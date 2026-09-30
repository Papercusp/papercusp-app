/**
 * presence-transition-commitments — the IO half of the P-039 presence emitter
 * (context-injection-audit-2026-07-28, design settled in D-012).
 *
 * Answers exactly one question, for a small set of agents that just crossed into
 * a bad liveness state: WHO ELSE has already committed something to them? That
 * set is the emitter's entire audience — see the self-budgeting argument in
 * `presence-transition-emitter.ts`.
 *
 * THE THREE CLASSES D-012 NAMES, and what the live corpus says about each
 * (measured 2026-08-02 against the operator DB before this was written — the
 * repo's "run the real SQL before believing a premise about a corpus" rule):
 *
 *   (a) awaiting-reply      — 149 directed messages in 7d carry an explicit
 *                             expects=action/answer/ack from 30+ distinct
 *                             senders. THE DOMINANT CLASS by an order of
 *                             magnitude, and the cheapest: it reuses
 *                             `fetchUnansweredDirected` verbatim.
 *   (b) blocked-on-lock     — 26 lock awaits in 7d across 19 subscribers. Real
 *                             but modest. Crosses into the SEPARATE locks
 *                             database, so it is fail-soft on its own.
 *   (c) awaiting-held-item  — RARE. Of 104 work-item awaits in 14d that resolve
 *                             to a real item, 103 were on an UNHELD item and
 *                             exactly ONE on an item held by another agent.
 *                             Wired anyway: it is cheap (one join in the DB we
 *                             are already querying) and it is the highest-value
 *                             case when it does fire, because the await is
 *                             parked FOREVER — the emitter of the event it
 *                             waits for is the agent that just died.
 *
 * ⚠ THE (c) MEASUREMENT IS A POINT-IN-TIME SNAPSHOT and cannot see a
 * claim-then-die history: it reads `taken_by` as of the query, so an item that
 * was held when the await was placed and released on completion reads as
 * "unheld". Treat 103/104 as evidence the class is SMALL, not as proof it is
 * empty — which is the other reason it is wired rather than dropped.
 *
 * EVERY LEG IS BEST-EFFORT. This runs inside a periodic sweep whose failure must
 * degrade to silence, never to a thrown sweep: a leg that cannot read resolves to
 * an empty list. A missed alert costs one slower notice (the receiver still has
 * `coord:orient` and its own polling); a thrown sweep costs every alert.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Commitment } from './presence-transition-emitter';
import { extractWorkItemIds, TERMINAL_WORK_ITEM_STATES } from './agent-tools/work_items/mirror-guard';
import {
  fetchUnansweredDirected,
  UNANSWERED_LOOKBACK_MS,
} from './agent-tools/coordination/unanswered-directed';

/**
 * A single receiver can legitimately hold many commitments on one dying peer;
 * the pure joiner already collapses them to one line. This bounds the SQL and
 * the per-subject fan-out so a pathological row count cannot make a sweep
 * expensive.
 */
const MAX_COMMITMENTS_PER_SUBJECT = 50;

/**
 * Resolve the work-items named by awaiting-reply summaries in one bounded read.
 * `null` means the read failed; callers must keep the commitments in that case
 * because an infra error is not evidence that a blocker is stale.
 *
 * Work-item ids are the unified table's global feature_id key, so this lookup
 * deliberately does not reuse event_awaits.workspace_id (which is the corpus
 * partition literal `default`, not the active coordination workspace).
 */
interface ReferencedWorkItemLookup {
  /** Rows that resolved, including rows whose status was unexpectedly null. */
  found: Set<string>;
  /** Known non-null statuses for the resolved rows. */
  states: Map<string, string>;
}

async function readReferencedWorkItemStates(
  ids: readonly string[],
): Promise<ReferencedWorkItemLookup | null> {
  if (ids.length === 0) return { found: new Set(), states: new Map() };
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ feature_id: string; status: string | null }[]>`
      SELECT feature_id, status
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${[...ids]})
    `;
    return {
      found: new Set(
        rows
          .filter((row) => row.feature_id)
          .map((row) => row.feature_id.toUpperCase()),
      ),
      states: new Map(
      rows
        .filter((row) => row.feature_id && row.status)
        .map((row) => [row.feature_id.toUpperCase(), row.status as string]),
      ),
    };
  } catch {
    return null;
  }
}

/**
 * A reply commitment whose summary names only settled or missing work is a
 * stale wait edge. Keep summaries with no work-item reference, with a live
 * reference, or when the lookup itself failed (fail-open on uncertainty).
 */
function referencesLiveWorkItem(
  summary: string | undefined,
  lookup: ReferencedWorkItemLookup,
): boolean {
  const ids = extractWorkItemIds(summary ?? '');
  if (ids.length === 0) return true;
  return ids.some((id) => {
    if (!lookup.found.has(id)) return false;
    const state = lookup.states.get(id);
    return state === undefined || !TERMINAL_WORK_ITEM_STATES.has(state.toLowerCase());
  });
}

/**
 * (a) Who is still awaiting a reply FROM one of these agents?
 *
 * REUSE, NOT RE-DERIVATION — this is the whole reason the class is cheap.
 * `fetchUnansweredDirected` is keyed BY RECIPIENT and returns, for each, the
 * still-unanswered asks with the `from` of whoever sent them. Asking it about
 * the DYING agent therefore yields precisely the correspondents left hanging:
 * the recipient is the subject, and each entry's `from` is a receiver.
 *
 * What that reuse buys is not lines of code but CORRECTNESS. That module's
 * definition of "unanswered" is the settled output of three separate
 * postmortems — WI-4537 (excluding machine lifecycle chatter, machine senders
 * and the ack-ping-pong), EI-13819 (accepting an untethered reply, which had
 * left real exchanges falsely stuck) and WI-6729 (re-bounding that branch after
 * it began silently DROPPING live obligations). A hand-rolled "did they reply?"
 * query here would reintroduce every one of those bugs, in a surface whose
 * false positives interrupt a working agent.
 */
async function gatherAwaitingReply(subjectIds: readonly string[]): Promise<Commitment[]> {
  try {
    const byRecipient = await fetchUnansweredDirected([...subjectIds], {
      lookbackMs: UNANSWERED_LOOKBACK_MS,
      perRecipientCap: MAX_COMMITMENTS_PER_SUBJECT,
    });
    const entries = [...byRecipient].flatMap(([subjectId, summary]) =>
      summary.newest.map((entry) => ({ subjectId, entry })),
    );
    const referencedIds = [
      ...new Set(entries.flatMap(({ entry }) => extractWorkItemIds(entry.summary ?? ''))),
    ];
    const lookup = await readReferencedWorkItemStates(referencedIds);
    if (lookup === null) {
      // Keep the old fail-soft behavior: a DB read failure cannot turn into a
      // false claim that a waiting agent's work has already settled.
      return entries.flatMap(({ subjectId, entry }) => {
        if (!entry.from) return [];
        return [{
          receiverId: entry.from,
          subjectId,
          kind: 'awaiting-reply' as const,
          detail: entry.summary ? clip(entry.summary, 60) : entry.msgId,
        }];
      });
    }
    const out: Commitment[] = [];
    for (const { subjectId, entry } of entries) {
      if (!entry.from || !referencesLiveWorkItem(entry.summary, lookup)) continue;
      out.push({
          receiverId: entry.from,
          subjectId,
          kind: 'awaiting-reply',
          detail: entry.summary ? clip(entry.summary, 60) : entry.msgId,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * (c) Who has an ARMED await on a work-item one of these agents is holding?
 *
 * The await keys are id-scoped (`work-item:done:<id>`, `claim:released:<id>`),
 * so the item id is the key's last segment and joins straight to
 * `harness_shared.work_items.feature_id`.
 *
 * ⚠ `event_awaits.workspace_id` is `'default'` for 100% of its 32,152 rows —
 * NOT the workspace slug. The `dev:pg_query` tenant advisory recommends adding
 * `workspace_id = 'papercusp-workspace'` to a filtered read of this table, and
 * doing so returns ZERO rows: a silent false "nobody is awaiting anything",
 * indistinguishable from a healthy empty result. So this query deliberately
 * does NOT scope on workspace here, and the `taken_by` join is what makes it
 * specific. (Same failure shape as the corpus-recall scope trap in P-008.)
 */
async function gatherAwaitingHeldItem(subjectIds: readonly string[]): Promise<Commitment[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      { subscriber_id: string; taken_by: string; item_id: string; title: string | null }[]
    >`
      SELECT a.subscriber_id,
             w.taken_by,
             w.feature_id AS item_id,
             w.title
        FROM harness_shared.event_awaits a
        JOIN harness_shared.work_items w
          ON w.feature_id = split_part(a.event_key, ':', 3)
       WHERE a.fired_at IS NULL
         AND a.cancelled_at IS NULL
         AND a.superseded_at IS NULL
         AND (a.expires_ts IS NULL OR a.expires_ts > now())
         AND (a.event_key LIKE 'work-item:%' OR a.event_key LIKE 'claim:%')
         AND w.taken_by = ANY(${[...subjectIds]}::text[])
         AND a.subscriber_id <> w.taken_by
       LIMIT ${MAX_COMMITMENTS_PER_SUBJECT * Math.max(1, subjectIds.length)}
    `;
    return rows.map((r) => ({
      receiverId: r.subscriber_id,
      subjectId: r.taken_by,
      kind: 'awaiting-held-item' as const,
      detail: r.title ? `${r.item_id} (${clip(r.title, 40)})` : r.item_id,
    }));
  } catch {
    return [];
  }
}

/**
 * (b) Who is queued in the lock waiter list behind a lock one of these agents
 * holds?
 *
 * Lives in the SEPARATE locks database (`@papercusp/locks`, its own
 * coordination-domain store), not the operator DB the other two legs read — so
 * it is imported lazily and fails soft on its own. `coordinationDomain: null`
 * reads every domain (WI-5979's diagnostic form), which is right here: a sweep
 * is host-wide and has no single domain of its own.
 *
 * The intersection is path overlap — a waiter is blocked on a subject when any
 * path it is waiting for is currently held by that subject.
 */
async function gatherBlockedOnLock(subjectIds: readonly string[]): Promise<Commitment[]> {
  try {
    const subjects = new Set(subjectIds);
    const { ensureBootstrap, getTxPool, readQueue } = await import('./agent-tools/locks/su-lock-store');
    await ensureBootstrap();
    const queue = await readQueue(getTxPool(), { coordinationDomain: null });

    // path → the subject holding it (only paths held by a transitioned agent).
    const heldBySubject = new Map<string, string>();
    for (const lock of queue.active_locks ?? []) {
      if (subjects.has(lock.owner)) heldBySubject.set(lock.path, lock.owner);
    }
    if (heldBySubject.size === 0) return [];

    const out: Commitment[] = [];
    for (const waiter of queue.waiting ?? []) {
      if (waiter.status !== 'waiting') continue;
      for (const path of waiter.paths ?? []) {
        const holder = heldBySubject.get(path);
        if (!holder || holder === waiter.owner) continue;
        out.push({
          receiverId: waiter.owner,
          subjectId: holder,
          kind: 'blocked-on-lock',
          detail: clip(path, 60),
        });
        break; // one commitment per waiter — the line names the first blocking path
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve every commitment held ON the given transitioned agents, across all
 * three classes. Legs run CONCURRENTLY and independently: one failing leg
 * silences only itself, so a locks-database hiccup never suppresses the
 * dominant awaiting-reply class.
 */
export async function gatherCommitmentsOn(subjectIds: readonly string[]): Promise<Commitment[]> {
  if (subjectIds.length === 0) return [];
  const legs = await Promise.all([
    gatherAwaitingReply(subjectIds),
    gatherBlockedOnLock(subjectIds),
    gatherAwaitingHeldItem(subjectIds),
  ]);
  return legs.flat();
}

/** Collapse whitespace and bound a fragment destined for a one-line notice. */
function clip(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
