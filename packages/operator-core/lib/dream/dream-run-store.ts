/**
 * Durable dream-attempt ledger (REM dreaming P-005, migration 862).
 *
 * A row is begun before source selection/model work, selection is persisted
 * before the dreamer call, and a terminal finalize is write-once.  The stable
 * run id is derived from the DBOS routine-fire workflow id plus the bounded
 * dream index, so a crash replay reuses the same row and accepted sinks retain
 * their existing `dream:<runId>` idempotency key.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { DreamPassUsage } from './dream-pass';
import type { DreamReviewUsage } from './dream-review';
import type { DreamFragmentKind } from './dream-config';
import type { DreamFragmentPair } from './fragment-sampler';
import type { CapabilitySamplingResult } from './capability-sampler';
import { newCollisionResistantIssueTail } from '../issues-engineer';
import { CapabilityProposalSchema } from './capability-pass';
import { capabilityProposalHash, capabilityReviewEvidenceHash, CAPABILITY_REVIEW_VERSION } from './capability-review';
import {
  newDreamCapabilityRun,
  dreamCapabilityRun,
  dreamCallTotals,
  sameDreamValue,
  validateDreamSampling,
  validateDreamRunCall,
  DreamCallUsageSchema,
  DreamRunAssessmentSchema,
  dreamRunAssessments,
  type DreamRunAssessment,
  type BeginCapabilityRunInput,
  type DreamCapabilityRun,
  type DreamRunCall,
} from './dream-run-provenance';

export const DREAM_RUN_MODES = ['manual', 'auto'] as const;
export type DreamRunMode = (typeof DREAM_RUN_MODES)[number];

export const DREAM_RUN_TERMINAL_STATUSES = [
  'no-pair',
  'abstained',
  'malformed',
  'duplicate',
  'rejected',
  'accepted',
  'error',
] as const;
export type DreamRunTerminalStatus = (typeof DREAM_RUN_TERMINAL_STATUSES)[number];
export type DreamRunStatus = 'running' | DreamRunTerminalStatus;

export interface DreamRun {
  workspaceId: string;
  runId: string;
  cycleId: string;
  potSlug: string;
  mode: DreamRunMode;
  status: DreamRunStatus;
  fragmentRefs: string[];
  fragmentKinds: DreamFragmentKind[];
  pairing: DreamFragmentPair['pairing'] | null;
  similarity: number | null;
  dreamerModel: string | null;
  reviewerModel: string | null;
  dreamUsage: DreamPassUsage | null;
  reviewUsage: DreamReviewUsage | null;
  outcome: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  routedRef: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  spendRecordedAt: string | null;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${name} must be a non-empty string`);
  return normalized;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`dream-run-store: invalid timestamp ${String(value)}`);
  return date.toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function mapDreamRun(row: Row): DreamRun {
  dreamCapabilityRun({ outcome: objectOrNull(row.outcome) });
  dreamRunAssessments({ outcome: objectOrNull(row.outcome) });
  return {
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    cycleId: String(row.cycle_id),
    potSlug: String(row.pot_slug),
    mode: String(row.mode) as DreamRunMode,
    status: String(row.status) as DreamRunStatus,
    fragmentRefs: stringArray(row.fragment_refs),
    fragmentKinds: stringArray(row.fragment_kinds) as DreamFragmentKind[],
    pairing: row.pairing == null ? null : (String(row.pairing) as DreamFragmentPair['pairing']),
    similarity: row.similarity == null ? null : Number(row.similarity),
    dreamerModel: row.dreamer_model == null ? null : String(row.dreamer_model),
    reviewerModel: row.reviewer_model == null ? null : String(row.reviewer_model),
    dreamUsage: objectOrNull(row.dream_usage) as DreamPassUsage | null,
    reviewUsage: objectOrNull(row.review_usage) as DreamReviewUsage | null,
    outcome: objectOrNull(row.outcome),
    review: objectOrNull(row.review),
    routedRef: row.routed_ref == null ? null : String(row.routed_ref),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    error: row.error == null ? null : String(row.error),
    startedAt: iso(row.started_at),
    completedAt: isoOrNull(row.completed_at),
    spendRecordedAt: isoOrNull(row.spend_recorded_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function getDreamRun(sql: Sql, input: { workspaceId: string; runId: string }): Promise<DreamRun | null> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  const rows = (await sql`
    SELECT * FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
     LIMIT 1`) as Row[];
  return rows[0] ? mapDreamRun(rows[0]) : null;
}

export async function beginDreamRun(
  sql: Sql,
  input: {
    workspaceId: string;
    runId: string;
    cycleId: string;
    potSlug: string;
    mode: DreamRunMode;
    capability?: BeginCapabilityRunInput;
  },
): Promise<{ created: boolean; run: DreamRun }> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  const cycleId = required(input.cycleId, 'cycleId');
  const potSlug = required(input.potSlug, 'potSlug');
  if (!DREAM_RUN_MODES.includes(input.mode)) throw new RangeError(`unsupported dream mode ${input.mode}`);
  const capability = input.capability ? newDreamCapabilityRun(input.capability) : null;

  const inserted = (await sql`
    INSERT INTO harness_shared.dream_runs
      (workspace_id, run_id, cycle_id, pot_slug, mode, outcome, dreamer_model)
    VALUES (${workspaceId}, ${runId}, ${cycleId}, ${potSlug}, ${input.mode},
      ${JSON.stringify(capability ? { capabilityRun: capability } : null)}::text::jsonb, ${capability?.dreamerModel ?? null})
    ON CONFLICT (workspace_id, run_id) DO NOTHING
    RETURNING *`) as Row[];
  const run = inserted[0] ? mapDreamRun(inserted[0]) : await getDreamRun(sql, { workspaceId, runId });
  if (!run) throw new Error(`dream-run-store: begin lost row ${workspaceId}/${runId}`);
  if (run.cycleId !== cycleId || run.potSlug !== potSlug || run.mode !== input.mode) {
    throw new Error(`dream-run-store: stable run id ${runId} was reused with different provenance`);
  }
  const saved = dreamCapabilityRun(run);
  if (!sameDreamValue(capability, saved ? { ...saved, sampling: null, calls: [], artifactId: null } : null))
    throw new Error(`dream-run-store: stable run id ${runId} was reused with different capability versions`);
  return { created: inserted.length > 0, run };
}

/** Persist the chosen pair before the first model call. */
export async function recordDreamRunSelection(
  sql: Sql,
  input: { workspaceId: string; runId: string } & (
    | { pair: DreamFragmentPair; dreamerModel: string; capability?: never }
    | { capability: CapabilitySamplingResult; pair?: never; dreamerModel?: never }
  ),
): Promise<DreamRun> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  if (input.capability) {
    const sampling = input.capability;
    validateDreamSampling(sampling);
    return withLockedDreamRun(sql, { workspaceId, runId }, async (tx, run) => {
      const provenance = requireCapability(run);
      if (provenance.sampling !== null) {
        if (!sameDreamValue(provenance.sampling, sampling)) throw new Error('Dream selection is already frozen');
        return run;
      }
      if (run.status !== 'running') throw new Error('Cannot select a terminal dream run');
      if (sampling.log.promptVersion !== provenance.dreamPromptVersion)
        throw new Error('Sampling prompt version changed');
      const entries =
        sampling.status === 'selected'
          ? [sampling.selection.a, sampling.selection.b, ...(sampling.selection.c ? [sampling.selection.c.entry] : [])]
          : [];
      if (
        entries.some(
          (e) =>
            e.packet.scope.workspaceId !== workspaceId ||
            e.packet.scope.potSlug !== run.potSlug ||
            e.packet.manifestRevision !== provenance.manifestRevision,
        )
      )
        throw new Error('Selection crosses run scope or manifest');
      provenance.sampling = sampling;
      return saveCapabilityRun(tx, run, provenance);
    });
  }
  const dreamerModel = required(input.dreamerModel, 'dreamerModel');
  if (dreamCapabilityRun((await getDreamRun(sql, { workspaceId, runId })) ?? { outcome: null }))
    throw new Error('A capability run cannot use legacy fragment selection');
  const fragments = [input.pair.anchor, input.pair.partner];
  const refs = fragments.map((fragment) => required(fragment.ref, 'fragment ref'));
  if (new Set(refs).size !== refs.length) throw new RangeError('dream selection requires distinct fragment refs');
  const kinds = fragments.map((fragment) => fragment.kind);
  const rows = (await sql`
    UPDATE harness_shared.dream_runs
       SET fragment_refs = ${JSON.stringify(refs)}::text::jsonb,
           fragment_kinds = ${JSON.stringify(kinds)}::text::jsonb,
           pairing = ${input.pair.pairing},
           similarity = ${input.pair.similarity},
           dreamer_model = ${dreamerModel},
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId} AND status = 'running'
     RETURNING *`) as Row[];
  const run = rows[0] ? mapDreamRun(rows[0]) : await getDreamRun(sql, { workspaceId, runId });
  if (!run) throw new Error(`dream-run-store: selection target not found ${workspaceId}/${runId}`);
  return run;
}

/** Short state transitions only: never hold this transaction across an external rail. */
export async function withLockedDreamRun<T>(
  sql: Sql,
  input: { workspaceId: string; runId: string },
  action: (tx: Sql, run: DreamRun) => Promise<T>,
): Promise<T> {
  const workspaceId = required(input.workspaceId, 'workspaceId'),
    runId = required(input.runId, 'runId');
  const run = async (tx: Sql | TransactionSql) => {
    const rows = await tx`SELECT * FROM harness_shared.dream_runs
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId} FOR UPDATE`;
    if (!rows[0]) throw new Error(`dream-run-store: run not found ${workspaceId}/${runId}`);
    return action(tx as unknown as Sql, mapDreamRun(rows[0]));
  };
  // The governor composes this short transition inside its workspace admission transaction.
  return (typeof sql.begin === 'function' ? await sql.begin(run) : await run(sql)) as T;
}

function requireCapability(run: DreamRun): DreamCapabilityRun {
  const value = dreamCapabilityRun(run);
  if (!value) throw new Error('Dream run has no capability provenance');
  return value;
}

/** A permanent capture id survives crashes and triage; no DB connection stays held while capturing. */
export async function reserveDreamRunArtifact(
  sql: Sql,
  input: { workspaceId: string; runId: string },
): Promise<DreamRun> {
  return withLockedDreamRun(sql, input, async (tx, run) => {
    const provenance = requireCapability(run);
    if (provenance.artifactId || run.status !== 'running' || run.review?.verdict !== 'accept') return run;
    provenance.artifactId = 'EI-' + newCollisionResistantIssueTail();
    return saveCapabilityRun(tx, run, provenance);
  });
}

async function saveCapabilityRun(sql: Sql, run: DreamRun, provenance: DreamCapabilityRun): Promise<DreamRun> {
  const totals = dreamCallTotals(provenance.calls);
  const rows = await sql`UPDATE harness_shared.dream_runs SET
    outcome = ${JSON.stringify({ ...run.outcome, capabilityRun: provenance })}::text::jsonb,
    input_tokens = ${totals.inputTokens}, output_tokens = ${totals.outputTokens}, cost_usd = ${totals.costUsd}, updated_at = now()
    WHERE workspace_id = ${run.workspaceId} AND run_id = ${run.runId} AND status = 'running' RETURNING *`;
  if (!rows[0]) throw new Error('Cannot change capability provenance on a terminal run');
  return mapDreamRun(rows[0]);
}

/** Only started:true authorizes dispatch. A reserved call on replay has UNKNOWN outcome. */
export async function beginDreamRunCall(
  sql: Sql,
  input: {
    workspaceId: string;
    runId: string;
    call: Pick<DreamRunCall, 'callId' | 'phase' | 'model' | 'reservedUsd'>;
  },
): Promise<{ started: boolean; run: DreamRun; call: DreamRunCall }> {
  const call = validateDreamRunCall({ ...input.call, status: 'reserved', usage: null, error: null });
  return withLockedDreamRun(sql, input, async (tx, run) => {
    const provenance = requireCapability(run);
    const expectedModel =
      call.phase === 'generation'
        ? provenance.dreamerModel
        : ['control-a', 'control-b', 'review'].includes(call.phase)
          ? provenance.reviewerModel
          : null;
    if (expectedModel && expectedModel !== call.model)
      throw new Error('Paid phase model differs from frozen run versions');
    const saved = provenance.calls.find((c) => c.callId === call.callId);
    if (saved) {
      if (!sameDreamValue({ ...saved, status: 'reserved', usage: null, error: null }, call))
        throw new Error('Paid call identity reused with different admission');
      return { started: false, run, call: saved };
    }
    if (run.status !== 'running' || run.review)
      throw new Error('Cannot dispatch after review or terminal finalization');
    if (provenance.calls.length >= 64) throw new Error('Dream paid-call ledger limit exceeded');
    provenance.calls.push(call);
    return { started: true, run: await saveCapabilityRun(tx, run, provenance), call };
  });
}

export async function settleDreamRunCall(
  sql: Sql,
  input: {
    workspaceId: string;
    runId: string;
    callId: string;
    usage: DreamPassUsage | null;
    error?: string;
  },
): Promise<DreamRun> {
  return withLockedDreamRun(sql, input, async (tx, run) => {
    const provenance = requireCapability(run),
      index = provenance.calls.findIndex((c) => c.callId === input.callId);
    if (index < 0) throw new Error('Paid call was not admitted');
    const saved = provenance.calls[index]!;
    const settled = validateDreamRunCall({
      ...saved,
      status: input.usage ? 'settled' : 'unknown',
      usage: input.usage,
      error: input.error?.slice(0, 4_000) ?? null,
    });
    if (saved.status !== 'reserved') {
      if (!sameDreamValue(saved, settled)) throw new Error('Paid call result is already frozen');
      return run;
    }
    provenance.calls[index] = settled;
    return saveCapabilityRun(tx, run, provenance);
  });
}

/** Persist the reviewed candidate BEFORE any capture/routing side effect. */
export async function recordDreamRunReview(
  sql: Sql,
  input: {
    workspaceId: string;
    runId: string;
    outcome: Record<string, unknown>;
    review: Record<string, unknown>;
  },
): Promise<DreamRun> {
  return withLockedDreamRun(sql, input, async (tx, run) => {
    const provenance = requireCapability(run);
    if (Object.hasOwn(input.outcome, 'capabilityRun') || Object.hasOwn(input.outcome, 'assessments'))
      throw new Error('Capability provenance is owned by the run ledger');
    const outcome = { ...input.outcome, capabilityRun: provenance };
    if (run.review) {
      if (!sameDreamValue(run.review, input.review) || !sameDreamValue(run.outcome, outcome))
        throw new Error('Reviewed dream is already frozen');
      return run;
    }
    const insight = input.outcome.insight as Record<string, unknown> | undefined;
    const candidate = CapabilityProposalSchema.parse(insight?.capability);
    if (
      provenance.sampling?.status !== 'selected' ||
      input.review.schemaVersion !== CAPABILITY_REVIEW_VERSION ||
      input.review.candidateHash !== capabilityProposalHash(candidate) ||
      input.review.evidenceHash !== capabilityReviewEvidenceHash(provenance.sampling.selection)
    )
      throw new Error('Review does not bind this candidate and selection');
    if (provenance.calls.some((c) => c.status === 'reserved'))
      throw new Error('Drain paid calls before freezing review');
    const reviewUsage = DreamCallUsageSchema.parse(input.review.usage);
    const calls = provenance.calls.filter((c) => ['control-a', 'control-b', 'review'].includes(c.phase));
    const totals = dreamCallTotals(calls);
    if (
      reviewUsage.model !== provenance.reviewerModel ||
      (totals.costBasis === 'actual' &&
        (Math.abs(totals.costUsd - reviewUsage.costUsd) > 1e-9 ||
          totals.inputTokens !== reviewUsage.inputTokens ||
          totals.outputTokens !== reviewUsage.outputTokens))
    )
      throw new Error('Review usage does not reconcile to governed phase calls');
    if (
      input.review.verdict === 'accept' &&
      (dreamCallTotals(provenance.calls).costBasis !== 'actual' ||
        !['generation', 'control-a', 'control-b', 'review'].every((phase) =>
          provenance.calls.some((c) => c.phase === phase),
        ))
    )
      throw new Error('Accepted review requires all governed generation and review calls');
    if (run.status !== 'running') throw new Error('Cannot review a terminal dream run');
    const rows = await tx`UPDATE harness_shared.dream_runs SET
      outcome = ${JSON.stringify(outcome)}::text::jsonb, review = ${JSON.stringify(input.review)}::text::jsonb,
      reviewer_model = ${provenance.reviewerModel}, updated_at = now()
      WHERE workspace_id = ${run.workspaceId} AND run_id = ${run.runId} RETURNING *`;
    return mapDreamRun(rows[0]!);
  });
}

export interface FinalizeDreamRunInput {
  workspaceId: string;
  runId: string;
  status: DreamRunTerminalStatus;
  dreamUsage?: DreamPassUsage | null;
  reviewUsage?: DreamReviewUsage | null;
  outcome?: Record<string, unknown> | null;
  review?: Record<string, unknown> | null;
  routedRef?: string | null;
  error?: string | null;
}

/** Terminal, write-once finalize. A replay returns the existing terminal row unchanged. */
export async function finalizeDreamRun(sql: Sql, input: FinalizeDreamRunInput): Promise<DreamRun> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  if (!DREAM_RUN_TERMINAL_STATUSES.includes(input.status)) {
    throw new RangeError(`unsupported terminal dream status ${input.status}`);
  }
  return withLockedDreamRun(sql, { workspaceId, runId }, async (tx, existing) => {
    if (existing.status !== 'running') return existing;
    const provenance = dreamCapabilityRun(existing);
    if (input.outcome && (Object.hasOwn(input.outcome, 'capabilityRun') || Object.hasOwn(input.outcome, 'assessments')))
      throw new Error('Capability provenance is owned by the run ledger');
    const frozenOutcome = provenance && existing.review ? existing.outcome : null;
    if (
      frozenOutcome &&
      ((input.outcome && !sameDreamValue({ ...input.outcome, capabilityRun: provenance }, frozenOutcome)) ||
        (input.review && !sameDreamValue(input.review, existing.review)))
    )
      throw new Error('Cannot replace a frozen reviewed dream');
    const usages = [input.dreamUsage, input.reviewUsage].filter(
      (usage): usage is DreamPassUsage | DreamReviewUsage => usage != null,
    );
    for (const usage of usages) {
      if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)
        throw new RangeError('dream usage cost must be non-negative');
      if (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0)
        throw new RangeError('dream input tokens must be non-negative integers');
      if (!Number.isInteger(usage.outputTokens) || usage.outputTokens < 0)
        throw new RangeError('dream output tokens must be non-negative integers');
    }
    if (provenance && input.status === 'accepted' && (existing.review?.verdict !== 'accept' || !existing.routedRef))
      throw new Error('Accepted capability run must be reviewed and sunk before finalization');
    const totals = provenance
      ? dreamCallTotals(provenance.calls)
      : {
          inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
          outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
          costUsd: usages.reduce((sum, usage) => sum + usage.costUsd, 0),
        };
    if (provenance) {
      for (const [summary, phases] of [
        [input.dreamUsage, ['generation']],
        [input.reviewUsage, ['control-a', 'control-b', 'review']],
      ] as const) {
        if (!summary) continue;
        DreamCallUsageSchema.parse(summary);
        const group = dreamCallTotals(provenance.calls.filter((c) => (phases as readonly string[]).includes(c.phase)));
        if (
          group.costBasis !== 'actual' ||
          Math.abs(summary.costUsd - group.costUsd) > 1e-9 ||
          summary.inputTokens !== group.inputTokens ||
          summary.outputTokens !== group.outputTokens
        )
          throw new Error('Aggregate usage does not reconcile to governed phase calls');
      }
    }
    const { inputTokens, outputTokens, costUsd } = totals;
    const reviewerModel = input.reviewUsage?.model ?? null;
    const error = input.error?.trim().slice(0, 4_000) || null;

    const rows = (await tx`
    UPDATE harness_shared.dream_runs
       SET status = ${input.status},
           reviewer_model = COALESCE(${reviewerModel}, reviewer_model),
           dream_usage = ${JSON.stringify(input.dreamUsage ?? null)}::text::jsonb,
           review_usage = ${JSON.stringify(input.reviewUsage ?? null)}::text::jsonb,
           outcome = ${JSON.stringify(frozenOutcome ?? (provenance ? { ...input.outcome, capabilityRun: provenance } : (input.outcome ?? null)))}::text::jsonb,
           review = ${JSON.stringify(input.review ?? existing.review)}::text::jsonb,
           routed_ref = ${existing.routedRef ?? input.routedRef ?? null},
           input_tokens = ${inputTokens},
           output_tokens = ${outputTokens},
           cost_usd = ${costUsd},
           error = ${error},
           completed_at = now(),
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId} AND status = 'running'
     RETURNING *`) as Row[];
    const run = rows[0] ? mapDreamRun(rows[0]) : null;
    if (!run) throw new Error(`dream-run-store: finalize target not found ${workspaceId}/${runId}`);
    return run;
  });
}

export async function listDreamRuns(
  sql: Sql,
  input: { workspaceId: string; potSlug?: string; cycleId?: string; limit?: number },
): Promise<DreamRun[]> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 500);
  const rows = (await sql`
    SELECT * FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId}
       ${input.potSlug ? sql`AND pot_slug = ${input.potSlug}` : sql``}
       ${input.cycleId ? sql`AND cycle_id = ${input.cycleId}` : sql``}
     ORDER BY started_at DESC, run_id DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapDreamRun);
}

/** Append a separately authored assessment without rewriting terminal provenance or spend. */
export async function recordDreamRunAssessment(
  sql: Sql,
  input: { workspaceId: string; runId: string; assessment: Omit<DreamRunAssessment, 'recordedAt'> },
): Promise<DreamRun> {
  return withLockedDreamRun(sql, input, async (tx, run) => {
    const provenance = requireCapability(run);
    if (run.status === 'running' || !run.review) throw new Error('Assess a terminal reviewed Dream proposal');
    const candidate = CapabilityProposalSchema.parse((run.outcome?.insight as Record<string, unknown>)?.capability);
    const assessments = dreamRunAssessments(run);
    const previous = assessments.find((a) => a.id === input.assessment.id);
    const assessment = DreamRunAssessmentSchema.parse({
      ...input.assessment, recordedAt: previous?.recordedAt ?? new Date().toISOString(),
    });
    if (assessment.candidateHash !== capabilityProposalHash(candidate) ||
        assessment.candidateHash !== run.review.candidateHash ||
        assessment.evidenceHash !== run.review.evidenceHash)
      throw new Error('Assessment does not bind the frozen proposal and review evidence');
    if ([provenance.dreamerModel, provenance.reviewerModel].includes(assessment.assessor))
      throw new Error('Assessment must name its separate assessor, not reuse a generating model identity');
    if (previous) {
      if (!sameDreamValue(previous, assessment)) throw new Error('Assessment identity is immutable');
      return run;
    }
    if (assessments.length >= 16) throw new Error('Dream assessment history is full');
    const rows = await tx`UPDATE harness_shared.dream_runs
      SET outcome = ${JSON.stringify({ ...run.outcome, assessments: [...assessments, assessment] })}::text::jsonb,
          updated_at = now()
      WHERE workspace_id = ${run.workspaceId} AND run_id = ${run.runId} RETURNING *`;
    return mapDreamRun(rows[0]!);
  });
}
