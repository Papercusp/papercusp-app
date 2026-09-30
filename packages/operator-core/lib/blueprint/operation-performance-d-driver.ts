/** P-013 workload D driver (plan blueprint-backed-work-item-execution-2026-09-23, D-016/D-019).
 *
 * A 4-tool recipe — two reads, one deterministic idempotent write, one declared wait — run
 * through the PUBLIC `orchestrate:run` handler on both arms:
 *   control   = current foreground orchestrate:run (the result IS the receipt);
 *   candidate = durable orchestrate:run (execution { background, durable } + inspectionPin):
 *               one DBOS workflow per run, one DBOS step per nested call (D-019).
 * The wait is the same fixed delay on both arms: the candidate uses the runtime-owned durable
 * timer (`tools.runtime.sleep`, DBOS.sleep — the only declared-wait primitive a durable script
 * may use), the control has no runtime facade so it waits through a fixture tool for the same
 * P013D_WAIT_MS. Everything else in the two scripts is byte-identical.
 *
 * Both the Vitest parent and the fresh cold child execute exactly these calls. */
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import type { ProjectedTool, ToolResult, UnifiedToolContext } from '@papercusp/tooldef';
import type { PhaseMarks } from '../../test/_paired-operation-benchmark';

export const P013D_WORKSPACE = 'p013-benchmark';
export const P013D_HARNESS = 'p013-benchmark-fixture';
export const P013D_OWNER = 'su-p013-d';
export const P013D_ROLE = 'worker';
export const P013D_WAIT_MS = 5;
/** Isolated DBOS system schema inside the throwaway database — never the shared `dbos` queue. */
export const P013D_DBOS_SCHEMA = 'dbos_p013d';
export const P013D_VALUE = 'd'.repeat(1024);

export type P013DArm = 'control' | 'candidate';

const RECIPE_HEAD = [
  "const cfg = await tools.p013d.readConfig({ key: 'p013d' });",
  "const put = await tools.p013d.put({ key: 'p013d', value: cfg.value });",
  "const back = await tools.p013d.readBack({ key: 'p013d' });",
];
const RECIPE_TAIL = "return { ok: true, bytes: String(back.value ?? '').length, put: put.inserted };";

/** Byte-identical except for the declared-wait line (see module comment). */
export const P013D_SCRIPTS: Readonly<Record<P013DArm, string>> = Object.freeze({
  control: [...RECIPE_HEAD, `await tools.p013d.wait({ ms: ${P013D_WAIT_MS} });`, RECIPE_TAIL].join('\n'),
  candidate: [...RECIPE_HEAD, `await tools.runtime.sleep({ ms: ${P013D_WAIT_MS} });`, RECIPE_TAIL].join('\n'),
});

export function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

/** First nested-tool start per run (ctx.runId) — the D-016 "dispatched" mark. */
const firstDispatch = new Map<string, number>();

export async function ensureP013DSchema(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS p013d;
    CREATE TABLE IF NOT EXISTS p013d.config (key text PRIMARY KEY, value text NOT NULL);
    CREATE TABLE IF NOT EXISTS p013d.writes (
      idempotency_key text PRIMARY KEY,
      run_id text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      written_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS p013d.write_attempts (
      seq bigserial PRIMARY KEY,
      run_id text NOT NULL,
      idempotency_key text
    );
    INSERT INTO p013d.config (key, value) VALUES ('p013d', '${P013D_VALUE}') ON CONFLICT (key) DO NOTHING;
  `);
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] } as ToolResult;
}

function fixtureTool(
  name: string,
  effect: 'read' | 'write',
  idempotent: boolean,
  properties: Record<string, unknown>,
  required: string[],
  fn: (args: Record<string, unknown>, ctx: UnifiedToolContext) => Promise<unknown>,
): ProjectedTool {
  return {
    pluginName: 'p013-workload-d',
    description: `P-013 workload D fixture ${name}`,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    capabilities: [],
    // A real role gate so both arms pay the live authorization check (default-deny otherwise).
    agentRoles: [P013D_ROLE as NonNullable<ProjectedTool['agentRoles']>[number]],
    effect,
    idempotent,
    expose: { mcp: { name } },
    fn: async (args: unknown, ctx: UnifiedToolContext): Promise<ToolResult> => {
      const runId = String(ctx.runId ?? '');
      if (runId && !firstDispatch.has(runId)) firstDispatch.set(runId, epochNow());
      return textResult(await fn((args ?? {}) as Record<string, unknown>, ctx));
    },
  } as ProjectedTool;
}

/** Deterministic fixtures: no provider, no clock, no randomness. The write is idempotent on the
 * caller-visible idempotency key; every live invocation is also logged so a repeated effect is
 * visible even when the unique key absorbs it. */
export function p013DFixtureTools(getSql: () => Sql): ProjectedTool[] {
  const keyProps = { key: { type: 'string', minLength: 1, maxLength: 64 } };
  return [
    fixtureTool('p013d:read_config', 'read', false, keyProps, ['key'], async (args) => {
      const rows = await getSql()<Array<{ value: string }>>`SELECT value FROM p013d.config WHERE key = ${String(args.key)}`;
      return { value: rows[0]?.value ?? null };
    }),
    fixtureTool('p013d:put', 'write', true, { ...keyProps, value: { type: 'string', maxLength: 4096 } }, ['key', 'value'],
      async (args, ctx) => {
        const runId = String(ctx.runId ?? '');
        const idem = ctx.idempotencyKey ?? `run:${runId}`;
        const sql = getSql();
        await sql`INSERT INTO p013d.write_attempts (run_id, idempotency_key) VALUES (${runId}, ${ctx.idempotencyKey ?? null})`;
        const inserted = await sql`
          INSERT INTO p013d.writes (idempotency_key, run_id, key, value)
          VALUES (${idem}, ${runId}, ${String(args.key)}, ${String(args.value ?? '')})
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING 1`;
        return { inserted: inserted.length === 1 };
      }),
    fixtureTool('p013d:read_back', 'read', false, keyProps, ['key'], async (args, ctx) => {
      const rows = await getSql()<Array<{ value: string }>>`
        SELECT value FROM p013d.writes WHERE run_id = ${String(ctx.runId ?? '')} AND key = ${String(args.key)} LIMIT 1`;
      return { value: rows[0]?.value ?? null };
    }),
    fixtureTool('p013d:wait', 'read', true, { ms: { type: 'integer', minimum: 0, maximum: 1000 } }, ['ms'],
      async (args) => {
        await new Promise((resolve) => setTimeout(resolve, Number(args.ms)));
        return { waited: Number(args.ms) };
      }),
  ];
}

export interface P013DTools {
  runTool: { handler: (...args: never[]) => Promise<unknown> };
  inspectTool: { handler: (...args: never[]) => Promise<unknown> };
}

export interface P013DRuntime {
  sql: Sql;
  tools: P013DTools;
  /** DBOS.getResult for the candidate's workflow handle. */
  awaitDurable: (workflowId: string, timeoutSec: number) => Promise<unknown>;
  pin: { sourceSha256: string; bindingsSha256: string };
  /** DBOS system schema this runtime's executor owns (a cold candidate child gets its own, so no
   * other live executor listening on the same queue can dequeue — and so execute — its workflow). */
  dbosSchema?: string;
}

export interface P013DSample extends PhaseMarks {
  runId: string;
  workflowId: string | null;
  /** Raw first-dispatch preceded the receipt (candidate local start); the mark is clamped to accepted. */
  dispatchBeforeReceipt: boolean;
}

export function p013DCaller(runId: string, idempotencyKey: string): UnifiedToolContext {
  return {
    workspaceId: P013D_WORKSPACE,
    harnessSlug: P013D_HARNESS,
    role: P013D_ROLE as UnifiedToolContext['role'],
    isSuperuser: false,
    uiClientId: P013D_OWNER,
    runId,
    idempotencyKey,
    transport: 'in_process',
    profile: 'engineer',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
  } as UnifiedToolContext;
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> } | null)?.content;
  return content?.map((part) => part.text ?? '').join('') ?? '';
}

export function parseToolJson(result: unknown): Record<string, unknown> {
  // defineTool handlers return the structured object directly; only the projected MCP form wraps
  // it in a content envelope.
  if (result && typeof result === 'object' && !Array.isArray((result as { content?: unknown }).content)) {
    return result as Record<string, unknown>;
  }
  const text = resultText(result);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`P-013 D: tool returned non-JSON: ${text.slice(0, 400)}`);
  }
}

/** Find the { sourceSha256, bindingsSha256 } pin anywhere in orchestrate:inspect's result. */
export function findInspectionPin(value: unknown): { sourceSha256: string; bindingsSha256: string } | null {
  if (typeof value === 'string' && value.includes('sourceSha256')) {
    try { return findInspectionPin(JSON.parse(value)); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sourceSha256 === 'string' && typeof record.bindingsSha256 === 'string') {
    return { sourceSha256: record.sourceSha256, bindingsSha256: record.bindingsSha256 };
  }
  for (const child of Object.values(record)) {
    const found = findInspectionPin(child);
    if (found) return found;
  }
  return null;
}

export async function inspectCandidatePin(tools: P013DTools): Promise<{ sourceSha256: string; bindingsSha256: string }> {
  const caller = p013DCaller('p013d-inspect', 'p013d-inspect');
  const inspected = await tools.inspectTool.handler({
    script: { source: P013D_SCRIPTS.candidate },
    execution: { lifecycle: 'background', durability: 'durable' },
  } as never, caller as never);
  const body = parseToolJson(inspected);
  const pin = findInspectionPin(body);
  if (!pin) throw new Error(`P-013 D: orchestrate:inspect returned no pin: ${JSON.stringify(body).slice(0, 600)}`);
  return pin;
}

function extractWorkflowId(body: Record<string, unknown>): string {
  const summary = body.summary;
  const parsed = typeof summary === 'string' ? JSON.parse(summary) as Record<string, unknown> : summary as Record<string, unknown>;
  const workflowId = (parsed?.durableRun as { workflowId?: string } | undefined)?.workflowId;
  if (!workflowId) throw new Error(`P-013 D: durable admission returned no workflowId: ${JSON.stringify(body).slice(0, 600)}`);
  return workflowId;
}

function assertSucceeded(arm: P013DArm, body: unknown): void {
  const text = JSON.stringify(body);
  if (!text.includes('"ok":true') && !text.includes('\\"ok\\":true')) {
    throw new Error(`P-013 D ${arm}: run did not succeed: ${text.slice(0, 800)}`);
  }
}

/** One sample on one arm, through the public handlers only. */
export async function runP013WorkloadD(rt: P013DRuntime, arm: P013DArm, runId: string): Promise<P013DSample> {
  const caller = p013DCaller(runId, `p013d:${runId}`);
  const ingress = epochNow();
  if (arm === 'control') {
    const result = await rt.tools.runTool.handler({ script: { source: P013D_SCRIPTS.control } } as never, caller as never);
    const terminal = epochNow();
    const body = parseToolJson(result);
    assertSucceeded(arm, body);
    const dispatched = firstDispatch.get(runId);
    firstDispatch.delete(runId);
    if (dispatched === undefined) throw new Error(`P-013 D control: no nested tool dispatched for ${runId}`);
    // Foreground has no receipt distinct from dispatch: admission and dispatch collapse, and the
    // returned result is both the terminal and the business event.
    return { ingress, accepted: dispatched, dispatched, terminal, businessEvent: terminal,
      runId, workflowId: null, dispatchBeforeReceipt: false };
  }
  const admitted = await rt.tools.runTool.handler({
    script: { source: P013D_SCRIPTS.candidate },
    execution: { lifecycle: 'background', durability: 'durable' },
    inspectionPin: rt.pin,
    timeoutSec: 120,
  } as never, caller as never);
  const accepted = epochNow();
  const workflowId = extractWorkflowId(parseToolJson(admitted));
  const outcome = await rt.awaitDurable(workflowId, 120) as { status?: string; summary?: unknown } | null;
  const terminal = epochNow();
  if (outcome?.status !== 'succeeded') {
    throw new Error(`P-013 D candidate: durable run ${workflowId} settled ${JSON.stringify(outcome).slice(0, 800)}`);
  }
  // The run's terminal event as seen through the public status surface.
  const status = parseToolJson(await rt.tools.inspectTool.handler({ durableRun: { workflowId } } as never, caller as never));
  const businessEvent = epochNow();
  const state = JSON.stringify(status);
  if (!/SUCCESS|succeeded/i.test(state)) throw new Error(`P-013 D candidate: inspect status not terminal: ${state.slice(0, 600)}`);
  const rawDispatch = firstDispatch.get(workflowId);
  firstDispatch.delete(workflowId);
  if (rawDispatch === undefined) throw new Error(`P-013 D candidate: no nested tool dispatched for ${workflowId}`);
  const dispatchBeforeReceipt = rawDispatch < accepted;
  const dispatched = Math.min(Math.max(rawDispatch, accepted), terminal);
  const persistence = await durablePersistence(rt.sql, workflowId, rt.dbosSchema);
  return { ingress, accepted, dispatched, terminal, businessEvent, runId, workflowId, dispatchBeforeReceipt,
    durableSteps: persistence.steps, dbBytes: persistence.bytes };
}

/** Extra DBOS persistence for one durable run: step rows and the bytes of every DBOS system row
 * it wrote (workflow_status + operation_outputs + notifications + events). Measured after
 * terminal, outside the timed window. */
export async function durablePersistence(
  sql: Sql, workflowId: string, schema: string = P013D_DBOS_SCHEMA,
): Promise<{ steps: number; rows: number; bytes: number }> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`P-013 D: unsafe DBOS schema name ${schema}`);
  const s = schema;
  const [row] = await sql.unsafe<Array<{ steps: number; rows: number; bytes: number }>>(`
    WITH ops AS (SELECT pg_column_size(o.*) AS b FROM "${s}".operation_outputs o WHERE workflow_uuid = $1),
         wf  AS (SELECT pg_column_size(w.*) AS b FROM "${s}".workflow_status w WHERE workflow_uuid = $1),
         ev  AS (SELECT pg_column_size(e.*) AS b FROM "${s}".workflow_events e WHERE workflow_uuid = $1)
    SELECT (SELECT count(*) FROM ops)::int AS steps,
           ((SELECT count(*) FROM ops) + (SELECT count(*) FROM wf) + (SELECT count(*) FROM ev))::int AS rows,
           (coalesce((SELECT sum(b) FROM ops), 0) + coalesce((SELECT sum(b) FROM wf), 0)
             + coalesce((SELECT sum(b) FROM ev), 0))::int AS bytes`, [workflowId]);
  return row ?? { steps: 0, rows: 0, bytes: 0 };
}

/** Behavioral invariant: the idempotent write happened exactly once per run, and no live
 * write invocation was repeated (including across the durable step boundary). */
export async function assertWriteExactlyOnce(sql: Sql, runIds: readonly string[]): Promise<{ runs: number; writes: number; attempts: number }> {
  const [row] = await sql<Array<{ writes: number; attempts: number; bad: number }>>`
    WITH ids AS (SELECT unnest(${sql.array([...runIds])}::text[]) AS run_id),
         w AS (SELECT run_id, count(*) AS n FROM p013d.writes WHERE run_id IN (SELECT run_id FROM ids) GROUP BY run_id),
         a AS (SELECT run_id, count(*) AS n FROM p013d.write_attempts WHERE run_id IN (SELECT run_id FROM ids) GROUP BY run_id)
    SELECT coalesce((SELECT sum(n) FROM w), 0)::int AS writes,
           coalesce((SELECT sum(n) FROM a), 0)::int AS attempts,
           (SELECT count(*) FROM ids LEFT JOIN w USING (run_id) LEFT JOIN a USING (run_id)
             WHERE coalesce(w.n, 0) <> 1 OR coalesce(a.n, 0) <> 1)::int AS bad`;
  if (!row || row.bad !== 0) {
    throw new Error(`P-013 D invariant: ${row?.bad ?? '?'} of ${runIds.length} runs did not write exactly once`);
  }
  return { runs: runIds.length, writes: row.writes, attempts: row.attempts };
}
