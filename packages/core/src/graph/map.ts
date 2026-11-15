// What a plan takes from a map besides its fields: the graph, and the base snapshot as an index.
//
// A map on disk is a SMAP file (../smap/smap.ts). It comes from a cache that may be stale, truncated
// or written by another version, so its reader checks everything; anything wrong is a MapError,
// which the CLI turns into a run-all plan (L3, architecture §3.5) instead of a guess.
import { TreeIndex } from '../git/diff.ts';
import { objectTypeOf } from '../git/ls-tree.ts';
import { GraphBuilder, type Graph } from './graph.ts';
import type { TrommelMap } from './static.ts';

/** The map cannot be trusted. The message is the reason, worded to follow "the map is invalid:". */
export class MapError extends Error {
  override readonly name = 'MapError';
}

/**
 * The map's graph; node ids follow sorted key order whatever order the map was written in. The
 * SMAP decoder gives the same graph straight from the file, and this is the oracle for it.
 */
export function mapGraph(map: Pick<TrommelMap, 'nodes' | 'edges'>): Graph {
  const builder = new GraphBuilder();
  for (const key of Object.keys(map.nodes)) {
    builder.addNode(key);
  }
  for (const [from, out] of Object.entries(map.edges)) {
    for (const [to, provenance] of Object.entries(out)) {
      builder.addEdge(from, to, provenance);
    }
  }
  return builder.build();
}

/** The snapshot a map was built from, as an index: the base of a plan's diff. */
export function mapIndex(map: Pick<TrommelMap, 'rootTree' | 'snapshot'>): TreeIndex {
  return TreeIndex.build({
    rootOid: map.rootTree,
    entries: map.snapshot.map(([mode, oid, path]) => ({ mode, oid, path, type: objectTypeOf(mode) })),
  });
}
