/**
 * Phase 3 of `dbos-durable-jobs-2026-05-31` — the START side (D-011/D-012).
 *
 * The carve-out filter (`durableOwnedFeatureIdsPg` in the orchestrator's
 * `state-pg.ts`) keeps the GLOBAL orchestrator from deciding for a feature a
 * durable pipeline owns. This module is the other half: it OPTS a feature into
 * durable ownership by starting (or resuming) its pipeline — respecting the
 * workflow-ID-as-claim so a feature is never double-dispatched.
 *
 * Runs in the operator host (where DBOS is launched). Only meaningful when
 * `PAPERCUSP_DBOS_ORCHESTRATOR=1` (the workflow is registered there); otherwise
 * `startFeaturePipeline` has nothing to enqueue on.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { activeWorkspaceId } from '../workspace-registry';
import { workspacesForHarness } from '../harness-membership';
import { resolveProjectDir } from '../spawn-config';
import { loadBlueprintFromFile, type BlueprintSpine } from '@papercusp/orchestrator/blueprint';
import { startFeaturePipeline } from './orchestrator-workflow';
import type { WorkItemClaimLeaseHandle } from '../work-item-claim-lease-wiring';

/** DBOS statuses that mean a pipeline still OWNS its feature (in-flight). */
const LIVE_STATUSES = new Set(['PENDING', 'ENQUEUED']);

export interface PipelineDecision {
  action: 'reuse' | 'start';
  workflowID: string;
  /** The epoch of the reused (or newly-started) pipeline lifetime. */
  epoch: number;
}

/** Parse the `:e<N>` epoch suffix off a `pipeline:<slug>:<feature>:e<N>` id. */
export function epochOf(workflowID: string): number {
  const m = workflowID.match(/:e(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Pure ownership/epoch decision (exported for unit testing). Given the prior
 * pipeline workflows for one feature:
 *  - a still-LIVE (PENDING/ENQUEUED) pipeline → **reuse** it (no double-start);
 *  - otherwise → **start** a fresh epoch = count of prior lifetimes, so the
 *    feature can be re-pipelined after a prior pipeline completed (DBOS will not
 *    re-enqueue a completed id — see `PipelineInput.epoch`).
 *
 * Concurrency is safe even when two callers both decide `start`: the workflow id
 * is deterministic (`pipeline:<slug>:<feature>:e<epoch>`) and the dedup id
 * collapses the duplicate enqueue.
 */
export function decidePipelineStart(
  prior: ReadonlyArray<{ workflowID: string; status: string }>,
  harnessSlug: string,
  featureId: string,
): PipelineDecision {
  const live = prior.find((w) => LIVE_STATUSES.has(w.status));
  if (live) {
    return { action: 'reuse', workflowID: live.workflowID, epoch: epochOf(live.workflowID) };
  }
  const epoch = prior.length;
  return { action: 'start', workflowID: `pipeline:${harnessSlug}:${featureId}:e${epoch}`, epoch };
}

export interface EnsurePipelineResult extends PipelineDecision {
  /** true → a NEW pipeline was enqueued; false → an existing live one owns it. */
  started: boolean;
}

/**
 * Ensure feature `<slug>:<featureId>` has a durable pipeline, respecting
 * ownership. Lists prior pipeline lifetimes from DBOS, reuses a live one if
 * present, else starts a fresh epoch. Idempotent under concurrency.
 */
/**
 * PURE home-workspace selection (exported for unit testing): the active workspace
 * when the harness is a member there (the common case — preserves prior behavior),
 * else the harness's first home workspace, else active. A harness lives in exactly
 * one workspace, so this lets a manual trigger (or a tick for a non-active
 * workspace) resolve any harness instead of nulling `resolveProject` against the
 * volatile active one. Kept free of I/O so the selection is directly testable —
 * the async wrapper feeds it `activeWorkspaceId()` + `workspacesForHarness()`.
 */
export function pickHomeWorkspace(active: string, members: readonly string[]): string {
  if (members.includes(active)) return active;
  if (members.length > 0) return members[0];
  return active;
}

/** The workspace to PIN a pipeline to — see {@link pickHomeWorkspace}. Falls back
 *  to the active workspace when the registry is unreadable. */
async function resolveHomeWorkspace(harnessSlug: string): Promise<string> {
  const active = activeWorkspaceId();
  try {
    return pickHomeWorkspace(active, await workspacesForHarness(harnessSlug));
  } catch {
    return active; // registry unreadable → fall back to active
  }
}

/**
 * Resolve the harness's declared blueprint spine from its git-canonical
 * `.papercusp/blueprint.yaml` (P-018). Returns null when the harness has no
 * blueprint file — the pipeline then falls back to `codingSpine()`
 * (orchestrator-workflow.ts), which since 2026-07-20 (commit 33d1bac9f4,
 * owner-directed) is the SINGLE-AGENT `coding-solo` spine: decider `worker`,
 * edges DONE/ESCALATE/IDLE only. ⚠ This is NOT behavior-preserving and NOT the
 * old built-in `coding`/`coding-factory` default — a blueprint-less harness now
 * runs with orchestration OFF, silently (no error, no warning). See WI-39505 for
 * the measured population and the two other callers of the same fallback.
 * The file is the source of truth (D-006); the PG cache is populated lazily
 * elsewhere. Fail-safe: any error → null → that single-agent fallback (never
 * breaks a dispatch).
 */
async function resolveHarnessSpine(
  harnessSlug: string,
  workspaceId: string,
): Promise<BlueprintSpine | null> {
  try {
    const dir = await resolveProjectDir(harnessSlug, workspaceId);
    if (!dir) return null;
    const bpFile = join(dir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(bpFile)) return null;
    return loadBlueprintFromFile(bpFile).blueprint.spine;
  } catch {
    return null;
  }
}

export async function ensureFeaturePipeline(
  harnessSlug: string,
  featureId: string,
  /** Explicit workspace to pin (the dispatch loop already knows it). When omitted,
   *  the harness's home workspace is resolved — see `resolveHomeWorkspace`. */
  workspaceId?: string,
  /** D-007 (shared-hive-loop-e2e-testing): the executor's per-Hive work-item lease,
   *  threaded into the pipeline so it can heartbeat (renew) + self-abort if the lease is
   *  stolen mid-run. Omitted when the lease flag is OFF / the claim couldn't be taken
   *  (fail-open) → the pipeline runs without the heartbeat seam (byte-identical). Only
   *  applied when a NEW pipeline is started; a reused live pipeline keeps its captured lease. */
  claim?: WorkItemClaimLeaseHandle,
): Promise<EnsurePipelineResult> {
  // `:e` suffix on the prefix disambiguates F-1 from F-12 (F-12's id continues
  // with `2:e…`, not `:e…`), so this returns only THIS feature's pipelines.
  const prior = await DBOS.listWorkflows({
    workflow_id_prefix: `pipeline:${harnessSlug}:${featureId}:e`,
  });
  const decision = decidePipelineStart(
    prior.map((w) => ({ workflowID: w.workflowID, status: w.status })),
    harnessSlug,
    featureId,
  );
  if (decision.action === 'start') {
    // Capture the workspace NOW so the whole pipeline resolves in it, immune to a
    // later active-workspace switch (which would otherwise null `resolveProject`).
    // An explicit caller (the dispatch loop) wins; otherwise pin the harness's home
    // workspace so a manual trigger works regardless of the active workspace.
    const captureWs = workspaceId ?? (await resolveHomeWorkspace(harnessSlug));
    // Resolve the harness's blueprint spine (P-018) so a non-coding harness
    // (research) runs its own declared graph; null → the built-in coding default.
    const spine = (await resolveHarnessSpine(harnessSlug, captureWs)) ?? undefined;
    await startFeaturePipeline({
      harnessSlug,
      featureId,
      epoch: decision.epoch,
      workspaceId: captureWs,
      spine,
      claim,
    });
  }
  return { ...decision, started: decision.action === 'start' };
}
