// Test helper for the lockfile soundness property (spec 2026-11-15-pnpm-yarn-lockfiles §9.2,
// DECISIONS 36): a random package universe and workspace, installed in one of four layouts, written
// out as the repository files the builder reads, and an oracle that walks the placed install.
//
// - The universe is the names a to e at 1.0.0 and 2.0.0. Each version depends on up to two
//   name-and-version pairs and, in Berry only, has at most one peer (classic yarn records no peers,
//   §6.7, and pnpm writes a resolved peer into the snapshot as a dependency, so it is one here).
// - The importers are '', pkgs/p and pkgs/q; the tests are x.test.ts in each, importing 1 to 3 names.
// - Layouts: pnpm's isolated one (every importer and every package sees exactly what it declares,
//   through symlinks into node_modules/.pnpm); a hoisted node_modules for classic yarn and Berry's
//   node-modules linker, placed by `hoist`, which keeps a provided peer visible as Yarn does; and
//   Plug'n'Play, which places nothing.
// - H is S after one or two edits: a bumped, added or removed declaration, a re-pointed dependency,
//   a second version of a name that some entry starts to use, or a re-published tarball.
//
// The oracle shares no code with the readers, the model or `locate`, so it can catch a wrong lookup.
// It follows Node's search path (or Plug'n'Play's declarations) from the test, by name, and lists
// every package it loads as `pkg <id> <content>` and every name it cannot find as `missing <name>`.
// `loadsWithoutUnmetPeers` is the same walk without the unmet peers Node finds by position, for the
// second residual case of spec §6.4 (ruling R9).
import fc from 'fast-check';

export type Layout = 'pnpm' | 'berry-node-modules' | 'berry-pnp' | 'classic';

const NAMES: readonly string[] = ['a', 'b', 'c', 'd', 'e'];
const VERSIONS: readonly string[] = ['1.0.0', '2.0.0'];
const IMPORTERS: readonly string[] = ['', 'pkgs/p', 'pkgs/q'];
export const TESTS: readonly string[] = ['x.test.ts', 'pkgs/p/x.test.ts', 'pkgs/q/x.test.ts'];

export interface Version {
  readonly name: string;
  readonly version: string;
  /** The integrity or checksum the lockfile records; a re-published tarball changes it. */
  readonly content: string;
  /** Dependency name → version, sorted by name. */
  readonly dependencies: ReadonlyMap<string, string>;
  /** Berry only: the name of its one peer dependency, which its parent is meant to provide and may not. */
  readonly peer: string | null;
}

export interface Install {
  /** `<name>@<version>` → that version, for all ten. */
  readonly universe: ReadonlyMap<string, Version>;
  /** Importer directory ('' for the root) → declared name → version. */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Test path → the names it imports. */
  readonly tests: ReadonlyMap<string, readonly string[]>;
  /** The ids the importers reach through dependencies, sorted: the lockfile's entries. */
  readonly used: readonly string[];
  /** Every real package directory → the id installed there. Plug'n'Play has none. */
  readonly copies: ReadonlyMap<string, string>;
  /** pnpm's symlinks: location → the real package directory it points at. */
  readonly links: ReadonlyMap<string, string>;
}

/** An install before it is placed: what the edits change. */
interface Spec {
  readonly universe: ReadonlyMap<string, Version>;
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly tests: ReadonlyMap<string, readonly string[]>;
}

const EDITS = ['bump', 'add', 'remove', 'repoint', 'second', 'content'] as const;
type EditKind = (typeof EDITS)[number];

interface Edit {
  readonly kind: EditKind;
  /** Picks one of the concrete edits of its kind, modulo their number. */
  readonly pick: number;
}

const isBerry = (layout: Layout): boolean => layout === 'berry-node-modules' || layout === 'berry-pnp';
const idOf = (name: string, version: string): string => `${name}@${version}`;
const nameOfId = (id: string): string => id.slice(0, id.indexOf('@'));
const other = (version: string): string => (version === VERSIONS[0] ? VERSIONS[1]! : VERSIONS[0]!);
const modulesOf = (dir: string): string => (dir === '' ? 'node_modules' : `${dir}/node_modules`);
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function sortedEntries<V>(map: ReadonlyMap<string, V>): [string, V][] {
  return [...map].sort(([a], [b]) => compareStrings(a, b));
}

function versionArb(name: string, version: string, berry: boolean): fc.Arbitrary<Version> {
  const others = NAMES.filter((candidate) => candidate !== name);
  return fc
    .record({
      dependencies: fc.uniqueArray(fc.tuple(fc.constantFrom(...others), fc.constantFrom(...VERSIONS)), { maxLength: 2, selector: ([dependency]) => dependency }),
      peer: berry ? fc.oneof({ weight: 2, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.constantFrom(...others) }) : fc.constant(null),
    })
    .map(({ dependencies, peer }) => ({
      name,
      version,
      content: `sha512-${name}-${version}`,
      dependencies: new Map([...dependencies].sort(([a], [b]) => compareStrings(a, b))),
      // A peer is a name the parent provides, never one the package depends on itself.
      peer: peer !== null && dependencies.some(([dependency]) => dependency === peer) ? null : peer,
    }));
}

function specArb(layout: Layout): fc.Arbitrary<Spec> {
  const universe = fc.tuple(...NAMES.flatMap((name) => VERSIONS.map((version) => versionArb(name, version, isBerry(layout)))));
  const declared = fc
    .tuple(...NAMES.map(() => fc.oneof({ weight: 3, arbitrary: fc.constant(null) }, { weight: 2, arbitrary: fc.constantFrom(...VERSIONS) })))
    .map((versions) => new Map(NAMES.flatMap((name, i) => (versions[i] === null || versions[i] === undefined ? [] : [[name, versions[i]] as const]))));
  const imports = fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 }).map((names) => [...names].sort(compareStrings));
  return fc
    .record({
      universe,
      importers: fc.tuple(...IMPORTERS.map(() => declared)),
      tests: fc.tuple(...TESTS.map(() => imports)),
    })
    .map(({ universe: versions, importers, tests }) => ({
      universe: new Map(versions.map((version) => [idOf(version.name, version.version), version])),
      importers: new Map(IMPORTERS.map((dir, i) => [dir, importers[i]!])),
      tests: new Map(TESTS.map((test, i) => [test, tests[i]!])),
    }));
}

const editArb: fc.Arbitrary<Edit> = fc.record({ kind: fc.constantFrom(...EDITS), pick: fc.nat({ max: 63 }) });

/**
 * S and H: H is S after one or two edits, both placed in `layout`. A pair that `hoist` cannot
 * install is not generated: a dependency cycle through two versions of one name, which nests
 * without end in any hoisted layout, or two packages that are each other's provided peer.
 */
export function installPairArb(layout: Layout): fc.Arbitrary<{ readonly s: Install; readonly h: Install }> {
  return fc
    .record({ spec: specArb(layout), edits: fc.array(editArb, { minLength: 1, maxLength: 2 }) })
    .map(({ spec, edits }) => ({ s: place(spec, layout), h: place(edits.reduce(applyEdit, spec), layout) }))
    .filter((pair): pair is { readonly s: Install; readonly h: Install } => pair.s !== null && pair.h !== null);
}

/** The ids the importers reach through dependencies, sorted. */
function usedIds(spec: Spec): string[] {
  const seen = new Set<string>();
  const queue = [...spec.importers.values()].flatMap((declared) => [...declared].map(([name, version]) => idOf(name, version)));
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (!seen.has(id)) {
      seen.add(id);
      for (const [name, version] of spec.universe.get(id)!.dependencies) {
        queue.push(idOf(name, version));
      }
    }
  }
  return [...seen].sort(compareStrings);
}

function withDeclarations(spec: Spec, dir: string, change: (declared: Map<string, string>) => void): Spec {
  const declared = new Map(spec.importers.get(dir));
  change(declared);
  return { ...spec, importers: new Map([...spec.importers].map(([key, value]) => [key, key === dir ? new Map(sortedEntries(declared)) : value])) };
}

function withVersion(spec: Spec, id: string, change: (version: Version) => Version): Spec {
  return { ...spec, universe: new Map([...spec.universe].map(([key, value]) => [key, key === id ? change(value) : value])) };
}

function withDependencies(version: Version, change: (dependencies: Map<string, string>) => void): Version {
  const dependencies = new Map(version.dependencies);
  change(dependencies);
  return { ...version, dependencies: new Map(sortedEntries(dependencies)), peer: version.peer !== null && dependencies.has(version.peer) ? null : version.peer };
}

/** Every concrete edit of one kind that applies to `spec`, in a fixed order. */
function candidates(spec: Spec, kind: EditKind): (() => Spec)[] {
  const declared = IMPORTERS.flatMap((dir) => [...spec.importers.get(dir)!.keys()].map((name) => [dir, name] as const));
  const used = usedIds(spec);
  switch (kind) {
    case 'bump':
      return declared.map(([dir, name]) => () => withDeclarations(spec, dir, (map) => map.set(name, other(map.get(name)!))));
    case 'add':
      return IMPORTERS.flatMap((dir) =>
        NAMES.filter((name) => !spec.importers.get(dir)!.has(name)).flatMap((name) => VERSIONS.map((version) => () => withDeclarations(spec, dir, (map) => map.set(name, version)))),
      );
    case 'remove':
      return declared.map(([dir, name]) => () => withDeclarations(spec, dir, (map) => map.delete(name)));
    case 'repoint':
      return used.flatMap((id) =>
        [...spec.universe.get(id)!.dependencies.keys()].map((name) => () => withVersion(spec, id, (version) => withDependencies(version, (map) => map.set(name, other(map.get(name)!))))),
      );
    case 'second': {
      // An entry starts to use the version of a name that the install does not have yet.
      const single = used.filter((id) => used.filter((candidate) => nameOfId(candidate) === nameOfId(id)).length === 1);
      return used.flatMap((id) => {
        const version = spec.universe.get(id)!;
        return single
          .filter((present) => nameOfId(present) !== version.name)
          .flatMap((present) => {
            const name = nameOfId(present);
            const target = other(spec.universe.get(present)!.version);
            const replace = version.dependencies.has(name) || version.dependencies.size < 2 ? [null] : [...version.dependencies.keys()];
            return replace.map((dropped) => () =>
              withVersion(spec, id, (current) =>
                withDependencies(current, (map) => {
                  if (dropped !== null) {
                    map.delete(dropped);
                  }
                  map.set(name, target);
                }),
              ),
            );
          });
      });
    }
    case 'content':
      return used.map((id) => () => withVersion(spec, id, (version) => ({ ...version, content: `${version.content}-republished` })));
  }
}

/** Applies the edit, or the first kind after it in EDITS that has a concrete edit. */
function applyEdit(spec: Spec, edit: Edit): Spec {
  const start = EDITS.indexOf(edit.kind);
  for (let offset = 0; offset < EDITS.length; offset++) {
    const options = candidates(spec, EDITS[(start + offset) % EDITS.length]!);
    if (options.length > 0) {
      return options[edit.pick % options.length]!();
    }
  }
  return spec;
}

/** The install of `spec` in `layout`, or null when a hoisted layout cannot hold it. */
function place(spec: Spec, layout: Layout): Install | null {
  const used = usedIds(spec);
  const placed = layout === 'pnpm' ? isolate(spec, used) : layout === 'berry-pnp' ? { copies: new Map<string, string>(), links: new Map<string, string>() } : hoist(spec);
  return placed === null ? null : { ...spec, used, ...placed };
}

/** pnpm's isolated layout: each package in node_modules/.pnpm/<id>, its dependencies and every importer's declarations as symlinks. */
function isolate(spec: Spec, used: readonly string[]): { copies: Map<string, string>; links: Map<string, string> } {
  const store = (id: string): string => `node_modules/.pnpm/${id}/node_modules/${nameOfId(id)}`;
  const copies = new Map<string, string>();
  const links = new Map<string, string>();
  for (const id of used) {
    copies.set(store(id), id);
    for (const [name, version] of spec.universe.get(id)!.dependencies) {
      links.set(`node_modules/.pnpm/${id}/node_modules/${name}`, store(idOf(name, version)));
    }
  }
  for (const [dir, declared] of spec.importers) {
    for (const [name, version] of declared) {
      links.set(`${modulesOf(dir)}/${name}`, store(idOf(name, version)));
    }
  }
  return { copies, links };
}

/** How deep `hoist` nests node_modules before it gives up. */
const MAX_DEPTH = 8;

/**
 * A hoisted node_modules, as classic yarn and Berry's node-modules linker lay it out:
 * - the root's declarations go to node_modules/<n>;
 * - an importer's declaration goes to the root when that slot is free or holds the same version,
 *   else to <importer>/node_modules/<n>;
 * - then, breadth first, a package's dependency goes as high up its own search path as it can: it
 *   reuses the first copy of that version it meets, stops below a slot holding another version,
 *   and never takes a slot that would change what an importer or a package placed earlier resolves
 *   that name to. The package's own node_modules always takes it.
 * So every importer and every package resolves each name it declares to the version it declares:
 * the function checks that before it returns.
 *
 * Peers are placed as Yarn's node-modules linker places them (spec §6.7). A package whose parent
 * provides its peer goes only where Node finds the parent's copy of that peer from it, and a copy
 * whose peer resolves otherwise is not reused for that parent. The parent places that peer first. An
 * unmet peer, one the parent does not provide, constrains nothing: Node finds whatever is there.
 *
 * null when the layout cannot hold the install: a cycle through two versions of one name (a@1 →
 * b@1 → a@2 → b@2 → a@1) nests past MAX_DEPTH node_modules, or two packages are each other's
 * provided peer, so neither can be placed first.
 */
function hoist(spec: Spec): { copies: Map<string, string>; links: Map<string, string> } | null {
  const copies = new Map<string, string>();
  /** Every resolution that must hold: what each importer and package declares, and each provided peer. */
  const required: { readonly from: string; readonly name: string; readonly id: string }[] = [];
  const queue: string[] = [];
  const resolves = (from: string, name: string): string | null => {
    for (const modules of searchPath(from)) {
      const id = copies.get(`${modules}/${name}`);
      if (id !== undefined) {
        return id;
      }
    }
    return null;
  };
  /** The peer that `parent` provides to its dependency `id`, as the id it must resolve to. */
  const providedPeer = (parent: ReadonlyMap<string, string>, id: string): { readonly name: string; readonly id: string } | null => {
    const peer = spec.universe.get(id)!.peer;
    const version = peer === null ? undefined : parent.get(peer);
    return peer === null || version === undefined ? null : { name: peer, id: idOf(peer, version) };
  };
  /** Whether a copy of `id` at `slot` sees its provided peer there. */
  const seesPeer = (slot: string, peer: { readonly name: string; readonly id: string } | null): boolean => peer === null || resolves(slot, peer.name) === peer.id;
  /** Whether a new copy of `id` at `slot` keeps every required resolution and sees its provided peer. */
  const fits = (slot: string, name: string, id: string, peer: { readonly name: string; readonly id: string } | null): boolean => {
    copies.set(slot, id);
    const ok = required.every((r) => r.name !== name || resolves(r.from, name) === r.id) && seesPeer(slot, peer);
    copies.delete(slot);
    return ok;
  };
  /** A parent's names in placing order: a provided peer before the package that needs it. */
  const ordered = (parent: ReadonlyMap<string, string>): string[] | null => {
    const out: string[] = [];
    const visiting = new Set<string>();
    const visit = (name: string): boolean => {
      if (out.includes(name)) {
        return true;
      }
      if (visiting.has(name)) {
        return false;
      }
      visiting.add(name);
      const peer = providedPeer(parent, idOf(name, parent.get(name)!));
      if (peer !== null && !visit(peer.name)) {
        return false;
      }
      out.push(name);
      return true;
    };
    return [...parent.keys()].sort(compareStrings).every(visit) ? out : null;
  };
  const put = (location: string, id: string): boolean => {
    copies.set(location, id);
    queue.push(location);
    return location.split('/').filter((segment) => segment === 'node_modules').length <= MAX_DEPTH;
  };

  for (const dir of IMPORTERS) {
    const declared = spec.importers.get(dir)!;
    const names = ordered(declared);
    if (names === null) {
      return null;
    }
    for (const name of names) {
      const id = idOf(name, declared.get(name)!);
      const peer = providedPeer(declared, id);
      const root = `node_modules/${name}`;
      const held = copies.get(root);
      let at = root;
      if (held === undefined ? !fits(root, name, id, peer) : held !== id || !seesPeer(root, peer)) {
        at = `${modulesOf(dir)}/${name}`;
        if (dir === '' || !fits(at, name, id, peer)) {
          throw new Error(`hoist: no slot for ${id} declared by ${dir || '.'}`);
        }
      }
      if (at !== root || held === undefined) {
        put(at, id);
      }
      required.push({ from: dir, name, id });
      if (peer !== null) {
        required.push({ from: at, name: peer.name, id: peer.id });
      }
    }
  }

  // Breadth first: an array's iterator also visits what is pushed while it runs.
  for (const location of queue) {
    const dependencies = spec.universe.get(copies.get(location)!)!.dependencies;
    const names = ordered(dependencies);
    if (names === null) {
      return null;
    }
    for (const name of names) {
      const id = idOf(name, dependencies.get(name)!);
      const peer = providedPeer(dependencies, id);
      let best: string | null = null;
      let reused: string | null = null;
      for (const modules of searchPath(location)) {
        // Only the root, an importer or a package has a node_modules: never pkgs/node_modules.
        const holder = modules === 'node_modules' ? '' : modules.slice(0, -'/node_modules'.length);
        if (holder !== '' && !IMPORTERS.includes(holder) && !copies.has(holder)) {
          continue;
        }
        const slot = `${modules}/${name}`;
        const held = copies.get(slot);
        if (held === id && seesPeer(slot, peer)) {
          reused = slot;
          break;
        }
        if (held !== undefined || !fits(slot, name, id, peer)) {
          break;
        }
        best = slot;
      }
      const at = reused ?? best;
      if (at === null) {
        throw new Error(`hoist: no slot for ${id} under ${location}`);
      }
      if (reused === null && !put(at, id)) {
        return null;
      }
      required.push({ from: location, name, id });
      if (peer !== null) {
        required.push({ from: at, name: peer.name, id: peer.id });
      }
    }
  }

  for (const r of required) {
    if (resolves(r.from, r.name) !== r.id) {
      throw new Error(`hoist: ${r.from || '.'} resolves ${r.name} to ${String(resolves(r.from, r.name))}, not ${r.id}`);
    }
  }
  return { copies, links: new Map() };
}

/** The node_modules directories Node searches from a file or package in `dir`, nearest first. */
function searchPath(dir: string): string[] {
  const out: string[] = [];
  for (let at = dir; ; at = dirOf(at)) {
    if (at.slice(at.lastIndexOf('/') + 1) !== 'node_modules') {
      out.push(modulesOf(at));
    }
    if (at === '') {
      return out;
    }
  }
}

/** The real package directory Node loads for `name` from `dir`, or null. */
function find(install: Install, dir: string, name: string): string | null {
  for (const modules of searchPath(dir)) {
    const location = `${modules}/${name}`;
    const linked = install.links.get(location);
    if (linked !== undefined) {
      return linked;
    }
    if (install.copies.has(location)) {
      return location;
    }
  }
  return null;
}

/** The importer a test belongs to: the deepest importer directory that holds it. */
export function importerOf(install: Install, test: string): string {
  const dir = dirOf(test);
  let best = '';
  for (const importer of install.importers.keys()) {
    if ((importer === '' || dir === importer || dir.startsWith(`${importer}/`)) && importer.length >= best.length) {
      best = importer;
    }
  }
  return best;
}

/** What `test` loads through each name it imports: sorted items, by imported name. */
export function loadsThrough(install: Install, layout: Layout, test: string): ReadonlyMap<string, readonly string[]> {
  return walk(install, layout, test, null);
}

/** Oracle: what `test` loads, walking the placed install as Node (or Plug'n'Play) does. Never calls a reader or `locate`. */
export function loads(install: Install, layout: Layout, test: string): readonly string[] {
  return union(loadsThrough(install, layout, test));
}

/**
 * What `test` loads by paths that never follow, in the hoisted Berry layout, an unmet peer named in
 * `peers`: a peer that the package's parent (the importer or package whose lookup loaded it) does
 * not provide, which Node then finds by position. Spec §6.4's second residual case. In every other
 * layout nothing is left out.
 */
export function loadsWithoutUnmetPeers(install: Install, layout: Layout, test: string, peers: ReadonlySet<string>): readonly string[] {
  return union(walk(install, layout, test, layout === 'berry-node-modules' ? peers : null));
}

function union(through: ReadonlyMap<string, readonly string[]>): readonly string[] {
  return [...new Set([...through.values()].flat())].sort(compareStrings);
}

function walk(install: Install, layout: Layout, test: string, unmet: ReadonlySet<string> | null): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const declared = install.importers.get(importerOf(install, test))!;
  for (const name of install.tests.get(test) ?? []) {
    const items = new Set<string>();
    if (layout === 'berry-pnp') {
      // A workspace loads exactly what it declares.
      const version = declared.get(name);
      if (version === undefined) {
        items.add(`missing ${name}`);
      } else {
        visitPnp(install, idOf(name, version), declared, items, new Set());
      }
    } else {
      const location = find(install, dirOf(test), name);
      if (location === null) {
        items.add(`missing ${name}`);
      } else {
        visitNode(install, location, declared, items, new Set(), unmet);
      }
    }
    out.set(name, [...items].sort(compareStrings));
  }
  return out;
}

/**
 * A package directory, then each name it requires (its dependencies and its peer), found from there.
 * `parent` is what its parent provides: the test's importer's declarations, or the dependencies of
 * the package that required it. A peer's copy has the same parent as the package whose peer it is.
 * With `unmet`, a peer named there that the parent does not provide is not followed.
 */
function visitNode(install: Install, location: string, parent: ReadonlyMap<string, string>, items: Set<string>, seen: Set<string>, unmet: ReadonlySet<string> | null): void {
  const id = install.copies.get(location)!;
  const version = install.universe.get(id)!;
  const follow = version.peer !== null && (unmet === null || !unmet.has(version.peer) || parent.has(version.peer));
  const key = `${location} ${follow ? 'peer' : ''}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  items.add(`pkg ${id} ${version.content}`);
  const required: [string, ReadonlyMap<string, string>][] = [...version.dependencies.keys()].map((name) => [name, version.dependencies]);
  if (follow) {
    required.push([version.peer, parent]);
  }
  for (const [name, provider] of required) {
    const found = find(install, location, name);
    if (found === null) {
      items.add(`missing ${name}`);
    } else {
      visitNode(install, found, provider, items, seen, unmet);
    }
  }
}

/**
 * Plug'n'Play: a package loads its own dependencies, and its peer is its parent's dependency of
 * that name. `provider` is the parent's dependencies (a workspace's declarations for a test).
 */
function visitPnp(install: Install, id: string, provider: ReadonlyMap<string, string>, items: Set<string>, seen: Set<string>): void {
  const version = install.universe.get(id)!;
  const peer = version.peer === null ? undefined : provider.get(version.peer);
  const key = `${id} ${peer ?? ''}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  items.add(`pkg ${id} ${version.content}`);
  if (version.peer !== null) {
    if (peer === undefined) {
      items.add(`missing ${version.peer}`);
    } else {
      visitPnp(install, idOf(version.peer, peer), provider, items, seen);
    }
  }
  for (const [name, dependency] of version.dependencies) {
    visitPnp(install, idOf(name, dependency), version.dependencies, items, seen);
  }
}

/** The repository files: lockfile, package.json files, workspace config and test files, ready for fakeRepo. */
export function writeRepo(install: Install, layout: Layout): Record<string, string> {
  const classic = layout === 'classic';
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const dependencies = (dir: string): { dependencies?: Record<string, string> } => {
    const declared = sortedEntries(install.importers.get(dir)!);
    return classic && declared.length > 0 ? { dependencies: Object.fromEntries(declared.map(([name]) => [name, classicRange(dir)])) } : {};
  };
  const files: Record<string, string> = {
    'package.json': json({ name: 'root', private: true, ...(layout === 'pnpm' ? {} : { workspaces: ['pkgs/*'] }), ...dependencies('') }),
  };
  for (const dir of IMPORTERS.filter((importer) => importer !== '')) {
    files[`${dir}/package.json`] = json({ name: workspaceName(dir), version: '0.0.0', ...dependencies(dir) });
  }
  switch (layout) {
    case 'pnpm':
      files['pnpm-workspace.yaml'] = "packages:\n  - 'pkgs/*'\n";
      files['pnpm-lock.yaml'] = pnpmLock(install);
      break;
    case 'berry-node-modules':
    case 'berry-pnp':
      files['.yarnrc.yml'] = `nodeLinker: ${layout === 'berry-pnp' ? 'pnp' : 'node-modules'}\n`;
      files['yarn.lock'] = berryLock(install);
      break;
    case 'classic':
      files['yarn.lock'] = classicLock(install);
      break;
  }
  for (const [test, names] of install.tests) {
    files[test] = names.map((name) => `import '${name}';\n`).join('');
  }
  return files;
}

const workspaceName = (dir: string): string => (dir === '' ? 'root' : dir.slice(dir.lastIndexOf('/') + 1));

/**
 * Classic yarn's importers declare ranges in package.json. Each importer has its own, which every
 * version satisfies, so a bump of what it resolves to is a lockfile-only change, as `yarn upgrade` makes.
 */
function classicRange(dir: string): string {
  return ['*', 'x', 'X'][IMPORTERS.indexOf(dir)]!;
}

function pnpmLock(install: Install): string {
  const lines = ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'importers:', ''];
  for (const dir of IMPORTERS) {
    const declared = sortedEntries(install.importers.get(dir)!);
    const key = dir === '' ? '.' : dir;
    if (declared.length === 0) {
      lines.push(`  ${key}: {}`, '');
      continue;
    }
    lines.push(`  ${key}:`, '    dependencies:');
    for (const [name, version] of declared) {
      lines.push(`      ${name}:`, `        specifier: ^${version}`, `        version: ${version}`);
    }
    lines.push('');
  }
  if (install.used.length === 0) {
    lines.push('packages: {}', '', 'snapshots: {}', '');
    return lines.join('\n');
  }
  lines.push('packages:', '');
  for (const id of install.used) {
    lines.push(`  ${id}:`, `    resolution: {integrity: ${install.universe.get(id)!.content}}`, '');
  }
  lines.push('snapshots:', '');
  for (const id of install.used) {
    const deps = sortedEntries(install.universe.get(id)!.dependencies);
    if (deps.length === 0) {
      lines.push(`  ${id}: {}`, '');
      continue;
    }
    lines.push(`  ${id}:`, '    dependencies:', ...deps.map(([name, version]) => `      ${name}: ${version}`), '');
  }
  return lines.join('\n');
}

function berryLock(install: Install): string {
  // Every descriptor that names an entry: `^<version>` from a workspace, the exact version from an entry.
  const descriptors = new Map<string, Set<string>>(install.used.map((id) => [id, new Set<string>()]));
  for (const declared of install.importers.values()) {
    for (const [name, version] of declared) {
      descriptors.get(idOf(name, version))!.add(`${name}@npm:^${version}`);
    }
  }
  for (const id of install.used) {
    for (const [name, version] of install.universe.get(id)!.dependencies) {
      descriptors.get(idOf(name, version))!.add(`${name}@npm:${version}`);
    }
  }
  const blocks: [string, string[]][] = [];
  for (const id of install.used) {
    const version = install.universe.get(id)!;
    const key = [...descriptors.get(id)!].sort(compareStrings).join(', ');
    const lines = [`"${key}":`, `  version: ${version.version}`, `  resolution: "${version.name}@npm:${version.version}"`];
    if (version.dependencies.size > 0) {
      lines.push('  dependencies:', ...sortedEntries(version.dependencies).map(([name, dependency]) => `    ${name}: "npm:${dependency}"`));
    }
    if (version.peer !== null) {
      lines.push('  peerDependencies:', `    ${version.peer}: "*"`);
    }
    lines.push(`  checksum: 10c0/${version.content}`, '  languageName: node', '  linkType: hard');
    blocks.push([key, lines]);
  }
  for (const dir of IMPORTERS) {
    const resolution = `${workspaceName(dir)}@workspace:${dir === '' ? '.' : dir}`;
    const declared = sortedEntries(install.importers.get(dir)!);
    const lines = [`"${resolution}":`, '  version: 0.0.0-use.local', `  resolution: "${resolution}"`];
    if (declared.length > 0) {
      lines.push('  dependencies:', ...declared.map(([name, version]) => `    ${name}: "npm:^${version}"`));
    }
    lines.push('  languageName: unknown', '  linkType: soft');
    blocks.push([resolution, lines]);
  }
  const header = '# This file is generated by running "yarn install" inside your project.\n# Manual changes might be lost - proceed with caution!\n\n__metadata:\n  version: 8\n  cacheKey: 10c0\n';
  return [header, ...blocks.sort(([a], [b]) => compareStrings(a, b)).map(([, lines]) => `${lines.join('\n')}\n`)].join('\n');
}

function classicLock(install: Install): string {
  const descriptors = new Map<string, Set<string>>(install.used.map((id) => [id, new Set<string>()]));
  for (const [dir, declared] of install.importers) {
    for (const [name, version] of declared) {
      descriptors.get(idOf(name, version))!.add(`${name}@${classicRange(dir)}`);
    }
  }
  for (const id of install.used) {
    for (const [name, version] of install.universe.get(id)!.dependencies) {
      descriptors.get(idOf(name, version))!.add(`${name}@${version}`);
    }
  }
  const blocks = install.used.map((id) => {
    const version = install.universe.get(id)!;
    const lines = [
      `${[...descriptors.get(id)!].sort(compareStrings).join(', ')}:`,
      `  version "${version.version}"`,
      `  resolved "https://registry.yarnpkg.com/${version.name}/-/${version.name}-${version.version}.tgz#${version.content}"`,
      `  integrity ${version.content}`,
    ];
    if (version.dependencies.size > 0) {
      lines.push('  dependencies:', ...sortedEntries(version.dependencies).map(([name, dependency]) => `    ${name} "${dependency}"`));
    }
    return `${lines.join('\n')}\n`;
  });
  return ['# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n', ...blocks].join('\n');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
