'use client';

/**
 * Settings → Remote access (external-app-access-to-workspaces-2026-09-29 P-010, decision D-025).
 * Replaces /settings/mobile: the old route redirects here and phone pairing lives on this page.
 *
 * One screen for everything that reaches a workspace from outside this computer:
 *  - the workspace's Remote access switch — off is the instant kill switch: every app key, service
 *    key and client-credentials token of the workspace is refused on its next request
 *    (`remote_access_off`, R-24/R-41). Phones keep their own pairing auth (D-025);
 *  - the route: this install's own tunnel (P-009) — address, health and its own on/off;
 *  - one list of phones, app keys and service keys with creator and last use (R-26, D-007), each
 *    with pause, edit scope, rotate and revoke (R-40);
 *  - "Pair a phone" (moved from /settings/mobile) and the "Connect an app" wizard.
 *
 * Reads are ONE sync query, `remoteAccess.overview` (sync-resolver). Writes go to the loopback-only
 * routes (/api/remote-access/*, /api/connected-apps*, /api/device/desktop/*); the tables carry the
 * sync trigger (migration 1264), so every write — from here or anywhere else — refreshes the list.
 * User-meaningful state (workspace, open wizard step, open panels, the entry being edited, the
 * pending confirmation) is in the URL via nuqs. Secrets (a new key, a pairing token) are shown once
 * and never enter the URL.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { Checkbox } from '@/app/harness/Checkbox';
import { ConfirmModal } from '@/app/harness/ConfirmModal';
import { RadioGroup } from '@/app/harness/RadioGroup';
import { Select } from '@/app/harness/Select';
import { StepOwnTunnel, type OwnTunnelStatusView } from '@/app/_components/SetupWizard/StepOwnTunnel';

export type EntryKind = 'mobile' | 'app' | 'service';

export interface RemoteAccessEntryView {
  id: string;
  kind: EntryKind;
  label: string | null;
  creator: string;
  scopes: { capabilities?: string[]; tools?: string[]; harnesses?: string[] };
  pairedAt: string;
  lastSeen: string | null;
  lastIp: string | null;
  expiresAt: string | null;
  pausedAt: string | null;
  spendCapCents: number | null;
  spendCapWindowSec: number | null;
  rotatedAt: string | null;
  previousKeyValidUntil: string | null;
  clientAuth: string | null;
}

export interface RemoteAccessOverviewRow {
  workspaceId: string;
  remoteAccess: { workspaceId: string; enabled: boolean; changedAt: string | null; changedBy: string | null };
  entries: RemoteAccessEntryView[];
  ownTunnel: OwnTunnelStatusView | null;
  ownTunnelError: string | null;
  portalRelay?: PortalRelayStatusView | null;
  portalRelayError?: string | null;
}

/** The subset of relay-opt-in.ts PortalRelayStatus the screen shows (external-app-access P-008). */
export interface PortalRelayStatusView {
  state: 'off' | 'linking' | 'linked';
  available: boolean;
  unavailableReason: 'hosted_machine' | null;
  portalOrigin: string;
  notice: { version: number; text: string };
  consent: { agreed: boolean; version: number | null; at: string | null };
  pending: { userCode: string; verificationUri: string; expiresAt: string | null } | null;
  linked: { appBaseUrl: string | null; mcpUrl: string | null; linkedAt: string | null } | null;
  health: 'off' | 'linking' | 'starting' | 'up' | 'down';
  lastError: string | null;
}

const RELAY_HEALTH_LABEL: Record<PortalRelayStatusView['health'], string> = {
  off: 'Off',
  linking: 'Waiting for approval',
  starting: 'Connecting…',
  up: 'Connected',
  down: 'Not connected',
};

interface WorkspaceOption {
  id: string;
  name: string;
}

interface QrPayload {
  server: string;
  pairToken: string;
  workspaceId: string;
}

interface IssuedKey {
  label: string;
  key: string;
  snippets: { baseUrl: string; curl: string; mcp: unknown };
  previousKeyValidUntil?: string | null;
}

interface PendingGrant {
  userCode: string;
  clientLabel: string;
  requestedScopes: { tools?: string[]; harnesses?: string[] };
  createdAt: string;
  expiresAt: string;
}

const WIZARD_STEPS = ['choose', 'connector', 'key', 'signin'] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

const KIND_LABEL: Record<EntryKind, string> = { mobile: 'Phone', app: 'App key', service: 'Service key' };

const HEALTH_LABEL: Record<OwnTunnelStatusView['health'], string> = {
  'not-configured': 'Not set up',
  off: 'Switched off',
  starting: 'Starting…',
  up: 'Running',
  down: 'Not working',
};

/** POST JSON to a loopback route; throws with the route's error code on refusal. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => null)) as ({ ok?: boolean; error?: { code?: string; message?: string } } & T) | null;
  if (!r.ok || !j || j.ok === false) throw new Error(j?.error?.message ?? j?.error?.code ?? `request failed (${r.status})`);
  return j;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function lines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The state tags an entry carries, in the order a reader needs them. */
export function entryTags(e: RemoteAccessEntryView, now: number): string[] {
  const tags: string[] = [];
  if (e.pausedAt) tags.push('Paused');
  if (e.expiresAt && new Date(e.expiresAt).getTime() <= now) tags.push('Expired');
  else if (e.expiresAt) tags.push(`Expires ${new Date(e.expiresAt).toLocaleDateString()}`);
  if (e.previousKeyValidUntil && new Date(e.previousKeyValidUntil).getTime() > now) {
    tags.push(`Old key works until ${new Date(e.previousKeyValidUntil).toLocaleString()}`);
  }
  if (e.clientAuth) tags.push(e.clientAuth === 'private_key_jwt' ? 'OAuth client (key pair)' : 'OAuth client (secret)');
  if (e.spendCapCents !== null) tags.push(`Cap $${(e.spendCapCents / 100).toFixed(2)}`);
  return tags;
}

export default function RemoteAccessSettingsPage() {
  const [ws, setWs] = useQueryState('ws', parseAsString.withDefault(''));
  const [wizard, setWizard] = useQueryState('connect', parseAsStringEnum<WizardStep>([...WIZARD_STEPS]));
  const [pairOpen, setPairOpen] = useQueryState('pair', parseAsBoolean.withDefault(false));
  const [tunnelOpen, setTunnelOpen] = useQueryState('tunnel', parseAsBoolean.withDefault(false));
  const [editId, setEditId] = useQueryState('edit', parseAsString);
  // "<action>:<entry id>" — the confirmation in front of the user (revoke, rotate).
  const [confirmTarget, setConfirmTarget] = useQueryState('confirm', parseAsString);

  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/workspaces');
        const body = res.ok ? ((await res.json()) as { current?: string; workspaces?: WorkspaceOption[] }) : {};
        if (cancelled) return;
        setWorkspaces(body.workspaces ?? []);
        if (!ws) void setWs(body.current ?? body.workspaces?.[0]?.id ?? 'default');
      } catch {
        if (!cancelled && !ws) void setWs('default');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Resolve the default workspace once; the URL owns it afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data, loading, error } = useSyncQuery<RemoteAccessOverviewRow>({
    queryName: 'remoteAccess.overview',
    args: { workspaceId: ws || 'default' },
    enabled: ws !== '',
  });
  const row = data?.[0] ?? null;
  const entries = useMemo(() => row?.entries ?? [], [row]);
  const now = Date.now();

  const run = useCallback(async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast.error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const setSwitch = (enabled: boolean) =>
    run(enabled ? 'Turning remote access on' : 'Turning remote access off', async () => {
      await postJson('/api/remote-access', { workspaceId: ws, enabled });
      toast.success(enabled ? 'Remote access is on' : 'Remote access is off — connected apps are refused now');
    });

  const setPaused = (e: RemoteAccessEntryView, paused: boolean) =>
    run(paused ? 'Pausing' : 'Resuming', async () => {
      await postJson('/api/remote-access/pause', { workspaceId: ws, id: e.id, kind: e.kind, paused });
    });

  const confirmEntry = useMemo(() => {
    if (!confirmTarget) return null;
    const i = confirmTarget.indexOf(':');
    const action = confirmTarget.slice(0, i);
    const entry = entries.find((x) => x.id === confirmTarget.slice(i + 1));
    return entry && (action === 'revoke' || action === 'rotate') ? { action, entry } : null;
  }, [confirmTarget, entries]);

  const doConfirmed = async () => {
    if (!confirmEntry) return;
    const { action, entry } = confirmEntry;
    await setConfirmTarget(null);
    if (action === 'revoke') {
      await run('Revoking', async () => {
        await postJson('/api/remote-access/revoke', { workspaceId: ws, id: entry.id, kind: entry.kind });
        toast.success(`${entry.label ?? KIND_LABEL[entry.kind]} revoked`);
      });
      return;
    }
    if (entry.kind === 'mobile') {
      // A phone's token is its pairing: rotating it is revoking it and pairing the phone again.
      await run('Rotating', async () => {
        await postJson('/api/remote-access/revoke', { workspaceId: ws, id: entry.id, kind: 'mobile' });
        await setPairOpen(true);
      });
      return;
    }
    await run('Rotating', async () => {
      const r = await postJson<{ key: string; snippets: IssuedKey['snippets']; previousKeyValidUntil: string | null }>(
        '/api/connected-apps/rotate',
        { workspaceId: ws, id: entry.id },
      );
      setIssued({ label: entry.label ?? entry.id, key: r.key, snippets: r.snippets, previousKeyValidUntil: r.previousKeyValidUntil });
    });
  };

  const tunnel = row?.ownTunnel ?? null;

  return (
    <div className="pc-settings-page" data-testid="remote-access-page">
      <header>
        <h1>Remote access</h1>
        <p className="pc-settings-intro">
          Let apps and phones outside this computer — Claude.ai, ChatGPT, scripts, Papercup Mobile — reach a workspace, and
          take that access back.
        </p>
      </header>

      <section className="pc-settings-section" data-testid="remote-access-switch">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Workspace</h2>
          <Select
            value={ws || 'default'}
            onChange={(v) => void setWs(v)}
            options={
              workspaces.length === 0
                ? [{ value: ws || 'default', label: ws || 'default' }]
                : workspaces.map((w) => ({ value: w.id, label: `${w.name} (${w.id})` }))
            }
            ariaLabel="Workspace"
          />
        </div>
        {error && <p className="pc-settings-note" role="alert">Could not load remote access: {String(error)}</p>}
        {row && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 220px' }}>
              <div data-testid="remote-access-state" data-enabled={row.remoteAccess.enabled ? 'true' : 'false'} style={{ fontWeight: 600 }}>
                Remote access is {row.remoteAccess.enabled ? 'on' : 'off'}
              </div>
              <div className="pc-settings-hint">
                {row.remoteAccess.enabled
                  ? 'Connected apps and service keys can reach this workspace within their scopes.'
                  : 'Every connected app, service key and OAuth client of this workspace is refused. Paired phones are not affected.'}
                {row.remoteAccess.changedAt ? ` Changed ${when(row.remoteAccess.changedAt)}.` : ''}
              </div>
            </div>
            <button
              type="button"
              data-testid="remote-access-toggle"
              disabled={busy !== null}
              onClick={() => void setSwitch(!row.remoteAccess.enabled)}
              style={row.remoteAccess.enabled ? { color: 'var(--bad, #f87171)' } : undefined}
            >
              {row.remoteAccess.enabled ? 'Turn off now' : 'Turn on'}
            </button>
          </div>
        )}
        {!row && loading && <p className="pc-settings-hint">Loading…</p>}
      </section>

      <section className="pc-settings-section" data-testid="remote-access-route">
        <h2>Route</h2>
        {row?.ownTunnelError && <p className="pc-settings-note">Tunnel status unavailable: {row.ownTunnelError}</p>}
        {tunnel && tunnel.configured ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', marginTop: 8 }}>
            <span className="pc-settings-hint">Your own tunnel</span>
            <span>{tunnel.mode === 'cloudflare' ? 'Cloudflare' : 'Run by hand'}</span>
            <span className="pc-settings-hint">Address</span>
            <span data-testid="remote-access-address">{tunnel.hostname ?? tunnel.ingressTarget ?? '—'}</span>
            {tunnel.mcpUrl && (
              <>
                <span className="pc-settings-hint">MCP URL</span>
                <code>{tunnel.mcpUrl}</code>
              </>
            )}
            <span className="pc-settings-hint">Health</span>
            <span data-testid="remote-access-health">{HEALTH_LABEL[tunnel.health]}</span>
            {tunnel.lastError && (
              <>
                <span className="pc-settings-hint">Last error</span>
                <span>{tunnel.lastError}</span>
              </>
            )}
          </div>
        ) : (
          <p className="pc-settings-hint">
            No route yet. Outside apps reach this computer through a tunnel in your own account (Cloudflare, or one you run).
          </p>
        )}
        <div className="pc-settings-actions" style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tunnel?.configured && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run('Changing the tunnel', async () => {
                  await postJson('/api/remote-access/own-tunnel/enabled', { enabled: !tunnel.enabled });
                })
              }
            >
              {tunnel.enabled ? 'Stop the tunnel' : 'Start the tunnel'}
            </button>
          )}
          <button type="button" onClick={() => void setTunnelOpen(!tunnelOpen)}>
            {tunnelOpen ? 'Close tunnel setup' : tunnel?.configured ? 'Change the tunnel' : 'Set up a tunnel'}
          </button>
        </div>
        {tunnelOpen && (
          <div style={{ marginTop: 12 }}>
            <StepOwnTunnel />
          </div>
        )}
        {row?.portalRelayError && <p className="pc-settings-note">Relay status unavailable: {row.portalRelayError}</p>}
        {row?.portalRelay && <PortalRelayCard relay={row.portalRelay} busy={busy !== null} run={run} />}
      </section>

      <section className="pc-settings-section" data-testid="remote-access-list">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Apps and devices</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" data-testid="remote-access-connect" onClick={() => void setWizard('choose')}>
              Connect an app
            </button>
            <button type="button" data-testid="remote-access-pair" onClick={() => void setPairOpen(true)}>
              Pair a phone
            </button>
          </div>
        </div>
        {issued && <IssuedKeyBox issued={issued} onDone={() => setIssued(null)} />}
        {row && entries.length === 0 && (
          <p className="pc-settings-hint" style={{ marginTop: 12 }}>Nothing is connected to this workspace.</p>
        )}
        <ul style={{ marginTop: 12, listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map((e) => (
            <li key={e.id} data-testid="remote-access-entry" data-entry-id={e.id} data-kind={e.kind} style={entryStyle}>
              <div
                data-testid="remote-access-entry-row"
                style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
              >
                <div style={{ minWidth: 0, flex: '1 1 220px', overflowWrap: 'anywhere' }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {e.label ?? '(unnamed)'} <span className="pc-settings-hint">· {KIND_LABEL[e.kind]}</span>
                  </div>
                  <div className="pc-settings-hint" style={{ marginTop: 2 }}>
                    Added by {e.creator} on {when(e.pairedAt)} · last used {when(e.lastSeen)}
                    {e.lastIp ? ` from ${e.lastIp}` : ''}
                  </div>
                  {e.kind !== 'mobile' && (
                    <div className="pc-settings-hint" style={{ marginTop: 2 }}>
                      Tools: {e.scopes.tools?.length ? e.scopes.tools.join(', ') : 'none'}
                      {e.scopes.harnesses?.length ? ` · projects: ${e.scopes.harnesses.join(', ')}` : ''}
                    </div>
                  )}
                  {entryTags(e, now).length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {entryTags(e, now).map((t) => (
                        <span key={t} className="pc-settings-status-pill">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div data-testid="remote-access-entry-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" data-action="pause" disabled={busy !== null} onClick={() => void setPaused(e, !e.pausedAt)}>
                    {e.pausedAt ? 'Resume' : 'Pause'}
                  </button>
                  {e.kind !== 'mobile' && (
                    <button type="button" data-action="edit-scope" onClick={() => void setEditId(editId === e.id ? null : e.id)}>
                      Edit scope
                    </button>
                  )}
                  <button type="button" data-action="rotate" disabled={busy !== null} onClick={() => void setConfirmTarget(`rotate:${e.id}`)}>
                    Rotate
                  </button>
                  <button
                    type="button"
                    data-action="revoke"
                    disabled={busy !== null}
                    onClick={() => void setConfirmTarget(`revoke:${e.id}`)}
                    style={{ color: 'var(--bad, #f87171)' }}
                  >
                    Revoke
                  </button>
                </div>
              </div>
              {editId === e.id && e.kind !== 'mobile' && (
                <ScopeEditor entry={e} workspaceId={ws} onClose={() => void setEditId(null)} />
              )}
            </li>
          ))}
        </ul>
      </section>

      {pairOpen && <PairPhone workspaceId={ws || 'default'} onClose={() => void setPairOpen(false)} />}
      {wizard && (
        <ConnectAppWizard
          step={wizard}
          setStep={(s) => void setWizard(s)}
          workspaceId={ws || 'default'}
          mcpUrl={tunnel?.mcpUrl ?? null}
          onIssued={(k) => {
            setIssued(k);
            void setWizard(null);
          }}
        />
      )}

      <ConfirmModal
        open={confirmEntry !== null}
        onOpenChange={(open) => {
          if (!open) void setConfirmTarget(null);
        }}
        title={
          confirmEntry?.action === 'revoke'
            ? `Revoke ${confirmEntry.entry.label ?? KIND_LABEL[confirmEntry.entry.kind]}?`
            : `Rotate ${confirmEntry?.entry.label ?? ''}?`
        }
        body={confirmBody(confirmEntry)}
        confirmLabel={confirmEntry?.action === 'revoke' ? 'Revoke' : 'Rotate'}
        destructive={confirmEntry?.action === 'revoke'}
        onConfirm={doConfirmed}
      />
    </div>
  );
}

const entryStyle = {
  border: '1px solid var(--border)',
  background: 'var(--bg-2)',
  borderRadius: 6,
  padding: '12px 16px',
} as const;

/**
 * The opt-in Papercusp relay (P-008, D-001 / D-009): the alternative to the user's own tunnel.
 * The notice is shown and must be agreed to before Connect is offered (R-20); connecting shows the
 * code and the address to approve it on the portal, and the reconciler finishes the link.
 */
export function PortalRelayCard(props: {
  relay: PortalRelayStatusView;
  busy: boolean;
  run: (what: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const { relay, busy, run } = props;
  // A mid-edit choice, not user-meaningful state: it resets when the notice is accepted.
  const [understood, setUnderstood] = useState(false);
  if (!relay.available) {
    return (
      <div data-testid="portal-relay" data-state="unavailable" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>Papercusp relay</h3>
        <p className="pc-settings-hint">This workspace runs on Papercusp and is already reachable through it; the relay is not used here.</p>
      </div>
    );
  }
  return (
    <div data-testid="portal-relay" data-state={relay.state} style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Papercusp relay</h3>
      <p className="pc-settings-hint">
        Instead of your own tunnel, this computer can keep a connection to Papercusp so outside apps reach it with no router changes.
      </p>
      {relay.state === 'off' && !relay.consent.agreed && (
        <div data-testid="portal-relay-notice">
          <p className="pc-settings-note">{relay.notice.text}</p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Checkbox dataTestId="portal-relay-understand" checked={understood} onChange={setUnderstood} />
            I understand
          </label>
          <button
            type="button"
            data-testid="portal-relay-accept"
            disabled={busy || !understood}
            onClick={() =>
              void run('Saving your agreement', async () => {
                await postJson('/api/remote-access/portal-relay/consent', { noticeVersion: relay.notice.version });
              })
            }
          >
            Agree
          </button>
        </div>
      )}
      {relay.state === 'off' && relay.consent.agreed && (
        <button
          type="button"
          data-testid="portal-relay-connect"
          disabled={busy}
          onClick={() =>
            void run('Connecting to the Papercusp relay', async () => {
              await postJson('/api/remote-access/portal-relay/connect', {});
            })
          }
        >
          Connect this computer
        </button>
      )}
      {relay.state === 'linking' && relay.pending && (
        <div data-testid="portal-relay-pending">
          <p>
            Open{' '}
            <a href={relay.pending.verificationUri} target="_blank" rel="noreferrer" data-testid="portal-relay-link">
              {relay.pending.verificationUri}
            </a>{' '}
            and approve the code <code data-testid="portal-relay-code">{relay.pending.userCode}</code>.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run('Cancelling', async () => {
                await postJson('/api/remote-access/portal-relay/cancel', {});
              })
            }
          >
            Cancel
          </button>
        </div>
      )}
      {relay.state === 'linked' && relay.linked && (
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', marginTop: 8 }}>
          <span className="pc-settings-hint">Status</span>
          <span data-testid="portal-relay-health">{RELAY_HEALTH_LABEL[relay.health]}</span>
          {relay.linked.appBaseUrl && (
            <>
              <span className="pc-settings-hint">App address</span>
              <code data-testid="portal-relay-address">{relay.linked.appBaseUrl}</code>
            </>
          )}
          {relay.linked.mcpUrl && (
            <>
              <span className="pc-settings-hint">MCP URL</span>
              <code data-testid="portal-relay-mcp">{relay.linked.mcpUrl}</code>
            </>
          )}
        </div>
      )}
      {relay.state === 'linked' && (
        <button
          type="button"
          data-testid="portal-relay-disconnect"
          disabled={busy}
          style={{ marginTop: 8, color: 'var(--bad, #f87171)' }}
          onClick={() =>
            void run('Disconnecting', async () => {
              await postJson('/api/remote-access/portal-relay/disconnect', {});
            })
          }
        >
          Disconnect
        </button>
      )}
      {relay.lastError && (
        <p className="pc-settings-note" data-testid="portal-relay-error">
          {relay.lastError}
        </p>
      )}
    </div>
  );
}

function confirmBody(c: { action: string; entry: RemoteAccessEntryView } | null): ReactNode {
  if (!c) return null;
  if (c.action === 'revoke') {
    return c.entry.kind === 'mobile'
      ? 'The phone is signed out on its next request and has to be paired again.'
      : 'Its next request is refused. This cannot be undone — connect the app again to give it access back.';
  }
  return c.entry.kind === 'mobile'
    ? 'A phone’s access is its pairing: rotating revokes this phone and opens pairing so you can pair it again.'
    : 'A new key is issued and shown once. The old key keeps working for a short overlap so you can switch the app over.';
}

function IssuedKeyBox({ issued, onDone }: { issued: IssuedKey; onDone: () => void }) {
  const mcp = JSON.stringify(issued.snippets.mcp, null, 2);
  return (
    <div data-testid="remote-access-issued-key" style={{ ...entryStyle, marginTop: 12, borderColor: 'var(--accent, #6aa7ff)' }}>
      <div style={{ fontWeight: 600 }}>Key for {issued.label} — copy it now, it is not shown again</div>
      <CopyField label="Key" value={issued.key} />
      {issued.previousKeyValidUntil && (
        <p className="pc-settings-hint">The old key keeps working until {when(issued.previousKeyValidUntil)}.</p>
      )}
      <CopyField label="MCP config" value={mcp} rows={6} />
      <CopyField label="curl" value={issued.snippets.curl} rows={3} />
      <button type="button" onClick={onDone}>Done</button>
    </div>
  );
}

function CopyField({ label, value, rows = 1 }: { label: string; value: string; rows?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the text and copy it by hand');
    }
  };
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="pc-settings-eyebrow" style={{ margin: 0 }}>{label}</span>
        <button type="button" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <textarea readOnly value={value} rows={rows} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }} />
    </div>
  );
}

function ScopeEditor({ entry, workspaceId, onClose }: { entry: RemoteAccessEntryView; workspaceId: string; onClose: () => void }) {
  const [tools, setTools] = useState((entry.scopes.tools ?? []).join('\n'));
  const [harnesses, setHarnesses] = useState((entry.scopes.harnesses ?? []).join('\n'));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      await postJson('/api/remote-access/scopes', { workspaceId, id: entry.id, tools: lines(tools), harnesses: lines(harnesses) });
      toast.success('Scope saved');
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-testid="remote-access-scope-editor" style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <label>
        <span className="pc-settings-hint">Tools it may call — one per line (`group:verb` or `group:*`). Empty means none.</span>
        <textarea value={tools} onChange={(e) => setTools(e.target.value)} rows={4} style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }} />
      </label>
      <label>
        <span className="pc-settings-hint">Projects it may touch — one per line. Empty means every project of the workspace.</span>
        <textarea value={harnesses} onChange={(e) => setHarnesses(e.target.value)} rows={2} style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }} />
      </label>
      {problem && <p className="pc-settings-note" role="alert">{problem}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save scope'}</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function Panel({ title, testId, onClose, children }: { title: string; testId: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="pc-settings-section" data-testid={testId} style={{ ...entryStyle, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

function PairPhone({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [minting, setMinting] = useState(false);

  useEffect(() => {
    if (!qr) return;
    // UI countdown timer (a render clock, not data sync).
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [qr, now]);

  const mint = async () => {
    setMinting(true);
    try {
      const res = await fetch('/api/device/desktop/mint-pair-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { qrPayload: QrPayload; expiresAt: number };
      setQr(body.qrPayload);
      setExpiresAt(body.expiresAt);
      setNow(Date.now());
    } catch (e) {
      toast.error(`Could not start pairing: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMinting(false);
    }
  };

  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return (
    <Panel title="Pair a phone" testId="remote-access-pair-panel" onClose={onClose}>
      <p className="pc-settings-hint">
        Pair Papercup Mobile to watch work, talk to Papercup and get alerts away from your desk. The phone joins workspace{' '}
        <code>{workspaceId}</code>.
      </p>
      {!qr ? (
        <button type="button" onClick={mint} disabled={minting}>{minting ? 'Generating…' : 'Show QR code'}</button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/device/qr.svg?payload=${encodeURIComponent(JSON.stringify(qr))}`}
            alt="Pairing QR code"
            style={{ height: 256, width: 256, borderRadius: 6, background: '#fff', padding: 8 }}
          />
          <div className="pc-settings-hint">
            {remaining > 0 ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Expired — show a new code'}
          </div>
          <p className="pc-settings-hint" style={{ maxWidth: 420, textAlign: 'center' }}>
            On the phone, open Papercup → “Scan QR” and point it at this code, or paste the pairing code below.
          </p>
          <div style={{ width: '100%', maxWidth: 420 }}>
            <CopyField label="Pairing code" value={JSON.stringify(qr)} rows={3} />
          </div>
          <button type="button" onClick={() => setQr(null)}>Cancel</button>
        </div>
      )}
    </Panel>
  );
}

function ConnectAppWizard(props: {
  step: WizardStep;
  setStep: (s: WizardStep | null) => void;
  workspaceId: string;
  mcpUrl: string | null;
  onIssued: (k: IssuedKey) => void;
}) {
  const { step, setStep, workspaceId, mcpUrl, onIssued } = props;
  const close = () => setStep(null);
  if (step === 'choose') {
    return (
      <Panel title="Connect an app" testId="remote-access-wizard" onClose={close}>
        <p className="pc-settings-hint">How does the app reach Papercup?</p>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <button type="button" data-step="connector" onClick={() => setStep('connector')}>
            Claude.ai or ChatGPT — add Papercup as a connector
          </button>
          <button type="button" data-step="signin" onClick={() => setStep('signin')}>
            An app that signs in with a code (it shows you a code to approve)
          </button>
          <button type="button" data-step="key" onClick={() => setStep('key')}>
            A script or service — create a key for it
          </button>
        </div>
      </Panel>
    );
  }
  if (step === 'connector') {
    return (
      <Panel title="Add Papercup to Claude.ai or ChatGPT" testId="remote-access-wizard" onClose={close}>
        {mcpUrl ? (
          <>
            <p className="pc-settings-hint">
              In Claude.ai open Settings → Connectors → Add custom connector (in ChatGPT: Settings → Connectors → Create) and
              paste this URL. The app then sends you here to approve what it may do.
            </p>
            <CopyField label="Connector URL" value={mcpUrl} />
          </>
        ) : (
          <p className="pc-settings-hint">
            This computer has no route from the internet yet. Set up a tunnel under Route above, then come back here.
          </p>
        )}
        <button type="button" style={{ marginTop: 12 }} onClick={() => setStep('choose')}>Back</button>
      </Panel>
    );
  }
  if (step === 'signin') return <SignInApprovals workspaceId={workspaceId} onBack={() => setStep('choose')} onClose={close} />;
  return <CreateKeyForm workspaceId={workspaceId} onBack={() => setStep('choose')} onClose={close} onIssued={onIssued} />;
}

function SignInApprovals({ workspaceId, onBack, onClose }: { workspaceId: string; onBack: () => void; onClose: () => void }) {
  const [grants, setGrants] = useState<PendingGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/connected-apps/device/pending', { cache: 'no-store' });
      const j = (await r.json()) as { grants?: PendingGrant[] };
      setGrants(j.grants ?? []);
    } catch (e) {
      toast.error(`Could not load waiting sign-ins: ${e instanceof Error ? e.message : String(e)}`);
      setGrants([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const decide = async (g: PendingGrant, decision: 'approve' | 'deny') => {
    setBusy(g.userCode);
    try {
      await postJson('/api/connected-apps/device/decision', { userCode: g.userCode, decision, workspaceId });
      toast.success(decision === 'approve' ? `${g.clientLabel} can now reach ${workspaceId}` : `${g.clientLabel} denied`);
      await load();
    } catch (e) {
      toast.error(`Could not ${decision}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title="Approve an app's sign-in" testId="remote-access-wizard" onClose={onClose}>
      <p className="pc-settings-hint">
        Start the sign-in in the app. When it shows a code, find the same code below and approve it for workspace{' '}
        <code>{workspaceId}</code>.
      </p>
      {grants === null && <p className="pc-settings-hint">Loading…</p>}
      {grants?.length === 0 && <p className="pc-settings-hint">No app is waiting to sign in.</p>}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
        {grants?.map((g) => (
          <li key={g.userCode} style={entryStyle}>
            <div style={{ fontWeight: 500 }}>
              {g.clientLabel} · <code>{g.userCode}</code>
            </div>
            <div className="pc-settings-hint">
              Asks for: {g.requestedScopes.tools?.length ? g.requestedScopes.tools.join(', ') : 'no tools'} · expires {when(g.expiresAt)}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" disabled={busy !== null} onClick={() => void decide(g, 'approve')}>Approve</button>
              <button type="button" disabled={busy !== null} onClick={() => void decide(g, 'deny')}>Deny</button>
            </div>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={() => void load()}>Refresh</button>
        <button type="button" onClick={onBack}>Back</button>
      </div>
    </Panel>
  );
}

const KEY_KINDS: ReadonlyArray<{ value: 'app' | 'service'; text: string }> = [
  { value: 'app', text: 'App key — acts for you' },
  { value: 'service', text: 'Service key — belongs to the workspace, needs a spending cap' },
];

function CreateKeyForm(props: { workspaceId: string; onBack: () => void; onClose: () => void; onIssued: (k: IssuedKey) => void }) {
  const { workspaceId, onBack, onClose, onIssued } = props;
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'app' | 'service'>('app');
  const [tools, setTools] = useState('');
  const [harnesses, setHarnesses] = useState('');
  const [capDollars, setCapDollars] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const create = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const body: Record<string, unknown> = { label: label.trim(), workspaceId, kind, tools: lines(tools) };
      const h = lines(harnesses);
      if (h.length) body.harnesses = h;
      if (capDollars.trim()) body.spendCapCents = Math.round(Number(capDollars) * 100);
      if (expiresOn) body.expiresAt = new Date(`${expiresOn}T23:59:59`).toISOString();
      const r = await postJson<{ key: string; snippets: IssuedKey['snippets'] }>('/api/connected-apps', body);
      onIssued({ label: label.trim(), key: r.key, snippets: r.snippets });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Create a key" testId="remote-access-wizard" onClose={onClose}>
      <div style={{ display: 'grid', gap: 8 }}>
        <label>
          <span className="pc-settings-hint">Name</span>
          <input data-field="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. nightly report" style={{ width: '100%' }} />
        </label>
        <RadioGroup label="Key type" className="pc-settings-radio-group" value={kind} options={KEY_KINDS} onChange={setKind}>
          {(option, selected) => (
            <>
              <span aria-hidden="true">{selected ? '◉' : '○'}</span> {option.text}
            </>
          )}
        </RadioGroup>
        <label>
          <span className="pc-settings-hint">Tools it may call — one per line (`group:verb` or `group:*`).</span>
          <textarea data-field="tools" value={tools} onChange={(e) => setTools(e.target.value)} rows={3} style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }} />
        </label>
        <label>
          <span className="pc-settings-hint">Projects it may touch — one per line (empty = all).</span>
          <textarea value={harnesses} onChange={(e) => setHarnesses(e.target.value)} rows={2} style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }} />
        </label>
        <label>
          <span className="pc-settings-hint">Spending cap in dollars {kind === 'service' ? '(required)' : '(optional)'}</span>
          <input value={capDollars} onChange={(e) => setCapDollars(e.target.value)} inputMode="decimal" style={{ width: 120 }} />
        </label>
        <label>
          <span className="pc-settings-hint">Expires on (optional)</span>
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
        {problem && <p className="pc-settings-note" role="alert">{problem}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" data-action="create-key" onClick={create} disabled={saving || !label.trim()}>
            {saving ? 'Creating…' : 'Create key'}
          </button>
          <button type="button" onClick={onBack}>Back</button>
        </div>
      </div>
    </Panel>
  );
}
