'use client';


/**
 * Navbar theme selector — a compact dropdown (mirrors WorkspaceSwitcher's
 * hand-rolled, portaled menu) that switches the active color theme instantly
 * and persists it the SAME way the personalization settings page does:
 * `writeActiveTheme()` → PG via /api/profile (source of truth) + a localStorage
 * write-through cache (see lib/theme.ts + lib/profile-pref.ts). Lists the
 * built-in themes plus any custom themes; "Manage themes…" opens the full
 * editor in settings.
 *
 * Open-state lives in the URL (`?themeSwitch=`) per the repo nuqs rule, so the
 * dropdown is agent-driveable and survives reloads.
 */

import { useRef } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { Tooltip } from '../harness/Tooltip';
import { Popover } from '../harness/Popover';
import RouteLink from './RouteLink';
import {
  themeList,
  useThemeCatalog,
  useActiveTheme,
  writeActiveTheme,
} from '@/lib/theme';

/** Tiny per-theme accent dot. Scopes `data-theme` so `var(--accent)` resolves
 *  to THAT theme's accent regardless of the page's active theme — the same
 *  trick the settings ThemePreview uses. */
function ThemeSwatch({ themeId }: { themeId: string }) {
  return (
    <span
      data-theme={themeId}
      aria-hidden
      style={{
        width: 12,
        height: 12,
        flex: '0 0 auto',
        borderRadius: 3,
        background: 'var(--accent)',
        border: '1px solid var(--border-strong)',
      }}
    />
  );
}

export default function ThemeSelector() {
  const [open, setOpen] = useQueryState('themeSwitch', parseAsBoolean.withDefault(false));
  const activeTheme = useActiveTheme();
  const { themes: customThemes } = useThemeCatalog();
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  const themes = themeList(customThemes);
  const activeLabel = themes.find((t) => t.id === activeTheme)?.label ?? 'Theme';

  const pick = (id: string) => {
    writeActiveTheme(id);
    setOpen(false);
  };

  return (
    <span ref={wrapRef} className="pc-theme-switcher" style={{ position: 'relative', fontSize: 13 }}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="end"
        sideOffset={4}
        zIndex={200}
        ariaLabel="Switch theme"
        contentClassName="pc-theme-menu pc-animate-in pc-animate-in--down pc-animate-in--fast"
        contentStyle={{
          minWidth: 200,
          background: 'var(--bg-popover)',
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: 4,
          boxShadow: '0 12px 32px color-mix(in oklab, black, transparent 40%), 0 0 0 1px color-mix(in oklab, var(--fg), transparent 96%)',
        }}
        trigger={
        <button
          type="button"
          className="pc-theme-trigger"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--fg-dim)',
            padding: '3px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            font: 'inherit',
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Switch theme"
        >
          <ThemeSwatch themeId={activeTheme} />
          <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeLabel}
          </span>
          <span className="pc-theme-trigger-caret" style={{ opacity: 0.6 }}>▾</span>
        </button>
        }
      >
        <div role="menu" aria-label="Theme">
          <div style={{ padding: '4px 8px', color: 'var(--fg-mute)', fontSize: 11, textTransform: 'uppercase' }}>
            Theme
          </div>
          {themes.map((t) => {
            const isCurrent = t.id === activeTheme;
            return (
              <Tooltip key={t.id} label={isCurrent ? 'current theme' : `switch to ${t.label}`}><button

                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                data-testid="theme-selector-option"
                data-theme-id={t.id}
                onClick={() => pick(t.id)}
                className="pc-theme-menu-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  background: isCurrent ? 'var(--accent)' : 'transparent',
                  border: 'none',
                  color: isCurrent ? 'var(--accent-ink)' : 'inherit',
                  cursor: 'pointer',
                  font: 'inherit',
                  padding: '5px 8px',
                  borderRadius: 3,
                }}

              >
                <ThemeSwatch themeId={t.id} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.label}
                </span>
                {isCurrent && <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>●</span>}
              </button></Tooltip>
            );
          })}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <RouteLink
            href="/settings/personalization"
            onClick={() => setOpen(false)}
            className="pc-theme-menu-manage"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              color: 'var(--fg-dim)',
              textDecoration: 'none',
              font: 'inherit',
              padding: '4px 8px',
              borderRadius: 3,
            }}
          >
            Manage themes…
          </RouteLink>
        </div>
      </Popover>
    </span>
  );
}
