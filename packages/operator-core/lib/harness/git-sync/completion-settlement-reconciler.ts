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
  completionWorkingTreeBlobSha,
  createCompletionBlobHistoryReader,
  createPersistedCompletionHistorySearchMemo,
  persistedCompletionHistorySearchMemo,
  type CompletionHistoryMemoStore,
  type HeadBlobResolution,
  type PersistedCompletionHistorySearchMemo,
} from '../../agent-tools/work_items/completion-freshness';
import { pgCompletionHistoryMemoStore } from './completion-history-memo-store';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type postgres from 'postgres';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { emitAwaitedEvent } from '../../events/await/engine';
import {
  COMPLETION_SETTLEMENT_HEALTH_KEY,
  recordCompletionSettlementHealth,
  type SettlementFireObservation,
} from './completion-settlement-health';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_CANDIDATES = 200;
const SETTLEMENT_CONCURRENCY = 8;

/**
 * `superseded-before-commit` (WI-10004711) is `content-mismatch` with the one fact that
 * decides the remedy: the close-time blob is in no commit since the close AND the working
 * tree no longer holds it, so no sweep can ever land it. Plain `content-mismatch` keeps
 * the cases where waiting can still work (the working tree still holds the blob, or it
 * could not be read). It is a verdict on the CURRENT state: a later commit that restores
 * the exact content still settles the row, because every pass re-checks history.
 */
export type SettlementResidualReason =
  | 'identity-unavailable'
  | 'missing-from-commit'
  | 'content-mismatch'
  | 'superseded-before-commit'
  /**
   * WI-10005343: the declared path is not a repository pathspec at all (absolute, `..`-escaping,
   * or pathspec magic) — a report URI, an out-of-repo file, a `/tmp` artifact. No commit can ever
   * hold it, so the verdict is deterministic, unlike `identity-unavailable`.
   */
  | 'not-a-repository-path';
export type SettlementResidualPath = { path: string; reason: SettlementResidualReason };
/** Current working-tree blob of one path: null = absent, undefined = could not read. */
type CompletionWorkingTreeLookup = (repoRoot: string, path: string, shaLength: number) => string | null | undefined;
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
type SettlementHistoryCheckoutAttestation = {
  repositoryRoot: string;
  closeHeadSha: string;
  emittedCommitSha: string;
  paths: SettlementHistoryPathAttestation[];
};
type SettlementHistoryAttestation = {
  version: 2;
  generation: number;
  evidenceHash: string;
  checkouts: SettlementHistoryCheckoutAttestation[];
};

/** EI-22344624691081449: manifest entries may describe an intentional deletion. */
type SettlementIdentity = CompletionSettlementManifest['contentIdentity'][number] & {
  deletion?: true;
  repositoryRoot?: string;
  headSha?: string;
};

type CheckoutIdentityGroup = {
  repositoryRoot: string;
  headSha: string;
  contentIdentity: SettlementIdentity[];
};

function settlementIdentityRoot(identity: SettlementIdentity, manifest: CompletionSettlementManifest): string {
  return identity.repositoryRoot ?? manifest.repositoryRoot;
}

function settlementIdentityHead(identity: SettlementIdentity, manifest: CompletionSettlementManifest): string {
  return identity.headSha ?? manifest.headSha;
}

function checkoutIdentityKey(repositoryRoot: string, headSha: string): string {
  return JSON.stringify([repositoryRoot, headSha]);
}

function checkoutPathKey(repositoryRoot: string, headSha: string, path: string): string {
  return JSON.stringify([repositoryRoot, headSha, path]);
}

function checkoutGroups(manifest: CompletionSettlementManifest): CheckoutIdentityGroup[] {
  const groups = new Map<string, CheckoutIdentityGroup>();
  for (const raw of manifest.contentIdentity) {
    const identity = raw as SettlementIdentity;
    const repositoryRoot = settlementIdentityRoot(identity, manifest);
    const headSha = settlementIdentityHead(identity, manifest);
    const key = checkoutIdentityKey(repositoryRoot, headSha);
    let group = groups.get(key);
    if (!group) {
      group = { repositoryRoot, headSha, contentIdentity: [] };
      groups.set(key, group);
    }
    group.contentIdentity.push(identity);
  }
  return [...groups.values()].sort((a, b) =>
    a.repositoryRoot.localeCompare(b.repositoryRoot) || a.headSha.localeCompare(b.headSha),
  );
}

function manifestForCheckout(
  manifest: CompletionSettlementManifest,
  group: CheckoutIdentityGroup,
): CompletionSettlementManifest {
  return {
    ...manifest,
    repositoryRoot: group.repositoryRoot,
    headSha: group.headSha,
    normalizedPaths: [...new Set(group.contentIdentity.map(({ path }) => path))],
    contentIdentity: group.contentIdentity,
    residualPaths: undefined,
  };
}

function historyCheckoutAttestations(
  raw: unknown,
  manifest: CompletionSettlementManifest,
): SettlementHistoryCheckoutAttestation[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  if (value.generation !== manifest.generation || value.evidenceHash !== manifest.evidenceHash) return [];
  const candidates: unknown[] = value.version === 1 && Array.isArray(value.paths)
    ? [{
        repositoryRoot: value.repositoryRoot ?? manifest.repositoryRoot,
        closeHeadSha: value.closeHeadSha ?? manifest.headSha,
        emittedCommitSha: value.emittedCommitSha,
        paths: value.paths,
      }]
    : value.version === 2 && Array.isArray(value.checkouts)
      ? value.checkouts
      : [];
  const verified: SettlementHistoryCheckoutAttestation[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const checkout = candidate as Record<string, unknown>;
    const repositoryRoot = checkout.repositoryRoot;
    const closeHeadSha = checkout.closeHeadSha;
    const emittedCommitSha = checkout.emittedCommitSha;
    if (
      typeof repositoryRoot !== 'string' || !repositoryRoot.trim() ||
      typeof closeHeadSha !== 'string' || !SHA_RE.test(closeHeadSha) ||
      typeof emittedCommitSha !== 'string' || !SHA_RE.test(emittedCommitSha) ||
      !Array.isArray(checkout.paths) || checkout.paths.length === 0
    ) continue;
    const group = checkoutGroups(manifest).find(
      (item) => item.repositoryRoot === repositoryRoot && item.headSha === closeHeadSha,
    );
    if (!group) continue;
    const paths: SettlementHistoryPathAttestation[] = [];
    let valid = true;
    for (const rawPath of checkout.paths) {
      if (!rawPath || typeof rawPath !== 'object' || Array.isArray(rawPath)) {
        valid = false;
        break;
      }
      const pathEntry = rawPath as Record<string, unknown>;
      const path = pathEntry.path;
      const workingTreeBlobSha = pathEntry.workingTreeBlobSha;
      if (
        typeof path !== 'string' || !path.trim() ||
        typeof workingTreeBlobSha !== 'string' || !SHA_RE.test(workingTreeBlobSha) ||
        pathEntry.fromHeadSha !== closeHeadSha || pathEntry.toCommitSha !== emittedCommitSha ||
        pathEntry.proof !== 'exact-path-blob-history'
      ) {
        valid = false;
        break;
      }
      const matches = group.contentIdentity.filter(
        (identity) => identity.path === path && identity.deletion !== true && identity.workingTreeBlobSha === workingTreeBlobSha,
      );
      if (matches.length !== 1) {
        valid = false;
        break;
      }
      paths.push({
        path,
        workingTreeBlobSha,
        fromHeadSha: closeHeadSha,
        toCommitSha: emittedCommitSha,
        proof: 'exact-path-blob-history',
      });
    }
    if (valid) verified.push({ repositoryRoot, closeHeadSha, emittedCommitSha, paths });
  }
  return verified;
}

function identityHasHistoryProof(
  identity: SettlementIdentity,
  group: CheckoutIdentityGroup,
  attestations: readonly SettlementHistoryCheckoutAttestation[],
): boolean {
  return attestations.some((checkout) =>
    checkout.repositoryRoot === group.repositoryRoot && checkout.closeHeadSha === group.headSha &&
    checkout.paths.some((path) =>
      path.path === identity.path && path.workingTreeBlobSha === identity.workingTreeBlobSha,
    ),
  );
}

function identityIsExactInStamp(
  identity: SettlementIdentity,
  group: CheckoutIdentityGroup,
  treeStampValue: unknown,
): boolean {
  if (!treeStampValue || typeof treeStampValue !== 'object' || Array.isArray(treeStampValue)) return false;
  const stamp = treeStampValue as Record<string, unknown>;
  if (!Array.isArray(stamp.contentIdentity)) return false;
  return stamp.contentIdentity.some((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return false;
    const entry = rawEntry as Record<string, unknown>;
    const root = typeof entry.repositoryRoot === 'string' ? entry.repositoryRoot : stamp.repositoryRoot;
    if (root !== group.repositoryRoot || entry.path !== identity.path) return false;
    if (identity.deletion === true) {
      return entry.deletion === true && entry.workingTreeBlobSha == null && entry.headBlobSha == null;
    }
    return entry.workingTreeBlobSha === identity.workingTreeBlobSha &&
      entry.headBlobSha === identity.workingTreeBlobSha;
  });
}

function identityIsOutOfRepoArtifactInStamp(
  identity: SettlementIdentity,
  group: CheckoutIdentityGroup,
  treeStampValue: unknown,
): boolean {
  if (!treeStampValue || typeof treeStampValue !== 'object' || Array.isArray(treeStampValue)) return false;
  const stamp = treeStampValue as Record<string, unknown>;
  if (!Array.isArray(stamp.contentIdentity)) return false;
  return stamp.contentIdentity.some((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return false;
    const entry = rawEntry as Record<string, unknown>;
    const repositoryRoot = typeof entry.repositoryRoot === 'string' ? entry.repositoryRoot : stamp.repositoryRoot;
    const headSha = typeof entry.headSha === 'string' ? entry.headSha : stamp.headSha;
    return entry.outOfRepoArtifact === true &&
      repositoryRoot === group.repositoryRoot &&
      headSha === group.headSha &&
      entry.path === identity.path;
  });
}

function identityNeedsCheckoutSettlement(
  identity: SettlementIdentity,
  group: CheckoutIdentityGroup,
  evidence: Record<string, unknown> | undefined,
  manifest: CompletionSettlementManifest,
  attestations: readonly SettlementHistoryCheckoutAttestation[],
): boolean {
  if (identity.deletion === true && identity.workingTreeBlobSha == null && identity.headBlobSha == null) return false;
  if (identity.deletion !== true && identity.workingTreeBlobSha != null && identity.headBlobSha === identity.workingTreeBlobSha) return false;
  return !identityIsExactInStamp(identity, group, evidence?.treeStamp) &&
    !identityHasHistoryProof(identity, group, attestations);
}

function completionEvidenceIdentityIsProven(
  evidence: Record<string, unknown> | undefined,
  manifest: CompletionSettlementManifest,
  attestations: readonly SettlementHistoryCheckoutAttestation[],
): boolean {
  const rawStamp = evidence?.treeStamp;
  if (!rawStamp || typeof rawStamp !== 'object' || Array.isArray(rawStamp)) return false;
  const stamp = rawStamp as Record<string, unknown>;
  if (!Array.isArray(stamp.contentIdentity)) return false;
  for (const rawEntry of stamp.contentIdentity) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return false;
    const entry = rawEntry as Record<string, unknown>;
    if (entry.outOfRepoArtifact === true) continue;
    if (entry.deletion === true) {
      if (entry.workingTreeBlobSha != null || entry.headBlobSha != null) return false;
      continue;
    }
    if (typeof entry.workingTreeBlobSha === 'string' && entry.headBlobSha === entry.workingTreeBlobSha) continue;
    const repositoryRoot = typeof entry.repositoryRoot === 'string' ? entry.repositoryRoot : stamp.repositoryRoot;
    const headSha = typeof entry.headSha === 'string' ? entry.headSha : stamp.headSha;
    if (typeof repositoryRoot !== 'string' || typeof headSha !== 'string') return false;
    const manifestGroup = checkoutGroups(manifest).find(
      (group) => group.repositoryRoot === repositoryRoot && group.headSha === headSha,
    );
    if (!manifestGroup || typeof entry.path !== 'string' || typeof entry.workingTreeBlobSha !== 'string') return false;
    const manifestMatches = manifestGroup.contentIdentity.filter(
      (identity) => identity.path === entry.path && identity.workingTreeBlobSha === entry.workingTreeBlobSha && identity.deletion !== true,
    );
    if (manifestMatches.length !== 1) return false;
    const attested = attestations.some((checkout) =>
      checkout.repositoryRoot === repositoryRoot && checkout.closeHeadSha === headSha &&
      checkout.paths.some((path) =>
        path.path === entry.path && path.workingTreeBlobSha === entry.workingTreeBlobSha,
      ),
    );
    if (!attested) return false;
  }
  return true;
}

function refreshedTreeStampForCheckout(
  rawStamp: unknown,
  manifest: CompletionSettlementManifest,
  groups: readonly CheckoutIdentityGroup[],
  repositoryRoot: string,
  commitSha: string,
  emittedTree: ReadonlyMap<string, HeadBlobResolution>,
): CompletionTreeStamp | undefined {
  const stamp = rawStamp && typeof rawStamp === 'object' && !Array.isArray(rawStamp)
    ? rawStamp as Record<string, unknown>
    : {
        repositoryRoot: manifest.repositoryRoot,
        headSha: manifest.headSha,
        contentIdentity: manifest.contentIdentity,
      };
  if (!Array.isArray(stamp.contentIdentity) || typeof stamp.repositoryRoot !== 'string' || typeof stamp.headSha !== 'string') return undefined;
  const groupsByHead = new Map(groups.map((group) => [group.headSha, group]));
  const fullyExactHeads = new Set<string>();
  for (const group of groups) {
    const allExact = group.contentIdentity.every((identity) => {
      const actual = emittedTree.get(identity.path);
      if (identity.deletion === true) return actual?.status === 'absent';
      return typeof identity.workingTreeBlobSha === 'string' &&
        actual?.status === 'resolved' && actual.sha === identity.workingTreeBlobSha;
    });
    if (allExact) fullyExactHeads.add(group.headSha);
  }
  let changed = false;
  const contentIdentity = stamp.contentIdentity.map((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return rawEntry;
    const entry = rawEntry as Record<string, unknown>;
    const root = typeof entry.repositoryRoot === 'string' ? entry.repositoryRoot : stamp.repositoryRoot as string;
    const head = typeof entry.headSha === 'string' ? entry.headSha : stamp.headSha as string;
    if (root !== repositoryRoot) return rawEntry;
    const group = groupsByHead.get(head);
    if (!group || !fullyExactHeads.has(group.headSha)) return rawEntry;
    const identity = group.contentIdentity.find((candidate) => candidate.path === entry.path);
    if (!identity) return rawEntry;
    const actual = emittedTree.get(identity.path);
    if (identity.deletion === true && actual?.status === 'absent') {
      changed = true;
      return { ...entry, repositoryRoot, headSha: commitSha, headBlobSha: null };
    }
    if (
      identity.deletion !== true && typeof identity.workingTreeBlobSha === 'string' &&
      actual?.status === 'resolved' && actual.sha === identity.workingTreeBlobSha
    ) {
      changed = true;
      return { ...entry, repositoryRoot, headSha: commitSha, headBlobSha: actual.sha };
    }
    return rawEntry;
  });
  if (!changed) return undefined;
  return {
    ...(stamp as unknown as CompletionTreeStamp),
    ...(stamp.repositoryRoot === repositoryRoot ? { headSha: commitSha } : {}),
    contentIdentity: contentIdentity as CompletionTreeStamp['contentIdentity'],
  };
}

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
  /** WI-10004711: opt-in. Without it a mismatch stays `content-mismatch` (never stranded). */
  workingTreeLookup?: CompletionWorkingTreeLookup,
): Promise<SettlementResidualPath[] | undefined> {
  const parsed = CompletionSettlementManifestSchema.safeParse(normalizeStoredSettlementManifest(manifest));
  if (!parsed.success || !SHA_RE.test(commitSha)) return undefined;
  const receipt = parsed.data;
  // WI-10005343: `git ls-tree` exits 128 on the WHOLE call for a path outside the repository
  // (`/reports/rpt_…`, `/tmp/…`, `/home/…/.config/…` — measured in legacy manifests written
  // before out-of-repo artifacts were excluded at close). The `!committed` branch below then
  // read that deterministic refusal as a transient timeout, so the row was skipped as
  // lookup-unavailable on every pass forever (33 consecutive fires for WI-10002141) and kept
  // the settlement health verdict `failing`. Such a path can be in no commit: classify it
  // here and look up only real repository paths.
  const lookupPaths = receipt.normalizedPaths.filter(batchSafeDeclaredPath);
  const committed =
    lookupPaths.length === 0
      ? new Map<string, HeadBlobResolution>()
      : await (signal
          ? lookup(receipt.repositoryRoot, commitSha, lookupPaths, { signal })
          : lookup(receipt.repositoryRoot, commitSha, lookupPaths));
  if (signal?.aborted) return undefined;
  // EI-24807349327024992: a whole-batch lookup failure measured NOTHING about this row. The
  // exact-tree lookup runs every `git ls-tree` under a 5s per-call timeout, so under load
  // (the pass routinely ran into its 90s budget) a timeout used to be persisted as an
  // `identity-unavailable` residual on EVERY declared path. That fails the 1207 floor, moves
  // the row from the never-attempted tier to the back of the rotation, and kept a fully
  // committed close `proposed` for ~3h (WI-10004574). Return undefined instead: the row
  // stays proposed (still fail-closed), nothing is written, and the next fire retries it.
  // The reconciler counts these as `lookupUnavailable`, so the skip is never silent.
  if (!committed) return undefined;
  const closeIdentity = new Map<string, SettlementIdentity>(
    receipt.contentIdentity.map((entry) => [entry.path, entry as SettlementIdentity]),
  );
  const residualPaths: SettlementResidualPath[] = [];
  for (const path of receipt.normalizedPaths) {
    if (!batchSafeDeclaredPath(path)) {
      residualPaths.push({ path, reason: 'not-a-repository-path' });
      continue;
    }
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
    // EI-24821039535031884: a history read that hit its 5s deadline measured nothing.
    // Skip the WHOLE row (undefined, counted as `lookupUnavailable`) exactly like the
    // whole-batch branch above, instead of persisting this path as `identity-unavailable`.
    // Only deterministic refusals (undefined below) are durable residue.
    if (foundInHistory === 'unmeasured') return undefined;
    if (foundInHistory === true) {
      onHistoryMatch?.(path, expectedSha);
      continue;
    }
    if (foundInHistory === undefined) {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    // WI-10004711: `stranded` needs BOTH halves measured. History must have been
    // CONSULTED (a skipped history read defaults to false above, which proves nothing),
    // and the working tree must be READ and differ: if it still holds the close-time blob,
    // the next sweep lands it (e.g. a path the last commit excluded while it was locked).
    const current = historyLookup ? workingTreeLookup?.(receipt.repositoryRoot, path, commitSha.length) : undefined;
    residualPaths.push({
      path,
      reason: current !== undefined && current !== expectedSha ? 'superseded-before-commit' : 'content-mismatch',
    });
  }
  return residualPaths;
}

type CandidateRow = { feature_id: string; harness_slug: string; payload: unknown; terminal_owner?: string | null };

/** WI-10004711: what the closer is told when their close can no longer settle by waiting. */
export type SettlementStrandedNotice = {
  workItemId: string;
  harness: string;
  workspaceId: string;
  /** The row's recorded closer; null when the row carries none (the notice is then logged only). */
  terminalOwner: string | null;
  strandedPaths: string[];
  commitSha: string;
  generation: number;
};

const SETTLEMENT_SYSTEM_OWNER = 'system:git-sync-completion-settlement';

/**
 * Production `onSettled` (P-007 Phase C, D-028 §6): settlement just upgraded the row to
 * 'committed', so an open completion verification task for it is accepted by settlement.
 * Lazy import: the store reaches work-items/issues-engineer, which this module must not load
 * eagerly.
 */
export async function acceptCompletionVerificationOnSettlement(settled: {
  id: string;
  authority: 'committed';
}): Promise<void> {
  const { acceptCompletionOnSettlementForSubject } = await import('../improvements/completion-verification-store');
  await acceptCompletionOnSettlementForSubject(settled.id, settled.authority);
}

/**
 * Production notice: one coord message to the closer. Best-effort by contract — the
 * caller swallows a failure, because a notice must never fail the settlement pass.
 */
export async function notifySettlementStranded(notice: SettlementStrandedNotice): Promise<void> {
  if (!notice.terminalOwner) {
    console.warn(
      `[git-sync-completion-settlement] ${notice.workItemId} is stranded (${notice.strandedPaths.join(', ')}) ` +
        'but carries no terminal_owner to notify',
    );
    return;
  }
  const identity: AgentIdentity = {
    ownerId: SETTLEMENT_SYSTEM_OWNER,
    ownerLabel: 'system · completion settlement',
    source: 'principal',
    workspaceId: notice.workspaceId,
    userId: null,
  };
  const paths = notice.strandedPaths.map((path) => `\`${path}\``).join(', ');
  await sendMessage(identity, {
    to: [notice.terminalOwner],
    harnessSlug: notice.harness,
    summary:
      `${notice.workItemId}: your close cannot settle by waiting. ${notice.strandedPaths.length} path(s) changed ` +
      'again before git-sync committed the content you closed with. Re-verify, then re-send work_items:complete.',
    body:
      `Your close of ${notice.workItemId} (harness ${notice.harness}) recorded blobs for ${paths} that never ` +
      `reached a commit: each path was edited again before git-sync swept it, so the recorded content is in ` +
      `no commit since your close (checked through ${notice.commitSha.slice(0, 12)}) and no longer in the ` +
      `working tree. The close stays authority 'proposed', not counted toward burn-down, until you act; ` +
      `waiting cannot settle it. Check that each path's CURRENT content still carries your change (someone ` +
      `else may have edited it). If it does, re-call work_items:complete { id: '${notice.workItemId}', ` +
      `harness: '${notice.harness}' } with your completion evidence: that records the current blobs, and the ` +
      `next git-sync commit settles it. If your change is gone, reopen the item instead.`,
    extra: {
      settlementStranded: true,
      workItemId: notice.workItemId,
      generation: notice.generation,
      strandedPaths: notice.strandedPaths,
    },
  });
}

/**
 * A declared path git accepts as a pathspec inside the repository. `git ls-tree` exits 128
 * on the whole call for a path outside the repository (`/reports/...` was measured in the
 * live candidate set on 2026-10-02), so one such path would fail the batched read for every
 * row. Rows that declare one fall through to their own per-row read, which classifies that
 * path as `not-a-repository-path` and looks up only the rest (WI-10005343).
 */
function batchSafeDeclaredPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.startsWith(':') || path.includes('\0')) return false;
  return !path.split('/').includes('..');
}

/**
 * The declared paths of every candidate row, read straight from the stored manifest. This
 * is only a prefetch hint: a path missing here makes that row read its own tree, so it skips
 * the schema parse that settleRow does anyway.
 */
/** A candidate row's parsed settlement manifest; undefined when it does not parse. */
function settlementManifestOfRow(row: CandidateRow) {
  try {
    const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as
      | Record<string, unknown>
      | null
      | undefined;
    const evidence = payload?.[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown> | undefined;
    const parsed = CompletionSettlementManifestSchema.safeParse(
      normalizeStoredSettlementManifest(evidence?.settlementManifest),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function declaredPathsForBatch(rows: readonly CandidateRow[], repositoryRoot: string): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    const manifest = settlementManifestOfRow(row);
    if (!manifest) continue;
    for (const group of checkoutGroups(manifest)) {
      if (group.repositoryRoot !== repositoryRoot) continue;
      for (const { path } of group.contentIdentity) if (batchSafeDeclaredPath(path)) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * WI-10005285: one exact-tree read per settlement pass instead of one per candidate row.
 *
 * Every row of a pass is checked against the SAME emitted commit in the SAME repository,
 * but each used to run its own `git ls-tree` (plus a second one for gitlinks). bg-host
 * forks those children from its multi-GB main thread at ~80 ms of frozen event loop each:
 * a 180 s bpftrace on 2026-10-02 counted ~307 of bg-host's ~393 git forks as these reads.
 * Reading the union of all rows' declared paths once (713 paths: 0.062 s, 83 KB) and
 * answering each row from it removes them.
 *
 * Each path resolves independently of which other paths are read with it, so a row's
 * answer is unchanged. A row is answered from the batch only when the batch resolved every
 * path it asks about; otherwise (the batch failed or timed out, or the row declared a path
 * left out of the batch) it does its own read exactly as before, so one bad row can never
 * stall the others.
 */
export function batchHeadBlobLookup(
  base: CompletionHeadBlobLookup,
  repositoryRoot: string,
  commitSha: string,
  paths: readonly string[],
  signal?: AbortSignal,
  onBatchUnavailable?: () => void,
): CompletionHeadBlobLookup {
  const union = [...new Set(paths)];
  let batch: Promise<ReadonlyMap<string, HeadBlobResolution> | undefined> | undefined;
  return async (root, sha, requested, opts) => {
    if (union.length === 0 || root !== repositoryRoot || sha !== commitSha) {
      return opts ? base(root, sha, requested, opts) : base(root, sha, requested);
    }
    batch ??= (async () => {
      try {
        const tree = await (signal ? base(root, sha, union, { signal }) : base(root, sha, union));
        if (!tree) onBatchUnavailable?.();
        return tree;
      } catch {
        onBatchUnavailable?.();
        return undefined;
      }
    })();
    const tree = await batch;
    if (tree && requested.every((path) => tree.has(path))) {
      return new Map(requested.map((path) => [path, tree.get(path)!] as const));
    }
    return opts ? base(root, sha, requested, opts) : base(root, sha, requested);
  };
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
  /**
   * WI-10004400 standing-guard seam: receives one observation per measured fire. Production
   * (no `sql` injected) persists it on the git-sync routine's metadata; a test that injects
   * `sql` without this seam records nothing, so the pre-existing fixtures stay hermetic.
   */
  recordHealth?: (observation: SettlementFireObservation) => Promise<void>;
  /**
   * WI-10004711: current working-tree blob seam. Production reads the checkout; like
   * `historyLookup`, it is off when only the tree-only `lookup` seam is injected.
   */
  workingTreeLookup?: CompletionWorkingTreeLookup;
  /**
   * WI-10004711: tells a closer their close can no longer settle by waiting. Production
   * (no `sql` injected) sends a coord message; injected `sql` without this seam sends
   * nothing, so hermetic fixtures never reach the real coord log.
   */
  notifyStranded?: (notice: SettlementStrandedNotice) => Promise<void>;
  /**
   * P-007 Phase C (D-028 §6): called once per row whose authority this fire really upgraded
   * to 'committed'. Production (no `sql` injected) closes the subject's open completion
   * verification task as accepted by settlement; injected `sql` without this seam does
   * nothing, so hermetic fixtures never write work items. Failures are logged, never thrown.
   */
  onSettled?: (settled: { id: string; harness: string; authority: 'committed' }) => Promise<void>;
  /**
   * WI-10005560: where the history reader's per-pair verdicts persist across restarts.
   * Production (no `sql` injected) uses Postgres, shared by every pass in the process. An
   * injected store gets a fresh memo per pass, as if the process restarted between passes;
   * injected `sql` without this seam persists nothing, so fixtures stay hermetic.
   */
  historyMemoStore?: CompletionHistoryMemoStore;
}

type ReconcileResult = {
  inspected: number;
  upgraded: string[];
  residual: number;
  unreadable: string[];
  /** Zero residual but the SQL authority floor kept the row 'proposed' — a TS/SQL proof disagreement. */
  floorRejected: string[];
  /** WI-10004711: rows that newly gained a `superseded-before-commit` path on this pass. */
  stranded: string[];
  /**
   * EI-24807349327024992: rows skipped because the exact-tree lookup returned nothing (a
   * timeout or Git failure). Nothing was written for them; the next fire retries them.
   */
  lookupUnavailable: string[];
};

/**
 * Reconcile a bounded batch of proposed code completions against the exact emitted commit,
 * and record the fire's outcome for the standing guard (WI-10004400): this function's
 * per-fire result used to be DISCARDED by its only caller, so a regression of the
 * never-attempted-first ordering or the floor-rejection fix was invisible until a hand census.
 */
export async function reconcileProposedCompletionsAtCommit(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps = {},
): Promise<ReconcileResult> {
  // A no-op call (bad sha / blank root) measured nothing, so it is not a fire to judge.
  if (!SHA_RE.test(commitSha) || !scope.repositoryRoot.trim()) {
    return reconcileProposedCompletionsCore(commitSha, scope, deps);
  }
  // EI-24758680272435881: stamped BEFORE the candidate SELECT. Only a never-attempted row
  // last written before this instant was visible to that SELECT (and, tier-first, would
  // have been among the first rows this pass started). A close that lands mid-pass is
  // the NEXT pass's to attempt, so it must not count against this one.
  const passStartedAtMs = Date.now();
  const historyMemo = settlementHistoryMemo(scope, deps);
  if (historyMemo) {
    await historyMemo.hydrate().catch((error: unknown) => warnHistoryMemo(scope, 'load', error));
  }
  let result: ReconcileResult;
  try {
    result = await reconcileProposedCompletionsCore(commitSha, scope, deps, historyMemo);
  } catch (error) {
    // The pass was cut short (budget / action timeout abort, or a failure), so its per-row
    // stats are unknown — the guard records that as null, never as a fabricated zero.
    await flushHistoryMemo(scope, historyMemo);
    await observeSettlementFire(scope, deps, passStartedAtMs, {
      outcome: deps.signal?.aborted ? 'budget-exceeded' : 'error',
      neverAttemptedRemaining: null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await flushHistoryMemo(scope, historyMemo);
  await observeSettlementFire(scope, deps, passStartedAtMs, {
    outcome: 'completed',
    inspected: result.inspected,
    upgraded: result.upgraded.length,
    residual: result.residual,
    unreadable: result.unreadable.length,
    floorRejected: result.floorRejected.length,
    lookupUnavailable: result.lookupUnavailable.length,
    neverAttemptedRemaining: null,
  });
  return result;
}

/**
 * WI-10005560: the memo a pass's history reader keeps its verdicts in, or undefined for the
 * process-local default. No reader runs when a lookup seam is injected, and injected `sql`
 * without a store is a hermetic fixture.
 */
function settlementHistoryMemo(
  scope: { workspaceId: string },
  deps: CompletionSettlementReconcilerDeps,
): PersistedCompletionHistorySearchMemo | undefined {
  if (deps.historyLookup || deps.lookup) return undefined;
  if (deps.historyMemoStore) return createPersistedCompletionHistorySearchMemo(deps.historyMemoStore);
  if (deps.sql) return undefined;
  return persistedCompletionHistorySearchMemo(scope.workspaceId, () =>
    pgCompletionHistoryMemoStore(getOrgPg().sql, scope.workspaceId),
  );
}

/**
 * Write what the pass learned, even when it was cut short: every kept verdict is exact over
 * its own range. Never throws: losing the write only costs the next boot a re-search.
 */
async function flushHistoryMemo(
  scope: { installSlug: string },
  memo: PersistedCompletionHistorySearchMemo | undefined,
): Promise<void> {
  if (!memo) return;
  await memo.flush().catch((error: unknown) => warnHistoryMemo(scope, 'save', error));
}

function warnHistoryMemo(scope: { installSlug: string }, op: 'load' | 'save', error: unknown): void {
  console.warn(
    `[git-sync-completion-settlement] ${scope.installSlug}: could not ${op} the history search memo: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/**
 * Fill in the DB-measured never-attempted count (measurable even for a cut-short pass),
 * then hand the observation to the recorder. Never throws: a guard that could fail the
 * settlement pass it watches would be worse than no guard.
 */
async function observeSettlementFire(
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps,
  passStartedAtMs: number,
  observation: SettlementFireObservation,
): Promise<void> {
  // Injected `sql` without an injected recorder = an existing hermetic fixture: stay out.
  if (!deps.recordHealth && deps.sql) return;
  try {
    const neverAttemptedRemaining = await countNeverAttemptedCandidates(scope, {
      sql: deps.sql,
      eligibleBeforeMs: passStartedAtMs,
    }).catch(() => null);
    const measured = { ...observation, neverAttemptedRemaining } as SettlementFireObservation;
    if (deps.recordHealth) {
      await deps.recordHealth(measured);
      return;
    }
    const { sql } = getOrgPg();
    await recordCompletionSettlementHealth(measured, {
      readPrevious: async () => {
        const rows = await sql<{ h: unknown }[]>`
          SELECT metadata -> ${COMPLETION_SETTLEMENT_HEALTH_KEY}::text AS h
            FROM harness_shared.routines
           WHERE install_slug = ${scope.installSlug} AND workspace_id = ${scope.workspaceId}
             AND target_role = 'system:git-sync'
           LIMIT 1`;
        return rows[0]?.h ?? null;
      },
      // The same top-level JSONB merge git-sync's own patchRoutineMetadata performs — a
      // `<subsystem>_health` key is what routines:list projects with no reader change.
      write: async (patch) => {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, updated_at = now()
           WHERE install_slug = ${scope.installSlug} AND workspace_id = ${scope.workspaceId}
             AND target_role = 'system:git-sync'`;
      },
    });
  } catch (error) {
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: could not record the standing-guard observation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function reconcileProposedCompletionsCore(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps,
  historyMemo?: PersistedCompletionHistorySearchMemo,
): Promise<ReconcileResult> {
  if (!SHA_RE.test(commitSha) || !scope.repositoryRoot.trim()) {
    return { inspected: 0, upgraded: [], residual: 0, unreadable: [], floorRejected: [], stranded: [], lookupUnavailable: [] };
  }
  const sql = deps.sql ?? getOrgPg().sql;
  const baseLookup = deps.lookup ?? completionHeadBlobMap;
  // A custom exact-tree lookup is the unit-test seam for the older tree-only
  // contract. Tests opt into history explicitly; production uses the safe Git reader.
  // WI-10005357: production shares one gitlink-reading history reader across the pass, so the
  // per-path `ls-tree` reads collapse to about one per (commit, repository) instead of one per
  // declared path per side. A fresh reader per pass keeps only its memo across passes, and
  // WI-10005560 persists that memo across restarts.
  const historyReader =
    deps.historyLookup || deps.lookup ? undefined : createCompletionBlobHistoryReader(undefined, historyMemo);
  const historyLookup = deps.historyLookup ?? historyReader?.contains;
  const workingTreeLookup = deps.workingTreeLookup ?? (deps.lookup ? undefined : completionWorkingTreeBlobSha);
  const notifyStranded = deps.notifyStranded ?? (deps.sql ? undefined : notifySettlementStranded);
  const onSettled = deps.onSettled ?? (deps.sql ? undefined : acceptCompletionVerificationOnSettlement);
  const emit = deps.emit ?? emitAwaitedEvent;
  // EI-24710716781971154: two-tier selection. A row whose manifest has no `residualPaths`
  // key has NEVER been attempted — it is the only kind a fresh close can be, and the
  // only kind that can still settle at this commit for the first time. Every attempt
  // bumps `updated_ts`, so ordering by it alone put a new close behind a FULL rotation
  // of every row that cannot settle (measured 2026-09-30: 527 of 555 candidates, one
  // rotation ≈ 2.4h at ~66 rows per 90s fire). Never-attempted rows go first; attempted
  // rows follow in the same oldest-touched-first rotation as before. The tier is
  // NULL-safe on purpose: an absent key makes `jsonb_typeof(...) = 'array'` NULL, and
  // NULLs sort LAST ascending, which would have put the fresh rows at the back.
  const rows = await sql<CandidateRow[]>`
    SELECT feature_id, harness_slug, payload, terminal_owner
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND authority = 'proposed'
       AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest']}::text[] IS NOT NULL
       AND (
         payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'contentIdentity']}::text[]) = 'array'
                   THEN payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'contentIdentity']}::text[]
                 ELSE '[]'::jsonb
               END
             ) AS settlement_identity(value)
            WHERE COALESCE(NULLIF(settlement_identity.value->>'repositoryRoot', ''),
                           payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[]) = ${scope.repositoryRoot}
         )
       )
     ORDER BY (jsonb_typeof(payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'residualPaths']}::text[]) IS NOT DISTINCT FROM 'array') ASC,
              updated_ts ASC, feature_id ASC
     LIMIT ${MAX_CANDIDATES}`;

  if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');

  // WI-10005285: every row is read against the same commit, so read the tree once per pass.
  // WI-10005357: the history reader's gitlink reads at that commit batch the same way.
  historyReader?.hint(scope.repositoryRoot, commitSha, declaredPathsForBatch(rows, scope.repositoryRoot));
  // WI-10005380: announce every row's close-time (path, blob) pairs before any row asks, so
  // one history search per range answers every row that shares it; and each row's paths at
  // its close-time HEAD, so that search resolves them from one ls-tree per HEAD.
  if (historyReader) {
    for (const row of rows) {
      const manifest = settlementManifestOfRow(row);
      if (!manifest) continue;
      for (const group of checkoutGroups(manifest)) {
        if (group.repositoryRoot !== scope.repositoryRoot) continue;
        const paths = [...new Set(group.contentIdentity.map(({ path }) => path))];
        historyReader.hint(group.repositoryRoot, group.headSha, paths);
        historyReader.hintBlobs(
          group.repositoryRoot,
          group.headSha,
          group.contentIdentity.flatMap((entry) =>
            entry.deletion !== true && typeof entry.workingTreeBlobSha === 'string'
              ? [{ path: entry.path, blobSha: entry.workingTreeBlobSha }]
              : [],
          ),
        );
      }
    }
  }
  let batchUnavailable = false;
  const lookup =
    rows.length > 1
      ? batchHeadBlobLookup(baseLookup, scope.repositoryRoot, commitSha, declaredPathsForBatch(rows, scope.repositoryRoot), deps.signal, () => {
          batchUnavailable = true;
        })
      : baseLookup;

  const upgradedByIndex: Array<string | undefined> = [];
  const residualByIndex: number[] = [];
  // WI-1409142: a candidate this pass could not READ is the failure mode that hurts
  // most, because it is indistinguishable from one that settled cleanly: the row is
  // skipped, no residualPaths are written, and it therefore shows up in NEITHER the
  // settled nor the unsettled count. 110 closes sat permanently stuck that way for
  // four days with not one line of output. Skipping is still correct — one malformed
  // row must not stall the batch — but it must never again be SILENT.
  const unreadableByIndex: Array<string | undefined> = [];
  // Zero residual, UPDATE matched, yet the authority floor kept the row 'proposed'.
  const floorRejectedByIndex: Array<string | undefined> = [];
  const strandedByIndex: Array<string | undefined> = [];
  const lookupUnavailableByIndex: Array<string | undefined> = [];
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
      if (!evidence || typeof evidence !== 'object') {
        unreadableByIndex[index] = row.feature_id;
        return;
      }
      const allGroups = checkoutGroups(parsed.data);
      const currentGroups = allGroups.filter((group) => group.repositoryRoot === scope.repositoryRoot);
      if (currentGroups.length === 0) {
        unreadableByIndex[index] = row.feature_id;
        return;
      }
      const emittedTree = new Map<string, HeadBlobResolution>();
      const captureLookup: CompletionHeadBlobLookup = async (root, sha, paths, opts) => {
        const found = await lookup(root, sha, paths, opts);
        if (found) for (const [path, identity] of found) emittedTree.set(path, identity);
        return found;
      };
      const historyMatchesByCheckout = new Map<string, Map<string, string>>();
      const currentResiduals: Array<SettlementResidualPath & { repositoryRoot: string; headSha: string }> = [];
      let measuredEveryCheckout = true;
      for (const group of currentGroups) {
        const groupKey = checkoutIdentityKey(group.repositoryRoot, group.headSha);
        const historyMatches = new Map<string, string>();
        const checkoutManifest = manifestForCheckout(parsed.data, group);
        historyReader?.hint(group.repositoryRoot, group.headSha, checkoutManifest.normalizedPaths);
        const residuals = await residualPathsForCommit(
          checkoutManifest,
          commitSha,
          captureLookup,
          deps.signal,
          historyLookup,
          (path, workingTreeBlobSha) => historyMatches.set(path, workingTreeBlobSha),
          workingTreeLookup,
        );
        if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');
        if (!residuals) {
          measuredEveryCheckout = false;
          break;
        }
        historyMatchesByCheckout.set(groupKey, historyMatches);
        currentResiduals.push(...residuals.map((entry) => ({
          ...entry,
          repositoryRoot: group.repositoryRoot,
          headSha: group.headSha,
        })));
      }
      if (!measuredEveryCheckout) {
        // A failed root/head read measured nothing for the row. Do not persist partial
        // results from another checkout; the next pass retries the complete current root.
        lookupUnavailableByIndex[index] = row.feature_id;
        return;
      }
      const currentRootResiduals = currentResiduals;
      const previousResiduals = parsed.data.residualPaths ?? [];
      const preservedResiduals = previousResiduals.filter(
        (entry) => (entry.repositoryRoot ?? parsed.data.repositoryRoot) !== scope.repositoryRoot,
      );
      const attestationCheckouts = historyCheckoutAttestations(evidence.historyAttestation, parsed.data)
        .filter((checkout) => checkout.repositoryRoot !== scope.repositoryRoot);
      for (const group of currentGroups) {
        const groupResiduals = currentRootResiduals.filter(
          (entry) => entry.repositoryRoot === group.repositoryRoot && entry.headSha === group.headSha,
        );
        if (groupResiduals.length > 0) continue;
        const closeHistoryMatches = historyMatchesByCheckout.get(checkoutIdentityKey(group.repositoryRoot, group.headSha));
        const paths = new Map<string, string>();
        for (const identity of group.contentIdentity) {
          // The authority floor excludes explicit artifacts that belong to no checkout.
          // Legacy manifests can still carry those paths as ordinary identities, so honor
          // the checkout-scoped server stamp before attaching repository history proof.
          if (identityIsOutOfRepoArtifactInStamp(identity, group, evidence.treeStamp)) continue;
          if (identity.deletion === true || typeof identity.workingTreeBlobSha !== 'string') continue;
          if (identity.headBlobSha === identity.workingTreeBlobSha) continue;
          const actual = emittedTree.get(identity.path);
          if (
            closeHistoryMatches?.get(identity.path) === identity.workingTreeBlobSha ||
            (actual?.status === 'resolved' && actual.sha === identity.workingTreeBlobSha)
          ) {
            paths.set(identity.path, identity.workingTreeBlobSha);
          }
        }
        if (paths.size > 0) {
          attestationCheckouts.push({
            repositoryRoot: group.repositoryRoot,
            closeHeadSha: group.headSha,
            emittedCommitSha: commitSha,
            paths: [...paths.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, workingTreeBlobSha]) => ({
              path,
              workingTreeBlobSha,
              fromHeadSha: group.headSha,
              toCommitSha: commitSha,
              proof: 'exact-path-blob-history' as const,
            })),
          });
        }
      }
      attestationCheckouts.sort((a, b) =>
        a.repositoryRoot.localeCompare(b.repositoryRoot) || a.closeHeadSha.localeCompare(b.closeHeadSha),
      );
      const historyAttestation: SettlementHistoryAttestation | null = attestationCheckouts.length > 0
        ? {
            version: 2,
            generation: parsed.data.generation,
            evidenceHash: parsed.data.evidenceHash,
            checkouts: attestationCheckouts,
          }
        : null;
      const confirmedTreeStamp = refreshedTreeStampForCheckout(
        evidence.treeStamp,
        parsed.data,
        currentGroups,
        scope.repositoryRoot,
        commitSha,
        emittedTree,
      );
      const nextEvidence = {
        ...evidence,
        historyAttestation,
        ...(confirmedTreeStamp ? { treeStamp: confirmedTreeStamp } : {}),
      };
      const nextResiduals = [...preservedResiduals, ...currentRootResiduals];
      for (const group of allGroups) {
        if (group.repositoryRoot === scope.repositoryRoot) continue;
        const alreadyHasResidual = preservedResiduals.some(
          (entry) => (entry.repositoryRoot ?? parsed.data.repositoryRoot) === group.repositoryRoot &&
            (entry.headSha ?? parsed.data.headSha) === group.headSha,
        );
        if (alreadyHasResidual) continue;
        for (const identity of group.contentIdentity) {
          if (!identityNeedsCheckoutSettlement(identity, group, evidence, parsed.data, attestationCheckouts)) continue;
          nextResiduals.push({
            path: identity.path,
            repositoryRoot: group.repositoryRoot,
            headSha: group.headSha,
            reason: 'checkout-not-processed',
          });
        }
      }
      nextResiduals.sort((a, b) =>
        (a.repositoryRoot ?? parsed.data.repositoryRoot).localeCompare(b.repositoryRoot ?? parsed.data.repositoryRoot) ||
        (a.headSha ?? parsed.data.headSha).localeCompare(b.headSha ?? parsed.data.headSha) ||
        a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
      );
      const nextManifest = { ...parsed.data, residualPaths: nextResiduals };
      const persistedEvidence = { ...nextEvidence, settlementManifest: nextManifest };
      const canCommit = nextResiduals.length === 0 &&
        completionEvidenceIdentityIsProven(persistedEvidence, parsed.data, attestationCheckouts);
      residualByIndex[index] = nextResiduals.length;
      const nextPayload = {
        ...payload,
        [TERMINAL_COMPLETION_EVIDENCE_KEY]: persistedEvidence,
      };
      const result = await sql<{ feature_id: string; authority?: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = ${sql.json(nextPayload)},
             authority = CASE WHEN ${canCommit} THEN 'committed' ELSE authority END,
             updated_ts = ${Date.now()}
       WHERE feature_id = ${row.feature_id}
         AND workspace_id = ${scope.workspaceId}
         AND harness_slug = ${row.harness_slug}
         AND authority = 'proposed'
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'generation']}::text[] = ${String(parsed.data.generation)}
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'evidenceHash']}::text[] = ${parsed.data.evidenceHash}
         AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY]}::text[] IS NOT DISTINCT FROM ${sql.json(evidence as postgres.JSONValue)}
       RETURNING feature_id, authority`;
      // EI-24710716781971154: RETURNING reflects the row AFTER migration 972/1207's
      // `downgrade_unproven_committed_close` trigger, which silently reverts an
      // unproven 'committed' to 'proposed' on this very write. A returned row is therefore
      // NOT proof of an upgrade: only `authority === 'committed'` is. Counting it anyway
      // reported a settlement and fired `work-item:settled:<id>` for a row the floor had
      // rejected, again on every rotation. Track it instead, so it is visible.
      if (canCommit && result[0] && result[0].authority !== 'committed') {
        floorRejectedByIndex[index] = result[0].feature_id;
      }
      // WI-10004711: tell the closer ONCE, on the transition into stranded. The prior
      // residue is this same generation's stored manifest, so a later pass that re-derives
      // the same stranded set stays silent, and a re-sent close (new generation, no stored
      // residue) starts clean. A missed CAS (result empty) is someone else's write: silent.
      const priorStranded = new Set(
        (parsed.data.residualPaths ?? [])
          .filter((entry) => entry.reason === 'superseded-before-commit' &&
            (entry.repositoryRoot ?? parsed.data.repositoryRoot) === scope.repositoryRoot)
          .map((entry) => checkoutPathKey(
            entry.repositoryRoot ?? parsed.data.repositoryRoot,
            entry.headSha ?? parsed.data.headSha,
            entry.path,
          )),
      );
      const newlyStranded = currentRootResiduals
        .filter((entry) => entry.reason === 'superseded-before-commit' &&
          !priorStranded.has(checkoutPathKey(entry.repositoryRoot, entry.headSha, entry.path)))
        .map((entry) => entry.path);
      if (result[0] && newlyStranded.length > 0) {
        strandedByIndex[index] = result[0].feature_id;
        try {
          await notifyStranded?.({
            workItemId: result[0].feature_id,
            harness: row.harness_slug,
            workspaceId: scope.workspaceId,
            terminalOwner: row.terminal_owner ?? null,
            strandedPaths: currentRootResiduals
              .filter((entry) => entry.reason === 'superseded-before-commit')
              .map((entry) => entry.path),
            commitSha,
            generation: parsed.data.generation,
          });
        } catch (error) {
          console.warn(
            `[git-sync-completion-settlement] ${scope.installSlug}: could not notify the closer of stranded ` +
              `${result[0].feature_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (canCommit && result[0] && result[0].authority === 'committed') {
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
        try {
          await onSettled?.({ id, harness: row.harness_slug, authority: 'committed' });
        } catch (error) {
          console.warn(
            `[git-sync-completion-settlement] ${scope.installSlug}: could not accept the completion verification ` +
              `task of settled ${id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
  const floorRejected = floorRejectedByIndex.filter((id): id is string => id !== undefined);
  const stranded = strandedByIndex.filter((id): id is string => id !== undefined);
  const lookupUnavailable = lookupUnavailableByIndex.filter((id): id is string => id !== undefined);
  const residualCount = residualByIndex.reduce((sum, count) => sum + count, 0);
  if (batchUnavailable) {
    // Every row then did its own read: correct, but it is the per-row fork cost
    // WI-10005285 removed, so it must not happen silently.
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: the batched exact-tree read at ` +
        `${commitSha.slice(0, 12)} measured nothing; ${rows.length} candidate(s) fell back to one git read each`,
    );
  }
  if (stranded.length > 0) {
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${stranded.length} of ${rows.length} ` +
        'proposed completion(s) became unsettleable by waiting (a declared path was edited again before ' +
        'any commit captured the close-time blob); their closers were told to re-send: ' +
        `${stranded.slice(0, 10).join(', ')}${stranded.length > 10 ? ` (+${stranded.length - 10} more)` : ''}`,
    );
  }
  if (floorRejected.length > 0) {
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${floorRejected.length} of ${rows.length} ` +
        'proposed completion(s) proved settled by the reconciler but were kept proposed by the ' +
        'completion authority floor (migration 1207); the TS proof and the SQL floor disagree for: ' +
        `${floorRejected.slice(0, 10).join(', ')}${floorRejected.length > 10 ? ` (+${floorRejected.length - 10} more)` : ''}`,
    );
  }
  if (unreadable.length > 0) {
    // Named ids, not just a count: the whole point is that someone can go LOOK at one.
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${unreadable.length} of ${rows.length} ` +
        'proposed completion(s) carry a settlementManifest this pass could not read; they were skipped ' +
        'and stay unsettled, counted as neither settled nor residual: ' +
        `${unreadable.slice(0, 10).join(', ')}${unreadable.length > 10 ? ` (+${unreadable.length - 10} more)` : ''}`,
    );
  }
  if (lookupUnavailable.length > 0) {
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${lookupUnavailable.length} of ${rows.length} ` +
        `proposed completion(s) were skipped because a git read at ${commitSha.slice(0, 12)} measured nothing ` +
        '(the exact-tree lookup returned nothing, or a per-path history read timed out); ' +
        'nothing was written and the next fire retries them: ' +
        `${lookupUnavailable.slice(0, 10).join(', ')}${lookupUnavailable.length > 10 ? ` (+${lookupUnavailable.length - 10} more)` : ''}`,
    );
  }
  return { inspected: rows.length, upgraded, residual: residualCount, unreadable, floorRejected, stranded, lookupUnavailable };
}

/**
 * WI-10004400: how many proposed candidates for this checkout have NEVER been attempted —
 * the tier `reconcileProposedCompletionsAtCommit` orders first (its manifest carries no
 * `residualPaths` array). Same scope predicate as the candidate SELECT above, deliberately
 * uncapped by MAX_CANDIDATES: the standing guard needs the true waiting population, and a
 * count of the capped batch would read 200 forever and hide a starved tail. Measurable even
 * when the pass itself was cut short by its budget, which is exactly when it is needed.
 */
export async function countNeverAttemptedCandidates(
  scope: { workspaceId: string; repositoryRoot: string },
  deps: {
    sql?: ReturnType<typeof getOrgPg>['sql'];
    /**
     * EI-24758680272435881: count only rows last written BEFORE this instant — the fire's
     * start. Without it the count included closes that landed mid-pass, after the candidate
     * SELECT, so under steady close traffic the population never read zero and the
     * consecutive-fires streak grew forever (measured 2026-10-01: a fully healthy pass that
     * wrote its first row still recorded `failing`, remaining 1, streak 32, because two
     * fresh closes arrived during it). Omitted = no cutoff (an all-time census).
     */
    eligibleBeforeMs?: number;
  } = {},
): Promise<number> {
  const sql = deps.sql ?? getOrgPg().sql;
  // One parameterized predicate either way (no conditional fragment): the "no cutoff" case
  // binds a ceiling no millisecond timestamp reaches.
  const eligibleBeforeMs = deps.eligibleBeforeMs ?? Number.MAX_SAFE_INTEGER;
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND authority = 'proposed'
       AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest']}::text[] IS NOT NULL
       AND (
         payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'contentIdentity']}::text[]) = 'array'
                   THEN payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'contentIdentity']}::text[]
                 ELSE '[]'::jsonb
               END
             ) AS settlement_identity(value)
            WHERE COALESCE(NULLIF(settlement_identity.value->>'repositoryRoot', ''),
                           payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[]) = ${scope.repositoryRoot}
         )
       )
       AND jsonb_typeof(payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'residualPaths']}::text[]) IS DISTINCT FROM 'array'
       AND updated_ts < ${eligibleBeforeMs}`;
  return Number(rows[0]?.n ?? 0);
}
