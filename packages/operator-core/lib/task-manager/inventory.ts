/**
 * The task-inventory read model — ONE implementation, two callers.
 *
 * (task-manager-no-escape-2026-07-27, WI-6475.)
 *
 * The pane originally lived only behind `GET /api/admin/tasks/inventory`, which the
 * client polled with a bare `fetch`. That 403'd in the desktop webview: a native
 * webview fetch does not ride the sys:http IPC bridge that injects the loopback-
 * superuser bearer, so it resolves `unverified-loopback` and a VT-gated admin route
 * refuses it (the mechanism is written up verbatim in
 * `endpoint-route/__tests__/auth-posture.test.ts`, EI-338). The pane now reads
 * through the sync layer like every sibling rail tab, whose transport
 * (`/zero-harness/rest-query`) is `auth:'loopback'` and is therefore admitted.
 *
 * The HTTP route is kept — it is a legitimate non-UI surface (curl, external probes,
 * the `/admin/tasks` page's own contract) — so this module exists to guarantee the
 * two callers can never drift into reporting different numbers for the same box.
 */
import { listTasks } from './store';
import { reconcileTick } from './reconcile-tick';
import { defaultForeignSignature, scanProcessesAsync } from './scan';
import type { ExemptReason, ProcessScope } from './scope-class';
import type { ScannedProcess } from './reconcile';
import { REPO_ROOT } from '../agent-tools/docs/_repo-paths';
import {
  formatProcessStartTime,
  projectProcessMetadata,
  readProcessMetadataAsync,
  type StableProcessMetadata,
} from '../process-metadata';
import { mapWithConcurrency } from '../gym/concurrency';
import { redactSensitiveText } from '../sensitive-text';
import { readSuperuserToken } from '../superuser-token';

// The PURE, dependency-free slice of this model lives in the CLIENT-SAFE `./inventory-shared`
// (WI-8191). A `'use client'` hook value-importing `cpuBusyPercent` from HERE dragged this
// module's server graph (store / reconcile-tick / scan / _repo-paths, and their node: builtins)
// into the SPA's browser-eager bundle, where it throws at module-init and white-screens the
// route. Everything below is re-exported so server callers — and this module's own tests —
// import from either path and still get ONE definition.
//
// ⚠ Adding a new pure type or constant here that a client needs? Put it in `./inventory-shared`
// instead. Re-exporting is safe (a client importing THIS file still pulls the server graph);
// what matters is that the CLIENT's import specifier points at the shared file.
import {
  emptyResourceTotals,
  foldResourceTotals,
  RESOURCE_TOTALS_FILTER,
  RESOURCE_TOTALS_LIMIT,
  type ScheduleTaskRow,
  type ScheduleTaskSummary,
  type TaskInventoryRow,
  type TaskResourceTotals,
} from './inventory-shared';

export {
  cpuBusyPercent,
  emptyResourceTotals,
  foldResourceTotals,
  RESOURCE_TOTALS_FILTER,
  RESOURCE_TOTALS_LIMIT,
} from './inventory-shared';
export type { ScheduleTaskRow, ScheduleTaskSummary, TaskInventoryRow, TaskResourceTotals } from './inventory-shared';

/**
 * A process the kernel scan SAW but the ledger does not own.
 *
 * Owner-reported (WI-6475): "the task manager is showing no tasks, obviously we have
 * running tasks". Both facts were true at once, and that is the bug. Only three seams
 * enrol (orchestrator agent turns, backgrounded bash jobs, headless fleet members),
 * each of them SHORT-LIVED, so at any given instant almost nothing enrolled is
 * mid-flight — while ~400 real processes run on the box. The pane rendered an empty
 * table next to its own line reading "400 process(es) scanned", which is not a
 * subtle failure: it reads as broken.
 *
 * The scan already collects pid + cmdline + cgroup for every one of these. Showing
 * them costs nothing and makes the pane answer the question its own tooltip promises
 * ("every process running right now") instead of "what our three seams enrolled in
 * the last minute".
 */
export type LiveProcessRow = {
  pid: number;
  startedAt: string | null;
  executable: string | null;
  role: string | null;
  build: string | null;
  cgroupPath: string;
  /** true = inside our slice (enrolled lineage); false = signature-matched, unenrolled. */
  owned: boolean;
  /**
   * `owned:false` split into the two populations a reader must not confuse:
   * `exempt` (a lifetime we deliberately do not own — the owner's terminal, a
   * systemd unit) and `unaccounted` (a genuine escape). Rendering both as one
   * "UNENROLLED" group is the defect this field exists to fix — it presented ~98%
   * of the box as a coverage hole (EI-19325095302441792).
   */
  scope: ProcessScope;
  /** Non-null exactly when `scope === 'exempt'` — the reason to show the reader. */
  exemptReason: ExemptReason | null;
};

export type TaskInventory = {
  enabled: boolean;
  summary: {
    total: number;
    byState: Record<string, number>;
    byClass: Record<string, number>;
    resources: TaskResourceTotals;
  };
  live: unknown;
  rows: TaskInventoryRow[];
  /**
   * What is ACTUALLY running, independent of the ledger. Populated only when the
   * caller asks for the live view (it comes from the same dry-run scan). Capped so a
   * busy box cannot ship an unbounded payload to a sidebar pane.
   */
  liveProcesses: LiveProcessRow[];
  /**
   * RECURRING tasks (P-019) — populated only when the caller passes `includeSchedules`.
   *
   * OPTIONAL on purpose, and the reason is not style: `TaskInventory` is a shared
   * interface with fixtures across several suites, and adding a REQUIRED field to one
   * strands every construction site in files this change never touches — the trap
   * `lint:required-field-strands` exists for. It also matches how the pane already
   * treats `resources`/`liveProcesses`: an older operator still serving `:3070` ships a
   * payload without the key, and absent must render as "not asked for", never as zero.
   */
  schedules?: ScheduleTaskRow[];
  scheduleSummary?: ScheduleTaskSummary;
  /**
   * Why the recurring set could not be read, when it could not be.
   *
   * Load-bearing, not decorative. `collectScheduleInventory` is fail-soft per source,
   * so a total failure would otherwise surface as `schedules: []` — indistinguishable
   * from "nothing recurring is registered", which is a false clean bill of health on a
   * pane whose entire job is finding what the system is doing behind your back. The
   * pane renders this instead of an empty table.
   */
  scheduleError?: string | null;
};

export type TaskInventoryOptions = {
  state?: string | null;
  cls?: string | null;
  includeEnded?: boolean;
  /**
   * With `live`, run the scan but ship NO per-process rows — the totals in `live`
   * only. For the header pill, which must state a true count of running processes
   * without carrying the process table onto every tab.
   */
  countsOnly?: boolean;
  live?: boolean;
  /**
   * Also inventory RECURRING tasks (P-019). OFF by default, and deliberately opt-in:
   * `collectScheduleInventory()` reads DBOS + the routines table AND makes a bounded
   * loopback probe to sibling processes, so it must never ride the pane's 5s process
   * refresh. Callers that want it pace themselves accordingly.
   */
  includeSchedules?: boolean;
};

/** Just enough of a store row to fold; keeps the seam below narrow and injectable. */
type ResourceSourceRow = { lastMemoryBytes?: number | null; cpuUsec?: number | null };
type ResourceLister = (filter: typeof RESOURCE_TOTALS_FILTER) => Promise<ResourceSourceRow[]>;

/**
 * Fetch the live tracked set and fold it — the ONE path that produces `summary.resources`.
 *
 * `lister` is injected so the filter-independence claim is testable without a database:
 * a fake lister records the filter it was handed, and the guard test asserts no caller
 * filter ever reaches it.
 *
 * ⚠ The mapping `lastMemoryBytes -> rssBytes` is load-bearing. The store row names the
 * field differently from the wire row, so folding a store row through the wire row's
 * `Pick<..., 'rssBytes'>` shape reads `undefined` on every row and yields a confident `0`
 * total that is indistinguishable from "nothing reported".
 */
export async function computeResourceTotals(
  nowMs: number,
  lister: ResourceLister = listTasks as unknown as ResourceLister,
): Promise<TaskResourceTotals> {
  const rows = await lister(RESOURCE_TOTALS_FILTER);
  const folded = foldResourceTotals(
    rows.map((r) => ({ rssBytes: r.lastMemoryBytes ?? null, cpuUsec: r.cpuUsec ?? null })),
    nowMs,
  );
  return { ...folded, truncated: rows.length >= RESOURCE_TOTALS_LIMIT };
}

/** The disabled-flag payload. Shared so both callers render the same empty state. */
export function disabledInventory(): TaskInventory {
  return {
    enabled: false,
    summary: { total: 0, byState: {}, byClass: {}, resources: emptyResourceTotals() },
    rows: [],
    live: null,
    liveProcesses: [],
  };
}

/** Cap on live-process rows shipped to the pane. */
const MAX_LIVE_PROCESS_ROWS = 4000;

/**
 * Row priority under the cap: ours, then real escapes, then dead-window residue,
 * then exempt lifetimes.
 *
 * `abandoned-window` outranks `exempt` because it is residue a human should see,
 * and ranks below `unaccounted` because it is not a chokepoint bypass — a human
 * did legitimately own it, right up until they closed the window (D-018).
 */
function scopeRank(scope: ProcessScope): number {
  if (scope === 'owned') return 0;
  if (scope === 'unaccounted') return 1;
  return scope === 'abandoned-window' ? 2 : 3;
}

function safeDisplayText(text: string, maxChars: number, knownSecrets: readonly string[] = []): string {
  // Redact BEFORE capping so a secret crossing the boundary cannot be partially
  // preserved in a client payload.
  return redactSensitiveText(text, knownSecrets).slice(0, maxChars);
}

function localDiagnosticSecrets(): readonly string[] {
  const token = readSuperuserToken();
  return token ? [token] : [];
}

/**
 * Pure projection for a `/proc` row crossing into a task-manager client.
 * `metadata` defaults to the cmdline-only projection; the live scan supplies the
 * procfs-read one via {@link projectLiveProcesses}.
 */
export function projectLiveProcess(
  p: ScannedProcess,
  metadata: StableProcessMetadata = projectProcessMetadata({ cmdline: p.cmdline }),
): LiveProcessRow {
  return {
    pid: p.pid,
    startedAt: formatProcessStartTime(p.startedAtMs),
    ...metadata,
    cgroupPath: p.cgroupPath,
    owned: p.owned,
    scope: p.scope,
    exemptReason: p.exemptReason,
  };
}

/**
 * Procfs metadata reads in flight at once. Bounded so a 4000-row scan cannot
 * monopolise the 4-thread libuv pool every other fs call in this process shares.
 */
const METADATA_READ_CONCURRENCY = 8;

/**
 * Project live rows with their procfs metadata, reading OFF the event loop.
 *
 * This used to be a synchronous readlinkSync + readFileSync per process on the
 * request-serving main thread: ~13% of main-thread self time during the P-007
 * popup stalls (EI-24342043796392664). The reads are async and bounded now.
 */
export async function projectLiveProcesses(
  rows: readonly ScannedProcess[],
): Promise<LiveProcessRow[]> {
  return mapWithConcurrency(rows, METADATA_READ_CONCURRENCY, async (p) =>
    projectLiveProcess(p, await readProcessMetadataAsync(p.pid, p.cmdline)),
  );
}

/**
 * SHARED TTL memo for the live scan (owner-directed 2026-08-02).
 *
 * The scan is a cgroup-tree walk, so it used to be affordable only for a pane you
 * had deliberately opened. That constraint is what made the header pill report the
 * LEDGER count — "3 tasks" on a box running 131 agents, which the owner correctly
 * called impossible. The pill is mounted on every tab, so it could not have paid
 * for a scan per render.
 *
 * Memoising the scan removes that trade-off: the pill, the open panel and the
 * /admin/tasks page now share ONE walk per TTL no matter how many readers there
 * are, so the pill can afford to show the true number instead of a cheap wrong one.
 *
 * In-flight calls share the SAME promise, not just the settled value — otherwise N
 * simultaneous mounts on a fresh cache each start their own walk, which is exactly
 * the stampede the memo exists to prevent.
 */
const LIVE_SCAN_TTL_MS = 5_000;
let liveScanMemo: { at: number; promise: Promise<LiveScanResult> } | null = null;

/**
 * `rows` is LAZY and memoised with the scan: the header pill (`countsOnly`, on
 * every tab, every 5s) needs only the totals and must never pay for per-process
 * metadata, while pane readers inside one TTL share one projection.
 */
type LiveScanResult = { live: unknown; rows: () => Promise<LiveProcessRow[]> };

function lazyProjection(scanned: readonly ScannedProcess[]): () => Promise<LiveProcessRow[]> {
  let projected: Promise<LiveProcessRow[]> | null = null;
  return () => (projected ??= projectLiveProcesses(scanned));
}

/** Test seam — drop the memo so a test never reads another test's scan. */
export function resetLiveScanMemoForTest(): void {
  liveScanMemo = null;
}

/**
 * SHARED TTL memo for the recurring inventory (P-019), same shape and same reason as
 * the live-scan memo above — in-flight callers share the PROMISE, not just the settled
 * value, so N simultaneous mounts cannot stampede it.
 *
 * The TTL is much longer than the scan's 5s because the cost profile is different and
 * so is the data: this reads DBOS + the routines table and probes sibling processes
 * over loopback, while what it returns is a REGISTRY — the set of things scheduled to
 * run. That set changes on deploys and arm/disarm, not second to second, so refreshing
 * it at the process poll's cadence would buy nothing and put two DB reads plus a
 * network probe behind every tick of a pane that is often just left open.
 */
const SCHEDULE_INVENTORY_TTL_MS = 30_000;
let scheduleMemo: { at: number; promise: Promise<ScheduleScanResult> } | null = null;

type ScheduleScanResult = {
  schedules: ScheduleTaskRow[];
  scheduleSummary: ScheduleTaskSummary;
  scheduleError: string | null;
};

/** Test seam — drop the memo so a test never reads another test's inventory. */
export function resetScheduleMemoForTest(): void {
  scheduleMemo = null;
}

function scanSchedules(now: number): Promise<ScheduleScanResult> {
  if (scheduleMemo && now - scheduleMemo.at < SCHEDULE_INVENTORY_TTL_MS) return scheduleMemo.promise;
  const promise = runScheduleScan();
  scheduleMemo = { at: now, promise };
  void promise.catch(() => {
    scheduleMemo = null;
  });
  return promise;
}

/**
 * The recurring-row projection — PURE, so its unit tests are the spec.
 *
 * Typed structurally rather than against `ScheduleInventoryRow` so this stays free of
 * the schedule-inventory (DBOS + federation) graph; the caller supplies real rows.
 */
export function projectScheduleRows(
  rows: readonly {
    source: string;
    scope: string;
    tier: string;
    category: string;
    name: string;
    installSlug?: string | null;
    cadence: string;
    armed?: boolean | null;
    lastFire?: string | null;
    nextFire?: string | null;
    lastError?: string | null;
    detail?: Record<string, unknown>;
  }[],
): ScheduleTaskRow[] {
  const diagnosticSecrets = localDiagnosticSecrets();
  // Guarantees a UNIQUE key per row, structurally — not by hoping the discriminator
  // list below is complete.
  //
  // ⚠ MEASURED, not theorised: `source:scope:name` looked sufficient and passed its
  // unit tests, then collided on 35 keys / 138 rows against the live inventory. The
  // cause was the SAME timer reported by two sibling processes (`operator:3170` and
  // `operator:3270`) — identical in every field the key used, differing only in
  // `detail.process`. Duplicate React keys silently DROP rows, so the pane would have
  // under-reported the recurring set while looking perfectly healthy: the exact
  // can't-see-its-own-gap failure this plan exists to prevent.
  //
  // Adding `process` fixes today's population. The ordinal fallback is what keeps it
  // fixed: any future source that repeats a row along an axis nobody thought to encode
  // gets a distinct key instead of vanishing. Uniqueness is bound to the PROPERTY (one
  // key per row) rather than to a guess about which fields happen to discriminate.
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const natural = [
      r.source,
      r.scope,
      r.installSlug ?? '',
      r.category,
      typeof r.detail?.process === 'string' ? r.detail.process : '',
      r.name,
    ].join(':');
    const n = seen.get(natural) ?? 0;
    seen.set(natural, n + 1);
    return {
      key: n === 0 ? natural : `${natural}#${n}`,
      name: r.name,
      source: r.source,
      tier: r.tier,
      category: r.category,
      scope: r.scope,
      installSlug: r.installSlug ?? null,
      cadence: r.cadence,
      // `?? null` NOT `|| null`: `armed: false` is a real, load-bearing reading
      // (disarmed), and `||` would flatten it into the same `null` the pane renders as
      // "unknown" — turning a timer we KNOW is off into one we cannot see. Measured on
      // the live inventory: 204 of 438 rows are legitimately `false`.
      armed: r.armed ?? null,
      lastFire: r.lastFire ?? null,
      nextFire: r.nextFire ?? null,
      lastError: r.lastError ? safeDisplayText(r.lastError, 300, diagnosticSecrets) : null,
      // Strict `=== true`, so a missing/odd `detail` can never read as federated. The
      // whole point of the flag is that it licenses trusting armed/lastFire.
      federated: r.detail?.federated === true,
      process: typeof r.detail?.process === 'string' ? r.detail.process : null,
    };
  });
}

async function runScheduleScan(): Promise<ScheduleScanResult> {
  try {
    // Imported lazily for the same reason the pane's arm is opt-in: this module is on
    // the header pill's path, and `schedule-inventory` drags the DBOS + federation
    // graph behind it. A reader who never opens the recurring view never pays for it.
    const { collectScheduleInventory, summarizeInventory } = await import('../schedule-inventory');
    const rows = await collectScheduleInventory();
    return {
      schedules: projectScheduleRows(rows),
      scheduleSummary: summarizeInventory(rows),
      scheduleError: null,
    };
  } catch (e) {
    // Same posture as the live scan: a fault degrades this section, never the pane —
    // and it reports the fault rather than an empty set, because "no recurring tasks"
    // is a materially different claim from "could not read them".
    return {
      schedules: [],
      scheduleSummary: { total: 0, bySource: {}, byTier: {} },
      scheduleError: safeDisplayText((e as Error).message, 300, localDiagnosticSecrets()),
    };
  }
}

function scanLive(now: number): Promise<LiveScanResult> {
  if (liveScanMemo && now - liveScanMemo.at < LIVE_SCAN_TTL_MS) return liveScanMemo.promise;
  const promise = runLiveScan();
  liveScanMemo = { at: now, promise };
  // A rejected scan must not be cached as the answer for the whole TTL — but
  // runLiveScan already converts a fault into a `{ error }` payload rather than
  // throwing, so this only guards a genuinely unexpected throw.
  void promise.catch(() => {
    liveScanMemo = null;
  });
  return promise;
}

async function runLiveScan(): Promise<LiveScanResult> {
  const diagnosticSecrets = localDiagnosticSecrets();
  // Never let a scan fault take the PANE down — a task manager that goes blank
  // exactly when the box is unhealthy is worse than one that renders the ledger
  // with a "live view unavailable" note.
  try {
    const tick = await reconcileTick({
      dryRun: true,
      scan: scanProcessesAsync,
      scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
    });
    return {
      live: {
        ...tick.summary,
        degraded: tick.degraded,
        degradedReason: tick.degradedReason ? safeDisplayText(tick.degradedReason, 300, diagnosticSecrets) : undefined,
        scan: tick.scan,
        unaccounted: tick.result.unaccounted.map((g) => ({
          cgroupPath: g.cgroupPath,
          pids: g.pids,
          sample: projectProcessMetadata({ cmdline: g.sampleCmdline }).executable ?? 'unknown',
        })),
      },
      // Owned first (enrolled lineage), then the genuine escapes, then the
      // deliberately-exempt lifetimes; within each, by pid so the order is stable
      // across the 5s refresh and rows do not jump under the reader's cursor.
      //
      // Ranking `unaccounted` ABOVE `exempt` is what makes the cap safe rather than
      // lucky: exempt rows are the large population (157 terminal processes on this
      // box, against ~13 real escapes), so a pid-ordered cut could drop precisely
      // the rows that carry the alarm and leave the pane reporting a clean gap it
      // simply could not see. The cap is not biting today at 4000 — this keeps the
      // property true if it ever does (EI-19325095302441792).
      rows: lazyProjection(
        tick.scannedProcesses
          .slice()
          .sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.pid - b.pid)
          .slice(0, MAX_LIVE_PROCESS_ROWS),
      ),
    };
  } catch (e) {
    return {
      live: { error: safeDisplayText((e as Error).message, 300, diagnosticSecrets) },
      rows: async () => [],
    };
  }
}

export async function getTaskInventory(opts: TaskInventoryOptions = {}): Promise<TaskInventory> {
  const { state, cls, includeEnded = false, live: wantLive = false } = opts;

  const rows = await listTasks({
    states: state ? [state as never] : undefined,
    classes: cls ? [cls] : undefined,
    includeEnded,
    limit: 500,
  });

  const byState: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    byClass[r.class] = (byClass[r.class] ?? 0) + 1;
  }

  let live: unknown = null;
  let liveProcesses: LiveProcessRow[] = [];
  if (wantLive) {
    const scanned = await scanLive(Date.now());
    live = scanned.live;
    // `countsOnly` is the HEADER PILL's arm: it needs the live TOTALS to state a
    // true process count, but shipping 4000 process rows to a control that renders one
    // short string would put the whole process table behind every tab of the app.
    // Same memoised scan either way — this drops only the payload.
    liveProcesses = opts.countsOnly ? [] : await scanned.rows();
  }

  // `?? null` on every nullable field is load-bearing, not defensive noise: the
  // store types these as `T | null | undefined`, and `JSON.stringify` DROPS an
  // undefined-valued key entirely. Left alone, a task with no work-item would ship
  // a row with no `workItemId` key at all rather than an explicit null, so the
  // client could not distinguish "not attributed" from "field missing" — and the
  // sync layer's row-delta negotiation diffs on key presence. Normalising here is
  // what makes the wire shape total.
  const diagnosticSecrets = localDiagnosticSecrets();
  const mappedRows: TaskInventoryRow[] = rows.map((r) => ({
    taskId: r.taskId,
    parentTaskId: r.parentTaskId ?? null,
    rootTaskId: r.rootTaskId,
    class: r.class,
    title: safeDisplayText(r.title, 300, diagnosticSecrets),
    state: r.state,
    launchedBy: r.launchedBy,
    workItemId: r.workItemId ?? null,
    planSlug: r.planSlug ?? null,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
    confined: r.confined,
    scopeUnit: r.scopeUnit ?? null,
    rssBytes: r.lastMemoryBytes ?? null,
    peakRssBytes: r.peakMemoryBytes ?? null,
    cpuUsec: r.cpuUsec ?? null,
    pids: r.pidsCurrent ?? null,
    memoryMaxBytes: r.memoryMaxBytes ?? null,
    deadlineAt: r.deadlineAt ?? null,
    exitCode: r.exitCode ?? null,
    exitReason: r.exitReason ? safeDisplayText(r.exitReason, 500, diagnosticSecrets) : null,
    termination: r.terminalProvenance
      ? {
          capturedAt: r.terminalProvenance.capturedAt,
          reason: r.exitReason ? safeDisplayText(r.exitReason, 500, diagnosticSecrets) : null,
          serviceResult: r.terminalProvenance.serviceResult,
          scopeUnit: r.terminalProvenance.scopeUnit,
          cgroupPath: r.terminalProvenance.cgroupPath,
          invocationId: r.terminalProvenance.invocationId,
          memoryMaxBytes: r.terminalProvenance.memoryMaxBytes,
          peakMemoryBytes: r.terminalProvenance.peakMemoryBytes,
          peakMemorySource: r.terminalProvenance.peakMemorySource,
        }
      : null,
    logPath: r.logPath ? safeDisplayText(r.logPath, 500, diagnosticSecrets) : null,
  }));

  // WI-7371: the totals run over their OWN unfiltered fetch, NOT `mappedRows`. `rows`
  // above already has the caller's state/class/includeEnded applied, so folding it would
  // put the pane's filter inside a figure labelled as a system total — the same defect as
  // a client-side `rows.reduce()`, just relocated to the server where it reads as
  // authoritative. See RESOURCE_TOTALS_FILTER and its guard test.
  const resources = await computeResourceTotals(Date.now());

  // P-019 — the RECURRING kind. Opt-in and separately memoised, so the process view's
  // cadence and this one's stay independent (see SCHEDULE_INVENTORY_TTL_MS).
  const scheduleScan = opts.includeSchedules ? await scanSchedules(Date.now()) : null;

  return {
    enabled: true,
    summary: {
      total: rows.length,
      byState,
      byClass,
      resources,
    },
    live,
    liveProcesses,
    rows: mappedRows,
    // Spread rather than always-present keys: a caller that did not ask for the
    // recurring view gets NO `schedules` key at all, which is what lets the pane tell
    // "not requested" apart from "requested, and there are none".
    ...(scheduleScan
      ? {
          schedules: scheduleScan.schedules,
          scheduleSummary: scheduleScan.scheduleSummary,
          scheduleError: scheduleScan.scheduleError,
        }
      : {}),
  };
}
