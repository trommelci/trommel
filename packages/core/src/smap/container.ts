// The SMAP container (ADR-0009, docs/smap-format.md §2): a header, a section table, the section
// bodies and a SHA-256 trailer. It knows nothing of what a section holds, so a later layer (the
// records, in M3) is a new section and not a new format.
//
// The layout is canonical. Bodies follow the table in table order with no gap, sections of one
// layer are adjacent and layers ascend, so a container has one encoding and each layer is one run
// of bytes with its own content address.
import { createHash } from 'node:crypto';

import type { ObjectFormat } from '../git/git.ts';
import { MapError } from '../graph/map.ts';
import { ByteReader, ByteWriter, SmapEncodeError } from './bytes.ts';

/** The container format; a file of another format is invalid. */
export const FORMAT = 0;
export const SNAPSHOT_LAYER = 1;
export const STATIC_LAYER = 2;

/** `\x89SMAP\r\n\x1a`, after PNG's: a tool that treats the file as text damages these bytes first. */
const MAGIC = Uint8Array.of(0x89, 0x53, 0x4d, 0x41, 0x50, 0x0d, 0x0a, 0x1a);
const TRAILER_BYTES = 32;
const TAG = /^[A-Z0-9]{4}$/;
const REQUIRED = 1;
const HASH_CODES: Readonly<Record<ObjectFormat, number>> = { sha1: 1, sha256: 2 };
const LAYER_DOMAIN = new TextEncoder().encode('smap-layer\0');

export interface Section {
  /** Four characters of A–Z or 0–9. */
  readonly tag: string;
  /** 1 snapshot, 2 static, 3 records; at most 255. */
  readonly layer: number;
  /** A decoder that does not know a required section rejects the map; it skips an optional one. */
  readonly required: boolean;
  readonly version: number;
  readonly body: Uint8Array;
}

export interface Container {
  /** The repository's object format: how long an object id is. */
  readonly hash: ObjectFormat;
  /** The static engine id. */
  readonly engine: string;
  readonly sections: readonly Section[];
}

function checkSections(sections: readonly Section[], fail: (problem: string) => never): void {
  const tags = new Set<string>();
  let layer = 1;
  for (const section of sections) {
    if (!TAG.test(section.tag)) {
      fail(`a section tag must be four characters of A-Z or 0-9, not ${JSON.stringify(section.tag)}`);
    }
    if (tags.has(section.tag)) {
      fail(`it has section ${section.tag} twice`);
    }
    tags.add(section.tag);
    if (!Number.isInteger(section.layer) || section.layer < 1 || section.layer > 255) {
      fail(`section ${section.tag} has layer ${section.layer}`);
    }
    if (section.layer < layer) {
      fail(`section ${section.tag} of layer ${section.layer} follows layer ${layer}`);
    }
    layer = section.layer;
  }
}

export function encodeContainer(container: Container): Uint8Array {
  checkSections(container.sections, (problem) => {
    throw new SmapEncodeError(`the container cannot be written: ${problem}`);
  });
  const out = new ByteWriter();
  out.bytes(MAGIC);
  out.u16(FORMAT);
  out.u8(HASH_CODES[container.hash]);
  out.u8(0);
  out.str(container.engine);
  out.u16(container.sections.length);
  let offset = out.length + container.sections.length * 16;
  for (const section of container.sections) {
    out.bytes(new TextEncoder().encode(section.tag));
    out.u8(section.layer);
    out.u8(section.required ? REQUIRED : 0);
    out.u16(section.version);
    out.u32(offset);
    out.u32(section.body.length);
    offset += section.body.length;
  }
  for (const section of container.sections) {
    out.bytes(section.body);
  }
  if (out.length + TRAILER_BYTES >= 2 ** 32) {
    throw new SmapEncodeError('the container cannot be written: a SMAP file is under 4 GiB');
  }
  out.bytes(createHash('sha256').update(out.finish()).digest());
  return out.finish();
}

/**
 * The sections of a file, their bodies as views into `bytes`. Throws MapError on anything wrong;
 * each message reads as the reason after "the map is invalid:".
 */
export function decodeContainer(bytes: Uint8Array): Container {
  const fail = (problem: string): never => {
    throw new MapError(problem);
  };
  if (bytes.length < MAGIC.length || MAGIC.some((byte, i) => bytes[i] !== byte)) {
    throw new MapError('it is not a SMAP file');
  }
  if (bytes.length < MAGIC.length + 2) {
    fail('it ends inside its header');
  }
  const format = new ByteReader(bytes.subarray(MAGIC.length, MAGIC.length + 2), 'the SMAP header').u16();
  if (format !== FORMAT) {
    fail(`it has SMAP format ${format}, expected ${FORMAT}`);
  }
  if (bytes.length < MAGIC.length + 2 + TRAILER_BYTES) {
    fail('it ends before its trailer');
  }
  const end = bytes.length - TRAILER_BYTES;
  const digest = createHash('sha256').update(bytes.subarray(0, end)).digest();
  if (digest.some((byte, i) => bytes[end + i] !== byte)) {
    fail('its trailer is not the SHA-256 of its contents');
  }

  const input = new ByteReader(bytes.subarray(MAGIC.length + 2, end), 'the SMAP header');
  const hashCode = input.u8();
  const hash = hashCode === HASH_CODES.sha1 ? 'sha1' : hashCode === HASH_CODES.sha256 ? 'sha256' : fail(`it names hash algorithm ${hashCode}`);
  if (input.u8() !== 0) {
    fail('its reserved byte is not zero');
  }
  const engine = input.str();
  const count = input.u16();
  const entries = Array.from({ length: count }, () => {
    const tag = String.fromCharCode(...input.bytes(4));
    const layer = input.u8();
    const flags = input.u8();
    if ((flags & ~REQUIRED) !== 0) {
      fail(`section ${JSON.stringify(tag)} has unknown flags ${flags}`);
    }
    return { tag, layer, required: (flags & REQUIRED) !== 0, version: input.u16(), offset: input.u32(), length: input.u32() };
  });
  checkSections(
    entries.map((entry) => ({ ...entry, body: bytes })),
    fail,
  );
  let offset = end - input.remaining;
  const sections = entries.map(({ offset: start, length, ...section }): Section => {
    if (start !== offset) {
      fail(`section ${section.tag} starts at ${start}, expected ${offset}`);
    }
    if (start + length > end) {
      fail(`section ${section.tag} runs past the end of the file`);
    }
    offset = start + length;
    return { ...section, body: bytes.subarray(start, offset) };
  });
  if (offset !== end) {
    fail(`${end - offset} bytes are left over before the trailer`);
  }
  return { hash, engine, sections };
}

/**
 * A layer's content address, as hex: the SHA-256 of the format, the hash algorithm, the layer
 * number and each of the layer's sections with its tag, flags, version and length. The static
 * layer also covers the engine id, since the graph is a function of the tree, the config and the
 * engine. The snapshot layer does not, so it is the same across engines.
 */
export function layerAddress(container: Container, layer: number): string {
  const out = new ByteWriter();
  out.bytes(LAYER_DOMAIN);
  out.u16(FORMAT);
  out.u8(HASH_CODES[container.hash]);
  out.u8(layer);
  if (layer === STATIC_LAYER) {
    out.str(container.engine);
  }
  for (const section of container.sections) {
    if (section.layer === layer) {
      out.bytes(new TextEncoder().encode(section.tag));
      out.u8(section.required ? REQUIRED : 0);
      out.u16(section.version);
      out.u32(section.body.length);
      out.bytes(section.body);
    }
  }
  return createHash('sha256').update(out.finish()).digest('hex');
}
