/**
 * carry-respawn-storm.ts — detect and break managed carry-respawn STORMS
 * (WI-10002530, the detector failure behind WI-10002522).
 *
 * A storm is one owner queueing carry-respawn after carry-respawn while its
 * successors never take a real turn: each successor boots, immediately asks
 * for another cut, and the host obliges. Measured 2026-09-23: su-cfa16b20 took
 * 14 queued `session:request-compaction` cuts between 00:14:38Z and 00:25:15Z
 * with ZERO agent-origin MCP calls between them (it held the gate lane), and
 * su-3340afad took 8 cuts over two hours with no model turn. Nothing alarmed:
 * every cut returned `respawn:'queued'`, loop:status showed only a wake error,
 * and the fleet leader waited on a claim-release that a wedged-but-alive holder
 * never emits.
 *
 * The known trigger (a Codex fork successor re-firing PreCompact) was fixed in
 * WI-10002522. This module guards the CLASS: any future trigger that recurs on
 * a successor lands in the same ledger shape and trips the same breaker.
 *
 * Evidence source — `harness_shared.tool_invocations`, the ledger every MCP call
 * already writes (indexed on `(coord_owner_id, invoked_at DESC)`):
 *   - a QUEUED cut  = a `session:request-compaction` row with status 'ok';
 *   - a REAL TURN   = any OTHER row with `call_origin = 'agent'` (hook-origin
 *                     rows such as activity:report fire without a model turn,
 *                     and in-process sub-calls are 'unknown', so neither counts);
 *   - a LATCH       = a prior `session:request-compaction` refusal with
 *                     error_code 'respawn-storm' since the last real turn.
 *
 * Absence of rows never PROVES idleness (native Bash/Edit calls write none), so
 * the rule is deliberately narrow: it only fires on POSITIVE evidence of
 * repeated queued cuts inside a short window, and the first real MCP call from
 * the session clears it. Every read is bounded and fail-OPEN — an unreadable
 * ledger never blocks a compaction.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { openEscalation } from './agent-tools/coordination/escalations';
import type { AgentIdentity } from './agent-tools/coordination/identity';

export const REQUEST_COMPACTION_TOOL = 'session:request-compaction';
/** The refusal code this breaker returns (and later reads back as the latch). */
export const RESPAWN_STORM_ERROR = 'respawn-storm';
/** Refuse the Nth queued cut (counting the one being requested) … */
export const RESPAWN_STORM_MIN_CUTS = 3;
/** … when the previous N-1 queued cuts all fell inside this window of now. */
export const RESPAWN_STORM_WINDOW_MS = 10 * 60_000;
/** How far back the ledger is read — also the latch's maximum reach. */
export const RESPAWN_STORM_LOOKBACK_MS = 60 * 60_000;
/** The ledger read must never hold a compaction hostage. */
export const RESPAWN_STORM_READ_TIMEOUT_MS = 1_500;
const LEDGER_ROW_LIMIT = 200;

export interface StormLedgerRow {
  invokedAtMs: number;
  toolName: string;
  status: string;
  callOrigin: string | null;
  errorCode: string | null;
}

export interface RespawnStormVerdict {
  storm: boolean;
  /** Why it fired: a dense run of queued cuts, or a still-open prior refusal. */
  reason: 'dense-cuts' | 'latched' | null;
  /** Queued cuts since the last real turn (within the lookback). */
  cutsSinceRealTurn: number;
  /** ISO timestamps of those cuts, newest first (capped for display). */
  cutTimes: string[];
  /** The most recent real (agent-origin, non-compaction) call, if one was seen. */
  lastRealTurnAt: string | null;
}

const NO_STORM: RespawnStormVerdict = {
  storm: false,
  reason: null,
  cutsSinceRealTurn: 0,
  cutTimes: [],
  lastRealTurnAt: null,
};

/**
 * Pure classifier over one owner's recent ledger rows (any order).
 * Walks newest→oldest until the first real turn; everything before that is the
 * current "no real turn" streak.
 */
export function classifyRespawnStorm(
  rows: readonly StormLedgerRow[],
  nowMs: number,
  opts: { minCuts?: number; windowMs?: number } = {},
): RespawnStormVerdict {
  const minCuts = Math.max(2, opts.minCuts ?? RESPAWN_STORM_MIN_CUTS);
  const windowMs = opts.windowMs ?? RESPAWN_STORM_WINDOW_MS;
  const sorted = [...rows].sort((a, b) => b.invokedAtMs - a.invokedAtMs);
  const cuts: number[] = [];
  let latched = false;
  let lastRealTurnAtMs: number | null = null;
  for (const row of sorted) {
    if (row.toolName === REQUEST_COMPACTION_TOOL) {
      if (row.status === 'ok') cuts.push(row.invokedAtMs);
      else if (row.errorCode === RESPAWN_STORM_ERROR) latched = true;
      continue;
    }
    if (row.callOrigin === 'agent') {
      lastRealTurnAtMs = row.invokedAtMs;
      break;
    }
  }
  const priorNeeded = minCuts - 1;
  const dense = cuts.length >= priorNeeded && nowMs - cuts[priorNeeded - 1]! <= windowMs;
  const storm = dense || latched;
  return {
    storm,
    reason: dense ? 'dense-cuts' : latched ? 'latched' : null,
    cutsSinceRealTurn: cuts.length,
    cutTimes: cuts.slice(0, 20).map((ms) => new Date(ms).toISOString()),
    lastRealTurnAt: lastRealTurnAtMs == null ? null : new Date(lastRealTurnAtMs).toISOString(),
  };
}

async function readLedger(ownerId: string, sql: Sql, lookbackMs: number): Promise<StormLedgerRow[]> {
  const lookbackSec = Math.max(1, Math.round(lookbackMs / 1000));
  const rows = await sql<
    Array<{
      invoked_at: Date | string;
      tool_name: string;
      status: string;
      call_origin: string | null;
      error_code: string | null;
    }>
  >`
    SELECT invoked_at, tool_name, status, call_origin, error_code
      FROM harness_shared.tool_invocations
     WHERE coord_owner_id = ${ownerId}
       AND invoked_at > now() - make_interval(secs => ${lookbackSec})
       AND (tool_name = ${REQUEST_COMPACTION_TOOL} OR call_origin = 'agent')
     ORDER BY invoked_at DESC
     LIMIT ${LEDGER_ROW_LIMIT}`;
  return rows.map((row) => ({
    invokedAtMs: (row.invoked_at instanceof Date ? row.invoked_at : new Date(row.invoked_at)).getTime(),
    toolName: row.tool_name,
    status: row.status,
    callOrigin: row.call_origin,
    errorCode: row.error_code,
  }));
}

/**
 * Read + classify, bounded and fail-OPEN: any error or timeout reports
 * "no storm" so a broken ledger can never strand a session at its limit.
 */
export async function detectRespawnStorm(
  ownerId: string,
  opts: { sql?: Sql; nowMs?: number; timeoutMs?: number; lookbackMs?: number } = {},
): Promise<RespawnStormVerdict> {
  if (!ownerId?.trim()) return NO_STORM;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const read = readLedger(ownerId, sql, opts.lookbackMs ?? RESPAWN_STORM_LOOKBACK_MS);
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs ?? RESPAWN_STORM_READ_TIMEOUT_MS);
    });
    const rows = await Promise.race([read, timeout]);
    if (!rows) return NO_STORM;
    return classifyRespawnStorm(rows, opts.nowMs ?? Date.now());
  } catch {
    return NO_STORM;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RespawnStormAlertInput {
  ownerId: string;
  workspaceId: string | null;
  verdict: RespawnStormVerdict;
  heldItems: ReadonlyArray<{ id: string; title: string | null }>;
}

/** Escalation dedup: ONE open row per storming owner; repeats coalesce onto it. */
export const RESPAWN_STORM_DEDUP_KIND = 'carry-respawn-storm';

export function respawnStormAlertText(input: RespawnStormAlertInput): { summary: string; body: string } {
  const { ownerId, verdict, heldItems } = input;
  const held = heldItems.length
    ? heldItems.map((item) => `- ${item.id}${item.title ? ` — ${item.title.slice(0, 120)}` : ''}`).join('\n')
    : '- (none held)';
  const summary =
    `Carry-respawn storm on ${ownerId}: ${verdict.cutsSinceRealTurn} queued cuts with no real turn ` +
    `— further cuts refused; ${heldItems.length} held work-item(s) are not progressing`;
  const body =
    `session:request-compaction refused a further carry-respawn for ${ownerId} (${RESPAWN_STORM_ERROR}, ` +
    `reason: ${verdict.reason}). Since its last real agent-origin call ` +
    `(${verdict.lastRealTurnAt ?? 'none within the last hour'}) it queued ${verdict.cutsSinceRealTurn} ` +
    `cut(s): ${verdict.cutTimes.join(', ') || 'n/a'}.\n\n` +
    `Each successor asked for another cut before taking a turn, so the session is alive but doing no work. ` +
    `Its claims are NOT released by this — a wedged-but-alive holder never emits fleet:claim-released.\n\n` +
    `Held work-items:\n${held}\n\n` +
    `Triage: read ~/.papercusp/psu-pty/${ownerId}.events.jsonl and the successor transcript for what fires ` +
    `the cut (WI-10002522 was a Codex fork re-firing PreCompact). The breaker clears itself on the ` +
    `session's next real MCP call; otherwise relaunch the session or release/reassign its items. ` +
    `Detector: WI-10002530.`;
  return { summary, body };
}

const BREAKER_OWNER_ID = 'carry-respawn-storm-breaker';

/** Open (or coalesce onto) the owner-facing alert. Fail-soft: never throws. */
export async function escalateRespawnStorm(input: RespawnStormAlertInput): Promise<void> {
  const identity: AgentIdentity = {
    ownerId: BREAKER_OWNER_ID,
    ownerLabel: 'system · carry-respawn storms',
    source: 'principal',
    workspaceId: input.workspaceId,
    userId: null,
  };
  const { summary, body } = respawnStormAlertText(input);
  try {
    await openEscalation(identity, {
      severity: 'advisory',
      summary,
      body,
      meta: {
        dedupKind: RESPAWN_STORM_DEDUP_KIND,
        subjectSignature: input.ownerId,
        stormOwnerId: input.ownerId,
        stormReason: input.verdict.reason,
        cutsSinceRealTurn: input.verdict.cutsSinceRealTurn,
        heldWorkItemIds: input.heldItems.map((item) => item.id),
      },
    });
  } catch (e) {
    console.warn(
      `[carry-respawn-storm] could not open the storm escalation for ${input.ownerId}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}
