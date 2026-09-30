/**
 * Deterministic first half of a Plans clean-up run.
 *
 * The owner route and the LLM-facing cleanup tools share this scan seam. The
 * route repeatedly applies only scanner-authorized findings through the same
 * run-row authority transaction and canonical plans/claim dispatcher the
 * resolver tool uses. It stops at a fixed point; only remaining judgment rows
 * justify launching an LLM process.
 */
import { withWorkspace } from '@papercusp/db-org';
import {
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import type { InnerCall } from '../agent-tools/_compound-dispatch';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import {
  settleRunPhase,
  type BulkRunPhase,
  type BulkRunRow,
} from '../attention/bulk-run-store';
import { notifyPlanCleanupRunChanged } from '../attention/bulk-run-sync';
import {
  bulkAutomationEligibility,
  normalizeBulkAutomationPolicy,
  type BulkAutomationPolicy,
  type BulkConfidence,
} from '../attention/bulk-dispositions';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { dispatchCleanupFindingAction } from './action-dispatch';
import { gatherCleanupInputs } from './gather';
import {
  DEFAULT_ENLIST_PLAN_LIMIT,
  scanForCleanupFindings,
  type CleanupFinding,
} from './scanner';
import {
  executeCleanupFindingAction,
  getRunFindings,
  reportFindingOutcomes,
  seedFindings,
  type CleanupFindingOutcomeReport,
  type CleanupFindingWriteRefusal,
  type CleanupRunFindingRow,
} from './run-store';

/**
 * The resolver tool path (agent-tools/plans/cleanup-run.ts) refuses to
 * auto-apply a finding whose confidence sits below the run's standing
 * automation policy (WI-2141525 — until this fix the deterministic pass had
 * no equivalent gate, so a review-all/L0 policy held every LLM-driven apply
 * but not a single deterministic one). Mirrors that check exactly: no
 * policy on the run ⇒ unrestricted (legacy runs predate P-006); otherwise
 * defer to the same `bulkAutomationEligibility` authority the resolver uses.
 */
function policyPermitsAutoApply(
  policy: BulkAutomationPolicy | null,
  row: { confidence: CleanupFinding['confidence']; confidenceLevel?: BulkConfidence | null },
): boolean {
  if (!policy) return true;
  const confidenceLevel = row.confidenceLevel ?? (row.confidence === 'provable' ? 'high' : 'medium');
  return bulkAutomationEligibility(policy, confidenceLevel).allowed;
}

export async function scanCleanupRun(
  run: BulkRunRow,
  planSlugs: readonly string[] = run.seedRefs,
  options: { enlistPlanLimit?: number } = {},
): Promise<CleanupFinding[]> {
  const inputs = await gatherCleanupInputs({
    workspaceId: run.workspaceId,
    harnessSlug: run.harnessSlug ?? operatorHomeHarnessSlug(),
    planSlugs: [...planSlugs],
  });
  return scanForCleanupFindings(inputs, { nowMs: Date.now(), ...options });
}

function unwrapDispatchResult(result: unknown): unknown {
  const structured = (result as { structuredContent?: unknown } | null)?.structuredContent;
  if (structured !== undefined) return structured;
  const content = (result as { content?: Array<{ text?: unknown }> } | null)?.content;
  const text = Array.isArray(content)
    ? content.find((entry) => typeof entry?.text === 'string')?.text
    : undefined;
  if (typeof text !== 'string') return result;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`plan-cleanup canonical dispatch returned non-JSON: ${text.slice(0, 300)}`);
  }
}

/**
 * Canonical in-process dispatcher for the first-party owner route. This mirrors
 * the loopback TUI plan routes: wildcard system principal, capability/quota
 * bypass, role gate retained, full projected-tool dispatch + audit/events.
 */
export function buildPlanCleanupSystemCall(input: {
  workspaceId: string;
  harnessSlug: string;
  runId: string;
  signal?: AbortSignal;
}): InnerCall {
  return async (name, args) => {
    const tool = lookupByMcpName(name);
    if (!tool) throw new Error(`plan-cleanup: canonical tool ${name} is not registered`);
    const result = await withWorkspace(input.workspaceId, async (tx) => {
      const ctx: UnifiedToolContext = {
        workspaceId: input.workspaceId,
        harnessSlug: input.harnessSlug,
        role: 'operator',
        featureId: null,
        chunkId: null,
        runId: input.runId,
        spawnId: 'plan-cleanup-deterministic',
        parentSpawnId: null,
        uiClientId: 'owner:plan-cleanup',
        isSuperuser: false,
        gateBypass: { capability: true, quota: true },
        profile: 'engineer',
        transport: 'in_process',
        log: () => {},
        progress: () => {},
        emit: () => {},
        signal: input.signal ?? new AbortController().signal,
        tx,
        principal: {
          slug: 'system:plan-cleanup-deterministic',
          workspaceId: input.workspaceId,
          capabilities: new Set(['*']),
        },
      };
      return dispatchProjectedToolToMcp(tool, name, args, ctx, PROJECTED_DEPS);
    });
    return unwrapDispatchResult(result);
  };
}

export interface DeterministicCleanupResult {
  needsResolver: boolean;
  phase: BulkRunPhase;
  passes: number;
  applied: number;
  skipped: number;
  failed: number;
  appliedFindingIds: string[];
  recommendationFindingIds: string[];
  reconciliationRequired: string[];
  fatalError: string | null;
  authorityRevoked: boolean;
  authorityRefusal: CleanupFindingWriteRefusal | null;
}

interface RunnerDeps {
  scanRun: typeof scanCleanupRun;
  seed: typeof seedFindings;
  read: typeof getRunFindings;
  execute: typeof executeCleanupFindingAction;
  report: typeof reportFindingOutcomes;
  dispatch: typeof dispatchCleanupFindingAction;
  settle: typeof settleRunPhase;
  notify: typeof notifyPlanCleanupRunChanged;
}

const DEFAULT_DEPS: RunnerDeps = {
  scanRun: scanCleanupRun,
  seed: seedFindings,
  read: getRunFindings,
  execute: executeCleanupFindingAction,
  report: reportFindingOutcomes,
  dispatch: dispatchCleanupFindingAction,
  settle: settleRunPhase,
  notify: notifyPlanCleanupRunChanged,
};

/** Exposed for focused tests; production callers omit `deps`. */
export async function runDeterministicPlanCleanup(input: {
  run: BulkRunRow;
  call: InnerCall;
  maxPasses?: number;
  deps?: Partial<RunnerDeps>;
}): Promise<DeterministicCleanupResult> {
  const deps = { ...DEFAULT_DEPS, ...input.deps };
  const run = input.run;
  // Normalizing an already-normalized policy is a no-op; done defensively so
  // this stays correct even if a future caller hands in a raw run row (the
  // same defensive re-normalize agent-tools/plans/cleanup-run.ts performs).
  const policy = run.automationPolicy ? normalizeBulkAutomationPolicy(run.automationPolicy) : null;
  const maxPasses = input.maxPasses ?? Math.max(4, run.seedRefs.length * 4 + 2);
  const appliedFindingIds: string[] = [];
  const reconciliationRequired: string[] = [];
  let skipped = 0;
  let failed = 0;
  let passes = 0;
  let fatalError: string | null = null;
  let authorityRevoked = false;
  let authorityRefusal: CleanupFindingWriteRefusal | null = null;
  let remainingEnlistments = DEFAULT_ENLIST_PLAN_LIMIT;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    passes = pass + 1;
    const scan = await deps.scanRun(run, run.seedRefs, { enlistPlanLimit: remainingEnlistments });
    const seeded = await deps.seed({
      runId: run.runId,
      findings: scan,
      workspaceId: run.workspaceId,
    });
    if (seeded.refused) {
      authorityRevoked = true;
      authorityRefusal = seeded.refused;
      break;
    }

    const rows = await deps.read(run.runId, run.workspaceId);
    const currentById = new Map(scan.map((finding) => [finding.findingId, finding]));
    const candidates = rows.filter((row) => {
      const current = currentById.get(row.findingId);
      if (row.outcome !== 'pending' || current?.autoApply !== true) return false;
      return policyPermitsAutoApply(policy, { confidence: current.confidence, confidenceLevel: row.confidenceLevel });
    });
    if (candidates.length === 0) break;

    let terminalized = 0;
    for (const row of candidates) {
      let actionDispatched = false;
      try {
        const result = await deps.execute({
          runId: run.runId,
          findingId: row.findingId,
          workspaceId: run.workspaceId,
          async execute(locked) {
            const fresh = (await deps.scanRun(run, [locked.planSlug], {
              enlistPlanLimit: remainingEnlistments,
            })).find(
              (finding) => finding.findingId === locked.findingId,
            );
            if (!fresh) {
              throw new Error(`${locked.findingId}: finding disappeared during locked re-verification`);
            }
            if (!fresh.autoApply) {
              throw new Error(
                `${locked.findingId}: auto-apply is no longer authorized (${fresh.autoApplyBlockedBy ?? fresh.confidence})`,
              );
            }
            if (!policyPermitsAutoApply(policy, { confidence: fresh.confidence, confidenceLevel: locked.confidenceLevel })) {
              throw new Error(
                `${locked.findingId}: auto-apply is no longer authorized (standing automation policy)`,
              );
            }
            const dispatched = await deps.dispatch({ run, finding: fresh, call: input.call });
            actionDispatched = true;
            return dispatched;
          },
        });
        if (result.refused) {
          authorityRevoked = true;
          authorityRefusal = result.refused;
          break;
        }
        appliedFindingIds.push(row.findingId);
        if (row.kind === 'enlist-plan') remainingEnlistments = Math.max(0, remainingEnlistments - 1);
        terminalized += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (actionDispatched) {
          reconciliationRequired.push(row.findingId);
          fatalError = `${row.findingId}: canonical action dispatched but outcome persistence failed — ${message}`;
          break;
        }
        const reported = await deps.report({
          runId: run.runId,
          workspaceId: run.workspaceId,
          reports: [{ findingId: row.findingId, outcome: 'failed', error: message }],
        });
        if (reported.refused) {
          authorityRevoked = true;
          authorityRefusal = reported.refused;
          break;
        }
        failed += 1;
        terminalized += 1;
      }
    }
    if (authorityRevoked || fatalError || terminalized === 0) break;
  }

  if (fatalError || authorityRevoked) {
    await deps.notify().catch(() => undefined);
    return {
      needsResolver: false,
      phase: fatalError ? 'failed' : authorityRefusal?.phase ?? run.phase,
      passes,
      applied: appliedFindingIds.length,
      skipped,
      failed,
      appliedFindingIds,
      recommendationFindingIds: [],
      reconciliationRequired,
      fatalError,
      authorityRevoked,
      authorityRefusal,
    };
  }

  // Final scan catches second-order findings (e.g. item flips make a plan
  // finishable) and classifies every still-pending snapshot row.
  const finalScan = await deps.scanRun(run, run.seedRefs, {
    enlistPlanLimit: remainingEnlistments,
  });
  const finalSeed = await deps.seed({
    runId: run.runId,
    findings: finalScan,
    workspaceId: run.workspaceId,
  });
  if (finalSeed.refused) {
    authorityRevoked = true;
    authorityRefusal = finalSeed.refused;
  }
  const rows = await deps.read(run.runId, run.workspaceId);
  const currentById = new Map(finalScan.map((finding) => [finding.findingId, finding]));
  const reports: CleanupFindingOutcomeReport[] = [];
  const recommendationFindingIds: string[] = [];

  for (const row of rows) {
    if (row.outcome !== 'pending') continue;
    const current = currentById.get(row.findingId);
    if (!current) {
      reports.push({
        findingId: row.findingId,
        outcome: 'skipped',
        error: 'finding no longer exists after the deterministic cleanup pass',
      });
      skipped += 1;
    } else if (
      current.autoApply &&
      policyPermitsAutoApply(policy, { confidence: current.confidence, confidenceLevel: row.confidenceLevel })
    ) {
      reports.push({
        findingId: row.findingId,
        outcome: 'failed',
        error: `deterministic cleanup did not converge within ${maxPasses} passes`,
      });
      failed += 1;
    } else {
      // Either a genuine judgment call, or a provable finding the standing
      // automation policy withheld (policyPermitsAutoApply === false) — both
      // route to the resolver, which reports a typed recommendation instead
      // of auto-applying (mirrors cleanup-run.ts's confidence_policy refusal
      // message).
      recommendationFindingIds.push(row.findingId);
    }
  }

  if (reports.length > 0 && !authorityRevoked) {
    const reported = await deps.report({
      runId: run.runId,
      workspaceId: run.workspaceId,
      reports,
    });
    if (reported.refused) {
      authorityRevoked = true;
      authorityRefusal = reported.refused;
    }
  }

  let phase: BulkRunPhase = authorityRefusal?.phase ?? run.phase;
  const needsResolver = !authorityRevoked && recommendationFindingIds.length > 0;
  if (!needsResolver && !authorityRevoked) {
    phase = (await deps.settle({ runId: run.runId }))?.phase ?? 'complete';
  }
  await deps.notify().catch(() => undefined);

  return {
    needsResolver,
    phase,
    passes,
    applied: appliedFindingIds.length,
    skipped,
    failed,
    appliedFindingIds,
    recommendationFindingIds,
    reconciliationRequired,
    fatalError,
    authorityRevoked,
    authorityRefusal,
  };
}
