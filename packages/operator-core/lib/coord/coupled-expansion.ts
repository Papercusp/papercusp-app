/**
 * coupled-expansion.ts — the ONE projection that turns resolved coupled peers
 * into `coord:presence`'s `expanded[]` block.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-031 leg (d) — the UNION CONSUMER.
 *
 * WHY THIS EXISTS. P-031 legs (a)–(c) gave coupling a store, two tools, and the
 * pure union {@link resolveCoupledPeers} — but nothing CALLED the union, so a
 * declared edge changed no read's output while `COUPLING_NOTE` was already
 * telling every agent that coupled peers see each other's working state. This
 * closes that gap: it is the first consumer, and by construction the only place
 * the union is turned into a payload.
 *
 * ⚠ D-053 IS THE CONTRACT AND IT IS NOT NEGOTIABLE. `coord:presence` returns a
 * BYTE-IDENTICAL BASE PAYLOAD FOR EVERY CALLER plus an APPENDED `expanded[]`
 * block. Coupling decides only WHO appears in that block — never what the base
 * rows contain, never their order, never their fields. This module therefore
 * takes the already-assembled roster rows as INPUT and only reads from them; it
 * has no way to mutate the base even by accident.
 *
 * IT IS A PROJECTION, NOT A BUILD — every state field below is copied from the
 * roster row the caller is ALREADY being sent. There is no second query, no new
 * capture, and nothing disclosed here that the base payload does not already
 * disclose to this same reader. The block's whole job is to say WHICH of those
 * peers matter to you and WHY.
 *
 * ⚠ WHAT IS DELIBERATELY ABSENT: `goal` and `assumptions`. D-053 says an
 * `expanded[]` entry carries the peer's current goal + live assumptions PROJECTED
 * FROM P-016's goal cell via `getCell(cell, reader)`. P-016 (goal as a cell) and
 * P-008 (assumptions as agent_facts at scope `work_item`) are both unbuilt, so
 * there is no honest source for either field today. The available near-miss —
 * `coord_presence.intent` — is the agent's DECLARED INTENT, not its goal, and it
 * is emitted here under that name only. Naming a declared intent `goal` would
 * repeat exactly the error P-029 caught: a populated field is not a meaningful
 * field, and a mechanism string dressed as a goal is worse than an honest null.
 * When P-016 lands, `goal` is ADDED here — it does not silently reinterpret
 * `intent`.
 *
 * ⚠ REACHING BEYOND THE ROSTER IS A LEAK, NOT A FEATURE. A coupled peer outside
 * the caller's presence scope (another hive, or an `ended` row the roster
 * filters) is emitted with `inRoster: false` and NULL state — never back-filled
 * from a wider query. Coupling is a RELEVANCE gate, never an ACCESS grant
 * (D-044, and the same rule couplings.ts states for the write side): it may
 * re-rank what a reader can already see, and it may never widen it. Dropping
 * such a peer silently was the other option and is worse — an agent that
 * coupled a peer and then cannot find it would read the tool as broken.
 */
import type { CoupledPeer } from './couplings';

/** Default cap on emitted entries. D-051's per-entry bound survives: a block
 *  bounded BY COUPLING is not the same as a block bounded PER ENTRY, and a
 *  third-party coupler can declare arbitrarily many edges against one agent. */
export const COUPLED_EXPANSION_MAX = 25;

/** One coupled peer, as `coord:presence` renders it. */
export interface CoupledExpansionEntry {
  ownerId: string;
  /** Why the reader is seeing this peer — the field P-013's contract requires. */
  expandedBecause: string;
  /** Which half(s) of the union produced the edge. */
  source: CoupledPeer['source'];
  /** The stated why of a declared edge, and who stated it. Absent when derived. */
  reason?: string | null;
  declaredBy?: string;
  /** False ⇒ the peer is coupled but outside this read's scope; state is null. */
  inRoster: boolean;
  ownerLabel: string | null;
  sessionState: string | null;
  /**
   * The peer's DECLARED INTENT, copied verbatim from its base roster row — which
   * has already normalized the placeholder sentinel to null and already baked in
   * the `[idle …]` staleness prefix. NOT a goal (see the header note).
   */
  intent: string | null;
  intentStale: boolean | null;
  lastActiveSecAgo: number | null;
}

export interface CoupledExpansion {
  expanded: CoupledExpansionEntry[];
  /** Coupled peers resolved, BEFORE the cap — so a cut is visible, not silent. */
  total: number;
  truncated: boolean;
}

/** The roster row shape this projection reads. Structural on purpose: it accepts
 *  the emitted row as-is, so no field is re-derived and none can drift. */
interface RosterRowLike {
  ownerId?: unknown;
  ownerLabel?: unknown;
  sessionState?: unknown;
  intent?: unknown;
  intentStale?: unknown;
  lastActiveSecAgo?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Render `expandedBecause`. Total: every source has a phrasing, and a declared
 * edge with no stated reason still explains itself (who declared it is the
 * minimum useful answer — that is what `declaredBy` is for).
 */
export function expandedBecauseOf(peer: CoupledPeer): string {
  const why = (peer.reason ?? '').trim();
  const by = (peer.declaredBy ?? '').trim();
  // D-078 (a): a derivation now names the SIGNAL that fired. When it supplies
  // none, each branch keeps its ORIGINAL phrasing verbatim — an unlabelled
  // derivation is still a true edge, and widening the channel must not reword
  // output that no derivation has opted into yet.
  const signal = (peer.derivedBecause ?? '').trim();
  switch (peer.source) {
    case 'declared':
      return why
        ? `coupled — declared by ${by || 'an agent'}: ${why}`
        : `coupled — declared by ${by || 'an agent'}`;
    case 'both': {
      const head = signal || 'derived';
      return why
        ? `coupled — ${head}, and declared by ${by || 'an agent'}: ${why}`
        : `coupled — ${head}, and declared by ${by || 'an agent'}`;
    }
    case 'derived':
    default:
      return `coupled — ${signal || 'derived from shared working state'}`;
  }
}

/**
 * Project resolved coupled peers into the `expanded[]` block.
 *
 * PURE AND TOTAL: both inputs are passed in, nothing is fetched, and a peer
 * missing from `rows` yields an honest `inRoster: false` entry rather than a
 * throw or a silent drop. Unit-testable without PG, like `resolveCoupledPeers`
 * and `claim-holder.ts` before it.
 *
 * Order is the caller-independent `resolveCoupledPeers` order (ownerId-sorted),
 * so two readers coupled to the same peers see the same sequence.
 */
export function buildCoupledExpansion(
  peers: readonly CoupledPeer[],
  rows: readonly unknown[],
  opts?: { max?: number },
): CoupledExpansion {
  const max = opts?.max != null && opts.max > 0 ? Math.floor(opts.max) : COUPLED_EXPANSION_MAX;
  const byId = new Map<string, RosterRowLike>();
  for (const r of rows) {
    const row = (r ?? {}) as RosterRowLike;
    const id = str(row.ownerId);
    if (id && !byId.has(id)) byId.set(id, row);
  }
  const total = peers.length;
  const expanded = peers.slice(0, max).map((peer): CoupledExpansionEntry => {
    const row = byId.get(peer.ownerId);
    const entry: CoupledExpansionEntry = {
      ownerId: peer.ownerId,
      expandedBecause: expandedBecauseOf(peer),
      source: peer.source,
      inRoster: !!row,
      ownerLabel: row ? str(row.ownerLabel) : null,
      sessionState: row ? str(row.sessionState) : null,
      intent: row ? str(row.intent) : null,
      intentStale: row ? bool(row.intentStale) : null,
      lastActiveSecAgo: row ? num(row.lastActiveSecAgo) : null,
    };
    // Declared-edge provenance rides only on a declared edge — a derived entry
    // carries no `declaredBy`, so the two halves stay distinguishable.
    if (peer.source !== 'derived') {
      entry.reason = peer.reason ?? null;
      if (peer.declaredBy) entry.declaredBy = peer.declaredBy;
    }
    return entry;
  });
  return { expanded, total, truncated: total > expanded.length };
}
