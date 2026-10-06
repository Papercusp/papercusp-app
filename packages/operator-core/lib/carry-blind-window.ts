/**
 * carry-blind-window — measure the gap between when a carry document was BUILT
 * and when the cut it describes actually FIRED, and hand the successor a real
 * number for it (EI-21442716425230784).
 *
 * WHY THIS EXISTS. The deterministic carry is a SNAPSHOT taken when
 * `session:request-compaction` runs. The cut happens later: the psu host has to
 * win a busy-gate, waits for the pty to go quiet, and re-polls across successive
 * windows (minutes, by design). Everything the predecessor does in between is
 * invisible to the successor — it is not in the carry doc, and the doc cannot
 * know it exists.
 *
 * The failure that commissioned this: carry built 16:13:55Z, the predecessor
 * kept working, at 16:17:33Z it produced an OAuth consent URL it explicitly
 * asked the OWNER to act on, and the cut landed ~19s later. The successor's
 * carry contained no trace of it; the owner came back with "give me the link
 * again i lost it" and the successor had to discover via `sessions:search` that
 * the link had ever existed.
 *
 * The carry document DOES warn that a blind window exists — in prose, with no
 * signal about THIS one. A successor cannot tell "nothing happened after the
 * snapshot" from "the single most owner-salient act of the session happened
 * after the snapshot", so the warning is unfalsifiable and therefore
 * unactionable. This module replaces it with a measurement.
 *
 * WHAT IT MEASURES, AND WHY THIS SOURCE. Both endpoints are ALREADY recorded,
 * so nothing new is written at the boundary:
 *   · the snapshot — the caller's own `session:request-compaction` row in
 *     `harness_shared.tool_invocations` (the call that built the carry);
 *   · the cut — the per-owner host event log's carry-respawn verdict, read
 *     through the EXISTING {@link readPriorRespawnOutcome} derivation.
 * The window's CONTENT is then the caller's tool calls strictly between them:
 * every one of those is work the carry doc does not contain. Live sample
 * (2026-08-25, 12 most recent self-requested compactions): 26, 34, 51, 68, 75,
 * 87, 88, 112, 137, 152, 187, 196. The blind window is not an edge case.
 *
 * Bounding the count at the CUT (rather than at "now") is what makes this a
 * ONE-SHOT: the coord ownerId survives the respawn, so an unbounded count would
 * grow with the successor's own calls and re-emit a different line every turn.
 *
 * Every derivation here is PURE and exported separately from the single IO
 * reader, so the arithmetic is unit-testable without a host, a PG, or a cut.
 */
import type { Sql } from 'postgres';
import { automaticToolInvocationPredicate } from './agent-tools/sessions/automatic-tool-names';
import { readPriorRespawnOutcome, type PriorRespawn } from './carry-respawn-outcome';

/** A measured blind window: what the carry doc could not have seen. */
export interface CarryBlindWindow {
  /** When the carry snapshot was taken (the request-compaction call), ms. */
  snapshotAtMs: number;
  /** When the cut actually fired, ms. */
  cutAtMs: number;
  /** cutAtMs - snapshotAtMs. */
  windowMs: number;
  /** Tool calls the predecessor made INSIDE the window — work the carry lacks. */
  callsAfter: number;
  /** The newest tool call inside the window, ms (null when unmeasured). */
  lastCallAtMs: number | null;
  /** That call's tool name — a cheap hint at what the predecessor was doing. */
  lastToolName: string | null;
}

/**
 * How recent the cut must be for this to be NEWS rather than history. A
 * successor that has already taken many turns has demonstrably moved on, and a
 * warning that is always on is one nobody reads (same rule, and the same
 * reasoning, as LOST_RESPAWN_AMBIENT_MAX_AGE_MS next door).
 */
export const CARRY_BLIND_WINDOW_MAX_CUT_AGE_MS = 30 * 60 * 1000;

/**
 * A window shorter than this is the ordinary build→inject latency, not a gate
 * wait: the carry is assembled and written to the host socket within a second or
 * two, so nothing can have happened in it. Measured from the live sample above,
 * where every genuine gate wait ran tens of seconds to minutes.
 */
export const CARRY_BLIND_WINDOW_MIN_MS = 5_000;

/**
 * PURE: assemble the window, or null when there is nothing worth telling the
 * successor.
 *
 * Returns null — deliberately, and each for its own reason — when:
 *   · either endpoint is unmeasured or non-finite (never invent a window);
 *   · the cut is not AFTER the snapshot (clock skew / a mismatched pair);
 *   · the window is below {@link CARRY_BLIND_WINDOW_MIN_MS} (no gate wait);
 *   · the cut is older than {@link CARRY_BLIND_WINDOW_MAX_CUT_AGE_MS} (history);
 *   · `callsAfter` is 0 — the window was genuinely EMPTY, so the carry document
 *     really is complete and saying so would be noise. Note this is an ANSWER,
 *     not a degradation: it is only reachable when the count was measured.
 */
export function buildCarryBlindWindow(input: {
  snapshotAtMs: number | null;
  cutAtMs: number | null;
  callsAfter: number | null;
  lastCallAtMs?: number | null;
  lastToolName?: string | null;
  nowMs?: number;
  maxCutAgeMs?: number;
}): CarryBlindWindow | null {
  const { snapshotAtMs, cutAtMs, callsAfter } = input;
  if (snapshotAtMs == null || !Number.isFinite(snapshotAtMs)) return null;
  if (cutAtMs == null || !Number.isFinite(cutAtMs)) return null;
  if (callsAfter == null || !Number.isFinite(callsAfter) || callsAfter <= 0) return null;
  const windowMs = cutAtMs - snapshotAtMs;
  if (windowMs < CARRY_BLIND_WINDOW_MIN_MS) return null;
  const now = input.nowMs ?? Date.now();
  const maxAge = input.maxCutAgeMs ?? CARRY_BLIND_WINDOW_MAX_CUT_AGE_MS;
  if (now - cutAtMs > maxAge) return null;
  const lastCallAtMs =
    typeof input.lastCallAtMs === 'number' && Number.isFinite(input.lastCallAtMs)
      ? input.lastCallAtMs
      : null;
  return {
    snapshotAtMs,
    cutAtMs,
    windowMs,
    callsAfter: Math.round(callsAfter),
    lastCallAtMs,
    lastToolName: input.lastToolName?.trim() ? input.lastToolName.trim() : null,
  };
}

/** PURE: the cut timestamp from an already-derived respawn verdict, or null.
 *  Only a DELIVERED verdict names a cut — `pending`/`dropped`/`none` describe a
 *  cut that has not happened, and reading one as a boundary would date the
 *  window from an event the predecessor never reached. */
export function cutAtFromRespawn(prior: PriorRespawn | null | undefined): number | null {
  if (!prior || prior.outcome !== 'delivered' || !prior.ts) return null;
  const ms = Date.parse(prior.ts);
  return Number.isFinite(ms) ? ms : null;
}

function humanDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 90) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m${rem}s` : `${mins}m`;
}

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * PURE: the one line the successor reads. It has to carry a COUNT (the thing
 * that makes it falsifiable), the window it covers, and the exact retrieval
 * verb — a warning without a recovery move is the prose this replaces.
 */
export function renderCarryBlindWindowLine(w: CarryBlindWindow): string {
  const tool = w.lastToolName ? `, last ${w.lastToolName}` : '';
  return (
    `- ⚠ carry blind window: ${w.callsAfter} tool call(s) landed in the ` +
    `${humanDuration(w.windowMs)} between your carry snapshot (${isoMinute(w.snapshotAtMs)}) and the cut` +
    `${tool} — NOT in your carry doc. Read them before treating it as complete: ` +
    `sessions:read { session:'self' }.`
  );
}

interface BlindWindowRow {
  snapshot_at: string | Date | null;
  calls_after: string | number | null;
  last_call_at: string | Date | null;
  last_tool: string | null;
}

function toMs(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * IO: measure this owner's blind window, or null when there is none to report.
 *
 * Never throws — an unreadable log or PG yields null, i.e. "say nothing", which
 * is the same degradation every other turn-start source takes. A missed warning
 * costs one `sessions:read`; a warning manufactured from a failed read would
 * send a successor hunting turns that do not exist.
 */
export async function readCarryBlindWindow(
  ownerId: string,
  opts: {
    workspaceId?: string | null;
    now?: number;
    sql?: Sql;
    prior?: PriorRespawn;
  } = {},
): Promise<CarryBlindWindow | null> {
  if (!ownerId?.trim()) return null;
  const now = opts.now ?? Date.now();
  try {
    const prior = opts.prior ?? (await readPriorRespawnOutcome(ownerId, { now }));
    const cutAtMs = cutAtFromRespawn(prior);
    if (cutAtMs == null) return null;
    if (now - cutAtMs > CARRY_BLIND_WINDOW_MAX_CUT_AGE_MS) return null;
    const sql = opts.sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
    const cutAt = new Date(cutAtMs).toISOString();
    const ws = opts.workspaceId?.trim() ? opts.workspaceId.trim() : null;
    const automatic = automaticToolInvocationPredicate(sql, 't');
    // ONE round-trip: the snapshot call, then the calls that landed between it
    // and the cut. Both legs ride tool_invocations_coord_owner_idx
    // (coord_owner_id, invoked_at DESC).
    const rows = (await sql`
      WITH snapshot AS (
        SELECT invoked_at
          FROM harness_shared.tool_invocations
         WHERE coord_owner_id = ${ownerId}
           AND tool_name = 'session:request-compaction'
           AND invoked_at <= ${cutAt}::timestamptz
           AND invoked_at > ${cutAt}::timestamptz - interval '2 hours'
           ${ws ? sql`AND workspace_id = ${ws}` : sql``}
         ORDER BY invoked_at DESC
         LIMIT 1
      ),
      after AS (
        -- Every column here MUST be t-qualified: the snapshot CTE also exposes
        -- an invoked_at, so a bare reference raises 'column reference
        -- "invoked_at" is ambiguous' (42702) at RUNTIME — a shape no
        -- type-checker sees and no unit test with a fake sql tag can reach.
        SELECT count(*)::bigint AS calls_after,
               max(t.invoked_at) AS last_call_at,
               (ARRAY_AGG(t.tool_name ORDER BY t.invoked_at DESC))[1] AS last_tool
          FROM harness_shared.tool_invocations t, snapshot s
         WHERE t.coord_owner_id = ${ownerId}
           AND t.invoked_at > s.invoked_at
           AND t.invoked_at <= ${cutAt}::timestamptz
           AND NOT ${automatic}
           ${ws ? sql`AND t.workspace_id = ${ws}` : sql``}
      )
      SELECT s.invoked_at AS snapshot_at, a.calls_after, a.last_call_at, a.last_tool
        FROM snapshot s, after a`) as unknown as BlindWindowRow[];
    const row = rows?.[0];
    if (!row) return null;
    return buildCarryBlindWindow({
      snapshotAtMs: toMs(row.snapshot_at),
      cutAtMs,
      callsAfter: row.calls_after == null ? null : Number(row.calls_after),
      lastCallAtMs: toMs(row.last_call_at),
      lastToolName: row.last_tool,
      nowMs: now,
    });
  } catch {
    return null;
  }
}
