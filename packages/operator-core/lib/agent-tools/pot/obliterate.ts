/**
 * pot:obliterate — completely delete a local pot, "as if it was never created".
 *
 * WHY THIS EXISTS: `pot:dissolve { dropSchema:true }` is a SOFT teardown. It clears the
 * Mug wake, cancels cups, tears down the learning loop, releases the desktop, deregisters
 * the harness, and drops the per-harness schema `harness_<slug>` — but the pot's rows live
 * in the SHARED `harness_shared` schema (work_items, harness_plans, harness_plan_parts,
 * plan_revisions, hive_settings, …), keyed by `harness_slug`. Those survive, so
 * `work_items:list { harness:<slug> }` still returns the pot's items after a dissolve.
 * The platform is otherwise append-only: `dev:pg_query` is read-only and there is no
 * hard-delete verb. This tool is that verb.
 *
 * Steps (each idempotent + tolerant of already-done):
 *   1. pot:dissolve { slug, confirm:true, dropSchema } — in-process, reusing its own
 *      root-only / owner-tier / confirm gates. `hive_not_found` is tolerated (re-run safe).
 *   2. purgeSharedRows: hard-DELETE every `harness_shared` BASE TABLE row (pg_class.relkind
 *      = 'r') carrying a `harness_slug` column, WHERE harness_slug = slug. FK order is
 *      handled by a bounded multi-pass loop (a parent blocked by a child this pass is
 *      deleted on a later pass). The whole purge is ONE statement (a DO block) that RAISEs
 *      — and therefore rolls back — if it cannot fully clear, so there is never a
 *      half-purge. `harness_features` / `harness_features_consolidated` / `fleet_assignment`
 *      are VIEWS over work_items+presence and read empty once the base rows are gone; they
 *      are skipped (a DELETE on a UNION view errors).
 *   3. Retract every harness-scoped fact for the slug.
 *   4. purgeFleetMembership: drop `fleet_membership_events` rows for a same-named fleet.
 *   5. removeFiles: rm the app tree (<papercuspRoot>/apps/<slug>), its git checkpoint
 *      worktree (<slug>-checkpoint), and the fleet launch-context file.
 *
 * NOT scrubbed by default: the large append-only audit/telemetry tables (coord_event_log,
 * tool_invocations, session_turns, …). They are system-wide history, expensive to scan, and
 * surface the pot nowhere. Pass purgeLogs:true to include them.
 *
 * ROOT-ONLY + confirm-gated + irreversible. Capability `harness:write` (same as pot:dissolve,
 * of which this is a strict superset) — mints no new capability.
 */
import { z } from 'zod';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { papercuspRoot } from '../../papercusp-root';
import { inProcessCall } from '../_compound-dispatch';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/**
 * Large, system-wide append-only audit/telemetry tables. Excluded from the purge by default:
 * they are shared history (not the pot's own records), are slow to scan, and never surface
 * the pot as a pot/plan/work-item. `purgeLogs:true` opts them in.
 */
const AUDIT_LOG_TABLES = [
  'coord_event_log',
  'tool_invocations',
  'tool_invocations_artifacts',
  'tool_invocations_spawn_tree',
  'session_turns',
  'session_briefs',
  'agent_activity',
  // retire-work-item-mail-surface-2026-07-26 P-006: the work-item mail surface's
  // write path (`messages:send`) is retired, so this table is append-only history
  // now — kept here (never purged by default) same as any other audit log. No
  // existing rows are deleted by this plan.
  'messages_consolidated',
  'executed_actions_consolidated',
  'user_actions',
  'claim_audit',
  'adaptive_telemetry',
  'agent_usage_samples',
  'toast_log',
  'token_index',
  'webhook_audit',
  'provision_audit_log',
  'harness_hook_logs',
  'agent_runs_consolidated',
  'agent_chats_consolidated',
] as const;

/** A harness slug is a kebab identifier. Validated before it is ever inlined into SQL. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The set of harness_shared BASE TABLES (never views) keyed by harness_slug. */
const tableSetSql = (excludeSql: string) => `
  SELECT c.relname
  FROM pg_class c
  JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
  WHERE nsp.nspname = 'harness_shared'
    AND c.relkind = 'r'
    AND c.relname NOT IN (${excludeSql})
    AND EXISTS (
      SELECT 1 FROM information_schema.columns col
      WHERE col.table_schema = 'harness_shared'
        AND col.table_name = c.relname
        AND col.column_name = 'harness_slug'
    )`;

/** Per-table row counts for the slug (only non-empty tables). Cheap: the log tables are out. */
const countSql = (excludeSql: string, slugLit: string) => `
  SELECT relname AS "table", cnt FROM (
    SELECT c.relname,
      (xpath('/row/c/text()', query_to_xml(
        format('SELECT count(*) AS c FROM harness_shared.%I WHERE harness_slug = %L', c.relname, ${slugLit}),
        false, true, '')))[1]::text::int AS cnt
    FROM (${tableSetSql(excludeSql)}) c
  ) s WHERE cnt > 0 ORDER BY cnt DESC, "table"`;

/**
 * One statement, therefore one transaction: multi-pass FK-tolerant delete, then a verify
 * that RAISEs (⇒ rollback) if anything survives. No half-purge is possible.
 */
const purgeSql = (excludeSql: string, slugLit: string) => `
DO $obliterate$
DECLARE r record; n bigint; remaining bigint := 0;
BEGIN
  FOR i IN 1..20 LOOP
    FOR r IN ${tableSetSql(excludeSql)} LOOP
      BEGIN
        EXECUTE format('DELETE FROM harness_shared.%I WHERE harness_slug = %L', r.relname, ${slugLit});
      EXCEPTION WHEN foreign_key_violation THEN
        NULL; -- blocked by a child this pass; a later pass gets it
      END;
    END LOOP;
  END LOOP;

  FOR r IN ${tableSetSql(excludeSql)} LOOP
    EXECUTE format('SELECT count(*) FROM harness_shared.%I WHERE harness_slug = %L', r.relname, ${slugLit}) INTO n;
    IF n > 0 THEN
      remaining := remaining + n;
      RAISE WARNING 'pot:obliterate — % rows remain in harness_shared.%', n, r.relname;
    END IF;
  END LOOP;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'pot:obliterate purge incomplete: % rows remain (rolled back); likely an FK cycle or an FK from an excluded audit table', remaining;
  END IF;
END
$obliterate$;`;

export default defineTool({
  name: 'pot:obliterate',
  profile: 'engineer',
  description:
    "Completely delete a local pot as if it never existed (root-only, destructive — pass confirm:true). Runs pot:dissolve {dropSchema} and then hard-DELETEs the pot's leftover rows from the SHARED harness_shared schema that dissolve leaves behind (work_items, plans, revisions, hive_settings, …), retracts its harness-scoped facts, drops a same-named fleet's membership rows, and removes its on-disk app tree, checkpoint worktree, and launch-context file. The purge is atomic — it rolls back rather than half-clear. Large append-only audit/telemetry logs are excluded unless purgeLogs:true. Irreversible.",
  guidance: {
    when: 'The owner wants a pot GONE — not just torn down. Use after (or instead of) pot:dissolve when `work_items:list {harness:<slug>}` must return [] and no trace should remain.',
    notWhen:
      'A reversible teardown — pot:dissolve (keeps the shared rows). Freezing a pot — pot:pause. Destroying a deployed cloud frame — deploy:teardown_pot (run that FIRST if the pot is deployed). From a cup — not allowed.',
    chaining:
      'deploy:teardown_pot first if deployed; loop:end first if you have a monitor loop on it. Verify after: pot:get {slug} → hive_not_found, work_items:list {harness:slug} → [].',
    seeAlso: [
      'pot:dissolve (soft teardown — leaves harness_shared rows)',
      'pot:pause (freeze instead of deleting)',
      'deploy:teardown_pot (destroy a deployed Swarm frame first)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The pot's home-harness slug to obliterate."),
    confirm: z
      .boolean()
      .optional()
      .describe('Required true — pot:obliterate is irreversible (hard row deletion + schema drop + file removal).'),
    dropSchema: z.boolean().optional().describe('Drop the harness_<slug> PG schema CASCADE. Default true.'),
    purgeSharedRows: z
      .boolean()
      .optional()
      .describe("Hard-DELETE the pot's rows from harness_shared base tables. Default true — this is the point of the tool."),
    purgeLogs: z
      .boolean()
      .optional()
      .describe('Also purge the large append-only audit/telemetry tables (coord_event_log, tool_invocations, …). Default false.'),
    purgeFleetMembership: z
      .boolean()
      .optional()
      .describe('Drop fleet_membership_events rows for a fleet named like the slug. Default true.'),
    removeFiles: z
      .boolean()
      .optional()
      .describe('rm the app tree, its checkpoint git worktree, and the fleet launch-context file. Default true.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only (mirrors pot:dissolve D-002) — a cup must never obliterate its own pot.
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_obliterate_root_only',
        message: 'pot:obliterate cannot be called from a cup (a spawned/parented agent). Only the operator/user obliterates a pot.',
      });
    }
    if (!args.confirm) {
      return text({
        ok: false,
        error: 'confirm_required',
        message:
          'pot:obliterate is IRREVERSIBLE — pass confirm:true. It dissolves the pot, hard-deletes its harness_shared rows, retracts its facts, and removes its files.',
      });
    }
    if (!SLUG_RE.test(args.slug)) {
      return text({ ok: false, error: 'invalid_slug', message: `Refusing to obliterate an unsafe slug: ${args.slug}` });
    }

    const slug = args.slug;
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const call = inProcessCall(ctx);
    const steps: Record<string, unknown> = {};

    // 1. Soft teardown first: reuse pot:dissolve wholesale (its own gates, wake/cups/
    //    learning-loop/desktop/deregister/schema-drop). Tolerate an already-dissolved pot
    //    so obliterate is safely re-runnable over a partial cleanup.
    try {
      const dissolved = (await call('pot:dissolve', {
        slug,
        confirm: true,
        dropSchema: args.dropSchema ?? true,
        workspace: workspaceId,
      })) as Record<string, unknown>;
      steps.dissolve = dissolved;
      if (dissolved?.ok === false && dissolved?.error !== 'hive_not_found') {
        return text({ ok: false, error: 'dissolve_failed', slug, dissolve: dissolved });
      }
    } catch (e) {
      steps.dissolve = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }

    const { sql } = getOrgPg();
    const slugLit = sqlLiteral(slug);
    const excludeSql = args.purgeLogs ? "''" : AUDIT_LOG_TABLES.map((t) => `'${t}'`).join(',');

    // 2. The hard part: purge the SHARED-schema rows pot:dissolve leaves behind.
    if (args.purgeSharedRows ?? true) {
      try {
        const before = (await sql.unsafe(countSql(excludeSql, slugLit))) as Array<{ table: string; cnt: number }>;
        await sql.unsafe(purgeSql(excludeSql, slugLit));
        const after = (await sql.unsafe(countSql(excludeSql, slugLit))) as Array<{ table: string; cnt: number }>;
        steps.purged = before;
        steps.purgedRowTotal = before.reduce((a, r) => a + Number(r.cnt), 0);
        steps.remaining = after;
        steps.purgeClean = after.length === 0;
      } catch (e) {
        steps.purgeClean = false;
        steps.purgeError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
    }

    // 3. Retract every harness-scoped fact for the slug (they'd otherwise keep folding
    //    into peers' orient/brief for a dead pot).
    try {
      const listed = (await call('facts:list', { scope: 'harness', scopeRef: slug, limit: 100 })) as {
        facts?: Array<{ key: string }>;
      };
      const keys = (listed?.facts ?? []).map((f) => f.key);
      for (const key of keys) {
        await call('facts:retract', { scope: 'harness', scopeRef: slug, key }).catch(() => undefined);
      }
      steps.factsRetracted = keys.length;
    } catch (e) {
      steps.factsRetracted = 0;
      steps.factsError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }

    // 4. A pot launched as a fleet leaves membership rows keyed by fleet_slug (NOT
    //    harness_slug), so the generic purge above misses them. Best-effort.
    if (args.purgeFleetMembership ?? true) {
      try {
        const dropped = await sql.unsafe(
          `DELETE FROM harness_shared.fleet_membership_events WHERE fleet_slug = $1 AND workspace_id = $2`,
          [slug, workspaceId],
        );
        steps.fleetMembershipRowsDropped = (dropped as unknown as { count?: number })?.count ?? 0;
      } catch (e) {
        steps.fleetMembershipError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
    }

    // 5. On-disk residue: the app tree, its git checkpoint worktree, the launch-context file.
    if (args.removeFiles ?? true) {
      const root = papercuspRoot();
      const targets = [
        join(root, 'apps', slug),
        join(root, 'apps', `${slug}-checkpoint`),
        join(root, 'launch-context', `fleet-${slug}-launch-context.md`),
      ];
      const removed: string[] = [];
      for (const t of targets) {
        try {
          await rm(t, { recursive: true, force: true });
          removed.push(t);
        } catch (e) {
          console.warn(`[pot:obliterate] rm ${t} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      steps.filesRemoved = removed;
    }

    return text({ ok: true, slug, obliterated: true, ...steps });
  },
});
