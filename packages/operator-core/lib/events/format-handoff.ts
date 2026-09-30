/**
 * The shared render layer for a deferral/handoff (event-reaction-system D-008,
 * "the `formatHandoff` render layer").
 *
 * One formatter, used by the defer→pane rule so the deferral renders identically
 * every time — and the agent spends ZERO tokens narrating it. Styled after
 * `summariseActivity` (compact, ≤ a couple lines) so it reads cleanly in the pui
 * fleet view's activity lane.
 */

import { clip } from '../activity-summary';

/** The `coord:handoff` open-handoff args this renders. (Mirrors the tool's Zod schema.) */
export interface HandoffArgs {
  to?: string[];
  plan_slug?: string;
  summary?: string;
  body?: string;
  next_action?: string;
  files_modified?: string[];
  commit?: string;
  note?: string;
}

/** Render a deferral/handoff as a compact one-liner for the agent's activity lane. */
export function formatHandoff(a: HandoffArgs): string {
  const to = a.to && a.to.length ? a.to.join(', ') : 'unassigned';
  const plan = a.plan_slug ? ` [${a.plan_slug}]` : '';
  const head = a.summary ? clip(a.summary, 90) : 'handoff';
  const next = a.next_action ? ` — next: ${clip(a.next_action, 60)}` : '';
  return clip(`⤳ deferred → ${to}${plan}: ${head}${next}`, 220);
}
