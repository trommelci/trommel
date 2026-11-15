import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { modelProblem } from '../../src/lockfile/model.ts';
import type { ModelEntry, Ref, ResolvedModel } from '../../src/lockfile/model.ts';
import type { Unparseable } from '../../src/lockfile/npm.ts';
import { parsePnpmLockfile } from '../../src/lockfile/pnpm.ts';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/lockfile/${name}`, import.meta.url), 'utf8');
const TWO = fixture('pnpm-two-documents.yaml');
const ONE = fixture('pnpm-one-document.yaml');

function read(text: string): ResolvedModel {
  const result = parsePnpmLockfile(text);
  if ('kind' in result) {
    throw new Error(`expected a model, got: ${result.reason}`);
  }
  return result;
}

function refuse(text: string): Unparseable {
  const result = parsePnpmLockfile(text);
  if (!('kind' in result)) {
    throw new Error('expected a refusal, got a model');
  }
  return result;
}

const entryOf = (model: ResolvedModel, id: string): ModelEntry => {
  const found = model.entries.get(id);
  if (found === undefined) {
    throw new Error(`no entry ${id}`);
  }
  return found;
};
const importerOf = (model: ResolvedModel, dir: string): ReadonlyMap<string, Ref> => {
  const found = model.importers.get(dir);
  if (found === undefined) {
    throw new Error(`no importer ${JSON.stringify(dir)}`);
  }
  return found;
};

/** A one-document lockfile around `body`, which follows the version line. */
const lock = (body: string): string => `lockfileVersion: '9.0'\n${body}`;

describe('parsePnpmLockfile', () => {
  it("reads both documents of a pnpm 12 lockfile, pnpm's own as env", () => {
    const model = read(TWO);
    const env = model.env as { lockfileVersion: string; importers: Record<string, unknown>; snapshots: Record<string, unknown> };
    expect(env.lockfileVersion).toBe('9.0');
    expect(env.importers['.']).toEqual({ configDependencies: {}, packageManagerDependencies: { pnpm: { specifier: '12.0.0', version: '12.0.0' } } });
    expect(env.snapshots).toEqual({ 'pnpm@12.0.0': {} });
    // pnpm's packages are not entries: only the project document has any.
    expect(model.entries.has('pnpm@12.0.0')).toBe(false);
    expect([...model.entries.keys()]).toContain('vitest@5.0.1');
  });

  it('one document gives env null and the same project model', () => {
    const one = read(ONE);
    expect(one.env).toBeNull();
    expect(read(TWO).importers).toEqual(one.importers);
    expect(read(TWO).entries).toEqual(one.entries);
  });

  it('aliases, links, tarball keys and peer suffixes resolve as spec §7.2 says', () => {
    const model = read(TWO);
    const root = importerOf(model, '');
    expect(root.get('zod3')).toEqual({ kind: 'entry', id: 'zod@3.24.3' });
    expect(root.get('zod443')).toEqual({ kind: 'entry', id: 'zod443@https://registry.npmjs.org/zod/-/zod-4.4.3.tgz' });
    expect(root.get('@vitest/coverage-v8')).toEqual({ kind: 'entry', id: '@vitest/coverage-v8@5.0.1(vitest@5.0.1)' });
    expect(root.get('vitest')).toEqual({ kind: 'entry', id: 'vitest@5.0.1' });
    expect(importerOf(model, 'packages/a').get('@scope/b')).toEqual({ kind: 'link', dir: 'packages/@scope/b' });

    const peer = entryOf(model, '@vitest/coverage-v8@5.0.1(vitest@5.0.1)');
    expect(peer.name).toBe('@vitest/coverage-v8');
    expect(peer.content).toEqual({ integrity: 'sha512-coverage-v8' });
    expect(peer.dependencies).toEqual(new Map([['vitest', { kind: 'entry', id: 'vitest@5.0.1' }]]));
    expect(peer.peers).toEqual([]);

    const tarball = entryOf(model, 'zod443@https://registry.npmjs.org/zod/-/zod-4.4.3.tgz');
    expect(tarball.name).toBe('zod443');
    expect(tarball.content).toEqual({ tarball: 'https://registry.npmjs.org/zod/-/zod-4.4.3.tgz' });
  });

  it("a reference to the workspace's own version is unresolved", () => {
    const ai = entryOf(read(TWO), 'ai@6.0.5(zod@4.6.7)');
    expect(ai.dependencies.get('zod')).toEqual({ kind: 'unresolved' });
    expect(ai.content).toEqual({ integrity: 'sha512-ai' });
  });

  it('packages for other platforms are entries', () => {
    const model = read(TWO);
    expect(entryOf(model, '@esbuild/darwin-arm64@0.27.7').content).toEqual({ integrity: 'sha512-esbuild-darwin-arm64' });
    expect(importerOf(model, 'packages/a').get('@esbuild/darwin-arm64')).toEqual({ kind: 'entry', id: '@esbuild/darwin-arm64@0.27.7' });
  });

  it('reads past settings, catalogs and overrides', () => {
    const start = ONE.indexOf('settings:');
    const end = ONE.indexOf('importers:');
    expect(start).toBeGreaterThan(0);
    const stripped = ONE.slice(0, start) + ONE.slice(end);
    expect(stripped).not.toContain('catalogs');
    expect(read(stripped)).toEqual(read(ONE));
  });

  it('importer directories keep scopes, and . is the root', () => {
    const model = read(ONE);
    expect([...model.importers.keys()].sort()).toEqual(['', 'packages/@scope/b', 'packages/a']);
    expect(importerOf(model, 'packages/@scope/b').get('vitest')).toEqual({ kind: 'entry', id: 'vitest@5.0.1' });
  });

  it('a lockfile with only an empty root importer is an empty model', () => {
    for (const root of ['  .: {}\n', '  .:\n']) {
      const model = read(lock(`\nimporters:\n\n${root}`));
      expect([...model.importers]).toEqual([['', new Map()]]);
      expect(model.entries.size).toBe(0);
      expect(model.env).toBeNull();
    }
    expect(read(lock('importers:\n')).importers.size).toBe(0);
  });

  it('a link out of the repository is unresolved, and a snapshot link is relative to the root', () => {
    const model = read(
      lock(
        [
          'importers:',
          '  .:',
          '    dependencies:',
          '      up:',
          '        specifier: link:../x',
          '        version: link:../x',
          '  packages/a:',
          '    dependencies:',
          '      sib:',
          '        specifier: link:../b',
          '        version: link:../b',
          'packages:',
          '  p@1.0.0:',
          '    resolution: {integrity: sha512-p}',
          'snapshots:',
          '  p@1.0.0:',
          '    dependencies:',
          '      inside: link:packages/b',
          '      outside: link:../../x',
          '',
        ].join('\n'),
      ),
    );
    expect(importerOf(model, '').get('up')).toEqual({ kind: 'unresolved' });
    expect(importerOf(model, 'packages/a').get('sib')).toEqual({ kind: 'link', dir: 'packages/b' });
    const deps = entryOf(model, 'p@1.0.0').dependencies;
    expect(deps.get('inside')).toEqual({ kind: 'link', dir: 'packages/b' });
    expect(deps.get('outside')).toEqual({ kind: 'unresolved' });
  });

  it('an unknown id is unresolved, and optionalDependencies of a snapshot are dependencies', () => {
    const model = read(
      lock(
        [
          'importers:',
          '  .:',
          '    dependencies:',
          '      gone:',
          '        specifier: 1.0.0',
          '        version: 1.0.0',
          'packages:',
          '  p@1.0.0:',
          '    resolution: {integrity: sha512-p}',
          '  q@1.0.0:',
          '    resolution: {integrity: sha512-q}',
          'snapshots:',
          '  p@1.0.0:',
          '    optionalDependencies:',
          '      q: 1.0.0',
          '  q@1.0.0: {}',
          '',
        ].join('\n'),
      ),
    );
    expect(importerOf(model, '').get('gone')).toEqual({ kind: 'unresolved' });
    expect(entryOf(model, 'p@1.0.0').dependencies.get('q')).toEqual({ kind: 'entry', id: 'q@1.0.0' });
  });

  it('keeps a __proto__ key of a resolution as plain data', () => {
    const model = read(lock('packages:\n  p@1.0.0:\n    resolution: {integrity: x, __proto__: y}\nsnapshots:\n  p@1.0.0: {}\nimporters:\n  .: {}\n'));
    const content = entryOf(model, 'p@1.0.0').content as Record<string, unknown>;
    expect(Object.keys(content)).toEqual(['__proto__', 'integrity']);
    expect(Object.getPrototypeOf(content)).toBe(Object.prototype);
  });

  it('cuts the peer suffix at the first ( after the @ that ends the name, not at one in the name', () => {
    const body = ['importers:', '  .: {}', 'packages:', '  a(b)@1.0.0:', '    resolution: {integrity: x}', 'snapshots:', '  a(b)@1.0.0(c@1.0.0): {}', ''].join('\n');
    const model = read(lock(body));
    expect(entryOf(model, 'a(b)@1.0.0(c@1.0.0)').content).toEqual({ integrity: 'x' });
  });

  it('the output of everything it accepts satisfies modelProblem', () => {
    expect(modelProblem(read(TWO))).toBeNull();
    expect(modelProblem(read(ONE))).toBeNull();
  });

  const ROOT = 'importers:\n  .: {}\n';
  it.each<[string, string, RegExp]>([
    ['a lockfileVersion of 6.0', "lockfileVersion: '6.0'\n" + ROOT, /lockfileVersion/],
    ['an unquoted lockfileVersion: 9', 'lockfileVersion: 9\n' + ROOT, /lockfileVersion/],
    ['no lockfileVersion', ROOT, /lockfileVersion/],
    ['three documents', `${lock(ROOT)}---\n${lock(ROOT)}---\n${lock(ROOT)}`, /document/],
    ['a first document holding settings', `lockfileVersion: '9.0'\nsettings:\n  a: b\n---\n${lock(ROOT)}`, /pnpm's own/],
    ['a first document whose root importer holds dependencies', `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: 1\n        version: 1\n---\n${lock(ROOT)}`, /pnpm's own/],
    ['a snapshot with no packages entry', lock(`${ROOT}snapshots:\n  foo@1.0.0: {}\n`), /no packages entry/],
    ['an importer dependency with no version', lock('importers:\n  .:\n    dependencies:\n      foo:\n        specifier: 1\n'), /version/],
    ['a packages entry with no resolution map', lock(`${ROOT}packages:\n  foo@1.0.0: {}\nsnapshots:\n  foo@1.0.0: {}\n`), /resolution/],
    ['a resolution that is not a map', lock(`${ROOT}packages:\n  foo@1.0.0:\n    resolution: abc\nsnapshots:\n  foo@1.0.0: {}\n`), /resolution/],
    ['no importers', lock('packages:\n'), /importers/],
    ['a YAML refusal, with its line', lock('importers:\n\t.: {}\n'), /line \d+/],
    ['a snapshot key whose name node would collide', lock(`${ROOT}packages:\n  foo@*:\n    resolution: {integrity: x}\nsnapshots:\n  foo@*: {}\n`), /@\*/],
  ])('refuses %s', (_title, text, reason) => {
    const result = refuse(text);
    expect(result.kind).toBe('unparseable');
    expect(result.format).toBe('pnpm');
    expect(result.reason).toMatch(reason);
  });
});
