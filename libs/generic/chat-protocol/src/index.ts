/**
 * @papercusp/chat-protocol — the deps-free wire contract for streaming agent chats.
 *
 * One typed SSE event union + the interactive-card protocol, shared across
 * Restart (Scout) and papercusp. Domain-agnostic on purpose: products,
 * broaden-options, etc. are NOT here — consumers extend `ChatEvent` with their
 * own domain events (see Scout's `CopilotSSEEvent`).
 *
 * Pure types + tiny guards; zero runtime deps so a NestJS backend, an Astro/React
 * frontend, and the papercusp operator can all import it without pulling React,
 * zod, or postgres.
 */

export { SayStreamProjector, projectSayText } from './say-stream.js';
import { parseGoalOwnerReportRef, type GoalOwnerReportRefV1 } from './goal-owner-report.js';
export * from './goal-owner-report.js';

/** Tool-call history may retain the original JSON-string representation.
 * Decode the array here; consumers still validate the option fields they use. */
export function decodeCardOptions(value: unknown): unknown[] | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Interactive cards — the model pauses mid-turn, asks the user, resumes.
// (Generalized from papercusp's CardSpec/CardResponse/OpenCardSnapshot.)
// ---------------------------------------------------------------------------

/**
 * `select` is single-choice rendered COMPACT (a dropdown) — same answer shape
 * as `radio`, which renders one full-width row per option. Added with its
 * tooldef twin (libs/generic/tooldef CardPresentation) 2026-07-27: this wire
 * union and that one are structurally coupled (tooldef's OpenCardSnapshot is
 * constrained by this module's), so a kind added to one and not the other is a
 * compile error rather than a silently untransportable card.
 */
export type CardPresentationKind = 'radio' | 'checkbox' | 'text' | 'date' | 'slider' | 'select';

export interface CardOption {
  /** Stable id returned in the response (e.g. "grade_a"). */
  id: string;
  label: string;
  description?: string;
  /** Optional secondary hint text (papercusp wire field; optional for back-compat). */
  hint?: string;
  /** Optional visual emphasis (papercusp wire field; optional for back-compat). */
  style?: 'default' | 'primary' | 'danger';
}

export interface CardPresentation {
  kind: CardPresentationKind;
  /** radio / checkbox choices. */
  options?: CardOption[];
  /** text input placeholder. */
  placeholder?: string;
  /** text only: render a multi-line input (papercusp wire field; optional). */
  multiline?: boolean;
  /**
   * Bounds. `number` for slider; ISO date `string` for the `date` kind
   * (papercusp uses string date bounds — widened for back-compat; consumers
   * that only do slider math read these as numbers).
   */
  min?: number | string;
  max?: number | string;
  step?: number;
  /**
   * radio only: the option set can be answered by voice (papercusp wire field;
   * optional for back-compat). Voice surfaces read the options for spoken answering.
   */
  voiceAnswerable?: boolean;
}

/** A tool-approval card's parts: the call's row title (e.g. `Update(calc.js)`),
 * the question asked about it, and the change itself, shown once. */
export interface CardApproval {
  title: string;
  question: string;
  body: string[];
}

/** What the model asks for via `ask_choice` / `present_card`. */
export interface CardSpec {
  prompt: string;
  /**
   * Visual presentation hint. Optional: a plain prompt (voice / text-only /
   * confirm) may omit it. (papercusp emits presentation-less cards; widened to
   * optional for back-compat — builders that always set it are unaffected.)
   */
  presentation?: CardPresentation;
  /** Plain-text rendering for voice / no-UI clients. */
  fallbackText?: string;
  /**
   * Supporting detail a renderer shows only behind its details toggle, never
   * by default — e.g. a tool approval's raw arguments under its readable
   * prompt. Optional; a renderer without a toggle may ignore it.
   */
  details?: string;
  /**
   * Present on a tool-approval card: its parts, so a renderer can draw a
   * coding CLI's approval block (title row, the change once, the question).
   * `prompt` still carries the same text for renderers that ignore this.
   */
  approval?: CardApproval;
  /** Allow the user to dismiss without answering. */
  allowDecline?: boolean;
  /** Auto-cancel after this many ms (server resolves as `cancel`). */
  timeoutMs?: number;
  /**
   * Optional structured body block rendered between the prompt and the
   * options — the card-system rendering of a `<report>` payload. A card
   * that only *shows* a report (no question) is valid: prompt carries the
   * one-liner, presentation is omitted. See `ReportBlock`.
   */
  report?: ReportBlock;
}

// ---------------------------------------------------------------------------
// Structured report blocks — the one schema for structured status content.
//
// A `ReportBlock` is the card system's structured-body payload: a two-tier
// plan→item status list. It is THE wire shape for the operator's `<report>`
// tag (papercusp), for attention/inbox items that carry structured detail,
// and for any `CardSpec.report` body. One schema, many renderers (desktop
// card, TUI two-tier list) — no parallel structured channels.
// (Lifted from papercusp's operator-converse ParsedReport — see plan
// report-cards-inbox-reconciliation-2026-06-05 D-001.)
// ---------------------------------------------------------------------------

/**
 * One item inside a report plan block. `status` is an optional free string
 * (rendered through a glyph map with a neutral fallback) — known tokens are
 * todo|wip|blocked|done|dropped|passed|failing|needs-human, but an unknown
 * status degrades gracefully rather than dropping the row.
 */
export interface ReportItem {
  /** Item id (e.g. `P-003`, `F-12`), optional. */
  id?: string;
  /** The item's one-line text. Required — an item with no text is dropped. */
  text: string;
  /** Free-string status; mapped to a glyph by the renderer. */
  status?: string;
  /**
   * Optional actionable drill-in pointer for the row — an opaque, renderer-
   * routed reference (e.g. `escalation:<id>`, `wi:<harness>#<id>`,
   * `plan:<slug>`). A card renderer MAY turn it into a link/action that opens
   * or resolves the referenced thing; a text renderer folds it in as a plain
   * suffix. Domain-neutral: the shape/meaning of the ref is the host's, not
   * this package's. (deterministic-status-cards-2026-07-17 P-001 — turns the
   * curator's dead `drill in: <ref>` monospace into a real action.)
   */
  ref?: string;
}

/** One plan (the outer tier) inside a report block. */
export interface ReportPlan {
  /** Plan slug, optional (links the block to a plan). */
  slug?: string;
  /** Plan title / label. Falls back to `slug` when omitted; a block with neither is dropped. */
  title: string;
  /** Free-string status (draft|ready|active|shipped|blocked|…); glyph-mapped. */
  status?: string;
  /** Optional one-line summary shown under the title. */
  summary?: string;
  /** The plan's items (the inner tier). Omitted/empty when the block is just a header. */
  items?: ReportItem[];
}

/** A structured two-tier plan→item status block. */
export interface ReportBlock {
  /** Optional overall heading for the block. */
  title?: string;
  /** Plan blocks; may be empty when an exact GOAL report reference is present. */
  plans: ReportPlan[];
  goalReport?: GoalOwnerReportRefV1;
}

/** Trim + drop empties: a non-blank string, or undefined. */
function reportStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Validate an already-JSON-parsed value into a `ReportBlock`, or null when
 * it's malformed / empty. Defensive — never throws; a bad payload is dropped
 * (callers warn) rather than crashing the turn/render.
 *
 * Shape: `{ title?, plans: [{ slug?, title, status?, summary?, items?: [{ id?, text, status?, ref? }] }] }`.
 * A plan block needs at least a `title` (or `slug` as fallback); an item
 * needs at least `text` (or `id` as fallback). Blocks/items missing both
 * are skipped. Returns null when no valid plan survives.
 */
export function parseReportBlock(value: unknown): ReportBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const goalValue = (value as Record<string, unknown>).goalReport;
  const goalReport = goalValue === undefined ? undefined : parseGoalOwnerReportRef(goalValue);
  if (goalValue !== undefined && !goalReport) return null;
  const rawPlans = (value as { plans?: unknown }).plans;
  if (rawPlans !== undefined && !Array.isArray(rawPlans)) return null;
  if (rawPlans === undefined && !goalReport) return null;

  const plans: ReportPlan[] = [];
  for (const p of (rawPlans ?? []) as unknown[]) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    const slug = reportStr(rec.slug);
    const title = reportStr(rec.title) ?? slug;
    if (!title) continue; // a plan block needs a label

    const items: ReportItem[] = [];
    if (Array.isArray(rec.items)) {
      for (const it of rec.items) {
        if (!it || typeof it !== 'object') continue;
        const irec = it as Record<string, unknown>;
        const id = reportStr(irec.id);
        const text = reportStr(irec.text) ?? id;
        if (!text) continue; // an item needs text
        items.push({ id, text, status: reportStr(irec.status), ref: reportStr(irec.ref) });
      }
    }

    plans.push({
      slug,
      title,
      status: reportStr(rec.status),
      summary: reportStr(rec.summary),
      items: items.length > 0 ? items : undefined,
    });
  }

  if (plans.length === 0 && !goalReport) return null;
  const out: ReportBlock = { plans };
  if (goalReport) out.goalReport = goalReport;
  const topTitle = reportStr((value as Record<string, unknown>).title);
  if (topTitle) out.title = topTitle;
  return out;
}

// ---------------------------------------------------------------------------
// `<ask>` blocks — a durable, owner-directed question any text-producing
// agent can emit inline in its turn output (D-001,
// owner-inbox-single-pane-2026-07-17). Distinct from `CardSpec` /
// `OpenCardSnapshot` (the live, correlated interactive-card channel): `<ask>`
// is a PLAIN-TEXT-EMBEDDABLE fallback that survives even on a client with no
// card system wired up (a Claude Stop-hook, an OMP turn_end capture, a
// transcript watcher). A client that DOES have a card system renders an
// `<ask>` block as an equivalent card; one that doesn't still gets a
// structured, greppable, machine-mirrorable question instead of unstructured
// prose that only a human reading the terminal would ever see.
//
// Wire shape: `<ask>{"question":"…","options":[{"id":"…","label":"…"}],
// "refs":["WI-1234"]}</ask>`, embedded inline in a turn's raw text — the same
// tag-in-turn-text convention as `<report>` (see operator-converse-tags.ts
// REPORT_RE). Unlike `<report>` (whose raw-text tag extraction is
// operator-turn-specific and lives in operator-converse-tags.ts, paired with
// `<say>`/`<spawn>`/etc.), `<ask>` needs the SAME raw-text extraction across
// multiple, unrelated client integrations (Claude hooks, OMP's coord-hook.ts,
// a Codex-side convention) — so the tag-level parser + serializer live here,
// in the shared deps-free package, rather than being re-implemented per
// client.
// ---------------------------------------------------------------------------

/** One offered choice for an `<ask>` block. */
export interface AskOption {
  /** Stable id returned in the reply (e.g. "yes", "opt_a"). Required. */
  id: string;
  label: string;
  description?: string;
}

/**
 * The `<ask>` block payload: a durable, structured question an agent poses
 * to the owner. `options` is omitted for a free-text question. `refs` names
 * ids/paths/urls the question is about (e.g. `WI-1234`, a file path) —
 * carried through as context for the mirrored escalation, not rendered as
 * part of the question text itself.
 */
export interface AskBlock {
  /** The question text. Required — a block with no question is dropped. */
  question: string;
  /** Optional choices the asker offers; omitted for a free-text question. */
  options?: AskOption[];
  /** Optional reference ids/paths/urls the question is about. */
  refs?: string[];
}

/**
 * Validate an already-JSON-parsed value into an `AskBlock`, or null when
 * it's malformed / empty. Defensive — never throws; a bad payload is
 * dropped (callers warn) rather than crashing the turn/render. Mirrors
 * `parseReportBlock`'s contract exactly.
 *
 * Shape: `{ question, options?: [{ id, label?, description? }], refs?: string[] }`.
 * An option needs at least `id` (falls back to `id` for a missing `label`);
 * options missing `id` are skipped. `refs` entries that aren't non-blank
 * strings are dropped.
 */
export function parseAskBlock(value: unknown): AskBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const question = reportStr(rec.question);
  if (!question) return null; // a block needs a question

  let options: AskOption[] | undefined;
  if (Array.isArray(rec.options)) {
    const parsed: AskOption[] = [];
    for (const o of rec.options) {
      if (!o || typeof o !== 'object') continue;
      const orec = o as Record<string, unknown>;
      const id = reportStr(orec.id);
      if (!id) continue; // an option needs a stable id
      const label = reportStr(orec.label) ?? id;
      parsed.push({ id, label, description: reportStr(orec.description) });
    }
    options = parsed.length > 0 ? parsed : undefined;
  }

  let refs: string[] | undefined;
  if (Array.isArray(rec.refs)) {
    const parsed = rec.refs.map((r) => reportStr(r)).filter((r): r is string => r !== undefined);
    refs = parsed.length > 0 ? parsed : undefined;
  }

  const out: AskBlock = { question };
  if (options) out.options = options;
  if (refs) out.refs = refs;
  return out;
}

/**
 * Parse a raw `<ask>` JSON body (the string between the tags) into an
 * `AskBlock`, or null when the JSON itself is malformed. Thin JSON.parse
 * wrapper around `parseAskBlock`, mirroring `parseReportBody`.
 */
export function parseAskBody(jsonBody: string): AskBlock | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonBody);
  } catch {
    return null;
  }
  return parseAskBlock(data);
}

const ASK_TAG_RE = /<ask>([\s\S]*?)<\/ask>/i;

/**
 * Extract + validate the `<ask>{json}</ask>` tag out of a raw turn-output
 * string, or null when no tag is present or its JSON body is malformed /
 * empty. Defensive — never throws. This is the tolerant parser callers
 * (hooks, watchers, hand-rolled hive integrations) reach for directly on
 * unstructured model output, without re-implementing the tag regex.
 */
export function parseAskTag(rawTurnText: string): AskBlock | null {
  const match = ASK_TAG_RE.exec(rawTurnText);
  if (!match) return null;
  return parseAskBody(match[1].trim());
}

/**
 * Serialize an `AskBlock` back into the `<ask>{json}</ask>` wire tag — the
 * inverse of `parseAskTag`. Used by callers that construct a tag
 * programmatically (e.g. a hook mirroring a client-native structured
 * question, like Claude's `AskUserQuestion`, into the `<ask>` convention)
 * rather than emitting raw text by hand.
 */
export function serializeAskTag(block: AskBlock): string {
  return `<ask>${JSON.stringify(block)}</ask>`;
}

/** The card as it appears on the wire (state channel) — a CardSpec plus identity. */
export interface OpenCardSnapshot extends CardSpec {
  correlationId: string;
  /** epoch ms */
  createdAt: number;
  /**
   * The response schema serialized as JSON Schema (papercusp wire field; optional
   * for back-compat). papercusp validates submissions against the source zod
   * schema server-side and ships the JSON-Schema form for renderers.
   */
  dataSchemaJson?: Record<string, unknown>;
}

/**
 * The user's answer, POSTed back out-of-band and correlated by `correlationId`.
 * `value` shape follows the presentation: radio → { optionId }, checkbox →
 * { optionIds }, text → { text }, slider → { value }, date → { date }.
 */
export type CardResponse =
  | { action: 'submit'; correlationId: string; value: Record<string, unknown> }
  | { action: 'decline'; correlationId: string }
  | { action: 'cancel'; correlationId: string };

// ---------------------------------------------------------------------------
// SSE event union — the streamed chat protocol.
// ---------------------------------------------------------------------------

/**
 * Generic, domain-agnostic chat events. Consumers union their own domain events
 * onto this (e.g. `type ScoutEvent = ChatEvent | { type: 'products'; … }`).
 *
 * On the SSE wire the event NAME is the discriminant (`event: delta`) and the
 * `data` line is the JSON of the same object (it MAY repeat `type`); use
 * {@link parseChatEvent} to normalise a received (name, data) pair.
 *
 * Vocabulary is the MEASURED wire (papercup-chat-one-component-one-contract
 * D-008): both papercusp backends (operator:converse and the agent-loop chat
 * engine) and both consumers (the desktop provider, the portal reducer) speak
 * `delta` / `tool_call` / `provenance` / `error` / `done`. The earlier documented
 * names `token` / `tool_start` were emitted and consumed by nothing and were
 * renamed to match the wire, not aliased.
 *
 * Three channels by convention (a complete partition of `ChatEvent['type']`):
 *  - EVENT channel (append-only, replayable): session, delta, tool_call,
 *    tool_result, provenance, done, error
 *  - STATE channel (last-write-wins, NOT replayed as history): card, card_closed, state
 *    — so a reconnect after answering a card never re-prompts.
 *  - TRANSIENT channel (fire-once actions, NOT replayed at all): navigate
 *    — replaying these on reconnect would re-fire the action (re-navigate).
 *
 * Only the EVENT channel is replayable — use {@link isReplayableEvent}. Gating
 * replay on `!isStateChannelEvent(type)` is WRONG: it would replay transient
 * events like `navigate`.
 */
export type ChatEvent =
  | { type: 'session'; sessionId: string }
  /** One streamed text fragment; consumers append `text`. */
  | { type: 'delta'; text: string }
  /**
   * The model invoked a tool. `name` is the canonical catalog name (colon form,
   * e.g. `chat:ask_choice`); `input` is the call's arguments when the emitter
   * has them (the "tool_call detail" the transcript renders); `callId` pairs it
   * with a later `tool_result`.
   */
  | { type: 'tool_call'; name: string; input?: unknown; callId?: string }
  /** The tool returned. `ok:false` marks a tool-level failure the turn survived. */
  | { type: 'tool_result'; name: string; callId?: string; ok?: boolean; summary?: string }
  /**
   * What will ACTUALLY run for this turn — announced before the first model
   * event, and persisted with the turn so a reconnect never rewrites history
   * from today's picker selection. `engine` is the runner (`loop`, `claude-code`,
   * `codex`, `omp`, …), `model` the resolved model spec.
   */
  | { type: 'provenance'; engine: string; model: string; accountRoute?: string | null }
  | { type: 'card'; card: OpenCardSnapshot }
  | { type: 'card_closed'; correlationId: string }
  | { type: 'state'; version: number; snapshot: unknown }
  | {
      type: 'done';
      /** Why the turn ended (`complete`, `aborted`, `max_steps`, …); emitter-defined. */
      stopReason?: string;
      usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; costUsd?: number };
    }
  | { type: 'error'; message: string }
  // Generic page navigation — the assistant asks the client to go to a target
  // (a URL/route; the href is just data, so it's domain-agnostic). Transient
  // action, NOT replayed on reconnect (it would re-navigate). Domain-specific
  // page actions (cart, filters, highlight) stay on the consumer's own event union.
  | { type: 'navigate'; href: string };

export type ChatEventType = ChatEvent['type'];

/** Event-channel types (append-only, safe to replay on reconnect). */
export const EVENT_CHANNEL_TYPES = [
  'session',
  'delta',
  'tool_call',
  'tool_result',
  'provenance',
  'done',
  'error',
] as const;
/** State-channel types (last-write-wins; do NOT replay as history). */
export const STATE_CHANNEL_TYPES = ['card', 'card_closed', 'state'] as const;
/**
 * Transient-channel types — fire-once actions that are NOT replayed at all
 * (replaying would re-fire the action, e.g. re-navigate the client). Distinct
 * from STATE: there is no last value to re-send on reconnect, the event is just
 * dropped from history.
 */
export const TRANSIENT_CHANNEL_TYPES = ['navigate'] as const;

/** True for events that belong on the last-write-wins state channel. */
export function isStateChannelEvent(type: ChatEventType): boolean {
  return (STATE_CHANNEL_TYPES as readonly string[]).includes(type);
}

/**
 * True for events that are safe to replay as history on reconnect — i.e. ONLY
 * the append-only EVENT channel. State events are re-sent as a snapshot (not
 * replayed), and transient events (`navigate`) are never re-sent. This is the
 * correct replay gate; do NOT use `!isStateChannelEvent(type)`, which would
 * wrongly replay transient actions.
 */
export function isReplayableEvent(type: ChatEventType): boolean {
  return (EVENT_CHANNEL_TYPES as readonly string[]).includes(type);
}

const ALL_CHAT_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...EVENT_CHANNEL_TYPES,
  ...STATE_CHANNEL_TYPES,
  ...TRANSIENT_CHANNEL_TYPES,
]);

/** True when `type` names a member of the `ChatEvent` union. */
export function isChatEventType(type: string): type is ChatEventType {
  return ALL_CHAT_EVENT_TYPES.has(type);
}

/**
 * Normalise one received SSE frame into a `ChatEvent`, or null when it is not
 * one. `eventName` is the SSE `event:` line (the discriminant on the wire);
 * `data` is the already-JSON-parsed `data:` payload. A payload that repeats
 * `type` must agree with the event name; a payload without it is stamped. The
 * required field of each member is checked (so a `delta` without `text` is
 * dropped, not rendered as "undefined") — optional detail is passed through.
 * Never throws: a frame nobody chose to render (`heartbeat`, `run-meta`, a
 * consumer's own domain event) is simply null, exactly as the host drops it.
 */
export function parseChatEvent(eventName: string, data: unknown): ChatEvent | null {
  if (!isChatEventType(eventName)) return null;
  const obj: Record<string, unknown> =
    data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  if (typeof obj.type === 'string' && obj.type !== eventName) return null;
  const str = (k: string): string | null => (typeof obj[k] === 'string' ? (obj[k] as string) : null);
  switch (eventName) {
    case 'session': {
      const sessionId = str('sessionId');
      return sessionId === null ? null : { type: 'session', sessionId };
    }
    case 'delta': {
      const text = str('text');
      return text === null ? null : { type: 'delta', text };
    }
    case 'tool_call': {
      const name = str('name');
      if (name === null || !name) return null;
      const callId = str('callId');
      return {
        type: 'tool_call',
        name,
        ...(obj.input !== undefined ? { input: obj.input } : {}),
        ...(callId !== null ? { callId } : {}),
      };
    }
    case 'tool_result': {
      const name = str('name');
      if (name === null || !name) return null;
      const callId = str('callId');
      const summary = str('summary');
      return {
        type: 'tool_result',
        name,
        ...(callId !== null ? { callId } : {}),
        ...(typeof obj.ok === 'boolean' ? { ok: obj.ok } : {}),
        ...(summary !== null ? { summary } : {}),
      };
    }
    case 'provenance': {
      const engine = str('engine');
      const model = str('model');
      if (engine === null || model === null) return null;
      const accountRoute = str('accountRoute');
      return {
        type: 'provenance',
        engine,
        model,
        ...(accountRoute !== null ? { accountRoute } : obj.accountRoute === null ? { accountRoute: null } : {}),
      };
    }
    case 'card': {
      const card = obj.card;
      if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
      const c = card as Record<string, unknown>;
      if (typeof c.correlationId !== 'string' || typeof c.prompt !== 'string') return null;
      return { type: 'card', card: card as OpenCardSnapshot };
    }
    case 'card_closed': {
      const correlationId = str('correlationId');
      return correlationId === null ? null : { type: 'card_closed', correlationId };
    }
    case 'state': {
      const version = typeof obj.version === 'number' ? obj.version : 0;
      return { type: 'state', version, snapshot: obj.snapshot };
    }
    case 'done': {
      const stopReason = str('stopReason');
      const usage =
        obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage)
          ? (obj.usage as Extract<ChatEvent, { type: 'done' }>['usage'])
          : undefined;
      return {
        type: 'done',
        ...(stopReason !== null ? { stopReason } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case 'error': {
      const message = str('message');
      return { type: 'error', message: message ?? 'stream error' };
    }
    case 'navigate': {
      const href = str('href');
      return href === null ? null : { type: 'navigate', href };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Persisted history — the ONE transcript-turn shape both hosts render.
// (papercup-chat-one-component-one-contract D-008 §3.)
// ---------------------------------------------------------------------------

export type ChatTurnRole = 'user' | 'assistant' | 'system';

/**
 * How the turn entered the conversation. `system` marks a system-authored
 * assistant turn (a deterministic status update, never model output).
 */
export type ChatTurnSource = 'text_typed' | 'voice_stt' | 'voice_tts' | 'system';

/**
 * One tool invocation recorded on a persisted turn. A card the model asked
 * through a tool (`chat:ask_choice`) is exactly such an entry, and its answer is
 * `answered` — so "persisted cards in history" needs no second shape: an
 * entry with `answered` renders as the answered card, without it as the tool row.
 * `picks` is the stored form (`option_id`, snake_case): it is the persisted
 * jsonb and is deliberately not re-cased on the wire.
 */
export interface ChatTurnToolCall {
  name: string;
  input?: unknown;
  callId?: string;
  /** Picks array — length 1 for single-select cards, ≥1 for multi. */
  answered?: {
    picks: Array<{ option_id: string; label: string }>;
    /** The user dismissed the card instead of choosing an option. */
    declined?: boolean;
    /** epoch ms */
    at: number;
  };
}

/**
 * A host-resolvable work reference the server found in `text` (so a renderer
 * can hydrate a pill without a round-trip). `kind` is the ref family; `title` /
 * `state` are present only when the host could resolve them — a public host
 * that cannot resolve refs sends none, and the renderer shows plain text.
 */
export interface WorkRefHint {
  ref: string;
  kind: 'WI' | 'P' | 'EI' | 'F';
  title?: string;
  state?: string;
}

/** The `provenance` frame's payload as persisted with a turn. */
export interface ChatTurnProvenance {
  engine: string;
  model: string;
  accountRoute?: string | null;
}

/**
 * One persisted transcript turn — what a history read returns and what the
 * shared component renders on both hosts. `createdAt` is epoch ms (the
 * message timestamp). `report` is the structured status card the turn carried
 * (`<report>` / a deterministic update). `error:true` marks a failure-marker
 * turn (the assistant produced no content; `text` is the message).
 */
export interface ChatTurn {
  id: string;
  /** Monotonic per-conversation sequence, when the store has one. */
  seq?: number;
  role: ChatTurnRole;
  text: string;
  /** epoch ms */
  createdAt: number;
  source?: ChatTurnSource;
  tools?: ChatTurnToolCall[] | null;
  report?: ReportBlock | null;
  provenance?: ChatTurnProvenance | null;
  error?: boolean;
  workRefs?: WorkRefHint[];
  /**
   * Plan context for P-NNN references in this turn. A plan-item id is only
   * meaningful inside its plan, so a renderer must not guess this value from
   * whichever plan the surrounding page happens to show.
   */
  planSlug?: string | null;
}

/** One page of history, oldest first within the page. */
export interface ChatTurnsPage {
  turns: ChatTurn[];
  /** True when at least one turn exists earlier than the lowest seq in `turns`. */
  hasMoreEarlier: boolean;
}

// Use the emitted ESM suffix in source specifiers. TypeScript's NodeNext
// consumers (including the standalone Phone worker) resolve this package's
// source entry directly and reject extensionless relative exports; bundlers
// still map the `.js` specifier to the sibling `.ts` source during a source
// build, while emitted ESM keeps the same specifier unchanged.
export * from './su-session.js';
export * from './voice.js';
