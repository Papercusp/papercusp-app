/**
 * EI-19395730805289668 — detect an OWNER-ATTRIBUTED PAUSE DECLARED IN CARRY-NOTE PROSE.
 *
 * ## Why this exists
 *
 * An agent that pauses work at the owner's request writes it into its checkpoint:
 *
 *     P-001 (real gym corpus) — PAUSED at owner request [owner 2026-08-02 "..."]
 *
 * Nothing parses that. The item stays `state:'open'` with no `payload._claimHold`, so it is
 * claimable by every floor the claim path applies, and `scheduler:get_next` hands it straight
 * back out — as it did on 2026-08-03T02:05Z, which is what prompted the filing.
 *
 * ## What this is NOT — the fix is deliberately at the WRITE side, not the claim path
 *
 * The obvious reading of that incident ("teach the scheduler to read the pause") is wrong, and
 * the measurement says so in BOTH directions:
 *
 *  1. **Frequency.** Four owner-pause declarations exist in this workspace's entire carry-note
 *     history. A prose parser on the claim hot path — run on every claim, forever — is not a
 *     proportionate answer to four events in three weeks.
 *  2. **Obeying that prose would have been WRONG.** Of those four, two (WI-3923 2026-07-11,
 *     WI-5381 2026-07-18) were still `open` with no hold weeks later — because both quoted
 *     SITUATIONAL directives ("conserve tokens", "get to a stopping point then pause") that had
 *     long since expired. A scheduler that honoured prose would have fenced both indefinitely,
 *     turning a spent instruction into a permanent gate. That is the directive-provenance rot
 *     the compaction rules warn about, mechanised.
 *
 * So the defect is not that the claim path cannot read prose. It is that a prose pause has
 * **no state and no expiry**, which makes it simultaneously unenforceable by the scheduler and
 * indefinitely misleading to whoever reads it next. The durable mechanism already exists and is
 * already enforced for both families (`payload._claimHold`, via `claimFloorsWhereSql` /
 * `claimHoldExclusionSql`) — the gap is that writing the prose never prompts anyone to use it.
 * The moment to catch that is when the prose is WRITTEN, while its author still knows whether
 * the pause is meant to outlive their turn.
 *
 * ## Precision: why this is a narrow whitelist and not a `/paus/i` match
 *
 * Calibrated against the real corpus, not invented cases. A random 40-line sample of carry-note
 * lines containing "paus" was inspected; **every one of the first eight was a false positive**
 * for a naive matcher — DB column names in evidence blocks (`loop_paused_reason`), code
 * identifiers (`pauseNewWork`, `reconcilePausedQueen()`, `newWorkPaused`), telemetry
 * (`governor.anyPaused=false`), categories (`owner-paused rows`, `token-paused observation`),
 * narrative (`post pause/resume cycle`, `born paused`), and pauses belonging to OTHER items
 * (`Do not touch p2p-ship/WI-3500/P-306 (paused)`). Dense engineering prose says "paused"
 * constantly and almost never to declare THIS item's state.
 *
 * Hence: an all-caps standalone `PAUSED` token (the convention all four true positives use)
 * PLUS an owner-attribution clause on the same line. Ambiguity resolves to SILENT, because this
 * is a warn-only nudge — a miss costs one un-nudged write, a false fire costs the author's
 * attention on every checkpoint they make.
 */

/** A pause this item's checkpoint declares in prose. */
export interface CarryNotePauseDeclaration {
  /** The matched line, trimmed and bounded — quoted back so the author sees what fired. */
  quote: string;
  /** 1-based line number within the note, for a long multi-section checkpoint. */
  line: number;
}

/** Bound on the quoted line, so a pathological single-line note can't blow up a tool result. */
const MAX_QUOTE_CHARS = 160;

/**
 * A standalone, all-caps PAUSED. Case-SENSITIVE and word-bounded on purpose: it must not match
 * inside an identifier (`reconcilePausedQueen`, `loop_paused_reason`, `pauseNewWork`) nor the
 * lowercase narrative use, which together are the entire measured false-positive population.
 */
const PAUSED_TOKEN = /\bPAUSED\b/;

/**
 * The attribution clause that separates "this item is paused, by the owner" from every other
 * sentence containing the word. Either an explicit `[owner:...]` provenance tag (the convention
 * the compaction rules prescribe), or `owner` co-occurring with `request`/`directive`.
 *
 * Deliberately NOT extended to self-imposed pauses: all four measured true positives are
 * owner-attributed, and widening a detector past its evidence is how it starts firing on prose
 * it was never calibrated against. See the KNOWN LIMIT test.
 */
const OWNER_TAG = /\[owner:/i;
const OWNER_ATTRIBUTION = /\bowner\b/i;
const DIRECTIVE_NOUN = /\b(request|directive)\b/i;
const PAUSE_OR_HOLD = /\b(?:pause|hold)\b/i;
const CLEARANCE_MARKER = /\b(?:cleared|lifted|released|retired|supersed(?:ed|ing|es))\b/i;
const NEGATED_CLEARANCE =
  /\b(?:not|never|isn't|isnt|wasn't|wasnt|hasn't|hasnt)\s+(?:be\s+)?(?:cleared|lifted|released|retired|supersed(?:ed|ing|es))\b/i;

function declaresOwnerPause(line: string): boolean {
  if (!PAUSED_TOKEN.test(line)) return false;
  if (OWNER_TAG.test(line)) return true;
  return OWNER_ATTRIBUTION.test(line) && DIRECTIVE_NOUN.test(line);
}

/**
 * Whether this line explicitly retires a pause/hold mentioned in the same line.
 *
 * Checkpoint bodies are append-history, so a later `RESUMED ... pause hold cleared`
 * paragraph must cancel an earlier declaration. Keep this line-local and require a
 * positive clearance marker: `the pause was not cleared` is evidence that the pause
 * remains active, not a cancellation.
 */
function clearsPause(line: string): boolean {
  return PAUSE_OR_HOLD.test(line) && CLEARANCE_MARKER.test(line) && !NEGATED_CLEARANCE.test(line);
}

/**
 * The latest still-active owner-attributed pause declaration in `text`, or null.
 *
 * Checkpoints preserve append-history. A later explicit clearance/resumption retires an
 * earlier declaration, while a later declaration becomes the active one. This feeds a one-line
 * nudge, so only the final still-active declaration is returned.
 */
export function detectPauseDeclaration(
  text: string | null | undefined,
): CarryNotePauseDeclaration | null {
  if (!text) return null;
  const lines = text.split('\n');
  let active: CarryNotePauseDeclaration | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (clearsPause(raw)) {
      active = null;
      continue;
    }
    if (declaresOwnerPause(raw)) {
      const trimmed = raw.trim();
      active = {
        quote: trimmed.length > MAX_QUOTE_CHARS ? `${trimmed.slice(0, MAX_QUOTE_CHARS)}…` : trimmed,
        line: i + 1,
      };
    }
  }
  return active;
}

/**
 * The nudge shown when a checkpoint declares an owner pause on an item carrying no claim hold.
 *
 * States BOTH failure directions, because the author's correct action depends on which one they
 * are in and the second is the counter-intuitive one: a pause that should outlive the turn needs
 * a hold, and a pause that should NOT needs an expiry — otherwise it misleads every later reader
 * indefinitely, which is exactly how two items sat "paused" for weeks on spent instructions.
 */
export function pauseNotEnforcedWarning(d: CarryNotePauseDeclaration): string {
  return (
    `This checkpoint DECLARES an owner pause (line ${d.line}: "${d.quote}") but the item carries no ` +
    `claim hold — the pause exists only as prose, which the claim path cannot read, so ` +
    `scheduler:get_next will keep serving this item. Pick one: (a) the pause should OUTLIVE your ` +
    `turn → work_items:hold_open (a real, enforced floor for both families); or (b) it is ` +
    `SITUATIONAL (a token-conservation window, "stop at a good point") → say so IN the note with an ` +
    `expiry, because an unexpired prose pause stays misleading forever — measured, two items sat ` +
    `open-and-"paused" for weeks on directives that had expired. Warn-only (EI-19395730805289668).`
  );
}
