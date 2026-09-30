'use client';

import { useEffect, useState } from 'react';
import { commands } from '@papercusp/operator-core/lib/tauri-bindings';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';
import { canUseContentOriginDesktopActions } from '@/lib/ipc-status-tauri';

// D-004 (operator-chat-sidebar-revival-2026-07-13 P-014): the native
// zellij/pui dock is TESTING-gated but stays bundled. Rust no longer spawns
// it at boot — it cannot read the client-loaded flag store — so this
// component is the webview side of the seam: it relays the resolved
// FLAGS.TESTING to `native_terminal_set_enabled` once flags load, and again
// on any live flip (flag on → spawn the dock, off → shut it down, no
// relaunch needed). Uses the reactive `@/lib/flag-hooks` useFlag (NOT the
// plain `@papercusp/flags/client` read) so a live /admin/features flip
// re-relays. Renders nothing.
export default function NativeTerminalGate() {
  const testing = useFlag(FLAGS.TESTING);
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void canUseContentOriginDesktopActions().then((allowed) => {
      if (!cancelled) setDesktop(allowed);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void commands.nativeTerminalSetEnabled(testing).then((res) => {
      if (res.status === 'error') {
        // Non-fatal: the dock simply stays in its previous state. Surfaced
        // for debuggability (e.g. an old Rust binary without the command).
        console.warn(
          '[NativeTerminalGate] native_terminal_set_enabled failed:',
          res.error,
        );
      }
    });
  }, [desktop, testing]);

  return null;
}
