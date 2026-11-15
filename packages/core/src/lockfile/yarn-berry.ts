// The yarn Berry reader: a yarn.lock of __metadata version 8 or 10 into the resolved model
// (spec 2026-11-15-pnpm-yarn-lockfiles §7.3). A key lists the descriptors (`name@range`) one entry
// answers; an entry is identified by its `resolution`. A workspace entry is an importer, not an
// entry, and a dependency on one is a link. A descriptor no key holds (yarn's own redirects, such
// as a range its resolution rewrote) is unresolved and takes the name node (§6.5). Everything but
// `resolution`, `checksum`, `dependencies` and `peerDependencies` is read past; `cacheKey` is part
// of every checksum already. Only a YamlError is turned into a refusal: any other error would be a
// bug in this reader, not an input.

import type { ModelEntry, Ref, ResolvedModel } from './model.ts';
import { modelProblem, nameOfId } from './model.ts';
import type { Unparseable } from './npm.ts';
import { parseYamlSubset, YamlError } from './yaml.ts';
import type { YamlMap, YamlValue } from './yaml.ts';

const WORKSPACE = /^(.+)@workspace:(.*)$/;
const VERSIONS: ReadonlySet<string> = new Set(['8', '10']);

class Refusal extends Error {}

/** `instanceof Map` does not narrow a ReadonlyMap. */
function isMap(value: YamlValue | undefined): value is YamlMap {
  return value instanceof Map;
}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

export function parseYarnBerryLockfile(text: string): ResolvedModel | Unparseable {
  try {
    return read(text);
  } catch (error) {
    if (error instanceof YamlError || error instanceof Refusal) {
      return { kind: 'unparseable', format: 'yarn', reason: error.message };
    }
    throw error;
  }
}

/** What a descriptor stands for: an entry's id, or a workspace's directory. */
type Target = { readonly kind: 'entry'; readonly id: string } | { readonly kind: 'link'; readonly dir: string };

interface Block {
  readonly key: string;
  readonly value: YamlMap;
  readonly resolution: string;
  readonly workspace: string | null;
}

function read(text: string): ResolvedModel {
  const documents = parseYamlSubset(text);
  if (documents.length !== 1) {
    refuse(`${documents.length} documents: a Berry lockfile is exactly one`);
  }
  const document = documents[0]!;
  const metadata = document.get('__metadata');
  if (!isMap(metadata)) {
    refuse('no __metadata mapping');
  }
  const version = metadata.get('version');
  if (typeof version !== 'string' || !VERSIONS.has(version)) {
    refuse(`__metadata version ${typeof version === 'string' ? JSON.stringify(version) : 'is missing or not a string'}, and only '8' and '10' are read`);
  }

  const blocks: Block[] = [];
  const targets = new Map<string, Target>();
  const resolutions = new Set<string>();
  for (const [key, value] of document) {
    if (key === '__metadata') {
      continue;
    }
    if (!isMap(value)) {
      refuse(`the value of ${JSON.stringify(key)} is not a map`);
    }
    const resolution = value.get('resolution');
    if (typeof resolution !== 'string' || resolution === '') {
      refuse(`the entry ${JSON.stringify(key)} has no resolution`);
    }
    if (resolutions.has(resolution)) {
      refuse(`the resolution ${JSON.stringify(resolution)} appears in two entries`);
    }
    resolutions.add(resolution);
    const match = WORKSPACE.exec(resolution);
    const workspace = match === null ? null : match[2] === '.' ? '' : match[2]!;
    const target: Target = workspace === null ? { kind: 'entry', id: resolution } : { kind: 'link', dir: workspace };
    for (const descriptor of key.split(', ')) {
      if (targets.has(descriptor)) {
        refuse(`the descriptor ${JSON.stringify(descriptor)} appears in two keys`);
      }
      targets.set(descriptor, target);
    }
    blocks.push({ key, value, resolution, workspace });
  }

  const importers = new Map<string, ReadonlyMap<string, Ref>>();
  const entries = new Map<string, ModelEntry>();
  for (const { key, value, resolution, workspace } of blocks) {
    const dependencies = new Map<string, Ref>();
    for (const [name, range] of mapOf(value.get('dependencies'), key, 'dependencies')) {
      if (typeof range !== 'string') {
        refuse(`${JSON.stringify(key)}: the range of ${JSON.stringify(name)} is not a string`);
      }
      const target = targets.get(`${name}@${range}`);
      dependencies.set(name, target ?? { kind: 'unresolved' });
    }
    if (workspace !== null) {
      if (importers.has(workspace)) {
        refuse(`the workspace ${JSON.stringify(workspace)} appears twice`);
      }
      importers.set(workspace, dependencies);
      continue;
    }
    const checksum = value.get('checksum');
    entries.set(resolution, {
      name: nameOfId(resolution),
      content: { resolution, checksum: typeof checksum === 'string' ? checksum : null },
      dependencies,
      peers: [...mapOf(value.get('peerDependencies'), key, 'peerDependencies').keys()],
    });
  }

  const model: ResolvedModel = { importers, entries, env: null };
  const problem = modelProblem(model);
  if (problem !== null) {
    refuse(problem);
  }
  return model;
}

/** A value that must be a map: a key with nothing under it is an empty one, and an absent key too. */
function mapOf(value: YamlValue | undefined, key: string, field: string): YamlMap {
  if (value === undefined || value === '') {
    return new Map();
  }
  if (isMap(value)) {
    return value;
  }
  return refuse(`${JSON.stringify(key)}: ${field} is not a map`);
}
