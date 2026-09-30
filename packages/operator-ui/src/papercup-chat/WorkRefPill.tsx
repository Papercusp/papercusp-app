/**
 * WorkRefPill — the HOST-FREE presentational pill for a WI-/EI-/F-/P- ref in
 * chat prose (papercup-chat-one-component-one-contract-2026-09-06 P-007;
 * parity row `op-work-ref-pill`, whose hydrating wrapper is ./HydratedWorkRefPill).
 *
 * The operator's own `chat/WorkRefPill.tsx` (chat-ref-pills-2026-07-26 P-003)
 * reaches for three app things — the design-system `Tooltip`, the Vditor
 * preload, and the `STATUS` colour table — none of which a portal host has.
 * This pill keeps the same props and the same three renderings (`<a>` for an
 * href, `<button>` for an activation handler, `<span>` for a static pill) and
 * expresses the status colour through CSS custom properties instead:
 *
 *     --pc-chat-status-<state>-solid / -bg / -text
 *
 * with neutral fallbacks, so an unthemed host renders a legible grey pill and
 * the operator (P-009) maps its STATUS table onto the variables once at mount.
 * The title rides on the native `title` attribute; a host that wants its own
 * tooltip wraps the pill.
 */
import type { AnchorHTMLAttributes, CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import type { WorkRefKind } from './parse-work-refs';

/** The unified lifecycle vocabulary both work-items and plan-items share
 *  (open/wip/blocked/needs-human/done/dropped, plus the plan-item `todo`). */
export type WorkRefState = 'open' | 'todo' | 'wip' | 'blocked' | 'needs-human' | 'done' | 'dropped' | 'unknown' | (string & {});

export interface WorkRefPillProps {
  /** The exact ref token as matched, e.g. "WI-5927", "EI-42", "F-100",
   *  "P-003" — rendered verbatim as the pill's visible text. */
  id: string;
  /** 'work-item' for WI-/EI-/F- ids, 'plan-item' for a P-NNN token — same
   *  vocabulary as parse-work-refs.ts's `WorkRefMatch['kind']`. */
  kind: WorkRefKind;
  /** Lifecycle state driving the pill's colour. Defaults to 'unknown' (neutral
   *  grey) — correct both before hydration resolves a real state and when the
   *  ref cannot be resolved at all. */
  state?: WorkRefState;
  /** The item's title, when known. When present the accessible name becomes
   *  "`id` — `title`" and the native tooltip shows it. */
  title?: string | null;
  /** Href for a real link — open-in-new-tab / middle-click / copy-link keep
   *  working. Renders an `<a>`. */
  href?: string;
  /** Click/Enter/Space activation handler. Renders a `<button>` when no
   *  `href` is given; forwarded on the `<a>` otherwise so a caller can
   *  `preventDefault()` and navigate in-app. */
  onActivate?: (event: ReactMouseEvent<HTMLElement>) => void;
  size?: 'xs' | 'sm';
  className?: string;
}

const SIZE_PX: Record<'xs' | 'sm', { font: number; dot: number; padY: number; padX: number }> = {
  xs: { font: 10, dot: 6, padY: 0, padX: 6 },
  sm: { font: 11, dot: 7, padY: 1, padX: 8 },
};

function statusVar(state: string, part: 'solid' | 'bg' | 'text', fallback: string): string {
  const key = state.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `var(--pc-chat-status-${key}-${part}, var(--pc-chat-status-unknown-${part}, ${fallback}))`;
}

function pillStyle(state: string, size: 'xs' | 'sm', interactive: boolean): CSSProperties {
  const s = SIZE_PX[size];
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: `${s.padY}px ${s.padX}px`,
    borderRadius: 999,
    fontSize: s.font,
    fontWeight: 600,
    lineHeight: 1.6,
    fontFamily: 'inherit',
    color: statusVar(state, 'text', '#4b5563'),
    background: statusVar(state, 'bg', 'rgba(107, 114, 128, 0.16)'),
    border: 'none',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    cursor: interactive ? 'pointer' : 'default',
  };
}

function PillContent({ id, state, dotSize }: { id: string; state: string; dotSize: number }) {
  return (
    <>
      <span
        aria-hidden
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: '50%',
          background: statusVar(state, 'solid', '#6b7280'),
          flexShrink: 0,
        }}
      />
      <span>{id}</span>
    </>
  );
}

export function WorkRefPill({
  id,
  kind,
  state = 'unknown',
  title,
  href,
  onActivate,
  size = 'sm',
  className,
}: WorkRefPillProps) {
  const dotSize = SIZE_PX[size].dot;
  const accessibleLabel = title ? `${id} — ${title}` : id;
  const shared = {
    'aria-label': accessibleLabel,
    title: title ?? undefined,
    className,
    'data-ref-kind': kind,
    'data-ref-state': state,
  } as const;

  if (href) {
    const handleClick: AnchorHTMLAttributes<HTMLAnchorElement>['onClick'] = (event) => onActivate?.(event);
    return (
      <a href={href} onClick={handleClick} style={pillStyle(state, size, true)} {...shared}>
        <PillContent id={id} state={state} dotSize={dotSize} />
      </a>
    );
  }

  if (onActivate) {
    return (
      <button type="button" onClick={onActivate} style={pillStyle(state, size, true)} {...shared}>
        <PillContent id={id} state={state} dotSize={dotSize} />
      </button>
    );
  }

  // Neither href nor onActivate: a static, non-interactive pill — the right
  // degrade for a ref nobody has wired navigation for yet.
  return (
    <span style={pillStyle(state, size, false)} {...shared}>
      <PillContent id={id} state={state} dotSize={dotSize} />
    </span>
  );
}
