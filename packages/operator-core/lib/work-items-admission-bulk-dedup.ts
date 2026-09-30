/**
 * Staged bulk work-item deduplication (work-queue-admission-and-bulk-dedup P-006).
 *
 * The census owns corpus selection, >=0.90 hard components, 0.85–0.90 ghost
 * context, and deterministic shard packing. This runner consumes that exact
 * pinned shard map, applies the promoter's duplication-only charter/code set,
 * and commits each stage only when a fresh census satisfies the monotone
 * non-increase ratchet. A rise rolls the whole stage back and leaves a failed
 * `bulk-stage` ledger row outside the transaction.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { isLlmCallError } from '@papercusp/testing-shell/llm';
import { admissionIdentity } from './harness/improvements/digest';
import { isTransientNetworkError } from './harness/routines/hetzner-orphan-frame-reaper';
import { LEARNING_MODEL_SPEC } from './learning/model-policy';
import { withWorkItemDependencyAdmissionTransaction } from './dbos/work-item-deps-store';
import {
  ADMISSION_COMPONENT_FLOOR,
  lexicalHardEdges,
  readAdjudicatedPairKeys,
  runWorkItemAdmissionCensus,
  type AdmissionCensusRunOptions,
  type AdmissionCensusRunResult,
} from './work-items-admission-census';
import {
  admissionPairKey,
  bindAdmissionMergeSnapshot,
  buildPromoterPrompt,
  parsePromoterJudgements,
  persistAdmissionPlan,
  planPromoterDispositions,
  promoterEvidenceForPrompt,
  readAdmissionMergeSnapshots,
  responsePayload,
  selectAdmissionRecurrenceCanonicals,
  type AdmissionMergeGuardRefusal,
  type AdmissionPlanPersistenceResult,
  type AdmissionRunOutcome,
  type PromoterItem,
  type PromoterJudgement,
  type PromoterLlmCall,
  type PromoterPair,
  type PromoterPlan,
} from './work-items-admission-promoter';
import {
  failedAdmissionMergeQualityReport,
  admissionMergeQualityHash,
  isCurrentAdmissionMergeQualityPass,
  prepareAdmissionMergeQualityGate,
  scoreAdmissionMergeQualityGate,
  type AdmissionMergeQualityPreparedGate,
  type AdmissionMergeQualityReport,
} from './work-items-admission-merge-quality';
import type { OrgSql } from './work-items';

export const WORK_ITEM_ADMISSION_BULK_DEDUP = 'work-item-admission-bulk-dedup';
export const BULK_DEDUP_ACTOR = `system:${WORK_ITEM_ADMISSION_BULK_DEDUP}`;
export const DEFAULT_BULK_MAX_STAGES = 12;
export const DEFAULT_BULK_PAIRS_PER_CALL = 150;
/**
 * Output-token budget for ONE judge batch, and the per-pair/overhead rates the
 * batch size is derived from.
 *
 * These three numbers and `pairsPerCall` are ONE constraint, not four settings.
 * Before 2026-08-29 they disagreed: the call site asked for
 * `Math.min(8_000, 500 + batch.length * 180)`, so a default 150-pair batch
 * computed a 27,500-token need and was silently clamped to 8,000 — a 3.4x
 * shortfall. The model then ran out of output mid-JSON, `responsePayload`
 * returned null, and `parsePromoterJudgements` threw
 * `expected object, received null`. Because the truncation is DETERMINISTIC in
 * the batch size, every retry re-sent the same oversized batch and failed
 * identically, so the bounded retry could only burn the budget, never recover.
 *
 * Measured on run wi882767-opus5-20260829-stage-1 (claude-opus-5:xhigh, 1770
 * pairs): modelCalls 12, modelRetries 36 (= 12 batches x the 3-retry maximum,
 * i.e. EVERY batch exhausted), protocolFailures 46, exhaustedBatches 10 of 12,
 * merged 0. tokens_out averaged 7,974 across 48 calls — flush against the 8,000
 * ceiling, which is the signature of truncation rather than a model that cannot
 * follow the schema. Only the two batches small enough to fit survived.
 *
 * The fix is to DERIVE the batch size from the budget (see
 * {@link maxPairsForOutputBudget}) so a batch can never be issued that its own
 * token budget cannot hold. Raising the ceiling instead would trade a known-
 * workable limit for a guess about a specific model's maximum output.
 */
export const BULK_JUDGE_MAX_OUTPUT_TOKENS = 8_000;
export const BULK_JUDGE_TOKENS_PER_PAIR = 180;
export const BULK_JUDGE_TOKEN_OVERHEAD = 500;

/**
 * The largest pair batch whose judgements fit in `maxOutputTokens`. This is the
 * single place the batch/budget relationship is expressed; the clamp on
 * `pairsPerCall` and the `maxTokens` passed to the model both read from it, so
 * they cannot drift apart again.
 */
export function maxPairsForOutputBudget(maxOutputTokens: number = BULK_JUDGE_MAX_OUTPUT_TOKENS): number {
  return Math.max(1, Math.floor((maxOutputTokens - BULK_JUDGE_TOKEN_OVERHEAD) / BULK_JUDGE_TOKENS_PER_PAIR));
}

/** Output tokens a batch of `pairs` judgements needs. Never exceeds the ceiling
 * for a batch sized by {@link maxPairsForOutputBudget}. */
export function bulkJudgeMaxTokens(pairs: number): number {
  return BULK_JUDGE_TOKEN_OVERHEAD + pairs * BULK_JUDGE_TOKENS_PER_PAIR;
}
export const DEFAULT_BULK_SHARD_CONCURRENCY = 4;
/** Bounded retries for a single model batch. A successful earlier batch stays
 * in memory, so only the failed batch is replayed. */
export const DEFAULT_BULK_BATCH_RETRY_BACKOFFS_MS = [500, 1_500, 4_000] as const;
export const BULK_STAGE_SCHEMA_VERSION = 'work-item-admission-bulk-stage-v2';
export const BULK_BATCH_CHECKPOINT_SCHEMA_VERSION = 'work-item-admission-bulk-batch-v1';
/** A live owner refreshes this lease before and after every batch. Two hours is
 * deliberately much longer than one normal model call, while still letting a
 * dead routine be reclaimed without manual row surgery. */
export const DEFAULT_BULK_STAGE_LEASE_MS = 2 * 60 * 60_000;

export type BulkDedupScope = 'full-corpus' | 'machine-emitter-targeted';

interface BulkMapRow {
  shard_id: number;
  item_id: string;
  role: 'member' | 'ghost';
  title: string | null;
  summary: string | null;
  status: string | null;
  item_kind: string | null;
  admission: string | null;
  condition_key: string | null;
  watchdog_key: string | null;
  title_key: string | null;
  created_ts: string | number | null;
}

interface BulkEdgeRow {
  a: string;
  b: string;
  cos: string | number;
  a_shard: number;
  b_shard: number;
}

export type BulkDedupItem = PromoterItem & { watchdogKey: string | null };

interface BulkInput {
  items: Map<string, BulkDedupItem>;
  pairs: PromoterPair[];
  pairShard: Map<string, number>;
  ghostIdsByShard: Map<number, string[]>;
  memberCount: number;
  fingerprint: string;
}

interface BulkBatchCheckpoint {
  schemaVersion: typeof BULK_BATCH_CHECKPOINT_SCHEMA_VERSION;
  key: string;
  shard: number;
  offset: number;
  pairKeys: string[];
  canary: boolean;
  status: 'complete';
  judgements: PromoterJudgement[];
  modelCalls: number;
  modelRetries: number;
  modelProtocolFailures: number;
  modelProtocolExhaustedBatches: number;
  modelProtocolLastError: string | null;
  ignoredUnknownJudgements: number;
  omittedExpectedJudgements: number;
  tokensIn: number;
  tokensOut: number;
  servedAccounts: string[];
  completedAt: number;
}

interface BulkStageLease {
  ownerId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  takeoverCount: number;
}

interface BulkStageEnvelope {
  schemaVersion: string;
  status?: string;
  mode?: string;
  scope?: BulkDedupScope;
  sourceCensusRunId?: string;
  inputFingerprint?: string;
  lease?: BulkStageLease;
  preflight?: BulkDedupPreflightResult;
  canary?: { status: 'pending' | 'passed' | 'failed'; batchKey?: string; reason?: string; servedAccount?: string };
  /** D-007 frozen independent-label replay. Kept in the existing stage
   * envelope so no second run ledger or label table can retire production
   * pairs from the census. */
  mergeQuality?: AdmissionMergeQualityReport;
  mergeQualityHistory?: Array<{
    gateKey?: string;
    status?: string;
    datasetHash?: string;
    promptHash?: string;
    thresholdHash?: string;
    recordedAt: string;
  }>;
  checkpoints?: { batches?: Record<string, BulkBatchCheckpoint> };
  failure?: { class: string; message: string; retryable: boolean };
  [key: string]: unknown;
}

export interface BulkModelFailureClassification {
  kind: 'transport' | 'protocol' | 'capacity' | 'quality' | 'guard' | 'lease' | 'unknown';
  class: string;
  retryable: boolean;
  message: string;
}

export class BulkAdmissionBlockedError extends Error {
  readonly classification: BulkModelFailureClassification;
  constructor(message: string, classification: BulkModelFailureClassification) {
    super(message);
    this.name = 'BulkAdmissionBlockedError';
    this.classification = classification;
  }
}

export class BulkAdmissionMergeGuardBlockedError extends BulkAdmissionBlockedError {
  readonly persistence: AdmissionPlanPersistenceResult;
  constructor(persistence: AdmissionPlanPersistenceResult) {
    const summary = persistence.guardRefusals
      .slice(0, 5)
      .map((refusal) => `${refusal.itemId}:${refusal.reason}`)
      .join(', ');
    super(`bulk admission merge guard refused ${persistence.guardRefusals.length} endpoint(s): ${summary}`, {
      kind: 'guard',
      class: 'merge_guard_refused',
      retryable: true,
      message: summary,
    });
    this.name = 'BulkAdmissionMergeGuardBlockedError';
    this.persistence = persistence;
  }
}

export class BulkRunActiveError extends Error {
  readonly ownerId: string;
  readonly expiresAt: number;
  constructor(ownerId: string, expiresAt: number) {
    super(`bulk admission run is already active under ${ownerId} until ${new Date(expiresAt).toISOString()}`);
    this.name = 'BulkRunActiveError';
    this.ownerId = ownerId;
    this.expiresAt = expiresAt;
  }
}

export interface BulkDedupStageResult {
  runId: string;
  sourceCensusRunId: string;
  resultCensusRunId: string;
  scope: BulkDedupScope;
  pairs: number;
  merged: number;
  held: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  modelRetries: number;
  modelProtocolFailures: number;
  modelProtocolExhaustedBatches: number;
  ignoredUnknownJudgements: number;
  omittedExpectedJudgements: number;
  censusBefore: number;
  censusAfter: number;
  scopedPairsAfter: number;
  /** Accounts that actually served at least one model response in this stage. */
  servedAccounts: string[];
  /** Model batches recovered from the durable stage envelope rather than called again. */
  reusedBatches: number;
  /** D-007 report for the frozen independent-label replay (non-empty stages). */
  mergeQuality?: AdmissionMergeQualityReport;
  /** Exact protected/drifted endpoints the shared writer refused. */
  guardRefusals?: AdmissionMergeGuardRefusal[];
}

export interface BulkDedupRunResult {
  runId: string;
  scope: BulkDedupScope;
  converged: boolean;
  convergenceReason: 'global-zero' | 'scope-zero';
  initialCensus: number;
  finalCensus: number;
  finalScopedPairs: number;
  stages: BulkDedupStageResult[];
}

type CensusRunner = (opts: AdmissionCensusRunOptions) => Promise<AdmissionCensusRunResult>;

export type BulkDedupModelProvider = 'claude' | 'codex' | 'unknown';

export interface BulkDedupPreflightResult {
  status: 'ready' | 'unknown' | 'blocked';
  provider: BulkDedupModelProvider;
  model: string;
  checkedAt: string;
  reason: string;
  /** Bounded, JSON-safe evidence from the reused account/gateway capacity readers. */
  evidence?: Record<string, unknown>;
}

export type BulkDedupPreflight = (input: {
  workspaceId: string;
  harnessSlug: string;
  model: string;
  ownerId?: string;
}) => Promise<BulkDedupPreflightResult>;

/** DBOS-backed in production, direct in focused/integration tests. Step names
 * are deterministic within one root run so DBOS can replay completed phases. */
export type BulkDedupStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface BulkDedupRunOptions {
  workspaceId: string;
  harnessSlug: string;
  llmCall: PromoterLlmCall;
  sql?: OrgSql;
  runId?: string;
  maxStages?: number;
  pairsPerCall?: number;
  shardConcurrency?: number;
  census?: Omit<AdmissionCensusRunOptions, 'workspaceId' | 'harnessSlug' | 'sql' | 'runId' | 'withinTransaction'>;
  now?: () => number;
  /** Stable owner identity for gateway attribution across retries/replays. */
  ownerId?: string;
  /** Dependency seam used by the real-PG recurrence guard to inject a census rise. */
  beforePostStageCensus?: (sql: OrgSql, stageIndex: number) => Promise<void>;
  /**
   * Model spec for this run's judging calls. Defaults to {@link LEARNING_MODEL_SPEC}.
   *
   * The default is the owner-directed learning policy and stays that way; this
   * override exists so ONE run can be driven onto a different backend without
   * re-pointing every learning path at it — the case that matters here is the
   * canonical Sol model being TRANSIENTLY unreachable, which failed three of
   * the four bulk-stage attempts on 2026-08-27/28.
   *
   * ⚠ DO NOT READ THIS AS "gpt-5.6-sol:xhigh is unsupported on ChatGPT accounts."
   * An earlier revision of this comment quoted `The 'gpt-5.6-sol:xhigh' model is
   * not supported when using Codex with a ChatGPT account` as ONE OF TWO candidate
   * causes for that incident (the other being a usage-walled codex pool). It was a
   * note about one moment, not a statement about the platform — but it read as a
   * standing capability constraint, and on 2026-08-31 an agent sizing a fleet found
   * it, treated it as live, and nearly re-planned the launch around avoiding
   * `:xhigh`. gpt-5.6-sol is the ROUTINE fleet model here and xhigh IS launched on
   * it regularly (owner, 2026-08-31). The quoted string is kept only so the phrase
   * stays greppable for the next person who hits it — explicitly labelled NOT
   * CURRENT.
   *
   * The general lesson, which is why this warning is longer than the note it
   * corrects: a dated incident recorded in a comment is evidence about one moment,
   * and the next reader will silently promote it to a standing fact about the
   * system — the more specific the quoted error string, the more authoritative it
   * reads. Date the incident, and say what it is NOT.
   *
   * Whatever is resolved here is what gets WRITTEN to `admission_runs.model_id`,
   * so the ledger reports the model that actually ran rather than the policy
   * constant. A ledger that names a model the run did not use is worse than an
   * empty column: it reads as evidence.
   */
  model?: string;
  /** Injectable bounded backoff for transient model transport failures. */
  batchRetryBackoffsMs?: readonly number[];
  /** Injectable sleep seam for retry tests; production uses setTimeout. */
  batchRetryDelay?: (ms: number) => Promise<void>;
  runCensus?: CensusRunner;
  /** Model/account capacity check. Production supplies the shared probe/readers;
   * direct tests may omit it, which is recorded as unknown and then proven by
   * the mandatory one-batch canary. */
  preflight?: BulkDedupPreflight;
  /** Durable phase checkpoint seam (`runCheckpointedStep` in the routine). */
  step?: BulkDedupStepRunner;
  /** Stable owner of the stage lease. Production passes DBOS.workflowID. */
  executionId?: string;
  /** Injectable stale threshold for recovery tests. */
  stageLeaseMs?: number;
}

function finiteMs(value: string | number | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function itemFromRow(row: BulkMapRow): BulkDedupItem {
  return {
    id: row.item_id,
    title: row.title ?? '',
    summary: row.summary ?? '',
    state: row.status ?? 'open',
    kind: row.item_kind ?? 'task',
    admission: row.admission,
    conditionKey: row.condition_key,
    watchdogKey: row.watchdog_key,
    createdAtMs: finiteMs(row.created_ts),
  };
}

/**
 * Backward-compatible bulk name for the one recurrence selector shared with
 * normal admission. Keeping this export avoids splitting callers while the
 * implementation and invariant live at the common promoter seam.
 */
export function guardBulkRecurrenceIdentity(
  plan: PromoterPlan,
  items: ReadonlyMap<string, BulkDedupItem>,
): PromoterPlan {
  return selectAdmissionRecurrenceCanonicals(plan, items);
}

function signalsForBulk(a: PromoterItem, b: PromoterItem): PromoterPair['signals'] {
  const signals: PromoterPair['signals'] = ['cosine'];
  if (a.conditionKey && a.conditionKey === b.conditionKey) signals.unshift('condition-key');
  if (admissionIdentity(a.title).titleKey === admissionIdentity(b.title).titleKey) signals.unshift('title-key');
  return [...new Set(signals)];
}

async function readBulkInput(
  sql: OrgSql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    censusRunId: string;
    expectedMembers: number;
    scope: BulkDedupScope;
  },
): Promise<BulkInput> {
  const mapRows = await sql<BulkMapRow[]>`
    SELECT sm.shard_id, sm.item_id, sm.role,
           wi.title, wi.summary, wi.status, wi.item_kind, wi.admission,
           wi.condition_key, wi.payload #>> '{watchdogKey}' AS watchdog_key,
           wi.payload #>> '{admissionIdentity,titleKey}' AS title_key,
           wi.created_ts
      FROM harness_shared.dedup_shard_map sm
      JOIN harness_shared.work_items wi
        ON wi.workspace_id = sm.workspace_id
       AND wi.harness_slug = sm.harness_slug
       AND wi.feature_id = sm.item_id
     WHERE sm.workspace_id = ${input.workspaceId}
       AND sm.harness_slug = ${input.harnessSlug}
       AND sm.run_id = ${input.censusRunId}
     ORDER BY sm.shard_id, sm.role, sm.item_id`;

  const memberRows = mapRows.filter((row) => row.role === 'member');
  const memberIds = new Set(memberRows.map((row) => row.item_id));
  if (memberRows.length !== input.expectedMembers || memberIds.size !== input.expectedMembers) {
    throw new Error(
      `bulk snapshot member coverage mismatch: rows=${memberRows.length}, unique=${memberIds.size}, expected=${input.expectedMembers}`,
    );
  }

  const items = new Map<string, BulkDedupItem>();
  for (const row of mapRows) if (!items.has(row.item_id)) items.set(row.item_id, itemFromRow(row));
  const edgeRows = await sql<BulkEdgeRow[]>`
    WITH homes AS MATERIALIZED (
      SELECT item_id, shard_id
        FROM harness_shared.dedup_shard_map
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND run_id = ${input.censusRunId}
         AND role = 'member'
    )
    SELECT e.a, e.b, e.cos, ha.shard_id AS a_shard, hb.shard_id AS b_shard
      FROM harness_shared.dedup_edges e
      JOIN homes ha ON ha.item_id = e.a
      JOIN homes hb ON hb.item_id = e.b
      LEFT JOIN harness_shared.dedup_adjudications d
        ON d.workspace_id = e.workspace_id
       AND d.harness_slug = e.harness_slug
       AND d.a = e.a AND d.b = e.b
     WHERE e.workspace_id = ${input.workspaceId}
       AND e.harness_slug = ${input.harnessSlug}
       AND e.cos >= ${ADMISSION_COMPONENT_FLOOR}
       AND d.a IS NULL
     ORDER BY e.a, e.b`;

  const pairs: PromoterPair[] = [];
  const pairShard = new Map<string, number>();
  for (const row of edgeRows) {
    const a = items.get(row.a);
    const b = items.get(row.b);
    if (!a || !b) throw new Error(`bulk snapshot edge endpoint missing from pinned map: ${row.a}::${row.b}`);
    if (input.scope === 'machine-emitter-targeted' && (!a.conditionKey || !b.conditionKey)) continue;
    const pairKey = admissionPairKey(a.id, b.id);
    pairs.push({
      pairKey,
      a,
      b,
      pendingIds: [a.id, b.id].sort(),
      signals: signalsForBulk(a, b),
      cosine: Number(row.cos),
    });
    pairShard.set(pairKey, Math.min(Number(row.a_shard), Number(row.b_shard)));
  }

  // WI-2140406 F2 (EI-22068819110487948): the cosine edge query above can only
  // surface pairs that HAVE an embedding-cosine edge >= 0.90. The measured
  // zero-delivery shape is 1,800+ identical-title twins with NO edge at all
  // (embeddings lagging, or landed with divergent summaries), and 1,821/1,822
  // of them carry NULL condition_key — so the targeted-scope filter above would
  // have dropped them even with an edge. Materialize identity pairs (persisted
  // titleKey / normalized title / condition_key) over the pinned member set,
  // with the same adjudication exclusion the cosine query gets from its
  // anti-join. Identity IS the machine signal, so lexical pairs are admitted in
  // every scope; `cosine: null` keeps the judge prompt honest ('n/a').
  const lexicalEdges = lexicalHardEdges(
    memberRows.map((row) => ({
      id: row.item_id,
      title: row.title ?? '',
      titleKey: row.title_key,
      conditionKey: row.condition_key,
    })),
  );
  if (lexicalEdges.length > 0) {
    const adjudicated = await readAdjudicatedPairKeys(sql, input, [...memberIds]);
    const memberShard = new Map(memberRows.map((row) => [row.item_id, row.shard_id]));
    const titleKeyByItem = new Map(memberRows.map((row) => [row.item_id, row.title_key]));
    const existingPairKeys = new Set(pairs.map((pair) => pair.pairKey));
    for (const edge of lexicalEdges) {
      if (adjudicated.has(`${edge.a}\0${edge.b}`)) continue;
      const pairKey = admissionPairKey(edge.a, edge.b);
      if (existingPairKeys.has(pairKey)) continue;
      const a = items.get(edge.a);
      const b = items.get(edge.b);
      if (!a || !b) throw new Error(`bulk lexical pair endpoint missing from pinned map: ${edge.a}::${edge.b}`);
      const signals: PromoterPair['signals'] = [];
      if (a.conditionKey && a.conditionKey === b.conditionKey) signals.push('condition-key');
      const keyA = titleKeyByItem.get(edge.a);
      const keyB = titleKeyByItem.get(edge.b);
      if (
        (keyA != null && keyA === keyB) ||
        admissionIdentity(a.title).titleKey === admissionIdentity(b.title).titleKey
      ) {
        signals.push('title-key');
      }
      pairs.push({ pairKey, a, b, pendingIds: [a.id, b.id].sort(), signals, cosine: null });
      pairShard.set(pairKey, Math.min(memberShard.get(edge.a)!, memberShard.get(edge.b)!));
      existingPairKeys.add(pairKey);
    }
  }

  // Bind every destructive endpoint to one complete, versioned evidence and
  // reference snapshot before any model batch is built. Ghost-only context
  // remains lean because it can never be mutated by this stage.
  const endpointIds = [...new Set(pairs.flatMap((pair) => [pair.a.id, pair.b.id]))].sort();
  const snapshotsById = await readAdmissionMergeSnapshots(sql, {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    ids: endpointIds,
  });
  for (const id of endpointIds) {
    const item = items.get(id);
    if (!item) continue;
    const bound = bindAdmissionMergeSnapshot(item, snapshotsById.get(id));
    items.set(id, { ...item, ...bound });
  }
  for (const pair of pairs) {
    pair.a = items.get(pair.a.id) ?? pair.a;
    pair.b = items.get(pair.b.id) ?? pair.b;
  }

  const ghostIdsByShard = new Map<number, string[]>();
  for (const row of mapRows) {
    if (row.role !== 'ghost') continue;
    ghostIdsByShard.set(row.shard_id, [...(ghostIdsByShard.get(row.shard_id) ?? []), row.item_id]);
  }
  for (const [shard, ids] of ghostIdsByShard) ghostIdsByShard.set(shard, [...new Set(ids)].sort());

  const fingerprint = createHash('sha256')
    .update(
      pairs
        .map(
          (pair) =>
            `${pair.pairKey}\x00${pairShard.get(pair.pairKey) ?? -1}\x00` +
            `${pair.a.mergeSnapshot?.fingerprint ?? 'missing'}\x00${pair.b.mergeSnapshot?.fingerprint ?? 'missing'}`,
        )
        .join('\x01'),
    )
    .digest('hex');
  return { items, pairs, pairShard, ghostIdsByShard, memberCount: memberRows.length, fingerprint };
}

export function buildBulkDedupPrompt(
  pairs: readonly PromoterPair[],
  ghostItems: readonly PromoterItem[],
): { system: string; user: string } {
  const system = buildPromoterPrompt([]).system;
  const endpointItems = new Map<string, PromoterItem>();
  for (const pair of pairs) {
    endpointItems.set(pair.a.id, pair.a);
    endpointItems.set(pair.b.id, pair.b);
  }
  const codeSet = [...endpointItems.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) =>
      [
        `## item ${item.id} state=${item.state} admission=${item.admission ?? 'legacy'} kind=${item.kind}`,
        `<title>${item.title.slice(0, 1_000)}</title>`,
        `<summary>${item.summary.slice(0, 4_000)}</summary>`,
        `<evidence>${promoterEvidenceForPrompt(item)}</evidence>`,
      ].join('\n'),
    )
    .join('\n\n');
  const pairSet = pairs
    .map((pair) => `${pair.pairKey} | signals=${pair.signals.join(',')} | cosine=${pair.cosine?.toFixed(4) ?? 'n/a'}`)
    .join('\n');
  const ghosts = ghostItems
    .filter((item) => !endpointItems.has(item.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (item) =>
        `${item.id} | <title>${item.title.slice(0, 500)}</title> | <summary>${item.summary.slice(0, 1_500)}</summary>`,
    )
    .join('\n');
  const user = [
    '# CODE SET — authoritative pair endpoints',
    codeSet,
    '# PAIRS TO JUDGE',
    pairSet,
    '# READ-ONLY GHOST CONTEXT — context only; never emit a judgement for an unlisted pair',
    ghosts || '(none)',
  ].join('\n\n');
  return { system, user };
}

export function assertAdmissionCensusRatchet(before: number, after: number): void {
  if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) {
    throw new Error(`admission census ratchet requires non-negative integers: before=${before}, after=${after}`);
  }
  if (after > before) {
    throw new Error(`admission census ratchet violated: ${before} -> ${after} (+${after - before})`);
  }
}

interface BulkStageRow {
  id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  detail: BulkStageEnvelope | null;
}

function parseStageEnvelope(value: unknown): BulkStageEnvelope {
  if (!value || typeof value !== 'object') return { schemaVersion: BULK_STAGE_SCHEMA_VERSION };
  const envelope = { ...(value as Record<string, unknown>) } as BulkStageEnvelope;
  // Older rows predate the resumability envelope. Treat them as v2-shaped
  // defaults while preserving every field they did record; this keeps a
  // partially written/legacy row readable and makes the parser's type contract
  // match the durable default used by beginBulkStage.
  if (typeof envelope.schemaVersion !== 'string' || envelope.schemaVersion.length === 0) {
    envelope.schemaVersion = BULK_STAGE_SCHEMA_VERSION;
  }
  return envelope;
}

function stageStatus(envelope: BulkStageEnvelope): string {
  return typeof envelope.status === 'string' ? envelope.status : 'running';
}

function stageWasStale(
  row: Pick<BulkStageRow, 'started_at' | 'finished_at'>,
  envelope: BulkStageEnvelope,
  nowMs: number,
  leaseMs: number,
): boolean {
  if (row.finished_at != null || stageStatus(envelope) !== 'running') return false;
  const leaseExpiry = Number(envelope.lease?.expiresAt);
  if (Number.isFinite(leaseExpiry) && leaseExpiry > 0) return leaseExpiry <= nowMs;
  const started = row.started_at instanceof Date ? row.started_at.getTime() : Date.parse(String(row.started_at));
  return Number.isFinite(started) && nowMs - started >= leaseMs;
}

function modelProvider(model: string): BulkDedupModelProvider {
  return /^(gpt-|chatgpt:|openai-codex\/)/i.test(model.trim()) ? 'codex' : model.trim() ? 'claude' : 'unknown';
}

/** Classify a bulk-run failure once, preserving the structured transport
 * verdict instead of making downstream readers infer it from prose. */
export function classifyBulkModelFailure(
  error: unknown,
  kind: BulkModelFailureClassification['kind'] = 'unknown',
): BulkModelFailureClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BulkAdmissionBlockedError) return error.classification;
  if (isLlmCallError(error)) {
    const turn = error.turn as { class?: unknown; retryable?: unknown };
    return {
      kind: kind === 'unknown' ? 'transport' : kind,
      class: typeof turn.class === 'string' ? turn.class : 'transport_error',
      retryable: turn.retryable === true,
      message,
    };
  }
  return {
    kind: kind === 'protocol' ? 'protocol' : kind,
    class: kind === 'protocol' ? 'protocol_error' : isTransientNetworkError(error) ? 'transient_io' : 'unknown',
    retryable: isTransientNetworkError(error),
    message,
  };
}

/** Reuse the gateway's live headroom reader for a cheap, bounded preflight.
 * An unreachable gateway is recorded as UNKNOWN (the canary remains the
 * authoritative serviceability proof); an observed zero-capacity pool blocks
 * before spending a model call. */
export async function defaultBulkDedupPreflight(input: {
  workspaceId: string;
  harnessSlug: string;
  model: string;
  ownerId?: string;
}): Promise<BulkDedupPreflightResult> {
  const provider = modelProvider(input.model);
  const checkedAt = new Date().toISOString();
  if (provider === 'unknown') {
    return { status: 'blocked', provider, model: input.model, checkedAt, reason: 'model is empty or unresolvable' };
  }
  try {
    const { fetchGatewayHeadroom } = await import('./inference-gateway/observability');
    const headroom = await fetchGatewayHeadroom({ provider, timeoutMs: 1_500 });
    if (!headroom.reachable) {
      return {
        status: 'unknown',
        provider,
        model: input.model,
        checkedAt,
        reason: headroom.error ?? 'gateway headroom could not be read',
        evidence: { reachable: false },
      };
    }
    if (headroom.healthyAccounts === undefined) {
      return {
        status: 'unknown',
        provider,
        model: input.model,
        checkedAt,
        reason: 'gateway is reachable but does not report provider account capacity',
        evidence: { reachable: true, healthyAccounts: null, queueDepth: headroom.queueDepth ?? null },
      };
    }
    if (headroom.healthyAccounts === 0) {
      return {
        status: 'blocked',
        provider,
        model: input.model,
        checkedAt,
        reason: 'gateway reports zero healthy accounts',
        evidence: { reachable: true, healthyAccounts: 0, queueDepth: headroom.queueDepth ?? null },
      };
    }
    return {
      status: 'ready',
      provider,
      model: input.model,
      checkedAt,
      reason: 'gateway reports serviceable capacity',
      evidence: {
        reachable: true,
        healthyAccounts: headroom.healthyAccounts ?? null,
        queueDepth: headroom.queueDepth ?? null,
        accountId: headroom.accountId ?? null,
      },
    };
  } catch (error) {
    return {
      status: 'unknown',
      provider,
      model: input.model,
      checkedAt,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function beginBulkStage(
  sql: OrgSql,
  input: {
    id: string;
    workspaceId: string;
    harnessSlug: string;
    scope: BulkDedupScope;
    sourceCensusRunId: string;
    pairs: number;
    inputFingerprint: string;
    ownerId: string;
    nowMs: number;
    leaseMs: number;
  },
): Promise<BulkStageEnvelope> {
  const lease: BulkStageLease = {
    ownerId: input.ownerId,
    acquiredAt: input.nowMs,
    heartbeatAt: input.nowMs,
    expiresAt: input.nowMs + input.leaseMs,
    takeoverCount: 0,
  };
  const envelope: BulkStageEnvelope = {
    schemaVersion: BULK_STAGE_SCHEMA_VERSION,
    status: 'running',
    mode: 'bulk-dedup',
    scope: input.scope,
    sourceCensusRunId: input.sourceCensusRunId,
    inputFingerprint: input.inputFingerprint,
    lease,
    canary: { status: 'pending' },
    checkpoints: { batches: {} },
  };
  await sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, batch_size, detail)
    VALUES (${input.id}, ${input.workspaceId}, ${input.harnessSlug}, 'bulk-stage', now(), ${input.pairs},
            ${JSON.stringify({
              ...envelope,
              outcome: {
                unit: 'pairs',
                attempted: input.pairs,
                successful: null,
                rolledBack: null,
                unchanged: null,
                uniqueRowsChanged: null,
                failureReason: null,
                blockedReason: null,
              } satisfies AdmissionRunOutcome,
            })}::text::jsonb)
    ON CONFLICT (id) DO NOTHING`;
  return envelope;
}

async function readBulkStage(sql: OrgSql, id: string): Promise<BulkStageRow | null> {
  const rows = await sql<BulkStageRow[]>`
    SELECT id, started_at, finished_at, detail
      FROM harness_shared.admission_runs
     WHERE id = ${id}
     LIMIT 1`;
  return rows[0] ?? null;
}

async function writeBulkStageEnvelope(
  sql: OrgSql,
  id: string,
  envelope: BulkStageEnvelope,
  ownerId?: string,
): Promise<void> {
  if (!ownerId) {
    await sql`
      UPDATE harness_shared.admission_runs
         SET detail = COALESCE(detail, '{}'::jsonb) || ${JSON.stringify(envelope)}::text::jsonb
       WHERE id = ${id}`;
    return;
  }
  const rows = await sql`
    UPDATE harness_shared.admission_runs
       SET detail = COALESCE(detail, '{}'::jsonb) || ${JSON.stringify(envelope)}::text::jsonb
     WHERE id = ${id}
       AND detail->'lease'->>'ownerId' = ${ownerId}
     RETURNING id`;
  if (!rows?.length) throw new BulkRunActiveError('unknown-owner', Date.now());
}

interface BulkStageLeaseState {
  envelope: BulkStageEnvelope;
  reused: boolean;
  complete: boolean;
}

/** Acquire/reacquire a stage lease. The conditional UPDATE is the final fence:
 * a second executor cannot proceed while a different owner has a live lease. */
async function acquireBulkStageLease(
  sql: OrgSql,
  input: {
    id: string;
    ownerId: string;
    nowMs: number;
    leaseMs: number;
    inputFingerprint: string;
    sourceCensusRunId: string;
    scope: BulkDedupScope;
    pairs: number;
    workspaceId: string;
    harnessSlug: string;
  },
): Promise<BulkStageLeaseState> {
  const inserted = await beginBulkStage(sql, input);
  const row = await readBulkStage(sql, input.id);
  if (!row) throw new Error(`bulk stage ${input.id} disappeared after creation`);
  const current = parseStageEnvelope(row.detail ?? inserted);
  const currentStatus = stageStatus(current);
  if (currentStatus === 'complete') return { envelope: current, reused: true, complete: true };

  const stale = stageWasStale(row, current, input.nowMs, input.leaseMs);
  const currentOwner = current.lease?.ownerId;
  const currentExpiry = Number(current.lease?.expiresAt);
  if (
    currentStatus === 'running' &&
    currentOwner &&
    currentOwner !== input.ownerId &&
    !stale &&
    Number.isFinite(currentExpiry) &&
    currentExpiry > input.nowMs
  ) {
    throw new BulkRunActiveError(currentOwner, currentExpiry);
  }

  const takeoverCount =
    stale && currentOwner && currentOwner !== input.ownerId
      ? Number(current.lease?.takeoverCount ?? 0) + 1
      : Number(current.lease?.takeoverCount ?? 0);
  const next: BulkStageEnvelope = {
    ...current,
    schemaVersion: BULK_STAGE_SCHEMA_VERSION,
    status: 'running',
    mode: 'bulk-dedup',
    scope: input.scope,
    sourceCensusRunId: input.sourceCensusRunId,
    inputFingerprint: input.inputFingerprint,
    lease: {
      ownerId: input.ownerId,
      acquiredAt: current.lease?.acquiredAt ?? input.nowMs,
      heartbeatAt: input.nowMs,
      expiresAt: input.nowMs + input.leaseMs,
      takeoverCount,
    },
    canary:
      current.inputFingerprint === input.inputFingerprint
        ? (current.canary ?? { status: 'pending' })
        : { status: 'pending' },
    checkpoints:
      current.inputFingerprint === input.inputFingerprint
        ? { batches: current.checkpoints?.batches ?? {} }
        : { batches: {} },
    // Capacity blocks are retryable. A re-arm must take a fresh headroom
    // reading rather than fossilizing the previous zero-capacity verdict.
    preflight: currentStatus === 'blocked' ? undefined : current.preflight,
  };
  // Preserve an explicit failure history while making the live state resumable.
  if (currentStatus === 'failed' || currentStatus === 'blocked') {
    next.failureHistory = [
      ...(Array.isArray(current.failureHistory) ? current.failureHistory : []),
      ...(current.failure ? [{ ...current.failure, at: input.nowMs }] : []),
    ].slice(-8);
    delete next.failure;
  }
  const updated = await sql`
    UPDATE harness_shared.admission_runs
       SET finished_at = NULL,
           detail = ${JSON.stringify(next)}::text::jsonb
     WHERE id = ${input.id}
       AND (
         detail->>'status' IS DISTINCT FROM 'running'
         OR detail->'lease'->>'ownerId' = ${input.ownerId}
         OR COALESCE(NULLIF(detail->'lease'->>'expiresAt', '')::double precision, 0) <= ${input.nowMs}
       )
     RETURNING id`;
  if (!updated?.length) {
    const latest = await readBulkStage(sql, input.id);
    const latestEnvelope = parseStageEnvelope(latest?.detail);
    const expiry = Number(latestEnvelope.lease?.expiresAt);
    if (latestEnvelope.lease?.ownerId && Number.isFinite(expiry) && expiry > input.nowMs) {
      throw new BulkRunActiveError(latestEnvelope.lease.ownerId, expiry);
    }
    throw new Error(`could not acquire bulk stage lease ${input.id}`);
  }
  return {
    envelope: next,
    reused: current.inputFingerprint === input.inputFingerprint,
    complete: false,
  };
}

async function heartbeatBulkStage(
  sql: OrgSql,
  input: { id: string; ownerId: string; nowMs: number; leaseMs: number },
): Promise<void> {
  const rows = await sql`
    UPDATE harness_shared.admission_runs
       SET detail = jsonb_set(
         COALESCE(detail, '{}'::jsonb),
         '{lease}',
         jsonb_build_object(
           'ownerId', ${input.ownerId}::text,
           'acquiredAt', COALESCE((detail->'lease'->>'acquiredAt')::double precision, ${input.nowMs}::double precision),
           'heartbeatAt', ${input.nowMs}::double precision,
           'expiresAt', ${input.nowMs + input.leaseMs}::double precision,
           'takeoverCount', COALESCE((detail->'lease'->>'takeoverCount')::int, 0)
         ),
         true
       )
     WHERE id = ${input.id} AND detail->'lease'->>'ownerId' = ${input.ownerId}
     RETURNING id`;
  if (!rows?.length) throw new BulkRunActiveError('unknown-owner', input.nowMs);
}

function batchCheckpointKey(stageRunId: string, shard: number, offset: number, pairKeys: readonly string[]): string {
  const digest = createHash('sha256')
    .update(`${stageRunId}\x00${shard}\x00${offset}\x00${pairKeys.join('\x01')}`)
    .digest('hex')
    .slice(0, 16);
  return `shard-${shard}-offset-${offset}-${digest}`;
}

function checkpointMatchesBatch(
  checkpoint: BulkBatchCheckpoint | undefined,
  batch: readonly PromoterPair[],
): checkpoint is BulkBatchCheckpoint {
  if (
    !checkpoint ||
    checkpoint.status !== 'complete' ||
    checkpoint.schemaVersion !== BULK_BATCH_CHECKPOINT_SCHEMA_VERSION
  )
    return false;
  const expected = batch.map((pair) => pair.pairKey);
  return expected.length === checkpoint.pairKeys.length && expected.every((key, i) => key === checkpoint.pairKeys[i]);
}

async function persistBulkBatchCheckpoint(
  sql: OrgSql,
  input: { stageRunId: string; ownerId: string; nowMs: number; leaseMs: number; checkpoint: BulkBatchCheckpoint },
): Promise<void> {
  const path = ['checkpoints', 'batches', input.checkpoint.key];
  const rows = await sql`
    UPDATE harness_shared.admission_runs
       SET detail = (
         jsonb_set(
           jsonb_set(
             COALESCE(detail, '{}'::jsonb),
             '{checkpoints}',
             COALESCE(detail->'checkpoints', '{}'::jsonb) || jsonb_build_object(
               'batches', COALESCE(detail->'checkpoints'->'batches', '{}'::jsonb)
             ),
             true
           ),
           ${path}::text[],
           ${JSON.stringify(input.checkpoint)}::text::jsonb,
           true
         )
         || jsonb_build_object(
           'lease', jsonb_build_object(
             'ownerId', ${input.ownerId}::text,
             'acquiredAt', COALESCE((detail->'lease'->>'acquiredAt')::double precision, ${input.nowMs}::double precision),
             'heartbeatAt', ${input.nowMs}::double precision,
             'expiresAt', ${input.nowMs + input.leaseMs}::double precision,
             'takeoverCount', COALESCE((detail->'lease'->>'takeoverCount')::int, 0)
           )
         )
       )
     WHERE id = ${input.stageRunId} AND detail->'lease'->>'ownerId' = ${input.ownerId}
     RETURNING id`;
  if (!rows?.length) throw new BulkRunActiveError('unknown-owner', input.nowMs);
}

async function persistBulkStageField(
  sql: OrgSql,
  input: { stageRunId: string; ownerId: string; path: string[]; value: unknown },
): Promise<void> {
  const rows = await sql`
    UPDATE harness_shared.admission_runs
       SET detail = jsonb_set(COALESCE(detail, '{}'::jsonb), ${input.path}::text[], ${JSON.stringify(input.value)}::text::jsonb, true)
     WHERE id = ${input.stageRunId} AND detail->'lease'->>'ownerId' = ${input.ownerId}
     RETURNING id`;
  if (!rows?.length) throw new BulkRunActiveError('unknown-owner', Date.now());
}

const MAX_BULK_ERROR_CAUSE_DEPTH = 8;

/** Convert an Error.cause chain into JSON-safe evidence without losing the
 * transport code/message nested under undici's generic `fetch failed`. */
export function serializeBulkErrorCause(error: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= MAX_BULK_ERROR_CAUSE_DEPTH) return '[cause chain truncated]';
  if (error === null || typeof error !== 'object') return error;
  if (seen.has(error)) return '[circular cause]';
  seen.add(error);
  if (error instanceof Error) {
    const out: Record<string, unknown> = { name: error.name, message: error.message };
    const source = error as Error & {
      cause?: unknown;
      code?: unknown;
      status?: unknown;
      errno?: unknown;
      type?: unknown;
    };
    for (const key of ['code', 'status', 'errno', 'type'] as const) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    if (source.cause !== undefined) out.cause = serializeBulkErrorCause(source.cause, depth + 1, seen);
    return out;
  }
  if (Array.isArray(error)) return error.slice(0, 32).map((entry) => serializeBulkErrorCause(entry, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(error).slice(0, 32)) {
    out[key] = serializeBulkErrorCause((error as Record<string, unknown>)[key], depth + 1, seen);
  }
  return out;
}

async function failBulkStage(
  sql: OrgSql,
  runId: string,
  error: unknown,
  attempted: number | null = null,
  ownerId?: string,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  const failure = classifyBulkModelFailure(error);
  const guardPersistence = error instanceof BulkAdmissionMergeGuardBlockedError ? error.persistence : null;
  const status =
    failure.kind === 'capacity' || failure.kind === 'quality' || failure.kind === 'guard' ? 'blocked' : 'failed';
  const allowCompletedQualityDisposition = failure.kind === 'quality';
  await sql`
    UPDATE harness_shared.admission_runs
       SET finished_at = now(),
           held = CASE
             WHEN ${guardPersistence !== null} THEN ${guardPersistence?.guardRefusals.length ?? 0}
             ELSE held
           END,
           detail = (COALESCE(detail, '{}'::jsonb) - 'errorCause') ||
                    ${JSON.stringify({
                      status,
                      error: message,
                      failure,
                      ...(failure.class === 'canary_protocol_failure'
                        ? { canary: { status: 'failed', reason: failure.message } }
                        : {}),
                      outcome: {
                        unit: 'pairs',
                        attempted,
                        successful: guardPersistence ? 0 : null,
                        // A failed stage is transactionally rolled back; the
                        // exact number of writes is unknowable when the error
                        // occurs during model/protocol handling.
                        rolledBack: guardPersistence ? guardPersistence.uniqueRowsChanged : null,
                        unchanged: guardPersistence ? attempted : null,
                        uniqueRowsChanged: guardPersistence ? 0 : null,
                        failureReason: status === 'failed' ? message : null,
                        blockedReason: status === 'blocked' ? message : null,
                      } satisfies AdmissionRunOutcome,
                      ...(guardPersistence ? { guardRefusals: guardPersistence.guardRefusals } : {}),
                      ...(cause !== undefined ? { errorCause: serializeBulkErrorCause(cause) } : {}),
                    })}::text::jsonb
     WHERE id = ${runId}
       AND (
         ${ownerId ?? null}::text IS NULL
         OR detail->'lease'->>'ownerId' = ${ownerId ?? null}
         OR (${allowCompletedQualityDisposition} AND detail->>'status' = 'complete')
       )`.catch(() => undefined);
}

type BulkModelResponse = Awaited<ReturnType<PromoterLlmCall>>;

/**
 * Is this thrown model-call failure worth retrying the batch for?
 *
 * ASK THE CLASSIFIER THAT ALREADY RAN — do not re-parse the message. `llmCall`
 * throws `LlmCallError(turn)` where `turn` is a `TurnError` from
 * `classifyHttpError`, carrying a computed `retryable` (true for rate_limited /
 * overloaded / timeout / transient_io, false for usage_limit / auth /
 * context_overflow / permanent). Reading that structured verdict preserves the
 * fail-fast on a walled account or bad token while retrying real blips.
 *
 * WHY THIS EXISTS (WI-882767, 2026-08-30): the message-regex path silently
 * discarded a 2h34m run. undici surfaces a socket that dies mid-response as the
 * bare word `terminated`, so the thrown message was `anthropic-direct error:
 * terminated` — which matches NEITHER available network heuristic (the reaper's
 * ECONNRESET/`socket hang up`/`fetch failed` set, nor loopback-fetch's, whose
 * `UND_ERR_SOCKET` branch cannot fire here anyway because `LlmCallError` is built
 * from a classified turn and does NOT preserve `.cause`). So the predicate
 * returned false, batch #33 of ~37 was never retried, `judgeShard` rethrew, and
 * the whole stage failed at ~90% having persisted nothing. The turn had said
 * `transient_io`, `retryable: true`, the entire time.
 *
 * The network heuristic stays as the fallback for a non-LlmCallError throw (a
 * raw fetch/socket failure from some future call path), where there is no turn
 * to consult.
 */
export function isRetryableModelCallError(error: unknown): boolean {
  if (isLlmCallError(error)) {
    // `testing-shell`'s TurnError is a deliberately MINIMAL structural subset, so
    // `retryable` is optional there even though every host classifier sets it. An
    // explicit verdict wins; a MISSING one falls through to the heuristic below
    // rather than reading as "not retryable" — an absent classification is not a
    // negative one, and defaulting it to false is how this bug looked the first time.
    const { retryable } = error.turn;
    if (typeof retryable === 'boolean') return retryable;
  }
  return isTransientNetworkError(error);
}

async function callBulkModelBatchWithRetry<T>(
  call: () => Promise<BulkModelResponse>,
  validate: (response: BulkModelResponse) => T,
  opts: { backoffsMs: readonly number[]; delay: (ms: number) => Promise<void> },
): Promise<{
  response: BulkModelResponse;
  value: T | null;
  retries: number;
  protocolFailures: number;
  protocolError: string | null;
  tokensIn: number;
  tokensOut: number;
}> {
  let retries = 0;
  let protocolFailures = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (;;) {
    let response: BulkModelResponse;
    try {
      response = await call();
    } catch (error) {
      if (!isRetryableModelCallError(error) || retries >= opts.backoffsMs.length) throw error;
      await opts.delay(opts.backoffsMs[retries]!);
      retries += 1;
      continue;
    }
    tokensIn += response.inputTokens;
    tokensOut += response.outputTokens;
    try {
      return {
        response,
        value: validate(response),
        retries,
        protocolFailures,
        protocolError: null,
        tokensIn,
        tokensOut,
      };
    } catch (error) {
      protocolFailures += 1;
      const protocolError = error instanceof Error ? error.message : String(error);
      if (retries >= opts.backoffsMs.length) {
        return {
          response,
          value: null,
          retries,
          protocolFailures,
          protocolError,
          tokensIn,
          tokensOut,
        };
      }
      await opts.delay(opts.backoffsMs[retries]!);
      retries += 1;
    }
  }
}

/** Run the D-007 gold replay through the same model, bulk prompt, response
 * parser, retry policy, and canonical planner as production.  This function
 * never throws a model/protocol error: it converts one into a structured
 * blocked report so the stage can persist the evidence before failing closed. */
async function runAdmissionMergeQualityReplay(
  prepared: AdmissionMergeQualityPreparedGate,
  opts: {
    llmCall: PromoterLlmCall;
    ownerId?: string;
    batchRetryBackoffsMs: readonly number[];
    batchRetryDelay: (ms: number) => Promise<void>;
    now: () => number;
  },
): Promise<AdmissionMergeQualityReport> {
  const startedAtMs = opts.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let replayAttempts = 0;
  let replayTokensIn = 0;
  let replayTokensOut = 0;
  let replayServedAccount: string | null = null;
  const replayServedAccounts = new Set<string>();
  const callReplayModel = () =>
    opts.llmCall({
      model: prepared.model,
      system: prepared.prompt.system,
      messages: [{ role: 'user', content: prepared.prompt.user }],
      responseFormat: 'json',
      maxTokens: bulkJudgeMaxTokens(prepared.pairs.length),
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
    });
  try {
    const attempted = await callBulkModelBatchWithRetry(
      async () => {
        replayAttempts += 1;
        const response = await callReplayModel();
        replayTokensIn += response.inputTokens;
        replayTokensOut += response.outputTokens;
        if (response.servedAccount?.trim()) {
          replayServedAccount = response.servedAccount.trim();
          replayServedAccounts.add(replayServedAccount);
        }
        return response;
      },
      (response) => parsePromoterJudgements(responsePayload(response)),
      { backoffsMs: opts.batchRetryBackoffsMs, delay: opts.batchRetryDelay },
    );
    return scoreAdmissionMergeQualityGate({
      prepared,
      judgements: attempted.value ?? [],
      servedAccount: attempted.response.servedAccount,
      servedAccounts: [...replayServedAccounts],
      modelAttempts: attempted.retries + 1,
      modelRetries: attempted.retries,
      modelProtocolFailures: attempted.protocolFailures,
      tokensIn: attempted.tokensIn,
      tokensOut: attempted.tokensOut,
      startedAt,
      completedAt: new Date(opts.now()).toISOString(),
      ...(attempted.value === null
        ? {
            additionalFailures: [
              `model replay exhausted protocol retries: ${attempted.protocolError ?? 'no schema-valid reply'}`,
            ],
          }
        : {}),
    });
  } catch (error) {
    return failedAdmissionMergeQualityReport({
      prepared,
      error,
      servedAccount: replayServedAccount,
      servedAccounts: [...replayServedAccounts],
      modelAttempts: replayAttempts,
      modelRetries: Math.max(0, replayAttempts - 1),
      tokensIn: replayTokensIn,
      tokensOut: replayTokensOut,
      startedAt,
      completedAt: new Date(opts.now()).toISOString(),
    });
  }
}

function mergeQualityBlockedError(report: AdmissionMergeQualityReport): BulkAdmissionBlockedError {
  const reason = report.failureReasons.join('; ') || 'merge-quality report did not pass';
  return new BulkAdmissionBlockedError(`bulk admission merge-quality gate blocked: ${reason}`, {
    kind: 'quality',
    class: 'merge_quality_gate_failed',
    retryable: false,
    message: reason,
  });
}

async function judgeBulkPairs(
  input: BulkInput,
  opts: {
    llmCall: PromoterLlmCall;
    model: string;
    pairsPerCall: number;
    shardConcurrency: number;
    ownerId?: string;
    executionId: string;
    batchRetryBackoffsMs: readonly number[];
    batchRetryDelay: (ms: number) => Promise<void>;
    stageRunId: string;
    sql: OrgSql;
    leaseMs: number;
    now: () => number;
    step: BulkDedupStepRunner;
    checkpoints: Record<string, BulkBatchCheckpoint>;
  },
): Promise<{
  judgements: PromoterJudgement[];
  modelCalls: number;
  modelRetries: number;
  modelProtocolFailures: number;
  modelProtocolExhaustedBatches: number;
  modelProtocolLastError: string | null;
  ignoredUnknownJudgements: number;
  omittedExpectedJudgements: number;
  tokensIn: number;
  tokensOut: number;
  servedAccounts: string[];
  reusedBatches: number;
}> {
  const byShard = new Map<number, PromoterPair[]>();
  for (const pair of input.pairs) {
    const shard = input.pairShard.get(pair.pairKey);
    if (shard === undefined) throw new Error(`pair ${pair.pairKey} has no authoritative shard`);
    byShard.set(shard, [...(byShard.get(shard) ?? []), pair]);
  }

  const shardEntries = [...byShard.entries()].sort((a, b) => a[0] - b[0]);
  const firstBatchKey = (() => {
    const first = shardEntries[0];
    return first
      ? batchCheckpointKey(
          opts.stageRunId,
          first[0],
          0,
          first[1].slice(0, opts.pairsPerCall).map((p) => p.pairKey),
        )
      : null;
  })();
  let resolveCanary!: () => void;
  let rejectCanary!: (error: unknown) => void;
  const canaryGate = new Promise<void>((resolve, reject) => {
    resolveCanary = resolve;
    rejectCanary = reject;
  });
  // A one-batch stage has no waiter, but a failed canary still rejects the gate.
  void canaryGate.catch(() => undefined);
  if (!firstBatchKey) resolveCanary();
  const results = new Array<{
    judgements: PromoterJudgement[];
    modelCalls: number;
    modelRetries: number;
    modelProtocolFailures: number;
    modelProtocolExhaustedBatches: number;
    modelProtocolLastError: string | null;
    ignoredUnknownJudgements: number;
    omittedExpectedJudgements: number;
    tokensIn: number;
    tokensOut: number;
    servedAccounts: string[];
    reusedBatches: number;
  }>(shardEntries.length);
  let nextShardIndex = 0;
  const judgeShard = async (shard: number, shardPairs: PromoterPair[]) => {
    const judgements: PromoterJudgement[] = [];
    let modelCalls = 0;
    let modelRetries = 0;
    let modelProtocolFailures = 0;
    let modelProtocolExhaustedBatches = 0;
    let modelProtocolLastError: string | null = null;
    let ignoredUnknownJudgements = 0;
    let omittedExpectedJudgements = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const servedAccounts = new Set<string>();
    let reusedBatches = 0;
    const ghostItems = (input.ghostIdsByShard.get(shard) ?? [])
      .map((id) => input.items.get(id))
      .filter((item): item is BulkDedupItem => Boolean(item));
    for (let offset = 0; offset < shardPairs.length; offset += opts.pairsPerCall) {
      const batch = shardPairs.slice(offset, offset + opts.pairsPerCall);
      const pairKeys = batch.map((pair) => pair.pairKey);
      const checkpointKey = batchCheckpointKey(opts.stageRunId, shard, offset, pairKeys);
      const saved = opts.checkpoints[checkpointKey];
      if (checkpointMatchesBatch(saved, batch)) {
        if (saved.canary) {
          // Keep the DBOS call sequence stable on a recovery replay: the first
          // batch is always represented by the same named step, even when its
          // parsed result is now coming from admission_runs.
          await opts.step(`bulk:${opts.stageRunId}:canary`, async () => undefined);
          resolveCanary();
        }
        judgements.push(...saved.judgements);
        // A checkpoint is the durable accounting record for one unique batch.
        // Fold its counters in exactly once so the terminal stage still reports
        // the whole run after a takeover; reusedBatches separately explains how
        // much of that work this executor recovered rather than re-issued.
        modelCalls += saved.modelCalls;
        modelRetries += saved.modelRetries;
        modelProtocolFailures += saved.modelProtocolFailures;
        modelProtocolExhaustedBatches += saved.modelProtocolExhaustedBatches;
        if (saved.modelProtocolLastError) modelProtocolLastError = saved.modelProtocolLastError;
        ignoredUnknownJudgements += saved.ignoredUnknownJudgements;
        omittedExpectedJudgements += saved.omittedExpectedJudgements;
        tokensIn += saved.tokensIn;
        tokensOut += saved.tokensOut;
        for (const account of saved.servedAccounts) servedAccounts.add(account);
        reusedBatches += 1;
        continue;
      }
      const prompt = buildBulkDedupPrompt(batch, ghostItems);
      const canary = checkpointKey === firstBatchKey;
      // Exactly one batch proves model + account serviceability before the
      // remaining shards spend capacity. Once it returns a schema-valid result,
      // independent shards fan out under the ordinary concurrency bound.
      if (!canary) await canaryGate;
      await heartbeatBulkStage(opts.sql, {
        id: opts.stageRunId,
        ownerId: opts.executionId,
        nowMs: opts.now(),
        leaseMs: opts.leaseMs,
      });
      const callBatch = () =>
        callBulkModelBatchWithRetry(
          () =>
            opts.llmCall({
              model: opts.model,
              system: prompt.system,
              messages: [{ role: 'user', content: prompt.user }],
              responseFormat: 'json',
              maxTokens: bulkJudgeMaxTokens(batch.length),
              ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
            }),
          (response) => parsePromoterJudgements(responsePayload(response)),
          { backoffsMs: opts.batchRetryBackoffsMs, delay: opts.batchRetryDelay },
        );
      // The canary is the DBOS-visible model checkpoint. Remaining batches use
      // the admission_runs checkpoints below; concurrent DBOS.runStep calls
      // would allocate replay function ids nondeterministically.
      let attempted: Awaited<ReturnType<typeof callBatch>>;
      try {
        attempted = canary ? await opts.step(`bulk:${opts.stageRunId}:canary`, callBatch) : await callBatch();
      } catch (error) {
        if (canary) rejectCanary(error);
        throw error;
      }
      modelRetries += attempted.retries;
      modelProtocolFailures += attempted.protocolFailures;
      if (attempted.protocolError) modelProtocolLastError = attempted.protocolError;
      const expected = new Set(batch.map((pair) => pair.pairKey));
      const parsed = attempted.value ?? [];
      if (attempted.value === null) modelProtocolExhaustedBatches += 1;
      const accepted = parsed.filter((judgement) => expected.has(judgement.pairKey));
      ignoredUnknownJudgements += parsed.length - accepted.length;
      const returned = new Set(accepted.map((judgement) => judgement.pairKey));
      const missing = batch.map((pair) => pair.pairKey).filter((key) => !returned.has(key));
      omittedExpectedJudgements += missing.length;
      if (attempted.response.servedAccount?.trim()) servedAccounts.add(attempted.response.servedAccount.trim());
      if (canary && attempted.value === null) {
        const error = new BulkAdmissionBlockedError(
          `bulk admission canary failed for ${checkpointKey}: no valid expected judgement`,
          {
            kind: 'protocol',
            class: 'canary_protocol_failure',
            retryable: false,
            message: attempted.protocolError ?? 'canary response omitted every expected pair',
          },
        );
        rejectCanary(error);
        throw error;
      }
      // The canary has now produced a schema-valid response for an expected
      // pair. Only at this point may the remaining shard workers spend model
      // capacity; their DB writes are still held behind the stage transaction.
      if (canary) resolveCanary();
      // Model text is untrusted evidence. Extra cross-pairs are ignored, while
      // omitted expected pairs flow into planPromoterDispositions' existing
      // fail-open hold path and are reconsidered in the next shrinking stage.
      judgements.push(...accepted);
      modelCalls += 1;
      tokensIn += attempted.tokensIn;
      tokensOut += attempted.tokensOut;
      const checkpoint: BulkBatchCheckpoint = {
        schemaVersion: BULK_BATCH_CHECKPOINT_SCHEMA_VERSION,
        key: checkpointKey,
        shard,
        offset,
        pairKeys,
        canary,
        status: 'complete',
        judgements: accepted,
        modelCalls: 1,
        modelRetries: attempted.retries,
        modelProtocolFailures: attempted.protocolFailures,
        modelProtocolExhaustedBatches: attempted.value === null ? 1 : 0,
        modelProtocolLastError: attempted.protocolError,
        ignoredUnknownJudgements: parsed.length - accepted.length,
        omittedExpectedJudgements: missing.length,
        tokensIn: attempted.tokensIn,
        tokensOut: attempted.tokensOut,
        servedAccounts: attempted.response.servedAccount?.trim() ? [attempted.response.servedAccount.trim()] : [],
        completedAt: opts.now(),
      };
      // A protocol-exhausted response is not a completed batch. Leaving it
      // uncheckpointed makes a later stale-run takeover retry the batch rather
      // than fossilizing an omission as successful work.
      if (attempted.value !== null)
        await persistBulkBatchCheckpoint(opts.sql, {
          stageRunId: opts.stageRunId,
          ownerId: opts.executionId,
          nowMs: opts.now(),
          leaseMs: opts.leaseMs,
          checkpoint,
        });
      if (canary) {
        await persistBulkStageField(opts.sql, {
          stageRunId: opts.stageRunId,
          ownerId: opts.executionId,
          path: ['canary'],
          value: {
            status: 'passed',
            batchKey: checkpointKey,
            ...(checkpoint.servedAccounts[0] ? { servedAccount: checkpoint.servedAccounts[0] } : {}),
          },
        });
      }
    }
    return {
      judgements,
      modelCalls,
      modelRetries,
      modelProtocolFailures,
      modelProtocolExhaustedBatches,
      modelProtocolLastError,
      ignoredUnknownJudgements,
      omittedExpectedJudgements,
      tokensIn,
      tokensOut,
      servedAccounts: [...servedAccounts].sort(),
      reusedBatches,
    };
  };
  const workers = Array.from({ length: Math.min(opts.shardConcurrency, shardEntries.length) }, async () => {
    while (nextShardIndex < shardEntries.length) {
      const index = nextShardIndex;
      nextShardIndex += 1;
      const [shard, shardPairs] = shardEntries[index]!;
      results[index] = await judgeShard(shard, shardPairs);
    }
  });
  await Promise.all(workers);
  return {
    judgements: results.flatMap((result) => result.judgements),
    modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0),
    modelRetries: results.reduce((sum, result) => sum + result.modelRetries, 0),
    modelProtocolFailures: results.reduce((sum, result) => sum + result.modelProtocolFailures, 0),
    modelProtocolExhaustedBatches: results.reduce((sum, result) => sum + result.modelProtocolExhaustedBatches, 0),
    modelProtocolLastError:
      results
        .map((result) => result.modelProtocolLastError)
        .filter((error): error is string => Boolean(error))
        .at(-1) ?? null,
    ignoredUnknownJudgements: results.reduce((sum, result) => sum + result.ignoredUnknownJudgements, 0),
    omittedExpectedJudgements: results.reduce((sum, result) => sum + result.omittedExpectedJudgements, 0),
    tokensIn: results.reduce((sum, result) => sum + result.tokensIn, 0),
    tokensOut: results.reduce((sum, result) => sum + result.tokensOut, 0),
    servedAccounts: [...new Set(results.flatMap((result) => result.servedAccounts))].sort(),
    reusedBatches: results.reduce((sum, result) => sum + result.reusedBatches, 0),
  };
}

/**
 * WI-2140406 F4: `admission_runs` rows are stranded in status 'running' forever
 * when the process dies mid-run (measured: `d035-1-stage-1` and
 * `d035-3-census-0` stuck 'running' since 2026-08-30). A stranded row misleads
 * every ledger reader — it looks like live work and hides that the run
 * delivered nothing. Reap at the next run start: any same-scope row still
 * 'running' past the stage lease with no finish is marked failed. The current
 * root's own rows are excluded because stage resumption legitimately takes over
 * an expired lease (`acquireBulkStageLease`), and a reap must never race it.
 */
async function reapStaleRunningAdmissionRuns(
  sql: OrgSql,
  input: { workspaceId: string; harnessSlug: string; rootRunId: string; leaseMs: number; nowMs: number },
): Promise<string[]> {
  const cutoff = new Date(input.nowMs - input.leaseMs).toISOString();
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.admission_runs
       SET finished_at = clock_timestamp(),
           detail = COALESCE(detail, '{}'::jsonb) || ${JSON.stringify({
             status: 'failed',
             error: 'reaped: still running past the stage lease with no finish (process died mid-run)',
             reapedBy: input.rootRunId,
             reapedAt: new Date(input.nowMs).toISOString(),
           })}::text::jsonb
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND finished_at IS NULL
       AND detail->>'status' = 'running'
       AND started_at < ${cutoff}::timestamptz
       AND id NOT LIKE ${`${input.rootRunId}%`}
     RETURNING id`;
  return rows.map((row) => row.id).sort();
}

export async function runWorkItemAdmissionBulkDedup(opts: BulkDedupRunOptions): Promise<BulkDedupRunResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const rootRunId = opts.runId ?? `bulk-dedup-${now()}-${randomUUID().slice(0, 8)}`;
  const executionId = opts.executionId?.trim() || `bulk-executor:${rootRunId}:${randomUUID().slice(0, 12)}`;
  const leaseMs =
    Number.isFinite(opts.stageLeaseMs) && (opts.stageLeaseMs ?? 0) > 0
      ? Math.max(1, Math.floor(opts.stageLeaseMs!))
      : DEFAULT_BULK_STAGE_LEASE_MS;
  const step: BulkDedupStepRunner = opts.step ?? (async <T>(_name: string, fn: () => Promise<T>) => fn());
  const maxStages = Math.max(1, Math.floor(opts.maxStages ?? DEFAULT_BULK_MAX_STAGES));
  // Clamp to what ONE batch's output budget can actually hold. A larger request
  // does not produce a bigger answer, it produces a TRUNCATED one that fails
  // parsing identically on every retry (see BULK_JUDGE_MAX_OUTPUT_TOKENS).
  const pairsPerCall = Math.max(
    1,
    Math.min(maxPairsForOutputBudget(), Math.min(200, Math.floor(opts.pairsPerCall ?? DEFAULT_BULK_PAIRS_PER_CALL))),
  );
  const shardConcurrency = Math.max(
    1,
    Math.min(16, Math.floor(opts.shardConcurrency ?? DEFAULT_BULK_SHARD_CONCURRENCY)),
  );
  const batchRetryBackoffsMs = (opts.batchRetryBackoffsMs ?? DEFAULT_BULK_BATCH_RETRY_BACKOFFS_MS).filter(
    (delayMs) => Number.isFinite(delayMs) && delayMs >= 0,
  );
  const batchRetryDelay =
    opts.batchRetryDelay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runCensus = opts.runCensus ?? runWorkItemAdmissionCensus;
  // Resolved ONCE and used for both the model calls and the ledger write, so
  // `admission_runs.model_id` can never disagree with the model that ran.
  const model = opts.model?.trim() || LEARNING_MODEL_SPEC;
  const mergeQualityPrepared = prepareAdmissionMergeQualityGate({
    model,
    buildPrompt: buildBulkDedupPrompt,
  });
  const mergeQualityStepName = `bulk:${rootRunId}:merge-quality`;
  const preflight: BulkDedupPreflight =
    opts.preflight ??
    (async (input) => ({
      status: 'unknown',
      provider: modelProvider(input.model),
      model: input.model,
      checkedAt: new Date(now()).toISOString(),
      reason: 'no production capacity preflight was configured; the one-batch canary is authoritative',
    }));
  const censusBase = {
    ...(opts.census ?? {}),
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
  };
  await reapStaleRunningAdmissionRuns(sql, {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    rootRunId,
    leaseMs,
    nowMs: now(),
  });

  // A terminal stage is the durable idempotency answer for a repeated root
  // runId. Return its recorded result without issuing another census/model call.
  const priorFirstStage = await readBulkStage(sql, `${rootRunId}-stage-1`);
  const priorEnvelope = parseStageEnvelope(priorFirstStage?.detail);
  let rootMergeQualityReport = isCurrentAdmissionMergeQualityPass(priorEnvelope.mergeQuality, mergeQualityPrepared)
    ? priorEnvelope.mergeQuality
    : null;
  let mergeQualityStepSeen = false;

  /**
   * One independent-label replay gates the whole non-empty root.  Every
   * non-empty stage receives the same report in its own existing envelope, so
   * a stage remains self-describing without spending another model call.
   */
  const ensureMergeQuality = async (
    stageRunId: string,
    stageEnvelope: BulkStageEnvelope,
  ): Promise<AdmissionMergeQualityReport> => {
    const stagePass = isCurrentAdmissionMergeQualityPass(stageEnvelope.mergeQuality, mergeQualityPrepared)
      ? stageEnvelope.mergeQuality
      : null;
    let report = rootMergeQualityReport ?? stagePass;
    if (!mergeQualityStepSeen) {
      report = await step(mergeQualityStepName, () =>
        report
          ? Promise.resolve(report)
          : runAdmissionMergeQualityReplay(mergeQualityPrepared, {
              llmCall: opts.llmCall,
              ownerId: opts.ownerId,
              batchRetryBackoffsMs,
              batchRetryDelay,
              now,
            }),
      );
      mergeQualityStepSeen = true;
    }
    if (!report || report.gateKey !== mergeQualityPrepared.gateKey) {
      report = failedAdmissionMergeQualityReport({
        prepared: mergeQualityPrepared,
        error: new Error(
          `stale or malformed merge-quality checkpoint: expected ${mergeQualityPrepared.gateKey}, ` +
            `received ${report?.gateKey ?? 'absent'}`,
        ),
        completedAt: new Date(now()).toISOString(),
      });
    }
    if (isCurrentAdmissionMergeQualityPass(report, mergeQualityPrepared)) rootMergeQualityReport = report;

    const prior = stageEnvelope.mergeQuality;
    const history =
      prior && prior.gateKey !== report.gateKey
        ? [
            ...(stageEnvelope.mergeQualityHistory ?? []),
            {
              gateKey: prior.gateKey,
              status: prior.status,
              datasetHash: prior.datasetHash,
              promptHash: prior.promptHash,
              thresholdHash: prior.thresholdHash,
              recordedAt: new Date(now()).toISOString(),
            },
          ].slice(-8)
        : stageEnvelope.mergeQualityHistory;
    if (
      prior?.gateKey !== report.gateKey ||
      prior?.status !== report.status ||
      prior?.completedAt !== report.completedAt
    ) {
      await writeBulkStageEnvelope(
        sql,
        stageRunId,
        {
          schemaVersion: BULK_STAGE_SCHEMA_VERSION,
          mergeQuality: report,
          ...(history ? { mergeQualityHistory: history } : {}),
        },
        // A completed legacy stage may predate leases. Refreshing only its
        // quality evidence is safe; running stages remain fenced by the
        // current execution lease.
        stageStatus(stageEnvelope) === 'complete' ? undefined : executionId,
      );
    }
    if (!isCurrentAdmissionMergeQualityPass(report, mergeQualityPrepared)) throw mergeQualityBlockedError(report);
    return report;
  };
  const priorResult = priorEnvelope.stageResult as BulkDedupStageResult | undefined;
  if (
    stageStatus(priorEnvelope) === 'complete' &&
    priorResult &&
    (priorEnvelope.convergence === 'global-zero' || priorEnvelope.convergence === 'scope-zero') &&
    (priorResult.pairs === 0 || rootMergeQualityReport !== null)
  ) {
    const savedRun = priorEnvelope.runResult as BulkDedupRunResult | undefined;
    const replayResult: BulkDedupRunResult = savedRun ?? {
      runId: rootRunId,
      scope: priorResult.scope,
      converged: true,
      convergenceReason: priorEnvelope.convergence,
      initialCensus: Number(priorEnvelope.initialCensus ?? priorResult.censusBefore),
      finalCensus: priorResult.censusAfter,
      finalScopedPairs: 0,
      stages: [priorResult],
    };
    // A completed root is a no-op at the application layer, but a DBOS recovery
    // must still encounter the same named steps in the same order. Direct calls
    // execute these no-op thunks; DBOS returns the previously checkpointed
    // outputs, which are deliberately ignored because the terminal envelope is
    // the authoritative result.
    await step(`bulk:${rootRunId}:census:0`, async () => undefined);
    if (replayResult.stages.some((stage) => stage.pairs > 0)) {
      await step(mergeQualityStepName, async () => priorEnvelope.mergeQuality);
    }
    for (const stage of replayResult.stages) {
      if (stage.pairs > 0) await step(`bulk:${stage.runId}:canary`, async () => undefined);
    }
    return replayResult;
  }

  let census = await step(`bulk:${rootRunId}:census:0`, () =>
    runCensus({ ...censusBase, sql, runId: `${rootRunId}-census-0` }),
  );
  const initialCensus = census.censusAfter;
  const scope = census.projection.recommendedBulkScope;
  const stageLimit = scope === 'machine-emitter-targeted' ? 1 : maxStages;
  const stages: BulkDedupStageResult[] = [];

  for (let stageIndex = 1; stageIndex <= stageLimit; stageIndex += 1) {
    const input = await readBulkInput(sql, {
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      censusRunId: census.runId,
      expectedMembers: census.corpusSize,
      scope,
    });
    // Pair checkpoints are valid only for the exact quality identity that
    // admitted them. Including the gate key here prevents a model/prompt/
    // threshold/dataset drift from replaying old production judgements under a
    // new ledger model id.
    const stageInputFingerprint = admissionMergeQualityHash({
      corpusFingerprint: input.fingerprint,
      mergeQualityGateKey: mergeQualityPrepared.gateKey,
    });
    const stageRunId = `${rootRunId}-stage-${stageIndex}`;
    const leaseState = await acquireBulkStageLease(sql, {
      id: stageRunId,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      scope,
      sourceCensusRunId: census.runId,
      pairs: input.pairs.length,
      inputFingerprint: stageInputFingerprint,
      ownerId: executionId,
      nowMs: now(),
      leaseMs,
    });
    let stageEnvelope = leaseState.envelope;
    const savedCheckpoints =
      stageEnvelope.inputFingerprint === stageInputFingerprint ? (stageEnvelope.checkpoints?.batches ?? {}) : {};

    if (stageStatus(stageEnvelope) === 'complete' && stageEnvelope.stageResult) {
      let savedStage = stageEnvelope.stageResult as BulkDedupStageResult;
      if (savedStage.pairs > 0) {
        const quality = await ensureMergeQuality(stageRunId, stageEnvelope);
        savedStage = { ...savedStage, mergeQuality: quality };
        await step(`bulk:${savedStage.runId}:canary`, async () => undefined);
      }
      stages.push(savedStage);
      if (stageEnvelope.convergence === 'global-zero' || stageEnvelope.convergence === 'scope-zero') {
        return {
          runId: rootRunId,
          scope,
          converged: true,
          convergenceReason: stageEnvelope.convergence,
          initialCensus,
          finalCensus: savedStage.censusAfter,
          finalScopedPairs: savedStage.scopedPairsAfter,
          stages,
        };
      }
      if (savedStage.resultCensusRunId) {
        // A completed non-terminal stage can be resumed from its result census;
        // the next loop iteration will read the pinned map afresh.
        const resumed = await runCensus({ ...censusBase, sql, runId: savedStage.resultCensusRunId });
        census = resumed;
        continue;
      }
    }

    const preflightResult =
      stageEnvelope.preflight ??
      (await preflight({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        model,
        ownerId: executionId,
      }));
    if (!stageEnvelope.preflight) {
      stageEnvelope = { ...stageEnvelope, preflight: preflightResult };
      await writeBulkStageEnvelope(sql, stageRunId, stageEnvelope, executionId);
    }
    if (preflightResult.status === 'blocked') {
      const error = new BulkAdmissionBlockedError(`bulk admission preflight blocked: ${preflightResult.reason}`, {
        kind: 'capacity',
        class: 'preflight_capacity_unavailable',
        retryable: true,
        message: preflightResult.reason,
      });
      await failBulkStage(sql, stageRunId, error, input.pairs.length, executionId);
      throw error;
    }

    if (input.pairs.length === 0) {
      const convergenceReason = census.censusAfter === 0 ? 'global-zero' : 'scope-zero';
      const completedRows = await sql`
        UPDATE harness_shared.admission_runs
           SET finished_at = now(), promoted = 0, merged = 0, held = 0,
               census_before = ${census.censusAfter}, census_after = ${census.censusAfter},
               model_id = NULL, tokens_in = 0, tokens_out = 0, latency_ms = 0,
               detail = detail || ${JSON.stringify({
                 status: 'complete',
                 convergence: convergenceReason,
                 resultCensusRunId: census.runId,
                 scopedPairsAfter: 0,
                 outcome: {
                   unit: 'pairs',
                   attempted: 0,
                   successful: 0,
                   rolledBack: 0,
                   unchanged: 0,
                   uniqueRowsChanged: 0,
                   failureReason: null,
                   blockedReason: null,
                 } satisfies AdmissionRunOutcome,
               })}::text::jsonb
         WHERE id = ${stageRunId}
           AND detail->'lease'->>'ownerId' = ${executionId}
         RETURNING id`;
      if (!completedRows?.length) throw new BulkRunActiveError('unknown-owner', now());
      stages.push({
        runId: stageRunId,
        sourceCensusRunId: census.runId,
        resultCensusRunId: census.runId,
        scope,
        pairs: 0,
        merged: 0,
        held: 0,
        modelCalls: 0,
        modelRetries: 0,
        modelProtocolFailures: 0,
        modelProtocolExhaustedBatches: 0,
        ignoredUnknownJudgements: 0,
        omittedExpectedJudgements: 0,
        tokensIn: 0,
        tokensOut: 0,
        censusBefore: census.censusAfter,
        censusAfter: census.censusAfter,
        scopedPairsAfter: 0,
        servedAccounts: [],
        reusedBatches: 0,
      });
      const emptyStage = stages.at(-1)!;
      await writeBulkStageEnvelope(
        sql,
        stageRunId,
        {
          schemaVersion: BULK_STAGE_SCHEMA_VERSION,
          status: 'complete',
          convergence: convergenceReason,
          initialCensus,
          stageResult: emptyStage,
          runResult: {
            runId: rootRunId,
            scope,
            converged: true,
            convergenceReason,
            initialCensus,
            finalCensus: census.censusAfter,
            finalScopedPairs: 0,
            stages,
          },
        },
        executionId,
      );
      return {
        runId: rootRunId,
        scope,
        converged: true,
        convergenceReason,
        initialCensus,
        finalCensus: census.censusAfter,
        finalScopedPairs: 0,
        stages,
      };
    }

    const startedAt = now();
    try {
      const mergeQuality = await ensureMergeQuality(stageRunId, stageEnvelope);
      const judged = await judgeBulkPairs(input, {
        llmCall: opts.llmCall,
        model,
        pairsPerCall,
        shardConcurrency,
        ownerId: opts.ownerId,
        executionId,
        batchRetryBackoffsMs,
        batchRetryDelay,
        stageRunId,
        sql,
        leaseMs,
        now,
        step,
        checkpoints: savedCheckpoints,
      });
      const itemIds = new Set(input.pairs.flatMap((pair) => [pair.a.id, pair.b.id]));
      const stageItems = [...itemIds].map((id) => input.items.get(id)!).filter(Boolean);
      const plan = guardBulkRecurrenceIdentity(
        planPromoterDispositions(stageItems, input.pairs, judged.judgements),
        input.items,
      );
      const reviewedReadyIds = plan.dispositions.flatMap((disposition) =>
        disposition.action === 'merge' ? [disposition.itemId, disposition.canonicalId] : [],
      );
      let committed:
        | { census: AdmissionCensusRunResult; scopedPairsAfter: number; stage: BulkDedupStageResult }
        | undefined;

      await withWorkItemDependencyAdmissionTransaction(sql, async (rawTx) => {
        const tx = rawTx as unknown as OrgSql;
        const persistence = await persistAdmissionPlan(tx, {
          workspaceId: opts.workspaceId,
          harnessSlug: opts.harnessSlug,
          runId: stageRunId,
          modelId: model,
          nowMs: now(),
          pending: stageItems,
          plan,
          snapshots: stageItems.flatMap((item) => (item.mergeSnapshot ? [item.mergeSnapshot] : [])),
          withinTransaction: true,
          promoteUnmerged: false,
          mergeAnyAdmission: true,
          requireImplementationReadiness: true,
          reviewedReadyIds,
          actor: BULK_DEDUP_ACTOR,
        });
        // A guarded refusal is an intentional no-mutation outcome for the
        // complete stage. Throwing inside this transaction rolls back any
        // sibling writes too; failBulkStage records the exact refusal set.
        if (persistence.guardRefusals.length > 0) {
          throw new BulkAdmissionMergeGuardBlockedError(persistence);
        }
        const merged = persistence.mergedIds.length;
        const held = persistence.held.length;
        await opts.beforePostStageCensus?.(tx, stageIndex);
        const nextCensus = await runCensus({
          ...censusBase,
          sql: tx,
          withinTransaction: true,
          runId: `${stageRunId}-census-after`,
        });
        assertAdmissionCensusRatchet(census.censusAfter, nextCensus.censusAfter);
        const nextInput = await readBulkInput(tx, {
          workspaceId: opts.workspaceId,
          harnessSlug: opts.harnessSlug,
          censusRunId: nextCensus.runId,
          expectedMembers: nextCensus.corpusSize,
          scope,
        });
        const stage: BulkDedupStageResult = {
          runId: stageRunId,
          sourceCensusRunId: census.runId,
          resultCensusRunId: nextCensus.runId,
          scope,
          pairs: input.pairs.length,
          merged,
          held,
          modelCalls: judged.modelCalls,
          modelRetries: judged.modelRetries,
          modelProtocolFailures: judged.modelProtocolFailures,
          modelProtocolExhaustedBatches: judged.modelProtocolExhaustedBatches,
          ignoredUnknownJudgements: judged.ignoredUnknownJudgements,
          omittedExpectedJudgements: judged.omittedExpectedJudgements,
          tokensIn: judged.tokensIn,
          tokensOut: judged.tokensOut,
          censusBefore: census.censusAfter,
          censusAfter: nextCensus.censusAfter,
          scopedPairsAfter: nextInput.pairs.length,
          servedAccounts: judged.servedAccounts,
          reusedBatches: judged.reusedBatches,
          mergeQuality,
          guardRefusals: persistence.guardRefusals,
        };
        const verdicts = persistence.adjudications.reduce<Record<string, number>>((acc, row) => {
          acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
          return acc;
        }, {});
        const completedRows = await tx`
          UPDATE harness_shared.admission_runs
             SET finished_at = now(), promoted = 0, merged = ${merged}, held = ${held},
                 census_before = ${census.censusAfter}, census_after = ${nextCensus.censusAfter},
                 model_id = ${model}, tokens_in = ${judged.tokensIn}, tokens_out = ${judged.tokensOut},
                 latency_ms = ${Math.max(0, now() - startedAt)},
                 detail = detail || ${JSON.stringify({
                   status: 'complete',
                   resultCensusRunId: nextCensus.runId,
                   scopedPairsBefore: input.pairs.length,
                   scopedPairsAfter: nextInput.pairs.length,
                   convergence:
                     nextInput.pairs.length === 0
                       ? nextCensus.censusAfter === 0
                         ? 'global-zero'
                         : 'scope-zero'
                       : null,
                   modelCalls: judged.modelCalls,
                   modelRetries: judged.modelRetries,
                   modelProtocol: {
                     failures: judged.modelProtocolFailures,
                     exhaustedBatches: judged.modelProtocolExhaustedBatches,
                     lastError: judged.modelProtocolLastError,
                     ignoredUnknownJudgements: judged.ignoredUnknownJudgements,
                     omittedExpectedJudgements: judged.omittedExpectedJudgements,
                   },
                   servedAccounts: judged.servedAccounts,
                   reusedBatches: judged.reusedBatches,
                   preflight: preflightResult,
                   verdicts,
                   // before/after only. There used to be an `ok: true` here, a
                   // HARDCODED literal: this write is downstream of
                   // assertAdmissionCensusRatchet, which throws on a rise, so the
                   // field could never be anything but true and recorded nothing.
                   // Worse, a flag named `ok` beside a merge count reads as an
                   // EFFICACY verdict when the assert it echoes is only a SAFETY
                   // one (the census did not grow). Any reader wanting the verdict
                   // derives it from the two fields that are actually measured.
                   ratchet: { before: census.censusAfter, after: nextCensus.censusAfter },
                   outcome: {
                     unit: 'pairs',
                     attempted: input.pairs.length,
                     successful: persistence.adjudications.length,
                     rolledBack: 0,
                     unchanged: Math.max(0, input.pairs.length - persistence.adjudications.length),
                     uniqueRowsChanged: persistence.uniqueRowsChanged,
                     failureReason: null,
                     blockedReason: null,
                   } satisfies AdmissionRunOutcome,
                   guardRefusals: persistence.guardRefusals,
                 })}::text::jsonb
           WHERE id = ${stageRunId}
             AND detail->'lease'->>'ownerId' = ${executionId}
           RETURNING id`;
        if (!completedRows?.length) throw new BulkRunActiveError('unknown-owner', now());
        const completedEnvelope: BulkStageEnvelope = {
          schemaVersion: BULK_STAGE_SCHEMA_VERSION,
          status: 'complete',
          convergence:
            nextInput.pairs.length === 0 ? (nextCensus.censusAfter === 0 ? 'global-zero' : 'scope-zero') : null,
          resultCensusRunId: nextCensus.runId,
          stageResult: stage,
          initialCensus,
          runResult:
            nextInput.pairs.length === 0
              ? {
                  runId: rootRunId,
                  scope,
                  converged: true,
                  convergenceReason: nextCensus.censusAfter === 0 ? 'global-zero' : 'scope-zero',
                  initialCensus,
                  finalCensus: nextCensus.censusAfter,
                  finalScopedPairs: 0,
                  stages: [...stages, stage],
                }
              : undefined,
          lease: {
            ...(stageEnvelope.lease ?? { acquiredAt: now() }),
            ownerId: executionId,
            heartbeatAt: now(),
            expiresAt: now() + leaseMs,
            takeoverCount: stageEnvelope.lease?.takeoverCount ?? 0,
          },
          outcome: {
            unit: 'pairs',
            attempted: input.pairs.length,
            successful: persistence.adjudications.length,
            rolledBack: 0,
            unchanged: Math.max(0, input.pairs.length - persistence.adjudications.length),
            uniqueRowsChanged: persistence.uniqueRowsChanged,
            failureReason: null,
            blockedReason: null,
          } satisfies AdmissionRunOutcome,
          guardRefusals: persistence.guardRefusals,
        };
        // Merge only terminal fields. Spreading the pre-judge envelope here
        // would overwrite `checkpoints.batches` with its stale snapshot and
        // erase every checkpoint written during this stage.
        await writeBulkStageEnvelope(tx, stageRunId, completedEnvelope, executionId);
        committed = { census: nextCensus, scopedPairsAfter: nextInput.pairs.length, stage };
      });

      if (!committed) throw new Error(`bulk stage ${stageRunId} committed without a result`);
      stages.push(committed.stage);
      if (committed.scopedPairsAfter === 0) {
        const convergenceReason = committed.census.censusAfter === 0 ? 'global-zero' : 'scope-zero';
        return {
          runId: rootRunId,
          scope,
          converged: true,
          convergenceReason,
          initialCensus,
          finalCensus: committed.census.censusAfter,
          finalScopedPairs: 0,
          stages,
        };
      }
      if (committed.scopedPairsAfter >= input.pairs.length) {
        throw new Error(
          `bulk dedup made no scoped progress: ${input.pairs.length} -> ${committed.scopedPairsAfter} pair(s)`,
        );
      }
      census = committed.census;
    } catch (error) {
      await failBulkStage(sql, stageRunId, error, input.pairs.length, executionId);
      throw error;
    }
  }

  throw new Error(`bulk dedup did not converge within ${stageLimit} stage(s)`);
}
