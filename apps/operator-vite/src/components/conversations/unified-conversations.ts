/**
 * unified-conversations — the ONE definition of "a conversation", shared by
 * every surface that renders the curated stream.
 *
 * WHY THIS FILE EXISTS (WI-5754): the unified stream was born inside
 * `adv/AdvConversationsTab.tsx` and, while that was the only surface reading
 * it, living there cost nothing. The left rail's Conversations tab
 * (`left-sidebar/ConversationsTab.tsx`) is a SECOND reader of the same three
 * stores, so the composition rules had to move somewhere both can import —
 * otherwise the two panes drift on the questions that matter most and are
 * least visible: which rows count as conversations, which are hidden as system
 * telemetry, and when two rows are "the same conversation".
 *
 * Everything here is PURE (no React, no fetch state) so it is directly
 * unit-testable and carries no chunk weight into either surface. The three
 * `useSyncQuery` reads stay with their components — this module only says what
 * to do with the rows once they arrive.
 *
 * The row TYPES are the wire shapes of the `conversations.*List` sync queries
 * (see packages/operator-core/lib/sync-resolver): Q&A questions, coord-thread
 * deliberations, agent-chat sessions, and agent↔agent coord messages.
 */

// ─── Source row shapes (the `conversations.*List` sync queries) ──────────────

/** `conversations.questionsList` — Q&A questions + discussions. */
export interface ConvRow {
  id: string;
  kind: string;
  state: string;
  scope: string;
  harness_slug: string | null;
  title: string | null;
  asker_id: string;
  topics?: string[];
  promoted_issue_id?: string | null;
  created_ts: string;
  updated_ts?: string;
}

export interface ConvPost {
  id: number;
  author_id: string | null;
  body: string;
  created_ts?: string;
}

/** `conversations.questionDetail`. */
export interface ConvDetailT {
  id: string;
  kind: string;
  state: string;
  scope: string;
  harness_slug?: string | null;
  title: string | null;
  body?: string;
  asker_id?: string;
  accepted_answer?: string | null;
  promoted_issue_id?: string | null;
  topics: string[];
  posts: ConvPost[];
  subscriber_count: number;
}

/** `conversations.deliberationList` — coord:thread / deliberate / vote threads. */
export interface ThreadRow {
  thread_id: string;
  parent_kind: string | null;
  parent_ref: string | null;
  title: string | null;
  created_by: string | null;
  harness_slug: string | null;
  created_at: string;
  last_post_at: string | null;
  post_count: number;
}

export interface ThreadPost {
  id: number;
  author_id: string | null;
  body: string | null;
  created_at: string;
  harness_slug: string | null;
}

/** `conversations.deliberationDetail`. */
export interface DeliberationDetail {
  thread: ThreadRow;
  posts: ThreadPost[];
}

/** `conversations.agentChatList` — multi-turn agent transcripts. */
export interface AgentChatRow {
  id: string;
  harness_slug: string | null;
  role: string | null;
  feature_id: string | null;
  title: string | null;
  created_at: string | number;
  updated_at?: string | number | null;
  archived_at: string | number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  turns: number;
}

export interface AgentChatTurn {
  ts?: string;
  role?: string;
  content?: unknown;
}

/** `conversations.agentChatDetail`. */
export interface AgentChatDetail extends AgentChatRow {
  transcript?: AgentChatTurn[];
}

/**
 * `conversations.agentMessageList` — agent↔agent `coord:send` traffic, the
 * highest-volume conversation type in the system and (until this source) the
 * only one with no curated home at all: it lived solely in the /adv Raw-events
 * firehose, which defaults to `system_only`, i.e. it showed the ~1.6k SYSTEM
 * envelopes and filtered out the ~10.6k AGENT ones (owner, 2026-07-27: "I see
 * agents sending messages to each other all the time but I only see 51 chat
 * messages and 85 decision messages").
 *
 * A row here is a conversation ROOT — an envelope with no `related_msg_id` —
 * carrying its reply-chain count. The root/child model is the one `FeedView`
 * already builds client-side; the resolver does it server-side so a 300px rail
 * never has to load the firehose to find the conversations in it.
 */
/**
 * The authored message fields (unified-agent-state-plane-2026-07-27 P-032/P-033),
 * projected SERVER-SIDE by `projectAuthoredFields` — never unpacked from a raw
 * envelope here. D-064's split is mirrored in the shape: envelope fields once,
 * section fields per section.
 */
export interface AuthoredMessageFields {
  /** ENVELOPE — one per message. */
  expects?: string;
  blocking?: boolean;
  why?: { goalRef: string; note?: string };
  /** D-084: what the sender READ, auto-derived. `versionAtSend` is the ref's
   *  version when the message was SENT — never when it was read. */
  basedOn?: { ref: string; via: string; readAt: string; versionAtSend?: string }[];
  /** PER-SECTION — authored, and genuinely varying between the parts of one message. */
  sections?: {
    text: string;
    /** Already classified server-side (D-026): the KIND decides staleness, and an
     *  unrecognised ref degrades to `opaque` rather than being dropped. */
    premises?: { ref: string; kind: string; invalidatable: boolean }[];
    forYouBecause?: { relation: string; ref?: string; note?: string };
    youMayNotKnow?: { ref: string; provenance?: string }[];
    couldNotDetermine?: { what: string; note?: string }[];
  }[];
  /** D-072 — fields DERIVED (owner-GUI default / machine stamp) rather than authored.
   *  Shown as such so a reader never mistakes a default for the sender's intent. */
  derivedFields?: string[];
}

export interface AgentMessageRow {
  msg_id: string;
  kind: string;
  /** The sending agent id. Never a `system*` actor — the resolver filters those
   *  out server-side, which is what keeps this source curated rather than raw. */
  from: string;
  to: string[];
  summary: string | null;
  /** Long form is returned only for an active server-side search or detail read. */
  body?: string | null;
  harness_slug: string | null;
  plan_slug: string | null;
  /** `intent` / `claim` / `completion` / `finding` / … — a machine-declared
   *  lifecycle beat rather than a hand-written message. Kept so the UI can say
   *  what kind of message this is without re-parsing the body. */
  lifecycle: string | null;
  /** `@fleet:…` / `@plan:…` / `@object:issue:WI-1` selectors the send targeted. */
  audience: string[];
  broadcast: boolean;
  reply_count: number;
  ts: string;
  last_reply_ts: string | null;
  /** Absent on an ordinary message — only a send that actually authored these
   *  carries the block, so a plain message renders exactly as it always did.
   *
   *  ⚠ WI-7240 — DETAIL ONLY. `conversations.agentMessageList` deliberately does
   *  NOT ship this field: it was 43.90% of that payload (188,386 B / 100 rows)
   *  and both `<AuthoredFields>` render sites read their row from
   *  `conversations.agentMessageDetail`. If you need it in a LIST row, fetch the
   *  detail read for that message rather than putting it back on the list — the
   *  server-side projection is shared, so the block is always identical. */
  authored?: AuthoredMessageFields;
}

export interface AgentMessageReply {
  msg_id: string;
  kind: string;
  from: string;
  to: string[];
  summary: string | null;
  body: string | null;
  ts: string;
}

/** `conversations.agentMessageDetail`. */
export interface AgentMessageDetail {
  message: AgentMessageRow;
  replies: AgentMessageReply[];
}

// ─── The unified row ────────────────────────────────────────────────────────

/** The four curated sources. Deliberately NOT the `inbox`/`feed` view ids —
 *  a row always belongs to exactly one materialized store. */
export type ConversationSource = 'threads' | 'deliberations' | 'agentchats' | 'messages';

export interface UnifiedConversationRow {
  /** `${source}:${sourceId}` — stable across list invalidations, so a row that
   *  moves to a new sorted position stays the same DOM node. */
  id: string;
  source: ConversationSource;
  sourceId: string;
  typeLabel: string;
  kind: string;
  state: string;
  title: string;
  preview: string;
  actor?: string;
  recipient?: string;
  harnessSlug?: string | null;
  relatedRef?: string | null;
  /** What `relatedRef` POINTS AT — `issue` (a WI-/EI- work item), `feature`
   *  (a `<harness>#<F-id>` composite), `conversation` (a `conv-…` id), or
   *  `plan`. Carried so a ref can be rendered as a real link to the right
   *  destination instead of dead text (D-005); absent ⇒ render plain. */
  relatedKind?: ConversationRefKind | null;
  count?: number;
  updatedAt: number;
}

/** The human-facing name of each source. Shared so the wide surface's inline
 *  type pill and the rail's stripe label can never disagree about what a
 *  source is called. */
export const SOURCE_LABEL: Record<ConversationSource, string> = {
  threads: 'Questions & discussions',
  deliberations: 'Group decisions',
  agentchats: 'Agent chat',
  messages: 'Agent messages',
};

// ─── Typed references ───────────────────────────────────────────────────────

/**
 * What a conversation's related-ref points at. These are the `parent_kind`
 * values `coord_threads` actually stores (measured 2026-07-27: issue 5,139 ·
 * feature 442 · conversation 163) plus `plan`, which only agent messages carry.
 */
export type ConversationRefKind = 'issue' | 'feature' | 'conversation' | 'plan';

export interface ConversationRef {
  kind: ConversationRefKind;
  ref: string;
}

const REF_KINDS = new Set<string>(['issue', 'feature', 'conversation', 'plan']);

/** Narrow an arbitrary `parent_kind` string to a ref kind we know how to open. */
export function asConversationRefKind(value: string | null | undefined): ConversationRefKind | null {
  const k = (value ?? '').trim().toLowerCase();
  return REF_KINDS.has(k) ? (k as ConversationRefKind) : null;
}

/**
 * A `feature` ref is stored as the composite `<harness>#<F-id>` (e.g.
 * `hive-canary#F-CANARY-20260617`). Split it so a popup can scope its lookup to
 * the OWNING harness — pointing a work-item popup at the wrong harness is the
 * failure `WorkItemPopupModal` explicitly documents. A ref with no `#` keeps the
 * caller's own harness context.
 */
export function splitFeatureRef(ref: string): { harnessSlug: string | null; id: string } {
  const at = ref.indexOf('#');
  return at > 0
    ? { harnessSlug: ref.slice(0, at), id: ref.slice(at + 1) }
    : { harnessSlug: null, id: ref };
}

/**
 * The FIRST openable object an audience selector list points at.
 *
 * `coord:send` addresses by audience selector rather than by a scalar id, so an
 * agent message's "related work" is encoded as `@object:issue:WI-6322` or
 * `@plan:my-plan-2026-07-27`. Selectors that resolve to a live SET of agents
 * (`@fleet:`, `@topic:`, `@file:`, `*`) are not objects you can open, so they
 * yield null rather than a link that goes nowhere.
 */
export function parseAudienceRef(audience: readonly string[] | null | undefined): ConversationRef | null {
  for (const raw of audience ?? []) {
    const sel = (raw ?? '').trim();
    if (sel.startsWith('@object:')) {
      const rest = sel.slice('@object:'.length);
      const at = rest.indexOf(':');
      if (at <= 0) continue;
      const kind = asConversationRefKind(rest.slice(0, at));
      const ref = rest.slice(at + 1).trim();
      if (kind && ref) return { kind, ref };
      continue;
    }
    if (sel.startsWith('@plan:')) {
      const ref = sel.slice('@plan:'.length).trim();
      if (ref) return { kind: 'plan', ref };
    }
  }
  return null;
}

// ─── Normalisation + identity ───────────────────────────────────────────────

export function conversationEpoch(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizedConversationText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * System-origin coordination is diagnostic telemetry, not a curated
 * conversation. Every curated source filters through this ONE predicate so the
 * Conversations views and the Raw events view stay a true partition — and so
 * the rail and /adv hide exactly the same rows.
 */
export function isSystemConversationActor(value: string | null | undefined): boolean {
  return /^system(?:$|[-_:/.])/i.test((value ?? '').trim());
}

/**
 * A deliberately strict cross-source signature. Distinct conversations may
 * legitimately share a work-item or a title, so collapse them only when every
 * user-visible identity field matches.
 */
export function unifiedConversationSignature(row: UnifiedConversationRow): string {
  return [
    normalizedConversationText(row.title),
    normalizedConversationText(row.preview),
    normalizedConversationText(row.actor),
    normalizedConversationText(row.recipient),
    normalizedConversationText(row.harnessSlug),
    normalizedConversationText(row.relatedRef),
  ].join('|');
}

// ─── Composition ────────────────────────────────────────────────────────────

/**
 * The already-fetched source windows to compose. Every field is OPTIONAL, which
 * is what lets a surface opt OUT of a source without forking this function —
 * the rail omits `questions` (owner, 2026-07-27: "remove the q&a tab no one is
 * using that feature") while /adv still passes it (D-001).
 *
 * A sources OBJECT rather than positional arrays (D-003): a fourth positional
 * `readonly T[]` argument next to three others is how the fifth source becomes
 * a silent mis-wiring.
 */
export interface ConversationSources {
  questions?: readonly ConvRow[];
  deliberations?: readonly ThreadRow[];
  agentChats?: readonly AgentChatRow[];
  agentMessages?: readonly AgentMessageRow[];
}

/** Title/preview for an agent message. `summary` is the one-line the sender
 *  wrote for the inbox; `body` is the long form. Either can be absent. */
function agentMessageText(row: AgentMessageRow): { title: string; preview: string } {
  const summary = (row.summary ?? '').trim();
  const body = (row.body ?? '').trim();
  const title = summary || body.slice(0, 140) || `${row.kind} from ${row.from}`;
  // Never repeat the title as its own preview — in a 68px rail row that reads
  // as a rendering bug. Fall back to the lifecycle beat / plan context instead.
  const preview = body && body !== summary ? body : [row.lifecycle, row.plan_slug].filter(Boolean).join(' · ');
  return { title, preview };
}

/**
 * Compose the unified stream from the cached list queries, newest first,
 * deduplicated by identity AND (across sources only) by the semantic signature.
 *
 * A row click therefore remounts onto a warm list cache instead of replacing
 * one aggregate query with a cold request — which is why this takes already
 * fetched arrays rather than doing any fetching of its own.
 */
export function composeUnifiedConversationRows(
  sources: ConversationSources,
  limit: number,
): UnifiedConversationRow[] {
  const { questions = [], deliberations = [], agentChats = [], agentMessages = [] } = sources;
  const candidates: UnifiedConversationRow[] = [
    ...questions.filter((row) => !isSystemConversationActor(row.asker_id)).map((row) => ({
      id: `threads:${row.id}`,
      source: 'threads' as const,
      sourceId: row.id,
      typeLabel: SOURCE_LABEL.threads,
      kind: row.kind,
      state: row.state,
      title: row.title ?? row.id,
      preview: (row.topics ?? []).map((topic) => `#${topic}`).join('  '),
      actor: row.asker_id,
      harnessSlug: row.harness_slug,
      relatedRef: row.promoted_issue_id,
      // A promoted conversation always points at a work item.
      relatedKind: row.promoted_issue_id ? ('issue' as const) : null,
      updatedAt: conversationEpoch(row.updated_ts ?? row.created_ts),
    })),
    ...deliberations.filter((row) => !isSystemConversationActor(row.created_by)).map((row) => ({
      id: `deliberations:${row.thread_id}`,
      source: 'deliberations' as const,
      sourceId: row.thread_id,
      typeLabel: SOURCE_LABEL.deliberations,
      kind: row.parent_kind ?? '',
      state: '',
      title: row.title ?? row.thread_id,
      preview: [row.parent_kind, row.parent_ref].filter(Boolean).join(' · '),
      actor: row.created_by ?? undefined,
      harnessSlug: row.harness_slug,
      relatedRef: row.parent_ref,
      relatedKind: row.parent_ref ? asConversationRefKind(row.parent_kind) : null,
      count: row.post_count,
      updatedAt: conversationEpoch(row.last_post_at ?? row.created_at),
    })),
    ...agentChats.filter((row) => !isSystemConversationActor(row.role)).map((row) => ({
      id: `agentchats:${row.id}`,
      source: 'agentchats' as const,
      sourceId: row.id,
      typeLabel: SOURCE_LABEL.agentchats,
      kind: row.role ?? '',
      state: row.archived_at == null ? 'open' : 'archived',
      title: row.title ?? row.id,
      preview: [row.role, row.feature_id].filter(Boolean).join(' · '),
      actor: row.role ?? undefined,
      harnessSlug: row.harness_slug,
      relatedRef: row.feature_id,
      relatedKind: row.feature_id ? ('feature' as const) : null,
      count: row.turns,
      updatedAt: conversationEpoch(row.updated_at ?? row.created_at),
    })),
    ...agentMessages.filter((row) => !isSystemConversationActor(row.from)).map((row) => {
      const { title, preview } = agentMessageText(row);
      const audienceRef = parseAudienceRef(row.audience);
      return {
        id: `messages:${row.msg_id}`,
        source: 'messages' as const,
        sourceId: row.msg_id,
        typeLabel: SOURCE_LABEL.messages,
        kind: row.kind,
        state: row.lifecycle ?? '',
        title,
        preview,
        actor: row.from,
        // A broadcast has no single recipient; naming one would be a lie, and
        // an enumerated 40-agent `to` array does not fit any row we render.
        recipient: row.broadcast
          ? 'broadcast'
          : row.to.length === 1
            ? row.to[0]
            : row.to.length > 1
              ? `${row.to.length} recipients`
              : undefined,
        harnessSlug: row.harness_slug,
        relatedRef: audienceRef?.ref ?? row.plan_slug ?? null,
        relatedKind: audienceRef?.kind ?? (row.plan_slug ? ('plan' as const) : null),
        count: row.reply_count || undefined,
        updatedAt: conversationEpoch(row.last_reply_ts ?? row.ts),
      };
    }),
  ];

  const identities = new Set<string>();
  // Which SOURCE first claimed a given semantic signature. The semantic collapse
  // exists for one conversation MIRRORED into two stores; applying it WITHIN a
  // source silently deletes distinct conversations that merely share a title —
  // measured on live data it swallowed 42% of agent chats (100 fetched → 58
  // signatures), which is why "Chat" read 51 (owner, 2026-07-27). Two rows with
  // different ids from the same store are two conversations, full stop.
  const semanticOwner = new Map<string, ConversationSource>();
  const deduplicated: UnifiedConversationRow[] = [];
  for (const row of candidates.sort((a, b) => b.updatedAt - a.updatedAt)) {
    const identity = `${row.source}:${row.sourceId}`;
    if (identities.has(identity)) continue;
    const semantic = unifiedConversationSignature(row);
    const owner = semanticOwner.get(semantic);
    if (owner !== undefined && owner !== row.source) continue;
    identities.add(identity);
    if (owner === undefined) semanticOwner.set(semantic, row.source);
    deduplicated.push(row);
    if (deduplicated.length === limit) break;
  }
  return deduplicated;
}

/** Free-text search over everything a row displays. Shared so the rail's
 *  single search box and /adv's search filter the same fields. */
export function conversationMatchesQuery(row: UnifiedConversationRow, query: string): boolean {
  const q = normalizedConversationText(query);
  if (!q) return true;
  return [row.typeLabel, row.kind, row.state, row.title, row.preview, row.actor, row.recipient, row.harnessSlug, row.relatedRef]
    .some((value) => normalizedConversationText(value).includes(q));
}

// ─── Shared transport ───────────────────────────────────────────────────────

/** Reads are bounded; a wedged coordination read must fail rather than hang a pane. */
export const CONVERSATION_READ_TIMEOUT_MS = 15_000;

export function conversationErrText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The audited coordination admin proxy — `POST /api/admin/coordination/:group/:verb`,
 * which re-dispatches into the SAME MCP tool handlers the agents call. Both the
 * rail and /adv write through this one helper, so neither can quietly acquire a
 * second write path.
 */
export async function coordFetch<T = Record<string, unknown>>(
  verb: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const isRead = verb.endsWith('/list') || verb.endsWith('/get');
  const res = await fetch(`/api/admin/coordination/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    ...(isRead ? { signal: AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS) } : {}),
  });
  if (!res.ok) throw new Error(`${verb}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ─── Display helpers ────────────────────────────────────────────────────────

/** agent-chat timestamps are bigint epoch-ms; coord/message ones are ISO
 *  strings. Normalise either to a display string. */
export function fmtConversationTs(v: string | number | null | undefined): string {
  if (v == null) return '';
  const d = new Date(typeof v === 'number' ? v : v);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Compact relative age — the rail has room for `3h`, not `3 hours ago`. */
export function fmtConversationRel(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * An agent-chat transcript turn's content is either a plain string or an array
 * of content parts (the provider block shape). Flatten either to text — shared,
 * because both the wide transcript and the rail's render the same turns.
 */
export function turnText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string'
          ? p
          : p && typeof p === 'object' && 'text' in p
            ? String((p as { text: unknown }).text)
            : JSON.stringify(p),
      )
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** The same clock, abbreviated for a 300px row where `ago` does not fit. */
export function fmtConversationAge(v: string | number | null | undefined): string {
  const rel = fmtConversationRel(v);
  return rel.endsWith(' ago') ? rel.slice(0, -4) : rel;
}
