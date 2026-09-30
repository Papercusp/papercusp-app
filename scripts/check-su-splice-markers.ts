#!/usr/bin/env -S npx tsx
/**
 * Build-time presence guard for the SU prompt splice contract (identities-v1
 * P-024). The per-artifact table and marker bytes live beside the runtime
 * splicer; this entrypoint only evaluates that one source of truth.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import {
  REQUIRED_SPLICE_MARKERS_BY_ARTIFACT,
  SPLICE_MARKERS,
  type RequiredSpliceMarkerArtifact,
} from '../packages/operator-core/lib/desktop-install/splice-tooling-overlay';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SU_SPLICE_MARKER_CHECK = '__SU_SPLICE_MARKERS__';

export interface SpliceMarkerProblem {
  path: string;
  markerId: string | null;
  count: number | null;
  reason: 'missing-artifact' | 'unreadable-artifact' | 'unknown-marker' | 'wrong-count';
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

export function checkSuSpliceMarkers({
  root = REPO_ROOT,
  artifacts = REQUIRED_SPLICE_MARKERS_BY_ARTIFACT,
  read = readFileSync,
}: {
  root?: string;
  artifacts?: readonly RequiredSpliceMarkerArtifact[];
  read?: typeof readFileSync;
} = {}): { ok: boolean; checked: number; skipped: number; problems: SpliceMarkerProblem[] } {
  const problems: SpliceMarkerProblem[] = [];
  let checked = 0;
  let skipped = 0;
  for (const artifact of artifacts) {
    let text: string;
    try {
      text = read(resolve(root, artifact.path), 'utf8') as string;
    } catch (error) {
      if (!artifact.required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped += 1;
        continue;
      }
      problems.push({
        path: artifact.path,
        markerId: null,
        count: null,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-artifact' : 'unreadable-artifact',
      });
      continue;
    }
    checked += 1;
    for (const markerId of artifact.markerIds) {
      const marker = SPLICE_MARKERS[markerId];
      if (!marker) {
        problems.push({ path: artifact.path, markerId, count: null, reason: 'unknown-marker' });
        continue;
      }
      const count = occurrences(text, marker);
      if (count !== 1) problems.push({ path: artifact.path, markerId, count, reason: 'wrong-count' });
    }
  }
  return { ok: problems.length === 0, checked, skipped, problems };
}

function main(): void {
  const result = checkSuSpliceMarkers();
  process.stdout.write(`${SU_SPLICE_MARKER_CHECK} ${JSON.stringify(result)}\n`);
  if (result.ok) {
    process.stderr.write(`✓ check-su-splice-markers: ${result.checked} artifact(s) satisfy the exact-once contract (${result.skipped} absent ignored build output(s))\n`);
    return;
  }
  process.stderr.write(`✖ check-su-splice-markers: ${result.problems.length} contract violation(s)\n`);
  for (const problem of result.problems) {
    process.stderr.write(`  - ${problem.path}: ${problem.markerId ?? 'artifact'} ${problem.reason}${problem.count == null ? '' : ` (count=${problem.count})`}\n`);
  }
  process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) main();
