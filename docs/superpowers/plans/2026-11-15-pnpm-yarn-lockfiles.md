# pnpm and yarn lockfiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse pnpm 9.0, yarn Berry 8 and 10, and classic yarn v1 lockfiles into package nodes, so that a lockfile change reruns only the tests that reach a changed package.

**Architecture:**
- Three readers turn lockfile text into one resolved model: importers, entries and references.
- `lockfileFromModel` turns that model into nodes, edges and a lookup behind a `Lockfile` interface, which npm's lockfile also implements.
- The builder, the planner and `trommel diff` see only the interface.
- Part 1 lands the readers with no caller. Part 2 cuts over and moves the engine to `trommel-static-4`.

**Tech Stack:** TypeScript on Node 22.18 or later, run through type stripping. Vitest 5.1 and fast-check 4.10.2. No new dependency.

**Spec:** [docs/superpowers/specs/2026-11-15-pnpm-yarn-lockfiles-design.md](../specs/2026-11-15-pnpm-yarn-lockfiles-design.md). Read its §6 (the model) and §7 (the readers) before any task.

## Global Constraints

- **Dependencies and APIs:**
  - Zero runtime dependencies in `packages/core` and `packages/cli`; `npm run check:deps` stays clean.
  - Node 22 APIs only (`@types/node` 22).
  - `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties. Relative imports end in `.ts`, and types use `import type`.
- **Data handling:**
  - Parsed keys live in `Map`s, never in plain objects. `canonicalJson` gets plain objects built from sorted entries, because it throws on a `Map`.
  - Strings sort by UTF-16 code unit: `a < b ? -1 : a > b ? 1 : 0`.
  - A reader returns a `ResolvedModel` or an `Unparseable`. It never throws anything else, never hangs, and runs in time linear in its input.
- **Node keys,** exactly as spec §6.1:
  - a lookup is `p:npm:<dir>/node_modules/<name>`, or `p:npm:node_modules/<name>` at the root;
  - an entry is `p:pnpm:<id>` or `p:yarn:<id>`;
  - a name node is `p:pnpm:<name>@*` or `p:yarn:<name>@*`;
  - pnpm's own document is `p:pnpm:#env`.
- **Engine and golden hashes:** the engine stays `trommel-static-3` through Task 8, and neither golden hash (`test/graph/golden.test.ts`, `test/smap/golden.test.ts`) may move until then. Task 9 makes the engine `trommel-static-4` and moves both hashes by the engine id alone.
- **Tests:** tests come first. Property tests are seeded (`TROMMEL_FC_SEED`, default `20261116`). After each test file passes, mutate the code by hand to prove the tests can fail, and note the mutants for DECISIONS 36 or 37.
- **Commits:** small and conventional, made with `git commit -s`, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ask Ojas first** before the first push, any merge, downloading the five samples again (spec §9.5) and cloning corpus repositories (spec §9.4). Never force-push.
- **Commands:** one test file with `npm test -- <path>`. The whole suite with `npm test`, plus `npm run lint`, `npm run typecheck` and `npm run check:deps`.

## Review Focus

1. **CRLF and a BOM.** A lockfile committed with CRLF line endings, or one that starts with U+FEFF, reads exactly as its LF twin. (Task 2)
2. **Names that are `Object.prototype` keys.** `__proto__`, `constructor` and `hasOwnProperty`, as keys, package names and descriptors, are ordinary names, and `Object.prototype` is untouched. (Tasks 2 and 3)
3. **Unusual importer directories.** A workspace at `packages/@scope/b`, and the root importer `.`, give the directories `packages/@scope/b` and `''`, and lookup keys that cannot collide with entry keys. (Task 4)
4. **Empty lockfiles.** A pnpm lockfile with only `importers: {.: {}}`, a Berry lockfile with only `__metadata`, and a classic lockfile with only its header read as empty models, not as refusals. (Tasks 4, 5 and 6)
5. **Merge-conflict markers.** A lockfile holding `<<<<<<<`, `=======` or `>>>>>>>` lines is refused by every reader, with a reason that names the line. It is never read in part. (Task 7)

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/lockfile/yaml.ts` | The strict YAML subset (spec §7.1) |
| `packages/core/src/lockfile/lockfile.ts` | The `Lockfile` interface, `LockfileKind`, and `diffLockfiles` from Task 12 on |
| `packages/core/src/lockfile/model.ts` | `ResolvedModel`, `lockfileFromModel`, `nameOfId`: spec §6 |
| `packages/core/src/lockfile/pnpm.ts` | pnpm 9.0 → model (spec §7.2) |
| `packages/core/src/lockfile/yarn-berry.ts` | Berry 8 and 10 → model (spec §7.3) |
| `packages/core/src/lockfile/yarn-classic.ts` | classic v1 → model (spec §7.4) |
| `packages/core/src/lockfile/npm.ts` | Gains `npmLockfile`; `detectLockfile` learns pnpm and yarn |
| `packages/core/src/graph/static.ts` | `readLockfile` dispatch, the builder over the interface, `ENGINE` |
| `packages/core/src/select/plan.ts` | Recompute through the interface, the shadow rule for npm only, `pathOf`, kind changes |
| `packages/core/src/smap/smap.ts` | `META` lockfile kinds 3, 4 and 5 |
| `packages/cli/src/cli.ts` | `trommel diff` over any two lockfiles of one kind |
| `packages/core/test/lockfile/*.test.ts` | One test file per source file, plus `fuzz.test.ts` |
| `packages/core/test/fixtures/lockfile/` | Hand-written fixtures modelled on the samples of spec §5 |
| `packages/core/test/select/install-tree.ts` | The generated installs and the Node-walk oracle (Task 11) |
| `bench/lockfile.ts` | Parse time and counts for lockfiles given by path |

---

# Part 1: the readers (pull request `m1/lockfile-readers`)

### Task 1: Worktree setup and a green baseline

**Files:** none tracked, then the spec and this plan.

- [ ] **Step 1: Link this worktree's packages.** A worktree has no `node_modules` of its own, so `@trommel/*` would resolve to the main checkout's sources (HANDOFF §12). Create directory junctions `node_modules/@trommel/{core,cli,vitest,jest,tool-corpus,tool-replay,tool-toyrepo}` pointing at this worktree's `packages/*` and `tools/*`, with PowerShell's `New-Item -ItemType Junction`, and delete `node_modules/.vitest-cache` if it exists. Nothing is downloaded.
- [ ] **Step 2: Run** `npm test`, `npm run lint`, `npm run typecheck` and `npm run check:deps`. Expected: 712 tests pass in 36 files, and the other three print nothing.
- [ ] **Step 3: Branch and commit the design.** Run `git switch -c m1/lockfile-readers`. Then `git add docs/superpowers` and commit with `git commit -s -m "docs: design and plan for pnpm and yarn lockfiles"`.

### Task 2: The YAML subset

**Files:**
- Create: `packages/core/src/lockfile/yaml.ts`
- Test: `packages/core/test/lockfile/yaml.test.ts`

**Interfaces — produces:**

```ts
export type YamlValue = string | readonly YamlValue[] | YamlMap;
export type YamlMap = ReadonlyMap<string, YamlValue>;
export class YamlError extends Error { readonly line: number }  // 1-based; message ends "(line N)"
export const FLOW_DEPTH = 8;
/** Every document of `text`, split at lines that are exactly `---`; each document is a mapping. */
export function parseYamlSubset(text: string): YamlMap[];
```

- [ ] **Step 1: Write the example tests.** In `describe('parseYamlSubset')`:
  - `'reads block mappings and every scalar form'`: `"a: b\nc:\n  d: 'e''f'\n  g: \"h\\ni\"\n"` gives one map, `a` → `'b'` and `c` → `{d: "e'f", g: 'h\ni'}`.
  - `'reads one-line flow collections'`:
    - `resolution: {integrity: sha512-x, tarball: https://r/x.tgz}` gives a map;
    - `cpu: [x64, arm64]` gives `['x64', 'arm64']`;
    - `x: {}` and `y: []` give an empty map and an empty array.
  - `'reads block sequences indented under their key'`: `"t:\n  - supports-color\n"` gives `t` → `['supports-color']`.
  - `'keeps a colon inside a plain key'`: the key `zod443@https://registry.npmjs.org/zod/-/zod-4.4.3.tgz` survives whole.
  - `'splits documents, and skips blank lines and comments'`: `"---\na: 1\n---\nb: 2 # c\n"` gives two maps, and `b` → `'2'`.
  - `'reads CRLF and a leading BOM as LF'` (Review Focus 1): the same document with `\r\n`, and with a leading `\uFEFF`, deep-equals its LF form.
  - `'treats prototype names as ordinary keys'` (Review Focus 2): the keys `__proto__`, `constructor` and `hasOwnProperty` are in the map, and `({} as Record<string, unknown>)['polluted']` stays `undefined`.
  - `it.each` over refusals, each a `YamlError` whose `line` is the given line:
    - a tab in the indentation;
    - an anchor `&a`, an alias `*a` or a tag `!!str`;
    - a block scalar `|` or `>`;
    - a complex key `? x`, or a directive `%YAML 1.2`;
    - a duplicate key;
    - an indentation of 3;
    - a flow collection that continues on the next line;
    - a plain scalar that continues on the next line;
    - flow nesting deeper than `FLOW_DEPTH`;
    - an unterminated quote;
    - a plain scalar starting with `@` or a backtick;
    - a double-quoted escape JSON lacks (`\x41`);
    - a document whose root is a scalar.
- [ ] **Step 2: Write the generator property.**
  - **Generator:** `yamlMapArb` builds maps of maps, arrays and strings. Keys and values include `:`, `#`, both quotes, `@`, `__proto__`, non-ASCII text and empty strings.
  - **Emitter:** a test-only `emit(map, style: 'pnpm' | 'berry')` writes them as the two lockfiles do. pnpm style uses single quotes where needed and flow maps for leaf maps; Berry style uses double quotes.
  - **Property** `'returns exactly the document it was given'`: `parseYamlSubset(emit(m, style))` deep-equals `[m]`, over 1,000 runs per style.
- [ ] **Step 3: Run** `npm test -- packages/core/test/lockfile/yaml.test.ts`. Expected: FAIL, `parseYamlSubset` is not defined.
- [ ] **Step 4: Implement `parseYamlSubset`.**
  - Make one pass over the lines, keeping a stack of indentation levels.
  - Flow collections go through a small recursive scanner that refuses nesting past `FLOW_DEPTH`.
  - A block-sequence item sits exactly two spaces deeper than its key.
  - Every scalar is a string.
- [ ] **Step 5: Run** the file, then lint and typecheck. Expected: PASS and no output. Hand-mutate the duplicate-key check, the depth limit and the `''` escape, and confirm each mutant fails a test.
- [ ] **Step 6: Commit:** `git commit -s -m "feat(core/lockfile): a strict YAML subset for pnpm and Berry lockfiles"`.

### Task 3: The resolved model and the `Lockfile` interface

**Files:**
- Create: `packages/core/src/lockfile/lockfile.ts`, `packages/core/src/lockfile/model.ts`
- Test: `packages/core/test/lockfile/model.test.ts`

**Interfaces — produces:**

```ts
// lockfile.ts
export type LockfileKind = 'npm' | 'pnpm' | 'yarn-berry' | 'yarn-classic';
export interface Lockfile {
  readonly kind: LockfileKind;
  readonly path: string;
  /** The nodes this lockfile always defines: key → hash, null for ⊥. */
  readonly nodes: ReadonlyMap<string, string | null>;
  /** The hash of any key of this lockfile, name nodes included on demand; undefined if it is none of its keys. */
  hash(key: string): string | null | undefined;
  /** The keys a key has edges to, sorted and unique; [] for a key it does not know. */
  dependencies(key: string): readonly string[];
  /** Spec §6.4: a lookup key, a name-node key, or null. `dir` is POSIX, '' for the root. */
  locate(name: string, dir: string): string | null;
}

// model.ts
export type Ref = { readonly kind: 'entry'; readonly id: string } | { readonly kind: 'link'; readonly dir: string } | { readonly kind: 'unresolved' };
export interface ModelEntry {
  readonly name: string;
  /** Plain, canonical-JSON-able data that identifies the content (spec §7). */
  readonly content: unknown;
  /** `dependencies` and `optionalDependencies`, by name. */
  readonly dependencies: ReadonlyMap<string, Ref>;
  /** Berry only: the names of its peerDependencies. */
  readonly peers: readonly string[];
}
export interface ResolvedModel {
  /** Importer directory ('' for the root) → declared name → what it resolves to. */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, Ref>>;
  readonly entries: ReadonlyMap<string, ModelEntry>;
  /** pnpm's own document as plain data, or null. */
  readonly env: unknown;
}
export function lockfileFromModel(kind: 'pnpm' | 'yarn-berry' | 'yarn-classic', path: string, model: ResolvedModel): Lockfile;
/** `@scope/x@…` → `@scope/x`; `x@…` → `x`. Works for pnpm ids, Berry resolutions and classic ids. */
export function nameOfId(id: string): string;
export function lookupKey(dir: string, name: string): string;
```

**What `lockfileFromModel` computes:**
- **Prefix:** `p:pnpm:` for pnpm, `p:yarn:` for both yarns.
- **The text of a reference:** an entry is its `id`, a link is `link:<dir>`, and an unresolved reference is `<name>@*`. Its target is the entry's key, nothing for a link, and the name node's key for an unresolved reference.
- **Lookup nodes:** one per importer and declared name. The hash is the reference's text; the edges are its target.
- **Entry nodes:**
  - The hash is `sha256(canonicalJson({ content, dependencies: {name: referenceText…}, peers: sortedPeers }))`.
  - The edges are the dependencies' targets, plus the name node of each peer.
- **Name nodes:**
  - The hash is `sha256(canonicalJson({ entries, declared, dependents }))`, built from three sorted lists:
    - `entries`: the ids of the entries named N;
    - `declared`: `[dir, referenceText]` for each importer that declares N;
    - `dependents`: `[entryId, referenceText]` for each entry that depends on N.
  - The hash is `null` when all three lists are empty.
  - The edges are the keys of every entry id the three lists name.
- **`#env`:** when `env` is not null, `p:pnpm:#env` hashes to `sha256(canonicalJson(env))` and has no edges.
- **`nodes`:** every lookup, every entry and `#env`, plus each name node that an unresolved reference or a peer points at. `hash()` computes any other name node on demand and keeps it.

- [ ] **Step 1: Write the tests,** each from small hand-built models:
  - `'a lockfile-only bump changes the lookup of the package that moved and nothing of the one that stayed'`: `a` and `b` both use `foo@1.0.0`, then `a` moves to `foo@1.1.0`.
    - The hash of `p:npm:packages/a/node_modules/foo` goes from `'foo@1.0.0'` to `'foo@1.1.0'`.
    - `p:npm:packages/b/node_modules/foo` and `p:pnpm:foo@1.0.0` keep their hashes.
  - `'an entry whose dependency moves changes hash, though its content did not'`.
  - `'locate follows spec §6.4'`. The root declares `vitest`, and `packages/a` declares `foo`:
    - `locate('foo', 'packages/a/src')` is `'p:npm:packages/a/node_modules/foo'`;
    - `locate('vitest', 'packages/a/test')` is `'p:pnpm:vitest@*'`;
    - `locate('vitest', 'scripts')` is `'p:npm:node_modules/vitest'`;
    - `locate('bar', 'packages/a')` is `'p:pnpm:bar@*'` when `bar` is only an entry;
    - `locate('nope', 'packages/a')` is `null`.
  - `'a name node changes when a copy appears, a declaration moves or a dependent re-points, and not otherwise'`.
  - `'a name node points at every entry its lists name'`: an alias. The root declares `zod3` → entry `zod@3.24.3`, so `dependencies('p:pnpm:zod3@*')` is `['p:pnpm:zod@3.24.3']`.
  - `'links hash as link:<dir> and have no edges'`, and `'unresolved references point at a name node that is in nodes'`.
  - `'#env has its own hash and no edges'`.
  - `'prototype names work end to end'` (Review Focus 2).
  - `'nodes and dependencies do not depend on the order the model was built in'`.
  - `'nameOfId'`:
    - `'@babel/code-frame@npm:7.29.7'` → `'@babel/code-frame'`;
    - `'fsevents@patch:fsevents@npm%3A2.3.3#…'` → `'fsevents'`;
    - `'zod443@https://registry.npmjs.org/…'` → `'zod443'`;
    - `'@vitest/coverage-v8@5.0.1(vitest@5.0.1)'` → `'@vitest/coverage-v8'`.
- [ ] **Step 2: Run** the file. Expected: FAIL, the module does not exist.
- [ ] **Step 3: Implement** `lockfile.ts` and `model.ts` as specified above.
- [ ] **Step 4: Run** the file, lint and typecheck. Expected: PASS. Hand-mutate dropping `dependencies` from the entry hash, dropping `dependents` from the name-node hash, and walking up to an ancestor's lookup in `locate`, and confirm each fails a test.
- [ ] **Step 5: Commit:** `git commit -s -m "feat(core/lockfile): the resolved model behind one Lockfile interface"`.

### Task 4: The pnpm reader

**Files:**
- Create: `packages/core/src/lockfile/pnpm.ts`
- Create: `packages/core/test/fixtures/lockfile/pnpm-two-documents.yaml`, `packages/core/test/fixtures/lockfile/pnpm-one-document.yaml`
- Test: `packages/core/test/lockfile/pnpm.test.ts`

**Interfaces:**
- Consumes `parseYamlSubset` (Task 2), `ResolvedModel` and `Ref` (Task 3), and `Unparseable` from `npm.ts`.
- Produces `export function parsePnpmLockfile(text: string): ResolvedModel | Unparseable`, whose refusals have `format: 'pnpm'`.

**Rules (spec §7.2):**
- **Documents:** one, or two where the first is pnpm's own. The first document's top-level keys must be a subset of `lockfileVersion`, `importers`, `packages` and `snapshots`, and its importer `.` may hold only `configDependencies` and `packageManagerDependencies`. That document becomes `env`.
- **Version:** `lockfileVersion` must equal `'9.0'`.
- **Importer directories:** `.` becomes `''`.
- **A `version` of `link:<rel>`:** a link to `joinPath(importerDir, rel)`, using `joinPath` from `resolve/resolver.ts`.
- **Other values:**
  - A value matching `/^(?:@[^/@()\s:]+\/)?[^/@()\s:]+@/` is an alias, and the value itself is the id. Otherwise the id is `<name>@<value>`.
  - An id in `snapshots` is an entry; anything else is unresolved.
- **Entries:**
  - The base is the key cut at the first `(` after the `@` that `nameOfId` splits at, and `packages` must hold the base.
  - The content is the base's `resolution` map, as a plain sorted object.
  - The entry's dependencies are its snapshot's `dependencies` and `optionalDependencies`.

- [ ] **Step 1: Write the fixtures.**
  - **`pnpm-two-documents.yaml`:**
    - pnpm's own document, then a project document with the importers `.`, `packages/a` and `packages/@scope/b`;
    - the peer key `@vitest/coverage-v8@5.0.1(vitest@5.0.1)`;
    - the alias `zod3: zod@3.24.3`;
    - `link:../@scope/b`;
    - the tarball key `zod443@https://registry.npmjs.org/zod/-/zod-4.4.3.tgz`;
    - `ai@6.0.5(zod@4.6.7)`, whose dependency `zod: 4.6.7` has no snapshot;
    - `@esbuild/darwin-arm64@0.27.7`, with `optional: true` and `os: [darwin]`.
  - In both fixtures, the project document also holds `settings`, `catalogs` and `overrides`.
  - **`pnpm-one-document.yaml`:** the same project document alone.
- [ ] **Step 2: Write the tests:**
  - `'reads both documents of a pnpm 12 lockfile, pnpm's own as env'`.
  - `'one document gives env null and the same project model'`.
  - `'aliases, links, tarball keys and peer suffixes resolve as spec §7.2 says'`:
    - the root's `zod3` is `{kind: 'entry', id: 'zod@3.24.3'}`;
    - `packages/a`'s `@scope/b` is `{kind: 'link', dir: 'packages/@scope/b'}`;
    - the entry `@vitest/coverage-v8@5.0.1(vitest@5.0.1)` has name `@vitest/coverage-v8` and its base's integrity as content.
  - `'a reference to the workspace's own version is unresolved'`: `ai@6.0.5(zod@4.6.7)`'s `zod`.
  - `'packages for other platforms are entries'` (spec §6.6).
  - `'reads past settings, catalogs and overrides'` (spec §7): the model is the same with those keys removed.
  - `'importer directories keep scopes, and . is the root'` (Review Focus 3).
  - `'a lockfile with only an empty root importer is an empty model'` (Review Focus 4).
  - `it.each` over refusals: each gives `kind: 'unparseable'` and `format: 'pnpm'`, with a reason matching the given pattern:
    - `lockfileVersion: '6.0'`, and an unquoted `lockfileVersion: 9`: `/lockfileVersion/`;
    - three documents: `/document/`;
    - a first document holding `settings`: `/pnpm's own/`;
    - a snapshot with no `packages` entry: `/no packages entry/`;
    - an importer dependency with no `version`: `/version/`;
    - a `packages` entry with no `resolution` map: `/resolution/`;
    - a YAML refusal, passed through with its line: `/line \d+/`.
- [ ] **Step 3: Run** the file. Expected: FAIL.
- [ ] **Step 4: Implement `parsePnpmLockfile`** per the rules above.
- [ ] **Step 5: Run,** lint and typecheck. Expected: PASS. Hand-mutate the alias rule, the peer-suffix cut and the env-shape check, and confirm each fails a test.
- [ ] **Step 6: Commit:** `git commit -s -m "feat(core/lockfile): read pnpm lockfiles, format 9.0, in both shapes"`.

### Task 5: The Berry reader

**Files:**
- Create: `packages/core/src/lockfile/yarn-berry.ts`
- Create: `packages/core/test/fixtures/lockfile/yarn-berry-8.lock`, `packages/core/test/fixtures/lockfile/yarn-berry-10.lock`
- Test: `packages/core/test/lockfile/yarn-berry.test.ts`

**Interfaces:**
- Consumes `parseYamlSubset` and the Task 3 types.
- Produces `export function parseYarnBerryLockfile(text: string): ResolvedModel | Unparseable`, whose refusals have `format: 'yarn'`.

**Rules (spec §7.3):**
- **The document:** exactly one. `__metadata.version` must be `'8'` or `'10'`.
- **Keys:** every other top-level key is split at `', '` into descriptors. Each descriptor maps to its entry, and a descriptor that appears twice is refused.
- **Workspace entries:** an entry whose `resolution` matches `/^(.+)@workspace:(.*)$/` is an importer at that directory, with `.` becoming `''`. Its `dependencies` become declarations.
- **Other entries:** the id is the `resolution`, and the name is `nameOfId(resolution)`. The content is `{ resolution, checksum: checksum ?? null }`, and `peers` are the keys of `peerDependencies`.
- **References:** a dependency `name: range` is the descriptor `` `${name}@${range}` ``. It resolves to the entry that descriptor maps to, or to a link when that entry is a workspace, and is otherwise unresolved.
- **`env`:** always null.

- [ ] **Step 1: Write the fixtures.** The two files differ only in `__metadata.version` (8 and 10) and their checksum prefixes (`10c0/` and `10/`). Each holds:
  - workspaces at `.` and `docs`;
  - a key with three descriptors;
  - `resolve@patch:resolve@npm%3A^1.22.11#optional!builtin<compat/resolve>` with a hashed resolution;
  - an entry with `peerDependencies`;
  - `remark-parse@npm:8.0.3` asking for `trim: "npm:0.0.1"`, while only `trim@npm:1.0.1` exists;
  - `conditions` and `dependenciesMeta`.
- [ ] **Step 2: Write the tests:**
  - `'workspace entries become importers, not entries'`.
  - `'versions 8 and 10 give the same model apart from checksums'`.
  - `'a redirected reference is unresolved'`.
  - `'patch entries are ordinary entries named after their package'`.
  - `'peers are listed by name'`.
  - `'a lockfile with only __metadata is an empty model'` (Review Focus 4).
  - `it.each` over refusals:
    - version 6: `/version/`;
    - no `__metadata`: `/__metadata/`;
    - an entry with no `resolution`: `/resolution/`;
    - a descriptor in two keys: `/descriptor/`;
    - a YAML refusal: `/line \d+/`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement `parseYarnBerryLockfile`.**
- [ ] **Step 5: Run,** lint and typecheck. Expected: PASS. Hand-mutate treating workspace entries as entries, and dropping `peers`, and confirm each fails a test.
- [ ] **Step 6: Commit:** `git commit -s -m "feat(core/lockfile): read yarn Berry lockfiles, versions 8 and 10"`.

### Task 6: The classic yarn reader

**Files:**
- Create: `packages/core/src/lockfile/yarn-classic.ts`
- Create: `packages/core/test/fixtures/lockfile/yarn-classic.lock`
- Test: `packages/core/test/lockfile/yarn-classic.test.ts`

**Interfaces:**
- Consumes the Task 3 types.
- Produces:

```ts
export interface ClassicWorkspace {
  /** Importer directory ('' for the root) → name → range, from dependencies, devDependencies and optionalDependencies of its package.json. */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Workspace package name → its directory. */
  readonly packages: ReadonlyMap<string, string>;
}
export function parseYarnClassicLockfile(text: string, workspace: ClassicWorkspace): ResolvedModel | Unparseable; // format 'yarn'
```

**Rules (spec §7.4):**
- **Header:** the leading comment block must hold the line `# yarn lockfile v1`.
- **Entry lines:** a line at column 0 ending in `:` lists descriptors separated by `', '`. Each descriptor is bare, or double-quoted as a JSON string.
- **Fields:** lines at two spaces are `key value`, with the value bare or double-quoted. `dependencies:` and `optionalDependencies:` open four-space lines of `name range`. Any other indentation or shape is refused.
- **Entries:** the id is `` `${name}@${version}` ``, and a duplicate id is refused. The content is `{ integrity }` when there is an integrity, else `{ resolved }`.
- **References:** a reference `name@range` is the entry that descriptor names; else a link when `name` is in `workspace.packages`; else unresolved. The importers' declarations resolve the same way.

- [ ] **Step 1: Write the fixture:** a multi-descriptor entry, one entry with `optionalDependencies`, one entry with `resolved` and no `integrity`, and a scoped name in a quoted descriptor.
- [ ] **Step 2: Write the tests:**
  - `'importers come from the declarations it is given'`.
  - `'a workspace package declared by range is a link'`.
  - `'each descriptor of an entry resolves to it'`.
  - `'integrity is the content, resolved when there is none'`.
  - `'a declared range with no entry that is no workspace package is unresolved'`.
  - `'a lockfile with only its header is an empty model'` (Review Focus 4).
  - `it.each` over refusals:
    - no header: `/yarn lockfile v1/`;
    - a duplicate `name@version`: `/duplicate/`;
    - a six-space line: `/line \d+/`;
    - a descriptor in two entries: `/descriptor/`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement `parseYarnClassicLockfile`.**
- [ ] **Step 5: Run,** lint and typecheck. Expected: PASS. Hand-mutate preferring `resolved` over `integrity`, and skipping the workspace-link fallback, and confirm each fails a test.
- [ ] **Step 6: Commit:** `git commit -s -m "feat(core/lockfile): read classic yarn lockfiles"`.

### Task 7: Totality, the benchmark, the samples and the first pull request

**Files:**
- Test: `packages/core/test/lockfile/fuzz.test.ts`
- Create: `bench/lockfile.ts`, `bench/results/2026-11-<day>-lockfile-win32.json`
- Modify: `bench/README.md`, `DECISIONS.md` (entry 36), `HANDOFF.md` (§1 status and §4 repository map), `packages/core/src/index.ts` (export the readers and the Task 3 names)

- [ ] **Step 1: Write the totality property.** For each fixture of Tasks 4 to 6 and its reader (classic with an empty `ClassicWorkspace`), make seeded mutations: truncate at a random offset, delete, duplicate or swap a random line, or replace a random character. Each result is a model or `kind: 'unparseable'`, and nothing throws. 2,000 runs per reader.
- [ ] **Step 2: Write the pathological cases:**
  - 10,000 nested `[` are refused by the depth limit;
  - a 1 MB single-line value reads in one pass;
  - `'every reader refuses merge-conflict markers, naming the line'` (Review Focus 5).
- [ ] **Step 3: Run** the file. Expected: PASS; fix any reader that throws.
- [ ] **Step 4: Write `bench/lockfile.ts`.**
  - `node bench/lockfile.ts <file>…` picks the reader by file name and header, using an empty `ClassicWorkspace` for classic yarn.
  - For each file it prints the bytes, the median parse time over 5 runs in milliseconds, and the counts of entries, importers, references and unresolved references.
  - It writes the JSON result to `bench/results/`.
- [ ] **Step 5: Ask Ojas** to download the five samples of spec §9.5 again, into a new empty scratch directory. Run the benchmark on them. Expected:
  - no refusal;
  - unresolved references: hono 0, zod 5, prettier 1, es-toolkit 0, excalidraw 0.

  Record the numbers in `bench/README.md`.
- [ ] **Step 6: Write DECISIONS 36:** the subset, reading past fields, the refusals, the sample numbers and the mutants of Tasks 2 to 7. Update HANDOFF §1 and §4.
- [ ] **Step 7: Run** `npm test`, `npm run lint`, `npm run typecheck` and `npm run check:deps`. Expected: all pass, and the golden hashes are unchanged.
- [ ] **Step 8: Commit** with `git commit -s -m "test(core/lockfile): totality, benchmark and DECISIONS 36"`. Ask Ojas before pushing, then open the pull request `m1/lockfile-readers` → `main`.

---

# Part 2: the cut-over (pull request `m1/lockfile-cutover`, branched from `m1/lockfile-readers`)

### Task 8: npm behind the interface, with nothing else changing

**Files:**
- Modify: `packages/core/src/lockfile/npm.ts`, `packages/core/src/graph/static.ts`, `packages/core/src/select/plan.ts`, `packages/cli/src/cli.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/lockfile/npm.test.ts`

**Interfaces — produces:**

```ts
// npm.ts
export function npmLockfile(parsed: NpmLockfile, path: string): Lockfile; // kind 'npm'
// static.ts
export type LockfileState =
  | { readonly kind: 'parsed'; readonly lockfile: Lockfile }
  | { readonly kind: 'unparseable'; readonly paths: readonly string[]; readonly reason: string }
  | { readonly kind: 'none' };
```

`MapLockfile` does not change in this task.

**What `npmLockfile` returns:**
- `nodes`: `p:npm:<location>` → its hash, plus the ⊥ node `p:npm:node_modules/<name>` of every missing dependency;
- `dependencies(key)`: the resolved locations' keys and those ⊥ nodes;
- `locate`: the `p:npm:` key of the location, or null.

- [ ] **Step 1: Write the tests:**
  - `'npmLockfile exposes every location as a p:npm: node with its hash'`;
  - `'its dependencies are the resolved locations and the ⊥ nodes of missing names'`;
  - `'locate returns the p:npm: key Node would load'`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement `npmLockfile`, and move the callers to the interface:**
  - the builder's package loop and `addResolution`;
  - the planner's recomputation of `p:` keys, which becomes `lockfile.hash(key) ?? null`;
  - its shadow rule, over the `p:npm:` keys of `lockfile.nodes`;
  - `trommel diff`, which still calls `diffLockfiles` on the underlying `NpmLockfile`.
- [ ] **Step 4: Run** `npm test`. Expected: every existing test passes unchanged, both golden hashes included.
- [ ] **Step 5: Commit:** `git commit -s -m "refactor(core): read npm lockfiles through the Lockfile interface"`.

### Task 9: pnpm and yarn in the map, SMAP's new lockfile kinds, engine `trommel-static-4`

**Files:**
- Modify: `packages/core/src/lockfile/npm.ts` (`detectLockfile`), `packages/core/src/graph/static.ts`, `packages/core/src/smap/smap.ts`, `docs/smap-format.md` (§4.1 and its validation list)
- Test: `packages/core/test/graph/static.test.ts`, `packages/core/test/smap/smap.test.ts`, `packages/core/test/graph/golden.test.ts`, `packages/core/test/smap/golden.test.ts`, `packages/core/test/lockfile/npm.test.ts`

**Interfaces — produces:**

```ts
export type DetectedLockfile = { readonly kind: 'npm' | 'pnpm' | 'yarn'; readonly path: string } | (Unparseable & { readonly path: string }) | { readonly kind: 'none' };
export type MapLockfile =
  | { readonly kind: LockfileKind; readonly path: string }
  | { readonly kind: 'unparseable'; readonly paths: readonly string[]; readonly reason: string }
  | { readonly kind: 'none' };
export const ENGINE = 'trommel-static-4';
// smap.ts META lockfile kinds: 0 none, 1 npm, 2 unparseable, 3 pnpm, 4 yarn-berry, 5 yarn-classic (each of 1, 3, 4, 5 followed by str path)
```

**Rules:**
- **`detectLockfile`:** bun is refused with `bun lockfiles are not parsed`.
- **`readLockfile`** picks the reader:
  - pnpm → `parsePnpmLockfile`;
  - yarn whose text holds `# yarn lockfile v1` → classic, otherwise Berry.
- **The classic `ClassicWorkspace`** comes from `new Resolver(vfs).workspaces()`. Its importers are `''` plus its `members`, each read from `<dir>/package.json` through `vfs.read` and `JSON.parse`. A member whose `package.json` cannot be read is refused with `<dir>/package.json cannot be read`. Its packages are the workspace names and their directories.
- **The builder:**
  - It adds every node of `lockfile.nodes` with its `dependencies`.
  - In `addResolution`, a `locate` result not yet in the map, a name node from case 2, is added with `lockfile.hash(key)` and its edges.
  - A `null` result keeps today's ⊥ node and uncertainty cause.

- [ ] **Step 1: Write the static tests:**
  - `'maps a pnpm workspace: lookups, entries, name nodes and #env'`. The repository has a root and `packages/a`, and `packages/a/test/x.test.ts` imports `foo`, declared by `a`, and `vitest`, declared by the root. Expect:
    - the edges `f:packages/a/test/x.test.ts` → `p:npm:packages/a/node_modules/foo` → `p:pnpm:foo@1.0.0`;
    - the edges `f:packages/a/test/x.test.ts` → `p:pnpm:vitest@*` → `p:pnpm:vitest@5.0.1`;
    - `p:pnpm:#env` with no edges;
    - `map.lockfile` equal to `{kind: 'pnpm', path: 'pnpm-lock.yaml'}`.
  - `'maps a Berry workspace'` and `'maps a classic yarn workspace from its package.json files'`, with the same shape.
  - `'a name the lockfile does not know is uncertain, as with npm'`: the cause is `line 1: nope is not in pnpm-lock.yaml`.
  - Rewrite `'makes external imports depend on a lockfile it cannot parse'` to use `bun.lock`, and add a pnpm `lockfileVersion: '6.0'` case whose reason matches `/lockfileVersion/`.
- [ ] **Step 2: Write the SMAP tests:**
  - each new kind round-trips;
  - the rejection test `'a lockfile kind of 3'` becomes `'a lockfile kind of 6'`.
- [ ] **Step 3: Run** them. Expected: FAIL.
- [ ] **Step 4: Implement** the rules above, the three SMAP kinds and the engine id, and update `docs/smap-format.md` §4.1 and its rule "a lockfile kind of 0 to 5".
- [ ] **Step 5: Move the golden hashes.**
  - First assert that the golden map's canonical JSON differs from its Task 8 form only in `engine`.
  - Then update the pinned SHA-256 values, length and layer addresses in both golden tests.
- [ ] **Step 6: Run** `npm test`, lint and typecheck. Expected: PASS.
- [ ] **Step 7: Commit:** `git commit -s -m "feat(core)!: pnpm and yarn lockfiles in the map; engine trommel-static-4"`.

### Task 10: The planner on pnpm and yarn

**Files:**
- Modify: `packages/core/src/select/plan.ts`
- Test: `packages/core/test/select/plan.test.ts`, in a new `describe('pnpm and yarn lockfiles')`

**Rules:**
- **`untrusted`:** compares `` `${kind} ${path}` ``, so a change of kind is an L3 whose cause names both kinds.
- **`pathOf`:**
  - a `p:pnpm:` or `p:yarn:` entry is `node_modules/<nameOfId(id)>`;
  - a name node `…:<name>@*` is `node_modules/<name>`;
  - `p:pnpm:#env` is `pnpm-lock.yaml`.
- **The shadow rule:** runs only when the head lockfile's kind is `npm`.

- [ ] **Step 1: Write the tests:**
  - `it.each(['pnpm', 'yarn-berry', 'yarn-classic'])` `'a lockfile-only bump in packages/a selects a's tests and not b's'`.
  - `'a test importing a root-declared name reruns when another copy of that name appears'` (pnpm).
  - `'adding a dependency to packages/b that the root also declares does not escalate the root'`: no escalation has `scope: ''`.
  - `'pnpm's own document changing alone escalates the root'`: the cause is `p:pnpm:#env changed and no test reaches it`.
  - `'a change of yarn lockfile flavour runs everything'`: the cause is `the lockfile changed from yarn-classic yarn.lock to yarn-berry yarn.lock`.
  - `'inputs.ignore node_modules/eslint exempts an unreached eslint bump'`: `ignored` contains `node_modules/eslint`, and nothing escalates.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the three rules.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, with every existing npm test unchanged.
- [ ] **Step 5: Commit:** `git commit -s -m "feat(core/select): plan pnpm and yarn lockfile changes"`.

### Task 11: The lockfile soundness property

**Files:**
- Create: `packages/core/test/select/install-tree.ts`, `packages/core/test/select/lockfile-soundness.test.ts`

**Interfaces — produces (test-only):**

```ts
export type Layout = 'pnpm' | 'berry-node-modules' | 'berry-pnp' | 'classic';
export interface Install { /* the universe, the importers' declarations and every placed copy */ }
export function installPairArb(layout: Layout): fc.Arbitrary<{ readonly s: Install; readonly h: Install }>;
/** The repository files: lockfile, package.json files, workspace config and test files, ready for fakeRepo. */
export function writeRepo(install: Install, layout: Layout): Record<string, string>;
/** Oracle: what `test` loads, walking the placed install as Node (or Plug'n'Play) does. Never calls a reader or `locate`. */
export function loads(install: Install, layout: Layout, test: string): readonly string[];
```

**The generator (spec §9.2):**
- **The universe:** the names `a` to `e`, at versions `1.0.0` and `2.0.0`. Each version depends on 0 to 2 name-and-version pairs, and in Berry has at most one peer.
- **The importers** are `''`, `pkgs/p` and `pkgs/q`, each with random declarations. The tests are `x.test.ts`, `pkgs/p/x.test.ts` and `pkgs/q/x.test.ts`, each importing 1 to 3 of the names.
- **The layouts:**
  - **pnpm** is isolated: each importer's `node_modules` holds exactly its declarations.
  - **Hoisted** (classic and `berry-node-modules`):
    - the root's declarations go to `node_modules/<n>`;
    - an importer's declaration goes to the root when that slot is free or holds the same version, else to `<importer>/node_modules/<n>`;
    - a package's dependency goes to the highest `node_modules` on its path whose slot is free or holds that version, else under the package.
  - **Plug'n'Play:** a workspace package loads only what it declares, and an undeclared name loads `missing <n>`.
- **H is S after one or two edits:** bump a declared version, add or remove a declaration, re-point an entry's dependency, or add a second version that some entry uses. Classic yarn gets no peers (spec §6.7).

- [ ] **Step 1: Write the property** `'selects every test whose loaded packages changed'`, 700 runs per layout, 2,800 runs in all.
  - For each test present in both, a difference between `loads` at S and at H means the test must be selected.
  - There is one exception, the residual of spec §6.4: every differing item is reached only through a name N that the test's own importer does not declare, and `lockfile.hash('<prefix>N@*')` is equal at S and at H. Those are counted, and the count is printed.
  - `expect(otherMisses).toEqual([])`.
- [ ] **Step 2: Run** it. Expected: PASS on the code of Tasks 3 to 10. A failure is a real miss: fix the code, not the oracle.
- [ ] **Step 3: Check the mutants.** Each of these must fail the property:
  - dropping `dependencies` from the entry hash;
  - pointing a file straight at an entry;
  - dropping `dependents` from the name-node hash;
  - walking up to an ancestor's lookup instead of taking the name node.

  Note them for DECISIONS 37.
- [ ] **Step 4: Commit:** `git commit -s -m "test(core/select): lockfile soundness over generated installs"`.

### Task 12: `trommel diff` over any lockfile

**Files:**
- Modify: `packages/core/src/lockfile/lockfile.ts` (gains `diffLockfiles`), `packages/core/src/lockfile/npm.ts` (loses its `diffLockfiles`), `packages/cli/src/cli.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/lockfile/npm.test.ts` (its `diffLockfiles` cases move into `packages/core/test/lockfile/lockfile.test.ts`), `packages/cli/test/cli.test.ts`

**Interfaces — produces:** `export function diffLockfiles(before: Lockfile, after: Lockfile): { added: string[]; changed: string[]; removed: string[] }`. It works over `nodes` and returns full `p:` keys, sorted.

- [ ] **Step 1: Write the tests:**
  - `'diffLockfiles reports p: keys added, changed and removed'`, for npm and for pnpm. The moved npm case now expects `p:npm:node_modules/zod`.
  - In the CLI, `'diff between two pnpm commits lists the changed packages'`.
  - `'diff between lockfile kinds says so'`: the output is `{before: 'npm package-lock.json', after: 'pnpm pnpm-lock.yaml', unknown: 'package changes are only computed between two lockfiles of one kind'}`.
  - The existing CLI test at `cli.test.ts:102` still passes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -s -m "feat(cli): trommel diff reports pnpm and yarn package changes"`.

### Task 13: Proof, documents and the second pull request

**Files:**
- Modify: `DECISIONS.md` (entry 37), `docs/architecture.md` (§3.1 `p:` kinds, §3.5 as built), `HANDOFF.md` (§1, §4, §8, §11, §13), `docs/roadmap.md` (the progress line), `bench/README.md`, `bench/CORPUS.md` (the survey table of spec §5)

- [ ] **Step 1: Replay this repository's last 70 non-merge commits** with `main`'s CLI and this branch's, as for DECISIONS 32 and 34:
  - Extract `main` with `git archive <main-sha> packages package.json bench`, and add junctions for its `@trommel/core` and `@trommel/cli`.
  - At each commit, run `trommel graph --rev <c>^`, then `trommel plan --mode shadow --static --map <dir> --head <c>`.
  - Run it in the background. Expected: on all 70, the tests that would run, the why-paths and the escalations are identical.
- [ ] **Step 2: Ask Ojas to clone `honojs/hono` and `excalidraw/excalidraw`** (spec §9.4). Then:
  - parse every version of their lockfile from the last 12 months, and count and explain the refusals;
  - plan every lockfile-only commit, and count them by outcome: a subset selected, L1 at the root with the package that caused it, or anything else.

  Expected: no L3 that names an unreadable lockfile.
- [ ] **Step 3: Run** `node bench/static-graph.ts`. Expected: this repository's numbers match `main`'s within noise.
- [ ] **Step 4: Write the documents.**
  - **DECISIONS 37:** the cut-over, the engine, the replay, the corpus counts and the mutants.
  - **Architecture:** the `p:` kinds in §3.1, and §3.5 as built.
  - **HANDOFF:**
    - §1: the status, and that each branch should expect one run-all plan;
    - §4: the repository-map rows;
    - §8: strike the lockfile item;
    - §11: add the known gaps (second-order hoisting moves, classic yarn's peers, the name node's precision on pnpm monorepos), and remove "Only npm lockfiles are parsed";
    - §13: entries 36 and 37.
  - **Roadmap:** the progress line.
  - **bench/README.md**, and the spec §5 survey table in **bench/CORPUS.md**.
- [ ] **Step 5: Run** `npm test`, `npm run lint`, `npm run typecheck` and `npm run check:deps`. Expected: all pass.
- [ ] **Step 6: Commit** with `git commit -s -m "docs: pnpm and yarn lockfiles are parsed (DECISIONS 37)"`. Ask Ojas before pushing, then open the pull request `m1/lockfile-cutover`. Retarget it to `main` once `m1/lockfile-readers` is merged.
