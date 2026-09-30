/**
 * carry-brief — ONE assembly of a session's continuity state
 * (compaction-continuity-hardening-2026-07-07 P-003).
 *
 * A context boundary (warm compaction OR cold reset/recycle) loses the transcript
 * but NOT the state parked on the carry surfaces: the loop carry-note, held
 * work-item checkpoints, open WALLS (structured owner-gated commitments, P-006),
 * owner-scoped standing facts, armed awaits, and fleet membership. This module
 * reads all of them in one place
 * so every boundary hands the successor the SAME brief:
 *
 *   (i)   the compaction watchdog's force-compact `/compact` FOCUS
 *         (compaction-compliance-watchdog.ts → renderCarryBriefFocus),
 *   (ii)  `session:request-compaction`'s default focus (request-compaction.ts),
 *   (iii) the COLD reset/recycle anchor payload (wake-executor.ts →
 *         renderCarryBriefColdExtras, appended to the loop carry-note).
 *
 * One code path serving warm compaction and cold recycle is the structural
 * guarantee that the two modes can't drift (owner requirement Q2). The P-004
 * post-compaction recovery hook consumes {@link renderCarryBriefText}.
 *
 * The focus renderer deliberately produces POINTERS, not copies: checkpointed
 * state is re-injected mechanically on the next wake/pickup, so spending summary
 * budget copying it is the failure the compaction strategy warns about. Every
 * read leg is best-effort — a failed leg yields an empty section, never a throw.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from './workspace-registry';
import {
  ANY_FAMILY_TERMINAL_STATES,
  FEATURE_TERMINAL_STATES,
  ISSUE_TERMINAL_STATES,
} from './work-item-dispatch-states';
import {
  getLoopCarryNoteWithMeta,
  renderCheckLine,
  shortCarryHash,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  type CheckEntry,
  type LoopCarryNoteWithMeta,
  type WallEntry,
} from './carry-note';
import { harnessOfScope } from './work-item-scope';
import { renderOwnerDirectivesBlock, type OwnerDirectiveRow } from './owner-directives';
import type { QueryHandle } from './ambient-push';
import {
  DEAD_END_KEY_PREFIX,
  foldNeverDropFacts,
  type FactSourceProvenance,
} from './agent-facts/store';
// P-029: the carry document is a DECLARED orientation sink, so it reads what it
// is entitled to carry from the shared class registry rather than deciding for
// itself. Imported through the sink-neutral seam on purpose — that module's own
// docstring names carry-brief consumers as its intended importer, and reaching
// into `turn-start-orientation` (the turn-start sink's own module) would be a
// layering inversion even though it resolves to the same binding.
import { ORIENTATION_CLASS_REGISTRY } from './orientation-class-registry';
import type { RegisteredOrientationClass } from './orientation-class-registry';
// TYPE-only: the runtime `markContestedFacts` is dynamically imported at its one
// call site below, matching how this module already defers `foldFacts`.
import type { FactContestMark } from './agent-tools/facts/contested-fold';
import { capPreservingOperative } from './operative-clause';
import { workItemFetchHint } from './work-item-fetch-hint';
import {
  checkCarriedFactsStaleness,
  renderFactsStalenessWarning,
  type FactStalenessResult,
} from './carry-fact-staleness';
import { transientExecHandleWarning } from './su-cold-loop';
import type { HydratableRef } from './agent-tools/coordination/ref-hydrate';
import type { WorkItemCheckpointRef, WorkItemCheckpointWithMeta } from './work-item-checkpoint';
import {
  readLinkedByocReleaseCarries,
  renderByocReleaseCarry,
  type ByocReleaseCarrySnapshot,
} from './byoc-release-carry';

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface CarryBriefHeldItem {
  id: string;
  title: string | null;
  /** The item's description body (uncapped here; renderers cap). */
  body: string | null;
  /** null for an operator/harness-null item (EI-8813) — never a guessed slug. */
  harness: string | null;
  /** In-flight state left by work_items:checkpoint — null when never written. */
  checkpoint: string | null;
  /** Epoch ms of the checkpoint's last write (carry_notes.updated_ts) — the
   *  staleness signal (P-003 fleet-deltas-leader-primitives: a checkpoint written
   *  long before a compaction means the turns since it will NOT carry). Null when
   *  no checkpoint, or when an injected test read supplies no meta. */
  checkpointUpdatedAtMs?: number | null;
  /** The checkpoint store was unavailable; never render this as confirmed-empty. */
  checkpointReadFailed?: boolean;
  /** Epoch ms of the work-item's last real progress (`work_items.last_progress_at`).
   *  Unlike checkpoint age, this is item-scoped evidence that work happened after
   *  the checkpoint. Optional for legacy/injected carry readers that did not load
   *  the column. */
  lastProgressAtMs?: number | null;
  /** Source-plan binding carried by the work-item row. Bare P-NNN references are
   *  not globally unique, so this is the only safe context for resolving one in
   *  the session's carry note. */
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  /**
   * Read-time ownership evidence. A carry snapshot may be delivered after a
   * claim is reassigned, so the row must carry the exact holder/workspace pair
   * that justified selecting it. Renderers fail closed when this proof is
   * absent or no longer matches the carry recipient.
   */
  holderProof?: {
    ownerId: string;
    workspaceId: string;
  } | null;
}

export type CarryBriefDeferredSource = 'created' | 'commented' | 'created-and-commented';

/**
 * A non-terminal work-item this session positively touched (filed or commented
 * on) but does not currently hold. This is deliberately NOT the unclaimed
 * backlog: the owner + current-session + non-terminal + unheld conjunction is
 * what makes the row a useful deferred-work signal instead of queue noise.
 */
export interface CarryBriefDeferredItem {
  id: string;
  title: string | null;
  /** The item's description body (uncapped here; renderers cap). */
  body: string | null;
  /** null for an operator-scoped item — never a guessed harness slug. */
  harness: string | null;
  kind: string;
  source: CarryBriefDeferredSource;
}

export interface CarryBrief {
  ownerId: string;
  /** Concrete workspace used for this carry read; absent on legacy literals. */
  workspaceId?: string | null;
  /** Armed AUTO loop + its carry-note (verbatim) — null when no loop routine exists. */
  loop: {
    harness: string;
    active: boolean;
    intervalSec: number | null;
    /**
     * Persisted loop lifecycle. The current builder always supplies this from
     * LoopStatus; optional keeps injected/legacy briefs readable while they
     * roll forward to the mode-aware shape.
     */
    carry?: 'warm' | 'cold';
    /** EI-20072281215342526: the loop's GOAL — the agent's MISSION. Carried here
     *  because a carry-respawn renders no wake kickoff, which used to be the goal's
     *  only delivery channel; the successor therefore inherited its held work-items
     *  WITHOUT the mission that generated them. Null for a loop armed with no goal, or
     *  armed before the goal was persisted structurally (those cannot be back-filled). */
    goal: string | null;
    carryNote: string | null;
    carryNoteUpdatedAtMs: number | null;
    /**
     * True when the carry-note store could not be read. Optional keeps legacy
     * injected briefs compatible while preserving the distinction between an
     * unreadable note and a confirmed empty note for fresh carry assembly.
     */
    carryNoteReadFailed?: boolean;
  } | null;
  /** P-002 (cold-carry-system-hardening-2026-07-19): LIVE one-line hydrations of the
   *  WI-/EI- ids the carry-note cites (P-008 reuse) — a cited item that changed state
   *  after the note was written is the #1 stale-conclusion tell. Optional: absent on
   *  briefs built before this leg / when the note cites nothing. */
  citedRefs?: string[];
  /** P-003: directed inbox mail that landed AFTER the carry-note was written — the
   *  note PREDATES these; a cold successor must not treat the note as current past
   *  them. Null when unknown (no note timestamp / read failed); count 0 = verified
   *  quiet. */
  postNoteInbox?: { count: number; lines: string[] } | null;
  /** Held (assigned, non-terminal) work-items + their checkpoints. */
  heldItems: CarryBriefHeldItem[];
  /** Bounded projections of canonical BYOC release journals explicitly linked
   * to this owner or one of the held work-items. The task ledger stays canonical. */
  byocReleases?: ByocReleaseCarrySnapshot[];
  /** This session's non-terminal, unheld work-items that it filed or commented
   *  on. Optional so legacy/injected CarryBrief literals remain valid. */
  deferredItems?: CarryBriefDeferredItem[];
  /** Open OWNER DIRECTIVES (EI-11484): explicit owner orders recorded verbatim
   *  (orders:record), still awaiting disposition — the workspace's highest-priority
   *  carry class, rendered ABOVE everything else. */
  directives: OwnerDirectiveRow[];
  /** Total open directives (may exceed directives.length — the fetch is bounded). */
  directivesTotalOpen: number;
  /** Open WALLS (P-006): owner-gated commitments as structured rows, parsed out of
   *  the loop carry-note's `## Walls` section. The brief carries them VERBATIM —
   *  they are open commitments, and prose dissolves them. */
  walls: WallEntry[];
  /** carried CHECKS (cold-carry-system-hardening P-001): external-state claims +
   *  probes, parsed out of the note's `## Checks` section — same structured
   *  delivery as walls so a capped/stale-collapsed note can't dissolve them. */
  checks?: CheckEntry[];
  /** Owner-scoped standing facts — the softer standing-context carrier (structured
   *  walls live in `walls` since P-006; facts remain for everything else).
   *  `sourceRef`/`sourceProvenance` ride along (when the store has them) both
   *  as the input to {@link factsStaleness} and as the verified source quote
   *  rendered at cold-resume time. P-012: carrying a quote all the way to this
   *  object and dropping it in the renderer is indistinguishable from never
   *  having captured it. */
  facts: Array<{
    key: string;
    body: string;
    sourceRef?: string | null;
    sourceProvenance?: FactSourceProvenance | null;
    /**
     * popup-agent-state-coverage-2026-08-18 P-011: the CONTESTED mark from
     * `markContestedFacts` — other agents have already written to this key, or a
     * prior version was settled UNDECIDABLE.
     *
     * It rides HERE rather than being recomputed downstream because the fold's
     * cost property is one BATCHED query for the whole fact set (contested-fold.ts);
     * a per-consumer recompute would multiply it by the number of surfaces. Absent
     * (not false) when the key is uncontested — MARK, NEVER SUPPRESS is the house
     * rule for this family, and an explicit `false` would invite a surface to render
     * a reassuring "uncontested" badge nobody measured.
     */
    contested?: FactContestMark;
  }>;
  /**
   * P-026 leg (b) (WI-5141): embedding staleness verdicts for `facts` above —
   * one entry per fact, `possibly-stale` when its verified typed source has
   * drifted since assert time. Empty/absent when `facts` is empty or nothing
   * in it qualifies (see carry-fact-staleness.ts) — never a failure signal on
   * its own. OPTIONAL (not just empty-array-default) so every pre-existing
   * `CarryBrief` literal (tests, other builders) stays valid without an edit —
   * renderers treat a missing array the same as an empty one.
   */
  factsStaleness?: FactStalenessResult[];
  /**
   * P-029: NEVER-DROP fact KEYS, folded at WORKSPACE **and** OWNER scope.
   *
   * ⚠ NOT a subset of `facts` above, and that gap is the whole reason this
   * field exists. `facts` folds an OWNER selector ONLY, so a never-drop fact
   * asserted at WORKSPACE scope — the scope a fleet-wide guard rail is actually
   * asserted at — reaches turn-start and the leader brief but has never reached
   * this document. The missing thing was the SELECTOR, not the projection,
   * which is why "carry-brief already carries facts" reads like coverage and is
   * not: the two folds ask different questions of the same store.
   *
   * This document's reader is the COLDEST in the system — it rebuilds from the
   * document alone — so it is the reader least able to re-derive a dead-end or
   * a guard rail, and the one for whom the omission is least recoverable. That
   * is EI-18725816532600240's "antidote absent where the poison is strongest",
   * one sink further out than P-025 fixed it for the leader brief.
   *
   * KEYS ONLY, deliberately: bodies are re-fetchable (`facts:list`) and `facts`
   * above is the full-body carrier, whereas what a successor cannot reconstruct
   * is the EXISTENCE of a rail it never saw. Absent (not `[]`) when none apply,
   * so "measured, none apply" is never confused with a degraded read.
   */
  neverDropFacts?: string[];
  /** Armed event awaits (infra inbox-wake rows excluded) — they survive the
   *  boundary and WILL wake the successor. */
  awaits: Array<{ eventKey: string; note: string | null }>;
  /** Fleet membership pointer, when presence carries one. */
  fleet: { slug: string; role: string | null } | null;
}

// ── Bounds ────────────────────────────────────────────────────────────────────

export const CARRY_BRIEF_MAX_HELD_ITEMS = 6;
export const CARRY_BRIEF_MAX_DEFERRED_ITEMS = 6;
export const CARRY_BRIEF_MAX_FACTS = 8;
export const CARRY_BRIEF_MAX_AWAITS = 8;
/** The /compact focus cap — mirrors session:request-compaction's schema cap. */
export const CARRY_BRIEF_FOCUS_MAX = 600;
/** Per-checkpoint render cap in the cold extras (the note is a pointer target,
 *  not the whole state — the full checkpoint is re-injected on item pickup). */
const COLD_CHECKPOINT_CAP = 500;
const COLD_FACT_BODY_CAP = 240;
/** A source quote is evidence, not a second fact body. Keep it useful but bounded. */
const COLD_FACT_SOURCE_QUOTE_CAP = 320;
const COLD_TITLE_CAP = 120;

/**
 * A work-item checkpoint can contain a structured `## Checks` section whose
 * rows are load-bearing state, not narrative padding. The cold carry excerpt
 * is character-capped, so a checkpoint can show a plausible-looking prefix of
 * that section while silently omitting the rest. Keep the existing character
 * disclosure, but add the row-level count that a caller needs before using the
 * excerpt as a `rowsMode:'replace'` source of truth.
 *
 * Count only canonical rows whose complete rendered line survived into the
 * excerpt. A cap can cut through a row, and counting that partial line would
 * overstate what the successor actually received.
 */
function renderCheckpointChecksDisclosure(
  checkpoint: string,
  excerpt: string,
  id: string,
  harness: string | null,
): string {
  const stored = splitCarryNoteChecks(checkpoint).checks;
  if (stored.length === 0 || excerpt.trim() === checkpoint.trim()) return '';
  const shown = stored.filter((check) => excerpt.includes(renderCheckLine(check))).length;
  const hidden = stored.length - shown;
  if (hidden === 0) {
    return `\n    checks: all ${stored.length} stored rows shown above — full set: ${workItemFetchHint(id, harness)}`;
  }
  // EI-22431465725244151: this line used to read "showing 0 of 11 stored rows in
  // this excerpt", which parses as a formatting note about the excerpt above it —
  // not as "there are rows here nobody has read". A reader who has already been
  // shown a fully-rendered `🧪 CARRIED CHECKS` block (the LOOP's set, a DIFFERENT
  // population that renders earlier in this same document) has no cue left that a
  // second set exists at all. Measured cost of that reading: a held item's stored
  // discriminator row went unread, the successor re-derived the lane with the wrong
  // predicate, and wrote a wrong scope claim onto a durable carry surface.
  //
  // So say the two things the old wording did not: these rows are THIS ITEM'S, and
  // some of them have not been shown to anyone.
  return (
    `\n    ⚠ checks: ${hidden} of ${stored.length} rows on THIS ITEM'S checkpoint are NOT shown above` +
    ` — a separate set from the loop's "CARRIED CHECKS" block, and an unread row cannot warn you.` +
    ` Read them before acting on this item: ${workItemFetchHint(id, harness)}`
  );
}
/** An INACTIVE loop's carry-note older than this renders as a labeled STALE
 *  pointer instead of verbatim — a dead lane's "Next action" is history, not the
 *  successor's agenda (2026-07-18: a 3-day-old drill note rode a carry doc as if
 *  current). An ACTIVE loop's note is always rendered in full (it is the
 *  workhorse), as is a recently-ended loop's (still-warm context). */
const INACTIVE_LOOP_NOTE_STALE_MS = 24 * 60 * 60_000;

/**
 * EI-18684357744098956: a held work-item's checkpoint carries the SAME authority
 * whether it is current or SUPERSEDED — nothing distinguishes a checkpoint the
 * session wrote-then-outgrew from one written last. The verified incident: a
 * pre-cut session wrote a checkpoint ("ZERO CODE WRITTEN"), then did real work,
 * then detected the staleness and tried to correct it — but the correction never
 * reached the store, so the successor woke on the stale claim rendered as plain
 * fact, and (holding "I wrote nothing" + "the file exists on disk" simultaneously)
 * misattributed its own work to a peer. A checkpoint whose write-time PREDATES
 * demonstrable subsequent session activity (further transcript turns) by more
 * than this margin cannot be trusted at face value — flag it instead of rendering
 * it as current. The margin absorbs ordinary write/flush latency so a checkpoint
 * written moments before the final turn isn't flagged on clock noise alone.
 *
 * Distinct from (complements, does not duplicate) `turn-end-tracking.ts`'s
 * `isStaleHeldCheckpoint` (P-015): that one compares a checkpoint's age against
 * an absolute now (45min) at turn-end to decide whether to WRITE a fresh
 * mechanical checkpoint. This one compares a checkpoint's write-time against
 * this SAME session's own later activity to decide whether to FLAG it at
 * carry-doc READ time — it catches the incident case a 45min age threshold
 * cannot: a checkpoint that is only seconds-to-minutes old but was already
 * superseded by work later in the very same pre-cut session. */
const HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS = 2 * 60_000;

/**
 * EI-20375177522112122: a cold successor reads its held work-item ids here and
 * has, twice, passed one straight to `coord:declare-intent { items }` — which
 * takes the PLAN-item namespace (P-NNN) and rejects a WI-/EI- id outright. The
 * existing mitigation (EI-21139039044360936) is at the point of FAILURE: the
 * refusal string now names the route. This is the same correction at the point
 * of READ, where the successor still has a choice to make.
 *
 * ⚠ The filing proposed "relocating the join declare-intent already runs for
 * validation". No such join exists: declare-intent rejects a work-item id with
 * a zod REGEX (`/^P-\d{3,}$/`) before any query, and its one DB check
 * (`planItemsForRow`) resolves plan-slug → that plan's parsed items — it never
 * maps a work-item to a plan-item. So nothing is relocated and no query is
 * added: `sourcePlanSlug`/`sourcePlanItemIds` are ALREADY on the held row this
 * renderer loaded (see the held-items SELECT above), and this only renders them.
 *
 * The three states are deliberately distinct. `undefined` means the binding was
 * NOT LOADED (an injected test read may omit the columns), and rendering
 * "no plan-item" for it would assert an absence from a measurement never taken —
 * the false-negative class this repo treats as a defect, not a rounding. Only a
 * loaded-and-empty binding is reported as none.
 */
function renderDeclareIntentLane(h: {
  id: string;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
}): string {
  // Not loaded ⇒ say nothing. Never infer absence from an unasked question.
  if (h.sourcePlanSlug === undefined && h.sourcePlanItemIds === undefined) return '';
  const slug = h.sourcePlanSlug?.trim() || null;
  const items = (h.sourcePlanItemIds ?? []).filter((i) => typeof i === 'string' && i.trim() !== '');
  const never = `${h.id} is a WORK-item id and \`items\` rejects it (P-NNN only)`;
  if (slug && items.length > 0) {
    return (
      `\n    declare-intent lane: plan '${slug}' → ${items.join(', ')} — pass THOSE ids as ` +
      `coord:declare-intent { current_plan_slug: '${slug}', items: [${items.map((i) => `'${i}'`).join(', ')}] }; ${never}.`
    );
  }
  if (slug) {
    // Bound to a plan but carrying no item id: real, and not the same as "none".
    return (
      `\n    declare-intent lane: plan '${slug}', but NO plan-item id is recorded on this row — ` +
      `read plans:items { slug: '${slug}' } to find your P-NNN before declaring a lane; ${never}.`
    );
  }
  return (
    `\n    declare-intent lane: none — this work-item has no plan-item binding, so pass NO \`items\` at all ` +
    `(omit it; \`items: []\` with no plan is a presence re-declaration, not a lane). Name ${h.id} in \`intent\` instead — ` +
    `scheduler:get_next already declared it when it claimed.`
  );
}

/** `HH:MM` (UTC) for the superseded-checkpoint flag — compact, sortable, and
 *  unambiguous next to another such stamp in the same line. */
function fmtClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`;
}

export type CarryBriefHolderFailure =
  | 'missing-proof'
  | 'invalid-proof'
  | 'owner-mismatch'
  | 'workspace-mismatch'
  | 'missing-workspace';

export interface CarryBriefHolderAssessment {
  verified: boolean;
  failure?: CarryBriefHolderFailure;
  holderOwnerId: string | null;
  holderWorkspaceId: string | null;
}

function concreteHolderIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== '*' ? trimmed : null;
}

/**
 * Validate read-time ownership evidence before any carry surface renders an
 * item as the successor's own lane. Missing expected scope or proof is
 * uncertainty, not permission to use the historical first-person wording.
 */
export function assessHeldItemOwnership(
  ownerId: string,
  workspaceId: string | null | undefined,
  item: Pick<CarryBriefHeldItem, 'holderProof'>,
): CarryBriefHolderAssessment {
  const proof = item.holderProof;
  const holderOwnerId = concreteHolderIdentity(proof?.ownerId);
  const holderWorkspaceId = concreteHolderIdentity(proof?.workspaceId);
  if (!proof) {
    return { verified: false, failure: 'missing-proof', holderOwnerId, holderWorkspaceId };
  }
  if (!holderOwnerId || !holderWorkspaceId) {
    return { verified: false, failure: 'invalid-proof', holderOwnerId, holderWorkspaceId };
  }
  const expectedOwnerId = concreteHolderIdentity(ownerId);
  const expectedWorkspaceId = concreteHolderIdentity(workspaceId);
  if (!expectedWorkspaceId) {
    return { verified: false, failure: 'missing-workspace', holderOwnerId, holderWorkspaceId };
  }
  if (!expectedOwnerId || holderOwnerId !== expectedOwnerId) {
    return { verified: false, failure: 'owner-mismatch', holderOwnerId, holderWorkspaceId };
  }
  if (holderWorkspaceId !== expectedWorkspaceId) {
    return { verified: false, failure: 'workspace-mismatch', holderOwnerId, holderWorkspaceId };
  }
  return { verified: true, holderOwnerId, holderWorkspaceId };
}

/**
 * Render only a read-only ownership warning for an unproven carried item.
 * Deliberately omits title/body/checkpoint text: those fields may contain
 * imperatives belonging to another live agent.
 */
export function renderHeldItemOwnershipWarning(
  ownerId: string,
  workspaceId: string | null | undefined,
  item: Pick<CarryBriefHeldItem, 'id' | 'harness' | 'holderProof'>,
  assessment: CarryBriefHolderAssessment = assessHeldItemOwnership(ownerId, workspaceId, item),
): string {
  const expectedWorkspace = concreteHolderIdentity(workspaceId);
  const session = `this session (${ownerId}${expectedWorkspace ? ` in workspace '${expectedWorkspace}'` : ''})`;
  let reason: string;
  switch (assessment.failure) {
    case 'owner-mismatch':
      reason =
        `the snapshot's holder proof names owner '${assessment.holderOwnerId ?? '?'}'` +
        ` in workspace '${assessment.holderWorkspaceId ?? '?'}', not ${session}`;
      break;
    case 'workspace-mismatch':
      reason =
        `the snapshot's holder proof names workspace '${assessment.holderWorkspaceId ?? '?'}'` +
        ` for owner '${assessment.holderOwnerId ?? '?'}', not ${session}`;
      break;
    case 'missing-workspace':
      reason =
        `the snapshot proves a holder (${assessment.holderOwnerId ?? '?'}) but this carry has no ` +
        'concrete workspace to compare against';
      break;
    case 'invalid-proof':
      reason = 'the snapshot carries incomplete or invalid holder proof';
      break;
    case 'missing-proof':
    default:
      reason = 'the snapshot carries no holder proof';
      break;
  }
  return (
    `${item.id} — ${reason}; do NOT edit, claim, or follow its checkpoint. ` +
    `Re-verify live ownership with ${workItemFetchHint(item.id, item.harness)}`
  );
}

// ── Held-items read (shared with the orient recovery fold) ────────────────────

export interface ReadHeldWorkItemsOpts {
  sql?: Sql;
  limit?: number;
  getWorkItemCheckpointWithMetaFn?: (ref: WorkItemCheckpointRef) => Promise<WorkItemCheckpointWithMeta>;
  getWorkItemCheckpointFn?: (ref: {
    harness: string | null;
    workItemId: string;
    workspaceId?: string;
  }) => Promise<string | null>;
}

/**
 * The caller's held (assigned, non-terminal) work-items + checkpoints — the read
 * both this brief and orient's post-compaction recovery fold
 * (compaction-recovery.ts) use, extracted so the two surfaces cannot drift.
 */
export async function readHeldWorkItems(
  ownerId: string,
  workspaceId: string,
  opts: ReadHeldWorkItemsOpts = {},
): Promise<CarryBriefHeldItem[]> {
  const sql = opts.sql ?? getOrgPg().sql;
  const limit = opts.limit ?? CARRY_BRIEF_MAX_HELD_ITEMS;
  // EI-9013: canonicalize the workspace — an unscoped su session's '*' (or a raw
  // ctx pass-through) previously scoped this query + the checkpoint reads to a
  // workspace that holds no rows, so the fold showed NOTHING held.
  const ws = resolveConcreteWorkspaceId(workspaceId);
  // EI-9013: query work_items DIRECTLY, covering BOTH families. The previous read
  // went through the engineer_issues VIEW, which filters item_kind IN
  // ('bug','change','task') — so a held FEATURE/chunk item (e.g. WI-3535, the
  // incident item) never appeared in the fold at all, checkpoint or not. The
  // scope CASE mirrors the view's mapping so harnessOfScope() semantics are
  // unchanged (EI-8813). Terminal filters stay per-family, but BOTH halves now
  // DERIVE from work-item-dispatch-states rather than re-spelling the words.
  // The issue half used to be the view-era literal ('done','resolved',
  // 'deprecated','closed') — a hand-copy of ISSUE_TERMINAL_STATES taken BEFORE
  // EI-21921121818266895 added `dropped` to it. work-item-status-full-unify
  // made `dropped` the issue-family writer's terminal spelling for
  // closed/deprecated inputs, so the stale copy read every dropped issue as
  // STILL HELD (measured 2026-09-22: 12,958 such rows exist). Latent only
  // because a dropped row currently also clears taken_by — derive, so the next
  // terminal spelling cannot reopen it (D-068).
  const held = await sql<Array<{
    issue_id: string;
    title: string | null;
    body: string | null;
    scope: string;
    taken_by: string | null;
    workspace_id: string | null;
    source_plan_slug: string | null;
    source_plan_item_ids: string[] | null;
    last_progress_at?: string | number | Date | null;
  }>>`
    SELECT feature_id AS issue_id,
           title,
           COALESCE(summary, '') AS body,
           taken_by,
           workspace_id,
           last_progress_at,
           CASE
             WHEN harness_slug LIKE 'operator:%' OR harness_slug = '' OR harness_slug IS NULL THEN 'operator'
             ELSE 'harness:' || harness_slug
           END AS scope,
           COALESCE(source_plan_slug, payload -> 'plan_item' ->> 'plan_slug') AS source_plan_slug,
           COALESCE(
             source_plan_item_ids,
             CASE WHEN payload -> 'plan_item' ->> 'item_id' IS NOT NULL
                  THEN ARRAY[payload -> 'plan_item' ->> 'item_id']
                  ELSE NULL END
           ) AS source_plan_item_ids
      FROM harness_shared.work_items
     WHERE taken_by = ${ownerId}
       -- Carry state is workspace-owned. Do not fall back to the legacy/default
       -- partition after resolving a concrete workspace: a duplicated WI-/EI-
       -- id in that partition can belong to a different live holder, and the
       -- successor would receive that peer's checkpoint as if it were its own.
       AND workspace_id = ${ws}
       -- Resource-governor receipts are local queue telemetry, not agent work.
       -- Exclude by the reserved payload marker rather than trusting the outer
       -- status/assignee projection: legacy or partially-reconciled terminal
       -- receipts can still look held to this reader.
       AND NOT jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')
       AND (
         (item_kind IN ('bug', 'change', 'task') AND NOT (status = ANY(${[...ISSUE_TERMINAL_STATES]}::text[])))
         OR (item_kind IN ('feature', 'chunk') AND NOT (status = ANY(${[...FEATURE_TERMINAL_STATES]}::text[])))
       )
     ORDER BY feature_id DESC
     LIMIT ${limit}
  `;
  // P-003 (fleet-deltas-leader-primitives): the default read carries the checkpoint's
  // write instant (getWorkItemCheckpointWithMeta) so the compaction gate can flag a
  // STALE checkpoint, not just a missing one. An injected test fn (string-only) keeps
  // the legacy shape — its meta stays null.
  const getCheckpointWithMeta: (ref: WorkItemCheckpointRef) => Promise<WorkItemCheckpointWithMeta> =
    opts.getWorkItemCheckpointWithMetaFn ?? (opts.getWorkItemCheckpointFn
    ? async (ref: { harness: string | null; workItemId: string; workspaceId?: string }) => ({
        checkpoint: await opts.getWorkItemCheckpointFn!(ref),
        updatedAtMs: null as number | null,
      })
    : async (ref: { harness: string | null; workItemId: string; workspaceId?: string }) => {
        const { getWorkItemCheckpointWithMeta } = await import('./work-item-checkpoint');
        return getWorkItemCheckpointWithMeta(ref);
      });
  const out: CarryBriefHeldItem[] = [];
  for (const h of held) {
    // EI-8813: reuse the SAME scope→harness resolution the write/read paths use
    // (harnessOfScope — null for the explicit global `operator` scope), instead of
    // an ad-hoc parse that defaulted a harness-null item to the literal string
    // 'papercup' (misspelled, and not even the checkpoint store's wildcard sentinel).
    // That mismatched harness silently orphaned the checkpoint from THIS read path
    // only — work_items:checkpoint/get already canonicalize correctly (EI-8805).
    const harness = harnessOfScope(h.scope ?? '');
    let checkpoint: string | null = null;
    let checkpointUpdatedAtMs: number | null = null;
    let checkpointReadFailed = false;
    try {
      const meta = await getCheckpointWithMeta({ harness, workItemId: h.issue_id, workspaceId: ws });
      checkpointReadFailed = meta.readFailed === true;
      checkpoint = checkpointReadFailed ? null : meta.checkpoint;
      checkpointUpdatedAtMs = checkpointReadFailed ? null : meta.updatedAtMs;
    } catch {
      checkpointReadFailed = true;
    }
    const holderProof =
      concreteHolderIdentity(h.taken_by) && concreteHolderIdentity(h.workspace_id)
        ? { ownerId: h.taken_by!, workspaceId: h.workspace_id! }
        : null;
    out.push({
      id: h.issue_id,
      title: h.title,
      body: h.body,
      harness,
      checkpoint,
      checkpointUpdatedAtMs,
      ...(checkpointReadFailed ? { checkpointReadFailed: true } : {}),
      ...(h.last_progress_at !== undefined ? { lastProgressAtMs: epochMs(h.last_progress_at) } : {}),
      ...(holderProof ? { holderProof } : {}),
      ...(h.source_plan_slug !== undefined ? { sourcePlanSlug: h.source_plan_slug } : {}),
      ...(h.source_plan_item_ids !== undefined ? { sourcePlanItemIds: h.source_plan_item_ids } : {}),
    });
  }
  return out;
}

// ── Deferred-work read (shared by carry surfaces and wind-down receipts) ──────

export interface ReadDeferredWorkItemsOpts {
  sql?: Sql;
  limit?: number;
  /**
   * Test/host seam for the current session incarnation. `undefined` means read
   * the latest unended adv_sessions row; `null` intentionally means that the
   * session start could not be established, so no deferred-work claim is made.
   */
  sessionStartedAtMs?: number | null;
  getCurrentSessionStartedAtMsFn?: (
    ownerId: string,
    workspaceId: string,
  ) => Promise<number | null>;
}

function epochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve the current session incarnation from the authoritative adv_sessions
 * log. `started_at` is the latest activation boundary for this owner (resume
 * re-activations update it); an absent/unreadable row is UNKNOWN, not proof
 * that the owner filed nothing.
 */
/**
 * P-029: the CARRY-DOCUMENT sink's consumer of the shared `neverDropFacts`
 * declaration.
 *
 * ⚠ HOW THIS CONSUMES THE SHARED REGISTRY — plan decision D-053. The registry
 * (P-023 / D-015) declares each orientation class ONCE and every applicable
 * surface renders it FROM that declaration. But its segments are LINE-oriented
 * (`render` returns `string[]`), while the carry document is assembled as a
 * structured {@link CarryBrief} and emitted by its own cold-resume renderer. So
 * this sink consumes the declaration through `RegisteredOrientationClass.id`
 * (typed `keyof OrientationState`) and NOT through `segments[].render` —
 * pushing a turn-start-shaped line into this document would be precisely the
 * "second copy of the line" the registry exists to prevent. Same shape as
 * `readLeaderNeverDropFacts`; D-053 rules both truthful.
 *
 * Reading the registry for applicability instead of hardcoding the class is what
 * makes withdrawing this sink a ONE-LINE change in the registry with no second
 * edit here.
 *
 * ⚠ THE SELECTORS ARE THE SUBSTANTIVE PART, not the fold. They mirror
 * turn-start's and the leader brief's — WORKSPACE scope plus this owner's — and
 * that is exactly what this document lacked: `buildCarryBrief`'s general `facts`
 * fold passes an OWNER selector only, so a workspace-scoped guard rail reached
 * the other two sinks and never this one. Do NOT "simplify" this into that fold:
 * `facts` carries full bodies + contested marks under a different cap and serves
 * a different section, so collapsing them would trade one gap for another.
 */
export async function readCarryNeverDropFacts(
  input: { ownerId: string; workspaceId: string | undefined },
  deps: {
    fold?: typeof foldNeverDropFacts;
    registry?: readonly RegisteredOrientationClass[];
    sql?: Sql;
  } = {},
): Promise<string[] | undefined> {
  const registry = deps.registry ?? ORIENTATION_CLASS_REGISTRY;
  const declared = registry.some(
    (entry) => entry.id === 'neverDropFacts' && entry.applicableSinks.includes('carry-brief'),
  );
  // Not declared for this sink ⇒ carry nothing, with no second edit needed here.
  if (!declared) return undefined;
  const fold = deps.fold ?? foldNeverDropFacts;
  const selectors = [
    { scope: 'workspace' as const },
    ...(input.ownerId ? [{ scope: 'owner' as const, scopeRef: input.ownerId }] : []),
  ];
  const facts = await fold(selectors, { workspaceId: input.workspaceId }, deps.sql);
  const keys = facts.map((fact) => fact.key).filter((key): key is string => Boolean(key));
  // Deduped because one key can legitimately resolve from BOTH selectors; sorted
  // so the document is stable across fold order and a diff means a real change.
  const unique = [...new Set(keys)].sort();
  // Successful-empty is ABSENT, not `[]`: an empty array in this document reads
  // as "measured, none apply", which is indistinguishable from a degraded read.
  return unique.length > 0 ? unique : undefined;
}

export async function readCurrentSessionStartedAtMs(
  ownerId: string,
  workspaceId: string,
  opts: Pick<ReadDeferredWorkItemsOpts, 'sql'> = {},
): Promise<number | null> {
  if (!ownerId) return null;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const ws = resolveConcreteWorkspaceId(workspaceId);
    const rows = await sql<Array<{ started_at_ms: number | string | null }>>`
      SELECT (extract(epoch FROM started_at) * 1000)::bigint AS started_at_ms
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${ws}
         AND coord_owner_id = ${ownerId}
         AND ended_at IS NULL
       ORDER BY started_at DESC, id DESC
       LIMIT 1
    `;
    return epochMs(rows[0]?.started_at_ms);
  } catch {
    return null;
  }
}

/**
 * Read this session's deliberately deferred work. The query is intentionally
 * base-table + thread-store based:
 *
 * - issue-family rows carry authorship in payload._ei.created_by;
 * - feature-family rows have no authorship column, so their positive signal is
 *   a comment post authored by this owner;
 * - both families' comment threads have stable ids/parent refs;
 * - terminal and held rows are excluded in SQL, before the bounded result.
 *
 * A missing current-session boundary returns an empty result rather than
 * claiming an arbitrary backlog row. All read failures are fail-soft for the
 * boundary builders that consume this helper.
 */
export async function readDeferredWorkItems(
  ownerId: string,
  workspaceId: string,
  opts: ReadDeferredWorkItemsOpts = {},
): Promise<CarryBriefDeferredItem[]> {
  if (!ownerId) return [];
  let sql: Sql;
  let ws: string;
  try {
    sql = opts.sql ?? getOrgPg().sql;
    ws = resolveConcreteWorkspaceId(workspaceId);
  } catch {
    return [];
  }
  let sessionStartedAtMs: number | null;
  try {
    sessionStartedAtMs =
      opts.sessionStartedAtMs !== undefined
        ? opts.sessionStartedAtMs
        : opts.getCurrentSessionStartedAtMsFn
          ? await opts.getCurrentSessionStartedAtMsFn(ownerId, ws)
          : await readCurrentSessionStartedAtMs(ownerId, ws, { sql });
  } catch {
    return [];
  }
  if (sessionStartedAtMs == null || !Number.isFinite(sessionStartedAtMs)) return [];

  const requestedLimit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.floor(opts.limit)
      : CARRY_BRIEF_MAX_DEFERRED_ITEMS;
  const limit = Math.min(CARRY_BRIEF_MAX_DEFERRED_ITEMS, Math.max(1, requestedLimit));
  const terminalStates = [...ANY_FAMILY_TERMINAL_STATES];
  try {
    const rows = await sql<
      Array<{
        id: string;
        title: string | null;
        body: string | null;
        harness_slug: string | null;
        kind: string | null;
        created_this_session: boolean;
        commented_this_session: boolean;
      }>
    >`
      WITH candidates AS (
        SELECT wi.feature_id AS id,
               wi.title,
               wi.summary AS body,
               wi.harness_slug,
               wi.item_kind AS kind,
               true AS created_this_session,
               false AS commented_this_session
          FROM harness_shared.work_items AS wi
         WHERE wi.workspace_id = ${ws}
           AND wi.item_kind IN ('bug', 'change', 'task')
           AND NULLIF(wi.payload #>> '{_ei,created_by}', '') = ${ownerId}
           AND wi.created_ts >= ${Math.floor(sessionStartedAtMs)}
           AND (
             wi.taken_by IS NULL
             OR btrim(wi.taken_by) = ''
             OR lower(btrim(wi.taken_by)) = 'unassigned'
           )
           AND (wi.status IS NULL OR wi.status <> ALL(${terminalStates}::text[]))
        UNION ALL
        SELECT wi.feature_id AS id,
               wi.title,
               wi.summary AS body,
               wi.harness_slug,
               wi.item_kind AS kind,
               false AS created_this_session,
               true AS commented_this_session
          FROM harness_shared.coord_thread_posts AS post
          JOIN harness_shared.coord_threads AS thread
            ON thread.workspace_id = post.workspace_id
           AND thread.thread_id = post.thread_id
          JOIN harness_shared.work_items AS wi
            ON wi.workspace_id = thread.workspace_id
           AND (
             (
               thread.parent_kind = 'issue'
               AND wi.item_kind IN ('bug', 'change', 'task')
               AND thread.parent_ref = wi.feature_id
             )
             OR (
               thread.parent_kind = 'feature'
               AND wi.item_kind IN ('feature', 'chunk')
               AND thread.parent_ref = wi.harness_slug || '#' || wi.feature_id
             )
           )
         WHERE post.workspace_id = ${ws}
           AND post.author_id = ${ownerId}
           AND post.created_at >= to_timestamp(${sessionStartedAtMs}::double precision / 1000.0)
           AND (
             wi.taken_by IS NULL
             OR btrim(wi.taken_by) = ''
             OR lower(btrim(wi.taken_by)) = 'unassigned'
           )
           AND (wi.status IS NULL OR wi.status <> ALL(${terminalStates}::text[]))
      ), touched AS (
        SELECT id,
               title,
               body,
               harness_slug,
               kind,
               bool_or(created_this_session) AS created_this_session,
               bool_or(commented_this_session) AS commented_this_session
          FROM candidates
         GROUP BY id, title, body, harness_slug, kind
      )
      SELECT id,
             title,
             body,
             harness_slug,
             kind,
             created_this_session,
             commented_this_session
        FROM touched
       ORDER BY id DESC
       LIMIT ${limit}
    `;
    return rows.map((row) => {
      const created = row.created_this_session === true;
      const commented = row.commented_this_session === true;
      const source: CarryBriefDeferredSource =
        created && commented ? 'created-and-commented' : created ? 'created' : 'commented';
      const rawHarness = row.harness_slug?.trim() ?? '';
      return {
        id: row.id,
        title: row.title ?? null,
        body: row.body ?? null,
        harness: rawHarness && !rawHarness.startsWith('operator:') ? rawHarness : null,
        kind: row.kind?.trim() || 'work-item',
        source,
      };
    });
  } catch {
    return [];
  }
}

const IDLE_NOTE_CLAIM_RE =
  /\b(?:nothing\s+(?:is\s+)?(?:in\s+flight|left|pending|outstanding|remains)|no\s+(?:work|items?)(?:\s+(?:is|are))?\s+(?:in\s+flight|left|pending|outstanding|to\s+do)|(?:queue|lane)\s+is\s+empty|pick\s+fresh\s+work|fresh\s+work\s+only)\b/i;

export interface DeferredWorkIdleNoteGuard {
  flagged: true;
  trigger: string;
  deferredIds: string[];
  message: string;
}

/**
 * Falsifiable guard for the exact dangerous universal: an idle-sounding
 * carry-note while the same session has positively touched open work it does
 * not hold. It is advisory; the returned ids are the falsifier, not a
 * replacement for reading each item's current state.
 */
export function detectIdleNoteGuard(
  note: string | null | undefined,
  deferredItems: readonly CarryBriefDeferredItem[],
): DeferredWorkIdleNoteGuard | null {
  if (!note?.trim() || deferredItems.length === 0) return null;
  const match = note.match(IDLE_NOTE_CLAIM_RE);
  if (!match) return null;
  const ids = deferredItems.map((item) => item.id);
  return {
    flagged: true,
    trigger: match[0],
    deferredIds: ids,
    message:
      `idle_note_guard: the carry-note says "${match[0]}", but this session filed or commented on ` +
      `${ids.length} non-terminal unheld work-item(s) (${ids.join(', ')}). ` +
      'That is not a clean idle verdict: re-check each item and either claim/checkpoint the intended remainder or deliberately settle it.',
  };
}

function deferredSourceText(source: CarryBriefDeferredSource): string {
  switch (source) {
    case 'created':
      return 'filed this session';
    case 'commented':
      return 'commented on this session';
    default:
      return 'filed and commented on this session';
  }
}

/** Render deferred work as a bounded pointer list, shared by all carry readers. */
export function renderDeferredWorkItems(
  deferredItems: readonly CarryBriefDeferredItem[],
): string {
  if (deferredItems.length === 0) return '';
  const lines = deferredItems.map((item) => {
    const title = item.title?.trim() ? ` — ${cap(item.title, COLD_TITLE_CAP)}` : '';
    return `  • ${item.id}${title} — ${deferredSourceText(item.source)} (${workItemFetchHint(item.id, item.harness)})`;
  });
  return (
    `⚠ DEFERRED, UNCLAIMED WORK — this session positively touched ${deferredItems.length} ` +
    'non-terminal work-item(s) that it does not currently hold. Re-check before declaring the lane idle:\n' +
    lines.join('\n')
  );
}

// ── Build ─────────────────────────────────────────────────────────────────────

export interface BuildCarryBriefOpts {
  sql?: Sql;
  workspaceId?: string;
  // Test seams — each defaults to the real reader.
  getLoopStatusFn?: (
    ownerId: string,
  ) => Promise<{
    harnessSlug: string;
    active: boolean;
    intervalSec: number | null;
    /** Persisted loop lifecycle; optional on test seams for legacy fixtures. */
    carry?: 'warm' | 'cold';
    /** EI-20072281215342526: the MISSION. Optional on the seam (not on `LoopStatus`,
     *  where it is required) so an existing test stub keeps compiling — a stub that
     *  omits it is stating "this test does not exercise the goal", which is honest,
     *  whereas the real reader always has one to give. */
    goal?: string | null;
  } | null>;
  getLoopCarryNoteWithMetaFn?: (ref: {
    harness: string;
    ownerId: string;
  }) => Promise<LoopCarryNoteWithMeta>;
  readHeldWorkItemsFn?: typeof readHeldWorkItems;
  readByocReleaseCarriesFn?: (
    ownerId: string,
    workspaceId: string,
    heldWorkItemIds: readonly string[],
  ) => Promise<ByocReleaseCarrySnapshot[]>;
  readDeferredWorkItemsFn?: typeof readDeferredWorkItems;
  listOwnerFactsFn?: (
    ownerId: string,
    workspaceId: string | undefined,
  ) => Promise<
    Array<{
      key: string;
      body: string;
      sourceRef?: string | null;
      sourceProvenance?: FactSourceProvenance | null;
      contested?: FactContestMark;
    }>
  >;
  /** P-026 leg (b) (WI-5141): injectable staleness checker — defaults to the
   *  real {@link checkCarriedFactsStaleness} (which itself resolves the real
   *  embedder unless `checkFactsStalenessFn` is supplied, e.g. in tests). */
  checkFactsStalenessFn?: typeof checkCarriedFactsStaleness;
  listActiveAwaitsFn?: (
    ownerId: string,
  ) => Promise<Array<{ eventKey: string; note: string | null }>>;
  getFleetFn?: (ownerId: string) => Promise<{ slug: string; role: string | null } | null>;
  listOpenDirectivesFn?: (
    workspaceId: string,
  ) => Promise<{ rows: OwnerDirectiveRow[]; totalOpen: number }>;
  /** P-002 seam: hydrate WI-/EI- ids cited in the carry note into live one-liners.
   *  Defaults to the P-008 detect→hydrate→render pipeline. */
  hydrateNoteRefsFn?: (
    noteText: string,
    heldItems?: readonly CarryBriefHeldItem[],
  ) => Promise<string[]>;
  /** P-003 seam: read directed inbox mail strictly after `sinceIso` (bounded).
   *  Defaults to the coordination inbox reader. */
  readPostNoteInboxFn?: (
    ownerId: string,
    sinceIso: string,
  ) => Promise<{ count: number; lines: string[] }>;
}

/** P-003 render bounds: at most this many post-note message lines, each clipped. */
const POST_NOTE_INBOX_MAX_LINES = 3;
const POST_NOTE_INBOX_LINE_CHARS = 150;

/**
 * Render one post-note message for the carry brief.
 *
 * The sender is actionable recovery state: a successor may need to reply to
 * this exact directed message with `coord:send`. Do not prefix-truncate it.
 * The old 12-character display prefix turned distinct owners such as
 * `su-respawn-1-…` into the same ambiguous recipient, so the successor had to
 * perform another roster lookup before it could answer. Keep the line bounded
 * by shortening only the message text after the complete sender and timestamp.
 */
export function renderPostNoteInboxLine(e: Record<string, unknown>): string {
  const from = typeof e.from === 'string' && e.from.length > 0 ? e.from : '?';
  const ts = typeof e.ts === 'string' ? e.ts : '';
  const text =
    (typeof e.summary === 'string' && e.summary) || (typeof e.body === 'string' && e.body) || '';
  const clippedText = text.replace(/\s+/g, ' ').trim();
  const prefix = `- ${from} (${ts}): `;
  const textBudget = POST_NOTE_INBOX_LINE_CHARS - prefix.length;
  // Owner ids are normally short enough to leave room for text. If a future
  // owner-id format consumes the whole line, preserve the exact sender rather
  // than clipping it into an unusable identifier.
  if (textBudget <= 0) return prefix;
  if (clippedText.length <= textBudget) return `${prefix}${clippedText}`;
  return `${prefix}${clippedText.slice(0, Math.max(0, textBudget - 1))}…`;
}

/** Default P-002 hydrator: P-008 reuse end-to-end (detect → hydrate → render one-liners).
 *  Lazy imports keep the coordination edge off the brief's cold path; any failure ⇒ [].
 *
 *  Returns BARE `label: "snippet"` strings (no leading glyph) — the seam's contract
 *  (see carry-brief.test.ts's hydrateNoteRefsFn mocks) is that the RENDERER adds the
 *  single `↪ ` prefix. This used to call ref-hydrate's `renderHydratedRef`, which
 *  ALSO prefixes `↪ ` — doubling the glyph in every real (non-test) carry doc
 *  ("↪ ↪ EI-… [bug/done]: …", found while fixing EI-18726068732447732). */
const CARRY_NOTE_REF = /\b(?:WI|EI)-\d+\b|\bplan:[a-z0-9][a-z0-9-]*#P-\d{3,}\b|\bP-\d{3,}\b/gi;

/**
 * Resolve references in note prose without guessing. WI-/EI- ids are global;
 * explicit plan:<slug>#P-NNN refs are complete; a bare P-NNN is admitted only
 * when exactly one HELD work-item binds that id to a source plan. If two held
 * lanes both contain P-007, ambiguity stays visible as an unresolved prose id
 * instead of silently choosing the wrong plan.
 */
export function detectCarryNoteRefs(
  noteText: string,
  heldItems: readonly CarryBriefHeldItem[],
): HydratableRef[] {
  const refs: HydratableRef[] = [];
  const seen = new Set<string>();
  for (const match of noteText.matchAll(CARRY_NOTE_REF)) {
    const token = match[0];
    if (/^(?:WI|EI)-/i.test(token)) {
      const id = token.toUpperCase();
      const key = `work-item:${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ kind: 'work-item', id });
      }
      continue;
    }
    if (/^plan:/i.test(token)) {
      const parsed = /^plan:([a-z0-9][a-z0-9-]*)#(P-\d{3,})$/i.exec(token);
      if (!parsed) continue;
      const slug = parsed[1].toLowerCase();
      const item = parsed[2].toUpperCase();
      const key = `plan-item:${slug}#${item}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ kind: 'plan-item', slug, item });
      }
      continue;
    }
    const item = token.toUpperCase();
    const bindings = new Map<string, { slug: string; item: string }>();
    for (const held of heldItems) {
      if (!held.sourcePlanSlug || !(held.sourcePlanItemIds ?? []).includes(item)) continue;
      const binding = { slug: held.sourcePlanSlug, item };
      bindings.set(`${binding.slug}#${binding.item}`, binding);
    }
    if (bindings.size !== 1) continue;
    const binding = [...bindings.values()][0];
    const key = `plan-item:${binding.slug}#${binding.item}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ kind: 'plan-item', ...binding });
    }
  }
  return refs;
}

async function defaultHydrateNoteRefs(
  noteText: string,
  heldItems: readonly CarryBriefHeldItem[],
): Promise<string[]> {
  try {
    const [{ hydrateRefs, makePlanItemResolver }] = await Promise.all([
      import('./agent-tools/coordination/ref-hydrate-resolve'),
    ]);
    const refs = detectCarryNoteRefs(noteText, heldItems);
    if (refs.length === 0) return [];
    const planItemResolver: import('./agent-tools/coordination/ref-hydrate-resolve').RefResolver =
      async (ref, budget) => {
        if (ref.kind !== 'plan-item') return null;
        const held = heldItems.find(
          (item) =>
            item.sourcePlanSlug === ref.slug && (item.sourcePlanItemIds ?? []).includes(ref.item),
        );
        return makePlanItemResolver(held?.harness ?? undefined)(ref, budget);
      };
    const hydrated = await hydrateRefs(refs, { resolvers: { 'plan-item': planItemResolver } });
    return hydrated.filter((h) => h.ok).map((h) => (h.snippet ? `${h.label}: "${h.snippet}"` : h.label));
  } catch {
    return [];
  }
}

/** Parse a cited-ref line's bracketed `[kind/state]` tag — the shape
 *  `defaultWorkItemResolver` / `bodyRefWorkItemResolver` emit as
 *  `<id> [<kind>/<state>...]`. Regex-only (never throws); returns null for a
 *  line with no recognizable id or tag (a custom hydrator, or a non-work-item
 *  ref shape) so callers degrade to "not terminal" rather than misfire. */
const CITED_REF_ID = /\b((?:WI|EI|F)-\d+)\b/;
const CITED_REF_STATE_TAG = /\[[a-z0-9_]+\/([a-z0-9_-]+)/i;
export function parseCitedRefStateTag(line: string): { id: string; state: string } | null {
  const idMatch = CITED_REF_ID.exec(line);
  const stateMatch = CITED_REF_STATE_TAG.exec(line);
  if (!idMatch || !stateMatch) return null;
  return { id: idMatch[1], state: stateMatch[1] };
}

const CITED_PLAN_ITEM_STATE_TAG = /\b(plan:([a-z0-9][a-z0-9-]*)#(P-\d{3,}))\s+\[([a-z0-9_-]+)\]/i;

/** Work-item and plan-item sibling used by the carry renderer. `mention` is the
 * exact token expected in note prose; plan labels retain the qualified id for
 * diagnostics while matching the bare P-NNN the author actually wrote. */
export function parseCitedLiveState(
  line: string,
): { id: string; mention: string; state: string } | null {
  const workItem = parseCitedRefStateTag(line);
  if (workItem) return { ...workItem, mention: workItem.id };
  const planItem = CITED_PLAN_ITEM_STATE_TAG.exec(line);
  if (!planItem) return null;
  return {
    id: planItem[1],
    mention: planItem[3].toUpperCase(),
    state: planItem[4],
  };
}

/**
 * Which of `citedRefs` cite a work-item whose LIVE state (as already resolved
 * by the fold) is terminal — the P-002 stale-imperative contradiction detector
 * (EI-18726068732447732): a cold carry-note's own prose can still instruct
 * action ("complete WI-NNN", "verify then close it") on an id the SAME brief's
 * fold already resolves as done/dropped/etc. The fold has the answer at render
 * time; this just joins it against the ids the note cites instead of printing
 * both and letting the reader reconcile them. Pure + derived from
 * ANY_FAMILY_TERMINAL_STATES (never re-list the words) so it's independently
 * unit-testable and can't drift from the canonical terminal vocabulary.
 */
export function detectTerminalCitedRefs(citedRefs: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of citedRefs) {
    const tag = parseCitedLiveState(line);
    if (tag && ANY_FAMILY_TERMINAL_STATES.includes(tag.state)) out.push(tag.id);
  }
  return out;
}

/** Put the live contradiction where stale prose is consumed, not only in a
 * later summary block. Each affected note line gets one compact suffix; active
 * refs remain in the existing LIVE-status block without noisy inline badges. */
export function annotateCarryNoteLiveContradictions(
  noteText: string,
  citedRefs: readonly string[],
): string {
  const terminal = citedRefs
    .map(parseCitedLiveState)
    .filter(
      (tag): tag is { id: string; mention: string; state: string } =>
        tag != null && ANY_FAMILY_TERMINAL_STATES.includes(tag.state),
    );
  if (terminal.length === 0) return noteText;
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return noteText
    .split('\n')
    .map((line) => {
      if (line.includes('⚠ LIVE:')) return line;
      const hits = terminal.filter((tag) =>
        new RegExp(`\\b${escapeRegex(tag.mention)}\\b`, 'i').test(line),
      );
      if (hits.length === 0) return line;
      return `${line}   ⚠ LIVE: ${hits.map((tag) => `${tag.id} status=${tag.state}`).join('; ')}`;
    })
    .join('\n');
}

/**
 * The cited-ref LIVENESS sections — the stale-note contradiction banner (only
 * when the note cites an already-terminal id) followed by the LIVE-status block
 * for every id it cites. ONE implementation, TWO consumers: the carry-respawn
 * document (`renderCarryBriefText`, which places it inline directly after the
 * note) and the COLD LOOP WAKE extras (`renderCarryBriefColdExtras`).
 *
 * EI-19362981097884026: those two renderers had silently drifted apart.
 * `buildCarryBrief` resolves `citedRefs` for BOTH paths — the cold wake pays for
 * that hydration like everyone else — but only the respawn document ever
 * consumed it, so a cold wake reproduced its note's "Next action" verbatim with
 * no liveness signal on the single field that DIRECTS the whole turn. Measured
 * live on this lane (cold fire #71): the note cited FIVE ids that were already
 * `done` and rendered none of them as terminal, while the respawn document for
 * the SAME session annotated them correctly — same data, two renderers, one
 * answer. Sharing the renderer is what stops them drifting again; a second copy
 * of this block would just re-arm the bug.
 *
 * Returns [] for an empty ref list, so a caller can splat it unconditionally.
 */
export function renderCitedRefLivenessSections(citedRefs: readonly string[]): string[] {
  if (citedRefs.length === 0) return [];
  const sections: string[] = [];
  const terminalIds = detectTerminalCitedRefs(citedRefs);
  if (terminalIds.length > 0) {
    // EI-18726068732447732: the note's own imperatives ("complete WI-NNN",
    // "verify then close it") can target an id the fold below ALREADY resolves
    // as terminal — flag the contradiction loudly, right at the point a reader
    // would otherwise just follow the stale prose.
    const idList = terminalIds.join(', ');
    const plural = terminalIds.length > 1;
    sections.push(
      `⚠⚠ STALE-NOTE CONTRADICTION: the note above may still instruct action on ${idList} — ` +
        `but the LIVE status below shows ${plural ? 'they are' : 'it is'} already TERMINAL. ` +
        `Do NOT follow any instruction to complete/verify/close/work on ${plural ? 'them' : 'it'}; ` +
        `treat ${plural ? 'them' : 'it'} as already resolved and re-orient before acting on the rest of the note.`,
    );
  }
  sections.push(
    `Cited in the note — LIVE status (trust these over the note's phrasing):\n` +
      citedRefs
        .map((l) => {
          const tag = parseCitedLiveState(l);
          const flagged = !!tag && ANY_FAMILY_TERMINAL_STATES.includes(tag.state);
          return `  ${flagged ? '⚠ TERMINAL ' : ''}↪ ${l}`;
        })
        .join('\n'),
  );
  return sections;
}

/** Retraction-shaped language in a post-note message — "retract", "I was wrong",
 *  "supersede", etc. A post-note message merely EXISTING is already flagged (the
 *  generic P-003 list below); this distinguishes the subset that specifically
 *  WITHDRAWS a prior claim, so the render can surface it loudly right next to
 *  the note's imperative instead of leaving it to be discovered only inside a
 *  list the reader may not fully read (EI-19408487308624743: a carry-note's own
 *  imperative kept marching orders on a premise a peer had retracted 55s before
 *  the note was built — the retraction was present, but only as one bullet
 *  inside the generic "N messages landed after" list below the imperative). */
const RETRACTION_LANGUAGE_RE =
  /\b(retract(?:ed|ing|ion)?|correction|corrected|superse(?:de[sd]?|ded|ding)|i was wrong|no longer (?:true|valid|applies)|disregard|withdraw(?:n|al|ing)?|scratch that)\b/i;

export function detectRetractionShapedLines(lines: readonly string[]): string[] {
  return lines.filter((l) => RETRACTION_LANGUAGE_RE.test(l));
}

/** Default P-003 reader: directed non-own mail strictly after `sinceIso`, bounded.
 *  Review fold #7: filtered through the continuation gate's isPendingInterrupt —
 *  categorized system broadcasts / auto lifecycle chatter / intent declares are
 *  presence machinery, not "the note predates N messages" evidence (the raw inbox
 *  held 10.7k rows with 4.6k ambient the night this shipped — an unfiltered count
 *  is pure noise). */
async function defaultReadPostNoteInbox(
  ownerId: string,
  sinceIso: string,
): Promise<{ count: number; lines: string[] }> {
  const [{ readInbox }, { isPendingInterrupt }] = await Promise.all([
    import('./agent-tools/coordination/messages'),
    import('./agent-tools/coordination/tools/continuation-gate'),
  ]);
  const entries = await readInbox(ownerId, { since_ts: sinceIso, excludeOwn: true });
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => isPendingInterrupt(e as never));
  const lines = rows.slice(-POST_NOTE_INBOX_MAX_LINES).map(renderPostNoteInboxLine);
  return { count: rows.length, lines };
}

/** Awaits the engine arms for itself (the always-on inbox wake) — infrastructure,
 *  not session state worth a line of the brief. */
function isInfraAwait(eventKey: string): boolean {
  return eventKey.startsWith('coord:inbox-wake:');
}

async function bestEffort<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

type CarryLoopRead = Pick<CarryBrief, 'loop' | 'walls'> & Partial<Pick<CarryBrief, 'checks'>>;

/**
 * Assemble the caller's carry brief. Every leg is independently best-effort: a
 * throwing reader yields that section empty, never a failed brief — this runs at
 * the worst possible moments (context exhausted, session about to reset).
 */
export async function buildCarryBrief(ownerId: string, opts: BuildCarryBriefOpts = {}): Promise<CarryBrief> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId() ?? 'default';
  let concreteWorkspaceId: string | null = null;
  try {
    concreteWorkspaceId = resolveConcreteWorkspaceId(workspaceId);
  } catch {
    /* a missing workspace proof keeps held-item rendering read-only */
  }
  const brief: CarryBrief = {
    ownerId,
    ...(concreteWorkspaceId ? { workspaceId: concreteWorkspaceId } : {}),
    loop: null,
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    factsStaleness: [],
    awaits: [],
    fleet: null,
  };

  // These seven roots have no data dependency on one another. Start all of
  // them before awaiting any result; the old serial fold made carry latency the
  // sum of every store read and put a multi-second query directly on HUD Orders.
  const directivesPromise = bestEffort(
    async () => {
      // EI-11484: open owner directives — the highest-priority carry class. The
      // read is workspace-scoped (NOT loop/session-scoped) on purpose: a
      // directive must survive the recording session's death.
      const listDirectives =
        opts.listOpenDirectivesFn ??
        (async (ws: string) => {
          const { listOpenOwnerDirectives, countOpenOwnerDirectives, OWNER_DIRECTIVES_RENDER_MAX_ROWS } =
            await import('./owner-directives');
          // Workspace-scoped, but rendered FOR this owner: rows THIS session
          // cleared off its own agenda drop out (P-008 / D-008). That is not a
          // narrowing of the survives-its-recorder rule above — the directive
          // stays open, and every other session still carries it.
          const rows = await listOpenOwnerDirectives(ws, OWNER_DIRECTIVES_RENDER_MAX_ROWS, opts.sql, ownerId);
          const totalOpen =
            rows.length >= OWNER_DIRECTIVES_RENDER_MAX_ROWS
              ? await countOpenOwnerDirectives(ws, opts.sql, ownerId).catch(() => rows.length)
              : rows.length;
          return { rows, totalOpen };
        });
      return listDirectives(workspaceId);
    },
    { rows: [] as OwnerDirectiveRow[], totalOpen: 0 },
  );

  const loopPromise = bestEffort(
    async (): Promise<CarryLoopRead> => {
      const getStatus =
        opts.getLoopStatusFn ??
        (async (id: string) => {
          const { getLoopStatus } = await import('./harness/routines/loop');
          return getLoopStatus(id, { sql: opts.sql });
        });
      const loop = await getStatus(ownerId);
      if (!loop) return { loop: null, walls: [] };
      const getNote = opts.getLoopCarryNoteWithMetaFn ?? getLoopCarryNoteWithMeta;
      const meta = await getNote({ harness: loop.harnessSlug, ownerId }).catch(
        (): LoopCarryNoteWithMeta => ({ note: null, updatedAtMs: null, readFailed: true }),
      );
      const carryNoteReadFailed = meta.readFailed === true;
      const carryNote = carryNoteReadFailed ? null : meta.note;
      return {
        loop: {
          harness: loop.harnessSlug,
          active: Boolean(loop.active),
          intervalSec: loop.intervalSec ?? null,
          carry: loop.carry,
          goal: loop.goal ?? null,
          carryNote,
          carryNoteUpdatedAtMs: carryNoteReadFailed ? null : meta.updatedAtMs,
          carryNoteReadFailed,
        },
        // P-006/P-001 delivery parity: walls and checks share the same structured
        // extraction as before; only their scheduling changed.
        walls: splitCarryNoteWalls(carryNote).walls,
        checks: splitCarryNoteChecks(carryNote).checks,
      };
    },
    { loop: null, walls: [] },
  );

  const heldItemsPromise = bestEffort(async () => {
    const readHeld = opts.readHeldWorkItemsFn ?? readHeldWorkItems;
    return readHeld(ownerId, workspaceId, { sql: opts.sql });
  }, [] as CarryBriefHeldItem[]);

  const deferredItemsPromise = bestEffort(async () => {
    const readDeferred = opts.readDeferredWorkItemsFn ?? readDeferredWorkItems;
    return readDeferred(ownerId, workspaceId, { sql: opts.sql });
  }, [] as CarryBriefDeferredItem[]);

  const factsPromise = bestEffort(
    async () => {
      const listOwnerFacts =
        opts.listOwnerFactsFn ??
        (async (id: string, ws: string | undefined) => {
          const { foldFacts } = await import('./agent-facts/store');
          const facts = await foldFacts(
            [{ scope: 'owner', scopeRef: id }],
            { workspaceId: ws, limitPerSelector: CARRY_BRIEF_MAX_FACTS },
            opts.sql,
          );
          // P-011: fold the CONTESTED mark HERE — on the full `AgentFact` rows,
          // BEFORE the narrowing below throws away `scope`/`scopeRef`/`createdBy`.
          const { markContestedFacts } = await import('./agent-tools/facts/contested-fold');
          const marked = await markContestedFacts(facts);
          return marked.map((f) => ({
            key: f.key,
            body: f.body,
            sourceRef: f.sourceRef,
            sourceProvenance: f.sourceProvenance,
            ...(f.contested ? { contested: f.contested } : {}),
          }));
        });
      return (await listOwnerFacts(ownerId, workspaceId)).slice(0, CARRY_BRIEF_MAX_FACTS);
    },
    [] as CarryBrief['facts'],
  );

  const awaitsPromise = bestEffort(
    async () => {
      const listAwaits =
        opts.listActiveAwaitsFn ??
        (async (id: string) => {
          const { listActiveAwaits } = await import('./events/await/store');
          const rows = await listActiveAwaits(id);
          return rows.map((r) => ({ eventKey: r.eventKey, note: r.note }));
        });
      return (await listAwaits(ownerId)).filter((a) => !isInfraAwait(a.eventKey)).slice(0, CARRY_BRIEF_MAX_AWAITS);
    },
    [] as CarryBrief['awaits'],
  );

  const fleetPromise = bestEffort(
    async () => {
      const getFleet =
        opts.getFleetFn ??
        (async (id: string) => {
          const sql = opts.sql ?? getOrgPg().sql;
          const rows = await sql<Array<{ fleet_slug: string | null; fleet_role: string | null }>>`
          SELECT fleet_slug, fleet_role FROM harness_shared.coord_presence
           WHERE owner_id = ${id}
           ORDER BY heartbeat_at DESC
           LIMIT 1
        `;
          const r = rows[0];
          return r?.fleet_slug ? { slug: r.fleet_slug, role: r.fleet_role ?? null } : null;
        });
      return getFleet(ownerId);
    },
    null as CarryBrief['fleet'],
  );

  // Dependency-chained reads begin as soon as their own prerequisite resolves;
  // they do not wait for an unrelated slow root.
  const byocReleasesPromise = heldItemsPromise.then((heldItems) =>
    bestEffort(async () => {
      const readReleases =
        opts.readByocReleaseCarriesFn ??
        ((id: string, ws: string, heldIds: readonly string[]) =>
          readLinkedByocReleaseCarries(
            { ownerId: id, workspaceId: ws, heldWorkItemIds: heldIds },
            opts.sql ?? getOrgPg().sql,
          ));
      return readReleases(
        ownerId,
        workspaceId,
        heldItems.map((item) => item.id),
      );
    }, [] as ByocReleaseCarrySnapshot[]),
  );

  const citedRefsPromise = Promise.all([loopPromise, heldItemsPromise]).then(([loopRead, heldItems]) => {
    if (!loopRead.loop?.carryNote) return undefined;
    const hydrate = opts.hydrateNoteRefsFn ?? defaultHydrateNoteRefs;
    return bestEffort(() => hydrate(loopRead.loop!.carryNote!, heldItems), [] as string[]);
  });

  const postNoteInboxPromise = loopPromise.then((loopRead) => {
    const loop = loopRead.loop;
    if (!loop?.carryNote || loop.carryNoteUpdatedAtMs == null || !Number.isFinite(loop.carryNoteUpdatedAtMs)) {
      return undefined;
    }
    const readDelta = opts.readPostNoteInboxFn ?? defaultReadPostNoteInbox;
    return bestEffort(() => readDelta(ownerId, new Date(loop.carryNoteUpdatedAtMs!).toISOString()), null);
  });

  const factsStalenessPromise = factsPromise.then((facts) => {
    // P-026 leg (b): deliberately follows the fact fold so a failed staleness
    // check can never blank the facts themselves.
    const checkStaleness = opts.checkFactsStalenessFn ?? checkCarriedFactsStaleness;
    return bestEffort(() => checkStaleness(facts), [] as FactStalenessResult[]);
  });

  // P-029: DELIBERATELY INDEPENDENT of factsPromise above, not derived from it.
  // That fold is owner-scoped; this one is workspace+owner, so deriving one from
  // the other would reintroduce exactly the selector gap this closes. Degrades
  // to `undefined` (absent) rather than `[]` so a failed read is never rendered
  // as a measured "no guard rails apply".
  const neverDropFactsPromise = bestEffort(
    () => readCarryNeverDropFacts({ ownerId, workspaceId }, { sql: opts.sql }),
    undefined as string[] | undefined,
  );

  const [
    directives,
    loopRead,
    heldItems,
    deferredItems,
    facts,
    awaits,
    fleet,
    byocReleases,
    citedRefs,
    postNoteInbox,
    factsStaleness,
    neverDropFacts,
  ] = await Promise.all([
    directivesPromise,
    loopPromise,
    heldItemsPromise,
    deferredItemsPromise,
    factsPromise,
    awaitsPromise,
    fleetPromise,
    byocReleasesPromise,
    citedRefsPromise,
    postNoteInboxPromise,
    factsStalenessPromise,
    neverDropFactsPromise,
  ]);

  brief.directives = directives.rows;
  brief.directivesTotalOpen = directives.totalOpen;
  brief.loop = loopRead.loop;
  brief.walls = loopRead.walls;
  if (loopRead.checks !== undefined) brief.checks = loopRead.checks;
  brief.heldItems = heldItems;
  if (byocReleases.length > 0) brief.byocReleases = byocReleases;
  if (deferredItems.length > 0) brief.deferredItems = deferredItems;
  if (citedRefs !== undefined) brief.citedRefs = citedRefs;
  if (postNoteInbox !== undefined) brief.postNoteInbox = postNoteInbox;
  brief.facts = facts;
  brief.factsStaleness = factsStaleness;
  // Assigned only when non-empty, so the field's ABSENCE keeps meaning "nothing
  // applies or the read degraded" rather than silently becoming a present `[]`.
  if (neverDropFacts !== undefined) brief.neverDropFacts = neverDropFacts;
  brief.awaits = awaits;
  brief.fleet = fleet;

  return brief;
}

// ── Renderers (pure) ──────────────────────────────────────────────────────────

function cap(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + '…' : t;
}

function humanAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${Math.round(h / 24)}d`;
}

// ── Pull-precise query handles (P-026, WI-5001 leg (a)) ───────────────────────
//
// deterministic-context-carry-2026-07-14 P-026 retires the speculative embedding
// hole-patch re-prime for session classes whose cold-boot drills PROVE the
// deterministic carry sufficient (see memory/compact-reprime.ts). Retiring the
// FOLD must not mean retiring the ABILITY to pull — a genuinely needed recall is
// a BUILDER gap, not a reason to keep folding noise. This is the growth leg: a
// PURE, no-recall deriver that turns typed carry state directly into resolvable
// {@link QueryHandle}s (never full content — D-002's teaser+handle discipline),
// covering exactly the three classes the item text names: a held work-item, an
// armed await ("open thread" — an unresolved rendezvous the successor is a party
// to), and a recorded dead-end (a tried-and-failed approach, P-015 slot).

/** Input shape for {@link deriveCarryQueryHandles} — a subset of {@link CarryBrief}
 *  (not the whole brief) so callers with only some of it (e.g. compact-reprime's
 *  narrower CompactReprimeInput) can still derive handles from what they have. */
export interface CarryQueryHandleInputs {
  heldItems: ReadonlyArray<{ id: string; title: string | null }>;
  awaits: ReadonlyArray<{ eventKey: string; note: string | null }>;
  facts: ReadonlyArray<{ key: string; body: string }>;
}

/** Hard cap on emitted handles — a handles block is a pointer list, not a dump. */
export const CARRY_QUERY_HANDLES_MAX = 8;

const HANDLE_QUERY_CLAMP_CHARS = 200;

function clampHandleQuery(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > HANDLE_QUERY_CLAMP_CHARS ? `${t.slice(0, HANDLE_QUERY_CLAMP_CHARS - 1)}…` : t;
}

/**
 * Derive deterministic pull-precise handles from typed carry state — PURE, no
 * embedding call, no recall. Order: held work-items first (the most concrete),
 * then open awaits, then dead-ends; each class stops contributing once `max` is
 * reached (a partial mix, never one class crowding out the others entirely, is
 * avoided by capping the OVERALL list — same reasoning as CARRY_BRIEF's per-
 * section caps upstream of this call).
 */
export function deriveCarryQueryHandles(
  inputs: CarryQueryHandleInputs,
  max: number = CARRY_QUERY_HANDLES_MAX,
): QueryHandle[] {
  const handles: QueryHandle[] = [];
  for (const item of inputs.heldItems) {
    if (handles.length >= max) return handles;
    const label = item.title?.trim() || item.id;
    handles.push({ kind: 'work-item', ref: item.id, query: [clampHandleQuery(label)] });
  }
  for (const a of inputs.awaits) {
    if (handles.length >= max) return handles;
    const label = a.note?.trim() || a.eventKey;
    handles.push({ kind: 'topic', ref: a.eventKey, query: [clampHandleQuery(label)] });
  }
  for (const f of inputs.facts) {
    if (handles.length >= max) return handles;
    if (!f.key.startsWith(DEAD_END_KEY_PREFIX)) continue; // dead-ends only (P-015 slot)
    handles.push({ kind: 'fact', ref: f.key, query: [clampHandleQuery(f.body)] });
  }
  return handles;
}

/** The heading compact-reprime's retired branch renders the handles block under. */
export const CARRY_QUERY_HANDLES_HEADING = 'Pull-precise carry handles (no recall)';

/**
 * Render handles as a compact, resolvable-pointer block — one line per handle,
 * NEVER folded content (mirrors ambient-push's teaser-not-content discipline:
 * this is the "pull" side of the same D-002 handle, resolved by the reader
 * explicitly, not injected as if it were a hit). Empty input renders null (the
 * caller's existing "nothing to inject" contract).
 */
export function renderCarryQueryHandlesBlock(handles: readonly QueryHandle[]): string | null {
  if (handles.length === 0) return null;
  const lines = handles.map((h) => `- [${h.kind}:${h.ref}] pull: ${h.query.join(' | ')}`);
  return `${CARRY_QUERY_HANDLES_HEADING}\n${lines.join('\n')}`;
}

/**
 * The `/compact` FOCUS line (consumers i + ii): the standing preserve set plus
 * THIS session's real pointers, hard-capped at `max`. Pointer semantics on
 * purpose — checkpointed state is re-injected mechanically, so the summarizer
 * should keep ids and one-line hooks, not copies. Ordered most-load-bearing
 * first so a truncation drops the least important tail.
 */
export function renderCarryBriefFocus(brief: CarryBrief, max: number = CARRY_BRIEF_FOCUS_MAX): string {
  const parts: string[] = [
    'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls',
  ];
  if (brief.directives.length > 0) {
    // EI-11484: open owner directives outrank even walls — ids only (the
    // store re-renders them mechanically on every wake; copying wastes focus).
    parts.push(
      `OPEN OWNER DIRECTIVES ${brief.directives.map((d) => `#${d.id}`).join(', ')} — re-rendered every wake, keep the ids`,
    );
  }
  if (brief.walls.length > 0) {
    // P-006: open walls outrank everything else — they are open COMMITMENTS, kept
    // VERBATIM (per-claim capped only to survive the hard focus cap).
    parts.push(`OPEN WALLS (carry verbatim, do not re-declare resolved): ${brief.walls.map((w) => `"${cap(w.claim, 90)}"`).join('; ')}`);
  }
  const heldOwnership = brief.heldItems.map((item) => ({
    item,
    assessment: assessHeldItemOwnership(brief.ownerId, brief.workspaceId, item),
  }));
  const verifiedHeldItems = heldOwnership.filter(({ assessment }) => assessment.verified).map(({ item }) => item);
  const unverifiedHeldItems = heldOwnership.filter(({ assessment }) => !assessment.verified);
  if (verifiedHeldItems.length > 0) {
    const ids = verifiedHeldItems.map((h) => h.id).join(', ');
    parts.push(
      `held work-items ${ids} — keep the ids as POINTERS (their checkpoints are re-injected on pickup, do not copy them)`,
    );
  }
  if (unverifiedHeldItems.length > 0) {
    parts.push(
      `unverified carried work-items ${unverifiedHeldItems.map(({ item }) => item.id).join(', ')} — ` +
        'read-only pointers; verify live ownership before editing, claiming, or following their checkpoints',
    );
  }
  if ((brief.deferredItems ?? []).length > 0) {
    parts.push(
      `deferred unclaimed work ${(brief.deferredItems ?? []).map((item) => item.id).join(', ')} — this session filed/commented on it; keep the ids and re-check before declaring idle`,
    );
  }
  if (brief.loop) {
    const iv = brief.loop.intervalSec != null ? ` ${brief.loop.intervalSec}s` : '';
    parts.push(
      `armed loop @${brief.loop.harness}${iv} — its loop:checkpoint re-delivers on wake, pointer only`,
    );
  }
  if (brief.facts.length > 0) {
    parts.push(`standing facts (folded into every orient): ${brief.facts.map((f) => f.key).join(', ')}`);
    // P-026 leg (b) (WI-5141): flag which ones drifted — ids only, pointer-style.
    const staleKeys = (brief.factsStaleness ?? [])
      .filter((r) => r.verdict === 'possibly-stale')
      .map((r) => r.key);
    if (staleKeys.length > 0) {
      parts.push(`⚠ possibly-stale facts (source drifted, re-verify): ${staleKeys.join(', ')}`);
    }
  }
  if (brief.awaits.length > 0) {
    parts.push(`armed awaits: ${brief.awaits.map((a) => a.eventKey).join(', ')}`);
  }
  if ((brief.byocReleases ?? []).length > 0) {
    parts.push(
      `BYOC release tasks ${(brief.byocReleases ?? []).map((release) => release.taskId).join(', ')} — current stage receipts re-render from task_ledger`,
    );
  }
  if (brief.fleet) {
    parts.push(`fleet ${brief.fleet.slug}${brief.fleet.role ? ` (${brief.fleet.role})` : ''}`);
  }
  parts.push('drop resolved tool output and superseded state');
  return cap(parts.join('; ') + '.', max);
}

/** {@link unverifiedFocusRefs}'s findings: WI-/EI-/F- ids and 12-hex carry-note
 *  short-hashes (shortCarryHash format) named in a text that do NOT correspond
 *  to anything in the owner's own brief. */
export interface UnverifiedFocusRefs {
  workItemIds: string[];
  carryHashes: string[];
}

const FOCUS_WORK_ITEM_ID_RE = /\b(?:WI|EI|F)-\d+\b/g;
const FOCUS_CARRY_HASH_RE = /\(([0-9a-f]{8,16})\)/g;

/**
 * EI-22131227584499489: `focus` / `continueNote` are free text an agent writes
 * itself (session:request-compaction's `args.focus`/`args.continueNote`) —
 * nothing previously verified the text actually named the CALLING owner's own
 * state before it became a confident "resume: <text>" instruction handed to
 * its successor. Observed: a judge-role successor's first prompt named another
 * live owner's held work-item (WI-2140920) and loop carry-note short-hash,
 * apparently carried over from ambient context (a broadcast / memory-search
 * hit) the judge session read but never held. This scans `text` for WI-/EI-/
 * F-NNN ids and parenthesized 8-16 hex carry-note hashes and reports any that
 * are NOT in `brief.heldItems` / do not match `brief.loop`'s own carry-note
 * hash. `renderCarryBriefFocus`'s OWN output is always self-consistent by
 * construction (it only ever names ids drawn FROM `brief`, and never prints a
 * hash literal), so this never false-positives against the system-derived
 * default focus — it exists for the caller-supplied path, where nothing else
 * validates the free text before it ships.
 */
export function unverifiedFocusRefs(text: string, brief: CarryBrief | null): UnverifiedFocusRefs {
  const heldIds = new Set((brief?.heldItems ?? []).map((h) => h.id));
  const ownHash = brief?.loop?.carryNote ? shortCarryHash(brief.loop.carryNote) : null;
  const workItemIds = Array.from(new Set(text.match(FOCUS_WORK_ITEM_ID_RE) ?? [])).filter(
    (id) => !heldIds.has(id),
  );
  const carryHashes = Array.from(
    new Set(Array.from(text.matchAll(FOCUS_CARRY_HASH_RE), (m) => m[1])),
  ).filter((h) => h !== ownHash);
  return { workItemIds, carryHashes };
}

/** Render {@link unverifiedFocusRefs}'s findings as a standalone warning line,
 *  or '' when nothing was flagged (the overwhelmingly common case — safe to
 *  call unconditionally). Fail-open by design: a false positive (e.g. the
 *  owner citing a WI it just completed) only ADDS a "verify before acting"
 *  caution, never blocks or rewrites the caller's text. */
export function renderFocusIntegrityWarning(refs: UnverifiedFocusRefs): string {
  if (refs.workItemIds.length === 0 && refs.carryHashes.length === 0) return '';
  const named = [...refs.workItemIds, ...refs.carryHashes.map((h) => `carry-note ${h}`)].join(', ');
  return (
    `⚠ FOCUS INTEGRITY: this focus/continuation text names ${named}, which do NOT appear ` +
    'among your own held work-items or your own loop carry-note (checked against THIS ' +
    "owner's brief at request time). It may have been copied from a broadcast, another " +
    'owner\'s carry state, or ambient context rather than reflecting what you actually ' +
    'hold — verify (coord:presence / work_items:get) before acting on it; do not claim or ' +
    'progress any work-item it names on trust alone.'
  );
}

export interface RenderCarryBriefColdExtrasOpts {
  /** EI-18684357744098956: the epoch ms of the LATEST demonstrable session
   *  activity (e.g. the last verbatim tail turn) known to the caller — the
   *  "session active until" half of the staleness comparison. A held item's
   *  checkpoint or the loop's carry-note written more than
   *  {@link HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS} before this instant is flagged
   *  SUPERSEDED rather than rendered as current. Omitted/null ⇒ no comparison is
   *  possible (e.g. no transcript available); every carry surface renders as
   *  before — this is purely additive. */
  sessionActivityMs?: number | null;
  /** Clock injection for the aged-wall re-scope prompt below, so its threshold is
   *  deterministic under test. Omitted ⇒ `Date.now()`. */
  nowMs?: number;
}

/**
 * A carried owner-gated wall older than this has survived many wakes without
 * clearing — the mechanical signature of a blocker being RE-REPORTED rather than
 * re-examined. Past it the carry surface stops merely restating the wall and tells
 * the agent to ask whether the blocked work is still WANTED.
 *
 * Owner directive (2026-09-18), after a plan sat frozen for hours behind a
 * genuinely unsatisfiable gate: "if I've reported the same blocker to you more than
 * once, that's the signal to ask whether the blocked thing is still wanted, not to
 * write a better report about it." The wall analysis in that incident was CORRECT —
 * the failure was never asking whether the feature behind it was worth its only
 * sound implementation. One dialog cleared a multi-turn freeze.
 *
 * `sinceMs` is preserved across rewrites of the same claim (see mergeWallEntries),
 * so this measures the AGE OF THE COMMITMENT, not the age of its latest wording —
 * re-phrasing a wall cannot reset the prompt.
 */
export const AGED_WALL_RESCOPE_PROMPT_MS = 2 * 60 * 60 * 1000;

/**
 * The sections a COLD reset/recycle injection appends AFTER the loop carry-note
 * (consumer iii — wake-executor). The note stays the injection's core (P-006:
 * no note ⇒ no cold start at all), so this renders everything else: held items
 * + capped checkpoints, standing facts, armed awaits, the fleet pointer.
 * Returns '' when the brief carries nothing beyond the loop note.
 */
export function renderCarryBriefColdExtras(
  brief: CarryBrief,
  opts: RenderCarryBriefColdExtrasOpts = {},
): string {
  const sessionActivityMs = opts.sessionActivityMs ?? null;
  const deferredItems = brief.deferredItems ?? [];
  const heldOwnership = brief.heldItems.map((item) => ({
    item,
    assessment: assessHeldItemOwnership(brief.ownerId, brief.workspaceId, item),
  }));
  const verifiedHeldItems = heldOwnership
    .filter(({ assessment }) => assessment.verified)
    .map(({ item }) => item);
  const unverifiedHeldItems = heldOwnership.filter(({ assessment }) => !assessment.verified);
  const sections: string[] = [];
  // EI-22436560948423011: the loop carry-note is the first imperative a cold
  // successor reads, but its write can predate later turns in the predecessor
  // session. Keep the note intact and add a nearby warning rather than silently
  // presenting that earlier snapshot as the current agenda.
  const carryNoteUpdatedAtMs = brief.loop?.carryNoteUpdatedAtMs;
  if (
    brief.loop?.carryNote &&
    sessionActivityMs != null &&
    carryNoteUpdatedAtMs != null &&
    sessionActivityMs - carryNoteUpdatedAtMs > HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS
  ) {
    sections.push(
      `⚠ CARRY-NOTE SUPERSEDED — written ${fmtClock(carryNoteUpdatedAtMs)}, session active until ` +
        `${fmtClock(sessionActivityMs)} (more happened after this note was written; its imperatives ` +
        `may be flat-out wrong — verify via sessions:search { session:'self', mode:'verbatim' } and ` +
        `the actual files/state before trusting the note or its "Next action" at face value).`,
    );
  }
  // EI-19362981097884026: FIRST, because these extras are appended directly
  // beneath the carry-note and this is the block that can contradict it. The
  // cold wake previously rendered the note's imperative with no liveness signal
  // at all while `buildCarryBrief` had already resolved every id it cites.
  // `renderCarryBriefText` strips `citedRefs` before delegating here (it places
  // the same block inline, higher up), exactly as it does for `directives`.
  sections.push(...renderCitedRefLivenessSections(brief.citedRefs ?? []));
  // A held checkpoint can preserve a native exec/write_stdin session id. That
  // handle belongs to the predecessor process and is not addressable after a
  // carry-respawn, including the warm session:request-compaction path. Surface
  // the same warning used by cold-loop notes before the checkpoint excerpt so
  // the successor reconciles durable evidence instead of blindly polling or
  // launching a duplicate command.
  const transientExecHandleItems = brief.heldItems.filter(
    (item) => item.checkpoint != null && transientExecHandleWarning(item.checkpoint) != null,
  );
  if (transientExecHandleItems.length > 0) {
    const ids = transientExecHandleItems.map((item) => item.id).join(', ');
    sections.push(
      `⚠ CARRIED TRANSIENT EXEC HANDLE(S) — held-item checkpoint(s) ${ids} contain a numeric ` +
        '`exec_command`/`write_stdin` session or process handle from the predecessor. ' +
        'Do NOT call `write_stdin` with that carried id. First reconcile durable spill/log/work-item ' +
        'evidence and the actual process; do not treat Unknown process id as command failure or ' +
        'blindly relaunch. If no live/completed process or durable result remains, rerun the bounded ' +
        'command with a fresh exec.',
    );
  }
  if (brief.directives.length > 0) {
    // EI-11484: open owner directives render FIRST — above walls, above the
    // agenda. Budgeted by the shared renderer (whole ≤300 chars, else substr
    // + orders:get pointer, block cap + "+N more").
    const block = renderOwnerDirectivesBlock(brief.directives, {
      totalOpen: brief.directivesTotalOpen,
      viewerOwnerId: brief.ownerId,
    });
    if (block) sections.push(block);
  }
  if (brief.walls.length > 0) {
    // P-006: walls FIRST, as rows, VERBATIM — the redundancy with the note's own
    // `## Walls` section is deliberate; commitments are the one carry class where
    // double-delivery beats any byte saving.
    const lines = brief.walls.map(
      (w) => `  • ${w.claim}${w.recheck ? ` — re-check: ${w.recheck}` : ''}`,
    );
    sections.push(
      `⛔ OPEN WALLS — owner-gated commitments you still carry (re-check, do not re-litigate or re-declare resolved; clear via loop:checkpoint { walls }):\n${lines.join('\n')}`,
    );
    // A wall that has stood this long is being RE-REPORTED, not re-examined. The
    // carry surface already redelivers it every wake, which is exactly what makes
    // the trap invisible: each redelivery reads as "still blocked", never as "you
    // have never asked whether this is still wanted". See AGED_WALL_RESCOPE_PROMPT_MS.
    const nowMs = opts.nowMs ?? Date.now();
    const agedAges = brief.walls
      .map((w) => (w.sinceMs != null && Number.isFinite(w.sinceMs) ? nowMs - w.sinceMs : null))
      .filter((age): age is number => age != null && age >= AGED_WALL_RESCOPE_PROMPT_MS);
    if (agedAges.length > 0) {
      const aged = brief.walls.filter(
        (w) =>
          w.sinceMs != null &&
          Number.isFinite(w.sinceMs) &&
          nowMs - w.sinceMs >= AGED_WALL_RESCOPE_PROMPT_MS,
      );
      sections.push(
        `⚠ AGED WALL${aged.length > 1 ? 'S' : ''} — carried ${humanAge(Math.max(...agedAges))} without clearing: ` +
          `${aged.map((w) => `"${cap(w.claim, 80)}"`).join('; ')}\n` +
          '  A wall you have carried this long has stopped being a blocker and become an UNEXAMINED PREMISE. ' +
          'ASK WHETHER THE BLOCKED THING IS STILL WANTED — as a real, answerable question with the options ' +
          'spelled out (an interactive dialog where your client has one, else coord:ask-owner), NOT another ' +
          'status report. "Nobody can clear this" is a sound finding; it is NOT the same as "this must be ' +
          "cleared\", and dropping or rescoping the work behind the wall is the owner's call to make, not " +
          'yours to assume. If you have already asked and are awaiting the answer, say so in the wall claim ' +
          '(loop:checkpoint { walls }) so this stops firing.',
      );
    }
  }
  if (brief.checks && brief.checks.length > 0) {
    // P-001 delivery parity: same double-delivery rationale as walls — a carried
    // claim whose probe dissolves in a capped note is the phantom-re-anchor shape.
    //
    // EI-22431465725244151: NAME whose checks these are. A held work-item's
    // checkpoint carries its OWN `## Checks` rows — a different population, written
    // on a different cadence — and those render later and are routinely elided. An
    // unqualified "CARRIED CHECKS" heading over a complete-looking list is read as
    // THE carried set, so finishing this block feels like finishing the checks and
    // the item's rows are never opened. Cross-reference them here, at the only
    // moment the false sense of completeness actually forms.
    const heldWithChecks = verifiedHeldItems
      .filter((h) => h.checkpoint && splitCarryNoteChecks(h.checkpoint).checks.length > 0)
      .map((h) => h.id);
    const alsoOnItems =
      heldWithChecks.length > 0
        ? `\n  ⚠ These are the LOOP's checks and NOT the only ones in this document — ${heldWithChecks.join(', ')} carr${heldWithChecks.length === 1 ? 'ies' : 'y'} a SEPARATE set on the work-item checkpoint below. Finishing this block is not finishing the checks.`
        : '';
    sections.push(
      `🧪 CARRIED CHECKS (this LOOP's) — claims + their probes (✓ verified w/ evidence · ? PREDICTED — run the re-check before relying; clear via loop:checkpoint { checks }):\n${brief.checks
        .map((c) => `  ${renderCheckLine(c).replace(/^-\s*/, '• ')}`)
        .join('\n')}${alsoOnItems}`,
    );
  }
  if ((brief.byocReleases ?? []).length > 0) {
    sections.push(
      `🚚 AUTHORITATIVE BYOC RELEASE RECEIPTS — derived from task_ledger, not authored carry prose. ` +
        `Re-read the task before acting if this document is stale; open walls/retractions elsewhere in this brief remain binding:\n` +
        (brief.byocReleases ?? []).map(renderByocReleaseCarry).join('\n'),
    );
  }
  const idleNoteGuard = detectIdleNoteGuard(brief.loop?.carryNote, deferredItems);
  if (idleNoteGuard) sections.push(idleNoteGuard.message);
  if (deferredItems.length > 0) {
    sections.push(renderDeferredWorkItems(deferredItems));
  }
  if (unverifiedHeldItems.length > 0) {
    sections.push(
      `⚠ UNVERIFIED CARRIED WORK — these rows are read-only evidence, not this session's lane. ` +
        `Do NOT edit, claim, or follow their checkpoints until live ownership is re-verified:\n` +
        unverifiedHeldItems
          .map(({ item, assessment }) =>
            `  • ${renderHeldItemOwnershipWarning(brief.ownerId, brief.workspaceId, item, assessment)}`,
          )
          .join('\n'),
    );
  }
  if (verifiedHeldItems.length > 0) {
    // The excerpt must SAY it is an excerpt. This is the cold successor's entire
    // resume state, rendered as prose with no sibling field to carry a structured
    // marker — so the withheld-chars notice goes inline, naming the call that
    // returns the rest. A bare `…` here reads as a complete checkpoint.
    const excerptCheckpoint = (h: { id: string; harness: string | null; checkpoint: string | null }): string => {
      // EI-20451119672468393: harness-qualified — a cold successor's session may
      // be scoped to a different pot than the held item's canonical harness, and
      // WI-<n> ids are not globally unique.
      const excerpt = capPreservingOperative(h.checkpoint!, COLD_CHECKPOINT_CAP, {
        inlineNotice: true,
        more: workItemFetchHint(h.id, h.harness),
      });
      return excerpt + renderCheckpointChecksDisclosure(h.checkpoint!, excerpt, h.id, h.harness);
    };
    const lines = verifiedHeldItems.map((h) => {
      const title = h.title ? ` — ${cap(h.title, COLD_TITLE_CAP)}` : '';
      const lane = renderDeclareIntentLane(h);
      // EI-20467754551087390: checkpoint prose commonly names files relative to
      // the held item's harness repository. A cold successor may be running from
      // a different harness/workspace root, so state the path scope next to the
      // checkpoint instead of leaving `apps/...` looking like a current-root
      // path. The slug is authoritative; the resolver supplies the actual path.
      const pathScope = h.checkpoint
        ? `\n    path scope: checkpoint paths are repository-relative to the ${h.harness ? `${h.harness} harness` : 'current'} repository root` +
          (h.harness ? ` (resolve with harness:list { detail: 'full' } and match this slug before shelling out)` : '')
        : '';
      let ckpt: string;
      if (h.checkpointReadFailed) {
        ckpt = `\n    checkpoint: UNKNOWN — store read failed; do not infer absence or overwrite. Re-read ${workItemFetchHint(h.id, h.harness)}`;
      } else if (!h.checkpoint) {
        ckpt = '\n    (no checkpoint written — read the item via work_items:get before acting)';
      } else {
        const superseded =
          sessionActivityMs != null &&
          h.checkpointUpdatedAtMs != null &&
          sessionActivityMs - h.checkpointUpdatedAtMs > HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS;
        // EI-19952485326105760: checkpoints are written APPEND-STYLE, so the
        // newest and most-binding content (e.g. a later owner directive that
        // SUPERSEDES an earlier plan in the same body) is written last —
        // exactly what a plain head-only `cap()` discards first. Use the
        // operative/supersession-preserving excerpt instead of `cap()` here.
        ckpt = superseded
          ? `\n    checkpoint: ⚠ SUPERSEDED — written ${fmtClock(h.checkpointUpdatedAtMs!)}, session active until ` +
            `${fmtClock(sessionActivityMs!)} (more happened after this was written; it may be flat-out wrong — ` +
            `verify via sessions:search { session:'self', mode:'verbatim' } and the actual files/state before ` +
            `trusting it, never treat it as "nothing done" or "work undone" at face value): ` +
            `${excerptCheckpoint(h)}`
          : `\n    checkpoint: ${excerptCheckpoint(h)}`;
      }
      return `  • ${h.id}${title}${lane}${pathScope}${ckpt}`;
    });
    sections.push(
      `You HELD these work-items as of just before this respawn (the full checkpoint re-injects on the item's next invocation; refresh it before ending). ` +
        `CAUTION (EI-18665023147548277): this brief was built BEFORE your old session's SessionEnd/Stop lifecycle event fired — that event unconditionally ` +
        `releases every claim you held (session-death-claim-release-2026-07-11), so a claim listed here CAN already be released by the time you read this. ` +
        `Do not trust "HOLD" at face value: re-verify with work_items:get (or coord:orient { afterCompaction: true }, which re-queries live) and re-claim ` +
        `(work_items:claim) before editing if assignee is not you:\n${lines.join('\n')}`,
    );
  }
  // P-029: the carry document's consumption of the `neverDropFacts` class.
  // FIRST of the facts family on purpose — these are the guard rails, dead-ends
  // and walls whose absence is unrecoverable for this document's reader, and a
  // successor that reads nothing else should still read these.
  if ((brief.neverDropFacts?.length ?? 0) > 0) {
    sections.push(
      `🛡️ NEVER-DROP facts — guard rails, dead-ends and walls that MUST survive this cut ` +
        `(folded at WORKSPACE + owner scope):\n` +
        `  ${brief.neverDropFacts!.join(', ')}\n` +
        `  Read the bodies BEFORE you plan — facts:list { scope: 'workspace' } and ` +
        `facts:list { scope: 'owner' }; a dead-end key records an approach already proven not to ` +
        `work, so re-attempting it is the specific waste these exist to prevent.\n` +
        `  ⚠ KEYS ONLY, and folded at WORKSPACE scope as well — so this list deliberately carries ` +
        `rails the owner-scoped standing-facts block below does NOT. An entry here with no entry ` +
        `there is CORRECT, not a discrepancy to reconcile.`,
    );
  }
  if (brief.facts.length > 0) {
    // Same fix as the held-item checkpoint above — a fact body can carry a
    // later imperative/supersession clause past the excerpt cut too.
    const lines = brief.facts.map((f) => {
      const fetch = `facts:list { scope: 'owner', key: '${f.key}' }`;
      const body = capPreservingOperative(f.body, COLD_FACT_BODY_CAP, {
          inlineNotice: true,
          // These rows come from listOwnerFactsFn, so preserve that selector in
          // the recovery handle. facts:list requires an explicit scope even for
          // a keyed lookup; the old key-only hint sent successors into a
          // guaranteed invalid_args retry at exactly the recovery boundary.
          more: fetch,
        });
      const provenance = f.sourceProvenance;
      let source = '';
      if (provenance?.quoteRedacted) {
        source =
          `\n    source quote: ⚠ WITHHELD — credential-shaped content was redacted before storage; ` +
          `inspect the fact metadata via ${fetch}`;
      } else if (provenance?.quote?.trim()) {
        const label = provenance.label?.trim() || provenance.kind;
        const quote = capPreservingOperative(provenance.quote, COLD_FACT_SOURCE_QUOTE_CAP, {
          inlineNotice: true,
          more: fetch,
        });
        source = `\n    source quote [${provenance.verified ? 'verified' : 'unverified'}; ${label}]: ${quote}`;
      } else if (provenance && !provenance.verified) {
        source =
          `\n    source provenance: ⚠ UNREADABLE — ${provenance.error?.trim() || 'source verification failed'}; ` +
          `inspect via ${fetch}`;
      } else if (provenance) {
        source =
          `\n    source provenance: ⚠ UNREADABLE — verified source metadata carried no quote; ` +
          `inspect via ${fetch}`;
      }
      return `  • ${f.key}: ${body}${source}`;
    });
    sections.push(
      `Your standing facts (owner-scoped; folded into every orient until retracted — walls/commitments live here):\n${lines.join('\n')}`,
    );
    // P-026 leg (b) (WI-5141): a fact whose verified typed source has drifted
    // since assert time — surfaced right after the facts block it annotates.
    const stalenessWarning = renderFactsStalenessWarning(brief.factsStaleness ?? []);
    if (stalenessWarning) sections.push(stalenessWarning);
  }
  if (brief.awaits.length > 0) {
    const lines = brief.awaits.map(
      (a) => `  • ${a.eventKey}${a.note ? ` — ${cap(a.note, 120)}` : ''}`,
    );
    sections.push(`Your armed awaits are still live and WILL wake you:\n${lines.join('\n')}`);
  }
  if (brief.fleet) {
    sections.push(
      `Fleet: you are in "${brief.fleet.slug}"${brief.fleet.role ? ` as ${brief.fleet.role}` : ''} — fleet:status for live state.`,
    );
  }
  return sections.join('\n\n');
}

export interface RenderCarryBriefTextOpts extends RenderCarryBriefColdExtrasOpts {}

/**
 * The full brief as text — the P-004 recovery-hook payload (and a debugging
 * surface). Loop section first (with the note's write age when known), then the
 * cold-extras sections.
 */
export function renderCarryBriefText(
  brief: CarryBrief,
  now: number = Date.now(),
  opts: RenderCarryBriefTextOpts = {},
): string {
  const sections: string[] = [];
  // EI-11484: open owner directives render ABOVE the loop contract — the whole
  // point of the store is that they outrank the re-injected standing agenda.
  const directivesBlock =
    brief.directives.length > 0
      ? renderOwnerDirectivesBlock(brief.directives, {
          nowMs: now,
          totalOpen: brief.directivesTotalOpen,
          viewerOwnerId: brief.ownerId,
        })
      : null;
  if (directivesBlock) sections.push(directivesBlock);
  if (brief.loop) {
    const iv = brief.loop.intervalSec != null ? `, every ${brief.loop.intervalSec}s` : '';
    const head = `Armed loop @${brief.loop.harness} (${brief.loop.active ? 'active' : 'inactive'}${iv}).`;
    if (brief.loop.carryNote) {
      const ageMs =
        brief.loop.carryNoteUpdatedAtMs != null
          ? Math.max(0, now - brief.loop.carryNoteUpdatedAtMs)
          : null;
      if (!brief.loop.active && ageMs != null && ageMs > INACTIVE_LOOP_NOTE_STALE_MS) {
        // A dead lane's old note is HISTORY, not agenda — reproducing its
        // imperative "Next action" verbatim reads as current marching orders to
        // a cold successor (the 2026-07-18 carry doc carried a 3-day-stale drill
        // note this way). Collapse to a labeled pointer; the note itself stays
        // recoverable via loop:status / the loop's checkpoint history.
        sections.push(
          `${head} Its last carry-note is ${humanAge(ageMs)} old — STALE (the loop is not armed; ` +
            `the note's imperatives are historical, NOT your current agenda). Recover it via ` +
            `loop:status if genuinely needed.`,
        );
      } else {
        const age = ageMs != null ? ` (written ${humanAge(ageMs)} ago)` : '';
        const annotatedNote = annotateCarryNoteLiveContradictions(
          brief.loop.carryNote,
          brief.citedRefs ?? [],
        );
        sections.push(`${head} Its carry-note${age}:\n${annotatedNote}`);
        // P-002: LIVE hydrations of the ids the note cites — a successor trusts
        // these over the note's phrasing (the note is a snapshot; these are now).
        // Rendered by the SHARED helper (EI-19362981097884026) so this document
        // and the cold-loop wake cannot answer the same question differently.
        sections.push(...renderCitedRefLivenessSections(brief.citedRefs ?? []));
        // P-003: the note PREDATES this mail — a cold successor must reconcile
        // before executing the note's imperatives.
        if (brief.postNoteInbox && brief.postNoteInbox.count > 0) {
          // EI-19408487308624743: surface a RETRACTION-shaped post-note message
          // loudly, right next to the note's imperative — never let a withdrawn
          // premise sit as just one bullet in the generic list below, where a
          // reader following the note's own marching orders may never reach it.
          const retractionLines = detectRetractionShapedLines(brief.postNoteInbox.lines);
          if (retractionLines.length > 0) {
            sections.push(
              `⚠⚠ POSSIBLE RETRACTION AFTER THIS NOTE: ${retractionLines.length} of the message(s) below ` +
                `read as a correction/retraction of a prior claim. The note's imperative above (including any ` +
                `"resume"/"next action" instruction) may rest on a premise that was WITHDRAWN after the note ` +
                `was written — reconcile against these BEFORE executing anything the note instructs:\n` +
                retractionLines.join('\n'),
            );
          }
          sections.push(
            `⚠ ${brief.postNoteInbox.count} directed message(s) landed AFTER this carry-note was written — ` +
              `the note PREDATES them; read before acting on its imperatives:\n` +
              brief.postNoteInbox.lines.join('\n'),
          );
        }
      }
    } else {
      sections.push(`${head} No carry-note written.`);
    }
  }
  // Directives already rendered at the top — strip them so the extras call
  // (shared with the cold path, where they DO belong inside) can't double-render.
  // EI-19362981097884026: `citedRefs` is the SAME hazard and takes the SAME
  // remedy. This renderer places the liveness block inline right after the note
  // (a better position than the extras tail), so it is stripped here; the cold
  // path has no inline placement, which is why the extras renderer owns it there.
  const extras = renderCarryBriefColdExtras(
    { ...brief, ...(directivesBlock ? { directives: [] } : {}), citedRefs: [] },
    {
      sessionActivityMs: opts.sessionActivityMs,
    },
  );
  if (extras) sections.push(extras);
  return sections.join('\n\n');
}
