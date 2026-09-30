/**
 * watermark.ts — per-agent "last-read" pointer shape + pure merge.
 * PURE.
 *
 * The watermark is a mutable single-doc-per-agent read cursor, NOT an
 * append-only channel — so its *persistence* stays host-side (a whole-
 * file/row read-modify-write, like presence), but the value shape and
 * the partial-merge rule are pure and live here.
 *
 * (Extracted from coordination/watermarks.ts —
 * agent-coordination-architecture-v2 §7.2.)
 */

export interface Watermark {
  /** Inbox messages/acks/notifies/handoffs read up to this ISO ts. */
  messages_since_ts: string;
  /**
   * Messages SHOWN (injected into the agent's `[coord+N]` block) up to this ISO ts —
   * the READ-RECEIPT cursor (EI-2042). Advanced DETERMINISTICALLY at injection by the
   * coord:inbox tool code, NOT by the LLM/turn-end hook. Distinct from
   * `messages_since_ts` (which advances at turn-END, so an aborted turn re-delivers):
   * `messages_shown_ts` is always ≥ `messages_since_ts`, and the gap between them =
   * "shown but the turn hasn't completed" (read-and-still-working vs read-and-done).
   * A sender tells "did peer X read my message" via `X.messages_shown_ts ≥ msg.ts`.
   */
  messages_shown_ts: string;
  /** Escalations read up to this ISO ts. */
  escalations_since_ts: string;
  /** plan-events read up to this ISO ts. */
  plan_events_since_ts: string;
  /** msg_ids of subscription `notify`s already surfaced. */
  subscriptions_fired: string[];
  /**
   * The cursor advanced past a snapshot the subscriber no longer holds — its
   * cached read-once baseline was lost (context compaction / fresh resume) while
   * this durable cursor kept advancing, so on the next read it must RE-BOOTSTRAP
   * (re-read the full snapshot) before trusting deltas. Set on a session-lifecycle
   * start, consumed + cleared once on the next read. A read-cursor concept, not
   * snapshot-payload-specific (presence-v2 D-007 is the first consumer).
   */
  snapshot_rebootstrap_pending: boolean;
  /**
   * OPEN per-surface read cursors: surface key → opaque cursor string. The
   * escape hatch from this record's closed shape — a new surface registers by
   * adding a KEY here, with no change to this type and no migration.
   *
   * Why it exists (D-077, correcting a premise in D-012): the whole Watermark
   * rides in one `coord_watermarks.surfaces` jsonb column, which reads as
   * "extensible" — but it is NOT an open map, because {@link normaliseWatermark}
   * rebuilds the value field-by-field from {@link emptyWatermark}. An unknown
   * top-level key is therefore not merely ignored: PgWatermarkStore.write is a
   * read-modify-write, so the next write by ANY caller silently DESTROYS it.
   * Cursors added under this map survive that round-trip; cursors added as new
   * top-level keys do not.
   *
   * The cursor is opaque on purpose — a surface defines its own ordering (an
   * ISO ts, a monotonic id, an HLC). The facts surface uses the fact's
   * `(fed_ts, fed_hlc)` cell version per D-012's reuse-the-existing-clock rule.
   */
  cursors: Record<string, string>;
}

/** A fresh watermark — everything unread. */
export function emptyWatermark(): Watermark {
  return {
    messages_since_ts: '',
    messages_shown_ts: '',
    escalations_since_ts: '',
    plan_events_since_ts: '',
    subscriptions_fired: [],
    snapshot_rebootstrap_pending: false,
    cursors: {},
  };
}

/**
 * Normalise a possibly-partial/malformed parsed object into a complete
 * Watermark (missing/typed-wrong fields fall back to empty). Lets a host
 * treat a corrupt file as "never read anything" rather than failing.
 */
export function normaliseWatermark(parsed: Partial<Watermark> | null | undefined): Watermark {
  const base = emptyWatermark();
  if (!parsed || typeof parsed !== 'object') return base;
  return {
    messages_since_ts:
      typeof parsed.messages_since_ts === 'string' ? parsed.messages_since_ts : base.messages_since_ts,
    // Backward-compat (EI-2042): a pre-existing watermark has no messages_shown_ts → fall back to
    // its messages_since_ts (the agent HAS read up to there), then empty. Self-corrects on the next
    // inbox fetch, which advances shown_ts to the live tip.
    messages_shown_ts:
      typeof parsed.messages_shown_ts === 'string'
        ? parsed.messages_shown_ts
        : typeof parsed.messages_since_ts === 'string'
          ? parsed.messages_since_ts
          : base.messages_shown_ts,
    escalations_since_ts:
      typeof parsed.escalations_since_ts === 'string' ? parsed.escalations_since_ts : base.escalations_since_ts,
    plan_events_since_ts:
      typeof parsed.plan_events_since_ts === 'string' ? parsed.plan_events_since_ts : base.plan_events_since_ts,
    subscriptions_fired: Array.isArray(parsed.subscriptions_fired)
      ? parsed.subscriptions_fired.filter((x): x is string => typeof x === 'string')
      : base.subscriptions_fired,
    snapshot_rebootstrap_pending:
      typeof parsed.snapshot_rebootstrap_pending === 'boolean'
        ? parsed.snapshot_rebootstrap_pending
        : base.snapshot_rebootstrap_pending,
    // Preserve every well-formed entry, including surfaces this build has never
    // heard of — that is the whole point of the map (an older peer/host must not
    // silently drop a newer surface's cursor on its read-modify-write). Only
    // non-string values are dropped, since the cursor contract is opaque-string.
    cursors: normaliseCursors(parsed.cursors),
  };
}

/** Keep string-valued entries of a possibly-malformed cursor map; else empty. */
function normaliseCursors(parsed: unknown): Record<string, string> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Merge `patch` into `current`. Omitted fields keep their current value
 * (partial update). `subscriptions_fired` is *replaced* when supplied,
 * not appended — the caller owns dedup.
 *
 * `cursors` merges PER KEY, unlike every other field: a patch touching one
 * surface must not erase another surface's cursor. Surfaces have independent
 * writers, so whole-map replacement would make advancing the facts cursor
 * silently drop, say, a presence cursor written moments earlier by a different
 * code path (the read-modify-write makes that loss durable). Per-key merge
 * still permits the deliberate BACKWARD move the protocol relies on for
 * safe-commit recovery — the patch simply supplies an earlier value for that
 * key.
 */
export function mergeWatermark(current: Watermark, patch: Partial<Watermark>): Watermark {
  return {
    messages_since_ts: patch.messages_since_ts ?? current.messages_since_ts,
    messages_shown_ts: patch.messages_shown_ts ?? current.messages_shown_ts,
    escalations_since_ts: patch.escalations_since_ts ?? current.escalations_since_ts,
    plan_events_since_ts: patch.plan_events_since_ts ?? current.plan_events_since_ts,
    subscriptions_fired: patch.subscriptions_fired ?? current.subscriptions_fired,
    snapshot_rebootstrap_pending:
      patch.snapshot_rebootstrap_pending ?? current.snapshot_rebootstrap_pending,
    cursors: patch.cursors
      ? { ...current.cursors, ...patch.cursors }
      : current.cursors,
  };
}
