'use client';

/**
 * TwoPaneShell — the shared flush 2-pane frame (a scrolling list column + a
 * flush, full-height detail column) used by the Plans / Inbox / Sessions views
 * (plan: unified-2-pane-shell). Generalized from the Sessions panes.
 *
 * It is rendered as a SINGLE persistent instance inside `.pc-plans__main`, with
 * `list`/`detail` computed per `?view=`. Because the element at that position is
 * always `<TwoPaneShell>` (no key change), React reuses the shell's fibers/DOM
 * across view switches — the frame (scroll containers, borders, the detail
 * surface) never unmounts; only the slot children reconcile. That is the
 * "swap content, not remount the frame" behaviour.
 *
 * The shell owns only column geometry + scroll + the detail surface. The detail
 * content keeps its own `<aside>` (with its own aria-label) and its own toolbar/
 * buttons, so this slot is a plain wrapper `<div>` (no nested landmark).
 */

import './TwoPaneShell.css';

export interface TwoPaneShellProps {
  /** Left column — a scrolling list (roster, inbox lists, plan items). */
  list: React.ReactNode;
  /** Right column — a flush full-height detail pane. The caller supplies the
   *  full content (its own `<aside>` + toolbar/buttons); the shell only provides
   *  the column slot + the flush surface treatment. */
  detail: React.ReactNode;
  /** Extra class on the frame — used for per-view token scoping (e.g.
   *  `pc-twopane--sessions` brightens the text scale for the roster). */
  className?: string;
}

export default function TwoPaneShell({
  list,
  detail,
  className,
}: TwoPaneShellProps): React.JSX.Element {
  return (
    <div className={`pc-twopane${className ? ` ${className}` : ''}`} data-testid="pc-twopane">
      <div className="pc-twopane__list">{list}</div>
      <div className="pc-twopane__detail">{detail}</div>
    </div>
  );
}
