/**
 * Isolated DBOS worker for durable-orchestration-workflow.crash.integration.test.ts
 * (blueprint-backed-work-item-execution-2026-09-23 P-019, D-019).
 *
 * The child runs the REAL `durableOrchestration` workflow against a throwaway database with a
 * synthetic tool registry whose tools log every live dispatch to `test_durable.calls`. In `crash`
 * mode the tool named by DURABLE_CRASH_TARGET is SIGKILLed right after its side effect — the exact
 * window where the effect happened but the step outcome was never recorded. In `recover` mode the
 * child relaunches DBOS on a fresh executor, lets recovery resume the same workflow ID, and prints
 * the settled outcome. DURABLE_CRASH_REVOKE removes one tool from the caller's CURRENT role
 * allowlist at recovery time.
 */
import postgres from 'postgres';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ProjectedTool, ToolResult, UnifiedToolContext } from '@papercusp/tooldef';

const dsn = process.env.DURABLE_CRASH_DSN;
const runKey = process.env.DURABLE_CRASH_RUN_KEY;
const mode = process.env.DURABLE_CRASH_MODE;
const script = process.env.DURABLE_CRASH_SCRIPT;
const crashTarget = process.env.DURABLE_CRASH_TARGET ?? '';
const revoked = new Set((process.env.DURABLE_CRASH_REVOKE ?? '').split(',').filter(Boolean));
if (!dsn || !runKey || !script || (mode !== 'crash' && mode !== 'recover')) {
  throw new Error('durable orchestration crash fixture configuration is incomplete');
}

const sql = postgres(dsn, { max: 2, onnotice: () => {} });

function probeTool(name: string, effect: 'read' | 'write', idempotent: boolean): ProjectedTool {
  return {
    pluginName: 'durable-crash-probe',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    idempotent,
    expose: { mcp: { name } },
    fn: async (args: unknown, ctx: UnifiedToolContext): Promise<ToolResult> => {
      await sql.unsafe(
        'INSERT INTO test_durable.calls (run_key, tool, mode, args, idempotency_key) VALUES ($1, $2, $3, $4, $5)',
        [runKey, name, mode, JSON.stringify(args ?? null), ctx.idempotencyKey ?? null],
      );
      if (mode === 'crash' && name === crashTarget) {
        // The side effect is committed; the process dies before DBOS records the step outcome.
        process.kill(process.pid, 'SIGKILL');
        await new Promise<never>(() => {});
      }
      const count = await sql.unsafe('SELECT count(*)::int AS n FROM test_durable.calls WHERE run_key = $1', [runKey]);
      return { content: [{ type: 'text', text: JSON.stringify({ tool: name, seen: count[0]?.n ?? 0 }) }] };
    },
  } as ProjectedTool;
}

const TOOLS: ProjectedTool[] = [
  probeTool('probe:read', 'read', false),
  probeTool('probe:put', 'write', true),
  probeTool('probe:send', 'write', false),
  probeTool('probe:after', 'read', false),
];

DBOS.setConfig({
  name: 'durable-orchestration-crash-p019',
  systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos',
  applicationVersion: 'durable-orchestration-crash-p019-v1',
  runAdminServer: false,
});

const workflow = await import('../lib/dbos/durable-orchestration-workflow');
// The seam MUST be configured before DBOS.launch: recovery starts at launch and would otherwise
// resolve the real operator registry.
workflow.configureDurableOrchestrationRuntime({
  tools: () => TOOLS,
  allowedFor: (_role, tools) => new Set(
    tools.map((tool) => tool.expose?.mcp?.name ?? '').filter((name) => name && !revoked.has(name)),
  ),
  excluded: new Set<string>(),
  deps: () => ({}),
  inner: (_tool, _name, _args, ctx, next) => next(ctx),
});

await DBOS.launch();
(globalThis as { __papercuspDbosStarted?: boolean }).__papercuspDbosStarted = true;

const input = {
  runKey,
  script,
  pin: { sourceSha256: 'fixture', bindingsSha256: 'fixture' },
  caller: { ownerId: 'durable-crash-caller', workspaceId: 'ws-p019-crash', role: 'worker' },
  timeoutSec: 60,
};
const workflowId = workflow.durableOrchestrationWorkflowId(input.caller.workspaceId, runKey);

if (mode === 'crash') {
  await workflow.startDurableOrchestration(input);
  const settled = await DBOS.getResult(workflowId, 60);
  throw new Error('crash point was not reached; workflow settled with ' + JSON.stringify(settled));
}

const outcome = await DBOS.getResult(workflowId, 90);
const status = await workflow.getDurableOrchestrationStatus(workflowId);
process.stdout.write('DURABLE_OUTCOME ' + JSON.stringify({ outcome, status }) + '\n');
await DBOS.shutdown();
await sql.end({ timeout: 5 });
