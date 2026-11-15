// The golden SMAP files (ADR-0009). A map is a function of the tree, the config and the engine, and
// SMAP gives a map one encoding, so these bytes are the same on every machine. CI runs this file on
// Ubuntu and on Windows: that is M1's "byte-identical SMAP across OSes".
//
// A change to a pin is reviewed like a snapshot. The static layer's address moves with the builder:
// it comes with a new ENGINE id, or with a DECISIONS entry saying why older maps stay safe to plan
// from (DECISIONS 26). The file's hash also moves with the format, which then needs a new FORMAT.
// ../graph/golden.test.ts pins the same map as canonical JSON, so a failure here alone means the
// encoding changed and the builder did not.
//
// To write the fixture again after such a change: TROMMEL_UPDATE_GOLDEN=1 npm test -- <this file>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/canonical-json.ts';
import { buildStaticMap, ENGINE } from '../../src/graph/static.ts';
import { FORMAT } from '../../src/smap/container.ts';
import { decodeSmap, encodeSmap } from '../../src/smap/smap.ts';
import { fakeRepo } from '../graph/fake-repo.ts';
import { goldenMap } from '../graph/golden-fixture.ts';
import { hexOf } from './hex.ts';

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

// A URL, so that Trommel's own plan sees this test depend on the fixture.
const FIXTURE = fileURLToPath(new URL('../fixtures/smap/golden.smap', import.meta.url));

const pins = (bytes: Uint8Array) => {
  const { layers } = decodeSmap(bytes);
  return { engine: ENGINE, format: FORMAT, length: bytes.length, sha256: sha256(bytes), snapshot: layers.snapshot, static: layers.static };
};

// Vector 2: the golden repository of ../graph/golden-fixture.ts.
const VECTOR_2 = {
  engine: 'trommel-static-3',
  format: 0,
  length: 3779,
  sha256: '1e681e67d1b2c5b750bb2ce5120976b22d75c6c2c8ed5c7c836d5fef91c4c335',
  snapshot: '363d585752cce5e318523488e4434ae399c9cbdee216a39349b6e78e89e8f9e8',
  static: 'bee3301f7bee9696132676a7ca225b45bb0c1c189bc98a9367dff9dbcdb1a480',
} as const;
/** The SHA-256 of the same map as canonical JSON, as ../graph/golden.test.ts pins it. */
const VECTOR_2_JSON = 'd648c8388ae3cd20ecfcf487d1dbcda9457b447217f93ff976da497a7d806811';

// Vector 3: a small SHA-256 repository, so 32-byte object ids are pinned too.
const VECTOR_3 = {
  engine: 'trommel-static-3',
  format: 0,
  length: 1045,
  sha256: '526aa9ba8990a9b6baf77023e823b4f73de5170fece91e061cf908059be3f62b',
  snapshot: '4e9391e83c4e4ba4d151a800b46f43cc6989320fa83444abbff0ac3ea1219c34',
  static: '244884ad07583b2533954b78d27787efe9688d820b7e5c6916299e2674f61ec5',
} as const;

const FACE = '\u{1F600}';
const TILDE = '～';

describe('vector 2, the golden repository', () => {
  const bytes = encodeSmap(goldenMap);
  if (process.env['TROMMEL_UPDATE_GOLDEN'] === '1') {
    mkdirSync(fileURLToPath(new URL('../fixtures/smap/', import.meta.url)), { recursive: true });
    writeFileSync(FIXTURE, bytes);
  }

  it('has the pinned bytes, whatever machine built it', () => {
    expect(pins(bytes)).toEqual(VECTOR_2);
  });

  it('is the committed fixture, byte for byte', () => {
    const file = readFileSync(FIXTURE);
    expect(file.length).toBe(bytes.length);
    expect(Buffer.compare(file, bytes)).toBe(0);
  });

  it("the fixture decodes to the builder's map", () => {
    const { map } = decodeSmap(readFileSync(FIXTURE));
    expect(sha256(canonicalJson(map))).toBe(VECTOR_2_JSON);
    expect(canonicalJson(map)).toBe(canonicalJson(goldenMap));
  });

  it('holds a path above U+FFFF as four bytes, and sorts it by UTF-16 code unit', () => {
    const { graph } = decodeSmap(bytes);
    const face = graph.id(`f:src/${FACE}.ts`)!;
    const tilde = graph.id(`f:src/${TILDE}.ts`)!;
    // U+1F600 is the units d83d de00 and U+FF5E is ff5e: by code unit the face comes first, by
    // code point it would come second.
    expect(face).toBeLessThan(tilde);
    expect(FACE.codePointAt(0)!).toBeGreaterThan(TILDE.codePointAt(0)!);
    expect(hexOf(bytes)).toContain('f0 9f 98 80');
    expect(hexOf(bytes)).not.toContain('ed a0 bd'); // never as a surrogate written on its own
  });

  it('stores no hash for a file, a directory or an uncertain node', () => {
    const stored = Object.entries(goldenMap.nodes).filter(([key]) => !/^[fdu]:/.test(key));
    // Every other node's hash is in the file: a SHA-256 as 32 raw bytes, anything else as text.
    for (const [, hash] of stored) {
      if (hash !== null && /^[0-9a-f]{64}$/.test(hash)) {
        expect(Buffer.from(bytes).includes(Buffer.from(hash, 'hex'))).toBe(true);
      }
    }
    const derived = Object.entries(goldenMap.nodes).filter(([key, hash]) => /^[du]:/.test(key) && hash !== null);
    expect(derived.length).toBeGreaterThan(0);
    for (const [, hash] of derived) {
      expect(Buffer.from(bytes).includes(Buffer.from(hash!, 'hex'))).toBe(false);
    }
  });
});

describe('vector 3, a sha256 repository', () => {
  const repo = fakeRepo(
    {
      'README.md': '# vector 3\n',
      'package.json': '{"name":"vector-3"}\n',
      'src/a.ts': "import './b';\nimport 'left-pad';\n",
      'src/b.ts': 'export {};\n',
      'test/a.test.ts': "import '../src/a';\n",
    },
    'sha256',
  );
  const map = buildStaticMap({ objectFormat: 'sha256', index: repo.index, vfs: repo.vfs, sources: repo.sources, tests: ['test/a.test.ts'], global: ['package.json'], config: 'ab'.repeat(32) });
  const bytes = encodeSmap(map);

  it('has the pinned bytes, whatever machine built it', () => {
    expect(pins(bytes)).toEqual(VECTOR_3);
  });

  it('holds 32-byte object ids and decodes to the map it was made from', () => {
    expect(map.rootTree).toHaveLength(64);
    expect(Buffer.from(bytes).includes(Buffer.from(map.rootTree, 'hex'))).toBe(true);
    expect(canonicalJson(decodeSmap(bytes).map)).toBe(canonicalJson(map));
  });
});
