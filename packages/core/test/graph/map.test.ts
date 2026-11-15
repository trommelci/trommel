import { describe, expect, it } from 'vitest';

import { mapGraph, mapIndex } from '../../src/graph/map.ts';
import { buildStaticMap, type TrommelMap } from '../../src/graph/static.ts';
import { fakeRepo } from './fake-repo.ts';

// Reading a map back from disk is the SMAP decoder's work: see ../smap/smap.test.ts for what it
// refuses and ../smap/fuzz.test.ts for damaged files.
const repo = fakeRepo({ 'src/a.ts': "import './b';\n", 'src/b.ts': '', 'a.test.ts': "import './src/a';\n" });
const map = buildStaticMap({ objectFormat: 'sha1', index: repo.index, vfs: repo.vfs, sources: repo.sources, tests: ['a.test.ts'] });

describe('mapGraph', () => {
  it('has every node, including ones without edges, and every edge', () => {
    const graph = mapGraph(map);
    expect(graph.nodeCount).toBe(Object.keys(map.nodes).length);
    const names = (key: string) => graph.dependencies(graph.id(key)!).map((id) => graph.name(id));
    expect(names('f:src/a.ts')).toContain('r:src/b');
    expect(names('r:src/b')).toEqual(['f:src/b.ts']);
  });

  it('is identical however the map was ordered', () => {
    const shuffled: TrommelMap = { ...map, nodes: Object.fromEntries(Object.entries(map.nodes).reverse()), edges: Object.fromEntries(Object.entries(map.edges).reverse()) };
    expect(mapGraph(shuffled).forwardTargets()).toEqual(mapGraph(map).forwardTargets());
  });
});

describe('mapIndex', () => {
  it('lists what the snapshot lists, under the root tree of the map', () => {
    const index = mapIndex(map);
    expect(index.rootOid).toBe(map.rootTree);
    expect(index.rootOid).toBe(repo.index.rootOid);
    expect(index.entries()).toEqual(repo.index.entries());
  });

  it('gives each entry the object type its mode stands for', () => {
    const index = mapIndex({
      rootTree: 'aa'.repeat(20),
      snapshot: [
        ['040000', '11'.repeat(20), 'd'],
        ['100644', '22'.repeat(20), 'd/f'],
        ['120000', '33'.repeat(20), 'l'],
        ['160000', '44'.repeat(20), 'm'],
      ],
    });
    expect(index.entries().map((entry) => [entry.path, entry.type])).toEqual([
      ['d', 'tree'],
      ['d/f', 'blob'],
      ['l', 'blob'],
      ['m', 'commit'],
    ]);
  });
});
