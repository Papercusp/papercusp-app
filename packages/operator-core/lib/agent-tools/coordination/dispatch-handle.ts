/**
 * dispatch-handle.ts — build a READY-TO-INVOKE `coord:dispatch` call and put it
 * inside a result the agent is already holding.
 *
 * Plan `coordination-spec-adoption-2026-08-03`, P-012 (ruling D-100, mechanism
 * corrected by D-101).
 *
 * WHY A HANDLE AND NOT A MENTION. `coord:dispatch` is the only single call that
 * assigns a lane, inlines each item's body so the receiver need not re-fetch,
 * wakes the target, and reports whether pickup actually happened — and it took
 * ONE call in 30 days, from one agent. D-100 kept it on the theory that its
 * disuse is DELIVERY rather than absent demand. D-101 then corrected HOW to fix
 * delivery: `state-plane-adoption-2026-08-02` measured that promotion — docs,
 * hints, `seeAlso` mentions — asymptoted at **1.7%**, while an affordance that
 * arrives pre-addressed inside a payload the agent already reads is what moved.
 * `coord:presence` has carried the string `'coord:dispatch (wake/dispatch a
 * parked agent you spotted)'` in its `seeAlso` for months; that mention is the
 * 1.7% mechanism, and the usage number is what it bought.
 *
 * So: no new prose. A caller that can dispatch gets the CALL, with `to`,
 * `planSlug` and `items` already filled in from state the caller's own result
 * already contains.
 *
 * ⚠ CALLER-RELATIVITY, inherited from the state-plane handles (their D-033 and
 * the `dev:pipeline_position` `plane` block): a handle emitted WITHOUT its
 * subject re-reads a DIFFERENT subject while looking authoritative. A dispatch
 * handle is only meaningful for a specific (lane → peer) pair, so when either
 * half is unresolvable this returns `unreadable: { needs }` and **no handle at
 * all** — never a plausible-looking call with a blank or guessed field. The
 * failure mode being avoided is concrete: a handle with a real `to` and an
 * empty `items` reads as "dispatch this peer" and actually fires a bare wake.
 *
 * Pure — no IO. Both call sites pass state they have already computed.
 */

/** A peer that could take a lane right now. */
export interface DispatchCandidate {
  ownerId: string;
  label?: string | null;
  sessionState?: string | null;
  wakeable?: boolean | null;
  /** Plan items the peer already holds — a busy peer is a worse target. */
  claimedItems?: readonly string[] | null;
}

/** The lane the caller could hand over. */
export interface DispatchSubject {
  planSlug?: string | null;
  items?: readonly string[] | null;
  /** Free text for the directed instruction; the caller knows its own context. */
  note?: string | null;
  harness?: string | null;
}

export interface DispatchHandle {
  tool: 'coord:dispatch';
  /** A ready call — invoke as-is, or edit `note` first. */
  call: {
    to: string;
    note: string;
    planSlug?: string;
    items?: string[];
    harness?: string;
  };
  /** Why this peer, so the caller can disagree with the choice rather than
   *  having to reverse-engineer it. */
  because: string;
  /** Other peers that could equally take it — `to` is a pick, not a verdict. */
  alsoWakeable?: string[];
}

export interface DispatchHandleUnreadable {
  /** What the handle would have needed. Deliberately the ONLY thing emitted when
   *  a field cannot be resolved — see the caller-relativity note above. */
  unreadable: { needs: 'target' | 'items' };
  why: string;
}

export type DispatchHandleResult = DispatchHandle | DispatchHandleUnreadable | null;

const MAX_ALSO = 4;

/** `parked` + `wakeable` is the canonical dispatch target (coord:presence's own
 *  guidance says so). `live` peers are excluded on purpose: dispatching a lane at
 *  an agent mid-turn races its own claim. */
export function isDispatchable(c: DispatchCandidate): boolean {
  return c.sessionState === 'parked' && c.wakeable === true;
}

/**
 * Build the handle, or say precisely what stopped it.
 *
 * Returns `null` — not an `unreadable` — when the caller is not in a
 * hand-off-shaped situation at all (no lane AND no peers). An `unreadable` is a
 * claim that a handle was WANTED and could not be completed; emitting one for
 * every idle presence read would be noise, and noise is what the mention already
 * was.
 */
export function buildDispatchHandle(
  subject: DispatchSubject,
  candidates: readonly DispatchCandidate[],
  opts: { selfOwnerId?: string | null } = {},
): DispatchHandleResult {
  const items = (subject.items ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  const targets = candidates.filter(
    (c) => c.ownerId && c.ownerId !== opts.selfOwnerId && isDispatchable(c),
  );

  // Not a hand-off situation — stay silent rather than manufacture an affordance.
  if (items.length === 0 && targets.length === 0) return null;

  if (targets.length === 0) {
    return {
      unreadable: { needs: 'target' },
      why: 'no parked+wakeable peer to hand this lane to — a live peer is mid-turn and dispatching at it races its own claim. Re-read coord:presence before dispatching, or leave the lane released for self-claim.',
    };
  }
  if (items.length === 0 || !subject.planSlug) {
    return {
      unreadable: { needs: 'items' },
      why: `${targets.length} peer(s) could take work, but no plan lane of yours resolved here — coord:dispatch assigns ITEMS, and a handle with a target but no items would fire a bare wake while reading as a hand-off. Name the plan + items yourself, or use coord:send for a plain nudge.`,
    };
  }

  // Prefer the least-loaded dispatchable peer; ties keep roster order so the
  // pick is stable between two reads of an unchanged roster.
  const ranked = [...targets].sort(
    (a, b) => (a.claimedItems?.length ?? 0) - (b.claimedItems?.length ?? 0),
  );
  const pick = ranked[0];
  const load = pick.claimedItems?.length ?? 0;
  const who = pick.label ? `${pick.label} (${pick.ownerId})` : pick.ownerId;

  return {
    tool: 'coord:dispatch',
    call: {
      to: pick.ownerId,
      note:
        subject.note?.trim() ||
        `Picking this up: ${subject.planSlug} ${items.join(', ')}. The item bodies are inlined below — claim and continue.`,
      planSlug: subject.planSlug,
      items: [...items],
      ...(subject.harness ? { harness: subject.harness } : {}),
    },
    because: `${who} is parked + wakeable and holds ${load} item(s) — the lightest dispatchable peer`,
    ...(ranked.length > 1
      ? { alsoWakeable: ranked.slice(1, 1 + MAX_ALSO).map((c) => c.ownerId) }
      : {}),
  };
}
