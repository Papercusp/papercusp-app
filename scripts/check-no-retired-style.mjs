#!/usr/bin/env node
/**
 * check-no-retired-style.mjs — fail-loud guard against re-wiring a MIGRATED
 * work-loop back into a bespoke `system:*` routine
 * (deterministic-blueprints-migration-2026-06-13 P-132 / D-007).
 *
 * The migration moved work-doing learning loops from bespoke `system:<loop>`
 * routine actions to deterministic BLUEPRINTS: the cadence routine now fires
 * `system:blueprint-run` with a `{ blueprintId }` payload (which detects
 * program-mode and runs the loop's deterministic step inline). There must be ONE
 * execution model for a migrated loop — the blueprint — not two. A routine that
 * re-points its `target` / `target_role` at the RETIRED bespoke action name is a
 * regression to the two-execution-model world this migration collapsed; this
 * guard fails the build when one reappears.
 *
 *   node scripts/check-no-retired-style.mjs
 *
 * The detection predicate (`isRetiredRoutineRewire`) + `findOffenders()` are
 * exported and unit-tested (packages/operator-core/lib/blueprint-steps/
 * no-retired-style-guard.test.ts) so BOTH directions are durably verified: the
 * test runs `findOffenders()` over the real tree (no false positive — green on
 * clean) AND exercises the predicate on synthetic re-wires (no false negative).
 *
 * NOT flagged (by design):
 *   - the retired action's PROVENANCE tag (`createdBy: 'system:negative-space-mine'`)
 *     — a filed-item attribution string, not a routine target. The `target`/
 *     `target_role` anchor excludes it.
 *   - doc-comment MENTIONS of the retired name — comments are stripped first.
 *   - a NON-migrated loop targeting its own (still-live) bespoke action
 *     (`system:prompt-ablation`, `system:scout-cycle`, …) — only the loops in
 *     MIGRATED_LOOPS are forbidden as targets.
 *
 * AMEND THIS WHEN YOU MIGRATE A LOOP: when a bucket-A loop's seed routine flips to
 * `system:blueprint-run` (P-120/P-121/P-122 waves), add it to MIGRATED_LOOPS so a
 * later re-wire of THAT loop is caught too. The set is the single source of truth
 * for "which loops are migrated and must never go bespoke again" — it must be a
 * DECLARED constant, not derived from the live seed state (a re-wire would flip the
 * seed, so a derived set could never detect its own regression).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * The migrated work-loops: each has a deterministic blueprint-step op
 * (packages/operator-core/lib/blueprint-steps/ops/*) AND a seed routine that now
 * targets `system:blueprint-run` with the given blueprintId. Its `retiredTarget`
 * (the old bespoke `system:<loop>` action) must never reappear as a routine target.
 */
export const MIGRATED_LOOPS = [
  { loop: 'negative-space-mine', retiredTarget: 'system:negative-space-mine', blueprintId: 'negative-space' },
  { loop: 'regret-mine', retiredTarget: 'system:regret-mine', blueprintId: 'regret' },
  { loop: 'neologism-mine', retiredTarget: 'system:neologism-mine', blueprintId: 'neologism' },
  { loop: 'fleet-ekg-scan', retiredTarget: 'system:fleet-ekg-scan', blueprintId: 'fleet-ekg' },
  // P-121/P-122 waves (seeds repointed to system:blueprint-run, 2026-06-13).
  { loop: 'red-queen-drill', retiredTarget: 'system:red-queen-drill', blueprintId: 'red-queen' },
  { loop: 'scout-cycle', retiredTarget: 'system:scout-cycle', blueprintId: 'scout' },
  { loop: 'transfer-distill', retiredTarget: 'system:transfer-distill', blueprintId: 'transfer' },
  { loop: 'prompt-ablation', retiredTarget: 'system:prompt-ablation', blueprintId: 'prompt-ablation' },
  // Ratified reclassified pure-deterministic loops (D-012; seeds repointed 2026-06-13).
  { loop: 'change-ledger-scan', retiredTarget: 'system:change-ledger-scan', blueprintId: 'change-ledger' },
  { loop: 'deferral-interest-refit', retiredTarget: 'system:deferral-interest-refit', blueprintId: 'deferral-interest' },
  { loop: 'calibration-resolve', retiredTarget: 'system:calibration-resolve', blueprintId: 'calibration' },
  { loop: 'graduation-scan', retiredTarget: 'system:graduation-scan', blueprintId: 'graduation' },
  // The hybrid eval engine (D-013; seed repointed 2026-06-13).
  { loop: 'iq-battery-gen', retiredTarget: 'system:iq-battery-gen', blueprintId: 'iq-battery' },
];

/** The retired bespoke action names that must never be a routine target again. */
export const RETIRED_ROUTINE_TARGETS = new Set(MIGRATED_LOOPS.map((m) => m.retiredTarget));

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A re-wire tell: a `target` / `target_role` assigned a RETIRED bespoke action
 * name (TS object `target: 'system:…'` or SQL `target_role = 'system:…'`). The
 * `target`-key anchor is what distinguishes a routine re-wire from the retired
 * name's legitimate uses (a `createdBy:` provenance value, a doc mention).
 */
const RETIRED_TARGET_RE = new RegExp(
  String.raw`\btarget(?:_role)?\s*[:=]\s*['"\x60](` +
    [...RETIRED_ROUTINE_TARGETS].map(escapeRegExp).join('|') +
    String.raw`)['"\x60]`,
);

/** Strip block + whole-line comments so a doc MENTION of a retired name never
 *  reads as a re-wire (the change-ledger writer-set guard uses the same trick). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Pure (text → boolean): does this file re-point a routine at a retired bespoke
 *  action? Comment-stripped + `target`-anchored, so it's robust to provenance
 *  values and doc mentions. Unit-tested for both directions. */
export function isRetiredRoutineRewire(text) {
  return RETIRED_TARGET_RE.test(stripComments(text));
}

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.endsWith('.test.ts') ||
  f.endsWith('.test.tsx') ||
  f === 'scripts/check-no-retired-style.mjs' ||
  !/\.(ts|tsx|sql)$/.test(f);

/**
 * Scan the tracked tree for re-wire offenders (excludes tests + _retired + self).
 *
 * WI-6666: enumerates via the shared `listTrackedFiles` helper, which recurses into
 * submodules. A bare `git ls-files` does NOT — it emits one gitlink entry per
 * submodule — so this guard previously never opened libs/generic/**, libs/papercusp/**,
 * or papercusp-desktop/**, where routine/blueprint wiring code also lives. Returns
 * `{ offenders, unscanned }` so `main` can report coverage; `findOffenders` below
 * keeps the plain-array contract the unit test pins (`() => string[]`).
 */
export function scanTree() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (isRetiredRoutineRewire(text)) offenders.push(f);
  }
  return { offenders, unscanned };
}

/** Plain-array contract (pinned by no-retired-style-guard.test.ts) — see scanTree(). */
export function findOffenders() {
  return scanTree().offenders;
}

function main() {
  const { offenders, unscanned } = scanTree();
  if (offenders.length === 0) {
    console.log(
      '✓ no-retired-style: every migrated loop routes through system:blueprint-run — none re-wired bespoke.' +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ a MIGRATED work-loop is re-wired to its retired bespoke action (two execution models):');
  console.error('  A migrated loop must fire its deterministic blueprint via');
  console.error("  `target: 'system:blueprint-run'` + a `{ blueprintId }` payload — NOT the retired");
  console.error(`  bespoke action (${[...RETIRED_ROUTINE_TARGETS].join(', ')}).\n`);
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} re-wire(s). See plan deterministic-blueprints-migration-2026-06-13 (P-132 / D-007).`,
  );
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit
// test) must NOT exec git / exit the process. Symlink-robust (WI-1443): node
// realpaths import.meta.url while argv[1] keeps the invoked path, so also
// compare realpaths.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
