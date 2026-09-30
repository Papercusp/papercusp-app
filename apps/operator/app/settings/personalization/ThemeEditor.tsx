'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import {
  isSafeCssValue,
  saveCustomTheme,
  slugifyThemeId,
  type CustomTheme,
  type ThemeToken,
} from '@/lib/theme';

/** Curated, user-facing editable tokens (grouped). The remaining semantic tokens
 * (bg-2/3/4 tiers, warn-bg/border, frost, card-shadow) inherit :root — themes
 * stay partial and simple. */
const GROUPS: Array<{ label: string; tokens: ThemeToken[] }> = [
  { label: 'Surfaces', tokens: ['bg', 'bg-1', 'bg-popover'] },
  { label: 'Text', tokens: ['fg', 'fg-dim', 'fg-mute'] },
  { label: 'Borders', tokens: ['border', 'border-strong'] },
  { label: 'Accent', tokens: ['accent', 'accent-strong', 'accent-cool', 'accent-ink'] },
  { label: 'Status', tokens: ['good', 'warn', 'bad'] },
];
const EDITABLE: ThemeToken[] = GROUPS.flatMap((g) => g.tokens);

const TOKEN_LABELS: Partial<Record<ThemeToken, string>> = {
  bg: 'Background',
  'bg-1': 'Base surface',
  'bg-popover': 'Popover surface',
  fg: 'Text',
  'fg-dim': 'Dimmed text',
  'fg-mute': 'Muted text',
  border: 'Border',
  'border-strong': 'Strong border',
  accent: 'Accent',
  'accent-strong': 'Accent (strong)',
  'accent-cool': 'Accent (cool)',
  'accent-ink': 'Accent ink',
  good: 'Good',
  warn: 'Warn',
  bad: 'Bad',
};

/** Read a theme's resolved token values by mounting a hidden, theme-scoped node.
 * Works for any built-in or `custom:<id>` seed (the custom <style> is injected,
 * and frost/black are explicitly scopable), falling back to :root for unset
 * tokens — so the editor always seeds with concrete values. */
function readThemeTokens(seedId: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof document === 'undefined') return out;
  const el = document.createElement('div');
  el.setAttribute('data-theme', seedId);
  el.style.display = 'none';
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  for (const t of EDITABLE) out[t] = cs.getPropertyValue(`--${t}`).trim();
  el.remove();
  return out;
}

/** Best-effort #rrggbb for the native color input (text input stays authoritative
 * so rgba()/named values are still editable). */
export function toHex(value: string): string {
  const s = (value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('').toLowerCase();
  const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) {
    const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return '#' + h(+m[1]) + h(+m[2]) + h(+m[3]);
  }
  return '#888888';
}

export interface ThemeEditorProps {
  /** Theme to seed initial values from (active theme for "new", or the custom id when editing). */
  seedThemeId: string;
  /** When editing an existing custom theme, its current definition (prefills name + id). */
  existing?: CustomTheme | null;
  /** Installed themes are immutable packages. Supplying one here seeds an
   * independent locally-authored copy instead of editing package bytes. */
  copyOf?: CustomTheme | null;
  onSaved: (theme: CustomTheme) => void;
  onCancel: () => void;
}

export default function ThemeEditor({ seedThemeId, existing, copyOf, onSaved, onCancel }: ThemeEditorProps) {
  const [name, setName] = useState(existing?.label ?? (copyOf ? `${copyOf.label} copy` : ''));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const seeded = readThemeTokens(seedThemeId);
    if (existing?.tokens) Object.assign(seeded, existing.tokens);
    if (copyOf?.tokens) Object.assign(seeded, copyOf.tokens);
    setDraft(seeded);
  }, [seedThemeId, existing, copyOf]);

  const previewVars = useMemo(
    () => Object.fromEntries(EDITABLE.map((t) => [`--${t}`, draft[t] ?? ''])) as CSSProperties,
    [draft],
  );

  const setToken = (token: ThemeToken, value: string) =>
    setDraft((d) => ({ ...d, [token]: value }));

  const onSave = async () => {
    const label = name.trim();
    if (!label) {
      toast.error('Give your theme a name');
      return;
    }
    const tokens: Partial<Record<ThemeToken, string>> = {};
    for (const t of EDITABLE) {
      const v = (draft[t] ?? '').trim();
      if (!v) continue;
      if (!isSafeCssValue(v)) {
        toast.error(`"${TOKEN_LABELS[t] ?? t}" has an invalid CSS color value`);
        return;
      }
      tokens[t] = v;
    }
    if (Object.keys(tokens).length === 0) {
      toast.error('Set at least one color');
      return;
    }
    setSaving(true);
    try {
      const saved = await saveCustomTheme({ id: existing?.id ?? slugifyThemeId(label), label, tokens });
      toast.success(`Saved theme "${saved.label}"`);
      onSaved(saved);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        marginTop: 14,
        padding: 14,
        borderRadius: 10,
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        display: 'flex',
        gap: 18,
        flexWrap: 'wrap',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: '1 1 360px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--fg-dim)' }}>
          Theme name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My theme"
            maxLength={60}
            style={{
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg-1)',
              color: 'var(--fg)',
              fontSize: 14,
            }}
          />
        </label>

        {GROUPS.map((group) => (
          <fieldset key={group.label} style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-mute)', marginBottom: 6 }}>
              {group.label}
            </legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {group.tokens.map((token) => (
                <div key={token} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="color"
                    aria-label={`${TOKEN_LABELS[token] ?? token} color picker`}
                    value={toHex(draft[token] ?? '')}
                    onChange={(e) => setToken(token, e.target.value)}
                    style={{ width: 28, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }}
                  />
                  <span style={{ width: 110, fontSize: 12, color: 'var(--fg-dim)' }}>{TOKEN_LABELS[token] ?? token}</span>
                  <input
                    value={draft[token] ?? ''}
                    onChange={(e) => setToken(token, e.target.value)}
                    aria-label={TOKEN_LABELS[token] ?? token}
                    spellCheck={false}
                    style={{
                      flex: 1,
                      minWidth: 90,
                      padding: '4px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-1)',
                      color: 'var(--fg)',
                      fontSize: 12,
                      fontFamily: 'var(--font-mono, monospace)',
                    }}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              fontWeight: 600,
              fontSize: 13,
              cursor: saving ? 'default' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : existing ? 'Save changes' : copyOf ? 'Save local copy' : 'Save theme'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--fg-dim)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>

      {/* Live preview — driven by the in-progress draft via inline CSS vars. */}
      <div style={{ flex: '0 0 220px' }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-mute)', marginBottom: 6 }}>
          Preview
        </div>
        <div
          style={{
            ...previewVars,
            background: 'var(--bg)',
            border: '1px solid var(--border-strong)',
            borderRadius: 10,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <strong style={{ color: 'var(--fg)', fontSize: 14 }}>Aa Title</strong>
          <span style={{ color: 'var(--fg-mute)', fontSize: 12 }}>Muted supporting text</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: 'var(--accent)', color: 'var(--accent-ink)' }}>
              Accent
            </span>
            <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--fg-dim)' }}>
              Outline
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--good)' }} />
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--warn)' }} />
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--bad)' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
