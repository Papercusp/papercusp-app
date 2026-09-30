/**
 * Operator ChatTarget — drives the live operator-converse endpoint
 * over HTTP+SSE.
 *
 * Plan §4. Two transport modes per scenario:
 *   - 'http-sse' (default for now)  — POST /api/agent-mcp/operator-converse
 *                                     parse the SSE event stream.
 *   - 'in-process' (TODO Phase 1.5) — call the converse tool handler
 *                                     directly via dispatchProjectedToolStream.
 *
 * The handler invocation path is the cleaner shape per the plan's §10.4
 * pushback, but the HTTP path is what we have working today and is what
 * the V8 testing already exercises. Phase 1 lands with http-sse; the
 * in-process path is a follow-up once `ToolDispatchOverride` lands in
 * the production dispatcher.
 */

import { registerOverride, clearOverride } from '@papercusp/testing-shell/llm';

import { llmTestBaseUrl } from './base-url';
import type {
  ChatSession,
  ChatTarget,
  SessionOptions,
  SseEvent,
  ToolCallEvent,
  TurnInput,
  TurnResult,
  CardEvent,
  ControlTag,
} from '@papercusp/testing-shell/llm';

const BEHAVIORS = [
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10',
  'B11', 'B12', 'B13', 'B14', 'B15', 'B16', 'B17', 'B18', 'B19',
  'B21', 'B22', 'B23', 'B27', 'B28', 'B29', 'B30',
];

export interface OperatorTargetOpts {
  /** Base URL — defaults to dev server. */
  baseUrl?: string;
  /** Optional `harnessSlug` — most operator behavior is harness-scoped. */
  harnessSlug?: string;
  /**
   * Persona role the converse brain runs as. The agent-mcp/operator-converse
   * route honors an EXPLICIT `body.role` (resolves `${role}:converse` + that
   * role's prompt set — operator-converse.ts ~L85). Defaults to `operator`;
   * the registered `sentinel` target passes `sentinel` so Sentinel-specific
   * behavior — notably `<handoff>` (sentinel-as-claude-tui) — is
   * exercisable. `<handoff>` is honored ONLY for role==='sentinel'
   * (converse.ts ~L512), so the operator target can never trigger it.
   */
  role?: 'operator' | 'papercup';
}

export class OperatorTarget implements ChatTarget {
  readonly id: string;
  readonly behaviors = BEHAVIORS;
  private readonly opts: OperatorTargetOpts;

  constructor(opts: OperatorTargetOpts = {}) {
    this.opts = opts;
    // The id is the target key + telemetry tag — derive it from the role so a
    // role='sentinel' instance registers/tags as 'sentinel', not 'operator'.
    this.id = opts.role === 'papercup' ? 'papercup' : 'operator';
  }

  async open(opts: SessionOptions): Promise<ChatSession> {
    // Post-Vite-migration topology (2026-05-20): :3055 is the Vite SPA
    // dev server (frontend only); the API backend — including
    // /api/agent-mcp/operator-converse — is the Hono host on :3070
    // (bin/hono-host.ts). The framework is an HTTP client of the
    // backend, so it targets the Hono host directly, not the frontend
    // dev server's proxy. Override with PAPERCUSP_LLM_TEST_OPERATOR_URL
    // (PAPERCUSP_OPERATOR_URL is honored origin-only — see ./base-url).
    const baseUrl = this.opts.baseUrl ?? llmTestBaseUrl() ?? 'http://127.0.0.1:3070';
    if (opts.transport === 'http-sse' && opts.dispatchOverride) {
      registerOverride(opts.runId, opts.dispatchOverride);
    }
    return new OperatorSession({
      runId: opts.runId,
      baseUrl,
      harnessSlug: this.opts.harnessSlug,
      role: this.opts.role,
      transport: opts.transport,
      hasOverride: !!opts.dispatchOverride,
      // The runId IS a UUID; reuse it as conversationId so chain rows
      // for this scenario are queryable by `ui_client_id` + the same
      // value as conversation_id.
      conversationId: opts.runId,
    });
  }
}

interface SessionState {
  runId: string;
  baseUrl: string;
  harnessSlug?: string;
  /** Persona role to stamp in the converse body (default operator). */
  role?: 'operator' | 'papercup';
  transport: 'in-process' | 'http-sse';
  hasOverride: boolean;
  /**
   * Synthetic conversation_id used purely for chain-ledger writes
   * (operator_continue_chains.conversation_id is uuid NOT NULL). The
   * runner's own runId is fine — the schema doesn't care that it
   * doesn't match an operator-side conversations.id, only that it's
   * stable across the chain turns of one scenario run.
   */
  conversationId: string;
}

class OperatorSession implements ChatSession {
  readonly sessionId: string;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
    // The runId doubles as a stable conversation key for `uiClientId`.
    this.sessionId = `llm-testing/${state.runId}`;
  }

  async send(input: TurnInput): Promise<TurnResult> {
    if (this.state.transport === 'in-process') {
      throw new Error('in-process transport not yet implemented (Phase 1.5 follow-up)');
    }
    return this.sendHttpSse(input);
  }

  async close(): Promise<void> {
    if (this.state.hasOverride) {
      clearOverride(this.state.runId);
    }
  }

  private async sendHttpSse(input: TurnInput): Promise<TurnResult> {
    const url = `${this.state.baseUrl}/api/agent-mcp/operator-converse`;
    const body = {
      messages: input.messages,
      trigger: input.trigger,
      mayAskActive: true,
      modality: (input.meta?.modality as 'text' | 'voice' | undefined) ?? 'text',
      uiClientId: this.sessionId,
      conversationId: this.state.conversationId,
      // The runner sets pendingTrigger='continue' when it observes a
      // <continue/> tag in the last turn — that's an auto-fire by
      // definition. Same shape as the production provider.
      isAutoFire: input.trigger === 'continue',
      ...(input.meta?.welcomedUser ? { welcomed_user: input.meta.welcomedUser } : {}),
      // Explicit role wins at the converse route (resolves `${role}:converse`).
      // Only stamp it when non-default so the operator target's wire body is
      // byte-identical to before (keeps existing operator scenarios stable).
      ...(this.state.role && this.state.role !== 'operator' ? { role: this.state.role } : {}),
    };

    // Stamp the workspace the brain should run in. WITHOUT this, the
    // converse handler resolves activeWorkspaceId() to registry.current
    // (this dev box: `papercusp-workspace`), which has NO operator system
    // principal — so converse.ts gates `mcpConfig` to undefined and the
    // brain runs TOOL-LESS (deflects on every status/tool assert). The
    // operator/oracle principals + the scenario harnesses (sheets, …) live
    // in `default`, so target that. Overridable via PAPERCUSP_LLM_TEST_WORKSPACE.
    // Shared with the WI-5023 state-snapshot watcher below — same workspace.
    const workspaceHeader = process.env.PAPERCUSP_LLM_TEST_WORKSPACE ?? 'default';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-papercusp-workspace': workspaceHeader,
    };
    if (this.state.hasOverride) {
      headers['X-Tool-Dispatch-Override-Id'] = this.state.runId;
    }

    const startMs = Date.now();
    const ctrl = new AbortController();
    // The 120s flat cap that lived here through 2026-05-21 aborted real
    // operator turns mid-stream: cold first turns can take 90-150s
    // before deltas, and well-behaved long turns can stream for several
    // minutes. Switch to inactivity-based: brain has up to 90s before
    // the FIRST event arrives; after the stream starts, the timer
    // becomes a 45s inter-event idle (heartbeats are 15s, so 45s of
    // silence = dead connection). A 600s wall-clock safety cap prevents
    // genuine runaways — scenario-level caps.maxSecs is the budget knob.
    const INITIAL_TIMEOUT_MS = 90_000;
    const IDLE_TIMEOUT_MS = 45_000;
    const TOTAL_CAP_MS = 600_000;
    let killer = setTimeout(() => ctrl.abort(), INITIAL_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(killer);
      return errorTurn(`fetch failed: ${(err as Error).message}`, Date.now() - startMs);
    }

    if (!resp.ok || !resp.body) {
      clearTimeout(killer);
      const text = await resp.text().catch(() => '');
      return errorTurn(`HTTP ${resp.status}: ${text.slice(0, 200)}`, Date.now() - startMs);
    }

    const result: TurnResult = {
      assistantText: '',
      toolCalls: [],
      toolResults: [],
      cards: [],
      controlTags: [],
      costUsd: 0,
      latencyMs: 0,
      finishReason: 'done',
      rawSseTape: [],
    };

    // WI-5023: production (agent-mcp/operator-converse.ts) only forwards
    // chat:ask_choice's state-snapshot card onto THIS stream when
    // modality==='voice' — a deliberate cross-conversation-isolation choice
    // (a text turn is meant to watch the SEPARATE, workspace-wide
    // GET /operator/state-snapshot channel the real desktop text UI uses,
    // same as production). Without watching that channel, a text-mode
    // scenario whose brain calls chat:ask_choice never observes a card at
    // all: the tool blocks inside ctx.askUser until its own timeout, the SSE
    // stream just goes quiet, and the turn eventually finishes with an empty
    // `cards` array — a false "card was never emitted" failure (op-S10).
    //
    // Fix: for a text turn, race a SECOND subscription to that same
    // production channel, scoped to THIS turn's own runId (learned from the
    // `run-meta` event below), and as soon as it sees this run's card,
    // (a) record it into `result.cards` and (b) auto-resolve it via the same
    // POST /card-response endpoint the real UI's click handler uses — so the
    // brain's tool call returns immediately instead of riding out its
    // handler timeout. Voice mode already gets cards on the primary stream,
    // so it skips this path entirely.
    const modality = body.modality;
    let cardWatcher: CardWatcher | null = null;

    try {
      for await (const ev of readSse(resp.body, startMs)) {
        // Reset idle timer on each event; enforce total cap.
        clearTimeout(killer);
        if (Date.now() - startMs >= TOTAL_CAP_MS) {
          ctrl.abort();
          break;
        }
        killer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);

        if (ev.name === 'run-meta') {
          if (modality !== 'voice' && !cardWatcher) {
            const runId = (ev.data as { runId?: string } | undefined)?.runId;
            if (runId) {
              cardWatcher = startCardWatcher({ baseUrl: this.state.baseUrl, workspaceHeader, runId });
            }
          }
          continue;
        }

        result.rawSseTape.push(ev);
        applyEvent(ev, result);
        if (ev.name === 'done' || ev.name === 'error') break;
      }
    } catch (err) {
      result.finishReason = 'error';
      result.error = (err as Error).message;
    } finally {
      clearTimeout(killer);
    }

    if (cardWatcher) {
      const observed = await cardWatcher.stop();
      const alreadyHave = (c: CardEvent) =>
        observed &&
        c.payload &&
        typeof c.payload === 'object' &&
        (c.payload as { correlationId?: unknown }).correlationId ===
          (observed.payload as { correlationId?: unknown } | undefined)?.correlationId;
      if (observed && !result.cards.some(alreadyHave)) {
        result.cards.push(observed);
      }

      // WI-5613: op-S10-ask-choice (and any scenario exercising a blocking
      // human-in-the-loop tool) was false-failing whenever the PRIMARY
      // stream got severed by an infra event unrelated to the SUT — most
      // commonly another fleet agent restarting :3170 mid-turn while
      // ctx.askUser legitimately blocks for up to 10 minutes waiting on a
      // click nobody in this unattended harness will ever send. The read
      // loop above then throws (fetch/SSE reset → 'terminated' or similar)
      // and sets finishReason='error', which runner.ts's
      // `inconclusiveReason` unconditionally turns into the whole run
      // being `errored` — even though harness_shared.tool_invocations (and
      // this very cardWatcher) prove the SUT already did exactly what the
      // scenario expects.
      //
      // Once we've actually OBSERVED the card the assert is waiting for
      // (via the separate, workspace-wide state-snapshot channel — a
      // channel that only reflects a card the SUT genuinely emitted), the
      // interesting part of the turn already happened: the rest of the
      // primary stream is just riding out an indefinite block that was
      // always going to end in a timeout, never a real answer. So the
      // disconnect at that point is evidence of infra churn, not a SUT
      // failure — downgrade back to 'done' so asserts (card_emitted, etc.)
      // evaluate normally instead of the run being marked inconclusive.
      //
      // A disconnect BEFORE any card ever arrives (observed === null, and
      // no card already in result.cards from the primary stream itself)
      // still errors the turn exactly as before — this only recovers the
      // specific case the evidence trail (WI-5613) diagnosed.
      if (result.finishReason === 'error' && (observed || result.cards.length > 0)) {
        result.recoveredFromDisconnectAfterCard = true;
        result.finishReason = 'done';
      }
    }

    result.latencyMs = Date.now() - startMs;
    // Parse control tags after the fact from the accumulated assistant text.
    result.controlTags = extractControlTags(result.assistantText);
    return result;
  }
}

// =============================================================================
// WI-5023 — text-mode card watcher
// =============================================================================

interface CardWatcher {
  /** Stop watching (aborts the subscription) and return the first card
   *  observed + auto-resolved, or null if none arrived before stopping. */
  stop(): Promise<CardEvent | null>;
}

/**
 * Watch GET /operator/state-snapshot (the SAME channel the production text
 * UI subscribes to) for `runId`'s first non-empty openCards, then submit a
 * default pick via POST /card-response so the blocked ctx.askUser call
 * returns immediately. Scoped to one runId — this channel is workspace-wide,
 * so a card belonging to any OTHER concurrent conversation in the same
 * workspace is ignored, not merely unobserved (no cross-conversation bleed
 * into this scenario's result).
 *
 * Best-effort throughout: any fetch/parse/POST failure here just means the
 * card goes unobserved (today's behavior) — it must never throw into the
 * scenario's own turn.
 */
function startCardWatcher(opts: { baseUrl: string; workspaceHeader: string; runId: string }): CardWatcher {
  const ctrl = new AbortController();
  let resolveSettled!: (card: CardEvent | null) => void;
  const settled = new Promise<CardEvent | null>((res) => {
    resolveSettled = res;
  });
  let settledFlag = false;
  const settleOnce = (card: CardEvent | null) => {
    if (settledFlag) return;
    settledFlag = true;
    resolveSettled(card);
  };

  (async () => {
    try {
      const res = await fetch(`${opts.baseUrl}/api/operator/state-snapshot`, {
        headers: { accept: 'text/event-stream', 'x-papercusp-workspace': opts.workspaceHeader },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return settleOnce(null);
      for await (const ev of readSse(res.body, Date.now())) {
        if (ev.name !== 'snapshot') continue;
        const vs = ev.data as {
          runId?: string;
          workspaceId?: string;
          snapshot?: { openCards?: Array<Record<string, unknown>> };
        };
        if (vs.runId !== opts.runId) continue;
        const rawCard = vs.snapshot?.openCards?.[0];
        if (!rawCard) continue;
        const card = cardFromObj(rawCard);
        if (!card) continue;

        const correlationId = rawCard.correlationId as string | undefined;
        const firstOptionId = card.options?.[0]?.id;
        if (correlationId && firstOptionId) {
          // Best-effort auto-resolve — mirrors the real UI's click handler
          // (POST /card-response), so the brain's blocked tool call returns
          // now instead of riding out its own timeout. `:id` in the path is
          // not read by the handler; the correlationId is what resolves it.
          fetch(`${opts.baseUrl}/api/operator/conversations/llm-testing/card-response`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              correlationId,
              action: 'submit',
              workspaceId: vs.workspaceId ?? opts.workspaceHeader,
              payload: { picks: [firstOptionId] },
            }),
          }).catch(() => {
            /* best-effort — the card was still OBSERVED even if the
             * auto-resolve POST fails; the scenario's own timeout is the
             * fallback unblock path. */
          });
        }
        settleOnce(card);
        break;
      }
    } catch {
      /* aborted, or the channel errored — settle with whatever we have */
    } finally {
      settleOnce(null);
    }
  })();

  return {
    async stop() {
      // Abort FIRST: if no card ever arrived, the watcher's read loop is
      // parked on the still-open GET stream and `settled` will not resolve
      // until that read is interrupted. Aborting unblocks it (the abort
      // throws into the watcher's try/catch, whose `finally` settles with
      // null), THEN we await the (now-guaranteed-to-resolve) promise.
      ctrl.abort();
      return settled;
    },
  };
}

// =============================================================================
// SSE parsing
// =============================================================================

async function* readSse(body: ReadableStream<Uint8Array>, startMs: number): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE events are delimited by double newlines.
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseSseBlock(block);
      if (parsed) {
        parsed.tMs = Date.now() - startMs;
        yield parsed;
      }
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let name = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // SSE comment / heartbeat
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && name === 'message') return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try { data = JSON.parse(raw); } catch { /* keep as string */ }
  return { name, data, tMs: 0 };
}

function applyEvent(ev: SseEvent, result: TurnResult): void {
  switch (ev.name) {
    case 'delta': {
      const text = extractDeltaText(ev.data);
      if (text) result.assistantText += text;
      break;
    }
    case 'tool_call': {
      const tc = ev.data as { name?: string; input?: unknown };
      if (tc?.name) {
        const event: ToolCallEvent = { name: tc.name, input: tc.input };
        result.toolCalls.push(event);
      }
      break;
    }
    case 'card':
    case 'state-snapshot': {
      const card = parseCardEvent(ev.data);
      if (card) result.cards.push(card);
      break;
    }
    case 'done': {
      const d = ev.data as { costUsd?: number } | undefined;
      if (d?.costUsd) result.costUsd = d.costUsd;
      result.finishReason = 'done';
      break;
    }
    case 'error': {
      const e = ev.data as { message?: string } | undefined;
      result.error = e?.message ?? 'unknown error';
      result.finishReason = 'error';
      break;
    }
  }
}

function extractDeltaText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const obj = data as { text?: unknown; delta?: unknown };
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.delta === 'string') return obj.delta;
  }
  return '';
}

function parseCardEvent(data: unknown): CardEvent | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  // The converse SSE emits state-snapshot envelopes whose `snapshot.openCards`
  // is the array we care about. Single 'card' events are simpler.
  const snapshot = obj.snapshot as { openCards?: unknown } | undefined;
  if (snapshot?.openCards && Array.isArray(snapshot.openCards)) {
    // Return the *first* card; the runner sees one event per emitted card.
    const c = snapshot.openCards[0] as Record<string, unknown> | undefined;
    if (!c) return null;
    return cardFromObj(c);
  }
  return cardFromObj(obj);
}

export function cardFromObj(c: Record<string, unknown>): CardEvent | null {
  // The state-channel OpenCardSnapshot (tooldef card-correlator) carries NO
  // `kind` field — its shape is { correlationId, prompt, presentation:
  // { kind: 'radio'|'checkbox', options, voiceAnswerable? }, fallbackText, … }.
  // The old parser required `kind`/`cardKind` and silently dropped EVERY real
  // chat_ask_choice card, which is why no S16 run ever recorded a card even
  // when the brain emitted one (voice-persona P-003, found 2026-06-07).
  // Derive the kind from the presentation for snapshot-shaped cards.
  const presentation = (c.presentation && typeof c.presentation === 'object'
    ? c.presentation
    : undefined) as
    | { kind?: unknown; options?: unknown; voiceAnswerable?: unknown }
    | undefined;
  const kind =
    typeof c.kind === 'string'
      ? c.kind
      : typeof c.cardKind === 'string'
        ? (c.cardKind as string)
        : presentation?.kind === 'radio' || presentation?.kind === 'checkbox'
          ? 'chat:ask_choice'
          : null;
  if (!kind) return null;
  const optsRaw = Array.isArray(c.options)
    ? (c.options as Array<{ id?: unknown; label?: unknown }>)
    : Array.isArray(presentation?.options)
      ? (presentation.options as Array<{ id?: unknown; label?: unknown }>)
      : undefined;
  const fallbackText = typeof c.fallbackText === 'string' ? (c.fallbackText as string) : undefined;
  return {
    kind,
    options: optsRaw
      ?.filter((o) => typeof o.id === 'string' && typeof o.label === 'string')
      .map((o) => ({ id: o.id as string, label: o.label as string })),
    // For snapshot-shaped (presentation-carrying) cards, the REAL voice flag
    // is presentation.voiceAnswerable (set only when true) — asserting on it
    // catches a brain that forgot voiceAnswerable:true. Legacy card events
    // without a presentation keep the fallbackText heuristic.
    voiceAnswerable: presentation ? presentation.voiceAnswerable === true : !!fallbackText,
    payload: c,
  };
}

function extractControlTags(text: string): ControlTag[] {
  const tags: ControlTag[] = [];
  // Operator emits <set_mode>passive</set_mode> as a paired tag; the
  // others are self-closing or void. We accept both forms — paired
  // tags' inner text lands as attrs.value.
  const re = /<(continue|sleep|spawn|set_mode)(\s+([^/>]*))?(?:>([^<]*)<\/\1>|\/?>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase() as ControlTag['tag'];
    const attrs: Record<string, string> = {};
    const attrStr = (m[3] ?? '').trim();
    if (attrStr) {
      for (const am of attrStr.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
        attrs[am[1]] = am[2];
      }
    }
    const innerText = (m[4] ?? '').trim();
    if (innerText) attrs.value = innerText;
    tags.push({ tag, attrs: Object.keys(attrs).length > 0 ? attrs : undefined });
  }
  return tags;
}

function errorTurn(message: string, latencyMs: number): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs,
    finishReason: 'error',
    error: message,
    rawSseTape: [],
  };
}
