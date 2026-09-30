'use client';

/**
 * WslOnboardingGate — wraps the app on the renderer side, intercepts
 * the render when running in the Tauri-on-Windows desktop app and the
 * embedded WSL2 environment isn't fully set up yet.
 *
 * Lifecycle, mirroring `wsl_setup.rs`:
 *
 *   NotSupported / Ready  → render children (normal app).
 *   NotInstalled          → "Install WSL2" button → kicks `wsl_install`.
 *                           After it returns we transition to PendingReboot.
 *   PendingReboot         → "Reboot Windows now / I'll do it myself" UI.
 *                           On next launch we re-check and proceed.
 *   InstalledNoDistro     → "Importing Papercusp runtime…" — runs
 *                           `wsl_import` automatically.
 *   PendingBootstrap      → "Configuring runtime…" — runs `wsl_bootstrap`
 *                           automatically.
 *   Error                 → show the message + a Retry button.
 *
 * We poll `wsl_status` after each step so the UI reacts to state
 * transitions without needing the Rust side to push events.
 */

import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { toast } from 'sonner';
import {
  isTauri,
  wslBootstrap,
  wslFinalizeReady,
  wslImport,
  wslInstall,
  wslRelaunchElevated,
  wslStatus,
  wslUninstall,
  type WslOpError,
  type WslStatus,
} from '@papercusp/operator-core/lib/wsl-tauri';
import { useConfirmDialog } from '../harness/useConfirmDialog';

function isWslOpError(e: unknown): e is WslOpError {
  return (
    typeof e === 'object'
    && e !== null
    && 'kind' in e
    && (e as WslOpError).kind !== undefined
  );
}

interface Props {
  children: ReactNode;
}

export default function WslOnboardingGate({ children }: Props) {
  const [status, setStatus] = useState<WslStatus | null | 'pending'>('pending');
  const [busy, setBusy] = useState<string | null>(null);
  const { askConfirm, confirmEl } = useConfirmDialog();
  const [logTail, setLogTail] = useState<string>('');
  // Track the prior state-kind so we can detect the transition into
  // Ready and trigger one app restart (so the Rust side spawns the
  // sidecar through wsl.exe). Without this guard, the restart would
  // also fire on the very first launch when the user already had a
  // working WSL setup — unnecessary churn.
  const priorKindRef = useRef<string | null>(null);
  const finalizingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setStatus(null);
      return;
    }
    try {
      const s = await wslStatus();
      setStatus(s);
    } catch (err) {
      // FAIL SAFE. On the dev devUrl origin wsl_status resolves (NotSupported on
      // Linux/macOS → handled above), so a THROW here means the invoke was
      // denied — which happens on every NON-dev env origin, where Tauri's ACL
      // blocks the app command ("wsl_status not allowed. Plugin not found").
      // Treat that as "nothing to set up" and render the app; never trap the user
      // behind the full-screen "Papercup setup — Windows" wizard they can't
      // dismiss (the bug this fixes: that screen appeared on prod/staging/local —
      // every env except dev).
      console.warn('[wsl-gate] wsl_status unavailable; passing through:', err);
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Restart the app on the PendingBootstrap → Ready transition so
  // setup() can spawn the sidecar through wsl.exe. We only fire when
  // the prior state was actually a non-Ready onboarding state — never
  // on a fresh launch where the user was already Ready.
  useEffect(() => {
    if (!status || status === 'pending') return;
    const kind = status.state.kind;
    const prior = priorKindRef.current;
    priorKindRef.current = kind;
    if (
      prior !== null
      && prior !== 'Ready'
      && prior !== 'NotSupported'
      && kind === 'Ready'
      && !finalizingRef.current
    ) {
      finalizingRef.current = true;
      void wslFinalizeReady().catch((err) => {
        // wslFinalizeReady triggers app.restart(); the only way control
        // returns is if it failed to start. Surface for the user.
        finalizingRef.current = false;
        toast.error(`Could not restart Papercusp: ${err}`, {
          description: 'Please quit and reopen.',
          duration: Infinity,
        });
      });
    }
  }, [status]);

  // PendingBootstrap auto-runs the bootstrap; InstalledNoDistro
  // auto-runs the import. The user only sees explicit buttons for
  // the ones that need their interactive consent (install + reboot).
  useEffect(() => {
    if (!status || status === 'pending') return;
    const kind = status.state.kind;
    if (kind === 'InstalledNoDistro' && busy !== 'import') {
      setBusy('import');
      void (async () => {
        try {
          await wslImport();
          await refresh();
        } catch (err) {
          setStatus({
            state: { kind: 'Error', message: String(err) },
            wslExeAvailable: status.wslExeAvailable,
            distros: status.distros,
            defaultVersion: status.defaultVersion,
          });
        } finally {
          setBusy(null);
        }
      })();
    }
    if (kind === 'PendingBootstrap' && busy !== 'bootstrap') {
      setBusy('bootstrap');
      void (async () => {
        try {
          const log = await wslBootstrap();
          setLogTail(log.split('\n').slice(-20).join('\n'));
          await refresh();
        } catch (err) {
          setStatus({
            state: { kind: 'Error', message: String(err) },
            wslExeAvailable: status.wslExeAvailable,
            distros: status.distros,
            defaultVersion: status.defaultVersion,
          });
        } finally {
          setBusy(null);
        }
      })();
    }
  }, [status, busy, refresh]);

  // Loading: render children optimistically. Status check is fast (<50ms);
  // a flash is worse than rendering the app and then showing the wizard.
  if (status === 'pending') return <>{children}</>;

  // Not Tauri or supported: pass through.
  if (status === null) return <>{children}</>;
  if (status.state.kind === 'NotSupported') return <>{children}</>;
  if (status.state.kind === 'Ready') return <>{children}</>;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg, #0a0a0f)',
        color: 'var(--fg, #e8e8ea)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Sits above normal app chrome but BELOW modal (z:100) + toast
        // (z:150) so the wrapper's confirmation modal can render over
        // the gate. The gate covers the whole viewport, so nothing
        // else competes for the layer.
        zIndex: 60,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          width: 'min(640px, 90vw)',
          padding: 32,
          background: 'var(--bg-2, #14141a)',
          border: '1px solid var(--border, #2a2a32)',
          borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>
          Papercusp setup — Windows
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--fg-mute, #9a9aa3)', margin: '0 0 24px', lineHeight: 1.55 }}>
          Papercusp runs inside a small Linux environment (WSL2) on Windows because
          its build tools are POSIX-native. We&apos;ll set it up for you — it takes
          about 5 minutes.
        </p>

        <Step status={status} busy={busy} onAction={refresh} logTail={logTail} askConfirm={askConfirm} />

        <Collapsible.Root style={{ marginTop: 24, fontSize: 12, color: 'var(--fg-mute, #9a9aa3)' }}>
          <Collapsible.Trigger style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
            Diagnostics
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre
              style={{
                fontSize: 11,
                padding: 12,
                background: 'rgba(0,0,0,0.25)',
                borderRadius: 6,
                overflow: 'auto',
                maxHeight: 200,
                marginTop: 8,
              }}
            >
              {JSON.stringify(status, null, 2)}
              {logTail ? '\n\n' + logTail : ''}
            </pre>
            <button
              type="button"
              onClick={async () => {
                const ok = await askConfirm({
                  title: 'Reset the Papercusp runtime?',
                  body: 'This removes the WSL distro and you will have to reinstall.',
                  confirmLabel: 'Reset',
                  destructive: true,
                });
                if (!ok) return;
                await wslUninstall();
                await refresh();
              }}
              style={{
                marginTop: 8,
                padding: '6px 12px',
                fontSize: 12,
                background: 'transparent',
                border: '1px solid var(--border, #2a2a32)',
                color: 'var(--fg-mute, #9a9aa3)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Reset runtime
            </button>
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
      {confirmEl}
    </div>
  );
}

function Step({
  status,
  busy,
  onAction,
  logTail,
  askConfirm,
}: {
  status: WslStatus;
  busy: string | null;
  onAction: () => void;
  logTail: string;
  askConfirm: ReturnType<typeof useConfirmDialog>['askConfirm'];
}) {
  const { state } = status;
  switch (state.kind) {
    case 'NotInstalled':
      return (
        <div>
          <p style={{ margin: '0 0 16px', lineHeight: 1.55 }}>
            Click below to install WSL2. You&apos;ll see a Windows admin prompt — accept it.
            After install, your computer needs to reboot.
          </p>
          <button
            type="button"
            disabled={busy === 'install'}
            onClick={async () => {
              try {
                await wslInstall();
              } catch (err) {
                if (isWslOpError(err) && err.kind === 'NeedsElevation') {
                  // One-click re-launch as admin — UAC prompt comes
                  // from PowerShell's Start-Process -Verb RunAs.
                  const ok = await askConfirm({
                    title: 'WSL install needs administrator privileges',
                    body: 'Re-launch Papercusp as admin? You\'ll see a Windows UAC prompt next.',
                    confirmLabel: 'Re-launch as admin',
                  });
                  if (ok) {
                    try {
                      await wslRelaunchElevated();
                      // wslRelaunchElevated calls app.exit() — control
                      // shouldn't return here, but if it does, refresh.
                    } catch (relaunchErr) {
                      toast.error(`Could not re-launch as admin: ${relaunchErr}`);
                    }
                  }
                } else {
                  const msg = isWslOpError(err) ? err.message : String(err);
                  toast.error(`Install failed: ${msg}`);
                }
              }
              onAction();
            }}
            style={primaryBtn(busy === 'install')}
          >
            {busy === 'install' ? 'Installing…' : 'Install WSL2'}
          </button>
        </div>
      );
    case 'PendingReboot':
      return (
        <div>
          <p style={{ margin: '0 0 8px', lineHeight: 1.55 }}>
            WSL2 is installed. <strong>Please reboot Windows</strong>, then re-launch Papercusp —
            we&apos;ll pick up where we left off.
          </p>
          <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--fg-mute, #9a9aa3)' }}>
            (You can also reboot manually now and come back.)
          </p>
          <button type="button" onClick={onAction} style={ghostBtn()}>
            Re-check
          </button>
        </div>
      );
    case 'InstalledNoDistro':
      return (
        <div>
          <p style={{ margin: '0 0 16px', lineHeight: 1.55 }}>
            <Spinner /> Importing Papercusp runtime…
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-mute, #9a9aa3)' }}>
            One-time, ~30 seconds. We&apos;re unpacking a small Ubuntu environment that
            Papercusp will run in.
          </p>
        </div>
      );
    case 'PendingBootstrap':
      return (
        <div>
          <p style={{ margin: '0 0 16px', lineHeight: 1.55 }}>
            <Spinner /> Configuring runtime…
          </p>
          {logTail ? (
            <pre
              style={{
                fontSize: 11,
                padding: 8,
                background: 'rgba(0,0,0,0.25)',
                borderRadius: 6,
                maxHeight: 120,
                overflow: 'auto',
                margin: 0,
              }}
            >
              {logTail}
            </pre>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-mute, #9a9aa3)' }}>
              Installing dependencies. This is one-time.
            </p>
          )}
        </div>
      );
    case 'Error':
      return (
        <div>
          <p style={{ margin: '0 0 12px', lineHeight: 1.55, color: '#ff7676' }}>
            Setup failed:
          </p>
          <pre
            style={{
              fontSize: 11,
              padding: 12,
              background: 'rgba(255,118,118,0.08)',
              borderRadius: 6,
              maxHeight: 200,
              overflow: 'auto',
              border: '1px solid rgba(255,118,118,0.25)',
            }}
          >
            {state.message ?? '(no detail)'}
          </pre>
          <button type="button" onClick={onAction} style={primaryBtn(false)}>
            Retry
          </button>
        </div>
      );
    default:
      return null;
  }
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        marginRight: 8,
        verticalAlign: -2,
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'wsl-spin 0.7s linear infinite',
      }}
    >
      <style>{`@keyframes wsl-spin { to { transform: rotate(360deg) } }`}</style>
    </span>
  );
}

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 500,
    background: disabled ? 'rgba(122, 162, 247, 0.4)' : 'var(--accent, #7aa2f7)',
    color: 'white',
    border: 0,
    borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

function ghostBtn(): CSSProperties {
  return {
    padding: '8px 16px',
    fontSize: 13,
    background: 'transparent',
    color: 'var(--fg, #e8e8ea)',
    border: '1px solid var(--border, #2a2a32)',
    borderRadius: 6,
    cursor: 'pointer',
  };
}
