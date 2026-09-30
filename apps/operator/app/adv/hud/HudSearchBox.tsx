'use client';

/**
 * HudSearchBox — the ONE search/filter control every HUD tab renders.
 *
 * [owner 2026-08-10] "all the tabs in the hud should share the same search
 * filter style with the left aligned highlighted search box … do it in a
 * generalized way."
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The HUD had TWO unrelated search inputs and no shared component: the sessions
 * board (HudBoard) rendered the `--hero` treatment (magnifier + accent ring +
 * tinted well), while the goals/plans/items board (HudEntityColumns) rendered a
 * bare `.hud__search`. Two hand-maintained copies of "the search box" is exactly
 * how the two drifted apart in the first place, so the fix is one component both
 * boards call — not a third stylesheet rule applied at four call sites.
 *
 * ⚠ THIS DELIBERATELY REVERSES A PRIOR DECISION, so do not "restore" it. The
 * 2026-08-02 pass that introduced `--hero` gave it to the sessions search ALONE
 * and recorded "the quiet base stays for HudEntityColumns" (see HudBoard.tsx,
 * the comment above its search block). The owner has since asked for the
 * opposite — one shared, highlighted box on every tab. The reasoning behind the
 * original split still holds for the *sessions* box (it searches full
 * transcripts, which earns salience); it simply lost to a stronger consistency
 * requirement. Reintroducing a quiet variant would re-split the two boards.
 *
 * ── Presentational only ─────────────────────────────────────────────────────
 * No state, no query semantics, no debounce. WHAT a query matches is the
 * matcher's job (hud-entity-board.ts); this owns only the control's markup,
 * styling and accessibility, so a change to either concern cannot disturb the
 * other.
 */
import type { ReactNode } from 'react';

export interface HudSearchBoxProps {
  /** Controlled value — the board owns the query state (usually via nuqs). */
  value: string;
  /** Receives the raw input string; the caller decides what to do with it. */
  onChange: (next: string) => void;
  /**
   * Per-surface placeholder. Deliberately NOT defaulted to one shared string:
   * the owner asked the tabs to share a STYLE, and "Filter plans…" vs "Search
   * transcripts…" is the one honest signal telling you what this particular box
   * will actually look inside of.
   */
  placeholder: string;
  /** Screen-reader label. Required — an unlabelled search box is a bare textbox. */
  ariaLabel: string;
  /** Optional test hook. Omitted ⇒ React drops the attribute entirely. */
  testId?: string;
  /**
   * Optional trailing slot, rendered INSIDE the wrap so it sits within the
   * control rather than after it. The sessions board puts its "still
   * searching…/+N transcripts" live region here; boards whose filtering is
   * purely synchronous pass nothing, and no empty node is rendered.
   */
  status?: ReactNode;
}

export default function HudSearchBox({
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
  status,
}: HudSearchBoxProps) {
  return (
    <span className="hud__searchwrap">
      {/* Inline rather than an icon-font/sprite import: it is eight attributes,
          it inherits currentColor with the input's focus ring, and it must never
          be announced — aria-hidden + focusable="false" (the latter for IE-era
          SVG focus behaviour that Edge still honours in some webviews). */}
      <svg className="hud__search-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.9" />
        <path
          d="M10.3 10.3 L14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
      <input
        type="search"
        className="hud__search hud__search--hero"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
      {status}
    </span>
  );
}
