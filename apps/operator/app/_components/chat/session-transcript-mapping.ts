/**
 * Session transcript → chat-message mapping (owner-inbox-single-pane-2026-07-17
 * P-007) — turns an su/interactive agent's live "thinking" timeline into the
 * `ChatMessage[]` shape `OperatorChat` already renders, with TOOL-NOISE
 * FILTERING: an su transcript is ~90% tool_use/tool_result records, which is
 * unreadable as a "friendly, Papercup-chat-grade" conversation (the owner ask
 * this plan item exists for). This module does NOT re-parse raw transcripts —
 * it reuses the already-built, cross-client (claude/omp/codex), live-followed
 * `TimelineEntry` stream (`/api/adv/session/thinking`,
 * apps/operator/app/harness/AgentThinkingStream.tsx) that already backs
 * AgentInspectorModal's technical/debug view. That view is deliberately raw
 * (cost/tokens/every tool call, for engineers debugging a run); this mapping
 * is the OTHER rendering of the SAME data — collapsed to what an owner wants
 * to read.
 *
 * Filtering rules, per turn (groupEntriesIntoTurns already segments the flat
 * timeline on `prompt` boundaries — one turn = one wake + the agent's response):
 *   - `prompt`      → a user ChatMessage (the owner/wake message that started
 *                     the turn).
 *   - `text`        → joined into the turn's assistant message content (the
 *                     "per-turn final response").
 *   - `tool_use`    → collapsed into a `ChatToolCall` chip (name + input) on
 *                     that same assistant message — OperatorChat already knows
 *                     how to render these compactly (renderOperatorToolChip);
 *                     this is the "collapsed one-line tool summary".
 *   - `tool_result` → DROPPED. This is the actual noise (can be a whole file);
 *                     the paired tool_use chip is enough signal for a chat view
 *                     that isn't debugging the run.
 *   - `status`      → DROPPED (thinking-status chatter, not conversation).
 *   - `result`      → used as a content FALLBACK only when the turn produced
 *                     no `text` entries (covers a client whose only "final
 *                     answer" signal is the turn_end/result record).
 *
 * A turn with neither text nor tool calls produces no assistant message (a
 * pure-status/result-only turn stays invisible — still noise reduction).
 *
 * Every visible row from a prompt-backed turn also carries the same
 * sessionTurn descriptor. That descriptor is the owner-safe bridge between
 * raw prompt boundaries and the rendered turn rail: an owner prompt supplies
 * its visible text, while a machine prompt supplies only the neutral preview
 * "Automatic continuation." The machine body remains hidden.
 */

import type { ChatMessage, ChatToolCall } from './chat-types';
import { groupEntriesIntoTurns, type TimelineEntry } from '../../harness/AgentThinkingStream';
import { ownerVisiblePromptText } from '@papercusp/operator-core/lib/agent-tools/coordination/owner-chat-turn';

/**
 * Map a flat live-thinking timeline into chat messages, oldest-first — the
 * order `OperatorChat`/`PapercupChat` expect.
 *
 * `planSlug` (WI-5997, chat-ref-pills-2026-07-26 P-007 residual): a P-NNN ref
 * pill's destination (D-001's PlanPopupModal) resolves off `ChatMessage.planSlug`
 * — PapercupChat reads it per-message (`turn.planSlug`) — but this mapper
 * never set it, so a real P- ref pill in a live session's chat rendered and
 * hydrated correctly yet silently no-op'd on click (confirmed only via direct
 * `wppop` URL injection, never a real transcript click, during WI-5933's
 * verification). Callers pass the session's roster `currentPlanSlug`, applied
 * UNIFORMLY to every mapped message — an approximation (true per-message
 * historical accuracy would need the plan slug threaded through the raw
 * transcript itself), but the one available today with no new query. Omit the
 * argument entirely (undefined) to leave `planSlug` off the message, same as
 * before this change — only an explicit call site opts in.
 */
export function sessionTimelineToChatMessages(
  entries: readonly TimelineEntry[],
  planSlug?: string | null,
): ChatMessage[] {
  return mapSessionTimeline(entries, planSlug).messages;
}

/** The mapping PLUS the entry→message translation a deep-link needs. */
export interface MappedSessionTranscript {
  messages: ChatMessage[];
  /**
   * Which message a flat-timeline entry index landed in, or -1.
   *
   * The `/api/adv/session/thinking` stream answers a search deep-link with an
   * `anchor` event naming an index into the FLAT entry array it just sent
   * (`session-anchor-window.ts`). This mapper collapses that array — many
   * entries become one message, and `tool_result`/`status` entries become no
   * message at all — so the stream's index is NOT a message index, and using
   * it as one silently scrolls to the wrong turn.
   *
   * Translating here, at the seam that does the collapsing, is what keeps that
   * honest: each store keeps its own indices and the conversion is explicit
   * and testable, rather than the two being assumed interchangeable.
   *
   * EVERY entry of a turn maps to that turn's message, including the dropped
   * ones — anchoring on a `tool_result` should land on the turn that ran the
   * tool, not fail. A turn that produced no message at all (pure status) maps
   * to -1, which the caller reads as "nothing to scroll to".
   */
  messageIndexForEntryIndex(entryIndex: number): number;
}

/**
 * The `ts` field for one mapped message — OMITTED entirely when the source entry
 * carried no timestamp, rather than set to `undefined`/null.
 *
 * Omission is the honest encoding: `ChatMessage.ts` means "the source told us
 * when this happened", and a transcript record without a timestamp did not. The
 * renderer's no-stamp branch is then reached by the field being absent, not by a
 * sentinel every reader has to remember to test. Same shape as `planSlugField`
 * below it, for the same reason.
 */
function tsField(ts: string | undefined): { ts?: string } {
  return ts ? { ts } : {};
}

/**
 * The full mapping. `sessionTimelineToChatMessages` is the messages-only
 * wrapper every existing caller keeps using unchanged.
 */
export function mapSessionTimeline(
  entries: readonly TimelineEntry[],
  planSlug?: string | null,
): MappedSessionTranscript {
  const turns = groupEntriesIntoTurns(entries);
  const messages: ChatMessage[] = [];
  // Entry OBJECT -> its index in the flat input array. groupEntriesIntoTurns
  // regroups the same objects rather than cloning them, which is what makes an
  // identity lookup sound here.
  const entryIndexOf = new Map<TimelineEntry, number>();
  entries.forEach((e, i) => { if (!entryIndexOf.has(e)) entryIndexOf.set(e, i); });
  const entryToMessage = new Map<number, number>();
  const bind = (e: TimelineEntry | null | undefined, messageIdx: number) => {
    if (!e) return;
    const i = entryIndexOf.get(e);
    if (i !== undefined && !entryToMessage.has(i)) entryToMessage.set(i, messageIdx);
  };
  // Only stamp the field when the caller actually passed something (incl.
  // explicit null) — an omitted second arg must produce byte-identical
  // messages to the pre-P-007-residual-fix behavior (existing callers/tests).
  const planSlugField = planSlug !== undefined ? { planSlug } : {};

  for (const turn of turns) {
    const promptText = turn.prompt ? ownerVisiblePromptText(turn.prompt.text ?? '') : '';
    const sessionTurn = turn.prompt
      ? {
          id: 'session-turn-' + turn.seq,
          kind: promptText ? ('owner' as const) : ('automatic' as const),
          preview: promptText || 'Automatic continuation.',
          ...(turn.startTs ? { startedAt: turn.startTs } : {}),
        }
      : null;
    const sessionTurnField = sessionTurn ? { sessionTurn } : {};

    if (turn.prompt) {
      // EI-20130618357432548: a prompt that papercusp INJECTED carries machine
      // annotations the owner never typed — the `⟦turn-origin:…⟧` provenance
      // envelope, and the `⟦owner-chat⟧` note appended to their own chat message.
      // This pane renders the transcript back TO the owner, so those are read as
      // part of the conversation (the reported bug: their "hi" appearing as a wall
      // of wake-pump plumbing). Strip them for display only. It also restores
      // echo absorption in `mergeSentEchoes`, which matches on exact text.
      // EI-20135573616431912 (owner-reported): stripping the annotations is not
      // enough — it removes the ENVELOPE but keeps the BODY, so every machine wake
      // (loop-fire instructions, wake-pump blobs, Stop-hook coaching walls) still
      // rendered here as a message FROM THE OWNER. Measured over 3 days, those are
      // the MAJORITY of this pane's user-role turns: 1756 machine envelopes + 44
      // hook walls vs 1540 genuine owner turns. `ownerVisiblePromptText` keeps only
      // what the human actually authored, keyed on turn PROVENANCE rather than a
      // marker deny-list (which rots, and fails open, every time a wake kind is
      // added). Returning '' makes the existing guard below drop the message.
      if (promptText) {
        messages.push({
          role: 'user',
          content: promptText,
          id: `prompt-${turn.seq}`,
          // The prompt entry's OWN instant — when this message arrived, which is
          // exactly what a user-side stamp should say.
          ...tsField(turn.prompt.ts),
          ...planSlugField,
          ...sessionTurnField,
        });
        bind(turn.prompt, messages.length - 1);
      }
    }

    const textParts: string[] = [];
    const tools: ChatToolCall[] = [];
    let resultText = '';
    /* WHEN the rendered content was produced. Tracked as the LAST timestamped
       entry that actually CONTRIBUTED content (text, or the result fallback) —
       not the turn's first entry and not `endTs`.

       The difference is not cosmetic on this surface. An assistant message here
       is a whole COLLAPSED TURN, which routinely spans minutes of tool calls, so
       the three candidates can be far apart:
         - the turn's START would date the reply to when the agent began working,
           which for a long turn reads as an answer that arrived before it did;
         - `endTs` is the last entry of ANY kind, including the dropped
           tool_result/status noise — so a turn that answered and then kept
           logging would be stamped after its own answer.
       The last content-bearing entry is the instant the reader is actually
       asking about: when this text appeared. */
    let lastTextTs: string | undefined;
    let resultTs: string | undefined;
    for (const e of turn.entries) {
      if (e.kind === 'text') {
        if (e.text) {
          textParts.push(e.text);
          if (e.ts) lastTextTs = e.ts;
        }
      } else if (e.kind === 'tool_use') {
        tools.push({ name: e.toolName ?? 'tool', input: e.toolInput });
      } else if (e.kind === 'result') {
        if (e.text) {
          resultText = e.text;
          if (e.ts) resultTs = e.ts;
        }
      }
      // tool_result / status: intentionally dropped — the tool-noise filter.
    }

    const joinedText = textParts.join('\n\n').trim();
    const content = joinedText || resultText.trim();
    /* Follow the SAME branch the content did. A turn routinely has both a `text`
       stream and a trailing `result` record, and `text` wins the content — so
       tracking one shared "last content entry" would stamp the streamed answer
       with the RESULT's instant, dating the visible text to a record whose own
       text was discarded. Small, but it is the difference between a timestamp
       that describes what you are reading and one that describes something
       else. */
    const contentTs = joinedText ? lastTextTs : resultTs;

    if (content || tools.length > 0) {
      messages.push({
        role: 'assistant',
        content,
        ...(tools.length > 0 ? { tools } : {}),
        id: `turn-${turn.seq}`,
        /* Fall back through the turn's own bounds for a TOOL-ONLY turn (content
           empty, chips present): it has no content-bearing entry to date, but it
           did happen, and `endTs` is the closest honest answer. `startTs` is the
           last resort — a prompt-led turn always has one. */
        ...tsField(contentTs ?? turn.endTs ?? turn.startTs),
        ...planSlugField,
        ...sessionTurnField,
      });
      // Every entry of the turn, INCLUDING the dropped tool_result/status ones
      // (see the interface note) — an anchor on a tool_result must still land
      // on the turn that ran it.
      const assistantIdx = messages.length - 1;
      for (const e of turn.entries) bind(e, assistantIdx);
    }
  }

  return {
    messages,
    messageIndexForEntryIndex: (entryIndex: number) => entryToMessage.get(entryIndex) ?? -1,
  };
}
