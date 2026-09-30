/**
 * Pure owner-gate marker extraction shared by plan writes and claim guards.
 *
 * Plan content is canonical, so the marker is derived once while a plan is
 * written and persisted on each normalized plan-item row.  The scheduler can
 * then use that indexed value without re-parsing prose for every candidate;
 * the functions here remain the semantic source for both paths.
 */

/**
 * Deliberately small and explicit.  Adding a phrase changes claimability and
 * is a scheduler/product decision, not an incidental parser tweak.
 */
export const OWNER_GATE_MARKERS = [
  'owner-gated',
  'hard-deferred',
  'never auto-flip',
  'needs a coordinated window',
  'owner-attended session',
] as const;

/** An item-shaped input keeps this helper independent of parser/index types. */
export interface OwnerGateItemLike {
  id: string;
  text: string | null | undefined;
}

/** A decision-shaped input keeps this helper independent of plan row types. */
export interface OwnerGateDecisionLike {
  itemRefs: readonly string[];
  title: string | null | undefined;
  body: string | null | undefined;
}

/**
 * EI-19968471075842609: a NEGATED mention must not read as the marker.
 * Deliberately narrow: only an immediately preceding negation is rejected;
 * later occurrences are still scanned.
 */
const NEGATED_MARKER_PREFIX = /(?:\bnon[-\s]?|\bnot\s+)$/;

/**
 * A marker carrying an explicit parenthesised item-id attribution predicates
 * over those items and no others.
 */
const MARKER_ITEM_ATTRIBUTION = /^[\s*_:—–-]*\(\s*(p-\d{3,}(?:\s*[,;·&+/]\s*p-\d{3,})*)\s*\)/;

function markerAttributionIds(afterMarker: string): string[] | null {
  const match = MARKER_ITEM_ATTRIBUTION.exec(afterMarker);
  if (!match) return null;
  const ids = match[1]
    .split(/[,;·&+/\s]+/)
    .filter(Boolean)
    .map((id) => id.toUpperCase());
  return ids.length > 0 ? ids : null;
}

/** Find a marker in targeted plan metadata (Now/Decision text). */
export function findOwnerGateMarker(text: string | null | undefined, itemId?: string | null): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const marker of OWNER_GATE_MARKERS) {
    for (let at = lower.indexOf(marker); at !== -1; at = lower.indexOf(marker, at + 1)) {
      if (NEGATED_MARKER_PREFIX.test(lower.slice(0, at))) continue;
      if (itemId) {
        const attributed = markerAttributionIds(lower.slice(at + marker.length));
        if (attributed && !attributed.includes(itemId.toUpperCase())) continue;
      }
      return marker;
    }
  }
  return null;
}

/** Escape an item id for a token-boundary regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Item text is open-ended feature prose.  Only a marker used as a leading
 * label/parenthesised clause is authoritative in the item's own text.
 */
export function findAnchoredOwnerGateMarker(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  for (const marker of OWNER_GATE_MARKERS) {
    // Keep the opening delimiters and closing delimiters as separate escaped
    // alternatives. The former `[([])` shape looked plausible but leaves the
    // generated expression unbalanced (`Unmatched ')'`) before it can inspect
    // any item text.
    const anchored = new RegExp(`(?:^|\\(|\\[)\\s*${escapeRegExp(marker)}\\s*(?::|\\)|\\])`, 'i');
    if (anchored.test(trimmed)) return marker;
  }
  return null;
}

function itemMentioned(text: string | null | undefined, itemId: string): boolean {
  if (!text) return false;
  return new RegExp(`\\b${escapeRegExp(itemId)}\\b`).test(text);
}

/** Split Now text into line/sentence units without cutting code-like prose. */
function markerScopeSegments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const segment = sentence.trim();
      if (segment) out.push(segment);
    }
  }
  return out;
}

/** Find a marker in a Now block only when its item attribution is unambiguous. */
export function findNowOwnerGateMarker(
  nowText: string | null | undefined,
  itemId: string,
  allItemIds: readonly string[],
): string | null {
  if (!nowText || !itemMentioned(nowText, itemId)) return null;
  for (const segment of markerScopeSegments(nowText)) {
    if (!itemMentioned(segment, itemId)) continue;
    const marker = findOwnerGateMarker(segment, itemId);
    if (marker) return marker;
  }
  const mentionsAnotherItem = allItemIds.some((id) => id !== itemId && itemMentioned(nowText, id));
  return mentionsAnotherItem ? null : findOwnerGateMarker(nowText, itemId);
}

/**
 * Derive the one persisted marker for one plan item.  Precedence mirrors the
 * post-claim guard: item label, item-scoped Now text, then item-scoped decision.
 */
export function deriveOwnerGateMarkerForItem(
  item: OwnerGateItemLike,
  nowText: string | null | undefined,
  allItemIds: readonly string[],
  decisions: readonly OwnerGateDecisionLike[],
): string | null {
  const ownMarker = findAnchoredOwnerGateMarker(item.text);
  const nowMarker = findNowOwnerGateMarker(nowText, item.id, allItemIds);
  const decisionMarker = decisions
    .filter((decision) => decision.itemRefs.includes(item.id))
    .map((decision) => findOwnerGateMarker(decision.title, item.id) ?? findOwnerGateMarker(decision.body, item.id))
    .find((marker): marker is string => Boolean(marker));
  return ownMarker ?? nowMarker ?? decisionMarker ?? null;
}

/** Derive all item markers once for a canonical parsed plan. */
export function deriveOwnerGateMarkers(
  items: readonly OwnerGateItemLike[],
  nowText: string | null | undefined,
  decisions: readonly OwnerGateDecisionLike[],
): Map<string, string | null> {
  const allItemIds = items.map((item) => item.id);
  return new Map(
    items.map((item) => [item.id, deriveOwnerGateMarkerForItem(item, nowText, allItemIds, decisions)]),
  );
}
