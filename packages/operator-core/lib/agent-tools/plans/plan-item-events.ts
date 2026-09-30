/**
 * plan-item-events — the plan-item done signal through the await-event primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-105).
 *
 * `plan-item:done:<slug>:<id>` fires when a plan item flips to done. An agent waiting on
 * a dependency plan item — a peer's lane, a blocking item on another plan — awaits exactly
 * it (events:await { event: "plan-item:done:my-plan:P-014" }) instead of polling plans:get.
 * The (slug, id) both live IN the key, so a waiter wakes only for THAT item; no payload
 * filtering. Transition-gated by the caller (only a real →done edge, never a re-set of an
 * already-done item). Fire-and-forget from plans:set-status; never throws.
 */

import { emitAwaitedEvent } from '../../events/await/engine';

/**
 * Expected fail-soft noise for a best-effort fire-and-forget emit (never warn, or
 * vitest-fail-on-console flakes rig tests): a partial test schema ("… does not exist"),
 * or the async query outliving its Postgres pool (CONNECTION_ENDED/DESTROYED). Else warn.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[plan-item-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seam for tests. */
export interface PlanItemEventsDeps {
  emit?: typeof emitAwaitedEvent;
}

/**
 * Fire `plan-item:done:<slug>:<id>` for an item that just flipped to done. Awaiter-only
 * (no `to` push): the audience is whoever registered interest in this item. Fire-and-forget.
 */
export function emitPlanItemDoneEvent(slug: string, itemId: string, deps: PlanItemEventsDeps = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: `plan-item:done:${slug}:${itemId}`,
        summary: `plan item ${slug} · ${itemId} → done`,
        payload: { slug, itemId },
        source: 'plans',
      }),
    )
    .catch((e: unknown) => failSoft(`done-event for ${slug}#${itemId}`, e));
}
