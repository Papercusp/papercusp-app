/**
 * self-marker.ts — caller self-identification overlay for roster / presence
 * endpoints (coord:presence, fleet:assignments, coord:orient).
 *
 * The problem this solves: a roster endpoint returns a LIST of agents, several
 * of which may be the SAME role (e.g. two `su` sessions). The caller is itself
 * one of those rows, but nothing in the result said which — so an agent reading
 * its own presence could not tell which entry was *itself* without separately
 * calling coord:whoami and eyeballing the id. This stamps the answer INTO the
 * result: a top-level `self` (the caller's own ownerId + label) plus `isSelf:true`
 * on the caller's own row.
 *
 * WHY a response-layer overlay (and NOT a field in `toStableRosterRow`): `isSelf`
 * is CALLER-dependent — the same agent row is `isSelf` for one reader and not for
 * another. The stable roster projection (presence-payload.ts) is, by contract,
 * caller-INDEPENDENT: it is the byte-stable cache prefix (D-006), it is shared
 * verbatim by the coord:inbox re-bootstrap block (P-010), and identity+state is
 * diffed by the [coord+N] delta channel (D-005). Baking a per-caller field into
 * it would break the byte-stable prefix AND let one caller's marker leak into the
 * delta diff. So self-marking is applied by each TOOL HANDLER, after the shared
 * snapshot is assembled, leaving the shared projection untouched. (Same `self`
 * marker pattern already used by coord:glance and coord:watermark.)
 */

import { resolveAgentIdentity, type ResolveIdentityCtx } from './identity';

/** The caller's own coordination identity, folded into a roster result so the
 *  reader can map "which of these rows is me". `ownerId` is the stable id to
 *  match a roster row's `ownerId`/`agentId` against; `ownerLabel` is display-only. */
export interface SelfRef {
  ownerId: string;
  ownerLabel: string;
}

/**
 * Soft-resolve the caller's identity for self-marking. BEST-EFFORT: an
 * anonymous / unattributable ctx yields `undefined` (the marker is simply
 * omitted — never an error), the same posture coord:whoami / coord:orient take.
 * A roster read must still succeed for a caller we cannot attribute.
 */
export function resolveSelfRef(ctx: unknown): SelfRef | undefined {
  try {
    const id = resolveAgentIdentity(ctx as ResolveIdentityCtx);
    if (id?.ownerId) return { ownerId: id.ownerId, ownerLabel: id.ownerLabel };
  } catch {
    /* anonymous / unattributable caller — no self marker */
  }
  return undefined;
}

/**
 * Stamp `isSelf: true` onto the roster row(s) whose `idKey` equals the caller's
 * ownerId. Returns a NEW array; non-self rows pass through unchanged (the marker
 * key is added ONLY to the caller's own row, so the rest of the roster stays
 * byte-identical to the shared snapshot). A no-op when `self` is undefined.
 *
 * `idKey` defaults to `ownerId` (coord:presence rows); fleet:assignments rows key
 * the caller's id under `agentId`, so it passes `'agentId'`.
 */
export function markSelfRows<T extends object>(
  rows: T[],
  self: SelfRef | undefined,
  idKey = 'ownerId',
): T[] {
  if (!self) return rows;
  return rows.map((r) =>
    (r as Record<string, unknown>)[idKey] === self.ownerId ? { ...r, isSelf: true } : r,
  );
}
