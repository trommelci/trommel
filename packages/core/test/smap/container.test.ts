import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MapError } from '../../src/graph/map.ts';
import { SmapEncodeError } from '../../src/smap/bytes.ts';
import { decodeContainer, encodeContainer, FORMAT, layerAddress, SNAPSHOT_LAYER, STATIC_LAYER, type Container, type Section } from '../../src/smap/container.ts';
import { ascii, bytesOf, hexOf } from './hex.ts';

const sha256 = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest();

/** The bytes of `hex`, followed by their SHA-256: a file with a valid trailer. */
function sealed(hex: string): Uint8Array {
  const body = bytesOf(hex);
  const file = new Uint8Array(body.length + 32);
  file.set(body);
  file.set(sha256(body), body.length);
  return file;
}

// One section, field by field, so a test can change exactly one of them.
const ONE = {
  magic: '89 53 4d 41 50 0d 0a 1a',
  format: '00 00',
  hash: '01',
  reserved: '00',
  engine: '01 65',
  count: '01 00',
  tag: '53 4e 41 50',
  layer: '01',
  flags: '01',
  version: '00 00',
  offset: '20 00 00 00',
  length: '02 00 00 00',
  body: 'aa bb',
} as const;
const oneWith = (change: Partial<Record<keyof typeof ONE, string>>): Uint8Array => sealed(Object.values({ ...ONE, ...change }).join(' '));

const HEADER_TWO = `${ONE.magic} 00 00 01 00 01 65 02 00`;
/** Two sections, `aa` and `bb cc`, with the given tags and layers. Their bodies start at byte 48. */
const two = (first: { tag: string; layer: string }, second: { tag: string; layer: string }, offsets = ['30 00 00 00', '31 00 00 00']): Uint8Array =>
  sealed(`${HEADER_TWO} ${ascii(first.tag)} ${first.layer} 01 00 00 ${offsets[0]!} 01 00 00 00 ${ascii(second.tag)} ${second.layer} 01 00 00 ${offsets[1]!} 02 00 00 00 aa bb cc`);

const snap: Section = { tag: 'SNAP', layer: SNAPSHOT_LAYER, required: true, version: 0, body: bytesOf('aa bb') };
const oneSection: Container = { hash: 'sha1', engine: 'e', sections: [snap] };

const plain = (container: Container): unknown => ({ ...container, sections: container.sections.map((section) => ({ ...section, body: hexOf(section.body) })) });

describe('encodeContainer', () => {
  it('a container with no sections is a header and a trailer', () => {
    const header = `${ONE.magic} 00 00 01 00 01 65 00 00`;
    expect(hexOf(encodeContainer({ hash: 'sha1', engine: 'e', sections: [] }))).toBe(hexOf(sealed(header)));
    expect(bytesOf(header).length).toBe(16);
  });

  it('a section adds a 16-byte table entry and its body', () => {
    expect(hexOf(encodeContainer(oneSection))).toBe(hexOf(oneWith({})));
  });

  it('writes the hash algorithm, the engine, an optional section and a version', () => {
    const container: Container = { hash: 'sha256', engine: 'trommel-static-3', sections: [{ tag: 'XTRA', layer: 3, required: false, version: 0x0102, body: bytesOf('') }] };
    const engine = `10 ${ascii('trommel-static-3')}`;
    // The header is 8 + 2 + 1 + 1 + 17 + 2 = 31 bytes, so the body would start at 31 + 16 = 47.
    expect(hexOf(encodeContainer(container))).toBe(hexOf(sealed(`${ONE.magic} 00 00 02 00 ${engine} 01 00 ${ascii('XTRA')} 03 00 02 01 2f 00 00 00 00 00 00 00`)));
  });

  it('the format number is 0', () => {
    expect(FORMAT).toBe(0);
  });

  it.each([
    ['a tag of three characters', [{ ...snap, tag: 'SNA' }]],
    ['a tag with a lowercase letter', [{ ...snap, tag: 'Snap' }]],
    ['a layer of 0', [{ ...snap, layer: 0 }]],
    ['a layer of 256', [{ ...snap, layer: 256 }]],
    ['layers that descend', [{ ...snap, layer: 2 }, { ...snap, tag: 'KEYS', layer: 1 }]],
    ['two sections with one tag', [snap, snap]],
    ['a version past a u16', [{ ...snap, version: 65536 }]],
  ])('refuses %s', (_name, sections) => {
    expect(() => encodeContainer({ hash: 'sha1', engine: 'e', sections })).toThrow(SmapEncodeError);
  });
});

describe('decodeContainer', () => {
  it('reads back what was written', () => {
    expect(plain(decodeContainer(encodeContainer(oneSection)))).toEqual(plain(oneSection));
  });

  it('round-trips, in both directions', () => {
    const tag = fc.string({ unit: fc.constantFrom('A', 'B', 'C', 'X', 'Y', 'Z', '0', '1', '9'), minLength: 4, maxLength: 4 });
    const section = fc.record({ tag, layer: fc.integer({ min: 1, max: 3 }), required: fc.boolean(), version: fc.integer({ min: 0, max: 65535 }), body: fc.uint8Array({ maxLength: 40 }) });
    const container = fc.record({
      hash: fc.constantFrom('sha1' as const, 'sha256' as const),
      engine: fc.string({ unit: 'binary', maxLength: 20 }),
      sections: fc.uniqueArray(section, { maxLength: 6, selector: (s) => s.tag }).map((sections) => [...sections].sort((a, b) => a.layer - b.layer)),
    });
    fc.assert(
      fc.property(container, (value) => {
        const bytes = encodeContainer(value);
        const decoded = decodeContainer(bytes);
        expect(plain(decoded)).toEqual(plain(value));
        expect(hexOf(encodeContainer(decoded))).toBe(hexOf(bytes));
      }),
      { numRuns: 1000 },
    );
  });

  it('a body is a view into the file, not a copy', () => {
    const bytes = encodeContainer(oneSection);
    expect(decodeContainer(bytes).sections[0]!.body.buffer).toBe(bytes.buffer);
  });

  it('reads a Buffer at a non-zero byteOffset like a fresh array', () => {
    const bytes = encodeContainer(oneSection);
    const pooled = Buffer.concat([Buffer.alloc(7), Buffer.from(bytes)]).subarray(7);
    expect(plain(decodeContainer(pooled))).toEqual(plain(oneSection));
  });

  it.each([
    ['an empty file', new Uint8Array(0)],
    ['ten zero bytes', new Uint8Array(10)],
    ['a JSON map', new TextEncoder().encode('{"version":1}')],
    ['a JSON map longer than a header', new TextEncoder().encode(JSON.stringify({ version: 1, engine: 'trommel-static-3', nodes: {}, edges: {}, snapshot: [] }))],
    ['a wrong magic', oneWith({ magic: '88 53 4d 41 50 0d 0a 1a' })],
    ['a magic whose CR LF became LF', oneWith({ magic: '89 53 4d 41 50 0a 1a 00' })],
  ])('%s is not a SMAP file', (_name, bytes) => {
    expect(() => decodeContainer(bytes)).toThrow(MapError);
    expect(() => decodeContainer(bytes)).toThrow(/not a SMAP file/);
  });

  it.each([
    ['another format', oneWith({ format: '01 00' }), /format 1, expected 0/],
    ['an unknown hash algorithm', oneWith({ hash: '03' }), /hash algorithm 3/],
    ['a non-zero reserved byte', oneWith({ reserved: '01' }), /reserved/],
    ['a flag bit other than bit 0', oneWith({ flags: '03' }), /flags/],
    ['a tag with a lowercase letter', oneWith({ tag: '73 4e 41 50' }), /tag/],
    ['a layer of 0', oneWith({ layer: '00' }), /layer/],
    ['a body that starts late', oneWith({ offset: '21 00 00 00' }), /starts at 33, expected 32/],
    ['a body past the end of the file', oneWith({ length: '03 00 00 00' }), /past the end/],
    ['bytes between the last body and the trailer', oneWith({ body: 'aa bb cc' }), /left over/],
    ['a section count the file cannot hold', oneWith({ count: 'ff ff' }), /early/],
    ['a file cut inside the header', sealed(`${ONE.magic} 00 00 01`), /early/],
    ['two sections with one tag', two({ tag: 'SNAP', layer: '01' }, { tag: 'SNAP', layer: '01' }), /SNAP twice/],
    ['layers that descend', two({ tag: 'KEYS', layer: '02' }, { tag: 'SNAP', layer: '01' }), /layer/],
    ['bodies that overlap', two({ tag: 'SNAP', layer: '01' }, { tag: 'KEYS', layer: '02' }, ['30 00 00 00', '30 00 00 00']), /starts at 48, expected 49/],
  ])('rejects %s', (_name, bytes, message) => {
    expect(() => decodeContainer(bytes)).toThrow(MapError);
    expect(() => decodeContainer(bytes)).toThrow(message);
  });

  it('two sections in ascending layers are read in table order', () => {
    const decoded = decodeContainer(two({ tag: 'SNAP', layer: '01' }, { tag: 'KEYS', layer: '02' }));
    expect(decoded.sections.map((section) => [section.tag, section.layer, hexOf(section.body)])).toEqual([
      ['SNAP', 1, 'aa'],
      ['KEYS', 2, 'bb cc'],
    ]);
  });

  it('rejects a wrong trailer', () => {
    const bytes = oneWith({});
    bytes[bytes.length - 1]! ^= 1;
    expect(() => decodeContainer(bytes)).toThrow(/trailer/);
    const changed = oneWith({});
    changed[33]! ^= 1; // a body byte
    expect(() => decodeContainer(changed)).toThrow(/trailer/);
  });

  it('rejects a file with a magic and nothing else', () => {
    expect(() => decodeContainer(bytesOf(ONE.magic))).toThrow(MapError);
    expect(() => decodeContainer(bytesOf(`${ONE.magic} 00 00 01 00`))).toThrow(MapError);
  });

  it('checks the magic, then the format, then the trailer', () => {
    const broken = (change: Partial<Record<keyof typeof ONE, string>>): Uint8Array => {
      const bytes = oneWith(change);
      bytes[bytes.length - 1]! ^= 1;
      return bytes;
    };
    expect(() => decodeContainer(broken({ magic: '88 53 4d 41 50 0d 0a 1a' }))).toThrow(/not a SMAP file/);
    expect(() => decodeContainer(broken({ format: '01 00' }))).toThrow(/format 1/);
    expect(() => decodeContainer(broken({ hash: '03' }))).toThrow(/trailer/);
  });
});

describe('layerAddress', () => {
  const keys: Section = { tag: 'KEYS', layer: STATIC_LAYER, required: true, version: 0, body: bytesOf('01 02 03') };
  const both = (change: Partial<Container> = {}, body = keys.body): Container => ({ hash: 'sha1', engine: 'a', sections: [snap, { ...keys, body }], ...change });

  it('is the SHA-256 of the layer as the specification writes it', () => {
    const preimage = bytesOf(`${ascii('smap-layer')} 00 | 00 00 | 01 | 01 | ${ONE.tag} | 01 | 00 00 | 02 00 00 00 | aa bb`.replaceAll('|', ''));
    expect(layerAddress(oneSection, SNAPSHOT_LAYER)).toBe(Buffer.from(sha256(preimage)).toString('hex'));
  });

  it('the static layer has its engine after the layer number', () => {
    const preimage = bytesOf(`${ascii('smap-layer')} 00 | 00 00 | 01 | 02 | 01 61 | ${ascii('KEYS')} | 01 | 00 00 | 03 00 00 00 | 01 02 03`.replaceAll('|', ''));
    expect(layerAddress(both(), STATIC_LAYER)).toBe(Buffer.from(sha256(preimage)).toString('hex'));
  });

  it("covers its own layer's sections only", () => {
    const changed = both({}, bytesOf('01 02 04'));
    expect(layerAddress(changed, STATIC_LAYER)).not.toBe(layerAddress(both(), STATIC_LAYER));
    expect(layerAddress(changed, SNAPSHOT_LAYER)).toBe(layerAddress(both(), SNAPSHOT_LAYER));
  });

  it('the engine moves the static layer and not the snapshot layer', () => {
    expect(layerAddress(both({ engine: 'b' }), STATIC_LAYER)).not.toBe(layerAddress(both(), STATIC_LAYER));
    expect(layerAddress(both({ engine: 'b' }), SNAPSHOT_LAYER)).toBe(layerAddress(both(), SNAPSHOT_LAYER));
  });

  it('the hash algorithm moves both', () => {
    expect(layerAddress(both({ hash: 'sha256' }), STATIC_LAYER)).not.toBe(layerAddress(both(), STATIC_LAYER));
    expect(layerAddress(both({ hash: 'sha256' }), SNAPSHOT_LAYER)).not.toBe(layerAddress(both(), SNAPSHOT_LAYER));
  });

  it('a section boundary is part of the address', () => {
    const split = (first: string, second: string): Container => ({
      hash: 'sha1',
      engine: 'a',
      sections: [
        { ...snap, tag: 'AAAA', body: bytesOf(first) },
        { ...snap, tag: 'BBBB', body: bytesOf(second) },
      ],
    });
    expect(layerAddress(split('aa bb', 'cc'), SNAPSHOT_LAYER)).not.toBe(layerAddress(split('aa', 'bb cc'), SNAPSHOT_LAYER));
  });
});
