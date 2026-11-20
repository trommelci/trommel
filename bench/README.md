# Benchmarks

- **Targets.** Pre-registered targets are in [TARGETS.md](TARGETS.md). Corpus selection is in [CORPUS.md](CORPUS.md).
- **Separate runs.** Timing scripts run apart from the test suite, so correctness tests never depend on how fast a machine is.
- **Recording.** Each script prints canonical JSON, and results are committed under [results/](results/) with the date and platform in the file name.

## Snapshot path: `node bench/ls-tree.ts [repo]`

This times what `trommel plan` does before any graph work:
- list the head tree with `git ls-tree -r -t -z`;
- parse the listing as a stream;
- index it by directory;
- run the Merkle descent against a base snapshot.

Without an argument, the script builds a synthetic repository with `git fast-import`: 20 packages × 25 modules × 20 files, which is 10,000 files in 541 trees. It then adds two commits on top, one changing 1 file and one changing 100 files.

| Date | Platform | Files | `git ls-tree` alone | `lsTree` (spawn + parse) | Index | Diff, 1 file | Diff, 100 files |
|---|---|---|---|---|---|---|---|
| 2026-11-11 | Windows 11, Ryzen AI 7 350, Node 26.4, git 2.55 | 10,000 | 31.5 ms | 57.6 ms | 3.0 ms | 0.0 ms | 0.4 ms |

All times are medians of 15 runs; the raw output is in [results/2026-11-11-ls-tree-win32.json](results/2026-11-11-ls-tree-win32.json).
- Architecture §3.1 expected about 100 ms for the CLI's listing at 10,000 files.
- `lsTree` also runs `git rev-parse` for the root tree id and parses the stream. Together those add about 26 ms over `git ls-tree` alone.

## Import lexer: `node bench/lex.ts [dir …]`

This times `lexImports` over every `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx` file under the given directories. The default is `node_modules`, which is already installed, so nothing is downloaded. Our own workspace links are skipped.

The script also counts the files the lexer marks **uncertain**. Every uncertain file costs precision, because its owning package escalates to L1. Real third-party code is a check that the uncertainty is not spurious.

| Date | Platform | Files | MB | Throughput | Imports found | Non-literal | Uncertain files |
|---|---|---|---|---|---|---|---|
| 2026-11-11 | Windows 11, Ryzen AI 7 350, Node 26.4 | 2,699 | 43.7 | 32–34 MB/s | 6,862 | 60 | 0 |

The raw output is in [results/2026-11-11-lex-win32.json](results/2026-11-11-lex-win32.json).
- The first run flagged 2 files in Vite and Vitest `.d.ts` output. Both contain method signatures named `import`, such as `import<T>(id: string): Promise<T>`. The fix and its fixture are `signatures.d.ts`.

## Graph: `node bench/graph.ts [nodes] [edgesPerNode]`

This builds a graph of deterministic pseudo-random edges, then times the multi-source reverse BFS (median of 7 runs) for 1, 10 and 100 changed nodes. The default is 100,000 nodes with 10 edges each, the scale in architecture §3.3.

| Date | Platform | Nodes | Edges | Build | Reverse BFS (all 100,000 nodes reached) |
|---|---|---|---|---|---|
| 2026-11-11 | Windows 11, Ryzen AI 7 350, Node 26.4 | 100,000 | 999,950 | 1.6 s | 7.6–8.5 ms |

The raw output is in [results/2026-11-11-graph-win32.json](results/2026-11-11-graph-win32.json).
- A random graph reaches every node, so these timings are the worst case for the BFS.
- The build merges edges through a `Map` and sorts its keys. In M3 the build will be replaced by decoding the stored map.

## Static graph: `node bench/static-graph.ts [repo [rev]]`

This times what `trommel graph` and `trommel plan` do, against T6 (a 10,000-file TypeScript repository in under 30 s cold).
- **CLI cold** is `trommel graph --out` in a fresh Node process: listing, blob reads, lexing, resolution, the map, its encoding as SMAP and the write. That is what CI pays.
- **Stages** come from one more build in the same process: `lsTree`, `GitVfs.load` (config blobs), `readBlobs` (every source), `buildStaticMap` (lexing, resolution and edges), `encodeSmap`, and canonical JSON for comparison.
- **Plan** (synthetic repository only) times `decodeSmap`, which checks the file and gives the graph, and `selectStatic` against a head commit that changes one file. Until 2026-11-14 the map was JSON, and this timed `parseMap`, the CSR build and `selectStatic`. Since 2026-11-14 it also times `selectStatic` against a head that adds a file (`selectAddedMs`): a listing changes, so the plan recomputes every resolution hub (DECISIONS 32).

Without an argument, the script builds a synthetic npm-workspaces monorepo with `git fast-import`: 20 packages × 25 modules × (19 sources + 1 test), 10,000 module files of about 4 KB each.
- Each source file imports three siblings (extensionless, so every import probes), a file in the next module, the next workspace package and lodash, and has an `import type`.
- Its body mixes comments, strings, templates and regexes, as real code does.
- The imports chain every module and package together, so one change reaches all 500 tests: the worst case for the plan.

| Date | Repository | Files | Source MB | Nodes | Edges | Map | CLI cold | `buildStaticMap` | Plan: parse + select |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-12 | synthetic | 10,023 | 42.1 | 106,390 | 684,501 | 26.7 MB | **2.5 s** | 2.5 s | 0.2 s + 0.57 s |
| 2026-11-12 | Trommel at day 9 | 222 | 0.4 | 1,457 | 2,739 | 0.26 MB | 0.36 s | 0.06 s | — |
| 2026-11-12 | honojs/hono at `f6fbaf02` (4.13.18) | 585 | 3.0 | 3,288 | 13,543 | 0.64 MB | 0.44 s | 0.10 s | — |
| 2026-11-14 | synthetic, `main` at `65a5958` (before hubs) | 10,023 | 42.1 | 106,388 | 683,501 | 26.7 MB | 2.5 s | 2.6 s | 0.2 s + 0.63 s |
| 2026-11-14 | synthetic, with hubs | 10,023 | 42.1 | 20,107 | 145,041 | 7.1 MB | **1.8 s** | 1.6 s | 0.06 s + 0.12 s; 0.30 s when a file is added |
| 2026-11-14 | Trommel at `65a5958`, before hubs | 238 | — | 1,466 | 2,790 | 0.26 MB | 0.37 s | 0.06 s | — |
| 2026-11-14 | Trommel at `65a5958`, with hubs | 238 | — | 514 | 1,044 | 0.14 MB | 0.37 s | 0.07 s | — |
| 2026-11-15 | synthetic, map as SMAP | 10,023 | 42.1 | 20,107 | 145,041 | **1.11 MB** (7.07 MB as JSON) | 1.8 s | 1.2 s | decode 0.05 s + select 0.04 s; select 0.18 s when a file is added |
| 2026-11-15 | Trommel at `c79d5a0`, map as SMAP | 258 | 0.6 | 531 | 1,155 | 0.05 MB (0.15 MB as JSON) | 0.36 s | 0.07 s | — |
| 2026-11-16 | synthetic, `main` at `74ca9b4` (engine `trommel-static-3`) | 10,023 | 42.1 | 20,107 | 145,041 | 1.11 MB | 2.52 s | 2.9 s | decode 0.14 s + select 0.08 s; select 0.42 s when a file is added |
| 2026-11-16 | synthetic, lockfile cut-over (`trommel-static-4`) | 10,023 | 42.1 | 20,107 | 145,041 | 1.11 MB | 2.55 s | 2.9 s | decode 0.14 s + select 0.06 s; select 0.45 s when a file is added |
| 2026-11-16 | Trommel at `3686470`, built by `main` at `74ca9b4` | 284 | 0.8 | 552 | 1,286 | 0.05 MB (0.16 MB as JSON) | 0.53 s | 0.11 s | — |
| 2026-11-16 | Trommel at `3686470`, lockfile cut-over | 284 | 0.8 | 552 | 1,286 | 0.05 MB (0.16 MB as JSON) | 0.55 s | 0.10 s | — |

All on Windows 11, Ryzen AI 7 350, Node 26.4 and git 2.55. The raw output is in [results/](results/): the 2026-11-12 files, and for 2026-11-14 [static-graph-before-hubs](results/2026-11-14-static-graph-before-hubs-win32.json), [static-graph](results/2026-11-14-static-graph-win32.json), [static-graph-trommel-before-hubs](results/2026-11-14-static-graph-trommel-before-hubs-win32.json) and [static-graph-trommel](results/2026-11-14-static-graph-trommel-win32.json); for 2026-11-15 [static-graph-smap](results/2026-11-15-static-graph-smap-win32.json) and [static-graph-trommel-smap](results/2026-11-15-static-graph-trommel-smap-win32.json); and for 2026-11-16 [static-graph-main](results/2026-11-16-static-graph-main-win32.json), [static-graph](results/2026-11-16-static-graph-win32.json), [static-graph-trommel-main](results/2026-11-16-static-graph-trommel-main-win32.json) and [static-graph-trommel](results/2026-11-16-static-graph-trommel-win32.json). The "before hubs" rows and the 2026-11-16 `main` rows ran `main`'s own copy of this script on the same machine the same day, so each pair compares like with like.
- **hono** was cloned with `--filter=blob:none`. At HEAD every blob is local. Building an older revision fetched its missing blobs one by one and took 18.7 s, which is network time, not Trommel's.
- **T6 is met:** 1.8 s cold against 30 s, and against the 10 s goal. Incremental builds (under 3 s) are not measured yet; extraction is not cached across runs.
- **Probe edges dominated,** as DECISIONS 17 expected: about 10 edges per extensionless import, 26.7 MB of JSON at 10,000 files. Resolution hubs (DECISIONS 32) cut nodes by 81% and edges by 79%: 9,520 `r:` and 520 `c:` hubs replace 86,802 absent files and 9,541 absent directories. The JSON map was 7.1 MB.
- **The plan** took about 0.8 s before hubs: 0.2 s to parse the JSON, then about 0.6 s to select, most of it rebuilding the CSR arrays (`graphMs`, 0.43 s). With hubs it takes 0.18 s for an edit (CSR rebuild 0.06 s), and 0.36 s when a file is added, since every hub is then recomputed at the head. M3's target is a plan p95 under 1 s at 10,000 files.
- **SMAP** (DECISIONS 33 and 34) makes the map 6.4 times smaller at 10,000 files: 1,110,846 bytes against 7,069,025 of JSON. On this repository it is 48,609 bytes against 149,855.
  - **Decoding replaces the parse and the rebuild.** A plan for an edit takes 0.09 s: 0.05 s to decode, which checks the trailer and every section and gives the CSR graph, then 0.04 s to select. With the JSON map the same plan took 0.18 s. A plan where a file was added takes 0.24 s, against 0.36 s.
  - **Encoding costs about as much as JSON did:** 0.09 s for `encodeSmap`, where canonical JSON took 0.05 to 0.08 s. The cold CLI is unchanged at 1.8 s.
  - A second run of the script gave the same numbers within 10 ms.
- **The lockfile cut-over** (DECISIONS 37) changes nothing here, as it should: the synthetic repository and this one use npm, whose nodes and edges are unchanged. Both builds give the same node and edge counts and the same map size, and each map differs from `main`'s only by the engine id.
  - Each side ran twice, alternating. The table gives the first run of each.
    - **Cold CLI and selection:** two runs of one build differ by about as much as the two builds do. The cold CLI took 2.52 and 2.54 s on `main` and 2.55 and 2.53 s with the cut-over. Selecting against a head that adds a file took 0.42 and 0.35 s on `main` and 0.45 and 0.37 s with the cut-over.
    - **Decoding and `buildStaticMap`:** `main`'s own two runs differ by more than the two builds do. Decoding took 0.14 and 0.10 s on `main` and 0.14 and 0.13 s with the cut-over. `buildStaticMap` took 2.91 and 3.12 s on `main` and 2.87 and 2.92 s with the cut-over.
  - **The machine was slower that day than on 2026-11-15**, for both builds alike: the cold CLI took 2.5 s where it took 1.8 s, and `buildStaticMap` 2.9 s where it took 1.2 s. Compare the 2026-11-16 rows only with each other.

## Lockfile readers: `node bench/lockfile.ts <file> …`

This reads each lockfile with its reader, picked by file name: `*pnpm-lock.yaml` is pnpm, and `*yarn.lock` is classic yarn when the text holds `# yarn lockfile v1`, else Berry. Classic yarn is read with an empty `ClassicWorkspace`. It prints the bytes, the median parse time of 5 runs, and the counts of entries, importers, references and unresolved references (those that point at a name node). A refusal is printed and recorded, not hidden.

The five samples of the design (spec §9.5) are the lockfiles of hono and zod (pnpm), prettier and es-toolkit (Berry) and excalidraw (classic). They were downloaded from the commits spec §9.5 pins, outside this repository, and are recorded by base name.

| Date | Platform | Sample | Bytes | Median | Entries | Importers | References | Unresolved |
|---|---|---|---|---|---|---|---|---|
| 2026-11-15 | Windows 11, Ryzen AI 7 350, Node 26.4 | hono, pnpm | 332,558 | 10.7 ms | 1,075 | 9 | 1,522 | 0 |
| | | zod, pnpm | 433,789 | 10.5 ms | 1,276 | 9 | 2,700 | 5 |
| | | prettier, Berry | 364,006 | 7.8 ms | 1,027 | 1 | 1,795 | 1 |
| | | es-toolkit, Berry | 583,970 | 15.9 ms | 1,647 | 5 | 2,659 | 0 |
| | | excalidraw, classic | 481,747 | 9.9 ms | 1,331 | 0 | 2,667 | 0 |

The raw output is in [results/2026-11-15-lockfile-win32.json](results/2026-11-15-lockfile-win32.json).
- **No refusal,** and the largest file (584 KB) reads in under 16 ms.
- **zod's 5 unresolved** are its peers on its own workspace package. **prettier's 1** is `remark-parse`, which `resolutions` redirects to `trim`. Neither is a refusal: the reference takes the name node (spec §6.5).
- **Excalidraw's importer count is 0** because the benchmark gives classic yarn an empty workspace. A real plan reads the members' `package.json` files.

## The lockfile corpus check: `node bench/lockfile-corpus.ts <clone> [--since <date>] [--rev <rev>]`

The check of the lockfile design's §9.4 (DECISIONS 40), on one clone, read only through git. Over the first-parent history of `<rev>` (default `HEAD`) since `<date>` (default a year before `<rev>`):
- it reads the root lockfile of every commit that changed one, as the builder does, and lists each refusal with its reason;
- it plans every lockfile-only commit, and every dependency commit (root lockfiles and `package.json` files only), as CI would: `trommel graph` at the first parent, then `trommel plan --shadow --static` at the commit, in the same process.

It counts the plans by outcome (tests selected through changed packages, L1 at the root with its causes, L1 in a package, L3, nothing selected), and the why-paths that end at a package the plan did not report as changed. It prints canonical JSON with every plan.

The clones are at `~/Projects/trommel-clones` (HANDOFF §12). [results/2026-11-20-lockfile-corpus-win32.json](results/2026-11-20-lockfile-corpus-win32.json) summarizes the six repositories, before and after DECISIONS 40's two fixes: counts by outcome and the top ten L1 causes. The per-commit output, 2.2 MB, is not committed; the script makes it again in about 27 minutes, 18 of them on prettier (9,805 files, 292 plans).

| Repository | Lockfile versions read | Plans | Run every test | L1 at the root | L3 |
|---|---|---|---|---|---|
| hono | 12 of 32 (20 bun) | 10 | 10 | 0 | 8 |
| excalidraw | 18 of 18 | 0 | — | — | — |
| vuejs/core | 125 of 125 | 77 | 77 | 66 | 0 |
| es-toolkit | 25 of 25 | 3 | 3 | 3 | 0 |
| typescript-eslint | 227 of 227 | 166 | 164 | 159 | 0 |
| prettier | 552 of 552 | 292 | 292 | 292 | 0 |

Before the fixes, 888 of the 979 versions read and all 548 plans ran every test, 48 of them as L3.
