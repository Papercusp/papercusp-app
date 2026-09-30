/**
 * picker-kit — the shared Create⇄Conversations visual vocabulary.
 *
 * ONE place that owns the small set of style tokens + presentational primitives
 * the two surfaces both reach for, so they look IDENTICAL:
 *   • the Create flow      (apps/operator/app/harness/CreateHarnessPicker.tsx)
 *   • the Conversations tab (apps/operator-vite/src/components/adv/AdvConversationsTab.tsx)
 *
 * The token values are lifted VERBATIM from CreateHarnessPicker's inline styles
 * (inputStyle, the primary/secondary submit buttons, the ~12px uppercase dim
 * section header, the 2-col card, the callout box), and every primitive uses the
 * same CSS custom properties (var(--bg-2), var(--accent), var(--border),
 * var(--fg), var(--fg-dim), var(--fg-mute), var(--bad), var(--accent-ink,
 * #051827) …) so a consumer in either app renders the same look under one theme.
 *
 * CONSTRAINT: operator-vite must be able to import this — so NO operator-vite or
 * Next-specific imports here, only React + plain DOM primitives. Every component
 * is small, presentational, and accepts `style` / `className` passthrough.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';

// ── Style tokens (lifted verbatim from CreateHarnessPicker) ─────────────────

/** Text/textarea/select-trigger input. (CreateHarnessPicker `inputStyle`.) */
export const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '7px 10px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 5,
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
};

/** Accent-filled submit/confirm button. (CreateHarnessPicker SubmitRow submit.) */
export const primaryBtnStyle: CSSProperties = {
  padding: '7px 16px',
  fontSize: 13,
  background: 'var(--accent)',
  border: '1px solid var(--accent)',
  color: 'var(--accent-ink, #051827)',
  borderRadius: 5,
  cursor: 'pointer',
  fontWeight: 600,
};

/** Bordered transparent cancel/back button. (CreateHarnessPicker SubmitRow cancel.) */
export const secondaryBtnStyle: CSSProperties = {
  padding: '7px 14px',
  fontSize: 13,
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--fg-dim)',
  borderRadius: 5,
  cursor: 'pointer',
};

/** ~12px uppercase dim section heading. (CreateHarnessPicker section <h3>.) */
export const sectionHeaderStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
};

/** The selectable 2-col-grid card. (CreateHarnessPicker `cardStyle`.) */
export const cardStyle: CSSProperties = {
  textAlign: 'left',
  padding: 16,
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  cursor: 'pointer',
  position: 'relative',
  transition: 'border-color 0.1s',
  display: 'block',
  textDecoration: 'none',
};

/** The dim explainer/callout box. (CreateHarnessPicker entry-explainer box.) */
export const calloutStyle: CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 12.5,
  lineHeight: 1.5,
  color: 'var(--fg-dim)',
};

// ── Debounce ────────────────────────────────────────────────────────────────

/** The shared debounce window for search/filter inputs across both surfaces. */
export const DEBOUNCE_MS = 300;

/**
 * Returns `value` debounced by `ms`: the latest value after no change for `ms`,
 * so a fast-typed search box only re-queries once it settles. Initial render
 * returns the initial value immediately (no leading delay).
 */
export function useDebouncedValue<T>(value: T, ms: number = DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// ── Friendly API errors ───────────────────────────────────────────────────

/**
 * Map a backend error code → friendly copy, in the style of
 * CreateHarnessPicker's friendlyError (the dest_exists/invalid_path/… switch).
 * Covers the cross-surface common codes; falls back to `raw` then a generic.
 */
export function friendlyApiError(code: string | undefined, raw?: string): string {
  switch (code) {
    case 'rate_limited':
    case 'too_many_requests':
    case '429':
      return 'Too many requests — slow down for a moment and try again.';
    case 'unauthorized':
    case 'unauthenticated':
    case '401':
      return 'You’re not signed in (or your session expired). Sign in and try again.';
    case 'forbidden':
    case '403':
      return 'You don’t have permission to do that.';
    case 'not_found':
    case '404':
      return 'We couldn’t find that — it may have been removed.';
    case 'conflict':
    case 'slug_taken':
    case '409':
      return 'That name is already taken. Choose a different one.';
    case 'network':
    case 'network_error':
      return 'Network error — check your connection and try again.';
    case 'validation':
    case 'invalid':
    case 'bad_request':
    case '400':
      return raw || 'Some of the details look invalid. Check the fields and try again.';
    case 'timeout':
    case '504':
      return 'That took too long and timed out. Try again.';
    case 'server_error':
    case 'internal':
    case '500':
      return 'Something went wrong on our end. Try again in a moment.';
    default:
      return raw || 'An unexpected error occurred.';
  }
}

// ── Presentational primitives ───────────────────────────────────────────────

/** The dim 12px bold field label. (CreateHarnessPicker FieldLabel.) */
export function FieldLabel({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500, ...style }}
    >
      {children}
    </span>
  );
}

/** A small muted hint paragraph under a field. (CreateHarnessPicker HintText.) */
export function HintText({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <p className={className} style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)', ...style }}>
      {children}
    </p>
  );
}

/** A red-tinted error banner. role="alert". (CreateHarnessPicker ErrorBanner.) */
export function ErrorBanner({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={className}
      style={{
        background: 'var(--bad-bg, rgba(255,80,80,0.08))',
        border: '1px solid var(--bad)',
        color: 'var(--bad)',
        borderRadius: 5,
        padding: '8px 12px',
        fontSize: 13,
        marginBottom: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * A centred empty-state placeholder — dashed border, optional icon above a
 * title + dim description + optional action node. Standardises the (currently
 * inconsistent) Conversations-tab empty states under the Create vocabulary.
 */
export function EmptyState({
  icon,
  title,
  desc,
  action,
  style,
  className,
}: {
  /** A pre-built icon element (e.g. a lucide `<Search />`), rendered above the title. */
  icon?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  /** A trailing action node (e.g. a button/link) under the description. */
  action?: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 6,
        minHeight: 120,
        padding: '20px 16px',
        border: '1px dashed var(--border)',
        borderRadius: 8,
        ...style,
      }}
    >
      {icon != null && (
        <span style={{ display: 'flex', color: 'var(--fg-mute)', marginBottom: 2 }} aria-hidden>
          {icon}
        </span>
      )}
      <strong style={{ fontSize: 13, color: 'var(--fg)' }}>{title}</strong>
      {desc != null && (
        <span style={{ fontSize: 12, color: 'var(--fg-dim)', lineHeight: 1.45, maxWidth: 420 }}>{desc}</span>
      )}
      {action != null && <span style={{ marginTop: 6 }}>{action}</span>}
    </div>
  );
}

/**
 * The inline style for a {@link Pill} in a given state. Extracted as a pure
 * function so the token mapping (active = accent bg + dark ink + bold; inactive =
 * var(--bg-2) + dim fg) can be unit-tested directly — jsdom's CSSOM drops `var()`
 * values, so reading them back off a rendered node's `.style` is unreliable in
 * the test environment (jsdom 20's cssstyle stores `var(...)` as `''`).
 */
export function pillStyle(active: boolean, accent: string = 'var(--accent)'): CSSProperties {
  return {
    padding: '4px 10px',
    fontSize: 12.5,
    fontWeight: active ? 600 : 500,
    background: active ? accent : 'var(--bg-2)',
    color: active ? 'var(--accent-ink, #051827)' : 'var(--fg-dim)',
    border: `1px solid ${active ? accent : 'var(--border)'}`,
    borderRadius: 999,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

/**
 * A pill/chip toggle button. Active = accent bg + dark ink text; inactive =
 * var(--bg-2) bg + var(--fg-dim). `accent` overrides the accent colour. Spreads
 * `...rest` onto the <button> (aria-pressed, role, title, etc.). Mirrors the
 * CreateHarnessPicker ForkToggle button look.
 */
export function Pill({
  active,
  accent = 'var(--accent)',
  onClick,
  children,
  style,
  className,
  ...rest
}: {
  active: boolean;
  /** Accent colour override (active bg + active border). Default var(--accent). */
  accent?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'style' | 'className' | 'children'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      style={{ ...pillStyle(active, accent), ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}
