/**
 * hygiene.ts — the backlog hygiene sweep
 * (learning-system-audit-improvements-2026-06-09 P-014).
 *
 * The capture side outruns the consume side (live: ~150 open, +105 in 3 days),
 * so the open queue accretes near-duplicates and stale minor noise that drown
 * the Learning tab and the triage pass. Two conservative, recallable actions:
 *
 *   - **dup-close** — within a likely-duplicate cluster of OPEN items (the same
 *     normalized-signature/Jaccard matcher dedup uses), keep ONE (highest
 *     severity, then newest) and close the rest with
 *     `decidedReason: 'duplicate of <kept>'`. The kept item carries the friction;
 *     the recall matcher surfaces the closure on any re-capture.
 *   - **age-out** — an OPEN, UNCLAIMED minor/nit item that has sat ≥ `staleDays`
 *     with a NON-recurring signature closes with a durable aged-out reason.
 *     Recurring signatures never age out (active friction), claimed items are
 *     in-flight, and major/critical severities are never auto-aged.
 *
 * Every close records `decidedReason` + advances `ideaLifecycle` through the
 * normal reject route, so hygiene is queue-as-memory, not deletion: a re-capture
 * of the same signature gets "already decided: <reason>" surfaced at capture.
 *
 * `planHygieneSweep` is pure; `runHygieneSweep` is thin PG glue (injectable
 * deps; `dryRun` plans without writing).
 *
 * ── There is deliberately NO observation retention here — do not re-add one
 * This file used to carry `planObservationRetention` / `runObservationRetention`
 * (turn-end-reflection-observations-2026-06-14 P-045), which HARD-DELETED
 * observation-lane rows that were both older than a 30d window and beyond a
 * ~1000-row cap. It was retired 2026-08-09 by owner directive — plan
 * `learning-loop-identity-and-consumption-2026-08-08` D-001, verbatim: "I dont
 * think we should have the 1k or 30 day limit. why would we ever want to throw out
 * observations?" — and D-005: observations are a TIME SERIES, never bulk-closed or
 * purged. The premise it rested on ("observations are disposable signals; Scout has
 * had its clustering window") is what the owner rejected.
 *
 * Two things a future reader should know before reaching for a bound again:
 *   - The cap never bound anything. Pruning required `beyondCap AND olderThanWindow`,
 *     and at fleet volume (~15k live rows) every ageing row is thousands of positions
 *     beyond a 1000-row cap, so the AND degenerated to a plain 30-day TTL.
 *   - It had destroyed nothing when it was removed (689 rows older than the window
 *     were still alive, measured), but it was ~30 minutes from its first permanent
 *     deletion — inert only because a coord-link partition swing hid the old rows
 *     from its scoped read. Inert is not safe; see D-029 for the full measurement.
 *
 * If a storage bound is ever genuinely needed it must be ARCHIVE/ROLLUP over rows
 * already marked CONSUMED (see `observation-consumption.ts`), never a DELETE, and
 * never over unconsumed rows. That is an owner-level decision, not a local one.
 */

import {
  setIssueState,
  commentIssue,
  mergeIssuePayload,
  type EngineerIssue,
} from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import type { ImprovementCandidate, ImprovementSeverity } from './policy';
import { readImprovementItems } from './read-items';
import { findLikelyDuplicates, signatureRecurrence, recurrenceGroupKey } from './digest';
import { initializeIdeaLifecycle, updateIdeaLifecycle } from './lifecycle';
import { trackDetached } from '../../detached-imports';

const DAY_MS = 24 * 60 * 60 * 1000;

const SEVERITY_RANK: Record<ImprovementSeverity, number> = { critical: 3, major: 2, minor: 1, nit: 0 };

export interface HygieneAction {
  id: string;
  kind: 'dup-close' | 'age-out';
  reason: string;
  /** For dup-close: the cluster member kept open. */
  keptId?: string;
}

export interface PlanHygieneOpts {
  nowMs?: number;
  /** Age (days) past which an unclaimed minor/nit item with a quiet signature ages out. */
  staleDays?: number;
  maxActions?: number;
}

export const DEFAULT_STALE_DAYS = 30;
export const DEFAULT_MAX_HYGIENE_ACTIONS = 25;

function ageDaysOf(c: ImprovementCandidate, nowMs: number): number {
  const created = c.createdAt ? Date.parse(c.createdAt) : NaN;
  return Number.isFinite(created) ? (nowMs - created) / DAY_MS : 0;
}

/** Pure planner. `all` should span all states (recurrence needs resolved history). */
export function planHygieneSweep(all: ImprovementCandidate[], opts: PlanHygieneOpts = {}): HygieneAction[] {
  const nowMs = opts.nowMs ?? Date.now();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const maxActions = opts.maxActions ?? DEFAULT_MAX_HYGIENE_ACTIONS;
  if (maxActions <= 0) return [];

  const open = all.filter((c) => (c.state ?? 'open') === 'open');
  const byId = new Map(open.map((c) => [c.id, c]));
  const actions: HygieneAction[] = [];
  const acted = new Set<string>();

  // 1. dup-close — clusters among OPEN items only (resolved members already left).
  // A destructive close needs MORE than Jaccard cluster membership (watchdog-audit
  // P-004: template titles — "Test failing repeatedly: <path>", "Tool <name>
  // erroring repeatedly" — token-collide across DISTINCT signals; the live dry-run
  // 2026-06-09 caught exactly 4 such false pairs). Mergeable sub-groups are:
  //   - same `watchdogKey` (the key asserts one signal identity), or
  //   - keyless items with EXACTLY equal normalized signatures (near-dup Jaccard
  //     alone is not enough to destroy a keyless item).
  // Keyed never merges with keyless, and different keys never merge.
  for (const cluster of findLikelyDuplicates(open)) {
    if (actions.length >= maxActions) break;
    const clusterMembers = cluster.ids.map((id) => byId.get(id)).filter((c): c is ImprovementCandidate => !!c);
    const groups = new Map<string, ImprovementCandidate[]>();
    for (const m of clusterMembers) {
      const groupKey = recurrenceGroupKey(m);
      const arr = groups.get(groupKey) ?? [];
      arr.push(m);
      groups.set(groupKey, arr);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const keep = [...members].sort((a, b) => {
        const sev = SEVERITY_RANK[b.severity ?? 'minor'] - SEVERITY_RANK[a.severity ?? 'minor'];
        if (sev !== 0) return sev;
        return Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0');
      })[0];
      for (const m of members) {
        if (actions.length >= maxActions) break;
        if (m.id === keep.id || acted.has(m.id)) continue;
        if (m.assignee) continue; // claimed = in-flight, never hygiene-close
        acted.add(m.id);
        actions.push({
          id: m.id,
          kind: 'dup-close',
          keptId: keep.id,
          reason: `duplicate of ${keep.id} (hygiene sweep) — the kept item carries this friction`,
        });
      }
    }
  }

  // 2. age-out — quiet, unclaimed, minor/nit, ≥ staleDays old.
  const recurringSigs = new Set(
    signatureRecurrence(all, { nowMs })
      .filter((s) => s.openCount > 1)
      .map((s) => s.signature),
  );
  for (const c of open) {
    if (actions.length >= maxActions) break;
    if (acted.has(c.id)) continue;
    const sev = c.severity ?? 'minor';
    if (sev !== 'minor' && sev !== 'nit') continue;
    if (c.assignee) continue;
    const age = ageDaysOf(c, nowMs);
    if (age < staleDays) continue;
    // Must use the SAME key `signatureRecurrence` emitted above — both are plain
    // strings, so looking this up by the bare title signature typechecks cleanly
    // while silently matching nothing, aging out exactly the recurring rows this
    // guard exists to protect.
    if (recurringSigs.has(recurrenceGroupKey(c))) continue; // active friction never ages out
    acted.add(c.id);
    actions.push({
      id: c.id,
      kind: 'age-out',
      reason: `aged out by the hygiene sweep: ${sev} severity, no recurrence pressure in ${Math.round(age)} days — re-capture if it bites again`,
    });
  }

  return actions;
}

export interface HygieneSweepResult {
  scanned: number;
  planned: HygieneAction[];
  dupClosed: number;
  agedOut: number;
  dryRun: boolean;
  /**
   * Actions whose underlying write silently no-op'd (WI-7034): either
   * `mergeIssuePayload` or `setIssueState` returned null — most commonly a
   * remote-origin row (EI-7833/migration 521's INSTEAD OF trigger skip-guard on the
   * `engineer_issues` compat view refuses a local UPDATE) or the row vanished mid-sweep.
   * These are NOT counted in `dupClosed`/`agedOut` and get NO "duplicate of …" /
   * "aged out …" comment — see the block comment above `runHygieneSweep` for why a
   * comment must never be posted for a write that didn't actually take.
   */
  failed: { id: string; reason: string }[];
}

/** Injectable dependency seam (unit tests run without PG). */
export interface HygieneSweepDeps {
  /**
   * `staleCutoffIso` (WI-39455): the age-out cutoff (`now - staleDays`), so the read
   * can select the stale tail as a SQL SET instead of hoping it falls inside the
   * newest-first recency window — it never does once the open backlog outgrows the
   * read cap (measured: 423 age-eligible rows, every one below the newest-2000
   * window of a 5,345-row backlog, so the sweep planned zero actions forever).
   * An injected fake may ignore the argument.
   */
  readItems: (opts?: { staleCutoffIso?: string }) => Promise<ImprovementCandidate[]>;
  setIssueState: (
    id: string,
    state: 'open' | 'resolved' | 'closed',
    by?: string,
    completionRef?: string,
    opts?: { skipCompletionGate?: boolean },
  ) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  mergeIssuePayload: (id: string, patch: Record<string, unknown>) => Promise<EngineerIssue | null>;
}

const defaultDeps: HygieneSweepDeps = {
  // P-008: same as the decay sweep — hygiene reads lifecycle fields only, never
  // `candidate.body` (the `body` above is commentIssue's WRITE param), so it takes
  // the body-less projection. See ListIssuesFilter.includeBody for the measurements.
  //
  // Two slices (WI-39455). The recency window alone CANNOT reach the age-out
  // population: it is newest-first + capped, and the stale tail by definition sits at
  // the old end. The second read selects `createdBefore: staleCutoffIso` open rows as
  // a SQL set. Recurrence semantics survive the split: a recurring signature has
  // RECENT siblings by definition, so the newest window carries exactly the history
  // `signatureRecurrence` needs to protect a recurring old row from aging out.
  readItems: async (opts) => {
    const recent = await readImprovementItems({ includeBody: false });
    if (!opts?.staleCutoffIso) return recent;
    const stale = await readImprovementItems({
      includeBody: false,
      state: 'open',
      createdBefore: opts.staleCutoffIso,
      limit: 2000,
    });
    const seen = new Set(recent.map((c) => c.id));
    return recent.concat(stale.filter((c) => !seen.has(c.id)));
  },
  setIssueState,
  commentIssue,
  mergeIssuePayload,
};

export async function runHygieneSweep(
  opts: PlanHygieneOpts & { dryRun?: boolean } = {},
  deps: HygieneSweepDeps = defaultDeps,
): Promise<HygieneSweepResult> {
  const staleCutoffIso = new Date(
    (opts.nowMs ?? Date.now()) - (opts.staleDays ?? DEFAULT_STALE_DAYS) * DAY_MS,
  ).toISOString();
  const all = await deps.readItems({ staleCutoffIso });
  const byId = new Map(all.map((c) => [c.id, c]));
  const planned = planHygieneSweep(all, opts);
  const result: HygieneSweepResult = {
    scanned: all.length,
    planned,
    dupClosed: 0,
    agedOut: 0,
    dryRun: opts.dryRun === true,
    failed: [],
  };
  if (opts.dryRun) return result;

  for (const a of planned) {
    const current = byId.get(a.id)?.ideaLifecycle ?? initializeIdeaLifecycle();
    // Hygiene closes ride the normal reject route through the state machine —
    // triaged(reject) + decidedReason + closed — so recall works identically.
    const lifecycle =
      current.state === 'open' || current.state === 'recurred' || current.state === 'triaged'
        ? updateIdeaLifecycle(current, 'triaged', { triageDecision: 'reject', triageReason: a.reason })
        : current;
    const merged = await deps.mergeIssuePayload(a.id, { ideaLifecycle: lifecycle, decidedReason: a.reason });
    // skipCompletionGate (WI-1403/WI-1404, contract C-1): an automated hygiene sweep
    // closing a duplicate/aged-out idea is a housekeeping dedup, not a genuine
    // completion — no principal did the work, so it must not satisfy C-1.
    const closedIssue = await deps.setIssueState(a.id, 'closed', 'improvement-hygiene', undefined, {
      skipCompletionGate: true,
    });
    // WI-7034: both writes go through the `engineer_issues` compat view,
    // whose INSTEAD OF trigger silently no-ops (returns null) an UPDATE against a
    // remote-origin row (EI-7833/migration 521) or a row that vanished mid-sweep.
    // `commentIssue` writes a DIFFERENT table (coord_thread_posts) unguarded by that
    // trigger, so posting it unconditionally — as this loop used to — left a
    // "duplicate of X (hygiene sweep)" comment on an item that was in fact NEVER
    // closed: state stayed 'open', decidedReason/ideaLifecycle never updated, and it
    // kept re-dispatching + getting re-claimed by agents for days (34-item chain,
    // observed live 2026-08-02, EI-18290228499378268 and 3 siblings stuck 11+ days).
    // Only report success — and only post the comment — when the row was actually
    // mutated locally.
    if (!merged || !closedIssue) {
      result.failed.push({
        id: a.id,
        reason: !merged && !closedIssue ? 'no-op-write' : !merged ? 'merge-no-op' : 'set-state-no-op',
      });
      continue;
    }
    await deps.commentIssue(a.id, `🧹 ${a.reason}`, 'improvement-hygiene');
    if (a.kind === 'dup-close') result.dupClosed += 1;
    else result.agedOut += 1;
  }

  if (planned.length > 0) {
    void trackDetached(import('../../sync-sse'))
      .then((m) => Promise.all([
        m.notifySyncInvalidate('learning.improvements'),
        m.notifySyncInvalidate('learning.improvements.summary'),
      ]))
      .catch(() => {});
    // Push-on-write for the Health tab's improvements panel
    // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007) —
    // same lazy fire-and-forget discipline as the invalidate above.
    void trackDetached(import('../../system-health/compute'))
      .then((m) => m.refreshHealthPanel('improvements'))
      .catch(() => {});
  }
  return result;
}
