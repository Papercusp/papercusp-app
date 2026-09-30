'use client';

/**
 * WorkRefPill — renders one work/plan-item reference (WI-1234, EI-42, F-100,
 * P-003) as a small, keyboard-focusable pill with live-state coloring
 * (chat-ref-pills-2026-07-26 P-003).
 *
 * Pure presentational component — no data fetching, no navigation of its
 * own:
 *  - `kind`/`id` use the SAME vocabulary parse-work-refs.ts (P-001) reports
 *    (`WorkRefMatch`), so a caller can spread a match straight into this
 *    component's props with zero translation.
 *  - `state`/`title` are passed in rather than fetched — live hydration via
 *    `@papercusp/sync`'s `useSyncQuery` is P-005's job, one layer up. A
 *    missing/unresolved state renders as the neutral 'unknown' pill (no
 *    special-casing needed by callers still loading or unable to resolve).
 *  - `href`/`onActivate` are both optional and the actual navigation
 *    decision (nuqs param writes onto the Working tab via
 *    resolveInboxDrillIn, P-002/P-004) is entirely the caller's — this
 *    component only renders whichever interactive element the given props
 *    imply and lets native `<a>`/`<button>` keyboard activation (Enter,
 *    and Space for `<button>`) do the rest. With NEITHER prop it renders a
 *    static, non-interactive pill (matches P-006's "no plan context → plain
 *    text, never a guessed link" stance one layer up, and is also just the
 *    right degrade for a pill nobody wired up yet).
 *
 * Styling reuses the harness dashboard's existing status token table
 * (`STATUS` in ../../harness/theme.ts — the same source `StatusPill` /
 * `IssueStatusPill` read in apps/operator/app/harness/primitives.tsx) rather
 * than inventing new colour values: the unified open/wip/blocked/needs-human
 * /done/dropped lifecycle already has DTCG-token-backed solid/bg/text triples
 * plus a built-in neutral-grey fallback for any status not in the table
 * (`STATUS` is a Proxy — indexing with `'unknown'` or any unrecognized
 * string safely returns that neutral fallback, which is exactly the "still
 * loading" / "couldn't resolve" pill this component needs and is why `state`
 * accepts `'unknown'` even though it isn't a real `HarnessStatus` key).
 */
import type { AnchorHTMLAttributes, CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';
import { preloadVditor } from '@/app/_components/MarkdownEditor';
import { STATUS, type HarnessStatus } from '../../harness/theme';
import type { WorkRefKind } from './parse-work-refs';

/**
 * Activating one of these pills opens PlanPopupModal / WorkItemPopupModal, whose
 * body is Vditor-rendered markdown. The chat itself renders with ReactMarkdown
 * and never touches Vditor, so that stack is COLD here — and the sidebar Plans
 * face was, until WI-7088, the only surface that warmed it (PlansPane.tsx). A
 * plan opened from chat therefore paid the whole cold cost on the click, which
 * is the "opening a plan takes several seconds" report.
 *
 * Hover/focus is the precise pre-click signal: it costs nothing when the user
 * never activates the pill, and buys the entire warm window when they do.
 * `preloadVditor` memoizes its promise, so the extra pills on screen — and the
 * repeat hovers — collapse into the one load.
 */
const warmPopupRenderer = () => void preloadVditor();

export interface WorkRefPillProps {
  /** The exact ref token as matched, e.g. "WI-5927", "EI-42", "F-100",
   *  "P-003" — rendered verbatim as the pill's visible text. */
  id: string;
  /** 'work-item' for WI-/EI-/F- ids, 'plan-item' for a P-NNN token — same
   *  vocabulary as parse-work-refs.ts's `WorkRefMatch['kind']`. Not rendered
   *  directly (both kinds share one visual language); kept on the props so a
   *  caller never has to re-derive it from the id's prefix. */
  kind: WorkRefKind;
  /** Lifecycle state driving the pill's color — the unified open/wip/blocked
   *  /needs-human/done/dropped vocabulary. Defaults to 'unknown' (neutral
   *  grey), the correct rendering both before P-005's live hydration
   *  resolves a real state and when the ref can't be resolved at all. */
  state?: HarnessStatus | 'unknown';
  /** The item's title, when known. When present, the pill's accessible name
   *  becomes "`id` — `title`" so a screen reader announces what the ref
   *  actually points to, not just the bare id. Omit while loading/unresolved
   *  — the id alone is still a meaningful accessible name. */
  title?: string | null;
  /** Href for a real link — open-in-new-tab / middle-click / "copy link"
   *  all keep working. Nothing currently passes this: the D-002 seam wires
   *  activation through `onActivate`/`onWorkRefActivate` (P-004 renders the
   *  pill and forwards clicks; P-008's WorkItemPopupModal binds the popup to
   *  that hook) rather than a navigable href, since D-001 (owner re-spec,
   *  2026-07-26) made the destination a popup, not a Working-tab nuqs
   *  navigation. Kept as a real option for a future caller that DOES want a
   *  plain link. Renders an `<a>`. */
  href?: string;
  /** Click/Enter/Space activation handler. Receives the triggering mouse or
   *  keyboard event so the caller can `preventDefault()` an `href` and
   *  perform an in-app nuqs navigation instead of a full page load — this
   *  component takes no position on that; it just forwards the event.
   *  Renders a `<button>` when no `href` is given. */
  onActivate?: (event: ReactMouseEvent<HTMLElement>) => void;
  size?: 'xs' | 'sm';
  className?: string;
}

const SIZE_PX: Record<'xs' | 'sm', { font: number; dot: number; padY: number; padX: number }> = {
  xs: { font: 10, dot: 6, padY: 0, padX: 6 },
  sm: { font: 11, dot: 7, padY: 1, padX: 8 },
};

/** Build the pill's inline style from its resolved status meta + size — same
 *  small-chip recipe `ChipPill` uses in ../../harness/primitives.tsx (tinted
 *  rounded-full background, bold-ish text in the status color), reproduced
 *  here rather than importing a component that file doesn't export, so this
 *  stays a self-contained, zero-new-color addition. */
function pillStyle(
  meta: { bg: string; text: string },
  size: 'xs' | 'sm',
  interactive: boolean,
): CSSProperties {
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
    color: meta.text,
    background: meta.bg,
    border: 'none',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    cursor: interactive ? 'pointer' : 'default',
  };
}

function PillContent({ id, dotColor, dotSize }: { id: string; dotColor: string; dotSize: number }) {
  return (
    <>
      <span
        aria-hidden
        style={{ width: dotSize, height: dotSize, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
      />
      <span>{id}</span>
    </>
  );
}

export function WorkRefPill({
  id,
  state = 'unknown',
  title,
  href,
  onActivate,
  size = 'sm',
  className,
}: WorkRefPillProps) {
  // STATUS is a Proxy that falls back to a neutral grey meta for any key not
  // in its table (theme.ts) — including 'unknown' — so this lookup never
  // needs its own special-cased branch. The cast mirrors the same pattern
  // primitives.tsx's IssueStatusPill already uses for its own status prop.
  const meta = STATUS[state as HarnessStatus];
  const dotSize = SIZE_PX[size].dot;
  const accessibleLabel = title ? `${id} — ${title}` : id;

  if (href) {
    const handleClick: AnchorHTMLAttributes<HTMLAnchorElement>['onClick'] = (event) => onActivate?.(event);
    return (
      <Tooltip label={title}>
        <a
          href={href}
          onClick={handleClick}
          onPointerEnter={warmPopupRenderer}
          onFocus={warmPopupRenderer}
          aria-label={accessibleLabel}
          className={className}
          style={pillStyle(meta, size, true)}
        >
          <PillContent id={id} dotColor={meta.solid} dotSize={dotSize} />
        </a>
      </Tooltip>
    );
  }

  if (onActivate) {
    return (
      <Tooltip label={title}>
        <button
          type="button"
          onClick={onActivate}
          onPointerEnter={warmPopupRenderer}
          onFocus={warmPopupRenderer}
          aria-label={accessibleLabel}
          className={className}
          style={pillStyle(meta, size, true)}
        >
          <PillContent id={id} dotColor={meta.solid} dotSize={dotSize} />
        </button>
      </Tooltip>
    );
  }

  // Neither href nor onActivate: a static, non-interactive pill — the right
  // degrade for a ref nobody has wired navigation for yet (mirrors P-006's
  // "no plan context → plain text, never a guessed link" stance).
  return (
    <Tooltip label={title}>
      <span
        aria-label={accessibleLabel}
        className={className}
        style={pillStyle(meta, size, false)}
      >
        <PillContent id={id} dotColor={meta.solid} dotSize={dotSize} />
      </span>
    </Tooltip>
  );
}
