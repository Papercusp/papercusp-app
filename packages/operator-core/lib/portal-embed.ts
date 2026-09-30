/**
 * Browser-safe contract shared by the hosted portal and the operator document
 * it embeds.  Keep this module free of React, filesystem, and server imports:
 * the portal uses it while building an iframe URL and the operator uses it in
 * both its pre-paint bootstrap and its React shell.
 */

export const PORTAL_EMBED_PARAM = 'portalEmbed' as const;
export const PORTAL_EMBED_THEME_PARAM = 'portalTheme' as const;
export const PORTAL_EMBED_ORIGIN_PARAM = 'portalOrigin' as const;
export const PORTAL_EMBED_MESSAGE = 'papercusp:portal-embed' as const;
export const PORTAL_EMBED_PROTOCOL_VERSION = 1 as const;

/**
 * Pane-only operator documents the portal frames as OUTER-SHELL SIDEBARS
 * (owner ask 2026-09-01: the Accounts steering rail and the Papercup chat are
 * sidebars of the cloud portal page, not of the embedded Papercusp app).
 * Each renders exactly one dock — no header, no tab strip, no other dock —
 * docked to the frame it lives in; the portal owns open/closed state and width.
 * Declared before PORTAL_EMBED_PATH_PREFIXES, which spreads it (a `const` is
 * not hoisted).
 */
export const PORTAL_PANES_PATH_PREFIX = '/portal-panes' as const;

/** Operator documents that may be framed by the hosted portal. */
export const PORTAL_EMBED_PATH_PREFIXES = ['/adv', '/tasks-roster', '/plans', '/inbox', PORTAL_PANES_PATH_PREFIX] as const;

export const PORTAL_PANE_PATHS = {
  /** The far-left steering rail: Accounts / Papercup / Pulse. */
  steering: `${PORTAL_PANES_PATH_PREFIX}/steering`,
  /** The Papercup chat dock with its Learning / Fleet / Peers faces. */
  chat: `${PORTAL_PANES_PATH_PREFIX}/chat`,
} as const;
export type PortalPaneId = keyof typeof PORTAL_PANE_PATHS;

export const PORTAL_EMBED_THEMES = ['light', 'dark', 'system'] as const;
export type PortalEmbedTheme = (typeof PORTAL_EMBED_THEMES)[number];
export type OperatorThemeId = 'portal-light' | 'portal-dark';

export interface PortalEmbedThemeMessage {
  type: typeof PORTAL_EMBED_MESSAGE;
  version: typeof PORTAL_EMBED_PROTOCOL_VERSION;
  theme: PortalEmbedTheme;
}

/** Parse the portal's deliberately small theme vocabulary. */
export function parsePortalEmbedTheme(value: unknown): PortalEmbedTheme | null {
  return typeof value === 'string' && (PORTAL_EMBED_THEMES as readonly string[]).includes(value)
    ? value as PortalEmbedTheme
    : null;
}

/** Query values are presence-like, but only explicit truthy spellings enable the mode. */
export function isPortalEmbedFlag(value: unknown): boolean {
  return value === '' || value === '1' || value === 'true' || value === 'yes';
}

/** True when a pathname + query describe an operator document hosted by the portal. */
export function isPortalEmbedLocation(pathname: string, search = ''): boolean {
  // Router adapters normally split pathname/search. Normalize the full-path
  // form too so a query-bearing location cannot accidentally retain chrome.
  const [path, inlineSearch = ''] = pathname.split('?', 2);
  if (!PORTAL_EMBED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return false;
  const explicitSearch = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams([inlineSearch, explicitSearch].filter(Boolean).join('&'));
  return isPortalEmbedFlag(params.get(PORTAL_EMBED_PARAM));
}

/** Resolve the URL fallback theme, defaulting to system when it is absent/invalid. */
export function portalEmbedThemeFromSearch(search = ''): PortalEmbedTheme {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return parsePortalEmbedTheme(params.get(PORTAL_EMBED_THEME_PARAM)) ?? 'system';
}

/** Convert the portal's light/dark/system vocabulary to the operator themes. */
export function operatorThemeForPortalTheme(
  theme: PortalEmbedTheme,
  prefersDark = false,
): OperatorThemeId {
  return theme === 'dark' || (theme === 'system' && prefersDark) ? 'portal-dark' : 'portal-light';
}

/**
 * Extra query params an embed forwards into the framed document — deep links:
 * the portal's `?plan` / `?item` become the operator's `pdash` / `opcis`
 * (portal-work-two-pane-2026-09-01 D-001). Empty / null values are skipped; a
 * present value overrides the same key already in the href.
 */
export type PortalEmbedExtraParams = Readonly<Record<string, string | null | undefined>>;

/** Build an embedded operator URL while preserving the surface's existing query. */
export function portalEmbedHref(
  href: string,
  theme: PortalEmbedTheme,
  parentOrigin?: string | null,
  extra?: PortalEmbedExtraParams,
): string {
  const [pathAndQuery, hash = ''] = href.split('#', 2);
  const [path, query = ''] = pathAndQuery.split('?', 2);
  const params = new URLSearchParams(query);
  params.set(PORTAL_EMBED_PARAM, '1');
  params.set(PORTAL_EMBED_THEME_PARAM, theme);
  const origin = typeof parentOrigin === 'string' ? parentOrigin.trim() : '';
  if (origin) params.set(PORTAL_EMBED_ORIGIN_PARAM, origin);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  return `${path}?${params.toString()}${hash ? `#${hash}` : ''}`;
}

export function portalEmbedThemeMessage(theme: PortalEmbedTheme): PortalEmbedThemeMessage {
  return {
    type: PORTAL_EMBED_MESSAGE,
    version: PORTAL_EMBED_PROTOCOL_VERSION,
    theme,
  };
}

/**
 * Validate a message before applying it.  The expected origin is derived from
 * the embedding document's referrer/query, never from the message itself.
 */
export function isTrustedPortalEmbedMessage(
  data: unknown,
  origin: string,
  expectedOrigin: string | null | undefined,
): data is PortalEmbedThemeMessage {
  if (!expectedOrigin || origin !== expectedOrigin) return false;
  if (!data || typeof data !== 'object') return false;
  const value = data as Record<string, unknown>;
  return value.type === PORTAL_EMBED_MESSAGE
    && value.version === PORTAL_EMBED_PROTOCOL_VERSION
    && parsePortalEmbedTheme(value.theme) !== null;
}

/** Extract a canonical origin from a URL-like string without throwing. */
export function safeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
