'use client';

/**
 * Setup wizard — "Remote access: use my own tunnel" (external-app-access P-009, D-001).
 *
 * Lets outside apps (Claude.ai, ChatGPT, scripts) reach this computer with no router
 * changes, through a tunnel in the user's OWN account:
 *  - Cloudflare (default, one click): install cloudflared if needed → sign in to Cloudflare
 *    → pick a name under the chosen domain → the tunnel is created and started.
 *  - Cloudflare with a pasted API token (advanced).
 *  - Another tunnel (Tailscale Funnel, ngrok, …) run by hand at the shown local address.
 *
 * Every call goes to the loopback-only /api/remote-access/own-tunnel routes
 * (lib/endpoint-route/routes/own-tunnel). The method choice lives in the URL (nuqs), so an
 * agent driving the wizard can read and set it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';

const BASE = '/api/remote-access/own-tunnel';
export const TUNNEL_METHODS = ['cloudflare', 'token', 'manual'] as const;
export type TunnelMethod = (typeof TUNNEL_METHODS)[number];

export interface OwnTunnelStatusView {
  configured: boolean;
  mode: 'cloudflare' | 'manual' | null;
  enabled: boolean;
  hostname: string | null;
  mcpUrl: string | null;
  ingressPort: number | null;
  ingressTarget: string | null;
  cloudflaredInstalled: boolean;
  health: 'not-configured' | 'off' | 'starting' | 'up' | 'down';
  lastError: string | null;
  login: { state: 'idle' | 'waiting' | 'complete' | 'failed'; loginUrl: string | null; error: string | null };
}

interface SignInView {
  state: 'idle' | 'waiting' | 'complete' | 'failed';
  loginUrl: string | null;
  error: string | null;
  zoneName?: string | null;
}

async function call<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    cache: 'no-store',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : init?.method === 'POST' ? '{}' : undefined,
  });
  const j = (await r.json().catch(() => null)) as ({ ok?: boolean; error?: { code?: string; message?: string } } & T) | null;
  if (!r.ok || !j || j.ok === false) {
    throw new Error(j?.error?.message ?? j?.error?.code ?? `request failed (${r.status})`);
  }
  return j;
}

const HEALTH_LABEL: Record<OwnTunnelStatusView['health'], string> = {
  'not-configured': 'Not set up',
  off: 'Switched off',
  starting: 'Starting…',
  up: 'Running',
  down: 'Not working',
};

export function StepOwnTunnel() {
  const [method, setMethod] = useQueryState(
    'tunnelMethod',
    parseAsStringEnum<TunnelMethod>([...TUNNEL_METHODS]).withDefault('cloudflare'),
  );
  const [status, setStatus] = useState<OwnTunnelStatusView | null>(null);
  const [signIn, setSignIn] = useState<SignInView | null>(null);
  const [label, setLabel] = useState('papercusp');
  const [hostname, setHostname] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const j = await call<{ tunnel: OwnTunnelStatusView }>('');
      setStatus(j.tunnel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [refresh]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pollSignIn = useCallback(() => {
    const tick = async () => {
      try {
        const j = await call<{ signIn: SignInView }>('/sign-in');
        setSignIn(j.signIn);
        if (j.signIn.state === 'waiting') pollRef.current = setTimeout(tick, 2_000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
  }, []);

  const installCloudflared = () =>
    run('install', async () => {
      await call('/install-cloudflared', { method: 'POST' });
      await refresh();
    });

  const startSignIn = () =>
    run('sign-in', async () => {
      const j = await call<{ signIn: SignInView }>('/sign-in', { method: 'POST' });
      setSignIn(j.signIn);
      pollSignIn();
    });

  const provision = (body: { label?: string; hostname?: string; apiToken?: string }) =>
    run('provision', async () => {
      const j = await call<{ tunnel: OwnTunnelStatusView }>('/cloudflare', { method: 'POST', body });
      setStatus(j.tunnel);
      setSignIn(null);
    });

  const useManual = () =>
    run('manual', async () => {
      const j = await call<{ tunnel: OwnTunnelStatusView }>('/manual', {
        method: 'POST',
        body: hostname.trim() ? { hostname: hostname.trim() } : {},
      });
      setStatus(j.tunnel);
    });

  const setEnabled = (enabled: boolean) =>
    run('toggle', async () => {
      const j = await call<{ tunnel: OwnTunnelStatusView }>('/enabled', { method: 'POST', body: { enabled } });
      setStatus(j.tunnel);
    });

  const remove = () =>
    run('remove', async () => {
      await call('/remove', { method: 'POST', body: {} });
      await refresh();
    });

  if (!status) {
    return (
      <div className="space-y-2 text-sm" data-testid="own-tunnel-step">
        {error ? <p className="text-red-600" data-testid="own-tunnel-error">{error}</p> : <p>Checking remote access…</p>}
      </div>
    );
  }

  if (status.configured) {
    return (
      <div className="space-y-3 text-sm" data-testid="own-tunnel-step">
        <p>
          Remote access: <strong data-testid="own-tunnel-health">{HEALTH_LABEL[status.health]}</strong>
          {status.mode === 'manual' ? ' (your own tunnel)' : ' (Cloudflare Tunnel in your account)'}
        </p>
        {status.mcpUrl ? (
          <p>
            Outside apps connect to <code data-testid="own-tunnel-mcp-url">{status.mcpUrl}</code>
          </p>
        ) : null}
        {status.mode === 'manual' && status.ingressTarget ? (
          <p>
            Point your tunnel at <code data-testid="own-tunnel-ingress-target">{status.ingressTarget}</code>. Only
            the app-access endpoints answer there; nothing on it is trusted as local.
          </p>
        ) : null}
        {status.lastError ? <p className="text-red-600">{status.lastError}</p> : null}
        <div className="flex gap-2">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => setEnabled(!status.enabled)} data-testid="own-tunnel-toggle">
            {status.enabled ? 'Switch off' : 'Switch on'}
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={remove} data-testid="own-tunnel-remove">
            Remove
          </button>
        </div>
        {error ? <p className="text-red-600" data-testid="own-tunnel-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm" data-testid="own-tunnel-step">
      <p>
        Let apps like Claude.ai or ChatGPT reach this computer without changing your router. The tunnel runs in your
        own account; you can switch it off at any time. This step is optional.
      </p>
      <div role="radiogroup" aria-label="Tunnel type" className="flex gap-3">
        {(
          [
            ['cloudflare', 'Cloudflare (recommended)'],
            ['token', 'Cloudflare with an API token'],
            ['manual', 'Another tunnel'],
          ] as const
        ).map(([id, text]) => (
          <label key={id} className="flex items-center gap-1">
            <input type="radio" name="tunnel-method" checked={method === id} onChange={() => void setMethod(id)} data-testid={`own-tunnel-method-${id}`} />
            {text}
          </label>
        ))}
      </div>

      {method !== 'manual' && !status.cloudflaredInstalled ? (
        <div className="space-y-1">
          <p>Cloudflare&apos;s tunnel program (cloudflared) is not installed yet.</p>
          <button type="button" className="btn" disabled={busy !== null} onClick={installCloudflared} data-testid="own-tunnel-install">
            {busy === 'install' ? 'Installing…' : 'Install cloudflared'}
          </button>
        </div>
      ) : null}

      {method === 'cloudflare' && status.cloudflaredInstalled ? (
        signIn?.state === 'complete' ? (
          <div className="space-y-2">
            <label className="flex items-center gap-1">
              Address:
              <input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="own-tunnel-label" />
              <span>.{signIn.zoneName ?? 'your-domain'}</span>
            </label>
            <button type="button" className="btn" disabled={busy !== null || !label.trim()} onClick={() => provision({ label: label.trim() })} data-testid="own-tunnel-create">
              {busy === 'provision' ? 'Creating tunnel…' : 'Create tunnel'}
            </button>
          </div>
        ) : signIn?.state === 'waiting' ? (
          <p>
            Finish signing in to Cloudflare in your browser{' '}
            {signIn.loginUrl ? (
              <a href={signIn.loginUrl} target="_blank" rel="noreferrer" data-testid="own-tunnel-login-url">
                (open the sign-in page)
              </a>
            ) : null}
            , then choose the domain to use.
          </p>
        ) : (
          <div className="space-y-1">
            {signIn?.state === 'failed' ? <p className="text-red-600">{signIn.error}</p> : null}
            <button type="button" className="btn" disabled={busy !== null} onClick={startSignIn} data-testid="own-tunnel-sign-in">
              Sign in to Cloudflare
            </button>
          </div>
        )
      ) : null}

      {method === 'token' && status.cloudflaredInstalled ? (
        <div className="space-y-2">
          <label className="flex flex-col">
            Full address (a domain in your Cloudflare account)
            <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="papercusp.example.com" data-testid="own-tunnel-hostname" />
          </label>
          <label className="flex flex-col">
            API token with Cloudflare Tunnel: Edit and DNS: Edit
            <input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} data-testid="own-tunnel-api-token" />
          </label>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !hostname.trim() || !apiToken.trim()}
            onClick={() => provision({ hostname: hostname.trim(), apiToken: apiToken.trim() })}
            data-testid="own-tunnel-create-token"
          >
            {busy === 'provision' ? 'Creating tunnel…' : 'Create tunnel'}
          </button>
        </div>
      ) : null}

      {method === 'manual' ? (
        <div className="space-y-2">
          <p>
            Run Tailscale Funnel, ngrok or another outbound tunnel yourself. Papercusp opens a separate local address for
            it that serves only the app-access endpoints.
          </p>
          <label className="flex flex-col">
            Public address of your tunnel (optional)
            <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="box.tailnet.ts.net" data-testid="own-tunnel-manual-hostname" />
          </label>
          <button type="button" className="btn" disabled={busy !== null} onClick={useManual} data-testid="own-tunnel-manual">
            Use my own tunnel
          </button>
        </div>
      ) : null}

      {error ? <p className="text-red-600" data-testid="own-tunnel-error">{error}</p> : null}
    </div>
  );
}
