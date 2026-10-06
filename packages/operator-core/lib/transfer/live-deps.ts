/**
 * Live ports for the transfer tick (P-022 / FB-08) — the PG/fs/LLM glue
 * behind {@link TransferTickDeps}. Kept out of tick.ts so unit tests import
 * the pure flow without touching pools, the registry, or the live LLM bridge.
 *
 *   - lister: fs scan of every registry project's `.papercusp/logs/*.jsonl`
 *     (the scanAgentRuns dir convention), mtime-windowed, newest first.
 *     PG-canonical runs write no jsonl (harness-agent-runs.ts note) — those
 *     arrive when lib/replay's TranscriptSource grows a PG leg (FB-06's
 *     port); this lister is deliberately the same corpus replay reads today.
 *   - llm: canonical learning-model distiller through llm-testing's Codex
 *     Responses bridge, cost taken from the shared transport result.
 *   - replay: the governed replay battery (replay-adapter.ts) with an
 *     canonical continuation student and the house frozen judge
 *     (lib/llm-testing/llm-client — the gym's judge path). Double-gated at
 *     run time: the transfer action's own flag+governor AND the replay
 *     substrate's flag+budget (both P-001 arming acts).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import { runGovernedSpendAttempt } from '../learning-governor/registrants';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';
import { computeOwnSourceHash } from '../scout/src-hash';
import { getMemoryBackend } from '../memory/backend';
import { harnessDir } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { fsTranscriptSource } from '../replay/transcript';
import type { ReplayRunner } from '../replay/types';
import { transferReplayPort } from './replay-adapter';
import {
  admitTransferLesson,
  listLessonsForTesting,
  markTransferError,
  recordTransferOutcome,
  setLessonMemoryId,
} from './store';
import type { TransferStorePort, TransferTickDeps } from './tick';
import {
  TRANSFER_LOOP_ID,
  TRANSFER_ORIGIN,
  type LessonDistillerLlm,
  type TranscriptRefLister,
  type TransferReplayPort,
} from './types';

export const TRANSFER_DISTILL_MODEL = LEARNING_MODEL_SPEC;
export const TRANSFER_STUDENT_MODEL = LEARNING_MODEL_SPEC;
const TRANSFER_LIVE_SOURCE_HASH = computeOwnSourceHash(import.meta.url);
const DISTILL_TIMEOUT_MS = 180_000;
const STUDENT_MAX_TOKENS = 2_048;
const STUDENT_TIMEOUT_MS = 120_000;
type TransferLlmCall = typeof import('../llm-testing/llm-client').llmCall;

async function defaultTransferLlmCall(opts: Parameters<TransferLlmCall>[0]) {
  const { llmCall } = await import('../llm-testing/llm-client');
  return llmCall(opts);
}

async function callWithTimeout(
  call: TransferLlmCall,
  input: Omit<Parameters<TransferLlmCall>[0], 'signal'>,
  timeoutMs: number,
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`transfer LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  try {
    return await call({ ...input, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Recent `.papercusp/logs/*.jsonl` across every registry project. */
export function fsTranscriptRefLister(workspaceId?: string): TranscriptRefLister {
  return async ({ windowMs, cap }) => {
    const registry = await loadHarnessRegistry(workspaceId);
    const cutoff = Date.now() - windowMs;
    const hits: Array<{ ref: string; mtimeMs: number }> = [];
    for (const project of registry.projects) {
      const logDir = join(harnessDir(project), 'logs');
      let files: string[];
      try {
        files = readdirSync(logDir);
      } catch {
        continue; // no logs dir for this project
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const ref = join(logDir, f);
        try {
          const { mtimeMs } = statSync(ref);
          if (mtimeMs >= cutoff) hits.push({ ref, mtimeMs });
        } catch {
          /* raced a deletion — skip */
        }
      }
    }
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return hits.slice(0, cap).map((h) => h.ref);
  };
}

/** The unkeyed-and-gatewayless no-op sentinel. Exported so judge-side callers
 *  (candidate-review) can NAME this condition in their error reason instead of
 *  reporting a bare "no usable verdict" — that anonymity is how the
 *  transferability judge sat dead for 28 days (EI-20597533361555377). */
export const DISTILLER_NOOP_SENTINEL = '[]';

export interface TransferLearningLlmOptions {
  model?: string;
  llmCall?: TransferLlmCall;
  /** Deprecated compatibility field; Codex auth is resolved by the shared gateway. */
  apiKey?: string;
}

/** Provider-neutral transfer distiller through the canonical Responses seam. */
export function learningDistillerLlm(opts: TransferLearningLlmOptions = {}): LessonDistillerLlm {
  const model = opts.model ?? TRANSFER_DISTILL_MODEL;
  const call = opts.llmCall ?? defaultTransferLlmCall;
  return async ({ system, user, maxTokens }) => {
    const response = await callWithTimeout(
      call,
      {
        model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens,
        priority: 'transfer',
      },
      DISTILL_TIMEOUT_MS,
    );
    return { text: response.text, costUsd: response.costUsd };
  };
}

/** Provider-neutral continuation student over the rendered replay case. */
export function learningStudentRunner(opts: TransferLearningLlmOptions = {}): ReplayRunner {
  const model = opts.model ?? TRANSFER_STUDENT_MODEL;
  const call = opts.llmCall ?? defaultTransferLlmCall;
  return async ({ systemPrompt, contextText }) => {
    const response = await callWithTimeout(
      call,
      {
        model,
        system: systemPrompt,
        messages: [{ role: 'user', content: contextText }],
        maxTokens: STUDENT_MAX_TOKENS,
        priority: 'transfer',
      },
      STUDENT_TIMEOUT_MS,
    );
    return {
      outputText: response.text,
      costUsd: response.costUsd,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      replayed: true,
      execution: { model: response.execution?.model ?? model, codeHash: null,
        loadedCode: { ...response.execution?.loadedCode, student: TRANSFER_LIVE_SOURCE_HASH },
        unresolved: response.execution?.unresolved?.length ? response.execution.unresolved :
          ['student-transport-completeness'] },
    };
  };
}

/** @deprecated Use {@link learningDistillerLlm}. Kept for callers during the provider-neutral cutover. */
export const anthropicDistillerLlm = learningDistillerLlm;
/** @deprecated Use {@link learningStudentRunner}. Kept for callers during the provider-neutral cutover. */
export const anthropicStudentRunner = learningStudentRunner;

/** The live student-transfer port: governed replay battery + house judge.
 *  Lazy judge import — the llm-client graph loads only when a test runs. */
export function liveTransferReplayPort(workspaceId: string): TransferReplayPort {
  return async (input) => {
    const { llmCall } = (await import('../llm-testing/llm-client')) as { llmCall: JudgeLlmCall };
    const port = transferReplayPort({ workspaceId, runner: learningStudentRunner(), llmCall });
    return port(input);
  };
}

/** store.ts bound to the live pool — the TransferStorePort the tick consumes. */
export function pgTransferStorePort(sql: Sql): TransferStorePort {
  return {
    admit: (input) => admitTransferLesson(sql, input),
    listForTesting: (q) => listLessonsForTesting(sql, q),
    recordOutcome: (q) => recordTransferOutcome(sql, q),
    markError: (q) => markTransferError(sql, q),
    setMemoryId: (q) => setLessonMemoryId(sql, q),
  };
}

/** The live tick deps. Memory degrades to null when the backend is
 *  unavailable (lessons still tracked in PG). */
export function defaultTransferTickDeps(sql: Sql, workspaceId: string): TransferTickDeps {
  return {
    store: pgTransferStorePort(sql),
    // P-005: reserve → run → settle, so a distiller call that throws or costs
    // nothing still closes an attempt on the governor ledger. `accumulate:true`
    // as before — the governor is this loop's only spend store.
    spendAttempt: (q) =>
      runGovernedSpendAttempt({
        workspaceId,
        loopId: TRANSFER_LOOP_ID,
        attemptKind: q.attemptKind,
        requestedUsd: q.requestedUsd,
        signalOrigin: TRANSFER_ORIGIN,
        runRef: q.runRef ?? null,
        note: q.note,
        accumulate: true,
        run: q.run,
      },
      // Hand the tick's already-open admin pool to the governor rather than
      // letting it resolve a second one.
      { getSql: async () => sql }),
    lister: fsTranscriptRefLister(workspaceId),
    source: fsTranscriptSource(),
    llm: learningDistillerLlm(),
    replay: liveTransferReplayPort(workspaceId),
    memory: getMemoryBackend(),
    log: (m) => console.log(`[transfer-distill] ${m}`),
  };
}
