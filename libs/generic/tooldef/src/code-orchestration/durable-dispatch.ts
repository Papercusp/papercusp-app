/**
 * Durable nested dispatch for explicitly durable tool orchestration
 * (blueprint-backed-work-item-execution-2026-09-23 P-019, decision D-019).
 *
 * A durable run re-executes its pinned script after a crash. This wrapper sits between the
 * orchestration runtime and the current-caller dispatch binding and turns every nested tool call
 * into its OWN checkpointed step — never the whole script as one opaque step. The step store is
 * injected (`DurableStepHost`), so this module stays domain-free; the operator binds it to DBOS.
 *
 * Replay rules (the registered tool contract decides; no caller can upgrade them):
 *   - read-only / registered-idempotent calls: a recorded outcome is returned without dispatch;
 *     an unrecorded one simply (re-)executes — at-least-once is safe for these classes.
 *   - uncertain calls (any other write): an INTENT step is recorded first. If a later execution
 *     finds the intent recorded but the call itself unrecorded, the previous attempt may have
 *     dispatched and its outcome is UNKNOWN — the call records `needs-reconciliation`, every later
 *     dispatch is refused, and the run stops. An uncertain write that fails after dispatch began
 *     stops the same way. There is no replay-safety override.
 *   - authorization is rechecked before every LIVE dispatch (never on replay), so a recovered run
 *     exercises only the caller's current permissions and never a recorded grant.
 *   - a recorded step whose argument fingerprint differs from the current call is replay
 *     divergence: the run halts instead of continuing on changed inputs.
 *
 * Calls are serialized in ordinal order so the host's step identities stay deterministic even when
 * the script issues calls concurrently.
 */
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import type { ToolResult } from '../wire';
import { ToolDispatchError, isPreExecutionFailure } from './dispatch-binding';
import { resolveToolEffect, type WrapDispatch } from './orchestrate';

export type DurableReplayClass = 'read-only' | 'idempotent' | 'uncertain';

/** The checkpoint store a durable run executes against (DBOS in production). */
export interface DurableStepHost {
  /** Run `fn` as a checkpointed step. A recorded outcome is returned WITHOUT running `fn`. */
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Durable timer: after recovery only the remaining time is waited. */
  sleep(ms: number): Promise<void>;
  /** Declared wait for an external signal on `topic`; resolves null on timeout. */
  receive(topic: string, timeoutSec: number): Promise<unknown>;
}

export interface DurableDispatchOptions {
  host: DurableStepHost;
  /** The current-caller binding every live nested call must enter. */
  inner: WrapDispatch;
  /** The candidate registry, used to classify `tools:invoke` by its nested target. */
  tools: readonly ProjectedTool[];
  /** Re-check the caller's CURRENT permission for one live dispatch. Throw to refuse. */
  authorize(toolName: string, tool: ProjectedTool): Promise<void> | void;
  /** Stable fingerprint of a call's arguments (replay divergence check). */
  fingerprint(args: unknown): string;
  /** Upper bound for one `tools.runtime.sleep` call. Default 1 hour. */
  maxSleepMs?: number;
  /** Upper bound for one `tools.runtime.waitFor` call. Default 1 hour. */
  maxWaitSec?: number;
}

export interface DurableStepSummary {
  ordinal: number;
  tool: string;
  replay: DurableReplayClass | 'runtime';
  source: 'live' | 'recorded';
  outcome: 'ok' | 'error' | 'needs-reconciliation';
}

export interface DurableDispatchState {
  steps: DurableStepSummary[];
  reconciliation: { ordinal: number; tool: string; reason: string } | null;
  divergence: { ordinal: number; tool: string } | null;
}

interface RecordedError {
  message: string;
  toolName?: string;
  code?: string;
}

/** The value persisted for one tool step. Always JSON; the live path returns the SAME value. */
type RecordedCall = {
  v: 1;
  argsFingerprint: string;
  ok: boolean;
  result?: unknown;
  error?: RecordedError;
  reconcile?: { reason: string };
};

export const DURABLE_RUNTIME_TOOL_NAMES = [
  'runtime:now',
  'runtime:random',
  'runtime:sleep',
  'runtime:wait_for',
] as const;

const RUNTIME_TOOL_SET: ReadonlySet<string> = new Set(DURABLE_RUNTIME_TOOL_NAMES);

/** Raised to the script once a run has stopped for reconciliation or diverged. */
export class DurableRunHaltedError extends Error {
  readonly reason: 'needs-reconciliation' | 'replay-diverged';
  constructor(reason: 'needs-reconciliation' | 'replay-diverged', message: string) {
    super(message);
    this.name = 'DurableRunHaltedError';
    this.reason = reason;
  }
}

function runtimeTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ProjectedTool {
  return {
    pluginName: 'durable-orchestration',
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    capabilities: [],
    effect: 'read',
    expose: { mcp: { name } },
    fn: async (): Promise<ToolResult> => {
      throw new Error(`${name} is only available inside a durable orchestration run`);
    },
  };
}

/**
 * Runtime-owned nondeterminism for durable scripts: recorded time and randomness, durable timers
 * and declared waits. They exist only in a durable run's facade and never reach a real dispatcher.
 */
export function durableRuntimeTools(): ProjectedTool[] {
  return [
    runtimeTool('runtime:now', 'Recorded wall-clock time for a durable run.', {}, []),
    runtimeTool('runtime:random', 'Recorded random number in [0, 1) for a durable run.', {}, []),
    runtimeTool('runtime:sleep', 'Durable sleep; recovery waits only the remaining time.', {
      ms: { type: 'integer', minimum: 0 },
    }, ['ms']),
    runtimeTool('runtime:wait_for', 'Declared wait for an external signal on a topic.', {
      topic: { type: 'string', minLength: 1, maxLength: 120 },
      timeoutSec: { type: 'integer', minimum: 1 },
    }, ['topic', 'timeoutSec']),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Registered-effect replay class, mirroring the P-018 inspection rule at runtime. */
export function classifyDurableCall(
  tool: ProjectedTool,
  toolName: string,
  args: unknown,
  tools: readonly ProjectedTool[],
): DurableReplayClass {
  let target = tool;
  let targetArgs = args;
  if (toolName === 'tools:invoke') {
    if (!isRecord(args) || typeof args.name !== 'string') return 'uncertain';
    const nestedName = args.name.trim();
    const nested = tools.find((candidate) => candidate.expose?.mcp?.name === nestedName);
    if (!nested) return 'uncertain';
    target = nested;
    targetArgs = args.args;
  }
  const effect = resolveToolEffect(target, targetArgs);
  if (effect === 'read') return 'read-only';
  if (effect === 'write' && target.idempotent === true) return 'idempotent';
  return 'uncertain';
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : JSON.parse(serialized);
}

function describeError(err: unknown): RecordedError {
  if (err instanceof ToolDispatchError) {
    return { message: err.message, toolName: err.toolName, code: err.code };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/** Rebuild a recorded failure so replay classifies it exactly like the live throw. */
function rebuildError(error: RecordedError): Error {
  if (error.toolName && error.code) {
    const rebuilt = new ToolDispatchError(error.toolName, error.code, '');
    rebuilt.message = error.message;
    return rebuilt;
  }
  return new Error(error.message);
}

function boundedInteger(value: unknown, min: number, max: number, field: string, tool: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolDispatchError(tool, 'invalid_args', `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/**
 * Build the durable wrapper and its observable state. The state is complete once the script
 * settles; the workflow reads it to decide between success, failure and needs-reconciliation.
 */
export function createDurableDispatch(opts: DurableDispatchOptions): {
  wrapDispatch: WrapDispatch;
  state: DurableDispatchState;
} {
  const state: DurableDispatchState = { steps: [], reconciliation: null, divergence: null };
  const maxSleepMs = opts.maxSleepMs ?? 3_600_000;
  const maxWaitSec = opts.maxWaitSec ?? 3_600;
  let nextOrdinal = 0;
  let lane: Promise<unknown> = Promise.resolve();

  const haltIfStopped = (): void => {
    if (state.reconciliation) {
      throw new DurableRunHaltedError(
        'needs-reconciliation',
        `durable run stopped for reconciliation at step ${state.reconciliation.ordinal} (${state.reconciliation.tool}); no further tool call is dispatched`,
      );
    }
    if (state.divergence) {
      throw new DurableRunHaltedError(
        'replay-diverged',
        `durable replay diverged at step ${state.divergence.ordinal} (${state.divergence.tool}); the run stops instead of continuing on changed inputs`,
      );
    }
  };

  const settle = (
    ordinal: number,
    toolName: string,
    replay: DurableReplayClass | 'runtime',
    ranLive: boolean,
    fingerprint: string,
    recorded: RecordedCall,
  ): unknown => {
    if (!ranLive && recorded.argsFingerprint !== fingerprint) {
      state.divergence = { ordinal, tool: toolName };
      haltIfStopped();
    }
    const outcome = recorded.reconcile ? 'needs-reconciliation' : recorded.ok ? 'ok' : 'error';
    state.steps.push({ ordinal, tool: toolName, replay, source: ranLive ? 'live' : 'recorded', outcome });
    if (recorded.reconcile) {
      state.reconciliation = { ordinal, tool: toolName, reason: recorded.reconcile.reason };
      haltIfStopped();
    }
    if (!recorded.ok) throw rebuildError(recorded.error ?? { message: 'durable step failed' });
    return recorded.result;
  };

  const runtimeStep = async (ordinal: number, toolName: string, args: unknown): Promise<unknown> => {
    const fingerprint = opts.fingerprint(args);
    const input = isRecord(args) ? args : {};
    if (toolName === 'runtime:sleep') {
      const ms = boundedInteger(input.ms, 0, maxSleepMs, 'ms', toolName);
      await opts.host.sleep(ms);
      state.steps.push({ ordinal, tool: toolName, replay: 'runtime', source: 'live', outcome: 'ok' });
      return { sleptMs: ms };
    }
    if (toolName === 'runtime:wait_for') {
      const topic = typeof input.topic === 'string' && input.topic.length > 0 && input.topic.length <= 120
        ? input.topic
        : (() => { throw new ToolDispatchError(toolName, 'invalid_args', 'topic must be a 1-120 character string'); })();
      const timeoutSec = boundedInteger(input.timeoutSec, 1, maxWaitSec, 'timeoutSec', toolName);
      const message = await opts.host.receive(topic, timeoutSec);
      state.steps.push({ ordinal, tool: toolName, replay: 'runtime', source: 'live', outcome: 'ok' });
      return { received: message !== null && message !== undefined, message: toJsonValue(message) };
    }
    let ranLive = false;
    const recorded = await opts.host.runStep<RecordedCall>(`runtime:${ordinal}:${toolName}`, async () => {
      ranLive = true;
      const now = new Date();
      const result = toolName === 'runtime:now'
        ? { iso: now.toISOString(), epochMs: now.getTime() }
        : { value: Math.random() };
      return { v: 1, argsFingerprint: fingerprint, ok: true, result };
    });
    return settle(ordinal, toolName, 'runtime', ranLive, fingerprint, recorded);
  };

  const toolStep = async (
    ordinal: number,
    tool: ProjectedTool,
    toolName: string,
    args: unknown,
    ctx: UnifiedToolContext,
    next: Parameters<WrapDispatch>[4],
  ): Promise<unknown> => {
    const replay = classifyDurableCall(tool, toolName, args, opts.tools);
    const fingerprint = opts.fingerprint(args);
    let intentRanLive = false;
    if (replay === 'uncertain') {
      await opts.host.runStep(`intent:${ordinal}:${toolName}`, async () => {
        intentRanLive = true;
        return { v: 1, argsFingerprint: fingerprint };
      });
    }
    let ranLive = false;
    const recorded = await opts.host.runStep<RecordedCall>(`tool:${ordinal}:${toolName}`, async () => {
      ranLive = true;
      if (replay === 'uncertain' && !intentRanLive) {
        // The intent was recorded by an earlier execution, but this call's outcome never was:
        // that execution may have dispatched the write before it stopped.
        return {
          v: 1,
          argsFingerprint: fingerprint,
          ok: false,
          reconcile: {
            reason: 'a previous execution recorded intent to dispatch this write but not its outcome; the external effect may or may not have happened',
          },
        };
      }
      try {
        await opts.authorize(toolName, tool);
        const result = await opts.inner(tool, toolName, args, ctx, next);
        return { v: 1, argsFingerprint: fingerprint, ok: true, result: toJsonValue(result) };
      } catch (err) {
        const error = describeError(err);
        if (replay === 'uncertain' && !isPreExecutionFailure(err)) {
          return {
            v: 1,
            argsFingerprint: fingerprint,
            ok: false,
            error,
            reconcile: { reason: `the write failed after dispatch began, so its outcome is unknown: ${error.message}` },
          };
        }
        return { v: 1, argsFingerprint: fingerprint, ok: false, error };
      }
    });
    return settle(ordinal, toolName, replay, ranLive, fingerprint, recorded);
  };

  const wrapDispatch: WrapDispatch = (tool, toolName, args, ctx, next) => {
    // Allocated synchronously, in the same order the orchestration runtime allocates ordinals.
    const ordinal = nextOrdinal++;
    const run = lane.then(() => {
      haltIfStopped();
      return RUNTIME_TOOL_SET.has(toolName)
        ? runtimeStep(ordinal, toolName, args)
        : toolStep(ordinal, tool, toolName, args, ctx, next);
    });
    lane = run.catch(() => undefined);
    return run;
  };

  return { wrapDispatch, state };
}

/** Authorization refusal for a live durable step, classified as pre-execution. */
export function durableAuthorizationDenied(toolName: string, message: string): ToolDispatchError {
  return new ToolDispatchError(toolName, 'role_not_allowed', message);
}
