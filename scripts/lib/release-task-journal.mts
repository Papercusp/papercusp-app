#!/usr/bin/env -S npx tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import type {
  AppendTaskReleaseReceiptResult,
  FindPriorCommittedTaskReleaseReceiptInput,
  PriorCommittedTaskReleaseReceipt,
  TaskReleaseJournal,
  TaskReleaseReceipt,
  TaskReleaseReceiptInput,
  TaskReleaseReuseSource,
  TaskReleaseReceiptState,
} from '@papercusp/operator-core/lib/task-manager/store';

export interface ReleaseTaskLedger {
  getTask(taskId: string): Promise<{ detail?: Record<string, unknown> | null } | null>;
  taskReleaseJournalFromDetail(detail: Record<string, unknown> | null | undefined): TaskReleaseJournal | null;
  appendTaskReleaseReceipt(
    taskId: string,
    expectedCursor: number,
    input: TaskReleaseReceiptInput,
  ): Promise<AppendTaskReleaseReceiptResult>;
  findPriorCommittedTaskReleaseReceipt?(
    input: FindPriorCommittedTaskReleaseReceiptInput,
  ): Promise<PriorCommittedTaskReleaseReceipt | null>;
}

export interface ReleaseTaskIdentity {
  sourceSha: string;
  gitlinks: Readonly<Record<string, string>>;
  version: string;
  channel: string;
  /**
   * Content digest of a BUNDLE artifact. Workspace-host publication tasks identify their artifact
   * by digest alone (`artifactIdentity: { bundleSha256 }`), not by source/version/channel. When
   * set, the journal must name exactly this digest — a stronger identity than the label tuple —
   * and version/channel only label the stage preimage. Absent keeps the desktop-release rule.
   */
  bundleSha256?: string;
}

export interface ReleaseTaskStageContext {
  taskId: string;
  operationId: string;
  ledger: ReleaseTaskLedger;
  identity: ReleaseTaskIdentity;
  credentialGeneration?: string | null;
  credentialExpiresAt?: string | null;
  /** Zero/absent preserves operation-local P-005 behavior. */
  reuseMaxAgeMs?: number;
  reuseExpiresAt?: string | null;
  queueWaitMs?: number | null;
  now?: () => Date;
  monotonicNow?: () => number;
}

export interface ReleaseTaskStageInput {
  stage: string;
  identity: unknown;
  /** `complete` binds source+gitlinks; `stage` lets a downstream stage key only its actual inputs. */
  sourceScope?: 'complete' | 'stage';
  requiredReuseEvidenceRefs?: readonly string[];
}

export interface ReleaseTaskStageInspection {
  action: 'ready' | 'reuse' | 'reconcile' | 'refused';
  inputHash: string;
  requestIdentity: string | null;
  state: TaskReleaseReceiptState | 'absent';
  attempt: number;
  cursor: number;
  journal: TaskReleaseJournal;
  receipt: TaskReleaseReceipt | null;
  reuseSource: TaskReleaseReuseSource | null;
  lookupElapsedMs: number | null;
  freshness: 'absent' | 'unbounded' | 'fresh' | 'expired';
}

export type BegunReleaseTaskStage = Omit<ReleaseTaskStageInspection, 'action'> & {
  action: 'run' | 'reuse' | 'reconcile' | 'refused';
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release stage identity contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') {
    throw new Error('release stage identity contains a non-JSON value');
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      if (entry === undefined) throw new Error(`release stage identity field '${key}' is undefined`);
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    })
    .join(',')}}`;
}

export function releaseStageInputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** The exact, inspectable preimage used for operation-local and cross-operation reuse. */
export function releaseTaskStageContentIdentity(
  context: Pick<ReleaseTaskStageContext, 'identity' | 'reuseMaxAgeMs'>,
  input: ReleaseTaskStageInput,
): Record<string, unknown> {
  const sourceScope = input.sourceScope ?? 'complete';
  return {
    schemaVersion: 1,
    stage: input.stage,
    sourceScope,
    release: {
      version: context.identity.version,
      channel: context.identity.channel,
      ...(context.identity.bundleSha256 !== undefined ? { bundleSha256: context.identity.bundleSha256 } : {}),
      ...(sourceScope === 'complete'
        ? {
            sourceSha: context.identity.sourceSha,
            gitlinks: sortedRecord(context.identity.gitlinks),
          }
        : {}),
    },
    reusePolicy: { maxAgeMs: context.reuseMaxAgeMs ?? 0 },
    requiredReuseEvidenceRefs: [...(input.requiredReuseEvidenceRefs ?? [])].sort(),
    stageIdentity: input.identity,
  };
}

export function releaseTaskStageInputHash(
  context: Pick<ReleaseTaskStageContext, 'identity' | 'reuseMaxAgeMs'>,
  input: ReleaseTaskStageInput,
): string {
  return releaseStageInputHash(releaseTaskStageContentIdentity(context, input));
}

/** Stable UUIDv4-shaped identity accepted by provider APIs that expose idempotency keys. */
export function releaseStageRequestIdentity(
  operationId: string,
  stage: string,
  inputHash: string,
  attempt = 0,
): string {
  const hex = createHash('sha256')
    .update(`${operationId}\u0000${stage}\u0000${inputHash}\u0000${attempt}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function readSourceGitlinks(sourceRoot: string, sourceSha: string): Record<string, string> {
  const gitmodules = execFileSync('git', ['-C', sourceRoot, 'show', `${sourceSha}:.gitmodules`], {
    encoding: 'utf8',
  });
  const paths = [...gitmodules.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
    .map((match) => match[1]!)
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`release source ${sourceSha} has no unique committed .gitmodules paths`);
  }
  const tree = execFileSync('git', ['-C', sourceRoot, 'ls-tree', sourceSha, '--', ...paths], {
    encoding: 'utf8',
  });
  const gitlinks: Record<string, string> = {};
  for (const line of tree.split('\n')) {
    const match = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line);
    if (match) gitlinks[match[2]!] = match[1]!;
  }
  const missing = paths.filter((entry) => !Object.hasOwn(gitlinks, entry));
  if (missing.length > 0) {
    throw new Error(`release source ${sourceSha} has non-gitlink submodule path(s): ${missing.join(', ')}`);
  }
  return sortedRecord(gitlinks);
}

export function assertReleaseTaskIdentity(
  journal: TaskReleaseJournal,
  expected: ReleaseTaskIdentity,
): void {
  const source = journal.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('release journal has no immutable source identity');
  }
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.sha !== expected.sourceSha) {
    throw new Error(`release journal source ${String(sourceRecord.sha)} does not match ${expected.sourceSha}`);
  }
  const rawGitlinks = sourceRecord.gitlinks;
  if (!rawGitlinks || typeof rawGitlinks !== 'object' || Array.isArray(rawGitlinks)) {
    throw new Error('release journal has no immutable gitlink map');
  }
  const journalGitlinks = rawGitlinks as Record<string, unknown>;
  if (!Object.values(journalGitlinks).every((sha) => typeof sha === 'string')) {
    throw new Error('release journal gitlink map is malformed');
  }
  const recorded = sortedRecord(journalGitlinks as Record<string, string>);
  const current = sortedRecord(expected.gitlinks);
  if (canonicalJson(recorded) !== canonicalJson(current)) {
    throw new Error('release journal gitlink tuple does not match the exact source tree');
  }

  const artifact = journal.artifactIdentity;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('release journal has no immutable artifact identity');
  }
  const identity = artifact as Record<string, unknown>;
  if (expected.bundleSha256 !== undefined) {
    // Fail closed both ways: a digest-bound caller never matches a label-identified (desktop)
    // journal, and a label-bound caller never matches a digest-identified one (below).
    if (identity.bundleSha256 !== expected.bundleSha256) {
      throw new Error(
        `release journal artifact digest ${String(identity.bundleSha256 ?? '(none)')} does not match ${expected.bundleSha256}`,
      );
    }
    return;
  }
  if (
    identity.sourceSha !== expected.sourceSha ||
    identity.version !== expected.version ||
    identity.channel !== expected.channel
  ) {
    throw new Error(
      `release journal artifact identity does not match source/version/channel ` +
        `${expected.sourceSha}/${expected.version}/${expected.channel}`,
    );
  }
}

async function readJournal(context: ReleaseTaskStageContext): Promise<TaskReleaseJournal> {
  const task = await context.ledger.getTask(context.taskId);
  if (!task) throw new Error(`release task ${context.taskId} is absent from the task ledger`);
  const journal = context.ledger.taskReleaseJournalFromDetail(task.detail);
  if (!journal) throw new Error(`release task ${context.taskId} has no complete release journal`);
  if (journal.operationId !== context.operationId) {
    throw new Error(
      `release task ${context.taskId} belongs to operation ${journal.operationId}, not ${context.operationId}`,
    );
  }
  assertReleaseTaskIdentity(journal, context.identity);
  return journal;
}

function latestReceipt(receipts: readonly TaskReleaseReceipt[], requestIdentity: string): TaskReleaseReceipt | null {
  return [...receipts].reverse().find((receipt) => receipt.requestIdentity === requestIdentity) ?? null;
}

function stageReceipts(
  journal: TaskReleaseJournal,
  stage: string,
  inputHash: string,
): TaskReleaseReceipt[] {
  const receipts = journal.receipts.filter((receipt) => receipt.stage === stage);
  const conflict = receipts.find((receipt) => receipt.inputHash !== inputHash);
  if (conflict) {
    throw new Error(
      `release stage ${stage} input changed within operation ${journal.operationId}; ` +
        `receipt ${conflict.sequence} pins ${conflict.inputHash}, current input is ${inputHash}`,
    );
  }
  return receipts;
}

function inspectJournal(
  context: Pick<ReleaseTaskStageContext, 'identity' | 'reuseMaxAgeMs' | 'now'>,
  journal: TaskReleaseJournal,
  input: ReleaseTaskStageInput,
): ReleaseTaskStageInspection {
  const inputHash = releaseTaskStageInputHash(context, input);
  const receipts = stageReceipts(journal, input.stage, inputHash);
  const identities = [...new Set(receipts.map((receipt) => receipt.requestIdentity))];
  const requestIdentity = identities.at(-1) ?? null;
  const prior = requestIdentity ? latestReceipt(receipts, requestIdentity) : null;
  const state = prior?.state ?? 'absent';
  const expiry = prior?.reuseExpiresAt ? Date.parse(prior.reuseExpiresAt) : NaN;
  const nowMs = (context.now?.() ?? new Date()).getTime();
  const freshness = !prior
    ? 'absent'
    : !prior.reuseExpiresAt
      ? 'unbounded'
      : Number.isFinite(expiry) && expiry > nowMs
        ? 'fresh'
        : 'expired';
  const action =
    state === 'committed'
      ? freshness === 'expired' ? 'refused' : 'reuse'
      : state === 'intent' || state === 'unknown'
        ? 'reconcile'
        : state === 'refused' && !prior?.evidenceRefs.includes('reconcile:confirmed-absent')
          ? 'refused'
          : 'ready';
  return {
    action,
    inputHash,
    requestIdentity,
    state,
    attempt: identities.length,
    cursor: journal.cursor,
    journal,
    receipt: prior,
    reuseSource: prior?.reuseSource ?? null,
    lookupElapsedMs: prior?.lookupElapsedMs ?? null,
    freshness,
  };
}

export async function inspectReleaseTaskStage(
  context: ReleaseTaskStageContext,
  input: ReleaseTaskStageInput,
): Promise<ReleaseTaskStageInspection> {
  return inspectJournal(context, await readJournal(context), input);
}

export async function beginReleaseTaskStage(
  context: ReleaseTaskStageContext,
  input: ReleaseTaskStageInput,
): Promise<BegunReleaseTaskStage> {
  for (let cursorAttempt = 0; cursorAttempt < 12; cursorAttempt += 1) {
    const inspection = await inspectReleaseTaskStage(context, input);
    if (
      inspection.action === 'reuse' ||
      inspection.action === 'reconcile' ||
      inspection.action === 'refused'
    ) {
      return { ...inspection, action: inspection.action };
    }
    const monotonicNow = context.monotonicNow ?? (() => performance.now());
    const lookupStarted = monotonicNow();
    let reuseSource: TaskReleaseReuseSource | null = null;
    if ((context.reuseMaxAgeMs ?? 0) > 0) {
      if (!context.ledger.findPriorCommittedTaskReleaseReceipt) {
        throw new Error('release receipt reuse is enabled but the ledger has no prior-receipt lookup');
      }
      const hit = await context.ledger.findPriorCommittedTaskReleaseReceipt({
        currentTaskId: context.taskId,
        currentOperationId: context.operationId,
        stage: input.stage,
        inputHash: inspection.inputHash,
        now: context.now?.() ?? new Date(),
        credentialGeneration: context.credentialGeneration ?? null,
        requiredEvidenceRefs: input.requiredReuseEvidenceRefs,
      });
      if (hit) {
        reuseSource = {
          taskId: hit.taskId,
          operationId: hit.operationId,
          sequence: hit.receipt.sequence,
        };
      }
    }
    const lookupElapsedMs = Math.max(0, monotonicNow() - lookupStarted);
    const requestIdentity = releaseStageRequestIdentity(
      context.operationId,
      input.stage,
      inspection.inputHash,
      inspection.attempt,
    );
    const inputIdentity = releaseTaskStageContentIdentity(context, input);
    const appended = await context.ledger.appendTaskReleaseReceipt(
      context.taskId,
      inspection.cursor,
      {
        operationId: context.operationId,
        requestIdentity,
        stage: input.stage,
        state: 'intent',
        inputHash: inspection.inputHash,
        inputIdentity,
        evidenceRefs: [
          `stage-input:${inspection.inputHash}`,
          ...(reuseSource
            ? [
                `reuse-source-task:${reuseSource.taskId}`,
                `reuse-source-operation:${reuseSource.operationId}`,
                `reuse-source-receipt:${reuseSource.sequence}`,
              ]
            : []),
        ],
        credentialGeneration: context.credentialGeneration ?? null,
        credentialExpiresAt: context.credentialExpiresAt ?? null,
        reuseSource,
        lookupElapsedMs,
        queueWaitMs: context.queueWaitMs ?? null,
      },
    );
    if (appended.ok) {
      return {
        ...inspectJournal(context, appended.journal, input),
        action: reuseSource ? 'reconcile' : 'run',
        requestIdentity,
        state: 'intent',
        reuseSource,
        lookupElapsedMs,
      };
    }
    if (appended.reason === 'cursor_mismatch' || appended.reason === 'cas_conflict') continue;
    throw new Error(`release journal refused ${input.stage}/${requestIdentity}/intent: ${appended.reason}`);
  }
  throw new Error(`release journal stayed contended while beginning ${input.stage}`);
}

export async function settleReleaseTaskStage(
  context: ReleaseTaskStageContext,
  input: ReleaseTaskStageInput & {
    requestIdentity: string;
    state: Exclude<TaskReleaseReceiptState, 'intent'>;
    evidenceRefs?: readonly string[];
    preparationElapsedMs?: number | null;
  },
): Promise<ReleaseTaskStageInspection> {
  for (let cursorAttempt = 0; cursorAttempt < 12; cursorAttempt += 1) {
    const inspection = await inspectReleaseTaskStage(context, input);
    if (inspection.requestIdentity !== input.requestIdentity) {
      throw new Error(
        `release stage ${input.stage} active request ${inspection.requestIdentity ?? '(absent)'} ` +
          `does not match ${input.requestIdentity}`,
      );
    }
    if (inspection.state === input.state) return inspection;
    if (inspection.state !== 'intent' && inspection.state !== 'unknown') {
      throw new Error(
        `release stage ${input.stage}/${input.requestIdentity} cannot transition ` +
          `${inspection.state} -> ${input.state}`,
      );
    }
    const appended = await context.ledger.appendTaskReleaseReceipt(
      context.taskId,
      inspection.cursor,
      {
        operationId: context.operationId,
        requestIdentity: input.requestIdentity,
        stage: input.stage,
        state: input.state,
        inputHash: inspection.inputHash,
        inputIdentity: releaseTaskStageContentIdentity(context, input),
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        credentialGeneration: context.credentialGeneration ?? null,
        credentialExpiresAt: context.credentialExpiresAt ?? null,
        reuseSource: inspection.receipt?.reuseSource ?? null,
        lookupElapsedMs: inspection.receipt?.lookupElapsedMs ?? null,
        queueWaitMs: inspection.receipt?.queueWaitMs ?? context.queueWaitMs ?? null,
        preparationElapsedMs: input.preparationElapsedMs ?? null,
        reuseExpiresAt:
          input.state === 'committed' && (context.reuseMaxAgeMs ?? 0) > 0
            ? (() => {
                const raw = context.reuseExpiresAt;
                const expiry = Date.parse(raw ?? '');
                const nowMs = (context.now?.() ?? new Date()).getTime();
                if (!Number.isFinite(expiry) || expiry <= nowMs) {
                  throw new Error('release reuse requires a future expiry derived from fresh audit evidence');
                }
                return new Date(expiry).toISOString();
              })()
            : null,
      },
    );
    if (appended.ok) return inspectJournal(context, appended.journal, input);
    if (appended.reason === 'cursor_mismatch' || appended.reason === 'cas_conflict') continue;
    throw new Error(
      `release journal refused ${input.stage}/${input.requestIdentity}/${input.state}: ${appended.reason}`,
    );
  }
  throw new Error(`release journal stayed contended while settling ${input.stage}/${input.state}`);
}

interface CliArgs {
  command: 'status' | 'begin' | 'commit' | 'unknown' | 'refuse';
  taskId: string;
  operationId: string;
  sourceRoot: string;
  sourceSha: string;
  version: string;
  channel: string;
  stage: string;
  identity: unknown;
  sourceScope: 'complete' | 'stage';
  requestIdentity?: string;
  evidenceRefs: string[];
  preparationElapsedMs?: number;
  reuseExpiresAt?: string;
}

function cliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliArgs {
  const [rawCommand, ...rest] = argv;
  if (!['status', 'begin', 'commit', 'unknown', 'refuse'].includes(rawCommand ?? '')) {
    throw new Error('usage: release-task-journal.mts <status|begin|commit|unknown|refuse> --stage NAME --identity VALUE ...');
  }
  const values = new Map<string, string>();
  const evidenceRefs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith('--')) throw new Error(`unexpected release journal argument ${arg}`);
    const equal = arg.indexOf('=');
    const key = equal >= 0 ? arg.slice(2, equal) : arg.slice(2);
    const value = equal >= 0 ? arg.slice(equal + 1) : rest[++index];
    if (value === undefined) throw new Error(`release journal argument --${key} requires a value`);
    if (key === 'evidence') evidenceRefs.push(value);
    else values.set(key, value);
  }
  const required = (key: string, fallback?: string): string => {
    const value = values.get(key) ?? fallback;
    if (!value?.trim()) throw new Error(`release journal requires --${key}`);
    return value.trim();
  };
  const command = rawCommand as CliArgs['command'];
  const requestIdentity = values.get('request-id');
  if (command !== 'status' && command !== 'begin' && !requestIdentity) {
    throw new Error(`release journal ${command} requires --request-id`);
  }
  const sourceScope = values.get('source-scope') ?? 'complete';
  if (sourceScope !== 'complete' && sourceScope !== 'stage') {
    throw new Error(`release journal --source-scope must be complete|stage (got ${sourceScope})`);
  }
  const identityRaw = required('identity');
  let identity: unknown = identityRaw;
  if (identityRaw.startsWith('{') || identityRaw.startsWith('[')) {
    try {
      identity = JSON.parse(identityRaw);
    } catch (error) {
      throw new Error(`release journal --identity is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const preparationRaw = values.get('preparation-ms');
  const preparationElapsedMs = preparationRaw === undefined ? undefined : Number(preparationRaw);
  if (preparationElapsedMs !== undefined && (!Number.isFinite(preparationElapsedMs) || preparationElapsedMs < 0)) {
    throw new Error('release journal --preparation-ms must be a finite non-negative number');
  }
  const reuseExpiresAt = values.get('reuse-expires-at');
  if (reuseExpiresAt !== undefined && !Number.isFinite(Date.parse(reuseExpiresAt))) {
    throw new Error('release journal --reuse-expires-at must be an ISO timestamp');
  }
  return {
    command,
    taskId: required('task-id', env.PAPERCUSP_RELEASE_TASK_ID),
    operationId: required('operation-id', env.PAPERCUSP_RELEASE_OPERATION_ID),
    sourceRoot: required('source-root'),
    sourceSha: required('source-sha', env.PAPERCUSP_EXPECTED_SOURCE_SHA),
    version: required('version'),
    channel: required('channel'),
    stage: required('stage'),
    identity,
    sourceScope,
    ...(requestIdentity ? { requestIdentity } : {}),
    ...(preparationElapsedMs === undefined ? {} : { preparationElapsedMs }),
    ...(reuseExpiresAt === undefined ? {} : { reuseExpiresAt }),
    evidenceRefs,
  };
}

async function defaultLedger(): Promise<ReleaseTaskLedger> {
  const store = await import('@papercusp/operator-core/lib/task-manager/store');
  return {
    getTask: store.getTask,
    taskReleaseJournalFromDetail: store.taskReleaseJournalFromDetail,
    appendTaskReleaseReceipt: store.appendTaskReleaseReceipt,
    findPriorCommittedTaskReleaseReceipt: store.findPriorCommittedTaskReleaseReceipt,
  };
}

function reuseMaxAgeMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC?.trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 7 * 24 * 60 * 60) {
    throw new Error('PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC must be an integer in 1..604800');
  }
  return seconds * 1000;
}

function queueWaitMs(env: NodeJS.ProcessEnv): number | null {
  const enqueued = Number(env.PAPERCUSP_RELEASE_ENQUEUED_AT_MS);
  const started = Number(env.PAPERCUSP_RELEASE_CHILD_STARTED_AT_MS);
  if (!Number.isFinite(enqueued) || !Number.isFinite(started) || enqueued < 0 || started < enqueued) return null;
  return started - enqueued;
}

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), process.env);
  const context: ReleaseTaskStageContext = {
    taskId: args.taskId,
    operationId: args.operationId,
    ledger: await defaultLedger(),
    identity: {
      sourceSha: args.sourceSha,
      gitlinks: readSourceGitlinks(args.sourceRoot, args.sourceSha),
      version: args.version,
      channel: args.channel,
    },
    credentialGeneration: process.env.PAPERCUSP_RELEASE_CREDENTIAL_GENERATION?.trim() || null,
    credentialExpiresAt: process.env.PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT?.trim() || null,
    reuseMaxAgeMs: reuseMaxAgeMs(process.env),
    reuseExpiresAt: args.reuseExpiresAt ?? null,
    queueWaitMs: queueWaitMs(process.env),
  };
  // P-003 clause 1 (D-008). This was written when linux was the only journalled
  // build leg and named it LITERALLY, so when P-002 added windows and mac they
  // silently fell to the `[]` arm: a cross-operation reuse hit for either leg
  // required NO evidence, while linux required signed-and-verified bytes. The
  // weaker rule is invisible at the call site — it looks like a stage that simply
  // has no requirement, not one that lost its guarantee — so derive the rule from
  // the stage FAMILY. A leg added later then inherits the requirement instead of
  // inheriting the hole.
  const requiredReuseEvidenceRefs = args.stage.startsWith('release.build.')
    ? ['artifact-set:hash-signature-verified']
    : args.stage === 'release.manifest'
      ? ['artifact-ledger:exact-set-verified']
      : [];
  const stage = {
    stage: args.stage,
    identity: args.identity,
    sourceScope: args.sourceScope,
    requiredReuseEvidenceRefs,
  };
  const result =
    args.command === 'status'
      ? await inspectReleaseTaskStage(context, stage)
      : args.command === 'begin'
        ? await beginReleaseTaskStage(context, stage)
        : await settleReleaseTaskStage(context, {
            ...stage,
            requestIdentity: args.requestIdentity!,
            state: args.command === 'commit' ? 'committed' : args.command === 'refuse' ? 'refused' : 'unknown',
            evidenceRefs:
              args.command === 'refuse'
                ? ['reconcile:confirmed-absent', ...args.evidenceRefs]
                : args.evidenceRefs,
            preparationElapsedMs: args.preparationElapsedMs,
          });
  process.stdout.write(`${JSON.stringify({
    action: result.action,
    state: result.state,
    requestIdentity: result.requestIdentity,
    inputHash: result.inputHash,
    attempt: result.attempt,
    freshness: result.freshness,
    lookupElapsedMs: result.lookupElapsedMs,
    reuseSource: result.reuseSource,
    // P-003 clause 1 (D-008). Receipts recorded evidence that nothing could ever
    // read: every evidence ref in release-local.sh was a WRITE, because this
    // payload never carried them back. A reuse decision could therefore only
    // re-derive trust from the current tree, never CHECK the bytes against what
    // the receipt actually committed. On a `reuse`/`reconcile` action these are
    // the PRIOR committed receipt's refs — the thing to verify against.
    evidenceRefs: result.receipt?.evidenceRefs ?? [],
  })}\n`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
