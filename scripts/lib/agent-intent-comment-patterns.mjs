/**
 * agent-intent-comment-patterns.mjs — the detector half of
 * `lint:no-agent-intent-comments` (EI-19324979765038953).
 *
 * WHY THIS EXISTS
 * A dead sync-resolver entry (`operatorTurns.byConversation`) held the release gate
 * red for hours — 3 consecutive reds, `main` frozen for the whole fleet — behind this
 * comment:
 *
 *     // su-37bf2 is DELETING this entry under P-025 ... so that deletion,
 *     // not a declaration, is what satisfies the shrink-only ratchet here.
 *
 * That was true as an INTENT when written. It never happened: the named session
 * released the file without the delete landing and stopped responding. But the comment
 * kept asserting the present tense, so every later reader concluded the item was owned
 * and in flight. A second agent read the entry, UPDATED the comment's work-item
 * reference, and still did not delete it — because the comment said someone else had
 * it. A 2-line deletion three agents independently agreed was correct sat undone while
 * the gate stayed red.
 *
 * THE ASYMMETRY THAT MAKES THIS WORTH A GATE
 * Such a comment is strictly WORSE THAN SILENCE. Silence would have made the next
 * reader investigate; the comment actively redirected them away. A claim naming an
 * agent + a pending action has a shelf life measured in minutes on this fleet, but a
 * comment has no expiry and no liveness signal — it is the in-code analogue of the
 * checkpoint-staleness problem `checkpointStale` already solves for work-items, on a
 * surface with no such detector.
 *
 * THE RULE. A source comment may freely CITE an agent session id — 688 comment lines
 * across 390 files do, and almost all are sound history ("filed by su-x", "su-x parked
 * 2026-07-26 on a sha release:trace confirmed was stale"). What it may not do is
 * attribute a PENDING or IN-FLIGHT action to one. Record that on a work-item, which
 * has an assignee, a state, and a staleness signal.
 *
 * WHAT SEPARATES THE TWO — measured against the real corpus, not guessed:
 *
 *   • SUBJECT vs OBJECT is the cleanest discriminator. A live claim puts the id in
 *     SUBJECT position ("su-0e44e will switch the claim…", "su-1226c owns the impl").
 *     Sound history puts it after `by` ("[Registry entry added BY su-16e4c to green
 *     the capture-coverage…]") — past-tense attribution whose trailing infinitive is
 *     the PURPOSE of a completed action, not a pending one. A naive proximity matcher
 *     fires on that line; this one must not, and `no-agent-intent-comments.test.ts`
 *     pins it as a negative control.
 *
 *   • An explicit AS-OF FRAME defuses the claim, because it tells the reader the
 *     staleness is theirs to judge: "(P-201, su-164d8's lane, MID-FIX AT THE TIME THIS
 *     WAS WRITTEN) is a stable…". So does a date. Both are the shape the fix hint
 *     teaches, so both must lint clean or the rule punishes its own remedy.
 *
 * This module is the PATTERN half; scripts/check-no-agent-intent-comments.mjs is the
 * tree-walking half (enumerate, read, report) — same split as
 * scripts/lib/identity-leak-patterns.mjs, and for the same reason: an edit-time
 * advisory and a blocking gate must never disagree about what the rule is.
 *
 * NOTE: this file necessarily SPELLS the forbidden shapes in its own prose and
 * fixtures, so check-no-agent-intent-comments.mjs skips it (and the test) by path.
 */

/**
 * A papercusp agent session id: `su-` + a hex stem. Real ids run from a 5-hex short
 * form (`su-37bf2`) to a full uuid (`su-12b70e95-84ce-4ea0-b546-8a692cdc949c`).
 */
export const AGENT_ID = /\bsu-[0-9a-f]{4,}(?:-[0-9a-f]+)*\b/gi;

/**
 * Cheap whole-file pre-filter. A file with no `su-` bigram at all cannot hold this
 * class, so the line scan is skipped entirely.
 */
export const FAST_REJECT = /\bsu-[0-9a-f]{4,}/i;

/**
 * Not shipped / not source / regenerated, plus the two files that must describe the
 * forbidden shape to define and test it. Mirrors the sibling identity rules so every
 * guard agrees on what "source" means.
 */
export const SKIP = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)coverage\//,
  /(^|\/)scratchpad\//,
  /(^|\/)scratch\//,
  /(^|\/)docs\/plans\//,
  /(^|\/)internal\/docs\//,
  /\.d\.mts$/,
  /(^|\/)scripts\/lib\/agent-intent-comment-patterns\.mjs$/,
  /(^|\/)scripts\/check-no-agent-intent-comments\.mjs$/,
  /(^|\/)no-agent-intent-comments\.test\.ts$/,
];

/** True when `file` is outside the source set this rule polices. */
export function isSkippedPath(file) {
  const p = String(file).replace(/\\/g, '/');
  return SKIP.some((re) => re.test(p));
}

/**
 * Present-tense ownership / in-flight action verbs. These assert a state that is true
 * NOW — exactly the assertion a comment cannot keep making truthfully.
 */
const LIVE_VERB =
  // Present-tense ownership. Deliberately NOT `owns?` — the bare adjective in
  // "su-3a5df's OWN advice after the incident" is not a claim, and matching it made
  // the rule fire on plain history. Nor bare `is`/`has`: "su-12b70e95…" IS exactly
  // what an operator needs' is prose ABOUT an id, not a claim BY one.
  '(?:owns|holds)\\b' +
  '|(?:is|are)\\s+(?:currently\\s+|already\\s+|still\\s+)?(?:be\\s+)?' +
  '(?:deleting|removing|fixing|landing|adding|migrating|updating|handling|taking|owning' +
  '|working|rewriting|replacing|refactoring|implementing|switching|wiring|splitting' +
  '|porting|extracting|deprecating|dropping|killing|greening|finishing|cleaning)';

/**
 * Future / intended action. "will <verb>" is the shape that froze the gate: a promise
 * with no expiry, indistinguishable at read time from a promise already kept.
 */
const FUTURE_CLAIM =
  '(?:will|shall|is\\s+going\\s+to|is\\s+about\\s+to|plans?\\s+to|intends?\\s+to' +
  '|has\\s+agreed\\s+to|agreed\\s+to|is\\s+to)\\s+(?:be\\s+)?[a-z]';

/**
 * The live-claim predicate, anchored to an agent id in SUBJECT position. The id may be
 * followed by a closing paren/quote/possessive before the predicate — the corpus is
 * full of `(P-011, su-4ac61) owns …` and `su-164d8's lane` — so a short run of
 * non-word characters is allowed between the two.
 */
const LIVE_CLAIM_AFTER_ID = new RegExp(
  // The possessive is ONE unit (`['’]s`), never a stray `s` the engine can backtrack
  // into the predicate: with a loose `s?` the engine split "su-02ae39's wiring" into
  // `'` + `s wiring` and read the possessive itself as the verb.
  `(?:${AGENT_ID.source})` + `(?:['’]s)?[\\)\\]"'\\s,:;—-]{0,4}\\s*` + `(?:${FUTURE_CLAIM}|${LIVE_VERB})`,
  'i',
);

/**
 * ATTRIBUTION, not assignment: the id is the OBJECT of `by`, so the sentence is
 * history. `added by su-16e4c to green the capture-coverage` reads as a completed act
 * plus its purpose — the single most common benign shape that a proximity-only matcher
 * would wrongly flag.
 */
const BY_ATTRIBUTION = new RegExp(`\\bby\\s+(?:${AGENT_ID.source})`, 'i');

/**
 * Explicit staleness frames. Each one hands the reader the age of the claim, which is
 * the whole defect being policed — so each must lint clean. A bare ISO date counts:
 * "su-1f7ee244, 2026-08-08): a session registered in auto mode" is a dated observation,
 * not a standing promise.
 */
const AS_OF_FRAME =
  /\b(?:at\s+the\s+time(?:\s+(?:this|of)\b[^.]*)?|as\s+of\b|used\s+to\b|no\s+longer\b|USED\s+TO\s+LIVE|at\s+that\s+time|when\s+(?:this|that)\s+was\s+written|historic(?:al)?\b|formerly\b)/i;
const ISO_DATE = /\b20\d\d-\d\d-\d\d\b/;

/**
 * An ILLUSTRATION, not an assertion. A JSDoc documenting a field's format has to be
 * able to spell the format: `Human-readable signal, e.g. "su-abc12 is working
 * WI-6386"` describes a string SHAPE and names no real session. Same precedent as
 * PLACEHOLDER_NAMES in identity-leak-patterns.mjs — a rule that cannot state its own
 * subject is unusable. Narrow on purpose: the frame must be on the same line as the
 * claim, so it cannot be sprinkled at the top of a file to silence one below.
 */
const EXAMPLE_FRAME = /\b(?:e\.g\.|for\s+example|such\s+as|sample|placeholder|format:)/i;

/** A comment line, in the three syntaxes this tree uses. */
const COMMENT_LINE = /^\s*(?:\/\/+|\/\*+|\*+\/?|#+|--)\s?(.*)$/;

/**
 * The one fix text, so the gate and any edit-time advisory teach the same thing.
 */
export const FIX_HINT =
  'A comment cannot go stale, but the claim can. State the CONDITION and cite the ' +
  'work-item, not the actor: "pending removal — see WI-NNNN" instead of ' +
  '"su-XXXXX is removing this". If the note is genuinely historical, frame it that ' +
  'way ("as of 2026-08-03", "mid-fix at the time this was written") or attribute it ' +
  'in the past tense ("added by su-XXXXX to ..."), all of which lint clean.';

/**
 * Find comments that attribute a pending action to a named agent session id.
 *
 * @param {string} text file contents (or, at edit time, just the incoming edit)
 * @returns {{line:number,id:string,text:string}[]} one row per finding
 */
export function findAgentIntentComments(text) {
  if (!FAST_REJECT.test(text)) return [];
  const out = [];
  const lines = String(text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = COMMENT_LINE.exec(raw);
    if (!m) continue;
    const body = m[1];
    if (!body || !FAST_REJECT.test(body)) continue;

    // A defused claim is the shape the fix hint teaches — never flag it.
    if (AS_OF_FRAME.test(body) || ISO_DATE.test(body) || EXAMPLE_FRAME.test(body)) continue;
    // Past-tense attribution: the id is the object of `by`, not the subject.
    if (BY_ATTRIBUTION.test(body)) continue;

    if (!LIVE_CLAIM_AFTER_ID.test(body)) continue;

    const idMatch = body.match(new RegExp(AGENT_ID.source, 'i'));
    out.push({ line: i + 1, id: idMatch ? idMatch[0] : 'su-?', text: raw.trim().slice(0, 200) });
  }
  return out;
}
