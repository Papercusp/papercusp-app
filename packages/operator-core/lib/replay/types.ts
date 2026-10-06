/**
 * Replay-harness vocabulary (self-learning-frontier-2026-06-12 P-020 / FB-06).
 *
 * The replay harness re-runs an agent from a HISTORICAL transcript point (or a
 * synthetic context) under a MODIFIED prompt/policy and scores the divergence —
 * the single substrate for regret mining (P-021), the transfer harness (P-022),
 * and shadow ablation (P-023). It is a consumer of the ONE eval-battery engine
 * (`@papercusp/eval-battery`, reconciliation D-001): a cell's `variant` = a
 * policy delta, `run` = a replayed continuation, and the frozen judge scores
 * the distilled result. Everything this substrate emits is born
 * `origin = 'replay'` (provenance D-002, migration 241's vocabulary).
 *
 * Ports (all injectable — unit tests run with fakes, zero LLM/PG):
 *   - {@link ReplayRunner}     — produces the replayed continuation (live: an
 *     LLM call or agent spawn; tests: a fake).
 *   - {@link TranscriptSource} — loads a historical transcript by ref
 *     (default: the `.papercusp/logs/*.jsonl` filesystem source).
 *   - {@link ReplayStore}      — persists cell lifecycle (PG impl in store.ts;
 *     in-memory fakes in tests).
 */
import type { SignalOrigin } from '../harness/improvements/provenance';
import type { LlmExecutionReceipt } from '@papercusp/testing-shell/llm';

/** The governor registration id for this loop (migration 244 vocabulary). */
export const REPLAY_LOOP_ID = 'frontier:replay-harness';

/** Every replay output is born with this origin (D-002). */
export const REPLAY_ORIGIN: SignalOrigin = 'replay';

/** A parsed transcript turn. `tool_use`/`tool_result` keep agentic structure
 *  visible to the divergence signals without modeling every backend's shape. */
export type ReplayTurnRole = 'system' | 'user' | 'assistant' | 'tool_use' | 'tool_result';

export interface ReplayTurn {
  /** Position in the parsed transcript (0-based, stable). */
  index: number;
  role: ReplayTurnRole;
  text: string;
  /** Tool name for tool_use turns, when the stream carried one. */
  toolName?: string;
  /** Event timestamp (ms) when the stream carried one. */
  ts?: number;
}

export interface ReplayTranscript {
  /** Stable reference (file path / uri) — provenance + the store's case_ref. */
  ref: string;
  /** Backend attribution when derivable ('claude-code' | 'codex' | 'omp'). */
  backend?: string;
  model?: string;
  turns: ReplayTurn[];
}

/** Loads historical transcripts by ref (FB-07 brings its own selection
 *  heuristics on top — this port only resolves a chosen ref). */
export interface TranscriptSource {
  load(ref: string): Promise<ReplayTranscript>;
}

/**
 * The policy delta a variant applies to the replayed agent. Generic by design
 * (the three consumers' needs, from their P-items): a regret-mining candidate
 * rule = `systemOverlay`; a transfer-harness lesson = `systemOverlay`; a
 * sedimentology ablation = `systemReplace` (the rule removed from the base).
 */
export interface ReplayPolicy {
  /** Appended to the base replay system prompt. */
  systemOverlay?: string;
  /** Replaces the base replay system prompt wholesale (ablations). */
  systemReplace?: string;
  /** Model override for the replayed continuation — the experiment model-per-arm knob
   *  (experiment-registry-invocation-api P-063). Falls back to the runner's default when
   *  unset; regret/transfer never set it, so this is additive + behavior-neutral for them. */
  model?: string;
  /** Human note (what this delta hypothesizes) — recorded, not executed. */
  note?: string;
}

export interface ReplayVariant {
  variantId: string;
  label: string;
  policy: ReplayPolicy;
}

/**
 * One replay case. `historical` = re-run from `turnIndex` of a real
 * transcript (turns before it become the context; turns from it on are the
 * original continuation — the divergence anchor). `synthetic` = a constructed
 * context with no historical continuation.
 */
export type ReplayCase =
  | {
      kind: 'historical';
      caseId: string;
      transcript: ReplayTranscript;
      /** Replay FROM this turn: context = turns[0..turnIndex). Must be ≥ 1. */
      turnIndex: number;
      /** Judge intent; defaults to the first user turn's text. */
      intent?: string;
      projectContext?: string;
    }
  | {
      kind: 'synthetic';
      caseId: string;
      context: string;
      intent: string;
      projectContext?: string;
    };

/** The eval-battery TCell: one (variant × case × repeat). */
export interface ReplayRunInput {
  variant: ReplayVariant;
  replayCase: ReplayCase;
  repeat: number;
}

/** The eval-battery THandle: the replayed continuation + its spend. */
export interface ReplayRunHandle {
  outputText: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** False when the handle is the historical continuation echoed as the
   *  zero-cost baseline (no runner invoked). */
  replayed: boolean;
  /** Identity supplied by the runner that actually made the continuation call.
   * Absent for historical echoes and runners that cannot attest their execution. */
  execution?: LlmExecutionReceipt;
}

/** Produces the replayed continuation for one cell. */
export interface ReplayRunner {
  (input: {
    /** Assembled from the variant's policy via buildReplaySystemPrompt. */
    systemPrompt: string;
    /** Deterministic rendering of the case context (tail-capped). */
    contextText: string;
    replayCase: ReplayCase;
    variant: ReplayVariant;
  }): Promise<ReplayRunHandle>;
}

/** Cell-lifecycle persistence (PG impl: store.ts; tests use in-memory fakes). */
export interface ReplayStore {
  startRun(r: {
    runId: string;
    batteryId: string;
    variant: ReplayVariant;
    replayCase: ReplayCase;
    repeat: number;
  }): Promise<void>;
  finishRun(
    runId: string,
    fields: { divergence: unknown; costUsd: number; elapsedMs: number },
  ): Promise<void>;
  recordScore(
    runId: string,
    score: {
      d1: number;
      d2: number;
      d3: number;
      composite: number;
      rationale: string;
      rubricHash: string;
      costUsd: number;
    },
  ): Promise<void>;
  markFailed(
    runId: string,
    fields: { status: 'rate_limited' | 'errored'; error: string; elapsedMs: number },
  ): Promise<void>;
}

/** The case_ref recorded for a case (transcript ref / synthetic:<caseId>). */
export function replayCaseRef(replayCase: ReplayCase): string {
  return replayCase.kind === 'historical' ? replayCase.transcript.ref : `synthetic:${replayCase.caseId}`;
}
