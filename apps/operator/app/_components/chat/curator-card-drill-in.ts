/**
 * curator-card-drill-in — map a curator/report card's opaque row `ref` onto the
 * attention item it should select (deterministic-status-cards-2026-07-17
 * P-003/D-004; drill-in resolver rework WI-5342). Pure + unit-testable — this
 * is the RESOLUTION half only (ref -> which live item, `selId`), unchanged by
 * WHERE the caller opens it.
 *
 * hud-consolidation-2026-07-26 P-003/P-004: the Inbox pane this used to open
 * (`?opcv=inbox` + `?opci` filter + `?opcis=<id>` selection) is retired
 * (`_retired/inbox-pane/`). The chat (OperatorChatSidebar.handleCardDrillIn)
 * now looks up the matched item's `ownerAgentId` and navigates to the HUD tab
 * instead — `/adv?tab=hud&hudsession=<ownerAgentId>` when one exists, or just
 * `/adv?tab=hud` for an ownerless ask (it still renders there, in the HUD's
 * unattributed lane — hud-consolidation P-002) or a ref with no live match.
 *
 * The curator's refs (fleet-signals.ts) and the inbox item ids (attention
 * adapters) are DIFFERENT identifier spaces:
 *   - `escalation:<msgId>`        → inbox id `coord-escalation:<msgId>`
 *   - `wi:<ref>`                  → item whose `itemRef` is `<ref>`
 *   - `plan:<slug>`              → first item on that plan
 *   - `decision:<id>` / bare id  → item whose id is `<id>`
 *   - `health:<panelId>`         → no inbox item (opens the pane only)
 *
 * WI-5342: the old pure `drillInRefToInbox` hard-coded ONLY the escalation
 * translation and returned null for every other ref, so clicking "Open ↗" on
 * any non-escalation card opened the inbox pane with NOTHING selected (and left
 * the filter on 'needs', which could also hide the item). Rather than enumerate
 * every ref→id mapping (which rots as kinds are added), we match the ref
 * against the LIVE items on their OWN identifiers — so any ref that corresponds
 * to a present inbox item selects it, current and future kinds alike.
 *
 * chat-ref-pills-2026-07-26 P-002 originally extended this same matching
 * with a SECOND destination — a chat WorkRefPill (P-003) pointing at the
 * "Working tab"'s `DetailPanel` (`apps/operator/app/adv/harnesses/
 * DetailPanel.tsx`, `?sel=<id>`) instead of the inbox pane. D-001 (owner
 * re-spec, 2026-07-26) superseded that DESTINATION: a pill click now opens a
 * POPUP (`WorkItemPopupModal`, P-008) instead of navigating tabs. P-009
 * retired that Working-tab resolver (`resolveWorkingTabDrillIn`) as dead —
 * the RESOLUTION half (ref -> which live item) still runs through this same
 * `resolveInboxDrillIn`, unchanged; only the since-removed translation onto
 * the Working tab's nuqs param + dock panel type is gone. The current
 * work-item-ref activation path is the D-002 seam: `PapercupChat`
 * (P-004) exposes a plain `onWorkRefActivate` passthrough hook with no
 * destination logic of its own, and `WorkItemPopupModal` (P-008) wires the
 * popup into that hook.
 */
import type { AttentionItem } from '@/app/admin/plans/plans-api';
import { splitQualifiedWorkItemRef, trailingWorkItemId } from '@/lib/work-item-ref';

const ESCALATION_PREFIX = 'escalation:';

/** The minimal item shape the resolver reads (a subset of AttentionItem). */
export type DrillInItem = Pick<AttentionItem, 'id' | 'itemRef' | 'planSlug'>;

export interface InboxDrillTarget {
  /** The `?opcis` selection id, or null when no inbox item matches the ref. */
  selId: string | null;
  /** The `?opci` filter to switch to so the selected row is VISIBLE ('all'),
   *  or null to leave the current filter (no selection was made). The inbox
   *  defaults to the 'needs' filter, which hides alert/activity-tier items —
   *  so a selection MUST force 'all' or the row lands on nothing. */
  filter: 'all' | null;
}

/**
 * Resolve a curator card `ref` onto the inbox selection it should open, given
 * the live attention items. Pure — `items` is passed in for testability.
 */
export function resolveInboxDrillIn(
  ref: string,
  items: readonly DrillInItem[],
): InboxDrillTarget {
  const r = ref.trim();
  if (!r) return { selId: null, filter: null };

  // The bare underlying id after a known `kind:` prefix (escalation:, wi:,
  // decision:, plan:, health:, …), or the whole ref when it carries no prefix.
  const colon = r.indexOf(':');
  const bare = colon >= 0 ? r.slice(colon + 1) : r;

  // Escalation fast-path: `escalation:<msgId>` → adapter id
  // `coord-escalation:<msgId>` (adapters.ts `coordEscalationToAttention`).
  const escalationId =
    r.startsWith(ESCALATION_PREFIX) && bare ? `coord-escalation:${bare}` : null;

  // Match on the item's OWN identifiers — conservative (no loose suffix
  // matching), so a hit is always the right item.
  const match = items.find(
    (i) =>
      i.id === r ||
      i.id === bare ||
      i.id === escalationId ||
      (i.itemRef != null && (i.itemRef === r || i.itemRef === bare)) ||
      (i.planSlug != null && r === `plan:${i.planSlug}`),
  );
  if (match) return { selId: match.id, filter: 'all' };

  // Escalation ref with no live match in the current snapshot: still target the
  // constructed id (the item is expected present; selecting a missing id is a
  // harmless no-op the pane tolerates).
  if (escalationId) return { selId: escalationId, filter: 'all' };

  // No inbox item corresponds to this ref (e.g. `health:<panelId>`) — open the
  // pane without a selection, leaving the current filter.
  return { selId: null, filter: null };
}

/* ── ref → destination (hud-open-destinations-and-true-counts-2026-07-27 P-001) ──
 *
 * `resolveInboxDrillIn` above answers "WHICH live attention item is this ref",
 * which was sufficient while every drill-in had exactly one destination (the
 * Inbox pane). That pane is retired, and its replacement (P-004: navigate to the
 * HUD tab, selecting the matched item's owning agent) covers only ONE of the
 * things a curator report row can name.
 *
 * The gap the owner hit (2026-07-27, "clicking open on one of the papercup
 * reports is supposed to open something relevant but it isn't"): a row naming a
 * WORK ITEM or a PLAN resolves to no `ownerAgentId`, so the handler pushed
 * `/adv?tab=hud` with nothing selected — and fired from the chat sidebar, which
 * is already on `/adv`, that is a visible no-op.
 *
 * The rule here is: OPEN THE MOST SPECIFIC THING THE REF NAMES.
 *   1. a work item (explicit `wi:` prefix, a bare WI-/EI-/F- id, or the matched
 *      item's own `itemRef`)  → the work item
 *   2. a plan (`plan:<slug>`, or the matched item's `planSlug`) → the plan
 *   3. otherwise, an ask from a live agent → that agent's conversation
 *   4. nothing resolvable (e.g. `health:<panelId>`) → 'none', so the CALLER can
 *      say so instead of navigating somewhere useless
 *
 * The one deliberate exception is `escalation:<msgId>`: an escalation names a
 * MESSAGE, and the actionable target of a message is the agent that sent it —
 * answering them IS the response. So an escalation with a resolvable owning
 * agent goes to the conversation first, falling back to the chain above.
 *
 * Pure — `items` is passed in, same contract as the resolvers above.
 */

/** The live-item shape {@link resolveRefDestination} reads: what
 *  {@link resolveInboxDrillIn} needs, plus the owning agent the HUD
 *  conversation destination is keyed by. */
export type RefDestinationItem = DrillInItem & { ownerAgentId?: string | null };

export type RefDestination =
  /** Open `id` in WorkItemPopupModal. `harness` is set when the REF ITSELF named
   *  one (`wi:papercusp#WI-6594`) — a work-item lookup is harness-scoped, and the
   *  ref is a stricter source than the surrounding surface's `?slug`, which is
   *  absent on every cross-harness mount. */
  | { kind: 'work-item'; id: string; harness?: string }
  /** Open `slug` in PlanPopupModal. */
  | { kind: 'plan'; slug: string }
  /** Open this agent's conversation (the HUD `?hudsession=` destination). */
  | { kind: 'session'; ownerAgentId: string }
  /** Nothing this ref names can be opened — the caller must SAY so rather than
   *  navigate somewhere that looks like a no-op. */
  | { kind: 'none' };

/** The work-item id a ref token names, read from its TRAILING segment (not a
 *  scan over prose — that is `parseWorkRefs`'s job). Case-insensitive so a
 *  `wi:wi-42` ref still resolves; normalized to uppercase, matching
 *  `parseWorkRefs`.
 *
 *  ⚠ This was an ANCHORED match on the whole token until 2026-07-28, which made
 *  it fail on every ref the curator actually emits: `curation/deps.ts` writes
 *  `wi:<harness>#<featureId>`, and `blockedWorkItemToAttention` carries the same
 *  `<harness>#<id>` string as the item's `itemRef`. Measured live on the owner's
 *  Fleet-status cards: `wi:papercusp#WI-6594` fell through the anchored test to
 *  the raw-token fallback below, so the popup opened on `papercusp#WI-6594` and
 *  rendered "No item found for papercusp#WI-6594." — with the button's own gate
 *  reporting the ref as openable. The grammar is shared with the HUD board, which
 *  shipped the identical bug; see `@/lib/work-item-ref`. */
function asWorkItemId(token: string): string | null {
  return trailingWorkItemId(token.trim());
}

export function resolveRefDestination(
  ref: string,
  items: readonly RefDestinationItem[],
): RefDestination {
  const r = ref.trim();
  if (!r) return { kind: 'none' };

  const colon = r.indexOf(':');
  const prefix = colon >= 0 ? r.slice(0, colon) : '';
  const bare = colon >= 0 ? r.slice(colon + 1) : r;

  // 1. Explicit kind prefixes from the curator's own ref vocabulary
  //    (fleet-signals.ts) — these are unambiguous, so they win outright.
  if (prefix === 'wi' && bare) {
    const q = splitQualifiedWorkItemRef(bare);
    return q.id
      ? { kind: 'work-item', id: q.id, ...(q.harness ? { harness: q.harness } : {}) }
      : { kind: 'work-item', id: bare };
  }
  if (prefix === 'plan' && bare) return { kind: 'plan', slug: bare };

  // 2. A work-item id carrying no `kind:` prefix — bare (`WI-6594`) or
  //    harness-qualified (`papercusp#WI-6594`, which `curation/deps.ts` emits
  //    for its review + progress rows).
  const bareQ = colon < 0 ? splitQualifiedWorkItemRef(r) : { harness: null, id: null };
  if (bareQ.id) {
    return { kind: 'work-item', id: bareQ.id, ...(bareQ.harness ? { harness: bareQ.harness } : {}) };
  }

  // 3. Resolve against the live items, reusing the SAME matcher the inbox
  //    destination uses — so the two can never disagree about which item a ref
  //    denotes, only about where to open it.
  const { selId } = resolveInboxDrillIn(r, items);
  const match = selId ? items.find((i) => i.id === selId) ?? null : null;

  // The escalation exception: answering the agent IS the action.
  if (prefix === 'escalation' && match?.ownerAgentId) {
    return { kind: 'session', ownerAgentId: match.ownerAgentId };
  }

  if (match) {
    const viaItemRef = match.itemRef ? splitQualifiedWorkItemRef(match.itemRef) : null;
    if (viaItemRef?.id) {
      return {
        kind: 'work-item',
        id: viaItemRef.id,
        ...(viaItemRef.harness ? { harness: viaItemRef.harness } : {}),
      };
    }
    if (match.planSlug) return { kind: 'plan', slug: match.planSlug };
    if (match.ownerAgentId) return { kind: 'session', ownerAgentId: match.ownerAgentId };
  }

  return { kind: 'none' };
}

/** A drill-in target that is CONCRETELY openable — every field the caller needs
 *  is present, so there is no way to render a button whose click then finds it
 *  cannot proceed. */
export type DrillInTarget =
  | { kind: 'work-item'; harness: string; id: string }
  | { kind: 'plan'; slug: string }
  | { kind: 'session'; ownerAgentId: string };

/** Resolving a ref against NO live items — the "steps 1+2 only" answer. */
const NO_LIVE_ITEMS: readonly RefDestinationItem[] = [];

/**
 * Does resolving this ref REQUIRE the live attention feed, or is it answerable
 * from the ref string alone?
 *
 * `resolveRefDestination` returns at step 1 (`wi:…`, `plan:…`) or step 2 (a
 * bare/qualified work-item id) WITHOUT EVER READING `items` — so for those refs
 * the feed cannot change the verdict, the rendered button, or where the click
 * lands. Only a ref that falls through to step 3 (`escalation:<msgId>`,
 * `decision:<id>`, a bare non-work-item id, `health:<panelId>`) is matched
 * against live items.
 *
 * That asymmetry is what makes the feed gateable. This predicate IS the
 * short-circuit test, run rather than re-stated: resolve against an empty item
 * list, and if the answer is already concrete, the items were never consulted.
 * Deriving it this way means it cannot drift out of sync with the resolver — a
 * new step-1/2 prefix is picked up here for free, and a re-ordering that starts
 * consulting items earlier flips this to `true` (fetch the feed) rather than
 * silently under-fetching.
 *
 * Caller: OperatorChatSidebar gates its `useInboxAttention()` on whether ANY
 * rendered card row needs the feed (no-http-anywhere-2026-07-28 P-008 / D-030 —
 * that feed measured 891 KB on every route, 68% of a route that renders no
 * attention items at all). Note `health:<panelId>` returns true here: it
 * resolves to nothing either way, but proving that needs the same step-3 pass,
 * and over-fetching for it is strictly safer than teaching this a second,
 * drift-prone copy of the resolver's ref vocabulary.
 */
export function refNeedsLiveItems(ref: string): boolean {
  return resolveRefDestination(ref, NO_LIVE_ITEMS).kind === 'none';
}

/**
 * Does any row in this report block need the live attention feed?
 * The per-message half of {@link refNeedsLiveItems}; `false` for a report with
 * no refs at all, which is the common curator card.
 */
export function reportNeedsLiveItems(
  report: { plans?: readonly { items?: readonly { ref?: string }[] }[] } | null | undefined,
): boolean {
  return (report?.plans ?? []).some((p) =>
    (p.items ?? []).some((i) => i.ref != null && i.ref !== '' && refNeedsLiveItems(i.ref)),
  );
}

/**
 * The SINGLE openable-verdict a card's Open button and its click must share:
 * null means "nothing to open", which per the owner's 2026-07-28 ruling means no
 * button at all.
 *
 * ⚠ This exists because `resolveRefDestination` alone is NOT that verdict, and
 * treating it as one shipped a button that lied. A work-item destination also
 * needs a HARNESS (the lookup is harness-scoped); the click applied that gate and
 * the button's gate did not, so on any surface without a resolvable harness the
 * button rendered and its click fell through to a bare `/adv?tab=hud` push.
 * Measured live 2026-07-28 on `wi:papercusp#WI-6594` with no `?slug` present: the
 * gate promised openable, and the click navigated to the board the sidebar was
 * ALREADY on — discarding the user's `scope`/`hudtab`/`hudwi` view state on the
 * way. `resolvedHarness` is the surrounding surface's fallback ONLY; a
 * harness-qualified ref carries its own and needs none.
 */
export function resolveDrillInTarget(
  ref: string,
  items: readonly RefDestinationItem[],
  resolvedHarness: string | null | undefined,
): DrillInTarget | null {
  const dest = resolveRefDestination(ref, items);
  switch (dest.kind) {
    case 'work-item': {
      const harness = dest.harness ?? resolvedHarness ?? null;
      return harness ? { kind: 'work-item', harness, id: dest.id } : null;
    }
    case 'plan':
      return { kind: 'plan', slug: dest.slug };
    case 'session':
      return { kind: 'session', ownerAgentId: dest.ownerAgentId };
    case 'none':
      return null;
  }
}

/**
 * @deprecated Use {@link resolveInboxDrillIn}, which matches against the live
 * items. Retained as the escalation-only string translation for any caller
 * that cannot supply the item list.
 */
export function drillInRefToInbox(ref: string): string | null {
  const r = ref.trim();
  if (r.startsWith(ESCALATION_PREFIX)) {
    const msgId = r.slice(ESCALATION_PREFIX.length);
    return msgId ? `coord-escalation:${msgId}` : null;
  }
  return null;
}

/** The minimal plan-item shape {@link resolvePlanItemDrillIn} needs — a
 *  plan-item id plus the plan it belongs to. P-NNN is unique only WITHIN a
 *  plan (every plan has its own P-006), never globally, so a bare id alone
 *  is never enough to identify one (chat-ref-pills-2026-07-26 "Known
 *  ambiguity"). */
export type PlanItemDrillItem = { id: string; planSlug: string };

export interface PlanItemDrillTarget {
  /** The admin/plans surface's own selection key — the SAME
   *  `"<planSlug>::<itemId>"` shape `PlanItemsList.tsx`'s `?item=` param
   *  already uses (reused verbatim rather than inventing a second encoding),
   *  or null when the ref can't be safely resolved: no message plan-slug
   *  context, or no live item matches within THAT specific plan. A pill
   *  with a null `sel` must render as plain text — pointing at the wrong
   *  plan's same-numbered item is worse than no pill at all. */
  sel: string | null;
}

/**
 * Resolve a bare P-NNN plan-item ref (as chat's `parseWorkRefs`, P-001,
 * reports it for `kind: 'plan-item'` — no `kind:` prefix) against the CHAT
 * MESSAGE'S OWN `plan_slug` context (chat-ref-pills-2026-07-26 P-006).
 *
 * P-NNN is unique only within a single plan, so resolving it against the
 * wrong plan (or guessing when no plan context is known at all) risks
 * linking to a DIFFERENT plan's same-numbered item — strictly worse than
 * rendering plain, non-navigating text. This function therefore requires
 * BOTH a non-empty `messagePlanSlug` AND a live item matching `ref` within
 * that exact plan before returning a `sel`; either miss returns
 * `{ sel: null }` so the caller (P-004's wiring) falls back to plain text,
 * mirroring {@link resolveInboxDrillIn}'s "no match → null" contract.
 *
 * Pure — `items` passed in for testability, same pattern as
 * {@link resolveInboxDrillIn}.
 */
export function resolvePlanItemDrillIn(
  ref: string,
  messagePlanSlug: string | null | undefined,
  items: readonly PlanItemDrillItem[],
): PlanItemDrillTarget {
  const r = ref.trim();
  if (!r || !messagePlanSlug) return { sel: null };
  const match = items.find((i) => i.planSlug === messagePlanSlug && i.id === r);
  return { sel: match ? `${messagePlanSlug}::${match.id}` : null };
}
