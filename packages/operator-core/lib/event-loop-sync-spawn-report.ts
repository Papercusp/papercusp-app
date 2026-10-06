/**
 * event-loop-sync-spawn-report.ts — WI-10005253 (runtime half of WI-10005242).
 *
 * When the event-loop sentinel profiles a stalled main thread and a hot stack sits inside a
 * synchronous child-process call, the sentinel worker posts a `sync-spawn-stall` message naming
 * the producer (event-loop-stall-profile.ts `syncSpawnProducer`). This module runs on the MAIN
 * thread, so it receives that message only once the loop has turned again. It files ONE work item
 * per producer.
 *
 * WHY. The build-time ratchet (lib/__tests__/main-thread-sync-spawn.test.ts) only scans
 * lib/agent-tools/** and lib/release/**. A sync spawn reached through a helper anywhere else was
 * found only by an agent reading 'STALL profiled' journal lines by hand, which is how
 * WI-10005193 (release:cut) and WI-10005223 (repair-queue admission) were found. This makes the
 * profile file the finding itself.
 *
 * DEDUPE, three layers so a producer that stalls every few minutes files once:
 *   1. an in-process cooldown per producer (24 h),
 *   2. an in-flight guard so overlapping stalls do not race two captures,
 *   3. a lookup of any NON-TERMINAL row already carrying the same watchdogKey.
 * Known limit: two host processes (:3070 cluster workers, :3170, bg-host) each run their own
 * reporter, so a producer that stalls several at once can still race into two rows.
 *
 * Template: agent-tools/tool-weight-selfcheck.ts (open-row lookup + captureImprovement with a
 * stable title, sourceRole 'system', dedupScope 'open').
 */
import type { CaptureImprovementInput } from './harness/improvements/capture-core';
import type { SyncSpawnProducer } from './event-loop-stall-profile';

/** The worker → main message. Kept flat and structured-clone safe. */
export interface SyncSpawnStallMessage extends SyncSpawnProducer {
  kind: 'sync-spawn-stall';
  pid: number;
  /** The `.cpuprofile` the sentinel wrote for this stall. */
  file: string;
  stalenessAtStartMs: number;
  mainThreadActivity: string;
}

export function isSyncSpawnStallMessage(m: unknown): m is SyncSpawnStallMessage {
  if (!m || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return (
    r.kind === 'sync-spawn-stall' &&
    typeof r.producer === 'string' &&
    typeof r.producerFn === 'string' &&
    r.producerFn.length > 0 &&
    typeof r.stack === 'string' &&
    typeof r.pct === 'number'
  );
}

export const SYNC_SPAWN_REPORT_COOLDOWN_MS = 24 * 60 * 60_000;

export function syncSpawnWatchdogKey(producerFn: string): string {
  return `event-loop-sync-spawn:${producerFn}`;
}

export type SyncSpawnReportOutcome = 'filed' | 'open-exists' | 'cooldown' | 'in-flight' | 'failed';

export interface SyncSpawnReportDeps {
  /** True when a non-terminal work item already carries this watchdogKey. */
  hasOpenRow: (watchdogKey: string) => Promise<boolean>;
  capture: (input: CaptureImprovementInput) => Promise<unknown>;
  now: () => number;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'dropped', 'resolved', 'closed']);

export const defaultSyncSpawnReportDeps: SyncSpawnReportDeps = {
  // Lazy: the sentinel host loads at boot and must not pull the issues/capture stack in with it.
  hasOpenRow: async (watchdogKey) => {
    const { findIssuesByWatchdogKeys } = await import('./issues-engineer');
    const rows = await findIssuesByWatchdogKeys([watchdogKey]);
    return rows.some((r) => !TERMINAL_STATES.has(String(r.state)));
  },
  capture: async (input) => {
    const { captureImprovement } = await import('./harness/improvements/capture-core');
    return captureImprovement(input);
  },
  now: () => Date.now(),
};

/** The capture input for one stall. The title is stable per producer so repeats coalesce. */
export function syncSpawnCaptureInput(m: SyncSpawnStallMessage, atMs: number): CaptureImprovementInput {
  return {
    title: `Synchronous child-process call blocked the operator event loop: ${m.producerFn}`,
    kind: 'bug',
    severity: 'major',
    scope: 'operator',
    foundDuring: 'event-loop-sentinel stall profile (WI-10005253)',
    findingClass: 'event-loop-sync-spawn',
    createdBy: 'system:event-loop-sentinel',
    sourceRole: 'system',
    source: 'su',
    dedupScope: 'open',
    watchdogKey: syncSpawnWatchdogKey(m.producerFn),
    evidenceAt: new Date(atMs).toISOString(),
    body:
      `The event-loop sentinel profiled a stalled operator main thread (pid ${m.pid}, ` +
      `${m.mainThreadActivity}, stale ${m.stalenessAtStartMs} ms when capture started). ` +
      `${m.pct}% of samples sat in a synchronous child-process call made by **${m.producer}**.\n\n` +
      `Hot stack (leaf first): \`${m.stack}\`\n\nProfile: \`${m.file}\`\n\n` +
      `A sync spawn on the main thread freezes every MCP session on the host until the child ` +
      `exits; a long one trips the sentinel's WEDGED SIGKILL. Fix: execFile + await (the ` +
      `runFileAsync pattern in agent-tools/release/cut.ts) or move the work onto a worker ` +
      `(release/admission-offthread.ts). If the producer lives under lib/agent-tools or ` +
      `lib/release, lower its entry in lib/__tests__/main-thread-sync-spawn.test.ts once fixed.`,
  };
}

/** One reporter per process: holds the cooldown and in-flight state across stalls. */
export function createSyncSpawnStallReporter(
  deps: SyncSpawnReportDeps = defaultSyncSpawnReportDeps,
): (m: SyncSpawnStallMessage) => Promise<SyncSpawnReportOutcome> {
  const lastFiledAt = new Map<string, number>();
  const inFlight = new Set<string>();
  return async (m) => {
    const key = syncSpawnWatchdogKey(m.producerFn);
    const t = deps.now();
    const last = lastFiledAt.get(key);
    if (last != null && t - last < SYNC_SPAWN_REPORT_COOLDOWN_MS) return 'cooldown';
    if (inFlight.has(key)) return 'in-flight';
    inFlight.add(key);
    try {
      if (await deps.hasOpenRow(key)) {
        lastFiledAt.set(key, t);
        return 'open-exists';
      }
      await deps.capture(syncSpawnCaptureInput(m, t));
      lastFiledAt.set(key, t);
      return 'filed';
    } catch {
      // No cooldown on failure: the next stall from this producer retries.
      return 'failed';
    } finally {
      inFlight.delete(key);
    }
  };
}
