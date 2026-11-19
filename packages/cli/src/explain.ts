// What `trommel explain` needs beside the plan: the argument as a repository path, the --to value as
// a map node, and the text a person reads. The decision itself comes from `explainTest` in core.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { Explanation, TrommelMap } from '@trommel/core';

import { readable, shown } from './report.ts';

/**
 * `arg` (relative to the current directory, or absolute) as a POSIX path from the repository root.
 * Both ends go through realpath, so a short (8.3) Windows name or a symlinked temp directory cannot
 * make a file inside the repository look outside it.
 */
export function repoPath(root: string, cwd: string, arg: string): string {
  const path = relative(realpathSync.native(root), resolve(realpathSync.native(cwd), arg));
  const parts = path.split(sep);
  if (path === '' || isAbsolute(path) || parts[0] === '..') {
    throw new Error(`${arg} is outside the repository`);
  }
  return parts.join('/');
}

/** The --to value as a node key: an exact key of the map, else the file of that path. */
export function targetNode(arg: string, path: () => string, map: TrommelMap | null): string {
  return map !== null && Object.hasOwn(map.nodes, arg) ? arg : `f:${path()}`;
}

const FOOTER = 'Shadow mode runs every test; this is what static selection would do.';

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
      case 'not reached':
        lines.push(`${test} does not reach ${to} in the map. Static reachability cannot see what a test reads through fs.`);
        break;
      case 'not in the map':
        lines.push(`${to} is not in the map.`);
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
