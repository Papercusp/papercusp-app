#!/usr/bin/env node
/**
 * Inference-gateway WEDGE watchdog — inference-gateway-robustness-audit-2026-06-20 P0.
 *
 * A wedged gateway stays UP (process alive, port listening), so systemd Restart=always never fires; the
 * two 2026-06-20 wedges ran SILENTLY for 6-38 min until a human noticed. This polls /stats and auto-
 * restarts on the wedge signature, turning a multi-minute silent outage into ~one poll of auto-recovery.
 *
 * Wedge signature (must HOLD for FREEZE_MS): totalRequests NOT advancing AND queueDepth>0 AND
 * inFlight>=maxConcurrent — work is waiting but NOTHING drains. A normal throttle still advances
 * totalRequests (requests trickle through), so this never false-positives on a paced/paused pool. Also
 * restarts if /stats is unreachable for UNREACHABLE_MS (the HTTP listener itself died/hung).
 *
 * SAFE FOR UNATTENDED OPERATION: a restart debounce (DEBOUNCE_MS) + a circuit breaker
 * (MAX_RESTARTS_PER_HR per rolling hour, then it STOPS restarting and only logs) so a misfire can never
 * restart-loop the gateway overnight — worst case it gives up and waits for a human.
 *
 * Env (all optional): PAPERCUSP_GATEWAY_PORT, _WATCHDOG_POLL_MS, _WATCHDOG_FREEZE_MS,
 *   _WATCHDOG_UNREACHABLE_MS, _WATCHDOG_DEBOUNCE_MS, _WATCHDOG_MAX_RESTARTS_HR, _WATCHDOG_UNIT.
 */
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_SCHEDULES } from '../schedule-descriptors.mjs';

const PORT = Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788;
const POLL_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_POLL_MS) || EXTERNAL_SCHEDULES.gatewayWatchdogPoll.defaultIntervalMs;
const FREEZE_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_FREEZE_MS) || 120_000;
const UNREACHABLE_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_UNREACHABLE_MS) || 60_000;
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_MAX_RESTARTS_HR) || 4;
const UNIT = process.env.PAPERCUSP_GATEWAY_WATCHDOG_UNIT || 'papercup-inference-gateway';
/** deploys:vintage self-report sink (fleet-reliability-verification-2026-07-10 P-008): this
 *  watchdog itself is a "runtime" whose vintage matters (an old watchdog script silently
 *  auto-restarting the gateway with stale wedge-detection logic is exactly the kind of thing
 *  "is the fix actually running there" should answer). Best-effort fire-and-forget POST — a
 *  dependency-free script can't import runtime-vintage.ts directly, so it hits the HTTP sink
 *  instead (never blocks/affects the poll loop on failure). Default target is :3070 (the
 *  always-up release operator, per the two-port model) — override for a non-default topology. */
const VINTAGE_URL = process.env.PAPERCUSP_RUNTIME_VINTAGE_URL || 'http://127.0.0.1:3070/api/internal/runtime-vintage';
/** Durable, journald-INDEPENDENT decision log. The systemd journal's stdout-socket capture
 *  (/run/systemd/journal/stdout) was observed wedged host-wide (2026-06-22, EI-2421): the watchdog's
 *  console.log restart decisions were invisible in journald for 44h, which is exactly why "is the
 *  watchdog the thing restarting the gateway?" was undiagnosable for days. So we ALSO append every
 *  restart / suppress / circuit-open decision to this file (synchronous append, visible to readers
 *  immediately). A standalone supervisor that runs precisely WHEN the operator/PG may be down is the
 *  canonical "must be a file, not Postgres" case (storage-policy). Env-tunable. */
const LOG_FILE = process.env.PAPERCUSP_GATEWAY_WATCHDOG_LOG || join(homedir(), '.papercusp', 'gateway-watchdog.log');
// Proactive DEAD-PROXY alert thresholds (EI-2537). Always-on observability (a durable log line; NEVER affects
// the restart decision), env-tunable like every other watchdog knob. A proxy is "dead" when its volume-fair
// egressFailRateByAccount crosses DEADPROXY_RATE over at least DEADPROXY_MIN_ATTEMPTS attempts (the floor
// filters small-sample noise); re-alerted at most every DEADPROXY_REALERT_MS per account (anti-spam debounce).
const DEADPROXY_MIN_ATTEMPTS = Number(process.env.PAPERCUSP_GATEWAY_DEADPROXY_MIN_ATTEMPTS) || 20;
const DEADPROXY_RATE = Number(process.env.PAPERCUSP_GATEWAY_DEADPROXY_RATE) || 0.5;
const DEADPROXY_REALERT_MS = Number(process.env.PAPERCUSP_GATEWAY_DEADPROXY_REALERT_MS) || 10 * 60_000;

let lastTotal = -1;
let frozenSince = 0;
let frozenSelfHeal = -1; // selfHealReclaims captured when the current freeze started — detects the in-process valve draining it
let unreachableSince = 0;
let lastRestart = 0;
const restartTimes = []; // epoch ms of recent restarts (rolling 1h window for the circuit breaker)
const deadProxyLastAlert = new Map(); // accountId -> epoch ms last DEAD-PROXY alert (per-account anti-spam debounce)
let egressPoolDownLastAlert = 0; // epoch ms of the last EGRESS-POOL-DOWN alert (same debounce window)
let egressPoolWasDown = false; // edge-trigger latch, so a standing outage logs once rather than every poll

let logDirEnsured = false;
const log = (m) => {
  const line = `[gw-watchdog ${new Date().toISOString()}] ${m}`;
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

function restart(reason) {
  const now = Date.now();
  if (now - lastRestart < DEBOUNCE_MS) {
    log(`SUPPRESS (debounce ${Math.round((DEBOUNCE_MS - (now - lastRestart)) / 1000)}s left): ${reason}`);
    return;
  }
  while (restartTimes.length && now - restartTimes[0] > 3_600_000) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_PER_HR) {
    log(`CIRCUIT OPEN: ${restartTimes.length} restarts in the last hour >= cap ${MAX_RESTARTS_PER_HR} — NOT restarting (${reason}). Manual attention needed.`);
    return;
  }
  lastRestart = now;
  restartTimes.push(now);
  log(`WEDGE -> restarting ${UNIT}: ${reason}`);
  execFile('systemctl', ['--user', 'restart', UNIT], (err) =>
    log(err ? `restart FAILED: ${err.message}` : 'restart issued OK'),
  );
  // reset detection state so a fresh boot gets a clean baseline
  lastTotal = -1;
  frozenSince = 0;
  frozenSelfHeal = -1;
  unreachableSince = 0;
}

/** Distinguish an INTERNAL wedge (a true deadlock/leak a restart fixes) from an EXTERNAL stall a
 *  restart can NOT fix and would only worsen by dropping every in-flight bee/queen spawn (EI-2421).
 *  The frozen-while-saturated signature ALSO fires when the whole account pool is rate-limit exhausted
 *  (every account paused / circuit-open → nothing trickles → totalRequests genuinely frozen), or while
 *  the gateway's own in-process self-heal valve (gateway.ts SELFHEAL_FREEZE_MS, < this 120s freeze) is
 *  already reclaiming the wedge. In those cases a restart is pure harm. Returns a reason string when the
 *  stall is external/self-healing (→ SUPPRESS the restart), else null (→ a real wedge, restart). */
export function externalStallReason(s, selfHealAtFreezeStart) {
  const now = Date.now();
  const pausedUntil = Number(s?.pausedUntil) || 0;
  const selfHeal = Number(s?.selfHealReclaims) || 0;
  const unified = s?.unified || {};
  if (pausedUntil > now) return `active account governor-paused ${Math.round((pausedUntil - now) / 1000)}s — rate-limit, not a wedge`;
  if (unified.rejected === true) return `unified budget window exhausted (rejected) — rate-limit, not a wedge`;
  if (selfHealAtFreezeStart >= 0 && selfHeal > selfHealAtFreezeStart)
    return `in-process self-heal valve already reclaiming (${selfHealAtFreezeStart}->${selfHeal}) — let it drain`;
  return null;
}

/** Rank egress proxies that are chronically failing (EI-2537): an account whose volume-fair
 *  egressFailRateByAccount (= egressFailsByAccount / egressAttemptsByAccount, computed gateway-side) is
 *  >= rateThreshold over >= minAttempts attempts. The min-attempts floor filters small-sample noise (a 1/1
 *  blip reads 100% but is not a dead proxy). Returns the offenders worst-first. Pure (no I/O) so a unit
 *  test can drive it with synthetic /stats; the poll loop logs the result + debounces per account. The
 *  RATE is the source-of-truth signal because a raw fail count ranks the BUSIEST proxy worst, not the
 *  deadest (the 2026-06-22 audit: ownerhandle had the most raw fails only because it carried the most traffic;
 *  definitelyahuman was the true dead proxy at ~95% rate). */
export function deadProxyAlerts(stats, { minAttempts = DEADPROXY_MIN_ATTEMPTS, rateThreshold = DEADPROXY_RATE } = {}) {
  const rate = (stats && stats.egressFailRateByAccount) || {};
  const attempts = (stats && stats.egressAttemptsByAccount) || {};
  const fails = (stats && stats.egressFailsByAccount) || {};
  const out = [];
  for (const [id, r] of Object.entries(rate)) {
    const a = Number(attempts[id]) || 0;
    if (a >= minAttempts && Number(r) >= rateThreshold) {
      out.push({ accountId: id, rate: Number(r), attempts: a, fails: Number(fails[id]) || 0 });
    }
  }
  return out.sort((x, y) => y.rate - x.rate);
}

/** Pool-wide EGRESS-DOWN alert (EI-18664933641195210) — the entry-level signal `deadProxyAlerts` above
 *  structurally cannot see. That one keys on the PER-ACCOUNT fail rate, but an account whose pool is
 *  [deadProxy, {}] ROTATES onto box-direct and the request then SUCCEEDS, so its account-level rate stays
 *  far below the 50% floor while its proxy is 100% dead. That is why a 16-day, three-proxy outage produced
 *  zero DEAD-PROXY lines: rotation masked it at exactly the granularity this detector reads.
 *
 *  `egressProxyHealth.allDown` is computed per ENTRY off the same cooldown map routing uses, and (since
 *  EI-18664933641195210) no longer self-clears when a cooldown merely EXPIRES — so it stays true for as
 *  long as the outage lasts instead of flapping. `configured:false` means there is no proxy path to judge
 *  at all and must NOT alert (EI-19962845612125031). Pure (no I/O) so a unit test can drive it. */
export function egressPoolDownAlert(stats) {
  const h = stats && stats.egressProxyHealth;
  if (!h || !h.configured || !h.allDown) return null;
  return { totalProxyEntries: Number(h.totalProxyEntries) || 0, reachableProxyEntries: Number(h.reachableProxyEntries) || 0 };
}

async function poll() {
  let s;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const r = await fetch(`http://127.0.0.1:${PORT}/stats`, { signal: ctrl.signal });
    clearTimeout(t);
    s = await r.json();
    unreachableSince = 0;
  } catch (e) {
    const now = Date.now();
    if (!unreachableSince) {
      unreachableSince = now;
      log(`/stats unreachable (${e.message})`);
    } else if (now - unreachableSince >= UNREACHABLE_MS) {
      restart(`/stats unreachable ${Math.round((now - unreachableSince) / 1000)}s`);
    }
    return;
  }
  const now = Date.now();
  const total = Number(s.totalRequests) || 0;
  const queued = Number(s.queueDepth) || 0;
  const inFlight = Number(s.inFlight) || 0;
  const maxConc = Number(s?.admission?.maxConcurrent ?? 0) || 0;
  const stuck = total === lastTotal && queued > 0 && maxConc > 0 && inFlight >= maxConc;
  if (stuck) {
    if (!frozenSince) {
      frozenSince = now;
      frozenSelfHeal = Number(s.selfHealReclaims) || 0;
      log(`freeze candidate: total=${total} queued=${queued} inFlight=${inFlight}/${maxConc} selfHeal=${frozenSelfHeal}`);
    } else if (now - frozenSince >= FREEZE_MS) {
      const ext = externalStallReason(s, frozenSelfHeal);
      if (ext) {
        // Not a wedge — a rate-limit/self-heal stall a restart can't fix. Re-baseline (don't restart-spam)
        // and keep watching: if it becomes a TRUE internal wedge (external signal clears but still frozen),
        // a later poll will see ext===null and restart.
        log(`SUPPRESS restart — stall is EXTERNAL/self-healing: ${ext}. A restart would only drop in-flight spawns. total=${total} ${inFlight}/${maxConc}`);
        frozenSince = now;
        frozenSelfHeal = Number(s.selfHealReclaims) || 0;
      } else {
        restart(`totalRequests frozen @${total}, ${queued} queued, ${inFlight}/${maxConc} in-flight for ${Math.round((now - frozenSince) / 1000)}s`);
      }
    }
  } else {
    if (frozenSince) log(`freeze cleared (total ${lastTotal}->${total})`);
    frozenSince = 0;
    frozenSelfHeal = -1;
  }
  lastTotal = total;

  // Proactive DEAD-PROXY alert (EI-2537) — INDEPENDENT of the wedge logic above. Name a chronically-failing
  // egress proxy in the durable log the instant its volume-fair rate crosses the threshold, so the worst
  // Rayobyte proxy is caught at poll granularity + session-independently, instead of waiting for a human to
  // read /stats. Pure logging; fully isolated in try/catch so a malformed /stats can never disturb the
  // restart path. Debounced per account so a sustained dead proxy logs at most once per DEADPROXY_REALERT_MS.
  try {
    for (const dp of deadProxyAlerts(s)) {
      const last = deadProxyLastAlert.get(dp.accountId) || 0;
      if (now - last >= DEADPROXY_REALERT_MS) {
        deadProxyLastAlert.set(dp.accountId, now);
        log(
          `DEAD-PROXY: '${dp.accountId}' egress failing ${Math.round(dp.rate * 100)}% (${dp.fails}/${dp.attempts} attempts) >= ${Math.round(DEADPROXY_RATE * 100)}% threshold — fix or pull its egress proxy (it is the dominant share of the bee-facing "api error" leak).`,
        );
      }
    }
  } catch (e) {
    log(`dead-proxy check error (non-fatal): ${e.message}`);
  }

  // Pool-wide EGRESS-DOWN alert (EI-18664933641195210). Same always-on-observability contract as the
  // per-account check above: durable log only, never touches the restart path, isolated in try/catch,
  // and debounced on the same REALERT window. Edge-logged — it fires on the transition INTO the outage
  // and on recovery, so a standing outage does not re-spam the durable log.
  try {
    const down = egressPoolDownAlert(s);
    if (down && now - egressPoolDownLastAlert >= DEADPROXY_REALERT_MS) {
      egressPoolDownLastAlert = now;
      egressPoolWasDown = true;
      log(
        `EGRESS-POOL-DOWN: all ${down.totalProxyEntries} proxy egress entries are unreachable — every proxy-egress account has failed over to the box's bare IP. Rotation HIDES this from the per-account DEAD-PROXY check (the request still succeeds via box-direct), so this is the only signal that fires. Restore/replace the egress proxies.`,
      );
    } else if (!down && egressPoolWasDown) {
      egressPoolWasDown = false;
      egressPoolDownLastAlert = 0; // a real recovery re-arms the alert immediately
      log('EGRESS-POOL-RECOVERED: at least one proxy egress entry is reachable again (proven by a real transport success).');
    }
  } catch (e) {
    log(`egress-pool-down check error (non-fatal): ${e.message}`);
  }
}

/** Mirrors build-info.ts's resolveBuildInfo() sha resolution — env override, else a one-time
 *  `git rev-parse --short HEAD` in this script's own directory (works from any subdir of a
 *  checkout; resolves null in a packaged bundle with neither env nor a .git dir, same contract
 *  as the TS resolver). */
function resolveTreeSha() {
  const envSha = process.env.PAPERCUSP_BUILD_SHA?.trim();
  if (envSha) return envSha;
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort boot self-report into the deploys:vintage ledger (P-008). Never throws, never
 *  blocks the poll loop — a failed report just means this watchdog's row stays stale until its
 *  next successful boot. */
async function reportVintage(unit) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3_000);
    await fetch(VINTAGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        unit,
        host: hostname(),
        treeSha: resolveTreeSha(),
        buildTime: new Date().toISOString(),
        pid: process.pid,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    log(`[runtime-vintage] boot self-report failed (non-fatal): ${e.message}`);
  }
}

function start() {
  log(
    `up — port ${PORT}, poll ${POLL_MS}ms, freeze ${FREEZE_MS}ms, debounce ${DEBOUNCE_MS}ms, cap ${MAX_RESTARTS_PER_HR}/hr, unit ${UNIT}; suppress-restart-on-external-stall ON; dead-proxy alert >=${Math.round(DEADPROXY_RATE * 100)}% over >=${DEADPROXY_MIN_ATTEMPTS} attempts; durable log ${LOG_FILE}`,
  );
  void reportVintage('inference-gateway-watchdog');
  setInterval(
    () => void poll().catch((e) => log(`poll error: ${e.message}`)),
    POLL_MS,
  );
}

// Auto-start when run as the systemd unit (`node watchdog.mjs`). Tests set PAPERCUSP_WATCHDOG_NO_AUTOSTART=1
// before importing so they can exercise the pure decision logic (externalStallReason) without the poll loop.
if (process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART !== '1') start();
