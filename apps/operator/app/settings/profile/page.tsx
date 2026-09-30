'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';
import { useLexicon } from '@/lib/useLexicon';

/**
 * The `preferred_models` block (scoper/worker/validator/reviewer/orchestrator)
 * was removed in the settings-audit 2026-07-09: nothing in the repo ever READ
 * it — the only occurrences were this form, the POST allowlist, and the type
 * decl. Per-role model selection lives on /settings/agent (models / roleModels
 * → AGENT_ROLE_BACKENDS), and 'orchestrator' is itself a retired role.
 */
interface Profile {
  email?: string;
  display_name?: string;
  default_project_dir?: string;
  theme?: 'dark' | 'light' | 'auto';
  updated_at?: string;
}

const ProfileSchema = z.object({
  email: z.string().optional().default(''),
  display_name: z.string().optional().default(''),
  default_project_dir: z.string().optional().default(''),
});
type ProfileFormData = z.infer<typeof ProfileSchema>;

export default function ProfilePage() {
  const t = useLexicon();
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { register, submit, reset, errors, isSubmitting } = useFormWith(ProfileSchema, {
    defaultValues: {
      email: '', display_name: '', default_project_dir: '',
    },
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/profile')
      .then((r) => r.json())
      .then((d: Profile) => {
        if (cancelled) return;
        reset({
          email: d.email ?? '',
          display_name: d.display_name ?? '',
          default_project_dir: d.default_project_dir ?? '',
        });
        setUpdatedAt(d.updated_at ?? null);
      })
      .catch((e) => { if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reset]);

  const onSubmit = async (data: ProfileFormData) => {
    try {
      const body: Profile = {
        email: data.email || undefined,
        display_name: data.display_name || undefined,
        default_project_dir: data.default_project_dir || undefined,
      };
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: Profile = await r.json();
      setUpdatedAt(d.updated_at ?? null);
      toast.success('Profile saved');
    } catch (e: any) {
      toast.error(`save failed: ${e?.message ?? e}`);
    }
  };

  if (loading) {
    return (
      <div>
        <h1>Profile</h1>
        <p className="pc-settings-loading">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Profile</h1>
      <p className="pc-settings-intro">
        Your identity (email + display name) and where new projects are created.
        Per-role model selection lives in <strong>Settings → AI backend</strong>.
      </p>

      <form onSubmit={submit(onSubmit)} className="pc-card">
        <FormField label="Email (optional)" error={errors.email?.message} description="Used to identify you in commit messages and agent attribution.">
          <input type="email" className="pc-input" placeholder="you@example.com" {...register('email')} />
        </FormField>

        <FormField label="Display name" error={errors.display_name?.message} description={`Shown next to your ${t('pot', { lower: true })} runs and proposals.`}>
          <input type="text" className="pc-input" placeholder="Your name" {...register('display_name')} />
        </FormField>

        <FormField label="Default project directory" error={errors.default_project_dir?.message} description={
          <>Where <code>papercusp init &lt;slug&gt;</code> creates new project directories.</>
        }>
          <input type="text" className="pc-input" placeholder="~/papercusp-projects" {...register('default_project_dir')} />
        </FormField>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <SubmitButton pending={isSubmitting}>Save</SubmitButton>
          {updatedAt && (
            <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
              Last updated <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleString()}</time>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
