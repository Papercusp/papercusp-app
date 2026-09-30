/**
 * The Hive-evaluation RUN HARNESS (P-021): run the WHOLE Hive (Queen + bees) autonomously
 * on a seeded scenario to completion — or a bounded timeout — in an isolated throwaway hive,
 * and capture the raw run record. A sibling battery slice over the apiary/gym machinery
 * (D-006), NOT a new runner: it reuses the deterministic run-identity, the gym hermetic
 * isolation (via the live ports), and the eval-battery `Subject` seam.
 *
 * The harness is JUDGE-FREE (D-009): it boots → seeds → drives → captures → records. Scoring
 * (the LLM judge / composite / un-gameable gate) is HE-06, layered as a pass over the recorded
 * runs (each record carries the `distilledTrace` + observations a judge needs). HE-04/05 read
 * the observations to compute outcome/efficiency/speed metrics. The same boot/seed/drive/collect
 * path backs both the judge-free battery (this file's {@link runHiveScenarioOnce}) and the
 * eval-battery `Subject` adapter ({@link hiveScenarioSubject}) HE-06 hands to `runBattery`.
 *
 * I/O lives entirely behind {@link HiveRunPorts} — the unit tests inject deterministic fakes
 * ({@link makeFakeHivePorts}); the live binding is in live-ports.ts.
 */
import type { DistilledRun, Subject } from '@papercusp/eval-battery';
import { computeParallelismStructure, type HiveScenario, type ParallelismStructure } from './scenario';
import { hiveEvalRunIdentity, type HiveEvalRunIdentity } from './run-identity';
import type { HiveRunObservations, HiveRunTerminalState } from './store';
import type { Genome } from '../instance-spec/genome';

/** One cell the battery runs: a scenario × repeat against a fixed instance, with controls. */
export interface HiveScenarioCell {
  /** The code-generation instance under test (manifest instanceId). */
  instanceId: string;
  scenario: HiveScenario;
  /** Repeat index (P-022 variance sample). */
  repeat: number;
  /** Determinism controls (P-022). */
  seed: number;
  budgetUsdCap: number;
  beeCap: number;
  /** Per-cell wall-clock bound; falls back to the battery's defaultTimeoutMs. */
  timeoutMs?: number;
  /**
   * The config-variation the instance-under-test boots with — set by an experiment arm
   * (experiment-registry-invocation-api P-063/D-023): `genome` is the merged genome
   * (`genome.*` knobs) and `modelOverrides` is the spawn-time `model.<role>` axis (D-003).
   * The live `bootHive` applies these when standing up the throwaway hive. Absent for an
   * unvaried (champion) cell — the hive-eval loop's existing cells omit it.
   */
  variantConfig?: { genome?: Genome; modelOverrides?: Record<string, string> };
}

/** What `bootHive` returns — where + how to drive the throwaway hive. Opaque to the engine. */
export interface HiveBootResult {
  potSlug: string;
  /** The throwaway hive's repo checkout (acceptance/bug detection run here — HE-04). */
  repoPath: string;
  workspaceId: string;
  /** Implementation-private state threaded to seed/drive/collect/teardown. */
  handle?: unknown;
}

/** What `driveToCompletion` returns — the run's terminal disposition + raw counts. */
export interface DriveResult {
  terminalState: HiveRunTerminalState;
  frontierDrained: boolean;
  workItemsTotal: number;
  workItemsCompleted: number;
  costUsd: number;
}

/** The subject's run handle (THandle) — public fields + the boot/drive context it carries
 *  for collectAndDistill + teardown. The eval-battery engine treats this OPAQUELY. */
export interface HiveRunHandle {
  runId: string;
  instanceId: string;
  scenarioId: string;
  potSlug: string;
  terminalState: HiveRunTerminalState;
  /** Measured boot→drive wall-clock (ms). */
  wallClockMs: number;
  frontierDrained: boolean;
  costUsd: number;
  workItemsTotal: number;
  workItemsCompleted: number;
  startedAtMs: number;
  boot: HiveBootResult;
  drive: DriveResult;
}

/** The TSignals the subject's collectAndDistill yields — raw observations + the ideal. */
export interface HiveRunSignals {
  observations: HiveRunObservations;
  parallelism: ParallelismStructure;
}

/** The injectable I/O seam — the gym hermetic isolation + Queen drive live behind this. */
export interface HiveRunPorts {
  /** Stand up a throwaway hive over the scenario's sandbox (clone @ commit, register home). */
  bootHive(input: { scenario: HiveScenario; cell: HiveScenarioCell; identity: HiveEvalRunIdentity }): Promise<HiveBootResult>;
  /** Seed the scenario's work-item DAG (+ the planted defect is already in the cloned repo). */
  seedScenario(input: { scenario: HiveScenario; boot: HiveBootResult }): Promise<void>;
  /** Drive the whole Hive autonomously to completion or the bounded timeout. */
  driveToCompletion(input: {
    scenario: HiveScenario;
    boot: HiveBootResult;
    cell: HiveScenarioCell;
    timeoutMs: number;
  }): Promise<DriveResult>;
  /** Read the run's trace for the judge (HE-06) + the raw signals. No scoring here. */
  collectRunData(input: {
    scenario: HiveScenario;
    boot: HiveBootResult;
    drive: DriveResult;
    cell: HiveScenarioCell;
    maxChars: number;
  }): Promise<{ distilledTrace: string; traceRef: string; extra?: Record<string, unknown> }>;
  /** Best-effort teardown of the throwaway hive (drop schema + remove clone). */
  teardown(input: { boot: HiveBootResult }): Promise<void>;
  now(): number;
}

/** The fully-captured record of one scenario run — the harness's durable output. */
export interface HiveScenarioRunRecord {
  runId: string;
  instanceId: string;
  scenarioId: string;
  shape: HiveScenario['shape'];
  repeat: number;
  seed: number;
  budgetUsdCap: number;
  beeCap: number;
  startedAt: Date;
  finishedAt: Date;
  observations: HiveRunObservations;
  parallelism: ParallelismStructure;
  /** The distilled trace a downstream judge (HE-06) reads. */
  distilledTrace: string;
  traceRef: string;
}

export interface HiveRunOpts {
  /** Battery-default wall-clock bound when a cell doesn't set its own. */
  defaultTimeoutMs: number;
  /** Distilled-trace cap handed to collectRunData. */
  maxDistillChars: number;
}

const DEFAULT_OPTS: HiveRunOpts = { defaultTimeoutMs: 30 * 60_000, maxDistillChars: 8000 };

/** boot → seed → drive, with teardown-on-failure. Shared by the one-shot runner + subject. */
async function bootSeedDrive(
  cell: HiveScenarioCell,
  ports: HiveRunPorts,
  opts: HiveRunOpts,
): Promise<{ identity: HiveEvalRunIdentity; boot: HiveBootResult; drive: DriveResult; startedAtMs: number; wallClockMs: number }> {
  const identity = hiveEvalRunIdentity({
    instanceId: cell.instanceId,
    scenarioId: cell.scenario.id,
    repeat: cell.repeat,
    seed: cell.seed,
  });
  const startedAtMs = ports.now();
  let boot: HiveBootResult | undefined;
  try {
    boot = await ports.bootHive({ scenario: cell.scenario, cell, identity });
    await ports.seedScenario({ scenario: cell.scenario, boot });
    const timeoutMs = cell.timeoutMs ?? opts.defaultTimeoutMs;
    const drive = await ports.driveToCompletion({ scenario: cell.scenario, boot, cell, timeoutMs });
    const wallClockMs = Math.max(0, ports.now() - startedAtMs);
    return { identity, boot, drive, startedAtMs, wallClockMs };
  } catch (err) {
    if (boot) {
      try {
        await ports.teardown({ boot });
      } catch {
        /* best-effort — an infra failure tearing down must not mask the original error */
      }
    }
    throw err;
  }
}

function buildObservations(boot: HiveBootResult, drive: DriveResult, wallClockMs: number, extra?: Record<string, unknown>): HiveRunObservations {
  return {
    terminalState: drive.terminalState,
    wallClockMs,
    frontierDrained: drive.frontierDrained,
    workItemsTotal: drive.workItemsTotal,
    workItemsCompleted: drive.workItemsCompleted,
    costUsd: drive.costUsd,
    repoPath: boot.repoPath,
    extra,
  };
}

/**
 * Run the whole Hive on ONE scenario to completion / timeout, capture the record, tear down.
 * Returns a record for any RUN outcome (drained / timeout / failed); only INFRA failures
 * (boot/seed/collect) throw — the caller (battery) records those as errored.
 */
export async function runHiveScenarioOnce(
  cell: HiveScenarioCell,
  ports: HiveRunPorts,
  opts: HiveRunOpts = DEFAULT_OPTS,
): Promise<HiveScenarioRunRecord> {
  const { identity, boot, drive, startedAtMs, wallClockMs } = await bootSeedDrive(cell, ports, opts);
  let distilledTrace = '';
  let traceRef = '';
  let extra: Record<string, unknown> | undefined;
  try {
    const data = await ports.collectRunData({ scenario: cell.scenario, boot, drive, cell, maxChars: opts.maxDistillChars });
    distilledTrace = data.distilledTrace;
    traceRef = data.traceRef;
    extra = data.extra;
  } finally {
    try {
      await ports.teardown({ boot });
    } catch {
      /* best-effort */
    }
  }
  const finishedAtMs = ports.now();
  const parallelism = computeParallelismStructure(cell.scenario.workItems);
  return {
    runId: identity.runId,
    instanceId: cell.instanceId,
    scenarioId: cell.scenario.id,
    shape: cell.scenario.shape,
    repeat: cell.repeat,
    seed: cell.seed,
    budgetUsdCap: cell.budgetUsdCap,
    beeCap: cell.beeCap,
    startedAt: new Date(startedAtMs),
    finishedAt: new Date(finishedAtMs),
    observations: buildObservations(boot, drive, wallClockMs, extra),
    parallelism,
    distilledTrace,
    traceRef,
  };
}

/**
 * The eval-battery `Subject` adapter (D-009): the SAME boot/seed/drive/collect path as the
 * one-shot runner, split into the engine's run/collectAndDistill phases so HE-06 can hand it
 * straight to `runBattery(cells, { subject, llmCall, rubric })` to add scoring. `run` carries
 * the boot/drive context on the (opaque) handle; `collectAndDistill` reads + tears down.
 */
export function hiveScenarioSubject(
  ports: HiveRunPorts,
  opts: HiveRunOpts = DEFAULT_OPTS,
): Subject<HiveScenarioCell, HiveRunHandle, HiveRunSignals> {
  return {
    async run(cell) {
      const { identity, boot, drive, startedAtMs, wallClockMs } = await bootSeedDrive(cell, ports, opts);
      return {
        runId: identity.runId,
        instanceId: cell.instanceId,
        scenarioId: cell.scenario.id,
        potSlug: boot.potSlug,
        terminalState: drive.terminalState,
        wallClockMs,
        frontierDrained: drive.frontierDrained,
        costUsd: drive.costUsd,
        workItemsTotal: drive.workItemsTotal,
        workItemsCompleted: drive.workItemsCompleted,
        startedAtMs,
        boot,
        drive,
      };
    },
    async collectAndDistill({ handle, cell, maxChars }): Promise<DistilledRun<HiveRunSignals>> {
      try {
        const data = await ports.collectRunData({
          scenario: cell.scenario,
          boot: handle.boot,
          drive: handle.drive,
          cell,
          maxChars,
        });
        const parallelism = computeParallelismStructure(cell.scenario.workItems);
        const observations = buildObservations(handle.boot, handle.drive, handle.wallClockMs, data.extra);
        return {
          distilledTrace: data.distilledTrace,
          traceRef: data.traceRef,
          rawSignals: observations,
          signals: { observations, parallelism },
        };
      } finally {
        try {
          await ports.teardown({ boot: handle.boot });
        } catch {
          /* best-effort */
        }
      }
    },
    judgeInput(cell) {
      const items = cell.scenario.workItems.map((w) => `- ${w.id}: ${w.title}`).join('\n');
      return {
        intent: `Drive the Hive to complete scenario "${cell.scenario.title}" (${cell.scenario.shape}).\nWork-items:\n${items}\nKnown-good end state: ${cell.scenario.acceptance.description}.`,
        projectContext: '',
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Deterministic fake ports — for unit tests of the harness + battery (no live hive).
// ---------------------------------------------------------------------------------------

/** Per-cell scripted behavior for the fake hive. Omitted fields default to a clean drain. */
export interface FakeHiveBehavior {
  /** ms the fake clock advances during driveToCompletion (→ deterministic wallClockMs). */
  advanceMs?: number;
  terminalState?: HiveRunTerminalState;
  frontierDrained?: boolean;
  workItemsCompleted?: number;
  costUsd?: number;
  /** Throw at this phase to exercise the harness's infra-error + teardown paths. */
  throwAt?: 'boot' | 'seed' | 'drive' | 'collect';
}

export interface FakeHivePorts {
  ports: HiveRunPorts;
  booted: string[];
  seeded: string[];
  tornDown: string[];
}

/**
 * Build deterministic fake ports. `behavior(cell)` scripts each run; the fake owns a virtual
 * clock advanced only during driveToCompletion, so wallClockMs is exactly the scripted
 * advanceMs (default 1000). Tracks boot/seed/teardown calls so tests can assert no hive leaks.
 */
export function makeFakeHivePorts(behavior: (cell: HiveScenarioCell) => FakeHiveBehavior = () => ({})): FakeHivePorts {
  let clock = 0;
  const booted: string[] = [];
  const seeded: string[] = [];
  const tornDown: string[] = [];
  const ports: HiveRunPorts = {
    now: () => clock,
    async bootHive({ cell, identity }) {
      const b = behavior(cell);
      if (b.throwAt === 'boot') throw new Error(`fake boot failure for ${cell.scenario.id}`);
      booted.push(identity.potSlug);
      return { potSlug: identity.potSlug, repoPath: `/tmp/${identity.potSlug}`, workspaceId: 'ws-fake', handle: { cell } };
    },
    async seedScenario({ scenario, boot }) {
      const b = behavior((boot.handle as { cell: HiveScenarioCell }).cell);
      if (b.throwAt === 'seed') throw new Error(`fake seed failure for ${scenario.id}`);
      seeded.push(boot.potSlug);
    },
    async driveToCompletion({ scenario, cell }) {
      const b = behavior(cell);
      if (b.throwAt === 'drive') throw new Error(`fake drive failure for ${scenario.id}`);
      clock += b.advanceMs ?? 1000;
      const total = scenario.workItems.length;
      const completed = b.workItemsCompleted ?? total;
      const drained = b.frontierDrained ?? completed >= total;
      return {
        terminalState: b.terminalState ?? (drained ? 'drained' : 'timeout'),
        frontierDrained: drained,
        workItemsTotal: total,
        workItemsCompleted: completed,
        costUsd: b.costUsd ?? 0,
      };
    },
    async collectRunData({ cell }) {
      const b = behavior(cell);
      if (b.throwAt === 'collect') throw new Error(`fake collect failure for ${cell.scenario.id}`);
      return { distilledTrace: `fake trace for ${cell.scenario.id} r${cell.repeat}`, traceRef: `fake://${cell.scenario.id}/r${cell.repeat}` };
    },
    async teardown({ boot }) {
      tornDown.push(boot.potSlug);
    },
  };
  return { ports, booted, seeded, tornDown };
}

export { DEFAULT_OPTS as HIVE_RUN_DEFAULT_OPTS };
