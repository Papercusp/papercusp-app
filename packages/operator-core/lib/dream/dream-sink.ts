/**
 * Accepted-dream sink (REM dreaming P-004).
 *
 * A reviewed dream does not get a parallel idea store or outcome loop. It is
 * captured onto the existing improvement rail, then enrolled in the existing
 * Blender routed-idea ledger with origin='dream'. The ordinary grade and
 * change-feed outcome machinery therefore sees the same wi:<id> artifact it
 * already understands. Source-fragment refs ride the ledger's established
 * addresses_pattern_refs provenance column.
 */
import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from '../harness/improvements/capture-core';
import { recordRoutedIdea, type RecordRoutedIdeaInput } from '../scout/routed-ledger';
import { validateDreamFragments, type DreamInsight } from './dream-pass';
import type { DreamReviewResult } from './dream-review';
import type { DreamFragment } from './fragment-sampler';
import type { Sql } from 'postgres';
import { activeWorkspaceId } from '../workspace-registry';
import { withLockedDreamRun, reserveDreamRunArtifact, type DreamRun } from './dream-run-store';
import { dreamCapabilityRun, dreamCallTotals } from './dream-run-provenance';
import { CapabilityManifestSchema, capabilityHash, type CapabilityManifest } from './capability-contracts';
import { CapabilityProposalSchema } from './capability-pass';
import {
  verifyCapabilityReviewAdmission,
  type CapabilityReviewResult,
  type CapabilityReviewSources,
} from './capability-review';

export interface SinkDreamInsightInput {
  kind?: 'fragment';
  /** Stable id of the persisted dream run; retries must reuse it. */
  dreamRunId: string;
  cycleId: string;
  harnessSlug: string;
  insight: DreamInsight;
  fragments: readonly DreamFragment[];
  review: DreamReviewResult;
  workspaceId?: string;
  createdBy?: string;
}

export interface SinkCapabilityDreamInput {
  kind: 'capability';
  sql: Sql;
  workspaceId: string;
  dreamRunId: string;
  rootPath: string;
  manifest: CapabilityManifest;
  sources: CapabilityReviewSources;
  createdBy?: string;
}
interface CapturedDream {
  id: string;
  candidateHash: string;
  evidenceHash: string;
}

export interface DreamSinkDeps {
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  recordRoutedIdea: (input: RecordRoutedIdeaInput) => Promise<void>;
  now: () => number;
  reserveArtifact?: typeof reserveDreamRunArtifact;
  findCaptured?: (sql: Sql, run: DreamRun) => Promise<CapturedDream | null>;
  saveRouted?: (sql: Sql, run: DreamRun, routedRef: string) => Promise<void>;
}

export type SinkDreamInsightResult =
  | { sunk: false; reason: 'review-rejected' | 'source-unverified'; detail?: string }
  | {
      sunk: true;
      ideaId: string;
      workItemId: string;
      routedRef: string;
      sourceRefs: string[];
      created: boolean;
      captureReason?: CaptureImprovementResult['reason'];
    };

const defaultDeps: DreamSinkDeps = {
  capture: (input) => captureImprovement(input),
  recordRoutedIdea,
  now: Date.now,
};

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${name} must be a non-empty string`);
  return normalized;
}

function normalizedInsight(insight: DreamInsight): DreamInsight {
  return {
    text: required(insight.text, 'dream insight text'),
    requiresA: required(insight.requiresA, 'dream insight requiresA'),
    requiresB: required(insight.requiresB, 'dream insight requiresB'),
    actionable: required(insight.actionable, 'dream insight actionable'),
  };
}

export function dreamIdeaId(dreamRunId: string): string {
  return `dream:${required(dreamRunId, 'dreamRunId')}`;
}

/** Human-readable artifact body; the structured copy also lands in payload.dream. */
export function buildDreamInsightBody(input: {
  dreamRunId: string;
  cycleId: string;
  insight: DreamInsight;
  sourceRefs: readonly string[];
  review: Extract<DreamReviewResult, { verdict: 'accept' }>;
}): string {
  return [
    input.insight.text,
    '',
    `**Why fragment A is required:** ${input.insight.requiresA}`,
    `**Why fragment B is required:** ${input.insight.requiresB}`,
    `**Action / falsifiable next step:** ${input.insight.actionable}`,
    '',
    '**Dream provenance**',
    `- Dream run: ${input.dreamRunId}`,
    `- Cycle: ${input.cycleId}`,
    `- Source fragments: ${input.sourceRefs.join(', ')}`,
    `- Independent review: dependence ${input.review.scores.dependence}/2, actionability ${input.review.scores.actionability}/2, novelty ${input.review.scores.novelty}/2`,
    `- Review note: ${input.review.note}`,
  ].join('\n');
}

function artifactId(result: CaptureImprovementResult): string | null {
  return result.issue?.id ?? result.coalescedOnto?.id ?? result.possibleDuplicates[0]?.id ?? null;
}

/**
 * Sink one review-passed dream onto Blender's existing improvement rail.
 *
 * Rejected reviews are a side-effect-free no-op. Accepted retries are stable:
 * the dream-run key participates in capture dedup, and the ledger upserts on
 * the deterministic dream idea id.
 */
export async function sinkDreamInsight(
  input: SinkDreamInsightInput | SinkCapabilityDreamInput,
  deps: DreamSinkDeps = defaultDeps,
): Promise<SinkDreamInsightResult> {
  if (input.kind === 'capability') return sinkCapabilityDream(input, deps);
  if (input.review.verdict !== 'accept') return { sunk: false, reason: 'review-rejected' };

  const dreamRunId = required(input.dreamRunId, 'dreamRunId');
  const cycleId = required(input.cycleId, 'cycleId');
  const harnessSlug = required(input.harnessSlug, 'harnessSlug');
  const insight = normalizedInsight(input.insight);
  validateDreamFragments(input.fragments);
  if (input.fragments.some((fragment) => fragment.harness !== harnessSlug)) {
    throw new RangeError('dream sink fragments must belong to the target harness');
  }
  const sourceRefs = [...new Set(input.fragments.map((fragment) => required(fragment.ref, 'fragment ref')))];
  if (sourceRefs.length < 2) throw new RangeError('dream sink requires at least two distinct source refs');

  const ideaId = dreamIdeaId(dreamRunId);
  const title = insight.text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)!
    .slice(0, 200);
  const captured = await deps.capture({
    title,
    kind: 'feature',
    body: buildDreamInsightBody({ dreamRunId, cycleId, insight, sourceRefs, review: input.review }),
    scope: `harness:${harnessSlug}`,
    sourceRole: 'system',
    filedByRole: 'dream',
    foundDuring: 'dream-cycle',
    createdBy: input.createdBy,
    semanticBlockBand: 'soft',
    watchdogKey: ideaId,
    payloadExtra: {
      dream: {
        dreamRunId,
        cycleId,
        sourceRefs,
        review: {
          scores: input.review.scores,
          note: input.review.note,
          model: input.review.usage.model,
        },
      },
    },
  });
  const workItemId = artifactId(captured);
  if (!workItemId) {
    throw new Error(`dream sink capture returned no routable artifact for ${ideaId}`);
  }
  const routedRef = `wi:${workItemId}`;

  await deps.recordRoutedIdea({
    ideaId,
    origin: 'dream',
    lens: 'dream',
    rail: 'improvement',
    routedRef,
    harnessSlug,
    cycleId,
    title,
    addressesPatternRefs: sourceRefs,
    routedAt: deps.now(),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  });

  return {
    sunk: true,
    ideaId,
    workItemId,
    routedRef,
    sourceRefs,
    created: captured.created,
    ...(captured.reason ? { captureReason: captured.reason } : {}),
  };
}

/** Exact identity lookup includes terminal ideas: capture's open-item dedup alone cannot do that. */
async function findCapturedDream(sql: Sql, run: DreamRun): Promise<CapturedDream | null> {
  const artifactId = dreamCapabilityRun(run)?.artifactId;
  if (!artifactId) return null;
  const rows = await sql`SELECT issue_id, payload FROM harness_shared.engineer_issues
    WHERE workspace_id = ${run.workspaceId} AND scope = ${'harness:' + run.potSlug}
      AND issue_id = ${artifactId} AND payload->>'watchdogKey' = ${dreamIdeaId(run.runId)} LIMIT 2`;
  if (rows.length > 1) throw new Error('Dream identity already has multiple captured artifacts');
  if (!rows[0]) return null;
  const dream = rows[0].payload?.dream;
  return { id: String(rows[0].issue_id), candidateHash: dream?.candidateHash, evidenceHash: dream?.evidenceHash };
}
async function saveDreamRouted(sql: Sql, run: DreamRun, routedRef: string): Promise<void> {
  await withLockedDreamRun(sql, run, async (tx, current) => {
    if (current.routedRef && current.routedRef !== routedRef) throw new Error('Dream routing identity changed');
    if (current.status !== 'running') {
      if (current.routedRef !== routedRef) throw new Error('Terminal dream routing is immutable');
      return;
    }
    await tx`UPDATE harness_shared.dream_runs SET routed_ref = ${routedRef}, updated_at = now()
      WHERE workspace_id = ${run.workspaceId} AND run_id = ${run.runId}`;
  });
}

async function sinkCapabilityDream(
  input: SinkCapabilityDreamInput,
  deps: DreamSinkDeps,
): Promise<SinkDreamInsightResult> {
  // Capture's established persistence seam is ambient-workspace scoped. Refuse a mismatch before spending or writing.
  if (deps === defaultDeps && activeWorkspaceId() !== input.workspaceId)
    throw new Error('Dream capture workspace mismatch');
  const run = await (deps.reserveArtifact ?? reserveDreamRunArtifact)(input.sql, {
    workspaceId: input.workspaceId,
    runId: input.dreamRunId,
  });
  const tx = input.sql;
  if (
    !['running', 'accepted'].includes(run.status) ||
    run.review?.verdict !== 'accept' ||
    run.outcome?.verdict !== 'insight'
  )
    return { sunk: false, reason: 'review-rejected' };
  const provenance = dreamCapabilityRun(run);
  if (!provenance || provenance.sampling?.status !== 'selected')
    return { sunk: false, reason: 'source-unverified', detail: 'Missing frozen capability selection' };
  const candidate = CapabilityProposalSchema.parse((run.outcome.insight as Record<string, unknown>)?.capability);
  const review = run.review as unknown as CapabilityReviewResult;
  if (
    capabilityHash(JSON.stringify(CapabilityManifestSchema.parse(input.manifest))) !== provenance.manifestHash ||
    review.usage.model !== provenance.reviewerModel ||
    dreamCallTotals(provenance.calls).costBasis !== 'actual'
  )
    return {
      sunk: false,
      reason: 'source-unverified',
      detail: 'Manifest, model or paid-call accounting is not verified',
    };
  const admission = await verifyCapabilityReviewAdmission({
    candidate,
    selection: provenance.sampling.selection,
    review,
    rootPath: input.rootPath,
    manifest: input.manifest,
    sources: input.sources,
    dreamerModel: provenance.dreamerModel,
  });
  if (!admission.admitted) return { sunk: false, reason: 'source-unverified', detail: admission.reason };
  const selection = provenance.sampling.selection;
  const sourceRefs = [selection.a, selection.b, ...(selection.c ? [selection.c.entry] : [])].map(
    (e) => e.packet.unit.id + '@' + e.contentVersion,
  );
  const ideaId = dreamIdeaId(run.runId),
    title = candidate.behavior.slice(0, 200);
  const findCaptured = deps.findCaptured ?? findCapturedDream;
  let captured = await findCaptured(tx, run);
  let created = false;
  if (!captured) {
    if (run.routedRef) throw new Error('Previously routed dream artifact is missing');
    const result = await deps.capture({
      artifactId: provenance.artifactId!,
      title,
      kind: 'feature',
      scope: 'harness:' + run.potSlug,
      sourceRole: 'system',
      filedByRole: 'dream',
      foundDuring: 'dream-cycle',
      createdBy: input.createdBy,
      semanticBlockBand: 'soft',
      watchdogKey: ideaId,
      body: [
        candidate.behavior,
        '',
        '**Proposed delta:** ' + candidate.priorArt.proposedDelta,
        '**Why A is required:** ' + candidate.primaryContributions.A.uniqueContribution,
        '**Why B is required:** ' + candidate.primaryContributions.B.uniqueContribution,
        '**Experiment:** ' + candidate.experiment.change,
        '**Baseline:** ' + candidate.experiment.baseline,
        '**Falsifier:** ' + candidate.experiment.falsifier,
        '',
        '**Dream provenance**',
        'Run: ' + run.runId,
        'Cycle: ' + run.cycleId,
        'Sources: ' + sourceRefs.join(', '),
        'Independent source review: ' + review.note,
        'Coverage: bounded; global novelty is not established.',
        'Ordinary Blender triage applies. Review does not approve a plan or its implementation.',
      ].join('\n'),
      payloadExtra: {
        dream: {
          dreamRunId: run.runId,
          cycleId: run.cycleId,
          workspaceId: run.workspaceId,
          sourceRefs,
          candidateHash: review.candidateHash,
          evidenceHash: review.evidenceHash,
          capability: candidate,
          provenance,
          review,
          admission: { checkedAt: new Date(deps.now()).toISOString(), status: 'verified' },
        },
      },
    });
    created = result.created;
    // A fuzzy duplicate or failed read may not substitute an unrelated artifact.
    captured = await findCaptured(tx, run);
    if (!captured) throw new Error('Dream capture returned no exact artifact identity');
  }
  if (captured.candidateHash !== review.candidateHash || captured.evidenceHash !== review.evidenceHash)
    throw new Error('Captured dream provenance differs from the frozen run');
  const routedRef = 'wi:' + captured.id;
  if (run.routedRef && run.routedRef !== routedRef) throw new Error('Dream routing identity changed');
  await deps.recordRoutedIdea({
    ideaId,
    origin: 'dream',
    lens: 'dream',
    rail: 'improvement',
    routedRef,
    harnessSlug: run.potSlug,
    cycleId: run.cycleId,
    title,
    addressesPatternRefs: sourceRefs,
    routedAt: new Date(run.startedAt).getTime(),
    preserveExisting: true,
    workspaceId: run.workspaceId,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  });
  await (deps.saveRouted ?? saveDreamRouted)(tx, run, routedRef);
  return { sunk: true, ideaId, workItemId: captured.id, routedRef, sourceRefs, created };
}
