/**
 * `durableOrchestration` — explicitly durable tool orchestration
 * (blueprint-backed-work-item-execution-2026-09-23 P-019, decision D-019; governed by D-013).
 *
 * ONE DBOS workflow per durable run. The workflow re-executes the run's PINNED script (source,
 * bindings and pin come from the recorded workflow input, never re-read) and every nested tool call
 * becomes its own checkpointed DBOS step through the generic `createDurableDispatch` wrapper — the
 * script is never retried as one opaque step. A recorded step is reused without dispatch; safe
 * pending steps resume; an uncertain write whose outcome is unknown stops the run for
 * reconciliation. There is no work item and no workflow per tool call, heartbeat or poll.
 *
 * Authority: a durable run executes with the caller's ROLE and never with superuser authority. The
 * role allowlist is recomputed from the live registry before every live step, and the real
 * dispatcher synthesizes the principal and re-gates the capability envelope per call — so recovery
 * exercises current permissions only and never a grant recorded at admission.
 *
 * DBOS executes on the primary host (bg-host). A request-side host that has not launched DBOS
 * enqueues through DBOSClient, like durable-spawn and routine fires.
 */
import { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { DBOS, DBOSClient, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  createDurableDispatch,
  durableAuthorizationDenied,
  durableRuntimeTools,
  DURABLE_RUNTIME_TOOL_NAMES,
  runToolOrchestration,
  type DispatchProjectedDeps,
  type DurableStepSummary,
  type OrchestrationInputs,
  type ProjectedTool,
  type UnifiedToolContext,
  type WrapDispatch,
} from '@papercusp/tooldef';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { dbosStarted, withDbosIdleTxGrace } from './bootstrap';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

export const DURABLE_ORCHESTRATION_WORKFLOW_NAME = 'durableOrchestration';
export const DURABLE_ORCHESTRATION_MAX_TIMEOUT_SEC = 3_600;

export interface DurableOrchestrationCaller {
  ownerId: string;
  workspaceId: string;
  harnessSlug?: string;
  role: string;
}

export interface DurableOrchestrationInput {
  /** Stable run identity; also the root of every nested idempotency key. */
  runKey: string;
  script: string;
  inputs?: OrchestrationInputs;
  /** The orchestrate:inspect pin the run was admitted against. */
  pin: { sourceSha256: string; bindingsSha256: string };
  caller: DurableOrchestrationCaller;
  timeoutSec: number;
  /** Existing handles this run belongs to. Linked, never created. */
  link?: { workItemId?: string };
}

export type DurableOrchestrationOutcome =
  | { status: 'succeeded'; summary: unknown; steps: DurableStepSummary[] }
  | { status: 'failed'; error: string; steps: DurableStepSummary[] }
  | {
      status: 'needs-reconciliation';
      reconciliation: { ordinal: number; tool: string; reason: string };
      steps: DurableStepSummary[];
    }
  | { status: 'replay-diverged'; divergence: { ordinal: number; tool: string }; steps: DurableStepSummary[] };

/** The live registry, allowlist and dispatch binding a run executes against. */
export interface DurableOrchestrationRuntime {
  tools(): readonly ProjectedTool[];
  allowedFor(role: string, tools: readonly ProjectedTool[]): ReadonlySet<string>;
  /** Tools a durable script may never reach (orchestration recursion). */
  excluded: ReadonlySet<string>;
  deps(): DispatchProjectedDeps;
  inner: WrapDispatch;
}

let configuredRuntime: DurableOrchestrationRuntime | null = null;

/** Test/host seam. Production resolves the operator registry lazily. */
export function configureDurableOrchestrationRuntime(runtime: DurableOrchestrationRuntime | null): void {
  configuredRuntime = runtime;
}

async function resolveRuntime(): Promise<DurableOrchestrationRuntime> {
  if (configuredRuntime) return configuredRuntime;
  await import('../agent-tools/index');
  const [{ listAllProjectedTools }, { roleScopedToolNames }, { PROJECTED_DEPS }, { bindCurrentCallerDispatch }, { ORCHESTRATION_RECURSION_EXCLUSIONS }] =
    await Promise.all([
      import('@papercusp/agent-mcp'),
      import('@papercusp/tooldef'),
      import('../projected-tool-deps'),
      import('../agent-tools/orchestration/current-caller-dispatch'),
      import('../agent-tools/orchestration/contract-preflight'),
    ]);
  configuredRuntime = {
    tools: () => listAllProjectedTools(),
    allowedFor: (role, tools) => roleScopedToolNames(tools, role, ORCHESTRATION_RECURSION_EXCLUSIONS),
    excluded: ORCHESTRATION_RECURSION_EXCLUSIONS,
    deps: () => PROJECTED_DEPS,
    inner: bindCurrentCallerDispatch,
  };
  return configuredRuntime;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}';
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : JSON.parse(serialized);
}

export function durableOrchestrationWorkflowId(workspaceId: string, runKey: string): string {
  return `orchestrate-durable:${workspaceId}:${runKey}`;
}

function durableRunContext(input: DurableOrchestrationInput, workflowId: string): UnifiedToolContext {
  return {
    workspaceId: input.caller.workspaceId,
    ...(input.caller.harnessSlug ? { harnessSlug: input.caller.harnessSlug } : {}),
    role: input.caller.role as UnifiedToolContext['role'],
    // Never superuser: a durable run holds only the caller's role, rechecked live per call.
    isSuperuser: false,
    // The nested key root is stable across recovery, so registered-idempotent writes dedupe.
    idempotencyKey: `durable-orchestration:${input.runKey}`,
    runId: workflowId,
    spawnId: 'durable-orchestration',
    uiClientId: input.caller.ownerId,
    featureId: input.link?.workItemId ?? null,
    transport: 'in_process',
    profile: 'engineer',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
  };
}

/** The DBOS step host. Refuses to run outside a workflow instead of silently not checkpointing. */
const dbosStepHost = {
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!DBOS.isWithinWorkflow() || DBOS.isInStep()) {
      throw new Error(`durable step ${name} is not inside a DBOS workflow; refusing an uncheckpointed dispatch`);
    }
    return DBOS.runStep(fn, { name });
  },
  sleep: (ms: number) => DBOS.sleep(ms),
  receive: (topic: string, timeoutSec: number) => DBOS.recv(topic, { timeoutSeconds: timeoutSec }),
};

export async function runDurableOrchestration(input: DurableOrchestrationInput): Promise<DurableOrchestrationOutcome> {
  const workflowId = DBOS.workflowID ?? durableOrchestrationWorkflowId(input.caller.workspaceId, input.runKey);
  const runtime = await resolveRuntime();
  const runtimeTools = durableRuntimeTools();
  const registry = [...runtime.tools(), ...runtimeTools];
  // The facade exposes the whole registry so replay stays faithful to the recorded run; the
  // CURRENT role allowlist is enforced before every live dispatch (and again by the dispatcher).
  const allowedNow = (): ReadonlySet<string> => runtime.allowedFor(input.caller.role, runtime.tools());
  const facadeScope = new Set<string>(DURABLE_RUNTIME_TOOL_NAMES);
  for (const tool of runtime.tools()) {
    const name = tool.expose?.mcp?.name;
    if (name && !runtime.excluded.has(name)) facadeScope.add(name);
  }
  const durable = createDurableDispatch({
    host: dbosStepHost,
    inner: runtime.inner,
    tools: registry,
    fingerprint: (args) => sha256(stableJson(args ?? null)),
    authorize: (toolName) => {
      if (!allowedNow().has(toolName)) {
        throw durableAuthorizationDenied(
          toolName,
          `${toolName} is not allowed for role ${input.caller.role} at the time of this live step`,
        );
      }
    },
  });
  // Worker-thread RPC callbacks must re-enter this workflow's DBOS context; binding the wrapper
  // here makes every nested step run inside it rather than silently outside any workflow.
  const wrapDispatch = AsyncResource.bind(durable.wrapDispatch) as WrapDispatch;
  const result = await runToolOrchestration(input.script, {
    ctx: durableRunContext(input, workflowId),
    deps: runtime.deps(),
    tools: registry,
    allowed: facadeScope,
    dryRun: false,
    timeoutMs: Math.min(input.timeoutSec, DURABLE_ORCHESTRATION_MAX_TIMEOUT_SEC) * 1_000,
    wrapDispatch,
    ...(input.inputs ? { inputs: input.inputs } : {}),
  });
  const steps = durable.state.steps;
  if (durable.state.reconciliation) {
    return { status: 'needs-reconciliation', reconciliation: durable.state.reconciliation, steps };
  }
  if (durable.state.divergence) return { status: 'replay-diverged', divergence: durable.state.divergence, steps };
  if (!result.ok) return { status: 'failed', error: String(result.error ?? 'durable script failed'), steps };
  return { status: 'succeeded', summary: toJsonValue(result.summary), steps };
}

export const durableOrchestrationWorkflow = idempotentRegisterWorkflow(DURABLE_ORCHESTRATION_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(runDurableOrchestration, {
    name: DURABLE_ORCHESTRATION_WORKFLOW_NAME,
    maxRecoveryAttempts: 10,
  }),
);

/**
 * Queue poll floor for durable runs (WI-10003560, plan blueprint-backed D-023). DBOS polls each
 * queue every `minPollingIntervalMs` (default 1000 ms, doubled on contention) and nothing wakes
 * the runner on enqueue, so at the default every durable run waited U(0, 1 s) before dispatch —
 * the dominant P-013 workload-D overhead (warm p50 1010 ms vs a 157 ms ceiling). 50 ms bounds that
 * wait at the cost of about 20 idle dequeue reads/s per DBOS executor. The in-memory queue config
 * wins over any persisted queue row, so this value is authoritative.
 */
export const DURABLE_ORCHESTRATION_QUEUE_MIN_POLL_MS = 50;

export const durableOrchestrationQueue = idempotentWorkflowQueue('durable-orchestration', () =>
  new WorkflowQueue('durable-orchestration', {
    concurrency: queueConcurrency(4),
    minPollingIntervalMs: DURABLE_ORCHESTRATION_QUEUE_MIN_POLL_MS,
  }),
);

/** The DBOSClient subset a request-side host drives; tests replace it. */
export interface DurableOrchestrationClient {
  enqueue(options: {
    queueName: string;
    workflowName: string;
    workflowID: string;
    deduplicationID: string;
    duplicationPolicy: 'return-existing';
    appVersion: string;
  }, input: DurableOrchestrationInput): Promise<unknown>;
  getWorkflow(workflowId: string): Promise<{ status: string; output?: unknown; error?: unknown } | undefined>;
  listWorkflowSteps(workflowId: string): Promise<Array<{ functionID: number; name: string; error?: unknown }> | undefined>;
  cancelWorkflow(workflowId: string): Promise<void>;
  send(destinationId: string, message: unknown, topic?: string, idempotencyKey?: string): Promise<void>;
}

let remoteClient: Promise<DurableOrchestrationClient> | null = null;

function primaryAppVersion(): string {
  return (
    process.env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION?.trim() ||
    process.env.DBOS__APPVERSION?.trim() ||
    'bg-host-v1'
  );
}

function getRemoteClient(): Promise<DurableOrchestrationClient> {
  remoteClient ??= DBOSClient.create({
    systemDatabaseUrl: withDbosIdleTxGrace(getHarnessAdminUrlWithSource().url),
    systemDatabaseSchemaName: 'dbos',
  }).then((client) => client as unknown as DurableOrchestrationClient).catch((error: unknown) => {
    remoteClient = null;
    throw error;
  });
  return remoteClient;
}

type ClientDeps = { client?: () => Promise<DurableOrchestrationClient> };

/** Admit a durable run. Repeating the same run key returns the existing workflow. */
export async function startDurableOrchestration(
  input: DurableOrchestrationInput,
  deps: ClientDeps = {},
): Promise<{ workflowId: string }> {
  const workflowID = durableOrchestrationWorkflowId(input.caller.workspaceId, input.runKey);
  if (dbosStarted()) {
    await DBOS.startWorkflow(durableOrchestrationWorkflow, {
      workflowID,
      queueName: durableOrchestrationQueue.name,
    })(input);
    return { workflowId: workflowID };
  }
  const client = await (deps.client ?? getRemoteClient)();
  await client.enqueue({
    queueName: durableOrchestrationQueue.name,
    workflowName: DURABLE_ORCHESTRATION_WORKFLOW_NAME,
    workflowID,
    deduplicationID: workflowID,
    duplicationPolicy: 'return-existing',
    appVersion: primaryAppVersion(),
  }, input);
  return { workflowId: workflowID };
}

export interface DurableOrchestrationStatus {
  workflowId: string;
  status: string;
  outcome?: DurableOrchestrationOutcome;
  error?: string;
  steps: Array<{ functionId: number; name: string; failed: boolean }>;
}

/** Read one durable run: DBOS status, its per-call step ledger and the settled outcome. */
export async function getDurableOrchestrationStatus(
  workflowId: string,
  deps: ClientDeps = {},
): Promise<DurableOrchestrationStatus | null> {
  const local = dbosStarted();
  const client = local ? null : await (deps.client ?? getRemoteClient)();
  const workflow = local
    ? await DBOS.getWorkflowStatus(workflowId)
    : await client!.getWorkflow(workflowId);
  if (!workflow) return null;
  const rawSteps = (local ? await DBOS.listWorkflowSteps(workflowId) : await client!.listWorkflowSteps(workflowId)) ?? [];
  const record = workflow as { status: string; output?: unknown; error?: unknown };
  return {
    workflowId,
    status: record.status,
    ...(record.status === 'SUCCESS' && record.output ? { outcome: record.output as DurableOrchestrationOutcome } : {}),
    ...(record.error ? { error: record.error instanceof Error ? record.error.message : String(record.error) } : {}),
    steps: rawSteps.map((step) => ({ functionId: step.functionID, name: step.name, failed: step.error != null })),
  };
}

/** Cancel a durable run, or deliver a signal to one of its declared waits. */
export async function controlDurableOrchestration(
  control: { workflowId: string; action: 'cancel' } | { workflowId: string; action: 'signal'; topic: string; message: unknown; idempotencyKey?: string },
  deps: ClientDeps = {},
): Promise<void> {
  const local = dbosStarted();
  if (control.action === 'cancel') {
    if (local) await DBOS.cancelWorkflow(control.workflowId);
    else await (await (deps.client ?? getRemoteClient)()).cancelWorkflow(control.workflowId);
    return;
  }
  if (local) await DBOS.send(control.workflowId, control.message, control.topic, control.idempotencyKey);
  else await (await (deps.client ?? getRemoteClient)()).send(control.workflowId, control.message, control.topic, control.idempotencyKey);
}
