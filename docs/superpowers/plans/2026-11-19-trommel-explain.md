# `trommel explain` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trommel explain <test> [--to <file|node>]` tells a person what the static plan decides for one test file and why, without ever disagreeing with `trommel plan`.

**Architecture:** The CLI loads the head and the map exactly as `plan` does and calls the same `selectStatic`. A new core function, `explainTest`, reads that test's entry from the `Selection` and adds paths from one forward breadth-first search (`forwardTree`) over the map's graph. The planner, the builder, the map and SMAP are untouched.

**Tech Stack:** TypeScript run by Node's type stripping (Node ≥ 22.18), Vitest 5.1, fast-check 4.10, no runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-11-19-trommel-explain-design.md](../specs/2026-11-19-trommel-explain-design.md)

## Global Constraints

- Zero runtime dependencies in `packages/{core,cli,vitest,jest}`; `npm run check:deps` must stay clean.
- `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties; relative imports end in `.ts`; types use `import type`.
- `@types/node` 22: no Node API newer than 22.
- Same input, same bytes out: explicit tie-breaks, canonical JSON for `--json`, no timestamps.
- `packages/core/src/select/plan.ts`, `graph/static.ts`, `graph/map.ts` and `smap/` do not change. The engine stays `trommel-static-4`, and both golden hashes stay as they are.
- `packages/core/src/{graph,select}/**` may not use `process`, `node:os` or `environment.ts` (lint enforces it).
- Paths are POSIX, repository-relative and case-sensitive.
- Property tests are seeded through `vitest.setup.ts` (`TROMMEL_FC_SEED`, default `20261116`).
- Commits: small, conventional, `git commit -s`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Exit codes: 0 for any explanation (a run-all fallback included), 1 when the argument is not a test Trommel plans at the head or lies outside the repository, 2 on a usage error.

## Review Focus

1. **A path typed from a subdirectory** (`cd test && trommel explain a.test.ts`) must mean `test/a.test.ts`, as git would read it. Pinned in Task 3.
2. **Windows short names and symlinked temp directories** (`C:\Users\RUNNER~1\…` on the hosted runner, `/var` → `/private/var` on macOS): the current directory and git's toplevel can name one folder two ways. Both are passed through `realpathSync.native` before `relative`. The Windows CI job exercises it, since the end-to-end repository lives under `tmpdir()`; Task 3 also pins a backslash path on win32.
3. **A path outside the repository** (`../x.test.ts`) must be an error naming the path, exit 1, never a lookup of a nonsense key. Pinned in Task 3.
4. **A name that is not a planned test** (a source file, a deleted test, a typo) must say how many tests Trommel does plan at that revision, exit 1. Pinned in Task 3.
5. **`--json` twice gives the same bytes.** Pinned in Task 3.

---

### Task 1: `forwardTree` in `core/graph`

**Files:**
- Modify: `packages/core/src/graph/graph.ts` (after `forwardReach`)
- Modify: `packages/core/src/index.ts` (the `./graph/graph.ts` export line)
- Test: `packages/core/test/graph/graph.test.ts`

**Interfaces:**
- Produces: `forwardTree(graph: Graph, root: number): Reach`. `reached` is 1 for `root` and everything it depends on, transitively; `parent[v]` is the node one hop closer to `root` (−1 for `root` and unreached nodes); `order` is BFS order, `root` first. `whyPath(tree, v)` then returns the chain `root … v`.

- [ ] **Step 1: Write the failing tests** in `graph.test.ts`:
  - `describe('forwardTree')`, `it('reaches what the root depends on, with a shortest chain to each')`: on `login()`, `forwardTree(graph, id('test/login.test.ts'))` has `names(graph, tree.order)` equal to `['test/login.test.ts', 'src/auth/index.ts', 'src/auth/token.ts', 'src/util.ts']`, `names(graph, whyPath(tree, id('src/util.ts'))!)` equal to `['test/login.test.ts', 'src/auth/index.ts', 'src/auth/token.ts', 'src/util.ts']`, and `whyPath(tree, id('test/other.test.ts'))` is `null`.
  - `it('rejects a root that is not a node')`: `forwardTree(login(), -1)` and `forwardTree(login(), 5)` throw `RangeError`.
  - In `describe('graph properties')`, `it('forwardTree: every chain is a shortest path of real edges from the root')`: for `arbGraph` and every root `r` in `0..n-1` of `build(g)`: `tree.reached` equals `forwardReach(graph, [r])` element for element; for each reached `v`, `whyPath(tree, v)` starts at `r`, ends at `v`, every consecutive pair `(a, b)` has `graph.dependencies(a).includes(b)`, and its length minus 1 equals the distance from an oracle BFS over `g.edges` (layer by layer, mapping labels through `graph.id(label(i))`); for each unreached `v`, `whyPath(tree, v)` is `null`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/core/test/graph/graph.test.ts`
Expected: FAIL, `forwardTree` is not exported.

- [ ] **Step 3: Implement `forwardTree(graph: Graph, root: number): Reach`** in `graph.ts`: the loop of `reverseReach` over `fwdOffsets`/`fwdTargets` with one seed, first discovery wins, neighbours in ascending id order (the CSR order). Same `RangeError` message style as `forwardReach`. Add `forwardTree` to the graph export line of `index.ts`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run packages/core/test/graph/graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Hand mutation.** Break the tie-break (iterate neighbours in descending order) and the parent assignment (set `parent[w] = root`); each must fail a test. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/graph/graph.ts packages/core/src/index.ts packages/core/test/graph/graph.test.ts
git commit -s -m "feat(core): forwardTree, a forward search with parent pointers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: `explainTest` in `core/select`

**Files:**
- Create: `packages/core/src/select/explain.ts`
- Create: `packages/core/test/select/repos.ts` (test helpers moved out of `plan.test.ts`)
- Modify: `packages/core/test/select/plan.test.ts` (import the moved helpers; no other change)
- Modify: `packages/core/src/index.ts` (export the new module)
- Test: `packages/core/test/select/explain.test.ts`

**Interfaces:**
- Consumes: `forwardTree`, `whyPath` (Task 1); `Selection`, `runAll`, `selectStatic` from `select/plan.ts`; `TrommelMap` from `graph/static.ts`; `Graph`.
- Produces, from `select/explain.ts`:

```ts
export type Verdict = 'affected' | 'forced' | 'would-skip';
/** A changed or uncertain node the test reaches, with a shortest path from the test; a u: node carries its causes. */
export interface SeedPath { readonly node: string; readonly path: readonly string[]; readonly causes?: readonly string[] }
export type Target =
  | { readonly node: string; readonly status: 'reached'; readonly path: readonly string[] }
  | { readonly node: string; readonly status: 'not reached' | 'not in the map' | 'test not in the map' | 'no map' };
export interface Explanation {
  readonly test: string;
  readonly verdict: Verdict;
  /** Forced only: the plan's reason, word for word ('new test file', 'alwaysRun', 'L1: …', 'L3: …'). */
  readonly reason?: string;
  /** The plan's own path: an affected test's why-path, or an L1 test's path into the escalated package. */
  readonly path?: readonly string[];
  /** Affected only: every seed the test reaches, sorted by key. */
  readonly seeds?: readonly SeedPath[];
  /** How many nodes the test reaches besides itself; only when the test is one of the map's tests. */
  readonly dependsOn?: number;
  readonly to?: Target;
}
export interface ExplainContext { readonly map: TrommelMap; readonly graph: Graph }
/** Throws RangeError when `test` is not in `selection.tests`. `to` is a node key. */
export function explainTest(selection: Selection, test: string, context: ExplainContext | null, to?: string): Explanation;
```

- Produces, from `test/select/repos.ts`: `isTest`, `mapOf`, `headOf`, `Files` (moved verbatim from the top of `plan.test.ts`), and `PATHS`, `randomRepo` (the `repo` arbitrary) and `materialize` (moved verbatim from the soundness `describe`, with `MODULES`, `TARGETS`, `BARE`, `lockfile`, `OTHER`, `relative`, `line` and `module` as module-level constants). The soundness property keeps its oracle `loads` and must generate the same repositories as before.

- [ ] **Step 1: Move the helpers.** Create `repos.ts`, import them in `plan.test.ts`, and run `npx vitest run packages/core/test/select/plan.test.ts`. Expected: PASS, the same test count as before the move.

- [ ] **Step 2: Write the failing tests** in `explain.test.ts`, with a fixture like `plan.test.ts`'s `BASE` plus `'test/ac.test.ts': "import '../src/a';\nimport '../src/c';\n"`. A helper `explain(base, head, test, rules?, to?)` builds the map with `mapOf`, plans with `selectStatic`, and calls `explainTest(selection, test, { map, graph: mapGraph(map) }, to)`.
  - `it('lists every seed an affected test reaches, sorted, each with a shortest path')`: with `src/b.ts` edited and lodash's integrity bumped, `test/ac.test.ts` is `affected` with `seeds.map((s) => s.node)` equal to `['f:src/b.ts', 'p:npm:node_modules/lodash']`. The path to `f:src/b.ts` is `['f:test/ac.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts']`, and the path to lodash ends `['f:src/c.ts', 'p:npm:node_modules/lodash']`.
  - `it('uses the plan's own why-path for the seed the plan names')`: `explanation.path` equals the selection's `affected` path for the test, and the seed whose `node` is that path's last element has exactly that path.
  - `it('carries the causes of an uncertain seed')`: a test importing a file containing `await import(name);` is `affected` through `u:<file>`, and that seed's `causes` equal `map.uncertain['u:<file>']`.
  - `it('says why a test is forced, in the plan's words')`: `test/new.test.ts` added at the head gives `{ verdict: 'forced', reason: 'new test file' }` with no `dependsOn`; `alwaysRun: ['test/plain.*']` gives `reason: 'alwaysRun'` with `dependsOn` defined; the L1 fixture of `plan.test.ts` ("unmapped inputs") gives `reason` equal to the selection's `forced` reason and `path` equal to its `path`.
  - `it('explains a run-all plan without a map')`: `explainTest(runAll(['t.test.ts'], 'no map at x/map.smap'), 't.test.ts', null, 'f:src/b.ts')` equals `{ test: 't.test.ts', verdict: 'forced', reason: 'L3: no map at x/map.smap', to: { node: 'f:src/b.ts', status: 'no map' } }`.
  - `it('says a would-skip reaches nothing that changed')`: with only `README.md` edited (not in the map, ignored via `{ ignore: ['README.md'] }`), `test/c.test.ts` is `would-skip` with no `seeds`, and `dependsOn` equals `forwardReach(graph, [id]).reduce(sum) - 1`.
  - `it('answers --to: reached, not reached, not in the map, test not in the map')`: `test/a.test.ts` to `f:src/b.ts` is `reached` with the path above; `test/c.test.ts` to `f:src/b.ts` is `not reached`; `test/a.test.ts` to `f:src/zzz.ts` is `not in the map`; the new test to `f:src/b.ts` is `test not in the map`.
  - `it('rejects a test the plan does not have')`: `explainTest(selection, 'src/a.ts', context)` throws `RangeError`.
  - `it('agrees with selectStatic on random repositories (property)')`: `fc.property(randomRepo, randomRepo, fc.subarray(PATHS, { minLength: 1, maxLength: 2 }), …)` building S and H as the soundness property does, `{ numRuns: 500 }`. For every test of the selection: the verdict matches the list it is in (`affected`, `forced` with the same `reason` and `path`, or `wouldSkip`); for an affected test, `seeds` is exactly the members of `changed ∪ uncertain` in the test's forward closure, every seed path is a chain of map edges from `f:<test>` to the seed, and the plan's path appears unchanged; for every test of `map.tests`, `dependsOn` is its closure size minus 1.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run packages/core/test/select/explain.test.ts`
Expected: FAIL, `../../src/select/explain.ts` does not exist.

- [ ] **Step 4: Implement `explainTest`** in `select/explain.ts`. The verdict, reason and plan path come only from `selection`. The tree is `forwardTree(graph, graph.id('f:' + test))`, built only when `context` is not null and `map.tests` includes the test. Seeds are `selection.changed` and `selection.uncertain` filtered by `tree.reached`, sorted with the module's `compareStrings`; each path is `whyPath(tree, id)` mapped through `graph.name`, except the seed the plan's path ends at, which takes the plan's path. Optional fields are left out, never `undefined`. Header comment: it explains the static plan's decision and never makes one. Export the module's types and `explainTest` from `index.ts`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run packages/core/test/select`
Expected: PASS, `plan.test.ts` included.

- [ ] **Step 6: Hand mutation.** Each must fail a test, then restore: always use the tree's path (drop the plan-path substitution); drop the `uncertain` seeds; take the verdict from the tree instead of the selection (affected when any seed is reached); count `dependsOn` with the test itself.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/select/explain.ts packages/core/src/index.ts packages/core/test/select
git commit -s -m "feat(core): explainTest, one test's static plan decision with its paths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The `trommel explain` command

**Files:**
- Modify: `packages/cli/src/args.ts` (the `Command` union, `USAGE`, `parseCommand`)
- Modify: `packages/cli/src/cli.ts` (shared head and plan loading; the `explain` case; header comment)
- Modify: `packages/cli/src/report.ts` (export `readable`; `shown(node, quote = '`')`)
- Create: `packages/cli/src/explain.ts` (argument paths and the text renderer)
- Test: `packages/cli/test/args.test.ts`, `packages/cli/test/explain.test.ts` (renderer unit tests), `packages/cli/test/cli.test.ts` (end to end)

**Interfaces:**
- Consumes: `explainTest`, `Explanation`, `ExplainContext` (Task 2).
- Produces:
  - `Command` gains `{ readonly name: 'explain'; readonly test: string; readonly to: string | null; readonly map: string; readonly head: string; readonly json: boolean }`.
  - `explain.ts`: `repoPath(root: string, cwd: string, arg: string): string` (throws `Error('<arg> is outside the repository')`), `targetNode(arg: string, path: () => string, map: TrommelMap | null): string` (an exact key of `map.nodes`, else `f:` + `path()`), and `explanationText(explanation: Explanation): string`.
  - `cli.ts`: `headAt(io, rev)` returning the snapshot, the config (`{ version: 1 }` when invalid) and the config error as `fallback`; and `planAt(io, head, mapDir)` returning `{ tests, notPlanned, mapPath, smap, selection, fallback? }`, holding the code `plan` has today from `discoverTests` to the internal-error fallback. `plan` calls `headAt`, then `planMode`, then `planAt`; its output is unchanged.

**Text output,** exact copy. `plain(node)` is `shown(node, '')`; a path is rendered as `readable(path).map(plain).join(' → ')`.
- affected: `<test> would run: it reaches <n> changed or uncertain node(s).`, then one line per seed: two spaces and the path, with the last node replaced by `uncertain: <causes joined by '; '>` for a `u:` seed and suffixed ` (changed)` otherwise.
- forced: `<test> would run: <reason>.`, then, when `path` has at least two nodes, two spaces and `through ` with the path from its second node.
- would-skip: `<test> would be skipped (unproven static reachability): none of the <n> node(s) it depends on changed.`
- `to`, one line: reached `Path to <plain(node)>: <path>`; not reached `<test> does not reach <plain(node)> in the map. Static reachability cannot see what a test reads through fs.`; not in the map `<plain(node)> is not in the map.`; test not in the map `<test> is not in the map, so it has no path to <plain(node)>.`; no map `Without a usable map, the path to <plain(node)> is unknown.`
- Last line, always: `Shadow mode runs every test; this is what static selection would do.`

**`--json`:** `canonicalJsonPretty({ version: 1, mode: 'shadow', static: true, base, head, fallback?, explanation })`, with `base` and `head` as in the plan report.

**Paths:** `repoPath` is `relative(realpathSync.native(root), resolve(realpathSync.native(cwd), arg))`, split on `sep` and joined with `/`; empty, `..`, `../…` or absolute results are outside the repository.

- [ ] **Step 1: Write the failing tests.**
  - `args.test.ts`: `parseCommand(['explain', 'test/a.test.ts'])` equals `{ name: 'explain', test: 'test/a.test.ts', to: null, map: '.trommel/map', head: 'HEAD', json: false }`; `--to x --map m --head h --json` fill their fields; no positional and two positionals throw `UsageError` with `explain takes one test file: trommel explain <test>`.
  - `explain.test.ts` (renderer): one case per verdict and per `to` status above, comparing `explanationText` with the exact lines; a hub between two files is hidden, and a hub at the end is shown as `resolution of src/b`.
  - `cli.test.ts`: the `trommel()` helper takes an optional `cwd` (default `repo`). A `describe('trommel explain')` after the fallback tests, on the map of `base` and the head where `src/b.ts` changed:
    - `explain test/a.test.ts` exits 0 with stdout `test/a.test.ts would run: it reaches 1 changed or uncertain node.\n  test/a.test.ts → src/a.ts → src/b.ts (changed)\nShadow mode runs every test; this is what static selection would do.\n`;
    - `explain test/c.test.ts` gives the would-skip line, with `<n>` equal to the forward closure of `f:test/c.test.ts` in the decoded map, minus 1;
    - `--to src/b.ts` from `test/a.test.ts` adds `Path to src/b.ts: test/a.test.ts → src/a.ts → src/b.ts`; from `test/c.test.ts` the not-reached line; `--to src/zzz.ts` gives `src/zzz.ts is not in the map.`; `--to p:npm:node_modules/lodash` from `test/c.test.ts` is a reached line ending `→ p:npm:node_modules/lodash`;
    - `--map nowhere --to src/b.ts` gives `test/a.test.ts would run: L3: no map at nowhere/map.smap.` and the no-map line, exit 0;
    - `--json` parses to an object whose `explanation` equals `{ test: 'test/a.test.ts', verdict: 'affected', path: [...], seeds: [...], dependsOn: <n> }`, and two runs give identical stdout (Review Focus 5);
    - with `cwd` = `join(repo, 'test')`, `explain a.test.ts` gives the same stdout as `explain test/a.test.ts` from the root (Review Focus 1); on win32 only, `explain test\\a.test.ts` does too (`it.runIf(process.platform === 'win32')`);
    - `explain ../outside.test.ts` exits 1 with stderr containing `../outside.test.ts is outside the repository` (Review Focus 3);
    - `explain src/a.ts` exits 1 with stderr `trommel: src/a.ts is not a test file Trommel plans at HEAD; it plans 2 test files\n` (Review Focus 4);
    - `trommel explain` exits 2.
  - The existing `trommel plan` tests stay as they are and must still pass.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/cli`
Expected: FAIL, unknown command `explain` and missing exports.

- [ ] **Step 3: Implement.** `args.ts`: the parse case and a `USAGE` entry after `plan`:

```
  explain <test> [--to <file|node>] [--map <dir>] [--head <rev>] [--json]
      Explain what the static plan decides for one test file, and why: every changed or
      uncertain node it reaches, with a path to each, or why it is forced or would be
      skipped. --to prints the test's path to a file or a map node. --json prints the
      explanation as canonical JSON. Paths are relative to the current directory.
```

`cli.ts`: `headAt`, `planAt`, the `explain` case (it ignores `selection.mode`, since it explains the static plan), and the header comment reworded: commands print canonical JSON, except `explain`, whose default output is text for a person. `report.ts`: the two exports. `explain.ts`: the three functions.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run packages/cli`
Expected: PASS.

- [ ] **Step 5: Hand mutation.** Each must fail a test, then restore: resolve the argument against the root instead of the current directory; treat a `--to` value as a path even when it is a map key; omit the ` (changed)` suffix; drop the not-a-planned-test check, so `explainTest`'s `RangeError` surfaces instead. (Dropping `realpathSync.native` cannot fail locally, where no short names occur; the Windows CI job covers it.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -s -m "feat(cli): trommel explain, one test's static plan decision and --to" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Docs, and the whole-repository check

**Files:**
- Modify: `DECISIONS.md` (new entry 38; check `git fetch origin && git log origin/main -1 -- DECISIONS.md` and its last heading first, and renumber if 38 is taken)
- Modify: `HANDOFF.md` (header update line; §1 a status bullet; §3 the expected test count; §4 rows for `graph.ts`, `select/explain.ts` and `packages/cli/src/`; §5.3 the collector after run 10; §8 strike `trommel explain`; §11 the collector line; §13 entry 38)
- Modify: `docs/roadmap.md` (the progress line: `trommel explain` is no longer left)
- Modify: `docs/architecture.md` (§5.1 row: what `explain` does in M1)
- Modify: `docs/superpowers/specs/2026-11-19-trommel-explain-design.md` (status: built, DECISIONS 38)

- [ ] **Step 1: Run the whole check**

Run: `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:deps`
Expected: every test passes (record the count for HANDOFF §3), and lint, typecheck and the dependency check print nothing.

- [ ] **Step 2: Confirm nothing the plan reads changed**

Run: `git diff --stat origin/main -- packages/core/src/select/plan.ts packages/core/src/graph/static.ts packages/core/src/graph/map.ts packages/core/src/smap`
Expected: no output. So the engine id, the golden hashes and every selection are unchanged, and no history replay is needed.

- [ ] **Step 3: Run it on this repository.** Build the map at `HEAD~1` with `node packages/cli/src/main.ts graph --rev HEAD~1 --out .trommel/map/map.smap`, then explain one affected test, one would-skip and one `--to`. Paste the output into the DECISIONS entry as evidence.

- [ ] **Step 4: Write the docs.** DECISIONS 38, *`trommel explain`*: context (HANDOFF §8, architecture §5.1); decision (it calls `selectStatic` and never recomputes a verdict; `forwardTree` paths, with the plan's own path for the seed it names; text by default with hubs hidden, `--json` canonical; paths relative to the current directory through `realpathSync.native`; `--to` takes an exact map key, else a file; exit codes; the configured `selection.mode` is ignored; the spec's alternatives 2 and 3 rejected); evidence (the test counts, the mutants of Tasks 1 to 3, Step 2's empty diff, Step 3's output). HANDOFF §5.3: run 10 ([44517265831](https://github.com/trommelci/trommel-corpus/actions/runs/44517265831), manifest `2026-11-19-10`) ended with nothing pending and was not stopped early; 24 of the 25 repositories have all 87 days and facebook/lexical has 86; every daily run from 2026-11-15 succeeded.

- [ ] **Step 5: Commit**

```bash
git add DECISIONS.md HANDOFF.md docs
git commit -s -m "docs: record trommel explain (DECISIONS 38) and the corpus backlog cleared" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
