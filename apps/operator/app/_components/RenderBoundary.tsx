'use client';

/**
 * RenderBoundary — the per-SECTION and per-ITEM error boundaries the operator's
 * list surfaces lacked (WI-6668, split out of WI-6551).
 *
 * ## Why this exists
 *
 * WI-6551 was a single missing field on a single row (`actions`, dropped by the
 * list feed and dereferenced unguarded). The consequence was wildly out of
 * proportion: React unmounted the subtree and `AdvTabErrorBoundary` replaced the
 * WHOLE HUD tab with "This section hit an error". One malformed row in one list
 * took down the entire surface — the owner saw a dead tab, not a missing button.
 *
 * That specific dereference is fixed. The BLAST-RADIUS property was not: the
 * next unguarded dereference, from any cause, in any section, would still blank
 * the tab. This file fixes the class:
 *
 *   - `SectionBoundary` — a throw inside one column/section degrades THAT
 *     section to a visible, retryable notice; its siblings keep rendering.
 *   - `RowBoundary` — a throw inside one list row degrades THAT row to a compact
 *     placeholder; the rest of the list still renders.
 *
 * ## Visible failure, never silent absence
 *
 * A skipped row is rendered as a placeholder, not dropped. Silently omitting it
 * would make every count on the board a lie (the model counted it; the DOM did
 * not) — the same reasoning behind the HUD's "+N more" note and the
 * empty-assistant-turn notice (hud-open-destinations-and-true-counts P-005): a
 * surface that cannot show you everything has to SAY so.
 *
 * ## Relationship to the boundaries that already exist
 *
 * `RouteErrorBoundary` (whole route), `DefaultRouterErrorComponent` (router) and
 * `AdvTabErrorBoundary` (one /adv tab) are all COARSER than this and all still
 * apply — they are the backstop for a throw outside any section. This is the
 * missing fine grain, deliberately app-generic (no HUD imports, callers supply
 * their own class names) so any list surface can adopt it.
 *
 * ## Cost
 *
 * A boundary is a class component, so it re-renders with its parent. To keep
 * that off the hot path, wrap the boundary INSIDE the `memo()` you already have
 * on the row (`memo(props => <RowBoundary><Card {...props}/></RowBoundary>)`)
 * rather than around it — then a row whose props are unchanged re-renders
 * neither the card nor the boundary, and adopting this costs nothing per commit.
 * WI-6560 (expensive HUD list commits) is why that ordering is spelled out.
 *
 * NOTE: React error boundaries catch errors thrown during RENDER, in lifecycle
 * methods, and in constructors of the tree below them. They do NOT catch errors
 * thrown in event handlers, in async callbacks, or during SSR hydration
 * mismatches. Guard those at the call site as before.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Normalize a thrown value to a one-line message. Non-Error throws are real
 *  (a rejected string, a thrown object) and must not render as "[object Object]". */
export function boundaryMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

interface RenderBoundaryProps {
  children: ReactNode;
  /** What is being isolated ("Needs you", "WI-6668") — shown in the fallback
   *  and in the console line, which is the only signal the caught crash leaves. */
  label: string;
  /** Render the replacement UI. `retry` clears the caught error and re-renders
   *  the children — useful when the cause was transient data. */
  fallback: (ctx: { message: string; retry: () => void; label: string }) => ReactNode;
  /** Console tag, e.g. "hud-section". Defaults to "render-boundary". */
  scope?: string;
  /** Changing this clears a caught error — escape-on-data-change, mirroring
   *  RouteErrorBoundary's escape-on-navigate. Omit for remount-only reset. */
  resetKey?: string | number | null;
}

interface RenderBoundaryState {
  error: unknown;
  componentStack: string | null;
}

/**
 * The generic primitive. Prefer `SectionBoundary` / `RowBoundary` below — they
 * carry the two fallbacks this app actually wants. Use this directly only when
 * you need a different fallback shape.
 */
export class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  state: RenderBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<RenderBoundaryState> {
    return { error };
  }

  componentDidUpdate(prev: RenderBoundaryProps): void {
    if (
      this.state.error !== null &&
      prev.resetKey !== this.props.resetKey &&
      this.props.resetKey !== undefined
    ) {
      this.setState({ error: null, componentStack: null });
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // The surrounding surface SURVIVES a caught crash, so this console line is
    // the only signal it happened — keep it, it is the read_console_messages
    // debug path (same rationale as AdvTabErrorBoundary's).
    // eslint-disable-next-line no-console
    console.error(
      `[${this.props.scope ?? 'render-boundary'}:${this.props.label}] render crashed:`,
      error,
      info.componentStack,
    );
  }

  private retry = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return this.props.fallback({
      message: boundaryMessage(this.state.error),
      retry: this.retry,
      label: this.props.label,
    });
  }
}

/**
 * One SECTION (a board column, a panel) degrades to a retryable notice instead
 * of taking its siblings — and the whole tab — down with it.
 *
 * `className` is the caller's, so this stays surface-agnostic: the HUD passes
 * its column classes and the fallback keeps the grid geometry intact rather
 * than collapsing the row of columns.
 */
export function SectionBoundary({
  children,
  label,
  className,
  resetKey,
  scope = 'section',
}: {
  children: ReactNode;
  label: string;
  className?: string;
  resetKey?: string | number | null;
  scope?: string;
}) {
  return (
    <RenderBoundary
      label={label}
      scope={scope}
      resetKey={resetKey}
      fallback={({ message, retry }) => (
        <section
          className={className}
          role="alert"
          data-testid="section-boundary-error"
          aria-label={`${label} — failed to render`}
        >
          <p className="pc-boundary pc-boundary--section">
            <strong>{label}</strong> couldn’t be displayed.
            <span className="pc-boundary__msg">{message}</span>
            <button type="button" className="pc-boundary__retry" onClick={retry}>
              Try again
            </button>
          </p>
        </section>
      )}
    >
      {children}
    </RenderBoundary>
  );
}

/**
 * One ROW in a list degrades to a compact placeholder instead of blanking the
 * list. The placeholder is deliberately VISIBLE (see the file docblock): a
 * silently dropped row makes the column's count wrong.
 */
export function RowBoundary({
  children,
  label,
  className,
  resetKey,
  scope = 'row',
}: {
  children: ReactNode;
  label: string;
  className?: string;
  resetKey?: string | number | null;
  scope?: string;
}) {
  return (
    <RenderBoundary
      label={label}
      scope={scope}
      resetKey={resetKey}
      fallback={({ message }) => (
        <p
          className={`pc-boundary pc-boundary--row${className ? ` ${className}` : ''}`}
          role="status"
          data-testid="row-boundary-error"
          title={message}
        >
          <span aria-hidden="true">⚠ </span>
          {label} couldn’t be displayed
        </p>
      )}
    >
      {children}
    </RenderBoundary>
  );
}
