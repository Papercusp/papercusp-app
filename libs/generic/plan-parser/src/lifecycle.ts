/**
 * lifecycle — DERIVE "where is this plan actually up to?" from the item graph,
 * instead of reading the hand-asserted `status` label.
 *
 * # Why this is derived and not stored
 *
 * `status` (draft / ready / active / shipped / superseded) is written ONCE, by
 * hand, and nothing recomputes it when the plan's items go terminal. It is the
 * same defect class P-002 removed from the `## Now` next-pointer, one level up:
 * a second copy of a fact the item graph already owns, believed precisely
 * because it is authoritative-looking and was correct when it was typed.
 *
 * The consequence is named in this repo's own agent guide: *"ALL ITEMS TERMINAL
 * IS NOT A FINISHED PLAN, AND `plans:items` CANNOT TELL YOU IT ISN'T"* — and
 * the mirror-image error is just as common, a plan sitting in `active` with
 * every item done, read as live work by every reader who trusts the label.
 *
 * Computing the verdict at READ time is rung 1 of the derived-truth ladder: it
 * cannot drift, it has no failure window, and it removes the second copy rather
 * than policing it on a schedule.
 *
 * # What this module is, and is not
 *
 * It answers TWO questions from evidence, and refuses to answer a third.
 *
 *   · **Implementation** — is there live work left? That is pure graph, and it
 *     is answered unconditionally.
 *   · **Momentum** — has anything moved lately? That needs a clock and an
 *     activity timestamp, both INJECTED, so this stays pure.
 *   · **Acceptance** — has the plan actually been VALIDATED? Deliberately NOT
 *     answered. That verdict belongs to the acceptance gate, which runs five
 *     check families across several tables and is expensive by design; a cheap
 *     second opinion here would be a competing definition of "may this ship",
 *     which is exactly the drift this plan exists to remove. All this module
 *     accepts is the cheap, indexed fact of whether the acceptance path has
 *     BEGUN — and it reports `awaiting-acceptance`, never `accepted`.
 *
 * Every signal is optional, and an ABSENT signal is reported as `unmeasured`
 * rather than defaulted. "Not measured" and "measured false" are different
 * facts: defaulting the first to the second would let a plan whose freshness
 * could not be read present as freshly active.
 *
 * Pure + dependency-free (generic-first): items and signals in, verdict out.
 * No I/O, no `Date.now()` — the caller injects its own clock, so the same
 * inputs always produce the same verdict and a test needs no fake timers.
 */

import { PLAN_STATUSES, type ItemStatus, type PlanItem, type PlanStatus } from './parser';
import { resolveEffectiveStatusForItems, type ResolvedItem } from './effective-status';

/**
 * Where the plan actually is, per the evidence.
 *
 * Five values, not a boolean, for the same reason `NextPointerReason` has six:
 * "nothing is left to do because the plan finished" and "nothing is left to do
 * because the plan never had items" are opposite situations, and collapsing
 * them is how an empty plan comes to read as complete.
 */
export type PlanLifecycleVerdict =
  /** The plan has no items; the graph has nothing to say. Callers MUST treat
   *  this as "no verdict" and never as "finished". */
  | 'no-items'
  /** Live items remain, and something moved within the staleness window. */
  | 'active'
  /** Live items remain, but nothing has moved for `stalledAfterDays`. The work
   *  is not finished and nobody is doing it. */
  | 'stalled'
  /** Every item is terminal and the acceptance path has NOT begun (or could
   *  not be measured — read `unmeasured`). Implementation landed; validation
   *  has not started. */
  | 'implementation-complete'
  /** Every item is terminal and an acceptance rubric is active — the remaining
   *  work is grading. Deliberately NOT a claim that it will pass. */
  | 'awaiting-acceptance';

/**
 * The cheap half of the acceptance-gate state: has the acceptance path BEGUN?
 *
 * Nothing here reports whether the plan may ship — see the module header.
 */
export interface PlanAcceptanceSignal {
  /** An acceptance rubric is active/ready for this plan as its subject. */
  rubricActive: boolean;
  /** Which rubric, when one was found. */
  rubricRef?: string | null;
  /**
   * The acceptance rubric this plan WAS validated against, when none is active.
   *
   * An acceptance rubric retires WITH its shipped plan (one-shot, by design), so
   * on a shipped plan `rubricActive:false` means the validation path was walked
   * and CLOSED — not never begun. A reader that cannot tell those apart sends
   * agents to author a duplicate rubric for a finished plan
   * (EI-22078741539479611). Omit when the retired rubric was not looked up.
   */
  retiredRubricRef?: string | null;
}

/**
 * Activity timestamps, and the clock to measure them against.
 *
 * `lastActivityAt` is the NEWEST instant across whatever sources the caller
 * could actually measure, and `sources` records each one by name — so a reader
 * can see that "12 days idle" rests on a plan write and a work-item transition
 * rather than on one column that might mean something else.
 */
export interface PlanFreshnessSignal {
  /** ISO-8601. `null` ⇒ nothing measurable; the momentum axis abstains. */
  lastActivityAt: string | null;
  /** Per-source attribution, newest-first is not required. */
  sources?: Array<{ source: string; at: string | null }>;
  /** The caller's clock, ISO-8601. Injected so this module stays pure. */
  now: string;
}

export interface PlanLifecycleSignals {
  /** Omit or pass `null` when the acceptance path was not looked up. */
  acceptance?: PlanAcceptanceSignal | null;
  /** Omit or pass `null` when no activity timestamp could be read. */
  freshness?: PlanFreshnessSignal | null;
  /**
   * Idle days past which a plan with live items reads `stalled`.
   *
   * Defaults to {@link DEFAULT_STALLED_AFTER_DAYS}, which is P-003's own
   * number ("a 30-day-cold plan cannot read as live"), not a tuned one.
   */
  stalledAfterDays?: number;
}

/** What the verdict could not see. Never silently omitted — see module header. */
export type PlanLifecycleUnmeasured = 'acceptance' | 'freshness';

export interface DerivedPlanLifecycle {
  verdict: PlanLifecycleVerdict;
  /** One line, ready to render where a bare `status` would have gone. */
  text: string;
  /** Terminal-item census — what makes each verdict a positive answer. */
  counts: {
    total: number;
    done: number;
    dropped: number;
    nonTerminal: number;
    wip: number;
    blocked: number;
    needsHuman: number;
  };
  /** Live items, ranked head-first, bounded — who the remaining work is. */
  liveItems: Array<{ id: string; effectiveStatus: ItemStatus }>;
  liveItemsTruncated: boolean;
  /** Whole days since the newest measured activity; `null` when unmeasured. */
  idleDays: number | null;
  /** The threshold actually applied, so a verdict carries its own yardstick. */
  stalledAfterDays: number;
  /** Signals the caller did not (or could not) supply. */
  unmeasured: PlanLifecycleUnmeasured[];
  acceptance: PlanAcceptanceSignal | null;
  freshness: PlanFreshnessSignal | null;
}

/** P-003's own number: a plan cold for a month must not read as live. */
export const DEFAULT_STALLED_AFTER_DAYS = 30;

/** How many live items travel with the verdict. */
const LIVE_ITEM_CAP = 5;

const MS_PER_DAY = 86_400_000;

function isTerminal(status: ItemStatus): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * Same needs-human band as the next-pointer: read BOTH the derived boolean and
 * the effective token, because `deriveItemNeedsHuman` is behavior-neutral until
 * the autonomy policy is armed, and until then the stored token is the only
 * signal there is.
 */
function awaitsHuman(item: ResolvedItem): boolean {
  return item.needsHuman || item.effectiveStatus === 'needs-human';
}

/**
 * Same two-signal rule as `awaitsHuman`, and for a sharper reason: the resolver
 * GUARANTEES the two signals diverge.
 *
 * An item blocked by a dependency edge carries `unresolvedBlockers`. An item
 * blocked for a deliberate external reason — re-blocked by a plan Decision,
 * say — carries `effectiveStatus: 'blocked'` with `unresolvedBlockers: []`,
 * because `resolveEffectiveStatusForItems` keeps the stored token sticky and
 * never invents edges for it. `effective-status.ts` documents that case as
 * legitimate and expected, and names the harm of reading it by edges alone:
 * "a caller reads that as 'the lane is drained'".
 *
 * Counting only the edge-derived half made this module that caller. It reported
 * `blocked: 0` for a plan holding three Decision-blocked items, so the summary
 * line "N wip, 0 blocked, M needs-human" told a reader nothing stood in the
 * way while the ship gate — which refuses on blocked items — disagreed.
 */
function isBlocked(item: ResolvedItem): boolean {
  return item.effectiveStatus === 'blocked' || item.unresolvedBlockers.length > 0;
}

/**
 * Whole days between two instants, or `null` if either is unparseable.
 *
 * An unparseable timestamp returns `null` rather than `0`: zero reads as "just
 * touched", which would make a broken clock the strongest possible evidence of
 * freshness.
 */
function idleDaysBetween(lastActivityAt: string | null, now: string): number | null {
  if (!lastActivityAt) return null;
  const then = Date.parse(lastActivityAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return null;
  // A future timestamp (clock skew, a scheduled-at column) is clamped to 0
  // rather than going negative — "moved recently" is the honest reading.
  return Math.max(0, Math.floor((nowMs - then) / MS_PER_DAY));
}

/**
 * Derive a plan's lifecycle verdict.
 *
 * Precedence is deliberate: the IMPLEMENTATION axis is decided first and from
 * the graph alone, then momentum refines it. A plan whose items are all
 * terminal is never `stalled` however cold it is — "finished and untouched" is
 * not the same condition as "unfinished and abandoned", and reporting the first
 * as the second would send a reader to restart work that is already done.
 */
export function derivePlanLifecycle(
  items: readonly PlanItem[],
  signals: PlanLifecycleSignals = {},
): DerivedPlanLifecycle {
  const stalledAfterDays = signals.stalledAfterDays ?? DEFAULT_STALLED_AFTER_DAYS;
  const acceptance = signals.acceptance ?? null;
  const freshness = signals.freshness ?? null;
  const idleDays = freshness ? idleDaysBetween(freshness.lastActivityAt, freshness.now) : null;

  const unmeasured: PlanLifecycleUnmeasured[] = [];
  if (!acceptance) unmeasured.push('acceptance');
  // A supplied freshness signal that yields no usable age is still unmeasured:
  // the caller looked and found nothing, which for a reader is the same gap.
  if (idleDays === null) unmeasured.push('freshness');

  const counts = {
    total: items.length,
    done: 0,
    dropped: 0,
    nonTerminal: 0,
    wip: 0,
    blocked: 0,
    needsHuman: 0,
  };

  const base = {
    counts,
    liveItems: [] as Array<{ id: string; effectiveStatus: ItemStatus }>,
    liveItemsTruncated: false,
    idleDays,
    stalledAfterDays,
    unmeasured,
    acceptance,
    freshness,
  };

  if (items.length === 0) {
    return {
      ...base,
      verdict: 'no-items',
      text:
        'no verdict — this plan has no items, so its lifecycle cannot be derived from the graph. ' +
        'An itemless plan is not a finished one.',
    };
  }

  const resolved = resolveEffectiveStatusForItems([...items]);
  const live: ResolvedItem[] = [];
  for (const item of resolved.items) {
    if (item.effectiveStatus === 'done') counts.done += 1;
    else if (item.effectiveStatus === 'dropped') counts.dropped += 1;
    else {
      counts.nonTerminal += 1;
      if (item.effectiveStatus === 'wip') counts.wip += 1;
      if (awaitsHuman(item)) counts.needsHuman += 1;
      else if (isBlocked(item)) counts.blocked += 1;
      live.push(item);
    }
  }

  base.liveItems = live
    .slice(0, LIVE_ITEM_CAP)
    .map((it) => ({ id: it.id, effectiveStatus: it.effectiveStatus }));
  base.liveItemsTruncated = live.length > LIVE_ITEM_CAP;

  if (live.length === 0) {
    const terminalCensus = `${counts.done} done, ${counts.dropped} dropped`;
    if (acceptance?.rubricActive) {
      return {
        ...base,
        verdict: 'awaiting-acceptance',
        text:
          `every item is terminal (${terminalCensus}) and an acceptance rubric is active` +
          `${acceptance.rubricRef ? ` (${acceptance.rubricRef})` : ''} — the remaining work is ` +
          'independent grading, not implementation. This is not a claim that it will pass.',
      };
    }
    // A retired acceptance rubric is the trace of a validation that CLOSED (it
    // retires with the ship), which is the opposite of "has not begun". The verdict
    // stays implementation-complete — the graph still cannot prove the grade
    // passed — but the text must not send a reader to start a path already walked.
    if (acceptance && !acceptance.rubricActive && acceptance.retiredRubricRef) {
      return {
        ...base,
        verdict: 'implementation-complete',
        text:
          `every item is terminal (${terminalCensus}); no acceptance rubric is active because ` +
          `'${acceptance.retiredRubricRef}' was RETIRED — an acceptance rubric retires with its ` +
          'shipped plan, so read this as validation completed and closed, never as validation ' +
          'not begun. Nothing here is pending; do not author a replacement rubric.',
      };
    }
    return {
      ...base,
      verdict: 'implementation-complete',
      text:
        `every item is terminal (${terminalCensus}), and ` +
        (acceptance
          ? 'no acceptance rubric is active — the validation path has not begun. '
          : 'the acceptance path was not measured on this read. ') +
        'Implementation landing is not the same as a finished plan.',
    };
  }

  const remaining =
    `${counts.nonTerminal} of ${counts.total} items are still live ` +
    `(${counts.wip} wip, ${counts.blocked} blocked, ${counts.needsHuman} needs-human)`;

  if (idleDays !== null && idleDays >= stalledAfterDays) {
    return {
      ...base,
      verdict: 'stalled',
      text:
        `${remaining}, and nothing has moved for ${idleDays} days ` +
        `(threshold ${stalledAfterDays}). The work is unfinished and nobody is doing it.`,
    };
  }

  return {
    ...base,
    verdict: 'active',
    text:
      `${remaining}` +
      (idleDays === null
        ? ', and no activity timestamp was measurable on this read.'
        : `, last activity ${idleDays} days ago.`),
  };
}

/**
 * What the derivation has to say about the plan's STORED status.
 *
 * Four values rather than a boolean, for P-002's reason: "the graph agrees",
 * "the graph has nothing to say", and "this label is not one we know" are three
 * different reasons a stored status survives a read, and flattening them would
 * let an unchecked pass-through read as a ratified one.
 */
export type PlanLifecycleDisposition =
  /** The graph is silent (no items); the stored label stands unexamined. */
  | 'abstained'
  /** The stored label is consistent with what the graph shows. */
  | 'agreed'
  /** The stored label claims something the graph refutes. */
  | 'contradicted'
  /** The stored label is not in the known status vocabulary. */
  | 'unrecognized';

export interface PlanLifecycleReconciliation {
  storedStatus: string | null;
  disposition: PlanLifecycleDisposition;
  /** Set only on `contradicted`: the claim, and the evidence against it. */
  contradiction: { claim: string; evidence: string } | null;
  /**
   * One line, ready to render — the STATUS-AWARE counterpart of
   * `derived.text`. Identical to it except over a TERMINAL stored status
   * (`shipped` / `superseded`), where the graph-only sentence is wrong: the
   * acceptance rubric RETIRES on ship, so `rubricActive:false` on a shipped
   * plan means "completed and retired", and rendering the graph's "the
   * validation path has not begun" there told readers a finished plan was
   * unvalidated (measured on a plan shipped with two independent graders).
   * `derived.text` is left untouched on purpose — it is the graph's own
   * verdict and must stay pure; this is the line a UI should print.
   */
  text: string;
  /** The graph's own verdict, attached on EVERY disposition — a reader can
   *  always see what was checked rather than trusting that it was. */
  derived: DerivedPlanLifecycle;
}

/**
 * Reconcile a plan's stored `status` against the derived lifecycle.
 *
 * # Jurisdiction (narrow on purpose — the sibling of D-003)
 *
 * The graph contradicts the label in exactly THREE cases, all of which are
 * statements about ITEMS, which is the only thing the graph can see:
 *
 *   1. **A live status over a drained graph** — `draft`/`ready`/`active` while
 *      every item is terminal. This is the headline drift class, and the one a
 *      reader most often mistakes for live work.
 *   2. **`shipped` over a live graph** — the ship gate refuses a plan with a
 *      `todo`/`blocked`/`needs-human` item, so a shipped plan with live items
 *      means the graph moved after the ship (or the gate was forced past).
 *   3. **`awaiting-acceptance` over a live graph** — the mirror of (2) one
 *      state earlier: that status asserts implementation is complete, so a
 *      live item refutes it. P-004's reverse transition repairs this
 *      automatically when the flip goes through `plans:set-status`; the case
 *      is reported anyway, because any other edit path can still produce it.
 *
 * Everything else is left alone. In particular `superseded` is NEVER
 * contradicted: a superseded plan is deliberately abandoned mid-flight, so live
 * items are its normal, correct shape — flagging them would manufacture drift
 * out of the one status whose whole meaning is "we stopped".
 *
 * STALENESS IS NOT A CONTRADICTION and is deliberately not folded in here. A
 * cold `active` plan is a real problem, but it is a different axis with a
 * different remedy, and overloading one field with two independent judgments is
 * how a reader loses the ability to act on either. It rides on
 * `derived.verdict` / `derived.idleDays` instead, where it can be read on its
 * own terms.
 *
 * Pure. Never mutates, never writes, and — like every derivation in this
 * module — reports rather than repairs.
 */
/**
 * A status change the graph WARRANTS, as opposed to one it merely reports.
 *
 * `reason` is written to be read by whoever finds the transition in a log or a
 * plan history months later, so it states the evidence, not the rule name.
 */
export interface PlanStatusTransition {
  from: PlanStatus;
  to: Extract<PlanStatus, 'awaiting-acceptance' | 'ready'>;
  reason: string;
}

/**
 * Decide whether the item graph warrants MOVING a plan's stored status (P-004).
 *
 * # Why this is narrower than {@link reconcilePlanLifecycle}
 *
 * Reconciliation REPORTS on any divergence; this function only proposes a write,
 * so it must clear a much higher bar: the target has to be recoverable from the
 * graph alone, or the write destroys information no derivation can put back.
 * Exactly one bit qualifies — *is any item non-terminal* — which is why the
 * transition is total and invertible in both directions, and why the eligible
 * statuses are exactly the two that differ by that bit and nothing else.
 *
 * # What it deliberately never does
 *
 *   · **Never touches `draft`.** `draft` vs `ready` encodes an authorial
 *     decision (has this plan been greenlit?) that the graph cannot see, so a
 *     rule moving a drained draft to `awaiting-acceptance` would silently
 *     greenlight a plan nobody approved — and could not undo it, because
 *     un-draining restores `ready`, not the `draft` it took.
 *   · **Never writes `shipped` or `superseded`, and never moves off them.**
 *     Shipping requires a code-truth audit, a vetted rubric and independent
 *     grading; deriving it from item statuses would forge exactly the evidence
 *     the ship gate exists to demand. Moving OFF a terminal status would
 *     resurrect a closed plan.
 *   · **Never writes `active`.** It is the legacy synonym for `ready`, accepted
 *     as a SOURCE (existing rows still carry it) and never as a target.
 *   · **Abstains on an itemless plan.** `no-items` is not `drained`; reading it
 *     as one would declare every itemless plan implementation-complete.
 *
 * Returns `null` when no write is warranted — which is the overwhelmingly
 * common case, including every re-flip that does not cross the boundary.
 */
export function derivePlanStatusTransition(
  storedStatus: string | null | undefined,
  derived: DerivedPlanLifecycle,
): PlanStatusTransition | null {
  // An itemless plan's graph is silent (D-004 point 4). Guarding on the verdict
  // rather than on `counts.total` keeps the two in lockstep: whatever
  // derivePlanLifecycle treats as "no verdict" is what abstains here.
  if (derived.verdict === 'no-items') return null;

  const stored = (storedStatus ?? '').trim() || null;
  const drained = derived.counts.nonTerminal === 0;
  const census = `${derived.counts.done} done, ${derived.counts.dropped} dropped`;

  if (drained && (stored === 'ready' || stored === 'active')) {
    return {
      from: stored,
      to: 'awaiting-acceptance',
      reason:
        `every one of ${derived.counts.total} items is terminal (${census}), so there is no ` +
        'implementation left to pick up. This records that the plan is waiting on the ' +
        'acceptance gate — it is NOT a claim that the plan passed one.',
    };
  }

  if (!drained && stored === 'awaiting-acceptance') {
    return {
      from: stored,
      to: 'ready',
      reason:
        `${derived.counts.nonTerminal} of ${derived.counts.total} items are live again ` +
        `(${derived.liveItems.map((it) => it.id).join(', ')}` +
        `${derived.liveItemsTruncated ? ', …' : ''}), so the plan is waiting on the work, ` +
        'not on a grader.',
    };
  }

  return null;
}

export function reconcilePlanLifecycle(
  storedStatus: string | null | undefined,
  derived: DerivedPlanLifecycle,
): PlanLifecycleReconciliation {
  const stored = (storedStatus ?? '').trim() || null;
  const base = { storedStatus: stored, derived, contradiction: null, text: derived.text };

  if (derived.verdict === 'no-items') return { ...base, disposition: 'abstained' };

  // Derived from the vocabulary rather than re-listed: a status added to
  // PLAN_STATUSES and forgotten here would report `unrecognized` on every plan
  // holding it, which reads as "this label is not one we know" — a much more
  // alarming statement than the truth ("nobody updated this list").
  const known = stored !== null && (PLAN_STATUSES as readonly string[]).includes(stored);
  if (!known) return { ...base, disposition: 'unrecognized' };

  const drained = derived.counts.nonTerminal === 0;

  if (stored === 'shipped' && !drained) {
    return {
      ...base,
      disposition: 'contradicted',
      contradiction: {
        claim: 'status: shipped — the plan is finished and validated',
        evidence:
          `${derived.counts.nonTerminal} of ${derived.counts.total} items are still live ` +
          `(${derived.liveItems.map((it) => `${it.id} [${it.effectiveStatus}]`).join(', ')}` +
          `${derived.liveItemsTruncated ? ', …' : ''}). The ship gate refuses live items, so ` +
          'either the graph moved after the ship or the gate was forced past.',
      },
    };
  }

  // The mirror of the `shipped` case, and the one P-004's reverse transition
  // repairs: `awaiting-acceptance` asserts that implementation is COMPLETE and
  // only grading remains, so a live item refutes it directly. Reported rather
  // than assumed impossible — the rule that maintains this status fires off a
  // `plans:set-status` call, and a plan whose items were edited by any other
  // path (a raw `.md` edit, a restore) can reach this state unrepaired.
  if (stored === 'awaiting-acceptance' && !drained) {
    return {
      ...base,
      disposition: 'contradicted',
      contradiction: {
        claim: 'status: awaiting-acceptance — implementation is done and only grading remains',
        evidence:
          `${derived.counts.nonTerminal} of ${derived.counts.total} items are still live ` +
          `(${derived.liveItems.map((it) => `${it.id} [${it.effectiveStatus}]`).join(', ')}` +
          `${derived.liveItemsTruncated ? ', …' : ''}). Implementation is NOT complete, so ` +
          'this plan is not waiting on a grader — it is waiting on the work.',
      },
    };
  }

  // Terminal stored statuses that the graph AGREES with get a status-aware
  // line. The graph-only sentence for a drained plan ("no acceptance rubric is
  // active — the validation path has not begun") is correct while the plan is
  // live and false once it has shipped: the acceptance rubric retires ON ship,
  // so its absence is the expected end state, not a gap. `derived` is left
  // exactly as the graph produced it — only the render line changes.
  if (stored === 'shipped' && drained) {
    return {
      ...base,
      disposition: 'agreed',
      text:
        `every item is terminal (${derived.counts.done} done, ${derived.counts.dropped} dropped) ` +
        'and the plan is shipped — a terminal status the ship gate writes after independent ' +
        'acceptance grading and the author\'s verdict. The acceptance rubric retires on ship, so ' +
        'an inactive rubric here means completed-and-retired, not never-begun. Nothing is left to do.',
    };
  }

  if (stored === 'superseded') {
    return {
      ...base,
      disposition: 'agreed',
      text:
        `superseded — the plan was deliberately abandoned (${derived.counts.done} done, ` +
        `${derived.counts.dropped} dropped, ${derived.counts.nonTerminal} still live` +
        (drained ? '' : ', which is the normal shape of a plan that stopped mid-flight') +
        '). No acceptance path is expected; a successor plan carries whatever survived.',
    };
  }

  if ((stored === 'draft' || stored === 'ready' || stored === 'active') && drained) {
    return {
      ...base,
      disposition: 'contradicted',
      contradiction: {
        claim: `status: ${stored} — there is live work here`,
        evidence:
          `every one of ${derived.counts.total} items is terminal ` +
          `(${derived.counts.done} done, ${derived.counts.dropped} dropped). ` +
          'Implementation landed; the status was never updated. Note this is NOT a claim ' +
          'that the plan is finished — shipping needs a code-truth audit and independent ' +
          'acceptance grading that no item status can evidence.',
      },
    };
  }

  return { ...base, disposition: 'agreed' };
}
