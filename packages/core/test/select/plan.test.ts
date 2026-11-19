import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseNpmLockfile, type NpmLockfile } from '../../src/lockfile/npm.ts';
import { fileHash, isLexed, readLockfile, type StaticInput } from '../../src/graph/static.ts';
import { dialectOf, lexImportsFromBytes } from '../../src/lex/ts.ts';
import { matchGlobs } from '../../src/resolve/glob.ts';
import { Resolver } from '../../src/resolve/resolver.ts';
import { mapGraph } from '../../src/graph/map.ts';
import { selectStatic, type HeadState, type PlanRules, type Selection } from '../../src/select/plan.ts';
import { decodeSmap, encodeSmap } from '../../src/smap/smap.ts';
import { fakeRepo, type FakeRepo } from '../graph/fake-repo.ts';
import { headOf, isTest, mapOf, materialize, PATHS, randomRepo, type Files } from './repos.ts';

function plan(base: Files, head: Files, rules: PlanRules = {}, mapOptions: Partial<StaticInput> = {}, headOptions: Partial<HeadState> = {}): Selection {
  return selectStatic(mapOf(fakeRepo(base), mapOptions), headOf(fakeRepo(head), headOptions), rules);
}

const selected = (selection: Selection) => [...selection.affected.map((a) => a.test), ...selection.forced.map((f) => f.test)].sort();

const LOCK = (lodash: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4', integrity: lodash }, ...extra } });

const BASE: Files = {
  'package.json': '{"name":"app"}',
  'package-lock.json': LOCK('sha512-1'),
  'src/a.ts': "import { b } from './b';\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/c.ts': "import _ from 'lodash';\n",
  'test/a.test.ts': "import '../src/a';\n",
  'test/c.test.ts': "import '../src/c';\n",
  'test/plain.test.ts': '',
};

describe('selectStatic', () => {
  it('selects nothing when nothing changed', () => {
    const selection = plan(BASE, BASE);
    expect(selection).toMatchObject({ changed: [], escalations: [], affected: [], forced: [] });
    expect(selection.wouldSkip).toEqual(['test/a.test.ts', 'test/c.test.ts', 'test/plain.test.ts']);
  });

  it('selects the tests that reach a changed file, with a why-path from the test to the change', () => {
    const selection = plan(BASE, { ...BASE, 'src/b.ts': 'export const b = 2;\n' });
    expect(selection.changed).toEqual(['f:src/b.ts']);
    expect(selection.affected).toEqual([{ test: 'test/a.test.ts', path: ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts'] }]);
    expect(selection.wouldSkip).toEqual(['test/c.test.ts', 'test/plain.test.ts']);
  });

  it('takes the graph it is handed, such as the one a SMAP file decodes to', () => {
    const map = mapOf(fakeRepo(BASE));
    const head = headOf(fakeRepo({ ...BASE, 'src/b.ts': 'export const b = 2;\n' }));
    const decoded = decodeSmap(encodeSmap(map));
    expect(selectStatic(decoded.map, head, {}, decoded.graph)).toEqual(selectStatic(map, head, {}));
    // It is used, not rebuilt: a graph without the edge from src/a.ts to its import selects otherwise.
    const { 'r:src/b': _dropped, ...rest } = map.edges['f:src/a.ts']!;
    const cut = mapGraph({ ...map, edges: { ...map.edges, 'f:src/a.ts': rest } });
    expect(selectStatic(map, head, {}, cut).affected).toEqual([]);
    expect(selectStatic(map, head, {}).affected.map((a) => a.test)).toEqual(['test/a.test.ts']);
  });

  it('counts a mode change as a change', () => {
    const base = fakeRepo(BASE);
    const head = fakeRepo({ ...BASE, 'src/b.ts': { mode: '100755' as const, content: BASE['src/b.ts']! } });
    expect(selectStatic(mapOf(base), headOf(head), {}).changed).toEqual(['f:src/b.ts']);
  });

  it('selects importers of a probe that appears, which may shadow the old target', () => {
    const selection = plan(BASE, { ...BASE, 'src/b/index.ts': '' });
    expect(selection.changed).toEqual(['r:src/b']);
    expect(selection.escalations).toEqual([]);
    expect(selection.affected).toEqual([{ test: 'test/a.test.ts', path: ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b'] }]);
  });

  it('selects importers of a file that appears at a probed path, without escalating, though it is no module', () => {
    const selection = plan(BASE, { ...BASE, 'src/b.json': '{}' });
    expect(selection.changed).toEqual(['r:src/b']);
    expect(selection.escalations).toEqual([]);
    expect(selected(selection)).toEqual(['test/a.test.ts']);
  });

  it('selects importers of a symlink whose missing target appears', () => {
    const base = { ...BASE, 'src/b.ts': "import './link.ts';\n", 'src/link.ts': { mode: '120000' as const, content: 'real.ts' } };
    const repo = (files: typeof base) => fakeRepo(files);
    const selection = selectStatic(mapOf(repo(base)), headOf(repo({ ...base, 'src/real.ts': '' } as typeof base)), {});
    expect(selection.changed).toEqual(['r:src/link.ts']);
    expect(selected(selection)).toEqual(['test/a.test.ts']);
  });

  it('selects the files of a directory whose config chain changes, without escalating', () => {
    const selection = plan(BASE, { ...BASE, 'src/tsconfig.json': '{}' });
    expect(selection.changed).toEqual(['c:src']);
    expect(selection.escalations).toEqual([]);
    expect(selected(selection)).toEqual(['test/a.test.ts', 'test/c.test.ts']);
  });

  it('selects the files of a directory whose config changes, through its c: hub', () => {
    const base = { ...BASE, 'tsconfig.json': '{}' };
    const selection = plan(base, { ...base, 'tsconfig.json': '{"compilerOptions":{"strict":true}}' });
    expect(selection.changed).toEqual(['f:tsconfig.json']);
    expect(selection.affected.find((a) => a.test === 'test/plain.test.ts')?.path).toEqual(['f:test/plain.test.ts', 'c:test', 'f:tsconfig.json']);
  });

  it('always selects tests that reach an uncertain file', () => {
    const base = { ...BASE, 'src/b.ts': "import './nowhere';\n" };
    const selection = plan(base, base);
    expect(selection.uncertain).toEqual(['u:src/b.ts']);
    expect(selection.affected).toEqual([{ test: 'test/a.test.ts', path: ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts', 'u:src/b.ts'] }]);
  });

  it('selects importers of a package whose lockfile entry changed', () => {
    const selection = plan(BASE, { ...BASE, 'package-lock.json': LOCK('sha512-2') });
    expect(selection.changed).toEqual(['p:npm:node_modules/lodash']);
    expect(selection.escalations).toEqual([]);
    expect(selected(selection)).toEqual(['test/c.test.ts']);
  });

  it('selects importers of every copy of a package when a new copy is installed elsewhere', () => {
    const head = { ...BASE, 'package-lock.json': LOCK('sha512-1', { 'node_modules/x/node_modules/lodash': { version: '3', integrity: 'sha512-3' } }) };
    const selection = plan(BASE, head);
    expect(selection.changed).toEqual(['p:npm:node_modules/lodash']);
    expect(selected(selection)).toEqual(['test/c.test.ts']);
  });

  it('does not count the ⊥ node of a name the head lockfile misses as a new install location', () => {
    const lock = (extra: Record<string, unknown>) =>
      LOCK('sha512-1', { 'node_modules/x': { version: '1', integrity: 'sha512-x', dependencies: { foo: '1' } }, 'node_modules/x/node_modules/foo': { version: '1', integrity: 'sha512-f' }, ...extra });
    const base = { ...BASE, 'package-lock.json': lock({}), 'src/d.ts': "import 'x';\n", 'test/d.test.ts': "import '../src/d';\n" };
    // w is new and declares foo, which nothing installs at the root: head has a ⊥ node p:npm:node_modules/foo, and x's own copy of foo is not shadowed by it
    const head = { ...base, 'package-lock.json': lock({ 'node_modules/w': { version: '1', integrity: 'sha512-w', dependencies: { foo: '1' } } }) };
    const selection = plan(base, head);
    expect(selection.changed).toEqual([]);
    expect(selected(selection)).toEqual([]);
  });

  it('selects bare importers when the workspace packages change', () => {
    const base = { ...BASE, 'package.json': '{"name":"app","workspaces":["pkgs/*"]}', 'pkgs/p/package.json': '{"name":"p"}', 'pkgs/p/index.js': '', 'src/a.ts': "import 'p';\n" };
    const selection = plan(base, { ...base, 'pkgs/q/package.json': '{"name":"q"}' });
    expect(selection.changed).toContain('g:workspaces');
    expect(selected(selection)).toContain('test/a.test.ts');
  });

  it('selects importers of a glob when a new file matches it', () => {
    const base = { ...BASE, 'src/a.ts': "import.meta.glob('./pages/*.ts');\n", 'src/pages/x.ts': '' };
    const selection = plan(base, { ...base, 'src/pages/y.ts': '' });
    expect(selection.changed).toContain('g:glob:src/pages/*.ts');
    expect(selected(selection)).toEqual(['test/a.test.ts']);
  });

  describe('a directory named by new URL(…, import.meta.url)', () => {
    const base = { ...BASE, 'src/a.ts': "export const data = new URL('./data/', import.meta.url);\n", 'src/data/x.json': '1', 'src/data/deep/y.json': '1' };

    it('is a dependency, not an uncertainty', () => {
      expect(mapOf(fakeRepo(base)).uncertain).toEqual({});
      expect(selected(plan(base, base))).toEqual([]);
    });

    it('selects its importers when a file below it changes', () => {
      const selection = plan(base, { ...base, 'src/data/deep/y.json': '2' });
      expect(selection.affected).toEqual([{ test: 'test/a.test.ts', path: ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'f:src/data/deep/y.json'] }]);
      expect(selection.escalations).toEqual([]);
    });

    it('selects its importers when a file appears below it, which needs no escalation', () => {
      const selection = plan(base, { ...base, 'src/data/z.json': '1' });
      expect(selection.changed).toContain('g:glob:src/data/**');
      expect(selection.escalations).toEqual([]);
      expect(selected(selection)).toEqual(['test/a.test.ts']);
    });

    it('still escalates a new file that no glob in the map matches (L1)', () => {
      const selection = plan(base, { ...base, 'src/other.json': '1' });
      expect(selection.escalations).toEqual([{ level: 'L1', scope: '', cause: 'src/other.json was added and is not in the graph' }]);
    });

    it('selects its importers when it appears, having been missing', () => {
      const missing = { ...BASE, 'src/a.ts': "export const data = new URL('./data/', import.meta.url);\n" };
      const selection = plan(missing, { ...missing, 'src/data/x.json': '1' });
      expect(selection.affected.find((a) => a.test === 'test/a.test.ts')?.path).toEqual(['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'd:src/data']);
    });
  });

  it('runs new tests, and tests named by alwaysRun', () => {
    const selection = plan(BASE, { ...BASE, 'test/new.test.ts': '' }, { alwaysRun: ['test/plain.*'] });
    expect(selection.forced).toEqual([
      { test: 'test/new.test.ts', reason: 'new test file' },
      { test: 'test/plain.test.ts', reason: 'alwaysRun' },
    ]);
  });

  describe('unmapped inputs (L1, ADR-0005)', () => {
    const WORKSPACES: Files = {
      ...BASE,
      'package.json': '{"name":"app","workspaces":["pkgs/*"]}',
      'pkgs/db/package.json': '{"name":"db","main":"src/index.ts"}',
      'pkgs/db/src/index.ts': 'export const db = 1;\n',
      'pkgs/db/migrations/001.sql': 'create table t ();\n',
      'pkgs/db/test/db.test.ts': "import '../src/index';\n",
      'pkgs/api/package.json': '{"name":"api"}',
      'pkgs/api/src/handler.ts': "import 'db';\n",
      'pkgs/api/test/api.test.ts': "import '../src/handler';\n",
      'pkgs/cli/package.json': '{"name":"cli"}',
      'pkgs/cli/src/main.ts': "import 'api';\n",
      'pkgs/cli/test/cli.test.ts': '',
      'pkgs/cli/test/fixtures/repo/package.json': '{"name":"fixture"}',
      'pkgs/cli/test/fixtures/repo/data.json': '1',
    };

    it('makes every node of the owning package changed, so the escalation follows dependencies into other packages', () => {
      const selection = plan(WORKSPACES, { ...WORKSPACES, 'pkgs/db/migrations/001.sql': 'create table u ();\n' });
      const cause = 'pkgs/db/migrations/001.sql was modified and is not in the graph';
      expect(selection.escalations).toEqual([{ level: 'L1', scope: 'pkgs/db', cause }]);
      expect(selection.forced.map(({ test, reason }) => ({ test, reason }))).toEqual([
        { test: 'pkgs/api/test/api.test.ts', reason: `L1: ${cause}` },
        { test: 'pkgs/db/test/db.test.ts', reason: `L1: ${cause}` },
      ]);
      // The why-path crosses into the escalated package; where it ends there is a tie-break among
      // that package's nodes (a hub sorts after the files).
      const [api, db] = selection.forced;
      expect(api!.path!.slice(0, 3)).toEqual(['f:pkgs/api/test/api.test.ts', 'r:pkgs/api/src/handler', 'f:pkgs/api/src/handler.ts']);
      expect(api!.path!.at(-1)).toMatch(/^[fdrc]:pkgs\/db\//);
      expect(db!.path).toEqual(['f:pkgs/db/test/db.test.ts']);
      expect(selection.wouldSkip).toEqual(['pkgs/cli/test/cli.test.ts', 'test/a.test.ts', 'test/c.test.ts', 'test/plain.test.ts']);
    });

    it('takes the owning package from the workspace members, not from a fixture package.json', () => {
      const selection = plan(WORKSPACES, { ...WORKSPACES, 'pkgs/cli/test/fixtures/repo/data.json': '2' });
      expect(selection.escalations).toEqual([{ level: 'L1', scope: 'pkgs/cli', cause: 'pkgs/cli/test/fixtures/repo/data.json was modified and is not in the graph' }]);
      expect(selected(selection)).toEqual(['pkgs/cli/test/cli.test.ts']);
    });

    it('treats a changed module that no test reaches as an unmapped input', () => {
      const selection = plan(WORKSPACES, { ...WORKSPACES, 'pkgs/cli/src/main.ts': "import 'api';\nimport 'db';\n" });
      const cause = 'pkgs/cli/src/main.ts changed and no test reaches it';
      expect(selection.escalations).toEqual([{ level: 'L1', scope: 'pkgs/cli', cause }]);
      expect(selection.forced).toEqual([{ test: 'pkgs/cli/test/cli.test.ts', reason: `L1: ${cause}`, path: ['f:pkgs/cli/test/cli.test.ts'] }]);
    });

    it('treats a changed hub that no test reaches as an unmapped input of the package its path lies in', () => {
      const base = { ...WORKSPACES, 'pkgs/cli/src/main.ts': "import 'api';\nimport './helpers';\n", 'pkgs/cli/src/helpers.ts': '' };
      const selection = plan(base, { ...base, 'pkgs/cli/src/helpers.js': '' });
      expect(selection.escalations).toEqual([{ level: 'L1', scope: 'pkgs/cli', cause: 'r:pkgs/cli/src/helpers changed and no test reaches it' }]);
      expect(selected(selection)).toEqual(['pkgs/cli/test/cli.test.ts']);
    });

    it('runs everything when the unreached module belongs to the root', () => {
      const base = { ...BASE, 'scripts/seed.ts': '' };
      const selection = plan(base, { ...base, 'scripts/seed.ts': 'export {};\n' });
      expect(selection.escalations).toEqual([{ level: 'L1', scope: '', cause: 'scripts/seed.ts changed and no test reaches it' }]);
      expect(selection.wouldSkip).toEqual([]);
    });

    it('treats a package that no test reaches as an unmapped input when its lockfile entry changes', () => {
      const eslint = (integrity: string) => ({ 'node_modules/eslint': { version: '10', integrity } });
      const selection = plan({ ...BASE, 'package-lock.json': LOCK('sha512-1', eslint('sha512-e1')) }, { ...BASE, 'package-lock.json': LOCK('sha512-1', eslint('sha512-e2')) });
      expect(selection.escalations).toEqual([{ level: 'L1', scope: '', cause: 'p:npm:node_modules/eslint changed and no test reaches it' }]);
      expect(selection.wouldSkip).toEqual([]);
    });

    it('treats a glob that no test reaches as an unmapped input of the root, since its matches can lie anywhere', () => {
      const base = { ...BASE, 'scripts/gen.ts': "import.meta.glob('./templates/*.ts');\n" };
      const selection = plan(base, { ...base, 'scripts/templates/b.ts': '' });
      expect(selection.escalations).toEqual([{ level: 'L1', scope: '', cause: 'g:glob:scripts/templates/*.ts changed and no test reaches it' }]);
    });

    it('lets inputs.ignore cover unreached nodes and files outside the graph, and lists what it ignored', () => {
      const base = { ...BASE, 'scripts/seed.ts': '', 'package-lock.json': LOCK('sha512-1', { 'node_modules/eslint': { integrity: 'sha512-e1' } }) };
      const head = { ...base, 'scripts/seed.ts': 'export {};\n', 'README.md': '# hi', 'package-lock.json': LOCK('sha512-1', { 'node_modules/eslint': { integrity: 'sha512-e2' } }) };
      const selection = plan(base, head, { ignore: ['**/*.md', 'scripts/**', 'node_modules/eslint'] });
      expect(selection.escalations).toEqual([]);
      expect(selection.ignored).toEqual(['README.md', 'node_modules/eslint', 'scripts/seed.ts']);
      expect(selected(selection)).toEqual([]);
    });

    it('does not escalate a deleted test, which reaches itself in the map', () => {
      const head = { ...BASE };
      delete head['test/plain.test.ts'];
      expect(plan(BASE, head).escalations).toEqual([]);
    });

    it('does not count an uncertain file that nothing reaches as a change', () => {
      const base = { ...BASE, 'fixtures/u.ts': "import './nowhere';\n" };
      const selection = plan(base, base);
      expect(selection.uncertain).toEqual(['u:fixtures/u.ts']);
      expect(selection.escalations).toEqual([]);
      expect(selected(selection)).toEqual([]);
    });
  });

  it('seeds every u: node, even one a damaged map lists no causes for', () => {
    const base = { ...BASE, 'src/b.ts': "import './nowhere';\n" };
    const map = mapOf(fakeRepo(base));
    const selection = selectStatic({ ...map, uncertain: {} }, headOf(fakeRepo(base)), {});
    expect(selection.uncertain).toEqual(['u:src/b.ts']);
    expect(selected(selection)).toEqual(['test/a.test.ts']);
  });

  it('ignores changes that match the ignore patterns, and new modules nothing could have loaded', () => {
    const selection = plan(BASE, { ...BASE, 'README.md': '# hi', 'docs/x.txt': 'x', 'src/new.ts': '' }, { ignore: ['**/*.md', 'docs/**'] });
    expect(selection.escalations).toEqual([]);
    expect(selection.ignored).toEqual(['README.md', 'docs/x.txt']);
    expect(selected(selection)).toEqual([]);
  });

  it.each([
    ['the config changed', {}, { config: 'b'.repeat(40) }, 'trommel.config.json changed'],
    ['the object format differs', {}, { objectFormat: 'sha256' as const }, 'the map is for sha1 objects, the repository uses sha256'],
  ])('runs everything when %s (L3)', (_name, mapOptions, headOptions, cause) => {
    const selection = plan(BASE, BASE, {}, { config: 'a'.repeat(40), ...mapOptions }, { config: 'a'.repeat(40), ...headOptions });
    expect(selection.escalations).toEqual([{ level: 'L3', cause }]);
    expect(selection.forced.map((f) => f.test)).toEqual(['test/a.test.ts', 'test/c.test.ts', 'test/plain.test.ts']);
    expect(selection.affected).toEqual([]);
    expect(selection.wouldSkip).toEqual([]);
  });

  it('runs everything when a lockfile it cannot parse changed, but not when it did not', () => {
    const base: Files = { ...BASE, 'pnpm-lock.yaml': 'a: 1\n' };
    delete base['package-lock.json'];
    expect(plan(base, base).escalations).toEqual([]);
    expect(plan(base, { ...base, 'pnpm-lock.yaml': 'a: 2\n' }).escalations).toEqual([{ level: 'L3', cause: "pnpm-lock.yaml changed and cannot be parsed (lockfileVersion is missing or not a string, and only '9.0' is read)" }]);
  });

  it('runs everything when the lockfile setup changes', () => {
    const head = { ...BASE, 'yarn.lock': '' };
    expect(plan(BASE, head).escalations).toEqual([
      { level: 'L3', cause: 'package-lock.json, yarn.lock changed and cannot be parsed (more than one lockfile: package-lock.json, yarn.lock)' },
    ]);
    const shrinkwrap: Files = { ...BASE, 'npm-shrinkwrap.json': BASE['package-lock.json']! };
    delete shrinkwrap['package-lock.json'];
    expect(plan(BASE, shrinkwrap).escalations).toEqual([{ level: 'L3', cause: 'the lockfile changed from npm package-lock.json to npm npm-shrinkwrap.json' }]);
  });
});

// pnpm and yarn lockfiles (spec §6.3, §6.4, §8.3): two workspace packages, a and b, whose
// tests import foo. a declares foo@^1.0.0 and b declares foo@~1.0.0, so one lockfile can resolve
// them to different versions.
describe('pnpm and yarn lockfiles', () => {
  type Flavour = 'pnpm' | 'yarn-berry' | 'yarn-classic';
  const lockName = (flavour: Flavour) => (flavour === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock');
  const dependency = (name: string, range: string) => JSON.stringify({ name, dependencies: { foo: range } });
  const pnpmDocument = (pnpm = '12.0.0') =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: ${pnpm}\n        version: ${pnpm}\n\npackages:\n\n  pnpm@${pnpm}:\n    resolution: {integrity: sha512-pnpm}\n\nsnapshots:\n\n  pnpm@${pnpm}: {}\n`;

  /** The lockfile in which a resolves foo to `a` and b resolves it to `b`. */
  function lockOf(flavour: Flavour, a: string, b: string): string {
    const versions = [...new Set([a, b])].sort();
    if (flavour === 'pnpm') {
      const importer = (dir: string, range: string, version: string) => `  ${dir}:\n    dependencies:\n      foo:\n        specifier: ${range}\n        version: ${version}\n`;
      return [
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
        importer('packages/a', '^1.0.0', a),
        importer('packages/b', '~1.0.0', b),
        'packages:\n',
        ...versions.map((v) => `  foo@${v}:\n    resolution: {integrity: sha512-foo${v}}\n`),
        'snapshots:\n',
        ...versions.map((v) => `  foo@${v}: {}\n`),
      ].join('\n');
    }
    const resolves = (v: string) => [a === v ? '^1.0.0' : null, b === v ? '~1.0.0' : null].filter((range) => range !== null);
    if (flavour === 'yarn-classic') {
      const entries = versions.map((v) => `${resolves(v).map((range) => `foo@${range}`).join(', ')}:\n  version "${v}"\n  resolved "https://registry.yarnpkg.com/foo/-/foo-${v}.tgz#x"\n  integrity sha512-foo${v}\n`);
      return `# yarn lockfile v1\n\n\n${entries.join('\n')}`;
    }
    const entries = versions.map((v) => `"${resolves(v).map((range) => `foo@npm:${range}`).join(', ')}":\n  version: ${v}\n  resolution: "foo@npm:${v}"\n  checksum: 10c0/x${v}\n  languageName: node\n  linkType: hard\n`);
    const workspace = (name: string, dir: string, deps: string) => `"${name}@workspace:${dir}":\n  version: 0.0.0-use.local\n  resolution: "${name}@workspace:${dir}"\n${deps}  languageName: unknown\n  linkType: soft\n`;
    return [
      '__metadata:\n  version: 8\n  cacheKey: 8\n',
      ...entries,
      workspace('a', 'packages/a', '  dependencies:\n    foo: "npm:^1.0.0"\n'),
      workspace('app', '.', ''),
      workspace('b', 'packages/b', '  dependencies:\n    foo: "npm:~1.0.0"\n'),
    ].join('\n');
  }

  const repo = (flavour: Flavour, lock: string): Files => ({
    'package.json': '{"name":"app","workspaces":["packages/*"]}',
    [lockName(flavour)]: lock,
    'packages/a/package.json': dependency('a', '^1.0.0'),
    'packages/a/index.ts': "import 'foo';\n",
    'packages/a/a.test.ts': "import './index';\n",
    'packages/b/package.json': dependency('b', '~1.0.0'),
    'packages/b/index.ts': "import 'foo';\n",
    'packages/b/b.test.ts': "import './index';\n",
  });

  it.each(['pnpm', 'yarn-berry', 'yarn-classic'] as const)("a lockfile-only bump in packages/a selects a's tests and not b's (%s)", (flavour) => {
    const base = repo(flavour, lockOf(flavour, '1.0.0', '1.0.0'));
    const selection = plan(base, repo(flavour, lockOf(flavour, '1.1.0', '1.0.0')));
    expect(selection.escalations).toEqual([]);
    expect(selected(selection)).toEqual(['packages/a/a.test.ts']);
    expect(selection.wouldSkip).toEqual(['packages/b/b.test.ts']);
  });

  it('a bump of a transitive dependency selects the tests that reach it', () => {
    const lock = (bar: string) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/a:\n    dependencies:\n      foo:\n        specifier: ^1.0.0\n        version: 1.0.0\n\n  packages/b: {}\n\npackages:\n\n  bar@${bar}:\n    resolution: {integrity: sha512-bar${bar}}\n\n  foo@1.0.0:\n    resolution: {integrity: sha512-foo}\n\nsnapshots:\n\n  bar@${bar}: {}\n\n  foo@1.0.0:\n    dependencies:\n      bar: ${bar}\n`;
    const files = (bar: string): Files => ({ ...repo('pnpm', lock(bar)), 'packages/b/index.ts': '' });
    const selection = plan(files('1.0.0'), files('1.0.1'));
    expect(selection.changed).toContain('p:pnpm:foo@1.0.0');
    expect(selection.escalations).toEqual([]);
    expect(selected(selection)).toEqual(['packages/a/a.test.ts']);
  });

  it('a test importing a root-declared name reruns when another copy of that name appears', () => {
    const lock = (extra: boolean) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      foo:\n        specifier: ^1.0.0\n        version: 1.0.0\n\n  packages/a: {}\n\n${extra ? '  packages/b:\n    dependencies:\n      foo:\n        specifier: ^2.0.0\n        version: 2.0.0\n' : '  packages/b: {}\n'}\npackages:\n\n  foo@1.0.0:\n    resolution: {integrity: sha512-foo1}\n${extra ? '\n  foo@2.0.0:\n    resolution: {integrity: sha512-foo2}\n' : ''}\nsnapshots:\n\n  foo@1.0.0: {}\n${extra ? '\n  foo@2.0.0: {}\n' : ''}`;
    const files = (extra: boolean): Files => ({ ...repo('pnpm', lock(extra)), 'packages/b/index.ts': '' });
    const selection = plan(files(false), files(true));
    expect(selection.changed).toContain('p:pnpm:foo@*');
    expect(selection.escalations).toEqual([]);
    expect(selected(selection)).toEqual(['packages/a/a.test.ts']);
  });

  it('adding a dependency to packages/b that the root also declares does not escalate the root', () => {
    const lock = (inB: boolean) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      typescript:\n        specifier: ^5.0.0\n        version: 5.0.0\n\n  packages/a: {}\n\n${inB ? '  packages/b:\n    dependencies:\n      typescript:\n        specifier: ^5.0.0\n        version: 5.0.0\n' : '  packages/b: {}\n'}\npackages:\n\n  typescript@5.0.0:\n    resolution: {integrity: sha512-ts}\n\nsnapshots:\n\n  typescript@5.0.0: {}\n`;
    const files = (inB: boolean): Files => ({ ...repo('pnpm', lock(inB)), 'packages/a/index.ts': '', 'packages/b/index.ts': '' });
    const selection = plan(files(false), files(true));
    expect(selection.escalations.filter((escalation) => escalation.scope === '')).toEqual([]);
    expect(selection.escalations).toEqual([]);
    expect(selected(selection)).toEqual([]);
  });

  it("pnpm's own document changing alone escalates the root", () => {
    const lock = (pnpm: string) => `${pnpmDocument(pnpm)}\n---\n${lockOf('pnpm', '1.0.0', '1.0.0')}`;
    const selection = plan(repo('pnpm', lock('12.0.0')), repo('pnpm', lock('12.0.1')));
    expect(selection.escalations).toEqual([{ level: 'L1', scope: '', cause: 'p:pnpm:#env changed and no test reaches it' }]);
    expect(selection.changed).toEqual(['p:pnpm:#env']);
  });

  it('a change of yarn lockfile flavour runs everything', () => {
    const selection = plan(repo('yarn-classic', lockOf('yarn-classic', '1.0.0', '1.0.0')), repo('yarn-berry', lockOf('yarn-berry', '1.0.0', '1.0.0')));
    expect(selection.escalations).toEqual([{ level: 'L3', cause: 'the lockfile changed from yarn-classic yarn.lock to yarn-berry yarn.lock' }]);
  });

  it.each([
    ['pnpm', 'pnpm pnpm-lock.yaml'],
    ['yarn-berry', 'yarn-berry yarn.lock'],
    ['yarn-classic', 'yarn-classic yarn.lock'],
  ] as const)('a %s map against a head with no lockfile runs everything', (flavour, described) => {
    const base = repo(flavour, lockOf(flavour, '1.0.0', '1.0.0'));
    const head = Object.fromEntries(Object.entries(base).filter(([path]) => path !== lockName(flavour)));
    expect(plan(base, head).escalations).toEqual([{ level: 'L3', cause: `the lockfile changed from ${described} to none` }]);
  });

  // Found by the whole-branch review (DECISIONS 37). packages/a imports foo, which the lockfile
  // does not know at B, and a root mock resolves the import: it is certain, and goes to case 3's ⊥
  // node p:npm:node_modules/foo (§6.4). At H, bar, which packages/b declares, depends on foo, so a
  // hoisted install puts foo at the root. npm's shadow rule sees that; so must pnpm and yarn.
  describe('a name left at ⊥ by case 3 that the head lockfile knows', () => {
    const files = (lockName: string, lock: string): Files => ({
      'package.json': '{"name":"app","workspaces":["packages/*"]}',
      [lockName]: lock,
      '__mocks__/foo.ts': 'export default 1;\n',
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/index.ts': "import 'foo';\n",
      'packages/a/a.test.ts': "import './index';\n",
      'packages/b/package.json': JSON.stringify({ name: 'b', dependencies: { bar: '^1.0.0' } }),
      'packages/b/index.ts': "import 'bar';\n",
      'packages/b/b.test.ts': "import './index';\n",
    });
    const classic = (foo: boolean): string =>
      foo
        ? '# yarn lockfile v1\n\n\nbar@^1.0.0:\n  version "1.1.0"\n  resolved "https://registry.yarnpkg.com/bar/-/bar-1.1.0.tgz#x"\n  integrity sha512-bar110\n  dependencies:\n    foo "^1.0.0"\n\nfoo@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz#x"\n  integrity sha512-foo100\n'
        : '# yarn lockfile v1\n\n\nbar@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/bar/-/bar-1.0.0.tgz#x"\n  integrity sha512-bar100\n';
    const pnpm = (foo: boolean): string => {
      const bar = foo ? '1.1.0' : '1.0.0';
      const importers = `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/a: {}\n\n  packages/b:\n    dependencies:\n      bar:\n        specifier: ^1.0.0\n        version: ${bar}\n`;
      const packages = `\npackages:\n\n  bar@${bar}:\n    resolution: {integrity: sha512-bar${bar}}\n${foo ? '\n  foo@1.0.0:\n    resolution: {integrity: sha512-foo100}\n' : ''}`;
      const snapshots = foo ? '\nsnapshots:\n\n  bar@1.1.0:\n    dependencies:\n      foo: 1.0.0\n\n  foo@1.0.0: {}\n' : '\nsnapshots:\n\n  bar@1.0.0: {}\n';
      return importers + packages + snapshots;
    };

    it.each([
      ['yarn-classic', 'yarn.lock', classic],
      ['pnpm', 'pnpm-lock.yaml', pnpm],
    ] as const)("selects packages/a's test (%s)", (_flavour, lockName, lock) => {
      const base = files(lockName, lock(false));
      const map = mapOf(fakeRepo(base));
      expect(map.nodes['p:npm:node_modules/foo']).toBeNull();
      expect(Object.keys(map.nodes).filter((key) => key.startsWith('u:'))).toEqual([]);
      const selection = plan(base, files(lockName, lock(true)));
      expect(selection.changed).toContain('p:npm:node_modules/foo');
      expect(selection.escalations).toEqual([]);
      expect(selection.forced).toEqual([]);
      expect(selection.affected.map((a) => a.test)).toEqual(['packages/a/a.test.ts', 'packages/b/b.test.ts']);
      expect(selection.wouldSkip).toEqual([]);
    });
  });

  it('inputs.ignore node_modules/eslint exempts an unreached eslint bump', () => {
    const lock = (eslint: string) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      eslint:\n        specifier: ^9.0.0\n        version: ${eslint}\n\n  packages/a: {}\n\n  packages/b: {}\n\npackages:\n\n  eslint@${eslint}:\n    resolution: {integrity: sha512-eslint${eslint}}\n\nsnapshots:\n\n  eslint@${eslint}: {}\n`;
    const files = (eslint: string): Files => ({ ...repo('pnpm', lock(eslint)), 'packages/a/index.ts': '', 'packages/b/index.ts': '' });
    const unignored = plan(files('9.0.0'), files('9.1.0'));
    expect(unignored.escalations.length).toBeGreaterThan(0);
    const selection = plan(files('9.0.0'), files('9.1.0'), { ignore: ['node_modules/eslint'] });
    expect(selection.escalations).toEqual([]);
    expect(selection.ignored).toEqual(['node_modules/eslint']);
    expect(selected(selection)).toEqual([]);
  });
});

// Soundness of the whole static pipeline (builder, map, Δ and selection) against an oracle that
// shares none of the graph code: what a test loads, found by following resolution targets, the
// configs each file reads, lockfile packages and their dependencies, and the global inputs. If that
// differs between S and H, or anything in it is uncertain, the plan from S's map must select the
// test. Repositories are drawn from a small universe where shadowing probes, tsconfig paths,
// workspaces and nested package copies are common.
describe('static selection soundness (property)', () => {
  /** What `test` loads in `repo`, as sorted "kind path hash" lines, and whether any of it is uncertain. */
  const loads = (repo: FakeRepo, test: string, global: readonly string[]): { items: string; uncertain: boolean } => {
    const resolver = new Resolver(repo.vfs);
    const lock = readLockfile(repo.vfs);
    // The oracle reads the npm lockfile itself, not through the interface under test.
    const npm = lock.kind === 'parsed' ? (parseNpmLockfile(repo.vfs.read(lock.lockfile.path)!) as NpmLockfile) : null;
    const items = new Set<string>();
    let uncertain = false;
    const file = (path: string) => items.add(`file ${path} ${String(fileHash(repo.index, path))}`);
    const pkg = (location: string): void => {
      if (npm !== null && !items.has(`pkg ${location}`)) {
        items.add(`pkg ${location}`);
        items.add(`pkg ${location} ${npm.packages.get(location)!.hash}`);
        npm.dependencies(location).resolved.forEach(pkg);
      }
    };
    const queue = [test];
    for (const path of queue) {
      file(path);
      if (!isLexed(path)) {
        continue;
      }
      resolver.fileConfigs(path).configs.forEach(file);
      const lexed = lexImportsFromBytes(repo.sources.get(path)!, dialectOf(path));
      uncertain ||= lexed.uncertain;
      for (const record of lexed.imports.filter((r) => r.typeOnly !== true)) {
        const resolution = resolver.resolve({ from: path, specifier: record.specifier, kind: record.kind, patterns: record.patterns ?? null });
        uncertain ||= resolution.kind === 'unresolved' || resolution.uncertain === true;
        resolution.configs.forEach(file);
        for (const target of resolution.targets.filter((t) => !queue.includes(t))) {
          queue.push(target);
        }
        if (resolution.packageName !== undefined) {
          const location = npm !== null ? npm.locate(resolution.packageName, path.slice(0, Math.max(0, path.lastIndexOf('/')))) : null;
          if (location !== null) {
            pkg(location);
          } else if (lock.kind === 'unparseable') {
            lock.paths.forEach(file);
          } else if (resolution.kind === 'external') {
            uncertain = true;
          }
        }
      }
    }
    matchGlobs(repo.vfs.files(), global).forEach(file);
    return { items: [...items].sort().join('\n'), uncertain };
  };

  it('selects every test whose loaded inputs changed or are uncertain', () => {
    fc.assert(
      fc.property(randomRepo, randomRepo, fc.subarray(PATHS, { minLength: 1, maxLength: 2 }), fc.boolean(), (s, other, edited, withGlobal) => {
        const h = Object.fromEntries(PATHS.map((path) => [path, edited.includes(path) ? other[path]! : s[path]!]));
        const global = withGlobal ? ['.env*'] : [];
        const sRepo = fakeRepo(materialize(s));
        const hRepo = fakeRepo(materialize(h));
        const selection = selectStatic(mapOf(sRepo, { global }), headOf(hRepo), {});
        const chosen = new Set(selected(selection));
        const both = sRepo.vfs.files().filter((path) => isTest(path) && hRepo.vfs.files().includes(path));
        for (const test of both) {
          const before = loads(sRepo, test, global);
          if (before.uncertain || before.items !== loads(hRepo, test, global).items) {
            expect(chosen.has(test), `${test} must run`).toBe(true);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });
});
