/**
 * P-521 F4 physical Phase J: bounded target-apply outage, preserved cursor, replay.
 *
 * The TARGET is the VM's read-merge apply of the tower's peer log into VM
 * Postgres (`mergeAdmittedLogsIncremental`, P-515). The tower is the fleet's live
 * bg-host, so it is never frozen, restarted or faulted: it only authors two
 * run-bound work items (write A, then write B) through its production MCP verb,
 * and its production outbox/peer-log carries them to the VM.
 *
 * The outage is a fault on the VM's database, bounded in time and in scope. A
 * BEFORE trigger on `harness_shared.work_items` raises SQLSTATE 57P03
 * ("cannot connect now") for write A's run-bound title only. The production
 * projection rethrows it, read-merge classifies it as retryable, and the cursor
 * must HOLD at write A with a durable `apply_failure` record. Nothing else on the
 * VM is touched, and the trigger is removed on every exit path.
 *
 * Steps (the scenario performs the host mutation before each one):
 *   baseline           neither host has either write; no fault is installed
 *   authored (tower)   the tower's own rows for A and B, read back by title
 *   held (VM, sampled) A absent; the tower log's cursor is at or below A's
 *                      position; apply_failure names A, retryable 57P03, with
 *                      more attempts than the retired retry budget and a hold of
 *                      at least PHASE_J_MIN_HOLD_MS
 *   held-after-restart the VM owner restarted with the fault still in; the
 *                      durable cursor and failure still hold A
 *   replayed           the fault is gone; A and B arrived with the tower's exact
 *                      content, and the cursor moved past A's position
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { physicalDrillTarget, type PhysicalDrillHost } from './physical-drill-phase-a';

export const PHASE_J_OBSERVATION_SCHEMA = 'hive-git-physical-phase-j-observation/v1' as const;
export const PHASE_J_FAULT_SCHEMA = 'hive-git-physical-phase-j-fault/v1' as const;
export const PHASE_J_INPUT_SCHEMA = 'hive-git-physical-phase-j-input/v1' as const;
export const PHASE_J_RESULT_SCHEMA = 'hive-git-physical-phase-j-result/v1' as const;
export const PHASE_J_PLAN_ITEM = 'P-521' as const;
export const PHASE_J_WORKSPACE_ID = 'papercusp-workspace' as const;
export const PHASE_J_FAULT_TABLE = 'harness_shared.work_items' as const;
/** cannot_connect_now: an infrastructure failure, never the structural 23503. */
export const PHASE_J_FAULT_SQLSTATE = '57P03' as const;
/** The retry budget P-515 retired: after it, the old merge advanced past the op. */
export const PHASE_J_RETIRED_RETRY_BUDGET = 5;
export const PHASE_J_MIN_ATTEMPTS = PHASE_J_RETIRED_RETRY_BUDGET + 1;
export const PHASE_J_MIN_HOLD_MS = 60_000;
/** The outage is bounded: install to remove may not exceed this. */
export const PHASE_J_MAX_OUTAGE_MS = 20 * 60_000;
export const PHASE_J_STEPS = ['baseline', 'authored', 'held', 'held-after-restart', 'replayed'] as const;
export type PhysicalPhaseJStep = (typeof PHASE_J_STEPS)[number];
export const PHASE_J_WRITES = ['A', 'B'] as const;
export type PhysicalPhaseJWrite = (typeof PHASE_J_WRITES)[number];

const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;
const FEATURE_ID = /^[A-Z]{1,4}-[0-9]{1,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HOST_STEPS: Record<PhysicalDrillHost, readonly PhysicalPhaseJStep[]> = {
  tower: ['baseline', 'authored'],
  vm: ['baseline', 'held', 'held-after-restart', 'replayed'],
};

type Sql = postgres.Sql;
type Deps = { sql?: Sql; now?: () => number };

async function defaultSql(): Promise<Sql> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase J runId is invalid: ${runId}`);
}

/**
 * Word labels for the write titles. admissionIdentity() drops single-letter tokens, so
 * "write A" / "write B" reduce to ONE titleKey and work_items_keyless_title_identity_uq
 * refuses the second create (WI-10003961 rig attempt 2: write B never existed on the tower).
 */
export const PHASE_J_WRITE_TITLE_LABELS: Readonly<Record<PhysicalPhaseJWrite, string>> = { A: 'alpha', B: 'bravo' };

/** Deterministic, run-bound content for each write, so the verifier can recompute it. */
export function phaseJWriteTitle(runId: string, write: PhysicalPhaseJWrite): string {
  assertRunId(runId);
  return `P-521 F4 apply outage write ${PHASE_J_WRITE_TITLE_LABELS[write]} ${runId}`;
}

export function phaseJWriteSummary(runId: string, write: PhysicalPhaseJWrite): string {
  assertRunId(runId);
  return `P-521 physical Phase J write ${write}; nonce ${sha256(`p521-phase-j:${runId}:${write}`)}`;
}

export function phaseJFaultName(runId: string): string {
  assertRunId(runId);
  return `p521_phase_j_outage_${sha256(runId).slice(0, 12)}`;
}

export function phaseJFaultMessage(runId: string): string {
  return `p521 phase J bounded target-apply outage ${runId}`;
}

// ---------------------------------------------------------------------------
// Fault (VM only)
// ---------------------------------------------------------------------------

export type PhysicalPhaseJFault = {
  schemaVersion: typeof PHASE_J_FAULT_SCHEMA;
  hostId: 'vm';
  runId: string;
  action: 'install' | 'remove';
  name: string;
  table: typeof PHASE_J_FAULT_TABLE;
  sqlstate: typeof PHASE_J_FAULT_SQLSTATE;
  matchTitle: string;
  at: string;
  /** Measured from pg_trigger after the action, not assumed from its success. */
  presentAfter: boolean;
  presentBefore: boolean;
};

async function faultTriggers(sql: Sql, like: string): Promise<string[]> {
  const rows = await sql<{ tgname: string }[]>`
    SELECT t.tgname FROM pg_trigger t
     WHERE t.tgrelid = ${PHASE_J_FAULT_TABLE}::regclass AND NOT t.tgisinternal AND t.tgname LIKE ${like}
     ORDER BY t.tgname`;
  return rows.map((row) => row.tgname);
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function installPhysicalPhaseJFault(input: { runId: string }, deps: Deps = {}): Promise<PhysicalPhaseJFault> {
  const name = phaseJFaultName(input.runId);
  const matchTitle = phaseJWriteTitle(input.runId, 'A');
  const sql = deps.sql ?? (await defaultSql());
  const stale = await faultTriggers(sql, 'p521_phase_j_outage_%');
  if (stale.length > 0) {
    throw new Error(`physical Phase J refuses to install over existing outage triggers: ${stale.join(', ')} (remove them with phase-j-fault vm sweep)`);
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(`
      CREATE FUNCTION harness_shared.${name}() RETURNS trigger LANGUAGE plpgsql AS $phase_j$
      BEGIN
        IF NEW.title = ${quoteLiteral(matchTitle)} THEN
          RAISE EXCEPTION USING ERRCODE = ${quoteLiteral(PHASE_J_FAULT_SQLSTATE)},
            MESSAGE = ${quoteLiteral(phaseJFaultMessage(input.runId))};
        END IF;
        RETURN NEW;
      END
      $phase_j$`);
    await tx.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${PHASE_J_FAULT_TABLE}
      FOR EACH ROW EXECUTE FUNCTION harness_shared.${name}()`);
  });
  const presentAfter = (await faultTriggers(sql, name)).includes(name);
  if (!presentAfter) throw new Error(`physical Phase J fault ${name} is not present after install`);
  return {
    schemaVersion: PHASE_J_FAULT_SCHEMA, hostId: 'vm', runId: input.runId, action: 'install', name,
    table: PHASE_J_FAULT_TABLE, sqlstate: PHASE_J_FAULT_SQLSTATE, matchTitle,
    at: new Date((deps.now ?? Date.now)()).toISOString(), presentAfter, presentBefore: false,
  };
}

export async function removePhysicalPhaseJFault(input: { runId: string }, deps: Deps = {}): Promise<PhysicalPhaseJFault> {
  const name = phaseJFaultName(input.runId);
  const sql = deps.sql ?? (await defaultSql());
  const presentBefore = (await faultTriggers(sql, name)).includes(name);
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP TRIGGER IF EXISTS ${name} ON ${PHASE_J_FAULT_TABLE}`);
    await tx.unsafe(`DROP FUNCTION IF EXISTS harness_shared.${name}()`);
  });
  const presentAfter = (await faultTriggers(sql, name)).includes(name);
  if (presentAfter) throw new Error(`physical Phase J fault ${name} is still present after removal`);
  return {
    schemaVersion: PHASE_J_FAULT_SCHEMA, hostId: 'vm', runId: input.runId, action: 'remove', name,
    table: PHASE_J_FAULT_TABLE, sqlstate: PHASE_J_FAULT_SQLSTATE, matchTitle: phaseJWriteTitle(input.runId, 'A'),
    at: new Date((deps.now ?? Date.now)()).toISOString(), presentAfter, presentBefore,
  };
}

/** Recovery for a crashed run: drop every Phase J outage trigger and function. */
export async function sweepPhysicalPhaseJFaults(deps: Deps = {}): Promise<{ removed: string[]; remaining: string[] }> {
  const sql = deps.sql ?? (await defaultSql());
  const removed = await faultTriggers(sql, 'p521_phase_j_outage_%');
  for (const name of removed) {
    if (!/^p521_phase_j_outage_[0-9a-f]{12}$/.test(name)) throw new Error(`physical Phase J refuses to drop ${name}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(`DROP TRIGGER IF EXISTS ${name} ON ${PHASE_J_FAULT_TABLE}`);
      await tx.unsafe(`DROP FUNCTION IF EXISTS harness_shared.${name}()`);
    });
  }
  return { removed, remaining: await faultTriggers(sql, 'p521_phase_j_outage_%') };
}

// ---------------------------------------------------------------------------
// Observation (both hosts)
// ---------------------------------------------------------------------------

export type PhaseJRow = {
  featureId: string;
  harnessSlug: string;
  kind: string;
  title: string;
  summary: string | null;
  authorPubkey: string | null;
  origin: string | null;
  /** sha256 over the federated content this phase proves: id, scope, kind, title, summary. */
  contentSha256: string;
};

export type PhaseJApplyFailure = {
  position: number;
  kind: string;
  groupKey: string;
  reason: string;
  errorCode: string | null;
  attempts: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type PhaseJCursorRow = {
  harnessSlug: string;
  logKeyHex: string;
  position: number;
  peerDevicePubkey: string | null;
  updatedAt: string;
  applyFailure: PhaseJApplyFailure | null;
};

export type PhysicalPhaseJObservation = {
  schemaVersion: typeof PHASE_J_OBSERVATION_SCHEMA;
  hostId: PhysicalDrillHost;
  step: PhysicalPhaseJStep;
  runId: string;
  observedAt: string;
  observerPid: number;
  /** Rows carrying each write's run-bound title; more than one is itself evidence of a defect. */
  writes: Record<PhysicalPhaseJWrite, { count: number; row: PhaseJRow | null }>;
  /** VM only: the pot's merge cursors, plus any cursor whose failure names a run write. */
  cursors: PhaseJCursorRow[];
  faultPresent: boolean;
};

export function phaseJContentSha256(row: Pick<PhaseJRow, 'featureId' | 'harnessSlug' | 'kind' | 'title' | 'summary'>): string {
  return sha256(JSON.stringify([row.featureId, row.harnessSlug, row.kind, row.title, row.summary]));
}

function finiteNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : Number.NaN;
}

function applyFailureOf(raw: unknown): PhaseJApplyFailure | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  return {
    position: finiteNumber(f.position),
    kind: String(f.kind ?? ''),
    groupKey: String(f.groupKey ?? ''),
    reason: String(f.reason ?? ''),
    errorCode: typeof f.errorCode === 'string' ? f.errorCode : null,
    attempts: finiteNumber(f.attempts),
    firstSeenAt: finiteNumber(f.firstSeenAt),
    lastSeenAt: finiteNumber(f.lastSeenAt),
  };
}

export function assertPhysicalPhaseJStep(hostId: string, step: string): asserts step is PhysicalPhaseJStep {
  if (hostId !== 'tower' && hostId !== 'vm') throw new Error(`physical Phase J host must be tower|vm: ${hostId}`);
  if (!HOST_STEPS[hostId].includes(step as PhysicalPhaseJStep)) {
    throw new Error(`physical Phase J ${hostId} step must be one of ${HOST_STEPS[hostId].join('|')}: ${step}`);
  }
}

export async function observePhysicalPhaseJ(
  input: { hostId: PhysicalDrillHost; step: string; runId: string; featureIds?: string[] },
  deps: Deps = {},
): Promise<PhysicalPhaseJObservation> {
  assertPhysicalPhaseJStep(input.hostId, input.step);
  assertRunId(input.runId);
  const featureIds = input.featureIds ?? [];
  for (const id of featureIds) if (!FEATURE_ID.test(id)) throw new Error(`physical Phase J feature id is invalid: ${id}`);
  const sql = deps.sql ?? (await defaultSql());
  const titles = PHASE_J_WRITES.map((w) => phaseJWriteTitle(input.runId, w));
  const rows = await sql<{
    feature_id: string; harness_slug: string; item_kind: string; title: string; summary: string | null;
    author_pubkey: string | null; origin: string | null;
  }[]>`
    SELECT feature_id, harness_slug, item_kind, title, summary, author_pubkey, origin
      FROM harness_shared.work_items
     WHERE title = ANY(${titles}::text[])
     ORDER BY feature_id`;
  const writes = Object.fromEntries(PHASE_J_WRITES.map((write, i) => {
    const matches = rows.filter((r) => r.title === titles[i]);
    const r = matches[0];
    const row: PhaseJRow | null = r ? {
      featureId: r.feature_id, harnessSlug: r.harness_slug, kind: r.item_kind, title: r.title, summary: r.summary,
      authorPubkey: r.author_pubkey, origin: r.origin,
      contentSha256: phaseJContentSha256({ featureId: r.feature_id, harnessSlug: r.harness_slug, kind: r.item_kind, title: r.title, summary: r.summary }),
    } : null;
    return [write, { count: matches.length, row }];
  })) as PhysicalPhaseJObservation['writes'];

  let cursors: PhaseJCursorRow[] = [];
  if (input.hostId === 'vm') {
    const named = featureIds.map((id) => `%/${id}"%`);
    const cursorRows = await sql<{
      harness_slug: string; log_keyhex: string; position: string; peer_device_pubkey: string | null;
      updated_at: Date; apply_failure: unknown;
    }[]>`
      SELECT harness_slug, log_keyhex, position::text AS position, peer_device_pubkey, updated_at, apply_failure
        FROM harness_shared.substrate_merge_cursor
       WHERE workspace_id = ${PHASE_J_WORKSPACE_ID}
         AND (harness_slug = ${physicalDrillTarget().potHome} OR apply_failure::text LIKE ANY(${named}::text[]))
       ORDER BY harness_slug, log_keyhex`;
    cursors = cursorRows.map((c) => ({
      harnessSlug: c.harness_slug,
      logKeyHex: c.log_keyhex,
      position: finiteNumber(c.position),
      peerDevicePubkey: c.peer_device_pubkey,
      updatedAt: new Date(c.updated_at).toISOString(),
      applyFailure: applyFailureOf(c.apply_failure),
    }));
  }
  const faultPresent = (await faultTriggers(sql, 'p521_phase_j_outage_%')).length > 0;
  return {
    schemaVersion: PHASE_J_OBSERVATION_SCHEMA,
    hostId: input.hostId,
    step: input.step,
    runId: input.runId,
    observedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    observerPid: process.pid,
    writes,
    cursors,
    faultPresent,
  };
}

/** The cursor whose durable failure names this feature id (the id is the key's last segment). */
export function phaseJFailingCursor(observation: PhysicalPhaseJObservation, featureId: string): PhaseJCursorRow | null {
  return observation.cursors.find((c) => c.applyFailure?.groupKey.endsWith(`/${featureId}`)) ?? null;
}

/**
 * What a step still waits for. Empty means the host reached the state the step
 * needs; the CLI exits "incomplete" (3) otherwise so the scenario can re-sample.
 * A state that can never become valid (A materialized under the fault) is NOT a
 * lag: it is returned as ready and the verifier rejects it with the evidence.
 */
export function phaseJLag(
  observation: PhysicalPhaseJObservation,
  expect: { featureIdA?: string; logKeyHex?: string; heldPosition?: number },
): string[] {
  const lag: string[] = [];
  if (observation.step === 'held' || observation.step === 'held-after-restart') {
    if (observation.writes.A.row) return lag;
    if (!expect.featureIdA) return ['featureIdA is required'];
    const failing = phaseJFailingCursor(observation, expect.featureIdA);
    if (!failing?.applyFailure) return ['no durable apply_failure names write A yet'];
    if (observation.step === 'held') {
      if (failing.applyFailure.attempts < PHASE_J_MIN_ATTEMPTS) {
        lag.push(`attempts ${failing.applyFailure.attempts} < ${PHASE_J_MIN_ATTEMPTS}`);
      }
      const heldMs = Date.parse(observation.observedAt) - failing.applyFailure.firstSeenAt;
      if (!(heldMs >= PHASE_J_MIN_HOLD_MS)) lag.push(`held ${heldMs}ms < ${PHASE_J_MIN_HOLD_MS}ms`);
    }
    return lag;
  }
  if (observation.step === 'replayed') {
    for (const write of PHASE_J_WRITES) if (!observation.writes[write].row) lag.push(`write ${write} has not arrived`);
    if (!expect.logKeyHex || !Number.isSafeInteger(expect.heldPosition)) return [...lag, 'logKeyHex and heldPosition are required'];
    const cursor = observation.cursors.find((c) => c.logKeyHex === expect.logKeyHex);
    if (!cursor || !(cursor.position > expect.heldPosition!)) lag.push(`cursor ${cursor?.position ?? 'missing'} has not passed ${expect.heldPosition}`);
    if (expect.featureIdA && phaseJFailingCursor(observation, expect.featureIdA)) lag.push('apply_failure for write A is not cleared');
  }
  return lag;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type PhaseJOwnerIdentity = { pid: number; build: string; launcher: string };

export type PhysicalPhaseJInput = {
  schemaVersion: typeof PHASE_J_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  baseline: { tower: PhysicalPhaseJObservation; vm: PhysicalPhaseJObservation };
  fault: { install: PhysicalPhaseJFault; remove: PhysicalPhaseJFault };
  authored: PhysicalPhaseJObservation;
  /** Every held sample the scenario took, in order; the last one met the lag contract. */
  held: PhysicalPhaseJObservation[];
  vmOwner: { before: PhaseJOwnerIdentity; after: PhaseJOwnerIdentity };
  heldAfterRestart: PhysicalPhaseJObservation;
  replayed: PhysicalPhaseJObservation;
};

export type PhysicalPhaseJVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_J_RESULT_SCHEMA;
    phase: 'J';
    planItem: typeof PHASE_J_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      boundedTargetApplyOutage: true;
      unappliedOperationRetainedDurably: true;
      cursorHeldBeyondRetiredRetryBudget: true;
      holdSurvivedOwnerRestart: true;
      replayDeliveredExactWrite: true;
      cursorAdvancedOnlyAfterReplay: true;
    };
    identities: {
      logKeyHex: string;
      heldPosition: number;
      attemptsBeforeRestart: number;
      outageMs: number;
      featureIds: Record<PhysicalPhaseJWrite, string>;
      writeBMaterializedDuringHold: boolean;
    };
  };
};

function time(value: string | undefined, label: string, errors: string[]): number {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

function checkObservation(
  label: string,
  o: PhysicalPhaseJObservation | undefined,
  host: PhysicalDrillHost,
  step: PhysicalPhaseJStep,
  runId: string,
  errors: string[],
): o is PhysicalPhaseJObservation {
  if (!o || o.schemaVersion !== PHASE_J_OBSERVATION_SCHEMA) { errors.push(`${label}: missing or wrong-schema observation`); return false; }
  if (o.hostId !== host || o.step !== step) errors.push(`${label}: expected ${host}/${step}, got ${o.hostId}/${o.step}`);
  if (o.runId !== runId) errors.push(`${label}: observation is not bound to this run`);
  for (const write of PHASE_J_WRITES) if ((o.writes?.[write]?.count ?? 0) > 1) errors.push(`${label}: write ${write} matched ${o.writes[write].count} rows`);
  return true;
}

function checkHeld(
  label: string,
  o: PhysicalPhaseJObservation,
  featureIdA: string,
  logKeyHex: string,
  heldPosition: number,
  errors: string[],
): PhaseJApplyFailure | null {
  if (o.writes.A.row) errors.push(`${label}: write A materialized on the VM during the outage`);
  if (!o.faultPresent) errors.push(`${label}: the outage fault was not in place`);
  const cursor = o.cursors.find((c) => c.logKeyHex === logKeyHex);
  if (!cursor) { errors.push(`${label}: the tower log's cursor row is missing`); return null; }
  if (!(cursor.position <= heldPosition)) errors.push(`${label}: cursor ${cursor.position} advanced past the missing write at ${heldPosition}`);
  const f = cursor.applyFailure;
  if (!f || !f.groupKey.endsWith(`/${featureIdA}`)) { errors.push(`${label}: durable apply_failure does not name write A`); return null; }
  if (f.position !== heldPosition) errors.push(`${label}: apply_failure moved from position ${heldPosition} to ${f.position}`);
  if (f.kind !== 'retryable') errors.push(`${label}: apply_failure kind ${f.kind} is not retryable`);
  if (f.errorCode !== PHASE_J_FAULT_SQLSTATE) errors.push(`${label}: apply_failure errorCode ${f.errorCode} is not the fault's ${PHASE_J_FAULT_SQLSTATE}`);
  if (!f.reason.includes(phaseJFaultMessage(o.runId))) errors.push(`${label}: apply_failure reason does not carry the run's fault message`);
  if (!(f.attempts > 0)) errors.push(`${label}: apply_failure attempts must be positive`);
  return f;
}

export function validatePhysicalPhaseJ(input: PhysicalPhaseJInput): PhysicalPhaseJVerdict {
  const errors: string[] = [];
  const fail = (): PhysicalPhaseJVerdict => ({ ok: false, errors, result: null });
  if (input?.schemaVersion !== PHASE_J_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_J_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input?.runId ?? '')) errors.push('runId is invalid');
  const { towerDeviceKey, vmDeviceKey } = input?.identities ?? ({} as PhysicalPhaseJInput['identities']);
  if (!towerDeviceKey || !vmDeviceKey || towerDeviceKey === vmDeviceKey) errors.push('tower and VM device keys must be distinct');
  if (!Array.isArray(input?.held) || input.held.length === 0) errors.push('held: at least one sample is required');
  if (errors.length) return fail();
  const { runId } = input;

  const ok = [
    checkObservation('baseline tower', input.baseline?.tower, 'tower', 'baseline', runId, errors),
    checkObservation('baseline vm', input.baseline?.vm, 'vm', 'baseline', runId, errors),
    checkObservation('authored', input.authored, 'tower', 'authored', runId, errors),
    ...input.held.map((o, i) => checkObservation(`held[${i}]`, o, 'vm', 'held', runId, errors)),
    checkObservation('held-after-restart', input.heldAfterRestart, 'vm', 'held-after-restart', runId, errors),
    checkObservation('replayed', input.replayed, 'vm', 'replayed', runId, errors),
  ].every(Boolean);
  const { install, remove } = input.fault ?? ({} as PhysicalPhaseJInput['fault']);
  for (const [label, f, action] of [['fault install', install, 'install'], ['fault remove', remove, 'remove']] as const) {
    if (f?.schemaVersion !== PHASE_J_FAULT_SCHEMA || f.action !== action || f.runId !== runId) errors.push(`${label}: missing or not bound to this run`);
    else if (f.name !== phaseJFaultName(runId) || f.matchTitle !== phaseJWriteTitle(runId, 'A') || f.sqlstate !== PHASE_J_FAULT_SQLSTATE) {
      errors.push(`${label}: fault identity is not this run's write-A outage`);
    }
  }
  if (install && !install.presentAfter) errors.push('fault install: trigger was not measured present');
  if (remove && (remove.presentAfter || !remove.presentBefore)) errors.push('fault remove: trigger was not measured present before and absent after');
  if (!ok || errors.length) return fail();

  // Causal order, all on one timeline: baseline -> install -> authored -> held... ->
  // restart -> held-after-restart -> remove -> replayed.
  let cursor = time(input.window.startedAt, 'window.startedAt', errors);
  const ordered: Array<[string, string]> = [
    ['baseline tower', input.baseline.tower.observedAt], ['baseline vm', input.baseline.vm.observedAt],
    ['fault install', install.at], ['authored', input.authored.observedAt],
    ...input.held.map((o, i): [string, string] => [`held[${i}]`, o.observedAt]),
    ['held-after-restart', input.heldAfterRestart.observedAt], ['fault remove', remove.at],
    ['replayed', input.replayed.observedAt],
  ];
  for (const [label, at] of ordered) {
    const t = time(at, label, errors);
    if (t < cursor) errors.push(`${label}: evidence is out of causal order`);
    cursor = Math.max(cursor, t);
  }
  if (time(input.window.finishedAt, 'window.finishedAt', errors) < cursor) errors.push('window closes before its evidence');
  const outageMs = Date.parse(remove.at) - Date.parse(install.at);
  if (!(outageMs > 0 && outageMs <= PHASE_J_MAX_OUTAGE_MS)) errors.push(`outage ${outageMs}ms is not bounded by ${PHASE_J_MAX_OUTAGE_MS}ms`);
  if (errors.length) return fail();

  // Baseline: neither write exists anywhere; no fault anywhere.
  for (const [label, o] of [['baseline tower', input.baseline.tower], ['baseline vm', input.baseline.vm]] as const) {
    for (const write of PHASE_J_WRITES) if (o.writes[write].count !== 0) errors.push(`${label}: write ${write} already exists`);
    if (o.faultPresent) errors.push(`${label}: an outage fault was already installed`);
  }
  // Authored: the tower's own rows, with the run's deterministic content, and never faulted.
  const towerRows = {} as Record<PhysicalPhaseJWrite, PhaseJRow>;
  for (const write of PHASE_J_WRITES) {
    const row = input.authored.writes[write].row;
    if (!row) { errors.push(`authored: tower has no row for write ${write}`); continue; }
    if (!FEATURE_ID.test(row.featureId)) errors.push(`authored: write ${write} feature id ${row.featureId} is malformed`);
    if (row.title !== phaseJWriteTitle(runId, write) || row.summary !== phaseJWriteSummary(runId, write)) {
      errors.push(`authored: write ${write} does not carry the run's deterministic content`);
    }
    const testHive = physicalDrillTarget().potHome;
    if (row.harnessSlug !== testHive) errors.push(`authored: write ${write} is not in the test hive ${testHive}`);
    if (!SHA256.test(row.contentSha256) || row.contentSha256 !== phaseJContentSha256(row)) errors.push(`authored: write ${write} content digest is wrong`);
    towerRows[write] = row;
  }
  if (input.authored.faultPresent) errors.push('authored: the tower carries an outage fault');
  if (errors.length) return fail();

  // Held: the tower log's cursor stays at or below A for the whole outage.
  const featureIdA = towerRows.A.featureId;
  const last = input.held[input.held.length - 1]!;
  const failingNow = phaseJFailingCursor(last, featureIdA);
  if (!failingNow?.applyFailure) return (errors.push('held: the final sample has no durable apply_failure naming write A'), fail());
  const logKeyHex = failingNow.logKeyHex;
  const heldPosition = failingNow.applyFailure.position;
  if (!Number.isSafeInteger(heldPosition) || heldPosition < 0) return (errors.push('held: failed position is not a log index'), fail());
  let writeBMaterializedDuringHold = false;
  for (const [i, sample] of input.held.entries()) {
    const f = checkHeld(`held[${i}]`, sample, featureIdA, logKeyHex, heldPosition, errors);
    if (sample.writes.B.row) writeBMaterializedDuringHold = true;
    if (!f && i === input.held.length - 1) errors.push('held: the final sample did not retain the unapplied operation');
  }
  const lastFailure = failingNow.applyFailure;
  if (lastFailure.attempts < PHASE_J_MIN_ATTEMPTS) {
    errors.push(`held: ${lastFailure.attempts} attempts do not exceed the retired retry budget of ${PHASE_J_RETIRED_RETRY_BUDGET}`);
  }
  const heldMs = Date.parse(last.observedAt) - lastFailure.firstSeenAt;
  if (!(heldMs >= PHASE_J_MIN_HOLD_MS)) errors.push(`held: the hold lasted ${heldMs}ms < ${PHASE_J_MIN_HOLD_MS}ms`);
  if (!(lastFailure.firstSeenAt >= Date.parse(install.at))) errors.push('held: the failure predates the fault install');
  if (towerDeviceKey && failingNow.peerDevicePubkey && failingNow.peerDevicePubkey !== towerDeviceKey) {
    errors.push(`held: the held log belongs to ${failingNow.peerDevicePubkey}, not the tower`);
  }

  // Restart: same artifact, new process; the durable hold survives it.
  const { before, after } = input.vmOwner ?? ({} as PhysicalPhaseJInput['vmOwner']);
  if (!before || !after || after.pid === before.pid || !before.build || after.build !== before.build || after.launcher !== before.launcher) {
    errors.push('held-after-restart: VM owner was not restarted on the same artifact and launcher');
  }
  checkHeld('held-after-restart', input.heldAfterRestart, featureIdA, logKeyHex, heldPosition, errors);
  if (input.heldAfterRestart.writes.B.row) writeBMaterializedDuringHold = true;

  // Replay: the exact tower content arrived, and only then did the cursor pass A.
  const replayed = input.replayed;
  if (replayed.faultPresent) errors.push('replayed: the outage fault is still installed');
  for (const write of PHASE_J_WRITES) {
    const row = replayed.writes[write].row;
    if (!row) { errors.push(`replayed: write ${write} did not arrive`); continue; }
    if (row.contentSha256 !== phaseJContentSha256(row)) errors.push(`replayed: write ${write} content digest is wrong`);
    if (row.featureId !== towerRows[write].featureId || row.contentSha256 !== towerRows[write].contentSha256) {
      errors.push(`replayed: write ${write} is not the tower's exact write`);
    }
    if (!row.authorPubkey || row.authorPubkey === vmDeviceKey) errors.push(`replayed: write ${write} carries no remote author provenance`);
    if (towerRows[write].authorPubkey && row.authorPubkey !== towerRows[write].authorPubkey) {
      errors.push(`replayed: write ${write} author ${row.authorPubkey} is not the tower's ${towerRows[write].authorPubkey}`);
    }
  }
  const replayCursor = replayed.cursors.find((c) => c.logKeyHex === logKeyHex);
  if (!replayCursor || !(replayCursor.position > heldPosition)) errors.push('replayed: the cursor did not advance past the replayed write');
  if (phaseJFailingCursor(replayed, featureIdA)) errors.push('replayed: apply_failure for write A was not cleared');
  if (errors.length) return fail();

  return {
    ok: true,
    errors: [],
    result: {
      schemaVersion: PHASE_J_RESULT_SCHEMA,
      phase: 'J',
      planItem: PHASE_J_PLAN_ITEM,
      status: 'complete',
      complete: true,
      missingAssertions: [],
      observedAt: replayed.observedAt,
      assertions: {
        boundedTargetApplyOutage: true,
        unappliedOperationRetainedDurably: true,
        cursorHeldBeyondRetiredRetryBudget: true,
        holdSurvivedOwnerRestart: true,
        replayDeliveredExactWrite: true,
        cursorAdvancedOnlyAfterReplay: true,
      },
      identities: {
        logKeyHex,
        heldPosition,
        attemptsBeforeRestart: lastFailure.attempts,
        outageMs,
        featureIds: { A: towerRows.A.featureId, B: towerRows.B.featureId },
        writeBMaterializedDuringHold,
      },
    },
  };
}

/** Stable digest of the verify input, for the evidence manifest. */
export function physicalPhaseJInputDigest(input: PhysicalPhaseJInput): string {
  return sha256(JSON.stringify(input));
}
