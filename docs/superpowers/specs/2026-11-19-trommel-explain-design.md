# `trommel explain`: design

- **Written:** 2026-11-19, at `main` = `587b013` (the lockfile cut-over merged, engine `trommel-static-4`).
- **Status:** approved by Ojas on 2026-11-19. Built on branch `m1/explain`, and [DECISIONS.md](../../../DECISIONS.md) entry 38 records it. Amended on 2026-11-19 in §4 for what the build changed: which `--to` values are node keys, the signature of `explainTest`, and the two loading functions. Amended again in §4 for the whole-branch review's fix wave: the default map at the repository root, the path rule, `--to` under an invalid configuration, the caveat on "not in the map", the exit codes and the end-to-end tests.
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

**Command.** `trommel explain <test> [--to <file|node>] [--map <dir>] [--head <rev>] [--json]`. `--map` defaults to `.trommel/map` under the repository root, wherever `explain` runs, and `--head` to `HEAD`. It explains the static, shadow-mode plan: the only plan M1 has. (Amended after the whole-branch review: the build read the default map from the current directory, as `plan` does, so from a subdirectory `explain` found no map. `plan` is unchanged.)

**Arguments (builder's call).** `<test>`, a path given to `--to` and a `--map` given are taken relative to the current directory, as git does.
- `<test>` and a `--to` path become repository-relative POSIX paths. The path is resolved lexically against the current directory; then its ancestors, nearest first, are compared with the repository root through `realpath`. The first that exists and is the root ends the walk, and the rest of the path, as typed, is the repository path. Ancestors that do not exist are skipped, so the file need not be in the work tree, and a link inside the repository stays as typed. When no ancestor is the root, or the path is the root itself, it is outside the repository. (Amended after the whole-branch review: the build took the real path of the root and of the current directory but not of the argument, so an absolute path through a short name such as `RUNNER~1`, macOS `/var` or a link to the repository exited 1 as outside it.)
- A `--to` value that is exactly a key of the map (`p:npm:node_modules/lodash`, `d:src`, `u:src/x.ts`) is that node, and so is any value shaped like a key, with or without a map: a lowercase node prefix (`c:`, `d:`, `f:`, `g:`, `p:`, `r:` or `u:`) not followed by a slash or a backslash. Anything else is a file, `f:<path>`, so a Windows drive path such as `C:\x` stays a path. A directory is named as a node, `d:<dir>`; a path is never read as a directory. (Amended during the build: with only exact keys, a key missing from the map, or given with no map, went through `path.resolve`, which on Windows reads `p:` as a drive, and exited 1 as "outside the repository". The cost is that a drive-relative path such as `c:foo` is read as a key.)

**Verdict,** taken from the plan's `Selection`:
- **affected:** every seed (changed node or `u:` node) the test reaches, sorted by key, each with a shortest path from the test. For the seed where the plan's why-path ends, the path is the plan's own, so the summary and `explain` never show two routes to one node. A `u:` node carries its causes from the map.
- **forced:** the reason as the plan words it: a new test file, `alwaysRun`, `L1: <cause>` with its path, or `L3: <cause>` (no map, an invalid map, a changed config or lockfile kind).
- **would skip:** unproven static reachability: none of the N nodes it reaches changed.

In shadow mode every test runs; the text says so once.

**`--to`.** The shortest path from the test to the node, from the same forward search, or "not reached". When the target is not in the map, it says that instead. It works whenever the map decodes, including under an L3 fallback: an invalid configuration plans every test without reading the map, and `explain` still decodes it for the paths, while the selection stays the run-all fallback. With no usable map it says it cannot answer. "Not reached" and "not in the map" both add that static reachability cannot see what a test reads through `fs`. (Amended after the whole-branch review: the build read no map under an invalid configuration, and said nothing of `fs` after "not in the map".)

**Output (builder's call).** Readable text on stdout by default, with the resolution hubs between two files hidden as the job summary hides them (`report.ts`'s `readable` and `shown`). `--json` prints the same explanation as canonical JSON, hubs included. The header comment of `cli.ts` that says everything printed is canonical JSON is reworded.

**Exit codes.** 0 for any explanation, a run-all fallback included; 1 when `<test>` is not a test Trommel plans at the head (the message says how many it found), or when `<test>` or a `--to` path is outside the repository; 2 on a usage error.

**Code.**
- `core/graph/graph.ts`: `forwardTree(graph, root)`, a breadth-first search over dependencies with parent pointers and the same tie-break as `reverseReach` (neighbours in ascending id order, first discovery wins). It returns a `Reach`, so `whyPath` gives the chain from the test to any node it reaches.
- `core/select/explain.ts`: `explainTest(selection, test, context, to?)`, where `context` is the map and the graph, or null when there is no usable map, returning a plain `Explanation` object. It never recomputes a verdict. (Amended: the design had `explainTest(map, graph, selection, test, to?)`.)
- `packages/cli`: the map-and-head loading of `plan` moves into two functions that both commands call, `headAt` and `planAt` in `cli.ts`; `planAt` takes the directory the map is resolved against, and reads the map through `readMap`, which `explain` also calls under an invalid configuration. `explain` adds argument parsing, a text renderer and the JSON output.

**Tests, written first.**
- `forwardTree`: on random graphs, every reached node's path is a chain of real edges from the root, its length is the forward BFS distance, and unreached nodes have no path.
- `explainTest` against `selectStatic`: on the random repository pairs the planner's soundness property already generates, the verdict and reason match the selection for every test, each affected test's seeds are exactly the seeds it reaches, each seed's path is as long as its distance from the test, and the plan's path appears unchanged.
- End to end through the CLI: affected, would-skip, the no-map fallback, `--to` reached, not reached and not in the map, `--to` under an invalid configuration, `--json`, a test given from a subdirectory with the default map, an absolute path (through a link too), and the exit codes. A new test and L1 are pinned in `explainTest` and in the renderer; the no-map case covers the forced path through the CLI.
- Each test file is checked by hand mutation, as for every module so far.

**Docs.** A DECISIONS entry (check `origin/main` for the next number first), HANDOFF §4 and §8, the roadmap's progress line, the architecture §5.1 row, and `--help`. HANDOFF §5.3 also gets the corpus collector's state on 2026-11-19: the backlog is cleared.

## 5. Left to the builder

The exact wording of the text output, the shape of the JSON object, and where in `packages/cli` the shared loading lives.
