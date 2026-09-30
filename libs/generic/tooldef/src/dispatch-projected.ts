/**
 * Unified dispatcher entrypoints for projected tools.
 *
 * Both transports (MCP `tools/call` and HTTP catch-all) end up here.
 * The actual pipeline — gates, timeout/idle watchdog, replay buffer,
 * ctx-binding wrappers, handler invoke, telemetry — lives in
 * `dispatch-stack.ts` as a named, ordered, replaceable stack.
 * This file is the public surface (the two top-level functions every
 * consumer calls) plus the streaming wrapper.
 *
 * Re-exports the shared types from `dispatch-types.ts` so existing
 * imports of `DispatchProjectedDeps`, `PASS_THROUGH`, etc. from
 * `dispatch-projected` keep working without churn across the dozen+
 * consumer files (oracle.ts, agent-chats.ts, operator-scan/route.ts,
 * llm-testing/targets/operator.ts, …).
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import type { ToolResult } from './wire';
import type { ProjectedTool, UnifiedToolContext } from './tool-projection';
import {
  DEFAULT_DISPATCH_STACK,
  runDispatchStack,
  type DispatchStep,
  type DispatchStepName,
} from './dispatch-stack';
import type { DispatchProjectedDeps, DispatchProjectedResult } from './dispatch-types';

export {
  defaultComputeQuotaWindow,
  PASS_THROUGH,
  UnauthorizedToolError,
  HarnessRequiredError,
  WorkspaceTxNotDeclaredError,
  WorkspaceTxUnavailableError,
  InvalidInputError,
  type QuotaWindow,
  type DispatchProjectedDeps,
  type DispatchProjectedErrorCode,
  type DispatchProjectedResult,
  type InvalidInputCorrection,
  type InvalidInputMetadata,
  type PostInvokeEvent,
  type CapabilityEnvelopeVerdict,
  type ToolDispatchOverrideFn,
} from './dispatch-types';

// Re-export the D-030 seam beside the dispatcher entrypoint so hosts that
// historically imported all dispatch contracts from this module do not need
// a source-path migration.
export {
  KERNEL_ENFORCEMENT_SCHEMA,
  sameKernelRevision,
  sameExecutionRevision,
  kernelRevisionKey,
  executionRevisionKey,
  normalizeKernelEnforcementResult,
  evaluateKernelEnforcement,
  evaluateKernelDecision,
  isKernelDenied,
  appliedExecutionRevision,
  actualExecutionRevision,
  enforceKernelBoundary,
  runAtKernelBoundary,
  wrapKernelSpawn,
  wrapNativeSpawn,
  createKernelEnforcementPort,
  createKernelPolicyPort,
  allowKernelEnforcement,
  KernelEnforcementDeniedError,
} from './kernel-enforcement';
export type {
  KernelEnforcementPhase,
  KernelBoundary,
  KernelDecision,
  KernelAvailability,
  KernelExecutionRevision,
  KernelActivationRevision,
  KernelOwnershipRequirement,
  KernelActivationSnapshot,
  KernelContextState,
  KernelEnforcementRequest,
  KernelEnforcementResult,
  KernelEnforcementPort,
  KernelPolicyPort,
} from './kernel-enforcement';

export {
  DEFAULT_DISPATCH_STACK,
  withReplacedStep,
  type DispatchExecution,
  type DispatchStep,
  type DispatchStepName,
} from './dispatch-stack';

/* ─── Dispatcher entrypoint ──────────────────────────────────────────── */

/**
 * Dispatch a projected tool. Drives the default dispatch stack (gates,
 * decorators, invoke, telemetry); hosts that need a custom stack should
 * call `runDispatchStack` directly with their stack.
 */
export async function dispatchProjectedTool(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
  stack: ReadonlyArray<DispatchStep> = DEFAULT_DISPATCH_STACK,
): Promise<DispatchProjectedResult> {
  return runDispatchStack(tool, toolName, input, ctx, deps, stack);
}

/* ─── In-process streaming dispatch ──────────────────────────────────── */

/**
 * One value yielded by `dispatchProjectedToolStream`.
 * - `event`: a ctx.emit(name, data) call from inside the handler.
 * - `done`: the handler returned successfully.
 * - `error`: dispatch/handler failed (role gate, quota, timeout, throw).
 */
export type DispatchStreamEvent =
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'done'; result: ToolResult }
  | { kind: 'error'; error: NonNullable<DispatchProjectedResult['error']> };

/**
 * In-process streaming wrapper around `dispatchProjectedTool` for
 * callers that want to consume a tool's typed event channel without
 * going through an HTTP or MCP transport.
 *
 * Goes through the full dispatcher — role check, quota, telemetry,
 * idle watchdog all apply. The escape hatch for callers who want to
 * bypass gating is to invoke `tool.fn(input, ctx)` directly (documented
 * as a footgun; loses RLS scoping and audit recording).
 *
 * Yields exactly one terminal event (`done` or `error`) before returning.
 */
export async function* dispatchProjectedToolStream(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
): AsyncGenerator<DispatchStreamEvent, void, void> {
  const queue: DispatchStreamEvent[] = [];
  let resolveWait: (() => void) | null = null;
  const wake = (): void => {
    const r = resolveWait;
    resolveWait = null;
    r?.();
  };

  // Override emit + progress so each emit pushes onto our queue. The
  // dispatcher will wrap our emit with its idle-timeout watchdog (if
  // tool.idleTimeoutSec is set), so wake() still fires correctly.
  const streamEmit = (name: string, data: unknown): void => {
    queue.push({ kind: 'event', name, data });
    wake();
  };
  const streamProgress = (pct: number | undefined, msg?: string): void => {
    streamEmit('progress', {
      progress: typeof pct === 'number' ? pct : 0,
      total: 100,
      ...(msg ? { message: msg } : {}),
    });
  };
  const streamCtx: UnifiedToolContext = {
    ...ctx,
    emit: streamEmit,
    progress: streamProgress,
  };

  const dispatchPromise = dispatchProjectedTool(tool, toolName, input, streamCtx, deps).then(
    (r) => {
      if (r.ok && r.result) queue.push({ kind: 'done', result: r.result });
      else if (r.ok) queue.push({ kind: 'done', result: { content: [] } });
      else queue.push({ kind: 'error', error: r.error ?? { code: 'handler_error', message: '' } });
      wake();
    },
    (err) => {
      queue.push({
        kind: 'error',
        error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) },
      });
      wake();
    },
  );

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((res) => {
          resolveWait = res;
        });
      }
      while (queue.length > 0) {
        const ev = queue.shift()!;
        yield ev;
        if (ev.kind === 'done' || ev.kind === 'error') return;
      }
    }
  } finally {
    await dispatchPromise.catch(() => {});
  }
}
