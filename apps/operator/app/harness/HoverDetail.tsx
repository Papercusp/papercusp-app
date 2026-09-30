'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from './Popover';

/**
 * HoverDetail — a hover-opened detail panel whose text you can actually SELECT.
 *
 * WHY THIS IS NOT `harness/Tooltip` [owner 2026-08-09]: "it should show the full
 * details on hover in a tooltip, but the text in the tooltip should also be
 * selectable and it shouldn't disappear easily to make it easy for the user to
 * select the text". A Radix Tooltip is the wrong primitive for that by design —
 * it is a transient label for a control, it closes on the first pointer event
 * that looks like intent, and dragging across it to select is exactly such an
 * event. So this is built on `harness/Popover` (a real `role="dialog"` panel)
 * with hover DRIVING it instead of a click.
 *
 * Three behaviours make "doesn't disappear easily" true rather than merely
 * slower, and the third is the one that matters:
 *
 *   1. GRACE. Leaving the anchor starts a ~500ms timer, not an immediate close,
 *      so the diagonal path from a row to the panel below it does not dismiss
 *      what you were reaching for.
 *   2. HOVER-THROUGH. The panel itself is a hover target: entering it cancels
 *      the pending close, so the pointer can live inside it indefinitely.
 *   3. SELECTION HOLD. While a non-collapsed selection exists INSIDE the panel,
 *      the close timer re-arms instead of firing — for as long as the selection
 *      lasts. Without this, the sequence that actually matters (select text →
 *      move the pointer to the copy shortcut / out of the panel) destroys the
 *      selection the user just made, which is the complaint this exists to fix.
 *      An outside click still dismisses it, and clicking outside is also what
 *      collapses the selection, so it cannot get stuck open.
 *
 * PIN. Clicking the anchor pins the panel open: hover leaves stop mattering
 * entirely until it is dismissed with the ✕, Escape, an outside click, or
 * another click on the anchor. That is the deliberate escape hatch for reading
 * something long without keeping a pointer parked on it.
 *
 * Everything about layering and focus-trap containment is inherited from
 * `harness/Popover`, which is the whole reason to build on it: it portals into
 * the nearest `[role=dialog][aria-modal=true]` ancestor (the dossier renders
 * inside `SessionChatModal`, so a `document.body` portal would land outside
 * that focus trap) and clamps its z above any open modal — see harness/popper-z.
 */

/** Hover-in dwell before opening. Long enough that sweeping the pointer across
 *  a list does not strobe panels; short enough to feel like a tooltip. */
const OPEN_DELAY_MS = 180;

/** Grace after the pointer leaves both the anchor and the panel. */
const CLOSE_GRACE_MS = 500;

/**
 * Is there a live, non-collapsed selection inside `el`?
 *
 * `Node.contains` accepts text nodes, and `commonAncestorContainer` IS a text
 * node for the common case of selecting within one paragraph — checking
 * `sel.anchorNode` alone would miss a selection extended backwards, so every
 * range is tested. Exported for the test that proves the hold actually holds.
 */
export function hasSelectionInside(el: HTMLElement | null): boolean {
  if (!el || typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  for (let i = 0; i < sel.rangeCount; i += 1) {
    const range = sel.getRangeAt(i);
    if (range.collapsed) continue;
    if (el.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

const PANEL_STYLE: CSSProperties = {
  /* Wider than harness/Tooltip's 320: this carries a body meant to be READ and
     copied, not a two-word label. */
  maxWidth: 460,
  maxHeight: 340,
  overflowY: 'auto',
  padding: '8px 10px',
  fontSize: 12,
  lineHeight: 1.5,
  background: 'color-mix(in srgb, var(--bg-1), transparent 4%)',
  color: '#f5f5f7',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  /* The point of the component. An ancestor with `user-select: none` (rails and
     chrome commonly set it to stop drag-selecting the UI) would otherwise make
     the body unselectable no matter how long the panel stays up. */
  userSelect: 'text',
  WebkitUserSelect: 'text',
  cursor: 'auto',
  /* Long refs, uuids and paths must WRAP rather than force a horizontal
     scrollbar inside a hover panel. */
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
};

export function HoverDetail({
  detail,
  children,
  ariaLabel,
  side = 'left',
  align = 'start',
  header,
  testId,
}: {
  /** The panel body. Rendered as-is; pass a string for plain selectable text. */
  detail: ReactNode;
  /** The anchor — the row/label the pointer hovers. */
  children: ReactNode;
  ariaLabel: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Optional one-line heading shown above the body, beside the pin control. */
  header?: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Mirrored into a ref because the close timer's callback re-arms ITSELF and
     would otherwise capture a stale `pinned` from the render that scheduled
     it — the panel would keep closing under a user who had just pinned it. */
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const scheduleOpen = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  }, []);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (pinnedRef.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const tick = () => {
      if (pinnedRef.current) {
        closeTimer.current = null;
        return;
      }
      if (hasSelectionInside(panelRef.current)) {
        /* Behaviour 3. Re-arm rather than close: the user is mid-selection, and
           a panel that vanishes at this exact moment destroys the selection it
           was opened to provide. */
        closeTimer.current = setTimeout(tick, CLOSE_GRACE_MS);
        return;
      }
      closeTimer.current = null;
      setOpen(false);
    };
    closeTimer.current = setTimeout(tick, CLOSE_GRACE_MS);
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    setPinned(false);
    setOpen(false);
  }, [clearTimers]);

  const togglePin = useCallback(() => {
    clearTimers();
    if (pinnedRef.current) {
      setPinned(false);
      setOpen(false);
      return;
    }
    setPinned(true);
    setOpen(true);
  }, [clearTimers]);

  /* Touch has no hover: a `pointerenter` from a finger would open the panel on
     the way to a tap and then leave it orphaned. Tap-to-pin serves touch. */
  const hoverOpen = (e: { pointerType?: string }) => {
    if (e.pointerType === 'touch') return;
    scheduleOpen();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        /* Radix reports Escape and outside-click here. Both are explicit
           dismissals, so they must also drop the pin — a pinned panel that
           "closed" but stayed pinned would refuse to reopen on hover. */
        if (!next) dismiss();
        else setOpen(true);
      }}
      anchor={
        <span
          ref={anchorRef}
          data-testid={testId}
          data-hover-detail-open={open ? 'true' : 'false'}
          data-hover-detail-pinned={pinned ? 'true' : 'false'}
          tabIndex={0}
          role="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          /* NOT `display: contents`, however tempting for a pure wrapper: Radix
             positions against this element's bounding rect, and a `contents`
             box has none — the panel would anchor at 0,0. Inline keeps the rect
             tight to the text, which is where you want the panel to point. */
          style={{ cursor: 'help' }}
          onPointerEnter={hoverOpen}
          onPointerLeave={scheduleClose}
          onFocus={() => setOpen(true)}
          onBlur={scheduleClose}
          onClick={togglePin}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              togglePin();
            }
          }}
        >
          {children}
        </span>
      }
      /* Without this, the very row the panel belongs to counts as "outside" and
         a click on it would dismiss instead of pin (an Anchor gets none of the
         exemption Radix grants a Trigger). */
      keepOpenWithin={anchorRef}
      side={side}
      align={align}
      ariaLabel={ariaLabel}
      contentStyle={{ padding: 0, background: 'transparent', border: 'none' }}
    >
      <div
        ref={panelRef}
        className="pc-hover-detail"
        data-testid={testId ? `${testId}-panel` : undefined}
        style={PANEL_STYLE}
        onPointerEnter={() => {
          if (closeTimer.current) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
          }
        }}
        onPointerLeave={scheduleClose}
      >
        {header || pinned ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              marginBottom: 6,
              userSelect: 'text',
            }}
          >
            <span style={{ flex: 1, minWidth: 0, opacity: 0.85 }}>{header}</span>
            {pinned ? (
              <button
                type="button"
                onClick={dismiss}
                aria-label="Close detail"
                data-testid={testId ? `${testId}-close` : undefined}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  opacity: 0.7,
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
        {detail}
        {!pinned ? (
          <div style={{ marginTop: 6, opacity: 0.45, fontSize: 11, userSelect: 'none' }}>
            click to pin
          </div>
        ) : null}
      </div>
    </Popover>
  );
}
