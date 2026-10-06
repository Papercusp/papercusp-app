'use client';

/**
 * Collapsible disclosure that defers mounting children until the first open.
 *
 * Why: always rendering large/expensive children (tables of N rows × M voice
 * options) makes initial page render slow even when the section is collapsed.
 *
 * Children only mount after the user expands. Once mounted, children stay
 * mounted across subsequent collapse/expand cycles so internal state (open
 * dropdowns, input focus, etc.) survives.
 */

import { useRef, useState, type ReactNode, type CSSProperties, type Ref } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';

interface LazyDetailsProps {
  summary: ReactNode;
  children: ReactNode;
  /** Open by default. Defaults to false. */
  defaultOpen?: boolean;
  /** Style passed to the outer Collapsible root. */
  style?: CSSProperties;
  /** Style passed to the Collapsible trigger. */
  summaryStyle?: CSSProperties;
  /** Class passed to the outer Collapsible root. */
  className?: string;
  /** Class passed to the Collapsible trigger. */
  summaryClassName?: string;
  /** Let a caller restore focus to this disclosure after closing a companion. */
  summaryRef?: Ref<HTMLButtonElement>;
}

export function LazyDetails({
  summary,
  children,
  defaultOpen = false,
  style,
  summaryStyle,
  className,
  summaryClassName,
  summaryRef,
}: LazyDetailsProps) {
  const [opened, setOpened] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <Collapsible.Root
      ref={ref}
      className={className}
      style={style}
      defaultOpen={defaultOpen}
      onOpenChange={(open) => {
        if (open && !opened) setOpened(true);
      }}
    >
      <Collapsible.Trigger ref={summaryRef} className={summaryClassName} style={summaryStyle}>{summary}</Collapsible.Trigger>
      {/* forceMount: keep the Content wrapper mounted across collapse so the
          `opened` gate (not Radix's unmount-on-close) governs child lifetime —
          children mount on first open and STAY mounted across later collapses,
          preserving internal child state (the documented invariant; Radix would
          otherwise unmount Content's subtree on every collapse). */}
      <Collapsible.Content forceMount>
        {opened ? children : null}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
