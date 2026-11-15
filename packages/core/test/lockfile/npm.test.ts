import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectLockfile, diffLockfiles, npmLockfile, parseNpmLockfile, type NpmLockfile } from '../../src/lockfile/npm.ts';

const V3 = JSON.stringify({
  name: 'root',
  lockfileVersion: 3,
  packages: {
    '': { name: 'root', workspaces: ['packages/*'], dependencies: { lodash: '^4' } },
    'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', integrity: 'sha512-AAA' },
    'node_modules/a': { version: '1.0.0', integrity: 'sha512-BBB', dependencies: { b: '^2', shared: '^1' }, peerDependencies: { react: '*' } },
    'node_modules/a/node_modules/b': { version: '2.0.0', integrity: 'sha512-CCC' },
    'node_modules/b': { version: '1.0.0', integrity: 'sha512-DDD' },
    'node_modules/shared': { version: '1.2.0', integrity: 'sha512-EEE', dev: true },
    'node_modules/@acme/core': { resolved: 'packages/core', link: true },
    'packages/core': { name: '@acme/core', version: '0.0.0', dependencies: { b: '^3' } },
    'packages/core/node_modules/b': { version: '3.0.0', integrity: 'sha512-FFF' },
    'node_modules/gitdep': { version: '0.1.0', resolved: 'git+ssh://git@github.com/x/y.git#abc' },
  },
});

const parse = (text: string): NpmLockfile => {
  const result = parseNpmLockfile(text);
  if (result.kind !== 'npm') {
    throw new Error(`expected npm, got ${result.kind}`);
  }
  return result;
};

describe('parseNpmLockfile', () => {
  it('turns every installed package into a p:npm node keyed by install location', () => {
    const lock = parse(V3);
    expect([...lock.packages.keys()]).toEqual([
      'node_modules/@acme/core',
      'node_modules/a',
      'node_modules/a/node_modules/b',
      'node_modules/b',
      'node_modules/gitdep',
      'node_modules/lodash',
      'node_modules/shared',
      'packages/core/node_modules/b',
    ]);
    expect(lock.packages.get('node_modules/lodash')).toEqual({ location: 'node_modules/lodash', name: 'lodash', hash: 'sha512-AAA' });
    expect(lock.packages.get('node_modules/@acme/core')).toEqual({ location: 'node_modules/@acme/core', name: '@acme/core', hash: 'link:packages/core', link: 'packages/core' });
    expect(lock.packages.get('node_modules/gitdep')!.hash).toBe('0.1.0|git+ssh://git@github.com/x/y.git#abc');
  });

  it('reads the packages map of a v2 lockfile too', () => {
    const v2 = JSON.stringify({ lockfileVersion: 2, packages: { '': {}, 'node_modules/x': { version: '1.0.0', integrity: 'sha512-X' } }, dependencies: {} });
    expect([...parse(v2).packages.keys()]).toEqual(['node_modules/x']);
  });

  it.each([
    ['a v1 lockfile', JSON.stringify({ lockfileVersion: 1, dependencies: {} }), 'lockfileVersion 1 has no packages map'],
    ['invalid JSON', '{ nope', 'invalid JSON'],
    ['a packages map that is not an object', JSON.stringify({ lockfileVersion: 3, packages: [] }), 'no packages map'],
  ])('reports %s as unparseable', (_name, text, reason) => {
    expect(parseNpmLockfile(text)).toEqual({ kind: 'unparseable', format: 'npm', reason });
  });
});

describe('NpmLockfile.locate', () => {
  it('finds the install location Node would load from, walking up from the importer', () => {
    const lock = parse(V3);
    expect(lock.locate('b', 'packages/core/src')).toBe('packages/core/node_modules/b');
    expect(lock.locate('b', 'packages/app/src')).toBe('node_modules/b');
    expect(lock.locate('@acme/core', 'packages/app/src')).toBe('node_modules/@acme/core');
    expect(lock.locate('missing', 'src')).toBeNull();
  });
});

describe('NpmLockfile.dependencies', () => {
  it('resolves a package dependencies, optional and peer dependencies from its own location', () => {
    const lock = parse(V3);
    expect(lock.dependencies('node_modules/a')).toEqual({ resolved: ['node_modules/a/node_modules/b', 'node_modules/shared'], missing: ['react'] });
    expect(lock.dependencies('node_modules/lodash')).toEqual({ resolved: [], missing: [] });
  });
});

describe('diffLockfiles', () => {
  it('lists the install locations that changed, appeared or disappeared', () => {
    const before = parse(V3);
    const changed = JSON.parse(V3) as { packages: Record<string, Record<string, unknown>> };
    changed.packages['node_modules/lodash']!['integrity'] = 'sha512-NEW';
    delete changed.packages['node_modules/shared'];
    changed.packages['node_modules/zod'] = { version: '4.0.0', integrity: 'sha512-ZZZ' };
    expect(diffLockfiles(before, parse(JSON.stringify(changed)))).toEqual({
      added: ['node_modules/zod'],
      changed: ['node_modules/lodash'],
      removed: ['node_modules/shared'],
    });
  });
});

describe('detectLockfile', () => {
  it.each([
    [['package-lock.json'], { kind: 'npm', path: 'package-lock.json' }],
    [['npm-shrinkwrap.json', 'package-lock.json'], { kind: 'npm', path: 'npm-shrinkwrap.json' }],
    [['pnpm-lock.yaml'], { kind: 'pnpm', path: 'pnpm-lock.yaml' }],
    [['yarn.lock'], { kind: 'yarn', path: 'yarn.lock' }],
    [['bun.lock'], { kind: 'unparseable', format: 'bun', path: 'bun.lock', reason: 'bun lockfiles are not parsed' }],
    [['bun.lockb'], { kind: 'unparseable', format: 'bun', path: 'bun.lockb', reason: 'bun lockfiles are not parsed' }],
    [['pnpm-lock.yaml', 'yarn.lock'], { kind: 'unparseable', format: 'unknown', path: 'pnpm-lock.yaml', reason: 'more than one lockfile: pnpm-lock.yaml, yarn.lock' }],
    [['package-lock.json', 'yarn.lock'], { kind: 'unparseable', format: 'unknown', path: 'package-lock.json', reason: 'more than one lockfile: package-lock.json, yarn.lock' }],
    [[], { kind: 'none' }],
  ] as const)('%j', (files, expected) => {
    expect(detectLockfile(new Set(files))).toEqual(expected);
  });
});

describe('the repository’s own lockfile', () => {
  it('parses, with an integrity hash for every registry package', () => {
    const lock = parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'package-lock.json'), 'utf8'));
    expect(lock.packages.size).toBeGreaterThan(50);
    expect(lock.locate('vitest', '')).toBe('node_modules/vitest');
    const unhashed = [...lock.packages.values()].filter((p) => p.link === undefined && !p.hash.startsWith('sha'));
    expect(unhashed).toEqual([]);
  });
});

describe('npmLockfile', () => {
  const lock = npmLockfile(parse(V3), 'package-lock.json');

  it('exposes every location as a p:npm: node with its hash', () => {
    expect(lock.kind).toBe('npm');
    expect(lock.path).toBe('package-lock.json');
    expect(lock.nodes.get('p:npm:node_modules/lodash')).toBe('sha512-AAA');
    expect(lock.nodes.get('p:npm:node_modules/@acme/core')).toBe('link:packages/core');
    expect(lock.nodes.get('p:npm:node_modules/gitdep')).toBe('0.1.0|git+ssh://git@github.com/x/y.git#abc');
    expect(lock.hash('p:npm:node_modules/a/node_modules/b')).toBe('sha512-CCC');
    expect(lock.hash('p:npm:node_modules/nothing')).toBeUndefined();
    const installed = [...lock.nodes].filter(([, hash]) => hash !== null).map(([key]) => key);
    expect(installed).toEqual([...parse(V3).packages.keys()].map((location) => `p:npm:${location}`));
  });

  it('its dependencies are the resolved locations and the ⊥ nodes of missing names', () => {
    // a declares b (its own copy), shared (hoisted) and react (installed nowhere)
    expect(lock.dependencies('p:npm:node_modules/a')).toEqual(['p:npm:node_modules/a/node_modules/b', 'p:npm:node_modules/react', 'p:npm:node_modules/shared']);
    expect(lock.nodes.get('p:npm:node_modules/react')).toBeNull();
    expect(lock.hash('p:npm:node_modules/react')).toBeNull();
    expect(lock.dependencies('p:npm:node_modules/react')).toEqual([]);
    expect(lock.dependencies('p:npm:node_modules/lodash')).toEqual([]);
    expect(lock.dependencies('f:src/a.ts')).toEqual([]);
  });

  it('locate returns the p:npm: key Node would load', () => {
    expect(lock.locate('b', 'packages/core')).toBe('p:npm:packages/core/node_modules/b');
    expect(lock.locate('b', 'node_modules/a/lib')).toBe('p:npm:node_modules/a/node_modules/b');
    expect(lock.locate('b', '')).toBe('p:npm:node_modules/b');
    expect(lock.locate('react', '')).toBeNull();
  });
});
