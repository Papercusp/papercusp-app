/**
 * P-019 (D-012) — ask the LIVE operator that holds a hive's corestore to append a
 * fresh head `__snapshot__`, so a `--sparse` release cut can be taken with NO OUTAGE.
 *
 * Why this exists at all: `--sparse` ships only `[coreSparseFrom, len)`, and
 * `computeSparseFrom` finds that bound by scanning back from the tail to the newest
 * complete snapshot set. That scan was capped at 4,000 ops until p2p-join-catchup-speed
 * P-004 removed the cap. A head snapshot at the tail still keeps the cut small (it
 * summarizes every op up to the cut), so the cut asks for one. A quiesced cut appends it itself; the WI-4487 no-outage cut opens the
 * store READ-ONLY and cannot. Before this, "no outage" and "sparse" were mutually
 * exclusive, and the release either took an outage or shipped 1.9 GB labelled sparse.
 *
 * The transport reuses the discovery seam `schedule:inventory` federation already
 * relies on (`listSiblingOperators` over `~/.papercusp/endpoint-ipc.<port>.json`)
 * rather than a port map or a new registry: which process holds a given hive is not
 * knowable statically (the desktop sidecar, :3070, :3170 and bg-host all boot
 * harnesses), and a port→role table is exactly the thing that rots the first time a
 * port moves.
 *
 * TWO PASSES, deliberately. The real call is O(own-log) and stalls the holder's merge
 * loop for its duration, so it is never fanned out: a fast side-effect-free
 * `probeOnly` pass identifies the single holder, and only that one is asked to do the
 * expensive thing.
 */
import { Agent, type Dispatcher } from 'undici';
import { listSiblingOperators, type SiblingOperator } from '../../schedule-federation';

export const HEAD_SNAPSHOT_PATH = '/api/internal/substrate/head-snapshot';

// The AbortSignal below owns each request's deadline. Undici otherwise applies
// its independent five-minute headers timeout, which cuts a healthy long snapshot
// short even when the caller explicitly grants a corpus-sized budget.
const snapshotDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** Discovery deadline per sibling. A `probeOnly` answer is a memory-map lookup. */
export const DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS = 1_500;

/**
 * Fallback deadline for a REAL request whose holder predates the corpus-length probe.
 * Current holders use {@link deriveHeadSnapshotTimeoutMs}; retaining this generous
 * fallback keeps a rolling deployment safe while old and new operators coexist.
 *
 * The operation reads the entire own log before appending, so a cut that gives up early
 * leaves the operator doing work while the cut degrades to a full seed. The route sets
 * `timeoutSec: null` and the caller owns this deadline.
 */
export const DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS = 45 * 60_000;

/** Measured healthy scan: 1,101,530ms for 7,657,919 own-log blocks (2026-09-18). */
export const HEAD_SNAPSHOT_MEASURED_MS_PER_BLOCK = 1_101_530 / 7_657_919;

/**
 * Headroom for machine variance and the append/flush tail after the scan.
 *
 * RAISED 2 -> 4 on 2026-09-21 (WI-10002143 / EI-23917342543376581). The ms/block constant
 * above is calibrated from a SINGLE healthy scan, so it describes an unloaded box and
 * nothing else. Measured on 2026-09-20 the same-size corpus ran more than 2x slower: the
 * derived budget was ~36.7 min, attempt 1 burned 2,214,447ms and aborted on its own
 * AbortSignal. That was a genuine scan overrun, NOT a holder recycle —
 * ~/.papercusp/bghost-watchdog.log shows no restart inside the window (nearest activation
 * 7 min before it started) and the routines ticker stayed healthy throughout.
 *
 * The asymmetry is what sets this number, not the mean. Over-granting costs NOTHING: the
 * client returns the instant the holder answers, so a budget larger than the real scan is
 * never waited out, and HEAD_SNAPSHOT_MAX_TIMEOUT_MS still bounds the worst case.
 * Under-granting costs an entire ~45-min release cut AND degrades it to a full seed —
 * exactly the mislabelled-sparse outcome the P-014/D-012 precondition exists to prevent.
 * So this factor must cover the SLOW tail of a loaded box, not its median.
 */
export const HEAD_SNAPSHOT_TIMEOUT_SAFETY_FACTOR = 4;

/** A small corpus still gets enough time for process/transport variance. */
export const HEAD_SNAPSHOT_MIN_TIMEOUT_MS = 15 * 60_000;

/** Bound malformed or unexpectedly huge corpus metadata. */
export const HEAD_SNAPSHOT_MAX_TIMEOUT_MS = 4 * 60 * 60_000;

/**
 * Derive the real-request deadline from the number of own-log blocks traversed by the
 * producer. `rowCount` is deliberately not used: it is the deduplicated fold output,
 * while the producer's read cost is O(ownLog.length). Invalid/missing probe metadata
 * falls back to the rolling-deploy constant above.
 */
export function deriveHeadSnapshotTimeoutMs(logLength: number | null | undefined): number {
  if (typeof logLength !== 'number' || !Number.isSafeInteger(logLength) || logLength < 0) {
    return DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS;
  }
  const estimated = Math.ceil(logLength * HEAD_SNAPSHOT_MEASURED_MS_PER_BLOCK * HEAD_SNAPSHOT_TIMEOUT_SAFETY_FACTOR);
  return Math.min(HEAD_SNAPSHOT_MAX_TIMEOUT_MS, Math.max(HEAD_SNAPSHOT_MIN_TIMEOUT_MS, estimated));
}

/**
 * Gap between attempts. The failure being waited out is a process restart, so polling
 * faster buys nothing and just hammers a booting operator.
 */
export const DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS = 15_000;

/** Retry budget must be derived from the timeout actually used for the real request. */
export function headSnapshotRetryBudgetMs(
  timeoutMs: number,
  retryDelayMs = DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS,
): number {
  return timeoutMs + 2 * retryDelayMs;
}

/**
 * How long to keep RE-attempting after a holder fails to answer, before giving up.
 *
 * The budget is checked only after an attempt settles; it deliberately never truncates
 * an in-flight snapshot request. Therefore it must outlast one full real-call timeout
 * and the delay before the next attempt, or the timeout path reaches the budget guard
 * before a second attempt can start. Keep one extra delay interval as margin for the
 * discovery and clock overhead around that boundary.
 */
export const DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS =
  headSnapshotRetryBudgetMs(DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS);

/**
 * How often an in-flight snapshot asks whether the exact holder is still alive.
 *
 * A head snapshot can take minutes, so checking only before the POST is not enough:
 * the holder can disappear after discovery and leave the request burning the whole
 * retry budget before the caller gets a chance to discover its replacement.
 */
export const DEFAULT_HEAD_SNAPSHOT_HOLDER_LIVENESS_INTERVAL_MS = 5_000;

export interface LiveHeadSnapshotProduced {
  readonly kind: 'produced';
  readonly port: number;
  readonly pid: number;
  readonly process: string | null;
  readonly appended: boolean;
  readonly coversUpTo: number;
  readonly chunkCount: number;
  readonly rowCount: number;
  readonly elapsedMs: number;
  /** Present only when the request needed more than one attempt. */
  readonly retry?: HeadSnapshotRetryLog;
}

export interface LiveHeadSnapshotNoHolder {
  readonly kind: 'no-holder';
  /** Present only when the request needed more than one attempt. */
  readonly retry?: HeadSnapshotRetryLog;
  /** Ports that answered the discovery pass at all (a live sibling we could talk to). */
  readonly answered: readonly number[];
  /** Every operator-shaped sibling we found on the box, answering or not. */
  readonly probed: readonly number[];
  /**
   * Ports that are ALIVE and serving, but 404'd this route — i.e. their build PREDATES
   * P-019. Distinguished from a dead port on purpose: those two are the same
   * `__transportError` on the wire and used to be reported identically, as a port that
   * merely "did not answer".
   *
   * That collapse hid the single most likely real-world cause of a `no-holder` on a
   * healthy box, and it hid it in the most expensive direction. Measured 2026-08-04
   * (P-014, WI-10773): `papercup-bg-host` HELD the papercusp corestore write lock and
   * served every other internal route (`/api/internal/managed-timers` → 200), but had
   * started 9 minutes BEFORE the head-snapshot route file existed, so it 404'd this one
   * path. The refusal reported `probed 3070, 3170, 3270, 3271; answered 3070, 3270` and
   * said "no operator process here reports having booted" — which reads as "nothing on
   * this box holds the hive", the opposite of the truth. The holder was right there in
   * the probed list, indistinguishable from a dead socket, and the stated remedies
   * ("make sure the operator is healthy", "quiesce and re-run") were both wrong: the
   * operator WAS healthy, and the actual fix is to restart it onto post-P-019 code.
   *
   * The Hono host has no file-watch, so a long-lived holder keeps 404ing this route
   * until it restarts — this is a NORMAL post-deploy state, not an exotic one.
   */
  readonly staleBuild: readonly number[];
}

export interface LiveHeadSnapshotFailed {
  readonly kind: 'failed';
  readonly port: number;
  readonly error: string;
  /**
   * TRUE when the holder never answered (socket died, timed out, non-2xx) — i.e. the
   * request did not reach a working operator. FALSE when the operator ANSWERED and
   * refused (`ok:false`).
   *
   * The split exists because only one of them is worth retrying, and conflating them
   * costs a whole cut: a recycling holder must be waited out, whereas "this harness
   * engine is stopped/closing" is a real answer that will not change by asking again.
   */
  readonly transport: boolean;
  /** Present only when the request needed more than one attempt. */
  readonly retry?: HeadSnapshotRetryLog;
}

/**
 * How many attempts a retrying request burned, and how long it took.
 *
 * `waitedMs` is the SUM OF THE DELIBERATE SLEEPS between attempts — it excludes the time
 * spent actually IN each attempt (discovery + the real POST, which can itself run for
 * minutes; see DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS). `elapsedMs` is true wall-clock from the
 * first attempt to now and is always >= waitedMs. A caller narrating "how hard did we
 * try" wants `elapsedMs` — WI-37467 found `waitedMs` rendered as if it were elapsed and
 * reported "~15s of waiting" for a run that took 616s, because that run's time was spent
 * inside the attempts (a holder that answered slowly), not in the one 15s sleep between
 * them.
 */
export interface HeadSnapshotRetryLog {
  readonly attempts: number;
  readonly waitedMs: number;
  readonly elapsedMs: number;
}

export type LiveHeadSnapshotOutcome = LiveHeadSnapshotProduced | LiveHeadSnapshotNoHolder | LiveHeadSnapshotFailed;

/**
 * A holder can answer the request and still be in the middle of a restart. The
 * head-snapshot route deliberately reports its producer error as HTTP 200 with
 * `ok:false`, so this is not a transport failure even though retrying is the
 * correct action for the transient closed-session class.
 */
export function isRetryableHeadSnapshotOutcome(outcome: LiveHeadSnapshotOutcome): boolean {
  if (outcome.kind === 'no-holder') return true;
  if (outcome.kind !== 'failed') return false;
  if (outcome.transport) return true;

  // Hypercore reports the restart-induced loss as SESSION_CLOSED. Some versions
  // surface the same condition as a plain "Corestore is closed" message. Keep
  // this matcher narrow: an ordinary operator refusal such as
  // "harness engine is stopped/closing" is an actionable answer, not a reason
  // to spend the whole cut retrying.
  return /\bSESSION_CLOSED\b/i.test(outcome.error) ||
    /\bcorestore\b.*\bclosed\b/i.test(outcome.error) ||
    /\bclosed\b.*\bcorestore\b/i.test(outcome.error);
}

interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal; headers: Record<string, string>; body: string; dispatcher?: Dispatcher },
) => Promise<ResponseLike>;

interface HeadSnapshotReply {
  ok?: unknown;
  booted?: unknown;
  /** O(1) own-log length returned only by the side-effect-free probe. */
  logLength?: unknown;
  process?: unknown;
  appended?: unknown;
  coversUpTo?: unknown;
  chunkCount?: unknown;
  rowCount?: unknown;
  elapsedMs?: unknown;
  error?: unknown;
}

async function post(
  fetchImpl: FetchLike,
  sibling: SiblingOperator,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HeadSnapshotReply | { __transportError: string; __status?: number }> {
  try {
    // The route declares `path: '/internal/substrate/head-snapshot'`; the host mounts
    // every route under `/api`, exactly as SIBLING_PROBE_PATH spells out for
    // managed-timers. HEAD_SNAPSHOT_PATH carries the prefix so this stays one string.
    const res = await fetchImpl(`http://127.0.0.1:${sibling.port}${HEAD_SNAPSHOT_PATH}`, {
      method: 'POST',
      dispatcher: snapshotDispatcher,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    // Keep the STATUS, not just a rendered string: a 404 here means "alive, but this
    // build predates the route" and is actionable in a way a dead socket is not.
    if (!res.ok) return { __transportError: `HTTP ${res.status}`, __status: res.status };
    return ((await res.json()) as HeadSnapshotReply) ?? {};
  } catch (e) {
    const cause = e instanceof Error ? e.cause : undefined;
    const detail = cause instanceof Error ? `${'code' in cause ? `${String(cause.code)}: ` : ''}${cause.message}` : '';
    return { __transportError: `${e instanceof Error ? e.message : String(e)}${detail ? ` (${detail})` : ''}` };
  }
}

function isTransportError(r: unknown): r is { __transportError: string } {
  return !!r && typeof r === 'object' && '__transportError' in r;
}

function parseLogLength(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

export interface HiveHolderFound {
  readonly kind: 'holder';
  readonly sibling: SiblingOperator;
  /** Own-log blocks the producer will traverse; absent on pre-fix holders. */
  readonly logLength?: number;
}
export type FindHiveHolderOutcome = HiveHolderFound | LiveHeadSnapshotNoHolder;

/**
 * Which operator-shaped process on this box has `(workspaceId, hive)` BOOTED?
 *
 * Cheap and side-effect-free by construction (`probeOnly`), which is what lets the
 * release cut ask this question BEFORE it mutates anything. That ordering is not a
 * micro-optimisation: `backfillLocalState` INSERTs into `substrate_outbox`, and P-014
 * established that a cut which cannot possibly produce a sparse seed must refuse
 * BEFORE leaving rows enqueued for it. Rolling discovery into the expensive request
 * would have quietly given that invariant back.
 *
 * NEVER throws — an unreachable or broken sibling is simply not a holder.
 */
export async function findLiveOperatorHoldingHive(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly warn?: (msg: string) => void;
}): Promise<FindHiveHolderOutcome> {
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  const fetchImpl = (inp.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
  const listSiblings = inp.listSiblingsImpl ?? listSiblingOperators;

  // selfPort: -1 — the CUTTER is a CLI, not an operator, so it serves no port and must
  // exclude NOTHING. The default (`ownHonoPort()`, which falls back to 3070) would
  // silently skip the release operator, i.e. the single most likely holder, and the
  // symptom would be an unexplained `no-holder` on a perfectly healthy box.
  const siblings = await listSiblings({ selfPort: -1 });
  const probed = siblings.map((s) => s.port);
  if (siblings.length === 0) {
    return { kind: 'no-holder', answered: [], probed, staleBuild: [] };
  }

  const probeTimeoutMs = inp.probeTimeoutMs ?? DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS;
  const probes = await Promise.all(
    siblings.map(async (s) => ({
      sibling: s,
      reply: await post(
        fetchImpl,
        s,
        { workspaceId: inp.workspaceId, hive: inp.hive, probeOnly: true },
        probeTimeoutMs,
      ),
    })),
  );

  const answered = probes.filter((p) => !isTransportError(p.reply)).map((p) => p.sibling.port);
  // A 404 on THIS path from a process that is otherwise serving = a build predating the
  // route. Reported separately because the remedy is specific (restart that process) and
  // is NOT any of the remedies a plain "did not answer" suggests.
  const staleBuild = probes
    .filter((p) => isTransportError(p.reply) && p.reply.__status === 404)
    .map((p) => p.sibling.port);
  const holders = probes.filter((p) => !isTransportError(p.reply) && p.reply.booted === true);
  if (holders.length === 0) {
    return { kind: 'no-holder', answered, probed, staleBuild };
  }
  if (holders.length > 1) {
    // Only one process can hold the corestore write lock, so this should be
    // unreachable. Say so loudly rather than picking silently — a second "holder" means
    // an assumption this whole mechanism rests on has broken.
    warn(
      `[head-snapshot] ${holders.length} processes claim to hold ${inp.workspaceId}::${inp.hive} ` +
        `(ports ${holders.map((h) => h.sibling.port).join(', ')}) — only one can hold the corestore ` +
        'write lock. Using the lowest port; investigate.',
    );
  }
  const holder = holders[0]!;
  const logLength = !isTransportError(holder.reply) ? parseLogLength(holder.reply.logLength) : undefined;
  return {
    kind: 'holder',
    sibling: holder.sibling,
    ...(logLength === undefined ? {} : { logLength }),
  };
}

/**
 * {@link findLiveOperatorHoldingHive}, but WAITS for a holder to appear instead of
 * answering from one instantaneous look.
 *
 * Discovery is side-effect-free (`probeOnly`), so waiting costs nothing but time — and a
 * one-shot look is wrong for the two states this box is in most often (P-014, 2026-08-09):
 *   • a holder mid-recycle has no booted hive for a few seconds; and
 *   • a JUST-restarted holder owns the fd lock while its `getBootedHarness` LRU is still
 *     cold, so every port answers `booted:false` (D-025) — which is indistinguishable
 *     from "nothing on this box holds this hive", and steers to the OUTAGE remedy.
 *
 * Kept separate from `findLiveOperatorHoldingHive` rather than folded into it: the
 * snapshot request runs its OWN retry around a full discovery+POST cycle, and a retry
 * nested inside a retry would multiply budgets that each look bounded on their own.
 */
export async function waitForLiveOperatorHoldingHive(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly retryBudgetMs?: number;
  readonly retryDelayMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly findHolderImpl?: typeof findLiveOperatorHoldingHive;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly nowImpl?: () => number;
  readonly warn?: (msg: string) => void;
}): Promise<FindHiveHolderOutcome> {
  const budgetMs = inp.retryBudgetMs ?? DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS;
  const delayMs = inp.retryDelayMs ?? DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS;
  const now = inp.nowImpl ?? Date.now;
  const sleep = inp.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const find = inp.findHolderImpl ?? findLiveOperatorHoldingHive;

  const startedAt = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const found = await find(inp);
    if (found.kind === 'holder') {
      if (attempts > 1) {
        inp.warn?.(
          `[head-snapshot] a holder for ${inp.workspaceId}::${inp.hive} appeared on attempt ` +
            `${attempts} after ~${now() - startedAt}ms — the earlier miss was a recycle, not an absence.`,
        );
      }
      return found;
    }
    // No operator-shaped process on this box AT ALL is a real absence, not a recycle —
    // nothing is coming back, so waiting the full budget would just delay a correct
    // refusal by ten minutes (a CI box, or a cut run somewhere the operator never runs).
    // A sibling that was PROBED but did not answer is the opposite case: that is what a
    // restarting holder looks like, so those are worth waiting out.
    if (found.probed.length === 0) return found;
    if (now() - startedAt + delayMs > budgetMs) {
      if (attempts > 1) {
        inp.warn?.(
          `[head-snapshot] no holder for ${inp.workspaceId}::${inp.hive} after ${attempts} ` +
            `attempts over ${now() - startedAt}ms — this is a real absence, not a recycle window.`,
        );
      }
      return found;
    }
    await sleep(delayMs);
  }
}

/**
 * Find the operator process holding `(workspaceId, hive)` and have it append a fresh
 * head snapshot. NEVER throws: every failure is a typed outcome, because the caller
 * (a release cut) must be able to degrade deliberately rather than die mid-cut.
 *
 * Re-runs discovery rather than taking a holder the caller found earlier — on purpose.
 * The cut probes once up-front (before mutating) and calls this AFTER a drain that can
 * legitimately run for minutes, and the operator is recycled every ~12 min by the
 * watchdog. The holder at the end of the drain is the only one whose answer means
 * anything.
 *
 * RETRIES across that recycle (P-014, 2026-08-09). Re-running discovery per attempt was
 * necessary but NOT sufficient: it makes each attempt ask the right process, while a
 * recycle landing between the probe and the POST still killed the whole cut on the first
 * transport error. Measured on this box, the holder's typical lifetime (~8.5 min) is
 * HALF the drain this call sits behind (~17.4 min), so "launch into a booted window" can
 * never carry a cut to completion — the window is structurally too short. Waiting the
 * recycle out is the only thing that closes it. See DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS.
 *
 * Retries only what a restart can actually fix — a transport failure, or a `no-holder`
 * (a freshly-recycled process holds the fd lock while its `getBootedHarness` LRU is
 * still cold, which reads as "nobody has this hive"). An operator that ANSWERED and
 * refused is a real answer and returns immediately.
 *
 * Retrying is safe against double-append: the reader resolves the sparse start with
 * `findLatestCompleteSnapshot`, so a second snapshot supersedes the first — and, being
 * later, trims MORE history rather than less.
 */
export async function requestLiveOperatorHeadSnapshot(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly timeoutMs?: number;
  /** Total time to keep re-attempting. 0 disables retry (one shot). */
  readonly retryBudgetMs?: number;
  readonly retryDelayMs?: number;
  /** How often to re-check the discovered holder while the POST is in flight. */
  readonly holderLivenessIntervalMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly nowImpl?: () => number;
  readonly warn?: (msg: string) => void;
}): Promise<LiveHeadSnapshotOutcome> {
  const delayMs = inp.retryDelayMs ?? DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS;
  let budgetMs = inp.retryBudgetMs ?? headSnapshotRetryBudgetMs(inp.timeoutMs ?? DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS, delayMs);
  const now = inp.nowImpl ?? Date.now;
  const sleep = inp.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startedAt = now();
  let attempts = 0;
  let waitedMs = 0;
  let last: LiveHeadSnapshotOutcome | null = null;

  for (;;) {
    attempts += 1;
    const attempt = await attemptHeadSnapshot(inp);
    const outcome = attempt.outcome;
    // A probe-derived timeout may be larger than the fallback. Expand the retry
    // budget from the actual request deadline before deciding whether another
    // attempt can start; otherwise a timed-out large corpus makes retry dead code.
    if (inp.retryBudgetMs === undefined) {
      budgetMs = Math.max(budgetMs, headSnapshotRetryBudgetMs(attempt.timeoutMs, delayMs));
    }
    // Only a restart-shaped failure is worth waiting out; a refusal is a real answer.
    // SESSION_CLOSED/Corestore-closed is returned as an HTTP-200 ok:false body by
    // the holder, so transport === false does not by itself mean "do not retry".
    const retryable = isRetryableHeadSnapshotOutcome(outcome);
    if (!retryable) {
      return attempts > 1 ? withRetryLog(outcome, { attempts, waitedMs, elapsedMs: now() - startedAt }) : outcome;
    }
    last = outcome;

    // Budget governs when we stop STARTING attempts — it never truncates an in-flight
    // one. The real call can legitimately run for minutes (it reads the whole own log),
    // and cutting that short would abandon work the operator is still doing.
    if (now() - startedAt + delayMs > budgetMs) {
      inp.warn?.(
        `[head-snapshot] giving up after ${attempts} attempt(s) over ${now() - startedAt}ms — ` +
          `the holder never came back within the ${budgetMs}ms retry budget.`,
      );
      return attempts > 1 ? withRetryLog(last, { attempts, waitedMs, elapsedMs: now() - startedAt }) : last;
    }

    inp.warn?.(
      `[head-snapshot] attempt ${attempts} did not land (${describeOutcome(outcome)}); ` +
        `retrying in ${delayMs}ms ` +
        `(${Math.max(0, budgetMs - (now() - startedAt))}ms of budget left).`,
    );
    await sleep(delayMs);
    waitedMs += delayMs;
  }
}

function describeOutcome(o: LiveHeadSnapshotOutcome): string {
  if (o.kind === 'no-holder') return `no booted holder among [${o.probed.join(', ')}]`;
  if (o.kind === 'failed') return `port ${o.port}: ${o.error}`;
  return 'produced';
}

function withRetryLog(o: LiveHeadSnapshotOutcome, retry: HeadSnapshotRetryLog): LiveHeadSnapshotOutcome {
  return { ...o, retry } as LiveHeadSnapshotOutcome;
}

/** ONE discovery + request cycle. The retry policy lives in the caller above. */
interface HeadSnapshotAttempt {
  readonly outcome: LiveHeadSnapshotOutcome;
  readonly timeoutMs: number;
}

async function attemptHeadSnapshot(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly holderLivenessIntervalMs?: number;
  readonly warn?: (msg: string) => void;
}): Promise<HeadSnapshotAttempt> {
  const fetchImpl = (inp.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
  const found = await findLiveOperatorHoldingHive(inp);
  if (found.kind !== 'holder') {
    return {
      outcome: found,
      timeoutMs: inp.timeoutMs ?? DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS,
    };
  }
  const holder = found.sibling;
  const timeoutMs = inp.timeoutMs ?? deriveHeadSnapshotTimeoutMs(found.logLength);

  // A full snapshot can occupy the holder for minutes. Watch the identity we
  // discovered while the POST is in flight so a dead/replaced holder becomes a
  // normal retryable transport failure instead of consuming the whole retry budget.
  const requestController = new AbortController();
  const stopWatching = watchHolderLiveness({
    ...inp,
    holder,
    onLost: (replacement) => {
      inp.warn?.(
        `[head-snapshot] holder ${holder.pid}@${holder.port} disappeared while the snapshot ` +
          `request was in flight (${describeHolderLoss(replacement, holder)}); aborting to retry.`,
      );
      requestController.abort();
    },
  });

  let reply: Awaited<ReturnType<typeof post>>;
  try {
    reply = await post(
      fetchImpl,
      holder,
      { workspaceId: inp.workspaceId, hive: inp.hive },
      timeoutMs,
      requestController.signal,
    );
  } finally {
    stopWatching();
  }
  if (isTransportError(reply)) {
    return {
      outcome: { kind: 'failed', port: holder.port, error: reply.__transportError, transport: true },
      timeoutMs,
    };
  }
  if (reply.ok !== true) {
    return {
      outcome: {
        kind: 'failed',
        port: holder.port,
        error: typeof reply.error === 'string' ? reply.error : 'operator reported ok:false',
        transport: false,
      },
      timeoutMs,
    };
  }
  return {
    outcome: {
      kind: 'produced',
      port: holder.port,
      pid: holder.pid,
      process: typeof reply.process === 'string' ? reply.process : null,
      appended: reply.appended === true,
      coversUpTo: Number(reply.coversUpTo) || 0,
      chunkCount: Number(reply.chunkCount) || 0,
      rowCount: Number(reply.rowCount) || 0,
      elapsedMs: Number(reply.elapsedMs) || 0,
    },
    timeoutMs,
  };
}

function sameHolder(a: SiblingOperator, b: SiblingOperator): boolean {
  return a.port === b.port && a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * OS-level liveness for the exact process the endpoint registry identified.
 *
 * A head snapshot deliberately occupies the holder for minutes. Requiring that
 * same busy process to answer another short HTTP request in order to prove it is
 * alive creates a circular failure: the work we are waiting for makes the probe
 * miss its deadline, and the missed probe aborts the work. The per-port endpoint
 * registry already gives us a PID + boot identity, so the watcher below checks
 * that identity directly instead.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM still proves that a process with this PID exists.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function describeHolderLoss(found: FindHiveHolderOutcome, previous: SiblingOperator): string {
  if (found.kind === 'holder') {
    return (
      `a replacement holder is ${found.sibling.pid}@${found.sibling.port} ` +
      `(previously ${previous.pid}@${previous.port})`
    );
  }
  return found.probed.length === 0
    ? 'no operator-shaped sibling remains'
    : `no matching holder among [${found.probed.join(', ')}]`;
}

/**
 * Monitor one specific holder until the request completes or its process identity
 * changes. This deliberately reads the endpoint PROCESS registry instead of calling
 * `findLiveOperatorHoldingHive`: the latter asks the busy holder to answer a 1.5s
 * HTTP probe, while the O(own-log) snapshot is documented to make that same event
 * loop unresponsive for minutes. A slow probe is not evidence that the process died.
 *
 * The timer is intentionally local to this long-lived HTTP request; it is not a
 * datastore polling loop, and it stops as soon as the POST settles.
 */
function watchHolderLiveness(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly holder: SiblingOperator;
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly holderLivenessIntervalMs?: number;
  readonly onLost: (found: FindHiveHolderOutcome) => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const intervalMs = inp.holderLivenessIntervalMs ?? DEFAULT_HEAD_SNAPSHOT_HOLDER_LIVENESS_INTERVAL_MS;
  const listSiblings = inp.listSiblingsImpl ?? listSiblingOperators;

  const scheduleNext = (): void => {
    timer = setTimeout(() => {
      void check().catch(() => {
        // Registry read failure is UNKNOWN, never proof the holder died. The real
        // request is independently bounded; keep watching rather than aborting it.
        if (!stopped) scheduleNext();
      });
    }, intervalMs);
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    const siblings = await listSiblings({ selfPort: -1 });
    if (stopped) return;

    const exact = siblings.find((s) => sameHolder(s, inp.holder));
    if (exact) {
      scheduleNext();
      return;
    }

    // A per-port discovery file can be briefly unreadable while another process
    // rewrites/prunes the registry. If the original PID still exists and no new
    // process has claimed its port, that is uncertainty — not holder death. Let the
    // real POST's own 15-minute deadline remain authoritative and check again.
    const replacement = siblings.find((s) => s.port === inp.holder.port);
    if (!replacement && pidAlive(inp.holder.pid)) {
      scheduleNext();
      return;
    }

    const found: FindHiveHolderOutcome = replacement
      ? { kind: 'holder', sibling: replacement }
      : {
          kind: 'no-holder',
          answered: [],
          probed: siblings.map((s) => s.port),
          staleBuild: [],
        };
    stopped = true;
    inp.onLost(found);
  };

  scheduleNext();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
