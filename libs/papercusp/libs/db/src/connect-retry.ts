/**
 * connect-retry — a narrow, provably-safe retry for a transaction OPEN
 * (`sql.begin(...)`'s `BEGIN` + the setup `SET_CONFIG` statements that run
 * ahead of the caller's own callback) hitting a pooled connection PgBouncer
 * already closed server-side.
 *
 * ## Why this exists (EI-9279)
 *
 * postgres-js keeps a free-list of pooled connections and hands one out for
 * the next query without first probing it. When PgBouncer (:6432) idle-reaps
 * a connection server-side, postgres-js doesn't learn about it until its
 * `close` event fires — a race that can leave a dead connection in the
 * free-list momentarily. A query issued against it fails immediately with
 * `CONNECTION_CLOSED` ("write CONNECTION_CLOSED 127.0.0.1:6432"). This bites
 * hardest on a FRESH SESSION's very first `withWorkspace` call (its pool was
 * just created, or has been idle since the previous session ended) — which is
 * exactly why it kept surfacing on a brand-new agent's mandated first tool
 * call (`coord:orient`), the worst possible place to fail since the agent
 * isn't oriented yet. Observed empirically: the failing call succeeded on
 * manual retry, typically the 2nd or 3rd attempt (WI/EI-9279 evidence).
 *
 * ## Why retrying `sql.begin(...)` as a whole is safe HERE
 *
 * `postgres-js`'s `sql.begin(fn)` sends `BEGIN` and awaits its round trip
 * BEFORE invoking `fn` at all (see `postgres/src/index.js` `begin()`), so a
 * `CONNECTION_CLOSED` thrown before the caller's callback starts PROVABLY
 * means the caller's own queries never reached the server — retrying the
 * whole `sql.begin(...)` (BEGIN + the workspace-context module's own
 * side-effect-free `SET_CONFIG` statements) cannot double-apply anything.
 * The moment the caller's callback starts running its own queries, retry
 * safety is no longer provable in general (a query may have partially
 * executed), so `retryBeforeCallbackStarts` requires the caller to call
 * `markStarted()` as the FIRST line of its callback body and refuses to
 * retry once that flag is set — a genuine mid-transaction failure always
 * propagates untouched, exactly like `pg-transient-retry.ts`'s narrower
 * `isRetriablePgConnectError` (CONNECT_TIMEOUT-only) does for background
 * sweeps. The two modules are deliberately independent (this one lives in
 * `@papercusp/db-org`, which `pg-transient-retry.ts`'s package —
 * `operator-core` — depends ON, not the reverse; a shared import would be a
 * backwards layering violation).
 *
 * ## The connect-phase DEADLINE (EI-19415414498429866)
 *
 * The retry above handles a connection that fails FAST. It does nothing for one
 * that never answers at all — and that gap took the whole fleet down for 29
 * minutes on 2026-08-03.
 *
 * `connection.ts` deliberately leaves postgres-js's `connect_timeout` UNSET in
 * production (to tolerate a slow embedded-pg cold boot), so a connect against a
 * genuinely dead endpoint **neither resolves nor rejects** — postgres-js simply
 * retries forever. Because `agent-mcp`'s `dispatch()` wraps EVERY tool handler in
 * `withWorkspace()`, and `withWorkspace` opens on the discovery-sourced APP pool,
 * one dead endpoint hung *100% of MCP dispatch* — `coord:whoami` included — while
 * `/api/health` (no DB) answered in 2ms and the env-pinned ADMIN pool kept the
 * database at 300-600 q/s. Nothing recovered it but a process restart, because the
 * resolved URL is memoized for the process lifetime.
 *
 * So the "wait forever" trade-off is sound for a background worker riding out a
 * boot race, and catastrophic for the request path. This module makes it
 * PER-CALLER rather than global: bound the CONNECT PHASE only — the window before
 * `markStarted()` proves a connection was obtained and the caller's own work is
 * about to begin. Once started, there is NO bound, so a legitimately long tool
 * (`testing:run`, `code:run`) is completely unaffected.
 *
 * A breach raises {@link ConnectPhaseDeadlineError}, which is deliberately NOT
 * classified retriable: a dead endpoint stays dead, and retrying would only
 * multiply the caller's wait. One clear, fast, *attributable* error beats an
 * indefinite silent hang that surfaces only as the client transport's own blanket
 * ~300s abort with no cause attached.
 */

// EI-19485014132257783: this process's own acquisition counters. Read-only here —
// the tickets are OPENED at the single acquisition seam (withAcquisitionDeadline),
// which wraps this module on both withWorkspace paths, so registering again here
// would double-count every waiter.
import { ACQUIRE_QUEUE_LOCATION_RESIDUAL, describeAcquirePressure } from './acquire-registry';
import { stampedTag } from './build-stamp';

/** Connect-phase ceiling (ms) — the wait before `markStarted()` proves a connection
 *  was obtained. Chosen to sit comfortably under the ~300s blanket "no response or
 *  progress" abort an MCP client transport imposes, so the failure is reported HERE,
 *  with a cause, instead of surfacing as an anonymous client-side timeout.
 *  `PAPERCUSP_DB_CONNECT_PHASE_DEADLINE_MS=0` disables it (restores the old
 *  wait-forever behaviour for a caller that genuinely needs it). */
export const DEFAULT_CONNECT_PHASE_DEADLINE_MS = 45_000;

export function resolveConnectPhaseDeadlineMs(): number {
  const raw = process.env.PAPERCUSP_DB_CONNECT_PHASE_DEADLINE_MS;
  if (raw === undefined || raw === '') return DEFAULT_CONNECT_PHASE_DEADLINE_MS;
  const n = Number(raw);
  // A non-numeric override must not silently disable the guard.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONNECT_PHASE_DEADLINE_MS;
  return n;
}

/**
 * Thrown when the CONNECT PHASE (everything before the caller's callback starts)
 * exceeds its deadline — i.e. the pool could not obtain a usable connection and
 * postgres-js is retrying in the background with no bound of its own.
 *
 * ## The message must NOT promise the whole operation was a no-op (EI-19448665862739845)
 *
 * This error used to state: "The transaction never opened, so the caller's own
 * queries never ran." That is LOCALLY TRUE — this wrapper bounds only the window
 * before `markStarted()`, so nothing ran on THIS connection — and it was still
 * read, correctly and disastrously, as a SAFETY GUARANTEE that the caller's whole
 * call had no effect. A guarantee of no-effect is precisely what licenses a retry.
 *
 * Measured 2026-08-03: a `coord:send` and an `improvements:capture` each surfaced
 * this error while taking FULL effect (message delivered, work-item created).
 * Believing the sentence and retrying delivered a peer the same directed message
 * twice; the second duplicate was caught only by an unrelated title-similarity
 * dedup, i.e. by luck.
 *
 * The defect is a SCOPE MISMATCH, not a lie, which is why it survived review:
 *   the code means  → "no query ran ON THIS CONNECTION"
 *   the caller reads → "MY CALL had no effect"
 * Those coincide only when the operation touches exactly ONE connection. Keep the
 * claim scoped to the connection, and keep the verify-before-retry warning — any
 * multi-connection caller needs it.
 *
 * Do not restore a single confident cause either: a saturated CLIENT pool with a
 * perfectly healthy endpoint presents identically to a dead endpoint (that same
 * incident: PG up, 159 of 512 connections free, reads succeeding throughout), so
 * "this almost always means the endpoint is DEAD" sent every reader to a dead end.
 *
 * ## …but naming both causes is not the same as DISCRIMINATING them (EI-19485014132257783)
 *
 * Two rewrites (EI-19448665862739845, then WI-8848) got the message from "one
 * confident wrong cause" to "two causes plus a procedure for telling them
 * apart". The procedure is still THREE MANUAL STEPS handed to a reader
 * mid-incident, and step 2 is a database query — against a pool that is
 * saturated by hypothesis, so the diagnostic queues behind the thing it is
 * diagnosing.
 *
 * When `pool` is supplied the message now LEADS with this process's own
 * acquire-registry counters (zero I/O — see `acquire-registry.ts`), which
 * settles the common case outright: a RECENT successful acquisition on the same
 * pool rules out a dead endpoint, and `held >= max` confirms client saturation.
 * The manual steps stay as the fallback for everything the counters cannot see
 * (other processes, direct pool users, the pooler's own queue).
 */
export class ConnectPhaseDeadlineError extends Error {
  readonly deadlineMs: number;
  /** The pool label this acquisition was against (`org-app`/`org-admin`), when known. */
  readonly pool: string | null;
  /** The measured acquire-pressure line, or null when nothing was measured. */
  readonly measured: string | null;
  constructor(deadlineMs: number, pool?: string) {
    const measured = pool ? describeAcquirePressure(pool) : null;
    // The caller-safety paragraph is INDEPENDENT of any measurement — it is
    // about what may already have committed, not about why the connect stalled —
    // so it is emitted on every path (EI-19448665862739845).
    const callerSafety =
      `No query ran ON THIS CONNECTION — but that is NOT a guarantee your whole operation ` +
      `had no effect: if it touches more than one connection, work already committed on ` +
      `another one STANDS. VERIFY before retrying anything non-idempotent ` +
      `(EI-19448665862739845: a coord:send and an improvements:capture each took FULL ` +
      `effect while surfacing this error, and the retry duplicated a peer's message). `;
    // A decisive measurement has already ANSWERED the cause question, so
    // re-printing the full three-step procedure would bury its own answer —
    // which is the complaint this change exists to fix. Only the residual
    // (WHERE the queue sits) survives.
    const causes = measured?.decisive
      ? ACQUIRE_QUEUE_LOCATION_RESIDUAL
      : `Two causes present identically here, so check both: (a) the pool's resolved ` +
        `endpoint is DEAD or unreachable — postgres-js retries a failed connect forever when ` +
        `connect_timeout is unset (the production default); check the resolved URL for this ` +
        `pool, and if it came from ~/.papercusp/embedded-pg.json it is memoized for the ` +
        `process lifetime so only a restart re-resolves it (EI-19415414498429866). (b) the ` +
        `CLIENT pool is saturated while the endpoint is perfectly healthy; check pool ` +
        `in-use/waiting, and pg_stat_activity count against max_connections. ` +
        `HOW TO TELL THEM APART (WI-8848, measured 2026-08-03 at a real breach): server capacity ` +
        `does NOT decide this — that breach had a fully IDLE server, 205 of 512 connections free ` +
        `and only 32 active, so "the database looks fine" is the EXPECTED reading here and is not ` +
        `evidence against (b). Discriminate in this order: (1) behind PgBouncer, ` +
        `"SHOW POOLS" on :6432 — cl_waiting > 0 or maxwait > 0 means the queue is at the POOLER ` +
        `(its default_pool_size), not in this process; (2) both zero ⇒ group pg_stat_activity by ` +
        `application_name and find THIS process's own pcusp:org-*:p<pid> row — at ` +
        `PAPERCUSP_DB_POOL_MAX (per process AND workspace) this client pool is the bottleneck; ` +
        `(3) only if both look healthy is (a) worth chasing. Note a per-statement timeout does ` +
        `not protect this path: it bounds how long each slot is HELD, not the wait to acquire one.`;
    super(
      // Stamped with the emitting BUILD (EI-19484133375867605): this message was
      // corrected once and then re-filed as a live defect four times by agents whose
      // long-lived host still served the pre-fix bytes. The stamp travels with the
      // pasted string, so a reader can tell "still broken" from "old process".
      `${stampedTag('connect-phase-deadline')} could not obtain a database connection within ${deadlineMs}ms. ` +
        (measured ? `${measured.text} ` : '') +
        callerSafety +
        causes,
    );
    this.name = 'ConnectPhaseDeadlineError';
    this.deadlineMs = deadlineMs;
    this.pool = pool ?? null;
    this.measured = measured?.text ?? null;
  }
}

/**
 * Bound `p` ONLY until `isStarted()` reports the caller's callback began. After
 * that the deadline is irrelevant and `p` is awaited unbounded.
 *
 * On a breach the underlying `p` is deliberately NOT cancelled — postgres-js owns
 * that retry and may still succeed, populating the pool for the next caller. We
 * attach handlers to `p` either way so a later rejection can never surface as an
 * unhandled rejection.
 */
function boundConnectPhase<T>(
  p: Promise<T>,
  isStarted: () => boolean,
  deadlineMs: number,
  pool?: string,
): Promise<T> {
  if (deadlineMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      // Started already? The connect phase succeeded — this deadline no longer
      // applies, and `p` alone decides the outcome.
      if (settled || isStarted()) return;
      settled = true;
      reject(new ConnectPhaseDeadlineError(deadlineMs, pool));
    }, deadlineMs);
    // Never hold the event loop open on account of this guard.
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * True iff `e` looks like a postgres-js connection-setup failure — safe to
 * retry ONLY while nothing has been sent on behalf of the caller's own
 * callback yet (enforced by `retryBeforeCallbackStarts`, not by this
 * predicate alone). Covers both `CONNECTION_CLOSED` (a stale pooled
 * connection PgBouncer already reaped) and `CONNECT_TIMEOUT` (the pool's
 * `connect()` itself timed out) — postgres-js-invented `code`s, so matching
 * on them cannot mask an unrelated application error.
 */
export function isRetriableConnectionSetupError(e: unknown): boolean {
  // A connect-phase DEADLINE is never retriable: a dead endpoint stays dead, so a
  // retry only multiplies the caller's wait. Checked by identity rather than left to
  // the message regex below — this error's own text mentions `connect_timeout` while
  // explaining the cause, and a future capitalisation of that word would otherwise
  // silently turn one 45s failure into three.
  if (e instanceof ConnectPhaseDeadlineError) return false;
  const x = e as { code?: string; message?: string } | null;
  if (!x) return false;
  if (
    x.code === 'CONNECTION_CLOSED' ||
    x.code === 'CONNECT_TIMEOUT' ||
    // PostgreSQL 57P03: the server is restarting/recovering and cannot accept
    // the connection yet. This is the same pre-callback startup window as a
    // stale pooled socket, so retrying remains safe before markStarted().
    x.code === '57P03'
  ) {
    return true;
  }
  return (
    /\b(CONNECTION_CLOSED|CONNECT_TIMEOUT|57P03|server_login_retry)\b/i.test(x.message ?? '') ||
    /\b(?:database system is (?:in recovery mode|starting up|not yet accepting connections)|not yet accepting connections)\b/i.test(
      x.message ?? '',
    )
  );
}

export interface RetryBeforeCallbackOpts {
  /** Additional attempts AFTER the first (so total tries = retries + 1). Default 2 —
   *  matches the empirical EI-9279 evidence ("succeeded on 3rd try"). */
  retries?: number;
  /** Base backoff in ms; grows linearly per attempt (backoffMs * attemptNumber). Default 150. */
  backoffMs?: number;
  /** Injectable sleep (tests pass a synchronous stub). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called just before each scheduled retry (attempt is 1-based). Test/observability hook. */
  onRetry?: (attempt: number, e: unknown) => void;
  /**
   * Ceiling (ms) on the CONNECT PHASE of each attempt — the window before
   * `markStarted()` fires. `0` disables the bound (wait forever, the pre-2026-08-03
   * behaviour). Defaults to {@link resolveConnectPhaseDeadlineMs}.
   *
   * Applies PER ATTEMPT, and a breach is not retriable, so a genuinely dead endpoint
   * costs one deadline — not `retries + 1` of them.
   */
  connectDeadlineMs?: number;
  /**
   * The `buildClient` label of the pool being acquired from (`org-app` /
   * `org-admin`). Purely diagnostic: it lets a {@link ConnectPhaseDeadlineError}
   * lead with this process's MEASURED acquire pressure for that pool instead of
   * handing the reader a manual probe (EI-19485014132257783).
   */
  pool?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `run`, retrying up to `retries` times on a `CONNECTION_CLOSED` /
 * `CONNECT_TIMEOUT` that strikes BEFORE `run`'s own `markStarted()` call —
 * i.e. before any of the real caller's queries were sent. `run` receives
 * `markStarted` and MUST call it as the first statement of the caller's own
 * callback (after any side-effect-free connection-setup statements the
 * wrapper itself issues, e.g. `SET_CONFIG`). Rethrows the LAST error once
 * retries are exhausted, once `markStarted()` has fired, or for any
 * non-classified error — this helper never swallows a real failure.
 */
export async function retryBeforeCallbackStarts<T>(
  run: (markStarted: () => void) => Promise<T>,
  opts: RetryBeforeCallbackOpts = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 150;
  const sleep = opts.sleep ?? defaultSleep;

  const connectDeadlineMs = opts.connectDeadlineMs ?? resolveConnectPhaseDeadlineMs();

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let started = false;
    try {
      return await boundConnectPhase(
        run(() => {
          started = true;
        }),
        () => started,
        connectDeadlineMs,
        opts.pool,
      );
    } catch (e) {
      lastErr = e;
      if (started || attempt >= retries || !isRetriableConnectionSetupError(e)) throw e;
      opts.onRetry?.(attempt + 1, e);
      await sleep(backoffMs * (attempt + 1));
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type checker.
  throw lastErr;
}
