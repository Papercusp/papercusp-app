#!/usr/bin/env node
/**
 * check-no-deployed-liveness-read.mjs — prevent the git-only
 * `positions.deployed` bit from being used as process liveness.
 *
 * `positions.deployed` answers one narrow question: whether the target commit is
 * an ancestor of the release checkout's HEAD.  The deploy swaps that checkout
 * before restarting the serving process, so the bit can be true while the old
 * process is still serving.  Process conclusions (live/running/loaded/safe to
 * proceed) therefore require the independent
 * `serving.startedSinceCodeChange` evidence.
 *
 * This is a class guard, not a per-site fix.  It scans production source and
 * fails when a `positions.deployed` read has no nearby serving evidence.  A
 * small, documented allowlist covers modules whose reads are intentionally
 * git-only (registry metadata and release-parity projections).
 *
 *   node scripts/check-no-deployed-liveness-read.mjs
 *   node scripts/check-no-deployed-liveness-read.mjs --list
 */
import { readFileSync } from 'node:fs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Legitimate git-only readers.  These modules expose ancestry/registry data;
 * they do not claim that a serving process has loaded the bytes.  Keep this
 * set shrink-only: a new production caller must carry serving evidence.
 */
export const ALLOWLIST = new Map([
  [
    'packages/operator-core/lib/agent-tools/dev/pipeline_position.ts',
    'projects the git position alongside the serving leg; the serving evidence is selected and returned by this projection tool',
  ],
  [
    'packages/operator-core/lib/cell-registrations.ts',
    'declares the cell schema and its git-only headline; process truth is a separate assessment/evidence path',
  ],
  [
    'packages/operator-core/lib/cell-registry.ts',
    'registry validation and documentation for the git position cell; it never asserts process liveness',
  ],
  [
    'packages/operator-core/lib/result-projection/named-views.ts',
    'named-view metadata only; selecting the git position field is not a liveness conclusion',
  ],
  [
    'packages/operator-core/lib/release-trace.ts',
    'release parity/containment projection; serving truth is represented separately by git-pipeline-position',
  ],
]);

export const BASELINE = new Set([]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/dist-sidecar/') ||
  f.includes('/build/') ||
  f.includes('/.next/') ||
  f.includes('/target/') ||
  f.includes('/coverage/') ||
  f.includes('/env-sidecars/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f);

const DEPLOYED_RE = /\bpositions\s*(?:\.\s*|\?\.\s*)deployed\b/g;
const SERVING_EVIDENCE_RE = /\bserving\s*(?:\.\s*|\?\.\s*)startedSinceCodeChange\b/;
const EVIDENCE_RADIUS = 420;

/**
 * Return every read that cannot be paired with process evidence in its local
 * expression/function window.  Exported for falsifiable unit tests.
 */
export function findUngroundedReads(source, fileName = '') {
  // Both comments and strings are non-executable here: a registry path such as
  // `path: 'positions.deployed'` describes the cell and is not a liveness read.
  const masked = stripCommentsAndStrings(source, fileName || undefined);
  const findings = [];
  DEPLOYED_RE.lastIndex = 0;
  let match;
  while ((match = DEPLOYED_RE.exec(masked))) {
    const start = Math.max(0, match.index - EVIDENCE_RADIUS);
    const end = Math.min(masked.length, match.index + match[0].length + EVIDENCE_RADIUS);
    const window = masked.slice(start, end);
    if (!SERVING_EVIDENCE_RE.test(window)) {
      findings.push({
        offset: match.index,
        line: masked.slice(0, match.index).split('\n').length,
        text: match[0],
      });
    }
  }
  return findings;
}

/** Predicate used by tests and by the filesystem scan. */
export function readsDeployedWithoutServingEvidence(source, fileName = '') {
  return findUngroundedReads(source, fileName).length > 0;
}

export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);
  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f) || ALLOWLIST.has(f) || BASELINE.has(f)) continue;
    let source;
    try {
      source = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    const findings = findUngroundedReads(source, f);
    if (findings.length > 0) offenders.push({ file: f, findings });
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (process.argv.includes('--list')) {
    for (const [file, reason] of ALLOWLIST) console.log(`ALLOW\t${file}\t${reason}`);
    for (const offender of offenders) {
      for (const finding of offender.findings)
        console.log(`OFFENDER\t${offender.file}:${finding.line}\t${finding.text}`);
    }
  }
  if (offenders.length === 0) {
    console.log(
      '✓ every positions.deployed read is paired with serving.startedSinceCodeChange or an explicit git-only allowlist entry.' +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ positions.deployed read(s) lack nearby serving.startedSinceCodeChange evidence:');
  for (const offender of offenders) {
    for (const finding of offender.findings)
      console.error(`  ${offender.file}:${finding.line} — ${finding.text}`);
  }
  console.error('\nDo not infer process liveness from git ancestry; carry serving evidence or document a genuine git-only reader.');
  process.exit(1);
}

if (isCliEntry(import.meta.url)) main();
