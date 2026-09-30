'use client';

import * as RT from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { TOOLTIP_FLOOR_Z } from './popper-z';

export const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  maxWidth: 320,
  padding: "6px 10px",
  fontSize: 12,
  lineHeight: 1.45,
  background: "color-mix(in srgb, var(--bg-1), transparent 4%)",
  color: "var(--fg, #e7f7ff)",
  border: "1px solid var(--border, rgba(125,211,252,0.15))",
  borderRadius: 6,
  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  /* Must clear the whole shell (`.oracle-dock--maximal-hud` is 1450) AND the
     modal band — a tooltip on a control inside a modal is the common case, and
     at the old popper floor of 1500 it was painted under that modal (WI-35969).
     Radix copies this onto the popper wrapper as an inline style, so it — not
     the harness.css floor — decides whether this is visible. Static rather than
     `usePopperZ()` because tooltips never need to be UNDER anything, which
     spares every Tooltip in the app a modal-registry subscription. See P-006 /
     the popper-stacking lint. */
  zIndex: TOOLTIP_FLOOR_Z,
};

export function Tooltip({ label, children, side = 'top', align = 'center' }: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}) {
  if (!label) return <>{children}</>;
  return (
    <RT.Provider delayDuration={250} skipDelayDuration={150}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content
            data-anim="fade"
            sideOffset={6}
            side={side}
            align={align}
            style={TOOLTIP_CONTENT_STYLE}
          >
            {label}
            <RT.Arrow
              style={{
                fill: "color-mix(in srgb, var(--bg-1), transparent 4%)",
              }}
              width={10}
              height={5}
            />
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
