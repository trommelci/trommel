# SMAP v0: design

- **Written:** 2026-11-14, at `main` = `f672238` (resolution hubs merged, engine `trommel-static-3`).
- **Status:** approved by Ojas on 2026-11-14. The codec (the first pull request of §4) is built: [DECISIONS.md](../../../DECISIONS.md) entry 33 records it, and [docs/smap-format.md](../../smap-format.md) is the specification that §5 became.
- **Scope:** item 4 of [HANDOFF.md](../../../HANDOFF.md) §1.1, the last of the four M1 items that change what a map contains.
- **Decided already, and not reopened here:** [ADR-0009](../../adr/0009-smap-binary-map-format.md) as corrected on 2026-11-13. This document fills in what the ADR leaves to the builder: the bytes, the API, the tests and how it lands.

## 1. Intent

The map is canonical JSON today ([DECISIONS.md](../../../DECISIONS.md) entry 23). SMAP v0 replaces it on disk with the binary container ADR-0009 describes.

**Why now.**
- M1's exit criteria name it: "byte-identical SMAP across OSes".
- M2 puts the node model inside every record. The container has to exist before records do, so that the record layer in M3 is a new section and not a second format.
- The JSON map is 7.1 MB at 10,000 files, and a plan parses it and rebuilds the graph arrays each time. Both costs grow with the repository.

## 2. Goals, non-goals, anti-goals

**Goals.**
1. A container with a header, a section table and a SHA-256 trailer, read and written with `DataView` and no dependency.
2. A snapshot layer and a static layer, each with its own content address.
3. **Lossless:** a map decodes to the same `TrommelMap` it was encoded from. The canonical JSON of the two is equal byte for byte.
4. **Canonical:** one map has exactly one encoding, and the decoder accepts nothing else. So `encode(decode(bytes))` gives back `bytes` for every file the decoder accepts. The one exception is a file with an optional section this decoder does not know: it is accepted, and that section is skipped.
5. **Total on bad input:** the decoder throws `MapError` on anything wrong, never another error, never a hang, and never allocates more than the file's size justifies. The plan then runs everything.
6. The same bytes on every OS and Node version, pinned in CI.
7. The planner's selections do not change.

**Non-goals.**
- The record layer (M3). The container reserves its layer number and nothing more.
- Chunking, chunk-local ids and the import table (M5).
- The Lite-mode cache key layout, `cache-mode` and the origin check (M3, ADR-0021).
- Compression inside the file. `actions/cache` already compresses.
- Any change to the builder, the node model or the planner's rules. The engine stays `trommel-static-3`.
- `trommel explain`, the pnpm and yarn parsers, and incremental extraction.

**Anti-goals.** These would make it a failure even if it worked:
- a decoder that accepts a damaged or crafted file and plans from it;
- two valid encodings of one map, so that a content address stops meaning "same map";
- a byte that depends on the machine, the clock or object insertion order;
- a second node model that drifts from the one the planner and the soundness property already use.

## 3. Constraints

- Zero runtime dependencies in `packages/core` and `packages/cli` (ADR-0002). Node 22.18 is the floor.
- Explicit little-endian through `DataView`. No typed-array view is laid over the file, since that would read in host byte order.
- `packages/core/src/smap/` joins the lint rule that keeps `process`, `node:os` and `environment.ts` out of the graph and selection modules (DECISIONS 28).
- Tests come first, property tests are seeded, and every test file is checked by mutating the code by hand (HANDOFF §2).
- ADRs may be corrected in place until 2026-11-16. This design needs two small corrections to ADR-0009 (§10), so the first PR should merge before then, or the corrections become a new ADR.

## 4. Approaches

Three ways to build it were weighed.

| | Approach | What it gives | What it costs |
|---|---|---|---|
| **A, picked** | SMAP v0 is a serialization of today's `TrommelMap`. The decoder returns that same structure, plus a `Graph` built straight from the adjacency section | The planner is untouched. The JSON map becomes the oracle: every property is "decodes to the same canonical JSON". The file shrinks and the CSR rebuild goes away | Decoding still materializes the node and edge objects. The benchmark measures that cost |
| B | A new in-memory model read lazily from the bytes, with the planner rewritten against it | The leanest plan at 100,000 files | Rewrites `plan.ts` and its 2,000-run soundness property just before M3 reshapes the planner around records. No oracle equality |
| C | Keep both formats readable for a while: the plan accepts `map.json` or `map.smap` | No run-all plan at the cut-over | Two validated readers of untrusted input. The last two engine bumps each accepted one run-all per branch |

**Why A.** It is the only one where "nothing about selection changed" is a property a test can state. B's speed is not needed yet: a plan takes 0.18 s at 10,000 files against a 1 s target. C buys one avoided run-all with a second attack surface.

**How it lands: two pull requests.**
1. **The codec.** `packages/core/src/smap/`, its tests, the golden vectors, the format specification and the ADR corrections. Nothing calls it yet, so no plan changes.
2. **The cut-over.** `trommel graph --out` writes SMAP, `trommel plan --map` reads it, `trommel.yml` and the benchmark follow, and the JSON reader is removed.

One PR would also work. Two keeps the format review apart from the behaviour change, and gets the ADR corrections in before the 16th.

## 5. The format

Everything is little-endian. This section becomes `docs/smap-format.md`, the normative specification, in the first PR.

### 5.1 Primitives

| Name | Encoding |
|---|---|
| `u8`, `u16`, `u32` | Unsigned integers |
| `varint` | Unsigned LEB128, at most 5 bytes, value below 2³². The shortest form only |
| `oid` | A git object id as raw bytes: 20 for `sha1`, 32 for `sha256`, as the header says |
| `str` | A `varint` byte length, then UTF-8. An unpaired surrogate, which UTF-8 cannot hold, is written as the three bytes of its code point (the WTF-8 rule). A surrogate pair is always the four-byte form. No overlong forms |
| front-coded list | Per string: a `varint` count of leading bytes shared with the previous string (0 for the first), then a `str` suffix. The shared count is the longest possible |

**Why the surrogate rule.** The lexer decodes escapes, so `import './\uD800'` gives a node key with an unpaired surrogate. JSON holds it as an escape. Plain UTF-8 would turn it into U+FFFD, and two different keys could become one. Git paths cannot contain one, so only keys, glob patterns and uncertain causes are affected.

**Order.** Wherever strings are sorted, the order is by UTF-16 code unit, as canonical JSON and the graph already sort. The decoder checks it on the decoded strings.

### 5.2 Container

```
header
  magic     8 bytes   89 53 4D 41 50 0D 0A 1A      "\x89SMAP\r\n\x1a"
  format    u16       0
  hash      u8        1 = sha1, 2 = sha256
  reserved  u8        0
  engine    str       the static engine id, "trommel-static-3"
  count     u16       number of sections
section table, 16 bytes per section
  tag       4 bytes   ASCII
  layer     u8        1 snapshot, 2 static, 3 records (M3)
  flags     u8        bit 0 = required; the other bits are zero
  version   u16
  offset    u32       from the start of the file
  length    u32
section bodies, in table order, with no gap between them
trailer     32 bytes  SHA-256 of every byte before it
```

- **The magic** follows PNG's: a high bit, a CR LF and a control-Z. A tool that treats the file as text damages it at once.
- **Sections of one layer are adjacent, and layers ascend.** The first body starts where the table ends, each starts where the last one ended, and the trailer follows the last.
- **An unknown section** is skipped when it is optional and makes the map invalid when it is required. The same holds for a known tag with an unknown version. A missing section that the decoder needs makes the map invalid.
- **A layer's content address** is the SHA-256 of: the ASCII bytes `smap-layer`, a zero byte, `format`, `hash`, the layer number, then for each of the layer's sections in table order its `tag`, `flags`, `version`, `length` and body. For the static layer, `engine` as a `str` follows the layer number. The snapshot layer's address therefore does not move when the engine does.
- **Limits.** A file is under 4 GiB and a map has under 2³² nodes and edges. The encoder throws past either.

### 5.3 Snapshot layer

`SNAP`, version 0, required.

```
root         oid       the root tree
undecodable  varint    paths that were not valid UTF-8
count        varint
entries, sorted by path
  mode       varint    the octal mode as a number: 100644 is 33188
  oid        oid
  path       front-coded
```

### 5.4 Static layer

Seven sections, all version 0 and required, in this order. A node's id is its position in `KEYS`.

| Tag | Contents |
|---|---|
| `META` | `tree`: the `oid` of the root tree this graph was derived from, equal to `SNAP`'s. `config`: `u8` 0, or `u8` 1 and the `oid` of `trommel.config.json`. `lockfile`: `u8` kind, then nothing for 0 (none), a `str` path for 1 (npm), or a `str` reason, a `varint` count and that many `str` paths for 2 (unparseable) |
| `KEYS` | A `varint` count, then the node keys as one front-coded list, strictly ascending |
| `EDGE` | A `varint` total E. Then per node in id order: a `varint` degree and that many `varint` targets, ascending. The first target is an id; each later one is the gap to the one before, at least 1. Then E provenance bytes in the same order, each 1 to 7 |
| `HASH` | For each node whose kind stores a hash, in id order: `u8` 0 for ⊥; `u8` 1 and 32 bytes for a SHA-256; `u8` 2 and a `str` for any other value. A value of 64 lowercase hex digits is always form 1 |
| `GLOB` | For each `g:` node in id order: `u8` 0 when the map records no patterns for it (`g:workspaces`), or `u8` 1, a `varint` count and that many `str` patterns |
| `TEST` | A `varint` count, then the ids of the test files' `f:` nodes, ascending and gap-coded like targets |
| `UNCT` | For each `u:` node in id order: a `varint` count and that many `str` causes |

**Which hashes are stored.** ADR-0009 stores a hash only where a plan cannot derive the change from the snapshot diff.
- **Derived, not stored:** `f:` (the blob id and mode, from `SNAP`), `d:` (the listing hash, from `SNAP`) and `u:` (the SHA-256 of its causes, from `UNCT`).
- **Stored:** every other kind. Today that is `g:`, `p:`, and the hubs `r:` and `c:`. A hub's hash depends on what its configs held at the base, and a plan in a depth-1 checkout cannot read those blobs. Package hashes are not SHA-256 values: they are npm integrity strings, `link:` targets or a version and URL, which is what form 2 is for.

**The encoder checks the derived kinds.** If a map gives an `f:`, `d:` or `u:` node a hash other than the derived one, encoding throws. That turns "the static graph is a function of the tree" from a comment into a check, and it is what makes the format lossless.

## 6. Code

```
packages/core/src/smap/
  bytes.ts       ByteWriter and a bounds-checked ByteReader; varint; str; front coding
  container.ts   header, section table, trailer, layer addresses
  smap.ts        encodeSmap and decodeSmap: the eight sections to and from TrommelMap
```

```ts
export function encodeSmap(map: TrommelMap): Uint8Array;

export interface Smap {
  readonly map: TrommelMap;
  /** Built from KEYS and EDGE directly; equal to mapGraph(map). */
  readonly graph: Graph;
  /** Content addresses, as hex. */
  readonly layers: { readonly snapshot: string; readonly static: string };
}

/** Throws MapError on anything wrong, including another engine's map. */
export function decodeSmap(bytes: Uint8Array, engine?: string): Smap;
```

- **`Graph.fromForward`**, new in `graph/graph.ts`, takes the names and the forward arrays and derives the reverse index by counting, as `GraphBuilder.build` already does after its merge. The review measured that derivation at 2.7 ms for 684,501 edges.
- **`selectStatic`** gains an optional `graph` argument, and falls back to `mapGraph(map)` without one. Nothing else in the planner changes.
- **`MapError`** stays where it is, in `graph/map.ts`, and the decoder throws it. The CLI already turns it into a run-all plan with the cause.

**What the decoder checks.** Each failure is a `MapError` that says what was wrong:
- the magic, format, hash algorithm, reserved byte and engine;
- the table: tags unique, flags known, layers ascending, bodies adjacent and inside the file;
- the trailer;
- every section read to its last byte and no further;
- every count against the bytes left, before anything is allocated;
- varints and strings in their only valid form; keys and paths strictly ascending; shared prefixes maximal;
- targets inside the node count and ascending; provenance 1 to 7; E equal to the sum of the degrees;
- tests are `f:` nodes; `META`'s tree equals `SNAP`'s root.

## 7. Tests

Written before the code they test, in `packages/core/test/smap/`.

| What | How |
|---|---|
| Primitives | Varint and `str` round trips over arbitrary values and strings, including unpaired surrogates. Each non-canonical form is rejected: a padded varint, an overlong sequence, a pair written as two surrogates, a short shared prefix |
| **Golden vector 1** | The smallest useful map, with its full bytes written out in the test and explained byte by byte in the specification |
| **Golden vector 2** | The fixture of `golden.test.ts`, which already has a path above U+FFFF and a name that sorts differently by code point. Pinned: both layer addresses, the file's SHA-256 and its length, next to the engine id. The bytes are also committed as `test/fixtures/smap/golden.smap`, so a second implementation has real input. `.gitattributes` marks `*.smap` binary |
| **Golden vector 3** | A small `sha256` repository, so 32-byte ids are pinned too |
| Round trip | Over random repositories from the planner's existing generator, in both object formats: the decoded map has the same canonical JSON, and re-encoding gives the same bytes |
| Graph | The decoded graph equals `mapGraph(map)`: names and all six CSR arrays |
| Truncation | Every prefix of the golden files is a `MapError` |
| Fuzzing | Mutate bytes and recompute the trailer, so the body is really parsed. The decoder either throws `MapError` or returns a map whose re-encoding equals the mutated input. No other error escapes, and no input hangs |
| Encoder checks | A map with a wrong derived hash, a bad mode or an edge to a missing node does not encode |

**Kept as it is:** the pinned SHA-256 of the fixture's canonical JSON. It pins the builder; the new pins cover the encoding. When one moves and the other does not, the failure says which side changed.

**Cross-OS.** `ci.yml` already runs every test on Ubuntu with Node 22, 24 and 26, and on Windows with Node 22. Before the first push the golden pins are also checked under WSL, from a type-stripped copy, as for DECISIONS 28 and 32.

## 8. The cut-over (second PR)

- **`trommel graph --out <file>`** writes SMAP. Without `--out` it still prints canonical JSON, which is the view a person reads.
- **`trommel plan --map <dir>`** reads `<dir>/map.smap` and passes the decoded graph to `selectStatic`.
- **`trommel.yml`** builds `.trommel/map/map.smap`. The cache key does not change: its layout is M3's work under ADR-0021.
- **One run-all plan per branch** follows, until a push to `main` caches a SMAP map. A restored cache that holds only `map.json` reads as "no map", and the summary says so.
- **`parseMap` and its tests are removed.** After the cut-over nothing reads a JSON map, and a second reader of untrusted input with no caller is a liability. The checks it made are the decoder's now. `mapGraph` and `MapError` stay: the first is the oracle for the decoded graph.
- **`bench/static-graph.ts`** records the SMAP size next to the JSON size, the encode and decode times, and the plan from a decoded map.
- **Proof that selection did not change:** this repository's last 70 non-merge commits, each planned from a map of its parent by `main`'s CLI and by the branch's. The selections must be identical on all 70, as for DECISIONS 32.

## 9. Documents

In the PR that makes each statement true:
- a new DECISIONS entry (33) with the layout, the calls in §11 and the evidence;
- `docs/smap-format.md`, linked from ADR-0009 and architecture §4.2;
- ADR-0009, corrected in place (§10);
- architecture §4.2, where "until SMAP v0 is built" goes;
- HANDOFF §1, §1.1 item 4, §4, §6, §8, §9 and §11; roadmap progress; README; `bench/README.md`.

## 10. Two corrections to ADR-0009

Both are Ojas's to approve, as the ADR's decider. Neither changes the decision; each makes a sentence true of the code.

1. **"A hash is stored only where a plan cannot derive the change from the snapshot diff: packages, globs and uncertain causes."** Hubs did not exist in code when this was written. Corrected: packages, globs and resolution hubs store a hash; an uncertain node stores its causes, and its hash is derived from them.
2. **"They are stored as UTF-8."** Corrected: UTF-8, with an unpaired surrogate written as the three bytes of its code point.

## 11. Calls made here, to check

None of these is in the ADR. Each is a builder's call and can be changed.

| Call | Reason |
|---|---|
| Format number 0 | The name is SMAP v0, and the record layer is an addition, not a new format |
| The engine id stays `trommel-static-3` | The builder's output is unchanged, and the JSON pin proves it. An older planner cannot read a SMAP file at all, and the new one cannot read a JSON map, so no plan crosses the change |
| A `layer` byte in each table entry | A layer's address can then be computed without knowing any tag |
| `META` repeats the root tree | The static layer names the snapshot it was derived from, so a mismatched pair is caught |
| `config` is stored, though the tree holds it | `buildStaticMap` takes it as an input, and the round trip must give back what went in |
| Modes as a varint of the octal number | Lossless for any mode a tree object can hold, where a five-value code would need an escape |
| Provenance in one run at the end of `EDGE` | It is long runs of one value, and the decoder copies it into the graph in one step |
| `--out` writes SMAP and stdout prints JSON, with no `--format` flag | Nobody needs SMAP on a terminal, and `>` already writes JSON to a file |
| The file is `.trommel/map/map.smap` | Same directory, so the cache path in `trommel.yml` is unchanged |
| The JSON reader is removed at the cut-over | §8 |
| Two pull requests | §4 |
| This document lives in `docs/superpowers/specs/` | The planning tool's default. It can stay out of the repository if that is preferred; DECISIONS 33 and the specification carry what lasts |

## 12. Left to the builder

- The internals of `ByteWriter` and `ByteReader`, and how the string codec picks its fast path.
- The generator details of the property tests, and the mutation counts of the fuzzer.
- The test helper `fake-tree.ts` makes SHA-1 ids only. Golden vector 3 needs it to make SHA-256 ids too.
- `decodeSmap` builds a `TreeIndex` from `SNAP` to derive the `f:` and `d:` hashes, and `selectStatic` builds one again from `map.snapshot`. Share it only if the benchmark shows the second build.
- Whether `decodeSmap` builds `map.edges` eagerly. Start eagerly, measure in the benchmark, and change it only if the number says so.
- The wording of each `MapError`.
