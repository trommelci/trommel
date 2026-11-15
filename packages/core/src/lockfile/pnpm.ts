// The pnpm reader: a pnpm-lock.yaml of format 9.0, in either shape (one document, or pnpm 12's
// two), into the resolved model (spec 2026-11-15-pnpm-yarn-lockfiles §7.2). It reads the
// importers, the `resolution` of each `packages` entry and the dependency maps of each snapshot,
// and reads past every other key. A lockfile that breaks its own format's invariants is refused
// (§6.5); a reference the lockfile does not resolve takes the name node. Only a YamlError is
// turned into a refusal: any other error would be a bug in this reader, not an input.

import { joinPath } from '../resolve/resolver.ts';
import type { ModelEntry, Ref, ResolvedModel } from './model.ts';
import { modelProblem, nameOfId } from './model.ts';
import type { Unparseable } from './npm.ts';
import { parseYamlSubset, YamlError } from './yaml.ts';
import type { YamlMap, YamlValue } from './yaml.ts';

const FIRST_KEYS: ReadonlySet<string> = new Set(['lockfileVersion', 'importers', 'packages', 'snapshots']);
const FIRST_ROOT_KEYS: ReadonlySet<string> = new Set(['configDependencies', 'packageManagerDependencies']);
const IMPORTER_FIELDS: readonly string[] = ['dependencies', 'optionalDependencies', 'devDependencies'];
const SNAPSHOT_FIELDS: readonly string[] = ['dependencies', 'optionalDependencies'];
/** A value that starts with a package name and `@` is an alias: the value is the whole id. */
const ALIAS = /^(?:@[^/@()\s:]+\/)?[^/@()\s:]+@/;

class Refusal extends Error {}

/** `instanceof Map` does not narrow a ReadonlyMap. */
function isMap(value: YamlValue | undefined): value is YamlMap {
  return value instanceof Map;
}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

export function parsePnpmLockfile(text: string): ResolvedModel | Unparseable {
  try {
    return read(text);
  } catch (error) {
    if (error instanceof YamlError || error instanceof Refusal) {
      return { kind: 'unparseable', format: 'pnpm', reason: error.message };
    }
    throw error;
  }
}

function read(text: string): ResolvedModel {
  const documents = parseYamlSubset(text);
  if (documents.length > 2) {
    refuse(`${documents.length} documents: pnpm writes one, or two with its own first`);
  }
  const project = documents[documents.length - 1]!;
  let env: unknown = null;
  if (documents.length === 2) {
    const first = documents[0]!;
    checkFirstDocument(first);
    checkVersion(first);
    env = toPlain(first);
  }
  checkVersion(project);

  const snapshots = mapOf(project.get('snapshots'), 'snapshots');
  const packages = mapOf(project.get('packages'), 'packages');
  const importersValue = project.get('importers');
  if (importersValue === undefined) {
    refuse('no importers key');
  }

  const importers = new Map<string, ReadonlyMap<string, Ref>>();
  for (const [key, value] of mapOf(importersValue, 'importers')) {
    const dir = key === '.' ? '' : key;
    if (importers.has(dir)) {
      refuse(`the importer ${JSON.stringify(key)} appears twice`);
    }
    importers.set(dir, declared(mapOf(value, `importer ${key}`), IMPORTER_FIELDS, `importer ${key}`, (name, version) => reference(dir, name, version, snapshots)));
  }

  const entries = new Map<string, ModelEntry>();
  for (const [id, value] of snapshots) {
    const name = nameOfId(id);
    const paren = id.indexOf('(', name.length + 1);
    const base = paren < 0 ? id : id.slice(0, paren);
    const pack = packages.get(base);
    if (pack === undefined) {
      refuse(`the snapshot ${JSON.stringify(id)} has no packages entry ${JSON.stringify(base)}`);
    }
    const resolution = isMap(pack) ? pack.get('resolution') : undefined;
    if (!isMap(resolution)) {
      refuse(`the packages entry ${JSON.stringify(base)} has no resolution mapping`);
    }
    const dependencies = declared(mapOf(value, `snapshot ${id}`), SNAPSHOT_FIELDS, `snapshot ${id}`, (depName, version) =>
      version.startsWith('link:') ? link('', version.slice(5)) : reference('', depName, version, snapshots),
    );
    entries.set(id, { name, content: toPlain(resolution), dependencies, peers: [] });
  }

  const model: ResolvedModel = { importers, entries, env };
  const problem = modelProblem(model);
  if (problem !== null) {
    refuse(problem);
  }
  return model;
}

/** pnpm's own document: only its four keys, and nothing but config dependencies in the root importer. */
function checkFirstDocument(first: YamlMap): void {
  for (const key of first.keys()) {
    if (!FIRST_KEYS.has(key)) {
      refuse(`the first document holds ${JSON.stringify(key)}, so it is not pnpm's own`);
    }
  }
  const root = mapOf(first.get('importers'), 'importers').get('.');
  for (const key of mapOf(root, 'importer .').keys()) {
    if (!FIRST_ROOT_KEYS.has(key)) {
      refuse(`the first document's importer . holds ${JSON.stringify(key)}, so it is not pnpm's own`);
    }
  }
}

function checkVersion(document: YamlMap): void {
  const version = document.get('lockfileVersion');
  if (version !== '9.0') {
    refuse(`lockfileVersion ${typeof version === 'string' ? JSON.stringify(version) : 'is missing or not a string'}, and only '9.0' is read`);
  }
}

/** A value that must be a mapping: a key with nothing under it is an empty one, and an absent key too. */
function mapOf(value: YamlValue | undefined, what: string): YamlMap {
  if (value === undefined || value === '') {
    return new Map();
  }
  if (isMap(value)) {
    return value;
  }
  return refuse(`${what} is not a mapping`);
}

/** The names a map's dependency fields declare, each with its `version`, resolved by `resolve`. */
function declared(owner: YamlMap, fields: readonly string[], what: string, resolve: (name: string, version: string) => Ref): Map<string, Ref> {
  const refs = new Map<string, Ref>();
  for (const field of fields) {
    for (const [name, value] of mapOf(owner.get(field), `${what}: ${field}`)) {
      // An importer's dependency is { specifier, version }; a snapshot's is the version itself.
      const version = isMap(value) ? value.get('version') : value;
      if (typeof version !== 'string' || version === '') {
        refuse(`${what}: ${JSON.stringify(name)} has no version`);
      }
      const ref = resolve(name, version);
      const before = refs.get(name);
      if (before !== undefined && JSON.stringify(before) !== JSON.stringify(ref)) {
        refuse(`${what}: ${JSON.stringify(name)} is declared twice, with different versions`);
      }
      refs.set(name, ref);
    }
  }
  return refs;
}

/** A `version` of an importer's dependency: a link, or the id of a snapshot, or unresolved. */
function reference(dir: string, name: string, version: string, snapshots: YamlMap): Ref {
  if (version.startsWith('link:')) {
    return link(dir, version.slice(5));
  }
  const id = ALIAS.test(version) ? version : `${name}@${version}`;
  return snapshots.has(id) ? { kind: 'entry', id } : { kind: 'unresolved' };
}

/** A workspace package at `rel` from `dir`; one that leaves the repository is unresolved. */
function link(dir: string, rel: string): Ref {
  const target = joinPath(dir, rel);
  return target === null ? { kind: 'unresolved' } : { kind: 'link', dir: target };
}

/** Maps become plain objects with sorted keys, arrays stay arrays. Iterative: the depth is the input's. */
function toPlain(root: YamlValue): unknown {
  if (typeof root === 'string') {
    return root;
  }
  const make = (value: YamlValue): unknown => (typeof value === 'string' ? value : isMap(value) ? {} : new Array<unknown>(value.length));
  const top = make(root);
  const work: [YamlValue, unknown][] = [[root, top]];
  while (work.length > 0) {
    const [value, target] = work.pop()!;
    if (typeof value === 'string') {
      continue;
    }
    if (isMap(value)) {
      for (const [key, child] of [...value].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const plain = make(child);
        // defineProperty, so that a key named __proto__ is data and not the prototype.
        Object.defineProperty(target, key, { value: plain, enumerable: true, writable: true, configurable: true });
        work.push([child, plain]);
      }
    } else {
      value.forEach((child, i) => {
        const plain = make(child);
        (target as unknown[])[i] = plain;
        work.push([child, plain]);
      });
    }
  }
  return top;
}
