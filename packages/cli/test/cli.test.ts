// End to end: the CLI run from source, as CI runs it, against a throwaway git repository.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { canonicalJson, decodeContainer, decodeSmap, encodeContainer, forwardReach } from '@trommel/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'demo' }, 'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-1' } } });

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const write = (files: Record<string, string | Uint8Array>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
};
const commit = (files: Record<string, string>): string => {
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'c');
  return git('rev-parse', 'HEAD');
};

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
const trommel = (args: string[], env: Record<string, string> = {}, cwd: string = repo): Run => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GITHUB_')));
  const result = spawnSync(process.execPath, [MAIN, ...args], { cwd, encoding: 'utf8', env: { ...clean, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

let base: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'trommel-cli-'));
  git('init', '-q');
  base = commit({
    '.gitignore': '.trommel/\n',
    'package.json': '{"name":"demo","type":"module"}\n',
    'package-lock.json': LOCK,
    'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
    'src/c.ts': "import _ from 'lodash';\nexport const c = _;\n",
    'test/a.test.ts': "import { a } from '../src/a';\n",
    'test/c.test.ts': "import { c } from '../src/c';\n",
    'README.md': '# demo\n',
  });
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('trommel graph, then plan', () => {
  it('writes the map of HEAD as a SMAP file', () => {
    const run = trommel(['graph', '--out', '.trommel/map/map.smap']);
    expect(run.stderr).toMatch(/2 tests/);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    const bytes = readFileSync(join(repo, '.trommel/map/map.smap'));
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x53, 0x4d, 0x41, 0x50, 0x0d, 0x0a, 0x1a]);
    expect(run.stderr).toContain(`${bytes.length} bytes of SMAP`);
    const { map } = decodeSmap(bytes);
    expect(map.tests).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    expect(map.rootTree).toBe(git('rev-parse', 'HEAD^{tree}'));
  });

  it('plans a change in shadow mode: everything runs, the selection is reported', () => {
    commit({ 'src/b.ts': 'export const b = 2;\n', 'README.md': '# demo, edited\n' });
    const outputs = join(repo, '..', `${repo.split(/[\\/]/).at(-1)!}-outputs.txt`);
    const summary = join(repo, '..', `${repo.split(/[\\/]/).at(-1)!}-summary.md`);
    writeFileSync(outputs, 'earlier=1\n');
    const run = trommel(['plan', '--mode', 'shadow', '--static', '--map', '.trommel/map'], { GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary });
    expect(run.status).toBe(0);
    const plan = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(plan['affected']).toEqual([{ test: 'test/a.test.ts', path: ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts'] }]);
    expect(plan['wouldSkip']).toEqual([{ test: 'test/c.test.ts', label: 'unproven static reachability' }]);
    expect(plan['run']).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    expect(plan['escalations']).toEqual([]);
    expect(readFileSync(outputs, 'utf8')).toBe('earlier=1\nmatrix={"include":[{"files":["test/a.test.ts","test/c.test.ts"],"shard":1}]}\ncount=2\n');
    expect(readFileSync(summary, 'utf8')).toContain('`test/a.test.ts` → `src/a.ts` → `src/b.ts` (changed)');
  });

  it('accepts --shadow for --mode shadow, and --shards', () => {
    const run = trommel(['plan', '--shadow', '--static', '--map', '.trommel/map', '--shards', '2']);
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { shards: string[][] }).shards).toEqual([['test/a.test.ts'], ['test/c.test.ts']]);
  });

  it('prints the snapshot difference between two revisions', () => {
    const run = trommel(['diff', base, 'HEAD']);
    expect(run.status).toBe(0);
    const delta = JSON.parse(run.stdout) as { files: { path: string; kind: string }[]; listings: string[]; packages: unknown };
    expect(delta.files.map((f) => `${f.kind} ${f.path}`)).toEqual(['modified README.md', 'modified src/b.ts']);
    expect(delta.listings).toEqual([]);
    expect(delta.packages).toEqual({ before: 'package-lock.json', after: 'package-lock.json', added: [], changed: [], removed: [] });
  });

  it('takes absolute paths for --out and --map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trommel-cli-abs-'));
    try {
      expect(trommel(['graph', '--rev', base, '--out', join(dir, 'map.smap')]).status).toBe(0);
      const run = trommel(['plan', '--shadow', '--static', '--map', dir]);
      expect(run.status).toBe(0);
      expect((JSON.parse(run.stdout) as { fallback?: string }).fallback).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds byte-identical maps of the same revision', () => {
    const again = join(repo, '.trommel/again.smap');
    expect(trommel(['graph', '--rev', base, '--out', again]).status).toBe(0);
    expect(Buffer.compare(readFileSync(again), readFileSync(join(repo, '.trommel/map/map.smap')))).toBe(0);
  });

  it('without --out, prints the same map as canonical JSON', () => {
    const run = trommel(['graph', '--rev', base]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${canonicalJson(decodeSmap(readFileSync(join(repo, '.trommel/map/map.smap'))).map)}\n`);
    expect(run.stderr).not.toContain('SMAP');
  });
});

describe('trommel plan fallbacks', () => {
  /** The map the first test wrote, as bytes. */
  const real = (): Buffer => readFileSync(join(repo, '.trommel/map/map.smap'));
  const otherEngine = (): Uint8Array => encodeContainer({ ...decodeContainer(real()), engine: 'trommel-static-9' });

  it.each<[string, string, () => Record<string, string | Uint8Array>, string]>([
    ['there is no map', 'nowhere', () => ({}), 'no map at nowhere/map.smap'],
    ['the map is not a SMAP file', 'bad', () => ({ 'bad/map.smap': '{' }), 'the map at bad/map.smap is invalid: it is not a SMAP file'],
    ['the map is a JSON map under the new name', 'json', () => ({ 'json/map.smap': '{"version":1,"engine":"trommel-static-3"}' }), 'the map at json/map.smap is invalid: it is not a SMAP file'],
    ['the map is empty', 'empty', () => ({ 'empty/map.smap': '' }), 'the map at empty/map.smap is invalid: it is not a SMAP file'],
    ['the map is cut short', 'cut', () => ({ 'cut/map.smap': real().subarray(0, 200) }), 'the map at cut/map.smap is invalid: its trailer is not the SHA-256 of its contents'],
    ['the map is cut inside its header', 'stub', () => ({ 'stub/map.smap': real().subarray(0, 40) }), 'the map at stub/map.smap is invalid: it ends before its trailer'],
    ['the directory holds only a stale map.json', 'stale', () => ({ 'stale/map.json': '{"version":1}' }), 'no map at stale/map.smap'],
    ['the map was built by another engine', 'other', () => ({ 'other/map.smap': otherEngine() }), 'the map at other/map.smap is invalid: the map was built by engine "trommel-static-9", expected trommel-static-4'],
  ])('plans every test, exiting 0, when %s', (_name, dir, files, cause) => {
    write(files());
    const outputs = join(repo, '..', `${repo.split(/[\\/]/).at(-1)!}-fallback.txt`);
    const run = trommel(['plan', '--shadow', '--static', '--map', dir], { GITHUB_OUTPUT: outputs });
    expect(run.status).toBe(0);
    const plan = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(plan['fallback']).toBe(cause);
    expect(plan['run']).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    expect(readFileSync(outputs, 'utf8')).toContain('count=2\n');
    expect(run.stderr).toContain(cause);
  });

  it('reads map.smap and ignores a stale map.json beside it', () => {
    write({ 'both/map.json': 'not a map at all', 'both/map.smap': real() });
    const run = trommel(['plan', '--shadow', '--static', '--map', 'both']);
    expect(run.status).toBe(0);
    const plan = JSON.parse(run.stdout) as { fallback?: string; base: { map: string } };
    expect(plan.fallback).toBeUndefined();
    expect(plan.base.map).toBe('both/map.smap');
  });

  it('plans every test when trommel.config.json is invalid', () => {
    commit({ 'trommel.config.json': '{ "version": 2 }' });
    const run = trommel(['plan', '--shadow', '--static']);
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { fallback: string }).fallback).toBe('invalid trommel.config.json: version: must be 1');
    git('rm', '-q', 'trommel.config.json');
    git('commit', '-q', '-m', 'c');
  });
});

describe('trommel explain', () => {
  // The map of `base`; the head is the commit where src/b.ts changed.
  const FOOTER = 'Shadow mode runs every test; this is what static selection would do.\n';
  const A_TEXT = `test/a.test.ts would run: it reaches 1 changed or uncertain node.\n  test/a.test.ts → src/a.ts → src/b.ts (changed)\n${FOOTER}`;
  const explain = (args: string[], cwd?: string): Run => trommel(['explain', ...args], {}, cwd);
  // The fallback tests above left their map fixtures in the work tree, and the config test committed
  // them; unmapped inputs would escalate every test (L1). Remove them from the head.
  beforeAll(() => {
    git('rm', '-rq', 'bad', 'json', 'empty', 'cut', 'stub', 'stale', 'other', 'both');
    git('commit', '-q', '-m', 'remove map fixtures');
  });
  const dependsOn = (test: string): number => {
    const { map, graph } = decodeSmap(readFileSync(join(repo, '.trommel/map/map.smap')));
    expect(map.tests).toContain(test);
    return forwardReach(graph, [graph.id(`f:${test}`)!]).reduce((sum, flag) => sum + flag, 0) - 1;
  };

  it('explains an affected test', () => {
    const run = explain(['test/a.test.ts']);
    expect(run).toEqual({ status: 0, stdout: A_TEXT, stderr: '' });
  });

  it('explains a would-skip, counting what the test depends on', () => {
    const run = explain(['test/c.test.ts']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `test/c.test.ts would be skipped (unproven static reachability): none of the ${dependsOn('test/c.test.ts')} nodes it depends on changed.\n${FOOTER}`,
    );
  });

  it('prints the path to a file or a map node after the verdict', () => {
    expect(explain(['test/a.test.ts', '--to', 'src/b.ts']).stdout).toBe(A_TEXT.replace(FOOTER, `Path to src/b.ts: test/a.test.ts → src/a.ts → src/b.ts\n${FOOTER}`));
    expect(explain(['test/c.test.ts', '--to', 'src/b.ts']).stdout).toContain(
      '\ntest/c.test.ts does not reach src/b.ts in the map. Static reachability cannot see what a test reads through fs.\n',
    );
    expect(explain(['test/c.test.ts', '--to', 'src/zzz.ts']).stdout).toContain('\nsrc/zzz.ts is not in the map.\n');
    const lodash = explain(['test/c.test.ts', '--to', 'p:npm:node_modules/lodash']).stdout;
    expect(lodash).toMatch(/\nPath to p:npm:node_modules\/lodash: test\/c\.test\.ts → .*→ p:npm:node_modules\/lodash\n/);
  });

  it('says so, exiting 0, when there is no map', () => {
    const run = explain(['test/a.test.ts', '--map', 'nowhere', '--to', 'src/b.ts']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `test/a.test.ts would run: L3: no map at nowhere/map.smap.\nWithout a usable map, the path to src/b.ts is unknown.\n${FOOTER}`,
    );
    expect(run.stderr).toBe('');
  });

  it('reads a key-shaped --to value as a node key, never as a path', () => {
    const noMap = explain(['test/a.test.ts', '--map', 'nowhere', '--to', 'p:npm:node_modules/lodash']);
    expect(noMap.status).toBe(0);
    expect(noMap.stdout.endsWith(`\nWithout a usable map, the path to p:npm:node_modules/lodash is unknown.\n${FOOTER}`)).toBe(true);
    const missing = explain(['test/a.test.ts', '--to', 'u:src/nothing.ts']);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('\nu:src/nothing.ts is not in the map.\n');
  });

  it('prints the explanation as canonical JSON, byte for byte the same each time', () => {
    const run = explain(['test/a.test.ts', '--json']);
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    const path = ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts'];
    expect(out['explanation']).toEqual({ test: 'test/a.test.ts', verdict: 'affected', path, seeds: [{ node: 'f:src/b.ts', path }], dependsOn: dependsOn('test/a.test.ts') });
    expect(out).toMatchObject({ version: 1, mode: 'shadow', static: true, base: { map: '.trommel/map/map.smap' }, head: { rev: 'HEAD' } });
    expect(out['fallback']).toBeUndefined();
    expect(explain(['test/a.test.ts', '--json']).stdout).toBe(run.stdout);
  });

  it('reports the fallback in the JSON, with no base', () => {
    const out = JSON.parse(explain(['test/a.test.ts', '--json', '--map', 'nowhere']).stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ base: null, fallback: 'no map at nowhere/map.smap', explanation: { verdict: 'forced', reason: 'L3: no map at nowhere/map.smap' } });
  });

  it('writes no GitHub outputs', () => {
    const outputs = join(repo, '..', `${repo.split(/[\\/]/).at(-1)!}-explain.txt`);
    const run = trommel(['explain', 'test/a.test.ts'], { GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: outputs });
    expect(run.status).toBe(0);
    expect(() => readFileSync(outputs)).toThrow(/ENOENT/);
  });

  it('takes the test and --map relative to the current directory', () => {
    expect(explain(['a.test.ts', '--map', '../.trommel/map'], join(repo, 'test'))).toEqual({ status: 0, stdout: A_TEXT, stderr: '' });
  });

  it('reads the default map at the repository root, from a subdirectory too', () => {
    const fromRoot = explain(['test/a.test.ts']);
    expect(fromRoot).toEqual({ status: 0, stdout: A_TEXT, stderr: '' });
    expect(explain(['a.test.ts'], join(repo, 'test'))).toEqual(fromRoot);
    const out = JSON.parse(explain(['a.test.ts', '--json'], join(repo, 'test')).stdout) as { base: { map: string } };
    expect(out.base.map).toBe('.trommel/map/map.smap');
  });

  it('takes an absolute path, through a link to the repository too', () => {
    const fromRoot = explain(['test/a.test.ts']);
    // On a Windows runner the temporary directory is under a short name (RUNNER~1), so this path is too.
    expect(explain([join(repo, 'test', 'a.test.ts')])).toEqual(fromRoot);
    // A junction on Windows, which needs no privilege; a symlink elsewhere.
    const outside = mkdtempSync(join(tmpdir(), 'trommel-cli-link-'));
    const link = join(outside, 'repo');
    symlinkSync(repo, link, 'junction');
    try {
      expect(explain([join(link, 'test', 'a.test.ts')])).toEqual(fromRoot);
    } finally {
      unlinkSync(link);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('takes backslashes on Windows', () => {
    expect(explain(['test\\a.test.ts']).stdout).toBe(A_TEXT);
  });

  it('exits 1 for a path outside the repository', () => {
    const run = explain(['../outside.test.ts']);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('../outside.test.ts is outside the repository');
  });

  it('exits 1 for a file Trommel does not plan', () => {
    const run = explain(['src/a.ts']);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('trommel: src/a.ts is not a test file Trommel plans at HEAD; it plans 2 test files\n');
  });

  it('exits 2 without a test', () => {
    const run = explain([]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('explain takes one test file: trommel explain <test>');
  });
});

describe('trommel usage errors', () => {
  it('refuses --mode safe with --static (kickoff gap 1)', () => {
    const run = trommel(['plan', '--mode', 'safe', '--static', '--map', '.trommel/map']);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/unproven static reachability/);
    expect(run.stdout).toBe('');
  });

  it('exits 2 on an unknown command, and prints help', () => {
    expect(trommel(['frob']).status).toBe(2);
    const help = trommel(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('plan --mode shadow --static');
  });

  it('exits 1 on a revision that does not exist', () => {
    const run = trommel(['graph', '--rev', 'no-such-rev']);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/trommel: /);
  });
});

describe('trommel diff over other lockfiles', () => {
  const PNPM = (zod: string): string =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      zod:\n        specifier: 3.24.3\n        version: 3.24.3\n\npackages:\n\n  zod@3.24.3:\n    resolution: {integrity: ${zod}}\n\nsnapshots:\n\n  zod@3.24.3: {}\n`;
  const inFreshRepo = (body: () => void): void => {
    const outer = repo;
    repo = mkdtempSync(join(tmpdir(), 'trommel-cli-diff-'));
    try {
      git('init', '-q');
      body();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      repo = outer;
    }
  };

  it('diff between two pnpm commits lists the changed packages', () => {
    inFreshRepo(() => {
      const one = commit({ 'package.json': '{"name":"demo"}\n', 'pnpm-lock.yaml': PNPM('sha512-one') });
      const two = commit({ 'pnpm-lock.yaml': PNPM('sha512-two') });
      const run = trommel(['diff', one, two]);
      expect(run.status).toBe(0);
      expect((JSON.parse(run.stdout) as { packages: unknown }).packages).toEqual({
        before: 'pnpm-lock.yaml',
        after: 'pnpm-lock.yaml',
        added: [],
        changed: ['p:pnpm:zod@3.24.3'],
        removed: [],
      });
    });
  });

  it('diff between lockfile kinds says so', () => {
    inFreshRepo(() => {
      const one = commit({ 'package.json': '{"name":"demo"}\n', 'package-lock.json': LOCK });
      rmSync(join(repo, 'package-lock.json'));
      const two = commit({ 'pnpm-lock.yaml': PNPM('sha512-one') });
      const run = trommel(['diff', one, two]);
      expect(run.status).toBe(0);
      expect((JSON.parse(run.stdout) as { packages: unknown }).packages).toEqual({
        before: 'npm package-lock.json',
        after: 'pnpm pnpm-lock.yaml',
        unknown: 'package changes are only computed between two lockfiles of one kind',
      });
    });
  });
});
