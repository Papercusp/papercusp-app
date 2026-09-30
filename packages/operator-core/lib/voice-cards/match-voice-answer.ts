/**
 * matchVoiceAnswer — pure function mapping a spoken transcript onto a
 * card's option set. The load-bearing parser for voice-aware cards.
 *
 * Plan: apps/operator/docs/plans/voice-aware-cards-2026-05-14.md §C.2
 *
 * Precedence (first match wins):
 *   1. Exact match against option id            → submit
 *   2. Exact match against option label         → submit
 *   3. Exact match against decline phrase       → decline
 *   4. Single substring match against label     → submit
 *      (multiple substring matches → ambiguous; zero → null)
 *
 * Special case (radio, single option): "ready" / "continue" / "go" /
 * "ok" / "okay" match the lone option's id at step 1. This makes the
 * silence-nudge Ready card work regardless of label phonetics.
 *
 * Confidence gate: if `transcript.confidence` is provided and below
 * `opts.minConfidence` (default 0.6), returns null. Realtime sessions
 * (when wired later) fill confidence; EL Conv AI doesn't, so its
 * matches always pass the gate (behavior unchanged for EL).
 *
 * Only `presentation.kind === 'radio'` is honored (M6). Bare askUser
 * without a presentation, or any other kind, returns null — those
 * cards stay announce-only.
 */

import type { OpenCardSnapshot, CardOption } from '@papercusp/agent-mcp';

import { isDeclinePhrase, normalize } from './decline-phrases';

export interface VoiceTranscript {
  text: string;
  /** STT engine confidence 0..1, optional. */
  confidence?: number;
  /** When the transcript was finalized (Date.now() at emit time). */
  tsMs: number;
}

export type MatchResult =
  | { action: 'submit'; payload: { picks: string[] } }
  | { action: 'decline' }
  | { action: 'ambiguous'; candidateIds: string[] }
  | null;

export interface MatchOpts {
  /** Minimum STT confidence to accept a match. Default 0.6. */
  minConfidence?: number;
}

const READY_SYNONYMS: ReadonlySet<string> = new Set([
  'ready',
  'continue',
  'go',
  'ok',
  'okay',
]);

const SUBSTRING_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with',
]);

/**
 * Voice answer matcher. See file header for precedence rules.
 */
export function matchVoiceAnswer(
  transcript: VoiceTranscript,
  card: OpenCardSnapshot,
  opts: MatchOpts = {},
): MatchResult {
  // Only radio presentation opts in (M6).
  const p = card.presentation;
  if (!p || p.kind !== 'radio') return null;

  const options = p.options;
  if (options.length === 0) return null;

  // Confidence gate. Skipped when undefined (caller engine doesn't report).
  const minConf = opts.minConfidence ?? 0.6;
  if (typeof transcript.confidence === 'number' && transcript.confidence < minConf) {
    return null;
  }

  const norm = normalize(transcript.text);
  if (norm.length === 0) return null;

  // Step 1: exact id match.
  for (const opt of options) {
    if (normalize(opt.id) === norm) {
      return submit(opt.id);
    }
  }

  // Step 1a: ready-style synonyms on a single-option radio.
  if (options.length === 1 && READY_SYNONYMS.has(norm)) {
    return submit(options[0].id);
  }

  // Step 2: exact label match.
  for (const opt of options) {
    if (normalize(opt.label) === norm) {
      return submit(opt.id);
    }
  }

  // Step 3: decline phrase.
  if (isDeclinePhrase(norm)) {
    return { action: 'decline' };
  }

  // Step 4: substring match against labels (token-bounded, stop-words stripped).
  const transcriptTokens = tokenize(norm);
  if (transcriptTokens.size === 0) return null;
  const matchIds: string[] = [];
  for (const opt of options) {
    const labelTokens = tokenize(normalize(opt.label));
    if (labelTokens.size === 0) continue;
    // "Single substring match" = every transcript content token appears
    // in the label, OR the label's content tokens are a subset of the
    // transcript. The asymmetry handles both "yes please" → "yes" and
    // "use existing" → "Use the existing version".
    if (
      isSubset(transcriptTokens, labelTokens)
      || isSubset(labelTokens, transcriptTokens)
    ) {
      matchIds.push(opt.id);
    }
  }
  if (matchIds.length === 1) return submit(matchIds[0]);
  if (matchIds.length > 1) {
    return { action: 'ambiguous', candidateIds: matchIds };
  }
  return null;
}

function submit(optionId: string): MatchResult {
  return { action: 'submit', payload: { picks: [optionId] } };
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.split(/\s+/)) {
    if (!w) continue;
    if (SUBSTRING_STOP_WORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Exported for tests / future shared use. */
export const __testing__ = { READY_SYNONYMS, SUBSTRING_STOP_WORDS, tokenize, isSubset };

/** Strip-down of CardOption to the fields the matcher needs. */
export type CardOptionView = Pick<CardOption, 'id' | 'label'>;
