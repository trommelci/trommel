import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Explanation, TrommelMap } from '@trommel/core';
import { afterAll, describe, expect, it } from 'vitest';

import { explanationText, repoPath, targetNode } from '../src/explain.ts';

const FOOTER = 'Shadow mode runs every test; this is what static selection would do.\n';

describe('explanationText', () => {
  it('lists each seed of an affected test, with an uncertain node by its causes', () => {
    const explanation: Explanation = {
      test: 'test/a.test.ts',
      verdict: 'affected',
      path: ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts'],
      seeds: [
        { node: 'f:src/b.ts', path: ['f:test/a.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b', 'f:src/b.ts'] },
        { node: 'u:src/d.ts', path: ['f:test/a.test.ts', 'u:src/d.ts'], causes: ['dynamic import', 'fs read'] },
      ],
      dependsOn: 3,
    };
    expect(explanationText(explanation)).toBe(
      'test/a.test.ts would run: it reaches 2 changed or uncertain nodes.\n' +
        '  test/a.test.ts → src/a.ts → src/b.ts (changed)\n' +
        '  test/a.test.ts → uncertain: dynamic import; fs read\n' +
        FOOTER,
    );
  });

  it('says node, not nodes, for one seed', () => {
    const explanation: Explanation = { test: 't.test.ts', verdict: 'affected', seeds: [{ node: 'f:a.ts', path: ['f:t.test.ts', 'f:a.ts'] }] };
    expect(explanationText(explanation)).toBe(`t.test.ts would run: it reaches 1 changed or uncertain node.\n  t.test.ts → a.ts (changed)\n${FOOTER}`);
  });

  it('shows a hub at the end of a path as the resolution of a file', () => {
    const explanation: Explanation = { test: 't.test.ts', verdict: 'affected', seeds: [{ node: 'r:src/b', path: ['f:t.test.ts', 'r:src/a', 'f:src/a.ts', 'r:src/b'] }] };
    expect(explanationText(explanation)).toContain('  t.test.ts → src/a.ts → resolution of src/b (changed)\n');
  });

  it('gives a forced test its reason, and the way into an escalated package', () => {
    expect(explanationText({ test: 't.test.ts', verdict: 'forced', reason: 'new test file', path: ['f:t.test.ts'] })).toBe(`t.test.ts would run: new test file.\n${FOOTER}`);
    expect(explanationText({ test: 't.test.ts', verdict: 'forced', reason: 'alwaysRun' })).toBe(`t.test.ts would run: alwaysRun.\n${FOOTER}`);
    expect(
      explanationText({ test: 't.test.ts', verdict: 'forced', reason: 'L1: lockfile changed', path: ['f:t.test.ts', 'r:src/a', 'f:src/a.ts', 'p:npm:node_modules/lodash'] }),
    ).toBe(`t.test.ts would run: L1: lockfile changed.\n  through src/a.ts → p:npm:node_modules/lodash\n${FOOTER}`);
  });

  it('says a would-skip is unproven, and counts what the test depends on', () => {
    const text = (dependsOn: number | undefined): string => explanationText({ test: 't.test.ts', verdict: 'would-skip', ...(dependsOn === undefined ? {} : { dependsOn }) });
    expect(text(4)).toBe(`t.test.ts would be skipped (unproven static reachability): none of the 4 nodes it depends on changed.\n${FOOTER}`);
    expect(text(1)).toContain('none of the 1 node it depends on changed.');
  });

  const to = (target: NonNullable<Explanation['to']>): string => explanationText({ test: 't.test.ts', verdict: 'would-skip', dependsOn: 2, to: target });

  it('puts the --to line after the verdict and before the footer', () => {
    expect(to({ node: 'f:src/b.ts', status: 'reached', path: ['f:t.test.ts', 'r:src/a', 'f:src/a.ts', 'f:src/b.ts'] })).toBe(
      't.test.ts would be skipped (unproven static reachability): none of the 2 nodes it depends on changed.\n' +
        'Path to src/b.ts: t.test.ts → src/a.ts → src/b.ts\n' +
        FOOTER,
    );
  });

  it.each<[NonNullable<Explanation['to']>, string]>([
    [{ node: 'f:src/b.ts', status: 'not reached' }, 't.test.ts does not reach src/b.ts in the map. Static reachability cannot see what a test reads through fs.'],
    [{ node: 'f:src/zzz.ts', status: 'not in the map' }, 'src/zzz.ts is not in the map.'],
    [{ node: 'f:src/b.ts', status: 'test not in the map' }, 't.test.ts is not in the map, so it has no path to src/b.ts.'],
    [{ node: 'f:src/b.ts', status: 'no map' }, 'Without a usable map, the path to src/b.ts is unknown.'],
  ])('renders the --to status %#', (target, line) => {
    expect(to(target)).toContain(`\n${line}\n${FOOTER}`);
  });
});

describe('targetNode', () => {
  const map = { nodes: { 'f:src/b.ts': {}, 'p:npm:node_modules/lodash': {}, 'src/odd': {} } } as unknown as TrommelMap;
  const path = (): string => 'src/b.ts';

  it('takes an exact map key as it is, and anything else as a file', () => {
    expect(targetNode('p:npm:node_modules/lodash', path, map)).toBe('p:npm:node_modules/lodash');
    expect(targetNode('src/odd', path, map)).toBe('src/odd');
    expect(targetNode('src/b.ts', path, map)).toBe('f:src/b.ts');
  });

  const never = (): string => {
    throw new Error('resolved');
  };

  it('takes a key-shaped value as a key, with no map or a map lacking it, without resolving a path', () => {
    for (const key of ['p:npm:node_modules/lodash', 'u:src/x.ts', 'f:src/b.ts', 'r:src/b', 'c:']) {
      expect(targetNode(key, never, null)).toBe(key);
      expect(targetNode(key, never, { nodes: {} } as unknown as TrommelMap)).toBe(key);
    }
    expect(targetNode('f:src/b.ts', never, map)).toBe('f:src/b.ts');
  });

  it('keeps Windows drive paths and plain files as paths', () => {
    for (const arg of ['c:/x', 'C:\\x', 'src/b.ts']) {
      expect(targetNode(arg, path, null)).toBe('f:src/b.ts');
    }
  });
});

describe('repoPath', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'trommel-explain-')));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'a.test.ts'), '');
  // A link to the repository from outside it, as a short name or a symlinked $TMPDIR gives: a junction
  // on Windows, which needs no privilege, and a symlink elsewhere (the type is ignored there).
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'trommel-explain-link-')));
  const link = join(outside, 'repo');
  symlinkSync(root, link, 'junction');
  afterAll(() => {
    unlinkSync(link);
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves against the current directory, as a POSIX path from the root', () => {
    expect(repoPath(root, root, 'test/a.test.ts')).toBe('test/a.test.ts');
    expect(repoPath(root, join(root, 'test'), 'a.test.ts')).toBe('test/a.test.ts');
    expect(repoPath(root, join(root, 'test'), '../test/./a.test.ts')).toBe('test/a.test.ts');
    expect(repoPath(root, root, join(root, 'test', 'a.test.ts'))).toBe('test/a.test.ts');
  });

  it.each(['../x.test.ts', '.', '', 'test/../..'])('refuses %j as outside the repository', (arg) => {
    expect(() => repoPath(root, root, arg)).toThrow(new Error(`${arg} is outside the repository`));
  });

  it('takes an absolute path through a link to the repository as the path inside it', () => {
    expect(repoPath(root, root, join(link, 'test', 'a.test.ts'))).toBe('test/a.test.ts');
    expect(repoPath(root, join(link, 'test'), 'a.test.ts')).toBe('test/a.test.ts');
    expect(repoPath(link, root, join(root, 'test', 'a.test.ts'))).toBe('test/a.test.ts');
  });

  it('resolves a file absent from the work tree, under directories absent too', () => {
    expect(repoPath(root, root, join(link, 'test', 'gone.test.ts'))).toBe('test/gone.test.ts');
    expect(repoPath(root, root, join(link, 'new', 'deeper', 'x.test.ts'))).toBe('new/deeper/x.test.ts');
  });

  it('keeps a link inside the repository as typed', () => {
    symlinkSync(join(root, 'test'), join(root, 'lib'), 'junction');
    try {
      expect(repoPath(root, root, join(link, 'lib', 'a.test.ts'))).toBe('lib/a.test.ts');
      expect(repoPath(root, root, 'lib/a.test.ts')).toBe('lib/a.test.ts');
    } finally {
      unlinkSync(join(root, 'lib'));
    }
  });

  it('still refuses a path outside, through the link or not', () => {
    for (const arg of [join(link, '..', 'x.test.ts'), join(outside, 'x.test.ts'), link]) {
      expect(() => repoPath(root, root, arg)).toThrow(new Error(`${arg} is outside the repository`));
    }
  });
});
