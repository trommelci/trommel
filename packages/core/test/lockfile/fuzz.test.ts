import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Unparseable } from '../../src/lockfile/npm.ts';
import type { ResolvedModel } from '../../src/lockfile/model.ts';
import { parsePnpmLockfile } from '../../src/lockfile/pnpm.ts';
import { parseYamlSubset, YamlError } from '../../src/lockfile/yaml.ts';
import { parseYarnBerryLockfile } from '../../src/lockfile/yarn-berry.ts';
import { parseYarnClassicLockfile } from '../../src/lockfile/yarn-classic.ts';

// Totality (spec 2026-11-15-pnpm-yarn-lockfiles §7, DECISIONS 36): whatever the text, a reader gives
// a model or an `unparseable`, and nothing is thrown.

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/lockfile/${name}`, import.meta.url), 'utf8');
}

const NO_WORKSPACE = { importers: new Map(), packages: new Map() };

interface Reader {
  readonly name: string;
  readonly files: readonly string[];
  readonly read: (text: string) => ResolvedModel | Unparseable;
}

const READERS: readonly Reader[] = [
  { name: 'pnpm', files: ['pnpm-one-document.yaml', 'pnpm-two-documents.yaml'], read: parsePnpmLockfile },
  { name: 'yarn berry', files: ['yarn-berry-8.lock', 'yarn-berry-10.lock'], read: parseYarnBerryLockfile },
  { name: 'yarn classic', files: ['yarn-classic.lock'], read: (text) => parseYarnClassicLockfile(text, NO_WORKSPACE) },
];

const CHARS = [':', '"', "'", '\t', '\n', '\r', ' ', '-', '[', ']', '{', '}', ',', '#', '@', '*', '&', '|', '>', '%', '\\', '\0', '\uFEFF', '\u00e9', '\ud83d', '0', 'a'];

interface Mutation {
  readonly file: number;
  readonly op: number;
  /** Fractions of the text or of its lines, so one draw fits every fixture. */
  readonly at: number;
  readonly other: number;
  readonly char: number;
}

const unit = fc.integer({ min: 0, max: 999_999 }).map((n) => n / 1_000_000);
const mutation: fc.Arbitrary<Mutation> = fc.record({
  file: fc.nat(1000),
  op: fc.integer({ min: 0, max: 5 }),
  at: unit,
  other: unit,
  char: fc.integer({ min: 0, max: CHARS.length - 1 }),
});

/**
 * Truncate, delete a line, duplicate a line, swap two lines, replace a character, or empty a block: keep a
 * line and delete the lines indented under it, which leaves a key with a scalar where a map was.
 */
function mutate(text: string, m: Mutation): string {
  const lines = text.split('\n');
  const i = Math.floor(m.at * lines.length);
  const j = Math.floor(m.other * lines.length);
  switch (m.op) {
    case 0:
      return text.slice(0, Math.floor(m.at * text.length));
    case 1:
      return lines.filter((_, k) => k !== i).join('\n');
    case 2:
      return [...lines.slice(0, i + 1), lines[i], ...lines.slice(i + 1)].join('\n');
    case 3: {
      const copy = [...lines];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy.join('\n');
    }
    case 4: {
      const k = Math.floor(m.at * text.length);
      return text.slice(0, k) + (CHARS[m.char] ?? '') + text.slice(k + 1);
    }
    default: {
      const openers = lines.flatMap((line, k) => (line.trimEnd().endsWith(':') ? [k] : []));
      const start = openers[Math.floor(m.at * openers.length)] ?? i;
      const indent = (line: string): number => line.length - line.trimStart().length;
      let end = start + 1;
      while (end < lines.length && (lines[end] === '' || indent(lines[end]!) > indent(lines[start]!))) end++;
      return [...lines.slice(0, start + 1), ...lines.slice(end)].join('\n');
    }
  }
}

describe('totality: a mutated lockfile gives a model or unparseable and never throws', () => {
  for (const reader of READERS) {
    const texts = reader.files.map(fixture);
    it(`${reader.name}: the fixtures themselves are read`, () => {
      for (const text of texts) expect(reader.read(text)).not.toHaveProperty('kind', 'unparseable');
    });
    it(`${reader.name}: 2,000 mutations`, () => {
      fc.assert(
        fc.property(mutation, (m) => {
          const result = reader.read(mutate(texts[m.file % texts.length]!, m));
          if ('kind' in result) expect(typeof result.reason).toBe('string');
          else expect(result.entries).toBeInstanceOf(Map);
        }),
        { numRuns: 2000 },
      );
    });
  }
});

describe('pathological inputs', () => {
  it('refuses 10,000 nested [ by the depth limit', () => {
    const deep = '['.repeat(10_000);
    expect(() => parseYamlSubset(`a: ${deep}\n`)).toThrow(YamlError);
    expect(() => parseYamlSubset(`a: ${deep}\n`)).toThrow(/nest|depth/i);
    expect(parsePnpmLockfile(`lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: ${deep}\n`)).toMatchObject({ kind: 'unparseable', format: 'pnpm' });
    expect(parseYarnBerryLockfile(`__metadata:\n  version: 10\n\n"a@npm:1":\n  version: 1\n  resolution: "a@npm:1"\n  dependencies: ${deep}\n`)).toMatchObject({ kind: 'unparseable', format: 'yarn' });
  });

  it('reads a 1 MB single-line value in one pass', () => {
    const value = 'x'.repeat(1 << 20);
    const started = performance.now();
    const [doc] = parseYamlSubset(`a: ${value}\nb: "${value}"\n`);
    expect(doc?.get('a')).toBe(value);
    expect(doc?.get('b')).toBe(value);
    const classic = parseYarnClassicLockfile(`# yarn lockfile v1\n\n\na@^1.0.0:\n  version "1.0.0"\n  resolved "${value}"\n`, NO_WORKSPACE);
    expect(classic).toHaveProperty('entries');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  for (const reader of READERS) {
    it(`${reader.name}: refuses merge-conflict markers, naming the line`, () => {
      const text = fixture(reader.files[reader.files.length - 1]!);
      for (const marker of ['<<<<<<< HEAD', '=======', '>>>>>>> feature']) {
        const lines = text.split('\n');
        lines.splice(3, 0, marker);
        const result = reader.read(lines.join('\n'));
        expect(result).toHaveProperty('kind', 'unparseable');
        expect((result as Unparseable).reason).toMatch(/\bline 4\b/);
      }
    });
  }
});
