/**
 * plans:items payload-tier shapers (context-trimming-tiers-2026-07-01 P-021).
 *
 * plans:items averages 38KB/call (7d MCP telemetry): each row nests the full
 * ResolvedItem (text, rawLine, decisionRefs, unresolvedBlockers) plus a
 * coverage subtree. A trimmed/standard session flattens each row to a
 * TOON-tabular scalar record — the pick-an-item essentials — and caps rows.
 * The handler already sorts by importance, so a head slice keeps the most
 * urgent rows.
 *
 * Contract (D-004, no silent caps): uniform key set per tier (null over
 * absent); arrays are joined to comma strings (an array cell defeats TOON's
 * tabular form); an over-cap list appends a visible `(truncated)` notice row
 * with the escape hatches.
 */

import { clipWithMarker, payloadTierRecoveryHint } from "./shape-clip";

const RECOVER_HINT = payloadTierRecoveryHint("plans:items");

export const PLANS_ITEMS_TIER_CAPS = {
  trimmed: { rows: 60, text: 120, phase: 48 },
  standard: { rows: 150, text: 280, phase: 80 },
} as const;

type ItemsTier = keyof typeof PLANS_ITEMS_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? clipWithMarker(s, n, RECOVER_HINT) : null;

/** True when `clip(s, n)` actually cut `s` short. EI-18762253154342502: the
 *  result-door's own `detectInnerTruncationMarkers` scans a spilled result's
 *  serialized JSON for a literal `"<field>_truncated": true` key — the SAME
 *  convention `work_items:get`'s `summary_truncated` and `coord:inbox`'s
 *  `body_truncated` already use. Before this fix, `clip()` silently dropped
 *  text with a bare "…" and no marker, so a plans:items row that got clipped
 *  to fit the trimmed/standard tier was indistinguishable — to the door — from
 *  a row that was never truncated at all, and an over-door spill of such a
 *  result printed the unconditional (and false) "FULL tool result" banner.
 *  Stamping `text_truncated` closes that gap for THIS tool; the door's default
 *  banner was also made honest for every tool that doesn't (yet) stamp one. */
const wasClipped = (s: unknown, n: number): boolean => typeof s === "string" && s.length > n;

const joined = (v: unknown): string | null =>
  Array.isArray(v) && v.length > 0 ? v.map(String).join(",") : null;

export function shapePlansItems(data: unknown, tier: ItemsTier): unknown {
  const items = (data as { items?: unknown[] } | null | undefined)?.items;
  if (!Array.isArray(items)) return data;
  const c = PLANS_ITEMS_TIER_CAPS[tier];
  const rawDiagnostics = (data as { specTriadDiagnostics?: unknown })?.specTriadDiagnostics;
  const specTriadDiagnostics = Array.isArray(rawDiagnostics)
    ? rawDiagnostics.map((diagnostic) => {
        const d = (diagnostic ?? {}) as Record<string, unknown>;
        return {
          plan: d.plan ?? null,
          missing: joined(d.missing),
          scopeReason: d.scopeReason ?? null,
          note: clip(d.note, c.text),
        };
      })
    : undefined;

  const project = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const item = (r.item ?? {}) as Record<string, unknown>;
    const coverage = r.coverage as
      | {
          level?: unknown;
          workers?: unknown;
          holder?: { goalText?: unknown; goalUnknown?: unknown; stale?: unknown } | null;
        }
      | null
      | undefined;
    const unresolved = Array.isArray(item.unresolvedBlockers)
      ? item.unresolvedBlockers.length
      : 0;
    const issueBlocks = Array.isArray(r.blockedByIssues)
      ? r.blockedByIssues.length
      : 0;
    const base = {
      plan: r.plan ?? null,
      id: item.id ?? null,
      status: item.effectiveStatus ?? null,
      importance: item.importance ?? null,
      needsHuman: item.needsHuman === true,
      text: clip(item.text, c.text),
      // Deliberately snake_case (not the file's usual camelCase): must literally match
      // `<field>_truncated` for the result-door's detector regex to recognize it (see wasClipped doc).
      text_truncated: wasClipped(item.text, c.text),
      phase: clip(item.phase, c.phase),
      /** Count of live blockers (unresolved P-refs + open issue-blocks). */
      blockers: unresolved + issueBlocks,
      /** Coverage level ("is anyone LIVE on this") — complete/full/partial/
       *  held-stalled/held-not-live/unclaimed/none. It is LIVENESS-aware, so it
       *  disagrees with the work-item ledger's `assignee` column by design: an
       *  assignee outlives its holder, `working` does not. `held-stalled` means
       *  the holder is live but has no item-scoped progress signal — coordinate,
       *  do not reclaim. `held-not-live` is the dead/unknown-holder case and is
       *  the only reclaimable band. Don't read a disagreement as one surface
       *  lagging the other. */
      working: typeof coverage?.level === "string" ? coverage.level : null,
      /** EI-18679411140143743: linked work is DONE but this item's own status
       *  isn't — a silent burn-down divergence a leader must not miss even in
       *  a trimmed/standard read. */
      diverged: r.coverageDivergence === true,
      /** okf-frontmatter-adoption H(b): the spec-triad legs this item's PLAN
       *  still owes, comma-joined — the reason it is absent from an
       *  `actionable` query. Carried in EVERY tier on purpose: without it a
       *  trimmed reader sees an item vanish from `actionable` with no visible
       *  cause, which is exactly the shape of a silent freeze. Null for every
       *  plan predating the requirement, i.e. almost always. */
      specTriadMissing: joined(r.specTriadMissing),
      /** EI-22173576329267385: count of WI-/EI- refs cited in this item's text
       *  whose CURRENT state is terminal (done/dropped/...) — a work-item's
       *  title is frozen at report time and never rewritten on closure, so a
       *  nonzero count here means re-check the cited ref(s) before trusting
       *  this item's premise as live. Carried in EVERY tier (cheap scalar,
       *  same rationale as `specTriadMissing`); the full ref/state detail is
       *  standard-tier-and-up (`citedWorkItems` below). Never itself a
       *  verdict — the load-bearing-vs-background judgment stays a reading
       *  task for the picking agent. 0 when no refs are cited or none
       *  resolved. */
      citedTerminalRefs: Array.isArray(r.citedWorkItems)
        ? (r.citedWorkItems as Array<{ terminal?: unknown }>).filter(
            (c) => c.terminal === true,
          ).length
        : 0,
    };
    if (tier === "trimmed") return base;
    const holder = coverage?.holder ?? null;
    return {
      ...base,
      blockedBy: joined(item.blockedBy),
      blockedByIssues: joined(r.blockedByIssues),
      workers: joined(coverage?.workers),
      /** EI-22173576329267385: `ref:state` pairs for every cited WI-/EI- ref
       *  that resolved (an unresolved/typo'd ref is omitted here but still
       *  counts toward nothing — `citedTerminalRefs` above is authoritative
       *  for "should I re-check something"). Null when no refs cited or none
       *  resolved. */
      citedWorkItems: Array.isArray(r.citedWorkItems) && r.citedWorkItems.length > 0
        ? (r.citedWorkItems as Array<{ ref?: unknown; state?: unknown }>)
            .map((c) => `${String(c.ref)}:${c.state == null ? "unknown" : String(c.state)}`)
            .join(",")
        : null,
      /** P-029/D-060: WHY the holder took it — the whole point of the item is
       *  that a reader should not have to attempt a claim to learn this. Clipped
       *  like `text`, since a flattened tier is a scalar table; the unclipped goal
       *  plus `declaredAt`/`ownerLabel` ride the full tier's `coverage.holder`.
       *  Null here is HONEST (nothing declared / auto-claimed), never invented. */
      holderGoal: clip(holder?.goalText, c.text),
      /** Null (not false) when activity is unknown — an unreadable activity stamp
       *  must not read as "fresh" (the same 3-valued rule as the full tier). */
      holderStale: typeof holder?.stale === "boolean" ? holder.stale : null,
      archived: r.archived === true,
    };
  };

  const rows = items.slice(0, c.rows).map(project);
  if (items.length > c.rows) {
    rows.push({
      ...project({}),
      plan: "(truncated)",
      text: `showing top ${c.rows} of ${items.length} by importance — narrow with status/actionable/slug, plans:get-item for detail, or ${RECOVER_HINT}`,
    });
  }
  return {
    ...(data as Record<string, unknown>),
    items: rows,
    ...(specTriadDiagnostics !== undefined ? { specTriadDiagnostics } : {}),
  };
}
