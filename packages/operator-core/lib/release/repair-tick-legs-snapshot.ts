/**
 * The read-side snapshot of a repair-tick's cheap non-test GATE LEG measurement
 * (`gate_health.repairTickLegs`, written by green-checkpoint.ts's
 * `augmentWithRepairTickLegs` — see `apps/operator/lib/release/green-checkpoint.ts`'s
 * `RepairTickLegs` / `RepairTickLegRecord`).
 *
 * WI-2143253: `gate.greenCheckpoint.candidateFailures` collapsed EVERY non-test leg
 * (lint / perf / desktop / delta) into ONE tri-state boolean (`postSuiteMeasured`) — it
 * could not name WHICH leg was failing, and observably went `false`/`none-failing` while
 * two lint legs (`lint:design-primitives`, `lint:plane-integrity`) were red on the very
 * candidate blocking `main`. The per-leg measurement already exists — an `awaiting-fixer`
 * hold tick takes it and persists it, precisely so non-test legs stay MEASURED (not
 * `failingTestsMeasured:false`) during repair — it was simply never read back into any
 * state cell. This module is the missing read/parse half.
 *
 * Mirrors `./in-flight-candidate.ts`'s pattern on purpose: a `packages/operator-core`-owned
 * parser for a JSONB blob the apps-layer `green-checkpoint.ts` writes, so this library layer
 * never imports the apps-layer type (apps depends on packages, never the reverse).
 *
 * ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────────
 * The LATEST repair-tick measurement only — a point-in-time marker, like
 * `inFlightCandidate`, not a per-round shrink series. Giving non-test legs the same
 * shrink-over-time tracking test files get via `frozen-candidate-repair-queue.ts`'s
 * `convergenceRounds` would need a persisted, capped round history keyed by signature — a
 * write-path change to the LIVE frozen repair queue, which is out of scope for this pass
 * (a real repair was in flight, owned by another agent, when this was filed). Read-side
 * visibility into the CURRENT set of failing legs is the gap actually blocking triage
 * ("is the gate red about a lint leg, and which one") and is what this closes; the
 * shrink-history half is named as deferred scope on the work-item this module fixes, not
 * silently dropped.
 */

export interface RepairTickLegSnapshot {
  /** The NON_TEST_GATE_SCRIPTS registry id (e.g. `lint:design-primitives`) — a correlation
   *  key that is NEVER a repo path (a fixer edits scripts/config under it, not a file named
   *  after the leg), unlike `distinctFailingFiles[].path` on the sibling test-file cell. */
  id: string;
  status: 'pass' | 'fail' | 'errored';
  /** Null when the writer omitted it (legacy row) or it did not parse as a number. */
  durationMs: number | null;
}

/** The persisted shape of one repair-tick's cheap-legs measurement. */
export interface StoredRepairTickLegs {
  /**
   * The repairHead these legs were actually measured AT, SHORT (the writer persists
   * `head.slice(0, 12)` — release-actions.ts — never the full sha). May differ from the
   * live repairHead: fixes land ON TOP of the frozen candidate and the legs re-run at the
   * advancing head, same as the file-based failures on the sibling cell. Compare with
   * `repairHeadSha.startsWith(head)`, never `===`.
   */
  head: string;
  atMs: number;
  /** True when every measured leg passed. */
  ok: boolean;
  /** Registry ids of every leg that did not pass at `head` — complete, not a first-failure
   *  floor (bounded to 20 by the writer). */
  failingSignatures: string[];
  /** Bounded to 32 by the writer. */
  legs: RepairTickLegSnapshot[];
}

/**
 * PURE: interpret the raw `gate_health.repairTickLegs` value. Returns null for anything
 * unreadable — missing or malformed.
 *
 * Deliberately NO age bound (unlike `parseInFlightCandidate`'s 3h liveness window): this is
 * a durable RESULT of a completed measurement, not a liveness marker for a run that might
 * have died. An old measurement is still the most recent one taken and stays meaningful
 * until superseded — the caller judges currency by comparing `head` against the LIVE
 * repairHead, not by age.
 */
export function parseRepairTickLegs(raw: unknown): StoredRepairTickLegs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const head = typeof r.head === 'string' && r.head ? r.head : null;
  const atMs = typeof r.atMs === 'number' ? r.atMs : null;
  if (!head || atMs == null) return null;

  const rawLegs = Array.isArray(r.legs) ? r.legs : [];
  const legs: RepairTickLegSnapshot[] = [];
  for (const entry of rawLegs) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    if (e.status !== 'pass' && e.status !== 'fail' && e.status !== 'errored') continue;
    legs.push({
      id: e.id,
      status: e.status,
      durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
    });
  }

  const failingSignatures = Array.isArray(r.failingSignatures)
    ? r.failingSignatures.filter((v): v is string => typeof v === 'string')
    : [];

  return {
    head,
    atMs,
    ok: r.ok === true,
    failingSignatures,
    legs,
  };
}

/**
 * Is this measurement CURRENT for the live repairHead, or from an earlier head the queue
 * has since moved past? `null` when currency cannot be judged (no live repairHead to
 * compare against) — distinct from `false`, which is a measured mismatch.
 */
export function repairTickLegsCurrent(
  snapshot: Pick<StoredRepairTickLegs, 'head'>,
  liveRepairHeadSha: string | null,
): boolean | null {
  if (!liveRepairHeadSha) return null;
  return liveRepairHeadSha.startsWith(snapshot.head);
}

/**
 * PURE: did the latest repair tick RE-RUN every signature the frozen queue is red on, at the
 * queue's CURRENT repairHead, and see each one pass?
 *
 * That is a red the gate itself could not reproduce at the same head. It deadlocks exactly
 * like an unmeasured red (WI-10003213): the hold tick persists a candidate snapshot with an
 * empty failing set, so `candidateSnapshotMatchesDispatch` never matches the queue's own
 * signature and the fixer dispatch is skipped every tick, while nothing else runs a suite.
 * Measured 2026-09-29 on queue 5ec99902 / head aa948759: the verify reported
 * `@papercusp/operator-core :: test:lane-stateful` FAIL with no failing test file recorded,
 * and the repair tick at the same head passed that leg (1159s).
 *
 * Every queue signature must appear among the tick's PASSING legs — a signature the tick did
 * not re-run is not evidence of anything, so a queue red on a test FILE (never a tick leg)
 * stays on the fixer path.
 */
export function repairTickClearedQueueSignature(
  snapshot: StoredRepairTickLegs | null,
  queue: { repairHead: string; failingTests?: readonly string[] | null },
): boolean {
  if (!snapshot || !snapshot.ok) return false;
  if (repairTickLegsCurrent(snapshot, queue.repairHead) !== true) return false;
  const failing = queue.failingTests ?? [];
  if (failing.length === 0) return false;
  const passed = new Set(snapshot.legs.filter((leg) => leg.status === 'pass').map((leg) => leg.id));
  return failing.every((id) => passed.has(id));
}
