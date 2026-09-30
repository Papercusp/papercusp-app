/**
 * candidate-review — the transferability bar + distillation for fleet-lesson
 * candidate auto-adoption (knowledge-pack-loop-integrity-2026-07-19 P-001,
 * fixing EI-18106960998481715), plus the candidate-signature normalizer
 * (P-002).
 *
 * WHY: recurrence-escalation stages candidates whose draftText is the NEWEST
 * member EI item's RAW body — watchdog incident text full of log hashes,
 * queue depths, and harness slugs. WI-5414's automated review only checked
 * CONTRADICTION against existing fleet-lessons items, so on 2026-07-19 it
 * adopted six raw incident bodies into the pack. This module adds the missing
 * judgment: is this actually a TRANSFERABLE lesson — and if so, what is the
 * lesson (the LLM REWRITES the draft into the compact rule; the pack carries
 * the distilled text, the candidate row keeps the raw provenance — plan
 * D-003).
 *
 * Failure posture (plan D-004 — the REVERSE of the old fail-open-to-adopt):
 * an errored/unparseable judgment returns verdict 'error' and the candidate
 * STAYS PENDING for the next tick. Never adopt-by-default.
 *
 * The LLM port is {@link LessonDistillerLlm} (transfer/types) — the same
 * shape live-deps' anthropicDistillerLlm implements (gateway-routed; unkeyed
 * processes ride the inference gateway's placeholder bearer since P-001
 * blender-loop-repair-2026-08-16; only unkeyed AND gatewayless no-ops, and
 * that no-op is now NAMED in the error reason instead of reading as a bare
 * parse failure).
 * PURE apart from the injected port: prompts + parsing pin in unit tests.
 */
import type { LessonDistillerLlm } from '../transfer/types';

/** Caps mirror transfer/distill.ts + pack-format expectations. */
const TITLE_CAP = 120;
const LESSON_TEXT_CAP = 1_200;
const DRAFT_RENDER_CAP = 6_000;
/** P-001 (blender-loop-repair-2026-08-16): 768 left ~zero headroom for a
 *  worst-case pass response (LESSON_TEXT_CAP chars of lesson + title + JSON
 *  scaffolding + any preamble the model emits despite "STRICT JSON") — a
 *  response cut at the token cap loses its closing brace and parses to null,
 *  which reads identically to a dead LLM. 1024 bought the full worst case on
 *  haiku. P-010 (opus-5 flip): thinking is ON by default on opus-5 and SHARES
 *  max_tokens with the response text, so the cap must also cover xhigh-depth
 *  thinking — 16K keeps the same closing-brace guarantee under thinking. */
export const TRANSFERABILITY_MAX_TOKENS = 16_000;
/** How much of an unparseable judge response survives into the error reason. */
const RAW_SNIPPET_CAP = 300;

export interface DistilledCandidate {
  title: string;
  text: string;
}

export type TransferabilityOutcome =
  | { verdict: 'pass'; reason: string; distilled: DistilledCandidate }
  | { verdict: 'fail'; reason: string }
  | { verdict: 'error'; reason: string };

export function buildTransferabilityPrompt(): string {
  return [
    'You review ONE candidate "fleet lesson" that a multi-agent coding platform',
    'wants to add to a shared knowledge pack. The candidate was auto-staged from',
    'recurring operational friction, so its draft is often a RAW incident report.',
    '',
    'A lesson is worth adopting ONLY if another agent, given it BEFORE a similar',
    'task in a DIFFERENT project, would do measurably better: a non-obvious',
    'gotcha, a verified root cause, a working procedure, a discovery rule.',
    'NOT adoptable: incident reports; ephemeral operational state (queue depths,',
    'counts, "X is currently stalled"); text bound to specific instances (log',
    'hashes, ids, host/harness/workspace names); task-specific trivia; generic',
    'best practice every agent already knows; restatements of an alert.',
    '',
    'If the draft CONTAINS a genuinely transferable rule, REWRITE it as that',
    'rule: strip every instance identifier, count, and slug; keep the cause →',
    'action content; one short paragraph.',
    '',
    'Return STRICT JSON, no prose outside it:',
    '  {"verdict":"pass","title":"<short imperative title>","lesson":"<the rewritten transferable lesson>"}',
    'or',
    '  {"verdict":"fail","reason":"<one line: why this is not a transferable lesson>"}',
  ].join('\n');
}

export function renderCandidateForReview(candidate: {
  title: string;
  draftText: string;
  scopes?: readonly string[];
  recurrenceCount?: number;
}): string {
  const scopes = candidate.scopes?.length ? `\nRecurred across: ${candidate.scopes.join(', ')}` : '';
  const count = candidate.recurrenceCount ? ` (${candidate.recurrenceCount}× recurrence)` : '';
  return `Candidate title: ${candidate.title}${count}${scopes}\n\nDraft body:\n${candidate.draftText.slice(0, DRAFT_RENDER_CAP)}`;
}

/**
 * Tolerant parse of the judge's response. Returns null when the response is
 * not a usable verdict (no JSON object, unknown verdict, pass without a
 * lesson) — the caller maps null to verdict 'error' (stay pending, D-004).
 */
export function parseTransferabilityResponse(text: string): TransferabilityOutcome | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.verdict === 'fail') {
    const reason =
      typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : 'judged not transferable';
    return { verdict: 'fail', reason: reason.slice(0, 500) };
  }
  if (o.verdict === 'pass') {
    const lesson = typeof o.lesson === 'string' ? o.lesson.trim() : '';
    if (!lesson) return null; // a pass MUST carry the rewritten lesson
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : lesson;
    return {
      verdict: 'pass',
      reason: 'judged transferable (distilled)',
      distilled: { title: title.slice(0, TITLE_CAP), text: lesson.slice(0, LESSON_TEXT_CAP) },
    };
  }
  return null;
}

/**
 * Run the transferability judgment on one candidate. Every failure mode
 * (LLM throw, empty/unparseable response) maps to verdict 'error' — the
 * candidate stays pending and the next tick retries (plan D-004).
 */
export async function judgeCandidateTransferability(
  candidate: { title: string; draftText: string; scopes?: readonly string[]; recurrenceCount?: number },
  llm: LessonDistillerLlm,
): Promise<TransferabilityOutcome> {
  let raw: string;
  try {
    const { text } = await llm({
      system: buildTransferabilityPrompt(),
      user: renderCandidateForReview(candidate),
      maxTokens: TRANSFERABILITY_MAX_TOKENS,
    });
    raw = text;
  } catch (e) {
    return {
      verdict: 'error',
      reason: `transferability judge errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const outcome = parseTransferabilityResponse(raw);
  if (!outcome) {
    // P-001: NEVER discard the raw response on parse-null — its shape is the
    // diagnosis. The bare "no usable verdict" reason hid an unkeyed-distiller
    // no-op ('[]') for 28 days (EI-20597533361555377).
    const { DISTILLER_NOOP_SENTINEL } = await import('../transfer/live-deps');
    if (raw.trim() === DISTILLER_NOOP_SENTINEL) {
      return {
        verdict: 'error',
        reason:
          'transferability judge got the distiller NO-OP sentinel — no ANTHROPIC_API_KEY in this process AND no inference-gateway route; the judge never ran. Fix the LLM wiring; retrying cannot help until it changes.',
      };
    }
    const snippet = JSON.stringify(raw.slice(0, RAW_SNIPPET_CAP));
    const truncated = raw.length > RAW_SNIPPET_CAP ? ` (first ${RAW_SNIPPET_CAP} of ${raw.length} chars)` : '';
    return {
      verdict: 'error',
      reason: `transferability judge returned no usable verdict; raw response${truncated}: ${snippet}`,
    };
  }
  return outcome;
}

/* ────────────────────────────────────────────────────────────────────────
 * P-002 — candidate-signature normalization
 * ──────────────────────────────────────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Hex run ≥8 chars containing at least one digit (so ordinary words never match). */
const HEX_RUN_RE = /^(?=.*\d)[0-9a-f]{8,}$/i;
const PURE_NUMBER_RE = /^\d+$/;

/**
 * Strip INSTANCE tokens (log hashes, uuids, bare numbers, `…`-truncated ids)
 * from a recurrence signature so one incident CLASS collapses to one
 * candidate — the two live replication-liveness candidates differed only by
 * log hash and were staged (then adopted) twice (EI-18106960998481715).
 * digest.ts's signatureRecurrence itself is untouched (P-002): this runs at
 * candidate STAGING only, so severity-escalation dedup keeps its keyspace.
 * Falls back to the original signature when stripping would empty it.
 */
export function normalizeCandidateSignature(signature: string): string {
  const kept = signature
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => {
      const bare = tok.replace(/…+$/g, '');
      if (PURE_NUMBER_RE.test(bare)) return false;
      if (UUID_RE.test(bare)) return false;
      if (HEX_RUN_RE.test(bare)) return false;
      return true;
    });
  const normalized = kept.join(' ').trim();
  return normalized.length > 0 ? normalized : signature.trim();
}
