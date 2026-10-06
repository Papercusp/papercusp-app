/**
 * carry-surface-typed-slots — owner-blocking QUESTIONS must be coord:ask-owner
 * records, not carry-surface prose (deterministic-context-carry-2026-07-14
 * P-015, plan D-003 "tracking is system-owned").
 *
 * WHY: an owner-blocking question written as checkpoint/fact/carry-note prose
 * ("waiting on the owner to decide X") is a commitment that only survives as
 * long as the prose does — compaction re-summarization dissolves it, and no
 * system surface (owner inbox, walls, escalations) ever hears about it, so the
 * owner is never actually asked and a successor can't tell whether the question
 * was ever posed. The TYPED slot for this is `coord:ask-owner` — it opens a
 * durable question thread, lands in the human inbox, and returns a
 * `conversation_id`. A carry surface then CITES the record with an ask ref:
 *
 *   [ask:<conversation_id>]
 *
 * (For a standing owner-gated commitment that is not a question — "capital
 * arming is owner-walled" — the typed slot is `loop:checkpoint { walls }`,
 * which re-renders into every wake until cleared.)
 *
 * THIS module is the write-time detector: a WARN-ONLY, line-scoped lint that
 * flags owner-question-shaped prose with no [ask:…] ref on the same line. Same
 * contract as ./carry-surface-provenance-lint.ts (never block a carry write —
 * a blocked checkpoint strands more state than an untyped question), same
 * high-precision-over-recall pattern discipline (a broad match trains agents
 * to ignore the nudge). Enforcement is P-016's job.
 */

/** An ask ref citing a coord:ask-owner record (its `conversation_id`). A line
 *  carrying one has its question IN the typed slot — never flagged. */
export const ASK_REF_RE = /\[ask:[a-z0-9][a-z0-9_-]{3,63}\]/i;

/** A loop-wall row rendered back into prose carries this marker — the walls
 *  slot is ALSO typed (loop:checkpoint { walls }), so its rendering clears.
 *  NOTE: this matches a marker an AUTHOR wrote by hand. The canonical
 *  `renderWallLine` output does NOT carry it (see WALLS_HEADING_RE below). */
const WALL_MARKER_RE = /\bOWNER-WALL\b|\[wall\]/i;

/** A markdown section heading; capture group 1 is the heading text. */
const HEADING_RE = /^#{1,6}\s+(.*?)\s*$/;

/**
 * The carry-note walls section heading (`## Walls`).
 *
 * EI-21762824239199233: rows INSIDE this section are the typed form by
 * construction, so they must never be scanned. Relying on WALL_MARKER_RE alone
 * was a false-positive generator: `renderWallLine` emits
 * `- [#id] <claim> — re-check: <cmd> (since <ISO>)` and carries NEITHER
 * `OWNER-WALL` nor `[wall]`, so the marker exemption never fired for a real
 * wall. Any wall whose claim read like an owner question was flagged
 * `owner-question-prose`, and the remedy text told the author to move it to
 * `loop:checkpoint { walls }` — where it already was.
 *
 * Kept as a local pattern rather than importing CARRY_NOTE_WALLS_HEADING so
 * this module stays pure and dependency-free; `carry-surface-typed-slots.test.ts`
 * PINS it against that constant and against real `renderWallLine` output, so
 * a rename cannot silently reopen this bug.
 */
const WALLS_HEADING_RE = /^walls$/i;

/**
 * Owner-blocking-question shapes. Two families, kept deliberately narrow:
 *  - directed ask: "ask the owner", "question for the owner", "ask the human";
 *  - blocked-on-answer: "waiting on the owner", "blocked on owner input",
 *    "needs the owner's decision/approval/go".
 * Plain mentions of the owner ("the owner said X" — provenance lint's beat) or
 * of owner-walled facts with the wall marker do not match.
 */
const OWNER_QUESTION_RES: RegExp[] = [
  // `coord:ask owner-UI-only` is a tool-mode label, not prose; a word boundary
  // alone treats the hyphen before `UI` as the end of the word "owner".
  /\b(?:ask|asking|need(?:s)? to ask|should ask|must ask)\s+(?:the\s+)?(?:owner|human)\b(?!-UI-only\b)/i,
  /\bquestion\s+for\s+(?:the\s+)?(?:owner|human)\b/i,
  // A non-possessive owner is ambiguous but conventionally means the human
  // owner ("waiting on the owner to decide"). A possessive owner must name
  // the human decision being awaited; otherwise phrases such as "wait for
  // the owner's build/restart" describe a peer-owned artifact dependency.
  /\b(?:waiting|waits?|blocked|pending|holding|held)\s+(?:on|for)\s+(?:the\s+)?owner(?!'s\b)\b/i,
  /\b(?:waiting|waits?|blocked|pending|holding|held)\s+(?:on|for)\s+(?:the\s+)?owner's(?:\s+\w+){0,2}\s+(?:input|answer|decision|confirmation|approval|response|reply|ruling|go|sign-?off)\b/i,
  /\bneeds?\s+(?:the\s+)?owner(?:'s)?\s+(?:input|answer|decision|confirmation|approval|response|reply|ruling|go|sign-?off)\b/i,
  /\bowner\s+(?:to\s+)?(?:decide|confirm|answer|approve|weigh in|choose)\b/i,
];

/**
 * A negation/absence token that, appearing shortly BEFORE a trigger match
 * within the same clause, flips the trigger's polarity — "no need to ask the
 * owner", "not blocked on the owner", "blocked on nothing owner-related".
 * Kept to a nearby word-window (not the whole clause) so a negation in an
 * unrelated earlier part of the same clause can't mask a real question
 * later in it (EI-19988500685566622 case 2).
 */
const NEGATION_RE = /\b(?:no|not|n't|never|nothing|none|nobody|without)\b/i;
const NEGATION_WINDOW_CHARS = 28;
const EXPLICIT_EMPTY_STATUS_RE = /^\s*[:—–-]\s*(?:nothing|none|nobody|no one)\b/i;

/**
 * An agent identifier (su-/claude- + hex) appearing as the line's subject
 * BEFORE a trigger match means the OWNER-WAIT belongs to that named THIRD
 * PARTY, not to the writer — a grader/monitor describing a graded subject's
 * state has no question of its own to route (EI-19988500685566622 case 1).
 * Scanned over the whole clause, not just the narrow negation window, since
 * a subject can sit well before its predicate.
 */
const AGENT_SUBJECT_RE = /\b(?:su|claude)-[0-9a-f]{4,}(?:-[0-9a-f]{4,})*\b/i;

/** A peer/work-item owner appearing before a trigger belongs to another
 * agent's lane, not to the human owner. This covers the compact coordination
 * phrasing used in carry notes, e.g. "WI-40086 peer owner to confirm the exact
 * event emitter" (EI-21392657495371064). */
const PEER_OWNER_SUBJECT_RE = /\b(?:peer|item|work[-\s]?item)\s+owner\b/i;

/**
 * A `dev:why` diagnostic can quote the peer-owned repair wait verbatim in a
 * carry note. The command marker, opening/closing quote, repair status, and
 * both peer-coordination clauses are required together so this exemption
 * cannot launder an ordinary owner wait (EI-22175896286054778).
 */
const DEV_WHY_PEER_REPAIR_NEXT_VERB_QUOTE_RE =
  /^`?dev:why`?\s+nextVerb\s+[—:-]\s*["“]wait\s+for\s+the\s+owner\s+of\s+the\s+in-flight\s+repair\s+to\s+finish\s+\(repair-in-progress\)\s+—\s+there\s+is\s+nothing\s+for\s+you\s+to\s+clear\b[^"”\n]*\band\s+a\s+re-fire\s+contends\s+with\s+them\b[^"”\n]*["”]`?$/i;

/** Clause delimiters bounding how far back a suppression check looks — a
 *  negation or subject in an earlier, unrelated clause must not mask a real
 *  question in a later one on the same line. */
const CLAUSE_DELIMITERS = ['.', ':', ';'];

function clauseStartBefore(line: string, index: number): number {
  let start = 0;
  for (const d of CLAUSE_DELIMITERS) {
    const at = line.lastIndexOf(d, index - 1);
    if (at + 1 > start) start = at + 1;
  }
  return start;
}

/** True when a trigger match at `matchIndex` on `line` should be suppressed —
 *  negated, or the grammatical subject is a named other agent — and so is
 *  not the writer's own unrouted question. */
function isSuppressedMatch(line: string, match: RegExpExecArray): boolean {
  const matchIndex = match.index;
  const afterMatch = line.slice(matchIndex + match[0].length);
  if (EXPLICIT_EMPTY_STATUS_RE.test(afterMatch)) return true;
  const clauseStart = clauseStartBefore(line, matchIndex);
  const clauseBefore = line.slice(clauseStart, matchIndex);
  // Include the matched phrase: the `owner` in "peer owner to confirm" is
  // itself the start of the trigger match, so looking only before matchIndex
  // would miss the peer-owner subject.
  const clauseThroughMatch = line.slice(clauseStart, matchIndex + match[0].length);
  if (AGENT_SUBJECT_RE.test(clauseBefore) || PEER_OWNER_SUBJECT_RE.test(clauseThroughMatch)) return true;
  const negationWindowStart = Math.max(clauseStart, matchIndex - NEGATION_WINDOW_CHARS);
  const negationWindow = line.slice(negationWindowStart, matchIndex);
  if (NEGATION_RE.test(negationWindow)) return true;
  return false;
}

export interface TypedSlotLintMatch {
  /** The offending line, trimmed and capped for display. */
  line: string;
  kind: 'owner-question-prose';
}

export interface TypedSlotLintResult {
  flagged: boolean;
  matches: TypedSlotLintMatch[];
}

const MAX_MATCH_LINES = 5;
const MATCH_LINE_CAP = 200;

/**
 * Scan `text` line-by-line for owner-blocking-question prose with no [ask:…]
 * ref (and no wall marker) on that same line. Line-scoped for the same reason
 * the provenance lint is: an ask ref elsewhere in a long checkpoint must not
 * mask a different, never-asked question. Pure, synchronous, side-effect-free.
 *
 * A trigger match is further suppressed when it is NEGATED ("no need to ask
 * the owner") or its clause's subject is a named OTHER AGENT ("subject
 * su-6e9985dd... was waiting on the owner") — neither is the writer's own
 * unrouted question (EI-19988500685566622).
 */
export function lintOwnerQuestionSlots(text: string | null | undefined): TypedSlotLintResult {
  if (!text) return { flagged: false, matches: [] };
  const matches: TypedSlotLintMatch[] = [];
  let inWallsSection = false;
  for (const rawLine of text.split('\n')) {
    if (matches.length >= MAX_MATCH_LINES) break;
    const line = rawLine.trim();
    if (!line) continue;
    // Section tracking runs BEFORE the per-line exemptions: a heading both
    // enters and LEAVES the walls section, so an owner question in a later
    // section is still flagged (the walls slot must not blanket the rest).
    const heading = HEADING_RE.exec(line);
    if (heading) {
      inWallsSection = WALLS_HEADING_RE.test(heading[1] ?? '');
      continue;
    }
    if (inWallsSection) continue; // EI-21762824239199233: walls rows ARE the typed form
    if (ASK_REF_RE.test(line)) continue; // the question IS a typed record
    if (WALL_MARKER_RE.test(line)) continue; // the walls slot is the typed form
    if (DEV_WHY_PEER_REPAIR_NEXT_VERB_QUOTE_RE.test(line)) continue; // quoted peer-owned diagnostic, not a human ask
    const hasUnsuppressedMatch = OWNER_QUESTION_RES.some((re) => {
      const m = re.exec(line); // none of these patterns carry the /g flag, so exec is stateless here
      if (!m) return false;
      return !isSuppressedMatch(line, m);
    });
    if (hasUnsuppressedMatch) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'owner-question-prose' });
    }
  }
  return { flagged: matches.length > 0, matches };
}

/** The advisory note a consumer folds into its response when flagged. */
export const OWNER_QUESTION_SLOT_NOTE =
  'typed_slot: owner-blocking question written as carry-surface prose. Prose dissolves under compaction and ' +
  'never reaches the owner — open it as a typed record instead: coord:ask-owner { question } (opens a question ' +
  'thread + lands in the human inbox, returns conversation_id), then cite it here as [ask:<conversation_id>]. ' +
  'A standing owner-gated commitment that is not a question belongs in loop:checkpoint { walls } (re-rendered ' +
  'into every wake until cleared). deterministic-context-carry P-015.';

/** Convenience: the `{ flagged, note, matches }` response field — undefined on
 *  the clean case, mirroring provenanceLintField's contract. */
export function ownerQuestionSlotField(text: string | null | undefined):
  | { flagged: true; note: string; matches: TypedSlotLintMatch[] }
  | undefined {
  const result = lintOwnerQuestionSlots(text);
  if (!result.flagged) return undefined;
  return { flagged: true, note: OWNER_QUESTION_SLOT_NOTE, matches: result.matches };
}
