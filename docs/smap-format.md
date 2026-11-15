# The SMAP format, version 0

- **Status:** normative. The decision is [ADR-0009](adr/0009-smap-binary-map-format.md); this document gives the bytes.
- **Code:** `packages/core/src/smap/` (`bytes.ts`, `container.ts`, `smap.ts`). **Tests and vectors:** `packages/core/test/smap/`.
- **Scope of version 0:** the container, the snapshot layer and the static layer. The record layer is added in M3 as new sections. Chunking is defined in M5.
- **Related:** [architecture.md](architecture.md) §4.2, [DECISIONS.md](../DECISIONS.md) entry 33.

A SMAP file is a map: a snapshot of a git tree, and the graph that the tree, the config and the static engine give for it. It holds nothing about the machine that wrote it and no timestamp.

**One map has one encoding.** Every rule below that says "the shortest form", "ascending" or "the longest" exists so that two writers cannot produce different bytes for the same map. A reader rejects anything else. A file that a reader accepts is therefore the file a writer would have written, and a content address means "the same map".

**A file that fails any check is invalid.** A plan from an invalid map runs everything.

## 1. Primitives

Every multi-byte integer is little-endian.

| Name | Encoding |
|---|---|
| `u8`, `u16`, `u32` | Unsigned integers of 1, 2 and 4 bytes |
| `varint` | Unsigned LEB128: seven bits per byte, low bits first, the high bit set on every byte but the last. The value is below 2³², so it takes at most five bytes. Only the shortest form is valid: the last byte is zero only for the value 0 |
| `oid` | A git object id as raw bytes: 20 for `sha1`, 32 for `sha256`, as the header says |
| `str` | A `varint` byte length, then that many bytes of text (§1.1) |
| front-coded list | A sequence of strings where each is written against the one before it (§1.2) |

### 1.1 Text

Text is UTF-8, with one extension. A string in the map is a sequence of UTF-16 code units, and it may hold a surrogate that is not half of a pair: the lexer decodes escapes, so `import './\uD800'` gives such a node key. UTF-8 cannot hold it.

- A surrogate pair is the four-byte UTF-8 form of the character it stands for.
- An unpaired surrogate is the three bytes of its code point: `U+D800` is `ed a0 80`. This is the WTF-8 rule. In Python it is `s.encode('utf-8', 'surrogatepass')`.
- A high surrogate followed by a low surrogate is never written as two three-byte forms.
- No overlong form, and no code point above U+10FFFF.
- Nothing is normalized, and a leading U+FEFF is a character like any other.

Git paths are byte strings that Trommel reads as UTF-8, so a path never holds an unpaired surrogate. Keys, glob patterns and uncertain causes can.

### 1.2 Order and front coding

**Order.** Wherever strings are sorted, they are compared by UTF-16 code unit. This is the order canonical JSON uses for keys and the order of JavaScript's `<` on strings. It differs from code-point order, and from the byte order of UTF-8, for a character above U+FFFF against one in U+E000 to U+FFFF: `U+1F600` (units `d83d de00`) sorts before `U+FF5E` (unit `ff5e`).

**Front coding.** Each string of the list is written as:

```
shared  varint   bytes it shares with the start of the string before it; 0 for the first
rest    str      the bytes after those
```

`shared` is the longest possible: when the string before has more bytes, the first byte of `rest` differs from that string's byte at position `shared`. The count is of bytes, so a shared prefix may end inside a character.

## 2. Container

```
header
  magic     8 bytes   89 53 4d 41 50 0d 0a 1a      "\x89SMAP\r\n\x1a"
  format    u16       0
  hash      u8        1 = sha1, 2 = sha256
  reserved  u8        0
  engine    str       the static engine id, such as "trommel-static-4"
  count     u16       number of sections
section table, 16 bytes per section
  tag       4 bytes   ASCII, each A-Z or 0-9
  layer     u8        1 snapshot, 2 static, 3 records (M3)
  flags     u8        bit 0 = required; the other bits are zero
  version   u16
  offset    u32       of the body, from the start of the file
  length    u32       of the body
section bodies
trailer     32 bytes  SHA-256 of every byte before it
```

- **The magic** follows PNG's. Its first byte has the high bit set, and it holds a CR LF and a control-Z, so a tool that treats the file as text damages it at once.
- **Bodies** are in table order with no gap: the first starts where the table ends, each next one where the last ended, and the trailer follows the last body.
- **Tags** are unique within a file.
- **Layers** ascend through the table, so the sections of one layer are adjacent.
- **An unknown section** is skipped when it is optional and makes the file invalid when it is required. The same holds for a known tag at a version the reader does not know.
- **Limits.** A file is under 4 GiB, and has at most 65,535 sections.

A reader checks the magic first, then the format, then the trailer, then everything else. So a file that is not SMAP, or is a later format, is reported as that and not as a damaged trailer.

### 2.1 Content addresses

Each layer has a content address: the SHA-256 of

```
"smap-layer" 00          the ASCII text and a zero byte
format   u16
hash     u8
layer    u8
engine   str             for the static layer (layer 2) only
then, for each section of the layer in table order:
  tag  flags  version  length  body
```

with `tag`, `flags`, `version` and `length` exactly as the table holds them.

- The snapshot layer's address does not cover the engine. The same tree gives the same snapshot layer under every engine.
- The static layer's address covers the engine, since the graph is a function of the tree, the config and the engine.
- An address is derived from the file, never stored in it.

## 3. Snapshot layer

One section: `SNAP`, version 0, required, layer 1. It is the output of `git ls-tree -r -t`: every blob, symlink, gitlink and tree of the snapshot.

```
root         oid       the root tree
undecodable  varint    how many paths were not valid UTF-8
count        varint
entries, sorted by path, each:
  mode       varint    the octal mode as a number: 100644 is 33188; below 1000000 octal
  oid        oid
  path       front-coded against the entry before
```

- Paths are strictly ascending, so none is empty and none repeats.
- A reader shows a mode as six octal digits: `040000` for a tree.
- A path that was not valid UTF-8 is stored as its lossy rendering and counted in `undecodable`. A plan from a map with a non-zero count runs everything.

## 4. Static layer

Seven sections, each version 0, required and in layer 2, in this order: `META`, `KEYS`, `EDGE`, `HASH`, `GLOB`, `TEST`, `UNCT`.

A **node** is a key string: `f:` a file path, `d:` a directory listing, `g:` a glob or other matched set, `p:` a package, `r:` and `c:` resolution hubs, `u:` an uncertain file. The text before the first colon is the node's **kind**, and it is never empty. A node's **id** is its position in `KEYS`. An id never appears outside the file it is in.

### 4.1 `META`

```
tree      oid                the root tree this graph was derived from; equal to SNAP's root
config    u8 0               there is no trommel.config.json
       or u8 1, oid          its blob id
lockfile  u8 0               none
       or u8 1, str          npm: the lockfile's path
       or u8 2, str, varint n, n × str
                             unparseable: the reason, then every lockfile present
       or u8 3, str          pnpm: the lockfile's path
       or u8 4, str          yarn Berry: the lockfile's path
       or u8 5, str          classic yarn: the lockfile's path
```

### 4.2 `KEYS`

```
count   varint
keys    one front-coded list, strictly ascending
```

### 4.3 `EDGE`

Forward adjacency: an edge goes from a dependent to what it depends on. A reader derives the reverse index.

```
total   varint                 the number of edges, E
for each node, in id order:
  degree   varint
  targets  degree × varint     ascending. The first is an id; each later one is the gap
                               from the target before it, at least 1
provenance  E bytes            one per edge, in the same order
```

A provenance byte is a bitmask: bit 0 static, bit 1 dynamic, bit 2 declared. It is 1 to 7. Two edges between the same nodes are one edge whose byte is the OR of both.

### 4.4 `HASH`

A hash is stored only where a plan cannot derive it.

- **Derived, and not in the file:** the hashes of `f:`, `d:` and `u:` nodes (§4.8).
- **Stored:** the hash of every node of any other kind. Today those are `g:`, `p:`, `r:` and `c:`.

For each node whose kind stores a hash, in id order:

```
u8 0                  absent (⊥): the package or path does not exist
u8 1, 32 bytes        a SHA-256
u8 2, str             any other text
```

A value that is 64 lowercase hex digits is always form 1. Form 2 is for package hashes, which are npm integrity strings, `link:` targets, or a version and a URL, and, for a pnpm or yarn lookup location, the id of the entry it resolves to. The hashes of pnpm and yarn entries, name nodes and pnpm's own document are SHA-256, form 1.

### 4.5 `GLOB`

For each `g:` node, in id order:

```
u8 0                              no patterns are recorded (g:workspaces, which the resolver recomputes)
u8 1, varint n, n × str           the patterns, in the order they were given
```

### 4.6 `TEST`

```
count   varint
ids     count × varint     the f: nodes of the test files, ascending and gap-coded as targets are
```

### 4.7 `UNCT`

For each `u:` node, in id order:

```
count    varint
causes   count × str        why the file is uncertain
```

### 4.8 The derived hashes

A reader that wants these hashes computes them. A plan needs none of them: it finds changed files and listings from the snapshot diff, and treats every `u:` node as changed.

| Kind | Hash |
|---|---|
| `f:<path>` | ⊥ when the snapshot has no entry at the path, or a tree. The object id as hex when the mode is `100644`. Otherwise the mode, a colon and the object id: `100755:…`, `120000:…`, `160000:…` |
| `d:<dir>` | ⊥ when the snapshot has no tree at the path (the root, `d:`, always exists). Otherwise the SHA-256 of the canonical JSON of the directory's entries as `[name, kind]` pairs sorted by name, where the kind is `d` for a tree, `m` for a gitlink, `l` for a symlink and `f` for any other blob |
| `u:<path>` | The SHA-256 of the canonical JSON of the node's causes, as an array |

Canonical JSON here is an array with no whitespace, its strings written as `JSON.stringify` writes them.

**A writer checks these.** If a map gives an `f:`, `d:` or `u:` node any other hash, it cannot be written. That is how the format holds the static graph to being a function of the tree.

## 5. What a reader checks

Each failure makes the file invalid.

- **Container:** the magic, the format, the trailer, the hash algorithm, the reserved byte; then the table: tag characters, unique tags, known flag bits, layers from 1 and ascending, bodies adjacent and inside the file, nothing between the last body and the trailer.
- **Sections:** every section of §3 and §4 is present once, required, at version 0, in its layer and in the order given. A required section that the reader does not know is an error.
- **Engine:** the header's engine id is the one the reader expects. A graph built by another engine is not safe to plan from.
- **Every section** is read to its last byte and no further.
- **Every count** is checked against the bytes left before anything is sized by it.
- **Primitives:** varints and text in their only valid form; shared prefixes the longest possible.
- **`SNAP`:** paths strictly ascending; modes below 1000000 octal.
- **`META`:** the tree equal to `SNAP`'s root; a config flag of 0 or 1; a lockfile kind of 0 to 5.
- **`KEYS`:** strictly ascending; each key with a kind.
- **`EDGE`:** targets ascending and below the node count; the degrees adding up to the total; provenance 1 to 7.
- **`HASH`:** a form of 0 to 2; no SHA-256 in form 2.
- **`GLOB`:** a flag of 0 or 1.
- **`TEST`:** ids ascending, each of an `f:` node.

## 6. Test vectors

### 6.1 Vector 1: every section, by hand

The map, as the canonical JSON model has it:

```
objectFormat  sha1          engine   trommel-static-4
rootTree      aa × 20       config   none        undecodable  0
lockfile      npm, package-lock.json
snapshot      100644  11 × 20  a.test.ts
              100644  22 × 20  a.ts
nodes         0  f:a.test.ts              11 × 20, derived
              1  f:a.ts                   22 × 20, derived
              2  g:glob:k                 cc × 32
              3  p:npm:node_modules/x     "sha512-X"
              4  p:npm:node_modules/y     ⊥
              5  u:a.ts                   cb0fc93f…9a6841, derived: SHA-256 of ["line 1: lexer E"]
edges         0 → 1 static, 0 → 2 declared, 1 → 3 static, 1 → 4 static, 1 → 5 static
globs         g:glob:k: "*.ts"
tests         a.test.ts
uncertain     u:a.ts: "line 1: lexer E"
```

The file is 460 bytes. Its SHA-256 is `649fe9a2c389b077a7448c8df4e1649e28216a5849b3d7ba0a7a7772825647f8`.

```
offset  bytes                                              meaning

header
     0  89 53 4d 41 50 0d 0a 1a                            magic
     8  00 00                                              format 0
    10  01                                                 sha1
    11  00                                                 reserved
    12  10 "trommel-static-4"                              engine: 16 bytes of text
    29  08 00                                              8 sections

section table            tag     layer flags version  offset       length
    31  53 4e 41 50  01  01  00 00  9f 00 00 00  52 00 00 00     SNAP  at 159, 82 bytes
    47  4d 45 54 41  02  01  00 00  f1 00 00 00  28 00 00 00     META  at 241, 40 bytes
    63  4b 45 59 53  02  01  00 00  19 01 00 00  3c 00 00 00     KEYS  at 281, 60 bytes
    79  45 44 47 45  02  01  00 00  55 01 00 00  11 00 00 00     EDGE  at 341, 17 bytes
    95  48 41 53 48  02  01  00 00  66 01 00 00  2c 00 00 00     HASH  at 358, 44 bytes
   111  47 4c 4f 42  02  01  00 00  92 01 00 00  07 00 00 00     GLOB  at 402, 7 bytes
   127  54 45 53 54  02  01  00 00  99 01 00 00  02 00 00 00     TEST  at 409, 2 bytes
   143  55 4e 43 54  02  01  00 00  9b 01 00 00  11 00 00 00     UNCT  at 411, 17 bytes

SNAP
   159  aa × 20                                            root tree
   179  00                                                 no undecodable path
   180  02                                                 2 entries
   181  a4 83 02                                           mode 33188, which is 100644 octal
   184  11 × 20                                            object id
   204  00  09 "a.test.ts"                                 path: shares 0, then 9 bytes
   215  a4 83 02                                           mode
   218  22 × 20                                            object id
   238  03  01 "s"                                         path: shares "a.t", then "s" → a.ts

META
   241  aa × 20                                            derived from this tree
   261  00                                                 no config
   262  01  11 "package-lock.json"                         an npm lockfile, 17 bytes of path

KEYS
   281  06                                                 6 keys
   282  00  0b "f:a.test.ts"                               node 0
   295  05  01 "s"                                         node 1: shares "f:a.t" → f:a.ts
   298  00  08 "g:glob:k"                                  node 2
   308  00  14 "p:npm:node_modules/x"                      node 3, 20 bytes
   330  13  01 "y"                                         node 4: shares 19 bytes → p:npm:node_modules/y
   333  00  06 "u:a.ts"                                    node 5

EDGE
   341  05                                                 5 edges
   342  02  01 01                                          node 0: 2 targets, 1, then a gap of 1 → 2
   345  03  03 01 01                                       node 1: 3 targets, 3, 4, 5
   349  00 00 00 00                                        nodes 2 to 5: none
   353  01 04 01 01 01                                     provenance: static, declared, static × 3

HASH
   358  01  cc × 32                                        node 2: a SHA-256
   391  02  08 "sha512-X"                                  node 3: other text
   401  00                                                 node 4: absent

GLOB
   402  01  01  04 "*.ts"                                  node 2: 1 pattern

TEST
   409  01  00                                             1 test, node 0

UNCT
   411  01  0f "line 1: lexer E"                           node 5: 1 cause, 15 bytes

trailer
   428  64 9d f8 77 d2 b5 c0 b5 e2 5d 47 cc 79 3b f2 9e
        08 55 df c3 ba 19 90 f1 c5 a1 fc 77 9e dc a6 f3    SHA-256 of bytes 0 to 427
```

Its layer addresses are `38f18a7d6a2595be651d1daf28fea5272f2bf23028500a371f5d8132b7c33672` (snapshot) and `a652ef6f72ef0e5b4fb81c194a250688943332c1eb6455f96e90bcdf06168956` (static).

`packages/core/test/smap/smap.test.ts` holds these bytes as hex, field by field, and compares the encoder's output with them.

### 6.2 Vector 2: the golden repository

The repository of `packages/core/test/graph/golden-fixture.ts`: 68 nodes of every kind, files of modes `100644`, `100755` and `120000`, and two file names that sort differently by code unit and by code point, one of them above U+FFFF. The file is committed as `packages/core/test/fixtures/smap/golden.smap`.

| | |
|---|---|
| Length | 3,779 bytes. The canonical JSON of the same map is 10,559 |
| SHA-256 of the file | `6f34de93c59906e017ea97dcb86487cd1c65140f77ba77acb9b9998452cf96c1` |
| Snapshot layer | `363d585752cce5e318523488e4434ae399c9cbdee216a39349b6e78e89e8f9e8` |
| Static layer | `49bef58675646f283c38057c0395baa36639a90e2184d170f4d4721b6993ed37` |
| SHA-256 of the map as canonical JSON | `e66292fe24cfeb58cc433ff95fa2bf5ab4133d99cc5b310dcc710dc3ba03739d` |

Its sections are `SNAP` 1,276 bytes, `META` 60, `KEYS` 762, `EDGE` 257, `HASH` 999, `GLOB` 95, `TEST` 5 and `UNCT` 134.

### 6.3 Vector 3: a SHA-256 repository

Five files with 32-byte object ids, built in `packages/core/test/smap/golden.test.ts`.

| | |
|---|---|
| Length | 1,045 bytes |
| SHA-256 of the file | `59b135a40122ae07ee9975b39e3948145018c894a400c7484f9e2bc7ad6468fa` |
| Snapshot layer | `4e9391e83c4e4ba4d151a800b46f43cc6989320fa83444abbff0ac3ea1219c34` |
| Static layer | `49a67692864ca575de0e83916c09480f44c94423e4f9e9b848d325714722f930` |

CI asserts vectors 2 and 3 on Ubuntu and on Windows.

## 7. Which number changes when

| Change | What moves |
|---|---|
| The builder gives a different graph for the same tree, or a plan must read a graph differently | The **engine id**. The static layer's address moves with it; the snapshot layer's does not |
| A section's layout changes | That **section's version**. A reader that does not know the version rejects the file, since every section so far is required |
| A layer is added | New **sections** with new tags. The format number stays: an older reader skips them when they are optional and rejects the file when they are required |
| The header, the table, the trailer or a primitive changes | The **format number** |
