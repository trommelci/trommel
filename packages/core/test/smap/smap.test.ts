import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/canonical-json.ts';
import { mapGraph, MapError } from '../../src/graph/map.ts';
import { buildStaticMap, ENGINE, type TrommelMap } from '../../src/graph/static.ts';
import { SmapEncodeError } from '../../src/smap/bytes.ts';
import { decodeContainer, layerAddress, SNAPSHOT_LAYER, STATIC_LAYER } from '../../src/smap/container.ts';
import { decodeSmap, encodeSmap } from '../../src/smap/smap.ts';
import { fakeRepo } from '../graph/fake-repo.ts';
import { arbitraryMap } from './arbitrary.ts';
import { ascii, assemble, bytesOf, hexOf, type HandSection } from './hex.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const run = (byte: string, count: number): string => Array.from({ length: count }, () => byte).join(' ');

// Vector 1: a map written by hand that uses every section, and the bytes the specification gives
// for it (docs/smap-format.md §6). The bodies below are the oracle: nothing in them is computed.
const ONE: TrommelMap = {
  version: 1,
  engine: 'trommel-static-3',
  objectFormat: 'sha1',
  rootTree: 'aa'.repeat(20),
  undecodable: 0,
  config: null,
  lockfile: { kind: 'npm', path: 'package-lock.json' },
  snapshot: [
    ['100644', '11'.repeat(20), 'a.test.ts'],
    ['100644', '22'.repeat(20), 'a.ts'],
  ],
  nodes: {
    'f:a.test.ts': '11'.repeat(20),
    'f:a.ts': '22'.repeat(20),
    'g:glob:k': 'cc'.repeat(32),
    'p:npm:node_modules/x': 'sha512-X',
    'p:npm:node_modules/y': null,
    'u:a.ts': sha256('["line 1: lexer E"]'),
  },
  edges: {
    'f:a.test.ts': { 'f:a.ts': 1, 'g:glob:k': 4 },
    'f:a.ts': { 'p:npm:node_modules/x': 1, 'p:npm:node_modules/y': 1, 'u:a.ts': 1 },
  },
  globs: { 'g:glob:k': ['*.ts'] },
  tests: ['a.test.ts'],
  uncertain: { 'u:a.ts': ['line 1: lexer E'] },
};

const HEADER = [
  '89 53 4d 41 50 0d 0a 1a', // magic
  '00 00', // format 0
  '01', // sha1
  '00', // reserved
  `10 ${ascii('trommel-static-3')}`, // engine
  '08 00', // eight sections
].join(' ');

const BODIES = {
  SNAP: [
    run('aa', 20), // root tree
    '00', // no undecodable path
    '02', // two entries
    `a4 83 02 ${run('11', 20)} 00 09 ${ascii('a.test.ts')}`, // mode 100644 = 33188, oid, path
    `a4 83 02 ${run('22', 20)} 03 01 ${ascii('s')}`, // a.ts shares "a.t"
  ],
  META: [
    run('aa', 20), // the tree this graph was derived from
    '00', // no config
    `01 11 ${ascii('package-lock.json')}`, // an npm lockfile
  ],
  KEYS: [
    '06',
    `00 0b ${ascii('f:a.test.ts')}`, // node 0
    `05 01 ${ascii('s')}`, // node 1, f:a.ts
    `00 08 ${ascii('g:glob:k')}`, // node 2
    `00 14 ${ascii('p:npm:node_modules/x')}`, // node 3
    `13 01 ${ascii('y')}`, // node 4, p:npm:node_modules/y
    `00 06 ${ascii('u:a.ts')}`, // node 5
  ],
  EDGE: [
    '05', // five edges
    '02 01 01', // node 0: to 1, then a gap of 1 to 2
    '03 03 01 01', // node 1: to 3, 4 and 5
    '00 00 00 00', // nodes 2 to 5 have none
    '01 04 01 01 01', // provenance: static, declared, static, static, static
  ],
  HASH: [
    `01 ${run('cc', 32)}`, // node 2: a SHA-256
    `02 08 ${ascii('sha512-X')}`, // node 3: another string
    '00', // node 4: absent
  ],
  GLOB: [`01 01 04 ${ascii('*.ts')}`], // node 2 has one pattern
  TEST: ['01 00'], // one test, node 0
  UNCT: [`01 0f ${ascii('line 1: lexer E')}`], // node 5 has one cause
} as const;
type Tag = keyof typeof BODIES;
const TAGS = Object.keys(BODIES) as Tag[];
const layerOf = (tag: Tag): number => (tag === 'SNAP' ? 1 : 2);
const sectionsOf = (bodies: Readonly<Record<Tag, string>>): HandSection[] => TAGS.map((tag): HandSection => [tag, layerOf(tag), 1, 0, bodies[tag]]);
const BASE: Readonly<Record<Tag, string>> = Object.fromEntries(TAGS.map((tag) => [tag, BODIES[tag].join(' ')])) as Record<Tag, string>;

const VECTOR = assemble(HEADER, sectionsOf(BASE));
/** Vector 1 with some section bodies replaced. */
const vectorWith = (change: Partial<Record<Tag, string>>): Uint8Array => assemble(HEADER, sectionsOf({ ...BASE, ...change })).bytes;
/** Vector 1 with its section table rewritten. */
const vectorTable = (rewrite: (sections: HandSection[]) => HandSection[], count = '08 00'): Uint8Array =>
  assemble(HEADER.slice(0, -5) + count, rewrite(sectionsOf(BASE))).bytes;

const withMap = (change: (draft: { -readonly [K in keyof TrommelMap]: TrommelMap[K] }) => void): TrommelMap => {
  const draft = structuredClone(ONE) as { -readonly [K in keyof TrommelMap]: TrommelMap[K] };
  change(draft);
  return draft;
};
type Loose = Record<string, unknown>;

describe('vector 1', () => {
  it('has the bytes the specification gives', () => {
    expect(hexOf(encodeSmap(ONE))).toBe(hexOf(VECTOR.bytes));
  });

  it('is 460 bytes, with its sections where the specification says', () => {
    expect(VECTOR.bytes.length).toBe(460);
    expect(VECTOR.offsets).toEqual([159, 241, 281, 341, 358, 402, 409, 411]);
  });

  it('decodes to the map it was made from', () => {
    const { map } = decodeSmap(VECTOR.bytes);
    expect(map).toEqual(ONE);
    expect(canonicalJson(map)).toBe(canonicalJson(ONE));
  });

  it('gives the graph of that map', () => {
    const { graph } = decodeSmap(VECTOR.bytes);
    expect(graph.nodeCount).toBe(6);
    expect(graph.edgeCount).toBe(5);
    expect(graph.dependencies(graph.id('f:a.ts')!).map((id) => graph.name(id))).toEqual(['p:npm:node_modules/x', 'p:npm:node_modules/y', 'u:a.ts']);
    expect(graph.dependents(graph.id('f:a.ts')!).map((id) => graph.name(id))).toEqual(['f:a.test.ts']);
    expect(graph.dependencyProvenance(graph.id('f:a.test.ts')!)).toEqual([1, 4]);
  });

  it('gives the address of each layer', () => {
    const container = decodeContainer(VECTOR.bytes);
    expect(decodeSmap(VECTOR.bytes).layers).toEqual({ snapshot: layerAddress(container, SNAPSHOT_LAYER), static: layerAddress(container, STATIC_LAYER) });
  });
});

describe('round trips', () => {
  it('a map decodes to itself, and re-encodes to the same bytes', () => {
    fc.assert(
      fc.property(arbitraryMap, (map) => {
        const bytes = encodeSmap(map);
        const decoded = decodeSmap(bytes).map;
        expect(canonicalJson(decoded)).toBe(canonicalJson(map));
        expect(hexOf(encodeSmap(decoded))).toBe(hexOf(bytes));
      }),
      { numRuns: 300 },
    );
  });

  it('the decoded graph is the graph of the map', () => {
    fc.assert(
      fc.property(arbitraryMap, (map) => {
        const { graph } = decodeSmap(encodeSmap(map));
        const expected = mapGraph(map);
        expect(Array.from({ length: graph.nodeCount }, (_, id) => graph.name(id))).toEqual(Array.from({ length: expected.nodeCount }, (_, id) => expected.name(id)));
        expect(graph.fwdOffsets).toEqual(expected.fwdOffsets);
        expect(graph.fwdTargets).toEqual(expected.fwdTargets);
        expect(graph.fwdProvenance).toEqual(expected.fwdProvenance);
        expect(graph.revOffsets).toEqual(expected.revOffsets);
        expect(graph.revSources).toEqual(expected.revSources);
        expect(graph.revProvenance).toEqual(expected.revProvenance);
      }),
      { numRuns: 300 },
    );
  });

  it('the generator reaches what the format has to carry', () => {
    const seen = { sha256: false, surrogate: false, unparseable: false, none: false, nullPackage: false, symlink: false, submodule: false, uncertain: false, config: false };
    for (const map of fc.sample(arbitraryMap, { numRuns: 300, seed: 20261116 })) {
      seen.sha256 ||= map.objectFormat === 'sha256';
      seen.surrogate ||= Object.keys(map.nodes).some((key) => !key.isWellFormed());
      seen.unparseable ||= map.lockfile.kind === 'unparseable';
      seen.none ||= map.lockfile.kind === 'none';
      seen.nullPackage ||= Object.entries(map.nodes).some(([key, hash]) => key.startsWith('p:') && hash === null);
      seen.symlink ||= map.snapshot.some(([mode]) => mode === '120000');
      seen.submodule ||= map.snapshot.some(([mode]) => mode === '160000');
      seen.uncertain ||= Object.keys(map.uncertain).length > 0;
      seen.config ||= map.config !== null;
    }
    expect(seen).toEqual({ sha256: true, surrogate: true, unparseable: true, none: true, nullPackage: true, symlink: true, submodule: true, uncertain: true, config: true });
  });

  it('an empty repository round-trips', () => {
    const empty: TrommelMap = { ...ONE, lockfile: { kind: 'none' }, snapshot: [], nodes: {}, edges: {}, globs: {}, tests: [], uncertain: {} };
    const decoded = decodeSmap(encodeSmap(empty));
    expect(decoded.map).toEqual(empty);
    expect([decoded.graph.nodeCount, decoded.graph.edgeCount]).toEqual([0, 0]);
  });

  it('a sha256 repository round-trips with 32-byte ids', () => {
    const repo = fakeRepo({ 'src/a.ts': "import './b';\n", 'src/b.ts': '', 'a.test.ts': "import './src/a';\n" }, 'sha256');
    const map = buildStaticMap({ objectFormat: 'sha256', index: repo.index, vfs: repo.vfs, sources: repo.sources, tests: ['a.test.ts'], config: 'ab'.repeat(32) });
    expect(map.rootTree).toHaveLength(64);
    const bytes = encodeSmap(map);
    expect(decodeContainer(bytes).hash).toBe('sha256');
    expect(canonicalJson(decodeSmap(bytes).map)).toBe(canonicalJson(map));
  });

  it('a Buffer at a non-zero byteOffset decodes like a fresh array', () => {
    const pooled = Buffer.concat([Buffer.alloc(7), Buffer.from(VECTOR.bytes)]).subarray(7);
    expect(pooled.byteOffset).not.toBe(0);
    expect(decodeSmap(pooled).map).toEqual(ONE);
  });

  it('what it returns does not alias the file', () => {
    const bytes = VECTOR.bytes.slice();
    const { graph } = decodeSmap(bytes);
    bytes.fill(0);
    expect(graph.dependencyProvenance(graph.id('f:a.test.ts')!)).toEqual([1, 4]);
  });

  it('every lockfile state, a config and an undecodable count round-trip', () => {
    for (const lockfile of [{ kind: 'none' }, { kind: 'npm', path: 'package-lock.json' }, { kind: 'unparseable', paths: ['pnpm-lock.yaml', 'yarn.lock'], reason: 'two lockfiles' }] as const) {
      const map: TrommelMap = { ...ONE, lockfile, config: '5c'.repeat(20), undecodable: 300 };
      expect(decodeSmap(encodeSmap(map)).map).toEqual(map);
    }
  });

  it('strings with an unpaired surrogate round-trip in keys, patterns and causes', () => {
    const lone = '\ud800';
    const map = withMap((draft) => {
      draft.nodes = { ...draft.nodes, [`g:glob:${lone}`]: 'dd'.repeat(32), [`u:${lone}`]: sha256(canonicalJson([`cause ${lone}`])) };
      draft.globs = { ...draft.globs, [`g:glob:${lone}`]: [`./${lone}*`] };
      draft.uncertain = { ...draft.uncertain, [`u:${lone}`]: [`cause ${lone}`] };
    });
    expect(decodeSmap(encodeSmap(map)).map).toEqual(map);
  });

  it('the snapshot layer is addressed apart from the static layer', () => {
    const repo = fakeRepo({ 'src/a.ts': '', 'a.test.ts': "import './src/a';\n", 'b.test.ts': '' });
    const build = (tests: string[]): TrommelMap => buildStaticMap({ objectFormat: 'sha1', index: repo.index, vfs: repo.vfs, sources: repo.sources, tests });
    const one = decodeSmap(encodeSmap(build(['a.test.ts']))).layers;
    const two = decodeSmap(encodeSmap(build(['a.test.ts', 'b.test.ts']))).layers;
    expect(two.snapshot).toBe(one.snapshot);
    expect(two.static).not.toBe(one.static);
    expect(one.snapshot).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decodeSmap', () => {
  it("refuses another engine's map, and says which", () => {
    expect(() => decodeSmap(VECTOR.bytes, 'trommel-static-9')).toThrow(MapError);
    expect(() => decodeSmap(VECTOR.bytes, 'trommel-static-9')).toThrow(/built by engine "trommel-static-3", expected trommel-static-9/);
    expect(ENGINE).toBe('trommel-static-3');
  });

  it('skips an optional section it does not know', () => {
    const bytes = vectorTable((sections) => [...sections, ['XTRA', 2, 0, 7, 'de ad']], '09 00');
    expect(decodeSmap(bytes).map).toEqual(ONE);
  });

  it.each([
    ['a required section it does not know', vectorTable((s) => [...s, ['XTRA', 2, 1, 0, 'de ad']], '09 00'), /XTRA/],
    ['a required section of a layer it does not know', vectorTable((s) => [...s, ['RCRD', 3, 1, 0, '']], '09 00'), /RCRD/],
    ['a known section at another version', vectorTable((s) => s.map((x): HandSection => (x[0] === 'KEYS' ? [x[0], x[1], x[2], 1, x[4]] : x))), /KEYS has version 1/],
    ['a known section that is optional', vectorTable((s) => s.map((x): HandSection => (x[0] === 'TEST' ? [x[0], x[1], 0, x[3], x[4]] : x))), /TEST/],
    ['a missing section', vectorTable((s) => s.filter((x) => x[0] !== 'KEYS'), '07 00'), /no section KEYS/],
    ['the snapshot in the static layer', vectorTable((s) => s.map((x): HandSection => (x[0] === 'SNAP' ? [x[0], 2, x[2], x[3], x[4]] : x))), /SNAP.*layer 2/],
    ['sections out of order', vectorTable((s) => [s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[6]!, s[5]!, s[7]!]), /order/],
  ])('rejects %s', (_name, bytes, message) => {
    expect(() => decodeSmap(bytes)).toThrow(MapError);
    expect(() => decodeSmap(bytes)).toThrow(message);
  });

  it.each<[string, Partial<Record<Tag, string>>, RegExp]>([
    ['a byte left over in a section', { TEST: '01 00 00' }, /section TEST.*left over/],
    ['a section that ends early', { UNCT: '01 0f 61' }, /section UNCT.*early/],
    ['snapshot paths out of order', { SNAP: `${run('aa', 20)} 00 02 a4 83 02 ${run('22', 20)} 00 04 ${ascii('a.ts')} a4 83 02 ${run('11', 20)} 03 06 ${ascii('est.ts')}` }, /section SNAP.*order/],
    ['a mode past six octal digits', { SNAP: `${run('aa', 20)} 00 01 80 80 10 ${run('11', 20)} 00 01 61` }, /section SNAP.*mode/],
    ['an entry count the section cannot hold', { SNAP: `${run('aa', 20)} 00 ff ff 03` }, /section SNAP.*count/],
    ["a graph of a tree that is not the snapshot's", { META: `${run('ab', 20)} 00 01 11 ${ascii('package-lock.json')}` }, /section META.*tree/],
    ['a config flag of 2', { META: `${run('aa', 20)} 02 00` }, /section META.*config/],
    ['a lockfile kind of 3', { META: `${run('aa', 20)} 00 03` }, /section META.*lockfile/],
    ['keys out of order', { KEYS: `02 00 06 ${ascii('f:a.ts')} 05 06 ${ascii('est.ts')}` }, /section KEYS.*order/],
    ['a key twice', { KEYS: `02 00 06 ${ascii('f:a.ts')} 06 00` }, /section KEYS.*order/],
    ['a key with no kind', { KEYS: `01 00 03 ${ascii('abc')}` }, /section KEYS.*kind/],
    ['a key whose kind is empty', { KEYS: `01 00 03 ${ascii(':ab')}` }, /section KEYS.*kind/],
    ['a target that is not a node', { EDGE: '05 02 01 01 03 03 01 02 00 00 00 00 01 04 01 01 01' }, /section EDGE.*target/],
    ['targets that do not ascend', { EDGE: '05 02 01 00 03 03 01 01 00 00 00 00 01 04 01 01 01' }, /section EDGE.*ascend/],
    ['a provenance of 0', { EDGE: '05 02 01 01 03 03 01 01 00 00 00 00 01 04 01 01 00' }, /section EDGE.*provenance/],
    ['a provenance of 8', { EDGE: '05 02 01 01 03 03 01 01 00 00 00 00 08 04 01 01 01' }, /section EDGE.*provenance/],
    ['an edge total above the sum of the degrees', { EDGE: '06 02 01 01 03 03 01 01 00 00 00 00 01 04 01 01 01 01' }, /section EDGE.*total/],
    ['an edge total below the sum of the degrees', { EDGE: '04 02 01 01 03 03 01 01 00 00 00 00 01 04 01 01' }, /section EDGE.*total/],
    ['a hash form of 3', { HASH: `03 ${run('cc', 32)} 02 08 ${ascii('sha512-X')} 00` }, /section HASH.*form/],
    ['a SHA-256 written as a string', { HASH: `02 40 ${ascii('cc'.repeat(32))} 02 08 ${ascii('sha512-X')} 00` }, /section HASH.*form/],
    ['a pattern flag of 2', { GLOB: `02 01 04 ${ascii('*.ts')}` }, /section GLOB.*flag/],
    ['a test that is not a file node', { TEST: '01 02' }, /section TEST.*f:/],
    ['a test that is not a node', { TEST: '01 06' }, /section TEST/],
    ['tests that do not ascend', { TEST: '02 00 00' }, /section TEST.*ascend/],
  ])('rejects %s', (_name, change, message) => {
    const bytes = vectorWith(change);
    expect(() => decodeSmap(bytes)).toThrow(MapError);
    expect(() => decodeSmap(bytes)).toThrow(message);
  });

  it.each(TAGS)('rejects a byte left over at the end of %s', (tag) => {
    const bytes = vectorWith({ [tag]: `${BASE[tag]} 00` });
    expect(() => decodeSmap(bytes)).toThrow(MapError);
    expect(() => decodeSmap(bytes)).toThrow(new RegExp(`section ${tag}.*left over`));
  });

  it('rejects what is not a SMAP file', () => {
    expect(() => decodeSmap(new TextEncoder().encode(canonicalJson(ONE)))).toThrow(/not a SMAP file/);
    expect(() => decodeSmap(new Uint8Array(0))).toThrow(MapError);
  });
});

describe('encodeSmap refuses', () => {
  const lone = (key: string, hash: string | null) => (draft: { nodes: TrommelMap['nodes'] }) => {
    draft.nodes = { ...draft.nodes, [key]: hash };
  };
  it.each<[string, TrommelMap, RegExp]>([
    ['a file node whose hash the snapshot does not give', withMap(lone('f:a.ts', '33'.repeat(20))), /f:a\.ts/],
    ['a file node for an absent path that has a hash', withMap(lone('f:gone.ts', '33'.repeat(20))), /f:gone\.ts/],
    ['a directory node whose hash the snapshot does not give', withMap(lone('d:src', 'ee'.repeat(32))), /d:src/],
    ['an uncertain node whose hash is not that of its causes', withMap(lone('u:a.ts', 'ee'.repeat(32))), /u:a\.ts/],
    ['an uncertain node with no causes', withMap((d) => (d.uncertain = {})), /u:a\.ts/],
    ['causes for a node that is not uncertain', withMap((d) => (d.uncertain = { ...d.uncertain, 'f:a.ts': ['x'] })), /f:a\.ts/],
    ['an edge from a key that is not a node', withMap((d) => (d.edges = { ...d.edges, 'f:nope': { 'f:a.ts': 1 } })), /f:nope/],
    ['an edge to a key that is not a node', withMap((d) => (d.edges = { ...d.edges, 'g:glob:k': { 'f:nope': 1 } })), /f:nope/],
    ['a node with an empty edge list', withMap((d) => (d.edges = { ...d.edges, 'g:glob:k': {} })), /g:glob:k/],
    ['a provenance of 0', withMap((d) => (d.edges = { ...d.edges, 'g:glob:k': { 'f:a.ts': 0 } })), /provenance/],
    ['a provenance of 8', withMap((d) => (d.edges = { ...d.edges, 'g:glob:k': { 'f:a.ts': 8 } })), /provenance/],
    ['a test that is not a file node', withMap((d) => (d.tests = ['nope.test.ts'])), /nope\.test\.ts/],
    ['tests out of order', withMap((d) => (d.tests = ['a.ts', 'a.test.ts'])), /tests/],
    ['a test listed twice', withMap((d) => (d.tests = ['a.test.ts', 'a.test.ts'])), /tests/],
    ['patterns for a key that is not a glob node', withMap((d) => (d.globs = { 'f:a.ts': ['*'] })), /f:a\.ts/],
    ['a snapshot out of order', withMap((d) => (d.snapshot = [...d.snapshot].reverse())), /snapshot/],
    ['a mode that is not six octal digits', withMap((d) => (d.snapshot = [['100644 ', '11'.repeat(20), 'a.test.ts'], d.snapshot[1]!])), /mode/],
    ['an object id of the wrong length', withMap((d) => (d.rootTree = 'aa'.repeat(32))), /hex/],
    ['an object id in uppercase', withMap((d) => (d.rootTree = 'AA'.repeat(20))), /hex/],
    ['a config that is not an object id', withMap((d) => (d.config = 'HEAD')), /hex/],
    ['a key with no kind', withMap(lone('nokind', null)), /nokind/],
    ['another map version', withMap((d) => (d.version = 2)), /version 2/],
    ['an unknown object format', withMap((d) => ((d as Loose)['objectFormat'] = 'md5')), /md5/],
    ['an unknown lockfile kind', withMap((d) => ((d as Loose)['lockfile'] = { kind: 'pnpm' })), /lockfile/],
    ['a hash that is not a string', withMap((d) => ((d.nodes as Loose) = { ...d.nodes, 'g:glob:k': 7 })), /g:glob:k/],
  ])('%s', (_name, map, message) => {
    expect(() => encodeSmap(map)).toThrow(SmapEncodeError);
    expect(() => encodeSmap(map)).toThrow(message);
  });

  it('but takes the map it was given, whatever order its keys are in', () => {
    const shuffled: TrommelMap = { ...ONE, nodes: Object.fromEntries(Object.entries(ONE.nodes).reverse()), edges: Object.fromEntries(Object.entries(ONE.edges).reverse()) };
    expect(hexOf(encodeSmap(shuffled))).toBe(hexOf(VECTOR.bytes));
    expect(bytesOf(hexOf(VECTOR.bytes))).toEqual(VECTOR.bytes);
  });
});
