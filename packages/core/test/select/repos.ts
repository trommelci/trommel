import fc from 'fast-check';

import { buildStaticMap, type StaticInput, type TrommelMap } from '../../src/graph/static.ts';
import type { HeadState } from '../../src/select/plan.ts';
import type { FakeRepo } from '../graph/fake-repo.ts';

export type Files = Record<string, string>;
export const isTest = (path: string) => /\.test\.[jt]s$/.test(path);

export function mapOf(repo: FakeRepo, options: Partial<StaticInput> = {}): TrommelMap {
  return buildStaticMap({ objectFormat: 'sha1', index: repo.index, vfs: repo.vfs, sources: repo.sources, tests: repo.vfs.files().filter(isTest), ...options });
}

export function headOf(repo: FakeRepo, options: Partial<HeadState> = {}): HeadState {
  return { objectFormat: 'sha1', index: repo.index, vfs: repo.vfs, tests: repo.vfs.files().filter(isTest), config: null, ...options };
}

const MODULES = ['src/a.ts', 'src/b.ts', 'src/d/index.ts', 'lib/f.mjs', 'test/a.test.ts', 'test/b.test.ts'];
const TARGETS = ['src/a', 'src/b.js', 'src/b', 'src/d', 'lib/f.mjs', 'data/x.json'];
const BARE = ['x', 'lodash', 'q', '@/b'];
const lockfile = (lodash: string, nested: boolean) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/x': { integrity: 'sha512-x', dependencies: { lodash: '*' } },
      'node_modules/lodash': { integrity: lodash },
      'node_modules/q': { integrity: 'sha512-q' },
      ...(nested ? { 'node_modules/x/node_modules/lodash': { integrity: 'sha512-nested' } } : {}),
    },
  });
const OTHER: Readonly<Record<string, readonly (string | null)[]>> = {
  'package.json': [null, '{"name":"r"}', '{"name":"r","workspaces":["pkgs/*"]}', '{"name":"r","type":"module","workspaces":["pkgs/*"]}'],
  'src/package.json': [null, '{"type":"commonjs"}'],
  'tsconfig.json': [null, '{}', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}'],
  'package-lock.json': [null, lockfile('sha512-1', false), lockfile('sha512-2', false), lockfile('sha512-1', true)],
  'pkgs/q/package.json': [null, '{"name":"q","main":"index.js"}', '{"name":"q","main":"other.js"}'],
  'pkgs/q/index.js': [null, ''],
  'src/b.js': [null, ''],
  'src/b/index.ts': [null, ''],
  'data/x.json': [null, '1', '2'],
  '.env.test': [null, 'A=1', 'A=2'],
};
export const PATHS = [...MODULES, ...Object.keys(OTHER)];

const relative = (fromDir: string, target: string): string => {
  const from = fromDir.split('/');
  const to = target.split('/');
  let common = 0;
  while (common < from.length && from[common] === to[common]) {
    common++;
  }
  const up = from.slice(common).map(() => '..');
  return [...(up.length === 0 ? ['.'] : up), ...to.slice(common)].join('/');
};
/** An import line, written relative to the importing file's directory. */
const line = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...TARGETS).map((target) => (dir: string) => `import '${relative(dir, target)}';`) },
  { weight: 4, arbitrary: fc.constantFrom(...BARE).map((name) => () => `import '${name}';`) },
  { weight: 1, arbitrary: fc.constant((dir: string) => `import type { T } from '${relative(dir, 'src/b')}';`) },
  { weight: 1, arbitrary: fc.constant((dir: string) => `import.meta.glob('${relative(dir, 'src')}/*.ts');`) },
  { weight: 1, arbitrary: fc.constant(() => 'await import(name);') },
);
const module = fc.option(fc.array(line, { maxLength: 3 }), { nil: null, freq: 5 });
export const randomRepo = fc.record({
  ...Object.fromEntries(MODULES.map((path) => [path, module])),
  ...Object.fromEntries(Object.entries(OTHER).map(([path, options]) => [path, fc.constantFrom(...options)])),
}) as unknown as fc.Arbitrary<Record<string, ((dir: string) => string)[] | string | null>>;

export const materialize = (files: Record<string, ((dir: string) => string)[] | string | null>): Files => {
  const out: Files = {};
  for (const [path, value] of Object.entries(files)) {
    if (value !== null) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      out[path] = typeof value === 'string' ? value : value.map((make) => make(dir)).join('\n');
    }
  }
  // A file cannot also be a directory.
  return Object.fromEntries(Object.entries(out).filter(([path]) => !Object.keys(out).some((other) => other.startsWith(`${path}/`))));
};
