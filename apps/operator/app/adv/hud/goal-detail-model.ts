/**
 * The goal DETAIL view's pure model (goal-mode-2026-08-07 P-021).
 *
 * The rail tab is the GLANCE ("is anything on fire"); this is the CATCH-UP view
 * ("I have not looked in three days"). The two answer different questions, so
 * they get different shapes — this one is ordered by the question each section
 * answers, not by how the resolver happened to return them:
 *
 *   1. THIS GOAL ENDS WHEN — the kill criterion verbatim, plus live tripwire
 *      BARS. This is the headline idea of the whole surface: a criterion
 *      written as prose is a promise nobody re-checks; the same criterion as a
 *      readout is something you can act on.
 *   2. PROJECTS — each with ITS OWN kill criterion (contract clause 4) and a
 *      shared-with badge, killed ones kept visible.
 *   3. WAITING ON YOU — the only section the owner can ACT on, so it sits above
 *      the two informational ones.
 *   4. ACTIVITY.
 *   5. SPEND BY DAY, stacked by project.
 *
 * Split out of the component for the reason `hud-entity-board.ts` gives for its
 * own split: the interesting logic here (bar arithmetic, the stacked-spend
 * transform, the killed/active partition) is worth testing without a DOM and
 * without pulling a server module — and therefore `postgres` — into the test.
 *
 * ── The one convention this file imposes on tripwire AUTHORS ────────────────
 * A bar measures CONSUMPTION TOWARD A CEILING: `current` climbs, `threshold` is
 * where the goal should stop. An "at least" metric ("no shipped build yet")
 * must be authored as its complement ("days without a shipped build: 12 of 14")
 * or it renders backwards — 0/1 would fill 0% and read as healthy at exactly
 * the moment it is the thing you needed to see. Deliberately NOT solved with a
 * `direction` field: a second direction doubles the readings of every bar on
 * screen ("is a full bar good here?") to buy an expressiveness the complement
 * form already has. Recorded as goal-mode-2026-08-07#D-022.
 */
import { formatAge } from './hud-board-model';
/* The burn derivation is IMPORTED, not mirrored. ceilingLine below already
   admits to hand-mirroring goalSpendLabel "so the detail view and the card it
   opened from cannot disagree" — a promise kept only by whoever edits both. The
   rate is the number where disagreeing would be worst (it drives a date the
   owner acts on), so it has exactly one implementation and both surfaces call
   it. Direction is safe: hud-entity-board imports nothing from this module. */
import { budgetWindowSuffix, burnEtaText, burnTitle, goalBurn, goalCeilingSpendUsd } from './hud-entity-board';

/* ── The `goals.detail` wire shape, narrowed ──────────────────────────────
   Declared here rather than imported from `sync-resolver/goals.ts` for the
   reason `hud-entity-board.ts` gives for HudGoalInput: this module's whole
   value is being testable without a server module in the import graph. */

export interface GoalDetailTripwire {
  metric: string;
  label: string;
  threshold: number;
  /** Absent until something measures it — renders as an unread bar, not a zero. */
  current?: number | null;
  /** `usd` and `days` get bespoke phrasing; anything else is suffixed as-is. */
  unit?: string | null;
  /**
   * Provenance for `current`, stamped by the platform refresh. ABSENT — or
   * carrying a `value` that no longer matches `current` — means an agent typed
   * the number by hand (EI-21605510614702802).
   */
  measuredBy?: { source: string; atMs: number; value: number } | null;
}

export interface GoalDetailGoalInput {
  id: string;
  title: string;
  body?: string | null;
  status: string;
  killCriterion?: string | null;
  tripwires?: GoalDetailTripwire[] | null;
  budgetCents?: number | null;
  /** Enforced snapshot and its window — see HudGoalInput.spentCents. */
  spentCents?: number | null;
  budgetWindowSec?: number | null;
  spendUsd?: number | null;
  /** The recent-window spend behind the burn rate (P-003). Absent ⇒ no reading;
   *  see goalBurn, which refuses to render a zero it did not measure. */
  spendRecentUsd?: number | null;
  spendRecentWindowDays?: number | null;
  openWorkItems?: number | null;
  needsHuman?: number | null;
  potCount?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface GoalDetailPotInput {
  harnessSlug: string;
  role: string;
  killCriterion?: string | null;
  note?: string | null;
  addedAt?: string | null;
  /** Non-null ⇒ detached/killed. The row STAYS on the page — see partitionPots. */
  removedAt?: string | null;
  servesGoals?: number | null;
  spendUsd?: number | null;
  openWorkItems?: number | null;
}

export interface GoalDetailWaitingInput {
  id: string;
  title: string;
  harnessSlug?: string | null;
  updatedAt?: string | null;
}

export interface GoalDetailActivityInput {
  id: string;
  title: string;
  harnessSlug?: string | null;
  status?: string | null;
  closedAt?: string | null;
  updatedAt?: string | null;
}

export interface GoalDetailSpendDayInput {
  day: string;
  harnessSlug?: string | null;
  costUsd?: number | null;
}

/** One derived plan row for the work rail (P-019). Shape mirrors the resolver's
 *  `GoalPlanCard` — see D-010 for WHY a goal's plans are derived through its
 *  stamped work items rather than through its pots' harnesses. */
export interface GoalDetailPlanInput {
  planSlug: string;
  harnessSlug: string;
  title?: string | null;
  status?: string | null;
  archived?: boolean | null;
  items?: number | null;
  openItems?: number | null;
  /**
   * The plan carries this goal's stamp (`harness_plans.goal_id`) — this goal's
   * agent AUTHORED it, independently of whether any work item has come from it
   * yet. See the resolver's `GoalPlanCard.stamped`.
   *
   * REQUIRED, not optional-with-a-default, and deliberately so: the counts are
   * the DERIVED ones, so a freshly-started plan is a truthful `0 of 0`, which
   * reads as failure exactly when the owner is watching to see whether the
   * agent did anything. `stamped` is the only field that separates "new" from
   * "nothing happened", so a construction site that omits it would silently
   * reinstate the bug this flag exists to fix. The resolver always emits it;
   * anything else building one of these has to say which it means.
   */
  stamped: boolean;
  updatedAt?: string | null;
}

/** An agent RUNNING this goal — `agent_modes.subject`, the marker D-007 found
 *  already existed. A list, not a scalar: D-006 makes one the normal case, but
 *  a goal carrying two stamps is a coordination fault worth seeing. */
export interface GoalDetailAgentInput {
  ownerId: string;
  setAt?: string | null;
  setBy?: string | null;
  live?: boolean | null;
  sessionState?: string | null;
}

/**
 * A subdirective of the open goal (P-017 / D-006).
 *
 * id/title/status and nothing else. A child steers its parent's agent rather
 * than owning one, so there is no separable spend, ceiling or session to carry —
 * the absent fields are the decision, not an oversight.
 */
export interface GoalDetailSubGoalInput {
  id: string;
  title: string;
  status: string;
}

/**
 * The launch knobs a goal pins, per role or as its across-the-board default
 * (goal-mode-hardening-2026-08-10 P-004's `LaunchProfile`, as it arrives here).
 *
 * Every field optional and typed as `string` rather than as the server's unions:
 * the closed sets arrive with the payload (`launchSettingsOptions`) so the editor
 * renders what the validator enforces, and re-declaring the unions here would be
 * the second spelling D-011 exists to prevent.
 */
export interface GoalDetailLaunchProfile {
  agent?: string;
  model?: string;
  effort?: string;
  account?: string;
  carry?: string;
  contextSize?: string;
  /**
   * The one NON-string profile key: it is a boolean in the stored document, to
   * match the fleet layer's spelling. The editor renders it from a closed set of
   * strings and converts at the form boundary (goal-launch-settings-model.ts),
   * so this type deliberately keeps the document's shape rather than the form's.
   *
   * Absent = unpinned, which resolves to headless (D-002) — never read absence
   * as `false`.
   */
  headless?: boolean;
  /**
   * WI-2140338: the session's compaction ceiling in TOKENS (the schema's
   * `compactionLimit`, an integer in [50_000, 2_000_000]). The second non-string
   * profile key; the editor holds it as a string and parses at the boundary.
   * Absent = unpinned = the tier/system default.
   */
  compactionLimit?: number;
}

/**
 * One stored ceiling, in its three meaningful states (D-015).
 *
 * Absent/null is NOT "no ceiling" — it is "the owner has not pinned one", which
 * resolves to the system default. No-ceiling is the explicit literal, and the
 * editor has to keep the two distinguishable or it shows an ungoverned goal and
 * a defaulted one identically.
 */
export type GoalDetailCeiling = number | 'unlimited';

/** The document stored on the goal — D-005's two ceilings plus the profiles. */
export interface GoalDetailLaunchSettings {
  /** Ceiling over EVERY live session. Absent/null = the system default. */
  maxAgents?: GoalDetailCeiling | null;
  /** Ceiling on any ONE fleet pursuing it. Composes with maxAgents. */
  maxPerFleet?: GoalDetailCeiling | null;
  /** Holder-selected concurrent plan fleets. This is intent, not a ceiling. */
  intendedParallelPlanFleets?: number;
  defaults?: GoalDetailLaunchProfile;
  roles?: Record<string, GoalDetailLaunchProfile>;
}

/** The closed sets the editor may offer, shipped by the resolver from the
 *  schema's own constants so the form cannot drift from the validator. */
export interface GoalDetailLaunchOptions {
  agent?: readonly string[];
  carry?: readonly string[];
  contextSize?: readonly string[];
  headless?: readonly string[];
}

/**
 * The ceilings a goal that pins nothing launches under, shipped by the resolver
 * from `GOAL_LAUNCH_DEFAULTS` (D-015).
 *
 * Shipped rather than re-declared for the same reason `launchSettingsOptions` is
 * (D-011): a number hand-spelled in the editor is a second declaration of a value
 * the server owns, and it would fall silently out of step — showing "default 12"
 * next to a field the resolver is enforcing at some other number.
 */
export interface GoalDetailLaunchDefaults {
  maxAgents: number;
  maxPerFleet: number;
}

/** Narrow client-side view of the shared server obligation contract. The
 *  unions intentionally stay strings here: the server owns the policy
 *  vocabulary, while this client only presents the values it received. */
export interface GoalModeObligationInput {
  id: string;
  title: string;
  status: string;
  applicableDemand: number;
  sourceGeneration: string;
  dueAt?: string | null;
  ageMs?: number | null;
  reason?: string | null;
  action?: { summary?: string | null } | null;
  measurementFailure?: { code?: string; detail?: string; retry?: string } | null;
}

export interface GoalModeStateInput {
  schemaVersion?: string;
  status?: 'known' | 'degraded' | 'unknown' | string;
  ownerId?: string | null;
  observedAt?: string | null;
  portfolio?: {
    assembledAt?: string | null;
    goal?: { id?: string; title?: string; status?: string | null } | null;
    queue?: {
      total?: number;
      inFlight?: number;
      blocked?: number;
      needsHuman?: number;
      claimable?: number | null;
    } | null;
    priorities?: string[] | null;
  } | null;
  obligations?: {
    evaluatedAt?: string | null;
    sourceGeneration?: string | null;
    projection?: {
      entries?: GoalModeObligationInput[] | null;
      receipt?: {
        sink?: string;
        entriesAvailable?: number;
        entriesDelivered?: number;
        entriesOmitted?: number;
        bodyTruncated?: boolean;
        refused?: boolean;
        reason?: string;
      } | null;
    } | null;
    detailRef?: string | null;
  } | null;
  degradedReasons?: string[] | null;
  unknown?: { code?: string; detail?: string; retry?: string } | null;
}

export interface GoalDetailInput {
  goal: GoalDetailGoalInput | null;
  /** The read-only server projection shared with the goal holder's turn-start
   *  brief. Absent means wire skew/unmeasured, never an all-clear. */
  goalModeState?: GoalModeStateInput | null;
  /** held | unheld | lost | unknown, resolved by the server's holder oracle. */
  holderLiveness?: string | null;
  /** Raw active becomes dormant when policy requires a live holder and none exists. */
  effectiveStatus?: string | null;
  deactivated?: boolean | null;
  /** Null = nothing pinned, which is the launch default and NOT an error. */
  launchSettings?: GoalDetailLaunchSettings | null;
  /** Non-null when the stored document could not be read — so the ceilings are
   *  NOT being enforced. Rendered as an alarm, never as "no settings": an
   *  unreadable ceiling and an absent one look identical and mean opposite
   *  things about whether the owner's limit is holding. */
  launchSettingsInvalid?: string | null;
  /** WI-2140573: keys the reader stripped as unknown (dotted paths) — in force NOWHERE on that host. */
  launchSettingsUnknownKeys?: string[];
  launchSettingsOptions?: GoalDetailLaunchOptions | null;
  /** Absent = a payload from before D-015; the editor then says nothing about
   *  defaults rather than inventing numbers it would have to keep in step. */
  launchSettingsDefaults?: GoalDetailLaunchDefaults | null;
  /** Empty array = none; absent/null = a payload from before P-017. */
  subGoals?: GoalDetailSubGoalInput[] | null;
  /** Set only when the open goal is itself a subdirective. */
  parent?: { id: string; title: string } | null;
  pots?: GoalDetailPotInput[] | null;
  plans?: GoalDetailPlanInput[] | null;
  agents?: GoalDetailAgentInput[] | null;
  waitingOnYou?: GoalDetailWaitingInput[] | null;
  /** The UNBOUNDED count of items parked on the owner. `waitingOnYou` is capped
   *  at 25 rows by the resolver, so this is the only honest source for the
   *  headline number. Optional/nullable ON PURPOSE: absent means NOT MEASURED,
   *  which `waitingCount` reports as such rather than silently substituting the
   *  row count (same discipline as P-004's `unmeasured` silence state — an absent
   *  reading is not a zero, and it is not a total either). */
  waitingOnYouTotal?: number | null;
  activity?: GoalDetailActivityInput[] | null;
  spendByDay?: GoalDetailSpendDayInput[] | null;
  spendLabel?: string | null;
  spendNote?: string | null;
}

export interface GoalModeObligationView {
  id: string;
  title: string;
  status: string;
  action: string | null;
  reason: string | null;
  demand: number | null;
  deadline: string | null;
  age: string | null;
  sourceGeneration: string | null;
  measurementFailure: { code: string | null; detail: string | null; retry: string | null } | null;
}

export interface GoalModeStateView {
  status: 'known' | 'degraded' | 'unknown';
  ownerId: string | null;
  observedAt: string | null;
  portfolio: {
    title: string;
    status: string | null;
    queue: string | null;
    priorities: string[];
  } | null;
  obligations: GoalModeObligationView[];
  sourceGeneration: string | null;
  entriesAvailable: number | null;
  entriesDelivered: number | null;
  entriesOmitted: number | null;
  omissionReason: string | null;
  detailRef: string | null;
  notices: string[];
  empty: 'no-demand' | 'unavailable' | 'overflow' | null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Presentation-only fold for the goal-mode section. It never decides whether
 * an obligation applies or is satisfied: entries, status, demand, timing and
 * omissions all come directly from the server's evaluated projection.
 */
export function goalModeStateView(input: GoalModeStateInput | null | undefined): GoalModeStateView {
  if (!input) {
    return {
      status: 'unknown',
      ownerId: null,
      observedAt: null,
      portfolio: null,
      obligations: [],
      sourceGeneration: null,
      entriesAvailable: null,
      entriesDelivered: null,
      entriesOmitted: null,
      omissionReason: null,
      detailRef: null,
      notices: ['Goal-mode state was not included in this server response.'],
      empty: 'unavailable',
    };
  }

  const status = input.status === 'known' || input.status === 'degraded' ? input.status : 'unknown';
  const receipt = input.obligations?.projection?.receipt;
  const entriesAvailable = finiteNonNegative(receipt?.entriesAvailable);
  const entriesDelivered = finiteNonNegative(receipt?.entriesDelivered);
  const entriesOmitted = finiteNonNegative(receipt?.entriesOmitted);
  const obligations = (input.obligations?.projection?.entries ?? []).map((entry) => {
    const ageMs = finiteNonNegative(entry.ageMs);
    const demand = finiteNonNegative(entry.applicableDemand);
    return {
      id: entry.id,
      title: entry.title,
      status: entry.status,
      action: entry.action?.summary?.trim() || null,
      reason: entry.reason?.trim() || null,
      demand,
      deadline: entry.dueAt?.trim() || null,
      age: ageMs == null ? null : formatAge(Math.round(ageMs / 1_000)),
      sourceGeneration: entry.sourceGeneration?.trim() || null,
      measurementFailure: entry.measurementFailure
        ? {
            code: entry.measurementFailure.code?.trim() || null,
            detail: entry.measurementFailure.detail?.trim() || null,
            retry: entry.measurementFailure.retry?.trim() || null,
          }
        : null,
    };
  });

  const notices = [
    ...(status === 'unknown' && input.unknown?.detail ? [input.unknown.detail] : []),
    ...(status === 'unknown' && input.unknown?.retry ? [`Recovery: ${input.unknown.retry}`] : []),
    ...(status === 'degraded' ? (input.degradedReasons ?? []).filter(Boolean) : []),
  ];
  const queue = input.portfolio?.queue;
  const queueParts = queue
    ? [
        finiteNonNegative(queue.inFlight) == null ? null : `${queue.inFlight} in flight`,
        finiteNonNegative(queue.blocked) == null ? null : `${queue.blocked} blocked`,
        finiteNonNegative(queue.needsHuman) == null ? null : `${queue.needsHuman} needs you`,
        queue.claimable == null
          ? 'claimable unknown'
          : finiteNonNegative(queue.claimable) == null
            ? null
            : `${queue.claimable} claimable`,
      ].filter((part): part is string => part != null)
    : [];

  let empty: GoalModeStateView['empty'] = null;
  if (obligations.length === 0) {
    if (entriesAvailable != null && entriesAvailable > 0) empty = 'overflow';
    else if (status === 'known' && entriesAvailable === 0) empty = 'no-demand';
    else empty = 'unavailable';
  }

  return {
    status,
    ownerId: input.ownerId?.trim() || null,
    observedAt: input.observedAt?.trim() || null,
    portfolio: input.portfolio?.goal
      ? {
          title: input.portfolio.goal.title?.trim() || input.portfolio.goal.id?.trim() || 'Goal',
          status: input.portfolio.goal.status?.trim() || null,
          queue: queueParts.length > 0 ? queueParts.join(' · ') : null,
          priorities: (input.portfolio.priorities ?? []).filter((item) => typeof item === 'string' && item.trim()),
        }
      : null,
    obligations,
    sourceGeneration: input.obligations?.sourceGeneration?.trim() || null,
    entriesAvailable,
    entriesDelivered,
    entriesOmitted,
    omissionReason: receipt?.reason?.trim() || null,
    detailRef: input.obligations?.detailRef?.trim() || null,
    notices,
    empty,
  };
}

/* ── Tripwire bars ───────────────────────────────────────────────────────── */

export type TripwireTone = 'ok' | 'warn' | 'breached' | 'unread';

export interface TripwireBar {
  key: string;
  label: string;
  /** `$310 of $500`, `day 12 of 30`, `12 of 30 builds`. */
  valueText: string;
  /**
   * 0-100, clamped. Null when there is no bar to fill — which happens for TWO
   * different reasons: nothing has measured this yet, OR there is a reading but
   * no usable threshold to measure it against.
   *
   * So `pct == null` is NOT "unmeasured", and must never be used to answer that
   * question. Read `measured` instead.
   */
  pct: number | null;
  /**
   * Did anyone actually take a reading? This is the ONE field that separates
   * "unmeasured" from "measured at zero" — the distinction this whole surface
   * exists to preserve — and it is stated explicitly rather than left to be
   * re-derived from `pct` or `tone`, because both have other reasons to take
   * the value a caller would read as absent.
   */
  measured: boolean;
  /**
   * Did the PLATFORM measure it, or did an agent type it?
   *
   * Deliberately a SECOND field rather than a redefinition of `measured` above,
   * because they answer different questions and both are worth asking: `measured`
   * is "is there a reading at all" (its `measured at zero` vs `unread` distinction
   * is test-guarded), and this is "where did that reading come from". Collapsing
   * them would lose one of the two.
   *
   * False for every hand-set value — which is the ordinary case for a domain
   * metric, since `TripwireSchema` itself notes most such metrics "live outside
   * this database entirely". A hand-set number is still shown; it just may not
   * be presented as a measurement (EI-21605510614702802).
   */
  derived: boolean;
  /** When the platform last wrote this reading; null when hand-set. Lets a caller age it. */
  measuredAtMs: number | null;
  tone: TripwireTone;
  /** Hover text spelling out what crossing this bar means. */
  title: string;
}

/** At and past the ceiling. Below it, the last fifth is the warning band —
 *  early enough to redirect the goal, late enough not to cry wolf all run. */
const WARN_AT_PCT = 80;

function moneyish(n: number): string {
  // Whole dollars: a goal ceiling is a four-figure decision, and cents on a
  // progress bar are noise that makes two bars harder to compare at a glance.
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function numberish(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * One tripwire → one bar. Pure.
 *
 * A tripwire with no `current` is NOT rendered as zero: zero is a reading, and
 * showing one where none was taken is the failure this whole surface exists to
 * prevent. It renders as an explicitly unread bar instead.
 */
export function tripwireBar(t: GoalDetailTripwire): TripwireBar {
  const unit = (t.unit ?? '').trim().toLowerCase();
  const label = t.label?.trim() || t.metric;
  const threshold = Number(t.threshold);
  const hasThreshold = Number.isFinite(threshold) && threshold > 0;
  const current = t.current == null ? null : Number(t.current);
  const hasCurrent = current != null && Number.isFinite(current);

  /*
   * PROVENANCE. A stamp counts only while it still vouches for the number that
   * is actually stored: `value` is compared, not merely present, so an agent who
   * hand-edits `current` on a previously-measured tripwire cannot leave the old
   * stamp behind to keep calling it a measurement. Mirrors `isDerived` in
   * goals/tripwire-refresh.ts — the writer of the stamp — deliberately, since
   * this module's whole point is being testable without a server import.
   */
  const stamp = t.measuredBy;
  const derived =
    hasCurrent &&
    !!stamp &&
    typeof stamp.source === 'string' &&
    Number.isFinite(stamp.value) &&
    stamp.value === current;
  const measuredAtMs = derived && Number.isFinite(stamp?.atMs) ? (stamp as { atMs: number }).atMs : null;

  const fmt = (n: number): string => (unit === 'usd' ? moneyish(n) : numberish(n));

  let valueText: string;
  if (!hasCurrent) {
    valueText = hasThreshold ? `not measured yet — limit ${fmt(threshold)}` : 'not measured yet';
  } else if (unit === 'days') {
    valueText = hasThreshold ? `day ${fmt(current)} of ${fmt(threshold)}` : `day ${fmt(current)}`;
  } else {
    const suffix = unit && unit !== 'usd' ? ` ${t.unit?.trim()}` : '';
    valueText = hasThreshold
      ? `${fmt(current)} of ${fmt(threshold)}${suffix}`
      : `${fmt(current)}${suffix}`;
  }

  // A tripwire with no usable threshold has no bar to fill — it still shows its
  // reading, because the number is the point even when the limit is missing.
  const pct =
    hasCurrent && hasThreshold
      ? Math.max(0, Math.min(100, Math.round((current / threshold) * 100)))
      : null;

  let tone: TripwireTone;
  if (!hasCurrent) tone = 'unread';
  else if (pct == null) tone = 'ok';
  else if (pct >= 100) tone = 'breached';
  else if (pct >= WARN_AT_PCT) tone = 'warn';
  else tone = 'ok';

  /*
   * PROVENANCE IS STRUCTURAL, NOT CONCATENATED. `derived` and the title sentence
   * carry it; `valueText` stays the reading phrase alone. Appending "· hand-set"
   * here would reach both render surfaces for free, but it would also be
   * unstylable (a marker deserves to be dimmed or badged, not bolded into the
   * number) and it would pad every bar in the compact PotHealthPane. The two
   * components render it instead — see TripwireRow / TripwireBar.
   */
  const title =
    tone === 'breached'
      ? `${label}: past its limit — this is a reason to stop the goal`
      : tone === 'unread'
        ? `${label}: no reading has been taken yet`
        : derived
          ? `${label}: ${valueText}`
          : `${label}: ${valueText} — entered by hand, not measured by the platform`;

  return {
    key: t.metric,
    label,
    valueText,
    pct,
    measured: hasCurrent,
    derived,
    measuredAtMs,
    tone,
    title,
  };
}

/** Every tripwire on the goal, in author order. Empty is the NORMAL case — a
 *  free-text kill criterion with no bars is fully supported, and renders as
 *  prose alone. */
export function tripwireBars(goal: GoalDetailGoalInput | null): TripwireBar[] {
  const raw = goal?.tripwires;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => t && typeof t.metric === 'string').map(tripwireBar);
}

/**
 * The one-line verdict above the bars.
 *
 * A goal with NO kill criterion is the case worth shouting about: nothing can
 * ever stop it, which is precisely the failure mode GOAL mode exists to bound.
 * It is stated outright rather than left as an empty section that reads as
 * merely uninformative.
 */
export function killCriterionLine(goal: GoalDetailGoalInput | null): {
  text: string;
  missing: boolean;
} {
  const text = goal?.killCriterion?.trim();
  if (text) return { text, missing: false };
  return {
    text: 'No kill criterion was set — nothing can stop this goal. Ask the agent to set one.',
    missing: true,
  };
}

/* ── Pots ────────────────────────────────────────────────────────────────── */

export interface GoalDetailPot extends GoalDetailPotInput {
  removed: boolean;
  /** `shared with 2 other goals`, or null when this goal is its only claimant. */
  sharedBadge: string | null;
  /** Clause 4 requires one per pot; its absence is shown, not hidden. */
  killCriterionText: string;
  killCriterionMissing: boolean;
}

function decorate(p: GoalDetailPotInput): GoalDetailPot {
  const removed = p.removedAt != null;
  const serves = p.servesGoals ?? 0;
  const crit = p.killCriterion?.trim();
  return {
    ...p,
    removed,
    // `servesGoals` counts THIS goal too, so the shared count is one less.
    sharedBadge: serves > 1 ? `shared with ${serves - 1} other goal${serves === 2 ? '' : 's'}` : null,
    killCriterionText: crit || 'No kill criterion for this pot',
    killCriterionMissing: !crit,
  };
}

/**
 * Active and removed pots, both kept.
 *
 * Removed pots STAY on the page, greyed. If kills vanished, the page would
 * only ever show growth — and "the agent actually closes things" (clause 4: an
 * agent that only ever creates is a ratchet) would become invisible at exactly
 * the moment it is working. The resolver deliberately does not filter them
 * either; this is the same decision held on both sides of the wire.
 */
export function partitionPots(pots: GoalDetailPotInput[] | null | undefined): {
  active: GoalDetailPot[];
  removed: GoalDetailPot[];
} {
  const all = (pots ?? []).map(decorate);
  return {
    active: all.filter((p) => !p.removed),
    removed: all.filter((p) => p.removed),
  };
}

/* ── Spend by day, stacked by pot ────────────────────────────────────────── */

export interface SpendStackSlice {
  harnessSlug: string;
  costUsd: number;
  /** Share of THIS day's column, 0-100 — the slice's height within the stack. */
  pct: number;
}

export interface SpendStackDay {
  day: string;
  totalUsd: number;
  /** Share of the tallest day, 0-100 — the column's own height. */
  heightPct: number;
  slices: SpendStackSlice[];
}

export interface SpendStack {
  days: SpendStackDay[];
  /** Every pot appearing anywhere in the window, for a stable legend/colour. */
  harnesses: string[];
  maxDayUsd: number;
  totalUsd: number;
}

/**
 * Bucket the flat (day, pot, cost) rows into stacked columns. Pure.
 *
 * The resolver already grouped by day+pot, so this is a reshape rather than
 * an aggregation — but it must still SUM on collision, because a caller that
 * passes ungrouped rows (a test, or a resolver that later stops grouping)
 * would otherwise silently keep only the last row of each pair.
 */
export function spendStack(rows: GoalDetailSpendDayInput[] | null | undefined): SpendStack {
  const byDay = new Map<string, Map<string, number>>();
  const harnesses: string[] = [];

  for (const r of rows ?? []) {
    const day = String(r.day ?? '').trim();
    if (!day) continue;
    const slug = (r.harnessSlug ?? '').trim() || 'unattributed';
    const cost = Number(r.costUsd ?? 0);
    if (!Number.isFinite(cost)) continue;
    if (!harnesses.includes(slug)) harnesses.push(slug);
    const bucket = byDay.get(day) ?? new Map<string, number>();
    bucket.set(slug, (bucket.get(slug) ?? 0) + cost);
    byDay.set(day, bucket);
  }

  const days = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, bucket]) => {
      const slices = [...bucket.entries()].map(([harnessSlug, costUsd]) => ({
        harnessSlug,
        costUsd,
        pct: 0,
      }));
      const totalUsd = slices.reduce((acc, s) => acc + s.costUsd, 0);
      for (const s of slices) s.pct = totalUsd > 0 ? (s.costUsd / totalUsd) * 100 : 0;
      slices.sort((a, b) => b.costUsd - a.costUsd || a.harnessSlug.localeCompare(b.harnessSlug));
      return { day, totalUsd, heightPct: 0, slices };
    });

  const maxDayUsd = days.reduce((m, d) => Math.max(m, d.totalUsd), 0);
  for (const d of days) d.heightPct = maxDayUsd > 0 ? (d.totalUsd / maxDayUsd) * 100 : 0;

  return {
    days,
    harnesses: [...harnesses].sort((a, b) => a.localeCompare(b)),
    maxDayUsd,
    totalUsd: days.reduce((acc, d) => acc + d.totalUsd, 0),
  };
}

/* ── Small shared formatting ─────────────────────────────────────────────── */

/** `4h ago` / `just now`, via the HUD's existing age formatter — deliberately
 *  not a fifth relative-time implementation in this app. */
export function agoText(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return `${formatAge(Math.max(0, Math.round((nowMs - t) / 1000)))} ago`;
}

/** The `$310 / $500` ceiling line for the header. Mirrors `goalSpendLabel` on
 *  the card so the detail view and the card it opened from cannot disagree. */
export function ceilingLine(goal: GoalDetailGoalInput | null): {
  text: string;
  pct: number | null;
  over: boolean;
} {
  // The same level the card's chip judges (goalCeilingSpendUsd) — never `?? 0`.
  const spend = goal ? goalCeilingSpendUsd(goal) : null;
  const ceiling = goal?.budgetCents == null ? null : goal.budgetCents / 100;
  if (ceiling == null || ceiling <= 0) {
    return { text: `${spend == null ? 'Spend unmeasured' : moneyish(spend)} — no ceiling set`, pct: null, over: false };
  }
  const per = budgetWindowSuffix(goal?.budgetWindowSec);
  if (spend == null) {
    return { text: `Unmeasured of ${moneyish(ceiling)}${per}`, pct: null, over: false };
  }
  return {
    text: `${moneyish(spend)} of ${moneyish(ceiling)}${per}`,
    pct: Math.max(0, Math.min(100, Math.round((spend / ceiling) * 100))),
    over: spend >= ceiling,
  };
}

/**
 * The rate line under the ceiling (P-003): what the goal is burning, and when
 * that runs into the ceiling.
 *
 * Separate from `ceilingLine` rather than folded into its `text`, because that
 * text renders in TWO places — a compact status chip in the header and the
 * ceiling block — and a full projected-date sentence does not belong in the
 * chip. Null when nothing measured the window, so the panel renders no line at
 * all rather than a zero rate it cannot support.
 */
export function burnLine(
  goal: GoalDetailGoalInput | null,
  nowMs: number,
): { text: string; detail: string; urgent: boolean } | null {
  if (!goal) return null;
  const burn = goalBurn(goal, nowMs);
  if (!burn) return null;
  const eta = burn.ceilingEtaMs;
  const urgent = eta != null && eta - nowMs <= 7 * 24 * 60 * 60 * 1000;
  return {
    text:
      eta == null
        ? burnRateShort(burn.perDayUsd)
        : `${burnRateShort(burn.perDayUsd)} · ceiling ~${burnEtaText(eta)}`,
    detail: burnTitle(burn, goal),
    urgent,
  };
}

/** Mirrors burnRateText's precision rule — see the note there on why a rate
 *  cannot use `moneyish`'s whole dollars. */
function burnRateShort(perDayUsd: number): string {
  const digits = perDayUsd >= 10 ? 0 : perDayUsd >= 1 ? 1 : 2;
  return `$${perDayUsd.toFixed(digits)}/day`;
}

/* ── The work rail (P-019) ─────────────────────────────────────────────────
   The goal popup's side panel: the goal's PLANS and its WORK ITEMS, mimicking
   the fleet-peers rail the owner pointed at ("the way we have the sidepanel for
   the fleet members, we can mimic that design").

   Derived here, not in the component, for the same reason `fleet-peers.ts` is a
   module beside `FleetPeersRail`: every rule about what appears and in what
   order is a decision worth pinning with a test, and a rail that computes its
   own grouping inline can only be checked by rendering it.

   ⚠ THE DEDUPE IS THE POINT, not a tidy-up. `waitingOnYou` and `activity` are
   two reads of the SAME work_items rows — the resolver filters the first to
   `needsHuman` and leaves the second unfiltered — so an item parked on the owner
   appears in BOTH. Rendering them as separate sections without subtracting
   would show that item twice, and a rail whose whole job is "what is under this
   goal" must not let the reader count one thing as two. */

/* ── Waiting-on-you count (P-006 / D-018) ─────────────────────────────────────

   The resolver fetches waiting rows `LIMIT 25` but counts the total unbounded,
   because the two answer different questions: the rows are what you RENDER, the
   total is what you can honestly CLAIM. Collapsing them — reporting the capped
   array's length as the headline — is the failure this type exists to prevent,
   and it is the direction that silently UNDER-reports the one queue only the
   owner can clear.

   Derived here rather than inline in the component for the same reason the work
   rail is: the rule for what number appears is a decision worth pinning with a
   test, and a component that computes it inline can only be checked by
   rendering it. */

export interface GoalWaitingCount {
  /** Rows actually present and rendered — never presented as a total. */
  shown: number;
  /** The true count, or null when the resolver did not measure it. */
  total: number | null;
  /** `shown` is a floor: rows were capped and some are not on screen. */
  truncated: boolean;
  /** No total was supplied — the reader is seeing rows, not a census. */
  unmeasured: boolean;
  /** The headline, e.g. `31 waiting on you`. Empty when nothing is parked. */
  label: string;
  /** Disclosure for the section heading when capped, else null. */
  note: string | null;
}

export function waitingCount(data: GoalDetailInput | null | undefined): GoalWaitingCount {
  const shown = (data?.waitingOnYou ?? []).length;
  const raw = data?.waitingOnYouTotal;
  // Number.isFinite rejects NaN from a malformed payload as firmly as it rejects
  // null — a nonsense total must degrade to `unmeasured`, never to a rendered NaN.
  const total = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  const unmeasured = total == null;
  // Only a total STRICTLY above what we hold proves a cap. Equal counts are the
  // ordinary case and must not be labelled truncated.
  const truncated = total != null && total > shown;
  // The headline prefers the total; with none, `shown` is all we can honestly
  // say, and the note marks it as un-censused rather than dressing it as a total.
  const headline = total ?? shown;
  return {
    shown,
    total,
    truncated,
    unmeasured,
    label: headline > 0 ? `${headline} waiting on you` : '',
    note: truncated
      ? `showing ${shown} of ${total}`
      : unmeasured && shown > 0
        ? 'count not measured'
        : null,
  };
}

export type GoalWorkTone = 'needs-you' | 'open' | 'closed';

export interface GoalWorkRailItem {
  id: string;
  title: string;
  harnessSlug: string | null;
  tone: GoalWorkTone;
  /** The row's meta line: state word + age. Composed here so the row component
   *  stays presentational. */
  metaText: string;
}

export interface GoalWorkRail {
  plans: GoalDetailPlanInput[];
  needsYou: GoalWorkRailItem[];
  open: GoalWorkRailItem[];
  closed: GoalWorkRailItem[];
  /** Nothing at all is under this goal — no plans, no items. The rail renders
   *  ONE sentence saying so instead of three empty headings, which read as a
   *  panel that failed to load rather than a goal nothing has touched yet.
   *  D-010: this is the LIVE state of every goal in this workspace today, so it
   *  is the state most likely to be seen — not an edge case. */
  empty: boolean;
}

function railMeta(state: string, iso: string | null | undefined, nowMs: number): string {
  const age = agoText(iso, nowMs);
  return age ? `${state} · ${age}` : state;
}

export function workRail(
  data: GoalDetailInput | null | undefined,
  nowMs: number,
): GoalWorkRail {
  const plans = (data?.plans ?? []).filter((p) => p != null && Boolean(p.planSlug));
  const waiting = data?.waitingOnYou ?? [];
  const activity = data?.activity ?? [];

  const needsYouIds = new Set(waiting.map((w) => w.id));
  const needsYou: GoalWorkRailItem[] = waiting.map((w) => ({
    id: w.id,
    title: w.title,
    harnessSlug: w.harnessSlug ?? null,
    tone: 'needs-you',
    metaText: railMeta('needs you', w.updatedAt, nowMs),
  }));

  const open: GoalWorkRailItem[] = [];
  const closed: GoalWorkRailItem[] = [];
  for (const a of activity) {
    // See the dedupe note above — never render a needs-you item a second time.
    if (needsYouIds.has(a.id)) continue;
    const isClosed = a.closedAt != null;
    (isClosed ? closed : open).push({
      id: a.id,
      title: a.title,
      harnessSlug: a.harnessSlug ?? null,
      tone: isClosed ? 'closed' : 'open',
      metaText: railMeta(
        isClosed ? 'closed' : (a.status ?? 'open'),
        isClosed ? a.closedAt : a.updatedAt,
        nowMs,
      ),
    });
  }

  return {
    plans,
    needsYou,
    open,
    closed,
    empty:
      plans.length === 0 && needsYou.length === 0 && open.length === 0 && closed.length === 0,
  };
}

/** What a plan row shows as its name. A plan whose row no longer resolves keeps
 *  its slug and is MARKED — see the resolver's `GoalPlanCard` docblock: live
 *  work items pointing at a deleted plan is a state worth seeing, not hiding. */
export function planLabel(
  /* Only the two fields it actually reads: a label helper has no business
     requiring a whole rail row, and widening it to one would make every caller
     supply fields the answer does not depend on. */
  plan: Pick<GoalDetailPlanInput, 'planSlug' | 'title'>,
): { text: string; missing: boolean } {
  const title = plan.title?.trim();
  if (title) return { text: title, missing: false };
  return { text: plan.planSlug, missing: true };
}
