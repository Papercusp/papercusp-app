/**
 * schedule-inventory — the central, read-only union of every scheduled/recurring
 * thing in the operator host, regardless of cadence
 * (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-002).
 *
 * Today scheduling is split across siloed surfaces with no single view. This
 * collapses the currently-available ones into ONE row shape:
 *   - DBOS scheduled workflows (durable tier) — via dbos-schedule-introspect (P-001)
 *   - harness_shared.routines (durable tier; fired by the DBOS routinesTick)
 *   - in-process-periodic checks (ephemeral tier; the EI-1622 host health sweeps)
 * Later sources plug in here unchanged: the managedSetInterval registry (P-006,
 * source 'managed') and per-process registries (P-014). Per D-006, `tier` maps to
 * the TWO execution mechanisms: durable (DBOS) | ephemeral (in-process).
 *
 * Pure aggregation with injectable source seams — the MCP tool (schedule:inventory)
 * and the /admin/schedules data path (P-003) both call collectScheduleInventory().
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import {
  listDbosScheduledWorkflows,
  type DbosScheduledEntry,
  type RegisteredSchedule,
} from './dbos/dbos-schedule-introspect';
import { buildDefaultChecks, inProcessPeriodicChecksArmed } from './dbos/in-process-periodic';
import { listManaged, type ManagedEntry, type TimerClassification } from '@papercusp/scheduled-registry';
import { collectSiblingManagedTimers, type SiblingManagedTimers } from './schedule-federation';
import {
  EXTERNAL_SCHEDULES,
  EXTERNAL_PROCESS_TIMERS as EXTERNAL_SCHEDULE_DESCRIPTORS,
  SYNC_TRIGGERED_SCHEDULES,
  SYNC_TRIGGERED_SWEEPS as SYNC_TRIGGERED_DESCRIPTORS,
} from './schedule-descriptors.mjs';

/**
 * Every source collectScheduleInventory can emit a row for. SINGLE source of truth:
 * the `ScheduleSource` type is derived from it AND the schedule:inventory tool's `source`
 * filter is built from it (z.enum(SCHEDULE_SOURCES)), so a NEW source can't be surfaced in
 * the inventory yet stay silently un-filterable in the tool (the P-009 "no silent gaps" rule
 * applied to the read surface itself).
 */
export const SCHEDULE_SOURCES = [
  'dbos',
  'routines',
  'in-process',
  'managed',
  'external-process',
] as const;
export type ScheduleSource = (typeof SCHEDULE_SOURCES)[number];
export type ScheduleScope = 'operator' | 'harness';
/** Execution mechanism (D-006): durable = DBOS-backed; ephemeral = in-process setInterval. */
export type ScheduleTier = 'durable' | 'ephemeral';

export interface ScheduleInventoryRow {
  source: ScheduleSource;
  scope: ScheduleScope;
  tier: ScheduleTier;
  /** finer audit class: dbos-scheduled | routine | global-sweep | (later) lifecycle/watchdog/cache/ephemeral-harness */
  category: string;
  name: string;
  /** routines carry an install slug; null otherwise. */
  installSlug: string | null;
  /** crontab, or a human interval like "every 30s". */
  cadence: string;
  /** armed/active where known; null when not applicable. */
  armed: boolean | null;
  /** ISO last-fire, or null. */
  lastFire: string | null;
  /** ISO next-fire, or null. */
  nextFire: string | null;
  lastError: string | null;
  /** WI-5018 routines grouping — the routine's group_slug (source 'routines' only; null otherwise/ungrouped). A first-class field (not buried in detail) since grouping is a primary render/filter axis once the routines table passes a few hundred rows. */
  groupSlug: string | null;
  /** source-specific extras (mode, queue, targetRole, intervalMs, shed, …). */
  detail: Record<string, unknown>;
}

export interface RoutineRow {
  install_slug: string;
  name: string;
  trigger_kind: string;
  trigger_config: Record<string, unknown> | null;
  target_role: string;
  active: boolean;
  next_fire_at: Date | null;
  last_fired_at: Date | null;
  metadata: Record<string, unknown> | null;
  /** WI-5018 routines grouping — null for ungrouped rows (most in-flight loop-<id> rows). */
  group_slug: string | null;
}

export interface InProcessCheckLite {
  name: string;
  intervalMs: number;
  shed?: boolean;
  fireOnArm?: boolean;
  /** D-004 push-don't-poll classification (P-011) — null when the source check hasn't
   *  declared one (should not happen for in-process checks; see PeriodicCheck). */
  classification?: TimerClassification | null;
}
export interface InProcessChecksResult {
  checks: InProcessCheckLite[];
  armed: boolean;
}

/**
 * A bespoke recurring timer in a SEPARATE process (NOT the operator host registry) — P-014.
 * Listed in the inventory for VISIBILITY, with armed/lastFire null because its live fire-state
 * is not reachable. Source of truth = each process's code.
 *
 * ⚠ This is now the FALLBACK, not the only mechanism. Processes that serve
 * `bin/hono-host.ts` (bg-host, staging) ARE federated live — see `getSiblingManaged` /
 * schedule-federation.ts, which emits `source: 'external-process'` rows carrying real
 * armed/lastFire/lastError and `detail.federated: true`. This static manifest covers only
 * the processes that serve no such endpoint: the inference gateway, its standalone
 * watchdog, and the psu-launcher.
 */
export interface ExternalProcessTimer {
  /** The owning process — the per-process sub-list grouping (D-007). */
  process: string;
  name: string;
  /** Human cadence where statically known, else '(external)'. */
  cadence: string;
  /** Repo source location the timer lives at. */
  source: string;
}

/**
 * STATIC manifest of the known external-process timers (mirrors P-009 / D-007). These run in the
 * inference gateway (:8788), its standalone systemd watchdog, and the psu-launcher — all
 * allow-listed from the host `check-no-raw-setinterval` guard. This static list is the plan's
 * OR-clause ("list each as category 'external-process'"); LIVE federation (real fire-state over
 * each process's admin/IPC) is the documented follow-on that replaces it.
 */
export const EXTERNAL_PROCESS_TIMERS: ExternalProcessTimer[] = EXTERNAL_SCHEDULE_DESCRIPTORS.map((d) => ({
  process: d.process,
  name: d.name,
  cadence: `every ~${humanInterval(d.defaultIntervalMs).replace(/^every /, '')}`,
  source: d.source,
}));

/**
 * SYNC-TRIGGERED sweeps — recurring work whose cadence is "after each git-sync"
 * rather than a cron or an interval.
 *
 * They ran in the host for months while being absent from every inventory and
 * every owner-facing pane, because they are neither a routines row nor a timer.
 * The owner found the hole from the outside (2026-07-25: "in the docs tab i'm
 * seeing knowledge pack routines but what about the routine that checks for
 * drifted documentation?"). It was real — the sweep exists and runs, it simply
 * had no identity anywhere.
 */
export interface SyncTriggeredSweep {
  name: string;
  cadence: string;
  /** `true`/`false` when statically known; `null` ⇒ resolve from `flag`. */
  armed: boolean | null;
  /** Feature-flag key whose value IS the armed state, when armed is null. */
  flag?: string;
  /** Where the code lives. */
  source: string;
  /** What fires it. */
  trigger?: string;
  /**
   * Does a fire bill a model? Declared HERE, beside the sweep, because whoever
   * adds one knows the answer and nothing downstream can infer it — a sync-triggered
   * sweep has no `target_role` for the automation catalog to classify it by
   * (agents-system-pane-split-2026-07-26 D-001). This is the one non-routines
   * source that can dispatch an agent, which is exactly why it must say so.
   */
  spends: 'llm' | 'none';
  note: string;
}

/**
 * The doc pipeline is TWO rows, not one, because they have different risk
 * profiles and collapsing them would hide the one that costs money: DETECTION
 * always runs and is free (a sha comparison); REPAIR spawns an LLM agent per
 * drift batch and is gated behind the owner-authority dark flag DOC_STEWARD.
 */
export const SYNC_TRIGGERED_SWEEPS: SyncTriggeredSweep[] = SYNC_TRIGGERED_DESCRIPTORS.map((descriptor) => ({
  ...descriptor,
}));

/** Resolve a sweep's armed state from its feature flag; null when unknowable. */
async function resolveFlagArmed(flagKey: string): Promise<boolean | null> {
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    // The sweep rows carry the key as a plain string; getFlag takes the FLAGS
    // union. An unknown key just reads as not-enabled — 'null beats a guess'
    // already governs the failure path, so the narrowing cast is safe here.
    return (await getFlag(flagKey as Parameters<typeof getFlag>[0], 'papercusp')) === true;
  } catch {
    return null; // unknown beats a guess
  }
}

export interface ScheduleInventoryDeps {
  getDbosSchedules: () => Promise<DbosScheduledEntry[]>;
  getRoutines: () => Promise<RoutineRow[]>;
  /** LIVE managed timers from the scheduled-registry (source 'managed') — the actually-armed in-process timers with real fire times. */
  getManaged: () => ManagedEntry[];
  /** STATIC fallback: the known in-process sweeps as config (source 'in-process'), for checks not armed in THIS process. */
  getInProcessChecks: () => InProcessChecksResult;
  /** STATIC manifest of separate-process timers (source 'external-process', P-014); live fire-state requires federation (follow-on). */
  getExternalProcess: () => ExternalProcessTimer[];
  /**
   * LIVE federation (EI-19445595198254637): the managed-timer registries of the OTHER
   * operator-shaped processes on this box (bg-host, staging), fetched over a bounded
   * loopback probe. This is the P-014 follow-on for processes that serve
   * `bin/hono-host.ts`; the static `getExternalProcess` manifest above stays the
   * fallback for processes that do not (the inference gateway, its watchdog,
   * psu-launcher). Fail-soft AND time-bounded — see schedule-federation.ts.
   */
  getSiblingManaged: () => Promise<SiblingManagedTimers[]>;
  /**
   * Enrich a sibling's REGISTERED DBOS schedules (names + crontabs) with fire-state.
   * Default reuses the existing `listDbosScheduledWorkflows` seam with the sibling's
   * registry injected, so a federated durable row resolves lastFire/lastStatus from
   * the SAME shared-Postgres read a local row does. Injectable so unit tests stay
   * hermetic (the default touches PG).
   */
  enrichSiblingDbos: (schedules: RegisteredSchedule[]) => Promise<DbosScheduledEntry[]>;
  /** STATIC manifest of sync-triggered sweeps (emitted as source 'in-process', category 'sync-triggered'). */
  getSyncTriggered: () => SyncTriggeredSweep[];
}

const iso = (d: Date | null | undefined): string | null =>
  d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : null;

const isoFromMs = (ms: number | null): string | null =>
  ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** "every 30s" / "every 5m" — a readable cadence for an interval-driven check. */
export function humanInterval(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `every ${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `every ${intervalMs / 60_000}m`;
  return `every ${Math.round(intervalMs / 1000)}s`;
}

async function defaultGetRoutines(): Promise<RoutineRow[]> {
  try {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    return await sql<RoutineRow[]>`
      SELECT install_slug, name, trigger_kind, trigger_config, target_role,
             active, next_fire_at, last_fired_at, metadata, group_slug
        FROM harness_shared.routines
       WHERE workspace_id = ${ws}
       ORDER BY install_slug, name`;
  } catch {
    return [];
  }
}

function defaultGetInProcessChecks(): InProcessChecksResult {
  let armed = false;
  try {
    armed = inProcessPeriodicChecksArmed();
  } catch {
    /* not loaded in this process */
  }
  let checks: InProcessCheckLite[] = [];
  try {
    checks = buildDefaultChecks().map((c) => ({
      name: c.name,
      intervalMs: c.intervalMs,
      shed: c.shed,
      fireOnArm: c.fireOnArm,
      classification: c.classification,
    }));
  } catch {
    /* ignore */
  }
  return { checks, armed };
}

/**
 * Collect the unified schedule inventory across all currently-available sources.
 * Each source seam is independently fail-soft — one source erroring yields its
 * empty slice, never a thrown inventory.
 */
export async function collectScheduleInventory(
  deps: Partial<ScheduleInventoryDeps> = {},
): Promise<ScheduleInventoryRow[]> {
  const getDbos = deps.getDbosSchedules ?? (() => listDbosScheduledWorkflows());
  const getRoutines = deps.getRoutines ?? defaultGetRoutines;
  const getChecks = deps.getInProcessChecks ?? defaultGetInProcessChecks;
  const getManaged = deps.getManaged ?? (() => listManaged());
  const getExternal = deps.getExternalProcess ?? (() => EXTERNAL_PROCESS_TIMERS);
  const getSyncTriggered = deps.getSyncTriggered ?? (() => SYNC_TRIGGERED_SWEEPS);
  const getSiblingManaged = deps.getSiblingManaged ?? (() => collectSiblingManagedTimers());
  const enrichSiblingDbos =
    deps.enrichSiblingDbos ??
    ((schedules: RegisteredSchedule[]) =>
      listDbosScheduledWorkflows({ getRegisteredSchedules: () => schedules }));

  const [dbos, routines, siblings] = await Promise.all([
    getDbos().catch(() => [] as DbosScheduledEntry[]),
    getRoutines().catch(() => [] as RoutineRow[]),
    // Federation is a NETWORK seam, so it gets the same fail-soft treatment as the
    // DB seams — and it is additionally time-bounded inside collectSiblingManagedTimers,
    // because a wedged sibling must degrade to an UNKNOWN row, never stall the inventory.
    getSiblingManaged().catch(() => [] as SiblingManagedTimers[]),
  ]);
  let inproc: InProcessChecksResult;
  try {
    inproc = getChecks();
  } catch {
    inproc = { checks: [], armed: false };
  }
  let managed: ManagedEntry[];
  try {
    managed = getManaged();
  } catch {
    managed = [];
  }
  let external: ExternalProcessTimer[];
  try {
    external = getExternal();
  } catch {
    external = [];
  }
  let syncTriggered: SyncTriggeredSweep[];
  try {
    syncTriggered = getSyncTriggered();
  } catch {
    syncTriggered = [];
  }

  const rows: ScheduleInventoryRow[] = [];

  /* Federated DBOS rows dedupe against these. A schedule registered in BOTH this
   * process and a sibling is ONE logical schedule — DBOS coordinates it through
   * shared Postgres, so both copies would carry identical fire-state and the second
   * row would read as a duplicate rather than as information. Federation exists to
   * add what was MISSING, not to double-report what was already visible. */
  const localDbosNames = new Set(dbos.map((d) => d.name));

  for (const d of dbos) {
    rows.push({
      source: 'dbos',
      scope: 'operator',
      tier: 'durable',
      category: 'dbos-scheduled',
      name: d.name,
      installSlug: null,
      cadence: d.crontab,
      armed: true, // a registered schedule is live in this process
      lastFire: isoFromMs(d.lastFireMs),
      nextFire: null,
      lastError: null,
      groupSlug: null,
      detail: { mode: d.mode, queueName: d.queueName, lastStatus: d.lastStatus },
    });
  }

  for (const r of routines) {
    const cron = (r.trigger_config as { cron?: string } | null)?.cron ?? null;
    const lastError =
      (r.metadata as { last_error?: unknown } | null)?.last_error != null
        ? String((r.metadata as { last_error?: unknown }).last_error)
        : null;
    rows.push({
      source: 'routines',
      scope: 'operator',
      tier: 'durable', // routines are fired by the DBOS routinesTick
      category: 'routine',
      name: r.name,
      installSlug: r.install_slug,
      cadence: cron ?? r.trigger_kind,
      armed: r.active,
      lastFire: iso(r.last_fired_at),
      nextFire: iso(r.next_fire_at),
      lastError,
      groupSlug: r.group_slug,
      detail: { triggerKind: r.trigger_kind, targetRole: r.target_role },
    });
  }

  // source 'managed' — the LIVE scheduled-registry (P-006): actually-armed in-process
  // timers (the re-homed host sweeps + any codemod'd bespoke timers) with real fire
  // times. All managed timers are the in-process (ephemeral) mechanism per D-006.
  const managedNames = new Set(managed.map((m) => m.name));
  for (const m of managed) {
    rows.push({
      source: 'managed',
      scope: 'operator',
      tier: 'ephemeral',
      category: m.category,
      name: m.name,
      installSlug: null,
      cadence: humanInterval(m.intervalMs),
      armed: true, // present in the registry == armed in this process
      lastFire: isoFromMs(m.lastFireAt),
      nextFire: null,
      lastError: m.lastError,
      groupSlug: null,
      detail: {
        intervalMs: m.intervalMs,
        shed: m.shed,
        fires: m.fires,
        armedAt: m.armedAt,
        running: m.running,
        instances: m.instances ?? 1,
        instanced: m.instanced ?? false,
        classification: m.classification ?? null,
      },
    });
  }

  // source 'in-process' — STATIC fallback: known sweeps NOT currently armed as managed
  // timers in THIS process (e.g. a :3070 request worker), so they're still listed
  // (armed=false) instead of vanishing. Deduped against the live managed set above.
  for (const c of inproc.checks) {
    if (managedNames.has(c.name)) continue;
    rows.push({
      source: 'in-process',
      scope: 'operator',
      tier: 'ephemeral',
      category: 'global-sweep',
      name: c.name,
      installSlug: null,
      cadence: humanInterval(c.intervalMs),
      armed: inproc.armed,
      lastFire: null,
      nextFire: null,
      lastError: null,
      groupSlug: null,
      detail: { intervalMs: c.intervalMs, shed: c.shed ?? false, fireOnArm: c.fireOnArm ?? false, classification: c.classification ?? null },
    });
  }

  // source 'external-process' — bespoke timers in SEPARATE processes (P-014): the inference
  // gateway, its standalone watchdog, the psu-launcher. Listed for VISIBILITY (the per-process
  // sub-list is detail.process); armed/lastFire are null because live fire-state requires the
  // per-process federation follow-on.
  for (const e of external) {
    rows.push({
      source: 'external-process',
      scope: 'operator',
      tier: 'ephemeral',
      category: 'external-process',
      name: e.name,
      installSlug: null,
      cadence: e.cadence,
      armed: null,
      lastFire: null,
      nextFire: null,
      lastError: null,
      groupSlug: null,
      detail: { process: e.process, source: e.source, note: 'static manifest — live fire-state requires P-014 federation' },
    });
  }

  /*
   * source 'external-process', LIVE (EI-19445595198254637) — the managed timers of the
   * OTHER operator-shaped processes on this box, with real armed/lastFire/lastError.
   *
   * These are `external-process` rather than `managed` on purpose: `managed` means
   * "armed in THIS process" and the in-process dedup above depends on that meaning
   * staying exact. `detail.federated` is what separates a live federated row from a
   * static-manifest one, and `detail.process` carries the owning process label.
   *
   * Why this exists: before it, every bg-host timer was absent from the one surface
   * built to inventory timers, and an inventory that answers "not here" reads exactly
   * like "does not exist" — which is how a reaper that failed 100% of its passes ran
   * 6+ days undetected.
   */
  for (const s of siblings) {
    if (!s.ok) {
      // A sibling that did not answer yields ONE explicit UNKNOWN row. This is the
      // whole point of the degraded path: silence must be VISIBLE. Dropping the row
      // would restore exactly the invisibility this change exists to remove.
      rows.push({
        source: 'external-process',
        scope: 'operator',
        tier: 'ephemeral',
        category: 'external-process',
        name: `${s.label} (timers unknown)`,
        installSlug: null,
        cadence: '(unknown)',
        armed: null,
        lastFire: null,
        nextFire: null,
        lastError: s.error ?? 'sibling process did not answer',
        groupSlug: null,
        detail: {
          process: s.label,
          federated: false,
          reachable: false,
          pid: s.pid,
          port: s.port,
          probeMs: s.elapsedMs,
          note: 'sibling operator process did not answer the managed-timer probe within its deadline — its timers are UNKNOWN, not absent',
        },
      });
      continue;
    }
    for (const m of s.timers) {
      rows.push({
        source: 'external-process',
        scope: 'operator',
        tier: 'ephemeral',
        category: m.category,
        name: m.name,
        installSlug: null,
        cadence: humanInterval(m.intervalMs),
        armed: true, // present in that process's registry == armed there
        lastFire: isoFromMs(m.lastFireAt),
        nextFire: null,
        lastError: m.lastError,
        groupSlug: null,
        detail: {
          process: s.label,
          federated: true,
          reachable: true,
          pid: s.pid,
          port: s.port,
          probeMs: s.elapsedMs,
          intervalMs: m.intervalMs,
          shed: m.shed,
          fires: m.fires,
          armedAt: m.armedAt,
          running: m.running,
          instances: m.instances ?? 1,
          instanced: m.instanced ?? false,
          classification: m.classification ?? null,
        },
      });
    }

    /*
     * The sibling's DURABLE tier — its registered DBOS scheduled workflows.
     *
     * Emitted as `source: 'dbos'`, NOT 'external-process', and the asymmetry with
     * the ephemeral rows above is deliberate on two counts:
     *   (a) truthfulness — these ARE DBOS scheduled workflows, so an operator
     *       auditing `source: 'dbos'` (the audience that missed the reaper for 6+
     *       days) must find them under that filter;
     *   (b) the poll-suspect timer-registration audit consumes exactly
     *       'in-process' | 'managed' | 'external-process' and deliberately EXCLUDES
     *       the durable tier (WI-6094). Tagging these 'external-process' would drag
     *       them into an audit that was explicitly scoped to exclude them.
     *
     * Fire-state comes from shared Postgres via the existing enrichment seam, so a
     * federated row carries the SAME lastFire/lastStatus a local one would — the
     * sibling only had to hand over names + crontabs.
     */
    if (s.dbosSchedules?.length) {
      let federatedDbos: DbosScheduledEntry[] = [];
      try {
        federatedDbos = await enrichSiblingDbos(s.dbosSchedules);
      } catch {
        federatedDbos = [];
      }
      for (const d of federatedDbos) {
        if (localDbosNames.has(d.name)) continue;
        rows.push({
          source: 'dbos',
          scope: 'operator',
          tier: 'durable',
          category: 'dbos-scheduled',
          name: d.name,
          installSlug: null,
          cadence: d.crontab,
          armed: true, // registered in that process == live there
          lastFire: isoFromMs(d.lastFireMs),
          nextFire: null,
          lastError: null,
          groupSlug: null,
          detail: {
            mode: d.mode,
            queueName: d.queueName,
            lastStatus: d.lastStatus,
            process: s.label,
            federated: true,
            pid: s.pid,
            port: s.port,
          },
        });
      }
    }
  }

  /*
   * SYNC-TRIGGERED sweeps — recurring work whose cadence is "after each git-sync"
   * rather than a cron or an interval. They ran in the host for months while
   * being absent from every inventory and every owner-facing pane, because they
   * are neither a routines row nor a timer.
   *
   * The owner found this hole from the outside (2026-07-25: "in the docs tab
   * i'm seeing knowledge pack routines but what about the routine that checks
   * for drifted documentation?"). It was real: the sweep exists and runs, it
   * simply had no identity anywhere.
   *
   * Emitted as two rows because they are two different things with two
   * different risk profiles, and collapsing them would hide the one that costs
   * money:
   *   - DETECTION always runs and is free (a sha comparison).
   *   - REPAIR spawns an LLM agent per drift batch and is gated behind the
   *     owner-authority dark flag FLAGS.DOC_STEWARD.
   * `armed` is resolved from that flag, never assumed — reporting a disabled
   * agent-spawner as "running" is exactly the kind of confident-but-wrong
   * status this inventory exists to eliminate.
   */
  for (const s of syncTriggered) {
    // `armed: null` on the manifest means "ask the flag" — resolved once below,
    // never guessed. Reporting a disabled agent-spawner as running is exactly
    // the confident-but-wrong status this inventory exists to eliminate.
    const armed = s.armed !== null ? s.armed : s.flag ? await resolveFlagArmed(s.flag) : null;
    rows.push({
      source: 'in-process',
      scope: 'operator',
      tier: 'ephemeral',
      category: 'sync-triggered',
      name: s.name,
      installSlug: null,
      cadence: s.cadence,
      armed,
      lastFire: null,
      nextFire: null,
      lastError: null,
      groupSlug: null,
      detail: { source: s.source, spends: s.spends, ...(s.trigger ? { trigger: s.trigger } : {}), ...(s.flag ? { flag: s.flag } : {}), note: s.note },
    });
  }

  return rows.sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
}

/** Small rollup for headers/badges. */
export function summarizeInventory(rows: ScheduleInventoryRow[]): {
  total: number;
  bySource: Record<string, number>;
  byTier: Record<string, number>;
} {
  const bySource: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
  }
  return { total: rows.length, bySource, byTier };
}
