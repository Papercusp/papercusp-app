/**
 * UI display-projection for the coord.* sync feeds
 * (whole-app-sync-payload-audit-2026-07-19 P-006).
 *
 * The `coord.inbox` / `coord.plans` sync resolvers return the SHARED
 * loadCoordInbox / loadCoordPlans loader output, which also feeds the
 * `/api/coord/*` HTTP routes (the pui TUI). The ONLY @papercusp/sync consumer
 * is CoordDashboard (app/coord/CoordDashboard.tsx), and it renders a strict
 * subset — so we project the loader rows to that subset at the SYNC RESOLVER
 * boundary only, leaving the HTTP-route loaders (and the pui TUI) untouched.
 *
 * Measured full sync payloads (2026-07-19, :3170):
 *   - coord.inbox 1.75MB — `payload` (the full CoordEnvelope) is 88% (1.55MB)
 *     and is NOT in CoordDashboard's InboxItem type (it renders `summary`).
 *   - coord.plans 1.09MB — `now_state` 655KB (60%) is carried but rendered
 *     NOWHERE in PlansPanel (the full plan body loads on-demand via
 *     /api/coord/plans/:slug); `now_next` 220KB IS rendered, CSS-truncated.
 */

import { isTerminalPlanStatus } from '@papercusp/plan-parser';
import { isPlanRunInstanceSlug } from '../agent-tools/plans/run-instance-slug';

/** Preview cap for the one displayed long-text field (matches the plans P-005 cap). */
export const COORD_TEXT_PREVIEW_MAX = 280;

function clipPreview(v: unknown, n: number): unknown {
  if (typeof v !== 'string') return v;
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

/**
 * Drop the heavy `payload` (full CoordEnvelope) from each inbox row — the
 * CoordDashboard InboxItem type omits it and the panel renders `summary`.
 * Every other (scalar) field is kept verbatim, incl. the `source`+`msg_id`
 * the client keys on. Defensive: a non-array passes through.
 */
export function projectCoordInboxForUi(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const { payload: _payload, ...rest } = row as Record<string, unknown>;
    return rest;
  });
}

/**
 * Drop the heavy `payload` (the envelope minus its projected columns) from each
 * history row — WI-7297.
 *
 * ## Why dropping it is not the same call as for coord.inbox above
 *
 * CoordDashboard never renders the inbox `payload` at all, so that one is a
 * plainly-unread field. CoordHistory DOES render this one — but through a
 * single `expanded` useState, so AT MOST ONE row's payload is ever displayed,
 * and only after a click. Measured live 2026-08-03: `payload` was 75.95% of the
 * read (159,523 B of 210,029 B) to display, in the common case, zero of them.
 * The waste is per-VIEW rather than per-row, which is why no further projection
 * of payload's CONTENTS could have fixed it — WI-7295 had already removed the
 * last redundant bytes, and everything left (`body`, `sections`,
 * `fieldProvenance`, `basedOn`) is real content that the expand pane needs.
 *
 * Nothing becomes unreachable: the expanded row fetches its own payload from
 * `/api/coord/history/:source/:msg_id` (an indexed point lookup, not a scan),
 * and the unprojected `/api/coord/history` HTTP route (pui TUI) still serves
 * every payload inline. The `source` + `msg_id` the client keys on — and which
 * that fetch is addressed by — are both kept, as is every other scalar.
 *
 * Applied to BOTH resolver branches (snapshot and live-scan fallback) so a
 * filtered view and the default view carry the SAME shape; `coord.history` rows
 * are keyed and diffed by the sync layer, and a shape that changed when a user
 * toggled a filter would churn deltas for unchanged data.
 */
export function projectCoordHistoryForUi(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const { payload: _payload, ...rest } = row as Record<string, unknown>;
    return rest;
  });
}

/**
 * Drop `now_state` (carried but never rendered), clip `now_next` (rendered as a
 * truncated preview), and drop FINISHED plan-run snapshot rows (WI-7256) from
 * each coord.plans row. Everything else — slug, title, status, updated,
 * item_count, decision_count — is kept.
 *
 * ## Why rows are dropped here and not just bytes
 *
 * WI-7246 established there is no per-row waste left: all seven surviving
 * columns are rendered by the sole consumer (CoordDashboard's PlansPanel), and
 * clipping `now_next` harder was measured and rejected — even an absurd clip to
 * 80 chars still leaves the payload over budget while truncating 724 of 953
 * rendered previews. The breach is ROW GROWTH, and it is unbounded: a scheduled
 * plan mints a `<template>@run-<token>` instance row per fire, permanently, and
 * nothing prunes them. One plan accounted for 50 of 973 rows.
 *
 * ## Why only the TERMINAL ones
 *
 * An instance is minted `active` (plan-run-action.ts) and becomes `superseded`
 * when the run finishes, so status — not the slug shape — is what separates
 * history from live state. Dropping every instance would silently hide an
 * IN-FLIGHT scheduled run from the panel; dropping only the terminal ones
 * removes exactly the accumulating population and leaves the live one visible.
 * What remains is bounded by concurrent runs rather than by all runs ever.
 *
 * Nothing becomes unreachable: the parent template keeps its own row, and the
 * full run history is still served by the unprojected `/api/coord/plans` HTTP
 * route (and `plans:runs`) — this projection is the sync boundary only.
 */
export function projectCoordPlansForUi(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  const out: unknown[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      out.push(row);
      continue;
    }
    const { now_state: _nowState, ...rest } = row as Record<string, unknown>;
    if (isPlanRunInstanceSlug(rest.slug) && isTerminalPlanStatus(rest.status as string | null | undefined)) {
      continue;
    }
    if ('now_next' in rest) rest.now_next = clipPreview(rest.now_next, COORD_TEXT_PREVIEW_MAX);
    out.push(rest);
  }
  return windowCoordPlansForUi(out);
}

/**
 * Most-recently-updated plans kept in the SYNC payload (WI-7256).
 *
 * ## Why a window and NOT another ceiling raise
 *
 * WI-7246 removed the per-row waste; every surviving field is rendered. What
 * was left is a read with NO BOUND, and its own allowlist entry said so:
 * "authored plans accrue at ~45-50/week ... THAT RED IS THE WINDOWING TRIGGER
 * — WI-7256's second half — NOT ANOTHER RAISE."
 *
 * That red arrived. Measured 2026-08-31, papercusp: 1,486 projected rows /
 * 634,634 B — 63% past the raised 390,000 ceiling, having been 973 rows /
 * 395,430 B on 2026-08-03. A ceiling only ever moves the next breach.
 *
 * NOTE the accrual is dominated by ORDINARY authored plans, not the
 * `<slug>@run-<epochms>` snapshots the title of WI-7256 names: only 83 of
 * 1,681 live rows are snapshots, and the terminal ones are already dropped
 * above. Windowing is what bounds the LARGER term.
 *
 * 400 rows measured 182,946 B — inside the 250,000 DEFAULT budget with 27%
 * headroom, which is why `coord.plans` no longer needs an allowlist entry at
 * all. The payload is now bounded by the window rather than by the corpus:
 * new plans rotate the oldest out instead of growing the feed.
 *
 * ## Why this is safe here
 *
 * PlansPanel has no filter or search predicate — it renders a flat list and
 * loads a full body on demand — so windowing cannot silently degrade a search
 * the way it would for a filtered feed. Nothing becomes unreachable: the
 * unprojected `/api/coord/plans` HTTP route (pui TUI) and `plans:list` still
 * serve the whole corpus, and the panel is told when its list is windowed.
 */
export const COORD_PLANS_UI_WINDOW = 400;

/**
 * Newest-first by `updated`, rows with no `updated` last, ties broken by slug.
 *
 * The tie-break is load-bearing, not cosmetic. `updated` is DATE-granularity
 * (`YYYY-MM-DD`), so many rows share a key at the cutoff, and `coord.plans` is
 * a DELTA-encoded resource (sync-delta-codec DELTA_RESOURCES). Without a total
 * order the membership of the last page could differ between two polls of
 * unchanged data, emitting spurious add/remove deltas. Sorting on the RESOLVED
 * `updated` (the loader already collapses row ?? frontmatter) also means this
 * never re-derives identity from markdown — the WI-7246 invariant.
 */
function windowCoordPlansForUi(rows: unknown[]): unknown[] {
  if (rows.length <= COORD_PLANS_UI_WINDOW) return rows;
  const updatedOf = (r: unknown): string =>
    r && typeof r === 'object' && typeof (r as Record<string, unknown>).updated === 'string'
      ? ((r as Record<string, unknown>).updated as string)
      : '';
  const slugOf = (r: unknown): string =>
    r && typeof r === 'object' ? String((r as Record<string, unknown>).slug ?? '') : '';
  return [...rows]
    .sort((a, b) => {
      const au = updatedOf(a);
      const bu = updatedOf(b);
      if (au !== bu) {
        if (!au) return 1;
        if (!bu) return -1;
        return bu.localeCompare(au);
      }
      return slugOf(a).localeCompare(slugOf(b));
    })
    .slice(0, COORD_PLANS_UI_WINDOW);
}
