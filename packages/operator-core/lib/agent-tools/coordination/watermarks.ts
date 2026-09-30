/**
 * watermarks.ts — operator host adapter for per-agent "last-read" pointers.
 *
 * Backend: `PgWatermarkStore` over the org embedded-pg handle —
 * `harness_shared.coord_watermarks`, one mutable row per (workspace, owner),
 * workspace-scoped like the sibling coord tables (coord-channels-pg-port
 * P-006 / D-001 / D-003). The value shape + pure merge stay in
 * @papercusp/coordination/core; the store does the read-modify-write
 * (single-writer-per-owner, so no lock — the same invariant the old fs
 * adapter relied on). The original function surface is preserved so all
 * callers + the turn-start hook are unchanged.
 *
 * agent-coordination-architecture-v2 §7.2.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  PgWatermarkStore,
  type WatermarkStore,
} from '@papercusp/coordination/watermark-store';
import { emptyWatermark, type Watermark } from '@papercusp/coordination/core';
import { coordScopeWorkspace } from './log';

export { emptyWatermark };
export type { Watermark };

/**
 * The ONE rule for "what has this agent already read" — the LATER of the
 * turn-END settle watermark and a real read receipt; either alone counts;
 * neither ⇒ null ("no receipt on record", i.e. nothing can be narrowed).
 * ISO strings compare lexicographically.
 *
 * Lives HERE, next to the cursor fields it interprets, because it has two
 * unrelated consumers that must never drift apart on the rule:
 *   - the continuation gate (loop/checkpoint.ts), where it started life as
 *     P-007 fleet-member-dx / EI-9035;
 *   - the Sessions-dossier unread badge (adv-agent-detail.ts), which had NO
 *     cursor at all and so counted the whole log
 *     (unread-count-truthfulness-2026-07-27 P-002 / D-004).
 *
 * Why a fallback is needed at all: an empty `messages_since_ts` reads as "never
 * read anything", i.e. count from log epoch — the 19k unread badge. It used to
 * be empty on almost every row because the cursor had exactly ONE writer
 * (`coord:watermark-set`, called only by the OMP hook's `onTurnEnd`), so no
 * Claude/Codex session ever wrote it at all. NOTE this is a CLIENT-COVERAGE
 * gap, not the attached-vs-detached one an earlier version of this comment
 * described: `onTurnEnd`'s "detached" means the OPERATOR is unreachable, which
 * is a different (and much rarer) condition than "a headless session".
 * `messages_shown_ts` (advanced deterministically by `coord:inbox` at
 * injection) and the `tool_invocations` read record are the signals that
 * survive that, so they are what an empty settle cursor falls back to.
 *
 * The write side is now fixed at its source: `messages_since_ts` SETTLES at the
 * cross-client turn-end seam `journal:record-turn`
 * (`turn-end-tracking.ts#settledMessagesCursor`, unread-count-truthfulness
 * P-008 / D-008), so every client advances it, not just OMP.
 *
 * This fallback is nonetheless PERMANENT, not a bridge awaiting that fix
 * (D-011). The settle is FORWARD-ONLY — it fires at a clean turn end, so it can
 * never reach an agent that has stopped taking turns, and thousands of existing
 * rows carry a `shown_ts` with no `since_ts` that only this fallback resolves
 * (D-009 declined to backfill them precisely because it already does). It is
 * also the recurrence guard for the bug class: the settle still depends on the
 * seam FIRING, so a killed session or a future transport that never reaches it
 * lands back here — and this fallback is what makes that degrade quietly
 * instead of counting from epoch. Do not remove it.
 */
export function pickUnreadCursor(
  wmTs: string | null | undefined,
  readTs: string | null | undefined,
): string | null {
  const a = wmTs || null;
  const b = readTs || null;
  if (a && b) return b > a ? b : a;
  return b ?? a;
}

function makeDefaultStore(): WatermarkStore {
  return new PgWatermarkStore({
    getSql: () => getOrgPg().sql,
    // Tables are defined by the migration baseline now; the host seam is a no-op.
    ensureSchema: async () => {},
    // F-C1: flip watermarks to per-workspace in lockstep with PgCoordLog (the same
    // flag-gated resolver), so read-positions track the active workspace's partition.
    getWorkspaceId: () => coordScopeWorkspace(),
  });
}

let store: WatermarkStore = makeDefaultStore();

/**
 * Swap the backing WatermarkStore. Tests inject `new InMemoryWatermarkStore()`
 * so they don't read/write the live `harness_shared.coord_watermarks` row for
 * (workspace, owner). Call `resetWatermarkStore()` in afterEach.
 */
export function configureWatermarkStore(next: WatermarkStore): void {
  store = next;
}

/** Restore the default PgWatermarkStore backend (afterEach in tests). */
export function resetWatermarkStore(): void {
  store = makeDefaultStore();
}

/**
 * Read an agent's watermark. A never-written owner reads as an empty
 * watermark ("never read anything").
 */
export async function readWatermark(ownerId: string): Promise<Watermark> {
  return store.read(ownerId);
}

/**
 * Merge `patch` into the agent's watermark and persist it. Omitted fields
 * keep their current value; `subscriptions_fired` is *replaced* when
 * supplied, not appended — the caller owns dedup.
 *
 * Deliberately NOT monotonic (P1-11): the ts cursors are last-write-wins, so a
 * patch carrying an EARLIER ts moves the cursor BACKWARD. This is by design,
 * not a regression bug — the watermark protocol is *at-least-once, never a
 * skip* (see watermark-crash-restart.integration.test.ts): a consumer that
 * ends consumption mid-(same-ts)-group commits the previous DISTINCT ts,
 * rolling the cursor back so the unconsumed siblings are re-seen on restart. A
 * `max(current, patch)` clamp here would break that safe-commit recovery and
 * turn a documented re-delivery into a SKIP. Ordering safety against truly
 * out-of-order stale writes is the caller's (turn-end-only commit; the OMP
 * coord extension only ever advances).
 */
export async function writeWatermark(
  ownerId: string,
  patch: Partial<Watermark>,
): Promise<Watermark> {
  return store.write(ownerId, patch);
}
