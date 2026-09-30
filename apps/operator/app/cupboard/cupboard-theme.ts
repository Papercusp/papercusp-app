/**
 * Cupboard palette — the app's GLOBAL semantic design tokens (the sky/frost
 * system in `_semantic.css`), surfaced as the `COLORS/FONTS/RADIUS/SIZES`
 * shape the Cupboard files already consume.
 *
 * Why this exists: the Cupboard storefront used to import the *harness
 * dashboard's* theme (`../harness/theme`) — a hardcoded Linear-indigo palette
 * (`#0b0e14` bg, `#5e6ad2` accent, neutral-gray text). That made the Cupboard
 * read as a different product and, worse, frozen — it ignored `<ThemeSelector/>`.
 * Every value here is a CSS custom property resolved at render, so the Cupboard
 * now tracks the active theme and matches the rest of the app.
 *
 * Prefer `var(--*)` / `pc-*` classes directly in new markup; this module exists
 * to retheme the existing inline-styled surface without rewriting ~60 call sites.
 */

export const COLORS = {
  bg: 'var(--bg)',
  surface: 'var(--bg-popover)',
  surfaceRaised: 'var(--bg-raised)',
  surfaceHover: 'var(--bg-raised-high)',
  border: 'var(--border)',
  borderStrong: 'var(--border-strong)',
  borderSubtle: 'var(--border)',

  text: 'var(--fg)',
  textMuted: 'var(--fg-mute)',
  textDim: 'var(--fg-mute)',
  textFaint: 'var(--fg-mute)',

  accent: 'var(--accent)',
  accentHover: 'var(--accent-strong)',

  danger: 'var(--bad)',
  dangerBg: 'var(--bad-bg)',
  dangerText: 'var(--bad)',
  success: 'var(--good)',
  successBg: 'color-mix(in srgb, var(--good), transparent 88%)',
  successText: 'var(--good)',
} as const;

export const FONTS = {
  ui: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'var(--font-mono)',
} as const;

// Spacing scale (font-size rems) — neutral, not a theme concern; kept as-is.
export const SIZES = {
  xs: '0.7rem',
  sm: '0.75rem',
  base: '0.8rem',
  md: '0.85rem',
  lg: '0.95rem',
  xl: '1.1rem',
} as const;

// Corner radii — softened from the harness theme's tight 3/4/6 to the app's
// rounder language (pc-input 10, pc-button 12) so panels match the chrome.
export const RADIUS = {
  sm: 6,
  md: 8,
  lg: 12,
} as const;
