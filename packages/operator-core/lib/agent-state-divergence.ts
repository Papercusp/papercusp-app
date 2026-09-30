/**
 * agent-state-divergence.ts — P-010's detector: where an agent's ACTIONS diverge
 * from what it DECLARED (unified-agent-state-plane-2026-07-27 P-010, per D-012,
 * D-016 and D-046). Targets MAST FM-2.6 (reasoning-action mismatch, 13.2%).
 *
 * PURE — no PG, no clock, no LLM. Unit-tested without a database.
 *
 * ⚠ Its sibling `agent-facts/conflicts.ts` (P-011), whose shape this deliberately
 * mirrored — same coverage-block discipline, same structural-zero discipline — was
 * RETIRED by WI-6545 / D-103 for having no producer: 3 of 2,217 facts ever carried
 * the typed `claim` it compared. The disciplines are still right and still apply
 * here; what killed that one is the thing to check for this one too. THIS detector
 * has a live corpus (it reads `tool_invocations`, which every agent writes without
 * opting in) — which is exactly the difference, and worth keeping in view.
 *
 * ── WHY THIS IS A DETECTOR AND NOT A READ TOOL (D-046) ──────────────────────
 *
 * P-010's item text says "bucket calls by `intent_event_id`". Read alone, that
 * describes a bucketing ENDPOINT — and D-046 explicitly refuses to build one:
 *
 *     "A bucketing endpoint over `tool_invocations` (`group by
 *      intent_event_id`) … it is the third read over a datum whose first two
 *      are dead. Rejected on evidence, not on caution."
 *
 * The evidence is brutal and specific: `activity:tool-log` (7 calls / 3 callers
 * / dead since 2026-07-16), `activity:recent` (6 / 2 / dead), `dev:session_detail`
 * (3 / 3 / dead). All three are pull reads over this exact table.
 *
 * The reconciliation is not a compromise, it is a real distinction. A pull read
 * requires an agent to CHOOSE to call it, and on this datum that choice has
 * demonstrably never been made — so a fourth one would be dead on arrival. A
 * DETECTOR requires no adoption: D-016 puts P-010 in the STRUCTURAL tier and
 * D-047 row 15 records its enforcement as "they run on their own". So this
 * module computes a verdict that is DELIVERED to the agent; it must never grow a
 * browse surface. The read path for this datum already exists and is P-024's
 * (`sessions:timeline`), which works precisely because it rides a tool people
 * already call.
 *
 * ── TYPED FIELDS ONLY — NO PROSE INFERENCE (the P-011 rule, and it binds here) ─
 *
 * P-011: *"v1 detects contradiction on TYPED fields only. Do not attempt prose
 * contradiction detection — that is an LLM call per pair and it will be wrong
 * often enough to poison the signal."* An intent declaration is FREE TEXT, so
 * "compare observed tool mix against what was declared" can NOT mean comparing
 * intent prose to tool names — that is the same poisoned signal wearing a
 * different hat. The typed things that actually exist on a stamped call are
 * `goal_ref` (TEXT, already resolved to `WI-6393` — P-009 typed it that way
 * deliberately), `intent_event_id`, `tool_name`, `status` and the args. Every
 * signal below is computed from those and nothing else.
 *
 * ── THE STAMPED LEGS ARE STRUCTURALLY EMPTY TODAY, AND THAT IS DISCLOSED ─────
 *
 * Measured 2026-07-27T15:16Z: **0 of 170,682** `tool_invocations` in 24h carried
 * `intent_event_id`, `goal_ref` OR `assumption_set_id`. P-009's stamp is written
 * but not yet DEPLOYED (`main` runs the release checkout). So a run of this
 * detector today compares nothing on the stamped legs and returns zero — which
 * is indistinguishable from "this fleet never diverges" unless the result says
 * so. It says so: {@link DivergenceCoverage.stampFillRate} ships with every
 * verdict and {@link isStructuralZero} separates "nothing was compared" from
 * "things were compared and agreed". Same defect class D-087 R4 closed for
 * P-011, and the same reason P-015 must measure FILL RATE rather than adoption.
 *
 * ── WHICH IS WHY THE SAMPLING LEGS EXIST ────────────────────────────────────
 *
 * P-010's text also asks for "the sampling trigger for unstamped signal — a
 * retry with changed args, or a tool/verb fallback after failure". Those need no
 * stamp at all: they are computed from `tool_name`, `status` and the args that
 * every one of those 170,682 rows already carries. That is what keeps this
 * detector genuinely live rather than dark while the stamp is undeployed — the
 * stamped leg lights up on its own the moment the deploy lands, with no code
 * change here.
 *
 * ⚠ But those two triggers are EVIDENCE, not findings. Taken literally — fire
 * whenever a retry changed its args — they produce ~532 findings/day across 23
 * agents, because retrying with CORRECTED arguments is what a healthy agent does
 * after `invalid-input`. Requiring the run not to converge
 * ({@link RETRY_THRASH_THRESHOLD}) cuts that to ~39/day across 11 agents while
 * keeping every genuine flail. The numbers behind both figures are on that
 * constant. This is the one place the item's literal wording had to yield to its
 * stated purpose (MAST FM-2.6), and it yielded on measurement, not taste.
 */
import { isDispatchWrapperMetadata } from './agent-tools/sessions/automatic-tool-names';

/** How an agent's actions diverged from its declaration. */
export const DIVERGENCE_KINDS = [
  /** STAMPED: one intent bucket, ≥2 distinct goal refs — declared once, worked
   *  several goals without re-declaring. */
  'goal-drift-within-intent',
  /**
   * UNSTAMPED SAMPLING: the same tool failed ≥{@link RETRY_THRASH_THRESHOLD}
   * times for one owner inside {@link THRASH_WINDOW_MS} — the agent is not
   * converging. P-010's named triggers (a retry with changed args, a tool/verb
   * fallback after failure) are the TRANSITIONS inside such a run and are
   * reported on the finding; see {@link RetryLoopEvidence} for why neither is a
   * finding on its own.
   */
  'unconverged-retry-loop',
] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

/** Why a run found no divergence. Only `'agreement'` is an informative zero. */
export const DIVERGENCE_ZERO_REASONS = [
  'no-calls',
  /** Nothing was stamped AND no failure was available to sample — both legs
   *  were structurally unable to run. */
  'nothing-comparable',
  /** The sampling legs ran and found nothing, but the stamped legs could not run
   *  at all (fill rate 0). A PARTIAL answer wearing a zero. */
  'stamped-legs-empty',
  /**
   * The stamped leg had comparable buckets, and EVERY one of them collapsed
   * because its goals are already terminal (P-010 / EI-18830083673617307). A
   * distinct reason from `stamped-legs-empty`, which blames a missing stamp — the
   * stamp was present here and the goals were simply finished. Reporting this as
   * `agreement` would be the worst option: nothing was compared.
   */
  'all-goals-terminal',
  'agreement',
] as const;
export type DivergenceZeroReason = (typeof DIVERGENCE_ZERO_REASONS)[number];

/**
 * True when the zero means "nothing was compared", not "no divergence exists".
 *
 * `stamped-legs-empty` counts as structural even though the sampling legs did
 * run: the caller asked about intent↔action divergence and the intent half was
 * never examined, so treating that as a clean bill of health is exactly the
 * misread this flag exists to prevent.
 */
export function isStructuralZero(reason: DivergenceZeroReason | null): boolean {
  return reason !== null && reason !== 'agreement';
}

/** Cap on returned findings — a payload bound, never a change to the counts. */
export const DIVERGENCE_LIMIT = 50;

/**
 * Failures of ONE tool by ONE owner inside {@link THRASH_WINDOW_MS} before the
 * run counts as unconverged.
 *
 * ⚠ THIS THRESHOLD IS MEASURED, NOT CHOSEN. Against 24h of live
 * `tool_invocations` (2026-07-27, workspace `papercusp-workspace`):
 *
 *   | same owner+tool failures in a 10-min window | groups | agents |
 *   |---|---|---|
 *   | exactly 1 (self-corrected)                  |    456 |      — |
 *   | exactly 2                                   |    106 |      — |
 *   | **≥3 (this threshold)**                     | **39** | **11** |
 *
 * Dropping to ≥1 — i.e. firing on every retry-with-changed-args, which is how
 * P-010's trigger reads at face value — yields ~532 findings/day across 23
 * agents (~23 per agent per day). That is not a detector, it is a mute button:
 * an agent that retries a call with CORRECTED arguments after `invalid-input`
 * is self-correcting, which is the behaviour we want, not a reasoning-action
 * mismatch. At ≥3 the rate is ~39/day across 11 agents (~3.5 per agent per
 * day) and every group is an agent genuinely failing to converge. Worst
 * observed run: 7.
 */
export const RETRY_THRASH_THRESHOLD = 3;

/** The window a thrash run must fit inside. */
export const THRASH_WINDOW_MS = 10 * 60_000;

/**
 * Statuses that count as a failed call.
 *
 * `role-not-allowed` is here because the live data has it (4 in 24h) and it is a
 * genuine refusal; it was missing from the first cut of this set, which is the
 * kind of gap only real rows expose.
 */
const FAILURE_STATUSES = new Set(['error', 'invalid-input', 'timeout', 'refused', 'denied', 'role-not-allowed']);

export function isFailureStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return FAILURE_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Statuses that count as a call having SUCCEEDED.
 *
 * Deliberately an explicit allow-list rather than `!isFailureStatus(...)`, and
 * the distinction is the whole point: "not a failure" is true of a NULL status
 * too, and treating an absent status as a success would let a gap in the input
 * silently suppress a real finding. That is the same rule `digestArgs` already
 * follows for absent args — a missing value is never evidence in either
 * direction. Measured vocabulary of `tool_invocations.status` over a live 3h
 * window: ok (27,777), invalid-input (90), timeout (15), error (7).
 */
const SUCCESS_STATUSES = new Set(['ok']);

export function isSuccessStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return SUCCESS_STATUSES.has(status.trim().toLowerCase());
}

/**
 * How long a run's LAST failure must have been allowed to sit before the run is
 * judged un-converged.
 *
 * Without this, the convergence test below is a race the detector loses at the
 * cadence it actually runs: the sweep ticks every ~30s, so a run whose fix lands
 * on the agent's very next turn is read as "still failing" simply because the
 * sweep looked between the last failure and the retry. Waiting is free here — the
 * debounce window is hours, so a genuine flail is reported a minute later rather
 * than not at all.
 *
 * Only applied when the caller supplies a clock (see `opts.now`).
 */
export const CONVERGENCE_SETTLE_MS = 2 * 60_000;

/** Existing fleet-registry evidence that a launch-shaped call committed work. */
export interface LaunchOutcomeEvidence {
  fleet: string;
  transactionId: string;
  state: string;
  openedMemberIds: readonly string[];
  verifiedMemberIds: readonly string[];
  failedOwnerIds: readonly string[];
}

/** One `tool_invocations` row, reduced to the fields a verdict can rest on. */
export interface DivergenceCall {
  id: number;
  /** `coord_owner_id` — divergence is only ever defined WITHIN one agent. */
  ownerId: string;
  toolName: string;
  status: string | null;
  /** ISO-8601. Used for ordering and the sampling window only. */
  invokedAt: string;
  intentEventId?: number | null;
  goalRef?: string | null;
  /** The plan slug carried by the intent declaration event. */
  declaredPlanSlug?: string | null;
  /** Typed P-NNN lane items carried by the intent declaration event. */
  declaredPlanItems?: readonly string[];
  /** Typed work-item refs explicitly covered by the declaration event. */
  declaredGoalRefs?: readonly string[];
  /** Raw args; digested internally. Absent is fine — the retry leg then cannot
   *  fire for that call, which is reported, not guessed at. */
  args?: unknown;
  /** Raw telemetry metadata. Explicit dispatch-wrapper rows are deliberate
   *  negative controls for retry sampling; the stamped goal leg still sees them. */
  metadataJson?: unknown;
  /** Hydrated only when telemetry matches the fleet's persisted launch transaction. */
  launchOutcome?: LaunchOutcomeEvidence;
}

/** A launch is committed when at least one member was opened or verified. */
export function hasCommittedLaunchOutcome(call: Pick<DivergenceCall, 'toolName' | 'launchOutcome'>): boolean {
  if (call.toolName !== 'fleet:launch-on-plan' || !call.launchOutcome) return false;
  return call.launchOutcome.openedMemberIds.length > 0 || call.launchOutcome.verifiedMemberIds.length > 0;
}

/** The namespace half of a `group:verb` tool name; '' when unnamespaced. */
export function toolNamespace(toolName: string): string {
  const i = toolName.indexOf(':');
  return i > 0 ? toolName.slice(0, i) : '';
}

/**
 * Stable digest of a call's args, for "did the args CHANGE" only. Key-sorted so
 * property order never manufactures a difference; unserializable input yields
 * null, meaning "cannot tell", never a throw inside a detector.
 */
export function digestArgs(args: unknown): string | null {
  if (args === undefined) return null;
  try {
    return stableJson(args);
  } catch {
    return null;
  }
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`).join(',')}}`;
}

/** One side of a finding — enough to read it without a second lookup. */
export interface DivergenceSide {
  callId: number;
  toolName: string;
  status: string | null;
  invokedAt: string;
  goalRef: string | null;
}

/**
 * What P-010's two named triggers actually looked like inside an unconverged
 * run. Reported rather than each being its own finding, because measurement
 * showed a LONE occurrence of either is healthy: 456 of 601 failure groups in
 * 24h were a single failure the agent then fixed. The triggers say what KIND of
 * flailing this was; the run length is what says it is flailing at all.
 */
export interface RetryLoopEvidence {
  /** Failures in the run. */
  attempts: number;
  /** Consecutive attempts whose args differed — P-010's "retry with changed
   *  args". High relative to `attempts` means the agent is varying inputs. */
  argsChangedTransitions: number;
  /** Attempts whose args were byte-identical to the previous one — retrying an
   *  unchanged call, which cannot succeed for a deterministic refusal. */
  identicalRetries: number;
  /** A different verb in the same namespace ran between attempts — P-010's
   *  "tool/verb fallback after failure". */
  fallbackObserved: boolean;
  /** Distinct failure statuses seen across the run. */
  statuses: string[];
}

export interface Divergence {
  kind: DivergenceKind;
  ownerId: string;
  /** The intent bucket this was found in; null for the unstamped legs. */
  intentEventId: number | null;
  /** One line naming what diverged, in typed terms. Never inferred prose. */
  detail: string;
  a: DivergenceSide;
  b: DivergenceSide;
  /** Present only on `unconverged-retry-loop`. */
  retryLoop?: RetryLoopEvidence;
}

export interface DivergenceCoverage {
  callsExamined: number;
  /** Calls carrying an `intent_event_id`. */
  stampedCalls: number;
  /** Calls carrying a `goal_ref`. */
  goalStampedCalls: number;
  /**
   * `stampedCalls / callsExamined`, 0..1, rounded to 4dp. THE number P-015
   * measures. A zero here means every stamped leg below was unable to run —
   * see the module header.
   */
  stampFillRate: number;
  /** Distinct non-null `intent_event_id` values seen. */
  intentBuckets: number;
  /**
   * Buckets holding ≥2 calls with a goal ref — the ones that COULD produce a
   * `goal-drift-within-intent` verdict, whether or not they did. This is the
   * false-positive-rate denominator, the analog of P-011's `comparedPairs`.
   */
  comparableBuckets: number;
  /** Failed calls — the false-positive denominator for the sampling leg. */
  failuresSeen: number;
  /**
   * Runs that reached {@link RETRY_THRASH_THRESHOLD}.
   *
   * NOT the same as the number of findings: a run counted here is still
   * suppressed if it converged or has not settled. `thrashRuns -
   * convergedRuns - unsettledRuns` is what was actually reported, and keeping
   * the three separate is what makes the suppression measurable instead of
   * invisible.
   */
  thrashRuns: number;
  /**
   * Runs the agent RECOVERED from — a later `ok` on the same (owner, tool)
   * ended the run. Self-correction, which this detector exists not to page on;
   * counted so the rate stays visible without anyone being notified.
   */
  convergedRuns: number;
  /**
   * Runs whose last failure was newer than {@link CONVERGENCE_SETTLE_MS} at
   * sweep time — the agent may be mid-correction, so the verdict is deferred to
   * a later sweep rather than guessed at now. Always 0 when no clock was passed.
   */
  unsettledRuns: number;
  /** Did the stamped leg have anything at all to compare? */
  stampedLegRan: boolean;
  /** Did the sampling leg have anything at all to examine? */
  samplingLegRan: boolean;
  /**
   * Were terminal goals filtered out at all? FALSE means the caller supplied no
   * terminal set, so the goal legs ran UNFILTERED and may cite closed work
   * (P-010). Recorded rather than inferred: "0 excluded" is ambiguous between
   * "the filter ran and everything was live" and "no filter ran", and those are
   * opposite states — the first is clean, the second is the bug.
   */
  terminalFilterApplied: boolean;
  /** Goal-stamped calls dropped because their goal is already terminal. */
  terminalGoalCallsExcluded: number;
  /**
   * Buckets that COULD have been compared before the terminal filter and could
   * not after. This is the suppression rate — the number that says how much of
   * the detector's old output was unactionable noise about finished work.
  */
  bucketsCollapsedByTerminal: number;
  /** Fleet launch calls whose telemetry matched a persisted launch transaction. */
  launchOutcomeCalls: number;
  /** Failure-shaped fleet launch calls reconciled as committed success boundaries. */
  launchFailuresReconciled: number;
}

export interface DivergenceReport {
  divergences: Divergence[];
  /** True when {@link DIVERGENCE_LIMIT} cut the list; counts stay complete. */
  truncated: boolean;
  coverage: DivergenceCoverage;
  /** Null when divergence was found. Otherwise WHY the answer is zero. */
  structuralZero: DivergenceZeroReason | null;
}

function sideOf(c: DivergenceCall): DivergenceSide {
  return {
    callId: c.id,
    toolName: c.toolName,
    status: c.status,
    invokedAt: c.invokedAt,
    goalRef: c.goalRef ?? null,
  };
}

/**
 * `goal_ref` is the process-wide resolved goal at dispatch time. When an owner
 * holds two work-items, that resolver can select the dependency even while an
 * explicit `work_items:checkpoint` payload targets the primary item. Prefer
 * that one-item action target for this tool only; it is typed evidence of what
 * the call acted on, not prose inference. Ambiguous batches stay on the
 * retrospective stamp so this correction cannot silently pick a goal.
 */
function explicitCheckpointGoalRef(c: DivergenceCall): string | null {
  if (c.toolName !== 'work_items:checkpoint' || !c.goalRef || typeof c.args !== 'object' || c.args === null) {
    return null;
  }

  const args = c.args as Record<string, unknown>;
  const refs: string[] = [];
  if (typeof args.id === 'string' && args.id.trim()) refs.push(args.id.trim());
  if (Array.isArray(args.items)) {
    for (const item of args.items) {
      if (typeof item !== 'object' || item === null) continue;
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) refs.push(id.trim());
    }
  }

  const unique = [...new Set(refs)];
  return unique.length === 1 ? unique[0]! : null;
}

function normalizeIntentGoal(c: DivergenceCall): DivergenceCall {
  const explicit = explicitCheckpointGoalRef(c);
  return explicit && explicit !== c.goalRef ? { ...c, goalRef: explicit } : c;
}

/**
 * Fleet membership is a mission CONTAINER, not an item-level goal.
 *
 * `agent-goal-ref.ts` deliberately filters the same `fleet:<slug>` ref out of
 * `ResolvedGoal.competing`: every ordinary fleet member has both a mission and
 * the work it was sent to do. The retrospective stamp can still carry the
 * mission when no more-specific claim is known, so the divergence leg must
 * apply that same granularity rule before comparing goals. Otherwise a normal
 * fleet transition from `fleet:<slug>` to `WI-/EI-…` looks like an undeclarable
 * multi-goal drift: `declared_goal_refs` intentionally accepts work-item refs
 * only, so no valid re-declaration could clear the finding.
 */
function isFleetMissionRef(ref: string): boolean {
  return ref.startsWith('fleet:');
}

function timeOf(c: DivergenceCall): number {
  const t = Date.parse(c.invokedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Deterministic order: by owner, then time, then id. Sorting defensively rather
 * than trusting the caller's ORDER BY means the same rows always yield the same
 * verdict — a property the tests assert directly.
 */
function ordered(calls: readonly DivergenceCall[]): DivergenceCall[] {
  return [...calls].sort((a, b) => {
    if (a.ownerId !== b.ownerId) return a.ownerId < b.ownerId ? -1 : 1;
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
}

/**
 * A shared declared plan lane is an independent, typed explanation for seeing
 * several work-item goals under one intent. Require every declaration copy to
 * carry the same non-empty plan slug and at least one identical P-NNN item;
 * absent, mismatched, or partial lane metadata must remain a positive drift.
 */
function hasSharedDeclaredPlanLane(bucket: readonly DivergenceCall[]): boolean {
  const planSlugs = bucket.map((c) =>
    typeof c.declaredPlanSlug === 'string' ? c.declaredPlanSlug.trim() : '',
  );
  if (planSlugs.length === 0 || planSlugs.some((slug) => slug.length === 0)) return false;
  const planSlug = planSlugs[0];
  if (planSlugs.some((slug) => slug !== planSlug)) return false;

  const itemLists = bucket.map((c) =>
    Array.isArray(c.declaredPlanItems)
      ? [...new Set(c.declaredPlanItems.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))]
      : [],
  );
  if (itemLists.some((items) => items.length === 0)) return false;
  return itemLists[0]!.some((item) => itemLists.every((items) => items.includes(item)));
}

/**
 * Find where actions diverged from declarations. Deterministic and total: same
 * input, same output, no I/O.
 *
 * Callers pass a BOUNDED window of one or more agents' calls. This module does
 * not decide the window — a detector that silently applied its own time bound
 * would disagree with the read that fed it and neither would be wrong on its own
 * terms (the same rule `conflicts.ts` follows for liveness).
 *
 * ── WHAT IS DELIBERATELY NOT A DIVERGENCE ───────────────────────────────────
 *
 * • **Several intent ids under ONE goal ref.** This is the NORMAL shape, not
 *   drift: an agent re-declares intent on every wake via `coord:orient` while
 *   holding the same claim throughout — `agent-state-stamp.ts` says so in as
 *   many words. Flagging it would fire on every long-running agent, every wake,
 *   which is precisely how a detector earns being ignored.
 * • **A goal ref going null.** `noteGoalClaimed(owner, null)` on release is a
 *   deliberate clear, so calls after a release legitimately carry no goal. Only
 *   two DISTINCT NON-NULL goals in one bucket are evidence of anything.
 * • **A ONE-OFF failure the agent then fixed.** Measured: 456 of 601 same-owner
 *   same-tool failure groups in 24h were a SINGLE failure. An agent that reads
 *   `invalid-input` and retries with corrected arguments is self-correcting —
 *   the behaviour we want. Firing there would produce ~23 notifications per
 *   agent per day and the detector would simply be muted, which is exactly how
 *   the pull reads over this table died (D-046).
 * • **A failure followed by an unrelated tool.** The fallback evidence requires
 *   the same NAMESPACE; without that, every failure followed by any next call
 *   is a "fallback" and the signal is noise.
 * • **Two failures.** Still inside normal correction (106 groups in 24h).
 *   {@link RETRY_THRASH_THRESHOLD} is where the population stops looking like
 *   self-correction and starts looking like flailing.
 */
export function detectIntentActionDivergence(
  calls: readonly DivergenceCall[],
  opts: {
    /**
     * The sweep's clock, used ONLY for {@link CONVERGENCE_SETTLE_MS}. Omitted ⇒
     * the settle rule does not apply at all, rather than defaulting to
     * `Date.now()` — a detector documented as "same input, same output, no I/O"
     * must not read a hidden clock, and the tests assert exactly that.
     */
    now?: number;
    /**
     * Goal refs that are already TERMINAL — excluded from the stamped leg
     * (P-010, EI-18830083673617307).
     *
     * ⚠ WHY THE CALLER SUPPLIES THIS RATHER THAN THE DETECTOR RESOLVING IT.
     * A work-item's state is I/O, and this function is documented as "same input,
     * same output, no I/O". Passing the resolved set in keeps that true and keeps
     * the detector unit-testable against any goal population.
     *
     * ⚠ OMITTING IT IS NOT THE SAME AS PASSING AN EMPTY SET, and the difference is
     * recorded in `coverage.terminalFilterApplied`. Omitted = the filter did not
     * run and findings may cite finished work (the pre-P-010 behaviour). Empty =
     * the filter ran and every goal was live. A detector that could not tell those
     * apart would report the bug as a clean result.
     */
    terminalGoalRefs?: ReadonlySet<string>;
  } = {},
): DivergenceReport {
  const rows = ordered(calls);
  const divergences: Divergence[] = [];
  let truncated = false;

  const push = (d: Divergence): void => {
    if (divergences.length >= DIVERGENCE_LIMIT) {
      truncated = true;
      return;
    }
    divergences.push(d);
  };

  // ── Stamped leg: goal drift inside one intent bucket ──────────────────────
  // Keyed by owner AND intent id: an intent id is globally unique, but keying on
  // both makes the invariant explicit rather than incidental.
  const buckets = new Map<string, DivergenceCall[]>();
  let stampedCalls = 0;
  let goalStampedCalls = 0;
  for (const c of rows) {
    if (c.intentEventId != null) {
      stampedCalls += 1;
      const key = `${c.ownerId}\x00${c.intentEventId}`;
      const b = buckets.get(key);
      if (b) b.push(c);
      else buckets.set(key, [c]);
    }
    if (c.goalRef != null && c.goalRef !== '') goalStampedCalls += 1;
  }

  const terminalGoals = opts.terminalGoalRefs;
  const terminalFilterApplied = terminalGoals !== undefined;
  let terminalGoalCallsExcluded = 0;
  let bucketsCollapsedByTerminal = 0;

  let comparableBuckets = 0;
  for (const bucket of buckets.values()) {
    const allWithGoal = bucket
      .map(normalizeIntentGoal)
      .filter(
        (c) =>
          c.goalRef != null &&
          c.goalRef !== '' &&
          !isFleetMissionRef(c.goalRef),
      );

    // Drop calls whose goal is already finished. A drift BETWEEN two closed goals
    // is unactionable by construction: there is no re-declaration the recipient
    // could make that would reconcile an intent with work that is already done,
    // so paging about it spends attention and buys nothing.
    const withGoal = terminalGoals
      ? allWithGoal.filter((c) => !terminalGoals.has(c.goalRef as string))
      : allWithGoal;
    terminalGoalCallsExcluded += allWithGoal.length - withGoal.length;

    // Counted BEFORE the `< 2` bail so the suppression is visible rather than
    // silent: a bucket that WAS comparable and is not any more is the whole
    // measurable effect of this filter.
    if (allWithGoal.length >= 2 && withGoal.length < 2) bucketsCollapsedByTerminal += 1;

    if (withGoal.length < 2) continue;
    // Counted BEFORE the distinctness test, and the distinction is load-bearing:
    // this is the "could be compared" denominator, not the "did diverge"
    // numerator. A healthy agent that holds ONE goal across a whole intent has a
    // comparable bucket that simply agrees — if that incremented nothing, its
    // clean result would be reported as a structural zero (nothing examined)
    // rather than as the real agreement it is.
    comparableBuckets += 1;
    const distinct = new Map<string, DivergenceCall>();
    for (const c of withGoal) {
      const g = c.goalRef as string;
      if (!distinct.has(g)) distinct.set(g, c);
    }
    if (distinct.size < 2) continue;
    // A declaration may intentionally cover several simultaneously-held work-items.
    // Suppress only when EVERY observed live goal is present in EVERY declaration
    // copy carried by the bucket; absent or partial metadata remains positive drift.
    const observedGoals = [...distinct.keys()];
    const fullyDeclared = bucket
      .map((c) => c.declaredGoalRefs)
      .every(
        (refs) => Array.isArray(refs) && observedGoals.every((goal) => refs.includes(goal)),
      );
    if (fullyDeclared || hasSharedDeclaredPlanLane(bucket)) continue;
    // Report against the FIRST goal seen — the one the intent was declared
    // under. Pairing every goal against every other would multiply one drift
    // into n² findings that all describe the same event.
    const [first, ...rest] = [...distinct.values()];
    for (const other of rest) {
      push({
        kind: 'goal-drift-within-intent',
        ownerId: first.ownerId,
        intentEventId: first.intentEventId ?? null,
        detail: `one intent declaration spans goals ${first.goalRef} and ${other.goalRef} — the goal changed without a new intent being declared`,
        a: sideOf(first),
        b: sideOf(other),
      });
    }
  }

  // ── Sampling legs: retry-with-changed-args, and same-namespace fallback ────
  // These need no stamp, which is why they have live input today.
  const byOwner = new Map<string, DivergenceCall[]>();
  for (const c of rows) {
    const b = byOwner.get(c.ownerId);
    if (b) b.push(c);
    else byOwner.set(c.ownerId, [c]);
  }

  let failuresSeen = 0;
  let thrashRuns = 0;
  let convergedRuns = 0;
  let unsettledRuns = 0;
  let launchOutcomeCalls = 0;
  let launchFailuresReconciled = 0;
  for (const owned of byOwner.values()) {
    // A dispatch wrapper is an outer telemetry row for a deliberate schema
    // probe. Its invalid-input status is expected negative-control evidence,
    // not an agent retry. Keep it in `rows` above so stamped goal evidence
    // remains intact; exclude it only from this sampling leg.
    const samplingOwned = owned.filter((c) => !isDispatchWrapperMetadata(c.metadataJson));
    // Calls of ONE tool, in time order — SUCCESSES INCLUDED. Grouping by tool
    // before running the window is what makes "the same call keeps failing"
    // distinguishable from "this agent had a bad minute across five different
    // tools"; keeping the successes in the timeline is what makes "without
    // converging" an observable claim rather than an unfalsifiable one.
    //
    // ⚠ This previously filtered to failures FIRST, which discarded the only
    // rows that could ever disprove the verdict — so the detector asserted a
    // negative it structurally could not see, and paged agents for runs that had
    // already succeeded on the very next call (EI-18824142520274965).
    const callsByTool = new Map<string, DivergenceCall[]>();
    for (const c of samplingOwned) {
      const isFailure = isFailureStatus(c.status);
      const committedLaunch = hasCommittedLaunchOutcome(c);
      if (c.launchOutcome) launchOutcomeCalls += 1;
      if (isFailure) failuresSeen += 1;
      if (isFailure && committedLaunch) launchFailuresReconciled += 1;
      // A status that is neither a known failure nor a known success is NEUTRAL:
      // it neither extends a run nor ends one. Letting an unknown status close a
      // run would manufacture convergence out of a gap in the input.
      if (!isFailure && !isSuccessStatus(c.status)) continue;
      // A failure-shaped launch that opened a member is a committed action, not
      // an unsuccessful retry. Normalize it to an explicit success boundary so
      // later genuine failures start a fresh episode.
      const timelineCall = committedLaunch ? { ...c, status: 'ok' } : c;
      const b = callsByTool.get(c.toolName);
      if (b) b.push(timelineCall);
      else callsByTool.set(c.toolName, [timelineCall]);
    }

    for (const [toolName, timeline] of callsByTool) {
      const ns = toolNamespace(toolName);

      // Cut the timeline into failure groups separated by successes. A success
      // is proof the agent got this tool working, so failures on either side of
      // it are separate episodes — not one long flail. This also fixes the
      // fail,fail,ok,fail,fail shape, which used to merge into a single
      // "4× without converging" run despite having converged twice.
      const groups: { failures: DivergenceCall[]; converged: boolean }[] = [];
      let pending: DivergenceCall[] = [];
      for (const c of timeline) {
        if (isSuccessStatus(c.status)) {
          if (pending.length > 0) groups.push({ failures: pending, converged: true });
          pending = [];
        } else {
          pending.push(c);
        }
      }
      // The trailing group has no success after it — the only shape that can
      // honestly be called un-converged.
      if (pending.length > 0) groups.push({ failures: pending, converged: false });

      for (const group of groups) {
        const failures = group.failures;
        let start = 0;
        while (start < failures.length) {
          // Extend the run while each further failure stays inside the window
          // measured from the run's FIRST attempt.
          const runStartAt = timeOf(failures[start]);
          let end = start + 1;
          while (end < failures.length && timeOf(failures[end]) - runStartAt <= THRASH_WINDOW_MS) {
            end += 1;
          }
          const run = failures.slice(start, end);
          if (run.length >= RETRY_THRASH_THRESHOLD) {
            thrashRuns += 1;

            // ── The two reasons a threshold run is still NOT a finding ──────────
            //
            // Both are suppressions of a claim the detector cannot support, not
            // politeness. Counted in coverage so the rate stays measurable.
            if (group.converged) {
              // The agent recovered on this tool. Reporting "without converging"
              // here is simply false, and it is worse than noise: agents are told
              // to treat that phrase as "suspect the tooling and stop", so firing
              // it on successful self-correction teaches them to distrust the
              // signal — and can push one to abandon a strategy one call from
              // working.
              convergedRuns += 1;
              start = end;
              continue;
            }
            if (opts.now != null && opts.now - timeOf(run[run.length - 1]) < CONVERGENCE_SETTLE_MS) {
              // Too soon to tell: the retry that fixes this may not have happened
              // yet. Defer to a later sweep rather than guess.
              unsettledRuns += 1;
              start = end;
              continue;
            }

            let argsChangedTransitions = 0;
            let identicalRetries = 0;
            for (let k = 1; k < run.length; k += 1) {
              const prevDigest = digestArgs(run[k - 1].args);
              const curDigest = digestArgs(run[k].args);
              // Both digests must EXIST. A null means "args were not supplied to
              // the detector", and calling that a change would invent signal from
              // a gap in the input — the failure mode this module is guarding.
              if (prevDigest == null || curDigest == null) continue;
              if (prevDigest === curDigest) identicalRetries += 1;
              else argsChangedTransitions += 1;
            }

            // A same-namespace fallback anywhere between the run's first and last
            // attempt — P-010's second named trigger.
            const lastAt = timeOf(run[run.length - 1]);
            const fallbackObserved =
              ns !== '' &&
              samplingOwned.some(
                (c) =>
                  c.toolName !== toolName &&
                  toolNamespace(c.toolName) === ns &&
                  timeOf(c) >= runStartAt &&
                  timeOf(c) <= lastAt,
              );

            const statuses = [
              ...new Set(run.map((c) => (c.status ?? '').trim().toLowerCase()).filter((s) => s !== '')),
            ].sort();

            push({
              kind: 'unconverged-retry-loop',
              ownerId: run[0].ownerId,
              intentEventId: run[0].intentEventId ?? null,
              detail:
                `${toolName} failed ${run.length}× within ` +
                `${Math.round(THRASH_WINDOW_MS / 60_000)}min (${statuses.join(', ')}) without converging` +
                (fallbackObserved ? `, with a fallback to another '${ns}' verb in between` : '') +
                (identicalRetries > 0
                  ? `; ${identicalRetries} retr${identicalRetries === 1 ? 'y' : 'ies'} re-sent IDENTICAL args`
                  : ''),
              a: sideOf(run[0]),
              b: sideOf(run[run.length - 1]),
              retryLoop: {
                attempts: run.length,
                argsChangedTransitions,
                identicalRetries,
                fallbackObserved,
                statuses,
              },
            });
          }
          start = end;
        }
      }
    }
  }

  const callsExamined = rows.length;
  const coverage: DivergenceCoverage = {
    callsExamined,
    stampedCalls,
    goalStampedCalls,
    stampFillRate: callsExamined === 0 ? 0 : round4(stampedCalls / callsExamined),
    intentBuckets: buckets.size,
    comparableBuckets,
    failuresSeen,
    thrashRuns,
    convergedRuns,
    unsettledRuns,
    stampedLegRan: comparableBuckets > 0,
    // The leg RAN if it had failures to examine — not if it found something.
    // Same distinction as `comparableBuckets`: an agent whose every failure
    // self-corrected was genuinely examined and genuinely came back clean.
    samplingLegRan: failuresSeen > 0,
    terminalFilterApplied,
    terminalGoalCallsExcluded,
    bucketsCollapsedByTerminal,
    launchOutcomeCalls,
    launchFailuresReconciled,
  };

  return {
    divergences,
    truncated,
    coverage,
    structuralZero: divergences.length > 0 ? null : zeroReasonFor(coverage),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function zeroReasonFor(c: DivergenceCoverage): DivergenceZeroReason {
  if (c.callsExamined === 0) return 'no-calls';
  // ⚠ ORDERED FIRST among the did-not-run reasons — the MOST SPECIFIC true
  // explanation wins, because each of the other two asserts something false here.
  // `nothing-comparable` says "NONE carried an intent stamp and NONE failed" and
  // `stamped-legs-empty` blames a zero fill rate; when a bucket collapsed on
  // terminality the stamps and goal refs were both PRESENT. Either would send the
  // reader to fix P-009's stamp instead of looking at goal state. (Caught by
  // `agent-state-divergence.test.ts` — the original ordering put this last and a
  // clean all-`ok` fixture fell through to `nothing-comparable`.)
  if (!c.stampedLegRan && c.bucketsCollapsedByTerminal > 0) return 'all-goals-terminal';
  if (!c.stampedLegRan && !c.samplingLegRan) return 'nothing-comparable';
  if (!c.stampedLegRan) return 'stamped-legs-empty';
  return 'agreement';
}

/** One line naming what a zero actually means, for a delivered finding. */
export function explainZero(reason: DivergenceZeroReason): string {
  switch (reason) {
    case 'no-calls':
      return 'STRUCTURAL ZERO — no tool calls were handed in, so nothing was examined.';
    case 'nothing-comparable':
      return 'STRUCTURAL ZERO — calls exist but NONE carried an intent stamp and NONE failed, so neither the stamped legs nor the sampling legs could run. This is not "no divergence": nothing was compared.';
    case 'stamped-legs-empty':
      return "PARTIAL — the sampling legs ran and found nothing, but stampFillRate is 0 so the intent/goal legs never ran. Until P-009's stamp is DEPLOYED every call carries NULL, and a zero here says nothing about intent↔action divergence.";
    case 'all-goals-terminal':
      return 'STRUCTURAL ZERO — intent buckets carried goal stamps, but every comparable bucket collapsed because its goals are already CLOSED. Nothing was compared. Not a missing stamp (the stamps were there) and not agreement (no live pair was examined).';
    case 'agreement':
      return 'A REAL ZERO — intent buckets were compared and the goals held within them agree.';
  }
}

/**
 * The delivery precondition. P-011 refuses to notify until its false-positive
 * rate is computable, on the grounds that wiring a detector into orient/coord
 * before the number exists is "the exact ordering the item forbids". The same
 * rule binds here, but PER LEG rather than for the whole detector: the sampling
 * legs have live input today (170,682 unstamped calls in 24h) while the stamped
 * legs have none, so a single global gate would either suppress a leg that works
 * or notify from a leg that cannot.
 *
 * Returns the kinds whose findings are safe to deliver given what actually ran.
 */
export function deliverableKinds(coverage: DivergenceCoverage): DivergenceKind[] {
  const out: DivergenceKind[] = [];
  if (coverage.stampedLegRan) out.push('goal-drift-within-intent');
  if (coverage.samplingLegRan) out.push('unconverged-retry-loop');
  return out;
}
