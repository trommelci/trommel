import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MapError } from '../../src/graph/map.ts';
import { ByteReader, ByteWriter, compareStrings, decodeString, encodeString, FrontReader, FrontWriter, SmapEncodeError } from '../../src/smap/bytes.ts';
import { ascii, bytesOf, hexOf } from './hex.ts';

const written = (write: (out: ByteWriter) => void): string => {
  const out = new ByteWriter();
  write(out);
  return hexOf(out.finish());
};
const reader = (hex: string): ByteReader => new ByteReader(bytesOf(hex), 'test');

/** Any JavaScript string: well-formed text mixed with runs of unpaired surrogates. */
const anyString = fc
  .array(fc.oneof(fc.string({ unit: 'binary' }), fc.string({ unit: fc.integer({ min: 0xd800, max: 0xdfff }).map((unit) => String.fromCharCode(unit)) })), { maxLength: 4 })
  .map((parts) => parts.join(''));

describe('varint', () => {
  it.each([
    [0, '00'],
    [127, '7f'],
    [128, '80 01'],
    [16383, 'ff 7f'],
    [16384, '80 80 01'],
    [4294967295, 'ff ff ff ff 0f'],
  ])('writes %i in its shortest form', (value, hex) => {
    expect(written((out) => { out.varint(value); })).toBe(hex);
    expect(reader(hex).varint()).toBe(value);
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (value) => {
        const out = new ByteWriter();
        out.varint(value);
        const input = new ByteReader(out.finish(), 'test');
        expect(input.varint()).toBe(value);
        expect(input.remaining).toBe(0);
      }),
      { numRuns: 2000 },
    );
  });

  it.each([-1, 1.5, 2 ** 32, Number.NaN])('the writer refuses %d', (value) => {
    expect(() => { new ByteWriter().varint(value); }).toThrow(SmapEncodeError);
  });

  it.each([
    ['a padded form', '80 00'],
    ['a padded zero', '80 80 00'],
    ['a sixth byte', 'ff ff ff ff ff 01'],
    ['a value past 2^32', 'ff ff ff ff 1f'],
    ['a varint cut short', '80'],
    ['nothing at all', ''],
  ])('the reader rejects %s', (_name, hex) => {
    expect(() => reader(hex).varint()).toThrow(MapError);
  });
});

describe('fixed-width integers', () => {
  it('are little-endian', () => {
    expect(written((out) => { out.u8(0xab); })).toBe('ab');
    expect(written((out) => { out.u16(0x1234); })).toBe('34 12');
    expect(written((out) => { out.u32(0x12345678); })).toBe('78 56 34 12');
    expect(written((out) => { out.u32(0xffffffff); })).toBe('ff ff ff ff');
    const input = reader('ab 34 12 78 56 34 12 ff ff ff ff');
    expect([input.u8(), input.u16(), input.u32(), input.u32()]).toEqual([0xab, 0x1234, 0x12345678, 0xffffffff]);
  });

  it('the writer refuses a value that does not fit', () => {
    expect(() => { new ByteWriter().u8(256); }).toThrow(SmapEncodeError);
    expect(() => { new ByteWriter().u16(65536); }).toThrow(SmapEncodeError);
    expect(() => { new ByteWriter().u32(2 ** 32); }).toThrow(SmapEncodeError);
    expect(() => { new ByteWriter().u16(-1); }).toThrow(SmapEncodeError);
  });

  it('the reader rejects a read past the end', () => {
    expect(() => reader('').u8()).toThrow(MapError);
    expect(() => reader('01').u16()).toThrow(MapError);
    expect(() => reader('01 02 03').u32()).toThrow(MapError);
    expect(() => reader('01 02').bytes(3)).toThrow(MapError);
  });

  it('a long write grows the buffer and keeps every byte', () => {
    const out = new ByteWriter();
    for (let i = 0; i < 5000; i++) {
      out.u8(i % 251);
    }
    const bytes = out.finish();
    expect(out.length).toBe(5000);
    expect(bytes.length).toBe(5000);
    expect([...bytes].every((byte, i) => byte === i % 251)).toBe(true);
  });
});

describe('object ids', () => {
  it('are raw bytes', () => {
    expect(written((out) => { out.hex('00ff10', 3); })).toBe('00 ff 10');
    expect(reader('00 ff 10').hex(3)).toBe('00ff10');
  });

  it.each([
    ['too short', 'abcd', 3],
    ['too long', 'abcdef01', 3],
    ['uppercase', 'ABCDEF', 3],
    ['not hex', 'zzzzzz', 3],
  ])('the writer refuses an id that is %s', (_name, hex, length) => {
    expect(() => { new ByteWriter().hex(hex, length); }).toThrow(SmapEncodeError);
  });
});

describe('strings', () => {
  it('round-trip, whatever they hold', () => {
    fc.assert(
      fc.property(anyString, (text) => {
        expect(decodeString(encodeString(text), 'test')).toBe(text);
      }),
      { numRuns: 3000 },
    );
  });

  it('a well-formed string is plain UTF-8', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        fc.pre(text.isWellFormed());
        expect(hexOf(encodeString(text))).toBe(hexOf(new TextEncoder().encode(text)));
      }),
      { numRuns: 2000 },
    );
  });

  it('an unpaired surrogate is three bytes, and a pair is four', () => {
    expect(hexOf(encodeString('\ud800'))).toBe('ed a0 80');
    expect(hexOf(encodeString('\udfff'))).toBe('ed bf bf');
    expect(hexOf(encodeString('😀'))).toBe('f0 9f 98 80');
    expect(hexOf(encodeString('a\ude00\ud83db'))).toBe('61 ed b8 80 ed a0 bd 62'); // low then high: no pair
  });

  it.each([
    ['a leading U+FEFF', '﻿x'],
    ['a NUL', 'a\0b'],
    ['an unpaired surrogate', 'x\ud800y'],
    ['127 bytes', 'a'.repeat(127)],
    ['128 bytes', 'a'.repeat(128)],
    ['16,383 bytes', 'a'.repeat(16383)],
    ['16,384 bytes', 'a'.repeat(16384)],
    ['the empty string', ''],
  ])('str() round-trips %s', (_name, text) => {
    const out = new ByteWriter();
    out.str(text);
    const input = new ByteReader(out.finish(), 'test');
    expect(input.str()).toBe(text);
    expect(input.remaining).toBe(0);
  });

  it('str() is a varint byte length, then the bytes', () => {
    expect(written((out) => { out.str('aé'); })).toBe('03 61 c3 a9');
  });

  it.each([
    ['an overlong form', 'c0 80'],
    ['an overlong three-byte form', 'e0 80 80'],
    ['a pair written as two surrogates', 'ed a0 bd ed b8 80'],
    ['a code point past U+10FFFF', 'f4 90 80 80'],
    ['a stray continuation byte', '80'],
    ['a sequence cut short', 'e2 82'],
    ['a five-byte form', 'f8 88 80 80 80'],
    ['a lead byte followed by a non-continuation', 'c3 28'],
  ])('decodeString rejects %s', (_name, hex) => {
    expect(() => decodeString(bytesOf(hex), 'test')).toThrow(MapError);
  });

  it('a string cut short by the end of the input is rejected', () => {
    expect(() => reader('05 61 62').str()).toThrow(MapError);
  });
});

describe('front coding', () => {
  const write = (texts: readonly string[]): Uint8Array => {
    const out = new ByteWriter();
    const front = new FrontWriter();
    for (const text of texts) {
      front.write(out, text);
    }
    return out.finish();
  };
  const read = (bytes: Uint8Array, count: number): string[] => {
    const input = new ByteReader(bytes, 'test');
    const front = new FrontReader();
    const texts = Array.from({ length: count }, () => front.read(input));
    input.end();
    return texts;
  };

  it('shares the longest prefix with the string before', () => {
    expect(hexOf(write(['f:a.test.ts', 'f:a.ts']))).toBe(`00 0b ${ascii('f:a.test.ts')} 05 01 ${ascii('s')}`);
  });

  it('a string that extends the one before shares all of it', () => {
    expect(hexOf(write(['a', 'a/b']))).toBe(`00 01 61 01 02 ${ascii('/b')}`);
  });

  it('shares bytes, so a prefix may end inside a character', () => {
    // é is c3 a9 and è is c3 a8: one shared byte.
    expect(hexOf(write(['é', 'è']))).toBe('00 02 c3 a9 01 01 a8');
    expect(read(bytesOf('00 02 c3 a9 01 01 a8'), 2)).toEqual(['é', 'è']);
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(fc.uniqueArray(anyString, { maxLength: 12 }), (texts) => {
        const sorted = [...texts].sort(compareStrings);
        expect(read(write(sorted), sorted.length)).toEqual(sorted);
      }),
      { numRuns: 1000 },
    );
  });

  it('the reader rejects a shared count that is not the longest', () => {
    expect(() => read(bytesOf('00 01 61 00 02 61 62'), 2)).toThrow(MapError);
  });

  it('the reader rejects a shared count past the string before', () => {
    expect(() => read(bytesOf('00 01 61 02 01 62'), 2)).toThrow(MapError);
  });

  it('the first string shares nothing', () => {
    expect(() => read(bytesOf('01 01 61'), 1)).toThrow(MapError);
  });
});

describe('ByteReader', () => {
  it('reads a view at a non-zero byteOffset like a fresh array', () => {
    const body = bytesOf('34 12 78 56 34 12 80 01 03 61 c3 a9 aa bb');
    const padded = new Uint8Array(7 + body.length);
    padded.set(body, 7);
    const pooled = Buffer.concat([Buffer.alloc(7), Buffer.from(body)]).subarray(7);
    for (const bytes of [body, new Uint8Array(padded.buffer, 7, body.length), pooled]) {
      const input = new ByteReader(bytes, 'test');
      expect([input.u16(), input.u32(), input.varint(), input.str(), input.hex(2)]).toEqual([0x1234, 0x12345678, 128, 'aé', 'aabb']);
      input.end();
    }
  });

  it('bytes() is a view of the input, not a copy', () => {
    const source = bytesOf('01 02 03');
    const view = new ByteReader(source, 'test').bytes(2);
    expect(view.buffer).toBe(source.buffer);
    expect([...view]).toEqual([1, 2]);
  });

  it('count() refuses a count the remaining bytes cannot hold', () => {
    expect(reader('02 aa bb').count(1)).toBe(2);
    expect(() => reader('03 aa bb').count(1)).toThrow(MapError);
    expect(() => reader('02 aa bb').count(2)).toThrow(MapError);
    expect(() => reader('ff ff ff ff 0f').count(1)).toThrow(MapError);
  });

  it('end() refuses leftover bytes', () => {
    const input = reader('01 02');
    input.u8();
    expect(() => { input.end(); }).toThrow(MapError);
    input.u8();
    expect(() => { input.end(); }).not.toThrow();
  });

  it('names what it was reading in the error', () => {
    expect(() => new ByteReader(bytesOf('80'), 'section KEYS').varint()).toThrow(/section KEYS/);
  });
});

describe('compareStrings', () => {
  it('orders by UTF-16 code unit, not by code point', () => {
    // U+FF5E is one unit, ff5e; U+1F600 is the units d83d de00. By code point the order is reversed.
    expect(['\u{1F600}', '～'].sort(compareStrings)).toEqual(['\u{1F600}', '～']);
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
  });
});
