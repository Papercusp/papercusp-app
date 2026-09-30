/**
 * Coord-deafness detection (coord-delivery-residual-gaps-2026-07-11 P-001).
 *
 * A session receives mid-turn coord mail via per-client legs (the Claude
 * PostToolUse[*] hook, Codex's per-session hooks.json, OMP's coord-hook
 * steer, server-side defineTool injection — see the coord-mid-turn-delivery
 * insight). Every leg ultimately calls `coord:inbox` / `coord:orient`
 * through /api/mcp, so each poll is a real row in
 * `harness_shared.tool_invocations` with `coord_owner_id` — which means
 * mail-reading freshness is ALREADY server-observable, no new tables.
 *
 * A session that is LIVE and demonstrably ACTIVE but has not read its inbox
 * for a whole budget window is **deaf right now** — its hook enrollment
 * drifted (`~/.claude/settings.json` lost the managed entry), its runtime
 * has no injection leg, or it is buried in one long foreground exec.
 * Whichever the cause, a peer/leader sending it mail must SEE that instead
 * of assuming delivery. This module is the ONE derivation shared by the
 * coord:presence overlay, coord:glance, and the infra watchdog:
 * a pure classifier + one batched read.
 *
 * Semantics note: `coordHook: 'stale' | 'missing'` describes OBSERVED
 * mail-reading freshness, not a config diagnosis — a session mid-way through
 * a 15-minute foreground build is correctly flagged (it IS blind right now)
 * even though its hook config is fine.
 */

import { getOrgPg } from '@papercusp/db-org';

/** The invocations that count as "read my coord mail". Kept as the single
 *  source of truth — `lastInboxReadAt` (loop/checkpoint.ts continuation gate)
 *  and the deafness derivation must never drift apart on this list.
 *  Both colon and underscore spellings appear in tool_invocations depending
 *  on the transport that recorded them.
 *
 *  `activity:report` / `activity_report` (WI-5972 fix): since the
 *  coordination-hook-rpc-fanout-collapse-2026-07-16 refactor (EI-11405), a
 *  native hook's PER-TOOL-CALL coordination pull is no longer a separate
 *  `coord:inbox` MCP round trip — it is FOLDED into `activity:report`'s
 *  `hook_bundle` cursor (see hook-bundle.ts + posttooluse-activity-report.sh,
 *  which explicitly replaced the now-deleted posttooluse-coord-inbox.sh).
 *  `buildActivityHookBundle` calls the inbox tool's handler DIRECTLY
 *  in-process, so that read is telemetered under `tool_name:'activity:report'`
 *  — never under `coord:inbox`/`coord:orient`. Every psu Claude session has
 *  this fold ON by default (PAPERCUSP_COORD_FOLD defaults to "1"), so for the
 *  overwhelming majority of live, actively-working sessions `activity:report`
 *  IS how coord mail actually gets read — omitting it here made every such
 *  session look "deaf" despite demonstrably receiving pushed wakes
 *  (fleet:leader-brief's coord_deaf falsely flagged live, actively-speaking
 *  members whose only "staleness" was never calling coord:inbox/orient BY
 *  NAME). Fail-open by symmetry with the rest of this module: crediting one
 *  extra tool name as "a read" can only REDUCE false-deaf flags, never
 *  introduce a false "not deaf" for a session that is genuinely unreachable
 *  (one with no injection leg at all issues no activity:report fold either,
 *  since the hook itself is what calls it). */
export const COORD_READ_TOOL_NAMES = [
  'coord:inbox',
  'coord:orient',
  'coord_inbox',
  'coord_orient',
  'activity:report',
  'activity_report',
] as const;

/** Default deafness budget: a live, active session with no inbox read for
 *  this long is flagged. Generous by design — hook-enrolled sessions read on
 *  EVERY tool call, so anything past this is a real signal, while pure
 *  thinking gaps between tool calls stay well under it. */
export const DEFAULT_COORD_DEAF_BUDGET_MS = 10 * 60_000;

/** Env-tunable budget (PAPERCUSP_COORD_DEAF_BUDGET_MS), clamped to ≥1 min so a
 *  typo can never turn the whole fleet "deaf" on normal cadence. */
export function coordDeafBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPERCUSP_COORD_DEAF_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COORD_DEAF_BUDGET_MS;
  return Math.max(60_000, Math.floor(raw));
}

/** Batched "when did each owner last read its coord mail" — ONE GROUP BY over
 *  tool_invocations for the whole roster (never per-row queries; the roster
 *  can be ~70 rows). Returns ISO strings keyed by owner; absent key = no read
 *  on record. Fail-soft: any error returns an empty map (callers treat
 *  unknown as not-flaggable, never as deaf). */
export async function lastInboxReadAtBatch(ownerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = ownerIds.filter(Boolean);
  if (!ids.length) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ coord_owner_id: string; last_read: string | Date }[]>`
      SELECT coord_owner_id, MAX(invoked_at) AS last_read
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ANY(${ids})
         AND tool_name = ANY(${[...COORD_READ_TOOL_NAMES]})
       GROUP BY coord_owner_id
    `;
    for (const r of rows) {
      const d = r.last_read instanceof Date ? r.last_read : new Date(r.last_read);
      if (!Number.isNaN(d.getTime())) out.set(r.coord_owner_id, d.toISOString());
    }
  } catch {
    /* fail-soft — an unreadable ledger must never degrade a roster read */
  }
  return out;
}

export type CoordDeafState = 'stale' | 'missing';

export interface CoordDeafVerdict {
  /** 'stale' = has read mail before, but not within budget despite being
   *  active. 'missing' = live + older than budget with NO read on record —
   *  the strongest hint the injection leg was never enrolled. */
  state: CoordDeafState;
  /** Seconds since the last observed read; null when there is none. */
  lastReadAgoSec: number | null;
}

export interface CoordDeafInput {
  /** presence sessionState — only 'live' rows are candidates (a parked
   *  session receives via its standing inbox-wake by design; ended reads
   *  nothing). */
  sessionState: string | null | undefined;
  /** Seconds since last observed activity. The row must be demonstrably
   *  active WITHIN the budget window — otherwise "no reads" is just
   *  idleness, not deafness. */
  lastActiveSecAgo: number | null | undefined;
  /** Session start (ISO). Grace period: a never-read session is only
   *  'missing' once it is older than the budget. */
  startedAt: string | null | undefined;
  /** Last observed coord read (ISO) from lastInboxReadAtBatch; null/absent =
   *  no read on record. */
  lastReadAt: string | null | undefined;
}

/** PURE deafness classifier — null = not deaf / not flaggable (unknowns fail
 *  toward null, never toward a false flag). */
export function classifyCoordDeafness(
  input: CoordDeafInput,
  nowMs: number,
  budgetMs: number = DEFAULT_COORD_DEAF_BUDGET_MS,
): CoordDeafVerdict | null {
  if (input.sessionState !== 'live') return null;
  // Demonstrably active within the window — otherwise the silence is idleness.
  const activeSec = input.lastActiveSecAgo;
  if (typeof activeSec !== 'number' || !Number.isFinite(activeSec) || activeSec < 0) return null;
  if (activeSec * 1000 > budgetMs) return null;

  const readMs = parseIsoMs(input.lastReadAt);
  if (readMs != null) {
    const ago = nowMs - readMs;
    if (ago <= budgetMs) return null;
    return { state: 'stale', lastReadAgoSec: Math.floor(ago / 1000) };
  }

  // No read on record at all: 'missing' only once the session has outlived
  // the grace window (a young session simply hasn't oriented yet), and only
  // when the start time is actually known — unknown start fails toward null.
  const startMs = parseIsoMs(input.startedAt);
  if (startMs == null) return null;
  if (nowMs - startMs <= budgetMs) return null;
  return { state: 'missing', lastReadAgoSec: null };
}

function parseIsoMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}
