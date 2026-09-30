'use client';

/**
 * DogfoodBootstrapBanner — the slim, NON-blocking top bar shown WHENEVER the
 * "Papercusp dogfood hive clone-on-first-boot" is in progress (clone-on-first-
 * boot stage 2 / desktop UI, part A). Mounted once at the router root
 * (__root.tsx) inside RootSyncProvider so it overlays EVERY route and the rest
 * of the app / setup stays fully usable beneath it.
 *
 * Visibility is settled from REAL sync rows (the honesty rule from
 * EntryGithubUrlForm — never fabricate a checkmark):
 *   - appears once `hiveFromRepo.progress` rows for BOOTSTRAP_PROGRESS_ID exist
 *     AND the flow is in progress (not all-terminal, no error → see
 *     reduceBootstrapRows.inProgress);
 *   - auto-HIDES the moment the flow is ready (submodules done/skipped) or when
 *     there are simply no rows (off desktop / not triggered).
 *
 * An ERROR also surfaces here (red bar) so a wedged clone is visible app-wide;
 * the actionable Retry lives in the setup-finish gate (this bar is informational
 * only, to keep the chrome non-interactive and out of the way).
 */

import { useState } from 'react';
import {
  useDogfoodBootstrapProgress,
  bootstrapStepLabel,
} from './useDogfoodBootstrapProgress';

export function DogfoodBootstrapBanner() {
  const p = useDogfoodBootstrapProgress();
  // Session-dismiss (WI-791, public-release): the dogfood clone is best-effort /
  // non-fatal, and a PUBLIC user can't access the private submodules at all — so a
  // terminal-error bar must be DISMISSIBLE, never an app-wide nag the user can't
  // clear. (Progress auto-hides on its own when the flow goes ready.)
  const [dismissed, setDismissed] = useState(false);

  // Show only while genuinely in progress, or on a hard error. Ready / no rows →
  // hidden (auto-hide). This keeps the chrome clear once the workspace lands.
  if (!p.hasRows) return null;
  if (!p.inProgress && !p.hasError) return null;
  if (dismissed) return null;

  const label = bootstrapStepLabel(p.activeStep);
  const pct = p.activePercent;
  const detail = p.activeDetail;
  const isError = p.hasError;
  // A transient GitHub-connect timeout (EI-3548): the finish gate is auto-retrying,
  // so phrase this as a recoverable network blip — never a terminal "failed" that
  // implies re-authenticating GitHub (which can't fix a network timeout).
  const isNetworkError = isError && p.networkError;
  // git not available (macOS CLT-stub / not installed) — a user-action error;
  // point at setup rather than implying a retry will fix it.
  const isGitMissing = isError && p.gitMissing;
  // The bootstrap parks the clone at 0% `running` with a "Sign in to GitHub…"
  // detail when auth isn't ready yet (bootstrap-papercusp-hive AWAITING_GH_SIGNIN_DETAIL).
  // Surface that prompt as the headline (and keep the 0% bar visible) instead of
  // the generic "Downloading…" label.
  const awaitingAuth = !isError && !!detail && /sign in to github/i.test(detail);

  return (
    <div
      data-testid="dogfood-bootstrap-banner"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        // EI-9921: stack BELOW the persistent env-switcher bar instead of
        // eclipsing it. EnvSwitcherBar publishes its measured height as
        // `--pc-env-bar-h` on <html> while shown (see its own top offset +
        // globals.css's .pc-header rule for the same pattern); the var is
        // unset when the env bar isn't mounted (off-desktop / no envs), so
        // the 0px fallback keeps this banner flush to the viewport top there.
        top: 'var(--pc-env-bar-h, 0px)',
        // WI-4729: the HORIZONTAL half of the same clearance convention as the
        // `top` offset above — EI-9921 stopped this bar eclipsing the
        // EnvSwitcherBar vertically, but at `left: 0` it still spans the full
        // viewport width at that same top, so its ~2.1e9 z-index covered the
        // dock headers. D-009 puts steering/settings first and Papercup chat
        // second; both publish their rendered widths, so clear their FULL sum.
        // Each 0px fallback keeps the bar flush left when that dock is absent.
        left: 'calc(var(--left-sidebar-w, 0px) + var(--op-chat-w, 0px))',
        right: 0,
        zIndex: 2147483645, // just under the sonner Toaster (…646)
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 14px',
        fontSize: 12.5,
        fontWeight: 600,
        color: isError ? 'var(--bad, #ef4444)' : 'var(--fg, #e8e8e8)',
        // OPAQUE, high-contrast bar — never the translucent `--bg-2` glass tier
        // (rgba ~0.045 alpha), which rendered the bar nearly invisible. Solid
        // `--bg-1` is opaque in every theme; the accent border + glow make the
        // active setup state clearly visible app-wide.
        background: isError ? 'var(--bad-bg-solid, #2a1618)' : 'var(--bg-1, #0b1220)',
        borderBottom: `2px solid ${isError ? 'var(--bad, #ef4444)' : 'var(--accent, #6366f1)'}`,
        boxShadow: isError
          ? '0 2px 10px rgba(239,68,68,0.25)'
          : '0 2px 10px rgba(0,0,0,0.45)',
        // Non-blocking: the fixed wrapper never traps pointer/scroll for the rest
        // of the app. Interactive descendants opt back in explicitly below.
        pointerEvents: 'none',
      }}
    >
      <style>{`@keyframes pc-dogfood-spin { to { transform: rotate(360deg); } }`}</style>
      {isError ? (
        <span aria-hidden="true" style={{ fontWeight: 700 }}>✕</span>
      ) : (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            minWidth: 12,
            border: '2px solid var(--accent, #6366f1)',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'pc-dogfood-spin 0.7s linear infinite',
          }}
        />
      )}
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {isGitMissing ? (
          <>Papercusp’s built-in workspace needs git — optional; the app works without it.</>
        ) : isNetworkError ? (
          <>Couldn’t reach GitHub for the built-in workspace (network) — retrying…</>
        ) : isError ? (
          <>Papercusp’s built-in workspace didn’t finish downloading — the app works fine without it.</>
        ) : awaitingAuth ? (
          <>Setting up Papercusp workspace — <strong>{detail}</strong></>
        ) : (
          <>
            Setting up Papercusp workspace — {label}
            {detail ? <span style={{ color: 'var(--fg-mute, #888)' }}> ({detail})</span> : null}
            {pct != null ? <> {pct}%</> : null}
          </>
        )}
      </span>
      {/* Thin progress bar fed by the measured percent (when present). */}
      {!isError && pct != null && (
        <span
          aria-hidden="true"
          style={{
            position: 'relative',
            flex: 1,
            height: 3,
            minWidth: 40,
            maxWidth: 240,
            borderRadius: 2,
            background: 'var(--border, #2a2d36)',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              position: 'absolute',
              inset: 0,
              width: `${pct}%`,
              background: 'var(--accent, #6366f1)',
              borderRadius: 2,
              transition: 'width 240ms ease',
            }}
          />
        </span>
      )}
      {/* Dismiss (WI-791): always available so the bar is never an unclearable
          nag — essential on a terminal error a public user can't resolve. */}
      <button
        type="button"
        data-testid="dogfood-bootstrap-dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          marginLeft: 'auto',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          opacity: 0.7,
          cursor: 'pointer',
          fontSize: 15,
          lineHeight: 1,
          padding: '0 2px',
          // The wrapper is intentionally pointer-transparent; keep dismissal
          // as the one browser hit target inside it.
          pointerEvents: 'auto',
        }}
      >
        ×
      </button>
    </div>
  );
}

export default DogfoodBootstrapBanner;
