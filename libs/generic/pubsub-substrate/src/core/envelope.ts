/**
 * envelope.ts — the typed line shape every coordination channel shares,
 * plus the monotonic id minter. PURE: no filesystem, no database.
 *
 * The fs/PG read+write of these envelopes lives behind the
 * `CoordEventLog` seam (../event-log); this module is only the
 * vocabulary + id generation that both the seam and the host share.
 *
 * (Extracted from apps/operator/lib/agent-tools/coordination/envelope.ts
 * — agent-coordination-architecture-v2 §6.2/§6.3.)
 */

/**
 * EXECUTABLE kinds — the closed set the RUNTIME acts on. A line of one of these
 * kinds drives machine behaviour: it mutates subscription/handoff/contract state,
 * or asks a session to do something (`notify`, `yield`).
 *
 * This set is CLOSED on purpose (agent-protocol-authority-semantics-2026-07-26,
 * D-014). "Executable" has to be something the runtime can ENUMERATE, not a
 * convention each reader is trusted to honour — P-009 ("the runtime never infers a
 * state transition from prose") stands on exactly this: only a kind listed here may
 * drive a state transition, and everything else is talk. Adding a member is
 * therefore a deliberate act that widens what the runtime will execute.
 */
export const COORD_EXECUTABLE_KINDS = [
  'subscribe',
  'unsubscribe',
  'notify',
  'handoff',
  'handoff_accepted',
  // F-FIX-037: a sibling expiry record auto-written by the stale-handoff reconcile
  // when a handoff sits pending past the TTL (same immutable pattern as acceptance).
  'handoff_expired',
  // coord-dispatch-reliability P-003: a sibling RE-PING record auto-written by the
  // reconcile sweep when an OPEN handoff is still un-acked after ~30m (but < the
  // 12h expire TTL) — re-pings the OFFERER once. Same immutable sibling pattern;
  // the record itself is the idempotency marker (one re-ping per handoff).
  'handoff_repinged',
  'contract',
  'plan_event',
  // turn-lifecycle-control Phase 4 (P-016/P-019): a cooperative turn:interrupt
  // yield — "wrap up + end your turn". The dual of a wake.
  'yield',
] as const;

/**
 * CONVERSATIONAL kinds — pure talk with an open payload. Preserved in full for
 * audit, but carrying ZERO authority over runtime state: a peer saying "this is
 * done" in a `message` body is a claim, never a transition.
 *
 * Unlike the executable set this side is expected to grow (P-010 adds an
 * evidence/provenance band to it), which is why the two are named separately
 * rather than partitioned by a predicate over one flat union.
 */
export const COORD_CONVERSATIONAL_KINDS = [
  'message',
  'ack',
  // Append-only compensation for an acknowledgement. Readers fold it against
  // the same principal's earlier ack; the original receipt stays immutable.
  'unack',
  'escalation',
  'escalation_resolved',
  // Append-only compensation for a resolution. A later generation may resolve
  // the same escalation again without deleting either historical event.
  'escalation_reopened',
  // context-injection-audit-2026-07-28 P-039 / D-012: a commitment-scoped notice
  // that a peer the RECEIVER is blocked on changed liveness state. Conversational
  // by construction — it reports a derived verdict and carries no authority over
  // runtime state (the reader decides whether to keep waiting). Deliberately NOT
  // `message`: the per-recipient unanswered-directed aggregate counts only
  // kind='message'/unset, so a distinct kind keeps these system notices out of
  // that count for free instead of relying on a machine-sender exclusion.
  'presence_alert',
] as const;

export type CoordExecutableKind = (typeof COORD_EXECUTABLE_KINDS)[number];
export type CoordConversationalKind = (typeof COORD_CONVERSATIONAL_KINDS)[number];

/**
 * The wire vocabulary. Byte-identical to the flat union this replaced — D-014
 * keeps every literal because each one is a value already persisted in
 * coord_event_log rows, so collapsing the set (as XFlow/muACP's ~4-member
 * vocabularies would suggest) is a WIRE change with a migration, not a type-level
 * reorganization.
 */
export type CoordKind = CoordExecutableKind | CoordConversationalKind;

const EXECUTABLE_KIND_SET: ReadonlySet<string> = new Set(COORD_EXECUTABLE_KINDS);

/**
 * Is this kind one the runtime may act on? The single runtime authority for the
 * D-014 split — readers ask this instead of re-listing kinds at each call site
 * (a re-listed set is how the two taxonomies drifted in the first place).
 * Accepts a plain string so a value off the wire can be narrowed safely.
 */
export function isExecutableCoordKind(kind: string): kind is CoordExecutableKind {
  return EXECUTABLE_KIND_SET.has(kind);
}

/**
 * The authority-bearing PROJECTION of an envelope — the only fields the runtime
 * may consult when deciding a state transition.
 *
 * P-009's invariant ("the runtime never infers a state transition from prose") is
 * enforced here STRUCTURALLY rather than by convention: `body` and `summary` are
 * absent from this type, so a transition path holding a CoordTransitionIntent
 * cannot read prose even by mistake — that is a compile error, not a code-review
 * note. This applies the plan's own D-004 to itself ("a rule that matters gets an
 * enum, a validator, or structural removal — never a sentence in a description");
 * before this, the guarantee WAS a sentence, re-honoured by hand at each fold.
 *
 * This is the "binding indirection" P-009 names: an agent PROPOSES in `body` — a
 * slot the protocol chose, preserved verbatim for audit — and the runtime BINDS
 * only what is declared in typed fields.
 */
export interface CoordTransitionIntent {
  /** Always an executable kind — the sole authority for the transition. */
  kind: CoordExecutableKind;
  msg_id: string;
  from: string;
  to: string[];
  ts: string;
  /** Which prior event this acts on (acceptances / expiries / re-pings). */
  related_msg_id?: string;
}

/**
 * The ONE sanctioned door from a raw envelope to a state transition.
 *
 * Returns a body-free {@link CoordTransitionIntent} when — and only when — the
 * envelope's DECLARED `kind` is a member of {@link COORD_EXECUTABLE_KINDS}.
 * Returns null for every conversational kind and every unknown string, however
 * imperative its prose: a `message` whose body reads "handoff accepted, you are
 * released" is a CLAIM, and this function is precisely where a claim stops being
 * a transition.
 *
 * Authority is read from `kind` alone — no branch below inspects `body` or
 * `summary`, and the returned value cannot carry them. Defensive by design
 * (never throws) and FAIL-CLOSED: a malformed envelope yields null, i.e. no
 * transition, rather than a partially-trusted one.
 */
export function readCoordTransitionIntent(
  env: Record<string, unknown> | null | undefined,
): CoordTransitionIntent | null {
  if (!env || typeof env !== 'object') return null;
  const { kind, msg_id, from, ts, to, related_msg_id } = env as Record<string, unknown>;
  if (typeof kind !== 'string' || !isExecutableCoordKind(kind)) return null;
  if (typeof msg_id !== 'string' || msg_id.length === 0) return null;
  if (typeof from !== 'string' || from.length === 0) return null;
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const recipients = Array.isArray(to) ? to.filter((t): t is string => typeof t === 'string') : [];
  return {
    kind,
    msg_id,
    from,
    ts,
    to: recipients,
    ...(typeof related_msg_id === 'string' && related_msg_id.length > 0
      ? { related_msg_id }
      : {}),
  };
}

export interface CoordEnvelope {
  /** ISO-8601 UTC. */
  ts: string;
  /** Time-prefixed unique id; sortable lexicographically. */
  msg_id: string;
  /** Writer's stable owner id. */
  from: string;
  /** Recipients. ['*'] = broadcast; ownerIds otherwise; ['human'] = surface to the user. */
  to: string[];
  /**
   * The ORIGINAL audience selectors (`@fleet:` / `@topic:` / `@plan:` / `@object:` /
   * `@file:` / `@fleet-leader:`) and/or `*` this was addressed to, preserved BEFORE
   * `expandAudience` resolved them to the concrete ownerIds now in `to`. This is the
   * key that makes a broadcast queryable as audience-keyed HISTORY (coord:feed
   * { audience }), so a late/returning fleet/topic member can catch up even though
   * their id was never in the frozen `to`. Generalizes `plan_slug`; set on every
   * selector/broadcast send (live AND retained by default — no opt-in flag). Fleet
   * selectors are stored canonicalized to their slug. Absent on plain-id-only sends
   * (already queryable by `to`).
   */
  audience?: string[];
  kind: CoordKind;
  summary?: string;
  body?: string;
  /** Optional ambient-classification tag (e.g. 'service-health', 'agent-governor').
   *  A `message` with a category is still a message (D-002), but coord:inbox
   *  default-excludes the ambient categories so the firehose of system
   *  status broadcasts doesn't bury addressed work — opt in via the tool's
   *  `categories` / `include_ambient`. Free-form so new ambient sources need
   *  no envelope change. */
  category?: string;
  files?: string[];
  /** Head SHA at write time. */
  commit?: string;
  plan_slug?: string;
  /**
   * Harness scope (federation). When set, this message is bound to a shared
   * harness and federates over that harness's peer-log to agents on other
   * machines (distributed-coordination-shared-harness-2026-06-04, Track A).
   * Unset = operator-scope / workspace-global — stays local (D-007). PgCoordLog
   * projects this to the `coord_event_log.harness_slug` column the capture
   * trigger reads; the fs/in-memory backends carry it in the envelope blob.
   */
  harness_slug?: string;
  /** For acks / replies / resolutions — points at the originating msg_id. */
  related_msg_id?: string;
  /**
   * Sender-declared reply expectation. This is deliberately separate from
   * wakeOnReply (which controls whether the sender is re-invoked when a reply
   * arrives): unanswered-directed uses this field to distinguish a question
   * from an FYI/status report.
   */
  expectsReply?: boolean;
  /** Kind-specific extras (e.g. subscribe.pattern, escalation.options). */
  [key: string]: unknown;
}

/**
 * Generate a coord msg_id. Format: `<ms-base36>-<seq-base36>-<hex>` —
 * lex-monotonic by construction within one process even across multiple
 * ids minted in the same millisecond, so a downstream sort by
 * (ts, msg_id) is deterministic.
 */
let _lastMs = 0;
let _seq = 0;
export function newMsgId(): string {
  const now = Date.now();
  if (now === _lastMs) {
    _seq += 1;
  } else {
    _lastMs = now;
    _seq = 0;
  }
  const ms = now.toString(36).padStart(8, '0');
  const seq = _seq.toString(36).padStart(4, '0');
  const rnd = globalThis.crypto.randomUUID().replace(/-/g, '');
  return `${ms}-${seq}-${rnd}`;
}

/**
 * Stable (ts, msg_id) comparator — the canonical ordering for every
 * coordination surface. Both the fold helpers and the seam impls sort
 * by this so reads are deterministic regardless of file/row order.
 */
export function compareByTsThenId(a: CoordEnvelope, b: CoordEnvelope): number {
  return a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id);
}
