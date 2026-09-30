/**
 * next-pointer — DERIVE "what should a reader pick up next?" from the item
 * graph, instead of reading a stored copy of the answer.
 *
 * # Why this is derived and not stored
 *
 * A plan's `## Now` block carries a hand-written `next:` line naming the item
 * to do next. That is a SECOND COPY of a fact the item graph already owns, and
 * nothing recomputes it when an item flips terminal — so it goes stale
 * silently, and it is believed precisely because it is specific and was
 * correct when it was written.
 *
 * Measured 2026-08-31 over `harness_shared.harness_plans` (papercusp): 349
 * plans name a `P-NNN` in their stored next-pointer; 208 of those name ONLY
 * items that are already `done`/`dropped`, and 89 of those sit on a plan whose
 * status is still live. The pointer directs the reader at nothing.
 *
 * The pre-existing guard (`now-item-contradictions`) runs at WRITE time only,
 * so a pointer written while `P-001` was `todo` is never re-examined when
 * `P-001` later flips `done`. Policing a stored copy on a schedule would be
 * rung 3 of the derived-truth ladder; computing it at read time is rung 1 — it
 * cannot drift, it has no failure window, and it removes the second copy
 * rather than chasing it.
 *
 * # What this module is, and is not
 *
 * It answers ONE question — *which item* — from the graph. It deliberately
 * does not try to reproduce the author's RATIONALE ("P-001 first because it is
 * the smallest change and the highest-value"), which is real information no
 * derivation can invent. The reconciliation between this verdict and the
 * author's stored prose lives at the read surface; see
 * `plans/now-next-derivation.ts` in the operator.
 *
 * Pure + dependency-free (generic-first): item array in, verdict out. No I/O,
 * no clock, no plan-document coupling — it takes a bare `PlanItem[]` so it
 * works equally from a parsed markdown body and from the PG-canonical
 * structured items index, exactly like `resolveEffectiveStatusForItems`.
 */

import { IMPORTANCE_LEVELS, type ItemStatus, type PlanItem } from './parser';
import { resolveEffectiveStatusForItems, type ResolvedItem } from './effective-status';

/**
 * Why the pointer is what it is. The reason is part of the answer, not
 * decoration: "no item is actionable because every one is blocked" and "no
 * item is actionable because the plan is finished" are opposite situations
 * that a bare `itemId: null` cannot tell apart.
 */
export type NextPointerReason =
  /** An item is already `wip` — that IS the next thing, and pointing a second
   *  reader past it is how work gets double-placed. */
  | 'in-flight'
  /** The highest-ranked item that can be picked up right now. */
  | 'actionable'
  /** Nothing is agent-actionable; the top-ranked item awaits a human. */
  | 'needs-human'
  /** Nothing is actionable; every remaining item is blocked. */
  | 'blocked'
  /** Every item is terminal — there is no next item, by construction. */
  | 'drained'
  /** The plan has no items, so the graph has nothing to say. Callers MUST
   *  treat this as "no verdict" and leave the author's prose alone, never as
   *  "the plan is finished". */
  | 'no-items';

export interface NextPointerCandidate {
  id: string;
  effectiveStatus: ItemStatus;
  /** True when the derived needs-human band applies (see `deriveItemNeedsHuman`). */
  needsHuman: boolean;
}

export interface DerivedNextPointer {
  /** The item a reader should look at next; `null` for `drained` / `no-items`. */
  itemId: string | null;
  effectiveStatus: ItemStatus | null;
  reason: NextPointerReason;
  /** One line, ready to render where a stored `next:` would have gone. */
  text: string;
  /** Ranked non-terminal items, head first — the pointer plus what follows it,
   *  so a reader who must route past the head can do so without re-deriving.
   *  Bounded; `candidatesTruncated` reports a cut. */
  candidates: NextPointerCandidate[];
  candidatesTruncated: boolean;
  /** Unresolved blockers of the pointed-at item (empty unless `blocked`). */
  blockedOn: string[];
  /** Terminal-item census — what makes `drained` a positive answer. */
  counts: { total: number; done: number; dropped: number; nonTerminal: number };
}

/** How many ranked candidates travel with the verdict. */
const CANDIDATE_CAP = 5;
/** How much of an item's own text is quoted into the pointer line. */
const EXCERPT_CHARS = 160;

const IMPORTANCE_RANK = new Map<string, number>(IMPORTANCE_LEVELS.map((lvl, i) => [lvl, i]));

function isTerminal(status: ItemStatus): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * The derived needs-human band. Reads BOTH the derived boolean and the
 * effective token: `deriveItemNeedsHuman` is behavior-neutral until the owner
 * arms the autonomy policy, so until then a stored `needs-human` token is the
 * only signal there is — keying on the boolean alone would silently rank a
 * human-gated item as ordinary work.
 */
function awaitsHuman(item: ResolvedItem): boolean {
  return item.needsHuman || item.effectiveStatus === 'needs-human';
}

/**
 * Rank exactly the way `plans:items` does: importance (urgent→low) first, then
 * document order. Implemented as a decorate-sort-undecorate on the input index
 * rather than relying on sort stability, so the tie-break is asserted by this
 * function instead of inherited from the engine.
 */
function rank(items: ResolvedItem[]): ResolvedItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ra = IMPORTANCE_RANK.get(a.item.importance) ?? IMPORTANCE_RANK.size;
      const rb = IMPORTANCE_RANK.get(b.item.importance) ?? IMPORTANCE_RANK.size;
      return ra !== rb ? ra - rb : a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** First meaningful line of an item's text, clipped at a word boundary. */
function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= EXCERPT_CHARS) return line;
  const cut = line.slice(0, EXCERPT_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > EXCERPT_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function describe(item: ResolvedItem, lead: string): string {
  const body = excerpt(item.text);
  return body ? `${item.id} — ${lead}: ${body}` : `${item.id} — ${lead}.`;
}

/**
 * Compute the next-pointer for a plan's items.
 *
 * Band precedence — `in-flight` → `actionable` → `needs-human` → `blocked` →
 * `drained` → `no-items` — with the importance ranking applied WITHIN each
 * band. The bands come first on purpose: an `urgent` item that is blocked is
 * not a thing anyone can do, so ranking across bands would hand a reader an
 * unstartable pointer with maximum confidence.
 */
export function deriveNextPointer(items: readonly PlanItem[]): DerivedNextPointer {
  const counts = { total: items.length, done: 0, dropped: 0, nonTerminal: 0 };

  if (items.length === 0) {
    return {
      itemId: null,
      effectiveStatus: null,
      reason: 'no-items',
      text: 'none — this plan has no items, so no next-pointer can be derived from its graph.',
      candidates: [],
      candidatesTruncated: false,
      blockedOn: [],
      counts,
    };
  }

  const resolved = resolveEffectiveStatusForItems([...items]);
  for (const item of resolved.items) {
    if (item.effectiveStatus === 'done') counts.done += 1;
    else if (item.effectiveStatus === 'dropped') counts.dropped += 1;
    else counts.nonTerminal += 1;
  }

  const live = rank(resolved.items.filter((it) => !isTerminal(it.effectiveStatus)));
  const candidates = live.slice(0, CANDIDATE_CAP).map((it) => ({
    id: it.id,
    effectiveStatus: it.effectiveStatus,
    needsHuman: awaitsHuman(it),
  }));
  const shared = {
    candidates,
    candidatesTruncated: live.length > CANDIDATE_CAP,
    counts,
  };

  if (live.length === 0) {
    return {
      itemId: null,
      effectiveStatus: null,
      reason: 'drained',
      text:
        `none — every item is terminal (${counts.done} done, ${counts.dropped} dropped). ` +
        'There is no next item to point at; if the plan is not finished, it needs new items, not a new pointer.',
      blockedOn: [],
      ...shared,
    };
  }

  const inFlight = live.find((it) => it.effectiveStatus === 'wip');
  if (inFlight) {
    return {
      itemId: inFlight.id,
      effectiveStatus: inFlight.effectiveStatus,
      reason: 'in-flight',
      text: describe(inFlight, 'already in flight (wip)'),
      blockedOn: [],
      ...shared,
    };
  }

  const actionable = live.find((it) => it.effectiveStatus === 'todo' && !awaitsHuman(it));
  if (actionable) {
    return {
      itemId: actionable.id,
      effectiveStatus: actionable.effectiveStatus,
      reason: 'actionable',
      text: describe(
        actionable,
        `the highest-ranked actionable item (importance: ${actionable.importance})`,
      ),
      blockedOn: [],
      ...shared,
    };
  }

  const human = live.find(awaitsHuman);
  if (human) {
    return {
      itemId: human.id,
      effectiveStatus: human.effectiveStatus,
      reason: 'needs-human',
      text: describe(human, 'awaiting a human decision — nothing here is agent-actionable'),
      blockedOn: human.unresolvedBlockers,
      ...shared,
    };
  }

  // Everything left is blocked. Point at the highest-ranked one and name what
  // it waits on, so the reader's next move is to go clear a blocker rather
  // than to pick up an item that will refuse them.
  const blocked = live[0]!;
  const on = blocked.unresolvedBlockers;
  return {
    itemId: blocked.id,
    effectiveStatus: blocked.effectiveStatus,
    reason: 'blocked',
    text: describe(
      blocked,
      on.length > 0
        ? `blocked on ${on.join(', ')} — nothing in this plan is actionable until a blocker resolves`
        : 'blocked (externally) — nothing in this plan is actionable until it clears',
    ),
    blockedOn: on,
    ...shared,
  };
}
