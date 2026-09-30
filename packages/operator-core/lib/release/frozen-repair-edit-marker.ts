/**
 * P-004/P-005 (frozen-candidate-compliance-enforcement-2026-08-30): the edit-time half of
 * frozen-candidate compliance.
 *
 * THE GAP THIS CLOSES. `detectFrozenRepairSharedTreeCollision` already knows that editing a
 * frozen candidate's failing path in the shared checkout is a hazard — it has known since
 * P-009. But it is REPORT-ONLY and runs inside the gate, hours after the edit, addressed to
 * whoever reads a diagnostic. The agent who made the edit is never told, at the one moment
 * the information is actionable. D-001 forbids closing that with prose: this is a push-time
 * signal that fires without the agent knowing to ask.
 *
 * WHY A MARKER FILE AND NOT A QUERY. The hook runs on EVERY Edit/Write across the whole
 * fleet. It must cost ~nothing in the overwhelmingly common case (nothing frozen), so the
 * signal is inverted: when no repair is frozen there is NO marker file, and the hook exits
 * after one failed stat. A per-edit database round-trip would be the wrong shape entirely.
 *
 * WHY IT CANNOT GO STALE. The marker is projected from `writeFrozenCandidateRepairQueue` —
 * documented there as "the one production write path for `repair_queue`" — so it is written
 * in the same call that persists the queue it describes. That is the same argument the
 * convergence projection beside it already makes, and it is what a separate best-effort
 * writer would give up.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  normalizeRepoPath,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

export type FrozenRepairMarkerLegStatus = 'red' | 'admitted' | 'green';

/** P-022: one P-021 manifest leg, status-only — exactly what the completion guard needs. */
export interface FrozenRepairMarkerLeg {
  legId: string;
  status: FrozenRepairMarkerLegStatus;
  /** Normalized subject paths (the leg's admission allowlist). */
  subjectPaths: string[];
}

export interface FrozenRepairEditMarker {
  candidate: string;
  repairHead: string;
  phase: string;
  /** Already normalized, so a reader only has to normalize its own edited path. */
  failingPaths: string[];
  updatedAtMs: number;
  /**
   * P-022 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #3): every path
   * the admission ledger carries on the CURRENT lineage (`admissions[].paths ∪ unchanged`),
   * normalized. Projected from the same queue write as the rest of the marker, so a
   * completion guard reading it sees the lineage the gate will judge — not staging's tip.
   * Empty for a queue with no admissions yet.
   */
  admittedPaths: string[];
  /** P-022: the P-021 repair manifest's legs (red / admitted / green), or [] before P-021 derived one. */
  legs: FrozenRepairMarkerLeg[];
}

export function frozenRepairMarkerPath(): string {
  const base = process.env.PAPERCUSP_STATE_DIR ?? join(homedir(), '.papercusp', 'state');
  return join(base, 'frozen-repair-edit-marker.json');
}

/**
 * Project (or clear) the marker. NEVER throws: this runs inside the gate's queue write, and
 * a filesystem problem here must not be able to fail a release write. A missing marker
 * degrades the hook to silence, which is exactly today's behaviour.
 */
export function projectFrozenRepairMarker(
  queue: FrozenCandidateRepairQueue | null,
  path: string = frozenRepairMarkerPath(),
): void {
  try {
    if (!queue || queue.phase === 'ready-to-test') {
      // `ready-to-test` is excluded for the same reason the collision detector excludes it:
      // no repair exists yet, so an edit races nothing.
      rmSync(path, { force: true });
      return;
    }
    const marker: FrozenRepairEditMarker = {
      candidate: queue.candidate,
      repairHead: queue.repairHead,
      phase: queue.phase,
      failingPaths: [
        ...new Set(queue.failingTests.map(normalizeRepoPath).filter((p) => p.length > 0)),
      ].sort(),
      updatedAtMs: queue.updatedAtMs,
      admittedPaths: [
        ...new Set(
          (queue.admissions ?? [])
            .flatMap((a) => [...(a.paths ?? []), ...(a.unchanged ?? [])])
            .map(normalizeRepoPath)
            .filter((p) => p.length > 0),
        ),
      ].sort(),
      legs: (queue.manifest?.rows ?? []).map((row) => ({
        legId: row.legId,
        status:
          row.status.kind === 'green' ? 'green' : row.status.kind === 'admitted' ? 'admitted' : 'red',
        subjectPaths: [...new Set(row.subjectPaths.map(normalizeRepoPath).filter((p) => p.length > 0))].sort(),
      })),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(marker), 'utf8');
  } catch {
    /* best-effort by construction — see the doc above */
  }
}

export function readFrozenRepairMarker(
  path: string = frozenRepairMarkerPath(),
): FrozenRepairEditMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Record<string, unknown>;
    if (typeof m.candidate !== 'string' || typeof m.repairHead !== 'string') return null;
    if (!Array.isArray(m.failingPaths)) return null;
    // P-022 fields are tolerated when absent (a marker written before P-022): the guard then
    // sees an empty ledger, which is the honest reading of a row that recorded no admissions.
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
    const legs: FrozenRepairMarkerLeg[] = Array.isArray(m.legs)
      ? m.legs.flatMap((leg): FrozenRepairMarkerLeg[] => {
          if (!leg || typeof leg !== 'object') return [];
          const l = leg as Record<string, unknown>;
          if (typeof l.legId !== 'string') return [];
          const status: FrozenRepairMarkerLegStatus =
            l.status === 'green' ? 'green' : l.status === 'admitted' ? 'admitted' : 'red';
          return [{ legId: l.legId, status, subjectPaths: strings(l.subjectPaths) }];
        })
      : [];
    return {
      candidate: m.candidate,
      repairHead: m.repairHead,
      phase: typeof m.phase === 'string' ? m.phase : 'unknown',
      failingPaths: m.failingPaths.filter((p): p is string => typeof p === 'string'),
      updatedAtMs: typeof m.updatedAtMs === 'number' ? m.updatedAtMs : 0,
      admittedPaths: strings(m.admittedPaths),
      legs,
    };
  } catch {
    return null;
  }
}

/**
 * P-005: the message names the CONSEQUENCE, not the rule.
 *
 * "Remember freeze-and-converge" is the prose that already failed — it asks the reader to
 * recall a regime and derive what it implies for them. What an agent mid-edit needs is the
 * outcome ("this fix will not reach the judged sha") and the one call that changes it.
 * Returns null when there is nothing to say.
 */
export function frozenRepairEditWarning(
  marker: FrozenRepairEditMarker | null,
  editedPath: string,
): string | null {
  if (!marker) return null;
  const normalized = normalizeRepoPath(editedPath);
  if (!normalized || !marker.failingPaths.includes(normalized)) return null;
  return (
    `⛔ THIS FIX WILL NOT REACH THE GATE.\n` +
    `   ${normalized} is in the frozen candidate's failing set, and the gate is judging ` +
    `${marker.repairHead.slice(0, 12)} (frozen candidate ${marker.candidate.slice(0, 12)}, ` +
    `phase ${marker.phase}) — NOT the staging tip your edit lands on.\n` +
    `   So the gate will keep failing on this exact file no matter how correct your fix is, ` +
    `and a "fixed the gate red" claim off this edit would be false.\n` +
    `   Put it on the judged lineage with ONE call:\n` +
    `     release:repair-queue { op:'admit', paths:['${normalized}'] }\n` +
    `   It reports whether the judged sha now carries your fix. Do NOT fire ` +
    `release:checkpoint-run and do NOT retire the queue to "make the gate move".`
  );
}
