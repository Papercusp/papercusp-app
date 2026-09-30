/**
 * Cross-process managed-timer federation — the P-014 follow-on that
 * `schedule-inventory.ts`'s `ExternalProcessTimer` docstring has been naming as
 * pending ever since that file was written ("live fire-state requires
 * per-process federation … once each process exposes its managed-timer list
 * over its own admin/IPC").
 *
 * ## The bug this closes
 *
 * `schedule:inventory`'s `source: 'managed'` slice reads
 * `listManaged()` — the in-memory `managedSetInterval` registry of **whichever
 * process serves the call**. On this box that is the operator (:3070). But most
 * recurring sweeps do not run there: they run in `papercup-bg-host.service`, a
 * SEPARATE process off the same `bin/hono-host.ts` entrypoint. So every bg-host
 * timer was structurally invisible to the one surface built to inventory timers,
 * and an inventory that answers "that timer is not here" reads exactly like "that
 * timer does not exist".
 *
 * Measured cost (2026-08-03, EI-19445595198254637): `dbos-executor-reaper` failed
 * on EVERY pass for 6+ days on a float-to-bigint bind, and
 * `attention-reconcile-unanswerable` had never executed once. Neither was
 * detectable from `schedule:inventory`, because both live in bg-host. The
 * detector for "an armed timer is erroring" already existed and already carried
 * `armed` + `lastFire` + `lastError` — it was simply pointed at the wrong process.
 * **The defect was ROUTING, not a missing mechanism**, which is why the fix here
 * federates the existing registry instead of inventing a heartbeat.
 *
 * ## Discovery — reuses the registry that already exists
 *
 * Every operator-shaped process already publishes
 * `~/.papercusp/endpoint-ipc.<port>.json` on boot (`endpoint-ipc-discovery.ts`)
 * carrying `{ socketPath, pid, startedAt, port }`, and prunes siblings whose pid
 * is dead. That is a live process registry, so this module reads it rather than
 * hard-coding a unit→port map (which would silently rot the first time a port
 * moved). Self-exclusion is exact because the self-port is derived with the SAME
 * expression the writer uses (`Number(PAPERCUSP_HONO_PORT) || 3070`).
 *
 * ## Why PULL (bounded HTTP) and not PUSH (publish to Postgres)
 *
 * A push design needs a new table + a new publisher + a migration — a new durable
 * surface for what is a visibility gap. A wide search for an existing
 * process/instance/heartbeat-scoped table found nothing to extend. Pull matches an
 * existing pattern (`dev/build_status.ts` already probes sibling ports) and adds no
 * durable surface. Push only wins if HISTORY is later required; say so explicitly
 * if that requirement appears rather than drifting into it.
 *
 * ## The hard constraint: a sibling may be WEDGED, and must not take us with it
 *
 * bg-host is not reliably responsive. Measured the same day
 * (EI-19446421329946902): a `schedule:inventory` MCP call against :3271 returned
 * ZERO BYTES twice (30s, 45s) and its `/api/health` went unresponsive and then
 * recovered, while the process stayed alive and working. So this module is built
 * to degrade, never to block:
 *
 *  - a short per-probe timeout (`AbortSignal.timeout`, which aborts the body read
 *    too, not just the connect);
 *  - a hard OUTER budget, so even a probe that ignores its signal cannot hold the
 *    inventory hostage;
 *  - `probeSibling` NEVER rejects — every failure becomes an `ok: false` row, so a
 *    non-answering sibling renders as UNKNOWN rather than silently absent. Unknown
 *    is strictly better than invisible; invisible is the bug being fixed.
 *
 * The probe endpoint (`GET /api/internal/managed-timers`) is deliberately a pure
 * in-memory read with no DB and no DBOS call, so probing a contended sibling adds
 * no I/O of its own.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { ManagedEntry } from '@papercusp/scheduled-registry';
import type { RegisteredSchedule } from './dbos/dbos-schedule-introspect';
import type { StallWakerStatus } from './inference-gateway/stall-waker-loop';
import type { EndpointIpcProcessRole } from './endpoint-ipc-discovery';
import { backgroundWorkersEnabled } from './background-workers';

/** Loopback path each operator-shaped process serves its managed registry on. */
export const SIBLING_PROBE_PATH = '/api/internal/managed-timers';

/** Per-sibling probe deadline. Healthy answers are single-digit ms (pure memory read). */
export const DEFAULT_SIBLING_PROBE_TIMEOUT_MS = 1200;

/** Hard outer fan-out budget across ALL siblings — the backstop for a probe that ignores its signal. */
export const DEFAULT_SIBLING_FANOUT_BUDGET_MS = 2000;

/** A live sibling operator-shaped process, as advertised by its own discovery file. */
export interface SiblingOperator {
  port: number;
  pid: number;
  /** epoch ms the sibling published its discovery file (its boot time). */
  startedAt: number;
  /** Absent on legacy discovery files; new writers publish this to avoid HTTP role probes. */
  processRole?: EndpointIpcProcessRole;
}

/** One sibling's schedule slices, or the reason they could not be read. */
export interface SiblingManagedTimers {
  port: number;
  pid: number;
  /** Stable display label, e.g. `bg-host:3271`. Falls back to `operator:<port>` when the sibling never answered to self-identify. */
  label: string;
  /** The sibling's self-reported role, or null when it did not answer. */
  process: string | null;
  /** false ⇒ its schedules are UNKNOWN (not absent); read `error`. */
  ok: boolean;
  /** The sibling's `managedSetInterval` registry (ephemeral tier). */
  timers: ManagedEntry[];
  /**
   * The sibling's REGISTERED DBOS scheduled workflows (durable tier) — names +
   * crontabs only, deliberately WITHOUT fire-state.
   *
   * This slice is why the federation covers the bug it was filed for. DBOS keeps
   * its schedule registry "only in an in-process registry populated when the
   * workflow modules are imported" (dbos-schedule-introspect.ts), and the modules
   * behind `PAPERCUSP_BACKGROUND_WORKERS` are imported ONLY in bg-host — so both
   * sweeps that failed silently for 6+ days (`dbos-executor-reaper`,
   * `attention-reconcile-unanswerable`) live here, not in `timers`. Federating the
   * managed timers alone would have shipped a fix that missed its own case.
   *
   * Fire-state is deliberately NOT fetched by the sibling: it lives in shared
   * Postgres (`dbos.event_dispatch_kv`) and the OPERATOR enriches these names
   * through the existing `listDbosScheduledWorkflows({ getRegisteredSchedules })`
   * seam. That keeps the probe a pure in-memory read on the process least able to
   * afford I/O.
   */
  dbosSchedules: RegisteredSchedule[];
  /**
   * The sibling's OWN `getStallWakerStatus()` reading (EI-22054545312178322) —
   * `null` when the sibling didn't answer (`ok:false`), predates this field, or
   * its `stallWaker` payload was malformed. Piggybacked on this same route/probe
   * rather than a new endpoint, exactly like `dbosSchedules` was: the loop
   * boot-starts only where `PAPERCUSP_BACKGROUND_WORKERS=1` (bg-host today), so a
   * caller on a request-only host (:3070/:3170) needs this to learn the real,
   * production loop's state instead of its own always-`running:false` local copy.
   */
  stallWaker: StallWakerStatus | null;
  error?: string;
  probeFailure?: 'timeout';
  elapsedMs: number;
}

/**
 * EI-19454206016477347: the shape `/api/internal/managed-timers` carries when the
 * responding worker's `cluster-managed-timers-sync.ts` cache holds a snapshot pushed
 * by its true-cluster PRIMARY. Optional on the wire — omitted entirely by a
 * single-process host, or a worker whose cache has not received a first beat yet.
 */
interface PrimaryManagedTimersWireShape {
  pid?: unknown;
  role?: unknown;
  timers?: unknown;
  dbosSchedules?: unknown;
}

/**
 * This process's own role, as reported by `/api/internal/managed-timers` and used
 * to label federated rows. Kept deliberately coarse — `bg-host` vs `operator` — and
 * always paired with the port, so the label is unambiguous (`operator:3170` is the
 * staging operator) without a port→name map that could drift.
 */
export function describeProcessRole(env: NodeJS.ProcessEnv = process.env): string {
  return backgroundWorkersEnabled(env) ? 'bg-host' : 'operator';
}

/**
 * This process's serving port. MUST stay expression-identical to
 * `endpoint-ipc-discovery.ts`'s `writeEndpointIpcDiscovery` — self-exclusion in
 * `listSiblingOperators` is only exact because both sides derive the port the same
 * way; a divergence would make a process federate ITSELF and double-count its rows.
 */
export function ownHonoPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PAPERCUSP_HONO_PORT) || 3070;
}

/** `process.kill(pid, 0)` liveness — mirrors the copy in endpoint-ipc-discovery.ts. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = genuinely dead. EPERM = a process with that pid exists but is not
    // ours to signal — that still proves alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * The live sibling operator-shaped processes on this box, newest-port-first-stable.
 *
 * Reads ONLY the per-port discovery files. The legacy singleton
 * `endpoint-ipc.json` is deliberately skipped: it is last-writer-wins across every
 * operator on the box, so including it would either duplicate a per-port sibling or
 * point at a different (possibly dead) process than its filename implies.
 *
 * Fail-soft everywhere: a missing dir, a corrupt file, or a raced-away read yields
 * fewer siblings, never a throw.
 */
export async function listSiblingOperators(
  opts: {
    dir?: string;
    selfPort?: number;
    isAlive?: (pid: number) => boolean;
  } = {},
): Promise<SiblingOperator[]> {
  const dir = opts.dir ?? join(homedir(), '.papercusp');
  const selfPort = opts.selfPort ?? ownHonoPort();
  const alive = opts.isAlive ?? pidAlive;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out: SiblingOperator[] = [];
  for (const name of names) {
    const m = /^endpoint-ipc\.(\d+)\.json$/.exec(name);
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isFinite(port) || port <= 0 || port === selfPort) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        pid?: unknown;
        startedAt?: unknown;
        processRole?: unknown;
      };
      const pid = Number(parsed?.pid);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!alive(pid)) continue; // stale advertisement from a dead process
      const processRole = parsed.processRole === 'operator' || parsed.processRole === 'bg-host'
        ? parsed.processRole
        : undefined;
      out.push({
        port,
        pid,
        startedAt: Number(parsed?.startedAt) || 0,
        ...(processRole ? { processRole } : {}),
      });
    } catch {
      /* unreadable / corrupt / raced away — skip, never throw */
    }
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}

type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function degraded(
  s: SiblingOperator,
  error: string,
  elapsedMs: number,
  probeFailure?: 'timeout',
): SiblingManagedTimers {
  return {
    port: s.port,
    pid: s.pid,
    label: `operator:${s.port}`,
    process: null,
    ok: false,
    timers: [],
    dbosSchedules: [],
    stallWaker: null,
    error,
    ...(probeFailure ? { probeFailure } : {}),
    elapsedMs,
  };
}

/**
 * EI-19454206016477347: build the second federated row from a worker's optional
 * `primary` payload field — the true-cluster PRIMARY's own registries, pushed to the
 * answering worker over cluster IPC (`cluster-managed-timers-sync.ts`) because the
 * primary never itself serves this route (SO_REUSEPORT always lands the HTTP request
 * on a worker). `null` when the field is absent (single-process host, or a worker
 * whose cache has not received a first beat) or malformed (an older sibling build, or
 * a corrupt cache) — never fabricated.
 *
 * The row is labelled `${role}(primary via :${port})` rather than `${role}:${port}` so
 * a reader can tell at a glance this is NOT a process actually listening on that port —
 * it was reached only because the worker relayed it.
 */
function primaryRowFromWire(
  s: SiblingOperator,
  primary: PrimaryManagedTimersWireShape | null | undefined,
  elapsedMs: number,
): SiblingManagedTimers | null {
  if (
    !primary ||
    typeof primary.pid !== 'number' ||
    typeof primary.role !== 'string' ||
    !Array.isArray(primary.timers)
  ) {
    return null;
  }
  return {
    port: s.port,
    pid: primary.pid,
    label: `${primary.role}(primary via :${s.port})`,
    process: primary.role,
    ok: true,
    timers: primary.timers as ManagedEntry[],
    dbosSchedules: Array.isArray(primary.dbosSchedules)
      ? (primary.dbosSchedules as RegisteredSchedule[])
      : [],
    // EI-22054545312178322: the stall-waker loop is never relayed over this wire.
    // It boot-starts on a genuine single-process background-workers host (bg-host
    // today), not inside a true-cluster PRIMARY that forks request-serving workers
    // — no observed topology runs both at once — so there is no primary-side
    // reading to relay here. `probeSibling`'s own `workerRow` (which answers about
    // whichever process actually served the HTTP request) is the row that carries it.
    stallWaker: null,
    elapsedMs,
  };
}

/** Loosely validate + extract `body.stallWaker` from a sibling's `/internal/managed-timers`
 *  response — `null` for an older sibling build that predates this field, or a malformed
 *  payload, exactly like `dbosSchedules` degrades above. Only the `running` boolean is load-
 *  bearing for `dev:stall_waker_status`'s selection logic, but the whole snapshot is passed
 *  through once that much is trustworthy — cheaper than field-by-field validation and no
 *  riskier, since the source is loopback-only (`auth: 'loopback'`) same-box IPC, not a
 *  hostile network peer. */
function parseStallWaker(x: unknown): StallWakerStatus | null {
  if (!x || typeof x !== 'object' || typeof (x as { running?: unknown }).running !== 'boolean') {
    return null;
  }
  return x as StallWakerStatus;
}

/**
 * Probe ONE sibling. NEVER rejects — every failure (timeout, refused connection,
 * non-2xx, malformed body) becomes a single `ok: false` row. That invariant is what
 * lets the caller `Promise.all` these without a rejection path, and what lets the
 * outer budget race abandon them without producing an unhandled rejection.
 *
 * Returns 1 or 2 rows: the answering WORKER's own registries, plus — when its response
 * carries a `primary` field (EI-19454206016477347) — a second row for its true-cluster
 * PRIMARY, federated over the worker's cluster-IPC cache. A degraded (unreachable)
 * probe can only ever produce the single worker-shaped row: there is no primary to
 * relay when the worker itself never answered.
 */
export async function probeSibling(
  s: SiblingOperator,
  opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<SiblingManagedTimers[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SIBLING_PROBE_TIMEOUT_MS;
  const doFetch = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await doFetch(`http://127.0.0.1:${s.port}${SIBLING_PROBE_PATH}`, {
      // AbortSignal.timeout aborts the BODY read too, not just the connect — the
      // observed bg-host failure mode is a connection that opens and then returns
      // zero bytes for 45s, which a connect-only timeout would sail straight past.
      signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [degraded(s, `HTTP ${res.status}`, Date.now() - startedAt)];
    const body = (await res.json()) as {
      process?: unknown;
      timers?: unknown;
      dbosSchedules?: unknown;
      primary?: unknown;
      stallWaker?: unknown;
    };
    const proc = typeof body?.process === 'string' && body.process ? body.process : null;
    const timers = Array.isArray(body?.timers) ? (body.timers as ManagedEntry[]) : [];
    // A sibling running a build that predates the dbosSchedules slice simply omits
    // it — that degrades to "no durable rows from this process", never a throw.
    const dbosSchedules = Array.isArray(body?.dbosSchedules)
      ? (body.dbosSchedules as RegisteredSchedule[])
      : [];
    // EI-22054545312178322: same degrade-on-absence rule as dbosSchedules — an
    // older sibling build that predates this field, or a malformed payload, both
    // read as "unknown", never fabricated as not-running.
    const stallWaker = parseStallWaker(body?.stallWaker);
    const elapsedMs = Date.now() - startedAt;
    const workerRow: SiblingManagedTimers = {
      port: s.port,
      pid: s.pid,
      label: `${proc ?? 'operator'}:${s.port}`,
      process: proc,
      ok: true,
      timers,
      dbosSchedules,
      stallWaker,
      elapsedMs,
    };
    const primaryRow = primaryRowFromWire(
      s,
      body?.primary as PrimaryManagedTimersWireShape | null | undefined,
      elapsedMs,
    );
    return primaryRow ? [workerRow, primaryRow] : [workerRow];
  } catch (e) {
    return [
      degraded(
        s,
        e instanceof Error ? e.message : String(e),
        Date.now() - startedAt,
        signal.aborted ? 'timeout' : undefined,
      ),
    ];
  }
}

/** A budget timer that can never keep the process alive. */
function budgetExpiry<T>(ms: number, value: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(value()), ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Fan out to every live sibling and return their managed-timer slices.
 *
 * Bounded TWICE on purpose: each probe carries its own `AbortSignal.timeout`, and
 * each probe additionally races a hard budget. The second bound is not redundant —
 * it is what makes "a wedged sibling cannot block the operator's inventory" true
 * even if a fetch implementation mishandles its signal, which is precisely the class
 * of failure bg-host has already demonstrated.
 *
 * The budget is applied PER PROBE rather than to the whole fan-out, so one wedged
 * sibling degrades alone: the healthy siblings' timers still come back. A whole-set
 * race would have thrown away good data to punish one bad process — and since probes
 * run in parallel, total wall-clock is bounded by `budgetMs` either way.
 */
export async function collectSiblingManagedTimers(
  opts: {
    timeoutMs?: number;
    budgetMs?: number;
    siblings?: SiblingOperator[];
    fetchImpl?: FetchLike;
  } = {},
): Promise<SiblingManagedTimers[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SIBLING_PROBE_TIMEOUT_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_SIBLING_FANOUT_BUDGET_MS;
  const siblings = opts.siblings ?? (await listSiblingOperators().catch(() => []));
  if (!siblings.length) return [];

  // probeSibling never rejects, so a probe abandoned by the budget race settles
  // unobserved rather than surfacing as an unhandled rejection. Each settles to 1 or 2
  // rows (EI-19454206016477347: a worker row, plus an optional federated primary row) —
  // flattened here so every caller keeps seeing a flat SiblingManagedTimers[], same
  // shape as before this change.
  const perSibling = await Promise.all(
    siblings.map((s) =>
      Promise.race([
        probeSibling(s, { timeoutMs, fetchImpl: opts.fetchImpl }),
        budgetExpiry(budgetMs, () => [
          degraded(s, `probe budget ${budgetMs}ms exceeded`, budgetMs, 'timeout'),
        ]),
      ]),
    ),
  );
  return perSibling.flat();
}
