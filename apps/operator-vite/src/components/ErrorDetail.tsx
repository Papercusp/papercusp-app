import { useState, type CSSProperties, type ReactNode } from 'react';

/**
 * Console-quality error detail for an error-boundary fallback.
 *
 * Before this (owner report 2026-07-21): the boundary's "Show details" rendered
 * only `String(error.stack)` — React's MINIFIED reconciler frames (`D1 → P1 →
 * Am → …`), which name nothing. The genuinely useful parts the browser CONSOLE
 * shows were dropped on the floor:
 *   - `error.message` — for a minified React error (e.g. #306) this is the ONLY
 *     human-decodable form: "Minified React error #306; visit
 *     https://react.dev/errors/306?args[]=… ". We surface it AND linkify the
 *     react.dev decode URL, so one click gives the real message.
 *   - the React COMPONENT stack (`info.componentStack` from `componentDidCatch`)
 *     — the "occurred in <X>" chain that names the component that actually threw
 *     (captured by every boundary, previously only console.error'd).
 * Plus a one-click Copy of all three for pasting into a bug report.
 *
 * Shared by RouteErrorBoundary, DefaultRouterErrorComponent, and
 * AdvTabErrorBoundary so the three never drift.
 */
export function ErrorDetail({
  error,
  componentStack,
}: {
  error: unknown;
  componentStack?: string | null;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const message = errorMessage(error);
  const stack = errorStack(error);
  const cstack = componentStack?.replace(/^\n+/, '') || '';

  const copyText = [
    message && `Error: ${message}`,
    cstack && `Component stack:\n${cstack}`,
    stack && `Stack:\n${stack}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const onCopy = (): void => {
    try {
      void navigator.clipboard?.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (sandbox / permissions) — the text stays selectable */
    }
  };

  return (
    <div style={WRAP} data-testid="error-detail">
      {message && (
        <div style={MESSAGE} data-testid="error-detail-message">
          {linkify(message)}
        </div>
      )}
      {cstack && (
        <>
          <div style={LABEL}>Component stack</div>
          <pre style={PRE} data-testid="error-detail-component-stack">
            {cstack}
          </pre>
        </>
      )}
      {stack && (
        <>
          <div style={LABEL}>Stack</div>
          <pre style={PRE}>{stack}</pre>
        </>
      )}
      {copyText && (
        <button type="button" style={COPY_BTN} onClick={onCopy} data-testid="error-detail-copy">
          {copied ? 'Copied ✓' : 'Copy error details'}
        </button>
      )}
    </div>
  );
}

/** The message string, robust to Error | string | unknown. */
export function errorMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  const m = (error as { message?: unknown }).message;
  if (typeof m === 'string' && m.length > 0) return m;
  return typeof m === 'undefined' ? '' : String(m);
}

/** The JS stack, or '' when absent (many minified / native errors have none). */
export function errorStack(error: unknown): string {
  const s = (error as { stack?: unknown } | null)?.stack;
  return typeof s === 'string' ? s : '';
}

/** Split a message on http(s) URLs and render each URL as a real link, so a
 *  "visit https://react.dev/errors/306?args[]=…" decode hint is one click from
 *  the actual message. Non-URL text renders verbatim. Exported for tests. */
export function linkify(text: string): ReactNode {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" style={LINK}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}

const WRAP: CSSProperties = { marginTop: 14, display: 'grid', gap: 6 };
const MESSAGE: CSSProperties = {
  padding: 12,
  fontSize: 12.5,
  lineHeight: 1.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--fg, #e7f7ff)',
  background: 'var(--bg-deeper, #060b12)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  userSelect: 'text',
};
const LABEL: CSSProperties = {
  marginTop: 6,
  fontSize: 10.5,
  fontWeight: 600,
  textTransform: 'uppercase',
  color: 'var(--fg-mute, #7f9bb4)',
};
const PRE: CSSProperties = {
  margin: 0,
  padding: 12,
  maxHeight: 200,
  overflow: 'auto',
  fontSize: 11,
  lineHeight: 1.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--fg-mute, #9bb3c7)',
  background: 'var(--bg-deeper, #060b12)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  userSelect: 'text',
};
const LINK: CSSProperties = { color: 'var(--accent, #57d7ff)', wordBreak: 'break-all' };
const COPY_BTN: CSSProperties = {
  justifySelf: 'start',
  marginTop: 4,
  padding: '5px 12px',
  fontSize: 12,
  color: 'var(--fg, #e7f7ff)',
  background: 'transparent',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  cursor: 'pointer',
};
