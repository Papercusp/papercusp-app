/**
 * sentinel-output-buffer — Phase D voice-OUT relay for the Sentinel-as-Claude-TUI
 * (sentinel-as-claude-tui-2026-06-22). The Sentinel calls the `voice:say` MCP
 * tool → `pushSentinelSay`; consumers drain via `drainSentinelSays`. In the
 * shipped one-brain pipeline there are two mutually-exclusive consumers:
 * the server-side full-agent says-pump while a voice session is live, or the
 * local webview's `GET /api/operator/papercup-output` poll when it is not.
 *
 * CROSS-PROCESS via PG (migration 390). `voice:say` executes inside the
 * agent-mcp process the psu Sentinel's role-scoped MCP connects to (observed:
 * 127.0.0.1:9071), while the webview drains on a DIFFERENT operator process —
 * so the prior PROCESS-LOCAL in-memory FIFO never bridged them (the user spoke,
 * got a correct TUI answer, and heard nothing). A single GLOBAL FIFO in shared
 * PG (`harness_shared.sentinel_says`) does: every operator/agent-mcp process on
 * the box talks to one database (native :5432 in dev, embedded in the shipped
 * app). LOCAL APP USER ONLY (owner constraint) — not the P2P voice-channel system.
 */
import { getOrgPg } from '@papercusp/db-org';
import { withPgRetry } from './pg-transient-retry';

/** Keep the queue bounded — a stalled consumer must not grow it without limit. */
const MAX = 32;

/**
 * Append a spoken line (from the Sentinel's `voice:say`). No-ops on blank, and
 * never throws: a voice-out relay failure must not fail the Sentinel's turn.
 */
export async function pushSentinelSay(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.sentinel_says (line, created_at)
      VALUES (${t}, ${Date.now()})
    `;
    // Bound the table to the most-recent MAX rows (best-effort).
    await sql`
      DELETE FROM harness_shared.sentinel_says
       WHERE id NOT IN (
         SELECT id FROM harness_shared.sentinel_says ORDER BY id DESC LIMIT ${MAX}
       )
    `;
  } catch (e) {
    console.warn(`[sentinel-output-buffer] pushSentinelSay failed: ${String(e).slice(0, 160)}`);
  }
}

/**
 * Return + clear all buffered spoken lines. The caller is whichever live
 * consumer currently owns the FIFO drain. Never throws: on any PG error the
 * drain just sees an empty batch this tick.
 */
export async function drainSentinelSays(): Promise<string[]> {
  try {
    // Bounded retry on a transient CONNECT_TIMEOUT (WI-2776): the DELETE…RETURNING
    // is issued in the connect phase, so a connect timeout means it provably never
    // ran — safe to re-issue this mutating drain. Absorbs the self-healing pooler
    // blip that otherwise logged a hard failure every tick; a sustained outage still
    // exhausts retries and hits the catch below.
    const { sql } = getOrgPg();
    const rows = await withPgRetry(
      () => sql<{ line: string }[]>`
        WITH drained AS (
          DELETE FROM harness_shared.sentinel_says RETURNING id, line
        )
        SELECT line FROM drained ORDER BY id ASC
      `,
      { label: 'drainSentinelSays' },
    );
    return rows.map((r) => r.line);
  } catch (e) {
    console.warn(`[sentinel-output-buffer] drainSentinelSays failed: ${String(e).slice(0, 160)}`);
    return [];
  }
}
