'use client';

/**
 * Color-theme selection for the operator UI (client runtime).
 *
 * Mirrors the `lib/visual-effects.ts` pattern (read/write/apply/subscribe +
 * `useSyncExternalStore`, `wsLocalKey`-scoped, applied pre-paint by a boot
 * `<script>` in `app/layout.tsx` + `apps/operator-vite/index.html`). The *active
 * theme selection* is a per-device browser-local preference; *custom theme
 * definitions* persist to a per-workspace local file via `/api/themes` (D-1).
 *
 * Apply mechanism — one path for every theme: `document.documentElement
 * .dataset.theme = '<id>'`. Built-ins resolve via generated CSS selector blocks
 * (`:root`/`[data-theme="frost"]` = frost, `[data-theme="black"]`); custom themes
 * inject a `<style id="pc-custom-themes">` block keyed on `[data-theme="custom:<id>"]`.
 *
 * The token contract lives in `lib/theme-tokens.ts` (shared with the server) and
 * is re-exported here so existing `@/lib/theme` importers keep working.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { injectedPref, reconcileProfilePref, writeProfileField } from '@papercusp/operator-core/lib/profile-pref';
import {
  BUILTIN_THEMES,
  CUSTOM_PREFIX,
  customThemeCss,
  customThemeSlug,
  DEFAULT_THEME_ID,
  isCustomThemeId,
  isValidThemeId,
  type CustomTheme,
  type ThemeMeta,
} from '@papercusp/operator-core/lib/theme-tokens';

export * from '@papercusp/operator-core/lib/theme-tokens';

export const THEME_STORAGE_KEY = 'papercusp.theme';
export const THEME_CHANGE_EVENT = 'papercusp:theme-changed';
/** localStorage key (workspace-scoped) holding the resolved CSS for all custom
 * themes, so the pre-paint boot script can inject it before React/fetch and avoid
 * a flash when a custom theme is active. Kept in sync by {@link applyCustomThemes}. */
export const CUSTOM_THEMES_CSS_KEY = 'papercusp.customThemesCss';
export const CUSTOM_THEMES_META_KEY = 'papercusp.customThemesMeta';
/** Full validated catalog cache. Unlike the CSS cache, this keeps labels and
 * provenance available to mounted pickers during a transient/offline read. */
export const CUSTOM_THEMES_CATALOG_KEY = 'papercusp.customThemesCatalog';
export const CUSTOM_THEMES_STYLE_ID = 'pc-custom-themes';

// ── active-theme selection ────────────────────────────────────────────────

export function readActiveTheme(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID;
  try {
    const stored = window.localStorage.getItem(wsLocalKey(THEME_STORAGE_KEY));
    if (isValidThemeId(stored)) return stored;
  } catch {
    /* fall through to the injected value */
  }
  // Cache cold/unreliable (desktop webview after a reload): fall back to the
  // host-injected PG value (window.__PAPERCUSP_PREFS__.theme_id) so this
  // synchronous snapshot matches the theme the boot script already painted —
  // otherwise React would reset data-theme to the default on first render.
  const injected = injectedPref('theme_id');
  return isValidThemeId(injected) ? injected : DEFAULT_THEME_ID;
}

export function applyTheme(id: string = readActiveTheme()): void {
  if (typeof document === 'undefined') return;
  const safe = isValidThemeId(id) ? id : DEFAULT_THEME_ID;
  document.documentElement.dataset.theme = safe;
  if (isCustomThemeId(safe) && typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(wsLocalKey(CUSTOM_THEMES_META_KEY));
      const meta = raw ? JSON.parse(raw) as Record<string, { baseTheme?: string; colorScheme?: string }> : {};
      const selected = meta[safe];
      document.documentElement.dataset.themeBase = selected?.baseTheme ?? DEFAULT_THEME_ID;
      document.documentElement.style.colorScheme = selected?.colorScheme === 'light' ? 'light' : 'dark';
    } catch {
      document.documentElement.dataset.themeBase = DEFAULT_THEME_ID;
      document.documentElement.style.colorScheme = 'dark';
    }
  } else {
    delete document.documentElement.dataset.themeBase;
    document.documentElement.style.removeProperty('color-scheme');
  }
}

/**
 * Write the active theme to the local cache, apply it, and notify subscribers
 * — WITHOUT pushing to PG. Shared by {@link writeActiveTheme} (after it queues
 * the PG write) and {@link reconcileActiveTheme} (adopting a value that came
 * FROM PG — re-pushing it would be a redundant write-back loop).
 */
function setActiveThemeLocal(id: string): void {
  const safe = isValidThemeId(id) ? id : DEFAULT_THEME_ID;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(wsLocalKey(THEME_STORAGE_KEY), safe);
    } catch {
      // localStorage can be unavailable in private/embedded contexts; still apply in-memory.
    }
  }
  applyTheme(safe);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { id: safe } }));
  }
}

/**
 * Set the active theme: cache it locally + apply + notify (instant), and
 * persist to the operator profile in PG (the source of truth — survives
 * reloads, restarts, and the desktop webview's unreliable localStorage). This
 * is the canonical save+apply entry point for the UI (settings page + navbar).
 */
export function writeActiveTheme(id: string): void {
  const safe = isValidThemeId(id) ? id : DEFAULT_THEME_ID;
  setActiveThemeLocal(safe);
  writeProfileField('theme_id', safe);
}

/**
 * Reconcile the active theme from PG on app mount. If the stored profile
 * `theme_id` differs from the local cache (changed in another window, or the
 * cache was lost), adopt it. The pre-paint host injection already paints the
 * correct theme on the desktop; this keeps long-lived/other windows in sync
 * and recovers when injection is absent (e.g. the :3055 Vite dev origin).
 */
export function reconcileActiveTheme(): Promise<string | null> {
  return reconcileProfilePref<string>({
    field: 'theme_id',
    parse: (raw) => (isValidThemeId(raw) ? raw : null),
    current: readActiveTheme,
    adopt: setActiveThemeLocal,
  });
}

export function subscribeTheme(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const sync = () => {
    applyTheme();
    listener();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key === wsLocalKey(THEME_STORAGE_KEY)) sync();
  };

  window.addEventListener(THEME_CHANGE_EVENT, sync);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, sync);
    window.removeEventListener('storage', handleStorage);
  };
}

function getThemeSnapshot(): string {
  const id = readActiveTheme();
  applyTheme(id);
  return id;
}

function getServerThemeSnapshot(): string {
  return DEFAULT_THEME_ID;
}

export function useActiveTheme(): string {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);
}

// ── custom themes (definitions live in a per-workspace file) ────────────────

/** Inject/replace the `<style>` element that holds every custom theme's rule
 * block, and cache its CSS so the boot script can re-inject it pre-paint. */
export function applyCustomThemes(themes: CustomTheme[]): void {
  const css = themes.map(customThemeCss).join('\n\n');
  if (typeof document !== 'undefined') {
    let el = document.getElementById(CUSTOM_THEMES_STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = CUSTOM_THEMES_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_CSS_KEY), css);
      window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_CATALOG_KEY), JSON.stringify(themes));
      window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_META_KEY), JSON.stringify(Object.fromEntries(
        themes.map((theme) => [`${CUSTOM_PREFIX}${theme.id}`, {
          baseTheme: theme.baseTheme ?? DEFAULT_THEME_ID,
          colorScheme: theme.colorScheme ?? (theme.baseTheme === 'portal-light' ? 'light' : 'dark'),
        }]),
      )));
    } catch {
      /* best effort */
    }
  }
  applyTheme();
}

/** Last known-good catalog for cold/offline rendering. The key is workspace
 * scoped, so switching workspaces cannot leak one workspace's installed layer
 * into another. Invalid cache data degrades to no custom entries while the
 * pre-paint CSS cache remains untouched. */
export function readCachedThemeCatalog(): CustomTheme[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(wsLocalKey(CUSTOM_THEMES_CATALOG_KEY));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((theme): theme is CustomTheme => (
      theme !== null && typeof theme === 'object' &&
      typeof (theme as CustomTheme).id === 'string' &&
      typeof (theme as CustomTheme).label === 'string' &&
      (theme as CustomTheme).tokens !== null &&
      typeof (theme as CustomTheme).tokens === 'object'
    ));
  } catch {
    return [];
  }
}

/** Live installed+local catalog. The sync invalidation fired after a committed
 * install/update/remove refreshes every mounted picker. A missing/error result
 * uses the last known-good workspace cache and, crucially, does not overwrite
 * the pre-paint CSS with an empty catalog. Once a real result arrives, a stale
 * active custom id falls back through the canonical preference writer. */
export function useThemeCatalog(): { themes: CustomTheme[]; error: unknown; invalidate: () => void } {
  const query = useSyncQuery({
    queryName: 'themes.catalog',
    args: {},
    // The theme runtime already owns a workspace-scoped last-known-good cache
    // containing the catalog, CSS, and base/scheme metadata. A second generic
    // persisted-query snapshot can lag a just-committed update across reload
    // and briefly look authoritative. Always revalidate this tiny local-file
    // catalog on mount and keep the dedicated cache as the only offline source.
    staleTime: 0,
    persist: false,
  });
  // `useSyncQuery` exposes `data: []` during its initial load (and can expose a
  // persisted stale array while a refetch is active). Neither is an
  // authoritative declaration that the catalog is empty. Treat only a
  // successful, settled result as live truth; otherwise keep the workspace's
  // last-known-good catalog/CSS. This is especially load-bearing on reload:
  // falling back from an injected `custom:<id>` while the first catalog fetch
  // is still in flight overwrites the correct PG preference with `frost`.
  const liveThemes = (
    !query.loading &&
    !query.fetching &&
    query.error == null &&
    Array.isArray(query.data)
  ) ? query.data as CustomTheme[] : null;
  const themes = useMemo(
    () => liveThemes ?? readCachedThemeCatalog(),
    [liveThemes],
  );
  useEffect(() => {
    if (liveThemes === null) return;
    applyCustomThemes(liveThemes);
    const active = readActiveTheme();
    const slug = customThemeSlug(active);
    if (slug && !liveThemes.some((theme) => theme.id === slug)) {
      writeActiveTheme(DEFAULT_THEME_ID);
    }
  }, [liveThemes]);
  return { themes, error: query.error, invalidate: query.invalidate };
}

async function themesRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/themes${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

export async function fetchCustomThemes(): Promise<CustomTheme[]> {
  const res = await themesRequest('');
  if (!res.ok) throw new Error(`failed to load custom themes (${res.status})`);
  const body = (await res.json()) as { themes?: CustomTheme[] };
  const themes = body.themes ?? [];
  applyCustomThemes(themes);
  return themes;
}

export async function saveCustomTheme(theme: CustomTheme): Promise<CustomTheme> {
  const res = await themesRequest(`/${encodeURIComponent(theme.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `failed to save theme (${res.status})`);
  }
  return (await res.json()) as CustomTheme;
}

export async function deleteCustomTheme(id: string): Promise<void> {
  const res = await themesRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`failed to delete theme (${res.status})`);
}

/** Selector list: built-ins followed by custom themes (as ThemeMeta). */
export function themeList(customThemes: CustomTheme[]): ThemeMeta[] {
  return [
    ...BUILTIN_THEMES,
    ...customThemes.map((t) => ({ id: `${CUSTOM_PREFIX}${t.id}`, label: t.label, builtin: false })),
  ];
}

/** The CustomTheme matching an active id like `custom:<slug>` (or null). */
export function findCustomTheme(activeId: string, customThemes: CustomTheme[]): CustomTheme | null {
  const slug = customThemeSlug(activeId);
  return slug ? (customThemes.find((t) => t.id === slug) ?? null) : null;
}
