// The `trommel` commands. Everything is read from git objects at a revision (never the working
// tree). Commands print canonical JSON, so the same inputs give the same bytes, except `explain`,
// whose default output is text for a person (it is deterministic too, and --json gives the JSON).
// The map on disk is a SMAP file (ADR-0009, docs/smap-format.md), which has that property too.
//
// Exit codes: 0 success (a plan that fell back to running everything is a success: it must never
// block CI), 1 an error, 2 a usage error.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  buildStaticMap,
  canonicalJson,
  canonicalJsonPretty,
  decodeSmap,
  diffLockfiles,
  encodeSmap,
  explainTest,
  GitVfs,
  isLexed,
  lsTree,
  MapError,
  merkleDiff,
  readBlobs,
  readLockfile,
  readObjectFormat,
  repoRoot,
  runAll,
  selectStatic,
  TreeIndex,
  type LockfileState,
  type ObjectFormat,
  type Selection,
  type Smap,
} from '@trommel/core';

import { MAP_DIR, parseCommand, planMode, USAGE, UsageError, type Command } from './args.ts';
import { CONFIG_FILE, ConfigError, discoverTests, parseConfig, rulesOf, type TrommelConfig } from './config.ts';
import { explanationText, repoPath, targetNode } from './explain.ts';
import { buildReport, githubOutputs, summaryOf } from './report.ts';

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    return usage(error, io);
  }
  try {
    switch (command.name) {
      case 'help':
        io.stdout(USAGE);
        return 0;
      case 'version':
        io.stdout(`${version()}\n`);
        return 0;
      case 'graph':
        return await graph(command, io);
      case 'diff':
        return await diff(command, io);
      case 'explain':
        return await explain(command, io);
      case 'plan':
        return await plan(command, io);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      return usage(error, io);
    }
    io.stderr(`trommel: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function usage(error: unknown, io: Io): number {
  io.stderr(`trommel: ${(error as Error).message}\nRun trommel --help for usage.\n`);
  return 2;
}

function version(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

interface Snapshot {
  readonly root: string;
  readonly rev: string;
  readonly objectFormat: ObjectFormat;
  readonly index: TreeIndex;
  readonly vfs: GitVfs;
  /** trommel.config.json at this revision. */
  readonly config: { readonly oid: string; readonly text: string } | null;
}

async function snapshotAt(root: string, rev: string): Promise<Snapshot> {
  const [objectFormat, listing] = await Promise.all([readObjectFormat(root), lsTree(root, rev)]);
  const index = TreeIndex.build(listing);
  const vfs = await GitVfs.load(root, index);
  const oid = vfs.kind(CONFIG_FILE) === 'file' ? vfs.oid(CONFIG_FILE) : null;
  return { root, rev, objectFormat, index, vfs, config: oid === null ? null : { oid, text: vfs.read(CONFIG_FILE) ?? '' } };
}

function configOf(snapshot: Snapshot): TrommelConfig {
  return snapshot.config === null ? { version: 1 } : parseConfig(snapshot.config.text);
}

async function graph(command: Extract<Command, { name: 'graph' }>, io: Io): Promise<number> {
  const started = performance.now();
  const snapshot = await snapshotAt(await repoRoot(io.cwd), command.rev);
  const config = configOf(snapshot);
  const rules = rulesOf(config);
  const files = snapshot.vfs.files();
  const lexed = files.filter(isLexed);
  const blobs = await readBlobs(snapshot.root, lexed.map((path) => snapshot.vfs.oid(path)!));
  const sources = new Map(lexed.map((path) => [path, blobs.get(snapshot.vfs.oid(path)!)!]));
  const map = buildStaticMap({
    objectFormat: snapshot.objectFormat,
    index: snapshot.index,
    vfs: snapshot.vfs,
    sources,
    tests: discoverTests(files, config).tests,
    global: rules.global,
    declared: rules.declared,
    config: snapshot.config?.oid ?? null,
  });
  // The file is SMAP; without --out the same map is printed as canonical JSON, for a person to read.
  let written: string;
  if (command.out === null) {
    const text = `${canonicalJson(map)}\n`;
    io.stdout(text);
    written = `${text.length} bytes of JSON`;
  } else {
    const bytes = encodeSmap(map);
    const out = resolve(io.cwd, command.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    written = `${bytes.length} bytes of SMAP`;
  }
  const edges = Object.values(map.edges).reduce((sum, out) => sum + Object.keys(out).length, 0);
  io.stderr(
    `trommel graph: ${files.length} files, ${lexed.length} lexed; ${Object.keys(map.nodes).length} nodes, ${edges} edges; ` +
      `${map.tests.length} tests, ${Object.keys(map.uncertain).length} uncertain files; ${written} in ${Math.round(performance.now() - started)} ms\n`,
  );
  return 0;
}

async function diff(command: Extract<Command, { name: 'diff' }>, io: Io): Promise<number> {
  const root = await repoRoot(io.cwd);
  const [base, head] = await Promise.all([snapshotAt(root, command.base), snapshotAt(root, command.head)]);
  const delta = merkleDiff(base.index, head.index);
  const before = readLockfile(base.vfs);
  const after = readLockfile(head.vfs);
  const packages =
    before.kind === 'parsed' && after.kind === 'parsed' && before.lockfile.kind === after.lockfile.kind
      ? { before: before.lockfile.path, after: after.lockfile.path, ...diffLockfiles(before.lockfile, after.lockfile) }
      : { before: describe(before), after: describe(after), unknown: 'package changes are only computed between two lockfiles of one kind' };
  io.stdout(
    canonicalJsonPretty({
      base: { rev: command.base, rootTree: base.index.rootOid },
      head: { rev: command.head, rootTree: head.index.rootOid },
      files: delta.files,
      listings: delta.listings,
      packages,
    }),
  );
  return 0;
}

function describe(lockfile: LockfileState): string {
  return lockfile.kind === 'parsed' ? `${lockfile.lockfile.kind} ${lockfile.lockfile.path}` : lockfile.kind === 'unparseable' ? `${lockfile.paths.join(', ')} (unparseable: ${lockfile.reason})` : 'none';
}

interface Head {
  readonly snapshot: Snapshot;
  /** `{ version: 1 }` when the configuration is invalid. */
  readonly config: TrommelConfig;
  /** The configuration error, which makes the plan run everything. */
  readonly fallback?: string;
}

async function headAt(io: Io, rev: string): Promise<Head> {
  const snapshot = await snapshotAt(await repoRoot(io.cwd), rev);
  try {
    return { snapshot, config: configOf(snapshot) };
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    return { snapshot, config: { version: 1 }, fallback: error.message };
  }
}

interface PlanAt {
  readonly tests: readonly string[];
  readonly notPlanned: readonly string[];
  readonly mapPath: string;
  readonly smap: Smap | null;
  readonly selection: Selection;
  readonly fallback?: string;
}

/**
 * The static plan at `head` from the map in `mapDir`, resolved against the directory `from`; with no
 * usable map, every test, and why. Messages name the map as `mapDir` gives it.
 */
function planAt(io: Io, head: Head, mapDir: string, from: string): PlanAt {
  const { snapshot, config } = head;
  let fallback = head.fallback;
  const rules = rulesOf(config);
  const { tests, notPlanned } = discoverTests(snapshot.vfs.files(), config);
  const mapPath = `${mapDir.replace(/[\\/]+$/, '')}/map.smap`;

  let smap: Smap | null = null;
  if (fallback === undefined) {
    const read = readMap(mapPath, from);
    if (read.smap === null) {
      fallback = read.fallback;
    } else {
      smap = read.smap;
    }
  }
  let selection: Selection;
  if (smap === null) {
    selection = runAll(tests, fallback!);
  } else {
    try {
      const state = { objectFormat: snapshot.objectFormat, index: snapshot.index, vfs: snapshot.vfs, tests, config: snapshot.config?.oid ?? null };
      selection = selectStatic(smap.map, state, { ignore: rules.ignore, alwaysRun: rules.alwaysRun }, smap.graph);
    } catch (error) {
      // A bug must not block CI either: run everything and say why.
      io.stderr(`trommel: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      fallback = `internal error: ${error instanceof Error ? error.message : String(error)}`;
      selection = runAll(tests, fallback);
    }
  }
  return { tests, notPlanned, mapPath, smap, selection, ...(fallback === undefined ? {} : { fallback }) };
}

/** The map at `mapPath`, resolved against the directory `from`, or why there is no usable map. */
function readMap(mapPath: string, from: string): { readonly smap: Smap } | { readonly smap: null; readonly fallback: string } {
  try {
    return { smap: decodeSmap(readFileSync(resolve(from, mapPath))) };
  } catch (error) {
    if (error instanceof MapError) {
      return { smap: null, fallback: `the map at ${mapPath} is invalid: ${error.message}` };
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { smap: null, fallback: `no map at ${mapPath}` };
    }
    return { smap: null, fallback: `the map at ${mapPath} cannot be read: ${(error as Error).message}` };
  }
}

async function plan(command: Extract<Command, { name: 'plan' }>, io: Io): Promise<number> {
  const head = await headAt(io, command.head);
  planMode(command, head.fallback === undefined ? head.config.selection?.mode : undefined);
  const { notPlanned, mapPath, smap, selection, fallback } = planAt(io, head, command.map, io.cwd);

  const report = buildReport({
    selection,
    base: smap === null ? null : { map: mapPath, rootTree: smap.map.rootTree },
    head: { rev: command.head, rootTree: head.snapshot.index.rootOid },
    ...(smap === null ? {} : { uncertainCauses: smap.map.uncertain }),
    notPlanned,
    shards: command.shards ?? rulesOf(head.config).shards,
    ...(fallback === undefined ? {} : { fallback }),
  });
  io.stdout(canonicalJsonPretty(report));
  const outputs = io.env['GITHUB_OUTPUT'];
  if (outputs !== undefined && outputs !== '') {
    appendFileSync(outputs, githubOutputs(report));
  }
  const summary = io.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, summaryOf(report));
  }
  io.stderr(
    fallback === undefined
      ? `trommel plan: shadow mode runs all ${report.run.length} test files; static reachability would run ${report.wouldRun} and skip ${report.wouldSkip.length} (unproven)\n`
      : `trommel plan: running all ${report.run.length} test files: ${fallback}\n`,
  );
  return 0;
}

async function explain(command: Extract<Command, { name: 'explain' }>, io: Io): Promise<number> {
  const head = await headAt(io, command.head);
  const { root } = head.snapshot;
  // The static plan, whatever selection.mode says: explain never selects, it explains. The default
  // map is the repository's, wherever explain runs; a --map given is relative to the current directory.
  const [mapDir, from] = command.map === null ? [MAP_DIR, root] : [command.map, io.cwd];
  const { tests, mapPath, smap: planned, selection, fallback } = planAt(io, head, mapDir, from);
  // An invalid configuration plans everything without reading the map. The selection stays that
  // fallback, but the paths, --to's included, still come from the map when it decodes.
  const smap = planned ?? (head.fallback === undefined ? null : readMap(mapPath, from).smap);
  const test = repoPath(root, io.cwd, command.test);
  if (!selection.tests.includes(test)) {
    throw new Error(`${command.test} is not a test file Trommel plans at ${command.head}; it plans ${tests.length} test ${tests.length === 1 ? 'file' : 'files'}`);
  }
  const to = command.to === null ? undefined : targetNode(command.to, () => repoPath(root, io.cwd, command.to!), smap?.map ?? null);
  const explanation = explainTest(selection, test, smap === null ? null : { map: smap.map, graph: smap.graph }, to);
  if (command.json) {
    io.stdout(
      canonicalJsonPretty({
        version: 1,
        mode: 'shadow',
        static: true,
        base: smap === null ? null : { map: mapPath, rootTree: smap.map.rootTree },
        head: { rev: command.head, rootTree: head.snapshot.index.rootOid },
        ...(fallback === undefined ? {} : { fallback }),
        explanation,
      }),
    );
  } else {
    io.stdout(explanationText(explanation));
  }
  return 0;
}
