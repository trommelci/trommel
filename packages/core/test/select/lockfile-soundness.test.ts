// The lockfile soundness property (spec 2026-11-15-pnpm-yarn-lockfiles §9.2, DECISIONS 36). A random
// install in each layout is written out at S and, after one or two edits, at H; the plan from S's
// map must select every test whose loaded packages differ, as an oracle that walks the placed
// install finds them (./install-tree.ts). That oracle never reads a lockfile and never calls
// `locate`, so a wrong lookup in the model shows as a miss.
//
// The allowed misses are the two residual cases of §6.4 (ruling R9), counted apart and printed:
// hoisting, for a reason two or more steps away, moved the copy that Node finds by position for
// - a name the test's own workspace package does not declare, or
// - in Berry's node-modules layout, an unmet peer: one the package's parent does not provide;
// while that name's node did not change. Any other miss fails.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildStaticMap, readLockfile, type StaticInput, type TrommelMap } from '../../src/graph/static.ts';
import { selectStatic, type HeadState, type Selection } from '../../src/select/plan.ts';
import { fakeRepo, type FakeRepo } from '../graph/fake-repo.ts';
import { importerOf, installPairArb, loads, loadsThrough, loadsWithoutUnmetPeers, TESTS, writeRepo, type Install, type Layout } from './install-tree.ts';

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

type Residual = 'undeclared' | 'unmet-peer';

/**
 * Which residual case of spec §6.4 a missed test is, or null for any other miss. The declarations,
 * the parents and the positions come from the generated install; a name node's hash is the one thing
 * read from the lockfiles.
 * - undeclared: every item that differs is reached only through names the test's own importer
 *   declares at neither S nor H, and each such name's node has the same hash at S and at H.
 * - unmet-peer (berry-node-modules only): every item that differs is reached only through peers that
 *   the package's parent does not provide, and that Node so finds by position, each with a name node
 *   of the same hash at S and at H. Such an item is in neither side's loads without those peers.
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
  const through = [...loadsThrough(s, layout, test), ...loadsThrough(h, layout, test)];
  const before = new Set(loads(s, layout, test));
  const after = new Set(loads(h, layout, test));
  const differing = [...[...before].filter((item) => !after.has(item)), ...[...after].filter((item) => !before.has(item))];
  if (
    differing.every((item) =>
      through
        .filter(([, items]) => items.includes(item))
        .every(([name]) => !s.importers.get(importer)!.has(name) && !h.importers.get(importer)!.has(name) && unchanged(name)),
    )
  ) {
    return 'undeclared';
  }
  if (layout === 'berry-node-modules') {
    const peers = new Set([...s.universe.values(), ...h.universe.values()].flatMap((version) => (version.peer === null ? [] : [version.peer])).filter(unchanged));
    const exact = new Set([...loadsWithoutUnmetPeers(s, layout, test, peers), ...loadsWithoutUnmetPeers(h, layout, test, peers)]);
    if (differing.every((item) => !exact.has(item))) {
      return 'unmet-peer';
    }
  }
  return null;
}

describe.each(LAYOUTS)('lockfile soundness, %s (property)', (layout) => {
  it('selects every test whose loaded packages changed', { timeout: 120_000 }, () => {
    const residuals: Record<Residual, number> = { undeclared: 0, 'unmet-peer': 0 };
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
    console.log(`lockfile soundness, ${layout}: residual misses of spec §6.4 in ${RUNS} runs: ${residuals.undeclared} through an undeclared name, ${residuals['unmet-peer']} through an unmet peer`);
  });
});
