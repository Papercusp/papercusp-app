/**
 * Session turn index (chat-popup-turn-rail-2026-08-31 P-001) — the pure
 * derivation behind the conversation popup's TURN RAIL.
 *
 * [owner 2026-08-31] "In our hud tab->sessions tab-> conversation popups its
 * inceedibly annoying to have to scroll up to see prior turns... a turn sidebar
 * on the left, that shows a preview of the users questions, and then you click
 * and it scrolls to the answer(past all the tool calls etc)."
 *
 * A turn in this file is exactly what the reader means by one: one raw session
 * wake (owner or automatic) and everything visible that came back because of
 * it. Generic feeds retain their user-message boundaries. It is derived from
 * the ALREADY RENDERED `ChatMessage[]` — not from the raw timeline.
 *
 *   1. The rail must index what is actually on screen. `session-transcript-mapping`
 *      collapses tool_use into chips and DROPS tool_result/status entirely, and
 *      `mergeSentEchoes` / `mergeConversationProjectionMessages` then append and
 *      interleave more. An index built one layer upstream would address messages
 *      that are not in the list the reader is scrolling.
 *   2. It makes the rail work for any feed shaped like a conversation, not only
 *      the live session stream.
 *
 * ── What a row can honestly say, and what it cannot ─────────────────────────
 * Measured before designing the row (D-006): `ChatToolCall` is `{ name, input?,
 * answered? }` and `TimelineEntry` carries no error field on `tool_result` —
 * which the mapper drops anyway. So there is NO per-turn failure signal in this
 * data, and a red "something went wrong" pip on a rail row would be invented,
 * not derived. It is deliberately absent. What IS real: the question text, its
 * timestamp, the number of tool chips collapsed into the answer, the elapsed
 * time between question and answer when the feed stamps both, and whether the
 * turn has an answer at all.
 */
import type { ChatMessage } from './chat-types';

export interface SessionTurn {
  /** 1-based, as the reader counts them. Stable for a given message array. */
  turn: number;
  /** Visible opening row: owner question, or first reply for a hidden automatic prompt. */
  questionIndex: number;
  /**
   * Index of the message a rail click should land on: the turn's ANSWER.
   *
   * Null when the turn has no answer yet — a still-streaming final turn, or two
   * user messages in a row. The rail renders that state rather than pretending,
   * and `jumpIndex` below falls back to the question so a click is never inert.
   */
  answerIndex: number | null;
  /**
   * Where a click actually goes: `answerIndex` when there is one, else
   * `questionIndex`. Callers should use THIS rather than re-deriving the
   * fallback — landing on the question of an unanswered turn is correct, and is
   * the only case where the rail does not skip the tool chips (there are none
   * to skip yet).
   */
  jumpIndex: number;
  /** The question, trimmed. May be empty — a feed can carry an empty prompt. */
  question: string;
  /** ISO instant of the question, when the feed knows it (`ChatMessage.ts`). */
  askedAt: string | null;
  /** ISO instant of the answer, when known. */
  answeredAt: string | null;
  /**
   * Wall time between question and answer, when BOTH carry a stamp. Null
   * otherwise — never a zero, which would read as an instant reply.
   */
  durationMs: number | null;
  /** Tool chips collapsed into this turn, summed across its assistant messages. */
  toolCount: number;
  /** First message index this turn owns (always `questionIndex`). */
  firstIndex: number;
  /** Last message index this turn owns, inclusive. */
  lastIndex: number;
}

/** A non-empty assistant message is one with text OR a structured report card. */
function isAnswer(m: ChatMessage): boolean {
  return m.role === 'assistant' && (m.content.trim().length > 0 || m.report != null);
}

function parseMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Split a rendered conversation into turns, oldest first.
 *
 * A marked turn opens the first time its explicit identity appears, including
 * an assistant-only row whose machine prompt is hidden. An unmarked user
 * message still opens a boundary for generic feeds and optimistic echoes.
 * Repeated identities never reopen, so a prompt/reply pair is counted once.
 * Messages before the first explicit boundary or unmarked user remain outside
 * the rail as leading partial/projection rows.
 */
export function deriveSessionTurns(messages: readonly ChatMessage[]): SessionTurn[] {
  const boundaries: Array<{ firstIndex: number; identity: ChatMessage['sessionTurn'] | null }> = [];
  const seenSessionTurns = new Set<string>();
  for (let i = 0; i < messages.length; i += 1) {
    const identity = messages[i].sessionTurn;
    if (identity) {
      if (!seenSessionTurns.has(identity.id)) {
        seenSessionTurns.add(identity.id);
        boundaries.push({ firstIndex: i, identity });
      }
      continue;
    }
    if (messages[i].role === 'user') boundaries.push({ firstIndex: i, identity: null });
  }

  const turns: SessionTurn[] = [];
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length; boundaryIndex += 1) {
    const boundary = boundaries[boundaryIndex];
    const i = boundary.firstIndex;
    const end = boundaries[boundaryIndex + 1]?.firstIndex != null
      ? boundaries[boundaryIndex + 1].firstIndex - 1
      : messages.length - 1;

    /* The LAST non-empty assistant message in the range, not the first: a turn
       can emit several (a projection row, an echo, then the real reply), and
       the one the reader is looking for is the final response. */
    let answerIndex: number | null = null;
    let toolCount = 0;
    for (let j = i; j <= end; j += 1) {
      const m = messages[j];
      if (m.role === 'assistant') {
        toolCount += m.tools?.length ?? 0;
        if (isAnswer(m)) answerIndex = j;
      }
    }

    const askedAt = boundary.identity?.startedAt ?? messages[i].ts ?? null;
    const answeredAt = answerIndex == null ? null : (messages[answerIndex].ts ?? null);
    const askedMs = parseMs(askedAt);
    const answeredMs = parseMs(answeredAt);

    turns.push({
      turn: turns.length + 1,
      questionIndex: i,
      answerIndex,
      jumpIndex: answerIndex ?? i,
      question: boundary.identity?.preview ?? messages[i].content.trim(),
      askedAt,
      answeredAt,
      durationMs:
        askedMs != null && answeredMs != null && answeredMs >= askedMs ? answeredMs - askedMs : null,
      toolCount,
      firstIndex: i,
      lastIndex: end,
    });

  }

  return turns;
}

/**
 * Which turn owns a given message index — the reverse binding that turns the
 * rail from a menu into a position indicator (P-005).
 *
 * Returns the turn's position in the array (0-based), or -1 when the index sits
 * before the first question or outside the conversation entirely. -1 is a real
 * answer, not a failure: it means "the reader is above the first turn", and the
 * rail should mark nothing live rather than guess at row 0.
 */
export function turnAtMessageIndex(turns: readonly SessionTurn[], messageIndex: number): number {
  if (messageIndex < 0) return -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (messageIndex >= turns[i].firstIndex) {
      return messageIndex <= turns[i].lastIndex ? i : -1;
    }
  }
  return -1;
}

/**
 * Which turn was RUNNING at a wall-clock instant — the derivation behind the
 * pending-decision card's "see where this was asked ↑" link
 * (session-popup-compaction-and-contrast-2026-08-02 D-007 step 5 / WI-7323).
 *
 * An owner-owed ask (`coord:escalate` / `coord:ask`) is created by a tool call
 * the agent makes INSIDE one of its turns, so the turn whose window contains
 * the item's `occurredAt` IS the turn where it was asked. Nothing on the record
 * itself says so, which is why the bracket is the derivation rather than a
 * lookup: a key census over the live `harness_shared.coord_open_escalations`
 * (269 rows, 2026-09-04) found no session id and no message index in `body`,
 * and `AttentionItem.ref` carries only `msgId` / `conversationId`.
 *
 * Returns the turn's position in the array (0-based), or -1 whenever the
 * instant cannot be placed. -1 is the answer in every uncertain case, on
 * purpose: a link that lands on the WRONG message is worse than no link, and it
 * would look correct in a presence-only check.
 *  - No stamp, or an unparseable one.
 *  - BEFORE the first question: the ask predates this transcript. This is the
 *    ordinary carry-respawn case — an owner id survives a respawn, the
 *    transcript does not — so it must degrade rather than clamp to turn 0.
 *  - AFTER a SETTLED transcript: the session was idle when the ask was made, so
 *    no turn owns it.
 *
 * "Settled" is `answerIndex === null` on the final turn — whether an answer
 * EXISTS — and deliberately not `answeredAt === null`, whether that answer is
 * STAMPED. The two look interchangeable and are not: a feed can deliver a
 * complete, answered turn whose answer carries no `ts` (measured against the
 * popup's own backfill path, 2026-09-04), and reading that as "still streaming"
 * makes the final turn open-ended forever — so an ask filed hours after the
 * session went quiet links to it. `answerIndex` cannot drift that way, because
 * it is derived from the messages rather than from their metadata.
 *
 * Turns with no `askedAt` are skipped rather than guessed at; a feed that
 * stamps nothing yields -1 for every item, which renders no links at all.
 */
export function turnAtInstant(
  turns: readonly SessionTurn[],
  iso: string | null | undefined,
): number {
  const at = parseMs(iso);
  if (at === null) return -1;

  const dated: { index: number; start: number; end: number | null }[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const start = parseMs(turns[i].askedAt);
    if (start === null) continue;
    dated.push({ index: i, start, end: parseMs(turns[i].answeredAt) });
  }
  if (dated.length === 0) return -1;

  if (at < dated[0].start) return -1;
  const last = dated[dated.length - 1];
  // Open-ended only while the final turn genuinely has no answer yet — the live
  // case the link exists for. Otherwise the transcript is settled and cannot own
  // an instant past its own last stamp.
  if (turns[last.index].answerIndex !== null && at > (last.end ?? last.start)) return -1;

  for (let k = dated.length - 1; k >= 0; k -= 1) {
    if (at >= dated[k].start) return dated[k].index;
  }
  return -1;
}

/**
 * Relative size of each turn, 0..1, for the spine density's tick heights
 * (D-003). Scaled against the LARGEST turn in the session rather than an
 * absolute message count, so the shape of the session is legible whether it is
 * seven short turns or one enormous one.
 *
 * Sized by MESSAGE SPAN, not tool count: the tick is a minimap of the scroll
 * the reader is navigating, and what makes a turn long to scroll past is how
 * much transcript it occupies.
 */
export function turnSizeRatios(turns: readonly SessionTurn[]): number[] {
  const spans = turns.map((t) => t.lastIndex - t.firstIndex + 1);
  const max = Math.max(1, ...spans);
  return spans.map((s) => s / max);
}

/** A focus request arriving at the conversation from one of its two sources. */
export interface FocusRequest {
  /** The rail's click. A LIVE user gesture. */
  jumpToIndex?: number | null;
  /** Bumped per click so the same index can be re-requested (D-005). */
  jumpNonce?: number | null;
  /** The search anchor baked into the URL the popup was opened with. */
  focusIndex?: number | null;
  /** Whether this conversation is a projection (no anchor honoured). */
  projection?: boolean;
}

export interface ResolvedFocus {
  railJumpActive: boolean;
  focusIndex: number | null | undefined;
  focusNonce: number | null;
}

/**
 * Which focus request wins (P-003).
 *
 * The rail's jump is a live gesture; the search anchor is a property of the URL
 * and therefore fires once and then STAYS SET for the life of the popup. So the
 * two are not symmetric and cannot be merged — without this precedence the stale
 * anchor re-wins on every commit and the rail appears broken on every click
 * after the first, which is the exact bug D-005's nonce was added to survive.
 *
 * Extracted from SessionChatModal so the rule is testable on its own. It was
 * previously two inline ternaries inside a 2,000-line component, which is why
 * the independent grading (EI-21986741094464185) found it had no coverage at
 * all: nothing could reach it without mounting the whole popup.
 */
export function resolveFocusPrecedence(req: FocusRequest): ResolvedFocus {
  const railJumpActive = typeof req.jumpToIndex === 'number' && req.jumpToIndex >= 0;
  return {
    railJumpActive,
    focusIndex: railJumpActive ? req.jumpToIndex : req.projection ? undefined : req.focusIndex,
    focusNonce: railJumpActive ? (req.jumpNonce ?? null) : null,
  };
}

/** One rendered transcript row, reduced to what the top-index probe reads. */
export interface RenderedRow {
  /** The row's `data-message-index`. */
  index: number;
  /** Its viewport-space top edge, from getBoundingClientRect(). */
  top: number;
}

/**
 * Which message the reader is actually looking at (P-005) — the REVERSE of
 * `resolveFocusPrecedence`, and the property D-003 says separates a position
 * indicator from a menu. A rail that only sends scroll commands is a menu; it
 * becomes a "you are here" marker only because this reports back.
 *
 * The rule: the LAST row whose top edge has passed the probe line. Rows are
 * matched by rect rather than by the virtualizer's `start` offsets because the
 * virtual container is a sibling of the load-earlier block, so virtual
 * coordinates and scrollTop differ by whatever that block occupies; rects need
 * no such correction and cannot go stale against it.
 *
 * When NOTHING has passed the probe the reader is scrolled above the first
 * rendered row, so that row is where they are. That clamp is a real answer, not
 * a fallback — returning -1 there would blank the live marker at the top of
 * every transcript.
 */
export function pickTopMessageIndex(rows: Iterable<RenderedRow>, probeTop: number): number {
  let best = -1;
  let firstRendered = -1;
  for (const row of rows) {
    if (!Number.isFinite(row.index)) continue;
    if (firstRendered < 0 || row.index < firstRendered) firstRendered = row.index;
    if (row.top <= probeTop && row.index > best) best = row.index;
  }
  return best < 0 ? firstRendered : best;
}
