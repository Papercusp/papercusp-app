/**
 * Frozen, independently authored merge-quality corpus and pure gate scorer.
 *
 * This is deliberately source-versioned rather than stored in
 * `dedup_adjudications`: inserting a labelled pair there retires the pair from
 * the production admission census.  The live bulk runner renders these cases
 * through its own prompt builder, parses the response with the production
 * parser, and passes the judgements here.  Canonical selection is scored by
 * the production planner, so there is no second approximation of that logic.
 *
 * D-007 (work-queue-resolution-improvement-2026-08-31) ratified the v1
 * thresholds and the independent-label boundary on 2026-09-01.
 */
import { createHash } from 'node:crypto';
import {
  admissionPairKey,
  planPromoterDispositions,
  type AdmissionPairVerdict,
  type PromoterItem,
  type PromoterJudgement,
  type PromoterPair,
} from './work-items-admission-promoter';

export const ADMISSION_MERGE_QUALITY_SCHEMA_VERSION = 'work-item-admission-merge-quality-report-v1';
export const ADMISSION_MERGE_QUALITY_DATASET_VERSION = 'work-item-admission-merge-quality-gold-v1';
export const ADMISSION_MERGE_QUALITY_LABEL_SOURCE =
  'source-authored-independent-labels; model-independent; owner-ratified-boundary:D-007@2026-09-01';

export interface AdmissionMergeQualityThresholds {
  coverage: number;
  duplicatePrecision: number;
  nonDuplicatePreservation: number;
  duplicateRecall: number;
  canonicalSelection: number;
}

export const ADMISSION_MERGE_QUALITY_THRESHOLDS: Readonly<AdmissionMergeQualityThresholds> = Object.freeze({
  coverage: 1,
  duplicatePrecision: 0.98,
  nonDuplicatePreservation: 1,
  duplicateRecall: 0.9,
  canonicalSelection: 1,
});

export function assertAdmissionMergeQualityThresholds(thresholds: AdmissionMergeQualityThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`merge-quality threshold ${name} must be a finite ratio in [0,1], received ${String(value)}`);
    }
  }
}

type GoldVerdict = Exclude<AdmissionPairVerdict, 'hold'>;

export interface AdmissionMergeQualityGoldCase {
  caseId: string;
  pair: PromoterPair;
  expectedVerdict: GoldVerdict;
  expectedCanonical: string | null;
  labelRationale: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

interface GoldItemInput {
  title: string;
  summary: string;
  createdAtMs: number;
  admission?: 'admitted' | 'pending';
  state?: string;
  conditionKey?: string | null;
}

function goldItem(id: string, input: GoldItemInput): PromoterItem {
  return {
    id,
    title: input.title,
    summary: input.summary,
    state: input.state ?? 'open',
    kind: 'change',
    admission: input.admission ?? 'admitted',
    conditionKey: input.conditionKey ?? null,
    createdAtMs: input.createdAtMs,
  };
}

function goldCase(input: {
  caseId: string;
  a: GoldItemInput;
  b: GoldItemInput;
  expectedVerdict: GoldVerdict;
  expectedCanonicalSide?: 'a' | 'b';
  labelRationale: string;
  signals?: PromoterPair['signals'];
  cosine?: number;
}): AdmissionMergeQualityGoldCase {
  const a = goldItem(`MQ-${input.caseId}-A`, input.a);
  const b = goldItem(`MQ-${input.caseId}-B`, input.b);
  const expectedCanonical =
    input.expectedVerdict === 'r-finding-merge' ? (input.expectedCanonicalSide === 'b' ? b.id : a.id) : null;
  return {
    caseId: input.caseId,
    pair: {
      pairKey: admissionPairKey(a.id, b.id),
      a,
      b,
      pendingIds: [a.id, b.id].sort(),
      signals: input.signals ?? ['cosine'],
      cosine: input.cosine ?? 0.94,
    },
    expectedVerdict: input.expectedVerdict,
    expectedCanonical,
    labelRationale: input.labelRationale,
  };
}

/**
 * Twenty-two real-shaped, synthetic cases: ten merge-positive and twelve
 * preservation cases, with four examples of every non-merge class.  The text
 * resembles the queue's actual engineering findings but the labels were
 * authored independently of any model output.  Unique endpoints keep one case
 * from changing another case's canonical component.
 */
export const ADMISSION_MERGE_QUALITY_GOLD_CORPUS: readonly AdmissionMergeQualityGoldCase[] = deepFreeze([
  goldCase({
    caseId: 'M01',
    a: {
      title: 'Bound the sync worker retry loop after repeated 503 responses',
      summary: 'The sync worker retries 503 forever; cap attempts and surface the exhausted failure.',
      createdAtMs: 1_701_000_001_000,
    },
    b: {
      title: 'Sync worker must stop retrying 503 forever',
      summary: 'Add a finite retry budget and report the terminal upstream error to the operator.',
      createdAtMs: 1_701_000_002_000,
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'a',
    labelRationale: 'Same unbounded-503 finding and the same bounded-retry plus surfaced-error remedy.',
  }),
  goldCase({
    caseId: 'M02',
    a: {
      title: 'Prevent a voice turn from being sent twice after reconnect',
      summary: 'Reconnect replays the accepted turn; key delivery by turn id so the second send is ignored.',
      createdAtMs: 1_702_000_001_000,
      admission: 'pending',
    },
    b: {
      title: 'Voice reconnect duplicates the accepted user turn',
      summary: 'Use the stable turn id as an idempotency key and suppress the replayed send.',
      createdAtMs: 1_702_000_002_000,
      admission: 'admitted',
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'b',
    labelRationale: 'Same reconnect replay and the same turn-id idempotency remedy; admitted history is canonical.',
  }),
  goldCase({
    caseId: 'M03',
    a: {
      title: 'Loop heartbeat emits a false stalled alert while work is progressing',
      summary: 'Progress updates do not refresh the heartbeat; refresh it whenever a checkpoint advances.',
      createdAtMs: 1_703_000_003_000,
      admission: 'pending',
    },
    b: {
      title: 'Advancing loops are incorrectly marked stalled',
      summary: 'Treat checkpoint advancement as heartbeat activity so the stalled-loop guard stays quiet.',
      createdAtMs: 1_703_000_001_000,
      admission: 'pending',
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'b',
    labelRationale: 'Same missing heartbeat refresh and identical checkpoint-activity remedy; older pending row wins.',
  }),
  goldCase({
    caseId: 'M04',
    a: {
      title: 'Remote initializer drops the workspace credential',
      summary: 'Thread the credential-delivery result through host initialization instead of reconstructing it.',
      createdAtMs: 1_704_000_004_000,
    },
    b: {
      title: 'Remote initializer drops the workspace credential',
      summary: 'Pass the credential-delivery result into the remote host initializer without a second lookup.',
      createdAtMs: 1_704_000_001_000,
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'b',
    labelRationale: 'Exact stable title and the same delivery-threading remedy; the older admitted row is canonical.',
  }),
  goldCase({
    caseId: 'M05',
    a: {
      title: 'Nested DBOS steps execute without durable progress rows',
      summary: 'Run the action at workflow scope and place checkpointed phases outside any enclosing DBOS step.',
      createdAtMs: 1_705_000_001_000,
      state: 'done',
    },
    b: {
      title: 'System action hides its DBOS phase checkpoints',
      summary: 'Remove the outer step wrapper so runCheckpointedStep can write operation outputs.',
      createdAtMs: 1_705_000_002_000,
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'a',
    labelRationale: 'Same nested-step invisibility and workflow-scope remedy; established terminal row is canonical.',
  }),
  goldCase({
    caseId: 'M06',
    a: {
      title: 'A dead release fixer leaves the green checkpoint red indefinitely',
      summary: 'Detect the dead executor, release its claim, and place a live replacement on the red gate.',
      createdAtMs: 1_706_000_004_000,
    },
    b: {
      title: 'Green checkpoint remains owned by a dead fixer',
      summary: 'Reap the dead fixer claim and launch one replacement owner for the current red verdict.',
      createdAtMs: 1_706_000_001_000,
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'b',
    labelRationale: 'Same dead-fixer ownership wedge and the same reap-and-replace repair.',
  }),
  goldCase({
    caseId: 'M07',
    a: {
      title: 'Admission neighbour query leaks candidates across workspaces',
      summary: 'Join every candidate subquery on workspace id and harness slug before scoring neighbours.',
      createdAtMs: 1_707_000_003_000,
      admission: 'admitted',
    },
    b: {
      title: 'Work-item admission can compare a row from another workspace',
      summary: 'Scope the lateral candidate query by workspace and harness before any similarity predicate.',
      createdAtMs: 1_707_000_001_000,
      admission: 'pending',
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'a',
    labelRationale: 'Same cross-workspace candidate leak and identical scoped-join remedy; admitted row is canonical.',
  }),
  goldCase({
    caseId: 'M08',
    a: {
      title: 'Inference request keeps an admission slot after its client disconnects',
      summary: 'Tie the slot lease to request cancellation and release it in the aborted-request finalizer.',
      createdAtMs: 1_708_000_001_000,
    },
    b: {
      title: 'Disconnected gateway caller squats on a provider slot',
      summary: 'Cancel the leased admission and free the slot when the downstream request aborts.',
      createdAtMs: 1_708_000_002_000,
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'a',
    labelRationale: 'Same disconnected-request slot leak and the same cancellation-bound lease cleanup.',
  }),
  goldCase({
    caseId: 'M09',
    a: {
      title: 'Artifact publish reports success before the URL can be resolved',
      summary: 'Resolve the published URL independently before recording delivery evidence.',
      createdAtMs: 1_709_000_005_000,
    },
    b: {
      title: 'Do not treat an artifact publish result as proof of delivery',
      summary: 'Verify the returned URL via the artifact registry before citing it in a checkpoint.',
      createdAtMs: 1_709_000_001_000,
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'b',
    labelRationale: 'Same false delivery assertion and the same independent URL-resolution guard.',
  }),
  goldCase({
    caseId: 'M10',
    a: {
      title: 'Manual file lock rejects an absolute checkout path',
      summary: 'Resolve files relative to the canonical harness root before calling locks:acquire.',
      createdAtMs: 1_710_000_001_000,
      admission: 'pending',
    },
    b: {
      title: 'locks:acquire receives an absolute repository filename',
      summary: 'Convert repository files to root-relative POSIX paths before acquiring the manual lock.',
      createdAtMs: 1_710_000_002_000,
      admission: 'pending',
    },
    expectedVerdict: 'r-finding-merge',
    expectedCanonicalSide: 'a',
    labelRationale: 'Same invalid lock target and the same canonical-root-relative conversion.',
  }),
  goldCase({
    caseId: 'D01',
    a: {
      title: 'Admission history table overflows on narrow desktop screens',
      summary: 'Make the owner-facing table horizontally scrollable and keep the status column pinned.',
      createdAtMs: 1_711_000_001_000,
    },
    b: {
      title: 'Admission API returns a legacy run without a status source',
      summary: 'Normalize legacy writer state and disclose when finished_at supplied the fallback.',
      createdAtMs: 1_711_000_002_000,
    },
    expectedVerdict: 'distinct',
    labelRationale: 'UI layout and legacy status semantics are different findings with different remedies.',
  }),
  goldCase({
    caseId: 'D02',
    a: {
      title: 'Release checkpoint is pinned red by a failing integration test',
      summary: 'Repair the test regression and rerun the checkpoint verdict.',
      createdAtMs: 1_712_000_001_000,
    },
    b: {
      title: 'Affected-test cache retains entries beyond its disk budget',
      summary: 'Evict least-recently-used cache entries when the configured byte ceiling is crossed.',
      createdAtMs: 1_712_000_002_000,
    },
    expectedVerdict: 'distinct',
    labelRationale: 'A current test regression and cache retention are independent release-system findings.',
  }),
  goldCase({
    caseId: 'D03',
    a: {
      title: 'Voice playback clips the first phoneme after barge-in',
      summary: 'Preserve the leading audio frame when rebuilding the playback buffer.',
      createdAtMs: 1_713_000_001_000,
    },
    b: {
      title: 'Memory recall ranks a stale session above the current one',
      summary: 'Resolve the newest live transcript before querying the self-session index.',
      createdAtMs: 1_713_000_002_000,
    },
    expectedVerdict: 'distinct',
    labelRationale: 'Audio buffering and session-recall freshness share no finding or remedy.',
  }),
  goldCase({
    caseId: 'D04',
    a: {
      title: 'Workspace host bootstrap omits the remote agent home',
      summary: 'Materialize the configured agent home before starting the remote host process.',
      createdAtMs: 1_714_000_001_000,
    },
    b: {
      title: 'Mobile sign-in loses the OAuth callback after process suspension',
      summary: 'Persist the pending callback nonce and resume it when the app returns to the foreground.',
      createdAtMs: 1_714_000_002_000,
    },
    expectedVerdict: 'distinct',
    labelRationale: 'Remote host setup and mobile OAuth resumption are unrelated findings.',
  }),
  goldCase({
    caseId: 'R01',
    a: {
      title: 'Inference gateway queue starves low-cost background requests',
      summary: 'Add weighted fairness so an interactive stream cannot occupy every dispatch turn.',
      createdAtMs: 1_715_000_001_000,
    },
    b: {
      title: 'Inference gateway reports the wrong served account after failover',
      summary: 'Record the account chosen by the final provider attempt in the response envelope.',
      createdAtMs: 1_715_000_002_000,
    },
    expectedVerdict: 'r-related',
    labelRationale: 'Same gateway subsystem, but scheduling starvation and account attribution are different findings.',
  }),
  goldCase({
    caseId: 'R02',
    a: {
      title: 'Work-item scheduler leaves an eligible item behind a stale claim',
      summary: 'Reap expired claims before ranking the claimable set.',
      createdAtMs: 1_716_000_001_000,
    },
    b: {
      title: 'Work-item scheduler ignores priority when two items become claimable together',
      summary: 'Apply effective priority before the stable created-at tie break.',
      createdAtMs: 1_716_000_002_000,
    },
    expectedVerdict: 'r-related',
    labelRationale:
      'Both affect scheduler selection, but stale-claim reaping and priority ordering are separate defects.',
  }),
  goldCase({
    caseId: 'R03',
    a: {
      title: 'Git sync stops after a merge conflict without dispatching the resolver',
      summary: 'Write the conflict receipt and enqueue the merge resolver before releasing the sync lock.',
      createdAtMs: 1_717_000_001_000,
    },
    b: {
      title: 'Release deploy restarts the service before the green ref is checked out',
      summary: 'Complete the release checkout before sending the restart signal.',
      createdAtMs: 1_717_000_002_000,
    },
    expectedVerdict: 'r-related',
    labelRationale:
      'Both sit in shipment infrastructure, but conflict dispatch and deploy ordering are distinct findings.',
  }),
  goldCase({
    caseId: 'R04',
    a: {
      title: 'Sync invalidation coalesces two tables into the wrong query name',
      summary: 'Map each backing-table event through the canonical query-name registry.',
      createdAtMs: 1_718_000_001_000,
    },
    b: {
      title: 'Sync client reconnect misses rows written during its cursor handoff',
      summary: 'Fence the snapshot and live cursor so no write falls between them.',
      createdAtMs: 1_718_000_002_000,
    },
    expectedVerdict: 'r-related',
    labelRationale: 'Both concern sync delivery, but invalidation mapping and cursor fencing are different findings.',
  }),
  goldCase({
    caseId: 'K01',
    a: {
      title: 'Provider 503 responses can retry forever',
      summary: 'Bound attempts to three and return the final classified error.',
      createdAtMs: 1_719_000_001_000,
    },
    b: {
      title: 'Provider 503 responses can retry forever',
      summary: 'Open a provider circuit after a failure burst and probe it before admitting new work.',
      createdAtMs: 1_719_000_002_000,
    },
    expectedVerdict: 'r-remedy-keep',
    labelRationale:
      'Same retry-storm finding, but bounded per-call attempts and a shared circuit breaker are material alternatives.',
  }),
  goldCase({
    caseId: 'K02',
    a: {
      title: 'Bulk judge output truncates before the JSON array closes',
      summary: 'Derive a smaller pair batch from the fixed output-token budget.',
      createdAtMs: 1_720_000_001_000,
    },
    b: {
      title: 'Bulk judge output truncates before the JSON array closes',
      summary: 'Raise the model output ceiling enough to preserve the existing large batch.',
      createdAtMs: 1_720_000_002_000,
    },
    expectedVerdict: 'r-remedy-keep',
    labelRationale:
      'Same truncation finding, but shrinking batches and raising the ceiling have different cost and risk.',
  }),
  goldCase({
    caseId: 'K03',
    a: {
      title: 'A long-running bulk stage loses its lease while the model is working',
      summary: 'Increase the lease duration above the longest expected model batch.',
      createdAtMs: 1_721_000_001_000,
    },
    b: {
      title: 'A long-running bulk stage loses its lease while the model is working',
      summary: 'Heartbeat the stage lease before and after every model batch.',
      createdAtMs: 1_721_000_002_000,
    },
    expectedVerdict: 'r-remedy-keep',
    labelRationale: 'Same lease-expiry finding, but a longer static lease and active heartbeats are distinct remedies.',
  }),
  goldCase({
    caseId: 'K04',
    a: {
      title: 'Gold labels must not retire production admission pairs',
      summary: 'Store labels in a dedicated database table excluded from the census join.',
      createdAtMs: 1_722_000_001_000,
    },
    b: {
      title: 'Gold labels must not retire production admission pairs',
      summary: 'Keep a frozen versioned corpus in source and persist only run reports in admission_runs.',
      createdAtMs: 1_722_000_002_000,
    },
    expectedVerdict: 'r-remedy-keep',
    labelRationale:
      'Same label-contamination finding, but a new label table and a source corpus are different storage designs.',
  }),
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function admissionMergeQualityHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)) ?? 'undefined')
    .digest('hex');
}

function datasetHash(corpus: readonly AdmissionMergeQualityGoldCase[]): string {
  return admissionMergeQualityHash({
    datasetVersion: ADMISSION_MERGE_QUALITY_DATASET_VERSION,
    labelSource: ADMISSION_MERGE_QUALITY_LABEL_SOURCE,
    cases: corpus,
  });
}

export function assertAdmissionMergeQualityCorpus(
  corpus: readonly AdmissionMergeQualityGoldCase[] = ADMISSION_MERGE_QUALITY_GOLD_CORPUS,
): void {
  const caseIds = new Set<string>();
  const pairKeys = new Set<string>();
  const allEndpointIds = new Set<string>();
  const counts: Record<GoldVerdict, number> = {
    distinct: 0,
    'r-finding-merge': 0,
    'r-remedy-keep': 0,
    'r-related': 0,
  };
  for (const entry of corpus) {
    if (caseIds.has(entry.caseId)) throw new Error(`duplicate merge-quality case id ${entry.caseId}`);
    if (pairKeys.has(entry.pair.pairKey)) throw new Error(`duplicate merge-quality pair ${entry.pair.pairKey}`);
    caseIds.add(entry.caseId);
    pairKeys.add(entry.pair.pairKey);
    if (entry.pair.pairKey !== admissionPairKey(entry.pair.a.id, entry.pair.b.id)) {
      throw new Error(`merge-quality case ${entry.caseId} has a non-canonical pair key`);
    }
    for (const endpoint of [entry.pair.a.id, entry.pair.b.id]) {
      if (allEndpointIds.has(endpoint)) {
        throw new Error(`merge-quality endpoint ${endpoint} appears in more than one case`);
      }
      allEndpointIds.add(endpoint);
    }
    if (!entry.labelRationale.trim()) throw new Error(`merge-quality case ${entry.caseId} has no label rationale`);
    counts[entry.expectedVerdict] += 1;
    const pairEndpointIds = new Set([entry.pair.a.id, entry.pair.b.id]);
    if (entry.expectedVerdict === 'r-finding-merge') {
      if (!entry.expectedCanonical || !pairEndpointIds.has(entry.expectedCanonical)) {
        throw new Error(`merge-quality case ${entry.caseId} has no valid expected canonical endpoint`);
      }
    } else if (entry.expectedCanonical !== null) {
      throw new Error(`non-merge quality case ${entry.caseId} must not name a canonical endpoint`);
    }
  }
  const positives = counts['r-finding-merge'];
  const negatives = corpus.length - positives;
  if (positives < 8) throw new Error(`merge-quality corpus needs at least 8 merge positives, found ${positives}`);
  if (negatives < 12) throw new Error(`merge-quality corpus needs at least 12 non-merge cases, found ${negatives}`);
  for (const verdict of ['distinct', 'r-related', 'r-remedy-keep'] as const) {
    if (counts[verdict] === 0) throw new Error(`merge-quality corpus has no ${verdict} preservation case`);
  }
}

assertAdmissionMergeQualityCorpus();

export const ADMISSION_MERGE_QUALITY_DATASET_HASH = datasetHash(ADMISSION_MERGE_QUALITY_GOLD_CORPUS);

export interface AdmissionMergeQualityPreparedGate {
  datasetVersion: typeof ADMISSION_MERGE_QUALITY_DATASET_VERSION;
  datasetHash: string;
  promptHash: string;
  thresholdHash: string;
  gateKey: string;
  model: string;
  thresholds: AdmissionMergeQualityThresholds;
  corpus: readonly AdmissionMergeQualityGoldCase[];
  pairs: PromoterPair[];
  prompt: { system: string; user: string };
}

export function prepareAdmissionMergeQualityGate(input: {
  model: string;
  buildPrompt: (
    pairs: readonly PromoterPair[],
    ghostItems: readonly PromoterItem[],
  ) => {
    system: string;
    user: string;
  };
  corpus?: readonly AdmissionMergeQualityGoldCase[];
  thresholds?: AdmissionMergeQualityThresholds;
}): AdmissionMergeQualityPreparedGate {
  const model = input.model.trim();
  if (!model) throw new Error('merge-quality gate requires a non-empty model');
  const corpus = input.corpus ?? ADMISSION_MERGE_QUALITY_GOLD_CORPUS;
  assertAdmissionMergeQualityCorpus(corpus);
  const thresholds = { ...(input.thresholds ?? ADMISSION_MERGE_QUALITY_THRESHOLDS) };
  assertAdmissionMergeQualityThresholds(thresholds);
  const pairs = corpus.map((entry) => entry.pair);
  const prompt = input.buildPrompt(pairs, []);
  const resolvedDatasetHash = datasetHash(corpus);
  const promptHash = admissionMergeQualityHash(prompt);
  const thresholdHash = admissionMergeQualityHash(thresholds);
  const gateKey = admissionMergeQualityHash({
    schemaVersion: ADMISSION_MERGE_QUALITY_SCHEMA_VERSION,
    datasetVersion: ADMISSION_MERGE_QUALITY_DATASET_VERSION,
    datasetHash: resolvedDatasetHash,
    promptHash,
    model,
    thresholdHash,
  });
  return {
    datasetVersion: ADMISSION_MERGE_QUALITY_DATASET_VERSION,
    datasetHash: resolvedDatasetHash,
    promptHash,
    thresholdHash,
    gateKey,
    model,
    thresholds,
    corpus,
    pairs,
    prompt,
  };
}

export interface AdmissionMergeQualityRatio {
  numerator: number;
  denominator: number;
  value: number;
}

export interface AdmissionMergeQualityOutcome {
  caseId: string;
  pairKey: string;
  expectedVerdict: GoldVerdict;
  predictedVerdict: AdmissionPairVerdict | null;
  expectedCanonical: string | null;
  selectedCanonical: string | null;
  covered: boolean;
  exactVerdict: boolean;
  destructivePrediction: boolean;
  duplicateTruePositive: boolean;
  duplicateFalsePositive: boolean;
  duplicateFalseNegative: boolean;
  canonicalCorrect: boolean | null;
}

export interface AdmissionMergeQualityReport {
  schemaVersion: typeof ADMISSION_MERGE_QUALITY_SCHEMA_VERSION;
  status: 'passed' | 'blocked';
  gateKey: string;
  datasetVersion: string;
  datasetHash: string;
  promptHash: string;
  thresholdHash: string;
  labelSource: string;
  model: string;
  servedAccount: string | null;
  servedAccounts: string[];
  thresholds: AdmissionMergeQualityThresholds;
  counts: {
    cases: number;
    mergePositive: number;
    nonMerge: number;
    returnedExpected: number;
    predictedMerge: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    correctCanonical: number;
  };
  metrics: {
    coverage: AdmissionMergeQualityRatio;
    duplicatePrecision: AdmissionMergeQualityRatio;
    nonDuplicatePreservation: AdmissionMergeQualityRatio;
    duplicateRecall: AdmissionMergeQualityRatio;
    canonicalSelection: AdmissionMergeQualityRatio;
    exactVerdictAccuracy: AdmissionMergeQualityRatio;
  };
  verdicts: {
    expected: Record<GoldVerdict, number>;
    predicted: Record<AdmissionPairVerdict | 'missing', number>;
  };
  missingPairKeys: string[];
  unknownPairKeys: string[];
  duplicatePairKeys: string[];
  failureReasons: string[];
  outcomes: AdmissionMergeQualityOutcome[];
  modelAttempts: number;
  modelRetries: number;
  modelProtocolFailures: number;
  tokensIn: number;
  tokensOut: number;
  startedAt: string;
  completedAt: string;
}

function ratio(numerator: number, denominator: number): AdmissionMergeQualityRatio {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : 0 };
}

function verdictCounts<T extends string>(values: readonly T[], domain: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(domain.map((value) => [value, 0])) as Record<T, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}

export function scoreAdmissionMergeQualityGate(input: {
  prepared: AdmissionMergeQualityPreparedGate;
  judgements: readonly PromoterJudgement[];
  servedAccount?: string | null;
  servedAccounts?: readonly string[];
  modelAttempts?: number;
  modelRetries?: number;
  modelProtocolFailures?: number;
  tokensIn?: number;
  tokensOut?: number;
  startedAt?: string;
  completedAt?: string;
  additionalFailures?: readonly string[];
}): AdmissionMergeQualityReport {
  const expectedKeys = new Set(input.prepared.corpus.map((entry) => entry.pair.pairKey));
  const byKey = new Map<string, PromoterJudgement>();
  const unknownPairKeys: string[] = [];
  const duplicatePairKeys: string[] = [];
  for (const judgement of input.judgements) {
    if (!expectedKeys.has(judgement.pairKey)) {
      unknownPairKeys.push(judgement.pairKey);
      continue;
    }
    if (byKey.has(judgement.pairKey)) {
      duplicatePairKeys.push(judgement.pairKey);
      continue;
    }
    byKey.set(judgement.pairKey, judgement);
  }
  const accepted = [...byKey.values()];
  const items = input.prepared.corpus.flatMap((entry) => [entry.pair.a, entry.pair.b]);
  const plan = planPromoterDispositions(items, input.prepared.pairs, accepted);
  const canonicalByPair = new Map(
    plan.adjudications.map((adjudication) => [
      admissionPairKey(adjudication.a, adjudication.b),
      adjudication.canonical,
    ]),
  );
  const outcomes: AdmissionMergeQualityOutcome[] = input.prepared.corpus.map((entry) => {
    const judgement = byKey.get(entry.pair.pairKey);
    const predictedVerdict = judgement?.verdict ?? null;
    const expectedMerge = entry.expectedVerdict === 'r-finding-merge';
    const predictedMerge = predictedVerdict === 'r-finding-merge';
    const duplicateTruePositive = expectedMerge && predictedMerge;
    const selectedCanonical = predictedMerge ? (canonicalByPair.get(entry.pair.pairKey) ?? null) : null;
    return {
      caseId: entry.caseId,
      pairKey: entry.pair.pairKey,
      expectedVerdict: entry.expectedVerdict,
      predictedVerdict,
      expectedCanonical: entry.expectedCanonical,
      selectedCanonical,
      covered: judgement !== undefined,
      exactVerdict: predictedVerdict === entry.expectedVerdict,
      destructivePrediction: predictedMerge,
      duplicateTruePositive,
      duplicateFalsePositive: !expectedMerge && predictedMerge,
      duplicateFalseNegative: expectedMerge && !predictedMerge,
      canonicalCorrect:
        duplicateTruePositive && entry.expectedCanonical !== null
          ? selectedCanonical === entry.expectedCanonical
          : null,
    };
  });
  const mergePositive = outcomes.filter((outcome) => outcome.expectedVerdict === 'r-finding-merge').length;
  const nonMerge = outcomes.length - mergePositive;
  const returnedExpected = outcomes.filter((outcome) => outcome.covered).length;
  const predictedMerge = outcomes.filter((outcome) => outcome.destructivePrediction).length;
  const truePositive = outcomes.filter((outcome) => outcome.duplicateTruePositive).length;
  const falsePositive = outcomes.filter((outcome) => outcome.duplicateFalsePositive).length;
  const falseNegative = outcomes.filter((outcome) => outcome.duplicateFalseNegative).length;
  const correctCanonical = outcomes.filter((outcome) => outcome.canonicalCorrect === true).length;
  const exactVerdicts = outcomes.filter((outcome) => outcome.exactVerdict).length;
  const metrics = {
    coverage: ratio(returnedExpected, outcomes.length),
    duplicatePrecision: ratio(truePositive, predictedMerge),
    nonDuplicatePreservation: ratio(nonMerge - falsePositive, nonMerge),
    duplicateRecall: ratio(truePositive, mergePositive),
    canonicalSelection: ratio(correctCanonical, truePositive),
    exactVerdictAccuracy: ratio(exactVerdicts, outcomes.length),
  };
  const failures = [...(input.additionalFailures ?? [])];
  const requireMetric = (name: keyof typeof metrics, threshold: number): void => {
    if (metrics[name].value < threshold) {
      failures.push(
        `${name} ${metrics[name].numerator}/${metrics[name].denominator}=${metrics[name].value.toFixed(4)} below ${threshold.toFixed(4)}`,
      );
    }
  };
  requireMetric('coverage', input.prepared.thresholds.coverage);
  requireMetric('duplicatePrecision', input.prepared.thresholds.duplicatePrecision);
  requireMetric('nonDuplicatePreservation', input.prepared.thresholds.nonDuplicatePreservation);
  requireMetric('duplicateRecall', input.prepared.thresholds.duplicateRecall);
  requireMetric('canonicalSelection', input.prepared.thresholds.canonicalSelection);
  if (unknownPairKeys.length > 0) failures.push(`model returned ${unknownPairKeys.length} unknown pair key(s)`);
  if (duplicatePairKeys.length > 0) failures.push(`model returned ${duplicatePairKeys.length} duplicate pair key(s)`);
  const expectedVerdictDomain = ['distinct', 'r-finding-merge', 'r-remedy-keep', 'r-related'] as const;
  const predictedVerdictDomain = [
    'distinct',
    'r-finding-merge',
    'r-remedy-keep',
    'r-related',
    'hold',
    'missing',
  ] as const;
  return {
    schemaVersion: ADMISSION_MERGE_QUALITY_SCHEMA_VERSION,
    status: failures.length === 0 ? 'passed' : 'blocked',
    gateKey: input.prepared.gateKey,
    datasetVersion: input.prepared.datasetVersion,
    datasetHash: input.prepared.datasetHash,
    promptHash: input.prepared.promptHash,
    thresholdHash: input.prepared.thresholdHash,
    labelSource: ADMISSION_MERGE_QUALITY_LABEL_SOURCE,
    model: input.prepared.model,
    servedAccount: input.servedAccount?.trim() || null,
    servedAccounts: [
      ...new Set(
        (input.servedAccounts ?? [])
          .map((account) => account.trim())
          .filter(Boolean)
          .concat(input.servedAccount?.trim() || []),
      ),
    ].sort(),
    thresholds: { ...input.prepared.thresholds },
    counts: {
      cases: outcomes.length,
      mergePositive,
      nonMerge,
      returnedExpected,
      predictedMerge,
      truePositive,
      falsePositive,
      falseNegative,
      correctCanonical,
    },
    metrics,
    verdicts: {
      expected: verdictCounts(
        outcomes.map((outcome) => outcome.expectedVerdict),
        expectedVerdictDomain,
      ),
      predicted: verdictCounts(
        outcomes.map((outcome) => outcome.predictedVerdict ?? 'missing'),
        predictedVerdictDomain,
      ),
    },
    missingPairKeys: outcomes.filter((outcome) => !outcome.covered).map((outcome) => outcome.pairKey),
    unknownPairKeys: [...new Set(unknownPairKeys)].sort(),
    duplicatePairKeys: [...new Set(duplicatePairKeys)].sort(),
    failureReasons: failures,
    outcomes,
    modelAttempts: Math.max(0, Math.floor(input.modelAttempts ?? 1)),
    modelRetries: Math.max(0, Math.floor(input.modelRetries ?? 0)),
    modelProtocolFailures: Math.max(0, Math.floor(input.modelProtocolFailures ?? 0)),
    tokensIn: Math.max(0, Math.floor(input.tokensIn ?? 0)),
    tokensOut: Math.max(0, Math.floor(input.tokensOut ?? 0)),
    startedAt: input.startedAt ?? new Date().toISOString(),
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
}

export function failedAdmissionMergeQualityReport(input: {
  prepared: AdmissionMergeQualityPreparedGate;
  error: unknown;
  servedAccount?: string | null;
  servedAccounts?: readonly string[];
  modelAttempts?: number;
  modelRetries?: number;
  modelProtocolFailures?: number;
  tokensIn?: number;
  tokensOut?: number;
  startedAt?: string;
  completedAt?: string;
}): AdmissionMergeQualityReport {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return scoreAdmissionMergeQualityGate({
    prepared: input.prepared,
    judgements: [],
    servedAccount: input.servedAccount,
    servedAccounts: input.servedAccounts,
    modelAttempts: input.modelAttempts ?? 1,
    modelRetries: input.modelRetries ?? 0,
    modelProtocolFailures: input.modelProtocolFailures ?? 0,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    additionalFailures: [`model replay failed: ${message}`],
  });
}

export function isCurrentAdmissionMergeQualityPass(
  value: unknown,
  prepared: AdmissionMergeQualityPreparedGate,
): value is AdmissionMergeQualityReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<AdmissionMergeQualityReport>;
  const metrics = report.metrics as AdmissionMergeQualityReport['metrics'] | undefined;
  const counts = report.counts as AdmissionMergeQualityReport['counts'] | undefined;
  const thresholds = report.thresholds as AdmissionMergeQualityThresholds | undefined;
  const outcomes = Array.isArray(report.outcomes) ? report.outcomes : undefined;
  const failureReasons = Array.isArray(report.failureReasons) ? report.failureReasons : undefined;
  const missingPairKeys = Array.isArray(report.missingPairKeys) ? report.missingPairKeys : undefined;
  const unknownPairKeys = Array.isArray(report.unknownPairKeys) ? report.unknownPairKeys : undefined;
  const duplicatePairKeys = Array.isArray(report.duplicatePairKeys) ? report.duplicatePairKeys : undefined;
  const finiteRatio = (candidate: AdmissionMergeQualityRatio | undefined): boolean =>
    Boolean(
      candidate &&
      Number.isInteger(candidate.numerator) &&
      candidate.numerator >= 0 &&
      Number.isInteger(candidate.denominator) &&
      candidate.denominator >= 0 &&
      Number.isFinite(candidate.value) &&
      candidate.value >= 0 &&
      candidate.value <= 1 &&
      candidate.value === (candidate.denominator > 0 ? candidate.numerator / candidate.denominator : 0),
    );
  return Boolean(
    report.schemaVersion === ADMISSION_MERGE_QUALITY_SCHEMA_VERSION &&
    report.status === 'passed' &&
    report.datasetVersion === prepared.datasetVersion &&
    report.gateKey === prepared.gateKey &&
    report.datasetHash === prepared.datasetHash &&
    report.promptHash === prepared.promptHash &&
    report.thresholdHash === prepared.thresholdHash &&
    report.labelSource === ADMISSION_MERGE_QUALITY_LABEL_SOURCE &&
    report.model === prepared.model &&
    thresholds &&
    JSON.stringify(canonicalize(thresholds)) === JSON.stringify(canonicalize(prepared.thresholds)) &&
    counts &&
    counts.cases === prepared.corpus.length &&
    counts.returnedExpected === counts.cases &&
    Number.isInteger(counts.mergePositive) &&
    counts.mergePositive > 0 &&
    Number.isInteger(counts.nonMerge) &&
    counts.nonMerge > 0 &&
    counts.mergePositive + counts.nonMerge === counts.cases &&
    Number.isInteger(counts.predictedMerge) &&
    counts.predictedMerge >= 0 &&
    Number.isInteger(counts.truePositive) &&
    counts.truePositive >= 0 &&
    Number.isInteger(counts.falsePositive) &&
    counts.falsePositive >= 0 &&
    Number.isInteger(counts.falseNegative) &&
    counts.falseNegative >= 0 &&
    Number.isInteger(counts.correctCanonical) &&
    counts.correctCanonical >= 0 &&
    outcomes &&
    outcomes.length === counts.cases &&
    outcomes.every((outcome) => outcome.covered && outcome.predictedVerdict !== null) &&
    failureReasons &&
    failureReasons.length === 0 &&
    missingPairKeys &&
    missingPairKeys.length === 0 &&
    unknownPairKeys &&
    unknownPairKeys.length === 0 &&
    duplicatePairKeys &&
    duplicatePairKeys.length === 0 &&
    metrics &&
    finiteRatio(metrics.coverage) &&
    finiteRatio(metrics.duplicatePrecision) &&
    finiteRatio(metrics.nonDuplicatePreservation) &&
    finiteRatio(metrics.duplicateRecall) &&
    finiteRatio(metrics.canonicalSelection) &&
    metrics.coverage.value >= prepared.thresholds.coverage &&
    metrics.duplicatePrecision.value >= prepared.thresholds.duplicatePrecision &&
    metrics.nonDuplicatePreservation.value >= prepared.thresholds.nonDuplicatePreservation &&
    metrics.duplicateRecall.value >= prepared.thresholds.duplicateRecall &&
    metrics.canonicalSelection.value >= prepared.thresholds.canonicalSelection,
  );
}

/** Deterministic perfect replay used by tests; production never calls this. */
export function admissionMergeQualityGoldJudgements(
  corpus: readonly AdmissionMergeQualityGoldCase[] = ADMISSION_MERGE_QUALITY_GOLD_CORPUS,
): PromoterJudgement[] {
  return corpus.map((entry) => ({
    pairKey: entry.pair.pairKey,
    verdict: entry.expectedVerdict,
    reason: `independent frozen label ${entry.caseId}: ${entry.labelRationale}`,
  }));
}
