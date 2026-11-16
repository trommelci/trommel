// The lockfile soundness property (spec 2026-11-15-pnpm-yarn-lockfiles §9.2, DECISIONS 36). A random
// install in each layout is written out at S and, after one or two edits, at H; the plan from S's
// map must select every test whose loaded packages differ, as an oracle that walks the placed
// install finds them (./install-tree.ts). That oracle never reads a lockfile and never calls
// `locate`, so a wrong lookup in the model shows as a miss.
//
// The allowed misses are the two residual cases of §6.4 (rulings R9 and R11): hoisting, for a
// reason two or more steps away, moved the copy that Node finds by position for
// - a name the test's own workspace package does not declare, or
// - in Berry's node-modules layout, an unmet peer: one the package's parent does not provide;
// while that name's node did not change. A missed test is exempt when every path to every item that
// differs crosses such an edge, of either case or of both; it is counted by which cases it needs,
// and the counts are printed. Any other miss fails.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildStaticMap, readLockfile, type StaticInput, type TrommelMap } from '../../src/graph/static.ts';
import { selectStatic, type HeadState, type Selection } from '../../src/select/plan.ts';
import { fakeRepo, type FakeRepo } from '../graph/fake-repo.ts';
import { importerOf, installPairArb, loads, loadsWithout, TESTS, writeRepo, type Exempt, type Install, type Layout } from './install-tree.ts';

// The planner helpers of plan.test.ts.
const isTest = (path: string) => /\.test\.[jt]s$/.test(path);

function mapOf(repo: FakeRepo, options: Partial<StaticInput> = {}): TrommelMap {
  return buildStaticMap({ objectFormat: 'sha1', index: repo.index, vfs: repo.vfs, sources: repo.sources, tests: repo.vfs.files().filter(isTest), ...options });
}

function headOf(repo: FakeRepo, options: Partial<HeadState> = {}): HeadState {
  return { objectFormat: 'sha1', index: repo.index, vfs: repo.vfs, tests: repo.vfs.files().filter(isTest), config: null, ...options };
}

const selected = (selection: Selection) => [...selection.affected.map((a) => a.test), ...selection.forced.map((f) => f.test)].sort();

const RUNS = 700;
const LAYOUTS: readonly Layout[] = ['pnpm', 'berry-node-modules', 'berry-pnp', 'classic'];
const KINDS: Readonly<Record<Layout, string>> = { pnpm: 'pnpm', 'berry-node-modules': 'yarn-berry', 'berry-pnp': 'yarn-berry', classic: 'yarn-classic' };

type Residual = 'undeclared' | 'unmet-peer' | 'mixed';

/**
 * Which residual case of spec §6.4 a missed test is (ruling R11), or null for any other miss. An
 * item that differs is exempt when every path from the test to it, in the oracle's walk, crosses an
 * exempt edge, so that it is in neither side's `loadsWithout`. The exempt edges are
 * - the test's import of a name its own importer declares at neither S nor H, and
 * - in berry-node-modules, a peer that the package's parent does not provide, found by position;
 * each only when the name's node has the same hash at S and at H. The test is exempt when every
 * item that differs is: by undeclared imports alone, by unmet peers alone, or only by the two
 * together. Declarations, parents and positions come from the generated install; the lockfiles are
 * read for the name-node hashes and nothing else.
 */
function residualCase(layout: Layout, s: Install, h: Install, sRepo: FakeRepo, hRepo: FakeRepo, test: string): Residual | null {
  const sLock = readLockfile(sRepo.vfs);
  const hLock = readLockfile(hRepo.vfs);
  if (sLock.kind !== 'parsed' || hLock.kind !== 'parsed') {
    return null;
  }
  const prefix = layout === 'pnpm' ? 'p:pnpm:' : 'p:yarn:';
  const unchanged = (name: string): boolean => sLock.lockfile.hash(`${prefix}${name}@*`) === hLock.lockfile.hash(`${prefix}${name}@*`);
  const importer = importerOf(s, test);
  const imports = new Set((s.tests.get(test) ?? []).filter((name) => !s.importers.get(importer)!.has(name) && !h.importers.get(importer)!.has(name) && unchanged(name)));
  const unmetPeers = new Set(
    layout === 'berry-node-modules' ? [...s.universe.values(), ...h.universe.values()].flatMap((version) => (version.peer === null ? [] : [version.peer])).filter(unchanged) : [],
  );
  const before = new Set(loads(s, layout, test));
  const after = new Set(loads(h, layout, test));
  const differing = [...[...before].filter((item) => !after.has(item)), ...[...after].filter((item) => !before.has(item))];
  const exempt = (edges: Exempt): boolean => {
    const exact = new Set([...loadsWithout(s, layout, test, edges), ...loadsWithout(h, layout, test, edges)]);
    return differing.every((item) => !exact.has(item));
  };
  const none = new Set<string>();
  if (exempt({ imports, unmetPeers: none })) {
    return 'undeclared';
  }
  if (exempt({ imports: none, unmetPeers })) {
    return 'unmet-peer';
  }
  return exempt({ imports, unmetPeers }) ? 'mixed' : null;
}

describe.each(LAYOUTS)('lockfile soundness, %s (property)', (layout) => {
  it('selects every test whose loaded packages changed', { timeout: 120_000 }, () => {
    const residuals: Record<Residual, number> = { undeclared: 0, 'unmet-peer': 0, mixed: 0 };
    fc.assert(
      fc.property(installPairArb(layout), ({ s, h }) => {
        const sRepo = fakeRepo(writeRepo(s, layout));
        const hRepo = fakeRepo(writeRepo(h, layout));
        const map = mapOf(sRepo);
        const selection = selectStatic(map, headOf(hRepo), {});
        // Both lockfiles were read, or the plan would run everything and prove nothing: S's kind is
        // in its map, and an H lockfile that changed and cannot be read is an L3.
        expect(map.lockfile.kind).toBe(KINDS[layout]);
        expect(selection.escalations.filter((escalation) => escalation.level === 'L3')).toEqual([]);
        const chosen = new Set(selected(selection));
        const otherMisses: { test: string; s: readonly string[]; h: readonly string[] }[] = [];
        const found: Residual[] = [];
        for (const test of TESTS) {
          const before = loads(s, layout, test);
          const after = loads(h, layout, test);
          if (chosen.has(test) || before.join('\n') === after.join('\n')) {
            continue;
          }
          const residual = residualCase(layout, s, h, sRepo, hRepo, test);
          if (residual === null) {
            otherMisses.push({ test, s: before, h: after });
          } else {
            found.push(residual);
          }
        }
        expect(otherMisses).toEqual([]);
        for (const residual of found) {
          residuals[residual]++;
        }
      }),
      { numRuns: RUNS },
    );
    console.log(
      `lockfile soundness, ${layout}: residual misses of spec §6.4 in ${RUNS} runs: ${residuals.undeclared} by undeclared imports only, ${residuals['unmet-peer']} by unmet peers only, ${residuals.mixed} only by both`,
    );
  });
});
