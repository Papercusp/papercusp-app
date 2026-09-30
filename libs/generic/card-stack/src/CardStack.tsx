/**
 * CardStack — a reusable overlapping-deck browser for a group of same-type
 * cards (owner ask 2026-07-19: "stack cards of the same type so that they
 * overlap, and then give a way for the user to navigate through them").
 *
 * The design (owner-refined 2026-07-19, v6 + category accents):
 *   - The ACTIVE card is the RIGHT-MOST; the pile of upcoming cards stacks
 *     left-and-down behind it, each with its REAL content rendered dimmed, so
 *     the deck reads as physical paper. Clicking a stacked card jumps to it.
 *   - The cycle animation is the index-based deck pattern the Motion/Framer
 *     card-stack example uses: every card in the window
 *     [active-1 … active+maxPeek] stays MOUNTED as the SAME element type, and
 *     only its transform/opacity (derived from its distance to the active
 *     index) changes — stepping NEXT flies the top card off to the RIGHT (the
 *     direction of progress) with a tilt + fade while the next card (content
 *     already visible, brightening through the slide) settles in on a slight
 *     spring; PREV flies it back. The deck's height animates between cards.
 *   - Navigation + identity anchor to the DECK (they never remount/flash):
 *     "‹ Prev" / "Next ›" pills straddle the active card's TOP edge, flanking
 *     the centred category badge; ← → keys work when the deck is focused.
 *   - The position indicator sits centred ABOVE the card: small uniform dot
 *     circles (geometry pinned against host tap-target button rules), the
 *     selected one lit with the accent + a glow ring; always rendered, even
 *     for a single-card deck (plain `n of N` beyond 12 cards).
 *   - `accent` (the deck's CATEGORY color) tints the whole chrome via the
 *     `--cs-accent` custom property — card edge, badge, active dot, hovers.
 *
 * Pure CSS transitions, no animation dependency (interaction is click/keys,
 * not drag). Self-styled in the panel idiom (scoped `pc-cardstack__*`) so it
 * drops into both operator (Next) and operator-vite consumers via
 * `@/app/harness`.
 */
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export interface CardStackProps<T> {
  /** The same-type cards to stack, in the order they should be browsed. */
  items: readonly T[];
  /** Stable key per item (layer identity — what makes the deck ANIMATE:
   *  a card keeps its element across steps and only its transform changes). */
  getKey: (item: T, index: number) => string;
  /** The card content for one item. Rendered on every layer in the window —
   *  dimmed + inert on the stacked cards behind the active one. */
  renderCard: (item: T, index: number) => ReactNode;
  /** Optional fuller body shown when the active card is expanded. Omit ⇒ no expand control. */
  renderExpanded?: (item: T, index: number) => ReactNode;
  /** Category badge content (label + count) rendered overlapping the active
   *  card's top edge. Use `pc-cardstack__header-label` / `-count` classes. */
  header?: ReactNode;
  /** Accessible label for the deck region. */
  ariaLabel?: string;
  /** Extra class on the outer wrapper. */
  className?: string;
  /** How many stacked cards to show behind the active one (default 2). */
  maxPeek?: number;
  /**
   * The deck's CATEGORY color (owner ask 2026-07-19d): every deck shows one
   * top-level category, and this accent is applied automatically across the
   * deck chrome — card edge tint, badge, active dot, nav hovers — via the
   * `--cs-accent` custom property. Category-derived, never stack-order-derived.
   * Omit ⇒ the host theme's `--accent`.
   */
  accent?: string;
}

/** Px each stacked card shifts right + down from the one above it. */
const OFFSET = 9;
/** Px the on-card nav pills overhang below the active card's bottom edge. */
const PILL_OVERHANG = 13;

/** SSR-safe layout effect (the operator app can server-render this file). */
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function CardStack<T>({
  items,
  getKey,
  renderCard,
  renderExpanded,
  header,
  ariaLabel,
  className,
  maxPeek = 2,
  accent,
}: CardStackProps<T>) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // The measured height of the ACTIVE card — sizes the deck (layers are
  // absolutely positioned) and pins the stacked cards to the same silhouette.
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const activeElRef = useRef<HTMLDivElement | null>(null);

  const count = items.length;
  // Clamp defensively — `items` can shrink under the cursor on a re-fetch.
  const active = Math.min(index, Math.max(0, count - 1));
  useEffect(() => {
    if (index !== active) setIndex(active);
  }, [index, active]);
  // Collapse the expanded body whenever the cursor moves to another card.
  useEffect(() => {
    setExpanded(false);
  }, [active]);

  const activeKey = count > 0 ? getKey(items[active], active) : "";
  // Measure before paint on every card change, then track content growth
  // (expanded bodies, async text) via ResizeObserver where available.
  useIsoLayoutEffect(() => {
    const el = activeElRef.current;
    if (!el) return;
    const measure = () => setCardHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeKey, expanded]);

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => Math.min(count - 1, Math.max(0, i + delta)));
    },
    [count],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        step(1);
      }
    },
    [step],
  );

  if (count === 0) return null;

  const canExpand = Boolean(renderExpanded);
  const dots = count <= 12;
  const hasNav = count > 1;
  // Constant gutters (deck-shaped, not position-shaped) so the layout never
  // shifts while browsing. The pile grows to the LEFT of the active card
  // (owner ask 2026-07-19: "the forward most card is the right most").
  const gutter = Math.min(maxPeek, count - 1) * OFFSET;
  // Badge + Prev/Next all ride the active card's TOP edge now.
  const topPad = header || hasNav ? 15 : 2;
  const bottomPad = gutter + 3;

  // The mounted layer window: the just-cycled card (d = -1, flying off /
  // waiting to fly back), the active card (d = 0), and the stacked cards
  // behind it (d = 1 … maxPeek). Deepest first so paint order matches even
  // before z-index applies.
  const layers: Array<{ idx: number; d: number }> = [];
  for (let d = Math.min(maxPeek, count - 1 - active); d >= 1; d--) {
    layers.push({ idx: active + d, d });
  }
  if (active > 0) layers.push({ idx: active - 1, d: -1 });
  layers.push({ idx: active, d: 0 });

  return (
    <div
      className={`pc-cardstack${className ? ` ${className}` : ""}`}
      style={accent ? ({ "--cs-accent": accent } as CSSProperties) : undefined}
    >
      {/* The position indicator renders for EVERY deck — a single-card stack
          still shows its one selected dot, so decks read consistently
          (owner ask 2026-07-19). */}
      <div className="pc-cardstack__bar">
        {dots ? (
          <div
            className="pc-cardstack__dots"
            role="tablist"
            aria-label={`Card ${active + 1} of ${count}`}
          >
            {items.map((it, i) => (
              <button
                key={getKey(it, i)}
                type="button"
                role="tab"
                aria-selected={i === active}
                aria-label={`Go to card ${i + 1} of ${count}`}
                className={`pc-cardstack__dot${i === active ? " is-active" : ""}`}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        ) : (
          <span
            className="pc-cardstack__count"
            aria-live="polite"
            aria-label={`Card ${active + 1} of ${count}`}
          >
            {active + 1} <i>of</i> {count}
          </span>
        )}
        {canExpand ? (
          <button
            type="button"
            className="pc-cardstack__expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </div>

      <div
        className="pc-cardstack__deck"
        role="group"
        aria-label={ariaLabel ?? `Card ${active + 1} of ${count}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{
          height:
            cardHeight != null ? topPad + cardHeight + bottomPad : undefined,
        }}
      >
        {layers.map(({ idx, d }) => {
          const it = items[idx];
          const isActive = d === 0;
          const style: CSSProperties = {
            top: topPad,
            left: gutter,
            right: 0,
            zIndex: d === -1 ? 4 : d === 0 ? 3 : 2 - d,
            // The pile grows LEFT-and-down behind the right-most active card;
            // a just-cycled card flies off to the RIGHT (the direction of
            // progress) and flies back in from there on Prev.
            transform:
              d === -1
                ? "translate(45%, -4%) rotate(5deg)"
                : d === 0
                  ? "none"
                  : `translate(${-d * OFFSET}px, ${d * OFFSET}px)`,
            opacity: d === -1 ? 0 : 1,
            // Stacked + exiting layers pin to the active card's silhouette so
            // the pile's edges stay uniform whatever each card's own content
            // height is.
            ...(isActive || cardHeight == null ? {} : { height: cardHeight }),
          };
          return (
            <div
              key={getKey(it, idx)}
              ref={isActive ? activeElRef : undefined}
              className={`pc-cardstack__card${
                isActive ? " is-top" : d === -1 ? " is-exit" : " is-back"
              }`}
              data-depth={d}
              aria-hidden={isActive ? undefined : true}
              title={!isActive && d > 0 ? "Bring this card to the top" : undefined}
              onClick={!isActive && d > 0 ? () => setIndex(idx) : undefined}
              style={style}
            >
              <div className="pc-cardstack__content">
                {isActive && expanded && renderExpanded
                  ? renderExpanded(it, idx)
                  : renderCard(it, idx)}
              </div>
            </div>
          );
        })}

        {/* Badge + Prev/Next anchor to the DECK (every layer shares the same
            top edge), so they never remount — no flash while cards animate
            beneath them. */}
        {header ? (
          <div
            className="pc-cardstack__header"
            style={{
              top: topPad - 12,
              left: `calc(50% + ${gutter / 2}px)`,
            }}
          >
            {header}
          </div>
        ) : null}
        {hasNav ? (
          <>
            <button
              type="button"
              className="pc-cardstack__navpill pc-cardstack__navpill--prev"
              aria-label="Previous card"
              disabled={active === 0}
              onClick={() => step(-1)}
              style={{ top: topPad - PILL_OVERHANG, left: gutter + 10 }}
            >
              <ChevronLeft size={13} aria-hidden />
              <span>Prev</span>
            </button>
            <button
              type="button"
              className="pc-cardstack__navpill pc-cardstack__navpill--next"
              aria-label="Next card"
              disabled={active >= count - 1}
              onClick={() => step(1)}
              style={{ top: topPad - PILL_OVERHANG, right: 10 }}
            >
              <span>Next</span>
              <ChevronRight size={13} aria-hidden />
            </button>
          </>
        ) : null}
      </div>

      <style>{`
      .pc-cardstack { display: flex; flex-direction: column; gap: 5px; }
      /* Centred position indicator (owner ask 2026-07-19). */
      .pc-cardstack__bar { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 12px; padding-inline: 3px; }
      .pc-cardstack__deck {
        position: relative; outline: none; border-radius: 14px;
        transition: height 320ms cubic-bezier(0.2, 0.8, 0.25, 1);
      }
      .pc-cardstack__deck:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 55%, transparent); }

      /* ── The layers — one element per card in the window, transform-driven ── */
      .pc-cardstack__card {
        position: absolute; overflow: hidden;
        border-radius: 13px;
        border: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 22%, var(--border, rgba(125, 211, 252, 0.2)));
        /* OPAQUE base is load-bearing: --bg-2 is a translucent wash in the
           theme, and the stacked layers behind this one carry real content —
           without an opaque floor their text bleeds THROUGH the active card
           (owner screenshot 2026-07-19 16:00). bg-1 floor + bg-2 wash + accent
           tint reproduces the panel surface, fully opaque. */
        background-color: var(--bg-1, #0d151d);
        background-image:
          linear-gradient(168deg,
            color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 8%, transparent) 0%,
            transparent 60%),
          linear-gradient(var(--bg-2, rgba(255, 255, 255, 0.04)),
            var(--bg-2, rgba(255, 255, 255, 0.04)));
        box-shadow: 0 12px 26px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        /* Slight spring overshoot for cards settling INTO place; the exiting
           card overrides with an accelerate-away curve below. */
        transition: transform 340ms cubic-bezier(0.3, 1.16, 0.35, 1), opacity 260ms ease;
      }
      .pc-cardstack__card.is-top { overflow: visible; }
      /* The active card RESPONDS — hover/keyboard focus warms its edge. */
      .pc-cardstack__card.is-top:hover,
      .pc-cardstack__card.is-top:focus-within {
        border-color: color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 45%, var(--border, rgba(125, 211, 252, 0.2)));
      }
      /* Stacked cards sit visibly BEHIND — a touch darker than the top card,
         so the pile has depth even before the dimmed content reads. */
      .pc-cardstack__card.is-back { cursor: pointer; filter: brightness(0.88); }
      /* Pronounced hover (owner ask 2026-07-19): the stacked card lights up,
         its edge goes accent, and it nudges toward the front. The CSS
         translate property composes with the inline transform, so the nudge
         never fights the stack offset. */
      .pc-cardstack__card.is-back:hover {
        filter: brightness(1.35);
        border-color: color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 60%, var(--border, rgba(125, 211, 252, 0.2)));
        translate: 4px 0;
        box-shadow: 0 10px 22px rgba(0, 0, 0, 0.5);
      }
      .pc-cardstack__card.is-exit {
        pointer-events: none;
        transition: transform 300ms cubic-bezier(0.5, 0, 0.75, 0.35), opacity 230ms ease-out;
      }
      /* Consumers' own card boxes render INSIDE this chrome — strip theirs so
         the deck never shows a double border. */
      .pc-cardstack .pc-cardstack__content > * {
        border: none; background: transparent; box-shadow: none;
      }
      /* Stacked cards show their content dimmed under the active card — the
         pile looks like real paper, and the content is ALREADY THERE when the
         card slides up, so nothing pops in. Inert until it is the top card. */
      .pc-cardstack__content { transition: opacity 300ms ease; }
      .pc-cardstack__card:not(.is-top) .pc-cardstack__content { pointer-events: none; }
      .pc-cardstack__card[data-depth="1"] .pc-cardstack__content { opacity: 0.45; }
      .pc-cardstack__card[data-depth="2"] .pc-cardstack__content { opacity: 0.28; }
      .pc-cardstack__card[data-depth="3"] .pc-cardstack__content { opacity: 0.2; }
      @media (prefers-reduced-motion: reduce) {
        .pc-cardstack__deck, .pc-cardstack__card { transition: none; }
      }

      /* ── Category badge, CENTRED on the active card's top edge ─────────── */
      .pc-cardstack__header {
        position: absolute; top: -12px; left: 50%; transform: translateX(-50%); z-index: 5;
        display: inline-flex; align-items: center; gap: 7px;
        max-width: calc(100% - 170px);
        padding: 3px 12px; border-radius: 8px;
        background: var(--bg-1, #0d151d);
        border: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 40%, var(--border, rgba(125, 211, 252, 0.2)));
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
        font-size: 11px; white-space: nowrap;
      }
      .pc-cardstack__header-label {
        font-weight: 700; color: var(--fg, #e7eef5);
        overflow: hidden; text-overflow: ellipsis;
      }
      .pc-cardstack__header-count {
        font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums;
      }

      /* ── On-card Prev / Next pills, straddling the card's TOP edge (owner
            ask 2026-07-19), flanking the centred category badge ───────────── */
      .pc-cardstack__navpill {
        position: absolute; top: ${-PILL_OVERHANG}px; z-index: 6;
        display: inline-flex; align-items: center; gap: 3px;
        height: 26px; padding: 0 11px; border-radius: 999px; cursor: pointer;
        font: inherit; font-size: 11px; font-weight: 700; letter-spacing: 0; /* design lint: no nonzero tracking */
        border: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 42%, var(--border, rgba(125, 211, 252, 0.2)));
        background: var(--bg-1, #0d151d); color: var(--fg-dim, #b9d4e8);
        box-shadow: 0 5px 14px rgba(0, 0, 0, 0.45);
        transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
      }
      .pc-cardstack__navpill--prev { left: 10px; }
      .pc-cardstack__navpill--next { right: 10px; }
      .pc-cardstack__navpill:hover:not(:disabled) {
        color: var(--fg, #e7eef5);
        background: color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 15%, var(--bg-1, #0d151d));
      }
      .pc-cardstack__navpill:disabled { opacity: 0.3; cursor: default; }

      /* ── Position indicator, centred above the card: small UNIFORM circles,
            the selected one unmistakably lit (owner ask 2026-07-19 — no
            stretched pill, no oversized dots; always shown, even for one). ── */
      .pc-cardstack__dots { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: center; }
      /* Doubled-up selector + explicit min/max: host apps ship tap-target
         rules (button { min-height: … }) that inflate 6px dot buttons into
         tall OVALS (owner screenshot 2026-07-19 19:29). Pin every dimension. */
      .pc-cardstack__dots > .pc-cardstack__dot {
        flex: none; box-sizing: border-box; appearance: none;
        width: 6px; height: 6px;
        min-width: 0; min-height: 0; max-width: 6px; max-height: 6px;
        padding: 0; border: 0; border-radius: 50%; cursor: pointer; line-height: 0;
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4) 40%, transparent);
        transition: background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
      }
      .pc-cardstack__dot:hover { background: var(--fg-mute, #7f9bb4); transform: scale(1.25); }
      .pc-cardstack__dot.is-active {
        background: var(--cs-accent, var(--accent, #7dd3fc));
        box-shadow:
          0 0 0 2px color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 35%, transparent),
          0 0 7px color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 60%, transparent);
      }
      .pc-cardstack__count {
        font-size: 11px; font-variant-numeric: tabular-nums; color: var(--fg-dim, #b9d4e8);
      }
      .pc-cardstack__count i { font-style: normal; color: var(--fg-mute, #7f9bb4); }
      .pc-cardstack__expand {
        margin-left: auto; padding: 2px 10px; border-radius: 999px; cursor: pointer;
        font-size: 10.5px; font-weight: 600;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: none; color: var(--fg-mute, #7f9bb4);
      }
      .pc-cardstack__expand:hover {
        color: var(--fg-dim, #b9d4e8);
        border-color: color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 45%, var(--border));
      }
      `}</style>
    </div>
  );
}
