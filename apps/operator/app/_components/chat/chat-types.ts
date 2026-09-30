/**
 * Chat message/tool-call types — the shape the operator conversation store and the
 * chat cards agree on.
 *
 * These were extracted from the legacy operator transcript renderer so the
 * provider can keep its message shape without keeping that renderer alive.
 */

export interface ChatToolCall {
  /** Display name of the tool the model called. */
  name: string;
  /** Tool input — rendered as a short chip by the surface, if it renders one. */
  input?: unknown;
  /**
   * For interactive tools (e.g. chat:ask_choice), the user's response.
   * When set, the surface should render the answered state.
   * Persisted into operator_turns.tools jsonb (migration 015).
   *
   * Always an array of picks (length 1 for single-select cards,
   * length ≥1 for multi-select). Pre-alpha unified shape — no
   * legacy {option_id, label} variant.
   */
  answered?: {
    picks: Array<{ option_id: string; label: string }>;
    /** True when the user used the card's Skip affordance. */
    declined?: boolean;
    at: number;
  };
}

import type { ReportBlock } from '@papercusp/chat-protocol';

/**
 * Owner-safe identity for one raw session turn.
 *
 * A session turn starts on every transcript prompt, including machine wakes
 * whose prompt body must never be rendered as owner speech. The mapper stamps
 * this same descriptor on every visible message from that raw turn so a
 * downstream navigation surface can recover the real boundary without
 * exposing the hidden prompt. Generic chat messages leave it unset and keep
 * their ordinary user-message grouping.
 */
export interface SessionTurnIdentity {
  /** Stable within one mapped transcript window. */
  id: string;
  /** Whether the raw prompt came from the owner or from session machinery. */
  kind: 'owner' | 'automatic';
  /** Safe rail copy; never contains a hidden machine prompt body. */
  preview: string;
  /** When the raw turn started, when the transcript carried an instant. */
  startedAt?: string;
}

export interface ChatMessage {
  /** Who spoke. Surfaces tint by role. */
  role: 'user' | 'assistant' | 'system';
  /**
   * WHICH agent spoke, when the surface knows (WI-4731 — the owner sees the
   * Papercup mark on every assistant message even when the message is the
   * Mug's or the Kettle's). Drives the per-message avatar: the host maps known
   * cast ids to their canonical marks (mug → Coffee, kettle → Thermometer — the
   * LeftSidebar tab iconography) and falls back
   * to the pane's own icon when absent/unknown. Optional so existing
   * papercup-only feeds are untouched.
   */
  agent?: 'papercup' | 'mug' | 'kettle' | (string & {});
  /** Visible message text. May be empty while the assistant turn is still streaming. */
  content: string;
  /** Optional tool calls to render above the content (chat:ask_choice uses this). */
  tools?: ChatToolCall[];
  /**
   * Structured status CARD for this message (deterministic-status-cards-2026-07-17
   * P-003). Set ONLY for the curator-operator's `source:'system'` status turns —
   * the provider maps `operator_turns.report` onto this field exclusively for
   * system turns, so `report` present ⟺ a curator status card. Rendered in the
   * chat via ReportBlockCard in place of the flattened `content` (gated on
   * FLAGS.CURATOR_STATUS_CARDS). The operator's OWN `<report>` turns (text_typed/
   * voice_tts) still route to the tiered Inbox and do NOT set this field — chat
   * conversation stays conversation (report-cards-inbox-reconciliation D-002); the
   * curator's fleet-status digest is the one deterministic exception, by design.
   */
  report?: ReportBlock;
  /**
   * Stable id for optimistic-write dedup. Set client-side to a uuid
   * when an optimistic local turn is dispatched; once the POST returns,
   * the row's PG id replaces it. A live-tail reconciler skips any
   * incoming row whose id matches an already-loaded message — defeats
   * the race where a push arrives before the POST response (would
   * otherwise double-render the user's own message).
   */
  id?: string;
  /**
   * Operator-side: the per-conversation sequence number from
   * operator_turns.seq. Needed by chat:ask_choice when the user picks
   * an option — the turn-answer endpoint addresses turns by seq. Not
   * set for optimistic local messages before they're persisted.
   */
  seq?: number;
  /**
   * WHEN this message happened — an ISO instant, rendered by the surface as the
   * per-message stamp (session-chat-popup-timestamps-and-modes-2026-08-09 P-001,
   * [owner 2026-08-09] "add timestamp to the user and agent messages in the
   * gui").
   *
   * OPTIONAL, and deliberately so: only a feed that genuinely KNOWS the instant
   * sets it. Session transcripts carry a parser-stamped `ts`; the operator
   * conversation mapper carries its persisted `operator_turns.created_at` and
   * optimistic rows carry their local creation instant until PG returns the
   * authoritative value. A message with no `ts` renders no stamp rather than an
   * invented one. Never default this to "now" at render time: a backfilled
   * transcript would then claim every historical turn happened at page load.
   *
   * NOT validated here. The renderer parses it and declines on an unparseable
   * value, which keeps this type a plain carrier of what the source said.
   */
  ts?: string | null;
  /**
   * The plan this message's content is about, when known
   * (chat-ref-pills-2026-07-26 P-006/P-004). A `P-NNN` plan-item ref is
   * unique only WITHIN a plan, so resolving/hydrating one requires the
   * MESSAGE'S OWN plan context — never a guess. Omit/null when the message
   * carries no plan context; a P-ref then renders as plain, non-navigating
   * text (mirrors resolvePlanItemDrillIn's "no plan context → plain text"
   * contract one layer down).
   */
  planSlug?: string | null;
  /** Raw session-turn boundary metadata; absent on generic chat feeds/echoes. */
  sessionTurn?: SessionTurnIdentity;
}
