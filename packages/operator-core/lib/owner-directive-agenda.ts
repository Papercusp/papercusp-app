/**
 * owner-directive-agenda — PER-SESSION agenda state for owner directives.
 *
 * Companion to `owner-directives.ts`, deliberately a separate module because it
 * answers a DIFFERENT question about the same row, and the whole defect this
 * exists to fix was those two questions sharing one column.
 *
 *   owner-directives.ts  → "is this really an owner directive, and is it done?"
 *                          GLOBAL facts about the directive.
 *   this module          → "has THIS session discharged this row from ITS OWN
 *                          banner?" A fact about a session.
 *
 * ORIGIN (plan `directive-visibility-and-ownership-2026-09-22`, D-008). Two
 * peers measured contradictory bugs within 25 minutes:
 *
 *   (A) su-ebc936c4 / WI-10002437 — `capture_status` is ONE directive-scoped
 *       column, so ANY agent's correct "not my lane" dismissal clears the row
 *       for EVERY session, including the one the owner was addressing.
 *       Existence proof: directive #96, the owner's own pause order typed into
 *       su-ebc936c4's lane, dismissed by su-c03852cb at 15:12:43Z. Irreversible.
 *
 *   (B) su-14342fa6 — refusing FOREIGN resolution strands every foreign row in
 *       every agent's Orientation forever, because a foreign row is exactly the
 *       row you can never clear.
 *
 * Under one shared column no setting satisfies both: tighten it and you strand,
 * loosen it and you erase. They are separated here by SCOPE. The directive row
 * stays immutable, workspace-global owner speech; agenda state becomes
 * per-(directive, session). Then (A) cannot occur — a dismissal is no longer
 * global — and (B) cannot occur — clearing your OWN agenda row is always
 * permitted, which is the only thing you were ever entitled to clear.
 *
 * ⚠ THE TWO GUARDS BELOW MUST NEVER SHARE A CALL SITE. D-008 is explicit that
 * refusing foreign ACTION and refusing foreign AGENDA-CLEARING are different
 * operations and must not share a guard. They are exported as two functions
 * with deliberately asymmetric shapes — one returns a verdict object, the other
 * does not exist at all, because agenda-clearing has NO foreign check by
 * construction. If you ever find yourself adding an ownership test to the
 * clear path, re-read D-008: that is defect (B), and it was designed into this
 * plan once already before a peer caught it.
 *
 * ABSENCE IS THE DEFAULT. A (directive, session) pair with no row has simply
 * not acted. This keeps the table proportional to actions rather than to
 * sessions × directives, lets a NEW session inherit the correct agenda with no
 * backfill, and makes the repair of the 47 measured foreign-dismissed rows a
 * matter of absence rather than of reconstructing an overwritten state.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { DirectiveRoutingDeps } from './owner-directive-routing';
import { TERMINAL_WORK_ITEM_STATES } from './work-items';

function db(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

export type DirectiveAgendaState = 'open' | 'dismissed';

export interface DirectiveAgendaRow {
  workspaceId: string;
  directiveId: number;
  ownerId: string;
  state: DirectiveAgendaState;
  reason: string | null;
  actedAt: string;
}

/**
 * Clear one directive from THIS session's banner.
 *
 * Unconditional by design — there is no ownership check here and there must
 * never be one. Clearing a FOREIGN directive from your own agenda is the
 * correct, expected operation: you are not the addressee, so it is noise to
 * you, and D-004 keeps it VISIBLE rather than filtered precisely so you can see
 * what peers are doing. What you are not entitled to do is act on it, which is
 * a different verb guarded by `directiveActionVerdict` below.
 *
 * Idempotent: re-clearing updates the reason and timestamp rather than
 * erroring, because an agent re-clearing a row it already cleared is a no-op
 * from the user's point of view and an error there would be pure friction.
 */
export async function clearDirectiveFromAgenda(
  input: { directiveId: number; ownerId: string; workspaceId: string; reason: string },
  sql?: Sql,
): Promise<{ ok: true; state: DirectiveAgendaState }> {
  const s = db(sql);
  const reason = input.reason.trim();
  await s`
    INSERT INTO harness_shared.owner_directive_agenda
      (workspace_id, directive_id, owner_id, state, reason, acted_at)
    VALUES (${input.workspaceId}, ${input.directiveId}, ${input.ownerId}, 'dismissed', ${reason}, now())
    ON CONFLICT (workspace_id, directive_id, owner_id)
    DO UPDATE SET state = 'dismissed', reason = ${reason}, acted_at = now()
  `;
  return { ok: true, state: 'dismissed' };
}

/**
 * Put a directive BACK on this session's banner after clearing it — the
 * reversibility that makes clearing a safe, low-stakes action.
 *
 * This is the half the old global column could not offer at all: a dismissal
 * was irreversible (`orders:resolve-pending promote` returns `not_pending`
 * afterwards), which is why #96 was a permanent loss rather than a nuisance.
 */
export async function restoreDirectiveToAgenda(
  input: { directiveId: number; ownerId: string; workspaceId: string },
  sql?: Sql,
): Promise<{ ok: true; state: DirectiveAgendaState }> {
  const s = db(sql);
  await s`
    INSERT INTO harness_shared.owner_directive_agenda
      (workspace_id, directive_id, owner_id, state, reason, acted_at)
    VALUES (${input.workspaceId}, ${input.directiveId}, ${input.ownerId}, 'open', NULL, now())
    ON CONFLICT (workspace_id, directive_id, owner_id)
    DO UPDATE SET state = 'open', reason = NULL, acted_at = now()
  `;
  return { ok: true, state: 'open' };
}

/**
 * The directive ids THIS session has cleared — what the Orientation renderer
 * subtracts before rendering.
 *
 * Returns a Set rather than a list because every caller is asking a membership
 * question per rendered row, and a list there turns one render into an O(n·m)
 * scan over a block that is already on the hot per-turn path.
 */
export async function listClearedDirectiveIds(
  input: { ownerId: string; workspaceId: string },
  sql?: Sql,
): Promise<Set<number>> {
  const s = db(sql);
  const rows = await s<Array<{ directive_id: string | number }>>`
    SELECT directive_id
      FROM harness_shared.owner_directive_agenda
     WHERE workspace_id = ${input.workspaceId}
       AND owner_id = ${input.ownerId}
       AND state = 'dismissed'
  `;
  return new Set(rows.map((r) => Number(r.directive_id)));
}

/**
 * SQL fragment that hides the directives THIS viewer has cleared off its own
 * banner. Empty when no viewer is known, so an un-threaded caller keeps the
 * pre-1195 behaviour (show everything) rather than silently hiding nothing or
 * everything.
 *
 * IT MUST BE APPLIED INSIDE THE DIRECTIVE QUERY, BEFORE `LIMIT` — never as a
 * filter over the returned page. The banner reads a fixed number of rows, so a
 * post-filter spends render slots on rows the viewer will never see: clear
 * three directives and the banner shows three FEWER live ones, which reads as
 * "there is nothing else owed". Same failure the `state` predicate in
 * listOwnerDirectives is documented to avoid.
 *
 * Correlated against the schema-qualified base table because both call sites
 * select from it unaliased.
 */
export function agendaClearedExclusionSql(s: Sql, viewerOwnerId: string | null | undefined) {
  if (!viewerOwnerId) return s``;
  return s`AND NOT EXISTS (
    SELECT 1 FROM harness_shared.owner_directive_agenda AS cleared
     WHERE cleared.workspace_id = harness_shared.owner_directives.workspace_id
       AND cleared.directive_id = harness_shared.owner_directives.id
       AND cleared.owner_id = ${viewerOwnerId}
       AND cleared.state = 'dismissed'
  )`;
}

export type DirectiveActionVerdict =
  | {
      allowed: true;
      because: 'addressee' | 'holds-linking-work-item' | 'inherited-from-ended-session' | 'adopting-unhandled';
    }
  | { allowed: false; addressedTo: string; holders: string[] };

/**
 * May THIS session ACT on this directive — promote it, or disposition it
 * done/declined?
 *
 * This is the guard D-008 kept, and it is deliberately NOT applied to the
 * clear path. Acting on a directive asserts something about the OWNER'S ORDER
 * — that it is genuine, or that it has been carried out. Only two parties can
 * truthfully assert that:
 *
 *   1. the session the owner was addressing (`recorded_by`), or
 *   2. a session that actually holds work carrying it — a non-terminal
 *      work-item whose `directive_ref` names this directive (migration 1194,
 *      P-005). This is what lets work legitimately change hands without the
 *      directive becoming unactionable.
 *
 * Rationale from the incident this plan exists for: on 2026-09-22 the acting
 * agent had `recordedBy` one `orders:get` away and read past it, because the
 * banner rendered a carry-out imperative and it believed it. A LABEL alone
 * would not have stopped it — the refusal is what prevents recurrence, and the
 * label (P-007) is what makes the refusal legible rather than mysterious.
 *
 * The refusal names the addressee AND any current holders so the caller's next
 * move is obvious: message them, or clear it from your own agenda instead.
 *
 * `routing` overrides the ended-addressee routing reads. Only callers that must
 * not reach the liveness oracle need it; the oracle has no `sql` seam and always
 * reads the ambient pool.
 */
export async function directiveActionVerdict(
  input: { directiveId: number; ownerId: string; workspaceId: string },
  sql?: Sql,
  routing?: DirectiveRoutingDeps,
): Promise<DirectiveActionVerdict | { allowed: false; notFound: true }> {
  const s = db(sql);
  const rows = await s<Array<{ recorded_by: string }>>`
    SELECT recorded_by FROM harness_shared.owner_directives
     WHERE id = ${input.directiveId} AND workspace_id = ${input.workspaceId}
  `;
  const directive = rows[0];
  if (!directive) return { allowed: false, notFound: true };

  if (directive.recorded_by === input.ownerId) return { allowed: true, because: 'addressee' };

  // Non-terminal is the load-bearing word: a DONE work-item that once carried
  // this directive must not keep granting its assignee authority over the
  // owner's order forever.
  //
  // The terminal set is the CANONICAL maintained constant, never a local list.
  // An earlier draft of this guard hand-spelled four terminal statuses; the
  // live column holds eleven, so `deprecated` and `passed` would have counted
  // as live and handed their assignee authority over an owner's directive. A
  // second copy of a truth the code already owns is exactly the drift the
  // derived-truth ladder warns about — and here the drift direction is
  // permissive, which is the worst one for a guard. Same `NOT (… = ANY(…))`
  // form issues-engineer.ts uses against the same constant.
  // The unified work-items table stores claim ownership in `taken_by`; there is
  // no `assignee` column on it (that spelling belongs to the issue family).
  // Getting this wrong is not a silent miss: the query THROWS `column
  // "assignee" does not exist`, which took out every dismiss/disposition path
  // on this verb fleet-wide until it was fixed.
  const holders = await s<Array<{ taken_by: string | null }>>`
    SELECT taken_by FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId}
       AND directive_ref = ${input.directiveId}
       AND NOT (status = ANY(${TERMINAL_WORK_ITEM_STATES as string[]}::text[]))
       AND taken_by IS NOT NULL
  `;
  const holderIds = holders.map((h) => h.taken_by!).filter(Boolean);
  if (holderIds.includes(input.ownerId)) return { allowed: true, because: 'holds-linking-work-item' };

  // P-008 / R-7: an ended addressee does not strand its directive
  // (owner-directive-routing.ts). Its live fleet leader inherits it; with no
  // live leader or holder it is UNHANDLED — on the owner's "nobody is handling
  // these" list — and any session may adopt it, or nobody could ever close it.
  // Fail-closed: a routing read error leaves the refusal standing.
  const { routeOpenDirectives, defaultDirectiveRoutingDeps } = await import('./owner-directive-routing');
  const routes = await routeOpenDirectives(
    input.workspaceId,
    [{ id: input.directiveId, recordedBy: directive.recorded_by }],
    routing ?? defaultDirectiveRoutingDeps(s),
  ).catch(() => null);
  const route = routes?.get(input.directiveId);
  if (route?.kind === 'fleet-leader' && route.leaderOwnerId === input.ownerId) {
    return { allowed: true, because: 'inherited-from-ended-session' };
  }
  if (route?.kind === 'unhandled') return { allowed: true, because: 'adopting-unhandled' };

  return { allowed: false, addressedTo: directive.recorded_by, holders: [...new Set(holderIds)] };
}
