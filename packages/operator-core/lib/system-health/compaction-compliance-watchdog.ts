/**
 * compaction-compliance-watchdog — the backstop for agent-managed compaction
 * (agent-managed-compaction-2026-07-01 P-009).
 *
 * On a cadence (OFF the per-turn hot path) it estimates each limit-setting session's
 * context size and caches it on coord_presence.context_tokens — the value the
 * coord:inbox usage signal reads to render `context: N/L (X%)` (P-007). It also logs
 * a warning when a session has run PAST its own compaction_limit without compacting
 * and force-injects a compact turn into live psu-pty hosts.
 *
 * Trust-the-agent design (D-008): the agent self-manages off the injected signal;
 * this catches the ones that don't. The force-compact rung below is the active
 * mechanical safety net for sessions that miss the nudge.
 *
 * Process-level (NOT a DBOS routine), like the git-sync / green / mcp-dark
 * watchdogs. Kill-switch: PAPERCUSP_COMPACTION_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  codexReadingProvenanceForOwner,
  detectContextDeathForOwner,
  detectToolReferenceDeathForOwner,
  estimateContextTokensForOwner,
  estimateContextWindowForOwner,
  observedPromptFloorForOwner,
  resolveLaunchCompactionLimitForOwner,
  resolveModelSpecForOwner,
  resolveSessionRefReconciled,
} from '../compaction-usage';
import { clearContextEstimate, setContextEstimate, setCompactionLimit } from '../agent-tools/coordination/presence';
import {
  COMPACTION_LIMIT_DEFAULT_1M_CAP,
  COMPACTION_OVERSHOOT_FACTOR,
  COMPACTION_WINDOW_MARGIN_TOKENS,
  clampCompactionLimit,
  defaultCompactionLimitForSpec,
  defaultCompactionLimitForWindow,
  selfSetCeilingForWindow,
  supersededDerivedCompactionLimits,
  MODEL_WINDOW_1M,
  modelWindowForSpec,
  type ModelTier,
} from '../agent-config-constants';
import { listActiveClaimFreshnessForOwner } from '../work-item-claims';
import { classifyStaleClaims, type StaleClaim } from '../agent-tools/coordination/tools/inbox-flush-gate';
import { recordContextUsage, setContextGaugeEnabled } from './context-usage-cache';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from '../agent-tools/coordination/compaction-recovery';
import { addressContinuationToOwner } from '../carry-respawn-addressing';

/** How often the watchdog sweeps. Off the hot path, so a relaxed cadence. */
const DEFAULT_INTERVAL_MS = 2 * 60_000; // 2 min
/** At/over this fraction of the limit ⇒ the agent should have compacted already —
 *  the WARN + surface band (over-limit log, unflushed-claim surfacing). */
const OVER_LIMIT_FRACTION = 1.0;
/** The P-012 FORCE-COMPACT rung fires only past this fraction of the limit (owner
 *  directive 2026-07-04: let an agent run a little over before the watchdog seizes
 *  the turn — the soft limit is a nudge target, not a hard wall). ALWAYS capped at
 *  the hard window − margin: 130% of the 158k default on a 200k window is ~205k,
 *  PAST the window, so an uncapped force would fire only after the session died on
 *  "Prompt is too long" — the cap forces at ~190k instead. Window unresolvable ⇒
 *  fall back to limit × COMPACTION_OVERSHOOT_FACTOR, the bound clampCompactionLimit
 *  already guarantees safe for whatever window legally produced that limit. */
const FORCE_COMPACT_FRACTION = 1.3;
/** EI-9982 retry-undelivered-force grace: once a force-compact inject SOCKET-ACKS,
 *  the watchdog stops re-injecting until the session recovers below its soft limit —
 *  on the assumption the `/compact` actually ran. But the inject is idle-gated
 *  host-side (it runs AFTER the current turn), so a session that IGNORES the nudge
 *  and keeps taking turns back-to-back (the EI-9982 probe: 14.8× the soft limit,
 *  "continuously taking turns") can have its single queued `/compact` deferred — or
 *  dropped — and never actually compact, leaving the watchdog PERMANENTLY silent
 *  (est never drops, so the recovery re-arm never fires). A landed compaction shows
 *  up in the tail-scan estimate immediately (tokensFromFileSize counts from the last
 *  compaction marker), so a session STILL at/over its force threshold this long after
 *  a successful inject has PROVEN the prior force did not land — re-inject. Sized to a
 *  few sweeps (≫ a normal compaction's land-time) so a genuinely in-progress compaction
 *  is never double-injected. */
const FORCE_RETRY_GRACE_MS = 6 * 60_000; // ~3 sweeps
/** EI-7632 stale-window guard: a LIVE session estimating ≥ this × the resolved window
 *  has DISPROVEN the resolution — a session genuinely past its window dies on "Prompt
 *  is too long" (P-019 owns that), it doesn't keep taking turns. The window inputs are
 *  box-shared and mutable (an argv-less session resolves through the settings.json
 *  symlink to the SHARED box default, which a mid-session /model toggle rewrites for
 *  all ~46 sessions at once — the 2026-07-05 incident: a 676k-est [1m] session
 *  window-resolved at 200k and force-noted nonsense numbers). est is bytes/4 and can
 *  overshoot real tokens ~1.5–2×, so require the full 2× before distrusting. */
const WINDOW_CONTRADICTED_FACTOR = 2;
/** Max limit-less live sessions seeded per pass — bounds fs/PG work per sweep. */
const MAX_SEEDS_PER_PASS = 25;

/**
 * D-137: two completed `session:compacted:<owner>` boundaries are the minimum
 * durable evidence that a session has repeatedly crossed a compaction boundary.
 * A single fire is normal; the detector below only considers the repeated case.
 */
export const D137_REPEATED_COMPACTION_THRESHOLD = 2;
/** Alias kept descriptive for callers that reason in terms of boundary fires. */
export const REPEATED_COMPACTION_BOUNDARY_THRESHOLD = D137_REPEATED_COMPACTION_THRESHOLD;

/** EI-10434 defense-in-depth, rung 2 (independent of the compaction-usage.ts
 *  root-cause fix — a bounded-scan misread — so a FUTURE misread source is
 *  caught the same way): a reading past this many × MODEL_WINDOW_1M is
 *  PHYSICALLY IMPOSSIBLE — no shipped model has ever had a window that large
 *  (MODEL_WINDOW_1M is the largest window this platform ever assigns; a
 *  per-owner window resolution is deliberately NOT needed here — a reading
 *  this far past the platform-wide MAXIMUM is impossible for every session,
 *  not just one owner's, so this is a cheap in-memory comparison, no DB
 *  round-trip). Discarded and re-sampled next sweep — never acted on: not
 *  cached, not counted toward overLimit, never force-compacted. This is
 *  DELIBERATELY stricter than "never act on a single anomaly" (the informal
 *  framing that motivated it) — it discards EVERY implausible reading, not
 *  just the first, because a genuinely-impossible number is never trustworthy
 *  no matter how many times it repeats; a session that is actually near its
 *  real limit will report a real (sub-ceiling) reading on recovery, so this
 *  can never durably suppress a legitimate crossing. */
const IMPLAUSIBLE_READING_FACTOR = 2;
/** The absolute plausibility ceiling: no live session should EVER read above
 *  this many tokens. (2 × 1,000,000 = 2,000,000.) */
const IMPLAUSIBLE_READING_ABSOLUTE_CEILING = MODEL_WINDOW_1M * IMPLAUSIBLE_READING_FACTOR;

/** In-memory escalation dedup: warn only on the FIRST crossing; clear on recovery. */
const overLimitOwners = new Set<string>();

/** P-019 context-death dedup: one fallback coord escalation per dead owner per process. */
const contextDeathEscalated = new Set<string>();

/** P-012 force-compact dedup + EI-9982 retry: owner → last SUCCESSFUL force-inject
 *  ms. Suppresses a duplicate inject within FORCE_RETRY_GRACE_MS of a socket-ack'd
 *  one (the P-012 "once per crossing" intent), but ALLOWS a re-inject once that grace
 *  elapses IF the session is still at/over its force threshold (proof the prior
 *  /compact never landed — EI-9982). Cleared when the owner recovers below its soft
 *  limit. A failed inject is NOT recorded, so it retries next pass. */
const forceCompactedAt = new Map<string, number>();

/** P-018 deterministic successor dedup. A socket ACK means the clean-boundary
 * lifecycle verb is queued in the host; suppress both duplicate respawns and the
 * older force-compact rung while that cut has a chance to land. */
const carryRespawnRequestedAt = new Map<string, number>();

/** WI-5075 rapid-refire guard: owner → consecutive carry-respawns fired without a
 *  SUSTAINED recovery below its limit in between. A landed cut can produce a
 *  transient under-limit successor sample; that sample is retained as churn
 *  evidence instead of re-arming the breaker.
 *
 *  ⚠ WI-38347 leg 4 — "never recovered BELOW ITS LIMIT" is NOT the same claim as
 *  "the estimate never dropped", and the original guard conflated them. It read a
 *  streak as proof that the estimate is not tracking the live session, but it never
 *  compared one estimate to another: the streak increments purely on "a respawn
 *  returned true and this owner is over limit again on a later sweep". When the
 *  limit sits well below the model window, an owner whose cuts are ALL LANDING is
 *  over limit again within minutes, so the streak fires on healthy churn and blames
 *  a transcript-resolution defect (measured 2026-08-13: codex su sessions open at
 *  ~50k, burn ~10k/min, and re-crossed a 158,000 limit in 5–18 min while every cut
 *  landed correctly). `estAtFirstCut` + `minEstSince` carry the evidence that
 *  actually separates the two cases — see {@link carryRespawnStreakVerdict}. */
const carryRespawnStreak = new Map<
  string,
  {
    count: number;
    lastAt: number;
    /** Compaction limit in effect when this streak was started. */
    limit: number;
    /** Estimate observed at the FIRST cut of this streak — the baseline a later
     *  observation has to fall below for the cut to have demonstrably landed. */
    estAtFirstCut: number;
    /** Lowest estimate observed on ANY sweep since that first cut. */
    minEstSince: number;
  }
>();
/** One loop-detected escalation per owner per process; un-deduped on failure. */
const carryRespawnLoopEscalated = new Set<string>();
/** EI-237397: one durable escalation per owner when the observed fixed prompt
 * floor is already at/above the configured soft limit. A cut cannot reduce a
 * fixed floor, so repeatedly respawning such a session is a livelock. */
const unsatisfiableLimitEscalated = new Set<string>();
/** First under-limit observation in the current carry-respawn streak. A single
 * under-limit sample can be the fresh successor booting after a landed cut, so
 * it does not clear the breaker; only a sustained recovery re-arms it. */
const carryRespawnUnderLimitSince = new Map<string, number>();
/** Streak trips at this many respawns without a sustained recovery below the limit.
 *  ⚠ WI-38347: this threshold detects "not recovering", which is NOT by itself
 *  evidence of a broken estimate — the claim this comment used to make ("impossible
 *  for a genuinely-refilling session") is false whenever the limit sits well below
 *  the window, because a fresh successor is then back over the limit in minutes.
 *  Trip on this, then let {@link carryRespawnStreakVerdict} say WHICH failure it is. */
const CARRY_RESPAWN_MAX_STREAK = 3;
/** A streak entry older than this is stale history, not an active loop. */
const CARRY_RESPAWN_STREAK_WINDOW_MS = 30 * 60_000;
/** WI-38347 leg 4: how far the estimate must FALL, in tokens, for a cut to count as
 *  demonstrably landed.
 *
 *  ⚠ An earlier draft of this used a FRACTION of the first-cut estimate (≤85%). That
 *  is unreachable by construction and would have made the churn branch dead code:
 *  only OVER-LIMIT sweeps are ever sampled (a reading below the limit clears the
 *  streak outright), so every sample is bounded below by the limit — and when the
 *  first-cut estimate is near the limit, as it usually is, no admissible reading can
 *  be 15% under it. The discriminating question is not "how far did it fall" but
 *  "did this number MOVE AT ALL": a pinned estimate is re-read from the same
 *  transcript tail and comes back EXACTLY equal, sweep after sweep, whereas any real
 *  cut moves it. So this is a small absolute floor — above read-to-read noise, and
 *  reachable from any first-cut estimate. */
const CARRY_RESPAWN_MOVED_MIN_TOKENS = 5_000;

/** Headroom above an observed prompt floor before a repaired soft limit may
 * become actionable. Rounded limits keep the gauge stable and leave room for
 * one small turn after the fixed prefix. */
export const UNSATISFIABLE_LIMIT_HEADROOM_TOKENS = 10_000;

/** Derive a model-safe limit that sits above a measured fixed prompt floor.
 * Returns null when no model window is known or the requested floor cannot fit
 * under the platform's hard window. This helper intentionally ignores the
 * lean fleet-member role cap: that cap is a spend default, but a limit below a
 * proven fixed floor makes every carry/force cut repeat forever (EI-237397). */
export function satisfiableCompactionLimitForPromptFloor(
  promptFloorTokens: number,
  windowTokens: number | null,
  currentLimit: number,
): number | null {
  if (
    !Number.isFinite(promptFloorTokens) ||
    promptFloorTokens < 0 ||
    !Number.isFinite(currentLimit) ||
    currentLimit <= 0 ||
    windowTokens == null ||
    !Number.isFinite(windowTokens) ||
    windowTokens <= 0
  ) return null;
  const required = Math.ceil((promptFloorTokens + UNSATISFIABLE_LIMIT_HEADROOM_TOKENS) / 1000) * 1000;
  // A member's 250k role cap is a spend default, not a hard safety ceiling:
  // once the fixed floor is measured above it, retaining that cap guarantees a
  // respawn loop. Use the full self-set window ceiling for this repair, while
  // preserving the member-shaped default when no repair is needed.
  const ceiling = selfSetCeilingForWindow(windowTokens, { fleetMember: false });
  if (required > ceiling || required <= currentLimit) return null;
  return Math.max(required, defaultCompactionLimitForWindow(windowTokens, { fleetMember: false }));
}

/** EI-237397: fixed prompt/carry context already consumes the force band, so
 * another carry-respawn cannot make progress. Keep the condition durable and
 * owner-addressable instead of emitting the ordinary "self-compact" nudge. */
async function escalateUnsatisfiableCompactionLimit(input: {
  ownerId: string;
  ownerLabel: string;
  estimate: number;
  fixedFloor: number;
  limit: number;
  forceAt: number;
  window: number | null;
}): Promise<void> {
  if (unsatisfiableLimitEscalated.has(input.ownerId)) return;
  unsatisfiableLimitEscalated.add(input.ownerId);
  const windowText = input.window == null ? 'unknown model window' : `${input.window}-token model window`;
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      {
        severity: 'blocker',
        summary: `soft compaction limit below fixed context cost: ${input.ownerLabel} (${input.ownerId})`,
        body:
          `The session's measured fixed/post-compaction context floor is ~${Math.round(input.fixedFloor)} ` +
          `tokens, already at/above the FORCE threshold ~${Math.round(input.forceAt)} for its ` +
          `configured soft limit ${Math.round(input.limit)} (${windowText}). Another carry-respawn ` +
          `would recreate the same floor and livelock. Raise the soft limit toward the model ceiling ` +
          `or reduce the fixed launch context before allowing another cut. (EI-237397)`,
        meta: {
          subjectSignature: `compaction-watchdog:unsatisfiable-limit:${input.ownerId}`,
          estimate: Math.round(input.estimate),
          fixedFloor: Math.round(input.fixedFloor),
          limit: Math.round(input.limit),
          forceAt: Math.round(input.forceAt),
          window: input.window,
        },
      },
    );
  } catch (e) {
    unsatisfiableLimitEscalated.delete(input.ownerId);
    console.warn(
      `[compaction-watchdog] unsatisfiable-limit escalation failed (will retry): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** The evidence a streak carries about whether its cuts were landing. */
export interface CarryRespawnStreakEvidence {
  /** Estimate at the first cut of the streak. */
  estAtFirstCut: number;
  /** Lowest estimate observed on any over-limit sweep since that cut. */
  minEstSince: number;
  /** The owner's configured compaction limit. */
  limit: number;
  /** The resolved model window, or null when it could not be established. */
  window: number | null;
}

/**
 * WI-38347 leg 4: did this streak's cuts LAND (`'churn'`) or did the estimate
 * never move (`'pinned'`)?
 *
 * `'pinned'` is the conservative default — it is returned when there is no
 * evidence at all, so an un-instrumented caller keeps the pre-leg-4 diagnosis
 * rather than silently acquiring a churn verdict nothing measured.
 */
export function carryRespawnStreakVerdict(
  evidence: CarryRespawnStreakEvidence | null | undefined,
): 'churn' | 'pinned' {
  if (evidence == null || !(evidence.estAtFirstCut > 0)) return 'pinned';
  return evidence.minEstSince <= evidence.estAtFirstCut - CARRY_RESPAWN_MOVED_MIN_TOKENS
    ? 'churn'
    : 'pinned';
}

/** EI-9982 diagnostic dedup: warn ONCE per owner when findLiveHost() returns null on the
 *  force-compact path. Before this, a no-live-host miss was completely silent — indistinguishable
 *  from (a) the flag being off, (b) the FORCE_RETRY_GRACE_MS suppression window, or (c)
 *  injectIntoHost() itself failing — so a session that was continuously taking turns yet never
 *  force-compacted (the reported symptom) left no signal to diagnose from. findLiveHost() reading
 *  a stale/missing ~/.papercusp/psu-pty/<ownerId>.json discovery file is the same fragility class
 *  as EI-9748 (headless-fleet-boot-death) / WI-3455 (discovery-key-stranding). Cleared on recovery
 *  alongside overLimitOwners/forceCompactedAt so a later crossing re-warns. */
const noHostWarned = new Set<string>();

/** P-018 boot self-assert: one advisory escalation per owner per defect-class per
 *  process (key `${ownerId}:${kind}`). The 2026-07-04 incident's dark-telemetry defect
 *  (a live member whose context estimate never resolved) was latent FROM BOOT and survived
 *  hours silently — this asserts it per member and surfaces the failure. (compaction_limit
 *  sanity is covered upstream: P-016 seeds the tier-aware default, P-017 lowers any >cap
 *  drift, so a boot-time limit re-assert here would be redundant.) */
const bootConfigEscalated = new Set<string>();
/** P-018 dark-telemetry counter: consecutive sweeps a live limit-carrying session's
 *  context estimate stayed null. Cleared when it resolves. */
const nullEstimateStreak = new Map<string, number>();

/** EI-10434: warn ONCE per owner while its readings stay implausible; cleared
 *  the moment a plausible reading is seen again so a later genuine crossing
 *  re-warns. Mirrors the overLimitOwners dedup pattern. */
const implausibleWarned = new Set<string>();

/** Test seam (EI-10434). */
export function resetImplausibleReadingsForTests(): void {
  implausibleWarned.clear();
}
/** P-018 dark-telemetry: escalate after this many consecutive null estimates. A
 *  normally-booting session reads null for a sweep or two (transcript not yet on
 *  disk); 3 sweeps (~6min) of grace keeps a healthy boot from tripping it, while a
 *  session that stays BLIND — the gauge / per-turn reminder / force-compact all can't
 *  see its usage, the "dark telemetry latent from boot" defect — gets surfaced. */
const DARK_TELEMETRY_MAX_NULL_SWEEPS = 3;

/**
 * WI-2140608 — a null sweep advances the dark-telemetry streak ONLY when the session was
 * ACTIVE inside this window (its `last_active_at`, which the 60s keepalive beat never bumps —
 * see CODEX_FROZEN_READING_MAX_LAG_MS). The P-018 hazard is a session CONSUMING context while
 * blind; a blind session that takes no turns cannot overflow anything. Measured 2026-09-01
 * (292 open dark-telemetry rows = ~146 distinct owners/day, 70% codex, one row per owner —
 * the PG dedup was never the problem): the flag fired a median 2–3h after the owner's first
 * session, never "since boot", and 38 of the 54 still-present owners had a RESOLVED estimate
 * again — the null was a transient idle stretch (a carry-respawn successor parked until its
 * wake, a codex rollout stalled at a walled account before its first token_count) that the
 * old "3 consecutive null sweeps" rule read as blindness. 5min = 2.5 sweeps: an idle session
 * falls out of the window inside one sweep; a session mid-turn (every tool dispatch bumps
 * last_active_at) never does.
 */
const DARK_TELEMETRY_ACTIVE_WINDOW_MS = 5 * 60_000;

function activeWithin(lastActiveAt: string | null | undefined, windowMs: number, nowMs = Date.now()): boolean {
  if (!lastActiveAt) return false;
  const t = Date.parse(lastActiveAt);
  return Number.isFinite(t) && nowMs - t <= windowMs;
}

/**
 * EI-21595542328480968 — how far a codex rollout's mtime may lag the session's OWN
 * `last_active_at` before the reading taken from it is treated as FROZEN (belonging
 * to a dead predecessor) rather than as this session's usage.
 *
 * The defect: codex homes are keyed by the adv_sessions ROW id, so an owner holding
 * more than one non-ended row can have its estimate read out of a DEAD predecessor's
 * home. That file never moves again, so the reading is pinned above the limit
 * forever — the force/carry-respawn rung below fires every grace expiry, never sees
 * recovery, and eventually SELF-SUPPRESSES, leaving a live over-limit session with
 * its backstop disarmed. That end state was observed on a real session.
 *
 * The margin is drawn from the measured population, not from the handful of sessions
 * that led to the defect (133 live codex sessions, 2026-08-27): the lag is NEGATIVE
 * for healthy sessions — the rollout is written at least as recently as the last tool
 * dispatch — with p50 −0.2min, p95 ≈ 0, and only 3 of 133 above +5min. 15min sits ~5×
 * above the largest healthy positive lag and ~6× below the 90.7min pathology, and is
 * comfortably wider than any single long turn (which can bump `last_active_at`
 * repeatedly before codex writes its next token_count event).
 *
 * ⚠ `last_active_at` is load-bearing and only works because the 60s keepalive beat
 * does NOT touch it (presence.ts D-003: `touchHeartbeat` bumps heartbeat_at ONLY).
 * An idle session therefore has an OLD last_active_at and so a small lag — which is
 * exactly the class that sank the first attempt at this fix.
 */
const CODEX_FROZEN_READING_MAX_LAG_MS = 15 * 60_000;

/** Owners already warned about a frozen codex reading (dedup; per process). */
const frozenCodexWarned = new Set<string>();

/** Test seam (EI-21595542328480968). */
export function resetFrozenCodexReadingsForTests(): void {
  frozenCodexWarned.clear();
}

/** D-137 escalation dedup. The durable escalation subject signature is the
 * cross-process backstop; this set keeps one watchdog process from repeatedly
 * logging/opening the same still-active condition on every sweep. */
const compactionStrandingEscalated = new Set<string>();

/** Test seam (D-137). */
export function resetCompactionStrandingForTests(): void {
  compactionStrandingEscalated.clear();
}

/**
 * Is this codex owner's context reading FROZEN — read from a rollout that belongs to
 * a different (dead) session and has not moved since well before this session's own
 * last activity? Returns the evidence when so, else null.
 *
 * BOTH conjuncts are required, and each excludes a class the other cannot:
 *  • IDENTITY (`rolloutSessionId !== refSessionId`) — the file is not this session's.
 *    Alone it is far too broad: measured 2026-08-27, it holds for 19 of 133 live codex
 *    sessions, 18 of them healthy, because an IDLE session's ref legitimately churns
 *    its native id past a rollout nobody has written to since.
 *  • LIVENESS (`lag > CODEX_FROZEN_READING_MAX_LAG_MS`) — the session has been doing
 *    work since that file stopped moving, which an idle session never shows.
 * A null id on either side means "cannot check", never "mismatch" — so an unparseable
 * filename degrades to trusting the reading, the safe direction.
 *
 * ⚠ THE CALL SITE IS PART OF THE FIX: this runs ONLY for a reading that is already
 * over its limit and therefore about to drive a cut. That placement is what makes the
 * rule safe rather than merely accurate — one live session (under limit, actively
 * working) satisfies BOTH conjuncts above and would be wrongly silenced if this were
 * evaluated for every session. Do not hoist it to the whole population.
 */
export async function frozenCodexReading(
  ownerId: string,
  lastActiveAt: string | Date | null,
): Promise<{ lagMs: number; rolloutPath: string } | null> {
  if (lastActiveAt == null) return null;
  const lastActiveMs = new Date(lastActiveAt).getTime();
  if (!Number.isFinite(lastActiveMs)) return null;
  const prov = await codexReadingProvenanceForOwner(ownerId).catch(() => null);
  if (!prov || prov.rolloutMtimeMs == null) return null;
  if (prov.rolloutSessionId == null || prov.refSessionId == null) return null;
  if (prov.rolloutSessionId === prov.refSessionId) return null;
  const lagMs = lastActiveMs - prov.rolloutMtimeMs;
  if (lagMs <= CODEX_FROZEN_READING_MAX_LAG_MS) return null;
  return { lagMs, rolloutPath: prov.rolloutPath };
}

/** Test seam (P-019). */
export function resetContextDeathEscalationsForTests(): void {
  contextDeathEscalated.clear();
}

/** Test seam (P-012 / EI-9982). */
export function resetForceCompactedForTests(): void {
  forceCompactedAt.clear();
}

/** Test seam (P-018 live carry-respawn). */
export function resetCarryRespawnForTests(): void {
  carryRespawnRequestedAt.clear();
  carryRespawnStreak.clear();
  carryRespawnLoopEscalated.clear();
  carryRespawnUnderLimitSince.clear();
  unsatisfiableLimitEscalated.clear();
}

/** Test seam (EI-9982 diagnostic). */
export function resetNoHostWarnedForTests(): void {
  noHostWarned.clear();
}

/** Test seam (P-018). */
export function resetBootConfigAssertForTests(): void {
  bootConfigEscalated.clear();
  nullEstimateStreak.clear();
}

/**
 * P-019 member-death detector: a session whose transcript tail carries the
 * "Prompt is too long" window-overflow error is DEAD (it cannot take another
 * turn — a single-exchange overflow cannot be compacted), and it died
 * SILENTLY: presence keeps beating until the process reaps, so leaders see
 * "alive" while nothing works (6 fleet members died this way on 2026-07-01).
 * Attempt the deterministic carry-respawn path first; if no live capable host can
 * accept it, raise ONE coord escalation per dead owner so the leader/owner can
 * relaunch it (fleet persona tier / trimmed context / a wider-window model).
 */
/** The transcript deaths the watchdog recovers with a forced carry-respawn. */
type TranscriptDeathKind = 'context-death' | 'tool-reference-death';
type CarryRespawnReason = 'soft-threshold' | TranscriptDeathKind;

/** Per-kind dedup key; context-death keeps the bare owner id it always used. */
function transcriptDeathKey(ownerId: string, kind: TranscriptDeathKind): string {
  return kind === 'context-death' ? ownerId : `${kind}:${ownerId}`;
}

async function escalateContextDeath(
  ownerId: string,
  ownerLabel: string,
  kind: TranscriptDeathKind = 'context-death',
): Promise<void> {
  const key = transcriptDeathKey(ownerId, kind);
  if (contextDeathEscalated.has(key)) return;
  contextDeathEscalated.add(key);
  const toolRef = kind === 'tool-reference-death';
  console.warn(
    toolRef
      ? `[compaction-watchdog] ${ownerLabel} (${ownerId}) is STRANDED on repeated unavailable-tool-reference rejections and could not be carry-respawned — escalating for relaunch (WI-10003466).`
      : `[compaction-watchdog] ${ownerLabel} (${ownerId}) DIED on "Prompt is too long" — escalating for relaunch (P-019).`,
  );
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    // Synthetic system identity — the steering-lease precedent shape.
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      toolRef
        ? {
            severity: 'blocker',
            summary: `session ${ownerLabel} (${ownerId}) is stranded: every turn is rejected because its transcript references a tool that is no longer available — it cannot take another turn`,
            body:
              `The transcript ends in consecutive provider rejections of a saved tool reference (typically its MCP connection dropped and the client removed that server's tools), ` +
              `so every wake fails while presence keeps beating. No live carry-respawn-capable psu host accepted a fresh-context successor. ` +
              `Relaunch it (psu --resume re-seeds the referenced tools, or a fresh session) — its claims are reclaimable via the stale-claim lane. (WI-10003466)`,
            meta: { subjectSignature: `compaction-watchdog:tool-reference-death:${ownerId}` },
          }
        : {
            severity: 'blocker',
            summary: `fleet member ${ownerLabel} (${ownerId}) died on "Prompt is too long" — context overflowed its model window; it cannot take another turn`,
            body:
              `The session's transcript ends in the window-overflow API error, so every subsequent wake fails silently while presence keeps beating. ` +
              `Relaunch it (fleet:launch-on-plan / psu) with less baseline context: --persona-tier=fleet, --context-size=trimmed, or a wider-window ([1m]) model. ` +
              `Its claims are reclaimable via the stale-claim lane. (context-trimming-tiers-2026-07-01 P-019)`,
            // WI-5848 (sweep of EI-18668025239634541's class): the in-memory
            // contextDeathEscalated Set is the only guard here, and it resets on a
            // process restart — a stable conditionKey is durable defense-in-depth
            // across restarts (this summary happens to already be restart-stable
            // since it embeds no varying count, but the conditionKey removes any
            // future risk if the summary is ever edited to add one).
            meta: { subjectSignature: `compaction-watchdog:context-death:${ownerId}` },
          },
    );
  } catch (e) {
    // Best-effort — never fail the sweep; un-dedup so the next pass retries.
    contextDeathEscalated.delete(key);
    console.warn(
      `[compaction-watchdog] ${kind} escalation failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * P-018 boot self-assert (agent-managed-compaction-2026-07-01): raise ONE advisory
 * coord escalation per owner per defect-class when a live member fails a critical-config
 * assertion — a too-high compaction_limit seed (compacts too late for its tier), dark
 * context telemetry (the watchdog/gauge/force-compact are BLIND to its usage), or a
 * dark-presence gap (EI-18127246030401689: the session has NO coord_presence row at all,
 * so it is invisible to every layer above, not merely blind on one estimate), or a
 * frozen codex reading (EI-21595542328480968: its estimate is being read out of another
 * session's dead rollout, so the number is real but belongs to someone else). All
 * defects were latent from boot and survived hours silently; surfacing them (D-008:
 * surface, don't seize) lets a leader/owner fix or relaunch. Advisory band ⇒ self-clears
 * once stale. Deduped + best-effort — never fails the sweep; a failed escalation un-dedups
 * to retry next pass.
 */
async function escalateBootConfig(
  ownerId: string,
  ownerLabel: string,
  kind: 'dark-telemetry' | 'dark-presence' | 'frozen-codex-reading',
  summary: string,
  body: string,
): Promise<void> {
  const key = `${ownerId}:${kind}`;
  if (bootConfigEscalated.has(key)) return;
  bootConfigEscalated.add(key);
  console.warn(`[compaction-watchdog] ${ownerLabel} (${ownerId}) boot-config assert FAILED (${kind}) — ${summary} (P-018).`);
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      {
        severity: 'advisory',
        summary,
        body,
        // WI-5848 (sweep of EI-18668025239634541's class): `summary` embeds a
        // LIVE streak/duration for the dark-telemetry kind (`${streak}
        // watchdog sweeps (~Nmin)`), so it varies across occurrences for the
        // SAME owner+kind exactly like the fixed lifecycle-death bug — the
        // in-memory `bootConfigEscalated` guard is the only thing preventing a
        // leak, and it resets on a process restart. `key` (already computed
        // above for that guard) is stable across occurrences — reuse it.
        meta: { subjectSignature: `compaction-watchdog:boot-config:${key}` },
      },
    );
  } catch (e) {
    bootConfigEscalated.delete(key);
    console.warn(
      `[compaction-watchdog] boot-config escalation failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * WI-2140608 — the other half of escalateBootConfig: when the condition CLEARS (the owner's
 * estimate resolves again) resolve the open advisory row and re-arm the guard. Without this
 * every transient dark stretch left its row open until the 48h operational reaper — measured
 * 2026-09-01: 38 of the 54 still-present flagged owners had a resolved estimate while their
 * escalation sat open. Guard-keyed per process like escalateBootConfig, so a row raised by a
 * PREVIOUS bg-host process is not looked up here (the reaper still owns that tail) and a
 * steady-state resolved session never touches the escalation store. Best-effort: a failed
 * lookup/resolve keeps the key so the next pass retries.
 */
async function recoverBootConfig(
  ownerId: string,
  kind: 'dark-telemetry',
  out: CompactionComplianceResult,
): Promise<void> {
  const key = `${ownerId}:${kind}`;
  if (!bootConfigEscalated.has(key)) return;
  const subjectSignature = `compaction-watchdog:boot-config:${key}`;
  try {
    const { listEscalations, resolveEscalation } = await import('../agent-tools/coordination/escalations');
    // openEscalation spreads `meta` FLAT onto the record, so the key sits at the top level.
    const open = (await listEscalations({ status: 'open' })).find(
      (rec) =>
        rec.from === 'compaction-watchdog' &&
        (rec as Record<string, unknown>).subjectSignature === subjectSignature,
    );
    if (open) {
      await resolveEscalation({
        msg_id: open.msg_id,
        choice: 'recovered',
        resolver: 'compaction-watchdog',
        note: `${kind} recovered: the session's context estimate resolves again, so the gauge, the per-turn reminder and the force-compact backstop can see it (WI-2140608).`,
      });
    }
    bootConfigEscalated.delete(key);
    out.bootConfigRecovered.push({ owner: ownerId, kind });
  } catch (e) {
    console.warn(
      `[compaction-watchdog] boot-config recovery failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** A live limit-setting session discoverable ONLY via its active loop routine —
 *  it carries no coord_presence row at all. See {@link discoverPresencelessLoopOwners}. */
export interface PresencelessLoopOwner {
  ownerId: string;
  workspaceId: string | null;
}

/**
 * EI-18127246030401689 (dark-presence gap): discover LIVE limit-setting sessions via
 * their ACTIVE loop routine (harness_shared.routines — `reschedule_interval_sec IS NOT
 * NULL` is the loop signature per 323-loop-routines-reschedule-interval.sql,
 * `target_owner_id` is the coord ownerId the loop wakes) that carry NO coord_presence
 * row at all.
 *
 * The seed/estimate/force-compact passes in {@link checkCompactionCompliance} scan
 * ONLY `coord_presence` (`WHERE compaction_limit IS NOT NULL/IS NULL ... heartbeat_at
 * > now() - interval '10 minutes'`), so a session in this class is COMPLETELY invisible
 * to every layer of the compaction backstop — not merely blind on one estimate (the
 * pre-existing dark-telemetry case, which still requires a presence row to even be
 * considered). This is exactly the blind spot that let su-43803a4c ride a warm loop
 * from 77k to 974k tokens over ~7h and die on "Prompt is too long" while the watchdog
 * correctly caught every OTHER over-limit session that same night (su-b00d5, tracked
 * via its own presence row, was force-carry-respawned as designed).
 *
 * A `loop:arm`'d routine only exists for a session with a resolvable coord identity
 * that is genuinely being woken — so a presence-less active-loop owner is ALWAYS
 * anomalous, never a false positive to filter out. Uses the partial index
 * `routines_loop_interval_idx` (WHERE reschedule_interval_sec IS NOT NULL), so this
 * scan stays cheap regardless of how many cron/rrule routines exist. Best-effort:
 * a query failure returns an empty list (never blocks the rest of the sweep).
 */
export async function discoverPresencelessLoopOwners(sql: Sql): Promise<PresencelessLoopOwner[]> {
  try {
    const rows = await sql<{ owner_id: string; workspace_id: string | null }[]>`
      SELECT DISTINCT r.target_owner_id AS owner_id, r.workspace_id
        FROM harness_shared.routines r
        LEFT JOIN harness_shared.coord_presence cp ON cp.owner_id = r.target_owner_id
       WHERE r.active = true
         AND r.reschedule_interval_sec IS NOT NULL
         AND r.target_owner_id IS NOT NULL
         AND cp.owner_id IS NULL
       LIMIT ${MAX_SEEDS_PER_PASS}
    `;
    return rows.map((r) => ({ ownerId: r.owner_id, workspaceId: r.workspace_id }));
  } catch {
    return [];
  }
}

/**
 * Best-effort display label for an owner id that has no presence row to read one
 * from. `harness_shared.fleet_membership_events` is an APPEND-ONLY fact table
 * stamped at spawn/boot time (named-su-agent-fleets-2026-06-29), independent of
 * coord_presence, so a fleet member's label often survives here even after its
 * presence row is gone. Falls back to the ownerId itself (label is display-only,
 * never keyed on — AgentIdentity's own contract).
 */
async function resolveBestEffortOwnerLabel(sql: Sql, ownerId: string): Promise<string> {
  try {
    const rows = await sql<{ owner_label: string | null }[]>`
      SELECT owner_label FROM harness_shared.fleet_membership_events
       WHERE owner_id = ${ownerId} AND owner_label IS NOT NULL
       ORDER BY id DESC LIMIT 1
    `;
    return rows[0]?.owner_label || ownerId;
  } catch {
    return ownerId;
  }
}

/**
 * Self-heal a MINIMAL coord_presence row for a presence-less active-loop owner (see
 * {@link discoverPresencelessLoopOwners}) so it re-enters the SAME sweep's normal
 * seed/estimate machinery: `writePresence` never sets `compaction_limit` on write (it
 * is not in its column list — packages/coordination/src/presence/pg-store.ts), so the
 * freshly-created row's limit stays NULL and is picked up by the very next "Seeding
 * step" query below within this SAME pass; `estimateContextTokensForOwner` resolves
 * the session ref via `harness_shared.adv_sessions` (resolveSessionRefReconciled),
 * entirely independent of coord_presence, so estimation works immediately once a
 * limit is seeded.
 *
 * ALSO escalates once per owner (dedup shared with the dark-telemetry rung above) so
 * the underlying "why did this row go missing" stays visible for follow-up —
 * self-healing must only shrink the blast radius, never hide the defect class.
 * Best-effort: a failed heal write is logged and retried next sweep (the owner stays
 * in `discoverPresencelessLoopOwners`' result until a row exists); the escalation
 * still fires regardless, since the gap itself was already real.
 */
async function healPresenceGap(sql: Sql, gap: PresencelessLoopOwner): Promise<boolean> {
  const ownerLabel = await resolveBestEffortOwnerLabel(sql, gap.ownerId);
  let healed = false;
  try {
    const { writePresence } = await import('../agent-tools/coordination/presence');
    await writePresence(
      { ownerId: gap.ownerId, ownerLabel, source: 'omp-hook-session', workspaceId: gap.workspaceId, userId: null },
      {},
      null,
    );
    healed = true;
    console.warn(
      `[compaction-watchdog] HEALED a missing coord_presence row for ${ownerLabel} (${gap.ownerId}) — ` +
        `discovered via its ACTIVE loop routine with NO presence row at all (dark-presence gap, ` +
        `EI-18127246030401689). It will be seeded a default compaction limit and estimated starting ` +
        `this same sweep.`,
    );
  } catch (e) {
    console.warn(
      `[compaction-watchdog] presence-gap heal FAILED for ${ownerLabel} (${gap.ownerId}) — will retry next ` +
        `sweep: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await escalateBootConfig(
    gap.ownerId,
    ownerLabel,
    'dark-presence',
    `${ownerLabel} had an ACTIVE loop routine but NO coord_presence row — it was completely invisible to ` +
      `the compaction watchdog (dark-presence gap)`,
    `discoverPresencelessLoopOwners found harness_shared.routines target_owner_id=${gap.ownerId} active with ` +
      `reschedule_interval_sec set, but no matching coord_presence row. The seed/estimate/force-compact ` +
      `backstop scans ONLY coord_presence, so this session's context could grow unbounded with zero mechanical ` +
      `protection (the EI-18127246030401689 class: su-43803a4c rode a warm loop 77k→974k tokens and died on ` +
      `"Prompt is too long" this way). A minimal presence row has ${healed ? 'been' : 'NOT been (write failed — see log)'} ` +
      `self-healed so tracking resumes, but the underlying cause of the missing row (a reaper sweep during a ` +
      `stretch with no presence-writing tool call? a self-relaunch that broke the beat's target row? something ` +
      `else?) is NOT diagnosed by this alarm — investigate why this owner's row went missing / was never created ` +
      `in the first place. (agent-managed-compaction-2026-07-01 P-018 / EI-18127246030401689)`,
  );
  return healed;
}

// (The P-012 force-compact focus helpers lived here until P-022 retired native
// /compact — a forced cut now delivers the full carry-doc addendum instead of a
// summarizer focus hint, so no focus derivation is needed.)
/**
 * The polite soft-threshold cut still needs a REAL successor turn. The carry
 * document is context, not a wake source: when the last owner message was already
 * answered, RespawnLaunchSpec.firstPrompt is deliberately null. Passing that null
 * through as an empty string boots the fresh CLI and then parks it forever unless
 * a loop/event/human happens to wake it (WI-39942).
 */
function watchdogCarryContinueNote(reason: CarryRespawnReason): string {
  const opening =
    reason === 'context-death'
      ? 'The compaction watchdog detected that the previous session hit a model-window "Prompt is too long" error and moved you onto fresh context. '
      : reason === 'tool-reference-death'
        ? 'The compaction watchdog detected that the previous session was stranded — the provider rejected every turn because its ' +
          'transcript referenced a tool that was no longer available (usually its MCP connection dropped) — and moved you onto ' +
          'fresh context with a fresh MCP connection. Any in-flight command you started may still have completed: re-check its ' +
          'output/log before re-running it. '
        : 'The compaction watchdog moved this session onto fresh context at its configured soft threshold. ';
  return (
    opening +
    MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION +
    ' Then resume your current unit ' +
    'of work from the carry document. Anything the carry dropped remains searchable with ' +
    "sessions:search { session:'self', mode:'verbatim' }."
  );
}

/** Every watchdog-authored first prompt is machine-origin, never owner speech. */
async function tagWatchdogContinuation(ownerId: string, note: string): Promise<string> {
  const addressedNote = addressContinuationToOwner(note, ownerId);
  try {
    const { tagTurnForInjection } = await import('../turn-provenance/turn-provenance');
    return tagTurnForInjection({ sid: ownerId, origin: 'watchdog', text: addressedNote }).taggedText;
  } catch {
    return addressedNote; // provenance must never strand a context boundary
  }
}

/**
 * Flush the state that a watchdog-owned carry boundary would otherwise strand.
 * The watchdog cannot afford the deliberate P-016 bounce: at the soft/force
 * threshold it is already deciding the cut, and the current session may not
 * receive another model turn before the host replaces it. `mode:'forced'`
 * therefore writes the bounded mechanical fallback on its first tripwire,
 * while the agent-requested session:request-compaction path leaves the default
 * refuse-once ladder untouched.
 */
async function mechanicalPreflushForWatchdog(
  ownerId: string,
  ownerLabel: string,
  workspaceId: string,
): Promise<void> {
  try {
    const { runFlushGate } = await import('../enforcement-gate-io');
    const nowMs = Date.now();
    await runFlushGate({
      boundary: 'compaction',
      mode: 'forced',
      ownerId,
      workspaceId: workspaceId ?? '*',
      sessionId: ownerId,
      sinceIso: new Date(nowMs - 30 * 60_000).toISOString(),
      journalNote:
        `The compaction watchdog is cutting ${ownerLabel} on a context threshold; ` +
        `mechanically flush stale state before the carry-respawn.`,
      nowMs,
    });
  } catch {
    // The gate is fail-soft by contract; a missing/failed preflush must not
    // strand the watchdog's existing retry/backstop.
  }
}

/** Which arm of `min(limit × 1.3, window − margin | limit × 1.2)` produced forceAt —
 *  the note must name the bound that actually bound (a fixed "≈ 1.3 × soft limit"
 *  gloss renders false math whenever the window cap wins, e.g. "~190k ≈ 1.3 × 400k";
 *  owner 2026-07-05). */
type ForceBound = 'fraction' | 'window' | 'overshoot';
/** The continuation-turn text opened on the compacted context (WI-1804 auto-continue
 *  hosts) — re-orient first (a compaction is a stale-snapshot boundary). Built with
 *  the session's REAL numbers (owner 2026-07-05: the old static text read as "you were
 *  compacted for merely passing the soft limit", which contradicts the model — the
 *  soft limit is the configured NUDGE point; the watchdog seizes only past the FORCE
 *  threshold), naming whichever bound actually set it. */
function forceCompactContinueNote(est: number, limit: number, forceAt: number, bound: ForceBound): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const threshold =
    bound === 'fraction'
      ? `~${k(forceAt)} ≈ 1.3 × your configured soft limit of ${k(limit)}`
      : bound === 'window'
        ? `~${k(forceAt)} — the model-window cap (window − safety margin), which on this session ` +
          `binds below 1.3 × your soft limit of ${k(limit)}`
        : `~${k(forceAt)} — the conservative bound used when the model window is unknown ` +
          `(1.2 × your soft limit of ${k(limit)})`;
  // Window cap AT/BELOW the soft limit ⇒ the configured limit is unreachable on this
  // model and no self-compact band exists — the standard band advice would be
  // impossible to follow.
  const advice =
    bound === 'window' && forceAt <= limit
      ? `Your configured soft limit (~${k(limit)}) exceeds what this model's window allows, so ` +
        `there is no self-compact band — the window cap is the real ceiling. Self-compact ` +
        `(session:request-compaction) well before ~${k(forceAt)}, and lower the soft limit ` +
        `(config:set-compaction-limit) so the nudge fires in time.`
      : `The soft limit itself is only the nudge point — you should self-compact ` +
        `(session:request-compaction) at a clean stopping point anywhere between it and the FORCE ` +
        `threshold; the watchdog seizes the turn only when that band is exhausted.`;
  return (
    `The compaction watchdog force-compacted you: your context (~${k(est)} tokens) crossed the ` +
    `FORCE threshold (${threshold}). ${advice} This is a fresh turn on the ` +
    `compacted context. ${MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION} ` +
    `Then resume your current unit of work.`
  );
}

/**
 * WI-38347: the escalation body is BACKEND-SPECIFIC, because the diagnosis is.
 *
 * The original WI-5075 text names `harness_shared.adv_sessions.session_id` as the
 * un-re-anchored field and prescribes "re-anchor it, or relaunch the session".
 * That is a CLAUDE diagnosis: only the claude branch of `maybeCarryRespawn` reads
 * `ref.sessionId` — a codex owner resolves its transcript through
 * `resolveSelfSession()` → the codex rollout file and never touches that column.
 * Handing a human a no-op fix at BLOCKER severity is bad; handing them "relaunch
 * the session" for a cohort of live multi-hour agents is actively harmful, and
 * that is what fired at 9 codex owners in 11 minutes on 2026-08-12.
 *
 * So: name the mechanism that actually governs THIS owner's estimate, and never
 * prescribe a remedy that the backend makes a no-op or destructive. The codex
 * root cause is deliberately stated as UNESTABLISHED rather than guessed — see
 * WI-38347, where guessing it once already produced a retraction.
 */
export function carryRespawnLoopEscalationBody(
  agent: 'claude' | 'codex' | 'omp' | null,
  streak: number,
  evidence?: CarryRespawnStreakEvidence | null,
): string {
  // WI-38347 leg 4: BEFORE naming a transcript-resolution defect, check whether the
  // estimate moved at all. Every per-backend body below diagnoses an estimate that is
  // NOT TRACKING the live session — a claim the streak alone never established. If the
  // cuts were landing, that whole family of diagnosis is wrong for any backend, and the
  // reader must be sent at the headroom instead of at a transcript hunt.
  if (carryRespawnStreakVerdict(evidence) === 'churn' && evidence != null) {
    const win = evidence.window;
    const ratio =
      win != null && win > 0
        ? `Its limit is ${evidence.limit} against a ${win}-token model window (${Math.round((evidence.limit / win) * 100)}%), `
        : `Its limit is ${evidence.limit} and the model window could not be resolved, `;
    return (
      `${streak} carry-respawns fired for this owner without a sustained recovery below its limit — but the cuts ARE LANDING: ` +
      `the estimate fell from ~${evidence.estAtFirstCut} to ~${evidence.minEstSince} after a cut and then climbed back over the limit. ` +
      `This is CHURN (a headroom problem), NOT the WI-5075 pinned-estimate defect, so there is no stale transcript or session ref to hunt ` +
      `and re-anchoring anything would be a no-op. ${ratio}` +
      `so a successor re-crosses the limit within minutes of booting and is cut again. ` +
      `DO NOT relaunch this session — respawns are already suppressed, the session is live and holding real work, and a relaunch only restarts the cycle. ` +
      `Fix the headroom instead: raise this owner's limit toward its true window, or reduce the successor's boot context. (WI-38347)`
    );
  }
  const shared =
    `A landed P-018 carry-respawn boots a near-empty successor, so the owner's context estimate must fall below its limit and stay there to re-arm the breaker. ` +
    `It did not — ${streak} consecutive cuts without sustained recovery, with the estimate never moving. Each further cut only kills live work. The watchdog has STOPPED respawning this owner until it recovers. `;
  if (agent === 'codex') {
    return (
      shared +
      `This owner is a CODEX session: its estimate is read from the rollout resolved by resolveSelfSession() ` +
      `(codexContextSnapshotFromRollout), NOT from the adv_sessions native-session ref — so the WI-5075 ` +
      `"stale session_id" diagnosis does NOT apply here and re-anchoring that column would be a no-op. ` +
      `The reason a codex respawn leaves the estimate high is NOT yet established — do not act on a guess. ` +
      `DO NOT relaunch this session as a remedy: the respawn suppression above has already stopped the kill loop, ` +
      `the session is live and holding real work, and killing it destroys that work without fixing anything. ` +
      `Investigate instead: compare the rollout path + tail token accounting before and after a cut. (WI-38347)`
    );
  }
  if (agent === 'claude') {
    return (
      shared +
      `This owner is a CLAUDE session, which resolves its transcript from the adv_sessions native-session ref — ` +
      `so a still-high estimate means estimateContextTokensForOwner is reading the DEAD predecessor's transcript ` +
      `(harness_shared.adv_sessions.session_id not re-anchored to the successor's fresh native id: a psu host ` +
      `launched before the WI-5075 fix, or a regression of that class). ` +
      `Fix: re-anchor the owner's adv_sessions.session_id to the live native session id (or relaunch the session ` +
      `so the post-fix launcher reports respawns), then verify the estimate drops. (WI-5075)`
    );
  }
  return (
    shared +
    `The session backend could not be resolved, so no backend-specific diagnosis is offered — deliberately, ` +
    `because the per-backend estimate paths differ and naming the wrong one sends the reader at a no-op fix ` +
    `(WI-38347). Establish the backend first (harness_shared.adv_sessions.agent for this owner), then read the ` +
    `matching branch of maybeCarryRespawn to find which transcript the estimate is actually being read from. ` +
    `DO NOT relaunch this session before that is known — respawns are already suppressed, so the kill loop has ` +
    `stopped, and a relaunch would destroy live work without fixing anything. (WI-5075, WI-38347)`
  );
}

/**
 * WI-5075: the kill-loop breaker. A carry-respawn streak with no sustained recovery in
 * between means further cutting is not helping this owner — so raise ONE loud
 * escalation and stop cutting until it recovers, whichever failure it turns out
 * to be. WI-38347: the streak does NOT by itself mean the estimate is failing to
 * track the live session; {@link carryRespawnStreakVerdict} separates a pinned
 * estimate from churn, and {@link carryRespawnLoopEscalationBody} then picks the
 * diagnosis (per-backend for pinned, backend-neutral headroom for churn).
 */
async function escalateCarryRespawnLoop(
  ownerId: string,
  ownerLabel: string,
  streak: number,
  evidence?: CarryRespawnStreakEvidence | null,
): Promise<void> {
  if (carryRespawnLoopEscalated.has(ownerId)) return;
  carryRespawnLoopEscalated.add(ownerId);
  const verdict = carryRespawnStreakVerdict(evidence);
  console.warn(
    `[compaction-watchdog] ${ownerLabel} (${ownerId}) CARRY-RESPAWN LOOP detected — ` +
      `${streak} respawns fired without sustained recovery below the limit (${verdict}). Suppressing further ` +
      `respawns for this owner and escalating (WI-5075, WI-38347).`,
  );
  // WI-38347: resolve the backend so the body names the mechanism that actually
  // governs THIS owner. Fail-soft to null (the neutral body) — an escalation that
  // cannot resolve the backend must still fire, just without a wrong diagnosis.
  //
  // NOTE the deliberate divergence: SessionRef.agent is `string | null` and this
  // file's usual convention is "unknown ⇒ treat as claude" (that is the right
  // default when RESOLVING A TRANSCRIPT, since claude is the majority backend and
  // a wrong guess is merely a failed lookup). It is the WRONG default here: an
  // unrecognized backend that inherits the claude branch gets handed a no-op fix
  // and a destructive "relaunch" instruction at blocker severity — precisely the
  // harm this function exists to prevent. So anything not positively identified
  // falls to the neutral body instead.
  let agent: 'claude' | 'codex' | 'omp' | null = null;
  try {
    const resolved = (await resolveSessionRefReconciled(ownerId))?.agent ?? null;
    agent =
      resolved === 'claude' || resolved === 'codex' || resolved === 'omp' ? resolved : null;
  } catch {
    /* neutral body */
  }
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      {
        severity: 'blocker',
        summary:
          verdict === 'churn'
            ? `carry-respawn CHURN on ${ownerLabel} (${ownerId}): ${streak} successor cuts, each landing and each re-crossing the limit before sustained recovery — respawns suppressed`
            : `carry-respawn LOOP on ${ownerLabel} (${ownerId}): ${streak} successor cuts with no sustained recovery and the context estimate never dropping — respawns suppressed`,
        body: carryRespawnLoopEscalationBody(agent, streak, evidence),
        // WI-5848 (sweep of EI-18668025239634541's class): `summary` embeds the
        // live `${streak}` count, so it varies across occurrences for the SAME
        // owner exactly like the fixed lifecycle-death bug — the in-memory
        // `carryRespawnLoopEscalated` guard is the only protection, and it
        // resets on a process restart. Key on the stable owner identity.
        meta: { subjectSignature: `compaction-watchdog:carry-respawn-loop:${ownerId}` },
      },
    );
  } catch (e) {
    // Best-effort — never fail the sweep; un-dedup so the next pass retries.
    carryRespawnLoopEscalated.delete(ownerId);
    console.warn(
      `[compaction-watchdog] carry-respawn-loop escalation failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * P-018 live actuation: at the session's soft threshold, or after P-019 detects a
 * terminal "Prompt is too long" response, ask a capable managed psu host to
 * replace the settled child with a fresh successor carrying the deterministic
 * launch-context document. The shared P-017/P-018 cutover flag defaults ON by
 * owner release direction (2026-07-15); OFF remains the emergency kill-switch.
 * Every miss is fail-soft: the soft-threshold path leaves native auto-compact and
 * the older force-compact rung as backstops, while the death path escalates below.
 */
async function maybeCarryRespawn(
  ownerId: string,
  ownerLabel: string,
  workspaceId: string,
  effectiveWindowTokens: number,
  reason: CarryRespawnReason = 'soft-threshold',
): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    if (!(await getFlag(FLAGS.GATEWAY_MAINTENANCE_CARRY, 'system'))) return false;
  } catch {
    return false;
  }
  try {
    const { findLiveHost, hostSupports, injectIntoHost } = await import(
      '../events/await/psu-pty-discovery'
    );
    const host = findLiveHost(ownerId);
    if (!host || !hostSupports(host, 'carry-respawn')) return false;

    // EI-13477: reconciled — a same-pid self-relaunch's dead native id must not
    // be read as this owner's live transcript when deciding whether to respawn.
    const ref = await resolveSessionRefReconciled(ownerId);
    if (!ref || ref.agent === 'omp') return false;
    let transcriptPath: string | null = null;
    let transcriptSourceKind: 'claude' | 'codex' = 'claude';
    if (ref.agent === 'codex') {
      const { resolveSelfSession } = await import('../search/self-session');
      const self = await resolveSelfSession(ownerId);
      if (self?.sourceKind === 'codex') {
        transcriptPath = self.filePath;
        transcriptSourceKind = 'codex';
      }
    } else {
      const { findSessionTranscript, newestTranscriptUnderOwner } = await import('../claude-sessions');
      transcriptPath =
        (ref.sessionId ? await findSessionTranscript(ref.sessionId, { owner: ownerId }) : null) ??
        newestTranscriptUnderOwner(ownerId);
    }
    if (!transcriptPath) return false;

    await mechanicalPreflushForWatchdog(ownerId, ownerLabel, workspaceId);

    const { buildOwnerRespawnLaunchSpec } = await import('../carry-respawn');
    const spec = await buildOwnerRespawnLaunchSpec(ownerId, {
      effectiveWindowTokens,
      buildOpts: {
        workspaceId,
        ownerLabel,
        transcriptPath,
        transcriptSourceKind,
        // Soft-threshold cuts are clean/idle-gated (deliberate ⇒ the P-010
        // refuse-once gate applies). A Prompt-is-too-long death is already a
        // terminal response, so its recovery cut is forced/non-deliberate and
        // carries any open owner message rather than refusing the only recovery
        // path. Neither path is self-requested: the session never ran its flush
        // discipline, and the rendered continuation must not claim "state was
        // flushed" (the 2026-07-18 provenance mislabel). A tool-reference death
        // (WI-10003466) is terminal the same way: every turn is already rejected.
        boundaryDeliberate: reason === 'soft-threshold',
        boundarySelfRequested: false,
      },
    });
    if (!spec) return false;
    if (spec.openOwnerQuestion.crossesOpenOwnerMessage && reason === 'soft-threshold') {
      console.warn(
        `[compaction-watchdog] ${ownerLabel} (${ownerId}) ${
          'reached the deterministic carry threshold and'
        } has an unanswered owner message; refusing this deliberate cut once (P-010/P-018).`,
      );
      return false;
    }
    // WI-39942: firstPrompt is null after an ANSWERED owner turn by design. The
    // carry addendum alone only briefs the successor; it does not start a turn.
    // Always synthesize a tagged continuation so an interactive one-shot session
    // with no loop/event wake cannot respawn into a fully-briefed silent park.
    const firstPrompt =
      spec.firstPrompt ??
      (await tagWatchdogContinuation(ownerId, watchdogCarryContinueNote(reason)));
    const ok = await injectIntoHost(host.sock, {
      mode: 'carry-respawn',
      data: firstPrompt,
      systemPromptAddendum: spec.systemPromptAddendum,
      ownerId,
    });
    if (ok) {
      console.warn(
        `[compaction-watchdog] CARRY-RESPAWN queued for ${ownerLabel} (${ownerId}) ${
          reason === 'context-death'
            ? 'after detecting a Prompt-is-too-long death'
            : reason === 'tool-reference-death'
              ? 'after detecting a stranding unavailable-tool-reference streak (WI-10003466)'
              : 'at the soft threshold'
        } — fresh ${transcriptSourceKind} successor will inherit the deterministic carry (P-018/D-011).`,
      );
    }
    return ok;
  } catch (e) {
    console.warn(
      `[compaction-watchdog] carry-respawn build/inject failed; retaining native backstop: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * P-019 recovery-first policy: a Prompt-is-too-long death gets one forced
 * carry-respawn attempt before the blocker escalation. A socket-acknowledged
 * recovery is given the same grace as the soft/force rungs so repeated death
 * sweeps do not queue duplicate successors while the host replaces the child.
 * Escalation remains the fallback for a disabled flag, missing/old host,
 * unavailable transcript/spec, or failed injection.
 */
async function recoverContextDeath(
  ownerId: string,
  ownerLabel: string,
  workspaceId: string,
  effectiveWindowTokens: number,
  kind: TranscriptDeathKind = 'context-death',
): Promise<TranscriptDeathRecovery> {
  if (contextDeathEscalated.has(transcriptDeathKey(ownerId, kind))) return 'unrecoverable';
  const lastCarryAt = carryRespawnRequestedAt.get(ownerId);
  if (lastCarryAt != null && Date.now() - lastCarryAt < FORCE_RETRY_GRACE_MS) return 'in-grace';
  const recovered = await maybeCarryRespawn(ownerId, ownerLabel, workspaceId, effectiveWindowTokens, kind);
  if (!recovered) {
    await escalateContextDeath(ownerId, ownerLabel, kind);
    return 'unrecoverable';
  }
  carryRespawnRequestedAt.set(ownerId, Date.now());
  return 'queued';
}

/** A forced transcript-death recovery attempt: queued now, already queued inside the
 *  socket-ACK grace (the host is replacing the child), or impossible (escalated). */
type TranscriptDeathRecovery = 'queued' | 'in-grace' | 'unrecoverable';

/** The wake-executor's view: `not-dead` = the RECONCILED live transcript shows no
 *  stranding streak (e.g. the recorded row names a dead predecessor's transcript). */
export type ToolReferenceDeathRecovery = TranscriptDeathRecovery | 'not-dead';

/**
 * WI-10003466: recover a LIVE claude session stranded by the provider's
 * unavailable-tool-reference rejection by moving it onto fresh context — the same
 * forced carry-respawn the sweep gives a "Prompt is too long" death, reachable
 * on demand so the wake executor can RECOVER a session at wake time instead of
 * quarantining it (the path that ended su-7dc2cf9d, 2026-09-27). Re-detects on the
 * reconciled live transcript first so a stale session row can never trigger a
 * respawn loop; shares the sweep's per-owner grace and escalation dedup, so the
 * two callers cannot queue duplicate successors. Never throws.
 */
export async function recoverToolReferenceDeathForOwner(
  ownerId: string,
  opts: { workspaceId: string; ownerLabel?: string },
): Promise<ToolReferenceDeathRecovery> {
  try {
    const death = await detectToolReferenceDeathForOwner(ownerId);
    if (!death) return 'not-dead';
    let window: number | null = null;
    try {
      window = await estimateContextWindowForOwner(ownerId);
    } catch {
      /* conservative fallback below */
    }
    const carryWindow = Math.min(MODEL_WINDOW_1M, Math.max(1, window ?? TOOL_REFERENCE_DEATH_FALLBACK_WINDOW));
    return await recoverContextDeath(
      ownerId,
      opts.ownerLabel ?? ownerId,
      opts.workspaceId,
      carryWindow,
      'tool-reference-death',
    );
  } catch {
    return 'unrecoverable';
  }
}

/** Same conservative carry budget session:request-compaction and loop-turn-outcome use
 *  when the live window cannot be resolved: smaller is safe, a guessed larger one is not. */
const TOOL_REFERENCE_DEATH_FALLBACK_WINDOW = 200_000;

/**
 * P-012 (agent-managed-compaction-2026-07-01) — the L2 mechanical FORCE rung,
 * rebuilt under P-022 (WI-4998: native /compact retired). An over-limit session
 * has ignored the per-turn reminder (rendered since 85%), crossed its own soft
 * limit, run through the FORCE_COMPACT_FRACTION grace band (owner 2026-07-04),
 * AND missed the polite soft-threshold carry-respawn above — so the watchdog
 * FORCES the deterministic cut: it assembles the carry spec itself and queues a
 * mode:'carry-respawn' on the session's live psu host (idle-gated — the cut runs
 * AFTER the current turn ends, safe to fire mid-turn). Unlike the polite rung,
 * a forced cut PROCEEDS over an open owner question — P-010 still holds because
 * the open message rides as the successor's first prompt, never lost. This
 * catches a non-self-managing session at ~130% of its limit (window-capped)
 * instead of letting it drift toward the model window (the 2026-07-04 836k
 * incident). Best-effort; returns true only when the inject actually reached a
 * live carry-respawn-capable host.
 *
 * Flag-gated (COMPACTION_WATCHDOG_FORCE_COMPACT, default ON) — a runtime
 * kill-switch for this invasive rung. No live capable host, or a failed spec
 * build ⇒ false + retry next pass; the hard-wall death detector (improvements
 * watchdog "Prompt is too long") is the terminal backstop — there is NO native
 * /compact fallback anywhere anymore. Dynamic imports mirror escalateContextDeath
 * so the sweep stays dependency-light + the deps stay mockable.
 */
async function maybeForceRespawn(
  ownerId: string,
  ownerLabel: string,
  workspaceId: string,
  effectiveWindowTokens: number,
  est: number,
  limit: number,
  /** The resolved force threshold (min(limit × 1.3, window − margin)) — named in the
   *  successor's first prompt so the cut agent (and its owner) see the real numbers. */
  forceAt: number = limit * FORCE_COMPACT_FRACTION,
  /** Which arm produced forceAt — the note words each regime differently. */
  bound: ForceBound = 'fraction',
): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    if (!(await getFlag(FLAGS.COMPACTION_WATCHDOG_FORCE_COMPACT, 'system'))) return false;
  } catch {
    return false; // flag infra unavailable ⇒ do NOT force (fail-safe)
  }
  try {
    const { findLiveHost, hostSupports, injectIntoHost } = await import(
      '../events/await/psu-pty-discovery'
    );
    const host = findLiveHost(ownerId);
    if (!host) {
      // EI-9982: distinguish "no live psu-pty host" from the flag-off / grace-suppressed /
      // inject-failed silent-no-op paths — this is the dominant cause of a continuously-active
      // session that crosses the FORCE threshold yet is never force-cut.
      if (!noHostWarned.has(ownerId)) {
        noHostWarned.add(ownerId);
        console.warn(
          `[compaction-watchdog] ${ownerLabel} (${ownerId}) crossed the FORCE threshold (~${est}/${limit} ` +
            `tokens) but findLiveHost() found no live psu-pty host — force-respawn silently no-ops here ` +
            `(EI-9982). Likely a stale/missing discovery file at ~/.papercusp/psu-pty/<ownerId>.json, a ` +
            `dead pid, or a pidIsPsuHost() identity mismatch (the EI-9748 / WI-3455 discovery-file ` +
            `fragility class) — check that file + the recorded pid/socket for this owner.`,
        );
      }
      return false;
    }
    if (!hostSupports(host, 'carry-respawn')) {
      console.warn(
        `[compaction-watchdog] ${ownerLabel} (${ownerId}) is at the FORCE threshold but its psu host ` +
          `predates the carry-respawn capability (P-022: native /compact is retired, no fallback) — ` +
          `the hard-wall death detector is the remaining backstop for this session.`,
      );
      return false;
    }
    // EI-13477: reconciled, same reasoning as maybeCarryRespawn above.
    const ref = await resolveSessionRefReconciled(ownerId);
    if (ref?.agent === 'omp') return false;
    let transcriptPath: string | null = null;
    let transcriptSourceKind: 'claude' | 'codex' = 'claude';
    if (ref?.agent === 'codex') {
      const { resolveSelfSession } = await import('../search/self-session');
      const self = await resolveSelfSession(ownerId);
      if (self?.sourceKind === 'codex') {
        transcriptPath = self.filePath;
        transcriptSourceKind = 'codex';
      }
    } else {
      const { findSessionTranscript, newestTranscriptUnderOwner } = await import('../claude-sessions');
      transcriptPath =
        (ref?.sessionId ? await findSessionTranscript(ref.sessionId, { owner: ownerId }) : null) ??
        newestTranscriptUnderOwner(ownerId);
    }
    await mechanicalPreflushForWatchdog(ownerId, ownerLabel, workspaceId);
    const { buildOwnerRespawnLaunchSpec } = await import('../carry-respawn');
    const spec = transcriptPath
      ? await buildOwnerRespawnLaunchSpec(ownerId, {
          effectiveWindowTokens,
          buildOpts: {
            workspaceId,
            ownerLabel,
            transcriptPath,
            transcriptSourceKind,
            // A forced cut is NOT the clean deliberate boundary the polite rung
            // waits for — mark it so the carry producers treat the tail as
            // potentially mid-thought.
            boundaryDeliberate: false,
          },
        })
      : null;
    if (!spec) {
      console.warn(
        `[compaction-watchdog] force-respawn for ${ownerLabel} (${ownerId}) could not assemble the ` +
          `carry spec (${transcriptPath ? 'builder failure' : 'no transcript'}) — will retry next pass; ` +
          `the death detector is the terminal backstop.`,
      );
      return false;
    }
    // turn-provenance P-002: the forced first prompt is typed into the successor's
    // PTY as a prompt — tag it `watchdog` so the hook labels it machine-generated,
    // not owner input. An OPEN owner message wins instead (P-010) and rides
    // verbatim/untagged — it IS owner text, delivered by the one shared kickoff
    // source. Fail-soft on any tag error.
    const firstPrompt =
      spec.firstPrompt ??
      (await tagWatchdogContinuation(
        ownerId,
        forceCompactContinueNote(est, limit, forceAt, bound),
      ));
    const ok = await injectIntoHost(host.sock, {
      mode: 'carry-respawn',
      data: firstPrompt,
      systemPromptAddendum: spec.systemPromptAddendum,
      ownerId,
    });
    if (ok) {
      console.warn(
        `[compaction-watchdog] FORCE-RESPAWNED ${ownerLabel} (${ownerId}) at ~${est}/${limit} tokens ` +
          `(${Math.round((est / limit) * 100)}% of the soft limit; force threshold ~${forceAt}) — ` +
          `queued the deterministic carry-respawn after it exhausted the self-cut band (P-012/P-022).`,
      );
    }
    return ok;
  } catch (e) {
    console.warn(
      `[compaction-watchdog] force-respawn inject failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * D-006 honor leg (context-trimming-tiers P-009): an EXPLICIT per-tier
 * compactionLimit rides the SPAWN RECORD and takes precedence over the
 * model-derived default — spawned_agents.model_tier resolved against the
 * workspace tier menu; a recorded model_spec still beats the fs/argv resolver
 * (a fleet bee's session settings.json rarely names the model). The child's
 * coord ownerId IS its spawnId (sessionOwner: spawnId in operator-spawn), so
 * the lookup keys on either column. Best-effort: null ⇒ resolver fallback.
 *
 * WI-38347: the result reports whether the number is an EXPLICIT configuration
 * (a per-tier `compactionLimit` someone deliberately set) or merely DERIVED from
 * a model spec. Only a derived number may be overridden by a measured window —
 * see {@link derivedSeedLimitForOwner}.
 */
async function resolveSpawnRecordLimit(
  sql: Sql,
  ownerId: string,
  tierMenu: () => Promise<readonly ModelTier[] | undefined>,
  fleetMember = false,
): Promise<{ limit: number; explicit: boolean; spec: string | null } | null> {
  try {
    const rows = await sql<{ model_spec: string | null; model_tier: string | null }[]>`
      SELECT model_spec, model_tier
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${ownerId} OR session_owner = ${ownerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.model_tier) {
      const tiers = await tierMenu();
      const tier = tiers?.find((t) => t.name === row.model_tier);
      // parseTiers already clamped a stored explicit limit to the spec's window.
      if (tier?.compactionLimit != null) {
        return { limit: tier.compactionLimit, explicit: true, spec: tier.spec ?? null };
      }
      if (tier?.spec) {
        return {
          limit: defaultCompactionLimitForSpec(tier.spec, { fleetMember }),
          explicit: false,
          spec: tier.spec,
        };
      }
    }
    if (row.model_spec) {
      return {
        limit: defaultCompactionLimitForSpec(row.model_spec, { fleetMember }),
        explicit: false,
        spec: row.model_spec,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The limit the SPEC-DERIVED seed path produces for an owner, with an
 * `explicit` flag saying whether that number was deliberately configured
 * (a `psu --compaction-limit` launch flag or a per-tier `compactionLimit`)
 * rather than guessed from a model spec. WI-38347.
 *
 * This is deliberately the PRE-measurement number — it is what the seed pass
 * writes when no live window is available, and therefore also the value the
 * raise gate compares a running session's stored limit against to decide
 * "this is still the default nobody chose" vs "somebody set this on purpose".
 * Do NOT fold the measured-window correction in here: the raise gate needs to
 * recognise the OLD (wrong) seed in order to heal it.
 */
async function derivedSeedLimitForOwner(
  sql: Sql,
  ownerId: string,
  tierMenu: () => Promise<readonly ModelTier[] | undefined>,
  fleetMember: boolean,
): Promise<{ limit: number; explicit: boolean; spec: string | null }> {
  // per-member-declarative-launch-specs P-005: an EXPLICIT `psu
  // --compaction-limit` on the recorded launch argv outranks every DERIVED
  // default below — the leader stated this member's limit outright
  // (MemberSpec.compactionLimit), which is the whole point of the flag.
  // Still clamped to the role ceiling and the model window: an explicit
  // request may lower a limit freely but may never raise it past the cap
  // its fleet role is governed by (a member cannot buy itself a leader's
  // 400k). Before this, a per-member limit could only be REQUESTED in a
  // brief the member had to obey by hand.
  const fromLaunch = await resolveLaunchCompactionLimitForOwner(ownerId);
  const fromSpawn = await resolveSpawnRecordLimit(sql, ownerId, tierMenu, fleetMember);
  // The fs/argv resolver does real I/O — only pay for it when its result is
  // actually needed: the explicit-launch-limit clamp always needs the spec's
  // window, but a resolved spawn-record default needs no further lookup at
  // all (D-006 honor leg — "the fs/argv resolver only ran for the
  // record-less owner").
  const needsSpec = fromLaunch != null || fromSpawn == null;
  const spec = needsSpec ? await resolveModelSpecForOwner(ownerId) : null;
  if (fromLaunch != null) {
    return { limit: clampCompactionLimit(fromLaunch, spec, { fleetMember }), explicit: true, spec };
  }
  if (fromSpawn != null) return fromSpawn;
  return { limit: defaultCompactionLimitForSpec(spec, { fleetMember }), explicit: false, spec };
}

/**
 * Best-effort hard-window resolve for the force-threshold cap, mirroring the
 * limit-seeding precedence (spawn record's spec/tier beats the fs/argv resolver —
 * a fleet bee's settings.json rarely names the model, and mis-reading a [1m]
 * member as 200k would silently collapse its force grace back to ~100%).
 * null ⇒ unknown window (caller falls back to the overshoot-factor bound).
 */
async function resolveWindowForOwner(
  sql: Sql,
  ownerId: string,
  tierMenu: () => Promise<readonly ModelTier[] | undefined>,
): Promise<number | null> {
  try {
    const rows = await sql<{ model_spec: string | null; model_tier: string | null }[]>`
      SELECT model_spec, model_tier
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${ownerId} OR session_owner = ${ownerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    let spec = row?.model_spec ?? null;
    if (!spec && row?.model_tier) {
      const tiers = await tierMenu();
      spec = tiers?.find((t) => t.name === row.model_tier)?.spec ?? null;
    }
    spec ??= await resolveModelSpecForOwner(ownerId);
    return spec ? modelWindowForSpec(spec) : null;
  } catch {
    return null;
  }
}

/** The exact durable boundary evidence read from event_key_fires. */
export interface CompactionBoundaryEvidence {
  /** The exact event key; optional for pure callers, enforced when supplied. */
  key?: string;
  /** Monotonic fire count recorded by the event latch. */
  fireCount: number;
  /** `last_fired_at`, converted to epoch milliseconds. */
  latestBoundaryMs: number;
}

/** An expired file-lock row owned by the suspect session. */
export interface ExpiredOwnerFileLockEvidence {
  path: string;
  expiresAtMs: number;
}

/** An edit-attribution row for one target path. */
export interface TargetEditEvidence {
  file: string;
  editedAtMs: number;
}

/**
 * Inputs to the D-137 detector. `null` means the corresponding read was
 * unavailable or malformed and MUST fail open. Empty arrays are valid reads
 * which simply do not satisfy that signal.
 */
export interface CompactionStrandingDetectorInput {
  owner: string;
  ownerLabel?: string;
  event: CompactionBoundaryEvidence | null;
  staleClaims: readonly StaleClaim[] | null;
  targetPaths: readonly string[] | null;
  expiredOwnerLocks: readonly ExpiredOwnerFileLockEvidence[] | null;
  targetEditsAfterBoundary: readonly TargetEditEvidence[] | null;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  nowMs?: number;
}

/** The durable, all-signals-agree D-137 alert returned by the detector. */
export interface CompactionStrandingAlert {
  owner: string;
  ownerLabel?: string;
  eventKey: string;
  fireCount: number;
  latestBoundaryMs: number;
  workItemIds: string[];
  staleClaims: StaleClaim[];
  targetPaths: string[];
  expiredOwnerLocks: ExpiredOwnerFileLockEvidence[];
}

function normalizeCompactionStrandingPath(path: string): string {
  return path.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function finiteEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueCompactionStrandingPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const path = normalizeCompactionStrandingPath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * PURE D-137 detector.
 *
 * It deliberately requires all four independent signals to be readable and
 * affirmative:
 *   1. the exact owner-keyed compaction event fired at least twice;
 *   2. a live claim has stale or missing carry-checkpoint state;
 *   3. an owner-held target-path lock is expired;
 *   4. no target-path edit attribution exists after the latest boundary.
 *
 * Any unavailable/malformed input returns null. This is the fail-open
 * recurrence guard: a degraded side DB, event latch, work-item read, or edit
 * ledger must never manufacture a suspect-owner alert.
 */
export function detectCompactionStranding(
  input: CompactionStrandingDetectorInput | null | undefined,
): CompactionStrandingAlert | null {
  if (!input || typeof input.owner !== 'string' || input.owner.trim() === '') return null;
  const owner = input.owner.trim();
  const eventKey = `session:compacted:${owner}`;
  const event = input.event;
  if (!event) return null;
  if (event.key != null && event.key !== eventKey) return null;

  const fireCount = finiteEpochMs(event.fireCount);
  const latestBoundaryMs = finiteEpochMs(event.latestBoundaryMs);
  const nowMs = input.nowMs ?? Date.now();
  if (
    fireCount == null ||
    !Number.isInteger(fireCount) ||
    fireCount < D137_REPEATED_COMPACTION_THRESHOLD ||
    latestBoundaryMs == null ||
    latestBoundaryMs <= 0 ||
    !Number.isFinite(nowMs) ||
    latestBoundaryMs > nowMs
  ) {
    return null;
  }

  const staleClaims = input.staleClaims;
  const targetPathsInput = input.targetPaths;
  const expiredOwnerLocks = input.expiredOwnerLocks;
  const targetEditsAfterBoundary = input.targetEditsAfterBoundary;
  if (
    !Array.isArray(staleClaims) ||
    !Array.isArray(targetPathsInput) ||
    !Array.isArray(expiredOwnerLocks) ||
    !Array.isArray(targetEditsAfterBoundary) ||
    staleClaims == null ||
    targetPathsInput == null ||
    expiredOwnerLocks == null ||
    targetEditsAfterBoundary == null ||
    staleClaims.length === 0 ||
    targetPathsInput.length === 0 ||
    expiredOwnerLocks.length === 0
  ) {
    return null;
  }

  // A malformed row is a read-integrity failure, not an empty result.
  const normalizedClaims: StaleClaim[] = [];
  const workItemIds = new Set<string>();
  for (const claim of staleClaims) {
    if (
      !claim ||
      typeof claim.workItemId !== 'string' ||
      claim.workItemId.trim() === '' ||
      (claim.reason !== 'never' && claim.reason !== 'drift') ||
      !Number.isFinite(claim.staleMs) ||
      claim.staleMs < 0
    ) {
      return null;
    }
    const workItemId = claim.workItemId.trim();
    normalizedClaims.push({ ...claim, workItemId });
    workItemIds.add(workItemId);
  }

  if (targetPathsInput.some((path) => typeof path !== 'string' || path.trim() === '')) return null;
  const targetPaths = uniqueCompactionStrandingPaths(targetPathsInput);
  if (targetPaths.length === 0) return null;
  const targetPathSet = new Set(targetPaths);
  const matchingExpiredLocks: ExpiredOwnerFileLockEvidence[] = [];
  for (const lock of expiredOwnerLocks) {
    if (
      !lock ||
      typeof lock.path !== 'string' ||
      lock.path.trim() === '' ||
      !Number.isFinite(lock.expiresAtMs)
    ) {
      return null;
    }
    const path = normalizeCompactionStrandingPath(lock.path);
    if (targetPathSet.has(path) && lock.expiresAtMs <= nowMs) {
      matchingExpiredLocks.push({ path, expiresAtMs: lock.expiresAtMs });
    }
  }
  if (matchingExpiredLocks.length === 0) return null;

  // The read is allowed to be empty. A non-empty edit after the boundary is
  // affirmative evidence that the owner did make progress, so suppress.
  for (const edit of targetEditsAfterBoundary) {
    if (
      !edit ||
      typeof edit.file !== 'string' ||
      edit.file.trim() === '' ||
      !Number.isFinite(edit.editedAtMs)
    ) {
      return null;
    }
    const file = normalizeCompactionStrandingPath(edit.file);
    if (targetPathSet.has(file) && edit.editedAtMs > latestBoundaryMs) return null;
  }

  return {
    owner,
    ...(input.ownerLabel ? { ownerLabel: input.ownerLabel } : {}),
    eventKey,
    fireCount,
    latestBoundaryMs,
    workItemIds: [...workItemIds],
    staleClaims: normalizedClaims,
    targetPaths,
    expiredOwnerLocks: matchingExpiredLocks,
  };
}

/** Descriptive aliases for callers/tests that use the incident language. */
export const detectD137CompactionStranding = detectCompactionStranding;
export const detectRepeatedCompactionStranding = detectCompactionStranding;

interface CompactionBoundaryDbRow {
  event_key: string;
  fire_count: number | string;
  last_fired_at: Date | string;
}

async function readCompactionBoundaryEvidence(
  sql: Sql,
  workspaceId: string,
  ownerId: string,
): Promise<CompactionBoundaryEvidence | null> {
  const key = `session:compacted:${ownerId}`;
  if (!workspaceId || !ownerId) return null;
  try {
    const rows = await sql<CompactionBoundaryDbRow[]>`
      SELECT event_key, fire_count, last_fired_at
        FROM harness_shared.event_key_fires
       WHERE workspace_id = ${workspaceId}
         AND event_key = ${key}
       LIMIT 1
    `;
    const row = rows[0];
    const fireCount = finiteEpochMs(row?.fire_count);
    const latestBoundaryMs = finiteEpochMs(row?.last_fired_at);
    if (!row || fireCount == null || latestBoundaryMs == null) return null;
    return { key: row.event_key, fireCount, latestBoundaryMs };
  } catch {
    return null;
  }
}

function pathsFromJson(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    if (value.some((path) => typeof path !== 'string' || path.trim() === '')) return null;
    return value as string[];
  }
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    if (parsed.some((path) => typeof path !== 'string' || path.trim() === '')) return null;
    return parsed as string[];
  } catch {
    return [];
  }
}

interface WorkItemTargetPathsDbRow {
  work_item_id: string;
  paths: unknown;
}

async function readTargetPathsByWorkItem(
  sql: Sql,
  ownerId: string,
  workspaceId: string,
  workItemIds: readonly string[],
): Promise<Map<string, string[]> | null> {
  const ids = [...new Set(workItemIds.map((id) => id.trim()).filter(Boolean))];
  if (!ownerId || !workspaceId || ids.length === 0) return null;
  try {
    const rows = await sql<WorkItemTargetPathsDbRow[]>`
      SELECT c.work_item_id,
             COALESCE(wi.payload->'paths', '[]'::jsonb) AS paths
        FROM harness_shared.work_item_claims c
        JOIN harness_shared.work_items wi
          ON wi.workspace_id = c.workspace_id
         AND wi.harness_slug = c.harness_slug
         AND wi.feature_id = c.work_item_id
       WHERE c.workspace_id = ${workspaceId}
         AND c.owner = ${ownerId}
         AND c.expires_ts > clock_timestamp()
         AND c.work_item_id = ANY(${ids}::text[])
    `;
    const out = new Map<string, string[]>();
    for (const row of rows) {
      if (!row || typeof row.work_item_id !== 'string') return null;
      const rawPaths = pathsFromJson(row.paths);
      if (rawPaths == null) return null;
      const paths = uniqueCompactionStrandingPaths(rawPaths);
      const prior = out.get(row.work_item_id);
      // Work-item ids are normally globally unique, but the canonical contract
      // is harness-local. Conflicting rows mean the read cannot identify the
      // claimed target unambiguously, so fail open rather than choose one.
      if (prior && JSON.stringify(prior) !== JSON.stringify(paths)) return null;
      out.set(row.work_item_id, paths);
    }
    return out;
  } catch {
    return null;
  }
}

interface TargetEditDbRow {
  file: string;
  edited_ms: string | number;
}

async function readTargetEditsAfterBoundary(
  sql: Sql,
  ownerId: string,
  targetPaths: readonly string[],
  boundaryMs: number,
): Promise<TargetEditEvidence[] | null> {
  if (!ownerId || targetPaths.length === 0 || !Number.isFinite(boundaryMs)) return null;
  try {
    const rows = await sql<TargetEditDbRow[]>`
      SELECT file, (extract(epoch FROM ts) * 1000)::bigint AS edited_ms
        FROM harness_shared.edit_attribution_ledger
       WHERE agent_id = ${ownerId}
         AND file = ANY(${targetPaths}::text[])
         AND ts > to_timestamp(${boundaryMs / 1000})
       ORDER BY ts ASC
    `;
    const out: TargetEditEvidence[] = [];
    for (const row of rows) {
      const editedAtMs = finiteEpochMs(row?.edited_ms);
      if (!row || typeof row.file !== 'string' || editedAtMs == null) return null;
      out.push({ file: row.file, editedAtMs });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Read expired owner-held locks from the separate SU lock database. The normal
 * `locks:queue`/readQueue surface intentionally hides expired rows; D-137 needs
 * the retained lease row itself to prove that a lock was held and then lapsed.
 * Any side-DB failure returns null (fail open).
 */
export async function readExpiredOwnerFileLocks(
  ownerId: string,
  targetPaths: readonly string[],
): Promise<ExpiredOwnerFileLockEvidence[] | null> {
  const paths = uniqueCompactionStrandingPaths(targetPaths);
  if (!ownerId || paths.length === 0) return null;
  try {
    const { ensureBootstrap, getTxPool } = await import('../agent-tools/locks/su-lock-store');
    await ensureBootstrap();
    const rows = await getTxPool()<Array<{ path: string; expires_ms: string | number }>>`
      SELECT path, (extract(epoch FROM expires_ts) * 1000)::bigint AS expires_ms
        FROM agent_file_locks
       WHERE owner = ${ownerId}
         AND path = ANY(${paths}::text[])
         AND expires_ts <= clock_timestamp()
       ORDER BY expires_ts ASC
    `;
    const out: ExpiredOwnerFileLockEvidence[] = [];
    for (const row of rows) {
      const expiresAtMs = finiteEpochMs(row?.expires_ms);
      if (!row || typeof row.path !== 'string' || expiresAtMs == null) return null;
      out.push({ path: row.path, expiresAtMs });
    }
    return out;
  } catch {
    return null;
  }
}

export type CompactionStrandingLockReader = (
  ownerId: string,
  targetPaths: readonly string[],
) => Promise<ExpiredOwnerFileLockEvidence[] | null>;

export interface CompactionStrandingDetectorDeps {
  /** Optional cached stale-claim read, used by the main sweep to avoid a duplicate query. */
  readStaleClaims?: () => Promise<readonly StaleClaim[] | null>;
  /** Injectable side-DB lock reader for tests and alternate lock authorities. */
  readExpiredOwnerFileLocks?: CompactionStrandingLockReader;
}

/**
 * Async D-137 detector wired to the durable stores. The event latch is checked
 * first so ordinary sessions pay only one indexed point read; claim, work-item,
 * edit-ledger, and side-lock reads happen only after the repeated boundary
 * threshold is met.
 */
export async function detectCompactionStrandingForOwner(
  sql: Sql,
  ownerId: string,
  ownerLabel: string,
  workspaceId: string,
  deps: CompactionStrandingDetectorDeps = {},
): Promise<CompactionStrandingAlert | null> {
  const event = await readCompactionBoundaryEvidence(sql, workspaceId, ownerId);
  if (!event || event.fireCount < D137_REPEATED_COMPACTION_THRESHOLD) return null;

  let staleClaims: readonly StaleClaim[] | null;
  if (deps.readStaleClaims) {
    staleClaims = await deps.readStaleClaims().catch(() => null);
  } else {
    try {
      const fresh = await listActiveClaimFreshnessForOwner(null, ownerId, { sql });
      staleClaims = classifyStaleClaims(fresh, Date.now());
    } catch {
      staleClaims = null;
    }
  }
  if (staleClaims == null || staleClaims.length === 0) return null;

  const targetPathsByWorkItem = await readTargetPathsByWorkItem(
    sql,
    ownerId,
    workspaceId,
    staleClaims.map((claim) => claim.workItemId),
  );
  if (targetPathsByWorkItem == null) return null;
  const targetPaths: string[] = [];
  const seenPaths = new Set<string>();
  // Missing paths for ANY stale claim suppress the whole alert. Partial
  // evidence is not enough for a destructive-looking diagnosis.
  for (const claim of staleClaims) {
    const paths = targetPathsByWorkItem.get(claim.workItemId);
    if (!paths || paths.length === 0) return null;
    for (const path of paths) {
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        targetPaths.push(path);
      }
    }
  }

  const targetEditsAfterBoundary = await readTargetEditsAfterBoundary(
    sql,
    ownerId,
    targetPaths,
    event.latestBoundaryMs,
  );
  if (targetEditsAfterBoundary == null) return null;

  const readExpiredLocks = deps.readExpiredOwnerFileLocks ?? readExpiredOwnerFileLocks;
  const expiredOwnerLocks = await readExpiredLocks(ownerId, targetPaths).catch(() => null);
  if (expiredOwnerLocks == null) return null;

  return detectCompactionStranding({
    owner: ownerId,
    ownerLabel,
    event,
    staleClaims,
    targetPaths,
    expiredOwnerLocks,
    targetEditsAfterBoundary,
  });
}

async function escalateCompactionStranding(alert: CompactionStrandingAlert): Promise<void> {
  if (compactionStrandingEscalated.has(alert.owner)) return;
  compactionStrandingEscalated.add(alert.owner);
  const label = alert.ownerLabel ?? alert.owner;
  console.warn(
    `[compaction-watchdog] ${label} (${alert.owner}) is SUSPECT after ${alert.fireCount} ` +
      `completed compaction boundaries: stale claim checkpoint + expired target lock + no target edit ` +
      `after ${new Date(alert.latestBoundaryMs).toISOString()} (D-137).`,
  );
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      {
        severity: 'blocker',
        summary:
          `compaction-stranding SUSPECT: ${label} (${alert.owner}) repeatedly compacted ` +
          `without editing its claimed target`,
        body:
          `D-137's independent signals agree for ${label} (${alert.owner}): the exact ` +
          `${alert.eventKey} latch fired ${alert.fireCount} times (latest boundary ` +
          `${new Date(alert.latestBoundaryMs).toISOString()}); live claim(s) ` +
          `${alert.workItemIds.join(', ')} still have stale/missing carry checkpoints; ` +
          `owner-held target lock(s) expired for ${alert.expiredOwnerLocks.map((lock) => lock.path).join(', ')}; ` +
          `and the edit-attribution ledger has no target edit after that boundary. ` +
          `Do not treat a pre-edit checkpoint as progress: checkpoint-or-release/relaunch the claim ` +
          `before another compaction cycle strands it. (D-137)`,
        meta: {
          subjectSignature: `compaction-watchdog:compaction-stranding:${alert.owner}`,
          eventKey: alert.eventKey,
          fireCount: alert.fireCount,
          latestBoundaryAt: new Date(alert.latestBoundaryMs).toISOString(),
          workItemIds: alert.workItemIds,
          targetPaths: alert.targetPaths,
          expiredTargetPaths: alert.expiredOwnerLocks.map((lock) => lock.path),
        },
      },
    );
  } catch (e) {
    // Best-effort — the result remains observable and the durable escalation
    // retries after the next matching sweep.
    compactionStrandingEscalated.delete(alert.owner);
    console.warn(
      `[compaction-watchdog] compaction-stranding escalation failed (will retry): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export interface CompactionComplianceResult {
  /** owners whose estimate was refreshed this pass. */
  estimated: string[];
  /** owners currently over their compaction_limit. */
  overLimit: string[];
  /** P-012: over-limit owners the watchdog FORCE-COMPACTED this pass (injected
   *  /compact into their live psu-pty). Subset of overLimit — excludes owners still
   *  inside the FORCE_COMPACT_FRACTION grace band, with no live host, an
   *  already-in-flight force (deduped), or the flag OFF. */
  forceCompacted: string[];
  /** P-018: owners whose capable psu host accepted a deterministic carry-respawn
   *  lifecycle verb this pass. Subset of overLimit; gated by the Phase-7 cutover. */
  carryRespawned: string[];
  /** P-017: running sessions whose STALE-above-cap compaction_limit was lowered to
   *  the current shaped default this pass (a policy change reaching a live session
   *  without a relaunch). */
  relimited: Array<{ owner: string; from: number; to: number }>;
  /** EI-237397: sessions whose observed fixed prompt floor consumes the force
   *  band; repairedTo is present when the watchdog raised a derived limit. */
  unsatisfiableLimits: Array<{
    owner: string;
    fixedFloor: number;
    limit: number;
    forceAt: number;
    repairedTo?: number;
  }>;
  /** owners seeded with a model-derived default limit this pass. */
  seeded: string[];
  /** P-019: owners whose transcript tail carries "Prompt is too long" (dead). */
  contextDeaths: string[];
  /** WI-10003466: owners whose live claude transcript ends in a streak of the provider's
   *  unavailable-tool-reference rejection (dead-but-still-beating after an MCP flap). */
  toolReferenceDeaths: string[];
  /** flush-to-proceed P-003: over-limit sessions holding a work-item claim whose checkpoint is
   *  stale (unflushed work about to be lost to a compaction/reclaim). SURFACED, never seized
   *  (D-008). One entry per (owner, stale claim). */
  unflushedClaims: Array<{ owner: string; workItemId: string; reason: StaleClaim['reason']; staleMs: number }>;
  /** P-018 boot self-assert: live members that FAILED the dark-telemetry assertion this pass —
   *  their context estimate never resolved (the gauge / per-turn reminder / force-compact are all
   *  blind to the session), so it can silently overflow. One entry per owner; escalated once per
   *  owner via escalateBootConfig. */
  bootConfigAlerts: Array<{ owner: string; kind: 'dark-telemetry' | 'dark-presence'; detail: string }>;
  /** WI-2140608: dark-telemetry escalations RESOLVED this pass because the owner's estimate
   *  resolves again; the per-process guard is re-armed so a later re-darkening re-escalates. */
  bootConfigRecovered: Array<{ owner: string; kind: 'dark-telemetry' }>;
  /** EI-10434: readings DISCARDED this pass for exceeding the plausibility ceiling —
   *  never cached, never counted toward overLimit/forceCompacted. One entry per owner. */
  implausibleReadings: Array<{ owner: string; est: number; ceiling: number }>;
  /** EI-21595542328480968: over-limit codex readings PROVEN to come from a dead
   *  predecessor's frozen rollout (identity mismatch + the session active long after
   *  that file stopped moving). Never cached, never counted toward
   *  overLimit/forceCompacted — acting on one is what disarms a live session's
   *  backstop. One entry per owner per pass. */
  frozenCodexReadings: Array<{ owner: string; est: number; lagMs: number }>;
  /** EI-18127246030401689: owners discovered via an ACTIVE loop routine with NO
   *  coord_presence row at all — self-healed a minimal row this pass so tracking
   *  resumes (see discoverPresencelessLoopOwners / healPresenceGap). Always paired
   *  with a 'dark-presence' bootConfigAlerts entry. */
  presenceGapsHealed: string[];
  /** D-137: owners for whom repeated exact compaction boundaries, stale/missing
   *  live-claim carry state, expired owner-held target locks, and no target edit
   *  after the latest boundary all agree. Fail-open: any unreadable signal is
   *  omitted rather than reported. */
  compactionStrandingAlerts: CompactionStrandingAlert[];
}

/**
 * One pass: SEED a model-derived default limit into limit-less live sessions
 * (context-trimming-tiers P-006/D-006 — the hook that arms the whole
 * agent-managed-compaction loop: signal + self-compaction only engage for
 * limit-carrying sessions), then refresh + cache each limit-setting live
 * session's context estimate and flag any that ran past its own limit.
 * Never throws (best-effort backstop).
 */
export interface CompactionComplianceDeps {
  /** Injectable D-137 side-lock reader; default reads papercusp_su. */
  readExpiredOwnerFileLocks?: CompactionStrandingLockReader;
}

export async function checkCompactionCompliance(
  sql: Sql,
  deps: CompactionComplianceDeps = {},
): Promise<CompactionComplianceResult> {
  const out: CompactionComplianceResult = {
    estimated: [],
    overLimit: [],
    forceCompacted: [],
    carryRespawned: [],
    relimited: [],
    unsatisfiableLimits: [],
    seeded: [],
    contextDeaths: [],
    toolReferenceDeaths: [],
    unflushedClaims: [],
    bootConfigAlerts: [],
    bootConfigRecovered: [],
    implausibleReadings: [],
    frozenCodexReadings: [],
    presenceGapsHealed: [],
    compactionStrandingAlerts: [],
  };
  // P-013 flag mirror: read FLAGS.CONTEXT_GAUGE once per pass and mirror it into the
  // in-process gauge switch the (sync) result-annotator reads. Best-effort — a flag-infra
  // hiccup leaves the previous value untouched (fail to the default-ON gauge).
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    setContextGaugeEnabled(await getFlag(FLAGS.CONTEXT_GAUGE, 'system'));
  } catch {
    /* keep the previous mirror value */
  }
  // EI-18127246030401689 dark-presence backstop: discover + self-heal live loop-armed
  // owners with NO coord_presence row at all, BEFORE the coord_presence-driven seed
  // pass below — a healed row's compaction_limit stays NULL (writePresence never sets
  // it), so it is picked up by that very next query within this SAME sweep instead of
  // waiting a full cycle. Best-effort per owner; never blocks the rest of the sweep.
  try {
    const gaps = await discoverPresencelessLoopOwners(sql);
    for (const gap of gaps) {
      const healed = await healPresenceGap(sql, gap);
      if (healed) out.presenceGapsHealed.push(gap.ownerId);
      out.bootConfigAlerts.push({
        owner: gap.ownerId,
        kind: 'dark-presence',
        detail: healed ? 'presence row healed this pass' : 'heal write failed — retrying next sweep',
      });
    }
  } catch (e) {
    console.warn(
      `[compaction-watchdog] dark-presence discovery pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Lazy per-pass tier menu, HOISTED so the seed pass AND the P-017 re-eval share ONE
  // workspace-config read: memoized, fail-soft to undefined (⇒ spec-derived defaults only).
  let tiersPromise: Promise<readonly ModelTier[] | undefined> | null = null;
  const tierMenu = () =>
    (tiersPromise ??= (async () => {
      try {
        const [{ effectiveTierConfig }, { readAgentConfig }] = await Promise.all([
          import('../fleet/model-tiers'),
          import('../agent-config'),
        ]);
        const cfg = await readAgentConfig().catch(() => null);
        return effectiveTierConfig(cfg, null).tiers;
      } catch {
        return undefined;
      }
    })());
  // Seeding step — one server-side place instead of N spawn paths (D-006).
  // Precedence: the spawn record (explicit tier limit > tier/recorded spec's
  // default) > the argv/fs model resolver (launch argv → session
  // settings.json) > the conservative 200k-window default (~158k). An agent's
  // own config:set-compaction-limit overwrites this at any time.
  try {
    // fleet_slug/fleet_role ride the presence row (mig 418 projection of
    // fleet_membership_events): a named-fleet MEMBER (any role but 'leader')
    // seeds the leaner [1m] member default (owner directive 2026-07-03) —
    // its state reconstructs cheaply from the work-item, so a smaller window
    // cuts per-wake cache spend; leaders keep the full default.
    const unseeded = await sql<
      { owner_id: string; fleet_slug: string | null; fleet_role: string | null }[]
    >`
      SELECT owner_id, fleet_slug, fleet_role
        FROM harness_shared.coord_presence
       WHERE compaction_limit IS NULL
         AND heartbeat_at > now() - interval '10 minutes'
       LIMIT ${MAX_SEEDS_PER_PASS}
    `;
    for (const r of unseeded) {
      try {
        const fleetMember = r.fleet_slug != null && r.fleet_role !== 'leader';
        const seed = await derivedSeedLimitForOwner(sql, r.owner_id, tierMenu, fleetMember);
        let limit = seed.limit;
        // WI-38347: a MEASURED effective window beats every spec-derived guess,
        // and for a non-Claude backend the guess is not merely imprecise — it is
        // a CATEGORY ERROR. `modelWindowForSpec` keys on the `[1m]` marker, which
        // is a Claude/CC auto-compact signal with NO meaning on codex or omp (see
        // its own docstring), so every non-Claude spec falls to the conservative
        // 200k branch and seeds 158,000. Measured 2026-08-13: 56 live codex
        // sessions on 158,000 against a true 258,400 window (correct: 207,000),
        // plus 2 omp — while the 3 codex sessions that named NO model, and so
        // resolved a null spec, landed on the right number. Specifying your model
        // correctly produced the WRONG limit; specifying nothing produced the
        // right one. Only the DERIVED branch is corrected: an explicit
        // `--compaction-limit` or per-tier limit stays the number someone chose.
        if (!seed.explicit) {
          const measured = await estimateContextWindowForOwner(r.owner_id).catch(() => null);
          if (measured != null) limit = defaultCompactionLimitForWindow(measured, { fleetMember });
        }
        // Record whether this seed came from an explicit launch/tier setting;
        // later derived repairs intentionally omit provenance so they preserve
        // this marker instead of turning a deliberate override into a seed.
        await setCompactionLimit(r.owner_id, limit, { explicit: seed.explicit });
        out.seeded.push(r.owner_id);
      } catch {
        /* best-effort per owner */
      }
    }
    if (out.seeded.length > 0) {
      console.log(`[compaction-watchdog] seeded default compaction limits for ${out.seeded.length} session(s)`);
    }
  } catch (e) {
    console.warn(
      `[compaction-watchdog] seed pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    const rows = await sql<
      {
        owner_id: string;
        owner_label: string;
        compaction_limit: number;
        compaction_limit_explicit: boolean | null;
        workspace_id: string;
        fleet_slug: string | null;
        fleet_role: string | null;
        last_active_at: string | null;
      }[]
    >`
      SELECT owner_id, owner_label, workspace_id, compaction_limit, compaction_limit_explicit, fleet_slug, fleet_role,
             last_active_at
        FROM harness_shared.coord_presence
       WHERE compaction_limit IS NOT NULL
         AND heartbeat_at > now() - interval '10 minutes'
    `;
    for (const r of rows) {
      // P-019 member-death detector: a "Prompt is too long" transcript tail means
      // the session is dead-but-still-beating — escalate once for relaunch. Runs
      // before the estimate gate (a dead session's estimate is exactly the kind
      // that looks "over limit" or fails to resolve).
      try {
        const contextDead = await detectContextDeathForOwner(r.owner_id);
        // WI-10003466: a streak of the provider's unavailable-tool-reference rejection is
        // the same dead-but-still-beating shape (hook-origin calls keep the presence beat
        // fresh), cured the same way — a fresh successor transcript + MCP connection.
        // Only checked when not already context-dead, so one owner gets one recovery.
        const toolReferenceDeath = contextDead ? null : await detectToolReferenceDeathForOwner(r.owner_id);
        if (contextDead || toolReferenceDeath) {
          const deathKind: TranscriptDeathKind = contextDead ? 'context-death' : 'tool-reference-death';
          if (contextDead) out.contextDeaths.push(r.owner_id);
          else out.toolReferenceDeaths.push(r.owner_id);
          // P-019 recovery-first: use the effective model window for the carry
          // budget, preferring the measured backend value and then the spec
          // resolver. A configured limit is the safe bounded fallback when
          // neither can resolve; clamp to the platform maximum so a bad/stale
          // setting cannot create an oversized successor context.
          let deathWindow: number | null = null;
          try {
            deathWindow = await estimateContextWindowForOwner(r.owner_id);
          } catch {
            /* resolver fallback below */
          }
          if (deathWindow == null) deathWindow = await resolveWindowForOwner(sql, r.owner_id, tierMenu);
          const carryWindow = Math.min(
            MODEL_WINDOW_1M,
            Math.max(1, deathWindow ?? r.compaction_limit),
          );
          if (
            (await recoverContextDeath(
              r.owner_id,
              r.owner_label,
              r.workspace_id,
              carryWindow,
              deathKind,
            )) === 'queued'
          ) {
            out.carryRespawned.push(r.owner_id);
          }
          continue; // no point estimating/flagging a dead session
        }
      } catch {
        /* best-effort per owner */
      }
      // D-137 repeated-compaction/pre-first-edit detector. Cache the stale-claim
      // classification for this owner so the existing over-limit P-003 surface
      // and this detector share one read. The detector itself checks the event
      // latch first, so ordinary sessions do not pay the cross-store reads.
      let staleClaimsForOwner: StaleClaim[] | null | undefined;
      const readStaleClaimsForOwner = async (): Promise<readonly StaleClaim[] | null> => {
        if (staleClaimsForOwner !== undefined) return staleClaimsForOwner;
        try {
          const fresh = await listActiveClaimFreshnessForOwner(null, r.owner_id, { sql });
          staleClaimsForOwner = classifyStaleClaims(fresh, Date.now());
        } catch {
          staleClaimsForOwner = null;
        }
        return staleClaimsForOwner;
      };
      const strandingAlert = await detectCompactionStrandingForOwner(
        sql,
        r.owner_id,
        r.owner_label,
        r.workspace_id,
        {
          readStaleClaims: readStaleClaimsForOwner,
          readExpiredOwnerFileLocks: deps.readExpiredOwnerFileLocks,
        },
      );
      if (strandingAlert) {
        out.compactionStrandingAlerts.push(strandingAlert);
        await escalateCompactionStranding(strandingAlert);
      } else {
        compactionStrandingEscalated.delete(r.owner_id);
      }
      // P-017 live-config reach: a stored limit ABOVE COMPACTION_LIMIT_DEFAULT_1M_CAP (the
      // ceiling clampCompactionLimit enforces on EVERY config:set-compaction-limit) cannot be a
      // valid explicit override — it is necessarily a STALE default from a superseded policy (the
      // 2026-07-04 incident: live members stuck at the old 500k after the cap dropped to 300k/400k,
      // with no way to push the fix short of a relaunch). Re-derive the current shaped default and
      // lower to it so a policy change reaches running sessions within one sweep. Cheap-gated on the
      // >cap check (steady-state passes resolve NOTHING) and one-directional (only lowers), so it
      // never clobbers an explicit lower override. Mutate r.compaction_limit so the over-limit gate
      // below re-checks against the corrected limit THIS pass (a now-over session force-compacts).
      if (!r.compaction_limit_explicit && r.compaction_limit > COMPACTION_LIMIT_DEFAULT_1M_CAP) {
        try {
          const fleetMember = r.fleet_slug != null && r.fleet_role !== 'leader';
          // WI-38347: re-derives through the SAME precedence the seed pass uses
          // (explicit launch flag > spawn record > spec default) rather than a
          // second hand-inlined copy of it. Still one-directional below.
          const fresh = (await derivedSeedLimitForOwner(sql, r.owner_id, tierMenu, fleetMember)).limit;
          if (fresh < r.compaction_limit) {
            await setCompactionLimit(r.owner_id, fresh);
            out.relimited.push({ owner: r.owner_id, from: r.compaction_limit, to: fresh });
            console.warn(
              `[compaction-watchdog] re-limited ${r.owner_label} (${r.owner_id}): ` +
                `${r.compaction_limit} → ${fresh} tokens — stale default above the current policy cap ` +
                `reached a live session without a relaunch (P-017).`,
            );
            r.compaction_limit = fresh;
          }
        } catch {
          /* best-effort per owner */
        }
      }
      const est = await estimateContextTokensForOwner(r.owner_id);
      if (est == null) {
        // P-018 boot self-assert (dark telemetry): a live limit-carrying session whose context
        // estimate never resolves is BLIND — the gauge, the per-turn reminder, and the P-012
        // force-compact backstop all read null, so it can silently overflow its model window
        // (the 836k incident class). Grace a few sweeps (a normal boot reads null briefly before
        // its transcript lands), then escalate once. A context-DEAD session (P-019 above) already
        // `continue`d, so this is a live-but-blind session, not a corpse.
        //
        // WI-2140608: only an ACTIVE null sweep advances the streak — a blind session that is
        // taking no turns (a carry-respawn successor parked until its wake, a codex rollout
        // stalled before its first token_count) is not consuming context and cannot overflow.
        // Idle sweeps neither advance nor reset the streak: the hazard is turns-while-blind,
        // and three of those over ANY span is the signal, however much idle time sits between.
        if (!activeWithin(r.last_active_at, DARK_TELEMETRY_ACTIVE_WINDOW_MS)) continue;
        const streak = (nullEstimateStreak.get(r.owner_id) ?? 0) + 1;
        nullEstimateStreak.set(r.owner_id, streak);
        if (streak >= DARK_TELEMETRY_MAX_NULL_SWEEPS) {
          // A null estimate is a FALSE POSITIVE for two owner classes — neither is a blind
          // managed session, so neither may raise a dark-telemetry alarm:
          //   (1) OMP self-compacts natively, so estimateContextTokensForOwner returns
          //       null for it BY DESIGN. Codex is deliberately NOT exempt: D-011 disables
          //       its native compaction, so a missing rollout estimate is now genuinely dark.
          //   (2) a SYNTHETIC principal that is not a launched agent session at all — an MCP-call
          //       principal (`mcp-call-<pid>`), a bare-UUID UI client, etc. It has NO adv_sessions
          //       row, so resolveSessionRef returns null; with no session/transcript to compact a
          //       null estimate is meaningless, not "blind" — WI-2917. (These get a compaction_limit
          //       seeded by the pass above purely because they carry a live presence heartbeat.)
          // A REAL Claude or Codex session whose transcript merely won't resolve DOES have an
          // adv_sessions row, so it still escalates below — the overflow signal is preserved.
          // EI-13477: reconciled — see resolveLiveTranscriptPath for why the raw
          // ref can under/over-classify an owner across a same-pid relaunch.
          const ref = await resolveSessionRefReconciled(r.owner_id);
          if (!ref || ref.agent === 'omp') {
            nullEstimateStreak.delete(r.owner_id); // by-design / synthetic null — don't accumulate a streak
            continue;
          }
          out.bootConfigAlerts.push({ owner: r.owner_id, kind: 'dark-telemetry', detail: `${streak} null sweeps` });
          await escalateBootConfig(
            r.owner_id,
            r.owner_label,
            'dark-telemetry',
            `${r.owner_label} has DARK context telemetry — its estimate stayed null across ${streak} ACTIVE watchdog sweeps (turns taken while blind; ~${streak * 2}min of activity)`,
            `estimateContextTokensForOwner returns null, so the context gauge, the per-turn usage reminder, and the force-compact backstop are ALL blind to this session — it can silently overflow its model window (the 2026-07-04 836k class). Usually a missing/unreadable transcript or an unresolved model spec. Check the session's transcript path + model resolution; relaunch if wedged. (agent-managed-compaction-2026-07-01 P-018)`,
          );
        }
        continue;
      }
      nullEstimateStreak.delete(r.owner_id); // estimate resolved — clear the dark-telemetry streak
      await recoverBootConfig(r.owner_id, 'dark-telemetry', out); // WI-2140608: close the row we raised
      // D-011: Codex reports its EFFECTIVE window in every token_count event
      // (258400 for a 272k model at 95%). A stale/unknown-spec seed can be 400k,
      // which means the warning and carry cut would literally be scheduled after
      // the hard wall.
      //
      // WI-38347 — this re-limit USED to be lower-only, and that one-directional
      // repair is what made the codex mis-seed PERMANENT: 158,000 sits BELOW the
      // 207,000 the measured window derives, so the heal could never reach it.
      // The perverse consequence is worth stating plainly, because it is the
      // shape to look for in any self-healing limit: the sessions that named
      // their model CORRECTLY were the broken ones (spec → the `[1m]`-marker
      // binary → a fabricated 200k window → 158,000, unraisable forever), while
      // the sessions that named NOTHING resolved a null spec, seeded 400,000,
      // and were correctly LOWERED to 207,000 on their first sweep. A repair
      // that only runs downhill does not just miss half its cases — it converts
      // a GOOD input into the unfixable one.
      //
      // So the direction is now decided by PROVENANCE, not by sign:
      //   • EXPLICIT values may exceed the 400k seeded role cap. Keep them
      //     unless they exceed the measured self-set ceiling, which is the
      //     actual model-safety bound for a deliberate runtime override.
      //   • NON-EXPLICIT values above the seeded safe limit still lower, while
      //     values below it raise only when they match a current/superseded
      //     derived seed. This preserves the legacy healing behavior without
      //     clobbering config:set-compaction-limit.
      // The raise gate is cheap-gated on `<` so a healed session pays for the
      // re-derive exactly once: afterwards the stored limit EQUALS safeLimit and
      // neither branch is taken.
      let liveWindow: number | null = null;
      try {
        liveWindow = await estimateContextWindowForOwner(r.owner_id);
        if (liveWindow != null) {
          const fleetMember = r.fleet_slug != null && r.fleet_role !== 'leader';
          const safeLimit = defaultCompactionLimitForWindow(liveWindow, { fleetMember });
          const selfSetCeiling = selfSetCeilingForWindow(liveWindow, { fleetMember });
          let apply: number | null = null;
          if (r.compaction_limit_explicit) {
            if (r.compaction_limit > selfSetCeiling) apply = selfSetCeiling;
          } else if (r.compaction_limit > safeLimit) {
            apply = safeLimit;
          } else if (r.compaction_limit < safeLimit) {
            const seed = await derivedSeedLimitForOwner(sql, r.owner_id, tierMenu, fleetMember);
            // WI-39789: heal a stored limit that matches the CURRENT derived
            // default OR one a SUPERSEDED policy derived for this spec. The
            // second test is not belt-and-braces — without it, changing a
            // derivation silently orphans every live session still carrying the
            // old number: it stops equalling the new default, so it reads as a
            // deliberate override, and the lower-only branch cannot reach it
            // because a stale seed sits BELOW the correct one. That is the same
            // unraisable-forever shape this block was written to cure, arriving
            // sideways (a policy change) instead of downhill. Measured: moving
            // the extended-codex derivation to the 400k role cap stranded 13
            // live sessions at the old 158,000 (2026-08-18).
            const superseded = supersededDerivedCompactionLimits(seed.spec, { fleetMember });
            if (
              !seed.explicit &&
              (seed.limit === r.compaction_limit || superseded.includes(r.compaction_limit))
            ) {
              apply = safeLimit;
            }
          }
          if (apply != null) {
            await setCompactionLimit(r.owner_id, apply);
            out.relimited.push({ owner: r.owner_id, from: r.compaction_limit, to: apply });
            console.warn(
              `[compaction-watchdog] re-limited ${r.owner_label} (${r.owner_id}): ` +
                `${r.compaction_limit} → ${apply} tokens from the live effective ` +
                `${liveWindow}-token model window (Codex D-011).`,
            );
            r.compaction_limit = apply;
          }
        }
      } catch {
        /* best-effort; the estimator's dark-telemetry path remains the guard */
      }
      // EI-10434 sanity clamp — discard + re-sample BEFORE this reading can drive
      // anything (cache, gauge, over-limit warn, or force-compact). See the
      // IMPLAUSIBLE_READING_* constants above for the full rationale.
      if (est > IMPLAUSIBLE_READING_ABSOLUTE_CEILING) {
        if (!implausibleWarned.has(r.owner_id)) {
          implausibleWarned.add(r.owner_id);
          console.warn(
            `[compaction-watchdog] ${r.owner_label} (${r.owner_id}): DISCARDING an implausible ` +
              `estimate ~${est} tokens — exceeds ${IMPLAUSIBLE_READING_ABSOLUTE_CEILING} ` +
              `(${IMPLAUSIBLE_READING_FACTOR}× MODEL_WINDOW_1M=${MODEL_WINDOW_1M}, the largest window ` +
              `any shipped model has). No shipped model has a window this large, so this is a misread, ` +
              `not real usage — NEVER acting on it (no cache write, no over-limit warn, no ` +
              `force-compact); re-sampling next sweep (EI-10434).`,
          );
        }
        out.implausibleReadings.push({ owner: r.owner_id, est, ceiling: IMPLAUSIBLE_READING_ABSOLUTE_CEILING });
        continue;
      }
      implausibleWarned.delete(r.owner_id); // plausible again — re-arm the dedup for a future misread
      // EI-21595542328480968 frozen-reading gate. Deliberately evaluated ONLY for a
      // reading that is already over its limit — i.e. one about to drive a cut. An
      // under-limit reading drives nothing irreversible, so there is nothing to
      // protect it from, and checking it could only ever cost a healthy session its
      // telemetry: measured 2026-08-27, one live under-limit session satisfies both
      // conjuncts of `frozenCodexReading` while working perfectly well. Scoping the
      // gate to this branch is what makes it structurally unable to disarm a healthy
      // session — not the thresholds inside it. See frozenCodexReading's header.
      if (est >= r.compaction_limit * OVER_LIMIT_FRACTION) {
        const frozen = await frozenCodexReading(r.owner_id, r.last_active_at).catch(() => null);
        if (frozen) {
          out.frozenCodexReadings.push({ owner: r.owner_id, est, lagMs: frozen.lagMs });
          // The cached number is this session's ONLY telemetry, and a frozen one is
          // worse than none: it renders a live session's gauge as over-limit forever
          // and keeps nudging it to compact. Null is the honest bridge state.
          await clearContextEstimate(r.owner_id).catch(() => {});
          if (!frozenCodexWarned.has(r.owner_id)) {
            frozenCodexWarned.add(r.owner_id);
            console.warn(
              `[compaction-watchdog] ${r.owner_label} (${r.owner_id}): IGNORING a frozen ~${est}/${r.compaction_limit}-token ` +
                `codex reading — it came from ${frozen.rolloutPath}, a rollout belonging to a DIFFERENT session that ` +
                `stopped moving ${Math.round(frozen.lagMs / 60_000)}min before this session's own last activity. ` +
                `Acting on it would force-compact/carry-respawn a live session on a dead predecessor's usage, ` +
                `forever (EI-21595542328480968). No cache write, no over-limit warn, no force-compact.`,
            );
            await escalateBootConfig(
              r.owner_id,
              r.owner_label,
              'frozen-codex-reading',
              `${r.owner_label} has an UNTRUSTWORTHY context estimate — it is being read from another session's frozen rollout`,
              `The codex rollout resolved for this owner (${frozen.rolloutPath}) belongs to a DIFFERENT native session and last moved ` +
                `${Math.round(frozen.lagMs / 60_000)}min before this session's own last activity, so the ~${est}-token reading is a dead ` +
                `predecessor's, not this session's. Codex homes are keyed by the adv_sessions ROW id, so an owner holding more than one ` +
                `non-ended row can resolve to a predecessor's home. The watchdog is ignoring the reading (no cache, no force-compact) — ` +
                `which stops the infinite carry-respawn loop, but leaves this session with NO context telemetry until the resolution is ` +
                `fixed. Check for multiple non-ended adv_sessions rows for this owner. (EI-21595542328480968)`,
            );
          }
          continue;
        }
      }
      frozenCodexWarned.delete(r.owner_id); // trustworthy again — re-arm the dedup
      await setContextEstimate(r.owner_id, est).catch(() => {});
      // P-013/P-015: mirror the fresh estimate into the in-process gauge cache so the
      // result-annotator + native-tool hook render the banded gauge with ZERO per-call
      // DB cost (the watchdog is the single writer; readers never touch PG).
      const observedPromptFloor = observedPromptFloorForOwner(r.owner_id);
      recordContextUsage(r.owner_id, est, r.compaction_limit, Date.now(), observedPromptFloor);
      out.estimated.push(r.owner_id);

      // WI-2143843: a limit change is an explicit re-arm, while a stale streak is
      // no longer active history. Clear both the streak and its escalation dedup
      // before the current reading can drive another cut.
      const existingStreak = carryRespawnStreak.get(r.owner_id);
      const underLimitSince = carryRespawnUnderLimitSince.get(r.owner_id);
      const streakAgeStart = underLimitSince ?? existingStreak?.lastAt;
      if (
        existingStreak != null &&
        (existingStreak.limit !== r.compaction_limit ||
          (streakAgeStart != null &&
            Date.now() - streakAgeStart >= CARRY_RESPAWN_STREAK_WINDOW_MS))
      ) {
        carryRespawnStreak.delete(r.owner_id);
        carryRespawnLoopEscalated.delete(r.owner_id);
        carryRespawnUnderLimitSince.delete(r.owner_id);
        carryRespawnRequestedAt.delete(r.owner_id);
      }

      // WI-2143843: sample under-limit readings too. A fresh successor is expected
      // to boot below the limit after a landed cut; retaining that evidence is what
      // lets the churn verdict survive the transient recovery sample.
      const sampleEntry = carryRespawnStreak.get(r.owner_id);
      if (sampleEntry != null && est < sampleEntry.minEstSince) {
        sampleEntry.minEstSince = est;
      }

      // EI-237397 applies even when the ordinary estimate is still BELOW the
      // configured limit: the route-bound floor can materialize on the next
      // turn, so waiting for `est >= limit` would miss the exact first sample
      // that proves the limit is unsatisfiable.
      let windowForCut: number | null = liveWindow;
      if (observedPromptFloor?.tokens != null || est >= r.compaction_limit * OVER_LIMIT_FRACTION) {
        windowForCut ??= await resolveWindowForOwner(sql, r.owner_id, tierMenu);
        if (windowForCut != null && est >= windowForCut * WINDOW_CONTRADICTED_FACTOR) {
          console.warn(
            `[compaction-watchdog] ${r.owner_label} (${r.owner_id}): resolved window ${windowForCut} is ` +
              `CONTRADICTED by a live ~${est}-token estimate (≥${WINDOW_CONTRADICTED_FACTOR}×) — ` +
              `stale/shared model-spec input (EI-7632); treating the window as unknown.`,
          );
          windowForCut = null;
        }
      }
      const fixedFloor = observedPromptFloor?.tokens;
      if (fixedFloor != null) {
        const fractionAt = r.compaction_limit * FORCE_COMPACT_FRACTION;
        const capAt =
          windowForCut != null
            ? windowForCut - COMPACTION_WINDOW_MARGIN_TOKENS
            : r.compaction_limit * COMPACTION_OVERSHOOT_FACTOR;
        const forceAt = Math.min(fractionAt, capAt);
        if (fixedFloor >= forceAt) {
          const repairedTo = r.compaction_limit_explicit
            ? null
            : satisfiableCompactionLimitForPromptFloor(fixedFloor, windowForCut, r.compaction_limit);
          if (repairedTo != null) {
            const from = r.compaction_limit;
            await setCompactionLimit(r.owner_id, repairedTo);
            r.compaction_limit = repairedTo;
            out.relimited.push({ owner: r.owner_id, from, to: repairedTo });
            out.unsatisfiableLimits.push({ owner: r.owner_id, fixedFloor, limit: from, forceAt, repairedTo });
            recordContextUsage(r.owner_id, est, repairedTo, Date.now(), observedPromptFloor);
            overLimitOwners.delete(r.owner_id);
            forceCompactedAt.delete(r.owner_id);
            carryRespawnRequestedAt.delete(r.owner_id);
            carryRespawnUnderLimitSince.delete(r.owner_id);
            carryRespawnLoopEscalated.delete(r.owner_id);
            unsatisfiableLimitEscalated.delete(r.owner_id);
            if (est < repairedTo) continue;
          } else {
            out.unsatisfiableLimits.push({ owner: r.owner_id, fixedFloor, limit: r.compaction_limit, forceAt });
            await escalateUnsatisfiableCompactionLimit({
              ownerId: r.owner_id,
              ownerLabel: r.owner_label,
              estimate: est,
              fixedFloor,
              limit: r.compaction_limit,
              forceAt,
              window: windowForCut,
            });
            // Do not issue the standard self-compact/carry/force advice: it
            // is the action that recreates the fixed-floor livelock.
            continue;
          }
        }
      }

      if (est >= r.compaction_limit * OVER_LIMIT_FRACTION) {
        out.overLimit.push(r.owner_id);
        // flush-to-proceed P-003 SURFACE (not seize, D-008): a session over its compaction limit
        // that holds a work-item whose CHECKPOINT is stale is about to lose unflushed work to the
        // imminent compaction/reclaim — the exact failure the discipline targets. Name it (reusing
        // the P-002 classifier over a fleet-wide freshness read on the watchdog's own sql seam) so
        // the loss is visible in the over-limit warning + the result. Best-effort; auto-reclaim is
        // deliberately NOT wired here. Owner is a globally-unique session uuid ⇒ null workspace.
        const unflushed = (await readStaleClaimsForOwner()) ?? [];
        for (const s of unflushed) {
          out.unflushedClaims.push({ owner: r.owner_id, workItemId: s.workItemId, reason: s.reason, staleMs: s.staleMs });
        }
        if (!overLimitOwners.has(r.owner_id)) {
          overLimitOwners.add(r.owner_id);
          const flushNote =
            unflushed.length > 0
              ? ` HOLDING UNFLUSHED WORK: ${unflushed.map((s) => s.workItemId).join(', ')} — its checkpoint is stale, so a compaction/reclaim here loses that state (flush-to-proceed P-003).`
              : '';
          console.warn(
            `[compaction-watchdog] ${r.owner_label} (${r.owner_id}) is over its compaction limit: ` +
              `~${est}/${r.compaction_limit} tokens (${Math.round((est / r.compaction_limit) * 100)}%) — ` +
              `should have called session:request_compaction.${flushNote}`,
          );
        }
        // P-018 deterministic SOFT cut. A recent socket ACK means the lifecycle
        // verb is already queued behind the host's clean-boundary gate; suppress
        // both duplicate respawns and the older force-compact rung during the
        // shared grace. A failed/unsupported/flag-off attempt falls straight
        // through to the unchanged P-012 hard backstop below.
        // WI-2143843: this is no longer an under-limit recovery stretch.
        const window = windowForCut;
        const streakEntry = carryRespawnStreak.get(r.owner_id);
        const streakAgeStart =
          carryRespawnUnderLimitSince.get(r.owner_id) ?? streakEntry?.lastAt;
        carryRespawnUnderLimitSince.delete(r.owner_id);
        const lastCarryAt = carryRespawnRequestedAt.get(r.owner_id);
        const carryRecently =
          lastCarryAt != null && Date.now() - lastCarryAt < FORCE_RETRY_GRACE_MS;
        if (carryRecently) continue;
        // WI-5075 rapid-refire guard: a respawn streak without SUSTAINED recovery
        // means further cutting is not helping this owner. The streak evidence
        // distinguishes a pinned estimate from healthy cuts followed by churn;
        // either way, stop cutting, escalate once, and skip the force-compact rung
        // too (another cut would only repeat the live-work loss).
        const streakLive =
          streakEntry != null &&
          streakAgeStart != null &&
          Date.now() - streakAgeStart < CARRY_RESPAWN_STREAK_WINDOW_MS;
        const streakCount = streakLive ? streakEntry.count : 0;
        if (streakCount >= CARRY_RESPAWN_MAX_STREAK && streakEntry != null) {
          await escalateCarryRespawnLoop(r.owner_id, r.owner_label, streakCount, {
            estAtFirstCut: streakEntry.estAtFirstCut,
            minEstSince: streakEntry.minEstSince,
            limit: r.compaction_limit,
            window,
          });
          continue;
        }
        const carryWindow = Math.min(
          MODEL_WINDOW_1M,
          Math.max(1, window ?? Math.max(r.compaction_limit, est)),
        );
        if (
          await maybeCarryRespawn(
            r.owner_id,
            r.owner_label,
            r.workspace_id,
            carryWindow,
          )
        ) {
          carryRespawnRequestedAt.set(r.owner_id, Date.now());
          // WI-38347 leg 4: the BASELINE is pinned to the FIRST cut of the streak and
          // carried forward — re-baselining on each cut would compare a successor to
          // itself and report every landed cut as frozen.
          carryRespawnStreak.set(r.owner_id, {
            count: streakCount + 1,
            lastAt: Date.now(),
            limit: streakLive && streakEntry != null ? streakEntry.limit : r.compaction_limit,
            estAtFirstCut: streakLive && streakEntry != null ? streakEntry.estAtFirstCut : est,
            minEstSince:
              streakLive && streakEntry != null ? Math.min(streakEntry.minEstSince, est) : est,
          });
          out.carryRespawned.push(r.owner_id);
          continue;
        }

        // P-012 L2 mechanical backstop — but only past the FORCE grace band
        // (owner 2026-07-04): warned at 100%, forced at min(limit × 1.3,
        // window − margin). Deduped per crossing; a failed/hostless/under-band
        // attempt is NOT recorded, so it retries next pass until it lands (or
        // the session recovers below). EI-9982: a socket-ack'd inject that never
        // actually compacted (host deferred/dropped the idle-gated /compact under
        // continuous turns) no longer suppresses forever — once FORCE_RETRY_GRACE_MS
        // has elapsed and the session is STILL at/over its force threshold below,
        // it re-injects.
        const lastForcedAt = forceCompactedAt.get(r.owner_id);
        const forcedRecently =
          lastForcedAt != null && Date.now() - lastForcedAt < FORCE_RETRY_GRACE_MS;
        if (!forcedRecently) {
          const fractionAt = r.compaction_limit * FORCE_COMPACT_FRACTION;
          const capAt =
            window != null
              ? window - COMPACTION_WINDOW_MARGIN_TOKENS
              : r.compaction_limit * COMPACTION_OVERSHOOT_FACTOR;
          const forceAt = Math.min(fractionAt, capAt);
          const bound: ForceBound =
            fractionAt <= capAt ? 'fraction' : window != null ? 'window' : 'overshoot';
          if (
            est >= forceAt &&
            (await maybeForceRespawn(
              r.owner_id,
              r.owner_label,
              r.workspace_id,
              carryWindow,
              est,
              r.compaction_limit,
              forceAt,
              bound,
            ))
          ) {
            forceCompactedAt.set(r.owner_id, Date.now());
            out.forceCompacted.push(r.owner_id);
          }
        }
      } else {
        overLimitOwners.delete(r.owner_id); // recovered (compacted / back under limit)
        forceCompactedAt.delete(r.owner_id); // re-arm the force for a future crossing
        carryRespawnRequestedAt.delete(r.owner_id); // re-arm the deterministic cut
        unsatisfiableLimitEscalated.delete(r.owner_id);
        const streakEntry = carryRespawnStreak.get(r.owner_id);
        if (streakEntry == null) {
          carryRespawnUnderLimitSince.delete(r.owner_id);
          carryRespawnLoopEscalated.delete(r.owner_id);
        } else {
          const underLimitSince = carryRespawnUnderLimitSince.get(r.owner_id) ?? Date.now();
          carryRespawnUnderLimitSince.set(r.owner_id, underLimitSince);
          if (Date.now() - underLimitSince >= CARRY_RESPAWN_STREAK_WINDOW_MS) {
            // A landed cut's first low sample is transient successor evidence, not
            // proof that the owner has stably recovered. Re-arm only after the
            // complete streak window has elapsed below the limit.
            carryRespawnStreak.delete(r.owner_id);
            carryRespawnLoopEscalated.delete(r.owner_id);
            carryRespawnUnderLimitSince.delete(r.owner_id);
          }
        }
        noHostWarned.delete(r.owner_id); // re-arm the EI-9982 diagnostic for a future crossing
      }
    }
  } catch (e) {
    console.warn(
      `[compaction-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return out;
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * EI-16190: known behavior-cutovers this watchdog's enforcement code must run
 * AT OR AFTER. A deploy restarts :3070, but a long-lived STANDALONE process
 * that also loads this module (papercup-bg-host, an embed-sidecar, a gateway
 * process, …) is NOT part of that restart set — it keeps running whatever
 * code was in memory when it last booted. The 2026-07-18 incident: P-022
 * retired native `/compact` fleet-wide, every :3070-served path picked it up
 * on deploy, but bg-host had been up since 2026-07-17 (hours before the
 * rewrite landed) and kept enforcing PRE-P-022 semantics for ~13h — completely
 * silently, because the zero-invocation transcript audit (native-compaction-audit.ts)
 * only proves the ABSENCE of native compact_boundary rows; it has no way to see
 * that the enforcer itself is stale. Add one entry here for every future
 * watchdog-behavior cutover so the NEXT one self-flags at boot instead of
 * requiring a human to notice a 13-hour silent gap.
 */
export const WATCHDOG_BEHAVIOR_CUTOVERS: ReadonlyArray<{ id: string; atMs: number; note: string }> = [
  {
    id: 'P-022-native-compact-retirement',
    atMs: Date.parse('2026-07-18T00:00:00Z'),
    note:
      'native /compact retired fleet-wide (WI-4998) — carry-respawn is the only context cut from this ' +
      'point on; a pre-cutover process still types the retired mode:"compact" (dropped loudly by ' +
      'psu-pty-host as of this same fix, but the SENDER is the thing that needs restarting).',
  },
];

/**
 * Pure + injectable (EI-16190): given this process's boot instant, return the
 * known cutovers it PREDATES — i.e. cutovers whose behavior change may not be
 * reflected in the code this process is actually running. Empty ⇒ this
 * process booted after every known cutover (the healthy case).
 */
export function staleCutoversForProcessStart(
  processStartedAtMs: number,
  cutovers: ReadonlyArray<{ id: string; atMs: number; note: string }> = WATCHDOG_BEHAVIOR_CUTOVERS,
): Array<{ id: string; atMs: number; note: string }> {
  return cutovers.filter((c) => Number.isFinite(c.atMs) && processStartedAtMs < c.atMs);
}

/** Dedup so a long-lived process warns/escalates about a given stale cutover
 *  exactly once, not every restart-of-the-watchdog-timer within one process. */
const staleCutoverEscalated = new Set<string>();

/** Test seam. */
export function resetStaleCutoverEscalationsForTests(): void {
  staleCutoverEscalated.clear();
}

/**
 * EI-16190 boot self-assert: one advisory coord escalation per (process,
 * cutover) when this host's own process demonstrably predates a known
 * behavior-cutover instant. Best-effort — never throws; a failed escalation
 * un-dedups so a later sweep can retry (mirrors escalateBootConfig).
 */
async function escalateStaleCutoverProcess(
  cutoverId: string,
  processStartedAtMs: number,
  cutoverAtMs: number,
  note: string,
): Promise<void> {
  if (staleCutoverEscalated.has(cutoverId)) return;
  staleCutoverEscalated.add(cutoverId);
  const bootIso = new Date(processStartedAtMs).toISOString();
  const cutoverIso = new Date(cutoverAtMs).toISOString();
  console.warn(
    `[compaction-watchdog] PRE-CUTOVER PROCESS (pid ${process.pid}): this host booted ${bootIso}, BEFORE the ` +
      `"${cutoverId}" cutover (${cutoverIso}) — ${note} This process may be enforcing stale behavior (EI-16190 ` +
      `class: a deploy restarted other hosts but not this long-lived one). RESTART this process to pick up the ` +
      `current enforcement code.`,
  );
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      {
        severity: 'advisory',
        summary: `pre-cutover process (pid ${process.pid}) still running: predates the "${cutoverId}" behavior cutover`,
        body:
          `This process's compaction watchdog booted ${bootIso}, before the "${cutoverId}" cutover landed ` +
          `(${cutoverIso}). ${note} Find this process (it is whichever long-lived host loaded ` +
          `compaction-compliance-watchdog.ts at that boot time — bg-host is the known repeat offender, EI-16190) ` +
          `and restart it so it runs current enforcement code. (EI-16190)`,
        // WI-5848 (sweep of EI-18668025239634541's class): `summary` embeds
        // `process.pid`, which varies across a process restart for the SAME
        // cutoverId — the in-memory `staleCutoverEscalated` guard (keyed on
        // cutoverId, not pid) is the only protection, and it resets on that
        // same restart. Key on cutoverId (the guard's own key), not the pid.
        meta: { subjectSignature: `compaction-watchdog:stale-cutover:${cutoverId}` },
      },
    );
  } catch (e) {
    staleCutoverEscalated.delete(cutoverId);
    console.warn(
      `[compaction-watchdog] stale-cutover escalation failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Start the compaction-compliance watchdog: a recurring process-level sweep.
 * Idempotent. Kill-switch: PAPERCUSP_COMPACTION_WATCHDOG='0'.
 */
export function startCompactionComplianceWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_COMPACTION_WATCHDOG === '0') return;
  // EI-16190: version/boot stamp, logged once at start — makes a stale
  // long-lived host trivially greppable across every host's logs, and
  // self-flags (+ escalates) the specific known-cutover misses above.
  const processStartedAtMs = Date.now() - process.uptime() * 1000;
  const stale = staleCutoversForProcessStart(processStartedAtMs);
  console.log(
    `[compaction-watchdog] starting (pid ${process.pid}, booted ${new Date(processStartedAtMs).toISOString()})` +
      (stale.length === 0 ? ' — up to date with all known behavior cutovers.' : ''),
  );
  for (const c of stale) {
    void escalateStaleCutoverProcess(c.id, processStartedAtMs, c.atMs, c.note);
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval(
    'compaction-compliance-watchdog',
    intervalMs,
    () => {
      void checkCompactionCompliance(sql);
    },
    { category: 'watchdog' },
  );
}
