/**
 * cell-thread.ts — P-006 of `gate-ownership-condition-singleton-2026-08-03`.
 *
 * Folds the DISCUSSION surface onto a state cell: an agent reading a red gate
 * sees not just *whether* someone owns the incident (P-004/P-005) but *what has
 * already been said about it* — the difference between filing the seventh
 * work-item and reading the three sentences that explain why the other six were
 * closed.
 *
 * ── WHY THE ITEM THREAD AND NEVER THE TOPIC (D-004) ───────────────────────────
 * One `gate` topic for all gate things is correct — topics are AREAS. But an area
 * spans every incident forever, so its last three messages very often describe a
 * PREVIOUS red: three confident, recent-looking messages about the wrong
 * incident, which is worse than showing none. The THREAD is this incident; the
 * TOPIC is a pointer, carried with a `since` so a reader who follows it can scope
 * their own read to this incident's window rather than re-reading history.
 *
 * ── WHY EVERY COUNT HERE IS REQUIRED (D-005) ──────────────────────────────────
 * Three messages printed without a count read as "that is all there is" —
 * absence-as-evidence, the same failure mode `claimState` hit in P-004 when an
 * unreadable store rendered as "nobody owns this". So the list carries
 * `shown`/`total`, and — because the median post in this workspace is 767 chars
 * (p90 2,883, max 7,860; measured 2026-08-03 over 8,479 posts) — TRUNCATION IS
 * THE COMMON CASE, not an edge case, and each message carries its own `chars` +
 * `truncated`. An excerpt that does not announce itself is the list-level bug
 * repeated one level down.
 *
 * ── WHAT THIS IS NOT (D-006) ──────────────────────────────────────────────────
 * The message list is ADVISORY PAYLOAD, explicitly OUTSIDE the cell's falsifier
 * contract. `CellSpec` requires a falsifier per cell, and a prose excerpt is not
 * a measured field — there is no apparatus that can contradict it, because it
 * asserts nothing beyond "these bytes were posted". Stating that here means the
 * next person to touch the ownership cell's falsifier does not have to work out
 * what it would mean to falsify a chat excerpt.
 */
import { cellUnknown, type CellUnknown } from '../cell-contract';
import { getWorkItemThreadWindow } from '../work-items';

/**
 * How much of a post body is inlined onto a cell before it is excerpted.
 *
 * 400 keeps three messages under ~1.2KB on a surface that renders on every
 * pipeline-position read, against a measured median post of 767 chars — i.e.
 * most posts DO truncate here, which is why {@link CellThreadMessage.truncated}
 * is a required field rather than a rare flag.
 */
export const CELL_THREAD_BODY_CHARS = 400;

/** How many posts a cell shows. Three, matching the coord injection's `[coord+N]`. */
export const CELL_THREAD_RECENT_LIMIT = 3;

/**
 * One post, projected onto a cell.
 *
 * `at` and `author` are REQUIRED by D-005 and are not decoration: a message
 * without a timestamp silently inherits the freshness of the cell embedding it,
 * which is a lie whenever the thread is older than the read — the common case for
 * a stale incident nobody has touched in days.
 */
export interface CellThreadMessage {
  /** ISO timestamp of the post. Never null — an undated message is the bug above. */
  at: string;
  /** The posting agent, or null for a substrate-authored post. */
  author: string | null;
  /** The body, excerpted to {@link CELL_THREAD_BODY_CHARS}. */
  text: string;
  /** Full length of the original body, so a reader knows how much is not shown. */
  chars: number;
  /** Whether `text` is an excerpt. Required — see the module doc. */
  truncated: boolean;
}

/**
 * A POINTER to an area, never its contents (D-004).
 *
 * `since` is the INCIDENT's start (the owning work-item's creation), not the time
 * the item was tagged. That is the boundary that makes a topic read about THIS
 * incident: tag time is an implementation detail of how the item got filed, while
 * the incident's start is what a reader must scope to in order to avoid the
 * previous red. It is therefore the same value on every pointer here — a property
 * of the incident, not of the edge.
 */
export interface CellTopicPointer {
  slug: string;
  ref: string;
  since: string | null;
}

/**
 * The discussion block folded onto a cell.
 *
 * ⚠ `shown`/`total` are NULL exactly when `unknown` is non-null, and in that case
 * `recent` is EMPTY. The invariant that matters — and that
 * {@link cellThreadIsCoherent} enforces — is that MESSAGES NEVER APPEAR WITHOUT A
 * COUNT. A populated list beside a null total would be precisely the
 * absence-as-evidence read D-005 exists to prevent.
 */
export interface CellThread {
  /** Oldest-first within the window — the order a conversation is read in. */
  recent: readonly CellThreadMessage[];
  /** How many messages are shown. NULL only when `unknown` is set. */
  shown: number | null;
  /** How many the thread holds in total. NULL only when `unknown` is set. */
  total: number | null;
  /** Pointers to the areas this incident is filed under. Never inlined messages. */
  topics: readonly CellTopicPointer[];
  /** In-band unknown, non-null exactly when the thread could not be measured. */
  unknown: CellUnknown | null;
}

/** The minimal post shape this module projects — structural, so the pure
 *  projection needs no store type and no database. */
export interface ThreadPostLike {
  author_id: string | null;
  body: string;
  created_ts: string;
}

/** PURE. Excerpt one post onto a cell. */
export function toCellThreadMessage(post: ThreadPostLike): CellThreadMessage {
  const body = post.body ?? '';
  const truncated = body.length > CELL_THREAD_BODY_CHARS;
  return {
    at: post.created_ts,
    author: post.author_id,
    text: truncated ? body.slice(0, CELL_THREAD_BODY_CHARS) : body,
    chars: body.length,
    truncated,
  };
}

/**
 * PURE. A MEASURED thread window.
 *
 * `total` comes from the store's own count over the same snapshot as the rows —
 * never a second query, which a concurrent post can overtake to produce
 * `shown: 3, total: 2`, a count that indicts the messages beside it.
 */
export function measuredThread(
  posts: readonly ThreadPostLike[],
  total: number,
  topics: readonly CellTopicPointer[] = [],
): CellThread {
  const recent = posts.map(toCellThreadMessage);
  return { recent, shown: recent.length, total, topics, unknown: null };
}

/**
 * PURE. A MEASURED silence — the item exists and has no posts.
 *
 * This is the DEFAULT state of a freshly bridge-minted work-item, not an edge
 * case: threads are created on first post, so a condition-minted item has no
 * thread row at all until someone comments. (Verified on the live WI-7282, minted
 * by the P-003 bridge at 02:19:52Z: no thread row, zero posts.) It is a real
 * `total: 0`, and must stay distinguishable from {@link unmeasuredThread}.
 */
export function silentThread(topics: readonly CellTopicPointer[] = []): CellThread {
  return { recent: [], shown: 0, total: 0, topics, unknown: null };
}

/**
 * PURE. There is no subject to have a thread — nothing owns the condition.
 *
 * `not-applicable` rather than `resolver-failed`: this is FINAL. Retrying changes
 * nothing and there is no lever, because the question "what has been said about
 * the owning item" presupposes an owning item.
 */
export function noSubjectThread(detail: string): CellThread {
  return { recent: [], shown: null, total: null, topics: [], unknown: cellUnknown('not-applicable', detail) };
}

/** PURE. The thread could NOT be read — never rendered as "nothing was said". */
export function unmeasuredThread(detail: string): CellThread {
  return { recent: [], shown: null, total: null, topics: [], unknown: cellUnknown('resolver-failed', detail) };
}

/**
 * PURE. The guard behind this module's one real invariant: a reader must never
 * receive messages without the counts that frame them, in either direction.
 */
export function cellThreadIsCoherent(t: CellThread): boolean {
  const unmeasured = t.unknown !== null;
  if (unmeasured) return t.shown === null && t.total === null && t.recent.length === 0;
  if (t.shown === null || t.total === null) return false;
  if (t.shown !== t.recent.length) return false;
  return t.total >= t.shown;
}

/** PURE. Project topic slugs + the incident start onto pointers (D-004). */
export function toTopicPointers(slugs: readonly string[], since: string | null): CellTopicPointer[] {
  return slugs.map((slug) => ({ slug, ref: `topic:${slug}`, since }));
}

/**
 * Read the discussion block for the work-item owning a cell's incident.
 *
 * `workItemId` is the cell's `ownership.workItem`, which is legitimately NULL
 * whenever nothing owns the condition — the single most common case on a healthy
 * gate. That is `not-applicable`, NOT an empty thread: "no one has commented" and
 * "there is nothing to comment on" are different facts, and only the second is
 * final.
 *
 * FAILS SOFT to {@link unmeasuredThread}, never to silence. A cell must always
 * render, but rendering an unreadable thread as "nothing was said" is the exact
 * P-004 defect this plan already had to correct once (`claimState` degrading to
 * `no-object` on an unreachable store, so the failure read as the reassuring
 * answer).
 */
export async function readCellThread(
  workItemId: string | null,
  opts: {
    harness?: string;
    limit?: number;
    getWorkItemThreadWindow?: typeof getWorkItemThreadWindow;
  } = {},
): Promise<CellThread> {
  if (!workItemId) return noSubjectThread('no work-item owns this condition, so there is no thread to read');
  const limit = opts.limit ?? CELL_THREAD_RECENT_LIMIT;
  try {
    const read = opts.getWorkItemThreadWindow ?? getWorkItemThreadWindow;
    const win = await read(workItemId, limit, opts.harness);
    if (!win) return unmeasuredThread(`work-item ${workItemId} owns this condition but could not be read`);
    const topics = toTopicPointers(win.topics, win.createdAt);
    return win.total === 0 ? silentThread(topics) : measuredThread(win.posts, win.total, topics);
  } catch (err) {
    return unmeasuredThread(`thread unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
}
