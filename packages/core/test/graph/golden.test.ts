// The golden map (ADR-0009, DECISIONS 28). The static map of a snapshot is a function of the tree,
// the config and the engine only (ADR-0003), so this fixture's map has the same bytes on every
// machine. CI runs this file on Ubuntu and on Windows: that is the cross-OS check.
//
// A change to the pinned hash is reviewed like a snapshot. It comes with a new ENGINE id, or with a
// DECISIONS entry saying why maps from the older builder stay safe to plan from (DECISIONS 26).
// That is why the engine id and the hash are pinned side by side.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/canonical-json.ts';
import { DECLARED, STATIC } from '../../src/graph/graph.ts';
import { parseMap } from '../../src/graph/map.ts';
import { ENGINE } from '../../src/graph/static.ts';
import { goldenMap } from './golden-fixture.ts';

const GOLDEN = {
  engine: 'trommel-static-3',
  sha256: 'd648c8388ae3cd20ecfcf487d1dbcda9457b447217f93ff976da497a7d806811',
} as const;

const map = goldenMap;
const text = canonicalJson(map);

describe('the golden map', () => {
  it('holds only the node kinds that a tree, a config and an engine can give', () => {
    const kinds: Record<string, number> = {};
    for (const key of Object.keys(map.nodes)) {
      const kind = key.slice(0, key.indexOf(':'));
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    expect(kinds).toEqual({ c: 7, d: 3, f: 28, g: 5, p: 6, r: 17, u: 2 });
  });

  it('covers an uncertain file, absent paths and both provenances, so the hash pins each', () => {
    expect(Object.keys(map.uncertain)).toEqual(['u:src/absent.ts', 'u:src/dynamic.ts']);
    expect(map.nodes['f:pnpm-workspace.yaml']).toBeNull();
    expect(map.nodes['p:npm:node_modules/gone']).toBeNull();
    const provenances = new Set(Object.values(map.edges).flatMap((out) => Object.values(out)));
    expect([...provenances].sort()).toEqual([STATIC, DECLARED]);
  });

  it('covers both kinds of hub: a package directory with a sub-hub and an exact entry, and config chains', () => {
    expect(map.edges['r:src/vendor']).toEqual({ 'f:src/vendor/main.js': STATIC, 'f:src/vendor/package.json': STATIC, 'r:src/vendor/index': STATIC });
    expect('r:src/vendor/main.js' in map.nodes).toBe(false);
    expect(map.edges['c:src']).toEqual({ 'f:package.json': STATIC, 'f:tsconfig.json': STATIC });
    expect(map.nodes['f:src/b.js']).toBeUndefined(); // an absent candidate lives in its hub's hash
  });

  it('has the pinned bytes, whatever machine built it', () => {
    expect({ engine: ENGINE, sha256: createHash('sha256').update(text).digest('hex') }).toEqual(GOLDEN);
  });

  it('reads back to the same bytes', () => {
    expect(canonicalJson(parseMap(text))).toBe(text);
  });
});
