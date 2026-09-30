'use client';

/**
 * Programmatic trigger for the integrated Support tab in the universal chat.
 *
 * Chatwoot is embedded inside OracleDock as the `Support` agent, so support
 * entry points should open that tab instead of launching a separate bubble.
 */

import type { ReactNode } from 'react';
import { shouldFallbackToSupportRoute } from '@papercusp/operator-core/lib/ui/desktop-static-host';
import { navigateClient } from '@papercusp/operator-core/lib/client-navigation';

interface Props {
  children?: ReactNode;
  className?: string;
  /** Optional message copied for the user before opening Support. */
  message?: string;
}

export function SupportChatButton({ children, className, message }: Props) {
  const onClick = () => {
    if (typeof window === 'undefined') return;
    if (message) {
      navigator.clipboard?.writeText(message).catch(() => {});
    }
    window.dispatchEvent(new CustomEvent('papercusp:open-support'));
    window.setTimeout(() => {
      if (shouldFallbackToSupportRoute(Boolean(document.querySelector('[data-oracle-dock]')))) {
        navigateClient('/support');
      }
    }, 250);
  };

  return (
    <button onClick={onClick} className={className} type="button">
      {children ?? 'Start support chat'}
    </button>
  );
}
