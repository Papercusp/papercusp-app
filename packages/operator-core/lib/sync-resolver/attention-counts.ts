/**
 * Attention COUNTS — the aggregate behind the always-mounted inbox badges,
 * without shipping the feed those badges are counting (WI-5955).
 *
 * THE PROBLEM. `useInboxPendingCount` (the sidebar "needs you" badge) and
 * `usePlansNeedingYouCount` (the Plans-face badge) are mounted on every app
 * start, and both derived their number by pulling the WHOLE unscoped
 * `plans.attention` feed — ~1MB after the P-003 projection — to compute two
 * integers. A session that never opens the Inbox paid the entire feed for a
 * badge; a session that did opened a SECOND, harness-scoped copy alongside it.
 *
 * WHY NOT THE OBVIOUS FIXES. Two smaller-looking options are both wrong:
 *   - "have the badge read the scoped feed the panels already fetch" —
 *     undercounts. The badge answers "how many decisions need you" across the
 *     WORKSPACE; a harness-scoped feed silently drops the rest.
 *   - "have the panels client-filter the unscoped feed" — measured and
 *     refuted (plan slim-plans-attention-sync-payload-2026-07-26 D-001).
 *     `harnessSlug` is pushed down into ~10 sources as a server-side query
 *     arg, so the filtered-away rows never carry the field that filtered them.
 * So the feed cannot be shared. What CAN be shared is the cheap aggregate.
 *
 * DRIFT IS THE REAL RISK HERE, NOT BYTES. The badge and the pane's own chips
 * were deliberately derived from ONE client-side list so they could never
 * disagree (the comment in use-inbox-pending.ts says exactly that). Moving the
 * count server-side reintroduces the chance they diverge, so:
 *   - the derivation below is a faithful mirror of the client's, INCLUDING the
 *     dedupe-by-id and the `effectiveTier` wire-lag fallback, and
 *   - `attention-counts-parity.test.ts` (apps/operator) pins the two against a
 *     shared case table, so a change to one that is not made to the other reds.
 * Counting here rather than from the tool's own `tierCounts` is deliberate for
 * the same reason: `tierCounts` is computed pre-grouping over an internal list,
 * whereas the client counts the GROUPS it renders. Counting what the client
 * counts is what makes the parity test meaningful.
 *
 * The canonical attention read derives these projections inside its existing
 * cache build. Compact callers avoid serializing and parsing the full feed.
 */

/** The attention tiers, as the client's `AttentionTier` union. */
export type AttentionTierName = 'decision' | 'alert' | 'activity' | 'handled';

interface AttentionItemish {
  id?: unknown;
  tier?: unknown;
  kind?: unknown;
  needsHuman?: unknown;
  planSlug?: unknown;
}

interface AttentionGroupish {
  items?: unknown;
}

export interface AttentionCounts {
  /** Decision-tier items — the "needs you" badge. */
  decisionItems: number;
  /** DISTINCT plans with >=1 decision-tier item — the Plans-face badge. */
  decisionPlans: number;
  /** Alert-tier items (the alerts affordance reads this). */
  alerts: number;
  /** Total distinct items in the feed — lets a consumer tell "empty feed" from
   *  "feed loaded, nothing needs you", which a bare zero cannot. */
  total: number;
}

/**
 * The sync dispatcher has a 10s outer resolver deadline, while the shared
 * `plans:attention` cached read deliberately allows a 45s cold build before
 * degrading. The always-mounted badge must choose a graceful value before the
 * outer deadline can turn that slow-but-recoverable read into HTTP 500.
 */
export const ATTENTION_COUNTS_FALLBACK_MS = 8_000;

const DEADLINE = Symbol('attention-counts-deadline');

export interface DeadlineOutcome<T> {
  /** The real result, or the graceful fallback when the deadline fired. */
  value: T;
  /**
   * TRUE when `value` is the FALLBACK rather than a real answer.
   *
   * This is returned rather than kept private on purpose. The previous
   * signature resolved to a bare `T`, which made a timed-out result
   * BYTE-IDENTICAL to a real one at every call site — so the caller could not
   * disclose the degradation even if it wanted to, and the graceful value got
   * rendered as fact. That is what happened to the attention badge: a fired
   * deadline yields empty groups, empty groups derive to all-zeros, and the
   * user was shown a confident "0 decisions need you" that was really "we
   * never found out". Returning the flag makes ignoring it a visible choice.
   */
  degraded: boolean;
}

/**
 * Resolve an attention-derived read with a caller-facing deadline. The
 * underlying operation is intentionally not cancelled: cachedRead's
 * single-flight build can finish and warm the next caller. A real rejection
 * remains an error; only the deadline takes the supplied graceful fallback.
 */
export async function withDeadlineFallback<T>(
  operation: Promise<T>,
  deadlineMs: number,
  fallback: () => T | Promise<T>,
): Promise<DeadlineOutcome<T>> {
  operation.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
  try {
    const result = await Promise.race([operation, timeout]);
    return result === DEADLINE
      ? { value: await fallback(), degraded: true }
      : { value: result as T, degraded: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The tier of an attention item, with the wire-lag fallback.
 *
 * MUST stay identical to `effectiveTier` in
 * apps/operator/app/_components/inbox/use-inbox-pending.ts — a row served by a
 * pre-tier server arrives without `tier`, and both sides infer it the same way.
 */
export function effectiveAttentionTier(item: AttentionItemish): AttentionTierName {
  const tier = item.tier;
  if (typeof tier === 'string' && tier) return tier as AttentionTierName;
  if (item.needsHuman === true) return 'decision';
  if (item.kind === 'smoke-fail' || item.kind === 'coord-escalation') return 'alert';
  return 'activity';
}

/**
 * Derive the badge counts from the attention groups.
 *
 * Dedupes by `id` first: an item that is not plan-scoped (an owner-wall, a
 * loop carry-note, a workspace alert) is emitted into MULTIPLE plan groups, so
 * a bare flatMap counts it 2-5 times — the same duplication WI-5337 fixed
 * client-side. Counting without the dedupe makes the badge disagree with the
 * list the user then opens.
 */
export function deriveAttentionCounts(groups: readonly unknown[]): AttentionCounts {
  const seen = new Set<string>();
  const decisionPlans = new Set<string>();
  let decisionItems = 0;
  let alerts = 0;

  for (const group of groups) {
    const items = (group as AttentionGroupish | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as AttentionItemish;
      const id = typeof item.id === 'string' ? item.id : null;
      // An id-less row cannot be deduped; skip it rather than over-count.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const tier = effectiveAttentionTier(item);
      if (tier === 'decision') {
        decisionItems += 1;
        if (typeof item.planSlug === 'string' && item.planSlug) decisionPlans.add(item.planSlug);
      } else if (tier === 'alert') {
        alerts += 1;
      }
    }
  }

  return { decisionItems, decisionPlans: decisionPlans.size, alerts, total: seen.size };
}

/**
 * The WIRE row for `plans.attentionCounts` — the counts plus the honesty bit.
 *
 * `degraded` is NOT part of `AttentionCounts` on purpose: `AttentionCounts` is
 * the DERIVATION, and attention-counts-parity.test.ts pins it field-for-field
 * against the client's own derivation so the badge can never disagree with the
 * list. A transport concern added there would either break that equality or,
 * worse, have to be papered over in the parity test — weakening the guard that
 * matters. The marker rides one level up, where the transport lives.
 */
export interface AttentionCountsRow extends AttentionCounts {
  /**
   * TRUE when these counts are the deadline FALLBACK rather than a real answer
   * — "we never found out", not "nothing needs you".
   *
   * The badge is always mounted, so the zero it renders is the most-read number
   * in the app. Without this bit a fired deadline is byte-identical to a real
   * empty inbox, and the user is told, confidently, that nothing needs them.
   */
  degraded: boolean;
}

/**
 * Compose the wire row from a deadline outcome.
 *
 * This exists as a named function rather than a spread at the call site so the
 * "graceful empty must be MARKED" property has one seam to pin a test to. The
 * bug it guards against is not hypothetical: the resolver previously dropped
 * the outcome wrapper entirely, which both lost the marker AND read `.groups`
 * off the wrapper — deriving all-zeros on EVERY call, degraded or not.
 */
export function attentionCountsRowFromOutcome(
  outcome: DeadlineOutcome<{ groups?: unknown[]; counts?: AttentionCounts; degraded?: boolean } | null | undefined>,
): AttentionCountsRow {
  const groups = outcome.value?.groups;
  return {
    ...(outcome.value?.counts ?? deriveAttentionCounts(Array.isArray(groups) ? groups : [])),
    degraded: outcome.degraded || outcome.value?.degraded === true,
  };
}

/* ── attention REFS — the drill-in projection (no-http-anywhere-2026-07-28 D-031) ──
 *
 * The second consumer that pulls the whole feed for a sliver of it. The chat
 * sidebar is mounted by ChromeShell on every non-chromeless route, and it holds
 * the feed for ONE purpose: resolving a curator card row's `ref` to something
 * openable. That resolver (`curator-card-drill-in.ts`) reads exactly FOUR fields
 * per item — `id`, `itemRef`, `planSlug`, `ownerAgentId` — out of a ~1,100-item
 * feed measured at 1,461 KB on :3055 / 891 KB on :3270.
 *
 * WHY THIS SHAPE AND NOT A SMALLER ONE. The obvious smaller design is to send
 * the chat's ref list up and return only matching rows (~700x smaller). It was
 * REJECTED in D-031: it forks the ref-MATCHING logic into a server-side second
 * copy, and this subsystem has already been bitten twice by exactly that
 * (the badge/pane divergence this file's counts guard against, and
 * slim-plans-attention D-001, where pushing `harnessSlug` down as a query arg
 * silently dropped ~677 items). Projecting the ROW while leaving the single
 * matcher client-side has no such failure mode: the client still matches over
 * every item it would have matched over, on the same identifiers.
 *
 * So the only thing that can drift here is the FIELD SET — if the resolver
 * starts reading a fifth field, this projection must grow with it.
 * `attention-refs-parity.test.ts` pins that: it fails if `RefDestinationItem`
 * gains a field this projection does not carry.
 *
 * Null-valued keys are omitted, matching the list feed's own wire convention
 * (D-025) — most items carry no `itemRef`, so this is most of the remaining
 * bytes.
 */

/** One attention item, projected to just what a ref drill-in resolves against.
 *  Mirrors the client's `RefDestinationItem` (curator-card-drill-in.ts). */
export interface AttentionRefRow {
  id: string;
  itemRef?: string;
  planSlug?: string;
  ownerAgentId?: string;
}

interface AttentionRefItemish extends AttentionItemish {
  itemRef?: unknown;
  ownerAgentId?: unknown;
}

/**
 * Project the attention groups down to the drill-in ref rows.
 *
 * Dedupes by `id` with the SAME rule {@link deriveAttentionCounts} uses (and
 * for the same reason — a non-plan-scoped item is emitted into several groups,
 * WI-5337), so the two derivations cannot disagree about which items exist.
 */
export function deriveAttentionRefs(groups: readonly unknown[]): AttentionRefRow[] {
  const seen = new Set<string>();
  const rows: AttentionRefRow[] = [];

  for (const group of groups) {
    const items = (group as AttentionGroupish | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as AttentionRefItemish;
      const id = typeof item.id === 'string' ? item.id : null;
      // An id-less row can be neither deduped NOR matched (every branch of the
      // client resolver keys off id/itemRef/planSlug against a real item), so
      // dropping it here costs nothing and keeps the dedupe honest.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row: AttentionRefRow = { id };
      if (typeof item.itemRef === 'string' && item.itemRef) row.itemRef = item.itemRef;
      if (typeof item.planSlug === 'string' && item.planSlug) row.planSlug = item.planSlug;
      if (typeof item.ownerAgentId === 'string' && item.ownerAgentId) {
        row.ownerAgentId = item.ownerAgentId;
      }
      rows.push(row);
    }
  }

  return rows;
}
