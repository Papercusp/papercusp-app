/**
 * Watchdog AUTO-CLOSE lifecycle (watchdog-and-exposed-systems-improvement-2026-06-18
 * P-009 / D-002). The watchdog escalates a long-open EI (known-open-aging) but never
 * RETIRES one whose underlying problem has CLEARED — so the backlog only grows (the
 * 2026-06-17 audit found 51 red-test EIs with 0 live reds, plus benchmark debris and
 * stopped-recurring tool errors all sitting open). This sweep closes a watchdog-sourced
 * EI once its signal has been ABSENT from the recent ran-ticks' known-open keys for
 * `minAbsentTicks` consecutive ticks — i.e. the signal stopped firing, so the problem
 * is gone. If it recurs, the watchdog simply re-files it (search-first dedup).
 *
 * SAFETY: auto-closing real improvement items is dangerous, so the decision is heavily
 * guarded (open + watchdog-keyed + organic + no LIVE in-flight dispatch + eligible
 * source + old enough + enough tick history) AND the whole sweep is gated by
 * `FLAGS.WATCHDOG_AUTO_CLOSE` — an owner-authority flag that DEFAULTS OFF (in DARK_FLAGS
 * per EI-7230: auto-closing without owner review is unsafe). The sweep runs only while the
 * flag is enabled (a workspace override in operator_flag_overrides, PostHog, or
 * /admin/features) and reverts to escalate-only when it is off. Do NOT assume the default
 * here reflects the live value — resolve `getFlag` (below) for the actual state.
 * NOTE (EI-7317): a bare `assignee` does NOT block retirement on its own — only a live
 * `in-flight-dispatch` row means someone is genuinely still working it. An assignee left
 * over from a resolved/abandoned dispatch is not active work; see decideAutoClose.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import {
  listIssues,
  setIssueState,
  commentIssue,
  type EngineerIssue,
} from '../../issues-engineer';
import { watchdogSourceOf } from './policy';
import { WATCHDOG_AUTO_CLOSE_OWNER } from './capture-core';
import { effectiveOrigin, DEFAULT_SIGNAL_ORIGIN } from './provenance';
import {
  decideRedTestGreenResolve,
  redTestPathOf,
  RED_TEST_GREEN_WINDOW_HOURS,
  type RedTestRun,
} from './red-test-green-resolve';
import {
  decideToolFailurePositiveRepair,
  toolFailureRepairEvidenceOf,
  type ToolFailureRepairEvidence,
} from './tool-error-positive-resolve';
import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

/**
 * Sources where a signal's ABSENCE reliably means the problem resolved.
 *
 * MOVED to the leaf module `./auto-close-sources` (EI-20106946822538304) so the issue-family
 * self-select CLAIM floor can share the one definition — `work-items.ts` cannot import THIS
 * file (`work-items.ts -> auto-close.ts -> issues-engineer.ts -> work-items.ts` is a cycle).
 * Re-exported here so this module's public API is unchanged; the allowlist's full rationale
 * (including why 'red-test' is deliberately absent) lives with the constant.
 *
 * The two halves must never disagree: this set decides which items auto-close CLOSES on a
 * quiet tick, and the same set decides which items the claim floor withholds while they are
 * still inside that recovery window. Forking it would let an agent claim an item the sweep is
 * about to retire — the very defect the floor was added to fix.
 */
// Imported AND re-exported: a bare `export { X } from '...'` re-export does NOT bind X in this
// module's scope, and `decideAutoClose` below uses it directly (the membership test that decides
// whether a quiet tick may close an item). Keep both lines together.
import {
  AUTO_CLOSE_DEFAULT_MIN_TICKS,
  AUTO_CLOSE_ELIGIBLE_SOURCES,
} from './auto-close-sources';
export { AUTO_CLOSE_DEFAULT_MIN_TICKS, AUTO_CLOSE_ELIGIBLE_SOURCES };

/**
 * WI-10005102: sources with a SOURCE-LEVEL closing route, which is what the census read
 * (`listOpen`) selects on. That is the absence-close allowlist PLUS 'red-test'. 'red-test' is
 * deliberately absent from AUTO_CLOSE_ELIGIBLE_SOURCES (a quiet tick must never close it), but
 * the positive green-run resolution below still needs to see it. Positive tool-failure
 * repair is the row-level route selected by `ListIssuesFilter.watchdogCloseRoutes`.
 * Watchdog-key duplicate closing is intentionally absent: work_items_watchdog_identity_uq
 * already forbids duplicate open rows with an exact harness/key/origin/lane identity.
 */
export const AUTO_CLOSE_CENSUS_SOURCES: readonly string[] = [...AUTO_CLOSE_ELIGIBLE_SOURCES, 'red-test'];

/**
 * Row cap on the census read. The SQL route filter is what keeps the census small; this cap
 * only bounds the transfer, and `listOpen` reports loudly when it is reached. It is the
 * listIssues ceiling (ISSUES_MAX_LIMIT), the largest legal value.
 */
export const AUTO_CLOSE_CENSUS_LIMIT = 2000;

/** The minimal shape the pure decision needs (an EngineerIssue maps onto it). */
export interface AutoCloseCandidate {
  issueId: string;
  /** payload.watchdogKey (`<source>:<key>`). */
  watchdogKey: string;
  /** Stable lifecycle identity persisted under payload.toolFailureProbation. */
  classKey?: string;
  /** Contract identity persisted under payload.toolFailureProbation. */
  contractFingerprint?: string;
  /** Serving revision persisted under payload.toolFailureProbation. */
  deployedRevision?: string;
  state: string;
  assignee: string | null;
  /** ms epoch of created_at. */
  createdAtMs: number;
  /** provenance (organic | drill | replay | shadow). */
  signalOrigin: string;
  /** An open, unresolved dispatch ledger row exists for this item. */
  inFlightDispatch: boolean;
}

/** The recent-tick context the decision reads against. */
export interface AutoCloseTickContext {
  /** Union of `known_open_keys` across the last `ranTickCount` ran-ticks (the
   *  "still-firing" set). A key absent from this set was absent from ALL of them. */
  seenKeys: ReadonlySet<string>;
  /** How many ran-ticks the window held (must be ≥ minAbsentTicks to act). */
  ranTickCount: number;
  /**
   * (WI-40769) Per-source count of ticks IN THIS WINDOW where the source's
   * collector declared itself UNOBSERVED (`CollectorStatus.observed === false`):
   * it skipped, or it threw. Those ticks are not absence evidence — the
   * condition was never evaluated — so `decideAutoClose` subtracts them.
   *
   * This is what makes a source whose collector CAN go blind safe to
   * absence-close: instead of excluding the source forever, the sweep simply
   * waits until enough ticks exist where the collector actually looked. Absent
   * / empty map ⇒ every tick observed (the pre-WI-40769 assumption, which is
   * correct for every collector that never declares itself blind).
   */
  unobservedTicksBySource?: ReadonlyMap<string, number>;
  nowMs: number;
}

export interface AutoCloseOptions {
  /** Consecutive ran-ticks a signal must be absent before its EI auto-closes. Default 6 (~90min). */
  minAbsentTicks?: number;
  /** An EI younger than this never auto-closes (its signal may not have hit known-open yet). Default 90min. */
  minIssueAgeMs?: number;
  /**
   * P-007: consecutive proven-green runs required to auto-resolve a `red-test` EI on
   * POSITIVE evidence (before the absence path considers it). Default
   * RED_TEST_GREEN_MIN_CONSECUTIVE (3). See red-test-green-resolve.ts.
   */
  redTestGreenMinConsecutive?: number;
  /** P-007: lookback hours for the green-run read. Default RED_TEST_GREEN_WINDOW_HOURS (24). */
  redTestGreenWindowHours?: number;
}

export const AUTO_CLOSE_DEFAULT_MIN_AGE_MS = 90 * 60_000;

export interface AutoCloseDecision {
  close: boolean;
  reason: string;
}

/**
 * Pure: should this candidate auto-close? Returns `{close:false, reason}` for every
 * guard so the decision is fully observable + unit-tested. Closes ONLY when the
 * signal has verifiably stopped firing and the item is safe to retire untouched.
 */
export function decideAutoClose(
  c: AutoCloseCandidate,
  ctx: AutoCloseTickContext,
  opts: AutoCloseOptions = {},
): AutoCloseDecision {
  const minTicks = opts.minAbsentTicks ?? AUTO_CLOSE_DEFAULT_MIN_TICKS;
  const minAge = opts.minIssueAgeMs ?? AUTO_CLOSE_DEFAULT_MIN_AGE_MS;
  if (c.state !== 'open') return { close: false, reason: 'not-open' };
  if (!c.watchdogKey) return { close: false, reason: 'no-watchdog-key' };
  if (effectiveOrigin(c.signalOrigin) !== DEFAULT_SIGNAL_ORIGIN) return { close: false, reason: 'non-organic' };
  if (!AUTO_CLOSE_ELIGIBLE_SOURCES.has(watchdogSourceOf(c.watchdogKey))) {
    return { close: false, reason: 'ineligible-source' };
  }
  // EI-7317: an `assignee` alone must NOT block retirement — only a LIVE in-flight
  // dispatch means genuinely active work. Once a dispatch resolves (or a watchdog
  // routine it was chasing is deactivated/deleted) the `assignee` column is never
  // cleared, so a signal that has verifiably stopped firing was staying open+assigned
  // forever and getting re-dispatched indefinitely (concrete case: EI-3901 — the
  // underlying loop was deactivated 2026-07-01, but the EI re-dispatched on
  // 2026-07-04, burning a full worker run to rediscover the bug was already gone).
  // inFlightDispatch is the only signal that means "do not touch, someone is on it".
  if (c.inFlightDispatch) return { close: false, reason: 'in-flight-dispatch' };
  if (ctx.ranTickCount < minTicks) return { close: false, reason: 'insufficient-tick-history' };
  // WI-40769: discount ticks where THIS source's collector observed nothing (it
  // skipped, or it threw). A ran-tick proves the WATCHDOG ran, not that this
  // particular collector evaluated its predicate — and silence from a collector
  // that never looked is not evidence that the condition cleared. Counted per
  // source so one blind collector cannot excuse another's absence.
  const unobserved = ctx.unobservedTicksBySource?.get(watchdogSourceOf(c.watchdogKey)) ?? 0;
  if (ctx.ranTickCount - unobserved < minTicks) {
    return { close: false, reason: 'insufficient-observed-tick-history' };
  }
  if (!Number.isFinite(c.createdAtMs) || ctx.nowMs - c.createdAtMs < minAge) {
    return { close: false, reason: 'too-new' };
  }
  if (ctx.seenKeys.has(c.watchdogKey)) return { close: false, reason: 'still-firing' };
  const abandonedAssignmentNote = c.assignee != null ? ' (assignee present but no live in-flight dispatch — abandoned assignment, not active work)' : '';
  return {
    close: true,
    reason: `signal absent from known-open keys for ≥${minTicks} ran-ticks — evidence cleared${abandonedAssignmentNote}`,
  };
}

export interface AutoCloseOutcome {
  issueId: string;
  watchdogKey: string;
  reason: string;
}

type Sql = ReturnType<typeof getOrgPg>['sql'];

export interface AutoCloseDeps {
  listOpen: () => Promise<EngineerIssue[]>;
  recentRanTickKeys: (
    n: number,
  ) => Promise<{
    seenKeys: Set<string>;
    ranTickCount: number;
    /** (WI-40769) Per-source blind-tick counts in the same window. Optional so
     *  existing test injections keep compiling (absent ⇒ all ticks observed). */
    unobservedTicksBySource?: Map<string, number>;
  }>;
  inFlightDispatchIds: (ids: string[]) => Promise<Set<string>>;
  close: (id: string, watchdogKey: string, reason: string) => Promise<void>;
  nowMs: () => number;
  /**
   * P-007 (optional): recent test_runs, LATEST-FIRST, keyed by NORMALIZED repo-relative
   * path, for the given red-test paths. When BOTH this and `resolveGreen` are present the
   * green-evidence pass runs; when either is absent it is skipped (existing absence-only
   * behavior — so pre-P-007 test injections are unchanged).
   */
  recentRedTestRuns?: (paths: string[], windowHours: number) => Promise<Map<string, RedTestRun[]>>;
  /** P-007 (optional): resolve a red-test EI WITH genuine green-run completion evidence. */
  resolveGreen?: (
    id: string,
    watchdogKey: string,
    completionRef: string,
    evidence: CompletionVerificationEvidence,
  ) => Promise<void>;
  /** Read durable per-class repair evidence for repeated-tool-error rows. */
  readToolFailureRepairEvidence?: (
    issues: EngineerIssue[],
  ) => Promise<Map<string, ToolFailureRepairEvidence>>;
  /** Resolve a repeated-tool-error row with real positive completion evidence. */
  resolveToolFailureRepair?: (
    id: string,
    watchdogKey: string,
    completionRef: string,
    evidence: CompletionVerificationEvidence,
  ) => Promise<void>;
}

const watchdogKeyOfIssue = (i: EngineerIssue): string => {
  const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
  return typeof p.watchdogKey === 'string' ? p.watchdogKey : '';
};

function toolFailureRepairFieldsOf(issue: EngineerIssue): {
  classKey?: string;
  contractFingerprint?: string;
  deployedRevision?: string;
} {
  const payload = issue.payload && typeof issue.payload === 'object' && !Array.isArray(issue.payload)
    ? (issue.payload as Record<string, unknown>)
    : {};
  const probation = payload.toolFailureProbation && typeof payload.toolFailureProbation === 'object' && !Array.isArray(payload.toolFailureProbation)
    ? (payload.toolFailureProbation as Record<string, unknown>)
    : {};
  return {
    ...(typeof probation.classKey === 'string' ? { classKey: probation.classKey } : {}),
    ...(typeof probation.contractFingerprint === 'string' ? { contractFingerprint: probation.contractFingerprint } : {}),
    ...(typeof probation.deployedRevision === 'string' ? { deployedRevision: probation.deployedRevision } : {}),
  };
}

/** Default deps: the real PG-backed reads + close. */
export function defaultAutoCloseDeps(workspaceId: string): AutoCloseDeps {
  const { sql }: { sql: Sql } = getOrgPg();
  return {
    // WI-4532: `watchdogKeyed: true` filters in SQL. It is load-bearing for CORRECTNESS,
    // not speed — this read is ORDER BY created_at DESC LIMIT 500, and the JS
    // `open.filter(watchdogKeyOfIssue)` below it therefore used to see only the watchdog
    // items among the 500 NEWEST open issues. Measured 2026-08-04: 17,154 open bug|change
    // issues => a ~7.5 HOUR visibility horizon. A watchdog item that went green after
    // falling out of that window could never be auto-resolved, so the sweep could raise an
    // alarm but not lower it (EI-18691336095110558 sat open 9 days with 46 passing runs on
    // its named test). With the filter the read returns the ~59 watchdog-keyed rows and the
    // limit stops binding. Do NOT "fix" a recurrence by raising the limit: ISSUES_MAX_LIMIT
    // is 2000 < 17,154, so the cap cannot cover the backlog and the horizon returns.
    //
    // WI-10005102: the same horizon came back one level down. By 2026-10-01 there were
    // 11,598 open watchdog-keyed rows (9,615 repeated-tool-error), so this read again saw
    // only the newest ~12 h. `watchdogCloseRoutes` narrows it, in SQL, to rows some route
    // below can close (521 of 11,598 that day). `body` is dropped because nothing in this
    // sweep reads it. If the read ever fills its limit the census is a window again, so
    // that is reported instead of being silently treated as the full set.
    listOpen: async () => {
      const rows = await listIssues({
        state: 'open',
        watchdogKeyed: true,
        watchdogCloseRoutes: { closableSources: AUTO_CLOSE_CENSUS_SOURCES },
        includeBody: false,
        limit: AUTO_CLOSE_CENSUS_LIMIT,
      });
      if (rows.length >= AUTO_CLOSE_CENSUS_LIMIT) {
        console.warn(
          `[watchdog-auto-close] census read SATURATED at ${AUTO_CLOSE_CENSUS_LIMIT} rows: ` +
            'older closable watchdog items are invisible to this tick (WI-10005102 horizon class)',
        );
      }
      return rows;
    },
    recentRanTickKeys: async (n: number) => {
      // WI-40769: `collectors` comes back alongside the keys so a BLIND tick is
      // distinguishable from a QUIET one. It is the existing jsonb column — no
      // migration — and pre-WI-40769 rows simply carry no `observed` field,
      // which reads as observed:true and preserves the old behaviour exactly.
      const rows = await sql<{ known_open_keys: string[]; collectors: unknown }[]>`
        SELECT known_open_keys, collectors
          FROM harness_shared.watchdog_ticks
         WHERE workspace_id = ${workspaceId} AND status = 'ran'
         ORDER BY tick_at DESC
         LIMIT ${n}`;
      const seenKeys = new Set<string>();
      const unobservedTicksBySource = new Map<string, number>();
      for (const r of rows) {
        for (const k of r.known_open_keys ?? []) seenKeys.add(k);
        // Count each source at most ONCE per tick: a source with several
        // collectors must not subtract more than the one tick it lost.
        const blindHere = new Set<string>();
        for (const c of Array.isArray(r.collectors) ? r.collectors : []) {
          if (!c || typeof c !== 'object') continue;
          const st = c as { observed?: unknown; unobservedSource?: unknown };
          if (st.observed !== false) continue;
          if (typeof st.unobservedSource !== 'string' || !st.unobservedSource) continue;
          blindHere.add(st.unobservedSource);
        }
        for (const s of blindHere) unobservedTicksBySource.set(s, (unobservedTicksBySource.get(s) ?? 0) + 1);
      }
      return { seenKeys, ranTickCount: rows.length, unobservedTicksBySource };
    },
    inFlightDispatchIds: async (ids: string[]) => {
      if (ids.length === 0) return new Set();
      const rows = await sql<{ item_id: string }[]>`
        SELECT DISTINCT item_id
          FROM harness_shared.improvement_dispatches
         WHERE item_id = ANY(${ids}::text[]) AND resolved_at IS NULL`;
      return new Set(rows.map((r) => r.item_id));
    },
    close: async (id, watchdogKey, reason) => {
      await commentIssue(
        id,
        `🟢 Auto-resolved by the watchdog: ${reason}. Signal \`${watchdogKey}\` stopped firing — no fix was dispatched; the underlying condition cleared on its own. If the exact signal recurs, the recurrence REOPENS this row (P-004 exact-key recurrence reopen) rather than filing a sibling. (P-009)`,
        WATCHDOG_AUTO_CLOSE_OWNER,
      );
      // skipCompletionGate (WI-1403/WI-1404, contract C-1): the watchdog auto-close is a
      // DEDUP marker, not a genuine completion — "no fix was dispatched; the underlying
      // condition cleared on its own" is explicitly NOT evidence of completed work, so
      // this flip must never satisfy C-1's genuine-completion criteria.
      // P-004: the `by` identity below lands in terminalOwner — capture-core's
      // exact-key recurrence reopen matches on exactly this value, so the promise
      // in the comment above is mechanically kept.
      await setIssueState(id, 'resolved', WATCHDOG_AUTO_CLOSE_OWNER, undefined, { skipCompletionGate: true });
    },
    // P-007: recent test_runs for red-test paths, LATEST-FIRST, keyed by the SAME
    // normalized repo-relative path the red-test collector keys its signal on
    // (normalizeRedTestPath's regex, inlined in SQL) so green-evidence matches the fail
    // signal's identity across sibling checkouts. Box-global (no workspace_id predicate),
    // DELIBERATELY mirroring collectRedTestSignals — the collector raises the signal
    // box-global, so the reader that lowers it must read the same set or the two disagree.
    recentRedTestRuns: async (paths, windowHours) => {
      const byPath = new Map<string, RedTestRun[]>();
      if (paths.length === 0) return byPath;
      const rows = await sql<{ npath: string; status: string; started_at: Date | string; commit_sha: string | null }[]>`
        WITH ranked AS (
          SELECT regexp_replace(file_path, '^.*papercupai-workspace/[^/]+/', '') AS npath,
                 status, started_at, commit_sha,
                 row_number() OVER (
                   PARTITION BY regexp_replace(file_path, '^.*papercupai-workspace/[^/]+/', '')
                   ORDER BY started_at DESC
                 ) AS rn
            FROM harness_shared.test_runs
           WHERE started_at > now() - make_interval(hours => ${windowHours})
             AND status IN ('pass', 'fail', 'error')
             AND source <> 'mutation-probe'
             AND file_path LIKE '%/%'
        )
        SELECT npath, status, started_at, commit_sha
          FROM ranked
         WHERE npath = ANY(${paths}::text[]) AND rn <= 10
         ORDER BY npath, rn`;
      for (const r of rows) {
        const list = byPath.get(r.npath) ?? [];
        const ms = r.started_at instanceof Date ? r.started_at.getTime() : Date.parse(String(r.started_at));
        list.push({ status: r.status, startedAtMs: ms, commitSha: r.commit_sha });
        byPath.set(r.npath, list);
      }
      return byPath; // already LATEST-FIRST per path (ordered by rn)
    },
    resolveGreen: async (id, _watchdogKey, completionRef, evidence) => {
      await commentIssue(
        id,
        `🟢 Auto-resolved on POSITIVE green-run evidence: ${completionRef} (P-007)`,
        'watchdog-green-resolve',
      );
      // NOT skipCompletionGate: unlike the absence-based close, this IS a genuine,
      // evidenced completion — the named test verifiably passes now (N consecutive greens
      // recorded in test_runs), attached as terminal completion evidence.
      await setIssueState(id, 'resolved', 'watchdog-green-resolve', completionRef, { completionEvidence: evidence });
    },
    // Positive repeated-tool-error evidence is already durable on the issue payload.
    // Keep the reader injectable so tests cannot accidentally query live PG, while the
    // default path consumes exactly the persisted per-class record.
    readToolFailureRepairEvidence: async (issues) => {
      const byId = new Map<string, ToolFailureRepairEvidence>();
      for (const issue of issues) {
        const evidence = toolFailureRepairEvidenceOf(issue.payload);
        if (evidence) byId.set(issue.id, evidence);
      }
      return byId;
    },
    resolveToolFailureRepair: async (id, _watchdogKey, completionRef, evidence) => {
      await commentIssue(
        id,
        `🟢 Auto-resolved on POSITIVE repeated-tool-error repair evidence: ${completionRef}. ` +
          `The exact class was verified; this is not an absence-only close (EI-22438587556370022).`,
        'watchdog-tool-error-resolve',
      );
      await setIssueState(id, 'resolved', 'watchdog-tool-error-resolve', completionRef, { completionEvidence: evidence });
    },
    nowMs: () => Date.now(),
  };
}

/**
 * IO: the auto-close sweep for one tick. DEFAULT-OFF flag-gated — returns [] until the
 * owner enables `papercusp-watchdog-auto-close`. Reads open watchdog-keyed EIs, the
 * recent ran-tick known-open keys, and the in-flight dispatch set; closes each EI the
 * pure decision admits.
 */
export async function processAutoClose(
  workspaceId: string,
  opts: AutoCloseOptions = {},
  deps?: AutoCloseDeps,
): Promise<AutoCloseOutcome[]> {
  if (!(await getFlag(FLAGS.WATCHDOG_AUTO_CLOSE, `watchdog-auto-close:${workspaceId}`))) return [];
  const d = deps ?? defaultAutoCloseDeps(workspaceId);
  const minTicks = opts.minAbsentTicks ?? AUTO_CLOSE_DEFAULT_MIN_TICKS;

  const open = await d.listOpen();
  // Pre-filter to watchdog-keyed candidates before the (cheaper) tick + dispatch reads.
  const keyed = open.filter((i) => watchdogKeyOfIssue(i));
  if (keyed.length === 0) return [];
  const out: AutoCloseOutcome[] = [];

  const inFlight = await d.inFlightDispatchIds(keyed.map((i) => i.id));

  // ── P-007: POSITIVE green-run resolution ────────────────────────────────────────────
  // Runs BEFORE (and independent of) the absence path, and does NOT need ran-tick history:
  // it resolves a red-test EI whose named test verifiably passes NOW (N consecutive greens
  // in test_runs), attaching that as real completion evidence. A green-resolved item is
  // then skipped by the absence loop below.
  const greenResolved = await resolveProvenGreenRedTests(keyed, inFlight, d, opts, out);

  // ── Positive repeated-tool-error repair resolution ──────────────────────────────────
  // Unlike the absence path, this path needs no quiet-tick history: an exact class/key
  // contract change or passing probe is affirmative evidence that the rejected call was
  // repaired. The source remains absent from AUTO_CLOSE_ELIGIBLE_SOURCES, so this is the
  // only route by which repeated-tool-error can close.
  const toolFailureResolved = await resolveProvenToolFailureRepairs(keyed, inFlight, d, out);

  // ── Absence-based close (needs enough ran-tick history) ────────────────────────────
  const { seenKeys, ranTickCount, unobservedTicksBySource } = await d.recentRanTickKeys(minTicks);
  if (ranTickCount >= minTicks) {
    const nowMs = d.nowMs();
    for (const i of keyed) {
      if (greenResolved.has(i.id) || toolFailureResolved.has(i.id)) continue; // already resolved positively
      const watchdogKey = watchdogKeyOfIssue(i);
      const candidate: AutoCloseCandidate = {
        issueId: i.id,
        watchdogKey,
        ...toolFailureRepairFieldsOf(i),
        state: i.state,
        assignee: i.assignee,
        createdAtMs: i.createdAt ? Date.parse(i.createdAt) : NaN,
        signalOrigin: i.signalOrigin ?? DEFAULT_SIGNAL_ORIGIN,
        inFlightDispatch: inFlight.has(i.id),
      };
      const decision = decideAutoClose(
        candidate,
        { seenKeys, ranTickCount, unobservedTicksBySource, nowMs },
        opts,
      );
      if (!decision.close) continue;
      try {
        await d.close(i.id, watchdogKey, decision.reason);
        out.push({ issueId: i.id, watchdogKey, reason: decision.reason });
      } catch (e) {
        // Best-effort: one close failing must not abort the sweep.
        console.warn(`[watchdog-auto-close] close failed for ${i.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }
  if (out.length > 0) {
    console.log(`[watchdog-auto-close] retired ${out.length} watchdog EI(s): ${out.map((o) => o.issueId).join(', ')}`);
  }
  return out;
}

/**
 * P-007: resolve each red-test EI whose named test is PROVEN green (N consecutive passing
 * runs) with the green run as real completion evidence, BEFORE the absence path. Returns
 * the set of issue ids it resolved (the absence loop skips them). Fully fail-soft: a
 * test_runs read error, or one resolve failing, never aborts the sweep. A no-op (returns
 * an empty set) when the green deps are not injected (pre-P-007 test call sites).
 */
async function resolveProvenGreenRedTests(
  canonical: EngineerIssue[],
  inFlight: Set<string>,
  d: AutoCloseDeps,
  opts: AutoCloseOptions,
  out: AutoCloseOutcome[],
): Promise<Set<string>> {
  const resolved = new Set<string>();
  if (!d.recentRedTestRuns || !d.resolveGreen) return resolved;
  const redTestItems = canonical.filter(
    (i) => redTestPathOf(watchdogKeyOfIssue(i)) != null && !inFlight.has(i.id),
  );
  if (redTestItems.length === 0) return resolved;
  const windowHours = opts.redTestGreenWindowHours ?? RED_TEST_GREEN_WINDOW_HOURS;
  const paths = [...new Set(redTestItems.map((i) => redTestPathOf(watchdogKeyOfIssue(i))!))];
  let runsByPath: Map<string, RedTestRun[]>;
  try {
    runsByPath = await d.recentRedTestRuns(paths, windowHours);
  } catch (e) {
    // Fail-soft: no green resolution this tick; the absence path still runs.
    console.warn(`[watchdog-green-resolve] test_runs read failed:`, e instanceof Error ? e.message : e);
    return resolved;
  }
  for (const i of redTestItems) {
    const watchdogKey = watchdogKeyOfIssue(i);
    const path = redTestPathOf(watchdogKey)!;
    const decision = decideRedTestGreenResolve(watchdogKey, runsByPath.get(path) ?? [], {
      minConsecutiveGreens: opts.redTestGreenMinConsecutive,
    });
    if (!decision.resolve) continue;
    try {
      await d.resolveGreen(i.id, watchdogKey, decision.completionRef!, decision.evidence!);
      resolved.add(i.id);
      out.push({ issueId: i.id, watchdogKey, reason: decision.reason });
    } catch (e) {
      console.warn(`[watchdog-green-resolve] resolve failed for ${i.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return resolved;
}

/**
 * Resolve repeated-tool-error EIs only on affirmative evidence for their exact
 * persisted class. This is deliberately injectable: tests and callers can supply the
 * durable evidence reader, while the default dependency reads the nested payload record.
 */
async function resolveProvenToolFailureRepairs(
  canonical: EngineerIssue[],
  inFlight: Set<string>,
  d: AutoCloseDeps,
  out: AutoCloseOutcome[],
): Promise<Set<string>> {
  const resolved = new Set<string>();
  if (!d.readToolFailureRepairEvidence || !d.resolveToolFailureRepair) return resolved;

  const candidates = canonical.filter((i) =>
    watchdogKeyOfIssue(i).startsWith('repeated-tool-error:') && !inFlight.has(i.id),
  );
  if (candidates.length === 0) return resolved;

  let evidenceByIssue: Map<string, ToolFailureRepairEvidence>;
  try {
    evidenceByIssue = await d.readToolFailureRepairEvidence(candidates);
  } catch (e) {
    // A failed evidence read is not positive evidence. Keep the item open and let the
    // rest of this sweep continue; repeated-tool-error is also excluded from absence close.
    console.warn(
      '[watchdog-tool-error-resolve] repair-evidence read failed:',
      e instanceof Error ? e.message : e,
    );
    return resolved;
  }

  for (const i of candidates) {
    const watchdogKey = watchdogKeyOfIssue(i);
    const fields = toolFailureRepairFieldsOf(i);
    const decision = decideToolFailurePositiveRepair(
      {
        watchdogKey,
        ...fields,
      },
      evidenceByIssue.get(i.id),
    );
    if (!decision.resolve) continue;
    try {
      await d.resolveToolFailureRepair(i.id, watchdogKey, decision.completionRef!, decision.evidence!);
      resolved.add(i.id);
      out.push({ issueId: i.id, watchdogKey, reason: decision.reason });
    } catch (e) {
      // Best-effort: one positive resolution failing must not abort other candidates.
      console.warn(
        `[watchdog-tool-error-resolve] resolve failed for ${i.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return resolved;
}
