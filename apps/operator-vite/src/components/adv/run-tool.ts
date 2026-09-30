/**
 * ONE client-side dispatch onto the gated + audited `/api/agent-mcp/run-tool`
 * bridge (plan learning-pot-scope-gate-2026-08-30, P-007).
 *
 * WHY THIS EXISTS. The same ~30-line fetch had been copy-pasted into six
 * places — AutomationPane, LearningLoopControl, ScheduleEditor, pot-control,
 * useModelOverride, and the rail's own control path — and the copies had
 * already DIVERGED in a way that costs debugging time rather than tidiness:
 *
 *   AutomationPane's copy does a bare `JSON.parse(text)` on the tool result.
 *   The projected-tool dispatcher returns VALIDATION failures as PLAIN TEXT
 *   (e.g. `invalid_input: invalid_args: ...`), not JSON — so on exactly the
 *   errors you most need to read, that copy throws a client-side
 *   `SyntaxError: Unexpected token 'i'` and the real server message is lost.
 *   pot-control's copy had already learned this and guards it.
 *
 * This module keeps the CORRECT body (the guarded one) as the single
 * implementation, so a lesson learned in one caller is not re-learned in the
 * next. New UI write paths call `runAgentTool`; they should not hand-roll the
 * fetch again.
 *
 * NOT A SYNC-LAYER BYPASS. This is the WRITE half only. Reads still go through
 * `@papercusp/sync` (`useSyncQuery`), and a caller that changes server state
 * must invalidate the query it just invalidated the truth of — the bridge
 * cannot know which query a given tool affects.
 */

/** The shape `/api/agent-mcp/run-tool` answers with. */
interface RunToolEnvelope {
  ok?: boolean;
  error?: string;
  message?: string;
  result?: { content?: Array<{ text?: string }> };
}

/**
 * Fire one agent tool through the gated/audited bridge. Throws on any failure
 * — transport, envelope, or a tool that ran and REFUSED — so callers can
 * surface the message rather than silently rendering a stale optimistic state.
 *
 * `confirmed: true` is sent because these are user-initiated clicks on a
 * control whose label already states the action; the bridge's own role gating
 * is what actually authorizes the write.
 */
export async function runAgentTool(
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args, confirmed: true }),
  });

  const body = (await res.json().catch(() => ({}))) as RunToolEnvelope;
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }

  const text = body.result?.content?.[0]?.text;
  if (!text) return;

  // See the header: a validation failure arrives as PLAIN TEXT. Never replace
  // a useful server error with a client-side JSON.parse SyntaxError — surface
  // the text itself, which IS the message.
  let payload: { ok?: boolean; message?: string; error?: string };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new Error(text);
  }

  if (payload.ok === false) {
    throw new Error(payload.message ?? payload.error ?? `${name} refused`);
  }
}
