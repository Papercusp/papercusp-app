'use client';

import * as RP from '@radix-ui/react-popover';
import * as RT from '@radix-ui/react-tooltip';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useCallback, useState } from 'react';
import { TOOLTIP_FLOOR_Z, usePopperZ } from './popper-z';
import './Popover.css';

/**
 * A modal dialog traps focus to its own subtree. Radix's default portal target
 * is `document.body`, which puts popover content OUTSIDE that subtree — so the
 * trap reverts any focus landing in the panel straight back to the trigger, and
 * nothing inside the panel can be focused or typed into at all.
 *
 * This is NOT a timing race, so no rAF/retry can win it: a synchronous
 * `input.focus()` on a fully-settled open panel fails just as hard (measured
 * live 2026-08-04 on the chat GRADE rubric picker, WI-10013). The only fix is
 * containment — render the panel INSIDE the trapping dialog.
 */
const MODAL_HOST_SELECTOR = '[role="dialog"][aria-modal="true"]';

/**
 * Popover — the canonical replacement for hand-rolled "anchored dropdown"
 * panels (header notifications, header recent-actions, the OracleDock
 * picker, etc.). Use this when a panel opens *under or beside* its trigger
 * button (i.e. it has an anchor), not centered on the screen.
 *
 * Use `<Modal>` instead when the panel is centered, takes over the screen,
 * or dims the background. Use `<Drawer.Root>` (vaul) for side-slide panels.
 *
 * Pattern:
 *
 *   const [open, setOpen] = useState(false);
 *   <Popover
 *     open={open}
 *     onOpenChange={setOpen}
 *     trigger={<button>Notifications</button>}
 *     side="bottom"
 *     align="end"
 *     ariaLabel="Notification history"
 *   >
 *     <div className="notif-panel">…</div>
 *   </Popover>
 *
 * Defaults differ from Radix Popover in two ways the harness chrome cares
 * about: we DO NOT auto-focus the first child on open (so opening
 * Notifications doesn't steal focus from the editor), and we restore focus
 * to the trigger on close. Override with `autoFocusOnOpen` if needed.
 *
 * For role: by default we set `role="dialog"` to match the prior hand-rolled
 * panels — screen readers announce "Notification history dialog" not
 * "Notification history group". If you want menu semantics (an actual list
 * of single-action items), reach for `@radix-ui/react-dropdown-menu` —
 * that's a different component, not a Popover prop.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  anchor,
  keepOpenWithin,
  tooltipLabel,
  children,
  side = 'bottom',
  align = 'end',
  sideOffset = 6,
  alignOffset = 0,
  ariaLabel,
  autoFocusOnOpen = false,
  closeOnOutsideClick = true,
  closeOnEscape = true,
  contentClassName,
  contentStyle,
  zIndex,
  portalContainer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  /**
   * Positioning-only anchor, rendered via `Popover.Anchor` instead of
   * `Popover.Trigger`. Use when the anchoring element must NOT toggle the
   * panel on click — the case that matters is a combobox whose anchor is its
   * own text input: a Trigger would close the list every time the user clicked
   * to reposition their cursor. With an anchor, open state is entirely the
   * caller's to drive (focus, typing, selection).
   *
   * Mutually exclusive with `trigger`; `trigger` wins if somehow both are set.
   */
  anchor?: ReactNode;
  /**
   * Pointer/focus events landing inside this element do NOT count as
   * "outside", so they can't dismiss the panel. Radix grants a Trigger that
   * exemption automatically but an Anchor gets none — without this, clicking
   * the very input the panel belongs to would dismiss it.
   */
  keepOpenWithin?: RefObject<HTMLElement | null>;
  /** Optional hover/focus tooltip on the trigger. When set, the wrapper
   * composes `Popover.Trigger asChild` *outside* `Tooltip.Trigger asChild`
   * around the same button — both Slots compose refs/props onto the DOM
   * node correctly. Passing a `<Tooltip>` wrapper inside `trigger` instead
   * breaks: Slot tries to clone the Tooltip component, which doesn't
   * forward the merged props down to the button, so `onClick` is lost
   * and the popover never opens. */
  tooltipLabel?: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  ariaLabel: string;
  autoFocusOnOpen?: boolean;
  closeOnOutsideClick?: boolean;
  closeOnEscape?: boolean;
  contentClassName?: string;
  contentStyle?: CSSProperties;
  zIndex?: number;
  /**
   * Explicit portal target. Leave unset: the panel AUTO-HOSTS inside the
   * nearest `[role=dialog][aria-modal=true]` ancestor when there is one (so it
   * lands inside that dialog's focus trap) and falls back to Radix's default
   * `document.body` otherwise. Pass an element only to override that, or `null`
   * to force `document.body`.
   */
  portalContainer?: HTMLElement | null;
}) {
  /*
   * Resolved from the trigger/anchor via a CALLBACK ref, not an effect: the
   * anchoring element mounts long before the panel first opens, so the host is
   * already known at the first open. An effect would portal to `body` for one
   * commit and then re-parent, which remounts the panel's whole subtree — the
   * exact churn that makes focus-on-open flaky.
   */
  const [detectedHost, setDetectedHost] = useState<HTMLElement | null>(null);
  const anchorRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const host = node.closest(MODAL_HOST_SELECTOR);
    setDetectedHost(host instanceof HTMLElement ? host : null);
  }, []);
  const host = portalContainer !== undefined ? portalContainer : detectedHost;

  /* CLAMPED, not defaulted. Radix copies this onto
     `[data-radix-popper-content-wrapper]` as an inline style, which overrides
     the harness.css floor — so a value below the floor is not "lower ordering",
     it is burial behind the app shell. The floor also RISES above any open
     modal, so a popover opened inside one is not buried by it (WI-35969). See
     harness/popper-z.ts. */
  const popperZ = usePopperZ(zIndex);
  const baseStyle: CSSProperties = {
    zIndex: popperZ,
    ...contentStyle,
  };
  /** True when the event came from inside the caller's keep-open element. */
  const isExempt = (target: EventTarget | null) =>
    !!keepOpenWithin?.current && target instanceof Node && keepOpenWithin.current.contains(target);

  const guardOutside = (e: { target: EventTarget | null; preventDefault: () => void }) => {
    if (!closeOnOutsideClick || isExempt(e.target)) e.preventDefault();
  };

  const popoverContent = (
    <RP.Portal container={host ?? undefined}>
      <RP.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        role="dialog"
        aria-label={ariaLabel}
        data-anim="pop"
        onOpenAutoFocus={autoFocusOnOpen ? undefined : (e) => e.preventDefault()}
        onEscapeKeyDown={closeOnEscape ? undefined : (e) => e.preventDefault()}
        onPointerDownOutside={guardOutside}
        onFocusOutside={guardOutside}
        onInteractOutside={guardOutside}
        className={contentClassName ? `pc-popover-content ${contentClassName}` : 'pc-popover-content'}
        style={baseStyle}
      >
        {children}
      </RP.Content>
    </RP.Portal>
  );

  const anchorNode = trigger ? (
    <RP.Trigger asChild ref={anchorRef}>{trigger}</RP.Trigger>
  ) : anchor ? (
    <RP.Anchor asChild ref={anchorRef}>{anchor}</RP.Anchor>
  ) : null;

  if (tooltipLabel) {
    return (
      <RP.Root open={open} onOpenChange={onOpenChange}>
        {/* Own Provider (like harness/Tooltip.tsx): a bare RT.Root throws when no
            app-level TooltipProvider is above it, which crashed every consumer
            rendered standalone (each tooltipLabel test used to wrap itself in a
            provider to survive — EI-9468). Nesting under an app provider is fine;
            this one just pins the 250/150 delays these tooltips already use. */}
        <RT.Provider delayDuration={250} skipDelayDuration={150}>
        <RT.Root>
          <RT.Trigger asChild>
            <RP.Trigger asChild ref={anchorRef}>{trigger}</RP.Trigger>
          </RT.Trigger>
          <RT.Portal>
            <RT.Content
              data-anim="fade"
              sideOffset={6}
              side="bottom"
              align="center"
              style={{
                maxWidth: 320,
                padding: '6px 10px',
                fontSize: 12,
                lineHeight: 1.45,
                background: 'color-mix(in srgb, var(--bg-1), transparent 4%)',
                color: '#f5f5f7',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6,
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                /* Same floor as harness/Tooltip — above the shell AND the modal
                   band (P-006 / WI-35969). Radix copies this to the popper
                   wrapper inline, overriding the harness.css floor. */
                zIndex: TOOLTIP_FLOOR_Z,
              }}
            >
              {tooltipLabel}
              <RT.Arrow style={{ fill: 'color-mix(in srgb, var(--bg-1), transparent 4%)' }} width={10} height={5} />
            </RT.Content>
          </RT.Portal>
        </RT.Root>
        </RT.Provider>
        {popoverContent}
      </RP.Root>
    );
  }

  return (
    <RP.Root open={open} onOpenChange={onOpenChange}>
      {anchorNode}
      {popoverContent}
    </RP.Root>
  );
}
