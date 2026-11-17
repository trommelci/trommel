// The resolved model every pnpm and yarn reader produces, and the `p:` nodes, edges and lookup it
// stands for (spec 2026-11-15-pnpm-yarn-lockfiles §6). Each node's hash covers its outgoing edges
// (§6.3): a lookup hashes the reference it resolves to, an entry its content and the references
// of its dependencies and peers, and a name node every copy of its name, every declaration of it
// and every dependency on it. A planner that compares hashes then sees every edge that moved.

import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.ts';
import type { Lockfile } from './lockfile.ts';

/**
 * What a declared name resolves to. An entry's id is a key of `ResolvedModel.entries`: a reader
 * that cannot resolve a reference uses `unresolved`, which points at the name's name node (§6.5).
 */
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

/** pnpm's own document (§6.8): one node with no edges in or out. */
const ENV_KEY = 'p:pnpm:#env';
/** A name node's key is `<prefix><name>@*`; `@*` cannot occur in an id (§6.1). */
const ANY = '@*';
const NONE: readonly string[] = Object.freeze([]);
/** The root lookup `p:npm:node_modules/<name>`, which is also the builder's ⊥ node of case 3 (§6.4). */
const ROOT_LOOKUP = 'p:npm:node_modules/';

/**
 * Builds the lockfile a model stands for. Precondition: `modelProblem(model)` is null, so that no id
 * contains `@*` or is `#env` (they would collide with name nodes and the env node), no importer
 * directory is `.` or has a leading, trailing or doubled `/`, and every `entry` reference names a key of
 * `entries`. Readers own untrusted input and enforce it; this function does not check it.
 */
export function lockfileFromModel(kind: 'pnpm' | 'yarn-berry' | 'yarn-classic', path: string, model: ResolvedModel): Lockfile {
  return new ModelLockfile(kind, path, model);
}

/** A reason the model breaks lockfileFromModel's preconditions, or null. Every reader returns Unparseable with this reason when it is not null. */
export function modelProblem(model: ResolvedModel): string | null {
  for (const id of model.entries.keys()) {
    if (id.includes(ANY) || id === '#env') {
      return `the id ${JSON.stringify(id)} contains "@*" or is "#env"`;
    }
  }
  for (const dir of model.importers.keys()) {
    if (dir === '.' || dir.startsWith('/') || dir.endsWith('/') || dir.includes('//')) {
      return `the importer directory ${JSON.stringify(dir)} is not a normalised relative directory`;
    }
  }
  for (const [dir, declared] of model.importers) {
    for (const [name, ref] of declared) {
      if (ref.kind === 'entry' && !model.entries.has(ref.id)) {
        return `${JSON.stringify(name)} in importer ${JSON.stringify(dir)} names ${JSON.stringify(ref.id)}, which is not an entry`;
      }
    }
  }
  for (const [id, entry] of model.entries) {
    for (const [name, ref] of entry.dependencies) {
      if (ref.kind === 'entry' && !model.entries.has(ref.id)) {
        return `${JSON.stringify(name)} in ${JSON.stringify(id)} names ${JSON.stringify(ref.id)}, which is not an entry`;
      }
    }
  }
  return null;
}

/** `@scope/x@…` → `@scope/x`; `x@…` → `x`. Works for pnpm ids, Berry resolutions and classic ids. */
export function nameOfId(id: string): string {
  let at: number;
  if (id.startsWith('@')) {
    const slash = id.indexOf('/');
    at = slash < 0 ? -1 : id.indexOf('@', slash + 1);
  } else {
    at = id.indexOf('@');
  }
  return at < 0 ? id : id.slice(0, at);
}

/** The lookup location of `name` declared by the importer at `dir` (§6.1). */
export function lookupKey(dir: string, name: string): string {
  return dir === '' ? `p:npm:node_modules/${name}` : `p:npm:${dir}/node_modules/${name}`;
}

/** What a name node's hash is built from, gathered in one pass over the model. */
interface NameLists {
  /** The ids of the entries with this name. */
  readonly entries: string[];
  /** [importer directory, reference text] for each importer that declares the name. */
  readonly declared: [string, string][];
  /** [entry id, reference text] for each entry whose dependencies hold the name. */
  readonly dependents: [string, string][];
  /** The entry ids that declarations and dependents of the name resolve to. */
  readonly targets: string[];
}

interface NameNode {
  readonly hash: string | null;
  readonly edges: readonly string[];
}

class ModelLockfile implements Lockfile {
  readonly kind: 'pnpm' | 'yarn-berry' | 'yarn-classic';
  readonly path: string;
  readonly nodes: ReadonlyMap<string, string | null>;
  private readonly prefix: string;
  /** Importer directory → the names it declares. */
  private readonly declares = new Map<string, Set<string>>();
  /** The edges of every lookup, entry and #env. Name nodes are in `named`. */
  private readonly edges = new Map<string, readonly string[]>();
  private readonly lists = new Map<string, NameLists>();
  /** Name nodes computed so far, by name. */
  private readonly named = new Map<string, NameNode>();

  constructor(kind: 'pnpm' | 'yarn-berry' | 'yarn-classic', path: string, model: ResolvedModel) {
    this.kind = kind;
    this.path = path;
    this.prefix = kind === 'pnpm' ? 'p:pnpm:' : 'p:yarn:';
    const hashes = new Map<string, string | null>();
    /** Names whose name node an unresolved reference or a peer points at. */
    const pointed = new Set<string>();

    for (const [dir, declared] of model.importers) {
      this.declares.set(dir, new Set(declared.keys()));
      for (const [name, ref] of declared) {
        const text = referenceText(name, ref);
        const key = lookupKey(dir, name);
        hashes.set(key, text);
        this.edges.set(key, this.targets(name, ref));
        const lists = this.listsOf(name);
        lists.declared.push([dir, text]);
        if (ref.kind === 'entry') {
          lists.targets.push(ref.id);
        } else if (ref.kind === 'unresolved') {
          pointed.add(name);
        }
      }
    }

    for (const [id, entry] of model.entries) {
      this.listsOf(entry.name).entries.push(id);
      const dependencies: [string, string][] = [];
      const out = new Set<string>();
      for (const [name, ref] of entry.dependencies) {
        const text = referenceText(name, ref);
        dependencies.push([name, text]);
        for (const target of this.targets(name, ref)) {
          out.add(target);
        }
        const lists = this.listsOf(name);
        lists.dependents.push([id, text]);
        if (ref.kind === 'entry') {
          lists.targets.push(ref.id);
        } else if (ref.kind === 'unresolved') {
          pointed.add(name);
        }
      }
      const peers = [...new Set(entry.peers)].sort(compareStrings);
      for (const peer of peers) {
        out.add(this.nameKey(peer));
        pointed.add(peer);
      }
      const key = this.prefix + id;
      // Object.fromEntries defines own properties, so a dependency named __proto__ is hashed like any other.
      hashes.set(key, sha256(canonicalJson({ content: entry.content, dependencies: Object.fromEntries(dependencies), peers })));
      this.edges.set(key, sortedUnique(out));
    }

    if (model.env !== null) {
      hashes.set(ENV_KEY, sha256(canonicalJson(model.env)));
      this.edges.set(ENV_KEY, NONE);
    }

    // Every list is complete now, so a name node computed from here on is final.
    for (const name of pointed) {
      hashes.set(this.nameKey(name), this.nameNode(name).hash);
    }
    this.nodes = new Map([...hashes].sort(([a], [b]) => compareStrings(a, b)));
  }

  hash(key: string): string | null | undefined {
    const known = this.nodes.get(key);
    if (known !== undefined) {
      return known;
    }
    const name = this.nameOfKey(key) ?? this.nameOfUnknownLookup(key);
    return name === null ? undefined : this.nameNode(name).hash;
  }

  dependencies(key: string): readonly string[] {
    const edges = this.edges.get(key);
    if (edges !== undefined) {
      return edges;
    }
    const name = this.nameOfKey(key) ?? this.nameOfUnknownLookup(key);
    return name === null ? NONE : this.nameNode(name).edges;
  }

  locate(name: string, dir: string): string | null {
    const own = this.ownImporter(dir);
    // Case 1: the file's own importer declares the name. Its ancestors' declarations do not
    // decide for it, since a hoisted install can put another copy in between (§6.4).
    if (own !== null && this.declares.get(own)!.has(name)) {
      return lookupKey(own, name);
    }
    // Case 2: the lockfile knows the name, through a declaration or an entry of that name.
    if (this.knows(name)) {
      return this.nameKey(name);
    }
    // Case 3: the builder's ⊥ node for a name the lockfile does not know.
    return null;
  }

  /** Whether a declaration or an entry has this name: what locate calls knowing it. */
  private knows(name: string): boolean {
    const lists = this.lists.get(name);
    return lists !== undefined && (lists.declared.length > 0 || lists.entries.length > 0);
  }

  /**
   * The name of a root lookup that is not a node, when this lockfile knows that name, or null. Such a
   * key is case 3's ⊥ node, built when an earlier lockfile did not know the name. It stands for the
   * name node here, so a planner sees the import's target change once the name is known (§6.4).
   */
  private nameOfUnknownLookup(key: string): string | null {
    if (!key.startsWith(ROOT_LOOKUP)) {
      return null;
    }
    const name = key.slice(ROOT_LOOKUP.length);
    return this.knows(name) ? name : null;
  }

  /** The deepest importer whose directory is `dir` or contains it on a `/` boundary. */
  private ownImporter(dir: string): string | null {
    let candidate = dir;
    for (;;) {
      if (this.declares.has(candidate)) {
        return candidate;
      }
      if (candidate === '') {
        return null;
      }
      const slash = candidate.lastIndexOf('/');
      candidate = slash < 0 ? '' : candidate.slice(0, slash);
    }
  }

  /** The key a reference has an edge to: the entry, the name node, or none for a link. */
  private targets(name: string, ref: Ref): readonly string[] {
    switch (ref.kind) {
      case 'entry':
        return Object.freeze([this.prefix + ref.id]);
      case 'link':
        return NONE;
      case 'unresolved':
        return Object.freeze([this.nameKey(name)]);
    }
  }

  private nameKey(name: string): string {
    return this.prefix + name + ANY;
  }

  /** The name of a name-node key of this lockfile's prefix, or null. */
  private nameOfKey(key: string): string | null {
    if (key.length <= this.prefix.length + ANY.length || !key.startsWith(this.prefix) || !key.endsWith(ANY)) {
      return null;
    }
    return key.slice(this.prefix.length, -ANY.length);
  }

  private listsOf(name: string): NameLists {
    let lists = this.lists.get(name);
    if (lists === undefined) {
      lists = { entries: [], declared: [], dependents: [], targets: [] };
      this.lists.set(name, lists);
    }
    return lists;
  }

  private nameNode(name: string): NameNode {
    let node = this.named.get(name);
    if (node === undefined) {
      node = this.computeNameNode(name);
      this.named.set(name, node);
    }
    return node;
  }

  private computeNameNode(name: string): NameNode {
    const lists = this.lists.get(name);
    if (lists === undefined || (lists.entries.length === 0 && lists.declared.length === 0 && lists.dependents.length === 0)) {
      return { hash: null, edges: NONE };
    }
    const entries = [...lists.entries].sort(compareStrings);
    const declared = [...lists.declared].sort(comparePairs);
    const dependents = [...lists.dependents].sort(comparePairs);
    const edges = sortedUnique(new Set([...lists.entries, ...lists.targets].map((id) => this.prefix + id)));
    return { hash: sha256(canonicalJson({ entries, declared, dependents })), edges };
  }
}

/** An entry is its id, a link is `link:<dir>`, and an unresolved reference to `name` is `<name>@*`. */
function referenceText(name: string, ref: Ref): string {
  switch (ref.kind) {
    case 'entry':
      return ref.id;
    case 'link':
      return `link:${ref.dir}`;
    case 'unresolved':
      return name + ANY;
  }
}

function sortedUnique(keys: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...keys].sort(compareStrings));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function comparePairs(a: readonly [string, string], b: readonly [string, string]): number {
  return compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
