'use client';

/**
 * rail-sections — the collapse/expand contract shared by BOTH session-popup
 * rails (Orders on the left, Activity on the right).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * [owner 2026-08-02] "make sure the sections that get big have a good way to
 * collapse and expand them" — and the complaint the whole popup redesign
 * started from [owner 2026-08-01]: "the coord section and others take up huge
 * vertical space if its a long list, thats bad".
 *
 * Two mechanisms, because "a long section" is two different problems:
 *   ① THE CAP IS A TOGGLE. A section you never read costs one row forever,
 *      and its COUNT stays visible while collapsed — so folding Coord away
 *      never hides the fact that 19 messages arrived.
 *   ② An OPEN section still cannot grow without bound: the rails' stylesheets
 *      cap each section's height and let its body scroll inside its own card,
 *      with the cap pinned. That half is what fixes the complaint for a reader
 *      who never clicks anything, which is the reader who complained.
 *
 * ── Why nuqs, and why ONE param ─────────────────────────────────────────────
 * Repo rule: user-meaningful state goes in the URL, never `useState` — the
 * agent-facing `ui:get_state` / `ui:dispatch` surface reads the URL, so a
 * `useState` toggle is invisible to an agent asked to "collapse the coord
 * section". One comma-joined param rather than one param per section keeps the
 * URL a short scalar (CLAUDE.md: "encode complex selections as a short scalar,
 * never 1KB of JSON") and keeps both rails in one place.
 *
 * Ids are namespaced by rail (`o-` orders, `a-` activity) so the two rails can
 * never collide on a shared name like `facts`.
 */

import { useCallback, useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { ReactNode } from 'react';

/** The one URL param carrying every collapsed section, comma-joined. */
export const RAIL_COLLAPSE_PARAM = 'railClosed';

export interface RailCollapse {
  /** Is this section currently folded? */
  closed: (id: string) => boolean;
  /** Fold it if open, open it if folded. */
  toggle: (id: string) => void;
}

export function useRailCollapse(): RailCollapse {
  const [raw, setRaw] = useQueryState(RAIL_COLLAPSE_PARAM, parseAsString.withDefault(''));

  /* `?? ''` even though `withDefault('')` types this as a plain string: clearing
     the param writes `null`, and a store that hands that value straight back
     (nuqs's own testing adapter, and every suite's hand-rolled useState-backed
     mock) would otherwise throw on `.split` — a crash in the render path of both
     rails, triggered by the ordinary act of re-opening the last folded section.
     The type says it cannot happen; the value says otherwise. */
  const set = useMemo(
    () => new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    [raw],
  );

  const closed = useCallback((id: string) => set.has(id), [set]);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // `null` rather than '' clears the param from the URL entirely once every
      // section is open again — the default state should not leave a tracking
      // crumb behind in a link someone pastes.
      const joined = [...next].join(',');
      void setRaw(joined === '' ? null : joined);
    },
    [set, setRaw],
  );

  return { closed, toggle };
}

/**
 * A CLUSTER label — the unfilled row that groups the framed cards under it by
 * the question they answer.
 *
 * Treatment C3's cheapest piece of hierarchy: it adds no fill, no stroke and no
 * accent, so it cannot compete with the section caps it is grouping. Six cards
 * down a narrow rail otherwise read as six peers, which they are not.
 */
export function RailCluster({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="pc-rail-cluster" data-testid={`rail-cluster-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      {label}
    </p>
  );
}

export interface RailQuietProps {
  /** The section's name — stays visible, so the reader still learns the signal exists. */
  label: string;
  /** What "none" means for THIS section — "none open", "no note written", … */
  none: string;
  testId?: string;
}

/**
 * A SETTLED section, rendered as one dim line instead of a bordered card with a
 * blank in it (plan P-005, Treatment C3's quiet-empty rule).
 *
 * ── The contract, which is the whole point ──────────────────────────────────
 * The frame is what encodes "there is something here". So this render branch is
 * for exactly ONE of the rails' states, and callers must NOT reach for it in the
 * other two — plan D-003's three-state rule (`unavailable` / genuinely-none /
 * `neverWritten` are three different conclusions about an agent's health, and
 * collapsing them is the `unavailableSignals` bug at panel scale):
 *
 *   ✔ genuinely none          → quiet line. Nothing happened; say so quietly.
 *   ✘ couldn't read it        → keep the card + <Unavailable>. "I don't know"
 *                               must never be quieter than "nothing".
 *   ✘ a FINDING about the     → keep the card. A loop running with no carry-note
 *     agent that happens to     is an emptiness that is itself the news, and the
 *     be shaped like empty      quiet branch would file it under "calm".
 *   ✘ anything wearing        → keep the card. `data-attn` means it wants the
 *     data-attn                 reader; a dim line is the opposite of that.
 *
 * Not a <button>: there is nothing to expand. Giving it the cap's affordance
 * would promise a body that does not exist.
 */
export function RailQuiet({ label, none, testId }: RailQuietProps): React.JSX.Element {
  return (
    <p className="pc-rail-quiet" data-testid={testId ?? `rail-quiet-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      <span className="pc-rail-quiet__label">{label}</span>
      <span className="pc-rail-quiet__none">{none}</span>
    </p>
  );
}

export interface RailSectionHeadProps {
  /** Namespaced section id — `o-facts`, `a-coord`. */
  sectionId: string;
  /** The section's name. Stays visible when collapsed; it is the click target. */
  label: string;
  /** The rail's own header class (`pc-orders__h` / `pc-dossier__h`). */
  className: string;
  closed: boolean;
  onToggle: () => void;
  /** Count badge / loading + error notes — rendered inside the cap, so they
   *  survive collapsing. A count you can only see by expanding is not a count. */
  children?: ReactNode;
}

/**
 * A section cap that is also the collapse toggle.
 *
 * `display: block` on the <button> with an inner span doing the layout is not a
 * style choice: WebKitGTK — the Tauri webview, the ONLY shipping target —
 * ignores flex/grid set on a <button> element and falls back to block, stacking
 * the chevron above the label (EI-18135716653974462 / WI-5581). chat-controls.css
 * carries the same note over `.pc-sec-head__btn`.
 *
 * No `title=`: `lint:design-primitives` rejects title-only tooltips on buttons
 * (invisible to keyboard and touch). `aria-expanded` + the label carry it.
 */
export function RailSectionHead({
  sectionId,
  label,
  className,
  closed,
  onToggle,
  children,
}: RailSectionHeadProps): React.JSX.Element {
  return (
    <h4 className={`${className} pc-sec-head`}>
      <button
        type="button"
        className="pc-sec-head__btn"
        onClick={onToggle}
        aria-expanded={!closed}
        aria-label={`${label} — ${closed ? 'expand' : 'collapse'} this section`}
        data-testid={`rail-section-toggle-${sectionId}`}
      >
        <span className="pc-sec-head__inner">
          {/* One glyph that ROTATES rather than two that swap: the control reads
              as one object moving, and there is no reflow as it changes state. */}
          <span className="pc-sec-head__chev" aria-hidden="true">
            ▸
          </span>
          <span className="pc-sec-head__label">{label}</span>
          {children}
        </span>
      </button>
    </h4>
  );
}
