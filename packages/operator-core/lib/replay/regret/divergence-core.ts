/**
 * divergence-core.ts — pure divergence-turn detection for regret mining
 * (self-learning-frontier-2026-06-12 P-021 / FB-07).
 *
 * Given a parsed transcript (transcript-core.ts), locate the assistant turn
 * where the trajectory went bad. Four signals, each with a turn + confidence:
 *
 *   error-loop      — earliest start of ≥ errorRunMin CONSECUTIVE failing tool
 *                     calls (call order across turns). The classic retry storm.
 *   repeat-loop     — the same tool re-invoked with an IDENTICAL input key
 *                     ≥ repeatMin times; divergence anchors at the second
 *                     occurrence (where looping became visible).
 *   burn-inflection — per-turn output-token rate spikes to ≥ inflectionFactor ×
 *                     the median of all preceding turns (with an absolute
 *                     floor, so quiet sessions don't trigger on noise).
 *   rescue-marker   — a human/peer rescue (yield / turn-interrupt) marker in
 *                     the injected user content; the rescue is evidence the
 *                     trajectory had already gone wrong by that turn.
 *
 * `pickDivergence` returns the EARLIEST strong signal (ties → higher
 * confidence): regret mining wants the first moment a different rule could
 * have changed the outcome, not the loudest later symptom.
 */

import type { ParsedTranscript } from './transcript-core';

export type DivergenceKind = 'error-loop' | 'repeat-loop' | 'burn-inflection' | 'rescue-marker';

export interface DivergenceFinding {
  kind: DivergenceKind;
  /** Assistant-turn index (transcript-core ordinal) where the trajectory diverged. */
  turn: number;
  /** 0..1 heuristic confidence. */
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface DivergenceOptions {
  /** Consecutive failing tool calls that constitute an error loop. Default 3. */
  errorRunMin?: number;
  /** Identical (tool, input) invocations that constitute a repeat loop. Default 3. */
  repeatMin?: number;
  /** Burn spike factor over the preceding-median per-turn output tokens. Default 3. */
  inflectionFactor?: number;
  /** Minimum preceding turns before an inflection can be called. Default 5. */
  inflectionMinPriorTurns?: number;
  /** Absolute per-turn output-token floor for an inflection window. Default 200. */
  inflectionMinTokens?: number;
}

const DEFAULTS: Required<DivergenceOptions> = {
  errorRunMin: 3,
  repeatMin: 3,
  inflectionFactor: 3,
  inflectionMinPriorTurns: 5,
  inflectionMinTokens: 200,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** All signals above bar, in detection order. Exposed for evidence/reporting. */
export function detectDivergenceSignals(
  transcript: ParsedTranscript,
  options: DivergenceOptions = {},
): DivergenceFinding[] {
  const opts = { ...DEFAULTS, ...options };
  const findings: DivergenceFinding[] = [];

  // Flatten tool calls in issue order, remembering the owning turn.
  const calls = transcript.turns.flatMap((turn) =>
    turn.toolCalls.map((call) => ({ turn: turn.index, name: call.name, inputKey: call.inputKey, isError: call.isError })),
  );

  // ── error-loop: earliest run of consecutive failures ──────────────────────
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i <= calls.length; i++) {
    if (i < calls.length && calls[i].isError) {
      if (runLength === 0) runStart = i;
      runLength += 1;
      continue;
    }
    if (runLength >= opts.errorRunMin) {
      const first = calls[runStart];
      findings.push({
        kind: 'error-loop',
        turn: first.turn,
        confidence: clamp01(0.5 + 0.1 * (runLength - opts.errorRunMin)),
        evidence: {
          runLength,
          tools: [...new Set(calls.slice(runStart, runStart + runLength).map((c) => c.name))],
        },
      });
      break; // earliest run only
    }
    runLength = 0;
  }

  // ── repeat-loop: identical (tool, input) re-invocations ───────────────────
  const occurrences = new Map<string, { count: number; secondTurn: number; name: string }>();
  let repeatFinding: DivergenceFinding | null = null;
  for (const call of calls) {
    const key = `${call.name}\x00${call.inputKey}`;
    const entry = occurrences.get(key) ?? { count: 0, secondTurn: -1, name: call.name };
    entry.count += 1;
    if (entry.count === 2) entry.secondTurn = call.turn;
    occurrences.set(key, entry);
    if (entry.count >= opts.repeatMin) {
      const candidate: DivergenceFinding = {
        kind: 'repeat-loop',
        turn: entry.secondTurn,
        confidence: clamp01(0.5 + 0.1 * (entry.count - opts.repeatMin)),
        evidence: { tool: entry.name, identicalCalls: entry.count },
      };
      // Keep the earliest-anchored (then most-repeated) loop.
      if (
        repeatFinding === null ||
        candidate.turn < repeatFinding.turn ||
        (candidate.turn === repeatFinding.turn && candidate.confidence > repeatFinding.confidence)
      ) {
        repeatFinding = candidate;
      }
    }
  }
  if (repeatFinding) findings.push(repeatFinding);

  // ── burn-inflection: output-token rate spike over the preceding median ────
  const burns = transcript.turns.map((t) => t.outputTokens);
  for (let i = opts.inflectionMinPriorTurns; i < burns.length; i++) {
    const prior = median(burns.slice(0, i));
    if (prior <= 0) continue;
    const bar = opts.inflectionFactor * prior;
    // The anchoring turn itself must spike (the window alone would anchor one
    // flat turn early); the forward window mean confirms it is sustained-ish.
    if (burns[i] < bar || burns[i] < opts.inflectionMinTokens) continue;
    const window = burns.slice(i, i + 3);
    const windowMean = window.reduce((a, b) => a + b, 0) / window.length;
    if (windowMean >= bar && windowMean >= opts.inflectionMinTokens) {
      findings.push({
        kind: 'burn-inflection',
        turn: i,
        confidence: clamp01(0.4 + 0.1 * (windowMean / (opts.inflectionFactor * prior))),
        evidence: { priorMedianTokens: prior, windowMeanTokens: Math.round(windowMean) },
      });
      break; // earliest inflection only
    }
  }

  // ── rescue-marker: a human/peer had to step in ─────────────────────────────
  const rescueTurn = transcript.rescueMarkerTurns[0];
  if (rescueTurn !== undefined) {
    findings.push({
      kind: 'rescue-marker',
      turn: rescueTurn,
      confidence: 0.6,
      evidence: { markerTurns: transcript.rescueMarkerTurns },
    });
  }

  return findings;
}

/** The divergence turn: earliest signal wins; ties break to higher confidence. */
export function pickDivergence(signals: readonly DivergenceFinding[]): DivergenceFinding | null {
  let best: DivergenceFinding | null = null;
  for (const signal of signals) {
    if (best === null || signal.turn < best.turn || (signal.turn === best.turn && signal.confidence > best.confidence)) {
      best = signal;
    }
  }
  return best;
}
