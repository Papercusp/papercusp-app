/**
 * GET /api/internal/managed-timers — THIS process's live managed-timer registry.
 *
 * The federation seam for `schedule:inventory` (EI-19445595198254637). Every
 * operator-shaped process on the box — the operator (:3070), staging (:3170),
 * `papercup-bg-host.service` (:3271) — boots the same `bin/hono-host.ts`, so every
 * one of them serves this route, and each answers about ITSELF. The operator's
 * inventory fans out over them (`schedule-federation.ts`) so a timer armed in
 * bg-host stops being structurally invisible to the surface built to inventory
 * timers.
 *
 * Two properties are load-bearing, not incidental:
 *
 * 1. **Pure in-memory.** `listManaged()` reads a module-scoped registry: no PG, no
 *    DBOS, no filesystem. That matters because the sibling most worth probing
 *    (bg-host) is also the one most likely to be contended — probing it must add no
 *    I/O of its own. This is deliberately NOT `collectScheduleInventory()`, which
 *    queries Postgres and DBOS and is the call that was measured returning zero
 *    bytes for 45s against :3271 (EI-19446421329946902).
 *
 * 2. **Never 5xx.** A registry read that throws is reported in the 200 body as
 *    `ok: false` + `error`, mirroring the PASS-WITH-NOTE contract of the sibling
 *    canary routes. A broken probe apparatus must not read to a naive caller as
 *    "this process is unhealthy".
 *
 * `auth: 'loopback'` — the only caller is another operator process on the same box.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  listManaged,
  moduleDuplicationWarning,
  moduleEvaluationCount,
} from '@papercusp/scheduled-registry';
import {
  formatModuleDuplicationWarnings,
  listModuleDuplications,
} from '@papercusp/module-singleton';
import { defaultGetRegisteredSchedules } from '../../../dbos/dbos-schedule-introspect';
import { describeProcessRole, ownHonoPort } from '../../../schedule-federation';
import { getCachedPrimaryManagedTimers } from '../../../cluster-managed-timers-sync';
import { getStallWakerStatus } from '../../../inference-gateway/stall-waker-loop';

export default defineTool({
  method: 'GET',
  path: '/internal/managed-timers',
  auth: 'loopback',
  async handler() {
    const identity = {
      process: describeProcessRole(),
      pid: process.pid,
      port: ownHonoPort(),
      uptimeSec: Math.round(process.uptime()),
    };
    // BOTH per-process registries, because both are per-process and the caller
    // cannot see either one from outside:
    //  - `timers`         = the managedSetInterval registry (ephemeral tier)
    //  - `dbosSchedules`  = the DBOS scheduled-workflow REGISTRY (durable tier),
    //    which DBOS populates only when the workflow modules are imported. The
    //    modules behind PAPERCUSP_BACKGROUND_WORKERS are imported ONLY in bg-host,
    //    which is exactly where `dbos-executor-reaper` and
    //    `attention-reconcile-unanswerable` live — so omitting this slice would ship
    //    a federation that misses the very outage that motivated it.
    // Names + crontabs only: fire-state lives in shared Postgres and is enriched by
    // the CALLER, keeping this handler a pure in-memory read.
    let timers: ReturnType<typeof listManaged> = [];
    let timersError: string | null = null;
    try {
      timers = listManaged();
    } catch (e) {
      timersError = e instanceof Error ? e.message : String(e);
    }
    let dbosSchedules: Awaited<ReturnType<typeof defaultGetRegisteredSchedules>> = [];
    try {
      dbosSchedules = await defaultGetRegisteredSchedules();
    } catch {
      // defaultGetRegisteredSchedules already swallows its own errors and returns
      // []; this is belt-and-braces so one registry can never take out the other.
    }
    // Self-trust report (EI-19463700807328229). The original outage was an
    // inventory that was HALF of one while looking complete — the reader had no
    // way to tell. `moduleEvaluations` is that missing signal: > 1 means this
    // module is duplicated in this process, so any NEW module-scoped state added
    // to the registry would split. It travels WITH the timer list rather than as
    // a separate health endpoint, because a separate endpoint is precisely what
    // nobody thought to call for six days.
    let moduleEvaluations: number | null = null;
    let moduleDuplication: string | null = null;
    try {
      moduleEvaluations = moduleEvaluationCount();
      moduleDuplication = moduleDuplicationWarning();
    } catch {
      // An older @papercusp/scheduled-registry build without these exports must
      // degrade to "unknown", never take out the timer list itself.
    }
    // The REALM-WIDE version of the same signal. The two fields above describe
    // one module; this describes every module pinned through
    // `@papercusp/module-singleton`, so a split in some OTHER shared singleton —
    // a cache, a connection pool, a "configure once at boot" config object — is
    // reported by a surface someone actually reads, instead of waiting to be
    // discovered from a contradictory reading the way the timer registry was.
    //
    // `[]` here means "no duplication among keys that use the primitive". It is
    // NOT a clean bill of health for modules that still pin their state by hand:
    // those are invisible to this report by construction, which is the whole
    // reason @papercusp/scheduled-registry stopped hand-rolling its own pin.
    let moduleDuplications: ReturnType<typeof listModuleDuplications> = [];
    try {
      moduleDuplications = listModuleDuplications();
    } catch {
      // Same degradation rule as above: a diagnostic must never be able to take
      // out the inventory it annotates.
    }
    // EI-19454206016477347: this WORKER's own registries above never include the
    // true-cluster PRIMARY's — the primary owns the background machinery but never
    // itself serves this route (SO_REUSEPORT always lands the request on a worker).
    // `getCachedPrimaryManagedTimers()` is a pure sync read of the latest snapshot the
    // primary pushed over cluster IPC (cluster-managed-timers-sync.ts, mirroring
    // EI-8816's booted-handles PUSH). `null` in a single-process / non-clustered host
    // (the primary never broadcasts there) or before the first beat arrives — the field
    // is simply omitted in that case, never a fabricated empty snapshot.
    const cachedPrimary = getCachedPrimaryManagedTimers();
    // EI-22054545312178322: this WORKER's own StallWakerStatus reading — always a
    // pure in-process read (mirrors getStallWakerStatus's own contract of "this
    // function stays a pure, honest LOCAL read"). A caller on a request-only host
    // reads `running:false` here for THIS process, exactly as it should; federating
    // to find the loop's real production home (bg-host) is schedule-federation.ts's
    // job on the CALLING side, not this route's. Never wrapped in try/catch:
    // getStallWakerStatus() only reads module-scope primitives (booleans, numbers,
    // a Map) and cannot throw.
    const stallWaker = getStallWakerStatus();
    return Response.json({
      ok: timersError === null,
      ...identity,
      timers,
      dbosSchedules,
      stallWaker,
      moduleEvaluations,
      ...(moduleDuplication ? { moduleDuplication } : {}),
      ...(moduleDuplications.length > 0
        ? {
            moduleDuplications,
            moduleDuplicationWarnings: formatModuleDuplicationWarnings(moduleDuplications),
          }
        : {}),
      ...(cachedPrimary
        ? {
            primary: {
              pid: cachedPrimary.pid,
              role: cachedPrimary.role,
              timers: cachedPrimary.timers,
              dbosSchedules: cachedPrimary.dbosSchedules,
              sentAt: cachedPrimary.sentAt,
              staleMs: Date.now() - cachedPrimary.receivedAt,
            },
          }
        : {}),
      ...(timersError ? { error: timersError } : {}),
    });
  },
});
