/**
 * queen-loop-facts — identify QUEEN-LOOP CONTROL standing-facts / recall hits so
 * coord:orient can WITHHOLD them from OWNER-DIRECTED (responsive) callers
 * (queen-fleet-authority-boundary-2026-07-02 P-002 / D-001).
 *
 * pauseNewWork / maxBees / hive-steering are controls for the queen-bee LOOP
 * (driveMode auto: queen/overwatch/bee). They must NOT be DELIVERED as binding to
 * a responsive session (su/sentinel/planner): a fleet leader / SU engineer that
 * reads "the hive is paused" as a self-command self-drains its fleet (the
 * 2026-07-02 churn). Steering stays PULLABLE on demand via pot:get-steering — it
 * is only stripped from the PUSHED orientation of a responsive caller (visibility
 * != bindingness; D-001).
 *
 * Two signals, so both a future structured convention AND today's ad-hoc asserts
 * are caught:
 *   1. STRUCTURAL — a fact key in the reserved `queen-loop:` namespace. Queen-loop
 *      control facts SHOULD be asserted at scope role:'queen' (which coord:orient
 *      never folds) or with this key prefix.
 *   2. VOCABULARY — a body naming the queen-loop steering levers (pauseNewWork,
 *      maxBees, pausedUntil, "place no new bees", "hive is paused", …). Catches a
 *      monitor's harness/workspace-scoped hand-asserted steering note — the
 *      observed leak that reached responsive orients.
 * Pure + unit-tested; the drive-mode gate lives in the caller (composeOrient).
 */

/** Reserved fact-key namespace for queen-loop control conclusions. */
export const QUEEN_LOOP_FACT_KEY_PREFIX = 'queen-loop:';

/** Body vocabulary of the queen-loop steering levers (case-insensitive). Specific
 *  enough that ordinary work-facts don't match: the camelCase lever names, and the
 *  imperative "pause the hive / place no new bees" phrasings a steering note uses. */
const STEERING_VOCAB_RE =
  /\b(pausenewwork|maxbees|pauseduntil)\b|place\s+no\s+new\s+(bee|work)|\bhive\s+(is\s+)?paused\b|paus(e|es|ed|ing)\s+the\s+(hive|queen)|new[-\s]?work\s+paused/i;

/** True iff a fact / recall hit is a QUEEN-LOOP control conclusion (structural key
 *  OR steering vocabulary). */
export function isQueenLoopControlText(opts: { key?: string | null; body?: string | null }): boolean {
  const key = (opts.key ?? '').toLowerCase();
  if (key.startsWith(QUEEN_LOOP_FACT_KEY_PREFIX)) return true;
  return STEERING_VOCAB_RE.test(opts.body ?? '');
}

/**
 * Partition items into kept vs withheld by the queen-loop-control predicate,
 * applied ONLY for a responsive caller. For any OTHER drive mode (auto, or unknown)
 * nothing is withheld — the queen-bee loop SHOULD receive its own steering, and an
 * unattributable caller is treated as the safe (non-withholding) default. `read`
 * projects each item to the { key, body } the predicate inspects, so the same
 * helper serves both the typed facts fold and the free-text recall hits.
 */
export function withholdQueenLoopControl<T>(
  items: readonly T[],
  driveMode: string | undefined,
  read: (item: T) => { key?: string | null; body?: string | null },
): { kept: T[]; withheld: T[] } {
  if (driveMode !== 'responsive') return { kept: [...items], withheld: [] };
  const kept: T[] = [];
  const withheld: T[] = [];
  for (const it of items) {
    (isQueenLoopControlText(read(it)) ? withheld : kept).push(it);
  }
  return { kept, withheld };
}

/** The transparency note surfaced on orient when queen-loop steering was withheld
 *  from a responsive caller — never a silent drop (mirrors coord:send's scoped
 *  report). */
export const QUEEN_LOOP_WITHHELD_REASON =
  "legacy queen-loop steering facts (pauseNewWork/maxBees/hive-pause) were withheld from an owner-directed (responsive) session — they govern the RETIRED autonomous placement loop, not your task, and no agent acts on them today. Pull live fleet state on demand via pot:get-steering; a fleet is paused only by an explicit fleet:* / owner action.";
