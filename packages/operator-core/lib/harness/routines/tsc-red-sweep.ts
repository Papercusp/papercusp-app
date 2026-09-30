/**
 * tsc-red-sweep.ts — the INTERPRETER for the new-file tsc reds that the baseline gate
 * observes on its hot path (EI-19342686127995790).
 *
 * THE GAP THIS CLOSES. `scripts/lib/tsc-baseline-gate.mjs` already computes a finding the
 * whole fleet cares about: a file the tsc baseline has never seen, whose errors are
 * COMMITTED (not a peer's dirty mid-edit), is a standing red that will red the shared
 * green-checkpoint for everyone. That finding was computed roughly 9 times an hour — every
 * agent's post-edit `lint:tsc` recomputes it — and recorded exactly ZERO times. It went to
 * stdout, in a block agents skim past on their way to the `TSC_EXIT=` line, and then
 * evaporated. Nothing accumulated it, so nothing could ever notice that one had been
 * standing for hours with nobody on it.
 *
 * WHY THIS IS NOT "FILE EVERY RED". The obvious remedy — capture the finding when the gate
 * computes it — is WRONG, and measuring the population is what showed it. On 2026-08-02 a
 * broadcast listed 5 committed non-baselined reds (14 errors); re-measured 15 minutes later,
 * 4 of the 5 were GONE and the fifth had shrunk 5 errors -> 1, entirely unaided. These reds
 * are DOMINATED by self-healing, because the overwhelmingly common case is an author still
 * actively working the file they just committed. Filing on first sight would have created 5
 * work-items that morning, 4 of which would have closed themselves unread — replacing a
 * silent-log problem with a backlog-noise problem, which is worse: noise trains agents to
 * ignore the very lane this is filed into.
 *
 * SO THE VALUABLE SUBSET IS NOT "RED" BUT "RED AND OWNERLESS" — a red that OUTLIVED its
 * author's attention. That is a question about time, and it is unanswerable from any single
 * gate run; it needs the observation history the hot path now appends. Hence the split:
 *
 *   hot path  (scripts/lib/tsc-red-observations.mjs, called by the gate)
 *             -> appendFileSync one line per standing red, every failure swallowed. The gate
 *                is shared infrastructure the whole fleet blocks on; it must never gain a
 *                call that can hang or change `TSC_EXIT`.
 *   this file (the routines tick, off the hot path)
 *             -> read the history, apply the DWELL decision, file the survivors.
 *
 * The redundancy that motivated the original filing ("~9 identical compiles/hour, squandered
 * compute") turns out to be the thing that makes this possible at all: it is a free
 * high-frequency sampler, and persistence is only measurable because of it.
 *
 * FAIL-SOFT BY CONTRACT, like every sibling sweep here. A missing store, a corrupt line, an
 * unavailable DB — each degrades to "file nothing this tick" and is reported in the return
 * value, never thrown. A sweep that can wedge the routines tick is worse than the silent log
 * it replaces.
 */
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { activeWorkspaceId } from '../../workspace-registry';
// Type-only: erased at runtime, so this does NOT eagerly pull capture-core (and its
// embedding/rubric dependency tree) into the routines tick. The real import stays lazy
// below. Typing the seam is what makes a wrong capture field a COMPILE error rather than
// a silently-ignored key at 3am — `improvements:capture` rejects undeclared args (EI-10883).
import type { CaptureImprovementInput } from '../improvements/capture-core';
import {
  readObservations,
  selectDwelledReds,
  pruneObservations,
  readRunHeartbeats,
  DWELL_SEC,
} from '../../../../../scripts/lib/tsc-red-observations.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// PURE matcher, shared with the gate's containment logic: longest-mount-wins, boundary-aware,
// and a path EQUAL to a gitlink is deliberately not "inside" it. Reused rather than re-derived
// so the ownership test and the gate agree on what "inside a submodule" means.
import { containingSubmodulePath } from '../../candidate-contains';
import {
  listIssues,
  setIssueState,
  commentIssue,
  findIssuesByWatchdogKeys,
  updateIssue,
  type EngineerIssue,
} from '../../issues-engineer';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { decideTscRedCleared, tscRedPathOf, type TscRedClearedDecision } from '../improvements/tsc-red-cleared-resolve';

/** One dwelled red, as the sweep resolved it. */
export interface TscRedSweepResult {
  file: string;
  outcome: 'filed' | 'escalated' | 'debounced' | 'capped' | 'error' | 'resolved' | 'skipped';
  /** How long the red was observed to persist, first sighting to last. */
  spanSec: number;
  sightings: number;
  reason: string;
}

/**
 * Bound the blast radius of one tick. `selectDwelledReds` returns longest-standing first, so
 * a cap takes the most-dwelled — the correct triage order — and defers the rest to the next
 * tick rather than dropping them (they are still in the store, still being observed).
 *
 * A tree with 20 simultaneously-dwelled reds is a fleet-wide event, not 20 independent bugs;
 * filing 20 items for it would be exactly the noise this sweep exists to avoid.
 */
export const MAX_FILES_PER_TICK = 5;

/** Per-path debounce window. Matches the house default used by every sibling sweep. */
export const DEBOUNCE_HOURS = 24;

/** A dwelled red as `selectDwelledReds` reports it (mirrors the .d.mts shape). */
export interface DwelledRed {
  file: string;
  firstSeen: number;
  lastSeen: number;
  sightings: number;
  spanSec: number;
  latestCount: number | null;
}

/** Stable per-path debounce identity. Embedded verbatim in the fire `reason` because
 *  `claimWatchdogFire` matches its scope key with `reason LIKE '%key%'`. */
export function debounceKeyFor(file: string): string {
  return `tsc-new-file-red::${file}`;
}

/**
 * A repeat observation is a DIFFERENT side effect from the first filing, so it needs its
 * own single-flight identity. Keeping the path in the key preserves per-file isolation;
 * keeping this distinct from {@link debounceKeyFor} prevents the original filing fire from
 * suppressing the escalation fire forever.
 */
export function repeatEscalationKeyFor(file: string): string {
  return `tsc-new-file-red-owner-escalation::${file}`;
}

/** Base retry window for the repeat escalation (the shared watchdog backoff still applies). */
export const REPEAT_ESCALATION_HOURS = 1;

/** Synthetic principal for the owner fallback when issue priority is unavailable. */
const TSC_RED_ESCALATION_IDENTITY: AgentIdentity = {
  ownerId: 'system:tsc-red-sweep',
  ownerLabel: 'system · tsc-red-sweep',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Only the fields the repeat-escalation decision reads. */
export type RepeatedUnownedTscRedIssue = Pick<
  EngineerIssue,
  'id' | 'title' | 'state' | 'assignee' | 'severity' | 'featureOrder' | 'updatedAt'
>;

export interface RepeatedUnownedTscRedResult {
  escalated: boolean;
  surfacedBy: 'priority' | 'owner-escalation' | null;
  reason: string;
}

export interface RepeatedUnownedTscRedDeps {
  updateIssueFn?: (id: string) => Promise<unknown>;
  bumpPriorityFn?: (
    id: string,
    position: 'top',
  ) => Promise<{ applicable: boolean; priority: number | null; proposed?: boolean } | null>;
  commentIssueFn?: (id: string, body: string) => Promise<unknown>;
  openEscalationFn?: (input: {
    severity: 'blocker';
    summary: string;
    body: string;
    meta: { subjectSignature: string };
  }) => Promise<unknown>;
}

/**
 * Make a repeatedly-observed, still-unowned standing red immediately actionable.
 *
 * Reuses the existing issue and the shared issue-claim ordering; it never creates a second
 * work-item and never auto-claims work nobody has begun. Critical severity makes the fleet-
 * wide gate impact explicit, while `bumpWorkItemPriority(..., 'top')` moves the item ahead of
 * ordinary unprioritized issue work. If issue priority is disabled/unavailable, the existing
 * coord escalation channel is the fallback — keyed stably per file so repeats coalesce.
 *
 * The caller re-reads the exact watchdog-key match after winning its single-flight claim.
 * This helper checks ownership again as a final cheap guard against acting on an assigned row.
 */
export async function escalateRepeatedUnownedTscRed(
  issue: RepeatedUnownedTscRedIssue,
  file: string,
  deps: RepeatedUnownedTscRedDeps = {},
): Promise<RepeatedUnownedTscRedResult> {
  if (issue.state !== 'open') {
    return { escalated: false, surfacedBy: null, reason: `${issue.id} is no longer open` };
  }
  if (issue.assignee) {
    return {
      escalated: false,
      surfacedBy: null,
      reason: `${issue.id} is owned by ${issue.assignee}`,
    };
  }
  if (issue.severity === 'critical' && issue.featureOrder != null) {
    return {
      escalated: false,
      surfacedBy: null,
      reason: `${issue.id} is already critical and prioritized`,
    };
  }

  const updateIssueFn =
    deps.updateIssueFn ?? ((id: string) => updateIssue(id, { severity: 'critical', by: 'system:tsc-red-sweep' }));
  const bumpPriorityFn =
    deps.bumpPriorityFn ??
    (async (id: string, position: 'top') => {
      const { bumpWorkItemPriority } = await import('../../work-items');
      return bumpWorkItemPriority(id, position);
    });
  const commentIssueFn =
    deps.commentIssueFn ?? ((id: string, body: string) => commentIssue(id, body, 'system:tsc-red-sweep'));
  const openEscalationFn =
    deps.openEscalationFn ??
    (async (input) => {
      const { openEscalation } = await import('../../agent-tools/coordination/escalations');
      return openEscalation(TSC_RED_ESCALATION_IDENTITY, input);
    });

  if (issue.severity !== 'critical') await updateIssueFn(issue.id);

  let priority: { applicable: boolean; priority: number | null; proposed?: boolean } | null = null;
  let priorityError: string | null = null;
  try {
    priority = await bumpPriorityFn(issue.id, 'top');
  } catch (e) {
    priorityError = e instanceof Error ? e.message : String(e);
  }
  const prioritySurfaced = Boolean(priority?.applicable && priority.priority != null && !priority.proposed);

  let surfacedBy: RepeatedUnownedTscRedResult['surfacedBy'] = 'priority';
  if (!prioritySurfaced) {
    surfacedBy = 'owner-escalation';
    await openEscalationFn({
      severity: 'blocker',
      summary: `Standing tsc red remains unowned: ${file} (${issue.id})`,
      body:
        `The standing-red sweep observed \`${file}\` again after filing ${issue.id}, and the ` +
        `issue is still OPEN and UNASSIGNED. Its severity was raised to critical. ` +
        `The shared issue-priority path could not surface it at the head of the claim queue` +
        `${priorityError ? ` (${priorityError})` : ''}, so this owner escalation is the ` +
        `fallback. Claim and fix ${issue.id}; this committed new-file red blocks the shared ` +
        `green-checkpoint promotion path.`,
      meta: { subjectSignature: repeatEscalationKeyFor(file) },
    });
  }

  await commentIssueFn(
    issue.id,
    `Repeated standing-red observation for \`${file}\`: severity raised to critical; ` +
      (surfacedBy === 'priority'
        ? 'moved to the head of the shared issue claim queue.'
        : 'shared issue priority was unavailable, so a coalesced blocker escalation was opened.'),
  );
  return {
    escalated: true,
    surfacedBy,
    reason:
      surfacedBy === 'priority'
        ? `${issue.id} raised to critical and moved to top issue priority`
        : `${issue.id} raised to critical and escalated to the owner`,
  };
}

interface RepeatedIssueSelection {
  issue: RepeatedUnownedTscRedIssue | null;
  reason: string;
}

/**
 * Select the newest open unassigned exact-key match, unless ANY open duplicate is assigned.
 * An assigned duplicate means the underlying condition is owned; escalating a second unassigned
 * duplicate would lie about that premise. `findIssuesByWatchdogKeys` is already newest-first,
 * but the explicit timestamp sort keeps the injectable seam honest in tests and future callers.
 */
function selectRepeatedUnownedIssue(issues: readonly RepeatedUnownedTscRedIssue[]): RepeatedIssueSelection {
  const open = issues.filter((issue) => issue.state === 'open');
  const owned = open.find((issue) => issue.assignee);
  if (owned) {
    return { issue: null, reason: `${owned.id} is owned by ${owned.assignee}` };
  }
  const issue = [...open]
    .filter((candidate) => !candidate.assignee)
    .sort((a, b) => {
      const aMs = Date.parse(a.updatedAt);
      const bMs = Date.parse(b.updatedAt);
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    })[0];
  return issue
    ? { issue, reason: `${issue.id} is the newest open unassigned exact-key match` }
    : { issue: null, reason: 'no open exact-key issue remains' };
}

/**
 * PURE: the two git probes that answer "is anyone ON this file right now?", spelled for the
 * repository the file actually lives in.
 *
 * EI-19468589610261889 — the superproject spelling is a FALSE-EMPTY for any path inside a
 * submodule, and this is not a cosmetic wrong answer: the superproject stores only a gitlink,
 * so `git status --porcelain` reports nothing and `git log -1 -- <path>` prints an empty
 * string for a file that may have been committed minutes ago. Both empties read as
 * reassurance — "nobody is editing it", "no recent commit, the author has moved on" — so the
 * guidance fails toward CLAIMING a file a peer is actively holding, which is the exact
 * collision the ownership test exists to prevent. Measured 2026-08-31: 7 of the 170 files in
 * the live tsc baseline sit inside 5 submodules (`libs/generic/sync`, `libs/generic/tooldef`,
 * `libs/papercusp`, `libs/test-config`, `libs/testing-shell`) — i.e. exactly the shared libs
 * where stomping a peer is most expensive.
 *
 * `submodulePaths` is a PARAMETER rather than a `.gitmodules` read so this stays pure and
 * unit-testable; `[]` restores the plain superproject spelling exactly, which is also the
 * fail-soft behaviour when discovery fails.
 *
 * NOT rewritten: `npm run lint:tsc -- --files=<submodule path>` is correct as-is. Measured
 * live 2026-08-31 — the gate AUTO-ROUTES it to the owning workspace's sibling gate
 * (`status=routed`, exit 0, `filesUnchecked=1` stamped honestly) rather than refusing it.
 */
export function ownershipTestLines(file: string, submodulePaths: readonly string[] = []): string[] {
  const sub = containingSubmodulePath([...submodulePaths], file);
  if (!sub) {
    return [
      `  git status --porcelain | grep ${file}   # dirty => someone is editing it RIGHT NOW`,
      `  git log -1 --format=%cI -- ${file}      # minutes old => author still has context`,
      `  npm run lint:tsc -- --files=${file}`,
    ];
  }
  const rel = file.slice(sub.length + 1);
  return [
    `  # ${file} is inside submodule '${sub}'. Ask its OWN repo: from the superproject both`,
    `  # probes below return EMPTY for every submodule file, which reads as "unowned" and is wrong.`,
    `  git -C ${sub} status --porcelain ${rel}   # dirty => someone is editing it RIGHT NOW`,
    `  git -C ${sub} log -1 --format=%cI -- ${rel}   # minutes old => author still has context`,
    `  npm run lint:tsc -- --files=${file}`,
  ];
}

/**
 * PURE: the capture payload for one dwelled red. Split out so the wording, the severity and
 * the dedup identity are all assertable without a database or a clock.
 *
 * `severity: 'major'` is deliberate and is the whole point of the item: this is not a
 * cosmetic type nit. A committed non-baselined red reds the SHARED green-checkpoint, so it
 * blocks every agent's promotion path, and by the time this sweep files it the red has
 * already outlived its author by DWELL_SEC — meaning nobody is on it.
 *
 * `submodulePaths` (default `[]`) selects the ownership-test spelling — see
 * `ownershipTestLines`.
 */
export function buildRedCapture(
  red: DwelledRed,
  submodulePaths: readonly string[] = [],
): {
  title: string;
  body: string;
  watchdogKey: string;
  paths: string[];
  evidenceAt: string;
} {
  const mins = Math.round(red.spanSec / 60);
  const count = red.latestCount == null ? 'unknown' : String(red.latestCount);
  return {
    title: `Standing tsc red with no owner: ${red.file} (${mins}min, ${count} errors)`,
    body:
      `\`${red.file}\` is a NEW file (the tsc baseline has never seen it) whose errors are ` +
      `COMMITTED — not a peer's uncommitted mid-edit — and it has now been observed red ` +
      `${red.sightings} times across ${mins} minutes without being fixed.\n\n` +
      `WHY THIS WAS FILED AND MOST REDS ARE NOT. Committed new-file reds are dominated by ` +
      `self-healing (measured 2026-08-02: 4 of 5 cleared unaided within ~15 minutes), so the ` +
      `sweep files only reds that OUTLIVE the ${Math.round(DWELL_SEC / 60)}-minute dwell ` +
      `threshold — i.e. ones whose author has most likely moved on. That makes this one ` +
      `unusual: it is very likely OWNERLESS rather than in progress.\n\n` +
      `IMPACT: a committed non-baselined red reds the shared green-checkpoint, so it blocks ` +
      `the whole fleet's promotion path, not just this file's author.\n\n` +
      `BEFORE CLAIMING IT, re-run the ownership test — the red may have been fixed between ` +
      `this filing and your reading it:\n` +
      `${ownershipTestLines(red.file, submodulePaths).join('\n')}\n\n` +
      `Observation window: first seen ${new Date(red.firstSeen * 1000).toISOString()}, ` +
      `last seen ${new Date(red.lastSeen * 1000).toISOString()}.`,
    watchdogKey: debounceKeyFor(red.file),
    paths: [red.file],
    evidenceAt: new Date(red.lastSeen * 1000).toISOString(),
  };
}

/** Injectable seams so the sweep is unit-testable without PG or the real store. */
export interface TscRedSweepDeps {
  nowMs?: number;
  path?: string;
  maxFiles?: number;
  readObservationsFn?: typeof readObservations;
  selectDwelledRedsFn?: typeof selectDwelledReds;
  pruneObservationsFn?: typeof pruneObservations;
  recentFiresFn?: typeof recentWatchdogFires;
  claimFireFn?: typeof claimWatchdogFire;
  /** Exact lookup of the issue created by the first filing. */
  findIssuesByWatchdogKeysFn?: (keys: string[]) => Promise<RepeatedUnownedTscRedIssue[]>;
  /** Execute the repeat-red escalation (injectable for a no-PG unit test). */
  escalateRepeatedUnownedTscRedFn?: (
    issue: RepeatedUnownedTscRedIssue,
    file: string,
  ) => Promise<RepeatedUnownedTscRedResult>;
  captureFn?: (input: CaptureImprovementInput) => Promise<unknown>;
  workspaceIdFn?: () => string;
  readRunHeartbeatsFn?: typeof readRunHeartbeats;
  /** Open watchdog-keyed issues to consider for retraction. */
  listOpenIssuesFn?: () => Promise<EngineerIssue[]>;
  /** Terminal resolve for one cleared red. */
  resolveIssueFn?: (id: string, decision: TscRedClearedDecision) => Promise<void>;
  /** Does this repo-relative path still exist? */
  fileExistsFn?: (file: string) => boolean;
  /** Post-sighting clean runs required (default TSC_RED_MIN_CLEAN_RUNS). */
  minCleanRuns?: number;
  /** Root the reported paths are relative to (default process.cwd()). */
  repoRoot?: string;
  /**
   * Declared submodule mount points, for spelling the ownership test in the repo that
   * actually holds the file (EI-19468589610261889). Default: read `.gitmodules` under
   * `repoRoot`. Fail-soft to `[]`, which restores the plain superproject spelling.
   */
  submodulePathsFn?: () => readonly string[];
}

/**
 * Declared submodule mounts from `.gitmodules`, sync + fail-soft.
 *
 * Sync on purpose: the only other filesystem read on this path (`fileExistsFn`) is sync too,
 * and the sweep must never gain a call that can hang — a missing, unreadable or malformed
 * `.gitmodules` yields `[]` and the ownership test simply keeps its superproject spelling.
 */
export function readDeclaredSubmodulePaths(repoRoot: string): string[] {
  try {
    return readFileSync(join(repoRoot, '.gitmodules'), 'utf8')
      .split('\n')
      .map((l) => /^\s*path\s*=\s*(.+?)\s*$/.exec(l)?.[1])
      .filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

/** The watchdog key a filed issue carries, or '' — mirrors auto-close.ts's accessor. */
function watchdogKeyOfIssue(i: EngineerIssue): string {
  const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
  return typeof p.watchdogKey === 'string' ? p.watchdogKey : '';
}

/**
 * When do we last KNOW this file was red?
 *
 * NOT from the observation store. That store has a 6h retention, and the items this exists
 * to retract are ~30h old — every observation that ever justified them has aged out, so a
 * store-only reading returns "no sighting" for exactly the population we care about and the
 * resolver would refuse forever while looking like it worked.
 *
 * The durable answer rides on the ITEM: `buildRedCapture` stamps `evidenceAt` with the last
 * sighting at filing time. Any FRESHER sighting still inside retention is layered on top by
 * the caller (max of the two), so a red that came back cannot be resolved by evidence that
 * predates its return. `updatedAt` is the fallback — later than the truth, which errs toward
 * refusing rather than resolving.
 */
function issueLastKnownRedSec(i: EngineerIssue): number | null {
  const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
  for (const cand of [p.evidenceAt, i.updatedAt]) {
    if (typeof cand !== 'string') continue;
    const ms = Date.parse(cand);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/**
 * Retract the standing-red items whose file is provably clean again.
 *
 * Fail-soft on every leg, like the filing pass: a store read error, an unreachable DB, or one
 * resolve failing degrades to "retract nothing this tick" and never throws into the routines
 * tick.
 */
export async function resolveClearedTscReds(deps: TscRedSweepDeps = {}): Promise<TscRedSweepResult[]> {
  const {
    nowMs = Date.now(),
    path,
    minCleanRuns,
    repoRoot = process.cwd(),
    readObservationsFn = readObservations,
    readRunHeartbeatsFn = readRunHeartbeats,
    fileExistsFn = (file: string) => existsSync(join(repoRoot, file)),
    listOpenIssuesFn = () => listIssues({ state: 'open', watchdogKeyed: true, limit: 500 }),
    resolveIssueFn = async (id: string, decision: TscRedClearedDecision) => {
      await commentIssue(
        id,
        `🟢 Auto-resolved on POSITIVE clean-run evidence: ${decision.completionRef}`,
        'tsc-red-cleared-resolve',
      );
      // NOT a dedup marker: the gate verifiably re-compiled this file and did not see the
      // red, so this is genuine, evidenced completion.
      await setIssueState(id, 'resolved', 'tsc-red-cleared-resolve', decision.completionRef!, {
        completionEvidence: decision.evidence,
      });
    },
  } = deps;

  const out: TscRedSweepResult[] = [];
  try {
    const heartbeats = readRunHeartbeatsFn(path ? { path, nowMs } : { nowMs });
    // No heartbeat inside retention means the sampler has not spoken at all. Every decision
    // below would refuse anyway; returning here makes that explicit and skips the DB read.
    if (heartbeats.length === 0) return out;

    const latestSightingByFile = new Map<string, number>();
    for (const o of readObservationsFn(path ? { path, nowMs, root: repoRoot } : { nowMs, root: repoRoot })) {
      latestSightingByFile.set(o.file, Math.max(latestSightingByFile.get(o.file) ?? 0, o.ts));
    }

    const open = await listOpenIssuesFn();
    for (const issue of open) {
      const watchdogKey = watchdogKeyOfIssue(issue);
      const file = tscRedPathOf(watchdogKey);
      if (!file) continue;
      try {
        const filedAt = issueLastKnownRedSec(issue);
        const fresh = latestSightingByFile.get(file) ?? 0;
        const lastSeenSec = Math.max(filedAt ?? 0, fresh) || null;
        const decision = decideTscRedCleared(
          watchdogKey,
          { lastSeenSec, heartbeats, fileExists: fileExistsFn(file) },
          { minCleanRuns },
        );
        if (!decision.resolve) continue;
        await resolveIssueFn(issue.id, decision);
        out.push({
          file,
          outcome: 'resolved',
          spanSec: 0,
          sightings: 0,
          reason: `${issue.id} ${decision.reason}`,
        });
      } catch (e) {
        out.push({
          file,
          outcome: 'error',
          spanSec: 0,
          sightings: 0,
          reason: `resolve failed for ${issue.id}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  } catch (e) {
    console.warn(`[tsc-red-sweep] resolve pass failed: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}

/**
 * Read the observation store, file the dwelled reds, prune what has aged out.
 *
 * The prune runs in a `finally` on purpose: retention is what BOUNDS the store, and a store
 * that only ever grows is a slow leak in a runtime dir. It must happen even on a tick where
 * the DB was unreachable and nothing could be filed.
 */
export async function tscRedSweep(deps: TscRedSweepDeps = {}): Promise<TscRedSweepResult[]> {
  const {
    nowMs = Date.now(),
    path,
    maxFiles = MAX_FILES_PER_TICK,
    readObservationsFn = readObservations,
    selectDwelledRedsFn = selectDwelledReds,
    pruneObservationsFn = pruneObservations,
    recentFiresFn = recentWatchdogFires,
    claimFireFn = claimWatchdogFire,
    findIssuesByWatchdogKeysFn = findIssuesByWatchdogKeys,
    escalateRepeatedUnownedTscRedFn = (issue, file) => escalateRepeatedUnownedTscRed(issue, file),
    captureFn,
    workspaceIdFn = activeWorkspaceId,
    repoRoot = process.cwd(),
    fileExistsFn = (file: string) => existsSync(join(repoRoot, file)),
    submodulePathsFn = () => readDeclaredSubmodulePaths(repoRoot),
  } = deps;

  const results: TscRedSweepResult[] = [];
  // Read once per tick, not per red: the mount set cannot change mid-sweep, and this keeps the
  // fail-soft `[]` a single decision rather than one per filed item.
  const submodulePaths = submodulePathsFn();
  try {
    const observations = readObservationsFn(path ? { path, nowMs, root: repoRoot } : { nowMs, root: repoRoot });
    const candidates: DwelledRed[] = selectDwelledRedsFn(observations, { nowMs });

    // THE FILING PRECONDITION (EI-21985631427355996). tsc cannot report an error for a file
    // that is not in the tree, so a dwelled path that does not exist here is not a red this
    // tree can have — it is an observation of some OTHER tree that reached this store, and
    // filing it manufactures a work-item nobody can ever act on. Measured: `lib/old-peer.ts`,
    // a fixture path from `lint-tsc.test.ts`, dwelled 172min and was filed as a major bug.
    //
    // NOT in tension with `decideTscRedCleared`, which deliberately REFUSES to resolve on a
    // vanished file ("ambiguous: deleted or renamed"). The polarities are duals and both are
    // right: CLOSING an item on absence is an absence argument about a red that may have
    // merely moved, while OPENING one demands positive evidence that there is something to
    // fix. A rename is handled correctly here too — the red is observed again at its new
    // path and files there, which is precisely why suppressing the stale path is safe.
    //
    // Placed BEFORE the cap on purpose: a phantom path sorts by dwell like any other, so
    // leaving it in the list lets it consume a MAX_FILES_PER_TICK slot and defer a real red.
    const dwelled: DwelledRed[] = [];
    for (const red of candidates) {
      if (fileExistsFn(red.file)) {
        dwelled.push(red);
        continue;
      }
      results.push({
        file: red.file,
        outcome: 'skipped',
        spanSec: red.spanSec,
        sightings: red.sightings,
        reason: 'path absent from this tree — an observation of another root, not a fileable red',
      });
    }
    if (dwelled.length === 0) return results;

    const workspaceId = workspaceIdFn();
    const source = 'tsc-new-file-red' as const;

    for (const [i, red] of dwelled.entries()) {
      if (i >= maxFiles) {
        results.push({
          file: red.file,
          outcome: 'capped',
          spanSec: red.spanSec,
          sightings: red.sightings,
          reason: `over MAX_FILES_PER_TICK (${maxFiles}) — deferred to the next tick`,
        });
        continue;
      }
      try {
        const installSlug = debounceKeyFor(red.file);
        if ((await recentFiresFn(workspaceId, installSlug, DEBOUNCE_HOURS, source)) > 0) {
          // A repeat is no longer a no-op: the original issue already exists, so use the
          // exact indexed key to find it and make that SAME row actionable. A lookup failure
          // remains fail-soft — never mint a second capture merely because the index was down.
          let matches: RepeatedUnownedTscRedIssue[];
          try {
            matches = await findIssuesByWatchdogKeysFn([debounceKeyFor(red.file)]);
          } catch (e) {
            results.push({
              file: red.file,
              outcome: 'error',
              spanSec: red.spanSec,
              sightings: red.sightings,
              reason: `repeat issue lookup failed: ${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
          }
          const selected = selectRepeatedUnownedIssue(matches);
          if (!selected.issue) {
            results.push({
              file: red.file,
              outcome: 'debounced',
              spanSec: red.spanSec,
              sightings: red.sightings,
              reason: selected.reason,
            });
            continue;
          }
          if (selected.issue.severity === 'critical' && selected.issue.featureOrder != null) {
            results.push({
              file: red.file,
              outcome: 'debounced',
              spanSec: red.spanSec,
              sightings: red.sightings,
              reason: `${selected.issue.id} is already critical and prioritized`,
            });
            continue;
          }
          const repeatScopeKey = repeatEscalationKeyFor(red.file);
          const repeatReason =
            `repeat standing tsc red remains unowned for ${red.file} (${selected.issue.id}); ` +
            `scope=${repeatScopeKey}`;
          const repeatClaimed = await claimFireFn({
            workspaceId,
            // Keep the original source/install dimensions, but add a distinct scope key so
            // the repeat side effect has its own hourly single-flight slot.
            installSlug,
            source,
            windowHours: REPEAT_ESCALATION_HOURS,
            scopeKey: repeatScopeKey,
            reason: repeatReason,
            wakeAt: null,
          });
          if (!repeatClaimed) {
            results.push({
              file: red.file,
              outcome: 'debounced',
              spanSec: red.spanSec,
              sightings: red.sightings,
              reason: `repeat escalation already claimed within ${REPEAT_ESCALATION_HOURS}h (raced or recent)`,
            });
            continue;
          }
          // The exact issue can be claimed or resolved between the cheap read and the
          // single-flight write. Re-read AFTER winning, then let the helper check ownership
          // once more; a lost race must fail toward doing nothing, never escalating owned work.
          let freshMatches: RepeatedUnownedTscRedIssue[];
          try {
            freshMatches = await findIssuesByWatchdogKeysFn([debounceKeyFor(red.file)]);
          } catch (e) {
            results.push({
              file: red.file,
              outcome: 'error',
              spanSec: red.spanSec,
              sightings: red.sightings,
              reason: `post-claim repeat issue lookup failed: ${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
          }
          const fresh = selectRepeatedUnownedIssue(freshMatches);
          if (!fresh.issue) {
            results.push({
              file: red.file,
              outcome: 'debounced',
              spanSec: red.spanSec,
              sightings: red.sightings,
              reason: `post-claim ownership recheck: ${fresh.reason}`,
            });
            continue;
          }
          const escalation = await escalateRepeatedUnownedTscRedFn(fresh.issue, red.file);
          if (!escalation.escalated) {
            results.push({
              file: red.file,
              outcome: 'debounced',
              spanSec: red.spanSec,
              sightings: red.sightings,
              reason: escalation.reason,
            });
            continue;
          }
          results.push({
            file: red.file,
            outcome: 'escalated',
            spanSec: red.spanSec,
            sightings: red.sightings,
            reason: escalation.reason,
          });
          continue;
        }
        const capture = buildRedCapture(red, submodulePaths);
        // Single-flight: atomically re-check + claim the debounce slot immediately before the
        // one-time side effect, so two overlapping ticks cannot both file (the EI-6777 fix
        // every sibling sweep carries).
        const claimed = await claimFireFn({
          workspaceId,
          installSlug,
          source,
          windowHours: DEBOUNCE_HOURS,
          reason: capture.watchdogKey,
          wakeAt: null,
        });
        if (!claimed) {
          results.push({
            file: red.file,
            outcome: 'debounced',
            spanSec: red.spanSec,
            sightings: red.sightings,
            reason: `filed within ${DEBOUNCE_HOURS}h (raced)`,
          });
          continue;
        }
        const capture_ = captureFn ?? (await import('../improvements/capture-core')).captureImprovement;
        await capture_({
          title: capture.title,
          kind: 'bug',
          severity: 'major',
          body: capture.body,
          paths: capture.paths,
          // A RESOLVED duplicate means the red came back — that is a regression worth
          // re-filing, so only an OPEN duplicate may decline this capture.
          dedupScope: 'open',
          // Exact indexed cross-tick dedup instead of a fuzzy title match, and it keeps a
          // DIFFERENT path's red from title-subsetting this one into a false duplicate.
          watchdogKey: capture.watchdogKey,
          evidenceAt: capture.evidenceAt,
          // Deliberately UNASSIGNED. The whole premise is that this red is ownerless; the
          // sweep is a sensor, and auto-claiming would put a machine's name on work no
          // machine is doing.
          sourceRole: 'system',
          foundDuring: 'tsc-red sweep (routines tick)',
          // Omit scope: a repo-wide gate concern, not one harness's — auto-homes to the
          // workspace platform Pot (capture-core.ts CaptureImprovementInput.scope).
        });
        results.push({
          file: red.file,
          outcome: 'filed',
          spanSec: red.spanSec,
          sightings: red.sightings,
          reason: `standing ${Math.round(red.spanSec / 60)}min across ${red.sightings} sightings`,
        });
      } catch (e) {
        results.push({
          file: red.file,
          outcome: 'error',
          spanSec: red.spanSec,
          sightings: red.sightings,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[tsc-red-sweep] sweep failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    try {
      pruneObservationsFn(path ? { path, nowMs } : { nowMs });
    } catch {
      // Retention is best-effort; a failed prune must not mask a successful filing.
    }
  }
  return results;
}
