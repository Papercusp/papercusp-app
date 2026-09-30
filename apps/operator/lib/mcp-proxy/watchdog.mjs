#!/usr/bin/env node
/**
 * mcp-proxy (:9071) LIVENESS watchdog — EI-9237.
 *
 * Incident 2026-07-10 ~14:28-14:37 EDT: papercup-mcp-proxy.service's event loop wedged (port
 * held, ESTAB clients, zero responses) while :3070 upstream stayed healthy. The proxy exists
 * precisely so a :3070 deploy restart is invisible to MCP clients (mcp-host-availability-
 * resilience-2026-06-22 P-005) — but it is itself an unwatched single point of failure. `psu`
 * dials :9071 first at startup, so EVERY invocation hung with zero output until a human noticed
 * ~9 minutes later and ran `systemctl --user restart papercup-mcp-proxy` by hand. Because the
 * process stayed `active` (port listening, just not answering), systemd's own `Restart=always`
 * never fires on this class of wedge — same blind spot the bg-host / inference-gateway
 * watchdogs exist to cover for their own services.
 *
 * DETECTION: the proxy is a stateless HTTP/TCP passthrough with no internal request counters to
 * inspect (unlike the inference-gateway's /stats-based freeze detector), so REACHABILITY of
 * :9071 (not a direct :3070 probe, which would miss a wedge in the proxy itself) is the whole
 * signal. Only a timeout/abort/connection-refused counts as unreachable; restart once
 * unreachable for >= UNREACHABLE_MS.
 *
 * ⚠ THE LIVENESS PROBE MUST NOT TRAVERSE THE UPSTREAM (WI-6743). This originally polled
 * `/api/health`, which the proxy FORWARDS to :3070, on the reasoning that "ANY response at all,
 * success or a proxied error status, proves the event loop is alive". That reasoning is void
 * here, because it contradicts this proxy's headline feature: retry-on-refused deliberately
 * WITHHOLDS a response for up to retryWindowMs (90s) while :3070 restarts, precisely so a deploy
 * is invisible to MCP clients. So during every deploy the proxy was alive and behaving exactly
 * as designed, and the probe recorded it as unreachable.
 *
 * Measured cost: 272 false `unreachable` incidents from 2026-07-10 to 2026-08-02. 11 of the 12
 * that fall inside journalctl's retention window are within 15s of a `Started papercup-dev-api`
 * (signed delta -5s..+8s); across all 272, deploy minutes (papercup-release HEAD reflog) peak at
 * :31/:32 and stall minutes at :32/:33/:34 — the same distribution shifted by the restart lag.
 * 76/272 fall within 60s of a deploy vs 8/272 for a +30min placebo shift. Beyond the noise, this
 * blinded the detector to the condition it exists for: a genuine wedge and a routine deploy
 * produced a byte-identical log line, and the resulting 272 look-alikes are what made WI-6743
 * spend two investigation cycles chasing DB-pool exhaustion and CPU starvation.
 *
 * We therefore poll LIVENESS_PROBE_PATH, which the proxy answers ITSELF (proxy.ts) without
 * touching :3070. A wedged event loop still cannot answer it, so wedge detection is unchanged;
 * upstream health is already covered — and correctly CLASSIFIED — by the session-plane and
 * data-plane probes below, which is where that judgement belongs.
 *
 * SAFE FOR UNATTENDED OPERATION: same shape as the bg-host / inference-gateway watchdogs — a
 * restart debounce + a rolling-hour circuit breaker so a misfire can never restart-loop forever,
 * and a durable journald-INDEPENDENT log file (the 2026-06-22 EI-2434 journal-silence precedent:
 * a decision log nobody can read is as good as no log).
 *
 * Env (all optional): PAPERCUSP_MCP_PROXY_WATCHDOG_PORT, _POLL_MS, _UNREACHABLE_MS, _DEBOUNCE_MS,
 *   _MAX_RESTARTS_HR, _UNIT, _LOG.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { MCP_PROXY_LOCAL_HEALTH_PATH, MCP_PROXY_RETRY_WINDOW_MS, PSU_CLIENT_HEADROOM_MS } from './budgets.mjs';
import { samplePgBouncerPools, SAMPLE_LOG_FILE as POOL_SAMPLE_LOG_FILE, MIN_SAMPLE_INTERVAL_MS as POOL_SAMPLE_MIN_INTERVAL_MS } from './pgbouncer-pool-sample.mjs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXTERNAL_SCHEDULES } from '../../../../packages/operator-core/lib/schedule-descriptors.mjs';

const execFileAsync = promisify(execFile);

async function runCommand(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, options);
    return { err: null, stdout: String(stdout ?? '') };
  } catch (error) {
    return { err: error, stdout: String(error?.stdout ?? '') };
  }
}

const PORT = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_PORT) || 9071;
const POLL_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POLL_MS) || EXTERNAL_SCHEDULES.mcpProxyWatchdogPoll.defaultIntervalMs;
const SESSION_PLANE_POLL_MS =
  Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POLL_MS) || EXTERNAL_SCHEDULES.mcpProxySessionPlanePoll.defaultIntervalMs;
/**
 * The liveness path — see "THE LIVENESS PROBE MUST NOT TRAVERSE THE UPSTREAM" above.
 * proxy.ts answers this one locally (`{ok:true,target}`) and returns BEFORE any forwarding,
 * so it stays truthful while retry-on-refused is holding a real request. Any upstream-forwarded
 * path (`/api/health`, `/api/mcp`, …) is WRONG here and reintroduces WI-6743's false alarms.
 */
export const LIVENESS_PROBE_PATH = MCP_PROXY_LOCAL_HEALTH_PATH;

/** Exported so the "must not traverse the upstream" invariant is unit-testable. */
export function livenessProbeUrl(port = PORT) {
  return `http://127.0.0.1:${port}${LIVENESS_PROBE_PATH}`;
}
/** The 2026-07-10 incident ran ~9min undetected; this threshold is deliberately short (2x the
 *  bg-host's 30s poll granularity) so a real wedge is caught within ~1min, not left to fester. */
const UNREACHABLE_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_UNREACHABLE_MS) || 45_000;
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
/**
 * RATE escalation (WI-6744). The restart threshold above only fires on ONE outage lasting
 * >= UNREACHABLE_MS. A burst of short outages that each self-recover therefore produces a run of
 * `recovered (was unreachable 10s)` lines and no action — which READS as a system healing itself
 * rather than one failing repeatedly. Severity was invisible at the layer that observed it.
 *
 * ⚠ ORDERING: this detector is only safe because the liveness probe no longer traverses the
 * upstream (WI-6743/WI-6924). Before that fix an `unreachable` event mostly meant "a deploy
 * restarted :3070", so escalating on rate would have paged on ~76 routine deploys a month and
 * been muted within a week. Now an event means the proxy failed to answer its OWN local route,
 * which is always worth counting. Do not reintroduce a forwarded liveness path without also
 * reconsidering these numbers.
 */
const RATE_WINDOW_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_RATE_WINDOW_MS) || 60 * 60_000;
const RATE_THRESHOLD = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_RATE_THRESHOLD) || 3;
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_MAX_RESTARTS_HR) || 6;
const UNIT = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_UNIT || 'papercup-mcp-proxy';
const INTEGRATION_ROOT =
  process.env.PAPERCUSP_INTEGRATION_ROOT?.trim() ||
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PTOOL_SCRIPT =
  process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_PTOOL_SCRIPT ||
  join(INTEGRATION_ROOT, 'apps/operator/scripts/ptool.mjs');

/**
 * The proxy process tsx-loads these runtime paths from the integration tree. Keep this
 * list scoped to the proxy itself: the watchdog lives beside the proxy but changing the
 * watchdog must not make it restart the proxy it is supervising. The service-health
 * detector intentionally uses the broader directory for diagnosis; this narrower list
 * is the activation safety boundary.
 */
export const MCP_PROXY_COMMITTED_HOT_PATHS = Object.freeze([
  'apps/operator/lib/mcp-proxy',
  'apps/operator/bin/mcp-proxy.ts',
]);
const MCP_PROXY_COMMITTED_HOT_PATH_SOURCE_PATHS = Object.freeze([
  ':(glob)apps/operator/lib/mcp-proxy/**/*.ts',
  ':(glob)apps/operator/lib/mcp-proxy/**/*.mjs',
  ':(glob)apps/operator/lib/mcp-proxy/**/*.js',
  'apps/operator/bin/mcp-proxy.ts',
]);
const MCP_PROXY_COMMITTED_HOT_PATH_TEST_EXCLUSIONS = Object.freeze([
  ':(exclude,glob)**/*.test.ts',
  ':(exclude,glob)**/*.test.tsx',
  ':(exclude,glob)**/*.spec.ts',
  ':(exclude,glob)**/*.spec.tsx',
  ':(exclude,glob)**/__tests__/**',
  ':(exclude)apps/operator/lib/mcp-proxy/watchdog.mjs',
  ':(exclude)apps/operator/lib/mcp-proxy/watchdog.d.mts',
]);
const MCP_PROXY_DIRTY_PATH_EXCLUSIONS = Object.freeze([
  ':(exclude)apps/operator/lib/mcp-proxy/watchdog.mjs',
  ':(exclude)apps/operator/lib/mcp-proxy/watchdog.d.mts',
  ':(exclude)apps/operator/lib/mcp-proxy/watchdog.test.ts',
]);
/** A git read + cgroup-free coordinated restart is much less frequent than liveness polling. */
const HOT_PATH_ACTIVATION_CHECK_MS =
  Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_HOT_PATH_ACTIVATION_CHECK_MS) || 5 * 60_000;
/** Let active proxy calls drain, but never use an unsafe override to kill a peer's call. */
const HOT_PATH_RESTART_DRAIN_SEC =
  Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_HOT_PATH_RESTART_DRAIN_SEC) || 30;
const HOT_PATH_PTOOL_TIMEOUT_MS = 30_000 + HOT_PATH_RESTART_DRAIN_SEC * 1_000;
/** Durable, journald-INDEPENDENT decision log — see the bg-host / inference-gateway watchdogs'
 *  identical rationale (EI-2434: journald's stdout-socket capture was itself observed wedged). */
const LOG_FILE = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_LOG || join(homedir(), '.papercusp', 'mcp-proxy-watchdog.log');

/* ────────────────────────────────────────────────────────────────────────────
 * SESSION-PLANE probe — EI-19299524366372518 (2026-08-01 incident).
 *
 * The /api/health probe above answers "is the event loop alive?". It CANNOT answer
 * "can a client actually get a tool catalog?", and on 2026-08-01 those diverged for
 * ~100 minutes: /api/health returned 200 in ~2ms continuously while the MCP session
 * plane was completely dead. Fleet tool throughput fell 2759 -> 44 calls/30min, 29 su
 * sessions went dark for a median of 80 minutes, and this watchdog logged nothing but
 * its routine 10s blips. Every consumer of :9071 cares about the tool catalog; nobody
 * cares about /api/health. So we probe the thing that matters.
 *
 * COST. The probe asks for a SINGLE tool (`?tools=`), so a healthy poll is ~4KB/15s.
 * The unfiltered catalog is ~980KB / 742 tools and is fetched ONLY as a confirmation
 * step before acting (see below) — never on the steady-state path. That matters: this
 * incident involved a resource-starved operator, and a watchdog that adds ~65KB/s plus
 * a 742-tool assembly every 15s would be pushing the thing it is meant to protect.
 *
 * TWO FALSE-POSITIVE TRAPS, both measured on the live endpoint, both guarded:
 *
 *  1. UNAUTHENTICATED reads as dead. With a missing/expired bearer the server returns
 *     HTTP 200 with ZERO tools — its own error text says so explicitly: "this MCP
 *     session is UNAUTHENTICATED, so it exposes NO tools (this is NOT 'a healthy server
 *     with zero tools')". A watchdog that restarted services because its own credential
 *     expired would be strictly worse than the blindness it replaces, so `auth` is a
 *     PROBE-CONFIG fault: logged loudly, never counted as a service failure.
 *
 *  2. A STALE FILTER NAME reads as dead. `?tools=does-not-exist` also returns HTTP 200,
 *     zero tools, and NO error — indistinguishable from an empty catalog. Renaming
 *     PROBE_TOOL would otherwise arm a permanent false alarm. Hence `empty` is treated
 *     as AMBIGUOUS, never as a verdict: it triggers one unfiltered confirmation fetch,
 *     and a healthy confirmation reports the stale filter as a config warning instead.
 *
 * THRESHOLD. Deliberately longer than the reachability path's 45s: the proxy is *designed*
 * to absorb an upstream gap up to its own retry window (that is the entire point of the
 * service), so acting sooner would fight the resilience layer. Default = window + headroom
 * (120s today) — detection in ~2min against the ~100min this incident actually took.
 *
 * DERIVED, not hard-coded (WI-6738). A literal here would be the same latent bug this
 * watchdog's sibling fix just removed: raise PAPERCUSP_MCP_PROXY_RETRY_MS and a frozen 120s
 * would start alarming DURING legitimate absorption. Sharing budgets.mjs means the whole
 * system's "how long may the proxy legitimately take?" answer moves in one place.
 * ──────────────────────────────────────────────────────────────────────────── */
const UPSTREAM_PORT = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_UPSTREAM_PORT) || 3070;
const HANDSHAKE_TIMEOUT_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_HANDSHAKE_TIMEOUT_MS) || 10_000;
const HANDSHAKE_UNHEALTHY_MS =
  Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_HANDSHAKE_UNHEALTHY_MS) ||
  MCP_PROXY_RETRY_WINDOW_MS + PSU_CLIENT_HEADROOM_MS;
/** Any single stable tool name; correctness does NOT depend on it (trap 2 above). */
const PROBE_TOOL = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_PROBE_TOOL || 'coord:orient';
/**
 * DATA-PLANE probe tool (WI-6739). Must be READ-ONLY and must actually touch Postgres —
 * the whole point is to execute a query, not to prove the registry can be serialised.
 * `facts:list` is a cheap scoped SELECT with no side effects.
 */
const DEFAULT_DB_PROBE_TOOL = 'facts:list';
/** Arguments the DEFAULT probe tool needs. Scoped so a healthy poll stays a small SELECT. */
const DEFAULT_DB_PROBE_ARGS = { scope: 'workspace' };
const DB_PROBE_TOOL = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_TOOL || DEFAULT_DB_PROBE_TOOL;
const DB_PROBE_ARGS_RAW = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_ARGS;
const SUPERUSER_TOKEN_FILE = join(homedir(), '.papercusp', 'superuser-token');

/**
 * Escalation to a human via coord:escalate (EI-19415174699106397 / WI-6739 follow-up).
 *
 * Before this, a CRITICAL verdict only ever reached a durable LOG FILE — nobody tails it in
 * real time. Measured live 2026-08-03 ~06:49-07:14Z: this exact watchdog correctly diagnosed
 * a dead data plane, correctly withheld the useless proxy restart, and then repeated the same
 * CRITICAL line every throttle window for 25 minutes while no human or agent acted, because it
 * had no channel to actually reach one. It knew the remediation and could not perform or
 * escalate it.
 *
 * `conditionKey` is REQUIRED so repeated firings of the same live condition coalesce onto one
 * open escalation row (bumping repeatCount) instead of leaking a new one per throttle window —
 * the exact flood class WI-... already fixed for `coord:escalate` callers that pass a stable key.
 *
 * Deliberately best-effort and thrown away on failure: `coord:escalate` itself persists via
 * Postgres, so during a genuine DATA-PLANE-dead condition this call can fail for the identical
 * reason it exists to report. That is tolerated, not papered over — this fires on EVERY
 * throttled CRITICAL cycle (not just once), and the live log shows the proxy/data plane
 * flapping between FAILING and recovered during a real incident, so a retried escalation has a
 * real chance of landing in one of those windows even when the very first attempt does not.
 */
export function buildEscalationCall(conditionKey, summary, body) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'coord:escalate',
      arguments: {
        severity: 'blocker',
        summary,
        body,
        conditionKey,
        evidence: { band: 'observed', reportedBy: 'mcp-proxy-watchdog' },
      },
    },
  };
}

async function escalateToHuman(conditionKey, summary, body) {
  const token = readProbeToken();
  if (!token) return; // no credential — already logged loudly elsewhere; nothing to escalate with
  const qs = `superuser=1&client=mcp-proxy-watchdog-escalate&tools=${encodeURIComponent('coord:escalate')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/mcp?${qs}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(buildEscalationCall(conditionKey, summary, body)),
    });
    const json = parseMcpBody(await res.text());
    if (json?.error) log(`escalate FAILED (${conditionKey}): ${json.error.message ?? `HTTP ${res.status}`}`);
    else if (res.status !== 200) log(`escalate FAILED (${conditionKey}): HTTP ${res.status}`);
    // A successful escalation is silent here — the CRITICAL log line right beside this call
    // already recorded the condition; no need to double-log the happy path.
  } catch (e) {
    log(`escalate FAILED (${conditionKey}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

let unreachableSince = 0;
/** Onset timestamps of recent unreachable episodes — the rolling window behind WI-6744. */
let stallOnsets = [];
let lastRateEscalationAt = 0;
let handshakeFailingSince = 0;
let dataFailingSince = 0;
let lastRestart = 0;
const restartTimes = []; // epoch ms of recent restarts (rolling 1h window for the circuit breaker)

let logDirEnsured = false;
const log = (m) => {
  const line = `[mcp-proxy-watchdog ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    if (!logDirEnsured) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      logDirEnsured = true;
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* durable log unavailable (perm/disk) — console.log remains the fallback; never let logging crash the watchdog */
  }
};

/** Pure, fail-closed activation verdict for committed proxy code (EI-22647232817982385).
 * A restart is allowed only when the current generation is known, a committed runtime
 * change is newer than that generation, and the relevant working-tree paths are clean.
 * Unknown evidence never becomes permission to restart. */
export function evaluateMcpProxyHotPathActivation({
  activeForSec,
  latestCommitMs,
  latestCommitHash,
  nowMs,
  dirtyEntries,
}) {
  if (activeForSec == null || !Number.isFinite(activeForSec) || activeForSec < 0) {
    return { activate: false, code: 'generation_unknown' };
  }
  if (nowMs == null || !Number.isFinite(nowMs) || nowMs <= 0) {
    return { activate: false, code: 'clock_unknown' };
  }
  if (
    latestCommitMs == null ||
    !Number.isFinite(latestCommitMs) ||
    latestCommitMs <= 0 ||
    typeof latestCommitHash !== 'string' ||
    latestCommitHash.trim() === ''
  ) {
    return { activate: false, code: 'commit_unknown' };
  }
  if (latestCommitMs > nowMs) {
    return { activate: false, code: 'commit_time_future' };
  }
  const bootMs = nowMs - activeForSec * 1000;
  if (!Number.isFinite(bootMs) || bootMs < 0) {
    return { activate: false, code: 'generation_unknown' };
  }
  if (latestCommitMs <= bootMs) {
    return { activate: false, code: 'generation_current', bootMs, latestCommitMs, latestCommitHash };
  }
  if (!Array.isArray(dirtyEntries)) {
    return { activate: false, code: 'cleanliness_unknown', bootMs, latestCommitMs, latestCommitHash };
  }
  if (dirtyEntries.length > 0) {
    return {
      activate: false,
      code: 'hot_paths_dirty',
      bootMs,
      latestCommitMs,
      latestCommitHash,
      dirtyCount: dirtyEntries.length,
      dirtySample: dirtyEntries.slice(0, 5),
    };
  }
  return { activate: true, code: 'activate', bootMs, latestCommitMs, latestCommitHash };
}

/** Pure throttle/reentrancy guard for the activation read/restart path. */
export function shouldCheckMcpProxyHotPathActivation({ inFlight, lastCheckMs, nowMs, intervalMs }) {
  if (inFlight === true) return false;
  if (![lastCheckMs, nowMs, intervalMs].every(Number.isFinite)) return false;
  if (intervalMs < 0 || nowMs < lastCheckMs) return false;
  return lastCheckMs === 0 || nowMs - lastCheckMs >= intervalMs;
}

/** Read committed proxy changes and current dirtiness. Every missing signal is returned as
 * null/unknown so the caller can fail closed instead of manufacturing a clean tree. */
export async function readMcpProxyHotPathState(deps = {}) {
  const shImpl = deps.sh ?? runCommand;
  let root = deps.root ?? process.env.PAPERCUSP_INTEGRATION_ROOT?.trim() ?? null;
  if (!root) {
    const rootRead = await shImpl('git', ['-C', dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel'], {
      timeout: 3000,
    });
    if (rootRead.err || !String(rootRead.stdout).trim()) {
      return { root: null, latestCommitMs: null, latestCommitHash: null, dirtyEntries: null, error: 'root_unknown' };
    }
    root = String(rootRead.stdout).trim();
  }

  const [commitRead, dirtyRead] = await Promise.all([
    shImpl(
      'git',
      [
        '-C',
        root,
        'log',
        '-1',
        '--format=%ct%x00%H',
        '--',
        ...MCP_PROXY_COMMITTED_HOT_PATH_SOURCE_PATHS,
        ...MCP_PROXY_COMMITTED_HOT_PATH_TEST_EXCLUSIONS,
      ],
      { timeout: 3000, cwd: root, maxBuffer: 4 * 1024 * 1024 },
    ),
    shImpl(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...MCP_PROXY_COMMITTED_HOT_PATHS, ...MCP_PROXY_DIRTY_PATH_EXCLUSIONS],
      { timeout: 3000, cwd: root, maxBuffer: 4 * 1024 * 1024 },
    ),
  ]);

  let latestCommitMs = null;
  let latestCommitHash = null;
  if (!commitRead.err) {
    const [epochSec, hash] = String(commitRead.stdout).trim().split('\0');
    const parsedMs = Number(epochSec) * 1000;
    if (Number.isFinite(parsedMs) && parsedMs > 0 && hash?.trim()) {
      latestCommitMs = parsedMs;
      latestCommitHash = hash.trim();
    }
  }
  const dirtyEntries = dirtyRead.err
    ? null
    : String(dirtyRead.stdout)
        .split('\0')
        .map((entry) => entry.trim())
        .filter(Boolean);
  return {
    root,
    latestCommitMs,
    latestCommitHash,
    dirtyEntries,
    error: commitRead.err ? 'commit_unknown' : dirtyRead.err ? 'cleanliness_unknown' : null,
  };
}

async function mcpProxyActiveForSec(deps = {}) {
  const readFile = deps.readFile ?? readFileSync;
  const shImpl = deps.sh ?? runCommand;
  let uptimeSec;
  try {
    uptimeSec = Number.parseFloat(String(readFile('/proc/uptime', 'utf8')).trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
  if (!Number.isFinite(uptimeSec)) return null;
  const result = await shImpl('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveEnterTimestampMonotonic', '--value'], {
    timeout: 3000,
  });
  if (result.err) return null;
  const activeMonoUsec = Number(result.stdout.trim());
  if (!Number.isFinite(activeMonoUsec) || activeMonoUsec <= 0) return null;
  const activeForSec = uptimeSec - activeMonoUsec / 1_000_000;
  return activeForSec >= 0 ? activeForSec : null;
}

function parsePtoolJson(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    for (const line of raw.split('\n').reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        /* launcher prelude — keep looking */
      }
    }
    return null;
  }
}

/** Invoke the existing coordinated restart surface; never bypass it with raw systemctl. */
export async function requestMcpProxyHotPathRestart(latestCommitHash, deps = {}) {
  const shImpl = deps.sh ?? runCommand;
  const ptoolScript = deps.ptoolScript ?? PTOOL_SCRIPT;
  const shortHash = String(latestCommitHash ?? 'unknown').slice(0, 12);
  const args = {
    target: 'mcp-proxy',
    confirm: true,
    authorize: true,
    max_drain_sec: HOT_PATH_RESTART_DRAIN_SEC,
    reason: `auto-activate committed mcp-proxy hot-path ${shortHash}; clean tree and known generation`,
  };
  const run = await shImpl(process.execPath, [ptoolScript, 'dev:restart', '--json', '-'], {
    stdin: JSON.stringify(args),
    timeout: HOT_PATH_PTOOL_TIMEOUT_MS,
  });
  if (run.err) return { ok: false, restarted: false, coalesced: false, code: 'ptool_failed', error: run.err.message };
  const body = parsePtoolJson(run.stdout);
  if (!body || body.ok !== true) {
    return { ok: false, restarted: false, coalesced: false, code: body?.reason ?? 'ptool_result_unknown', body };
  }
  return {
    ok: true,
    restarted: body.restarted === true,
    coalesced: body.coalesced === true,
    code: body.restarted === true ? 'restarted' : body.coalesced === true ? 'coalesced' : 'no_restart',
    body,
  };
}

let hotPathActivationCheckInFlight = false;
let lastHotPathActivationCheckMs = 0;
let lastHotPathActivationDecisionKey = null;

async function maybeActivateMcpProxyHotPathCode() {
  const checkStartedAtMs = Date.now();
  if (!shouldCheckMcpProxyHotPathActivation({
    inFlight: hotPathActivationCheckInFlight,
    lastCheckMs: lastHotPathActivationCheckMs,
    nowMs: checkStartedAtMs,
    intervalMs: HOT_PATH_ACTIVATION_CHECK_MS,
  })) return { restartRequested: false, code: 'throttled_or_in_flight' };
  hotPathActivationCheckInFlight = true;
  lastHotPathActivationCheckMs = checkStartedAtMs;
  try {
    const [activeForSec, state] = await Promise.all([mcpProxyActiveForSec(), readMcpProxyHotPathState()]);
    const verdict = evaluateMcpProxyHotPathActivation({
      activeForSec,
      latestCommitMs: state.latestCommitMs,
      latestCommitHash: state.latestCommitHash,
      nowMs: Date.now(),
      dirtyEntries: state.dirtyEntries,
    });
    const decisionKey = `${state.latestCommitHash ?? 'unknown'}:${verdict.code}:${verdict.dirtyCount ?? ''}`;
    if (verdict.code !== 'generation_current' && decisionKey !== lastHotPathActivationDecisionKey) {
      lastHotPathActivationDecisionKey = decisionKey;
      const dirty = verdict.dirtySample?.length ? ` dirty=${verdict.dirtySample.join(' | ')}` : '';
      log(`committed mcp-proxy hot-path activation ${verdict.activate ? 'READY' : 'SUPPRESSED'} (${verdict.code}) commit=${state.latestCommitHash?.slice(0, 12) ?? 'UNKNOWN'}${dirty}`);
    }
    if (!verdict.activate) return { restartRequested: false, code: verdict.code };
    const reason = `committed mcp-proxy hot-path ${state.latestCommitHash.slice(0, 12)} is newer than the running generation`;
    if (!admitRestart(reason)) return { restartRequested: false, code: 'restart_suppressed' };
    const outcome = await requestMcpProxyHotPathRestart(state.latestCommitHash);
    log(
      outcome.ok
        ? `committed mcp-proxy hot-path activation via dev:restart: ${outcome.code} (commit ${state.latestCommitHash.slice(0, 12)})`
        : `committed mcp-proxy hot-path activation REFUSED/FAILED by dev:restart (${outcome.code}) — monitoring continues`,
    );
    return { restartRequested: outcome.restarted === true, code: outcome.code };
  } catch (error) {
    log(`committed mcp-proxy hot-path activation probe FAILED CLOSED: ${error?.message ?? String(error)}`);
    return { restartRequested: false, code: 'probe_failed' };
  } finally {
    hotPathActivationCheckInFlight = false;
  }
}

/** Pure decision: given how long the proxy has been continuously unreachable, should we restart
 *  now? Exported so the threshold logic is unit-testable without a live poll loop / network. */
export function shouldRestart(unreachableSinceMs, nowMs, thresholdMs = UNREACHABLE_MS) {
  if (!unreachableSinceMs) return false;
  return nowMs - unreachableSinceMs >= thresholdMs;
}

/**
 * Pure decision for RATE escalation (WI-6744): drop events older than the window, then report
 * whether the survivors reach the threshold. Exported for the same reason as shouldRestart —
 * so the judgement is unit-testable without a live poll loop.
 *
 * Takes the event list by value and RETURNS the pruned list; the caller owns the state. Counting
 * a self-recovering burst is the whole point: each event individually looks like a recovery.
 */
export function evaluateStallRate(eventTimesMs, nowMs, windowMs = RATE_WINDOW_MS, threshold = RATE_THRESHOLD) {
  const kept = eventTimesMs.filter((t) => nowMs - t < windowMs);
  return { kept, count: kept.length, escalate: kept.length >= threshold, windowMs, threshold };
}

/**
 * Pure verdict for one session-plane probe. Split out from the network call so the
 * exact 2026-08-01 miss is expressible as a unit test: a target that answers
 * /api/health with 200/2ms but cannot serve a tool catalog MUST be judged unhealthy.
 *
 *   'ok'    — a well-formed JSON-RPC result carrying a NON-EMPTY tool catalog. Proves
 *             the whole path a real client needs: session established, bearer accepted,
 *             registry assembled, response serialised.
 *   'auth'  — the credential was rejected. A PROBE-CONFIG fault, never a service fault.
 *   'empty' — 200 + zero tools + no error. AMBIGUOUS (stale filter vs genuinely empty
 *             registry); the caller must confirm before treating it as a verdict.
 *   'dead'  — no response, non-200, unparseable, or a non-auth JSON-RPC error.
 */
export function classifyProbeResult({ networkError, status, json } = {}) {
  if (networkError) return 'dead';
  if (status !== 200) return 'dead';
  if (!json || typeof json !== 'object') return 'dead';
  const err = json.error;
  if (err) {
    const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
    // The server reports a bad/expired bearer as a -32603 whose message names the cause.
    return text.includes('auth') || text.includes('bearer') || text.includes('unauthenticated')
      ? 'auth'
      : 'dead';
  }
  const tools = json.result?.tools;
  if (!Array.isArray(tools)) return 'dead';
  return tools.length > 0 ? 'ok' : 'empty';
}

/**
 * Pure remediation decision, given a confirmed-unhealthy proxy probe and a probe of the
 * upstream taken at the same moment.
 *
 * The discrimination is the point. On 2026-08-01 the proxy was fine and :3070 was wedged
 * — restarting the proxy would have accomplished nothing while burning a slot in the
 * circuit breaker and making the log lie about what was broken. Only a :3070 restart
 * cleared it (all 29 dark sessions recovered inside the 7 minutes after it).
 */
/**
 * Pure verdict for one DATA-PLANE probe — the third plane, and the one that actually
 * failed on 2026-08-01 (WI-6739).
 *
 * That outage had THREE distinct planes and only the third was broken:
 *   /api/health      → 200 in ~2ms, continuously.
 *   session plane    → fine. Of the whole peak hour only 9 `/api/mcp` requests failed…
 *   data plane       → …against 5,542 failed DB-backed `bootstrap-su/heartbeat` POSTs.
 * :3070 was ECONNREFUSING a dead Postgres endpoint (a stale embedded-pg port) while its
 * event loop, its HTTP server and its in-memory tool registry were all perfectly healthy.
 * So a `tools/list` probe — which is served from the registry and never queries PG — stays
 * GREEN throughout. A detector that is green during the incident it exists to catch is
 * worse than no detector, because it actively reassures. Hence: execute a real read-only
 * tool and require it to come back.
 *
 * The classification is deliberately conservative so this can never cry wolf:
 *   'ok'     — a JSON-RPC result came back. The query ran.
 *   'config' — a JSON-RPC error that is NOT connection-shaped (bad args, renamed tool).
 *              OUR fault, never the service's — logged, never alarmed.
 *   'dead'   — no response / timeout / non-200 (a 408 is literally what clients saw), or a
 *              JSON-RPC error naming a connection failure (the tool ran and could not reach PG).
 */
export function classifyDataPlaneResult({ networkError, status, json } = {}) {
  if (networkError) return 'dead'; // timeout — a pool waiting on a dead endpoint never answers
  if (status !== 200) return 'dead'; // 408/5xx — the exact client-visible symptom on 2026-08-01
  if (!json || typeof json !== 'object') return 'dead';
  const err = json.error;
  if (err) {
    const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
    if (text.includes('auth') || text.includes('bearer') || text.includes('unauthenticated')) return 'config';
    // A tool that RAN but could not reach the database is the signal, not a config fault.
    const connectionShaped =
      text.includes('econnrefused') ||
      text.includes('etimedout') ||
      text.includes('econnreset') ||
      text.includes('connect ') ||
      text.includes('connection') ||
      text.includes('pool') ||
      text.includes('timeout');
    return connectionShaped ? 'dead' : 'config';
  }
  return json.result ? 'ok' : 'config';
}

/**
 * Arguments for the data-plane probe call.
 *
 * Fixes a trap in the remedy this watchdog prints at itself. On a 'config' verdict it says
 * "set PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_TOOL to a live read-only tool" — but the args
 * used to be hard-coded to `{ scope: 'workspace' }`, which only `facts:list` accepts. So
 * following that instruction sent the DEFAULT tool's arguments to the NEW tool, which fails
 * validation, which is another 'config' verdict: the documented fix could not work, and the
 * watchdog stayed blind while looking configured.
 *
 * Rules, in order: an explicit override wins; the default args apply ONLY to the default
 * tool; any other tool starts empty. A malformed override is reported (`invalid`) rather
 * than silently falling back to args that belong to a different tool — silently probing with
 * the wrong arguments is exactly the blindness above, one layer down.
 */
export function dataPlaneProbeArgs(tool, rawArgs, defaultTool = DEFAULT_DB_PROBE_TOOL) {
  if (rawArgs != null && String(rawArgs).trim() !== '') {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed, invalid: false };
      }
    } catch {
      /* reported as `invalid` below — never silently substituted */
    }
    return { args: {}, invalid: true };
  }
  return { args: tool === defaultTool ? { ...DEFAULT_DB_PROBE_ARGS } : {}, invalid: false };
}

/**
 * WI-39378 — the LAST gate before an irreversible, third-party-destructive action.
 *
 * Restarting the proxy kills every agent's in-flight MCP call, so the verdict must be
 * true at the MOMENT of restarting, not merely when it was computed. `pollHandshake`
 * decides "dead", then awaits an upstream probe that can burn a full
 * HANDSHAKE_TIMEOUT_MS, and only then acts — a window the plane can recover inside.
 * It did, live, on 2026-08-16T03:54:37Z: "session plane recovered (was failing 156s)"
 * at .232, "WEDGED -> restarting" at .826, 594ms later.
 *
 * Two independent ways the verdict can be stale, and both must stand the restart down:
 *   - `failingSince === 0`  — a concurrent poll observed recovery and cleared it.
 *   - `recheckKind === 'ok'` — the plane answers right now, whatever we believed before.
 * Pass `recheckKind: null` to test only the first (i.e. before spending a probe).
 *
 * @param {number} failingSince    epoch ms the plane started failing; 0 = not failing
 * @param {string|null} recheckKind  a fresh probe verdict, or null if not probed yet
 * @returns {'stand-down-recovered'|'stand-down-recheck-ok'|'restart'}
 */
export function decideRestartAfterRecheck(failingSince, recheckKind) {
  if (!failingSince) return 'stand-down-recovered';
  if (recheckKind === 'ok') return 'stand-down-recheck-ok';
  return 'restart';
}

export function decideHandshakeAction(proxyKind, upstreamKind) {
  if (proxyKind === 'ok') return 'none';
  if (proxyKind === 'auth') return 'none'; // our own credential; never a service verdict
  return upstreamKind === 'ok' ? 'restart-proxy' : 'upstream-wedged';
}

/** Read the superuser bearer fresh each probe (32 bytes; picks up rotation for free). */
function readProbeToken() {
  try {
    return readFileSync(SUPERUSER_TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Extract the JSON-RPC payload from either an SSE frame or a plain JSON body. */
function parseMcpBody(text) {
  const frame = text.split('\n').find((l) => l.startsWith('data: '));
  try {
    return JSON.parse(frame ? frame.slice(6) : text);
  } catch {
    return null;
  }
}

/**
 * One session-plane probe against `port`. `full: true` drops the single-tool filter and
 * asks for the whole catalog — the confirmation path only (see the cost note above).
 */
async function probeMcp(port, { full = false } = {}) {
  const token = readProbeToken();
  if (!token) return { kind: 'auth', detail: `no superuser token at ${SUPERUSER_TOKEN_FILE}` };
  const qs = `superuser=1&client=mcp-proxy-watchdog${full ? '' : `&tools=${encodeURIComponent(PROBE_TOOL)}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp?${qs}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const json = parseMcpBody(await res.text());
    const kind = classifyProbeResult({ status: res.status, json });
    return { kind, detail: kind === 'ok' ? `${json.result.tools.length} tools` : (json?.error?.message ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { kind: 'dead', detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a real read-only tool through a real MCP session, so the probe exercises the
 * DATABASE, not just the tool registry. See classifyDataPlaneResult for why.
 */
async function probeDataPlane(port) {
  const token = readProbeToken();
  if (!token) return { kind: 'config', detail: `no superuser token at ${SUPERUSER_TOKEN_FILE}` };
  const qs = `superuser=1&client=mcp-proxy-watchdog-db&tools=${encodeURIComponent(DB_PROBE_TOOL)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp?${qs}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: DB_PROBE_TOOL, arguments: dataPlaneProbeArgs(DB_PROBE_TOOL, DB_PROBE_ARGS_RAW).args },
      }),
    });
    const json = parseMcpBody(await res.text());
    const kind = classifyDataPlaneResult({ status: res.status, json });
    return { kind, detail: kind === 'ok' ? 'query returned' : (json?.error?.message ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { kind: 'dead', detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function admitRestart(reason) {
  const now = Date.now();
  if (now - lastRestart < DEBOUNCE_MS) {
    log(`SUPPRESS (debounce ${Math.round((DEBOUNCE_MS - (now - lastRestart)) / 1000)}s left): ${reason}`);
    return false;
  }
  while (restartTimes.length && now - restartTimes[0] > 3_600_000) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_PER_HR) {
    log(`CIRCUIT OPEN: ${restartTimes.length} restarts in the last hour >= cap ${MAX_RESTARTS_PER_HR} — NOT restarting (${reason}). Manual attention needed.`);
    return false;
  }
  lastRestart = now;
  restartTimes.push(now);
  return true;
}

function restart(reason) {
  if (!admitRestart(reason)) return false;
  log(`WEDGED -> restarting ${UNIT}: ${reason}`);
  execFile('systemctl', ['--user', 'restart', UNIT], (err) =>
    log(err ? `restart FAILED: ${err.message}` : 'restart issued OK'),
  );
  unreachableSince = 0;
  return true;
}

async function poll() {
  // Code drift is a separate, throttled lane. It runs in the existing watchdog cadence so
  // there is no second unregistered timer, and it never delays the liveness probe.
  void maybeActivateMcpProxyHotPathCode().catch((e) => log(`hot-path activation poll error: ${e.message}`));
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    // ANY http response proves the event loop answered — that's the whole liveness signal. We
    // deliberately do not inspect the body/status further; the wedge signature is "nothing comes
    // back at all". The path MUST be the proxy-local one: a forwarded path cannot answer while
    // retry-on-refused holds a request through a :3070 restart (WI-6743).
    await fetch(livenessProbeUrl(PORT), { signal: ctrl.signal });
    clearTimeout(t);
    if (unreachableSince) log(`recovered (was unreachable ${Math.round((Date.now() - unreachableSince) / 1000)}s)`);
    unreachableSince = 0;
  } catch (e) {
    const now = Date.now();
    if (!unreachableSince) {
      unreachableSince = now;
      log(`unreachable (${e.message})`);
      // EI-19384024494946006: capture PgBouncer's live pool state at the ONSET of a flap —
      // by the time a human/agent can look, the incident has usually already self-recovered.
      // Fire-and-forget: never let a diagnostic sample delay or break the poll loop.
      void samplePgBouncerPools('proxy-unreachable-onset').catch(() => {});
      // WI-6744: count the ONSET, so a burst of short self-recovering outages is visible as a
      // rate even though each one individually ends in a reassuring `recovered` line.
      stallOnsets.push(now);
      const rate = evaluateStallRate(stallOnsets, now, RATE_WINDOW_MS, RATE_THRESHOLD);
      stallOnsets = rate.kept;
      if (rate.escalate && now - lastRateEscalationAt >= RATE_WINDOW_MS) {
        lastRateEscalationAt = now;
        const summary = `${rate.count} proxy stalls in the last ${Math.round(rate.windowMs / 60_000)}min (threshold ${rate.threshold}) — each self-recovered, but a repeatedly-stalling proxy can kill a mid-handshake agent session (WI-6740)`;
        log(
          `CRITICAL: ${summary}. Since WI-6924 the liveness probe is proxy-local, so these are NOT :3070 deploys: the proxy ` +
            `is failing to answer its own route. Investigate ${UNIT}; do not just wait for a longer outage.`,
        );
        void escalateToHuman(
          'mcp-proxy-stall-rate',
          summary,
          `Investigate ${UNIT} — the proxy is failing to answer its own local liveness route, not upstream. See ${LOG_FILE} for the full stall history.`,
        ).catch(() => {});
      }
    } else if (shouldRestart(unreachableSince, now, UNREACHABLE_MS)) {
      restart(`unreachable for ${Math.round((now - unreachableSince) / 1000)}s (${e.message})`);
    }
  }
}

let lastAuthLog = 0;
let lastUpstreamLog = 0;
let lastDataLog = 0;
let lastDataConfigLog = 0;
const LOG_THROTTLE_MS = 10 * 60_000;

/**
 * Data-plane poll (WI-6739) — runs only once the session plane is GREEN, because that is
 * precisely the blind spot: on 2026-08-01 the catalog served fine while every DB-backed
 * call timed out for ~100 minutes and nothing anywhere alarmed.
 *
 * Never restarts the proxy. A :3070 that cannot reach Postgres is not a proxy fault, and
 * restarting the proxy would burn a circuit-breaker slot while the log blamed the wrong
 * service — the same reasoning as the upstream branch in pollHandshake.
 */
async function pollDataPlane() {
  const { kind, detail } = await probeDataPlane(PORT);

  if (kind === 'ok') {
    if (dataFailingSince) {
      log(`data plane recovered (was failing ${Math.round((Date.now() - dataFailingSince) / 1000)}s)`);
      dataFailingSince = 0;
    }
    return;
  }

  if (kind === 'config') {
    const now = Date.now();
    if (now - lastDataConfigLog > LOG_THROTTLE_MS) {
      lastDataConfigLog = now;
      log(`PROBE CONFIG: data-plane probe tool "${DB_PROBE_TOOL}" did not execute (${detail}) — this watchdog is BLIND to the WI-6739 class until fixed, but it is OUR probe config, not a service fault. Set PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_TOOL to a live read-only tool that queries Postgres, and PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_ARGS (JSON) to whatever arguments THAT tool needs — the default args belong to "${DEFAULT_DB_PROBE_TOOL}" and are not sent to any other tool.`);
    }
    return;
  }

  const now = Date.now();
  if (!dataFailingSince) {
    dataFailingSince = now;
    log(`data plane FAILING (${detail}) — session plane and /api/health are GREEN; that combination is the WI-6739 signature`);
    // EI-19384024494946006: this is the exact onset the WI-6739/EI-19384024494946006 mechanism
    // has twice gone unproven for — capture PgBouncer's live SHOW POOLS/SHOW STATS right now,
    // while it is still happening, instead of investigating from the outside after it heals.
    void samplePgBouncerPools('data-plane-failing-onset').catch(() => {});
    return;
  }
  if (!shouldRestart(dataFailingSince, now, HANDSHAKE_UNHEALTHY_MS)) return;

  if (now - lastDataLog > LOG_THROTTLE_MS) {
    lastDataLog = now;
    // WI-39378: this used to read `${secs}`, which is declared only inside pollHandshake —
    // a different function scope. pollDataPlane is awaited FROM pollHandshake, so the
    // ReferenceError unwound into that caller's `.catch`, surfacing as a single line
    // `handshake poll error: secs is not defined` and, far worse, aborting this block
    // BEFORE escalateToHuman below. The WI-6739 data-plane-dead escalation had therefore
    // never been able to fire — the detector was silently dead in exactly the case it
    // exists for. Measured live 2026-08-16T03:54:37Z. Keep this derived from
    // dataFailingSince, which is THIS function's own state.
    const secs = Math.round((now - dataFailingSince) / 1000);
    const summary = `MCP DATA plane dead ${secs}s while the session plane and /api/health stay GREEN (${detail}) — the WI-6739 signature`;
    const remediation = `check :${UPSTREAM_PORT}'s journal for repeated "connect ECONNREFUSED" to its DB port, then restart the operator host. Restarting ${UNIT} would NOT fix this.`;
    log(
      `CRITICAL: ${summary}. This is the 2026-08-01 signature (WI-6739): the operator on :${UPSTREAM_PORT} is serving its tool catalog from memory while every DB-backed call times out — most likely a dead/stale Postgres endpoint it will retry forever. ` +
        `Restarting ${UNIT} would NOT fix this and is being withheld. Remediation: ${remediation}`,
    );
    // Best-effort — this call itself needs the DB the condition is ABOUT, so it can fail for the
    // same reason; see escalateToHuman's doc comment. It retries every throttle window, so a
    // brief recovery blip (observed live) is enough for one attempt to land.
    void escalateToHuman('mcp-data-plane-dead', summary, remediation).catch(() => {});
  }
}

/**
 * Session-plane poll — the detector /api/health cannot be (EI-19299524366372518).
 * Runs alongside the reachability poll rather than replacing it: that one still covers
 * the EI-9237 frozen-event-loop class, and dropping it would trade one blind spot for
 * another.
 */
async function pollHandshake() {
  let { kind, detail } = await probeMcp(PORT);

  // 'empty' is ambiguous, never a verdict — confirm against the unfiltered catalog
  // before believing it (trap 2: a renamed PROBE_TOOL looks exactly like a dead registry).
  if (kind === 'empty') {
    const confirm = await probeMcp(PORT, { full: true });
    if (confirm.kind === 'ok') {
      log(`PROBE CONFIG: filter tool "${PROBE_TOOL}" matched nothing but the catalog is healthy (${confirm.detail}) — set PAPERCUSP_MCP_PROXY_WATCHDOG_PROBE_TOOL to a live tool name. NOT a service fault.`);
      kind = 'ok';
    } else {
      ({ kind, detail } = confirm);
      if (kind === 'empty') kind = 'dead'; // confirmed empty registry on a real client path
    }
  }

  if (kind === 'ok') {
    if (handshakeFailingSince) {
      log(`session plane recovered (was failing ${Math.round((Date.now() - handshakeFailingSince) / 1000)}s)`);
      handshakeFailingSince = 0;
    }
    // Session plane green is exactly when the WI-6739 class hides. Check the data plane.
    await pollDataPlane();
    return;
  }

  if (kind === 'auth') {
    const now = Date.now();
    if (now - lastAuthLog > LOG_THROTTLE_MS) {
      lastAuthLog = now;
      log(`PROBE CONFIG: session probe cannot authenticate (${detail}) — this watchdog is BLIND until fixed, but that is OUR credential, not a service fault, so nothing will be restarted.`);
    }
    return; // never let our own bad credential restart a healthy service
  }

  const now = Date.now();
  if (!handshakeFailingSince) {
    handshakeFailingSince = now;
    log(`session plane FAILING (${detail}) — /api/health may still be green; that is the point of this probe`);
    return;
  }
  if (!shouldRestart(handshakeFailingSince, now, HANDSHAKE_UNHEALTHY_MS)) return;

  const secs = Math.round((now - handshakeFailingSince) / 1000);
  const upstream = await probeMcp(UPSTREAM_PORT);
  const action = decideHandshakeAction(kind, upstream.kind);

  if (action === 'restart-proxy') {
    // WI-39378 — RE-CONFIRM BEFORE RESTARTING. Everything above was decided from a probe
    // taken before the `await probeMcp(UPSTREAM_PORT)` on the line above, which is a real
    // network round-trip and can burn a full HANDSHAKE_TIMEOUT_MS when upstream is the
    // thing that is sick. Restarting the proxy is destructive to third parties: it kills
    // every agent's in-flight MCP call ("transport dropped mid-call; response was lost").
    // Acting on a stale verdict is therefore not a cosmetic race. Observed live
    // 2026-08-16T03:54:37Z, verbatim from this log, 0.6s apart:
    //     03:54:37.232Z session plane recovered (was failing 156s)
    //     03:54:37.826Z WEDGED -> restarting papercup-mcp-proxy: session plane dead 150s
    // i.e. it restarted the proxy immediately after observing that the plane was healthy.
    // A recovery must CANCEL a pending restart, never race it.
    if (decideRestartAfterRecheck(handshakeFailingSince, null) === 'stand-down-recovered') {
      log(`STAND DOWN: session plane recovered while we were probing upstream :${UPSTREAM_PORT} — not restarting ${UNIT}`);
      return;
    }
    const recheck = await probeMcp(PORT);
    if (decideRestartAfterRecheck(handshakeFailingSince, recheck.kind) !== 'restart') {
      log(
        `STAND DOWN: session plane answered on re-check (${recheck.detail}) after ${secs}s failing — not restarting ${UNIT}. ` +
          `A restart here would have killed every in-flight MCP call for a plane that had already recovered (WI-39378).`,
      );
      handshakeFailingSince = 0;
      return;
    }
    restart(
      `session plane dead ${secs}s through :${PORT} (re-confirmed: ${recheck.detail}) while upstream :${UPSTREAM_PORT} serves tools — proxy is the culprit (${detail})`,
    );
    handshakeFailingSince = 0;
    return;
  }

  // Upstream is the culprit. Restarting the proxy cannot fix it and would burn a
  // circuit-breaker slot while the log blamed the wrong service — so we do not.
  if (now - lastUpstreamLog > LOG_THROTTLE_MS) {
    lastUpstreamLog = now;
    const summary = `MCP session plane dead ${secs}s and the UPSTREAM operator :${UPSTREAM_PORT} is the culprit (proxy: ${detail}; upstream: ${upstream.detail})`;
    const remediation = `restart the operator host serving :${UPSTREAM_PORT}. Restarting ${UNIT} would NOT fix this.`;
    log(
      `CRITICAL: ${summary}. Restarting ${UNIT} would NOT fix this and is being withheld. This is the 2026-08-01 signature (WI-6739): /api/health stays 200/2ms while every client is dark. ` +
        `Remediation: ${remediation}`,
    );
    void escalateToHuman('mcp-session-plane-dead-upstream', summary, remediation).catch(() => {});
  }
}

function start() {
  log(
    `up — port ${PORT}, poll ${POLL_MS}ms, unreachable-threshold ${UNREACHABLE_MS}ms, debounce ${DEBOUNCE_MS}ms, cap ${MAX_RESTARTS_PER_HR}/hr, unit ${UNIT}; durable log ${LOG_FILE}`,
  );
  log(
    `session-plane probe — tools/list via :${PORT} every ${POLL_MS}ms (filter "${PROBE_TOOL}", timeout ${HANDSHAKE_TIMEOUT_MS}ms), unhealthy after ${HANDSHAKE_UNHEALTHY_MS}ms, upstream :${UPSTREAM_PORT}`,
  );
  const probeArgs = dataPlaneProbeArgs(DB_PROBE_TOOL, DB_PROBE_ARGS_RAW);
  log(
    `data-plane probe (WI-6739) — tools/call "${DB_PROBE_TOOL}" args ${JSON.stringify(probeArgs.args)} via :${PORT}, runs whenever the session plane is green, unhealthy after ${HANDSHAKE_UNHEALTHY_MS}ms; catches a DB-dead operator that still serves its tool catalog`,
  );
  log(
    `pgbouncer pool sampler (EI-19384024494946006) — SHOW POOLS/SHOW STATS captured on every ` +
      `reachability/data-plane FAILING onset (debounced ${POOL_SAMPLE_MIN_INTERVAL_MS}ms), logged to ${POOL_SAMPLE_LOG_FILE}`,
  );
  log(
    `human escalation (EI-19415174699106397) — every CRITICAL verdict also fires coord:escalate ` +
      `(conditionKey-coalesced, best-effort, retried each throttle window) so a sustained outage ` +
      `pages a human instead of only appending to this log file`,
  );
  log(
    `committed mcp-proxy hot-path activation (EI-22647232817982385) — checks every ${HOT_PATH_ACTIVATION_CHECK_MS}ms; ` +
      `requires a newer committed clean runtime tree and uses coordinated dev:restart with a ${HOT_PATH_RESTART_DRAIN_SEC}s call drain`,
  );
  if (probeArgs.invalid) {
    // Loud at startup rather than once per 10min throttle window: every poll from here on is a
    // guaranteed 'config' verdict, i.e. this watchdog is BLIND to the WI-6739 class right now.
    log(
      `PROBE CONFIG: PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_ARGS is not a JSON object — probing "${DB_PROBE_TOOL}" with NO arguments instead of guessing. Fix it or unset it.`,
    );
  }
  setInterval(
    () => void poll().catch((e) => log(`poll error: ${e.message}`)),
    POLL_MS,
  );
  // WI-39378 — pollHandshake must not overlap itself. One pass can spend up to three
  // HANDSHAKE_TIMEOUT_MS probes (session, confirm-full, upstream) against a POLL_MS of
  // 15s, so overlapping runs were routine, not exotic. Overlap is how one run observed
  // recovery and zeroed handshakeFailingSince while another was already past its own
  // decision point and went on to restart the proxy anyway. Every probe is bounded by an
  // AbortController, so a plain in-flight flag cannot wedge this poller permanently.
  let handshakePollInFlight = false;
  setInterval(() => {
    if (handshakePollInFlight) {
      log(`skip: previous session-plane poll still in flight after ${POLL_MS}ms`);
      return;
    }
    handshakePollInFlight = true;
    void pollHandshake()
      .catch((e) => log(`handshake poll error: ${e.message}`))
      .finally(() => {
        handshakePollInFlight = false;
      });
  }, SESSION_PLANE_POLL_MS);
}

// Auto-start when run as the systemd unit (`node watchdog.mjs`). Tests set
// PAPERCUSP_WATCHDOG_NO_AUTOSTART=1 before importing so they can exercise the pure decision
// logic (shouldRestart) without launching setInterval / hitting the network.
if (process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART !== '1') start();
