// The classic yarn reader: a yarn.lock "v1" into the resolved model (spec
// 2026-11-15-pnpm-yarn-lockfiles §7.4). The format is not YAML, so this has its own line reader. An
// entry line lists the descriptors (`name@range`) one entry answers; the entry is identified by
// `<name>@<version>`. The lockfile does not say which packages are workspaces, so the caller passes
// the workspace's declarations: a descriptor no entry holds that names a workspace package is a link,
// and any other is unresolved and takes the name node (§6.5). Anything off the shapes below is a
// refusal that names its line: nothing is guessed. The reader never throws anything but a Refusal.

import type { ModelEntry, Ref, ResolvedModel } from './model.ts';
import { modelProblem } from './model.ts';
import type { Unparseable } from './npm.ts';

export interface ClassicWorkspace {
  /** Importer directory ('' for the root) → name → range, from dependencies, devDependencies and optionalDependencies of its package.json. */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Workspace package name → its directory. */
  readonly packages: ReadonlyMap<string, string>;
}

const HEADER = '# yarn lockfile v1';
const BLOCKS: ReadonlySet<string> = new Set(['dependencies', 'optionalDependencies']);

class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

export function parseYarnClassicLockfile(text: string, workspace: ClassicWorkspace): ResolvedModel | Unparseable {
  try {
    return read(text, workspace);
  } catch (error) {
    if (error instanceof Refusal) {
      return { kind: 'unparseable', format: 'yarn', reason: error.message };
    }
    throw error;
  }
}

interface Block {
  readonly descriptors: readonly string[];
  readonly name: string;
  readonly version: string;
  readonly content: { readonly integrity: string } | { readonly resolved: string };
  /** name → range, in file order. */
  /** name → the ranges listed for it (more than one when both dependency fields list it). */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
}

/** A token at `at`: a double-quoted JSON string, or bare up to the next space. Returns it and where it ended. */
function token(line: string, at: number, number: number): [string, number] {
  if (line[at] === '"') {
    let end = at + 1;
    while (end < line.length && line[end] !== '"') {
      end += line[end] === '\\' ? 2 : 1;
    }
    if (end >= line.length) {
      return refuse(`line ${number}: an unterminated quoted string`);
    }
    try {
      const value: unknown = JSON.parse(line.slice(at, end + 1));
      if (typeof value === 'string') {
        return [value, end + 1];
      }
    } catch {
      // falls through to the refusal
    }
    return refuse(`line ${number}: a quoted string that is not a JSON string`);
  }
  const space = line.indexOf(' ', at);
  const end = space < 0 ? line.length : space;
  if (end === at) {
    return refuse(`line ${number}: an empty token`);
  }
  return [line.slice(at, end), end];
}

/** `key`, or `key value`: each bare or quoted, one space between, nothing after. */
function pair(line: string, at: number, number: number): [string, string | null] {
  const [key, afterKey] = token(line, at, number);
  if (afterKey === line.length) {
    return [key, null];
  }
  if (line[afterKey] !== ' ') {
    return refuse(`line ${number}: expected a space after ${JSON.stringify(key)}`);
  }
  const [value, afterValue] = token(line, afterKey + 1, number);
  if (afterValue !== line.length) {
    return refuse(`line ${number}: unexpected text after the value of ${JSON.stringify(key)}`);
  }
  return [key, value];
}

/** A two-space `key:` line, which opens a block: the key alone, with no value. */
function opener(line: string, number: number): [string, null] {
  const body = line.slice(0, -1);
  const [key, end] = token(body, 2, number);
  if (end !== body.length) {
    return refuse(`line ${number}: unexpected text before the ":"`);
  }
  return [key, null];
}

/** The name of a descriptor: what comes before the `@` that starts its range. */
function descriptorName(descriptor: string, number: number): string {
  const at = descriptor.startsWith('@') ? descriptor.indexOf('@', descriptor.indexOf('/') + 1) : descriptor.indexOf('@');
  if (descriptor.startsWith('@') && !descriptor.includes('/')) {
    return refuse(`line ${number}: the descriptor ${JSON.stringify(descriptor)} has no scoped name`);
  }
  if (at <= 0) {
    return refuse(`line ${number}: the descriptor ${JSON.stringify(descriptor)} has no @range`);
  }
  return descriptor.slice(0, at);
}

/** An entry under construction. */
interface Open {
  readonly line: number;
  readonly descriptors: string[];
  readonly name: string;
  readonly fields: Map<string, string>;
  readonly dependencies: Map<string, string[]>;
  /** The names listed in the block that is open. */
  readonly listed: Set<string>;
  readonly seen: Set<string>;
  block: 'dependencies' | 'optionalDependencies' | null;
}

function read(text: string, workspace: ClassicWorkspace): ResolvedModel {
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).split('\n');
  const blocks: Block[] = [];
  let header = false;
  let open: Open | null = null;

  const close = (): void => {
    if (open === null) {
      return;
    }
    const version = open.fields.get('version');
    if (version === undefined) {
      refuse(`line ${open.line}: the entry has no version`);
    }
    const integrity = open.fields.get('integrity');
    const resolved = open.fields.get('resolved');
    if (integrity === undefined && resolved === undefined) {
      refuse(`line ${open.line}: the entry has neither integrity nor resolved`);
    }
    blocks.push({
      descriptors: open.descriptors,
      name: open.name,
      version,
      content: integrity !== undefined ? { integrity } : { resolved: resolved! },
      dependencies: open.dependencies,
    });
    open = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const number = index + 1;
    let line = lines[index]!;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    if (line === '') {
      continue;
    }
    if (line.startsWith('#')) {
      if (line === HEADER && open === null && blocks.length === 0) {
        header = true;
      }
      continue;
    }
    if (!header) {
      refuse(`line ${number}: the comment block before the first entry does not hold "${HEADER}"`);
    }

    let indent = 0;
    while (line[indent] === ' ') {
      indent++;
    }
    if (indent === 0) {
      close();
      if (!line.endsWith(':')) {
        refuse(`line ${number}: expected an entry line ending in ":"`);
      }
      const descriptors: string[] = [];
      for (const part of line.slice(0, -1).split(', ')) {
        const [descriptor, end] = token(part, 0, number);
        if (end !== part.length) {
          refuse(`line ${number}: unexpected text after the descriptor ${JSON.stringify(descriptor)}`);
        }
        descriptors.push(descriptor);
      }
      const name = descriptorName(descriptors[0]!, number);
      for (const descriptor of descriptors) {
        if (descriptorName(descriptor, number) !== name) {
          refuse(`line ${number}: the descriptors of one entry name two packages (${JSON.stringify(name)} and ${JSON.stringify(descriptorName(descriptor, number))})`);
        }
      }
      open = { line: number, descriptors, name, fields: new Map(), dependencies: new Map(), listed: new Set(), seen: new Set(), block: null };
    } else if (open === null) {
      refuse(`line ${number}: an indented line outside an entry`);
    } else if (indent === 2) {
      // A block opens with `key:` and no value.
      const [key, value] = line.endsWith(':') ? opener(line, number) : pair(line, 2, number);
      if (open.seen.has(key)) {
        refuse(`line ${number}: the field ${JSON.stringify(key)} appears twice in one entry`);
      }
      open.seen.add(key);
      open.block = null;
      if (value === null) {
        if (!BLOCKS.has(key)) {
          refuse(`line ${number}: the block ${JSON.stringify(key)} is not one this reader knows`);
        }
        open.block = key as Open['block'];
        open.listed.clear();
      } else if (BLOCKS.has(key)) {
        refuse(`line ${number}: ${key} has a value, not lines`);
      } else {
        open.fields.set(key, value);
      }
    } else if (indent === 4 && open.block !== null) {
      const [name, range] = pair(line, 4, number);
      if (range === null) {
        refuse(`line ${number}: a dependency with no range`);
      }
      if (open.listed.has(name)) {
        refuse(`line ${number}: the dependency ${JSON.stringify(name)} appears twice in one block`);
      }
      open.listed.add(name);
      const ranges = open.dependencies.get(name);
      if (ranges === undefined) {
        open.dependencies.set(name, [range]);
      } else {
        ranges.push(range);
      }
    } else {
      refuse(`line ${number}: an indentation of ${indent} that this reader does not know`);
    }
  }
  close();
  if (!header) {
    refuse(`no "${HEADER}" line`);
  }

  const targets = new Map<string, string>();
  const ids = new Set<string>();
  for (const block of blocks) {
    const id = `${block.name}@${block.version}`;
    if (ids.has(id)) {
      refuse(`duplicate entry ${JSON.stringify(id)}`);
    }
    ids.add(id);
    for (const descriptor of block.descriptors) {
      if (targets.has(descriptor)) {
        refuse(`the descriptor ${JSON.stringify(descriptor)} appears in two entries`);
      }
      targets.set(descriptor, id);
    }
  }

  const resolve = (name: string, range: string): Ref => {
    const id = targets.get(`${name}@${range}`);
    if (id !== undefined) {
      return { kind: 'entry', id };
    }
    const dir = workspace.packages.get(name);
    return dir !== undefined ? { kind: 'link', dir } : { kind: 'unresolved' };
  };

  const importers = new Map<string, ReadonlyMap<string, Ref>>();
  for (const [dir, declared] of workspace.importers) {
    const refs = new Map<string, Ref>();
    for (const [name, range] of declared) {
      refs.set(name, resolve(name, range));
    }
    importers.set(dir, refs);
  }
  const entries = new Map<string, ModelEntry>();
  for (const block of blocks) {
    const dependencies = new Map<string, Ref>();
    for (const [name, ranges] of block.dependencies) {
      // dependencies and optionalDependencies may both list a name: they must agree on what it is.
      const [first, ...rest] = ranges.map((range) => resolve(name, range));
      for (const other of rest) {
        if (JSON.stringify(other) !== JSON.stringify(first)) {
          refuse(`${block.name}@${block.version}: ${JSON.stringify(name)} is listed twice, with different ranges that resolve differently`);
        }
      }
      dependencies.set(name, first!);
    }
    entries.set(`${block.name}@${block.version}`, { name: block.name, content: block.content, dependencies, peers: [] });
  }

  const model: ResolvedModel = { importers, entries, env: null };
  const problem = modelProblem(model);
  if (problem !== null) {
    refuse(problem);
  }
  return model;
}
