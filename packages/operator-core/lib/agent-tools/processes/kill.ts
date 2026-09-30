/**
 * processes:kill — send SIGTERM (or SIGKILL) to one OR many host pids.
 *
 * Tier 1 sensitive — bearer-required, capability-gated. Agents that
 * pass URL spawn-context (no principal) cannot reach this; only callers
 * with a real bearer (dashboard via superuser token, future per-user
 * sessions) can invoke. Handler enforces a kind allowlist on top of the
 * capability gate.
 *
 * Audit log: every call writes a row to harness_shared.audit_log before
 * the signal is sent, so the action is recorded even if the kill
 * cascades through dependent processes.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `pid` for one or `pids`
 * for several → { ok, results:[{ ok, pid, kind, signal | error }], counts }.
 * Each result self-describes its pid (killProcess already returns the pid +
 * verdict), so a protected/absent pid fails ONLY itself. `signal` is
 * batch-level.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { killProcess } from '../../process-kill';
import { killScopeUnit, killTask } from '../../task-manager/control';
import { toList, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

/**
 * Independent top-level task scopes may be torn down together, but keep the
 * fan-out bounded so a caller-controlled batch cannot exhaust systemd/DB
 * capacity. Descendants of one task remain serialized inside killTask().
 */
export const PROCESS_KILL_MAX_CONCURRENCY = 4;

export default defineTool({
  name: 'processes:kill',
  profile: 'engineer',
  description:
    'Send SIGTERM (or SIGKILL) in ONE call via `taskId`/`taskIds`, `scopeUnit`/`scopeUnits`, or legacy `pid`/`pids`. PREFER task ids from `processes:list`: they kill the whole cgroup subtree and cannot hit a recycled pid. Scope units are for live unaccounted Papercusp scopes from `processes:list { live:true }`; they are re-probed before signalling. Pids are limited to managed agent kinds (`run.sh | omp | claude | codex`); bare or otherwise-unclassified Claude/Codex commands require an exact argv[0] basename match, and host services such as `hono-host.ts` have guarded controls.',
  guidance: {
    when: 'End a named task. Prefer `taskId` from `processes:list`: it kills the whole subtree. Use `pid` only for a managed AGENT process (`run.sh | omp | claude | codex`); bare or otherwise-unclassified Claude/Codex commands are accepted only when the raw PID probe sees an exact `claude`/`codex` argv[0].',
    notWhen:
      'NEVER pattern-match names to build a kill list (`pkill -f` can kill the owner\'s desktop window or peers\' tests). For runaway BUILD/TEST jobs, `pid` returns `unsupported_kind`; start them with `capability:bash { run_in_background: true }` for a real handle. Host services such as `hono-host.ts` (including desktop :3270) require guarded `dev:restart { target: "desktop-dev" }` (or the matching server target). To PAUSE, use `processes:freeze`.',
    chaining:
      '`processes:list` -> `taskId` or `live.unaccountedGroups[].scopeUnit` -> here. In taskId mode, `includeSubtree:true` also signals logically nested tasks with their own scopes.',
    returns:
      '{ ok, results:[...], counts } — keyed, not positional; one failure never fails the rest. taskId `ok:true` means the scope was re-probed empty, or SIGKILL was delivered and termination is still pending; leave LIVE rows alone; no retry. A taskId kill that begins with non-escalated SIGTERM tries a bounded `systemctl stop` fallback when the scope survives; only if that fallback and its re-probe still leave survivors does it return `ok:false, error:"incomplete"`. Explicit SIGKILL never invokes `stop`, and escalated kills retain their termination-pending/no-retry behavior. scopeUnit is accepted only for a validated `pc-*.scope` from `processes:list`; systemd must resolve it under `papercusp.slice` and verify it empty afterward (or report SIGKILL pending). Other taskId failures: `identity_mismatch` refuses a recycled identity; `not_live` means ended/residue; `unsupported`/`command_failed`. Pid failures: `pid_not_found` means absent; `unsupported_kind` means alive but outside tracked kinds (never read as gone — EI-18698120633403217); `protected_kind` is tracked but off-limits.',
  },
  capability: 'processes:kill',
  args: z
    .object({
      pid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'a host pid for a killable run.sh, omp, claude, or exact Codex CLI agent (n=1 shorthand for pids:[pid])',
        ),
      pids: z
        .array(z.number().int().positive())
        .min(1)
        .max(100)
        .optional()
        .describe('host pids for killable run.sh, omp, claude, or exact Codex CLI agents (1–100)'),
      taskId: z.string().max(64).optional().describe('a single task-ledger id (n=1 shorthand for taskIds)'),
      taskIds: z
        .array(z.string().max(64))
        .min(1)
        .max(100)
        .optional()
        .describe('task-ledger ids from processes:list — kills each whole cgroup subtree'),
      scopeUnit: z
        .string()
        .max(160)
        .optional()
        .describe('one live unaccounted Papercusp scope unit from processes:list { live:true }'),
      scopeUnits: z
        .array(z.string().max(160))
        .min(1)
        .max(100)
        .optional()
        .describe('live unaccounted Papercusp scope units from processes:list { live:true }'),
      includeSubtree: z
        .boolean()
        .optional()
        .describe('also signal logically-nested tasks that got their own scopes (taskId mode only)'),
      escalateAfterMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe('SIGTERM, then SIGKILL after this long IF the scope still holds processes (taskId mode only)'),
      signal: z.enum(['SIGTERM', 'SIGKILL']).optional().describe('the signal to send (batch-level; default SIGTERM)'),
      reapTerminalResidue: z
        .boolean()
        .optional()
        .describe(
          'WI-37521: reap a TERMINAL row (taskId mode only) whose cgroup scope is POSITIVELY re-verified, in this call, to still hold live process(es) — the "row closed, payload kept running" class. Without this the normal `not_live` refusal applies unchanged. Refused for an unconfined row or a scope that is actually empty (nothing to reap).',
        ),
    })
    .refine(
      (a) =>
        Boolean(a.pid) ||
        (a.pids?.length ?? 0) > 0 ||
        Boolean(a.taskId) ||
        (a.taskIds?.length ?? 0) > 0 ||
        Boolean(a.scopeUnit) ||
        (a.scopeUnits?.length ?? 0) > 0,
      { message: 'pass `taskId`/`taskIds`, `scopeUnit`/`scopeUnits`, or `pid`/`pids`' },
    ),
  result: z
    .object({ ok: z.unknown().optional(), results: z.unknown().optional(), counts: z.unknown().optional() })
    .passthrough(),
  async handler(args, ctx) {
    // Task-addressed kills go through the cgroup: whole subtree, no recycled-pid
    // hazard. Pid-addressed kills keep the legacy tracked-kind path.
    const taskIds = [...new Set([...toList<string>(args.taskId), ...toList<string>(args.taskIds)])];
    const taskEnv = taskIds.length
      ? await runBulk(
          taskIds,
          async (taskId) =>
            killTask(taskId, {
              signal: args.signal,
              includeSubtree: args.includeSubtree,
              escalateAfterMs: args.escalateAfterMs,
              reapTerminalResidue: args.reapTerminalResidue,
            }),
          {
            keyOf: (taskId) => ({ taskId }),
            maxConcurrency: Math.min(taskIds.length, PROCESS_KILL_MAX_CONCURRENCY),
          },
        )
      : null;

    const scopeUnits = [...new Set([...toList<string>(args.scopeUnit), ...toList<string>(args.scopeUnits)])];
    const scopeEnv = scopeUnits.length
      ? await runBulk(
          scopeUnits,
          async (scopeUnit) =>
            killScopeUnit(scopeUnit, {
              signal: args.signal,
              escalateAfterMs: args.escalateAfterMs,
            }),
          { keyOf: (scopeUnit) => ({ scopeUnit }) },
        )
      : null;

    const pids = [...new Set([...toList<number>(args.pid), ...toList<number>(args.pids)])];
    const pidEnv = pids.length
      ? await runBulk(
          pids,
          async (pid) => {
            const result = await killProcess({
              pid,
              signal: args.signal,
              actorSlug: ctx.principal.slug,
              workspaceId: ctx.principal.workspaceId,
            });
            // killProcess returns { ok, pid, kind, signal | error, detail? } — already
            // self-keyed by pid; surface it verbatim so a per-item failure rides through.
            return { ...result, ok: result.ok, pid: result.pid ?? pid };
          },
          { keyOf: (pid) => ({ pid }) },
        )
      : null;

    if (taskEnv && !pidEnv && !scopeEnv) return bulkContent(taskEnv);
    if (pidEnv && !taskEnv && !scopeEnv) return bulkContent(pidEnv);
    if (scopeEnv && !taskEnv && !pidEnv) return bulkContent(scopeEnv);
    // Multiple addressing modes in one call: merge the keyed result lists rather than picking one,
    // so a mixed batch reports every item instead of silently dropping half.
    const envs = [taskEnv, pidEnv, scopeEnv].filter(Boolean) as Array<NonNullable<typeof taskEnv>>;
    const base = envs[0]!;
    return bulkContent({
      ...base,
      results: envs.flatMap((env) => env.results ?? []),
      counts: {
        ok: envs.reduce((n, env) => n + (env.counts?.ok ?? 0), 0),
        failed: envs.reduce((n, env) => n + (env.counts?.failed ?? 0), 0),
      },
    } as typeof taskEnv);
  },
});
