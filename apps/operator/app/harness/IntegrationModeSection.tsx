'use client';

/**
 * P-017 (pot-review-integration-mode-2026-10-05, D-007): the pot-settings form of
 * the ONE question "Where should the agents' work go?" — the same wording pot
 * creation asks (integrationModeQuestion, served by GET
 * /api/harness/:slug/integration-mode).
 *
 * Guided switching: choosing the other answer does not apply it. A confirm step
 * explains, in plain language, what changes; only "Switch" sends the PUT. A
 * refusal (e.g. no test suite) is shown as the server's own message and the
 * current answer stays selected. Users never see low-level git settings.
 *
 * Saves independently of the config.json Save bar (like HarnessPluginsSection).
 * Hidden for projects that are not pots (409 not_a_pot / 404).
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { RadioGroup } from './RadioGroup';
import type {
  IntegrationModeQuestion,
} from '@papercusp/operator-core/lib/harness/git-sync/integration-mode-question';

type Mode = 'direct' | 'review';

interface IntegrationModeState {
  question: IntegrationModeQuestion;
  current: Mode | null;
  workingCopyUrl: string | null;
}

/** One `potIntegration.settings` row; `isPot:false` hides the section. */
interface SettingsRow {
  slug: string;
  isPot: boolean;
  question?: IntegrationModeQuestion;
  current?: Mode | null;
  workingCopyUrl?: string | null;
}

/** Plain-language explanation of what switching to `target` changes. */
export function switchExplanation(target: Mode, repoLabel: string, workingCopyUrl: string | null): string {
  if (target === 'review') {
    const where = workingCopyUrl ? `the working copy (${workingCopyUrl})` : 'a working copy of the repository, created for this pot';
    return (
      `Agents keep working together as they do now, but their work goes to ${where} instead of ${repoLabel}. ` +
      `${repoLabel} receives their combined work only through a PR, opened after the pot's tests pass, that you (or a reviewer) approve. ` +
      `The switch takes effect from the next sync; work already in ${repoLabel} stays there.`
    );
  }
  // P-019: leaving a working copy is refused while its PR to the main repo is
  // open (guardLeavingWorkingCopy) — say so BEFORE the user presses Switch.
  return (
    `From now on, agents' work goes straight into ${repoLabel}, as before. ` +
    `If a PR from the working copy to ${repoLabel} is still open, it must be merged or closed first; until then the switch is refused and nothing changes. ` +
    'The working copy is kept; nothing is deleted.'
  );
}

/** "owner/repo" from the question's option label ("Straight into owner/repo"). */
function repoLabelFrom(question: IntegrationModeQuestion): string {
  const direct = question.options.find((o) => o.value === 'direct');
  return direct ? direct.label.replace(/^Straight into /, '') : 'the main repository';
}

export default function IntegrationModeSection({ slug }: { slug: string }) {
  // EI-25188362216785598: a LIVE read (potIntegration.settings) — the PUT below and any
  // pot_settings write push a fresh row, so a switch made elsewhere shows here too.
  const { data: rows, loading, error: readError, invalidate } = useSyncQuery<SettingsRow>({
    queryName: 'potIntegration.settings',
    args: { slug },
  });
  const row = rows[0];
  const hidden = row?.isPot === false;
  /** The answer just saved, shown until the re-read row arrives (transient → useState). */
  const [optimistic, setOptimistic] = useState<Pick<IntegrationModeState, 'current' | 'workingCopyUrl'> | null>(null);
  useEffect(() => {
    setOptimistic(null);
  }, [row?.current, row?.workingCopyUrl]);
  const state: IntegrationModeState | null = row?.isPot && row.question
    ? {
        question: row.question,
        current: optimistic?.current ?? row.current ?? null,
        workingCopyUrl: optimistic ? optimistic.workingCopyUrl : (row.workingCopyUrl ?? null),
      }
    : null;
  const loadError = !loading && !row ? (readError?.message ?? 'Could not read this setting.') : null;
  /** The answer the user picked but has not confirmed yet (mid-edit draft). */
  const [pending, setPending] = useState<Mode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPending(null);
    setError(null);
  }, [slug]);

  const confirmSwitch = useCallback(async () => {
    if (!pending || !state) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/integration-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: pending }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        return;
      }
      // Show the saved answer now; the pushed row (and this re-read) replaces it.
      setOptimistic({
        current: (body.mode as Mode | null) ?? pending,
        workingCopyUrl: body.fork?.url ?? state.workingCopyUrl,
      });
      invalidate();
      setPending(null);
      toast.success('Saved where the agents’ work goes');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [pending, slug, state, invalidate]);

  if (hidden) return null;

  const current: Mode = state?.current ?? state?.question.defaultValue ?? 'direct';
  const selected: Mode = pending ?? current;

  return (
    <section
      data-testid="integration-mode-section"
      style={{ marginBottom: 24, paddingTop: 8, borderTop: '1px solid var(--border)' }}
    >
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>
        {state?.question.prompt ?? "Where should the agents' work go?"}
      </h2>
      {loadError && (
        <p data-testid="integration-mode-load-error" style={{ margin: 0, color: 'var(--bad)', fontSize: 12 }}>
          Could not load this setting: {loadError}
        </p>
      )}
      {!state && !loadError && (
        <p style={{ margin: 0, color: 'var(--fg-mute)', fontSize: 11.5 }}>Loading…</p>
      )}
      {state && (
        <fieldset data-testid="integration-mode-settings" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {state.question.prompt}
          </legend>
          <RadioGroup
            label={state.question.prompt}
            value={selected}
            options={state.question.options.map(opt => ({ ...opt, disabled: !opt.available || saving }))}
            onChange={next => {
              setError(null);
              setPending(next === current ? null : next);
            }}
            optionStyle={opt => ({
                display: 'flex',
                width: '100%',
                textAlign: 'left',
                alignItems: 'flex-start',
                gap: 8,
                padding: '6px 8px',
                border: 'none',
                background: 'transparent',
                color: 'var(--fg)',
                borderRadius: 6,
                cursor: opt.disabled ? 'not-allowed' : 'pointer',
            })}
          >
            {(opt, checked) => <>
              <span aria-hidden="true">{checked ? '◉' : '○'}</span>
              <span data-testid={`integration-mode-option-${opt.value}`}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: selected === opt.value ? 600 : 500 }}>
                  {opt.label}
                  {opt.value === current && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-dim)', fontWeight: 400 }}>(current)</span>
                  )}
                </span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fg-mute)', lineHeight: 1.45 }}>
                  {opt.available ? opt.description : opt.unavailableReason}
                </span>
              </span>
            </>}
          </RadioGroup>
          {current === 'review' && state.workingCopyUrl && !pending && (
            <p data-testid="integration-mode-working-copy" style={{ margin: '4px 8px 0', fontSize: 11.5, color: 'var(--fg-dim)' }}>
              Working copy: <a href={state.workingCopyUrl} target="_blank" rel="noreferrer">{state.workingCopyUrl}</a>
            </p>
          )}
          {pending && (
            <div
              data-testid="integration-mode-confirm-panel"
              role="group"
              aria-label="Confirm the change"
              style={{ margin: '8px 0 0', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}
            >
              <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.5 }}>
                {switchExplanation(pending, repoLabelFrom(state.question), state.workingCopyUrl)}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  data-testid="integration-mode-confirm"
                  disabled={saving}
                  onClick={() => void confirmSwitch()}
                  style={{ fontSize: 12, padding: '3px 12px' }}
                >
                  {saving ? 'Switching…' : 'Switch'}
                </button>
                <button
                  type="button"
                  data-testid="integration-mode-cancel"
                  disabled={saving}
                  onClick={() => {
                    setPending(null);
                    setError(null);
                  }}
                  style={{ fontSize: 12, padding: '3px 12px' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && (
            <p data-testid="integration-mode-error" role="alert" style={{ margin: '8px 0 0', color: 'var(--bad)', fontSize: 12 }}>
              {error}
            </p>
          )}
        </fieldset>
      )}
    </section>
  );
}
