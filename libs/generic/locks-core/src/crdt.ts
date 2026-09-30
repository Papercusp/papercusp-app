/**
 * CRDT primitives for the federation (D-004,
 * locks-correctness-hardening-2026-06-04).
 *
 * Naive last-write-wins silently DROPS concurrent updates on non-scalar
 * content: a counter undercounts (two peers each +1 at the same ms → one is
 * lost), a set edit drops an element (concurrent tag/member adds clobber each
 * other), a co-edited body gets wholesale overwritten. The fix is to merge by
 * TYPE rather than overwrite by timestamp:
 *
 *   - PN-Counter   — tallies / spend (commutative add + subtract).
 *   - OR-Set       — sets with add-wins semantics (tags, members, watchers,
 *                    relations): a concurrent add beats a concurrent remove.
 *   - LWW-Register — genuinely scalar fields, but keyed on an HLC (not a wall
 *                    clock) and applied PER FIELD, not per whole record.
 *   - Version vector / DVV — DETECT concurrency (vs a causal succession) so a
 *                    truly-concurrent change is routed to the merge-resolver
 *                    instead of being clobbered (→ Causal+ consistency).
 *
 * Every type here is a state-based (convergent) CRDT: `merge` is commutative,
 * associative, and idempotent, so replicas converge regardless of delivery
 * order or duplication — which is exactly what the at-least-once outbox drain
 * delivers. The states are plain JSON so they ride the existing outbox as
 * δ-CRDTs. Co-edited prose (a sequence CRDT — Yjs/Automerge/Loro) is the one
 * type NOT implemented here: it carries a runtime + persistence format of its
 * own and is intentionally deferred ("text last", per the plan); use
 * {@link LwwRegister} for scalar text until then. Code stays on git +
 * merge-resolver.
 *
 * PURE module (no PG, no I/O) — exhaustively unit-testable.
 */

import { compareHlc, type Hlc } from './hlc';

export type ActorId = string;

// ───────────────────────── Version vector / DVV ─────────────────────────

/** A version vector: per-actor event count. Missing actor ⇒ 0. */
export type VersionVector = Record<ActorId, number>;

export type VvOrder = 'equal' | 'dominates' | 'dominated' | 'concurrent';

/**
 * Causal comparison of two version vectors:
 *   - 'equal'      — identical histories.
 *   - 'dominates'  — `a` has seen everything `b` has, and strictly more (a ≥ b,
 *                    a ≠ b). `a` causally succeeds `b`.
 *   - 'dominated'  — the mirror (`b` dominates `a`).
 *   - 'concurrent' — neither has seen all of the other: a genuine conflict that
 *                    must go to the merge-resolver, NOT be clobbered.
 */
export function vvCompare(a: VersionVector, b: VersionVector): VvOrder {
  let aGreater = false;
  let bGreater = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av > bv) aGreater = true;
    else if (av < bv) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'dominates';
  if (bGreater) return 'dominated';
  return 'equal';
}

/** Pointwise max — the join of two version vectors. */
export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

/** Return a copy of `vv` with `actor`'s counter incremented (a new local event). */
export function vvIncrement(vv: VersionVector, actor: ActorId): VersionVector {
  return { ...vv, [actor]: (vv[actor] ?? 0) + 1 };
}

/** True iff `vv` has observed the event `(actor, counter)`. */
export function vvSeen(vv: VersionVector, actor: ActorId, counter: number): boolean {
  return (vv[actor] ?? 0) >= counter;
}

/**
 * A Dotted Version Vector (Preguiça et al.): the causal context `vv` PLUS the
 * single `dot` `(actor, counter)` that identifies THIS write. DVVs let a single
 * peer hold multiple concurrent siblings without false-merging them — the
 * precise tool for multi-writer-per-peer. `dot.counter` is always `vv[actor]+1`
 * at creation, i.e. the dot extends the context by exactly one event.
 */
export interface Dvv {
  context: VersionVector;
  dot: { actor: ActorId; counter: number };
}

/** Create a DVV for a new event by `actor` against causal `context`. */
export function dvvNew(context: VersionVector, actor: ActorId): Dvv {
  const counter = (context[actor] ?? 0) + 1;
  return { context: { ...context }, dot: { actor, counter } };
}

/** Does `a` causally descend from (dominate-or-equal) `b`'s dot? i.e. has `a`'s
 *  context already absorbed `b`'s write — so `b` is obsolete, not concurrent. */
export function dvvDescends(a: Dvv, b: Dvv): boolean {
  return vvSeen(a.context, b.dot.actor, b.dot.counter);
}

/** True when two DVVs are genuinely concurrent (neither absorbs the other). */
export function dvvConcurrent(a: Dvv, b: Dvv): boolean {
  return !dvvDescends(a, b) && !dvvDescends(b, a);
}

// ───────────────────────── G-Counter / PN-Counter ─────────────────────────

/** Grow-only counter: per-actor monotonic tallies; value = sum. */
export type GCounter = Record<ActorId, number>;

export function gCounterValue(g: GCounter): number {
  let s = 0;
  for (const v of Object.values(g)) s += v;
  return s;
}

export function gCounterInc(g: GCounter, actor: ActorId, by = 1): GCounter {
  if (by < 0) throw new Error('gCounterInc: increment must be non-negative');
  return { ...g, [actor]: (g[actor] ?? 0) + by };
}

export function gCounterMerge(a: GCounter, b: GCounter): GCounter {
  const out: GCounter = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

/** PN-Counter: a pair of G-Counters (P=increments, N=decrements). value=ΣP−ΣN.
 *  Merge is pointwise max on each half, so concurrent +1 / −1 from different
 *  actors both survive (the bug naive LWW causes — one is lost — cannot happen). */
export interface PnCounter {
  p: GCounter;
  n: GCounter;
}

export const pnZero = (): PnCounter => ({ p: {}, n: {} });

export function pnValue(c: PnCounter): number {
  return gCounterValue(c.p) - gCounterValue(c.n);
}

export function pnInc(c: PnCounter, actor: ActorId, by = 1): PnCounter {
  return by >= 0
    ? { p: gCounterInc(c.p, actor, by), n: c.n }
    : { p: c.p, n: gCounterInc(c.n, actor, -by) };
}

export function pnDec(c: PnCounter, actor: ActorId, by = 1): PnCounter {
  return pnInc(c, actor, -by);
}

export function pnMerge(a: PnCounter, b: PnCounter): PnCounter {
  return { p: gCounterMerge(a.p, b.p), n: gCounterMerge(a.n, b.n) };
}

// ───────────────────────── OR-Set (add-wins) ─────────────────────────

/**
 * Observed-Remove Set. Each add mints a globally-unique tag; an element is
 * present iff it has ≥1 tag that no observed remove has tombstoned. A concurrent
 * add+remove resolves ADD-WINS: the remove only tombstones the tags it has
 * OBSERVED, so the concurrent add's fresh tag survives. State is two tag sets,
 * stored as string arrays for JSON transport.
 */
export interface OrSet<T extends string = string> {
  /** Present (element, tag) pairs, encoded `tag` → element. */
  adds: Record<string, T>;
  /** Tombstoned tags (observed removes). */
  removes: string[];
}

export const orSetEmpty = <T extends string = string>(): OrSet<T> => ({ adds: {}, removes: [] });

/** Add `elem` with a caller-supplied globally-unique `tag` (e.g. `actor:counter`). */
export function orSetAdd<T extends string>(s: OrSet<T>, elem: T, tag: string): OrSet<T> {
  return { adds: { ...s.adds, [tag]: elem }, removes: s.removes };
}

/** Remove `elem`: tombstone every tag currently observed for it (observed-remove). */
export function orSetRemove<T extends string>(s: OrSet<T>, elem: T): OrSet<T> {
  const tombstone = Object.entries(s.adds)
    .filter(([, e]) => e === elem)
    .map(([tag]) => tag);
  return { adds: s.adds, removes: [...new Set([...s.removes, ...tombstone])] };
}

/** The live element set: elements with at least one non-tombstoned tag. */
export function orSetValues<T extends string>(s: OrSet<T>): T[] {
  const dead = new Set(s.removes);
  const live = new Set<T>();
  for (const [tag, elem] of Object.entries(s.adds)) if (!dead.has(tag)) live.add(elem);
  return [...live];
}

export function orSetHas<T extends string>(s: OrSet<T>, elem: T): boolean {
  const dead = new Set(s.removes);
  return Object.entries(s.adds).some(([tag, e]) => e === elem && !dead.has(tag));
}

/** Merge = union of adds + union of removes. Commutative/associative/idempotent. */
export function orSetMerge<T extends string>(a: OrSet<T>, b: OrSet<T>): OrSet<T> {
  return {
    adds: { ...a.adds, ...b.adds },
    removes: [...new Set([...a.removes, ...b.removes])],
  };
}

// ───────────────────────── LWW-Register (HLC-keyed, per-field) ─────────────────────────

/**
 * Last-writer-wins register keyed on an HLC (D-003) rather than a wall clock,
 * applied PER FIELD. A write carries `{ value, hlc, actor }`; merge keeps the
 * greater HLC, breaking an exact-HLC tie by the higher `actor` (a clock-
 * independent, deterministic, peer-stable tiebreak) so every replica converges
 * to the same winner. This is the correct primitive for a genuinely scalar
 * field (status, title) — used per field so two peers editing DIFFERENT fields
 * of the same record never clobber each other.
 */
export interface LwwRegister<V> {
  value: V;
  hlc: Hlc;
  actor: ActorId;
}

export function lwwSet<V>(value: V, hlc: Hlc, actor: ActorId): LwwRegister<V> {
  return { value, hlc, actor };
}

/** Pick the winning register: greater HLC, then greater actor on an exact tie. */
export function lwwMerge<V>(a: LwwRegister<V>, b: LwwRegister<V>): LwwRegister<V> {
  const c = compareHlc(a.hlc, b.hlc);
  if (c > 0) return a;
  if (c < 0) return b;
  return a.actor >= b.actor ? a : b;
}

// ───────────────────────── Conflict routing (→ merge-resolver) ─────────────────────────

export type MergeDecision =
  | { kind: 'apply' } // incoming causally succeeds local — apply (Thomas Write Rule satisfied)
  | { kind: 'drop' } // incoming is causally dominated by / equal to local — drop (stale re-upsert)
  | { kind: 'conflict' }; // concurrent — route to the merge-resolver, do NOT clobber

/**
 * Decide what to do with an INCOMING write given the LOCAL state's version
 * vector — the seam that replaces blind clobbering with Causal+ behaviour.
 * 'apply'/'drop' is the Thomas Write Rule (only the causally-later write lands);
 * 'conflict' is the case naive LWW silently loses and we instead escalate.
 */
export function decideMerge(localVv: VersionVector, incomingVv: VersionVector): MergeDecision {
  switch (vvCompare(incomingVv, localVv)) {
    case 'dominates':
      return { kind: 'apply' };
    case 'dominated':
    case 'equal':
      return { kind: 'drop' };
    case 'concurrent':
      return { kind: 'conflict' };
  }
}
