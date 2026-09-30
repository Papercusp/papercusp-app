// Served as `/@vite/client` when desktop HMR is disabled (see
// `shouldServeNoopViteClient`). It CANNOT be empty: even with `server.hmr:
// false`, the TanStack Router plugin (and potentially others) still inject
//   import { createHotContext as __vite__createHotContext } from "/@vite/client";
//   import.meta.hot = __vite__createHotContext("/src/routes/…");
// into route modules. An empty stub exports no `createHotContext`, so the
// webview throws `SyntaxError: Importing binding name 'createHotContext' is not
// found` and white-screens the whole app. So serve a *functional* no-op
// client: the bindings exist and `import.meta.hot` is an inert stub (no
// WebSocket, no reload), so every `if (import.meta.hot)` HMR block runs
// harmlessly against no-ops. (Real HMR opts in via PAPERCUSP_ENABLE_HMR=1,
// which serves Vite's real client instead.)
//
// ⚠ `updateStyle`/`removeStyle` are NOT HMR — they are Vite's dev-mode CSS
// injection path. Every `import './x.css'` in dev compiles to a JS module
// that calls `updateStyle(id, css)` from this client. Stubbing them as
// no-ops (the original version of this file) rendered the ENTIRE app
// unstyled for any plain-browser consumer of :3055 — invisible in the
// desktop webview (which loads the BUILT dist, where CSS is real files)
// but it broke every Playwright a11y/contrast check in e2e. They must be
// real implementations (mirroring vite/src/client/client.ts); only the
// hot-reload machinery stays inert.
export const NO_VITE_CLIENT_BODY = `/* Papercusp desktop dev: Vite HMR client disabled — inert HMR, REAL style injection. */
const noop = () => {};
export function createHotContext() {
  return {
    accept: noop,
    acceptExports: noop,
    dispose: noop,
    prune: noop,
    invalidate: noop,
    decline: noop,
    on: noop,
    off: noop,
    send: noop,
    data: {},
  };
}
export function injectQuery(url) { return url; }
// Real dev CSS injection (mirrors Vite's client sheetsMap) — see header note.
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (style) {
    style.textContent = content;
    return;
  }
  style = document.createElement('style');
  style.setAttribute('type', 'text/css');
  style.setAttribute('data-vite-dev-id', id);
  style.textContent = content;
  document.head.appendChild(style);
  sheetsMap.set(id, style);
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
`;
import { shouldSuppressStaticDesktopReload } from '@papercusp/operator-core/lib/ui/desktop-static-host';

export function isDesktopHmrEnabled(env: Record<string, string | undefined>): boolean {
  return env.PAPERCUSP_ENABLE_HMR === '1' || env.NEXT_PUBLIC_ENABLE_HMR === '1';
}

export function shouldServeNoopViteClient(url: string | undefined, enableHmr: boolean): boolean {
  return !enableHmr && typeof url === 'string' && url.startsWith('/@vite/client');
}

export function shouldSuppressJsReload(origin: string): boolean {
  return shouldSuppressStaticDesktopReload(origin);
}

export function shouldInterceptStaticAnchor(targetHref: string, currentHref: string): boolean {
  if (!shouldSuppressJsReload(new URL(currentHref).origin)) return false;
  try {
    const current = new URL(currentHref);
    const next = new URL(targetHref, currentHref);
    if (!(next.protocol === 'http:' || next.protocol === 'https:')) return false;
    return next.origin === current.origin;
  } catch {
    return false;
  }
}

export function shouldInterceptStaticAnchorClick(opts: {
  targetHref: string;
  currentHref: string;
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  download: boolean;
  targetBlank: boolean;
}): boolean {
  if (opts.defaultPrevented) return false;
  if (opts.button !== 0) return false;
  if (opts.metaKey || opts.ctrlKey || opts.shiftKey || opts.altKey) return false;
  if (opts.download || opts.targetBlank) return false;
  return shouldInterceptStaticAnchor(opts.targetHref, opts.currentHref);
}
