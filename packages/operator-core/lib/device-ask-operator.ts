/**
 * ask_operator proxy — routes a free-form voice utterance through the
 * existing /api/agent-mcp/operator-converse SSE endpoint, drains the
 * stream, and returns a single string suitable for the EL agent to
 * speak.
 *
 * Extracted from _hono/mobile.ts so the failure-mode mapping can be
 * unit-tested without spinning up a Hono server. The route stays a
 * thin wrapper.
 *
 * Failure-mode contract (the response shape the route returns):
 *
 *   { kind: 'ok',           text: '<words to speak>' }
 *   { kind: 'empty',        text: 'The operator brain returned an empty response…' }
 *   { kind: 'bad-status',   text: 'Operator is offline — …', status: number }
 *   { kind: 'timeout',      text: 'Operator brain took longer than 25s — …', timeoutMs: 25000 }
 *   { kind: 'error',        text: 'Hit an error reaching the operator brain.', error: string }
 *
 * Caller (the Hono route) just returns `c.json(text)` — the kind field
 * is for logging/metrics.
 */

const VALID_TRIGGERS = new Set([
  'user_message',
  'quiet_wait_resume',
  'open_canvas',
  'user_says_ready',
]);

export const ASK_OPERATOR_TIMEOUT_MS = 25_000;

export type AskOperatorResult =
  | { kind: 'ok'; text: string }
  | { kind: 'empty'; text: string; eventCount: number; trigger: string }
  | { kind: 'bad-status'; text: string; status: number }
  | { kind: 'timeout'; text: string; timeoutMs: number }
  | { kind: 'error'; text: string; error: string };

export function normalizeTrigger(raw: unknown): string {
  if (typeof raw !== 'string') return 'user_message';
  // Legacy: brain-driven silence triggers retired 2026-05-14. Stale
  // EL agent configs that still emit silence_* now collapse to
  // user_message — the deterministic /silence-nudge endpoint emits
  // the Ready card from the provider's timer, not from voice paths.
  if (raw === 'silence_nudge' || raw === 'silence_check' || raw === 'silence_after_question') {
    return 'user_message';
  }
  return VALID_TRIGGERS.has(raw) ? raw : 'user_message';
}

/** Drains an SSE stream from operator-converse, summing every event's `text` field. */
async function drainConverseStream(body: ReadableStream<Uint8Array>): Promise<{ assembled: string; eventCount: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let assembled = '';
  let eventCount = 0;
   
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const evt = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      eventCount += 1;
      for (const line of evt.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (typeof payload?.text === 'string') assembled += payload.text;
        } catch {
          /* skip non-JSON */
        }
      }
    }
  }
  return { assembled, eventCount };
}

export interface AskOperatorOptions {
  baseUrl: string;
  userText: string;
  trigger: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export async function askOperatorViaConverse(opts: AskOperatorOptions): Promise<AskOperatorResult> {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ASK_OPERATOR_TIMEOUT_MS;
  const trigger = normalizeTrigger(opts.trigger);
  const userText = opts.userText.trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(`${opts.baseUrl}/api/agent-mcp/operator-converse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: userText ? [{ role: 'user', content: userText }] : [],
        trigger,
        mayAskActive: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      return {
        kind: 'bad-status',
        status: res.status,
        text: "Papercup is offline — can't reach the brain right now. Try again in a moment.",
      };
    }
    const { assembled, eventCount } = await drainConverseStream(res.body);
    const sayMatch = assembled.match(/<say(?:\s[^>]*)?>([\s\S]*?)<\/say>/i);
    const out = (sayMatch ? sayMatch[1] : assembled).trim();
    if (!out) {
      return {
        kind: 'empty',
        eventCount,
        trigger,
        text: 'The operator brain returned an empty response. This is a known issue — your phone is fine.',
      };
    }
    return { kind: 'ok', text: out };
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError' || controller.signal.aborted;
    if (aborted) {
      return {
        kind: 'timeout',
        timeoutMs,
        text: `Papercup brain took longer than ${timeoutMs / 1000}s — skipping this turn.`,
      };
    }
    return {
      kind: 'error',
      error: (err as Error)?.message ?? String(err),
      text: 'Hit an error reaching the operator brain — try again.',
    };
  } finally {
    clearTimeout(timer);
  }
}
