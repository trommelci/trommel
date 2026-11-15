import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/canonical-json.ts';
import { DECLARED, STATIC } from '../../src/graph/graph.ts';
import { buildStaticMap, isLexed, isModule, listingHash, type TrommelMap, type StaticInput } from '../../src/graph/static.ts';
import { fakeRepo, type FakeRepo } from './fake-repo.ts';

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-L', dependencies: { dep: '^1', gone: '^1' } },
    'node_modules/dep': { version: '1.0.0', integrity: 'sha512-D' },
  },
});

function build(repo: FakeRepo, options: Partial<StaticInput> = {}): TrommelMap {
  const tests = repo.vfs.files().filter((path) => /\.test\.[jt]s$/.test(path));
  return buildStaticMap({ objectFormat: 'sha1', index: repo.index, vfs: repo.vfs, sources: repo.sources, tests, ...options });
}

const edgesFrom = (map: TrommelMap, from: string) => map.edges[from] ?? {};

describe('module files', () => {
  it.each([
    ['src/a.ts', true, true],
    ['src/a.tsx', true, true],
    ['src/a.mts', true, true],
    ['src/a.cjs', true, true],
    ['src/a.jsx', true, true],
    ['src/a.d.ts', true, false],
    ['src/a.d.mts', true, false],
    ['src/styles.d.css.ts', true, false],
    ['src/a.json', false, false],
    ['src/a.md', false, false],
  ])('%s: module %s, lexed %s', (path, module, lexed) => {
    expect(isModule(path)).toBe(module);
    expect(isLexed(path)).toBe(lexed);
  });
});

describe('buildStaticMap', () => {
  const repo = fakeRepo({
    'package.json': '{"name":"app"}',
    'package-lock.json': LOCK,
    'tsconfig.json': '{}',
    'src/a.ts': "import { b } from './b';\nimport type { T } from './types';\nimport { type U } from './types2';\nimport _ from 'lodash';\n",
    'src/b.ts': 'export const b = 1;\n',
    'src/types.ts': 'export type T = 1;\n',
    'src/types2.ts': 'export type U = 1;\n',
    'src/decl.d.ts': "import './never-lexed';\n",
    'test/a.test.ts': "import { a } from '../src/a';\n",
    'docs/guide.md': '# guide\n',
  });
  const map = build(repo, { global: ['package.json', '.env*'] });

  it('describes the snapshot', () => {
    expect(map.version).toBe(1);
    expect(map.objectFormat).toBe('sha1');
    expect(map.rootTree).toBe(repo.index.rootOid);
    expect(map.lockfile).toEqual({ kind: 'npm', path: 'package-lock.json' });
    expect(map.tests).toEqual(['test/a.test.ts']);
    expect(map.snapshot.map(([, , path]) => path)).toContain('src');
    expect(map.uncertain).toEqual({});
  });

  it('hashes files by blob id, and an absent path outside every hub as null', () => {
    expect(map.nodes['f:src/b.ts']).toBe(repo.vfs.oid('src/b.ts'));
    expect(map.nodes['f:pnpm-workspace.yaml']).toBeNull(); // a bare import's workspace lookup
  });

  it("keeps a resolution's probes in its hub's hash, not as nodes", () => {
    expect('f:src/b.js' in map.nodes).toBe(false);
    expect('d:src/b' in map.nodes).toBe(false);
    expect('f:src/package.json' in map.nodes).toBe(false);
    expect(map.nodes['r:src/b']).toMatch(/^[0-9a-f]{64}$/);
    expect(map.nodes['c:src']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds every module file as a node, even one nothing imports, and never non-module files', () => {
    expect(map.nodes['f:src/types.ts']).toBe(repo.vfs.oid('src/types.ts'));
    expect(map.nodes['f:src/decl.d.ts']).toBe(repo.vfs.oid('src/decl.d.ts'));
    expect('f:docs/guide.md' in map.nodes).toBe(false);
  });

  it('gives an import one STATIC edge, to the r: hub of the path it resolves, which links to what exists', () => {
    expect(edgesFrom(map, 'f:src/a.ts')['r:src/b']).toBe(STATIC);
    expect(edgesFrom(map, 'f:src/a.ts')['f:src/b.ts']).toBeUndefined();
    expect(edgesFrom(map, 'r:src/b')).toEqual({ 'f:src/b.ts': STATIC });
    expect(edgesFrom(map, 'f:test/a.test.ts')['r:src/a']).toBe(STATIC);
    expect(edgesFrom(map, 'r:src/a')).toEqual({ 'f:src/a.ts': STATIC });
  });

  it('links an import of a path that exists exactly to the file itself, with no hub', () => {
    const exact = build(fakeRepo({ 'src/a.ts': "import './b.ts';\n", 'src/b.ts': '' }));
    expect(edgesFrom(exact, 'f:src/a.ts')['f:src/b.ts']).toBe(STATIC);
    expect('r:src/b.ts' in exact.nodes).toBe(false);
  });

  it('keeps the hub of a symlink whose target is missing, since the target may appear', () => {
    const dangling = build(fakeRepo({ 'src/a.ts': "import './link.ts';\n", 'src/link.ts': { mode: '120000', content: 'real.ts' } }));
    expect(edgesFrom(dangling, 'f:src/a.ts')['r:src/link.ts']).toBe(STATIC);
    expect(edgesFrom(dangling, 'r:src/link.ts')).toEqual({ 'f:src/link.ts': STATIC });
  });

  it('hashes a hub by which of its candidates exist, and leaves contents to the edges', () => {
    const files = { 'src/a.ts': "import './b';\n", 'src/b.ts': 'export {};\n' };
    const hub = (extra: Record<string, string>) => build(fakeRepo({ ...files, ...extra })).nodes['r:src/b'];
    expect(hub({ 'src/b.ts': 'export const b = 2;\n' })).toBe(hub({}));
    expect(hub({ 'src/b.js': '' })).not.toBe(hub({}));
    expect(hub({ 'src/b/index.ts': '' })).not.toBe(hub({}));
    expect(hub({ 'src/other.ts': '' })).toBe(hub({}));
  });

  it("hashes a probed directory's listing into its hub, as its d: node was before", () => {
    const files = { 'src/a.ts': "import './d';\n", 'src/d/index.ts': '' };
    const hub = (extra: Record<string, string>) => build(fakeRepo({ ...files, ...extra })).nodes['r:src/d'];
    expect(hub({ 'src/d/other.ts': '' })).not.toBe(hub({}));
  });

  it('skips statement-level type imports but keeps inline ones, which still evaluate the module', () => {
    const a = edgesFrom(map, 'f:src/a.ts');
    expect(a['r:src/types']).toBeUndefined();
    expect(a['r:src/types2']).toBe(STATIC);
  });

  it('never lexes declaration files', () => {
    expect(map.edges['f:src/decl.d.ts']).toBeUndefined();
  });

  it("gives every source file one edge to its directory's c: hub, which links to the configs that exist", () => {
    expect(edgesFrom(map, 'f:src/a.ts')['c:src']).toBe(STATIC);
    expect(edgesFrom(map, 'f:src/b.ts')['c:src']).toBe(STATIC);
    expect(edgesFrom(map, 'c:src')).toEqual({ 'f:package.json': STATIC, 'f:tsconfig.json': STATIC });
    expect(edgesFrom(map, 'f:test/a.test.ts')['c:test']).toBe(STATIC);
    expect(edgesFrom(map, 'f:src/a.ts')['f:tsconfig.json']).toBeUndefined();
  });

  it("hashes a c: hub by which configs exist on the way up, so a new tsconfig.json changes it", () => {
    const files = { 'package.json': '{}', 'src/a.ts': '' };
    const hub = (extra: Record<string, string>) => build(fakeRepo({ ...files, ...extra })).nodes['c:src'];
    expect(hub({ 'package.json': '{"type":"module"}' })).toBe(hub({}));
    expect(hub({ 'src/tsconfig.json': '{}' })).not.toBe(hub({}));
    expect(hub({ 'src/package.json': '{}' })).not.toBe(hub({}));
  });

  it('maps a bare import to its lockfile location and packages to their dependencies', () => {
    expect(edgesFrom(map, 'f:src/a.ts')['p:npm:node_modules/lodash']).toBe(STATIC);
    expect(map.nodes['p:npm:node_modules/lodash']).toBe('sha512-L');
    expect(edgesFrom(map, 'p:npm:node_modules/lodash')).toEqual({ 'p:npm:node_modules/dep': STATIC, 'p:npm:node_modules/gone': STATIC });
    expect(map.nodes['p:npm:node_modules/gone']).toBeNull();
  });

  it('makes each test depend on the global inputs, as DECLARED edges', () => {
    const test = edgesFrom(map, 'f:test/a.test.ts');
    expect(test['g:inputs.global']).toBe(DECLARED);
    expect(edgesFrom(map, 'g:inputs.global')).toEqual({ 'f:package.json': DECLARED });
    expect(map.globs['g:inputs.global']).toEqual(['package.json', '.env*']);
  });

  it('holds nothing about the machine that built it: every node is a file, listing, glob, package or hub', () => {
    expect(Object.keys(map.nodes).filter((key) => !/^[fdgprc]:/.test(key))).toEqual([]);
  });

  it('hashes a directory listing by names and kinds, not contents', () => {
    const edited = fakeRepo({ 'src/a.ts': 'changed', 'src/b.ts': '' });
    const same = fakeRepo({ 'src/a.ts': 'original', 'src/b.ts': '' });
    const symlinked = fakeRepo({ 'src/a.ts': { mode: '120000', content: 'b.ts' }, 'src/b.ts': '' });
    expect(listingHash(edited.index, 'src')).toBe(listingHash(same.index, 'src'));
    expect(listingHash(symlinked.index, 'src')).not.toBe(listingHash(same.index, 'src'));
    expect(listingHash(same.index, 'missing')).toBeNull();
    expect(listingHash(same.index, 'src/a.ts')).toBeNull();
  });
});

// Spec 2026-11-15-pnpm-yarn-lockfiles §6.4. Each repository has a root and packages/a, and
// packages/a/test/x.test.ts imports foo, which packages/a declares, and vitest, which only the root
// declares: foo goes through a's lookup location (case 1), vitest through its name node (case 2).
const TEST_FILE = { 'packages/a/test/x.test.ts': "import 'foo';\nimport 'vitest';\n" };

const PNPM_LOCK = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    configDependencies: {}',
  '    packageManagerDependencies:',
  '      pnpm:',
  '        specifier: 12.0.0',
  '        version: 12.0.0',
  '',
  'packages:',
  '',
  '  pnpm@12.0.0:',
  '    resolution: {integrity: sha512-pnpm}',
  '',
  'snapshots:',
  '',
  '  pnpm@12.0.0: {}',
  '',
  '---',
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    devDependencies:',
  '      vitest:',
  '        specifier: 5.0.1',
  '        version: 5.0.1',
  '',
  '  packages/a:',
  '    dependencies:',
  '      foo:',
  '        specifier: ^1.0.0',
  '        version: 1.0.0',
  '',
  'packages:',
  '',
  '  foo@1.0.0:',
  '    resolution: {integrity: sha512-foo}',
  '',
  '  vitest@5.0.1:',
  '    resolution: {integrity: sha512-vitest}',
  '',
  'snapshots:',
  '',
  '  foo@1.0.0: {}',
  '',
  '  vitest@5.0.1: {}',
  '',
].join('\n');

const PNPM_REPO = {
  'package.json': '{"name":"root","private":true}\n',
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': PNPM_LOCK,
  'packages/a/package.json': '{"name":"a"}\n',
  ...TEST_FILE,
};

const BERRY_LOCK = [
  '__metadata:',
  '  version: 8',
  '  cacheKey: 10c0',
  '',
  '"a@workspace:packages/a":',
  '  version: 0.0.0-use.local',
  '  resolution: "a@workspace:packages/a"',
  '  dependencies:',
  '    foo: "npm:^1.0.0"',
  '  languageName: unknown',
  '  linkType: soft',
  '',
  '"foo@npm:^1.0.0":',
  '  version: 1.0.0',
  '  resolution: "foo@npm:1.0.0"',
  '  checksum: 10c0/foo',
  '  languageName: node',
  '  linkType: hard',
  '',
  '"root@workspace:.":',
  '  version: 0.0.0-use.local',
  '  resolution: "root@workspace:."',
  '  dependencies:',
  '    vitest: "npm:5.0.1"',
  '  languageName: unknown',
  '  linkType: soft',
  '',
  '"vitest@npm:5.0.1":',
  '  version: 5.0.1',
  '  resolution: "vitest@npm:5.0.1"',
  '  checksum: 10c0/vitest',
  '  languageName: node',
  '  linkType: hard',
  '',
].join('\n');

const CLASSIC_LOCK = [
  '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
  '# yarn lockfile v1',
  '',
  '',
  'foo@^1.0.0:',
  '  version "1.0.0"',
  '  resolved "https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz#f00"',
  '  integrity sha512-foo',
  '',
  'vitest@5.0.1:',
  '  version "5.0.1"',
  '  resolved "https://registry.yarnpkg.com/vitest/-/vitest-5.0.1.tgz#5e5"',
  '  integrity sha512-vitest',
  '',
].join('\n');

/**
 * The yarn repository around a yarn.lock; classic yarn reads the declarations from these
 * package.json files. `change` replaces files, and removes those it gives as null.
 */
const yarnRepo = (lock: string, change: Readonly<Record<string, string | null>> = {}): FakeRepo => {
  const files: Record<string, string | null> = {
    'package.json': '{"name":"root","private":true,"workspaces":["packages/*"],"devDependencies":{"vitest":"5.0.1"}}\n',
    'packages/a/package.json': '{"name":"a","dependencies":{"foo":"^1.0.0"}}\n',
    'yarn.lock': lock,
    ...TEST_FILE,
    ...change,
  };
  return fakeRepo(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== null)));
};

/** The edges and nodes §6.4 gives the test file: case 1 for foo, case 2 for vitest. */
function expectWorkspaceShape(map: TrommelMap, prefix: string, foo: string, vitest: string): void {
  const test = edgesFrom(map, 'f:packages/a/test/x.test.ts');
  // foo: a's own lookup location, whose hash is the id it resolves to, then the entry.
  expect(test['p:npm:packages/a/node_modules/foo']).toBe(STATIC);
  expect(map.nodes['p:npm:packages/a/node_modules/foo']).toBe(foo);
  expect(edgesFrom(map, 'p:npm:packages/a/node_modules/foo')).toEqual({ [prefix + foo]: STATIC });
  expect(map.nodes[prefix + foo]).toMatch(/^[0-9a-f]{64}$/);
  // vitest: the name node, not the root's lookup location, then every entry of that name.
  expect(test[`${prefix}vitest@*`]).toBe(STATIC);
  expect(test['p:npm:node_modules/vitest']).toBeUndefined();
  expect(map.nodes[`${prefix}vitest@*`]).toMatch(/^[0-9a-f]{64}$/);
  expect(edgesFrom(map, `${prefix}vitest@*`)).toEqual({ [prefix + vitest]: STATIC });
  // The root's lookup location is in the map too, from the lockfile's own nodes.
  expect(map.nodes['p:npm:node_modules/vitest']).toBe(vitest);
  expect(edgesFrom(map, 'p:npm:node_modules/vitest')).toEqual({ [prefix + vitest]: STATIC });
  expect(map.uncertain).toEqual({});
}

describe('pnpm and yarn lockfiles', () => {
  it('maps a pnpm workspace: lookups, entries, name nodes and #env', () => {
    const map = build(fakeRepo(PNPM_REPO));
    expect(map.lockfile).toEqual({ kind: 'pnpm', path: 'pnpm-lock.yaml' });
    expectWorkspaceShape(map, 'p:pnpm:', 'foo@1.0.0', 'vitest@5.0.1');
    expect(map.nodes['p:pnpm:#env']).toMatch(/^[0-9a-f]{64}$/);
    expect(map.edges['p:pnpm:#env']).toBeUndefined();
    expect(Object.values(map.edges).some((out) => 'p:pnpm:#env' in out)).toBe(false);
  });

  it('maps a Berry workspace', () => {
    const map = build(yarnRepo(BERRY_LOCK));
    expect(map.lockfile).toEqual({ kind: 'yarn-berry', path: 'yarn.lock' });
    expectWorkspaceShape(map, 'p:yarn:', 'foo@npm:1.0.0', 'vitest@npm:5.0.1');
    expect(Object.keys(map.nodes).filter((key) => key.includes('#env'))).toEqual([]);
  });

  it('maps a classic yarn workspace from its package.json files', () => {
    const map = build(yarnRepo(CLASSIC_LOCK));
    expect(map.lockfile).toEqual({ kind: 'yarn-classic', path: 'yarn.lock' });
    expectWorkspaceShape(map, 'p:yarn:', 'foo@1.0.0', 'vitest@5.0.1');
    expect(Object.keys(map.nodes).filter((key) => key.includes('#env'))).toEqual([]);
  });

  it.each<[string, Readonly<Record<string, string | null>>, string]>([
    ['the root package.json is missing', { 'package.json': null }, 'package.json cannot be read'],
    ["a member's package.json is not JSON", { 'packages/a/package.json': '{' }, 'packages/a/package.json cannot be read'],
    ["a member's package.json is not an object", { 'packages/a/package.json': '[]' }, 'packages/a/package.json cannot be read'],
    ["a member's dependencies are not an object", { 'packages/a/package.json': '{"name":"a","dependencies":["foo"]}' }, 'packages/a/package.json cannot be read'],
    ["the root's devDependencies are null", { 'package.json': '{"name":"root","workspaces":["packages/*"],"devDependencies":null}' }, 'package.json cannot be read'],
  ])('refuses a classic yarn workspace when %s', (_name, change, reason) => {
    const map = build(yarnRepo(CLASSIC_LOCK, change));
    expect(map.lockfile).toEqual({ kind: 'unparseable', paths: ['yarn.lock'], reason });
    expect(edgesFrom(map, 'f:packages/a/test/x.test.ts')['f:yarn.lock']).toBe(STATIC);
  });

  it('links a workspace package that a classic yarn member declares and the lockfile has no entry for', () => {
    const map = build(
      yarnRepo(CLASSIC_LOCK, {
        'packages/a/package.json': '{"name":"a","dependencies":{"foo":"^1.0.0","b":"1.0.0"}}\n',
        'packages/b/package.json': '{"name":"b","version":"1.0.0"}\n',
      }),
    );
    expect(map.lockfile).toEqual({ kind: 'yarn-classic', path: 'yarn.lock' });
    expect(map.nodes['p:npm:packages/a/node_modules/b']).toBe('link:packages/b');
    expect(map.edges['p:npm:packages/a/node_modules/b']).toBeUndefined();
    expect(map.nodes['p:npm:packages/b/node_modules/foo']).toBeUndefined(); // b's package.json declares nothing
  });

  it('reads past declarations that are not strings, in a classic yarn workspace', () => {
    const map = build(yarnRepo(CLASSIC_LOCK, { 'packages/a/package.json': '{"name":"a","dependencies":{"foo":"^1.0.0","odd":7}}\n' }));
    expect(map.lockfile).toEqual({ kind: 'yarn-classic', path: 'yarn.lock' });
    expect('p:npm:packages/a/node_modules/odd' in map.nodes).toBe(false);
  });

  it('a name the lockfile does not know is uncertain, as with npm', () => {
    const map = build(fakeRepo({ ...PNPM_REPO, 'packages/a/src/b.ts': "import 'nope';\n" }));
    expect(map.uncertain['u:packages/a/src/b.ts']).toEqual(['line 1: nope is not in pnpm-lock.yaml']);
    expect(edgesFrom(map, 'f:packages/a/src/b.ts')['p:npm:node_modules/nope']).toBe(STATIC);
    expect(map.nodes['p:npm:node_modules/nope']).toBeNull();
  });
});

describe('uncertainty', () => {
  it('turns lexer diagnostics, unresolved imports and packages missing from the lockfile into a u: node', () => {
    const repo = fakeRepo({
      'package-lock.json': LOCK,
      'src/a.ts': "import './missing';\nconst m = await import(name);\nimport 'left-pad';\nimport 'https://x.example/m.js';\n",
      'src/b.ts': "const s = 'unterminated\n",
      'src/c.ts': "import './a';\n",
    });
    const map = build(repo);
    expect(map.uncertain['u:src/a.ts']).toEqual([
      'line 1: ./missing is unresolved (not found)',
      'line 2: a dynamic import with a non-literal specifier is unresolved (non-literal)',
      'line 3: left-pad is not in package-lock.json',
      'line 4: https://x.example/m.js is unresolved (remote module)',
    ]);
    expect(map.uncertain['u:src/b.ts']).toEqual(['line 1: lexer unterminated-string']);
    expect(map.uncertain['u:src/c.ts']).toBeUndefined();
    expect(edgesFrom(map, 'f:src/a.ts')['u:src/a.ts']).toBe(STATIC);
    expect(edgesFrom(map, 'f:src/a.ts')['p:npm:node_modules/left-pad']).toBe(STATIC);
    expect(map.nodes['p:npm:node_modules/left-pad']).toBeNull();
    expect(map.nodes['u:src/a.ts']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks every external import uncertain when there is no lockfile', () => {
    const map = build(fakeRepo({ 'src/a.ts': "import 'lodash';\n" }));
    expect(map.lockfile).toEqual({ kind: 'none' });
    expect(map.uncertain['u:src/a.ts']).toEqual(['line 1: lodash: there is no lockfile']);
  });

  it('makes external imports depend on a lockfile it cannot parse', () => {
    const map = build(fakeRepo({ 'bun.lock': '{}\n', 'src/a.ts': "import 'lodash';\n" }));
    expect(map.lockfile).toEqual({ kind: 'unparseable', paths: ['bun.lock'], reason: 'bun lockfiles are not parsed' });
    expect(edgesFrom(map, 'f:src/a.ts')['f:bun.lock']).toBe(STATIC);
    expect(map.uncertain).toEqual({});
  });

  it('makes external imports depend on a pnpm lockfile of a version it does not read', () => {
    const map = build(fakeRepo({ 'pnpm-lock.yaml': "lockfileVersion: '6.0'\n", 'src/a.ts': "import 'lodash';\n" }));
    expect(map.lockfile).toMatchObject({ kind: 'unparseable', paths: ['pnpm-lock.yaml'] });
    expect(map.lockfile.kind === 'unparseable' ? map.lockfile.reason : null).toMatch(/lockfileVersion/);
    expect(edgesFrom(map, 'f:src/a.ts')['f:pnpm-lock.yaml']).toBe(STATIC);
    expect(map.uncertain).toEqual({});
  });

  it('reports every lockfile when there is more than one', () => {
    const map = build(fakeRepo({ 'package-lock.json': LOCK, 'yarn.lock': '', 'src/a.ts': "import 'lodash';\n" }));
    expect(map.lockfile).toMatchObject({ kind: 'unparseable', paths: ['package-lock.json', 'yarn.lock'] });
    expect(edgesFrom(map, 'f:src/a.ts')).toMatchObject({ 'f:package-lock.json': STATIC, 'f:yarn.lock': STATIC });
  });
});

describe('globs and declared inputs', () => {
  it('records import.meta.glob as a g: node with its patterns', () => {
    const map = build(fakeRepo({ 'src/r.ts': "import.meta.glob(['./pages/*.ts', '!./pages/_*.ts']);\n", 'src/pages/a.ts': '', 'src/pages/_b.ts': '' }));
    const key = 'g:glob:src/pages/*.ts|!src/pages/_*.ts';
    expect(edgesFrom(map, 'f:src/r.ts')[key]).toBe(STATIC);
    expect(edgesFrom(map, 'f:src/r.ts')['f:src/pages/a.ts']).toBe(STATIC);
    expect(map.globs[key]).toEqual(['src/pages/*.ts', '!src/pages/_*.ts']);
  });

  it('makes a bare import depend on the workspaces node', () => {
    const map = build(fakeRepo({ 'package.json': '{"name":"r","workspaces":["pkgs/*"]}', 'pkgs/p/package.json': '{"name":"p"}', 'pkgs/p/index.js': '', 'src/a.ts': "import 'p';\n" }));
    expect(edgesFrom(map, 'f:src/a.ts')['g:workspaces']).toBe(STATIC);
    expect(edgesFrom(map, 'f:src/a.ts')['r:pkgs/p/index']).toBe(STATIC);
    expect(edgesFrom(map, 'r:pkgs/p/index')).toEqual({ 'f:pkgs/p/index.js': STATIC });
    expect(edgesFrom(map, 'f:src/a.ts')['f:pkgs/p/package.json']).toBe(STATIC);
    expect('g:workspaces' in map.globs).toBe(false);
  });

  it('connects tests to declared match→affects rules', () => {
    const repo = fakeRepo({ 'fixtures/pay/a.json': '{}', 'test/pay/x.test.ts': '', 'test/other.test.ts': '' });
    const map = build(repo, { declared: [{ match: 'fixtures/pay/**', affects: 'test/pay/**' }] });
    expect(edgesFrom(map, 'f:test/pay/x.test.ts')['g:declared:fixtures/pay/**']).toBe(DECLARED);
    expect(edgesFrom(map, 'f:test/other.test.ts')['g:declared:fixtures/pay/**']).toBeUndefined();
    expect(edgesFrom(map, 'g:declared:fixtures/pay/**')).toEqual({ 'f:fixtures/pay/a.json': DECLARED });
  });
});

describe('determinism', () => {
  it('gives identical bytes whatever order the sources arrive in', () => {
    const files = { 'src/a.ts': "import './b';\nimport './c';\n", 'src/b.ts': "import './c';\n", 'src/c.ts': '', 'a.test.ts': "import './src/a';\n" };
    const repo = fakeRepo(files);
    const reversed = { ...repo, sources: new Map([...repo.sources].reverse()) };
    expect(canonicalJson(build(reversed))).toBe(canonicalJson(build(repo)));
  });

  it('refuses to build without the bytes of a lexed file', () => {
    const repo = fakeRepo({ 'src/a.ts': '' });
    expect(() => build({ ...repo, sources: new Map() })).toThrow(/src\/a\.ts/);
  });
});
