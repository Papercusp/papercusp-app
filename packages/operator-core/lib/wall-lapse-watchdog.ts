/**
 * wall-lapse-watchdog.ts — the OWNER-WALL TTL-lapse pager
 * (owner-wall-ttl-lapse-hardening-2026-07-26, EI-18669544162414270).
 *
 * The motivating gap: `WI-4723` (a critical, still-unremediated public-credential
 * exposure) carried a closing instruction — "still LIVE = NOT rotated, do NOT
 * close this item on the strength of clean scans" — anchored to a standing fact
 * asserted with the ORDINARY 7-day default TTL. The fact lapsed silently on
 * 2026-07-20 while the exposure stood; a successor reading it after that date
 * would see "no fact" and could easily misread that as "resolved" — a critical
 * safety signal that decayed to the SAFE-LOOKING state with nobody told.
 *
 * `facts:assert { slot:'wall' }` (agent-tools/facts/assert.ts) is the write-side
 * half of the fix: it keys the fact under `wall:` and defaults its TTL to 90d
 * instead of 7d. This module is the READ-side backstop for when even that longer
 * window elapses without a re-assert or an explicit retract — TTL decay on a
 * wall must be LOUD, never silent. Same chassis as the sibling watchdogs
 * (rubric-staleness-watchdog.ts, release-deploy-staleness): a PURE alert
 * formatter (unit-tested with no DB), a thin PG sweep wired into the shared
 * routinesTick as one durable step, fail-soft throughout, and the shared
 * fires-ledger debounce (one page per wall per window, not one per tick).
 */
import { listLapsedWallFacts, type LapsedWallFact } from './agent-facts/store';
import { recentWatchdogFires, recordFire } from './pot/watchdog';
import { openEscalation } from './agent-tools/coordination/escalations';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** Re-page on the same still-lapsed wall at most once per this many hours. */
const WALL_LAPSE_DEBOUNCE_HOURS = 24;

/** Fallback installSlug for a wall fact not scoped to a concrete harness
 *  (workspace/role/owner/work_item scope) — matches the sibling watchdogs'
 *  own single-install default (this platform has one install today). */
const DEFAULT_INSTALL_SLUG = 'papercusp';

// ── pure formatter (unit-tested without DB) ─────────────────────────────────

/**
 * PURE: build the escalation summary + body for one lapsed wall fact. Kept
 * separate from the PG sweep so the wording is testable without a database.
 */
export function formatWallLapseAlert(
  fact: Pick<LapsedWallFact, 'scope' | 'scopeRef' | 'key' | 'body' | 'createdBy' | 'expiresAt'>,
  now: number,
): { summary: string; body: string } {
  const lapsedDays = Math.max(0, Math.round((now - Date.parse(fact.expiresAt)) / 86_400_000));
  const scopeLabel = fact.scopeRef ? `${fact.scope}:${fact.scopeRef}` : fact.scope;
  return {
    summary: `Owner-gated wall fact '${fact.key}' LAPSED ${lapsedDays}d ago, unretracted — its absence must NOT be read as resolved`,
    body:
      `[${scopeLabel}] ${fact.body}\n\n` +
      `This fact was asserted as a WALL (slot:'wall') — an owner-gated blocker — and its TTL expired ` +
      `${fact.expiresAt} without ever being explicitly retracted. TTL decay always fails toward "clear", ` +
      `which is the wrong direction for an unremediated risk: do NOT infer the underlying condition resolved ` +
      `just because this fact stopped folding into orients/briefs.\n\n` +
      `Either the condition is STILL LIVE — re-assert it (facts:assert { slot:'wall', key:'${fact.key}', body:'...' }, ` +
      `TTL defaults to 90d) — or it genuinely resolved, in which case retract it explicitly (facts:retract) rather ` +
      `than letting it time out. Originally asserted by ${fact.createdBy}.`,
  };
}

// ── the PG sweep ─────────────────────────────────────────────────────────────

export interface WallLapseSweepResult {
  key: string;
  outcome: 'alerted' | 'debounced' | 'error';
  reason: string;
}

/** Synthetic identity for the background lapse escalation (mirrors the
 *  sibling watchdogs' wedge/staleness identities). */
const WALL_LAPSE_IDENTITY: AgentIdentity = {
  ownerId: 'wall-lapse-watchdog',
  ownerLabel: 'system · wall-lapse-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Injectable seams so the sweep's orchestration is testable without PG. */
export interface WallLapseSweepDeps {
  listLapsedWallFacts?: typeof listLapsedWallFacts;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/**
 * The wall-lapse sweep: every unretracted, TTL-expired `wall:` fact fires one
 * debounced (24h) alert — a `pot_watchdog_fires` row (source 'wall-fact-lapse',
 * scoped by the fact's own key so N simultaneously-lapsed walls each page
 * independently, mirroring the rubric-staleness per-rubric fix) plus a coord
 * escalation naming the fact, how long it's been lapsed, and how to re-assert
 * or retract it. Fail-soft per fact AND overall — a watchdog that throws
 * guards nothing.
 */
export async function wallLapseSweep(deps: WallLapseSweepDeps = {}): Promise<WallLapseSweepResult[]> {
  const now = deps.now ?? Date.now();
  const results: WallLapseSweepResult[] = [];
  let facts: LapsedWallFact[];
  try {
    facts = await (deps.listLapsedWallFacts ?? listLapsedWallFacts)();
  } catch (e) {
    return [{ key: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) }];
  }
  for (const fact of facts) {
    try {
      const workspaceId = fact.workspaceId || 'default';
      const installSlug = fact.scope === 'harness' && fact.scopeRef ? fact.scopeRef : DEFAULT_INSTALL_SLUG;
      const firedRecently =
        (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
          workspaceId,
          installSlug,
          WALL_LAPSE_DEBOUNCE_HOURS,
          'wall-fact-lapse',
          fact.key,
        )) > 0;
      if (firedRecently) {
        results.push({ key: fact.key, outcome: 'debounced', reason: 'fires-ledger debounce' });
        continue;
      }
      const { summary, body } = formatWallLapseAlert(fact, now);
      console.warn(`[wall-fact-lapse] ALERT: ${summary}`);
      await (deps.recordFire ?? recordFire)({
        workspaceId,
        installSlug,
        source: 'wall-fact-lapse',
        reason: summary,
        wakeAt: null,
      });
      await (deps.openEscalation ?? openEscalation)(WALL_LAPSE_IDENTITY, {
        severity: 'blocker',
        summary,
        body,
      });
      results.push({ key: fact.key, outcome: 'alerted', reason: summary });
    } catch (e) {
      results.push({ key: fact.key, outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
