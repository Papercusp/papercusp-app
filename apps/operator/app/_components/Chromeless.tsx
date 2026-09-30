'use client';

import { useEffect } from 'react';

/**
 * Toggles the `papercusp-chromeless` body class which globals.css uses to
 * hide the root header / OracleDock / Chatwoot widget. Useful for routes
 * embedded as iframes by plugin dashboard tabs (see /pi and /docs).
 *
 * - `auto` (default false): if true, only apply when we detect we're inside
 *   an iframe (`window.self !== window.top`). Use this for routes that are
 *   also meaningful standalone (e.g. /docs, where direct visitors should
 *   still see the operator chrome). Without `auto`, applies unconditionally.
 */
export default function Chromeless({ auto = false }: { auto?: boolean }) {
  useEffect(() => {
    if (auto && window.self === window.top) return;
    document.body.classList.add('papercusp-chromeless');
    return () => document.body.classList.remove('papercusp-chromeless');
  }, [auto]);
  return null;
}
