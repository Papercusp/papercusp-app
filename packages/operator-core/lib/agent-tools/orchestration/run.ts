import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { AGENT_ROLES, defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import {
  durableRuntimeTools,
  type OrchestrationInputs,
  type ToolResult,
} from '@papercusp/tooldef';
import {
  buildOutputEnvelope,
  DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS,
  type OutputEnvelope,
  type OutputExecutionMetrics,
  type OutputReplayStateContentItem,
} from '../../output-envelope';
import { clampForegroundTimeoutMs } from '../capability/foreground-transport-cap';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import codeRunTool, {
  type CodeRunCaptureMode,
  withCodeRunCaptureMode,
  withCodeRunContract,
} from '../code/run';
import { inspectScriptContract } from './contract-preflight';
import { inspectDurability } from './durability-inspection';
import { inspectOrchestration } from './inspect';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import type { ProjectedTool } from '@papercusp/tooldef';
import {
  controlDurableOrchestration,
  startDurableOrchestration,
} from '../../dbos/durable-orchestration-workflow';
import {
  orchestrationPolicyFailure,
  orchestrationSourceArgsSchema,
  type OrchestrationScriptSource,
  type OrchestrationSourceArgs,
} from './public-contract';
import {
  savedRecipeAdapterFor,
  type SavedRecipeAdapter,
  type SavedRecipeSelector,
} from './saved-recipe-adapter';

const DEFAULT_TIMEOUT_SEC = 30;

export const serverScriptRunArgsSchema = orchestrationSourceArgsSchema;
export type ServerScriptRunArgs = OrchestrationSourceArgs & {
  script: OrchestrationScriptSource;
  recipe?: undefined;
};

type TextContent = { type: 'text'; text: string };
type MediaContent =
  | { type: 'image'; data: string; mimeType: string; _meta?: Record<string, unknown> }
  | { type: 'audio'; data: string; mimeType: string };

type CodeRunToolResult = Omit<ToolResult, 'content'> & {
  content: Array<ToolResult['content'][number] | MediaContent>;
};

type CodeRunPayload = {
  ok?: unknown;
  summary?: unknown;
  error?: unknown;
  partial?: unknown;
  dispatchCount?: unknown;
  intermediateBytes?: unknown;
  plannedMutations?: unknown;
  writeAttempts?: unknown;
  rejectedMutations?: unknown;
  uncertainMutations?: unknown;
  childFailures?: unknown;
  notDispatchedWrites?: unknown;
  runtimeObservations?: unknown;
  state?: unknown;
};

function runtimeObservations(value: unknown): {
  authorizationObservationCount: number;
  authorityWideningDetected: boolean;
  midTurnPromptInjectionObservability: 'not-observable';
} {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    authorizationObservationCount: finiteNonNegative(record.authorizationObservationCount) ?? 0,
    authorityWideningDetected: record.authorityWideningDetected === true,
    // Server execution has no truthful before/after signal for native-client
    // prompt injection. Never turn missing visibility into an unchanged claim.
    midTurnPromptInjectionObservability: 'not-observable',
  };
}

export interface ServerScriptRunDeps {
  runCode: (
    args: {
      script: string;
      title?: string;
      description?: string;
      dryRun?: boolean;
      timeoutSec?: number;
    },
    ctx: UnifiedToolContext,
    captureMode: CodeRunCaptureMode,
  ) => Promise<CodeRunToolResult>;
  /** Synthetic-catalog seam for focused composition tests. Production calls
   * omit this and preflight against the live current-caller registry. */
  inspectScript?: typeof inspectScriptContract;
  projectedTools?: readonly ProjectedTool[];
  startDurable?: typeof startDurableOrchestration;
  durableRunKey?: (ctx: UnifiedToolContext) => string;
}

function pinMatches(
  expected: NonNullable<OrchestrationSourceArgs['inspectionPin']>,
  actual: { sourceSha256: string; bindingsSha256: string; recipeRevision?: string },
): boolean {
  return expected.sourceSha256 === actual.sourceSha256 &&
    expected.bindingsSha256 === actual.bindingsSha256 &&
    expected.recipeRevision === actual.recipeRevision;
}

const DEFAULT_DEPS: ServerScriptRunDeps = {
  async runCode(args, ctx, captureMode) {
    return codeRunTool.handler(
      args as never,
      withCodeRunCaptureMode(ctx, captureMode) as never,
    ) as Promise<CodeRunToolResult>;
  },
  startDurable: startDurableOrchestration,
};

const DURABLE_ADMISSION_HAZARDS = new Set([
  'wall-clock',
  'random-control',
  'uncheckpointed-wait',
  'ambient-environment',
]);

function defaultDurableRunKey(ctx: UnifiedToolContext): string {
  const requestKey = ctx.idempotencyKey?.trim();
  if (!requestKey) return randomUUID();
  return createHash('sha256')
    .update(`${ctx.workspaceId ?? ''}\0${ctx.uiClientId ?? ctx.principal?.slug ?? ''}\0${requestKey}`)
    .digest('hex');
}

function isTextContent(value: unknown): value is TextContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

function isMediaContent(value: unknown): value is MediaContent {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    (item.type === 'image' || item.type === 'audio') &&
    typeof item.data === 'string' &&
    typeof item.mimeType === 'string'
  );
}

function parseCodeRunResult(result: CodeRunToolResult): {
  payload: CodeRunPayload;
  media: MediaContent[];
} {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find(isTextContent);
  if (!text) throw new TypeError('code:run returned no text payload');
  const parsed = JSON.parse(text.text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('code:run returned a non-object payload');
  }
  return {
    payload: parsed as CodeRunPayload,
    media: content.filter(isMediaContent),
  };
}

function authoredSummaryText(value: unknown): string {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value ?? '') : serialized;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function replayStateContent(value: unknown): OutputReplayStateContentItem[] {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('code:run returned non-object replay state');
  }
  return [{ kind: 'replay-state', values: value as Record<string, unknown> }];
}

function executionMetrics(
  args: ServerScriptRunArgs,
  payload: CodeRunPayload,
  durationMs: number,
  captureMode: CodeRunCaptureMode,
): OutputExecutionMetrics {
  const requestedTimeoutSec = args.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const effectiveTimeoutSec = args.timeoutSec
    ? clampForegroundTimeoutMs(args.timeoutSec * 1_000) / 1_000
    : DEFAULT_TIMEOUT_SEC;
  const dispatchCount = finiteNonNegative(payload.dispatchCount) ?? 0;
  const observations = runtimeObservations(payload.runtimeObservations);

  return {
    backend: 'server',
    durationMs,
    toolCalls: 1 + dispatchCount,
    intermediateBytes: finiteNonNegative(payload.intermediateBytes) ?? 0,
    requestedTimeoutSec,
    effectiveTimeoutSec,
    requestedExecutionMode: args.execution?.mode ?? 'server',
    executionMode: 'server',
    executionModeDeprecated: args.execution?.mode === 'auto',
    lifecycle: 'foreground',
    captureMode,
    dryRun: args.dryRun ?? false,
    plannedMutationCount: countArray(payload.plannedMutations),
    writeAttemptCount: countArray(payload.writeAttempts),
    rejectedMutationCount: countArray(payload.rejectedMutations),
    uncertainMutationCount: countArray(payload.uncertainMutations),
    childFailureCount: countArray(payload.childFailures),
    notDispatchedWriteCount: countArray(payload.notDispatchedWrites),
    authorizationObservationCount: observations.authorizationObservationCount,
    authorityWideningDetected: observations.authorityWideningDetected,
    midTurnPromptInjectionObservability: observations.midTurnPromptInjectionObservability,
  };
}

function executionEnvelope(
  args: ServerScriptRunArgs,
  payload: CodeRunPayload,
  durationMs: number,
  captureMode: CodeRunCaptureMode,
): OutputEnvelope {
  const summary = authoredSummaryText(payload.summary);
  const metrics = executionMetrics(args, payload, durationMs, captureMode);
  const content = replayStateContent(payload.state);
  if (payload.ok === false) {
    return buildOutputEnvelope({
      summary,
      ...(content.length ? { content } : {}),
      state: 'error',
      error: {
        code: 'script_execution_failed',
        message: typeof payload.error === 'string' ? payload.error : 'code:run execution failed',
      },
      metrics,
    });
  }
  if (payload.partial === true || countArray(payload.childFailures) > 0) {
    return buildOutputEnvelope({
      summary,
      ...(content.length ? { content } : {}),
      state: 'incomplete',
      incomplete: { reason: 'partial_execution' },
      metrics,
    });
  }
  return buildOutputEnvelope({ summary, ...(content.length ? { content } : {}), metrics });
}

/** WI-40720 gap 2 — the ONE place orchestrate:run stamps its outer `tool_invocations` row.
 *
 *  Before this, exactly one of four return paths stamped anything: the script SUCCESS path, and
 *  only backend/returnedContextBytes/failureClass. Preflight refusals, the saved-recipe path and
 *  both catch paths stamped NOTHING, so an orchestrate:run that was refused, threw, or ran a saved
 *  recipe left no telemetry row at all. The rollout gates then measured only the runs that
 *  succeeded via a fresh script — a survivorship filter that makes failure rate and latency look
 *  better the more often the door breaks.
 *
 *  Easy to miss because the file LOOKS instrumented: every path already fills `metrics` on the
 *  returned ENVELOPE (backend, phase, executed, durationMs). That is the model-facing response,
 *  not the telemetry row — nothing reads it back into `tool_invocations`. The envelope is what a
 *  reader sees; `ctx.metadata` is what the gates count.
 *
 *  Vocabulary deliberately mirrors code:run's stamp (see agent-tools/code/run.ts) so
 *  CODE_RUN_INSTRUMENTATION_SQL reads both doors through identical keys. */
function stampOrchestrationRow(
  ctx: Pick<UnifiedToolContext, 'metadata'>,
  input: {
    /** The call's own args. Source, requested mode and recipe identity are all DERIVED from
     *  this rather than passed per-path: every one of them was, at some point in review, set on
     *  one path and missing on the others. Deriving them here makes that class impossible. */
    args: OrchestrationSourceArgs;
    envelope: { state?: string; error?: { code?: string }; incomplete?: { reason?: string } };
    serializedBytes: number;
    durationMs: number;
    phase: 'preflight' | 'execution';
    executed: boolean;
    extra?: Record<string, unknown>;
  },
): void {
  const { envelope, args } = input;
  const requested = args.execution?.mode ?? 'server';
  const source = args.script
    ? 'script'
    : args.recipe
      ? 'recipe'
      : args.durableControl
        ? 'durable-control'
        : 'durable-run';
  ctx.metadata?.({
    backend: 'server',
    // A requested mode the server did not honour is one of gap 4's HARD rollback triggers
    // (server-backend mismatch), so it has to be measurable rather than inferred.
    //
    // ⚠ `auto` is NOT a mismatch. It is a request to let the server CHOOSE, so being served
    // server-side is that request being honoured, not violated. Counting it would have fired a
    // hard rollback trigger on correct behaviour — and because `auto` is the mode a caller picks
    // when they have no opinion, it would likely have been the most common value, making the
    // gate's loudest alarm also its least meaningful one.
    requestedExecutionMode: requested,
    backendMismatch: requested !== 'server' && requested !== 'auto',
    source,
    // Everything recipe-shaped is derived together, for every recipe path — success, refusal
    // and throw alike. Two separate review findings came from stamping these on the success
    // path only: recipeRequested-on-success-only excluded failed calls from the very
    // denominator reuse is measured against (so reuse rate IMPROVED as recipes broke), and
    // selector-on-success-only meant a failing recipe could be counted but not IDENTIFIED —
    // you would know recipes were failing and not which one. Deriving here ends both.
    ...(source === 'recipe'
      ? {
          recipeRequested: true,
          ...(args.recipe?.id ? { recipeId: args.recipe.id } : {}),
          ...(args.recipe?.revision === undefined ? {} : { recipeRevision: args.recipe.revision }),
        }
      : {}),
    phase: input.phase,
    executed: input.executed,
    durationMs: Math.max(0, input.durationMs),
    returnedContextBytes: input.serializedBytes,
    // The door has not spilled at this point; _mcp-handler backfills the real figure when it
    // later projects or spills the response (WI-40720 gap 3).
    spilledBytes: 0,
    failureClass:
      envelope.state === 'complete' ? null : (envelope.error?.code ?? envelope.incomplete?.reason ?? envelope.state),
    ...(input.extra ?? {}),
  });
}

function preflightError(
  code: string,
  message: string,
  args: OrchestrationSourceArgs,
  ctx?: Pick<UnifiedToolContext, 'metadata'>,
): ToolResult {
  const envelope = buildOutputEnvelope({
    summary: '',
    state: 'error',
    error: { code, message },
    metrics: {
      backend: 'server',
      phase: 'preflight',
      executed: false,
      requestedExecutionMode: args.execution?.mode ?? 'server',
      lifecycle: args.execution?.lifecycle ?? 'foreground',
    },
  });
  const serialized = JSON.stringify(envelope);
  // `ctx` is optional so existing direct callers/tests keep compiling; when it is supplied the
  // refusal becomes countable. A preflight refusal is a REAL outcome of the door — omitting it
  // is what let "capability unavailable" and policy refusals vanish from the failure rate.
  if (ctx) {
    stampOrchestrationRow(ctx, {
      envelope,
      serializedBytes: Buffer.byteLength(serialized, 'utf8'),
      durationMs: 0,
      phase: 'preflight',
      executed: false,
      args,
      extra: { capabilityMiss: code === 'capability_unavailable' },
    });
  }
  return { content: [{ type: 'text', text: serialized }] } as ToolResult;
}

/** Thin server-script adapter. All execution, repair, timeout, authorization and
 * recipe-capture behavior remains owned by code:run; this layer only maps the
 * public script policy and emits the shared P-006 envelope. */
export async function runServerScriptAdapter(
  args: ServerScriptRunArgs,
  ctx: UnifiedToolContext,
  deps: ServerScriptRunDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  const policyFailure = orchestrationPolicyFailure(args, 'run');
  if (policyFailure) return preflightError(policyFailure.error.code, policyFailure.error.message, args, ctx);

  const checked = await (deps.inspectScript ?? inspectScriptContract)({
    script: args.script,
    bindings: args.bindings,
    lifecycle: args.execution?.lifecycle,
    ctx,
  });
  if (!checked.ok) return preflightError(checked.error.code, checked.error.message, args, ctx);

  if (args.inspectionPin) {
    const durable = args.execution?.durability === 'durable';
    const projectedTools = deps.projectedTools ?? listAllProjectedTools();
    const durability = await inspectDurability({
      script: args.script.source,
      bindings: checked.contract.bindings,
      calls: checked.staticCalls,
      tools: durable ? [...projectedTools, ...durableRuntimeTools()] : projectedTools,
    });
    if (!pinMatches(args.inspectionPin, durability.pin)) {
      return preflightError('inspection_pin_stale', 'script or validated bindings changed since orchestrate:inspect', args, ctx);
    }
    if (durable) {
      const hazards = durability.diagnostics
        .map((diagnostic) => diagnostic.code)
        .filter((code) => DURABLE_ADMISSION_HAZARDS.has(code));
      if (hazards.length > 0) {
        return preflightError(
          'durable_replay_unsafe',
          `durable admission refused nondeterminism hazard(s): ${[...new Set(hazards)].join(', ')}`,
          args,
          ctx,
        );
      }
      const ownerId = ctx.uiClientId ?? ctx.principal?.slug ?? ctx.spawnId ?? ctx.runId;
      if (!ctx.workspaceId || !ctx.role || !ownerId) {
        return preflightError(
          'capability_denied',
          'durable admission requires current workspace, role and owner identity context',
          args,
          ctx,
        );
      }
      const timeoutSec = args.timeoutSec ?? 3_600;
      const callerHarnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
      try {
        const admitted = await (deps.startDurable ?? startDurableOrchestration)({
          runKey: (deps.durableRunKey ?? defaultDurableRunKey)(ctx),
          script: args.script.source,
          inputs: checked.contract.bindings.inputs as OrchestrationInputs,
          pin: {
            sourceSha256: durability.pin.sourceSha256,
            bindingsSha256: durability.pin.bindingsSha256,
          },
          caller: {
            ownerId,
            workspaceId: ctx.workspaceId,
            // The superuser '*' sentinel is truthy but names no harness; stamp only a
            // concrete slug onto the durable run's caller identity.
            ...(callerHarnessSlug ? { harnessSlug: callerHarnessSlug } : {}),
            role: ctx.role,
          },
          timeoutSec,
          ...(args.workItemId ? { link: { workItemId: args.workItemId } } : {}),
        });
        const envelope = buildOutputEnvelope({
          summary: JSON.stringify({ durableRun: { workflowId: admitted.workflowId, status: 'admitted' } }),
          metrics: {
            backend: 'dbos',
            phase: 'admission',
            executed: true,
            lifecycle: 'background',
            durability: 'durable',
            timeoutSec,
          },
        });
        const serialized = JSON.stringify(envelope);
        stampOrchestrationRow(ctx, {
          envelope,
          serializedBytes: Buffer.byteLength(serialized, 'utf8'),
          durationMs: 0,
          phase: 'execution',
          executed: true,
          args,
          extra: { backend: 'dbos', durability: 'durable', durableWorkflowId: admitted.workflowId },
        });
        return { content: [{ type: 'text', text: serialized }] } as ToolResult;
      } catch (error) {
        return preflightError(
          'durable_admission_failed',
          error instanceof Error ? error.message : String(error),
          args,
          ctx,
        );
      }
    }
  }

  const captureMode = args.capture?.mode ?? 'auto';
  const startedAt = Date.now();
  try {
    const codeResult = await deps.runCode(
      {
        script: args.script.source,
        title: args.capture?.title ?? args.script.title,
        description: args.capture?.description ?? args.script.description,
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
        ...(args.timeoutSec === undefined ? {} : { timeoutSec: args.timeoutSec }),
      },
      withCodeRunContract(ctx, {
        inputs: checked.contract.bindings.inputs,
        ...(checked.contract.bindingSchema ? { bindingSchema: checked.contract.bindingSchema } : {}),
        capabilityManifest: checked.manifest,
        ...(args.capture?.tags ? { tags: args.capture.tags } : {}),
      }),
      captureMode,
    );
    const { payload, media } = parseCodeRunResult(codeResult);
    const durationMs = Math.max(0, Date.now() - startedAt);
    let envelope: OutputEnvelope;
    try {
      envelope = executionEnvelope(args, payload, durationMs, captureMode);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      envelope = buildOutputEnvelope({
        summary: '',
        state: 'error',
        error: {
          code: 'summary_budget_exceeded',
          message:
            `${error.message}; author a bounded summary within ` +
            `${DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS} characters and return bulky evidence through references`,
        },
        metrics: {
          ...executionMetrics(args, payload, durationMs, captureMode),
          phase: 'execution',
          executed: true,
        },
      });
    }

    const serialized = JSON.stringify(envelope);
    stampOrchestrationRow(ctx, {
      envelope,
      serializedBytes:
        Buffer.byteLength(serialized, 'utf8') +
        media.reduce((sum, item) => sum + Buffer.byteLength(item.data, 'utf8'), 0),
      durationMs: Math.max(0, Date.now() - startedAt),
      phase: 'execution',
      executed: true,
      args,
    });
    return {
      content: [{ type: 'text', text: serialized }, ...media],
    } as unknown as ToolResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = buildOutputEnvelope({
      summary: '',
      state: 'error',
      error: { code: 'server_adapter_failed', message, retryable: false },
      metrics: {
        backend: 'server',
        phase: 'execution',
        executed: false,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
    const serialized = JSON.stringify(envelope);
    // A thrown adapter is the single most important row to record and was the one most surely
    // missing: without it, every crash of this door was invisible to the failure-rate gate.
    stampOrchestrationRow(ctx, {
      envelope,
      serializedBytes: Buffer.byteLength(serialized, 'utf8'),
      durationMs: Math.max(0, Date.now() - startedAt),
      phase: 'execution',
      executed: false,
      args,
    });
    return {
      isError: true,
      content: [{ type: 'text', text: serialized }],
    } as ToolResult;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function recipeRunEnvelope(
  raw: unknown,
  args: OrchestrationSourceArgs,
  durationMs: number,
  // WI-40720 gap 2: optional so existing direct callers/tests keep compiling; supplied by
  // runOrchestration so the saved-recipe path stamps a telemetry row like the script path does.
  ctx?: Pick<UnifiedToolContext, 'metadata'>,
): ToolResult {
  const direct = asRecord(raw);
  if (direct?.ok === false && asRecord(direct.error)) {
    const error = asRecord(direct.error)!;
    return preflightError(
      String(error.code ?? 'recipe_preflight_failed'),
      String(error.message ?? 'recipe preflight failed'),
      args,
      ctx,
    );
  }
  const results = direct?.results;
  const item = Array.isArray(results) ? asRecord(results[0]) : null;
  if (!item) throw new Error('orchestrate:run: recipes:run returned an invalid envelope');

  const result = asRecord(item.result) ?? {};
  const summary = authoredSummaryText(result.summary ?? result.result);
  const metrics: OutputExecutionMetrics = {
    backend: 'server',
    durationMs,
    toolCalls: 1 + (finiteNonNegative(result.dispatchCount) ?? 0),
    intermediateBytes: finiteNonNegative(result.intermediateBytes) ?? 0,
    requestedTimeoutSec: args.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    effectiveTimeoutSec: args.timeoutSec
      ? clampForegroundTimeoutMs(args.timeoutSec * 1_000) / 1_000
      : DEFAULT_TIMEOUT_SEC,
    requestedExecutionMode: args.execution?.mode ?? 'server',
    executionMode: 'server',
    executionModeDeprecated: args.execution?.mode === 'auto',
    lifecycle: 'foreground',
    recipeReuse: true,
    recipeId: args.recipe?.id ?? String(item.id ?? ''),
    dryRun: args.dryRun ?? false,
    plannedMutationCount: countArray(result.plannedMutations),
    writeAttemptCount: countArray(result.writeAttempts),
    rejectedMutationCount: countArray(result.rejectedMutations),
    uncertainMutationCount: countArray(result.uncertainMutations),
    childFailureCount: countArray(result.childFailures),
    notDispatchedWriteCount: countArray(result.notDispatchedWrites),
  };

  let envelope: OutputEnvelope;
  try {
    if (item.ok !== true) {
      const phase = item.phase === 'preflight' ? 'preflight' : 'execution';
      envelope = buildOutputEnvelope({
        summary,
        state: 'error',
        error: {
          code: String(item.error ?? 'recipe_execution_failed'),
          message: String(asRecord(item.diagnostic)?.message ?? item.reason ?? 'saved recipe execution failed'),
        },
        metrics: { ...metrics, phase, executed: phase !== 'preflight' },
      });
    } else if (result.partial === true || countArray(result.childFailures) > 0) {
      envelope = buildOutputEnvelope({
        summary,
        state: 'incomplete',
        incomplete: { reason: 'partial_execution' },
        metrics,
      });
    } else {
      envelope = buildOutputEnvelope({ summary, metrics });
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    envelope = buildOutputEnvelope({
      summary: '',
      state: 'error',
      error: {
        code: 'summary_budget_exceeded',
        message:
          `${error.message}; author a bounded summary within ` +
          `${DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS} characters and return bulky evidence through references`,
      },
      metrics: { ...metrics, phase: 'execution', executed: true },
    });
  }
  const serialized = JSON.stringify(envelope);
  if (ctx) {
    // Derive phase/executed from the envelope that was ACTUALLY built, never hardcode them.
    // `item.ok === false` with `item.phase === 'preflight'` produces a preflight/not-executed
    // envelope, and an earlier draft stamped execution/true regardless — which would have
    // recorded a recipe that never ran as a completed execution, inflating both the executed
    // count and the latency sample with work that did not happen.
    const built = envelope as { metrics?: { phase?: string; executed?: boolean } };
    stampOrchestrationRow(ctx, {
      envelope,
      serializedBytes: Buffer.byteLength(serialized, 'utf8'),
      durationMs,
      phase: built.metrics?.phase === 'preflight' ? 'preflight' : 'execution',
      executed: built.metrics?.executed ?? true,
      args,
      // Saved-recipe reuse is a headline P-020 rollout metric and this path recorded none of it.
      // recipeId is taken from `metrics`, which already resolved it as args.recipe?.id ?? item.id —
      // an earlier draft re-derived it with `typeof args.recipe === 'string'`, which can NEVER be
      // true because the public selector is an object, so it silently stamped nothing. Reusing the
      // resolved value is both correct and drift-proof.
      extra: {
        // recipeRequested is NOT set here — the helper derives it from source:'recipe' so every
        // recipe path (success, refusal, throw) lands in the denominator, not just this one.
        recipeReuse: true,
        ...(metrics.recipeId ? { recipeId: metrics.recipeId } : {}),
        ...(args.recipe?.revision === undefined ? {} : { recipeRevision: args.recipe.revision }),
      },
    });
  }
  return { content: [{ type: 'text', text: serialized }] } as ToolResult;
}

export async function runOrchestration(
  args: OrchestrationSourceArgs,
  ctx: UnifiedToolContext,
  deps: {
    server?: ServerScriptRunDeps;
    recipes?: SavedRecipeAdapter;
    durableControl?: typeof controlDurableOrchestration;
  } = {},
): Promise<ToolResult> {
  const policyFailure = orchestrationPolicyFailure(args, 'run');
  if (policyFailure) return preflightError(policyFailure.error.code, policyFailure.error.message, args, ctx);
  if (args.durableControl) {
    const { workflowId } = args.durableControl;
    if (!ctx.workspaceId || !workflowId.startsWith(`orchestrate-durable:${ctx.workspaceId}:`)) {
      return preflightError(
        'capability_denied',
        'durable run does not belong to the current workspace',
        args,
        ctx,
      );
    }
    try {
      await (deps.durableControl ?? controlDurableOrchestration)(
        args.durableControl.action === 'cancel'
          ? { workflowId, action: 'cancel' }
          : {
              workflowId,
              action: 'signal',
              topic: args.durableControl.topic,
              message: args.durableControl.message ?? null,
              ...(args.durableControl.idempotencyKey
                ? { idempotencyKey: args.durableControl.idempotencyKey }
                : {}),
            },
      );
      const envelope = buildOutputEnvelope({
        summary: JSON.stringify({
          durableControl: { workflowId, action: args.durableControl.action, accepted: true },
        }),
        metrics: {
          backend: 'dbos',
          phase: 'control',
          executed: true,
          lifecycle: 'background',
          durability: 'durable',
        },
      });
      const serialized = JSON.stringify(envelope);
      stampOrchestrationRow(ctx, {
        envelope,
        serializedBytes: Buffer.byteLength(serialized, 'utf8'),
        durationMs: 0,
        phase: 'execution',
        executed: true,
        args,
        extra: { backend: 'dbos', durability: 'durable', durableWorkflowId: workflowId },
      });
      return { content: [{ type: 'text', text: serialized }] } as ToolResult;
    } catch (error) {
      return preflightError(
        'durable_control_failed',
        error instanceof Error ? error.message : String(error),
        args,
        ctx,
      );
    }
  }
  if (args.script) {
    return runServerScriptAdapter(args as ServerScriptRunArgs, ctx, deps.server ?? DEFAULT_DEPS);
  }

  const startedAt = Date.now();
  try {
    const adapter = deps.recipes ?? savedRecipeAdapterFor(ctx);
    if (args.inspectionPin) {
      const inspected = await inspectOrchestration(args, ctx, {
        recipes: adapter,
        ...(deps.server?.inspectScript ? { inspectScript: deps.server.inspectScript } : {}),
        ...(deps.server?.projectedTools ? { projectedTools: deps.server.projectedTools } : {}),
      });
      const data = (inspected as ToolResult & { data?: unknown }).data;
      const record = asRecord(data);
      const normalized = asRecord(record?.normalized);
      const durability = asRecord(normalized?.durability);
      const pin = asRecord(durability?.pin);
      if (!record?.ok || !pin || !pinMatches(args.inspectionPin, pin as {
        sourceSha256: string; bindingsSha256: string; recipeRevision?: string;
      })) {
        return preflightError('inspection_pin_stale', 'saved recipe revision, source or validated bindings changed since orchestrate:inspect', args, ctx);
      }
    }
    const raw = await adapter.run({
      recipe: args.recipe as SavedRecipeSelector,
      ...(args.bindings ? { bindings: args.bindings } : {}),
      ...(args.timeoutSec === undefined ? {} : { timeoutSec: args.timeoutSec }),
      ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
    });
    return recipeRunEnvelope(raw, args, Math.max(0, Date.now() - startedAt), ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = buildOutputEnvelope({
      summary: '',
      state: 'error',
      error: { code: 'server_adapter_failed', message, retryable: false },
      metrics: { backend: 'server', phase: 'execution', executed: false },
    });
    const serialized = JSON.stringify(envelope);
    stampOrchestrationRow(ctx, {
      envelope,
      serializedBytes: Buffer.byteLength(serialized, 'utf8'),
      durationMs: Math.max(0, Date.now() - startedAt),
      phase: 'execution',
      executed: false,
      args,
    });
    return { isError: true, content: [{ type: 'text', text: serialized }] } as ToolResult;
  }
}

const orchestrateRunTool = defineTool({
  name: 'orchestrate:run',
  description:
    'Preferred execution door for exactly one fresh script or saved recipe, plus explicit durable-run cancel/signal control. Foreground runs execute on the server; pinned durable scripts run as background DBOS workflows under the current caller.',
  guidance: {
    when: 'After orchestrate:search/inspect, run one fresh script or exact saved-recipe continuation.',
    notWhen: 'You need a single direct tool call or must use a native compatibility door explicitly.',
    chaining:
      'orchestrate:search { query } → orchestrate:inspect { recipe|script } → orchestrate:run { recipe|script }; use durableControl for cancel/signal',
    seeAlso: ['orchestrate:search', 'orchestrate:inspect', 'code:run (compatibility door)', 'recipes:run (compatibility door)'],
  },
  // The wrapper only needs the read-only facade capability: inner tools retain their own
  // capability/role/envelope gates, which lets evidence-only roles (notably judge) orchestrate
  // reads without granting the shell capability. Keep the explicit write effect because this
  // generic execution door can still contain write-effect inner calls for roles that have them.
  capability: 'agent_tools:read',
  effect: 'write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: serverScriptRunArgsSchema,
  handler(args, ctx) {
    return runOrchestration(args, ctx);
  },
});

export default orchestrateRunTool;
