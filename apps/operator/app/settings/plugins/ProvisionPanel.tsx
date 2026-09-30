/**
 * Provision panel — consent + run/teardown/verify driver for one
 * (harness, plugin) pair where the plugin declares a `provision` block.
 *
 * Surfaces:
 *   - Setup state banner (clean / setup-stale / setup-failed)
 *   - "Run setup" button → POST /api/provision/run with consentConfirmed
 *   - Recorded resources list
 *   - Audit log (last N entries)
 *   - Teardown / verify buttons
 *
 * Spec: /docs/snapshots/build-scripts.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import * as Collapsible from '@radix-ui/react-collapsible';

interface ProvisionScriptDecl {
  path: string;
  timeoutSec?: number;
  displayName?: string;
  description?: string;
  // Real manifests (cloudflare-stack et al.) declare these per-script;
  // the SDK type carries them on the parent PluginProvision. The panel
  // reads both shapes — parent wins, script-level is the fallback.
  cloudProvider?: { id: string; region?: string; regions?: string[] };
  allowedHosts?: string[];
}

interface ProvisionDecl {
  setup?: ProvisionScriptDecl;
  teardown?: ProvisionScriptDecl;
  verify?: ProvisionScriptDecl;
  cloudProvider?: { id: string; region?: string; regions?: string[] };
  allowedHosts?: string[];
}

interface RecordedResource {
  kind: string;
  externalId: string;
  recordedAt: string;
  metadata?: Record<string, unknown>;
}

interface ProvisionState {
  schemaVersion: 1;
  hashes: { configHash: string; scriptHash: string; pluginVersion: string } | null;
  createdResources: RecordedResource[];
  outputs: Record<string, unknown>;
  lastSetupAt: string | null;
  lastVerifyAt: string | null;
  setupFailed: boolean;
  setupError?: string;
}

interface AuditEntry {
  ts: string;
  kind: string;
  runId?: string;
  data?: Record<string, unknown>;
}

interface Props {
  harness: string;
  plugin: string;
  provision: ProvisionDecl;
}

export function ProvisionPanel({ harness, plugin, provision }: Props) {
  const [state, setState] = useState<ProvisionState | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [running, setRunning] = useState<'setup' | 'teardown' | 'verify' | null>(null);
  const cloudProvider = provision.cloudProvider ?? provision.setup?.cloudProvider;
  const allowedHosts = provision.allowedHosts ?? provision.setup?.allowedHosts ?? [];

  const reload = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/provision/state?harness=${encodeURIComponent(harness)}&plugin=${encodeURIComponent(plugin)}&auditLimit=30`,
        { cache: 'no-store' },
      );
      const d = await r.json();
      if (d.ok) {
        setState(d.state);
        setAudit(d.audit ?? []);
      }
    } catch (e: any) {
      toast.error(`provision state load failed: ${e?.message ?? e}`);
    }
  }, [harness, plugin]);

  useEffect(() => {
    if (harness && plugin) reload();
  }, [harness, plugin, reload]);

  async function runPhase(phase: 'setup' | 'teardown' | 'verify') {
    setRunning(phase);
    try {
      const r = await fetch('/api/provision/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness, plugin, phase, consentConfirmed: true }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`${phase} failed`, { description: d.error ?? `exit ${d.exitCode}` });
      } else {
        toast.success(`${phase} ${d.decision === 'unchanged' ? 'unchanged (skipped)' : 'succeeded'}`);
      }
      await reload();
    } catch (e: any) {
      toast.error(`${phase} crashed: ${e?.message ?? e}`);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div style={panel}>
      <h4 style={{ margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase', color: 'var(--fg-mute)' }}>
        Provisioning
      </h4>

      {state?.setupFailed && (
        <div style={banner('error')}>
          <strong>Setup failed.</strong> {state.setupError ?? 'Check the audit log below.'}
          <div style={{ marginTop: 6 }}>
            {provision.teardown && (
              <button disabled={!!running} onClick={() => runPhase('teardown')} style={btn}>
                Run teardown to clean up
              </button>
            )}
          </div>
        </div>
      )}

      {!state?.hashes && !state?.setupFailed && (
        <div style={banner('info')}>
          Setup has not been run on <strong>{harness}</strong> yet.
          {/* Consent surface: clicking "Run setup" IS the consent, so what
              the script does must be readable before the click — the
              manifest's displayName/description + its network reach. */}
          {provision.setup?.displayName && (
            <div style={{ marginTop: 6, fontWeight: 600 }}>{provision.setup.displayName}</div>
          )}
          {provision.setup?.description && (
            <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5 }}>{provision.setup.description}</div>
          )}
          {cloudProvider && (
            <div style={{ marginTop: 4, fontSize: 11 }}>
              Cloud provider: <code>{cloudProvider.id}</code>
              {cloudProvider.region && <> · region <code>{cloudProvider.region}</code></>}
            </div>
          )}
          {allowedHosts.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11 }}>
              Network access:{' '}
              {allowedHosts.map((h, i) => (
                <span key={h}>{i > 0 && ', '}<code>{h}</code></span>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {provision.setup && (
          <button disabled={!!running} onClick={() => runPhase('setup')} style={primary}>
            {running === 'setup' ? 'Running setup…' : state?.hashes ? 'Re-run setup' : 'Run setup'}
          </button>
        )}
        {provision.verify && (
          <button disabled={!!running} onClick={() => runPhase('verify')} style={btn}>
            {running === 'verify' ? 'Verifying…' : 'Verify'}
          </button>
        )}
        {provision.teardown && (state?.createdResources?.length ?? 0) > 0 && (
          <button disabled={!!running} onClick={() => runPhase('teardown')} style={btnDanger}>
            {running === 'teardown' ? 'Tearing down…' : 'Teardown'}
          </button>
        )}
      </div>

      {state?.createdResources && state.createdResources.length > 0 && (
        <Collapsible.Root defaultOpen style={{ marginBottom: 12 }}>
          <Collapsible.Trigger asChild>
            <button type="button" style={{ ...summary, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}>
              Recorded resources ({state.createdResources.length})
            </button>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <ul style={list}>
              {state.createdResources.map((r) => (
                <li key={`${r.kind}:${r.externalId}`} style={li}>
                  <code style={{ color: 'var(--accent)' }}>{r.kind}</code>{' '}
                  <code>{r.externalId}</code>
                  <span style={{ float: 'right', fontSize: 11, color: 'var(--fg-mute)' }}>
                    {new Date(r.recordedAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      {audit.length > 0 && (
        <Collapsible.Root>
          <Collapsible.Trigger asChild>
            <button type="button" style={{ ...summary, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}>
              Audit log ({audit.length})
            </button>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <ul style={{ ...list, fontFamily: 'monospace', fontSize: 11 }}>
              {audit.map((e, i) => (
                <li key={i} style={li}>
                  <span style={{ color: 'var(--fg-mute)' }}>{new Date(e.ts).toLocaleTimeString()}</span>{' '}
                  <strong style={{ color: kindColor(e.kind) }}>{e.kind}</strong>
                  {e.data && <span style={{ marginLeft: 6, color: 'var(--fg-mute)' }}>{shortJson(e.data)}</span>}
                </li>
              ))}
            </ul>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      {state?.hashes && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--fg-mute)' }}>
          configHash <code>{state.hashes.configHash.slice(7, 19)}</code>{' · '}
          scriptHash <code>{state.hashes.scriptHash.slice(7, 19)}</code>{' · '}
          v<code>{state.hashes.pluginVersion}</code>
        </div>
      )}
    </div>
  );
}

export function shortJson(o: unknown): string {
  const s = JSON.stringify(o);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

export function kindColor(k: string): string {
  if (k.endsWith('-failed')) return 'var(--bad)';
  if (k.endsWith('-succeeded')) return 'var(--good)';
  if (k === 'consent-rejected') return 'var(--bad)';
  if (k === 'log-truncated') return 'var(--warn)';
  return 'var(--fg-dim)';
}

const panel: React.CSSProperties = {
  marginTop: 24, padding: 16, border: '1px solid var(--border)',
  borderRadius: 6, background: 'var(--bg-1)',
};
function banner(tone: 'info' | 'error'): React.CSSProperties {
  return {
    padding: '8px 12px', marginBottom: 12, borderRadius: 4, fontSize: 12,
    background: tone === 'error' ? 'color-mix(in oklab, var(--bad), transparent 86%)' : 'color-mix(in oklab, var(--accent), transparent 88%)',
    border: `1px solid ${tone === 'error' ? 'color-mix(in oklab, var(--bad), transparent 64%)' : 'color-mix(in oklab, var(--accent), transparent 68%)'}`,
    color: tone === 'error' ? 'var(--bad)' : 'var(--fg)',
  };
}
const summary: React.CSSProperties = {
  cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--fg-mute)',
  padding: '4px 0',
};
const list: React.CSSProperties = { listStyle: 'none', padding: 0, margin: '4px 0 0', fontSize: 12 };
const li: React.CSSProperties = { padding: '4px 0', borderBottom: '1px solid var(--border)' };
const btn: React.CSSProperties = {
  padding: '6px 12px', background: 'transparent', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
};
const btnDanger: React.CSSProperties = {
  ...btn, color: 'var(--bad)', border: '1px solid color-mix(in oklab, var(--bad), transparent 64%)',
};
const primary: React.CSSProperties = {
  padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-ink)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
};
