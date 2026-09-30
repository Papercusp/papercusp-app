/**
 * pot-git/foreign-publish.ts — P-109 leg (iii): the PUBLISH wiring from a
 * foreign workspace clone into the RESULTS CHANNEL, and the canonical-side
 * IMPORT (p2p-work-distribution-2026-07-02; ratified D-017/D-018 — option
 * (b), per-scope bare repos; Q6 FINAL).
 *
 * PUBLISH (executor host side):
 *   foreign clone ──(quarantine fetch + RC-2 admission: caps/secrets/P-110
 *   identity, all in foreign-mirror-quarantine.ts)──▶ the LOCAL per-scope
 *   bare repo (FS-D3) at `scopeForeignRef(scope, name)` — the RC-4 in-repo
 *   marker — then the executor signs SCOPE sigrefs carrying the C8
 *   `originClaim` (signed AS EXECUTOR, naming the author it did NOT author;
 *   confined to scope repos per D-017 n2), and an RC-1 completion receipt
 *   points at {scope_id, ref, commit_oid, execution_epoch, offer_id}.
 *   Refusals produce the RC-1 refusal receipt — coord NEVER carries
 *   artifacts, receipts carry pointers (X3).
 *
 * IMPORT (origin/canonical side):
 *   the canonical repo fetches the result ref from the (local or federated)
 *   scope repo under the SAME `refs/foreign/<segment>/<name>` name — a LOCAL
 *   TRACKING REF in the foreign-marked family, so the landed P-110
 *   `isForeignMarkedRef` contract holds unchanged — then judges it with
 *   `admitForeignMergeHead` (the X2 invariant call site: ANY merge of a
 *   foreign-marked ref into canonical staging goes through the gate). A
 *   refused import DELETES the tracking ref (no poisoned marked ref lingers;
 *   the quarantined objects are unreferenced and gc-able).
 *
 * The commit lane (leg ii) writes the clone; this module moves results OUT.
 * The foreign session itself pushes nowhere and dials nothing (X1).
 */
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  admitForeignMergeHead,
  type ForeignAdmissionResult,
} from './foreign-merge-admission';
import {
  quarantineFetchAndJudge,
  type QuarantineCaps,
  type QuarantineFetchResult,
} from './foreign-mirror-quarantine';
import { receiptFromQuarantine, type ResultsReceipt } from './results-receipt';
import { ensureScopeRepo, scopeForeignRef, type ScopeId } from './scope-repo';
import { buildScopeSigrefs, type SigrefOriginClaim, type SignedSigrefs } from './sigrefs';
import { defaultRunGit, type RunGit } from './storage';

export interface PublishForeignResultInput {
  potHomeSlug: string;
  scope: ScopeId;
  /** The foreign workspace clone (leg-iv provision output). */
  foreignClonePath: string;
  /** Branch in the clone carrying the deliverable (usually its default). */
  sourceBranch: string;
  /** Result name → `refs/foreign/<segment>/<name>` (e.g. the offer id). */
  resultName: string;
  /** The offer's attested origin chain (numeric gh user ids, X9). */
  originGithubUserIds: number[];
  offerId: string;
  /** H9 fencing epoch the executor ran under. */
  executionEpoch: number;
  /**
   * Range anchors: ALREADY-ADMITTED canonical shas only — typically the
   * workspace's provision base (p2p_foreign_workspaces.base_sha, mig 470).
   * Excludes canonical history from the admission judgment so only the
   * FOREIGN-introduced range is judged. Omit/empty = full-history judgment.
   */
  rangeAnchorShas?: string[];
  /** Executor device signing identity — omit BOTH to skip the sigref step
   *  (e.g. a host without hive keys; the receipt still points at the ref). */
  executorDevicePubkeyBase64?: string;
  sign?: (bytes: Buffer) => Promise<Buffer>;
  /** Injected clock (receipts stamp once; tests are deterministic). */
  nowMs: number;
  caps?: QuarantineCaps;
  quarantineDir?: string;
  runGit?: RunGit;
  resolveGithubUserId?: (email: string) => Promise<number | null>;
}

export interface PublishForeignResultOutcome {
  admitted: boolean;
  /** The scope repo the result published into (created on demand). */
  scopeRepoPath: string;
  /** The foreign-marked ref name (present on refusals too — the receipt names it). */
  foreignRef: string;
  /** Admitted head sha (null on refusal). */
  head: string | null;
  /** The RC-1 receipt (completion or refusal) — the coord-plane payload. */
  receipt: ResultsReceipt;
  /** The executor's scope sigrefs snapshot (null when refused or unsigned). */
  sigrefs: SignedSigrefs | null;
  /** The raw admission verdict for audit/trace (M21). */
  quarantine: QuarantineFetchResult;
}

/**
 * Publish one foreign deliverable into the per-scope repo. Fail-closed: any
 * quarantine refusal (caps / secrets / identity / mechanical) publishes
 * NOTHING and returns the loud refusal receipt.
 */
export async function publishForeignResult(
  input: PublishForeignResultInput,
): Promise<PublishForeignResultOutcome> {
  const runGit = input.runGit ?? defaultRunGit;
  const scopeRepoPath = await ensureScopeRepo(input.potHomeSlug, input.scope);
  const foreignRef = scopeForeignRef(input.scope, input.resultName);

  // Prior publish of this result name = the admission range anchor (only the
  // NEW range is judged; same rule as canonical staging in the gate).
  const prior = await runGit(['rev-parse', '--verify', '--quiet', foreignRef], scopeRepoPath);
  const targetTip = prior.code === 0 ? prior.stdout.trim() : null;

  const quarantine = await quarantineFetchAndJudge({
    targetRepoPath: scopeRepoPath,
    foreignClonePath: input.foreignClonePath,
    sourceBranch: input.sourceBranch,
    foreignRef,
    targetTip,
    rangeAnchors: input.rangeAnchorShas,
    originGithubUserIds: input.originGithubUserIds,
    offerId: input.offerId,
    caps: input.caps,
    quarantineDir: input.quarantineDir,
    runGit,
    resolveGithubUserId: input.resolveGithubUserId,
  });

  const receipt = receiptFromQuarantine(quarantine, {
    scope: input.scope,
    executionEpoch: input.executionEpoch,
    offerId: input.offerId,
    nowMs: input.nowMs,
  });

  if (!quarantine.admit || !quarantine.head || !quarantine.quarantinePath) {
    return {
      admitted: false,
      scopeRepoPath,
      foreignRef,
      head: null,
      receipt,
      sigrefs: null,
      quarantine,
    };
  }

  try {
    // Move the admitted objects out of quarantine into the scope repo and
    // point the foreign-marked ref at the head. Fetching FROM the quarantine
    // transfers exactly the new pack (the quarantine alternates on the scope
    // repo's ODB, so shared history never re-transfers).
    const fetch = await runGit(
      ['fetch', '-q', '--no-tags', quarantine.quarantinePath, `+refs/quarantine/head:${foreignRef}`],
      scopeRepoPath,
    );
    if (fetch.code !== 0) {
      throw new Error(`publish fetch into scope repo failed: ${fetch.stderr.trim()}`);
    }
  } finally {
    // The quarantine did its job either way.
    await rm(dirname(quarantine.quarantinePath), { recursive: true, force: true }).catch(() => {});
  }

  // C8/RC-3: the executor signs the scope's result refs AS EXECUTOR with the
  // origin claim attached (confined to scope-repo sigrefs — D-017 n2).
  let sigrefs: SignedSigrefs | null = null;
  if (input.executorDevicePubkeyBase64 && input.sign) {
    const claims = new Map<string, SigrefOriginClaim>([
      [
        foreignRef,
        {
          offer_id: input.offerId,
          origin_github_user_id: input.originGithubUserIds[0],
          execution_epoch: input.executionEpoch,
        },
      ],
    ]);
    sigrefs = await buildScopeSigrefs(scopeRepoPath, input.executorDevicePubkeyBase64, input.sign, {
      nowMs: input.nowMs,
      claims,
      runGit,
    });
  }

  return {
    admitted: true,
    scopeRepoPath,
    foreignRef,
    head: quarantine.head,
    receipt,
    sigrefs,
    quarantine,
  };
}

export interface ImportForeignResultInput {
  /** The canonical repo (holds the staging line the merge would land on). */
  canonicalRepoPath: string;
  /** The scope repo holding the published result (local path or URL). */
  scopeRepoPath: string;
  scope: ScopeId;
  resultName: string;
  /** The canonical staging ref (default `refs/heads/staging`). */
  stagingRef?: string;
  /** The offer's attested origin chain — the SAME chain the publish judged;
   *  the import re-judges independently (never trust the wire). */
  originGithubUserIds: number[];
  offerId: string;
  runGit?: RunGit;
  resolveGithubUserId?: (email: string) => Promise<number | null>;
}

export interface ImportForeignResultOutcome {
  admitted: boolean;
  /** The LOCAL TRACKING REF in the canonical repo (RC-4 marker family). */
  trackingRef: string;
  /** The imported head (null when the fetch itself failed). */
  head: string | null;
  /** The P-110 gate verdict (null when the fetch failed before judging). */
  admission: ForeignAdmissionResult | null;
  error: string | null;
}

/**
 * Import one published result into the canonical repo under its
 * `refs/foreign/<segment>/<name>` local tracking ref and judge it with the
 * P-110 gate. THE X2 INVARIANT: the merge lane may integrate ONLY a head this
 * function returned `admitted: true` for. A refused import deletes the
 * tracking ref.
 */
export async function importForeignResultToCanonical(
  input: ImportForeignResultInput,
): Promise<ImportForeignResultOutcome> {
  const runGit = input.runGit ?? defaultRunGit;
  const trackingRef = scopeForeignRef(input.scope, input.resultName);

  const fetch = await runGit(
    ['fetch', '-q', '--no-tags', input.scopeRepoPath, `+${trackingRef}:${trackingRef}`],
    input.canonicalRepoPath,
  );
  if (fetch.code !== 0) {
    return {
      admitted: false,
      trackingRef,
      head: null,
      admission: null,
      error: `import fetch failed: ${fetch.stderr.trim()}`,
    };
  }
  const headR = await runGit(['rev-parse', '--verify', '--quiet', trackingRef], input.canonicalRepoPath);
  if (headR.code !== 0) {
    return { admitted: false, trackingRef, head: null, admission: null, error: 'imported ref unresolvable' };
  }
  const head = headR.stdout.trim();

  const stagingRef = input.stagingRef ?? 'refs/heads/staging';
  const stagingR = await runGit(['rev-parse', '--verify', '--quiet', stagingRef], input.canonicalRepoPath);
  const stagingHead = stagingR.code === 0 ? stagingR.stdout.trim() : null;

  const admission = await admitForeignMergeHead({
    repoPath: input.canonicalRepoPath,
    foreignRef: trackingRef,
    head,
    stagingHead,
    originGithubUserIds: input.originGithubUserIds,
    offerId: input.offerId,
    runGit,
    resolveGithubUserId: input.resolveGithubUserId,
  });

  if (!admission.admit) {
    // No poisoned marked ref lingers; the objects become unreferenced.
    await runGit(['update-ref', '-d', trackingRef], input.canonicalRepoPath);
    return { admitted: false, trackingRef, head, admission, error: null };
  }
  return { admitted: true, trackingRef, head, admission, error: null };
}
