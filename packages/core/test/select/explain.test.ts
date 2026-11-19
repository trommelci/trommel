import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { forwardReach, forwardTree, whyPath } from '../../src/graph/graph.ts';
import { mapGraph } from '../../src/graph/map.ts';
import type { StaticInput } from '../../src/graph/static.ts';
import { explainTest, type Explanation } from '../../src/select/explain.ts';
import { runAll, selectStatic, type HeadState, type PlanRules, type Selection } from '../../src/select/plan.ts';
import { fakeRepo } from '../graph/fake-repo.ts';
import { headOf, mapOf, materialize, PATHS, randomRepo, type Files } from './repos.ts';

const LOCK = (lodash: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4', integrity: lodash } } });

const BASE: Files = {
  'package.json': '{"name":"app"}',
  'package-lock.json': LOCK('sha512-1'),
  'README.md': 'hello\n',
  'src/a.ts': "import { b } from './b';\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/c.ts': "import _ from 'lodash';\n",
  'test/a.test.ts': "import '../src/a';\n",
  'test/c.test.ts': "import '../src/c';\n",
  'test/ac.test.ts': "import '../src/a';\nimport '../src/c';\n",
  'test/plain.test.ts': '',
};

function explain(base: Files, head: Files, test: string, rules: PlanRules = {}, to?: string, mapOptions: Partial<StaticInput> = {}, headOptions: Partial<HeadState> = {}) {
  const map = mapOf(fakeRepo(base), mapOptions);
  const selection = selectStatic(map, headOf(fakeRepo(head), headOptions), rules);
  const graph = mapGraph(map);
  return { map, graph, selection, explanation: explainTest(selection, test, { map, graph }, to) };
}

const EDITED: Files = { ...BASE, 'src/b.ts': 'export const b = 2;\n', 'package-lock.json': LOCK('sha512-2') };
const A_TO_B = ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts'];

describe('explainTest', () => {
  it('lists every seed an affected test reaches, sorted, each with a shortest path', () => {
    const { explanation } = explain(BASE, EDITED, 'test/ac.test.ts');
    expect(explanation.verdict).toBe('affected');
    expect(explanation.seeds!.map((s) => s.node)).toEqual(['f:src/b.ts', 'p:npm:node_modules/lodash']);
    expect(explanation.seeds![0]!.path).toEqual(['f:test/ac.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts']);
    expect(explanation.seeds![1]!.path.slice(-2)).toEqual(['f:src/c.ts', 'p:npm:node_modules/lodash']);
    expect(explanation.seeds![1]).not.toHaveProperty('causes');
  });

  it("uses the plan's own why-path for the seed the plan names", () => {
    const { explanation, selection } = explain(BASE, EDITED, 'test/ac.test.ts');
    const planned = selection.affected.find((a) => a.test === 'test/ac.test.ts')!.path;
    expect(explanation.path).toEqual(planned);
    expect(explanation.seeds!.find((s) => s.node === planned.at(-1))!.path).toEqual(planned);
  });

  it('shows the path the plan gave, not the tree\'s own, when two shortest paths tie', () => {
    // Forward from the test the tie goes through y, backward from the seed through z.
    const tie: Files = {
      'package.json': '{"name":"a"}',
      'src/z.ts': "import './m';\n",
      'src/y.ts': "import './n';\n",
      'src/m.ts': "import './s';\n",
      'src/n.ts': "import './s';\n",
      'src/s.ts': '1',
      'test/t.test.ts': "import '../src/z';\nimport '../src/y';\n",
    };
    const { explanation, selection, graph } = explain(tie, { ...tie, 'src/s.ts': '2' }, 'test/t.test.ts');
    const planned = selection.affected[0]!.path;
    expect(planned[1]).toBe('r:src/z');
    expect(whyPath(forwardTree(graph, graph.id('f:test/t.test.ts')!), graph.id('f:src/s.ts')!)!.map((n) => graph.name(n))[1]).toBe('r:src/y');
    expect(explanation.seeds).toEqual([{ node: 'f:src/s.ts', path: planned }]);
  });

  it('carries the causes of an uncertain seed', () => {
    const files: Files = { ...BASE, 'src/u.ts': 'await import(name);\n', 'test/u.test.ts': "import '../src/u';\n" };
    const { explanation, map } = explain(files, files, 'test/u.test.ts');
    expect(explanation.verdict).toBe('affected');
    const seed = explanation.seeds!.find((s) => s.node === 'u:src/u.ts')!;
    expect(seed.causes).toEqual(map.uncertain['u:src/u.ts']);
    expect(seed.causes!.length).toBeGreaterThan(0);
    expect(seed.path.at(-1)).toBe('u:src/u.ts');
  });

  describe('forced', () => {
    it('says why a new test is forced, in the plan\'s words, with no dependsOn', () => {
      const head = { ...BASE, 'test/new.test.ts': '' };
      const { explanation } = explain(BASE, head, 'test/new.test.ts');
      expect(explanation).toEqual({ test: 'test/new.test.ts', verdict: 'forced', reason: 'new test file' });
    });

    it('says alwaysRun, and still counts what the test depends on', () => {
      const { explanation } = explain(BASE, BASE, 'test/plain.test.ts', { alwaysRun: ['test/plain.*'] });
      expect(explanation).toMatchObject({ verdict: 'forced', reason: 'alwaysRun' });
      expect(explanation.dependsOn).toBeDefined();
      expect(explanation).not.toHaveProperty('seeds');
    });

    it('gives an L1 test the reason and path the plan gave it', () => {
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
      };
      const { explanation, selection } = explain(WORKSPACES, { ...WORKSPACES, 'pkgs/db/migrations/001.sql': 'create table u ();\n' }, 'pkgs/api/test/api.test.ts');
      const planned = selection.forced.find((f) => f.test === 'pkgs/api/test/api.test.ts')!;
      expect(planned.path).toBeDefined();
      expect(explanation.verdict).toBe('forced');
      expect(explanation.reason).toBe(planned.reason);
      expect(explanation.path).toEqual(planned.path);
    });
  });

  it('explains a run-all plan without a map', () => {
    expect(explainTest(runAll(['t.test.ts'], 'no map at x/map.smap'), 't.test.ts', null, 'f:src/b.ts')).toEqual({
      test: 't.test.ts',
      verdict: 'forced',
      reason: 'L3: no map at x/map.smap',
      to: { node: 'f:src/b.ts', status: 'no map' },
    });
  });

  it('says a would-skip reaches nothing that changed', () => {
    const { explanation, graph } = explain(BASE, { ...BASE, 'README.md': 'edited\n' }, 'test/c.test.ts', { ignore: ['README.md'] });
    expect(explanation.verdict).toBe('would-skip');
    expect(explanation).not.toHaveProperty('seeds');
    const reach = forwardReach(graph, [graph.id('f:test/c.test.ts')!]);
    expect(explanation.dependsOn).toBe(reach.reduce((sum, flag) => sum + flag, 0) - 1);
    expect(explanation.dependsOn).toBeGreaterThan(0);
  });

  it('answers --to: reached, not reached, not in the map, test not in the map', () => {
    const head = { ...BASE, 'test/new.test.ts': '' };
    expect(explain(BASE, head, 'test/a.test.ts', {}, 'f:src/b.ts').explanation.to).toEqual({ node: 'f:src/b.ts', status: 'reached', path: A_TO_B });
    expect(explain(BASE, head, 'test/c.test.ts', {}, 'f:src/b.ts').explanation.to).toEqual({ node: 'f:src/b.ts', status: 'not reached' });
    expect(explain(BASE, head, 'test/a.test.ts', {}, 'f:src/zzz.ts').explanation.to).toEqual({ node: 'f:src/zzz.ts', status: 'not in the map' });
    expect(explain(BASE, head, 'test/new.test.ts', {}, 'f:src/b.ts').explanation.to).toEqual({ node: 'f:src/b.ts', status: 'test not in the map' });
  });

  it('rejects a test the plan does not have', () => {
    const { selection, map, graph } = explain(BASE, BASE, 'test/a.test.ts');
    expect(() => explainTest(selection, 'src/a.ts', { map, graph })).toThrow(RangeError);
  });

  it('agrees with selectStatic on random repositories (property)', () => {
    fc.assert(
      fc.property(randomRepo, randomRepo, fc.subarray(PATHS, { minLength: 1, maxLength: 2 }), (s, other, edited) => {
        const h = Object.fromEntries(PATHS.map((path) => [path, edited.includes(path) ? other[path]! : s[path]!]));
        const map = mapOf(fakeRepo(materialize(s)));
        const selection: Selection = selectStatic(map, headOf(fakeRepo(materialize(h))), {});
        const graph = mapGraph(map);
        const seeds = new Set([...selection.changed, ...selection.uncertain]);
        for (const test of selection.tests) {
          const explanation: Explanation = explainTest(selection, test, { map, graph });
          const affected = selection.affected.find((a) => a.test === test);
          const forced = selection.forced.find((f) => f.test === test);
          if (affected !== undefined) {
            expect(explanation.verdict).toBe('affected');
            expect(explanation.path).toEqual(affected.path);
          } else if (forced !== undefined) {
            expect(explanation.verdict).toBe('forced');
            expect(explanation.reason).toBe(forced.reason);
            expect(explanation.path).toEqual(forced.path);
          } else {
            expect(selection.wouldSkip).toContain(test);
            expect(explanation.verdict).toBe('would-skip');
          }
          if (!map.tests.includes(test)) {
            expect(explanation).not.toHaveProperty('dependsOn');
            continue;
          }
          const closure = forwardReach(graph, [graph.id(`f:${test}`)!]);
          expect(explanation.dependsOn).toBe(closure.reduce((sum, flag) => sum + flag, 0) - 1);
          if (affected === undefined) {
            expect(explanation).not.toHaveProperty('seeds');
            continue;
          }
          const expected = [...seeds].filter((key) => closure[graph.id(key)!] === 1).sort();
          expect(explanation.seeds!.map((x) => x.node)).toEqual(expected);
          const tree = forwardTree(graph, graph.id(`f:${test}`)!);
          for (const seed of explanation.seeds!) {
            expect(seed.path[0]).toBe(`f:${test}`);
            expect(seed.path.at(-1)).toBe(seed.node);
            for (let i = 1; i < seed.path.length; i++) {
              expect(Object.hasOwn(map.edges[seed.path[i - 1]!] ?? {}, seed.path[i]!), `${seed.path[i - 1]} -> ${seed.path[i]}`).toBe(true);
            }
            // Shortest: as many edges as the seed's distance from the test.
            expect(seed.path.length - 1, `distance to ${seed.node}`).toBe(whyPath(tree, graph.id(seed.node)!)!.length - 1);
          }
          expect(explanation.seeds!.find((x) => x.node === affected.path.at(-1))!.path).toEqual(affected.path);
        }
      }),
      { numRuns: 500 },
    );
  });
});
