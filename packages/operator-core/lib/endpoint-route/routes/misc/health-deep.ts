/**
 * GET /api/health/deep — B4 (infra-fail-fast-build-integrity-2026-06-19):
 * SUBSYSTEM-exercising readiness.
 *
 * `/api/health` is pure liveness and `/api/health/ready` is BOOT readiness (DBOS
 * launched) — NEITHER exercises PG or memory. So during the 2026-06-19 :3070
 * outage the host reported "active"/ready (200) while mem0 was wedged
 * (better-sqlite3 ABI mismatch) and every memory-touching handler hung. This
 * probe ROUND-TRIPS PG (`SELECT 1`) + memory (`available()`) under a short
 * deadline, so "a wedged subsystem behind a green check" surfaces here as a 503.
 *
 * Additive — the existing liveness/boot probes are unchanged. Public + cheap
 * (one trivial query, hard deadline). Coordinates with self-healing D-001
 * (D-001 covers the loop-saturation-survival angle); this is the
 * subsystem-roundtrip angle.
 *
 * False-alarm guard: a CLEAN "memory disabled/unreachable" (`available()`
 * resolves `{ok:false}`) is NOT a failure — a memory-disabled host (NoopBackend)
 * is healthy. Only a HANG (deadline) or an unexpected throw counts as `down` —
 * which is exactly how the outage manifested (available() never resolved).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defineTool } from '@papercusp/agent-mcp';
import { BWRAP_BIN, BWRAP_USERNS_PROBE_ARGS } from '@papercusp/deployment-driver';
import { dbosLaunchesHere } from '../../../background-workers';
import { dbosStarted } from '../../../dbos/bootstrap';
import { getMemoryBackend } from '../../../memory/backend';
import { currentLoopLag, loopPressure } from '../../../event-loop-lag-monitor';
import { getCpuWorkerState, type CpuWorkerVerdict } from '../../../cpu-task-worker';

export type ProbeStatus = 'ok' | 'disabled' | 'down';

export interface SubsystemProbe {
  status: ProbeStatus;
  latencyMs: number;
  detail?: string;
}

/** Per-subsystem round-trip deadline. Generous enough for a cold pool, short
 *  enough that a wedge surfaces fast instead of riding a transport timeout. */
export const DEEP_PROBE_TIMEOUT_MS = 3_000;

/**
 * Race a probe against a deadline. The probe fn returns its non-failure status
 * (`ok` | `disabled`); a throw OR a timeout is mapped to `down`. Never throws.
 */
export async function probeSubsystem(
  fn: () => Promise<ProbeStatus>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<SubsystemProbe> {
  const t0 = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status, latencyMs: now() - t0 };
  } catch (err) {
    return { status: 'down', latencyMs: now() - t0, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pure readiness predicate (exported for tests). DBOS gates only when enabled
 * (mirrors `isReady` in health-ready). PG `down` is always not-ready (the
 * operator can't serve without PG). Memory `down` (hang/throw) is not-ready;
 * memory `disabled` is a fine config and does NOT gate.
 */
export function computeDeepReadiness(args: {
  dbosEnabled: boolean;
  dbosLaunched: boolean;
  pg: ProbeStatus;
  memory: ProbeStatus;
}): boolean {
  const dbosOk = args.dbosEnabled ? args.dbosLaunched : true;
  const pgOk = args.pg !== 'down';
  const memoryOk = args.memory !== 'down';
  return dbosOk && pgOk && memoryOk;
}

export interface LoopLagReading {
  /** 'ok' when no lag monitor is running (absence of signal, never a false-healthy claim). */
  pressure: 'ok' | 'elevated' | 'critical';
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** Native observations in the current reset window. */
  sampleCount: number | null;
  /** Elapsed time since the histogram's last reset. */
  windowMs: number | null;
  /** False when an early isolated maximum can still define p95. */
  windowMature: boolean | null;
}

/**
 * EI-19285078178745571: a 2026-08-01 incident had EVERY MCP tool call wedged for
 * ~17min while `/api/health` (and this deep probe's own PG/memory legs) kept
 * answering fast — because neither of those legs touches whether the event loop
 * itself is able to timely service queued work; they only prove PG/memory are
 * reachable FROM a loop iteration that got to run. The near-identical 2026-06-19
 * EI-79 outage (sustained synchronous CPU work starving the loop) had the SAME
 * blind spot and is exactly what `event-loop-lag-monitor.ts`'s standing gauge was
 * built to make "self-evident next time" — but that gauge only ever reached a
 * structured console.warn, never an HTTP-visible signal. Surfacing it here closes
 * that gap for an external monitor/dashboard without guessing at a mechanism this
 * file can't reproduce.
 *
 * Deliberately does NOT gate `ready`/503: unlike PG/memory (binary reachable-or-not,
 * and the operator genuinely cannot serve without them), loop pressure is a
 * continuous signal the admission-control layer (mcp-admission.ts) already sheds
 * NEW requests on at the 'critical' band — flipping deep-health to 503 on the same
 * signal would just duplicate that shedding at the readiness layer (risking a
 * legitimate load-balancer / process-supervisor overreaction to a transient,
 * self-recovering spike) instead of adding new information. This is a read-only
 * diagnostic: the raw p95/p99/max let a human or monitor see "the loop was under
 * pressure" even when no threshold breach reads as a hard failure.
 */
export function readLoopLag(): LoopLagReading {
  const lag = currentLoopLag();
  return {
    pressure: loopPressure(),
    p95Ms: lag?.p95Ms ?? null,
    p99Ms: lag?.p99Ms ?? null,
    maxMs: lag?.maxMs ?? null,
    sampleCount: lag?.sampleCount ?? null,
    windowMs: lag?.windowMs ?? null,
    windowMature: lag?.windowMature ?? null,
  };
}

export interface CpuWorkerReading {
  /** A worker thread currently exists (it is spawned lazily, on first offload). */
  alive: boolean;
  /**
   * The crash-breaker has LATCHED: this process has stopped offloading and every
   * serialization now runs inline. Since EI-20505664003243915 this is no longer
   * permanent — the breaker re-arms itself; `reArmInMs` says when the next
   * half-open probe is admitted.
   *
   * ⚠ Do NOT alert on this field alone: `disabled:false` is an ABSENCE of bad
   * news, not evidence the offload works. Read `verdict`.
   */
  disabled: boolean;
  pendingCount: number;
  /** Batch size at/above which work is offloaded (for reading the two counts). */
  minItems: number;
  keepAlive: boolean;
  /** Crashes since the last request the worker actually served (breaker trips at 3). */
  consecutiveCrashes: number;
  /**
   * Requests the worker thread has actually SERVED — the only positive signal
   * here, and the one the reporting item asked for: it proves worker-served
   * requests RESUME rather than merely that a latch was cleared.
   */
  servedByWorker: number;
  /** Offload-ELIGIBLE requests that ran inline anyway (small batches excluded). */
  eligibleFallbacks: number;
  /** Message of the most recent worker crash, or null if none this process. */
  lastCrashError: string | null;
  /** Breaker closures earned by a served probe (NOT by a restart). */
  reArms: number;
  /** Half-open probes that crashed; each doubles the next cooldown. */
  reArmFailures: number;
  /** ms until the next half-open probe; null when the breaker is closed. */
  reArmInMs: number | null;
  /**
   * The reading `disabled` cannot give — 'serving' | 'idle-unproven' |
   * 'silently-falling-back' | 'disabled'. The middle two BOTH report
   * `disabled:false`, and telling them apart is the whole point.
   */
  verdict: CpuWorkerVerdict;
}

/**
 * WI-37696: the CPU-offload crash-breaker, made observable.
 *
 * `cpu-task-worker.ts` exists to keep large JSON serialization off the main
 * thread — inline it costs 30-50ms/tick of event-loop lag. It also has a sync
 * fallback, and that combination is what makes its breaker dangerous: when
 * `disabled` latches, the process keeps emitting BYTE-IDENTICAL responses with
 * no error, no log line and no exit code. The offload simply goes away —
 * permanently, and re-introducing exactly the lag the module was written to
 * remove. "Silent + permanent" is strictly harder to triage than "loud +
 * intermittent", and until this wiring NOTHING read `getCpuWorkerState()` at
 * all (its own doc comment claimed this endpoint and the loop-monitor
 * dashboard; neither actually called it).
 *
 * Answered for THIS PROCESS on purpose. The state is module-global to the host
 * that runs the worker, so only the host serving this request can report it —
 * and `cpu-task-worker` is genuinely loaded here (`rest-query.ts`,
 * `sync-read-audit.ts`). The SIBLING breakers in `@papercusp/memory` and
 * `@papercusp/rerank` are deliberately NOT reported here: those workers spawn in
 * the embed-sidecar process, so importing them into this handler would load a
 * module this host never uses and report a pristine `disabled: false` — a false
 * all-clear, which is a worse outcome than no signal. They are surfaced by the
 * sidecar's own `/healthz`.
 *
 * Report-only, exactly like `readLoopLag` above: an offload that fell back is
 * DEGRADED, not unserviceable. Gating readiness on it would hand a supervisor a
 * reason to restart a host that is serving correct responses.
 */
export function readCpuWorker(): CpuWorkerReading {
  return getCpuWorkerState();
}

/**
 * The MCP proxy's OWN local health path. operator-core must not import from
 * `apps/`, so this literal is a deliberate second copy of
 * `MCP_PROXY_LOCAL_HEALTH_PATH` (apps/operator/lib/mcp-proxy/budgets.mjs) —
 * PINNED, not derived: `health-deep-mcp-plane.test.ts` reads that file and fails
 * if the two ever diverge (the derived-truth ladder's PIN rung).
 */
export const MCP_PROXY_HEALTH_PATH = '/__mcp_proxy_health';
/** Short: the plane is either answering promptly or it is the thing being reported on. */
export const MCP_PLANE_PROBE_TIMEOUT_MS = 1_500;
/** Fraction of a class ceiling at which occupancy reads as 'elevated'. */
export const MCP_PLANE_ELEVATED_UTILIZATION = 0.75;

export type McpPlanePressure = 'ok' | 'elevated' | 'saturated' | 'unknown';

/** Per-class occupancy as the proxy reports it. EVERY field is optional on purpose: a
 *  running proxy may predate (or postdate) any given field — the deployed one at the time
 *  of writing had no `criticalContinuationQueue` while the committed source did. */
export interface McpInFlightSnapshot {
  total?: number;
  ordinary?: number;
  ordinaryCeiling?: number;
  reservedControlPlane?: number;
  reservedControlPlaneCeiling?: number;
  criticalContinuation?: number;
  criticalContinuationQueue?: {
    waiting?: number;
    max?: number;
    oldestAgeMs?: number | null;
    /** The queue's own wait budget; a waiter past it is dropped. */
    maxWaitMs?: number;
  };
  maxInFlight?: number;
  oldestAgeMs?: Record<string, number | null>;
}

export interface McpPlaneReading {
  /** 'ok' = proxy answered · 'down' = unreachable/unparseable (that IS the finding). */
  status: ProbeStatus;
  latencyMs: number;
  pressure: McpPlanePressure;
  detail?: string;
  inFlight: McpInFlightSnapshot | null;
}

/**
 * PURE + unit-tested occupancy verdict.
 *
 * ⚠ The `critical-continuation` class is a SINGLE-FLIGHT BULKHEAD: its ceiling is 1, so
 * 1-of-1 in flight is its NORMAL WORKING STATE, not saturation. It is judged by whether
 * work is QUEUED behind that one slot — never by the slot being occupied. Counting 1/1 as
 * saturated would pin this signal permanently red (the live proxy sat at exactly
 * criticalContinuation:1 while healthy), and a signal that is always red is one readers
 * learn to ignore — the precise failure this whole probe exists to prevent.
 */
export function classifyMcpPressure(f: McpInFlightSnapshot | null): McpPlanePressure {
  if (!f) return 'unknown';
  const ratios: number[] = [];
  const add = (n: unknown, d: unknown): void => {
    if (typeof n === 'number' && typeof d === 'number' && d > 0) ratios.push(n / d);
  };
  add(f.ordinary, f.ordinaryCeiling);
  add(f.reservedControlPlane, f.reservedControlPlaneCeiling);
  add(f.total, f.maxInFlight);
  const q = f.criticalContinuationQueue;
  if (q && typeof q.waiting === 'number' && q.waiting > 0) {
    ratios.push(typeof q.max === 'number' && q.max > 0 ? Math.min(1, q.waiting / q.max) : 1);
    // Depth alone hides the shape that produced this bug: ONE request starving behind
    // the single slot until the CLIENT's own timer fires. A queue 2-deep reads shallow
    // while its oldest waiter sits at 29s of a 30s budget, so age-against-budget is the
    // leg that actually sees the silent-timeout case.
    if (typeof q.oldestAgeMs === 'number' && typeof q.maxWaitMs === 'number' && q.maxWaitMs > 0) {
      ratios.push(Math.min(1, q.oldestAgeMs / q.maxWaitMs));
    }
  }
  if (ratios.length === 0) return 'unknown';
  const peak = Math.max(...ratios);
  if (peak >= 1) return 'saturated';
  if (peak >= MCP_PLANE_ELEVATED_UTILIZATION) return 'elevated';
  return 'ok';
}

/**
 * EI-21524598788382723 — the gap this closes. `/api/health` answers 200 in ~4ms and
 * `/api/health/deep` exercised FIVE subsystems (pg, memory, loop lag, cpu worker, dbos)
 * while omitting the one plane every agent's every tool call traverses. So the documented
 * symptom was a green health check beside a plane that was shedding or timing out every
 * call — an agent reading "health 200" concludes its TOOL is broken and goes and
 * investigates the wrong subsystem.
 *
 * `loopLag` above was added after EI-19285078178745571 (2026-08-01: every MCP call wedged
 * ~17min while /api/health answered fast) and is the closest prior signal — but it is a
 * PROXY for this plane, not this plane. The event loop can be perfectly healthy while the
 * proxy sheds every request on admission: measured 2026-08-27, loopLag read `ok` (p95
 * 38ms) in the same minutes durability writes were being shed `mcp_proxy_overloaded`.
 *
 * Deliberately does NOT gate `ready`/503 — same reasoning the loopLag docstring gives, and
 * it matters MORE here: shedding is the admission guard WORKING, and a busy proxy flipping
 * :3070 to 503 would invite a supervisor/deploy health-probe to treat a healthy host as
 * failed and roll it back. Report-only, additive; every existing leg is unchanged.
 */
export async function readMcpPlane(): Promise<McpPlaneReading> {
  const t0 = Date.now();
  const port = Number(process.env.PAPERCUSP_MCP_PROXY_PORT ?? 9071);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${MCP_PROXY_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(MCP_PLANE_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        status: 'down',
        latencyMs: Date.now() - t0,
        pressure: 'unknown',
        inFlight: null,
        detail: `proxy health returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { inFlight?: McpInFlightSnapshot } | null;
    const inFlight = body?.inFlight ?? null;
    return {
      status: 'ok',
      latencyMs: Date.now() - t0,
      pressure: classifyMcpPressure(inFlight),
      inFlight,
    };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Date.now() - t0,
      pressure: 'unknown',
      inFlight: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Agent sandbox (WI-10004649). Codex runs every sandboxed command under bwrap with a new user,
// pid and net namespace. Where the kernel refuses an unprivileged user namespace (stock Ubuntu
// 24.04 without the AppArmor bwrap grant, or a foreign profile overriding it) every such
// command fails, and nothing else on the host reports it: the Server .deb postinst only WARNs
// when the grant does not load. This leg runs the SAME probe the hosted bootstrap dies on
// (`BWRAP_USERNS_PROBE_ARGS`, @papercusp/deployment-driver), as the account this process runs
// agents under.
//
// Report-only, like the loop-lag / cpu-worker / MCP-plane legs: a missing sandbox degrades
// agents but the server still serves, and a 503 here would make deploy health checks roll back
// or restart a host for an OS setting no restart can fix. `status: 'down'` IS the alert.
// ---------------------------------------------------------------------------------------------

/**
 * ok = the namespaces were created; disabled = not Linux (no bwrap sandbox); down = it cannot
 * sandbox (bwrap missing or exited non-zero); unknown = no answer yet (the probe overran its
 * deadline or is still running). A timeout is never `down`: on this tower the same probe took
 * 80 ms to over 5 s under load (measured 2026-10-01), so a deadline says nothing about the sandbox.
 */
export type AgentSandboxStatus = 'ok' | 'disabled' | 'down' | 'unknown';

export interface AgentSandboxReading {
  status: AgentSandboxStatus;
  /** Why it is down or unknown (bwrap's own first stderr line, a missing binary, a timeout); null when ok. */
  detail: string | null;
  checkedAt: string;
}

/** The probe spawns a process, so its answer is reused for this long. */
export const AGENT_SANDBOX_PROBE_TTL_MS = 10 * 60_000;
export const AGENT_SANDBOX_PROBE_TIMEOUT_MS = 30_000;

export interface AgentSandboxProbeDeps {
  platform: () => NodeJS.Platform;
  exists: (file: string) => boolean;
  run: (bin: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stderr: string; error?: string }>;
  now: () => number;
}

/**
 * Run a probe command with a deadline that a stalled event loop cannot turn into a false
 * timeout. `execFile`'s own `timeout` kills from the timers phase, which runs BEFORE the poll
 * phase that delivers the child's exit: a loop blocked past the deadline (measured 2026-10-01:
 * 5.3 s of module start-up right before the first probe) killed an already-exited 85 ms bwrap
 * and reported the sandbox down. Here the deadline only schedules the kill for the check phase,
 * after any pending exit has been processed.
 */
export function runProbeCommand(bin: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: { code: number | null; stderr: string; error?: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 4096) stderr += d;
    });
    child.on('error', (e) => done({ code: null, stderr, error: e.message }));
    child.on('close', (code) => done({ code, stderr }));
    timer = setTimeout(
      () =>
        setImmediate(() => {
          if (settled || child.exitCode !== null || child.signalCode !== null) return;
          child.kill('SIGKILL');
          done({ code: null, stderr, error: `timeout after ${timeoutMs}ms` });
        }),
      timeoutMs,
    );
  });
}

const defaultAgentSandboxDeps: AgentSandboxProbeDeps = {
  platform: () => process.platform,
  exists: (file) => existsSync(file),
  run: runProbeCommand,
  now: Date.now,
};

/** One probe run. Never throws. */
export async function probeAgentSandbox(deps: AgentSandboxProbeDeps = defaultAgentSandboxDeps): Promise<AgentSandboxReading> {
  const checkedAt = new Date(deps.now()).toISOString();
  if (deps.platform() !== 'linux') return { status: 'disabled', detail: null, checkedAt };
  if (!deps.exists(BWRAP_BIN)) return { status: 'down', detail: `bwrap is not installed (${BWRAP_BIN})`, checkedAt };
  try {
    const r = await deps.run(BWRAP_BIN, BWRAP_USERNS_PROBE_ARGS, AGENT_SANDBOX_PROBE_TIMEOUT_MS);
    if (r.code === 0) return { status: 'ok', detail: null, checkedAt };
    if (r.code === null && r.error?.startsWith('timeout')) return { status: 'unknown', detail: r.error, checkedAt };
    const first = r.stderr.split('\n').map((l) => l.trim()).find(Boolean);
    return { status: 'down', detail: (first ?? r.error ?? `bwrap exited ${r.code}`).slice(0, 300), checkedAt };
  } catch (err) {
    return { status: 'down', detail: err instanceof Error ? err.message : String(err), checkedAt };
  }
}

let agentSandboxCache: { at: number; reading: AgentSandboxReading } | null = null;
let agentSandboxInflight: Promise<AgentSandboxReading> | null = null;

/**
 * The probe answer without ever holding a health response for the probe's own deadline:
 * a fresh cached answer is returned as is; a stale one is returned while one background
 * re-probe runs (concurrent readers share it); with no answer yet the read waits at most
 * `waitMs` and then reports `unknown`. Only a definitive answer is cached, so an `unknown`
 * is re-probed on the next read.
 */
export async function readAgentSandbox(
  deps: AgentSandboxProbeDeps = defaultAgentSandboxDeps,
  waitMs: number = DEEP_PROBE_TIMEOUT_MS,
): Promise<AgentSandboxReading> {
  const cached = agentSandboxCache;
  if (cached && deps.now() - cached.at < AGENT_SANDBOX_PROBE_TTL_MS) return cached.reading;
  agentSandboxInflight ??= probeAgentSandbox(deps)
    .then((reading) => {
      if (reading.status !== 'unknown') agentSandboxCache = { at: deps.now(), reading };
      return reading;
    })
    .finally(() => {
      agentSandboxInflight = null;
    });
  if (cached) return cached.reading;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<AgentSandboxReading>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unknown', detail: 'probe still running', checkedAt: new Date(deps.now()).toISOString() }), waitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([agentSandboxInflight, waited]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test-only. */
export function __resetAgentSandboxCache(): void {
  agentSandboxCache = null;
  agentSandboxInflight = null;
}

export default defineTool({
  method: 'GET',
  path: '/health/deep',
  auth: 'public',
  async handler() {
    // "Does THIS process run DBOS" — NOT the bare PAPERCUSP_DBOS_ENABLE env flag
    // (set in the shared .env.local that every host sources). A request-only host
    // (BACKGROUND_WORKERS=0, e.g. :3070) delegates DBOS to the bg-host, so its local
    // dbosStarted() is false BY DESIGN and must not perpetually gate readiness to 503.
    const dbosEnabled = dbosLaunchesHere();
    const dbos = dbosStarted();

    const [pg, memory, mcpPlane, agentSandbox] = await Promise.all([
      probeSubsystem(async () => {
        const { getOrgPg } = await import('@papercusp/db-org');
        await getOrgPg().sql`SELECT 1`;
        return 'ok';
      }, DEEP_PROBE_TIMEOUT_MS),
      probeSubsystem(async () => {
        const avail = await getMemoryBackend().available();
        // A clean {ok:false} means deliberately disabled / cleanly unreachable —
        // NOT the wedge we're guarding against (that HANGS → caught as 'down').
        return avail.ok ? 'ok' : 'disabled';
      }, DEEP_PROBE_TIMEOUT_MS),
      // Carries its own deadline + never throws, so it needs no probeSubsystem race:
      // an unreachable proxy IS the reading, not a failed probe.
      readMcpPlane(),
      // Cached, never throws, report-only (see the Agent sandbox section above).
      readAgentSandbox(),
    ]);
    // Synchronous, cheap (a native histogram read) — no deadline race needed.
    const loopLag = readLoopLag();
    // Same: a plain module-state snapshot, no I/O.
    const cpuWorker = readCpuWorker();

    const ready = computeDeepReadiness({
      dbosEnabled,
      dbosLaunched: dbos,
      pg: pg.status,
      memory: memory.status,
    });

    return Response.json(
      { ok: ready, ready, dbos, dbosEnabled, pg, memory, loopLag, cpuWorker, mcpPlane, agentSandbox, ts: new Date().toISOString() },
      { status: ready ? 200 : 503 },
    );
  },
});
