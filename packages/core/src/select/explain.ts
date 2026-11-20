// Explains one test's decision in the static plan, with paths. It explains the plan's decision and
// never makes one: the verdict, the reason and the plan's own path come from the `Selection` alone.
// The graph adds what the plan does not keep: every seed (changed node or `u:` node) the test
// reaches, how much the test depends on, and, on request, whether and how it reaches one node.
import { forwardTree, whyPath, type Graph, type Reach } from '../graph/graph.ts';
import type { TrommelMap } from '../graph/static.ts';
import type { Selection } from './plan.ts';

export type Verdict = 'affected' | 'forced' | 'would-skip';

/** A changed or uncertain node the test reaches, with a shortest path from the test; a u: node carries its causes. */
export interface SeedPath {
  readonly node: string;
  readonly path: readonly string[];
  readonly causes?: readonly string[];
}

export type Target =
  | { readonly node: string; readonly status: 'reached'; readonly path: readonly string[] }
  | { readonly node: string; readonly status: 'not reached' | 'not in the map' | 'test not in the map' | 'no map' };

export interface Explanation {
  readonly test: string;
  readonly verdict: Verdict;
  /** Forced only: the plan's reason, word for word ('new test file', 'alwaysRun', 'L1: …', 'L3: …'). */
  readonly reason?: string;
  /** The plan's own path: an affected test's why-path, or an L1 test's path into the escalated package. */
  readonly path?: readonly string[];
  /** Affected only: every seed the test reaches, sorted by key. */
  readonly seeds?: readonly SeedPath[];
  /** How many nodes the test reaches besides itself; only when the test is one of the map's tests. */
  readonly dependsOn?: number;
  readonly to?: Target;
}

export interface ExplainContext {
  readonly map: TrommelMap;
  readonly graph: Graph;
}

/** Throws RangeError when `test` is not in `selection.tests`. `to` is a node key. */
export function explainTest(selection: Selection, test: string, context: ExplainContext | null, to?: string): Explanation {
  if (!selection.tests.includes(test)) {
    throw new RangeError(`${test} is not a test of this plan`);
  }
  const affected = selection.affected.find((entry) => entry.test === test);
  const forced = selection.forced.find((entry) => entry.test === test);
  const verdict: Verdict = affected !== undefined ? 'affected' : forced !== undefined ? 'forced' : 'would-skip';
  const planPath = affected?.path ?? forced?.path;

  let tree: Reach | null = null;
  if (context?.map.tests.includes(test) === true) {
    const id = context.graph.id(`f:${test}`);
    tree = id === undefined ? null : forwardTree(context.graph, id);
  }

  let seeds: SeedPath[] | undefined;
  if (verdict === 'affected' && context !== null && tree !== null) {
    const { map, graph } = context;
    const reached = tree;
    seeds = [...selection.changed, ...selection.uncertain]
      .filter((key) => reached.reached[graph.id(key)!] === 1)
      .sort(compareStrings)
      .map((key) => {
        const path = key === planPath?.at(-1) ? planPath : whyPath(reached, graph.id(key)!)!.map((node) => graph.name(node));
        const causes = key.startsWith('u:') && Object.hasOwn(map.uncertain, key) ? map.uncertain[key] : undefined;
        return { node: key, path, ...(causes !== undefined ? { causes } : {}) };
      });
  }

  let dependsOn: number | undefined;
  if (tree !== null) {
    dependsOn = -1;
    for (const flag of tree.reached) {
      dependsOn += flag;
    }
  }

  return {
    test,
    verdict,
    ...(forced !== undefined ? { reason: forced.reason } : {}),
    ...(planPath !== undefined ? { path: planPath } : {}),
    ...(seeds !== undefined ? { seeds } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(to !== undefined ? { to: target(context, tree, test, to) } : {}),
  };
}

function target(context: ExplainContext | null, tree: Reach | null, test: string, node: string): Target {
  if (context === null) {
    return { node, status: 'no map' };
  }
  const { map, graph } = context;
  if (!Object.hasOwn(map.nodes, node)) {
    return { node, status: 'not in the map' };
  }
  if (tree === null || !map.tests.includes(test)) {
    return { node, status: 'test not in the map' };
  }
  const path = whyPath(tree, graph.id(node)!);
  return path === null ? { node, status: 'not reached' } : { node, status: 'reached', path: path.map((id) => graph.name(id)) };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
