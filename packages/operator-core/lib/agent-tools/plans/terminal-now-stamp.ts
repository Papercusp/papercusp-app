/**
 * terminal-now-stamp.ts — stamp a plan's `## Now` block when the plan reaches a
 * TERMINAL lifecycle status (shipped / superseded).
 *
 * WHY. The `## Now` block is the cold-resume anchor — the single most-read
 * field on a plan — and nothing updated it when the plan's status flipped.
 * A shipped plan therefore keeps instructing readers to do work that is already
 * finished, and that prose is BELIEVED precisely because it is specific and was
 * correct when written. Measured twice inside one session on this box
 * (2026-08-12): `spawner-sidecar-cluster-fanout-2026-08-12` sat at
 * frontmatter.status='shipped' for 8h while its Now still read "SHIP BLOCKER
 * (the only one) … UNGRADED", sending an agent to re-grade a rubric that had
 * been graded 6/6 hours earlier; a sibling plan's Now said "await the re-grade"
 * after three scorecards already existed. In both cases three prose surfaces
 * agreed with each other and only the frontmatter was true.
 *
 * The existing guard covers the OPPOSITE direction only: lint.ts's
 * `completion_status_mismatch` (EI-205) fires when the Now reads complete but
 * the status is still draft/ready. Nothing fired for terminal-status-with-live-
 * Now, and a lint only reaches whoever runs it — never the agent being misled.
 *
 * The stamp is PREPEND-ONLY. The author's own State/Next text is preserved
 * verbatim beneath the banner, so no content is destroyed and no risky "does
 * this prose read as finished?" classifier is needed to decide whether the
 * rewrite is safe. It leads BOTH structured fields (`now.state` and `now.next`),
 * not just the rendered markdown, because agents read the parsed block at least
 * as often as the prose.
 */

import { parsePlan } from './parser';
import { replaceNowBlock } from './set-now';

/**
 * Sentinel that makes the stamp idempotent. Matched against the WHOLE existing
 * Now block, so a re-ship (or a superseded plan later marked shipped) never
 * nests a second banner. Deliberately a literal that no human writes by hand.
 */
export const TERMINAL_NOW_STAMP_MARK = '⛔ PLAN CLOSED';

const LABELS = { shipped: 'SHIPPED', superseded: 'SUPERSEDED' } as const;

export type TerminalNowStatus = keyof typeof LABELS;

/** Where the first `**State:**` / `**Next:**` marker begins, or -1. */
const FIRST_MARKER_RE = /\*\*(?:State|Next):\*\*/i;

/**
 * Return the plan body with its `## Now` block stamped as closed, or `null`
 * when there is nothing to do:
 *   - the status is not terminal
 *   - the plan has no `## Now` block (never invent one — an absent Now is not
 *     a lying Now, and a plan that never had the anchor should not gain one
 *     as a side effect of shipping)
 *   - the block is already stamped (idempotent)
 *
 * Pure — no I/O, no clock beyond the injected `today`. Callers splice the
 * result into the same locked write as the status flip so the stamp and the
 * status can never disagree, not even transiently.
 */
export function stampTerminalNowBlock(
  body: string,
  status: string,
  today: Date = new Date(),
): string | null {
  const label = LABELS[status as TerminalNowStatus];
  if (!label) return null;

  const now = parsePlan(body).now;
  if (!now) return null;
  if (now.raw.includes(TERMINAL_NOW_STAMP_MARK)) return null;

  const iso = today.toISOString().slice(0, 10);
  const verb = label.toLowerCase();
  const banner =
    `${TERMINAL_NOW_STAMP_MARK} — ${label} ${iso}. Nothing in this plan is actionable. ` +
    `Anything below this line is the last pre-${verb} snapshot, kept for history: it described ` +
    `work that is finished or abandoned, so do not start from it. Read frontmatter \`status\`, ` +
    `not this prose, to learn whether a plan is live (stamped by plans:set-plan-status).`;

  // Content the parser attributes to neither field: prose written between the
  // `## Now` heading and the first **State:**/**Next:** marker. `replaceNowBlock`
  // rewrites the whole section, so carry it or it is dropped.
  const markerAt = now.raw.search(FIRST_MARKER_RE);
  const preamble = markerAt > 0 ? now.raw.slice(0, markerAt).trim() : '';
  // A Now block written as free prose (no markers at all) parses to empty
  // state+next with everything in `raw` — carry the whole thing.
  const freeProse = !now.state && !now.next ? now.raw.trim() : '';

  const state = [banner, preamble, now.state, freeProse].filter(Boolean).join('\n\n');
  const next = now.next
    ? `none — the plan is ${verb}. (Pre-${verb} next, no longer actionable: ${now.next})`
    : `none — the plan is ${verb}.`;

  return replaceNowBlock(body, state, next);
}
