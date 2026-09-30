'use client';

import * as RT from '@radix-ui/react-tooltip';
import React, { type ReactNode } from 'react';

/**
 * GitTooltip — local Radix Tooltip wrapper, mirrors
 * apps/operator/app/harness/Tooltip.tsx so the git panel can give
 * action buttons accessible hover/focus hints without native `title=`
 * (design-spec HR4).
 *
 * Relies on a `<Tooltip.Provider>` mounted by the consuming app — the
 * operator hoists one to its root layout, so any git panel rendered
 * inside the operator is covered. Renders children unchanged when
 * `label` is falsy.
 */

const CONTENT_STYLE: React.CSSProperties = {
  maxWidth: 320,
  padding: '6px 10px',
  fontSize: 12,
  lineHeight: 1.45,
  background: 'rgba(20,20,22,0.96)',
  color: '#f5f5f7',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  zIndex: 200,
};

export function GitTooltip({
  label,
  children,
  side = 'top',
}: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  if (!label) return <>{children}</>;
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content data-anim="fade" sideOffset={6} side={side} style={CONTENT_STYLE}>
          {label}
          <RT.Arrow style={{ fill: 'rgba(20,20,22,0.96)' }} width={10} height={5} />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
