/**
 * insight-docs-matcher — matcher 4 (insights / runbook suggestions) for
 * ambient-semantic-push-2026-07-14 (Phase 5 P-010), built to plan D-002/D-006 +
 * the D-010 lexical reframe.
 *
 * The LAST and most Clippy-prone matcher: when the agent's cursor overlaps an
 * agent-insights / runbook doc, push the doc's teaser + handle so the agent can
 * pull the runbook BEFORE re-deriving a known procedure. Everything about its
 * defaults is therefore the most conservative in the family:
 *   • matcherKind 'insight' ⇒ severity 'info' — DRONE-INVISIBLE by the D-004
 *     policy table (a weak model never sees a doc suggestion at all);
 *   • the highest default floor of any matcher (0.35) + the tightest default
 *     volume cap (3) — it proposes sparingly, the per-class policy disposes;
 *   • the P-010 SHIPPING GATE is not this module's to waive: it ships only
 *     after matchers 1–3 demonstrate utilization above the eviction bar
 *     (P-005/P-007/P-009 + the P-011 ledger). This pure core existing does NOT
 *     enable it — the live leg stays DEFAULT-OFF behind {@link InsightDocSource}.
 *
 * Same shape as dead-end-matcher: consume ALREADY-FETCHED doc digests, score
 * cursor↔doc lexical overlap, emit teaser-not-content pushes. PURE, no-LLM.
 */

import {
  buildCursor,
  scoreCursorOverlap,
  type LexicalCursor,
  type CursorOverlap,
  type BuildCursorOptions,
} from './lexical-cursor';
import { makePush, type PushObject } from './ambient-push';

/** An already-fetched insight/runbook doc DIGEST — never the full body. The
 *  matchable text is the title + tags + a bounded excerpt; the handle resolves
 *  the rest on pull (teaser-not-content, D-002). */
export interface InsightDoc {
  /** The doc path / slug the handle resolves: agent-insights/known-benign-transients….mdx */
  ref: string;
  /** The digest to match on: title + tags + a bounded excerpt. */
  text: string;
}

export interface InsightMatch {
  push: PushObject;
  doc: InsightDoc;
  overlap: CursorOverlap;
}

export interface InsightMatchOptions {
  /** Floor for a doc suggestion (default {@link DEFAULT_INSIGHT_MIN_SCORE}). */
  minScore?: number;
  /** Cap the suggestions per round (default {@link DEFAULT_INSIGHT_MAX_DOCS}). */
  maxDocs?: number;
  /** Shared terms surfaced in the handle query / teaser. */
  maxTerms?: number;
  cursorOptions?: BuildCursorOptions;
  idf?: (term: string) => number;
}

/** The most conservative floor in the matcher family — matcher 4 is the most
 *  Clippy-prone, so it proposes sparingly (policy still disposes per class). */
export const DEFAULT_INSIGHT_MIN_SCORE = 0.35;
/** Tightest default volume cap in the family, same reasoning. */
export const DEFAULT_INSIGHT_MAX_DOCS = 3;

/**
 * Match the agent's cursor against already-fetched insight-doc digests. Returns
 * the matches above the floor, strongest first (ref tie-break), capped — each
 * carrying an 'insight'-kind push (info severity: drone-invisible by policy).
 * PURE.
 */
export function matchInsightDocs(
  agentCursor: LexicalCursor,
  docs: InsightDoc[],
  opts: InsightMatchOptions = {},
): InsightMatch[] {
  const minScore = opts.minScore ?? DEFAULT_INSIGHT_MIN_SCORE;
  const maxDocs = Math.max(0, opts.maxDocs ?? DEFAULT_INSIGHT_MAX_DOCS);
  const maxTerms = Math.max(1, opts.maxTerms ?? 5);
  const overlapOpts = opts.idf ? { idf: opts.idf } : {};

  const out: InsightMatch[] = [];
  for (const doc of docs) {
    if (!doc || !doc.ref || typeof doc.text !== 'string' || !doc.text.trim()) continue;
    const overlap = scoreCursorOverlap(agentCursor, buildCursor([doc.text], opts.cursorOptions), overlapOpts);
    if (overlap.score <= 0 || overlap.score < minScore) continue;
    const terms = overlap.sharedTerms.slice(0, maxTerms).map((t) => t.term);
    out.push({
      doc,
      overlap,
      push: makePush({
        matcherKind: 'insight',
        handle: { kind: 'doc', ref: doc.ref, query: terms },
        teaser: `runbook near your work (${doc.ref}) — shared: ${terms.join(', ')}`,
        score: overlap.score,
      }),
    });
  }
  out.sort((a, b) => b.overlap.score - a.overlap.score || a.doc.ref.localeCompare(b.doc.ref));
  return out.slice(0, maxDocs);
}

/** The DEFERRED live seam (DEFAULT-OFF): fetch the real doc digests (docs:search
 *  over agent-insights/) and deliver the suggestions. Gated HARDER than its
 *  siblings — P-010 ships only after matchers 1–3 demonstrate utilization above
 *  the eviction bar (P-005/P-007/P-009 + P-011). Nothing here calls it. */
export type InsightDocSource = {
  fetchDocs(): Promise<InsightDoc[]>;
  deliver(push: PushObject): Promise<void>;
};
