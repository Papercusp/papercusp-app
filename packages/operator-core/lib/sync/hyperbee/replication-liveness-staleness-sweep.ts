/**
 * replication-liveness-staleness-sweep — closes the "abandoned but still-registered
 * harness" hole in the replication-stall EI class (WI-5563).
 *
 * Context: replication-stall-orphan-sweep.ts already auto-resolves an open
 * replication-liveness EI whose target harness has been RENAMED/DELETED (no longer
 * in the workspace's harness registry at all) — that is unconditionally safe (a
 * harness that doesn't exist can, by construction, never again produce a recovery
 * sample). This sweep covers the WIDER, riskier case that orphan-sweep deliberately
 * leaves alone: a target harness that STILL EXISTS in the registry (even a demo/test
 * harness like hello-world*, spoon-knife*, dummy-pot-0707, sharetest732, lane2-*)
 * but has had NO activity for a long time — i.e. genuinely abandoned, not renamed.
 *
 * WI-5563's own SQL diagnosis found 172 open replication-liveness EIs papercusp-wide
 * (71 on papercusp itself), spanning 53 distinct harness slugs, most of them clearly
 * one-off test/demo pots that will never run again — but whose registry ROW still
 * exists, so orphan-sweep's existence check alone does not resolve them. Left alone,
 * this class only ever grows (~12/day net accumulation as of 2026-07-20) and
 * permanently inflates the "open bug" count with structurally-undrainable noise,
 * starving any generic bug-drain fleet whose claim spec targets kind=bug (the
 * bug-drain-200k fleet starvation this WI was filed to diagnose).
 *
 * SAFETY (mirrors auto-close.ts's philosophy for the same class of decision —
 * autonomously resolving a durable escalation without a human/agent looking at the
 * specific item is unsafe by default):
 *   - Scoped to the connectivity-only EI kinds (`no_replicator` / `frozen` /
 *     `connected_never_replicated`) — NEVER the `drain_*` kinds, which indicate an
 *     active outbox-drain defect that could still affect a currently-idle-but-alive
 *     harness and needs a human/agent look, not a blanket time sweep.
 *   - Requires BOTH the EI itself to be old (`minEiAgeMs`) AND the target harness to
 *     have recorded NO activity for a long, separate inactivity window
 *     (`minInactivityMs`) — an EI can be old on a harness that only just went quiet;
 *     this sweep only fires once the harness itself has been silent for a long time too.
 *   - FAILS CLOSED: a harness whose last activity is unknowable is left untouched,
 *     exactly like an existence-check error in orphan-sweep.
 *   - Gated behind a NEW default-OFF flag (`FLAGS.REPLICATION_LIVENESS_STALENESS_AUTO_CLOSE`,
 *     owner-authority class, same precedent as `WATCHDOG_AUTO_CLOSE`) — inert until
 *     the owner reviews and enables it. KNOWN_DARK_FLAGS.
 *
 * ⚠ THE ACTIVITY SOURCE IS THE PART THAT WAS WRONG — and it made this sweep a
 * structural no-op for 13 days without emitting a single signal (WI-5563, fixed
 * 2026-08-09). It originally read `harness_status.last_active_ts` alone. That table
 * is NOT an activity ledger: it is a 5-minute orchestrator LEASE
 * (expirable-registrations.ts), so a row exists only while an orchestrator is
 * actively running the harness. An ABANDONED harness — the only kind this sweep
 * exists to act on — therefore has no row, `lastActiveMs` comes back null, and the
 * fail-closed guard refuses. The guard was inverted against its own purpose: the more
 * certainly abandoned the harness, the more certainly the sweep declined to act.
 * Measured 2026-08-09: the whole `harness_status` table held ONE row, with a NULL
 * `last_active_ts`; all 15 age-eligible EIs skipped as `unknown-activity`; the flag
 * had been ON since 2026-07-27 and the sweep had resolved exactly ZERO EIs, ever.
 *
 * The fix takes the NEWEST of the lease read and a DURABLE per-harness activity read
 * (`harnessLastActivityMs` — newest work-item touch, never TTL'd), so "quiet for 30
 * days" is answerable for a harness that has been dead for months. Fail-closed is
 * kept, but now only fires when BOTH sources are silent.
 *
 * ⚠ It also reported nothing when it did nothing, which is why the no-op was
 * invisible: the scheduled tick logged only `if (resolvedIds.length > 0)`. A sweep
 * that cannot fire and a sweep that correctly found nothing to do were byte-identical
 * from outside. `StalenessSweepResult.skipped` is a per-reason census so the two are
 * now distinguishable, and the tick logs it unconditionally.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { parseStallEiTarget } from './replication-stall-orphan-sweep';

const KIND_RE = /(?:^|\s)kind=(\S+)/;

/** Parse the `kind=…` field stamped by buildReplicationStallBody. */
export function parseStallEiKind(body: string): string | null {
  const m = KIND_RE.exec(body);
  return m ? m[1] : null;
}

/**
 * EI kinds eligible for the staleness sweep — connectivity-only signals whose
 * absence-of-activity genuinely means "nobody is using this harness anymore",
 * never the `drain_*` kinds (those indicate an active defect on a possibly-still-live
 * harness, not mere disuse).
 */
export const STALENESS_ELIGIBLE_KINDS: ReadonlySet<string> = new Set([
  'no_replicator',
  'frozen',
  'connected_never_replicated',
]);

/** Resolver identity stamped on staleness-swept EIs — distinct from both the normal
 *  recovery-sample RECOVERY_OWNER and orphan-sweep's ORPHAN_SWEEP_OWNER so all three
 *  closure reasons stay independently attributable. */
export const STALENESS_SWEEP_OWNER = 'system:replication-liveness-staleness-sweep';

/** Consecutive open EIs inspected per pass (same rationale as orphan-sweep's SWEEP_LIMIT). */
const SWEEP_LIMIT = 1000;

/** An EI younger than this never staleness-closes — give it a chance to recover
 *  through the normal path first. Default 14 days. */
export const DEFAULT_MIN_EI_AGE_MS = 14 * 24 * 60 * 60_000;

/** The harness itself must have recorded NO activity for at least this long — a
 *  SEPARATE, longer window than the EI age so a harness that only just went quiet
 *  is not swept just because an old-ish EI happens to be open on it. Default 30 days. */
export const DEFAULT_MIN_INACTIVITY_MS = 30 * 24 * 60 * 60_000;

export interface StalenessSweepOptions {
  minEiAgeMs?: number;
  minInactivityMs?: number;
  /**
   * Clock override (ms epoch). Production leaves it unset and the sweep stamps `Date.now()`.
   *
   * ⚠ IT EXISTS SO TESTS ARE NOT TIME BOMBS. `decideStaleness` already takes `nowMs`
   * explicitly, so the pure-decision tests were always deterministic — this IO wrapper was
   * the ONE place that reached for the real clock, which silently made every injected
   * fixture's age drift with the calendar. A fixture written to mean "recently active"
   * (frozen `NOW - 1d`, where NOW is 2026-07-20) became "inactive for 30 days" the moment
   * real time crossed 2026-08-18T00:00Z, and RED the green gate — 9 days after either file
   * was last touched, so nothing in the diff could explain it. The drift is one-directional
   * and silent: fixtures meant to be OLD only get safely older, so only the "recent" ones
   * rot, and they rot into a PASSING-looking assertion flip rather than an error.
   * Pass `nowMs` and a fixture means what it says permanently.
   */
  nowMs?: number;
}

export interface StalenessCandidate {
  id: string;
  kind: string | null;
  createdAtMs: number;
  /** ms epoch of the target harness's last recorded activity, or null when unknown. */
  lastActiveMs: number | null;
}

/**
 * The subset of skip reasons the PURE decision function can produce. Typed as a
 * union (rather than a bare string) so the sweep's census cannot silently fail to
 * count a decision — an uncounted skip is precisely the blind spot that let this
 * sweep no-op undetected, so the compiler now enforces the accounting.
 */
export type StalenessDecisionSkipReason = Extract<
  StalenessSkipReason,
  'ineligible-kind' | 'ei-too-new' | 'unknown-activity-fail-closed' | 'harness-recently-active'
>;

export type StalenessDecision =
  | { resolve: true; reason: string }
  | { resolve: false; reason: StalenessDecisionSkipReason };

/**
 * Pure: should this open replication-stall EI staleness-close? Every guard is
 * independently observable/unit-tested, mirroring decideAutoClose's shape.
 */
export function decideStaleness(
  c: StalenessCandidate,
  nowMs: number,
  opts: StalenessSweepOptions = {},
): StalenessDecision {
  const minEiAge = opts.minEiAgeMs ?? DEFAULT_MIN_EI_AGE_MS;
  const minInactivity = opts.minInactivityMs ?? DEFAULT_MIN_INACTIVITY_MS;
  if (!c.kind || !STALENESS_ELIGIBLE_KINDS.has(c.kind)) {
    return { resolve: false, reason: 'ineligible-kind' };
  }
  if (!Number.isFinite(c.createdAtMs) || nowMs - c.createdAtMs < minEiAge) {
    return { resolve: false, reason: 'ei-too-new' };
  }
  if (c.lastActiveMs == null) {
    // Fail CLOSED: unknown activity history (no harness_status row at all) —
    // never resolve on an uncertain read, exactly like orphan-sweep's existence check.
    return { resolve: false, reason: 'unknown-activity-fail-closed' };
  }
  if (nowMs - c.lastActiveMs < minInactivity) {
    return { resolve: false, reason: 'harness-recently-active' };
  }
  return {
    resolve: true,
    reason:
      `harness inactive for ≥${Math.round(minInactivity / 86_400_000)}d (last activity ` +
      `${new Date(c.lastActiveMs).toISOString()}) and this ${c.kind} EI has been open ≥` +
      `${Math.round(minEiAge / 86_400_000)}d with no recovery — treated as abandoned, not merely renamed/deleted`,
  };
}

export interface StalenessSweepDeps {
  listOpenReplicationStallEis(): Promise<Array<{ id: string; body: string; createdAtMs: number }>>;
  /** Still-registered check (mirrors orphan-sweep's harnessExists) — a harness that no
   *  longer exists is orphan-sweep's job, not this sweep's; skip it here either way. */
  harnessExists(workspaceId: string, harnessSlug: string): Promise<boolean>;
  /** ms epoch of the harness's last recorded activity, or null when no status row exists. */
  harnessLastActiveMs(workspaceId: string, harnessSlug: string): Promise<number | null>;
  resolve(id: string, note: string): Promise<void>;
}

/**
 * Every reason this sweep can decline to act on an EI it looked at. Counted so an
 * inert sweep is DISTINGUISHABLE from a sweep that correctly found nothing — the
 * distinction that hid WI-5563's no-op for 13 days.
 */
export type StalenessSkipReason =
  | 'malformed-body'
  | 'flag-off'
  | 'harness-gone-orphan-sweeps-it'
  | 'harness-exists-unreadable'
  | 'ineligible-kind'
  | 'ei-too-new'
  | 'unknown-activity-fail-closed'
  | 'harness-recently-active';

export interface StalenessSweepResult {
  checked: number;
  resolvedIds: string[];
  errors: number;
  /** Per-reason census of everything NOT resolved. Sums with resolvedIds to `checked`. */
  skipped: Record<StalenessSkipReason, number>;
}

export function emptySkipCensus(): Record<StalenessSkipReason, number> {
  return {
    'malformed-body': 0,
    'flag-off': 0,
    'harness-gone-orphan-sweeps-it': 0,
    'harness-exists-unreadable': 0,
    'ineligible-kind': 0,
    'ei-too-new': 0,
    'unknown-activity-fail-closed': 0,
    'harness-recently-active': 0,
  };
}

/**
 * Pure: combine the 5-minute orchestrator LEASE reading with the DURABLE work-item
 * activity reading into one "last active" answer. Newest wins; null only when BOTH
 * are unknown (the genuine fail-closed case).
 *
 * Kept pure and exported because it is the exact seam WI-5563 got wrong — a lease
 * that is absent for every abandoned harness must never be the sole input to an
 * "is this abandoned?" question.
 */
export function pickLastActiveMs(
  leaseMs: number | null | undefined,
  durableMs: number | null | undefined,
): number | null {
  const candidates = [leaseMs, durableMs].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
  return candidates.length === 0 ? null : Math.max(...candidates);
}

async function defaultDeps(): Promise<StalenessSweepDeps> {
  const [
    { listIssues, setIssueState },
    { harnessExistsInWorkspace, harnessStatusFor, harnessLastActivityMs },
    { REPLICATION_LIVENESS_TOPIC },
  ] =
    await Promise.all([
      import('../../issues-engineer'),
      import('../../device-harnesses'),
      import('./replication-stall-ei'),
    ]);
  return {
    listOpenReplicationStallEis: async () => {
      const issues = await listIssues({
        state: 'open',
        topic: REPLICATION_LIVENESS_TOPIC,
        limit: SWEEP_LIMIT,
      });
      return issues.map((i) => ({
        id: i.id,
        body: i.body,
        createdAtMs: i.createdAt ? Date.parse(i.createdAt) : NaN,
      }));
    },
    harnessExists: harnessExistsInWorkspace,
    // WI-5563: the NEWEST of the 5-minute orchestrator lease and the durable
    // work-item activity. The lease alone is null for every abandoned harness —
    // i.e. absent exactly when this sweep needs it — so it can never be the sole
    // input here. See the ACTIVITY SOURCE note at the top of this file.
    harnessLastActiveMs: async (workspaceId, harnessSlug) => {
      const [status, durable] = await Promise.all([
        harnessStatusFor(workspaceId, harnessSlug).catch(() => null),
        harnessLastActivityMs(workspaceId, harnessSlug).catch(() => null),
      ]);
      return pickLastActiveMs(status?.last_active_ts ?? null, durable);
    },
    resolve: async (id, note) => {
      await setIssueState(id, 'resolved', STALENESS_SWEEP_OWNER, note);
    },
  };
}

/**
 * One sweep pass: resolve every open, connectivity-only replication-stall EI whose
 * target harness still exists but has been inactive long enough to be treated as
 * abandoned. Flag-gated (default OFF) — returns a zero-result until the owner enables
 * `papercusp-replication-liveness-staleness-auto-close`. Never throws — best-effort,
 * same VITEST-without-deps safety gate as the orphan sweep.
 */
export async function runReplicationLivenessStalenessSweepOnce(
  opts: StalenessSweepOptions = {},
  deps?: StalenessSweepDeps,
): Promise<StalenessSweepResult> {
  if (process.env.VITEST && !deps) {
    return { checked: 0, resolvedIds: [], errors: 0, skipped: emptySkipCensus() };
  }

  let d: StalenessSweepDeps;
  try {
    d = deps ?? (await defaultDeps());
  } catch {
    return { checked: 0, resolvedIds: [], errors: 0, skipped: emptySkipCensus() };
  }

  let open: Array<{ id: string; body: string; createdAtMs: number }>;
  try {
    open = await d.listOpenReplicationStallEis();
  } catch {
    return { checked: 0, resolvedIds: [], errors: 0, skipped: emptySkipCensus() };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const activeCache = new Map<string, number | null>();
  // Per-target-workspace flag check (cached) — a multi-tenant sweep must respect each
  // target workspace's OWN owner ratification, never a single external caller-supplied
  // workspace (there isn't one: the target workspace comes from each EI's own stamped
  // body, exactly like orphan-sweep's harnessExists target).
  const flagCache = new Map<string, boolean>();
  const resolvedIds: string[] = [];
  const skipped = emptySkipCensus();
  const skip = (reason: StalenessSkipReason): void => {
    skipped[reason] += 1;
  };
  let errors = 0;

  for (const issue of open) {
    const target = parseStallEiTarget(issue.body);
    if (!target) {
      skip('malformed-body'); // malformed/foreign body — never touched
      continue;
    }
    const kind = parseStallEiKind(issue.body);

    if (!deps) {
      let enabled = flagCache.get(target.workspaceId);
      if (enabled === undefined) {
        try {
          enabled = await getFlag(
            FLAGS.REPLICATION_LIVENESS_STALENESS_AUTO_CLOSE,
            `replication-liveness-staleness-sweep:${target.workspaceId}`,
          );
        } catch {
          enabled = false; // fail closed on a flag-read error
        }
        flagCache.set(target.workspaceId, enabled);
      }
      if (!enabled) {
        skip('flag-off');
        continue;
      }
    }

    // Orphan-sweep's job, not ours: a nonexistent harness is skipped here either way
    // (it either already resolved via orphan-sweep, or will on its next pass).
    let exists: boolean;
    try {
      exists = await d.harnessExists(target.workspaceId, target.harnessSlug);
    } catch {
      // uncertain — leave it, never assume either sweep's precondition
      skip('harness-exists-unreadable');
      continue;
    }
    if (!exists) {
      skip('harness-gone-orphan-sweeps-it');
      continue;
    }

    const cacheKey = `${target.workspaceId}::${target.harnessSlug}`;
    let lastActiveMs = activeCache.get(cacheKey);
    if (lastActiveMs === undefined) {
      try {
        lastActiveMs = await d.harnessLastActiveMs(target.workspaceId, target.harnessSlug);
      } catch {
        lastActiveMs = null; // fails closed via decideStaleness's unknown-activity guard
      }
      activeCache.set(cacheKey, lastActiveMs);
    }

    const decision = decideStaleness(
      { id: issue.id, kind, createdAtMs: issue.createdAtMs, lastActiveMs },
      nowMs,
      opts,
    );
    if (!decision.resolve) {
      skip(decision.reason);
      continue;
    }

    try {
      await d.resolve(
        issue.id,
        `auto-resolved (staleness sweep): ${decision.reason}. If harness '${target.harnessSlug}' ` +
          `becomes active again and re-stalls, a fresh alert files normally.`,
      );
      resolvedIds.push(issue.id);
    } catch {
      errors += 1;
    }
  }

  return { checked: open.length, resolvedIds, errors, skipped };
}
