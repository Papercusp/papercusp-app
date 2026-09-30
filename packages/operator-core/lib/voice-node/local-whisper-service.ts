/**
 * voice-node/local-whisper-service — operator-managed whisper-server CHILD process
 * (voice-public-release-readiness-2026-07-12 P-009 hop 3, WI-4449).
 *
 * Public users have no voicemode install and no systemd unit — the operator itself is the
 * natural, CROSS-PLATFORM supervisor for the provisioned whisper-server (provisioner/
 * whisper-binary.ts): spawn on first STT need, health-gate before use, reap on operator exit.
 * The dev box (or any box already running an external whisper on VOICEMODE_URL, e.g. the live
 * voicemode-whisper unit) is untouched: `ensureLocalWhisper` probes the external URL FIRST and
 * stands down when it answers.
 *
 * Deliberate boundaries:
 *   - CACHE-ONLY: uses `findCachedWhisperBinary` + `resolveWhisperModel` (both fs-only) —
 *     this module NEVER downloads or builds. The explicit provision step (the settings /
 *     wizard "install local voice" action) populates the cache; an un-provisioned box gets a
 *     clean `not-provisioned` reason, not a surprise 150MB download on a PTT press.
 *   - No auto-respawn loop: a crashed child flips state to 'stopped' and the NEXT ensure()
 *     re-spawns (bounded by MAX_SPAWNS_PER_WINDOW so a crash-looping binary can't spawn-storm
 *     — the WI-4221 lesson, applied preemptively).
 *   - Spawns on a dedicated LOCAL port (default 2022 to match the VOICEMODE_URL seam; an
 *     external server on that port is detected before any spawn, so no bind conflict).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import {
  findCachedWhisperBinary,
  resolveWhisperModel,
  renderWhisperServerArgs,
  whisperPlatformSpec,
  WHISPER_SERVER_DEFAULT_PORT,
  type WhisperModelId,
} from '../provisioner/whisper-binary';
import { managedSpawn } from '../task-manager/managed-spawn';
import { registerSidecarShutdownHooks } from '../process-supervision/sidecar-spawn-shared';
import { platformKeyFor } from '../provisioner/llama-binary';
import { detectHardware, type DetectedHardware } from '../provisioner/hardware-detect';

export type LocalWhisperSource = 'external' | 'managed';

export interface EnsureWhisperResult {
  ok: boolean;
  /** Base URL serving /v1/audio/transcriptions when ok. */
  url?: string;
  source?: LocalWhisperSource;
  /** Machine-readable reason when !ok: 'not-provisioned' (binary/model missing — run the
   *  provision step), 'spawn-failed', 'unhealthy' (spawned but never answered), 'spawn-storm',
   *  'port-occupied' (something ELSE is bound to the port and never answered /health — spawning
   *  would silently stack a duplicate listener via SO_REUSEPORT, the WI-4501 17-server pile). */
  reason?: 'not-provisioned' | 'spawn-failed' | 'unhealthy' | 'spawn-storm' | 'port-occupied';
  detail?: string;
}

export interface LocalWhisperDeps {
  home?: string;
  /** External whisper base URL probed before any spawn. Default: the VOICEMODE_URL seam. */
  externalUrl?: string;
  port?: number;
  model?: WhisperModelId;
  detectHw?: () => Promise<DetectedHardware>;
  probe?: (baseUrl: string) => Promise<boolean>;
  /** Raw TCP bind check on the managed port (default: node:net connect). WI-4501: whisper-server
   *  binds with SO_REUSEPORT, so a duplicate spawn SUCCEEDS silently and the kernel round-robins
   *  /health probes across the pile — HTTP probing alone cannot see the duplication. */
  tcpProbe?: (port: number) => Promise<boolean>;
  spawnFn?: typeof spawn;
  /** Health-wait tuning (tests shrink these). */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  now?: () => number;
}

/**
 * Options for the failure-recovery wrapper used by STT routes.
 *
 * The ordinary transcription path deliberately stays a single request: callers first use the
 * lifecycle URL returned by {@link whisperSttBaseUrl}, and only a transport/5xx failure enters
 * this wrapper. Keeping the warm function injectable makes the recovery contract hermetic in
 * route tests without making the hot path depend on a test-only global.
 */
export interface WhisperRecoveryOptions {
  /** Warm/reconcile the local endpoint before the one permitted retry. */
  warm?: (deps: LocalWhisperDeps) => Promise<unknown>;
  /** Retryable upstream statuses. Defaults to connection failures and HTTP 5xx/408. */
  shouldRetryStatus?: (status: number) => boolean;
}

interface ManagedState {
  child: ChildProcess | null;
  url: string | null;
  starting: Promise<EnsureWhisperResult> | null;
  spawnTimes: number[];
}

const MAX_SPAWNS_PER_WINDOW = 3;
const SPAWN_WINDOW_MS = 5 * 60 * 1000;

// Module-singleton on purpose: ONE managed whisper child per operator process, whichever
// route asks first (same posture as the voice bus / audio socket singletons in this dir).
const state: ManagedState = { child: null, url: null, starting: null, spawnTimes: [] };

/** Is ANYTHING accepting TCP on 127.0.0.1:port? Distinct from the HTTP /health probe: a
 *  listener that is sick, still loading its model, or not-whisper-at-all still accepts the
 *  connect — and is exactly what we must never spawn a duplicate next to. */
async function defaultTcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

// Cross-PROCESS spawn lock (WI-4501): the in-memory `state.starting` coalescer only guards ONE
// operator process, but a deploy restarts several hono-hosts at once — 8 of them each spawned
// "their own singleton" on 2026-07-12 (17 servers stacked on :2022). A tiny lockfile under
// ~/.papercusp serializes the spawn across processes: fresh lock → poll the port's health
// instead of spawning; stale lock (holder died mid-spawn) → take over.
const SPAWN_LOCK_FRESH_MS = 60_000;

function spawnLockPath(home: string | undefined): string {
  return join(home ?? homedir(), '.papercusp', 'whisper-spawn.lock');
}

async function acquireSpawnLock(home: string | undefined): Promise<'acquired' | 'held'> {
  const lockPath = spawnLockPath(home);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return 'acquired';
    } catch {
      // EEXIST — another process is (or was) mid-spawn.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs < SPAWN_LOCK_FRESH_MS) return 'held';
        await unlink(lockPath); // stale — holder died mid-spawn; take over on the retry
      } catch {
        // lock vanished between write and stat — retry the acquire
      }
    }
  }
  return 'held';
}

async function releaseSpawnLock(home: string | undefined): Promise<void> {
  try {
    await unlink(spawnLockPath(home));
  } catch {
    // already gone — fine
  }
}

async function defaultProbe(baseUrl: string): Promise<boolean> {
  try {
    // /health — NOT /v1/models. whisper.cpp's server implements /health (200) and 404s
    // /v1/models; it is only OpenAI-shaped on its --inference-path. Probing /v1/models made a
    // healthy, actively-transcribing whisper read as DOWN (the same bug this module inherited
    // from probeVoicemodeHealth; fixed there too).
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Test hook: forget the managed child WITHOUT killing it (unit tests own their fakes). */
export function __resetLocalWhisperStateForTests(): void {
  state.child = null;
  state.url = null;
  state.starting = null;
  state.spawnTimes = [];
}

/** Stop the managed child (operator shutdown / settings "disable local voice"). Idempotent. */
export async function stopLocalWhisper(): Promise<void> {
  const child = state.child;
  state.child = null;
  state.url = null;
  if (child && child.exitCode === null && !child.killed) {
    // Register the exit-wait BEFORE kill — a child that exits synchronously on kill (fakes in
    // tests; a fast real exit) would otherwise strand the wait until the timeout fallback.
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    // Bounded wait — whisper-server exits promptly on SIGTERM; don't hang shutdown on it.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
  }
}

/**
 * Ensure a whisper STT endpoint is available, spawning the provisioned server if needed.
 * Concurrent callers coalesce onto one in-flight start (no double-spawn on a burst of PTT
 * requests). Never throws.
 */
export async function ensureLocalWhisper(deps: LocalWhisperDeps = {}): Promise<EnsureWhisperResult> {
  const probe = deps.probe ?? defaultProbe;
  const externalUrl = deps.externalUrl ?? (process.env.VOICEMODE_URL ?? 'http://localhost:2022');

  // 1. An external server (dev-box voicemode, a user's own install) always wins — zero spawns.
  if (await probe(externalUrl)) return { ok: true, url: externalUrl, source: 'external' };

  // 2. Already-managed child still healthy?
  if (state.child && state.child.exitCode === null && state.url) {
    if (await probe(state.url)) return { ok: true, url: state.url, source: 'managed' };
    // Unresponsive child — treat as dead, reap, and fall through to a fresh spawn.
    await stopLocalWhisper();
  } else if (state.child && state.child.exitCode !== null) {
    state.child = null;
    state.url = null;
  }

  // 3. Coalesce concurrent starts.
  if (state.starting) return state.starting;
  state.starting = startManaged(deps, probe);
  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

/**
 * The STT call sites' one-liner: the base URL to POST /v1/audio/transcriptions at.
 *
 * HOT PATH — this runs once per utterance, so it does NO I/O: it is a pure read of the
 * lifecycle state (a live managed child → its URL; otherwise the external URL, which is
 * also the not-provisioned fallback, so an unreachable whisper fails with exactly the same
 * surface it had before this module existed).
 *
 * It deliberately does NOT call ensureLocalWhisper: that probes over HTTP, and doing so here
 * added a full round-trip to EVERY transcription (caught by agent-peer.test.ts's "one fetch
 * per transcription" contract — the test was right and the first cut of this function was
 * wrong). The managed child is started by `warmLocalWhisper()` at the lifecycle moments that
 * actually mean "voice is about to be used" — enabling voice mode, and finishing the local
 * install — never on the utterance path.
 */
export function whisperSttBaseUrl(deps: LocalWhisperDeps = {}): string {
  if (state.child && state.child.exitCode === null && state.url) return state.url;
  return deps.externalUrl ?? (process.env.VOICEMODE_URL ?? 'http://localhost:2022');
}

/**
 * Lifecycle warm-up: bring a whisper endpoint up (external probe → managed child spawn) so the
 * FIRST utterance already has one. Fire-and-forget by design — callers are lifecycle events
 * (voice-mode enable, install completion), never the request path, and a failure here just
 * means the STT call falls back to the external URL and surfaces the usual unreachable error.
 */
export async function warmLocalWhisper(deps: LocalWhisperDeps = {}): Promise<EnsureWhisperResult> {
  return ensureLocalWhisper(deps);
}

/**
 * Execute one Whisper request and recover once when the endpoint has failed.
 *
 * A healthy request is always one fetch. A 4xx (bad audio/request) and a 429 (quota/rate
 * limiting) are returned unchanged, because warming a local process cannot repair either and a
 * second request would obscure the actionable provider response. Connection failures, timeouts,
 * and 5xx responses are the lifecycle-failure class: warm the external-or-managed endpoint once,
 * then retry exactly once against the freshly selected URL. The helper is shared by the operator,
 * device, and P2P STT paths so they cannot drift into three different retry policies.
 */
export async function fetchWhisperWithRecovery(
  request: (baseUrl: string) => Promise<Response>,
  deps: LocalWhisperDeps = {},
  options: WhisperRecoveryOptions = {},
): Promise<Response> {
  const shouldRetryStatus = options.shouldRetryStatus ?? ((status: number) => status === 408 || status >= 500);
  const warm = options.warm ?? ((d: LocalWhisperDeps) => warmLocalWhisper(d));
  const firstBase = whisperSttBaseUrl(deps);
  try {
    const first = await request(firstBase);
    if (first.ok || !shouldRetryStatus(first.status)) return first;
    // We are discarding this retryable response. Release its body before warming so a keep-alive
    // socket cannot linger while the child starts (undici's `Response` body is otherwise held by
    // the connection pool until its timeout).
    await first.body?.cancel().catch(() => {});
  } catch {
    // A transport failure is the strongest signal that the managed child may have died. Continue
    // to the same single warm + retry path; the retry's error is intentionally allowed to reach
    // the route, which reports the honest final 502 rather than hiding it behind the first error.
  }

  // Warm is best-effort. If the cache is absent or the child cannot start, the retry still runs
  // against the external URL and preserves the original route error surface.
  await warm(deps).catch(() => {});
  return request(whisperSttBaseUrl(deps));
}

async function startManaged(deps: LocalWhisperDeps, probe: (u: string) => Promise<boolean>): Promise<EnsureWhisperResult> {
  const now = deps.now ?? Date.now;
  // Spawn-storm guard: a binary that boots-then-dies must not respawn unboundedly.
  state.spawnTimes = state.spawnTimes.filter((t) => now() - t < SPAWN_WINDOW_MS);
  if (state.spawnTimes.length >= MAX_SPAWNS_PER_WINDOW) {
    return { ok: false, reason: 'spawn-storm', detail: `${MAX_SPAWNS_PER_WINDOW} spawns in ${SPAWN_WINDOW_MS / 60000}min — refusing to spawn-loop a failing whisper-server` };
  }

  const port = deps.port ?? WHISPER_SERVER_DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  const timeoutMs = deps.healthTimeoutMs ?? 15_000;
  const intervalMs = deps.healthIntervalMs ?? 500;

  // NEVER spawn onto a bound port (WI-4501). whisper-server binds SO_REUSEPORT, so a duplicate
  // spawn does NOT fail with EADDRINUSE — it silently stacks, and the kernel then round-robins
  // /health probes across the pile, so a sick listener answering one probe triggers ANOTHER
  // spawn (17 servers × --threads 127 on this box). If something already holds the port:
  // still-loading whisper → poll /health until it answers (use it as external); anything that
  // never answers → 'port-occupied', a loud reason instead of a silent duplicate.
  const tcpProbe = deps.tcpProbe ?? defaultTcpProbe;
  if (await tcpProbe(port)) {
    const bindDeadline = now() + timeoutMs;
    while (now() < bindDeadline) {
      if (await probe(url)) return { ok: true, url, source: 'external' };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return {
      ok: false,
      reason: 'port-occupied',
      detail: `something is bound to 127.0.0.1:${port} but never answered /health within ${timeoutMs}ms — refusing to stack a duplicate whisper-server on it`,
    };
  }

  const detectHw = deps.detectHw ?? detectHardware;
  const hw = await detectHw();
  const platformKey = platformKeyFor(whisperPlatformSpec(hw));
  const cached = await findCachedWhisperBinary({ home: deps.home, platformKey });
  if (!cached) {
    return { ok: false, reason: 'not-provisioned', detail: `no provisioned whisper-server for ${platformKey} — run the local-voice install step` };
  }
  const modelPlan = await resolveWhisperModel(deps.model, { home: deps.home });
  if (modelPlan.needsDownload || !modelPlan.weightsPath) {
    return { ok: false, reason: 'not-provisioned', detail: modelPlan.detail };
  }

  const args = renderWhisperServerArgs({ modelPath: modelPlan.weightsPath, port });
  const spawnFn = deps.spawnFn ?? spawn;

  // Cross-process spawn lock: `state.starting` coalesces within ONE process; this serializes
  // ACROSS processes (a deploy restarts several hono-hosts at once — each spawned "its own
  // singleton" on 2026-07-12). A fresh foreign lock means a sibling is mid-spawn: poll its
  // server's health instead of spawning a duplicate.
  const lock = await acquireSpawnLock(deps.home);
  if (lock === 'held') {
    const lockDeadline = now() + timeoutMs;
    while (now() < lockDeadline) {
      if (await probe(url)) return { ok: true, url, source: 'external' };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return {
      ok: false,
      reason: 'unhealthy',
      detail: `another process holds the whisper spawn lock and its server never answered /health within ${timeoutMs}ms`,
    };
  }
  try {
    return await spawnAndHealthGate({ deps, probe, url, args, binPath: cached.binPath, spawnFn, now, timeoutMs, intervalMs });
  } finally {
    // Awaited on purpose: a fire-and-forget unlink races the CALLER's next ensure() —
    // which would see a "fresh foreign lock" that is really our own garbage.
    await releaseSpawnLock(deps.home);
  }
}

async function spawnAndHealthGate(opts: {
  deps: LocalWhisperDeps;
  probe: (u: string) => Promise<boolean>;
  url: string;
  args: string[];
  binPath: string;
  spawnFn: typeof spawn;
  now: () => number;
  timeoutMs: number;
  intervalMs: number;
}): Promise<EnsureWhisperResult> {
  const { probe, url, args, binPath, spawnFn, now, timeoutMs, intervalMs } = opts;
  state.spawnTimes.push(now());
  let child: ChildProcess;
  try {
    // ENROLLED, not raw (WI-39563). This server is health-gated and then PARKED in
    // module-scope `state.child` below — it is long-lived by design. A raw spawn puts
    // it in the operator's own cgroup, so a bg-host restart (KillMode=control-group)
    // takes it down and nothing in the ledger can address it; `processes:kill` has no
    // row to reach, leaving kill-by-pid as the only lever. `managedSpawn` confines it
    // to a SIBLING transient scope instead, so it survives its launcher and is
    // addressable by taskId.
    //
    // `detached: false` is still correct and is NOT what made this unsafe — the scope,
    // not the process group, is what decouples the lifetime. The old guard keyed on
    // `detached: true` and so could not see this site at all (EI-19483245448673321);
    // it is now caught by the "handle parked on a property" trigger.
    //
    // managedSpawn FAILS SOFT by contract: a PG blip degrades to an unledgered spawn
    // and an unavailable systemd scope degrades to an unconfined one, both reported
    // via confinementSkippedReason. Neither refuses the spawn, so the whisper path is
    // no more fragile than the raw call it replaces. `spawnFn` is forwarded so the
    // existing test injection seam still works.
    const managed = await managedSpawn(
      binPath,
      args,
      {
        class: 'sidecar',
        title: 'local whisper-server (STT)',
        argv: [binPath, ...args],
        launchedBy: 'system:local-whisper-service',
        detail: { url },
      },
      { spawnOptions: { stdio: 'ignore', detached: false }, spawnFn },
    );
    child = managed.child;
    // Register the lifecycle hook on the SPAWN seam, not at one lucky host bootstrap call site.
    // `async-with-exit` signals the child synchronously even on Node's `exit` event, then awaits
    // the bounded stop sequence for normal SIGTERM/SIGINT. The registrar is idempotent by label,
    // so repeated recovery attempts never stack process listeners.
    registerSidecarShutdownHooks({
      label: 'local-whisper-service',
      mode: 'async-with-exit',
      stop: stopLocalWhisper,
    });
    // Keep the pending child visible to stopLocalWhisper while its model is loading. Previously
    // state.child was assigned only after /health passed, so a shutdown in this window had no
    // handle to signal and leaked the just-spawned server.
    state.child = child;
    state.url = url;
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', detail: e instanceof Error ? e.message : String(e) };
  }
  const spawnError: Promise<EnsureWhisperResult> = new Promise((resolve) => {
    child.once('error', (e) => resolve({ ok: false, reason: 'spawn-failed', detail: e.message }));
  });
  child.on('exit', () => {
    if (state.child === child) {
      state.child = null;
      state.url = null;
    }
  });

  // Health-gate: the model load takes ~1s (base) — poll until it answers or time out.
  const deadline = now() + timeoutMs;
  const healthy: Promise<EnsureWhisperResult> = (async () => {
    while (now() < deadline) {
      if (child.exitCode !== null) {
        return { ok: false, reason: 'spawn-failed' as const, detail: `whisper-server exited ${child.exitCode} during startup` };
      }
      if (await probe(url)) {
        return { ok: true, url, source: 'managed' as const };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    child.kill('SIGTERM');
    if (state.child === child) {
      state.child = null;
      state.url = null;
    }
    return { ok: false, reason: 'unhealthy' as const, detail: `whisper-server did not answer /health within ${timeoutMs}ms` };
  })();

  return Promise.race([healthy, spawnError]);
}
