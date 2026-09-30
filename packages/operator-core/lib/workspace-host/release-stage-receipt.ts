/**
 * Bind a workspace-host outcome to the release task it is evidence for, and record it as a release
 * journal stage through the MAINTAINED writer (`beginReleaseTaskStage` / `settleReleaseTaskStage`),
 * never by hand-appending to the ledger (D-391, D-394).
 *
 * Every BYOC milestone after publication — root bootstrap, fixed-agent initialization, customer
 * acceptance, the 24h soak, the teardown census, billing closure — is an outcome OBSERVED on a host
 * that runs one release's exact bundle. So every one binds the same way: an explicitly named release
 * task (the readiness reader selects one task explicitly too; there is no digest -> task discovery),
 * and the host's runtime bundle digest must equal the release's.
 *
 * ## Where the bundle digest comes from
 *
 * A publication-only task pins the digest in `artifactIdentity.bundleSha256`. A MANAGED cut cannot:
 * its journal is seeded before the build exists, with a label identity (source/version/channel), and
 * the digest first appears on its committed `release.build.*` receipt. Both are read here, together
 * with every committed publication receipt, and they must name exactly ONE digest — two digests on
 * one release is a journal that describes two different builds, and no stage may bind to it.
 *
 * A stage identity is the RELEASE-level claim ("bundle B passed stage S under inputs I"), so it names
 * the bundle and the stage's own inputs only. Which host, incarnation and run produced the evidence
 * are evidence refs: keying the identity on the host would make a failed stage impossible to retry
 * on another machine.
 */
import {
  beginReleaseTaskStage,
  inspectReleaseTaskStage,
  settleReleaseTaskStage,
  type ReleaseTaskLedger,
  type ReleaseTaskStageContext,
  type ReleaseTaskStageInput,
} from '../../../../scripts/lib/release-task-journal.mjs';
import {
  appendTaskReleaseReceipt,
  getTask,
  taskReleaseJournalFromDetail,
  type TaskReleaseJournal,
} from '../task-manager/store';
import { readWorkspaceHostRuntimeRelease } from './soak-store';

/** Journal channel label for digest-identified workspace-host releases (hash preimage only). */
export const WORKSPACE_HOST_RELEASE_CHANNEL = 'workspace-host';

const DIGEST = /^[0-9a-f]{64}$/;
/** `bundle:sha256:<d>` is what a build or upload names; `provider:bundle:<d>` what finalization confirmed. */
const BUNDLE_REF = /^(?:bundle:sha256|provider:bundle):([0-9a-f]{64})$/;

export type WorkspaceHostReleaseBindingFailure =
  | 'task-not-found'
  | 'journal-missing'
  | 'bundle-unrecorded'
  | 'bundle-ambiguous'
  | 'bundle-mismatch'
  | 'source-unrecorded'
  | 'artifact-unidentified'
  | 'stage-unobservable'
  | 'stage-committed'
  | 'stage-refused';

export class WorkspaceHostReleaseBindingError extends Error {
  constructor(
    readonly reason: WorkspaceHostReleaseBindingFailure,
    readonly stage: string,
    detail: string,
  ) {
    super(`Cannot record ${stage}: ${detail}`);
    this.name = 'WorkspaceHostReleaseBindingError';
  }
}

export interface WorkspaceHostReleaseBinding {
  taskId: string;
  operationId: string;
  bundleSha256: string;
  sourceSha: string;
  gitlinks: Record<string, string>;
  /** A label only for a digest-identified journal; the journal's own artifact version otherwise. */
  version: string;
  /**
   * Present only when the journal identifies its artifact by LABEL (a managed cut, D-394). Absent
   * means digest-identified — which every binding persisted before D-394 was (a running soak holds
   * one as workflow input), so its request identity must keep resolving exactly as it did then.
   */
  artifactLabel?: { channel: string };
}

/** One stage a workspace-host outcome records: its journal name and its own inputs. */
export interface WorkspaceHostReleaseStage {
  stage: string;
  identity: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function defaultLedger(): ReleaseTaskLedger {
  return { getTask: (taskId) => getTask(taskId), taskReleaseJournalFromDetail, appendTaskReleaseReceipt };
}

/**
 * Every bundle digest the journal names: its pinned artifact identity, plus the bundle refs on its
 * COMMITTED build and publication receipts. An intent or a refused attempt proves nothing about
 * which bytes the release is, so only committed receipts count.
 */
export function releaseJournalBundleDigests(journal: TaskReleaseJournal): string[] {
  const found = new Set<string>();
  const pinned = record(journal.artifactIdentity)?.bundleSha256;
  if (typeof pinned === 'string' && DIGEST.test(pinned)) found.add(pinned);
  for (const receipt of journal.receipts) {
    if (receipt.state !== 'committed') continue;
    if (!receipt.stage.startsWith('release.build.') && !receipt.stage.startsWith('publish.')) continue;
    for (const ref of receipt.evidenceRefs) {
      const match = BUNDLE_REF.exec(ref);
      if (match) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/**
 * Bind an outcome to the release task it is evidence for. The host must be RUNNING that release's
 * exact bundle: an outcome observed on a machine that runs other bytes says nothing about this
 * release.
 */
export async function resolveWorkspaceHostReleaseBinding(input: {
  releaseTaskId: string;
  stage: string;
  hostRuntimeRelease: unknown;
  ledger?: ReleaseTaskLedger;
}): Promise<WorkspaceHostReleaseBinding> {
  const ledger = input.ledger ?? defaultLedger();
  const fail = (reason: WorkspaceHostReleaseBindingFailure, detail: string) =>
    new WorkspaceHostReleaseBindingError(reason, input.stage, detail);

  const task = await ledger.getTask(input.releaseTaskId);
  if (!task) throw fail('task-not-found', `no task '${input.releaseTaskId}'`);
  const journal = ledger.taskReleaseJournalFromDetail(task.detail);
  if (!journal) throw fail('journal-missing', `task '${input.releaseTaskId}' has no release journal`);

  const artifact = record(journal.artifactIdentity);
  const pinned = artifact?.bundleSha256;
  if (pinned !== undefined && (typeof pinned !== 'string' || !DIGEST.test(pinned))) {
    throw fail('bundle-unrecorded', 'the release journal pins a malformed bundle digest');
  }
  const digests = releaseJournalBundleDigests(journal);
  if (digests.length === 0) {
    throw fail(
      'bundle-unrecorded',
      'the release journal names no bundle digest: neither its artifact identity nor a committed build or publication receipt',
    );
  }
  if (digests.length > 1) {
    throw fail('bundle-ambiguous', `the release journal names ${digests.length} bundle digests: ${digests.join(', ')}`);
  }
  const bundleSha256 = digests[0]!;

  const runtime = record(input.hostRuntimeRelease);
  if (runtime?.bundleSha256 !== bundleSha256) {
    throw fail(
      'bundle-mismatch',
      `the host runs bundle ${String(runtime?.bundleSha256 ?? 'unknown')}, the release is ${bundleSha256}`,
    );
  }
  const source = record(journal.source);
  const gitlinks = record(source?.gitlinks);
  if (typeof source?.sha !== 'string' || !gitlinks) {
    throw fail('source-unrecorded', 'the release journal records no source identity');
  }
  const binding = {
    taskId: input.releaseTaskId,
    operationId: journal.operationId,
    bundleSha256,
    sourceSha: source.sha,
    gitlinks: Object.fromEntries(
      Object.entries(gitlinks).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  };
  if (pinned !== undefined) {
    return { ...binding, version: typeof runtime.version === 'string' ? runtime.version : 'unknown' };
  }
  if (typeof artifact?.version !== 'string' || typeof artifact.channel !== 'string') {
    throw fail(
      'artifact-unidentified',
      'the release journal identifies its artifact by neither a bundle digest nor a version and channel',
    );
  }
  return { ...binding, version: artifact.version, artifactLabel: { channel: artifact.channel } };
}

export function workspaceHostReleaseStageContext(
  binding: WorkspaceHostReleaseBinding,
  ledger: ReleaseTaskLedger = defaultLedger(),
): ReleaseTaskStageContext {
  const shared = { sourceSha: binding.sourceSha, gitlinks: binding.gitlinks, version: binding.version };
  return {
    taskId: binding.taskId,
    operationId: binding.operationId,
    ledger,
    identity: binding.artifactLabel
      ? { ...shared, channel: binding.artifactLabel.channel }
      : // The writer matches a digest-identified journal on the digest alone; channel is a label.
        { ...shared, channel: WORKSPACE_HOST_RELEASE_CHANNEL, bundleSha256: binding.bundleSha256 },
  };
}

function stageInput(binding: WorkspaceHostReleaseBinding, stage: WorkspaceHostReleaseStage): ReleaseTaskStageInput {
  return {
    stage: stage.stage,
    sourceScope: 'stage',
    identity: { ...stage.identity, bundleSha256: binding.bundleSha256 },
  };
}

function refusal(stage: WorkspaceHostReleaseStage, action: string, state: string): WorkspaceHostReleaseBindingError {
  return action === 'reuse'
    ? new WorkspaceHostReleaseBindingError('stage-committed', stage.stage, 'this release operation already committed it')
    : new WorkspaceHostReleaseBindingError('stage-refused', stage.stage, `the stage is ${state} and not retryable`);
}

/**
 * Whether the stage can be recorded now; throws when it never can. Read-only.
 *
 * `recordedBy` is an evidence ref naming the caller's own run. A COMMITTED receipt carrying it is
 * that run's earlier attempt — a durable step re-executing after its settle landed — so it reads
 * `recorded`, not a refusal: the run must be able to finish the work it already recorded.
 */
export async function workspaceHostReleaseStageReadiness(
  binding: WorkspaceHostReleaseBinding,
  stage: WorkspaceHostReleaseStage,
  options: { ledger?: ReleaseTaskLedger; recordedBy?: string } = {},
): Promise<'writable' | 'recorded'> {
  const inspection = await inspectReleaseTaskStage(
    workspaceHostReleaseStageContext(binding, options.ledger),
    stageInput(binding, stage),
  );
  if (
    inspection.action === 'reuse' &&
    options.recordedBy !== undefined &&
    inspection.receipt?.evidenceRefs.includes(options.recordedBy)
  ) {
    return 'recorded';
  }
  if (inspection.action === 'reuse' || inspection.action === 'refused') {
    throw refusal(stage, inspection.action, inspection.state);
  }
  return 'writable';
}

/** Refuse an outcome whose receipt could never be written, BEFORE the work runs. Read-only. */
export async function assertWorkspaceHostReleaseStageWritable(
  binding: WorkspaceHostReleaseBinding,
  stage: WorkspaceHostReleaseStage,
  ledger?: ReleaseTaskLedger,
): Promise<void> {
  await workspaceHostReleaseStageReadiness(binding, stage, { ledger });
}

/**
 * Record the stage's intent and return the request it must settle.
 *
 * A PENDING intent for this same stage input is ADOPTED, not refused. A durable step that calls this
 * can re-execute after its append landed but before its checkpoint; refusing then would reject the
 * step's own intent. Adoption is also sound for an intent an abandoned attempt left behind: these
 * stages record an observed outcome and change nothing at the provider, and the settling receipt's
 * evidence names the run that actually produced the verdict.
 */
export async function beginWorkspaceHostReleaseStage(
  binding: WorkspaceHostReleaseBinding,
  stage: WorkspaceHostReleaseStage,
  ledger?: ReleaseTaskLedger,
): Promise<{ requestIdentity: string; adopted: boolean }> {
  const begun = await beginReleaseTaskStage(workspaceHostReleaseStageContext(binding, ledger), stageInput(binding, stage));
  if ((begun.action === 'run' || begun.action === 'reconcile') && begun.requestIdentity) {
    return { requestIdentity: begun.requestIdentity, adopted: begun.action === 'reconcile' };
  }
  throw refusal(stage, begun.action, begun.state);
}

/**
 * Settle the stage from its observed outcome. A failed outcome is settled `refused` WITH
 * `reconcile:confirmed-absent`: recording it changed nothing at the provider, so a new attempt is
 * safe and the journal lets it mint a fresh request identity instead of wedging the stage.
 */
export async function settleWorkspaceHostReleaseStage(input: {
  binding: WorkspaceHostReleaseBinding;
  stage: WorkspaceHostReleaseStage;
  requestIdentity: string;
  outcome: 'committed' | 'refused';
  evidenceRefs: readonly string[];
  ledger?: ReleaseTaskLedger;
}): Promise<void> {
  await settleReleaseTaskStage(workspaceHostReleaseStageContext(input.binding, input.ledger), {
    ...stageInput(input.binding, input.stage),
    requestIdentity: input.requestIdentity,
    state: input.outcome,
    evidenceRefs: [
      ...(input.outcome === 'refused' ? ['reconcile:confirmed-absent'] : []),
      ...input.evidenceRefs,
    ],
  });
}

/**
 * The stages ONE host operation records on one release, keyed by the operation's own names for them.
 * Opened read-only BEFORE the operation touches anything (`openWorkspaceHostReleaseRecorder`), so a
 * receipt that could never be written refuses the request instead of surfacing after the work.
 *
 * Every settle names the operation first (`runRef`). That ref is also how a durable step that
 * re-executes the same operation after its settle landed finds its committed receipt: such a stage is
 * `recorded`, and begin/settle leave it alone instead of refusing the operation's own work.
 */
export class WorkspaceHostReleaseRecorder<Slot extends string> {
  private readonly open = new Map<Slot, string>();

  constructor(
    readonly binding: WorkspaceHostReleaseBinding,
    private readonly stages: Readonly<Record<Slot, WorkspaceHostReleaseStage>>,
    private readonly recorded: ReadonlySet<Slot>,
    private readonly runRef: string,
    private readonly ledger?: ReleaseTaskLedger,
  ) {}

  stage(slot: Slot): WorkspaceHostReleaseStage {
    return this.stages[slot];
  }

  /** Record the stage's intent. A stage this operation already committed is left alone. */
  async begin(slot: Slot): Promise<void> {
    if (this.recorded.has(slot) || this.open.has(slot)) return;
    const begun = await beginWorkspaceHostReleaseStage(this.binding, this.stages[slot], this.ledger);
    this.open.set(slot, begun.requestIdentity);
  }

  async settle(slot: Slot, outcome: 'committed' | 'refused', evidenceRefs: readonly string[]): Promise<void> {
    const requestIdentity = this.open.get(slot);
    if (!requestIdentity) return;
    await settleWorkspaceHostReleaseStage({
      binding: this.binding,
      stage: this.stages[slot],
      requestIdentity,
      outcome,
      evidenceRefs: [this.runRef, ...evidenceRefs],
      ...(this.ledger ? { ledger: this.ledger } : {}),
    });
    this.open.delete(slot);
  }

  /**
   * Settle every still-open stage `refused` after the operation failed. Best effort by design: a
   * settle that cannot land leaves a pending intent, which the next attempt of this operation adopts.
   */
  async refuseOpen(evidenceRefs: readonly string[]): Promise<void> {
    for (const slot of [...this.open.keys()]) {
      await this.settle(slot, 'refused', evidenceRefs).catch(() => undefined);
    }
  }
}

export async function openWorkspaceHostReleaseRecorder<Slot extends string>(input: {
  releaseTaskId: string;
  workspaceId: string;
  hostId: string;
  stages: Readonly<Record<Slot, WorkspaceHostReleaseStage>>;
  /** Evidence ref naming the operation, e.g. `initialize-operation:<id>`. */
  runRef: string;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
}): Promise<WorkspaceHostReleaseRecorder<Slot>> {
  const slots = Object.keys(input.stages) as Slot[];
  const binding = await resolveWorkspaceHostReleaseBinding({
    releaseTaskId: input.releaseTaskId,
    stage: input.stages[slots[0]!].stage,
    hostRuntimeRelease: await (input.readHostRuntimeRelease ?? readWorkspaceHostRuntimeRelease)(
      input.workspaceId,
      input.hostId,
    ),
    ...(input.ledger ? { ledger: input.ledger } : {}),
  });
  const recorded = new Set<Slot>();
  for (const slot of slots) {
    const readiness = await workspaceHostReleaseStageReadiness(binding, input.stages[slot], {
      recordedBy: input.runRef,
      ...(input.ledger ? { ledger: input.ledger } : {}),
    });
    if (readiness === 'recorded') recorded.add(slot);
  }
  return new WorkspaceHostReleaseRecorder(binding, input.stages, recorded, input.runRef, input.ledger);
}
