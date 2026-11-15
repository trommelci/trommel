// Vector 1: a map written by hand that uses every section of SMAP v0. ./smap.test.ts gives its
// bytes field by field, as docs/smap-format.md does; ./fuzz.test.ts damages them.
import { createHash } from 'node:crypto';

import type { TrommelMap } from '../../src/graph/static.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const ONE: TrommelMap = {
  version: 1,
  engine: 'trommel-static-4',
  objectFormat: 'sha1',
  rootTree: 'aa'.repeat(20),
  undecodable: 0,
  config: null,
  lockfile: { kind: 'npm', path: 'package-lock.json' },
  snapshot: [
    ['100644', '11'.repeat(20), 'a.test.ts'],
    ['100644', '22'.repeat(20), 'a.ts'],
  ],
  nodes: {
    'f:a.test.ts': '11'.repeat(20),
    'f:a.ts': '22'.repeat(20),
    'g:glob:k': 'cc'.repeat(32),
    'p:npm:node_modules/x': 'sha512-X',
    'p:npm:node_modules/y': null,
    'u:a.ts': sha256('["line 1: lexer E"]'),
  },
  edges: {
    'f:a.test.ts': { 'f:a.ts': 1, 'g:glob:k': 4 },
    'f:a.ts': { 'p:npm:node_modules/x': 1, 'p:npm:node_modules/y': 1, 'u:a.ts': 1 },
  },
  globs: { 'g:glob:k': ['*.ts'] },
  tests: ['a.test.ts'],
  uncertain: { 'u:a.ts': ['line 1: lexer E'] },
};
