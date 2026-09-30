/**
 * plans:list payload-tier shapers (context-trimming-tiers-2026-07-01 P-021).
 *
 * plans:list is the fattest agent-facing directory read by 7d MCP telemetry
 * (avg 128KB/call, max 495KB): a workspace accumulates hundreds of plans and
 * the default call returns every row with full itemCounts objects + long
 * nextAction sentences. A trimmed/standard session projects each row to the
 * scan-relevant core and caps the row count — keeping the MOST-RECENTLY-UPDATED
 * rows when the caller didn't pick an explicit order (an alphabetical-head cut
 * would drop the active tail).
 *
 * Contract (D-004, no silent caps): rows keep a UNIFORM key set per tier
 * (null over absent) so TOON's tabular form applies; an over-cap list appends
 * a visible `(truncated)` notice row naming what was kept + the escape hatches
 * (narrowing args / a full-tier `tools:invoke` dispatch). `itemCounts` is flattened to scalar
 * `open`/`done` counts (an object cell would defeat TOON tabularization).
 */

export const PLANS_LIST_TIER_CAPS = {
  trimmed: { rows: 60, title: 90, next: 110 },
  standard: { rows: 150, title: 160, next: 240 },
} as const;

type ListTier = keyof typeof PLANS_LIST_TIER_CAPS;

import { clipWithMarker, payloadTierRecoveryHint } from "./shape-clip";

const RECOVER_HINT = payloadTierRecoveryHint("plans:list");

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? clipWithMarker(s, n, RECOVER_HINT) : null;

/** Item statuses an agent can still act on — everything but done/dropped. */
const CLOSED_ITEM_STATUSES = new Set(["done", "dropped"]);

function openDoneCounts(itemCounts: unknown): {
  open: number | null;
  done: number | null;
} {
  if (!itemCounts || typeof itemCounts !== "object")
    return { open: null, done: null };
  let open = 0;
  let done = 0;
  for (const [status, n] of Object.entries(
    itemCounts as Record<string, unknown>,
  )) {
    const count = typeof n === "number" ? n : 0;
    if (CLOSED_ITEM_STATUSES.has(status)) done += count;
    else open += count;
  }
  return { open, done };
}

export function shapePlansList(
  data: unknown,
  tier: ListTier,
  args?: unknown,
): unknown {
  const plans = (data as { plans?: unknown[] } | null | undefined)?.plans;
  if (!Array.isArray(plans)) return data;
  const c = PLANS_LIST_TIER_CAPS[tier];

  // Over-cap keep policy: an explicit `order` arg means the handler's head IS
  // the caller's chosen top (updated/created/slug) — keep it. Default (slug-
  // alphabetical) would cut the active tail arbitrarily, so re-rank a COPY by
  // `updated` desc before slicing: a capped directory scan wants recency.
  const explicitOrder =
    typeof (args as { order?: unknown } | null | undefined)?.order === "string";
  let ranked = plans;
  if (plans.length > c.rows && !explicitOrder) {
    ranked = [...plans].sort((a, b) =>
      String((b as { updated?: unknown })?.updated ?? "").localeCompare(
        String((a as { updated?: unknown })?.updated ?? ""),
      ),
    );
  }

  const project = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const { open, done } = openDoneCounts(r.itemCounts);
    const lifecycle =
      r.lifecycle && typeof r.lifecycle === "object"
        ? (r.lifecycle as Record<string, unknown>)
        : null;
    const contradiction =
      lifecycle?.contradiction && typeof lifecycle.contradiction === "object"
        ? (lifecycle.contradiction as Record<string, unknown>)
        : null;
    const base = {
      slug: r.slug ?? null,
      title: clip(r.title, c.title),
      status: r.status ?? null,
      lifecycleVerdict: lifecycle?.verdict ?? null,
      lifecycleDisposition: lifecycle?.disposition ?? null,
      lifecycleContradiction: clip(contradiction?.evidence, c.next),
      harness: r.harness ?? null,
      updated: r.updated ?? null,
      next: clip(r.nextAction, c.next),
      open,
      maxImportance: r.maxImportance ?? null,
      triggered: r.triggered ?? null,
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      done,
      owner: r.owner ?? null,
      initiative: r.initiative ?? null,
      template: r.template ?? null,
      startStatus: r.startStatus ?? null,
      priority: r.priority ?? null,
      scheduled: r.scheduled ?? null,
      triggerSources: r.triggerSources ?? null,
    };
  };

  const rows = ranked.slice(0, c.rows).map(project);
  if (plans.length > c.rows) {
    const kept = explicitOrder
      ? `first ${c.rows} in requested order`
      : `${c.rows} most-recently-updated`;
    rows.push({
      ...project({}),
      slug: "(truncated)",
      title: `showing ${kept} of ${plans.length} — narrow with status/updatedSince/limit/order, plans:get {slug} for detail, or ${RECOVER_HINT}`,
    });
  }
  return { ...(data as Record<string, unknown>), plans: rows };
}
