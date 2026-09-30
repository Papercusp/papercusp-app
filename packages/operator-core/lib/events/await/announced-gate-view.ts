/**
 * THE ANNOUNCED-GATE DIRECTORY READ — one store, one visibility predicate,
 * two sinks (plan item P-027; scope narrowed by decision D-063).
 *
 * WHAT THIS IS AND IS NOT.
 *
 * P-027's item text says the announced-gate panel is "SEPARATELY re-derived"
 * on turn-start and on the leader brief, and asks for the two to be collapsed
 * into one payload. Measured before writing this (D-063), that framing is too
 * strong in one direction and too weak in another:
 *
 *  - TOO STRONG: there was never a second copy of the gate KEYS. Both sinks
 *    already read `listActiveAnnouncements` and filter with
 *    `announcementVisibleTo`, exactly as `coord:orient` / `events:catalog` do.
 *    Collapsing the two PAYLOADS would have deleted information — the leader
 *    cockpit deliberately includes FIRED latches (`unfiredOnly: false`) that a
 *    per-turn block must not carry, because an always-present row is the
 *    signal-decay failure P-017/D-003 already ruled against.
 *
 *  - TOO WEAK: what genuinely duplicated was the GLUE — "read the store, then
 *    apply the visibility predicate with this reader's scope". Two hand-written
 *    copies of that pairing can diverge silently, and the divergence would be
 *    invisible: each sink would keep rendering a plausible gate list, just a
 *    differently-scoped one. That is what this module removes.
 *
 * So the shared thing is the READ + SCOPE contract. The ENRICHMENT stays with
 * each sink, because the two answer different questions:
 *
 *   turn-start   "which OPEN gates can I await right now, and is any of them
 *                 announced by an owner who is already gone?"
 *                 -> unfiredOnly: true, plus stale-owner warnings.
 *   leader-brief "what is the gate panel for my fleet, INCLUDING what has
 *                 already fired?"
 *                 -> unfiredOnly: false, plus per-gate waiter counts.
 *
 * ⚠ DO NOT add enrichment here. The moment this function starts joining
 * awaiter counts or ownership it acquires one sink's question, and the other
 * sink pays for metadata it does not render. Keep it to read + scope.
 */
import { listActiveAnnouncements } from './store';
import { announcementVisibleTo } from './announce-key';

/**
 * The announcement row, derived from the reader's own return type rather than
 * imported: `store.ts` declares `AwaitRow` locally and does NOT export it, so
 * naming it directly is a compile error. Deriving it also means this module
 * cannot drift from the store's actual row shape.
 */
type AnnouncementRow = Awaited<ReturnType<typeof listActiveAnnouncements>>[number];

/**
 * The reader's scope. Every field is optional-and-nullable because a caller
 * legitimately may not have one: an agent outside a fleet has no `fleetSlug`,
 * and `announcementVisibleTo` already treats a missing field as "cannot see
 * anything scoped to that dimension" rather than as a wildcard.
 */
export interface AnnouncedGateReaderScope {
  fleetSlug?: string | null;
  planSlug?: string | null;
  harnessSlug?: string | null;
}

export interface ReadVisibleAnnouncementsInput {
  scope: AnnouncedGateReaderScope;
  /**
   * `true` = only gates that have not fired (turn-start: a fired gate is not
   * something to await). `false` = include latched ones (the leader cockpit).
   * REQUIRED rather than defaulted: the two sinks want opposite values, so a
   * default would silently be wrong for one of them.
   */
  unfiredOnly: boolean;
  /** REQUIRED for the same reason — the sinks budget differently (50 vs 100). */
  limit: number;
}

/**
 * Read the live announcement directory and keep only what this reader may see.
 *
 * PURE apart from the injected store read, so both sinks' tests can drive it
 * without a database.
 */
export async function readVisibleAnnouncements(
  input: ReadVisibleAnnouncementsInput,
  deps: { listAnnouncements?: typeof listActiveAnnouncements } = {},
): Promise<AnnouncementRow[]> {
  const listAnnouncements = deps.listAnnouncements ?? listActiveAnnouncements;
  const announcements = await listAnnouncements({
    unfiredOnly: input.unfiredOnly,
    limit: input.limit,
  });
  return selectVisibleAnnouncements(announcements, input.scope);
}

/**
 * The SCOPING CONTRACT on its own — pure, for a caller that already holds the
 * rows.
 *
 * ⚠ WHY BOTH THIS AND `readVisibleAnnouncements` EXIST, since one wrapping the
 * other looks redundant. The turn-start sink resolves its scope from the
 * caller's session brief and live fleet membership, and fetches those
 * CONCURRENTLY with the announcement read — it cannot know the scope until
 * after the read has been issued. Forcing it through the read+filter form would
 * serialize two independent round-trips on a per-turn path for no gain. So the
 * shared unit is this selector, and `readVisibleAnnouncements` is the
 * convenience for a caller (the leader brief) that already knows its scope.
 *
 * Both sinks therefore go through ONE scoping implementation, which is the
 * property P-027 is actually after; neither pays for the other's call shape.
 */
export function selectVisibleAnnouncements(
  announcements: readonly AnnouncementRow[],
  scope: AnnouncedGateReaderScope,
): AnnouncementRow[] {
  return announcements.filter((announcement) => announcementVisibleTo(announcement, scope));
}
