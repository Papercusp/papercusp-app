/**
 * compile-brief.ts — compile a self-contained work-item brief from a plan item +
 * its plan context (plan-implementation-framework-2026-06-15 P-003, "compiled
 * briefs"; flag `papercusp-compiled-briefs`).
 *
 * A work-item brief is the situational context the placed bee is MISSING —
 * historically a hand-authored per-lane overlay (queen-wave-dispatch P-021).
 * Compiled briefs derive it deterministically at convert-time from what the plan
 * already encodes: the plan's current focus (`## Now`) and the decisions bearing
 * on the item (its `decisionRefs`). Pure + bounded; the flag read + the wiring
 * into the mint live in ./convert.ts.
 *
 * Rule: only produce a brief when there is genuine ENRICHMENT beyond the item
 * text (plan focus and/or bearing decisions). The item text alone is already the
 * work_item's summary, so a brief that only restated it would add nothing.
 */

export interface CompileBriefDecision {
  id: string;
  title: string;
  body: string;
}

export interface CompileBriefInput {
  itemId: string;
  itemText: string;
  planTitle?: string | null;
  /** The plan's `## Now` block: the current focus the bee should align to. */
  planFocus?: { state?: string | null; next?: string | null } | null;
  /** Decisions bearing on this item (resolved from its decisionRefs). */
  decisions?: CompileBriefDecision[];
  /** Hard cap on the result (the payload.brief column tolerates ~2000). */
  maxChars?: number;
}

const DEFAULT_MAX = 2000;

/** Collapse whitespace + trim, then clip to `max` with a trailing ellipsis. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (max <= 1) return t.length ? '…' : '';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Resolve the decisions a parsed item references, in ref order, deduped. Pure +
 * tolerant of a partial/mocked parse (missing arrays → empty). A ref with no
 * matching decision is skipped.
 */
export function decisionsForItem(
  parsed:
    | {
        items?: Array<{ id: string; decisionRefs?: string[] }>;
        decisions?: Array<{ id: string; title: string; body: string }>;
      }
    | null
    | undefined,
  itemId: string,
): CompileBriefDecision[] {
  const item = (parsed?.items ?? []).find((i) => i.id === itemId);
  const refs = item?.decisionRefs ?? [];
  if (refs.length === 0) return [];
  const byId = new Map((parsed?.decisions ?? []).map((d) => [d.id, d]));
  const out: CompileBriefDecision[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (seen.has(r) || !byId.has(r)) continue;
    seen.add(r);
    const d = byId.get(r)!;
    out.push({ id: d.id, title: d.title, body: d.body });
  }
  return out;
}

/**
 * Compile a self-contained brief, or '' when there is no enrichment to add.
 * Deterministic; bounded to `maxChars` (the decisions block is budgeted to ~half
 * the cap so the task + focus survive, then the whole result is clipped as a
 * backstop).
 */
export function compilePlanItemBrief(input: CompileBriefInput): string {
  const max = input.maxChars ?? DEFAULT_MAX;
  const decisions = input.decisions ?? [];
  const focusState = input.planFocus?.state?.trim() ?? '';
  const focusNext = input.planFocus?.next?.trim() ?? '';
  const hasEnrichment = decisions.length > 0 || focusState !== '' || focusNext !== '';
  if (!hasEnrichment) return '';

  const sections: string[] = [];

  // Restate the task so the brief is self-contained as a prompt overlay.
  const itemText = (input.itemText ?? '').trim();
  const head = `## Task — ${input.itemId}${input.planTitle ? ` · ${clip(input.planTitle, 80)}` : ''}`;
  sections.push(itemText ? `${head}\n${itemText}` : head);

  if (focusState || focusNext) {
    const lines = ['## Plan focus'];
    if (focusState) lines.push(clip(focusState, 400));
    if (focusNext) lines.push(`Next: ${clip(focusNext, 200)}`);
    sections.push(lines.join('\n'));
  }

  if (decisions.length > 0) {
    const perDecision = Math.max(120, Math.floor(max / 2 / decisions.length));
    const rendered = decisions.map(
      (d) => `- ${d.id} — ${clip(d.title, 100)}: ${clip(d.body, perDecision)}`,
    );
    sections.push(['## Decisions bearing on this item', ...rendered].join('\n'));
  }

  const full = sections.join('\n\n');
  return full.length <= max ? full : `${full.slice(0, max - 1)}…`;
}
