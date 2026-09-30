/**
 * A valid physical Phase J input, shared by the Phase J unit tests and the
 * outer physical-evidence guard (hive-git-drill-zero-skip-guard.test.ts).
 * Every value is synthetic and deterministic. Timestamps are offsets in
 * seconds from `startMs`, and every one of them lies inside
 * [startMs, startMs + PHASE_J_FIXTURE_WINDOW_MS], so a caller can place the
 * whole leg inside an enclosing physical-run window by choosing `startMs`.
 * The real end-to-end leg is exercised by physical-drill-phase-j.integration.test.ts.
 */
import {
  PHASE_J_FAULT_SCHEMA,
  PHASE_J_FAULT_SQLSTATE,
  PHASE_J_FAULT_TABLE,
  PHASE_J_INPUT_SCHEMA,
  PHASE_J_OBSERVATION_SCHEMA,
  phaseJContentSha256,
  phaseJFaultMessage,
  phaseJFaultName,
  phaseJWriteSummary,
  phaseJWriteTitle,
  type PhaseJCursorRow,
  type PhaseJRow,
  type PhysicalPhaseJFault,
  type PhysicalPhaseJInput,
  type PhysicalPhaseJObservation,
  type PhysicalPhaseJStep,
  type PhysicalPhaseJWrite,
} from './physical-drill-phase-j';

export const PHASE_J_FIXTURE_LOG_KEY_HEX = 'ab'.repeat(32);
export const PHASE_J_FIXTURE_HELD_POSITION = 57;
export const PHASE_J_FIXTURE_FEATURE_IDS: Readonly<Record<PhysicalPhaseJWrite, string>> = { A: 'EI-101', B: 'EI-102' };
/** Every fixture timestamp lies within this many ms after `startMs`. */
export const PHASE_J_FIXTURE_WINDOW_MS = 300_000;

const HIVE = 'hello-world-3-pot';

export interface PhaseJFixtureOptions {
  runId: string;
  towerDeviceKey: string;
  vmDeviceKey: string;
  startMs: number;
}

/** The fixture's building blocks, so a test can mutate one sample coherently. */
export function phaseJFixture(options: PhaseJFixtureOptions) {
  const { runId, towerDeviceKey, vmDeviceKey, startMs } = options;
  const ids = PHASE_J_FIXTURE_FEATURE_IDS;
  const at = (s: number) => new Date(startMs + s * 1000).toISOString();

  const row = (write: PhysicalPhaseJWrite, author = towerDeviceKey): PhaseJRow => {
    const base = {
      featureId: ids[write],
      harnessSlug: HIVE,
      kind: 'task',
      title: phaseJWriteTitle(runId, write),
      summary: phaseJWriteSummary(runId, write),
    };
    return {
      ...base,
      authorPubkey: author,
      origin: author === towerDeviceKey ? 'remote' : 'local',
      contentSha256: phaseJContentSha256(base),
    };
  };

  const heldCursor = (attempts: number, overrides: Partial<PhaseJCursorRow> = {}): PhaseJCursorRow => ({
    harnessSlug: HIVE,
    logKeyHex: PHASE_J_FIXTURE_LOG_KEY_HEX,
    position: PHASE_J_FIXTURE_HELD_POSITION,
    peerDevicePubkey: towerDeviceKey,
    updatedAt: at(60),
    applyFailure: {
      position: PHASE_J_FIXTURE_HELD_POSITION,
      kind: 'retryable',
      groupKey: `engineer-issues::${HIVE}/${ids.A}`,
      reason: phaseJFaultMessage(runId),
      errorCode: PHASE_J_FAULT_SQLSTATE,
      attempts,
      firstSeenAt: startMs + 10_000,
      lastSeenAt: startMs + 70_000,
    },
    ...overrides,
  });

  const obs = (
    host: 'tower' | 'vm',
    step: PhysicalPhaseJStep,
    s: number,
    parts: Partial<PhysicalPhaseJObservation> = {},
  ): PhysicalPhaseJObservation => ({
    schemaVersion: PHASE_J_OBSERVATION_SCHEMA,
    hostId: host,
    step,
    runId,
    observedAt: at(s),
    observerPid: 900,
    writes: { A: { count: 0, row: null }, B: { count: 0, row: null } },
    cursors: [],
    faultPresent: false,
    ...parts,
  });

  const fault = (action: 'install' | 'remove', s: number): PhysicalPhaseJFault => ({
    schemaVersion: PHASE_J_FAULT_SCHEMA,
    hostId: 'vm',
    runId,
    action,
    name: phaseJFaultName(runId),
    table: PHASE_J_FAULT_TABLE,
    sqlstate: PHASE_J_FAULT_SQLSTATE,
    matchTitle: phaseJWriteTitle(runId, 'A'),
    at: at(s),
    presentAfter: action === 'install',
    presentBefore: action === 'remove',
  });

  const build = (): PhysicalPhaseJInput => {
    const both = (author?: string) => ({ A: { count: 1, row: row('A', author) }, B: { count: 1, row: row('B', author) } });
    return {
      schemaVersion: PHASE_J_INPUT_SCHEMA,
      runId,
      window: { startedAt: at(0), finishedAt: at(PHASE_J_FIXTURE_WINDOW_MS / 1000) },
      identities: { towerDeviceKey, vmDeviceKey },
      baseline: { tower: obs('tower', 'baseline', 1), vm: obs('vm', 'baseline', 1) },
      fault: { install: fault('install', 2), remove: fault('remove', 160) },
      authored: obs('tower', 'authored', 5, { writes: both(towerDeviceKey) }),
      held: [
        obs('vm', 'held', 40, { cursors: [heldCursor(3)], faultPresent: true }),
        obs('vm', 'held', 80, { cursors: [heldCursor(7)], faultPresent: true }),
      ],
      vmOwner: {
        before: { pid: 100, build: 'version:0.0.25', launcher: 'serve' },
        after: { pid: 200, build: 'version:0.0.25', launcher: 'serve' },
      },
      heldAfterRestart: obs('vm', 'held-after-restart', 150, { cursors: [heldCursor(2)], faultPresent: true }),
      replayed: obs('vm', 'replayed', 200, {
        writes: both(towerDeviceKey),
        cursors: [{ ...heldCursor(0), position: 60, applyFailure: null }],
      }),
    };
  };

  return { at, row, heldCursor, obs, fault, build };
}

export function buildPhysicalPhaseJInput(options: PhaseJFixtureOptions): PhysicalPhaseJInput {
  return phaseJFixture(options).build();
}
