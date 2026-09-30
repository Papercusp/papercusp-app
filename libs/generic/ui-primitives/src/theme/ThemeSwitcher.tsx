'use client';

import { type CSSProperties } from 'react';
import { Contrast, MonitorCog, Moon, Palette, Sun } from 'lucide-react';
import { useTheme } from './useTheme';

export interface ThemeOption {
  id: string;
  label: string;
}

/** Structural on purpose: app-local icon packages may carry a different React type identity. */
export type ThemeIcon = (props: { size?: number; 'aria-hidden'?: boolean }) => any;

export interface ThemeSwitcherProps {
  /** Theme manifest — pass `THEMES` from `@papercusp/design-tokens/themes`. */
  themes: readonly ThemeOption[];
  /** Optional override of the per-theme icon (keyed by theme id). */
  icons?: Record<string, ThemeIcon>;
  className?: string;
  /** Controlled value for server-persisted/account-owned preferences. */
  value?: string;
  /** Controlled change handler; omit with value for local runtime persistence. */
  onChange?: (id: string) => void;
}

// Sensible defaults; consumers can override via the `icons` prop.
const DEFAULT_ICONS: Record<string, ThemeIcon> = {
  frost: Moon,
  black: Contrast,
  light: Sun,
  system: MonitorCog,
  dark: Moon,
};

const wrapStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: 'var(--bg-2, var(--chip, transparent))',
  border: '1px solid var(--border, var(--line, currentColor))',
};

function btnStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    color: active ? 'var(--accent-ink, var(--panel-raised, currentColor))' : 'var(--fg-dim, var(--muted, currentColor))',
    background: active ? 'var(--accent, currentColor)' : 'transparent',
    transition: 'background 120ms ease, color 120ms ease',
  };
}

/**
 * Headless theme switcher — a segmented control over the supplied themes.
 * Styling uses the host's design-token CSS vars (with fallbacks) so it stays
 * theme-reactive without hardcoding brand values; override via `className`.
 */
export function ThemeSwitcher(props: ThemeSwitcherProps) {
  if (props.value !== undefined) {
    return <ThemeSwitcherControl {...props} theme={props.value} setTheme={props.onChange ?? (() => {})} />;
  }
  return <LocalThemeSwitcher {...props} />;
}

function LocalThemeSwitcher(props: ThemeSwitcherProps) {
  const local = useTheme();
  return <ThemeSwitcherControl {...props} theme={local.theme} setTheme={props.onChange ?? local.setTheme} />;
}

function ThemeSwitcherControl({
  themes,
  icons = DEFAULT_ICONS,
  className,
  theme,
  setTheme,
}: ThemeSwitcherProps & { theme: string; setTheme: (id: string) => void }) {
  return (
    <div role="group" aria-label="Theme" className={className} style={wrapStyle}>
      {themes.map((t) => {
        const Icon = icons[t.id] ?? Palette; // ?? guard — a missing key never crashes the subtree
        const active = theme === t.id;
        return (
          <button
            key={t.id}
            type="button"
            title={t.label}
            aria-label={t.label}
            aria-pressed={active}
            data-theme-option={t.id}
            onClick={() => setTheme(t.id)}
            style={btnStyle(active)}
          >
            <Icon size={15} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
