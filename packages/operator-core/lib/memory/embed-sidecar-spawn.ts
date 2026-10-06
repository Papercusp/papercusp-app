/**
 * Embedding sidecar spawner (P-002, plan
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Cloned from fleet/spawner-sidecar-spawn.ts (which cloned the substrate one) —
 * the third node-child sidecar, same supervision mechanics so all three behave
 * identically: ready-line handshake, crash auto-respawn with backoff + a
 * sliding-window circuit breaker, graceful-stop shutdown hooks, and a pure
 * supervision-status snapshot for dev:service_health.
 *
 * Spawns apps/operator/bin/embed-sidecar.ts (dev) or re-execs the bundle with
 * PAPERCUSP_EMBED_SIDECAR_MODE=1 (packaged). Rollout control is a PER-HOST env
 * opt-in — PAPERCUSP_EMBED_SIDECAR=1 — mirroring the spawner sidecar's v1
 * (orchestrator-runner.ts): embedding hosts differ (bg-host embeds constantly,
 * a desktop install rarely), so a fleet-wide flag flip is the wrong shape.
 *
 * Everything here is dark — the OFF path never spawns. Since WI-4021 (D-003
 * retired) a host that RESOLVES a sidecar URL requires it: embed failures
 * throw (writes park in the memory write journal) instead of failing over to
 * an in-process model. ensureEmbedSidecar() returning null while the spawner
 * is DISABLED leaves the caller on the pure in-process engine — that path is
 * for hosts with no sidecar story at all, not an outage fallback. While it is
 * ENABLED, null only means "not up yet" (e.g. a start that timed out): the
 * wiring still hands the client an ensure hook and the client stays
 * sidecar-only (WI-10005932).
 * Hosts with the systemd-owned sidecar (papercup-embed-sidecar.service)
 * should set PAPERCUSP_EMBED_SIDECAR_URL and never enable this spawner.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { papercuspDataDir } from '../own-tunnel/runtime';
import {
  resolveSidecarSpawnPlan,
  gracefulStopChild,
  respawnBackoffMs,
  pruneRespawnWindow,
  respawnBudgetExhausted,
  registerSidecarShutdownHooks as registerSharedSidecarShutdownHooks,
  verifySidecarFitness,
  loopbackListenerUids,
  loopbackListenerOwnedBy,
  type SidecarFitness,
} from '../process-supervision/sidecar-spawn-shared';
import { isBenignHostError } from '../host-benign-errors';
import {
  EMBED_SIDECAR_DEFAULT_PORT,
  EMBED_SIDECAR_LEGACY_CAPABILITIES,
  EMBED_SIDECAR_PORT_ENV,
  EMBED_SIDECAR_READY_LINE,
  EMBED_SIDECAR_IDLE_EXIT_LINE,
  EMBED_SIDECAR_IDLE_EXIT_ENV,
} from './embed-sidecar-server';

/** Per-host switch. '1' = on; any other SET value ('0', '') = off; unset = the
 *  P-532 default (on inside a sidecar-capable bundle, see embedSidecarEnabled). */
export const EMBED_SIDECAR_ENABLE_ENV = 'PAPERCUSP_EMBED_SIDECAR';

/**
 * P-532 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): the built
 * entries whose own boot diverts PAPERCUSP_EMBED_SIDECAR_MODE=1 to
 * runEmbedSidecarServer, so re-exec'ing them yields a sidecar and not a second
 * full host. serve.mjs = the packaged / hosted Server and the desktop app;
 * hono-host.mjs = the operator host bundle. embed-sidecar-default-on.test.ts
 * pins each name to an entry source that still carries the divert.
 */
export const EMBED_SIDECAR_REEXEC_ENTRIES: readonly string[] = ['serve.mjs', 'hono-host.mjs'];

/**
 * P-532: idle window after which a sidecar THIS Server spawned exits, returning
 * the model's memory (~1 GB) to the host. The next embed re-spawns it (model
 * load ~2 s, inside the 15 s embed budget).
 */
export const EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS = 5 * 60_000;

/** WI-10005932: override for how long a spawned child may take to print its READY line. */
export const EMBED_SIDECAR_STARTUP_TIMEOUT_ENV = 'PAPERCUSP_EMBED_SIDECAR_STARTUP_TIMEOUT_MS';

/**
 * WI-10005932: default READY deadline for a spawned sidecar. It was 10 s. On a
 * 4-vCPU host with three packaged Servers cold-booting at once (P-532d), the
 * re-exec'd bundle needed about 10 s just to reach READY. The parent then killed
 * a healthy child four times in a row, each respawn repeating the same startup
 * cost, and stopped one attempt short of the circuit breaker. The deadline only
 * has to catch a wedged child, so it is set well above contended startup.
 */
export const EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/** WI-10005932: READY deadline for a spawned child; a positive integer env override wins. */
export function embedSidecarStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[EMBED_SIDECAR_STARTUP_TIMEOUT_ENV]?.trim();
  if (!raw) return EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS;
}

// ESM (type:module) — derive the module dir from import.meta (EI-1612 shape).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let sidecarProcess: ChildProcess | null = null;
let sidecarReady = false;
/** P-531: the running child announced a deliberate idle exit and has not exited
 *  yet. Set from the IDLE_EXIT stdout line, cleared on exit/error. */
let idleExitPending = false;
/** P-532b: the last child exit was an announced idle exit and no child has started since.
 *  Cleared by a crash or a new spawn, so a crashed sidecar is never mistaken for an idle one. */
let lastExitIdle = false;
/** P-530: the port the running child announced on its READY line. Null until
 *  the child is ready and again once it exits. */
let spawnedPort: number | null = null;
const readyWaiters: (() => void)[] = [];

let deliberateStop = false;
export const MAX_RESPAWN_ATTEMPTS = 5;
export const RESPAWN_WINDOW_MS = 5 * 60_000;
let respawnAttempts: number[] = []; // timestamps (ms) of recent auto-respawn schedules
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let gaveUp = false;

/** P-532: is this module running inside a built entry that can re-exec itself as the sidecar? */
export function runningFromSidecarCapableBundle(selfPath: string = fileURLToPath(import.meta.url)): boolean {
  return EMBED_SIDECAR_REEXEC_ENTRIES.includes(path.basename(selfPath));
}

/**
 * Is the embed sidecar enabled on THIS host? Evaluated per call so tests and
 * late exports can flip it.
 *
 * P-532: an explicit PAPERCUSP_EMBED_SIDECAR always wins ('1' on, anything else
 * off). Unset, it defaults ON inside a sidecar-capable bundle (packaged / hosted
 * Server, desktop, operator host) and OFF when running from source (tsx dev
 * processes, scripts, tests), which would otherwise re-exec a .ts entry per
 * process. An explicit PAPERCUSP_EMBED_SIDECAR_URL still takes precedence over
 * either in every consumer (resolveProcessSidecarUrl's order).
 */
export function embedSidecarEnabled(
  env: NodeJS.ProcessEnv = process.env,
  selfPath: string = fileURLToPath(import.meta.url),
): boolean {
  // Never inside a sidecar process itself (any *_SIDECAR_MODE) — a sidecar
  // spawning sidecars is the recursion the mode-divert exists to prevent.
  if (env.PAPERCUSP_EMBED_SIDECAR_MODE === '1') return false;
  const raw = env[EMBED_SIDECAR_ENABLE_ENV];
  if (raw !== undefined) return raw.trim() === '1';
  return runningFromSidecarCapableBundle(selfPath);
}

/**
 * P-532: the idle-exit setting for a sidecar THIS Server spawns. An explicit
 * PAPERCUSP_EMBED_SIDECAR_IDLE_EXIT_MS on the parent (0 = never) is inherited
 * unchanged. A fixed shared port keeps never-exit: another process may hold
 * that URL with no ensure hook to bring it back. Otherwise the child exits after
 * EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS idle and the spawner re-launches it lazily.
 */
export function spawnedSidecarIdleExitEnv(
  parentEnv: NodeJS.ProcessEnv,
  fixedPort: number | null,
): NodeJS.ProcessEnv {
  if (parentEnv[EMBED_SIDECAR_IDLE_EXIT_ENV] !== undefined) return {};
  if (fixedPort !== null) return {};
  return { [EMBED_SIDECAR_IDLE_EXIT_ENV]: String(EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS) };
}

function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * P-530 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): an explicit
 * PAPERCUSP_EMBED_SIDECAR_PORT keeps the single host-wide port this spawner
 * used before (EMBED_SIDECAR_DEFAULT_PORT is that historical value). Without it,
 * each Server spawns its OWN sidecar on an ephemeral port and records where in
 * its own data dir, so two tenants on one host never share a sidecar and one
 * tenant's text is never embedded by another tenant's process (WI-10005481
 * class). Null = ephemeral mode.
 */
export function embedSidecarFixedPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[EMBED_SIDECAR_PORT_ENV]?.trim();
  if (!raw) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** P-530: what a Server records about the sidecar it spawned on an ephemeral port. */
export interface EmbedSidecarRecord {
  pid: number;
  port: number;
  /** process.getuid() of the Server that spawned it; null where the OS has no uids. */
  uid: number | null;
  startedAt: number;
}

export const EMBED_SIDECAR_RECORD_FILE = 'embed-sidecar.json';

/** The record lives in the tenant's own data dir (PAPERCUSP_HOME, else
 *  ~/.papercusp), which no other tenant can write. */
export function embedSidecarRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(papercuspDataDir(env), 'run', EMBED_SIDECAR_RECORD_FILE);
}

const isPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 65536;

/** Pure: parse a record file's text; null for anything malformed. */
export function parseEmbedSidecarRecord(text: string): EmbedSidecarRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.pid) || (r.pid as number) <= 0 || !isPort(r.port)) return null;
  if (r.uid !== null && !Number.isInteger(r.uid)) return null;
  if (typeof r.startedAt !== 'number') return null;
  return { pid: r.pid as number, port: r.port as number, uid: r.uid as number | null, startedAt: r.startedAt };
}

export function readEmbedSidecarRecord(env: NodeJS.ProcessEnv = process.env): EmbedSidecarRecord | null {
  try {
    return parseEmbedSidecarRecord(readFileSync(embedSidecarRecordPath(env), 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic 0600 write (tmp + rename) into a 0700 dir. A failure is logged, not
 *  thrown: this Server still uses the child it holds; only sibling adoption is lost. */
function writeEmbedSidecarRecord(rec: EmbedSidecarRecord, env: NodeJS.ProcessEnv = process.env): void {
  const file = embedSidecarRecordPath(env);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    console.warn('[embed-sidecar] could not record the sidecar address:', err instanceof Error ? err.message : err);
  }
}

/** Remove the record only when it still names `pid` (a sibling may have replaced it). */
function removeEmbedSidecarRecord(pid: number, env: NodeJS.ProcessEnv = process.env): void {
  if (readEmbedSidecarRecord(env)?.pid !== pid) return;
  try {
    unlinkSync(embedSidecarRecordPath(env));
  } catch {
    // already gone
  }
}

function ownUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Is `pid` alive AND signalable by this process? EPERM means it belongs to
 *  another uid, which for adoption is the same as gone. */
function pidIsOurs(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pure: the pid a /healthz payload reports, or null. */
export function healthzPid(health: unknown): number | null {
  const pid = health && typeof health === 'object' ? (health as { pid?: unknown }).pid : undefined;
  return Number.isInteger(pid) ? (pid as number) : null;
}

/** Pure: the bound port a READY line announces (`… port=<n>`), or null. */
export function parseEmbedSidecarReadyPort(line: string): number | null {
  const m = /\bport=(\d+)\b/.exec(line);
  const port = m ? Number(m[1]) : NaN;
  return isPort(port) ? port : null;
}

export type EmbedSidecarAdoptVerdict = { adopt: true } | { adopt: false; reason: string };

/**
 * P-530, pure: may THIS process use the sidecar `record` names? Every check
 * must pass: the record was written by this uid; its pid is alive and ours;
 * on a host with a socket table, every listener on the port belongs to this
 * uid (a stale record whose port another tenant has since bound is refused);
 * and, when probed, /healthz reports the recorded pid. A host with no socket
 * table (`listenerUids` null, not Linux) relies on the pid checks.
 */
export function judgeRecordedEmbedSidecar(input: {
  record: EmbedSidecarRecord;
  uid: number | null;
  pidAlive: boolean;
  listenerUids: number[] | null;
  /** undefined = not probed (the sync address read); null = probed, no pid. */
  healthPid?: number | null;
}): EmbedSidecarAdoptVerdict {
  const { record, uid } = input;
  if (record.uid !== uid) return { adopt: false, reason: `recorded by uid ${record.uid}, this process is uid ${uid}` };
  if (!input.pidAlive) return { adopt: false, reason: `recorded pid ${record.pid} is not running as this uid` };
  if (input.listenerUids !== null && uid !== null) {
    if (input.listenerUids.length === 0) return { adopt: false, reason: `nothing listens on port ${record.port}` };
    if (!loopbackListenerOwnedBy(input.listenerUids, uid)) {
      return { adopt: false, reason: `port ${record.port} is held by uid(s) ${input.listenerUids.join(',')}` };
    }
  }
  if (input.healthPid !== undefined && input.healthPid !== record.pid) {
    return { adopt: false, reason: `/healthz on port ${record.port} reports pid ${input.healthPid}, not ${record.pid}` };
  }
  return { adopt: true };
}

function judgeRecordNow(record: EmbedSidecarRecord, healthPid?: number | null): EmbedSidecarAdoptVerdict {
  return judgeRecordedEmbedSidecar({
    record,
    uid: ownUid(),
    pidAlive: pidIsOurs(record.pid),
    listenerUids: loopbackListenerUids(record.port),
    healthPid,
  });
}

/** The URL of the child this process holds, once it has announced its port. */
/** P-532b: this tenant's sidecar is idle BY DESIGN — it announced an idle exit and is
 *  shutting down, or it exited idle and nothing has re-launched it. A health probe reads
 *  this so a sidecar that exits idle mid-probe is reported "not running", never DOWN,
 *  while a crash (which clears it) still reads DOWN. */
export function embedSidecarIdleByDesign(): boolean {
  return idleExitPending || lastExitIdle;
}

function childUrl(): string | null {
  return spawnedPort !== null && isEmbedSidecarRunning() ? loopbackUrl(spawnedPort) : null;
}

/**
 * The loopback base URL of THIS tenant's sidecar, or null when none is known.
 * Fixed-port mode: always that port. Ephemeral mode (P-530): the child this
 * process spawned, else a sibling's recorded sidecar that passes the
 * synchronous ownership checks, else null (a lazily spawned sidecar that is
 * not running now, e.g. after an idle exit). Read-only: never spawns.
 */
export function embedSidecarLocalUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const fixed = embedSidecarFixedPort(env);
  if (fixed !== null) return loopbackUrl(fixed);
  const own = childUrl();
  if (own) return own;
  const rec = readEmbedSidecarRecord(env);
  return rec && judgeRecordNow(rec).adopt ? loopbackUrl(rec.port) : null;
}

/** P-530: a sibling Server of this tenant already runs a sidecar? Adopt it only
 *  after the full check, /healthz pid included, and only when it is fit. */
async function adoptRecordedEmbedSidecar(requiredCapabilities: readonly string[]): Promise<string | null> {
  const rec = readEmbedSidecarRecord();
  if (!rec) return null;
  const url = loopbackUrl(rec.port);
  const health = await probeSidecarHealth(url);
  const verdict = judgeRecordNow(rec, healthzPid(health));
  if (!verdict.adopt) {
    console.log(`[embed-sidecar] not adopting the recorded sidecar at ${url}: ${verdict.reason}`);
    return null;
  }
  const fitness = verifySidecarFitness(health, requiredCapabilities, EMBED_SIDECAR_LEGACY_CAPABILITIES);
  if (!fitness.fit) {
    // Unlike the fixed port, an unfit sibling does not block this Server: its
    // own sidecar gets a port of its own.
    console.error(describeUnfitSidecar(url, fitness));
    return null;
  }
  return url;
}

/** Fetch and parse /healthz at `url`, or null if nothing healthy answers.
 *  Returns the PAYLOAD, not a boolean: liveness alone cannot decide whether a
 *  sidecar is usable, because a long-running one is frozen at its build time
 *  and 404s every route added since (EI-19314150478401738). Callers that need
 *  a route pair this with verifySidecarFitness(). */
export async function probeSidecarHealth(url: string, timeoutMs = 1500): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: ctl.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Does anything answer /healthz at `url`? Liveness ONLY — the right question
 *  for "is this port already bound" (don't spawn a doomed EADDRINUSE child),
 *  and the WRONG question for "may I use this sidecar" (see
 *  probeSidecarHealth + verifySidecarFitness). */
async function healthzAnswers(url: string, timeoutMs = 1500): Promise<boolean> {
  return (await probeSidecarHealth(url, timeoutMs)) !== null;
}

/**
 * Render an unfit sidecar as a LOUD, actionable, distinguishable line.
 *
 * The whole failure mode this guards is silence: a permanent 404 on a route
 * the client was built to call means VERSION SKEW, not an outage, and it must
 * never be absorbed into a generic "degraded" path. It also cannot be fixed by
 * restarting the process — the bundle must be REBUILT first, or a restart just
 * re-execs the same stale artifact. So the remedy is spelled out.
 */
export function describeUnfitSidecar(url: string, fitness: SidecarFitness): string {
  if (fitness.fit) return '';
  if (fitness.reason === 'unreachable') {
    return `[embed-sidecar] ${url} did not answer /healthz — not adopting.`;
  }
  const missing = fitness.missing.join(', ');
  const age =
    fitness.reason === 'stale-build'
      ? 'it advertises NO capabilities at all, so it predates capability advertisement'
      : `it advertises capabilities but not: ${missing}`;
  return (
    `[embed-sidecar] VERSION SKEW: the sidecar at ${url} cannot serve [${missing}] — ${age}. ` +
    'It runs a BUILT BUNDLE and is frozen at its build time while its callers advance, so the ' +
    'fix is to restart whatever OWNS the process so its bundle is rebuilt: on hosts running ' +
    'papercup-embed-sidecar.service that is `systemctl --user restart papercup-embed-sidecar.service` ' +
    "(the unit's ExecStartPre re-bundles the entry before it starts). Otherwise point " +
    'PAPERCUSP_EMBED_SIDECAR_URL at a current sidecar. Falling back to the in-process engine ' +
    'for this capability rather than calling a route that would 404 forever.'
  );
}

/** Short exponential backoff + sliding-window circuit breaker — a persistently
 *  crashing sidecar gives up rather than looping; embedding just stays on the
 *  in-process fallback path (D-003) until an explicit respawn. */
function scheduleRespawn(): void {
  if (deliberateStop) return;
  if (respawnTimer) return; // a respawn is already pending
  const now = Date.now();
  respawnAttempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  if (respawnBudgetExhausted(respawnAttempts, MAX_RESPAWN_ATTEMPTS)) {
    gaveUp = true;
    console.error(
      `[embed-sidecar] ${MAX_RESPAWN_ATTEMPTS} crashes within ${Math.round(RESPAWN_WINDOW_MS / 1000)}s — giving up auto-respawn. ` +
        'Embedding on this host will FAIL (no in-process fallback, WI-4021) until an explicit spawnEmbedSidecar() call ' +
        'or a supervised sidecar answers the port.',
    );
    return;
  }
  respawnAttempts.push(now);
  const backoffMs = respawnBackoffMs(respawnAttempts.length);
  console.warn(
    `[embed-sidecar] auto-respawning in ${backoffMs}ms (attempt ${respawnAttempts.length}/${MAX_RESPAWN_ATTEMPTS} in window)`,
  );
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    void (async () => {
      // Fixed port: a likely reason OUR child died with the port contested is
      // that a sibling process's sidecar owns it. If something healthy answers,
      // adopt it — respawning would just EADDRINUSE-crash into the circuit
      // breaker. Ephemeral port (P-530): nothing to contest; only a verified
      // sibling of this tenant is a reason not to respawn.
      const fixed = embedSidecarFixedPort();
      const sibling =
        fixed !== null ? ((await healthzAnswers(loopbackUrl(fixed))) ? loopbackUrl(fixed) : null) : await adoptRecordedEmbedSidecar([]);
      if (sibling) {
        console.log(`[embed-sidecar] ${sibling} already served by a sibling process — adopting, not respawning`);
        return;
      }
      await spawnEmbedSidecar().catch((err) => {
        console.error('[embed-sidecar] auto-respawn failed:', err);
      });
    })();
  }, backoffMs);
}

/**
 * Spawn the embedding sidecar process.
 * Waits for the PAPERCUSP_EMBED_SIDECAR_READY handshake line (printed at
 * LISTEN — model warm-up continues in the background, so this stays well
 * inside the timeout even on a cold model cache).
 */
/**
 * P-531: how the spawner treats a sidecar exit. Only a CLEAN exit (code 0)
 * that the sidecar announced on stdout (EMBED_SIDECAR_IDLE_EXIT_LINE) is an
 * idle exit: no crash-respawn, no respawn-budget charge, the next embed
 * re-launches it. Anything else, including a non-zero exit after the
 * announcement, stays a crash and goes through scheduleRespawn.
 */
export function classifyEmbedSidecarExit(e: { idleExitAnnounced: boolean; code: number | null }): 'idle-exit' | 'crash' {
  return e.idleExitAnnounced && e.code === 0 ? 'idle-exit' : 'crash';
}

export async function spawnEmbedSidecar(): Promise<void> {
  // WI-7249 / D-011: registration belongs to the SPAWN, not to a call site. Registered
  // inside ensureEmbedSidecar today, so a direct spawnEmbedSidecar() caller (it is
  // exported) would register nothing — the same shape the spawner-sidecar leaked from.
  // Idempotent by label.
  registerEmbedSidecarShutdownHooks();

  if (sidecarProcess) {
    // Already running
    if (sidecarReady) return;
    // Wait for ready
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
    });
  }

  // A fresh spawn attempt — clear any pending backoff timer and the
  // deliberate-stop flag so the crash-respawn machinery is armed.
  deliberateStop = false;
  gaveUp = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  const sidecarScript = path.join(
    // 4 levels up from packages/operator-core/lib/memory/ → repo root,
    // then apps/operator/bin/.
    moduleDir,
    '../../../../apps/operator/bin/embed-sidecar.ts',
  );

  // Spawn target. esbuild bundles EVERY module into the single serve.mjs, so in
  // a PACKAGED build import.meta.url here IS serve.mjs — re-exec that artifact
  // under the bundled node with PAPERCUSP_EMBED_SIDECAR_MODE=1 (serve.ts /
  // hono-host.ts divert to runEmbedSidecarServer). In DEV (tsx, real source
  // tree) run the .ts entry via tsx.
  const selfPath = fileURLToPath(import.meta.url);
  const plan = resolveSidecarSpawnPlan({
    selfPath,
    devScriptPath: sidecarScript,
    bundledModeEnvVar: 'PAPERCUSP_EMBED_SIDECAR_MODE',
    execPath: process.execPath,
    spawnerPid: process.pid,
  });

  const fixedPort = embedSidecarFixedPort();
  const startupTimeoutMs = embedSidecarStartupTimeoutMs();
  return new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...plan.env,
      // P-530: no explicit port → bind an ephemeral one; the READY line says which.
      ...(fixedPort === null ? { [EMBED_SIDECAR_PORT_ENV]: '0' } : {}),
      // P-532: a per-tenant child exits when idle unless the parent says otherwise.
      ...spawnedSidecarIdleExitEnv(process.env, fixedPort),
      // EI-8810 belt: the sidecar serves its OWN loopback port only — never the
      // parent's HTTP port or the background-worker role. A mode-divert miss in
      // the re-exec'd entry otherwise boots a full host on the PARENT's port
      // (EADDRINUSE crash-respawn loop) and could double-run the single-writer
      // background machinery. Port 0 = ephemeral bind if some entry ever listens.
      PAPERCUSP_HONO_PORT: '0',
      PORT: '0',
      PAPERCUSP_BACKGROUND_WORKERS: '0',
    };

    const child = spawn(plan.cmd, plan.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });
    sidecarProcess = child;
    lastExitIdle = false;
    /** P-530: the child is gone — forget its port and drop its record. */
    const forgetChild = (): void => {
      spawnedPort = null;
      if (fixedPort === null && typeof child.pid === 'number') removeEmbedSidecarRecord(child.pid);
    };

    const timeout = setTimeout(() => {
      if (!sidecarReady && sidecarProcess) {
        sidecarProcess.kill();
        sidecarProcess = null;
      }
      reject(new Error(`Embed sidecar startup timeout (${startupTimeoutMs} ms)`));
    }, startupTimeoutMs);

    // Listen for ready handshake
    let stdoutBuffer = '';
    let idleExitAnnounced = false;
    sidecarProcess.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');

      // Keep the last incomplete line
      stdoutBuffer = lines[lines.length - 1] || '';

      for (const line of lines.slice(0, -1)) {
        console.log('[embed-sidecar]', line);

        if (line.includes(EMBED_SIDECAR_IDLE_EXIT_LINE)) {
          // P-531: a deliberate idle exit is coming. Stop routing new work to
          // this process now; the exit handler below must not crash-respawn it.
          idleExitAnnounced = true;
          idleExitPending = true;
          sidecarReady = false;
        }

        if (line.includes(EMBED_SIDECAR_READY_LINE)) {
          const port = parseEmbedSidecarReadyPort(line) ?? fixedPort;
          if (port === null) {
            // Ephemeral mode cannot address a child that did not say where it
            // listens; a ready-but-unaddressable child is a failed spawn.
            clearTimeout(timeout);
            child.kill();
            reject(new Error(`Embed sidecar READY line carried no port: ${line}`));
            continue;
          }
          spawnedPort = port;
          if (fixedPort === null && typeof child.pid === 'number') {
            writeEmbedSidecarRecord({ pid: child.pid, port, uid: ownUid(), startedAt: Date.now() });
          }
          sidecarReady = true;
          clearTimeout(timeout);
          resolve();

          // Wake any other waiters
          for (const waiter of readyWaiters) {
            waiter();
          }
          readyWaiters.length = 0;
        }
      }
    });

    sidecarProcess.stderr?.on('data', (chunk: Buffer) => {
      console.warn('[embed-sidecar-err]', chunk.toString().trim());
    });

    sidecarProcess.on('error', (err) => {
      sidecarProcess = null;
      sidecarReady = false;
      idleExitPending = false;
      forgetChild();
      reject(err);
    });

    sidecarProcess.on('exit', (code) => {
      sidecarProcess = null;
      sidecarReady = false;
      idleExitPending = false;
      forgetChild();
      lastExitIdle = false;
      if (classifyEmbedSidecarExit({ idleExitAnnounced, code }) === 'idle-exit') {
        lastExitIdle = true;
        console.log('[embed-sidecar] exited idle; the next embed re-launches it');
        // A caller that arrived during the idle shutdown is parked on
        // readyWaiters: re-launch now so it is not stranded until a timeout.
        if (readyWaiters.length > 0) void spawnEmbedSidecar().catch(() => undefined);
        return;
      }
      // A caller parked on readyWaiters must not wait on a child that died
      // before its READY line: wake it so it re-decides (P-530 parks callers
      // until an ephemeral child announces its port).
      for (const waiter of readyWaiters) waiter();
      readyWaiters.length = 0;
      const msg = code !== null ? `exit code ${code}` : 'killed';
      if (!deliberateStop) {
        console.warn(`[embed-sidecar] died (${msg})`);
      }
      scheduleRespawn();
    });
  });
}

/** EI-19418496145469907: log the "no sidecar configured at all" fallback
 *  ONCE per process. Neither PAPERCUSP_EMBED_SIDECAR_URL nor
 *  PAPERCUSP_EMBED_SIDECAR=1 is a perfectly normal state for most hosts (a
 *  desktop install, a one-off script, an agent shell) — this is not an
 *  error — but it was previously byte-identical in the logs to actually
 *  exercising the sidecar path, so a standalone verification driver could
 *  silently verify the wrong code branch with no observable tell. */
let loggedNoSidecarConfigured = false;

/** Test seam — clear the once-per-process "no sidecar configured" memo. */
export function _resetNoSidecarConfiguredLogForTests(): void {
  loggedNoSidecarConfigured = false;
}

/** WI-9354: the fallback warn below is correct in every REAL deployment, but
 *  under vitest it fired inside any suite that merely happens to build an
 *  embedder (configure.ts -> embed-sidecar-wiring.ts -> here) — incidental to
 *  what those suites test. The repo runs vitest-fail-on-console, so that
 *  unasserted warn RED-PINNED five unrelated files at once (scheduler, work
 *  items, mcp-handler gating, knowledge-tier dedup) and took the fleet gate
 *  with it. Same class, and the same remedy, as hive-directory-boot.ts:221/249
 *  and session-compacted-events.ts:28 — stay silent under test, unchanged in
 *  production. This is an OPT-IN rather than a blanket `!process.env.VITEST`
 *  precisely so the owning suite (embed-sidecar-spawn.test.ts, EI-19418496145469907)
 *  still observes the warn and keeps proving the fallback is not silent —
 *  suppressing it there would disarm that guard instead of fixing this bug. */
let warnNoSidecarUnderTest = false;

/** Test seam — opt THIS file's suite into observing the fallback warn. */
export function _setNoSidecarWarnUnderTest(enabled: boolean): void {
  warnNoSidecarUnderTest = enabled;
}

/**
 * Ensure the host-local sidecar is up and return its base URL, or null when
 * disabled/unspawnable. The lazy front door consumers call on first embed —
 * mirrors spawnInvokeOnceWithFallback's shape: failure returns null, never
 * throws. While the spawner is enabled the wiring treats that null as "not up
 * yet" and keeps calling this per attempt; only a disabled spawner means
 * in-process (WI-10005932).
 *
 * Default (P-530, no PAPERCUSP_EMBED_SIDECAR_PORT): the sidecar binds an
 * ephemeral port and this Server records it in its own data dir. A sibling
 * process of the same tenant adopts it only after embedSidecarRecord checks
 * (same uid, live pid, port held by this uid, /healthz pid matches); anything
 * else gets this Server its own sidecar.
 *
 * Explicit fixed port: the port is ONE per host, so if a process of THIS uid
 * already serves it (this one earlier, or a sibling operator process), adopt
 * that instance instead of spawning a second child that would EADDRINUSE-die.
 * A port held by another uid is refused, never adopted.
 */
export async function ensureEmbedSidecar(
  requiredCapabilities: readonly string[] = [],
): Promise<string | null> {
  if (!embedSidecarEnabled()) {
    // WI-9354: gate on the opt-in under vitest only. The memo is set ONLY when
    // we actually warn, so real-deployment "exactly once per process" semantics
    // are byte-identical to before.
    const warnAllowed = !process.env.VITEST || warnNoSidecarUnderTest;
    if (warnAllowed && !loggedNoSidecarConfigured) {
      loggedNoSidecarConfigured = true;
      console.warn(
        '[embed-sidecar] no sidecar configured for this process ' +
          `(${EMBED_SIDECAR_ENABLE_ENV} not '1' and not running from a sidecar-capable bundle, ` +
          'no explicit URL) — using pure in-process embedding. ' +
          'This is expected for hosts with no sidecar story. If you meant to exercise the sidecar ' +
          'path (e.g. verifying production embedding behavior from a standalone driver), export ' +
          'PAPERCUSP_EMBED_SIDECAR_URL — the systemd units\' value: ' +
          "`systemctl --user show papercusp-bg-host.service -p Environment`. " +
          // EI-19464316359123796: the in-process path loads @huggingface/transformers,
          // whose onnxruntime-node native addon leaves a live InferenceSession behind —
          // see the appended warning below for the process.exit() teardown hazard.
          'If THIS process later calls process.exit() (common in a one-off tsx/node ' +
          'driver script), Node may abort before the native embedder addon\'s own ' +
          "teardown runs, printing a bare `terminate called after throwing an instance " +
          "of 'Napi::Error'` and exiting via SIGABRT (exit code 134) — AFTER your " +
          'results have already printed correctly (EI-19464316359123796). That crash ' +
          'is a benign native teardown race, not a sign your results are wrong; do not ' +
          'treat a nonzero exit code alone as failure in a wrapper script. Workaround: ' +
          'let the script exit naturally instead of calling process.exit() after an ' +
          'embed call, or export PAPERCUSP_EMBED_SIDECAR_URL so embedding routes ' +
          'through the sidecar HTTP process instead of loading the native addon here.',
      );
    }
    return null;
  }
  const fixed = embedSidecarFixedPort();
  if (isEmbedSidecarRunning()) {
    // P-531: a child that announced an idle exit is still alive but shutting
    // down, so handing out its URL now would send the caller to a closing
    // server. spawnEmbedSidecar() parks this caller on readyWaiters, and the
    // exit handler re-launches immediately because a waiter is parked.
    // P-530: an ephemeral-port child has no address until its READY line, so
    // a caller that arrives mid-startup waits for it the same way.
    if (idleExitPending || (fixed === null && spawnedPort === null)) await spawnEmbedSidecar();
    const own = childUrl() ?? (fixed !== null ? loopbackUrl(fixed) : null);
    if (own) return own;
  }
  if (fixed !== null) {
    const url = loopbackUrl(fixed);
    // Sibling-owned? Liveness alone is NOT enough to adopt: the sibling may be a
    // long-running bundle that predates the routes this caller needs, in which
    // case adopting it means 404-forever (EI-19314150478401738).
    const health = await probeSidecarHealth(url);
    if (health !== null) {
      // P-530: and never another uid's (another tenant's) process, wherever
      // the host can say who owns the port.
      const uid = ownUid();
      if (uid !== null && loopbackListenerOwnedBy(loopbackListenerUids(fixed), uid) === false) {
        console.error(
          `[embed-sidecar] ${url} is served by another user's process — not adopting it. ` +
            `Unset ${EMBED_SIDECAR_PORT_ENV} so this Server spawns its own sidecar on a port of its own.`,
        );
        return null;
      }
      const fitness = verifySidecarFitness(health, requiredCapabilities, EMBED_SIDECAR_LEGACY_CAPABILITIES);
      if (fitness.fit) return url; // sibling-owned and capable — adopt
      console.error(describeUnfitSidecar(url, fitness));
      // The port is BOUND by that unfit sibling, so spawning here would just
      // EADDRINUSE-crash into the circuit breaker. Refuse honestly instead.
      return null;
    }
  } else {
    const sibling = await adoptRecordedEmbedSidecar(requiredCapabilities);
    if (sibling) return sibling;
  }
  try {
    await spawnEmbedSidecar();
    registerEmbedSidecarShutdownHooks();
    return childUrl() ?? (fixed !== null ? loopbackUrl(fixed) : null);
  } catch (err) {
    // WI-10005932: no consumer loads the model in-process on null; the
    // sidecar embedder retries within its own budget (WI-4021).
    console.warn('[embed-sidecar] ensure failed (no sidecar this attempt; callers retry):', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Check if the sidecar is running.
 */
export function isEmbedSidecarRunning(): boolean {
  return !!sidecarProcess && !sidecarProcess.killed;
}

/**
 * Has the host-local sidecar THIS process spawned completed its ready
 * handshake (LISTEN)? False before any spawn, while a spawn is cold-starting,
 * or if this process never spawned one; true from the ready line onward until
 * a crash/stop resets it (the `exit` handler clears `sidecarReady` — see
 * `scheduleRespawn`).
 *
 * Deliberately distinct from `isEmbedSidecarRunning()`, which flips true the
 * INSTANT the child is forked (`sidecarProcess` is set at `spawn()`, well
 * before the ready line) — so it cannot answer "would acquiring this
 * sidecar's URL be cheap right now". This can (WI-3923): a caller bounding
 * its own acquisition (e.g. `buildQueryEmbedderResolved`'s interactive path)
 * uses this to tell a genuinely-cold spawn (worth skipping and warming in the
 * background) from an already-ready one (worth waiting the normal ~instant
 * `ensureEmbedSidecar()` resolve for).
 */
export function isEmbedSidecarReady(): boolean {
  return sidecarReady;
}

/** Test seam — inject a fake sidecar ChildProcess without spawning a real child. */
export function _setEmbedSidecarProcessForTests(proc: ChildProcess | null): void {
  sidecarProcess = proc;
  sidecarReady = !!proc;
}

/**
 * Kill the sidecar gracefully.
 */
export async function stopEmbedSidecar(): Promise<void> {
  if (!sidecarProcess || sidecarProcess.killed) return;
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const proc = sidecarProcess;
  await gracefulStopChild(proc, { timeoutMs: 5000, kill: (sig) => proc.kill(sig) });
  sidecarProcess = null;
  sidecarReady = false;
}

/**
 * Register graceful shutdown hooks.
 */
export function registerEmbedSidecarShutdownHooks(): void {
  registerSharedSidecarShutdownHooks({
    label: 'embed-sidecar-spawn',
    stop: () => stopEmbedSidecar(),
    // Only tear down for an ACTUALLY-fatal uncaughtException (P-006 lesson:
    // a benign client-disconnect EPIPE must not kill a healthy sidecar into
    // a warm-respawn churn loop).
    isFatalException: (err) => !isBenignHostError(err),
  });
}

/** Test seam — reset the module-global respawn state between unit tests. */
export function _resetEmbedSidecarSpawnStateForTests(): void {
  deliberateStop = false;
  gaveUp = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  respawnAttempts = [];
  sidecarProcess = null;
  sidecarReady = false;
  idleExitPending = false;
  lastExitIdle = false;
  spawnedPort = null;
  readyWaiters.length = 0;
}

/**
 * Node-child supervision status for `dev:service_health`'s additive
 * `supervision` block — mirrors `spawnerSidecarSupervisionStatus()`. PURE
 * given the module's own in-memory state (no I/O).
 */
export interface EmbedSidecarSupervisionStatus {
  running: boolean;
  respawnAttemptsInWindow: number;
  gaveUp: boolean;
  lastRespawnScheduledAt: number | null;
}

export function embedSidecarSupervisionStatus(now: number = Date.now()): EmbedSidecarSupervisionStatus {
  const attempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  return {
    running: !!sidecarProcess && !sidecarProcess.killed,
    respawnAttemptsInWindow: attempts.length,
    gaveUp,
    lastRespawnScheduledAt: attempts.length ? attempts[attempts.length - 1] : null,
  };
}
