// The one interface every parsed lockfile offers (spec 2026-11-15-pnpm-yarn-lockfiles §8.1), so
// that the builder, the planner and `trommel diff` never ask which format they have. A lockfile is
// a set of `p:` nodes with hashes and edges, plus the lookup a bare import goes through (§6.4).

export type LockfileKind = 'npm' | 'pnpm' | 'yarn-berry' | 'yarn-classic';

export interface Lockfile {
  readonly kind: LockfileKind;
  readonly path: string;
  /** The nodes this lockfile always defines: key → hash, null for ⊥. */
  readonly nodes: ReadonlyMap<string, string | null>;
  /**
   * The hash of any key of this lockfile, name nodes included on demand; undefined if it is none of
   * its keys. A pnpm or yarn lockfile also answers for a root lookup `p:npm:node_modules/<name>` that
   * is not a node: with the name's name node once the lockfile knows the name (spec §6.4, case 3).
   */
  hash(key: string): string | null | undefined;
  /** The keys a key has edges to, sorted and unique; [] for a key it does not know. */
  dependencies(key: string): readonly string[];
  /** Spec §6.4: a lookup key, a name-node key, or null. `dir` is POSIX, '' for the root. */
  locate(name: string, dir: string): string | null;
}
