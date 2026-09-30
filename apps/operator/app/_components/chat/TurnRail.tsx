'use client';

/**
 * TurnRail — the conversation popup's turn index
 * (chat-popup-turn-rail-2026-08-31 P-002).
 *
 * [owner 2026-08-31] "In our hud tab->sessions tab-> conversation popups its
 * inceedibly annoying to have to scroll up to see prior turns... a turn sidebar
 * on the left, that shows a preview of the users questions, and then you click
 * and it scrolls to the answer(past all the tool calls etc)."
 *
 * So the popup now reads left-to-right as: WHERE you are in the conversation
 * (this) → what they were told (Orders) → the conversation → what they are doing
 * (Activity) → who they are with (Fleet). This rail sits closest to the
 * transcript because it is the only zone that is ABOUT the transcript; the other
 * three are about the agent.
 *
 * PRESENTATIONAL ONLY, like FleetPeersRail beside it. Every rule about what a
 * turn is, which message a click lands on, and which row is live lives in the
 * pure, unit-tested `session-turn-index.ts`. The caller derives because the
 * caller also needs the answer: it owns the jump request and the transcript.
 *
 * ── Two densities, one component (D-003) ────────────────────────────────────
 * `density: 'rail'` is the default — question previews you can read without
 * interacting. `density: 'spine'` is what it becomes when width runs out: a
 * ~40px gutter of ticks sized by how much transcript each turn occupies, with
 * the question one hover or one focus away. The other three rails OVERLAY when
 * they run out of room; this one degrades instead, because an overlay you must
 * open to see where you are defeats the point of a position indicator.
 *
 * ── Why there is no failure pip (D-006) ─────────────────────────────────────
 * The mockups had one. `ChatToolCall` carries no status, `TimelineEntry` carries
 * no error on `tool_result`, and the mapper drops `tool_result` outright — so a
 * pip here would be decoration shaped like evidence. What the row says instead
 * is `no answer yet`, which is derived from the message array and true.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Tooltip } from '../../harness/Tooltip';
import { useChatClock, formatMessageStamp } from './message-timestamp';
import { formatAge } from '../../adv/hud/hud-board-model';
import { turnSizeRatios, type SessionTurn } from './session-turn-index';

export type TurnRailDensity = 'rail' | 'spine';

/** Tick heights for the spine. Floor is a hit target, not an aesthetic: below
 *  ~12px a tick stops being clickable, which is the failure mode the mockup
 *  review flagged for a long session. */
const TICK_MIN_PX = 12;
const TICK_MAX_PX = 44;

/** What a row shows when the question is empty — a real case (a wake with no
 *  prompt text). Rendering an empty row would read as a broken rail. */
const NO_QUESTION = 'no question text';

function tickHeight(ratio: number): number {
  return Math.round(TICK_MIN_PX + ratio * (TICK_MAX_PX - TICK_MIN_PX));
}

/** `2m 10s` → the same vocabulary the HUD uses for every other elapsed time. */
function durationWord(ms: number | null): string | null {
  if (ms == null) return null;
  return formatAge(Math.round(ms / 1000));
}

/**
 * The one-line description of a row, used by BOTH the tooltip and the
 * aria-label so a screen-reader user and a hovering one get the same sentence.
 * It names the DESTINATION, because the visible row is a question and nothing
 * about a question says that pressing it scrolls you to its answer.
 */
function rowDescription(t: SessionTurn, stampIso: string | null): string {
  const q = t.question || NO_QUESTION;
  const where = t.answerIndex == null ? 'no answer yet — jumps to the question' : 'jumps to the answer';
  const when = stampIso ? ` · ${stampIso}` : '';
  const cost = t.toolCount > 0 ? ` · ${t.toolCount} tool call${t.toolCount === 1 ? '' : 's'}` : '';
  return `Turn ${t.turn}: ${q} (${where}${cost}${when})`;
}

function TurnRow({
  turn,
  live,
  nowMs,
  onJump,
}: {
  turn: SessionTurn;
  live: boolean;
  nowMs: number;
  onJump: () => void;
}) {
  const stamp = formatMessageStamp(turn.askedAt, nowMs);
  const duration = durationWord(turn.durationMs);
  const description = rowDescription(turn, stamp?.iso ?? null);

  return (
    <li>
      {/* The shared Tooltip primitive, never a native `title=` — a title is
          unreachable by keyboard and on touch, and lint:design-primitives fails
          one on a <button>. `side="right"` because this rail is the popup's LEFT
          edge; opening left would render off the window. */}
      <Tooltip label={description} side="right">
        <button
          type="button"
          className="pc-turn"
          onClick={onJump}
          data-testid="turn-rail-row"
          data-turn={turn.turn}
          data-live={live ? 'true' : undefined}
          /* aria-current, not aria-selected: the row is not a selection, it is
             where the reader currently IS in the transcript. */
          aria-current={live ? 'true' : undefined}
          aria-label={description}
        >
          <span className="pc-turn__top">
            <span className="pc-turn__n">T{turn.turn}</span>
            {stamp ? (
              <time className="pc-turn__time" dateTime={stamp.iso}>
                {stamp.absolute}
              </time>
            ) : null}
          </span>
          <span className="pc-turn__q" data-empty={turn.question ? undefined : 'true'}>
            {turn.question || NO_QUESTION}
          </span>
          <span className="pc-turn__meta">
            {turn.answerIndex == null ? (
              /* The only state word on the row, and it is derived (D-006): this
                 turn has no answer in the transcript yet. */
              <span className="pc-turn__pending">no answer yet</span>
            ) : null}
            {turn.toolCount > 0 ? <span>{turn.toolCount} tools</span> : null}
            {duration ? <span>{duration}</span> : null}
          </span>
        </button>
      </Tooltip>
    </li>
  );
}

function TurnTick({
  turn,
  ratio,
  live,
  nowMs,
  onJump,
}: {
  turn: SessionTurn;
  ratio: number;
  live: boolean;
  nowMs: number;
  onJump: () => void;
}) {
  const stamp = formatMessageStamp(turn.askedAt, nowMs);
  const description = rowDescription(turn, stamp?.iso ?? null);

  return (
    <li>
      <Tooltip label={description} side="right">
        <button
          type="button"
          className="pc-turn-tick"
          onClick={onJump}
          data-testid="turn-rail-tick"
          data-turn={turn.turn}
          data-live={live ? 'true' : undefined}
          aria-current={live ? 'true' : undefined}
          aria-label={description}
        >
          <span
            className="pc-turn-tick__bar"
            style={{ height: tickHeight(ratio) }}
            aria-hidden="true"
          />
          <span className="pc-turn-tick__n" aria-hidden="true">
            {turn.turn}
          </span>
        </button>
      </Tooltip>
    </li>
  );
}

export default function TurnRail({
  turns,
  liveTurn,
  density = 'rail',
  onJump,
  onClose,
}: {
  /** Derived by the caller from the messages it is rendering. */
  turns: readonly SessionTurn[];
  /**
   * Array position of the turn the reader is currently inside, or -1 for none
   * (the transcript is scrolled above the first question). -1 is a real answer,
   * not a missing one: the rail marks nothing rather than guessing at row 0.
   */
  liveTurn: number;
  density?: TurnRailDensity;
  /** Scroll the transcript to this message index — the turn's ANSWER (D-005). */
  onJump: (messageIndex: number, turnIndex: number) => void;
  onClose: () => void;
}) {
  // Subscribed only so rendered stamps re-paint as the session runs; ordering
  // and content come from the model the caller derived, so this can never
  // disagree with it.
  const nowMs = useChatClock();
  const ratios = useMemo(() => turnSizeRatios(turns), [turns]);
  const listRef = useRef<HTMLDivElement | null>(null);

  /* Keep the live row in view. A "you are here" marker below the fold is not a
     marker — and on a long session the rail is scrolled independently of the
     transcript, so following the reader is the only way the two stay agreed.

     scrollTop is written directly rather than calling scrollIntoView: that
     helper walks EVERY scrollable ancestor, so inside a modal it can move the
     page behind the popup as a side effect. This moves one element and nothing
     else. */
  useEffect(() => {
    const list = listRef.current;
    if (!list || liveTurn < 0) return;
    const row = list.querySelector<HTMLElement>(`[data-turn="${liveTurn + 1}"]`);
    if (!row) return;
    const top = row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = Math.max(0, top - 8);
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight + 8;
    }
  }, [liveTurn, turns]);

  const spine = density === 'spine';

  return (
    <aside
      className={`pc-turns${spine ? ' pc-turns--spine' : ''}`}
      data-testid="turn-rail"
      data-density={density}
      aria-label="Turns in this conversation"
    >
      {/* Mirrors the Orders / Activity / Fleet title bars so the columns read as
          one set. At spine density there is no room for a sentence, so the cap
          shrinks to the count — the accessible name on the <aside> above is what
          still says what the column is. */}
      <header className="pc-zone-title" data-testid="turns-zone-title">
        {spine ? (
          <span className="pc-turns__spine-cap" aria-hidden="true">
            {turns.length}
          </span>
        ) : (
          <>
            <span>Turns</span>
            {/* "you", not "they": every other rail describes the agent, this one
                describes what the READER asked. */}
            <span className="pc-zone-title__sub">— what you asked</span>
            <span className="pc-turns__count">{turns.length}</span>
            <button
              type="button"
              className="pc-zone-title__close"
              onClick={onClose}
              aria-label="Hide the turn rail"
            >
              ✕
            </button>
          </>
        )}
      </header>

      <div className="pc-turns__list" ref={listRef}>
        {turns.length === 0 ? (
          /* Stated rather than rendered as an empty column: a transcript can
             genuinely contain no questions (an agent woken by a loop fire talks
             without being asked), and a blank rail would read as a load failure
             rather than as an accurate answer. Suppressed at spine density,
             where there is no room for a sentence. */
          spine ? null : (
            <p className="pc-turns__empty" data-testid="turn-rail-empty">
              No questions in this session yet.
            </p>
          )
        ) : (
          <ul className="pc-turns__rows">
            {turns.map((t, i) =>
              spine ? (
                <TurnTick
                  key={t.turn}
                  turn={t}
                  ratio={ratios[i] ?? 1}
                  live={i === liveTurn}
                  nowMs={nowMs}
                  onJump={() => onJump(t.jumpIndex, i)}
                />
              ) : (
                <TurnRow
                  key={t.turn}
                  turn={t}
                  live={i === liveTurn}
                  nowMs={nowMs}
                  onJump={() => onJump(t.jumpIndex, i)}
                />
              ),
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}
