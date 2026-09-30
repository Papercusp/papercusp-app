/**
 * recipient-liveness.ts — FF#3: force a FRESH liveness read into a transfer result.
 *
 * The incident: an agent read another agent's presence ONCE at session start, then
 * handed it work ~13h later when it had long since ended — and the `woken:0` it got
 * back was rationalized away. The handoff/wake tools already probe liveness at the
 * transfer point (the wake fan), but they reported only a count. This forces the
 * missed addressee's CURRENT session state INTO the result, so a transfer to a
 * long-dead agent reads `ended` instead of a silent `woken:0` — the fresh read can't
 * be skipped because it's in the answer the caller is already looking at.
 *
 * Only the MISS path calls this (a wake/handoff that woke nobody), so the two extra
 * batch queries in fetchWakeability never touch the common case. Fully fail-soft: any
 * error → [] (a liveness-probe hiccup must NEVER fail an already-durable send/handoff).
 *
 * Leaf module by design: it consumes inbox-wake (NON_WAKEABLE) + recipient-resolve
 * (isSelectorOrWildcard) + presence-wakeability (fetchWakeability/deriveSessionState),
 * none of which import it — so there is no import cycle.
 */
import { NON_WAKEABLE } from './inbox-wake';
import { isSelectorOrWildcard, remoteSessionsByOwnerId } from './recipient-resolve';
// TYPE-ONLY import (erased): keep this module import-SAFE. The value side
// (resolveSessionStates) pulls the presence→DB chain, so it is lazy-imported
// inside the function — a consumer (or its unit test) can import this module
// without loading PG at module-init.
import type { SessionState } from './presence-wakeability';

export interface MissedRecipientLiveness {
  ownerId: string;
  /** Fresh coordinator-facing state at the transfer moment. `ended` = no live
   *  inbox-wake await (a wake reaches nobody → relaunch, do NOT assume pickup).
   *  `unknown` = federated/remote or not probeable here. */
  sessionState: SessionState | 'unknown';
  /** A live `coord:inbox-wake:<id>` await exists → a wake WOULD land. false ⇒
   *  nothing is listening; the inject black-holes until the agent is relaunched. */
  wakeable: boolean;
}

/**
 * Fresh per-recipient session state for a MISS path (FF#3). `ownerIds` is the set a
 * wake/handoff just FAILED to wake. Returns one row per concrete addressee with its
 * CURRENT `sessionState` + `wakeable`, freshly read (never a cached snapshot).
 *
 * Unification P-004: derives via the shared liveness oracle with
 * `hydratePerId` — each missed addressee's own coord_presence row supplies the
 * heartbeat / pid / recorded legs, so a dead-drop verdict here is at least as
 * strict as the roster's. (The old hand-rolled derivation fed `stale:false`
 * with NO hardStale/pid, so a zombie-await session killed by a reboot read
 * `parked` — a false "the transfer will be picked up" — exactly where the
 * caller was deciding whether the send black-holed.) The miss set is small
 * (the addressees of ONE send), so the per-id hydration point-reads are cheap.
 *
 * EI-16693: a FEDERATED (cross-machine) recipient must NEVER be run through the
 * local oracle. `resolveSessionStates`'s legs (wakeability, hardStale, pid probe,
 * `coord_presence` hydration) are ALL local-machine-only — a remote-homed session
 * has no row in any of them, which used to read as "no signal anywhere" and fall
 * through `deriveSessionState`'s `!wakeable ⇒ 'ended'` branch: a confidently WRONG
 * verdict for a session that is, per its own federated heartbeat, very much alive
 * (repro: coord:presence showed a 12s-old federated heartbeat for the same ownerId
 * the same send's `recipient_liveness` had just called `ended`). coord:presence
 * itself never makes this mistake — it explicitly excludes federated rows from the
 * local wakeability fetch and leaves their `sessionState` unset (see
 * presence-snapshot.ts's `isFederated` filtering). This mirrors that: consult the
 * SAME federated live-presence source send.ts already uses to classify
 * `recipient_remote`/`recipient_remote_stale` (`remoteSessionsByOwnerId`, backed by
 * `shared_session_presence`) and short-circuit those ids to `'unknown'` — a
 * deliberately non-committal verdict — instead of asking the local-only oracle to
 * guess at a session it structurally cannot see.
 */
export async function describeMissedRecipients(
  ownerIds: readonly string[],
  opts: { workspaceId?: string | null } = {},
): Promise<MissedRecipientLiveness[]> {
  const ids = [...new Set(ownerIds)].filter(
    (r) => !isSelectorOrWildcard(r) && !NON_WAKEABLE.has(r),
  );
  if (ids.length === 0) return [];
  // Best-effort: a federation-detection hiccup just means we fall back to running
  // every id through the local oracle (today's pre-fix behavior for that id),
  // never a hard failure of the whole liveness enrichment.
  let remoteIds: ReadonlySet<string>;
  try {
    remoteIds = new Set((await remoteSessionsByOwnerId(opts.workspaceId)).keys());
  } catch {
    remoteIds = new Set();
  }
  const localIds = ids.filter((id) => !remoteIds.has(id));
  const remoteResults: MissedRecipientLiveness[] = ids
    .filter((id) => remoteIds.has(id))
    .map((ownerId) => ({ ownerId, sessionState: 'unknown' as const, wakeable: false }));
  if (localIds.length === 0) return remoteResults;
  try {
    // Lazy value-import (keeps this module import-safe — see the type-only import above).
    const { resolveSessionStates } = await import('./liveness-oracle');
    const verdicts = await resolveSessionStates(
      localIds.map((ownerId) => ({ ownerId })),
      {
        hydratePerId: true,
        // EI-22546045794068839: keep the required-wake liveness projection
        // aligned with gate ownership / coord:presence for hosted sessions.
        psuHostPositiveAuthority: true,
      },
    );
    const localResults = localIds.map((ownerId) => {
      const v = verdicts.get(ownerId);
      if (!v) return { ownerId, sessionState: 'unknown' as const, wakeable: false };
      // EI-18771777750306094: a null sessionState is the oracle's IN-BAND
      // unknown. It lands on the same 'unknown' this function already had a
      // word for — an unmeasurable recipient must never read as a definite
      // state on the send-MISS path, which exists to decide whether a transfer
      // black-holed.
      return {
        ownerId,
        sessionState: v.sessionState ?? ('unknown' as const),
        wakeable: v.wakeable,
      };
    });
    return [...localResults, ...remoteResults];
  } catch {
    // Fail-soft: a liveness-probe hiccup must never fail the (already-durable) send.
    return remoteResults;
  }
}
