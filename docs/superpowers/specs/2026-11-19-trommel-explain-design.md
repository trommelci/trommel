# `trommel explain`: design

- **Written:** 2026-11-19, at `main` = `587b013` (the lockfile cut-over merged, engine `trommel-static-4`).
- **Status:** approved by Ojas on 2026-11-19. Built on branch `m1/explain`, and [DECISIONS.md](../../../DECISIONS.md) entry 38 records it. Amended on 2026-11-19 in §4 for what the build changed: which `--to` values are node keys (ruling R5), the signature of `explainTest`, and the two loading functions.
- **Scope:** the `trommel explain` item of [HANDOFF.md](../../../HANDOFF.md) §8, one of the M1 scope items in [roadmap](../../roadmap.md) §1. It is not an exit criterion.
- **Decided already, and not reopened here:** [architecture.md](../../architecture.md) §5.1 lists `trommel explain <test>` as the why-path command, beside `trommel verify`. In M3 it explains a plan's decision; M1 builds it so that meaning carries over.

## 1. Intent

`trommel plan` gives each affected test one why-path: the shortest route to the lowest-numbered nearest seed. A test forced by L1 gets a path into the escalated package. A would-skip gets only its label. Nothing answers a question about one test:
- which of the changed nodes does it reach, and through what;
- why is it forced;
- does it depend on `src/x.ts` at all?

The last one is the question a person asks when a shadow summary lists a would-skip that looks wrong (HANDOFF §1, "record any would-skip that should have run").

## 2. Goals, non-goals, anti-goals

**Goals.**
1. For one test, the plan's own decision and its reason, with every changed or uncertain node the test reaches and a shortest path to each.
2. `--to <file|node>`: the path from the test to one node, or a plain statement that the map has none.
3. The verdict can never disagree with `trommel plan` for the same map, head and config.
4. Same input, same bytes out, in text and in JSON.

**Non-goals.**
- Explaining a recorded plan file or a plan id (M3, with proofs).
- Any change to the planner, the builder or the map. The engine stays `trommel-static-4`, and no golden hash moves.
- Listing a test's whole dependency closure. `--to` answers the question a person has; `trommel graph` prints the rest.

**Anti-goals.**
- An explanation that contradicts the plan, or a second selector that can drift from it.
- A path that is not a path of the map's graph.
- A "does not reach" that reads as proof of independence: static reachability cannot see what a test reads through `fs`.

## 3. Approaches

1. **Run `selectStatic` and look at one test (chosen).** `explain` loads the map and the head exactly as `plan` does, calls the same `selectStatic`, and takes that test's entry from the `Selection`. The paths to the other changed nodes come from one forward breadth-first search from the test. The verdict is the plan's by construction.
2. **A selector of its own for one test.** It could stop early, but it duplicates the planner's rules (escalations, hubs, lockfiles) and can drift from them. Rejected.
3. **Explain output inside `selectStatic`.** It changes the planner, which then needs the 70-commit replay to show selections are unchanged, for no change in selection. Rejected.

## 4. Design

**Command.** `trommel explain <test> [--to <file|node>] [--map <dir>] [--head <rev>] [--json]`. `--map` defaults to `.trommel/map` and `--head` to `HEAD`, as for `plan`. It explains the static, shadow-mode plan: the only plan M1 has.

**Arguments (builder's call).** `<test>` and a path given to `--to` are taken relative to the current directory, as git does, and turned into repository-relative POSIX paths. A `--to` value that is exactly a key of the map (`p:npm:node_modules/lodash`, `d:src`, `u:src/x.ts`) is that node, and so is any value shaped like a key: a node prefix (`c:`, `d:`, `f:`, `g:`, `p:`, `r:` or `u:`) not followed by a slash or a backslash, with or without a map. Anything else is a file, `f:<path>`, so a Windows drive path such as `C:\x` stays a path. (Amended by ruling R5: with only exact keys, a key missing from the map, or given with no map, went through `path.resolve`, which on Windows reads `p:` as a drive, and exited 1 as "outside the repository". The cost is that a drive-relative path such as `c:foo` is read as a key.)

**Verdict,** taken from the plan's `Selection`:
- **affected:** every seed (changed node or `u:` node) the test reaches, sorted by key, each with a shortest path from the test. For the seed where the plan's why-path ends, the path is the plan's own, so the summary and `explain` never show two routes to one node. A `u:` node carries its causes from the map.
- **forced:** the reason as the plan words it: a new test file, `alwaysRun`, `L1: <cause>` with its path, or `L3: <cause>` (no map, an invalid map, a changed config or lockfile kind).
- **would skip:** unproven static reachability: none of the N nodes it reaches changed.

In shadow mode every test runs; the text says so once.

**`--to`.** The shortest path from the test to the node, from the same forward search, or "not reached". When the target is not in the map, it says that instead. It works whenever the map decodes, including under an L3 fallback that still has a map; with no usable map it says it cannot answer. "Not reached" adds that the map cannot see what a test reads through `fs`.

**Output (builder's call).** Readable text on stdout by default, with the resolution hubs between two files hidden as the job summary hides them (`report.ts`'s `readable` and `shown`). `--json` prints the same explanation as canonical JSON, hubs included. The header comment of `cli.ts` that says everything printed is canonical JSON is reworded.

**Exit codes.** 0 for any explanation, a run-all fallback included; 1 when `<test>` is not a test Trommel plans at the head (the message says how many it found); 2 on a usage error.

**Code.**
- `core/graph/graph.ts`: `forwardTree(graph, root)`, a breadth-first search over dependencies with parent pointers and the same tie-break as `reverseReach` (neighbours in ascending id order, first discovery wins). It returns a `Reach`, so `whyPath` gives the chain from the test to any node it reaches.
- `core/select/explain.ts`: `explainTest(selection, test, context, to?)`, where `context` is the map and the graph, or null when there is no usable map, returning a plain `Explanation` object. It never recomputes a verdict. (Amended: the design had `explainTest(map, graph, selection, test, to?)`.)
- `packages/cli`: the map-and-head loading of `plan` moves into two functions that both commands call, `headAt` and `planAt` in `cli.ts`; `explain` adds argument parsing, a text renderer and the JSON output.

**Tests, written first.**
- `forwardTree`: on random graphs, every reached node's path is a chain of real edges from the root, its length is the forward BFS distance, and unreached nodes have no path.
- `explainTest` against `selectStatic`: on the random repository pairs the planner's soundness property already generates, the verdict and reason match the selection for every test, each affected test's seeds are exactly the seeds it reaches, and the plan's path appears unchanged.
- End to end through the CLI: affected, would-skip, new test, L1, the no-map fallback, `--to` reached, not reached and not in the map, `--json`, a path given from a subdirectory, and the exit codes.
- Each test file is checked by hand mutation, as for every module so far.

**Docs.** A DECISIONS entry (check `origin/main` for the next number first), HANDOFF §4 and §8, the roadmap's progress line, the architecture §5.1 row, and `--help`. HANDOFF §5.3 also gets the corpus collector's state on 2026-11-19: the backlog is cleared.

## 5. Left to the builder

The exact wording of the text output, the shape of the JSON object, and where in `packages/cli` the shared loading lives.
