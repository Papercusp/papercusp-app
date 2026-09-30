'use client';

/**
 * Chatwoot live-chat widget for the in-app operator surface.
 *
 * Mirrors the implementation on papercusp.com but tags conversations
 * with `papercusp:operator` so the support team can tell them apart
 * from public marketing-site visits.
 *
 * Performance rule: do NOT boot the cross-origin widget iframe on every
 * operator page load. Load it only when support is explicitly requested
 * (Support page / support CTA), otherwise the hidden iframe burns a full
 * WebKit process for no user-visible value.
 */

import { useEffect, useState } from 'react';
import { shouldEnableSupportWidget } from '@papercusp/operator-core/lib/ui/desktop-static-host';

declare global {
  interface Window {
    chatwootSettings?: Record<string, unknown>;
    chatwootSDK?: { run: (config: { websiteToken: string; baseUrl: string }) => void };
    $chatwoot?: {
      setUser: (id: string, attrs: Record<string, unknown>) => void;
      setLabel: (label: string) => void;
      setCustomAttributes: (attrs: Record<string, unknown>) => void;
      reset: () => void;
      toggle: (state?: 'open' | 'close') => void;
    };
  }
}

const DEFAULT_BASE_URL = 'https://chat.papercupai.com';
const DEFAULT_TOKEN = 'CT5CTToo11YtPN3CVkhvbFs9';

export function shouldEnableChatwootForCurrentWindow(view: {
  pathname: string;
  origin: string;
}): boolean {
  return shouldEnableSupportWidget(view.pathname, view.origin);
}

function shouldEnableNow(): boolean {
  if (typeof window === 'undefined') return false;
  return shouldEnableChatwootForCurrentWindow({
    pathname: window.location.pathname,
    origin: window.location.origin,
  });
}

function readCssToken(name: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || undefined;
}

export function ChatwootWidget() {
  const [enabled, setEnabled] = useState(shouldEnableNow);

  useEffect(() => {
    const enable = () => {
      if (!shouldEnableNow()) return;
      setEnabled(true);
    };
    const onPopState = () => {
      if (shouldEnableNow()) setEnabled(true);
      else setEnabled(false);
    };
    window.addEventListener('papercusp:open-support', enable as EventListener);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('papercusp:open-support', enable as EventListener);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const baseUrl = process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL ?? DEFAULT_BASE_URL;
    const websiteToken = process.env.NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN ?? DEFAULT_TOKEN;
    if (!websiteToken) return;
    const widgetColor = readCssToken('--accent');

    window.chatwootSettings = {
      hideMessageBubble: true,
      position: 'right',
      locale: 'en',
      type: 'standard',
      launcherTitle: 'Papercusp Support',
      darkMode: 'dark',
      ...(widgetColor ? { widgetColor } : {}),
      widgetStyle: 'flat',
      showUnreadMessagesDialog: false,
      showPopoutButton: false,
    };

    if (window.chatwootSDK) {
      window.chatwootSDK.run({ websiteToken, baseUrl });
      return;
    }

    const script = document.createElement('script');
    script.src = `${baseUrl}/packs/js/sdk.js`;
    script.defer = true;
    script.async = true;
    script.onerror = () => {
      script.remove();
    };
    script.onload = () => {
      window.chatwootSDK?.run({ websiteToken, baseUrl });
      const ready = (cb: () => void) => {
        const tick = () => {
          if (window.$chatwoot) cb();
          else setTimeout(tick, 200);
        };
        tick();
      };
      ready(() => {
        try {
          window.$chatwoot?.setLabel('papercusp:operator');
          fetch('/api/auth/me')
            .then((r) => (r.ok ? r.json() : null))
            .then((auth) => {
              const me = auth?.user ?? null;
              if (me?.id) {
                window.$chatwoot?.setUser(String(me.id), {
                  name: me.display_name ?? me.username ?? undefined,
                });
              }
            })
            .catch(() => {
              /* unauthenticated — ignore */
            });
        } catch {
          /* best-effort */
        }
      });
    };
    document.body.appendChild(script);
  }, [enabled]);

  return null;
}
