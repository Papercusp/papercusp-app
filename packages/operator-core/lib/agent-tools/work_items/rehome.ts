/**
 * work_items:rehome — move a work-item (and its dependent rows) to another harness
 * (plan workspace-work-scope-policy-2026-09-04 P-009 — the NON-NAIVE half of the
 * workspace work-scope policy).
 *
 * A papercusp platform defect is routinely filed under the pot where it SURFACED
 * (a content-fixer quarantine in calendar / email / sidestage, a tool bug from a
 * mis-homed session). Parking every out-of-scope item as "other pot's work" would
 * be the naive filter the owner asked us not to build. This tool classifies the
 * item (`classifyForRehome`) and, on `move`, relocates the base row plus every
 * dependent row keyed by (workspace_id, harness_slug, feature_id) in ONE
 * transaction, stamping `payload.rehomed_from` for audit. Nothing is deleted; a
 * move is reversible by moving back.
 */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { classifyForRehome, isHarnessInScope, primeWorkScopePolicy, recordWorkScopeDecision } from '../../work-scope-policy';
import { loadOwnAuthorPubkeys } from '../../work-items-admission';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

/**
 * Every `harness_shared` relation carrying (workspace_id, harness_slug, feature_id)
 * rows that must follow the item when it moves. Measured 2026-09-05 from
 * information_schema (relations with all three columns, minus backups/views/logs).
 */
export const REHOME_DEPENDENT_TABLES = [
  'feature_claims',
  'claim_audit',
  'work_item_blocked',
  'work_item_release_cooldowns',
  'harness_feature_notes',
  'harness_feature_debug_notes',
  'harness_pending_issues',
  // NOT `triage_routed_items`: it is a VIEW over work_items (894-triage-corpus-views.sql),
  // so it follows the base-table move on its own and an UPDATE against it fails the whole
  // transaction ("cannot update view") — measured live 2026-09-05 on the P-009 backfill.
  // rehome.test.ts pins every entry here to a real base table in the schema dump.
] as const;

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export interface RehomeMoved {
  ok: true;
  id: string;
  from: string;
  to: string;
  /** rows moved per relation (work_items included) */
  moved: Record<string, number>;
  /** true ⇒ the move ran in full and was ROLLED BACK; nothing changed. */
  dryRun?: boolean;
}
export interface RehomeRefused {
  ok: false;
  error: 'not_found' | 'ambiguous' | 'already_home' | 'exists_in_target' | 'conflicts_in_target' | 'peer_owned';
  message: string;
  /** conflicts_in_target: the target-harness constraint the move would violate. */
  constraint?: string;
  /** conflicts_in_target: the open row in the target harness that holds the same identity, when identifiable. */
  twinId?: string | null;
}

/** Thrown to roll a dry-run transaction back after the move ran in full. */
class RehomeDryRunRollback extends Error {
  constructor(readonly outcome: RehomeMoved) {
    super('work_items:rehome dry run — rolled back');
  }
}

/**
 * The title-identity guard (migration 1157). A keyless bug/change/task may not share its
 * `payload.admissionIdentity.titleKey` with another OPEN row in the same harness, so a move
 * into a harness that already holds the newer twin is refused by the index, not by us.
 */
const TITLE_IDENTITY_CONSTRAINT = 'work_items_keyless_title_identity_uq';

/** The open row in `to` that shares the moving row's title identity (the index's own key). */
async function findTitleIdentityTwin(workspaceId: string, id: string, from: string, to: string): Promise<string | null> {
  const sql = getOrgPg().sql;
  const rows = await sql<Array<{ feature_id: string }>>`
    SELECT t.feature_id
      FROM harness_shared.work_items s
      JOIN harness_shared.work_items t
        ON t.workspace_id = s.workspace_id
       AND t.harness_slug = ${to}
       AND t.feature_id <> s.feature_id
       AND t.payload #>> '{admissionIdentity,titleKey}' = s.payload #>> '{admissionIdentity,titleKey}'
     WHERE s.workspace_id = ${workspaceId} AND s.harness_slug = ${from} AND s.feature_id = ${id}
       AND (t.status IS NULL OR t.status <> ALL (${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
     ORDER BY t.created_ts DESC NULLS LAST
     LIMIT 1`;
  return rows[0]?.feature_id ?? null;
}

function pgErrorField(err: unknown, field: 'code' | 'constraint_name'): string | null {
  const v = (err as Record<string, unknown> | null)?.[field];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The transactional move. Exported for the backfill script + tests.
 *
 * `dryRun` executes EVERY statement of the real move and then rolls the transaction back,
 * so a preview reports exactly what the move would do — including a refusal from a
 * target-harness constraint. A preview that only re-read the source row once answered
 * ok:true for three rows whose real move then died on a raw unique-violation
 * (WI-10004844, 2026-10-01).
 */
export async function rehomeWorkItem(input: {
  id: string;
  to: string;
  reason: string;
  actor: string;
  from?: string | null;
  workspaceId?: string;
  dryRun?: boolean;
}): Promise<RehomeMoved | RehomeRefused> {
  const sql = getOrgPg().sql;
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  // A remote row authored by one of THIS workspace's own substrate keys is ours (the same
  // own-node rule the claim gate applies); any other remote row belongs to a peer, and a
  // local move would fork it — the content write re-stamps origin='local' (migration 824's
  // stamp_local_federated_write), silently taking the row away from its author.
  const ownKeys = await loadOwnAuthorPubkeys(workspaceId);
  // A holder object, not a `let`: it is written inside the transaction callback, and TS
  // would otherwise keep the `null` narrowing into the catch below.
  const source: { harness: string | null } = { harness: null };
  let outcome: RehomeMoved | RehomeRefused;
  try {
    outcome = await sql.begin(async (tx): Promise<RehomeMoved | RehomeRefused> => {
    const rows = await tx<Array<{ harness_slug: string; origin: string | null; author_pubkey: string | null }>>`
      SELECT harness_slug, origin, author_pubkey FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${input.id}
         ${input.from ? tx`AND harness_slug = ${input.from}` : tx``}
       FOR UPDATE`;
    if (rows.length === 0) {
      return {
        ok: false,
        error: 'not_found',
        message: `${input.id} not found in workspace ${workspaceId}${input.from ? ` / harness ${input.from}` : ''}`,
      };
    }
    if (rows.length > 1) {
      return {
        ok: false,
        error: 'ambiguous',
        message: `${input.id} exists in ${rows.length} harnesses (${rows.map((r) => r.harness_slug).join(', ')}) — pass \`from\``,
      };
    }
    const from = rows[0]!.harness_slug;
    source.harness = from;
    if (from === input.to) return { ok: false, error: 'already_home', message: `${input.id} is already homed in ${input.to}` };
    const { origin, author_pubkey: author } = rows[0]!;
    if (origin === 'remote' && !(author && ownKeys.has(author))) {
      return {
        ok: false,
        error: 'peer_owned',
        message:
          `${input.id} is remote-authored by a key this workspace has never written locally (${author ? author.slice(0, 16) : 'no author key'}) — ` +
          `a local move would take it from its authoring peer; ask that peer to re-home it`,
      };
    }
    const clash = await tx`
      SELECT 1 FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${input.to} AND feature_id = ${input.id}
       LIMIT 1`;
    if (clash.length > 0) {
      return { ok: false, error: 'exists_in_target', message: `${input.id} already exists in ${input.to} — resolve the twin first` };
    }
    const moved: Record<string, number> = {};
    for (const table of REHOME_DEPENDENT_TABLES) {
      const r = await tx.unsafe(
        `UPDATE harness_shared.${table} SET harness_slug = $1 WHERE workspace_id = $2 AND harness_slug = $3 AND feature_id = $4`,
        [input.to, workspaceId, from, input.id],
      );
      moved[table] = r.count;
    }
    const stamp = { harness: from, at: new Date().toISOString(), by: input.actor, reason: input.reason };
    const base = await tx`
      UPDATE harness_shared.work_items
         SET harness_slug = ${input.to},
             payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('rehomed_from', ${tx.json(stamp)}::jsonb),
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${from} AND feature_id = ${input.id}`;
    moved.work_items = base.count;
    const result: RehomeMoved = { ok: true, id: input.id, from, to: input.to, moved };
    if (input.dryRun) throw new RehomeDryRunRollback({ ...result, dryRun: true });
    return result;
    });
  } catch (err) {
    if (err instanceof RehomeDryRunRollback) return err.outcome;
    // A target-harness constraint refused the move (or would have, under dryRun). Name it and,
    // for the title-identity guard, the twin that already holds the identity — instead of
    // surfacing a raw `duplicate key value violates unique constraint` handler_error.
    const from = source.harness;
    if (pgErrorField(err, 'code') === '23505' && from) {
      const constraint = pgErrorField(err, 'constraint_name') ?? 'unique constraint';
      const twinId =
        constraint === TITLE_IDENTITY_CONSTRAINT ? await findTitleIdentityTwin(workspaceId, input.id, from, input.to) : null;
      return {
        ok: false,
        error: 'conflicts_in_target',
        constraint,
        twinId,
        message:
          `${input.id} cannot move to ${input.to}: it would violate ${constraint}` +
          (twinId
            ? ` — ${twinId} already holds the same title identity there. Close ${input.id} as superseded by ${twinId} instead of moving it.`
            : constraint === TITLE_IDENTITY_CONSTRAINT
              ? ' — an open row there already holds the same title identity. Close this one as superseded instead of moving it.'
              : ''),
      };
    }
    throw err;
  }
  if (outcome.ok && !outcome.dryRun) {
    // Ledger + loudness OUTSIDE the transaction (best-effort, never rolls a move back).
    await recordWorkScopeDecision({
      site: 'work_items:rehome',
      verdict: 'rehomed',
      harness: outcome.from,
      subject: input.id,
      actor: input.actor,
      note: `→ ${outcome.to}: ${input.reason}`,
    });
  }
  return outcome;
}

interface ItemRow {
  harness_slug: string;
  title: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/** The creating role, wherever the filing path stamped it (`payload._ei.created_by`, `payload.created_by`, `metadata.created_by`). */
function createdByRole(row: ItemRow): string | null {
  const ei = (row.payload?._ei ?? null) as { created_by?: unknown } | null;
  const candidates = [ei?.created_by, row.payload?.created_by, row.payload?.created_by_role, row.metadata?.created_by];
  const hit = candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
  return hit ?? null;
}

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

export default defineTool({
  name: 'work_items:rehome',
  profile: 'engineer',
  description:
    "Move a work-item to another harness — base row + dependent claim/blocked/note rows in ONE transaction, `payload.rehomed_from` audit, nothing deleted. The NON-NAIVE half of the workspace work-scope policy: a platform defect filed under the pot where it surfaced is re-homed to papercusp instead of parked. { op:'classify', id } previews the classifier verdict; { op:'move', id, harness, reason } moves (dryRun previews).",
  capability: 'operator:write',
  guidance: {
    when: 'An out-of-scope work-item references the papercusp platform (repo paths, tool verbs, a system-role creator) — classify, then move it to papercusp so the claim gates admit it.',
    notWhen: 'To change WHICH harnesses are allowed, use workspace:work_scope. A genuinely other-pot item stays where it is (held by the policy), never moved to make it claimable.',
    chaining: "workspace:work_scope { op:'get' } → work_items:rehome { op:'classify', id } → work_items:rehome { op:'move', id, harness:'papercusp', reason } → work_items:claim.",
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 40 } },
  args: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('classify'),
      id: z.string().min(1).max(120),
      from: z.string().min(1).max(120).optional().describe('the harness the item currently lives in (disambiguates a twinned id)'),
    }),
    z.object({
      op: z.literal('move'),
      id: z.string().min(1).max(120),
      harness: z.string().min(1).max(120).describe('target harness (usually papercusp)'),
      reason: z.string().min(3).max(500),
      from: z.string().min(1).max(120).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      return json({ ok: false, error: 'forbidden', message: 'work_items:rehome needs an operator-config write role' });
    }
    const actor = `role:${ctx.role}`;
    const sql = getOrgPg().sql;
    const workspaceId = activeWorkspaceId();
    const rows = await sql<ItemRow[]>`
      SELECT harness_slug, title, summary, payload, metadata
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${args.id}
         ${args.from ? sql`AND harness_slug = ${args.from}` : sql``}
       LIMIT 2`;
    if (rows.length === 0) return json({ ok: false, error: 'not_found', message: `${args.id} not found in workspace ${workspaceId}` });
    if (rows.length > 1) {
      return json({ ok: false, error: 'ambiguous', message: `${args.id} exists in ${rows.map((r) => r.harness_slug).join(', ')} — pass from` });
    }
    const row = rows[0]!;
    const payload = row.payload ?? {};
    // PRIME BEFORE CLASSIFYING (WI-10002448) — never drop this await. BOTH readers below
    // (`classifyForRehome`'s default scope and `isHarnessInScope`) sync-read a cache an async
    // refresh fills, and an empty cache reads as "not enforced". This is the exact case
    // primeWorkScopePolicy's docstring measured (2026-09-05): the first classify after a
    // :3170 restart answered in-scope for a `calendar` item the stored policy excluded.
    await primeWorkScopePolicy();
    const verdict = classifyForRehome({
      harness: row.harness_slug,
      title: row.title,
      body: row.summary,
      paths: stringList(payload.paths),
      createdByRole: createdByRole(row),
      toolRefs: stringList(payload.toolRefs) ?? stringList(payload.refs),
    });
    if (args.op === 'classify') {
      return json({ ok: true, id: args.id, harness: row.harness_slug, inScope: isHarnessInScope(row.harness_slug), verdict });
    }
    const res = await rehomeWorkItem({
      id: args.id,
      to: args.harness,
      reason: args.reason,
      actor,
      from: row.harness_slug,
      workspaceId,
      dryRun: args.dryRun === true,
    });
    return json({ ...res, verdict });
  },
});
