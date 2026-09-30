'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { Select } from '@/app/harness/Select';
import { useLexicon } from '@/lib/useLexicon';

interface QrPayload {
  server: string;
  pairToken: string;
  workspaceId: string;
}

interface PairedDevice {
  device_id: string;
  device_label: string | null;
  paired_at: string;
  last_seen: string | null;
  workspace_id: string;
}

interface MintResp {
  qrPayload: QrPayload;
  expiresAt: number;
}

interface WorkspaceOption {
  id: string;
  name: string;
}

export default function MobileSettingsPage() {
  const t = useLexicon();
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState('default');
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    refreshDevices();
    loadWorkspaces();
  }, []);

  const loadWorkspaces = async () => {
    try {
      const res = await fetch('/api/workspaces');
      if (!res.ok) return;
      const body = (await res.json()) as { current?: string; workspaces?: WorkspaceOption[] };
      const list = body.workspaces ?? [];
      setWorkspaces(list);
      if (body.current) setWorkspaceId(body.current);
      else if (list.length > 0) setWorkspaceId(list[0].id);
    } catch {
      /* ignore — falls back to "default" */
    }
  };

  const refreshDevices = async () => {
    try {
      const res = await fetch('/api/device/desktop/devices');
      if (!res.ok) return;
      const body = (await res.json()) as { devices: PairedDevice[] };
      setDevices(body.devices);
    } catch {
      /* ignore */
    }
  };

  const mint = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/device/desktop/mint-pair-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as MintResp;
      setQr(body.qrPayload);
      setExpiresAt(body.expiresAt);
    } catch (e) {
      toast.error(`Pair-token mint failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setQr(null);
    setExpiresAt(0);
  };

  const revoke = async (deviceId: string) => {
    const ok = await askConfirm({
      title: 'Revoke this device?',
      body: 'It will need to re-pair to use Papercup Mobile.',
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/device/desktop/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Device revoked');
      refreshDevices();
    } catch (e) {
      toast.error(`Revoke failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const remainingMs = qr ? Math.max(0, expiresAt - now) : 0;
  const remainingS = Math.floor(remainingMs / 1000);

  return (
    <div>
      {confirmEl}
      <header>
        <h1>Mobile access</h1>
        <p className="pc-settings-intro">
          Pair the Papercup Mobile app on your phone to monitor {t('pot', { plural: true, lower: true })}, voice-control Papercup, and receive intervention pushes when away from your desk.
        </p>
      </header>

      <section className="pc-settings-section">
        <h2>Pair a new device</h2>

        {!qr && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Select
              value={workspaceId}
              onChange={setWorkspaceId}
              options={
                workspaces.length === 0
                  ? [{ value: workspaceId, label: workspaceId }]
                  : workspaces.map((w) => ({ value: w.id, label: `${w.name} (${w.id})` }))
              }
              ariaLabel="Workspace"
            />
            <button type="button" onClick={mint} disabled={busy}>
              {busy ? 'Generating…' : 'Show QR code'}
            </button>
          </div>
        )}

        {qr && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <QRSvg payload={qr} />
            <div className="pc-settings-hint">
              Expires in {Math.floor(remainingS / 60)}:{String(remainingS % 60).padStart(2, '0')}
            </div>
            <p className="pc-settings-hint" style={{ maxWidth: 420, textAlign: 'center' }}>
              On your phone, open PaperCusp → &quot;Scan QR&quot; → point at this code. Or use the manual code below.
            </p>
            <ManualPayloadBox payload={qr} />
            <button type="button" onClick={cancel}>Cancel</button>
          </div>
        )}
      </section>

      <section className="pc-settings-section">
        <h2>Paired devices</h2>
        {devices.length === 0 ? (
          <p className="pc-settings-hint" style={{ marginTop: 12 }}>No devices paired yet.</p>
        ) : (
          <ul style={{ marginTop: 12, listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {devices.map((d) => (
              <li
                key={d.device_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-2)',
                  borderRadius: 6,
                  padding: '12px 16px',
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
                    {d.device_label ?? '(unnamed)'}
                  </div>
                  <div className="pc-settings-hint" style={{ marginTop: 2 }}>
                    workspace {d.workspace_id} • paired {new Date(d.paired_at).toLocaleString()}
                    {d.last_seen ? ` • last seen ${new Date(d.last_seen).toLocaleString()}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(d.device_id)}
                  style={{ color: 'var(--bad, #f87171)', borderColor: 'color-mix(in oklab, var(--bad, #f87171), transparent 60%)' }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * QR rendered server-side via /api/device/qr.svg. The phone's barcode scanner
 * reads the JSON payload directly from the SVG.
 */
function ManualPayloadBox({ payload }: { payload: QrPayload }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(payload);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the text and copy manually');
    }
  };
  return (
    <div style={{
      width: '100%',
      maxWidth: 420,
      border: '1px solid color-mix(in oklab, var(--accent, #6aa7ff), transparent 50%)',
      background: 'var(--bg-2)',
      borderRadius: 6,
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="pc-settings-eyebrow" style={{ margin: 0 }}>Manual pair payload</span>
        <button type="button" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <textarea
        readOnly
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        rows={3}
        style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }}
      />
      <p className="pc-settings-hint" style={{ margin: 0, fontSize: 11 }}>
        Paste this into the phone&apos;s &quot;Manual pair code&quot; field — it contains the server URL and token together.
      </p>
    </div>
  );
}

function QRSvg({ payload }: { payload: QrPayload }) {
  const json = JSON.stringify(payload);
  const src = `/api/device/qr.svg?payload=${encodeURIComponent(json)}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Pairing QR code"
      style={{ height: 256, width: 256, borderRadius: 6, background: '#fff', padding: 8 }}
    />
  );
}
