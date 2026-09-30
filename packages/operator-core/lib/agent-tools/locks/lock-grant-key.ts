/**
 * lock-grant await-event key — the join between a waiter ticket and the
 * await a blocked agent (locks:acquire { wake_on_grant }) registered on it.
 *
 * Extracted from lock-grant-bridge so the apply-on-grant path (EI-9033) can
 * reference it without importing the bridge (which imports apply-on-grant) —
 * i.e. to break the module cycle. The bridge re-exports these for back-compat,
 * so existing `from './lock-grant-bridge'` importers keep resolving.
 */

export const LOCK_GRANT_KEY_PREFIX = 'lock:grant:';

export const lockGrantKey = (ticketId: string): string => `${LOCK_GRANT_KEY_PREFIX}${ticketId}`;

export function ticketFromLockGrantKey(key: string): string | null {
  return key.startsWith(LOCK_GRANT_KEY_PREFIX) ? key.slice(LOCK_GRANT_KEY_PREFIX.length) : null;
}
