'use client';

import { useEffect } from 'react';

/**
 * Capture every sonner toast to harness_shared.toast_log so the
 * NotificationCenter bell can show history across reloads.
 *
 * Implementation: a MutationObserver watches the sonner Toaster's <ol>
 * for new <li> children. Each new toast's level/message/description is
 * extracted from the rendered DOM and POSTed to /api/toast-log. The
 * Toaster <ol> is created lazily (sonner only mounts it when the first
 * toast appears), so we also observe the parent <section> until the <ol>
 * appears.
 *
 * No `toast()` callsite changes are needed — every call from anywhere
 * in the codebase gets logged.
 */
export function ToastHistoryRecorder() {
  useEffect(() => {
    const seenIds = new Set<string>();

    const recordToast = (li: Element) => {
      // Sonner toast layout: <li data-sonner-toast data-id="…" data-type="error|success|...">
      //   <div data-content>
      //     <div data-title>...</div>
      //     <div data-description>...</div>
      const id = li.getAttribute('data-id') ?? '';
      // Use data-id when present so we don't double-record on rerender.
      // Fall back to a synthetic key if sonner ever omits it.
      const key = id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (seenIds.has(key)) return;
      seenIds.add(key);

      const level = li.getAttribute('data-type') ?? 'default';
      const titleEl = li.querySelector('[data-title]');
      const descEl = li.querySelector('[data-description]');
      // Some toasts use plain children if no separate title/description was
      // passed — fall back to the toast's full text content.
      const message = (titleEl?.textContent ?? li.textContent ?? '').trim();
      if (!message) return;
      const description = descEl?.textContent?.trim() || null;

      // Action button captured by the lib/notify.ts helper. The helper
      // wraps the action label in a <span data-toast-action-href="…">
      // so we can read the href + label back out of the rendered DOM
      // without a separate POST. Plain `toast.X(...)` calls (without
      // the helper) don't carry this attribute and so don't surface
      // a button in the history (we can't replay an arbitrary onClick
      // function from a database row).
      const actionEl = li.querySelector<HTMLElement>('[data-toast-action-href]');
      const actionLabel = actionEl?.getAttribute('data-toast-action-label')
        ?? actionEl?.textContent?.trim()
        ?? null;
      const actionHrefRaw = actionEl?.getAttribute('data-toast-action-href') ?? '';
      const actionHref = actionHrefRaw && (actionHrefRaw.startsWith('/') || /^https?:\/\//i.test(actionHrefRaw))
        ? actionHrefRaw
        : null;

      // Active harness from URL search param `slug` (panel routes) or path
      // segment (`/harness/[slug]`).
      let harnessSlug: string | null = null;
      try {
        const url = new URL(window.location.href);
        const fromQuery = url.searchParams.get('slug');
        if (fromQuery && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(fromQuery)) {
          harnessSlug = fromQuery;
        } else {
          const m = url.pathname.match(/\/harness\/([a-z0-9][a-z0-9._-]{0,63})\b/i);
          if (m) harnessSlug = m[1];
        }
      } catch { /* ignore */ }

      // Fire-and-forget; failure to log a toast must never disrupt the UI.
      fetch('/api/toast-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message, description, harnessSlug, actionLabel, actionHref }),
        keepalive: true,
      }).catch(() => {});
    };

    let liObserver: MutationObserver | null = null;
    const attachLiObserver = (ol: Element) => {
      // Existing toasts (e.g., on hot-reload) get logged on first mount.
      ol.querySelectorAll(':scope > li').forEach(recordToast);
      liObserver?.disconnect();
      liObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of Array.from(m.addedNodes)) {
            if (node.nodeType === 1 && (node as Element).tagName === 'LI') {
              recordToast(node as Element);
            }
          }
        }
      });
      liObserver.observe(ol, { childList: true });
    };

    // The <ol> may not exist yet (sonner mounts it lazily). Watch the
    // section until it appears.
    let sectionObserver: MutationObserver | null = null;
    const tryAttach = () => {
      const ol = document.querySelector<HTMLOListElement>('ol[data-sonner-toaster]');
      if (ol) {
        attachLiObserver(ol);
        return true;
      }
      return false;
    };

    if (!tryAttach()) {
      const section = document.querySelector('section[aria-label*="Notifications"]');
      if (section) {
        sectionObserver = new MutationObserver(() => {
          if (tryAttach()) sectionObserver?.disconnect();
        });
        sectionObserver.observe(section, { childList: true, subtree: true });
      }
    }

    return () => {
      liObserver?.disconnect();
      sectionObserver?.disconnect();
    };
  }, []);

  return null;
}
