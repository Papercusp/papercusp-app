/**
 * Real-corpus snapshot for the memory-backend benchmark
 * (memory-backend-benchmark-2026-06-05 P-004, D-002/D-009).
 *
 * The benchmark corpus is the owner's REAL Claude Code file memory —
 * snapshotted ONCE through the seam (read-only; the live store is never
 * written) and frozen as `fixtures/corpus.v1.json` so runs stay
 * comparable while the live store keeps evolving. Regenerate a NEW
 * version (corpus.v2.json + a gold-set rev) deliberately, never in
 * place: the gold set's expected keys are bound to a corpus version.
 *
 * Snapshot path: ClaudeFileMemoryBackend.list() — the same parser the
 * claude-file backend itself uses, so the snapshot is exactly what that
 * backend would serve.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ClaudeFileMemoryBackend } from '@papercusp/memory';
import type { CorpusEntry } from '@papercusp/memory/bench';

export const CORPUS_FIXTURE_VERSION = 'v1';

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

/** Snapshot a Claude memory dir into corpus entries (read-only). */
export async function snapshotClaudeCorpus(memoryDir: string): Promise<CorpusEntry[]> {
  const backend = new ClaudeFileMemoryBackend({ memoryDir });
  const entries = await backend.list({ scope: 'snapshot' });
  return entries
    .map((e): CorpusEntry => ({
      key: e.id,
      text: e.text,
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
      ...(typeof e.metadata?.description === 'string' && e.metadata.description
        ? { description: e.metadata.description }
        : {}),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Load the frozen corpus fixture. */
export function loadCorpusFixture(version: string = CORPUS_FIXTURE_VERSION): CorpusEntry[] {
  const file = path.join(FIXTURES_DIR, `corpus.${version}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: CorpusEntry[] };
  return parsed.entries;
}

/** Write a corpus snapshot as a frozen fixture (deliberate versioning). */
export function writeCorpusFixture(entries: CorpusEntry[], version: string): string {
  const file = path.join(FIXTURES_DIR, `corpus.${version}.json`);
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ version, snapshotAt: new Date().toISOString(), count: entries.length, entries }, null, 2) + '\n',
    'utf8',
  );
  return file;
}
