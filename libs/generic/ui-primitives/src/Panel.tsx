'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';

interface PanelProps {
  title: string;
  count?: number | string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  className?: string;
  /**
   * When true, render a maximize/minimize toggle in the panel header.
   * Maximize portals the panel to document.body and pins it via fixed
   * positioning over the whole viewport. Minimize button + ESC restore it.
   * Defaults to true; pass false on panels that already have a custom
   * fullscreen affordance or shouldn't be maximizable.
   */
  maximizable?: boolean;
}

const PANEL_OVERLAY_ANIM_MS = 220;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function Panel({
  title, count, actions, children, padded, className = '', maximizable = true,
}: PanelProps) {
  const [maximized, setMaximized] = useState(false);
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const openPanel = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    const reducedMotion = prefersReducedMotion();
    setClosing(false);
    setEntered(reducedMotion);
    setMaximized(true);
  }, []);

  const closePanel = useCallback(() => {
    if (!maximized || closing) return;

    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    if (prefersReducedMotion()) {
      setClosing(false);
      setEntered(false);
      setMaximized(false);
      return;
    }

    setClosing(true);
    setEntered(false);
    closeTimerRef.current = window.setTimeout(() => {
      setClosing(false);
      setMaximized(false);
      closeTimerRef.current = null;
    }, PANEL_OVERLAY_ANIM_MS);
  }, [closing, maximized]);

  const toggle = useCallback(() => {
    if (maximized) {
      closePanel();
      return;
    }

    openPanel();
  }, [closePanel, maximized, openPanel]);

  useEffect(() => {
    if (!maximized || prefersReducedMotion()) return;

    setEntered(false);
    const rafId = window.requestAnimationFrame(() => {
      setEntered(true);
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [maximized]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  // ESC closes when maximized.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePanel, maximized]);

  // Lock body scroll while maximized so the underlying page doesn't scroll
  // behind the overlay.
  useEffect(() => {
    if (!maximized || typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [maximized]);

  const head = (
    <div className="h-panel-head">
      <span className="h-panel-title">{title}</span>
      {count !== undefined && <span className="h-panel-count">· {count}</span>}
      {actions && <div className="h-panel-actions">{actions}</div>}
    </div>
  );

  const body = (
    <div className={`h-panel-body${padded ? ' padded' : ''}`}>
      {children}
    </div>
  );

  // Maximize button is positioned absolutely on the panel root rather
  // than inside the head, because some panels (e.g. Feature queue) hide
  // their head via CSS and use an inline toolbar instead. Top-right
  // corner keeps it visible no matter which layout the panel uses.
  const maximizeBtn = maximizable ? (
    <button
      type="button"
      className="h-panel-maximize"
      onClick={toggle}
      aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
      title={maximized ? `Restore (Esc)` : 'Maximize'}
    >
      {maximized ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
    </button>
  ) : null;

  if (maximized && typeof document !== 'undefined') {
    const panelStateClass = closing ? ' is-closing' : entered ? ' is-entered' : '';

    return (
      <>
        {/* Placeholder keeps the grid slot from collapsing while the real panel
            is portaled to document.body. */}
        <div className={`h-panel h-panel-placeholder ${className}`} aria-hidden="true" />
        {createPortal(
          <div
            className={`h-panel h-panel-maximized${panelStateClass} ${className}`}
            role="dialog"
            aria-modal="true"
            aria-label={`${title} (maximized)`}
          >
            {head}
            {body}
            {maximizeBtn}
          </div>,
          document.body
        )}
      </>
    );
  }

  return (
    <div className={`h-panel ${className}`}>
      {head}
      {body}
      {maximizeBtn}
    </div>
  );
}
