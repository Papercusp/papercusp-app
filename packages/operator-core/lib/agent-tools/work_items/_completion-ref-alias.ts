/**
 * `reason` / `note` ↔ `completionRef`: the SAME logical field on a TERMINAL
 * work_items:set_state write, accepted under the name this verb's own family already
 * taught the caller (EI-19961538712475843).
 *
 * THE BUG THIS CLOSES (measured 2026-09-05 against harness_shared.tool_invocations over
 * a 7-day window): work_items:set_state rejected 84 calls from 52 distinct agents, and
 * 59 of those were a bare `Unrecognized key` — 53 naming `reason`, 6 naming `note`.
 * That is not a typo burst. `reason` is the HOUSE CONVENTION across this verb's own
 * siblings — work_items:park, :release, :hold_open, :rehome, :request_release,
 * :withdraw_release_request, :decline_release_request and :claim all declare it — so
 * set_state was the one member of the family that refused the word its neighbours had
 * taught. The callers were applying the convention correctly; the outlier was the tool.
 *
 * WHY AN ALIAS RATHER THAN A BETTER ERROR: on a terminal write the caller's `reason` IS
 * the completion evidence, so the call is right in every respect except the spelling.
 * Aliasing turns the rejection into the write the caller already intended, which a
 * suggestion cannot do.
 *
 * WHY IT IS REFUSED ON A NON-TERMINAL WRITE: `completionRef` is persisted to
 * `terminal_completion_ref`, which `setWorkItemState` writes only on the terminal branch
 * (work-items.ts). Routing a non-terminal `reason` into it would ACCEPT the argument and
 * silently discard the value — precisely the silent-success bug {@link ./_body-alias}
 * was written to kill, and the reason that module rejects its own ambiguous case instead
 * of guessing. So the non-terminal branch refuses the alias LOUDLY and names the verb
 * that does persist a reason, rather than accepting a value it cannot store.
 *
 * CLASS: the silent-success family — an `ok` that did nothing, and a write that
 * discarded its payload while reporting success.
 */
import { z } from 'zod';

/** Accepted spellings, in precedence order. Ordered, so resolution is deterministic. */
export const COMPLETION_REF_ALIAS_KEYS = ['reason', 'note'] as const;

/** The shape both the top-level shorthand and the items[] union arms carry. */
export type CompletionRefAliasBearing = {
  completionRef?: unknown;
  reason?: unknown;
  note?: unknown;
};

const ALIAS_DESCRIBE =
  'alias for `completionRef` on a TERMINAL state — refused on a non-terminal one, which persists no reason field';

/**
 * Schema fields, spread into every shape that accepts the alias. Declared on BOTH union
 * arms (not just the terminal one) on purpose: the args schema is `.strict()`, so an
 * undeclared key is rejected at parse time, which would preempt the targeted
 * non-terminal message in {@link rejectNonTerminalCompletionAlias} with a generic
 * "Unrecognized key" — the exact dead-end this module exists to remove.
 */
export const completionRefAliasFields = {
  reason: z.string().min(1).max(2000).optional().describe(ALIAS_DESCRIBE),
  note: z.string().min(1).max(2000).optional().describe(ALIAS_DESCRIBE),
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The alias actually supplied, with its key — `reason` outranks `note`. */
export function suppliedAlias(
  a: CompletionRefAliasBearing,
): { key: (typeof COMPLETION_REF_ALIAS_KEYS)[number]; value: string } | undefined {
  for (const key of COMPLETION_REF_ALIAS_KEYS) {
    const value = asString(a[key]);
    if (value !== undefined) return { key, value };
  }
  return undefined;
}

/**
 * Resolve the single completion-evidence value from whichever name was used. Order is
 * irrelevant once {@link rejectCompletionRefAliasConflict} has run at validation time:
 * at most one distinct value survives, so the first present wins. `undefined` when none
 * was supplied.
 */
export function resolveCompletionRefAlias(a: CompletionRefAliasBearing): string | undefined {
  return asString(a.completionRef) ?? suppliedAlias(a)?.value;
}

/**
 * Reject the cases aliasing cannot silently resolve: a canonical `completionRef` AND an
 * alias supplied with DIFFERENT values, or both aliases supplied with different values.
 * Which one wins would be ambiguous, so — as in `_body-alias` — say so rather than pick.
 * Pure; add via `.superRefine`.
 */
export function rejectCompletionRefAliasConflict(
  a: CompletionRefAliasBearing,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number> = [],
): void {
  const canonical = asString(a.completionRef);
  const reason = asString(a.reason);
  const note = asString(a.note);
  const conflictWith = (key: string, value: string): boolean =>
    canonical !== undefined && value !== canonical && key.length > 0;

  for (const [key, value] of [
    ['reason', reason],
    ['note', note],
  ] as const) {
    if (value !== undefined && conflictWith(key, value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `\`${key}\` and \`completionRef\` are the SAME field on a terminal write — pass only one. You passed both with different values, so which one wins would be ambiguous.`,
      });
    }
  }

  if (reason !== undefined && note !== undefined && reason !== note) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, 'note'],
      message:
        '`reason` and `note` are the SAME field — pass only one. You passed both with different values, so which one wins would be ambiguous.',
    });
  }
}

/**
 * Refuse an alias on a NON-TERMINAL write, naming the verb that actually persists the
 * value. Loud by design: the alternative is accepting an argument this branch cannot
 * store (see the module header).
 */
export function rejectNonTerminalCompletionAlias(
  a: CompletionRefAliasBearing,
  state: unknown,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number> = [],
): void {
  const supplied = suppliedAlias(a);
  if (!supplied) return;
  const isBlocked = String(state ?? '').trim().toLowerCase() === 'blocked';
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...path, supplied.key],
    message:
      `\`${supplied.key}\` aliases \`completionRef\`, which only a TERMINAL state persists — a ` +
      `"${String(state ?? '')}" write stores no reason field, so accepting it here would silently discard it. ` +
      (isBlocked
        ? 'Record a blocked reason with work_items:set_blocker (typed external blocker), or work_items:link { rel:"blocks" } for a dependency on another work-item.'
        : 'Record the reason with work_items:comment, or work_items:checkpoint for in-flight state.'),
  });
}
