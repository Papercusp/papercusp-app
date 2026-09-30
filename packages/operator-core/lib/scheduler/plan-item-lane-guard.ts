/**
 * The PLAN-ITEM-LANE readiness guard for self-select claims (WI-3667).
 *
 * A work-item can carry a `payload.plan_item: { plan_slug, item_id }` back-pointer
 * (stamped by plan-workitem-promotion-run.ts when a plan lane is promoted into an
 * execution record). `reservedPlanLaneExclusionSql` (work-items.ts) already excludes
 * such a row from self-select while its PLAN is `active` — but that is a coarse,
 * plan-wide floor. It says nothing about the individual plan ITEM's own resolved
 * status: a plan can be inactive (draft/paused) or its `active` floor can already
 * have lapsed while the SPECIFIC item is explicitly `blocked` (or blocked-by an
 * unresolved dependency, or a cycle) — and a claim-then-inspect self-selector then
 * picks up exactly the kind of mid-flight, human-supervised close-out work that
 * causes damage when run early (WI-3667: a Phase-5 close-out claimed mid-outage-
 * diagnosis, before the diagnosis had settled).
 *
 * ─ THE TWO LINKAGE MECHANISMS (EI-13738) ──────────────────────────────────────
 * `payload.plan_item` is stamped ONLY by the separate, dark-flagged
 * `plan-workitem-promotion-run.ts` path. The path that ACTUALLY promotes plan
 * items in production — `promote.ts` / `POST /features/import`, the tool behind
 * every real `plans:start` / feature-import call — writes a DIFFERENT, DB-column
 * linkage instead: `source_plan_slug` + `source_plan_item_ids` on the
 * family-specific work-item views (`harness_features_consolidated` for features
 * and `engineer_issues` for issues), with NO `payload.plan_item` stamp. Relying
 * on the payload back-pointer alone therefore left every REAL plan-promoted item
 * invisible to this guard — confirmed by the live incidents this guard's own
 * regression tests reproduce (EI-9107/EI-9108, P-401/P-308 — WI-3503/WI-3502),
 * which in production carried the DB-column linkage, not a payload stamp; two
 * independent agents (EI-13738) each rediscovered the same gap from opposite
 * directions within an hour of each other. `resolvePlanItemStamp` below now
 * resolves via EITHER mechanism, so a claim from either promotion path is
 * covered without a human having to remember which one stamped this row.
 *
 * ─ TERMINAL-lane residue (EI-13337 / EI-13352 / EI-13267 / EI-14693) ──────────
 * The costlier, recurring variant: the linked plan item is already TERMINAL
 * (`done`/`dropped`) yet the work-item is sitting at `state:'todo'` — a stale
 * residue (a completion that never terminalized the WI, a WI reset back to todo
 * after its plan item was already done, or a WI minted after the item completed).
 * `reconcileLinkedWorkItemsForPlanItem` (the reverse mirror, EI-5925/6960) heals
 * this — but ONLY on the plan-item's done TRANSITION; once the item is already
 * done, that reaction never re-fires, so a WI that lands in `todo` afterwards is
 * never reconciled. Nothing then stops the backlog-drain fleet from claiming it,
 * re-verifying "already done, no code needed", and re-closing it by hand — the
 * exact repeated fleet-time cost those four issues each report. This guard closes
 * that gap defensively: a claimed WI whose linked plan item is terminal is treated
 * the same as a blocked one (release + retry, never served), independent of
 * WHATEVER left the WI non-terminal.
 *
 * effectiveStatus resolution (blocked-by graph, cycles, missing refs — see
 * @papercusp/plan-parser's resolveEffectiveStatusForItems) is genuinely a JS-side
 * computation over the plan's JSONB `items` index, not a cheap SQL predicate — so
 * this is a POST-CLAIM guard, not a claimFloorsWhereSql addition: the caller claims
 * atomically as before, then this checks the linked plan item; on a hit the caller
 * releases the row and tries the next one (see getNextForBee's retry loop). The
 * short claim-then-release window is invisible to the outside caller (never
 * returned) and mirrors the existing lease-arbitration-loss retry shape.
 *
 * Fails OPEN (returns null ⇒ not blocked) on any lookup error — a plans read
 * hiccup must never wedge the whole claim path; the coarse plan-wide floor above
 * still applies as a backstop.
 */
import type { WorkItem } from '../work-items';
import { isTerminalItemStatus } from '../fleet-drained-events';

export interface PlanItemLaneBlock {
  reason: string;
  planSlug: string;
  itemId: string;
  effectiveStatus: string;
  /**
   * WI-7316: the `staleBlockedHint` `resolveEffectiveStatusForItems` already derived for
   * the SPECIFIC plan item that produced this block — passed straight through, never
   * re-derived (the resolve call above computes it in the same pass, so this costs nothing).
   *
   * Non-null names a CONTRADICTION the resolver can see but cannot safely auto-clear: most
   * often a plan item whose stored token is `blocked` while every one of its blocked-by
   * dependencies has already resolved (the token is deliberately sticky — reserved for
   * external blockers — so it holds until a human clears it with `plans:set-status`).
   *
   * EI-19397307303043951 added the field and surfaced it on `plans:get-item` / `plans:lint`
   * only. That closed the diagnosis for someone who thinks to run those — but a fleet member
   * polling by claim-spec calls neither, and this guard is exactly what turns such an item
   * into an invisible miss: the row is claimed, blocked here, released, retried, and the
   * caller is handed a bare empty queue. Carrying the hint on the block lets the two
   * self-select surfaces (`scheduler:get_next`, `work_items:claimable`) tell a genuinely
   * drained lane apart from one that is one `plans:set-status` call away from claimable.
   *
   * Null whenever the resolver found no contradiction — i.e. an ordinary, honest block.
   */
  staleBlockedHint: string | null;
}

/**
 * EI-13780: a plan's own PROSE can mark a `todo`-status item as owner-gated /
 * hard-deferred without the structural `effectiveStatus`/`needsHuman` fields
 * ever reflecting it — a plan author writes "owner-gated" / "HARD-DEFERRED …
 * never auto-flip" in the item's own text, the plan's `## Now` block, or a
 * Decision, and the scheduler has no notion of that language. Two real
 * near-misses motivated this (both caught + hand-held by a fleet leader,
 * never executed): WI-357 (physical-rename-phase5 P-008 — "Owner-gated: needs
 * a coordinated quiescent window … Not auto-executable", inline on the item)
 * and WI-1774 (backend-reliability-100pct P-003 — the plan's own `## Now`
 * `Next` line: "P-003 … HARD-DEFERRED to an owner-attended session …never
 * auto-flip"). A fixed, deliberately small phrase set — expanding it is a
 * product decision, not a scheduler one.
 */
const OWNER_GATE_MARKERS = [
  'owner-gated',
  'hard-deferred',
  'never auto-flip',
  'needs a coordinated window',
  'owner-attended session',
] as const;

/**
 * EI-19968471075842609: a NEGATED mention must not read as the marker.
 * `'non-owner-gated'.includes('owner-gated')` is true, so a Now-block clause
 * written precisely to say an item is NOT gated — "the closest surviving
 * non-owner-gated lever on Report 1" — registered as the positive marker and
 * gated every item that sentence named (P-033/P-011/P-012, measured). It also
 * quoted "owner-gated" back in the refusal as though it came from the item, so
 * the reader goes looking for a gate that does not exist.
 *
 * This is the SAME inversion EI-18718822565695446 fixed one level up (the more
 * carefully a Now block enumerates what is actionable, the more items it
 * false-gated), reappearing inside the predicate that fix calls: scoping the
 * marker to the right sentence cannot help when the marker itself is matched by
 * SPELLING rather than by the property it stands for.
 *
 * Deliberately NARROW — only an IMMEDIATELY preceding negation is rejected, and
 * the scan continues to later occurrences. The module's scoping doc names the
 * dangerous direction (a false NEGATIVE hands genuinely owner-gated work to a
 * self-selector), so "…non-owner-gated lever… and P-019 is owner-gated" still
 * gates on the second, real mention.
 */
const NEGATED_MARKER_PREFIX = /(?:\bnon[-\s]?|\bnot\s+)$/;

/**
 * A marker carrying an EXPLICIT parenthesised ITEM-ID attribution predicates over
 * THOSE items and no others.
 *
 * This is the THIRD variant of one bug. EI-18718822565695446 scoped the marker to
 * the right SENTENCE; EI-19968471075842609 stopped it matching by SPELLING through
 * a negation; both left the case where the sentence is a STATUS-COUNTS LINE and the
 * marker is a COUNT LABEL rather than a predication about anything it lists:
 *
 *     **27 of 36 done, 4 dropped, 1 owner-gated (P-035), 4 todo** (P-036 · P-023)
 *
 * That is one line and one sentence, so sentence-scoping cannot separate them, and
 * the marker is not negated — yet it gates P-036/P-023/P-024, the very items the
 * line exists to advertise as ACTIONABLE. It is the same inversion those two fixes
 * name (the more precisely a Now block reports status, the more items it
 * false-gates) arriving through a third door, and it is worse than the earlier two
 * because that counts line is the STANDARD opening of a `## Now` block here — so it
 * false-gates the whole todo list of every plan that keeps an accurate summary.
 * Measured 2026-08-09 on semantic-search-fingerprint-coverage-2026-08-03: P-036 was
 * refused self-select citing a marker that the same clause attributes to P-035.
 *
 * Deliberately NARROW, because the module's doc names the false-NEGATIVE as the
 * dangerous direction (handing genuinely owner-gated work to a self-selector):
 *   • only an IMMEDIATELY-following parenthesised group counts as an attribution;
 *   • the group must contain ONLY item ids — `P-003 (zero-downtime deploy)` is
 *     prose, carries no attribution, and keeps today's gate-everything-named
 *     behaviour;
 *   • an attribution that DOES name this item still gates it;
 *   • a non-matching occurrence is SKIPPED, not fatal — the scan continues, so a
 *     real unattributed marker later in the text still gates.
 */
const MARKER_ITEM_ATTRIBUTION = /^[\s*_:—–-]*\(\s*(p-\d{3,}(?:\s*[,;·&+/]\s*p-\d{3,})*)\s*\)/;

/** The item ids a marker occurrence is explicitly attributed to, or null if it carries no attribution. */
function markerAttributionIds(afterMarker: string): string[] | null {
  const m = MARKER_ITEM_ATTRIBUTION.exec(afterMarker);
  if (!m) return null;
  const ids = m[1]
    .split(/[,;·&+/\s]+/)
    .filter(Boolean)
    .map((s) => s.toUpperCase());
  return ids.length > 0 ? ids : null;
}

/**
 * `itemId` — when supplied, an occurrence explicitly attributed to OTHER items is
 * skipped (see MARKER_ITEM_ATTRIBUTION). Omitted ⇒ unchanged behaviour, which is
 * what the item's-own-text and Decision paths continue to use.
 */
function findOwnerGateMarker(text: string | null | undefined, itemId?: string | null): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const marker of OWNER_GATE_MARKERS) {
    for (let at = lower.indexOf(marker); at !== -1; at = lower.indexOf(marker, at + 1)) {
      if (NEGATED_MARKER_PREFIX.test(lower.slice(0, at))) continue;
      if (itemId) {
        const attributed = markerAttributionIds(lower.slice(at + marker.length));
        if (attributed && !attributed.includes(itemId.toUpperCase())) continue;
      }
      return marker;
    }
  }
  return null;
}

/** Escape a plan-item id for use inside a RegExp literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * EI-18754937921052867: an item's OWN `text` is frequently long, free-form
 * prose describing WHAT IS BEING BUILT — and that prose can itself use marker
 * language to describe a FEATURE's semantics rather than to say the ITEM is
 * owner-gated. Real repro: a plan item whose text ends "...health=stalled
 * when pushLagSec far exceeds the sync interval; disabled when push is
 * owner-gated." is describing a git-sync health enum the code should report,
 * not declaring the item itself gated — but `findOwnerGateMarker`'s bare
 * substring search can't tell that apart from a genuine gate note.
 *
 * The genuine shape (WI-357/P-008) is a LABEL: "(Owner-gated: needs a
 * coordinated quiescent window …)" — the marker introduces a clause, set off
 * by a leading position, an opening bracket/paren, or a trailing bracket
 * ("[owner-gated]"). Require that anchor for the item's OWN text specifically
 * (the Now-block / Decision scans keep their existing, already-scoped
 * substring search — they're targeted metadata, not open-ended spec prose,
 * so they carry much less of this false-positive risk).
 */
function findAnchoredOwnerGateMarker(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  for (const marker of OWNER_GATE_MARKERS) {
    const anchored = new RegExp(`(?:^|[([])\\s*${escapeRegExp(marker)}\\s*[:\\])]`, 'i');
    if (anchored.test(trimmed)) return marker;
  }
  return null;
}

/** Whether `itemId` (e.g. "P-003") is mentioned, as a whole token, in `text` —
 *  used to scope a plan-wide Now/Decision marker hit to the item it actually
 *  names, so a marker about ONE gated item in a plan never blanket-excludes
 *  every other unrelated `todo` item in the same plan. */
function itemMentioned(text: string | null | undefined, itemId: string): boolean {
  if (!text) return false;
  return new RegExp(`\\b${escapeRegExp(itemId)}\\b`).test(text);
}

/** Split Now text into the smallest units an owner-gate marker can sensibly be
 *  scoped to: lines first (a `## Now` block is usually bulleted), then sentences
 *  within a line. The sentence split requires WHITESPACE after the terminator so
 *  real plan prose like "discovery.refresh() into ONE loop" or ":3170-only,
 *  high-stakes" is never cut in half mid-clause. */
function markerScopeSegments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const s = sentence.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * EI-18718822565695446: find an owner-gate marker in the `## Now` block that is
 * actually ABOUT `itemId`.
 *
 * The previous form asked two INDEPENDENT questions of the whole block — "is the
 * item mentioned anywhere?" and "is there a marker anywhere?" — so one genuinely
 * gated item's marker gated every OTHER item the block happened to name. That
 * inverts the Now block's purpose: the more helpfully it enumerates what is
 * actionable, the more items it false-gates. (Real case: a Now block reading
 * "the next actionable block: P-007, P-008, P-009" plus "P-019 remains
 * owner-gated — it needs the live 2-machine Hetzner rig" gated P-007/8/9 on
 * P-019's gate.) This is the same locality `itemMentioned` already established
 * one level up, applied one level down: it narrowed plan-wide → Now-block-wide,
 * and this narrows Now-block-wide → the clause that names the item.
 *
 * Two rules, in order — the second exists so tightening the scope cannot swap a
 * false POSITIVE for a false NEGATIVE, which is the more dangerous direction
 * (it would hand genuinely owner-gated work to a self-selector):
 *   1. DEFINITE — a marker in the same line/sentence as the item's mention.
 *      Where one sentence names several items and carries a marker, it gates all
 *      of them, which is correct and is the WI-1774/P-003 shape (EI-13780).
 *   2. UNAMBIGUOUS — the block carries a marker and names NO OTHER plan item, so
 *      the marker cannot be about anything else. Preserves the pre-fix behaviour
 *      exactly where it was never ambiguous, e.g. a Now block whose mention and
 *      marker sit in separate sentences ("P-019 is the remaining item. It is
 *      owner-gated.").
 * Anything else — a marker elsewhere in a block that names other items too — is
 * genuinely ambiguous and no longer gates.
 */
function findNowOwnerGateMarker(nowText: string, itemId: string, allItemIds: readonly string[]): string | null {
  if (!nowText || !itemMentioned(nowText, itemId)) return null;
  for (const segment of markerScopeSegments(nowText)) {
    if (!itemMentioned(segment, itemId)) continue;
    const marker = findOwnerGateMarker(segment, itemId);
    if (marker) return marker;
  }
  const mentionsAnotherItem = allItemIds.some((id) => id !== itemId && itemMentioned(nowText, id));
  return mentionsAnotherItem ? null : findOwnerGateMarker(nowText, itemId);
}

export interface PlanItemStamp {
  plan_slug: string;
  /** One or more plan-item ids this work-item implements (source_plan_item_ids
   *  can carry several; the payload.plan_item back-pointer always carries one). */
  item_ids: string[];
}

type PlanItemColumnRow = {
  source_plan_slug: string | null;
  source_plan_item_ids: string[] | null;
};

function extractPlanItemStampFromPayload(payload: unknown): PlanItemStamp | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).plan_item;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stamp = raw as Record<string, unknown>;
  const planSlug = typeof stamp.plan_slug === 'string' ? stamp.plan_slug : null;
  const itemId = typeof stamp.item_id === 'string' ? stamp.item_id : null;
  if (!planSlug || !itemId) return null;
  return { plan_slug: planSlug, item_ids: [itemId] };
}

/**
 * EI-13738: resolve via the `source_plan_slug` / `source_plan_item_ids` columns
 * on the family-specific work-item view — the linkage the LIVE promotion path
 * (promote.ts / POST /features/import) actually writes. Feature-family rows are
 * read from `harness_features_consolidated`; issue-family rows are read from
 * `engineer_issues`, whose `base_harness_slug` column preserves the physical
 * harness filter. A missing/partial column pair (no source_plan_slug, or an
 * empty source_plan_item_ids) resolves to null — unplanned/standalone work, not
 * an error.
 */
async function resolvePlanItemStampFromColumns(
  workItem: Partial<Pick<WorkItem, 'id' | 'harness' | 'family'>>,
): Promise<PlanItemStamp | null> {
  // id/family are optional on the wider Pick below (most callers — including
  // every existing test in this file predating EI-13738 — construct a bare
  // `{ payload, harness }` object with no id/family; those legitimately have
  // no DB row to look up, so bail rather than query with an undefined id).
  if ((workItem.family !== 'feature' && workItem.family !== 'issue') || !workItem.id) return null;
  const workItemId = workItem.id;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  let rows: PlanItemColumnRow[];
  if (workItem.family === 'issue') {
    const { issuesScopeWorkspace } = await import('../issues-engineer');
    const harness = workItem.harness;
    rows = await sql<PlanItemColumnRow[]>`
      SELECT source_plan_slug, source_plan_item_ids
        FROM harness_shared.engineer_issues
       WHERE issue_id = ${workItemId}
         AND workspace_id = ${issuesScopeWorkspace()}
         AND ${harness ? sql`base_harness_slug = ${harness}` : sql`TRUE`}
       LIMIT 1`;
  } else {
    const { activeWorkspaceId } = await import('../workspace-registry');
    const harness = workItem.harness;
    rows = await sql<PlanItemColumnRow[]>`
      SELECT source_plan_slug, source_plan_item_ids
        FROM harness_shared.harness_features_consolidated
       WHERE feature_id = ${workItemId}
         AND workspace_id = ${activeWorkspaceId()}
         AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
       LIMIT 1`;
  }
  const row = rows[0];
  if (!row?.source_plan_slug || !row.source_plan_item_ids || row.source_plan_item_ids.length === 0) return null;
  return { plan_slug: row.source_plan_slug, item_ids: row.source_plan_item_ids };
}

/** Resolve a work-item's plan-item linkage via EITHER mechanism (see the module
 *  doc's "THE TWO LINKAGE MECHANISMS" section) — payload back-pointer first
 *  (cheap, no I/O), falling back to the DB-column linkage. Fails OPEN (null) on
 *  any lookup error, same contract as the caller `planItemLaneBlockReason`. */
/** Exported for plan-item-claim-collision.ts (P-006, agent-trap-guards-2026-07-26)
 *  — the collision check needs the SAME plan-item linkage resolution (either
 *  mechanism) this guard already does; duplicating it would let the two drift. */
export async function resolvePlanItemStamp(
  workItem: Pick<WorkItem, 'payload' | 'harness'> &
    Partial<Pick<WorkItem, 'id' | 'family' | 'sourcePlanSlug' | 'sourcePlanItemIds'>>,
): Promise<PlanItemStamp | null> {
  const fromPayload = extractPlanItemStampFromPayload(workItem.payload);
  if (fromPayload) return fromPayload;
  // The normal WorkItem projection already carries the indexed source-plan columns. Prefer
  // those mapped values over a second view read: claimable lifecycle events run from the same
  // projection and must be able to apply this guard without introducing an avoidable DB round
  // trip (or losing the linkage when the event is emitted after a release). Keep the DB fallback
  // below for sparse/legacy callers whose projection does not include these optional fields.
  if (
    typeof workItem.sourcePlanSlug === 'string' &&
    workItem.sourcePlanSlug.trim() &&
    Array.isArray(workItem.sourcePlanItemIds) &&
    workItem.sourcePlanItemIds.length > 0
  ) {
    const itemIds = workItem.sourcePlanItemIds.filter(
      (itemId): itemId is string => typeof itemId === 'string' && itemId.trim().length > 0,
    );
    if (itemIds.length > 0) return { plan_slug: workItem.sourcePlanSlug.trim(), item_ids: itemIds };
  }
  try {
    return await resolvePlanItemStampFromColumns(workItem);
  } catch {
    return null;
  }
}

export interface PlanItemNeedsHumanContradiction {
  reason: string;
  planSlug: string;
  itemIds: string[];
}

/**
 * EI-13766: plan truth is authoritative for whether plan-linked work belongs in
 * the owner lane. A structured work-item ask is necessary, but it must not be
 * allowed to contradict a plan whose referenced items all explicitly resolve as
 * `needsHuman:false`.
 *
 * This deliberately fails open unless EVERY referenced item resolves. A
 * multi-item feature whose plan linkage is only partially readable is not enough
 * evidence to reject the write; the periodic lane reconciler will retry from a
 * fresh plan read. Both linkage mechanisms are inherited from
 * {@link resolvePlanItemStamp}.
 */
export async function planItemNeedsHumanContradiction(
  workItem: Pick<WorkItem, 'payload' | 'harness'> &
    Partial<Pick<WorkItem, 'id' | 'family' | 'sourcePlanSlug' | 'sourcePlanItemIds'>>,
): Promise<PlanItemNeedsHumanContradiction | null> {
  const stamp = await resolvePlanItemStamp(workItem);
  if (!stamp) return null;
  try {
    const [{ getPlanRow, planItemsForRow }, { isTerminalPlanStatus, resolveEffectiveStatusForItems }] = await Promise.all([
      import('../agent-tools/plans/source'),
      import('@papercusp/plan-parser'),
    ]);
    const row = await getPlanRow(stamp.plan_slug, { harnessSlug: workItem.harness ?? undefined });
    if (!row) return null;
    const { items } = resolveEffectiveStatusForItems(planItemsForRow(row));
    const linked = stamp.item_ids.map((itemId) => items.find((item) => item.id === itemId));
    if (linked.some((item) => !item)) return null;
    // EI-22166703532735250: `needsHuman:false` is derived even for carrier residue.
    // A shipped/superseded plan is historical, and an all-terminal linked set is
    // abandoned/completed work; neither is evidence that a fresh owner blocker would
    // contradict a currently agent-actionable lane.
    const planStatus = typeof (row as { status?: unknown }).status === 'string' ? (row as { status: string }).status : null;
    if (isTerminalPlanStatus(planStatus) || linked.every((item) => isTerminalItemStatus(item!.effectiveStatus))) {
      return null;
    }
    if (!linked.every((item) => item?.needsHuman === false)) return null;
    return {
      reason:
        `linked plan item${stamp.item_ids.length === 1 ? '' : 's'} ` +
        `${stamp.plan_slug}#${stamp.item_ids.join(',')} explicitly remain agent-actionable (needsHuman=false)`,
      planSlug: stamp.plan_slug,
      itemIds: [...stamp.item_ids],
    };
  } catch {
    // Fail OPEN — an incomplete plan read must not wedge the lifecycle writer.
    return null;
  }
}

/**
 * Whether a just-claimed work-item's linked plan-item lane is currently
 * blocked / needs-human / already-terminal — the cases self-select must not
 * silently hand out. Returns null when the item carries no plan-item
 * linkage (neither mechanism), the linked plan/item(s) can't be found, or the
 * lane is clear.
 */
export async function planItemLaneBlockReason(
  workItem: Pick<WorkItem, 'payload' | 'harness'> &
    Partial<Pick<WorkItem, 'id' | 'family' | 'sourcePlanSlug' | 'sourcePlanItemIds'>>,
): Promise<PlanItemLaneBlock | null> {
  const stamp = await resolvePlanItemStamp(workItem);
  if (!stamp) return null;
  try {
    const [{ getPlanRow, planItemsForRow }, { resolveEffectiveStatusForItems }] = await Promise.all([
      import('../agent-tools/plans/source'),
      import('@papercusp/plan-parser'),
    ]);
    const row = await getPlanRow(stamp.plan_slug, { harnessSlug: workItem.harness ?? undefined });
    if (!row) return null;
    const { items } = resolveEffectiveStatusForItems(planItemsForRow(row));
    const linked = stamp.item_ids
      .map((itemId) => items.find((i) => i.id === itemId))
      .filter((i): i is (typeof items)[number] => Boolean(i));
    if (linked.length === 0) return null;
    // A work-item can implement several plan items (source_plan_item_ids) — ANY
    // one of them being effectively blocked, or needing a human decision, gates
    // the whole work-item (a claimer executing it would be doing that item's
    // work too). Checked before the terminal/stale-residue case below so a
    // mixed set (one done + one blocked) still reports the actionable blocker.
    const blocked = linked.find((i) => i.effectiveStatus === 'blocked');
    if (blocked) {
      const blockers =
        blocked.unresolvedBlockers.length > 0 ? ` (blocked-by: ${blocked.unresolvedBlockers.join(', ')})` : '';
      return {
        reason: `plan-item ${stamp.plan_slug}#${blocked.id} is effectively blocked${blockers}`,
        planSlug: stamp.plan_slug,
        itemId: blocked.id,
        effectiveStatus: blocked.effectiveStatus,
        // WI-7316: the headline case. `blockers` above is EMPTY exactly when every
        // blocked-by dependency has resolved — i.e. the block is a sticky stored token
        // with nothing actually blocking it — and that is precisely when the resolver
        // populates staleBlockedHint. Without carrying it here the caller sees "is
        // effectively blocked" with no blocked-by list and no way to tell that the
        // remedy is a one-call `plans:set-status`, not a wait.
        staleBlockedHint: blocked.staleBlockedHint,
      };
    }
    const needsHuman = linked.find((i) => i.needsHuman);
    if (needsHuman) {
      return {
        reason: `plan-item ${stamp.plan_slug}#${needsHuman.id} needs a human decision`,
        planSlug: stamp.plan_slug,
        itemId: needsHuman.id,
        effectiveStatus: needsHuman.effectiveStatus,
        staleBlockedHint: needsHuman.staleBlockedHint,
      };
    }
    // Already-terminal lane (EI-13337/13352/13267/14693): the plan item(s) are
    // done/dropped, so this work-item is stale residue — completed/abandoned
    // work, not open work. Never hand it to a self-selector to re-verify +
    // re-close by hand. Only when EVERY linked item is terminal — a work-item
    // covering one done + one still-open item is still real open work.
    if (linked.every((i) => i.effectiveStatus === 'done' || i.effectiveStatus === 'dropped')) {
      const terminal = linked[0];
      return {
        reason: `plan-item ${stamp.plan_slug}#${terminal.id} is already ${terminal.effectiveStatus} — its work-item is stale residue of completed/abandoned work, not open work`,
        planSlug: stamp.plan_slug,
        itemId: terminal.id,
        effectiveStatus: terminal.effectiveStatus,
        // Deliberately `terminal`'s own hint, not "any linked item's": the hint must
        // describe the SAME item as `itemId` or it reads as evidence about the wrong row.
        // For a terminal item the resolver populates it when a blocked-by edge is still
        // unresolved (a likely-stale edge, or an item closed early).
        staleBlockedHint: terminal.staleBlockedHint,
      };
    }
    // EI-13780: a plan can mark a still-`todo` item owner-gated/hard-deferred
    // purely in PROSE — the item's own line, the plan's `## Now` block, or a
    // Decision scoped to it (via the Decision's own itemRefs) — with no
    // structural effectiveStatus/needsHuman signal at all (see the module-level
    // OWNER_GATE_MARKERS doc comment). Checked last, over the SAME `linked` set,
    // same any-one-gates-the-whole-work-item semantics as blocked/needsHuman above.
    const nowText = [row.nowState, row.nowNext].filter(Boolean).join('\n');
    const allItemIds = items.map((i) => i.id);
    for (const li of linked) {
      const ownMarker = findAnchoredOwnerGateMarker(li.text);
      const nowMarker = findNowOwnerGateMarker(nowText, li.id, allItemIds);
      const decisionMarker = (row.decisions ?? [])
        .filter((d) => d.itemRefs.includes(li.id))
        .map((d) => findOwnerGateMarker(d.title) ?? findOwnerGateMarker(d.body))
        .find((m): m is string => Boolean(m));
      const hit = ownMarker ?? nowMarker ?? decisionMarker ?? null;
      if (hit) {
        return {
          reason: `plan-item ${stamp.plan_slug}#${li.id}'s plan text marks it owner-gated ("${hit}") — not eligible for self-select`,
          planSlug: stamp.plan_slug,
          itemId: li.id,
          effectiveStatus: li.effectiveStatus,
          staleBlockedHint: li.staleBlockedHint,
        };
      }
    }
    return null;
  } catch {
    // Fail OPEN — a plans-read hiccup must never wedge the shared claim path.
    return null;
  }
}

/** Lifecycle-event parity seam. Kept as a named wrapper so callers that mock the claim-time
 * guard (for example, work-items integration fixtures) can independently control notification
 * checks without consuming claim-time one-shot assertions. Production behavior is identical. */
export async function planItemLaneBlockReasonForClaimableEvent(
  workItem: Pick<WorkItem, 'payload' | 'harness'> &
    Partial<Pick<WorkItem, 'id' | 'family' | 'sourcePlanSlug' | 'sourcePlanItemIds'>>,
): Promise<PlanItemLaneBlock | null> {
  return planItemLaneBlockReason(workItem);
}

export interface PlanItemLiveClaimBlock {
  reason: string;
  planSlug: string;
  itemId: string;
  claimedBy: string;
  claimedByLabel: string | null;
}

/**
 * WI-5343: an UNASSIGNED work-item's linked plan item can be under a LIVE claim
 * lease (`harness_shared.plan_item_claims`) even though the plan parser's
 * `effectiveStatus` never reflects it — `effectiveStatus` is a structural
 * (blocked-by-graph) computation, not "who currently holds the pen". Evidence:
 * WI-5137 sat in the claimable backlog, unassigned/todo, while its linked plan
 * item P-402 was live-claimed by a DIFFERENT session with a fresh checkpoint —
 * `planItemLaneBlockReason` above cleared it (P-402 wasn't structurally
 * blocked), so nothing stopped a self-selector from picking up work someone
 * else was already actively executing (caught only by hand, WI-5137's own
 * comment thread).
 *
 * Distinct from `plan-item-claim-collision.ts`'s `planItemClaimCollision`,
 * which detects the OPPOSITE drift (an ASSIGNED work-item whose plan item has
 * since been claimed by someone other than ITS OWN assignee — a live-holder
 * bug on a row you already hold). This checks the pre-claim question: is the
 * plan item already spoken for by ANYONE, so an unassigned work-item should
 * not be advertised as freely self-selectable in the first place? Ownership
 * doesn't matter here (even "held by me already" means this isn't NEW
 * self-selectable work — the caller would see their own claim via their own
 * assignments fold instead).
 *
 * Fails OPEN (null) on any lookup error, same contract as the sibling checks
 * in this file — a claims-store hiccup must never wedge work_items:observe /
 * coord:orient's claimable read.
 */
export async function planItemLiveClaimReason(
  workItem: Pick<WorkItem, 'payload' | 'harness'> &
    Partial<Pick<WorkItem, 'id' | 'family' | 'sourcePlanSlug' | 'sourcePlanItemIds'>>,
): Promise<PlanItemLiveClaimBlock | null> {
  const stamp = await resolvePlanItemStamp(workItem);
  if (!stamp) return null;
  try {
    const [{ resolvePlanScope }, { getClaim }] = await Promise.all([
      import('../agent-tools/plans/source'),
      import('../plan-items/claims'),
    ]);
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: workItem.harness ?? undefined });
    for (const itemId of stamp.item_ids) {
      const claim = await getClaim(workspaceId, harnessSlug, stamp.plan_slug, itemId);
      if (claim && !claim.expired) {
        return {
          reason:
            `plan-item ${stamp.plan_slug}#${itemId} — which this work-item implements — is currently held by a ` +
            `LIVE claim from ${claim.ownerLabel ?? claim.owner}; not eligible for self-select until it releases.`,
          planSlug: stamp.plan_slug,
          itemId,
          claimedBy: claim.owner,
          claimedByLabel: claim.ownerLabel,
        };
      }
    }
    return null;
  } catch {
    // Fail OPEN — a claims-store hiccup must never wedge the shared claim path.
    return null;
  }
}
