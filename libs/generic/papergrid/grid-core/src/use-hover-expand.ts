'use client';
/**
 * useHoverExpand — shared hover-to-expand row state for grids.
 *
 * Originally inlined in BulkOrderGrid; factored out so any grid can wire
 * hover-expansion with the same open/close debounce semantics. Opens
 * immediately on row mouse-enter or keyboard focus, closes after a short
 * debounce on mouse-leave or blur so the user can cross the row-to-panel
 * gap without flicker. Escape always closes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseHoverExpandOptions {
  /** ms delay before opening on hover (0 = instant). Default 0. */
  openDelayMs?: number;
  /** ms delay before closing after mouse leaves row + panel. Default 180. */
  closeDelayMs?: number;
  /** Escape key closes the expanded row. Default true. */
  escapeCloses?: boolean;
}

export interface HoverExpandHandle<Id extends string | number = string> {
  hoveredId: Id | null;
  expandedId: Id | null;
  /** Wire to the row element: onMouseEnter={() => rowEnter(id)} */
  rowEnter: (id: Id) => void;
  rowLeave: () => void;
  rowFocus: (id: Id) => void;
  rowBlur: () => void;
  /** Wire to the expanded-content wrapper so hovering inside keeps it open. */
  panelEnter: () => void;
  panelLeave: () => void;
  openNow: (id: Id) => void;
  closeNow: () => void;
}

export function useHoverExpand<Id extends string | number = string>(
  opts: UseHoverExpandOptions = {},
): HoverExpandHandle<Id> {
  const { openDelayMs = 0, closeDelayMs = 180, escapeCloses = true } = opts;

  const [hoveredId, setHoveredId] = useState<Id | null>(null);
  const [expandedId, setExpandedId] = useState<Id | null>(null);

  const openRef = useRef<number | null>(null);
  const closeRef = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeRef.current !== null) {
      window.clearTimeout(closeRef.current);
      closeRef.current = null;
    }
  }, []);
  const cancelOpen = useCallback(() => {
    if (openRef.current !== null) {
      window.clearTimeout(openRef.current);
      openRef.current = null;
    }
  }, []);

  const openNow = useCallback((id: Id) => {
    cancelOpen(); cancelClose();
    setExpandedId(id);
  }, [cancelOpen, cancelClose]);

  const closeNow = useCallback(() => {
    cancelOpen(); cancelClose();
    setExpandedId(null);
  }, [cancelOpen, cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeRef.current = window.setTimeout(() => setExpandedId(null), closeDelayMs);
  }, [cancelClose, closeDelayMs]);

  const scheduleOpen = useCallback((id: Id) => {
    cancelClose();
    if (openDelayMs === 0) { cancelOpen(); setExpandedId(id); return; }
    cancelOpen();
    openRef.current = window.setTimeout(() => setExpandedId(id), openDelayMs);
  }, [cancelClose, cancelOpen, openDelayMs]);

  const rowEnter = useCallback((id: Id) => {
    setHoveredId(id);
    scheduleOpen(id);
  }, [scheduleOpen]);

  const rowLeave = useCallback(() => {
    setHoveredId(null);
    cancelOpen();
    scheduleClose();
  }, [cancelOpen, scheduleClose]);

  const rowFocus  = useCallback((id: Id) => { openNow(id); }, [openNow]);
  const rowBlur   = useCallback(() => { scheduleClose(); }, [scheduleClose]);
  const panelEnter = useCallback(() => { cancelClose(); }, [cancelClose]);
  const panelLeave = useCallback(() => { scheduleClose(); }, [scheduleClose]);

  useEffect(() => {
    if (!escapeCloses) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeNow(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escapeCloses, closeNow]);

  useEffect(() => () => { cancelOpen(); cancelClose(); }, [cancelOpen, cancelClose]);

  return {
    hoveredId, expandedId,
    rowEnter, rowLeave, rowFocus, rowBlur,
    panelEnter, panelLeave,
    openNow, closeNow,
  };
}
