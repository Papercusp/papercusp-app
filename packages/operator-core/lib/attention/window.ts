/**
 * Bounded, deterministic windows for the `plans:attention` read.
 *
 * The attention reader deliberately builds one canonical feed and caches that
 * feed.  This module is the cheap presentation step that turns the feed into a
 * page for a UI caller.  Keeping it pure is important: page boundaries must be
 * reproducible for the same snapshot, regardless of which of the independent
 * source legs completed first.
 */

import {
  importanceRank,
  type AttentionItem,
  type AttentionTier,
} from './types';
import type { AttentionGroup } from './group';

/** The default UI page is comfortably below the 250 KB wire budget. */
export const DEFAULT_ATTENTION_PAGE_SIZE = 100;
/** A caller may request a larger page, but never an unbounded accidental one. */
export const MAX_ATTENTION_PAGE_SIZE = 500;
/** Upper bound for an offset supplied by an untrusted UI/client. */
export const MAX_ATTENTION_OFFSET = 1_000_000;

/** Metadata carried on the first attention group as `_meta`. */
export interface AttentionWindowMeta {
  /** Number of distinct attention items in the complete filtered feed. */
  total: number;
  /** Alias used by list/read callers that name totals explicitly. */
  totalCount: number;
  /** Zero-based item offset represented by this page. */
  offset: number;
  /** Requested page size; null means the full/unbounded escape hatch. */
  limit: number | null;
  /** Number of distinct items represented by this page. */
  returned: number;
  /** True when another page can be requested. */
  hasMore: boolean;
  /** Offset to pass for the next page, or null when exhausted. */
  nextOffset: number | null;
}

export interface AttentionWindowResult {
  groups: AttentionGroup[];
  meta: AttentionWindowMeta;
}

type GroupEntry = {
  item: AttentionItem;
  group: AttentionGroup;
  groupIndex: number;
  itemIndex: number;
};

const TIER_RANK: Record<AttentionTier, number> = {
  decision: 0,
  handled: 1,
  alert: 2,
  activity: 3,
};

function tierRank(value: unknown): number {
  return typeof value === 'string' && value in TIER_RANK
    ? TIER_RANK[value as AttentionTier]
    : TIER_RANK.activity;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compare attention rows in the order a human should encounter them:
 * decisions first, then importance, then newest activity.  Every tie has a
 * stable textual key, so source completion order cannot reshuffle a page.
 */
export function compareAttentionEntries(a: GroupEntry, b: GroupEntry): number {
  return (
    tierRank(a.item.tier) - tierRank(b.item.tier) ||
    importanceRank(a.item.importance) - importanceRank(b.item.importance) ||
    compareTimestampDesc(a.item.occurredAt, b.item.occurredAt) ||
    a.item.id.localeCompare(b.item.id) ||
    a.group.key.localeCompare(b.group.key) ||
    a.groupIndex - b.groupIndex ||
    a.itemIndex - b.itemIndex
  );
}

function compareTimestampDesc(a: unknown, b: unknown): number {
  const at = timestamp(a);
  const bt = timestamp(b);
  if (at !== null && bt !== null) return bt - at;
  // Unknown dates sort after dated rows in both directions.  This avoids
  // inventing recency for rows whose source has no timestamp.
  if (at !== bt) return at === null ? 1 : -1;
  return 0;
}

function asAttentionItem(value: unknown): AttentionItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<AttentionItem>;
  return typeof item.id === 'string' && item.id.length > 0
    ? (item as AttentionItem)
    : null;
}

/**
 * Build a bounded page from grouped attention rows.
 *
 * Rows are de-duplicated by id before counting and slicing.  A non-plan row can
 * legitimately be emitted in more than one synthetic group; counting those
 * copies would make `hasMore` and the visible count disagree with the UI's own
 * dedupe rule.  The first group after the deterministic sort owns a duplicate
 * in the returned page.
 */
export function paginateAttentionGroups(
  groups: readonly AttentionGroup[],
  options: { limit?: number | null; offset?: number } = {},
): AttentionWindowResult {
  const entries: GroupEntry[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]!;
    for (let itemIndex = 0; itemIndex < group.items.length; itemIndex += 1) {
      const item = asAttentionItem(group.items[itemIndex]);
      if (!item) continue;
      entries.push({ item, group, groupIndex, itemIndex });
    }
  }

  entries.sort(compareAttentionEntries);
  const unique: GroupEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.item.id)) continue;
    seen.add(entry.item.id);
    unique.push(entry);
  }

  const rawOffset = options.offset ?? 0;
  const offset = Math.min(
    MAX_ATTENTION_OFFSET,
    Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0),
  );
  const rawLimit = options.limit;
  const limit =
    rawLimit == null
      ? null
      : Math.min(
          MAX_ATTENTION_PAGE_SIZE,
          Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_ATTENTION_PAGE_SIZE),
        );
  const page = limit == null ? unique.slice(offset) : unique.slice(offset, offset + limit);
  const hasMore = offset + page.length < unique.length;
  const meta: AttentionWindowMeta = {
    total: unique.length,
    totalCount: unique.length,
    offset,
    limit,
    returned: page.length,
    hasMore,
    nextOffset: hasMore ? offset + page.length : null,
  };

  // Keep the original group metadata, but only include rows selected for this
  // page.  Group order follows the first selected row's global priority and is
  // deterministic even when a page starts in the middle of a group.
  const selectedByGroup = new Map<string, AttentionItem[]>();
  const firstByGroup = new Map<string, GroupEntry>();
  for (const entry of page) {
    const key = entry.group.key;
    const rows = selectedByGroup.get(key) ?? [];
    rows.push(entry.item);
    selectedByGroup.set(key, rows);
    if (!firstByGroup.has(key)) firstByGroup.set(key, entry);
  }

  const selectedGroups = [...selectedByGroup.entries()]
    .map(([key, items]) => {
      const original = groups.find((group) => group.key === key);
      return original ? { group: original, items, first: firstByGroup.get(key)! } : null;
    })
    .filter((value): value is { group: AttentionGroup; items: AttentionItem[]; first: GroupEntry } => value !== null)
    .sort((a, b) => compareAttentionEntries(a.first, b.first))
    .map(({ group, items }) => ({ ...group, items }));

  return { groups: selectedGroups, meta };
}
