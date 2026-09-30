/**
 * Committed git conflict marker detector (EI-1836 / EI-18217568076594579).
 *
 * EI-1836 (2026-06-20): `apps/operator/app/globals.css` carried three COMMITTED
 * git stash/merge conflict markers (a bad git-sync auto-merge), and `vite build`
 * died with a cryptic `CssSyntaxError: Unknown word "Stashed"` — freezing the SPA
 * build, the desktop sidecar build, the WI-280 re-key witness rebuild, AND the
 * green-checkpoint SPA build, all on a stray "Stashed" word in CSS. That incident
 * only shipped `scripts/check-conflict-markers.mjs` as a POST-hoc CI gate — it
 * still let git-sync COMMIT the broken file first (same class of gap the mdx /
 * smart-quotes / shell-syntax detectors already close for their own error
 * classes). EI-18217568076594579 (2026-07-20) recurred: an agent ran a banned
 * `git stash pop` on the shared tree, left 4 unresolved marker hunks in the same
 * file, and git-sync auto-committed them verbatim — breaking the operator-vite
 * build fleet-wide for ~27min before an unrelated agent noticed and fixed it.
 *
 * This is the PRE-commit half: the SAME pure detector `check-conflict-markers.mjs`
 * already ships (git grep pre-filter + a `^(<{7}|>{7}|\|{7})` line-start regex,
 * zero false positives by construction) wired into the git-sync content guard's
 * registry (git-sync-content-guard-2026-06-13, D-003) so a conflict-marker file
 * is quarantined — never committed — instead of relying on a downstream CI/build
 * failure to catch it hours later.
 *
 * Imports FROM `scripts/check-conflict-markers.mjs` rather than duplicating the
 * regex (D-003: one implementation, so the guard and CI can never disagree) —
 * and deliberately NOT the other way around: that script is invoked via bare
 * `node` (no TS/tsx) from papercusp-desktop/bin/build-desktop-sidecar.sh, so it
 * must stay dependency-free; this TS module (which already runs under tsx/vitest
 * everywhere it's used) is the one that reaches across the boundary, mirroring
 * the existing check-conflict-markers-guard.test.ts import.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { findConflictMarker as findConflictMarkerWithPath, CONFLICT_MARKER_ERE } from '../../../../scripts/check-conflict-markers.mjs';

export { CONFLICT_MARKER_ERE };

export interface ConflictMarkerHit {
  line: number;
  marker: string;
  text: string;
}

/** Pure detector: the FIRST conflict marker in `content`, or null. 1-based line.
 *  `file` doesn't affect detection (the underlying detector is text-only over the
 *  bracket regex) — accepted for a uniform ContentDetector-style signature. */
export function findConflictMarker(_file: string, content: string): ConflictMarkerHit | null {
  const hit: { line: number; marker: string; text: string } | null = findConflictMarkerWithPath('', content);
  if (!hit) return null;
  return { line: hit.line, marker: hit.marker, text: hit.text };
}
