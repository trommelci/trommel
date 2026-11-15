// Damaged and crafted files. A map comes from a cache, so the decoder has to hold against anything:
// every input here is either refused with a MapError or is a file the encoder would have written.
// No other error may escape, and nothing may hang or allocate past what the file's size allows.
//
// The second half of that rule is the format's canonical form: if the decoder accepts a file, the
// map it gives re-encodes to exactly those bytes. A check the decoder forgets shows up here as a
// file that decodes and does not re-encode to itself.
import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MapError } from '../../src/graph/map.ts';
import { decodeContainer, encodeContainer, type Section } from '../../src/smap/container.ts';
import { decodeSmap, encodeSmap } from '../../src/smap/smap.ts';
import { goldenMap } from '../graph/golden-fixture.ts';
import { ONE } from './vector-one.ts';

const TRAILER = 32;
const ONE_BYTES = encodeSmap(ONE);
const GOLDEN_BYTES = encodeSmap(goldenMap);

/** `content` followed by its SHA-256, so the decoder gets past the trailer and reads the rest. */
function sealed(content: Uint8Array): Uint8Array {
  const file = new Uint8Array(content.length + TRAILER);
  file.set(content);
  file.set(createHash('sha256').update(content).digest(), content.length);
  return file;
}

function outcome(bytes: Uint8Array): 'refused' | 'canonical' {
  let map;
  try {
    ({ map } = decodeSmap(bytes));
  } catch (error) {
    if (error instanceof MapError) {
      return 'refused';
    }
    throw error;
  }
  const again = encodeSmap(map);
  if (Buffer.compare(again, bytes) !== 0) {
    throw new Error(`the decoder accepted ${bytes.length} bytes that re-encode to ${again.length} different ones`);
  }
  return 'canonical';
}

interface Edit {
  readonly kind: 'replace' | 'insert' | 'delete';
  readonly at: number;
  readonly value: number;
}
const edits = fc.array(fc.record({ kind: fc.constantFrom('replace' as const, 'insert' as const, 'delete' as const), at: fc.nat(), value: fc.integer({ min: 0, max: 255 }) }), { minLength: 1, maxLength: 4 });

function apply(bytes: Uint8Array, changes: readonly Edit[]): Uint8Array {
  const out = [...bytes];
  for (const { kind, at, value } of changes) {
    const position = out.length === 0 ? 0 : at % out.length;
    if (kind === 'replace' && out.length > 0) {
      out[position] = value;
    } else if (kind === 'insert') {
      out.splice(position, 0, value);
    } else if (out.length > 0) {
      out.splice(position, 1);
    }
  }
  return Uint8Array.from(out);
}

describe('the two vectors themselves', () => {
  it('are canonical', () => {
    expect(outcome(ONE_BYTES)).toBe('canonical');
    expect(outcome(GOLDEN_BYTES)).toBe('canonical');
  });
});

describe('truncation', () => {
  it.each([
    ['vector 1', ONE_BYTES],
    ['vector 2', GOLDEN_BYTES],
  ])('every prefix of %s is refused', (_name, bytes) => {
    for (let length = 0; length < bytes.length; length++) {
      expect(outcome(bytes.subarray(0, length))).toBe('refused');
    }
  });

  it.each([
    ['vector 1', ONE_BYTES],
    ['vector 2', GOLDEN_BYTES],
  ])('every prefix of %s is refused even with a fresh trailer', (_name, bytes) => {
    const content = bytes.subarray(0, bytes.length - TRAILER);
    for (let length = 0; length < content.length; length++) {
      expect(outcome(sealed(content.subarray(0, length)))).toBe('refused');
    }
  });
});

describe('damage', () => {
  it('every single-byte change to vector 1 is refused without a fresh trailer', () => {
    for (let at = 0; at < ONE_BYTES.length; at++) {
      const changed = ONE_BYTES.slice();
      changed[at]! ^= 0x01;
      expect(outcome(changed)).toBe('refused');
    }
  });

  it('every single-byte change to vector 1, with a fresh trailer, is refused or canonical', () => {
    const content = ONE_BYTES.slice(0, ONE_BYTES.length - TRAILER);
    const counts = { refused: 0, canonical: 0 };
    for (let at = 0; at < content.length; at++) {
      const original = content[at]!;
      for (let value = 0; value < 256; value++) {
        if (value !== original) {
          content[at] = value;
          counts[outcome(sealed(content))]++;
        }
      }
      content[at] = original;
    }
    // Both happen: most changes break something, and a changed hash or path byte is another map.
    expect(counts.refused + counts.canonical).toBe(content.length * 255);
    expect(counts.refused).toBeGreaterThan(counts.canonical);
    expect(counts.canonical).toBeGreaterThan(1000);
  });

  it('random edits to vector 2, with a fresh trailer, are refused or canonical', () => {
    const content = GOLDEN_BYTES.subarray(0, GOLDEN_BYTES.length - TRAILER);
    fc.assert(
      fc.property(edits, (changes) => {
        outcome(sealed(apply(content, changes)));
      }),
      { numRuns: 3000 },
    );
  });

  it('random edits inside one section of vector 2, with the table rebuilt, are refused or canonical', () => {
    // An insert or a delete in the file always breaks the table, so the section readers never see
    // it. Rebuilding the container around the damaged body gets the damage to them.
    const container = decodeContainer(GOLDEN_BYTES);
    const counts = { refused: 0, canonical: 0 };
    fc.assert(
      fc.property(fc.nat(container.sections.length - 1), edits, (which, changes) => {
        const sections = container.sections.map((section, i): Section => (i === which ? { ...section, body: apply(section.body, changes) } : section));
        counts[outcome(encodeContainer({ ...container, sections }))]++;
      }),
      { numRuns: 6000 },
    );
    expect(counts.refused).toBeGreaterThan(0);
    expect(counts.canonical).toBeGreaterThan(0);
  });

  it('random bytes after a real header are refused or canonical', () => {
    const container = decodeContainer(ONE_BYTES);
    fc.assert(
      fc.property(fc.nat(container.sections.length - 1), fc.uint8Array({ maxLength: 64 }), (which, body) => {
        const sections = container.sections.map((section, i): Section => (i === which ? { ...section, body } : section));
        outcome(encodeContainer({ ...container, sections }));
      }),
      { numRuns: 3000 },
    );
  });
});
