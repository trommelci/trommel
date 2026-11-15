import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/canonical-json.ts';
import type { Lockfile } from '../../src/lockfile/lockfile.ts';
import { lockfileFromModel, lookupKey, modelProblem, nameOfId } from '../../src/lockfile/model.ts';
import type { ModelEntry, Ref, ResolvedModel } from '../../src/lockfile/model.ts';

const entry = (id: string): Ref => ({ kind: 'entry', id });
const link = (dir: string): Ref => ({ kind: 'link', dir });
const unresolved: Ref = { kind: 'unresolved' };

type Declared = readonly (readonly [string, Ref])[];

interface EntrySpec {
  readonly name?: string;
  readonly content?: unknown;
  readonly deps?: Declared;
  readonly peers?: readonly string[];
}

function mk(id: string, spec: EntrySpec = {}): ModelEntry {
  return {
    name: spec.name ?? nameOfId(id),
    content: spec.content ?? { integrity: `sha512-${id}` },
    dependencies: new Map(spec.deps ?? []),
    peers: spec.peers ?? [],
  };
}

// Tuples, not object literals, so that `__proto__` is an ordinary name here too.
function model(importers: readonly (readonly [string, Declared])[], entries: readonly (readonly [string, EntrySpec])[], env: unknown = null): ResolvedModel {
  return {
    importers: new Map(importers.map(([dir, declared]) => [dir, new Map(declared)])),
    entries: new Map(entries.map(([id, spec]) => [id, mk(id, spec)])),
    env,
  };
}

const pnpm = (m: ResolvedModel): Lockfile => lockfileFromModel('pnpm', 'pnpm-lock.yaml', m);
const sha256 = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('lockfileFromModel', () => {
  it('a lockfile-only bump changes the lookup of the package that moved and nothing of the one that stayed', () => {
    const before = pnpm(
      model(
        [
          ['', []],
          ['packages/a', [['foo', entry('foo@1.0.0')]]],
          ['packages/b', [['foo', entry('foo@1.0.0')]]],
        ],
        [['foo@1.0.0', {}]],
      ),
    );
    const after = pnpm(
      model(
        [
          ['', []],
          ['packages/a', [['foo', entry('foo@1.1.0')]]],
          ['packages/b', [['foo', entry('foo@1.0.0')]]],
        ],
        [
          ['foo@1.0.0', {}],
          ['foo@1.1.0', {}],
        ],
      ),
    );
    const a = 'p:npm:packages/a/node_modules/foo';
    const b = 'p:npm:packages/b/node_modules/foo';
    expect(before.hash(a)).toBe('foo@1.0.0');
    expect(after.hash(a)).toBe('foo@1.1.0');
    expect(before.dependencies(a)).toEqual(['p:pnpm:foo@1.0.0']);
    expect(after.dependencies(a)).toEqual(['p:pnpm:foo@1.1.0']);
    expect(after.hash(b)).toBe('foo@1.0.0');
    expect(after.hash(b)).toBe(before.hash(b));
    expect(after.hash('p:pnpm:foo@1.0.0')).toBe(before.hash('p:pnpm:foo@1.0.0'));
    expect(after.hash('p:pnpm:foo@*')).not.toBe(before.hash('p:pnpm:foo@*'));
    expect([...after.nodes]).toEqual([
      [a, 'foo@1.1.0'],
      [b, 'foo@1.0.0'],
      ['p:pnpm:foo@1.0.0', sha256({ content: { integrity: 'sha512-foo@1.0.0' }, dependencies: {}, peers: [] })],
      ['p:pnpm:foo@1.1.0', sha256({ content: { integrity: 'sha512-foo@1.1.0' }, dependencies: {}, peers: [] })],
    ]);
    expect(after.kind).toBe('pnpm');
    expect(after.path).toBe('pnpm-lock.yaml');
  });

  it('an entry whose dependency moves changes hash, though its content did not', () => {
    const build = (fooId: string): Lockfile =>
      pnpm(
        model(
          [['', [['bar', entry('bar@1.0.0')]]]],
          [
            ['bar@1.0.0', { content: { integrity: 'sha512-bar' }, deps: [['foo', entry(fooId)]] }],
            ['foo@1.0.0', {}],
            ['foo@1.1.0', {}],
          ],
        ),
      );
    const before = build('foo@1.0.0');
    const after = build('foo@1.1.0');
    expect(before.hash('p:pnpm:bar@1.0.0')).toBe(sha256({ content: { integrity: 'sha512-bar' }, dependencies: { foo: 'foo@1.0.0' }, peers: [] }));
    expect(after.hash('p:pnpm:bar@1.0.0')).toBe(sha256({ content: { integrity: 'sha512-bar' }, dependencies: { foo: 'foo@1.1.0' }, peers: [] }));
    expect(after.hash('p:pnpm:bar@1.0.0')).not.toBe(before.hash('p:pnpm:bar@1.0.0'));
    expect(before.dependencies('p:pnpm:bar@1.0.0')).toEqual(['p:pnpm:foo@1.0.0']);
    expect(after.dependencies('p:pnpm:bar@1.0.0')).toEqual(['p:pnpm:foo@1.1.0']);
    expect(after.hash('p:npm:node_modules/bar')).toBe(before.hash('p:npm:node_modules/bar'));
  });

  it('an entry hashes its sorted peers and points at their name nodes', () => {
    const id = 'react-dom@npm:18.3.1';
    const lock = lockfileFromModel(
      'yarn-berry',
      'yarn.lock',
      model(
        [['', [['react-dom', entry(id)]]]],
        [
          [id, { content: { resolution: id, checksum: 'c1' }, deps: [['loose-envify', entry('loose-envify@npm:1.4.0')]], peers: ['scheduler', 'react'] }],
          ['loose-envify@npm:1.4.0', {}],
          ['react@npm:18.3.1', {}],
        ],
      ),
    );
    expect(lock.hash(`p:yarn:${id}`)).toBe(
      sha256({ content: { resolution: id, checksum: 'c1' }, dependencies: { 'loose-envify': 'loose-envify@npm:1.4.0' }, peers: ['react', 'scheduler'] }),
    );
    expect(lock.dependencies(`p:yarn:${id}`)).toEqual(['p:yarn:loose-envify@npm:1.4.0', 'p:yarn:react@*', 'p:yarn:scheduler@*']);
    expect(lock.nodes.get('p:yarn:react@*')).toBe(sha256({ entries: ['react@npm:18.3.1'], declared: [], dependents: [] }));
    expect(lock.dependencies('p:yarn:react@*')).toEqual(['p:yarn:react@npm:18.3.1']);
    expect(lock.nodes.has('p:yarn:scheduler@*')).toBe(true);
    expect(lock.nodes.get('p:yarn:scheduler@*')).toBeNull();
    expect(lock.dependencies('p:yarn:scheduler@*')).toEqual([]);
    const without = lockfileFromModel(
      'yarn-berry',
      'yarn.lock',
      model(
        [['', [['react-dom', entry(id)]]]],
        [
          [id, { content: { resolution: id, checksum: 'c1' }, deps: [['loose-envify', entry('loose-envify@npm:1.4.0')]], peers: ['react'] }],
          ['loose-envify@npm:1.4.0', {}],
          ['react@npm:18.3.1', {}],
        ],
      ),
    );
    expect(without.hash(`p:yarn:${id}`)).not.toBe(lock.hash(`p:yarn:${id}`));
  });

  it('prefixes both yarns with p:yarn:', () => {
    for (const kind of ['yarn-berry', 'yarn-classic'] as const) {
      const lock = lockfileFromModel(kind, 'yarn.lock', model([['', [['foo', entry('foo@1.0.0')]]]], [['foo@1.0.0', {}]]));
      expect(lock.kind).toBe(kind);
      expect(lock.path).toBe('yarn.lock');
      expect([...lock.nodes.keys()]).toEqual(['p:npm:node_modules/foo', 'p:yarn:foo@1.0.0']);
      expect(lock.dependencies('p:npm:node_modules/foo')).toEqual(['p:yarn:foo@1.0.0']);
      expect(lock.locate('foo', 'scripts')).toBe('p:npm:node_modules/foo');
      expect(lock.hash('p:yarn:foo@*')).not.toBeNull();
      expect(lock.hash('p:pnpm:foo@*')).toBeUndefined();
      expect(lock.hash('p:pnpm:foo@1.0.0')).toBeUndefined();
    }
  });

  it('locate follows spec §6.4', () => {
    const m = model(
      [
        ['', [['vitest', entry('vitest@5.0.1')]]],
        ['packages/a', [['foo', entry('foo@1.0.0')]]],
      ],
      [
        ['vitest@5.0.1', {}],
        ['foo@1.0.0', { deps: [['bar', entry('bar@2.0.0')]] }],
        ['bar@2.0.0', {}],
      ],
    );
    const lock = pnpm(m);
    expect(lock.locate('foo', 'packages/a/src')).toBe('p:npm:packages/a/node_modules/foo');
    expect(lock.locate('vitest', 'packages/a/test')).toBe('p:pnpm:vitest@*');
    expect(lock.locate('vitest', 'scripts')).toBe('p:npm:node_modules/vitest');
    expect(lock.locate('bar', 'packages/a')).toBe('p:pnpm:bar@*');
    expect(lock.locate('nope', 'packages/a')).toBeNull();
    // The name node a case-2 lookup lands on is computed on demand.
    expect(lock.nodes.has('p:pnpm:vitest@*')).toBe(false);
    expect(lock.hash('p:pnpm:vitest@*')).toBe(sha256({ entries: ['vitest@5.0.1'], declared: [['', 'vitest@5.0.1']], dependents: [] }));
    expect(lock.dependencies('p:pnpm:vitest@*')).toEqual(['p:pnpm:vitest@5.0.1']);
    expect(lockfileFromModel('yarn-classic', 'yarn.lock', m).locate('vitest', 'packages/a/test')).toBe('p:yarn:vitest@*');
  });

  it("a file's own importer is the deepest that contains it, on a / boundary", () => {
    const lock = pnpm(
      model(
        [
          ['', [['foo', entry('foo@1.0.0')]]],
          ['packages/a', [['foo', entry('foo@2.0.0')]]],
          ['packages/a/nested', [['baz', entry('baz@1.0.0')]]],
        ],
        [
          ['foo@1.0.0', {}],
          ['foo@2.0.0', {}],
          ['baz@1.0.0', {}],
        ],
      ),
    );
    expect(lock.locate('foo', 'packages/a')).toBe('p:npm:packages/a/node_modules/foo');
    expect(lock.locate('foo', 'packages/ab/src')).toBe('p:npm:node_modules/foo');
    expect(lock.locate('foo', '')).toBe('p:npm:node_modules/foo');
    expect(lock.locate('baz', 'packages/a/nested/deep/er')).toBe('p:npm:packages/a/nested/node_modules/baz');
    // packages/a/nested does not declare foo, and its parent's declaration does not decide for it.
    expect(lock.locate('foo', 'packages/a/nested/src')).toBe('p:pnpm:foo@*');
    expect(lock.locate('baz', 'packages/a')).toBe('p:pnpm:baz@*');

    // With no root importer, a file outside every importer has no own importer: only cases 2 and 3.
    const rootless = pnpm(model([['packages/a', [['foo', entry('foo@1.0.0')]]]], [['foo@1.0.0', {}]]));
    expect(rootless.locate('foo', 'scripts')).toBe('p:pnpm:foo@*');
    expect(rootless.locate('foo', '')).toBe('p:pnpm:foo@*');
    expect(rootless.locate('nope', 'scripts')).toBeNull();
  });

  it('does not change when the model it was built from does', () => {
    const declared = new Map<string, Ref>([['foo', entry('foo@1.0.0')]]);
    const importers = new Map<string, Map<string, Ref>>([['packages/a', declared]]);
    const entries = new Map<string, ModelEntry>([['foo@1.0.0', mk('foo@1.0.0')]]);
    const lock = pnpm({ importers, entries, env: null });
    const nodes = [...lock.nodes];
    declared.set('vitest', entry('vitest@5.0.1'));
    importers.set('', new Map([['vitest', entry('vitest@5.0.1')]]));
    entries.set('vitest@5.0.1', mk('vitest@5.0.1'));
    expect([...lock.nodes]).toEqual(nodes);
    expect(lock.locate('vitest', 'packages/a/test')).toBeNull();
    expect(lock.locate('foo', 'scripts')).toBe('p:pnpm:foo@*');
    expect(lock.hash('p:pnpm:vitest@*')).toBeNull();
  });

  it('a name the lockfile knows only as an unresolved dependency is not known to locate', () => {
    const lock = pnpm(model([['', []]], [['x@1.0.0', { deps: [['ghost', unresolved]] }]]));
    expect(lock.locate('ghost', '')).toBeNull();
    expect(lock.nodes.has('p:pnpm:ghost@*')).toBe(true);
  });

  it('a name node changes when a copy appears, a declaration moves or a dependent re-points, and not otherwise', () => {
    const cov = '@vitest/coverage-v8@5.0.1(vitest@5.0.1)';
    interface Draft {
      importers: Map<string, Map<string, Ref>>;
      entries: Map<string, ModelEntry>;
    }
    const vitestNode = (edit: (draft: Draft) => void = () => undefined): string | null | undefined => {
      const draft: Draft = {
        importers: new Map([
          ['', new Map([['vitest', entry('vitest@5.0.1')]])],
          ['packages/a', new Map([['foo', entry('foo@1.0.0')]])],
        ]),
        entries: new Map([
          ['vitest@5.0.1', mk('vitest@5.0.1')],
          ['vitest@4.0.0', mk('vitest@4.0.0')],
          [cov, mk(cov, { deps: [['vitest', entry('vitest@5.0.1')], ['magicast', entry('magicast@0.3.5')]] })],
          ['magicast@0.3.5', mk('magicast@0.3.5')],
          ['foo@1.0.0', mk('foo@1.0.0')],
        ]),
      };
      edit(draft);
      return pnpm({ importers: draft.importers, entries: draft.entries, env: null }).hash('p:pnpm:vitest@*');
    };

    const original = vitestNode();
    expect(original).toBe(
      sha256({
        entries: ['vitest@4.0.0', 'vitest@5.0.1'],
        declared: [['', 'vitest@5.0.1']],
        dependents: [[cov, 'vitest@5.0.1']],
      }),
    );

    const changes: Record<string, (draft: Draft) => void> = {
      'a copy appears': (d) => d.entries.set('vitest@5.0.2', mk('vitest@5.0.2')),
      'a copy disappears': (d) => d.entries.delete('vitest@4.0.0'),
      'a declaration moves': (d) => d.importers.get('')!.set('vitest', entry('vitest@4.0.0')),
      'a declaration becomes unresolved': (d) => d.importers.get('')!.set('vitest', unresolved),
      'a workspace starts declaring it': (d) => d.importers.get('packages/a')!.set('vitest', entry('vitest@5.0.1')),
      'a workspace stops declaring it': (d) => d.importers.get('')!.delete('vitest'),
      'a dependent re-points': (d) => d.entries.set(cov, mk(cov, { deps: [['vitest', entry('vitest@4.0.0')], ['magicast', entry('magicast@0.3.5')]] })),
      'a dependent appears': (d) => d.entries.set('foo@1.0.0', mk('foo@1.0.0', { deps: [['vitest', entry('vitest@5.0.1')]] })),
      'a dependent disappears': (d) => d.entries.set(cov, mk(cov, { deps: [['magicast', entry('magicast@0.3.5')]] })),
    };
    for (const [what, edit] of Object.entries(changes)) {
      expect(vitestNode(edit), what).not.toBe(original);
    }

    const nonChanges: Record<string, (draft: Draft) => void> = {
      "a copy's content changes": (d) => d.entries.set('vitest@5.0.1', mk('vitest@5.0.1', { content: { integrity: 'sha512-other' } })),
      "a copy's own dependency moves": (d) => d.entries.set('vitest@5.0.1', mk('vitest@5.0.1', { deps: [['magicast', entry('magicast@0.3.5')]] })),
      'another name is bumped': (d) => {
        d.importers.get('packages/a')!.set('foo', entry('foo@1.1.0'));
        d.entries.set('foo@1.1.0', mk('foo@1.1.0'));
      },
      "a dependent's other dependency moves": (d) => {
        d.entries.set('magicast@0.3.6', mk('magicast@0.3.6'));
        d.entries.set(cov, mk(cov, { deps: [['vitest', entry('vitest@5.0.1')], ['magicast', entry('magicast@0.3.6')]] }));
      },
      "a dependent's content changes": (d) => d.entries.set(cov, mk(cov, { content: 'other', deps: [['vitest', entry('vitest@5.0.1')], ['magicast', entry('magicast@0.3.5')]] })),
      'an entry gains it as a peer': (d) => d.entries.set('foo@1.0.0', mk('foo@1.0.0', { peers: ['vitest'] })),
    };
    for (const [what, edit] of Object.entries(nonChanges)) {
      expect(vitestNode(edit), what).toBe(original);
    }
  });

  it('a name node points at every entry its lists name', () => {
    const lock = pnpm(
      model(
        [['', [['zod3', entry('zod@3.24.3')], ['zod', entry('zod@4.0.0')]]]],
        [
          ['zod@3.24.3', {}],
          ['zod@4.0.0', {}],
          ['x@1.0.0', { deps: [['zod4', entry('zod@4.0.0')]] }],
        ],
      ),
    );
    expect(lock.dependencies('p:pnpm:zod3@*')).toEqual(['p:pnpm:zod@3.24.3']);
    expect(lock.hash('p:pnpm:zod3@*')).toBe(sha256({ entries: [], declared: [['', 'zod@3.24.3']], dependents: [] }));
    expect(lock.dependencies('p:pnpm:zod4@*')).toEqual(['p:pnpm:zod@4.0.0']);
    expect(lock.hash('p:pnpm:zod4@*')).toBe(sha256({ entries: [], declared: [], dependents: [['x@1.0.0', 'zod@4.0.0']] }));
    // zod@4.0.0 is both a copy of zod and the root's declaration of it: one edge.
    expect(lock.dependencies('p:pnpm:zod@*')).toEqual(['p:pnpm:zod@3.24.3', 'p:pnpm:zod@4.0.0']);
    expect(lock.hash('p:pnpm:zod@*')).toBe(sha256({ entries: ['zod@3.24.3', 'zod@4.0.0'], declared: [['', 'zod@4.0.0']], dependents: [] }));
    expect(lock.locate('zod3', 'src')).toBe('p:npm:node_modules/zod3');
  });

  it('links hash as link:<dir> and have no edges', () => {
    const lock = pnpm(model([['packages/a', [['@acme/b', link('packages/b')]]]], [['x@1.0.0', { deps: [['@acme/b', link('packages/b')]] }]]));
    expect(lock.hash('p:npm:packages/a/node_modules/@acme/b')).toBe('link:packages/b');
    expect(lock.dependencies('p:npm:packages/a/node_modules/@acme/b')).toEqual([]);
    expect(lock.hash('p:pnpm:x@1.0.0')).toBe(sha256({ content: { integrity: 'sha512-x@1.0.0' }, dependencies: { '@acme/b': 'link:packages/b' }, peers: [] }));
    expect(lock.dependencies('p:pnpm:x@1.0.0')).toEqual([]);
    expect(lock.nodes.has('p:pnpm:@acme/b@*')).toBe(false);
    expect(lock.hash('p:pnpm:@acme/b@*')).toBe(sha256({ entries: [], declared: [['packages/a', 'link:packages/b']], dependents: [['x@1.0.0', 'link:packages/b']] }));
    expect(lock.dependencies('p:pnpm:@acme/b@*')).toEqual([]);
    const moved = pnpm(model([['packages/a', [['@acme/b', link('libs/b')]]]], [['x@1.0.0', { deps: [['@acme/b', link('packages/b')]] }]]));
    expect(moved.hash('p:npm:packages/a/node_modules/@acme/b')).toBe('link:libs/b');
  });

  it('unresolved references point at a name node that is in nodes', () => {
    const lock = pnpm(
      model(
        [['', [['prettier', unresolved]]]],
        [
          ['x@1.0.0', { deps: [['zod', unresolved], ['y', entry('y@1.0.0')]] }],
          ['y@1.0.0', {}],
          ['zod@3.0.0', {}],
        ],
      ),
    );
    expect([...lock.nodes.keys()]).toEqual(['p:npm:node_modules/prettier', 'p:pnpm:prettier@*', 'p:pnpm:x@1.0.0', 'p:pnpm:y@1.0.0', 'p:pnpm:zod@*', 'p:pnpm:zod@3.0.0']);
    expect(lock.hash('p:npm:node_modules/prettier')).toBe('prettier@*');
    expect(lock.dependencies('p:npm:node_modules/prettier')).toEqual(['p:pnpm:prettier@*']);
    expect(lock.nodes.get('p:pnpm:prettier@*')).toBe(sha256({ entries: [], declared: [['', 'prettier@*']], dependents: [] }));
    // An unresolved reference names no entry, so the name node does not point at itself.
    expect(lock.dependencies('p:pnpm:prettier@*')).toEqual([]);
    expect(lock.hash('p:pnpm:x@1.0.0')).toBe(sha256({ content: { integrity: 'sha512-x@1.0.0' }, dependencies: { y: 'y@1.0.0', zod: 'zod@*' }, peers: [] }));
    expect(lock.dependencies('p:pnpm:x@1.0.0')).toEqual(['p:pnpm:y@1.0.0', 'p:pnpm:zod@*']);
    expect(lock.nodes.get('p:pnpm:zod@*')).toBe(sha256({ entries: ['zod@3.0.0'], declared: [], dependents: [['x@1.0.0', 'zod@*']] }));
    expect(lock.dependencies('p:pnpm:zod@*')).toEqual(['p:pnpm:zod@3.0.0']);
    // A name node nothing unresolved points at is not in nodes, but hash() computes it.
    expect(lock.nodes.has('p:pnpm:y@*')).toBe(false);
    expect(lock.hash('p:pnpm:y@*')).toBe(sha256({ entries: ['y@1.0.0'], declared: [], dependents: [['x@1.0.0', 'y@1.0.0']] }));
    expect(lock.dependencies('p:pnpm:y@*')).toEqual(['p:pnpm:y@1.0.0']);
  });

  it('answers ⊥ for an empty name node and nothing for a key it does not know', () => {
    const lock = pnpm(model([['', [['foo', entry('foo@1.0.0')]]]], [['foo@1.0.0', {}]]));
    expect(lock.hash('p:pnpm:nope@*')).toBeNull();
    expect(lock.dependencies('p:pnpm:nope@*')).toEqual([]);
    expect(lock.nodes.has('p:pnpm:nope@*')).toBe(false);
    for (const key of ['p:npm:node_modules/nope', 'p:pnpm:foo@2.0.0', 'p:pnpm:#env', 'p:yarn:foo@*', 'f:src/a.ts', 'p:pnpm:foo', '']) {
      expect(lock.hash(key), key).toBeUndefined();
      expect(lock.dependencies(key), key).toEqual([]);
    }
  });

  it('#env has its own hash and no edges', () => {
    const env = { lockfileVersion: '9.0', importers: { '.': { configDependencies: { '@pnpm/x': '1.0.0' } } } };
    const importers: readonly (readonly [string, Declared])[] = [['', [['foo', entry('foo@1.0.0')]]]];
    const entries: readonly (readonly [string, EntrySpec])[] = [['foo@1.0.0', {}]];
    const lock = pnpm(model(importers, entries, env));
    expect(lock.nodes.get('p:pnpm:#env')).toBe(sha256(env));
    expect(lock.hash('p:pnpm:#env')).toBe(sha256(env));
    expect(lock.dependencies('p:pnpm:#env')).toEqual([]);
    for (const key of lock.nodes.keys()) {
      expect(lock.dependencies(key), key).not.toContain('p:pnpm:#env');
    }
    const bumped = pnpm(model(importers, entries, { ...env, lockfileVersion: '9.1' }));
    expect(bumped.hash('p:pnpm:#env')).not.toBe(lock.hash('p:pnpm:#env'));
    const others = (l: Lockfile): [string, string | null][] => [...l.nodes].filter(([key]) => key !== 'p:pnpm:#env');
    expect(others(bumped)).toEqual(others(lock));
    const none = pnpm(model(importers, entries, null));
    expect(none.nodes.has('p:pnpm:#env')).toBe(false);
    expect(others(none)).toEqual(others(lock));
  });

  it('prototype names work end to end', () => {
    const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort(compareStrings);
    const build = (target: string): Lockfile =>
      pnpm(
        model(
          [
            ['', [['__proto__', entry('__proto__@1.0.0')], ['constructor', unresolved]]],
            ['hasOwnProperty', [['toString', entry('toString@1.0.0')]]],
          ],
          [
            ['__proto__@1.0.0', {}],
            ['__proto__@2.0.0', {}],
            ['toString@1.0.0', { deps: [['__proto__', entry(target)]], peers: ['valueOf'] }],
          ],
        ),
      );
    const lock = build('__proto__@2.0.0');
    expect([...lock.nodes.keys()]).toEqual([
      'p:npm:hasOwnProperty/node_modules/toString',
      'p:npm:node_modules/__proto__',
      'p:npm:node_modules/constructor',
      'p:pnpm:__proto__@1.0.0',
      'p:pnpm:__proto__@2.0.0',
      'p:pnpm:constructor@*',
      'p:pnpm:toString@1.0.0',
      'p:pnpm:valueOf@*',
    ]);
    expect(lock.hash('p:npm:node_modules/__proto__')).toBe('__proto__@1.0.0');
    expect(lock.dependencies('p:npm:node_modules/__proto__')).toEqual(['p:pnpm:__proto__@1.0.0']);
    expect(lock.hash('p:npm:node_modules/constructor')).toBe('constructor@*');
    expect(lock.nodes.get('p:pnpm:constructor@*')).toBe(sha256({ entries: [], declared: [['', 'constructor@*']], dependents: [] }));
    expect(lock.hash('p:pnpm:toString@1.0.0')).toBe(
      sha256({ content: { integrity: 'sha512-toString@1.0.0' }, dependencies: Object.fromEntries([['__proto__', '__proto__@2.0.0']]), peers: ['valueOf'] }),
    );
    // The dependency named __proto__ is in the hash: re-pointing it changes the entry.
    expect(build('__proto__@1.0.0').hash('p:pnpm:toString@1.0.0')).not.toBe(lock.hash('p:pnpm:toString@1.0.0'));
    expect(lock.dependencies('p:pnpm:toString@1.0.0')).toEqual(['p:pnpm:__proto__@2.0.0', 'p:pnpm:valueOf@*']);
    expect(lock.nodes.get('p:pnpm:valueOf@*')).toBeNull();
    expect(lock.hash('p:pnpm:__proto__@*')).toBe(
      sha256({
        entries: ['__proto__@1.0.0', '__proto__@2.0.0'],
        declared: [['', '__proto__@1.0.0']],
        dependents: [['toString@1.0.0', '__proto__@2.0.0']],
      }),
    );
    expect(lock.dependencies('p:pnpm:__proto__@*')).toEqual(['p:pnpm:__proto__@1.0.0', 'p:pnpm:__proto__@2.0.0']);
    expect(lock.hash('p:pnpm:hasOwnProperty@*')).toBeNull();
    expect(lock.hash('p:pnpm:toString@*')).not.toBeNull();
    expect(lock.locate('__proto__', 'src')).toBe('p:npm:node_modules/__proto__');
    expect(lock.locate('toString', 'hasOwnProperty/src')).toBe('p:npm:hasOwnProperty/node_modules/toString');
    expect(lock.locate('constructor', 'hasOwnProperty')).toBe('p:pnpm:constructor@*');
    expect(lock.locate('toString', 'src')).toBe('p:pnpm:toString@*');
    expect(lock.locate('hasOwnProperty', 'src')).toBeNull();
    expect(lock.locate('valueOf', 'src')).toBeNull();
    expect(Object.getOwnPropertyNames(Object.prototype).sort(compareStrings)).toEqual(prototypeKeys);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe('the order a model was built in', () => {
  const NAMES = ['a', '@s/b', '__proto__', 'constructor'];
  const IDS = NAMES.flatMap((name) => [`${name}@1.0.0`, `${name}@2.0.0(a@1.0.0)`]);
  const DIRS = ['', 'packages/a', 'packages/a/x', 'packages/ab'];

  interface Spec {
    importers: (readonly [string, Declared])[];
    entries: (readonly [string, EntrySpec])[];
    env: unknown;
  }

  const specArb: fc.Arbitrary<Spec> = fc.uniqueArray(fc.constantFrom(...IDS), { maxLength: 6 }).chain((ids) => {
    const refArb: fc.Arbitrary<Ref> = fc.oneof(
      fc.constantFrom(...DIRS).map(link),
      fc.constant(unresolved),
      ...(ids.length === 0 ? [] : [fc.constantFrom(...ids).map(entry)]),
    );
    const declaredArb = fc.uniqueArray(fc.tuple(fc.constantFrom(...NAMES), refArb), { maxLength: 3, selector: ([name]) => name });
    const entryArb = fc.record({ content: fc.constantFrom('x', 'y'), deps: declaredArb, peers: fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: 2 }) });
    return fc.record({
      importers: fc.uniqueArray(fc.tuple(fc.constantFrom(...DIRS), declaredArb), { maxLength: 3, selector: ([dir]) => dir }),
      entries: fc.array(entryArb, { minLength: ids.length, maxLength: ids.length }).map((specs) => specs.map((spec, i) => [ids[i]!, spec] as const)),
      env: fc.constantFrom(null, { lockfileVersion: '9.0' }),
    });
  });

  const reversed = (spec: Spec): Spec => ({
    importers: spec.importers.map(([dir, declared]) => [dir, [...declared].reverse()] as const).reverse(),
    entries: spec.entries.map(([id, e]) => [id, { ...e, deps: [...(e.deps ?? [])].reverse(), peers: [...(e.peers ?? [])].reverse() }] as const).reverse(),
    env: spec.env,
  });

  const build = (spec: Spec): Lockfile => pnpm(model(spec.importers, spec.entries, spec.env));

  const observe = (lock: Lockfile): unknown => {
    const keys = [...lock.nodes.keys(), ...NAMES.map((name) => `p:pnpm:${name}@*`)];
    return {
      nodes: [...lock.nodes],
      keys: keys.map((key) => [key, lock.hash(key), lock.dependencies(key)]),
      locate: [...DIRS, 'packages/a/x/y', 'other'].map((dir) => NAMES.map((name) => lock.locate(name, dir))),
    };
  };

  it('nodes and dependencies do not depend on the order the model was built in', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const forward = build(spec);
        expect(observe(build(reversed(spec)))).toEqual(observe(forward));
        const keys = [...forward.nodes.keys()];
        expect(keys).toEqual([...keys].sort(compareStrings));
        for (const key of [...keys, ...NAMES.map((name) => `p:pnpm:${name}@*`)]) {
          const deps = forward.dependencies(key);
          expect(deps).toEqual([...new Set(deps)].sort(compareStrings));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('every edge ends at a key the lockfile can hash', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const lock = build(spec);
        for (const key of [...lock.nodes.keys(), ...NAMES.map((name) => `p:pnpm:${name}@*`)]) {
          for (const target of lock.dependencies(key)) {
            expect(lock.hash(target), `${key} → ${target}`).not.toBeUndefined();
            // Stronger: a target is a node the lockfile lists, so a planner that walks nodes reaches it.
            expect(lock.nodes.has(target), `${key} → ${target}`).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a key with the same hash in two lockfiles has the same dependencies in both (§6.3)', () => {
    fc.assert(
      fc.property(specArb, specArb, (left, right) => {
        const a = build(left);
        const b = build(right);
        const keys = new Set([...a.nodes.keys(), ...b.nodes.keys(), ...NAMES.map((name) => `p:pnpm:${name}@*`)]);
        for (const key of keys) {
          const hash = a.hash(key);
          if (hash !== undefined && hash === b.hash(key)) {
            expect(a.dependencies(key), key).toEqual(b.dependencies(key));
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('modelProblem', () => {
  const ok = (extra: Partial<ResolvedModel> = {}): ResolvedModel => ({ ...model([['', [['a', entry('a@1.0.0')]]], ['packages/a', [['b', link('packages/b')]]]], [['a@1.0.0', { deps: [['c', entry('c@1.0.0')]] }], ['c@1.0.0', {}]]), ...extra });

  it('is null for a clean model', () => {
    expect(modelProblem(ok())).toBeNull();
    expect(modelProblem(model([], []))).toBeNull();
  });

  it.each([
    ['an id that contains @*', 'foo@*'],
    ['an id that contains @* after a version', 'foo@1.0.0(bar@*)'],
    ['the id #env', '#env'],
  ])('refuses %s, and names it', (_title, id) => {
    expect(modelProblem(model([], [[id, {}]]))).toContain(JSON.stringify(id));
  });

  it.each(['.', '/a', 'a/', 'a//b', '/'])('refuses the importer directory %j, and names it', (dir) => {
    expect(modelProblem(model([[dir, []]], []))).toContain(JSON.stringify(dir));
  });

  it('accepts the root and nested directories', () => {
    expect(modelProblem(model([['', []], ['packages/@s/a', []]], []))).toBeNull();
  });

  it('refuses an importer reference to a missing entry, and names it', () => {
    expect(modelProblem(model([['', [['a', entry('a@9.9.9')]]]], [['a@1.0.0', {}]]))).toContain('a@9.9.9');
  });

  it('refuses an entry dependency on a missing entry, and names it', () => {
    expect(modelProblem(model([], [['a@1.0.0', { deps: [['b', entry('b@9.9.9')]] }]]))).toContain('b@9.9.9');
  });

  it('does not mind links and unresolved references', () => {
    expect(modelProblem(model([['', [['a', link('nowhere')], ['b', unresolved]]]], [['x@1.0.0', { deps: [['y', unresolved], ['z', link('q')]] }]]))).toBeNull();
  });
});

describe('nameOfId', () => {
  it.each([
    ['@babel/code-frame@npm:7.29.7', '@babel/code-frame'],
    ['fsevents@patch:fsevents@npm%3A2.3.3#~builtin<compat/fsevents>::version=2.3.3&hash=df0bf1', 'fsevents'],
    ['zod443@https://registry.npmjs.org/zod/-/zod-4.4.3.tgz', 'zod443'],
    ['@vitest/coverage-v8@5.0.1(vitest@5.0.1)', '@vitest/coverage-v8'],
    ['foo@1.0.0', 'foo'],
    ['@scope/x@workspace:packages/x', '@scope/x'],
    ['__proto__@1.0.0', '__proto__'],
    ['plain', 'plain'],
    ['@scope/x', '@scope/x'],
    ['@scope', '@scope'],
  ])('%s → %s', (id, name) => {
    expect(nameOfId(id)).toBe(name);
  });
});

describe('lookupKey', () => {
  it('is node_modules/<name> at the root and <dir>/node_modules/<name> elsewhere', () => {
    expect(lookupKey('', 'vitest')).toBe('p:npm:node_modules/vitest');
    expect(lookupKey('packages/a', '@acme/b')).toBe('p:npm:packages/a/node_modules/@acme/b');
    expect(lookupKey('packages/@scope/b', 'x')).toBe('p:npm:packages/@scope/b/node_modules/x');
  });
});
