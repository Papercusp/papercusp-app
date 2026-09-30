/**
 * Nightly lesson distillation (P-022 / FB-08): one LLM pass per transcript →
 * up to N candidate lessons. The LLM is a port ({@link LessonDistillerLlm});
 * parsing is tolerant (a malformed response yields zero lessons, never a
 * throw) and everything is capped — the tick admits, it doesn't flood.
 *
 * `lessonSignature` is the structural dedup key (sha-256 of the normalized
 * text): the transfer_lessons UNIQUE constraint rides it, and knowledge-pack
 * candidates are matched on the same key (the D-006 inherit-the-bar join).
 */
import { createHash } from 'node:crypto';
import { renderTurns } from '../replay/transcript';
import type { ReplayTranscript } from '../replay/types';
import type { DistilledLesson, LessonDistillerLlm } from './types';

/** Normalized-text sha-256 — whitespace/case drift maps to one signature. */
export function lessonSignature(lessonText: string): string {
  const normalized = lessonText.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

const TRANSCRIPT_RENDER_CAP = 24_000;
const LESSON_TEXT_CAP = 1_200;
const TITLE_CAP = 120;
/** P-010 (opus-5 flip): thinking is ON by default on opus-5 and shares max_tokens
 *  with the response text, so this cap covers xhigh-depth thinking too — 1024 was
 *  sized for haiku (no thinking) and would truncate the closing brace. */
const DISTILL_MAX_TOKENS = 16_000;

/**
 * Cut `s` to at most `maxLen` chars WITHOUT chopping the last word in half
 * (EI-18121665970916886 — a bare `.slice(0, TITLE_CAP)` produced titles like
 * "…not class matchin" mid-word). Cuts at the last space at or before the
 * budget (reserving one char for the ellipsis) and appends an ellipsis; falls
 * back to a hard cut only when there's no space to cut on within budget (one
 * very long unbroken word).
 */
function truncateAtWordBoundary(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${boundary.trimEnd()}…`;
}

export function buildDistillSystemPrompt(maxLessons: number): string {
  return [
    'You distill TRANSFERABLE lessons from one coding-agent transcript.',
    'A good lesson is a compact, self-contained rule another agent could be',
    'given BEFORE attempting a similar task and thereby do measurably better:',
    'a non-obvious gotcha, a verified root cause, a procedure that worked',
    'after others failed. NOT good: task-specific trivia, restatements of the',
    'task, generic best practice the agent already knows.',
    '',
    `Return STRICT JSON: an array of at most ${maxLessons} objects, each`,
    '{"title": "<short imperative title>", "lesson": "<1 short paragraph>"}.',
    'Return [] when the transcript taught nothing transferable. No prose',
    'outside the JSON.',
  ].join('\n');
}

/** Tolerant parse of the distiller's response: best-effort JSON-array
 *  extraction; junk entries are skipped, fields capped. */
export function parseDistilledLessons(text: string, maxLessons: number): DistilledLesson[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DistilledLesson[] = [];
  for (const entry of parsed) {
    if (out.length >= maxLessons) break;
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const lessonText = typeof e.lesson === 'string' ? e.lesson.trim() : '';
    if (!lessonText) continue;
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : lessonText;
    out.push({
      title: truncateAtWordBoundary(title, TITLE_CAP),
      lessonText: lessonText.slice(0, LESSON_TEXT_CAP),
    });
  }
  return out;
}

export interface DistillResult {
  lessons: DistilledLesson[];
  costUsd: number;
}

/**
 * Distill one transcript. Transcripts too short to teach anything (fewer
 * than `minTurns` turns) are skipped at zero cost.
 */
export async function distillLessonsFromTranscript(
  transcript: ReplayTranscript,
  llm: LessonDistillerLlm,
  opts: { maxLessons: number; minTurns?: number },
): Promise<DistillResult> {
  const minTurns = opts.minTurns ?? 4;
  if (transcript.turns.length < minTurns) return { lessons: [], costUsd: 0 };
  const rendered = renderTurns(transcript.turns, { maxChars: TRANSCRIPT_RENDER_CAP, keep: 'tail' });
  const { text, costUsd } = await llm({
    system: buildDistillSystemPrompt(opts.maxLessons),
    user: `Transcript (${transcript.ref}):\n\n${rendered}`,
    maxTokens: DISTILL_MAX_TOKENS,
  });
  return { lessons: parseDistilledLessons(text, opts.maxLessons), costUsd };
}
