/**
 * push-utilization — the utilization LEDGER + eviction scorer for ambient-
 * semantic-push-2026-07-14 (Phase 6, P-011), built to plan D-005 (which
 * inherits deterministic-context-carry D-001: no runtime self-adaptation —
 * telemetry is dashboard-only, a HUMAN retires or tunes a matcher).
 *
 * The standing test EVERY matcher lives under. It consumes the auditable output
 * of the {@link SelectPushesResult ambient-push selection pipeline} — the
 * delivered pushes plus every {@link DroppedPush} with its reason — joins each
 * DELIVERED push to a later-arriving OUTCOME (pulled? acted on?), and rolls the
 * whole thing into a per-matcher utilization report + an ADVISORY-ONLY
 * retire/tune/keep recommendation. Mirrors maxturn-sweep's scoreMaxTurnSweep /
 * cold-boot-drill's gradeColdBootDrills: pure, nullable metrics (never a
 * fabricated 0), a recommendation stamped `advisoryOnly: true`.
 *
 * THE DELIBERATE NON-CAPABILITY (D-005 / carry D-001): this module produces a
 * REPORT and a RECOMMENDATION and NOTHING ELSE. It exposes no function that
 * mutates a policy, disables a matcher, or feeds back into selection — the
 * control path never reads utilization at runtime. Eviction/tuning is a human
 * reading the dashboard and editing config; the recommendation is a suggestion
 * for that human, not an actuator.
 *
 * DEFERRED live leg (DEFAULT-OFF, later phase): the "acted-on" SIGNAL EXTRACTION
 * — deciding from a live session's trace whether a delivered push led to a route
 * change / lock taken / fact read. That is the {@link OutcomeProbe} seam; this
 * module CONSUMES an already-extracted {@link PushOutcome}, it never derives one.
 */
import type {
  MatcherKind,
  PushObject,
  PushSessionClass,
  DropReason,
  DroppedPush,
  SelectPushesResult,
} from './ambient-push';

// ─────────────────────────────────────────────────────────────────────────────
// The lifecycle signal: pushed → pulled? → acted on?
// ─────────────────────────────────────────────────────────────────────────────

/** The downstream ACTIONS that count as "acted on" (plan P-011, verbatim: "route
 *  change, lock taken, fact read"). Deriving these from a live trace is the
 *  deferred {@link OutcomeProbe} leg; this module only tallies them. */
export type ActedSignalKind = 'route-change' | 'lock-taken' | 'fact-read';

/** The observed outcome of ONE delivered push. `pulled` = the agent resolved the
 *  handle (fetched the brief); `acted` = a downstream action followed (possibly
 *  from the teaser alone, without pulling — that is still genuine engagement).
 *  Produced by the live outcome probe; absent (null on the ledger entry) until
 *  the probe observes it — never fabricated as a false "not pulled". */
export interface PushOutcome {
  pulled: boolean;
  acted: boolean;
  /** Which action, when acted. Omitted when !acted. */
  actionKind?: ActedSignalKind;
}

/** Did the push reach the agent, or did selection drop it (and why)? */
export type Delivery = { kind: 'delivered' } | { kind: 'dropped'; reason: DropReason };

/** One row of the ledger: a push, how it was delivered, and its observed outcome
 *  (null = not yet observed, or dropped — a dropped push has no outcome). */
export interface LedgerEntry {
  pushKey: string;
  push: PushObject;
  matcherKind: MatcherKind;
  sessionClass: PushSessionClass;
  delivery: Delivery;
  outcome: PushOutcome | null;
  observedAt: number | null;
}

/** A stable correlation key joining a delivered push to its later outcome. The
 *  outcome probe MUST key its results by this same function so the join lands.
 *  Content-derived (matcher + handle + peer source) — deterministic, no ids to
 *  thread through the transport. */
export function pushKey(push: PushObject): string {
  return [push.matcherKind, push.handle.kind, push.handle.ref, push.sourceSessionId ?? ''].join('::');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger assembly (join a selection round to its outcomes)
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildLedgerInput {
  /** One round's selection output from ambient-push.selectPushes. */
  selection: SelectPushesResult;
  /** The class of the session this round was selected for. */
  sessionClass: PushSessionClass;
  /** Outcomes for the DELIVERED pushes, keyed by {@link pushKey} — the deferred
   *  live signal. Absent ⇒ every delivered entry carries outcome:null (pending),
   *  which the scorer correctly excludes from rates (a pending push is not
   *  counted as "not pulled"). */
  outcomes?: ReadonlyMap<string, PushOutcome>;
  now?: () => number;
}

/**
 * Turn ONE selection round into ledger entries: every delivered push (joined to
 * its outcome if the probe has one) and every dropped push (with its reason,
 * outcome always null — it never reached the agent). PURE. Accumulate the arrays
 * across rounds/sessions and hand the flat list to {@link scorePushUtilization}.
 */
export function buildLedger(input: BuildLedgerInput): LedgerEntry[] {
  const now = input.now ?? Date.now;
  const at = now();
  const entries: LedgerEntry[] = [];

  for (const push of input.selection.selected) {
    const key = pushKey(push);
    entries.push({
      pushKey: key,
      push,
      matcherKind: push.matcherKind,
      sessionClass: input.sessionClass,
      delivery: { kind: 'delivered' },
      outcome: input.outcomes?.get(key) ?? null,
      observedAt: at,
    });
  }

  for (const d of input.selection.dropped) {
    entries.push({
      pushKey: pushKey(d.push),
      push: d.push,
      matcherKind: d.push.matcherKind,
      sessionClass: input.sessionClass,
      delivery: { kind: 'dropped', reason: d.reason },
      outcome: null,
      observedAt: at,
    });
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-matcher utilization aggregate (the dashboard rows)
// ─────────────────────────────────────────────────────────────────────────────

const ALL_DROP_REASONS: readonly DropReason[] = ['below-floor', 'severity-gated', 'not-novel', 'budget-exhausted'];
const ALL_ACTED_KINDS: readonly ActedSignalKind[] = ['route-change', 'lock-taken', 'fact-read'];

/** Ship/severity order (D-006): collision first, insight last. Fixes a stable,
 *  meaningful row order on the dashboard and in recommendations. */
const MATCHER_ORDER: readonly MatcherKind[] = ['collision', 'dead-end', 'topic-sub', 'insight'];

function matcherRank(m: MatcherKind): number {
  const i = MATCHER_ORDER.indexOf(m);
  return i === -1 ? MATCHER_ORDER.length : i;
}

export interface MatcherUtilization {
  matcherKind: MatcherKind;
  /** Pushes this matcher DELIVERED (reached the agent). */
  delivered: number;
  /** Delivered pushes for which the probe has an outcome — the rate denominator.
   *  A pending (outcome:null) push is NOT counted as "not pulled". */
  observed: number;
  pulled: number;
  acted: number;
  /** observed pushes that were pulled OR acted on (either is real engagement). */
  engaged: number;
  /** Delivered but never picked up: observed − engaged. The D-005 signal — "pushes
   *  that are not pulled show up on the dashboard". */
  ignored: number;
  /** pulled / observed. null when observed == 0. */
  pullRate: number | null;
  /** acted / observed. null when observed == 0. */
  actRate: number | null;
  /** engaged / observed — the headline utilization. null when observed == 0. */
  engagementRate: number | null;
  actedByKind: Record<ActedSignalKind, number>;
  /** Pushes this matcher proposed that selection DROPPED, by reason. */
  droppedByReason: Record<DropReason, number>;
  totalDropped: number;
  /** delivered / (delivered + totalDropped): how much of what the matcher
   *  proposed actually shipped. null when the matcher proposed nothing. */
  deliveryRate: number | null;
}

function zeroDropReasons(): Record<DropReason, number> {
  return { 'below-floor': 0, 'severity-gated': 0, 'not-novel': 0, 'budget-exhausted': 0 };
}
function zeroActedKinds(): Record<ActedSignalKind, number> {
  return { 'route-change': 0, 'lock-taken': 0, 'fact-read': 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// The advisory recommendation (a suggestion for the human — never an actuator)
// ─────────────────────────────────────────────────────────────────────────────

export type MatcherVerdict = 'healthy' | 'underutilized' | 'insufficient-data';
/** The action the human might take. 'keep' / 'tune' / 'retire' / 'gather-more-data'. */
export type SuggestedAction = 'keep' | 'tune' | 'retire' | 'gather-more-data';

export interface MatcherRecommendation {
  matcherKind: MatcherKind;
  verdict: MatcherVerdict;
  suggestedAction: SuggestedAction;
  rationale: string;
  /** The engagement rate the verdict rests on (null when insufficient data). */
  engagementRate: number | null;
  observed: number;
  /** Always true — retiring/tuning a matcher is a human decision (D-005 / carry
   *  D-001), never auto-applied. A field, not a free choice. */
  advisoryOnly: true;
}

export interface UtilizationScoreParams {
  /** A matcher needs ≥ this many OBSERVED delivered pushes before its verdict is
   *  trusted (below it: insufficient-data / gather-more-data). Default 20. */
  minObserved: number;
  /** Engagement at/above this rate ⇒ healthy / keep. Default 0.5. */
  healthyEngagementRate: number;
  /** Engagement below this rate ⇒ retire candidate (barely anyone engages).
   *  Between the two ⇒ tune. Default 0.2. */
  retireEngagementRate: number;
}

export const DEFAULT_UTILIZATION_PARAMS: UtilizationScoreParams = {
  minObserved: 20,
  healthyEngagementRate: 0.5,
  retireEngagementRate: 0.2,
};

export interface PushUtilizationReport {
  /** Per-matcher dashboard rows, in ship/severity order. */
  matchers: MatcherUtilization[];
  /** Per-matcher advisory recommendation, same order. */
  recommendations: MatcherRecommendation[];
  params: UtilizationScoreParams;
  totals: {
    delivered: number;
    observed: number;
    pulled: number;
    acted: number;
    engaged: number;
    dropped: number;
  };
  /** Always true — the whole report is advisory; nothing here steers the control path. */
  advisoryOnly: true;
}

/**
 * Roll a flat ledger into per-matcher utilization + an advisory retire/tune/keep
 * recommendation. PURE. Only DELIVERED pushes with an OBSERVED outcome feed the
 * engagement rates (pending/dropped never fabricate a "not pulled"); the verdict
 * rests on the engagement rate (pulled OR acted — acting on a teaser alone is
 * real use) against the params, and is ADVISORY ONLY — a human ratifies any
 * eviction/tune, the runtime never reads this (D-005 / carry D-001).
 */
export function scorePushUtilization(
  entries: LedgerEntry[],
  params: UtilizationScoreParams = DEFAULT_UTILIZATION_PARAMS,
): PushUtilizationReport {
  const byMatcher = new Map<MatcherKind, MatcherUtilization>();
  const ensure = (m: MatcherKind): MatcherUtilization => {
    let u = byMatcher.get(m);
    if (!u) {
      u = {
        matcherKind: m,
        delivered: 0,
        observed: 0,
        pulled: 0,
        acted: 0,
        engaged: 0,
        ignored: 0,
        pullRate: null,
        actRate: null,
        engagementRate: null,
        actedByKind: zeroActedKinds(),
        droppedByReason: zeroDropReasons(),
        totalDropped: 0,
        deliveryRate: null,
      };
      byMatcher.set(m, u);
    }
    return u;
  };

  for (const e of entries) {
    const u = ensure(e.matcherKind);
    if (e.delivery.kind === 'dropped') {
      u.droppedByReason[e.delivery.reason] += 1;
      u.totalDropped += 1;
      continue;
    }
    // delivered
    u.delivered += 1;
    if (e.outcome) {
      u.observed += 1;
      if (e.outcome.pulled) u.pulled += 1;
      if (e.outcome.acted) {
        u.acted += 1;
        if (e.outcome.actionKind) u.actedByKind[e.outcome.actionKind] += 1;
      }
      if (e.outcome.pulled || e.outcome.acted) u.engaged += 1;
    }
  }

  // Finalize derived rates.
  for (const u of byMatcher.values()) {
    u.ignored = u.observed - u.engaged;
    u.pullRate = u.observed ? u.pulled / u.observed : null;
    u.actRate = u.observed ? u.acted / u.observed : null;
    u.engagementRate = u.observed ? u.engaged / u.observed : null;
    const proposed = u.delivered + u.totalDropped;
    u.deliveryRate = proposed ? u.delivered / proposed : null;
  }

  const matchers = [...byMatcher.values()].sort((a, b) => matcherRank(a.matcherKind) - matcherRank(b.matcherKind));
  const recommendations = matchers.map((u) => recommend(u, params));

  const totals = matchers.reduce(
    (t, u) => {
      t.delivered += u.delivered;
      t.observed += u.observed;
      t.pulled += u.pulled;
      t.acted += u.acted;
      t.engaged += u.engaged;
      t.dropped += u.totalDropped;
      return t;
    },
    { delivered: 0, observed: 0, pulled: 0, acted: 0, engaged: 0, dropped: 0 },
  );

  return { matchers, recommendations, params, totals, advisoryOnly: true };
}

/** The advisory verdict for one matcher's utilization. PURE. Insufficient data
 *  (or none observed) never recommends eviction — it asks for more data. */
function recommend(u: MatcherUtilization, params: UtilizationScoreParams): MatcherRecommendation {
  const base = { matcherKind: u.matcherKind, engagementRate: u.engagementRate, observed: u.observed, advisoryOnly: true as const };

  if (u.observed < params.minObserved || u.engagementRate === null) {
    return {
      ...base,
      verdict: 'insufficient-data',
      suggestedAction: 'gather-more-data',
      rationale:
        `only ${u.observed} observed delivery${u.observed === 1 ? '' : 'ies'} (need ≥ ${params.minObserved}); ` +
        `no eviction call yet — gather more before a human decides (advisory, never auto-applied — D-005)`,
    };
  }

  const rate = u.engagementRate;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  if (rate >= params.healthyEngagementRate) {
    return {
      ...base,
      verdict: 'healthy',
      suggestedAction: 'keep',
      rationale:
        `engagement ${pct(rate)} ≥ ${pct(params.healthyEngagementRate)} over ${u.observed} observed ` +
        `(pulled ${u.pulled}, acted ${u.acted}) — carrying its weight; keep (advisory, human-ratified — D-005)`,
    };
  }

  if (rate < params.retireEngagementRate) {
    return {
      ...base,
      verdict: 'underutilized',
      suggestedAction: 'retire',
      rationale:
        `engagement ${pct(rate)} < ${pct(params.retireEngagementRate)} over ${u.observed} observed ` +
        `(${u.ignored} delivered pushes ignored) — a human should RETIRE or heavily rework this matcher ` +
        `(advisory only; the runtime never acts on this — D-005 / carry D-001)`,
    };
  }

  return {
    ...base,
    verdict: 'underutilized',
    suggestedAction: 'tune',
    rationale:
      `engagement ${pct(rate)} in [${pct(params.retireEngagementRate)}, ${pct(params.healthyEngagementRate)}) over ${u.observed} observed ` +
      `— some use but below the healthy bar; a human should TUNE its floor/thresholds before retiring ` +
      `(advisory, human-ratified — D-005)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The DEFERRED live leg (a named seam; nothing here calls it)
// ─────────────────────────────────────────────────────────────────────────────

/** The LIVE outcome-extraction seam (DEFAULT-OFF, later phase): given the pushes
 *  delivered to a session, inspect that session's subsequent trace and decide,
 *  per push, whether it was pulled (handle resolved) and/or acted on (route
 *  change / lock taken / fact read), keyed by {@link pushKey}. Deriving those
 *  signals is host-coupled (it reads live coord + session state) and stays
 *  staged until the owner arms it — mirroring maxturn-sweep's CellDriver and the
 *  sibling cores' injected drivers. This module never invokes it; it only
 *  consumes the {@link PushOutcome} map such a probe would return. */
export type OutcomeProbe = (
  delivered: LedgerEntry[],
  opts: { now: () => number },
) => Promise<ReadonlyMap<string, PushOutcome>>;
