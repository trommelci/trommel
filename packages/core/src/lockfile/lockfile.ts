// The one interface every parsed lockfile offers (spec 2026-11-15-pnpm-yarn-lockfiles §8.1), so
// that the builder, the planner and `trommel diff` never ask which format they have. A lockfile is
// a set of `p:` nodes with hashes and edges, plus the lookup a bare import goes through (§6.4).

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

/**
 * The keys that appeared, changed hash or disappeared between two lockfiles, each list sorted. It
 * compares `nodes` only, a ⊥ node being a hash like any other; the caller checks the kinds agree.
 */
export function diffLockfiles(before: Lockfile, after: Lockfile): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [key, hash] of after.nodes) {
    if (!before.nodes.has(key)) {
      added.push(key);
    } else if (before.nodes.get(key) !== hash) {
      changed.push(key);
    }
  }
  for (const key of before.nodes.keys()) {
    if (!after.nodes.has(key)) {
      removed.push(key);
    }
  }
  return { added: added.sort(compareStrings), changed: changed.sort(compareStrings), removed: removed.sort(compareStrings) };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
