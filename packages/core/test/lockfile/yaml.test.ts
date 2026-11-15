import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FLOW_DEPTH, parseYamlSubset, YamlError } from '../../src/lockfile/yaml.ts';
import type { YamlMap, YamlValue } from '../../src/lockfile/yaml.ts';

function m(entries: [string, YamlValue][]): YamlMap {
  return new Map(entries);
}

describe('parseYamlSubset', () => {
  it('reads block mappings and every scalar form', () => {
    expect(parseYamlSubset("a: b\nc:\n  d: 'e''f'\n  g: \"h\\ni\"\n")).toEqual([
      m([
        ['a', 'b'],
        ['c', m([['d', "e'f"], ['g', 'h\ni']])],
      ]),
    ]);
  });

  it('reads one-line flow collections', () => {
    const [doc] = parseYamlSubset(
      'resolution: {integrity: sha512-x, tarball: https://r/x.tgz}\ncpu: [x64, arm64]\nx: {}\ny: []\nz: {a: [b, {c: d}], e: "f, g"}\n',
    );
    expect(doc).toEqual(
      m([
        ['resolution', m([['integrity', 'sha512-x'], ['tarball', 'https://r/x.tgz']])],
        ['cpu', ['x64', 'arm64']],
        ['x', m([])],
        ['y', []],
        ['z', m([['a', ['b', m([['c', 'd']])]], ['e', 'f, g']])],
      ]),
    );
  });

  it('reads block sequences indented under their key', () => {
    expect(parseYamlSubset('t:\n  - supports-color\n  - \'x y\'\nu: v\n')).toEqual([
      m([['t', ['supports-color', 'x y']], ['u', 'v']]),
    ]);
  });

  it('keeps a colon inside a plain key', () => {
    const key = 'zod443@https://registry.npmjs.org/zod/-/zod-4.4.3.tgz';
    expect(parseYamlSubset(`snapshots:\n\n  ${key}: {}\n`)).toEqual([
      m([['snapshots', m([[key, m([])]])]]),
    ]);
  });

  it('splits documents, and skips blank lines and comments', () => {
    expect(parseYamlSubset('---\na: 1\n---\nb: 2 # c\n')).toEqual([
      m([['a', '1']]),
      m([['b', '2']]),
    ]);
    expect(parseYamlSubset('# lead\n\n---\n# only a comment\n---\na: 1\n')).toEqual([
      m([]),
      m([['a', '1']]),
    ]);
  });

  it('reads CRLF and a leading BOM as LF', () => {
    const lf = "---\na: b\nc:\n  - d\n  - 'e'\nf: {g: h}\n---\ni: j\n";
    const expected = parseYamlSubset(lf);
    expect(expected).toHaveLength(2);
    expect(parseYamlSubset(lf.replaceAll('\n', '\r\n'))).toEqual(expected);
    expect(parseYamlSubset('\uFEFF' + lf)).toEqual(expected);
  });

  it('treats prototype names as ordinary keys', () => {
    const [doc] = parseYamlSubset('__proto__:\n  polluted: yes\nconstructor: x\nhasOwnProperty: y\n');
    expect([...doc!.keys()]).toEqual(['__proto__', 'constructor', 'hasOwnProperty']);
    expect(doc!.get('__proto__')).toEqual(m([['polluted', 'yes']]));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('reads an empty value as an empty string', () => {
    expect(parseYamlSubset('a:\nb: # c\nc: d\n')).toEqual([
      m([['a', ''], ['b', ''], ['c', 'd']]),
    ]);
  });

  const deep = (n: number): string => '['.repeat(n) + ']'.repeat(n);

  it('accepts flow nesting to FLOW_DEPTH', () => {
    expect(() => parseYamlSubset(`a: ${deep(FLOW_DEPTH)}\n`)).not.toThrow();
  });

  it.each<[string, string, number]>([
    ['a tab in the indentation', 'a:\n\t\tb: c\n', 2],
    ['an anchor', 'a:\n  b: &a c\n', 2],
    ['an alias', 'a: 1\nb: *a\n', 2],
    ['a tag', 'a: !!str c\n', 1],
    ['a literal block scalar', 'a: |\n  text\n', 1],
    ['a folded block scalar', 'a: >\n  text\n', 1],
    ['a complex key', 'a: b\n? x\n', 2],
    ['a directive', '%YAML 1.2\na: b\n', 1],
    ['a duplicate key', 'a: b\nc:\n  d: 1\n  d: 2\n', 4],
    ['a duplicate key in a flow mapping', 'a: {b: 1, b: 2}\n', 1],
    ['an indentation of 3', 'a:\n   b: c\n', 2],
    ['a flow collection that continues on the next line', 'a: [x,\n  y]\n', 1],
    ['a plain scalar that continues on the next line', 'a: b\n  c\n', 2],
    ['flow nesting deeper than FLOW_DEPTH', `a: b\nc: ${deep(FLOW_DEPTH + 1)}\n`, 2],
    ['an unterminated single quote', "a: 'b\n", 1],
    ['an unterminated double quote', 'x: y\na: "b\n', 2],
    ['a plain scalar starting with @', 'a: @scope/x\n', 1],
    ['a plain key starting with @', '@scope/x: 1\n', 1],
    ['a plain scalar starting with a backtick', 'a: `x`\n', 1],
    ['a double-quoted escape JSON lacks', 'a: "\\x41"\n', 1],
    ['a colon and a space inside a plain value', 'a: b: c\n', 1],
    ['text after a closing quote', "a: 'b' c\n", 1],
    ['a flow collection in a block sequence', 'a:\n  - [b]\n', 2],
    ['a sequence item indented deeper than two', 'a:\n    - b\n', 2],
    ['a block mapping inside a block sequence', 'a:\n  - b\n  c: d\n', 3],
    ['a root that is a scalar', 'just text\n', 1],
    ['a root that is indented', '  a: b\n', 1],
  ])('refuses %s', (_name, text, line) => {
    let caught: unknown;
    try {
      parseYamlSubset(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(YamlError);
    expect((caught as YamlError).line).toBe(line);
    expect((caught as YamlError).message).toMatch(new RegExp(`\\(line ${line}\\)$`));
  });

  it('names an odd indentation as such', () => {
    expect(() => parseYamlSubset('a:\n   b: c\n')).toThrow(/not a multiple of two/);
  });

  it('counts lines across documents', () => {
    expect(() => parseYamlSubset('a: 1\n---\nb: 2\nb: 3\n')).toThrow(/\(line 4\)$/);
  });
});

// A test-only emitter that writes a map the way pnpm (single quotes, flow maps for leaf maps)
// or Berry (double quotes) writes it, choosing quoting so that every value round-trips.
type Style = 'pnpm' | 'berry';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

function emitScalar(s: string, style: Style, flow: boolean): string {
  if (style === 'berry') {
    return JSON.stringify(s);
  }
  const plain =
    s !== '' &&
    !INDICATOR_START.test(s) &&
    !/^\s|\s$/.test(s) &&
    !CONTROL.test(s) &&
    !s.includes(': ') &&
    !s.includes(' #') &&
    !s.endsWith(':') &&
    !(flow && /[,[\]{}]/.test(s));
  if (plain) {
    return s;
  }
  return CONTROL.test(s) ? JSON.stringify(s) : `'${s.replaceAll("'", "''")}'`;
}

function emitFlow(v: YamlValue, style: Style): string {
  if (typeof v === 'string') {
    return emitScalar(v, style, true);
  }
  if (v instanceof Map) {
    return `{${[...(v as YamlMap)].map(([k, x]) => `${emitScalar(k, style, true)}: ${emitFlow(x, style)}`).join(', ')}}`;
  }
  return `[${(v as readonly YamlValue[]).map((x) => emitFlow(x, style)).join(', ')}]`;
}

function emitBlock(map: YamlMap, indent: number, style: Style, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const [k, v] of map) {
    const key = emitScalar(k, style, false);
    if (typeof v === 'string') {
      out.push(`${pad}${key}: ${emitScalar(v, style, false)}`);
    } else if (v instanceof Map) {
      const leaf = [...v.values()].every((x) => typeof x === 'string');
      if (v.size === 0 || (style === 'pnpm' && leaf)) {
        out.push(`${pad}${key}: ${emitFlow(v, style)}`);
      } else {
        out.push(`${pad}${key}:`);
        emitBlock(v, indent + 2, style, out);
      }
    } else {
      const items = v as readonly string[];
      if (items.length === 0 || (style === 'pnpm' && items.length <= 2)) {
        out.push(`${pad}${key}: ${emitFlow(items, style)}`);
      } else {
        out.push(`${pad}${key}:`);
        for (const item of items) {
          out.push(`${pad}  - ${emitScalar(item, style, false)}`);
        }
      }
    }
    if (indent === 0) {
      out.push('');
    }
  }
}

function emit(map: YamlMap, style: Style): string {
  const out: string[] = [];
  emitBlock(map, 0, style, out);
  return out.join('\n') + '\n';
}

const charArb = fc.constantFrom(
  ':', '#', "'", '"', '@', ' ', '-', '\\', ',', '[', ']', '{', '}', '\n', '\t',
  'a', 'b', 'z', '0', '9', '/', '.', '=', '\u00e9', '\u65e5', '\u{1F600}',
);
const stringArb = fc.oneof(
  fc.array(charArb, { maxLength: 8 }).map((cs) => cs.join('')),
  fc.constantFrom('', '__proto__', 'constructor', '@scope/pkg@1.0.0', 'a: b', 'a #b', 'https://r/x.tgz', ' x'),
);

const { mapArb } = fc.letrec<{ mapArb: YamlMap; valueArb: YamlValue }>(
  (tie) => ({
    valueArb: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      stringArb,
      fc.array(stringArb, { maxLength: 4 }),
      tie('mapArb'),
    ),
    mapArb: fc
      .array(fc.tuple(stringArb, tie('valueArb')), { maxLength: 4 })
      .map((entries): YamlMap => new Map(entries)),
  }),
);

describe('parseYamlSubset round trip', () => {
  for (const style of ['pnpm', 'berry'] as const) {
    it(`returns exactly the document it was given (${style})`, () => {
      fc.assert(
        fc.property(mapArb, (map) => {
          expect(parseYamlSubset(emit(map, style))).toEqual([map]);
        }),
        { numRuns: 1000 },
      );
    });
  }
});
