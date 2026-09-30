'use client';

import { useEffect, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { useLexicon } from '@/lib/useLexicon';

interface MaskedCreds {
  tenantId: string | null;
  tenantSecretMasked: string | null;
  registeredAt: string | null;
  publishHost: string | null;
  path: string;
}

export default function PublishingClient() {
  const t = useLexicon();
  const [creds, setCreds] = useState<MaskedCreds | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/publish-credentials');
      setCreds(await r.json());
    } catch (e: unknown) {
      toast.error(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const onRotate = async () => {
    if (!await askConfirm({
      title: 'Rotate the publish secret?',
      body: 'The old secret stops working immediately. Anything storing the old value (CI, deploy scripts) will need to be updated.',
      confirmLabel: 'Rotate',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch('/api/publish-credentials/rotate', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setCreds(d);
      toast.success('Secret rotated.');
    } catch (e: unknown) {
      toast.error(`rotate failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onForget = async () => {
    if (!await askConfirm({
      title: 'Delete local publish credentials?',
      body: 'Future publishes will register a fresh tenant. The marketplace-side record is not affected.',
      confirmLabel: 'Delete credentials',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch('/api/publish-credentials', { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
      toast.success('Credentials cleared.');
    } catch (e: unknown) {
      toast.error(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p>Loading…</p>;

  const registered = creds?.tenantId != null;

  return (
    <div className="pc-settings-section">
      {confirmEl}
      <h1>Publishing</h1>
      <p className="pc-settings-intro">
        One-click public publishing for coding {t('pot', { plural: true, lower: true })}, hosted on{' '}
        <code>*.preview.papercuspai.com</code>. The substrate auto-registers a
        per-machine tenant the first time you click Publish; this page lets you
        review and rotate that machine identity.
      </p>

      {!registered && (
        <div className="pc-callout pc-callout-info">
          <strong>Not yet registered.</strong> Open a coding {t('pot', { lower: true })}, enable the{' '}
          <code>@papercupai/cloudflare-pages</code> plugin, and click
          Publish. The substrate will register a tenant automatically.
        </div>
      )}

      {registered && (
        <dl className="pc-defs">
          <dt>Tenant ID</dt>
          <dd><code>{creds.tenantId}</code></dd>

          <dt>Tenant secret</dt>
          <dd><code>{creds.tenantSecretMasked}</code></dd>

          <dt>Registered at</dt>
          <dd>{creds.registeredAt}</dd>

          <dt>Publish host</dt>
          <dd><code>{creds.publishHost}</code></dd>

          <dt>Stored at</dt>
          <dd><code>{creds.path}</code></dd>
        </dl>
      )}

      {registered && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            className="h-btn"
            onClick={onRotate}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Rotate secret'}
          </button>
          <button
            type="button"
            className="h-btn ghost"
            onClick={onForget}
            disabled={busy}
          >
            Forget credentials
          </button>
        </div>
      )}

      <Collapsible.Root style={{ marginTop: 24 }}>
        <Collapsible.Trigger asChild>
          <button type="button" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
            BYO Cloudflare (eject path)
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <p>
            Per-{t('pot')} plugin config also accepts <code>byoCloudflareToken</code>{' '}
            and <code>byoCloudflareAccountId</code>. When both are set, the
            substrate publishes directly to your own Cloudflare account and{' '}
            <strong>does not</strong> contact <code>{creds?.publishHost ?? 'publish.papercuspai.com'}</code>.
            See <code>libs/papercusp/plugins/cloudflare-pages/README.md</code>.
          </p>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );
}
