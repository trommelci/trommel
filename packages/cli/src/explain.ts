// What `trommel explain` needs beside the plan: the argument as a repository path, the --to value as
// a map node, and the text a person reads. The decision itself comes from `explainTest` in core.
import { realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import type { Explanation, TrommelMap } from '@trommel/core';

import { readable, shown } from './report.ts';

/**
 * `arg` (relative to the current directory, or absolute) as a POSIX path from the repository root.
 * `arg` is resolved lexically, then its ancestors, nearest first, are compared with the root through
 * realpath: the first that exists and is the root ends the walk, and the rest of the path, as typed,
 * is the answer. So a short (8.3) Windows name, a symlinked temp directory or a link to the
 * repository cannot make a file inside it look outside it, a link inside the repository stays as
 * typed, and the file need not exist in the work tree.
 */
export function repoPath(root: string, cwd: string, arg: string): string {
  const real = realpathSync.native(root);
  const path = resolve(cwd, arg);
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    if (realOrNull(ancestor) === real) {
      const below = relative(ancestor, path);
      if (below === '') {
        break;
      }
      return below.split(sep).join('/');
    }
    if (dirname(ancestor) === ancestor) {
      break;
    }
  }
  throw new Error(`${arg} is outside the repository`);
}

/** The real path of `path`, or null when it does not exist (or cannot be read). */
function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * The --to value as a node key: an exact key of the map, or anything shaped like a key (a node
 * prefix not followed by a slash or backslash, so a Windows drive path like `C:\x` stays a path),
 * with or without a map; else the file of that path.
 */
export function targetNode(arg: string, path: () => string, map: TrommelMap | null): string {
  return (map !== null && Object.hasOwn(map.nodes, arg)) || /^[cdfgpru]:(?![\\/])/.test(arg) ? arg : `f:${path()}`;
}

const FOOTER = 'Shadow mode runs every test; this is what static selection would do.';
const UNSEEN = 'Static reachability cannot see what a test reads through fs.';

export function explanationText(explanation: Explanation): string {
  const { test } = explanation;
  const lines: string[] = [];
  switch (explanation.verdict) {
    case 'affected': {
      const seeds = explanation.seeds ?? [];
      lines.push(`${test} would run: it reaches ${seeds.length} changed or uncertain ${seeds.length === 1 ? 'node' : 'nodes'}.`);
      for (const seed of seeds) {
        const steps = readable(seed.path).map(plain);
        steps[steps.length - 1] = seed.node.startsWith('u:') ? `uncertain: ${(seed.causes ?? []).join('; ')}` : `${steps.at(-1)} (changed)`;
        lines.push(`  ${steps.join(' → ')}`);
      }
      break;
    }
    case 'forced': {
      lines.push(`${test} would run: ${explanation.reason}.`);
      const path = explanation.path ?? [];
      if (path.length >= 2) {
        lines.push(`  through ${route(readable(path).slice(1))}`);
      }
      break;
    }
    case 'would-skip': {
      const n = explanation.dependsOn ?? 0;
      lines.push(`${test} would be skipped (unproven static reachability): none of the ${n} ${n === 1 ? 'node' : 'nodes'} it depends on changed.`);
      break;
    }
  }
  if (explanation.to !== undefined) {
    const to = plain(explanation.to.node);
    switch (explanation.to.status) {
      case 'reached':
        lines.push(`Path to ${to}: ${route(readable(explanation.to.path))}`);
        break;
      // Neither is proof of independence: the test may still read the file through fs.
      case 'not reached':
        lines.push(`${test} does not reach ${to} in the map. ${UNSEEN}`);
        break;
      case 'not in the map':
        lines.push(`${to} is not in the map. ${UNSEEN}`);
        break;
      case 'test not in the map':
        lines.push(`${test} is not in the map, so it has no path to ${to}.`);
        break;
      case 'no map':
        lines.push(`Without a usable map, the path to ${to} is unknown.`);
        break;
    }
  }
  lines.push(FOOTER);
  return `${lines.join('\n')}\n`;
}

function plain(node: string): string {
  return shown(node, '');
}

function route(path: readonly string[]): string {
  return path.map(plain).join(' → ');
}
