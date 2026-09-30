/**
 * runAgentLoop — Papercusp's OWNED tool loop (plan own-tui-full-divorce-2026-08-24,
 * P-007; decisions D-009 walking skeleton, D-010 ModelPort seam).
 *
 * The loop is a pure async generator over a ModelPort: it owns turn
 * sequencing, tool execution, HITL approval gating, stop conditions and
 * usage aggregation — and NOTHING provider-shaped (that lives behind the
 * port). Sessions/persistence are P-009; the native-protocol surface that
 * streams these events to the TUI pane is P-008. Both consume this loop
 * as-is, which is why the event vocabulary here is deliberately explicit:
 * it is the embryo of the native session protocol's wire events.
 *
 * Semantics (stopWhen / prepareStep, named for their AI SDK analogues but
 * owned here):
 *  - a STEP = one model stream + (if it called tools) their executions.
 *  - after a step with NO tool calls the loop ends naturally ('complete').
 *  - stopWhen conditions are evaluated after every step; any true → end
 *    ('stop-condition'). Default: stepCountIs(DEFAULT_MAX_STEPS) so a
 *    runaway loop cannot spin unbounded even when the caller passes nothing.
 *  - prepareStep runs before each model call and may override model /
 *    system / messages / tools for THAT step (context trimming, tool
 *    narrowing, model escalation).
 *  - a tool whose def says needsApproval routes through the ApprovalPort
 *    (P-008 bridges this to the card system's ask_choice round-trip). No
 *    port configured → the call is DENIED, never silently executed: the
 *    deny is fed back to the model as an isError tool_result.
 */

import type {
  ModelMessage,
  ModelPort,
  ModelStreamEvent,
  ModelStopReason,
  ModelToolDef,
  ModelUsage,
} from './model-port';

// ---------------------------------------------------------------------------
// Tools

export interface LoopToolContext {
  stepIndex: number;
  signal?: AbortSignal;
}

/** A tool the LOOP can execute: the model-facing def + the server-side
 *  execution. The capability:* door projection (P-007 follow-on slice)
 *  builds these from the agent-tools registry. */
export interface LoopTool extends ModelToolDef {
  execute(input: unknown, ctx: LoopToolContext): Promise<unknown>;
  /** true, or a per-input predicate → route through the ApprovalPort before
   *  executing. Absent/false → execute immediately. */
  needsApproval?: boolean | ((input: unknown) => boolean);
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
}

// ---------------------------------------------------------------------------
// Approvals (the HITL seam)

export interface ApprovalRequest {
  call: ToolCallRecord;
  stepIndex: number;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Human-readable reason; on a deny it is fed back to the model. */
  reason?: string;
}

/** P-008 bridges this to the TUI permission round-trip (card system). */
export interface ApprovalPort {
  /**
   * Persist any state the decision surface needs before the approval-required
   * tool call is emitted to that surface. A rejected preparation fails the
   * turn visibly instead of rendering a prompt that cannot be resolved.
   */
  prepareApproval?(req: ApprovalRequest): Promise<void>;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

// ---------------------------------------------------------------------------
// Stop conditions + prepareStep

export interface LoopStepInfo {
  stepIndex: number;
  /** Assistant text accumulated this step. */
  text: string;
  toolCalls: ToolCallRecord[];
  stopReason: ModelStopReason;
  usage: ModelUsage | null;
  /** Account that actually served this model request, when the provider
   * returned authoritative routing provenance. */
  servedAccount?: string;
}

export interface StopState {
  steps: LoopStepInfo[];
  lastStep: LoopStepInfo;
}

export type StopCondition = (state: StopState) => boolean;

export const DEFAULT_MAX_STEPS = 24;

export function stepCountIs(n: number): StopCondition {
  return ({ steps }) => steps.length >= n;
}

export function hasToolCall(name: string): StopCondition {
  return ({ lastStep }) => lastStep.toolCalls.some((c) => c.name === name);
}

export interface PrepareStepArgs {
  stepIndex: number;
  steps: LoopStepInfo[];
  messages: ModelMessage[];
}

export interface StepOverrides {
  model?: string;
  system?: string;
  messages?: ModelMessage[];
  tools?: LoopTool[];
}

export type PrepareStep = (args: PrepareStepArgs) => StepOverrides | undefined | Promise<StepOverrides | undefined>;

// ---------------------------------------------------------------------------
// Loop events — the embryo of the native session protocol's wire vocabulary.

export type LoopStopReason = 'complete' | 'stop-condition' | 'aborted' | 'error';

export type LoopEvent =
  | { type: 'step_start'; stepIndex: number }
  | { type: 'text_delta'; stepIndex: number; text: string }
  | { type: 'reasoning_delta'; stepIndex: number; text: string }
  | { type: 'tool_call'; stepIndex: number; call: ToolCallRecord; needsApproval: boolean }
  | { type: 'approval_resolved'; stepIndex: number; callId: string; approved: boolean; reason?: string }
  | {
      type: 'tool_result';
      stepIndex: number;
      callId: string;
      name: string;
      result?: unknown;
      /** Set when execution threw, the tool is unknown, or approval was denied. */
      error?: string;
      denied?: boolean;
    }
  | { type: 'step_end'; stepIndex: number; step: LoopStepInfo }
  | {
      type: 'done';
      stopReason: LoopStopReason;
      finalText: string;
      messages: ModelMessage[];
      steps: LoopStepInfo[];
      usage: ModelUsage;
      /** Account that actually served the most recent model request. */
      servedAccount?: string;
    }
  | { type: 'error'; message: string; raw?: unknown };

// ---------------------------------------------------------------------------

export interface RunAgentLoopOptions {
  port: ModelPort;
  model: string;
  system?: string;
  /** Initial conversation (typically ends with the user's prompt). */
  messages: ModelMessage[];
  tools?: LoopTool[];
  /** Any-true ends the loop after the current step. Default: stepCountIs(DEFAULT_MAX_STEPS).
   *  A caller-supplied array REPLACES the default, but the DEFAULT_MAX_STEPS
   *  hard cap still applies as a backstop. */
  stopWhen?: StopCondition | StopCondition[];
  prepareStep?: PrepareStep;
  approvals?: ApprovalPort;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Gateway admission-tier label, forwarded to every model call. */
  priority?: string;
  /** Optional inference-gateway account route, forwarded to every model call. */
  account?: string;
  /** Stable caller identity forwarded to every model call for gateway
   * attribution (for example an owned chat loop id). */
  ownerId?: string;
}

function addUsage(total: ModelUsage, u: ModelUsage | null | undefined): ModelUsage {
  if (!u) return total;
  return {
    inputTokens: total.inputTokens + u.inputTokens,
    outputTokens: total.outputTokens + u.outputTokens,
    ...(u.cacheReadTokens !== undefined || total.cacheReadTokens !== undefined
      ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0) }
      : {}),
    ...(u.cacheCreationTokens !== undefined || total.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: (total.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0) }
      : {}),
    ...(u.costUsd !== undefined || total.costUsd !== undefined
      ? { costUsd: (total.costUsd ?? 0) + (u.costUsd ?? 0) }
      : {}),
  };
}

function toolNeedsApproval(tool: LoopTool, input: unknown): boolean {
  if (typeof tool.needsApproval === 'function') return tool.needsApproval(input);
  return tool.needsApproval === true;
}

/** Serialize a tool's outcome into a tool_result content payload. Non-JSON
 *  values degrade to String(value) rather than throwing mid-loop. */
function toResultContent(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

/** Best-effort iterator cleanup. A provider's `return()` is allowed to be
 * asynchronous, but it must not be allowed to keep the caller blocked while
 * an abort is already settling the turn. Calling it (and observing rejection)
 * is enough to give well-behaved adapters a chance to cancel their transport.
 */
function closeModelStream(iterator: AsyncIterator<ModelStreamEvent>): void {
  if (typeof iterator.return !== 'function') return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Cleanup is best-effort; the turn's terminal event remains authoritative.
  }
}

export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<LoopEvent, void, void> {
  const messages: ModelMessage[] = [...opts.messages];
  const steps: LoopStepInfo[] = [];
  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  let servedAccount: string | undefined;
  const stopConditions: StopCondition[] = opts.stopWhen
    ? Array.isArray(opts.stopWhen)
      ? opts.stopWhen
      : [opts.stopWhen]
    : [stepCountIs(DEFAULT_MAX_STEPS)];

  const finalText = () => {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].text) return steps[i].text;
    }
    return '';
  };
  const done = (stopReason: LoopStopReason): LoopEvent => ({
    type: 'done',
    stopReason,
    finalText: finalText(),
    messages,
    steps,
    usage,
    ...(servedAccount ? { servedAccount } : {}),
  });

  for (let stepIndex = 0; ; stepIndex++) {
    if (opts.signal?.aborted) {
      yield done('aborted');
      return;
    }
    // Hard backstop: even a caller-supplied stopWhen that never fires cannot
    // spin past DEFAULT_MAX_STEPS extra steps beyond the largest explicit cap.
    if (stepIndex >= DEFAULT_MAX_STEPS * 4) {
      yield done('stop-condition');
      return;
    }

    const overrides = opts.prepareStep ? await opts.prepareStep({ stepIndex, steps, messages }) : undefined;
    const stepModel = overrides?.model ?? opts.model;
    const stepSystem = overrides?.system ?? opts.system;
    const stepMessages = overrides?.messages ?? messages;
    const stepTools = overrides?.tools ?? opts.tools ?? [];

    yield { type: 'step_start', stepIndex };

    let text = '';
    const toolCalls: ToolCallRecord[] = [];
    let stopReason: ModelStopReason = 'other';
    let stepUsage: ModelUsage | null = null;
    let stepServedAccount: string | undefined;
    let streamErrored = false;

    let stream: AsyncIterable<import('./model-port').ModelStreamEvent>;
    try {
      stream = opts.port.stream({
        model: stepModel,
        ...(stepSystem !== undefined ? { system: stepSystem } : {}),
        // SNAPSHOT, not the live array: the loop mutates `messages` after this
        // call, and an adapter that reads its request lazily (queued behind a
        // governor, retried) must see the conversation AS OF this step.
        messages: [...stepMessages],
        ...(stepTools.length
          ? {
              tools: stepTools.map(({ name, description, inputSchema }) => ({
                name,
                ...(description !== undefined ? { description } : {}),
                inputSchema,
              })),
            }
          : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        ...(opts.account !== undefined ? { account: opts.account } : {}),
        ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
      });
    } catch (e) {
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      yield done('error');
      return;
    }

    const iterator = stream[Symbol.asyncIterator]();
    let abortHandler: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    if (opts.signal) {
      abortPromise = new Promise<void>((resolve) => {
        abortHandler = () => resolve();
        opts.signal!.addEventListener('abort', abortHandler, { once: true });
      });
    }
    let sawStop = false;
    let streamAborted = false;
    let streamEndedEarly = false;

    try {
      while (true) {
        if (opts.signal?.aborted) {
          streamAborted = true;
          break;
        }

        // Do not use raw `for await` here: an adapter can leave `next()`
        // pending after its signal fires. Racing each pull lets the owned
        // loop settle and close the iterator instead of hanging the chat.
        const nextResult = Promise.resolve()
          .then(() => iterator.next())
          .then(
            (value) => ({ kind: 'next' as const, value }),
            (error) => ({ kind: 'error' as const, error }),
          );
        const result = abortPromise
          ? await Promise.race([nextResult, abortPromise.then(() => ({ kind: 'aborted' as const }))])
          : await nextResult;

        if (result.kind === 'aborted') {
          streamAborted = true;
          break;
        }
        if (result.kind === 'error') throw result.error;
        if (opts.signal?.aborted) {
          streamAborted = true;
          break;
        }
        if (result.value.done) {
          streamEndedEarly = !sawStop && !streamErrored;
          break;
        }

        const ev = result.value.value;
        switch (ev.type) {
          case 'text_delta':
            text += ev.text;
            yield { type: 'text_delta', stepIndex, text: ev.text };
            break;
          case 'reasoning_delta':
            yield { type: 'reasoning_delta', stepIndex, text: ev.text };
            break;
          case 'tool_call': {
            const call: ToolCallRecord = { id: ev.id, name: ev.name, input: ev.input };
            toolCalls.push(call);
            const tool = stepTools.find((t) => t.name === ev.name);
            const needsApproval = tool ? toolNeedsApproval(tool, ev.input) : false;
            if (needsApproval) {
              await opts.approvals?.prepareApproval?.({ call, stepIndex });
            }
            yield {
              type: 'tool_call',
              stepIndex,
              call,
              needsApproval,
            };
            break;
          }
          case 'stop':
            sawStop = true;
            stopReason = ev.reason;
            stepUsage = ev.usage ?? null;
            if (ev.servedAccount) {
              stepServedAccount = ev.servedAccount;
              servedAccount = ev.servedAccount;
            }
            break;
          case 'error':
            streamErrored = true;
            yield { type: 'error', message: ev.message, ...(ev.raw !== undefined ? { raw: ev.raw } : {}) };
            break;
        }
        // `stop` and `error` are terminal ModelPort events. Stop pulling
        // immediately so a provider that leaves its iterator open cannot
        // strand the turn after it already emitted its terminal frame.
        if (sawStop || streamErrored) break;
      }
    } catch (e) {
      if (opts.signal?.aborted) {
        streamAborted = true;
      } else {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
        streamErrored = true;
      }
    } finally {
      if (opts.signal && abortHandler) opts.signal.removeEventListener('abort', abortHandler);
      if (streamAborted || streamEndedEarly || streamErrored || sawStop) closeModelStream(iterator);
    }

    if (streamAborted) {
      yield done('aborted');
      return;
    }

    if (streamEndedEarly) {
      yield { type: 'error', message: 'model stream ended before terminal stop/error event' };
      yield done('error');
      return;
    }

    if (streamErrored) {
      yield done('error');
      return;
    }

    usage = addUsage(usage, stepUsage);

    // Record the assistant turn (text + tool calls) on the REAL conversation,
    // even when prepareStep substituted the messages sent to the model.
    const assistantParts: ModelMessage['content'] = [];
    if (text) assistantParts.push({ type: 'text', text });
    for (const c of toolCalls) {
      assistantParts.push({ type: 'tool_call', id: c.id, name: c.name, input: c.input });
    }
    if (assistantParts.length) messages.push({ role: 'assistant', content: assistantParts });

    const step: LoopStepInfo = {
      stepIndex,
      text,
      toolCalls,
      stopReason,
      usage: stepUsage,
      ...(stepServedAccount ? { servedAccount: stepServedAccount } : {}),
    };
    steps.push(step);

    if (toolCalls.length === 0) {
      yield { type: 'step_end', stepIndex, step };
      yield done('complete');
      return;
    }

    // Execute the step's tool calls sequentially (deterministic transcript
    // order; parallel execution is a later, measured optimization).
    const resultParts: ModelMessage['content'] = [];
    for (const call of toolCalls) {
      const tool = stepTools.find((t) => t.name === call.name);
      if (!tool) {
        const error = `unknown tool: ${call.name}`;
        yield { type: 'tool_result', stepIndex, callId: call.id, name: call.name, error };
        resultParts.push({ type: 'tool_result', toolCallId: call.id, content: error, isError: true });
        continue;
      }
      if (toolNeedsApproval(tool, call.input)) {
        let decision: ApprovalDecision;
        if (opts.approvals) {
          try {
            decision = await opts.approvals.requestApproval({ call, stepIndex });
          } catch (e) {
            decision = {
              approved: false,
              reason: `approval request failed: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        } else {
          decision = { approved: false, reason: 'no approval channel configured' };
        }
        yield {
          type: 'approval_resolved',
          stepIndex,
          callId: call.id,
          approved: decision.approved,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        };
        if (!decision.approved) {
          const error = `tool call denied${decision.reason ? `: ${decision.reason}` : ''}`;
          yield { type: 'tool_result', stepIndex, callId: call.id, name: call.name, error, denied: true };
          resultParts.push({ type: 'tool_result', toolCallId: call.id, content: error, isError: true });
          continue;
        }
      }
      try {
        const result = await tool.execute(call.input, {
          stepIndex,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        yield { type: 'tool_result', stepIndex, callId: call.id, name: call.name, result };
        resultParts.push({ type: 'tool_result', toolCallId: call.id, content: toResultContent(result) });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        yield { type: 'tool_result', stepIndex, callId: call.id, name: call.name, error };
        resultParts.push({ type: 'tool_result', toolCallId: call.id, content: error, isError: true });
      }
    }
    messages.push({ role: 'user', content: resultParts });

    yield { type: 'step_end', stepIndex, step };

    const stopState: StopState = { steps, lastStep: step };
    if (stopConditions.some((c) => c(stopState))) {
      yield done('stop-condition');
      return;
    }
  }
}
