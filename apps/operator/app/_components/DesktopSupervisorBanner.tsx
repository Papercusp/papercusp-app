/**
 * Persistent in-app banner for the desktop supervisor's two TERMINAL states
 * (WI-5392).
 *
 * The Rust supervisor has always emitted two webview events alongside its OS
 * notifications — `operator-dead` (WI-1878: auto-respawn gave up past the cap)
 * and `install-broken` (WI-5390: the install is missing its sidecar, so no
 * amount of respawning can help). Both emit sites were written "for an in-app
 * persistent banner"; that banner did not exist, so nothing in the tree ever
 * called `listen()` for either event and the OS notification was the only
 * channel that actually reached a user. This is that listener.
 *
 * WHY A BANNER AND NOT A TOAST. Both states are PERMANENT until the user acts,
 * and an OS notification is transient — dismissed, missed while backgrounded,
 * or suppressed entirely if notifications are muted/off. A sticky banner is the
 * surface that still holds the message ten minutes later.
 *
 * PRECEDENCE. `install-broken` outranks `operator-dead` and is not
 * downgradable: a broken install is the terminal explanation for the dead
 * operator, and the two asks are contradictory ("wait, it's retrying" vs.
 * "waiting cannot help — reinstall"). Once an install defect is latched, a
 * later `operator-dead` must not overwrite it with the wait-it-out wording.
 *
 * NOT DISMISSABLE. There is no close button by design — the condition, not the
 * user, clears this. `operator-dead` self-clears when the operator comes back
 * (WI-3270 made give-up recoverable: respawns resume once the cap window
 * drains, so a live transport is proof of recovery); `install-broken` never
 * self-clears, because nothing short of a reinstall resolves it.
 *
 * STATE PLACEMENT. Deliberately `useState`, not nuqs: this is push-driven
 * process-failure lifecycle, not user-meaningful navigation state. Putting it
 * in the URL would let a user paste themselves a fake "your install is broken"
 * banner, and would survive into a session where the condition is long gone —
 * both worse than useState. (CLAUDE.md's nuqs rule lists error/loading
 * lifecycle as the explicit useState case.)
 *
 * NO RESTART BUTTON. The copy says "restart the app" rather than offering a
 * button because the desktop exposes no app-relaunch command to the webview —
 * inventing one is a separate change, and a dead button is worse than a clear
 * instruction. The wording matches the OS notification body so the two
 * channels never disagree.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useSyncConnectivity } from '@papercusp/sync';
import { canUseContentOriginDesktopActions } from '@/lib/ipc-status-tauri';
import {
  parseOperatorDeadPayload,
  type OperatorDeadPayload,
} from '@papercusp/operator-core/lib/cross-boundary-event-contracts';

export function DesktopSupervisorBanner() {
  const [dead, setDead] = useState<OperatorDeadPayload | null>(null);
  // The install defect message, verbatim from Rust. Latched: once true it is
  // never cleared by a subsequent event (see PRECEDENCE above).
  const [installBroken, setInstallBroken] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  const { offline } = useSyncConnectivity();

  useEffect(() => {
    let cancelled = false;
    void canUseContentOriginDesktopActions().then((allowed) => {
      if (!cancelled) setDesktop(allowed);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const track = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };

    void Promise.all([
      import('@papercusp/operator-core/lib/tauri-bindings'),
      import('@tauri-apps/api/event'),
    ])
      .then(async ([{ events }, { listen }]) => {
        // Registered together so neither event can land in the gap between two
        // separate awaits — both fire exactly once per episode, so a missed
        // one is missed for good.
        const [operatorDeadUnlisten, installBrokenUnlisten] = await Promise.all([
          events.operatorDead.listen((e) => {
            const payload = parseOperatorDeadPayload(e.payload);
            if (payload) setDead(payload);
          }),
          listen<string>('install-broken', (e) => {
            setInstallBroken(e.payload || 'Papercusp is missing part of its installation.');
          }),
        ]);
        track(operatorDeadUnlisten);
        track(installBrokenUnlisten);
      })
      .catch(() => {
        /* no event API (very old webview) — the OS notification remains the
         * only channel, exactly as before this component existed. */
      });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [desktop]);

  // Recovery: a live transport means the operator answered, so a previously
  // given-up respawn cycle has since succeeded. Only clears the RETRYING state
  // — a broken install is terminal and stays latched even if some transport
  // briefly reports healthy.
  //
  // The `sawOffline` gate closes a race that would otherwise make this banner
  // unshowable: `operator-dead` is emitted the instant the supervisor gives up,
  // which is BEFORE useSyncConnectivity necessarily notices the transport
  // dropped (it polls/reconnects on its own schedule). Clearing on a bare
  // `!offline` would then wipe the banner on the very next render — the user
  // sees a flash, or nothing at all. So we require having actually observed the
  // transport DOWN since the event before treating a subsequent UP as recovery.
  const sawOffline = useRef(false);
  useEffect(() => {
    if (!dead) return;
    if (offline) sawOffline.current = true;
    else if (sawOffline.current) setDead(null);
  }, [offline, dead]);

  if (installBroken) {
    return (
      <div role="alert" style={{ ...banner, ...badTone }}>
        <div style={{ flex: 1 }}>
          <strong>Papercusp installation is incomplete.</strong>{' '}
          {installBroken}{' '}
          Reinstall Papercusp to fix this — waiting will not recover it.
        </div>
      </div>
    );
  }

  if (dead) {
    return (
      <div role="alert" style={{ ...banner, ...warnTone }}>
        <div style={{ flex: 1 }}>
          <strong>Papercusp stopped responding.</strong>{' '}
          Auto-restart is backing off after {dead.respawns} failed attempts in{' '}
          {dead.window_secs}s ({dead.reason}). Retries continue in the background;
          restart the app to recover immediately.
        </div>
      </div>
    );
  }

  return null;
}

// Shares HostCheckBanner's fixed slot (top: 56) but sits one layer ABOVE it
// (zIndex 1001 vs 1000). Both are fixed-position, so on the rare host that
// trips both, this one deliberately covers the other: a dead operator or a
// broken install is unrecoverable-until-you-act, while the shared-host notice
// is an advisory the user acknowledges once. The buried banner is not lost —
// this one clears on recovery (or on reinstall), revealing it again.
const banner: React.CSSProperties = {
  position: 'fixed', top: 56, left: 0, right: 0, zIndex: 1001,
  display: 'flex', alignItems: 'center', gap: 16,
  padding: '10px 16px', fontSize: 13,
};
const warnTone: React.CSSProperties = {
  background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn)', color: 'var(--warn)',
};
const badTone: React.CSSProperties = {
  background: 'var(--bad-bg)', borderBottom: '1px solid var(--bad)', color: 'var(--bad)',
};

export default DesktopSupervisorBanner;
