'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import { Select } from '../../harness/Select';
import {
  applyVisualEffectsMode,
  readVisualEffectsMode,
  subscribeVisualEffects,
  writeVisualEffectsMode,
  type VisualEffectsMode,
} from '@/lib/visual-effects';
import {
  CUSTOM_PREFIX,
  DEFAULT_THEME_ID,
  customThemeSlug,
  deleteCustomTheme,
  findCustomTheme,
  themeList,
  useActiveTheme,
  useThemeCatalog,
  writeActiveTheme,
  type CustomTheme,
} from '@/lib/theme';
import ThemeEditor from './ThemeEditor';
import SavedPromptsSection from '../../harness/SavedPromptsSection';
import { OperatorSettingsSlot } from '@papercusp/operator-ui/settings-slots';

const VISUAL_EFFECTS_OPTIONS: Array<{ value: VisualEffectsMode; label: string; description: string }> = [
  {
    value: 'system',
    label: 'System default',
    description: 'Use the OS reduced-motion preference. Full cinematic HUD effects stay on unless this device asks for less motion.',
  },
  {
    value: 'full',
    label: 'Full cinematic',
    description: 'Jump gates, scans, HUD sweeps, glow loops, and the full Papercusp wow effect.',
  },
  {
    value: 'minimal',
    label: 'Minimal / calm',
    description: 'Static chrome, no jump gate, no decorative scan loops, and reduced expensive motion.',
  },
];

const THEME_DESCRIPTIONS: Record<string, string> = {
  frost: 'The default — a slate-navy base with sky-cyan accents and glassy frost surfaces.',
  black: 'Pure-black surfaces with neutral greys and a white accent. High contrast, minimal color.',
  honeycomb: 'The Swarm palette — ominous charcoal surfaces with honey-amber signal color.',
  'portal-light': 'The hosted portal light palette — warm paper, dark ink, and green interactive accents.',
  'portal-dark': 'The hosted portal dark palette — charcoal surfaces, warm text, and green interactive accents.',
};

/** Live mini-preview of a theme, scoped via `data-theme={id}` so it renders that
 * theme's real tokens regardless of the page's active theme. */
function ThemePreview({ themeId }: { themeId: string }) {
  return (
    <div
      data-theme={themeId}
      aria-hidden
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 62,
      }}
    >
      <div style={{ height: 8, width: '55%', borderRadius: 3, background: 'var(--fg)' }} />
      <div style={{ height: 6, width: '82%', borderRadius: 3, background: 'var(--fg-mute)' }} />
      <div
        style={{
          alignSelf: 'flex-start',
          marginTop: 2,
          fontSize: 10,
          fontWeight: 600,
          lineHeight: 1.4,
          padding: '2px 8px',
          borderRadius: 999,
          background: 'var(--accent)',
          color: 'var(--accent-ink)',
        }}
      >
        Accent
      </div>
    </div>
  );
}

export default function PersonalizationSettingsPage() {
  const [visualEffectsMode, setVisualEffectsMode] = useState<VisualEffectsMode>('system');
  const activeTheme = useActiveTheme();
  const { themes: customThemes, invalidate: invalidateThemes } = useThemeCatalog();
  // Editor open-state in the URL (repo nuqs rule): null = closed, 'new' = create
  // (seed from active), 'custom:<id>' = edit that theme.
  const [themeEdit, setThemeEdit] = useQueryState('themeEdit', parseAsString);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const syncVisualEffects = () => {
      const mode = readVisualEffectsMode();
      setVisualEffectsMode(mode);
      applyVisualEffectsMode(mode);
    };
    syncVisualEffects();
    return subscribeVisualEffects(() => setVisualEffectsMode(readVisualEffectsMode()));
  }, []);

  const setVisualEffectsPreference = useCallback((value: string) => {
    const mode = (VISUAL_EFFECTS_OPTIONS.some((opt) => opt.value === value) ? value : 'system') as VisualEffectsMode;
    setVisualEffectsMode(mode);
    writeVisualEffectsMode(mode);
    toast.success('Visual effects preference saved');
  }, []);

  const themes = themeList(customThemes);
  const selectedVisualEffects = VISUAL_EFFECTS_OPTIONS.find((opt) => opt.value === visualEffectsMode) ?? VISUAL_EFFECTS_OPTIONS[0];

  const selectTheme = useCallback(
    (id: string) => {
      writeActiveTheme(id);
      const label = themes.find((t) => t.id === id)?.label ?? id;
      toast.success(`Theme set to ${label}`);
    },
    [themes],
  );

  const onDelete = useCallback(
    async (id: string) => {
      const slug = customThemeSlug(id);
      if (!slug) return;
      try {
        await deleteCustomTheme(slug);
        if (activeTheme === id) writeActiveTheme(DEFAULT_THEME_ID);
        if (themeEdit === id) void setThemeEdit(null);
        toast.success('Theme deleted');
        invalidateThemes();
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setConfirmDeleteId(null);
      }
    },
    [activeTheme, themeEdit, setThemeEdit, invalidateThemes],
  );

  const onSaved = useCallback(
    async (theme: CustomTheme) => {
      invalidateThemes();
      writeActiveTheme(`${CUSTOM_PREFIX}${theme.id}`);
      void setThemeEdit(null);
    },
    [invalidateThemes, setThemeEdit],
  );

  const copyThemeId = themeEdit?.startsWith('copy:') ? themeEdit.slice('copy:'.length) : null;
  const editorSeedId = themeEdit === 'new' ? activeTheme : copyThemeId ?? themeEdit ?? activeTheme;
  const editorExisting = themeEdit && themeEdit !== 'new' && !copyThemeId
    ? findCustomTheme(themeEdit, customThemes)
    : null;
  const editorCopyOf = copyThemeId ? findCustomTheme(copyThemeId, customThemes) : null;
  const descriptionText =
    THEME_DESCRIPTIONS[activeTheme] ??
    (findCustomTheme(activeTheme, customThemes) ? 'Your custom theme.' : 'Custom theme.');

  return (
    <div>
      <h1>Personalization</h1>
      <p className="pc-settings-intro">
        Tune browser-local presentation preferences for this Papercup interface.
      </p>

      {/* A host may own an additional presentation preference while this page
          still owns where that preference belongs. The desktop supplies no
          slot; the web portal supplies its light/system/dark preference here
          instead of rendering a second Settings card above the whole page. */}
      <OperatorSettingsSlot name="personalization" />

      <section className="pc-settings-section">
        <h2>Theme</h2>
        <p className="pc-settings-hint" style={{ margin: '0 0 12px' }}>
          Recolors the entire interface on this device. A theme changes only the high-level color
          tokens — surfaces, text, borders, and accents. Custom themes are saved to a local file.
        </p>
        <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {themes.map((t) => {
            const selected = t.id === activeTheme;
            const definition = findCustomTheme(t.id, customThemes);
            const installed = definition?.installed === true;
            const cardStyle: CSSProperties = {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              width: 172,
              padding: 10,
              textAlign: 'left',
              cursor: 'pointer',
              background: 'var(--bg-2)',
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              boxShadow: selected ? '0 0 0 1px var(--accent)' : 'none',
              borderRadius: 10,
            };
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t.label}
                onClick={() => selectTheme(t.id)}
                style={cardStyle}
              >
                <ThemePreview themeId={t.id} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.label}
                  </strong>
                  {selected && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>● Active</span>}
                </div>
                {!t.builtin && (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void setThemeEdit(installed ? `copy:${t.id}` : t.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          void setThemeEdit(installed ? `copy:${t.id}` : t.id);
                        }
                      }}
                      style={{ fontSize: 11, color: 'var(--fg-mute)', cursor: 'pointer' }}
                    >
                      {installed ? 'Edit as copy' : 'Edit'}
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirmDeleteId === t.id) void onDelete(t.id);
                        else setConfirmDeleteId(t.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (confirmDeleteId === t.id) void onDelete(t.id);
                          else setConfirmDeleteId(t.id);
                        }
                      }}
                      style={{ fontSize: 11, color: confirmDeleteId === t.id ? 'var(--bad)' : 'var(--fg-mute)', cursor: 'pointer', fontWeight: confirmDeleteId === t.id ? 600 : 400 }}
                    >
                      {confirmDeleteId === t.id ? 'Confirm?' : installed ? 'Remove' : 'Delete'}
                    </span>
                  </div>
                )}
                {installed && definition && (
                  <div
                    data-testid="installed-theme-provenance"
                    style={{ fontSize: 10.5, lineHeight: 1.35, color: 'var(--fg-mute)' }}
                  >
                    Installed{definition.version ? ` · v${definition.version}` : ''}
                    {definition.source ? <><br />{definition.source.replace(/^https?:\/\/github\.com\//, '')}</> : null}
                  </div>
                )}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setThemeEdit('new')}
            aria-label="Create a new theme"
            style={{
              width: 172,
              minHeight: 110,
              borderRadius: 10,
              border: '1px dashed var(--border-strong)',
              background: 'transparent',
              color: 'var(--fg-mute)',
              cursor: 'pointer',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> New theme
          </button>
        </div>

        <p className="pc-settings-hint" style={{ marginTop: 10, maxWidth: 560 }}>
          {descriptionText}
        </p>

        {themeEdit != null && (
          <ThemeEditor
            key={themeEdit}
            seedThemeId={editorSeedId}
            existing={editorExisting}
            copyOf={editorCopyOf}
            onSaved={onSaved}
            onCancel={() => void setThemeEdit(null)}
          />
        )}
      </section>

      <section className="pc-settings-section">
        <h2>Visual effects</h2>
        <p className="pc-settings-hint" style={{ margin: '0 0 12px' }}>
          Controls cinematic motion on this browser/device only. Use Minimal / calm for older hardware or a quieter UI.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Select
            value={visualEffectsMode}
            onChange={setVisualEffectsPreference}
            ariaLabel="Visual effects preference"
            options={VISUAL_EFFECTS_OPTIONS.map(({ value, label }) => ({ value, label }))}
            triggerStyle={{ minWidth: 180, justifyContent: 'space-between', padding: '7px 10px' }}
          />
          <div style={{ fontSize: 13, color: 'var(--fg-mute)', maxWidth: 560 }}>
            <strong style={{ display: 'block', color: 'var(--fg)', marginBottom: 2 }}>
              {selectedVisualEffects.label}
            </strong>
            {selectedVisualEffects.description}
          </div>
        </div>
      </section>

      <section className="pc-settings-section">
        <SavedPromptsSection scope={{ kind: 'workspace' }} />
      </section>
    </div>
  );
}
