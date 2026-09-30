/**
 * live-lock-paths — "which repo paths does a LIVE agent currently hold?", read from the
 * lock plane rather than from declared presence.
 *
 * WHY THIS EXISTS (EI-18776963284535761). Several collision-avoidance consumers were
 * built on `coord_presence.current_files`, which is populated only by an explicit
 * `coord:declare-intent { current_files }`. Almost nothing declares it, and until the fix
 * in that item every `coord:orient` actively WIPED it — measured 113 live presence rows,
 * 0 populated. So those consumers were reading a permanently-empty set and silently
 * degraded to no-ops.
 *
 * The lock plane is the authority on who is on a file (the same conclusion `coord:send`
 * states in its own `@file:` miss message, and the fix EI-18772330418885814 applied to
 * the `@file:` audience). It is also AUTOMATIC: the PreToolUse edit hook acquires a lock
 * on every Edit/Write, so it reflects real activity with no agent discipline required.
 *
 * ⚠ This is deliberately NOT wired back into `current_files` itself. That column must stay
 * a DECLARED signal, because `locks/enrich-busy.ts` compares it against the contended path
 * to decide whether a lock holder is still focused on it (`holder_focused`, the veto that
 * protects a live holder from being advertised as an orphaned lock, EI-10433). A holder
 * holds a lock on the contended path by definition, so a lock-derived `current_files`
 * would make that term CONSTANT-TRUE and kill the orphan signal — the same
 * constant-valued-term bug the original issue was about, merely inverted. Consumers that
 * want the automatic signal call THIS; consumers that want the declared one read presence.
 */

import { ensureBootstrap, getTxPool, readQueue } from './su-lock-store';

export interface LiveLockHolding {
  path: string;
  owner: string;
  /** The holder's declared edit intent, preserved for actionable git-sync diagnostics. */
  intent: string;
  /** The active work-item/goal associated with the lock, when the caller stamped one. */
  goalRef?: string;
  /**
   * The lock's coordination domain: the absolute root of the repository `path` is relative
   * to. The read below spans EVERY domain, so a consumer that compares `path` against one
   * specific tree must translate by this first (EI-24649116564770033; git-sync does so via
   * `translateLiveLockHoldingsToRoot`).
   */
  coordinationDomain?: string;
}

/**
 * Read every currently-held file lock without swallowing lock-plane failures.
 *
 * Most collision-avoidance callers should use {@link liveLockHoldings}, whose
 * fail-soft contract preserves their historical best-effort behaviour. Commit
 * gates are different: treating an unreadable lock plane as an empty set can
 * stage a peer's in-flight (including temporarily truncated) file. Those
 * callers use this strict seam and must fail closed when it throws.
 */
export async function liveLockHoldingsStrict(): Promise<LiveLockHolding[]> {
  await ensureBootstrap();
  // readQueue already filters holders to expires_ts > clock_timestamp(), so the set is
  // live by construction. No `paths`/`owner` filter ⇒ the whole active set.
  const queue = await readQueue(getTxPool(), { coordinationDomain: null });
  return queue.active_locks.map((l) => ({
    path: l.path,
    owner: l.owner,
    intent: l.intent,
    ...(l.goal_ref?.trim() ? { goalRef: l.goal_ref.trim() } : {}),
    ...(l.coordination_domain?.trim() ? { coordinationDomain: l.coordination_domain.trim() } : {}),
  }));
}

/**
 * Every path currently held by a live lock, with its holder.
 *
 * `coordinationDomain: null` reads across EVERY domain, matching the audience-host
 * `@file:` read: the domain resolves from whichever checkout the operator process
 * loaded, so a domain-scoped read can report a genuinely-held lock as absent (observed
 * live — an agent editing the staging tree had its lock recorded under
 * `…/papercup-release`). Missing a real holder is the failure mode this exists to remove.
 *
 * HOLDERS ONLY, not waiters: unlike an audience — where an extra recipient is harmless —
 * a false positive here DEFERS real work, and a waiter is by definition not editing yet.
 *
 * Fail-soft: any error (locks unconfigured, side-DB unreachable) returns [] so the caller
 * degrades to exactly its pre-existing behaviour rather than breaking.
 */
export async function liveLockHoldings(): Promise<LiveLockHolding[]> {
  try {
    return await liveLockHoldingsStrict();
  } catch {
    return [];
  }
}

/** The distinct held paths, optionally excluding one agent's own holdings. */
export async function liveLockedPaths(opts: { excludeOwner?: string } = {}): Promise<string[]> {
  const holdings = await liveLockHoldings();
  const seen = new Set<string>();
  for (const h of holdings) {
    if (opts.excludeOwner && h.owner === opts.excludeOwner) continue;
    const path = h.path.trim();
    if (path) seen.add(path);
  }
  return [...seen];
}
