/**
 * Learning-governor STORE (self-learning-frontier-2026-06-12 P-003 / FB-01) —
 * SQL over migration 244 (harness_shared.learning_governor_loops +
 * learning_spend_events). Helpers take an injected `Sql` (the live operator
 * admin pool), control-plane style, so the routine-action glue and tests share
 * one core; SQL is covered by store.integration.test.ts, decisions by the pure
 * core (core.ts).
 *
 * The two write modes registrants use:
 *   - register: upsert preserving omitted fields (setAutoloop semantics) —
 *     spent_usd is PRESERVED unless explicitly passed (mirror mode overwrites
 *     it from the loop's own source of truth, e.g. gym_autoloop_config).
 *   - recordLearningSpend: append one ledger event; accumulate:true (default)
 *     also bumps the registration's spent_usd atomically — the path for loops
 *     whose ONLY spend store is the governor (scout, every frontier loop).
 *     accumulate:false ledgers the event only (gym: the row's spent mirrors
 *     gym_autoloop_config, so accumulating here would double-count).
 */
import type { Sql, TransactionSql } from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  checkLoopVerdict,
  LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  SCOUT_LOOP_ID_PREFIX,
  type GovernorVerdict,
  type LearningBudgetKind,
  type LearningEnforcement,
  type LearningLoopRegistration,
} from './core';
import { potLearningEnabled } from '../learning/pot-gate/store';
import {
  planReservation,
  reservationHeadroomUsd,
  settleReservation,
  summarizeSpendPositions,
  toLearningSpend,
  type LearningSpendPositions,
  type ReservationRefusal,
  type SpendAttemptKind,
  type SpendDisposition,
  type SpendReservationStatus,
} from './spend';
import type { LearningSpend } from '../experiment/types';

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ts = (v: unknown): number => new Date(v as string | Date).getTime();

function mapLoop(r: Row): LearningLoopRegistration {
  return {
    workspaceId: str(r.workspace_id),
    loopId: str(r.loop_id),
    potSlug: strOrNull(r.pot_slug),
    displayName: str(r.display_name),
    budgetKind: str(r.budget_kind) as LearningBudgetKind,
    budgetUsd: numOrNull(r.budget_usd),
    spentUsd: Number(r.spent_usd ?? 0),
    priority: Number(r.priority ?? 100),
    enabled: r.enabled === true || r.enabled === 't',
    enforcement: str(r.enforcement) as LearningEnforcement,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
    registeredAt: ts(r.registered_at),
    updatedAt: ts(r.updated_at),
  };
}

export interface LearningSpendEvent {
  id: string;
  workspaceId: string;
  loopId: string;
  /** The pot the spend learned FOR (pot-scope-all-learnings P-004); null = pre-pot legacy or pot-less. */
  potSlug: string | null;
  costUsd: number;
  signalOrigin: string;
  runRef: string | null;
  note: string | null;
  createdAt: number;
}

function mapEvent(r: Row): LearningSpendEvent {
  return {
    id: str(r.id),
    workspaceId: str(r.workspace_id),
    loopId: str(r.loop_id),
    potSlug: strOrNull(r.pot_slug),
    costUsd: Number(r.cost_usd),
    signalOrigin: str(r.signal_origin),
    runRef: strOrNull(r.run_ref),
    note: strOrNull(r.note),
    createdAt: ts(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegisterLearningLoopInput {
  workspaceId: string;
  loopId: string;
  /** Seed a missing registrant without changing an existing owner's settings or spend. */
  ifMissing?: boolean;
  /** The pot the loop learns FOR (P-004). Sets/overwrites when passed (null included); undefined preserves. */
  potSlug?: string | null;
  /** Defaults to loopId on first registration; preserved when omitted thereafter. */
  displayName?: string;
  budgetKind?: LearningBudgetKind;
  /** number sets a cap; null clears it (⇒ refuses unattended); undefined preserves. */
  budgetUsd?: number | null;
  /** Mirror mode: overwrite spent from the loop's own source of truth. Omitted = preserved. */
  spentUsd?: number;
  priority?: number;
  enabled?: boolean;
  enforcement?: LearningEnforcement;
  meta?: Record<string, unknown> | null;
}

/** Upsert a loop registration; omitted fields are preserved (setAutoloop semantics). */
export async function registerLearningLoop(
  sql: Sql,
  q: RegisterLearningLoopInput,
): Promise<LearningLoopRegistration> {
  const existing = await getLearningLoop(sql, { workspaceId: q.workspaceId, loopId: q.loopId });
  if (q.ifMissing && existing) return existing;
  const merged = {
    workspaceId: q.workspaceId,
    loopId: q.loopId,
    potSlug: q.potSlug !== undefined ? q.potSlug : existing?.potSlug ?? null,
    displayName: q.displayName ?? existing?.displayName ?? q.loopId,
    budgetKind: q.budgetKind ?? existing?.budgetKind ?? 'lifetime',
    budgetUsd: q.budgetUsd !== undefined ? q.budgetUsd : existing?.budgetUsd ?? null,
    spentUsd: q.spentUsd ?? existing?.spentUsd ?? 0,
    priority: q.priority ?? existing?.priority ?? 100,
    enabled: q.enabled ?? existing?.enabled ?? true,
    enforcement: q.enforcement ?? existing?.enforcement ?? 'governor',
    meta: q.meta !== undefined ? q.meta : existing?.meta ?? null,
  };
  const rows = (await sql`
    INSERT INTO harness_shared.learning_governor_loops
      (workspace_id, loop_id, pot_slug, display_name, budget_kind, budget_usd, spent_usd, priority, enabled, enforcement, meta)
    VALUES (${merged.workspaceId}, ${merged.loopId}, ${merged.potSlug}, ${merged.displayName}, ${merged.budgetKind}, ${merged.budgetUsd},
      ${merged.spentUsd}, ${merged.priority}, ${merged.enabled}, ${merged.enforcement}, ${merged.meta as never})
    ON CONFLICT (workspace_id, loop_id) DO UPDATE SET
      pot_slug = EXCLUDED.pot_slug,
      display_name = EXCLUDED.display_name, budget_kind = EXCLUDED.budget_kind, budget_usd = EXCLUDED.budget_usd,
      spent_usd = EXCLUDED.spent_usd, priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
      enforcement = EXCLUDED.enforcement, meta = EXCLUDED.meta, updated_at = now()
    WHERE ${!q.ifMissing}
    RETURNING *`) as Row[];
  if (rows[0]) return mapLoop(rows[0]);
  // Another creator may have won between the read and INSERT. Never overwrite it.
  const concurrent = await getLearningLoop(sql, { workspaceId: q.workspaceId, loopId: q.loopId });
  if (!concurrent) throw new Error('Learning loop disappeared during registration');
  return concurrent;
}

export async function getLearningLoop(
  sql: Sql,
  q: { workspaceId: string; loopId: string },
): Promise<LearningLoopRegistration | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.learning_governor_loops
     WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId} LIMIT 1`) as Row[];
  return rows.length ? mapLoop(rows[0]) : null;
}

/** Every registered loop in the workspace, priority order (the ledger view + summarize input). */
export async function listLearningLoops(
  sql: Sql,
  q: { workspaceId: string },
): Promise<LearningLoopRegistration[]> {
  const rows = (await sql`
    SELECT * FROM harness_shared.learning_governor_loops
     WHERE workspace_id = ${q.workspaceId}
     ORDER BY priority ASC, loop_id ASC`) as Row[];
  return rows.map(mapLoop);
}

/**
 * Deregister a loop — drop its registration row (the lifecycle inverse of
 * registerLearningLoop). Used by pot:dissolve to remove the per-hive
 * `gym:<hive>` / `scout:<hive>` registrants so a dissolved hive's loop leaves no
 * stranded governor row. Idempotent (a missing row is a no-op); returns whether
 * a row was deleted. The spend-event ledger is left as the durable audit trail.
 */
export async function deleteLearningLoop(
  sql: Sql,
  q: { workspaceId: string; loopId: string },
): Promise<{ deleted: boolean }> {
  const rows = (await sql`
    DELETE FROM harness_shared.learning_governor_loops
     WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId}
     RETURNING loop_id`) as Row[];
  return { deleted: rows.length > 0 };
}

/**
 * THE unattended-refusal check (D-004): look up the registration and apply the
 * generalized gym rule. Frontier loops call the flag-aware wrapper
 * (registrants.ts learningGovernorPreflight) — this is the PG-level core.
 *
 * Also applies the per-pot master switch (learning-pot-scope-gate-2026-08-30
 * D-001). The registration row already CARRIES `pot_slug`, so the pot is
 * resolved here rather than threaded through every call site — no caller
 * changes, and a loop with no pot (`pot_slug` null) is unaffected.
 *
 * That costs ONE extra indexed PK lookup, and only when a registration exists.
 * It is deliberately a second query rather than a LEFT JOIN onto the
 * registration read: the join would make every governor check fail hard on a
 * substrate that has not applied migration 1039, whereas the pot store's own
 * undefined_table fail-open keeps the gate inert there — which is the whole
 * posture of R-5.
 */
export async function governorCheck(
  sql: Sql,
  q: { workspaceId: string; loopId: string; floorUsd?: number },
): Promise<GovernorVerdict> {
  const reg = await getLearningLoop(sql, { workspaceId: q.workspaceId, loopId: q.loopId });
  const potEnabled = reg?.potSlug
    ? await potLearningEnabled(sql, { workspaceId: q.workspaceId, potSlug: reg.potSlug })
    : undefined;
  // P-005: spend RESERVED by attempts still in flight is committed money the
  // registration's `spent_usd` has not been charged for yet. Counting it as
  // spend is what stops N concurrent attempts each reading the same headroom
  // and collectively overspending it. Only lifetime rows gate on it — a
  // per-cycle cap bounds ONE run by contract (enforcement 'native'), so open
  // attempts on other runs are deliberately not charged against it.
  //
  // Before any reservation exists this term is 0, so the verdict is exactly
  // what it was pre-P-005; and on a substrate without migration 1116 the read
  // degrades to 0 rather than throwing, keeping the same fail-open posture the
  // pot gate above uses (the preflight's own catch is fail-CLOSED, so an
  // exception here would refuse every loop on an un-migrated substrate).
  const openReserved =
    reg && reg.budgetKind === 'lifetime' && reg.budgetUsd !== null
      ? await sumOpenReservedUsd(sql, { workspaceId: q.workspaceId, loopId: q.loopId })
      : 0;
  const effective = reg && openReserved > 0 ? { ...reg, spentUsd: reg.spentUsd + openReserved } : reg;
  return checkLoopVerdict(effective, q.floorUsd ?? LEARNING_GOVERNOR_BUDGET_FLOOR_USD, potEnabled);
}

// ---------------------------------------------------------------------------
// Spend ledger
// ---------------------------------------------------------------------------

export interface RecordLearningSpendInput {
  workspaceId: string;
  loopId: string;
  /** The pot the spend learned FOR (P-004); omitted/null ⇒ recorded pot-less. */
  potSlug?: string | null;
  costUsd: number;
  /** Provenance (P-002/D-002 vocabulary). Default 'organic'. */
  signalOrigin?: 'organic' | 'drill' | 'replay' | 'shadow';
  runRef?: string | null;
  note?: string | null;
  /**
   * true (default): also bump the registration's spent_usd — the path for
   * loops whose only spend store is the governor. false: ledger the event
   * only (mirror-mode loops whose row spent syncs from their own store).
   */
  accumulate?: boolean;
}

/** Append one spend event (+ optionally accumulate onto the registration row, atomically). */
export async function recordLearningSpend(sql: Sql, q: RecordLearningSpendInput): Promise<LearningSpendEvent> {
  if (!Number.isFinite(q.costUsd) || q.costUsd < 0) {
    throw new Error(`learning-governor: costUsd must be a non-negative finite number, got ${q.costUsd}`);
  }
  const run = async (tx: Sql | TransactionSql): Promise<LearningSpendEvent> => {
    const rows = (await tx`
      INSERT INTO harness_shared.learning_spend_events
        (workspace_id, loop_id, pot_slug, cost_usd, signal_origin, run_ref, note)
      VALUES (${q.workspaceId}, ${q.loopId}, ${q.potSlug ?? null}, ${q.costUsd}, ${q.signalOrigin ?? 'organic'},
        ${q.runRef ?? null}, ${q.note ?? null})
      RETURNING *`) as Row[];
    if (q.accumulate !== false) {
      await tx`
        UPDATE harness_shared.learning_governor_loops
           SET spent_usd = spent_usd + ${q.costUsd}, updated_at = now()
         WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId}`;
    }
    return mapEvent(rows[0]);
  };
  // Event + accumulate must land together. Open our own transaction when handed a
  // top-level client; inside a caller's TransactionSql (no `.begin`) run directly.
  const begin = (sql as unknown as { begin?: unknown }).begin;
  return typeof begin === 'function' ? ((await sql.begin(run)) as LearningSpendEvent) : run(sql);
}

/**
 * Windowed scout spend — Σ cost_usd of every `blender:*` spend EVENT in the
 * workspace at/after `sinceMs`, plus how many distinct scout loops contributed.
 * The workspace-ceiling gate's data source (scout-ceiling.ts): the event ledger
 * is the only spend store with timestamps, so it is what makes the ceiling an
 * accounting-window cap instead of a lifetime one.
 */
export async function sumScoutSpendSince(
  sql: Sql,
  q: { workspaceId: string; sinceMs: number },
): Promise<{ totalUsd: number; loopCount: number }> {
  const rows = (await sql`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total, COUNT(DISTINCT loop_id)::int AS loops
      FROM harness_shared.learning_spend_events
     WHERE workspace_id = ${q.workspaceId}
       AND loop_id LIKE ${SCOUT_LOOP_ID_PREFIX + '%'}
       AND created_at >= ${new Date(q.sinceMs)}`) as Row[];
  const r = rows[0] ?? {};
  return { totalUsd: Number(r.total ?? 0), loopCount: Number(r.loops ?? 0) };
}

export async function listLearningSpendEvents(
  sql: Sql,
  q: { workspaceId: string; loopId?: string; limit?: number },
): Promise<LearningSpendEvent[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const rows = (await sql`
    SELECT * FROM harness_shared.learning_spend_events
     WHERE workspace_id = ${q.workspaceId}
       ${q.loopId ? sql`AND loop_id = ${q.loopId}` : sql``}
     ORDER BY created_at DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapEvent);
}

// ---------------------------------------------------------------------------
// Spend RESERVATION + SETTLEMENT (P-005) — migration 1116
//
// The lifecycle the post-hoc ledger above cannot express. Decisions live in
// the pure core (spend.ts); this is the SQL that binds them, plus the one
// concurrency guarantee that has to live here: the reservation decision runs
// under a row lock on the registration, so two attempts cannot both read the
// same headroom and both grant against it.
// ---------------------------------------------------------------------------

export interface LearningSpendReservation {
  id: string;
  workspaceId: string;
  loopId: string;
  potSlug: string | null;
  attemptKind: string;
  requestedUsd: number;
  reservedUsd: number;
  usedUsd: number;
  status: SpendReservationStatus;
  signalOrigin: string;
  runRef: string | null;
  note: string | null;
  createdAt: number;
  settledAt: number | null;
  /** Conservative bounds, retained even after monetary settlement. Not usage. */
  resources?: LearningReservationResources;
}

export interface LearningReservationResources {
  armId: string;
  inputTokens: number;
  outputTokens: number;
}

/** Frozen by the controller in registration.meta.reservationResourceBudget.
 * The allowlist bounds distinct arms as well as rejecting invented identities. */
export interface LearningReservationResourceBudget {
  inputTokens: number;
  outputTokens: number;
  requestsPerArm: number;
  armIds: string[];
}

const resourceCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
/** Exact reservations and settlements must agree on currency precision. */
function exactUsdMicros(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  const n = Math.round(value * 1_000_000);
  return value >= 0 && Number.isSafeInteger(n) && n / 1_000_000 === value ? n : null;
}
const resourceArm = (s: unknown): s is string => typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 256;
function resourceBudgetValid(value: unknown): value is LearningReservationResourceBudget {
  if (!value || typeof value !== 'object') return false;
  const v = value as LearningReservationResourceBudget;
  return resourceCount(v.inputTokens) && resourceCount(v.outputTokens) && resourceCount(v.requestsPerArm) &&
    v.requestsPerArm > 0 && Array.isArray(v.armIds) && v.armIds.length > 0 && v.armIds.length <= 1000 &&
    v.armIds.every(resourceArm) && new Set(v.armIds).size === v.armIds.length;
}

function mapReservation(r: Row): LearningSpendReservation {
  return {
    id: str(r.id),
    workspaceId: str(r.workspace_id),
    loopId: str(r.loop_id),
    potSlug: strOrNull(r.pot_slug),
    attemptKind: str(r.attempt_kind),
    requestedUsd: Number(r.requested_usd ?? 0),
    reservedUsd: Number(r.reserved_usd ?? 0),
    usedUsd: Number(r.used_usd ?? 0),
    status: str(r.status) as SpendReservationStatus,
    signalOrigin: str(r.signal_origin),
    runRef: strOrNull(r.run_ref),
    note: strOrNull(r.note),
    createdAt: ts(r.created_at),
    settledAt: r.settled_at === null || r.settled_at === undefined ? null : ts(r.settled_at),
    ...(r.arm_id == null ? {} : { resources: { armId: str(r.arm_id),
      inputTokens: Number(r.reserved_input_tokens), outputTokens: Number(r.reserved_output_tokens) } }),
  };
}

/** Table-absent (pre-1116 substrate) degrades to the empty/zero reading, never a throw. */
function isUndefinedTable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === '42P01' || /relation .* does not exist/i.test(e instanceof Error ? e.message : '');
}

/**
 * Σ reserved on attempts still OPEN for one loop — the "committed but not yet
 * charged" term `governorCheck` folds into spend, and the `unsettledUsd`
 * number for that loop.
 */
export async function sumOpenReservedUsd(
  sql: Sql,
  q: { workspaceId: string; loopId?: string },
): Promise<number> {
  try {
    const rows = (await sql`
      SELECT COALESCE(SUM(reserved_usd), 0) AS open_reserved
        FROM harness_shared.learning_spend_reservations
       WHERE workspace_id = ${q.workspaceId}
         AND status = 'open'
         ${q.loopId ? sql`AND loop_id = ${q.loopId}` : sql``}`) as Row[];
    return Number(rows[0]?.open_reserved ?? 0);
  } catch (e) {
    if (isUndefinedTable(e)) return 0;
    throw e;
  }
}

/** One native run's frozen per-cycle policy. This scopes issuer arithmetic,
 * not authentication or provider invoice enforcement. Persisted using the
 * existing reservation run_ref; no new ledger or registration is needed. */
export interface CycleSpendReservationScope {
  runId: string;
  budgetUsd: number;
}

const cycleUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shared receipt identity check for the store and governed dispatch helper. */
export function cycleReservationRunRef(cycle: CycleSpendReservationScope, reservationId: string): string | null {
  if (!cycle || typeof cycle.runId !== 'string' || !cycleUuid.test(cycle.runId) ||
    exactUsdMicros(cycle.budgetUsd) === null || typeof reservationId !== 'string' || !cycleUuid.test(reservationId)) return null;
  return `cycle:${cycle.runId.toLowerCase()}/cap:${exactUsdMicros(cycle.budgetUsd)}/attempt:${reservationId.toLowerCase()}`;
}

export interface ReserveLearningSpendInput {
  workspaceId: string;
  loopId: string;
  /** The pot the attempt learns FOR (P-004); omitted ⇒ inherited from the registration. */
  potSlug?: string | null;
  attemptKind?: SpendAttemptKind;
  requestedUsd: number;
  signalOrigin?: 'organic' | 'drill' | 'replay' | 'shadow';
  runRef?: string | null;
  note?: string | null;
  floorUsd?: number;
  /** Bound all attempts in ONE per-cycle run under the registration lock.
   * The registered cap must still match; other runs retain their own cap.
   * Incompatible with exact lifetime/resource reservations or caller runRef. */
  cycle?: CycleSpendReservationScope;
  /** Exact, single-use reservation for a controller's frozen manifest. The
   * registration must carry meta.reservationBinding with this SHA256, be
   * enabled/lifetime, and still have the expected dollar cap. No partial grant
   * or successful replay is possible. Optional resource bounds require the
   * matching registered budget. Callers still own approval, source/auth/native
   * bounds, full remaining-arm projection and authenticated accounting. */
  exact?: {
    reservationId: string;
    binding: string;
    expectedBudgetUsd: number;
    resources?: LearningReservationResources;
    expectedResourceBudget?: LearningReservationResourceBudget;
  };
}

type ExactReservationRefusal = 'invalid-exact-request' | 'transaction-required' | 'binding-required' |
  'stale-binding' | 'disabled' | 'pot-disabled' | 'unsupported-budget-kind' | 'insufficient-headroom' | 'already-reserved' |
  'resource-binding-required' | 'resource-accounting-incomplete' | 'resource-cap-exceeded';

type CycleReservationRefusal = 'invalid-cycle-request' | 'cycle-binding-required' |
  'stale-cycle-budget' | 'cycle-accounting-incomplete';

export type ReserveLearningSpendResult =
  | { ok: true; reservation: LearningSpendReservation; clamped: boolean; headroomUsd: number | null }
  | { ok: false; reason: ReservationRefusal | ExactReservationRefusal | CycleReservationRefusal; requestedUsd: number; headroomUsd: number | null };

/**
 * Open one attempt. Refuses (fail-closed) on a disabled or unbudgeted registration,
 * an invalid amount, or no headroom; grants a CLAMPED reservation when the loop
 * can afford some but not all of the request — a partial grant is an allow,
 * and the caller bounds itself at `reservation.reservedUsd`.
 *
 * The registration row is locked FOR UPDATE for the duration of the decision.
 * That lock is the whole reason concurrent attempts are safe: without it two
 * callers read the same `spent_usd` + open-reservation sum and both grant.
 *
 * A missing registration refuses as 'unbudgeted' — the same posture as the
 * D-004 preflight, which refuses an unregistered loop outright.
 */
export async function reserveLearningSpend(
  sql: Sql,
  q: ReserveLearningSpendInput,
): Promise<ReserveLearningSpendResult> {
  q = { ...q, ...(q.cycle !== undefined ? { cycle: { ...q.cycle } } : {}), ...(q.exact ? { exact: { ...q.exact,
    ...(q.exact.resources ? { resources: { ...q.exact.resources } } : {}),
    ...(q.exact.expectedResourceBudget ? { expectedResourceBudget: { ...q.exact.expectedResourceBudget,
      armIds: Array.isArray(q.exact.expectedResourceBudget.armIds) ? [...q.exact.expectedResourceBudget.armIds] : [] } } : {}),
  } } : {}) };
  const exact = q.exact;
  const cycle = q.cycle;
  const reservationId = exact?.reservationId ?? randomUUID();
  const cycleRef = cycle === undefined ? null : cycleReservationRunRef(cycle, reservationId);
  const refuse = (reason: ReservationRefusal | ExactReservationRefusal | CycleReservationRefusal, headroomUsd: number | null = null): ReserveLearningSpendResult =>
    ({ ok: false, reason, requestedUsd: q.requestedUsd, headroomUsd });
  // Work in integer microdollars on the exact path, not floating subtraction
  // that can round remaining headroom UP. Reject non-microdollar input.
  const micros = exactUsdMicros;
  const begin = (sql as unknown as { begin?: unknown }).begin;
  if (cycle !== undefined && (!cycleRef || exact !== undefined || q.runRef != null || micros(q.requestedUsd) === null)) {
    return refuse('invalid-cycle-request');
  }
  if (cycle === undefined && q.runRef?.startsWith('cycle:')) return refuse('cycle-binding-required');
  if (cycle !== undefined && typeof begin !== 'function') return refuse('transaction-required');
  if (exact && (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(exact.reservationId) ||
    !/^[a-f0-9]{64}$/.test(exact.binding) || micros(exact.expectedBudgetUsd) === null ||
    micros(q.requestedUsd) === null || micros(q.floorUsd ?? LEARNING_GOVERNOR_BUDGET_FLOOR_USD) === null ||
    q.runRef != null)) return refuse('invalid-exact-request');
  // The legacy test seam may run without begin; exact grants must NEVER take
  // a FOR UPDATE lock in autocommit and then insert outside its transaction.
  if (exact && typeof begin !== 'function') return refuse('transaction-required');
  const resources = exact?.resources;
  const expectedResources = exact?.expectedResourceBudget;
  if ((resources || expectedResources) && (!resources || !resourceBudgetValid(expectedResources) ||
    !resourceArm(resources.armId) || !resourceCount(resources.inputTokens) ||
    !resourceCount(resources.outputTokens) || resources.outputTokens === 0)) return refuse('invalid-exact-request');
  const run = async (tx: Sql | TransactionSql): Promise<ReserveLearningSpendResult> => {
    const regRows = (await tx`
      SELECT * FROM harness_shared.learning_governor_loops
       WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId}
       FOR UPDATE`) as Row[];
    const reg = regRows[0] ? mapLoop(regRows[0]) : null;
    // Preflight may have allowed the loop before an async pool/dispatch wait.
    // Re-read authority under the registration lock for every reservation,
    // including native per-cycle mirrors and zero-cost attempts.
    // Attribution on the request cannot choose a different pot's authority.
    if (reg?.potSlug && !(await potLearningEnabled(tx as Sql, {
      workspaceId: q.workspaceId, potSlug: reg.potSlug,
    }))) return refuse('pot-disabled');
    if (reg && !reg.enabled) return refuse('disabled');
    if ((reg?.meta?.reservationBinding != null || reg?.meta?.reservationResourceBudget != null) && !exact) {
      return refuse('binding-required');
    }
    if (exact) {
      if (!reg || reg.budgetUsd === null) return refuse('unbudgeted');
      if (reg.budgetKind !== 'lifetime') return refuse('unsupported-budget-kind');
      if (reg.meta?.reservationBinding !== exact.binding || reg.budgetUsd !== exact.expectedBudgetUsd) {
        return refuse('stale-binding');
      }
    }
    if (cycle !== undefined) {
      if (!reg || reg.budgetUsd === null) return refuse('unbudgeted');
      if (reg.budgetKind !== 'per-cycle') return refuse('unsupported-budget-kind');
      if (reg.budgetUsd !== cycle.budgetUsd) return refuse('stale-cycle-budget');
    }
    const resourceBudget = reg?.meta?.reservationResourceBudget;
    if (resourceBudget != null || resources) {
      if (!resources || !expectedResources || !resourceBudgetValid(resourceBudget)) return refuse('resource-binding-required');
      if (resourceBudget.inputTokens !== expectedResources.inputTokens || resourceBudget.outputTokens !== expectedResources.outputTokens ||
        resourceBudget.requestsPerArm !== expectedResources.requestsPerArm ||
        resourceBudget.armIds.length !== expectedResources.armIds.length ||
        resourceBudget.armIds.some(id => !expectedResources.armIds.includes(id))) return refuse('stale-binding');
      if (!resourceBudget.armIds.includes(resources.armId)) return refuse('resource-cap-exceeded');
      // No status filter: a failed/cancelled/settled request may have spent
      // tokens. Releasing USD is not authority to refund any resource bound.
      // GROUP BY keeps the result bounded by the frozen arm population, and
      // rejects an incomplete legacy history instead of treating it as zero.
      const history = (await tx`
        SELECT arm_id, SUM(reserved_input_tokens) AS inputs, SUM(reserved_output_tokens) AS outputs,
          COUNT(*) AS requests,
          BOOL_AND(reserved_input_tokens IS NOT NULL AND reserved_output_tokens IS NOT NULL
            AND run_ref IS NOT DISTINCT FROM ${`manifest:${exact!.binding}/attempt:`} || id::text) AS complete
        FROM harness_shared.learning_spend_reservations
        WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId}
        GROUP BY arm_id`) as Row[];
      let inputs = resources.inputTokens, outputs = resources.outputTokens;
      let armRequests = 1;
      for (const row of history) {
        const input = Number(row.inputs), output = Number(row.outputs), requests = Number(row.requests);
        if (row.complete !== true || !resourceArm(row.arm_id) || !resourceBudget.armIds.includes(row.arm_id) ||
          !resourceCount(input) || !resourceCount(output) || !resourceCount(requests)) return refuse('resource-accounting-incomplete');
        inputs += input; outputs += output;
        if (row.arm_id === resources.armId) armRequests += requests;
        if (requests > resourceBudget.requestsPerArm) return refuse('resource-cap-exceeded');
      }
      if (![inputs, outputs, armRequests].every(resourceCount) || inputs > resourceBudget.inputTokens ||
        outputs > resourceBudget.outputTokens || armRequests > resourceBudget.requestsPerArm) return refuse('resource-cap-exceeded');
    }
    const openReserved = await sumOpenReservedUsd(tx as Sql, {
      workspaceId: q.workspaceId,
      loopId: q.loopId,
    });
    let headroomUsd = reservationHeadroomUsd(
      reg,
      openReserved,
      q.floorUsd ?? LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
    );
    if (cycle !== undefined) {
      const runPrefix = `cycle:${cycle.runId.toLowerCase()}/`;
      const attemptPrefix = `${runPrefix}cap:${micros(cycle.budgetUsd)}/attempt:`;
      // OPEN rows hold their full reservation, even when a caller knows only
      // a usage subtotal. Every terminal disposition charges its actual use.
      // Mirror accumulate:false therefore cannot reopen this run's capacity.
      const history = (await tx`
        SELECT COALESCE(SUM(CASE WHEN status = 'open' THEN reserved_usd ELSE used_usd END), 0) AS committed_usd,
          COALESCE(BOOL_AND(reserved_usd >= 0 AND used_usd >= 0
            AND reserved_usd * 1000000 = TRUNC(reserved_usd * 1000000)
            AND used_usd * 1000000 = TRUNC(used_usd * 1000000)
            AND status IN ('open', 'settled', 'failed', 'cancelled')
            AND run_ref = ${attemptPrefix} || id::text), TRUE) AS complete
        FROM harness_shared.learning_spend_reservations
        WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId}
          AND run_ref LIKE ${runPrefix + '%'}`) as Row[];
      const committed = micros(Number(history[0]?.committed_usd));
      if (history[0]?.complete !== true || committed === null) return refuse('cycle-accounting-incomplete');
      headroomUsd = Math.max(0, micros(cycle.budgetUsd)! - committed) / 1_000_000;
    }
    if (exact && reg) {
      const cap = micros(reg.budgetUsd!), spent = micros(reg.spentUsd), open = micros(openReserved);
      const floor = micros(q.floorUsd ?? LEARNING_GOVERNOR_BUDGET_FLOOR_USD);
      if (cap === null || spent === null || open === null || floor === null ||
        !Number.isSafeInteger(spent + open + floor)) return refuse('invalid-exact-request');
      const remaining = cap - spent - open - floor;
      headroomUsd = Math.max(0, remaining) / 1_000_000;
      if (remaining < micros(q.requestedUsd)!) return refuse('insufficient-headroom', headroomUsd);
    }
    const plan = planReservation({ requestedUsd: q.requestedUsd, headroomUsd });
    if (!plan.ok) {
      return { ok: false, reason: plan.reason ?? 'no-headroom', requestedUsd: q.requestedUsd, headroomUsd };
    }
    const rows = (await tx`
      INSERT INTO harness_shared.learning_spend_reservations
        (id, workspace_id, loop_id, pot_slug, attempt_kind, requested_usd, reserved_usd,
         status, signal_origin, run_ref, note
         ${resources ? tx`, arm_id, reserved_input_tokens, reserved_output_tokens` : tx``})
      VALUES (${reservationId}, ${q.workspaceId}, ${q.loopId}, ${q.potSlug === undefined ? (reg?.potSlug ?? null) : q.potSlug},
        ${q.attemptKind ?? 'cycle'}, ${q.requestedUsd}, ${plan.reservedUsd},
        'open', ${q.signalOrigin ?? 'organic'},
        ${exact ? `manifest:${exact.binding}/attempt:${exact.reservationId.toLowerCase()}` : cycleRef ?? q.runRef ?? null}, ${q.note ?? null}
        ${resources ? tx`, ${resources.armId}, ${resources.inputTokens}, ${resources.outputTokens}` : tx``})
      ON CONFLICT (id) DO NOTHING
      RETURNING *`) as Row[];
    // A replay must not return an existing success: the caller could send a
    // second paid request on the same reservation. PK also arbitrates callers
    // using the same id under DIFFERENT registration-row locks.
    if (!rows[0]) return refuse('already-reserved', headroomUsd);
    return {
      ok: true,
      reservation: mapReservation(rows[0]),
      clamped: plan.clamped,
      headroomUsd,
    };
  };
  return typeof begin === 'function'
    ? ((await sql.begin(run)) as ReserveLearningSpendResult)
    : run(sql);
}

export interface SettleLearningSpendInput {
  workspaceId: string;
  reservationId: string;
  disposition: SpendDisposition;
  /** What was actually charged. Legacy rows default to 0. Exact rows require
   * an explicit nonnegative microdollar value; unknown charges stay OPEN. */
  usedUsd?: number;
  note?: string | null;
  /**
   * true (default): the charge also bumps the registration's spent_usd — the
   * path for loops whose only spend store is the governor. false: ledger the
   * event only (mirror-mode loops whose row spent syncs from their own store).
   * Exact lifetime reservations refuse false: releasing their reserved USD
   * without accumulating the charge would reopen already-spent headroom.
   */
  accumulate?: boolean;
}

export type SettleLearningSpendResult =
  | {
      ok: true;
      reservation: LearningSpendReservation;
      /** The charge event, when one was written (a zero-cost settlement writes none). */
      event: LearningSpendEvent | null;
      releasedUsd: number;
      overrunUsd: number;
    }
  | { ok: false; reason: 'not-found' | 'already-settled' | 'exact-settlement-required' | 'cycle-settlement-required'; reservation: LearningSpendReservation | null };

/**
 * Close one attempt — the ONLY way an attempt leaves 'open'. Idempotent by
 * construction: the row is taken FOR UPDATE and a non-'open' status returns
 * `already-settled` rather than charging twice, so a retried settlement after
 * a crash cannot double-bill.
 *
 * Money still lands on learning_spend_events (append-only, migration 244),
 * linked back by reservation_id; this row records the lifecycle. A settlement
 * that charged nothing writes NO event — the reservation row is itself the
 * record that the attempt happened and cost nothing, which is exactly the
 * cancelled/failed case the old `costUsd > 0` guards dropped on the floor.
 */
export async function settleLearningSpend(
  sql: Sql,
  q: SettleLearningSpendInput,
): Promise<SettleLearningSpendResult> {
  // Do not let a caller change the charge/workspace while the row lock awaits.
  q = { ...q };
  const begin = (sql as unknown as { begin?: unknown }).begin;
  const run = async (tx: Sql | TransactionSql): Promise<SettleLearningSpendResult> => {
    const rows = (await tx`
      SELECT * FROM harness_shared.learning_spend_reservations
       WHERE workspace_id = ${q.workspaceId} AND id = ${q.reservationId}
       FOR UPDATE`) as Row[];
    if (!rows[0]) return { ok: false, reason: 'not-found', reservation: null };
    const current = mapReservation(rows[0]);
    if (current.status !== 'open') {
      return { ok: false, reason: 'already-settled', reservation: current };
    }
    // Identify the original exact grant from durable provenance, not today's
    // registration settings, which may have changed since it was reserved.
    const exact = current.runRef !== null &&
      /^manifest:[a-f0-9]{64}\/attempt:/.test(current.runRef) &&
      current.runRef.slice(-current.id.length) === current.id;
    if (exact && (typeof begin !== 'function' || q.accumulate === false || exactUsdMicros(q.usedUsd) === null)) {
      return { ok: false, reason: 'exact-settlement-required', reservation: current };
    }
    if (current.runRef?.startsWith('cycle:')) {
      const parts = current.runRef.split('/');
      const scope = { runId: parts[0].slice(6), budgetUsd: Number(parts[1]?.slice(4)) / 1_000_000 };
      if (typeof begin !== 'function' || exactUsdMicros(q.usedUsd) === null ||
        current.runRef !== cycleReservationRunRef(scope, current.id)) {
        return { ok: false, reason: 'cycle-settlement-required', reservation: current };
      }
    }
    const settlement = settleReservation({
      reservedUsd: current.reservedUsd,
      disposition: q.disposition,
      ...(q.usedUsd === undefined ? {} : { usedUsd: q.usedUsd }),
    });
    const updated = (await tx`
      UPDATE harness_shared.learning_spend_reservations
         SET used_usd = ${settlement.usedUsd},
             status = ${settlement.status},
             note = COALESCE(${q.note ?? null}, note),
             settled_at = now()
       WHERE workspace_id = ${q.workspaceId} AND id = ${q.reservationId}
       RETURNING *`) as Row[];
    let event: LearningSpendEvent | null = null;
    if (settlement.usedUsd > 0) {
      const evRows = (await tx`
        INSERT INTO harness_shared.learning_spend_events
          (workspace_id, loop_id, pot_slug, cost_usd, signal_origin, run_ref, note, reservation_id)
        VALUES (${q.workspaceId}, ${current.loopId}, ${current.potSlug}, ${settlement.usedUsd},
          ${current.signalOrigin}, ${current.runRef}, ${q.note ?? current.note}, ${current.id})
        RETURNING *`) as Row[];
      event = mapEvent(evRows[0]);
      if (q.accumulate !== false) {
        await tx`
          UPDATE harness_shared.learning_governor_loops
             SET spent_usd = spent_usd + ${settlement.usedUsd}, updated_at = now()
           WHERE workspace_id = ${q.workspaceId} AND loop_id = ${current.loopId}`;
      }
    }
    return {
      ok: true,
      reservation: mapReservation(updated[0]),
      event,
      releasedUsd: settlement.releasedUsd,
      overrunUsd: settlement.overrunUsd,
    };
  };
  return typeof begin === 'function'
    ? ((await sql.begin(run)) as SettleLearningSpendResult)
    : run(sql);
}

export async function listLearningSpendReservations(
  sql: Sql,
  q: { workspaceId: string; loopId?: string; status?: SpendReservationStatus; limit?: number },
): Promise<LearningSpendReservation[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  try {
    const rows = (await sql`
      SELECT * FROM harness_shared.learning_spend_reservations
       WHERE workspace_id = ${q.workspaceId}
         ${q.loopId ? sql`AND loop_id = ${q.loopId}` : sql``}
         ${q.status ? sql`AND status = ${q.status}` : sql``}
       ORDER BY created_at DESC
       LIMIT ${limit}`) as Row[];
    return rows.map(mapReservation);
  } catch (e) {
    if (isUndefinedTable(e)) return [];
    throw e;
  }
}

/**
 * The four amounts, separately — requested / reserved / used / unsettled — for
 * a workspace, optionally narrowed to one loop or a time window.
 *
 * Returned in BOTH shapes on purpose: `positions` carries the governor's own
 * diagnostics (open and overrun attempt counts), and `spend` is the P-001
 * `LearningSpend` a learning contract embeds verbatim, so a candidate's spend
 * record is the governor's ledger rather than a number reassembled beside it.
 */
export async function getLearningSpendPositions(
  sql: Sql,
  q: { workspaceId: string; loopId?: string; sinceMs?: number },
): Promise<{ positions: LearningSpendPositions; spend: LearningSpend }> {
  let positions: LearningSpendPositions;
  try {
    const since = q.sinceMs === undefined ? null : new Date(q.sinceMs).toISOString();
    const rows = (await sql`
      SELECT requested_usd, reserved_usd, used_usd, status
        FROM harness_shared.learning_spend_reservations
       WHERE workspace_id = ${q.workspaceId}
         ${q.loopId ? sql`AND loop_id = ${q.loopId}` : sql``}
         ${since ? sql`AND created_at >= ${since}` : sql``}`) as Row[];
    positions = summarizeSpendPositions(
      rows.map((r) => ({
        requestedUsd: Number(r.requested_usd ?? 0),
        reservedUsd: Number(r.reserved_usd ?? 0),
        usedUsd: Number(r.used_usd ?? 0),
        status: str(r.status) as SpendReservationStatus,
      })),
    );
  } catch (e) {
    if (!isUndefinedTable(e)) throw e;
    positions = summarizeSpendPositions([]);
  }
  return { positions, spend: toLearningSpend(positions, new Date().toISOString()) };
}
