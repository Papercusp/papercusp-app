/**
 * reconcileLinkedWorkItems — the MISSING reverse half of reflect-rules.ts
 * (EI-5925: "completing a plan item doesn't auto-reconcile its linked/mirror
 * work-items -> a large phantom-todo backlog causing fleet-wide claim-churn").
 *
 * reflect-rules.ts already mirrors a work_item's lifecycle ONTO its linked plan
 * item (complete/set_state -> plans:set-status). But when a plan item is flipped
 * to `done` via some OTHER path — directly on the plan, or by a SIBLING work-item
 * that also implements it — any OTHER work-item still pointing at that same plan
 * item is never told: it sits non-terminal forever, a phantom "todo" that
 * multiple agents independently re-verify and race to close by hand (the exact
 * fleet-time cost this ticket reports; su-bda6c's manual "Reconciled via
 * plan-item status" sweeps are precisely this operation, done by a human/agent
 * instead of the system).
 *
 * This module is the reverse mirror: given a plan item that just went `done`,
 * find EVERY work-item still pointing at it — via BOTH truth sources convert.ts
 * writes (the `implements` coord_links edge AND the `payload.plan_item` stamp,
 * since either can survive the other's deletion) — and auto-resolve any that are
 * (a) still non-terminal AND (b) carry NO independent in-flight progress
 * (`lastProgressAt` unset — the real item-scoped progress signal, distinct from
 * a mere claim/heartbeat per work-items.ts's own docs). Guard (b) is exactly the
 * ticket's own stated safety rail: never clobber genuinely-active parallel work
 * on the same item.
 *
 * Wired as a builtin reaction action (events/builtin-actions.ts) fired by a rule
 * on `plans:set-status` (plan-items/reconcile-rule.ts) — NOT a hardcoded call
 * inside plans/set-status.ts — so the whole plan-item <-> work-item lifecycle
 * interplay stays ONE mechanism, inspectable in events:graph, matching the
 * architecture reflect-rules.ts already established.
 */
import { getOrgPg } from '@papercusp/db-org';
import { PLAN_ITEM_KIND, planItemRef, implementsLinkScopes } from '../issue-blocks-merge';
import { IMPLEMENTS_REL } from './convert';
import {
  getWorkItem,
  setWorkItemState,
  setWorkItemStateWithAliasInfo,
  setWorkItemClaimHold,
  mergeWorkItemPayload,
  isSettledWorkItemState,
  isClaimHoldParked,
  readWorkItemHeldOpenBy,
  readWorkItemClaimHoldProvenance,
  looksLikePolicyGate,
  ISSUE_FAMILY_KINDS,
  SETTLED_WORK_ITEM_STATES,
  type WorkItem,
} from '../work-items';
import { getPlanRow, planItemsForRow, type PlanRow } from '../agent-tools/plans/source';
import { resolveEffectiveStatusForItems } from '@papercusp/plan-parser';
import { getFeatureBlockers, syncFeatureBlockEdges } from '../dbos/feature-blockers-edges';
import {
  activeExternalBlockers,
  externalBlockerCapabilityPolicy,
  inferExternalBlockerCapability,
  readExternalBlockers,
  updateExternalBlockerHistory,
  type ExternalBlockerCapability,
  type ExternalBlockerRecord,
} from '../external-blockers';
import { RECONCILER_SYSTEM_ACTOR } from '../completion-audit';
import type { AgenticPlanExecutionTarget } from '../agentic-plan-execution-target';

/** The two TERMINAL plan-item statuses this reconciler heals (mirrors
 *  `isTerminalStatus` in agent-tools/plans/set-status.ts) and the settled
 *  work-item state each maps onto, per family:
 *   - `done`    → the work SHIPPED   → feature `passed`     / issue `resolved`
 *   - `dropped` → the work ABANDONED → feature `deprecated` / issue `closed`
 *  The `dropped` half is EI-14693's extension: the transition reaction only ever
 *  fired on `done` (reconcile-rule.ts's `newlyDonePlanItem`), so a WI linked to a
 *  `dropped` plan item was NEVER reconciled — the periodic sweep below closes that
 *  gap too. */
const TERMINAL_PLAN_ITEM_TARGET = {
  done: { feature: 'passed', issue: 'resolved' },
  dropped: { feature: 'deprecated', issue: 'closed' },
} as const;
type TerminalPlanItemStatus = keyof typeof TERMINAL_PLAN_ITEM_TARGET;
function isTerminalPlanItemStatus(s: string | null | undefined): s is TerminalPlanItemStatus {
  return s === 'done' || s === 'dropped';
}

/** One plan item that just transitioned to `done` (or an equivalent terminal
 *  status) — the minimal identity reconciliation needs. */
export interface CompletedPlanItem {
  planSlug: string;
  itemId: string;
  /** EI-8970: the harness the triggering `plans:set-status` flip ran under
   *  (its ctx.harnessSlug) — threads through to the stale-read guard below so
   *  it re-reads the SAME plan row the flip wrote, rather than guessing the
   *  operator-home harness for a plan that actually lives in a different one.
   *  Optional/omitted is safe — the guard degrades to a best-effort resolve. */
  harnessSlug?: string | null;
  /**
   * EI-18677799334390930: the coordination identity (ownerId) of whoever actually
   * flipped the plan item to done/dropped, when the trigger's ctx resolved one —
   * best-effort, may be absent (e.g. a system-triggered flip). Retained as transient
   * trigger context for callers, but deliberately NOT persisted as completion evidence:
   * mirroring a plan status is only a proposed judgement, not independent verification.
   */
  triggeredBy?: string | null;
}

export interface ReconcileLinkedWorkItemsResult {
  planSlug: string;
  itemId: string;
  /** Work-item ids auto-resolved by this sweep. */
  reconciled: string[];
  /** Linked but carrying independent in-flight progress — left alone. */
  skippedInFlight: string[];
  /** Linked but already terminal — nothing to do. */
  skippedAlreadyTerminal: string[];
  /**
   * EI-19460536530145188: issue-family work-items (bug/change/task) reached ONLY
   * via the `payload.plan_item` stamp, with no `implements` edge to prove they
   * are an IMPLEMENTATION of the plan item. Deliberately NOT terminal-closed —
   * see the guard below for why a bare stamp is not evidence of implementation.
   */
  skippedUnprovenLink: string[];
  /**
   * EI-22178190387074148: linked work-items sitting in `blocked`/`needs-human` —
   * left alone rather than terminal-closed. That state IS the authority signal:
   * an open owner-decision or external dependency the WORK-ITEM tracks, which a
   * sibling plan item reaching done/dropped says nothing about resolving. See the
   * guard below for the full rationale.
   */
  skippedGatedState: string[];
}

/**
 * A work-item linked to a plan item, tagged with WHICH truth source found it.
 * `viaImplementsEdge` is the only evidence that the work-item IMPLEMENTS the
 * plan item rather than merely referencing it — see the reconcile guard.
 */
export type LinkedWorkItem = WorkItem & { viaImplementsEdge: boolean };

/**
 * D-046 (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 / WI-40754): ONE canonical
 * work-item per plan lane. Among the NON-terminal linked rows the canonical row is the
 * EARLIEST-created (tie → lexicographically smallest id), preferring rows PROVEN by an
 * `implements` edge — so an unrelated stamp-only row can never outrank a real promoted
 * implementation, while the stamp-only fallback still elects a canonical row when no
 * proven implementation exists at all. Every other non-terminal linked row is a
 * DUPLICATE the lane sync must not mutate (live evidence: plan-lane sync reopened
 * duplicate mints WI-40504 AND WI-40513 together; post-D-046 it mutates only the
 * canonical row and reports the rest as `skippedDuplicates`). Pure — no I/O.
 */
export function selectCanonicalLinkedWorkItem(linked: readonly LinkedWorkItem[]): {
  canonical: LinkedWorkItem | null;
  duplicates: LinkedWorkItem[];
} {
  const nonTerminal = linked.filter((wi) => !isSettledWorkItemState(wi.state));
  if (nonTerminal.length === 0) return { canonical: null, duplicates: [] };
  const proven = nonTerminal.filter((wi) => wi.viaImplementsEdge);
  const pool = proven.length > 0 ? proven : nonTerminal;
  let canonical = pool[0];
  for (const wi of pool.slice(1)) {
    const tCanon = Date.parse(canonical.createdAt) || 0;
    const tNext = Date.parse(wi.createdAt) || 0;
    if (tNext < tCanon || (tNext === tCanon && wi.id < canonical.id)) canonical = wi;
  }
  return { canonical, duplicates: nonTerminal.filter((wi) => wi !== canonical) };
}

/** Match the durable `payload.plan_item` stamp (plan_slug + item_id) on either
 *  federated table.
 *
 *  The leading `payload->'plan_item' IS NOT NULL` is load-bearing, not a
 *  redundant guard: it matches the PARTIAL predicate of
 *  work_items_plan_item_stamp_idx (migration 725) exactly, which is what
 *  permits an index scan rather than a seq scan. harness_features_consolidated
 *  is a plain (non-aggregating) view over work_items, so a query against it
 *  inlines onto the same base-table index — there is no separate hfc-side
 *  index (WI-7049: migration 725 originally tried to add one directly on the
 *  view, which is illegal on Postgres and was removed).
 *
 *  ⚠ Do NOT reintroduce a `CASE WHEN jsonb_typeof(payload) = 'string'` unwrap
 *  here. That mitigation for the postgres-js `::jsonb` binding quirk
 *  (agent-insights/postgres-js-jsonb-binding) is exactly what defeated the index
 *  and made this lookup the single largest live consumer of DB time in the
 *  system — ~7.6 hours per day at 142 calls/min x 134ms to return ONE row
 *  (WI-6993). It is no longer needed at all: the write path is fixed at the
 *  source (restoreRawJsonbSerializer, EI-18698602043482898) and migration 725's
 *  CHECK constraint makes a non-object payload unstorable. */
function stampMatchFragment(sql: ReturnType<typeof getOrgPg>['sql'], planSlug: string, itemId: string) {
  return sql`payload->'plan_item' IS NOT NULL
         AND payload->'plan_item'->>'plan_slug' = ${planSlug}
         AND payload->'plan_item'->>'item_id' = ${itemId}`;
}

/**
 * Every work-item that implements-or-was-stamped-for one plan item, deduped by
 * (harness, id). No harness filter needed — a plan item's ref ('<plan>#<item>')
 * is already the join key across the edge, payload-stamp, and feature-column
 * truth sources.
 */
export async function findAllLinkedWorkItems(planSlug: string, itemId: string): Promise<LinkedWorkItem[]> {
  const { sql } = getOrgPg();
  const found = new Map<string, LinkedWorkItem>();
  // `viaImplementsEdge` is STICKY-TRUE: an item found by BOTH truth sources is
  // proven by the edge, and the later stamp pass must not downgrade it.
  const add = (wi: WorkItem | null, viaImplementsEdge: boolean) => {
    if (!wi) return;
    const key = `${wi.harness ?? ''}#${wi.id}`;
    const prior = found.get(key);
    found.set(key, {
      ...wi,
      viaImplementsEdge: viaImplementsEdge || prior?.viaImplementsEdge === true,
    });
  };

  // Truth source 1: the `implements` coord_links edge (every row — a plan item
  // can, in principle, have accumulated more than one if a duplicate mint ever
  // slipped through; reconciling all of them is strictly safer than only the
  // newest).
  //
  // WI-10004553: read BOTH tenants of the split link plane. This lookup was pinned to
  // DEFAULT_COORD_WORKSPACE, but every edge written since 2026-08-27 lives under
  // coordScopeWorkspace(), so each post-cutover promoted ISSUE read as stamp-only and
  // was left open forever by the unproven-link guard below (~190 rows measured).
  const linkRows = await sql<{ src_kind: string; src_ref: string }[]>`
    SELECT DISTINCT src_kind, src_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ANY(${implementsLinkScopes()})
       AND rel = ${IMPLEMENTS_REL}
       AND dst_kind = ${PLAN_ITEM_KIND}
       AND dst_ref = ${planItemRef(planSlug, itemId)}`;
  for (const r of linkRows) {
    if (r.src_kind === 'issue') {
      add(await getWorkItem(r.src_ref), true);
    } else if (r.src_kind === 'feature') {
      const i = r.src_ref.indexOf('#');
      if (i > 0) add(await getWorkItem(r.src_ref.slice(i + 1), r.src_ref.slice(0, i)), true);
    }
  }

  // Truth source 2: the payload.plan_item stamp — the backstop that survives an
  // out-of-band edge deletion (findConvertedWorkItemByStamp's rationale, here
  // collecting EVERY match rather than just the newest).
  const featureRows = await sql<{ feature_id: string; harness_slug: string }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE ${stampMatchFragment(sql, planSlug, itemId)}`;
  for (const r of featureRows) add(await getWorkItem(r.feature_id, r.harness_slug), false);

  // Truth source 3: the live feature columns written by plans:convert. Keep this
  // as a separate indexed lookup rather than OR-ing it into the payload-stamp
  // query above: the exact stamp predicate is what lets Postgres use
  // work_items_plan_item_stamp_idx, while source_plan_slug/source_plan_item_ids
  // are independently authoritative for feature-family rows whose payload stamp
  // was never written (or was lost during legacy migration).
  const featureColumnRows = await sql<{ feature_id: string; harness_slug: string }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE source_plan_slug = ${planSlug}
       AND ${itemId} = ANY(COALESCE(source_plan_item_ids, ARRAY[]::text[]))`;
  for (const r of featureColumnRows) add(await getWorkItem(r.feature_id, r.harness_slug), false);

  // Read the UNIFIED base table rather than the engineer_issues view. The view
  // projects `payload - '_ei'`, and an index cannot be built on the base table to
  // serve that derived expression — so going through the view forced a seq scan on
  // every call. `engineer_issues` is exactly `work_items` filtered to the issue
  // family with feature_id aliased to issue_id, so this is the same row set.
  const issueRows = await sql<{ issue_id: string }[]>`
    SELECT feature_id AS issue_id
      FROM harness_shared.work_items
     WHERE item_kind = ANY(${[...ISSUE_FAMILY_KINDS]}::text[])
       AND ${stampMatchFragment(sql, planSlug, itemId)}`;
  for (const r of issueRows) add(await getWorkItem(r.issue_id), false);

  return [...found.values()];
}

/** Reconcile every work-item linked to ONE just-completed plan item. Never
 *  throws — a per-item DB hiccup is caught and surfaced via `reconciled: []`
 *  rather than breaking the caller's (fire-and-forget reaction) path. */
export async function reconcileLinkedWorkItemsForPlanItem(
  item: CompletedPlanItem,
  opts: {
    knownTerminalStatus?: TerminalPlanItemStatus;
  } = {},
): Promise<ReconcileLinkedWorkItemsResult> {
  const out: ReconcileLinkedWorkItemsResult = {
    planSlug: item.planSlug,
    itemId: item.itemId,
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
    skippedGatedState: [],
  };
  try {
    // Resolve the plan item's TERMINAL status (done vs dropped) — it both gates
    // the sweep (bail if it is no longer terminal) and selects the settled state
    // each linked work-item is flipped to (TERMINAL_PLAN_ITEM_TARGET).
    let terminalStatus: TerminalPlanItemStatus;
    if (opts.knownTerminalStatus) {
      // The periodic data-heal sweep (reconcileOrphanedPlanItemWorkItems) has
      // ALREADY re-read the plan row fresh and CONFIRMED this item terminal, so it
      // is fail-CLOSED at the caller (it never passes a non-terminal item). Trust
      // that read and skip a redundant per-item getPlanRow round-trip.
      terminalStatus = opts.knownTerminalStatus;
    } else {
      // EI-8970: the reaction path fires fire-and-forget off the triggering
      // `plans:set-status` event's SNAPSHOT ("this item just went done"). By the
      // time the sweep actually runs, a peer may already have CORRECTED the SAME
      // plan item back off terminal (a premature done, caught and flipped back to
      // wip moments later). Acting on the stale snapshot would terminal-flip every
      // linked work-item under a now-false premise — the exact race observed on
      // cup-lexicon-full-rename-2026-07-09#P-006 / WI-3463. Re-read the item's
      // CURRENT stored status and bail the WHOLE sweep (touch nothing) if it is no
      // longer terminal — the next genuine terminal transition re-fires this rule
      // and reconciles correctly then. Fails OPEN as `done` (the reaction only
      // ever fires on a done transition) on any read hiccup or when the row/item
      // can't be resolved — this guard must never turn a DB blip or a missing
      // derived index into a missed reconcile.
      const row = await getPlanRow(item.planSlug, {
        harnessSlug: item.harnessSlug ?? undefined,
      }).catch(() => null);
      const current = row?.items.find((i) => i.id === item.itemId);
      if (current && !isTerminalPlanItemStatus(current.status)) {
        return out;
      }
      terminalStatus = current && isTerminalPlanItemStatus(current.status) ? current.status : 'done';
    }
    const target = TERMINAL_PLAN_ITEM_TARGET[terminalStatus];

    const linked = await findAllLinkedWorkItems(item.planSlug, item.itemId);
    for (const wi of linked) {
      if (isSettledWorkItemState(wi.state)) {
        out.skippedAlreadyTerminal.push(wi.id);
        continue;
      }
      // EI-19968934836644509: lift a stale plan-lane-sync hold on EVERY non-
      // settled linked item, UNCONDITIONALLY — before either skip check below.
      // This reconciler has just confirmed the plan item is genuinely terminal,
      // so a `plan-lane:` external blocker / held_open lease this same sync
      // mechanism left behind is stale REGARDLESS of whether the terminal STATE
      // flip itself proceeds. It previously sat AFTER both skip checks, so an
      // item that hit either — in-flight (an active assignee still working it)
      // or unproven-link (issue-family, stamp-only) — `continue`d past it every
      // single sweep pass and could stay gate-parked forever even though every
      // pass re-confirmed its plan item was done: WI-37408 sat blocked
      // ~1h20m behind a live `lastProgressAt`+assignee (genuinely being worked,
      // correctly never auto-closed) while its lane hold, which is orthogonal to
      // whether we trust the completion, was never lifted. Best-effort: a clear
      // failure here must never block the skip/flip logic that follows.
      await clearStaleLaneHold(wi, planLaneBlockerRef(item.planSlug, item.itemId));
      const gatedByOwnState =
        (wi.state === 'blocked' || wi.state === 'needs-human') &&
        // EXCLUDE a block THIS sync mechanism itself imposed (mirroring a
        // blocked/needs-human PLAN LANE onto the work-item — see the
        // "Non-terminal plan-item lane sync" section below). clearStaleLaneHold
        // just above already lifted its hold metadata now that the plan item is
        // confirmed terminal, so that flavor of blocked/needs-human is stale
        // residue, not an independent signal — it must still reconcile normally
        // (WI-stale-hold / WI-active-held / WI-stamp-only below all cover this).
        readWorkItemHeldOpenBy(wi.payload)?.by !== PLAN_LANE_SYNC_ACTOR;
      if (gatedByOwnState) {
        // EI-22178190387074148: `blocked`/`needs-human` is not "still being worked
        // on" (that is the assignee check below) — it is the WORK-ITEM asserting
        // an open question or external dependency, independent of whatever the
        // plan item did. A sibling plan item reaching done/dropped says nothing
        // about that question being resolved, so silently terminal-closing it here
        // would resolve it by fiat and destroy the signal (the repro: an unclaimed
        // `blocked` issue carrying an open owner-decision question, closed as a
        // side effect of dropping the plan item that merely pointed at it).
        //
        // Biased the same way as the in-flight and unproven-link skips below: a
        // surviving open item is recoverable (someone resolves the block, then
        // closes it with that resolution recorded); a silent terminal close is
        // not — nobody looks at it again, and it reads as an answered question
        // that was never actually answered.
        out.skippedGatedState.push(wi.id);
        continue;
      }
      if (wi.assignee) {
        // SOMEONE CURRENTLY HOLDS THIS ITEM — a sibling completed the plan item,
        // but this one is genuinely still being worked. Never clobber it.
        //
        // EI-20405552992224051: this keys on the CURRENT HOLDER ALONE, deliberately.
        // It previously required `lastProgressAt && wi.assignee`, which stranded the
        // exact REVERSE of the WI-6303 case below: an item an agent has just REOPENED
        // and RE-CLAIMED in order to finish the work carries an assignee but no
        // `lastProgressAt` yet — nothing has been recorded against it since the reopen
        // — so it read as NOT in-flight and this sweep terminal-closed it back out from
        // under its live holder. That is the "each reconcile pass re-closes whatever the
        // last agent reopened" loop two agents hit independently on WI-38661/WI-38600:
        // reopening the work-item alone never stuck, because its plan item stayed
        // terminal and the next pass simply re-closed it. A CURRENT CLAIMANT is
        // sufficient evidence of in-flight work by itself; also demanding a progress
        // stamp asks a just-started holder to prove activity it has not yet had time to
        // record. Note WI-6303 below ADDED `&& wi.assignee` rather than REPLACING the
        // timestamp, and its own closing sentence ("Requiring a CURRENT assignee closes
        // the gap") describes the predicate it meant to leave behind — this restores it.
        //
        // Measured when this landed (papercusp-workspace, non-terminal rows): 4 held
        // with no progress stamp (the vulnerable population), 25 held with one (already
        // protected either way), 803 carrying a stale stamp with NO holder (the WI-6303
        // population, which stays reconcilable because it has no assignee).
        //
        // Biased safely: skipping leaves the item OPEN and therefore RECOVERABLE, which
        // is the same asymmetry the unproven-link guard below is argued from — a silent
        // terminal close is the unrecoverable direction.
        //
        // WI-6303: `lastProgressAt` alone is NOT a safe in-flight signal — three
        // reclaim paths (work-items-stale-claims.ts's dead/stalled-holder reaper,
        // shared-pot-loop/fleet-monitors.ts's sweepOrphanedTakenBy, and
        // fleet/pg-stores.ts's fleet:cancel claim release) clear `taken_by`/
        // `taken_at` on reclaim but leave `last_progress_at` stamped from
        // whatever the dead/orphaned holder last did — unlike the voluntary
        // release path and the terminal-transition path, which both clear it
        // (see the "release clears the progress signal too" comment on
        // releaseWorkItem). A work-item reclaimed by any of those three paths
        // then reads as "genuinely active" FOREVER (no staleness decay, no
        // re-check), permanently hiding it from this reconciler even with zero
        // claimant — the live-verified root cause of WI-5130/WI-5136/WI-5137
        // drifting from their already-`done` plan items P-104/P-301/P-402 for
        // 10+ days. Requiring a CURRENT assignee closes the gap for both new
        // occurrences (once the three reclaim paths below are fixed to clear
        // last_progress_at) and existing corrupted rows (an unclaimed item with
        // a stale timestamp is no longer treated as in-flight).
        out.skippedInFlight.push(wi.id);
        continue;
      }
      if (wi.family === 'issue' && !wi.viaImplementsEdge) {
        // EI-19460536530145188: an ISSUE-family item reached only by the
        // `payload.plan_item` STAMP, with no `implements` edge. The stamp is NOT
        // evidence of implementation, and closing on it destroys real work.
        //
        // WHY THE STAMP IS NOT EVIDENCE: `work_items:create { plan_item }` writes
        // its coord edge with rel `'relates'` (_create-core.ts) — deliberately
        // weaker than `implements`. It writes the stamp too, but ONLY so that
        // work_items:complete's plan-item auto-flip can find it
        // (EI-19390496242545842, which added the stamp write for that FORWARD
        // direction alone). This reconciler then read the same stamp in the
        // REVERSE direction as if it asserted implementation. It does not: an
        // agent who files a bug DISCOVERED while working P-007 passes
        // `plan_item:{...}` because it is the only linking field offered, and the
        // tool describes it as a coverage edge — not as a self-destruct.
        //
        // MEASURED before this guard (whole history, 1,210 reconciler-closed rows):
        //   task    593 — 593 via implements edge,   0 stamp-only
        //   feature 585 —   0 via implements edge, 585 stamp-only  (feature-family, unaffected)
        //   change   30 —  29 via implements edge,   1 stamp-only
        //   bug       1 —   0 via implements edge,   1 stamp-only  (WI-9333, destroyed)
        // So every legitimately-reconciled issue-family item (593 task + 29 change)
        // carries the edge and is UNAFFECTED; only the 2 stamp-only issue rows are
        // spared. Feature-family is untouched — it is entirely stamp-borne by
        // design (convert.ts / plan-run minting), which is why the stamp path
        // cannot simply be dropped, and why this guard is scoped to `issue`.
        //
        // ⚠ Do NOT "fix" this by excluding bug/change by KIND instead. 29 of the
        // 30 reconciled `change` rows are genuine plan-item implementations
        // ("P-005: Tests + gates…", "Apply compact icon-only rail…") minted with
        // the edge by convert.ts; a kind-based exclusion would strand all of them
        // as the phantom-todos EI-5925 created this module to eliminate — breaking
        // 30 to save 1. The truth source, not the kind, is the discriminator.
        //
        // Skipping (rather than closing as `closed`/abandoned) is the deliberate
        // choice: a surviving open item is RECOVERABLE — an agent claims it, sees
        // the work already landed, and closes it with evidence. A silent terminal
        // close is not: nobody looks at it again, and it reads as a shipped fix.
        out.skippedUnprovenLink.push(wi.id);
        continue;
      }
      const targetState = wi.family === 'feature' ? target.feature : target.issue;
      // EI-18653945816361859 / EI-19968934836644509: the stale plan-lane-sync
      // hold on this item was already lifted above (hoisted ahead of the
      // in-flight/unproven-link skip checks, unconditionally, for every
      // non-settled linked item) — so by the time control reaches here
      // setWorkItemState's held-open guard never has stale gate state left to
      // trip on. No second clearStaleLaneHold call needed; it is idempotent
      // but redundant.
      try {
        await setWorkItemState(wi.id, targetState, {
          harness: wi.harness ?? undefined,
          by: RECONCILER_SYSTEM_ACTOR,
          completionAuthority: 'proposed',
        });
        out.reconciled.push(wi.id);
      } catch {
        // A single item's flip failing (e.g. a race that terminalized it
        // between the read above and now) must not break the sweep.
      }
    }
  } catch {
    // DB hiccup — this is a best-effort sweep, never a hard dependency of the
    // plan-item flip that triggered it.
  }
  return out;
}

/** Reconcile a BATCH of just-completed plan items (the bulk plans:set-status
 *  shape) — one call per item, all failures isolated. */
export async function reconcileLinkedWorkItemsForCompletedPlanItems(
  items: CompletedPlanItem[],
): Promise<ReconcileLinkedWorkItemsResult[]> {
  const out: ReconcileLinkedWorkItemsResult[] = [];
  for (const item of items) {
    out.push(await reconcileLinkedWorkItemsForPlanItem(item));
  }
  return out;
}

// ── Non-terminal plan-item lane sync (EI-14699) ──────────────────────────────
// The reconciler above heals a plan item that reached done/dropped. Its GATED
// sibling problem: a plan item flipped to `blocked`/needs-human leaves its linked
// work-item at `state:'todo'`, so scheduler:get_next / the `work-item:claimable`
// pool keep serving it — each self-selector claims it, the plan-item-lane-guard
// (scheduler/plan-item-lane-guard.ts) discovers the blocked lane and RELEASES it,
// and the cycle repeats: a perpetual claim/release ping-pong that burns fleet
// cycles (WI-3475/WI-3467 each cycled 8+ times before a human hand-set `blocked`).
// reflect-rules.ts mirrors work_item → plan_item, and the reconciler above mirrors
// a TERMINAL plan_item → work_item — but the gated lane statuses had NO reverse
// leg, so the two surfaces drift.
//
// The durable fix mirrors the terminal reconciler's own "heal the data, not the
// view" pattern: the periodic sweep below ALSO syncs a blocked/needs-human plan
// lane ONTO its linked work-items — PARKING them out of the self-select pool (so
// the ping-pong stops at the source, not just at the post-claim guard) — and
// UN-parks them the moment the lane is actionable again. Parking reuses the
// external-blocker machinery (external-blockers.ts / work_items:set_blocker): a
// provenance-carrying `plan-lane:<plan>#<item>` blocker record IS the marker that
// THIS sync parked the item, so the un-park only ever lifts a park this sync
// created and restores to claimable ONLY when no OTHER active blocker remains —
// the exact rule work_items:set_blocker uses, so an independently-blocked item is
// never clobbered.

/** The blocker `kind` this lane sync stamps on a linked work-item while its plan
 *  lane is blocked/needs-human. A single stable kind + `plan-lane:` ref across
 *  BOTH gated statuses keeps the clear path a single (kind, ref) match. */
const PLAN_LANE_BLOCKER_KIND = 'gate' as const;
const PLAN_LANE_SYNC_ACTOR = 'system:plan-item-lane-sync';

/**
 * WI-37914: the payload key recording the state a work-item held BEFORE this sync
 * parked it, so the un-park restores what was actually there instead of flattening
 * every item to the family's claimable default (an item parked while `wip` must not
 * silently reopen as unclaimed work).
 */
const PLAN_LANE_PARKED_FROM_KEY = 'planLaneParkedFrom';

/** The stashed pre-park state, or null. Defensive — payload is federated JSON. */
export function readPlanLaneParkedFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)[PLAN_LANE_PARKED_FROM_KEY];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Work-item states that mean "somebody is holding this" — restored only when the
 *  holder is still on it (see {@link restoreStateAfterUngate}). */
const IN_PROGRESS_WORK_ITEM_STATES = new Set(['wip', 'in_progress', 'in-progress', 'validating']);

/** The synthetic external-blocker ref that marks a lane-parked work-item. */
export function planLaneBlockerRef(planSlug: string, itemId: string): string {
  return `plan-lane:${planItemRef(planSlug, itemId)}`;
}

/**
 * Legacy durable parks predate typed release contracts, so the exact plan-lane
 * blocker history is the strongest provenance they carry. Keep this fallback
 * deliberately narrow: the reason must name this lane item and describe a
 * dependency, the park must have been created after this sync first gated the
 * lane, and owner/policy/manual-pause language always wins in favour of keeping
 * the park. Unattributed holds and coexisting hold-open leases are likewise not
 * ours to clear.
 *
 * EI-21649364699609566: WI-40822 was parked while P-068 required its hosted-auth
 * dependency, then P-068 became actionable and this sync cleared its exact
 * `plan-lane:` blocker while leaving `_claimHold:true`. Exact-plan admission
 * consequently undercounted the executable frontier. This predicate identifies
 * that dependency-only legacy shape without turning an actionable plan status
 * into authority to erase an independent durable disposition.
 */
const EXPLICIT_MANUAL_PARK_MARKER =
  /\b(?:owner(?:[-\s](?:directed|gated|walled|attended))?|manual(?:ly)?|paus(?:e|ed)|stand[-\s]?down|do\s+not|don't|never|forbid(?:s|den)?|prohibit(?:s|ed)?|explicit(?:ly)?|authori[sz]ation|approval|credential|physical[-\s]?device|human[-\s]?(?:action|decision)|security[-\s]?gate)\b/i;
const DEPENDENCY_PARK_MARKER = /\b(?:requires?|blocked|wait(?:ing)?|until|when|once|after|dependency|prerequisite|unpark)\b/i;

function containsExactToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'i').test(text);
}

export function isDependencyDerivedPlanLanePark(
  wi: Pick<WorkItem, 'payload'>,
  laneRef: string,
  laneItem: { planSlug: string; itemId: string },
): boolean {
  const provenance = readWorkItemClaimHoldProvenance(wi.payload);
  const park = provenance.parked;
  if (!park || provenance.heldOpen) return false;
  const reason = park.reason?.trim() ?? '';
  if (
    !reason ||
    looksLikePolicyGate(reason) ||
    EXPLICIT_MANUAL_PARK_MARKER.test(reason) ||
    !DEPENDENCY_PARK_MARKER.test(reason) ||
    (!containsExactToken(reason, laneItem.itemId) && !reason.includes(laneRef))
  ) {
    return false;
  }

  const parkedAt = park.at ? Date.parse(park.at) : Number.NaN;
  if (!Number.isFinite(parkedAt)) return false;
  return readExternalBlockers(wi.payload).some((blocker) => {
    if (
      blocker.kind !== PLAN_LANE_BLOCKER_KIND ||
      blocker.capability !== 'live-dependency' ||
      blocker.ref !== laneRef ||
      blocker.createdBy !== PLAN_LANE_SYNC_ACTOR
    ) {
      return false;
    }
    if (blocker.status === 'cleared' && blocker.clearedBy !== PLAN_LANE_SYNC_ACTOR) return false;
    const gatedAt = Date.parse(blocker.createdAt);
    return Number.isFinite(gatedAt) && gatedAt <= parkedAt;
  });
}

/**
 * EI-18653945816361859: lift a STALE plan-lane-sync hold from a work-item whose
 * plan item has just been confirmed terminal (done/dropped) — the exact `ungate`
 * mechanics `applyLaneGateToWorkItem` uses for an `actionable` lane, applied
 * inline ahead of a terminal transition rather than a lane re-sync. Clears BOTH
 * halves the gate leg can have stamped: the `plan-lane:` external blocker
 * (`updateExternalBlockerHistory`) and, when it is the holder, the
 * `held_open_by` lease (`setWorkItemClaimHold`'s `by` provenance) that would
 * otherwise trip `setWorkItemState`'s held-open guard ("HELD OPEN by
 * system:plan-item-lane-sync") and get silently swallowed by this reconciler's
 * per-item try/catch, leaving the work-item non-terminal forever. A no-op when
 * neither is present. Best-effort: never throws — the terminal transition
 * attempt that follows must run either way. */
async function clearStaleLaneHold(wi: WorkItem, laneRef: string): Promise<void> {
  try {
    const harness = wi.harness ?? undefined;
    const hasLaneBlocker = activeExternalBlockers(wi.payload).some(
      (b) => b.kind === PLAN_LANE_BLOCKER_KIND && b.ref === laneRef,
    );
    if (hasLaneBlocker) {
      const { blockers } = updateExternalBlockerHistory(
        wi.payload,
        { kind: PLAN_LANE_BLOCKER_KIND, ref: laneRef, clear: true },
        PLAN_LANE_SYNC_ACTOR,
      );
      await mergeWorkItemPayload(wi.id, { externalBlockers: blockers }, { harness });
    }
    const heldOpen = readWorkItemHeldOpenBy(wi.payload);
    if (heldOpen?.by === PLAN_LANE_SYNC_ACTOR) {
      await setWorkItemClaimHold(wi.id, false, {
        harness,
        by: PLAN_LANE_SYNC_ACTOR,
        leaseOnly: true,
        expectedLeaseHolder: PLAN_LANE_SYNC_ACTOR,
      });
    }
  } catch {
    // best-effort — the terminal transition attempt below still runs either way.
  }
}

/** The lane status a linked work-item is synced to. `blocked`/`needs-human` PARK
 *  it out of self-select; `actionable` UN-parks a lane-parked item. */
export type PlanLaneSyncStatus = 'blocked' | 'needs-human' | 'actionable';

/** Where a lane's prose asserted that its linked work-item is its own exit
 * condition. The source labels are intentionally narrow: they identify the
 * plan text that made the circularity visible, not a second dependency graph. */
export type CircularPrerequisiteSource = 'lane-item-text' | 'plan-now-next' | 'item-decision';

/**
 * A gated plan lane is about to park the work-item that the lane itself names
 * as its completion prerequisite. This is a finding rather than a lifecycle
 * action: parking it would manufacture a deadlock, so the caller must surface
 * the cycle and leave the work-item untouched.
 */
export interface CircularPrerequisiteFinding {
  kind: 'circular-prerequisite';
  planSlug: string;
  itemId: string;
  workItemId: string;
  sources: CircularPrerequisiteSource[];
}

/** The fresh plan projection needed by the pure circularity detector. */
export type CircularPrerequisitePlanRow = Pick<PlanRow, 'planSlug' | 'content' | 'items' | 'decisions' | 'nowNext'>;

function containsWorkItemId(text: unknown, workItemId: string): boolean {
  if (typeof text !== 'string' || !text || !workItemId.trim()) return false;
  const escaped = workItemId.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Work-item ids are token-like (WI-123, F-123, ...). Do not let WI-12
  // match WI-123, or an id embedded in a longer identifier, while allowing
  // normal markdown punctuation around the token.
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'i').test(text);
}

/**
 * Pure detector for the silent lane-sync deadlock (WI-131638).
 *
 * A linked work-item is circular only when the plan's own lane evidence names
 * that exact id: the lane item's text, the `## Now` next instruction, or a
 * decision explicitly scoped to the item. Unscoped decisions are deliberately
 * ignored so a plan-wide note cannot block an otherwise independent lane.
 */
export function detectCircularPrerequisite(
  row: CircularPrerequisitePlanRow,
  itemId: string,
  workItemId: string,
): CircularPrerequisiteFinding | null {
  const laneItem = planItemsForRow(row as PlanRow).find((item) => item.id === itemId);
  const sources: CircularPrerequisiteSource[] = [];

  if (containsWorkItemId(laneItem?.text, workItemId)) sources.push('lane-item-text');
  if (containsWorkItemId(row.nowNext, workItemId)) sources.push('plan-now-next');

  const decisionRefs = new Set(laneItem?.decisionRefs ?? []);
  for (const decision of row.decisions ?? []) {
    if (!decision.itemRefs?.includes(itemId) && !decisionRefs.has(decision.id)) continue;
    if (containsWorkItemId(decision.title, workItemId) || containsWorkItemId(decision.body, workItemId)) {
      sources.push('item-decision');
      break;
    }
  }

  if (sources.length === 0) return null;
  return {
    kind: 'circular-prerequisite',
    planSlug: row.planSlug,
    itemId,
    workItemId,
    sources,
  };
}

export type LaneGateOp =
  | { op: 'gate'; capability: ExternalBlockerCapability }
  /** `via` says WHICH un-park this is: the normal one (our blocker is still active),
   *  or the WI-37914 repair of a park whose blocker was cleared without its state
   *  being restored — the two differ only in whether a blocker write is still owed. */
  | { op: 'ungate'; via: 'active-lane-blocker' | 'stale-park-repair' }
  /** Plan truth says actionable while the work-item still carries a direct or
   *  legacy needs-human park. Clear only the human portion and recompute state
   *  from the blockers that remain. */
  | { op: 'repair-needs-human' }
  | { op: 'noop'; reason: 'terminal' | 'in-flight' | 'already-gated' | 'no-lane-blocker' };

function hasNeedsHumanResidue(wi: Pick<WorkItem, 'state' | 'payload'>): boolean {
  const payload =
    wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
      ? (wi.payload as Record<string, unknown>)
      : {};
  // EI-21274031426739947: a blocker naming a capability NO amount of plan truth or
  // agent authority can supply (credential / physical-device / external-service-action
  // / product-decision — the capabilities the policy marks `requiresOwnerCapability`) is
  // not owner-park RESIDUE, it is an unsatisfied PREREQUISITE. Plan status cannot
  // testify about it: whether the owner has spoken into a microphone is simply not a
  // fact a plan item knows. Clearing one fabricates readiness, and the row goes
  // straight back into the claim pool for an agent that structurally cannot do it
  // (measured: WI-1439's owner-at-mic acceptance was cleared at 19:31Z with no accept/
  // reject evidence and re-claimed at 19:37Z, then repeatedly, burning a fresh agent's
  // context each time). Only `approval-auto-clearable` is genuine repairable residue —
  // exactly the split external-blockers.ts already draws, reused here rather than
  // re-listed, so a new capability cannot silently land on the clearable side.
  if (activeExternalBlockers(wi.payload).some(requiresOwnerCapability)) return false;
  return (
    wi.state.trim().toLowerCase() === 'needs-human' ||
    payload.needsOwnerAction === true ||
    payload.needsHuman === true ||
    activeExternalBlockers(wi.payload).some((blocker) => blocker.kind === 'human')
  );
}

/**
 * Does this blocker name a capability the lane sync can never satisfy on its own?
 * Reads the SAME policy table `work_items:set_blocker` uses; an untyped legacy row
 * falls back to `inferExternalBlockerCapability` so it is classified, never assumed
 * clearable. Exported for the unit test.
 */
export function requiresOwnerCapability(blocker: ExternalBlockerRecord): boolean {
  const capability = blocker.capability ?? inferExternalBlockerCapability(blocker.kind);
  // `requiresOwnerCapability`, NOT `!autoClearable` — they are different questions and
  // 'live-dependency' is exactly where they diverge (autoClearable:false, but
  // requiresOwnerCapability:false, because a stalled dependency is owned by the
  // dependency-owner, not a person holding a device). Keying on !autoClearable made an
  // ordinary runtime blocker suppress a legitimate owner-park repair — caught by the
  // pre-existing 'independent nonhuman blocker' case. The four capabilities this must
  // protect (credential, physical-device, external-service-action, product-decision)
  // are precisely the ones the policy marks requiresOwnerCapability:true.
  return externalBlockerCapabilityPolicy(capability).requiresOwnerCapability;
}

/**
 * WI-37914: the state an un-parked work-item is restored TO — pure, so the
 * "never silently reopen claimed work" invariant is testable without PG.
 *
 * Prefers the state stashed at park time; falls back to the family's claimable
 * default (`todo` for a feature, `open` for an issue) when there is nothing usable
 * to restore — which is also the path every item parked BEFORE this fix takes,
 * since none of them carry a stash.
 *
 * An in-progress stash (`wip`/`validating`) is only honoured while an assignee is
 * still on the row: the holder can be reaped while the item sits parked, and
 * restoring `wip` with nobody on it recreates the orphaned-claim state the stale-
 * claim reaper then has to clean up again.
 */
export function restoreStateAfterUngate(wi: Pick<WorkItem, 'state' | 'family' | 'payload' | 'assignee'>): string {
  const fallback = wi.family === 'feature' ? 'todo' : 'open';
  const parkedFrom = readPlanLaneParkedFrom(wi.payload);
  if (!parkedFrom) return fallback;
  const normalized = parkedFrom.toLowerCase();
  // Never restore INTO a gated or settled state — that is the park we are lifting.
  if (normalized === 'blocked' || normalized === 'needs-human' || isSettledWorkItemState(parkedFrom)) return fallback;
  if (IN_PROGRESS_WORK_ITEM_STATES.has(normalized) && !wi.assignee) return fallback;
  return parkedFrom;
}

/**
 * PURE decision (no I/O): what the lane sync should do to ONE linked work-item,
 * given its current state and the plan lane's status. Kept apart from the PG
 * effect below so the invariant is unit-testable without the lock/PG path
 * (mirrors set-status.ts's releaseTerminalGrips / releaseTodoClaim shape):
 *  - a settled work-item is never touched (its work is done/abandoned);
 *  - GATE never clobbers genuinely-active work (a live `assignee` — keyed on the
 *    CURRENT HOLDER ALONE per EI-20405552992224051, because a freshly-reopened and
 *    re-claimed item has no `lastProgressAt` yet; and WI-6303: a bare
 *    `lastProgressAt` can be a stale stamp left behind by a dead/orphaned-claim
 *    reclaim path that never cleared it, not real in-flight work — see
 *    reconcileLinkedWorkItemsForPlanItem's identical guard for the full
 *    root-cause writeup) and is idempotent (a re-gate of an already lane-parked
 *    item is a no-op);
 *  - UN-GATE only lifts a park THIS sync created (the `plan-lane:` blocker is
 *    present), so an item blocked for any other reason is left alone.
 */
export function decideLaneGate(
  wi: Pick<WorkItem, 'state' | 'lastProgressAt' | 'payload' | 'assignee'>,
  laneStatus: PlanLaneSyncStatus,
  laneRef: string,
): LaneGateOp {
  if (isSettledWorkItemState(wi.state)) return { op: 'noop', reason: 'terminal' };
  const hasLaneBlocker = activeExternalBlockers(wi.payload).some(
    (b) => b.kind === PLAN_LANE_BLOCKER_KIND && b.ref === laneRef,
  );
  if (laneStatus === 'actionable') {
    if (hasNeedsHumanResidue(wi)) return { op: 'repair-needs-human' };
    if (hasLaneBlocker) return { op: 'ungate', via: 'active-lane-blocker' };
    // WI-37914 REPAIR PATH. The un-park used to clear the blocker and stop there,
    // leaving `state:'blocked'` behind — and because the check above keys on an
    // ACTIVE blocker, the very next sweep read the item as "not parked by us" and
    // walked past it. The contradiction was therefore permanent: every claim spec
    // filters `states:['open']`, so the item was invisible to `work_items:claimable`
    // and `scheduler:get_next` while the plan reported it unblocked, and a whole
    // fleet sat idle beside work it could not see (measured live on
    // hud-chat-release-audit, 3 members, 2026-08-11).
    //
    // Heal it from the CLEARED history rather than from `state` alone: a `blocked`
    // row whose plan-lane blocker WE cleared, with no other active blocker left, is
    // a park we failed to lift. An item blocked for any other reason still has no
    // cleared lane record of ours and is left alone — the same provenance rule the
    // active path uses, read one status over.
    const ourClearedPark = readExternalBlockers(wi.payload).some(
      (b) =>
        b.kind === PLAN_LANE_BLOCKER_KIND &&
        b.ref === laneRef &&
        b.status === 'cleared' &&
        b.clearedBy === PLAN_LANE_SYNC_ACTOR,
    );
    const stranded = wi.state.trim().toLowerCase() === 'blocked' && ourClearedPark;
    if (stranded && activeExternalBlockers(wi.payload).length === 0) {
      return { op: 'ungate', via: 'stale-park-repair' };
    }
    return { op: 'noop', reason: 'no-lane-blocker' };
  }
  // Gate intent (blocked / needs-human).
  // EI-20405552992224051: the CURRENT HOLDER alone — deliberately the SAME predicate,
  // for the same reason, as reconcileLinkedWorkItemsForPlanItem's in-flight guard above
  // (this function's doc cross-references it as "identical", so the two must not drift).
  // Parking an item a live agent has just claimed yanks it out of the claim pool from
  // under its holder, and a just-claimed item has no `lastProgressAt` to show yet.
  if (wi.assignee) return { op: 'noop', reason: 'in-flight' };
  if (hasLaneBlocker) return { op: 'noop', reason: 'already-gated' };
  return {
    op: 'gate',
    capability: laneStatus === 'needs-human' ? 'product-decision' : 'live-dependency',
  };
}

type LaneGateAction =
  | 'gated'
  | 'ungated'
  | 'skipped-in-flight'
  | 'skipped-terminal'
  | 'noop'
  | { failure: string };

function laneSyncFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000) || 'unknown_error';
}

/** Direct-execution contract stamped by canonical plan-run promotion, if this
 * unassigned row belongs to one. Kept on the shared payload reader so settle
 * and lane-sync cannot disagree about what counts as agentic execution. */
async function agenticExecutionForUngate(wi: WorkItem): Promise<AgenticPlanExecutionTarget | null> {
  if (wi.assignee) return null;
  const { planRunExecutionTarget } = await import('../work-items-events');
  return planRunExecutionTarget(wi.payload);
}

/**
 * Complete the dispatch-first half of an agentic lane restore. The lifecycle
 * writer has already restored the item with its broad claimable co-fire
 * suppressed; this shared composite now atomically claims the stable name and
 * issues the durable required wake. `wakeRetained:false` makes a concurrent
 * settle-path winner idempotent without spending a duplicate wake.
 */
async function dispatchUngatedAgenticWorkItem(
  wi: WorkItem,
  execution: AgenticPlanExecutionTarget | null,
  laneItem: { planSlug: string; itemId: string },
): Promise<void> {
  if (!execution) return;
  try {
    const { assignAndWakeActionableWorkItems } =
      await import('../agent-tools/coordination/actionable-work-item-dispatch');
    const dispatched = await assignAndWakeActionableWorkItems({
      workItemIds: [wi.id],
      targetAgent: execution.agentName,
      harness: execution.appHarnessSlug,
      summary: `${wi.id} became actionable when ${laneItem.planSlug}#${laneItem.itemId} cleared`,
      source: 'system:plan-run-lane-dispatch',
      wakeRetained: false,
    });
    if (!dispatched.ok) {
      console.warn(
        `[plan-lane-sync] stable successor dispatch for ${wi.id} failed: ` +
          `${dispatched.failure?.message ?? dispatched.warning ?? 'assignment failed'}`,
      );
    }
  } catch (error) {
    console.warn(
      `[plan-lane-sync] stable successor dispatch for ${wi.id} threw: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Apply the pure decision to ONE work-item via the work-item lifecycle surface,
 *  reusing the exact park/restore mechanics of work_items:set_blocker. Never
 *  throws — a per-item lifecycle hiccup is caught and reported as a plain 'noop'. */
async function applyLaneGateToWorkItem(
  wi: WorkItem,
  laneStatus: PlanLaneSyncStatus,
  laneRef: string,
  laneItem: { planSlug: string; itemId: string },
): Promise<LaneGateAction> {
  const decision = decideLaneGate(wi, laneStatus, laneRef);
  if (decision.op === 'noop') {
    return decision.reason === 'terminal'
      ? 'skipped-terminal'
      : decision.reason === 'in-flight'
        ? 'skipped-in-flight'
        : 'noop';
  }
  const harness = wi.harness ?? undefined;
  try {
    if (decision.op === 'gate') {
      const summary = `plan lane ${laneItem.planSlug}#${laneItem.itemId} is ${
        laneStatus === 'needs-human' ? 'awaiting a human decision' : 'blocked'
      } — linked work-item parked until the lane clears (${PLAN_LANE_SYNC_ACTOR})`;
      const { blockers } = updateExternalBlockerHistory(
        wi.payload,
        { kind: PLAN_LANE_BLOCKER_KIND, capability: decision.capability, ref: laneRef, summary },
        PLAN_LANE_SYNC_ACTOR,
      );
      // WI-37914: stash the pre-park state IN THE SAME merge as the blocker record, so
      // the un-park can restore what was actually here. Both families store `blocked`
      // natively post-unify (work-item-status-full-unify P-003) — the issue family ALSO
      // picks up setWorkItemStateWithAliasInfo's auto claim-hold, so the un-park owes a
      // state restore AND a hold release, not just the hold.
      await mergeWorkItemPayload(
        wi.id,
        { externalBlockers: blockers, [PLAN_LANE_PARKED_FROM_KEY]: wi.state },
        { harness },
      );
      await setWorkItemStateWithAliasInfo(wi.id, 'blocked', { harness, by: PLAN_LANE_SYNC_ACTOR });
      return 'gated';
    }
    if (decision.op === 'repair-needs-human') {
      // Clear ONLY active human blockers, and among those only the ones whose
      // capability is auto-clearable. Runtime/gate/event blockers remain intact, so
      // plan truth repairs the false owner park without fabricating readiness for
      // independently blocked work.
      //
      // EI-21274031426739947: the capability filter is the second half of that same
      // rule and is defence in depth — `hasNeedsHumanResidue` should already have
      // refused to route a genuinely owner-gated item here, so if this loop is ever
      // reached with a credential / physical-device / external-service-action /
      // product-decision blocker present, the prerequisite still survives instead of
      // being erased on the way past.
      let blockers = readExternalBlockers(wi.payload);
      for (const blocker of blockers.filter(
        (row) => row.status === 'active' && row.kind === 'human' && !requiresOwnerCapability(row),
      )) {
        blockers = updateExternalBlockerHistory(
          { externalBlockers: blockers },
          { kind: 'human', ref: blocker.ref, clear: true },
          PLAN_LANE_SYNC_ACTOR,
        ).blockers;
      }
      const stillActive = blockers.filter((blocker) => blocker.status === 'active');
      await mergeWorkItemPayload(
        wi.id,
        { externalBlockers: blockers },
        { harness, unset: ['needsOwnerAction', 'needsHuman'] },
      );
      const restored = stillActive.length > 0 ? 'blocked' : wi.family === 'feature' ? 'todo' : 'open';
      const execution = stillActive.length === 0 ? await agenticExecutionForUngate(wi) : null;
      await setWorkItemStateWithAliasInfo(wi.id, restored, {
        harness,
        by: PLAN_LANE_SYNC_ACTOR,
        announceClaimable: execution ? false : undefined,
      });
      if (stillActive.length === 0) await dispatchUngatedAgenticWorkItem(wi, execution, laneItem);
      return stillActive.length > 0 ? 'gated' : 'ungated';
    }
    // Un-gate: clear OUR lane blocker; restore to claimable ONLY when no OTHER
    // active blocker remains (the exact rule work_items:set_blocker uses, so an
    // independently-blocked item stays parked).
    const { blockers, changed } = updateExternalBlockerHistory(
      wi.payload,
      { kind: PLAN_LANE_BLOCKER_KIND, ref: laneRef, clear: true },
      PLAN_LANE_SYNC_ACTOR,
    );
    // On the WI-37914 repair path the blocker is ALREADY cleared, so this is a no-op
    // clear (changed:false) and the only thing still owed is the state restore below.
    const stillActive = blockers.filter((b) => b.status === 'active');
    if (stillActive.length === 0) {
      // EI-20268159828040355: prepare BOTH lifecycle halves before clearing the
      // blocker history. If state/hold restoration is rejected by a concurrent
      // lifecycle guard, leaving the plan-lane blocker active makes the next sweep
      // retry the whole operation. Clearing the blocker first creates a partial
      // write (`blocked` + no active blocker) that the normal actionable decision
      // cannot reliably rediscover.
      //
      // WI-37914: BOTH halves of the park have to come off. Clearing the claim hold
      // alone left `state:'blocked'` behind, and every fleet claim spec filters
      // `states:['open']` — so the item read as unblocked on the plan while staying
      // structurally invisible to `scheduler:get_next`, stranding the lane.
      const restored = restoreStateAfterUngate(wi);
      const claimHold = readWorkItemClaimHoldProvenance(wi.payload);
      const clearDependencyPark = isDependencyDerivedPlanLanePark(wi, laneRef, laneItem);
      const clearsSystemLease = claimHold.heldOpen?.by === PLAN_LANE_SYNC_ACTOR;
      const remainsClaimHeld =
        isClaimHoldParked(wi.payload) &&
        (!claimHold.attributed ||
          Boolean(claimHold.parked && !clearDependencyPark) ||
          Boolean(claimHold.heldOpen && !clearsSystemLease));
      const execution = remainsClaimHeld ? null : await agenticExecutionForUngate(wi);
      await setWorkItemStateWithAliasInfo(wi.id, restored, {
        harness,
        by: PLAN_LANE_SYNC_ACTOR,
        announceClaimable: execution || remainsClaimHeld ? false : undefined,
      });
      // The issue-family blocked alias creates a liveness-bound lease. Clear
      // that lease only, so a coexisting durable park survives. A feature row
      // has no alias lease; its legacy dependency-only durable park is cleared
      // solely when the predicate above proves exact plan-lane provenance.
      if (clearsSystemLease) {
        await setWorkItemClaimHold(wi.id, false, {
          harness,
          by: PLAN_LANE_SYNC_ACTOR,
          leaseOnly: true,
          expectedLeaseHolder: PLAN_LANE_SYNC_ACTOR,
          reason: `plan lane ${laneItem.planSlug}#${laneItem.itemId} cleared`,
        });
      }
      if (clearDependencyPark) {
        await setWorkItemClaimHold(wi.id, false, {
          harness,
          parkedBy: PLAN_LANE_SYNC_ACTOR,
          parkedReason: `dependency-derived plan lane ${laneItem.planSlug}#${laneItem.itemId} cleared`,
        });
      }
      // Clear the blocker only after the lifecycle restore succeeds. On the repair
      // path `changed` is false because the history already records our clear.
      if (changed) await mergeWorkItemPayload(wi.id, { externalBlockers: blockers }, { harness });
      // Drop the stash — it describes a park that no longer exists, and leaving it
      // would let a LATER un-park restore a state from the wrong era.
      await mergeWorkItemPayload(wi.id, { [PLAN_LANE_PARKED_FROM_KEY]: null }, { harness });
      await dispatchUngatedAgenticWorkItem(wi, execution, laneItem);
    }
    return 'ungated';
  } catch (error) {
    // Keep the sweep fail-soft, but let its caller distinguish a failed write from
    // an intentional no-op decision. The caller records and warns on this result.
    return { failure: laneSyncFailureMessage(error) };
  }
}

export interface PlanLaneSyncFailure {
  stage: 'linked-work-item-read' | 'apply-gate';
  workItemId?: string;
  message: string;
}

export interface PlanLaneSyncResult {
  /** Work-item ids PARKED out of self-select (a blocked/needs-human lane). */
  gated: string[];
  /** Work-item ids RESTORED to claimable (the lane became actionable). */
  ungated: string[];
  /** Linked but carrying independent in-flight progress — left alone (gate only). */
  skippedInFlight: string[];
  /** Linked but already terminal — nothing to do. */
  skippedAlreadyTerminal: string[];
  /**
   * D-046: non-terminal linked rows that are NOT the canonical lane row (see
   * {@link selectCanonicalLinkedWorkItem}) — NEVER mutated by the lane sync, only
   * reported, so a stale duplicate mint can no longer be reopened/re-parked in
   * lockstep with the canonical row.
   */
  skippedDuplicates: string[];
  /** Gated lanes whose linked canonical row was named as their own prerequisite. */
  circularPrerequisites: CircularPrerequisiteFinding[];
  /** Fail-soft sync errors that used to disappear as empty arrays or `noop`. */
  failures?: PlanLaneSyncFailure[];
}

/**
 * Sync every work-item linked to ONE plan item to the plan lane's current gated
 * status (blocked / needs-human → park; actionable → un-park). Reuses BOTH truth
 * sources findAllLinkedWorkItems reads (the `implements` edge + the payload stamp)
 * and is fully fail-safe per item — never throws.
 */
export async function syncLinkedWorkItemsToPlanLane(
  item: CompletedPlanItem,
  laneStatus: PlanLaneSyncStatus,
  /** Fresh plan projection, when available. Required for cycle detection; the
   * legacy mint-time caller may omit it and the periodic/inline callers pass it. */
  planRow?: CircularPrerequisitePlanRow | null,
): Promise<PlanLaneSyncResult> {
  const out: PlanLaneSyncResult = {
    gated: [],
    ungated: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedDuplicates: [],
    circularPrerequisites: [],
  };
  const recordFailure = (failure: PlanLaneSyncFailure) => {
    (out.failures ??= []).push(failure);
    console.warn(
      `[plan-lane-sync] ${JSON.stringify({
        event: 'plan_lane_sync_failure',
        planSlug: item.planSlug,
        itemId: item.itemId,
        ...failure,
      })}`,
    );
  };
  try {
    const laneRef = planLaneBlockerRef(item.planSlug, item.itemId);
    const linked = await findAllLinkedWorkItems(item.planSlug, item.itemId);
    // D-046: elect ONE canonical row; the sync mutates it alone. Terminal rows keep
    // reporting as skippedAlreadyTerminal; every other non-terminal row is a duplicate.
    const { canonical } = selectCanonicalLinkedWorkItem(linked);
    for (const wi of linked) {
      if (isSettledWorkItemState(wi.state)) {
        out.skippedAlreadyTerminal.push(wi.id);
        continue;
      }
      if (wi !== canonical) {
        out.skippedDuplicates.push(wi.id);
        continue;
      }
      if (laneStatus !== 'actionable' && planRow) {
        const finding = detectCircularPrerequisite(planRow, item.itemId, wi.id);
        if (finding) {
          out.circularPrerequisites.push(finding);
          continue;
        }
      }
      let action: LaneGateAction;
      try {
        action = await applyLaneGateToWorkItem(wi, laneStatus, laneRef, {
          planSlug: item.planSlug,
          itemId: item.itemId,
        });
      } catch (error) {
        // An unexpected throw still remains isolated to this linked row.
        recordFailure({ stage: 'apply-gate', workItemId: wi.id, message: laneSyncFailureMessage(error) });
        continue;
      }
      if (typeof action !== 'string') {
        recordFailure({ stage: 'apply-gate', workItemId: wi.id, message: action.failure });
        continue;
      }
      if (action === 'gated') out.gated.push(wi.id);
      else if (action === 'ungated') out.ungated.push(wi.id);
      else if (action === 'skipped-in-flight') out.skippedInFlight.push(wi.id);
      else if (action === 'skipped-terminal') out.skippedAlreadyTerminal.push(wi.id);
    }
  } catch (error) {
    // A lookup-level DB hiccup remains best-effort, but is no longer invisible.
    recordFailure({ stage: 'linked-work-item-read', message: laneSyncFailureMessage(error) });
  }
  return out;
}

/**
 * Classify a plan item's CURRENT effective lane (blocked-by graph aware) the same
 * way scheduler/plan-item-lane-guard.ts does — so a plan item that is effectively
 * blocked by an unresolved dependency (its OWN stored status still `todo`) is
 * caught too, not just an explicit `blocked` flip. Returns null when the plan
 * row / item can't be resolved (fail-closed → the caller skips the lane sync).
 */
function classifyPlanLane(row: Awaited<ReturnType<typeof getPlanRow>>, itemId: string): PlanLaneSyncStatus | null {
  if (!row) return null;
  const { items } = resolveEffectiveStatusForItems(planItemsForRow(row));
  const it = items.find((i) => i.id === itemId);
  if (!it) return null;
  if (it.effectiveStatus === 'blocked') return 'blocked';
  if (it.needsHuman) return 'needs-human';
  return 'actionable';
}

/**
 * EI-18732669095544832: resync ONE plan item's lane status onto its linked
 * work-items RIGHT NOW — the inline counterpart to the periodic orphan sweep's
 * non-terminal leg above (EI-14699). Before this, the ONLY thing that ever ran
 * `syncLinkedWorkItemsToPlanLane` for a non-terminal item was the 15-minute
 * `plan-item-orphan-reconcile` cron sweep — so a tool call that changes an item's
 * EFFECTIVE lane WITHOUT going through `plans:set-status` itself (chiefly
 * `plans:set-item-blocked-by` adding/clearing a `blocked-by` edge) reported
 * `ok:true` while the linked work-item silently stayed parked/unparked for up to
 * 15 minutes — indistinguishable from a no-op to the caller (`plan-item-lane-
 * sync:blocked-by-changed` in `lane-sync-rule.ts` fires this off exactly that
 * tool, the same reaction-rule pattern `reconcile-rule.ts` uses for the terminal
 * leg — see that file's header for why this is a rule, not a hardcoded call
 * inside `plans/set-item-blocked-by.ts`).
 *
 * Re-reads the plan row FRESH (never trusts a caller-supplied snapshot) and
 * classifies the item's CURRENT effective lane the same blocked-by-graph-aware
 * way the periodic sweep does — so this is correct even when several edges
 * changed since the triggering call. Fail-closed + never throws: a plan/item
 * that can't be resolved, or a lane-classify hiccup, is a silent no-op — the
 * periodic sweep remains the backstop for anything this misses.
 */
export async function resyncPlanItemLaneNow(
  planSlug: string,
  itemId: string,
  harnessSlug?: string | null,
): Promise<PlanLaneSyncResult | null> {
  try {
    const row = await getPlanRow(planSlug, { harnessSlug: harnessSlug ?? undefined }).catch(() => null);
    if (!row) return null;
    const laneStatus = classifyPlanLane(row, itemId);
    if (!laneStatus) return null;
    const result = await syncLinkedWorkItemsToPlanLane(
      { planSlug, itemId, harnessSlug: harnessSlug ?? null },
      laneStatus,
      row,
    );
    // D-049/D-050: the SAME reaction that resyncs the lane also reconciles the promoted
    // dependency graph — before this, plans:set-item-blocked-by updated the plan + lane
    // but left stale work_item_deps/coord_links edges behind (live: the scheduler kept
    // WI-40473 blocked on removed P-018/WI-40472 while plans:items reported it
    // actionable). Best-effort: a dependency-reconcile hiccup must never break the lane
    // sync that already succeeded.
    await reconcilePlanAuthoredDependenciesNow(planSlug, itemId, harnessSlug).catch(() => null);
    return result;
  } catch {
    return null;
  }
}

// ── D-050: plan-authored dependency reconciliation on the canonical promoted row ─────
//
// `plans:set-item-blocked-by` rewrites a plan item's `blockedBy` and (via the
// plan-item.resyncLane reaction) resyncs the LANE — but the promoted dependency GRAPH
// (coord_links `blocks` edges + the work_item_deps mirror) was never reconciled, so
// REMOVED plan edges survived as stale scheduler gates (D-049's live evidence). The
// reconciliation below replaces ONLY the plan-authored edge subset on the canonical row:
//
//   desired = (live blockers MINUS the prior plan-authored marker set)
//             UNION the plan's CURRENT resolved blockers
//
// so removed plan edges disappear while unrelated agent-authored blockers survive. The
// marker (`_planAuthoredBlockers` on the canonical row's payload) records the EXACT
// blocker work-item ids last authored from this plan item; a markerless legacy row seeds
// conservatively — every live edge is treated as unrelated (preserved), and only
// additions happen until the first marker write.

/** D-050: the payload key holding the last plan-authored blocker set on a canonical row. */
export const PLAN_AUTHORED_BLOCKERS_KEY = '_planAuthoredBlockers';

/** The prior plan-authored blocker ids — ONLY when the marker's identity matches THIS
 *  plan item (a marker written by a different plan/item must not license deletions
 *  here). Null = no usable marker → conservative seed. Defensive: payload is federated
 *  JSON. */
export function readPlanAuthoredBlockers(payload: unknown, planSlug: string, itemId: string): string[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)[PLAN_AUTHORED_BLOCKERS_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (m.planSlug !== planSlug || m.itemId !== itemId) return null;
  if (!Array.isArray(m.blockerWorkItemIds)) return null;
  return m.blockerWorkItemIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * D-050 pure core: the next full blocker set for the canonical promoted row.
 * `(live MINUS priorPlanAuthored) UNION currentResolved` — deletions are licensed only
 * for edges the marker proves THIS plan item authored; a null marker deletes nothing.
 * Pure — unit-testable without PG.
 */
export function computePlanAuthoredDependencySet(args: {
  liveBlockerIds: readonly string[];
  priorPlanAuthoredIds: readonly string[] | null;
  currentResolvedPlanBlockerIds: readonly string[];
}): string[] {
  const prior = new Set(args.priorPlanAuthoredIds ?? []);
  const unrelated = args.liveBlockerIds.filter((id) => !prior.has(id));
  return [...new Set([...unrelated, ...args.currentResolvedPlanBlockerIds])];
}

export interface PlanDependencyReconcileResult {
  /** The canonical promoted row whose edges were reconciled. */
  canonicalId: string;
  /** The full blocker set written through syncFeatureBlockEdges. */
  desired: string[];
  /** The plan's current blockers as resolved canonical work-item ids (the new marker). */
  resolved: string[];
}

/**
 * Reconcile ONE plan item's promoted dependency edges onto its canonical linked
 * work-item, per D-050. Fresh-reads the plan (never trusts a caller snapshot), resolves
 * each still-open `blockedBy` plan item to ITS canonical linked feature-family row, and
 * writes only the prior owned subset through `syncFeatureBlockEdges` and canonical
 * work_item_deps admission — even when the set is EMPTY, so removed plan
 * edges actually clear. The `_planAuthoredBlockers` marker is written ONLY after the
 * edge sync succeeds (a failed sync must not advance provenance). Null = nothing to do
 * (no plan/item, no canonical feature-family row) or the edge sync was refused (cycle) —
 * fail-soft by design, mirroring every other sweep in this module.
 */
export async function reconcilePlanAuthoredDependenciesNow(
  planSlug: string,
  itemId: string,
  harnessSlug?: string | null,
): Promise<PlanDependencyReconcileResult | null> {
  try {
    const row = await getPlanRow(planSlug, { harnessSlug: harnessSlug ?? undefined }).catch(() => null);
    if (!row) return null;
    const items = planItemsForRow(row);
    const item = items.find((i) => i.id === itemId);
    if (!item) return null;

    // The canonical promoted row for THIS lane. Only feature-family rows participate:
    // The reader is feature-only, but the canonical writer knows every endpoint family.
    // Pass the prior owned subset below rather than replacing all of the target's edges.
    const { canonical } = selectCanonicalLinkedWorkItem(await findAllLinkedWorkItems(planSlug, itemId));
    if (!canonical || canonical.family !== 'feature' || !canonical.harness) return null;
    const harness = canonical.harness;

    // Resolve each CURRENT still-open blocker plan item to its canonical linked
    // feature-family row in the SAME harness. A done/dropped blocker is satisfied, not
    // missing (promotion's own rule); an unresolvable one contributes no edge — never a
    // guess.
    const statusById = new Map(items.map((i) => [i.id, i.storedStatus as string | null]));
    const resolved: string[] = [];
    for (const blockerItemId of item.blockedBy ?? []) {
      const st = statusById.get(blockerItemId);
      if (st === 'done' || st === 'dropped' || st === undefined) continue;
      const blockerCanonical = selectCanonicalLinkedWorkItem(
        await findAllLinkedWorkItems(planSlug, blockerItemId),
      ).canonical;
      if (!blockerCanonical || blockerCanonical.family !== 'feature') continue;
      if ((blockerCanonical.harness ?? null) !== harness) continue;
      if (blockerCanonical.id === canonical.id) continue;
      resolved.push(blockerCanonical.id);
    }

    const live = (await getFeatureBlockers(harness)).get(canonical.id) ?? [];
    const prior = readPlanAuthoredBlockers(canonical.payload, planSlug, itemId);
    const desired = computePlanAuthoredDependencySet({
      liveBlockerIds: live,
      priorPlanAuthoredIds: prior,
      currentResolvedPlanBlockerIds: resolved,
    });

    // Write even an EMPTY set — that is exactly how a removed plan edge clears. A cycle
    // refusal (syncFeatureBlockEdges throws) aborts BEFORE the marker write below, so a
    // refused sync never advances provenance.
    // No marker (prior === null) means this sync owns NO edges yet, so it removes none: pass
    // [] (add-only), never undefined, which would fall back to the full-replace contract and
    // drop blocker edges outside `live` (other families / harnesses) that this plan never wrote.
    await syncFeatureBlockEdges(harness, canonical.id, desired, { priorBlockerIds: prior ?? [] });
    await mergeWorkItemPayload(
      canonical.id,
      { [PLAN_AUTHORED_BLOCKERS_KEY]: { planSlug, itemId, blockerWorkItemIds: resolved } },
      { harness },
    );
    return { canonicalId: canonical.id, desired, resolved };
  } catch {
    return null;
  }
}

/**
 * EI-21018197537550703: resync every plan item whose `blockedBy` names one
 * dependency whose terminality just changed. The dependency edge itself is
 * intentionally left untouched; each dependent is re-classified from the
 * CURRENT plan graph by {@link resyncPlanItemLaneNow}, so another unresolved
 * blocker keeps the lane parked while the last resolved blocker opens it.
 *
 * This is the dependency-target mode behind the existing
 * `plan-item.resyncLane` builtin action. It reuses the canonical per-item writer
 * instead of introducing a second lane mutation path. Fail-closed + never
 * throws; the periodic orphan sweep remains the backstop.
 */
export async function resyncDependentPlanItemLanesNow(
  planSlug: string,
  dependencyItemId: string,
  harnessSlug?: string | null,
): Promise<string[]> {
  try {
    const row = await getPlanRow(planSlug, { harnessSlug: harnessSlug ?? undefined }).catch(() => null);
    if (!row) return [];
    const dependentItemIds = planItemsForRow(row)
      .filter((item) => item.blockedBy.includes(dependencyItemId))
      .map((item) => item.id);
    for (const itemId of dependentItemIds) {
      await resyncPlanItemLaneNow(planSlug, itemId, harnessSlug).catch(() => null);
    }
    return dependentItemIds;
  } catch {
    return [];
  }
}

interface OrphanCandidate {
  planSlug: string;
  itemId: string;
  harnessSlug: string | null;
}

export interface OrphanReconcileSweepResult {
  /** Distinct (plan_slug, item_id) pairs enumerated from non-terminal, stamped
   *  work-items — the candidate frontier before the terminal-status check. */
  candidatePlanItems: number;
  /** WI-10004586: true when the candidate query hit its `candidateCap`, so
   *  `candidatePlanItems` (and every count derived from the window) is a FLOOR
   *  over a bounded fetch, not the population total. */
  candidateWindowSaturated: boolean;
  /** Of those candidates, how many were CONFIRMED terminal (done/dropped) and
   *  therefore actually swept. */
  terminalPlanItems: number;
  /** Work-item ids terminalized by this sweep. */
  reconciled: string[];
  /** EI-14699: work-item ids PARKED out of self-select because their plan lane is
   *  blocked/needs-human (the reverse-mirror gate). */
  gated: string[];
  /** EI-14699: work-item ids RESTORED to claimable because their plan lane became
   *  actionable again (the reverse-mirror un-gate). */
  ungated: string[];
  /** Linked but carrying independent in-flight progress — left alone. */
  skippedInFlight: string[];
  /** Linked but already terminal — nothing to do. */
  skippedAlreadyTerminal: string[];
  /**
   * EI-19460536530145188: issue-family work-items left OPEN because only the
   * `payload.plan_item` stamp linked them to the completed plan item — no
   * `implements` edge, so nothing asserts they implement it. Surfaced here (not
   * merely omitted from `reconciled`) so the sweep's own report says what it
   * declined to close: a skip that is invisible is the same silence this guard
   * exists to end.
   */
  skippedUnprovenLink: string[];
  /**
   * WI-39498: the zombie-contradiction census — OPEN (non-settled) work-items whose
   * linked plan item is already terminal AND whose plan-item text names the work-item
   * id with a completion annotation ("← WI-NNN completed (done)"). These are exactly
   * the rows the unproven-link guard above deliberately leaves open for a human/agent
   * judgement — measured at 77 with one row burning 9 successive agents, because
   * nothing surfaced the contradiction. The per-row surfacing is the claim-time
   * planItemContradictionWarning (work-item-plan-contradiction.ts); THIS count is the
   * aggregate detector, re-measured every sweep tick so the population's size — and
   * any regrowth — is machine-readable instead of silent. -1 = the census read failed
   * (never conflate an unmeasured population with an empty one).
   */
  planSaysDoneOpen: number;
  /** Gated lanes whose linked canonical row was named as their own prerequisite. */
  circularPrerequisites: CircularPrerequisiteFinding[];
}

/** Default per-tick candidate cap — a generous bound (orphan residue is bursty at
 *  worst; a healthy fleet clears it in a few ticks). Overridable via the routine's
 *  trigger_config `candidate_cap`. */
export const DEFAULT_ORPHAN_SWEEP_CAP = 500;

/**
 * The PERIODIC data-heal (EI-14693). `reconcileLinkedWorkItemsForPlanItem` only
 * ever runs off the plan item's done *transition* (reconcile-rule.ts) — so a
 * work-item that lands in a non-terminal state AFTER its plan item is already
 * terminal (a reset [EI-13337], a complete-without-state [D-004: EI-13318/13346/
 * 14676], or a late create) is never re-healed and pollutes every surface that
 * reads raw work-item `state` (the claim path — now guarded by
 * plan-item-lane-guard.ts — plus pot:survey placement, backlog counts, …).
 *
 * This sweep closes the transition-gap "fix the data, not the view" style: it
 * finds every NON-terminal work-item still carrying a `payload.plan_item` stamp,
 * re-reads each referenced plan item's CURRENT status, and:
 *   - for the ones that are genuinely terminal (done OR dropped), reuses the exact
 *     same per-item reconciler — inheriting all its safety rails (skip
 *     already-terminal, skip independent in-flight `lastProgressAt` progress,
 *     never throw);
 *   - for the ones whose lane is blocked/needs-human, PARKS the linked work-items
 *     out of self-select (EI-14699 — ends the claim/release ping-pong at the
 *     source), and RESTORES them when the lane is actionable again. This half is
 *     blocked-by-graph aware, so an item effectively blocked by an unresolved
 *     dependency is caught even without an explicit `blocked` stored status.
 *
 * FAIL-CLOSED by construction: a candidate whose plan can't be resolved is SKIPPED
 * — never terminalized on a guess, and a lane-classify hiccup skips only the lane
 * sync. Idempotent: a re-park of an already lane-parked item, or a re-heal of
 * already-terminal data, is a clean no-op.
 *
 * Homed on the `system:plan-item-orphan-reconcile` routine (a bounded periodic
 * sweep — NOT a bare setInterval), mirroring `system:gc-plan-runs`.
 */
export async function reconcileOrphanedPlanItemWorkItems(
  opts: { candidateCap?: number } = {},
): Promise<OrphanReconcileSweepResult> {
  const cap = opts.candidateCap && opts.candidateCap > 0 ? opts.candidateCap : DEFAULT_ORPHAN_SWEEP_CAP;
  const out: OrphanReconcileSweepResult = {
    candidatePlanItems: 0,
    candidateWindowSaturated: false,
    terminalPlanItems: 0,
    reconciled: [],
    gated: [],
    ungated: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
    planSaysDoneOpen: -1,
    circularPrerequisites: [],
  };

  const { sql } = getOrgPg();

  // WI-39498 census (see the field's doc on OrphanReconcileSweepResult). One bounded
  // COUNT per tick: the join keys match work_items_plan_item_stamp_idx's partial
  // predicate, and the ILIKE legs only run on the already-joined (stamped, non-settled,
  // terminal-plan-item) rows. Deliberately the SAME predicate the claim-time warning
  // uses (planItemTextNamesCompleted), so detector and warning cannot drift. Fail-soft:
  // a census failure leaves -1 (unmeasured), never 0, and never blocks the heal sweep.
  try {
    const census = await sql<{ n: string }[]>`
      SELECT count(*) AS n
        FROM harness_shared.work_items w
        JOIN harness_shared.plan_items pi
          ON pi.plan_slug = w.payload->'plan_item'->>'plan_slug'
         AND pi.item_id   = w.payload->'plan_item'->>'item_id'
       WHERE w.payload->'plan_item' IS NOT NULL
         AND NOT (w.status = ANY(${SETTLED_WORK_ITEM_STATES}::text[]))
         AND pi.status IN ('done', 'dropped')
         AND pi.item_text ILIKE '%' || w.feature_id || '%'
         AND (pi.item_text ILIKE '%completed%' OR pi.item_text ILIKE '%(done)%')`;
    const n = Number(census[0]?.n);
    if (Number.isFinite(n)) out.planSaysDoneOpen = n;
  } catch {
    // census is advisory — the heal sweep below must run regardless.
  }
  // 1. Enumerate candidate plan-items from NON-terminal work-items carrying
  //    EITHER linkage mechanism, in ONE query over the unified base table
  //    (harness_shared.work_items, mig 374) rather than the harness_features_-
  //    consolidated / engineer_issues VIEWS. The issues view projects
  //    `(payload - '_ei')`, which throws `cannot delete from scalar` when the
  //    planner evaluates it over a string-scalar payload during inlining; the base
  //    table exposes the raw `payload` (always a jsonb object — migration 725's
  //    CHECK constraint). `status` exclusion uses the FULL cross-family SETTLED_WORK_-
  //    ITEM_STATES superset (WI-5279: the legacy-only 4-value list here predated
  //    work-item-status-full-unify/2026-07-19 and silently stopped excluding rows
  //    already written with the unified 'done'/'dropped' spelling — live-verified
  //    1638 of 1898 plan_item-stamped rows now carry those spellings, so the stale
  //    filter let already-terminal noise crowd out the `LIMIT cap` candidate
  //    window, starving genuine orphans like WI-3676/WI-4669/EI-13337's class from
  //    ever being enumerated by this sweep). Workspace-agnostic on the stamp
  //    exactly like findAllLinkedWorkItems; `harness_slug` is the getPlanRow hint;
  //    the per-item reconciler re-resolves the plan.
  const cands = new Map<string, OrphanCandidate>();
  const key = (planSlug: string, itemId: string) => `${planSlug}\0${itemId}`;

  //    WI-10004586: the window is ORDERED, not an arbitrary planner slice. Without
  //    an ORDER BY the same ~cap rows came back every tick, and rows that are
  //    skipped on every pass (gated, unproven-link, a non-terminal lane sync)
  //    held the window while terminal orphans past it were never visited —
  //    measured 2026-10-01: 536 candidates, 68 with a terminal plan item, only
  //    52 of those inside the LIMIT 500 window. Candidates whose plan item the
  //    derived `plan_items` index already shows TERMINAL go first (they are the
  //    ones this sweep exists to heal); the rest rotate via random() so every
  //    lane-sync candidate is eventually visited. The index only PRIORITISES —
  //    each candidate is still confirmed against a fresh getPlanRow below, so a
  //    stale index row can reorder the window but never terminalize anything.
  const rows = await sql<{ plan_slug: string; item_id: string; harness_slug: string | null }[]>`
    SELECT c.plan_slug, c.item_id, c.harness_slug
      FROM (
        SELECT DISTINCT linkage.plan_slug, linkage.item_id, w.harness_slug
          FROM harness_shared.work_items w
          CROSS JOIN LATERAL (
            SELECT w.payload->'plan_item'->>'plan_slug' AS plan_slug,
                   w.payload->'plan_item'->>'item_id'  AS item_id
             WHERE w.payload->'plan_item' IS NOT NULL
            UNION
            SELECT w.source_plan_slug AS plan_slug, source_item_id AS item_id
              FROM unnest(COALESCE(w.source_plan_item_ids, ARRAY[]::text[])) AS source_item_id
             WHERE w.source_plan_slug IS NOT NULL
          ) AS linkage
         WHERE NOT (w.status = ANY(${SETTLED_WORK_ITEM_STATES}::text[]))
           AND linkage.plan_slug IS NOT NULL
           AND linkage.item_id IS NOT NULL
      ) AS c
     ORDER BY EXISTS (
                SELECT 1 FROM harness_shared.plan_items pi
                 WHERE pi.plan_slug = c.plan_slug
                   AND pi.item_id = c.item_id
                   AND pi.status = ANY(${Object.keys(TERMINAL_PLAN_ITEM_TARGET)}::text[])
              ) DESC,
              random()
     LIMIT ${cap}`;
  out.candidateWindowSaturated = rows.length >= cap;
  for (const r of rows) {
    const k = key(r.plan_slug, r.item_id);
    if (!cands.has(k)) cands.set(k, { planSlug: r.plan_slug, itemId: r.item_id, harnessSlug: r.harness_slug ?? null });
  }
  out.candidatePlanItems = cands.size;

  // 2. Group candidates by plan so each plan is read ONCE.
  const byPlan = new Map<string, { harnessSlug: string | null; items: OrphanCandidate[] }>();
  for (const c of cands.values()) {
    let g = byPlan.get(c.planSlug);
    if (!g) {
      g = { harnessSlug: c.harnessSlug, items: [] };
      byPlan.set(c.planSlug, g);
    }
    if (!g.harnessSlug && c.harnessSlug) g.harnessSlug = c.harnessSlug;
    g.items.push(c);
  }

  // 3. Per plan: read once, then route each candidate by its plan-item status
  //    (fail-closed — an unresolvable plan is skipped):
  //     - TERMINAL (done/dropped) → the terminal reconciler (EI-14693, unchanged).
  //     - GATED/actionable → the EI-14699 lane sync (park a blocked/needs-human
  //       lane's linked work-items out of self-select; un-park an actionable one).
  //       Classification is blocked-by-graph aware, so an item effectively blocked
  //       by an unresolved dependency is caught even without an explicit `blocked`
  //       stored status. Fail-closed: a classify hiccup skips the lane sync only.
  for (const [planSlug, g] of byPlan) {
    const row = await getPlanRow(planSlug, { harnessSlug: g.harnessSlug ?? undefined }).catch(() => null);
    if (!row) continue; // fail-closed: cannot confirm status → touch nothing.
    const statusById = new Map(row.items.map((i) => [i.id, i.status]));
    for (const c of g.items) {
      const st = statusById.get(c.itemId);
      if (isTerminalPlanItemStatus(st)) {
        out.terminalPlanItems += 1;
        const r = await reconcileLinkedWorkItemsForPlanItem(
          { planSlug: c.planSlug, itemId: c.itemId, harnessSlug: c.harnessSlug },
          { knownTerminalStatus: st },
        );
        out.reconciled.push(...r.reconciled);
        out.skippedInFlight.push(...r.skippedInFlight);
        out.skippedAlreadyTerminal.push(...r.skippedAlreadyTerminal);
        out.skippedUnprovenLink.push(...r.skippedUnprovenLink);
        continue;
      }
      // NON-terminal (EI-14699): sync the effective lane onto linked work-items.
      try {
        const laneStatus = classifyPlanLane(row, c.itemId);
        if (laneStatus) {
          const r = await syncLinkedWorkItemsToPlanLane(
            { planSlug: c.planSlug, itemId: c.itemId, harnessSlug: c.harnessSlug },
            laneStatus,
            row,
          );
          out.gated.push(...r.gated);
          out.ungated.push(...r.ungated);
          out.skippedInFlight.push(...r.skippedInFlight);
          out.skippedAlreadyTerminal.push(...r.skippedAlreadyTerminal);
          out.circularPrerequisites.push(...r.circularPrerequisites);
        }
      } catch {
        // fail-closed — a lane-classify/sync hiccup must never wedge the sweep.
      }
    }
  }
  return out;
}
