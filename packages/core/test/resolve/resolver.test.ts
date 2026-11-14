import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ImportKind } from '../../src/lex/ts.ts';
import { matchGlobs } from '../../src/resolve/glob.ts';
import { exportsTargets, MemoryVfs, Resolver, type Resolution } from '../../src/resolve/resolver.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'resolve');

interface Case {
  from: string;
  specifier: string | null;
  kind?: ImportKind;
  patterns?: string[] | null;
  expect: {
    kind: Resolution['kind'];
    targets: string[];
    packageName?: string;
    reason?: string;
    absentIncludes?: string[];
    absentExcludes?: string[];
    dirsIncludes?: string[];
    configsIncludes?: string[];
    globs?: { key: string; matches: string[] }[];
  };
}

function loadRepo(name: string): MemoryVfs {
  const dir = join(FIXTURES, name);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    const path = relative(dir, full).split(sep).join('/');
    if (entry.isFile() && path !== '_expected.json' && path !== '_symlinks.json') {
      files[path] = readFileSync(full, 'utf8');
    }
  }
  const symlinksPath = join(dir, '_symlinks.json');
  const symlinks = readdirSync(dir).includes('_symlinks.json') ? (JSON.parse(readFileSync(symlinksPath, 'utf8')) as Record<string, string>) : {};
  return new MemoryVfs(files, symlinks);
}

describe('resolver fixture repositories', () => {
  const repos = readdirSync(FIXTURES);
  it('has the five fixture repositories', () => {
    expect(repos.sort()).toEqual(['misc', 'relative', 'tsconfig-paths', 'workspaces-npm', 'workspaces-pnpm']);
  });

  for (const repo of repos) {
    const cases = JSON.parse(readFileSync(join(FIXTURES, repo, '_expected.json'), 'utf8')) as Case[];
    describe(repo, () => {
      const resolver = new Resolver(loadRepo(repo));
      it.each(cases.map((c) => [`${c.kind ?? 'static'} ${String(c.specifier ?? c.patterns)} from ${c.from}`, c] as const))('%s', (_label, c) => {
        const result = resolver.resolve({ from: c.from, specifier: c.specifier, kind: c.kind ?? 'static', patterns: c.patterns ?? null });
        const e = c.expect;
        expect(result.kind).toBe(e.kind);
        expect(result.targets).toEqual(e.targets);
        if (e.packageName !== undefined) expect(result.packageName).toBe(e.packageName);
        if (e.reason !== undefined) expect(result.reason).toBe(e.reason);
        for (const path of e.absentIncludes ?? []) expect(result.absent).toContain(path);
        for (const path of e.absentExcludes ?? []) expect(result.absent).not.toContain(path);
        for (const path of e.dirsIncludes ?? []) expect(result.dirs).toContain(path);
        for (const path of e.configsIncludes ?? []) expect(result.configs).toContain(path);
        if (e.globs !== undefined) expect(result.globs).toEqual(e.globs);
      });
    });
  }
});

describe('probe recording', () => {
  it('records every candidate of an extensionless relative import', () => {
    const resolver = new Resolver(new MemoryVfs({ 'src/a.ts': '', 'src/util.ts': '' }));
    const result = resolver.resolve({ from: 'src/a.ts', specifier: './util', kind: 'static', patterns: null });
    expect(result.targets).toEqual(['src/util.ts']);
    expect(result.absent).toEqual(
      ['', '.cjs', '.cts', '.js', '.json', '.jsx', '.mjs', '.mts', '.tsx'].map((ext) => `src/util${ext}`).sort(),
    );
    expect(result.dirs).toEqual(['src/util']);
  });
});

// Resolution hubs (ADR-0003): evidence that depends only on one path (`r:`) or one directory's
// config chain (`c:`), recorded once and shared by every importer.
describe('resolution hubs', () => {
  const EXTS = ['.cjs', '.cts', '.js', '.json', '.jsx', '.mjs', '.mts', '.ts', '.tsx'];
  const none = { targets: [], absent: [], dirs: [], configs: [] };

  it('puts the probes of an extensionless path in one r: hub that every importer shares', () => {
    const resolver = new Resolver(new MemoryVfs({ 'src/a.ts': '', 'src/c.ts': '', 'src/util.ts': '' }));
    const a = resolver.resolve({ from: 'src/a.ts', specifier: './util', kind: 'static' });
    const c = resolver.resolve({ from: 'src/c.ts', specifier: './util', kind: 'static' });
    for (const result of [a, c]) {
      expect(result.hubs).toEqual(['r:src/util']);
      expect(result.direct).toEqual(none);
      expect(result.targets).toEqual(['src/util.ts']);
    }
    expect(resolver.hub('r:src/util')).toEqual({
      key: 'r:src/util',
      targets: ['src/util.ts'],
      absent: ['src/util', ...EXTS.filter((ext) => ext !== '.ts').map((ext) => `src/util${ext}`)].sort(),
      dirs: ['src/util'],
      configs: [],
      hubs: [],
    });
  });

  it('gives a package directory one hub with its package.json, and a sub-hub per entry it tries', () => {
    const resolver = new Resolver(new MemoryVfs({ 'lib/pkg/package.json': '{"main":"main.js"}', 'lib/pkg/main.js': '', 'x.ts': '' }));
    const result = resolver.resolve({ from: 'x.ts', specifier: './lib/pkg', kind: 'static' });
    expect(result).toMatchObject({ kind: 'file', targets: ['lib/pkg/main.js'], hubs: ['r:lib/pkg'], direct: none });
    expect(resolver.hub('r:lib/pkg')).toEqual({
      key: 'r:lib/pkg',
      targets: [],
      absent: EXTS.map((ext) => `lib/pkg${ext}`),
      dirs: ['lib/pkg'],
      configs: ['lib/pkg/package.json'],
      hubs: ['r:lib/pkg/index', 'r:lib/pkg/main.js'],
    });
    expect(resolver.hub('r:lib/pkg/main.js')).toEqual({ key: 'r:lib/pkg/main.js', ...none, targets: ['lib/pkg/main.js'], hubs: [] });
  });

  it("records a directory's config chain as one c: hub, the evidence of fileConfigs", () => {
    const resolver = new Resolver(
      new MemoryVfs({ 'package.json': '{}', 'a/tsconfig.json': '{ "extends": "../tsconfig.base" }', 'tsconfig.base.json': '{}', 'a/b/f.ts': '', 'a/b/g.ts': '' }),
    );
    expect(resolver.hub('c:a/b')).toEqual({
      key: 'c:a/b',
      targets: [],
      absent: ['a/b/package.json', 'a/b/tsconfig.json', 'a/package.json', 'tsconfig.base'],
      dirs: [],
      configs: ['a/tsconfig.json', 'package.json', 'tsconfig.base.json'],
      hubs: [],
    });
    expect(resolver.fileConfigs('a/b/g.ts')).toEqual({ configs: resolver.hub('c:a/b').configs, absent: resolver.hub('c:a/b').absent });
  });

  it('marks a hub uncertain when it reads a config it cannot parse', () => {
    const resolver = new Resolver(new MemoryVfs({ 'tsconfig.json': '{', 'src/a.ts': '', 'src/p/package.json': 'not json' }));
    expect(resolver.hub('c:src').uncertain).toBe(true);
    expect(resolver.hub('r:src/p')).toMatchObject({ reason: 'invalid package.json', uncertain: true });
    expect(resolver.resolve({ from: 'src/a.ts', specifier: './p', kind: 'static' })).toMatchObject({ kind: 'unresolved', uncertain: true });
  });

  it('makes a bare import uncertain when its tsconfig cannot be read, and a leading-slash path not', () => {
    const resolver = new Resolver(new MemoryVfs({ 'tsconfig.json': '{', 'src/a.ts': '', 'src/b.ts': '' }));
    expect(resolver.resolve({ from: 'src/a.ts', specifier: 'lodash', kind: 'static' }).uncertain).toBe(true);
    expect(resolver.resolve({ from: 'src/a.ts', specifier: '/src/b.ts', kind: 'static' })).toMatchObject({ kind: 'file', targets: ['src/b.ts'] });
    expect(resolver.resolve({ from: 'src/a.ts', specifier: '/src/b.ts', kind: 'static' }).uncertain).toBeUndefined();
  });

  // Review finding L3: these resolve against the importer's package root, so the lookup of that
  // root is evidence too. Before, only the file's own config edges happened to cover it.
  it.each([
    ['a leading-slash path', { specifier: '/x.ts', kind: 'static' }],
    ['a bare package, through its root mocks', { specifier: 'lodash', kind: 'static' }],
    ['a subpath import', { specifier: '#x', kind: 'static' }],
    ['a leading-slash glob', { specifier: null, kind: 'glob', patterns: ['/*.ts'] }],
  ] as const)('records the package root lookup that %s resolves against', (_name, request) => {
    const resolver = new Resolver(new MemoryVfs({ 'package.json': '{}', 'a/package.json': '{"imports":{"#x":"./x.ts"}}', 'a/x.ts': '', 'a/b/f.ts': '' }));
    const result = resolver.resolve({ from: 'a/b/f.ts', ...request });
    expect(result.hubs).toContain('c:a/b');
    expect(result.configs).toContain('a/package.json');
    expect(result.absent).toContain('a/b/package.json');
  });

  it('makes a cycle of package entries uncertain instead of looping', () => {
    const resolver = new Resolver(new MemoryVfs({ 'p/package.json': '{"main":"sub"}', 'p/sub/package.json': '{"main":".."}', 'x.ts': '' }));
    const result = resolver.resolve({ from: 'x.ts', specifier: './p', kind: 'static' });
    expect(result).toMatchObject({ hubs: ['r:p'], uncertain: true });
    expect(resolver.hub('r:p/sub').hubs).toContain('r:p');
  });

  it('refuses a key that names no hub', () => {
    expect(() => new Resolver(new MemoryVfs({})).hub('f:x')).toThrow(/not a hub/);
  });
});

describe('exportsTargets', () => {
  it.each([
    ['string sugar', './index.js', '.', ['./index.js']],
    ['array fallbacks are a union', ['./a.js', './b.js'], '.', ['./a.js', './b.js']],
    ['conditions are a union, types excluded', { '.': { types: './i.d.ts', node: { import: './n.mjs', require: './n.cjs' }, default: './d.js' } }, '.', ['./n.mjs', './n.cjs', './d.js']],
    ['the most specific pattern wins', { './features/*.js': './src/*.js', './features/private-internal/*': null }, './features/private-internal/x', []],
    ['a pattern substitutes every star', { './x/*': { import: './esm/*.mjs', require: './cjs/*.cjs' } }, './x/a/b', ['./esm/a/b.mjs', './cjs/a/b.cjs']],
  ] as const)('%s', (_name, exports, subpath, expected) => {
    expect(exportsTargets(exports, subpath)).toEqual(expected);
  });

  it('returns null when nothing matches', () => {
    expect(exportsTargets({ '.': './i.js' }, './other')).toBeNull();
  });
});

// `new URL(spec, import.meta.url)`: an asset next to the module, or a directory whose files the
// code may read. A directory depends on everything below it, as a glob, so files that appear count.
describe('new URL(…, import.meta.url)', () => {
  const resolver = new Resolver(
    new MemoryVfs(
      {
        'src/a.ts': '',
        'src/logo.svg': '',
        'src/fixtures/one.json': '',
        'src/fixtures/deep/two.json': '',
        'app/[slug]/page.ts': '',
        'app/s/page.ts': '',
        'real/data.json': '',
        'top.ts': '',
      },
      { 'aliases/data.json': '../real/data.json', 'links/dir': '../real', 'links/up': '../../outside' },
    ),
  );
  const url = (from: string, specifier: string) => resolver.resolve({ from, specifier, kind: 'url' });

  it('resolves a file to that file', () => {
    expect(url('src/a.ts', './logo.svg')).toMatchObject({ kind: 'file', targets: ['src/logo.svg'], globs: [] });
  });

  it('resolves a directory to every file below it, recorded as a glob', () => {
    const files = ['src/fixtures/deep/two.json', 'src/fixtures/one.json'];
    for (const specifier of ['./fixtures/', './fixtures', 'fixtures/']) {
      const result = url('src/a.ts', specifier);
      expect(result, specifier).toMatchObject({ kind: 'file', targets: files, globs: [{ key: 'src/fixtures/**', matches: files, patterns: ['src/fixtures/**'] }] });
      expect(result.dirs, specifier).toContain('src/fixtures');
      expect(result.reason, specifier).toBeUndefined();
    }
  });

  it("resolves '.' to the module's own directory, itself included", () => {
    expect(url('src/a.ts', '.').targets).toEqual(['src/a.ts', 'src/fixtures/deep/two.json', 'src/fixtures/one.json', 'src/logo.svg']);
  });

  it('resolves the repository root to every file', () => {
    const small = new Resolver(new MemoryVfs({ 'a/b/c.ts': '', 'd.json': '' }));
    const result = small.resolve({ from: 'a/b/c.ts', specifier: '../..', kind: 'url' });
    expect(result).toMatchObject({ kind: 'file', targets: ['a/b/c.ts', 'd.json'], globs: [{ key: '**', matches: ['a/b/c.ts', 'd.json'], patterns: ['**'] }] });
  });

  it('escapes glob characters in the directory name', () => {
    expect(url('app/[slug]/page.ts', '.')).toMatchObject({ targets: ['app/[slug]/page.ts'], globs: [{ key: 'app/[[]slug]/**', patterns: ['app/[[]slug]/**'] }] });
  });

  it('follows a symlink below the directory to the file it names', () => {
    expect(url('top.ts', './aliases/').targets).toEqual(['aliases/data.json', 'real/data.json']);
  });

  it('leaves a directory unresolved when a symlink below it leads to a directory or out of the repository', () => {
    expect(url('top.ts', './links/')).toMatchObject({ kind: 'unresolved', reason: 'symlinked directory', targets: [] });
    expect(url('top.ts', '.')).toMatchObject({ kind: 'unresolved', targets: [] });
  });

  it('leaves a missing path, a path outside the repository and a symlinked directory unresolved', () => {
    expect(url('src/a.ts', './nowhere/')).toMatchObject({ kind: 'unresolved', reason: 'not found', absent: ['src/nowhere'], dirs: ['src/nowhere'] });
    expect(url('top.ts', '..')).toMatchObject({ kind: 'unresolved', reason: 'outside repository' });
    expect(url('top.ts', './links/dir/')).toMatchObject({ kind: 'unresolved', reason: 'symlinked directory' });
  });
});

// The resolver's soundness: a result may only depend on what it recorded. Adding a file that is
// not a probed path, a config, or under a probed directory, or removing a file that is not a
// target or config, must leave the result unchanged.
describe('evidence completeness (property)', () => {
  const DIRS = ['', 'a', 'a/b', 'a/x'];
  const NAMES = ['x', 'index', 'util'];
  const EXTS = ['', '.ts', '.js', '.json', '.mjs'];
  // package.json files move the importer's package root, which a leading-slash path and the root
  // mocks of a bare import resolve against (review finding L3).
  const UNIVERSE = [
    ...DIRS.flatMap((dir) => NAMES.flatMap((name) => EXTS.map((ext) => (dir === '' ? `${name}${ext}` : `${dir}/${name}${ext}`)))),
    ...DIRS.map((dir) => (dir === '' ? 'package.json' : `${dir}/package.json`)),
  ].filter((path) => !DIRS.includes(path));
  const SPECIFIERS = ['./x', './x.js', '../x', '../x.ts', './index', '..', '.', '../b', '../../x', '/x', '/x.ts', '/a/x', './util', '../x/util', './x/index', '../..', '../x/', './util/'];
  const IMPORTER = 'a/b/f.ts';
  const contentOf = (path: string) => (path.endsWith('package.json') ? '{}' : '');

  const covered = (result: Resolution, path: string): boolean =>
    result.targets.includes(path) ||
    result.absent.includes(path) ||
    result.configs.includes(path) ||
    result.dirs.some((dir) => path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`)) ||
    result.globs.some((glob) => glob.patterns !== undefined && matchGlobs([path], glob.patterns).length > 0);

  const resolveAs = (files: string[], specifier: string, kind: ImportKind): Resolution =>
    new Resolver(new MemoryVfs(Object.fromEntries([...files, IMPORTER].map((f) => [f, contentOf(f)])))).resolve({
      from: IMPORTER,
      specifier,
      kind,
      patterns: null,
    });

  // Paths that cannot coexist with the file set (a file where a directory is needed) are skipped.
  const coexists = (files: string[], path: string) =>
    !files.some((f) => f.startsWith(`${path}/`) || path.startsWith(`${f}/`)) && path !== IMPORTER && !IMPORTER.startsWith(`${path}/`);

  it.each(['static', 'url'] as const)('adding or removing unrecorded files never changes a %s resolution', (kind) => {
    fc.assert(
      fc.property(fc.subarray(UNIVERSE, { maxLength: 12 }), fc.constantFrom(...SPECIFIERS), (picked, specifier) => {
        const files = picked.filter((path, _i, all) => all.every((other) => other === path || !other.startsWith(`${path}/`)) && coexists([], path));
        const resolve = (set: string[]) => resolveAs(set, specifier, kind);
        const before = resolve(files);
        for (const extra of UNIVERSE) {
          if (!files.includes(extra) && coexists(files, extra) && !covered(before, extra)) {
            const after = resolve([...files, extra]);
            expect({ kind: after.kind, targets: after.targets }, `adding ${extra}`).toEqual({ kind: before.kind, targets: before.targets });
          }
        }
        for (const gone of files) {
          if (!before.targets.includes(gone) && !before.configs.includes(gone) && !covered(before, gone)) {
            const after = resolve(files.filter((f) => f !== gone));
            expect({ kind: after.kind, targets: after.targets }, `removing ${gone}`).toEqual({ kind: before.kind, targets: before.targets });
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  // The map keeps a resolution's evidence as its direct part plus edges to hubs, so the two must
  // add up to exactly what the resolution recorded: nothing lost, nothing invented.
  it.each(['static', 'url', 'mock'] as const)('splits a %s resolution into direct evidence and hubs without losing any', (kind) => {
    const bare = ['lodash', 'x', '#x', '@s/p'];
    fc.assert(
      fc.property(fc.subarray(UNIVERSE, { maxLength: 12 }), fc.constantFrom(...SPECIFIERS, ...bare), (picked, specifier) => {
        const files = picked.filter((path, _i, all) => all.every((other) => other === path || !other.startsWith(`${path}/`)) && coexists([], path));
        const resolver = new Resolver(new MemoryVfs(Object.fromEntries([...files, IMPORTER].map((f) => [f, contentOf(f)]))));
        const result = resolver.resolve({ from: IMPORTER, specifier, kind, patterns: null });
        const sum = { targets: new Set(result.direct.targets), absent: new Set(result.direct.absent), dirs: new Set(result.direct.dirs), configs: new Set(result.direct.configs) };
        const seen = new Set<string>();
        const visit = (key: string): void => {
          if (seen.has(key)) {
            return;
          }
          seen.add(key);
          const hub = resolver.hub(key);
          hub.targets.forEach((p) => sum.targets.add(p));
          hub.absent.forEach((p) => sum.absent.add(p));
          hub.dirs.forEach((p) => sum.dirs.add(p));
          hub.configs.forEach((p) => sum.configs.add(p));
          hub.hubs.forEach(visit);
        };
        result.hubs.forEach(visit);
        const sorted = (set: Set<string>) => [...set].sort();
        expect(sorted(sum.targets)).toEqual(result.targets);
        expect(sorted(sum.absent).filter((p) => !sum.targets.has(p))).toEqual(result.absent);
        expect(sorted(sum.dirs)).toEqual(result.dirs);
        expect(sorted(sum.configs)).toEqual(result.configs);
      }),
      { numRuns: 400 },
    );
  });
});

// A file's own config dependencies: the tsconfig chain that governs it and the nearest
// package.json, whose `type` decides how Node loads it.
describe('packageOf', () => {
  const npm = new Resolver(
    new MemoryVfs({
      'package.json': '{"name":"root","workspaces":["packages/*","!packages/skip"]}',
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/src/x.ts': '',
      'packages/a/test/fixtures/repo/package.json': '{"name":"fixture"}',
      'packages/a/test/fixtures/repo/src/y.ts': '',
      'packages/unnamed/package.json': '{}',
      'packages/skip/package.json': '{"name":"skip"}',
      'packages/nopkg/z.ts': '',
      'bench/package.json': '{"type":"module"}',
      'bench/b.ts': '',
    }),
  );

  it('is the deepest workspace member that holds the path, named or not', () => {
    expect(npm.packageOf('packages/a/src/x.ts')).toBe('packages/a');
    expect(npm.packageOf('packages/a')).toBe('packages/a');
    expect(npm.packageOf('packages/unnamed/index.js')).toBe('packages/unnamed');
  });

  it('ignores a package.json that is not a workspace member, such as a fixture or a type marker', () => {
    expect(npm.packageOf('packages/a/test/fixtures/repo/src/y.ts')).toBe('packages/a');
    expect(npm.packageOf('bench/b.ts')).toBe('');
  });

  it('is the root for excluded members, directories without a package.json and paths outside every member', () => {
    expect(npm.packageOf('packages/skip/s.ts')).toBe('');
    expect(npm.packageOf('packages/nopkg/z.ts')).toBe('');
    expect(npm.packageOf('packages/ab/c.ts')).toBe('');
    expect(npm.packageOf('README.md')).toBe('');
  });

  it('prefers a nested member to the member around it', () => {
    const nested = new Resolver(
      new MemoryVfs({
        'package.json': '{"workspaces":["packages/*","packages/a/plugins/*"]}',
        'packages/a/package.json': '{}',
        'packages/a/plugins/p/package.json': '{}',
      }),
    );
    expect(nested.packageOf('packages/a/plugins/p/x.ts')).toBe('packages/a/plugins/p');
    expect(nested.packageOf('packages/a/plugins/x.ts')).toBe('packages/a');
  });

  it('reads pnpm-workspace.yaml', () => {
    const pnpm = new Resolver(new MemoryVfs({ 'package.json': '{}', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", 'apps/web/package.json': '{}' }));
    expect(pnpm.packageOf('apps/web/src/main.ts')).toBe('apps/web');
  });

  it('is the root for everything when the workspace list cannot be read', () => {
    const broken = new Resolver(new MemoryVfs({ 'package.json': '{"workspaces":', 'packages/a/package.json': '{}' }));
    expect(broken.packageOf('packages/a/x.ts')).toBe('');
  });
});

describe('fileConfigs', () => {
  it('records the tsconfig chain, the nearest package.json and every miss on the way up', () => {
    const resolver = new Resolver(
      new MemoryVfs({
        'package.json': '{}',
        'a/tsconfig.json': '{ "extends": "../tsconfig.base" }',
        'tsconfig.base.json': '{}',
        'a/b/f.ts': '',
      }),
    );
    expect(resolver.fileConfigs('a/b/f.ts')).toEqual({
      configs: ['a/tsconfig.json', 'package.json', 'tsconfig.base.json'],
      absent: ['a/b/package.json', 'a/b/tsconfig.json', 'a/package.json', 'tsconfig.base'],
    });
  });

  it('stops at the nearest package.json, even one without a type field', () => {
    const resolver = new Resolver(new MemoryVfs({ 'package.json': '{"type":"module"}', 'a/package.json': '{}', 'a/f.js': '' }));
    expect(resolver.fileConfigs('a/f.js')).toEqual({ configs: ['a/package.json'], absent: ['a/tsconfig.json', 'tsconfig.json'] });
  });

  it('records the root package.json and tsconfig.json as absent when nothing exists', () => {
    expect(new Resolver(new MemoryVfs({ 'f.ts': '' })).fileConfigs('f.ts')).toEqual({ configs: [], absent: ['package.json', 'tsconfig.json'] });
  });

  // Soundness, as for resolve(): the result may only depend on what it recorded.
  describe('evidence completeness (property)', () => {
    const DIRS = ['', 'a', 'a/b'];
    const NAMES = ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'base', 'base.json', 'x.ts'];
    const UNIVERSE = DIRS.flatMap((dir) => NAMES.map((name) => (dir === '' ? name : `${dir}/${name}`)));
    const CONTENTS = ['{}', '{"extends":"./tsconfig.base.json"}', '{"extends":"../tsconfig.json"}', '{"extends":"./base"}', '{"extends":"../base.json"}', '{"extends":["./base.json","../tsconfig.base.json"]}', '{"extends":"@tsconfig/node22"}', 'not json'];
    const IMPORTER = 'a/b/f.ts';
    const configsOf = (files: Record<string, string>) => new Resolver(new MemoryVfs({ ...files, [IMPORTER]: '' })).fileConfigs(IMPORTER);

    it('adding, removing or editing an unrecorded file never changes the result', () => {
      fc.assert(
        fc.property(fc.dictionary(fc.constantFrom(...UNIVERSE), fc.constantFrom(...CONTENTS), { maxKeys: 10 }), fc.constantFrom(...CONTENTS), (files, other) => {
          const before = configsOf(files);
          const recorded = new Set([...before.configs, ...before.absent]);
          for (const path of UNIVERSE) {
            if (!recorded.has(path)) {
              const changed = path in files ? Object.fromEntries(Object.entries(files).filter(([p]) => p !== path)) : { ...files, [path]: other };
              expect(configsOf(changed), `toggling ${path}`).toEqual(before);
            }
            if (path in files && !before.configs.includes(path)) {
              expect(configsOf({ ...files, [path]: other }), `editing ${path}`).toEqual(before);
            }
          }
        }),
        { numRuns: 400 },
      );
    });
  });
});
