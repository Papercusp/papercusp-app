'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * ConsoleLauncherButton — the "+" button in the global chrome that
 * opens an OS-native terminal in the active harness's directory with
 * env + .mcp.json pre-configured for superuser MCP access.
 *
 * The icon shows a terminal/console glyph (rounded rectangle with `>_`),
 * not a literal `+`, per user's review of the v2 plan.
 *
 * Flow: click → POST /api/agent-mcp/console/resolve → Tauri
 * console_launch command → native terminal opens in a new window.
 *
 * Visible only inside the Tauri desktop app. In the browser-served
 * dev mode (no Tauri bridge), the button hides itself rather than
 * showing a button that does nothing.
 */

import { useEffect, useState } from 'react';
import { usePathname } from '@/lib/router-compat/navigation';
import { toast } from 'sonner';

import { launchNativeConsole, isConsoleLauncherSupported } from '@papercusp/operator-core/lib/native-console';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';

export function ConsoleLauncherButton() {
  const [busy, setBusy] = useState(false);
  // Click counter — defensive parse so HMR state weirdness can't
  // produce NaN (React warns 'Received NaN for children attribute'
  // when that happens, which we saw in the user's Tauri devtools).
  const [clickCount, setClickCount] = useState<number>(0);
  const pathname = usePathname();
  const harnessSlug = extractHarnessSlug(pathname ?? '');
  // psu-in-desktop-builds-2026-06-23 B: the discoverable "superuser session"
  // entry only appears when the owner-authority PSU_END_USER flag is on. The
  // server re-checks the flag before honoring runPsu (defense-in-depth).
  const psuEnabled = useFlag(FLAGS.PSU_END_USER);

  const launchPsu = async () => {
    setBusy(true);
    try {
      await launchNativeConsole({ slug: harnessSlug, runPsu: true });
      toast.success('Superuser session (psu) launched.', { duration: 4000 });
    } catch (e: any) {
      toast.error(`psu launch failed: ${e?.message ?? 'unknown error'}`, { duration: 10000 });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    console.info('[console-launcher] mounted', {
      hasTauriInternals: typeof (window as any).__TAURI_INTERNALS__,
      tauriInvokeType: typeof (window as any).__TAURI_INTERNALS__?.invoke,
      pageOrigin: window.location.origin,
    });
    // Manual trigger from devtools: window.__papercupLaunchTerminal()
    (window as any).__papercupLaunchTerminal = () => {
      console.info('[console-launcher] manual trigger from window');
      launchNativeConsole({ slug: null }).catch((e) =>
        console.error('[console-launcher] manual trigger failed', e),
      );
    };
  }, []);

  const tooltip = harnessSlug
    ? `Launch terminal in ${harnessSlug}`
    : 'Launch terminal in workspace root';

  return (
    <>
    <Tooltip label={tooltip}><button
      type="button"
      className={`pc-console-btn${busy ? ' is-busy' : ''}`}
      aria-label="Launch terminal"

      disabled={busy}
      onMouseDown={() => console.info('[console-launcher] mousedown')}
      onClick={async () => {
        // Defensive: cast to number so HMR-preserved state can't
        // produce NaN. setState fn-form means we don't rely on stale
        // closure variable either.
        setClickCount((c) => (Number.isFinite(c) ? c + 1 : 1));
        console.info('[console-launcher] button clicked', { harnessSlug });
        setBusy(true);
        try {
          await launchNativeConsole({ slug: harnessSlug });
          toast.success('Terminal launched.', { duration: 4000 });
        } catch (e: any) {
          console.error('[console-launcher] launch failed', e);
          toast.error(`Terminal launch failed: ${e?.message ?? 'unknown error'}`, {
            duration: 10000,
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <ConsoleIcon />
      {clickCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -6,
            right: -6,
            background: 'var(--good)',
            color: '#021016',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            padding: '1px 5px',
            pointerEvents: 'none',
            lineHeight: 1,
          }}
        >
          {clickCount}
        </span>
      )}
    </button></Tooltip>
    {psuEnabled && (
      <Tooltip label={`Open a superuser session (psu)${harnessSlug ? ` in ${harnessSlug}` : ''}`}>
        <button
          type="button"
          className={`pc-console-btn pc-console-btn--psu${busy ? ' is-busy' : ''}`}
          aria-label="Open superuser session (psu)"
          disabled={busy}
          onClick={() => void launchPsu()}
        >
          <PsuIcon />
        </button>
      </Tooltip>
    )}
    </>
  );
}

function PsuIcon() {
  // A shield with a small terminal chevron — "elevated/superuser console".
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Shield outline */}
      <path d="M9 1.6 L15 3.8 V8.6 C15 12.2 12.4 14.8 9 16.4 C5.6 14.8 3 12.2 3 8.6 V3.8 Z" />
      {/* Prompt chevron inside */}
      <path d="M7 6.6 L9.2 8.4 L7 10.2" />
    </svg>
  );
}

function ConsoleIcon() {
  // Rounded rectangle with `>_` inside (terminal) + a small `+` badge
  // on the top-right corner so the affordance reads as "open new
  // console" not just "console". The badge sits on a filled accent
  // disc so it pops against the dark chrome background.
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Terminal body */}
      <rect x="1.6" y="3.2" width="14.8" height="11.6" rx="1.8" />
      {/* Prompt chevron */}
      <path d="M4.6 7.2 L7.0 9.0 L4.6 10.8" />
      {/* Cursor underscore */}
      <line x1="8.4" y1="11.6" x2="12.6" y2="11.6" />
      {/* "+" badge on the top-right corner — disc + crossing lines.
          stroke="none" + fill on the disc so it visually layers over
          the terminal outline; the cross uses a contrasting stroke. */}
      <circle cx="14.5" cy="3.5" r="3.1" fill="#0b1019" stroke="currentColor" strokeWidth="1.4" />
      <line x1="14.5" y1="1.9" x2="14.5" y2="5.1" strokeWidth="1.5" />
      <line x1="12.9" y1="3.5" x2="16.1" y2="3.5" strokeWidth="1.5" />
    </svg>
  );
}

function extractHarnessSlug(pathname: string): string | null {
  const m = pathname.match(/^\/harness\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
