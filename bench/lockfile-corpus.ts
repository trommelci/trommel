#!/usr/bin/env node
// The corpus check of the pnpm and yarn lockfile design (spec 2026-11-15-pnpm-yarn-lockfiles §9.4, DECISIONS 37) on one
// cloned repository. Correctness lives in the test suite; this measures what the readers and the planner do on a real
// year of history.
//
//   node bench/lockfile-corpus.ts <clone> [--since <date>] [--rev <rev>]
//
// Over the first-parent history of <rev> (default HEAD) since <date> (default 12 months before <rev>'s commit date):
//   1. every commit that changed a root lockfile has its lockfile read as the builder reads it (`readLockfile`, with
//      classic yarn's workspace from the members' package.json files), and each refusal is listed with its reason;
//   2. every lockfile-only commit (one whose diff from its first parent touches root lockfiles and nothing else) is
//      planned as CI plans it: `trommel graph --rev <parent>`, then `trommel plan --shadow --static --head <commit>`,
//      in this process. Each plan is counted by outcome: tests selected through changed packages, L1 at the root
//      (with the cause), L1 in a package, L3, or nothing selected;
//   3. every dependency commit (root lockfiles and package.json files, nothing else) is planned the same way, since
//      that is what most dependency bumps look like, and the spec's lockfile-only commits can be rare.
// The clone is read only through git. Prints canonical JSON; record results under bench/results/.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { canonicalJsonPretty, GitVfs, LOCKFILE_PATHS, lsTree, readLockfile, TreeIndex } from '@trommel/core';

import { run } from '../packages/cli/src/cli.ts';

const args = process.argv.slice(2);
const repo = args[0] === undefined || args[0].startsWith('--') ? undefined : resolve(args[0]);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
if (repo === undefined) {
  process.stderr.write('usage: node bench/lockfile-corpus.ts <clone> [--since <date>] [--rev <rev>]\n');
  process.exit(2);
}

const git = (...gitArgs: string[]): string => execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
const lines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

const head = git('rev-parse', '--verify', `${option('--rev') ?? 'HEAD'}^{commit}`);
const headDate = new Date(git('show', '-s', '--format=%cI', head));
const since = option('--since') ?? new Date(Date.UTC(headDate.getUTCFullYear() - 1, headDate.getUTCMonth(), headDate.getUTCDate())).toISOString().slice(0, 10);
const started = performance.now();

// Newest first, as git lists them; reported oldest first.
const touching = lines(git('log', '--first-parent', `--since=${since}`, '--format=%H', head, '--', ...LOCKFILE_PATHS)).reverse();

interface Read {
  readonly commit: string;
  readonly state: string;
  readonly reason?: string;
}
const reads: Read[] = [];
for (const commit of touching) {
  const index = TreeIndex.build(await lsTree(repo, commit));
  const state = readLockfile(await GitVfs.load(repo, index));
  reads.push(
    state.kind === 'parsed'
      ? { commit, state: `${state.lockfile.kind} ${state.lockfile.path}` }
      : state.kind === 'unparseable'
        ? { commit, state: `unparseable ${state.paths.join(', ')}`, reason: state.reason }
        : { commit, state: 'none' },
  );
}

// A lockfile-only commit touches root lockfiles and nothing else; a dependency commit touches root lockfiles and
// package.json files and nothing else, at least one of each, which is what most dependency bumps look like.
const isPackageJson = (path: string): boolean => path === 'package.json' || path.endsWith('/package.json');
const kinds = new Map<string, 'lockfile-only' | 'dependency' | 'other'>();
for (const commit of touching) {
  const parent = git('rev-parse', `${commit}^1`);
  const changed = lines(git('diff-tree', '-r', '--no-commit-id', '--name-only', parent, commit));
  const lockfiles = changed.filter((path) => LOCKFILE_PATHS.includes(path));
  const manifests = changed.filter(isPackageJson);
  kinds.set(
    commit,
    lockfiles.length === changed.length ? 'lockfile-only' : lockfiles.length + manifests.length === changed.length && manifests.length > 0 ? 'dependency' : 'other',
  );
}
const lockfileOnly = touching.filter((commit) => kinds.get(commit) === 'lockfile-only');
const dependency = touching.filter((commit) => kinds.get(commit) === 'dependency');

interface PlanJson {
  readonly fallback?: string;
  readonly escalations: readonly { readonly level: string; readonly cause: string; readonly scope?: string }[];
  readonly changed: readonly string[];
  readonly affected: readonly { readonly test: string; readonly path: readonly string[] }[];
  readonly forced: readonly { readonly test: string; readonly reason: string }[];
  readonly wouldSkip: readonly unknown[];
  readonly run: readonly string[];
}

async function cli(argv: string[]): Promise<string> {
  let out = '';
  let err = '';
  const status = await run(argv, { cwd: repo!, env: {}, stdout: (text) => (out += text), stderr: (text) => (err += text) });
  if (status !== 0) {
    throw new Error(`trommel ${argv.join(' ')} exited ${status}: ${err.trim()}`);
  }
  return out;
}

interface Planned {
  readonly commit: string;
  readonly outcome: string;
  readonly tests: number;
  readonly changedPackages: readonly string[];
  readonly selected: number;
  readonly throughPackages: number;
  readonly throughUncertain: number;
  readonly escalations: readonly string[];
  /** Why-paths of selected tests that end at a package node the plan did not report as changed. */
  readonly wrongPaths: number;
}
const scratch = mkdtempSync(join(tmpdir(), 'trommel-lockfile-corpus-'));

/** Plans each commit against a map of its first parent, as CI would on a pull request with that one commit. */
async function planEach(commits: readonly string[]): Promise<Planned[]> {
  const plans: Planned[] = [];
  for (const commit of commits) {
    const parent = git('rev-parse', `${commit}^1`);
    const mapDir = join(scratch, commit.slice(0, 12));
    let plan: PlanJson;
    try {
      await cli(['graph', '--rev', parent, '--out', join(mapDir, 'map.smap')]);
      plan = JSON.parse(await cli(['plan', '--shadow', '--static', '--map', mapDir, '--head', commit])) as PlanJson;
    } catch (error) {
      plans.push({ commit, outcome: 'error', tests: 0, changedPackages: [], selected: 0, throughPackages: 0, throughUncertain: 0, escalations: [(error as Error).message], wrongPaths: 0 });
      continue;
    } finally {
      rmSync(mapDir, { recursive: true, force: true });
    }
    const changed = new Set(plan.changed);
    const throughPackages = plan.affected.filter((a) => a.path.at(-1)!.startsWith('p:')).length;
    const throughUncertain = plan.affected.filter((a) => a.path.at(-1)!.startsWith('u:')).length;
    const wrongPaths = plan.affected.filter((a) => a.path.at(-1)!.startsWith('p:') && !changed.has(a.path.at(-1)!)).length;
    const l3 = plan.fallback !== undefined || plan.escalations.some((e) => e.level === 'L3');
    const l1Root = plan.escalations.some((e) => e.level === 'L1' && e.scope === '');
    const l1Package = plan.escalations.some((e) => e.level === 'L1' && e.scope !== '');
    const outcome = l3
      ? 'L3'
      : l1Root
        ? 'L1 at the root'
        : l1Package
          ? 'L1 in a package'
          : throughPackages > 0
            ? 'selected through changed packages'
            : plan.affected.length > 0
              ? 'selected through other changes'
              : 'nothing selected';
    plans.push({
      commit,
      outcome,
      tests: plan.run.length,
      changedPackages: plan.changed.filter((key) => key.startsWith('p:')),
      selected: plan.affected.length + plan.forced.length,
      throughPackages,
      throughUncertain,
      escalations: plan.escalations.map((e) => `${e.level}${e.scope === undefined ? '' : ` (${e.scope === '' ? '.' : e.scope})`}: ${e.cause}`),
      wrongPaths,
    });
  }
  return plans;
}

const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};
const summary = (plans: readonly Planned[]) => ({
  count: plans.length,
  outcomes: tally(plans.map((p) => p.outcome)),
  /** Plans that would run every test, whatever the reason. */
  everyTest: plans.filter((p) => p.tests > 0 && p.selected === p.tests).length,
  rootCauses: tally(plans.flatMap((p) => p.escalations.filter((e) => e.startsWith('L1 (.): ')).map((e) => e.slice('L1 (.): '.length)))),
  wrongPaths: plans.reduce((sum, p) => sum + p.wrongPaths, 0),
  plans,
});

let lockfilePlans: Planned[];
let dependencyPlans: Planned[];
try {
  lockfilePlans = await planEach(lockfileOnly);
  dependencyPlans = await planEach(dependency);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(
  canonicalJsonPretty({
    repository: basename(repo),
    head,
    since,
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version },
    seconds: Math.round((performance.now() - started) / 100) / 10,
    lockfileVersions: {
      commits: reads.length,
      states: tally(reads.map((r) => r.state)),
      refusals: reads.filter((r) => r.reason !== undefined),
    },
    commitsByKind: tally([...kinds.values()]),
    lockfileOnlyCommits: summary(lockfilePlans),
    dependencyCommits: summary(dependencyPlans),
  }),
);
