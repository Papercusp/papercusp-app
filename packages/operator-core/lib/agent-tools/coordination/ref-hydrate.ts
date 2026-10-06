/**
 * ref-hydrate.ts — the shared deref-at-delivery vocabulary: parse, budget, and
 * render TYPED REFS so content travels by REFERENCE and the platform expands it
 * verbatim at the delivery/injection boundary (coord-authority-hardening-2026-07-11
 * P-001, from the EI-9501 post-incident audit).
 *
 * The failure class this kills: an agent RE-TYPES content that already exists
 * durably under an id — a relayed owner directive (EI-9501: paraphrased +
 * mis-scoped hive-wide), a hand-typed gate key (waiter strands forever), a
 * work-item title recalled stale, a reply whose question the asker compacted
 * away. Deref-at-delivery means the sender passes the id, the platform inlines
 * a bounded VERBATIM snippet at delivery, and the receiver pays zero fetch
 * round-trips. Consumers: relayOf (P-004), related_msg_id (P-005), gateRefs
 * (P-006), facts sourceRef (P-007), body auto-refs (P-008), dispatch/handoff
 * (WI-4165, deferred).
 *
 * Budget discipline (D-004): a hydration is a COMPACT snippet + the retained id
 * (full fetch stays one call away), capped per message, and NEVER recursive —
 * a hydrated quote's own refs do not expand.
 *
 * Pure + import-free (like ./cue-authority): the IO half (message / work-item /
 * gate lookups) lives in ./ref-hydrate-resolve so coord-schema (the injection
 * renderer) can import the parse/render helpers WITHOUT pulling the DB /
 * agent-mcp graph into its dependency tree.
 */

/** Session-source kinds accepted by the canonical `session_turn:` reference. */
export const SESSION_TURN_SOURCE_KINDS = ['claude', 'omp', 'codex', 'agent_chat'] as const;
export type SessionTurnSourceKind = (typeof SESSION_TURN_SOURCE_KINDS)[number];

/** The parsed coordinates of one indexed transcript turn. */
export interface SessionTurnRef {
  sourceKind: SessionTurnSourceKind;
  sessionId: string;
  turnIdx: number;
}

/** Render a parsed session-turn ref in the public canonical form. */
export function formatSessionTurnRef(ref: SessionTurnRef): string {
  return `session_turn:${ref.sourceKind}:${ref.sessionId}:${ref.turnIdx}`;
}

/** A typed, platform-resolvable reference. */
export type HydratableRef =
  /** A coord message by msg_id (`msg:<id>`). */
  | { kind: 'msg'; id: string }
  /** A work-item by id — WI-/EI-/F- families (`WI-123`, `wi:WI-123`). */
  | { kind: 'work-item'; id: string }
  /** A conversation id (exact or unique prefix, resolved in the caller's workspace). */
  | { kind: 'conversation'; id: string }
  /** A plan item (`plan:<slug>#P-001`). */
  | { kind: 'plan-item'; slug: string; item: string }
  /** An announced event gate by exact key (`gate:<key>`). */
  | { kind: 'gate'; key: string }
  /** One indexed transcript turn (`session_turn:<source>:<session>:<idx>`). */
  | ({ kind: 'session-turn' } & SessionTurnRef)
  /** The calling session's current human turn (`owner-turn` sentinel — the
   *  H2 Tier-2 origin; a TUI turn has NO coord msg_id, so it is resolved
   *  server-side from the session store, never referenced by id). */
  | { kind: 'owner-turn' };

export interface RefHydrationBudget {
  /** Max characters of verbatim snippet per hydrated ref. */
  snippetChars: number;
  /** Max refs hydrated per message — beyond this, refs pass through unhydrated. */
  maxRefs: number;
}

/** Delivery-time lifecycle state for a referenced work-item. */
export interface TerminalSubject {
  state: string;
  /** Canonical time the item entered its current terminal state; null for legacy rows. */
  closedAt: string | null;
}

/** D-004: ~200 chars/ref, ≤3 refs/message, never recursive. */
export const DEFAULT_REF_BUDGET: RefHydrationBudget = { snippetChars: 200, maxRefs: 3 };

/** One resolved (or failed-soft) hydration, ready to render. */
export interface HydratedRef {
  ref: HydratableRef;
  ok: boolean;
  /** Short structured label — WHO/WHAT/WHEN, never the content itself. */
  label: string;
  /** Bounded VERBATIM snippet (single-line, clamped); '' when !ok. */
  snippet: string;
  /** Failure tag when !ok: 'not_found' | 'resolver_not_installed' | 'resolve_error'. */
  error?: string;
  /** Present when a referenced work-item is already terminal at delivery time. */
  terminalSubject?: TerminalSubject;
}

const WORK_ITEM_ID = /^(?:wi:)?((?:WI|EI|F)-\d+)$/i;
const CONVERSATION_ID = /^(?:conversation:)?(conv-[a-z0-9][a-z0-9-]*)$/i;
const PLAN_ITEM = /^plan:([a-z0-9][a-z0-9-]*)#(P-\d{3,})$/i;
const MSG_REF = /^msg:(\S+)$/i;
const GATE_REF = /^gate:(\S+)$/;
/** Session ids may contain colons, so the session capture is greedy and the
 * final numeric segment is the turn index (same first/last separator rule as
 * sessions/_shared.ts parseTurnRef). */
const SESSION_TURN_REF = /^session_turn:(claude|omp|codex|agent_chat):(\S+):(\d+)$/i;

/**
 * Parse one explicit ref token into a typed ref. Returns null for anything
 * unrecognized — callers must treat null as "not a ref", never an error.
 */
export function parseRefToken(token: string): HydratableRef | null {
  const t = (token ?? '').trim();
  if (!t) return null;
  if (t === 'owner-turn') return { kind: 'owner-turn' };
  const msg = MSG_REF.exec(t);
  if (msg) return { kind: 'msg', id: msg[1] };
  const wi = WORK_ITEM_ID.exec(t);
  if (wi) return { kind: 'work-item', id: wi[1].toUpperCase() };
  const conversation = CONVERSATION_ID.exec(t);
  if (conversation) return { kind: 'conversation', id: conversation[1] };
  const pi = PLAN_ITEM.exec(t);
  if (pi) return { kind: 'plan-item', slug: pi[1].toLowerCase(), item: pi[2].toUpperCase() };
  const gate = GATE_REF.exec(t);
  if (gate) return { kind: 'gate', key: gate[1] };
  const sessionTurn = SESSION_TURN_REF.exec(t);
  if (sessionTurn) {
    const turnIdx = Number(sessionTurn[3]);
    if (Number.isSafeInteger(turnIdx)) {
      return {
        kind: 'session-turn',
        sourceKind: sessionTurn[1].toLowerCase() as SessionTurnSourceKind,
        sessionId: sessionTurn[2],
        turnIdx,
      };
    }
  }
  return null;
}

/** Work-item id shapes loose in prose — the P-008 auto-detect surface.
 * Bounded by both word and hyphen characters so 'WI-123' matches inside a
 * sentence but 'XWI-123' and hyphenated handles such as
 * 'diag-EI-123-unlabeled' do not manufacture a shorter phantom ref. */
const BODY_WORK_ITEM = /(?<![\w-])((?:WI|EI)-\d+)(?![\w-])/g;

/** Structured work-item refs are exact citations, unlike ids found in prose.
 * Keep this deliberately narrower than the prose detector: only the fields
 * whose contract is a ref are allowed to establish an ambiguity fence. */
const STRUCTURED_WORK_ITEM_REF = /^(?:work-item:)?(?:wi:)?((?:WI|EI)-\d+)(?:#[^\s#]+)?$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function structuredWorkItemId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = STRUCTURED_WORK_ITEM_REF.exec(value.trim());
  return match?.[1]?.toUpperCase() ?? null;
}

/** Collect exact work-item refs from the envelope's typed/authored fields.
 *
 * A message can contain a display-shortened prose token (`EI-224`) beside a
 * structured citation of the real item (`EI-22489500008234936`). Resolving the
 * former against the work-item table is dangerous when the prefix itself is a
 * different, real row. These fields are the sender's typed refs; free prose is
 * intentionally not inspected here. */
function structuredWorkItemIds(entry: unknown): ReadonlySet<string> {
  const record = asRecord(entry);
  const ids = new Set<string>();
  if (!record) return ids;

  const add = (value: unknown) => {
    const id = structuredWorkItemId(value);
    if (id) ids.add(id);
  };
  const addRefObject = (value: unknown) => add(asRecord(value)?.ref);
  const addRefList = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === 'string') add(item);
      else addRefObject(item);
    }
  };
  const addSections = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const section of value) {
      const s = asRecord(section);
      if (!s) continue;
      addRefList(s.premises);
      add(asRecord(s.forYouBecause)?.ref);
      addRefList(s.youMayNotKnow);
      add(asRecord(s.blockedOn)?.ref);
    }
  };

  addSections(record.sections);
  // Accept the pre-normalized structured body shape as well. The persisted
  // envelope uses `sections`, but this keeps the pure helper safe for callers
  // that hand it the original structured body.
  addSections(record.body);
  addRefList(record.basedOn);
  add(asRecord(record.why)?.goalRef);
  add(asRecord(record.blockedOn)?.ref);
  add(asRecord(record.expectEffect)?.itemId);
  add(asRecord(record.forYouBecause)?.ref);
  return ids;
}

/**
 * Auto-detect hydratable refs in free prose (P-008). Deliberately NARROW:
 * work-item ids only (WI-/EI-), the shapes agents cite constantly and receivers
 * re-fetch or half-remember. De-duped, first-`max` in order of appearance.
 * (F- ids are excluded from auto-detect: too collision-prone in prose.)
 */
export function detectBodyRefs(
  text: string,
  max = DEFAULT_REF_BUDGET.maxRefs,
  include?: (id: string) => boolean,
): HydratableRef[] {
  const out: HydratableRef[] = [];
  const seen = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(BODY_WORK_ITEM)) {
    const id = m[1].toUpperCase();
    if (include && !include(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: 'work-item', id });
    if (out.length >= max) break;
  }
  return out;
}

/** Stable key for de-dupe / budget accounting. */
export function canonicalRefKey(ref: HydratableRef): string {
  switch (ref.kind) {
    case 'msg':
      return `msg:${ref.id}`;
    case 'work-item':
      return `work-item:${ref.id}`;
    case 'conversation':
      return `conversation:${ref.id}`;
    case 'plan-item':
      return `plan-item:${ref.slug}#${ref.item}`;
    case 'gate':
      return `gate:${ref.key}`;
    case 'session-turn':
      return `session-turn:${ref.sourceKind}:${ref.sessionId}:${ref.turnIdx}`;
    case 'owner-turn':
      return 'owner-turn';
  }
}

/**
 * Clamp verbatim content to a single bounded line: newlines/runs of whitespace
 * collapse to single spaces; cut at `n` chars with a trailing ellipsis. The
 * snippet must stay VERBATIM in what it shows — clamping trims, never rewrites.
 */
export function clampSnippet(text: string, n: number): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= n) return oneLine;
  return `${oneLine.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

/**
 * Apply the budget: de-dupe by canonical key, keep the first `maxRefs` in
 * order. Pure — resolution happens in the IO half on the survivors only.
 */
export function applyRefBudget(
  refs: HydratableRef[],
  budget: RefHydrationBudget = DEFAULT_REF_BUDGET,
): HydratableRef[] {
  const out: HydratableRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const key = canonicalRefKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= budget.maxRefs) break;
  }
  return out;
}

/**
 * Render one hydration to the injection-line form. Verbatim content is always
 * quoted so a reader can tell platform-read words from the sender's own prose —
 * the anti-telephone-game property (D-005: the original words travel with the
 * relay, next to the paraphrase, so drift is visible at every hop).
 */
export function renderHydratedRef(h: HydratedRef): string {
  if (!h.ok) return `↪ ${h.label} — unresolved (${h.error ?? 'unknown'})`;
  return h.snippet ? `↪ ${h.label}: "${h.snippet}"` : `↪ ${h.label}`;
}

/** Render a hydration block (one line per ref) — '' for an empty list. */
export function renderHydratedRefs(hs: HydratedRef[]): string {
  return hs.map(renderHydratedRef).join('\n');
}

/**
 * The P-005 related_msg_id REPLY-QUOTE inline suffix: appended to a delivered
 * [coord+N] line whose envelope carries `related_msg_id` (a reply / escalation
 * resolution), quoting the REFERENCED message — sender, ts, bounded verbatim
 * snippet — so the receiver reads the exchange without a fetch, even when they
 * compacted the original away. `⤷ re` (not `↪`) so a reply-quote reads
 * distinctly from a relay/ref hydration on the same line. An unresolved ref
 * stays VISIBLE (the fail-soft contract) — never silently dropped.
 */
export function renderReplyQuoteSuffix(h: HydratedRef): string {
  if (!h.ok) return ` ⤷ re ${h.label} — unresolved (${h.error ?? 'unknown'})`;
  return h.snippet ? ` ⤷ re ${h.label}: "${h.snippet}"` : ` ⤷ re ${h.label}`;
}

// ─────────────────────────── P-006: gateRefs ───────────────────────────

/** Gate-key status at SEND time (checked against the announced-gates store):
 *  `declared` = announced, not yet fired; `fired` = latched (proceed, don't
 *  wait); `undeclared` = no announcement matches (typo, or a machine-derived
 *  key that needs none); `unknown` = the probe failed (fail-soft). */
export type GateRefStatus = 'declared' | 'fired' | 'undeclared' | 'unknown';

export interface GateRefStamp {
  /** The EXACT event key — the whole point: it travels verbatim, so the
   *  receiver copies (or `events:await { fromMsg }`-resolves) it, never
   *  re-types it. */
  key: string;
  status: GateRefStatus;
}

/** The reserved envelope field gateRef stamps ride on (array — same
 *  pass-through contract as cueAuthority / relayProvenance). */
export const GATE_REFS_FIELD = 'gateRefs';
/** Cap per message — a send that names more gates than this is prose, not
 *  coordination. */
export const GATE_REFS_MAX = 3;

const GATE_STATUSES: ReadonlySet<string> = new Set(['declared', 'fired', 'undeclared', 'unknown']);

/**
 * Read + validate gateRef stamps off an envelope. Defensive: absent/malformed
 * → [] (never throws); malformed entries are dropped individually; capped.
 */
export function readGateRefs(env: Record<string, unknown> | null | undefined): GateRefStamp[] {
  const raw = env?.[GATE_REFS_FIELD];
  if (!Array.isArray(raw)) return [];
  const out: GateRefStamp[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const { key, status } = s as Record<string, unknown>;
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof status !== 'string' || !GATE_STATUSES.has(status)) continue;
    out.push({ key: key.trim(), status: status as GateRefStatus });
    if (out.length >= GATE_REFS_MAX) break;
  }
  return out;
}

/**
 * The inline `⛩` delivery suffix: each declared gate rendered with its EXACT
 * key + send-time status. NEVER clipped by the line's text cap (it is appended
 * after the clip) — a truncated gate key is worse than none, since a receiver
 * copying it would strand on a near-miss.
 */
export function renderGateRefsSuffix(stamps: GateRefStamp[]): string {
  if (!stamps.length) return '';
  return ` ⛩ ${stamps.map((s) => `gate ${s.key} [${s.status}]`).join('; ')}`;
}

// ─────────────────────────── P-008: body auto-refs ───────────────────────────

/** The envelope field `coord:send { noBodyRefs: true }` stamps — the SENDER's
 *  opt-out from receiver-side auto-hydration of WI-/EI- ids in this message's
 *  prose (e.g. the ids are historical/illustrative and inline live status would
 *  mislead). Honored at collect (no lookups) AND render (no suffix). */
export const BODY_REFS_OPT_OUT_FIELD = 'bodyRefsOptOut';

/** P-008 delivery budget: ~150 verbatim chars per hydrated mention (title/state/
 *  assignee + checkpoint tail), ≤3 mentions per message (detectBodyRefs' cap). */
export const BODY_REF_SNIPPET_CHARS = 150;
/** Of the per-ref budget, at most this much goes to the checkpoint TAIL. */
export const BODY_REF_CHECKPOINT_TAIL_CHARS = 60;

/** Read the sender opt-out off an envelope. Defensive: only a literal `true`
 *  opts out (a forged/malformed value degrades to "hydrate as usual"). */
export function readBodyRefsOptOut(env: Record<string, unknown> | null | undefined): boolean {
  return env?.[BODY_REFS_OPT_OUT_FIELD] === true;
}

/** Kinds whose text is agent-authored FREE PROSE — the only place an id mention
 *  is a CITATION worth hydrating. Machine-stamped lifecycle lines (intent /
 *  claim / completion / …), plan events, acks and subscription deltas name
 *  their item STRUCTURALLY (the line is already about it); hydrating those
 *  would burn the budget on ceremony and double-render on high-volume status. */
const BODY_REF_PROSE_KINDS: ReadonlySet<string> = new Set([
  'message',
  'escalation',
  'escalation_resolved',
  'handoff',
  'handoff_accepted',
  'contract',
  'yield',
]);

/** Whether an entry's prose is eligible for body auto-ref hydration (P-008).
 *  Pure + defensive: a lifecycle-stamped entry (whatever its kind) and any
 *  non-prose kind are ineligible; malformed shapes degrade to ineligible. */
export function isBodyRefEligible(
  entry: { kind?: unknown; lifecycle?: unknown } | null | undefined,
): boolean {
  if (!entry) return false;
  if (typeof entry.lifecycle === 'string' && entry.lifecycle) return false;
  return typeof entry.kind === 'string' && BODY_REF_PROSE_KINDS.has(entry.kind);
}

/**
 * Detect body refs over an ENTRY's full prose (summary + body) — the shared
 * text derivation the delivery seam (collect) and the renderer (attach) must
 * agree on, so a ref hydrated from the body still decorates the summary line.
 */
export function detectEntryBodyRefs(
  entry: { summary?: unknown; body?: unknown } | null | undefined,
  max = DEFAULT_REF_BUDGET.maxRefs,
): HydratableRef[] {
  const text = [entry?.summary, entry?.body]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ');
  const structuredIds = structuredWorkItemIds(entry);
  return detectBodyRefs(text, max, (id) => {
    // A strict prefix is ambiguous: it may be a different real row, so never
    // decorate it as authoritative when the same envelope carries the longer
    // typed citation. Exact citations remain eligible.
    return ![...structuredIds].some(
      (structuredId) => structuredId.length > id.length && structuredId.startsWith(id),
    );
  });
}

/**
 * Clamp verbatim content to a single bounded line keeping the TAIL (the
 * freshest end — a checkpoint's "next action" lives there), with a LEADING
 * ellipsis. Same verbatim contract as clampSnippet: trims, never rewrites.
 */
export function clampSnippetTail(text: string, n: number): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= n) return oneLine;
  return `…${oneLine.slice(oneLine.length - Math.max(0, n - 1)).trimStart()}`;
}

/**
 * The P-008 inline delivery suffix: each RESOLVED auto-detected mention as
 * `↪ <label>: "<snippet>"`, joined `; `. Unresolved hydrations are SILENTLY
 * skipped — deliberately unlike renderHydratedRef/renderReplyQuoteSuffix's
 * loud-unresolved: an auto-detected mention carries no sender-declared pointer
 * (the id still travels verbatim in the prose), and a local miss is ROUTINE
 * (a federated peer's item, a foreign-harness id, prose that merely looks like
 * an id) — decorating every one with "unresolved" would be pure noise. The
 * fail-soft "visible, not papered over" contract binds DECLARED refs only.
 */
export function renderBodyRefsSuffix(hs: HydratedRef[]): string {
  const ok = hs.filter((h) => h.ok);
  if (!ok.length) return '';
  return ` ${ok.map((h) => (h.snippet ? `↪ ${h.label}: "${h.snippet}"` : `↪ ${h.label}`)).join('; ')}`;
}

/**
 * Render a warning for a directed action/answer request whose cited subject is
 * already terminal. This is deliberately an annotation, not suppression: a
 * terminal subject may still fail to satisfy the ask, but the receiver should
 * not spend a full pass without first checking whether the request is already
 * answered. The warning is rendered by coord-schema only for directed asks.
 */
export function renderTerminalSubjectSuffix(hs: HydratedRef[]): string {
  const terminal = hs.filter((h) => h.ok && h.ref.kind === 'work-item' && h.terminalSubject);
  if (!terminal.length) return '';
  const subjects = terminal.map((h) => {
    const subject = h.ref.kind === 'work-item' ? h.ref.id : h.label;
    const stamp = h.terminalSubject!;
    const since = stamp.closedAt ? ` since ${stamp.closedAt}` : '';
    return `${subject} [${stamp.state}]${since}`;
  });
  return ` ⚠ SUBJECT TERMINAL: ${subjects.join('; ')} — this ask may already be satisfied`;
}
