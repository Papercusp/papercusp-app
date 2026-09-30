'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Profile {
  email?: string;
  display_name?: string;
  default_project_dir?: string;
  preferred_models?: Record<string, string>;
  theme?: 'dark' | 'light' | 'auto';
  updated_at?: string;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((r) => r.json())
      .then((d) => setProfile(d))
      .catch((e) => toast.error(`load failed: ${e?.message ?? e}`));
  }, []);

  const update = (patch: Partial<Profile>) => {
    setProfile((p) => ({ ...(p ?? {}), ...patch }));
  };

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(profile),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setProfile(d);
      toast.success(`saved to ~/.papercusp/profile.json`);
    } catch (e: any) {
      toast.error(`save failed: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return <div><h1>Profile</h1><p>loading…</p></div>;

  return (
    <div>
      <h1>Profile</h1>

      <div className="pc-warn" role="status" style={{ marginBottom: 16 }}>
        🔓 <strong>Local-only mode.</strong> Cloud sign-in isn&rsquo;t wired
        yet — your profile lives at <code>~/.papercusp/profile.json</code>.
        When auth lands, this same form will start syncing to your account
        across machines. API keys always stay local.
      </div>

      <div className="pc-card" style={{ maxWidth: 640 }}>
        <div className="pc-form-row">
          <label htmlFor="email">Email (optional)</label>
          <input
            id="email"
            type="email"
            className="pc-input"
            placeholder="you@example.com"
            value={profile.email ?? ''}
            onChange={(e) => update({ email: e.target.value })}
          />
          <span className="help">Used to identify you across devices once cloud sync is wired.</span>
        </div>

        <div className="pc-form-row">
          <label htmlFor="display_name">Display name</label>
          <input
            id="display_name"
            type="text"
            className="pc-input"
            placeholder="Your name"
            value={profile.display_name ?? ''}
            onChange={(e) => update({ display_name: e.target.value })}
          />
          <span className="help">Shown next to your harness runs and proposals.</span>
        </div>

        <div className="pc-form-row">
          <label htmlFor="default_project_dir">Default project directory</label>
          <input
            id="default_project_dir"
            type="text"
            className="pc-input"
            placeholder="~/papercusp-projects"
            value={profile.default_project_dir ?? ''}
            onChange={(e) => update({ default_project_dir: e.target.value })}
          />
          <span className="help">Where <code>papercusp init &lt;slug&gt;</code> creates new project directories.</span>
        </div>

        <h3 style={{ marginTop: 24, marginBottom: 8 }}>Preferred models</h3>
        <ModelInput
          label="scoper"
          help="Plans missions and reviews proposals. Bigger model = better plans."
          value={profile.preferred_models?.scoper ?? ''}
          onChange={(v) => update({ preferred_models: { ...profile.preferred_models, scoper: v } })}
        />
        <ModelInput
          label="worker"
          help="Implements features. The high-volume role; pick something fast."
          value={profile.preferred_models?.worker ?? ''}
          onChange={(v) => update({ preferred_models: { ...profile.preferred_models, worker: v } })}
        />
        <ModelInput
          label="validator"
          help="Verifies workers. Bigger model = catches more bugs."
          value={profile.preferred_models?.validator ?? ''}
          onChange={(v) => update({ preferred_models: { ...profile.preferred_models, validator: v } })}
        />
        <ModelInput
          label="reviewer"
          help="Gates plans and proposals. Should be at least as smart as scoper."
          value={profile.preferred_models?.reviewer ?? ''}
          onChange={(v) => update({ preferred_models: { ...profile.preferred_models, reviewer: v } })}
        />
        <ModelInput
          label="orchestrator"
          help="Coordinates the loop. Tiny model is fine — it's mostly routing."
          value={profile.preferred_models?.orchestrator ?? ''}
          onChange={(v) => update({ preferred_models: { ...profile.preferred_models, orchestrator: v } })}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button type="button" className="pc-button primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {profile.updated_at && (
            <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
              Last updated <time dateTime={profile.updated_at}>{new Date(profile.updated_at).toLocaleString()}</time>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelInput({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="pc-form-row">
      <label htmlFor={`model-${label}`}>{label}</label>
      <input
        id={`model-${label}`}
        type="text"
        className="pc-input"
        placeholder="claude-sonnet-4-6"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="help">{help}</span>
    </div>
  );
}
