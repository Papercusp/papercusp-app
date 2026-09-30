/**
 * useWslGateBlocking — read-only mirror of WslOnboardingGate's "is the
 * full-screen onboarding overlay showing right now" condition, for chrome
 * components mounted OUTSIDE the gate's subtree in the router root
 * (`apps/operator-vite/src/routes/__root.tsx`) that must not visually
 * bleed through it.
 *
 * WI-2749 item #2: `LeftSidebar` (z-index 1290) and `PresenceRail`
 * (z-index 900) are `position: fixed` siblings mounted BEFORE
 * `<WslOnboardingGate>` in the root tree — the gate itself is only
 * `zIndex: 60`, so during Windows WSL onboarding those two panels render
 * ON TOP of the "Papercusp setup — Windows" overlay (confirmed via static
 * z-index audit: LeftSidebar's `left-sidebar.styles.ts` sets
 * `z-index: 1290`, PresenceRail sets `zIndex: 900`, both well above the
 * gate's 60). This is exactly what the item's CDP innerText probe caught
 * ("the onboarding gate heading alongside app-shell/Brain-panel text").
 *
 * Rather than raise the gate's z-index (which would also cover the
 * intentionally-"unkillable" EnvSwitcherBar / TerminalDivider escape
 * hatches — see EnvSwitcherBar's own doc comment — those must stay
 * reachable even mid-onboarding), the root simply skips mounting the two
 * data-bearing panels while onboarding is blocking.
 *
 * IMPORTANT: this hook is READ-ONLY. It must NEVER call `wslInstall` /
 * `wslImport` / `wslBootstrap` / `wslFinalizeReady` — WslOnboardingGate is
 * the single owner of those one-shot side effects. Two independent
 * instances both auto-triggering them would double-run the install/import
 * flow. This hook only polls `wsl_status` (a cheap, idempotent read) to
 * decide chrome visibility.
 */
'use client';

import { useEffect, useState } from 'react';
import { isTauri, wslStatus } from '@papercusp/operator-core/lib/wsl-tauri';

const POLL_MS = 1500;

export function useWslGateBlocking(): boolean {
  const [blocking, setBlocking] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    const check = async () => {
      try {
        const s = await wslStatus();
        if (cancelled) return;
        // No status (denied ACL / non-Tauri) or a pass-through state ⇒ the
        // gate isn't blocking — fail safe to "not blocking" like the gate
        // itself does, so chrome never gets stuck permanently hidden.
        if (!s) {
          setBlocking(false);
          return;
        }
        setBlocking(s.state.kind !== 'NotSupported' && s.state.kind !== 'Ready');
      } catch {
        if (!cancelled) setBlocking(false);
      }
    };

    void check();
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return blocking;
}
