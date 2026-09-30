/**
 * POST /api/agent-config/test
 *
 * Fires a one-shot PONG prompt at the **backend the user actually
 * selected** (claude-code or omp — resolved via effectiveBackend) to
 * verify that agent CLI is installed, reachable, and authenticated.
 * Returns { ok, finalText, durationMs, costUsd, error?, backend }.
 *
 * Why probe the selected backend: this is the "Test current backend"
 * button, so it fires at the backend the user actually chose — omp
 * exercises the omp CLI; probing claude-code exercises the local claude
 * session / Anthropic key. An earlier version hard-pinned a single
 * backend, so the button validated that path regardless of the user's
 * choice — green even when their selected agent CLI was broken.
 */
import { runAgentChat } from '../../../agent-chat-stream';
import { readAgentConfig, effectiveBackend } from '../../../agent-config';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-config/test',
  auth: 'loopback',
  timeoutSec: 45, // handler self-bounds at 30s; give the route-stack headroom
  async handler() {
    const started = Date.now();
    const backend = effectiveBackend(await readAgentConfig()); // 'claude-code' | 'omp'
    let finalText = '';
    let costUsd = 0;
    let errorMsg: string | undefined;
    let timedOut = false;

    try {
      const ac = new AbortController();
      const killer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, 30_000);
      try {
        // No model override: test the configured CLI's default so this
        // validates auth/reachability, not a specific per-role model.
        for await (const ev of runAgentChat({
          backend,
          promptText: 'Reply with exactly the four characters: PONG',
          signal: ac.signal,
        })) {
          if (ev.type === 'delta') finalText += ev.text; // CLI backends stream incrementally
          else if (ev.type === 'result') {
            if (ev.finalText) finalText = ev.finalText;
            costUsd = ev.costUsd;
          } else if (ev.type === 'error') {
            errorMsg = `${ev.message}${ev.stderr ? `: ${ev.stderr.slice(0, 400)}` : ''}`;
          }
        }
      } finally {
        clearTimeout(killer);
      }
    } catch (err) {
      errorMsg = (err as Error).message;
    }
    if (timedOut && !errorMsg) {
      errorMsg =
        `timed out after 30s — the ${backend} CLI is slow, not installed, or not authenticated ` +
        (backend === 'omp'
          ? '(run `omp` once, or check ~/.omp/agent/auth.json)'
          : '(check the `claude` binary + a Claude session, or set an Anthropic key)');
    }
    if (!errorMsg && finalText.trim().length === 0) {
      errorMsg = `${backend} returned cleanly but produced no output`;
    }

    const trimmed = finalText.trim();
    return Response.json({
      ok: !errorMsg && trimmed.length > 0,
      finalText: trimmed,
      durationMs: Date.now() - started,
      costUsd,
      error: errorMsg ?? null,
      backend,
    });
  },
});
