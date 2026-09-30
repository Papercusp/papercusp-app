/**
 * chat-engine — one agent-chat turn on the OWNED loop (P-008,
 * own-tui-full-divorce-2026-08-24; D-008/D-009 native session protocol).
 *
 * This is the engine half of the `engine:'loop'` lane on
 * `POST /api/harness/:slug/agent-chats/:chatId/messages`: it runs
 * `runAgentLoop` over the chat's transcript and forwards every LoopEvent to
 * the SSE sink under its OWN name — the LoopEvent vocabulary IS the native
 * session protocol's wire vocabulary (loop.ts): `step_start`, `text_delta`,
 * `reasoning_delta`, `tool_call` (carries `needsApproval`),
 * `approval_resolved`, `tool_result`, `step_end`, `done`, `error`. Field
 * names ride verbatim (camelCase); the legacy spawn lane's `delta`/`done`
 * snake_case wire is untouched and unshared.
 *
 * Split of responsibilities (mirrors the legacy lane): the ROUTE owns the
 * streaming lock, cost caps, prompt assembly and transcript persistence;
 * this engine owns loop execution + wire mapping and returns the totals the
 * route persists. That keeps the engine runnable in tests with a fake
 * ModelPort and no PG.
 *
 * HITL: gated tool calls route through the PG approval store
 * (approval-store.ts) so the decision POST can land on any cluster worker.
 * The client learns the callId from the `tool_call` event and answers via
 * `POST .../agent-chats/:chatId/approvals/:callId`.
 */
import type { TranscriptTurn } from '../agent-chats-data';
import { splitModelSpec } from '../agent-config-constants';
import type { ModelMessage, ModelPort, ModelUsage } from './model-port';
import { runAgentLoop, stepCountIs, type ApprovalPort, type LoopStopReason, type LoopTool } from './loop';
import { createRoutedModelPort } from './provider-router';
import { awaitLoopApprovalDecision, createLoopApproval } from './approval-store';
import { maybeCompactSession } from './session-compaction';
import type { LoopSessionRow, LoopSessionStore } from './session-store';

/** Interactive default — overridable per message (`body.model`) or by env. */
export const DEFAULT_LOOP_CHAT_MODEL = process.env.PAPERCUSP_LOOP_CHAT_MODEL || 'claude-sonnet-4-6';

export const DEFAULT_LOOP_CHAT_MAX_STEPS = 24;

/** Resolve the exact model spec used for one interactive loop turn. The route
 * uses the same helper before execution so the live provenance frame and the
 * persisted transcript can never disagree with the model handed to the loop. */
export function resolveLoopChatModel(opts: { model?: string; effort?: string }): string {
  const baseModel = opts.model ?? DEFAULT_LOOP_CHAT_MODEL;
  return opts.effort ? `${splitModelSpec(baseModel).model ?? baseModel}:${opts.effort}` : baseModel;
}

/** Wire-copy guard: a tool_result payload larger than this rides as a
 *  truncated preview (the FULL result still reaches the model — the wire
 *  copy exists for pane rendering, not for correctness). */
export const WIRE_RESULT_MAX_CHARS = 8_192;

export interface LoopChatSink {
  event(name: string, data: unknown): void;
}

export interface LoopChatTurnOpts {
  chatId: string;
  workspaceId: string;
  /** Assembled system prompt (persona + context sections — NO history block,
   *  NO trailing user turn: those travel as messages). */
  system: string;
  /** Full transcript INCLUDING the just-appended user turn. */
  transcript: TranscriptTurn[];
  sink: LoopChatSink;
  model?: string;
  /** Explicit effort selection. When present it replaces any suffix on model. */
  effort?: string;
  /** Explicit gateway account selection. Undefined means auto routing. */
  account?: string;
  /** Stable caller identity forwarded to the inference gateway for routing
   * attribution (the owned chat loop id). */
  ownerId?: string;
  maxSteps?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Gateway admission-tier label. */
  priority?: string;
  /** Loop toolset (host-wired capability doors). Default: none. */
  tools?: LoopTool[];
  /** Injectable seams (tests). Defaults: provider-routing port; PG approvals. */
  port?: ModelPort;
  approvals?: ApprovalPort;
  /** P-009 session store: when provided, the turn RESUMES from the stored
   *  ModelMessage working set (full tool detail) and persists the updated
   *  set + usage totals afterward. The ROUTE wires the PG store; omitting it
   *  (tests, one-shot callers) degrades to the text-transcript rebuild. */
  sessions?: LoopSessionStore;
  /** Let the route persist the transcript before exposing done/error. */
  deferTerminalEvent?: boolean;
}

export interface LoopChatTurnResult {
  stopReason: LoopStopReason | null;
  finalText: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Set when the loop surfaced an error event (the turn should persist a
   *  failure marker, exactly like the legacy lane's error path). */
  errorMessage: string | null;
  stepCount: number;
  /** Account that actually served the most recent model request, when the
   * gateway returned authoritative routing provenance. */
  servedAccount?: string;
}

/** Map the PG transcript (text turns) onto the loop's ModelMessage shape.
 *  Error-marker turns and empty bodies are skipped; tool detail inside old
 *  turns is P-009's sessions store, not reconstructable from text. */
export function transcriptToMessages(transcript: TranscriptTurn[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const t of transcript) {
    if ((t as { error?: boolean }).error) continue;
    const text = (t.content ?? '').trim();
    if (!text) continue;
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    out.push({ role: t.role, content: [{ type: 'text', text }] });
  }
  return out;
}

/** Clamp a tool result for the WIRE copy only. */
export function clampForWire(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    json = String(value);
  }
  if (json.length <= WIRE_RESULT_MAX_CHARS) return value;
  return {
    truncated: true,
    fullChars: json.length,
    preview: json.slice(0, WIRE_RESULT_MAX_CHARS),
  };
}

/** The default ApprovalPort: PG round-trip via approval-store (cluster-correct). */
export function pgApprovalPort(args: {
  chatId: string;
  workspaceId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): ApprovalPort {
  const prepareApproval = async (req: Parameters<ApprovalPort['requestApproval']>[0]) => {
    await createLoopApproval({
      chatId: args.chatId,
      callId: req.call.id,
      workspaceId: args.workspaceId,
      toolName: req.call.name,
      toolInput: req.call.input,
      stepIndex: req.stepIndex,
    });
  };
  return {
    prepareApproval,
    async requestApproval(req) {
      // Idempotent safety net for callers that invoke the port directly rather
      // than through runAgentLoop's pre-render preparation hook.
      await prepareApproval(req);
      return awaitLoopApprovalDecision({
        chatId: args.chatId,
        callId: req.call.id,
        workspaceId: args.workspaceId,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
    },
  };
}

/**
 * Run one loop-engine chat turn, forwarding events to the sink. Never
 * throws for in-loop failures — those surface as the `error` wire event +
 * `errorMessage` on the result (the route persists a failure turn, exactly
 * like the legacy lane).
 */
export async function runLoopChatTurn(opts: LoopChatTurnOpts): Promise<LoopChatTurnResult> {
  const port = opts.port ?? createRoutedModelPort();
  const approvals =
    opts.approvals ??
    pgApprovalPort({
      chatId: opts.chatId,
      workspaceId: opts.workspaceId,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  const model = resolveLoopChatModel(opts);

  // ── P-009 resume: prefer the stored ModelMessage working set ────────────
  let stored: LoopSessionRow | null = null;
  if (opts.sessions) {
    try {
      stored = await opts.sessions.load({ chatId: opts.chatId, workspaceId: opts.workspaceId });
    } catch {
      stored = null; // unreadable store ⇒ text rebuild (anchor self-heals later)
    }
  }
  const lastTurn = opts.transcript[opts.transcript.length - 1];
  const freshUserText = lastTurn && lastTurn.role === 'user' ? (lastTurn.content ?? '').trim() : '';
  // Freshness anchor: the stored row was saved against transcript length N
  // (base + the assistant turn the route persisted); this call's transcript
  // must be exactly N + 1 (the just-appended user turn). Anything else means
  // another lane (legacy CLI-spawn) or a failed persist moved the chat —
  // replaying the stored session would silently drop those turns, so fall
  // back to the text rebuild instead.
  const session = stored && freshUserText && stored.transcriptTurns + 1 === opts.transcript.length ? stored : null;
  const messages: ModelMessage[] = session
    ? [...session.messages, { role: 'user' as const, content: [{ type: 'text' as const, text: freshUserText }] }]
    : transcriptToMessages(opts.transcript);
  const priorSummary = session ? session.summary : null;
  const priorCompactedCount = session ? session.compactedCount : 0;
  const system = priorSummary
    ? `${opts.system}\n\n## Earlier conversation (compacted summary)\n\n${priorSummary}`
    : opts.system;

  const result: LoopChatTurnResult = {
    stopReason: null,
    finalText: '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    errorMessage: null,
    stepCount: 0,
  };

  let doneMessages: ModelMessage[] | null = null;
  let doneUsage: ModelUsage | null = null;

  const loop = runAgentLoop({
    port,
    model,
    system,
    messages,
    ...(opts.tools ? { tools: opts.tools } : {}),
    stopWhen: [stepCountIs(opts.maxSteps ?? DEFAULT_LOOP_CHAT_MAX_STEPS)],
    ...(approvals ? { approvals } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.account !== undefined ? { account: opts.account } : {}),
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
  });

  try {
    for await (const ev of loop) {
      switch (ev.type) {
        case 'step_start':
        case 'text_delta':
        case 'reasoning_delta':
        case 'approval_resolved':
          opts.sink.event(ev.type, ev);
          break;
        case 'tool_call':
          opts.sink.event('tool_call', {
            ...ev,
            call: { ...ev.call, input: clampForWire(ev.call.input) },
          });
          break;
        case 'tool_result':
          opts.sink.event('tool_result', {
            ...ev,
            ...(ev.result !== undefined ? { result: clampForWire(ev.result) } : {}),
          });
          break;
        case 'step_end':
          result.stepCount = ev.stepIndex + 1;
          // The step's full LoopStepInfo (messages-shaped) stays server-side;
          // the pane needs the boundary + per-step usage only.
          opts.sink.event('step_end', {
            type: 'step_end',
            stepIndex: ev.stepIndex,
            usage: ev.step.usage,
            stopReason: ev.step.stopReason,
            toolCallCount: ev.step.toolCalls.length,
          });
          break;
        case 'done':
          result.stopReason = ev.stopReason;
          result.finalText = ev.finalText;
          result.tokensIn = ev.usage.inputTokens;
          result.tokensOut = ev.usage.outputTokens;
          result.costUsd = ev.usage.costUsd ?? 0;
          result.stepCount = ev.steps.length;
          if (ev.servedAccount) result.servedAccount = ev.servedAccount;
          doneMessages = ev.messages;
          doneUsage = ev.usage;
          // Wire `done` = totals + finalText; the full messages snapshot is
          // NOT streamed (P-009 persists it — the pane re-reads the chat).
          if (!opts.deferTerminalEvent) {
            opts.sink.event('done', {
              type: 'done',
              stopReason: ev.stopReason,
              finalText: ev.finalText,
              usage: ev.usage,
              stepCount: ev.steps.length,
              ...(ev.servedAccount ? { servedAccount: ev.servedAccount } : {}),
            });
          }
          break;
        case 'error':
          result.errorMessage = ev.message;
          if (!opts.deferTerminalEvent) {
            opts.sink.event('error', { type: 'error', message: ev.message });
          }
          break;
      }
    }
  } catch (e) {
    // A generator-level throw (port/tool bug escaping the loop's own guards):
    // degrade to the same error surface, never a broken stream with no event.
    const message = e instanceof Error ? e.message : String(e);
    result.errorMessage = result.errorMessage ?? message;
    if (!opts.deferTerminalEvent) {
      opts.sink.event('error', { type: 'error', message });
    }
  }

  // ── P-009 persist: compact if over budget, then save the working set ────
  // Runs for EVERY done (error stops included — the user turn is real even
  // when the stream died) so the session never lags the transcript.
  if (opts.sessions && doneMessages && doneUsage) {
    try {
      const compact = await maybeCompactSession({
        messages: doneMessages,
        priorSummary,
        priorCompactedCount,
        port,
        model,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        ...(opts.account !== undefined ? { account: opts.account } : {}),
      });
      let turnUsage: ModelUsage = doneUsage;
      if (compact.summarizeUsage) {
        const s = compact.summarizeUsage;
        turnUsage = {
          inputTokens: turnUsage.inputTokens + s.inputTokens,
          outputTokens: turnUsage.outputTokens + s.outputTokens,
          ...(turnUsage.cacheReadTokens !== undefined || s.cacheReadTokens !== undefined
            ? { cacheReadTokens: (turnUsage.cacheReadTokens ?? 0) + (s.cacheReadTokens ?? 0) }
            : {}),
          ...(turnUsage.cacheCreationTokens !== undefined || s.cacheCreationTokens !== undefined
            ? {
                cacheCreationTokens: (turnUsage.cacheCreationTokens ?? 0) + (s.cacheCreationTokens ?? 0),
              }
            : {}),
          ...(turnUsage.costUsd !== undefined || s.costUsd !== undefined
            ? { costUsd: (turnUsage.costUsd ?? 0) + (s.costUsd ?? 0) }
            : {}),
        };
        // The summarize call is real spend — surface it on the turn result
        // too, so the route's cost-cap accounting sees it.
        result.tokensIn += s.inputTokens;
        result.tokensOut += s.outputTokens;
        if (s.costUsd !== undefined) result.costUsd += s.costUsd;
      }
      await opts.sessions.saveTurn({
        chatId: opts.chatId,
        workspaceId: opts.workspaceId,
        messages: compact.messages,
        summary: compact.summary,
        compactedCount: compact.compactedCount,
        // The route persists ONE more turn (assistant or failure marker) on
        // top of the transcript this call received — anchor to that length.
        transcriptTurns: opts.transcript.length + 1,
        model,
        usage: turnUsage,
        priced: turnUsage.costUsd !== undefined,
      });
    } catch {
      // Degraded persistence: the anchor mismatch on the next load falls back
      // to the text rebuild — never fail a completed turn over the store.
    }
  }

  return result;
}
