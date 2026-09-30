'use client';

/**
 * Built-in intent handlers — registered once on app boot by the
 * UiIntentDispatcher. These are generic enough to work on any page,
 * so features don't need to opt in.
 *
 * `set_url` is the workhorse: because every nuqs-state lives in the
 * URL, "open the panel", "switch tabs", "select a row" reduce to
 * "merge these params into the URL". The browser's history API +
 * nuqs's URL subscription handle the rest.
 */

import { registerIntent } from './intent-registry';

let __registered = false;

export function registerBuiltInIntents(): void {
  if (__registered || typeof window === 'undefined') return;
  __registered = true;

  registerIntent(
    'set_url',
    (args) => {
      const params = (args.params as Record<string, string | null> | undefined) ?? {};
      const mode = (args.mode as 'merge' | 'replace' | undefined) ?? 'merge';
      // Optional pathname navigation (P-018 GUI tab-tour): `path: '/adv'`
      // switches the route while params merge as usual. Same-origin only —
      // a relative path, never a full URL.
      const path = args.path as string | undefined;
      const u = new URL(window.location.href);
      if (path !== undefined) {
        if (!path.startsWith('/')) throw new Error(`set_url: path must start with '/' (got ${JSON.stringify(path)})`);
        u.pathname = path;
      }
      if (mode === 'replace') {
        for (const k of Array.from(u.searchParams.keys())) u.searchParams.delete(k);
      }
      for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined) u.searchParams.delete(k);
        else u.searchParams.set(k, String(v));
      }
      // history.replaceState + popstate so Next/nuqs subscribers fire.
      // Next.js router.replace would also work but we don't have the
      // router instance here without coupling to a hook. Direct
      // history is fine for this use case.
      window.history.replaceState({}, '', `${u.pathname}${u.search}${u.hash}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return { url: window.location.href };
    },
    { builtIn: true },
  );

  registerIntent(
    'snapshot',
    (args) => {
      const selector = (args.selector as string | undefined) ?? 'body';
      const mode = (args.mode as 'outerHTML' | 'innerText' | 'textContent' | undefined) ?? 'innerText';
      const el = document.querySelector(selector);
      if (!el) return { found: false, selector, text: null };
      const max = (args.maxLength as number | undefined) ?? 50_000;
      let text: string;
      if (mode === 'outerHTML') text = (el as HTMLElement).outerHTML;
      else if (mode === 'textContent') text = el.textContent ?? '';
      else text = (el as HTMLElement).innerText ?? el.textContent ?? '';
      if (text.length > max) text = text.slice(0, max) + `\n…truncated at ${max} chars`;
      return { found: true, selector, mode, text };
    },
    { builtIn: true },
  );

  registerIntent(
    'read_visible_text',
    (args) => {
      const selector = (args.selector as string | undefined) ?? 'body';
      const el = document.querySelector(selector);
      if (!el) return { found: false, selector, text: null };
      const max = (args.maxLength as number | undefined) ?? 50_000;
      let text = (el as HTMLElement).innerText ?? '';
      if (text.length > max) text = text.slice(0, max) + `\n…truncated at ${max} chars`;
      return { found: true, selector, text };
    },
    { builtIn: true },
  );

  registerIntent(
    'focus',
    (args) => {
      const selector = args.selector as string | undefined;
      if (!selector) throw new Error('focus: selector required');
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return { found: false, selector };
      el.focus();
      return { found: true, selector, activeElementMatches: document.activeElement === el };
    },
    { builtIn: true },
  );

  registerIntent(
    'scroll_into_view',
    (args) => {
      const selector = args.selector as string | undefined;
      if (!selector) throw new Error('scroll_into_view: selector required');
      const el = document.querySelector(selector);
      if (!el) return { found: false, selector };
      const block = (args.block as ScrollLogicalPosition | undefined) ?? 'center';
      el.scrollIntoView({ block, behavior: 'instant' as ScrollBehavior });
      return { found: true, selector };
    },
    { builtIn: true },
  );

  registerIntent(
    'click',
    (args) => {
      const selector = args.selector as string | undefined;
      if (!selector) throw new Error('click: selector required');
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return { found: false, selector };
      el.click();
      return { found: true, selector };
    },
    { builtIn: true },
  );
}
