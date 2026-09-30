/**
 * The D-006 transfer gate — PURE promotion/demotion/retention decisions
 * (P-022 / FB-08). No IO: the tick feeds it battery outcomes; the store
 * persists what it decides. Heavily unit-tested (gate.test.ts).
 *
 * The rules, verbatim from the plan:
 *   - a lesson is RETAINED/PROMOTED only if the with-lesson student BEATS the
 *     baseline (composite delta strictly above `minDelta`);
 *   - a failure DEMOTES to probationary (a previously-validated lesson that
 *     fails a retest loses its tier — the memory unit test, re-runnable);
 *   - admission is NEVER gated here (D-006: the same-turn insight rule is
 *     untouched) — the gate applies to retention/promotion only;
 *   - repeated failures with no pass ever ⇒ 'retired' (the retention
 *     decision; the tick forgets the memory entry).
 */
import type { TransferStatus, TransferTier } from './types';

export interface TransferGateOptions {
  /** Composite-score margin the with-lesson run must beat baseline by.
   *  Strictly-greater: a tie is a fail (the lesson earned nothing). */
  minDelta: number;
  /** Consecutive-lifetime fail count (with zero passes) that retires. */
  maxFailsBeforeRetire: number;
}

export const DEFAULT_TRANSFER_GATE: TransferGateOptions = {
  // Composite is the eval-battery judge's 0–10 scale; half a point is above
  // judge jitter for a single-cell battery without demanding a miracle.
  minDelta: 0.5,
  maxFailsBeforeRetire: 3,
};

export type TransferVerdict = 'passed' | 'failed';

/** The student-transfer test: did the lesson actually transfer? */
export function transferVerdict(
  outcome: { withComposite: number; baselineComposite: number },
  opts: Pick<TransferGateOptions, 'minDelta'> = DEFAULT_TRANSFER_GATE,
): TransferVerdict {
  return outcome.withComposite - outcome.baselineComposite > opts.minDelta ? 'passed' : 'failed';
}

export interface GateTransition {
  tier: TransferTier;
  status: TransferStatus;
  passCount: number;
  failCount: number;
  /** True when the tier change requires the memory entry forgotten. */
  forgetMemory: boolean;
}

/**
 * Apply one verdict to a lesson's lifecycle counters. Pure — the caller
 * persists the transition and mirrors `tier` onto the memory entry's
 * metadata (promotion/demotion) or forgets it (retirement).
 */
export function applyTransferVerdict(
  lesson: { tier: TransferTier; passCount: number; failCount: number },
  verdict: TransferVerdict,
  opts: Pick<TransferGateOptions, 'maxFailsBeforeRetire'> = DEFAULT_TRANSFER_GATE,
): GateTransition {
  if (verdict === 'passed') {
    return {
      tier: 'validated',
      status: 'passed',
      passCount: lesson.passCount + 1,
      failCount: lesson.failCount,
      forgetMemory: false,
    };
  }
  const failCount = lesson.failCount + 1;
  const retire = lesson.passCount === 0 && failCount >= opts.maxFailsBeforeRetire;
  return {
    tier: retire ? 'retired' : 'probationary',
    status: 'failed',
    passCount: lesson.passCount,
    failCount,
    forgetMemory: retire,
  };
}

/** Tick tuning — every knob payload_template-overridable (the negative-space
 *  miner's demandOptionsFromPayload pattern). */
export interface TransferTickOptions extends TransferGateOptions {
  /** How far back the nightly distillation looks for transcripts. */
  windowMs: number;
  /** Max transcripts distilled per tick. */
  maxTranscriptsPerTick: number;
  /** Max candidate lessons admitted per transcript. */
  maxLessonsPerTranscript: number;
  /** Max student-transfer tests run per tick (each is a replay battery). */
  maxTestsPerTick: number;
  /** Memory scope probationary lessons are admitted into. */
  memoryScope: string;
}

export const DEFAULT_TRANSFER_TICK: TransferTickOptions = {
  ...DEFAULT_TRANSFER_GATE,
  windowMs: 24 * 60 * 60_000,
  maxTranscriptsPerTick: 12,
  maxLessonsPerTranscript: 3,
  maxTestsPerTick: 5,
  memoryScope: 'harness:papercup',
};

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Parse tick options from a routine payload_template (unknown-shaped). */
export function transferOptionsFromPayload(payload: unknown): TransferTickOptions {
  const p = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const windowHours = num(p.windowHours);
  return {
    minDelta: num(p.minDelta) ?? DEFAULT_TRANSFER_TICK.minDelta,
    maxFailsBeforeRetire: num(p.maxFailsBeforeRetire) ?? DEFAULT_TRANSFER_TICK.maxFailsBeforeRetire,
    windowMs: windowHours !== undefined ? windowHours * 60 * 60_000 : DEFAULT_TRANSFER_TICK.windowMs,
    maxTranscriptsPerTick: num(p.maxTranscriptsPerTick) ?? DEFAULT_TRANSFER_TICK.maxTranscriptsPerTick,
    maxLessonsPerTranscript: num(p.maxLessonsPerTranscript) ?? DEFAULT_TRANSFER_TICK.maxLessonsPerTranscript,
    maxTestsPerTick: num(p.maxTestsPerTick) ?? DEFAULT_TRANSFER_TICK.maxTestsPerTick,
    memoryScope:
      typeof p.memoryScope === 'string' && p.memoryScope.length > 0
        ? p.memoryScope
        : DEFAULT_TRANSFER_TICK.memoryScope,
  };
}
