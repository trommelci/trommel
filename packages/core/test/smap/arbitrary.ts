// Random maps for the SMAP property tests: each is the builder's map of a small random repository,
// so it holds whatever the builder can give. The repositories vary what the format has to carry:
// both object formats, every file mode, names that sort differently by code unit and by code point,
// a specifier with an unpaired surrogate, globs, hubs, uncertain files and each lockfile state.
import fc from 'fast-check';

import { buildStaticMap, type TrommelMap } from '../../src/graph/static.ts';
import type { FakeFile } from '../git/fake-tree.ts';
import { fakeRepo } from '../graph/fake-repo.ts';

const FACE = '\u{1F600}';
const TILDE = '～';

const LINES = [
  "import './a';",
  "import './b.ts';",
  "import './d/c';",
  "import './c';",
  "import '../a';",
  "import '../src/a';",
  "import '../src/d/e';",
  `import './${FACE}';`,
  `import '../src/${TILDE}';`,
  "import 'lodash';",
  "import 'not-installed';",
  "import lib from 'lib';",
  "import '@/b';",
  "import type { T } from './b';",
  "const a = require('./a');",
  "export const load = (name: string) => import(name);",
  "export const pages = import.meta.glob('./d/*.ts');",
  "export const data = new URL('./d/', import.meta.url);",
  // The lexer decodes the escape, so this specifier holds an unpaired surrogate.
  "import './\\ud800x';",
  "export const odd = import.meta.glob('./\\udfff*.ts');",
  "import './missing';",
] as const;

const SOURCES = ['src/a.ts', 'src/b.ts', 'src/d/c.ts', 'src/d/e.tsx', `src/${FACE}.ts`, `src/${TILDE}.js`, 'test/x.test.ts', 'test/y.test.ts'] as const;

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'random', workspaces: ['packages/*'] },
    'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-L', dependencies: { gone: '^1' } },
    'node_modules/lib': { resolved: 'packages/lib', link: true },
    'packages/lib': { name: 'lib', version: '1.0.0' },
  },
});

const EXTRAS: Readonly<Record<string, string | FakeFile>> = {
  'package.json': '{"name":"random","type":"module","workspaces":["packages/*"]}\n',
  'package-lock.json': LOCK,
  'yarn.lock': '# yarn lockfile v1\n',
  'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
  'src/d/package.json': '{"main":"c.ts"}\n',
  'src/link.ts': { mode: '120000', content: 'b.ts' },
  'bin/run.js': { mode: '100755', content: '#!/usr/bin/env node\n' },
  'vendor/sub': { mode: '160000', content: 'commit-1' },
  'fixtures/data.json': '{}\n',
  'packages/lib/package.json': '{"name":"lib","main":"index.js"}\n',
  'packages/lib/index.js': 'module.exports = 1;\n',
};

const content = fc.array(fc.constantFrom(...LINES), { maxLength: 4 }).map((lines) => `${lines.join('\n')}\n`);

const spec = fc.record({
  sources: fc.record(Object.fromEntries(SOURCES.map((path) => [path, fc.option(content, { nil: null, freq: 4 })]))),
  extras: fc.subarray(Object.keys(EXTRAS)),
  hash: fc.constantFrom('sha1' as const, 'sha256' as const),
  global: fc.boolean(),
  declared: fc.boolean(),
  config: fc.boolean(),
});

export const arbitraryMap: fc.Arbitrary<TrommelMap> = spec.map(({ sources, extras, hash, global, declared, config }) => {
  const files: Record<string, string | FakeFile> = {};
  for (const [path, text] of Object.entries(sources)) {
    if (text !== null) {
      files[path] = text;
    }
  }
  for (const path of extras) {
    files[path] = EXTRAS[path]!;
  }
  const repo = fakeRepo(files, hash);
  return buildStaticMap({
    objectFormat: hash,
    index: repo.index,
    vfs: repo.vfs,
    sources: repo.sources,
    tests: repo.vfs.files().filter((path) => path.endsWith('.test.ts')),
    ...(global ? { global: ['package.json', '**/*.json'] } : {}),
    ...(declared ? { declared: [{ match: 'fixtures/**', affects: 'test/x.test.ts' }] } : {}),
    config: config ? 'c0'.repeat(hash === 'sha1' ? 20 : 32) : null,
  });
});
