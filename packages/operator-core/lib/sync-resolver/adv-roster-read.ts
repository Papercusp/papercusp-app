/**
 * adv-roster-read.ts — the Sessions roster snapshot, BOUNDED and GUARDABLE (WI-39825).
 *
 * ## Why this is its own module and not still inline in the resolver
 *
 * The compute used to live inside `sync-resolver/index.ts`'s `advRoster.list`
 * resolver. Bounding it there is possible — and it WAS bounded there first, in
 * place. Guarding the bound there is not, and an unfalsifiable guard is the
 * thing this whole class of work exists to avoid: the in-place version shipped
 * with zero tests asserting that the deadline fires, which is indistinguishable
 * from a deadline that never fires.
 *
 * A resolver's only input is its wire `argsSchema`. To prove a deadline fires
 * you have to MOVE it, and the only way to move it through a resolver is to put
 * a `budgetMs` knob into the CLIENT CONTRACT — a private test lever shipped to
 * every caller. The alternative, leaving the budget hardcoded at
 * {@link ROSTER_READ_BUDGET_MS} and genuinely waiting it out, costs 6s per test
 * case, blows vitest's 5s default, and produces the kind of slow suite somebody
 * eventually deletes.
 *
 * Extraction dissolves both problems, and it is the seam this repo already
 * chose: `learning-observations-read.ts`, `learning-gym-read.ts`,
 * `learning-frontier-read.ts`, `learning-retain-read.ts` and
 * `learning-scout-read.ts` are all this shape. `opts.budgetMs` is a FUNCTION
 * parameter here, never a wire field, so a guard can shrink the budget to
 * milliseconds while the shipped contract is unchanged.
 *
 * ## What the bound actually fixes
 *
 * Four store legs fan out under one `Promise.all`, and before WI-39825 they had
 * neither a deadline nor a catch. `Promise.all` waits for the slowest, so ONE
 * wedged read took the whole roster past the sync layer's
 * `RESOLVER_READ_TIMEOUT_MS` ceiling and the Sessions view rendered nothing —
 * which is what "the roster spins forever" looks like from the outside. This is
 * a POLLED query behind the header pill and the Agents tile, so a single wedged
 * leg is not a one-off 500; it is every poll, for as long as the store is slow.
 *
 * The legs are NOT equal, so they do not degrade equally:
 *
 *   - `active` (`mergeRosterWithAssignments`) IS the roster. A snapshot without
 *     it is not a degraded roster, it is a wrong one — an empty fleet reads as
 *     "nothing is running", the single most misleading thing this view can say.
 *     So a lapse PROPAGATES, exactly as a throw from that reader does today.
 *     The gain is a fast, LABELLED failure at the budget instead of a hang.
 *   - `ended` / `pending` / `starting` are supplementary sections that render
 *     empty perfectly well. Their lapse costs its own section and nothing else.
 *
 * ## Why a lapsed supplementary leg is NAMED rather than swallowed
 *
 * The in-place version used a bare `.catch(() => [])`. That keeps the roster
 * shipping — the important half — but makes a wedged leg invisible: an empty
 * `ended` list is indistinguishable from "no sessions have ended", and an empty
 * `starting` from "nothing is booting", which is precisely the calm-and-empty
 * failure the `degradedFields` channel exists to prevent. Each casualty is now
 * recorded as a shared {@link DegradedField} beside the intact data, and the
 * array is OMITTED entirely when every leg succeeds — so a healthy payload is
 * byte-identical to what it was before, and its presence is the signal.
 *
 * On the kind: a lapse classifies as `read-failed`, not a new `timed-out`
 * member. `UnavailableKind` is a shared union consumed by client guards; adding
 * a member to say what the verbatim reason (`<label> exceeded the read budget`)
 * already says would strand those consumers for no information gain.
 */

import { classifyReadFailure, type DegradedField } from './degraded-snapshot';
import { createReadDeadline } from './read-deadline';
import { dedupeInFlight } from '../dedupe-in-flight';

/**
 * The whole snapshot's budget, shared by every leg (see `createReadDeadline`:
 * one deadline for the fan-out, not a per-call budget). 6s — the budget the
 * bounded `learning.*` reads carry, measured against real :3170 latency (p90
 * 599ms) and sized to fire under both the sync layer's ~10s
 * `RESOLVER_READ_TIMEOUT_MS` and the memory backend's degraded p50 of ~10.9s.
 * That ordering is the whole point: a budget above the resolver ceiling cannot
 * prevent the failure it exists to prevent, and one below normal latency turns
 * a healthy read into an outage.
 */
export const ROSTER_READ_BUDGET_MS = 6_000;

export interface ReadAdvRosterOptions {
  /** Active workspace id; `null` is the cross-workspace read, as before. */
  workspaceId?: string | null;
  /** Row cap for the ended-sessions section (the wire default is 50). */
  endedLimit?: number;
  /**
   * Deadline for the whole fan-out. A FUNCTION parameter, never a wire field —
   * it exists so the guard can prove the deadline fires without waiting
   * {@link ROSTER_READ_BUDGET_MS} out. Defaults to {@link ROSTER_READ_BUDGET_MS}.
   */
  budgetMs?: number;
  /**
   * Test-only clock override for the stale-while-revalidate cache (see below).
   * A FUNCTION parameter, never a wire field — same reasoning as `budgetMs`:
   * it lets a guard prove FRESH_MS/STALE_MS boundaries fire without a real
   * (or fake-timer) wait. Defaults to `Date.now`.
   */
  nowMs?: () => number;
}

/**
 * Read the Sessions roster: the live fleet plus the ended / pending / starting
 * sections, bounded by one shared deadline. This is the UNCACHED read — see
 * `readAdvRoster` below, which every real caller uses, for the stale-while-
 * revalidate cache wrapped around this.
 *
 * Rejects only when `active` — the leg the view cannot be honest without —
 * fails or lapses. Every other failure mode returns a roster that is TRUE about
 * its intact sections and names the casualties in `degradedFields`.
 */
async function readAdvRosterUncached(opts: ReadAdvRosterOptions = {}) {
  const { workspaceId = null, endedLimit = 50, budgetMs = ROSTER_READ_BUDGET_MS } = opts;
  const os = await import('node:os');
  const {
    mergeRosterWithAssignments,
    dedupeEndedAgainstActive,
    pendingLaunchesToRosterEntries,
    startingLaunchesToRosterEntries,
    readStartingLaunchLogHints,
    dedupeStartingAgainstActive,
  } = await import('../adv-roster');
  const { listEndedAdvSessions, listPendingWorkbenchLaunches, listStartingTerminalLaunches } =
    await import('../adv-sessions');

  const degradedFields: DegradedField[] = [];
  /** Note a supplementary leg's failure instead of swallowing it into `[]`. */
  const noteDegraded = (field: string, err: unknown): never[] => {
    const { kind, reason } = classifyReadFailure(err);
    console.warn(`[advRoster.list] ${field} read failed:`, reason);
    degradedFields.push({ field, kind, reason });
    return [];
  };

  const withinBudget = createReadDeadline(budgetMs);
  const [{ active, orphanedClaims }, endedAll, pendingRows, startingRows] = await Promise.all([
    // PRIMARY: a lapse propagates, as a throw from this reader does today.
    withinBudget(mergeRosterWithAssignments({ workspaceId }), 'roster active'),
    withinBudget(listEndedAdvSessions({ workspaceId, limit: endedLimit }), 'roster ended').catch(
      (err) => noteDegraded('ended', err),
    ),
    withinBudget(listPendingWorkbenchLaunches({ workspaceId }), 'roster pending').catch((err) =>
      noteDegraded('pending', err),
    ),
    withinBudget(listStartingTerminalLaunches({ workspaceId }), 'roster starting').catch((err) =>
      noteDegraded('starting', err),
    ),
  ]);

  // EI-24748208098755918: the starting tier's log diagnostics are read here,
  // asynchronously, instead of with readSync inside the mapper (a profiled
  // 790 ms event-loop stall). Same shared deadline; a lapse costs only the
  // hint text, never the starting cards themselves.
  const startingHints = await withinBudget(
    readStartingLaunchLogHints(startingRows),
    'roster starting hints',
  ).catch(() => undefined);

  const host = os.hostname();
  return {
    active,
    ended: dedupeEndedAgainstActive(endedAll, active),
    orphanedClaims,
    pending: pendingLaunchesToRosterEntries(pendingRows, host),
    // WI-6376: terminal-spawned launches inside their boot window, minus any
    // that already came online (presence wins — see the dedupe's doc).
    starting: dedupeStartingAgainstActive(
      startingLaunchesToRosterEntries(startingRows, host, startingHints),
      active,
    ),
    // Omitted entirely when every leg succeeded, so a healthy roster stays
    // byte-identical to what it was before the bound — the flag's PRESENCE is
    // the signal, exactly as `unavailable` is for a whole-snapshot fault.
    ...(degradedFields.length > 0 ? { degradedFields } : {}),
  };
}

export type RosterSnapshot = Awaited<ReturnType<typeof readAdvRosterUncached>>;

/**
 * Stale-while-revalidate cache for the fan-out above (EI-22091013068319789).
 *
 * MEASURED 2026-09-01 on the green operator under load (~107/128 cores):
 * `readAdvRosterUncached` took 3.1-6.3s at 193 active rows. This is a POLLED
 * query (the header pill's `pollIntervalMs: 5_000`, plus the cross-origin
 * portal's own read under a 2.5s budget, plus the Sessions roster view, the
 * HUD board, and every open browser tab/portal instance independently) — so
 * that cost was paid on EVERY tick, by EVERY consumer, with no de-dup between
 * the many callers hitting the SAME (workspaceId, endedLimit) key at once.
 * Owner-visible consequence: the portal's "agents running" / "process
 * manager" top-bar triggers vanished outright, because every read aborted
 * under its 2.5s timeout (WI-2047194 mitigated this on the PORTAL side with
 * its own 20s-budget stale-while-revalidate re-serve; this is the matching
 * fix at the SOURCE, so every consumer benefits, not just that one caller).
 *
 * Same two-tier shape `resolveSystemHealth` already uses for its own
 * expensive aggregation:
 *   - a hit inside {@link ROSTER_CACHE_FRESH_MS} is served with NO refresh —
 *     a plain cache hit;
 *   - a hit inside {@link ROSTER_CACHE_STALE_MS} is served IMMEDIATELY
 *     (never blocking the caller on the underlying read) while a refresh
 *     runs in the background — this is what turns a tight caller budget
 *     (the portal's 2.5s) into a near-instant cache hit instead of a timeout;
 *   - a cold cache (nothing cached yet, or older than STALE_MS — i.e. nobody
 *     has read this key in a while) blocks on a real read, exactly as before
 *     this cache existed. Worst case is unchanged; the common case is not.
 * Concurrent callers hitting a cold/stale key share exactly ONE in-flight
 * refresh via `dedupeInFlight`, so a stampede of simultaneous pollers (two
 * pill mounts + the portal + a HUD tab, all within the same instant) costs
 * one real read, not N.
 *
 * FRESH_MS is chosen comfortably under the pill's 5s poll cadence so a lone
 * active poller still observes a materially fresh roster on most polls (the
 * background refresh triggered by one stale hit typically lands before the
 * NEXT poll); STALE_MS bounds how old a re-served snapshot may ever be, so a
 * genuinely wedged refresh path degrades to the cold-read behavior instead of
 * serving arbitrarily stale data forever.
 *
 * Bypassed entirely when a caller passes an explicit `budgetMs` — that knob
 * is a TEST-ONLY function parameter, never present on the wire (see this
 * module's header), so every real caller takes the cached path and a test
 * proving the read deadline fires still gets a genuinely fresh, uncached read.
 */
export const ROSTER_CACHE_FRESH_MS = 2_000;
export const ROSTER_CACHE_STALE_MS = 15_000;

interface RosterCacheEntry {
  result: RosterSnapshot;
  computedAt: number;
}
const rosterCache = new Map<string, RosterCacheEntry>();
const rosterInFlight = new Map<string, Promise<RosterSnapshot>>();

function rosterCacheKey(workspaceId: string | null, endedLimit: number): string {
  return `${workspaceId ?? '*'}::${endedLimit}`;
}

function refreshRosterCache(key: string, opts: ReadAdvRosterOptions): Promise<RosterSnapshot> {
  return dedupeInFlight(rosterInFlight, key, async () => {
    const result = await readAdvRosterUncached(opts);
    rosterCache.set(key, { result, computedAt: (opts.nowMs ?? Date.now)() });
    return result;
  });
}

/** Test-only: drop every cached/in-flight roster entry so a suite starts cold. */
export function _resetRosterCacheForTests(): void {
  rosterCache.clear();
  rosterInFlight.clear();
}

/**
 * Read the Sessions roster — the cached entry point every real caller uses.
 * See the cache doc above and `readAdvRosterUncached` for the underlying read.
 */
export async function readAdvRoster(opts: ReadAdvRosterOptions = {}): Promise<RosterSnapshot> {
  if (opts.budgetMs !== undefined) {
    // Test-only budget override (see ReadAdvRosterOptions.budgetMs) — always
    // bypass the cache so a deliberately tightened/widened deadline observes
    // a genuinely fresh, uncached read.
    return readAdvRosterUncached(opts);
  }
  const workspaceId = opts.workspaceId ?? null;
  const endedLimit = opts.endedLimit ?? 50;
  const key = rosterCacheKey(workspaceId, endedLimit);
  const cached = rosterCache.get(key);
  if (cached) {
    const age = (opts.nowMs ?? Date.now)() - cached.computedAt;
    if (age < ROSTER_CACHE_FRESH_MS) return cached.result;
    if (age < ROSTER_CACHE_STALE_MS) {
      void refreshRosterCache(key, opts).catch(() => {
        // Best-effort background refresh: a failure here leaves the existing
        // (still within STALE_MS) cached snapshot in place for the next
        // caller to re-serve, exactly like resolveSystemHealth's fire-and-
        // forget refresh. The NEXT read past STALE_MS falls through to the
        // blocking cold-read branch below and surfaces the failure directly.
      });
      return cached.result;
    }
  }
  return refreshRosterCache(key, opts);
}
