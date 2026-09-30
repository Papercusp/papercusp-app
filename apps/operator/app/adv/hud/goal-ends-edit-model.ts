/**
 * The pure half of the "this goal ends when" inline editors
 * (goals-tab-improvement-2026-08-09 P-009).
 *
 * WHY THIS EXISTS AT ALL. The section it serves is the loudest thing the panel
 * can say — "No kill criterion was set — nothing can stop this goal" — and
 * until now it attached no remedy: the owner read an alarm and had nowhere to
 * go. The item's fix is that the warning BECOMES the control that fixes it, and
 * the money ceiling beside it becomes editable for the same reason (a ceiling
 * is usually wrong until the goal's shape is understood).
 *
 * WHY THE CRITERION RULE IS IMPORTED AND NOT RESTATED. `killCriterionProblem`
 * is the ONE definition of what counts as a written criterion, and its module
 * says in as many words why a second copy is dangerous: a private copy "drifts
 * silently and only ever in the permissive direction", so the edit door quietly
 * becomes the way to install a criterion the create door would have refused.
 * The item states this as a hard constraint. So this file adds no rule of its
 * own for the criterion — it forwards, and surfaces the shared message VERBATIM,
 * which is exactly the contract that module's header describes for this caller.
 *
 * ⚠ THIS EDITOR CANNOT CLEAR THE CRITERION, AND THAT IS DELIBERATE — not an
 * oversight to "fix" later. `goals:update` does treat a blank as an explicit
 * clear, so the capability exists one layer down; what does not exist is a
 * reason to reach it from a one-click control sitting under an alarm about the
 * criterion being absent. A blank submit here fails the shared rule like any
 * other non-criterion, and the refusal is the shared message.
 *
 * ⚠ IT CAN NOW CLEAR THE CEILING, AND THE ORDER THAT MADE THAT SAFE MATTERS.
 * Until EI-20072247655456262 `goals:update`'s `budgetCents` was
 * `z.number().int().nonnegative().optional()` — no `.nullable()`, unlike its
 * `tripwires`, `parentId` and `launchSettings` siblings, which all took null to
 * clear — so there was no value this editor could send that unset a ceiling,
 * and a blank field that appeared to clear one would have been refused by zod
 * or silently omitted and read as "leave unchanged": a control that lies about
 * what it did. Blank was therefore "no change requested" and Save stayed
 * disabled. That item widened the schema AND its handler first, so blank now
 * parses to `{ cents: null }` and the write actually removes the ceiling. The
 * precondition is the point: a blank-clears path here is only honest while the
 * server can honour it, so if that schema ever narrows again, this parse has to
 * narrow with it — the two are one behaviour split across two layers.
 */
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';

/**
 * Ten million dollars. Not a policy about what a goal may spend — the ceiling
 * is the owner's number, not ours. It is a TYPO fence: the realistic distance
 * between an intended ceiling and a slipped keystroke is orders of magnitude,
 * and a ceiling that can never be reached is indistinguishable from none while
 * looking like a bound.
 */
export const MAX_CEILING_USD = 10_000_000;

export interface CeilingInputResult {
  /**
   * Cents to write, or `null` to REMOVE the ceiling (a blank field). Present
   * only when `problem` is null — a caller that reads `cents` without checking
   * `problem` would write `undefined`, which `goals:update` reads as "leave
   * unchanged", turning a refusal into a silent no-op that still closes the
   * editor.
   *
   * ⚠ `null` and `undefined` are DIFFERENT WRITES here, so a caller must not
   * collapse them with `??` or a falsy check: null removes the ceiling and
   * undefined leaves it alone. That is the same distinction the write path
   * makes, and the reason the field is optional-and-nullable rather than
   * merely optional.
   */
  cents?: number | null;
  /** The refusal to render under the field, or null when the input is usable. */
  problem: string | null;
}

/**
 * Parse what the owner typed into the ceiling field.
 *
 * Accepts a leading `$` and thousands commas because both are what a person
 * types when the label beside the field is a dollar amount. Rejects everything
 * else by pattern rather than by `Number()`, which would quietly accept `1e9`,
 * `0x10`, `Infinity` and a trailing-garbage `500abc` — each a number the owner
 * did not mean and none of them a typo we should silently round into a binding
 * ceiling.
 *
 * More than two decimal places is a refusal rather than a round, because cents
 * are the stored unit: rounding `12.345` to `$12.35` writes a ceiling the owner
 * never typed and never sees corrected.
 */
export function parseCeilingInput(raw: string): CeilingInputResult {
  const text = raw.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  // Blank REMOVES the ceiling (EI-20072247655456262). Explicitly `null`, never
  // an omitted `cents`: the write path reads undefined as "leave unchanged", so
  // returning nothing here would close the editor having done nothing while
  // looking like it cleared the field.
  if (!text) return { cents: null, problem: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return {
      problem: `'${raw.trim()}' is not a dollar amount — enter a number like 500 or 1250.50`,
    };
  }
  const usd = Number(text);
  if (!Number.isFinite(usd)) {
    return { problem: `'${raw.trim()}' is not a dollar amount` };
  }
  if (usd > MAX_CEILING_USD) {
    return {
      problem: `$${usd.toLocaleString('en-US')} is past the $${MAX_CEILING_USD.toLocaleString('en-US')} limit this field accepts — a ceiling that large cannot bind anything, so it is more likely a typo than an intent`,
    };
  }
  return { cents: Math.round(usd * 100), problem: null };
}

/**
 * The stored ceiling as the owner should see it in the input.
 *
 * Empty for "no ceiling" — the same absence the field's own note names — and
 * two decimals ONLY when the stored value actually has cents, so a $500 ceiling
 * reads `500` rather than the invoice-looking `500.00`.
 */
export function ceilingToInput(budgetCents: number | null | undefined): string {
  if (budgetCents == null || !Number.isFinite(budgetCents)) return '';
  const cents = Math.round(budgetCents);
  if (cents < 0) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * The criterion's refusal message, or null.
 *
 * A forwarder with no logic of its own — see the header. It exists as a named
 * export so the editor imports ONE thing from this module and a reader looking
 * for "where does the editor decide?" lands on the file that says the rule is
 * not decided here.
 */
export function criterionSubmitProblem(draft: string): string | null {
  return killCriterionProblem(draft);
}

/** Has the criterion draft actually moved off what is stored? */
export function criterionDirty(stored: string | null | undefined, draft: string): boolean {
  return (stored ?? '').trim() !== draft.trim();
}

/**
 * Has the ceiling draft actually moved off what is stored?
 *
 * Compares PARSED values, not text, so `$500`, `500` and `500.00` are all the
 * same ceiling and none of them offers a Save that would write nothing.
 *
 * BLANK IS DIRTY EXACTLY WHEN A CEILING IS STORED. Blank means "remove it"
 * (see the header — the write path takes null now), so it is a real change
 * against a stored ceiling and no change at all against none. The second half
 * is what keeps Save disabled on the "Set ceiling" path: an enabled Save over
 * an empty field with nothing stored would write null over null and report a
 * removal that removed nothing.
 *
 * An unparseable NON-blank draft does count as dirty: the owner typed
 * something, and disabling Save on it would hide the refusal that explains
 * why it is not a ceiling.
 */
export function ceilingDirty(storedCents: number | null | undefined, draft: string): boolean {
  const typed = draft.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (!typed) return storedCents != null && storedCents >= 0;
  const parsed = parseCeilingInput(draft);
  if (parsed.problem) return true;
  const stored = storedCents == null || storedCents < 0 ? null : Math.round(storedCents);
  return parsed.cents !== stored;
}
