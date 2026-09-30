'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from '@/lib/router-compat/navigation';
import {
  isPortalEmbedLocation,
  isTrustedPortalEmbedMessage,
  operatorThemeForPortalTheme,
  parsePortalEmbedTheme,
  portalEmbedThemeFromSearch,
  safeOrigin,
  type PortalEmbedTheme,
} from '@papercusp/operator-core/lib/portal-embed';
import { applyTheme } from '@/lib/theme';

function prefersDarkTheme(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function setPortalEmbedAttributes(theme: PortalEmbedTheme): void {
  document.documentElement.dataset.portalEmbed = 'true';
  document.documentElement.dataset.portalEmbedTheme = theme;
  document.body.classList.add('portal-embed');
  applyTheme(operatorThemeForPortalTheme(theme, prefersDarkTheme()));
}

function clearPortalEmbedAttributes(): void {
  delete document.documentElement.dataset.portalEmbed;
  delete document.documentElement.dataset.portalEmbedTheme;
  document.body.classList.remove('portal-embed');
}

/**
 * Keeps an operator document aligned with the hosted portal that framed it.
 * The query string is the pre-paint fallback; the parent message is the live
 * path when a user switches themes without navigating. Origin + source checks
 * keep an unrelated window from changing an embedded operator's palette.
 */
export function PortalEmbedThemeBridge() {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const enabled = isPortalEmbedLocation(pathname, search);

  useEffect(() => {
    if (!enabled) {
      clearPortalEmbedAttributes();
      return;
    }

    const params = new URLSearchParams(search);
    const queryOrigin = safeOrigin(params.get('portalOrigin'));
    const referrerOrigin = safeOrigin(document.referrer);
    // If both signals exist they must agree. A mismatched URL is still allowed
    // to use its local fallback theme, but it may not authorize live messages.
    const expectedOrigin = queryOrigin && referrerOrigin && queryOrigin !== referrerOrigin
      ? null
      : queryOrigin ?? referrerOrigin;
    let theme = portalEmbedThemeFromSearch(search);
    setPortalEmbedAttributes(theme);

    const applyLiveTheme = (next: PortalEmbedTheme) => {
      theme = next;
      setPortalEmbedAttributes(next);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (!isTrustedPortalEmbedMessage(event.data, event.origin, expectedOrigin)) return;
      const next = parsePortalEmbedTheme(event.data.theme);
      if (next) applyLiveTheme(next);
    };
    window.addEventListener('message', onMessage);

    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const onMediaChange = () => {
      if (theme === 'system') setPortalEmbedAttributes(theme);
    };
    media?.addEventListener?.('change', onMediaChange);
    // Safari/WebKitGTK versions shipped with older desktop builds expose the
    // legacy listener pair only.
    media?.addListener?.(onMediaChange);

    return () => {
      window.removeEventListener('message', onMessage);
      media?.removeEventListener?.('change', onMediaChange);
      media?.removeListener?.(onMediaChange);
      clearPortalEmbedAttributes();
    };
  }, [enabled, search]);

  return null;
}
