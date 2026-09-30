/**
 * Guarded operator read/admit/retire surface for the one persisted frozen repair queue.
 *
 * `admit` (P-002 of frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-004/D-010) is
 * THE door through which a fix reaches a frozen candidate's judged lineage: exactly the named
 * paths, taken from the integration branch (or an explicitly pinned ancestor commit), replayed onto the queue's `repairHead` by
 * `admitPathsOntoRepairHead`. Nothing here fast-forwards, merges, or reads the tip as a whole —
 * the pre-D-004 `converge` (fast-forward repairHead to the staging tip) is gone, and `converge`
 * is now only an alias for `admit` so a stale runbook still lands on the right door.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { trackDetached } from '../../detached-imports';
import {
  applyFrozenCandidateRepairQueueTransition,
  readFrozenCandidateRepairQueueState,
  retireFrozenCandidateRepairQueue,
  writeFrozenCandidateRepairQueue,
} from '../../harness/routines/release-actions';
import { integrationRoot } from '../../release-deploy-launch';
import { releaseFixerSpawnAlive } from '../../release/fixer-liveness';
import { checkpointPidIdentity } from '../../release/checkpoint-qualification-transaction';
import { isPidAlive } from '../../release/in-flight-candidate';
import {
  describeUnreadableFrozenCandidateRepairQueue,
  diagnoseFrozenCandidateRepairQueue,
  markFrozenRepairAdmitted,
  normalizeRepoPath,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
  type FrozenRepairAdmissionPrecheck,
} from '../../release/frozen-candidate-repair-queue';
import {
  parseFrozenRepairEditHunk,
  readFrozenRepairEditLedger,
  recordFrozenRepairEdit,
  type FrozenRepairEditLedgerRow,
} from '../../release/frozen-repair-edit-ledger';
import {
  buildCommittedPatchSource,
  buildHunkExactSource,
  summarizeForeignHunks,
  type HunkExactSuccess,
} from '../../release/hunk-exact-admission';
import { containmentForPaths, integrationBranch } from '../../release/judged-sha-containment';
import { importCompletenessPreflight } from '../../release/admission-import-completeness';
import {
  chainAdmissionPreflights,
  lockfileManifestConsistencyPreflight,
} from '../../release/admission-lockfile-consistency';
import { admitPathsOntoRepairHead, realAdmissionGit, retractAdmission } from '../../release/repair-head-admission';
import {
  createCheckpointTreeFixPrecheckRunner,
  evaluateFixPrecheck,
  precheckPopulation,
  resolveCanonicalIntegrationRoot,
  type FixPrecheckPopulation,
  type FixPrecheckProgress,
  type FixPrecheckVerdict,
} from '../../release/admission-fix-precheck';
import { checkpointRootMirror } from '../../release-checkpoint-launch';
import {
  describeDependencyPrediction,
  isDependencyInputPath,
  predictDependencyGeneration,
  type DependencyGenerationPrediction,
} from '../../release/dependency-admission-prediction';
import { claimRepairManifestLeg, renderAdmitCommand } from '../../release/repair-manifest';
import { readIdentity } from '../locks/identity';
import { readGateOwnership, shouldStandDownForLivePeer } from '../../coord/gate-ownership';
import { executeWithGateActionReceipt } from '../../release/gate-action-receipt';

const json = (payload: unknown) => ({ data: payload });
const target = () => ({ workspaceId: activeWorkspaceId(), installSlug: operatorHomeHarnessSlug() });
const FULL_COMMIT_SHA = /^[0-9a-f]{40,64}$/;
const queueIdentityFields = {
  /** The frozen queue snapshot the caller read before building this admission. */
  expectedCandidate: z
    .string()
    .regex(/^[0-9a-fA-F]{40,64}$/)
    .optional(),
  expectedRepairHead: z
    .string()
    .regex(/^[0-9a-fA-F]{40,64}$/)
    .optional(),
  expectedUpdatedAtMs: z.number().int().nonnegative().optional(),
};
type QueueIdentityArgs = {
  expectedCandidate?: string;
  expectedRepairHead?: string;
  expectedUpdatedAtMs?: number;
};
type QueueIdentity = {
  expectedCandidate: string;
  expectedRepairHead: string;
  expectedUpdatedAtMs: number;
};

/**
 * The identity tuple is optional for backwards-compatible reads/dry-runs, but it is never
 * partially meaningful. The schema rejects partial tuples; this runtime helper keeps direct
 * handler calls equally fail-closed when a caller bypasses the parser in a unit test.
 */
function readQueueIdentity(args: QueueIdentityArgs): QueueIdentity | null {
  const fields: Array<keyof QueueIdentityArgs> = ['expectedCandidate', 'expectedRepairHead', 'expectedUpdatedAtMs'];
  const supplied = fields.filter((field) => args[field] !== undefined);
  if (supplied.length === 0) return null;
  if (supplied.length !== fields.length) {
    throw new Error(
      'release:repair-queue admit expectedCandidate, expectedRepairHead, and expectedUpdatedAtMs must be supplied together',
    );
  }
  return {
    expectedCandidate: args.expectedCandidate!,
    expectedRepairHead: args.expectedRepairHead!,
    expectedUpdatedAtMs: args.expectedUpdatedAtMs!,
  };
}
const argsSchema = z.preprocess(
  (value) => {
    // The read branch has no arguments. Treat an omitted op on an otherwise
    // empty object as the read operation, while leaving malformed branch
    // payloads subject to the discriminated-union requirements below.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 0) {
        return { op: 'get' };
      }
      // `status` is the read verb across the sibling release:* family —
      // `release:deploy { op: 'status' }` is the documented read for the very
      // same intent — so agents reach for it here and get an invalid_input
      // refusal naming an enum with no `status` in it. Measured 3x in 24h from
      // 2 distinct agents. Accept it as an alias for the read branch rather
      // than leaving the family's naming split. The result `op` echoes the
      // normalized `get`, so downstream readers see one canonical value.
      if (record.op === 'status') {
        return { ...record, op: 'get' };
      }
    }
    return value;
  },
  z
    .discriminatedUnion('op', [
      z.object({ op: z.literal('get') }),
      z.object({
        op: z.literal('admit'),
        /** Repo-relative paths your fix touched — the admission allowlist. REQUIRED: an admission is by explicit path. */
        paths: z.array(z.string().min(1)).min(1).max(50),
        reason: z.string().min(8).max(2000).optional(),
        confirm: z.boolean().optional(),
        /** Optional work-item reference linking this admission to its tracked fix. */
        workItem: z.string().max(120).optional(),
        ...queueIdentityFields,
        /** P-020 (D-008 3a): ALSO replay these agents' ledgered hunks — a genuinely shared fix. Never implied. */
        includeHunksFrom: z.array(z.string().min(1).max(200)).max(20).optional(),
        /** P-020 (D-008 3b): admit staging's WHOLE blob (may carry foreign work). Requires `reason`; the ledger records every foreign hunk it carries. */
        wholeBlob: z.boolean().optional(),
        /** Pin whole-blob reads to one immutable integration-branch ancestor so a reviewed preview cannot drift with staging. */
        sourceCommit: z.string().regex(FULL_COMMIT_SHA).optional(),
        /** Explicit reviewed single-commit delta from staging history when hook capture is missing. Requires reason; incompatible with other source options. */
        patchCommit: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional(),
        /** P-006 (R6, D-002): opt OUT of the admission pre-check for a deliberate wide admission. Requires `precheckReason`; recorded on the ledger entry. */
        skipPrecheck: z.boolean().optional(),
        precheckReason: z.string().min(8).max(2000).optional(),
        /** Retry a terminal failed pre-check for the same immutable built commit. A running one is never duplicated. */
        retryPrecheck: z.boolean().optional(),
      }),
      z.object({
        /** Alias of admit, kept so a stale runbook lands on the same door. Identical semantics. */
        op: z.literal('converge'),
        paths: z.array(z.string().min(1)).min(1).max(50),
        reason: z.string().min(8).max(2000).optional(),
        confirm: z.boolean().optional(),
        /** Optional work-item reference linking this aliased admission to its tracked fix. */
        workItem: z.string().max(120).optional(),
        ...queueIdentityFields,
        includeHunksFrom: z.array(z.string().min(1).max(200)).max(20).optional(),
        wholeBlob: z.boolean().optional(),
        sourceCommit: z.string().regex(FULL_COMMIT_SHA).optional(),
        patchCommit: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional(),
        skipPrecheck: z.boolean().optional(),
        precheckReason: z.string().min(8).max(2000).optional(),
        retryPrecheck: z.boolean().optional(),
      }),
      z.object({
        /**
         * P-021 (D-007 #1): claim one repair-manifest leg. Claiming a leg claims its subject
         * paths — the caller's presence `current_files` is set to them so peers see the lane.
         * `release:true` gives the leg back (only the holder may).
         */
        op: z.literal('claim-leg'),
        /** The manifest row's `legId` (from get → repairQueue.manifest.rows[].legId). */
        leg: z.string().min(1).max(300),
        release: z.boolean().optional(),
      }),
      z.object({
        /**
         * P-019 (D-008 layer 1) — HOOK PLUMBING, never called by hand. The PostToolUse
         * edit hook records the exact hunk of one Edit/Write made while a candidate is frozen,
         * attributed to the calling per-session owner. P-020's hunk-exact admission replays it.
         */
        op: z.literal('record-edit'),
        /** Repo-relative path the edit touched (normalized server-side). */
        path: z.string().min(1).max(1024),
        hunk: z.unknown(),
        /** The client's tool_use_id — with editIndex, the idempotency key for a retried hook call. */
        toolUseId: z.string().max(200).optional(),
        editIndex: z.number().int().nonnegative().optional(),
        atMs: z.number().int().positive().optional(),
        /** The candidate the hook's marker named; a mismatch with the live queue is reported, never trusted. */
        candidate: z
          .string()
          .regex(/^[0-9a-fA-F]{40,64}$/)
          .optional(),
        workItem: z.string().max(120).optional(),
      }),
      z.object({
        op: z.literal('retire'),
        expectedCandidate: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
        expectedRepairHead: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
        expectedUpdatedAtMs: z.number().int().nonnegative(),
        reason: z.string().min(8).max(2000),
        confirm: z.boolean().optional(),
      }),
    ])
    .superRefine((value, refinementCtx) => {
      if (value.op !== 'admit' && value.op !== 'converge') return;
      if (
        value.patchCommit !== undefined &&
        (value.wholeBlob === true ||
          value.sourceCommit !== undefined ||
          value.includeHunksFrom !== undefined ||
          !value.reason ||
          value.reason.trim().length < 8)
      ) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['patchCommit'],
          message: 'patchCommit requires a review reason and cannot combine with wholeBlob or includeHunksFrom',
        });
      }
      if (value.sourceCommit !== undefined && value.wholeBlob !== true) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceCommit'],
          message: 'sourceCommit is only valid with wholeBlob:true',
        });
      }
      const fields: Array<keyof QueueIdentityArgs> = ['expectedCandidate', 'expectedRepairHead', 'expectedUpdatedAtMs'];
      const supplied = fields.filter((field) => value[field] !== undefined).length;
      if (supplied === 0 || supplied === fields.length) return;
      for (const field of fields) {
        if (value[field] === undefined) {
          refinementCtx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: 'expectedCandidate, expectedRepairHead, and expectedUpdatedAtMs must be supplied together',
          });
        }
      }
    }),
);

export type FrozenRepairFixerAuthorizationStatus =
  | 'not-applicable'
  | 'unsigned-caller'
  | 'missing-spawn-id'
  | 'no-repair-queue'
  | 'wrong-phase'
  | 'queue-unassigned'
  | 'different-fixer'
  | 'queue-unreadable'
  | 'authorized-delegate';

export interface FrozenRepairFixerAuthorization {
  status: FrozenRepairFixerAuthorizationStatus;
  authorized: boolean | null;
  callerSpawnId: string | null;
  queueFixerSpawnId: string | null;
  safeAction: string;
}

/**
 * Authenticate a frozen-candidate release-fixer against the queue that launched it.
 *
 * A live su owns LIVE_GATE_OPS while the queue delegates the file/test repair to one
 * child. The generic ownership cell cannot distinguish that child from an unrelated
 * would-be fixer, so the child used to see the parent's live hold and self-cancel.
 * The signed MCP spawn id is the non-forgeable join: only the queue's current
 * `fixerSpawnId` is the delegated worker. Every missing/mismatched state fails closed.
 */
export function assessFrozenRepairFixerAuthorization(
  queue: FrozenCandidateRepairQueue | null,
  caller: {
    role?: string | null;
    spawnId?: string | null;
    sigVerifiedSpawn?: boolean | null;
    isSuperuser?: boolean | null;
  },
): FrozenRepairFixerAuthorization {
  const callerSpawnId = typeof caller.spawnId === 'string' && caller.spawnId.trim() ? caller.spawnId.trim() : null;
  const queueFixerSpawnId = queue?.fixerSpawnId ?? null;
  const result = (
    status: FrozenRepairFixerAuthorizationStatus,
    authorized: boolean | null,
    safeAction: string,
  ): FrozenRepairFixerAuthorization => ({
    status,
    authorized,
    callerSpawnId,
    queueFixerSpawnId,
    safeAction,
  });

  // EI-22208176411693669: the superuser-bearer transport (`?superuser=1` + loopback
  // bearer, _mcp-handler.ts's SU-bearer branch) never carries a verified per-spawn
  // signature — sigVerifiedSpawn is unconditionally absent/false there — and its
  // `?role=` query param is DELIBERATELY only a `tools/list` catalog-narrowing hint
  // (token-usage-reduction P-011), never a security identity assertion; dispatch
  // capability on that branch is already unconditional (isSuperuser bypasses role
  // gates platform-wide). So this caller can never legitimately reach
  // 'authorized-delegate' through the signed-spawn check no matter which role its
  // catalog was narrowed to — including 'release-fixer', which previously slipped
  // past the check below and landed on the fail-closed 'unsigned-caller' verdict
  // even when the caller genuinely was the queue's own delegated fixer. Route it to
  // 'not-applicable' like any other non-release-fixer-role caller: the buildReleaseFixerKickoff
  // brief already documents the fallback (compare fixerSpawnId to PAPERCUSP_SID
  // directly), and the converge write-gate independently authorizes this transport tier.
  if (caller.isSuperuser === true) {
    return result(
      'not-applicable',
      null,
      'This caller reached the queue over the superuser-bearer transport, which carries no verified per-spawn signature regardless of its ?role= catalog hint — the signed-delegate check does not apply here. Compare repairQueue.fixerSpawnId directly against your own PAPERCUSP_SID to confirm you remain the delegated fixer; converge is independently authorized for this transport tier.',
    );
  }
  if (caller.role !== 'release-fixer') {
    return result(
      'not-applicable',
      null,
      'This caller is not a release-fixer; use the ordinary operator/su queue policy.',
    );
  }
  if (caller.sigVerifiedSpawn !== true) {
    return result(
      'unsigned-caller',
      false,
      'STOP: the caller has no verified signed-spawn provenance, so it cannot inherit delegated repair authority.',
    );
  }
  if (!callerSpawnId) {
    return result('missing-spawn-id', false, 'STOP: the signed request carried no usable spawn id.');
  }
  if (!queue) {
    return result('no-repair-queue', false, 'STOP: no frozen repair queue currently delegates work.');
  }
  if (queue.phase !== 'awaiting-fixer') {
    return result('wrong-phase', false, `STOP: the repair queue is ${queue.phase}, not awaiting-fixer.`);
  }
  if (!queue.fixerSpawnId) {
    return result(
      'queue-unassigned',
      false,
      'STOP: the queue has not durably assigned a fixer spawn yet; retry the read after dispatch finalization rather than guessing.',
    );
  }
  if (queue.fixerSpawnId !== callerSpawnId) {
    return result('different-fixer', false, `STOP: this queue is delegated to ${queue.fixerSpawnId}, not this caller.`);
  }
  return result(
    'authorized-delegate',
    true,
    "Proceed only with the assigned repair: author on the shared staging checkout and land it with op:'admit' (path-exact; there is no repair worktree). A separate held-live LIVE_GATE_OPS owner is your delegator, not a competing fixer. Do not claim the gate, launch a checkpoint, mutate deployment, or work outside this queue identity.",
  );
}

/**
 * P-027 (D-014): before the door decides anything, make the row agree with the lineage ref.
 * A row that fell BEHIND the ref (a pre-D-014 run write-back dropped an admission the ref kept)
 * would otherwise refuse every admit with `lineage-ref-moved` until a human reset the ref by
 * hand. The rebuild is derived from the commits and persisted through the CAS transition, so a
 * concurrent writer is carried, not overwritten; a refusal (`ref-behind-row`, foreign commit,
 * git fault) leaves the row untouched and is reported on the inspect. Never fatal: an inspect
 * that cannot reconcile still answers with the row as stored.
 */
async function reconcileQueueRowWithLineage(
  queueTarget: ReturnType<typeof target>,
  queue: FrozenCandidateRepairQueue,
): Promise<{
  queue: FrozenCandidateRepairQueue;
  ledger: { status: string; reconciled: number; detail: string } | null;
}> {
  try {
    const { reconcileFrozenRepairQueueWithLineageRef } = await import('../../release/frozen-lineage-ledger-reconcile');
    const { applyFrozenCandidateRepairQueueTransition } = await import('../../harness/routines/release-actions');
    const root = integrationRoot();
    const probe = reconcileFrozenRepairQueueWithLineageRef(queue, { root });
    if (probe.status === 'in-sync') return { queue, ledger: null };
    if (probe.status !== 'reconciled') {
      return { queue, ledger: { status: probe.status, reconciled: 0, detail: probe.detail } };
    }
    let last = probe;
    const outcome = await applyFrozenCandidateRepairQueueTransition(queueTarget, (fresh) => {
      last = reconcileFrozenRepairQueueWithLineageRef(fresh, { root });
      return last.queue;
    });
    return {
      queue: outcome.queue ?? last.queue,
      ledger: { status: last.status, reconciled: last.reconciled.length, detail: last.detail },
    };
  } catch (err) {
    return {
      queue,
      ledger: { status: 'reconcile-failed', reconciled: 0, detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function inspectQueue() {
  const queueTarget = target();
  const read = await readFrozenCandidateRepairQueueState(queueTarget);
  let queue = read.status === 'value' ? read.queue : null;
  let ledger: { status: string; reconciled: number; detail: string } | null = null;
  if (queue) ({ queue, ledger } = await reconcileQueueRowWithLineage(queueTarget, queue));
  // R6 runs in this host's process, not a persistent worker. A normal service restart
  // kills its setup/test child and its in-memory finalizer. The marker must not keep
  // advertising "running" until the entire per-file timeout budget expires.
  const pending = queue?.admissionPrecheck;
  if (queue && pending?.status === 'running' && pending.runnerPidIdentity && pending.runnerPid) {
    const alive = isPidAlive(pending.runnerPid);
    const observedIdentity = alive === true ? checkpointPidIdentity(pending.runnerPid) : null;
    if (alive === false || (observedIdentity !== null && observedIdentity !== pending.runnerPidIdentity)) {
      const detail =
        `R6 pre-check host process ${pending.runnerPid} ended or was replaced before settling ` +
        `${pending.operationId}; no test verdict exists for ${pending.builtCommit.slice(0, 12)}. ` +
        'The admission remains fail-closed; retryPrecheck:true starts a fresh measurement.';
      const verdict = evaluateFixPrecheck(
        precheckPopulation({ signature: queue.signature, admittedPaths: pending.files }),
        { ran: false, reason: 'runner-failed', detail },
      );
      try {
        await settleAdmissionPrecheck(queueTarget, pending.operationId, verdict);
        const refreshed = await readFrozenCandidateRepairQueueState(queueTarget);
        if (refreshed.status === 'value') queue = refreshed.queue;
      } catch (err) {
        ledger = {
          status: 'precheck-reconcile-failed',
          reconciled: 0,
          detail: `Could not persist host-restart failure for ${pending.operationId}: ${String(err)}`,
        };
      }
    }
  }
  let fixerAlive: boolean | null | undefined;
  if (queue?.fixerSpawnId) {
    fixerAlive = await releaseFixerSpawnAlive(getOrgPg().sql, queue.fixerSpawnId).catch(() => null);
  }
  return {
    target: queueTarget,
    read,
    queue,
    fixerAlive,
    /** P-027: null when the row already agreed with the lineage ref; otherwise what the reconcile did or refused. */
    ledger,
    diagnostic: diagnoseFrozenCandidateRepairQueue(queue, { nowMs: Date.now(), fixerAlive }),
  };
}

async function inspectFixerLiveness(queue: FrozenCandidateRepairQueue | null) {
  if (!queue?.fixerSpawnId) return null;
  return releaseFixerSpawnAlive(getOrgPg().sql, queue.fixerSpawnId).catch(() => null);
}

/** P-006 (R6): the compact pre-check record carried on the ledger entry, the audit row and the result. */
function precheckRecordOf(
  verdict: FixPrecheckVerdict | null,
  ctx: { skipPrecheck: boolean; precheckReason: string; dryRun: boolean; population: FixPrecheckPopulation },
): NonNullable<FrozenRepairAdmission['precheck']> {
  if (verdict === null) {
    if (ctx.skipPrecheck)
      return { ran: false, reason: 'skipped', precheckReason: ctx.precheckReason, wouldRun: ctx.population.files };
    if (ctx.population.files.length === 0) return { ran: false, reason: 'nothing-to-run' };
    return { ran: false, reason: ctx.dryRun ? 'dry-run' : 'not-run', wouldRun: ctx.population.files };
  }
  if (verdict.ran) {
    return {
      ran: true,
      commit: verdict.commit,
      passing: verdict.passing,
      failing: verdict.failing,
      unmeasured: verdict.unmeasured,
      ...(verdict.ok ? { fixes: verdict.fixes } : {}),
    };
  }
  return {
    ran: false,
    reason: verdict.reason,
    ...('detail' in verdict ? { detail: verdict.detail } : {}),
    wouldRun: ctx.population.files,
  };
}

const ADMISSION_PRECHECK_SETUP_BUDGET_MS = 20 * 60_000;
const ADMISSION_PRECHECK_PER_FILE_BUDGET_MS = 10 * 60_000;
const ADMISSION_PRECHECK_SETTLEMENT_BUDGET_MS = 60_000;

function sameAdmissionPrecheck(
  state: FrozenRepairAdmissionPrecheck | undefined,
  input: {
    root: string;
    candidate: string;
    repairHead: string;
    builtCommit: string;
    builtTree: string;
    files: readonly string[];
    actor: string;
  },
): state is FrozenRepairAdmissionPrecheck {
  if (!state) return false;
  const measuredTree = (() => {
    if (state.builtTree !== undefined) return state.builtTree;
    if (state.builtCommit === input.builtCommit) return input.builtTree;
    const result = realAdmissionGit(['rev-parse', '--verify', `${state.builtCommit}^{tree}`], { cwd: input.root });
    const tree = result.stdout.trim();
    return result.status === 0 && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  })();
  return (
    state.candidate === input.candidate &&
    state.repairHead === input.repairHead &&
    // EI-23137352034265370: source-tip/reason provenance lives in the synthetic commit
    // message, so two builds can have different commit ids while carrying the exact same
    // admission tree on the same repairHead. Legacy markers resolve their commit tree here.
    measuredTree === input.builtTree &&
    state.actor === input.actor &&
    state.files.length === input.files.length &&
    state.files.every((file, index) => file === input.files[index])
  );
}

function admissionPrecheckDeadline(startedAtMs: number, files: readonly string[]): number {
  return (
    startedAtMs +
    ADMISSION_PRECHECK_SETUP_BUDGET_MS +
    files.length * ADMISSION_PRECHECK_PER_FILE_BUDGET_MS +
    ADMISSION_PRECHECK_SETTLEMENT_BUDGET_MS
  );
}

async function settleAdmissionPrecheck(
  queueTarget: ReturnType<typeof target>,
  operationId: string,
  verdict: FixPrecheckVerdict,
): Promise<void> {
  const settledAtMs = Date.now();
  await applyFrozenCandidateRepairQueueTransition(queueTarget, (fresh) => {
    const current = fresh.admissionPrecheck;
    if (!current || current.operationId !== operationId || current.status !== 'running') return fresh;
    const { dispatchReservation, ...rest } = fresh;
    return {
      ...rest,
      ...(dispatchReservation?.token === operationId ? {} : { dispatchReservation }),
      admissionPrecheck: {
        ...current,
        status: verdict.ok ? (verdict.ran ? 'passed' : 'deferred') : 'failed',
        verdict,
        updatedAtMs: settledAtMs,
      },
      updatedAtMs: Math.max(fresh.updatedAtMs + 1, settledAtMs),
    };
  });
}

async function recordAudit(actor: string, details: Record<string, unknown>): Promise<boolean> {
  try {
    const id = `repair-queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await getOrgPg().sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        Date.now(),
        actor,
        'release:repair-queue',
        'green-checkpoint:repair-queue',
        JSON.stringify(details),
        activeWorkspaceId(),
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export default defineTool({
  name: 'release:repair-queue',
  profile: 'engineer',
  description:
    'Inspect, admit paths onto, claim a manifest leg, or retire the frozen repair queue. Workspace-global; omit harness/workspace. `admit{paths,...}` is the only door for a gate-red fix on judged lineage: it replays exactly the named integration-branch paths onto repairHead as one proved commit; `wholeBlob:true, sourceCommit:<ancestor SHA>` pins a reviewed source against later staging drift. Dry-run unless `confirm:true`. A confirmed admission with R6 test files first returns an observable `precheck-running` operation; no background leg publishes. `converge` aliases `admit`; `retire` is an exact-identity CAS and dry-run unless confirmed.',
  capability: 'operator:write',
  effectForCall: (args) => {
    const op = (args as { op?: unknown }).op;
    return op === undefined ||
      op === 'get' ||
      ((op === 'admit' || op === 'converge') && (args as { confirm?: unknown }).confirm !== true)
      ? 'read'
      : 'write';
  },
  requirePrincipal: false,
  // The release-fixer's runbook uses the read/dry-run and confirmed admit
  // paths; its existing operator:write cap keeps the write branch guarded.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  rolesQuota: { operator: { perRun: 20 } },
  guidance: {
    when: 'After a gate-red fix is committed on staging, use `admit{paths}` for exactly the changed files; also inspect a frozen, blocked, or dead-fixer queue.',
    notWhen:
      'Workspace-global: never pass harness/workspace. Never catch up to tip, retire live/unknown work, launch a checkpoint, or deploy.',
    chaining:
      '`get` → dry-run `admit{paths, expectedCandidate, expectedRepairHead, expectedUpdatedAtMs}` → verify proof → repeat with `confirm:true`. If staging may move between preview and confirmation, use `wholeBlob:true, sourceCommit:<reviewed integration ancestor SHA>, reason`. If R6 returns `precheck-running`, read it via `get`, then repeat with refreshed identity after pass; retry only a terminal failed pre-check. For missed hook capture, `patchCommit:<full SHA>, reason` replays that commit’s named-path delta. Retire only when `get` proves `retireAllowed` and pass its exact identity.',
    returns:
      '{ ok, op, verdict?, repairQueueRead?, admitted?, precheckOperation?, dryRun?, judgedSha?, nextAction?, containment?, proof? }. Read `nextAction`; mutations report verdict plus proof/containment and retire uses CAS.',
    seeAlso: ['release:deploy', 'dev:pipeline_position', 'release:trace'],
  },
  args: argsSchema,
  result: z
    .object({
      ok: z.boolean().optional(),
      op: z.enum(['get', 'admit', 'claim-leg', 'record-edit', 'retire']).optional(),
      recorded: z.boolean().optional(),
      target: z.unknown().optional(),
      repairQueue: z.unknown().nullable().optional(),
      repairQueueRead: z.unknown().optional(),
      callerAuthorization: z.unknown().optional(),
      verdict: z.string().optional(),
      admitted: z.boolean().optional(),
      precheckOperation: z.unknown().optional(),
      dryRun: z.boolean().optional(),
      judgedSha: z.string().nullable().optional(),
      source: z.unknown().optional(),
      nextAction: z.unknown().nullable().optional(),
      containment: z.unknown().nullable().optional(),
      proof: z.unknown().optional(),
      admission: z.unknown().optional(),
      lineageRef: z.string().optional(),
      wouldMoveRepairHead: z.unknown().optional(),
      movedRepairHead: z.unknown().optional(),
      persisted: z.boolean().optional(),
      auditRecorded: z.boolean().optional(),
      note: z.string().optional(),
      reason: z.string().optional(),
      detail: z.string().optional(),
      stray: z.array(z.string()).optional(),
      retired: z.boolean().optional(),
      // WI-1105109: the post-retire procedure statement. Declared rather than left to
      // .passthrough() so it is part of the contract a test can pin.
      nextStep: z.string().optional(),
      alreadyClear: z.boolean().optional(),
      refused: z.boolean().optional(),
      casMiss: z.boolean().optional(),
      current: z.unknown().nullable().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const inspected = await inspectQueue();
    const compactRead =
      inspected.read.status === 'value'
        ? { status: 'value' as const, schemaVersion: inspected.read.queue.schemaVersion }
        : inspected.read;
    const renderedQueue = inspected.read.status === 'unreadable' ? inspected.read : inspected.diagnostic;
    const callerAuthorization: FrozenRepairFixerAuthorization =
      inspected.read.status === 'unreadable'
        ? {
            status: 'queue-unreadable',
            authorized: false,
            callerSpawnId: typeof ctx.spawnId === 'string' && ctx.spawnId.trim() ? ctx.spawnId.trim() : null,
            queueFixerSpawnId: null,
            safeAction:
              `STOP: ${describeUnreadableFrozenCandidateRepairQueue(inspected.read)}. ` +
              'Do not infer that the queue is clear; use a reader that understands this schema.',
          }
        : assessFrozenRepairFixerAuthorization(inspected.queue, {
            role: ctx.role,
            spawnId: ctx.spawnId,
            sigVerifiedSpawn: ctx.sigVerifiedSpawn,
            isSuperuser: ctx.isSuperuser,
          });
    if (args.op === 'get') {
      return json({
        ok: true,
        op: 'get',
        target: inspected.target,
        repairQueue: renderedQueue,
        repairQueueRead: compactRead,
        callerAuthorization,
        // P-027 (D-014): ledger/ref agreement. Absent ⇒ in sync on this read; `reconciled` ⇒ the
        // row was rebuilt from the lineage ref just now; any other status ⇒ a disagreement this
        // read refused to repair, with the reason.
        ...(inspected.ledger ? { lineageLedger: inspected.ledger } : {}),
      });
    }
    if (inspected.read.status === 'unreadable') {
      const op =
        args.op === 'retire'
          ? 'retire'
          : args.op === 'claim-leg'
            ? 'claim-leg'
            : args.op === 'record-edit'
              ? 'record-edit'
              : 'admit';
      return json({
        ok: false,
        op,
        ...(op === 'retire'
          ? { retired: false }
          : op === 'claim-leg'
            ? { claimed: false }
            : op === 'record-edit'
              ? { recorded: false }
              : { admitted: false }),
        refused: true,
        verdict: 'refused',
        reason: 'repair-queue-unreadable',
        detail:
          `${describeUnreadableFrozenCandidateRepairQueue(inspected.read)}; ` +
          'no queue mutation or moving-tip fallback was attempted',
        target: inspected.target,
        repairQueue: inspected.read,
        repairQueueRead: compactRead,
        callerAuthorization,
      });
    }
    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = readIdentity(ctx).ownerId;
    } catch {
      // The action receipt remains explicitly unknown if identity cannot be resolved.
    }
    let ownership: Awaited<ReturnType<typeof readGateOwnership>> | null = null;
    let ownershipObservedAt: string | null = null;
    try {
      ownership = await readGateOwnership({ harness: inspected.target.installSlug });
      ownershipObservedAt = new Date().toISOString();
    } catch {
      // A failed observation cannot be promoted to ownership proof.
    }
    const gateOwnershipReceipt = ownership?.claimState === 'held' && ownership.workItem
      ? { certainty: 'prelaunch-observation' as const, observedAt: ownershipObservedAt,
          conditionKey: ownership.eventKey, workItem: ownership.workItem,
          holder: ownership.takenBy, takenAt: ownership.takenAt,
          claimState: ownership.claimState, assessment: ownership.assessment }
      : { certainty: 'unknown' as const, observedAt: ownershipObservedAt,
          conditionKey: ownership?.eventKey ?? null, workItem: ownership?.workItem ?? null,
          holder: ownership?.takenBy ?? null, reason: ownership?.unknown?.code ?? 'no-held-condition' };
    let effectReceipt: { receiptId: string; ownership: Record<string, unknown> } | null = null;
    const stampActionEffect = (effect: Record<string, unknown>) => ctx.metadata?.({
      gateActionReceipt: {
        schemaVersion: effectReceipt ? 2 : 1,
        action: `repair-queue:${args.op}`,
        callerOwnerId,
        ...(effectReceipt ? { receiptId: effectReceipt.receiptId } : {}),
        ownership: effectReceipt?.ownership ?? gateOwnershipReceipt,
        delegate: {
          status: callerAuthorization.status,
          authorized: callerAuthorization.authorized,
          callerSpawnId: callerAuthorization.callerSpawnId,
          queueFixerSpawnId: callerAuthorization.queueFixerSpawnId,
        },
        target: { candidate: inspected.queue?.candidate ?? null, repairHead: inspected.queue?.repairHead ?? null },
        effect,
      },
    });
    stampActionEffect({ status: 'unknown', reason: 'no-settled-effect-receipt' });
    if (args.op !== 'record-edit' && callerAuthorization.status !== 'authorized-delegate' &&
        ownership && shouldStandDownForLivePeer(ownership, callerOwnerId)) {
      stampActionEffect({ status: 'refused-live-peer' });
      return json({ ok: false, op: args.op, refused: true, verdict: 'refused',
        reason: 'gate_condition_claimed_by_live_peer', ownership: gateOwnershipReceipt });
    }
    if (args.op === 'record-edit') {
      // P-019 (D-008 layer 1). The hook only calls this while the marker file exists, so the
      // common case never reaches here; when it does and nothing is frozen (a race with a
      // retire/promotion), there is no lineage to attribute to and nothing is written.
      const queue = inspected.queue;
      const base = { op: 'record-edit' as const, target: inspected.target, repairQueueRead: compactRead };
      if (!queue) {
        return json({ ok: true, recorded: false, verdict: 'no-frozen-queue', judgedSha: null, ...base });
      }
      const hunk = parseFrozenRepairEditHunk(args.hunk);
      if (!hunk) {
        return json({
          ok: false,
          recorded: false,
          refused: true,
          verdict: 'refused',
          reason: 'invalid-hunk',
          detail:
            "hunk must be { kind:'edit', old, new, replaceAll? } | { kind:'write', body } | { kind:'oversize', of, bytes, sha256 }",
          judgedSha: queue.repairHead,
          ...base,
        });
      }
      const identity = readIdentity(ctx);
      let outcome:
        | Awaited<ReturnType<typeof recordFrozenRepairEdit>>
        | { ok: false; reason: 'persist_failed'; detail: string };
      try {
        outcome = await recordFrozenRepairEdit(getOrgPg().sql, {
          workspaceId: inspected.target.workspaceId,
          installSlug: inspected.target.installSlug,
          candidate: queue.candidate,
          agent: identity.ownerId,
          path: args.path,
          hunk,
          atMs: typeof args.atMs === 'number' && args.atMs > 0 ? args.atMs : Date.now(),
          toolUseId: args.toolUseId ?? '',
          editIndex: args.editIndex ?? 0,
          workItem: args.workItem ?? null,
        });
      } catch (err) {
        outcome = { ok: false, reason: 'persist_failed', detail: (err as Error).message };
      }
      if (!outcome.ok) {
        return json({
          ok: false,
          recorded: false,
          refused: true,
          verdict: 'refused',
          reason: outcome.reason,
          detail: outcome.detail,
          judgedSha: queue.repairHead,
          candidate: queue.candidate,
          ...base,
        });
      }
      const failing = new Set(queue.failingTests.map(normalizeRepoPath));
      const subject = new Set((queue.manifest?.rows ?? []).flatMap((row) => row.subjectPaths.map(normalizeRepoPath)));
      const inRepairRadius = failing.has(outcome.path) || subject.has(outcome.path);
      const suppliedCandidate = args.candidate?.toLowerCase();
      stampActionEffect({ status: 'edit-recorded', recorded: true, inserted: outcome.inserted,
        ledgerId: outcome.id, path: outcome.path });
      return json({
        ok: true,
        recorded: true,
        inserted: outcome.inserted,
        oversize: outcome.oversize,
        ledgerId: outcome.id,
        path: outcome.path,
        agent: identity.ownerId,
        candidate: queue.candidate,
        judgedSha: queue.repairHead,
        inRepairRadius,
        admitCommand: renderAdmitCommand([outcome.path]),
        ...(suppliedCandidate && suppliedCandidate !== queue.candidate.toLowerCase()
          ? { candidateMismatch: { marker: suppliedCandidate, queue: queue.candidate } }
          : {}),
        ...base,
      });
    }
    if (args.op === 'admit' || args.op === 'converge') {
      const root = integrationRoot();
      const branch = integrationBranch();
      const queue = inspected.queue;
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
      const base = {
        op: 'admit' as const,
        target: inspected.target,
        source: { ref: branch, root },
        repairQueue: inspected.diagnostic,
        repairQueueRead: compactRead,
        callerAuthorization,
      };
      if (!queue) {
        return json({
          ok: true,
          admitted: false,
          verdict: 'no-frozen-queue',
          judgedSha: null,
          containment: null,
          nextAction:
            'No frozen repair queue. Fix on staging as normal — git-sync commits it and the next ' +
            'candidate is cut from that tip. Do not fire release:checkpoint-run.',
          ...base,
        });
      }
      const containmentAt = (judgedSha: string) =>
        paths.length ? containmentForPaths(paths, judgedSha, root, undefined, branch) : null;
      if (paths.length === 0) {
        return json({
          ok: false,
          admitted: false,
          refused: true,
          verdict: 'refused',
          reason: 'paths_required',
          detail:
            'admit is by explicit path allowlist: name exactly the repo-relative files your fix changed. ' +
            'Nothing is ever admitted by tip, branch or "everything since the candidate".',
          judgedSha: queue.repairHead,
          containment: null,
          ...base,
        });
      }
      const dryRun = args.confirm !== true;
      const expectedQueueIdentity = readQueueIdentity(args);
      if (
        expectedQueueIdentity &&
        (queue.candidate !== expectedQueueIdentity.expectedCandidate ||
          queue.repairHead !== expectedQueueIdentity.expectedRepairHead ||
          queue.updatedAtMs !== expectedQueueIdentity.expectedUpdatedAtMs)
      ) {
        return json({
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          reason: 'exact_queue_identity_mismatch',
          detail:
            'The queue changed after the caller read it; no admission was built. Re-read with op:get and retry with the complete expectedCandidate/expectedRepairHead/expectedUpdatedAtMs tuple.',
          judgedSha: queue.repairHead,
          currentQueueIdentity: {
            candidate: queue.candidate,
            repairHead: queue.repairHead,
            updatedAtMs: queue.updatedAtMs,
          },
          expectedQueueIdentity,
          containment: containmentAt(queue.repairHead),
          ...base,
        });
      }
      // EI-22208176411693669: assessFrozenRepairFixerAuthorization above already routes
      // an isSuperuser caller to 'not-applicable' (never 'authorized-delegate') because
      // the SU-bearer transport carries no verified per-spawn signature regardless of its
      // cosmetic ?role= catalog hint. Without this clause a superuser caller whose ?role=
      // was forwarded as 'release-fixer' would still fail every disjunct here (role!=='su',
      // not an OPERATOR_CONFIG_WRITE_ROLE, authorized!==true) and be wrongly thrown out of
      // admission — even though dispatch capability on that transport is already
      // unconditional (isSuperuser bypasses role gates platform-wide, per
      // tool-projection.ts). Mirror that bypass here explicitly.
      if (
        ctx.role !== 'su' &&
        !isOperatorConfigWriteRole(ctx.role) &&
        ctx.isSuperuser !== true &&
        callerAuthorization.authorized !== true
      ) {
        throw new Error(
          'release:repair-queue admit requires an operator-config write role, su, or the exact signed release-fixer delegated by this queue',
        );
      }
      const identity = readIdentity(ctx);
      const activePrecheck = queue.admissionPrecheck;
      if (!dryRun && activePrecheck?.status === 'running' && activePrecheck.expiresAtMs > Date.now()) {
        return json({
          ...base,
          ok: true,
          admitted: false,
          pending: true,
          dryRun: false,
          verdict: 'precheck-running',
          judgedSha: queue.repairHead,
          precheckOperation: activePrecheck,
          currentQueueIdentity: {
            candidate: queue.candidate,
            repairHead: queue.repairHead,
            updatedAtMs: queue.updatedAtMs,
          },
          note: 'This queue already has one live R6 admission pre-check. It is the only admitted decision in flight and NOTHING publishes in the background. Re-read op:get after it settles; do not start a second pre-check.',
        });
      }
      // P-020 (D-008 layers 2–3): HUNK-EXACT by default. The source the primitive admits from
      // is a synthesised commit = repairHead + ONLY the caller's ledgered hunks per path, so a
      // peer's concurrent work in the same file never rides in. `wholeBlob:true` (with a
      // reason) is the explicit, ledgered widening; `includeHunksFrom` replays named peers.
      const wholeBlob = args.wholeBlob === true;
      const includeHunksFrom = (args.includeHunksFrom ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
      const mode = args.patchCommit !== undefined ? 'committed-patch' : wholeBlob ? 'whole-blob' : 'hunk-exact';
      if (
        args.patchCommit !== undefined &&
        (wholeBlob ||
          args.sourceCommit !== undefined ||
          args.includeHunksFrom !== undefined ||
          !args.reason ||
          args.reason.trim().length < 8)
      ) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          mode,
          reason: 'invalid-patch-source',
          detail: 'patchCommit requires a review reason and cannot combine with wholeBlob or includeHunksFrom',
        });
      }
      if (args.sourceCommit !== undefined && !wholeBlob) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          mode,
          reason: 'invalid-source-commit',
          detail: 'sourceCommit is only valid with wholeBlob:true',
        });
      }
      let ledgerRows: FrozenRepairEditLedgerRow[] = [];
      let ledgerReadError: string | null = null;
      try {
        ledgerRows = await readFrozenRepairEditLedger(getOrgPg().sql, {
          workspaceId: inspected.target.workspaceId,
          installSlug: inspected.target.installSlug,
          candidate: queue.candidate,
          paths,
        });
      } catch (err) {
        ledgerReadError = (err as Error).message;
      }
      let sourceRef = branch;
      let hunkExact: HunkExactSuccess | null = null;
      let patch: FrozenRepairAdmission['patch'];
      let foreign: ReturnType<typeof summarizeForeignHunks> = { count: 0, agents: [], byPath: {} };
      if (args.patchCommit !== undefined) {
        const built = buildCommittedPatchSource({
          root,
          repairHead: queue.repairHead,
          patchCommit: args.patchCommit,
          integrationRef: branch,
          paths,
          reason: args.reason!,
        });
        if (!built.ok) {
          return json({
            ...base,
            ok: false,
            admitted: false,
            refused: true,
            dryRun,
            verdict: 'refused',
            mode,
            reason: built.code,
            detail: built.detail,
            judgedSha: queue.repairHead,
          });
        }
        patch = built.patch;
        sourceRef = built.sourceCommit;
      } else if (wholeBlob) {
        if (!args.reason || args.reason.trim().length < 8) {
          return json({
            ok: false,
            admitted: false,
            refused: true,
            dryRun,
            verdict: 'refused',
            reason: 'reason_required',
            detail:
              "wholeBlob:true admits staging's whole blob of each path, which may carry other agents' concurrent work (D-008) — say why that is safe in `reason` (≥ 8 chars). Prefer the default hunk-exact admission, or includeHunksFrom:[<agent>] for a shared fix.",
            judgedSha: queue.repairHead,
            containment: containmentAt(queue.repairHead),
            mode,
            ...base,
          });
        }
        if (args.sourceCommit !== undefined) {
          const resolved = realAdmissionGit(['rev-parse', '--verify', `${args.sourceCommit}^{commit}`], { cwd: root });
          const resolvedSha = resolved.stdout.trim();
          if (resolved.status !== 0 || !FULL_COMMIT_SHA.test(resolvedSha)) {
            return json({
              ok: false,
              admitted: false,
              refused: true,
              dryRun,
              verdict: 'refused',
              reason: 'source-commit-unresolvable',
              detail: `sourceCommit ${args.sourceCommit} does not resolve to a commit in the integration repository`,
              judgedSha: queue.repairHead,
              mode,
              ...base,
            });
          }
          const ancestor = realAdmissionGit(['merge-base', '--is-ancestor', resolvedSha, branch], { cwd: root });
          if (ancestor.status !== 0) {
            return json({
              ok: false,
              admitted: false,
              refused: true,
              dryRun,
              verdict: 'refused',
              reason: ancestor.status === 1 ? 'source-commit-not-integrated' : 'source-commit-ancestry-unavailable',
              detail:
                ancestor.status === 1
                  ? `sourceCommit ${resolvedSha} is not an ancestor of the integration branch ${branch}`
                  : `could not prove sourceCommit ancestry: ${(ancestor.stderr || ancestor.stdout).trim().slice(0, 400)}`,
              judgedSha: queue.repairHead,
              mode,
              ...base,
            });
          }
          sourceRef = resolvedSha;
        }
        foreign = summarizeForeignHunks(ledgerRows, paths, identity.ownerId, includeHunksFrom);
      } else {
        if (ledgerReadError !== null) {
          return json({
            ok: false,
            admitted: false,
            refused: true,
            dryRun,
            verdict: 'refused',
            reason: 'ledger-unavailable',
            detail: `the edit ledger could not be read (${ledgerReadError}) — hunk-exact admission cannot tell your hunks from a peer's. Retry, or admit explicitly with wholeBlob:true and a reason.`,
            judgedSha: queue.repairHead,
            containment: containmentAt(queue.repairHead),
            mode,
            ...base,
          });
        }
        const built = buildHunkExactSource({
          root,
          candidate: queue.candidate,
          repairHead: queue.repairHead,
          paths,
          ledger: ledgerRows,
          actor: identity.ownerId,
          includeHunksFrom,
          nowMs: Date.now(),
        });
        if (!built.ok) {
          return json({
            ok: false,
            admitted: false,
            refused: true,
            dryRun,
            verdict: 'refused',
            reason: built.code,
            detail: built.detail,
            ...(built.path ? { path: built.path } : {}),
            ...(built.foreignAgents ? { foreignAgents: built.foreignAgents } : {}),
            ...(built.hunkIndex !== undefined ? { hunkIndex: built.hunkIndex } : {}),
            ...(built.step ? { step: built.step } : {}),
            exits: built.exits,
            judgedSha: queue.repairHead,
            containment: containmentAt(queue.repairHead),
            mode,
            ...base,
          });
        }
        hunkExact = built;
        sourceRef = built.sourceCommit;
      }
      // P-006 (R6, D-002): the ADMISSION PRE-CHECK. A confirmed admit is two-phase: phase 1
      // builds + PROVES the admission commit unpublished (dryRun:true — a real object in the
      // root's store), the frozen signature's test-file entries plus any admitted test files
      // are measured AT that commit in the checkpoint tree, and only a non-red result reaches
      // phase 2 (the publishing build of the same tree onto the same parent; the lineage-ref
      // CAS still guards races). A gate run holding the checkpoint tree makes the pre-check
      // accepts ONLY the explicit checkpoint-tree-busy exception
      // (`precheck.ran:false, reason:'checkpoint-tree-busy'`) — the R-1 re-judge measures it.
      // Any other runner/setup failure refuses publication because an unmeasured result never
      // counts as passing. `skipPrecheck:true` + `precheckReason` is the deliberate ledgered opt-out.
      const population = precheckPopulation({ signature: queue.signature ?? [], admittedPaths: paths });
      const skipPrecheck = args.skipPrecheck === true;
      const precheckReason = typeof args.precheckReason === 'string' ? args.precheckReason.trim() : '';
      if (skipPrecheck && precheckReason.length < 8) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          reason: 'precheck-reason-required',
          detail:
            'skipPrecheck:true opts a confirmed admission OUT of the R6 pre-check (the built commit is not measured before publication) — say why that is safe in `precheckReason` (≥ 8 chars); it is recorded on the ledger entry.',
          judgedSha: queue.repairHead,
          containment: containmentAt(queue.repairHead),
          mode,
        });
      }
      const precheckApplies = !dryRun && !skipPrecheck && population.files.length > 0;
      const buildAdmission = (dry: boolean) =>
        admitPathsOntoRepairHead({
          root,
          candidate: queue.candidate,
          repairHead: queue.repairHead,
          paths,
          source: {
            ref: sourceRef,
            ...(wholeBlob && args.sourceCommit !== undefined ? { recordAsRef: branch } : {}),
          },
          actor: identity.ownerId,
          reason: args.reason,
          nowMs: Date.now(),
          dryRun: dry,
          // P-004: the proved commit must resolve every relative import of every admitted TS/JS
          // file, or the door refuses `admission-incomplete` naming the sibling to admit. The
          // The pinned whole-blob source is consulted when supplied; other modes preserve the
          // integration branch as the suggestion source. Nothing is admitted on the caller's behalf.
          // WI-10004232: and a lockfile workspace entry it moves must still agree with its manifest,
          // or npm install rewrites the lock and the promoted pin can never certify.
          preflight: chainAdmissionPreflights(
            importCompletenessPreflight({
              root,
              probeRef: wholeBlob && args.sourceCommit !== undefined ? sourceRef : branch,
              ...(wholeBlob ? { enforceSourceCohort: true } : {}),
            }),
            lockfileManifestConsistencyPreflight({
              root,
              probeRef: wholeBlob && args.sourceCommit !== undefined ? sourceRef : branch,
            }),
          ),
        });
      // Build the immutable candidate first. Publication is the effect boundary,
      // and must happen only while the condition claim row is locked below.
      let outcome = buildAdmission(true);
      // WI-10004151 part 2: an admitted lockfile/patch moves repairHead onto dependency inputs
      // the gate must materialise (`--ensure-ref`) before it can judge anything. Ask the SAME
      // script now whether that would succeed, so a lock no installed tree can produce is
      // refused here instead of parking verification an hour later. `unknown` never refuses.
      const dependencyPaths = paths.filter(isDependencyInputPath);
      const dependencyGeneration: DependencyGenerationPrediction | null =
        outcome.ok && dependencyPaths.length > 0
          ? await predictDependencyGeneration({
              integrationRoot: resolveCanonicalIntegrationRoot(root),
              ref: outcome.commit,
              paths: dependencyPaths,
            })
          : null;
      const dependencyNote = dependencyGeneration ? describeDependencyPrediction(dependencyGeneration) : null;
      if (outcome.ok && dependencyGeneration?.verdict === 'refused' && !dryRun && !skipPrecheck) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun: false,
          verdict: 'refused',
          reason: 'dependency-generation-unbuildable',
          detail: (dependencyNote ?? '').trim(),
          dependencyGeneration,
          builtCommit: outcome.commit,
          judgedSha: queue.repairHead,
          containment: containmentAt(queue.repairHead),
          mode,
          note:
            'Nothing was published. The gate could never materialise these dependency inputs, so verification would park. ' +
            'Install the lock in the integration tree first (npm run install:safe) so a matching generation can be built, ' +
            'admit a lock that matches what is installed, or deliberately override with skipPrecheck:true + precheckReason.',
        });
      }
      let precheck: FixPrecheckVerdict | null = null;
      if (precheckApplies && outcome.ok) {
        const builtCommit = outcome.commit;
        // The serving host's root may be a LINKED worktree (`:3170` runs from papercusp-staging);
        // the checkpoint tree, its run-lock and setup-release-checkout all key off the MAIN one.
        const precheckRoot = resolveCanonicalIntegrationRoot(root);
        const matchingPrecheck = sameAdmissionPrecheck(queue.admissionPrecheck, {
          root,
          candidate: queue.candidate,
          repairHead: queue.repairHead,
          builtCommit,
          builtTree: outcome.tree,
          files: population.files,
          actor: identity.ownerId,
        })
          ? queue.admissionPrecheck
          : undefined;
        if (matchingPrecheck?.status === 'running' && matchingPrecheck.expiresAtMs > Date.now()) {
          const retrySourceCommit = matchingPrecheck.sourceCommit ?? outcome.entry.source.sha;
          return json({
            ...base,
            ok: true,
            admitted: false,
            pending: true,
            dryRun: false,
            verdict: 'precheck-running',
            judgedSha: queue.repairHead,
            precheckOperation: matchingPrecheck,
            currentQueueIdentity: {
              candidate: queue.candidate,
              repairHead: queue.repairHead,
              updatedAtMs: queue.updatedAtMs,
            },
            note:
              'R6 pre-check is still running and NOTHING publishes in the background. Re-read op:get; after status=passed or status=deferred (checkpoint-tree-busy), repeat this confirmed admit with the refreshed exact queue identity' +
              (wholeBlob ? ` and wholeBlob:true, sourceCommit:'${retrySourceCommit}'` : '') +
              '.',
          });
        }
        if (
          (matchingPrecheck?.status === 'passed' && matchingPrecheck.verdict?.ok === true && matchingPrecheck.verdict.ran) ||
          (matchingPrecheck?.status === 'deferred' && matchingPrecheck.verdict?.ok === true &&
            !matchingPrecheck.verdict.ran && matchingPrecheck.verdict.reason === 'checkpoint-tree-busy')
        ) {
          precheck = matchingPrecheck.verdict;
        } else if (
          matchingPrecheck?.status === 'failed' &&
          matchingPrecheck.verdict?.ok === false &&
          args.retryPrecheck !== true
        ) {
          precheck = matchingPrecheck.verdict;
        } else {
          const startedAtMs = Date.now();
          const runnerPidIdentity = checkpointPidIdentity(process.pid);
          const operationId =
            `repair-precheck-${queue.candidate.slice(0, 12)}-${builtCommit.slice(0, 12)}-` +
            `${startedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const operation: FrozenRepairAdmissionPrecheck = {
            schemaVersion: 1,
            operationId,
            status: 'running',
            candidate: queue.candidate,
            repairHead: queue.repairHead,
            builtCommit,
            sourceCommit: outcome.entry.source.sha,
            builtTree: outcome.tree,
            files: [...population.files],
            actor: identity.ownerId,
            runnerPid: process.pid,
            ...(runnerPidIdentity ? { runnerPidIdentity } : {}),
            startedAtMs,
            updatedAtMs: startedAtMs,
            expiresAtMs: admissionPrecheckDeadline(startedAtMs, population.files),
            // Seed the durable marker with the first file before setup begins. The runner's
            // callback refreshes this snapshot before each subsequent test process starts.
            currentFile: population.files[0] as string,
            completedCount: 0,
            totalCount: population.files.length,
            heartbeatAtMs: startedAtMs,
          };
          const pendingQueue: FrozenCandidateRepairQueue = {
            ...queue,
            admissionPrecheck: operation,
            dispatchReservation: {
              token: operationId,
              claimedAtMs: startedAtMs,
              expiresAtMs: operation.expiresAtMs,
            },
            updatedAtMs: Math.max(queue.updatedAtMs + 1, startedAtMs),
          };
          try {
            await writeFrozenCandidateRepairQueue(inspected.target, pendingQueue, {
              expectedUpdatedAtMs: queue.updatedAtMs,
            });
          } catch (err) {
            return json({
              ...base,
              ok: false,
              admitted: false,
              refused: true,
              dryRun: false,
              verdict: 'refused',
              reason: 'precheck-state-conflict',
              detail:
                `The queue changed before the R6 pre-check marker could be persisted (${(err as Error).message}). ` +
                'No pre-check was launched and nothing was published; re-read op:get.',
              judgedSha: queue.repairHead,
            });
          }
          const runner = createCheckpointTreeFixPrecheckRunner({
            integrationRoot: precheckRoot,
            checkpointRoot: checkpointRootMirror(precheckRoot),
          });
          const persistPrecheckProgress = async (progress: FixPrecheckProgress): Promise<void> => {
            await applyFrozenCandidateRepairQueueTransition(inspected.target, (fresh) => {
              const current = fresh.admissionPrecheck;
              if (!current || current.operationId !== operationId || current.status !== 'running') return fresh;
              const updatedAtMs = Math.max(fresh.updatedAtMs + 1, progress.heartbeatAtMs);
              return {
                ...fresh,
                updatedAtMs,
                admissionPrecheck: {
                  ...current,
                  currentFile: progress.currentFile,
                  completedCount: progress.completedCount,
                  totalCount: progress.totalCount,
                  heartbeatAtMs: progress.heartbeatAtMs,
                  updatedAtMs,
                },
              };
            });
          };
          void trackDetached(
            (async () => {
              let run: Awaited<ReturnType<typeof runner>>;
              try {
                run = await runner({
                  commit: builtCommit,
                  files: population.files,
                  onProgress: persistPrecheckProgress,
                });
              } catch (err) {
                run = { ran: false, reason: 'runner-failed', detail: (err as Error).message };
              }
              await settleAdmissionPrecheck(inspected.target, operationId, evaluateFixPrecheck(population, run));
            })(),
          ).catch((err) => {
            console.error(`[release:repair-queue] detached pre-check ${operationId} failed to settle`, err);
          });
          return json({
            ...base,
            ok: true,
            admitted: false,
            pending: true,
            dryRun: false,
            verdict: 'precheck-running',
            judgedSha: queue.repairHead,
            builtCommit,
            precheckOperation: operation,
            currentQueueIdentity: {
              candidate: pendingQueue.candidate,
              repairHead: pendingQueue.repairHead,
              updatedAtMs: pendingQueue.updatedAtMs,
            },
            note:
              'R6 pre-check launched after its durable marker was written. NOTHING publishes in the background. Re-read op:get; after status=passed or status=deferred (checkpoint-tree-busy), repeat this confirmed admit with the refreshed exact queue identity' +
              (wholeBlob ? ` and wholeBlob:true, sourceCommit:'${operation.sourceCommit}'` : '') +
              '.',
          });
        }
        if (!precheck.ok) {
          return json({
            ...base,
            ok: false,
            admitted: false,
            refused: true,
            dryRun: false,
            verdict: 'refused',
            reason: precheck.code,
            detail: precheck.detail,
            precheck: precheckRecordOf(precheck, { skipPrecheck, precheckReason, dryRun, population }),
            precheckResults: precheck.ran ? precheck.results : [],
            builtCommit,
            judgedSha: queue.repairHead,
            containment: containmentAt(queue.repairHead),
            mode,
            note: precheck.ran
              ? 'R6: nothing was published — the admission commit was built and measured but the lineage ref did not move. ' +
                'Fix the red at the built commit (or, for a deliberate wide admission, re-run with skipPrecheck:true + precheckReason).'
              : 'R6: nothing was published — the admission commit was built, but the pre-check runner could not measure it. ' +
                'Repair the runner/setup failure, or deliberately opt out with skipPrecheck:true + precheckReason.',
          });
        }
      }
      if (!dryRun && outcome.ok) {
        // Phase 2: publish. The durable intent predates the ref movement; the
        // linked claim row remains locked until this exact publication settles.
        const admitted = await executeWithGateActionReceipt({
          action: 'release:repair-queue', actor: identity.ownerId,
          ownerId: identity.ownerId, conditionKey: ownership?.eventKey ?? '',
          allowUnowned: true,
          delegate: { authorized: callerAuthorization.status === 'authorized-delegate',
            callerSpawnId: callerAuthorization.callerSpawnId,
            queueFixerSpawnId: callerAuthorization.queueFixerSpawnId },
          target: { op: 'admit', candidate: queue.candidate, repairHead: queue.repairHead,
            builtCommit: outcome.commit },
          run: async () => buildAdmission(false),
          summarize: (effect) => ({ status: effect.ok ? 'lineage-ref-published' : 'not-published',
            ...(effect.ok ? { commit: effect.commit } : { reason: effect.code }) }),
        });
        if (!admitted.ok) {
          stampActionEffect({ status: admitted.effectMayHaveRun ? 'unknown' : 'refused',
            reason: admitted.reason, receiptId: admitted.receiptId });
          return json({ ok: false, admitted: false, refused: !admitted.effectMayHaveRun,
            verdict: 'refused', reason: admitted.reason, receiptId: admitted.receiptId,
            effectMayHaveRun: admitted.effectMayHaveRun, ...base });
        }
        effectReceipt = { receiptId: admitted.receiptId, ownership: admitted.ownership };
        outcome = admitted.effect;
      }
      const precheckEntry = precheckRecordOf(precheck, { skipPrecheck, precheckReason, dryRun, population });
      const hunksRecord: Record<string, { applied: number; agents: string[] }> | null = hunkExact
        ? Object.fromEntries(hunkExact.perPath.map((p) => [p.path, { applied: p.applied, agents: p.agents }]))
        : null;
      const provenance = patch
        ? { mode, patch, source: { ref: sourceRef, root } }
        : hunkExact
          ? {
              mode,
              hunks: hunksRecord,
              hunkExact: hunkExact.perPath.map((p) => ({
                path: p.path,
                applied: p.applied,
                agents: p.agents,
                foreignHunksExcluded: p.foreignHunks,
                foreignAgents: p.foreignAgents,
                unchanged: p.unchanged,
              })),
            }
          : {
              mode,
              source: { ref: sourceRef, root },
              foreignHunksAccepted: foreign.count,
              foreignAgents: foreign.agents,
              foreignHunksByPath: foreign.byPath,
            };
      if (!outcome.ok) {
        if (outcome.code === 'nothing-to-admit') {
          return json({
            ok: true,
            admitted: false,
            dryRun,
            verdict: 'already-admitted',
            detail: outcome.detail,
            judgedSha: queue.repairHead,
            containment: containmentAt(queue.repairHead),
            ...base,
          });
        }
        return json({
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          reason: outcome.code,
          detail: outcome.detail,
          ...(outcome.stray ? { stray: outcome.stray } : {}),
          ...(outcome.paths ? { invalidPaths: outcome.paths } : {}),
          ...(outcome.step ? { step: outcome.step } : {}),
          ...(outcome.missing
            ? {
                missing: outcome.missing,
                // The same admission, widened by exactly the missing paths — and nothing else.
                admitCommand: renderAdmitCommand([...new Set([...paths, ...outcome.missing.map((m) => m.wanted)])]),
                note:
                  'P-004: an admitted file imports a path that does not exist at the proved commit. The tip is never ' +
                  'widened for you — re-run admitCommand (your hunks for the added paths must be in the edit ledger, ' +
                  'i.e. you authored them on staging).',
              }
            : {}),
          judgedSha: queue.repairHead,
          containment: containmentAt(queue.repairHead),
          ...base,
        });
      }
      // The ledger entry carries HOW the source was built (D-008): hunk-exact with the replayed
      // hunks per path, or whole-blob with the foreign hunks it accepted and why.
      const entry: FrozenRepairAdmission = {
        ...outcome.entry,
        mode,
        precheck: precheckEntry,
        ...(patch
          ? { patch }
          : hunksRecord
            ? { hunks: hunksRecord }
            : { foreignHunksAccepted: foreign.count, foreignAgents: foreign.agents }),
      };
      const proof = {
        diff: outcome.diff,
        unchanged: outcome.unchanged,
        blobs: outcome.entry.blobs,
        tree: outcome.tree,
      };
      if (dryRun) {
        return json({
          ok: true,
          admitted: false,
          dryRun: true,
          verdict: 'would-admit',
          judgedSha: queue.repairHead,
          wouldMoveRepairHead: { from: queue.repairHead, to: outcome.commit },
          lineageRef: outcome.lineageRef,
          proof,
          precheck: precheckEntry,
          ...(dependencyGeneration ? { dependencyGeneration } : {}),
          containment: containmentAt(queue.repairHead),
          note:
            `Pass confirm:true to publish admission ${outcome.commit.slice(0, 12)} onto ${outcome.lineageRef} ` +
            'and advance repairHead to it (phase ready-to-verify). The immutable candidate is never touched; ' +
            'the commit carries exactly proof.diff and nothing else from the tip.' +
            (dependencyGeneration?.verdict === 'refused'
              ? ` ⚠ A confirmed admit will be REFUSED (dependency-generation-unbuildable):${dependencyNote ?? ''}`
              : (dependencyNote ?? '')),
          ...base,
          ...provenance,
        });
      }
      // Published: the lineage ref now points at the admission. The queue row is the second
      // store; if it cannot be written, retract the ref so the two never disagree.
      let next: FrozenCandidateRepairQueue;
      try {
        next = markFrozenRepairAdmitted(queue, entry);
      } catch (err) {
        const retracted = retractAdmission({
          root,
          candidate: queue.candidate,
          published: outcome.commit,
          previousRepairHead: queue.repairHead,
        });
        return json({
          ok: false,
          admitted: false,
          refused: true,
          verdict: 'refused',
          reason: 'lineage-ref-moved',
          detail: `${(err as Error).message}${retracted ? ' (lineage ref retracted)' : ' (lineage ref could NOT be retracted — it is at the unrecorded admission; re-read the queue)'}`,
          judgedSha: queue.repairHead,
          containment: containmentAt(queue.repairHead),
          ...base,
        });
      }
      let persisted = true;
      try {
        if (expectedQueueIdentity) {
          await writeFrozenCandidateRepairQueue(inspected.target, next, {
            expectedUpdatedAtMs: expectedQueueIdentity.expectedUpdatedAtMs,
          });
        } else {
          await writeFrozenCandidateRepairQueue(inspected.target, next, {
            expectedUpdatedAtMs: queue.updatedAtMs,
          });
        }
      } catch {
        persisted = false;
      }
      let retracted: boolean | null = null;
      if (!persisted) {
        retracted = retractAdmission({
          root,
          candidate: queue.candidate,
          published: outcome.commit,
          previousRepairHead: queue.repairHead,
        });
      }
      const auditRecorded = await recordAudit(identity.ownerId, {
        op: 'admit',
        reason: args.reason ?? null,
        workItem: args.workItem ?? null,
        candidate: queue.candidate,
        from: queue.repairHead,
        to: outcome.commit,
        source: outcome.entry.source,
        paths: outcome.entry.paths,
        unchanged: outcome.entry.unchanged,
        mode,
        ...(patch
          ? { patch }
          : hunksRecord
            ? { hunks: hunksRecord }
            : { foreignHunksAccepted: foreign.count, foreignAgents: foreign.agents }),
        precheck: precheckEntry,
        ...(dependencyGeneration ? { dependencyGeneration } : {}),
        persisted,
        ...(retracted === null ? {} : { retracted }),
      });
      const judgedSha = persisted ? outcome.commit : queue.repairHead;
      stampActionEffect({ status: persisted ? 'repair-head-published' : 'publish-failed',
        persisted, retracted, from: queue.repairHead, to: outcome.commit, auditRecorded });
      return json({
        ok: persisted,
        admitted: persisted,
        dryRun: false,
        verdict: persisted ? 'admitted' : 'refused',
        judgedSha,
        movedRepairHead: { from: queue.repairHead, to: outcome.commit },
        lineageRef: outcome.lineageRef,
        proof,
        admission: entry,
        ...provenance,
        precheck: precheckEntry,
        ...(dependencyGeneration ? { dependencyGeneration } : {}),
        containment: containmentAt(judgedSha),
        persisted,
        auditRecorded,
        ...base,
        ...(patch ? { source: { ref: sourceRef, root } } : {}),
        repairQueue: persisted
          ? diagnoseFrozenCandidateRepairQueue(next, { nowMs: Date.now(), fixerAlive: inspected.fixerAlive })
          : inspected.diagnostic,
        ...(persisted
          ? {
              nextAction:
                `repairHead is ${outcome.commit.slice(0, 12)} (phase ${next.phase}); the gate re-verifies at that head on its next tick. ` +
                'Do NOT fire release:checkpoint-run and do NOT retire.' +
                (precheckEntry.ran
                  ? ` R6 pre-check ran at the built commit: ${precheckEntry.fixes?.length ?? 0} signature red(s) fixed, ${precheckEntry.failing?.length ?? 0} still failing, ${precheckEntry.unmeasured?.length ?? 0} unmeasured.`
                  : precheckEntry.reason === 'checkpoint-tree-busy'
                    ? ' ⚠ R6 pre-check did NOT run (a gate run holds the checkpoint tree) — accepted loud; the re-judge measures it.'
                    : precheckEntry.reason === 'skipped'
                      ? ' ⚠ R6 pre-check SKIPPED by the caller (skipPrecheck); the re-judge measures it.'
                      : '') +
                (dependencyGeneration?.verdict === 'refused'
                  ? ` ⚠ Admitted PAST an unbuildable-dependency prediction (skipPrecheck):${dependencyNote ?? ''} Verification will park until a matching generation exists.`
                  : (dependencyNote ?? '')),
            }
          : {
              refused: true,
              reason: 'persist_failed',
              note: retracted
                ? 'The queue row could not be written, so the lineage ref was retracted to the previous repairHead; nothing moved. Re-run.'
                : 'The queue row could not be written AND the lineage ref could not be retracted: the ref is at the admission but the row is not. Re-read the queue before relying on the judged sha.',
            }),
      });
    }
    if (args.op === 'claim-leg') {
      // P-021 (D-007 #1): claiming a leg claims its paths. The manifest row is the unit a
      // fixer takes; the claim is carried on the queue row (the ONE write path re-derives
      // the manifest with `previous` so a claim survives every rebuild), and the caller's
      // presence `current_files` is set to the leg's subject paths so lock contention and
      // fleet placement see the lane without a separate declare-intent.
      const queue = inspected.queue;
      const legId = args.leg.trim();
      const release = args.release === true;
      const base = {
        op: 'claim-leg' as const,
        leg: legId,
        release,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
        repairQueueRead: compactRead,
        callerAuthorization,
      };
      if (!queue) {
        return json({
          ok: true,
          claimed: false,
          verdict: 'no-frozen-queue',
          nextAction:
            'No frozen repair queue, so there is no manifest and nothing to claim. Fix on staging as normal; ' +
            'git-sync commits it and the next candidate is cut from that tip. Do not fire release:checkpoint-run.',
          ...base,
        });
      }
      if (
        ctx.role !== 'su' &&
        !isOperatorConfigWriteRole(ctx.role) &&
        ctx.isSuperuser !== true &&
        callerAuthorization.authorized !== true
      ) {
        throw new Error(
          'release:repair-queue claim-leg requires an operator-config write role, su, or the exact signed release-fixer delegated by this queue',
        );
      }
      if (!queue.manifest) {
        return json({
          ok: false,
          claimed: false,
          refused: true,
          verdict: 'refused',
          reason: 'no-manifest',
          detail:
            'The frozen queue carries no repair manifest yet: the gate derives it on its next queue write ' +
            '(a freeze, an admission, a re-verify). Re-read with op:get after the next green-checkpoint tick.',
          ...base,
        });
      }
      const identity = readIdentity(ctx);
      const outcome = claimRepairManifestLeg(queue.manifest, {
        legId,
        actor: identity.ownerId,
        atMs: Date.now(),
        release,
      });
      if (!outcome.ok) {
        return json({
          ok: false,
          claimed: false,
          refused: true,
          verdict: 'refused',
          reason: outcome.reason,
          ...(outcome.reason === 'no-such-leg'
            ? {
                legIds: outcome.legIds,
                detail: `No manifest leg ${JSON.stringify(legId)}; the manifest names ${outcome.legIds.length} leg(s) — copy a legId from repairQueue.manifest.rows[].`,
              }
            : outcome.reason === 'held-by-other'
              ? {
                  row: outcome.row,
                  holder: outcome.holder,
                  detail: `Leg ${legId} is held by ${outcome.holder.actor} — coordinate with the holder (coord:send), never contest a live claim.`,
                }
              : {
                  row: outcome.row,
                  detail: `Leg ${legId} is already ${outcome.row.statusLabel}; there is nothing left to claim on it.`,
                }),
          ...base,
        });
      }
      const next: FrozenCandidateRepairQueue = { ...queue, manifest: outcome.manifest };
      const claimed = await executeWithGateActionReceipt({
        action: 'release:repair-queue', actor: identity.ownerId, ownerId: identity.ownerId,
        conditionKey: ownership?.eventKey ?? '', allowUnowned: true,
        delegate: { authorized: callerAuthorization.status === 'authorized-delegate',
          callerSpawnId: callerAuthorization.callerSpawnId,
          queueFixerSpawnId: callerAuthorization.queueFixerSpawnId },
        target: { op: 'claim-leg', candidate: queue.candidate, repairHead: queue.repairHead,
          leg: legId, release },
        run: async () => {
          try {
            await writeFrozenCandidateRepairQueue(inspected.target, next, {
              expectedUpdatedAtMs: queue.updatedAtMs,
            });
            return { persisted: true };
          } catch {
            return { persisted: false };
          }
        },
        summarize: (effect) => ({ status: effect.persisted
          ? (release ? 'leg-released' : 'leg-claimed') : 'persist-failed', persisted: effect.persisted }),
      });
      if (!claimed.ok) {
        stampActionEffect({ status: claimed.effectMayHaveRun ? 'unknown' : 'refused',
          reason: claimed.reason, receiptId: claimed.receiptId });
        return json({ ...base, ok: false, claimed: false, refused: !claimed.effectMayHaveRun,
          reason: claimed.reason, receiptId: claimed.receiptId,
          effectMayHaveRun: claimed.effectMayHaveRun });
      }
      effectReceipt = { receiptId: claimed.receiptId, ownership: claimed.ownership };
      const persisted = claimed.effect.persisted;
      // Claiming a leg claims its paths: publish them as the caller's current files. Best-effort —
      // the claim itself is on the queue row; presence is the peer-visible mirror of it.
      let presenceFiles: string[] | null = null;
      if (persisted && !outcome.released && outcome.paths.length > 0) {
        try {
          const [{ resolveAgentIdentity }, { writePresence }] = await Promise.all([
            import('../coordination/identity'),
            import('../coordination/presence'),
          ]);
          await writePresence(resolveAgentIdentity(ctx), { currentFiles: outcome.paths });
          presenceFiles = outcome.paths;
        } catch {
          presenceFiles = null;
        }
      }
      const auditRecorded = await recordAudit(identity.ownerId, {
        op: 'claim-leg',
        leg: legId,
        release,
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        paths: outcome.paths,
        persisted,
      });
      const released = release && persisted;
      stampActionEffect({ status: persisted ? (release ? 'leg-released' : 'leg-claimed') : 'persist-failed',
        persisted, leg: legId, auditRecorded });
      return json({
        ok: persisted,
        claimed: persisted && !release,
        released,
        verdict: persisted ? (release ? 'released' : 'claimed') : 'refused',
        row: outcome.row,
        paths: outcome.paths,
        admitCommand: outcome.row.admitCommand,
        presenceFiles,
        persisted,
        auditRecorded,
        ...base,
        repairQueue: persisted
          ? diagnoseFrozenCandidateRepairQueue(next, { nowMs: Date.now(), fixerAlive: inspected.fixerAlive })
          : inspected.diagnostic,
        ...(persisted
          ? {
              nextAction: release
                ? `Leg ${legId} released; its ${outcome.paths.length} subject path(s) are unclaimed again.`
                : outcome.row.admitCommand
                  ? `You hold leg ${legId} (${outcome.row.statusLabel}). Fix its subject paths on staging, wait for git-sync to commit, then land it with: ${outcome.row.admitCommand}. Do NOT fire release:checkpoint-run.`
                  : `You hold leg ${legId} (${outcome.row.statusLabel}) but its subject paths are unknown — name the files you fix by hand in release:repair-queue { op:'admit', paths:[…] }. Do NOT fire release:checkpoint-run.`,
            }
          : {
              refused: true,
              reason: 'persist_failed',
              note: 'The queue row could not be written; the claim is not recorded. Re-read the queue and retry.',
            }),
      });
    }
    if (ctx.role !== 'su' && !isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('release:repair-queue retire requires an operator-config write role or su authority');
    }
    if (!inspected.queue || !inspected.diagnostic) {
      return json({ ok: true, op: 'retire', retired: false, alreadyClear: true, target: inspected.target });
    }
    const identityMatches =
      inspected.queue.candidate === args.expectedCandidate &&
      inspected.queue.repairHead === args.expectedRepairHead &&
      inspected.queue.updatedAtMs === args.expectedUpdatedAtMs;
    if (!identityMatches) {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: 'exact_queue_identity_mismatch',
        target: inspected.target,
        repairQueue: inspected.diagnostic,
      });
    }
    // A broad liveness read can fail-soft to `null` while the exact terminal pair is still
    // durable. Let the transaction-scoped retire helper recheck that case; keep the other safety
    // refusals (live fixer, active reservation, unsafe phase) fail-closed at the read boundary.
    if (!inspected.diagnostic.retireAllowed && inspected.diagnostic.retireRefusal !== 'liveness-unknown') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: inspected.diagnostic.retireRefusal,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
      });
    }
    if (args.confirm !== true) {
      return json({
        ok: true,
        op: 'retire',
        dryRun: true,
        retired: false,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
        note: 'Pass confirm:true with the same exact identity to execute the compare-and-swap retirement.',
      });
    }

    const identity = readIdentity(ctx);
    const retired = await executeWithGateActionReceipt({
      action: 'release:repair-queue', actor: identity.ownerId, ownerId: identity.ownerId,
      conditionKey: ownership?.eventKey ?? '', allowUnowned: true,
      target: { op: 'retire', candidate: inspected.queue.candidate,
        repairHead: inspected.queue.repairHead, updatedAtMs: inspected.queue.updatedAtMs },
      run: () => retireFrozenCandidateRepairQueue(inspected.target, inspected.queue!),
      summarize: (effect) => ({ status: effect.retired ? 'queue-retired' : 'not-retired',
        refusal: effect.refusal ?? null }),
    });
    if (!retired.ok) {
      stampActionEffect({ status: retired.effectMayHaveRun ? 'unknown' : 'refused',
        reason: retired.reason, receiptId: retired.receiptId });
      return json({ ok: false, op: 'retire', retired: false,
        refused: !retired.effectMayHaveRun, reason: retired.reason,
        receiptId: retired.receiptId, effectMayHaveRun: retired.effectMayHaveRun });
    }
    effectReceipt = { receiptId: retired.receiptId, ownership: retired.ownership };
    const result = retired.effect;
    const currentFixerAlive =
      result.fixerAlive !== undefined ? result.fixerAlive : await inspectFixerLiveness(result.current);
    const currentDiagnostic = result.current
      ? diagnoseFrozenCandidateRepairQueue(result.current, {
          nowMs: Date.now(),
          fixerAlive: currentFixerAlive,
        })
      : null;
    // The transaction may refuse after taking the routine-row lock because its authoritative
    // liveness/identity differs from the preflight read. This is a safety refusal, not a storage
    // CAS miss, and must remain visible as such so callers do not retry a live/unknown fixer.
    if (!result.retired && result.refusal && result.refusal !== 'identity-mismatch') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: result.refusal,
        target: inspected.target,
        repairQueue: currentDiagnostic,
      });
    }
    if (!result.retired && result.refusal === 'identity-mismatch') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: 'exact_queue_identity_mismatch',
        target: inspected.target,
        repairQueue: currentDiagnostic,
      });
    }
    const casMiss = !result.retired;
    const auditRecorded = await recordAudit(identity.ownerId, {
      reason: args.reason,
      expectedCandidate: args.expectedCandidate,
      expectedRepairHead: args.expectedRepairHead,
      expectedUpdatedAtMs: args.expectedUpdatedAtMs,
      retired: result.retired,
      casMiss,
    });
    stampActionEffect({ status: result.retired ? 'queue-retired' : 'cas-miss',
      retired: result.retired, casMiss, auditRecorded });
    // A CAS miss is a storage outcome, not a liveness refusal. The nested `current`
    // diagnostic describes the row after the failed write; it must not become the
    // operation's headline reason.
    return json({
      ok: result.retired,
      op: 'retire',
      retired: result.retired,
      casMiss,
      reason: casMiss ? 'cas-miss' : undefined,
      target: inspected.target,
      auditRecorded,
      current: currentDiagnostic,
      // WI-1105109 [owner 2026-08-30, OWNER-interactive]: "make sure another agent
      // uses the frozen candidate system next and doesn't retire it like you did".
      //
      // A SUCCESSFUL retire is the exact moment the treadmill restarts. The recorded
      // failure was not the retire — that one was correct — it was firing
      // release:checkpoint-run TWICE immediately afterwards, each cutting a FRESH
      // candidate at tip. `notWhen` already forbids retiring "merely to make the gate
      // move", but guidance is read BEFORE the call and the mistake happens AFTER it,
      // so the answer has to travel on the RESULT the caller is holding when they
      // choose their next move.
      nextStep: result.retired
        ? 'The next scheduled green-checkpoint run RE-FREEZES a candidate on its own — retiring does not stall the gate, so nothing needs firing to restart it. Do NOT call release:checkpoint-run to make the gate move: it always cuts a FRESH candidate at the current tip, which is the pre-D-001 re-cut-at-tip treadmill D-007 diagnosed (each cut re-admits the whole sweep and imports breakage faster than fixes land). To land a fix on the judged lineage, use release:repair-queue { op: "admit", paths: [...] }.'
        : undefined,
    });
  },
});
