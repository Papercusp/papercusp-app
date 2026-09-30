/**
 * cell-reader-ctx.ts — build the `(CellReader, CellReadEnv)` pair a cell read
 * runs under, from a tool's identity + ctx.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT FOUR COPIES ─────────────────────────────
 *
 * Reading a cell passes TWO independent access gates (D-058, documented at
 * length in `cell-read.ts`): the P-019 audience check on the SPEC, and the
 * resolver tool's own ROLE gate on the dispatch. This pair is what feeds both.
 * It was constructed inline in `state:read`, and P-008 (b) added three more call
 * sites (`facts:assert`'s dependency capture, `facts:list`, the orient fold).
 *
 * Four hand-rolled copies of an access-control input is how a fail-open default
 * gets introduced by one of them: the `role ?? ''` rule below is load-bearing
 * and non-obvious, and it is exactly the kind of line someone "cleans up" into
 * `role ?? 'su'` at the third copy. D-042 names that failure directly — an
 * access default that fails OPEN — so the construction lives once, here.
 */
import type { CellReadEnv } from '../cell-read';
import type { CellReader } from '../cell-registry';

/** The slice of a tool ctx this needs. Structural rather than an imported ctx
 *  type, matching `resolveFactScopeRef`'s style — it keeps this usable from the
 *  orient fold, which does not have a tool ctx in scope in the same shape. */
export interface CellReaderCtxLike {
  workspaceId?: string | null;
  harnessSlug?: string | null;
  role?: string | null;
}

/**
 * Resolve the reader (WHO is asking — gate 1) and the env (what the dispatch
 * runs as — gate 2).
 *
 * ⚠ `role` FAILS CLOSED. An absent role becomes `''`, which matches no tool's
 * role allowlist, so the resolver dispatch is refused and the read renders as a
 * `not-measured` unknown: honest and safe. Substituting a real role for a caller
 * who never presented one would WIDEN gate 2 — the access default that fails
 * open. The same reasoning is why `reader.roles` is `[]` rather than a guess:
 * an empty role list can only ever match fewer cells, never more.
 */
export function cellReaderFromCtx(
  identity: { ownerId: string; workspaceId?: string | null },
  ctx: CellReaderCtxLike,
): { reader: CellReader; env: CellReadEnv } {
  return {
    reader: {
      ownerId: identity.ownerId,
      roles: ctx.role ? [ctx.role] : [],
      ...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),
    },
    env: {
      workspaceId: identity.workspaceId ?? ctx.workspaceId ?? 'default',
      harnessSlug: ctx.harnessSlug ?? null,
      role: ctx.role ?? '',
    },
  };
}
