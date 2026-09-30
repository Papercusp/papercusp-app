/**
 * sweep-after-sync — the git-sync-tick → doc-freshness-sweep bridge (P-003/D-004).
 *
 * After a harness repo syncs (git-sync `synced`), the paths that moved between the
 * pre-sync HEAD and the new HEAD are exactly the commit's changed paths. We diff
 * them, intersect with each doc's denormalised anchor_paths (the reverse index),
 * and flip the matched docs' freshness — enqueuing a documenter regeneration for
 * stale generated docs and flagging a re-verify for stale manual docs.
 *
 * Fully best-effort: any failure here is swallowed (it must never wedge git-sync),
 * lazily imported by the action so it adds nothing to the hot path until a sync
 * actually completes.
 */

import { projectDirForSlug } from '../../operator-notes';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { relative } from 'node:path';
import { runGit, repoHeadSha, repoChangedPathPairs, listSubmodulePaths } from './git-runner';
import { makeFeatureCommitLookup } from './feature-commits';
import { sweepHarnessDocs, recomputeDocStatus, type SweepResult } from './freshness-sweep';
import { deleteDocRecord, listDocRecords, setDocStatus, markRegenEnqueued, markReverifyFlagged } from './doc-record';
import { resolveHarnessDocPaths } from './harness-repo';
import { readDocBody } from './doc-fs';
import { anchorManualDoc } from './manual-anchor';
import { dispatchDocStewardForDrift, type DriftedDoc } from './doc-steward-dispatch';
import {
  buildOkfExpiryDigest,
  claimDailyExpiryScan,
  scanExpiredDocs,
  type OkfExpiryScan,
} from './okf-expiry';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';
import { trackDetached } from '../../detached-imports';
import { SYNC_TRIGGERED_SCHEDULES } from '../../schedule-descriptors.mjs';

/** Stable inventory identity for the deterministic post-git-sync detection writer. */
const DOC_FRESHNESS_SWEEP_NAME = SYNC_TRIGGERED_SCHEDULES.docFreshnessSweep.name;

const DOCS_IDENTITY: AgentIdentity = {
  ownerId: 'system:doc-freshness',
  ownerLabel: 'doc-freshness',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Cap on how many doc ids the digest names inline (the rest fold into "+N more"). */
export const DOC_DRIFT_DIGEST_MAX_NAMED = 8;

/**
 * Coalesce a sweep's drifted docs into ONE digest line (EI-2826). The sweep used to
 * broadcast ONE coord message per drifted doc to `*`; a single substantive commit could
 * fire 50+ in seconds, BURYING directed peer messages in every agent's inbox (the channel
 * became unusable as a directed-message bus during any large change). One digest per sweep
 * preserves the signal (it names the drifted docs + the regen/re-verify split) without the
 * flood. Returns null when nothing drifted (→ send nothing).
 */
export function buildDocDriftDigest(harnessSlug: string, staleDocs: DriftedDoc[]): string | null {
  if (staleDocs.length === 0) return null;
  // classifyDrift routes manual→'review'→re-verify and generated/augmented→'stale'→regen,
  // so `source === 'manual'` is exactly the re-verify set; everything else is regen-enqueued.
  const reverify = staleDocs.filter((d) => d.source === 'manual').length;
  const regen = staleDocs.length - reverify;
  const parts: string[] = [];
  if (reverify > 0) parts.push(`${reverify} manual need RE-VERIFY`);
  if (regen > 0) parts.push(`${regen} generated STALE → regen enqueued`);
  const named = staleDocs.slice(0, DOC_DRIFT_DIGEST_MAX_NAMED).map((d) => d.docId).join(', ');
  const more = staleDocs.length > DOC_DRIFT_DIGEST_MAX_NAMED ? ` (+${staleDocs.length - DOC_DRIFT_DIGEST_MAX_NAMED} more)` : '';
  return `📄 ${harnessSlug}: ${staleDocs.length} doc(s) drifted after this sync — ${parts.join(', ')}: ${named}${more}`;
}

/** Read a harness repo's current HEAD sha (captured pre-sync to bound the diff). */
export async function captureHeadSha(
  harnessSlug: string,
  workspaceId?: string,
  repoRootOverride?: string | null,
): Promise<string | null> {
  const repoRoot = repoRootOverride === undefined
    ? await projectDirForSlug(harnessSlug, workspaceId)
    : repoRootOverride;
  if (!repoRoot) return null;
  return repoHeadSha(repoRoot);
}

/**
 * P-005 — the OKF `stale_after` leg of freshness, run alongside (never inside) the
 * git-anchor sweep. Returns the scan when one actually ran, or null when the daily
 * gate skipped it / the harness has no resolvable docs tree.
 *
 * Exported for the test that proves an EXPIRED doc produces a digest, using a
 * synthetic past date in a temp tree — never a corpus value (plan D-002).
 */
export async function runOkfExpirySweep(
  harnessSlug: string,
  now: Date = new Date(),
): Promise<OkfExpiryScan | null> {
  if (!claimDailyExpiryScan(harnessSlug, now)) return null;
  const paths = await resolveHarnessDocPaths(harnessSlug);
  if (!paths) return null;
  const scan = await scanExpiredDocs(paths.docsRoot, now);
  const digest = buildOkfExpiryDigest(harnessSlug, scan);
  if (digest) {
    await sendMessage(DOCS_IDENTITY, { to: ['*'], summary: digest, category: 'doc-drift' }).catch(() => {});
  }
  return scan;
}

export interface SweepAfterSyncInput {
  harnessSlug: string;
  workspaceId: string;
  /** Exact tree the sync ran against; null means the scoped lookup found none. */
  repoRoot?: string | null;
  /** HEAD before the sync (omit/blank → recompute all anchored docs). */
  prevSha?: string;
  /** HEAD after the sync. */
  headSha?: string;
}

type DocFreshnessSweepRunner = (input: SweepAfterSyncInput) => Promise<SweepResult | null>;

interface DocFreshnessSweepQueueState {
  current: SweepAfterSyncInput;
  pending: SweepAfterSyncInput | null;
  run: DocFreshnessSweepRunner;
}

/**
 * Per-process, per-harness single-flight for the post-sync corpus sweep.
 *
 * The sweep is intentionally advisory, but a large tracked corpus can take minutes:
 * every candidate recomputes its Git baseline and persists its result sequentially.
 * Awaiting it inside `git-sync:record` used to hold GitHub/P2P publication behind
 * unrelated documentation work. Detach it from the git action while keeping at most
 * one sweep live per harness; later syncs coalesce into one follow-up range instead of
 * piling up overlapping 983-row corpus scans.
 */
const queuedDocFreshnessSweeps = new Map<string, DocFreshnessSweepQueueState>();

function queueKey(input: SweepAfterSyncInput): string {
  // Include the descriptor identity in the single-flight key so this writer's
  // runtime queue cannot silently detach from schedule:inventory.
  return `${DOC_FRESHNESS_SWEEP_NAME}\u0000${input.workspaceId}\u0000${input.harnessSlug}`;
}

/** Preserve every not-yet-swept commit when several syncs arrive during one run. */
function coalesceQueuedSweep(
  prior: SweepAfterSyncInput | null,
  next: SweepAfterSyncInput,
  current: SweepAfterSyncInput,
): SweepAfterSyncInput {
  if (!prior) {
    const followsCurrent =
      current.repoRoot === next.repoRoot &&
      Boolean(current.headSha) &&
      current.headSha === next.prevSha;
    return { ...next, prevSha: followsCurrent ? next.prevSha : undefined };
  }
  const contiguous =
    prior.repoRoot === next.repoRoot &&
    Boolean(prior.prevSha) &&
    Boolean(prior.headSha) &&
    prior.headSha === next.prevSha;
  return {
    ...next,
    // A discontinuity cannot safely drop either diff. Omitting prevSha makes the
    // existing sweep recompute all anchored docs, the conservative/idempotent fallback.
    prevSha: contiguous ? prior.prevSha : undefined,
  };
}

export interface EnqueueDocFreshnessSweepDeps {
  /** Test seam; production reuses the existing sweep implementation. */
  run?: DocFreshnessSweepRunner;
}

/**
 * Queue the post-sync docs sweep without making git publication wait for it.
 * Returns synchronously; tracked detached work is drained by the Vitest harness.
 */
export function enqueueDocFreshnessSweepAfterSync(
  input: SweepAfterSyncInput,
  deps: EnqueueDocFreshnessSweepDeps = {},
): void {
  const key = queueKey(input);
  const existing = queuedDocFreshnessSweeps.get(key);
  if (existing) {
    existing.pending = coalesceQueuedSweep(existing.pending, input, existing.current);
    return;
  }

  const state: DocFreshnessSweepQueueState = {
    current: input,
    pending: null,
    run: deps.run ?? runDocFreshnessSweepAfterSync,
  };
  queuedDocFreshnessSweeps.set(key, state);

  const drain = async (): Promise<void> => {
    let current: SweepAfterSyncInput | null = input;
    try {
      while (current) {
        state.current = current;
        try {
          await state.run(current);
        } catch (error) {
          console.warn(
            `[doc-freshness] ${current.harnessSlug}: post-sync sweep failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        current = state.pending;
        state.pending = null;
      }
    } finally {
      queuedDocFreshnessSweeps.delete(key);
    }
  };

  // Start on the next microtask so even a runner with substantial synchronous setup
  // cannot leak latency back into the git-sync action that only enqueues it.
  void trackDetached(Promise.resolve().then(drain)).catch(() => {});
}

/**
 * Run the freshness sweep for a harness after a git-sync. Returns the sweep
 * result (or null when there were no doc records / nothing to do).
 */
export async function runDocFreshnessSweepAfterSync(input: SweepAfterSyncInput): Promise<SweepResult | null> {
  const { harnessSlug } = input;
  // A harness's docs live in its workspace — derive it (never a silent 'default'). This
  // whole sweep is best-effort (the caller swallows any throw), so a derive failure for an
  // unregistered harness degrades to "no sweep", never a silent cross-workspace read (D-003).
  const workspaceId = await resolveWorkspaceForHarness(harnessSlug, input.workspaceId);

  const repoRoot = input.repoRoot === undefined
    ? await projectDirForSlug(harnessSlug, workspaceId)
    : input.repoRoot;
  if (!repoRoot) return null;

  // P-005 (okf-frontmatter-adoption): the TIME-based freshness leg. Runs BEFORE every
  // early return below on purpose — an OKF `stale_after` expires on a day when nothing
  // changed and no doc record exists, which is precisely what the git-anchored sweep
  // (diff-driven, records-driven) cannot see. Gated to once per UTC day per harness
  // because the field is date-granular, and fully best-effort.
  await runOkfExpirySweep(harnessSlug).catch(() => {});

  // Submodule roots, so the drift checker routes a submodule anchor's `git log` into
  // the submodule against its own baseline (#3) instead of a superproject log that
  // can't see inside it (silent rot). Best-effort; [] = superproject-only behavior.
  const submodulePaths = await listSubmodulePaths(repoRoot).catch(() => [] as string[]);

  // Derive the changed paths for the prefilter AND the self-bootstrap. prevSha==headSha
  // → nothing moved.
  let changedPaths: string[] | undefined;
  let changedPathPairs: Awaited<ReturnType<typeof repoChangedPathPairs>> = null;
  const prev = (input.prevSha ?? '').trim();
  const head = (input.headSha ?? '').trim();
  if (prev && head) {
    if (prev === head) return null;
    changedPathPairs = await repoChangedPathPairs(repoRoot, prev, head);
    if (changedPathPairs) {
      if (changedPathPairs.length === 0) return null;
      // Keep the existing prefilter semantics: a rename contributes its new path.
      changedPaths = changedPathPairs.map((change) => change.path);
    }
  }

  const records = await listDocRecords(harnessSlug, workspaceId);

  // Self-bootstrap (owner 2026-06-22): once a harness is doc-tracked (≥1 record — e.g.
  // from the harness:create seed), a doc TOUCHED in this commit that has no record yet
  // is registered NOW — so tracking grows page-by-page with zero `harness_docs:record`
  // ceremony. Reuses anchorManualDoc (deterministic, no LLM — D-006). Bounded to the
  // commit's changed doc-paths (cheap). A never-tracked / opted-out harness keeps 0
  // records, so the bail below holds and the sweep never auto-starts it.
  if (records.size > 0 && changedPaths?.length) {
    try {
      const paths = await resolveHarnessDocPaths(harnessSlug);
      if (paths) {
        const docsRel = relative(paths.repoRoot, paths.docsRoot);
        const prefix = docsRel && docsRel !== '.' ? docsRel.replace(/\/?$/, '/') : '';
        const docIdForRepoPath = (repoPath: string): string | null => {
          if (!/\.(md|mdx)$/i.test(repoPath)) return null;
          if (prefix && !repoPath.startsWith(prefix)) return null;
          const docId = prefix ? repoPath.slice(prefix.length) : repoPath;
          return docId || null;
        };

        // A rename is different from a delete + unrelated add: Git gives us both paths,
        // so retire only the old tracking row for a move. Otherwise the self-bootstrap
        // below correctly creates the new archive/ doc but leaves the old doc_id forever.
        for (const change of changedPathPairs ?? []) {
          if (!change.previousPath) continue;
          const oldDocId = docIdForRepoPath(change.previousPath);
          const newDocId = docIdForRepoPath(change.path);
          if (!oldDocId || !newDocId || oldDocId === newDocId || !records.has(oldDocId)) continue;
          if (await readDocBody(paths.docsRoot, newDocId) === null) continue;
          await deleteDocRecord(harnessSlug, oldDocId, workspaceId);
          records.delete(oldDocId);
        }

        const reanchorDeps = {
          runGit,
          repoRoot,
          resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, workspaceId),
          submodulePaths,
        };
        for (const p of changedPaths) {
          if (!/\.(md|mdx)$/i.test(p)) continue;
          if (prefix && !p.startsWith(prefix)) continue;
          const docId = prefix ? p.slice(prefix.length) : p;
          if (!docId) continue;
          if (!records.has(docId)) {
            // NEW doc → register + set the verify baseline (page-by-page tracking growth).
            const res = await anchorManualDoc({ harnessSlug, docId, verify: true, workspaceId });
            if (res.ok) records.set(docId, res.record);
            continue;
          }
          // TRACKED doc whose FILE changed this commit → its `documents:` frontmatter may
          // have changed, so RE-DERIVE its anchors — the cache must never drift from the
          // frontmatter (docs-audit #2; before this, anchors were only derived on the FIRST
          // bootstrap, so a later `documents:` edit silently left a stale anchor cache and
          // the sweep matched the wrong paths). anchorManualDoc (no verify) re-parses the
          // frontmatter and upserts subject_ref/anchor_paths; the upsert COALESCEs
          // last_verified_sha (baseline preserved). We then recompute status from the FRESH
          // anchors so a pure-frontmatter edit doesn't stick at the transient 'review'
          // anchorManualDoc writes for an un-verified anchor.
          const res = await anchorManualDoc({ harnessSlug, docId, workspaceId });
          if (res.ok) {
            const { status, detail } = await recomputeDocStatus(res.record, reanchorDeps);
            await setDocStatus(harnessSlug, docId, status, detail, workspaceId);
            records.set(docId, { ...res.record, status, statusDetail: detail });
          }
        }
      }
    } catch {
      // best-effort: a self-bootstrap failure must never wedge the sweep / git-sync.
    }
  }

  // A harness with no doc records (and none newly registered) can't have any drift.
  if (records.size === 0) return null;

  // Every retry-DUE drifted doc this sweep — new drift PLUS unhealed docs the retry clock
  // re-fires (~30min backoff; freshness-sweep touchRegen/touchReverify). This is the batch
  // the doc-steward (P-008) retries against.
  const staleDocs: DriftedDoc[] = [];
  // WI-2007: docs that NEWLY transitioned into drift THIS sweep (fresh→review/stale) — a
  // strict subset of staleDocs sharing the SAME object refs (so the attribution enrichment
  // below mutates both). The '*' broadcast is EDGE-TRIGGERED off this, so a still-unhealed
  // doc is announced once, not re-broadcast to every agent every 30min forever.
  const newlyDrifted: DriftedDoc[] = [];

  const result = await sweepHarnessDocs({
    harnessSlug,
    workspaceId,
    repoRoot,
    runGit,
    changedPaths,
    submodulePaths,
    resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, workspaceId),
    // EI-2826/WI-2007: collect every retry-due doc into staleDocs (drives the doc-steward),
    // and the NEWLY-transitioned subset into newlyDrifted (drives the edge-triggered '*'
    // broadcast below). Same object ref in both so attribution enrichment applies once.
    onRegenNeeded: (doc, detail, becameDrifted) => {
      const d: DriftedDoc = { docId: doc.docId, anchorPaths: doc.anchorPaths, reason: detail ?? 'subject code changed', source: doc.source };
      staleDocs.push(d);
      if (becameDrifted) newlyDrifted.push(d);
    },
    onReverifyNeeded: (doc, detail, becameDrifted) => {
      const d: DriftedDoc = { docId: doc.docId, anchorPaths: doc.anchorPaths, reason: detail ?? 'subject code changed', source: doc.source };
      staleDocs.push(d);
      if (becameDrifted) newlyDrifted.push(d);
    },
  });

  // P-005 (doc-drift attribution): enrich each drifted doc with the work-item(s) that recently
  // changed its anchored code (from git_sync_commit_attribution) so the doc-steward knows WHY the
  // code drifted (D-006: derived, no extra agent call). Deterministic + best-effort; ONE query.
  if (staleDocs.length > 0) {
    try {
      const { lookupDriftCauseWorkItems } = await import('../../edit-attribution');
      const causes = await lookupDriftCauseWorkItems(
        [...new Set(staleDocs.flatMap((d) => d.anchorPaths))],
        { harnessSlug },
      );
      if (causes.size > 0) {
        for (const d of staleDocs) {
          const wis = [...new Set(d.anchorPaths.flatMap((f) => causes.get(f) ?? []))];
          if (wis.length > 0) d.workItems = wis;
        }
      }
    } catch {
      /* best-effort: attribution enrichment must never break the sweep */
    }
  }

  // EI-2826 + WI-2007: ONE coalesced doc-drift broadcast per sweep, EDGE-TRIGGERED — it names
  // only docs that NEWLY drifted this sweep (fresh→review/stale), never the standing backlog.
  // The retry clock re-fires an UNHEALED doc's callback every ~30min so the doc-steward keeps
  // retrying, but attempts only bump on a CONFIRMED steward dispatch (WI-1661) — so with no/busy
  // steward the backoff stays at 30min forever and the doc would otherwise re-broadcast to EVERY
  // agent every 30min indefinitely (the 3686-msg flood that buried directed messages). Agents see
  // a new drift once; the standing set stays discoverable via harness_docs:list. Sent AFTER
  // attribution enrichment (shared refs). Best-effort — a send failure must never break the sweep.
  const digest = buildDocDriftDigest(harnessSlug, newlyDrifted);
  if (digest) {
    await sendMessage(DOCS_IDENTITY, { to: ['*'], summary: digest, category: 'doc-drift' }).catch(() => {});
  }

  // P-008 doc-steward — dispatch the LLM consumer to FIX the newly-drifted docs against the
  // current code (the deterministic counterpart to detection). Best-effort + flag-gated.
  // WI-2104: the dispatcher CAPS the batch to what one steward can finish inside its spawn
  // budget, so order the most-deserving docs first — NEWLY-drifted (0 attempts, most likely
  // healable) ahead of retry re-offers. `newlyDrifted` shares object refs with `staleDocs`,
  // so a Set dedups the concatenation.
  const ordered = [...new Set([...newlyDrifted, ...staleDocs])];
  const dispatched = await dispatchDocStewardForDrift(harnessSlug, workspaceId, ordered);

  // WI-1661: spend each dispatched doc's retry attempt HERE — only once a doc-steward is
  // CONFIRMED to have actually launched for this batch — never inside sweepHarnessDocs
  // itself (which only touches the retry-CLOCK, so a skipped dispatch — flag off, an
  // exception, or the dispatcher's active/cooldown gate — no longer silently burns an
  // attempt toward the 5-attempt give-up cap with zero agent turns ever spent on the doc).
  // WI-2104: charge ONLY the docs actually IN the dispatched batch — a doc sliced out by
  // the batch cap was never handed to a steward, so it keeps its attempts and re-offers on
  // its retry clock. (Before this, a 40-doc batch charged all 40 while the steward timed
  // out after ~6 — the give-up cap filled with docs no agent ever read.)
  for (const d of dispatched) {
    if (d.source === 'manual') {
      await markReverifyFlagged(harnessSlug, d.docId, workspaceId).catch(() => {});
    } else {
      await markRegenEnqueued(harnessSlug, d.docId, workspaceId).catch(() => {});
    }
  }

  return result;
}

export interface ReconcileAnchorsResult {
  /** Anchor-derived docs examined (manual/augmented records). */
  scanned: number;
  /** Docs whose denormalised anchor cache DIFFERED from the freshly-derived frontmatter anchors
   *  (the stale-cache the re-anchor-on-change path missed) and was rewritten. */
  reconciled: number;
  /** Re-anchor failures (a doc whose harness/doc paths couldn't be resolved). */
  failed: number;
}

/**
 * PERIODIC FULL doc-anchor RECONCILE (#5 PART B) — the safety net for the re-anchor-on-change path.
 *
 * `runDocFreshnessSweepAfterSync` re-derives a doc's anchors ONLY when its FILE changed in a git-sync
 * tick (the self-bootstrap loop above). That misses a stale anchor cache that slipped past
 * re-anchor-on-change — e.g. a `documents:` frontmatter edit committed in a tick whose diff range the
 * sweep never saw (a force-push / squash / a sync without prev↔head, a record seeded before the
 * re-anchor logic existed, or a partial-failure that left the cache half-written). A stale anchor cache
 * silently makes the reverse-index match the WRONG paths → the freshness sweep both misses real drift
 * and false-flags unrelated changes.
 *
 * This re-derives anchors from the CURRENT frontmatter for ALL anchor-derived (manual/augmented) docs and
 * rewrites the cache where it drifted — reusing the EXACT `anchorManualDoc` + `recomputeDocStatus` path the
 * self-bootstrap loop already uses, so reconcile and re-anchor-on-change share one code path. Generated
 * docs are NOT touched: their anchors come from the documenter regeneration (provenance.ts, with a
 * `generated_from_sha` baseline), not author frontmatter — re-anchoring them as manual would wipe that
 * baseline. Best-effort + idempotent: a clean cache is a no-op (the upsert rewrites identical anchors and
 * `recomputeDocStatus` lands the same status), so it is safe to run on a periodic routine.
 */
export async function reconcileAllDocAnchors(
  harnessSlug: string,
  workspaceId?: string,
): Promise<ReconcileAnchorsResult> {
  const ws = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const out: ReconcileAnchorsResult = { scanned: 0, reconciled: 0, failed: 0 };

  const repoRoot = await projectDirForSlug(harnessSlug);
  if (!repoRoot) return out;
  const submodulePaths = await listSubmodulePaths(repoRoot).catch(() => [] as string[]);
  const reanchorDeps = {
    runGit,
    repoRoot,
    resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, ws),
    submodulePaths,
  };

  const records = await listDocRecords(harnessSlug, ws);
  for (const [docId, record] of records) {
    // Only anchor-derived docs (manual/augmented) carry frontmatter-derived anchors; a generated doc's
    // anchors + baseline belong to the documenter regeneration path, so skip it (see the doc-comment).
    if (record.source === 'generated') continue;
    out.scanned += 1;
    const before = [...record.anchorPaths].sort();
    // Re-derive from CURRENT frontmatter (no verify → preserves the last_verified_sha baseline via the
    // upsert COALESCE), exactly like the self-bootstrap re-anchor-on-change branch.
    const res = await anchorManualDoc({ harnessSlug, docId, workspaceId: ws });
    if (!res.ok) {
      out.failed += 1;
      continue;
    }
    const after = [...res.record.anchorPaths].sort();
    const drifted = before.length !== after.length || before.some((p, i) => p !== after[i]);
    if (drifted) out.reconciled += 1;
    // Recompute status from the FRESH anchors so a pure-frontmatter change doesn't stick at the
    // transient 'review' anchorManualDoc writes for an un-verified anchor (mirrors the bootstrap loop).
    const { status, detail } = await recomputeDocStatus(res.record, reanchorDeps);
    await setDocStatus(harnessSlug, docId, status, detail, ws);
  }

  return out;
}
