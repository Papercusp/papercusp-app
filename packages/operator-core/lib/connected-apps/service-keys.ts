/**
 * Service keys — the credential an UNATTENDED app keeps and presents on every call with nobody
 * signed in (external-app-access-to-workspaces-2026-09-29 P-015, owner question #936).
 *
 * A service key is a connected_apps row with kind='service'. It is the same `pcapp_<id>_<secret>`
 * bearer as an app key, with the same scopes, pause, revoke and expiry, and it resolves to the same
 * `kind: 'service'` principal. What differs is policy, and all of it lives here:
 *
 *   - It belongs to the WORKSPACE. No expiry unless the owner sets one, and it keeps working after
 *     the person who created it leaves the organization (D-007). The creator (`user_email`) is
 *     recorded for display and for P-011's "creator removed" alert; nothing in verification or in
 *     the principal reads it, so no membership change can stop the key (R-10).
 *   - A spending cap is MANDATORY (R-13): a key that never expires must not be able to run up
 *     unlimited LLM spend once leaked. `resolveSpendCap` refuses a service key without one, and
 *     migration 1252's CHECK refuses it again at the storage layer.
 *   - Rotation has an OVERLAP window (R-11/R-12): rotating keeps the key's id, scopes and cap, mints
 *     a new secret, and keeps the old secret valid until a deadline so the app can be re-configured
 *     with no downtime. `rotationOverlapSec` bounds that window.
 *
 * Cap shape = goals.budget_cents + budget_window_sec (migration 914): a ceiling in US cents over a
 * trailing window of seconds; a null window means the key's whole lifetime. P-011 enforces caps.
 */

/** The kinds of connected_apps row that carry a `pcapp_` bearer (a phone uses its device JWT). */
export type AppKeyKind = 'app' | 'service';

export const APP_KEY_KINDS: readonly AppKeyKind[] = ['app', 'service'];

/** Default trailing window for a spending cap when the caller names a cap but no window: 30 days. */
export const DEFAULT_SPEND_CAP_WINDOW_SEC = 30 * 24 * 60 * 60;

/** Default rotation overlap: the old secret keeps working for a day. */
export const DEFAULT_ROTATION_OVERLAP_SEC = 24 * 60 * 60;

/** Longest rotation overlap: past this, an old secret is effectively a second permanent key. */
export const MAX_ROTATION_OVERLAP_SEC = 30 * 24 * 60 * 60;

/** Largest cap accepted, in cents: well inside float64 integer precision and bigint range. */
export const MAX_SPEND_CAP_CENTS = 100_000_000_000; // $1 billion

export interface SpendCapProblem {
  field: 'spendCapCents' | 'spendCapWindowSec';
  value: unknown;
  reason: string;
}

/** Thrown when a key's requested spending cap is missing (service keys) or malformed. */
export class SpendCapError extends Error {
  constructor(readonly problems: readonly SpendCapProblem[]) {
    super(`spending cap refused: ${problems.map((p) => `${p.field} ${JSON.stringify(p.value)} — ${p.reason}`).join('; ')}`);
    this.name = 'SpendCapError';
  }
}

export interface ResolvedSpendCap {
  spendCapCents: number | null;
  spendCapWindowSec: number | null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Normalize and check a requested spending cap for a key of `kind`.
 *
 * - `spendCapCents`: a positive whole number of cents. REQUIRED for a service key (R-13); optional
 *   for an app key, where omitted or null means "no per-key cap" (the workspace's own limits still
 *   apply).
 * - `spendCapWindowSec`: the trailing window. Omitted = 30 days. Explicit null = the key's whole
 *   lifetime. Only meaningful with a cap, so it is refused on an uncapped key.
 *
 * Throws `SpendCapError` listing every problem.
 */
export function resolveSpendCap(
  kind: AppKeyKind,
  req: { spendCapCents?: number | null; spendCapWindowSec?: number | null },
): ResolvedSpendCap {
  const problems: SpendCapProblem[] = [];
  const cents = req.spendCapCents;
  const window = req.spendCapWindowSec;
  const hasCap = cents !== undefined && cents !== null;

  if (!hasCap) {
    if (kind === 'service') {
      problems.push({
        field: 'spendCapCents',
        value: cents ?? null,
        reason: 'a service key must have a spending cap (it never expires by default, so a leaked key must not be able to spend without limit)',
      });
    }
    if (window !== undefined && window !== null) {
      problems.push({ field: 'spendCapWindowSec', value: window, reason: 'a window needs a spending cap to apply to' });
    }
  } else if (!isPositiveInteger(cents) || cents > MAX_SPEND_CAP_CENTS) {
    problems.push({
      field: 'spendCapCents',
      value: cents,
      reason: `must be a whole number of cents between 1 and ${MAX_SPEND_CAP_CENTS}`,
    });
  }
  if (hasCap && window !== undefined && window !== null && !isPositiveInteger(window)) {
    problems.push({ field: 'spendCapWindowSec', value: window, reason: 'must be a positive whole number of seconds, or null for the key\'s whole lifetime' });
  }
  if (problems.length > 0) throw new SpendCapError(problems);

  if (!hasCap) return { spendCapCents: null, spendCapWindowSec: null };
  return {
    spendCapCents: cents,
    spendCapWindowSec: window === undefined ? DEFAULT_SPEND_CAP_WINDOW_SEC : window,
  };
}

/** Thrown when a requested rotation overlap is outside 0..MAX_ROTATION_OVERLAP_SEC. */
export class RotationOverlapError extends Error {
  constructor(readonly value: unknown) {
    super(`rotation overlap refused: ${JSON.stringify(value)} — must be a whole number of seconds between 0 and ${MAX_ROTATION_OVERLAP_SEC}`);
    this.name = 'RotationOverlapError';
  }
}

/**
 * The overlap window for a rotation, in seconds. Omitted = one day. Zero is allowed and means an
 * immediate cutover: the old secret is refused from the moment of rotation (use it after a leak).
 */
export function rotationOverlapSec(requested?: number | null): number {
  if (requested === undefined || requested === null) return DEFAULT_ROTATION_OVERLAP_SEC;
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 0 || requested > MAX_ROTATION_OVERLAP_SEC) {
    throw new RotationOverlapError(requested);
  }
  return requested;
}

/**
 * True while a rotated-out secret is still inside its overlap window. The deadline is exclusive:
 * at `validUntil` itself the old secret is already refused, so a zero overlap is a true cutover.
 */
export function previousKeyStillValid(validUntil: Date | null | undefined, now: Date): boolean {
  return validUntil instanceof Date && validUntil.getTime() > now.getTime();
}
