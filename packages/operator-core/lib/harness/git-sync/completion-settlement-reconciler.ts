import { getOrgPg } from '@papercusp/db-org';
import {
  CompletionSettlementManifestSchema,
  TERMINAL_COMPLETION_EVIDENCE_KEY,
  type CompletionSettlementManifest,
  type CompletionTreeStamp,
} from '../../coord-lifecycle/records';
import {
  completionBlobHistoryContains,
  completionHeadBlobMap,
  type HeadBlobResolution,
} from '../../agent-tools/work_items/completion-freshness';
import { emitAwaitedEvent } from '../../events/await/engine';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_CANDIDATES = 200;
const SETTLEMENT_CONCURRENCY = 8;

export type SettlementResidualReason = 'identity-unavailable' | 'missing-from-commit' | 'content-mismatch';
export type SettlementResidualPath = { path: string; reason: SettlementResidualReason };
type CompletionHeadBlobLookup = (
  repoRoot: string,
  headSha: string,
  paths: readonly string[],
  opts?: { signal?: AbortSignal },
) => ReadonlyMap<string, HeadBlobResolution> | undefined | Promise<ReadonlyMap<string, HeadBlobResolution> | undefined>;
type CompletionBlobHistoryLookup = typeof completionBlobHistoryContains;
type SettlementHistoryPathAttestation = {
  path: string;
  workingTreeBlobSha: string;
  fromHeadSha: string;
  toCommitSha: string;
  proof: 'exact-path-blob-history';
};
type SettlementHistoryAttestation = {
  version: 1;
  generation: number;
  evidenceHash: string;
  repositoryRoot: string;
  closeHeadSha: string;
  emittedCommitSha: string;
  paths: SettlementHistoryPathAttestation[];
};

/** EI-22344624691081449: manifest entries may describe an intentional deletion. */
type SettlementIdentity = CompletionSettlementManifest['contentIdentity'][number] & {
  deletion?: true;
};

/**
 * WI-1409142: restore the two blob-sha keys the terminal payload write used to drop.
 *
 * `jsonb_strip_nulls` is RECURSIVE. Applied to completion evidence it deleted
 * `contentIdentity[].headBlobSha` / `.workingTreeBlobSha` whenever the value was a
 * meaningful `null` — a declared path not yet in HEAD, which is simply what a close
 * looks like before git-sync sweeps. `CompletionSettlementManifestSchema` requires
 * those keys, so the stored manifest failed `safeParse`, `residualPathsForCommit`
 * returned undefined, and the reconciler skipped the row: 110 closes could never
 * settle, and showed up in neither the settled nor the unsettled count.
 *
 * Both write sites now exempt the evidence subtree, so new rows keep their nulls.
 * This exists for the rows ALREADY on disk — it lets them settle on the next pass
 * instead of needing a backfill. An absent key and an explicit null mean the same
 * thing here ("this side was not resolved"), so filling one in loses nothing.
 *
 * Defaults are spread FIRST so a key that IS present — including an explicit null —
 * always wins; only a genuinely missing key is filled.
 */
export function normalizeStoredSettlementManifest(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const manifest = raw as { contentIdentity?: unknown };
  if (!Array.isArray(manifest.contentIdentity)) return raw;
  return {
    ...manifest,
    contentIdentity: manifest.contentIdentity.map((entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { workingTreeBlobSha: null, headBlobSha: null, ...(entry as Record<string, unknown>) }
        : entry,
    ),
  };
}

export async function residualPathsForCommit(
  manifest: unknown,
  commitSha: string,
  lookup: CompletionHeadBlobLookup = completionHeadBlobMap,
  signal?: AbortSignal,
  historyLookup?: CompletionBlobHistoryLookup,
  onHistoryMatch?: (path: string, workingTreeBlobSha: string) => void,
): Promise<SettlementResidualPath[] | undefined> {
  const parsed = CompletionSettlementManifestSchema.safeParse(normalizeStoredSettlementManifest(manifest));
  if (!parsed.success || !SHA_RE.test(commitSha)) return undefined;
  const receipt = parsed.data;
  const committed = await (signal
    ? lookup(receipt.repositoryRoot, commitSha, receipt.normalizedPaths, { signal })
    : lookup(receipt.repositoryRoot, commitSha, receipt.normalizedPaths));
  if (signal?.aborted) return undefined;
  if (!committed) {
    return receipt.normalizedPaths.map((path) => ({ path, reason: 'identity-unavailable' }));
  }
  const closeIdentity = new Map<string, SettlementIdentity>(
    receipt.contentIdentity.map((entry) => [entry.path, entry as SettlementIdentity]),
  );
  const residualPaths: SettlementResidualPath[] = [];
  for (const path of receipt.normalizedPaths) {
    const expected = closeIdentity.get(path);
    if (!expected) {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    const actual = committed.get(path);
    // WI-42441: a path the lookup could not RESOLVE is `identity-unavailable`, never
    // `missing-from-commit`. The two carry opposite remedies — one is the server's to
    // fix, the other asks the closer to go re-commit work that is already committed —
    // and an unreadable submodule used to land in the second.
    if (!actual || actual.status === 'unresolvable') {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    if (expected.deletion === true) {
      // A deletion is settled by a definitive absence in the emitted commit.
      // Do not let a malformed deletion entry with a non-null close identity
      // become proof merely because the path happens to be absent.
      if (expected.workingTreeBlobSha !== null || expected.headBlobSha !== null) {
        residualPaths.push({ path, reason: 'identity-unavailable' });
        continue;
      }
      if (actual.status !== 'absent') residualPaths.push({ path, reason: 'content-mismatch' });
      continue;
    }
    const expectedSha = expected.workingTreeBlobSha;
    if (expectedSha == null) {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    if (actual.status === 'absent') {
      residualPaths.push({ path, reason: 'missing-from-commit' });
      continue;
    }
    if (actual.sha === expectedSha) continue;
    const foundInHistory = historyLookup
      ? await historyLookup(
          receipt.repositoryRoot,
          receipt.headSha,
          commitSha,
          path,
          expectedSha,
          signal ? { signal } : undefined,
        )
      : false;
    if (signal?.aborted) return undefined;
    if (foundInHistory === true) {
      onHistoryMatch?.(path, expectedSha);
      continue;
    }
    residualPaths.push({
      path,
      reason: foundInHistory === undefined ? 'identity-unavailable' : 'content-mismatch',
    });
  }
  return residualPaths;
}

type CandidateRow = { feature_id: string; harness_slug: string; payload: unknown };

/**
 * WI-1053550: the treeStamp this reconciler's authority upgrade needs to SURVIVE
 * migration 972's `completion_authority_floor_trg`. That trigger polices ONLY
 * `_completionEvidence.treeStamp.contentIdentity` (mirroring
 * `completionTreeContentIdentityMatches()`) — a surface this reconciler never
 * wrote before this fix. It refreshed `settlementManifest` only, so an upgrade
 * to `committed` was downgraded straight back by the trigger on the very same
 * write: the trigger re-read the ORIGINAL close-time treeStamp (captured before
 * git-sync had landed the commit, so headBlobSha routinely didn't match yet)
 * and found it still unproven, no matter how conclusively the manifest's own
 * exact-commit lookup had just settled the row.
 *
 * A zero residual count can now come from either an exact emitted-tree match or a
 * path-history match. Only the former can refresh treeStamp: a superseded historical
 * blob is not the emitted commit's current head blob. This function therefore checks
 * the emitted tree map independently and refuses to synthesize a false head identity.
 * The database floor still requires exact tree identity; historical-only authority
 * needs a corresponding floor extension before it can persist.
 */
function confirmedTreeStampForSettlement(
  manifest: CompletionSettlementManifest,
  commitSha: string,
  emittedTree: ReadonlyMap<string, HeadBlobResolution>,
): CompletionTreeStamp | undefined {
  const normalized = new Set(manifest.normalizedPaths);
  const contentIdentity = manifest.contentIdentity
    // WI-1409142: `!= null` also excludes an ABSENT key. The schema now accepts a
    // missing sha as null, so a strict `!== null` would let `undefined` through and
    // write a treeStamp entry whose shas are undefined — which
    // completionTreeContentIdentityMatches would then have to reject, silently
    // undoing the very upgrade this function exists to make survive the trigger.
    .filter((entry) => {
      if (!normalized.has(entry.path)) return false;
      const deletion = (entry as SettlementIdentity).deletion === true;
      return deletion || entry.workingTreeBlobSha != null;
    })
    .map((entry) => {
      const deletion = (entry as SettlementIdentity).deletion === true;
      return {
        path: entry.path,
        workingTreeBlobSha: deletion ? null : entry.workingTreeBlobSha,
        headBlobSha: deletion ? null : entry.workingTreeBlobSha,
        ...(deletion ? { deletion: true as const } : {}),
      };
    });
  if (contentIdentity.length === 0) return undefined;
  // History can prove settlement after a later commit has superseded a path,
  // but that does not make the older blob part of commitSha's exact tree. Only
  // refresh treeStamp when the emitted tree itself still matches every identity.
  const exactTreeMatches = contentIdentity.every((entry) => {
    if ((entry as SettlementIdentity).deletion === true) {
      return emittedTree.get(entry.path)?.status === 'absent';
    }
    const actual = emittedTree.get(entry.path);
    return actual?.status === 'resolved' && actual.sha === entry.workingTreeBlobSha;
  });
  if (!exactTreeMatches) return undefined;
  return { repositoryRoot: manifest.repositoryRoot, headSha: commitSha, contentIdentity };
}

export interface CompletionSettlementReconcilerDeps {
  /** Exact-tree lookup seam used by focused reconciliation tests. */
  lookup?: CompletionHeadBlobLookup;
  /** Exact-path history proof seam. Production uses the emitted commit's Git history. */
  historyLookup?: CompletionBlobHistoryLookup;
  /** Await-event seam; production uses the durable, per-key latched emitter. */
  emit?: typeof emitAwaitedEvent;
  /** Database seam for focused tests. */
  sql?: ReturnType<typeof getOrgPg>['sql'];
  /** Called once per candidate so the action liveness timer can observe batch progress. */
  onProgress?: (progress: { completed: number; total: number; featureId: string }) => void | Promise<void>;
  /** Cancels an in-flight Git child and prevents late settlement writes after timeout. */
  signal?: AbortSignal;
}

/** Reconcile a bounded batch of proposed code completions against the exact emitted commit. */
export async function reconcileProposedCompletionsAtCommit(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps = {},
): Promise<{ inspected: number; upgraded: string[]; residual: number; unreadable: string[] }> {
  if (!SHA_RE.test(commitSha) || !scope.repositoryRoot.trim()) {
    return { inspected: 0, upgraded: [], residual: 0, unreadable: [] };
  }
  const sql = deps.sql ?? getOrgPg().sql;
  const lookup = deps.lookup ?? completionHeadBlobMap;
  // A custom exact-tree lookup is the unit-test seam for the older tree-only
  // contract. Tests opt into history explicitly; production uses the safe Git reader.
  const historyLookup = deps.historyLookup ?? (deps.lookup ? undefined : completionBlobHistoryContains);
  const emit = deps.emit ?? emitAwaitedEvent;
  const rows = await sql<CandidateRow[]>`
    SELECT feature_id, harness_slug, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND authority = 'proposed'
       AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
       AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest']}::text[] IS NOT NULL
     ORDER BY updated_ts ASC, feature_id ASC
     LIMIT ${MAX_CANDIDATES}`;

  if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');

  const upgradedByIndex: Array<string | undefined> = [];
  const residualByIndex: number[] = [];
  // WI-1409142: a candidate this pass could not READ is the failure mode that hurts
  // most, because it is indistinguishable from one that settled cleanly: the row is
  // skipped, no residualPaths are written, and it therefore shows up in NEITHER the
  // settled nor the unsettled count. 110 closes sat permanently stuck that way for
  // four days with not one line of output. Skipping is still correct — one malformed
  // row must not stall the batch — but it must never again be SILENT.
  const unreadableByIndex: Array<string | undefined> = [];
  let completed = 0;
  const settleRow = async (row: CandidateRow, index: number): Promise<void> => {
    try {
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');
      let payload: Record<string, unknown>;
      try {
        payload =
          typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : (row.payload as Record<string, unknown>);
      } catch {
        unreadableByIndex[index] = row.feature_id;
        return;
      }
      const evidence = payload?.[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown> | undefined;
      const manifest = evidence?.settlementManifest;
      const parsed = CompletionSettlementManifestSchema.safeParse(normalizeStoredSettlementManifest(manifest));
      if (!parsed.success) {
        unreadableByIndex[index] = row.feature_id;
        return;
      }
      let emittedTree: ReadonlyMap<string, HeadBlobResolution> | undefined;
      const captureLookup: CompletionHeadBlobLookup = async (root, sha, paths, opts) => {
        emittedTree = await lookup(root, sha, paths, opts);
        return emittedTree;
      };
      const historyMatches = new Map<string, string>();
      const residualPaths = await residualPathsForCommit(
        parsed.data,
        commitSha,
        captureLookup,
        deps.signal,
        historyLookup,
        (path, workingTreeBlobSha) => historyMatches.set(path, workingTreeBlobSha),
      );
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');
      if (!residualPaths) return;
      residualByIndex[index] = residualPaths.length;
      const nextManifest = { ...parsed.data, residualPaths };
      const historyAttestation: SettlementHistoryAttestation | null =
        residualPaths.length === 0 && historyMatches.size > 0
          ? {
              version: 1,
              generation: parsed.data.generation,
              evidenceHash: parsed.data.evidenceHash,
              repositoryRoot: parsed.data.repositoryRoot,
              closeHeadSha: parsed.data.headSha,
              emittedCommitSha: commitSha,
              paths: [...historyMatches.entries()].map(([path, workingTreeBlobSha]) => ({
                path,
                workingTreeBlobSha,
                fromHeadSha: parsed.data.headSha,
                toCommitSha: commitSha,
                proof: 'exact-path-blob-history' as const,
              })),
            }
          : null;
      // WI-1053550: refresh treeStamp only when the emitted tree itself matches every
      // close-time blob. A history-only settlement cannot truthfully claim that the
      // superseded blob is still in the emitted tree.
      const confirmedTreeStamp =
        residualPaths.length === 0 && emittedTree
          ? confirmedTreeStampForSettlement(parsed.data, commitSha, emittedTree)
          : undefined;
      const nextPayload = {
        ...payload,
        [TERMINAL_COMPLETION_EVIDENCE_KEY]: {
          ...evidence,
          settlementManifest: nextManifest,
          historyAttestation,
          ...(confirmedTreeStamp ? { treeStamp: confirmedTreeStamp } : {}),
        },
      };
      const result = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = ${sql.json(nextPayload)},
             authority = CASE WHEN ${residualPaths.length} = 0 THEN 'committed' ELSE authority END,
             updated_ts = ${Date.now()}
       WHERE feature_id = ${row.feature_id}
         AND workspace_id = ${scope.workspaceId}
         AND harness_slug = ${row.harness_slug}
         AND authority = 'proposed'
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'generation']}::text[] = ${String(parsed.data.generation)}
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'evidenceHash']}::text[] = ${parsed.data.evidenceHash}
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
       RETURNING feature_id`;
      if (residualPaths.length === 0 && result[0]) {
        const id = result[0].feature_id;
        upgradedByIndex[index] = id;
        // D-003: the generation/evidence-scoped CAS above is the exact-once gate.
        // Replays and stale generations miss RETURNING and therefore cannot re-fire.
        await emit({
          key: `work-item:settled:${id}`,
          summary: `${id} settlement committed at ${commitSha.slice(0, 12)}`,
          payload: {
            id,
            harness: row.harness_slug,
            commitSha,
            generation: parsed.data.generation,
            evidenceHash: parsed.data.evidenceHash,
          },
          source: 'git-sync-completion-settlement',
          workspaceId: scope.workspaceId,
        });
      }
    } finally {
      completed += 1;
      await deps.onProgress?.({ completed, total: rows.length, featureId: row.feature_id });
    }
  };
  // Each candidate has its own generation/evidence CAS. Run a bounded group of
  // independent Git lookups and writes together so old proposed completions do
  // not consume the entire per-fire settlement budget one at a time. Drain every
  // worker before this reconciler returns, including after an error.
  let nextIndex = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < rows.length) {
      const index = nextIndex++;
      try {
        await settleRow(rows[index]!, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(SETTLEMENT_CONCURRENCY, rows.length) }, () => worker()),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const upgraded = upgradedByIndex.filter((id): id is string => id !== undefined);
  const unreadable = unreadableByIndex.filter((id): id is string => id !== undefined);
  const residualCount = residualByIndex.reduce((sum, count) => sum + count, 0);
  if (unreadable.length > 0) {
    // Named ids, not just a count: the whole point is that someone can go LOOK at one.
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${unreadable.length} of ${rows.length} ` +
        'proposed completion(s) carry a settlementManifest this pass could not read; they were skipped ' +
        'and stay unsettled, counted as neither settled nor residual: ' +
        `${unreadable.slice(0, 10).join(', ')}${unreadable.length > 10 ? ` (+${unreadable.length - 10} more)` : ''}`,
    );
  }
  return { inspected: rows.length, upgraded, residual: residualCount, unreadable };
}
