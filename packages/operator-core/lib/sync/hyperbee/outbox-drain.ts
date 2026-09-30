/**
 * outbox-drain — Stage 3 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * Reads undrained `harness_shared.substrate_outbox` rows for one booted harness
 * and appends the mapped `LocalWriteOp`s to that device's own Hypercore log via
 * `BootedHarnessHandle.append`, so feature content + issues federate to peers
 * (the read-side `harness-features` / `issues` projections apply them).
 *
 * Delivery: AT-LEAST-ONCE (D-4). A row is marked `drained_at` ONLY after its
 * `append` resolves. If `append` throws on a row, the drain STOPS (leaving that
 * row + all later rows undrained) so the next pass re-attempts them. The LWW
 * merge + idempotent `INSERT … ON CONFLICT` projections tolerate a duplicate /
 * reordered op, so re-appending a row that was actually delivered is harmless.
 *
 * Liveness: `startOutboxDrain` wires a `LISTEN substrate_outbox` (event-driven,
 * the Stage-1 trigger fires `pg_notify` with payload `${ws}::${slug}`) PLUS a
 * bounded poll-fallback timer (in case a NOTIFY is missed while the process was
 * briefly down). This is CDC within one process — NOT polling-as-transport
 * (D-3). It also runs an immediate catch-up drain on start.
 *
 * Inline 24h GC: each drain also deletes ITS OWN (workspace, harness) rows
 * drained > 24h ago, keeping the outbox table small without a separate sweeper
 * (user-approved default — open question 1 in the plan). The GC is scoped per
 * handle so N booted harnesses don't run N concurrent global DELETEs (EI-125).
 *
 * NOT wired into boot here — Stage 5 calls `startOutboxDrain` from boot-all.ts.
 */

import type postgres from 'postgres';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { pinModuleState } from '@papercusp/module-singleton';
import { createConcurrencyGate, type ConcurrencyGate } from '@papercusp/sync';
import type { BootedHarnessHandle, LocalWriteOp } from './boot';
import { outboxRowToLocalWriteOp, UnknownOutboxTableError, type OutboxRow } from './feature-issue-op-keys';
import { recordLocalWrite } from './clobber-events';
import { shouldEncryptOpForRekey } from './hive-epoch-content-ops';
import { isSessionClosedError } from './own-log-fork-guard';
import { redactContentOpValueForEgress } from './content-op-egress-guard';
import {
  createStageAttempt,
  withStageAttempt,
  logIfStageStalls,
  STAGE_STALL_LOG_MS,
  type StageDiagnosticEvent,
} from './stage-stall-log';
import { extractPgErrorInfo } from '../../pg-read-query';
import { trackDetached } from '../../detached-imports';

/**
 * The projection tableTag for federated plans (harness-plans.ts:199 — the value
 * `outboxRowToLocalWriteOp` maps `harness_plans` to). The CDC drain records a
 * LOCAL write for plan ops so a later REMOTE plan op for the same plan_slug can be
 * detected as a clobber (shared-hive-collaboration P-007). Scoped to plans: the
 * other CDC tables (features/issues) have no clobber surface, and `writerPubkey`
 * threading would entangle author-provenance — out of P-007's scope.
 */
const PLAN_TABLE_TAG = 'plans-by-slug';

/**
 * EI-22138988923269437 (WI-2141185's mitigation follow-up): `harness_shared.
 * substrate_outbox` tables that carry cross-agent COORDINATION traffic —
 * these must never be starved behind a bulk backfill of some other
 * CDC-captured table. Kept intentionally small and coordination-specific
 * (not "everything important") — extend by adding a table_name here if a
 * new coordination-carrying table is federated through the outbox.
 *
 * Measured incident: a one-shot 142k-row `engineer_issues` backfill sat at
 * the head of the id-ordered drain cursor for ~20h, during which
 * `coord_event_log`'s oldest undrained row aged from fresh to 27.7k rows
 * behind — cross-agent coordination (messages/handoffs/escalations) was
 * effectively undelivered the whole time, even though nothing about
 * coordination itself was unhealthy.
 */
export const OUTBOX_PRIORITY_TABLES: ReadonlySet<string> = new Set([
  'coord_event_log',
  'coord_conversations',
  'coord_threads',
  'coord_thread_posts',
]);

/** `OUTBOX_PRIORITY_TABLES` as a plain array — the shape `= ANY()`/`!= ALL()`
 *  bind params need. Computed once at module scope (tiny, constant). */
const OUTBOX_PRIORITY_TABLE_LIST: readonly string[] = Array.from(OUTBOX_PRIORITY_TABLES);

/** Unmapped outbox table_names already logged (dedupe the forward-compat skip
 *  warning so an undrained unknown row doesn't spam the log every drain pass). */
const loggedUnknownTables = new Set<string>();

/**
 * EI-13920: fan-out schema-mismatch signatures (`${table_name}:${pgCode}:${message}`)
 * already logged loudly. A fan-out query referencing a column/table the live DB
 * schema doesn't have (a migration that hasn't run, or code shipped ahead of its
 * migration) fails IDENTICALLY for every row of that table on every drain tick —
 * observed live as the same "column ... does not exist" line repeating per-key,
 * indefinitely, drowning the log with a fault that only a schema fix (not a retry)
 * resolves. Dedupe by signature so it is surfaced ONCE per drain-process lifetime,
 * loudly, instead of spamming. Non-schema-mismatch fan-out failures are NOT deduped
 * here — they may be transient/data-specific and are worth seeing on each occurrence. */
const loggedFanoutSchemaMismatches = new Set<string>();

/** Postgres SQLSTATE codes that mean the DB schema doesn't match what the query
 *  expects (a missing/renamed column or table) — structural, not transient, so
 *  retrying every tick cannot fix it; only a migration or a code fix can. */
const SCHEMA_MISMATCH_PG_CODES = new Set<string>([
  '42703', // undefined_column
  '42P01', // undefined_table
]);

/** Returns a stable dedupe signature when `e` is a schema-mismatch Postgres error
 *  (see SCHEMA_MISMATCH_PG_CODES), else null (not a schema-mismatch — caller should
 *  fall back to its normal per-occurrence logging). */
function fanoutSchemaMismatchSignature(tableName: string, e: unknown): string | null {
  const info = extractPgErrorInfo(e);
  if (!info.code || !SCHEMA_MISMATCH_PG_CODES.has(info.code)) return null;
  return `${tableName}:${info.code}:${info.message}`;
}

/** Drain batch size per `drainOutboxOnce` pass. Bounds memory + append latency;
 *  the LISTEN/poll loop re-drains until the table is empty. */
export const DEFAULT_DRAIN_BATCH = 200;

/** Drained rows older than this are GC'd inline on the next drain (24h). */
export const OUTBOX_GC_AGE_MS = 24 * 60 * 60 * 1000;

/** Inline-GC batch size. Bounded so a large backlog can't become one unbounded
 *  DELETE that never commits before the host recycles (the memory-watchdog
 *  recycles the operator ~every 12 min). Each batch is its own committed
 *  statement, so progress survives a restart. */
export const OUTBOX_GC_BATCH = 5000;

/**
 * Inline-GC wall-time budget per drain pass. This is a liveness policy, not a
 * productive-capacity ceiling: each DELETE remains a small committed batch and
 * the next NOTIFY/poll pass resumes any remaining backlog. The former
 * OUTBOX_GC_MAX_BATCHES bound silently left rows behind after an arbitrary
 * 100k-row ceiling.
 */
export const OUTBOX_GC_BUDGET_MS = 30_000;

/**
 * Maximum live outbox batches across the whole process.
 *
 * `boot-all` already caps handle construction at four, but every
 * `startOutboxDrain` detaches its immediate catch-up pass. The construction cap
 * therefore did not cover the work it spawned: a 103-harness host issued 103
 * concurrent `SELECT ... LIMIT 200` reads, and V8's live heap sampler attributed
 * 1.58 GB / 88% of sampled live allocations to postgres JSONB `DataRow` parsing
 * before the host recycled repeatedly (EI-21855287664853515).
 *
 * Four preserves the existing boot-wave concurrency while bounding decoded row
 * batches to 4 * DEFAULT_DRAIN_BATCH. The gate is FIFO, so a busy harness cannot
 * starve a quiet one, and each serialized harness loop joins the queue at most
 * once. Queue time sits OUTSIDE DRAIN_PASS_TIMEOUT_MS below: the watchdog still
 * measures a real admitted pass, never time spent waiting for safe capacity.
 */
export const DEFAULT_OUTBOX_DRAIN_CONCURRENCY = 4;

/**
 * Process-wide admission for inline outbox GC.
 *
 * Every booted harness owns a drain loop, and every newly-wired loop starts an
 * immediate catch-up pass. `boot-all` bounds handle creation, but
 * `startOutboxDrain` deliberately detaches that first pass before returning, so
 * the boot bound cannot bound the GC work that follows. On a 102-harness host
 * that produced 102 overlapping DELETE loops, starved real row delivery, and
 * wedged the main event loop until the host watchdog killed it (EI-218417).
 *
 * GC is best-effort maintenance and every later NOTIFY/poll pass retries it, so
 * contention must SKIP rather than queue: queueing every harness behind one
 * slow cleanup would put the delivery path behind maintenance again. The
 * process-global try-lock admits one GC loop while every other drain proceeds
 * directly to its undrained-row SELECT. Pinning keeps the guard shared across
 * duplicate module evaluation in the long-lived host.
 */
interface OutboxProcessAdmissionState {
  /** Backward-compatible field owned by the original inline-GC try-lock. */
  inFlight: boolean;
  /** Whole-pass FIFO gate added by EI-21855287664853515. Optional because a
   * live process may retain the pre-fix pinned object across module re-eval. */
  drainGate?: ConcurrencyGate;
}

const outboxProcessAdmission = pinModuleState<OutboxProcessAdmissionState>(
  '@papercusp/operator-core.hyperbeeOutboxInlineGc',
  () => ({
    inFlight: false,
    drainGate: createConcurrencyGate(DEFAULT_OUTBOX_DRAIN_CONCURRENCY),
  }),
);

// Upgrade a pre-fix pinned singleton in place rather than minting a parallel
// process-global surface. Re-evaluation also restores the safety cap if a test
// or diagnostic retuned the shared gate.
outboxProcessAdmission.drainGate ??= createConcurrencyGate(DEFAULT_OUTBOX_DRAIN_CONCURRENCY);
outboxProcessAdmission.drainGate.setLimit(DEFAULT_OUTBOX_DRAIN_CONCURRENCY);
const outboxDrainAdmission = outboxProcessAdmission.drainGate;

function tryAcquireInlineGc(): (() => void) | null {
  if (outboxProcessAdmission.inFlight) return null;
  outboxProcessAdmission.inFlight = true;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    outboxProcessAdmission.inFlight = false;
  };
}

/** Default poll-fallback cadence for `startOutboxDrain` (ms). */
export const DEFAULT_POLL_MS = 5000;

/**
 * WI-2009 (gate 1b, shared-hive-p2p-release-readiness): watchdog timeout for ONE
 * drain pass. The drain loop SERIALIZES passes (`draining` flag) — so a single
 * pass that never settles (a hung `await`: keychain unwrap inside
 * `epochEncrypt.encryptOp` on a wedged mac keychain [WI-2018], an epoch-key
 * resolution, an `append` into a wedged substrate) freezes the WHOLE loop
 * FOREVER: every later NOTIFY/poll tick coalesces into the stuck pass and the
 * harness's local writes silently stop federating. That is the live VM
 * signature this WI was filed on (fail-count frozen for 18min+ across process
 * restarts, ONE fresh attempt ~50s post-boot then silence — the 5s poll never
 * "stopped", it was coalescing into a hung pass).
 *
 * The watchdog RACES each pass against this timeout. On expiry the loop is
 * un-wedged (the pass is abandoned; a fresh pass re-attempts on the next tick)
 * — SAFE by this module's own at-least-once contract: the zombie pass finishing
 * later just re-appends rows a newer pass already delivered, which the LWW
 * merge + idempotent projections tolerate by design. The stall also escalates
 * loudly (console line + durable EI via the replication-liveness EI surface) so
 * a hung drain is never silent again.
 */
export const DRAIN_PASS_TIMEOUT_MS = 120_000;

/**
 * WI-2009 (leg 3, the backlog-stall detector the hung-pass watchdog does NOT
 * cover): how long the drain may make ZERO forward progress — settle a pass but
 * drain no rows — while mapped undrained rows remain queued, before it escalates
 * a durable `drain_backlog_stalled` EI.
 *
 * This is the EXACT live signature this WI was filed on that the `DRAIN_PASS_
 * TIMEOUT_MS` watchdog misses: the passes do NOT hang — each one FAILS FAST
 * (a persistent `EpochKeyUnavailableError` because the epoch key never reached
 * this device [WI-2003 divergence], or a persistent append fault), logging a
 * console line every 5s (the filed "208 cumulative drain-failed lines") while
 * `undrained` sits frozen and nobody pages. The watchdog only fires on a pass
 * that never SETTLES; a fast-failing pass settles instantly, so the backlog
 * stalls silently forever.
 *
 * Progress-based (not age-based) so a legitimate large catch-up — the drain
 * chewing through a big backlog 200 rows/poll after the process was down —
 * never false-positives: any pass that drains ≥1 row resets the no-progress
 * clock. Only a backlog that is NOT shrinking at all trips it. A FROZEN peer
 * (a1a71) never trips it either: its drain loop isn't running, so the detector
 * isn't either. 10 min is well under "silently dead indefinitely" yet far above
 * any transient key-arrival delay (seconds) or a normal catch-up.
 */
export const DRAIN_BACKLOG_STALL_MS = 10 * 60 * 1000;

/**
 * WI-5147 (EI-13571): backlog-AGE/SIZE alert — PROGRESS-INDEPENDENT, unlike
 * `DRAIN_BACKLOG_STALL_MS` above. That detector only escalates when the drain
 * makes ZERO forward progress for the whole window; a backlog that is ALWAYS
 * making *some* progress — however pathologically slow relative to its size —
 * never trips it, and can silently starve new content for days to weeks with
 * nobody paged. That is the exact live incident this was filed on: a papercusp
 * harness backlog of 7351 rows, oldest 3 WEEKS old, drained at ~2 rows/min the
 * whole time (steady but nowhere near enough) and went completely undetected
 * until an agent doing a live federation witness happened to notice their own
 * queued write wasn't landing.
 *
 * This detector reads the oldest-undrained-row AGE and the undrained COUNT
 * directly from `substrate_outbox` (not the since-last-progress clock), so it
 * fires independently of whether the drain is "moving". Either threshold alone
 * is sufficient to escalate (a huge backlog of fresh rows during a legitimate
 * bulk catch-up is fine; an old backlog that never shrinks below the size floor
 * is not). 1h / 2000 rows are generous relative to a normal catch-up (a process
 * restart draining a few minutes' worth of backlog clears well under both) but
 * far tighter than "three weeks unnoticed".
 */
export const DRAIN_BACKLOG_AGE_STALL_MS = 60 * 60 * 1000;

/** Undrained-row-count threshold for the same detector — see
 *  `DRAIN_BACKLOG_AGE_STALL_MS`'s doc-comment. Either threshold alone escalates. */
export const DRAIN_BACKLOG_SIZE_STALL_THRESHOLD = 2000;

/** How often the backlog-age/size probe runs (throttled — it's a cheap read, but
 *  no need to run it every single pass). Mirrors `DRAIN_ORPHAN_CHECK_INTERVAL_MS`'s
 *  cadence: run once at boot (the moment a stale backlog is detectable) and then
 *  at most this often. */
export const DRAIN_BACKLOG_AGE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * WI-2136 (orphan-tail recurrence guard): the lookback window for the orphan-tail
 * detector. It only considers rows drained within this window into a PRIOR-era
 * own-log key. Set to the inline-GC horizon (24h) — a still-present drained row is
 * inherently ≤24h old (older ones are GC'd), so this captures exactly the tails
 * that could still be recovered by a re-emit (drained_at=NULL). A dead era whose
 * rows have all been GC'd is unrecoverable and (correctly) no longer flagged.
 */
export const DRAIN_ORPHAN_LOOKBACK_MS = OUTBOX_GC_AGE_MS;

/**
 * WI-2136: min interval between orphan-tail detector runs. The detector runs once
 * at boot (the moment a restart's prior-era tail is detectable) and then at most
 * this often, piggy-backed on the existing drain loop (no second timer). Each dead
 * key escalates ONCE per process (in-memory latch) and the durable EI dedups per
 * (harness, dead-log, kind), so this cadence bounds the read cost, not the noise.
 */
export const DRAIN_ORPHAN_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** Thrown inside the drain loop when a pass exceeds `DRAIN_PASS_TIMEOUT_MS`. */
export class DrainPassTimeoutError extends Error {
  constructor(
    readonly scope: string,
    readonly timeoutMs: number,
  ) {
    super(
      `[outbox-drain] PASS TIMEOUT for ${scope}: a drain pass exceeded ${timeoutMs}ms — ` +
        `hung await (keychain unwrap / epoch-key resolution / append) wedging the serialized ` +
        `drain loop (WI-2009 class). Loop un-wedged; next tick re-attempts.`,
    );
    this.name = 'DrainPassTimeoutError';
  }
}

/**
 * WI-3896 (tower outbox-drain wedge — the "papercusp substrate_merge_cursor
 * never establishes" incident): `DRAIN_PASS_TIMEOUT_MS` bounds a whole PASS, but
 * the `SELECT … ORDER BY id LIMIT batch` in `drainOutboxOnce` always re-fetches
 * the SAME earliest-undrained rows first — so when ONE row's epoch-encrypt (or
 * append) genuinely never settles, it is the leading row of EVERY pass, EVERY
 * pass times out at the SAME row, and NOTHING behind it (in this or any later
 * batch) ever gets a chance to drain. The pass-level watchdog un-wedges the
 * LOOP, but not the BACKLOG — it just times out forever on the same poison row.
 *
 * This is a PER-ROW bound + quarantine on top of the pass-level one: each
 * potentially-hanging per-row stage (epoch-encrypt, hypercore-append) races
 * against `ROW_STAGE_TIMEOUT_MS` (well under `DRAIN_PASS_TIMEOUT_MS`, so a
 * genuinely-poison row is caught and named LONG before it could exhaust the
 * whole pass budget). `startOutboxDrain`'s loop counts CONSECUTIVE stage-
 * timeouts for the SAME row id; after `ROW_QUARANTINE_THRESHOLD` in a row, that
 * ONE row is quarantined (added to `quarantinedIds`, checked + skipped BEFORE
 * any potentially-hanging stage on every future pass) so later rows are no
 * longer blocked by it. The row is left undrained ON PURPOSE (never falsely
 * marked `drained_at`) — quarantine is a triage decision, not a silent data
 * drop; a human/agent can root-cause + manually clear it via the runbook.
 *
 * Generous relative to a normal write, even under host CPU saturation, so a
 * transient (load-induced) slow row gets a couple of free retries before being
 * treated as poison — mirrors `MERGE_APPLY_TIMEOUT_MS` in `read-merge.ts`,
 * which bounds the analogous receive-side merge-apply hang the same way.
 */
export const ROW_STAGE_TIMEOUT_MS = 45_000;

/**
 * WI-3896 fanout-follow-up-2 (live incident: PASS TIMEOUT recurring every ~2min
 * post-deploy, 18:03/18:05/18:07, zero quarantine lines — journal shows the
 * *stalling row id advancing* between consecutive 15s stage-stall logs, e.g.
 * 6012522 → 6012523, across DIFFERENT tables, ruling out a single poison row).
 *
 * `fanout()` is NOT a correctness-blocking stage like epoch-encrypt/append —
 * `fanoutOutboxRow` reads through the SEPARATE `getOrgPg()` org pool (not the
 * harness admin pool epoch-encrypt/append use), and its own sibling local-object
 * fan-out path (`fanoutForObject`) already treats a *systemically* slow org-pool
 * query as expected-possible and bounds it at a mere `FANOUT_DEADLINE_MS`
 * (10s default) — reusing `ROW_STAGE_TIMEOUT_MS` (45s, sized for a rare single
 * poison row) here was the gap: when the org pool itself is degraded, EVERY
 * row's fan-out hangs, and at 45s/row only ~2-3 rows fit before
 * `DRAIN_PASS_TIMEOUT_MS` (120s) fires anyway — so the row-level quarantine
 * (which only trips after 3 CONSECUTIVE timeouts on the SAME id) never even
 * gets a chance to engage before the pass-level watchdog re-wedges the loop.
 *
 * A MUCH tighter, separate bound for fan-out specifically — mirroring the
 * sibling path's philosophy that fan-out is best-effort/non-blocking (a
 * timeout here already falls into the existing catch, never blocking
 * `drained_at`) — lets 120s/8s ≈ 15 rows fit even if EVERY one's fan-out hangs,
 * so `drained_at`/merge-cursor progress (the correctness-critical path) keeps
 * moving even while the fan-out side-channel is broadly degraded.
 */
export const FANOUT_ROW_TIMEOUT_MS = 8_000;

/** How many CONSECUTIVE same-row stage timeouts before that row is quarantined
 *  (skipped from then on). Mirrors WI-255's `MAX_APPLY_THROWS` in read-merge.ts. */
export const ROW_QUARANTINE_THRESHOLD = 3;

/** Thrown when a single per-row stage (epoch-encrypt / hypercore-append) exceeds
 *  `ROW_STAGE_TIMEOUT_MS`. Carries the row id so the caller's consecutive-timeout
 *  counter can attribute the episode to the SAME poison row across passes. */
export class RowStageTimeoutError extends Error {
  constructor(
    readonly rowId: string | number,
    readonly stage: string,
    readonly timeoutMs: number,
  ) {
    super(
      `[outbox-drain] ROW STAGE TIMEOUT for row id=${rowId} at stage '${stage}': exceeded ` +
        `${timeoutMs}ms (WI-3896 poison-row class). Quarantined after ${ROW_QUARANTINE_THRESHOLD} ` +
        `consecutive occurrences on this same row.`,
    );
    this.name = 'RowStageTimeoutError';
  }
}

/**
 * Race `p` (a per-row stage — epoch-encrypt or append) against `timeoutMs`; on
 * expiry throw `RowStageTimeoutError(rowId, stage)`. `p` is DETACHED on either
 * path — a late resolution/rejection is swallowed so a slow-but-real write that
 * eventually lands (this row was merely SLOW, not poison) can never surface as
 * an unhandled rejection or double-count; the row itself stays undrained and is
 * simply re-attempted (or, once quarantined, skipped) next pass — same
 * at-least-once argument the pass-level `DrainPassTimeoutError` already relies
 * on. `timeoutMs <= 0` disables the bound (falls back to the pass-level timeout
 * alone, today's pre-WI-3896 behavior).
 */
async function raceRowStage<T>(rowId: string | number, stage: string, p: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RowStageTimeoutError(rowId, stage, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    p.catch(() => {}); // detach the (possibly zombie) write — never an unhandled rejection
  }
}

/** Quarantined row ids already logged per scope (dedupe the skip warning so a
 *  permanently-quarantined row doesn't spam the log every drain pass). Keyed
 *  `${scope}:${id}` so distinct harnesses never collide on a numeric id. */
const loggedQuarantinedRowIds = new Set<string>();

/**
 * EI-13917: is `e` a postgres.js "the client this pass is using was already
 * `.end()`-ed" error? `connection.ts`'s `getOrgPg()`/`getOrgPgApp()` correctly
 * invalidate + rebuild their SHARED client when the discovery-file URL changes
 * (e.g. another local install rewrote `~/.papercusp/embedded-pg.json` — WI-5244)
 * — but this drain loop is handed that client ONCE at `startOutboxDrain` and
 * closes over it for its entire lifetime (the poll timer + LISTEN handler never
 * re-resolve it). So when the shared client gets replaced out from under this
 * closure, every subsequent write on the OLD (now-ended) handle fails with
 * `code: 'CONNECTION_ENDED'` — forever, since nothing here ever re-fetches a
 * fresh client. This is the exact "600x/min CONNECTION_ENDED, no self-recovery"
 * incident this drain was filed on (EI-13917).
 *
 * Mirrors `own-log-fork-guard.ts`'s `isSessionClosedError` shape + the existing
 * CONNECTION_ENDED/CONNECTION_DESTROYED classification in
 * `service-health-events.ts` — same postgres.js error family, same
 * `.code`/message shape.
 */
export function isConnectionEndedError(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === 'CONNECTION_ENDED' || code === 'CONNECTION_DESTROYED') return true;
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg);
}

/**
 * WI-3619 (WI-2009-class per-stage detector): when a drain pass hangs, the
 * PASS TIMEOUT watchdog names the PASS but not the STAGE — the journal says
 * "hung await (keychain unwrap / epoch-key resolution / append)" and the
 * operator is left guessing which. Every await inside a pass is wrapped with
 * `logIfStageStalls` (P-012, fleet-reliability-verification-2026-07-10:
 * generalized out of this module into `./stage-stall-log` so every other
 * federation hop can adopt the same instrumentation without re-deriving it —
 * see that module's doc-comment for the current adopter list). Re-exported
 * here for back-compat with any existing import of `STAGE_STALL_LOG_MS` from
 * this module.
 */
export { STAGE_STALL_LOG_MS, logIfStageStalls };

/** The NOTIFY channel the Stage-1 capture trigger fires on. */
const NOTIFY_CHANNEL = 'substrate_outbox';

/** A captured outbox row, as the local fan-out consumer reads it. */
export interface OutboxFanoutRow {
  id: string | number;
  table_name: string;
  op: 'put' | 'del';
  key: string;
  row: Record<string, unknown> | null;
}

/** The local subscribe→inject fan-out consumer (coordination-substrate Phase 2).
 *  Runs per row on the SAME drain as federation (not a second consumer). */
export type OutboxFanoutFn = (row: OutboxFanoutRow) => Promise<unknown>;

/**
 * The encrypt-on-capture capability for the read-plane re-key (C-001,
 * shared-hive-rekey-2026-06-19). Built at boot from the hive's crypto + epoch-key
 * resolver (owner derives / member unwraps) + localDevice, and THREADED into the
 * drain. The drain calls `encryptOp` for the hive-CONTENT ops it selects
 * (`shouldEncryptOpForRekey`), then stamps the returned `{ epoch }` + sets the
 * encrypted `value` on the op before append. ABSENT ⇒ the re-key is off for this
 * harness and every op federates plaintext (today's behavior, byte-identical).
 */
export interface EpochEncryptCapability {
  /**
   * Encrypt a selected content op's payload under the hive's CURRENT epoch key.
   * Returns `{ epoch, value }` — the epoch to stamp + the json-safe encrypted value
   * to set on `op.value` — or `null` to leave the op plaintext. MAY reject
   * (e.g. `EpochKeyUnavailableError`) when the current epoch key has not yet reached
   * this device; the drain treats that like an append failure (halt + retry) so the
   * op federates once the key arrives — it is never dropped or sent in the clear.
   */
  encryptOp(op: LocalWriteOp): Promise<{ epoch: number; value: unknown } | null>;
}

export interface DrainOptions {
  /** Max rows to drain this pass. Default `DEFAULT_DRAIN_BATCH`. */
  batch?: number;
  /** Clock override (epoch ms) — for the drained_at stamp + GC cutoff. Tests
   *  inject a fixed value; production omits it (Date.now). */
  now?: number;
  /** Local subscribe→inject fan-out, run per row AFTER the federation append and
   *  BEFORE drained_at (at-least-once: a failure re-runs; the insert is
   *  idempotent). Omitted → no fan-out (federation-only, the pre-Phase-2 behavior). */
  fanout?: OutboxFanoutFn;
  /** Re-key encrypt-on-capture capability (C-001). When present, the drain encrypts
   *  the payload of selected hive-CONTENT ops under the current epoch + stamps
   *  `op.epoch` before append. Omitted ⇒ no encryption (plaintext, today's path). */
  epochEncrypt?: EpochEncryptCapability;
  /**
   * WI-40905 lifecycle resolver. Read at the selected row's encryption point,
   * not once before the batch query: a pre-Hive pass may already be in flight
   * when the in-place re-key refresh completes, and that stale pass must not
   * drain a newly-captured post-boundary row with its old "no capability"
   * snapshot. When supplied this takes precedence over `epochEncrypt`.
   */
  resolveEpochEncrypt?: () => EpochEncryptCapability | undefined;
  /** Test seam: override the inline-GC batch size (`OUTBOX_GC_BATCH`). Lets a
   *  test exercise the batched/bounded loop + early-break without seeding 100k+
   *  rows. Production omits it. */
  _gcBatch?: number;
  /** Test seam: override the inline-GC wall-time budget. Production omits it. */
  _gcBudgetMs?: number;
  /** Test seam: monotonic clock for the GC budget. Production uses Date.now. */
  _gcNowMs?: () => number;
  /**
   * WI-3896: row ids to unconditionally SKIP this pass — poison rows the
   * caller's consecutive-stage-timeout counter has quarantined. Checked BEFORE
   * any potentially-hanging stage (epoch-encrypt/append); logged once per row
   * id then left undrained ON PURPOSE (never falsely marked `drained_at`) so a
   * later rows in the SAME batch are unaffected and a human/agent can
   * root-cause + manually clear it via the runbook. Ids are matched as strings.
   */
  quarantinedIds?: ReadonlySet<string>;
  /** WI-3896: per-row stage timeout (ms) for epoch-encrypt/append — bounds ONE
   *  row's hang so it can't wedge the whole pass for the full pass-level
   *  timeout. Default `ROW_STAGE_TIMEOUT_MS`; `<= 0` disables the bound (today's
   *  pre-WI-3896 behavior — only the pass-level watchdog applies). */
  rowTimeoutMs?: number;
  /** WI-3896 fanout-follow-up-2: SEPARATE, much tighter per-row timeout (ms) for
   *  fan-out specifically — it is best-effort/non-blocking (unlike
   *  epoch-encrypt/append, a timeout here is already caught + never blocks
   *  `drained_at`), so it must not eat into the same 45s-per-row budget those
   *  correctness-blocking stages need; a systemically-degraded fan-out path
   *  would otherwise still exhaust the pass-level watchdog after only ~2-3 rows.
   *  Default `FANOUT_ROW_TIMEOUT_MS`; `<= 0` disables the bound. */
  fanoutTimeoutMs?: number;
  /** Optional local diagnostic sink for per-row attempt and named-hop events.
   * The sink is observational: it is detached from the business path and any
   * throw/rejection is swallowed by the stage-attempt helper. */
  onDiagnosticEvent?: (event: StageDiagnosticEvent) => void | Promise<void>;
  /** Disable local per-row diagnostic attempts even when a sink is supplied. */
  diagnosticsEnabled?: boolean;
}

interface OutboxDbRow {
  id: string | number;
  table_name: string;
  op: 'put' | 'del';
  key: string;
  row: Record<string, unknown> | null;
  ts: string | number;
  /** D-001: the op's HLC ordering key (the PG clock of record), threaded onto the
   *  wire op so the remote peer's projection materialises an identical fed_hlc.
   *  NULL on a pre-314 outbox row / an append-only table → stampOpHlc fallback. */
  op_hlc: string | null;
}

/**
 * Drain one batch of undrained outbox rows for this handle's (workspace,
 * harness). Returns the number of rows drained.
 *
 * AT-LEAST-ONCE: marks `drained_at` ONLY after `append` resolves; if `append`
 * throws, the error propagates (the row + later rows stay undrained) so the
 * caller's retry re-attempts. Also performs the inline 24h GC of long-drained
 * rows before reading the batch.
 */
export async function drainOutboxOnce(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: DrainOptions = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const batch = opts.batch ?? DEFAULT_DRAIN_BATCH;
  // WI-3619: the scope string for the per-stage stall detector lines.
  const scope = `${handle.workspaceId}::${handle.harnessSlug}`;

  // Inline 24h GC — keep the table small. SCOPED to this handle's (workspace,
  // harness): every booted harness runs its own drain loop, so an unscoped GC
  // means N concurrent global DELETEs fighting over the same rows + locks
  // (root cause of EI-125 alongside the unbounded DELETE — this produced a
  // 102 GB substrate_outbox, 2026-06-08). Scoping also rides the
  // (workspace_id, harness_slug, drained_at, id) drain index. BOUNDED +
  // BATCHED: each capped batch is its own committed statement so progress
  // survives the memory-watchdog recycle (~every 12 min); the drain loop
  // re-runs until the backlog clears.
  // Best-effort: a GC failure must not block the drain, so swallow it.
  const gcBatch = opts._gcBatch ?? OUTBOX_GC_BATCH;
  const gcBudgetMs = opts._gcBudgetMs ?? OUTBOX_GC_BUDGET_MS;
  const gcNowMs = opts._gcNowMs ?? Date.now;
  const gcStartedAtMs = gcNowMs();
  const releaseInlineGc = tryAcquireInlineGc();
  if (releaseInlineGc) {
    try {
      for (let i = 0; ; i++) {
        if (gcNowMs() - gcStartedAtMs >= gcBudgetMs) break;
        const gc = await logIfStageStalls(
          scope,
          `gc-delete (batch ${i})`,
          pg`
          WITH del AS (
            SELECT id
              FROM harness_shared.substrate_outbox
             WHERE workspace_id = ${handle.workspaceId}
               AND harness_slug = ${handle.harnessSlug}
               AND drained_at IS NOT NULL
               AND drained_at < ${now - OUTBOX_GC_AGE_MS}
             ORDER BY id
             LIMIT ${gcBatch}
             FOR UPDATE SKIP LOCKED
          )
          DELETE FROM harness_shared.substrate_outbox o
           USING del
           WHERE o.id = del.id`,
        );
        // Fewer than a full batch removed → backlog cleared for now.
        if ((gc.count ?? 0) < gcBatch) break;
      }
    } catch {
      // GC is non-fatal observability; continue to the actual drain.
    } finally {
      releaseInlineGc();
    }
  }

  // EI-22138988923269437 (priority lane): two independently-bounded scans —
  // `priority` (the small OUTBOX_PRIORITY_TABLES set) and `rest` (every other
  // table, unchanged flat FIFO, INCLUDING a forward-compat table_name this
  // build's CDC_CAPTURED_TABLES registry doesn't know about yet — same
  // UnknownOutboxTableError skip-with-log path as before) — unioned, then
  // ORDER BY priority-flag DESC, id ASC LIMIT batch. Because priority rows are
  // fetched by their OWN query (never competing with `rest`'s id ordering to
  // even be CONSIDERED), they are included in the final LIMIT regardless of
  // how old a bulk backfill sitting in `rest` is — that alone fixes the filed
  // defect (a bulk backfill head-of-line-blocking coordination traffic).
  //
  // Deliberately NOT per-non-priority-table-fair: an earlier version of this
  // fix additionally capped EVERY registered CDC table to an equal share of
  // `batch` (dividing by the full static table count, ~20), which regressed
  // ordinary single-table throughput ~20x (caught by the pre-existing
  // "respects the batch limit" test: batch=2 against one busy table now drained
  // only 1/pass). That broader non-priority-vs-non-priority fairness was never
  // part of the filed defect — only coordination-vs-backfill was — so it was
  // removed rather than tuned; `rest` keeps the ORIGINAL flat semantics.
  //
  // `priority`'s own `LIMIT batch` needs mig 1095's
  // (workspace_id, harness_slug, table_name, drained_at, id) index to stay a
  // cheap per-table-name-scoped range scan — without it, filtering to 4
  // table_names while ordering by the GLOBAL id (ascending) would degrade to
  // an O(backlog) scan past every smaller-id non-priority row first (the
  // exact cost this fix exists to avoid).
  const rows = await logIfStageStalls(
    scope,
    'select-undrained-batch',
    pg<OutboxDbRow[]>`
    WITH priority AS (
      SELECT id, table_name, op, key, row, ts,
             -- D-001: read op_hlc RESILIENTLY via to_jsonb so an outbox
             -- provisioned before migration 314 degrades to NULL
             -- (stampOpHlc fallback) instead of crashing.
             (to_jsonb(o.*) ->> 'op_hlc') AS op_hlc
        FROM harness_shared.substrate_outbox o
       WHERE o.workspace_id = ${handle.workspaceId}
         AND o.harness_slug = ${handle.harnessSlug}
         AND o.table_name = ANY(${OUTBOX_PRIORITY_TABLE_LIST}::text[])
         AND o.drained_at IS NULL
         -- mig 645 (WI-3896 follow-up): a PERSISTED-quarantined poison row is
         -- excluded at the SQL level too, read RESILIENTLY via to_jsonb (same
         -- pattern as op_hlc above) so a pre-645 outbox degrades to "column
         -- absent -> NULL -> not excluded" instead of crashing.
         AND (to_jsonb(o.*) ->> 'quarantined_at') IS NULL
       ORDER BY o.id
       LIMIT ${batch}
    ),
    rest AS (
      SELECT id, table_name, op, key, row, ts,
             (to_jsonb(o.*) ->> 'op_hlc') AS op_hlc
        FROM harness_shared.substrate_outbox o
       WHERE o.workspace_id = ${handle.workspaceId}
         AND o.harness_slug = ${handle.harnessSlug}
         AND o.table_name != ALL(${OUTBOX_PRIORITY_TABLE_LIST}::text[])
         AND o.drained_at IS NULL
         AND (to_jsonb(o.*) ->> 'quarantined_at') IS NULL
       ORDER BY o.id
       LIMIT ${batch}
    ),
    -- Postgres forbids an arbitrary expression in the ORDER BY of a bare
    -- UNION/UNION ALL (only output column names/ordinals are allowed there —
    -- "invalid UNION/INTERSECT/EXCEPT ORDER BY clause"). Wrap the union in its
    -- own CTE so the priority-lane ORDER BY below applies to a plain SELECT
    -- over it, where a computed expression is fine.
    combined AS (
      SELECT * FROM priority
      UNION ALL
      SELECT * FROM rest
    )
    SELECT * FROM combined
    ORDER BY (table_name = ANY(${OUTBOX_PRIORITY_TABLE_LIST}::text[])) DESC, id
    LIMIT ${batch}`,
  );

  const rowTimeoutMs = opts.rowTimeoutMs ?? ROW_STAGE_TIMEOUT_MS;
  const fanoutTimeoutMs = opts.fanoutTimeoutMs ?? FANOUT_ROW_TIMEOUT_MS;
  let drained = 0;
  for (const r of rows) {
    // WI-3896: a row the caller's consecutive-stage-timeout counter has already
    // quarantined — skip it BEFORE any potentially-hanging stage so later rows
    // in this same batch are never blocked by it. Left undrained ON PURPOSE.
    if (opts.quarantinedIds?.has(String(r.id))) {
      const logKey = `${scope}:${r.id}`;
      if (!loggedQuarantinedRowIds.has(logKey)) {
        loggedQuarantinedRowIds.add(logKey);

        console.warn(
          `[outbox-drain] skipping QUARANTINED poison row id=${r.id} table=${r.table_name} for ` +
            `${scope} (WI-3896: repeated stage timeouts) — left undrained on purpose; a human/agent ` +
            `must root-cause + manually clear it via the runbook. Later rows are unaffected.`,
        );
      }
      continue;
    }
    let op: ReturnType<typeof outboxRowToLocalWriteOp>;
    try {
      op = outboxRowToLocalWriteOp({
        table_name: r.table_name,
        op: r.op,
        key: r.key,
        ts: typeof r.ts === 'number' ? r.ts : Number(r.ts),
        row: r.row,
        // D-001: the PG-clock HLC stamped at capture → op.hlc (stampOpHlc
        // preserves a preset hlc). NULL → stampOpHlc generates a fallback.
        op_hlc: r.op_hlc ?? undefined,
      } satisfies OutboxRow);
    } catch (e) {
      // Forward-compat: a NEWER capture trigger may enqueue a table this (older,
      // co-located) build can't map yet. SKIP that row — leave it undrained so a
      // newer build federates it — and CONTINUE to the next row, rather than
      // halting the whole drain (which would stop ALL federation for this scope).
      // Any OTHER error is a genuine fault → rethrow (preserve the at-least-once
      // halt-and-retry contract). Log each unknown table once to avoid per-pass spam.
      if (e instanceof UnknownOutboxTableError) {
        if (!loggedUnknownTables.has(e.tableName)) {
          loggedUnknownTables.add(e.tableName);

          console.warn(
            `[outbox-drain] skipping outbox rows for unmapped table '${e.tableName}' ` +
              `(forward-compat: this build has no projection for it; a newer build will ` +
              `federate them). Rows stay undrained.`,
          );
        }
        continue;
      }
      throw e;
    }

    // P-002: each selected outbox row receives a fresh attempt identity. The
    // identity is local-only and never enters the LocalWriteOp, encrypted
    // envelope, AAD, or replicated wire data. Retries therefore cannot close
    // or relabel an earlier attempt, while all named dependency hops below can
    // share the same row-scoped context.
    const attempt = createStageAttempt({
      rowId: r.id,
      onEvent: opts.onDiagnosticEvent,
      enabled: opts.diagnosticsEnabled,
    });

    try {
      // P-015 (federated-scout-gym D-006): EGRESS secrets-guard. A shareable fact
      // (body) / federatable elite (rationale) carries agent-authored free text that
      // could embed a credential — redact secret-bearing lines from the WIRE copy
      // HERE, before epoch-encryption + append, so a secret never leaves the hive.
      // Keeps the local PG row intact (only op.value is scrubbed). Fail-soft:
      // redactContentOpValueForEgress returns the value unchanged on any fault /
      // non-content tag / no-secret, so the drain can never break on redaction.
      if (op.type === 'put' && op.value !== undefined) {
        const guarded = redactContentOpValueForEgress(op.table, op.value);
        if (guarded.redacted) {
          op = { ...op, value: guarded.value };

          console.warn(
            `[outbox-drain] egress secrets-guard redacted a secret-bearing '${op.table}' op before federation`,
          );
        }
      }

      // Re-key encrypt-on-capture (C-001, shared-hive-rekey-2026-06-19): when the
      // re-key is active for this harness (capability threaded) AND this is a
      // hive-CONTENT put with a payload (admission/key/policy ops + dels stay
      // plaintext — shouldEncryptOpForRekey), encrypt the payload under the current
      // epoch + stamp op.epoch BEFORE append. A null result leaves the op plaintext;
      // a rejection (the epoch key is not yet on this device) propagates like an
      // append failure (halt + retry) so the op federates once the key arrives — it
      // is never dropped or sent in the clear.
      const epochEncrypt = opts.resolveEpochEncrypt?.() ?? opts.epochEncrypt;
      if (epochEncrypt && op.type === 'put' && op.value !== undefined && shouldEncryptOpForRekey(op.table)) {
        const encryptStage = `epoch-encrypt (row id=${r.id} table=${r.table_name})`;
        const enc = await raceRowStage(
          r.id,
          encryptStage,
          logIfStageStalls(
            scope,
            encryptStage,
            withStageAttempt(attempt, () => epochEncrypt.encryptOp(op)),
            STAGE_STALL_LOG_MS,
            {
              attempt,
              stage: 'epoch-encrypt',
            },
          ),
          rowTimeoutMs,
        );
        if (enc) op = { ...op, value: enc.value, epoch: enc.epoch };
      }

      // AT-LEAST-ONCE: append FIRST. If this throws we stop here, leaving this
      // row + all later rows undrained for the next pass to re-attempt.
      // WI-3896: bounded per-row (`rowTimeoutMs`) on top of `logIfStageStalls`'s
      // observability-only stall log, so ONE genuinely-hung append can't wedge
      // this pass for the full pass-level DRAIN_PASS_TIMEOUT_MS — see this row's
      // consecutive-timeout handling in `startOutboxDrain`'s `drainSafely`.
      const appendStage = `hypercore-append (row id=${r.id} table=${r.table_name})`;
      await raceRowStage(
        r.id,
        appendStage,
        logIfStageStalls(
          scope,
          appendStage,
          withStageAttempt(attempt, () => handle.append(op)),
          STAGE_STALL_LOG_MS,
          {
            attempt,
            stage: 'hypercore-append',
          },
        ),
        rowTimeoutMs,
      );

      // P-007: record this LOCAL plan write so a racing REMOTE plan op for the same
      // plan_slug is detected as a clobber (harness-plans.ts writeToPg fires
      // observeMergedOp on remote apply). Keyed by the device's own log key — a
      // remote op's receiver-stamped source key never equals it, so it never
      // self-clobbers. Plans only (see PLAN_TABLE_TAG). Best-effort: an in-memory
      // tracker write must never break federation.
      if (op.table === PLAN_TABLE_TAG) {
        try {
          recordLocalWrite({ table: op.table, hbKey: op.hbKey, ts: op.ts, pubkey: handle.ownLog.keyHex });
        } catch {
          // tracker is pure in-process bookkeeping; ignore.
        }
      }

      // Local subscribe→inject fan-out on the SAME row (Phase 2). BEST-EFFORT and
      // federation-safe: a fan-out failure is logged but must NOT stall federation
      // (the critical at-least-once path) or block this row's drained_at — so it is
      // caught here. The genuine double-process case (fan-out succeeds, then the
      // drained_at write fails → row reprocessed) is deduped by the idempotent
      // insert (deterministic msg_id + ON CONFLICT, mig 126). Non-subscribable
      // tables are a no-op inside the fan-out.
      if (opts.fanout) {
        try {
          // WI-3896 follow-up: fan-out was previously bounded ONLY by logIfStageStalls
          // (observability-only — logs at 15s but never times out), so a genuinely-hung
          // fanout() blocked this row FOREVER, wedging the whole pass until the
          // pass-level DRAIN_PASS_TIMEOUT_MS (120s) watchdog fired.
          //
          // WI-3896 fanout-follow-up-2: the FIRST fix (racing against the shared
          // 45s `rowTimeoutMs`) was insufficient — live post-deploy evidence showed
          // the PASS TIMEOUT still recurring every ~2min with ZERO quarantine lines,
          // because the stalling row id kept ADVANCING (6012522 → 6012523 → …,
          // across different tables) — this is a systemically-degraded fan-out path
          // (getOrgPg()'s pool, separate from the harness admin pool epoch-encrypt/
          // append use), not one poison row. At 45s/row only ~2-3 rows fit before the
          // 120s pass watchdog fires anyway, so the per-row quarantine (which needs 3
          // CONSECUTIVE timeouts on the SAME id) never gets a chance to engage. Using
          // the much tighter, SEPARATE `fanoutTimeoutMs` (default 8s — fan-out is
          // best-effort/non-blocking, unlike epoch-encrypt/append) lets ~15 rows fit
          // per pass even if every one's fan-out hangs, so `drained_at`/merge-cursor
          // progress keeps moving while fan-out itself degrades independently.
          const fanoutStage = `fanout (row id=${r.id} table=${r.table_name})`;
          await raceRowStage(
            r.id,
            fanoutStage,
            logIfStageStalls(
              scope,
              fanoutStage,
              opts.fanout({ id: r.id, table_name: r.table_name, op: r.op, key: r.key, row: r.row }),
            ),
            fanoutTimeoutMs,
          );
        } catch (e) {
          const schemaSig = fanoutSchemaMismatchSignature(r.table_name, e);
          if (schemaSig) {
            if (!loggedFanoutSchemaMismatches.has(schemaSig)) {
              loggedFanoutSchemaMismatches.add(schemaSig);
              console.error(
                `[outbox-drain] FAN-OUT SCHEMA MISMATCH for table '${r.table_name}': ${schemaSig} — ` +
                  `the fan-out query references a column/table this DB doesn't have (a migration is ` +
                  `missing or hasn't run here, or code shipped ahead of its migration). This will recur ` +
                  `for EVERY row of this table on EVERY drain tick until fixed — logged ONCE per ` +
                  `signature to avoid log-flood; federation is unaffected (fan-out is local-only ` +
                  `best-effort). Root-cause via the migration allocator / schema drift check, not a retry.`,
              );
            }
          } else {
            console.error(
              `[outbox-drain] fan-out failed for ${r.table_name} key=${r.key} (federation unaffected):`,
              e instanceof Error ? e.message : String(e),
            );
          }
        }
      }

      // Mark drained only after the append + fan-out resolved. WI-2136: also stamp
      // WHICH own-log key this row was appended into, so the orphan-tail recurrence
      // guard can later detect a row drained onto a PRIOR-era log that no longer
      // matches the live process's log (the WI-2105 non-persistent-keypair class).
      // Optional-chained: a handle without an ownLog (a capability-seam/test handle,
      // or a pre-log boot state) must not crash the drain — NULL is an explicitly
      // supported value here (mig 495: 'NULL = undrained or drained pre-migration'),
      // and the recurrence guard treats NULL as unknowable, never as stranded.
      await logIfStageStalls(
        scope,
        `mark-drained (row id=${r.id})`,
        pg`
        UPDATE harness_shared.substrate_outbox
           SET drained_at = ${now},
               drained_log_key = ${handle.ownLog?.keyHex ?? null}
         WHERE id = ${r.id}`,
        STAGE_STALL_LOG_MS,
        { attempt, stage: 'mark-drained' },
      );
      attempt.finish('fulfilled');
      drained += 1;
    } catch (error) {
      attempt.finish(error instanceof RowStageTimeoutError ? 'abandoned' : 'rejected');
      throw error;
    }
  }

  return drained;
}

export interface StartDrainOptions {
  /** Poll-fallback cadence (ms). Default `DEFAULT_POLL_MS`. Set 0 to disable
   *  the timer (tests that only want the LISTEN/initial paths). */
  pollMs?: number;
  /** Drain batch size per pass. Default `DEFAULT_DRAIN_BATCH`. */
  batch?: number;
  /** Local subscribe→inject fan-out consumer, run per row (Phase 2). */
  fanout?: OutboxFanoutFn;
  /** Optional local diagnostic sink for per-row attempt and named-hop events. */
  onDiagnosticEvent?: (event: StageDiagnosticEvent) => void | Promise<void>;
  /** Disable local per-row diagnostic attempts even when a sink is supplied. */
  diagnosticsEnabled?: boolean;
  /** Re-key encrypt-on-capture capability (C-001) — threaded to each drain pass. */
  epochEncrypt?: EpochEncryptCapability;
  /**
   * WI-40905: resolve the re-key encrypt-on-capture capability at each selected
   * row's encryption point instead of snapshotting boot-time state forever. A harness
   * can boot + start its drain while still private, then become a Hive
   * home/member via an in-place re-key. In that lifecycle the boot-time
   * capability is absent, but the SAME drain must begin encrypting after the
   * re-key without starting a second LISTEN/poll loop.
   *
   * When supplied this takes precedence over `epochEncrypt`. The resolver is
   * synchronous on purpose: the lifecycle hook performs the async dependency
   * rebuild once, then atomically swaps the capability this getter returns.
   * Per-row resolution closes the in-flight-pass race: a pass that began before
   * the refresh cannot later read + plaintext-drain a row captured after it.
   */
  resolveEpochEncrypt?: () => EpochEncryptCapability | undefined;
  /**
   * P-008 (shared-hive-cross-machine-scale-10k): subscribe to the outbox NOTIFY
   * channel through a SHARED connection instead of this drain's own `pg.listen`.
   *
   * WHY: `pg.listen` reserves a dedicated PG backend per call, and this drain is
   * started ONCE PER HARNESS — so N booted harnesses held N dedicated connections
   * all subscribed to the SAME global `substrate_outbox` channel, each discarding
   * the other N-1 harnesses' payloads. That is a hard connection-count wall at the
   * 10k-hive scale this plan targets, and pure waste: the payload is already
   * `ws::slug`-addressed, so one connection can fan out in-process.
   *
   * Pass {@link hubListen} (see `pg-listen-hub.ts`) to collapse every harness onto
   * ONE backend — postgres-js multiplexes multiple `.listen()` calls on a single
   * `sql` instance, and the hub ref-counts so the LAST unsubscribe closes it.
   *
   * OMITTED ⇒ byte-identical legacy behavior (this drain's own `pg.listen`). The
   * default is deliberately NOT the hub: the hub connects to `getHarnessAdminUrl()`,
   * so a caller that passes a DIFFERENT `pg` (an integration test's containerised
   * database) must keep listening on its own connection or it would silently
   * subscribe to the wrong database. The production seam (`wire-outbox.ts`) opts in.
   *
   * Contract: resolve to an unsubscribe fn; it is called once on drain teardown.
   */
  listen?: (channel: string, cb: (payload: string) => void) => Promise<() => void>;
  /** Test seam: override the per-pass watchdog timeout (`DRAIN_PASS_TIMEOUT_MS`).
   *  0 disables the watchdog. Production omits it. */
  _passTimeoutMs?: number;
  /** Test seam: override the no-forward-progress backlog-stall window
   *  (`DRAIN_BACKLOG_STALL_MS`). 0 disables the backlog detector. Production omits it. */
  _backlogStallMs?: number;
  /** Test seam (WI-5147): override the backlog-AGE threshold
   *  (`DRAIN_BACKLOG_AGE_STALL_MS`). `<= 0` disables the age leg (size can still
   *  fire alone). Production omits it. */
  _backlogAgeStallMs?: number;
  /** Test seam (WI-5147): override the backlog-SIZE threshold
   *  (`DRAIN_BACKLOG_SIZE_STALL_THRESHOLD`). `<= 0` disables the size leg (age can
   *  still fire alone). Production omits it. */
  _backlogSizeStallThreshold?: number;
  /** Test seam (WI-5147): override the age/size probe throttle
   *  (`DRAIN_BACKLOG_AGE_CHECK_INTERVAL_MS`). Production omits it. */
  _backlogAgeCheckIntervalMs?: number;
  /** Test seam (WI-2136): override the orphan-tail lookback window
   *  (`DRAIN_ORPHAN_LOOKBACK_MS`). Production omits it. */
  _orphanLookbackMs?: number;
  /** Test seam (WI-2136): override the orphan-tail check throttle
   *  (`DRAIN_ORPHAN_CHECK_INTERVAL_MS`). A NEGATIVE value disables the detector.
   *  Production omits it. */
  _orphanCheckIntervalMs?: number;
  /** WI-3896: override the per-row stage timeout (`ROW_STAGE_TIMEOUT_MS`) for
   *  epoch-encrypt/append. `<= 0` disables the per-row bound (only the
   *  pass-level watchdog applies — today's pre-WI-3896 behavior). Production
   *  omits it. */
  _rowTimeoutMs?: number;
  /** WI-3896 fanout-follow-up-2: override the SEPARATE fan-out-only timeout
   *  (`FANOUT_ROW_TIMEOUT_MS`). `<= 0` disables the fan-out bound. Production
   *  omits it. */
  _fanoutTimeoutMs?: number;
  /** WI-3896: override how many CONSECUTIVE same-row stage timeouts before that
   *  row is quarantined (`ROW_QUARANTINE_THRESHOLD`). Production omits it. */
  _rowQuarantineThreshold?: number;
  /**
   * WI-3684 send-side twin: fired when a drain pass fails with a Hypercore
   * `SESSION_CLOSED` error (own-log-fork-guard's `isSessionClosedError`) — the
   * own-log session is PERMANENTLY dead (Hypercore never recovers a closed
   * session on the same handle), so this drain SELF-STOPS instead of
   * blind-retrying the poll every `pollMs` forever. The caller (wire-outbox.ts
   * → boot-all.ts's `ensureSendSideWired`) uses this to un-mark the harness as
   * "send-side wired" so the NEXT boot-all reconcile pass re-wires a fresh
   * drain against whatever handle is current then — mirroring the receive
   * side's repair-on-detect posture (boot.ts's `drainRepairQueue`), which
   * likewise reacts to a dead session instead of retrying it. Best-effort:
   * called AFTER this drain has already stopped itself, so a throwing/slow
   * callback can't wedge the drain loop.
   *
   * EI-13917: ALSO fired on a `CONNECTION_ENDED` postgres.js error
   * (`isConnectionEndedError`, this module) — the SAME "permanently dead
   * handle, self-stop + re-wire fresh" posture, just for a killed PG client
   * instead of a killed Hypercore session (e.g. connection.ts invalidating +
   * rebuilding the shared client after a discovery-file URL change, while this
   * drain's closure still held the old, now-ended one).
   */
  onSessionClosed?: () => void;
  /** Test seam: intercept ALL detector escalations (default = durable EI via
   *  `fileReplicationStallEi`). Receives the human detail + the episode `kind`
   *  ('drain_stalled' hung-pass | 'drain_backlog_stalled' no-progress |
   *  'drain_backlog_aged' pathologically-slow-but-progressing | 'drain_orphan_tail'
   *  prior-era log | 'drain_row_quarantined' poison row). Production omits it. */
  _onStallEpisode?: (
    detail: string,
    kind?:
      | 'drain_stalled'
      | 'drain_backlog_stalled'
      | 'drain_backlog_aged'
      | 'drain_orphan_tail'
      | 'drain_row_quarantined',
  ) => void;
  /** WI-6997 test seam: intercept ALL detector RECOVERIES (default = auto-resolve
   *  the durable EI via `resolveReplicationStallEi`). The symmetric counterpart to
   *  `_onStallEpisode` — before WI-6997 only escalation had a seam, which is part of
   *  why the missing resolve leg went unnoticed: no test could observe a recovery
   *  that never called anything. Production omits it. */
  _onStallRecovery?: (detail: string, kind?: 'drain_stalled' | 'drain_backlog_stalled' | 'drain_backlog_aged') => void;
}

export interface OutboxDrainHandle {
  /** Stop the loop: clear the poll timer + close the LISTEN connection.
   *  Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start the per-harness drain loop:
 *   - an immediate catch-up drain (in case the process was down with a backlog);
 *   - a `LISTEN substrate_outbox` that drains when a NOTIFY's payload matches
 *     this harness's `${workspaceId}::${harnessSlug}`;
 *   - a bounded poll-fallback timer (liveness if a NOTIFY is missed).
 *
 * Resilient: a drain error is logged, not fatal — the next NOTIFY/poll retries
 * (the undrained rows are still in the outbox).
 *
 * Returns a handle whose `stop()` clears the timer + closes the LISTEN
 * connection.
 */
export function startOutboxDrain(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: StartDrainOptions = {},
): OutboxDrainHandle {
  const pollMs = Number.isFinite(opts.pollMs as number) ? (opts.pollMs as number) : DEFAULT_POLL_MS;
  const batch = opts.batch;
  const fanout = opts.fanout;
  const resolveEpochEncrypt = opts.resolveEpochEncrypt ?? (() => opts.epochEncrypt);
  const wantPayload = `${handle.workspaceId}::${handle.harnessSlug}`;

  let stopped = false;
  // A stopped handle must leave the process-wide queue immediately. Once an
  // admitted pass starts, its existing stop/error semantics remain unchanged.
  const drainAdmissionAbort = new AbortController();
  // Serialize drains so a NOTIFY + poll + initial pass can't overlap (a half-
  // applied batch racing another). A pending drain is coalesced (run-again flag).
  let draining = false;
  let runAgain = false;

  // Declared here (assigned once started, below) so `stopInternal` — called
  // both from the public `stop()` AND from the SESSION_CLOSED self-stop path
  // inside `drainSafely`'s catch — can release them from one place.
  let pollTimer: ReturnType<typeof managedSetInterval> | null = null;
  let listenReq: ReturnType<typeof pg.listen> | undefined;
  // P-008: set instead of `listenReq` when `opts.listen` (the shared hub) is used.
  // Resolves to the hub's ref-counted unsubscribe — releasing OUR subscription only;
  // the shared backend closes when the LAST harness detaches.
  let sharedUnsubscribe: Promise<() => void> | undefined;

  /** Idempotent: clears the poll timer + releases the LISTEN subscription. */
  async function stopInternal(): Promise<void> {
    if (stopped) return;
    stopped = true;
    drainAdmissionAbort.abort();
    if (pollTimer) {
      try {
        pollTimer.stop();
      } catch {
        // no-op
      }
    }
    try {
      if (sharedUnsubscribe) {
        // Shared-hub path: drop OUR subscription. Never closes a peer harness's
        // listener — the hub ref-counts and only the last detach ends the backend.
        (await sharedUnsubscribe)();
      } else if (listenReq) {
        const req = await listenReq;
        await req.unlisten();
      }
    } catch {
      // best-effort: the connection may already be closing
    }
  }

  const passTimeoutMs = opts._passTimeoutMs ?? DRAIN_PASS_TIMEOUT_MS;
  const backlogStallMs = opts._backlogStallMs ?? DRAIN_BACKLOG_STALL_MS;
  const orphanLookbackMs = opts._orphanLookbackMs ?? DRAIN_ORPHAN_LOOKBACK_MS;
  const orphanCheckIntervalMs = opts._orphanCheckIntervalMs ?? DRAIN_ORPHAN_CHECK_INTERVAL_MS;

  // WI-2009 leg-3 backlog-stall detector state. `lastProgressAt` is the last
  // time ANY pass drained ≥1 row (init: loop start). `backlogStallEscalated`
  // edge-triggers the durable EI ONCE per no-progress episode; a resumed drain
  // (a pass that drains a row) clears it so a later re-stall re-escalates.
  let lastProgressAt = Date.now();
  let backlogStallEscalated = false;

  // WI-6997: the hung-pass (`drain_stalled`) escalation had NO latch — it fired
  // per timeout and, unlike the two backlog detectors, had no state saying "we
  // are currently escalated". That is why it also had no recovery edge to hang a
  // resolve on. Latch it like the others: set on escalate, cleared on the first
  // pass that drains a row, and THAT transition is the recovery edge.
  let drainHangEscalated = false;

  // WI-5147 backlog-age/size detector state (progress-INDEPENDENT — see
  // `DRAIN_BACKLOG_AGE_STALL_MS`'s doc-comment). `lastBacklogAgeCheckAt` throttles
  // the probe; `backlogAgeEscalated` edge-triggers ONCE per episode and clears the
  // moment BOTH thresholds recover, so a later re-breach re-escalates.
  const backlogAgeStallMs = opts._backlogAgeStallMs ?? DRAIN_BACKLOG_AGE_STALL_MS;
  const backlogSizeStallThreshold = opts._backlogSizeStallThreshold ?? DRAIN_BACKLOG_SIZE_STALL_THRESHOLD;
  const backlogAgeCheckIntervalMs = opts._backlogAgeCheckIntervalMs ?? DRAIN_BACKLOG_AGE_CHECK_INTERVAL_MS;
  let lastBacklogAgeCheckAt = 0;
  let backlogAgeEscalated = false;
  // EI-209736: the escalation latch is process-local, while the EI it opens is
  // durable. A restarted/replaced drain can therefore observe a healthy backlog
  // with a fresh `false` latch even though the prior instance's exact-title EI is
  // still open. Reconcile ONCE on this instance's first healthy probe; subsequent
  // healthy polls stay free of resolve queries, while a later real breach still
  // gets its normal escalated->recovered edge below.
  let backlogAgeHealthyStartReconciled = false;

  // WI-2136 orphan-tail detector state. `escalatedOrphanKeys` latches each dead
  // prior-era log key so it pages ONCE per process; `lastOrphanCheckAt` throttles
  // the check to `orphanCheckIntervalMs` (0 ⇒ never run yet → run on the first pass,
  // i.e. at boot — the moment a restart's stranded tail becomes detectable).
  const escalatedOrphanKeys = new Set<string>();
  let lastOrphanCheckAt = 0;

  // WI-3896 poison-row quarantine state. `rowTimeoutCounts` counts CONSECUTIVE
  // stage timeouts per row id (a different row's timeout doesn't touch another
  // row's count); once a row crosses `rowQuarantineThreshold` it moves into
  // `quarantinedIds` (permanent for this process — threaded into every future
  // `drainOutboxOnce` call so that row is skipped before any hanging stage).
  const rowTimeoutCounts = new Map<string, number>();
  const quarantinedIds = new Set<string>();
  const rowTimeoutMs = opts._rowTimeoutMs ?? ROW_STAGE_TIMEOUT_MS;
  const fanoutTimeoutMs = opts._fanoutTimeoutMs ?? FANOUT_ROW_TIMEOUT_MS;
  const rowQuarantineThreshold = opts._rowQuarantineThreshold ?? ROW_QUARANTINE_THRESHOLD;

  /** WI-2009 stall escalation for BOTH detectors: loud console line (grep-able,
   *  mirrors the WI-1840 detector pattern) + durable EI (dedup'd per
   *  (harness, log, kind) while one stays open). Best-effort — never throws into
   *  the drain loop. */
  const escalateStall = (
    kind:
      | 'drain_stalled'
      | 'drain_backlog_stalled'
      | 'drain_backlog_aged'
      | 'drain_orphan_tail'
      | 'drain_row_quarantined',
    detail: string,
    stalledForMs: number,
    // WI-2136: the log key the EI dedups on. Defaults to the LIVE own-log key
    // (the harness's stable identifier for the drain-stall kinds); the orphan-tail
    // kind overrides it with the DEAD prior-era key so distinct dead eras page
    // separately and each dedups against its own open EI.
    logKeyHex: string = handle.ownLog.keyHex,
  ): void => {
    if (opts._onStallEpisode) {
      opts._onStallEpisode(detail, kind);
      return;
    }
    void trackDetached(import('./replication-stall-ei')).then(
      (m) =>
        m.fileReplicationStallEi({
          workspaceId: handle.workspaceId,
          harnessSlug: handle.harnessSlug,
          logKeyHex,
          kind,
          stalledForMs,
          detail,
        }),
      () => {},
    );
  };

  /**
   * WI-6997: the RECOVERY counterpart of `escalateStall` — the leg this module
   * never had. `replication-liveness.ts` has always auto-resolved its own three
   * kinds on recovery (`reportRecovery` -> `resolveReplicationStallEi`), but the
   * five drain_* kinds filed HERE had no such path: each detector cleared its
   * in-process latch on recovery and left the durable EI open forever. Measured
   * 2026-08-02: `terminal_owner = 'system:replication-liveness'` (the auto-resolve
   * owner) appears on 33 EIs across the three wired kinds and on ZERO drain_* EIs,
   * while ~102 drain_* EIs were closed BY HAND (one agent closed 51). This is the
   * EI-4643 class already fixed once for `connected_never_replicated`, left
   * unfixed in this sibling module.
   *
   * Call this on the escalated->recovered transition or once when a fresh drain's
   * first backlog probe is healthy. Never call it on every healthy pass:
   * `resolveReplicationStallEi` no-ops when no EI is open, but it is a PG round-
   * trip, and the drain's healthy path runs every 5s poll. The one boot-time
   * reconciliation closes an EI whose durable state outlived this local latch.
   *
   * Deliberately NOT wired for `drain_orphan_tail` (a dead prior-era log — the era
   * stays dead, there is no recovery) or `drain_row_quarantined` (a poison row is
   * permanently skipped by design). Inventing a recovery edge for those would file
   * a false all-clear; they remain correctly manual.
   *
   * Best-effort, like its escalate twin: never throws back into the drain loop.
   */
  const recoverStall = (
    kind: 'drain_stalled' | 'drain_backlog_stalled' | 'drain_backlog_aged',
    detail: string,
    logKeyHex: string = handle.ownLog.keyHex,
  ): void => {
    // Seam first, exactly like `escalateStall`. NOTE: deliberately no console line
    // here — `escalateStall` does not emit one either (the durable EI is this
    // module's signal), and logging only the recovery half would be asymmetric.
    // It would also make every EXISTING drain test that recovers without passing
    // this seam fail under the repo's vitest-fail-on-console.
    if (opts._onStallRecovery) {
      opts._onStallRecovery(detail, kind);
      return;
    }
    void trackDetached(import('./replication-stall-ei')).then(
      (m) =>
        m.resolveReplicationStallEi({
          harnessSlug: handle.harnessSlug,
          logKeyHex,
          kind,
          detail,
        }),
      () => {},
    );
  };

  /**
   * WI-2009 leg 3: escalate when the drain SETTLES its passes but makes ZERO
   * forward progress for the whole `backlogStallMs` window while a MAPPED
   * undrained row still waits — the filed silent-permanence signature the
   * hung-pass watchdog does NOT cover (fast-failing passes settle instantly).
   * Runs on both the settle AND the throw path (a persistent
   * EpochKeyUnavailableError throws every pass). Progress-based, so a legitimate
   * large catch-up (any row draining resets the clock) never false-positives.
   * Best-effort + read-only: a probe fault must never wedge the drain.
   */
  async function maybeEscalateBacklogStall(): Promise<void> {
    if (stopped || backlogStallEscalated || backlogStallMs <= 0) return;
    const stalledForMs = Date.now() - lastProgressAt;
    if (stalledForMs < backlogStallMs) return;
    try {
      // A forward-compat unmapped-table row is left undrained ON PURPOSE (a
      // newer build federates it) — NOT a stall. Only a row this build CAN map
      // counts, so exclude the tables the drain has logged as unmapped.
      const unknownTables = [...loggedUnknownTables];
      const stuck = await pg`
        SELECT 1
          FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${handle.workspaceId}
           AND harness_slug = ${handle.harnessSlug}
           AND drained_at IS NULL
           AND NOT (table_name = ANY(${unknownTables as string[]}::text[]))
         LIMIT 1`;
      if (stuck.length === 0) return; // nothing mappable is actually waiting
      backlogStallEscalated = true;
      escalateStall(
        'drain_backlog_stalled',
        `outbox-drain for ${wantPayload} made ZERO forward progress for ` +
          `${Math.round(stalledForMs / 1000)}s while mapped undrained rows remain — passes settle but ` +
          `drain nothing (WI-2009 filed silent-permanence signature: persistent EpochKeyUnavailableError ` +
          `[epoch key never arrived — WI-2003 divergence] or a persistent append fault). Local writes are ` +
          `NOT federating; the ${pollMs}ms poll keeps re-attempting.`,
        stalledForMs,
      );
    } catch {
      // best-effort observability — the drain's own liveness must not depend on it
    }
  }

  /**
   * WI-5147 (EI-13571): escalate when the backlog is old/large enough to be
   * pathological EVEN THOUGH the drain is making forward progress — the class
   * `maybeEscalateBacklogStall` above cannot see (that one only fires on ZERO
   * progress). Reads the oldest-undrained-row age + undrained count directly
   * (not the since-last-progress clock), so it fires regardless of whether the
   * drain is "moving". Throttled (cheap read, but no need every pass) and
   * edge-triggered per episode — recovers (clears the latch) the moment BOTH
   * thresholds are back under control, so a later re-breach re-escalates.
   * Best-effort + read-only: a probe fault must never wedge the drain.
   */
  async function maybeEscalateBacklogAged(): Promise<void> {
    if (stopped) return;
    if (backlogAgeStallMs <= 0 && backlogSizeStallThreshold <= 0) return;
    const nowT = Date.now();
    if (lastBacklogAgeCheckAt !== 0 && nowT - lastBacklogAgeCheckAt < backlogAgeCheckIntervalMs) return;
    lastBacklogAgeCheckAt = nowT;
    try {
      // Same forward-compat exclusion as the zero-progress detector: a row this
      // build can't map is left undrained ON PURPOSE (a newer build federates
      // it) — it must never count toward "pathological", only genuinely
      // mappable undrained rows do.
      const unknownTables = [...loggedUnknownTables];
      const [row] = await pg<Array<{ undrained_count: string | number; oldest_ts: string | number | null }>>`
        SELECT count(*)::bigint AS undrained_count, min(ts) AS oldest_ts
          FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${handle.workspaceId}
           AND harness_slug = ${handle.harnessSlug}
           AND drained_at IS NULL
           AND NOT (table_name = ANY(${unknownTables as string[]}::text[]))`;
      const undrainedCount = row ? Number(row.undrained_count) : 0;
      const oldestTs = row?.oldest_ts != null ? Number(row.oldest_ts) : null;
      const oldestAgeMs = oldestTs != null ? Math.max(0, nowT - oldestTs) : 0;

      const ageBreached = backlogAgeStallMs > 0 && oldestAgeMs >= backlogAgeStallMs;
      const sizeBreached = backlogSizeStallThreshold > 0 && undrainedCount >= backlogSizeStallThreshold;

      if (!ageBreached && !sizeBreached) {
        // WI-6997: BOTH legs recovered. EI-209736 adds the restart-shaped case:
        // the durable EI can outlive this process-local latch, so the first
        // healthy probe of every drain instance performs one exact-kind no-op
        // resolve. The per-instance flag prevents a query on every later poll.
        if (backlogAgeEscalated || !backlogAgeHealthyStartReconciled) {
          recoverStall(
            'drain_backlog_aged',
            `outbox backlog recovered: ${undrainedCount} undrained row(s), oldest ` +
              `${Math.round(oldestAgeMs / 60000)}min old — both the age (${Math.round(
                backlogAgeStallMs / 60000,
              )}min) and size (${backlogSizeStallThreshold}) thresholds are clear`,
          );
        }
        backlogAgeHealthyStartReconciled = true;
        backlogAgeEscalated = false; // recovered on both legs — a later re-breach re-escalates
        return;
      }
      if (backlogAgeEscalated) return; // already paged for this episode

      backlogAgeEscalated = true;
      const reasons = [
        ageBreached
          ? `oldest undrained row is ${Math.round(oldestAgeMs / 60000)}min old (≥ ` +
            `${Math.round(backlogAgeStallMs / 60000)}min threshold)`
          : null,
        sizeBreached ? `${undrainedCount} undrained rows (≥ ${backlogSizeStallThreshold} threshold)` : null,
      ]
        .filter((r): r is string => r !== null)
        .join(' AND ');
      escalateStall(
        'drain_backlog_aged',
        `outbox-drain for ${wantPayload} has a PATHOLOGICALLY SLOW backlog: ${reasons}. The drain IS ` +
          `making SOME forward progress (this is NOT the 'drain_backlog_stalled' zero-progress case, which ` +
          `never trips here) — it is simply far too slow relative to the backlog's age/size, and a ` +
          `slowly-but-always-progressing backlog can otherwise go undetected indefinitely (WI-5147 class: a ` +
          `papercusp harness backlog sat 3 weeks like this before anyone noticed).`,
        oldestAgeMs,
      );
    } catch {
      // best-effort observability — the drain's own liveness must not depend on it
    }
  }

  /**
   * WI-2136 orphan-tail recurrence guard: page when fed-scope rows were drained
   * into a PRIOR-era own-log key that no longer matches the live process's log.
   *
   * The own-log keypair is SUPPOSED to persist across restarts; WI-2105 found it
   * does NOT on the tower bg-host (e06b8704 era → 4072cfad era), so each restart
   * orphans the prior log's unreplicated tail — rows sit drained_at-stamped but
   * their blocks can never replicate (no live process holds the dead log's
   * keypair). The drain now stamps `drained_log_key` per row (mig 495); this reads
   * the distinct keys of recently-drained rows and escalates a durable
   * `drain_orphan_tail` EI for any that isn't the live key. Recovery is
   * runbook-only per the GO/NO-GO (d)-clause (set drained_at=NULL for the dead-key
   * rows → the next drain re-appends them onto the live log); the root fix (Q1) is
   * to persist the keypair, after which the live key always matches and this guard
   * stays silent — pinning the class against regression.
   *
   * Throttled + latched: runs at boot (the initial pass) and then ≤ once per
   * `orphanCheckIntervalMs`; each dead key pages once per process (and the EI dedups
   * per (harness, dead-log, kind) besides). Best-effort + read-only: a probe fault
   * must never wedge the drain. Legacy rows (drained pre-495) carry NULL and are
   * excluded, so they never false-fire.
   */
  async function maybeDetectOrphanTail(): Promise<void> {
    if (stopped || orphanCheckIntervalMs < 0) return;
    const nowT = Date.now();
    if (lastOrphanCheckAt !== 0 && nowT - lastOrphanCheckAt < orphanCheckIntervalMs) return;
    lastOrphanCheckAt = nowT;
    try {
      const groups = await pg<
        Array<{
          drained_log_key: string;
          rows: number;
          oldest_at: string | number | null;
          newest_at: string | number | null;
        }>
      >`
        SELECT drained_log_key,
               count(*)::int AS rows,
               min(drained_at) AS oldest_at,
               max(drained_at) AS newest_at
          FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${handle.workspaceId}
           AND harness_slug = ${handle.harnessSlug}
           AND drained_at IS NOT NULL
           AND drained_log_key IS NOT NULL
           AND drained_log_key <> ${handle.ownLog.keyHex}
           AND drained_at >= ${nowT - orphanLookbackMs}
         GROUP BY drained_log_key`;
      for (const g of groups) {
        const deadKey = g.drained_log_key;
        if (escalatedOrphanKeys.has(deadKey)) continue;
        escalatedOrphanKeys.add(deadKey);
        const oldestAt = g.oldest_at != null ? Number(g.oldest_at) : nowT;
        const newestAt = g.newest_at != null ? Number(g.newest_at) : nowT;
        escalateStall(
          'drain_orphan_tail',
          `outbox-drain orphan-tail (WI-2136 / WI-2105 class) for ${wantPayload}: ${g.rows} ` +
            `fed-scope row(s) were drained into a PRIOR-era own-log key ${deadKey.slice(0, 12)}… that ` +
            `no longer matches the live log ${handle.ownLog.keyHex.slice(0, 12)}… — the own-log keypair ` +
            `changed across a restart, so that era's unreplicated tail is stranded (its blocks can never ` +
            `replicate; no live process holds the dead log). Recovery is runbook-only: set drained_at=NULL ` +
            `for the dead-key rows so the next drain re-appends them onto the live log (drained ` +
            `${oldestAt}–${newestAt}).`,
          Math.max(0, nowT - oldestAt),
          deadKey,
        );
      }
    } catch {
      // best-effort observability — the drain's own liveness must not depend on it
    }
  }

  async function drainSafely(): Promise<void> {
    if (stopped) return;
    if (draining) {
      runAgain = true;
      return;
    }
    draining = true;
    let anyProgress = false;
    try {
      do {
        runAgain = false;
        const drainOpts: DrainOptions = {};
        if (batch !== undefined) drainOpts.batch = batch;
        if (fanout !== undefined) drainOpts.fanout = fanout;
        if (opts.onDiagnosticEvent !== undefined) drainOpts.onDiagnosticEvent = opts.onDiagnosticEvent;
        if (opts.diagnosticsEnabled !== undefined) drainOpts.diagnosticsEnabled = opts.diagnosticsEnabled;
        // WI-40905: thread the resolver itself, not a pass-start snapshot. A
        // pre-refresh pass may still be between SELECT stages when the re-key
        // completes; resolving at the row's encryption point prevents that
        // stale pass from plaintext-draining a post-boundary capture.
        drainOpts.resolveEpochEncrypt = resolveEpochEncrypt;
        // WI-3896: thread the per-row bound + this process's standing quarantine
        // set into every pass, so a previously-quarantined row stays skipped and
        // any row currently hanging is bounded well under `passTimeoutMs`.
        drainOpts.rowTimeoutMs = rowTimeoutMs;
        drainOpts.fanoutTimeoutMs = fanoutTimeoutMs;
        drainOpts.quarantinedIds = quarantinedIds;
        // WI-2009 watchdog: race the pass against the timeout so ONE hung await
        // can never wedge the serialized loop forever. Admission intentionally
        // wraps ONLY the underlying pass, not this timeout race: when the
        // watchdog fires, the caller is released to re-attempt, but the
        // process-wide slot remains held until the underlying pass settles.
        // Otherwise every timed-out "zombie" pass would keep its row/JSONB/
        // append work alive after the gate released its slot, defeating the
        // process-wide memory and throughput bound (D-124).
        const drainedThisPass = await new Promise<number>((resolve, reject) => {
          // Start the pass + watchdog only AFTER FIFO admission. Counting queue
          // time as a pass timeout would create abandoned zombie drains before
          // their SELECT even began and defeat the memory bound.
          void outboxDrainAdmission
            .run(async () => {
              const pass = drainOutboxOnce(handle, pg, drainOpts);
              if (passTimeoutMs <= 0) {
                try {
                  resolve(await pass);
                } catch (e) {
                  reject(e);
                }
                return;
              }

              const timer = setTimeout(
                () => reject(new DrainPassTimeoutError(wantPayload, passTimeoutMs)),
                passTimeoutMs,
              );
              timer.unref?.();
              try {
                // Keep the admission callback alive until the real pass
                // settles. `resolve`/`reject` become harmless no-ops if the
                // timeout already settled the caller-facing promise.
                resolve(await pass);
              } catch (e) {
                reject(e);
              } finally {
                clearTimeout(timer);
              }
            }, drainAdmissionAbort.signal)
            // A queued pass may be aborted by stopInternal before admission.
            // Once admitted, the callback absorbs the pass outcome above.
            .catch(reject);
        });
        // WI-2009 leg 3: a drained row is forward progress — reset the
        // no-progress clock + clear the escalation latch (recovered).
        if (drainedThisPass > 0) {
          // WI-6997: a drained row is forward progress, so it is the recovery edge
          // for BOTH progress-based escalations. Previously this cleared the latches
          // and nothing else, stranding the durable EIs open indefinitely.
          if (backlogStallEscalated) {
            recoverStall(
              'drain_backlog_stalled',
              `outbox drain resumed forward progress: drained ${drainedThisPass} row(s) ` +
                `for ${wantPayload} after a no-progress episode`,
            );
          }
          if (drainHangEscalated) {
            recoverStall(
              'drain_stalled',
              `outbox drain pass completed normally for ${wantPayload} (drained ` +
                `${drainedThisPass} row(s)) after a hung-pass episode — the wedge cleared`,
            );
          }
          lastProgressAt = Date.now();
          backlogStallEscalated = false;
          drainHangEscalated = false;
          anyProgress = true;
        }
      } while (runAgain && !stopped);
    } catch (e) {
      // stopInternal aborts a queued (not yet executing) admission. That is a
      // normal lifecycle edge, not a drain fault or stall episode.
      if (stopped && drainAdmissionAbort.signal.aborted) return;
      console.error(`[outbox-drain] drain failed for ${wantPayload}:`, e instanceof Error ? e.message : String(e));
      if (e instanceof DrainPassTimeoutError) {
        // WI-6997: latch it so the next successful pass has an edge to resolve on.
        drainHangEscalated = true;
        escalateStall(
          'drain_stalled',
          `outbox-drain pass for ${wantPayload} exceeded ${passTimeoutMs}ms (hung await — ` +
            `WI-2009 permanence class; loop un-wedged, next tick re-attempts)`,
          passTimeoutMs,
        );
      } else if (e instanceof RowStageTimeoutError) {
        // WI-3896: a SINGLE row's stage (epoch-encrypt/append) timed out — bound
        // well under passTimeoutMs so this is caught + attributed to the exact
        // row LONG before the pass-level watchdog would even fire. Count
        // CONSECUTIVE occurrences for this SAME row id; quarantine (permanent
        // skip) once it crosses the threshold so later rows stop being blocked.
        const key = String(e.rowId);
        const n = (rowTimeoutCounts.get(key) ?? 0) + 1;
        if (n >= rowQuarantineThreshold) {
          rowTimeoutCounts.delete(key);
          quarantinedIds.add(key);
          // mig 645 (WI-3896 follow-up): PERSIST the quarantine so it survives
          // this process's restart (this dev box's hosts self-recycle every
          // ~5-8min) — without this, a restart forgets `quarantinedIds` and
          // re-discovers the SAME poison row from scratch (3 more consecutive
          // 45s stage timeouts before re-quarantining, every single restart,
          // forever). Best-effort + fire-and-forget: a write failure here must
          // never block the drain loop — the in-memory `quarantinedIds` add
          // above already protects THIS process's passes regardless.
          void pg`
            UPDATE harness_shared.substrate_outbox
               SET quarantined_at = ${Date.now()}
             WHERE id = ${e.rowId}
               AND quarantined_at IS NULL
          `.catch((persistErr: unknown) => {
            console.error(
              `[outbox-drain] WI-3896 quarantine: failed to PERSIST quarantined_at for row ` +
                `id=${e.rowId} (in-memory quarantine still applies for this process; a restart ` +
                `will re-discover + re-time-out this row):`,
              persistErr instanceof Error ? persistErr.message : String(persistErr),
            );
          });
          const detail =
            `outbox-drain for ${wantPayload}: row id=${e.rowId} (stage '${e.stage}') timed out ` +
            `${n}× consecutively and is now QUARANTINED (permanently skipped — left undrained ON ` +
            `PURPOSE, never falsely marked drained_at) so it can no longer wedge every row behind ` +
            `it. Root-cause + manually clear via the runbook once resolved (WI-3896 class — check ` +
            `whether this was LOAD-induced, in which case re-checking under lower host load first ` +
            `is worth trying before assuming permanent poison).`;
          console.error(`[outbox-drain] WI-3896 quarantine: ${detail}`);
          escalateStall('drain_row_quarantined', detail, rowTimeoutMs * n);
        } else {
          rowTimeoutCounts.set(key, n);
          console.error(
            `[outbox-drain] row id=${e.rowId} stage '${e.stage}' for ${wantPayload} timed out ` +
              `(${n}/${rowQuarantineThreshold} consecutive before quarantine) — next pass retries this row.`,
          );
        }
      } else if (isSessionClosedError(e)) {
        // WI-3684 send-side twin: the own-log session is PERMANENTLY closed
        // (Hypercore equivocation guard, or an explicit close) — every future
        // `handle.append` on this same handle will throw the same error, so
        // the `${pollMs}ms` poll blind-retrying forever just spams this error
        // every tick. Self-stop instead, and tell the caller (wire-outbox.ts →
        // boot-all.ts) so it can re-wire a fresh drain once a live handle is
        // available again (mirrors boot.ts's repair-on-detect for the receive
        // side — detect-and-act, not detect-and-retry-blindly).
        console.error(
          `[outbox-drain] own-log session for ${wantPayload} is SESSION_CLOSED — ` +
            `stopping this drain (no further ${pollMs}ms retries against the dead session); ` +
            `signaling for a re-wire`,
        );
        await stopInternal();
        try {
          opts.onSessionClosed?.();
        } catch {
          // best-effort — a throwing callback must never surface from here
        }
      } else if (isConnectionEndedError(e)) {
        // EI-13917: the shared PG client this closure was handed is now
        // permanently ENDED (connection.ts rebuilt it elsewhere — e.g. a
        // discovery-file URL change — and this drain never re-resolves its
        // reference). Every future pass on `pg` would fail the SAME way
        // forever (the live incident: 600x/min for 4.5min until a manual
        // process restart). Self-stop instead of blind-retrying the dead
        // handle, and reuse the EXACT same re-wire path WI-3684 built for a
        // permanently-closed hypercore session: `onSessionClosed` un-marks
        // this harness's outbox wiring so the next `ensureSendSideWired` call
        // re-wires a FRESH drain against a freshly-resolved `getOrgPg().sql`.
        console.error(
          `[outbox-drain] PG client for ${wantPayload} is CONNECTION_ENDED (EI-13917 class — the ` +
            `shared client was invalidated out from under this drain, e.g. by a discovery-file URL ` +
            `change) — stopping this drain (no further ${pollMs}ms retries against the dead client); ` +
            `signaling for a re-wire against the current client`,
        );
        await stopInternal();
        try {
          opts.onSessionClosed?.();
        } catch {
          // best-effort — a throwing callback must never surface from here
        }
      }
    } finally {
      draining = false;
    }
    // WI-2009 leg 3: check for a no-forward-progress backlog stall AFTER the
    // drain settles — reached on BOTH the normal and the throw (fast-fail) path,
    // so a pass that fails fast every time (the filed signature) is caught.
    if (!stopped && !anyProgress) await maybeEscalateBacklogStall();
    // WI-5147: check the backlog age/size directly — independent of `anyProgress`
    // (that's the entire point: this fires even while the drain IS progressing,
    // just too slowly relative to the backlog).
    if (!stopped) await maybeEscalateBacklogAged();
    // WI-2136: check for an orphaned prior-era drain tail (throttled; runs at boot
    // via the initial pass). Independent of drain progress — a perfectly healthy
    // draining process can still be sitting on a stranded tail from a prior era
    // whose keypair it no longer holds.
    if (!stopped) await maybeDetectOrphanTail();
  }

  // mig 645 (WI-3896 follow-up): seed `quarantinedIds` from any ALREADY-persisted
  // quarantine (a prior process, before this restart, stamped `quarantined_at`)
  // so a fresh boot doesn't have to re-discover + re-time-out (3× 45s) the SAME
  // poison row it already root-caused-as-poison last time. Best-effort: read
  // RESILIENTLY via to_jsonb (mirrors the drain SELECT above) so a pre-645
  // outbox / a fake test `pg` with no `quarantined_at` handling degrades to
  // "nothing pre-seeded" rather than throwing at boot.
  void (async () => {
    try {
      const seeded = await pg<Array<{ id: string | number }>>`
        SELECT id FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${handle.workspaceId}
           AND harness_slug = ${handle.harnessSlug}
           AND drained_at IS NULL
           AND (to_jsonb(substrate_outbox.*) ->> 'quarantined_at') IS NOT NULL`;
      for (const r of seeded) quarantinedIds.add(String(r.id));
      if (seeded.length > 0) {
        console.warn(
          `[outbox-drain] seeded ${seeded.length} already-persisted quarantined row id(s) for ` +
            `${wantPayload} from a prior process (WI-3896 follow-up — no re-discovery needed).`,
        );
      }
    } catch {
      // best-effort — a probe fault must never block boot; worst case this
      // process re-discovers + re-quarantines the same poison row itself.
    }
  })();

  // Immediate catch-up drain.
  void drainSafely();

  // LISTEN — drain on a matching NOTIFY. Two paths, SAME filter semantics: this
  // drain reacts only to its own `ws::slug` payload either way.
  //   - shared (P-008, `opts.listen`): every harness rides ONE ref-counted backend.
  //   - legacy (default): `pg.listen` reserves its own dedicated connection
  //     internally; the returned request's `unlisten()` releases it.
  const onNotify = (payload: string): void => {
    if (stopped) return;
    if (payload === wantPayload) void drainSafely();
  };
  const listenSetup: Promise<unknown> = opts.listen
    ? (sharedUnsubscribe = opts.listen(NOTIFY_CHANNEL, onNotify))
    : Promise.resolve((listenReq = pg.listen(NOTIFY_CHANNEL, onNotify)));
  // Surface a listen-setup failure without crashing the boot path. The poll-fallback
  // timer below still guarantees drain liveness if the subscription never lands.
  void listenSetup.catch((e: unknown) => {
    console.error(`[outbox-drain] LISTEN setup failed for ${wantPayload}:`, e instanceof Error ? e.message : String(e));
  });

  // Poll-fallback timer (liveness if a NOTIFY is missed). `.unref()` so it never
  // keeps the process alive on its own.
  pollTimer =
    pollMs > 0
      ? managedSetInterval(
          'hyperbee-outbox-drain-poll',
          pollMs,
          () => {
            void drainSafely();
          },
          { category: 'lifecycle', instanced: true },
        )
      : null;

  return {
    stop: stopInternal,
  };
}
