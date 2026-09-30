/**
 * release-cut-operation — managed-release IDENTITY for the MANUAL `release:cut` path
 * (desktop-release-incremental-resume-2026-09-21 P-001).
 *
 * The phase journal itself is NOT new here. `release-local.sh` already implements one —
 * `release_task_journal_configure()` + `scripts/lib/release-task-journal.mts`, with stage
 * receipts, reuse/reconcile decisions and content identity — and the NIGHTLY routine
 * (`harness/routines/nightly-release-cut-action.ts`) already drives it: it mints a task
 * id and an operation id, seeds `detail.release`, and threads both through the child's
 * env. Everything that machinery needs to run is present.
 *
 * What was missing is the other caller. A MANUAL cut fired through `release:cut` never
 * minted either id, so `release_task_journal_configure()` returned early and every manual
 * cut ran UNMANAGED: no stage receipts, no resume, and nothing durable recording WHICH
 * source/version/platform a given run was building. Two consequences, both silent:
 *
 *   1. An interrupted cut was unrecoverable. `readCutStatus` could say `interrupted`, but
 *      not what was being cut, so there was nothing to resume FROM — the only option was
 *      to start the 35–60 min build again.
 *   2. Worse, the on-host sentinels (`/tmp/papercup-release-cut[-<platform>].{started,
 *      done,log}`) are per-PLATFORM and therefore SHARED by successive cuts of the same
 *      leg. With no identity on them, a reader holding an older operation reads a LATER
 *      cut's DONE sentinel as its own outcome — a success the operation never had.
 *
 * So this module supplies identity and correlation, and deliberately adds no second
 * journal: the ledger row (`harness_shared.task_ledger.detail.release`) that the existing
 * adapter already reads and appends to IS the store. A new table would split canonical
 * state across two stores and leave the shell adapter writing to the one nobody queried.
 *
 * Structure mirrors release-cut-launch.ts: the decisions are PURE functions taking plain
 * inputs, so every branch is unit-testable without a database, a build, or a real cut.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  registerTask,
  listTasks,
  taskReleaseJournalFromDetail,
  TASK_RELEASE_JOURNAL_SCHEMA_VERSION,
} from './task-manager/store';
import { newTaskId } from './task-manager/types';
import type { TaskRow } from './task-manager/types';
import type { TaskReleaseJournal } from './task-manager/store';
import { readCutStatus, cutUnitFor, PLATFORMS } from './release-cut-launch';
import type { Channel, CutStatus, Platform } from './release-cut-launch';

/** `launched_by` for every manual cut operation — the discovery key. Distinct from the
 *  nightly routine's `system:nightly-release-cut`, so restart discovery over manual cuts
 *  cannot accidentally adopt (or resume) a nightly one. */
export const CUT_OPERATION_LAUNCHED_BY = 'release:cut';

/** The artifact-identity discriminator the journal keys reuse decisions on. Shared with
 *  the nightly path on purpose: the same bytes must hash the same way from either lane. */
export const CUT_ARTIFACT_KIND = 'papercusp-desktop-release';

/**
 * What a cut operation is FOR — the source/version/platform tuple P-001 requires be
 * persisted. Everything here participates in the stage input hash, so a cut of a
 * different source, version, channel or platform can never reuse this operation's
 * receipts.
 */
export interface CutOperationIdentity {
  version: string;
  channel: Channel;
  /** The single leg this operation cuts; `null` is the legacy whole-cut unit.
   *  Load-bearing in the identity, not just a label: a macOS leg's bytes are not a
   *  Linux leg's bytes, so they must not share a receipt. */
  platform: Platform | null;
  /** Exact 40-char superproject commit the cut is authorized to package. */
  sourceSha: string;
  /** Submodule pins at that commit — the rest of the source identity. Two cuts of the
   *  same superproject sha with different gitlinks are different builds. */
  gitlinks: Readonly<Record<string, string>>;
}

/** Credential binding, carried so a resume can refuse an expired one rather than
 *  discovering it mid-build (mirrors the nightly seed). */
export interface CutOperationCredential {
  generation?: string | null;
  expiresAt?: string | null;
}

/** The `detail.release` seed. Shape is dictated by `TaskReleaseJournal` — the shell
 *  adapter reads and CAS-appends against exactly this. */
export interface CutJournalSeed {
  schemaVersion: typeof TASK_RELEASE_JOURNAL_SCHEMA_VERSION;
  operationId: string;
  source: { sha: string; gitlinks: Readonly<Record<string, string>> };
  artifactIdentity: {
    kind: typeof CUT_ARTIFACT_KIND;
    channel: Channel;
    platform: Platform | null;
    sourceSha: string;
    version: string;
  };
  credential: { generation: string | null; expiresAt: string | null };
  cursor: 0;
  currentStage: null;
  currentState: null;
  spentOperationIds: never[];
  receipts: never[];
}

/**
 * PURE. Build the journal seed for a new operation. Kept separate from the ledger write
 * so the shape the shell adapter depends on is asserted directly in tests, with no
 * database in the way.
 */
export function buildCutJournalSeed(
  operationId: string,
  identity: CutOperationIdentity,
  credential: CutOperationCredential = {},
): CutJournalSeed {
  return {
    schemaVersion: TASK_RELEASE_JOURNAL_SCHEMA_VERSION,
    operationId,
    source: { sha: identity.sourceSha, gitlinks: identity.gitlinks },
    artifactIdentity: {
      kind: CUT_ARTIFACT_KIND,
      channel: identity.channel,
      platform: identity.platform,
      sourceSha: identity.sourceSha,
      version: identity.version,
    },
    credential: {
      generation: credential.generation ?? null,
      expiresAt: credential.expiresAt ?? null,
    },
    cursor: 0,
    currentStage: null,
    currentState: null,
    spentOperationIds: [],
    receipts: [],
  };
}

/** The stage name the cutter journals a leg's build under. `release.build.linux` is what
 *  release-local.sh uses today; a null platform is the whole-cut unit, whose build leg is
 *  still Linux. Derived rather than restated so the two cannot drift apart by hand. */
export function cutBuildStage(platform: Platform | null): string {
  return `release.build.${platform ?? 'linux'}`;
}

export interface BeginCutOperationInput {
  identity: CutOperationIdentity;
  credential?: CutOperationCredential;
  /** papercusp-desktop root the cut runs in — recorded so discovery can report WHERE. */
  cwd?: string | null;
  /** The work-item this cut serves, when the caller's claim names it unambiguously
   *  (expensive-verification-loops P-001: a cut is an expensive verification attempt). */
  workItemId?: string | null;
  workspaceId?: string;
  harnessSlug?: string | null;
  /** Pre-minted ids. Injectable so a test asserts an exact row rather than a random one. */
  taskId?: string;
  operationId?: string;
}

export interface BeginCutOperationResult {
  taskId: string;
  operationId: string;
  identity: CutOperationIdentity;
  seed: CutJournalSeed;
  unit: string;
}

export interface BeginCutOperationDeps {
  registerTask?: typeof registerTask;
  newTaskId?: () => string;
  newOperationId?: () => string;
}

/**
 * Open a managed cut operation: mint the ids and persist the identity + journal seed in
 * the task ledger BEFORE the cut is launched.
 *
 * Ordering is the point. The row must exist before `systemd-run` accepts the unit,
 * because the detached cut's first journal write CAS-appends against it — and because a
 * launch that dies between fork and first receipt must still leave something discoverable
 * behind. A row with no cut is recoverable (discovery reports `unknown`); a cut with no
 * row is not.
 */
export async function beginCutOperation(
  input: BeginCutOperationInput,
  deps: BeginCutOperationDeps = {},
): Promise<BeginCutOperationResult> {
  const register = deps.registerTask ?? registerTask;
  const taskId = input.taskId ?? (deps.newTaskId ?? newTaskId)();
  const operationId = input.operationId ?? (deps.newOperationId ?? randomUUID)();
  const { identity } = input;
  const seed = buildCutJournalSeed(operationId, identity, input.credential);
  const unit = cutUnitFor(identity.platform ?? undefined);

  await register(
    {
      class: 'deploy',
      title: `desktop release cut ${identity.version} ${identity.channel}${identity.platform ? ` (${identity.platform})` : ''}`,
      argv: [],
      cwd: input.cwd ?? null,
      launchedBy: CUT_OPERATION_LAUNCHED_BY,
      harnessSlug: input.harnessSlug ?? null,
      workItemId: input.workItemId ?? null,
      detail: {
        channel: identity.channel,
        version: identity.version,
        platform: identity.platform,
        sourceSha: identity.sourceSha,
        // The transient unit this operation's sentinels live under. Discovery needs it to
        // know which /tmp trio to read, and it is per-platform, so it cannot be re-derived
        // from the task row alone once the platform field is gone.
        cutUnit: unit,
        release: seed,
      },
    },
    { workspaceId: input.workspaceId, taskId },
  );

  return { taskId, operationId, identity, seed, unit };
}

// ─── Restart discovery ─────────────────────────────────────────────────────────

/**
 * What an operation's on-host evidence actually supports.
 *
 * `superseded` and `unknown` exist so the reader is never handed a confident wrong
 * answer: both mean "this operation's outcome is NOT readable from the sentinels", which
 * is the exact case the anonymous marker used to report as a clean `done`.
 */
export type CutOperationDisposition =
  | 'running'
  | 'interrupted'
  | 'complete'
  | 'failed'
  | 'superseded'
  | 'unknown';

export interface CutOperationReconciliation {
  disposition: CutOperationDisposition;
  /** Only an `interrupted` operation may be resumed: its receipts are intact and no
   *  other cut has taken its sentinels. */
  resumable: boolean;
  /** Why, in one line — so a caller reports evidence rather than re-deriving it. */
  reason: string;
}

/**
 * PURE. Reconcile ONE operation's ledger identity against the host's sentinels.
 *
 * The marker's operation id is the whole mechanism: it is what distinguishes "my cut" from
 * "the cut that replaced mine on this platform's shared sentinels". When it does not
 * match, no state is claimed from the DONE sentinel at all.
 */
export function classifyCutOperation(operationId: string, status: CutStatus): CutOperationReconciliation {
  const marker = status.operation;
  if (!marker) {
    return {
      disposition: 'unknown',
      resumable: false,
      reason: 'no started marker on the host — the cut never started, or /tmp was cleared',
    };
  }
  if (marker.operationId === null) {
    return {
      disposition: 'unknown',
      resumable: false,
      reason: 'started marker carries no operation id (unmanaged or pre-P-001 launch); its outcome cannot be attributed',
    };
  }
  if (marker.operationId !== operationId) {
    return {
      disposition: 'superseded',
      resumable: false,
      reason: `the platform's sentinels now belong to operation ${marker.operationId}; this operation's outcome is not readable from them`,
    };
  }
  if (status.running) {
    return { disposition: 'running', resumable: false, reason: `transient unit is active` };
  }
  if (status.state === 'done') {
    return { disposition: 'complete', resumable: false, reason: 'DONE sentinel reports exit 0' };
  }
  if (status.state === 'failed') {
    return {
      disposition: 'failed',
      resumable: false,
      reason: `DONE sentinel reports exit ${status.exitCode}`,
    };
  }
  return {
    disposition: 'interrupted',
    resumable: true,
    reason: 'started but the unit is gone with no DONE sentinel — resumable from its last committed receipt',
  };
}

export interface DiscoveredCutOperation {
  taskId: string;
  operationId: string;
  identity: CutOperationIdentity;
  unit: string;
  taskState: TaskRow['state'];
  /** Last stage the journal committed — where a resume picks up. */
  currentStage: string | null;
  receiptCount: number;
  status: CutStatus;
  reconciliation: CutOperationReconciliation;
}

/** PURE. Recover the persisted identity from a ledger row, or null when the row is not a
 *  managed cut operation. Tolerant by construction: a row whose detail was written by an
 *  older launcher simply does not resolve, rather than throwing mid-sweep. */
export function cutOperationIdentityFromTask(
  task: TaskRow,
): { identity: CutOperationIdentity; journal: TaskReleaseJournal } | null {
  const journal = taskReleaseJournalFromDetail(task.detail);
  if (!journal) return null;
  const artifact = (journal as { artifactIdentity?: Record<string, unknown> }).artifactIdentity;
  const source = (journal as { source?: { sha?: unknown; gitlinks?: unknown } }).source;
  const version = artifact?.version;
  const channel = artifact?.channel;
  const sha = source?.sha;
  if (typeof version !== 'string' || typeof channel !== 'string' || typeof sha !== 'string') return null;
  const platform = artifact?.platform;
  const gitlinks = source?.gitlinks;
  return {
    identity: {
      version,
      channel: channel as Channel,
      platform: (PLATFORMS as readonly string[]).includes(platform as string) ? (platform as Platform) : null,
      sourceSha: sha,
      gitlinks: (gitlinks && typeof gitlinks === 'object' ? gitlinks : {}) as Record<string, string>,
    },
    journal,
  };
}

export interface DiscoverCutOperationsDeps {
  listTasks?: typeof listTasks;
  /** Injected so discovery is testable without a host: one call per platform unit. */
  readStatus?: (platform: Platform | undefined) => CutStatus;
  workspaceId?: string;
}

/**
 * Restart discovery: enumerate every manual cut operation the ledger still considers live
 * and say, per operation, what the host's evidence supports.
 *
 * This is the answer to "the operator restarted mid-cut — what was in flight?", which
 * before P-001 had none: the ids existed only inside the detached unit's environment, so
 * they died with it. `listTasks` without `includeEnded` already scopes to non-terminal
 * rows, which is exactly the in-flight set.
 */
export async function discoverCutOperations(
  deps: DiscoverCutOperationsDeps = {},
): Promise<DiscoveredCutOperation[]> {
  const list = deps.listTasks ?? listTasks;
  const readStatus = deps.readStatus ?? ((platform: Platform | undefined) => readCutStatus({ platform }));
  const tasks = await list({
    workspaceId: deps.workspaceId,
    launchedBy: CUT_OPERATION_LAUNCHED_BY,
    classes: ['deploy'],
  });

  const discovered: DiscoveredCutOperation[] = [];
  for (const task of tasks) {
    const resolved = cutOperationIdentityFromTask(task);
    if (!resolved) continue;
    const { identity, journal } = resolved;
    const status = readStatus(identity.platform ?? undefined);
    discovered.push({
      taskId: task.taskId,
      operationId: journal.operationId,
      identity,
      unit: cutUnitFor(identity.platform ?? undefined),
      taskState: task.state,
      currentStage: journal.currentStage,
      receiptCount: journal.receipts.length,
      status,
      reconciliation: classifyCutOperation(journal.operationId, status),
    });
  }
  return discovered;
}

/**
 * The submodule pins at a source commit — the half of the source identity a bare sha does
 * not carry. Injectable everywhere it is used; this default is the only code path that
 * shells out.
 *
 * ⚠ A third copy of this logic (nightly-release-cut-action.ts and
 * scripts/lib/release-task-journal.mts hold the others). Consolidating the three is
 * deliberately NOT done here — it touches the nightly release path, which is out of
 * P-001's scope — but they must agree, because a disagreement silently changes an
 * identity hash and voids receipt reuse across lanes.
 */
export function readSourceGitlinks(sourceRoot: string, sourceSha: string): Record<string, string> {
  const gitmodules = execFileSync('git', ['-C', sourceRoot, 'show', `${sourceSha}:.gitmodules`], {
    encoding: 'utf8',
  });
  const paths = [...gitmodules.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
    .map((match) => match[1])
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`source ${sourceSha} has no unique committed .gitmodules paths`);
  }
  const output = execFileSync('git', ['-C', sourceRoot, 'ls-tree', sourceSha, '--', ...paths], {
    encoding: 'utf8',
  });
  const gitlinks: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line);
    if (match) gitlinks[match[2]] = match[1];
  }
  const missing = paths.filter((entry) => !Object.hasOwn(gitlinks, entry));
  if (missing.length > 0) {
    throw new Error(`source ${sourceSha} has non-gitlink submodule path(s): ${missing.join(', ')}`);
  }
  return Object.fromEntries(Object.entries(gitlinks).sort(([left], [right]) => left.localeCompare(right)));
}
