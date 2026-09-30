/**
 * host-code-staleness-from-ledger — which operator hosts are serving live calls with
 * stale code, judged from the LEDGER rather than from inside each host (WI-1565914).
 *
 * ── Why this exists beside stale-routine-executor-watchdog, not inside it ────────────
 * That watchdog is an IN-PROCESS SELF-CHECK. One line into its sweep:
 *
 *     if (!routinesEnabledHere()) return { outcome: 'skipped', reason: '…not enabled…' };
 *
 * so a process only ever judges ITSELF, and only if it carries PAPERCUSP_DBOS_ROUTINES=1.
 * Measured 2026-08-31: every one of the six :3070 listeners has that variable UNSET, so
 * the host actually serving agent MCP calls has never once evaluated its own staleness.
 * Meanwhile :3271 reported "RECOVERED — running current code again" 106 times across the
 * exact window in which ≥17.5-day-stale hosts were serving live calls. Both statements
 * were true; together they read as an all-clear over a population of one.
 *
 * Two properties make the self-check structurally unable to close this, no matter how its
 * identity is computed:
 *   1. It cannot cover a process that does not run it.
 *   2. A process stale enough to matter may PREDATE the check's own code, so it cannot
 *      contain the instrument that would report it — the detector is weakest exactly
 *      where it is needed most.
 *
 * Judging from the ledger inverts both: `harness_shared.tool_invocations` now carries the
 * serving host's identity and loaded sha (migration 1043), so a host is measured by the
 * calls it ACTUALLY SERVED, needing no cooperation from it — and a host too old to report
 * is not silently absent, it is a counted silent host (see below).
 *
 * ── The rule this module exists to enforce ──────────────────────────────────────────
 * Every verdict carries its POPULATION, and a "nothing is stale" answer is UNUTTERABLE
 * from an empty one. This is not defensive garnish: it is the failure being fixed,
 * reappearing one level up. Until each host restarts onto migration-1043 code its
 * `serving_build_sha` is NULL, so a naive scan finds no stale sha and returns a
 * confident all-clear that actually means NOBODY IS REPORTING YET — the same shape as
 * the "RECOVERED" pages that masked the original bug.
 *
 * So `conclusive:false` is a real, expected verdict, not an error, and a caller may not
 * read it as health. Hosts seen WITHOUT a sha are counted as `hostsSilent` and named, so
 * the unmeasured remainder is always visible next to whatever was measured.
 *
 * Pure decider + a thin collector, mirroring evaluateExecutorStaleness/…Sweep next door.
 */

import { claimWatchdogFire, recentWatchdogFires, scopedFireReason } from '../../pot/watchdog';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { resolveCurrentHeadCommit } from '../../dbos/process-boot-identity';

/** One host's footprint in the ledger window. */
export interface LedgerHostObservation {
  servingHost: string;
  servingProcessId: string | null;
  /** The code that host loaded. NULL = it has not reported one (pre-1043, or unprovable). */
  servingBuildSha: string | null;
  calls: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

/** What the verdict was computed OVER. Reported unconditionally. */
export interface HostPopulation {
  /** Distinct serving_host values in the window. */
  hostsSeen: number;
  /** Those reporting a build sha — the only ones staleness could be judged for. */
  hostsReporting: number;
  /** Seen but reporting no sha: present, serving calls, and UNMEASURABLE. */
  hostsSilent: number;
  /** Names of the silent hosts, so the gap is addressable and not just a count. */
  silentHosts: string[];
  /** Calls whose serving host is not recorded at all (rows predating migration 1043). */
  callsUnattributed: number;
  callsAttributed: number;
}

export interface StaleHost {
  servingHost: string;
  servingProcessId: string | null;
  buildSha: string;
  /** ABSOLUTE age of the loaded code — now minus that commit's time. The measure the
   *  self-check could not produce: it reported hours-since-boot, which tops out at a few
   *  hours and can never surface an 18-day-old binary. */
  codeAgeMs: number | null;
  calls: number;
  lastSeenMs: number;
}

export interface LedgerStalenessVerdict {
  /**
   * Whether a stale/not-stale answer is even utterable. FALSE means the instrument
   * measured nothing — never that everything is healthy.
   */
  conclusive: boolean;
  reason: string;
  population: HostPopulation;
  /** Always empty when `conclusive` is false. */
  stale: StaleHost[];
}

export interface EvaluateLedgerStalenessInput {
  observations: LedgerHostObservation[];
  /** Current tree HEAD. Null ⇒ nothing to compare against; the verdict is inconclusive. */
  headSha: string | null;
  /** Commit time of a build sha, for ABSOLUTE age. Null when unresolvable. */
  commitTimeMs: (sha: string) => number | null;
  now: number;
  /** How old the LOADED CODE may be before a host is called stale. */
  maxCodeAgeMs: number;
  /** Rows in the window carrying no serving_host at all. */
  callsUnattributed?: number;
}

/** Two shas match if either is a prefix of the other (short vs full sha). */
function shaMatches(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

function buildPopulation(input: EvaluateLedgerStalenessInput): HostPopulation {
  const byHost = new Map<string, LedgerHostObservation[]>();
  for (const o of input.observations) {
    const list = byHost.get(o.servingHost);
    if (list) list.push(o);
    else byHost.set(o.servingHost, [o]);
  }
  const silentHosts: string[] = [];
  let hostsReporting = 0;
  for (const [host, rows] of byHost) {
    if (rows.some((r) => !!r.servingBuildSha)) hostsReporting++;
    else silentHosts.push(host);
  }
  return {
    hostsSeen: byHost.size,
    hostsReporting,
    hostsSilent: silentHosts.length,
    silentHosts: silentHosts.sort(),
    callsUnattributed: input.callsUnattributed ?? 0,
    callsAttributed: input.observations.reduce((n, o) => n + o.calls, 0),
  };
}

/** How the unmeasured remainder is appended to every conclusive reason — the sentence
 *  that keeps a partial measurement from reading as a total one. */
function remainderSuffix(pop: HostPopulation): string {
  const parts: string[] = [];
  if (pop.hostsSilent > 0) {
    parts.push(
      `${pop.hostsSilent} host(s) served calls WITHOUT reporting a build sha and could not be judged ` +
        `(${pop.silentHosts.join(', ')})`,
    );
  }
  if (pop.callsUnattributed > 0) {
    parts.push(`${pop.callsUnattributed} call(s) in the window carry no serving host at all`);
  }
  return parts.length ? ` NOT MEASURED: ${parts.join('; ')}.` : '';
}

/**
 * Pure decider. Never returns "nothing is stale" without a non-empty reporting
 * population, and never states a measured result without naming what it could not see.
 */
export function evaluateLedgerHostStaleness(input: EvaluateLedgerStalenessInput): LedgerStalenessVerdict {
  const population = buildPopulation(input);

  if (population.hostsSeen === 0) {
    return {
      conclusive: false,
      reason:
        'MEASURED NOTHING: no host reported serving any call in this window. That is a statement about ' +
        'the instrument, not about host health — do not read it as an all-clear.',
      population,
      stale: [],
    };
  }

  if (!input.headSha) {
    return {
      conclusive: false,
      reason:
        `MEASURED NOTHING: tree HEAD could not be resolved, so no loaded sha could be compared against it ` +
        `(${population.hostsReporting} of ${population.hostsSeen} host(s) were reporting a sha).`,
      population,
      stale: [],
    };
  }

  if (population.hostsReporting === 0) {
    return {
      conclusive: false,
      reason:
        `MEASURED NOTHING: ${population.hostsSeen} host(s) served calls but NONE reported a build sha, so ` +
        `staleness is unjudgeable for every one of them (${population.silentHosts.join(', ')}). Expected while ` +
        `hosts have not yet restarted onto migration-1043 code — a zero here means nobody is reporting, ` +
        `NOT that nothing is stale.`,
      population,
      stale: [],
    };
  }

  // Judge only the reporting subset, newest observation per host+sha.
  const stale: StaleHost[] = [];
  for (const o of input.observations) {
    const sha = o.servingBuildSha;
    if (!sha) continue;
    if (shaMatches(sha, input.headSha)) continue;
    const committedAt = input.commitTimeMs(sha);
    const codeAgeMs = committedAt === null ? null : Math.max(0, input.now - committedAt);
    // An unresolvable commit time must not silently pass as fresh: a sha that differs
    // from HEAD and whose age cannot be established is still reported, with a null age.
    if (codeAgeMs !== null && codeAgeMs < input.maxCodeAgeMs) continue;
    stale.push({
      servingHost: o.servingHost,
      servingProcessId: o.servingProcessId,
      buildSha: sha,
      codeAgeMs,
      calls: o.calls,
      lastSeenMs: o.lastSeenMs,
    });
  }
  stale.sort((a, b) => (b.codeAgeMs ?? Number.MAX_SAFE_INTEGER) - (a.codeAgeMs ?? Number.MAX_SAFE_INTEGER));

  const scope = `${population.hostsReporting} of ${population.hostsSeen} host(s) reporting a build sha`;
  if (stale.length === 0) {
    // A NO-STALE answer is a UNIVERSAL claim over the serving population, so it is only
    // utterable from a REPRESENTATIVE one. The three guards above catch absolute zero
    // (no hosts seen, no HEAD, nobody reporting a sha) — but the case that actually
    // occurs here is near-zero, not zero: a handful of attributed calls beside a window
    // dominated by hosts too old to stamp ANY identity, whose rows carry no serving_host
    // and so can never raise hostsSilent above 0.
    //
    // Measured 2026-08-31T09:00Z (WI-1401990): 4 attributed vs 1,686 unattributed calls
    // returned `conclusive: true, stale: []` — a confident all-clear — while :3270 was
    // live 152 commits behind HEAD with populated routineDrift, and the six :3070 pids
    // serving the bulk of that window had booted BEFORE the identity writer existed.
    // That is this module's own stated failure mode ("a confident all-clear that actually
    // means NOBODY IS REPORTING YET") reappearing one level up, because `remainderSuffix`
    // only ever mentioned the remainder in PROSE while `conclusive: true` told every
    // machine reader to trust it.
    //
    // The asymmetry is deliberate: a POSITIVE finding below stays conclusive at any
    // coverage, because "this host is stale" is an EXISTENCE claim that a small sample
    // can establish and a large unmeasured remainder cannot falsify.
    const windowCalls = population.callsAttributed + population.callsUnattributed;
    const coverage = windowCalls === 0 ? 0 : population.callsAttributed / windowCalls;
    const floor = ledgerAttributionFloor();
    if (floor > 0 && coverage < floor) {
      return {
        conclusive: false,
        reason:
          `MEASURED TOO LITTLE: no stale host among ${scope}, but only ` +
          `${population.callsAttributed} of ${windowCalls} call(s) in the window carry a serving ` +
          `host at all (${(coverage * 100).toFixed(1)}%, floor ${(floor * 100).toFixed(0)}%). An ` +
          `all-clear over that remainder would be a statement about the instrument, not about ` +
          `host health — do not read it as health.${remainderSuffix(population)}`,
        population,
        stale,
      };
    }
    return {
      conclusive: true,
      reason: `No stale host among ${scope}.${remainderSuffix(population)}`,
      population,
      stale,
    };
  }

  const worst = stale[0]!;
  const age =
    worst.codeAgeMs === null ? 'an unresolvable age' : `${(worst.codeAgeMs / 86_400_000).toFixed(1)} days old`;
  return {
    conclusive: true,
    reason:
      `${stale.length} of ${scope} are serving live calls with stale code. Worst: ${worst.servingHost} ` +
      `running ${worst.buildSha.slice(0, 10)}, code ${age}, ${worst.calls} call(s) in window. ` +
      `Restart that host to pick up current code.${remainderSuffix(population)}`,
    population,
    stale,
  };
}

// ── tunables (env-overridable, like every sibling watchdog) ───────────────────────────

/** Minimum share of a window's calls that must carry a serving host before a NO-STALE
 *  answer may be called conclusive. Default 0.5: an all-clear should rest on at least
 *  half the traffic actually being measured. Only ever downgrades an all-clear — a
 *  positive stale finding is conclusive at any coverage. `<=0` disables the floor
 *  (kill switch), restoring the pre-fix behaviour of trusting any non-empty sample. */
export function ledgerAttributionFloor(): number {
  const n = Number(process.env.PAPERCUSP_LEDGER_ATTRIBUTION_FLOOR ?? 0.5);
  return Number.isFinite(n) ? n : 0.5;
}

/** How old a host's LOADED CODE may be before it is called stale. Default 3 days — far
 *  above any normal restart cadence here, and far below the 17.5-day case that went
 *  unnoticed. `<=0` disables the sweep (kill switch). */
export function ledgerStaleCodeMaxAgeSec(): number {
  const n = Number(process.env.PAPERCUSP_LEDGER_HOST_STALE_CODE_MAX_AGE_SEC ?? 259_200);
  return Number.isFinite(n) ? n : 259_200;
}

/** Ledger window the population is drawn from. Default 15 min: long enough that a
 *  low-traffic host still appears, short enough that a host which has since restarted is
 *  not reported on the strength of calls it served before rebooting. */
export function ledgerHostWindowSec(): number {
  const n = Number(process.env.PAPERCUSP_LEDGER_HOST_WINDOW_SEC ?? 900);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

// A commit's timestamp is immutable, so this memo never needs invalidating — which is
// what makes resolving absolute code age affordable on every tick.
const commitTimeCache = new Map<string, number | null>();

/** Commit time of a sha, in ms. Null when unresolvable (pruned object, shallow clone,
 *  non-checkout host) — never a guess, because a fabricated age is worse than none. */
export async function resolveCommitTimeMs(sha: string): Promise<number | null> {
  const key = sha.trim().toLowerCase();
  if (!key) return null;
  const hit = commitTimeCache.get(key);
  if (hit !== undefined) return hit;
  let value: number | null = null;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('git', ['show', '-s', '--format=%ct', key], { timeout: 5_000 });
    const secs = Number(stdout.trim());
    value = Number.isFinite(secs) && secs > 0 ? secs * 1_000 : null;
  } catch {
    value = null;
  }
  commitTimeCache.set(key, value);
  return value;
}

export function _resetCommitTimeCacheForTests(): void {
  commitTimeCache.clear();
}

export interface LedgerHostSnapshot {
  observations: LedgerHostObservation[];
  callsUnattributed: number;
}

/**
 * Read the window's per-host footprint straight from the ledger.
 *
 * `callsUnattributed` is collected deliberately alongside it: rows carrying no
 * serving_host are calls this instrument CANNOT see, and counting them is what keeps a
 * partial view from reading as a complete one.
 */
export async function collectLedgerHostObservations(opts: {
  workspaceId?: string;
  windowMs?: number;
  now?: number;
}): Promise<LedgerHostSnapshot> {
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const windowMs = opts.windowMs ?? ledgerHostWindowSec() * 1_000;
  const since = new Date((opts.now ?? Date.now()) - windowMs).toISOString();
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();

  const rows = (await sql`
    SELECT serving_host, serving_process_id, serving_build_sha,
           count(*)::bigint AS calls,
           min(invoked_at) AS first_seen,
           max(invoked_at) AS last_seen
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${workspaceId}
       AND invoked_at >= ${since}::timestamptz
       AND serving_host IS NOT NULL
     GROUP BY 1, 2, 3
  `) as Array<{
    serving_host: string;
    serving_process_id: string | null;
    serving_build_sha: string | null;
    calls: string | number;
    first_seen: Date | string;
    last_seen: Date | string;
  }>;

  const unattributed = (await sql`
    SELECT count(*)::bigint AS n
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${workspaceId}
       AND invoked_at >= ${since}::timestamptz
       AND serving_host IS NULL
  `) as Array<{ n: string | number }>;

  return {
    observations: rows.map((r) => ({
      servingHost: r.serving_host,
      servingProcessId: r.serving_process_id,
      servingBuildSha: r.serving_build_sha,
      calls: Number(r.calls),
      firstSeenMs: new Date(r.first_seen).getTime(),
      lastSeenMs: new Date(r.last_seen).getTime(),
    })),
    callsUnattributed: Number(unattributed[0]?.n ?? 0),
  };
}

export interface LedgerStalenessSweepResult {
  outcome: 'alerted' | 'healthy' | 'inconclusive' | 'skipped' | 'error';
  reason: string;
  verdict?: LedgerStalenessVerdict;
}

/**
 * The sweep. Unlike the in-process self-check next door, this places NO
 * `PAPERCUSP_DBOS_ROUTINES` condition on its SUBJECTS: it runs on whichever host executes
 * routines and reports about EVERY host, including ones that run no routines at all. That
 * inversion is the entire point — the host serving agent calls is exactly the one that
 * never self-reported.
 *
 * Paging fires ONLY on a conclusive verdict with stale hosts. An inconclusive verdict is
 * returned and traced but never paged: alerting on a measurement that measured nothing
 * trains readers to ignore the page, which is how the original all-clear kept its
 * credibility. Equally, it is never reported as `healthy`.
 */
// Throttled for the same reason the sibling watchdog throttles its git shell-outs: this
// runs on the 30s routinesTick, and its two ledger reads are index range scans over a
// 15-minute window of a table taking ~800K inserts/day. Host code cannot change without a
// restart, so re-asking 120×/hour buys nothing. Process-local, so a missed tick is never a
// missed alarm — only a later one.
const LEDGER_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
let lastLedgerSweepAtMs = 0;

export function _resetLedgerSweepThrottleForTests(): void {
  lastLedgerSweepAtMs = 0;
}

export async function hostCodeStalenessFromLedgerSweep(opts: {
  now?: number;
  workspaceId?: string;
  installSlug?: string;
  /** Bypass the tick throttle (probes, tests, an explicit on-demand read). */
  force?: boolean;
}): Promise<LedgerStalenessSweepResult> {
  const maxAgeSec = ledgerStaleCodeMaxAgeSec();
  if (maxAgeSec <= 0) return { outcome: 'skipped', reason: 'kill switch' };

  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastLedgerSweepAtMs < LEDGER_SWEEP_MIN_INTERVAL_MS) {
    return { outcome: 'skipped', reason: 'throttled' };
  }
  lastLedgerSweepAtMs = now;
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? operatorHomeHarnessSlug();

  try {
    const [snapshot, headSha] = await Promise.all([
      collectLedgerHostObservations({ workspaceId, now }),
      resolveCurrentHeadCommit(),
    ]);

    // Resolve commit times up front for the distinct shas actually present (a handful),
    // so the decider stays pure and synchronous — and therefore fully testable.
    const shas = [...new Set(snapshot.observations.map((o) => o.servingBuildSha).filter((s): s is string => !!s))];
    const times = new Map<string, number | null>();
    for (const sha of shas) times.set(sha, await resolveCommitTimeMs(sha));

    const verdict = evaluateLedgerHostStaleness({
      observations: snapshot.observations,
      callsUnattributed: snapshot.callsUnattributed,
      headSha,
      commitTimeMs: (sha) => times.get(sha) ?? null,
      now,
      maxCodeAgeMs: maxAgeSec * 1_000,
    });

    if (!verdict.conclusive) return { outcome: 'inconclusive', reason: verdict.reason, verdict };
    if (verdict.stale.length === 0) return { outcome: 'healthy', reason: verdict.reason, verdict };

    // Scope the debounce to the worst offender's host, so two stale hosts cannot
    // suppress each other's page.
    const identity = verdict.stale[0]!.servingHost;
    const windowHours = 6;
    const already = await recentWatchdogFires(workspaceId, installSlug, windowHours, 'stale-serving-host', identity);
    if (already > 0) return { outcome: 'skipped', reason: 'debounced', verdict };

    const claimed = await claimWatchdogFire({
      workspaceId,
      installSlug,
      source: 'stale-serving-host',
      reason: scopedFireReason(`stale serving host: ${verdict.reason}`, identity, 'stale-serving-host'),
      wakeAt: null,
      windowHours,
      scopeKey: identity,
    });
    if (!claimed) return { outcome: 'skipped', reason: 'debounced (raced or backed off)', verdict };
    return { outcome: 'alerted', reason: verdict.reason, verdict };
  } catch (e) {
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
