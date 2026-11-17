# pnpm and yarn lockfiles: design

- **Written:** 2026-11-15, at `main` = `74ca9b4` (SMAP v0 is the map on disk; engine `trommel-static-3`).
- **Status:** approved by Ojas on 2026-11-15, after he chose approach A of §4 and answered the three review questions of §12. Amended on 2026-11-16 (`ce741d0`) for rulings R9–R11, which await Ojas's confirmation.
- **Scope:** the first item of [HANDOFF.md](../../../HANDOFF.md) §8, "pnpm and yarn lockfile parsers", from the M1 row of [roadmap](../../roadmap.md) §1.
- **Decided already, and not reopened here:** architecture §3.1's `p:` nodes and §3.5's row "lockfile changed but unparseable → L3", read by [DECISIONS.md](../../../DECISIONS.md) entry 23 as "only when it changes"; entry 18 for npm; entry 32's rule that a hub's hash covers what it points at; ADR-0002, zero runtime dependencies.
- **Evidence:** §5, gathered on 2026-11-15 with Ojas's approval: the lockfile headers of the 24 corpus repositories, and five sample lockfiles in full.

## 1. Intent

`detectLockfile` reports `pnpm-lock.yaml` and `yarn.lock` as unparseable. Every bare import then depends on the lockfile file itself, and any change to it runs every test (L3). 24 of the 26 vetted corpus repositories use one of them: 19 pnpm and 5 yarn.

**Why now.**
- M4's replay measures selection on real history, and dependency bumps are among its most common commits. Under L3 each one runs everything, so the replay would measure the fallback, not the selector ([bench/CORPUS.md](../../../bench/CORPUS.md)).
- M1's exit criterion of golden graphs for 6 repositories would otherwise show nearly every bare import pointing at one file.
- The foundation review orders it straight after SMAP v0 ([review](../../research/2026-11-foundation-review.md), "Rest of M1").

**Success** is a lockfile change that reruns only the tests reaching a changed package, in all three formats the corpus uses, with a soundness argument as local as npm's.

## 2. Goals, non-goals, anti-goals

**Goals.**
1. Read pnpm lockfile format 9.0, as one YAML document and as the two documents pnpm 12 writes; yarn Berry lockfiles with `__metadata.version` 8 or 10; and classic yarn v1.
2. Package nodes whose hashes change whenever what a test loads could change: a package's content, what its dependencies resolve to, and what a workspace package's declared names resolve to.
3. **Refuse, never guess.** A lockfile that a reader cannot parse, whose format version it does not know, or that breaks its own format's invariants is unparseable, exactly as today. Fields outside the resolved graph are read past, for the reason given in §7 (my call).
4. **Total on bad input.** A pull request controls its lockfile. A reader returns a lockfile or a refusal; it never throws anything else, never hangs, and runs in time linear in its input.
5. **npm unchanged.** This repository's map changes only by the engine id, and its last 70 commits select the same tests as with the CLI on `main`.
6. The same bytes on every OS.

**Non-goals.**
- bun (`bun.lock`, `bun.lockb`), pnpm formats before 9.0, Berry before 8, and npm v1. They stay unparseable. Berry 6 appears only in typescript-eslint's past, and hono used `bun.lock` a year ago (§5).
- Simulating install layouts: hoisting, Plug'n'Play's resolver, or pnpm's virtual-store directory names.
- Changing behaviour on `.npmrc`, `.yarnrc.yml` or the lockfile's `settings`. Those files stay what they are today: `.npmrc` and `.yarnrc.yml` are root files outside the graph, so a change to either escalates the root package (L1).
- Following an external package into workspace sources. A workspace link has a constant hash and no edges, as npm's does today (review finding M6).
- Mapping script URLs to package nodes. That is M2's mapper, which will need the ids of §6.1.
- Rewriting `parsePnpmWorkspace` in `core/resolve/yaml.ts`. Its output decides workspace resolution, so changing it would change maps.
- Lockfiles below the repository root. Only root lockfiles are detected, as today.

**Anti-goals.** These would make it a failure even if it worked:
- a lockfile-only bump that changes what a test loads while no `p:` node changes (§6.3), outside the two known gaps of §6.4 and §6.7;
- a reader that accepts YAML it does not fully understand and plans from it;
- a node, key or hash that depends on the machine, such as dropping packages for another OS;
- a planner rule per lockfile format. The builder knows formats; the planner compares hashes.

## 3. Constraints

- Zero runtime dependencies in `packages/core` and `packages/cli` (ADR-0002). Node 22.18 is the floor and `@types/node` is 22.
- Parsed keys live in `Map`s, never in plain objects: `__proto__` and `constructor` are legal package names in hostile input.
- Tests come first, property tests are seeded, and every test file is checked by mutating the code by hand ([HANDOFF.md](../../../HANDOFF.md) §2).
- When a change moves the golden hash, it says whether the engine id changes (HANDOFF §1.1, item 2). This one does: §8.6.
- No ADR changes. No ADR names the `p:` key forms; architecture §3.1 does, and it is a document updated in place. So the deadline for correcting ADRs in place, 2026-11-16, does not bind this work.
- Cloning corpus repositories is a download, so §9.4 needs Ojas's approval when it runs.

## 4. Approaches

| | Approach | What it gives | What it costs |
|---|---|---|---|
| **A, picked** | **Resolved entries.** Each lockfile entry is a node keyed by what it resolved to, hashed by its content and by what its dependencies resolve to. Each pair of workspace package and declared name is a small lookup node, hashed by the entry it resolves to | Models what all three formats record. The soundness argument is one rule, the hubs' rule (§6.3). The planner compares hashes and loses its only npm-specific need | A common lockfile interface, new key forms, and an update to architecture §3.1 |
| B | **A virtual `node_modules`.** Turn every format into npm-style install locations, copying pnpm's real layout, and reuse the npm code unchanged | The least new code | For yarn the paths are fiction: classic yarn and Berry's `node-modules` linker hoist, and Plug'n'Play has no `node_modules`. `inputs.ignore` and M2's mapper would see paths that do not exist. npm's rule that a new copy of a name changes every copy comes along, which costs precision on bumps |
| C | **One node per workspace package**, hashed over its whole resolved closure | The smallest change | Any bump inside a workspace package reruns every file in it that imports a package. On hono, where nearly all code is the root package, that is almost everything |

**Why A.** It is the only one that is both precise on bumps and true to the lockfiles, none of which records install locations. C works against the reason for doing this. B buys code reuse with paths that do not exist.

## 5. What the lockfiles say

**Headers, 2026-11-15.** For each of the 24 repositories: its current head, and the last commit before 2025-11-15.

| Format | At head | A year ago |
|---|---|---|
| pnpm 9.0, two documents (pnpm 12) | 10: vue core, vite, TanStack/query, trpc, h3, typescript-eslint, vueuse, docusaurus, hono, starlight | none |
| pnpm 9.0, one document | 9: zod, svelte, lexical, vitest, date-fns, msw, zustand, jotai, redux-toolkit | 13 |
| Berry 10 | prettier, babel | none |
| Berry 8 | es-toolkit | prettier, babel, es-toolkit, redux-toolkit |
| Berry 6 | none | typescript-eslint |
| classic v1 | excalidraw, immer | excalidraw, immer, docusaurus |
| other | none | lexical: npm v2; hono: `bun.lock`; date-fns: no lockfile found |

Five repositories changed lockfile kind within the year. A change of kind already runs everything once (§8.3), and an unsupported format costs nothing until its lockfile changes.

**The samples**, read in full with throwaway scripts outside the repository:

| Sample | Commit | Size | Layout |
|---|---|---|---|
| hono, pnpm, two documents | `f6fbaf02` | 333 KB: 9 importers, 1,070 packages, 1,075 snapshots | default (isolated) |
| zod, pnpm, one document | `fef16cba` | 434 KB: 9 importers, 1,274 packages, 1,275 snapshots | `node-linker=isolated` |
| prettier, Berry 10 | `2cc4f0fd` | 364 KB: 1,028 entries | `nodeLinker: node-modules` |
| es-toolkit, Berry 8 | `24e7a7b8` | 584 KB: 1,652 entries, 5 workspaces | Plug'n'Play (no `nodeLinker`, Yarn 4's default) |
| excalidraw, classic | `3a317b55` | 482 KB: 1,331 entries | hoisted |

What they show:
- **pnpm's first document pins pnpm itself.** Its importer `.` has only `configDependencies` and `packageManagerDependencies`, plus `packages` and `snapshots` for the pnpm binaries. The project is the second document.
- **pnpm references are exact.** An importer's `version`, or a snapshot's dependency value, names a snapshot key: `<name>@<version>`, or the value itself when it is an alias such as `zod@3.24.3` for `zod3`. All 1,522 references in hono resolve. In zod, all but five resolve: `ai@6.0.5(zod@4.6.7)` and four others list `zod: 4.6.7`, the workspace's own package, which has no entry. Workspace dependencies are `link:<relative dir>`.
- **pnpm puts resolved peers in the key and in `dependencies`**: `@vitest/coverage-v8@5.0.1(@vitest/browser@5.0.1)(vitest@5.0.1)` lists `vitest` among its dependencies. Every snapshot has a `packages` entry under its key without the peer suffix.
- **Berry 8 and 10 have the same fields:** `version`, `resolution`, `dependencies`, `peerDependencies`, `peerDependenciesMeta`, `dependenciesMeta`, `bin`, `checksum`, `conditions`, `languageName` and `linkType`. Only the checksum's cache-key prefix differs (`10c0/` and `10/`).
- **Berry workspaces are entries** (`prettier@workspace:.`, `docs@workspace:docs`) whose `dependencies` hold the declared descriptors. Every reference in es-toolkit resolves. prettier has one that does not: `remark-parse@npm:8.0.3` asks for `trim@npm:0.0.1`, and only `trim@npm:1.0.1` exists, most likely through `resolutions` in the root `package.json` (not downloaded). `patch:` entries are ordinary entries with a hash in their resolution.
- **Classic yarn lists no workspaces and no peers.** Entries are `name@range` lists with `version`, `resolved`, `integrity`, `dependencies` and `optionalDependencies`. Every reference in excalidraw resolves.
- **YAML used.** Block mappings and block sequences, flow mappings and sequences on one line (`resolution: {integrity: …, tarball: …}`, `cpu: [x64]`, `{}`), plain and single-quoted scalars in pnpm, double-quoted scalars in Berry, and plain keys that contain a colon (`zod443@https://registry.npmjs.org/…`). No anchors, tags, block scalars or multi-line values.

## 6. The package model

### 6.1 Node kinds

| Key | What it is | Hash | Edges to |
|---|---|---|---|
| `p:npm:<location>` | **npm:** an install location, unchanged (DECISIONS 18). **pnpm and yarn:** a lookup location, `<importer>/node_modules/<name>` (`node_modules/<name>` for the root), one for each name a workspace package declares | npm: as today. pnpm and yarn: the id of the entry it resolves to, or `link:<dir>` for a workspace package | npm: as today. pnpm and yarn: that entry; nothing for a link |
| `p:pnpm:<id>`, `p:yarn:<id>` | **An entry.** The id is pnpm's snapshot key (`name@version(peers)`), Berry's `resolution`, or classic yarn's `name@version` | SHA-256 of the canonical JSON of the entry's content identity (§7) and the ids its dependencies resolve to | each dependency's entry, or its name node |
| `p:pnpm:<name>@*`, `p:yarn:<name>@*` | **A name node:** what decides which copy of a name loads when no declaration of the loader's own decides it. Used by a file that imports a name its own workspace package does not declare (§6.4), by a reference the lockfile does not resolve (§6.5), and by a Berry peer (§6.7) | SHA-256 of the canonical JSON of three sorted lists: the ids of every entry with that name; every importer that declares it, with what it resolves to; and every entry that depends on it, with the id it depends on. ⊥ when all three are empty | every entry those lists name: the entries with that name, and the entries its declarations and dependents point at, which differ for an alias such as zod's `zod3` |
| `p:pnpm:#env` | **pnpm's own document** (§6.8) | SHA-256 of that document's canonical JSON | none |

No id contains `@*` and none is `#env`, so the kinds cannot collide. A reader refuses a lockfile that would break this (§6.5). Berry resolutions may contain `#`, as patch resolutions do. A name node exists for every name that a file or an entry points at by these rules, and a plan recomputes it at H from the head lockfile. Missing-package nodes keep today's form, `p:npm:node_modules/<name>` with hash ⊥, for a bare import of a name the lockfile does not know at all.

### 6.2 Edges

All are STATIC:
- a file to the lookup location of a name its own workspace package declares, and otherwise to that name's name node (§6.4);
- a lookup location to its entry;
- an entry to what each of its `dependencies` and `optionalDependencies` resolves to, or to the name node when it does not resolve, and, in Berry, to the name node of each `peerDependencies` name;
- a name node to every entry its three lists name.

### 6.3 The one rule: a node's hash covers its outgoing edges

The planner sees an edge only through the hashes of the nodes it joins. So a change of where an edge points must change the hash of the node it leaves from.

**The case it closes.** `packages/a` and `packages/b` both use `foo@1.0.0`. A lockfile-only bump moves `a` to `foo@1.1.0`, and `b` stays. The entry `foo@1.0.0` is unchanged. If `a`'s files had edges straight to it, the bump would select nothing. With the rule:
- the lookup location `packages/a/node_modules/foo` changes hash, from `foo@1.0.0` to `foo@1.1.0`;
- so does any entry whose dependency on `foo` moved;
- a name node changes when an entry of its name appears or disappears, when a workspace package starts or stops declaring the name or re-points it, and when any entry's dependency on it moves.

Content travels by edges, as for every other node: a dependency whose content changes is reached through the edge that points at it. The rule is the hubs' rule (DECISIONS 32). It lets the planner compare hashes and nothing else.

**npm's shadow rule stays npm's** (Ojas, 2026-11-15). A new npm install location of a name changes every map location of that name, because npm's nesting is positional. pnpm and yarn do not need it:
- a file's exact lookup is always its own workspace package's;
- a change of which workspace package owns a file changes `g:workspaces`, which every bare import already depends on;
- a change of who declares a name changes that name's name node.

Applied to lookup locations, npm's rule would mark the root's lookup of, say, typescript as changed whenever a workspace package added typescript. No test reaches that lookup, so every such commit would run everything (DECISIONS 29).

### 6.4 Lookup: what a bare import loads

From a file in directory D, for the name N, the file's own importer W is the deepest importer whose directory is D or contains D. Then:
1. **W declares N:** the file gets an edge to the lookup location `<W>/node_modules/N`. This is exact in every layout.
2. **W does not, but the lockfile knows N** (an importer declares it, or an entry has that name): the file gets an edge to N's name node (Ojas, 2026-11-15).
3. **Otherwise:** the file gets an edge to `p:npm:node_modules/N` with hash ⊥, and is uncertain ("N is not in pnpm-lock.yaml"), as with npm today. A file that also resolves N to a file of the repository, through a root `__mocks__/N` or tsconfig `paths`, is not uncertain, and the edge alone carries a change. So when the lockfile later learns N, the ⊥ node's hash there becomes N's name node (or the root's lookup, if the root declares N), and the change is seen (found by the whole-branch review; DECISIONS 36 records the rule, and 37 the planner's use of it).

Importers are:
- **pnpm:** the keys of `importers`, with their `dependencies`, `devDependencies` and `optionalDependencies`;
- **Berry:** the entries resolved as `<name>@workspace:<dir>`, with their `dependencies`;
- **classic:** the root and the workspace members `Resolver.workspaces()` finds, with the same three fields of their own `package.json`.

**Why case 1 is exact.**
- **pnpm (isolated):** `<W>/node_modules` holds W's declared names, linked to their entries.
- **Hoisted** (classic yarn, Berry's `node-modules`, pnpm's `node-linker=hoisted`): the install gives W the version its range resolves to, either in `<W>/node_modules` or higher up with no other copy in between.
- **Plug'n'Play:** W loads exactly what it declares.

**Why case 2 is not a walk up.** In pnpm's isolated layout, walking up to the importer that declares N would be exact. But a hoisted install can put another copy of N into `<W>/node_modules`, for a package W depends on that needs another version, and the readers do not read `node-linker`. A test in W that imports N, typically vitest or a testing library declared only at the root, then loads that copy. The name node covers every copy of N and the direct causes of where they go: who declares N and who depends on which copy.

**The residual, a known gap** (Ojas, 2026-11-15). Hoisting can also move a copy because of a change two or more steps away. A package that depends on N can move between `node_modules` folders because its own dependents changed, and take its copy of N with it. That can change which copy a file in case 2 loads while no input of N's name node changes.

The same move reaches an unmet Berry peer in a hoisted layout: a peer that the package's parent does not provide. Node finds it by position, so when the package moves, it can reach another copy of its peer while no input of the peer's name node changes. §9.2's property found this on Berry's `node-modules` layout: 0 to 3 times in 700 runs.

Both are a known gap (ruling R9, 2026-11-16, made within Ojas's decision on second-order hoisting moves and awaiting his confirmation), recorded in HANDOFF §11. An exact fix would make the peer depend on the whole hoisting layout, which is approach C. M2's records, which see the file a test actually loaded, close it.

**What case 2 costs.** A name node changes more often than one lookup would: when any copy of N is bumped, added or removed, or a package depending on N is bumped. On pnpm monorepos whose tests import a root-declared vitest, a bump of a `@vitest/*` package then reruns those tests. That usually comes with a vitest bump anyway. §11 names the refinement that would win it back.

### 6.5 Fallbacks and refusals

- **A reference the lockfile does not resolve** points at the name node. That covers zod's peers on its own workspace package and prettier's `resolutions` redirect. `resolutions` and `overrides` are not applied: they live in the root `package.json`, a global input, so changing them already reruns everything.
- **A declared workspace package** resolves to a lookup location with hash `link:<dir>` and no edge: pnpm's `link:`, Berry's `workspace:` descriptors, and, in classic yarn, a declared name that has no entry but is a workspace member.
- **Refused, so the lockfile is unparseable:** an unknown format version; YAML outside §7.1's subset; a duplicate key; a pnpm snapshot with no `packages` entry; a dependency without a version; a Berry entry without `resolution`; more than two pnpm documents, or a first document that is not pnpm's own (§7.2); an id that contains `@*` or is `#env`. The rule is that a lockfile breaking its own format's invariants is refused, and a reference that legitimately points outside the lockfile takes the name node.

### 6.6 Packages for other platforms

Every entry is a node, whatever its `os`, `cpu`, `libc`, `optional` or `conditions`. The map holds nothing about any machine (DECISIONS 28). A test on Linux then also depends on, say, `@esbuild/darwin-arm64`, which costs a little precision when such a package alone changes.

### 6.7 Peer dependencies

- **pnpm:** resolved peers are part of the snapshot key and listed in its dependencies. Nothing extra.
- **Berry:** an entry lists the names of its `peerDependencies`. The parent provides them, and the lockfile does not record which version, so each peer is an edge to its name node. This is sound when the parent provides the peer, and coarse only for peers. An unmet peer in a hoisted layout is found by position, and falls in §6.4's residual.
- **classic yarn:** the lockfile does not record peers at all, so a package's peers are not edges. A test that reaches a package but not its peer misses a bump of the peer. This is a known gap (Ojas, 2026-11-15), recorded in HANDOFF §11: every would-skip in M1 is labelled unproven, and M2's records close it.

### 6.8 pnpm's own document

pnpm 12 writes a first document that pins pnpm and its config dependencies. No test loads them, so the document is one node, `p:pnpm:#env`, with no edges in or out. A change to it is a changed node that no test reaches, which escalates the root package (L1, DECISIONS 29). In practice it changes with the root `package.json`, which reruns everything anyway. That keeps the uncertain case conservative at no real cost.

## 7. Reading each format

**What a reader reads, and what it reads past (my call).** Each reader reads the resolved graph:
- pnpm: `importers`, the `resolution` of each `packages` entry, and the dependency maps of each snapshot;
- Berry: each entry's `resolution`, `checksum`, `dependencies` and `peerDependencies`;
- classic yarn: each entry's `version`, `resolved`, `integrity`, `dependencies` and `optionalDependencies`.

Every other key and field is read past, as long as it parses within the subset. That covers `settings`, `catalogs`, `overrides`, `patchedDependencies`, `pnpmfileChecksum`, `time`, `engines`, `bin` and `dependenciesMeta`.

**Why reading past is safe.**
- The lockfile is the install's own record. Overrides, patches, catalogs, `packageExtensions` and pnpmfile hooks act through what they resolve, and that appears in the graph: a patch is part of a snapshot key or a resolution, and an override is the version that got locked.
- Settings that decide where packages land, rather than which ones, live outside the lockfile. `.npmrc` and `.yarnrc.yml` escalate on their own (§2). `pnpm-workspace.yaml` is a config of every bare import's workspace lookup, so any change to it reruns every file that imports a package.
- An allowlist of fields would refuse pnpm 12 lockfiles nobody has seen yet, and gain nothing that the graph does not already say.

### 7.1 The YAML subset (pnpm and Berry)

**Accepted:**
- block mappings, indented two spaces per level, with blank lines anywhere;
- block sequences of scalars (`- supports-color`);
- plain scalars, which may contain a colon not followed by a space;
- single-quoted scalars, with `''` as the only escape;
- double-quoted scalars, with JSON's escapes only;
- flow mappings and flow sequences on one line, nested to a small fixed depth (`{integrity: …, tarball: …}`, `[x64]`, `{}`);
- comments, and the document marker `---` alone on a line.

**Refused:** tabs in indentation, anchors, aliases, tags, block scalars (`|`, `>`), multi-line flow collections, plain scalars that continue on the next line, complex keys (`?`), directives (`%`), duplicate keys, indentation that is not a multiple of two, and block mappings nested deeper than 64 levels (DECISIONS 36), since hashing the model recurses on what a reader copies.

**Output:** every scalar is a string. A mapping is a `Map`, a sequence an array. A refusal names its line. One pass, and recursion only in flow nesting, which is bounded.

### 7.2 pnpm

- **Documents.** One, or two where the first has only the keys `lockfileVersion`, `importers`, `packages` and `snapshots`, and its importer `.` only `configDependencies` and `packageManagerDependencies`. The project is the last document.
- **Version.** `lockfileVersion` is the string `'9.0'`, or the lockfile is refused.
- **Importers.** Directory → the three dependency fields → name → `{specifier, version}`. A `version` of `link:<rel>` is a workspace package at `<rel>` from the importer. Any other `version` is a reference. Other importer fields are read past.
- **References.** A value that starts with a valid package name followed by `@` is an alias and is the id itself. Otherwise the id is `<dependency name>@<value>`. The id must be a key of `snapshots`, or the reference takes the name node.
- **Entries.** One per snapshot key. Its base is the key without the peer suffix, which starts at the first `(` after the version's `@`; `packages` must have the base. Content identity: the base's `resolution` mapping, as sorted canonical JSON.

### 7.3 yarn Berry

- **Version.** `__metadata.version` is 8 or 10, or the lockfile is refused. The cache key is not read on its own: it is part of every checksum.
- **Keys.** An entry's key is one quoted string of comma-separated descriptors. Each descriptor maps to the entry, and a descriptor that appears twice is refused.
- **Workspace entries are importers, not entries (my call).** An entry resolved as `<name>@workspace:<dir>` gives its importer's declared names and gets no `p:yarn:` node, as npm skips workspace declarations (DECISIONS 18). A test reaches a workspace package through its sources, because the resolver resolves workspace names before any lookup. Such a node would have no edges in: any bump of a workspace's direct dependency would change a node no test reaches and escalate the root (DECISIONS 29). For the same reason a name node covers lockfile entries only. A peer on a workspace package, as babel's packages have on `@babel/core`, reaches its sources no better than npm's links do today.
- **Entries.** The id is the `resolution`. Content identity: the `resolution` and the `checksum` (absent for links and some patches, where the resolution already identifies the content).
- **References.** A dependency `name: "<range>"` is the descriptor `name@<range>`, which must be a key, or the reference takes the name node.

### 7.4 classic yarn

- **Format.** The header `# yarn lockfile v1`. Entries at column 0 are `descriptor[, descriptor]:`, fields at two spaces are `key value`, and `dependencies` and `optionalDependencies` are nested at four spaces. Values may be bare or double-quoted. Anything else is refused.
- **Entries.** The id is `name@version`. Content identity: `integrity`, or `resolved` when there is no integrity. If two entries share an id, the lockfile is refused. The excalidraw sample has none among its 1,331 entries. Berry repeats `name@version` only for `patch:` entries, which have their own resolutions, and no descriptor appears twice in either Berry sample.
- **Importers** come from the workspace members' `package.json` files (§6.4), so reading a classic lockfile needs the snapshot's workspace list and its `package.json` contents, not just the lockfile text. A declared `name@range` with no entry that is not a workspace member takes the name node.

## 8. Integration

### 8.1 One lockfile interface

The builder, the planner and `trommel diff` stop asking which format they have. Every parsed lockfile offers the same five things. The names are a sketch:

```ts
interface Lockfile {
  readonly kind: 'npm' | 'pnpm' | 'yarn-berry' | 'yarn-classic';
  readonly path: string;
  /** Every p: node the lockfile defines: key → hash, null for ⊥. */
  readonly nodes: ReadonlyMap<string, string | null>;
  /** The hash of any key, name nodes computed on demand; undefined for a key it does not know. */
  hash(key: string): string | null | undefined;
  /** The p: nodes a p: node has edges to, sorted. */
  dependencies(key: string): readonly string[];
  /** The p: node a bare import of `name` from directory `dir` loads, or null. */
  locate(name: string, dir: string): string | null;
}
```

npm's lockfile is adapted to it, with no change to its nodes or edges. That includes the ⊥ nodes of packages a package declares but npm did not install.

### 8.2 The builder (`core/graph/static.ts`)

- The package loop adds every node of `lockfile.nodes` and its edges, whatever the format.
- `addResolution` calls `locate`. On null it adds today's ⊥ node and uncertainty cause.
- `readLockfile(vfs)` gains what classic yarn needs: the workspace members and a way to read their `package.json`.

### 8.3 The planner (`core/select/plan.ts`)

- **Recomputed `p:` nodes:** for every `p:` key in the map, the hash at H is `head.lockfile.hash(key)`, else ⊥. Lookup locations, entries, name nodes and `#env` are recomputed alike. `hash()` computes a name node that case 2 of §6.4 added to the map, and answers for case 3's ⊥ node once the lockfile knows its name.
- **The shadow rule** runs for npm lockfiles only, as today (§6.3).
- **Untrusted maps:** a change of the lockfile's kind or path is L3, where today only its path is compared. So a move from Berry to classic, or from yarn to pnpm, runs everything once, with that cause in the summary.
- **Unparseable lockfiles:** unchanged.
- **`inputs.ignore`** matches an entry or a name node as `node_modules/<name>`, the same pattern that already matches its lookup location at the root, and `#env` as `pnpm-lock.yaml`. So ignoring an eslint bump stays one pattern per package.

### 8.4 SMAP

- **`META`'s lockfile kind** gains three values, each followed by the lockfile's path: 3 pnpm, 4 yarn Berry, 5 classic yarn. Kinds 0 to 2 keep their bytes. [docs/smap-format.md](../../smap-format.md) §4.1 and its validation rule ("a lockfile kind of 0 to 5") change in place. The engine id, not the format version, keeps old readers and new maps apart.
- **`HASH`:** entry, name-node and `#env` hashes are SHA-256, form 1. Lookup-location hashes are an id or `link:<dir>`, form 2.
- **Golden vectors:** the fixture uses npm, so `golden.smap` changes only in the engine id.

### 8.5 The CLI

- `trommel diff` reports package changes between two lockfiles of one kind: the `p:` keys added, changed and removed. Between kinds it says so, as it does today between npm and anything else.
- `trommel graph` prints the lockfile as `{kind, path}`.

### 8.6 The engine id

The engine becomes `trommel-static-4`: maps of pnpm and yarn repositories have new nodes. Both golden hashes move with the engine id and with nothing else. **Expect one run-all plan** on each branch until a push to `main` caches a `trommel-static-4` map.

## 9. Tests and proof

### 9.1 Readers

- **YAML subset:** every accepted construct, every refused one with the line it names, and a seeded generator that writes random documents in pnpm's and Berry's style, which the reader must return exactly.
- **Each format:** small hand-written fixtures that reproduce every feature of §5: both pnpm shapes, peers, aliases, `link:`, a tarball key with a colon, references to a workspace version, Berry workspaces, `patch:` entries, a redirected reference, Plug'n'Play and node-modules settings, classic descriptor lists and workspaces declared in `package.json`.
- **Totality:** truncated and mutated fixtures parse or are refused, and nothing else.

### 9.2 Soundness

The selector's soundness property (`select/plan.test.ts`, 2,000 runs) gains lockfile kinds. Its oracle must not reuse the readers' lookup, or it could not catch a wrong one. Today's property calls `locate`; this one does not.
- **The generator** builds a random package universe and a random install:
  - an isolated layout for pnpm;
  - a hoisted layout for Berry and classic yarn, placed by a small hoister in the test;
  - a Plug'n'Play layout for Berry.

  It writes the lockfile from that install, at S and again at H, after random bumps, additions, removals, re-pointed dependencies and new declarations. Classic yarn's peers are left out (§6.7).
- **The oracle** walks the generated install as Node does, or as Plug'n'Play does, and computes for each test the set of (entry id, content) pairs it loads at S and at H.
- **The assertion:** every test whose set differs is selected. The allowed exceptions are the two residual cases of §6.4, and nothing else:
  - the copy of a name the test's own workspace package does not declare changed, while that name's node did not;
  - in a hoisted Berry layout, an unmet peer that Node finds by position reached another copy, while the peer's name node did not change.

  The property counts each case separately, and a test exempt only by a mix of the two as a third, mixed case (ruling R11, which awaits Ojas's confirmation). It fails on any other miss.
- **What the property cannot see:** the exemption reads the name-node hash from the system under test. A mutant that weakens that hash is classed as a residual, and the model's own tests (`model.test.ts`) catch it instead. Likewise, pointing a file straight at an entry is covered by the escalation of changed packages that no test reaches, and the planner's example tests catch it.
- **Hand mutants** include:
  - dropping a dependency from an entry's hash;
  - pointing a file straight at an entry;
  - dropping the dependents from a name node's hash;
  - walking up to an ancestor's lookup instead of taking the name node.

### 9.3 This repository

- The map differs from `main`'s only by the engine id.
- The last 70 commits select the same tests, with the same why-paths and escalations, as the CLI on `main`. This is the history replay of DECISIONS 32 and 34.

### 9.4 The corpus (needs Ojas's approval to clone)

On hono and one yarn repository, preferably excalidraw:
- every version of the lockfile in the last 12 months parses, or the refusals are counted and explained;
- every lockfile-only commit is planned, and the report counts them by outcome: a subset selected, L1 at the root with the package that caused it, or anything else.

Under DECISIONS 29, which stands (Ojas, 2026-11-15), a bump of a package no test reaches escalates the root package. That covers dev tools such as typescript, eslint and wrangler. So many lockfile-only commits will still run everything, now as L1 with a named cause instead of L3. The counts let the replay set up its `inputs.ignore`.

### 9.5 Benchmarks

`bench/lockfile.ts` reads lockfiles given by path and records parse time and node and edge counts. The numbers go to `bench/results/` and [bench/README.md](../../../bench/README.md). Expect tens of milliseconds for a 600 KB lockfile; well over 100 ms would need a look.

**The samples stay out of the repository.** They were downloaded on 2026-11-15 to a session scratchpad that will not last. Fetching them again is a download, so the build asks Ojas first. Each is `https://raw.githubusercontent.com/<repository>/<commit>/<file>`:

| Repository | Commit | Files |
|---|---|---|
| honojs/hono | `f6fbaf0299c48eea9e656e03e2ffe7ac755e8823` | `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| colinhacks/zod | `fef16cba0cf6668eb25ecc32fdfe2ce0a46f6f80` | `pnpm-lock.yaml`, `.npmrc` |
| prettier/prettier | `2cc4f0fd2cc44a970229a5cb025cd47c63f31b04` | `yarn.lock`, `.yarnrc.yml` |
| toss/es-toolkit | `24e7a7b8cb8035fae1ea2e7b507aab96698a38b9` | `yarn.lock`, `.yarnrc.yml` |
| excalidraw/excalidraw | `3a317b55f508815d10a4c12acca99df30f026521` | `yarn.lock`, `.npmrc` |

### 9.6 Done when

1. The five samples parse with no refusal, and every reference resolves or takes a name node.
2. The soundness property, the generator round trip and the totality tests are green on every CI OS, and the hand mutants are caught.
3. This repository's map differs only by the engine id, and the 70-commit replay is identical.
4. On the corpus repositories of §9.4, no lockfile-only commit escalates to L3 because its lockfile cannot be read. The why-paths of selected tests name the changed packages, and the commits that end in L1 at the root are counted, each with its cause.

## 10. How it lands

Two pull requests, as SMAP did:

1. **`m1/lockfile-readers`:** the YAML subset and the pnpm, Berry and classic readers, with §9.1's tests and the benchmark. They have no caller, so no plan changes and the engine stays `trommel-static-3`. DECISIONS 36 records it.
2. **`m1/lockfile-cutover`:** the interface, builder, planner, SMAP kinds, CLI and engine `trommel-static-4`, with §9.2 to §9.4. In the same pull request, the documents that follow the decision: DECISIONS 37, architecture §3.1 (the `p:` kinds) and §3.5 (as built), [docs/smap-format.md](../../smap-format.md), HANDOFF §1, §4, §8, §11 and §13, the roadmap's progress line, bench/README.md, and §5's survey in bench/CORPUS.md.

## 11. Left to the builder

- Module layout and names, for example `core/lockfile/{yaml,pnpm,yarn}.ts`.
- Refusal reasons, which should name the line or the entry.
- The flow-nesting limit.
- Whether npm's lockfile implements the interface or is wrapped.
- How the classic reader receives the workspace `package.json` files.
- `trommel diff`'s exact output, within canonical JSON.
- Whether classic yarn's duplicate ids are refused, as §7.4 says, or disambiguated. A disambiguated id must not change when an unrelated entry changes.
- The hoister in §9.2's test. It needs to be faithful enough to produce the nested copies of §6.4, not to copy yarn's.

**Not in scope, for later if the numbers ask for it:**
- **Reading pnpm's `node-linker`.** In the isolated layout, case 2 of §6.4 could then walk up to the declaring importer exactly, and win back the name node's precision on pnpm monorepos.
- **Scoping an unreached package's escalation** to the workspace packages whose lookups lead to it, instead of the root. It would refine DECISIONS 29, and helps only tools that are declared per package. §9.4's counts say whether it is worth it.

## 12. Decided in review (2026-11-15)

A reviewer read the design against the code. These three questions went to Ojas, who took the recommendation on each:
1. **A name a file's own workspace package does not declare** takes the name node, whose hash covers its copies, who declares it and who depends on which copy. Second-order hoisting moves are a known gap (§6.4). npm's shadow rule stays npm's (§6.3).
2. **DECISIONS 29 stands.** A bump of a package no test reaches escalates the root. Done means no L3 because the lockfile cannot be read, and §9.4 counts the L1 commits (§9.4, §9.6).
3. **Classic yarn's peers** are a known gap (§6.7).

These were settled without Ojas, as calls he can check:
- Berry's workspace entries are importers, not entries (§7.3).
- Readers read past fields outside the resolved graph (§7).
- Where the samples come from, and that fetching them again needs approval (§9.5).
