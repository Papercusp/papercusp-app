/**
 * cold-boot-drill-autorunner (cold-with-carry-activation-2026-07-20, owner-directed A2)
 * — the BOOTSTRAP for P-021 cold-by-default.
 *
 * P-021's classDefaultColdForWake only colds a session class the drill ledger PROVES
 * sufficient (reportColdBootDrills().sufficientClasses), but P-020 drills were opt-in
 * and never run at scale, AND the manually-run drills were graded under class strings
 * ('gateway-claude-headless', 'claude-su') the live classifier sessionClassForHost
 * NEVER emits — it only emits 'claude-headless' / 'claude-interactive'. So NO live-wake
 * class was ever proven and cold-by-default stayed inert for the entire headless fleet
 * (EI-18133456688790756).
 *
 * This watchdog closes that bootstrap gap. Each pass, flag-gated
 * (COLD_BOOT_DRILL_AUTORUNNER, default ON):
 *   1. GRADE — server-side grades any of its prior drills that RESPAWNED but were
 *      never graded (gradeColdBootDrill reads the successor transcript; the drilled
 *      session need not self-grade). This is what actually FEEDS sufficientClasses.
 *   2. START — if a target live-wake class is still not proven (and has no drill in
 *      flight, and hasn't exhausted its give-up budget), starts ONE cold-boot drill on
 *      an eligible headless carry-respawn-capable host, passing NO explicit sessionClass
 *      so startColdBootDrill defaults it from sessionClassForHost — guaranteeing the
 *      grade lands under the live-wake vocabulary (the A1 class-normalization fix).
 *
 * SAFETY (why auto-cutting a live session is acceptable here):
 *   - TARGET IS HEADLESS ONLY. We never auto-drill an interactive/human session
 *     (D-005 never-cold-a-human); AUTO_DRILL_CLASSES = ['claude-headless']. A headless
 *     loop is cold-resilient BY DESIGN (and, post-B, cold by default anyway), so cutting
 *     one costs ~nothing — it does what it would do on its next cold wake.
 *   - The cut is the same clean-boundary carry-respawn the compaction watchdog already
 *     fires routinely: startColdBootDrill crosses the flush gate + refuses over an open
 *     owner message, and the host busy-gate defers the actual cut until the session is
 *     at-prompt (never mid-turn — D-006).
 *   - BOUNDED BLAST RADIUS: at most ONE drill started per pass; never a second while one
 *     is in flight for the class; and STOP once the class is proven (minDrills=1 ⇒ one
 *     good drill is usually enough) or after MAX_DRILLS_BEFORE_GIVEUP graded-but-still-
 *     insufficient drills (a genuine "carry insufficient" signal the report surfaces —
 *     not a reason to keep cutting sessions forever).
 *   - `managedSetInterval` (never a bare setInterval) — visible in schedule:inventory,
 *     category 'watchdog', like its system-health siblings.
 *
 * Pure sweep (runColdBootDrillAutorunOnce) with injected deps for tests; the boot start
 * (startColdBootDrillAutorunner) wires the real ledger/report/host/drill functions.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  readColdBootDrillLedger,
  reportColdBootDrills,
  startColdBootDrill,
  gradeColdBootDrill,
  type ColdBootDrillLedgerEvent,
  type ColdBootDrillReport,
  type StartColdBootDrillResult,
  type GradeColdBootDrillResult,
} from '../cold-boot-drill-live';
import {
  listLiveHosts,
  hostSupports,
  sessionClassForHost,
  type PsuPtyHost,
} from '../events/await/psu-pty-discovery';

/** Invasive (it cuts a live session), so a relaxed cadence. One drill/pass, and it
 *  stops entirely once the class is proven, so this mainly sets how fast the FIRST
 *  proof lands after boot. */
export const COLD_BOOT_DRILL_AUTORUN_INTERVAL_MS = 15 * 60_000; // 15 min

/** The ONLY classes the autorunner will auto-drill. Deliberately headless-only:
 *  auto-cutting an interactive/human-present session is forbidden (D-005). The
 *  headless class is also the population that most needs cold-by-default (long-running
 *  unattended loops) — the exact gap EI-18133456688790756 identified. */
export const AUTO_DRILL_CLASSES: readonly string[] = ['claude-headless'];

/** Max drills to GRADE per pass — bounds the fs/transcript work each tick. */
const MAX_GRADES_PER_PASS = 5;

/** If a class has this many GRADED drills and STILL isn't sufficient, stop
 *  auto-drilling it: the carry is genuinely insufficient (a real signal the report
 *  surfaces), not something more session-cuts will fix. */
export const MAX_DRILLS_BEFORE_GIVEUP = 3;

export interface ColdBootDrillAutorunDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  report: () => Promise<ColdBootDrillReport>;
  listHosts: () => PsuPtyHost[];
  startDrill: (input: {
    ownerId: string;
    ownerLabel: string;
    workspaceId?: string | null;
    sessionClass?: string;
  }) => Promise<StartColdBootDrillResult>;
  gradeDrill: (ownerId: string, drillId: string) => Promise<GradeColdBootDrillResult>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.COLD_BOOT_DRILL_AUTORUNNER, 'system');
  } catch {
    // Flag infra unavailable (early boot / tests) — do NOT auto-cut sessions.
    return false;
  }
}

function autorunDeps(overrides: Partial<ColdBootDrillAutorunDeps>): ColdBootDrillAutorunDeps {
  return {
    readLedger: readColdBootDrillLedger,
    report: () => reportColdBootDrills(),
    listHosts: () => listLiveHosts(),
    startDrill: (input) =>
      // NO explicit sessionClass ⇒ startColdBootDrill defaults it from
      // sessionClassForHost(host) — the A1 class-vocabulary fix.
      startColdBootDrill({
        ownerId: input.ownerId,
        ownerLabel: input.ownerLabel,
        workspaceId: input.workspaceId ?? undefined,
        sessionClass: input.sessionClass,
      }),
    gradeDrill: (ownerId, drillId) => gradeColdBootDrill(ownerId, drillId),
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    ...overrides,
  };
}

const RESPAWNED_KINDS: ReadonlySet<string> = new Set(['carry-drill-respawned']);
const GRADED_KIND = 'carry-drill-graded';
/** Terminal kinds that END a drill's lifecycle (besides graded) — a drill that
 *  dropped / failed / was request-failed is not a grade candidate. */
const DEAD_KINDS: ReadonlySet<string> = new Set([
  'carry-drill-carry-dropped',
  'carry-drill-respawn-failed',
  'carry-drill-request-failed',
]);
/** Kinds proving a drill is IN FLIGHT (started, not yet terminal). */
const INFLIGHT_KINDS: ReadonlySet<string> = new Set([
  'carry-drill-requested',
  'carry-drill-queued',
  'carry-drill-respawned',
  'carry-drill-carry-delivered',
]);

/** Drills that respawned but were never graded and are not otherwise dead — the
 *  grade candidates. Returns {drillId, ownerId} (grade needs both). Deduped. */
export function respawnedUngradedDrills(
  events: readonly ColdBootDrillLedgerEvent[],
): Array<{ drillId: string; ownerId: string }> {
  const respawned = new Map<string, string>(); // drillId → ownerId
  const graded = new Set<string>();
  const dead = new Set<string>();
  for (const e of events) {
    if (!e.drillId) continue;
    if (RESPAWNED_KINDS.has(e.kind) && e.ownerId) respawned.set(e.drillId, e.ownerId);
    else if (e.kind === GRADED_KIND) graded.add(e.drillId);
    else if (DEAD_KINDS.has(e.kind)) dead.add(e.drillId);
  }
  const out: Array<{ drillId: string; ownerId: string }> = [];
  for (const [drillId, ownerId] of respawned) {
    if (!graded.has(drillId) && !dead.has(drillId)) out.push({ drillId, ownerId });
  }
  return out;
}

/** Is a drill for `sessionClass` currently IN FLIGHT (started, not yet graded/dead)?
 *  Prevents piling a second drill on a class while the first is still resolving. */
export function hasPendingDrillForClass(
  events: readonly ColdBootDrillLedgerEvent[],
  sessionClass: string,
): boolean {
  const inflight = new Set<string>();
  const terminal = new Set<string>();
  for (const e of events) {
    if (!e.drillId || e.sessionClass !== sessionClass) continue;
    if (e.kind === GRADED_KIND || DEAD_KINDS.has(e.kind)) terminal.add(e.drillId);
    else if (INFLIGHT_KINDS.has(e.kind)) inflight.add(e.drillId);
  }
  for (const id of inflight) if (!terminal.has(id)) return true;
  return false;
}

/** Count of GRADED drills for `sessionClass` (the give-up budget denominator). */
export function gradedDrillCountForClass(
  events: readonly ColdBootDrillLedgerEvent[],
  sessionClass: string,
): number {
  const graded = new Set<string>();
  for (const e of events) {
    if (e.kind === GRADED_KIND && e.sessionClass === sessionClass && e.drillId) graded.add(e.drillId);
  }
  return graded.size;
}

/** Pick a headless, carry-respawn-capable live host for `sessionClass`, preferring
 *  the most-idle (oldest lastActivityAt) to minimise disruption — though the host
 *  busy-gate defers the cut to a clean boundary regardless. null ⇒ none eligible. */
export function pickEligibleHost(hosts: readonly PsuPtyHost[], sessionClass: string): PsuPtyHost | null {
  const eligible = hosts.filter(
    (h) =>
      h.bridgeTty === false && // headless only (D-005) — never auto-cut a human session
      sessionClassForHost(h) === sessionClass &&
      hostSupports(h, 'carry-respawn'),
  );
  if (eligible.length === 0) return null;
  // Most-idle first: a null/absent activity stamp sorts as "very idle" (0).
  eligible.sort((a, b) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0));
  return eligible[0]!;
}

export interface ColdBootDrillAutorunResult {
  skipped: boolean;
  graded: string[];
  /** class → drillId started this pass (at most one entry). */
  started: Array<{ sessionClass: string; ownerId: string; drillId: string }>;
  /** classes already proven (report.sufficientClasses ∩ AUTO_DRILL_CLASSES). */
  proven: string[];
  /** classes skipped this pass with the reason (no-host / in-flight / gave-up). */
  skippedClasses: Array<{ sessionClass: string; reason: string }>;
}

/**
 * One autorun pass: grade prior respawned-but-ungraded drills, then start ONE new
 * drill for the first unproven, not-in-flight, not-given-up target class that has an
 * eligible headless host. Never throws (best-effort backstop). Exported for tests.
 */
export async function runColdBootDrillAutorunOnce(
  overrides: Partial<ColdBootDrillAutorunDeps> = {},
): Promise<ColdBootDrillAutorunResult> {
  const deps = autorunDeps(overrides);
  const empty: ColdBootDrillAutorunResult = { skipped: true, graded: [], started: [], proven: [], skippedClasses: [] };
  if (!(await deps.flagEnabled())) return empty;

  // 1. GRADE phase — feed sufficientClasses from prior respawned drills.
  const ledger = await deps.readLedger();
  const graded: string[] = [];
  for (const { drillId, ownerId } of respawnedUngradedDrills(ledger).slice(0, MAX_GRADES_PER_PASS)) {
    try {
      const r = await deps.gradeDrill(ownerId, drillId);
      if (r.ok) graded.push(drillId);
    } catch {
      /* best-effort per drill — retry next pass */
    }
  }

  // Re-read ledger + report AFTER grading so a just-graded drill counts immediately.
  const ledgerAfter = graded.length > 0 ? await deps.readLedger() : ledger;
  const report = await deps.report();
  const sufficient = new Set(report.sufficientClasses);
  const proven = AUTO_DRILL_CLASSES.filter((c) => sufficient.has(c));

  // 2. START phase — one drill for the first eligible unproven target class.
  const started: ColdBootDrillAutorunResult['started'] = [];
  const skippedClasses: ColdBootDrillAutorunResult['skippedClasses'] = [];
  for (const sessionClass of AUTO_DRILL_CLASSES) {
    if (sufficient.has(sessionClass)) continue; // proven → nothing to do
    if (hasPendingDrillForClass(ledgerAfter, sessionClass)) {
      skippedClasses.push({ sessionClass, reason: 'drill-in-flight' });
      continue;
    }
    if (gradedDrillCountForClass(ledgerAfter, sessionClass) >= MAX_DRILLS_BEFORE_GIVEUP) {
      skippedClasses.push({ sessionClass, reason: 'gave-up-carry-insufficient' });
      continue;
    }
    const host = pickEligibleHost(deps.listHosts(), sessionClass);
    if (!host) {
      skippedClasses.push({ sessionClass, reason: 'no-eligible-headless-host' });
      continue;
    }
    try {
      const r = await deps.startDrill({ ownerId: host.ownerId, ownerLabel: host.ownerId });
      if (r.ok) {
        started.push({ sessionClass, ownerId: host.ownerId, drillId: r.drillId });
        break; // ONE drill per pass — bounded blast radius
      }
      skippedClasses.push({ sessionClass, reason: `start-failed:${r.error}` });
    } catch {
      skippedClasses.push({ sessionClass, reason: 'start-threw' });
    }
  }

  return { skipped: false, graded, started, proven, skippedClasses };
}

let autorunTimer: ManagedHandle | null = null;

/**
 * Start the cold-boot drill autorunner: a recurring process-level pass. Idempotent
 * (re-start stops the prior timer). Runtime gate: FLAGS.COLD_BOOT_DRILL_AUTORUNNER
 * (checked per pass). Kill-switch also via env PAPERCUSP_COLD_BOOT_DRILL_AUTORUNNER='0'
 * for a hard boot-time disable (mirrors the compaction watchdog's env kill-switch).
 */
export function startColdBootDrillAutorunner(opts: { intervalMs?: number } = {}): void {
  if (process.env.PAPERCUSP_COLD_BOOT_DRILL_AUTORUNNER === '0') return;
  const intervalMs = opts.intervalMs ?? COLD_BOOT_DRILL_AUTORUN_INTERVAL_MS;
  if (autorunTimer) autorunTimer.stop();
  let running = false;
  autorunTimer = managedSetInterval(
    'cold-boot-drill-autorunner',
    intervalMs,
    () => {
      if (running) return; // never overlap a slow pass
      running = true;
      void runColdBootDrillAutorunOnce()
        .then((r) => {
          if (r.started.length > 0) {
            console.warn(
              `[cold-boot-drill-autorunner] started ${r.started.length} bootstrap drill(s): ` +
                r.started.map((s) => `${s.sessionClass} on ${s.ownerId} (${s.drillId.slice(0, 8)}…)`).join(', ') +
                ` — proving cold-by-default (${graded(r)}).`,
            );
          }
        })
        .catch((e) => {
          console.warn(
            `[cold-boot-drill-autorunner] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          running = false;
        });
    },
    { category: 'watchdog' },
  );
}

function graded(r: ColdBootDrillAutorunResult): string {
  return r.graded.length > 0 ? `graded ${r.graded.length} prior drill(s)` : 'no prior drills to grade';
}

/** Test seam: stop the timer between tests. */
export function stopColdBootDrillAutorunnerForTests(): void {
  if (autorunTimer) autorunTimer.stop();
  autorunTimer = null;
}
