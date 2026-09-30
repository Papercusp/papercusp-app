/**
 * keyless-ei-policy.ts — a triage/age policy for KEYLESS improvement items
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-014).
 *
 * THE GAP: an EI carries `payload.watchdogKey` ONLY when the watchdog filed it.
 * Manually-filed EIs (improvements:capture / issues:create) and any non-watchdog
 * item carry NO key — so they are STRUCTURALLY invisible to the three lifecycle
 * machines that all key off the watchdogKey:
 *   - dedup            (findIssuesByWatchdogKeys → `payload ? 'watchdogKey'`)
 *   - known-open aging (known-open-aging.ts derives runs from watchdog_ticks.known_open_keys)
 *   - auto-close       (auto-close.ts REQUIRES payload.watchdogKey, D-004)
 * A keyless EI therefore never dedups, never ages, never auto-closes — it just
 * accretes. At audit time 661 OPEN EIs were keyless, dominating the backlog
 * headline with un-managed entries.
 *
 * THE POLICY (P-014, D-decision in the plan): keyless EIs get an AGE + HUMAN-REVIEW
 * lane, NOT auto-close. A human filed them deliberately; their "evidence" is not a
 * windowed signal that disappears, so the P-009 auto-close (which closes when a key
 * stops firing) is the WRONG tool — closing them unread would lose real work. Instead:
 *   1. AGE-BAND every open keyless EI (fresh < 7d · aging 7–30d · stale ≥ 30d).
 *   2. Split the backlog headline into MANAGED (keyed) vs UN-MANAGED (keyless) so the
 *      headline number stops being dominated by the un-managed pile (the P-014 ask).
 *   3. Surface a periodic HUMAN-REVIEW digest of the stale + unassigned keyless EIs
 *      (improvements:keyless-digest) with a per-item disposition hint — claim it,
 *      close it if obsolete, or convert it to a keyed form if it is really a
 *      recurring signal (which then makes it eligible for dedup/aging/auto-close).
 *
 * Pure planner (`summarizeKeylessBacklog` / `planKeylessReview` / `keylessAgeBandOf`)
 * + a thin store read (`readOpenKeylessIssues`), mirroring the auto-close /
 * known-open-aging split so the policy is unit-testable without PG.
 */

import { getOrgPg } from '@papercusp/db-org';
import { ISSUE_KINDS, issuesScopeWorkspace, type IssueSeverity } from '../../issues-engineer';

// ── thresholds (tunable; mirror the known-open-aging const style) ──────────────

/** A keyless EI younger than this is FRESH — recently filed, no action yet. */
export const KEYLESS_AGING_MS = 7 * 24 * 3_600_000; // 7 days
/** A keyless EI older than this is STALE — the un-managed accretion the digest targets. */
export const KEYLESS_STALE_MS = 30 * 24 * 3_600_000; // 30 days
/** Default cap on the stale-review queue a digest returns (oldest-first). */
export const DEFAULT_KEYLESS_REVIEW_LIMIT = 30;

export type KeylessAgeBand = 'fresh' | 'aging' | 'stale';

/** Pure: which age band an open-for-`ageMs` keyless EI falls in. */
export function keylessAgeBandOf(
  ageMs: number,
  opts: { agingMs?: number; staleMs?: number } = {},
): KeylessAgeBand {
  const agingMs = opts.agingMs ?? KEYLESS_AGING_MS;
  const staleMs = opts.staleMs ?? KEYLESS_STALE_MS;
  if (ageMs >= staleMs) return 'stale';
  if (ageMs >= agingMs) return 'aging';
  return 'fresh';
}

// ── the row shape the policy operates on (a minimal projection) ────────────────

export interface KeylessIssueRow {
  id: string;
  title: string;
  severity: IssueSeverity;
  source: string;
  scope: string;
  assignee: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

// ── pure rollup + review planner ───────────────────────────────────────────────

export interface KeylessBacklogSummary {
  /** Total open keyless EIs (the un-managed backlog headline). */
  total: number;
  /** How many of `total` were sampled into `rows` (== total unless capped). */
  sampled: number;
  /** Age-band counts over the sample. */
  fresh: number;
  aging: number;
  stale: number;
  /** Stale (≥30d) AND unassigned — the genuinely-accreting, no-owner pile. */
  staleUnassigned: number;
  /** Aging-or-older (≥7d) AND unassigned — the un-owned pile the review digest
   *  surfaces NOW (staleUnassigned is 0 while the corpus is young). */
  agingUnassigned: number;
  /** Age of the oldest sampled keyless EI, in days (0 when none). */
  oldestDays: number;
  /** Counts by severity + source, so a noise concentration is visible. */
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
}

/**
 * Pure: roll a sampled set of open keyless EIs into the backlog headline split.
 * `total` is the true count (the store reports it independently of the sample cap).
 */
export function summarizeKeylessBacklog(
  rows: readonly KeylessIssueRow[],
  total: number,
  nowMs: number,
  opts: { agingMs?: number; staleMs?: number } = {},
): KeylessBacklogSummary {
  const bySeverity: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let fresh = 0;
  let aging = 0;
  let stale = 0;
  let staleUnassigned = 0;
  let agingUnassigned = 0;
  let oldestMs = nowMs;
  for (const r of rows) {
    const band = keylessAgeBandOf(nowMs - r.createdAtMs, opts);
    if (band === 'fresh') fresh++;
    else if (band === 'aging') aging++;
    else {
      stale++;
      if (!r.assignee) staleUnassigned++;
    }
    if (band !== 'fresh' && !r.assignee) agingUnassigned++;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    if (r.createdAtMs < oldestMs) oldestMs = r.createdAtMs;
  }
  return {
    total,
    sampled: rows.length,
    fresh,
    aging,
    stale,
    staleUnassigned,
    agingUnassigned,
    oldestDays: rows.length === 0 ? 0 : Math.floor((nowMs - oldestMs) / 86_400_000),
    bySeverity,
    bySource,
  };
}

/** A suggested disposition for one keyless EI surfaced for review. */
export type KeylessDisposition = 'claim-or-close' | 'follow-up-owner' | 'convert-to-keyed';

export interface KeylessReviewItem {
  id: string;
  title: string;
  severity: IssueSeverity;
  scope: string;
  source: string;
  assignee: string | null;
  ageDays: number;
  band: KeylessAgeBand;
  disposition: KeylessDisposition;
}

/**
 * Pure: the human-review queue — keyless EIs at or past the review FLOOR (the
 * un-managed accretion worth triaging), oldest-first, capped. Each carries a
 * disposition hint:
 *   - unassigned → 'claim-or-close'  (no owner; a human should claim or close it)
 *   - assigned    → 'follow-up-owner' (stale despite an owner — nudge or reassign)
 *
 * The floor DEFAULTS to the AGING threshold (7d), NOT stale (30d): validated against
 * live data the keyless corpus is young (weeks old) — a 30d floor leaves the queue
 * EMPTY while ~95 un-owned aging items accrete. Skipping only genuinely-fresh (<7d)
 * items surfaces the real pile now; truly-stale items rise to the top as they age
 * (the queue is oldest-first). Override `reviewFloorMs` to tune.
 */
export function planKeylessReview(
  rows: readonly KeylessIssueRow[],
  nowMs: number,
  opts: { agingMs?: number; staleMs?: number; limit?: number; reviewFloorMs?: number } = {},
): KeylessReviewItem[] {
  const reviewFloorMs = opts.reviewFloorMs ?? opts.agingMs ?? KEYLESS_AGING_MS;
  const limit = opts.limit ?? DEFAULT_KEYLESS_REVIEW_LIMIT;
  const out: KeylessReviewItem[] = [];
  for (const r of rows) {
    const ageMs = nowMs - r.createdAtMs;
    if (ageMs < reviewFloorMs) continue;
    const band = keylessAgeBandOf(ageMs, opts);
    const disposition: KeylessDisposition = r.assignee ? 'follow-up-owner' : 'claim-or-close';
    out.push({
      id: r.id,
      title: r.title,
      severity: r.severity,
      scope: r.scope,
      source: r.source,
      assignee: r.assignee,
      ageDays: Math.floor(ageMs / 86_400_000),
      band,
      disposition,
    });
  }
  // Oldest-first (most-accreted at the top of the review queue), capped.
  return out.sort((a, b) => b.ageDays - a.ageDays).slice(0, Math.max(0, limit));
}

// ── thin store read (PG) ───────────────────────────────────────────────────────

interface KeylessRowDb {
  issue_id: string;
  title: string;
  severity: string;
  source: string;
  scope: string;
  assignee: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toMs(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
}

export interface OpenKeylessIssues {
  /** True count of open keyless EIs (independent of the sample cap). */
  total: number;
  /** Up to `limit` rows, oldest-first. */
  rows: KeylessIssueRow[];
}

/**
 * Read open EIs that carry NO `payload.watchdogKey` — the un-managed backlog.
 * `coalesce(payload ? 'watchdogKey', false) = false` is NULL-payload-safe: an EI
 * with a NULL payload (the historical manual-capture shape) IS keyless and counts.
 * Scoped through `issuesScopeWorkspace()` exactly like listIssues, and restricted
 * to ISSUE_KINDS (bug|change) so delegated `task` rows never leak in.
 */
export async function readOpenKeylessIssues(limit = 500): Promise<OpenKeylessIssues> {
  const { sql } = getOrgPg();
  const ws = issuesScopeWorkspace();
  const kinds = ISSUE_KINDS as string[];
  const countRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${ws}
       AND kind = ANY(${kinds}::text[])
       AND state = 'open'
       AND NOT coalesce(payload ? 'watchdogKey', false)`;
  const total = Number(countRows[0]?.n ?? 0);
  const rows = await sql<KeylessRowDb[]>`
    SELECT issue_id, title, severity, source, scope, assignee, created_at, updated_at
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${ws}
       AND kind = ANY(${kinds}::text[])
       AND state = 'open'
       AND NOT coalesce(payload ? 'watchdogKey', false)
     ORDER BY created_at ASC
     LIMIT ${Math.max(1, Math.min(limit, 2000))}`;
  return {
    total,
    rows: rows.map((r) => ({
      id: r.issue_id,
      title: r.title,
      severity: r.severity as IssueSeverity,
      source: r.source,
      scope: r.scope,
      assignee: r.assignee,
      createdAtMs: toMs(r.created_at),
      updatedAtMs: toMs(r.updated_at),
    })),
  };
}

/** One-line policy statement, surfaced by the digest tool + the watchdog-status headline. */
export const KEYLESS_EI_POLICY =
  'Keyless EIs (no payload.watchdogKey — manual/non-watchdog) are AGE-BANDED and surfaced ' +
  'for HUMAN REVIEW, never auto-closed (no windowed evidence to clear). The review queue is ' +
  'aging-or-older (≥7d, default) + unassigned — the un-managed accretion: claim them, close ' +
  'them if obsolete, or convert a recurring one to a keyed form so it re-enters ' +
  'dedup/aging/auto-close.';
