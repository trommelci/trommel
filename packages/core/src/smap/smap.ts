// SMAP v0 (ADR-0009, docs/smap-format.md): the map as a binary container. A snapshot layer holds
// the tree listing; a static layer holds the graph that the tree, the config and the engine give.
// The record layer is a new section in M3.
//
// The format is a serialization of TrommelMap and nothing more. `decodeSmap(encodeSmap(map))` gives
// back a map with the same canonical JSON, and a file that decodes re-encodes to the same bytes, so
// one map has one encoding and a layer's content address means "the same map".
//
// A hash is stored only where a plan cannot derive it (ADR-0009). File and directory hashes come
// from the snapshot, and an uncertain node's from its causes; the encoder refuses a map where they
// do not, which is what "the static graph is a function of the tree" means in code. Package, glob
// and hub hashes are stored: a plan recomputes them at the head and compares.
import { canonicalJson } from '../canonical-json.ts';
import type { TreeIndex } from '../git/diff.ts';
import { Graph } from '../graph/graph.ts';
import { MapError, mapIndex } from '../graph/map.ts';
import { ENGINE, fileHash, listingHash, MAP_VERSION, sha256, type MapLockfile, type TrommelMap } from '../graph/static.ts';
import { ByteReader, ByteWriter, compareStrings, FrontReader, FrontWriter, SmapEncodeError } from './bytes.ts';
import { decodeContainer, encodeContainer, layerAddress, SNAPSHOT_LAYER, STATIC_LAYER, type Section } from './container.ts';

/** The sections of format 0, in the order a file holds them. All are required, at version 0. */
const SECTIONS = [
  ['SNAP', SNAPSHOT_LAYER],
  ['META', STATIC_LAYER],
  ['KEYS', STATIC_LAYER],
  ['EDGE', STATIC_LAYER],
  ['HASH', STATIC_LAYER],
  ['GLOB', STATIC_LAYER],
  ['TEST', STATIC_LAYER],
  ['UNCT', STATIC_LAYER],
] as const;
type Tag = (typeof SECTIONS)[number][0];
const SECTION_VERSION = 0;

const MODE = /^[0-7]{6}$/;
const MODE_LIMIT = 0o1000000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_BYTES = 32;
const OID_BYTES = { sha1: 20, sha256: 32 } as const;
const LOCKFILE_NONE = 0;
const LOCKFILE_NPM = 1;
const LOCKFILE_UNPARSEABLE = 2;
const HASH_ABSENT = 0;
const HASH_SHA256 = 1;
const HASH_STRING = 2;

export interface Smap {
  readonly map: TrommelMap;
  /** The map's graph, built from the adjacency section directly; equal to `mapGraph(map)`. */
  readonly graph: Graph;
  /** The content address of each layer, as hex. */
  readonly layers: { readonly snapshot: string; readonly static: string };
}

/** The text before a key's first colon: `f`, `d`, `g`, `p`, `r`, `c`, `u`. Null when there is none. */
function kindOf(key: string): string | null {
  const colon = key.indexOf(':');
  return colon < 1 ? null : key.slice(0, colon);
}

/** Kinds whose hash follows from the snapshot or from the node's causes, so the file omits it. */
function isDerived(kind: string): boolean {
  return kind === 'f' || kind === 'd' || kind === 'u';
}

function derivedHash(key: string, kind: string, index: TreeIndex, causes: Readonly<Record<string, readonly string[]>>): string | null {
  const path = key.slice(2);
  return kind === 'f' ? fileHash(index, path) : kind === 'd' ? listingHash(index, path) : sha256(canonicalJson(causes[key] ?? []));
}

function refuse(problem: string): never {
  throw new SmapEncodeError(`the map cannot be written as SMAP: ${problem}`);
}

export function encodeSmap(map: TrommelMap): Uint8Array {
  if (map.version !== MAP_VERSION) {
    refuse(`it has version ${map.version}, expected ${MAP_VERSION}`);
  }
  if (!Object.hasOwn(OID_BYTES, map.objectFormat)) {
    refuse(`its object format is ${JSON.stringify(map.objectFormat)}`);
  }
  const oid = OID_BYTES[map.objectFormat];
  const keys = Object.keys(map.nodes).sort(compareStrings);
  const ids = new Map(keys.map((key, id) => [key, id]));
  const kinds = keys.map((key) => kindOf(key) ?? refuse(`node ${JSON.stringify(key)} has no kind`));

  const snap = new ByteWriter();
  snap.hex(map.rootTree, oid);
  snap.varint(map.undecodable);
  snap.varint(map.snapshot.length);
  const paths = new FrontWriter();
  let before = '';
  for (const [mode, id, path] of map.snapshot) {
    if (!MODE.test(mode)) {
      refuse(`the snapshot gives ${path} the mode ${JSON.stringify(mode)}`);
    }
    if (!(path > before)) {
      refuse(`the snapshot is not sorted by path at ${JSON.stringify(path)}`);
    }
    before = path;
    snap.varint(Number.parseInt(mode, 8));
    snap.hex(id, oid);
    paths.write(snap, path);
  }

  const meta = new ByteWriter();
  meta.hex(map.rootTree, oid);
  if (map.config === null) {
    meta.u8(0);
  } else {
    meta.u8(1);
    meta.hex(map.config, oid);
  }
  writeLockfile(meta, map.lockfile);

  const keyTable = new ByteWriter();
  keyTable.varint(keys.length);
  const front = new FrontWriter();
  for (const key of keys) {
    front.write(keyTable, key);
  }

  for (const from of Object.keys(map.edges)) {
    if (!ids.has(from)) {
      refuse(`edges start at ${from}, which is not a node`);
    }
  }
  const adjacency = keys.map((from) => {
    const out = map.edges[from];
    if (out === undefined) {
      return [];
    }
    const targets = Object.entries(out).map(([to, provenance]): [number, number] => {
      const id = ids.get(to) ?? refuse(`an edge from ${from} ends at ${to}, which is not a node`);
      if (!Number.isInteger(provenance) || provenance < 1 || provenance > 7) {
        refuse(`the edge ${from} -> ${to} has provenance ${JSON.stringify(provenance)}`);
      }
      return [id, provenance];
    });
    if (targets.length === 0) {
      refuse(`${from} has an empty edge list`);
    }
    return targets.sort(([a], [b]) => a - b);
  });
  const edge = new ByteWriter();
  edge.varint(adjacency.reduce((sum, targets) => sum + targets.length, 0));
  for (const targets of adjacency) {
    edge.varint(targets.length);
    let previous = 0;
    targets.forEach(([target], i) => {
      edge.varint(i === 0 ? target : target - previous);
      previous = target;
    });
  }
  for (const targets of adjacency) {
    for (const [, provenance] of targets) {
      edge.u8(provenance);
    }
  }

  for (const key of Object.keys(map.uncertain)) {
    if (!key.startsWith('u:') || !ids.has(key)) {
      refuse(`causes are listed for ${key}, which is not a u: node`);
    }
  }
  for (const key of Object.keys(map.globs)) {
    if (!key.startsWith('g:') || !ids.has(key)) {
      refuse(`patterns are listed for ${key}, which is not a g: node`);
    }
  }
  const index = mapIndex(map);
  const hash = new ByteWriter();
  const glob = new ByteWriter();
  const unct = new ByteWriter();
  keys.forEach((key, id) => {
    const kind = kinds[id]!;
    const value = map.nodes[key];
    if (value !== null && typeof value !== 'string') {
      refuse(`node ${key} has a hash that is neither a string nor null`);
    }
    if (kind === 'u') {
      const causes = map.uncertain[key] ?? refuse(`node ${key} has no causes`);
      unct.varint(causes.length);
      for (const cause of causes) {
        unct.str(cause);
      }
    }
    if (kind === 'g') {
      const patterns = map.globs[key];
      glob.u8(patterns === undefined ? 0 : 1);
      if (patterns !== undefined) {
        glob.varint(patterns.length);
        for (const pattern of patterns) {
          glob.str(pattern);
        }
      }
    }
    if (isDerived(kind)) {
      const derived = derivedHash(key, kind, index, map.uncertain);
      if (value !== derived) {
        refuse(`node ${key} has the hash ${JSON.stringify(value)}, but ${kind === 'u' ? 'its causes give' : 'the snapshot gives'} ${JSON.stringify(derived)}`);
      }
    } else if (value === null) {
      hash.u8(HASH_ABSENT);
    } else if (SHA256_HEX.test(value)) {
      hash.u8(HASH_SHA256);
      hash.hex(value, SHA256_BYTES);
    } else {
      hash.u8(HASH_STRING);
      hash.str(value);
    }
  });

  const test = new ByteWriter();
  test.varint(map.tests.length);
  let last = -1;
  let lastTest = '';
  map.tests.forEach((path, i) => {
    const id = ids.get(`f:${path}`) ?? refuse(`test ${JSON.stringify(path)} is not a node`);
    if (i > 0 && !(path > lastTest)) {
      refuse(`its tests are not sorted and unique at ${JSON.stringify(path)}`);
    }
    test.varint(i === 0 ? id : id - last);
    last = id;
    lastTest = path;
  });

  const bodies: Readonly<Record<Tag, ByteWriter>> = { SNAP: snap, META: meta, KEYS: keyTable, EDGE: edge, HASH: hash, GLOB: glob, TEST: test, UNCT: unct };
  return encodeContainer({
    hash: map.objectFormat,
    engine: map.engine,
    sections: SECTIONS.map(([tag, layer]): Section => ({ tag, layer, required: true, version: SECTION_VERSION, body: bodies[tag].finish() })),
  });
}

function writeLockfile(out: ByteWriter, lockfile: MapLockfile): void {
  if (lockfile.kind === 'none') {
    out.u8(LOCKFILE_NONE);
  } else if (lockfile.kind === 'npm') {
    out.u8(LOCKFILE_NPM);
    out.str(lockfile.path);
  } else if ((lockfile as { kind: string }).kind === 'unparseable') {
    out.u8(LOCKFILE_UNPARSEABLE);
    out.str(lockfile.reason);
    out.varint(lockfile.paths.length);
    for (const path of lockfile.paths) {
      out.str(path);
    }
  } else {
    refuse(`its lockfile state is ${JSON.stringify(lockfile)}`);
  }
}

/**
 * Reads a SMAP file. Anything wrong is a MapError whose message reads as the reason after "the
 * map is invalid:"; that includes a map built by another engine, which is not safe to plan from.
 */
export function decodeSmap(bytes: Uint8Array, engine: string = ENGINE): Smap {
  const container = decodeContainer(bytes);
  if (container.engine !== engine) {
    throw new MapError(`the map was built by engine ${JSON.stringify(container.engine)}, expected ${engine}`);
  }
  const bodies = knownSections(container.sections);
  const oid = OID_BYTES[container.hash];

  const snap = new ByteReader(bodies.SNAP, 'section SNAP');
  const rootTree = snap.hex(oid);
  const undecodable = snap.varint();
  const entries = snap.count(oid + 3);
  const snapshot: [string, string, string][] = [];
  const paths = new FrontReader();
  let before = '';
  for (let i = 0; i < entries; i++) {
    const mode = snap.varint();
    if (mode >= MODE_LIMIT) {
      snap.fail(`a mode of ${mode.toString(8)} is past six octal digits`);
    }
    const id = snap.hex(oid);
    const path = paths.read(snap);
    if (!(path > before)) {
      snap.fail(`its paths are out of order at ${JSON.stringify(path)}`);
    }
    before = path;
    snapshot.push([mode.toString(8).padStart(6, '0'), id, path]);
  }
  snap.end();

  const meta = new ByteReader(bodies.META, 'section META');
  if (meta.hex(oid) !== rootTree) {
    meta.fail('its graph was derived from a tree that is not the snapshot');
  }
  const configFlag = meta.u8();
  if (configFlag > 1) {
    meta.fail(`a config flag of ${configFlag}`);
  }
  const config = configFlag === 1 ? meta.hex(oid) : null;
  const lockfile = readLockfile(meta);
  meta.end();

  const keyTable = new ByteReader(bodies.KEYS, 'section KEYS');
  const n = keyTable.count(2);
  const keys: string[] = [];
  const kinds: string[] = [];
  const front = new FrontReader();
  before = '';
  for (let id = 0; id < n; id++) {
    const key = front.read(keyTable);
    if (!(key > before)) {
      keyTable.fail(`its keys are out of order at ${JSON.stringify(key)}`);
    }
    before = key;
    keys.push(key);
    kinds.push(kindOf(key) ?? keyTable.fail(`the key ${JSON.stringify(key)} has no kind`));
  }
  keyTable.end();

  const edge = new ByteReader(bodies.EDGE, 'section EDGE');
  const total = edge.count(2);
  if (n > edge.remaining) {
    edge.fail(`${n} nodes do not fit the ${edge.remaining} bytes left`);
  }
  const offsets = new Uint32Array(n + 1);
  const targets = new Uint32Array(total);
  let e = 0;
  for (let from = 0; from < n; from++) {
    const degree = edge.varint();
    if (degree > total - e) {
      edge.fail(`its degrees add up to more than its edge total of ${total}`);
    }
    let previous = 0;
    for (let k = 0; k < degree; k++) {
      const step = edge.varint();
      if (k > 0 && step === 0) {
        edge.fail(`the targets of ${keys[from]!} do not ascend`);
      }
      const target = k === 0 ? step : previous + step;
      if (target >= n) {
        edge.fail(`an edge from ${keys[from]!} has the target ${target}, which is not a node`);
      }
      targets[e++] = target;
      previous = target;
    }
    offsets[from + 1] = e;
  }
  if (e !== total) {
    edge.fail(`its degrees add up to ${e}, not to its edge total of ${total}`);
  }
  // A copy: the graph must not alias the file, and a Buffer's own slice() would.
  const provenance = new Uint8Array(edge.bytes(total));
  for (const bits of provenance) {
    if (bits < 1 || bits > 7) {
      edge.fail(`an edge has the provenance ${bits}`);
    }
  }
  edge.end();

  const hash = new ByteReader(bodies.HASH, 'section HASH');
  const glob = new ByteReader(bodies.GLOB, 'section GLOB');
  const unct = new ByteReader(bodies.UNCT, 'section UNCT');
  const stored = new Map<string, string | null>();
  const globs: Record<string, string[]> = {};
  const uncertain: Record<string, string[]> = {};
  keys.forEach((key, id) => {
    const kind = kinds[id]!;
    if (kind === 'u') {
      uncertain[key] = Array.from({ length: unct.count(1) }, () => unct.str());
    }
    if (kind === 'g') {
      const flag = glob.u8();
      if (flag > 1) {
        glob.fail(`a pattern flag of ${flag}`);
      }
      if (flag === 1) {
        globs[key] = Array.from({ length: glob.count(1) }, () => glob.str());
      }
    }
    if (!isDerived(kind)) {
      const form = hash.u8();
      if (form === HASH_ABSENT) {
        stored.set(key, null);
      } else if (form === HASH_SHA256) {
        stored.set(key, hash.hex(SHA256_BYTES));
      } else if (form === HASH_STRING) {
        const value = hash.str();
        if (SHA256_HEX.test(value)) {
          hash.fail('a SHA-256 is written in the string form');
        }
        stored.set(key, value);
      } else {
        hash.fail(`a hash form of ${form}`);
      }
    }
  });
  hash.end();
  glob.end();
  unct.end();

  const test = new ByteReader(bodies.TEST, 'section TEST');
  const tests: string[] = [];
  let last = 0;
  const testCount = test.count(1);
  for (let i = 0; i < testCount; i++) {
    const step = test.varint();
    if (i > 0 && step === 0) {
      test.fail('its tests do not ascend');
    }
    const id = i === 0 ? step : last + step;
    const key = keys[id] ?? test.fail(`the test ${id} is not a node`);
    if (!key.startsWith('f:')) {
      test.fail(`the test ${key} is not an f: node`);
    }
    tests.push(key.slice(2));
    last = id;
  }
  test.end();

  const index = mapIndex({ rootTree, snapshot });
  const nodes: Record<string, string | null> = {};
  const edges: Record<string, Record<string, number>> = {};
  keys.forEach((key, id) => {
    const kind = kinds[id]!;
    nodes[key] = isDerived(kind) ? derivedHash(key, kind, index, uncertain) : stored.get(key)!;
    const start = offsets[id]!;
    const end = offsets[id + 1]!;
    if (end > start) {
      const out: Record<string, number> = {};
      for (let k = start; k < end; k++) {
        out[keys[targets[k]!]!] = provenance[k]!;
      }
      edges[key] = out;
    }
  });

  return {
    map: { version: MAP_VERSION, engine: container.engine, objectFormat: container.hash, rootTree, undecodable, config, lockfile, snapshot, nodes, edges, globs, tests, uncertain },
    graph: Graph.fromForward(keys, offsets, targets, provenance),
    layers: { snapshot: layerAddress(container, SNAPSHOT_LAYER), static: layerAddress(container, STATIC_LAYER) },
  };
}

function readLockfile(input: ByteReader): MapLockfile {
  const kind = input.u8();
  if (kind === LOCKFILE_NONE) {
    return { kind: 'none' };
  }
  if (kind === LOCKFILE_NPM) {
    return { kind: 'npm', path: input.str() };
  }
  if (kind === LOCKFILE_UNPARSEABLE) {
    const reason = input.str();
    return { kind: 'unparseable', paths: Array.from({ length: input.count(1) }, () => input.str()), reason };
  }
  return input.fail(`a lockfile kind of ${kind}`);
}

/**
 * The bodies of the sections this version reads. An optional section it does not know is skipped;
 * a required one, or a known one in a shape it does not expect, makes the map invalid.
 */
function knownSections(sections: readonly Section[]): Readonly<Record<Tag, Uint8Array>> {
  const found = new Map<Tag, Uint8Array>();
  let next = 0;
  for (const section of sections) {
    const position = SECTIONS.findIndex(([tag]) => tag === section.tag);
    if (position === -1 || section.version !== SECTION_VERSION) {
      if (!section.required) {
        continue;
      }
      throw new MapError(position === -1 ? `it has a required section ${section.tag} that this version does not know` : `its section ${section.tag} has version ${section.version}, expected ${SECTION_VERSION}`);
    }
    const [tag, layer] = SECTIONS[position]!;
    if (!section.required) {
      throw new MapError(`its section ${tag} is marked optional`);
    }
    if (section.layer !== layer) {
      throw new MapError(`its section ${tag} is in layer ${section.layer}, expected ${layer}`);
    }
    if (position < next) {
      throw new MapError(`its section ${tag} is out of order`);
    }
    next = position + 1;
    found.set(tag, section.body);
  }
  for (const [tag] of SECTIONS) {
    if (!found.has(tag)) {
      throw new MapError(`it has no section ${tag}`);
    }
  }
  return Object.fromEntries(found) as Record<Tag, Uint8Array>;
}
