/**
 * parse-work-refs.ts — pure work/plan-item reference extraction from chat
 * markdown-ish prose (chat-ref-pills-2026-07-26 P-001). No React, no IO.
 *
 * Reuses the WI-/EI-/F- id shape and the 'work-item'/'plan-item' kind
 * vocabulary from
 * packages/operator-core/lib/agent-tools/coordination/ref-hydrate.ts (read
 * first per the plan) rather than inventing a second one. What's DIFFERENT
 * here: this needs character POSITIONS (start/end) so a caller can splice
 * pill nodes into rendered markdown text, and it must be markdown-aware
 * enough to skip refs that are already inside a fenced/inline code span or
 * an existing markdown link — double-linkifying prose inside a link, or
 * "linkifying" a ref that's part of a code sample, is worse than missing a
 * pill (mirrors ref-hydrate's fail-soft-but-visible stance, just applied at
 * extraction time instead of render time).
 *
 * P-NNN scoping (resolving a plan-item ref against the message's plan_slug,
 * or falling back to plain text with no plan context) is P-006 — a SEPARATE
 * step downstream of this pure extraction, per the plan's "Known ambiguity"
 * section. This module only reports that a P-NNN token was seen; it does
 * not know or care which plan it belongs to.
 */

export type WorkRefKind = 'work-item' | 'plan-item';

export interface WorkRefMatch {
  /** 'work-item' for WI-/EI-/F- ids; 'plan-item' for a bare P-NNN token
   *  (plan scoping against message context is a separate step — P-002/P-006). */
  kind: WorkRefKind;
  /** The exact matched token, normalized to uppercase (e.g. "WI-5927",
   *  "EI-42", "F-100", "P-001"). */
  id: string;
  /** Character offset (inclusive) into `text` where the match starts. */
  start: number;
  /** Character offset (exclusive) into `text` where the match ends. */
  end: number;
}

// Word-bounded so 'WI-123' matches inside a sentence but 'XWI-123' or
// 'WI-123abc' (a ref glued into a larger identifier) does not — same
// convention as ref-hydrate.ts's BODY_WORK_ITEM (case-sensitive, no /i).
const WORK_ITEM_REF = /\b(WI|EI|F)-(\d+)\b/g;
// Plan-item ids are unique only within a plan and always carry >= 3 digits
// (ref-hydrate.ts's PLAN_ITEM: `P-\d{3,}`) — P-01 is not a real plan-item
// shape, so requiring 3 digits also cuts accidental false positives.
const PLAN_ITEM_REF = /\bP-(\d{3,})\b/g;

// ``` … ``` (or an unterminated fence running to end-of-text).
const FENCED_BLOCK = /```[\s\S]*?(?:```|$)/g;
// N backticks … the SAME N backticks (approximates CommonMark inline code
// spans; good enough for "don't linkify inside `WI-123`").
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
// [label](url) or ![label](url) — an existing markdown link/image; a ref
// inside either half is already linked (or is part of a URL), so it must
// not be treated as free prose.
const MD_LINK = /!?\[[^\]]*\]\([^)]*\)/g;

/** Overwrite `chars[start, end)` with spaces, in place (length-preserving). */
function blank(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) chars[i] = ' ';
}

/**
 * Build a same-length "scan text" with fenced code blocks, inline code
 * spans, and existing markdown links blanked out (replaced with spaces) so
 * refs inside them are invisible to the extraction regexes, while every
 * other character — and therefore every surviving match's start/end offset
 * — lines up exactly with the ORIGINAL text. Order matters: fences are
 * masked first so a later inline-code/link scan never crosses into a
 * fenced block's own backticks/brackets; inline code is masked next so a
 * link scan doesn't chase a bracket that's really inside a code span.
 */
function maskNonProse(text: string): string {
  const chars = text.split('');

  for (const m of text.matchAll(FENCED_BLOCK)) {
    blank(chars, m.index!, m.index! + m[0].length);
  }

  let scan = chars.join('');
  for (const m of scan.matchAll(INLINE_CODE)) {
    blank(chars, m.index!, m.index! + m[0].length);
  }

  scan = chars.join('');
  for (const m of scan.matchAll(MD_LINK)) {
    blank(chars, m.index!, m.index! + m[0].length);
  }

  return chars.join('');
}

/**
 * Extract WI-/EI-/F-/P- refs from `text` with their character positions.
 * Pure, no React, no IO. Skips refs inside a fenced code block, an inline
 * code span, or an existing markdown link; never matches mid-word. Every
 * occurrence is reported (not de-duped) — a caller splicing pills wants
 * every mention linkified, not just the first. Results are sorted by
 * `start` so a caller can walk the text once, left to right.
 */
export function parseWorkRefs(text: string): WorkRefMatch[] {
  if (!text) return [];
  const scan = maskNonProse(text);
  const out: WorkRefMatch[] = [];

  for (const m of scan.matchAll(WORK_ITEM_REF)) {
    const start = m.index!;
    out.push({
      kind: 'work-item',
      id: `${m[1].toUpperCase()}-${m[2]}`,
      start,
      end: start + m[0].length,
    });
  }
  for (const m of scan.matchAll(PLAN_ITEM_REF)) {
    const start = m.index!;
    out.push({ kind: 'plan-item', id: `P-${m[1]}`, start, end: start + m[0].length });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}
