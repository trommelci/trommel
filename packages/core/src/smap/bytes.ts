// The primitives of the SMAP format (docs/smap-format.md §1): little-endian integers, varints,
// strings and front-coded lists. Every value has exactly one encoding, and the reader accepts no
// other, so a file that decodes is the file the encoder would have written.
//
// A map is input from a cache that may be damaged, truncated or crafted. The reader checks every
// length before it reads, and reports anything wrong as a MapError, which the CLI turns into a
// plan that runs everything.
import { MapError } from '../graph/map.ts';

/** The map handed to the encoder cannot be written: it breaks an invariant of the format. */
export class SmapEncodeError extends Error {
  override readonly name = 'SmapEncodeError';
}

/** UTF-16 code-unit order, the order canonical JSON and the graph use. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const U32_LIMIT = 2 ** 32;
const HEX_DIGITS = /^[0-9a-f]*$/;
const HEX_BYTES = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

function unsigned(value: number, limit: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value >= limit) {
    throw new SmapEncodeError(`${what} cannot hold ${value}`);
  }
  return value;
}

export class ByteWriter {
  private buffer = new Uint8Array(256);
  private view = new DataView(this.buffer.buffer);
  private size = 0;

  get length(): number {
    return this.size;
  }

  /** Room for `extra` more bytes. It may replace the buffer, so callers take the offset first. */
  private reserve(extra: number): number {
    const start = this.size;
    if (start + extra > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, start + extra));
      grown.set(this.buffer.subarray(0, start));
      this.buffer = grown;
      this.view = new DataView(grown.buffer);
    }
    this.size = start + extra;
    return start;
  }

  u8(value: number): void {
    const start = this.reserve(1);
    this.view.setUint8(start, unsigned(value, 0x100, 'a u8'));
  }

  u16(value: number): void {
    const start = this.reserve(2);
    this.view.setUint16(start, unsigned(value, 0x10000, 'a u16'), true);
  }

  u32(value: number): void {
    const start = this.reserve(4);
    this.view.setUint32(start, unsigned(value, U32_LIMIT, 'a u32'), true);
  }

  /** Unsigned LEB128 in its shortest form; at most five bytes. */
  varint(value: number): void {
    let rest = unsigned(value, U32_LIMIT, 'a varint');
    const start = this.reserve(rest < 0x80 ? 1 : rest < 0x4000 ? 2 : rest < 0x200000 ? 3 : rest < 0x10000000 ? 4 : 5);
    let at = start;
    while (rest >= 0x80) {
      this.buffer[at++] = (rest & 0x7f) | 0x80;
      rest >>>= 7;
    }
    this.buffer[at] = rest;
  }

  bytes(bytes: Uint8Array): void {
    const start = this.reserve(bytes.length);
    this.buffer.set(bytes, start);
  }

  /** A varint byte length, then the string's bytes. */
  str(text: string): void {
    const bytes = encodeString(text);
    this.varint(bytes.length);
    this.bytes(bytes);
  }

  /** `length` raw bytes from `2 × length` lowercase hex digits: an object id or a SHA-256. */
  hex(hex: string, length: number): void {
    if (hex.length !== length * 2 || !HEX_DIGITS.test(hex)) {
      throw new SmapEncodeError(`${JSON.stringify(hex)} is not ${length} bytes of lowercase hex`);
    }
    const start = this.reserve(length);
    for (let i = 0; i < length; i++) {
      this.buffer[start + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
  }

  /** A copy of exactly the bytes written. */
  finish(): Uint8Array {
    return this.buffer.slice(0, this.size);
  }
}

export class ByteReader {
  /** What is being read; it starts every error message. */
  readonly what: string;
  private readonly source: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(bytes: Uint8Array, what: string) {
    this.source = bytes;
    // A Buffer from readFileSync, or a section's view, starts anywhere in its ArrayBuffer.
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.what = what;
  }

  get remaining(): number {
    return this.source.length - this.offset;
  }

  fail(problem: string): never {
    throw new MapError(`${this.what}: ${problem}`);
  }

  private take(length: number): number {
    if (length > this.remaining) {
      this.fail(`it ends ${length - this.remaining} bytes early`);
    }
    const start = this.offset;
    this.offset += length;
    return start;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (byte === 0 && i > 0) {
          this.fail('a varint is not in its shortest form');
        }
        if (value >= U32_LIMIT) {
          this.fail('a varint is past 2^32');
        }
        return value;
      }
      scale *= 0x80;
    }
    return this.fail('a varint is longer than five bytes');
  }

  /** A varint count of items that each take at least `minBytesEach`; checked before any allocation. */
  count(minBytesEach: number): number {
    const count = this.varint();
    if (count * minBytesEach > this.remaining) {
      this.fail(`a count of ${count} does not fit the ${this.remaining} bytes left`);
    }
    return count;
  }

  /** A view of the next `length` bytes, not a copy. */
  bytes(length: number): Uint8Array {
    const start = this.take(length);
    return this.source.subarray(start, start + length);
  }

  str(): string {
    return decodeString(this.bytes(this.varint()), this.what);
  }

  hex(length: number): string {
    let hex = '';
    for (const byte of this.bytes(length)) {
      hex += HEX_BYTES[byte]!;
    }
    return hex;
  }

  end(): void {
    if (this.remaining !== 0) {
      this.fail(`${this.remaining} bytes are left over`);
    }
  }
}

const ENCODER = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF: without it the decoder drops the character.
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * UTF-8. An unpaired surrogate, which UTF-8 cannot hold, is written as the three bytes of its code
 * point; a surrogate pair is always the four-byte form of the character it stands for.
 */
export function encodeString(text: string): Uint8Array {
  if (text.isWellFormed()) {
    return ENCODER.encode(text);
  }
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      out.push(unit);
    } else if (unit < 0x800) {
      out.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
    } else if (isHigh(unit) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) {
      const point = text.codePointAt(i)!;
      i++;
      out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      out.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** The inverse of `encodeString`. Anything it would not have written is a MapError. */
export function decodeString(bytes: Uint8Array, what: string): string {
  try {
    return STRICT.decode(bytes);
  } catch {
    return decodeWithSurrogates(bytes, what);
  }
}

/** The slow path: text that is not UTF-8 is either a string with an unpaired surrogate or damage. */
function decodeWithSurrogates(bytes: Uint8Array, what: string): string {
  const fail = (problem: string): never => {
    throw new MapError(`${what}: a string ${problem}`);
  };
  const units: number[] = [];
  let afterLoneHigh = false;
  let i = 0;
  const continuation = (): number => {
    const byte = bytes[i++];
    if (byte === undefined) {
      return fail('is cut short');
    }
    if ((byte & 0xc0) !== 0x80) {
      return fail('has a broken sequence');
    }
    return byte & 0x3f;
  };
  while (i < bytes.length) {
    const lead = bytes[i++]!;
    let point: number;
    if (lead < 0x80) {
      point = lead;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      point = ((lead & 0x1f) << 6) | continuation();
    } else if (lead >= 0xe0 && lead <= 0xef) {
      point = ((lead & 0x0f) << 12) | (continuation() << 6) | continuation();
      if (point < 0x800) {
        fail('has an overlong form');
      }
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      point = ((lead & 0x07) << 18) | (continuation() << 12) | (continuation() << 6) | continuation();
      if (point < 0x10000 || point > 0x10ffff) {
        fail('has a code point out of range');
      }
    } else {
      return fail('has an invalid byte');
    }
    if (afterLoneHigh && isLow(point)) {
      fail('writes a surrogate pair as two surrogates');
    }
    afterLoneHigh = isHigh(point);
    if (point < 0x10000) {
      units.push(point);
    } else {
      units.push(0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 0x3ff));
    }
  }
  let text = '';
  for (let start = 0; start < units.length; start += 8192) {
    text += String.fromCharCode(...units.slice(start, start + 8192));
  }
  return text;
}

const NO_BYTES = new Uint8Array(0);

function sharedPrefix(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) {
    shared++;
  }
  return shared;
}

/** Writes each string as the count of leading bytes it shares with the one before, then the rest. */
export class FrontWriter {
  private previous: Uint8Array = NO_BYTES;

  write(out: ByteWriter, text: string): void {
    const bytes = encodeString(text);
    const shared = sharedPrefix(this.previous, bytes);
    out.varint(shared);
    out.varint(bytes.length - shared);
    out.bytes(bytes.subarray(shared));
    this.previous = bytes;
  }
}

export class FrontReader {
  private previous: Uint8Array = NO_BYTES;

  read(input: ByteReader): string {
    const shared = input.varint();
    if (shared > this.previous.length) {
      input.fail('a string shares more bytes than the one before it has');
    }
    const rest = input.bytes(input.varint());
    if (shared < this.previous.length && rest.length > 0 && rest[0] === this.previous[shared]) {
      input.fail('a string does not share its longest prefix');
    }
    const bytes = new Uint8Array(shared + rest.length);
    bytes.set(this.previous.subarray(0, shared));
    bytes.set(rest, shared);
    this.previous = bytes;
    return decodeString(bytes, input.what);
  }
}
