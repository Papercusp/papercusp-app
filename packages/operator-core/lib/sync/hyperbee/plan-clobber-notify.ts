/**
 * plan-clobber-notify — the user-facing surface for plan clobber/conflict events
 * (shared-hive-collaboration-2026-06-14 P-007).
 *
 * `clobber-events.ts` detects when a REMOTE write overrides a recent LOCAL write
 * within the LWW window. The drain records local PLAN writes (outbox-drain.ts) and
 * the plan projection reports remote plan applies (harness-plans.ts), so a raced
 * plan edit now fires a `clobber` event for table `plans-by-slug`. This module
 * turns that event into a durable user notification — "your edit to plan X raced a
 * concurrent change" — instead of the silent loss P-007 set out to kill.
 *
 * The mapping (`planClobberNotice`) is PURE so it unit-tests without the coord
 * substrate; `registerPlanClobberNotifier` is the thin, idempotent wiring that
 * forwards plan clobbers to an injected `notify` (boot passes the real coord send).
 * Non-plan clobbers (e.g. the queue/working-set tables) are ignored here — they
 * have their own surface (the clobber-stream SSE).
 */

import { clobberEvents, type ClobberEvent } from './clobber-events';

/** The projection tableTag for federated plans (harness-plans.ts). */
const PLAN_TABLE_TAG = 'plans-by-slug';

export interface PlanClobberNotice {
  /** The plan whose local edit was overridden (the clobber event's hbKey). */
  planSlug: string;
  /** The winning remote contributor's source identity (receiver-stamped key). */
  byPubkey: string;
  /** Human-readable summary line for the inbox/toast. */
  summary: string;
  /** Longer body explaining the loss + the recovery action. */
  body: string;
}

/** Short, display-only rendering of a source pubkey (never used for identity). */
function shortPubkey(pubkey: string): string {
  return pubkey ? pubkey.slice(0, 8) : 'another contributor';
}

/**
 * Map a clobber event to a user-facing plan-clobber notice, or `null` when the
 * event isn't a plan clobber. Pure — the testable core.
 */
export function planClobberNotice(ev: ClobberEvent): PlanClobberNotice | null {
  if (ev.table !== PLAN_TABLE_TAG || !ev.hbKey) return null;
  const planSlug = ev.hbKey;
  const byPubkey = ev.theirs?.pubkey ?? '';
  const who = shortPubkey(byPubkey);
  return {
    planSlug,
    byPubkey,
    summary: `⚠ Your edit to plan ${planSlug} raced a concurrent change`,
    body:
      `Your local edit to plan "${planSlug}" was overridden by a concurrent change ` +
      `from ${who} (last-writer-wins). Your version was not saved — reopen the plan ` +
      `to review the current content and re-apply your change.`,
  };
}

export type NotifyPlanClobber = (notice: PlanClobberNotice) => void | Promise<void>;

/** Process-global registration guard — clobberEvents is a singleton, so a
 *  per-harness boot must not stack duplicate listeners (one notice per clobber). */
let active: (() => void) | null = null;

/**
 * Register the global plan-clobber → user-notify listener. Idempotent: a second
 * call (e.g. another harness booting in the same process) returns the existing
 * unregister fn without adding a duplicate listener. Returns the unregister fn.
 */
export function registerPlanClobberNotifier(notify: NotifyPlanClobber): () => void {
  if (active) return active;
  const handler = (ev: ClobberEvent): void => {
    const notice = planClobberNotice(ev);
    if (!notice) return;
    // Best-effort: a notification failure — SYNC or async — must never throw into
    // the EventEmitter (a listener throw would break the whole clobber fan-out).
    try {
      void Promise.resolve(notify(notice)).catch(() => {});
    } catch {
      // synchronous throw from notify — swallow.
    }
  };
  clobberEvents.on('clobber', handler);
  active = () => {
    clobberEvents.off('clobber', handler);
    active = null;
  };
  return active;
}

/** Test seam — drop the registration so each test starts clean. */
export function _resetPlanClobberNotifierForTests(): void {
  if (active) active();
}
