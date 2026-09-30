'use client';

import type { ReactNode } from 'react';
import { useLexiconPackId } from '@/lib/useLexicon';

type Props = {
  title?: string;
  subtitle?: string;
  className?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  leading?: ReactNode;
};

export function OperatorWordmarkLockup({
  title,
  subtitle,
  className,
  titleClassName,
  subtitleClassName,
  leading,
}: Props) {
  const packId = useLexiconPackId();
  // Product wordmark default. WI-4478 D-001: the product/window identity is
  // "Papercusp" (matches the Tauri window title + productName); the assistant
  // PERSONA stays "Papercup" in chat/voice surfaces, which pass an explicit
  // `title="Papercup"` override (see OperatorChatSidebar) rather than relying
  // on this default.
  const resolvedTitle = title ?? (packId === 'the-hive' ? 'The Swarm' : 'Papercusp');
  const resolvedSubtitle = subtitle ?? (packId === 'the-hive' ? 'Hive console' : 'mission console');

  return (
    <span className={className ? `operator-wordmark ${className}` : 'operator-wordmark'}>
      {leading}
      <span className="operator-wordmark__copy">
        <span className={titleClassName ? `operator-wordmark__title ${titleClassName}` : 'operator-wordmark__title'}>
          {resolvedTitle}
        </span>
        {resolvedSubtitle ? (
          <span className={subtitleClassName ? `operator-wordmark__subtitle ${subtitleClassName}` : 'operator-wordmark__subtitle'}>
            {resolvedSubtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
