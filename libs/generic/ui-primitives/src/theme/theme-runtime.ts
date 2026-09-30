// Headless, framework-agnostic runtime for Restart's [data-theme] theme system.
// No design-tokens / papergrid imports — theme ids are plain strings and the
// manifest is supplied by the consumer (keeps this lib brand-value-free). The
// grid (canvas) re-themes by listening to THEME_EVENT, not by being imported here.

export const STORAGE_KEY = 'restart:theme';
export const THEME_EVENT = 'restart:themechange';
export const DEFAULT_THEME = 'frost';

/** Current theme: the live `<html data-theme>` if set, else the stored choice, else default. */
export function getActiveTheme(): string {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.dataset.theme;
    if (attr) return attr;
  }
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Apply a theme: set the attribute, persist it, and notify listeners (incl. the grid bridge). */
export function applyTheme(id: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = id;
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode / SSR — non-fatal */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { id } }));
  }
}

/** Subscribe to theme changes (this tab via THEME_EVENT, other tabs via `storage`). */
export function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => onChange();
  window.addEventListener(THEME_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(THEME_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

export const getSnapshot = (): string => getActiveTheme();
export const getServerSnapshot = (): string => DEFAULT_THEME;

/** Inline `<script>` body — applies the stored theme before first paint (no FOUC). */
export const PREPAINT_SNIPPET =
  `(function(){try{var t=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});` +
  `if(t)document.documentElement.dataset.theme=t;}catch(e){}})();`;
