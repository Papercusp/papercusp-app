/**
 * The recall query's HUMAN TAIL — context-injection-audit-2026-07-28, P-006 / D-046.
 *
 * P-006 was owner-gated from 2026-07-28 until 2026-08-02, when the owner chose,
 * from four presented options: **"last 3 HUMAN turns only."** This module is
 * that shape and no other. The push-path recall query stops being
 * `prompt.slice(0, CLAMP)` and becomes the prompt PLUS the last 3 turns the
 * human actually spoke — assistant turns and machine-injected turns are
 * excluded structurally, not down-weighted.
 *
 * ⚠ THE NAIVE IMPLEMENTATION INVERTS THE OWNER'S INTENT — read this before
 * changing anything here. In `harness_shared.session_turns`, `speaker = 'user'`
 * covers BOTH owner-typed turns AND every machine wake: a loop fire, a wake
 * pump, a self-compaction carry, a fleet kickoff all arrive as `'user'`.
 * Measured on one loop-driven session's last 8 `'user'` rows: 5 real turns of
 * 22–71 chars, plus 3 cold-wake notes of exactly 8,000 chars each. "Last 3 user
 * turns" there is ~24,000 chars of wake chrome clamped to 1,000 — a query that
 * is 100% machine text, i.e. STRICTLY WORSE than the prompt-only query it
 * replaces, and it drives D-033's measured defect (74.4% of turn-start queries
 * machine-injected) toward 100%. So: **filter on PROVENANCE, never on
 * `speaker`.**
 *
 * Three defences, in order, because no single one is sufficient:
 *
 *  1. **Envelope provenance (primary).** Every papercusp injector stamps
 *     `⟦turn-origin:<origin> nonce:…⟧` at the head of the turn it injects, so a
 *     parsed envelope is positive proof of machine origin. Measured over 3 days
 *     of live `'user'` rows: 60.2% carry one (loop-fire 413, wake-pump 108,
 *     self-compaction 63, fleet-kickoff 59) and are dropped here.
 *  2. **Known unenveloped machine heads.** The envelope test is necessary but
 *     NOT sufficient, and treating it as sufficient DID ship a bug that the live
 *     acceptance caught: of the 430 unenveloped rows in the same window, 167
 *     (38.8%) are CLI/hook/watchdog injections — `<task-notification>` blocks,
 *     interrupt markers, Stop-hook feedback, skill bodies. See
 *     `UNENVELOPED_MACHINE_HEADS`.
 *  3. **A per-entry cap (the one that does not depend on classifying correctly).**
 *     This is the load-bearing defence, and it is the reason (2) is allowed to be
 *     an incomplete heuristic list. Whatever the catalogue misses contributes at
 *     most `HUMAN_TAIL_ENTRY_CHARS`, so a misclassification is bounded (one
 *     capped slot wasted) rather than catastrophic (the query becomes 8,000
 *     chars of boilerplate). Never remove the cap on the grounds that the
 *     filters look good; the filters are heuristics, the cap is arithmetic.
 *
 * The current prompt is composed FIRST and is never displaced (see
 * `composeRecallQuery`). That is what rules out the "char budget over a mixed
 * tail" option the owner rejected: there, a long turn evicts the human's words
 * by being long. Here it cannot.
 */
import { isUnenrolledMachineSurface } from '../turn-provenance/machine-surface-catalogue';
import { parseEnvelope, stripInjectedChrome } from '../turn-provenance/turn-provenance';

/** D-046, literally: "the last 3 HUMAN turns". */
export const HUMAN_TAIL_TURNS = 3;

/**
 * Max chars contributed by ONE tail turn. Bounds the blast radius of a
 * misclassified machine turn AND of a human who pasted a document — defence (3)
 * above. 400 × 3 = 1,200, so the tail alone can never fill the 1,000-char query
 * clamp; the prompt is always composed first regardless.
 */
export const HUMAN_TAIL_ENTRY_CHARS = 400;

/**
 * How many `speaker='user'` rows to scan back to find `HUMAN_TAIL_TURNS` human
 * ones. Machine turns dominate a loop-driven session (60.2% fleet-wide), so the
 * scan must be several times the target. A session whose last 40 `'user'` rows
 * are all machine has no human tail to recover, and correctly gets none.
 */
const TAIL_SCAN_ROWS = 40;

/**
 * Staleness guard, NOT part of D-046's shape: a human turn from days ago is
 * about different work, and injecting it would resurrect stale intent into
 * today's query. D-046 specifies the COUNT, not a window; this bounds the count
 * to one working span and is deliberately generous.
 */
const TAIL_LOOKBACK_HOURS = 24;

/**
 * Bound the bytes pulled per row on the hot path. Far more than the
 * `HUMAN_TAIL_ENTRY_CHARS` a survivor can contribute, and the envelope this
 * classifies on sits at the head, so truncation never changes a verdict.
 */
const TAIL_ROW_CHARS = 2_000;

/**
 * Machine turns that arrive with NO papercusp envelope, because no papercusp
 * injector produced them — the CLI, a hook, or a watchdog did.
 *
 * ⚠ THIS LIST IS LOAD-BEARING, NOT A LONG TAIL. Measured over 3 days of live
 * `'user'` rows: 430 carried no envelope, and **167 of them (38.8%) match a
 * pattern below** — task-notifications 72, interrupt markers 54, MCP auto-heal
 * advisories 24, Stop-hook feedback 13, skill preambles 4. Together with the
 * 60.2% that ARE enveloped, ~75.6% of all `speaker='user'` rows are machine
 * text — independently corroborating D-033's 74.4% by a different route.
 *
 * That number is also a correction: an earlier draft of this module asserted the
 * unenveloped residue was "near zero per-owner". It was measured by grepping for
 * the two shapes that draft already knew about, so it could only ever confirm
 * itself. The live acceptance run caught it — every tail it built was topped by
 * `<task-notification>` blocks. If you extend this list, enumerate the
 * population first (GROUP BY on the head) instead of testing a guess.
 *
 * Add only heads a human demonstrably never types: a false positive here
 * silently drops the owner's words, which is the failure this module exists to
 * prevent. That is why there is no `^# ` rule (a human pastes markdown) and no
 * length rule (a human pastes documents) — the per-entry cap covers what the
 * catalogue misses, which is the residue's proper home.
 *
 * These are HEURISTICS and deliberately do NOT live in `turn-provenance.ts`
 * beside `INJECTED_CHROME_PATTERNS`: that module's classification is
 * PROOF-based (an envelope, or a ledger hash match), and mixing pattern guesses
 * into it would let a heuristic masquerade as a verified provenance verdict.
 */
const UNENVELOPED_MACHINE_HEADS: readonly RegExp[] = [
  // The CLI's own tag-wrapped injections. Named explicitly rather than as a
  // generic `^<tag>` so a human pasting XML keeps their turn.
  /^\s*<(task-notification|system-reminder|local-command-stdout|local-command-stderr|command-message|command-name)\b/,
  // CLI control markers for an aborted turn — text about the session, not in it.
  /^\s*\[Request interrupted by user/,
  // Stop-hook feedback: our own hook chain talking back into the turn.
  /^\s*Stop hook feedback:/,
  // The MCP transport auto-heal advisory (mcp-dark-watchdog).
  /^\s*⚠\s*MCP transport auto-heal/,
  // Claude Code's skill-loader preamble, e.g. "Base directory for this skill: …"
  /^\s*Base directory for this skill:/,
];

/**
 * Is this turn text something the HUMAN typed?
 *
 * Deliberately conservative in one direction only: an unrecognised turn is
 * treated as human (and then capped by `HUMAN_TAIL_ENTRY_CHARS`). Treating an
 * unrecognised turn as machine would drop real owner words, and losing the
 * human's signal is the defect P-006 exists to fix.
 *
 * ── Why the CATALOGUE call is here (P-005) ──────────────────────────────────
 *
 * `machine-surface-catalogue` is THE curated list, and its own header names
 * this module as one of the private copies that should import from it. That
 * migration was never done, so the catalogue reached the owner's chat pane and
 * not this altitude — and every improvement to it (including the v2 bump)
 * silently stopped at the seam. MEASURED 2026-08-11 over the 20,000 most recent
 * user turns: 529 rows the catalogue recognises were classified HUMAN here, and
 * they displaced real owner words in 4.9% of sessions' selected tails (4.2% of
 * slots) — the single largest shape being the native compaction preamble, the
 * exact row D-004 had already fixed one altitude up.
 *
 * The call is ADDITIVE, not a replacement: the private list below still holds
 * shapes the catalogue does not (the `<system-reminder>`/`<local-command-stderr>`
 * tags), and those are deliberately NOT migrated — the catalogue's synthetic
 * markers are substring-matched across the head, so moving an anchored tag
 * there would widen it into an owner who quotes the tag (D-002/D-003). Both
 * lists are consulted; neither is authoritative alone, and
 * `turn-provenance/owner-visibility-altitude-parity.test.ts` fails if the two
 * altitudes drift apart again.
 */
export function isHumanTurn(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (parseEnvelope(t)) return false; // positive proof of machine origin
  // THE one curated catalogue — never re-implement its shapes here (D-004).
  if (isUnenrolledMachineSurface(t)) return false;
  return !UNENVELOPED_MACHINE_HEADS.some((re) => re.test(t));
}

/** Normalised head, for comparing two turns without exact-byte equality. */
function turnKey(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
}

/**
 * Pick the last `count` HUMAN turns out of candidate `'user'`-row texts.
 *
 * @param texts   candidate turn texts, NEWEST FIRST.
 * @param exclude a turn to suppress — the current prompt, which the ~1 min
 *                ingest lag can already have landed in `session_turns` as a row
 *                (p50 58 s, p90 116 s), and which is composed separately anyway.
 * @returns the selected turns, NEWEST FIRST, each chrome-stripped and capped.
 */
export function selectHumanTail(
  texts: readonly string[],
  count = HUMAN_TAIL_TURNS,
  exclude?: string,
): string[] {
  const seen = new Set<string>();
  if (exclude?.trim()) seen.add(turnKey(exclude));
  const out: string[] = [];
  for (const raw of texts) {
    if (out.length >= count) break;
    if (!isHumanTurn(raw)) continue;
    // Belt-and-braces: a human turn can still carry relayed machine text (a
    // pasted wake, a quoted carry-note). stripInjectedChrome is the ONE place
    // that knows those shapes — never write a second stripper.
    const cleaned = stripInjectedChrome(raw).trim();
    if (!cleaned) continue;
    const key = turnKey(cleaned);
    if (seen.has(key)) continue; // repeated prompt, or the current one echoed back
    seen.add(key);
    out.push(cleaned.slice(0, HUMAN_TAIL_ENTRY_CHARS));
  }
  return out;
}

/**
 * Compose the final recall query: the current signal FIRST, then the human
 * tail, newest first, clamped as a whole.
 *
 * Ordering is the contract, not a detail. The clamp cuts from the tail end, so
 * composing the prompt first makes the guarantee structural: **this can never
 * return less of the current prompt than the prompt-only query it replaced.**
 * The tail spends only what is left over, and each entry is already capped.
 */
export function composeRecallQuery(args: {
  /** The current turn's signal — the stripped prompt, or the tool-derived query. */
  current: string;
  /** Human tail, newest first (from `selectHumanTail`). */
  tail: readonly string[];
  /** Total clamp for the composed query. */
  clamp: number;
}): string {
  const head = (args.current ?? '').trim().slice(0, args.clamp);
  // A blank current signal yields a blank query — the tail must NOT resurrect
  // recall for a prompt that has none. buildMemoryContextBlock returns null on
  // a blank queryContext, and that degenerate-case guard stays intact here.
  if (!head) return '';
  const parts = [head];
  let remaining = args.clamp - head.length;
  for (const turn of args.tail) {
    if (remaining <= 1) continue; // overflow SKIPS, never breaks the loop
    const piece = turn.slice(0, remaining - 1); // -1 for the joining newline
    if (!piece.trim()) continue;
    parts.push(piece);
    remaining -= piece.length + 1;
  }
  return parts.join('\n');
}

/**
 * Read the recent `speaker='user'` rows for one session owner, newest first.
 *
 * Fail-soft by contract, like every other step on this hook path: any error
 * returns `[]`, which degrades the query to exactly today's prompt-only
 * behaviour rather than failing the turn.
 *
 * `owner` is the coord ownerId and spans the whole carry/respawn chain, so the
 * tail survives a compaction — which is the case that needs it most.
 */
export async function fetchRecentUserTurnTexts(args: {
  owner: string;
  workspaceId: string;
}): Promise<string[]> {
  const owner = (args.owner ?? '').trim();
  if (!owner) return [];
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ text: string }>>`
      SELECT left(text, ${TAIL_ROW_CHARS}) AS text
        FROM harness_shared.session_turns
       WHERE owner = ${owner}
         AND speaker = 'user'
         -- Local transcript files carry no workspace identity and are stamped
         -- 'default' (the session-search convention, sources.ts).
         AND (workspace_id = ${args.workspaceId} OR workspace_id = 'default')
         AND ts > now() - (${TAIL_LOOKBACK_HOURS} * interval '1 hour')
       ORDER BY ts DESC
       LIMIT ${TAIL_SCAN_ROWS}`;
    return rows.map((r) => r.text ?? '');
  } catch {
    return []; // never load-bearing — a missing tail is a degraded query, not an error
  }
}

/**
 * The whole P-006 step in one call: fetch, filter to human turns, compose.
 * Returns the query to hand to `buildMemoryContextBlock`.
 *
 * Used by BOTH push call sites — `turn-start-memory` (current = the
 * chrome-stripped prompt) and its `mid-turn-context` sibling (current = the
 * tool-derived query). That pair is the answer to the owner's "where will this
 * be used?": nine call sites reach `injection.ts`, P-006 changes these two, and
 * `operator:converse` already passes a human tail of its own.
 */
export async function buildRecallQueryWithHumanTail(args: {
  owner: string;
  workspaceId: string;
  current: string;
  clamp: number;
}): Promise<string> {
  const current = (args.current ?? '').trim();
  if (!current) return '';
  const texts = await fetchRecentUserTurnTexts({
    owner: args.owner,
    workspaceId: args.workspaceId,
  });
  if (!texts.length) return current.slice(0, args.clamp);
  const tail = selectHumanTail(texts, HUMAN_TAIL_TURNS, current);
  return composeRecallQuery({ current, tail, clamp: args.clamp });
}
