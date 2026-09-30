/**
 * Wake-delivery health read over `harness_shared.psu_pty_host_events`
 * (psu-pty-turn-boundary-generalization-2026-09-22, P-007 -> P-008).
 *
 * P-007 added the `turn-delivered` SUCCESS row, which is what made a delivery RATE
 * computable at all: before it, all 51 host event kinds were failures, drops, expiries or
 * lifecycle markers, so the failure side was fully instrumented while the denominator did
 * not exist. This module is the reader that turns that into a number, and P-008 is its
 * first consumer — a wedge report that says "this host has delivered 0 of 14 wakes in 6h"
 * is actionable in a way that "this host looks wedged" is not.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM THE INGEST ──────────────────────────────────────
 * `psu-pty-host-events-ingest.ts` owns WRITING the relation and pulls in fs + unlink to do
 * it. The wedge guard needs only to READ one aggregate, and a detector that runs every 20
 * minutes should not import a GC module (with its delete paths) to fetch a count.
 *
 * ── THE PART THAT IS EASY TO GET WRONG ───────────────────────────────────────────────
 * A rate is only as honest as its DENOMINATOR, and this one has two specific traps:
 *
 *  1. `busy-gate-expired` IS NOT A LOSS ANYMORE. It was the obvious "wake failed" marker,
 *     and counting it as one is the intuitive implementation. But P-005 re-arms a deferred
 *     turn and delivers it at the next clean boundary (plan D-007, confirmed from a host
 *     ledger: busy-gate-expired -> wake-rearm-queued -> turn-delivered). So a run counting
 *     it as terminal would report a low success rate that is measuring the RECOVERY
 *     MECHANISM WORKING — and would get worse the better the re-arm performs. It is
 *     reported separately as `recovered`, never in the loss set.
 *
 *  2. NO DATA IS NOT ZERO PERCENT. The ingest routine is scheduled; if it has not run, or
 *     ran outside this window, the table is legitimately empty. Rendering that as "0%
 *     delivery success" would manufacture a fleet-wide outage out of an unscheduled
 *     janitor — and 0% is exactly the reading that provokes an emergency response. An
 *     empty window returns `measured:false` with a reason and a NULL rate; callers must
 *     branch on it rather than formatting `ratePct`.
 *
 * The loss set is therefore an EXPLICIT allowlist, not "everything that is not
 * turn-delivered". Kinds are added to it deliberately, with the reasoning recorded beside
 * each one, because the host's kind vocabulary grows and a new lifecycle marker must not
 * silently start counting as a delivery failure. `byKind` returns the raw counts so any
 * consumer can recompute the rate under a different definition instead of trusting this
 * one.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

/** The one success row. Emitted by verifySubmitted() only when the turn provably landed. */
export const WAKE_SUCCESS_KIND = 'turn-delivered';

/**
 * Outcomes where a wake ended WITHOUT reaching the agent and nothing further is pending.
 *
 * Deliberately narrow. Each entry is a terminal disposition of a delivery attempt:
 *   - stale-fire-dropped    — the fire was older than its validity window; never injected.
 *   - retired-mode-dropped  — addressed to a mode this host no longer supports.
 *   - mcp-reconnect-dropped — dropped across an MCP reconnect rather than re-armed.
 *   - wake-rearm-unsupported— the re-arm path could not dispatch this mode, so the P-005
 *                             recovery did NOT apply and the wake really is lost.
 *   - submit-verify-exhausted — injected, but never confirmed as submitted.
 *   - quota-block-starvation  — the turn never ran because quota blocking starved it out.
 *
 * NOT included, and why: `busy-gate-expired` (P-005 re-arms it — see the header),
 * `turn-deferred-*` and `wake-turn-deferred-for-pending-respawn` (deferred is a PENDING
 * state, not an outcome), and every `launch-kickoff-*` / `respawn-*` / `carry-drill-*` row
 * (those belong to session startup and drills, not to the wake-delivery hop this measures).
 */
export const WAKE_TERMINAL_LOSS_KINDS = [
  'stale-fire-dropped',
  'retired-mode-dropped',
  'mcp-reconnect-dropped',
  'wake-rearm-unsupported',
  'submit-verify-exhausted',
  'quota-block-starvation',
] as const;

/** Deferred-then-rescued: counted and reported, but never as a loss. See trap 1 above. */
export const WAKE_RECOVERED_KIND = 'busy-gate-expired';

export interface WakeDeliveryHealth {
  /**
   * False when the window held no relevant rows at all. `ratePct` is NULL in that case and
   * MUST NOT be rendered as 0 — see trap 2. `reason` says which flavour of absence it is.
   */
  measured: boolean;
  reason?: 'no-rows-in-window' | 'relation-missing' | 'query-failed';
  windowHours: number;
  /** Successful deliveries in the window. */
  delivered: number;
  /** Terminal losses, per WAKE_TERMINAL_LOSS_KINDS. */
  lost: number;
  /** Deferred at the busy gate — re-armed by P-005, so NOT counted in `lost`. */
  recovered: number;
  /** delivered / (delivered + lost), as a percentage. NULL when !measured. */
  ratePct: number | null;
  /** Raw per-kind counts, so the rate is always recomputable under another definition. */
  byKind: Record<string, number>;
  /** Restricted to these owners when the caller asked for a per-host reading. */
  ownerIds?: string[];
}

export interface WakeDeliveryHealthOptions {
  sql?: Sql;
  workspaceId?: string;
  /** Lookback window. */
  sinceHours?: number;
  /** Restrict to specific hosts — what the wedge report uses for a per-host reading. */
  ownerIds?: readonly string[];
}

/**
 * Read wake-delivery health for a window.
 *
 * FAIL-SOFT: every failure path returns `measured:false` with a reason rather than
 * throwing. The callers are a 20-minute detector routine and a report renderer; neither
 * should fail because a telemetry aggregate was unavailable, and a thrown error there would
 * suppress the wedge report that is the actually-urgent signal.
 */
export async function readWakeDeliveryHealth(
  opts: WakeDeliveryHealthOptions = {},
): Promise<WakeDeliveryHealth> {
  const sinceHours = Number.isFinite(opts.sinceHours) && (opts.sinceHours as number) > 0
    ? (opts.sinceHours as number)
    : 6;
  const ownerIds = opts.ownerIds?.length ? [...new Set(opts.ownerIds)] : undefined;
  const base: WakeDeliveryHealth = {
    measured: false,
    windowHours: sinceHours,
    delivered: 0,
    lost: 0,
    recovered: 0,
    ratePct: null,
    byKind: {},
    ...(ownerIds ? { ownerIds } : {}),
  };

  const kinds = [WAKE_SUCCESS_KIND, WAKE_RECOVERED_KIND, ...WAKE_TERMINAL_LOSS_KINDS];

  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    const rows = (await sql`
      SELECT kind, count(*)::int AS n
        FROM harness_shared.psu_pty_host_events
       WHERE workspace_id = ${workspaceId}
         AND ts >= now() - (${sinceHours} * interval '1 hour')
         AND kind = ANY(${sql.array([...kinds])})
         ${ownerIds ? sql`AND owner_id = ANY(${sql.array(ownerIds)})` : sql``}
       GROUP BY kind
    `) as unknown as Array<{ kind: string; n: number }>;

    if (!rows.length) return { ...base, reason: 'no-rows-in-window' };

    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = Number(r.n) || 0;

    const delivered = byKind[WAKE_SUCCESS_KIND] ?? 0;
    const recovered = byKind[WAKE_RECOVERED_KIND] ?? 0;
    const lost = WAKE_TERMINAL_LOSS_KINDS.reduce((sum, k) => sum + (byKind[k] ?? 0), 0);
    const denom = delivered + lost;

    return {
      ...base,
      measured: true,
      delivered,
      lost,
      recovered,
      byKind,
      // A window containing only `recovered` rows has no terminal outcomes to rate. Report
      // the counts and a NULL rate rather than dividing by zero into a misleading 0 or 100.
      ratePct: denom > 0 ? Math.round((delivered / denom) * 1000) / 10 : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A missing relation means migration 1190 has not applied on this host yet — a
    // legitimate, temporary state that must read differently from a real query failure.
    const missing = /does not exist/i.test(msg);
    return { ...base, reason: missing ? 'relation-missing' : 'query-failed' };
  }
}

/**
 * One-line render for a report. Never formats a percentage it does not have: an unmeasured
 * window says so out loud, because "0% delivered" and "we could not measure" are the two
 * readings a wedge report must never conflate.
 */
export function renderWakeDeliveryHealth(h: WakeDeliveryHealth): string {
  if (!h.measured) {
    const why =
      h.reason === 'relation-missing'
        ? 'telemetry table not present yet (migration 1190 pending on this host)'
        : h.reason === 'query-failed'
          ? 'telemetry query failed'
          : 'no delivery telemetry in window';
    return `wake-delivery success rate: NOT MEASURED — ${why} (last ${h.windowHours}h).`;
  }
  const rate = h.ratePct === null ? 'n/a (no terminal outcomes)' : `${h.ratePct}%`;
  return (
    `wake-delivery success rate: ${rate} over the last ${h.windowHours}h ` +
    `(${h.delivered} delivered, ${h.lost} lost, ${h.recovered} deferred-then-re-armed). ` +
    `Rate = delivered/(delivered+lost); deferred-then-re-armed is EXCLUDED because P-005 ` +
    `recovers it — counting it as a loss would penalise the recovery working.`
  );
}
