/**
 * Canonical ticket workflow vocabulary — linear-asana-task-sync-2026-10-05 P-001.
 *
 * The `ticket` datatype (migrations 1332 + 1377) carries an optional
 * `statusCategory`: one provider-neutral workflow column every tracker maps onto
 * (Linear's workflow-state types, Asana sections/completion, GitHub open/closed).
 * The coarse `state` open|closed stays on every ticket and is DERIVED from the
 * category here, so a consumer that only knows open/closed keeps working.
 *
 * This module is the single TypeScript statement of that vocabulary. Provider
 * plugins are self-contained CommonJS and restate the mapping they need; the
 * drift test (ticket-vocabulary.test.ts) pins this list to the enums in
 * migration 1377 so the two cannot silently diverge.
 */

/** Workflow categories, in board order. */
export const TICKET_STATUS_CATEGORIES = [
  'triage',
  'backlog',
  'todo',
  'in-progress',
  'in-review',
  'done',
  'canceled',
] as const;

export type TicketStatusCategory = (typeof TICKET_STATUS_CATEGORIES)[number];

export type TicketState = 'open' | 'closed';

export type TicketTransition = 'opened' | 'closed' | 'reopened' | 'moved';

const CLOSED_CATEGORIES: ReadonlySet<TicketStatusCategory> = new Set(['done', 'canceled']);

export function isTicketStatusCategory(value: unknown): value is TicketStatusCategory {
  return typeof value === 'string' && (TICKET_STATUS_CATEGORIES as readonly string[]).includes(value);
}

/** The coarse open/closed state a category implies: done and canceled are closed. */
export function ticketStateForCategory(category: TicketStatusCategory): TicketState {
  return CLOSED_CATEGORIES.has(category) ? 'closed' : 'open';
}

/**
 * The `ticket-status-change` transition for a category change, or null when
 * nothing changed. Crossing open→closed is `closed`, closed→open is `reopened`;
 * any other change of column (todo→in-progress, done→canceled) is `moved`.
 * A ticket seen for the first time has no `from` and is `opened`.
 */
export function ticketTransitionBetween(
  from: TicketStatusCategory | null | undefined,
  to: TicketStatusCategory,
): TicketTransition | null {
  if (from == null) return 'opened';
  if (from === to) return null;
  const before = ticketStateForCategory(from);
  const after = ticketStateForCategory(to);
  if (before === 'open' && after === 'closed') return 'closed';
  if (before === 'closed' && after === 'open') return 'reopened';
  return 'moved';
}
