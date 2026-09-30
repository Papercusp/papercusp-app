/**
 * plan-item coverage — rolls a plan item's "is anyone working this?" up from the
 * work-items LINKED to it AND any direct plan-item claim, so the plans:* readers
 * surface coverage instead of leaving a `todo` item looking unworked when a linked
 * work-item is in flight (or already done).
 *
 * THE GAP THIS CLOSES. A plan item and a work-item are two parallel claim systems
 * bridged only by a coord_links edge (rel in fixes|relates|duplicates, dst_kind=
 * plan_item — written by work_items:link / the forward edge on work_items:create).
 * Nothing rolled the work-item's claim/liveness back onto the plan item, so
 * `plans:items actionable=true` happily returned items that a linked WI was already
 * fixing → double-starts. This module fuses BOTH signals into one coverage level.
 *
 * THREE SIGNALS, ONE READ each (mirrors issue-blocks-merge.ts's hoisted-batch shape):
 *   1. coord_links work→plan_item edges + the linked work-item's TERMINAL state
 *      (issue: resolved|closed ; feature: passed|deprecated) — ONE query.
 *   2. the canonical fleet_assignment view (listFleetAssignments) — ONE read — for
 *      BOTH the linked work-items' LIVE activity (progressing|alive|stalled|dead)
 *      AND any direct plan_item_claim on the item itself.
 *   3. (EI-13721) the `payload.plan_item` STAMP on harness_shared.work_items — ONE
 *      query — a backstop for a work-item bound to a plan item WITHOUT a coord_links
 *      edge (a hand-built payload, a legacy/ad-hoc creation path, or an edge pruned
 *      out-of-band). Deduped against signal 1 so an edge-backed work-item is never
 *      double-counted; a stamp-only link is tagged with the synthetic rel
 *      STAMP_ONLY_REL so a caller can tell the two apart.
 * All three are globally-keyed by the plan_item ref ('<slug>#<item>', globally
 * unique), so the multi-plan readers hoist getAllPlanItemCoverage() out of their
 * plan loop.
 *
 * STALENESS. Like the issue-block overlay, this rides plans:items' 45s SWR cache —
 * the live-claim leg can lag a claim/release by up to that window. Acceptable for
 * the "don't double-start" use: the terminal/edge leg (the load-bearing part) is
 * exact, and a 45s-stale "someone's on it" only ever errs toward not double-starting.
 *
 * "Actively worked" ≡ activity progressing|alive (claimed by a LIVE holder). A
 * stalled/dead claim is deliberately NOT counted as covered — the former keeps
 * the no-progress signal visible without treating a live holder as gone. The
 * stalled case has its own `held-stalled` band; only a confirmed dead/unknown
 * holder reads `held-not-live`, so a reader is never invited to reclaim a live
 * holder's work from a missing checkpoint alone.
 *
 * COVERAGE IS LIVENESS-AWARE; THE WORK-ITEM LEDGER'S `assignee` IS NOT. That is
 * the one thing to know before comparing the two surfaces (P-005,
 * trap-guards-followups-2026-08-01). `harness_shared.work_items.assignee` is a
 * column that persists after its holder dies; the level below is recomputed from
 * live activity every read. So `plans:items` reporting nobody on an item that the
 * ledger says is assigned is CORRECT AND EXPECTED — not a lag, not a missing link,
 * not a stale cache. The `held-not-live` band exists to say so out loud, because
 * the previous collapse of that case into `unclaimed`/`none` ("nobody on it" /
 * "genuinely unworked") actively invited the wrong conclusion — including from an
 * agent that then went looking for a nonexistent bug in the stamp/link path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { listFleetAssignments, deriveActivity, type FleetAssignmentRow } from './fleet/assignments';
import { resolveSessionStates } from './agent-tools/coordination/liveness-oracle';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';
import { planItemRef, PLAN_ITEM_KIND } from './issue-blocks-merge';
import { ISSUE_FAMILY_KINDS } from './work-items';
import { ISSUE_TERMINAL_STATUSES } from './work-item-blocking';
import { TERMINAL_STATUSES as FEATURE_TERMINAL_STATUSES } from './dbos/frontier-readiness';
import { isTerminalItemStatus } from './fleet-drained-events';
import type { ItemActivity } from './item-activity';
import { projectClaimHolder, type ClaimHolder } from './plan-items/claim-holder';

/** The link rels that count a work-item as ADDRESSING a plan item. `blocks` is NOT
 *  here — that's the issue-block overlay (todo→blocked), a different relationship. */
export const COVERAGE_RELS = ['fixes', 'relates', 'duplicates'] as const;

/**
 * Terminal (work-done) states per family — sourced from the SAME canonical sets
 * work-items.ts / work-item-blocking.ts use (issue: resolved|closed, PLUS the
 * unified done|dropped terminals the issue-family alias layer now actually
 * persists; feature: passed|deprecated, PLUS done|dropped).
 *
 * EI-18129037155166784: this used to be a LOCALLY-DUPLICATED literal
 * `['resolved','closed']` / `['passed','deprecated']` that predated
 * work-item-status-full-unify (2026-07-19) — after that migration the issue
 * family's alias layer persists 'resolved'/'closed' requests as unified
 * 'done'/'dropped' (work-items.ts ISSUE_STATE_ALIASES), so a work-item that
 * HAD closed (state:'done') read as NON-terminal here. That silently
 * mis-classified its linked plan item's coverage as 'partial'/'unclaimed'
 * instead of 'complete' — an already-closed work-item's own plan item looking
 * perpetually unworked, inviting a duplicate re-claim of work that was already
 * done. Importing the single source of truth instead of a local copy is what
 * complete.ts's TERMINAL_WORK_ITEM_STATES already did for the same class of bug
 * (see its EI-5269/EI-18127483322976472 comment) — this module was the one
 * remaining stale copy.
 */
const ISSUE_TERMINAL = ISSUE_TERMINAL_STATUSES;
const FEATURE_TERMINAL = FEATURE_TERMINAL_STATUSES;

/** An activity that means a LIVE holder currently has the item (counts as covered). */
function isLiveActivity(a: ItemActivity): boolean {
  return a === 'progressing' || a === 'alive';
}

/**
 * A claim EXISTS on the item but its holder is not live — `dead` (holder confirmed
 * gone) or `reserved` (holder liveness unknown). `stalled` gets its own band:
 * the fleet view says the holder is alive but has not emitted item progress, and
 * that is an ask/coordinate signal, not a reclaim signal.
 *
 * This is the distinction P-005 (trap-guards-followups-2026-08-01) exists to make
 * visible. Coverage collapsed all of these into `unclaimed`/`none`, which are
 * documented as "nobody on it" / "genuinely unworked" — but the work-item ledger
 * still shows an `assignee`, because an assignee persists past its holder's death.
 * A reader comparing the two surfaces sees `working:'unclaimed'` next to a named
 * assignee and concludes one of them is LYING or LAGGING. Neither is: coverage is
 * liveness-aware and the ledger column is not. Splitting the level out states that
 * directly, so the reclaimable case is legible instead of inferred.
 */
function isHeldButNotLive(a: ItemActivity | null | undefined): boolean {
  return a != null && a !== 'free' && a !== 'stalled' && !isLiveActivity(a);
}

/** A holder is alive but its item-scoped progress signal is stale/missing. */
function isHeldStalled(a: ItemActivity | null | undefined): boolean {
  return a === 'stalled';
}

/**
 * EI-18679411140143743: is a plan item's own status STALE against its linked
 * work-item(s)? True when coverage says every linked work-item is done
 * (`level === 'complete'`) but the plan item's own status is still non-terminal
 * — the exact silent divergence the ticket reports (burn-down undercounts,
 * a leader re-chases work that already shipped).
 *
 * This is a DETECTOR, not an auto-heal: forward propagation already happens at
 * completion time (work_items:complete's synchronizeFinishWork, for a
 * `payload.plan_item`-stamped item) and the reverse direction has its own
 * periodic sweep (reconcileOrphanedPlanItemWorkItems) — but neither catches a
 * plan item left behind after a linked work-item finishes via a path that
 * skips/loses the propagation (a `relates`-only coverage edge with no stamp,
 * a transient finish-leg failure, a race). Auto-flipping here would risk
 * fighting a DELIBERATE reopen (a leader re-opening a falsely-closed plan item
 * while its stale work-item claim hasn't caught up yet) — surfacing the
 * divergence is the safe, always-correct action; a human/leader decides
 * whether to re-propagate or investigate.
 *
 * Pure — no I/O, unit-tested without PG. `effectiveStatus` is the item's own
 * DERIVED status (not the coverage of a *different* item), so a plan item
 * effectively `blocked` by an unrelated dependency while its own linked work
 * is done still counts as diverged — that is precisely the case a leader
 * burn-down needs surfaced.
 */
export function isCoverageDivergent(effectiveStatus: string, level: CoverageLevel): boolean {
  return level === 'complete' && !isTerminalItemStatus(effectiveStatus);
}

/** The synthetic `rel` stamped on a coverage link discovered ONLY via the
 *  `payload.plan_item` stamp query (no coord_links edge backs it) — see the
 *  "1b. STAMP-based coverage" block in getAllPlanItemCoverage. Distinguishes it
 *  from a real coord_links rel ('fixes' | 'relates' | 'duplicates' | 'implements')
 *  in the compacted `links[]` a caller reads. */
export const STAMP_ONLY_REL = 'plan_item_stamp';

/**
 * Every coverage band, as a VALUE — so a consumer that must handle all of them
 * (fleet:assignments' sort order) can be pinned against this list by a test
 * instead of by a hand-copied literal that silently rots when a band is added.
 */
export const COVERAGE_LEVELS = [
  'none', // no link and no claim of any kind → genuinely unworked, nobody ever took it
  'unclaimed', // links exist, all open, and NO link/claim has a holder at all (filed, never taken)
  'held-not-live', // a holder is dead/unknown (link or direct claim) → RECLAIMABLE
  'held-stalled', // a holder is alive but has no item progress → ASK/coordinate; never auto-reclaim
  'partial', // some linked work is live-held (or a direct claim) but not all open links are
  'full', // every non-terminal linked work-item is live-held (or a bare direct claim)
  'complete', // ≥1 link and EVERY linked work-item is terminal (the work is done)
] as const;

export type CoverageLevel = (typeof COVERAGE_LEVELS)[number];

/**
 * The bands where a LIVE holder is on the item RIGHT NOW — exactly the bands
 * `classifyCoverage` reaches once its `anyLive` test passes. Nothing else.
 *
 * EI-22174704695369849: `plans:items { actionable: true }` advertises "pickable
 * right now" off `effectiveStatus === 'todo'` alone, so it offered an item that
 * the SAME result object reported as `working: 'partial'` — held and actively
 * edited by a live peer. The refuting data was already computed and already
 * returned beside the claim; this predicate is what lets the filter consult it.
 *
 * The narrowness is the design, not an oversight. Every band left OUT is one a
 * caller may legitimately pick, and hiding it would trade this bug for the
 * strictly worse inverse (EI-20043747805764486: `actionable` returning `[]`
 * while items were pickable, which reads as a drained plan and stands a fleet
 * member down). The cost asymmetry is lopsided — a false POSITIVE here costs one
 * claim round-trip and is caught by `coord:declare-intent`'s `claims.conflicts`,
 * while a false NEGATIVE silently hides work from everyone — so this errs
 * toward offering:
 *   • `none` / `unclaimed` — nobody is on it.
 *   • `held-not-live`      — documented as the reclaimable band (holder dead or
 *                            liveness unknown); the claim outlived its holder.
 *   • `held-stalled`       — a live holder with no item progress. Deliberately
 *                            still offered: `isReclaimable()` in item-activity.ts
 *                            counts `'stalled'` as auto-freeable, so the reaper
 *                            re-surfaces these; withholding them would suppress
 *                            work the system is itself in the middle of freeing.
 *                            ⚠ The word "reclaimable" has OPPOSITE polarity on the
 *                            two surfaces and the two are consistent, not in
 *                            conflict: item-activity's `isReclaimable` licenses the
 *                            REAPER to free the claim, while this module's "never
 *                            auto-reclaim" tells a READER not to jump ahead of it.
 *                            Offering the item is the reader-side move that stays
 *                            correct either way.
 *   • `complete`           — linked work is done, but auto-hiding it is the
 *                            auto-heal `isCoverageDivergent` deliberately refuses
 *                            to perform, and a deliberately REOPENED item must
 *                            stay pickable. It is already flagged `diverged`.
 *
 * Pure and exhaustively pinned by test against COVERAGE_LEVELS, so a newly added
 * band must be classified explicitly rather than defaulting into "pickable".
 */
export const LIVE_HELD_COVERAGE_LEVELS: readonly CoverageLevel[] = ['partial', 'full'];

/**
 * Is a live holder on this item right now, making it NOT pickable by self-select?
 * See {@link LIVE_HELD_COVERAGE_LEVELS} for why the other bands stay offerable.
 */
export function isLiveHeldCoverage(level: CoverageLevel | null | undefined): boolean {
  return level != null && LIVE_HELD_COVERAGE_LEVELS.includes(level);
}

export interface CoverageWorkLink {
  /** WI-/EI-/F- id of the linked work-item. */
  workItemId: string;
  rel: string;
  /** The linked work-item is in a terminal (done) state. */
  terminal: boolean;
  /** The linked work-item is blocked or durably parked out of self-select. */
  blocked?: true;
  /** Activity from the fleet view ('free' when no claim row exists). */
  activity: ItemActivity;
  /** Holder ownerId when live-held (progressing|alive), else null. */
  holder: string | null;
}

export interface PlanItemCoverage {
  /** '<slug>#<item>'. */
  ref: string;
  links: CoverageWorkLink[];
  /** A LIVE plan_item_claim sits directly on the item. */
  directlyClaimed: boolean;
  directHolder: string | null;
  directActivity: ItemActivity | null;
  /** P-029/D-060: the direct claim's holder WITH the goal they declared for it,
   *  so a reader browsing what is taken no longer has to collide with the holder
   *  to learn why. Null when nothing is directly claimed. Pure projection — every
   *  field is already on the `fleet_assignment` row read below (`detail` IS the
   *  claim intent for a plan_item_claim source), so it costs no extra query. */
  holder: ClaimHolder | null;
  level: CoverageLevel;
  /** Distinct holder ids actively on it (live links + a live direct claim). */
  workers: string[];
  /** Newest linked work-item update (≈ completion time for a 'complete' entry) —
   *  the recency signal the active-coverage default filters on (EI-9015). Null when
   *  no linked row carries a timestamp (e.g. a direct-claim-only entry). */
  lastActivityAt: Date | null;
}

/**
 * Pure coverage classifier (unit-testable, no I/O). `links` carry each linked
 * work-item's terminal flag + activity; `directlyClaimed` is whether a LIVE
 * plan-item claim sits on the item. See {@link CoverageLevel} for the bands.
 *
 * `directActivity` is the DIRECT plan-item claim's raw activity (null when no
 * claim row exists at all). It is separate from `directlyClaimed` because that
 * flag is already narrowed to LIVE holders by the caller — so a dead/stalled
 * direct claim arrives here as `directlyClaimed:false`, indistinguishable from
 * "no claim" without this argument. Optional so existing callers keep compiling;
 * omitting it only costs the held-not-live/held-stalled/none distinction for
 * direct claims.
 */
export function classifyCoverage(
  links: Pick<CoverageWorkLink, 'terminal' | 'activity'>[],
  directlyClaimed: boolean,
  directActivity?: ItemActivity | null,
): CoverageLevel {
  if (links.length === 0) {
    if (directlyClaimed) return 'full';
    // A direct claim whose holder died does NOT read as "genuinely unworked": the
    // claim row survives its holder, and so does the work-item ledger's assignee.
    if (isHeldStalled(directActivity)) return 'held-stalled';
    return isHeldButNotLive(directActivity) ? 'held-not-live' : 'none';
  }
  const nonTerminal = links.filter((l) => !l.terminal);
  // Every linked work-item is done → the plan item's work is complete (don't restart).
  if (nonTerminal.length === 0) return 'complete';
  const anyLive = directlyClaimed || nonTerminal.some((l) => isLiveActivity(l.activity));
  if (!anyLive) {
    // Nothing live — but is that "never taken" or "taken by someone who is gone"?
    // Both are pickable; only the second explains a non-null ledger assignee.
    if (isHeldStalled(directActivity) || nonTerminal.some((l) => isHeldStalled(l.activity))) {
      return 'held-stalled';
    }
    return isHeldButNotLive(directActivity) || nonTerminal.some((l) => isHeldButNotLive(l.activity))
      ? 'held-not-live'
      : 'unclaimed';
  }
  // Fully covered iff every still-open linked work-item is live-held.
  if (nonTerminal.every((l) => isLiveActivity(l.activity))) return 'full';
  return 'partial';
}

/**
 * One coverage COLLISION (EI-6074): a plan item that is directly claimed by one
 * principal while a LINKED live work-item covering the SAME deliverable is held by
 * a DIFFERENT principal — two distinct principals both working the same thing
 * (the "WI-X ≡ P-Y" duplicate). This is the cross-claim-table redundancy the
 * per-type dedup floor can't see: a work-item claim and the plan-item claim it
 * implements live in different tables and are never cross-checked, so
 * orphaned/stalled both read 0 while two live bees run the same work.
 *
 * Deliberately NARROW — it fires ONLY when a DIRECT plan-item claim coexists with a
 * differently-held linked work-item. Legitimate parallel decomposition (several
 * distinct linked work-items, each held by a different bee, with NO direct plan-item
 * claim) is NOT a collision: those are different deliverables under one plan item.
 */
export interface CoverageCollision {
  /** '<slug>#<item>'. */
  ref: string;
  /** The principal holding the direct plan-item claim on the item. */
  directHolder: string;
  /** The DISTINCT principals holding linked live work-item claims on the same
   *  deliverable (each holder !== directHolder). */
  workItemHolders: { workItemId: string; holder: string }[];
  /** All distinct principals in the collision (directHolder + workItemHolders). */
  principals: string[];
}

/**
 * Detect coverage collisions across a coverage map (EI-6074). Pure; no I/O.
 * Returns, for each plan item that is directly claimed AND has a linked live
 * work-item held by a DIFFERENT principal, the colliding ref + principals — so a
 * reader (fleet:assignments) can surface "two distinct principals both resolve to
 * the same deliverable" as a coordination-collision, alongside orphaned/stalled.
 *
 * Note `PlanItemCoverage.links[].holder` is populated ONLY for LIVE (progressing|
 * alive) work-item claims (see getAllPlanItemCoverage), so a stalled/dead linked
 * claim — which is reclaimable, not a live duplicate — never counts as a collision.
 */
export function coverageCollisions(cov: Iterable<PlanItemCoverage>): CoverageCollision[] {
  const out: CoverageCollision[] = [];
  for (const c of cov) {
    if (!c.directlyClaimed || !c.directHolder) continue;
    const workItemHolders = c.links
      .filter((l): l is CoverageWorkLink & { holder: string } => l.holder != null && l.holder !== c.directHolder)
      .map((l) => ({ workItemId: l.workItemId, holder: l.holder }));
    if (workItemHolders.length === 0) continue;
    const principals = [...new Set([c.directHolder, ...workItemHolders.map((w) => w.holder)])];
    out.push({ ref: c.ref, directHolder: c.directHolder, workItemHolders, principals });
  }
  return out;
}

/**
 * One same-principal duplicate-coverage finding (EI-21188799646985672): a
 * single live holder owns two or more DISTINCT non-terminal linked work-items
 * for one plan item. This is intentionally separate from CoverageCollision:
 * the latter detects contention between a direct plan-item claim and a linked
 * work-item claim held by a DIFFERENT principal, while this detector mirrors
 * the plan-item reflection guard's all-non-terminal-linked-work-items rule.
 */
export interface CoverageDuplicate {
  /** '<slug>#<item>'. */
  ref: string;
  /** The principal holding the duplicate linked work-items. */
  holder: string;
  /** Distinct non-terminal linked work-item IDs held by `holder`. */
  workItemIds: string[];
}

/**
 * Detect same-principal duplicate coverage across a coverage map (EI-21188799646985672).
 * Pure; no I/O. A work-item may have multiple coverage edges (for example
 * `fixes` and `relates`), so IDs are deduplicated before applying the
 * two-or-more threshold. `holder` is only populated for live linked claims by
 * getAllPlanItemCoverage; stalled/dead links therefore cannot raise this signal.
 * Direct plan-item claims are deliberately ignored: one direct claim plus one
 * linked work-item is the cross-table case owned by coverageCollisions, not a
 * same-principal linked-sibling duplicate.
 */
export function duplicateCoverage(cov: Iterable<PlanItemCoverage>): CoverageDuplicate[] {
  const out: CoverageDuplicate[] = [];
  for (const c of cov) {
    const byHolder = new Map<string, Set<string>>();
    for (const link of c.links) {
      if (link.terminal || link.holder == null) continue;
      const workItems = byHolder.get(link.holder) ?? new Set<string>();
      workItems.add(link.workItemId);
      byHolder.set(link.holder, workItems);
    }
    for (const [holder, workItems] of byHolder) {
      if (workItems.size < 2) continue;
      out.push({ ref: c.ref, holder, workItemIds: [...workItems] });
    }
  }
  return out;
}

/** Lean wire shape attached per plan item (omit empty arrays to keep payload small). */
export interface CompactCoverage {
  level: CoverageLevel;
  workers?: string[];
  /** P-029/D-060: the direct claim's holder + the goal they declared for it.
   *  ABSENT rather than null when there is no direct claim, and — the rule that
   *  matters — its absence never removes the ROW: a reader must not be able to
   *  infer holder visibility from the shape of the list (D-056). */
  holder?: ClaimHolder;
  links?: { id: string; rel: string; activity: ItemActivity; terminal: boolean; blocked?: true }[];
}

export function compactCoverage(cov: PlanItemCoverage): CompactCoverage {
  return {
    level: cov.level,
    ...(cov.workers.length ? { workers: cov.workers } : {}),
    ...(cov.holder ? { holder: cov.holder } : {}),
    ...(cov.links.length
      ? {
          links: cov.links.map((l) => ({
            id: l.workItemId,
            rel: l.rel,
            activity: l.activity,
            terminal: l.terminal,
            ...(l.blocked ? { blocked: true as const } : {}),
          })),
        }
      : {}),
  };
}

interface StampCoverageRow {
  work_item_id: string;
  item_kind: string;
  status: string;
  updated_ts: string | number | null;
  plan_slug: string;
  item_id: string;
  claim_hold: string | null;
}

interface CoverageLinkRow {
  dst_ref: string;
  rel: string;
  src_kind: string;
  src_ref: string;
  issue_state: string | null;
  feature_status: string | null;
  feature_id: string | null;
  issue_claim_hold: string | null;
  feature_claim_hold: string | null;
  /** Newest update on the joined work-item row (issue or feature side). */
  src_updated_at: Date | string | null;
}

const LIVE_SESSION_STATES = new Set<SessionState>(['live', 'parked', 'recorded']);
const GONE_SESSION_STATES = new Set<SessionState>(['ended', 'suspect', 'draining']);

/** Resolve holder state through the same oracle used by coord:presence. */
async function coverageSessionStates(
  rows: readonly Pick<FleetAssignmentRow, 'agentId' | 'source' | 'holderHeartbeatAt'>[],
): Promise<Map<string, SessionState>> {
  const subjects = new Map<string, { ownerId: string; heartbeatAt?: string | null; claimsHeld: boolean }>();
  for (const row of rows) {
    if (!row.agentId || row.source === 'presence' || subjects.has(row.agentId)) continue;
    subjects.set(row.agentId, {
      ownerId: row.agentId,
      heartbeatAt: row.holderHeartbeatAt,
      claimsHeld: true,
    });
  }
  if (subjects.size === 0) return new Map();
  try {
    const verdicts = await resolveSessionStates([...subjects.values()], { hydratePerId: true });
    // EI-18771777750306094: drop the in-band `null` (unmeasured) verdicts —
    // consumers already treat a missing owner as "no session-state evidence"
    // and pass `undefined` through to normalizeCoverageActivity, which is the
    // honest reading for an owner the oracle could not measure.
    return new Map(
      [...verdicts].flatMap(([ownerId, verdict]) =>
        verdict.sessionState == null ? [] : [[ownerId, verdict.sessionState] as const],
      ),
    );
  } catch {
    return new Map();
  }
}

/** Correct warm-heartbeat activity drift with the authoritative session state. */
function normalizeCoverageActivity(
  activity: ItemActivity,
  sessionState: SessionState | undefined,
): ItemActivity {
  if (sessionState && GONE_SESSION_STATES.has(sessionState)) return 'dead';
  // A live/parked/recorded session is not `reserved` merely because the view's
  // heartbeat join was absent or stale during this read.
  if (sessionState && LIVE_SESSION_STATES.has(sessionState) && activity === 'reserved') return 'alive';
  return activity;
}

/**
 * Every plan item with ≥1 work→plan_item edge OR a live direct claim, keyed by the
 * coord_links dst_ref ('<plan_slug>#<item_id>') → its fused coverage. ONE coord_links
 * query + ONE fleet_assignment read plus one batched liveness-oracle read, so
 * multi-plan readers hoist it out of their plan loop (the issue-blocks-merge
 * pattern). Pure read; never throws on empty.
 */
export async function getAllPlanItemCoverage(opts: {
  /** Restrict the coverage scan when a caller has already filtered its items. */
  planItemRefs?: readonly string[];
} = {}): Promise<Map<string, PlanItemCoverage>> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const requestedRefs = opts.planItemRefs;
  // Do not let an intentionally empty filtered set widen back into the
  // fleet-wide read used by health/coordination callers.
  if (requestedRefs !== undefined && requestedRefs.length === 0) return new Map();

  // 1. work→plan_item edges + the linked work-item's terminal state. NOTE: unlike the
  //    issue-BLOCK edge (issues:link → coord DEFAULT workspace), work_items:link writes
  //    the work→plan edge into the CALLER's workspace, so these edges are spread across
  //    workspaces — we must NOT filter coord_links by a fixed workspace (that silently
  //    dropped every edge). The plan_item dst_ref ('<slug>#<item>') is GLOBALLY unique,
  //    so an unfiltered match is collision-safe and the harness-scoped reader only ever
  //    looks up the refs of plans it lists. engineer_issues joins on the globally-unique
  //    issue_id (EI-2760). A feature_id is unique only per (workspace, harness), so the
  //    feature join is pinned to the active workspace (getWorkItem's F-B3 rule) on the
  //    harness-qualified '<harness>#<id>' src_ref — a cross-workspace feature link just
  //    resolves to null state (treated non-terminal, the safe direction).
  const linkRows = await sql<CoverageLinkRow[]>`
    SELECT l.dst_ref, l.rel, l.src_kind, l.src_ref,
           i.state      AS issue_state,
           i.payload ->> '_claimHold' AS issue_claim_hold,
           f.status     AS feature_status,
           f.payload ->> '_claimHold' AS feature_claim_hold,
           f.feature_id AS feature_id,
           GREATEST(i.updated_at,
                    to_timestamp((f.updated_ts::numeric / 1000.0)::double precision))
                        AS src_updated_at
      FROM harness_shared.coord_links l
      LEFT JOIN harness_shared.engineer_issues i
        ON l.src_kind = 'issue' AND i.issue_id = l.src_ref
      LEFT JOIN harness_shared.harness_features_consolidated f
        ON l.src_kind = 'feature'
       AND (f.harness_slug || '#' || f.feature_id) = l.src_ref
       AND f.workspace_id = ${ws}
     WHERE l.rel IN ('fixes', 'relates', 'duplicates')
       AND l.dst_kind = ${PLAN_ITEM_KIND}
       ${requestedRefs !== undefined ? sql`AND l.dst_ref = ANY(${requestedRefs}::text[])` : sql``}
     ORDER BY l.dst_ref, l.src_ref`;

  const stampRows = requestedRefs !== undefined
    ? await sql<StampCoverageRow[]>`
        WITH requested(plan_slug, item_id) AS (
          SELECT * FROM unnest(
            ${requestedRefs.map((ref) => ref.slice(0, ref.lastIndexOf('#')))}::text[],
            ${requestedRefs.map((ref) => ref.slice(ref.lastIndexOf('#') + 1))}::text[]
          )
        )
        SELECT w.feature_id AS work_item_id, w.item_kind, w.status, w.updated_ts,
               w.payload ->> '_claimHold' AS claim_hold,
               w.payload->'plan_item'->>'plan_slug' AS plan_slug,
               w.payload->'plan_item'->>'item_id'  AS item_id
          FROM harness_shared.work_items w
          JOIN requested r
            ON w.payload->'plan_item'->>'plan_slug' = r.plan_slug
           AND w.payload->'plan_item'->>'item_id' = r.item_id
         WHERE w.payload->'plan_item' IS NOT NULL`
    : await sql<StampCoverageRow[]>`
        SELECT feature_id AS work_item_id, item_kind, status, updated_ts,
               payload ->> '_claimHold' AS claim_hold,
               payload->'plan_item'->>'plan_slug' AS plan_slug,
               payload->'plan_item'->>'item_id'  AS item_id
          FROM harness_shared.work_items
         WHERE payload->'plan_item' IS NOT NULL
           AND payload->'plan_item'->>'plan_slug' IS NOT NULL
           AND payload->'plan_item'->>'item_id'  IS NOT NULL`;

  // 3. live claims (work-item AND plan-item) from the canonical view — one read.
  const linkedWorkItemIds = [
    ...new Set(
      [
        ...linkRows.map((row) =>
          row.src_kind === 'issue' ? row.src_ref : (row.feature_id ?? row.src_ref),
        ),
        ...stampRows.map((row) => row.work_item_id),
      ],
    ),
  ];
  const fleet = await listFleetAssignments({
    workspaceId: null,
    activeOnly: true,
    ...(requestedRefs !== undefined
      ? { planItemRefs: requestedRefs, workItemIds: linkedWorkItemIds }
      : {}),
  });
  const sessionStates = await coverageSessionStates(fleet);
  const wiActivity = new Map<string, { activity: ItemActivity; holder: string | null }>();
  // P-029/D-060: keep the claim's DECLARED GOAL alongside its activity. On a
  // `plan_item_claim` row the view's `detail` IS `plan_item_claims.intent`, and
  // `claim_acquired_ts`/`last_activity_ts` are the staleness signals — all three
  // already on the row, so carrying them costs nothing but the fields we stopped
  // discarding. (This used to keep `agentId` alone, which is exactly why a reader
  // saw a bare ownerId and had to collide with the holder to learn the why.)
  const directClaim = new Map<string, { activity: ItemActivity; holder: ClaimHolder | null; holderId: string | null }>();
  for (const r of fleet) {
    if (r.source === 'work_item_claim' && r.workItemId) {
      const activity = normalizeCoverageActivity(deriveActivity(r), r.agentId ? sessionStates.get(r.agentId) : undefined);
      wiActivity.set(r.workItemId, {
        activity,
        holder: isLiveActivity(activity) ? r.agentId : null,
      });
    } else if (r.source === 'plan_item_claim' && r.planSlug && r.itemId) {
      const activity = normalizeCoverageActivity(deriveActivity(r), r.agentId ? sessionStates.get(r.agentId) : undefined);
      directClaim.set(planItemRef(r.planSlug, r.itemId), {
        activity,
        holderId: r.agentId,
        holder: projectClaimHolder({
          ownerId: r.agentId,
          ownerLabel: r.agentLabel,
          itemId: r.itemId,
          intent: r.detail,
          acquiredTs: r.claimAcquiredTs,
          lastActivityTs: r.lastActivityTs,
        }),
      });
    }
  }

  // 4. Group edge-based links by plan-item ref, joining each to its live activity.
  const byRef = new Map<string, CoverageWorkLink[]>();
  const newestByRef = new Map<string, number>();
  for (const row of linkRows) {
    const workItemId = row.src_kind === 'issue' ? row.src_ref : (row.feature_id ?? row.src_ref);
    const terminal =
      (row.issue_state != null && ISSUE_TERMINAL.has(row.issue_state)) ||
      (row.feature_status != null && FEATURE_TERMINAL.has(row.feature_status));
    const live = wiActivity.get(workItemId);
    const activity: ItemActivity = live?.activity ?? 'free';
    const holder = isLiveActivity(activity) ? (live?.holder ?? null) : null;
    // A durable claim hold is the same self-select exclusion floor as a blocked
    // work-item. `plans:items { actionable:true }` consumes this one coverage flag
    // to avoid advertising the linked plan lane while its work-item is parked.
    const blocked =
      row.issue_state === 'blocked' ||
      row.feature_status === 'blocked' ||
      row.issue_claim_hold === 'true' ||
      row.feature_claim_hold === 'true';
    const arr = byRef.get(row.dst_ref) ?? [];
    arr.push({
      workItemId,
      rel: row.rel,
      terminal,
      ...(blocked ? { blocked: true as const } : {}),
      activity,
      holder,
    });
    byRef.set(row.dst_ref, arr);
    if (row.src_updated_at != null) {
      const ts = new Date(row.src_updated_at).getTime();
      if (Number.isFinite(ts) && ts > (newestByRef.get(row.dst_ref) ?? 0)) {
        newestByRef.set(row.dst_ref, ts);
      }
    }
  }

  // 5. STAMP-based coverage (EI-13721). A work-item can carry a durable
  // `payload.plan_item` stamp as its ONLY plan binding when whatever path
  // created/stamped it never wrote the coord_links coverage edge above (a
  // hand-built payload, a legacy/ad-hoc creation path, or an edge pruned
  // out-of-band — the same "the edge can survive without the stamp or vice
  // versa" reality convert.ts's findConvertedWorkItemByStamp and
  // reconcile-linked-work-items.ts's findAllLinkedWorkItems already treat as a
  // backstop truth source at pickup/reconcile time). Confirmed live (2026-07-19):
  // WI-1, WI-5141, WI-155 all carry a plan_item stamp with zero coverage edge.
  // Without this leg such a work-item's plan item reads `coverage: undefined`
  // (looks genuinely unworked) even though a live assignee is actively on it —
  // exactly the false "orphaned lane" diagnosis EI-13721 reports. Read the
  // UNIFIED base table (harness_shared.work_items, migration 374 — one
  // row-space across both families, feature_id/status/item_kind uniform) so
  // this is correct regardless of which path bound the work-item — not only
  // the coord_links-edge path. Merged below, deduped against any edge-based
  // entry for the same (ref, work-item) pair so a normally-linked item is
  // never double-counted or given a second synthetic link.
  // The leading `payload->'plan_item' IS NOT NULL` matches the PARTIAL predicate of
  // work_items_plan_item_stamp_idx (migration 725) exactly — that is what lets the
  // planner use the index instead of scanning. ⚠ Do NOT reintroduce a
  // `CASE WHEN jsonb_typeof(payload)='string'` unwrap here: that mitigation for the
  // postgres-js `::jsonb` binding quirk is precisely what defeated the index and made
  // the sibling stamp lookup ~7.6 HOURS of DB time per day (WI-6993). The write path
  // is fixed at the source (restoreRawJsonbSerializer, EI-18698602043482898) and 725's
  // CHECK constraint makes a non-object payload unstorable.
  for (const row of stampRows) {
    const ref = planItemRef(row.plan_slug, row.item_id);
    const arr = byRef.get(ref) ?? [];
    if (arr.some((l) => l.workItemId === row.work_item_id)) continue; // already covered via a real edge
    const terminal = ISSUE_FAMILY_KINDS.includes(row.item_kind as (typeof ISSUE_FAMILY_KINDS)[number])
      ? ISSUE_TERMINAL.has(row.status)
      : FEATURE_TERMINAL.has(row.status);
    const live = wiActivity.get(row.work_item_id);
    const activity: ItemActivity = live?.activity ?? 'free';
    const holder = isLiveActivity(activity) ? (live?.holder ?? null) : null;
    arr.push({
      workItemId: row.work_item_id,
      rel: STAMP_ONLY_REL,
      terminal,
      ...(row.status === 'blocked' || row.claim_hold === 'true' ? { blocked: true as const } : {}),
      activity,
      holder,
    });
    byRef.set(ref, arr);
    if (row.updated_ts != null) {
      const ts = Number(row.updated_ts);
      if (Number.isFinite(ts) && ts > (newestByRef.get(ref) ?? 0)) {
        newestByRef.set(ref, ts);
      }
    }
  }

  // 5. Assemble coverage for the union of refs that have a link OR a direct claim.
  const out = new Map<string, PlanItemCoverage>();
  const refs = new Set<string>([...byRef.keys(), ...directClaim.keys()]);
  for (const ref of refs) {
    const links = byRef.get(ref) ?? [];
    const direct = directClaim.get(ref) ?? null;
    const directlyClaimed = Boolean(direct && isLiveActivity(direct.activity));
    const level = classifyCoverage(links, directlyClaimed, direct?.activity ?? null);
    const workers = new Set<string>();
    for (const l of links) if (l.holder) workers.add(l.holder);
    if (directlyClaimed && direct?.holderId) workers.add(direct.holderId);
    const newest = newestByRef.get(ref);
    out.set(ref, {
      ref,
      links,
      directlyClaimed,
      directHolder: direct?.holderId ?? null,
      directActivity: direct?.activity ?? null,
      // Mirrors `directHolder`'s presence rule — projected whenever a direct claim
      // row exists, INCLUDING a stalled/dead one. Hiding a lapsing holder would
      // hide the case a reader most needs: `stale`/`directActivity` say it is not
      // progressing, which is more useful than an empty holder that reads as free.
      holder: direct?.holder ?? null,
      level,
      workers: [...workers],
      lastActivityAt: newest != null ? new Date(newest) : null,
    });
  }
  return out;
}
