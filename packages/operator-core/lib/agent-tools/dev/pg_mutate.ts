/**
 * dev:pg_mutate — the credential-safe WRITE escape hatch for operator Postgres
 * (EI-20478724424443538).
 *
 * dev:pg_query is read-only by design, and admin credentials are deliberately
 * not exposed to agents — so an authorized one-off data repair used to mean
 * process-environment spelunking or abusing the migration path, both of which
 * bypass audit entirely. This verb closes that gap WITHOUT widening the blast
 * radius: single DML statement, DDL refused (schema stays migrations-only),
 * top-level WHERE required on UPDATE/DELETE, affected-row cap + expectedRows
 * guard that ROLL BACK on breach, dryRun preview, and an audit_log row that
 * commits atomically with the mutation. Engine: ../../pg-mutate-query.ts.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  pgMutateQuery,
  writePgMutateOutcomeAudit,
  PgMutateGuardError,
  PgMutateQueryError,
  PG_MUTATE_DEFAULT_MAX_AFFECTED,
  PG_MUTATE_HARD_MAX_AFFECTED,
  type PgMutateAudit,
} from '../../pg-mutate-query';
import { extractPgErrorInfo, buildTenantScopeAdvisory, PgReadQueryTimeoutError } from '../../pg-read-query';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteHarnessSlug } from '../_harness-scope';

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function jsonError(reason: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, reason, ...extra }) }],
  };
}

export default defineTool({
  name: 'dev:pg_mutate',
  profile: 'engineer',
  description:
    'Run ONE audited INSERT/UPDATE/DELETE against operator Postgres — the authorized-data-repair escape hatch. ' +
    'Requires `reason`; UPDATE/DELETE need a top-level WHERE; rolls back over `maxAffectedRows` or on an ' +
    '`expectedRows` mismatch; `dryRun` previews. DDL refused — schema changes stay migrations-only.',
  capability: 'intel:write',
  guidance: {
    when:
      'An AUTHORIZED one-off data mutation with no documented write verb — repairing a stale row, retiring a wedged ' +
      'record. Probe the predicate with dev:pg_query first, then pass the measured count as expectedRows (or use dryRun).',
    notWhen:
      'A mutation a documented verb already covers (work_items:*, plans:*, facts:* … — those also emit sync ' +
      'invalidation; this tool does NOT, so UI projections can lag until their next refresh). Never DDL — migrations only.',
    returns:
      '{ rowsAffected, committed, rows (RETURNING, capped), truncated, fields, elapsedMs }. committed:false = dryRun ' +
      'rollback. Guard breaches return rolled_back errors carrying the measured rowsAffected; nothing was committed.',
    seeAlso: [
      'dev:pg_query (reads + `describe`; probe your WHERE there before mutating through it)',
      'db:next-migration (schema changes — never runtime DDL through this tool)',
    ],
  },
  requirePrincipal: false,
  // Same rationale as dev:pg_query (EI-20234305706295524): the engine runs its
  // own admin-pool transaction and never reads ctx.tx — retaining the ambient
  // workspace transaction would hold an app-pool slot for the whole call.
  skipWorkspaceTx: true,
  agentRoles: ['operator', 'architect', 'debugger', 'cup', 'mug', 'scoper', 'reviewer', 'validator', 'worker'],
  args: z.object({
    sql: z
      .string()
      .min(1)
      .describe('A single INSERT / UPDATE / DELETE (optionally WITH …). RETURNING is allowed. No `;`-separated statements, no DDL.'),
    reason: z
      .string()
      .min(8)
      .describe('Why this mutation is authorized/needed — stored verbatim in the audit row. Required.'),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe('Execute, report rowsAffected/RETURNING, then ROLL BACK unconditionally. The safe first run.'),
    expectedRows: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Exact-match guard: roll back unless the statement affects exactly this many rows.'),
    maxAffectedRows: z
      .number()
      .int()
      .positive()
      .max(PG_MUTATE_HARD_MAX_AFFECTED)
      .optional()
      .describe(`Roll back when more rows than this are affected (default ${PG_MUTATE_DEFAULT_MAX_AFFECTED}).`),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(30000)
      .optional()
      .describe('Bounds the WHOLE call — connect/acquire + statement_timeout + execute (default 5000).'),
    allowUnscoped: z
      .boolean()
      .optional()
      .default(false)
      .describe('Explicitly allow writing a tenant-scoped table without a workspace_id/harness_slug predicate.'),
  }),
  result: z
    .object({
      rowsAffected: z.unknown().optional(),
      committed: z.unknown().optional(),
      rows: z.unknown().optional(),
      truncated: z.unknown().optional(),
      fields: z.unknown().optional(),
      elapsedMs: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();

    const enabled = await getFlag(FLAGS.PG_MUTATE_TOOL, `pg-mutate:${workspaceId}`);
    if (!enabled) {
      return jsonError('flag_disabled', 'dev:pg_mutate is disabled (flag papercusp-pg-mutate-tool) — flip it via /admin/features.');
    }

    // An audited write REQUIRES an attributable actor — an unattributable ctx
    // is refused rather than logged as 'unknown'.
    let actor: string;
    try {
      actor = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
    } catch {
      return jsonError('unattributable_caller', 'Could not resolve your agent identity — an audited write refuses an unattributable caller.');
    }

    // Hard tenant gate (the read tool's advisory, enforced): a WHERE over a
    // tenant-scoped table must carry the tenant predicate.
    const tenantAdvisory = await buildTenantScopeAdvisory(args.sql, {
      workspaceId: ctx.workspaceId,
      // Sentinel guard via the CANONICAL resolver (no-raw-harness-sentinel): an
      // all-harness sentinel must never reach a tenant predicate as if it were a
      // concrete slug. The hand-rolled `!== '*'` form this replaced admitted the
      // OTHER sentinel spelling ('all') and did not trim, so it could leak a
      // non-concrete scope into the predicate.
      harnessSlug: resolveConcreteHarnessSlug(null, ctx),
    }).catch(() => null);
    if (tenantAdvisory && !args.allowUnscoped) {
      return jsonError(
        'tenant_scope_required',
        `${tenantAdvisory} Add the tenant predicate(s), or pass allowUnscoped: true for a deliberate cross-tenant write.`,
      );
    }

    const audit: PgMutateAudit = { actor, reason: args.reason, workspaceId };
    try {
      const result = await pgMutateQuery(args.sql, {
        timeoutMs: args.timeoutMs,
        dryRun: args.dryRun,
        expectedRows: args.expectedRows,
        maxAffectedRows: args.maxAffectedRows,
        audit,
      });
      if (!result.committed) {
        await writePgMutateOutcomeAudit(audit, 'dry_run', args.sql, { rows_affected: result.rowsAffected });
      }
      return jsonResult(result);
    } catch (err) {
      if (err instanceof PgMutateGuardError) {
        await writePgMutateOutcomeAudit(audit, 'rolled_back', args.sql, { rows_affected: err.rowsAffected });
        return jsonError('rolled_back', err.message, { rowsAffected: err.rowsAffected });
      }
      if (err instanceof PgMutateQueryError) {
        return jsonError('invalid_statement', err.message);
      }
      if (err instanceof PgReadQueryTimeoutError) {
        return jsonError('call_timeout', err.message);
      }
      const info = extractPgErrorInfo(err);
      const payload: Record<string, unknown> = {};
      if (info.hint) payload.hint = info.hint;
      if (info.detail) payload.detail = info.detail;
      if (info.code) payload.code = info.code;
      if (info.position) payload.position = info.position;
      return jsonError('pg_error', info.message, payload);
    }
  },
});
