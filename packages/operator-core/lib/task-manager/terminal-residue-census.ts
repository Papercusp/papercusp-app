/**
 * terminal-residue-census — the LEADING indicator for dead-terminal-window residue
 * (process-lifecycle-no-orphans-2026-08-02, P-013 / D-017).
 *
 * ── WHY THIS DOES NOT REUSE `summary.unaccounted` ───────────────────────────
 *
 * The obvious implementation of P-013 is "trend the reconciler's unaccounted
 * count". That number is structurally pinned near 0 for this residue class, so a
 * trend over it can never fire. Measured 2026-08-03 02:50Z, at one instant:
 *
 *   • direct cgroup census   → 14 dead-window scopes holding 59 processes
 *   • processes:list {live}  → unaccounted: 0, foreign: 1, degraded: FALSE
 *   • task_ledger            → 0 rows in state 'unaccounted', ever (of 953)
 *
 * The cause is ORDERING, not classification. `classifyScope` already returns
 * `unaccounted` for a dead window (scope-class.ts), but it is never reached:
 * `scan.ts` skips a foreign process on the repo-root signature BEFORE `push()`,
 * and `push()` is the only caller of the window probe. So window-liveness sits
 * DOWNSTREAM of a cmdline filter, and 50 of those 59 processes can never be
 * classified at all. (Filed EI-19398679054297365.)
 *
 * This module therefore censuses SCOPES directly. It reuses the existing probe
 * (`readTerminalAppPids` + `terminalWindowAlive`) unchanged — those read
 * `cgroup.procs` and `/proc/<pid>/stat` only, need no cmdline match, and so are
 * immune to the filter that blinds the scan.
 *
 * ── WHY THE SIGNAL IS THE FLOOR, NOT THE LEVEL ──────────────────────────────
 *
 * D-016 measured the steady state: 14 of 15 dead-window scopes held live agent
 * sessions or shared infra. So an absolute-level alarm is ~93% false-positive and
 * would be muted within a day — the failure this indicator exists to avoid.
 *
 * What actually distinguishes residue from ordinary use is that residue never
 * goes away. Windows open and close all day, which moves the MAXIMUM constantly;
 * only a floor that climbs means scopes are accumulating and never being cleared.
 * So the verdict compares the MINIMUM of a recent window against the MINIMUM of
 * an older one. That is the "16 days of silent accumulation" shape, and it is
 * deliberately insensitive to churn.
 *
 * ── REPORT-ONLY (D-006 / D-010 / D-016) ─────────────────────────────────────
 *
 * Nothing here terminates anything, and nothing here should grow that power
 * without re-deciding D-016. A dead window is NOT proof of abandonment — it is
 * "a window closed but these kept running". Consumers must render it that way.
 *
 * EI-20369673282334981 added `live-service-unclaimed` and `owningSessionIds`
 * under exactly that constraint. Both are strictly REPORTING: the set of scopes
 * this module protects from the `stale` label is byte-for-byte what it was, and
 * the two additions only make an already-protected population countable and
 * attributable. Attribution is not authorization — an agent that started shared
 * infra and then ended leaves that infra attributed to a dead session.
 *
 * Also binding, from D-015: never key success on a scope's unit `ActiveState` or
 * on a `systemctl stop` exit code. A vte-spawn scope sets `KillMode=process`, so
 * a stop returns rc=0, flips the unit to inactive(dead), and leaves every task
 * running — unit state LAUNDERS this residue.
 */

import { parseCgroupProcs, CGROUP_ROOT, type CgroupFs } from './cgroup-read';
import { isTerminalWindowScope, TERMINAL_SLICE } from './scope-class';
import { readTerminalAppPids, terminalWindowAlive } from './terminal-window';

/**
 * Absolute cgroup dir of the terminal application slice, derived from the user
 * manager root the scan already computes (`deriveUserManagerRoot`).
 *
 * Returns null when there is no user manager root (a container, a system-slice
 * deployment) — the caller then has nothing to census, which is the honest
 * degradation rather than a guessed path.
 */
export function resolveTerminalSliceAbs(
  userManagerRoot: string | null,
  cgroupRoot: string = CGROUP_ROOT,
): string | null {
  if (!userManagerRoot) return null;
  const rel = userManagerRoot.replace(/^\/+/, '');
  return `${cgroupRoot}/${rel}/app.slice/${TERMINAL_SLICE}`;
}

/**
 * What a dead-window scope actually IS, once probed (EI-19418147529720290).
 *
 * The count alone was never enough, and the gap had teeth: on 2026-08-03 an agent
 * (me) read "15 dead scopes holding 62 processes", joined the pids to PSS, and
 * reported 2.37 GB as reclaimable. 1.45 GB of it — 61% — was the LIVE staging
 * operator, still serving `:3170` and holding four listening sockets; its window
 * had simply been closed. The header already told consumers a dead window is not
 * proof of abandonment, but handed them a single integer, so the correct reading
 * was not available to them. This type is that reading.
 *
 * Deliberately conservative: `stale` must be EARNED, everything undecided stays
 * `indeterminate`. D-016 measured 14 of 15 dead scopes holding live tenants, so a
 * classifier that guesses wrong in the `stale` direction would recreate the ~93%
 * false-positive rate this indicator was designed to avoid.
 */
export type ResidueDisposition =
  /** Holds a listening socket or a pid the caller knows is live — NOT residue. */
  | 'live-service-held'
  /**
   * EI-20369673282334981 — holds a LISTENING socket, is past the staleness
   * threshold, and NO caller-supplied `knownLivePids` entry claims it.
   *
   * This bucket exists because `live-service-held` was previously the terminal
   * answer for any listener at any age, which made the census structurally unable
   * to report a leaked SERVER — the highest-cost orphan shape on this box. On
   * 2026-08-13 an abandoned heap-retention probe (a Hono host on :4015, launched
   * from a terminal whose agent session had ended) held ~70 GiB for 12 hours and
   * this guard could not have reported it at any age.
   *
   * ⚠ REPORTED, NEVER REAPABLE. It is deliberately NOT a sub-kind of `stale`, and
   * it carries no more authority to kill than `live-service-held` did. D-016
   * measured the counter-example that makes that non-negotiable: the `:3170`
   * staging operator lives in a dead terminal window, listens, and is claimed by
   * nobody the task ledger knows about — i.e. it is INDISTINGUISHABLE from the
   * :4015 orphan by every property observable here. Attribution is not
   * authorization. The point of the split is to make the population VISIBLE and
   * countable so it can be measured before anyone proposes acting on it.
   */
  | 'live-service-unclaimed'
  /**
   * Old enough, and nothing suggests a live tenant. The only reclaim candidate.
   *
   * A FLOOR on what is abandoned, never the whole of it: the probe protects
   * anything holding a TCP port, so an abandoned daemon that still listens (a
   * forgotten emulator, a stray `http.server`) lands in `live-service-held` or
   * `live-service-unclaimed` instead. Under-reporting here is the intended error
   * direction.
   */
  | 'stale'
  /** Too young to judge, unprobeable, or no probe was supplied. Never counted as stale. */
  | 'indeterminate';

/** One scope observed to have no live window. */
export interface DeadWindowScope {
  /** The scope's leaf unit name, e.g. `vte-spawn-<uuid>.scope`. */
  scope: string;
  /** How many processes it still holds. */
  pidCount: number;
  /** What it is. `indeterminate` whenever no probe was supplied — never a guess. */
  disposition: ResidueDisposition;
  /** Age of its longest-running process, the input to the staleness threshold. */
  oldestPidAgeMs: number | null;
  /**
   * EI-20369673282334981 — the agent session ids (`PAPERCUSP_SID`) inherited by
   * this scope's processes, when the probe can read them.
   *
   * REPORTING ONLY, and two properties of it must survive into any consumer:
   *
   *  • An EMPTY list is not evidence of orphanhood. Measured on this box
   *    2026-08-13: 148 of 200 readable `/proc/<pid>/environ` carried no
   *    `PAPERCUSP_SID` at all — a systemd service, a pre-operator bootstrap, or
   *    anything the owner launched by hand. The majority case, not an edge.
   *  • A session id here says who LAUNCHED the process, not who owns it now. An
   *    ended session does not make the process abandoned: an agent that started
   *    the `:3170` staging operator and has since ended leaves critical shared
   *    infra attributed to a dead session.
   *
   * Absent probe support (or an unreadable environ) yields an empty list, which
   * must stay indistinguishable from "no opinion" — never promoted to a verdict.
   */
  owningSessionIds: string[];
}

/**
 * The liveness evidence the census cannot gather itself without giving up purity.
 *
 * Injected rather than imported so `censusTerminalResidue` stays pure with respect
 * to its dependencies (no clock, no subprocess, no DB) — the property its existing
 * tests rest on. `nodeResidueLivenessProbe` is the real implementation.
 */
export interface ResidueLivenessProbe {
  /** Pids owning at least one socket in LISTEN. A server is not residue. */
  listeningPids(): ReadonlySet<number>;
  /**
   * Pids the CALLER independently knows are live tenants — enrolled task_ledger
   * rows, live agent sessions. Optional, because the census must not reach into a
   * database to answer; a caller that has the set cheaply should pass it.
   */
  knownLivePids?(): ReadonlySet<number>;
  /**
   * The agent session id (`PAPERCUSP_SID`) a pid inherited from the shell that
   * launched it, or null when there is none / it is unreadable.
   *
   * Optional for the same reason `knownLivePids` is: the census must stay pure
   * with respect to its injected `CgroupFs`, and this needs `/proc/<pid>/environ`.
   * A probe that omits it leaves `owningSessionIds` empty, which reads as "no
   * opinion" — see `DeadWindowScope.owningSessionIds` for why that must never be
   * read as "unowned".
   */
  owningSessionId?(pid: number): string | null;
  /** Wall-clock ms since a pid started, or null when unreadable. */
  pidAgeMs(pid: number): number | null;
}

export interface ResidueClassifyOptions {
  probe?: ResidueLivenessProbe;
  /**
   * A scope younger than this is `indeterminate`, never `stale`. A window that
   * closed moments ago holding a fresh process is far more likely a race with a
   * still-starting session than an orphan. Default 24h.
   */
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60_000;

export interface ResidueCensus {
  /** Terminal window scopes seen at all. */
  scopesTotal: number;
  /** Scopes whose window is positively observed DEAD. */
  scopesDead: number;
  /** Processes held by those dead-window scopes. */
  deadPids: number;
  /**
   * Scopes the probe could not decide (`null`) — an unreadable scope, an empty
   * one, no identifiable terminal application. Reported, never counted as dead:
   * unknown is not dead, exactly as `classifyScope` treats it.
   */
  unprobeable: number;
  /** The dead-window scopes themselves, for a report-only surface. */
  dead: DeadWindowScope[];
  /**
   * `scopesDead` split by disposition — the numbers a consumer should actually
   * render. `scopesDead` alone invites a reclaim estimate that is mostly live work.
   * Without a probe these are `0 / 0 / scopesDead`: honestly undecided, not clean.
   */
  deadStale: number;
  deadLiveServiceHeld: number;
  /**
   * EI-20369673282334981 — dead-window scopes holding a listener that no known
   * live tenant claims, past the staleness threshold. Report-only; see the
   * `live-service-unclaimed` disposition for why this must not drive a reap.
   */
  deadLiveServiceUnclaimed: number;
  deadIndeterminate: number;
}

/**
 * Census the terminal slice. Pure with respect to the injected `fs` — no clock,
 * no subprocess, no writes.
 *
 * `terminalSliceAbs` is the absolute cgroup dir of the terminal application slice
 * (the parent of the `vte-spawn-*.scope` dirs).
 */
export function censusTerminalResidue(
  terminalSliceAbs: string,
  fs: CgroupFs,
  opts: ResidueClassifyOptions = {},
): ResidueCensus {
  const appPids = readTerminalAppPids(terminalSliceAbs, fs);
  const { probe } = opts;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // Hoisted: both sets are one scan of /proc each, and a slice can hold 100+ scopes.
  const listening = probe?.listeningPids();
  const knownLive = probe?.knownLivePids?.();

  let scopesTotal = 0;
  let unprobeable = 0;
  const dead: DeadWindowScope[] = [];

  for (const name of fs.readDir(terminalSliceAbs)) {
    if (!isTerminalWindowScope(name)) continue;
    const abs = `${terminalSliceAbs}/${name}`;
    if (!fs.isDir(abs)) continue;
    scopesTotal++;

    const alive = terminalWindowAlive(abs, appPids, fs);
    if (alive === null) {
      unprobeable++;
      continue;
    }
    if (alive) continue;

    const pids = parseCgroupProcs(fs.readFile(`${abs}/cgroup.procs`) ?? '');
    dead.push({
      scope: name,
      pidCount: pids.length,
      ...classify(pids),
      owningSessionIds: owningSessions(pids),
    });
  }

  /**
   * The order of these tests is the safety property, not a style choice: every
   * branch that could mistake live work for residue is checked BEFORE the one that
   * can label something `stale`.
   */
  function classify(pids: readonly number[]): Pick<DeadWindowScope, 'disposition' | 'oldestPidAgeMs'> {
    if (!probe) return { disposition: 'indeterminate', oldestPidAgeMs: null };

    // A pid the caller independently knows is live settles it outright, at any
    // age. This is checked FIRST and separately from the listener test: it is the
    // strongest evidence available here, and it is the leg that makes "unclaimed"
    // below mean anything at all.
    if (pids.some((p) => knownLive?.has(p))) {
      return { disposition: 'live-service-held', oldestPidAgeMs: oldest(pids) };
    }

    if (pids.some((p) => listening?.has(p))) {
      const listenerAge = oldest(pids);
      // EI-20369673282334981. A listener still short-circuits every staleness
      // test — the protection is UNCHANGED, and nothing below can now relabel it
      // `stale`. What changes is only the NAME the report gives it once it is old
      // and unclaimed, because "a 12-hour-old listening server nobody claims" and
      // "the staging operator" were previously the same integer.
      //
      // An unreadable age keeps the original label: `live-service-unclaimed` is a
      // claim about age, and a failed read is not evidence for it.
      if (listenerAge !== null && listenerAge >= staleAfterMs) {
        return { disposition: 'live-service-unclaimed', oldestPidAgeMs: listenerAge };
      }
      return { disposition: 'live-service-held', oldestPidAgeMs: listenerAge };
    }

    const age = oldest(pids);
    // An unreadable age is NOT a young one. Falling through to `stale` here would
    // label a scope residue on the strength of a failed read.
    if (age === null) return { disposition: 'indeterminate', oldestPidAgeMs: null };
    if (age < staleAfterMs) return { disposition: 'indeterminate', oldestPidAgeMs: age };

    // An EMPTY dead scope is not stale residue — it holds nothing to reclaim, and
    // counting it as stale would inflate the one number meant to drive cleanup.
    if (pids.length === 0) return { disposition: 'indeterminate', oldestPidAgeMs: age };

    return { disposition: 'stale', oldestPidAgeMs: age };
  }

  /**
   * The distinct `PAPERCUSP_SID` values this scope's processes carry, in first-seen
   * order. Deduplicated because the common shape is one agent shell plus its
   * children, which all inherit the SAME id — reporting it N times would read as N
   * sessions.
   */
  function owningSessions(pids: readonly number[]): string[] {
    if (!probe?.owningSessionId) return [];
    const seen = new Set<string>();
    for (const p of pids) {
      const sid = probe.owningSessionId(p);
      if (sid) seen.add(sid);
    }
    return [...seen];
  }

  function oldest(pids: readonly number[]): number | null {
    let max: number | null = null;
    for (const p of pids) {
      const a = probe?.pidAgeMs(p);
      if (typeof a === 'number' && Number.isFinite(a) && (max === null || a > max)) max = a;
    }
    return max;
  }

  const by = (d: ResidueDisposition) => dead.filter((x) => x.disposition === d).length;
  return {
    scopesTotal,
    scopesDead: dead.length,
    deadPids: dead.reduce((n, d) => n + d.pidCount, 0),
    unprobeable,
    dead,
    deadStale: by('stale'),
    deadLiveServiceHeld: by('live-service-held'),
    deadLiveServiceUnclaimed: by('live-service-unclaimed'),
    deadIndeterminate: by('indeterminate'),
  };
}

/**
 * Is `pid` sitting in a terminal window scope whose window is still ALIVE?
 *
 * `true` alive · `false` the window is positively gone · `null` NOT APPLICABLE or
 * COULD NOT TELL (the pid is not in a window scope, /proc was unreadable, the
 * terminal application could not be identified).
 *
 * ── WHY THIS EXISTS (P-012 / D-019) ─────────────────────────────────────────
 *
 * The idle-session reaper decides what to SIGKILL from a different population
 * than this detector: open `adv_sessions` rows keyed by `coord_owner_id`. Its
 * "don't kill a window the user is looking at" protection comes from
 * `desktop-window-liveness`, which enumerates X windows via `wmctrl` — and when
 * that is unavailable (headless host, no DISPLAY, a rotted launch handle,
 * Windows) it yields an EMPTY set. An empty PROTECTION set protects nobody, so
 * that signal fails toward KILLING. It has already done so twice: WI-1586 (the
 * exemption silently became a no-op and it SIGKILLed a session the owner had
 * open on screen) and WI-1641 (the same lapse on Windows).
 *
 * This predicate answers the same question from the cgroup tree instead, so it
 * needs no X server and holds precisely where the wmctrl signal is empty. It is
 * ADDITIVE: a caller folds it in as one more reason to protect, never as a
 * reason to kill. Per D-019, unknown (`null`) must PROTECT — matching
 * `classifyScope`, which treats an unprobeable window as still exempt, and
 * inverting the reaper's existing fail-toward-kill polarity.
 */
/**
 * `alive` the window is open · `dead` it is positively gone · `unknown` it IS a
 * window scope but the probe could not decide · `not-a-window` the pid is not in
 * a terminal window scope at all.
 *
 * `unknown` and `not-a-window` MUST stay distinct. Collapsing them to one "no
 * answer" value is a real bug, not a tidiness question: `not-a-window` is the
 * common case for a headless psu session, so a protection rule that treats it
 * like `unknown` would spare EVERY such session and silently disable the reaper
 * — the same over-broad-signal failure this plan keeps finding, with the sign
 * flipped toward never acting.
 */
export type WindowScopeVerdict = 'alive' | 'dead' | 'unknown' | 'not-a-window';

export function isPidInLiveWindowScope(pid: number, fs: CgroupFs): WindowScopeVerdict {
  const raw = fs.readFile(`/proc/${pid}/cgroup`);
  if (!raw) return 'not-a-window';

  // `0::/user.slice/.../vte-spawn-<uuid>.scope` — take the path off the last field.
  const line = raw.split('\n').find((l) => l.includes('::'));
  const rel = line?.slice(line.indexOf('::') + 2).trim();
  if (!rel) return 'not-a-window';
  if (!isTerminalWindowScope(rel)) return 'not-a-window';

  const scopeAbs = `${CGROUP_ROOT}${rel}`;
  const sliceAbs = scopeAbs.slice(0, scopeAbs.lastIndexOf('/'));
  const appPids = readTerminalAppPids(sliceAbs, fs);
  const alive = terminalWindowAlive(scopeAbs, appPids, fs);
  return alive === null ? 'unknown' : alive ? 'alive' : 'dead';
}

/**
 * D-019: should the reaper SPARE this pid on the strength of the cgroup signal?
 *
 * The polarity is the whole point, so it is expressed once here rather than left
 * to each call site. This leg protects only when it has something to say about a
 * REAL window: `alive` (obviously) and `unknown` (a window scope we could not
 * read — the reaper's wmctrl leg fails toward killing in exactly this case, so
 * this one must not).
 *
 * `not-a-window` yields NO protection — not because the session is unimportant,
 * but because this leg has no opinion about it and must stay strictly additive:
 * it may only ever prevent a kill that happens today, never disable the sweep.
 */
export function cgroupWindowProtects(verdict: WindowScopeVerdict): boolean {
  return verdict === 'alive' || verdict === 'unknown';
}

/** One observation of the dead-window count. */
export interface ResidueSample {
  atMs: number;
  scopesDead: number;
}

export interface AppendSampleOptions {
  /** Drop samples older than this. Default matches the trend lookback. */
  retainMs?: number;
  /** Hard cap on ring length, so a fast cadence can never bloat the row. */
  maxSamples?: number;
}

const DEFAULT_RETAIN_MS = 21 * 24 * 60 * 60_000;
const DEFAULT_MAX_SAMPLES = 400;

/**
 * PURE: append one sample and prune the ring.
 *
 * Kept separate from the store so the retention rule is unit-testable without a
 * database. Prunes by AGE first, then by count — age is the semantic rule (the
 * trend needs a multi-week lookback), and the count cap is only a bound on how
 * badly a misconfigured cadence can bloat one jsonb row.
 *
 * Retention is deliberately LONGER than the trend's lookback: a comparison window
 * whose oldest sample is the same age as the retention cut has nothing stable to
 * compare against.
 */
export function appendResidueSample(
  ring: readonly ResidueSample[],
  sample: ResidueSample,
  opts: AppendSampleOptions = {},
): ResidueSample[] {
  const retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;

  const cutoff = sample.atMs - retainMs;
  const kept = [...ring, sample]
    .filter((s) => s.atMs >= cutoff)
    .sort((a, b) => a.atMs - b.atMs);

  return kept.length > maxSamples ? kept.slice(kept.length - maxSamples) : kept;
}

export type ResidueTrend = 'rising' | 'steady' | 'falling' | 'unknown';

export interface ResidueTrendVerdict {
  trend: ResidueTrend;
  /** Floor of the recent window minus floor of the older window. */
  floorDelta: number;
  /** The two floors, so a report can show its work rather than assert a verdict. */
  recentFloor: number | null;
  olderFloor: number | null;
  /** True only for a sustained RISING floor — the report-worthy condition. */
  alarm: boolean;
  /** Why, in one line, for the surface that renders this. */
  summary: string;
}

export interface ResidueTrendOptions {
  /** Now, for splitting the samples. */
  nowMs: number;
  /** Samples at or after `nowMs - recentWindowMs` form the recent window. */
  recentWindowMs?: number;
  /** How far back the comparison window reaches. */
  lookbackMs?: number;
  /** Floor rise required to call it rising. */
  minFloorDelta?: number;
  /** Minimum samples in EACH window before a verdict is possible. */
  minSamplesPerWindow?: number;
}

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MIN_FLOOR_DELTA = 2;
const DEFAULT_MIN_SAMPLES = 3;

/**
 * PURE: is the dead-window population ACCUMULATING?
 *
 * Compares the floor (minimum) of a recent window against the floor of the
 * preceding lookback window. A floor that climbs means scopes are arriving and
 * never leaving; ordinary open/close churn moves the peak, not the floor.
 *
 * Returns `unknown` — never a healthy-looking `steady` — when either window is
 * too thin to support a verdict. A monitor that cannot tell must say so; that is
 * the same rule `terminalWindowAlive` and the reconciler's degraded-scan check
 * already follow, and inventing a reassuring answer here is precisely how a
 * detector launders residue (D-017).
 */
export function evaluateResidueTrend(
  samples: readonly ResidueSample[],
  opts: ResidueTrendOptions,
): ResidueTrendVerdict {
  const recentWindowMs = opts.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const minFloorDelta = opts.minFloorDelta ?? DEFAULT_MIN_FLOOR_DELTA;
  const minSamples = opts.minSamplesPerWindow ?? DEFAULT_MIN_SAMPLES;

  const recentFrom = opts.nowMs - recentWindowMs;
  const olderFrom = opts.nowMs - lookbackMs;

  const recent: number[] = [];
  const older: number[] = [];
  for (const s of samples) {
    if (s.atMs >= recentFrom) recent.push(s.scopesDead);
    else if (s.atMs >= olderFrom) older.push(s.scopesDead);
  }

  if (recent.length < minSamples || older.length < minSamples) {
    return {
      trend: 'unknown',
      floorDelta: 0,
      recentFloor: recent.length ? Math.min(...recent) : null,
      olderFloor: older.length ? Math.min(...older) : null,
      alarm: false,
      summary:
        `not enough history to judge accumulation (recent=${recent.length}, older=${older.length}, ` +
        `need ${minSamples} in each) — no verdict, which is not the same as healthy`,
    };
  }

  const recentFloor = Math.min(...recent);
  const olderFloor = Math.min(...older);
  const floorDelta = recentFloor - olderFloor;

  if (floorDelta >= minFloorDelta) {
    return {
      trend: 'rising',
      floorDelta,
      recentFloor,
      olderFloor,
      alarm: true,
      summary:
        `dead-window scopes are ACCUMULATING: the floor rose ${olderFloor} → ${recentFloor} ` +
        `(+${floorDelta}). A window closed but these kept running, and nothing is clearing them. ` +
        `Report-only (D-016) — do NOT reap on this signal; most such scopes hold live tenants.`,
    };
  }
  if (floorDelta <= -minFloorDelta) {
    return {
      trend: 'falling',
      floorDelta,
      recentFloor,
      olderFloor,
      alarm: false,
      summary: `dead-window scope floor fell ${olderFloor} → ${recentFloor} (${floorDelta}) — residue is clearing`,
    };
  }
  return {
    trend: 'steady',
    floorDelta,
    recentFloor,
    olderFloor,
    alarm: false,
    summary: `dead-window scope floor steady at ~${recentFloor} (was ${olderFloor}) — no accumulation`,
  };
}

/**
 * EI-19407950136194410 — is a periodic maintenance job due?
 *
 * The reconcile tick used to gate its two hourly sub-jobs on a MODULE-SCOPED tick
 * counter (`tickCount % 120`, `task-reconcile-action.ts`). That counter resets to 0
 * on every process start, so reaching 120 required the host to stay up for 60
 * UNINTERRUPTED minutes. A host restarting more often than hourly therefore ran both
 * jobs EXACTLY ZERO TIMES, forever — with no error, no log line, and no partial
 * state. The metadata key simply never appeared, which is indistinguishable from
 * "ran and found nothing".
 *
 * That is the same failure polarity as D-019 on `process-lifecycle-no-orphans`: a
 * signal that reads ABSENT when it is merely UNAVAILABLE. It is also the expensive
 * direction, because host churn is precisely what PRODUCES the residue this census
 * measures — the detector switched itself off under the exact conditions it exists
 * to detect, and a restart intended to *activate* it instead delayed it another hour.
 *
 * The fix is to ask the wall clock against a watermark that OUTLIVES the process
 * rather than to count ticks inside it.
 *
 * `lastAtMs == null` means "no watermark on record" — a first run, or a store that
 * could not be read. Both answer DUE on purpose: running a cheap idempotent job once
 * more is strictly safer than a detector that stays silent because its own history
 * was unreadable. That asymmetry is the whole point of the bug this replaces.
 */
export function isMaintDue(input: {
  lastAtMs: number | null;
  nowMs: number;
  intervalMs: number;
}): boolean {
  const { lastAtMs, nowMs, intervalMs } = input;
  if (lastAtMs == null || !Number.isFinite(lastAtMs)) return true;
  // A watermark in the FUTURE (clock skew, a hand-edited row, a restored backup)
  // would otherwise wedge the job shut for as long as the skew lasts. Treat it as
  // due rather than trust it — same fail-toward-running asymmetry as above.
  if (lastAtMs > nowMs) return true;
  return nowMs - lastAtMs >= intervalMs;
}
