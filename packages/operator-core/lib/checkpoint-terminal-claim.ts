/**
 * checkpoint-terminal-claim — does a checkpoint's own text DECLARE that its author
 * believed they reached a terminal (passed/deprecated/resolved/closed/done/complete)
 * or a deliberate blocked/needs-human state?
 *
 * Extracted from `pot/placement-watchdog.ts` (WI-38297) so a SECOND reader — the
 * stranded-checkpoint triage scan — can address the same predicate without importing
 * the watchdog's whole module graph (DB seams, placement ranker, pot config) into the
 * agent-tool registration path. `placement-watchdog.ts` re-exports it, so its own
 * tests and call sites are unchanged and there is still exactly ONE definition of what
 * "the checkpoint declares terminal" means. Sibling of {@link ./checkpoint-bg-job-claim}
 * — same warn-only, pure, text-only posture, opposite precision/recall trade (see below).
 *
 * ⚠ MEASURED PRECISION ~43%, and that number is the whole reason the triage surface is
 * READ-ONLY (measured 2026-08-12 by hand-reading EVERY match over the live backlog —
 * 23 matches, ~10 genuinely finished). Two classifiers were rejected on the same
 * evidence and must not be reintroduced as "improvements":
 *   · "the checkpoint asserts completion" (IMPLEMENTED/FIXED/passed/…) matched 349 of
 *     449 checkpoints — 78% of the population, i.e. a non-discriminator, not a signal.
 *   · anything reading the checkpoint's TAIL: checkpoints carry an auto-appended
 *     `tool-log tail:` section listing tool NAMES (`work_items_complete`,
 *     `work_items_release`, …), so 6 of 15 tail matches were pure tool-log noise.
 *     These markers dodge that ONLY because the assertive ones anchor to `^`.
 * At 43%, a majority of matches are still real matches — but a MINORITY being wrong is
 * fatal to an auto-closer and merely a cost to a human/agent triage queue. Observed
 * false positives are emphatic in the opposite direction ("⛔ DO NOT CLOSE…", "CLAIMED,
 * no code written yet"), which is exactly why the scan returns the note HEAD for a
 * reader to judge rather than a verdict to act on.
 *
 * ✅ PRECISION FIX 2026-08-12 — the bare adverb `now` was removed from the assertive-
 * transition alternation for the five ambiguous tokens. Measured over the full live
 * population (497 open checkpointed rows): 8 matches fired on `now` ALONE, and hand-
 * reading all 8 found ZERO true positives. See the marker's own comment for the verbatim
 * evidence. This NARROWS the classifier and is the opposite direction from the two
 * rejected "improvements" above — those widened it. The lesson generalizes: a marker
 * must be PERFORMATIVE (the author declaring they performed a transition), because a
 * NARRATIVE sentence's subject is usually some other item, check, question or risk —
 * the same "done, but of WHAT?" error the triage reader has to make by hand.
 */

/**
 * EI-15232 — high-precision markers that a cup's own checkpoint DECLARES it believed
 * it reached a terminal (passed/deprecated/resolved/closed/done/complete) or a
 * deliberate blocked/needs-human state. Used to detect a STALE-OPEN unit: the cup
 * asserts terminal/blocked in its checkpoint, but the unit's `set_state` flip
 * silently failed to persist, so the row still reads `todo`. Concrete (2026-07-17):
 * WI-3503 "STATE: Terminal (passed) … checkpoint cleared" and WI-3504 "transition to
 * BLOCKED" — both left state=todo.
 *
 * Deliberately CONSERVATIVE: a FALSE positive would suppress a legitimate re-place
 * page for an item that still needs work (the worse error), so the scan requires an
 * explicit state ASSERTION, not a passing mention of the word. A false negative just
 * preserves today's behavior (the page still fires) — never worse than the status quo.
 */
const CHECKPOINT_TERMINAL_MARKERS: ReadonlyArray<RegExp> = [
  // "STATE: Terminal", "state = terminal"
  /\bstate\s*[:=]\s*terminal\b/i,
  // "Terminal (passed)", "Terminal (blocked)", …
  /\bterminal\s*\(\s*(?:passed|blocked|deprecated|resolved|closed|done|needs-human)/i,
  // an assertive transition to a terminal/park state: "transition(ed) to BLOCKED",
  // "flipped to passed", "moved to resolved", "set state to closed", "marked deprecated",
  // "status: passed".
  //
  // ⚠ THESE VERBS ARE ALL *PERFORMATIVE* — the author declaring they PERFORMED a
  // transition. The bare adverb "now" was deliberately REMOVED from this alternation
  // (see the `now` marker below) because it is *narrative*, and a narrative sentence's
  // subject is usually NOT this item.
  /\b(?:transition(?:ed|ing)?|flipp?ed|moved|set(?:\s+state)?|marked|status\s*[:=])\s+(?:to\s+|as\s+)?(?:passed|deprecated|resolved|closed|blocked|needs-human|done)\b/i,
  // "now needs-human" / "now deprecated" — the NARRATIVE form, admitted ONLY for state
  // tokens that are not also ordinary technical adjectives.
  //
  // MEASURED 2026-08-12 over the full live population (497 open checkpointed rows): the
  // bare `now` alternative was carried in the marker above against ALL SEVEN terminal
  // tokens, and it produced 8 matches that fired on `now` ALONE (no performative verb
  // anywhere in the note). Every one of the 8 was hand-read, and ALL EIGHT were false
  // positives — a 0% hit rate — because "now <word>" states that something reached that
  // condition WITHOUT naming this item as the subject:
  //   · "peer su-02434, WI-4427, now RESOLVED"       → a DIFFERENT work-item
  //   · "the 57-drop is MY reader fix (WI-3356, now done)" → a SIBLING item
  //   · "Its one outstanding check is now CLOSED"    → a CHECK
  //   · "its bound workItem EI-19480850505352533 is now DONE" → a different item; the
  //      same note says verbatim "This item (WI-37504) stays OPEN"
  //   · "central open question is now CLOSED"        → a QUESTION
  //   · "RISK I FLAGGED AS UNVERIFIED IS NOW RESOLVED" → a RISK
  //   · "That mismatch is now resolved"              → a MISMATCH
  //   · "Now resolved per tick via getLongLivedAdminPool(…)" → WORD SENSE: URL
  //      resolution, nothing to do with the `resolved` work-item state at all.
  // That last one shows the second, independent failure: `resolved`/`closed`/`blocked`/
  // `done` are among the most common adjectives in this codebase's prose (a closed
  // handle, a blocked socket, a resolved specifier), so pairing them with a narrative
  // adverb matches ordinary engineering English.
  //
  // `needs-human` and `deprecated` do not have that problem — they are item-state
  // vocabulary, not English — so the narrative form is kept for exactly those two and
  // the tested `'now needs-human'` case still matches. Dropping the other five costs no
  // measured recall (zero of the 8 was a true positive) and removes 8 of the 18 matches
  // this marker family produced, i.e. the single largest false-positive source in the
  // classifier. Re-widening this to the common adjectives reintroduces all 8.
  /\bnow\s+(?:to\s+|as\s+)?(?:needs-human|deprecated)\b/i,
  // an explicit "✅ COMPLETE" / "✅ DONE" completion header the cup writes on finish
  /✅\s*(?:complete(?:d)?|done|passed)\b/i,
  // EI-18712524449804476 — a checkpoint that OPENS with an assertive all-caps terminal
  // marker word, the convention this codebase's own agents actually write in practice
  // ("TERMINAL — WI-4446 COMPLETE + VERIFIED, state=passed. Do NOT restart.",
  // "SUPERSEDED by owner decision"). Anchored to the START of the checkpoint (never a
  // passing mid-text mention) to keep the same conservative, false-positive-averse
  // posture as the markers above.
  /^\s*(?:TERMINAL|SUPERSEDED|OBSOLETE|VOID|DUPLICATE)\b/,
  // EI-18712524449804476 — a checkpoint that OPENS with the item's own id followed
  // directly by a terminal verb ("WI-4480 PASSED 2026-07-17 15:12Z (terminalOwner …)").
  // Anchored to the start for the same reason as above.
  /^\s*(?:WI|EI|F)-\d+\s+(?:PASSED|COMPLETE(?:D)?|DONE|RESOLVED|CLOSED|DEPRECATED|SUPERSEDED)\b/,
];

/** EI-15232 — does the cup's checkpoint text DECLARE a terminal/blocked completion?
 *  Pure; exported for the decider unit tests. */
export function checkpointDeclaresTerminal(checkpoint: string | null | undefined): boolean {
  if (!checkpoint) return false;
  return CHECKPOINT_TERMINAL_MARKERS.some((re) => re.test(checkpoint));
}
