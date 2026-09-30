'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';
import { Button } from '@/app/harness/Button';
import { useLexicon } from '@/lib/useLexicon';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import RouteLink from '@/app/_components/RouteLink';
import { LazyDetails } from '@/app/_components/LazyDetails';

interface MaskedCoreCredentials {
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  zeroentropy_api_key: string | null;
  github_pat: string | null;
  updated_at: string | null;
  path: string;
}

interface VoiceCredsState { configured: boolean; apiKey: string | null }
interface VoiceCredsSnapshot {
  elevenlabs: VoiceCredsState;
  openai: VoiceCredsState;
  cartesia: VoiceCredsState;
  deepgram: VoiceCredsState;
  picovoice: VoiceCredsState;
}

// Core keys (OpenAI embeddings, ZeroEntropy, GitHub) — leave-alone-on-empty semantics.
//
// No `anthropic` entry since inference-rename-and-provider-agnostic-default-2026-08-09 P-004:
// Anthropic access comes from the default account under Settings → Inference, not a raw key.
// `Credentials.anthropic_api_key` is still READ as a legacy fall-through (D-001) and can still
// be written by `setup:save_key` — this page just stops offering it as the way to configure it.
const ApiKeysSchema = z.object({
  openai: z.string().optional().default(''),
  zeroentropy: z.string().optional().default(''),
  github: z.string().optional().default(''),
});
type ApiKeysFormData = z.infer<typeof ApiKeysSchema>;

export default function ApiKeysPage() {
  const t = useLexicon();
  const [masked, setMasked] = useState<MaskedCoreCredentials | null>(null);
  const [voiceCreds, setVoiceCreds] = useState<VoiceCredsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const { register, submit, reset, errors, isSubmitting } = useFormWith(ApiKeysSchema, {
    defaultValues: { openai: '', zeroentropy: '', github: '' },
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/credentials').then(r => r.json()),
      fetch('/api/agent-mcp/operator-credentials').then(r => r.ok ? r.json() : null),
    ])
      .then(([core, voice]) => {
        if (cancelled) return;
        setMasked(core);
        if (voice) setVoiceCreds(voice as VoiceCredsSnapshot);
      })
      .catch((e) => { if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const onSubmit = async (data: ApiKeysFormData) => {
    if (!data.openai && !data.zeroentropy && !data.github) {
      toast.message('Nothing to save — fill at least one field.');
      return;
    }
    try {
      const body: Record<string, string> = {};
      if (data.openai) body.openai_api_key = data.openai;
      if (data.zeroentropy) body.zeroentropy_api_key = data.zeroentropy;
      if (data.github) body.github_pat = data.github;
      const r = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: MaskedCoreCredentials = await r.json();
      setMasked(d);
      reset({ openai: '', zeroentropy: '', github: '' });
      toast.success(`Saved to ${d.path}`);
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    }
  };

  if (loading) {
    return (
      <div>
        <h1>API keys</h1>
        <p className="pc-settings-loading">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <h1>API keys</h1>
      <p className="pc-settings-intro">
        Bring-your-own API keys for the services Papercusp talks to. To sign in to a
        Claude or Codex <em>subscription</em> instead, add it under{' '}
        <RouteLink href="/settings/deploy-accounts">Inference</RouteLink> — that pool is
        the single place account logins live, and one of its accounts can be marked the
        default for everything on this machine, whether it is an Anthropic or an OpenAI
        account.
      </p>

      <div className="pc-warn pc-settings-inline-callout" role="status">
        <strong>Keys stay on this computer.</strong>
        <span>Stored at <code>~/.papercusp/credentials.json</code> with user-only permissions; Papercusp never stores them on its servers.</span>
      </div>

      <section className="pc-settings-section">
        <h2>API keys — Core</h2>
        <p className="pc-settings-hint" style={{ marginBottom: 12 }}>
          These are raw provider keys, not account logins. Anthropic and Codex/OpenAI
          <em> model access</em> comes from the default account under{' '}
          <RouteLink href="/settings/deploy-accounts">Inference</RouteLink> — there is no
          Anthropic key to set here. The OpenAI key below is for <em>embeddings</em>, which no
          subscription account can serve. GitHub PAT is needed only when publishing{' '}
          {t('pot', { plural: true, lower: true })} to the marketplace.
        </p>

        <form onSubmit={submit(onSubmit)} className="pc-card">
        <SecretField
          label="OpenAI embeddings key"
          help="Powers semantic search and memory embeddings (text-embedding-3-small), plus LLM fallback for some plugins. This is a raw API key and works SEPARATELY from any OpenAI/Codex account under Inference — a subscription account cannot serve embeddings, so this slot stays even when a default account is set. It is also a separate slot from the OpenAI voice key below."
          placeholder={masked?.openai_api_key ?? 'sk-…'}
          masked={masked?.openai_api_key}
          uses={['Semantic search', 'Memory', 'LLM fallback']}
          loading={loading}
          register={register('openai')}
          error={errors.openai?.message}
        />
        <SecretField
          label="ZeroEntropy API key (search rerank)"
          help="Optional. Enables the cross-encoder rerank stage (zerank-2) over agent-memory search results. Without it, search returns the RRF-fused order unchanged — so this is purely a relevance upgrade that turns on the moment a key is set."
          placeholder={masked?.zeroentropy_api_key ?? 'ze_…'}
          masked={masked?.zeroentropy_api_key}
          uses={['Search rerank']}
          loading={loading}
          register={register('zeroentropy')}
          error={errors.zeroentropy?.message}
        />
        <SecretField
          label="GitHub personal access token"
          help={`Optional. Needed only if you want to publish ${t('pot', { plural: true, lower: true })} to the marketplace.`}
          placeholder={masked?.github_pat ?? 'ghp_…'}
          masked={masked?.github_pat}
          uses={['Marketplace publishing']}
          loading={loading}
          register={register('github')}
          error={errors.github?.message}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <SubmitButton pending={isSubmitting}>Save</SubmitButton>
          {masked?.updated_at && (
            <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
              Last updated <time dateTime={masked.updated_at}>{new Date(masked.updated_at).toLocaleString()}</time>
            </span>
          )}
          </div>
        </form>
      </section>

      <SearchProvidersSection />

      <section className="pc-settings-section">
        <h2>Voice & cloud engines</h2>
        <p className="pc-settings-hint" style={{ marginBottom: 12 }}>
          Optional keys for cloud STT (Deepgram), cloud TTS (ElevenLabs, OpenAI,
          Cartesia), wake-word/noise-suppression (Picovoice), and full-agent voice
          modes (Google for Gemini Live, OpenAI for Realtime). Configure only the
          ones you actually use — local Voicemode + Kokoro work without any of these.
        </p>
        {voiceCreds && (
          <div>
          <VoiceKeyRow
            label="OpenAI (voice)"
            field="openaiApiKey"
            state={voiceCreds.openai}
            placeholder="sk-..."
            helpUrl="https://platform.openai.com/api-keys"
            note="Used for OpenAI tts-1 voices AND OpenAI Realtime full-agent mode."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="ElevenLabs"
            field="elevenlabsApiKey"
            state={voiceCreds.elevenlabs}
            placeholder="sk_..."
            helpUrl="https://elevenlabs.io/app/settings/api-keys"
            note="ElevenLabs Turbo v2.5 TTS + ElevenLabs Conversational AI full-agent mode."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="Cartesia"
            field="cartesiaApiKey"
            state={voiceCreds.cartesia}
            placeholder="sk_..."
            helpUrl="https://play.cartesia.ai/keys"
            note="Cartesia Sonic-2 TTS — fastest first-byte (<100ms)."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="Deepgram"
            field="deepgramApiKey"
            state={voiceCreds.deepgram}
            placeholder="dg_..."
            helpUrl="https://console.deepgram.com/project/default/keys"
            note="Deepgram Nova-2 STT (alternative to Voicemode whisper)."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="Picovoice"
            field="picovoiceApiKey"
            state={voiceCreds.picovoice}
            placeholder="pv_..."
            helpUrl="https://console.picovoice.ai/"
            note="Wake-word (Porcupine) + noise suppression (Koala). Free tier covers personal use."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          </div>
        )}
      </section>
    </div>
  );
}

function VoiceKeyRow({
  label, field, state, placeholder, helpUrl, note, onChange,
}: {
  label: string;
  field: 'elevenlabsApiKey' | 'openaiApiKey' | 'cartesiaApiKey' | 'deepgramApiKey' | 'picovoiceApiKey';
  state: VoiceCredsState;
  placeholder: string;
  helpUrl: string;
  note: string;
  onChange: (snap: VoiceCredsSnapshot) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-credentials', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: draft.trim() }),
      });
      if (r.ok) {
        onChange((await r.json()) as VoiceCredsSnapshot);
        setDraft('');
        toast.success(`${label} key saved`);
      } else {
        toast.error(`Save failed: HTTP ${r.status}`);
      }
    } catch (err) {
      // Network-level failure (no HTTP response) — without this the rejection
      // was unhandled and the user saw nothing.
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally { setBusy(false); }
  };

  const clear = async () => {
    const ok = await askConfirm({
      title: `Clear the ${label} API key?`,
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-credentials', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: null }),
      });
      if (r.ok) onChange((await r.json()) as VoiceCredsSnapshot);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginBottom: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 4 }}>
      {confirmEl}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <strong style={{ fontSize: 13 }}>{label}</strong>
          <span className={`pc-settings-status-pill ${state.configured ? 'is-set' : 'is-empty'}`}>
            {state.configured ? 'Set' : 'Not set'}
          </span>
        </div>
        <a href={helpUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, opacity: 0.7, flex: '0 0 auto' }}>get key →</a>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginBottom: 8 }}>{note}</p>
      {state.configured ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code className="pc-settings-secret-value">
            {state.apiKey ?? '(masked)'}
          </code>
          <button type="button" onClick={clear} disabled={busy}
            style={{ padding: '4px 10px', fontSize: 12, color: 'var(--bad)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>
            Clear
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            style={{ flex: 1, padding: '4px 8px', fontSize: 12, fontFamily: 'monospace' }}
          />
          <button type="button" onClick={save} disabled={busy || !draft.trim()}
            style={{ padding: '4px 12px', fontSize: 12, background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function SecretField({
  label,
  help,
  uses,
  placeholder,
  masked,
  loading,
  register,
  error,
}: {
  label: string;
  help: string;
  uses?: string[];
  placeholder: string;
  masked: string | null | undefined;
  loading: boolean;
  register: UseFormRegisterReturn;
  error?: string;
}) {
  return (
    <FormField
      label={label}
      error={error}
      description={help}
    >
      <input
        type="password"
        className="pc-input"
        placeholder={loading ? 'loading…' : placeholder}
        autoComplete="off"
        spellCheck={false}
        {...register}
      />
      <div className="pc-settings-field-status">
        <span className={`pc-settings-status-pill ${masked ? 'is-set' : 'is-empty'}`}>
          {loading ? 'Checking…' : masked ? 'Set' : 'Not set'}
        </span>
        {masked && <span className="pc-settings-status-copy">Leave blank to keep; type to overwrite.</span>}
      </div>
      {uses && uses.length > 0 && (
        <div className="pc-settings-usage-badges" aria-label={`${label} usage`}>
          {uses.map((use) => <span key={use}>{use}</span>)}
        </div>
      )}
    </FormField>
  );
}

/* ─── Search-provider keys section ──────────────────────────────────── */

interface ProviderField {
  envVar: string;
  masked: string | null;
  isPrimary: boolean;
}
interface ProviderRow {
  id: string;
  label: string;
  fields: ProviderField[];
}
interface ProvidersResponse {
  providers: ProviderRow[];
  updatedAt: number | null;
}

function SearchProvidersSection() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/credentials/search-providers', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setData(d as ProvidersResponse))
      .catch((e) => setError(e?.message ?? String(e)));
  }, []);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const values: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(drafts)) {
        // Empty string after trim → null (clear); else use the value.
        const trimmed = v.trim();
        values[k] = trimmed.length > 0 ? trimmed : null;
      }
      const res = await fetch('/api/credentials/search-providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const next = await res.json();
      if (!res.ok) throw new Error((next && next.error) || `HTTP ${res.status}`);
      setData(next as ProvidersResponse);
      setDrafts({});
      toast.success('Search-provider keys updated');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pc-settings-section">
      <h2>Search providers</h2>
      <p className="pc-settings-hint" style={{ marginBottom: 12 }}>
        API keys for OMP&rsquo;s 14 web-search providers. Set the ones you actually use; the
        orchestrator injects them into OMP&rsquo;s spawn env. OMP&rsquo;s search chain
        falls through to whichever provider is configured.
        See <RouteLink href="/settings/omp" style={{ color: 'var(--fg)' }}>OMP settings → providers.webSearch</RouteLink>{' '}
        to set the preferred provider.
      </p>
      {error && (
        <div className="pc-warn" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {!data && !error && <div style={{ color: 'var(--fg-mute)' }}>Loading…</div>}
      {data && (
        <div style={{ maxWidth: 640, display: 'grid', gap: 8 }}>
          {data.providers.map((p) => (
            <LazyDetails
              key={p.id}
              style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px' }}
              summaryStyle={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
              summary={
                <>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                    {p.fields.some((f) => f.masked) ? 'Configured' : 'Not configured'}
                  </span>
                </>
              }
            >
              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                {p.fields.map((f) => (
                  <div key={f.envVar} style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 2 }}>
                    <label style={{ fontSize: 11, color: 'var(--fg-mute)', fontFamily: 'monospace' }}>
                      {f.envVar}
                      {f.isPrimary && <span style={{ marginLeft: 6, color: 'var(--fg-dim)' }}>(primary)</span>}
                    </label>
                    <input
                      type="password"
                      placeholder={f.masked ?? '—'}
                      value={drafts[f.envVar] ?? ''}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [f.envVar]: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      style={{
                        padding: '6px 8px', fontSize: 12, fontFamily: 'monospace',
                        background: 'var(--bg-1)', border: '1px solid var(--border)',
                        borderRadius: 3, color: 'var(--fg)',
                      }}
                    />
                  </div>
                ))}
              </div>
            </LazyDetails>
          ))}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button
              size="lg"
              variant="primary"
              onClick={onSave}
              disabled={saving || Object.keys(drafts).length === 0}
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              {saving ? 'Saving…' : `Save ${Object.keys(drafts).length} change${Object.keys(drafts).length === 1 ? '' : 's'}`}
            </Button>
            {Object.keys(drafts).length > 0 && (
              <Button
                size="lg"
                onClick={() => setDrafts({})}
                style={{ padding: '6px 14px', fontSize: 13 }}
              >
                Discard
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
