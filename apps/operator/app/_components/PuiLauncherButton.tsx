'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * PuiLauncherButton — the "PUI" CTA next to OPS in the global header. Opens
 * the `pui` ratatui workbench (apps/tui) in an OS-native terminal via a
 * server-side spawn (POST /api/adv/sessions/launch-pui → launch-pui.ts).
 *
 * Renders alongside the OPS button on every chrome page (the brief: "next to
 * the OPS button"). The launch only makes sense when the operator host is
 * local (the desktop), which is the shipping target; the route surfaces a
 * clear toast if no terminal / no pui binary is found.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */

import { useState } from 'react';
import { toast } from 'sonner';

import { launchPuiWorkbench } from '@papercusp/operator-core/lib/pui-launch';
import { TerminalMark } from './ChromeNavMarks';

export function PuiLauncherButton() {
  const [busy, setBusy] = useState(false);

  return (
    <Tooltip label="Open the pui workbench in a terminal"><button
      type="button"
      className="pc-header-cta pc-header-cta--mission"
      aria-label="Open the pui workbench in a terminal"
      aria-busy={busy}

      disabled={busy}
      style={busy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
      onClick={async () => {
        setBusy(true);
        try {
          const { terminal } = await launchPuiWorkbench();
          toast.success(`pui workbench launched (${terminal}).`, { duration: 4000 });
        } catch (e: any) {
          toast.error(`pui launch failed: ${e?.message ?? 'unknown error'}`, {
            duration: 10000,
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="pc-header-cta-orb" aria-hidden="true">
        <TerminalMark className="pc-header-cta-logo pc-header-cta-logo--pui" />
      </span>
      <span className="pc-header-cta-label">PUI</span>
    </button></Tooltip>
  );
}
