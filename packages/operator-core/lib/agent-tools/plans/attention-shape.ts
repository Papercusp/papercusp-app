/**
 * plans:attention payload-tier shapers (context-trimming-tiers-2026-07-01 P-021).
 *
 * plans:attention is the single fattest tool payload measured (7d MCP
 * telemetry: avg 1.09MB/call, max 1.23MB): every AttentionItem carries a full
 * body, actions[], triage + authorization fields — the Planning-tab UI needs
 * all of it, an agent scanning "what needs a human" does not. A trimmed/
 * standard session gets GROUP SUMMARIES (per-group counts, no item bodies)
 * plus the TOP-N items across all groups (decisions first, then importance),
 * each projected to a one-line scalar row.
 *
 * Contract (D-004, no silent caps): `itemsTotal` + a `hint` name what was
 * collapsed and the escape hatch (a full-tier `tools:invoke` dispatch); rows keep uniform keys
 * for TOON. The UI reads this tool via the HTTP/sync path (no ctx_tier →
 * full), so its grouped shape is untouched.
 */

export const ATTENTION_TIER_CAPS = {
  trimmed: { top: 15, title: 110, groupTitle: 80 },
  standard: { top: 40, title: 200, groupTitle: 120 },
} as const;

type AttentionTierName = keyof typeof ATTENTION_TIER_CAPS;

import { clipWithMarker, payloadTierRecoveryHint } from "./shape-clip";

const RECOVER_HINT = payloadTierRecoveryHint("plans:attention");

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? clipWithMarker(s, n, RECOVER_HINT) : null;

/** Most → least urgent; unknown ranks as 'normal'. */
const IMPORTANCE_ORDER = ["urgent", "high", "normal", "low"] as const;
const impRank = (v: unknown): number => {
  const i = IMPORTANCE_ORDER.indexOf(v as (typeof IMPORTANCE_ORDER)[number]);
  return i === -1 ? IMPORTANCE_ORDER.indexOf("normal") : i;
};

type Item = Record<string, unknown>;
type Group = { key?: unknown; items?: unknown };

export function shapePlansAttention(
  data: unknown,
  tier: AttentionTierName,
): unknown {
  const d = data as
    | { groups?: unknown[]; tierCounts?: unknown }
    | null
    | undefined;
  if (!d || !Array.isArray(d.groups)) return data;
  const c = ATTENTION_TIER_CAPS[tier];

  const groupRows: Record<string, unknown>[] = [];
  const all: Array<{ item: Item; group: string }> = [];
  for (const g of d.groups as Group[]) {
    const go = (g ?? {}) as Record<string, unknown>;
    const items = Array.isArray(go.items) ? (go.items as Item[]) : [];
    const decisions = items.filter((it) => it?.tier === "decision").length;
    groupRows.push({
      key: go.key ?? null,
      title: clip(go.title, c.groupTitle),
      maxImportance: go.maxImportance ?? null,
      itemCount: items.length,
      decisions,
      ...(tier === "standard"
        ? {
            kind: go.kind ?? null,
            planSlug: go.planSlug ?? null,
            harnessSlug: go.harnessSlug ?? null,
          }
        : {}),
    });
    for (const it of items) all.push({ item: it, group: String(go.key ?? "") });
  }

  // Decisions (awaiting a human) outrank everything, then importance; stable
  // sort keeps each group's own ordering as the tie-break.
  const sorted = [...all].sort(
    (a, b) =>
      Number(a.item?.tier !== "decision") - Number(b.item?.tier !== "decision") ||
      impRank(a.item?.importance) - impRank(b.item?.importance),
  );
  const top = sorted.slice(0, c.top).map(({ item, group }) => ({
    id: item.id ?? null,
    kind: item.kind ?? null,
    group,
    importance: item.importance ?? null,
    tier: item.tier ?? null,
    status: item.status ?? null,
    title: clip(item.title, c.title),
    ...(tier === "standard"
      ? { needsHuman: item.needsHuman === true, itemRef: item.itemRef ?? null }
      : {}),
  }));

  return {
    tierCounts: d.tierCounts ?? null,
    itemsTotal: all.length,
    groups: groupRows,
    top,
    hint: `group counts + top ${top.length} of ${all.length} items (decisions first) — ${RECOVER_HINT} for bodies/actions, or act via each item id`,
  };
}
