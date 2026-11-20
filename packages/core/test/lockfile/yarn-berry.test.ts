import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { modelProblem } from '../../src/lockfile/model.ts';
import type { ModelEntry, Ref, ResolvedModel } from '../../src/lockfile/model.ts';
import type { Unparseable } from '../../src/lockfile/npm.ts';
import { parseYarnBerryLockfile } from '../../src/lockfile/yarn-berry.ts';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/lockfile/${name}`, import.meta.url), 'utf8');
const V10 = fixture('yarn-berry-10.lock');
const V8 = fixture('yarn-berry-8.lock');
const PATCH_ID = 'resolve@patch:resolve@npm%3A1.22.12#optional!builtin<compat/resolve>::version=1.22.12&hash=c3c19d';

function read(text: string): ResolvedModel {
  const result = parseYarnBerryLockfile(text);
  if ('kind' in result) {
    throw new Error(`expected a model, got: ${result.reason}`);
  }
  return result;
}

function refuse(text: string): Unparseable {
  const result = parseYarnBerryLockfile(text);
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

/** A lockfile of version 10 around `body`, which follows `__metadata`. */
const lock = (body: string): string => `__metadata:\n  version: 10\n  cacheKey: 10\n\n${body}`;

describe('parseYarnBerryLockfile', () => {
  it('workspace entries become importers, not entries', () => {
    const model = read(V10);
    expect([...model.importers.keys()].sort()).toEqual(['', 'docs']);
    expect([...model.entries.keys()].some((id) => id.includes('@workspace:'))).toBe(false);
    expect(model.env).toBeNull();
    expect(modelProblem(model)).toBeNull();

    const root = importerOf(model, '');
    expect(root.get('docs')).toEqual({ kind: 'link', dir: 'docs' });
    expect(root.get('remark-parse')).toEqual({ kind: 'entry', id: 'remark-parse@npm:8.0.3' });
    expect(root.get('resolve')).toEqual({ kind: 'entry', id: PATCH_ID });
    expect(importerOf(model, 'docs').get('vitepress')).toEqual({ kind: 'entry', id: 'vitepress@npm:1.6.3' });
  });

  it('every descriptor of a multi-descriptor key maps to the one entry', () => {
    const model = read(V10);
    const id = '@babel/code-frame@npm:7.29.7';
    expect(entryOf(model, id).name).toBe('@babel/code-frame');
    expect(importerOf(model, '').get('@babel/code-frame')).toEqual({ kind: 'entry', id });
    expect(importerOf(model, 'docs').get('@babel/code-frame')).toEqual({ kind: 'entry', id });
    expect(entryOf(model, 'vitepress@npm:1.6.3').dependencies.get('@babel/code-frame')).toEqual({ kind: 'entry', id });
  });

  it('versions 8 and 10 give the same model apart from checksums', () => {
    const strip = (model: ResolvedModel): unknown => ({
      importers: [...model.importers],
      entries: [...model.entries].map(([id, entry]) => [id, { ...entry, content: { ...(entry.content as object), checksum: null } }]),
    });
    const ten = read(V10);
    const eight = read(V8);
    expect(strip(eight)).toEqual(strip(ten));
    expect(entryOf(ten, 'trim@npm:1.0.1').content).toEqual({ resolution: 'trim@npm:1.0.1', checksum: '10/b9c0d2' });
    expect(entryOf(eight, 'trim@npm:1.0.1').content).toEqual({ resolution: 'trim@npm:1.0.1', checksum: '10c0/b9c0d2' });
  });

  it('version 9 is read as version 10 is', () => {
    const nine = V10.replace('__metadata:\n  version: 10\n', '__metadata:\n  version: 9\n');
    expect(nine).not.toBe(V10);
    expect(read(nine)).toEqual(read(V10));
  });

  describe('version 6 (yarn 3), which writes a range without its protocol', () => {
    const SIX = [
      '__metadata:\n  version: 6\n  cacheKey: 8\n',
      '"a@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "a@npm:1.0.0"\n  dependencies:\n    b: ^2.0.0\n    c: "npm:^3.0.0"\n    d: ^9.0.0\n    w: "workspace:^"\n  checksum: 6e98e4\n  languageName: node\n  linkType: hard\n',
      '"b@npm:^2.0.0":\n  version: 2.0.0\n  resolution: "b@npm:2.0.0"\n',
      '"c@npm:^3.0.0":\n  version: 3.0.0\n  resolution: "c@npm:3.0.0"\n',
      '"root@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "root@workspace:."\n  dependencies:\n    a: ^1.0.0\n    w: "workspace:^"\n  languageName: unknown\n  linkType: soft\n',
      '"w@workspace:^, w@workspace:w":\n  version: 0.0.0-use.local\n  resolution: "w@workspace:w"\n  languageName: unknown\n  linkType: soft\n',
    ].join('\n');

    it("resolves a bare range through yarn's default protocol, npm:", () => {
      const model = read(SIX);
      expect(importerOf(model, '').get('a')).toEqual({ kind: 'entry', id: 'a@npm:1.0.0' });
      const a = entryOf(model, 'a@npm:1.0.0');
      expect(a.dependencies.get('b')).toEqual({ kind: 'entry', id: 'b@npm:2.0.0' });
      expect(a.content).toEqual({ resolution: 'a@npm:1.0.0', checksum: '6e98e4' });
      expect(modelProblem(model)).toBeNull();
    });

    it('keeps a range that names its protocol, and leaves a range no key holds unresolved', () => {
      const a = entryOf(read(SIX), 'a@npm:1.0.0');
      expect(a.dependencies.get('c')).toEqual({ kind: 'entry', id: 'c@npm:3.0.0' });
      expect(a.dependencies.get('w')).toEqual({ kind: 'link', dir: 'w' });
      expect(a.dependencies.get('d')).toEqual({ kind: 'unresolved' });
    });

    it('a later version gets no such fallback: its ranges name their protocol', () => {
      const ten = SIX.replace('__metadata:\n  version: 6\n', '__metadata:\n  version: 10\n');
      expect(entryOf(read(ten), 'a@npm:1.0.0').dependencies.get('b')).toEqual({ kind: 'unresolved' });
    });
  });

  it('a redirected reference is unresolved', () => {
    const model = read(V10);
    expect(entryOf(model, 'remark-parse@npm:8.0.3').dependencies.get('trim')).toEqual({ kind: 'unresolved' });
    expect(model.entries.has('trim@npm:1.0.1')).toBe(true);
  });

  it('patch entries are ordinary entries named after their package', () => {
    const entry = entryOf(read(V10), PATCH_ID);
    expect(entry.name).toBe('resolve');
    expect(entry.content).toEqual({ resolution: PATCH_ID, checksum: '10/ab0af5' });
    expect(entry.dependencies.get('is-core-module')).toEqual({ kind: 'entry', id: 'is-core-module@npm:2.16.1' });
  });

  it('peers are listed by name', () => {
    const model = read(V10);
    expect(entryOf(model, 'react-dom@npm:18.3.1').peers).toEqual(['react', 'react-native']);
    // A peer is not a dependency.
    expect([...entryOf(model, 'react-dom@npm:18.3.1').dependencies.keys()]).toEqual(['js-tokens']);
    expect(entryOf(model, 'js-tokens@npm:4.0.0').peers).toEqual([]);
  });

  it('conditions, dependenciesMeta and the other fields are read past', () => {
    const entry = entryOf(read(V10), 'fsevents@npm:2.3.3');
    expect(entry.content).toEqual({ resolution: 'fsevents@npm:2.3.3', checksum: '10/4c1ade' });
    expect(entry.dependencies.get('node-gyp')).toEqual({ kind: 'unresolved' });
  });

  it('an entry without a checksum has a null one', () => {
    const model = read(lock('"a@npm:1.0.0":\n  version: 1.0.0\n  resolution: "a@npm:1.0.0"\n'));
    expect(entryOf(model, 'a@npm:1.0.0').content).toEqual({ resolution: 'a@npm:1.0.0', checksum: null });
  });

  it('a lockfile with only __metadata is an empty model', () => {
    const model = read('__metadata:\n  version: 8\n  cacheKey: 8\n');
    expect(model.importers.size).toBe(0);
    expect(model.entries.size).toBe(0);
    expect(model.env).toBeNull();
  });

  it('a workspace that depends on nothing is an importer with no declarations', () => {
    const model = read(lock('"w@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "w@workspace:."\n  languageName: unknown\n  linkType: soft\n'));
    expect([...model.importers]).toEqual([['', new Map()]]);
  });

  it('an empty dependencies value is an empty map', () => {
    const model = read(lock('"a@npm:1.0.0":\n  resolution: "a@npm:1.0.0"\n  dependencies:\n'));
    expect(entryOf(model, 'a@npm:1.0.0').dependencies.size).toBe(0);
  });

  it.each([
    ['version 4 (yarn 2)', '__metadata:\n  version: 4\n  cacheKey: 7\n', /version "4", and only '6', '8', '9' and '10' are read/],
    ['version 7', '__metadata:\n  version: 7\n  cacheKey: 8\n', /version "7"/],
    ['no __metadata', '"a@npm:1.0.0":\n  resolution: "a@npm:1.0.0"\n', /__metadata/],
    ['an entry with no resolution', lock('"a@npm:1.0.0":\n  version: 1.0.0\n'), /resolution/],
    [
      'a descriptor in two keys',
      lock('"a@npm:1.0.0, b@npm:1.0.0":\n  resolution: "a@npm:1.0.0"\n\n"b@npm:1.0.0":\n  resolution: "b@npm:1.0.0"\n'),
      /descriptor/,
    ],
    ['two entries with one resolution', lock('"a@npm:^1.0.0":\n  resolution: "a@npm:1.0.0"\n\n"a@npm:~1.0.0":\n  resolution: "a@npm:1.0.0"\n'), /resolution/],
    ['dependencies that are not a map', lock('"a@npm:1.0.0":\n  resolution: "a@npm:1.0.0"\n  dependencies: x\n'), /dependencies/],
    ['peerDependencies that are a list', lock('"a@npm:1.0.0":\n  resolution: "a@npm:1.0.0"\n  peerDependencies:\n    - x\n'), /peerDependencies/],
    ['a top-level value that is not a map', lock('"a@npm:1.0.0": x\n'), /not a map/],
    ['two documents', `${V10}---\n${V10}`, /document/],
    ['a resolution that makes an id with @*', lock('"a@npm:1.0.0":\n  resolution: "a@*"\n'), /@\*/],
    ['a YAML refusal', '__metadata:\n  version: 10\n\t bad\n', /line \d+/],
  ])('refuses %s', (_name, text, reason) => {
    const refusal = refuse(text);
    expect(refusal.format).toBe('yarn');
    expect(refusal.reason).toMatch(reason);
  });

  it('refuses a version that is not one of those numbers, written plainly', () => {
    expect(refuse('__metadata:\n  version: "08"\n').reason).toMatch(/version/);
    expect(refuse('__metadata:\n  cacheKey: 10\n').reason).toMatch(/version/);
  });
});
