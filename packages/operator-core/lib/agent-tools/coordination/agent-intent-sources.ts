/**
 * agent-intent-sources.ts — the DURABLE read behind `intentEventId` re-hydration
 * (WI-6637), sibling of `agent-goal-sources.ts` and built to the same split: this
 * file is the only part that touches a store, and the policy that consumes it
 * lives in `agent-state-stamp.ts`.
 *
 * WHY THIS EXISTS. `tool_invocations.intent_event_id` is fed from a module-scoped
 * `Map` that a deploy empties. WI-6595 gave `goalRef` a durable source; the intent
 * half had none, so every operator restart zeroed it for the fleet MAJORITY —
 * measured across the 2026-07-28T09:41:42Z restart, 361 calls by 5 owners carried
 * `intentEventId` on EXACTLY ZERO of them while re-hydrated `goalRef` reached ~78%.
 * The asymmetry is the whole point: the long-running monitor-loop sessions that
 * dominate a post-restart window wake every ~60s but re-declare intent only at
 * bootstrap, so "agents wake constantly" never implied "agents re-declare".
 *
 * ⚠ THE POINTER IS THE APPEND-ONLY LOG LINE, NOT THE PRESENCE ROW. `coord_presence`
 * also carries an owner's current intent and is the obvious-looking source, but it
 * is MUTATED IN PLACE — so a pointer at it would name different content than it did
 * when stamped, which is exactly the D-003 violation P-008(a) fixed for facts.
 * `sendMessage` states this where the id is minted (`messages.ts`, the
 * `noteIntentDeclared` call site): the event log is append-only, so this pointer is
 * stable. Re-hydration must read the SAME record the live path points at, or the
 * two would disagree about what an intent id even means.
 *
 * ⚠ `lifecycle` IS READ STRUCTURALLY, out of the envelope body, for the same reason
 * the producer writes it that way: it rides in `extra` rather than a declared
 * envelope field, so `body->>'lifecycle'` is the contract both sides share.
 */
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';

/**
 * The `coord_event_log.id` of an owner's most recent intent declaration, or null
 * for "this owner has never declared one".
 *
 * COST — measured, not assumed. The decisive case is an owner that has NEVER
 * declared, because that is the one which cannot short-circuit and must walk the
 * index backwards to exhaustion. On the live table (75,249 `messages` rows in this
 * workspace) that walk is **32ms**, indistinguishable from the 31ms hit case. So
 * this deliberately carries NO time bound: a bound would buy nothing measurable and
 * would silently miss an agent whose declaration is older than the window — which
 * is precisely the long-running monitor-loop session this fix exists to serve.
 *
 * Never throws: the caller is a best-effort telemetry fill (D-014), so a store that
 * is down or not yet up degrades to "no pointer", exactly as a cache miss would.
 */
export async function resolveOwnerIntentEventId(ownerId: string): Promise<number | null> {
  const owner = (ownerId ?? '').trim();
  // Mirrors `readGoalLegs`: with no PG fast path there is no durable store to read,
  // and on a fresh boot that is precisely when the first calls arrive.
  if (!owner || !coordHasPgFastPath()) return null;

  try {
    const sql = coordSql();
    const ws = coordWorkspaceId();
    // `id::text` — the column is bigint. Reading it as text and converting once
    // here keeps the driver from handing back a rounded number, the same care
    // `dev:pg_query` takes with int8.
    const rows = await sql<{ id: string | null }[]>`
      SELECT id::text AS id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND writer_key = ${owner}
         AND body->>'lifecycle' = 'intent'
       ORDER BY id DESC
       LIMIT 1`;
    const raw = rows[0]?.id;
    if (raw == null) return null;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    /* best-effort, exactly like the telemetry it feeds */
    return null;
  }
}
