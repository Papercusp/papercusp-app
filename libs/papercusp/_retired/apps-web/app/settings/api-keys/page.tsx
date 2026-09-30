'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface MaskedCredentials {
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  github_pat: string | null;
  updated_at: string | null;
  path: string;
}

export default function ApiKeysPage() {
  const [masked, setMasked] = useState<MaskedCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state. Empty = "leave alone"; non-empty = "overwrite".
  const [anthropic, setAnthropic] = useState('');
  const [openai, setOpenai] = useState('');
  const [github, setGithub] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/credentials')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setMasked(d); })
      .catch((e) => { if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!anthropic && !openai && !github) {
      toast.message('Nothing to save — fill at least one field.');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (anthropic) body.anthropic_api_key = anthropic;
      if (openai) body.openai_api_key = openai;
      if (github) body.github_pat = github;
      const r = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: MaskedCredentials = await r.json();
      setMasked(d);
      // Clear inputs once saved so users see the masked values came back.
      setAnthropic('');
      setOpenai('');
      setGithub('');
      toast.success(`Saved to ${d.path}`);
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1>API keys</h1>

      <div className="pc-warn" role="status">
        ⚠ <strong>These keys stay on your computer.</strong> They&rsquo;re written to{' '}
        <code>~/.papercusp/credentials.json</code> with permissions <code>0600</code>{' '}
        (your user only). They are <strong>never</strong> sent to or stored on
        Papercusp&rsquo;s servers. If you lose this file, you&rsquo;ll need to re-enter
        the keys here.
      </div>

      <form onSubmit={onSave} className="pc-card" style={{ maxWidth: 640 }}>
        <Field
          id="anthropic"
          label="Anthropic API key"
          help="Required. Used by every harness role for `claude -p` invocations."
          placeholder={masked?.anthropic_api_key ?? 'sk-ant-…'}
          masked={masked?.anthropic_api_key}
          loading={loading}
          value={anthropic}
          onChange={setAnthropic}
        />
        <Field
          id="openai"
          label="OpenAI API key"
          help="Optional. Used by some plugins (e.g. embeddings, transcription)."
          placeholder={masked?.openai_api_key ?? 'sk-…'}
          masked={masked?.openai_api_key}
          loading={loading}
          value={openai}
          onChange={setOpenai}
        />
        <Field
          id="github"
          label="GitHub personal access token"
          help="Optional. Needed only if you want to publish harnesses to the marketplace."
          placeholder={masked?.github_pat ?? 'ghp_…'}
          masked={masked?.github_pat}
          loading={loading}
          value={github}
          onChange={setGithub}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button type="submit" className="pc-button primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {masked?.updated_at && (
            <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
              Last updated <time dateTime={masked.updated_at}>{new Date(masked.updated_at).toLocaleString()}</time>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function Field({
  id,
  label,
  help,
  placeholder,
  masked,
  loading,
  value,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  placeholder: string;
  masked: string | null | undefined;
  loading: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="pc-form-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        className="pc-input"
        placeholder={loading ? 'loading…' : placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="help">
        {help}
        {!loading && masked && (
          <>
            {' '}Currently set to <span className="placeholder-mask">{masked}</span>.
            Leave the field empty to keep it; type to overwrite.
          </>
        )}
        {!loading && !masked && <> Currently <strong>not set</strong>.</>}
      </span>
    </div>
  );
}
