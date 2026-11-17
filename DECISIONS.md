# Decisions log

Implementation decisions too small or too local for an ADR, plus session hand-overs. Entries are numbered and never renumbered. Each one gives the context, the decision and the evidence. Architecture-level decisions live in [docs/adr/](docs/adr/README.md).

## 1. Kickoff (2026-11-11)

- **Context.** The architecture, roadmap, 21 ADRs and pre-registered targets were approved on 2026-11-11 (commits `da4f879`, `0a39d9c`). Implementation was planned to start on Mon 2026-11-16.
- **Decision.**
  - Start M1 on Wed 2026-11-11, five days early, keeping the day order of [roadmap.md](docs/roadmap.md) §4. Days 1–10 are: skeleton, corpus collector, `core/git`, `core/lex/ts`, `core/graph`, `core/resolve/ts`, `core/lockfile/npm`, CLI v0 and the walking skeleton.
  - Work on one short-lived branch and pull request per roadmap day. If a merge is pending, the next day's branch builds on the unmerged one.
  - ADRs can still be corrected in place until 2026-11-16. After that, a changed decision is a new ADR.
- **Gaps found while reading the docs.** Each one is resolved on the day it affects, with its own entry:
  1. M1 has no records, so no skip can be safe under ADR-0005. The walking skeleton's would-skips are unproven static reachability and must be labelled that way. The CLI flags also differ: architecture §5.1 has `--mode shadow`, while the roadmap's day 9 has `--shadow --static`.
  2. Architecture §3.2 says `import type` "is always erased". That holds only for the statement form. `import { type X } from 'm'` becomes `import {} from 'm'` under `verbatimModuleSyntax` and still evaluates `m`. Missing import forms: `import x = require()`, `export * as ns`, `vi.mock`/`jest.mock` (with `__mocks__`), `importActual`/`requireActual`, `require.resolve` and `new URL('…', import.meta.url)`.
  3. The docs don't say where the resolver probes for files: the working tree or git's listing.
  4. The runners probe extensions in different orders. Vite's default tries `.js` before `.ts`, TypeScript prefers `.ts`, and Jest has its own list.
  5. The zero-dependency check named only core and the CLI, but ADR-0002 also covers the runner plugins.
  6. The replay candidates in architecture §9 item 8 were chosen because they upload JUnit, not for re-execution. GitHub's license field shows `mariadb-connector-nodejs` as LGPL-2.1, and PostHog, baserow, luma.gl and AutoGPT as NOASSERTION.
  7. The planning hand-over note says the repo was "not pushed", but `origin/main` was already `0a39d9c` and the repository is public.
- **Evidence.** [roadmap.md](docs/roadmap.md) §4; [docs/adr/README.md](docs/adr/README.md); the GitHub API, read on 2026-11-11.

## 2. TypeScript 6.0, not 7.0

- **Context.** `typescript@latest` is 7.0.2, the native port. typescript-eslint 8.72.2, also the latest, peer-requires `typescript >=4.8.4 <6.1.0`, and type-aware linting needs it.
- **Decision.** Pin TypeScript 6.0.3. Revisit when typescript-eslint supports 7.x.
- **Evidence.** `npm view typescript dist-tags` and `npm view typescript-eslint peerDependencies`, run on 2026-11-11.

## 3. Source-first workspace packages

- **Context.** Core, the CLI and the runner plugins ship with zero runtime dependencies ([ADR-0002](docs/adr/0002-zero-dependency-cli.md)) and support Node 22 and later. A build step in every CI job and in the plan job would add latency and moving parts.
- **Decision.**
  - Workspace packages export `./src/*.ts` directly.
  - Sources use only erasable TypeScript (`erasableSyntaxOnly`) with explicit `.ts` relative imports, so Node's type stripping runs them unchanged. `tsc` only typechecks (`noEmit`).
  - Development needs Node 22.18 or later. The CI test job runs a repository script on every Node version in the matrix to prove type stripping works there.
  - When the CLI is published, it is bundled into one JavaScript file that runs on Node 22. Internal packages are inlined, so they never appear in `dependencies`.
- **Evidence.** `erasableSyntaxOnly` exists since TypeScript 5.8. Node's type stripping has been on by default since 22.18; the CI matrix verifies this.

## 4. Placeholder package names

- **Context.** The npm name `sieve` is taken, and the final name was to be chosen by M9 (architecture §8.1, risk 10). Architecture §5.3 used a placeholder scope.
- **Decision.** Packages are named under a placeholder scope and marked `"private": true` until the name is final.
- **Superseded by entry 30 (2026-11-14).** The name is Trommel, and the packages are `@trommel/*`. They stay `"private": true` until the first publish.

## 5. Exact pins; Node types follow the CLI's floor

- **Context.** Same input, same bytes out, and that includes the toolchain. The CLI supports Node 22 and later.
- **Decision.**
  - devDependencies are pinned exactly (`save-exact` in `.npmrc`).
  - `@types/node` tracks 22.x, so code that uses an API newer than Node 22 fails the typecheck.
  - The TypeScript target and lib are ES2024, which Node 22's V8 (12.4) fully supports.

## 6. Scope of the zero-dependency check

- **Context.** The brief named core and the CLI. [ADR-0002](docs/adr/0002-zero-dependency-cli.md) also covers the runner plugins, and runtime dependencies can also arrive through `optionalDependencies` or `bundleDependencies`.
- **Decision.**
  - `npm run check:deps` covers `packages/{core,cli,vitest,jest}`.
  - It rejects non-empty `dependencies`, `optionalDependencies` and `bundle(d)Dependencies`.
  - It allows `peerDependencies` only in the two runner plugins.
  - A missing manifest counts as a violation, so renaming a package can't skip the check.

## 7. The DCO check covers pull-request commits only

- **Context.** The two documentation commits on `main` (`da4f879`, `0a39d9c`) predate the sign-off rule, and history on `main` is never rewritten.
- **Decision.** CI checks every non-merge commit in `base..head` of a pull request. The sign-off's e-mail must match the commit author's, compared case-insensitively.

## 8. Seeded property tests

- **Context.** Property tests must be deterministic in CI and still able to explore.
- **Decision.** fast-check uses the global seed `20261116`, set in `vitest.setup.ts`. `TROMMEL_FC_SEED` overrides it, and failures print the seed and path needed to replay them.

## 9. The corpus collector uses `GITHUB_TOKEN`, not a personal token

- **Context.** The collector reads Actions data and downloads artifacts from other public repositories. It was not known whether a workflow's `GITHUB_TOKEN` is allowed to do that, or whether it is limited to 1,000 requests per hour as the docs say.
- **Evidence.** A one-off probe workflow (run 43022083834 on a temporary `probe/artifact-access` branch, since deleted) called the API with `GITHUB_TOKEN`:
  - against electron/forge and baserow/baserow, listing runs, listing a run attempt's jobs, listing a commit's check runs and listing artifacts all returned 200;
  - downloading electron/forge's newest artifact returned **302**, then 200 with a 436,043-byte zip archive;
  - `/rate_limit` reported a core **limit of 5,000** for the token;
  - baserow's repository-wide `GET /actions/artifacts` returned **500**. It also failed for meshery and AutoGPT in a survey with a user token, so listings of large repositories fail on GitHub's side.
- **Decision.**
  - The collector authenticates with its own workflow `GITHUB_TOKEN`, so no secret is needed.
  - It lists artifacts per run, never per repository.
  - It retries 5xx responses with backoff, honours `retry-after` and the reset time, and reads the rate limit from response headers instead of assuming one.

## 10. Collector design

- **Context.** History older than 90 days is gone. A daily job gets at most 6 hours, and on 2026-11-11 the candidates created anywhere from 1 to more than 2,500 runs a day. A live metadata-only test against vuejs/core took about 3.2 requests and about 38 KB of raw JSON per run.
- **Decision.**
  - **Work order.** The last 7 days are re-collected on every run, to catch new attempts and short-lived artifacts. The backfill then goes oldest day first, back to 89 days ago, tier 1 repositories before tier 2.
  - **Run listing.** Runs are listed per workflow, by `created` day. A range whose `total_count` exceeds GitHub's 1,000-result cap is split in halves.
  - **Per run.** The collector fetches each new attempt and its jobs, the check runs of the check suite, and the artifact listing, and mirrors matching test reports.
  - **Resumable state.** State records, per run, the attempt seen and the artifacts mirrored. It is updated run by run, so an interrupted day resumes where it stopped.
  - **Budgets.** The request and time budgets end a run cleanly. The manifest records what is pending and the coverage of the retention window.
  - **Raw objects.** Records are raw API objects written as canonical NDJSON. Consumers deduplicate.
- **Evidence.** Tests in `tools/corpus/test`, mutation-checked by hand against the fake API. Metadata-only live runs on 2026-11-11 against colinhacks/zod and vuejs/core.

## 11. Corpus storage (proposed; awaiting approval)

- **Context.** The data has to outlive GitHub's 90 days, be publicly reproducible (TARGETS.md, "Publication"), and cost nothing to run.
- **Decision (proposed).**
  - A separate public repository, `trommelci/trommel-corpus`, built from the template in `tools/corpus/corpus-repo/`.
  - Manifests and collector state are committed to git.
  - Raw NDJSON (`.tar.gz`) and mirrored artifacts (`.tar`, per repository) are uploaded as daily release assets, which have no retention limit.
  - The collector is pinned by commit in `collector.ref`.
  - Mirroring is limited to permissively licensed repositories; the rest contribute metadata only (bench/CORPUS.md).
- **Status.** Approved on 2026-11-11 and created as [trommelci/trommel-corpus](https://github.com/trommelci/trommel-corpus), with the collector pinned to `4d28a10`. The first run started the same day (workflow run 43026895799).

## 12. Snapshot diff semantics (`core/git`)

- **Context.** Architecture §3.1 defines `f:` hashes as blob ids and `d:` hashes as a digest of a directory's entry names. It leaves several cases open: mode changes, symlinks, submodules, paths that are not valid UTF-8, and the order of output.
- **Decision.**
  - **Change kinds.** A blob, symlink or gitlink whose oid *or mode* changes is `modified`, so an executable-bit flip counts as a change, which is conservative. A path that turns from file into directory, or the reverse, is a `deleted` plus `added`s.
  - **Listings.** A directory's listing is the set of its entry names *and kinds*: file, symlink, submodule or directory. A file that becomes a symlink therefore changes its directory's listing, as `readdir` with file types would show. A directory that appears or vanishes counts as a listing change too, because its `d:` node goes to or from absent.
  - **Path order.** Every path list is sorted by UTF-16 code units, the order canonical JSON uses for keys, and never by git's tree order. Both diffs therefore yield byte-identical results on every OS.
  - **Undecodable paths.** A path whose bytes are not valid UTF-8 is kept, with a lossy rendering and an `undecodable` flag. `TreeIndex` counts these paths, so callers can escalate (L3). Duplicate paths throw.
  - **Reading from git.** `lsTree` reads `git ls-tree -r -t -z --full-tree <root tree>` as a stream. It never hashes working-tree bytes, because those differ across OSes when line endings are converted.
- **Evidence.**
  - P10 (`packages/core/test/git/diff.test.ts`): the descent equals the naive diff on 10,000 seeded random tree pairs. It also visits exactly the directories that exist on both sides with different ids.
  - A differential test against `git diff-tree -r --no-renames` on SHA-1 and SHA-256 repositories built with plumbing.
  - Five hand mutants of the descent, all caught.

## 13. `git ls-tree` cost at 10,000 files

- **Context.** Open item: measure `git ls-tree` on a 10,000-file repository. Architecture §3.1 expected about 100 ms.
- **Evidence.** On the synthetic 10,000-file repository (`node bench/ls-tree.ts`), medians of 15 runs on Windows 11 with Node 26.4 and git 2.55:
  - `git ls-tree` alone: 31.5 ms;
  - the full snapshot read (`lsTree`): 57.6 ms;
  - `TreeIndex.build`: 3 ms;
  - the descent: under 0.5 ms for 1 or 100 changed files.

  The details are in [bench/README.md](bench/README.md).
- **Decision.** The CLI lists the whole head tree locally. The two-round-trip protocol in §3.1 matters for the server's bandwidth, not for the CLI's latency.

## 14. The TypeScript/JavaScript import lexer (`core/lex/ts`)

- **Context.** Architecture §3.2 and ADR-0002 call for a hand-written, zero-dependency state machine. The kickoff found gap 2: `import type` semantics, plus import forms the docs don't list.
- **Decision.**
  - **Origin.** The lexer was written fresh. TokenDamper's `ts-validator.ts` was read for reference only, and no code was ported, so it needs no provenance line.
  - **Two stages.** A scanner produces tokens. A recognizer then reads import forms off the token stream.
  - **Twelve record kinds:**
    - `static`, `side-effect`, `reexport`, `dynamic`;
    - `require` (including `module.require`), `require-resolve`;
    - `import-equals` (`import x = require()`);
    - `glob`: `import.meta.glob`/`globEager`, with patterns and the `query` and `base` options;
    - `meta-resolve`;
    - `url` (`new URL('…', import.meta.url)`);
    - `mock`: `vi` or `jest` mock, `doMock`, `unmock` and similar; `vi.mock(import('./x'))` is recognised;
    - `actual`: `importActual` and `requireActual`.

    Specifier queries such as `?raw` are kept verbatim for the resolver.
  - **Type-only imports.** Statement-level `import type` and `export type` are marked `typeOnly`. When every named specifier carries an inline `type`, the record is marked `inlineTypeOnly`, but it stays an edge, because `verbatimModuleSyntax` keeps it as `import {}`. That resolves kickoff gap 2.
  - **Uncertainty is never silent.**
    - A non-literal specifier yields `specifier: null`, or `patterns: null` for a glob.
    - Diagnostics mark the whole file uncertain: unterminated strings, templates, comments or JSX; unbalanced brackets; an `import` or `export … from` that can't be parsed; template or JSX nesting deeper than 256; invalid UTF-8.
  - **Regex versus division** is decided by the previous significant token:
    - a keyword after `.` or `?.` is a property name;
    - the `)` closing `if`, `while`, `for` or `with` lets a regex follow;
    - `++` and `--` are operands;
    - a would-be regex that reaches the end of its line is reinterpreted as division.
  - **JSX.** It is on for `.tsx`, `.js` and `.jsx`, and off for `.ts`, where `<T>x` is a type assertion. `<` opens JSX only where an expression can start. In `.tsx`, `<T,>` and `<T extends …>` are type parameters. JSX text and attribute strings are not code.
  - **Definitions are not calls.** These are treated as definitions or signatures:
    - `import(` or `require(` with no arguments, or with `{` after the matching `)`;
    - a first argument written `name:` or `name?:`;
    - `import<` in any form.

    `typeof import('x')` in a type position is recorded as a dynamic import, which is conservative.
- **Evidence.**
  - 19 golden fixtures with hand-derived expectations.
  - A generative test: 2,000 seeded programs bury real imports among adversarial strings, comments, templates, regexes and divisions, under LF and CRLF, and every one must come out in order with no diagnostics.
  - 3,000 arbitrary inputs: no throw, and identical output on repeat.
  - 10 hand mutants of key decisions, all caught.
  - On the 2,699 files under `node_modules` (43.7 MB), **0 files are marked uncertain**. Before the signature fix, two files were wrongly flagged, both Vite and Vitest `.d.ts` output with `import<T>(…)` method signatures.

## 15. Lexer throughput

- **Evidence.** `node bench/lex.ts` runs at 32–34 MB/s (median of 5 passes over 43.7 MB) on Windows 11 with Node 26.4.
- **Implication.** A cold lex of a 10,000-file repository that averages 10 KB per file (100 MB) takes about 3 s. That is a tenth of T6's 30-second budget for the whole static graph. Extraction is cached by (blob oid, extractor version), so incremental runs only re-lex changed blobs.

## 16. Graph representation (`core/graph`)

- **Context.** Architecture §3.2 and §3.3 specify the graph:
  - CSR adjacency in both directions;
  - a provenance per edge (static, dynamic or declared);
  - a multi-source reverse BFS with parent pointers for why-paths;
  - output that is deterministic across runs and OSes (P6).
- **Decision.**
  - **Edge direction.** An edge points from the dependent to what it depends on. The BFS walks the reverse arrays from the changed nodes.
  - **Canonical ids.** `GraphBuilder.build()` numbers nodes in sorted name order, in UTF-16 code-unit order. The same graph built in any order therefore gives identical CSR arrays, BFS order and why-paths.
  - **Ties.** Seeds and neighbours are visited in ascending id order, and the first discovery wins. A why-path is therefore a shortest path to the lowest-numbered nearest seed.
  - **Provenance is a 3-bit mask:** `STATIC=1`, `DYNAMIC=2`, `DECLARED=4`. Duplicate edges are merged by OR-ing the bits, because one edge is often both static and dynamic.
    - This differs from ADR-0009 and §4.2, which give SMAP a "2-bit provenance per edge". Two bits can't represent combinations of three sources.
    - To settle when SMAP is built (week 3): a 3-bit mask, or 2 bits plus a rule that drops a source.
  - Seeds that aren't nodes throw. Callers map changed paths to nodes, or to escalations (§3.5), first.
- **Evidence.**
  - P1: a node is reached exactly when its forward closure meets the change set. Checked against a DFS oracle over the raw edge list on 2,000 random graphs, with cycles allowed.
  - P3: monotonicity, on 2,000 graphs.
  - Why-paths follow real edges and are shortest, checked by an independent BFS on 1,000 graphs.
  - Building with permuted insertion order gives identical arrays and why-paths, on 1,000 graphs.
  - 5 hand mutants, all caught.
  - At 100,000 nodes and 1M edges, the reverse BFS takes 7.6–8.5 ms in the worst case, when every node is reached; §3.3 expected tens of milliseconds. The build takes 1.6 s ([bench/README.md](bench/README.md)).

## 17. Module resolution (`core/resolve`)

- **Context.**
  - Architecture §3.2 asks the resolver to cover relative paths, extensions, index files, tsconfig `paths`/`baseUrl`/`extends`, package `exports`/`imports` and workspaces, with "probe recording".
  - Kickoff gaps 3 and 4 asked where to probe, and how to handle runners that order candidates differently.
- **Decision.**
  - **Where it probes.** The resolver works on a virtual file system: git's case-sensitive listing of one snapshot, through the `Vfs` interface, never the working tree. Untracked and ignored files are invisible to it; `generated` rules and the M2 fs hooks cover them.
  - **Union of runners.** For a missing exact path, every candidate any runner might pick is probed:
    - the path itself;
    - `.js`→`.ts`/`.tsx`, `.jsx`→`.tsx`, `.mjs`→`.mts`, `.cjs`→`.cts`;
    - the extensions `.ts .tsx .mts .cts .js .jsx .mjs .cjs .json`;
    - for a directory, its package.json entry and `index` with every extension.

    Every existing candidate is a target and every missing one an absent (⊥) node. When the exact path exists, it alone is the target, because Vite, Jest and Node all try it first.
  - **Directories.** Any path probed as a directory is a `d:` node, including one that doesn't exist. A missing directory is one `d:` node instead of eleven `index` probes, and it is still sound: if the directory appears, its listing changes.
  - **Exports and imports.** Targets are the union over every condition except `types`/`typings`, through nested conditions and fallback arrays. The key is chosen by Node's `PATTERN_KEY_COMPARE`, the most specific match. `null` means not exported. Without `exports`, the entry is the union of `main`, `module`, `browser` and `jsnext:main`, plus `index`.
  - **tsconfig.**
    - The nearest `tsconfig.json` governs. Each missing `tsconfig.json` on the way up is a ⊥ node.
    - `extends` may omit `.json`, and chains are followed.
    - Package bases are not readable from git. Those under `@tsconfig/` are assumed to set no paths; any other package base marks the result uncertain.
    - The best `paths` match (longest prefix) and `baseUrl` add candidates on top of normal resolution, never instead of it.
  - **Workspaces.**
    - Packages come from pnpm-workspace.yaml, or else the root package.json `workspaces`, with `!` excludes.
    - A bare import depends on one synthetic node, `workspaces`, that lists every `name=dir`. Its edges therefore don't grow with the number of packages, and a rename or a new package still affects every bare import.
    - Duplicate package names make the result uncertain.
  - **Mocks.**
    - An external package also depends on the `__mocks__` listing at the repo root and at the importer's package root, because Jest uses `<root>/__mocks__/<pkg>` automatically. Existing mock files there are targets.
    - `vi.mock` and `jest.mock` records add `__mocks__/<name>` next to each resolved module.
  - **Everything else is explicit:**
    - `node:` and builtins → `builtin`;
    - `data:` → `ignored`;
    - `http(s):` → `unresolved: remote module`;
    - other schemes such as `virtual:` → `unresolved: virtual module`;
    - a path below a symlinked directory → `unresolved: symlinked directory`;
    - an unparseable package.json or tsconfig → `uncertain`.
- **Evidence.**
  - 5 fixture repositories with 43 hand-derived cases.
  - An exact probe list for one import.
  - Unit tests for JSONC, the pnpm YAML subset, globs and `exportsTargets`.
  - **The soundness property:** on 400 random repositories × 13 specifiers, adding any file that isn't recorded evidence, or removing any file that isn't a target, config or under a recorded directory, never changes the result.
  - 10 hand mutants of the safety-critical choices, all caught.
- **Cost, still to measure.** Probe edges will dominate the edge count, at about 10 per extensionless import. If SMAP size or graph build time demands it, shared per-directory "probe group" nodes can cut that.
- **Settled by entry 32 (2026-11-14).** Probes that depend only on the resolved path or the importer's directory live in `r:` and `c:` resolution hubs, whose hash covers which candidates exist. An absent candidate inside a hub is no longer a node.

## 18. npm lockfiles (`core/lockfile/npm`)

- **Decision.**
  - Every `node_modules/…` entry in a v2 or v3 `packages` map becomes `p:npm:<install location>`. Its hash is the `integrity`; without one, `version|resolved`; for a workspace link, `link:<dir>`. The root entry and workspace declarations are skipped, because they are package.json files that are already `f:` nodes.
  - `locate(name, dir)` follows Node's walk up the `node_modules` directories, never through `node_modules/node_modules`.
  - A package depends on what its dependencies, optional dependencies and peers resolve to from its own location; unresolvable names are reported as missing.
  - v1 lockfiles, invalid JSON, pnpm, yarn, bun, or more than one lockfile kind are reported as `unparseable`, which escalates to L3 (§3.5).
- **Evidence.** 16 tests, including a parse of this repository's own lockfile. pnpm and yarn parsing is due in M1's week 3; bench/CORPUS.md shows it is a prerequisite for the replay corpus.

## 19. Session hand-over (2026-11-11): days 1–8 done, 9–10 next

- **Done.** All changes are on stacked branches, one pull request per roadmap day:

  | Day | Pull request | State |
  |---|---|---|
  | 1, skeleton and CI | #1 | merged |
  | 1–2, corpus collector | #2 | open |
  | 2–3, `core/git` and P10 | #3 | open |
  | 3–4, import lexer | #4 | open |
  | 5, graph with P1 and P3 | #5 | open |
  | 6–7, resolver | #6 | open |
  | 8, npm lockfile | #7 | open |

  At the time of writing, 239 tests pass locally. #2–#5 were green in CI; #6 and #7 were pending.
- **Corpus.** [trommelci/trommel-corpus](https://github.com/trommelci/trommel-corpus) was created with approval. Its first collection run, 43026895799, was still running.
- **Open item: day 1–2's "done when".** It is met once that run publishes `manifests/2026/2026-11-11-1.json`. If the run failed, read its log, fix the collector on #2, update `collector.ref` and re-run the workflow.
- **Next: day 9, CLI v0.**
  - `core/git`: read blob contents with `git cat-file --batch`, and add a `GitVfs` over `TreeIndex` plus blobs.
  - A static graph builder:
    - lex every source file;
    - resolve every record;
    - add edges to targets, absent paths, `d:`, configs and `g:` nodes;
    - add each importer's tsconfig chain and nearest package.json;
    - add `p:` nodes through `locate` and lockfile package edges;
    - mark `u:` nodes and uncertain files.
  - The CLI: an argument parser, a `trommel.config.json` loader, and `trommel graph`, `diff` and `plan --static --shadow --map <dir>`, all emitting canonical JSON. Would-skips must be labelled unproven (kickoff gap 1).
- **Next: day 10.** The walking skeleton workflow (plan → matrix → shards → `trommel-gate`), with the map in `actions/cache` (roadmap §5).
- **How to verify.** Run `npm ci`, then `npm test`, `npm run lint` and `npm run typecheck`. `node bench/ls-tree.ts`, `node bench/lex.ts` and `node bench/graph.ts` reproduce the recorded numbers.

## 20. Hand-off document (2026-11-11)

- **Context.** After entry 19 was written, Ojas approved merging #2–#7. They were merged into `main` in order, with merge commits, and `main` is green at `00fea91`. Ojas then asked for a hand-off detailed enough for someone else to continue.
- **Decision.**
  - [HANDOFF.md](HANDOFF.md) at the repository root is the single place to start. It covers:
    - status;
    - ground rules;
    - setup and verification;
    - a module map with entry points;
    - how to operate the corpus collector;
    - detailed plans for days 9 and 10;
    - the rest of M1;
    - recorded numbers;
    - decisions waiting on Ojas;
    - known limits;
    - environment notes.
  - Entry 19's PR states are superseded: every one of #1–#7 is merged.
  - Architecture §3.1 now defines `d:` hashes as names *and kinds*, matching entry 12 and the code. Whoever builds the graph on day 9 should implement against that.
- **Evidence.** `gh pr view` shows #1–#7 merged; CI on `main` passes.

## 21. Collector budget: oldest days first, per-repository shares, PostHog dropped

- **Context.** The first collection run (43026895799, 2026-11-11) succeeded but could not keep up:
  - 24,581 requests over 320 minutes collected 6,208 runs, 6,258 attempts and 83,523 jobs, with no errors.
  - That covered only 1.7 of the 7 recent days it re-collected first (Nov 4, and Nov 5 for 19 of 26 repositories), and none of the backfill.
  - PostHog's `ci-frontend.yml` was 4,183 of those runs, all from one day.
  - Only 68 artifacts (0.2 MB, meshery) matched the test-report pattern.
- **Decision.**
  - **Oldest days first.** Days are collected oldest first: the backfill, then a recent window that shrinks from 7 to 2 days. GitHub deletes the oldest days first, and a recent day not reached in time is collected later as a backfill day.
  - **Per-repository shares.** In phase 1, each repository may spend `repoShare` requests (default 1,000; 25 repositories × 1,000 is about one run's capacity). A repository that hits its share stops for the phase; the client throws `ShareExhausted`, distinct from `BudgetExhausted`. In phase 2, the remaining time goes to the open work in plan order. State is saved run by run, so an interrupted day resumes without refetching.
  - **The manifest** now records `requestsByRepo`, `options.repoShare`, and a `capped` item status.
  - **PostHog/posthog is removed** from `repos.json`. It is tier 2 and metadata-only (NOASSERTION), and most of its runs are bots.
- **Evidence.** Tests in `tools/corpus/test` cover the share limit in the client, the new plan order, and the two phases: a capped repository yields to the others, then finishes from the leftover time. Two hand mutants are caught: dropping phase 2, and ignoring the share. The first run's numbers are in its manifest, `manifests/2026/2026-11-11-1.json` in trommel-corpus.

## 22. Race-proof corpus publishing: a reusable workflow, and re-apply before pushing

- **Context.** A collection run holds the data repository for hours, and its last act is a push to `main` there. Three things could go wrong:
  - **A push during a run lost the run.** Anything landing on trommel-corpus `main` while a run collected — a `collector.ref` bump, a workflow edit — made the run's final push non-fast-forward. The release, with the data, was already published; the manifest and `state/collector-state.json` were not. The next run redid the work and the release sat orphaned with nothing pointing at it. The `collect` concurrency group keeps two runs apart and does nothing about a person. DECISIONS 21's PR added a `git pull --rebase` loop to the template, but it was untestable bash that left a half-finished rebase behind on a conflict, so attempts 2 and 3 failed for a new reason; the copy live in trommel-corpus never got even that.
  - **A partial release was visible.** One `gh release create` created the release and uploaded every asset, so a failure part-way left a published release missing assets.
  - **The cause was structural.** `collector.ref` lived in the data repository, so every collector change needed a hand push into it — exactly the event that lost runs. The workflow also existed twice, as the template here and the copy there, free to drift.
- **Decision.**
  - **The data repository no longer holds the collector version.** trommel-corpus's `collect.yml` becomes a thin caller of `.github/workflows/corpus-collect.yml` in this repository, and `collector.ref` is deleted. The reusable workflow checks out the collector from `job.workflow_repository` at `job.workflow_sha`, the commit of the workflow file that is running, so a run is pinned to itself and the manifest still records that commit through `--ref`. Normal operation needs no push to trommel-corpus at all: merging here changes the next run.
  - **Pinned to `@main`, not to a tag.** CI gates `main`, and a tag would move the manual step rather than remove it. The cost is that a bad merge can break the next night's collection; that is recoverable, a lost day of a 90-day window is not.
  - **One source of truth, checked daily.** The steps a run performs exist once, here. The caller stub and the data repository's README are still copies, so a `templates` job in the reusable workflow diffs them against `tools/corpus/corpus-repo/` and fails when they differ. It is a job of its own, not a step in `collect`: drift turns the run red without stopping collection, because a stale README must never cost a day of history that GitHub is about to delete.
  - **Publishing is a tested script**, `tools/corpus/src/publish.ts` with a thin `publish-main.ts` CLI, rather than inline YAML. Commands are injected, so ordering and failure handling are testable.
  - **Data first, then the index that claims it.** The release is created as a draft, its assets uploaded, and only then un-drafted; the manifest and state are committed after that. A consumer never sees a partial release, and committed state can never promise data that was not stored. The manifest and the state file are also release assets, so a run whose commit never lands stays recoverable. Re-running a job, which keeps its run number, uploads over the existing release instead of failing on the tag.
  - **Re-apply rather than rebase.** Each attempt fetches `origin/main`, resets the branch to it, writes the run's staged manifest and state over whatever is there, commits and pushes. Three attempts by default, then it throws with every attempt's git output. Against `git pull --rebase`: there is no conflict state to abort when someone touched the same file, the run's own files always win while every other file comes from the remote, and it is idempotent — a re-run that would commit the same bytes reports nothing to do instead of failing. Only tracked files move, so the collector's untracked output in the checkout survives.
- **Evidence.** `tools/corpus/test/publish.test.ts` builds a real bare "remote" with two clones and has a competitor push to `main` immediately before chosen push attempts:
  - a commit that lands mid-run is kept and the run's manifest and state still arrive, on the second attempt;
  - a competitor that touched `state/collector-state.json` itself does not conflict, and the run's version wins;
  - a competitor on every attempt exhausts them and throws with git's rejection, leaving no `rebase-merge`, `rebase-apply` or `MERGE_HEAD` behind and HEAD still on the branch;
  - an unreachable remote fails with git's own message;
  - the files already being on the branch reports nothing to commit;
  - `gh release edit --draft=false` runs before the first `git commit`, and a failing `gh release create` commits nothing at all.

## 23. The static graph and the M1 map (`core/graph/static`)

- **Context.** Day 9 builds the static impact graph (architecture §3.1, §3.2) and stores it for plans ([HANDOFF.md](HANDOFF.md) §6.1). Several choices were left open: declaration files, the rule for uncertain files, lockfiles that cannot be parsed, mode changes, and the map's format.
- **Decision.**
  - **Inputs come from git objects only.** `readBlobs` reads every blob through one `git cat-file --batch` process. `GitVfs` serves the resolver from a `TreeIndex`: modes `100644`/`100755` are files, `120000` symlinks, `160000` submodules, trees directories.
  - **Module files** (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) are all nodes, imported or not. **Declaration files** (`.d.ts`, `.d.mts`, `.d.cts`, `.d.<ext>.ts`) are nodes but are never lexed: no runtime evaluates them. Type tests (Vitest typecheck) would need them; they are out of scope until records exist. Statement-level `import type` is skipped; inline `type` specifiers stay edges (entry 14).
  - **Node keys and hashes.**
    - `f:<path>`: the blob id, prefixed by the mode unless it is `100644` (`100755:<oid>`, `120000:<oid>`), so a mode change is a change, as in entry 12. A path that does not exist hashes to `null` (⊥).
    - `d:<dir>`: SHA-256 of the canonical JSON of its sorted `[name, kind]` pairs, with entry 12's kinds; `null` if missing.
    - `g:workspaces` (the resolver's name map), `g:glob:<patterns>` (`import.meta.glob`), `g:inputs.global` and `g:declared:<match>`: SHA-256 of the canonical JSON of the sorted matches. The map keeps each pattern-based node's patterns, so a plan can recompute it.
    - `p:npm:<location>`: the lockfile hash (entry 18). Every package in the lockfile is a node.
    - `e:runtime` (Node major.minor), `e:platform` (OS and architecture) and `e:env/<NAME>` for each tracked variable: SHA-256 of the value, so the map never holds environment values.
    - `u:<path>`: an uncertain file.
  - **Edges.**
    - STATIC, from each lexed file: to everything each resolution recorded (targets, absent paths, directories, configs, globs); to its own config chain (`Resolver.fileConfigs`: the tsconfig chain and the nearest `package.json`); and, for a bare specifier, to `p:npm:` via `locate`, or to the ⊥ node `p:npm:node_modules/<name>` when the package is not installed.
    - STATIC, from each package: to what its dependencies resolve to, or to that ⊥ node.
    - DECLARED, from each test: to `g:inputs.global`, every `e:` node and the declared rules that match it.
  - **The `u:` rule: an uncertain file's `u:` node is always changed, a seed of every plan.**
    - A file is uncertain when the lexer raised a diagnostic, an import is unresolved (non-literal ones included), a resolution read a config it could not parse, or a bare import names a package missing from the lockfile (or there is no lockfile).
    - Any test that reaches the file always runs.
    - Architecture §3.5's narrower rule, L1 only when the uncertain file changed, relies on dynamic coverage that does not exist until M2/M3.
  - **Lockfiles that cannot be parsed** (pnpm, yarn, bun, npm v1) **or more than one.**
    - Bare imports depend on each lockfile's `f:` node, and a plan escalates to L3 when any of them changed or the set of lockfiles changed.
    - This is §3.5's row "lockfile changed but unparseable". HANDOFF §6.1's "unparseable is L3" is read the same way, so an unchanged pnpm lockfile costs no precision.
    - Both corpus candidates, hono and zod, use pnpm.
  - **Default global inputs:** the root `package.json`, `.env*`, Vite and Vitest configs, `vitest.workspace.*`, `vitest.setup.*`, and Jest's config and setup, by their conventional names. `inputs.global` adds to them. Runner configs are module files, so their imports are followed too.
  - **The map** is canonical JSON at `.trommel/map/map.json` until SMAP (week 3). It holds `version` 1, `engine` `trommel-static-1` (another engine's map is invalid), `objectFormat`, `rootTree`, `undecodable`, the config's blob id, the lockfile setup, `snapshot`, `nodes`, `edges`, `globs`, `tests` and `uncertain` (the causes per `u:` node).
    - `snapshot` lists every `ls-tree` entry as `[mode, oid, path]`, so a plan diffs against it without the base commit, which a depth-1 checkout does not have.
    - `edges` is an adjacency object, `{ from: { to: provenance } }`: the same content as `[from, to, provenance]` triples, in less space.
    - `parseMap` checks every field and both ends of every edge. Anything wrong is a `MapError`, and the plan runs everything.
- **Evidence.**
  - Example tests for every node and edge kind (`static.test.ts`, `map.test.ts`), and determinism: identical bytes whatever order the sources arrive in, and byte-identical maps of one revision from the CLI.
  - `Resolver.fileConfigs` passes the evidence-completeness property of entry 17 (400 runs). `GitVfs` and `MemoryVfs` give identical resolutions (500 runs).
  - **T6:** `trommel graph` on a synthetic 10,000-file TypeScript monorepo (42.1 MB) takes **2.5 s cold**, against 30 s. On this repository it takes 0.36 s. See [bench/README.md](bench/README.md).
  - **Probe-edge volume** (entry 17's open item): in the synthetic repository, 60,000 imports, mostly extensionless, give 684,501 edges, about 10 per import as estimated, and a 26.7 MB map. SMAP and per-directory probe groups are the levers if size matters.
  - On this repository 18 files are uncertain, all lexer fixtures that nothing imports, so no test runs because of them.

## 24. Static selection and CLI v0; kickoff gap 1 resolved

- **Context.** Day 9's CLI: `trommel graph`, `trommel diff` and `trommel plan --static --shadow --map` ([HANDOFF.md](HANDOFF.md) §6.2). Kickoff gap 1 (entry 1) was still open: no skip can be safe without records, and the docs spelled the flags two ways.
- **Decision.**
  - **Δ(S,H).** Files and listings come from the Merkle descent against the map's snapshot; `g:`, `p:` and `e:` nodes are recomputed at H. Every `u:` node is a seed. A new install location of a package named `N` seeds every `p:` node named `N`, because it can shadow another copy for some importers.
  - **Escalations** (§3.5), each listed with its cause:
    - **L1**, every test under the owning package (the nearest `package.json` at H): a changed file that is not a graph node. Exempt are files matching `inputs.ignore` (default `**/*.md`, `docs/**`, `LICENSE*`), lockfiles and `trommel.config.json` (handled below), and newly added module files, whose effect already shows through the probes and listings they would satisfy.
    - **L3**, every test: `trommel.config.json` changed; another object format; a path that is not UTF-8; the lockfile setup changed; a lockfile that cannot be parsed changed.
    - **Run-all fallback, exit 0:** no map, an invalid map (version, engine or any malformed field), an invalid config, or an internal error. CI is never blocked.
  - New test files and `alwaysRun` tests always run. Why-paths go from the test to the changed or uncertain node.
  - **Kickoff gap 1.**
    - `plan` needs `--static` until records exist (M2/M3).
    - `--static` refuses `--mode safe`, whether from the flag or from `selection.mode` in the config, and `budget`, with exit code 2. Shadow mode runs every test.
    - `--shadow` is an alias of `--mode shadow`.
    - Every would-skip is labelled **unproven static reachability**: per test in the plan JSON, and in the summary.
    - Architecture §5.1 is updated to match.
  - **GitHub outputs.**
    - `matrix` is `{"include":[{"shard":k,"files":[…]}]}`: the sorted run set split round-robin into `--shards` exact file lists (default `sharding.max`, else 1).
    - `count` is the number of test files to run.
    - The step summary has the would-run and would-skip counts, escalations, up to 20 why-paths and the would-skip list.
  - **Config.** `trommel.config.json` is read from git at the planned revision and validated by hand against the §5.1 schema; without one, the defaults apply. Projects may add `include` and `exclude` globs; otherwise each runner's default applies, without `node_modules` and `fixtures`.
  - **Exit codes:** 0 for success, fallbacks included; 1 for an error; 2 for a usage error.
- **Evidence.**
  - **Soundness property:** 2,000 seeded pairs of small repositories with shadowing probes, tsconfig paths, workspaces, nested package copies and global inputs.
    - If what a test loads differs between S and H, or any of it is uncertain, the plan must select the test.
    - The oracle follows resolutions, configs, lockfile packages and global inputs directly, and shares no graph code.
    - 20 hand mutants of the builder and the selection were all caught. A first version that used the builder as its own oracle caught only 7.
  - End-to-end CLI tests on a throwaway repository: graph, plan with `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY`, each fallback, `--mode safe` refused, diff, byte-identical maps and absolute paths.
  - On this repository, a map built at `2a4a4b7` and planned at the CLI commit selects 11 of 27 test files: 7 affected, with why-paths, and 4 new test files. The other 16 are unproven would-skips.
  - **On honojs/hono** (corpus, pnpm, no `trommel.config.json`), at `f6fbaf02`: `trommel graph` takes 0.44 s cold for 585 files, with 161 test files found by Vitest's default include and 45 uncertain files.
    - Planning `HEAD~6` → `HEAD~1` (13 changed nodes, `src/hono-base.ts` among them) selects 114 of 161: 87 through changed files, 26 through uncertain files and 1 new test file. The other 47 are unproven would-skips.
    - The 26 come mostly from adapters that import `hono` itself: its `exports` point at `dist/`, which is build output and not in git. The rest are `bun:test` (an unknown scheme) and one non-literal `import()`.
    - Planning `HEAD~10` → `HEAD` selects all 161: the release commit bumps the version in the root `package.json`, which every file depends on (its nearest `package.json`, and a global input).
    - hono's own Vitest config uses projects with extglob includes, so discovery without a `trommel.config.json` also counts adapter and runtime tests that hono runs elsewhere.

## 25. The walking skeleton in CI (day 10)

- **Context.** Day 10 puts the plan → matrix → shards → gate slice into CI on this repository, in shadow mode, with the map kept in `actions/cache` (roadmap §4 and §5, architecture §5.3 and §5.4, [HANDOFF.md](HANDOFF.md) §7). Until the runner plugin and `trommel run` arrive (M3), a shard needs some other way to run an exact file list. ADR-0004 rules out Vitest's positional filters, which match substrings.
- **Decision.**
  - **`.github/workflows/trommel.yml`** runs on pull requests, pushes to `main` and merge groups, alongside `ci.yml`, which still runs the whole suite on every OS and Node version. Its jobs:
    - **`plan`** restores the map, runs `trommel plan --mode shadow --static --map .trommel/map` from source, and writes `matrix`, `count` and the job summary.
    - **`test`** is a matrix of shards from the plan, skipped when `count` is 0. Each shard runs `npx vitest run` with its file list.
    - **`trommel-gate`** always runs (`if: always()`). It passes only if `plan` succeeded and every shard succeeded, or the shards were skipped because `count` was 0.
    - **`map`** runs only on pushes: `trommel graph --out .trommel/map/map.json`, then `actions/cache/save` under `trommel-map-<sha>`.
  - **Finding the map.** `plan` restores with key `trommel-map-<sha>` and `restore-keys: trommel-map-`, so a pull request gets the newest map saved on `main`. If no cache matches, the CLI's run-all fallback applies.
  - **Plan and map share one Node version** (`NODE_VERSION`, 26) and one runner image. The map records the runtime and platform as `e:` nodes that every test depends on, so a mismatch would mark every test affected.
  - **Exact file lists, until M3.**
    - The shard passes `TROMMEL_TEST_FILES`, a JSON array of repository-relative POSIX paths, and `vitest.config.ts` makes it the `include` (`scripts/lib/test-files.ts`).
    - Each path is glob-escaped: what tinyglobby, Vitest's globber, escapes, plus `!`, `+` and `@` everywhere.
    - `exclude` is emptied, so nothing can drop a listed file.
    - A list that is invalid, or that names something that is not a file, fails the shard loudly. Uncertainty means run: a shard must never run fewer files than its plan.
  - **`trommel.config.json`.**
    - `sharding.max` is 3: the 29 test files split round-robin into 3 shards.
    - One `inputs.declared` rule: `packages/cli/src/**` affects `packages/cli/test/cli.test.ts`. That test runs the CLI as a child process, by path, which the static graph cannot see. Core changes reach the CLI sources through their imports, so one rule covers both packages.
  - **Global inputs avoid `new URL(…, import.meta.url)`.** The resolver reads it as an import it cannot resolve (§11 of the hand-off). In `vitest.config.ts`, which every test depends on, that would mark every test affected on every change. Both new files use `import.meta.dirname` instead.
  - **Not yet:**
    - `trommel-gate` is not a required check. That is a branch-protection setting for Ojas to decide ([HANDOFF.md](HANDOFF.md) §10).
    - The gate is a shell step until `trommel gate` exists.
    - Shards are round-robin, not duration-balanced; LPT planning (§3.8) needs recorded durations.
- **Evidence.**
  - **Discovery matches Vitest.** With no `projects` in the config, `trommel plan` finds the same 29 files as `vitest list` under `vitest.config.ts`.
  - **Run-all fallback.** With no map, `trommel plan` exits 0, writes `count=29` and 3 shards, and the summary says it could not use a map.
  - **A past fix, re-planned.** A map built at the parent of `4742257` (a fix in `packages/core/src/git/git.ts`), planned at `4742257`, selects 9 of 27 test files, with why-paths. One of the 18 would-skips was `cli.test.ts`, which drives `git.ts` through the CLI, hence the declared rule.
  - **A probe on this branch.** A throwaway commit adds one line to `git.ts` on top of this branch, made with `git commit-tree` so no branch moves. Planned against this branch's map, it selects 10 of 29, `cli.test.ts` among them, through `g:declared:packages/cli/src/**`.
    - Before the switch to `import.meta.dirname`, the same probe selected all 29, through the uncertain `vitest.config.ts`.
    - After it, the map has 18 uncertain files, all of them lexer fixtures that are data.
  - **The file-list mechanism.** `scripts/test/test-files.test.ts` covers parsing, escaping, and two end-to-end `vitest list` runs:
    - one through this repository's `vitest.config.ts`;
    - one over names such as `a[1]`, `b(x)`, `!f`, `g+(h)` and `i@(j)`, plus `l*`, `m?` and `n|o` off Windows, each with an unlisted twin that the unescaped name would match as a glob.

    Mutants that skip escaping, or escape only brackets, fail both end-to-end runs. A config that ignores the list fails the first.
  - **In CI (done when, met 2026-11-13).**
    - **No map yet.** #13's run 43435242836 missed the cache, ran all 29 files in shards of 10, 10 and 9, and the gate passed. The Windows job then caught a test-only path bug: `os.tmpdir()` is an 8.3 short path there.
    - **Map cached.** The merge's push run 43435914996 built the map in 153 ms (1,464 nodes, 2,804 edges) and cached it as `trommel-map-f065f80…`, 39 KiB.
    - **Shadow summary.** #14's run 43479358998 restored that map. Static reachability would run 11 of 29 test files, each with a why-path, and skip 18 (unproven), as the local dry run predicted.

## 26. A directory named by `new URL(…, import.meta.url)` is a dependency

- **Context.** The lexer records `new URL(spec, import.meta.url)` as a `url` record, so assets next to a module are dependencies. When `spec` named a directory (`'.'`, `'..'`, `'./fixtures/'`), the resolver found no file and reported it as unresolved ("not found"), which made the file uncertain: every test reaching it always ran.
  - Day 10 hit this in `vitest.config.ts`, a global input, where it would have selected every test on every change (entry 25).
  - On honojs/hono it made test files uncertain whose only problem was a fixtures directory.
  - The same pattern written as `import.meta.dirname` was invisible altogether, so the stricter treatment fell only on one spelling.
- **Decision.**
  - **A directory URL** depends on every file below it, since the code may read any of them. The resolution's targets are those files, recorded as a glob over `<dir>/**` (`g:glob:<dir>/**`), so a file appearing there changes the glob's hash. `'..'` up to the repository root gives `**`, every file.
  - **Directory names are glob-escaped.** The dialect has no escape character, so `escapeGlob` writes `*`, `?` and `[` as one-character classes, `{` as a one-option brace, and a leading `!` as a class.
  - **A missing target** is recorded as a directory that may yet appear (a `d:` node), as for imports.
  - **Symlinks and submodules below the directory.** A symlink to a file is followed, and both count. A symlink to a directory or out of the repository, or a submodule, leaves the URL unresolved: what the code could read below it cannot be listed.
  - **Selection (L1).** An added file that a glob of the map matches no longer escalates its package. It shows in Δ as that glob's changed hash, which selects exactly its dependents, like a new module's probes. This covers directory URLs, `import.meta.glob`, `inputs.global` and declared inputs. A new file no glob matches still escalates.
  - **The engine stays `trommel-static-1`.** The planner never re-resolves at H: it trusts the map's edges and only recomputes node hashes, whose definitions did not change.
    - An old map read by the new planner selects what the old engine would have.
    - A new map read by an old planner uses the same glob dialect, and escalates more, not less.
    - So `ENGINE` changes when hash definitions or the reading of a map change, not when the builder becomes more precise.
  - **Code that walks out of the directory** (`new URL('.', import.meta.url)` and then `../src`) reads files this does not record. Like any `fs` read, that is why every would-skip stays unproven until records exist (M2/M3).
- **Evidence.**
  - **Resolver examples:** a file, a directory with or without a trailing slash, `'.'`, the root, `app/[slug]`, a symlink to a file, symlinks to a directory and out of the repository, a missing path and a path outside the repository.
  - **Evidence-completeness property.** It now also runs over `url` records, with directory specifiers added. It caught a mutant that dropped the "may yet become a directory" record: an absent target that became a directory changed the result unseen.
  - **`escapeGlob` properties:** 2,000 pairs of paths built from glob characters. The escaped glob matches exactly its path, and with `/**` exactly the path and what is below it, never as an exclude.
  - **Selection examples:** the importer is not uncertain; a file changing below the directory selects it with a why-path; a file appearing selects it with no escalation; a new file outside any glob still escalates; the directory appearing selects it through `d:`.
  - **7 hand mutants were all caught:** no escaping; no "may yet become a directory"; no glob; symlinks not checked; files not targets; the L1 exemption dropped; every added file exempt.
  - **On hono** at `f6fbaf02`, uncertain files fall from 45 to 44. Nodes rise from 3,288 to 3,377 and edges from 13,543 to 14,453.
    - `adapters/deno/test/serve-static.test.ts` now depends on `adapters/deno/test/**`.
    - `build/declaration-emit.test.ts` depends on its fixtures directory, and on `**` through `new URL('..', import.meta.url)`, which names the repository root.
  - **On this repository**, `vitest.config.ts` keeps `import.meta.dirname`. A root-directory URL in a global input would now be a dependency on every file, which still selects every test on any change.

## 27. The foundation review, and seven ADRs corrected in place (2026-11-13)

- **Context.** Before M2 starts writing records, Ojas asked for a read-only review of the architecture, the ADRs, the roadmap, the threat model and the merged code. ADRs can be corrected in place only until 2026-11-16 (entry 1).
  - The review is [docs/research/2026-11-foundation-review.md](docs/research/2026-11-foundation-review.md). It read `main` at `86a995e`, before day 10 (entry 25) and the directory-URL fix (entry 26) merged.
  - Its verdict: the foundation is sound enough to build M2 on, if seven contracts are corrected before records exist. It has 3 critical, 4 high, 8 medium and 7 low findings (C1–C3, H1–H4, M1–M8, L1–L7).
- **Decision.** Ojas approved the seven ADR corrections on 2026-11-13. Each ADR's status line names the findings behind it.

  | ADR | What changed | Findings |
  |---|---|---|
  | 0003, graph nodes | Environment components are record attributes, not nodes. Resolution hubs (`r:` for one resolved path, `c:` for one directory's config chain) are node kinds. Provenance is a bitmask. `u:` is an uncertain file | C3, M1, M3 |
  | 0004, selection unit | The runner, not Trommel, decides what a test file is. `trommel run` also runs every discovered file the plan does not mention. A plan that knows no tests runs the command unfiltered | C2 |
  | 0005, safety criterion | A record is self-contained: closure as (node, hash) pairs, digest, environment, engine and recorder versions, completeness flags, time. Validity is base-free. The environment is compared in the job that runs the test. Capture has three scopes (test file, worker, run), and the runner reports its effective configuration. Uncertain nodes and unmapped inputs override a record | C1, C3, H1, H4 |
  | 0009, SMAP | A container with a section table and a trailer; three layers (snapshot, static graph, records); one provenance byte per edge; forward adjacency only; UTF-16 key order; chunking defined in M5 | C3, M2, M4 |
  | 0012, trust lanes | Three lanes: evidence, pull request, untrusted. Only runs of reviewed code change shared state. A pull-request run is evidence for its own pull request only, whoever its author is | H2 |
  | 0014, flake decisions | An observation counts toward shared state only on inputs the default branch has had, or together with a flaky failure from the default branch or a second pull request. A burst of flips in one job is an environment incident | H3 |
  | 0021, Lite mode | The cache trust model, from GitHub's documented scoping rules. Keys carry the format version and the environment cell. Only the map job has `cache-mode: write`. The map names its origin. Proofs are unsigned | M5 |

- **What this settles.**
  - **Entry 16, provenance width:** one byte per edge with three bits defined, as the code already has it. ADR-0009 no longer says 2 bits.
  - **Entry 17, probe-edge volume:** exact hub nodes. Measured at 10,000 files, probes are 84% of the 684,501 edges and 91% of the 106,390 nodes. A hub's evidence depends only on its path or directory, never on the importer, so nothing is lost. Not built yet.
  - **The day-9 `u:` rule** (entry 23): every uncertain file counts as changed in every plan. It is now in ADR-0005, and it stays past M3 unless a record carries resolution evidence for that importer. The exemptions of new modules and of glob-matched new files from L1 (entries 24 and 26) are sound only under this rule.
  - **The day-9 lockfile rule** (entry 23): the review recommends confirming that an unparseable lockfile escalates to L3 only when it changes. The code is unchanged, and the confirmation is still Ojas's ([HANDOFF.md](HANDOFF.md) §10).
- **How it meets entry 26.** Entry 26 keeps `trommel-static-1` when the builder only becomes more precise. The review asked for a guard that fails when the map of a fixture changes and the engine id does not. ADR-0009 now takes both: a changed golden hash comes with a new engine id, or with a recorded reason why older maps stay safe. Once records exist, ADR-0005 makes a record invalid when the engine or recorder version differs from the planner's.
- **Where the code lags the corrected ADRs.** Nothing below is a live fault: every plan is still shadow-only and every would-skip unproven.

  | The ADR now says | The code today | When |
  |---|---|---|
  | The static map holds nothing about the builder's machine | `e:runtime` and `e:platform` are nodes, so one tree gives different bytes on Linux and Windows | M1, with SMAP v0 |
  | An unmapped input makes every node of its owning package changed; a changed node no test reaches is an unmapped input | L1 forces only tests under the owning package's path; a changed module nothing reaches does not escalate | M1 |
  | Resolution hubs | One edge per probe | M1, with SMAP v0 |
  | SMAP container, snapshot and static layers | Canonical JSON map (entry 23) | M1, week 3 |
  | Self-contained records, three capture scopes, reported configuration, resolution evidence | No recorder yet | M2 |
  | `trommel run` reconciles with the runner's discovery, and checks the shard's environment and tree | Shards run exactly `TROMMEL_TEST_FILES` (entry 25); the plan measures the environment in its own job | M3 |
  | Record layer in SMAP; base-free proofs; the Lite key layout, `cache-mode` and origin check | `trommel.yml` saves `trommel-map-<sha>` and restores by prefix | M3 |
  | Lanes from verified claims | No server | M5 |
  | Observation scoping and the burst guard | No ledger | M7 |

- **Not decided.** These findings are recommendations until Ojas takes them up; the review's §2 has the evidence for each.
  - **M6:** four dependencies the static extractor drops without a `u:` node: a file kind it cannot lex (`.vue`, `.svelte`), a `file:` link dependency, a workspace package shadowed by a nested installed copy, and `createRequire` under another name.
  - **M7:** K1 is ambiguous as written and needs about 300 faulty changes to bound a 1% miss rate; the corpus collector keeps no logs, so it cannot name the test that flaked.
  - **M8:** `generated` rules cannot hash outputs in a plan job that builds nothing; they have to map outputs to inputs.
  - **L1–L7:** map consistency checks, glob node keys, resolver evidence for `ownerDir`, file lists out of the job outputs, `package.json` field hashing, default tracked environment variables.
  - The review's recommendations for [HANDOFF.md](HANDOFF.md) §10 and its nine questions for the owner.
- **Evidence.** All in the review, with the inputs to rebuild each probe.
  - `npm test` at `86a995e`: 395 tests in 28 files pass.
  - A synthetic 10,000-file monorepo reproduces the recorded benchmark exactly. A plain binary layout of that map is 2.2 MB against 26.7 MB of JSON, and the reverse index derives from the forward arrays in 2.7 ms.
  - 12 probes of the real `buildStaticMap` and `selectStatic`, built with the `fakeRepo` test helper.
  - GitHub's dependency caching reference, read on 2026-11-13: a pull request's cache is scoped to its merge ref, and only trusted triggers can write the default branch's scope.

## 28. The environment leaves the static map; the engine is `trommel-static-2` (2026-11-14)

- **Context.** ADR-0003 and ADR-0009, as corrected on 2026-11-13 (entry 27), make the static map a function of the tree, the config and the engine only. The code still did what entries 23 and 24 describe.
  - `buildStaticMap` added `e:runtime`, `e:platform` and one `e:env/<NAME>` node per tracked variable, with a DECLARED edge from every test. `selectStatic` recomputed them at the head.
  - The review's probe built one tree with a `linux-x64` and a `win32-x64` environment. The two maps differed, in `e:platform` only. M1's exit criterion is a byte-identical map across OSes.
  - The nodes described the machine that ran `trommel plan`, not the shard that runs the test.
  - This is item 2 of [HANDOFF.md](HANDOFF.md) §1.1.
- **Decision.**
  - **Neither the map nor a static plan knows the environment.** `StaticInput.env` and `HeadState.env` are gone, and so is the `e:` branch of Δ(S,H). A plan is a function of the map, the head tree and the config.
  - **Nothing compares environments until M3.** A change of Node version or OS between the map and the plan no longer selects every test.
    - That loses no safety. Every would-skip is unproven and shadow-only, and the old comparison was made on the wrong machine.
    - ADR-0005 puts the comparison in the job that runs the test. `trommel run` does that in M3.
  - **`environment()` and `envHash()` stay, for the M2 recorder.** They moved to `packages/core/src/environment.ts` and have tests of their own. Nothing calls them yet.
  - **`env.track` is validated and not used.**
    - It joins `generated`, `quarantine` and the other keys that the M1 CLI checks without using (architecture §5.1). Tracked variables belong to a record, so the M2 recorder is their next reader.
    - `Rules.track` is removed, since nothing read it.
    - Changing `env.track` still runs everything once, like any change to `trommel.config.json` (L3).
  - **The engine id becomes `trommel-static-2`.** Entry 26's rule is that the id changes when hash definitions or the reading of a map change. Here the reading changes.
    - **An older map read by this planner:** its `e:` nodes would never change. The plan would ignore a dependency the map declares, and select fewer tests than the engine that built the map.
    - **A new map read by an older planner:** it finds no `e:` node and compares nothing, without saying so.
    - **Cost:** one run-all plan per cached map. The plan gives the cause: the map was built by engine "trommel-static-1", expected trommel-static-2.
    - `MAP_VERSION` stays 1: the fields and their layout did not change.
  - **The golden map** (`packages/core/test/graph/golden.test.ts`) is ADR-0009's cross-OS check, ahead of SMAP v0.
    - It builds the map of an in-memory repository with `fakeRepo` and pins the SHA-256 of its canonical JSON. `ci.yml` runs it on Ubuntu with Node 22, 24 and 26, and on Windows with Node 22.
    - **The engine id is pinned next to the hash.** A change to the hash is reviewed like a snapshot: it comes with a new engine id, or with an entry here saying why older maps stay safe to plan from.
    - **The fixture has every node kind the builder gives today:** files with modes `100644`, `100755` and `120000`, absent paths, directory listings, the workspaces set, an `import.meta.glob`, a directory URL, global and declared inputs, npm packages with a missing dependency, and two uncertain files. Two file names sort differently by UTF-16 code unit and by code point, and one is above U+FFFF.
    - Two more assertions say what a failure means before anyone compares hashes: the node count per kind, and the uncertain files and provenance values present.
    - Resolution hubs and SMAP v0 will each change the hash. Each then has to answer the engine question.
  - **A lint rule keeps the machine out.** Under `packages/core/src/{graph,lex,lockfile,resolve,select}`, ESLint rejects the `process` global and imports of `node:os`, `node:process` and `environment.ts`.
    - The golden map catches a dependency on the OS or the Node version, because CI varies both. It cannot catch an environment variable.
    - `core/src/git` is left out: it runs git.
  - **Superseded in earlier entries:** the `e:` node kind and its DECLARED edges (entry 23); recomputing `e:` nodes in Δ(S,H) (entry 24); "plan and map share one Node version" (entry 25); the first row of entry 27's table of where the code lags.
- **Evidence.**
  - **Same bytes on two systems, before any CI run.** The fixture's map hashes to `7ec52403…5c7fb7` on Windows 11 (x64, Node 26.4) and on Ubuntu under WSL (x64, Node 22.22). That Ubuntu's Node is built without TypeScript support, so it ran a type-stripped copy of the same sources. Entry 30 renamed the engine id, which moved the pinned hash to `6ef757a6…d14aa1` and changed no other byte.
  - **10 hand mutants, all caught.**
    - By the golden map and `static.test.ts`: an `e:platform` node with an edge from every test; an `e:runtime` node with no edge.
    - By the golden map: the engine id set back to `trommel-static-1`.
    - By lint: `static.ts` reading `process.platform`; `static.ts` importing `environment.ts`; `plan.ts` importing `node:os`.
    - By `environment.test.ts`: the patch version kept in `runtime`; an unset variable read as empty; `envHash` returning the value; `environment()` ignoring the process it is given.
    - By `config.test.ts`: `env.track` passed through to the rules.
  - **`trommel graph` on this repository** at `4c89e79` emits no `e:` node. The map goes from 1,465 nodes and 2,807 edges to 1,463 and 2,749: two nodes, and two edges for each of 29 tests.
  - **The synthetic 10,000-file repository** goes from 106,390 nodes and 684,501 edges to 106,388 and 683,501. `bench/static-graph.ts` runs without an environment; its recorded timings were not measured again.
  - **An older map.** A map of this repository relabelled `trommel-static-1` gives a run-all plan with exit 0 and the cause above.
  - **The soundness property** of entry 24 still passes its 2,000 runs. Its oracle never looked at the environment.
  - 449 tests in 31 files pass. Lint, typecheck and the zero-dependency check are clean.

## 29. Unmapped inputs follow the graph, and a changed node that no test reaches escalates (2026-11-14)

- **Context.** ADR-0005, as corrected on 2026-11-13 (entry 27), calls two things unmapped inputs: a changed file that is not a node, and a changed node that no test reaches. Every node of the owning package then counts as changed. The code still did what entry 24 describes.
  - L1 forced only the tests whose path lay under the owning package. In the review's probe 1, a changed `packages/db/migrations/001.sql` forced `packages/db`'s tests and left the api test that imports `db` a would-skip.
  - A changed module that no test reached selected nothing. On this repository that was how `packages/cli/src/cli.ts` went unseen until entry 25 declared it by hand.
  - `parseMap` accepted a `u:` node with no entry in `uncertain`, and plans seeded only the entries (review finding L1).
  - This is item 1 of [HANDOFF.md](HANDOFF.md) §1.1. Ojas chose on 2026-11-14 to escalate by default rather than only report (§10, question 9).
- **Decision.**
  - **A changed node that no test of the map reaches is an unmapped input.**
    - Reach is judged in the map's graph from the map's tests, not H's, so a deleted test reaches its own node and does not escalate.
    - Every node kind counts: files, directory listings, globs and packages. A lockfile bump of a package that no test imports (eslint, for one) escalates the root and runs everything. That is the review's probe 4: a runner preset named only in config.
    - A `u:` node is never a change. It is a seed of every plan regardless (entry 23), and counting it here would escalate every uncertain fixture on every plan.
  - **The owning package is the deepest workspace member that holds the path, or the root.** `Resolver.packageOf` reads the members from `workspaces` or `pnpm-workspace.yaml`, named or not.
    - Entry 24 used the nearest `package.json`. That is right for module resolution, which keeps using `ownerDir`, and wrong here: a fixture repository with its own `package.json` became a package with no tests. On this repository's history, `7e7c6c2` modified `packages/core/test/fixtures/resolve/misc/_expected.json`, which `resolver.test.ts` reads through `fs`. The old planner escalated `packages/core/test/fixtures/resolve/misc` and forced no test. The new one escalates `packages/core`.
    - A `package.json` that is no workspace member (a fixture, a `type` marker, a tool folder) does not start a package. A workspace list that cannot be read gives no members, so everything belongs to the root.
    - A glob has no path of its own, and its matches can lie anywhere, so an unreached glob belongs to the root.
  - **L1 seeds the graph.** Every node whose path is the package directory or below it counts as changed: files, listings, `u:` nodes and install locations. A test reached only through them is forced, with the L1 cause and a why-path that ends inside the package. This is a superset of the old rule, since each test's own node lies under its package.
  - **`inputs.ignore` covers both kinds of unmapped input, by path**: a file's path, a listing's directory, a package's install location (`node_modules/eslint`). A glob cannot be ignored. The plan JSON and the summary list every path it exempted (`ignored`), so nothing escalates or disappears without a line in the summary.
  - **Every `u:` node seeds the plan**, and `parseMap` rejects a `u:` node without causes and causes for a node that is not `u:`.
  - **This repository's `inputs.ignore`** is the default list plus `bench/**`, `scripts/check-*.ts` and `eslint.config.js`. Benchmarks, the CI guards' entry points and the lint config are read by no test; the guards' logic in `scripts/lib/` is tested and stays mapped. The declared rule of entry 25 stays: a core change reaches `cli.test.ts` only through it, because core's own tests reach core's nodes.
  - **The engine stays `trommel-static-2`** (entry 26's rule). The map's bytes and the meaning of every field are unchanged; the planner only escalates more. An older map read by this planner selects at least what the old planner did. The golden hash of entry 28 does not move.
  - **Not done here:** the review's DECLARED edge from every test to its runner's package node. Vitest is reached through the tests' own imports on this repository, and an unreached runner package now escalates instead of being missed.
  - **Superseded in earlier entries:** L1 as "every test under the owning package (the nearest `package.json` at H)" (entry 24); the second row of entry 27's table of where the code lags.
- **Evidence.**
  - **Examples** in `plan.test.ts`: probe 1 across workspace packages, with why-paths; a fixture `package.json`; an unreached module in a package and at the root; an unreached package and an unreached glob; `inputs.ignore` over all three kinds, with `ignored`; a deleted test; an uncertain file that nothing reaches; a map whose `uncertain` was emptied. `packageOf` has examples of its own, nested members and an unreadable workspace list included. `forwardReach` has a 2,000-run property against the closure oracle of `graph.test.ts`.
  - **16 hand mutants, all caught:** reach judged from H's tests; `u:` nodes counted as changes; the nearest `package.json` as owner; L1 forcing only tests under the scope; ignore not applied to unreached nodes; unreached globs skipped; packages without a path; the unreached rule removed; seeds only from causes; both `parseMap` checks dropped; the shallowest member winning; unnamed members dropped; `forwardReach` following dependents; the report without the through-path or the ignored list.
  - **The soundness property** of entry 24 still passes its 2,000 runs. The new rules only add selections.
  - **This repository's last 70 non-merge commits**, each planned from a map of its parent, with the old planner and the new one on the same map. Of 1,597 possible test-file runs:

    | Planner | Unreached rule fires | Selects more than the old one | Runs everything | Test files selected |
    |---|---|---|---|---|
    | Old | — | — | 15 commits | 483 (30%) |
    | New, default `inputs.ignore` | 5 commits | 6 | 17 | 551 (35%) |
    | New, this repository's `inputs.ignore` | 3 commits | 4 | 11 | 416 (26%) |

    - With the repository's list, the rule fires on `packages/cli/src/cli.ts` and `main.ts` (two commits from before entry 25's declared rule) and on `tools/corpus/src/main.ts`. Each escalates its own package and adds 2 or 3 tests. The fourth commit that selects more is `7e7c6c2`, the fixture above.
    - `bench/**` also takes four commits out of the run-all set. Each added a `bench/results/*.json` file, which is not a node, so the old L1 escalated the root.
    - The review estimated 14 of 70 at `86a995e`, counting commits that touched one of 16 unreached modules. This window ends 23 commits later, and three things keep the rule quieter than that. Entry 25's declared rule now reaches the CLI sources. An added module is not in the map, so it never fires the rule (it is exempt from L1 as in entry 24). And a commit that escalates to L3 stops before L1.
    - No commit in the window changed `package-lock.json`, so the package rule has no history here.
  - 473 tests in 31 files pass. Lint, typecheck and the zero-dependency check are clean.

## 30. The name is Trommel (2026-11-14)

- **Context.** The project was built under the codename SIEVE, and entry 4 left the final name to M9. "Sieve" was never available: the npm name `sieve` is taken, Sieve Labs is an existing company, SIEVE is an NSDI'24 cache-eviction algorithm, and Sieve is the RFC 5228 mail-filtering language. Ojas asked to settle the name now, before M2 writes the first record and before anything is published.
- **Decision.**
  - **The name is Trommel.** A trommel is a rotating drum sieve, so the project keeps its metaphor. The GitHub organisation is `trommelci`, holding `trommelci/trommel` and `trommelci/trommel-corpus`. The npm organisation is `trommel`, and the packages are `@trommel/*`, still `"private": true` until the first publish. Ojas registered both organisations on 2026-11-14.
  - **Every identifier is renamed, not only the prose:**

    | Was | Is |
    |---|---|
    | SIEVE, Sieve (prose, `SieveMap`, `SieveConfig`, `Sieve-Protocol`) | Trommel (`TrommelMap`, `TrommelConfig`, `Trommel-Protocol`) |
    | the `sieve` command | `trommel` |
    | `@sieve-ci/*`, `sieve-monorepo` | `@trommel/*`, `trommel-monorepo` |
    | `sieve.config.json`, `.sieve/map` | `trommel.config.json`, `.trommel/map` |
    | `SIEVE_*` environment variables | `TROMMEL_*` |
    | `.github/workflows/sieve.yml`, job `sieve-gate`, cache key `sieve-map-<sha>` | `trommel.yml`, `trommel-gate`, `trommel-map-<sha>` |
    | engine id `sieve-static-2` | `trommel-static-2` |
    | `ojassug/sieve`, `ojassug/sieve-corpus` | `trommelci/trommel`, `trommelci/trommel-corpus` |

  - **The old name stays only where it names something else**: the npm package `sieve`, the NSDI'24 algorithm and RFC 5228 (architecture §8.1 risk 10 and §9 item 9), plus this entry and the README's naming note. Earlier entries and the other documents now use the new names, also for things that existed under the old ones (cache keys, engine ids, run summaries). This table maps them back.
  - **The engine id changes, and the map format does not.** The golden map's pinned hash moves from `7ec52403…5c7fb7` to `6ef757a6…d14aa1` (entry 26's rule: a moved hash comes with a new engine id). Putting `sieve-static-2` back into the new bytes gives the old hash exactly, so the engine id is the only byte that changed. Entry 28's cross-OS evidence therefore carries over.
- **Consequences.**
  - **One run-all plan per branch after the merge.** A map cached as `sieve-map-*` is not restored under the new key prefix, and an old map would fail the engine check anyway. The first push to `main` after the merge caches a `trommel-map-*` map.
  - **Moving the repositories, in order.** The corpus repository's `collect.yml` calls `trommelci/trommel/.github/workflows/corpus-collect.yml@main`, and that only resolves once the main repository is `trommelci/trommel`. Ojas renames and transfers both repositories first, and then the two rename PRs merge: this repository's, and the one in the data repository that changes `README.md`, `collect.yml` and `docs/verification.md` to match `tools/corpus/corpus-repo` (the templates check compares them byte for byte). GitHub redirects the old URLs, so links and PR numbers stay valid.
  - **Answered here:** architecture §8.3 question 2 (the name and npm scope) and question 3 (the org: `trommelci`, before M6); HANDOFF §10 question 4.
- **Evidence.** A trademark screen on 2026-11-14, not legal clearance. A formal check stays on M10.
  - **USPTO** (tmsearch.uspto.gov): no live TROMMEL mark in Nice classes 9 or 42.
  - **TMview** (EUIPO, UKIPO, WIPO and the national offices; 165 results): no live plain TROMMEL mark for software. The live marks in classes 9 and 42 are compound words (softTrommel washing machines, Trommelflex cable drums) or mining equipment (The Trommel Shop, in Australia and India).
  - **Products and packages:**
    - No software product uses the name. CERT/CC's TROMMEL firmware-triage script has been dormant since 2020.
    - npm `trommel` and the `@trommel` scope, crates.io and Homebrew were free.
    - PyPI `trommel` is an unrelated data-cleaning library.
  - **Ruled out:**
    - Tamis: tamis.app is a live French application-security product.
    - Alibi: USPTO registration 6689301, Seldon, classes 9, 35 and 42.
    - Weir, Idem, Sequent, Lacuna, Riffle and Searce: live marks in classes 9 or 42.
    - Probity: two active 2026 developer tools.
  - 473 tests in 31 files pass, with the re-pinned golden hash. Lint, typecheck and the zero-dependency check are clean.

## 31. The roadmap has no dates or commit budgets (2026-11-14)

- **Context.** The roadmap gave every milestone its weeks, its dates and a commit count: 640 commits over 26 weeks at about 25 a week, from Mon 2026-11-16. Other documents repeated the figures: "week 1" for the collector, "week 3" for SMAP, K1 on 2027-01-24, the pace row and risk 6 in architecture.md, and ADRs 0001, 0019 and 0020. Implementation started five days early (entry 1), so the calendar already disagreed with the work. Ojas asked to drop the dates and commit counts and keep only the milestones and what is left in them: being ahead or behind, or how many commits a milestone takes, doesn't matter; what each milestone has to deliver does.
- **Decision.**
  - **A milestone has a scope and exit criteria, and no dates or commit budget.** It is done when its exit criteria are met. The milestones keep their order, and the cut list, the K1 gate at the end of M4 and the pivot plan are unchanged.
  - **Removed:**
    - from [roadmap.md](docs/roadmap.md): the weeks, dates and commits columns, the total, the start date, the first steps' dates and commit count, K1's date and "if behind" on the cut list. Its header now says what is left in M1;
    - from [architecture.md](docs/architecture.md): the pace row (now this rule), risk 6 (now the scope), K1's date, "launch slips" in K3, "week 1" and "week 3";
    - "month 1", "week 8" and "week 17" from [threat-model.md](docs/threat-model.md) §2.4, which now names M1, M3 and M7;
    - the weeks from [README.md](README.md), [HANDOFF.md](HANDOFF.md), [bench/TARGETS.md](bench/TARGETS.md), [bench/README.md](bench/README.md) and [bench/CORPUS.md](bench/CORPUS.md);
    - the pace and commit figures from ADRs 0001, 0019 and 0020, corrected in place, which is still allowed before 2026-11-16. No decision changed.
  - **Kept, because none of them is a schedule:**
    - the roadmap's day numbers, which name M1's first ten steps and their branches (`m1/d09-cli`);
    - K1's threshold. TARGETS.md is pre-registered, and only the gate's date went;
    - the 4 clean shadow weeks before enforcement (M7, architecture §3.10, the threat model). That is an evidence window, and when to enforce is still open (HANDOFF §10 item 5);
    - K2's 7 days to root-cause an escape, the collector's daily cron and its backlog estimates;
    - the date until which ADRs may be corrected in place (2026-11-16), a rule about decisions, not about the plan;
    - dates that record when something happened.
  - **Records keep their wording.** Earlier entries in this log, and the dated reports in `docs/research/`, still say "week 1" or "week 3". Read "week 1" as the start of M1, and "week 3" (SMAP, the pnpm and yarn parsers) as later in M1.
- **Evidence.** A search of every Markdown file outside `docs/research/` for weeks, months, month-and-day dates, commits per week and commit counts. Every match left is in the "kept" list above, is part of a past entry here, or is not about the plan: CORPUS.md's R3 and M4's "≥200 commits" count commits of the repositories Trommel replays, Node's end-of-life dates are Node's, and "fell behind" or "behind an interface" are ordinary words.

## 32. Resolution hubs: `r:` and `c:` (2026-11-14)

- **Context.** ADR-0003, as corrected on 2026-11-13 (entry 27), makes resolution hubs node kinds. The code still recorded every probe as its own edge from the importer, as entries 17 and 23 describe.
  - The review measured probe evidence at 84% of the edges and 91% of the nodes of a 10,000-file map (its finding M3). Entry 17 had left the cost open, with per-directory "probe groups" as the lever.
  - On this repository, each file's own config chain was most of it: imports carry their extensions, but every file had an edge to each absent `tsconfig.json` and `package.json` above it.
  - This is item 3 of [HANDOFF.md](HANDOFF.md) §1.1. The review's finding L3 belongs with it: a leading-slash path, a bare import's root mocks and a leading-slash glob resolve against the importer's package root, and `resolve()` recorded nothing about how that root was found. Only the file's own config edges covered it, and a hub refactor would have dropped that cover.
- **Decision.**
  - **Two hub kinds**, each worked out once per resolver and shared by every importer:
    - `r:<path>`: what resolving that path probed. That is the exact path, the TypeScript source for a `.js` name, every extension, the directory with its package.json entry, and `index` with every extension. It depends on the path alone (`Resolver.probePath`).
    - `c:<dir>`: the tsconfig chain that governs files in that directory, and the nearest package.json at or above it, with every miss on the way up. It is the evidence `fileConfigs` returned for any file in that directory.
  - **A package directory's entries are sub-hubs.** `r:lib/pkg` links to `r:lib/pkg/main.js` and `r:lib/pkg/index`, because each is resolved as a path of its own. A cycle of `main` fields used to overflow the stack. It now ends at the hub still being worked out, and makes the result uncertain ("resolution cycle").
  - **A hub's hash covers which candidates exist; its edges carry what they hold.** The hash is SHA-256 of the canonical JSON of what the hub recorded itself: targets, absent candidates, configs, each probed directory with its listing hash, sub-hubs, reason and uncertainty. The hub has edges to the targets and configs that exist, so an edit to one changes that file's `f:` node and not the hub. **An absent candidate is no node at all.**
  - **The listing of a probed directory stays in the hash.** For an existing directory its own probes already cover every candidate, so this is wider than it has to be. It keeps exactly what the `d:` node gave: a file added to `src/d/` still selects the importers of `./d`. Narrowing it is a precision change, for later and with evidence.
  - **A hub that found only its own path, as an existing file, is linked as that file.** For `import './b.ts'` the importer's edge goes to `f:src/b.ts`. That file's hash changes whenever the path stops being exactly that file: when it is edited, deleted, turned into a symlink or directory, or hidden below a new symlink. A symlink whose target is missing keeps its hub, since the target may appear.
  - **An importer has one edge per hub**, plus edges for the evidence outside every hub: the workspace lookup (`g:workspaces`, `package.json`, `pnpm-workspace.yaml`), root mock listings, a workspace package's own package.json and its `exports` targets, URLs, globs and `__mocks__`. Every lexed file also has one edge to its own `c:` hub.
  - **`Resolution` still lists everything it recorded**, so its meaning is unchanged. It adds `hubs` and `direct`, the part outside the hubs. A property checks that `direct` plus every hub's evidence, followed through sub-hubs, gives back exactly the full lists.
  - **L3 is fixed.** Wherever the resolver uses the importer's package root (a leading slash, root mocks, a `#` import, a leading-slash glob), it now includes the importer's `c:` hub, whose package.json lookup is the same walk. The hub's tsconfig plays no part in that lookup, so an unreadable tsconfig does not make those imports uncertain. A bare import still is, as before: its `paths` are unknown.
  - **The plan recomputes hubs at H, and only when a listing changed.**
    - With `Resolver.hub(key)` over the head, it compares each hub's hash with the map's.
    - Nothing a hub's hash covers can change without a listing changing. A file that appears, vanishes or changes kind changes its directory's listing (entry 12), and the hash otherwise holds only names and listing hashes.
    - A config's contents can still change what a hub probes, but that config is one of the hub's edges, and its own node has changed.
    - So a plan for a change that only edits files recomputes no hub.
  - **An added file that a changed hub now finds is seen, not unmapped.** Before, it was a ⊥ node of the map. Now it is a target or config of the recomputed hub. L1 does not fire for it, and the hub's change selects the importers. This matters for files that are not modules: a new `src/b.json` beside `./b`, or a new `src/tsconfig.json`.
  - **Hubs have paths for L1.** An unreached changed hub escalates the package its path or directory lies in, and an escalated package seeds its hubs as well as its files.
  - **The summary hides the hubs between two files.** They only say that one file imports the other; the plan JSON keeps them. A hub at the end of a why-path is named for what it stands for: "resolution of `src/b`" or "configs of `src`".
  - **The engine becomes `trommel-static-3`** (entry 26's rule: the reading of a map changes). An older planner would never recompute a hub, and would miss a probe that appears. The new planner rejects an older map, which costs one run-all plan per cached map, with the cause given. `MAP_VERSION` stays 1: the fields and their layout are unchanged.
  - **The golden map** gains a package directory (`src/vendor/`, entry `main.js`), so its bytes pin a hub with a sub-hub and an inlined exact entry. Its hash moves from `6ef757a6…d14aa1` to `d648c838…806811`, with the new engine id. It has 68 nodes (7 `c:`, 3 `d:`, 28 `f:`, 5 `g:`, 6 `p:`, 17 `r:` and 2 `u:`), where the fixture without its two new files had 214.
  - **Superseded in earlier entries:**
    - entry 17's "every missing one an absent (⊥) node" and "any path probed as a directory is a `d:` node", for the probes now inside a hub, and its "cost, still to measure";
    - entry 23's edges from the importer to every absent path, `d:` directory and config, and to the file's own configs;
    - the third row of entry 27's table of where the code lags.
- **Evidence.**
  - **Tests.** Hubs in `resolver.test.ts`: the shared hub, a package directory with sub-hubs, the `c:` hub, uncertainty, the four L3 cases, the cycle, and the split property over 400 random repositories for static, URL and mock imports.
    - The evidence-completeness property now draws package.json files, so the package root moves, and has two more leading-slash specifiers. Before the fix it failed: adding `a/package.json` changed what `/x` resolved to.
    - `static.test.ts` pins hub edges and hashes, the inlined exact file and the dangling symlink. `plan.test.ts` covers probes that appear, non-module files and configs that appear, an unreached hub, and a symlink whose target appears.
    - The soundness property of entry 24 still passes its 2,000 runs. Its oracle shares no graph code and never knew how the builder factors edges.
  - **22 hand mutants, all caught.** Two survived the first pass and gained a test each: an unreadable tsconfig not making a bare import uncertain, and inlining a hub that has absent probes, which matters for a dangling symlink.
    - In the resolver: hub evidence not merged, or not marked as coming from a hub; a hub's reason or uncertainty dropped; the package-root lookup not recorded; no cycle guard, or a cycle that is not uncertain; the direct evidence keeping hub probes; the `c:` hub dropping package.json misses.
    - In the builder: never inlining; the hash without listings or without absent candidates; no edge to the file's `c:` hub, to sub-hubs or to configs.
    - In the planner: hubs never recomputed; files or configs that a changed hub finds not counted as seen; hubs without a path for L1.
    - In the report: hubs kept between files.
  - **This repository's last 70 non-merge commits**, each planned from a map of its parent, by `main`'s CLI and by this one. The selections are identical on all 70: 592 of 1,753 possible test-file runs, with the same L1 causes. Each map has about a third of the nodes and edges: at `65a5958`, 1,466 nodes and 2,790 edges become 514 and 1,044, and 263 KB becomes 142 KB.
  - **The synthetic 10,000-file repository**, measured the same day with `main`'s benchmark and with this one ([bench/README.md](bench/README.md)):

    | | Nodes | Edges | Map | CLI cold | Plan, an edit | Plan, a file added |
    |---|---|---|---|---|---|---|
    | `main` at `65a5958` | 106,388 | 683,501 | 26.7 MB | 2.5 s | 0.84 s | — |
    | With hubs | 20,107 | 145,041 | 7.1 MB | 1.8 s | 0.18 s | 0.36 s |

    - 9,520 `r:` and 520 `c:` hubs replace 86,802 absent files and 9,541 absent directories.
    - The review inferred about 100,000 edges. The rest are each importer's edge to its hub and each hub's edge to its target.
    - A plan where a file was added recomputes all 10,040 hubs, which costs 0.19 s more than one where a file was only edited.
  - **The golden map's bytes match on two systems before CI:** `d648c838…806811` on Windows 11 (x64, Node 26.4), and on Ubuntu under WSL (x64, Node 22.22), run there from a type-stripped copy as in entry 28.
  - 500 tests in 31 files pass. Lint, typecheck and the zero-dependency check are clean.

## 33. SMAP v0: the container, the snapshot layer and the static layer (2026-11-15)

- **Context.** [ADR-0009](docs/adr/0009-smap-binary-map-format.md), as corrected on 2026-11-13 (entry 27), makes the map a binary container with a snapshot layer, a static layer and, from M3, a record layer. The code still wrote the canonical JSON of entry 23.
  - This is item 4 of [HANDOFF.md](HANDOFF.md) §1.1, the last of the four M1 items that change what a map contains. M1's exit criteria name it: "byte-identical SMAP across OSes".
  - The ADR fixes the model and leaves the bytes to the builder. The design, with the approaches that were weighed, is [docs/superpowers/specs/2026-11-14-smap-v0-design.md](docs/superpowers/specs/2026-11-14-smap-v0-design.md); Ojas approved it on 2026-11-14.
  - It lands in two pull requests. **This entry is the first: the codec. Nothing calls it yet.** `trommel graph` still writes the JSON map and `trommel plan` still reads it. The cut-over is the next pull request.
- **Decision.**
  - **SMAP v0 is a serialization of `TrommelMap`, and nothing more.** `encodeSmap(map)` gives the bytes. `decodeSmap(bytes)` gives back the same map, a `Graph` built straight from the adjacency section, and the content address of each layer. The builder, the node model and the planner's rules are untouched, so the JSON map is the oracle for every test.
    - The other way considered was a new in-memory model read lazily from the bytes, with the planner rewritten against it. A plan takes 0.18 s at 10,000 files against a 1 s target, and M3 reshapes the planner around records anyway.
  - **The bytes are specified in [docs/smap-format.md](docs/smap-format.md),** with a test vector walked through byte by byte. In short: a header (magic, format, hash algorithm, engine id), a table of 16-byte entries, the section bodies and a SHA-256 trailer. `SNAP` is the snapshot layer. `META`, `KEYS`, `EDGE`, `HASH`, `GLOB`, `TEST` and `UNCT` are the static layer.
  - **One map has one encoding, and the decoder accepts no other.** Varints are in their shortest form, keys and paths strictly ascending, shared prefixes the longest possible, edge targets ascending and gap-coded, sections in a fixed order with no gap. So a file that decodes re-encodes to the same bytes, and a content address means "the same map". The one exception is an optional section the decoder does not know, which it skips.
  - **A hash is stored only where a plan cannot derive it.**
    - Not stored: `f:` (the blob id and mode are in the snapshot), `d:` (the listing is in the snapshot) and `u:` (the SHA-256 of its causes, which are stored).
    - Stored: every other kind, which today means `g:`, `p:`, `r:` and `c:`. **ADR-0009 listed "packages, globs and uncertain causes"; it is corrected in place to name the hubs.** A hub's hash depends on what its configs held at the base, and a plan in a depth-1 checkout cannot read those blobs.
    - A stored hash is absent, a SHA-256 as 32 raw bytes, or any other text. The third form is for package hashes: npm integrity strings, `link:` targets, or a version and a URL (entry 18).
  - **The encoder refuses a map whose derived hashes do not follow from its snapshot.** "The static graph is a function of the tree" (ADR-0003) is now a check at the point where a map is written, and it is what makes the round trip exact.
  - **Text is UTF-8, with an unpaired surrogate written as the three bytes of its code point.** ADR-0009 said "UTF-8"; it is corrected in place.
    - The lexer decodes escapes (entry 14), so `import './\uD800x'` gives the hub key `r:src/\uD800x`. The JSON map holds it as an escape. Plain UTF-8 would turn it into U+FFFD, and two different keys could become one.
    - A surrogate pair is always the four-byte form, so the encoding stays unique. Git paths cannot hold an unpaired surrogate; keys, glob patterns and uncertain causes can.
    - A leading U+FEFF is kept. `TextDecoder` drops it unless told otherwise, and a test pins that.
  - **Each layer has a content address:** the SHA-256 of the format, the hash algorithm, the layer number and the layer's sections with their table fields. The static layer's also covers the engine id. The snapshot layer's does not, so one tree has one snapshot layer under every engine. Addresses are derived from the file, never stored in it. Nothing uses them before M3.
  - **The engine id stays `trommel-static-3`,** which is entry 26's question answered. The builder gives the same graph: the pinned SHA-256 of the fixture's canonical JSON, `d648c838…806811`, did not move. The reading of a graph did not change either. The container has its own format number, and after the cut-over no plan crosses the change: an older planner cannot read a SMAP file, and the new one will not read a JSON map.
  - **The format number is 0.** The record layer will be new sections, not a new format. [smap-format.md](docs/smap-format.md) §7 says which number moves for which change.
  - **Smaller calls,** none of them in the ADR:
    - Each table entry has a `layer` byte, so a layer's address can be computed without knowing any tag.
    - `META` repeats the root tree, so a static layer names the snapshot it was derived from, and a mismatched pair is refused.
    - `config` is stored although the tree holds the file. `buildStaticMap` takes it as an input, and the round trip gives back what went in.
    - A mode is the varint of its octal number, which holds any mode a tree object can, where a five-value code would need an escape.
    - Provenance is one run of bytes at the end of `EDGE`. It is long runs of one value, and the decoder copies it into the graph in one step.
    - The magic follows PNG's (`\x89SMAP\r\n\x1a`), so a tool that treats the file as text damages it at once.
    - A map with an empty edge list (`{'f:x': {}}`) is refused. A decoded map never has one, so accepting it would break the round trip. The builder never makes one.
    - Every failure of the decoder is a `MapError`, worded as the reason after "the map is invalid:". The encoder throws `SmapEncodeError`.
  - **Around the codec.**
    - `Graph.fromForward` builds a graph from its names and forward arrays and derives the reverse index by counting. `GraphBuilder.build` is left as it is, so it stays an independent oracle for it.
    - `mapIndex` (the base snapshot of a map as a `TreeIndex`) and `objectTypeOf` (the object type a mode stands for) were private to the planner.
    - `packages/core/src/smap/` joins the lint rule of entry 28 that keeps `process`, `node:os` and `environment.ts` out.
    - `.gitattributes` marks `*.smap` binary.
    - The test helpers `fake-tree.ts` and `fake-repo.ts` can make SHA-256 ids.
  - **The golden files.** [smap-format.md](docs/smap-format.md) §6 has the values.
    - Vector 1 is a map written by hand that uses every section. `smap.test.ts` assembles its 460 bytes from hex, field by field, so the encoder is checked against the specification and not against itself.
    - Vector 2 is the golden repository of entry 28. Its file is committed as `packages/core/test/fixtures/smap/golden.smap` (3,779 bytes), and `smap/golden.test.ts` pins its length, its SHA-256 and both layer addresses, next to the engine id and the format number. It has a path above U+FFFF, sorted by UTF-16 code unit.
    - Vector 3 is a small SHA-256 repository.
    - **The JSON pin stays** in `graph/golden.test.ts`. It pins the builder; the new pins cover the encoding. When one file fails and the other does not, that says which side moved.
- **Evidence.**
  - **Tests.** 717 pass in 36 files, where there were 500 in 31. Lint, typecheck and the zero-dependency check are clean.
    - `smap/bytes.test.ts` (60), `smap/container.test.ts` (45), `smap/smap.test.ts` (91), `smap/golden.test.ts` (7) and `smap/fuzz.test.ts` (10); plus `Graph.fromForward` against the builder on 1,000 random graphs, and `mapIndex`.
    - **Round trip,** on 300 random maps that the builder makes from random repositories: the decoded map has the same canonical JSON, re-encoding gives the same bytes, and the decoded graph equals `mapGraph(map)` in all six CSR arrays.
    - **The generator is checked too.** A test asserts that those 300 maps include both object formats, a key with an unpaired surrogate, every lockfile state, an absent package, a symlink, a gitlink, an uncertain file and a config. It failed at first: the surrogate line had been written with the character itself, which UTF-8 encoding had already turned into U+FFFD.
    - **Refusals:** 47 ways a file is refused, 40 by changing one section of vector 1 and 7 by changing its section table; and 25 ways a map is refused by the encoder.
  - **Fuzzing.** Each input is refused with a `MapError`, or decodes to a map that re-encodes to exactly those bytes. No other error escaped.
    - Every prefix of vectors 1 and 2, with and without a recomputed trailer: 8,414 inputs, all refused.
    - Every single-byte change to vector 1 with the trailer recomputed: 109,140 inputs.
    - 3,000 random edits to vector 2; 6,000 inside one section with the table rebuilt, since an insert in the file never reaches a section reader; and 3,000 random section bodies.
    - A count of 2³² − 1 is refused at each of the seven places a count is read, before anything is sized by it.
  - **80 hand mutants, all caught.** 14 in the primitives, 16 in the container, 5 in the graph helpers, 39 in the codec, 3 in the allocation checks and 3 against the golden pins.
    - One survived its first pass and gained tests: bytes left over at the end of `SNAP`. Every section now has that test.
    - The fuzz tests alone, with every other test file left out, catch 30 of 40 dropped decoder checks. The other ten need several coordinated bytes (a SHA-256 in the string form, a surrogate pair as two surrogates) or are masked by a later check, and each has a targeted test.
  - **Found by the tests while they were being made to pass:** `ByteWriter` evaluated `this.buffer` before the call that could replace it, so a write that grew the buffer went to the old one.
  - **Size.** The golden fixture is 3,779 bytes as SMAP and 10,559 as canonical JSON. The 10,000-file numbers come with the cut-over, when the benchmark writes SMAP.
  - **The same bytes on two systems before CI:** all three vectors give identical lengths, hashes and layer addresses on Windows 11 (x64, Node 26.4) and on Ubuntu under WSL (x64, Node 22.22), run there from a type-stripped copy as in entry 28.

## 34. The map on disk is SMAP: the cut-over (2026-11-15)

- **Context.** Entry 33 built the SMAP v0 codec with no caller. This is the second pull request of the design ([docs/superpowers/specs/2026-11-14-smap-v0-design.md](docs/superpowers/specs/2026-11-14-smap-v0-design.md) §8): the CLI, the workflow and the benchmark move to SMAP, and the JSON reader goes. It finishes item 4 of [HANDOFF.md](HANDOFF.md) §1.1.
- **Decision.**
  - **`trommel graph --out <file>` writes a SMAP file. Without `--out` it prints the same map as canonical JSON.** The JSON is the view a person reads, and `>` writes it to a file. There is no `--format` flag: nobody needs SMAP on a terminal. The summary line on stderr says which was written and how many bytes.
  - **`trommel plan --map <dir>` reads `<dir>/map.smap`** and hands the decoded graph to `selectStatic`, which takes it as an optional fourth argument and builds the graph itself without one. A plan no longer parses JSON or rebuilds the CSR arrays.
  - **The file is `.trommel/map/map.smap`.** It is in the same directory as before, so the cache path in `trommel.yml` does not change. Nor does the cache key: its layout is M3's work under ADR-0021.
  - **`parseMap` and its 14 tests are removed.** After the cut-over nothing reads a JSON map, and a second reader of untrusted input with no caller is a liability.
    - Each refusal it made has a counterpart in the decoder: not JSON is "not a SMAP file"; the map version is the format number; the engine, the object format, a missing field, an edge to a missing node, a bad provenance, a test that is not a node and a malformed snapshot entry each have their check.
    - Two have none because SMAP cannot write them: a `u:` node without causes, and causes for a node that is not `u:`. `UNCT` holds one entry per `u:` node, in id order.
    - `MapError`, `mapGraph` and `mapIndex` stay. `mapGraph` is the oracle for the graph the decoder gives. `MAP_VERSION` stays as the version of the in-memory model and of its JSON.
  - **What a plan does with a map it cannot use is unchanged:** it runs every test, exits 0 and gives the cause. The causes now read "no map at .trommel/map/map.smap", "it is not a SMAP file", "its trailer is not the SHA-256 of its contents", or the engine mismatch of entry 28.
  - **The cost is one run-all plan per branch,** until a push to `main` caches a SMAP map. This change's own pull request is one of them. A cache saved before holds only `map.json`, which is "no map" to the new planner. An older planner on a branch that restores a new cache finds no `map.json` and also runs everything.
  - **`@trommel/core` exports the container functions** (`decodeContainer`, `encodeContainer`, `layerAddress` and the layer numbers), for the CLI's tests and for the tools that will read layers.
  - **Superseded in earlier entries:** entry 23's map file ("canonical JSON at `.trommel/map/map.json`") and its reader; entry 25's `trommel graph --out .trommel/map/map.json` in the workflow.
- **Evidence.**
  - **Tests.** 712 pass in 36 files: 726 before the reader's 14 went. Lint, typecheck and the zero-dependency check are clean.
    - `cli.test.ts`, end to end against a throwaway repository: the file starts with the SMAP magic and decodes to the map of HEAD; two builds of one revision are byte-identical; the JSON on stdout is the canonical JSON of the decoded file.
    - Eight fallbacks, each exiting 0 with every test planned and the cause in the plan, the summary and stderr: no map, a file that is not SMAP, a JSON map under the new name, an empty file, a file cut short, a file cut inside its header, a directory with only a stale `map.json`, and a map built by another engine.
    - A directory with both files reads `map.smap` and ignores the stale `map.json`.
    - `plan.test.ts`: a plan from the decoded map and graph equals a plan from the built map, and a graph with one edge removed selects otherwise, so the graph handed in is used and not rebuilt.
  - **4 hand mutants, all caught:** the plan ignoring the decoded graph, the plan still reading `map.json`, `--out` writing JSON, and stdout left empty.
  - **This repository's last 70 non-merge commits,** each planned from a map of its parent, by the CLI on `main` at `f672238` with a JSON map and by this one with a SMAP map. On all 70 the tests that would run, the why-path of each affected test and the escalations are identical: 640 of 1,973 possible test-file runs, 13 commits with an L1 escalation and no fallback. The 70 maps come to 9.81 MB as JSON and 3.26 MB as SMAP.
  - **The synthetic 10,000-file repository** ([bench/README.md](bench/README.md)), against the numbers of entry 32 on the same machine:

    | | Map | CLI cold | Writing the map | Plan, an edit | Plan, a file added |
    |---|---|---|---|---|---|
    | JSON map (entry 32) | 7.07 MB | 1.8 s | 0.08 s | 0.18 s: parse 0.06, select 0.12 | 0.36 s |
    | SMAP | 1.11 MB | 1.8 s | 0.09 s | 0.09 s: decode 0.05, select 0.04 | 0.24 s |

    - The map is 6.4 times smaller: 1,110,846 bytes against 7,069,025.
    - Decoding checks the trailer and every section, and gives the CSR graph. The select step no longer rebuilds it, which was half of its time.
    - On this repository the map is 48,609 bytes against 149,855.
  - **Not yet seen in CI:** `trommel.yml` with the SMAP map. Its first run on this change should show the run-all fallback with "no map at .trommel/map/map.smap", and the first push to `main` after the merge should cache a `map.smap`. Check both, as §7 of the hand-off did for day 10.

## 35. An external review of SMAP v0 (2026-11-15)

- **Context.** After entries 33 and 34, Ojas had SMAP v0 reviewed by Gemini in Antigravity, read-only, on `main` at `74ca9b4`. It confirmed that the tests pass, that the golden hashes hold, and test vector 1 ([docs/smap-format.md](docs/smap-format.md) §6.1) byte by byte by hand. It reported four findings. All four are fixed here, and none changes a byte of the format or anything a user would notice.
- **Decision.**
  - **1. The section count was not checked before use.** `decodeContainer` read the count and built the table from it at once, while §5 of the specification says every count is checked against the bytes left before anything is sized by it. The reviewer rated this Important. It is graded Minor here: the count is a u16, so at most 65,535 entries are ever made, and a file too short for them already failed with "ends early". It is a matter of conformance, not of safety. The decoder now refuses a count whose 16-byte entries the bytes left cannot hold: "it lists 65535 sections, more than the file can hold".
  - **2. The specification did not say that an edge list is never empty.** `encodeSmap` refuses a map that gives a node an empty edge list, because a decoded map never has one. §4.3 now says so: a node with no outgoing edge has degree 0 and no entry in the map's edge table.
  - **3. The specification did not say why `format` is 0 and the map's `version` is 1.** §2 now says that `format` numbers the file format, and that `version` (`MAP_VERSION`) numbers the in-memory model and its canonical JSON and is not stored in the file. This is as intended (entry 34).
  - **4. `npm run lint` scanned `.claude/` and `.superpowers/`.** ESLint does not read git's excludes, so in the main checkout it linted other sessions' worktrees under `.claude/worktrees/`, with over a thousand errors, and scratch files under `.superpowers/`. Both are now in `ignores` in `eslint.config.js`, in a commit of its own since it is outside SMAP.
- **Evidence.**
  - **Tests.** Still 712 in 36 files: the row "a section count the file cannot hold" in `container.test.ts` now expects the new message. It failed before the check was added, and again with the check removed by hand. Lint, typecheck and the zero-dependency check are clean.
  - **The format did not move.** No golden hash in `test/smap/golden.test.ts` or `test/graph/golden.test.ts` changed, and vector 1 is still 460 bytes.

## 36. pnpm and yarn lockfile readers (2026-11-15)

- **Context.** Until now a pnpm or yarn lockfile was `unparseable`, so any change to one escalated to L3 and ran every test. The design ([docs/superpowers/specs/2026-11-15-pnpm-yarn-lockfiles-design.md](docs/superpowers/specs/2026-11-15-pnpm-yarn-lockfiles-design.md)) reads all three formats into one resolved model, so that a bump of one package selects only the tests that reach it. This is the first of its two pull requests: the readers, with no caller. The cut-over to the builder and the planner is the second, and the engine stays `trommel-static-3` until then.
- **Decision.**
  - **One model, three readers.** `parsePnpmLockfile`, `parseYarnBerryLockfile` and `parseYarnClassicLockfile` each give a `ResolvedModel` (importers, entries, pnpm's own document) or an `Unparseable`. `lockfileFromModel` turns a model into the `Lockfile` interface: `p:pnpm:` and `p:yarn:` nodes, lookups, and name nodes `p:<kind>:<name>@*`. Each node's hash covers its outgoing edges. All of this is exported from `@trommel/core`.
  - **A strict YAML subset, written for these two formats** (`lockfile/yaml.ts`, 7.1 of the spec). Block mappings, scalar sequences, plain, single- and double-quoted scalars, and one-line flow collections nested to 8 levels. Anchors, aliases, tags, block scalars, tabs in indentation, duplicate keys and odd indentation are refused, each naming its line. One pass, an explicit stack for block depth, and recursion only in flow collections, which the limit bounds. Block mappings may nest 64 levels (`BLOCK_DEPTH`, where pnpm needs about 6), and deeper is refused with its line, because hashing the model recurses through what a reader copies: a pnpm `resolution` nested 2,000 levels deep overflowed the stack in `lockfileFromModel` (found by the whole-branch review). Every scalar is a string. A hostile file cannot reach a prototype: keys live in `Map`s, and the pnpm reader copies data with `defineProperty`.
  - **Fields the graph does not need are read past,** not validated: `cacheKey`, `languageName`, `linkType`, `bin`, `engines`, `os`, `cpu`, the importers' `specifier` and the rest. A reader that refused what it never uses would break on every new field a package manager adds.
  - **What is refused,** by `Unparseable` with the line or the reason: an unknown format (pnpm `lockfileVersion` other than `'9.0'`, Berry `__metadata.version` other than 8 and 10, classic without `# yarn lockfile v1`); YAML outside the subset; a duplicate key; a pnpm snapshot with no `packages` entry; a dependency with no version; a Berry entry with no `resolution`; a resolution or a descriptor that appears twice; more than two pnpm documents, or a first one that is not pnpm's own; a name listed twice in one classic block, or in two fields with references that resolve differently; merge-conflict markers, which no subset accepts, and which are named by line. `modelProblem` refuses an id that contains `@*` or is `#env`, an importer directory that is `.` or starts or ends with `/`, and a reference to an entry that does not exist (ruling R5): such an id would collide with a name node, and every reader calls it before returning.
  - **A reference the lockfile does not resolve points at the name node,** and does not refuse. A lockfile that breaks its own format's invariants is refused. One whose references legitimately leave it is read: zod's peers on its own workspace package, prettier's `resolutions` redirect.
  - **A root lookup that is not a node follows its name once the lockfile knows the name.** For `p:npm:node_modules/<N>` outside `nodes`, `hash()` and `dependencies()` answer with N's name node when an importer declares N or an entry has that name, and with nothing otherwise.
    - **Why:** the builder makes that key, with hash ⊥, for a bare import of a name the lockfile does not know (spec §6.4, case 3). When the importing file also resolves N to a file of the repository, through a root `__mocks__/N` or tsconfig `paths`, it is not uncertain, so the key is how a plan sees N arrive.
    - **Found by the whole-branch review:** before this, a test reaching such a file could be skipped when N first appeared through another workspace package, where npm's shadow rule runs it.
  - **Berry workspace entries are importers,** not entries, and their descriptors are links. Classic yarn has no workspace data of its own, so its reader takes a `ClassicWorkspace` (importers from the members' `package.json`, and the workspace package names). A declared name with no entry that is a member is a link.
  - **Totality is a tested property.** For each reader, 2,000 seeded mutations of every fixture (a cut, a deleted, duplicated or swapped line, a replaced character, or a block emptied under its key) give a model or `unparseable`, and nothing is thrown. 10,000 nested `[` are refused by the depth limit, and a 1 MB single-line value reads in one pass.
- **Evidence.**
  - **Tests.** 896 pass in 42 files, where there were 712 in 36 before. Lint, typecheck and the zero-dependency check are clean, and both golden hashes are unchanged.
    - `yaml.test.ts` (43), `model.test.ts`, `pnpm.test.ts` (26), `yarn-berry.test.ts` (23), `yarn-classic.test.ts` (36) and `fuzz.test.ts` (13).
    - Fixtures are small hand-built files: two pnpm shapes, Berry 8 and 10, and classic.
  - **Five real lockfiles, read with no refusal** (benchmark in [bench/README.md](bench/README.md), recorded in [bench/results/2026-11-15-lockfile-win32.json](bench/results/2026-11-15-lockfile-win32.json)):

    | Sample | Format | Bytes | Entries | Importers | References | Unresolved | Median of 5 |
    |---|---|---|---|---|---|---|---|
    | hono | pnpm | 332,558 | 1,075 | 9 | 1,522 | 0 | 10.7 ms |
    | zod | pnpm | 433,789 | 1,276 | 9 | 2,700 | 5 | 10.5 ms |
    | prettier | Berry | 364,006 | 1,027 | 1 | 1,795 | 1 | 7.8 ms |
    | es-toolkit | Berry | 583,970 | 1,647 | 5 | 2,659 | 0 | 15.9 ms |
    | excalidraw | classic | 481,747 | 1,331 | 0 | 2,667 | 0 | 9.9 ms |

    - The five unresolved in zod are its peers on its own workspace package. The one in prettier is `remark-parse` redirected to `trim` by `resolutions`. Excalidraw is read with an empty `ClassicWorkspace`, so its importer count is 0.
    - zod has 1,276 snapshots, where its `packages` section has 1,275 keys: peer variants share a base.
  - **78 hand mutants, all caught.** 10 in the YAML subset, 20 in the model, 23 in the pnpm reader, 9 in the Berry reader, 15 in the classic reader and 1 in the fuzz test.
    - **Three survived their first pass and gained tests:** the tab check in the YAML subset (the first test used two tabs, so the odd-indentation check masked it); the peer suffix cut at the first `(` anywhere, not the first after the version's `@`; and a four-space line outside a block in classic yarn.
    - **A fourth survived the fuzz test itself.** With the Berry check that a top-level value is a map replaced by a cast, so that a scalar value made `value.get` throw a `TypeError`, 2,000 runs passed. `fc.double` was drawing almost only values near 0, so every "random" line was the first one. Fractions now come from `fc.integer`, and the same mutant fails on its first counterexample, a cut at 0.67.
    - The soundness mutants of the model are the three that matter: an entry hash that drops its dependencies, a name-node hash that drops its dependents, and a `locate` that walks up to an ancestor importer.
    - **The whole-branch review's two fixes add 10 more, all caught by this branch's tests.** Five are for the block limit: removed, off by one either way, the wrong line, a limit of 2,000. Five are for the root-lookup rule: removed from `hash()`, removed from `dependencies()`, applied to unknown names, known only through a declaration, and applied to non-root lookups.
  - **Not done here:** nothing calls the readers, so no plan changes. Corpus lockfiles (spec 9.4) and the replay of this repository's commits are the cut-over's evidence.

## 37. pnpm and yarn lockfiles are parsed: the cut-over (2026-11-16)

- **Context.** Entry 36 built the three readers with no caller. This is the second pull request of the design ([docs/superpowers/specs/2026-11-15-pnpm-yarn-lockfiles-design.md](docs/superpowers/specs/2026-11-15-pnpm-yarn-lockfiles-design.md) §10): one lockfile interface for the builder, the planner and `trommel diff`, SMAP's new lockfile kinds, and the engine `trommel-static-4`. Until now any change to a pnpm or yarn lockfile ran every test (L3). It finishes the first item of [HANDOFF.md](HANDOFF.md) §8, except the corpus check, which waits on Ojas (below).
- **Decision.**
  - **One interface for every lockfile** (spec §8.1). The builder, the planner and `trommel diff` ask a `Lockfile` for its `nodes`, a node's `hash` and `dependencies`, and where a bare import goes (`locate`). They no longer ask which format they have. A lockfile state is `parsed`, `unparseable` or `none`.
    - npm is adapted with no change to its nodes or edges (`npmLockfile`). That includes the ⊥ nodes of names a package declares and npm did not install.
  - **Detection.** `detectLockfile` now reports `pnpm-lock.yaml` and `yarn.lock` as lockfiles to read. A `yarn.lock` whose text holds `# yarn lockfile v1` is classic; any other is Berry.
    - What a reader refuses (entry 36) is `unparseable` as before, so a change to it is still L3. That covers pnpm before 9.0 and Berry before 8. bun stays unparseable, now with the reason "bun lockfiles are not parsed", and so does more than one lockfile.
  - **Classic yarn's workspace** is read from the snapshot:
    - The importers are the root and the members `Resolver.workspaces()` finds. Each declares the names in the `dependencies`, `devDependencies` and `optionalDependencies` of its own `package.json`. When two fields name one package, the later field wins.
    - A member whose `package.json` cannot be read, or has a dependency field that is not an object, makes the lockfile unparseable: "<dir>/package.json cannot be read".
  - **The builder** adds every node and edge of the lockfile, whatever its kind (spec §8.2). A bare import goes where `locate` says (spec §6.4):
    - the lookup of the file's own workspace package, when that package declares the name;
    - else the name's name node, added with its hash and edges the first time a file uses it;
    - else today's ⊥ node, and the file is uncertain.

    `map.lockfile` is `{kind, path}`, and `trommel graph` prints it so.
  - **SMAP** (spec §8.4, [docs/smap-format.md](docs/smap-format.md) §4.1 and §4.4).
    - `META` gains lockfile kinds 3 (pnpm), 4 (yarn Berry) and 5 (classic yarn), each followed by the lockfile's path. Kinds 0 to 2 keep their bytes, and the format number stays 0.
    - Entry, name-node and `#env` hashes are SHA-256, form 1. A lookup's hash is text, form 2: the entry id, `link:<dir>`, or `<name>@*` when its reference is unresolved.
  - **The engine is `trommel-static-4`** (spec §8.6). Maps of pnpm and yarn repositories have new nodes, and the engine id, not the format number, keeps old planners and new maps apart. Both golden hashes moved with the engine id and with nothing else:
    - the fixture's canonical JSON, from `d648c838…806811` to `e66292fe…03739d`. A diff of the two texts differs only in `engine`;
    - `golden.smap` is still 3,779 bytes. It changed at byte 28, the last character of the engine id, and in its 32-byte trailer.
  - **The planner compares hashes, with no new rule per format** (spec §8.3):
    - **Recomputed nodes.** Every `p:` key of the map is recomputed from the head lockfile's `hash(key)`, else ⊥. That covers lookups, entries, name nodes and `#env` alike (ruling R6). Recomputing only `p:npm:` keys would miss a bump that moves only an entry or a name node.
    - **npm's shadow rule stays npm's** (spec §6.3). It runs only when the head lockfile is npm's. pnpm and yarn lookups are `p:npm:` keys too, and without the guard a member's new lookup of typescript would mark the root's lookup changed and escalate the root.
    - **A lockfile that changes kind or path is L3.** The cause names both sides as `<kind> <path>` (ruling R7), so a move from Berry to classic, or from yarn to pnpm, runs everything once. A pnpm or yarn lockfile that was deleted is L3 too.
    - **Ruling R8:** a map whose lockfile was unparseable, against a head where the same path now parses, is L3, for npm too. Before, the two sides had the same path and the plan went on. It follows spec §8.3, since the kind changed, and it costs one run-all plan when a lockfile first becomes readable.
    - **One npm cause string changed.** "the lockfile changed from package-lock.json to npm-shrinkwrap.json" now reads "the lockfile changed from npm package-lock.json to npm npm-shrinkwrap.json". Levels, selections and why-paths are unchanged.
    - **`inputs.ignore`** matches an entry or a name node as `node_modules/<name>`, the pattern that already matches its lookup at the root, and `p:pnpm:#env` as `pnpm-lock.yaml`. So ignoring an eslint bump stays one pattern.
    - **pnpm's own document** is a changed node that no test reaches, so a change to it escalates the root (L1, entry 29), as spec §6.8 says.
  - **`trommel diff`** gives the `p:` keys added, changed and removed between two parsed lockfiles of one kind (`diffLockfiles`, spec §8.5). A ⊥ hash is a hash like any other, and each list is sorted.
    - Between kinds, or when either side is not parsed, it gives each side as `<kind> <path>`, `<path> (unparseable: <reason>)` or `none`, and "package changes are only computed between two lockfiles of one kind".
    - **For npm the output changes.** Keys carry their `p:npm:` prefix, and the ⊥ nodes of missing names are listed. Before, the lists held install locations without the prefix, and only installed ones.
  - **The soundness property of spec §9.2** is `test/select/lockfile-soundness.test.ts`, with its generator and oracle in `test/select/install-tree.ts`.
    - **The generator.** A universe of five names, each at two versions with up to two dependencies; in Berry, a third of the versions have one peer. Three importers declare random versions, and three tests import one to three names. H is S after one or two edits: a declaration bumped, added or removed, a dependency re-pointed, a second version brought in, or a package re-published with new content.
    - **Four layouts,** 700 runs each: pnpm's isolated layout, Berry's `node-modules`, Berry's Plug'n'Play, and classic yarn hoisted. A small hoister in the test places the hoisted installs, and writers write each install's lockfile and `package.json` files. In the generated pnpm and Berry repositories a declaration lives in the lockfile alone, so every edit is lockfile-only.
    - **The oracle** walks the placed install as Node does, or as Plug'n'Play does, and gives the (entry, content) pairs each test loads. It never reads a lockfile and never calls `locate`, so a wrong lookup shows as a miss.
    - **The assertion:** every test whose loads differ is selected, except the two residual cases of spec §6.4 (below), which are counted. Two checks keep a run from passing vacuously: S's map records the expected lockfile kind, and the plan has no L3.
  - **The known gaps,** each in [HANDOFF.md](HANDOFF.md) §11:
    - **Second-order hoisting moves** (spec §6.4). Hoisting can move a copy for a reason two or more steps away. Then a file can load another copy of a name its own workspace package does not declare, or an unmet Berry peer found by position can reach another copy, while no input of that name's node changes (ruling R9). M2's records, which see the file a test loaded, close both.
    - **Classic yarn's peers** (spec §6.7). The lockfile does not record them, so they are not edges.
    - **The name node's precision cost** (spec §6.4, "What case 2 costs"). On a pnpm monorepo whose tests import a root-declared vitest, a bump of a `@vitest/*` package reruns those tests. Reading pnpm's `node-linker` would win it back (spec §11).
  - **Rulings R9, R10 and R11, awaiting Ojas's confirmation.** They change which misses the property tolerates. They were made during the build, within his decision that second-order hoisting moves are a known gap (spec §12).
    - **R9:** the property first failed on Berry's `node-modules` layout, 0 to 3 times in 700 runs. A workspace edit re-hoisted a package whose peer its parent does not provide, so Node found another copy of the peer by position, and the peer's name node did not change. That is the same mechanism as the residual, so the exemption gained a second case: an unmet Berry peer found by position, with its name node unchanged. Spec §6.4, §6.7 and §9.2 were corrected in `ce741d0`. An exact fix would make the peer depend on the whole hoisting layout, which is approach C of the spec.
    - **R10:** the test's hoister keeps a peer that the parent provides visible from the package, as Yarn guarantees and spec §6.7 relies on. Without that, seed 2 failed on an install Yarn never writes. Installs with a cycle of provided peers, of any length, cannot be placed and are skipped. That was about 3% of the Berry `node-modules` draws, measured before the review's fix round changed how peers are provided. The review's fix round then modelled all three ways Yarn provides a peer: from a dependency of the parent, from the parent itself, and forwarded from the parent's own peer.
    - **R11:** one exemption for both cases. A differing item is exempt when every path from the test to it crosses an exempt edge: an import of a name the test's own workspace package declares at neither S nor H, or, in Berry's `node-modules` layout, an unmet peer found by position, each with its name node unchanged. A test exempt only by a mix of the two is counted as "mixed". Seed 8 failed on such a mix before it.
  - **Two fixes from the whole-branch review** of both branches (`ab745a9..fc350d1`), made on the readers' branch and merged in:
    - **YAML block nesting is limited to 64 levels** (`BLOCK_DEPTH`, entry 36). A pnpm `resolution` nested 2,000 levels deep, a 4.0 MB file, was read, and `lockfileFromModel` then overflowed the stack hashing it. `trommel plan` caught the error and ran everything, but `trommel graph`, which is the map job on `main`, and `trommel diff` exited 1. Deeper nesting is now a refusal that names its line, so such a lockfile is `unparseable`.
    - **Case 3's ⊥ node follows the name node once the name is known** (spec §6.4), found by the whole-branch review. A bare import that the resolver also maps to a file, through a root `__mocks__/N` or tsconfig `paths`, is not uncertain, and its edge goes to `p:npm:node_modules/N` with hash ⊥. When N became known at H only through a non-root importer or an entry, that key was none of the head lockfile's nodes, so `hash` gave undefined, the plan read ⊥ again and saw no change. In classic yarn, `bar` (declared by `packages/b`) gaining a dependency on `foo`, while `packages/a` imports `foo` under a root mock, selected only `b.test` and skipped `a.test`, though a hoisted install now puts `foo` at the root. npm's shadow rule selects both. Now `hash` and `dependencies` answer for a root lookup that is not a node with N's name node when the lockfile knows N, as `locate` defines knowing, and as before when it does not.
  - **Superseded in earlier entries:**
    - entry 18's "pnpm, yarn … are reported as `unparseable`", and its diff of install locations;
    - entry 24's "lockfiles that cannot be parsed (pnpm, yarn, bun, npm v1)", which now means bun, npm v1, and pnpm and yarn formats the readers do not know;
    - entry 36's "no caller".
- **Evidence.**
  - **Tests.** 945 pass in 44 files, where entry 36 had 896 in 42. Lint, typecheck and the zero-dependency check are clean.
    - `plan.test.ts` plans a lockfile-only bump in one workspace package for pnpm, Berry and classic yarn, and it selects that package's tests and not the other's. It also covers a transitive bump, a new copy of a root-declared name, `#env`, a change of yarn flavour, a deleted pnpm or yarn lockfile and an ignored eslint bump. For classic yarn and pnpm, it plans the review's case: a name that case 3 left at ⊥ becomes known at H, and the test that imports it is selected.
    - `static.test.ts` maps each format, the classic workspace and its refusals; `smap.test.ts` pins each kind's `META` bytes and round-trips each kind; `lockfile.test.ts` and `cli.test.ts` cover the diff.
  - **The soundness property** passes its 2,800 runs at the default seed, in 6.7 s on the day of the benchmark below. The review, before its fix round, counted 1,905 of the 2,800 runs with no L1 escalation; a run with one proves nothing.
    - The residual counts, in the form undeclared imports only / unmet peers only / only both:

      | Layout | Default seed, 700 runs | Seeds 1 to 50, 35,000 runs |
      |---|---|---|
      | pnpm | 0 / 0 / 0 | 0 / 0 / 0 |
      | Berry `node-modules` | 3 / 1 / 0 | 134 / 31 / 4 |
      | Berry Plug'n'Play | 0 / 0 / 0 | 0 / 0 / 0 |
      | classic yarn | 1 / 0 / 0 | 108 / 0 / 0 |

    - All 51 seeds pass, with no miss of any other kind. In pnpm's isolated layout and Plug'n'Play, which do not hoist, none was counted.
  - **The four mutants of spec §9.2,** in `model.ts`:
    - **M1, an entry hash without its dependencies:** the property fails in every layout, at run 6 in pnpm and classic yarn and at run 16 in both Berry layouts.
    - **M4, a walk up to an ancestor's lookup instead of the name node:** it fails at run 89 in pnpm and at run 22 in both Berry layouts. It passes in classic yarn, because there a declaration lives in the member's `package.json`. Adding or removing a declaration also changes that file, which the test depends on, so the test is selected anyway.
    - **M2 and M3 cannot fail the property,** as spec §9.2 says. Pointing a file straight at an entry (M2) leaves every lookup with no edge in, so any change to a lookup is a changed node that no test reaches and escalates its package (entry 29). That is sound, so the property sees no miss. A name-node hash without its dependents (M3) is read by the exemption itself, so each miss it causes counts as a residual. 11 example tests catch M2 (three in `plan.test.ts`, three in `static.test.ts`, five in `model.test.ts`), and 8 in `model.test.ts` catch M3.
  - **27 more hand mutants,** all caught but one whose code is gone:
    - **2 in npm's adapter.** One survived its first pass and gained a test: the shadow rule counting the ⊥ node of a missing name as a new install location.
    - **18 in the map, SMAP and detection,** among them the case-2 name node not added, `map.lockfile` always npm, swapped kind bytes, every `yarn.lock` read as Berry, classic importers without the members, and an unreadable `package.json` read as declaring nothing. The eighteenth, `trommel diff` without its npm-only guard, survived; that guard was replaced in the same pull request by the one-kind check, whose removal is caught.
    - **4 in the planner:** only `p:npm:` keys recomputed, the shadow rule for every format, `describe` without the kind, and an entry's ignore path taken as its full id.
    - **1 in the test's install:** without the rule that a peer naming the parent is the parent, the two example tests fail, while the property alone exempts the miss as an unmet peer.
    - **2 in `trommel diff`:** the one-kind check dropped, and a ⊥ hash treated as absent.
  - **10 mutants of the review's fixes,** all caught.
    - **5 in the block limit.** Without the limit, the 2,000-level test fails with the `RangeError`. Off by one either way, the opening key's line named instead of the first deeper one, and a limit of 2,000 each fail `yaml.test.ts` or `fuzz.test.ts`.
    - **5 in the root lookup.** Without the new branch of `hash`, both new plan tests fail, and `model.test.ts` too. Without it in `dependencies`, a root lookup followed whether or not the name is known, a name known only through a declaration, and every lookup followed rather than the root's, each fail `model.test.ts`. The plan tests pass with the `dependencies` mutant, since the plan reads only hashes, and the soundness property passes with the `hash` mutant: its imports of a name the lockfile does not know are uncertain, so they always run.
  - **This repository's last 70 non-merge commits,** `29f1638` to `3686470`, each planned from a map of its parent by the CLI on `main` at `74ca9b4` and by this one (spec §9.3). On all 70 the tests that would run, the would-skips, the why-path of each affected test and the escalations are identical. Escalations were compared by level, scope and cause, with the kind that R7 adds removed, and no cause needed it. In all: 728 of 2,337 possible test-file runs, 11 commits with an L1 escalation, 1 with an L3 (`trommel.config.json` changed, at `e808651`) and no fallback.
    - Each of the 70 maps differs from `main`'s only in the last character of the engine id and in the trailer: 3,350,720 bytes for the 70, on both sides.
  - **The synthetic 10,000-file repository and this one,** measured the same day and on the same machine with `main`'s benchmark and with this one, twice each ([bench/README.md](bench/README.md)). The numbers match within noise. `main`'s own two runs differ by 0.04 s in decoding and 0.21 s in `buildStaticMap`, more than the two builds differ there. For the cold CLI and the select steps, two runs of one build differ by about as much as the two builds do.

    | | Map | CLI cold | `buildStaticMap` | Decode | Select, an edit | Select, a file added |
    |---|---|---|---|---|---|---|
    | Synthetic, `main` at `74ca9b4` | 1,110,846 bytes | 2.52 s, 2.54 s | 2.91 s, 3.12 s | 0.14 s, 0.10 s | 0.08 s, 0.07 s | 0.42 s, 0.35 s |
    | Synthetic, this change | 1,110,846 bytes | 2.55 s, 2.53 s | 2.87 s, 2.92 s | 0.14 s, 0.13 s | 0.06 s, 0.07 s | 0.45 s, 0.37 s |
    | This repository at `3686470`, `main` | 50,592 bytes | 0.53 s, 0.54 s | 0.11 s, 0.12 s | — | — | — |
    | This repository at `3686470`, this change | 50,592 bytes | 0.55 s, 0.54 s | 0.10 s, 0.11 s | — | — | — |

    - Both builds give 20,107 nodes and 145,041 edges at 10,000 files, and 552 nodes and 1,286 edges here.
    - The machine was slower than for entry 34, on both sides: the cold CLI took 2.5 s where it took 1.8 s on 2026-11-15. So these rows compare only with each other.
- **Not done.**
  - **The corpus check of spec §9.4. Not done yet: it needs Ojas's approval to clone `honojs/hono` and `excalidraw/excalidraw`.** On each:
    - read every version of the lockfile from the last 12 months, and count and explain each refusal;
    - plan every lockfile-only commit, and count the plans by outcome: a subset selected, L1 at the root with the package that caused it, or anything else.

    Done means no lockfile-only commit escalates to L3 because its lockfile cannot be read, the why-paths of selected tests name the changed packages, and the commits that end in L1 at the root are counted with their causes (spec §9.6). Under entry 29 many will still be L1, for bumps of tools that no test imports; the counts set up the replay's `inputs.ignore`.
  - **Not yet seen in CI.** Expect one run-all plan on each branch until a push to `main` caches a `trommel-static-4` map. The cause is "the map at .trommel/map/map.smap is invalid: the map was built by engine "trommel-static-3", expected trommel-static-4".
  - **No byte check on a second system before CI.** Only the engine id moved in the golden files, and CI runs both golden pins on Ubuntu and Windows.
