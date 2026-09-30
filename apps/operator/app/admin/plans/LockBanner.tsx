'use client';

/**
 * Lock-state banner (P-205).
 *
 * Renders a slim amber banner above the plan editor when the open
 * plan's file is held by an active lock — naming the holder, intent,
 * and remaining TTL. The banner re-computes the "expires in Ns"
 * countdown every second; the lock STATE itself is pushed, not polled —
 * usePlanLock subscribes to `planLock.byPath` and the lock writers emit on
 * acquire/release (P-025 of semantic-search-fingerprint-coverage-2026-08-03,
 * which retired the 30s timer this comment used to describe). The focus /
 * visibility-change re-fetch survives as the backstop for a dropped
 * fire-and-forget notify.
 *
 * Caller's responsibility: forcing read mode while `lock` is non-null.
 * PlanDetail does that — passing `readOnly` to PlanEditor anyway today
 * since Phase-3 Edit mode isn't shipped; once it is (P-301), the
 * caller flips readOnly back on whenever this banner is showing.
 */

import { useEffect, useState } from 'react';
import type { ActiveLock } from './plans-api';

interface Props {
  lock: ActiveLock | null;
}

export default function LockBanner({ lock }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!lock) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lock]);
  if (!lock) return null;
  const owner = lock.owner_label || lock.owner;
  const expiresMs = Date.parse(lock.expires_ts) - now;
  return (
    <div className="pc-lock-banner" role="status" aria-live="polite">
      <span className="pc-lock-banner__icon" aria-hidden>
        🔒
      </span>
      <div className="pc-lock-banner__copy">
        <strong>Locked</strong> by <code>{owner}</code>
        {lock.intent ? <> for <em>{lock.intent}</em></> : null}
        {' · '}
        <span className="pc-lock-banner__ttl">{formatTtl(expiresMs)}</span>
      </div>
    </div>
  );
}

function formatTtl(ms: number): string {
  if (ms <= 0) return 'expired';
  const s = Math.round(ms / 1000);
  if (s < 60) return `expires in ${s}s`;
  const m = Math.round(s / 60);
  return `expires in ${m}m`;
}
