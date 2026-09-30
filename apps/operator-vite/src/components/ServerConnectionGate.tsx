import { FormEvent, useEffect, useState } from 'react';

declare global {
  interface Window {
    __papercuspBootError?: string;
    __papercuspServerConnectionRequired?: string;
    __papercuspServerConnectionRestored?: boolean;
  }
}

/**
 * Accept only a credential-free HTTPS operator origin. The hosted/browser
 * transport is same-origin HTTP + SSE, so navigating the webview to the
 * Server's root reuses the normal browser SPA without inventing a second
 * desktop-only client path.
 */
export function normalizeRemoteServerUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * P-007 / D-001: a thin GUI cannot repair a missing backend by spawning its
 * own bundled runtime. When Rust cannot launch or discover the independently
 * installed Server, present the two honest routes instead: install/start the
 * local sibling product, or navigate to a remote/hosted Server origin.
 *
 * This is lifecycle/error state, not navigation state, so local React state is
 * intentional (the repo's nuqs rule explicitly exempts error state and drafts).
 */
export default function ServerConnectionGate() {
  const [reason, setReason] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteError, setRemoteError] = useState<string | null>(null);

  useEffect(() => {
    const initial = window.__papercuspServerConnectionRestored
      ? null
      : window.__papercuspServerConnectionRequired ?? window.__papercuspBootError;
    if (initial) setReason(initial);

    const requireConnection = (event: Event) => {
      // point_window_at_operator marks a successful attach before emitting the
      // restored event. Ignore any bounded diagnostic retry that was already in
      // flight when the operator became reachable.
      if (window.__papercuspServerConnectionRestored) return;
      const detail = (event as CustomEvent<string>).detail;
      setReason(detail || 'No Papercusp Server endpoint is available.');
    };
    const restoreConnection = () => {
      window.__papercuspServerConnectionRestored = true;
      delete window.__papercuspServerConnectionRequired;
      delete window.__papercuspBootError;
      setReason(null);
      setRemoteUrl('');
      setRemoteError(null);
    };
    window.addEventListener('papercusp:server-connection-required', requireConnection);
    window.addEventListener('papercusp:boot-error', requireConnection);
    window.addEventListener('papercusp:server-connection-restored', restoreConnection);
    return () => {
      window.removeEventListener('papercusp:server-connection-required', requireConnection);
      window.removeEventListener('papercusp:boot-error', requireConnection);
      window.removeEventListener('papercusp:server-connection-restored', restoreConnection);
    };
  }, []);

  if (!reason) return null;

  const connectRemote = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRemoteServerUrl(remoteUrl);
    if (!normalized) {
      setRemoteError('Enter a credential-free HTTPS Server address.');
      return;
    }
    setRemoteError(null);
    window.location.assign(normalized);
  };

  return (
    <div style={backdrop} role="alertdialog" aria-modal="true" aria-labelledby="server-gate-title">
      <section style={panel}>
        <p style={eyebrow}>Papercusp GUI</p>
        <h1 id="server-gate-title" style={title}>Connect to a Papercusp Server</h1>
        <p style={intro}>
          This GUI is intentionally thin and does not contain a backend runtime.
          Choose where your Server runs.
        </p>
        <p style={diagnostic} data-testid="server-connection-reason">{reason}</p>

        <div style={choices}>
          <article style={card}>
            <h2 style={cardTitle}>Use this computer</h2>
            <p style={cardCopy}>
              Install the separate <strong>Papercusp Server</strong> package for this
              platform and start it. The GUI will reconnect automatically.
            </p>
            <button type="button" style={primaryButton} onClick={() => window.location.reload()}>
              Retry local Server
            </button>
          </article>

          <article style={card}>
            <h2 style={cardTitle}>Use another Server</h2>
            <p style={cardCopy}>
              Connect to a remote or hosted Papercusp Server over HTTPS. The same
              browser SPA uses HTTP and SSE against that Server origin.
            </p>
            <form onSubmit={connectRemote} style={form}>
              <label htmlFor="papercusp-server-url" style={label}>Server address</label>
              <input
                id="papercusp-server-url"
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder="https://server.example.com"
                value={remoteUrl}
                onChange={(event) => {
                  setRemoteUrl(event.target.value);
                  setRemoteError(null);
                }}
                aria-invalid={Boolean(remoteError)}
                aria-describedby={remoteError ? 'papercusp-server-url-error' : undefined}
                style={input}
              />
              {remoteError && (
                <p id="papercusp-server-url-error" role="alert" style={fieldError}>{remoteError}</p>
              )}
              <button type="submit" style={secondaryButton}>Connect securely</button>
            </form>
          </article>
        </div>
      </section>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 2147483645, display: 'grid', placeItems: 'center',
  padding: 24, overflow: 'auto', background: 'rgba(7, 9, 13, 0.96)', color: 'var(--text, #f3f4f6)',
};
const panel: React.CSSProperties = { width: 'min(760px, 100%)', textAlign: 'left' };
const eyebrow: React.CSSProperties = { margin: '0 0 8px', color: 'var(--muted, #9ca3af)', fontSize: 12, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase' };
const title: React.CSSProperties = { margin: 0, fontSize: 30, lineHeight: 1.15 };
const intro: React.CSSProperties = { margin: '12px 0 8px', color: 'var(--muted, #aeb4bf)', lineHeight: 1.6 };
const diagnostic: React.CSSProperties = { margin: '0 0 22px', padding: '9px 11px', borderRadius: 8, background: 'var(--bad-bg, #3a171c)', color: 'var(--bad, #fca5a5)', fontSize: 13 };
const choices: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 };
const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', minHeight: 240, padding: 18, border: '1px solid var(--border, #30343b)', borderRadius: 12, background: 'var(--bg-2, #12151a)' };
const cardTitle: React.CSSProperties = { margin: 0, fontSize: 17 };
const cardCopy: React.CSSProperties = { flex: 1, margin: '10px 0 16px', color: 'var(--muted, #aeb4bf)', fontSize: 14, lineHeight: 1.55 };
const form: React.CSSProperties = { display: 'grid', gap: 8 };
const label: React.CSSProperties = { fontSize: 12, fontWeight: 700 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--border, #3d434c)', borderRadius: 8, padding: '9px 10px', background: 'var(--bg, #0b0d11)', color: 'inherit', fontSize: 14 };
const fieldError: React.CSSProperties = { margin: 0, color: 'var(--bad, #fca5a5)', fontSize: 12 };
const buttonBase: React.CSSProperties = { borderRadius: 8, padding: '9px 12px', fontWeight: 700, cursor: 'pointer' };
const primaryButton: React.CSSProperties = { ...buttonBase, border: 0, background: 'var(--accent, #4f8cff)', color: '#fff' };
const secondaryButton: React.CSSProperties = { ...buttonBase, border: '1px solid var(--border, #3d434c)', background: 'transparent', color: 'inherit' };
