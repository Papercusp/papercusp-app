'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MODAL_FLOOR_Z, clampModalZ, nextModalZ, registerOpenModalZ } from './popper-z';
import './Modal.css';

/* No z-index here on purpose: the layer is ALLOCATED per open (see the docblock
   in the component body) and always overwrites this object, so a literal here
   would be inert and misleading — the exact reading trap EI-19478883404425412
   filed against the Popover call sites. */
const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.75)',
};

const CONTENT_WRAP_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  /* z-index deliberately absent — allocated per open, see OVERLAY_STYLE above. */
  pointerEvents: 'none', // overlay handles backdrop clicks; content gets its own
  padding: '2rem',
};

const CONTENT_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  outline: 'none',
  // The wrap insets the content by 2rem on every side; cap the box to the
  // remaining viewport and scroll internally so a tall dialog (e.g. a create
  // success card with an invite secret + warnings) can never overflow past the
  // backdrop and leave nothing to click-away on. Per-modal contentStyle (spread
  // after this) can still override.
  maxHeight: 'calc(100vh - 4rem)',
  overflowY: 'auto',
};

const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/**
 * Modal — Radix Dialog wrapper that matches the harness's centered modal
 * pattern. Use:
 *   <Modal open={open} onOpenChange={setOpen} title="My modal">
 *     <inner content />
 *   </Modal>
 *
 * `title` is required for screen readers. Pass `srOnlyTitle` to hide it.
 * `description` similarly maps to Dialog.Description.
 *
 * Use `contentStyle` to override sizing; the wrapper centers it. Use
 * `overlayStyle` to tweak backdrop (e.g., higher z-index/partial scrim).
 * `closeOnOverlayClick` can keep a scrim dismissible even when
 * `closeOnOutsideClick={false}` preserves live persistent chrome.
 *
 * `wrapStyle` overrides the CENTERING WRAP, not the content — the one thing
 * `contentStyle` cannot reach. The wrap insets every modal by 2rem on all
 * sides, which is right for a centered dialog and wrong for a
 * fill-the-window one: a `width: 100vw` content still lands 2rem short on
 * each edge and centered, so it reads as "nearly maximized", which looks like
 * a layout bug rather than a mode. Pass `{ padding: 0 }` to opt out. Kept as
 * a style override rather than a `fullBleed` boolean because the wrap is a
 * plain flex box — alignment and padding are the only things anyone needs
 * from it, and a boolean would have to grow a case per future caller.
 * (session-chat-popup-direction-d-2026-08-02 P-001.)
 */
export function Modal({
  open,
  onOpenChange,
  title,
  srOnlyTitle = false,
  description,
  children,
  contentStyle,
  contentClassName,
  overlayStyle,
  wrapStyle,
  zIndex,
  closeOnEscape = true,
  closeOnOutsideClick = true,
  closeOnOverlayClick = closeOnOutsideClick,
  modal = true,
  nonDismissableOutsideSelector,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  srOnlyTitle?: boolean;
  description?: string;
  children: ReactNode;
  contentStyle?: CSSProperties;
  contentClassName?: string;
  overlayStyle?: CSSProperties;
  /** Overrides the centering wrap (padding/alignment) — see the docblock. */
  wrapStyle?: CSSProperties;
  zIndex?: number;
  closeOnEscape?: boolean;
  closeOnOutsideClick?: boolean;
  closeOnOverlayClick?: boolean;
  modal?: boolean;
  /**
   * Outside clicks matching this selector are allowed to reach the target
   * without dismissing the dialog. Use sparingly for persistent app chrome
   * that must remain live while a modal-like surface is open.
   */
  nonDismissableOutsideSelector?: string;
  /**
   * Radix's open-autofocus hook. By default Radix focuses the FIRST TABBABLE
   * descendant, which is whatever happens to be first in the DOM — often a
   * window control (a close/maximize button) rather than the content. That is
   * both poor a11y (the reader lands on chrome, not on what they opened) and,
   * if that control is a tooltip trigger, an Escape thief: the tooltip opens on
   * focus, mounts its own dismissable layer, and swallows the first Escape so
   * the dialog never closes.
   *
   * Prevent-and-redirect to opt out:
   *   onOpenAutoFocus={(e) => { e.preventDefault(); myRef.current?.focus(); }}
   * (give the redirect target `tabIndex={-1}` so it is focusable but not
   * itself tabbable).
   */
  onOpenAutoFocus?: (event: Event) => void;
  /**
   * Runs before the default return-focus behavior. Prevent the event when a
   * caller needs to move focus somewhere other than the element that opened
   * the dialog.
   */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  /*
   * Layer allocation (WI-35969). This used to be a flat `zIndex ?? 100`, chosen
   * when the only thing a modal had to clear was the OracleDock at 80. The
   * body-portaled popper floor was later raised to 1500, which silently made
   * that 100 mean "under every dropdown" — so a modal opened FROM a dropdown
   * (the agents-running pill → a conversation) was painted behind the dropdown
   * that launched it and read as "it never opened". See harness/popper-z.ts.
   *
   * Allocated ONCE per open, and adjusted DURING the opening render rather than
   * in an effect: an effect would paint one frame at the wrong layer, and for a
   * modal-over-popper-over-modal stack that frame is exactly the wrong one.
   * (React's supported "adjust state during render" pattern — the extra render
   * is thrown away before the browser sees it.)
   */
  const [prevOpen, setPrevOpen] = useState(open);
  const [allocatedZ, setAllocatedZ] = useState<number | null>(() => (open ? nextModalZ() : null));
  if (open !== prevOpen) {
    setPrevOpen(open);
    setAllocatedZ(open ? nextModalZ() : null);
  }
  // An explicit `zIndex` still wins — callers that deliberately order two of
  // their own surfaces keep doing so — but the floor is now MODAL_FLOOR_Z, not
  // an arbitrary literal, so a stale low value cannot bury the modal again.
  const z = clampModalZ(zIndex ?? allocatedZ ?? MODAL_FLOOR_Z);
  // Publish while open so a Select/Tooltip opened INSIDE this modal can clear
  // it. Registration in an effect is soon enough: effects flush before the user
  // can interact with the modal that just appeared.
  useEffect(() => {
    if (!open) return;
    return registerOpenModalZ(z);
  }, [open, z]);
  // Radix can restore focus through <Dialog.Trigger>, but this wrapper is used
  // as a controlled primitive and intentionally exposes no Trigger. Capture
  // the active invoker immediately before Radix moves focus into the content,
  // then restore it after the dismissable layer has torn down. The same
  // requestAnimationFrame timing is used by useConfirmDialog/usePromptDialog.
  const restoreFocusTargetRef = useRef<HTMLElement | null>(null);
  const handleOpenAutoFocus = (event: Event) => {
    const active =
      typeof document === 'undefined' ? null : document.activeElement;
    restoreFocusTargetRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    onOpenAutoFocus?.(event);
  };
  const handleCloseAutoFocus = (event: Event) => {
    onCloseAutoFocus?.(event);
    const target = restoreFocusTargetRef.current;
    restoreFocusTargetRef.current = null;
    if (
      event.defaultPrevented ||
      !target ||
      typeof requestAnimationFrame === 'undefined'
    ) {
      return;
    }
    event.preventDefault();
    requestAnimationFrame(() => {
      if (document.contains(target)) target.focus({ preventScroll: true });
    });
  };
  const overlay = { ...OVERLAY_STYLE, zIndex: z, ...overlayStyle };
  const wrap = { ...CONTENT_WRAP_STYLE, zIndex: z + 1, ...wrapStyle };
  const content = { ...CONTENT_STYLE, ...contentStyle };
  const keepAllowedOutsideInteractionOpen = (event: {
    target: EventTarget | null;
    detail?: { originalEvent?: Event };
    preventDefault: () => void;
  }) => {
    if (!closeOnOutsideClick) {
      event.preventDefault();
      return;
    }
    const target = event.detail?.originalEvent?.target ?? event.target;
    if (
      nonDismissableOutsideSelector
      && target instanceof Element
      && target.closest(nonDismissableOutsideSelector)
    ) {
      event.preventDefault();
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <Dialog.Portal>
        {modal ? (
          <Dialog.Overlay
            data-anim="fade"
            style={overlay}
            onClick={closeOnOverlayClick ? () => onOpenChange(false) : undefined}
          />
        ) : (
          <div
            aria-hidden="true"
            data-anim="fade"
            style={overlay}
            onClick={closeOnOverlayClick ? () => onOpenChange(false) : undefined}
          />
        )}
        <div style={wrap}>
          <Dialog.Content
            aria-modal={modal ? 'true' : undefined}
            className={contentClassName ? `pc-modal-content ${contentClassName}` : 'pc-modal-content'}
            data-anim="pop"
            style={content}
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
            onEscapeKeyDown={closeOnEscape ? undefined : (e) => e.preventDefault()}
            onPointerDownOutside={keepAllowedOutsideInteractionOpen}
            onInteractOutside={keepAllowedOutsideInteractionOpen}
          >
            <Dialog.Title style={srOnlyTitle ? SR_ONLY_STYLE : { display: 'none' }}>
              {title}
            </Dialog.Title>
            {/*
             * Always render Dialog.Description (sr-only when no description
             * passed). Radix emits an a11y warning whenever the rendered
             * Dialog.Content has no descendant Description and no explicit
             * aria-describedby. Empty string is fine for screen readers —
             * Title carries the meaning.
             */}
            <Dialog.Description style={SR_ONLY_STYLE}>
              {description ?? ''}
            </Dialog.Description>
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
