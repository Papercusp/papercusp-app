/**
 * loop-goal-staleness.ts — EI-19501119110607678.
 *
 * THE BUG. `loop:arm`'s `goal` is frozen at arm time and re-delivered on every wake.
 * One measured instance: a goal armed 2026-08-03T15:07Z named four concrete items
 * ("Current lane: EI-… — BLOCKED on a lock held by …"); by 06:00Z the next morning
 * ALL FOUR were `done`, closed by the same agent hours earlier, and the lock
 * contention it described was long resolved. For ~14 hours, 171 fires, the wake
 * carried a confident, specific, WRONG instruction to work finished items.
 *
 * WHAT WAS ALREADY FIXED, AND WHY IT IS NOT ENOUGH. P-017
 * (fleet-lead-instrumentation-audit-2026-08-09) fixed the ORDERING half: the goal no
 * longer leads the wake, and is tagged "frozen at arm time — the checkpoint above is
 * the fresher source". That is a GENERIC caution, and a generic caution loses to
 * specific text every time — the goal still names real ids in the shape of live
 * state, and "frozen" does not tell you it is WRONG, only that it might be. The
 * reader must still go and check, every wake, forever; nobody does.
 *
 * WHAT THIS ADDS. A MEASUREMENT, not another caution: resolve the ids the goal names
 * and say what they actually are now. "This goal names 4 work-items, all terminal
 * (EI-… done)" ends the question instead of deferring it.
 *
 * ⚠ THE FAILURE MODE THIS MODULE MUST NOT HAVE is announcing staleness it did not
 * measure. An unresolvable id (read failed, wrong workspace, typo in the goal) is
 * NOT a terminal id, and a lookup that returns nothing is NOT "everything is done" —
 * that is the "zero rows read as a real zero" trap, and here it would produce a
 * confident STALE verdict on a perfectly live goal, which is worse than the silence
 * it replaced. So `unresolved` is tracked as its own bucket, never folded into
 * terminal, and `allTerminal` requires that nothing was left unresolved.
 *
 * Pure + clock-free: states come in as data, so this is exhaustively testable with
 * no PG.
 */
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

/**
 * The work-item id shapes a goal can name.
 *
 * ⚠ ONE REGEX, shared with `detectDrivenWorkItemId` (loop.ts) rather than copied.
 * That function answers a DIFFERENT question — "does this goal name exactly one item
 * I should auto-claim?" — but off the SAME extraction, and two regexes that must
 * agree about what an id looks like are two regexes that will eventually disagree.
 */
const WORK_ITEM_ID = /\b(?:WI|EI|F)-\d+\b/gi;

/** Terminal states, canonical — never hand-listed (the same import `agent-goal-sources`
 *  uses, for the same reason: a local copy silently missed `passed`/`resolved`). */
const TERMINAL = new Set<string>(ANY_FAMILY_TERMINAL_STATES.map((s) => s.toLowerCase()));

/**
 * Every distinct work-item id a goal names, in first-appearance order.
 *
 * Upper-cased so `ei-123` and `EI-123` cannot count as two items, which would let a
 * goal look like it names more work than it does.
 */
export function extractGoalWorkItemIds(goal: string | null | undefined): string[] {
  const matches = String(goal ?? '').match(WORK_ITEM_ID);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const id = m.toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface GoalStalenessVerdict {
  /** Distinct ids the goal names. Empty ⇒ nothing to check; the goal is prose. */
  ids: string[];
  /** Ids resolved to a terminal state, with the state, in goal order. */
  terminal: { id: string; state: string }[];
  /** Ids resolved to a NON-terminal state — the goal still has live work in it. */
  live: string[];
  /**
   * Ids the state read could not resolve.
   *
   * ⚠ NOT terminal and NOT live. A read failure and a genuinely-finished item must
   * never be the same bucket, or a broken lookup renders as "your whole goal is
   * done" — the loudest possible wrong answer.
   */
  unresolved: string[];
  /** Every named id resolved, at least one, and none live. The strong verdict. */
  allTerminal: boolean;
  /** The wake annotation, or null when there is nothing honest to say. */
  note: string | null;
}

/**
 * Judge a frozen goal against the CURRENT state of the items it names.
 *
 * `states` maps id → work-item state. An id absent from the map is UNRESOLVED (see
 * the interface note) — callers must pass a map built from a successful read, and
 * pass an EMPTY map for a failed one, which correctly yields "everything unresolved"
 * and therefore no claim at all.
 */
export function assessGoalStaleness(
  goal: string | null | undefined,
  states: ReadonlyMap<string, string>,
): GoalStalenessVerdict {
  const ids = extractGoalWorkItemIds(goal);
  const terminal: { id: string; state: string }[] = [];
  const live: string[] = [];
  const unresolved: string[] = [];

  for (const id of ids) {
    const state = states.get(id);
    if (state == null || state === '') {
      unresolved.push(id);
      continue;
    }
    if (TERMINAL.has(state.toLowerCase())) terminal.push({ id, state });
    else live.push(id);
  }

  const allTerminal = ids.length > 0 && unresolved.length === 0 && live.length === 0 && terminal.length > 0;

  return { ids, terminal, live, unresolved, allTerminal, note: renderNote({ ids, terminal, live, unresolved, allTerminal }) };
}

/**
 * The annotation.
 *
 * SILENT WHEN THERE IS NOTHING TO SAY. A goal whose items are all live gets no line
 * — this fires exactly when the text is dangerous, which is what keeps it worth
 * reading. Adding a reassurance on every healthy wake would make it scenery within a
 * day, and scenery is what the P-017 caution already became.
 */
function renderNote(v: Omit<GoalStalenessVerdict, 'note'>): string | null {
  if (v.terminal.length === 0) return null;
  const named = v.terminal.map((t) => `${t.id} (${t.state})`).join(', ');

  if (v.allTerminal) {
    return (
      `⚠⚠ THIS GOAL IS STALE — every work-item it names is already TERMINAL: ${named}. ` +
      `The goal text was frozen when the loop was armed and nothing invalidates it, so it will keep ` +
      `arriving every wake looking like live state. Do NOT start on those items: re-read your ` +
      `checkpoint for the real next action, and re-arm with a current goal (loop:arm { goal }) so the ` +
      `next wake stops repeating this.`
    );
  }

  const remaining = v.live.length > 0 ? ` Still open: ${v.live.join(', ')}.` : '';
  const unknown =
    v.unresolved.length > 0
      ? ` Could not resolve ${v.unresolved.join(', ')} — treat those as UNKNOWN, not as finished.`
      : '';
  return (
    `⚠ This goal names ${v.ids.length} work-item(s); ${v.terminal.length} already TERMINAL: ${named}.` +
    `${remaining}${unknown} The goal is frozen at arm time — verify an item's state before acting on it.`
  );
}
