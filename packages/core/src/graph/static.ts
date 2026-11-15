// The static impact graph of one snapshot (architecture §3.1, §3.2), as the map a plan starts from.
// On disk it is a SMAP file (../smap/smap.ts, docs/smap-format.md); `trommel graph` prints the same
// map as canonical JSON. Every module file is lexed from its git blob,
// every import resolved, and everything a resolution recorded becomes an edge, so a test depends
// on every file, absent path, directory listing, glob, config and package that could change what
// it loads. What cannot be decided is not dropped: it becomes a `u:` node, always treated as changed
// (DECISIONS 23).
//
// The map is a function of the tree, the config and the engine only (ADR-0003, DECISIONS 28). It
// holds nothing about the machine that built it, so one tree gives the same bytes on every OS and
// Node version; test/graph/golden.test.ts pins that.
//
// Probes shared by every importer of a path or a directory live in resolution hubs (ADR-0003,
// DECISIONS 32). A hub node `r:<path>` or `c:<dir>` links to the files and configs that exist, and
// its hash covers which of its candidates exist, so an absent candidate is no node at all. A plan
// recomputes the hub at the head to compare it.
import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.ts';
import type { TreeIndex } from '../git/diff.ts';
import type { ObjectFormat } from '../git/git.ts';
import { dialectOf, lexImportsFromBytes, type ImportRecord } from '../lex/ts.ts';
import type { Lockfile, LockfileKind } from '../lockfile/lockfile.ts';
import { lockfileFromModel, type ResolvedModel } from '../lockfile/model.ts';
import { detectLockfile, LOCKFILE_PATHS, npmLockfile, parseNpmLockfile, type Unparseable } from '../lockfile/npm.ts';
import { parsePnpmLockfile } from '../lockfile/pnpm.ts';
import { parseYarnBerryLockfile } from '../lockfile/yarn-berry.ts';
import { parseYarnClassicLockfile, type ClassicWorkspace } from '../lockfile/yarn-classic.ts';
import { matchGlobs } from '../resolve/glob.ts';
import { dirname, Resolver, type Hub, type Resolution, type Vfs } from '../resolve/resolver.ts';
import { DECLARED, STATIC } from './graph.ts';

/** The version of this in-memory model and of its canonical JSON. The file format has its own number (../smap/container.ts). */
export const MAP_VERSION = 1;
/**
 * What builds the graph and how a plan reads it; a map built by another engine is invalid (L3).
 * `trommel-static-2` has no `e:` nodes: a plan no longer compares the environment (DECISIONS 28).
 * `trommel-static-3` has resolution hubs, whose hashes a plan recomputes (DECISIONS 32).
 * `trommel-static-4` reads pnpm and yarn lockfiles, whose maps have new `p:` nodes (DECISIONS 36).
 */
export const ENGINE = 'trommel-static-4';

const MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** `.d.ts`, `.d.mts`, `.d.cts` and arbitrary-extension declarations such as `.d.css.ts`. */
const DECLARATION = /\.d\.(?:[^/]*\.)?[cm]?ts$/;

/** A JavaScript or TypeScript module, declaration files included. Every one is a graph node. */
export function isModule(path: string): boolean {
  return MODULE.test(path);
}

/** A module that runs, so its imports are edges. Declaration files never run (DECISIONS 23). */
export function isLexed(path: string): boolean {
  return MODULE.test(path) && !DECLARATION.test(path);
}

export type LockfileState =
  | { readonly kind: 'parsed'; readonly lockfile: Lockfile }
  | { readonly kind: 'unparseable'; readonly paths: readonly string[]; readonly reason: string }
  | { readonly kind: 'none' };

/**
 * The root lockfile of a snapshot, behind the `Lockfile` interface when it can be read (spec
 * 2026-11-15-pnpm-yarn-lockfiles §8.2), else every lockfile present and why not.
 */
export function readLockfile(vfs: Vfs): LockfileState {
  const present = LOCKFILE_PATHS.filter((path) => vfs.kind(path) === 'file' || vfs.kind(path) === 'symlink').sort(compareStrings);
  const detected = detectLockfile(new Set(present));
  if (detected.kind === 'none') {
    return { kind: 'none' };
  }
  if (detected.kind === 'unparseable') {
    return { kind: 'unparseable', paths: present, reason: detected.reason };
  }
  const { path } = detected;
  const text = vfs.read(path) ?? '';
  const read = (kind: 'pnpm' | 'yarn-berry' | 'yarn-classic', model: ResolvedModel | Unparseable): LockfileState =>
    'kind' in model ? { kind: 'unparseable', paths: present, reason: model.reason } : { kind: 'parsed', lockfile: lockfileFromModel(kind, path, model) };
  switch (detected.kind) {
    case 'npm': {
      const parsed = parseNpmLockfile(text);
      return parsed.kind === 'npm' ? { kind: 'parsed', lockfile: npmLockfile(parsed, path) } : { kind: 'unparseable', paths: present, reason: parsed.reason };
    }
    case 'pnpm':
      return read('pnpm', parsePnpmLockfile(text));
    case 'yarn': {
      if (!text.includes(CLASSIC_HEADER)) {
        return read('yarn-berry', parseYarnBerryLockfile(text));
      }
      const workspace = classicWorkspace(vfs);
      return typeof workspace === 'string' ? { kind: 'unparseable', paths: present, reason: workspace } : read('yarn-classic', parseYarnClassicLockfile(text, workspace));
    }
  }
}

/** The line classic yarn writes at the top of its lockfile; a yarn.lock without it is Berry's. */
const CLASSIC_HEADER = '# yarn lockfile v1';
const DECLARATION_FIELDS: readonly string[] = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * What classic yarn's lockfile does not say (spec §6.4): the root and every workspace member as
 * importers, each with the names its own package.json declares, and the workspace packages by name.
 * A package.json that cannot be read is the reason the lockfile is unparseable: its declarations
 * decide what a file loads, and nothing is guessed.
 */
function classicWorkspace(vfs: Vfs): ClassicWorkspace | string {
  const workspaces = new Resolver(vfs).workspaces();
  const importers = new Map<string, ReadonlyMap<string, string>>();
  for (const dir of ['', ...workspaces.members]) {
    if (importers.has(dir)) {
      continue;
    }
    const path = dir === '' ? 'package.json' : `${dir}/package.json`;
    const declared = declarations(vfs.read(path));
    if (declared === null) {
      return `${path} cannot be read`;
    }
    importers.set(dir, declared);
  }
  return { importers, packages: workspaces.byName };
}

/** The string-valued entries of a package.json's three dependency fields, a later field winning; null if it cannot be read. */
function declarations(text: string | null): Map<string, string> | null {
  let json: unknown;
  try {
    json = JSON.parse(text ?? '');
  } catch {
    return null;
  }
  if (!isRecord(json)) {
    return null;
  }
  const declared = new Map<string, string>();
  for (const field of DECLARATION_FIELDS) {
    const value = json[field];
    if (value === undefined) {
      continue;
    }
    if (!isRecord(value)) {
      return null;
    }
    for (const [name, range] of Object.entries(value)) {
      if (typeof range === 'string') {
        declared.set(name, range);
      }
    }
  }
  return declared;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type MapLockfile =
  | { readonly kind: LockfileKind; readonly path: string }
  | { readonly kind: 'unparseable'; readonly paths: readonly string[]; readonly reason: string }
  | { readonly kind: 'none' };

export interface TrommelMap {
  readonly version: number;
  readonly engine: string;
  readonly objectFormat: ObjectFormat;
  readonly rootTree: string;
  /** Paths that are not valid UTF-8; non-zero makes every plan from this map run everything. */
  readonly undecodable: number;
  /** The blob id of trommel.config.json, or null without one. */
  readonly config: string | null;
  readonly lockfile: MapLockfile;
  /** Every `ls-tree -r -t` entry as [mode, oid, path], sorted by path: the base of the next diff. */
  readonly snapshot: readonly (readonly [string, string, string])[];
  /** Node key → hash; null is ⊥, a path or package that does not exist. */
  readonly nodes: Readonly<Record<string, string | null>>;
  /** Adjacency: dependent → { dependency → provenance bits }. */
  readonly edges: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The patterns behind each pattern-based g: node; `g:workspaces` is recomputed by the resolver. */
  readonly globs: Readonly<Record<string, readonly string[]>>;
  readonly tests: readonly string[];
  /** `u:` node → why the file is uncertain. */
  readonly uncertain: Readonly<Record<string, readonly string[]>>;
}

export interface DeclaredRule {
  readonly match: string;
  readonly affects: string;
}

export interface StaticInput {
  readonly objectFormat: ObjectFormat;
  readonly index: TreeIndex;
  /** The same snapshot as `index`, for the resolver. */
  readonly vfs: Vfs;
  /** Blob bytes of every file `isLexed` accepts. */
  readonly sources: ReadonlyMap<string, Uint8Array>;
  readonly tests: readonly string[];
  /** `inputs.global` patterns: every test depends on what they match. */
  readonly global?: readonly string[];
  readonly declared?: readonly DeclaredRule[];
  readonly config?: string | null;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The hash of an `f:` node: the blob id, prefixed by the mode unless it is a regular file. */
export function fileHash(index: TreeIndex, path: string): string | null {
  const entry = index.entry(path);
  if (entry === undefined || entry.type === 'tree') {
    return null;
  }
  return entry.mode === '100644' ? entry.oid : `${entry.mode}:${entry.oid}`;
}

/** The hash of a `d:` node: SHA-256 of the sorted names and kinds; null for a missing directory. */
export function listingHash(index: TreeIndex, dir: string): string | null {
  const listing = index.listing(dir);
  return listing === null ? null : sha256(canonicalJson(listing));
}

/** The hash of a `g:` node: SHA-256 of the sorted matches. */
export function globHash(matches: readonly string[]): string {
  return sha256(canonicalJson([...matches].sort(compareStrings)));
}

/**
 * The hash of an `r:` or `c:` hub: SHA-256 of what it recorded, each probed directory with its
 * listing. Which candidates exist is in it, and what an existing one holds is left to the hub's
 * edges, so editing a target or a config changes that file's node and not the hub.
 */
export function hubHash(index: TreeIndex, hub: Hub): string {
  return sha256(
    canonicalJson({
      absent: hub.absent,
      configs: hub.configs,
      dirs: hub.dirs.map((dir) => [dir, listingHash(index, dir)]),
      hubs: hub.hubs,
      reason: hub.reason ?? null,
      targets: hub.targets,
      uncertain: hub.uncertain === true,
    }),
  );
}

/** Whether `key` names a resolution hub. */
export function isHub(key: string): boolean {
  return key.startsWith('r:') || key.startsWith('c:');
}

/**
 * A hub that only found its own path as an existing file adds nothing that file's node does not
 * already hold: the file's hash changes whenever the path stops being exactly that file.
 */
function isExactFile(hub: Hub): boolean {
  return (
    hub.key.startsWith('r:') &&
    hub.targets.length === 1 &&
    hub.targets[0] === hub.key.slice(2) &&
    hub.absent.length === 0 &&
    hub.dirs.length === 0 &&
    hub.configs.length === 0 &&
    hub.hubs.length === 0 &&
    hub.reason === undefined &&
    hub.uncertain !== true
  );
}

class MapBuilder {
  readonly nodes = new Map<string, string | null>();
  readonly edges = new Map<string, Map<string, number>>();
  readonly globs = new Map<string, readonly string[]>();
  readonly causes = new Map<string, string[]>();
  /** The node each hub key links to: the hub, or the file of an exact one. */
  private readonly linked = new Map<string, string>();
  private readonly index: TreeIndex;
  private readonly resolver: Resolver;

  constructor(index: TreeIndex, resolver: Resolver) {
    this.index = index;
    this.resolver = resolver;
  }

  /** The node to link to for a hub, added with its edges the first time. */
  hub(key: string): string {
    const known = this.linked.get(key);
    if (known !== undefined) {
      return known;
    }
    const hub = this.resolver.hub(key);
    if (isExactFile(hub)) {
      const file = this.file(hub.targets[0]!);
      this.linked.set(key, file);
      return file;
    }
    this.linked.set(key, key); // before the sub-hubs, which may lead back here
    this.node(key, hubHash(this.index, hub));
    for (const path of [...hub.targets, ...hub.configs]) {
      this.edge(key, this.file(path), STATIC);
    }
    for (const sub of hub.hubs) {
      this.edge(key, this.hub(sub), STATIC);
    }
    return key;
  }

  node(key: string, hash: string | null): string {
    if (!this.nodes.has(key)) {
      this.nodes.set(key, hash);
    }
    return key;
  }

  file(path: string): string {
    return this.node(`f:${path}`, fileHash(this.index, path));
  }

  dir(path: string): string {
    return this.node(`d:${path}`, listingHash(this.index, path));
  }

  glob(key: string, matches: readonly string[], patterns?: readonly string[]): string {
    if (patterns !== undefined) {
      this.globs.set(key, patterns);
    }
    return this.node(key, globHash(matches));
  }

  edge(from: string, to: string, provenance: number): void {
    let out = this.edges.get(from);
    if (out === undefined) {
      out = new Map();
      this.edges.set(from, out);
    }
    out.set(to, (out.get(to) ?? 0) | provenance);
  }

  uncertain(path: string, cause: string): void {
    const list = this.causes.get(path) ?? [];
    list.push(cause);
    this.causes.set(path, list);
  }
}

export function buildStaticMap(input: StaticInput): TrommelMap {
  const { index, vfs } = input;
  const resolver = new Resolver(vfs);
  const lockfile = readLockfile(vfs);
  const b = new MapBuilder(index, resolver);
  const files = vfs.files();

  // The lockfile's nodes and their edges, whatever its format (spec 2026-11-15-pnpm-yarn-lockfiles
  // §8.2). Hashed nodes first, then the ⊥ nodes, so a missing dependency can never shadow an
  // installed one.
  if (lockfile.kind === 'parsed') {
    const { nodes } = lockfile.lockfile;
    for (const [key, hash] of nodes) {
      if (hash !== null) {
        b.node(key, hash);
      }
    }
    for (const [key, hash] of nodes) {
      if (hash === null) {
        b.node(key, null);
      }
    }
    for (const key of nodes.keys()) {
      for (const dependency of lockfile.lockfile.dependencies(key)) {
        b.edge(key, dependency, STATIC);
      }
    }
  }

  for (const path of files) {
    if (isModule(path)) {
      b.file(path);
    }
  }
  for (const path of files) {
    if (!isLexed(path)) {
      continue;
    }
    const bytes = input.sources.get(path);
    if (bytes === undefined) {
      throw new Error(`static graph: no source bytes for ${path}`);
    }
    const from = b.file(path);
    b.edge(from, b.hub(`c:${dirname(path)}`), STATIC); // the file's own configs
    const lexed = lexImportsFromBytes(bytes, dialectOf(path));
    for (const diagnostic of lexed.diagnostics) {
      b.uncertain(path, `line ${diagnostic.line}: lexer ${diagnostic.code}`);
    }
    for (const record of lexed.imports) {
      if (record.typeOnly === true) {
        continue; // `import type` and `export type` are erased in every configuration
      }
      const resolution = resolver.resolve({
        from: path,
        specifier: record.specifier,
        kind: record.kind,
        patterns: record.patterns ?? null,
        ...(record.base === undefined ? {} : { base: record.base }),
      });
      addResolution(b, from, path, record, resolution, lockfile);
    }
  }

  const globalKey = input.global !== undefined && input.global.length > 0 ? b.glob('g:inputs.global', matchGlobs(files, input.global), input.global) : null;
  if (globalKey !== null) {
    for (const match of matchGlobs(files, input.global!)) {
      b.edge(globalKey, b.file(match), DECLARED);
    }
  }
  const declared = (input.declared ?? []).map((rule) => {
    const matches = matchGlobs(files, [rule.match]);
    const key = b.glob(`g:declared:${rule.match}`, matches, [rule.match]);
    for (const match of matches) {
      b.edge(key, b.file(match), DECLARED);
    }
    return { key, affects: rule.affects };
  });
  const tests = [...new Set(input.tests)].sort(compareStrings);
  for (const test of tests) {
    const from = b.file(test);
    if (globalKey !== null) {
      b.edge(from, globalKey, DECLARED);
    }
    for (const rule of declared) {
      if (matchGlobs([test], [rule.affects]).length > 0) {
        b.edge(from, rule.key, DECLARED);
      }
    }
  }

  const uncertain: Record<string, string[]> = {};
  for (const [path, causes] of b.causes) {
    const key = b.node(`u:${path}`, sha256(canonicalJson(causes)));
    b.edge(`f:${path}`, key, STATIC);
    uncertain[key] = causes;
  }

  return {
    version: MAP_VERSION,
    engine: ENGINE,
    objectFormat: input.objectFormat,
    rootTree: index.rootOid,
    undecodable: index.undecodable,
    config: input.config ?? null,
    lockfile: lockfile.kind === 'parsed' ? { kind: lockfile.lockfile.kind, path: lockfile.lockfile.path } : lockfile,
    snapshot: index.entries().map((entry) => [entry.mode, entry.oid, entry.path] as const),
    nodes: Object.fromEntries(b.nodes),
    edges: Object.fromEntries([...b.edges].map(([from, out]) => [from, Object.fromEntries(out)])),
    globs: Object.fromEntries(b.globs),
    tests,
    uncertain,
  };
}

function addResolution(b: MapBuilder, from: string, path: string, record: ImportRecord, resolution: Resolution, lockfile: LockfileState): void {
  for (const key of resolution.hubs) {
    b.edge(from, b.hub(key), STATIC);
  }
  const { direct } = resolution;
  for (const file of [...direct.targets, ...direct.absent, ...direct.configs]) {
    b.edge(from, b.file(file), STATIC);
  }
  for (const dir of direct.dirs) {
    b.edge(from, b.dir(dir), STATIC);
  }
  for (const glob of resolution.globs) {
    const key = glob.patterns === undefined ? `g:${glob.key}` : `g:glob:${glob.key}`;
    b.edge(from, b.glob(key, glob.matches, glob.patterns), STATIC);
  }

  const label = record.specifier ?? `a ${record.kind} import with a non-literal specifier`;
  const where = `line ${record.line}`;
  if (resolution.kind === 'unresolved') {
    b.uncertain(path, `${where}: ${label} is unresolved (${resolution.reason ?? 'unknown'})`);
  } else if (resolution.uncertain === true) {
    b.uncertain(path, `${where}: ${label} depends on a config that cannot be read`);
  }
  const name = resolution.packageName;
  if (name === undefined) {
    return;
  }
  // A bare specifier may load from node_modules even when tsconfig paths also found a file.
  const onlyPackage = resolution.kind === 'external';
  if (lockfile.kind === 'parsed') {
    const lock = lockfile.lockfile;
    const key = lock.locate(name, dirname(path));
    if (key !== null) {
      // A key the map does not have yet is a name node (spec §6.4, case 2), which the lockfile gives
      // on demand. Its edges go to entries, and every entry is in the map already.
      if (!b.nodes.has(key)) {
        b.node(key, lock.hash(key) ?? null);
        for (const dependency of lock.dependencies(key)) {
          b.edge(key, dependency, STATIC);
        }
      }
      b.edge(from, key, STATIC);
      return;
    }
    b.edge(from, b.node(`p:npm:node_modules/${name}`, null), STATIC);
    if (onlyPackage) {
      b.uncertain(path, `${where}: ${name} is not in ${lockfile.lockfile.path}`);
    }
  } else if (lockfile.kind === 'unparseable') {
    for (const lock of lockfile.paths) {
      b.edge(from, b.file(lock), STATIC);
    }
  } else if (onlyPackage) {
    b.uncertain(path, `${where}: ${name}: there is no lockfile`);
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
