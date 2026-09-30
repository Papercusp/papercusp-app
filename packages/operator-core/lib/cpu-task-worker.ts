/**
 * cpu-task-worker.ts — offload CPU-heavy synchronous work to a persistent
 * worker_threads Worker so the operator main event loop is not blocked.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 *
 * Background: the F1 cpuprofile attributed two hot-path culprits that ran
 * SYNCHRONOUSLY on the main thread per SSE polling tick:
 *
 *  (a) JSON.stringify on large result-batch payloads (coord:plan-events
 *      3.5 MB, plans:list 358 KB) — blocks ~30–50 ms per call.
 *  (b) gzipSync on the same payloads — blocks ~50–100 ms per call.
 *
 * At 350–630 elevated windows/hr this compounds into p95 501 ms / worst
 * 3475 ms event-loop lag seen in round-3 cpuprofile captures.
 *
 * (b) IS GONE — the operator no longer compresses any response. It is a
 * loopback desktop sidecar, so gzip only ever shrank bytes that never left
 * the machine while costing CPU on both ends; this worker existed partly to
 * HIDE that cost rather than not pay it. Do not re-add compression here
 * (guard: scripts/check-no-wire-compression.mjs). (a) is real work that
 * still has to happen, so the serialize offload stays.
 *
 * Architecture: one persistent worker per process (lazy-spawned on first
 * call). The main thread postMessages a `{ kind:'serialize', id, value }`
 * envelope; the worker does JSON.stringify and transfers the result back.
 * Falls back to inline sync execution on the main thread when
 * worker_threads are unavailable or the worker crashes — byte-identical
 * behavior (same BigInt→Number replacer), just slower.
 *
 * The structured-clone transfer of `value` to the worker is faster than
 * JSON.stringify because V8 uses a compact binary format internally.
 * Main-thread blocking is reduced to the clone step (~10 ms for a 3.5 MB
 * object) rather than the full stringify (~30–50 ms).
 *
 * Pattern follows libs/generic/memory/src/local-embedder-worker.ts exactly —
 * INCLUDING, until WI-37688, its three transient-failure traps: a runtime
 * crash latched the offload off for the process lifetime, a request in flight
 * when the worker went away never settled, and the worker was never unref'd
 * so a one-off process could not exit. All three are fixed here and there;
 * see `syncWorkerRef`, `rejectAllPending` and MAX_CONSECUTIVE_CRASHES below,
 * and keep the two modules in step when either changes.
 *
 * ⚠ THE TWO MODULES ARE NOW OUT OF STEP, DELIBERATELY (EI-20505664003243915).
 * WI-37688 BOUNDED the first trap (three crashes, not one) but did not remove
 * it: past the bound the latch was still permanent for the process lifetime,
 * with "restart the host" as the documented remedy — restart-to-clear, which
 * is a mitigation, not a fix. This module now RE-ARMS: a latched breaker
 * admits one half-open probe on a backed-off cooldown and closes only when a
 * request is actually SERVED (`closeBreakerOnServe`), it carries the crash
 * CAUSE into the announcement instead of discarding it, and it reports a
 * `verdict` that separates "offload proven working" from "silently falling
 * back". The embedder/reranker breakers in libs/generic/memory and
 * libs/generic/rerank still latch permanently and still carry no cause — the
 * same class, tracked separately rather than fixed by widening this item into
 * a generic lib and the sidecar.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

/**
 * Minimum batch-item count above which we prefer offloading to the worker
 * even without a byte estimate. Below this threshold the structured-clone
 * round-trip overhead (per-field visit) costs more than sync stringify.
 * Env-tunable; default 5 items (empirically ~32 KB+ for typical results).
 */
export const OFFLOAD_MIN_ITEMS = Math.max(
  1,
  Number(process.env.PAPERCUSP_CPU_WORKER_MIN_ITEMS) || 5,
);

interface PendingRequest {
  resolve: (r: WorkerResult) => void;
  reject: (err: Error) => void;
}

interface WorkerResult {
  json: string | null;
}

let _worker: Worker | null = null;
let _workerReady: Promise<void> | null = null;
let _nextId = 0;
const _pending = new Map<number, PendingRequest>();
let _workerDisabled = false;
let _consecutiveCrashes = 0;
/**
 * What `syncWorkerRef` last APPLIED to the worker's libuv handle.
 *
 * libuv exposes no ref-state getter, so this is the only way to report the
 * real thing. Do NOT replace it by re-deriving `_pending.size > 0` in the
 * diagnostic: that restates the code instead of observing it, and a
 * `syncWorkerRef` that stopped ref'ing entirely would still read as correct
 * (measured — that exact mutant SURVIVED the probe, WI-37688). `syncWorkerRef`
 * is the only writer.
 */
let _workerRefd = false;

/**
 * Requests SERVED by the worker thread (a `serialize_ok` round-trip).
 *
 * The only POSITIVE signal this module has. Every other field is an
 * absence-of-bad — `disabled:false` + `alive:false` + `consecutiveCrashes:0`
 * is the state of a healthy idle process AND of a process whose worker has
 * never once served a request, and nothing could tell them apart
 * (EI-20505664003243915). A count of work actually done on the worker thread
 * is what makes "the offload is working" observable rather than inferred.
 */
let _servedByWorker = 0;

/**
 * Offload-ELIGIBLE requests that fell back to the main thread.
 *
 * Deliberately not "every sync stringify": a small batch taking the inline
 * path is the designed behaviour and counting it would bury the signal. Only
 * `itemCount >= OFFLOAD_MIN_ITEMS` — work this module exists to move — counts
 * here, so `eligibleFallbacks > 0 && servedByWorker === 0` means the offload
 * is silently not happening.
 */
let _eligibleFallbacks = 0;

/**
 * Was the MOST RECENT offload-eligible request served by the worker? Null until
 * one has been asked for.
 *
 * The verdict keys off this rather than off `servedByWorker > 0` because the
 * counters are CUMULATIVE and a cumulative count cannot express "it is working
 * NOW": a process that served one request at boot and has failed every request
 * since would report `servedByWorker: 1` forever, and on an operator host that
 * lives for days that is precisely the window in which the answer matters.
 * (Caught by health-deep.test.ts asserting against the cumulative form.)
 */
let _lastEligibleServed: boolean | null = null;

/** Message of the most recent worker crash — see `tripBreaker`'s `cause`. */
let _lastCrashError: string | null = null;
/** When the breaker latched, for the re-arm cooldown. Null ⇒ not latched. */
let _breakerTrippedAt: number | null = null;
/** Failed half-open probes since the breaker latched; drives the backoff. */
let _reArmFailures = 0;
/** Breaker closures earned by a SERVED request (not by a restart). */
let _reArms = 0;
/**
 * A half-open probe is admitted.
 *
 * Gates re-entry so a latched breaker admits ONE probe rather than letting
 * every concurrent request respawn a worker that is still broken — the
 * respawn-per-request failure MAX_CONSECUTIVE_CRASHES exists to prevent.
 */
let _halfOpen = false;

/**
 * Consecutive runtime crashes after which the worker is given up on for good.
 *
 * A TRANSIENT crash must not disable the offload permanently (WI-37688): the
 * whole point of this module is to keep 30-50ms stringifies off the operator
 * main thread, and the sync fallback is byte-identical, so a permanent
 * disable is an INVISIBLE performance regression — no error, no exit code,
 * no log line, just the event-loop lag this module was built to remove.
 * But a worker that spawns fine and then crashes on every message must not
 * be respawned per request either, so recovery is bounded rather than
 * unlimited.
 */
const MAX_CONSECUTIVE_CRASHES = 3;

/**
 * Cooldown before a latched breaker admits one half-open probe, doubling per
 * failed probe up to REARM_MAX_COOLDOWN_MS.
 *
 * Until EI-20505664003243915 the latch was PERMANENT for the process
 * lifetime and the documented remedy was "restart the host" — restart-to-
 * clear, which is a mitigation, not a fix: an operator host lives for days,
 * so one transient burst of three crashes bought days of degraded
 * serialization. The backoff is what lets recovery be automatic without
 * reintroducing respawn-per-request: at the cap a broken worker costs four
 * spawn attempts an hour, while a worker whose cause has cleared is back
 * within one cooldown.
 */
const REARM_BASE_COOLDOWN_MS = 60_000;
const REARM_MAX_COOLDOWN_MS = 900_000;

/** Cooldown for the NEXT probe, given how many probes have already failed. */
export function _reArmCooldownMs(failures: number): number {
  const backed = REARM_BASE_COOLDOWN_MS * 2 ** failures;
  return Math.min(backed, REARM_MAX_COOLDOWN_MS);
}

/**
 * Is a half-open probe admissible right now?
 *
 * PURE, and exported, so the admission boundary is tested against the REAL
 * predicate the request path calls rather than a restatement of it. Inline in
 * `serializeJsonResponse` this comparison was reachable only through a live
 * breaker trip plus a clock the test cannot move, which is how a cooldown that
 * silently never fired would still have read as covered.
 */
export function _breakerAdmitsProbe(a: {
  disabled: boolean;
  halfOpen: boolean;
  trippedAt: number | null;
  reArmFailures: number;
  now: number;
}): boolean {
  // Not latched ⇒ the worker path is open anyway; already probing ⇒ exactly one
  // probe at a time, which is what stops a burst from respawning a broken worker.
  if (!a.disabled || a.halfOpen || a.trippedAt === null) return false;
  return a.now - a.trippedAt >= _reArmCooldownMs(a.reArmFailures);
}

/**
 * Announce a breaker trip (WI-37700). Null ⇒ nothing wired; the trip is still logged.
 *
 * A SEAM rather than a direct call because this module is a hot-path serialization
 * helper reached from an HTTP route handler — importing the coord/PG client here would
 * pull that whole graph into every request path and invite an import cycle. The host
 * wires the real notifier at boot (`runBootstrap`); tests inject a fake.
 */
let _breakerNotifier: ((summary: string) => void) | null = null;

/**
 * Wire the breaker-trip announcement. Call once per process, at boot.
 *
 * MUST be called in every process that SERVES REQUESTS, not just the primary: this
 * module's state is per-process, and on a clustered host (`hono-host.ts` listens with
 * `reusePort: true`; `cluster-fork.ts` forks N workers) the offload — and therefore the
 * breaker — lives independently in each forked worker. That per-process scoping is the
 * whole reason this leg announces from the inside instead of being polled: a GET of
 * `/api/health/deep` is answered by ONE worker, so it samples 1 of N rather than
 * reporting the host. See `worker-breaker-watch.ts` for the full split.
 */
export function configureCpuWorkerBreakerNotifier(
  notify: ((summary: string) => void) | null,
): void {
  _breakerNotifier = notify;
}

/**
 * Latch the breaker and announce it EXACTLY ONCE.
 *
 * Every write to `_workerDisabled = true` goes through here, which is what makes "the
 * breaker tripped" a single observable event rather than a state three call sites set
 * independently.
 *
 * ⚠ The `if (_workerDisabled) return;` guard is DEFENCE IN DEPTH, not the thing
 * currently producing the once-only property — measured, not assumed (a mutation probe
 * removing it leaves the suite green). Today a second call cannot happen: once the latch
 * is set, `serializeJsonResponse` computes `useWorker = false` and goes straight to the
 * sync fallback without re-entering `ensureWorker`, and `_worker` is already null so the
 * 'error' handler cannot fire again. The guard stays because that reachability argument
 * is an emergent property of three separate call sites rather than an invariant anything
 * enforces — the same reasoning as `installBeforeExitHook`'s documented-unreachable
 * pending check — and because the failure it prevents (one broadcast per request to the
 * whole fleet) is far worse than a redundant branch.
 */
function tripBreaker(reason: string, cause?: unknown): void {
  if (_workerDisabled) return;
  _workerDisabled = true;
  _breakerTrippedAt = Date.now();
  if (cause !== undefined) _lastCrashError = describeCause(cause);
  // The CAUSE, not just the count. Until EI-20505664003243915 the crash Error
  // was in scope in the 'error' handler and thrown away — it reached only
  // rejectAllPending/rejectReady, both of which terminate in the bare `catch`
  // in serializeJsonResponse. So the one durable record of a trip (this
  // announcement) said THAT the worker died and never WHY, and the 2026-08-15
  // trip left no recoverable cause anywhere. A responder cannot investigate a
  // crash mechanism the announcement discarded.
  const causeLine = _lastCrashError === null ? '' : ` Last crash: ${_lastCrashError}.`;
  const summary =
    `⚠ worker-breaker TRIPPED: \`cpuWorker\` in operator host pid ${process.pid} has ` +
    `latched \`disabled\` (${reason}) — every JSON response body above ` +
    `${OFFLOAD_MIN_ITEMS} items now serializes INLINE on the main event loop instead of ` +
    `the worker thread, which is the 30-50ms-per-response lag this module exists to ` +
    `remove.${causeLine} The breaker RE-ARMS itself: after a cooldown (from ` +
    `${Math.round(REARM_BASE_COOLDOWN_MS / 1000)}s, doubling per failed probe to ` +
    `${Math.round(REARM_MAX_COOLDOWN_MS / 60000)}min) one probe request retries the ` +
    `worker, and the breaker closes only when a request is actually SERVED. ` +
    `On a clustered host this is ONE worker of N — the others are unaffected. ` +
    `If it never recovers, the cause above is what to fix; a host restart also clears it.`;
  // Logged unconditionally: the log line is the floor, the notifier the improvement.
  // A trip that only ever reached a notifier nobody wired would be as silent as before.
  console.error(`[cpu-task-worker] ${summary}`);
  try {
    _breakerNotifier?.(summary);
  } catch (err) {
    // The notifier is best-effort telemetry on a degradation path — it must never
    // turn a survivable fallback into a thrown error inside a response handler.
    console.error('[cpu-task-worker] breaker notifier threw (ignored):', err);
  }
}

/**
 * Render a crash cause as one line for the announcement.
 *
 * Bounded because it is interpolated into a message broadcast to the fleet and
 * a worker can throw an Error whose message is a whole serialized payload.
 */
function describeCause(cause: unknown): string {
  const raw =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : typeof cause === 'string'
        ? cause
        : String(cause);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 299)}…` : oneLine;
}

/**
 * Close the breaker because a half-open probe was actually SERVED.
 *
 * Called from the `serialize_ok` branch and nowhere else, which is the whole
 * point: the item that asked for this (EI-20505664003243915) asked for a
 * detector proving worker-served requests RESUME "instead of only clearing the
 * latch". Clearing `_workerDisabled` when a worker merely SPAWNS would be
 * exactly the latch-clearing it ruled out — a worker that spawns fine and dies
 * on every message would flap closed forever. A served round-trip is the only
 * evidence the offload works, so it is the only thing that closes the breaker.
 */
function closeBreakerOnServe(): void {
  _workerDisabled = false;
  _halfOpen = false;
  _breakerTrippedAt = null;
  _reArmFailures = 0;
  _reArms += 1;
  const summary =
    `✅ worker-breaker RECOVERED: \`cpuWorker\` in operator host pid ${process.pid} ` +
    `re-armed after a half-open probe was SERVED by the worker thread — JSON bodies ` +
    `above ${OFFLOAD_MIN_ITEMS} items are off the main event loop again ` +
    `(recovery #${_reArms}${_lastCrashError === null ? '' : `; prior crash: ${_lastCrashError}`}).`;
  // Announced for the same reason the trip is: the fallback is byte-identical,
  // so a recovery is as invisible as the degradation was. A trip that is never
  // followed by a recovery notice reads forever as "still broken".
  console.error(`[cpu-task-worker] ${summary}`);
  try {
    _breakerNotifier?.(summary);
  } catch (err) {
    console.error('[cpu-task-worker] breaker notifier threw (ignored):', err);
  }
}

function workerPath(): string {
  const here =
    typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  return resolve(dirname(here), 'cpu-task-worker.script.mjs');
}

/**
 * Hold the event loop open exactly while a request is in flight.
 *
 * An always-ref'd worker keeps a one-off process alive forever; an
 * always-unref'd one lets the process exit mid-request, stranding the
 * caller. Ref while `_pending` is non-empty, unref when idle — call after
 * EVERY mutation of `_pending`.
 */
function syncWorkerRef(): void {
  if (!_worker) return;
  if (_pending.size > 0) {
    _worker.ref();
    _workerRefd = true;
  } else {
    _worker.unref();
    _workerRefd = false;
  }
}

/**
 * Settle every in-flight request instead of dropping it.
 *
 * Clearing `_pending` without rejecting leaves each caller's promise pending
 * FOREVER — and the caller here is an HTTP route handler
 * (endpoint-route/routes/zero-harness/rest-query.ts), so a dropped request
 * is a response that is never sent.
 */
function rejectAllPending(err: Error): void {
  if (_pending.size === 0) return;
  for (const [, p] of _pending) p.reject(err);
  _pending.clear();
}

function ensureWorker(): Promise<void> {
  // `_halfOpen` is the ONE admission past a latched breaker: serializeJsonResponse
  // sets it for a single probe once the cooldown has elapsed.
  if (_workerDisabled && !_halfOpen) {
    return Promise.reject(new Error('cpu-task worker disabled'));
  }
  if (_workerReady) return _workerReady;

  _workerReady = new Promise<void>((resolveReady, rejectReady) => {
    try {
      _worker = new Worker(workerPath());
      // A fresh Worker is ref'd by libuv until we say otherwise.
      _workerRefd = true;
    } catch (err) {
      tripBreaker(
        `the worker thread could not be spawned: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
      rejectReady(err as Error);
      return;
    }

    let initialized = false;

    _worker.on(
      'message',
      (msg: {
        kind: string;
        id?: number;
        json?: string | null;
        error?: string;
      }) => {
        if (msg.kind === 'ready') {
          initialized = true;
          syncWorkerRef();
          resolveReady();
          return;
        }
        if (typeof msg.id !== 'number') return;
        const p = _pending.get(msg.id);
        if (!p) return;
        _pending.delete(msg.id);
        syncWorkerRef();
        if (msg.kind === 'serialize_ok') {
          // Reset the crash run on a SERVED REQUEST, not on a successful
          // spawn: a worker that spawns cleanly and then dies on every
          // message would reset the counter each cycle and the breaker would
          // never trip — which is the one case it exists for.
          _consecutiveCrashes = 0;
          // The positive signal. Incremented HERE, on the completed round-trip,
          // for the same reason the crash counter resets here: this is the only
          // point at which the worker has demonstrably done the work.
          _servedByWorker += 1;
          _lastEligibleServed = true;
          if (_halfOpen) closeBreakerOnServe();
          p.resolve({ json: msg.json ?? null });
        } else {
          p.reject(new Error(msg.error ?? 'cpu-task worker error'));
        }
      },
    );

    _worker.on('error', (err) => {
      rejectAllPending(err);
      // A runtime crash clears the HANDLE so the next call respawns — it does
      // NOT disable the offload. Only a run of consecutive crashes does, so a
      // transient failure self-heals while a permanently broken worker cannot
      // be respawned on every request (WI-37688).
      _worker = null;
      _workerReady = null;
      _lastCrashError = describeCause(err);
      _consecutiveCrashes += 1;
      // EVERY crash is logged, not just the one that trips the breaker. The
      // first two of a run used to be entirely silent — `err` reached only
      // rejectAllPending/rejectReady, whose rejections the caller swallows to
      // take the sync fallback — so the crashes that EXPLAIN a trip vanished
      // before the trip that reported it (EI-20505664003243915). Bounded by
      // MAX_CONSECUTIVE_CRASHES and then by the re-arm backoff.
      console.error(
        `[cpu-task-worker] worker crash ${_consecutiveCrashes} ` +
          `(pid ${process.pid}): ${_lastCrashError}`,
      );
      if (_halfOpen) {
        // The half-open probe crashed: the worker is still broken. The breaker
        // was never un-latched (only `_halfOpen` admitted this one request), so
        // there is nothing to re-trip — just close the window and back off.
        _halfOpen = false;
        _reArmFailures += 1;
        _breakerTrippedAt = Date.now();
        console.error(
          `[cpu-task-worker] half-open probe FAILED (${_reArmFailures} so far); next probe in ` +
            `${Math.round(_reArmCooldownMs(_reArmFailures) / 1000)}s`,
        );
      } else if (_consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
        tripBreaker(
          `${_consecutiveCrashes} consecutive runtime crashes without a served request`,
          err,
        );
      }
      if (!initialized) rejectReady(err);
    });

    _worker.on('exit', (code) => {
      if (code !== 0 && !initialized) {
        rejectReady(new Error(`cpu-task worker exited with code ${code} before ready`));
      }
      // A worker can exit WITHOUT an 'error' event (terminate, an OOM kill,
      // process.exit inside the thread). Stragglers must be settled here too,
      // or their callers wait forever.
      rejectAllPending(new Error(`cpu-task worker exited with code ${code}`));
      _worker = null;
      _workerReady = null;
    });
  });

  return _workerReady;
}

/**
 * Record that an offload-ELIGIBLE request ran inline after all.
 *
 * One helper rather than three assignments so the cumulative count and the
 * most-recent-outcome flag cannot drift apart — the exact two-writers-of-one-
 * fact shape that produces a well-formed reading nothing can falsify.
 */
function noteEligibleFallback(): void {
  _eligibleFallbacks += 1;
  _lastEligibleServed = false;
}

/** BigInt→Number replacer (inline fallback path — byte-identical to worker). */
function bigIntReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Serialize a JSON response body via the CPU-task worker.
 *
 * When `itemCount` is above OFFLOAD_MIN_ITEMS the JSON.stringify is
 * offloaded to the worker thread so it does not block the main event loop.
 * Falls back to sync stringify when the worker is unavailable, disabled, or
 * the batch is small. The response is never compressed — see the file
 * header.
 *
 * @param value     The JS value to serialize.
 * @param itemCount Number of top-level items in the batch; used as a cheap
 *                  proxy for expected payload size.
 */
export async function serializeJsonResponse(
  value: unknown,
  itemCount: number,
): Promise<string> {
  const eligible = itemCount >= OFFLOAD_MIN_ITEMS;

  // Half-open admission: a latched breaker lets exactly ONE probe through once
  // the (backed-off) cooldown has elapsed. `_halfOpen` gates re-entry so a burst
  // of concurrent requests cannot each respawn a still-broken worker — the
  // respawn-per-request failure MAX_CONSECUTIVE_CRASHES exists to prevent.
  if (
    eligible &&
    _breakerAdmitsProbe({
      disabled: _workerDisabled,
      halfOpen: _halfOpen,
      trippedAt: _breakerTrippedAt,
      reArmFailures: _reArmFailures,
      now: Date.now(),
    })
  ) {
    _halfOpen = true;
  }

  const useWorker = eligible && (!_workerDisabled || _halfOpen);
  // Counted BEFORE the attempt: an eligible request that the breaker turned
  // away never reaches the worker path at all, and that refusal is exactly the
  // silent degradation this counter makes visible.
  if (eligible && !useWorker) noteEligibleFallback();

  if (useWorker) {
    try {
      await ensureWorker();
      const id = _nextId++;
      const result = await new Promise<WorkerResult>((res, rej) => {
        _pending.set(id, { resolve: res, reject: rej });
        syncWorkerRef();
        try {
          _worker!.postMessage({ kind: 'serialize', id, value });
        } catch (err) {
          // A non-cloneable value (or a worker that vanished between the
          // await and here) must not leave a pending entry behind holding
          // the event loop open.
          _pending.delete(id);
          syncWorkerRef();
          rej(err as Error);
        }
      });

      if (result.json !== null) return result.json;
      // Unexpected null result — fall through to sync path.
      noteEligibleFallback();
    } catch {
      // Worker spawn failed or crashed — sync fallback below. Counted for the
      // same reason as a breaker refusal: the offload did not happen. The crash
      // itself is logged by the 'error' handler; this bare catch stays silent so
      // a degradation path never throws inside a response handler.
      noteEligibleFallback();
    }
  }

  // Sync fallback (small batch or worker unavailable).
  return JSON.stringify(value, bigIntReplacer);
}

/** Test seam — terminate the worker and reset module state. */
export async function _resetCpuWorker(): Promise<void> {
  if (_worker) {
    try {
      await _worker.terminate();
    } catch {
      /* noop */
    }
  }
  _worker = null;
  _workerReady = null;
  _workerDisabled = false;
  _consecutiveCrashes = 0;
  _workerRefd = false;
  _servedByWorker = 0;
  _eligibleFallbacks = 0;
  _lastEligibleServed = null;
  _lastCrashError = null;
  _breakerTrippedAt = null;
  _reArmFailures = 0;
  _reArms = 0;
  _halfOpen = false;
  // REJECT stragglers, never drop them — a bare `_pending.clear()` here left
  // the caller's promise unsettled forever (WI-37688). The 'exit' handler
  // fired by terminate() above normally drains this first; the loop is the
  // backstop for anything it did not reach.
  rejectAllPending(new Error('cpu-task worker reset while request in flight'));
  _nextId = 0;
}

/**
 * Test seam — drive the registered 'error' handler with a synthetic crash.
 *
 * The worker script is fully try/catch'd, so there is no message a test can
 * send that makes the thread throw; without this seam the crash-recovery path
 * (the defect in WI-37688 — a transient crash used to disable the offload for
 * the whole process lifetime) is unreachable from a test and would ship
 * unguarded. Emitting on the Worker invokes the REAL handler registered in
 * `ensureWorker`, not a copy of it.
 *
 * @returns false when there is no live worker to crash.
 */
export function _injectWorkerCrashForTest(err: Error): boolean {
  if (!_worker) return false;
  _worker.emit('error', err);
  return true;
}

/**
 * Test seam — rewind the breaker's trip timestamp so the re-arm cooldown reads
 * as elapsed.
 *
 * Rewinds the REAL `_breakerTrippedAt` that the REAL cooldown comparison in
 * `serializeJsonResponse` reads, rather than adding a bypass branch: a seam that
 * short-circuits the comparison would leave the actual admission logic untested
 * while looking covered. Same reasoning as `_injectWorkerCrashForTest`, which
 * drives the registered handler instead of a copy of it.
 *
 * @returns false when the breaker is not latched, so a test cannot silently
 *          assert against a no-op.
 */
export function _advanceBreakerClockForTest(ms: number): boolean {
  if (_breakerTrippedAt === null) return false;
  _breakerTrippedAt -= ms;
  return true;
}

/**
 * Diagnostics, surfaced by `GET /api/health/deep` as its `cpuWorker` block
 * (`endpoint-route/routes/misc/health-deep.ts` → `readCpuWorker`).
 *
 * That consumer is the point of this function, not a nicety: `disabled` latches
 * PERMANENTLY and the caller falls back to inline `JSON.stringify`, so a tripped
 * breaker emits byte-identical output with no error and no log — invisible
 * unless something reads it. It went unread for exactly that reason until
 * WI-37696; if you remove the last caller, this function is dead and the
 * breaker is silent again.
 *
 * `keepAlive` reports whether the worker is currently holding the event loop
 * open; read it in the SAME snapshot as `pendingCount` — asserting the two in
 * separate reads is a race, not an assertion (EI-20053788422725852).
 */
export function getCpuWorkerState(): {
  alive: boolean;
  disabled: boolean;
  pendingCount: number;
  minItems: number;
  keepAlive: boolean;
  consecutiveCrashes: number;
  servedByWorker: number;
  eligibleFallbacks: number;
  lastCrashError: string | null;
  reArms: number;
  reArmFailures: number;
  reArmInMs: number | null;
  verdict: CpuWorkerVerdict;
} {
  return {
    alive: _worker !== null,
    disabled: _workerDisabled,
    pendingCount: _pending.size,
    minItems: OFFLOAD_MIN_ITEMS,
    keepAlive: _worker !== null && _workerRefd,
    consecutiveCrashes: _consecutiveCrashes,
    servedByWorker: _servedByWorker,
    eligibleFallbacks: _eligibleFallbacks,
    lastCrashError: _lastCrashError,
    reArms: _reArms,
    reArmFailures: _reArmFailures,
    reArmInMs: cpuWorkerReArmInMs(),
    verdict: cpuWorkerVerdict(),
  };
}

/**
 * What the offload is ACTUALLY doing — the reading `disabled` cannot give.
 *
 * `disabled:false` is an absence-of-bad, and three very different situations
 * produce it: the offload is working, nothing has asked it to work yet, and it
 * is being asked and silently not doing it. The last is the one that motivated
 * EI-20505664003243915 and the one no previous field could express.
 */
export type CpuWorkerVerdict =
  /** Breaker closed and the worker has served ≥1 request — offload PROVEN working. */
  | 'serving'
  /** Breaker closed, nothing offload-eligible has been asked yet. Benign, unproven. */
  | 'idle-unproven'
  /** Breaker closed, eligible work happened, NONE served by the worker. The silent failure. */
  | 'silently-falling-back'
  /** Breaker latched; `reArmInMs` says when the next half-open probe is admitted. */
  | 'disabled';

/** Milliseconds until the next half-open probe; null when the breaker is closed. */
function cpuWorkerReArmInMs(): number | null {
  if (!_workerDisabled || _breakerTrippedAt === null) return null;
  return Math.max(0, _reArmCooldownMs(_reArmFailures) - (Date.now() - _breakerTrippedAt));
}

function cpuWorkerVerdict(): CpuWorkerVerdict {
  if (_workerDisabled) return 'disabled';
  // Keyed off the MOST RECENT eligible outcome, not the cumulative count — see
  // `_lastEligibleServed`. Null means nothing has asked yet, which is unproven
  // rather than healthy.
  if (_lastEligibleServed === null) return 'idle-unproven';
  return _lastEligibleServed ? 'serving' : 'silently-falling-back';
}
