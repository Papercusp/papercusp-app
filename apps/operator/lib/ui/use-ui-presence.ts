'use client';

/**
 * Mirror the current tab's URL into harness_shared.ui_clients so
 * agents can ask "what is the user looking at right now?" without
 * per-feature wiring.
 *
 * Posts on:
 *   - mount (and a one-shot retry after 1s for slow first-paint)
 *   - every URL change (via the popstate event, which nuqs + our
 *     built-in `set_url` intent both fire)
 *   - every 15 seconds as a heartbeat for last_seen_at
 */

import { useEffect, useRef } from 'react';
import { getOrCreateClientId } from '@papercusp/operator-core/lib/ui/client-id';
import { callRoute } from '@papercusp/operator-core/lib/call-tool';

const HEARTBEAT_MS = 15_000;

async function postPresence(clientId: string): Promise<void> {
  try {
    await callRoute('/api/ui/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        url: window.location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      }),
      keepalive: true,
    });
  } catch {
    // Presence is best-effort. Don't make the UI care if it fails.
  }
}

export function useUiPresence(): void {
  const lastUrlRef = useRef<string>('');
  useEffect(() => {
    const clientId = getOrCreateClientId();
    if (!clientId) return;

    const flush = () => {
      const url = window.location.href;
      if (url === lastUrlRef.current) return;
      lastUrlRef.current = url;
      void postPresence(clientId);
    };

    // Initial post + a one-shot retry (covers cases where the first
    // request fires before the operator's middleware is warm).
    void postPresence(clientId);
    const initialRetry = window.setTimeout(() => void postPresence(clientId), 1_000);

    const onPop = () => flush();
    window.addEventListener('popstate', onPop);

    // nuqs + Next.js trigger a popstate on shallow navigations, but
    // not every router.push goes through history.pushState in dev.
    // Poll the URL every 500ms as a safety net; the diff check keeps
    // POST volume low.
    // perf:allow A7 — diff-guarded URL-change safety poll; flush only POSTs on an
    // actual URL change, so the steady-state cost is a 500ms string compare.
    const poll = window.setInterval(flush, 500);
    const heartbeat = window.setInterval(() => void postPresence(clientId), HEARTBEAT_MS);

    return () => {
      window.clearTimeout(initialRetry);
      window.clearInterval(poll);
      window.clearInterval(heartbeat);
      window.removeEventListener('popstate', onPop);
    };
  }, []);
}
