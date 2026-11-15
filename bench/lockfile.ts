#!/usr/bin/env node
// Lockfile reader time and counts on real lockfiles (spec 2026-11-15-pnpm-yarn-lockfiles §9.5). Correctness lives in the
// test suite; this only measures.
//
//   node bench/lockfile.ts <file> [file ...]
//
// The reader is picked by file name: *pnpm-lock.yaml is pnpm; *yarn.lock is classic yarn when its text holds
// "# yarn lockfile v1" (read with an empty workspace, so every workspace package is an ordinary entry or unresolved),
// else Berry. Prints canonical JSON; record results under bench/results/. Files are recorded by base name.
import { readFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { basename } from 'node:path';

import { canonicalJsonPretty, parsePnpmLockfile, parseYarnBerryLockfile, parseYarnClassicLockfile } from '@trommel/core';
import type { Ref, ResolvedModel } from '@trommel/core';

const RUNS = 5;
const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: node bench/lockfile.ts <file> [file ...]\n');
  process.exit(2);
}

function read(name: string, text: string): ReturnType<typeof parsePnpmLockfile> {
  if (name.endsWith('pnpm-lock.yaml')) return parsePnpmLockfile(text);
  if (name.endsWith('yarn.lock')) {
    return text.includes('# yarn lockfile v1') ? parseYarnClassicLockfile(text, { importers: new Map(), packages: new Map() }) : parseYarnBerryLockfile(text);
  }
  throw new Error(`no reader for ${name}`);
}

function readerOf(name: string, text: string): string {
  if (name.endsWith('pnpm-lock.yaml')) return 'pnpm';
  return text.includes('# yarn lockfile v1') ? 'yarn-classic' : 'yarn-berry';
}

function count(model: ResolvedModel): { references: number; unresolved: number } {
  let references = 0;
  let unresolved = 0;
  const tally = (refs: ReadonlyMap<string, Ref>): void => {
    for (const ref of refs.values()) {
      references++;
      if (ref.kind === 'unresolved') unresolved++;
    }
  };
  for (const refs of model.importers.values()) tally(refs);
  for (const entry of model.entries.values()) tally(entry.dependencies);
  return { references, unresolved };
}

const results = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const name = basename(file);
  const seconds: number[] = [];
  let model: ReturnType<typeof read> = read(name, text);
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    model = read(name, text);
    seconds.push(performance.now() - start);
  }
  seconds.sort((a, b) => a - b);
  const medianMs = Math.round(seconds[Math.floor(RUNS / 2)]! * 10) / 10;
  const bytes = Buffer.byteLength(text);
  if ('kind' in model) {
    results.push({ file: name, reader: readerOf(name, text), bytes, medianMs, refused: model.reason });
    process.stderr.write(`${name}: REFUSED ${model.reason}\n`);
    continue;
  }
  const { references, unresolved } = count(model);
  const row = { file: name, reader: readerOf(name, text), bytes, medianMs, entries: model.entries.size, importers: model.importers.size, references, unresolved };
  results.push(row);
  process.stderr.write(`${name}: ${bytes} bytes, ${medianMs} ms, ${row.entries} entries, ${row.importers} importers, ${references} references, ${unresolved} unresolved\n`);
}

process.stdout.write(
  canonicalJsonPretty({
    benchmark: 'lockfile',
    runs: RUNS,
    results,
    environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown' },
  }) + '\n',
);
