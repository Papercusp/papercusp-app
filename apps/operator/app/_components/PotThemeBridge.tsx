'use client';

import { useEffect } from 'react';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { applyTheme, readActiveTheme, subscribeTheme } from '@/lib/theme';

const HIVE_TITLE = 'The Swarm';
const HIVE_THEME_ID = 'honeycomb';
const CLASSIC_TITLE = 'Papercusp Operator';
const HIVE_FAVICON_ID = 'pc-pot-favicon';
const HIVE_FAVICON_HREF = '/brand/the-hive/favicon.svg';

function setHiveFavicon(enabled: boolean): void {
  const existing = document.getElementById(HIVE_FAVICON_ID);
  if (!enabled) {
    existing?.remove();
    return;
  }

  const link = (existing ?? document.createElement('link')) as HTMLLinkElement;
  link.id = HIVE_FAVICON_ID;
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = HIVE_FAVICON_HREF;
  if (!existing) document.head.appendChild(link);
}

export function PotThemeBridge() {
  const hiveEnabled = useFlag(FLAGS.THE_HIVE);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const apply = () => {
      // portalEmbed owns the document theme while this operator is framed by
      // the hosted portal. A profile/theme subscription must not clobber that
      // parent-owned contract after the pre-paint bootstrap has applied it.
      if (document.documentElement.dataset.portalEmbed === 'true') return;
      if (hiveEnabled) {
        document.documentElement.dataset.theme = HIVE_THEME_ID;
        document.title = HIVE_TITLE;
        setHiveFavicon(true);
        return;
      }
      applyTheme(readActiveTheme());
      document.title = CLASSIC_TITLE;
      setHiveFavicon(false);
    };

    apply();
    if (hiveEnabled) return undefined;
    return subscribeTheme(apply);
  }, [hiveEnabled]);

  return null;
}
