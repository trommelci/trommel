// The golden repository and its map (DECISIONS 28 and 32), shared by the two golden tests: the
// canonical JSON of this map is pinned in ./golden.test.ts, and its SMAP bytes in
// ../smap/golden.test.ts. It holds every node kind the builder gives today.
import { buildStaticMap, type TrommelMap } from '../../src/graph/static.ts';
import { fakeRepo } from './fake-repo.ts';

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'golden', workspaces: ['packages/*'] },
    'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-L', dependencies: { dep: '^1', gone: '^1' } },
    'node_modules/dep': { version: '1.0.0', integrity: 'sha512-D' },
    'node_modules/lib': { resolved: 'packages/lib', link: true },
    'packages/lib': { name: 'lib', version: '1.0.0' },
  },
});

// Every string is written with explicit escapes, so no editor or checkout setting can change a byte.
// The two non-ASCII names sort differently by UTF-16 code unit (the map's order) and by code point.
const FACE = '\u{1F600}';
const TILDE = '～';

const repo = fakeRepo({
  '.env.test': 'A=1\n',
  'package.json': '{"name":"golden","type":"module","workspaces":["packages/*"]}\n',
  'package-lock.json': LOCK,
  'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
  'vitest.config.ts': 'export default {};\n',
  'bin/run.js': { mode: '100755', content: '#!/usr/bin/env node\n' },
  'fixtures/payments/one.json': '{"amount":1}\n',
  'packages/lib/package.json': '{"name":"lib","main":"index.js"}\n',
  'packages/lib/index.js': 'module.exports = 1;\n',
  'src/a.ts': "import { b } from './b';\nimport _ from 'lodash';\nimport { util } from '@/util';\nimport type { T } from './types';\nimport lib from 'lib';\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/util.ts': 'export const util = 1;\n',
  'src/types.d.ts': 'export type T = 1;\n',
  'src/pages.ts': "export const pages = import.meta.glob('./pages/*.ts');\n",
  'src/pages/home.ts': 'export default 1;\n',
  'src/assets.ts': "export const data = new URL('./data/', import.meta.url);\n",
  'src/data/x.json': '1\n',
  'src/dynamic.ts': 'export const load = (name: string) => import(name);\n',
  'src/absent.ts': "import 'not-installed';\n",
  'src/link.ts': { mode: '120000', content: 'b.ts' },
  'src/vendor/package.json': '{"main":"main.js"}\n',
  'src/vendor/main.js': 'module.exports = 2;\n',
  [`src/${FACE}.ts`]: `import './${TILDE}';\n`,
  [`src/${TILDE}.ts`]: 'export {};\n',
  'test/a.test.ts': "import '../src/a';\nimport '../src/vendor';\n",
  'test/pages.test.ts': "import '../src/pages';\nimport '../src/assets';\n",
  'test/payments.test.ts': "import '../src/dynamic';\nimport '../src/absent';\n",
  'test/unicode.test.ts': `import '../src/${FACE}';\nimport '../src/link';\n`,
});

export const goldenMap: TrommelMap = buildStaticMap({
  objectFormat: 'sha1',
  index: repo.index,
  vfs: repo.vfs,
  sources: repo.sources,
  tests: repo.vfs.files().filter((path) => path.endsWith('.test.ts')),
  global: ['package.json', '.env*', '**/vitest.config.*'],
  declared: [{ match: 'fixtures/payments/**', affects: 'test/payments.test.ts' }],
  config: '5c0ffee5c0ffee5c0ffee5c0ffee5c0ffee5c0ff',
});
