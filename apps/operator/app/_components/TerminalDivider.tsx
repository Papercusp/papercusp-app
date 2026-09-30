'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { commands, type TerminalLayout } from '@papercusp/operator-core/lib/tauri-bindings';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { canUseContentOriginDesktopActions } from '@/lib/ipc-status-tauri';

// WI-3388 (owner ask 2026-07-08): the native terminal dock (a NATIVE
// view/window OUTSIDE this webview, docked LEFT — see
// papercusp-desktop/src-tauri/src/native_terminal.rs) is user-resizeable via
// a draggable divider, plus a full collapse to a thin re-open rail. Every
// backend (X11 glued Ghostty, Linux VTE, macOS SwiftTerm, Windows ConPTY)
// resizes its OWN native surface in response to `terminal_set_layout`; this
// component is the shared control surface, living entirely on the webview
// side of the seam.
//
// Why this works uniformly across every backend without knowing which one is
// live: the terminal is always docked LEFT and the webview is always the
// "remainder" — so the webview's OWN left edge (x=0) is exactly the seam,
// in every backend, with no coordination needed beyond that geometric fact.
// Collapsing simply frees the terminal's native space back to the GUI; the
// rail control below is what fills the now-flush left edge.

const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.6;
const RAIL_WIDTH_PX = 28;

function clampFraction(f: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, f));
}

/** Backends with an actual native surface to resize. NewWindow/Disabled have
 * no docked surface — nothing here to drag, so the divider stays unmounted. */
function hasDockedSurface(strategy: string): boolean {
  return strategy === 'glued-ghostty-x11' || strategy.startsWith('embedded-');
}

export default function TerminalDivider() {
  const enabled = useFlag(FLAGS.TERMINAL_DIVIDER);
  // WI-3388 live-verify (2026-07-17): the dock's own gate (FLAGS.TESTING,
  // relayed to Rust by NativeTerminalGate — see its module doc) opens
  // ASYNCHRONOUSLY relative to this component's mount: NativeTerminalGate is
  // a JSX sibling, so its `native_terminal_set_enabled` invoke and this
  // component's own `nativeTerminalStatus` check are dispatched in the same
  // tick with no ordering guarantee on which Tauri command completes first —
  // and `native_terminal_status` reports strategy:"disabled" outright
  // whenever the gate isn't open yet (main.rs `native_terminal_status`),
  // regardless of the real backend. A one-shot check that loses that race
  // never gets a second look, so the divider silently never appears — and a
  // LIVE flip of FLAGS.TESTING from /admin/features (no reload) is not a
  // race at all, it's a GUARANTEED miss, since nothing here used to react to
  // it. Depending on the same reactive `testing` value NativeTerminalGate
  // relays turns both the boot race and the live-flip case into a normal
  // re-render: this effect re-fires exactly when the gate could have opened.
  const testing = useFlag(FLAGS.TESTING);
  const [desktop, setDesktop] = useState(false);
  const [docked, setDocked] = useState(false);
  const [layout, setLayout] = useState<TerminalLayout | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, fraction: 0.42 });
  const rafRef = useRef<number | null>(null);
  const pendingFractionRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void canUseContentOriginDesktopActions().then((allowed) => {
      if (!cancelled) setDesktop(allowed);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!desktop || !enabled) return;
    let cancelled = false;
    // Bounded retry (belt-and-suspenders on top of the `testing` dependency
    // above): NativeTerminalGate's own `native_terminal_set_enabled` invoke
    // can still be in flight the instant `testing` flips, since it's a
    // SEPARATE async command with no ordering guarantee against this one —
    // a short backoff absorbs that last sliver of the race without polling
    // indefinitely once the gate is genuinely closed (FLAGS.TESTING off).
    const RETRY_DELAYS_MS = [150, 400, 900];
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        const status = await commands.nativeTerminalStatus();
        if (cancelled) return;
        const isDocked = hasDockedSurface(status.strategy);
        setDocked(isDocked);
        if (isDocked) {
          const l = await commands.terminalGetLayout();
          if (!cancelled) setLayout(l);
          return;
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay == null) return;
        await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop, enabled, testing]);

  const flushPendingFraction = useCallback(() => {
    rafRef.current = null;
    const f = pendingFractionRef.current;
    if (f == null) return;
    pendingFractionRef.current = null;
    void commands.terminalSetLayout(f, null).then((res) => {
      if (res.status === 'ok') setLayout(res.data);
    });
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      // Total docking-axis size ≈ the webview's own width scaled up by the
      // terminal's current share of it — an approximation (the backends
      // don't all define "fraction" against the identical axis basis — see
      // native_terminal.rs's `sibling_extent` vs `initial_split_position`),
      // good enough for a smooth drag feel; the native side still clamps to
      // its own configured min/max px regardless of what we send.
      const { x: startX, fraction: startFraction } = dragStartRef.current;
      const totalAxis = window.innerWidth / (1 - clampFraction(startFraction));
      const deltaPx = e.clientX - startX;
      const next = clampFraction(startFraction + deltaPx / totalAxis);
      pendingFractionRef.current = next;
      setLayout((prev) => (prev ? { ...prev, fraction: next } : prev));
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flushPendingFraction);
      }
    },
    [flushPendingFraction],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    // Final flush so the persisted value matches exactly where the pointer
    // let go, even if a rAF tick is still pending.
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingFractionRef.current != null) {
      const f = pendingFractionRef.current;
      pendingFractionRef.current = null;
      void commands.terminalSetLayout(f, null).then((res) => {
        if (res.status === 'ok') setLayout(res.data);
      });
    }
  }, [onPointerMove]);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!layout || layout.collapsed) return;
      e.preventDefault();
      draggingRef.current = true;
      dragStartRef.current = { x: e.clientX, fraction: layout.fraction };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    [layout, onPointerMove, onPointerUp],
  );

  const toggleCollapsed = useCallback(() => {
    if (!layout) return;
    const next = !layout.collapsed;
    void commands.terminalSetLayout(null, next).then((res) => {
      if (res.status === 'ok') setLayout(res.data);
    });
  }, [layout]);

  if (!desktop || !enabled || !docked || !layout) return null;

  return (
    <>
      {!layout.collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal"
          onPointerDown={onHandlePointerDown}
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            bottom: 0,
            width: 10,
            marginLeft: -5,
            zIndex: 2147483000,
            cursor: 'col-resize',
            background: 'transparent',
          }}
        />
      )}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={layout.collapsed ? 'Show terminal' : 'Hide terminal'}
        style={{
          position: 'fixed',
          left: 0,
          top: '50%',
          transform: 'translateY(-50%)',
          width: RAIL_WIDTH_PX,
          height: 56,
          zIndex: 2147483001,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--pc-border, rgba(255,255,255,0.14))',
          borderLeft: 'none',
          borderTopRightRadius: 8,
          borderBottomRightRadius: 8,
          background: 'var(--pc-surface-2, rgba(20,26,34,0.92))',
          color: 'var(--fg-mute, #9db4c4)',
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: 1,
        }}
      >
        {layout.collapsed ? '›' : '‹'}
      </button>
    </>
  );
}
