import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { diffLockfiles } from '../../src/lockfile/lockfile.ts';
import type { Lockfile } from '../../src/lockfile/lockfile.ts';
import { lockfileFromModel } from '../../src/lockfile/model.ts';
import { npmLockfile, parseNpmLockfile } from '../../src/lockfile/npm.ts';
import { parsePnpmLockfile } from '../../src/lockfile/pnpm.ts';

const V3 = JSON.stringify({
  name: 'root',
  lockfileVersion: 3,
  packages: {
    '': { name: 'root', dependencies: { lodash: '^4' } },
    'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-AAA' },
    'node_modules/shared': { version: '1.2.0', integrity: 'sha512-EEE', dev: true },
  },
});
const PNPM = readFileSync(new URL('../fixtures/lockfile/pnpm-one-document.yaml', import.meta.url), 'utf8');

function npm(text: string): Lockfile {
  const parsed = parseNpmLockfile(text);
  if (parsed.kind !== 'npm') {
    throw new Error(parsed.reason);
  }
  return npmLockfile(parsed, 'package-lock.json');
}

function pnpm(text: string): Lockfile {
  const model = parsePnpmLockfile(text);
  if ('kind' in model) {
    throw new Error(model.reason);
  }
  return lockfileFromModel('pnpm', 'pnpm-lock.yaml', model);
}

describe('diffLockfiles', () => {
  it('reports p: keys added, changed and removed (npm)', () => {
    const changed = JSON.parse(V3) as { packages: Record<string, Record<string, unknown>> };
    changed.packages['node_modules/lodash']!['integrity'] = 'sha512-NEW';
    delete changed.packages['node_modules/shared'];
    changed.packages['node_modules/zod'] = { version: '4.0.0', integrity: 'sha512-ZZZ' };
    expect(diffLockfiles(npm(V3), npm(JSON.stringify(changed)))).toEqual({
      added: ['p:npm:node_modules/zod'],
      changed: ['p:npm:node_modules/lodash'],
      removed: ['p:npm:node_modules/shared'],
    });
  });

  it('reports p: keys added, changed and removed (pnpm)', () => {
    const edited = PNPM.replaceAll('sha512-zod}', 'sha512-zod-new}').replaceAll('sha512-tinyspy}', 'sha512-tinyspy-new}');
    const result = diffLockfiles(pnpm(PNPM), pnpm(edited));
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual(['p:pnpm:tinyspy@3.0.0', 'p:pnpm:zod@3.24.3']);
    const extra = '  zzz@1.0.0:\n    resolution: {integrity: sha512-zzz}\n\n';
    const grown = pnpm(PNPM.replace('  zod@3.24.3:\n', `${extra}  zod@3.24.3:\n`).replace('  zod@3.24.3: {}\n', '  zzz@1.0.0: {}\n\n  zod@3.24.3: {}\n'));
    expect(diffLockfiles(pnpm(PNPM), grown).added).toEqual(['p:pnpm:zzz@1.0.0']);
    expect(diffLockfiles(grown, pnpm(PNPM)).removed).toEqual(['p:pnpm:zzz@1.0.0']);
  });

  it('treats a null (⊥) hash as a hash like any other', () => {
    const lock = (nodes: [string, string | null][]): Lockfile => ({ kind: 'npm', path: 'x', nodes: new Map(nodes), hash: () => undefined, dependencies: () => [], locate: () => null });
    expect(diffLockfiles(lock([['p:npm:a', null], ['p:npm:b', 'h'], ['p:npm:c', null]]), lock([['p:npm:a', null], ['p:npm:b', null], ['p:npm:d', null]]))).toEqual({
      added: ['p:npm:d'],
      changed: ['p:npm:b'],
      removed: ['p:npm:c'],
    });
  });

  it('sorts each list by UTF-16 code unit', () => {
    const lock = (keys: string[]): Lockfile => ({ kind: 'npm', path: 'x', nodes: new Map(keys.map((k) => [k, 'h'])), hash: () => undefined, dependencies: () => [], locate: () => null });
    expect(diffLockfiles(lock([]), lock(['p:npm:b', 'p:npm:B', 'p:npm:a'])).added).toEqual(['p:npm:B', 'p:npm:a', 'p:npm:b']);
  });
});
