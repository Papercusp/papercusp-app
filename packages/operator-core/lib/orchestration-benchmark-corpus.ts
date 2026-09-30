/**
 * Frozen orchestration benchmark corpus for
 * orchestration-runtime-unification-and-safe-output-2026-08-22 P-002.
 *
 * The live 01a02a75 sample is measurement-grade: its sizes and latency come
 * from the raw Codex rollout, not session_turn_parts (tool payloads are capped
 * at 2,000 characters there). Synthetic cases keep the capability matrix
 * deterministic without pretending their fixture-only latency is a live
 * measurement.
 */
import { Buffer } from 'node:buffer';

export const ORCHESTRATION_BENCHMARK_SCHEMA_VERSION = 1 as const;

export const ORCHESTRATION_WORKFLOW_CLASSES = [
  'server-only',
  'client-only',
  'shell-only',
  'multimodal',
  'background-job',
  'mixed',
] as const;
export type OrchestrationWorkflowClass = (typeof ORCHESTRATION_WORKFLOW_CLASSES)[number];

export type ReplayabilityClass =
  | 'deterministic'
  | 'environment-bound'
  | 'client-bound'
  | 'session-bound'
  | 'mixed';

export interface OrchestrationBenchmarkMetrics {
  /** Bytes emitted by nested calls before the orchestration wrapper. */
  intermediateBytes: number;
  /** Individual nested-result sizes, so the aggregate is independently checkable. */
  intermediateResultBytes: readonly number[];
  /** Bytes serialized back into model context by the current backend. */
  returnedContextBytes: number;
  /** UTF-16 characters serialized back by the current backend, when measured. */
  returnedContextChars: number;
  /** Outer orchestration call plus every logical nested tool call. */
  toolCalls: number;
  /** Null for fixture-only cases: synthetic timing must not masquerade as measured latency. */
  latencyMs: number | null;
  latencyBasis: 'raw-rollout-timestamps' | 'not-measured-synthetic';
}

export interface OrchestrationBenchmarkCase {
  id: string;
  workflowClass: OrchestrationWorkflowClass;
  source:
    | {
        kind: 'live-incident';
        sessionId: string;
        callId: string;
        capturedAt: string;
        rawResolver: 'session_ingest_state.file_path';
      }
    | { kind: 'synthetic'; fixtureVersion: 1 };
  currentBackend: 'code:run' | 'functions.exec';
  currentBackendBehavior: string;
  metrics: OrchestrationBenchmarkMetrics;
  replayability: {
    class: ReplayabilityClass;
    reason: string;
  };
  dataSafety: {
    secretValuesPresent: boolean;
    ephemeralIdentifierKinds: readonly string[];
    note: string;
  };
  /** Script-authored result. The runtime may bound it but must never synthesize it. */
  authoredSummary: string;
  /** Acceptance facts that summary + typed references must preserve. */
  expectedEvidenceFacts: readonly string[];
  referenceKinds: readonly string[];
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function serializedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function syntheticCase(input: {
  id: string;
  workflowClass: OrchestrationWorkflowClass;
  currentBackend: 'code:run' | 'functions.exec';
  currentBackendBehavior: string;
  intermediatePayloads: readonly unknown[];
  currentReturn: unknown;
  toolCalls: number;
  replayability: OrchestrationBenchmarkCase['replayability'];
  ephemeralIdentifierKinds?: readonly string[];
  authoredSummary: string;
  expectedEvidenceFacts: readonly string[];
  referenceKinds?: readonly string[];
}): OrchestrationBenchmarkCase {
  const intermediateResultBytes = input.intermediatePayloads.map(serializedBytes);
  return {
    id: input.id,
    workflowClass: input.workflowClass,
    source: { kind: 'synthetic', fixtureVersion: 1 },
    currentBackend: input.currentBackend,
    currentBackendBehavior: input.currentBackendBehavior,
    metrics: {
      intermediateBytes: intermediateResultBytes.reduce((sum, bytes) => sum + bytes, 0),
      intermediateResultBytes,
      returnedContextBytes: serializedBytes(input.currentReturn),
      returnedContextChars: serializedChars(input.currentReturn),
      toolCalls: input.toolCalls,
      latencyMs: null,
      latencyBasis: 'not-measured-synthetic',
    },
    replayability: input.replayability,
    dataSafety: {
      secretValuesPresent: false,
      ephemeralIdentifierKinds: input.ephemeralIdentifierKinds ?? [],
      note: 'Synthetic payload contains no credential or secret value.',
    },
    authoredSummary: input.authoredSummary,
    expectedEvidenceFacts: input.expectedEvidenceFacts,
    referenceKinds: input.referenceKinds ?? [],
  };
}

const INCIDENT_INTERMEDIATE_RESULT_BYTES = [2449, 5842, 5842, 2440, 3271, 1986, 5976, 4679] as const;

/**
 * The frozen incident is intentionally first: it is both the largest case and
 * the acceptance fixture named by D-010/P-019. Eight nested reads plus the
 * outer functions.exec call are the plan's "nine-read" event.
 */
export const ORCHESTRATION_BENCHMARK_CORPUS: readonly OrchestrationBenchmarkCase[] = [
  {
    id: 'incident-01a02a75-nine-read-fanout',
    workflowClass: 'mixed',
    source: {
      kind: 'live-incident',
      sessionId: '01a02a75-9c18-78d1-b986-22826dd0310f',
      callId: 'call_9VFyMvWRue3Ya2paBhrGwnpR',
      capturedAt: '2026-08-22T17:17:05.110Z',
      rawResolver: 'session_ingest_state.file_path',
    },
    currentBackend: 'functions.exec',
    currentBackendBehavior:
      'One client isolate ran eight exec_command-backed ptool reads concurrently and concatenated every raw result into one model-facing return.',
    metrics: {
      intermediateBytes: INCIDENT_INTERMEDIATE_RESULT_BYTES.reduce((sum, bytes) => sum + bytes, 0),
      intermediateResultBytes: INCIDENT_INTERMEDIATE_RESULT_BYTES,
      returnedContextBytes: 35_336,
      returnedContextChars: 35_265,
      toolCalls: 9,
      latencyMs: 9_488,
      latencyBasis: 'raw-rollout-timestamps',
    },
    replayability: {
      class: 'environment-bound',
      reason:
        'The read graph is deterministic, but its work-item, event, fleet, account, and release answers are live snapshots and must be rebound at replay time.',
    },
    dataSafety: {
      secretValuesPresent: false,
      ephemeralIdentifierKinds: [
        'session-id',
        'call-id',
        'owner-id',
        'work-item-id',
        'event-key',
        'commit-sha',
        'scratch-path',
      ],
      note:
        'The raw result contains operational identifiers but no credential value. Recipes and summaries must retain typed bindings/references, never literal ephemeral identifiers.',
    },
    authoredSummary:
      'All eight reads completed. The work-item snapshot, two gate reads, fleet brief, two provider-capacity reads, account inventory, and release trace are available as typed references rather than concatenated raw output. At capture time the fleet had four members, all parked, no claimable work, and no speaking member. Codex capacity was blind and reported no usable account; Claude capacity was also partly blind but reported one usable account and scarce headroom. The requested release target was committed on staging but neither green-pinned nor deployed: the authoritative checkpoint was red with an absent fixer, so the safe next action was to classify and repair the named gate failures rather than force-deploy. The two named gates remained declared/awaitable, and the output did not widen authority, mutate state, expose a credential, or change mid-turn injection. Exact work-item rows, gate registrations, per-account status, failing checks, and release provenance remain expandable from their references.',
    expectedEvidenceFacts: [
      'all eight nested reads completed',
      'fleet member, parked, speaking, and claimable counts are preserved',
      'Codex and Claude capacity verdicts retain blindness and usable-account counts',
      'release target presence distinguishes staging, green pin, and deployment',
      'authoritative red gate and absent fixer remain explicit',
      'safe next action is gate classification/repair, not force deployment',
      'declared gate state remains recoverable',
      'authority, secrets, and mid-turn injection behavior are unchanged',
    ],
    referenceKinds: [
      'work-item-snapshot',
      'event-status',
      'fleet-brief',
      'capacity-snapshot',
      'account-snapshot',
      'release-trace',
    ],
  },
  syntheticCase({
    id: 'synthetic-server-only',
    workflowClass: 'server-only',
    currentBackend: 'code:run',
    currentBackendBehavior: 'Server code:run invokes two read tools and returns only the authored aggregate.',
    intermediatePayloads: [
      { ok: true, items: [{ id: 'P-A', state: 'done' }, { id: 'P-B', state: 'wip' }] },
      { ok: true, gate: { state: 'green', generation: 7 } },
    ],
    currentReturn: { summary: 'Two items inspected; one remains active. Gate generation 7 is green.' },
    toolCalls: 3,
    replayability: { class: 'deterministic', reason: 'All calls are server reads with explicit inputs.' },
    authoredSummary: 'Two items were inspected; one remains active. The referenced gate verdict is green.',
    expectedEvidenceFacts: ['two items inspected', 'one active item', 'green gate verdict'],
    referenceKinds: ['work-item-snapshot', 'gate-verdict'],
  }),
  syntheticCase({
    id: 'synthetic-client-only-tool',
    workflowClass: 'client-only',
    currentBackend: 'functions.exec',
    currentBackendBehavior: 'The client isolate calls a client-owned image inspection tool unavailable to server code:run.',
    intermediatePayloads: [{ detail: 'original', width: 1280, height: 720 }],
    currentReturn: { summary: 'Image dimensions inspected on the client.', ref: 'client-image-ref' },
    toolCalls: 2,
    replayability: { class: 'client-bound', reason: 'Replay requires a client-local file and view_image.' },
    ephemeralIdentifierKinds: ['client-file-path'],
    authoredSummary: 'The client-held image was inspected at original detail; dimensions are attached as metadata.',
    expectedEvidenceFacts: ['client capability was required', 'original-detail inspection completed'],
    referenceKinds: ['client-image'],
  }),
  syntheticCase({
    id: 'synthetic-shell-only',
    workflowClass: 'shell-only',
    currentBackend: 'functions.exec',
    currentBackendBehavior: 'The client isolate delegates one bounded shell command to exec_command.',
    intermediatePayloads: [{ exitCode: 0, stdout: '3 matching files\n', stderr: '' }],
    currentReturn: { summary: 'Shell scan completed: three matching files.', exitCode: 0 },
    toolCalls: 2,
    replayability: { class: 'environment-bound', reason: 'Replay depends on the checked-out filesystem state.' },
    ephemeralIdentifierKinds: ['working-directory'],
    authoredSummary: 'The bounded shell scan completed successfully and found three matching files.',
    expectedEvidenceFacts: ['exit code zero', 'three matching files'],
    referenceKinds: ['shell-output'],
  }),
  syntheticCase({
    id: 'synthetic-multimodal',
    workflowClass: 'multimodal',
    currentBackend: 'functions.exec',
    currentBackendBehavior: 'The client isolate receives an image tool result and emits an image content item.',
    intermediatePayloads: [{ mimeType: 'image/png', dataBytes: 4096 }],
    currentReturn: { summary: 'One PNG emitted.', media: [{ kind: 'image', mimeType: 'image/png', bytes: 4096 }] },
    toolCalls: 2,
    replayability: { class: 'client-bound', reason: 'Replay requires the client multimodal emitter.' },
    authoredSummary: 'One PNG was emitted; its MIME type, byte count, and typed media reference are preserved.',
    expectedEvidenceFacts: ['one image emitted', 'MIME type and byte count preserved'],
    referenceKinds: ['media'],
  }),
  syntheticCase({
    id: 'synthetic-background-job',
    workflowClass: 'background-job',
    currentBackend: 'functions.exec',
    currentBackendBehavior: 'exec_command yields a PTY session and write_stdin resumes it to completion.',
    intermediatePayloads: [
      { status: 'running', sessionId: 'fixture-session' },
      { status: 'completed', exitCode: 0, stdout: 'done\n' },
    ],
    currentReturn: { summary: 'Background job completed successfully.', exitCode: 0 },
    toolCalls: 3,
    replayability: { class: 'session-bound', reason: 'The PTY session id is valid only for the originating client session.' },
    ephemeralIdentifierKinds: ['pty-session-id'],
    authoredSummary: 'The background job resumed from its typed PTY reference and completed with exit code zero.',
    expectedEvidenceFacts: ['job yielded before completion', 'resume completed', 'exit code zero'],
    referenceKinds: ['pty-session', 'shell-output'],
  }),
  syntheticCase({
    id: 'synthetic-mixed-capabilities',
    workflowClass: 'mixed',
    currentBackend: 'functions.exec',
    currentBackendBehavior:
      'One client script mixes a server read, local shell probe, and generated-image emission; D-013 collapses this to server-side script mixing once capability parity exists.',
    intermediatePayloads: [
      { ok: true, state: 'ready' },
      { exitCode: 0, stdout: 'asset.png\n' },
      { mimeType: 'image/png', dataBytes: 8192 },
    ],
    currentReturn: {
      summary: 'Server state is ready; shell probe passed; one generated PNG emitted.',
      refs: ['server-read', 'shell-output', 'generated-image'],
    },
    toolCalls: 4,
    replayability: { class: 'mixed', reason: 'Server read is replayable; shell and media legs require declared host/client capabilities.' },
    ephemeralIdentifierKinds: ['working-directory', 'generated-media-handle'],
    authoredSummary:
      'The server state was ready, the local shell probe passed, and one generated PNG was emitted through typed references.',
    expectedEvidenceFacts: ['server state ready', 'shell probe passed', 'one generated image emitted'],
    referenceKinds: ['server-read', 'shell-output', 'generated-media'],
  }),
];

/**
 * Summary budget derivation. The value is not chosen independently: it is the
 * smallest 250-character bucket that contains the largest script-authored gold
 * summary in this frozen corpus. The bucket avoids making a wording-only edit a
 * runtime configuration change; there is no extra percentage/headroom factor.
 */
export const SUMMARY_BUDGET_BUCKET_CHARS = 250;

export function authoredSummarySerializedChars(entry: OrchestrationBenchmarkCase): number {
  return serializedChars(entry.authoredSummary);
}

export function deriveMeasuredSummaryBudgetChars(
  corpus: readonly OrchestrationBenchmarkCase[] = ORCHESTRATION_BENCHMARK_CORPUS,
): number {
  if (corpus.length === 0) throw new Error('summary budget requires a non-empty benchmark corpus');
  const measuredMaximum = Math.max(...corpus.map(authoredSummarySerializedChars));
  return Math.ceil(measuredMaximum / SUMMARY_BUDGET_BUCKET_CHARS) * SUMMARY_BUDGET_BUCKET_CHARS;
}

export const MEASURED_SUMMARY_BUDGET_CHARS = deriveMeasuredSummaryBudgetChars();

export const FUNCTIONS_EXEC_CLIENT_RESIDUE_CLASSIFIER_VERSION = 1 as const;

export interface FunctionsExecCapabilityClassification {
  ptySession: boolean;
  clientTool: boolean;
  multimodalEmit: boolean;
  clientRuntime: boolean;
  clientOnlyResidue: boolean;
}

/** Classify the client-held surfaces named by P-002/P-025 from functions.exec source. */
export function classifyFunctionsExecSource(source: string): FunctionsExecCapabilityClassification {
  const ptySession = /tools\.(?:exec_command|write_stdin)\s*\(/.test(source);
  const clientTool = /tools\.(?:apply_patch|view_image|web__run|image_gen__imagegen)\s*\(/.test(source);
  const multimodalEmit = /(?:^|[^A-Za-z0-9_.])(?:image|audio|generatedImage)\s*\(/m.test(source);
  const clientRuntime =
    /(?:^|[^A-Za-z0-9_.])(?:store|load|notify|yield_control|setTimeout|clearTimeout)\s*\(/m.test(source);
  return {
    ptySession,
    clientTool,
    multimodalEmit,
    clientRuntime,
    clientOnlyResidue: ptySession || clientTool || multimodalEmit || clientRuntime,
  };
}

/**
 * Time-bounded live baseline from session_turn_parts.
 *
 * Writer/units verified before capture:
 * - search/session-ingest.ts stores Codex custom tool calls as tool_name='exec';
 * - transcript-text-caps.ts caps tool source at 2,000 chars plus a 25-char marker.
 *
 * Therefore the observed union is a lower bound. Only truncated rows with no
 * observed capability marker can widen it; assigning every such row to the
 * residue gives the conservative upper bound.
 */
export const FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT = {
  source: 'harness_shared.session_turn_parts',
  corpusWorkspaceId: 'default',
  sourceKind: 'codex',
  toolName: 'exec',
  classifierVersion: FUNCTIONS_EXEC_CLIENT_RESIDUE_CLASSIFIER_VERSION,
  firstTs: '2026-08-20T19:28:39.753Z',
  capturedThroughTs: '2026-08-22T20:12:38.804Z',
  totalCalls: 235_074,
  ptySessionCalls: 144_804,
  clientToolCalls: 2_041,
  multimodalEmitCalls: 167,
  clientRuntimeCalls: 447,
  observedUnionCalls: 147_103,
  truncatedCalls: 12_652,
  truncatedUnclassifiedCalls: 6_532,
} as const;

export function clientResidueBounds(snapshot = FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT): {
  lowerCalls: number;
  upperCalls: number;
  lowerFraction: number;
  upperFraction: number;
} {
  const lowerCalls = snapshot.observedUnionCalls;
  const upperCalls = lowerCalls + snapshot.truncatedUnclassifiedCalls;
  return {
    lowerCalls,
    upperCalls,
    lowerFraction: lowerCalls / snapshot.totalCalls,
    upperFraction: upperCalls / snapshot.totalCalls,
  };
}
