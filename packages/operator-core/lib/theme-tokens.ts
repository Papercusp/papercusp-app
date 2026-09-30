/**
 * Theme token contract — shared between the client theme lib (`lib/theme.ts`,
 * `'use client'`) and the server persistence/endpoint (`lib/custom-themes.ts`,
 * `routes/themes`). Kept free of React/DOM/`'use client'` so it imports cleanly
 * on the server.
 *
 * THE CONTRACT: a theme may set ONLY the semantic tokens in {@link THEME_TOKENS}
 * — never brand primitives (`--sky-*`) or raw literals. Enforced here (custom
 * themes) and by `design-tokens/tokens.test.ts` (built-ins).
 */

/** The only CSS variables a theme may set. Mirrors the color/overlay tokens in
 * `app/_semantic.css` (generated from `design-tokens/desktop.semantic.tokens.json`). */
export const THEME_TOKENS = [
  'bg-deepest', 'bg-deeper', 'bg-deep', 'bg', 'bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-popover', 'bg-raised', 'bg-raised-high',
  'fg', 'fg-dim', 'fg-mute',
  'border', 'border-strong',
  'accent', 'accent-strong', 'accent-cool', 'accent-soft', 'accent-deep', 'accent-deeper', 'accent-ink',
  'good', 'warn', 'bad', 'good-bg', 'warn-bg', 'bad-bg', 'warn-border',
  'frost', 'card-shadow',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

const THEME_TOKEN_SET: ReadonlySet<string> = new Set(THEME_TOKENS);
export function isThemeToken(value: unknown): value is ThemeToken {
  return typeof value === 'string' && THEME_TOKEN_SET.has(value);
}

export const BUILTIN_THEME_IDS = ['frost', 'black', 'honeycomb', 'portal-light', 'portal-dark'] as const;
export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number];

export function isBuiltinThemeId(value: unknown): value is BuiltinThemeId {
  return typeof value === 'string' && (BUILTIN_THEME_IDS as readonly string[]).includes(value);
}

export type ThemeColorScheme = 'light' | 'dark';

/** Frost is the `:root` default — the base semantic layer in `_semantic.css`. */
export const DEFAULT_THEME_ID: BuiltinThemeId = 'frost';

export interface ThemeMeta {
  id: string;
  label: string;
  builtin: boolean;
}

export const BUILTIN_THEMES: ThemeMeta[] = [
  { id: 'frost', label: 'Blue frost', builtin: true },
  { id: 'black', label: 'Black', builtin: true },
  { id: 'honeycomb', label: 'Honeycomb', builtin: true },
  { id: 'portal-light', label: 'Portal light', builtin: true },
  { id: 'portal-dark', label: 'Portal dark', builtin: true },
];

export const CUSTOM_PREFIX = 'custom:';

/** A user-authored theme. `tokens` is a partial map — only the semantic tokens
 * that differ from the base; the rest inherit `:root`. */
export interface CustomTheme {
  /** Stable slug, unique among custom themes (NOT prefixed; the active-theme id
   *  is `custom:<id>`). */
  id: string;
  label: string;
  tokens: Partial<Record<ThemeToken, string>>;
  /** Installed packages may inherit one of the generated built-in semantic
   * layers before applying their own overrides. Local themes omit this and
   * retain the historical frost-base behaviour. */
  baseTheme?: BuiltinThemeId;
  colorScheme?: ThemeColorScheme;
  /** Present only for a Cupboard-installed package. The local editor's
   * validator intentionally drops these fields so package provenance cannot be
   * forged through the ordinary custom-theme PUT route. */
  installed?: boolean;
  packageRef?: string;
  /** Cupboard discriminator inside the source repository. Present only for an
   * installed package, so storefronts can identify the installed copy without
   * trusting a display label or conflating two publishers with the same id. */
  listingRef?: string;
  version?: string;
  source?: string;
  description?: string;
}

export function isCustomThemeId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(CUSTOM_PREFIX) && value.length > CUSTOM_PREFIX.length;
}

/** The `<id>` part of a `custom:<id>` active-theme id (or null if not custom). */
export function customThemeSlug(activeId: string): string | null {
  return isCustomThemeId(activeId) ? activeId.slice(CUSTOM_PREFIX.length) : null;
}

/** A theme id is valid if it's a known built-in or a `custom:<id>` id. */
export function isValidThemeId(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  if ((BUILTIN_THEME_IDS as readonly string[]).includes(value)) return true;
  return isCustomThemeId(value);
}

/** Kebab-case slug from a label; bounded length; never empty. */
export function slugifyThemeId(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'theme';
}

/**
 * Validate a single CSS color value before it's injected into a `<style>` block.
 * Custom theme values flow into `[data-theme="custom:id"] { --token: <value> }`,
 * so a value containing `;{}<>` or `url(...)` could break out / inject. Allow the
 * shape of common color values only: hex, rgb/rgba/hsl/hsla/oklch/color() funcs,
 * named colors, plus the gradient/var forms frost/card-shadow legitimately use.
 */
const CSS_VALUE_DISALLOWED = /[;{}<>\\]|url\(|@import|expression|javascript:/i;
const CSS_VALUE_ALLOWED = /^[a-z0-9#%.,()/\s_+*-]+$/i;
export function isSafeCssValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 200) return false;
  if (CSS_VALUE_DISALLOWED.test(v)) return false;
  return CSS_VALUE_ALLOWED.test(v);
}

export class CustomThemeValidationError extends Error {}

/**
 * Validate + normalize untrusted input (request body or a hand-edited file row)
 * into a {@link CustomTheme}. Enforces the THEME CONTRACT (token keys ⊆
 * THEME_TOKENS) and CSS-value safety. Throws {@link CustomThemeValidationError}.
 */
export function validateCustomTheme(input: unknown): CustomTheme {
  if (!input || typeof input !== 'object') {
    throw new CustomThemeValidationError('theme must be an object');
  }
  const raw = input as Record<string, unknown>;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label || label.length > 60) {
    throw new CustomThemeValidationError('label must be a non-empty string ≤ 60 chars');
  }
  const id = typeof raw.id === 'string' && raw.id ? slugifyThemeId(raw.id) : slugifyThemeId(label);
  if (!raw.tokens || typeof raw.tokens !== 'object') {
    throw new CustomThemeValidationError('tokens must be an object');
  }
  const tokens: Partial<Record<ThemeToken, string>> = {};
  for (const [key, value] of Object.entries(raw.tokens as Record<string, unknown>)) {
    if (!isThemeToken(key)) {
      throw new CustomThemeValidationError(
        `"${key}" is not a themeable token — a theme may only set the semantic layer (${THEME_TOKENS.join(', ')})`,
      );
    }
    if (!isSafeCssValue(value)) {
      throw new CustomThemeValidationError(`value for "${key}" is not a safe CSS value`);
    }
    tokens[key] = (value as string).trim();
  }
  if (Object.keys(tokens).length === 0) {
    throw new CustomThemeValidationError('a custom theme must set at least one token');
  }
  return { id, label, tokens };
}

/** Render a custom theme to a CSS rule block. Used by the runtime style injector
 * (client) and available to the server if a generated artifact is ever wanted. */
export function customThemeCss(theme: CustomTheme): string {
  const decls = (Object.entries(theme.tokens) as [ThemeToken, string][])
    .map(([token, value]) => `  --${token}: ${value};`)
    .join('\n');
  // A custom theme also carries `data-theme-base`, whose generated semantic
  // block supplies tokens the package omitted. Give the explicit custom layer
  // higher specificity than that base alias so it wins even when its cached
  // pre-paint <style> appears before the bundled base CSS after a reload.
  return `:root[data-theme="${CUSTOM_PREFIX}${theme.id}"] {\n${decls}\n}`;
}
