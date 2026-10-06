/**
 * read-cursors.ts — server-side per-agent read cursors with two-phase
 * ACK-ON-NEXT-READ (fleet-deltas-leader-primitives-2026-07-10 P-004; the
 * owner-ratified D-002 design; mig 537 `harness_shared.coord_read_cursors`).
 *
 * The problem this solves: every delta protocol in this system so far failed on
 * the CALLER leg — AGENT clients never carry cursors (the `_meta.delta` cursor is
 * carried by the MCP TRANSPORT's delta proxy, not by any agent — WI-3153;
 * `since_ts` seeded wrong loses messages forever, WI-1600). So the cursor lives
 * SERVER-side, keyed (workspace, owner, surface), and the caller passes nothing.
 *
 * Two-phase semantics (the loop-wake-turn-death fix):
 *   call N   : deliver delta(committed → current); store pending = current.
 *   call N+1 : its ARRIVAL is the ack — promote pending → committed, then
 *              deliver delta(committed → current) as usual.
 * A caller that dies after call N never makes call N+1, so pending is never
 * promoted: the next call re-diffs against the OLD committed and re-delivers
 * call N's content. At-least-once, never a skip — the same recovery contract as
 * coord_watermarks' deliberately non-monotonic ts cursors (watermarks.ts),
 * generalized from timestamps to arbitrary compact state fingerprints.
 *
 * ACK-ON-PROOF (owner-directive-delivery-redesign-2026-09-22 P-005, D-005).
 * Arrival proves only that the caller came BACK, not that call N's content
 * reached the agent. A hook killed after the server staged (its own wall, the
 * client's hook timeout, a crash between receiving and printing) still arrives
 * on the next turn, so arrival would ack a block nobody saw. A caller that can
 * prove emission passes an {@link AckConfirmation}: `stage` records a delivery
 * token inside pending, the caller echoes that token back only after it
 * actually emitted, and `ackAndRead` promotes pending ONLY on a match —
 * otherwise it discards pending and the next diff re-delivers. A caller that
 * passes no confirmation keeps ack-on-arrival unchanged.
 *
 * Store shape mirrors watermarks.ts: a module-level default Pg store with
 * configure/reset seams so tests inject the in-memory variant and never touch
 * the live row.
 */

import { getOrgPg } from '@papercusp/db-org';
import { coordScopeWorkspace } from './log';

/** A compact JSON-serializable state fingerprint. Keep it SMALL (the point is
 *  to diff against it, not to archive state) — per-member scalars, not payloads. */
export type CursorState = Record<string, unknown>;

export interface AckResult {
  /** The state the caller has provably seen (post-promotion) — diff against
   *  THIS. Null on the very first call for a surface: deliver a full baseline. */
  committed: CursorState | null;
  /** True when no committed state exists yet — the caller must receive a full
   *  snapshot, not a delta. */
  baseline: boolean;
  /** In ACK-ON-PROOF mode, the pending state whose token was not confirmed.
   *  It was discarded from storage and is returned only so the owning surface
   *  can attribute the unconfirmed delivery; it never becomes the diff floor. */
  unconfirmedPending?: CursorState;
}

/**
 * The reserved key a staged pending carries its delivery token under. A surface's
 * own state must never use it; promotion strips it, so no diff ever sees it.
 */
export const DELIVERY_TOKEN_KEY = '__deliveryToken';

/**
 * ACK-ON-PROOF — see the module header. `confirmedToken` is the token the caller
 * proves it emitted; null means it can prove nothing (a first turn, or the last
 * emission failed), which discards pending exactly like a mismatch does.
 */
export interface AckConfirmation {
  confirmedToken: string | null;
}

export interface ReadCursorStore {
  /** Phase 1+2 in one round-trip: promote pending→committed (the ack for the
   *  previous delivery), persist `next` as the new pending, and return the
   *  post-promotion committed to diff against. */
  ackAndAdvance(ownerId: string, surface: string, next: CursorState): Promise<AckResult>;
  /** Phase 1 ALONE — see the module-level {@link ackAndRead}. */
  ackAndRead(ownerId: string, surface: string, confirmation?: AckConfirmation): Promise<AckResult>;
  /** Phase 2 ALONE — see the module-level {@link stage}. */
  stage(ownerId: string, surface: string, next: CursorState): Promise<void>;
  /** Replace one metadata candidate only while its own token still matches
   * pending or committed. Never changes the fingerprint floor or ACK token. */
  annotateByToken(ownerId: string, surface: string, key: string, token: string, value: unknown): Promise<boolean>;
  /** Drop a surface's cursor (e.g. a schema change invalidates fingerprints). */
  clear(ownerId: string, surface: string): Promise<void>;
}

class PgReadCursorStore implements ReadCursorStore {
  async ackAndAdvance(ownerId: string, surface: string, next: CursorState): Promise<AckResult> {
    const { sql } = getOrgPg();
    const ws = coordScopeWorkspace();
    // Single-writer-per-(owner,surface) — the owning agent's own turn is the only
    // writer, the same no-lock invariant coord_watermarks relies on. One statement:
    // promote pending→committed (ack) and install the new pending, returning the
    // PRE-UPDATE promotion result via a CTE over the old row.
    const rows = await sql<Array<{ committed: CursorState | null }>>`
      WITH old AS (
        SELECT committed, pending FROM harness_shared.coord_read_cursors
         WHERE workspace_id = ${ws} AND owner_id = ${ownerId} AND surface = ${surface}
      ), up AS (
        INSERT INTO harness_shared.coord_read_cursors
               (workspace_id, owner_id, surface, committed, pending, pending_at, updated_at)
        VALUES (${ws}, ${ownerId}, ${surface},
                (SELECT COALESCE(pending, committed) FROM old),
                -- WI-7092 / EI-607: this sql is getOrgPg's client (line 53) -- sql.json(next)
                -- THROWS on it in production (a postgres-js CJS/ESM dual-package
                -- module-instance mismatch; see
                -- agent-insights/sql-json-throws-on-getorgpg-client). Bind as
                -- JSON.stringify(next)::jsonb instead -- portable, server-side cast, and
                -- correct under vitest too (vitest's module transform does not reproduce
                -- the CJS/ESM split, so a vitest-run test cannot tell the two forms apart --
                -- this comment plus lint:no-sql-json are what actually guard the class).
                ${JSON.stringify(next)}::jsonb, now(), now())
        ON CONFLICT (workspace_id, owner_id, surface) DO UPDATE
           SET committed  = COALESCE(harness_shared.coord_read_cursors.pending,
                                     harness_shared.coord_read_cursors.committed),
               pending    = EXCLUDED.pending,
               pending_at = now(),
               updated_at = now()
        RETURNING committed
      )
      SELECT committed FROM up
    `;
    const committed = rows[0]?.committed ?? null;
    return { committed, baseline: committed === null };
  }

  async ackAndRead(ownerId: string, surface: string, confirmation?: AckConfirmation): Promise<AckResult> {
    const { sql } = getOrgPg();
    const ws = coordScopeWorkspace();
    // Phase 1 only: promote pending→committed and CLEAR pending. Same single
    // statement / single-writer invariant as ackAndAdvance; the only difference is
    // that no new pending is installed, because the caller cannot know it yet.
    // Under ack-on-proof the promotion is conditional on the token match; a
    // non-match keeps committed. Pending is cleared either way, so a failed
    // delivery is re-diffed from the old floor rather than retried verbatim.
    const proof = confirmation !== undefined;
    const token = confirmation?.confirmedToken ?? null;
    const rows = await sql<Array<{ committed: CursorState | null; unconfirmed_pending: CursorState | null }>>`
      WITH old AS MATERIALIZED (
        SELECT pending
          FROM harness_shared.coord_read_cursors
         WHERE workspace_id = ${ws} AND owner_id = ${ownerId} AND surface = ${surface}
      ), up AS (
        INSERT INTO harness_shared.coord_read_cursors
               (workspace_id, owner_id, surface, committed, pending, pending_at, updated_at)
        VALUES (${ws}, ${ownerId}, ${surface}, NULL, NULL, now(), now())
        ON CONFLICT (workspace_id, owner_id, surface) DO UPDATE
           SET committed  = CASE
                              WHEN NOT ${proof}::boolean
                                THEN COALESCE(harness_shared.coord_read_cursors.pending,
                                              harness_shared.coord_read_cursors.committed)
                              WHEN harness_shared.coord_read_cursors.pending ->> ${DELIVERY_TOKEN_KEY}::text
                                   = ${token}::text
                                THEN harness_shared.coord_read_cursors.pending
                              ELSE harness_shared.coord_read_cursors.committed
                            END - ${DELIVERY_TOKEN_KEY}::text,
               pending    = NULL,
               updated_at = now()
        RETURNING committed
      )
      SELECT up.committed,
             CASE WHEN ${proof}::boolean
                        AND old.pending IS NOT NULL
                        AND old.pending ->> ${DELIVERY_TOKEN_KEY}::text IS DISTINCT FROM ${token}::text
                  THEN old.pending - ${DELIVERY_TOKEN_KEY}::text
                  ELSE NULL
             END AS unconfirmed_pending
        FROM up
        LEFT JOIN old ON true
    `;
    const committed = rows[0]?.committed ?? null;
    const unconfirmedPending = rows[0]?.unconfirmed_pending ?? null;
    return {
      committed,
      baseline: committed === null,
      ...(unconfirmedPending === null ? {} : { unconfirmedPending }),
    };
  }

  async stage(ownerId: string, surface: string, next: CursorState): Promise<void> {
    const { sql } = getOrgPg();
    const ws = coordScopeWorkspace();
    // WI-7092 / EI-607: bind as JSON.stringify(...)::jsonb, never sql.json(...) —
    // see the note in ackAndAdvance above; lint:no-sql-json guards the class.
    await sql`
      INSERT INTO harness_shared.coord_read_cursors
             (workspace_id, owner_id, surface, committed, pending, pending_at, updated_at)
      VALUES (${ws}, ${ownerId}, ${surface}, NULL, ${JSON.stringify(next)}::jsonb, now(), now())
      ON CONFLICT (workspace_id, owner_id, surface) DO UPDATE
         SET pending    = EXCLUDED.pending,
             pending_at = now(),
             updated_at = now()
    `;
  }

  async annotateByToken(ownerId: string, surface: string, field: string, token: string, value: unknown): Promise<boolean> {
    const encoded = JSON.stringify(value);
    if (!field || !token || encoded === undefined) return false;
    const { sql } = getOrgPg();
    const ws = coordScopeWorkspace();
    const rows = await sql<Array<{ updated: number }>>`
      UPDATE harness_shared.coord_read_cursors
         SET pending = CASE
               WHEN pending -> ${field}::text ->> 'token' = ${token}::text
                 THEN jsonb_set(pending, ARRAY[${field}::text], ${encoded}::jsonb, true)
               ELSE pending END,
             committed = CASE
               WHEN committed -> ${field}::text ->> 'token' = ${token}::text
                 THEN jsonb_set(committed, ARRAY[${field}::text], ${encoded}::jsonb, true)
               ELSE committed END,
             updated_at = now()
       WHERE workspace_id = ${ws} AND owner_id = ${ownerId} AND surface = ${surface}
         AND (pending -> ${field}::text ->> 'token' = ${token}::text OR
              committed -> ${field}::text ->> 'token' = ${token}::text)
      RETURNING 1 AS updated
    `;
    return rows.length > 0;
  }

  async clear(ownerId: string, surface: string): Promise<void> {
    const { sql } = getOrgPg();
    const ws = coordScopeWorkspace();
    await sql`
      DELETE FROM harness_shared.coord_read_cursors
       WHERE workspace_id = ${ws} AND owner_id = ${ownerId} AND surface = ${surface}`;
  }
}

/** In-memory variant for tests (mirrors watermarks.ts's injection contract). */
export class InMemoryReadCursorStore implements ReadCursorStore {
  private rows = new Map<string, { committed: CursorState | null; pending: CursorState | null }>();
  async ackAndAdvance(ownerId: string, surface: string, next: CursorState): Promise<AckResult> {
    const key = `${ownerId}\0${surface}`;
    const row = this.rows.get(key) ?? { committed: null, pending: null };
    const committed = row.pending ?? row.committed;
    this.rows.set(key, { committed, pending: next });
    return { committed, baseline: committed === null };
  }
  async ackAndRead(ownerId: string, surface: string, confirmation?: AckConfirmation): Promise<AckResult> {
    const key = `${ownerId}\0${surface}`;
    const row = this.rows.get(key) ?? { committed: null, pending: null };
    const confirmedPending = row.pending !== null && confirmation !== undefined &&
      confirmation.confirmedToken !== null && row.pending[DELIVERY_TOKEN_KEY] === confirmation.confirmedToken;
    const unconfirmedPending = confirmation !== undefined && row.pending !== null && !confirmedPending
      ? withoutDeliveryToken(row.pending)
      : null;
    const promoted =
      confirmation === undefined
        ? (row.pending ?? row.committed)
        : confirmedPending
          ? row.pending
          : row.committed;
    const committed = promoted === null ? null : withoutDeliveryToken(promoted);
    this.rows.set(key, { committed, pending: null });
    return {
      committed,
      baseline: committed === null,
      ...(unconfirmedPending === null ? {} : { unconfirmedPending }),
    };
  }
  async stage(ownerId: string, surface: string, next: CursorState): Promise<void> {
    const key = `${ownerId}\0${surface}`;
    const row = this.rows.get(key) ?? { committed: null, pending: null };
    this.rows.set(key, { committed: row.committed, pending: next });
  }
  async annotateByToken(ownerId: string, surface: string, field: string, token: string, value: unknown): Promise<boolean> {
    const key = ownerId + '\0' + surface;
    const row = this.rows.get(key);
    if (!row || !field || !token) return false;
    const update = (state: CursorState | null): CursorState | null => {
      const candidate = state?.[field];
      return candidate && typeof candidate === 'object' && 'token' in candidate &&
        candidate.token === token ? { ...state, [field]: value } : state;
    };
    const pending = update(row.pending);
    const committed = update(row.committed);
    if (pending === row.pending && committed === row.committed) return false;
    this.rows.set(key, { pending, committed });
    return true;
  }
  async clear(ownerId: string, surface: string): Promise<void> {
    this.rows.delete(`${ownerId}\0${surface}`);
  }
}

function withoutDeliveryToken(state: CursorState): CursorState {
  if (!(DELIVERY_TOKEN_KEY in state)) return state;
  const { [DELIVERY_TOKEN_KEY]: _token, ...rest } = state;
  return rest;
}

let store: ReadCursorStore = new PgReadCursorStore();

/** Swap the backing store (tests inject InMemoryReadCursorStore). */
export function configureReadCursorStore(next: ReadCursorStore): void {
  store = next;
}

/** Restore the default Pg store (afterEach in tests). */
export function resetReadCursorStore(): void {
  store = new PgReadCursorStore();
}

/** The module-level entry consumers call — see ReadCursorStore.ackAndAdvance. */
export async function ackAndAdvance(
  ownerId: string,
  surface: string,
  next: CursorState,
): Promise<AckResult> {
  return store.ackAndAdvance(ownerId, surface, next);
}

/**
 * PHASE 1 of the two-phase protocol, ALONE: promote pending→committed (the ack
 * for the previous delivery) and return the post-promotion committed to diff
 * against, WITHOUT installing a new pending. Pair with {@link stage}.
 *
 * WHY THIS EXISTS SEPARATELY FROM `ackAndAdvance`. That function fuses both
 * phases into one round-trip, which requires the caller to know `next` BEFORE
 * the read — true for a snapshot surface (fetch the whole roster, fingerprint
 * it, then ack) but NOT for a WINDOWED one. `coord:inbox` needs the committed
 * floor to BOUND its query — the bound is worth 11.6ms against 220ms
 * (inbox.ts's measured window note) — so the floor must be in hand before the
 * read, and `next` (the newest ts actually delivered) is only knowable after it.
 * Fusing them there would mean reading unbounded to learn the bound.
 *
 * AT-LEAST-ONCE IS PRESERVED, and the death window is the point. A turn that
 * dies between `ackAndRead` and `stage` leaves pending NULL and committed at
 * the PREVIOUS delivery's high-water mark, so the next call promotes nothing
 * and re-delivers from that same floor — the content of the dead call is
 * re-sent, never skipped. Identical recovery contract to `ackAndAdvance`; only
 * the window in which a crash costs a re-delivery differs.
 *
 * Pass `confirmation` for ACK-ON-PROOF (module header): the previous pending is
 * promoted only when its staged delivery token equals `confirmedToken`.
 */
export async function ackAndRead(
  ownerId: string,
  surface: string,
  confirmation?: AckConfirmation,
): Promise<AckResult> {
  return store.ackAndRead(ownerId, surface, confirmation);
}

/**
 * PHASE 2, ALONE: install `next` as pending — call it AFTER the delivery it
 * describes has been assembled for the caller. Its promotion to committed is
 * deferred to the NEXT `ackAndRead`/`ackAndAdvance`, which is what makes the
 * delivery at-least-once rather than at-most-once. See {@link ackAndRead}.
 *
 * `deliveryToken` stages the pending under ACK-ON-PROOF: the next `ackAndRead`
 * promotes it only when the caller confirms that exact token.
 */
export async function stage(
  ownerId: string,
  surface: string,
  next: CursorState,
  opts: { deliveryToken?: string } = {},
): Promise<void> {
  return store.stage(
    ownerId,
    surface,
    opts.deliveryToken ? { ...next, [DELIVERY_TOKEN_KEY]: opts.deliveryToken } : next,
  );
}

/** Enrich a staged or already ACKed metadata candidate without changing the
 * cursor's delivery floor. The candidate's token prevents late work from
 * annotating a newer turn. */
export async function annotateReadCursorByToken(
  ownerId: string, surface: string, key: string, token: string, value: unknown,
): Promise<boolean> {
  return store.annotateByToken(ownerId, surface, key, token, value);
}

/** Drop a surface's cursor for an owner. */
export async function clearReadCursor(ownerId: string, surface: string): Promise<void> {
  return store.clear(ownerId, surface);
}
