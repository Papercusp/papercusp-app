/**
 * dead-end-matcher — the dead-end matcher THIN pure core for
 * ambient-semantic-push-2026-07-14 (Phase 4 P-006), built to plan D-002/D-006
 * and the D-010 lexical reframe.
 *
 * The idea: an agent (or its fleet) has recorded DEAD-END FACTS — short notes
 * about a path already tried and known to fail ("psu-launcher.mjs restart under
 * compaction wedges the advisory lock — do not retry"). When the agent's CURRENT
 * work (its lexical cursor, built from its own journal notes — the echo-guarded
 * hot loop) drifts toward one of those documented dead ends, that is exactly the
 * moment a warning is worth pushing: not a fresh opinion (no LLM, no Clippy), but
 * a legible pointer to a fact the agent — or a peer — already wrote down.
 *
 * This is the same pure-core / deferred-live-leg split the rest of the build
 * uses. What lands here (deterministic, no-LLM, no-transport):
 *   • the canonical {@link DeadEndFact} shape the not-yet-landed carry P-015
 *     dead-end store will share — DEFINED here, the same move ambient-push made
 *     defining {@link QueryHandle} before its carry P-026 slot existed;
 *   • the pure matcher: for each fact, build its cursor, score its overlap with
 *     the agent's cursor (reusing lexical-cursor's BM25-family weighted cosine),
 *     and above a warning floor emit a legible, data-not-directive dead-end push
 *     naming the shared terms as both the "why" and the re-pull query.
 *
 * DEFERRED live leg (DEFAULT-OFF, behind {@link DeadEndFactSource}): reading the
 * real dead-end facts out of the carry P-015 store (agent-authored + fleet-shared,
 * provenance-scoped per D-007/D-008) and resolving a pulled fact.ref into a brief.
 * Nothing in this pure core calls it.
 */

import {
  buildCursor,
  scoreCursorOverlap,
  type LexicalCursor,
  type CursorOverlap,
  type BuildCursorOptions,
} from './lexical-cursor';
import { makePush, type PushObject, type QueryHandle } from './ambient-push';

// ─────────────────────────────────────────────────────────────────────────────
// The dead-end fact shape (defined here; the carry P-015 store will share it)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One recorded dead end: a resolvable `ref` (the WI / doc / fact slot that holds
 * the full account) plus the short `note` whose keywords the matcher scores the
 * agent's cursor against. `kind` picks the {@link QueryHandle} kind the pull
 * resolves through — defaults to 'fact', the natural home for a dead-end record.
 * Deliberately thin: the live store (carry P-015) owns storage + resolution; the
 * matcher only needs the ref to point at and the note to match on.
 */
export interface DeadEndFact {
  /** The id / anchor to resolve on pull: a fact slot, WI-4790, a doc path, … */
  ref: string;
  /** The short account of the dead end — its keywords are the match signal. */
  note: string;
  /** Which handle kind the pull resolves through (default 'fact'). */
  kind?: QueryHandle['kind'];
}

/** One matched dead end: the push to (maybe) deliver, the fact it came from, and
 *  the overlap that fired it (so the caller keeps the legible "why"). */
export interface DeadEndMatch {
  push: PushObject;
  fact: DeadEndFact;
  overlap: CursorOverlap;
}

export interface DeadEndMatchOptions {
  /** The warning floor: a fact whose overlap with the cursor is below this never
   *  becomes a candidate. Deliberate constant (no runtime self-adaptation —
   *  carry D-001); the delivery pipeline's per-class floor (ambient-push
   *  DEFAULT_PUSH_POLICIES) applies AGAIN on top of this — this floor only bounds
   *  what the matcher proposes. */
  minScore?: number;
  /** Bound the shared-term list carried in the teaser + re-pull query. */
  maxTerms?: number;
  /** Cursor-build options for the per-fact cursors (decay/classWeights/…), so a
   *  caller can keep them consistent with how the agent cursor was built. */
  cursorOptions?: BuildCursorOptions;
  /** Optional BM25 idf (from the live inverted index) so a rare shared id
   *  outweighs a common domain term — the same rarity leg collisions use. */
  idf?: (term: string) => number;
}

/** Deliberate default warning floor. Below ambient-push's drone floor (0.4) on
 *  purpose: the matcher proposes at a modest overlap and the class policy makes
 *  the final call about whether a given weak-model session actually sees it. */
export const DEFAULT_DEAD_END_MIN_SCORE = 0.3;

/** How much of the note to fold into the teaser as context (makePush clamps the
 *  whole teaser to TEASER_MAX_CHARS regardless; this keeps the snippet legible). */
const NOTE_SNIPPET_CHARS = 90;

function noteSnippet(note: string): string {
  const collapsed = note.replace(/\s+/g, ' ').trim();
  return collapsed.length > NOTE_SNIPPET_CHARS ? collapsed.slice(0, NOTE_SNIPPET_CHARS - 1) + '…' : collapsed;
}

/**
 * Match the agent's cursor against a set of dead-end facts. For each fact: build
 * its cursor from the note, score the weighted-cosine overlap with the agent's
 * cursor, and — above the warning floor — emit a dead-end (warning severity)
 * push. The teaser is legible ("documented dead-end near your work (<ref>): …
 * shared: …") and stamped data-not-directive (a warning is data, never an owner
 * directive to the receiver — carry P-014); the handle points at fact.ref with
 * the shared terms as the exact re-pull query. Sorted strongest overlap first,
 * ties broken by ref for a deterministic order. PURE — no I/O, no LLM.
 */
export function matchDeadEnds(
  agentCursor: LexicalCursor,
  facts: DeadEndFact[],
  opts: DeadEndMatchOptions = {},
): DeadEndMatch[] {
  const minScore = opts.minScore ?? DEFAULT_DEAD_END_MIN_SCORE;
  const maxTerms = Math.max(1, opts.maxTerms ?? 5);
  const idf = opts.idf;

  const matches: DeadEndMatch[] = [];
  for (const fact of facts) {
    if (!fact || typeof fact.note !== 'string' || !fact.note.trim() || !fact.ref) continue;
    const factCursor = buildCursor([fact.note], opts.cursorOptions);
    const overlap = scoreCursorOverlap(agentCursor, factCursor, idf ? { idf } : {});
    if (overlap.score <= 0 || overlap.score < minScore) continue;

    const terms = overlap.sharedTerms.slice(0, maxTerms).map((s) => s.term);
    const push = makePush({
      matcherKind: 'dead-end',
      handle: { kind: fact.kind ?? 'fact', ref: fact.ref, query: terms },
      teaser: `documented dead-end near your work (${fact.ref}): ${noteSnippet(fact.note)} — shared: ${terms.join(', ') || '(cursor overlap)'}`,
      score: overlap.score,
    });
    matches.push({ push, fact, overlap });
  }

  matches.sort((a, b) => b.overlap.score - a.overlap.score || a.fact.ref.localeCompare(b.fact.ref));
  return matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferred live seam (DEFAULT-OFF — carry P-015 slot is live-drill-gated)
// ─────────────────────────────────────────────────────────────────────────────

/** The live leg this pure core defers to: read the real dead-end facts in scope
 *  (agent-authored + fleet-shared, provenance-scoped per D-007/D-008) and resolve
 *  a pulled fact.ref into a brief. Named so the host boundary is explicit; the
 *  matcher above never touches it, and it ships DEFAULT-OFF until the P-015 store
 *  + the acceptance drills (P-005/P-007) exist. */
export type DeadEndFactSource = {
  fetchFacts(): Promise<DeadEndFact[]>;
  resolve(ref: string): Promise<{ ref: string; brief: string } | null>;
};
