'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from '@/lib/router-compat/navigation';
import { toast } from 'sonner';

/**
 * Paths where the welcome toast should NOT fire. A user landing on
 * /login or /signup is explicitly trying to authenticate — telling them
 * they're auto-signed-in as someone else while they're trying to switch
 * is confusing and wrong.
 *
 * The /login submit path is also covered by the sessionStorage flag
 * check inside the effect, but suppression here is the simpler signal
 * for the "user navigated to /login to switch" case.
 */
const SUPPRESSED_PATHS: readonly string[] = ['/login', '/signup'];

/**
 * Mounts in the chrome and fires a toast when the user is silently
 * auto-logged-in (default user, no cookie) or returns after a daily
 * 4am-local reset.
 *
 * Suppression model — per-user:
 *   - `papercusp_user_welcomed_<userId>` stores the last welcome ms.
 *   - We compute the most recent 4am-local boundary. If the stored ts
 *     is BEFORE that boundary, fire the toast and update the stamp.
 *   - First-time-ever-for-this-user has no stamp → fires.
 *
 * This is intentionally NOT the same path as the explicit-login
 * welcome (set in /login → consumed by OperatorConversationProvider →
 * fires user_welcomed converse trigger). That stays brain-side; this
 * is chrome-side and only fires the toast.
 *
 * Suppressed entirely:
 *   - When `sessionStorage.papercusp_just_logged_in` is set (the user
 *     literally just submitted /login — they already saw the toast
 *     and don't need a duplicate).
 *   - When the chrome's auth probe says `autoLogin: false` AND we've
 *     already welcomed within the current 4am window.
 */

interface MeResponse {
  user?: { id: string; display_name: string } | null;
  autoLogin?: boolean;
  /**
   * Set by /api/auth/me when PG is unreachable and the response is a
   * synthetic default user with a sentinel UUID. We skip the welcome
   * toast entirely in that mode — writing a stamp keyed on the
   * synthetic UUID would cause a duplicate welcome to fire the next
   * time PG recovers (the real default user has a different UUID).
   */
  pgUnavailable?: boolean;
}

/** Compute the most recent 4am-local epoch ms boundary at or before `now`. */
function lastReset4amLocalMs(now: number): number {
  const d = new Date(now);
  const today4am = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime();
  return now >= today4am ? today4am : today4am - 24 * 60 * 60 * 1000;
}

export default function AutoLoginWelcomeToast() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Pathname suppression — user on /login or /signup is trying to
    // authenticate, the toast would race their intent. ChromeShell
    // does mount on these paths (not in CHROMELESS_PATH_PREFIXES) so
    // we have to suppress here.
    if (pathname && SUPPRESSED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return;
    }

    // Don't fire if the explicit-login flow just ran — /login set this
    // flag and the OperatorConversationProvider will consume it for the
    // brain greeting. Chrome toast would be a duplicate.
    let justLoggedIn = false;
    try {
      justLoggedIn = !!sessionStorage.getItem('papercusp_just_logged_in');
    } catch {
      /* sessionStorage unavailable */
    }
    if (justLoggedIn) return;

    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/auth/me');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as MeResponse;
        const user = j.user;
        if (!user) return;

        // Skip the toast when the synthetic-default-user fallback fired.
        // The synthetic UUID won't match the real default user's UUID
        // once PG recovers, so writing a welcome stamp here causes a
        // duplicate toast on next load. Defer to a real /me response.
        if (j.pgUnavailable) return;

        const now = Date.now();
        const boundary = lastReset4amLocalMs(now);
        const stampKey = `papercusp_user_welcomed_${user.id}`;
        let lastMs = 0;
        try {
          const raw = localStorage.getItem(stampKey);
          lastMs = raw ? Number.parseInt(raw, 10) : 0;
          if (!Number.isFinite(lastMs)) lastMs = 0;
        } catch {
          /* localStorage unavailable — fall through; toast will fire each load */
        }

        if (lastMs >= boundary) return; // already welcomed this 4am window

        const isFirstEver = lastMs === 0;
        const message = isFirstEver
          ? `Signed in as ${user.display_name}`
          : `Welcome back, ${user.display_name}`;

        try {
          localStorage.setItem(stampKey, String(now));
        } catch {
          /* fine — toast will just re-fire next time, which is acceptable */
        }

        toast(message, {
          duration: 8_000,
          action: {
            label: 'Not you? Switch',
            onClick: () => router.push('/login?switch=1'),
          },
        });
      } catch {
        /* network failure — no-op */
      }
    })();

    return () => {
      cancelled = true;
    };
    // pathname-dependent — re-run when the user navigates between
    // chromed routes. The 4am boundary check inside ensures we
    // don't double-toast within a window even if pathname changes
    // multiple times.
  }, [pathname, router]);

  return null;
}
