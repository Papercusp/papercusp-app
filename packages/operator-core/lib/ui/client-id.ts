/**
 * Per-tab UI client id. Stored in sessionStorage so it survives
 * navigations within the tab but each tab gets its own. Generated
 * on first read.
 *
 * This is the handle that the agent → UI control surface keys on:
 * presence rows, intent rows, and the `client` URL param baked into
 * chat-spawned agents' MCP URLs all reference it.
 *
 * See: apps/operator/docs/ui-control-plan.md
 */

const STORAGE_KEY = 'papercusp_ui_client_id';

function uuidv4(): string {
  // Browsers older than ~2024 may not have crypto.randomUUID(). Fall back to
  // assembling from getRandomValues — same shape, same entropy.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let __cached: string | null = null;

/**
 * Read (or mint) the current tab's UI client id. SSR-safe: returns
 * an empty string when not in a browser, callers should treat that
 * as "no presence available" rather than minting one.
 */
export function getOrCreateClientId(): string {
  if (typeof window === 'undefined') return '';
  if (__cached) return __cached;
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
      __cached = existing;
      return existing;
    }
    const fresh = uuidv4();
    window.sessionStorage.setItem(STORAGE_KEY, fresh);
    __cached = fresh;
    return fresh;
  } catch {
    // sessionStorage can throw in private-browsing modes; mint a
    // process-lifetime id instead so the rest of the system still
    // works for this tab.
    if (!__cached) __cached = uuidv4();
    return __cached;
  }
}

/** Test/dev only — clear the in-memory cache. */
export function _resetClientIdCacheForTests(): void {
  __cached = null;
}
