'use client';

/**
 * useAgentOrders — the ORDERS half of the session popup's two-panel dossier
 * (session-chat-popup-direction-d-2026-08-02 P-011, owner ask 2026-08-02).
 *
 * Sibling of `use-agent-detail.ts`, and deliberately a SECOND named query
 * (`agentOrders.byOwner`) rather than more legs on `agentDetail.byOwner`: the
 * server-side gather runs buildCarryBrief (directives, walls, checkpoints,
 * cited-ref hydration), while this panel is independently toggleable and
 * collapses first on a narrow viewport. Folding it in would charge every popup
 * for a panel it may never show.
 *
 * ⚠ WIRE CONTRACT — read before adding a field. This ENTIRE payload is new, so
 * an operator that predates it serves `agentOrders.byOwner` as an unknown query
 * and this hook resolves to `null`. Every consumer must render that as "not
 * available from this operator", never as "the agent has no orders". Within the
 * payload, the same rule `use-agent-detail.ts` documents for `coord.unread`
 * applies to every field here: declare it OPTIONAL, because the SPA rebuilds on
 * the vite hot path while the sidecar only reloads on restart, so a bundle that
 * knows about a field is routinely served payloads that predate it. Reading
 * `.length` off a required-but-absent array is what once took down the whole
 * hud tab.
 */

import { useSyncQuery } from '@papercusp/sync';
import type { RecordedOrientDisclosures } from './Disclosures';

// ── Server DTO mirror (packages/operator-core/lib/adv-agent-orders.ts).
//    Inlined, not imported, so this client module never pulls the PG-backed
//    server module into the SPA bundle — same rationale as use-agent-detail.ts.

/** Which orders signal's read THREW this call. A key present here means
 *  "we could not ask", which is a different conclusion from "there is none". */
export type AgentOrdersSignalKey =
  | 'mission'
  | 'modes'
  | 'wakeMode'
  | 'carry'
  | 'disclosures'
  | 'obligationRows';

/**
 * One rendered line of the SHARED obligation + delta projection (P-018).
 *
 * Mirrors `OrientationRow` in packages/operator-core/lib/turn-start-orientation.ts
 * — the projection `renderOrientationLines` itself delegates to — so the Orders
 * rail and the agent's own turn-start block render from ONE object and cannot
 * disagree about "what was this agent told".
 *
 * Inlined rather than imported for the same reason as every type above: this
 * client module must not pull the PG-backed server module into the SPA bundle.
 */
export interface OrientationRow {
  /** The registry class that emitted this row. Widened to `string` on purpose:
   *  the server's `keyof OrientationState` grows as classes are added (P-013..
   *  P-016 are adding four right now), and a client union would reject a row
   *  from a NEWER operator — dropping real obligations on the floor, which is
   *  the one failure this panel exists to prevent. */
  classId: string;
  /** The class segment's emission order — ascending, the shared priority rule. */
  order: number;
  /** The rendered line, verbatim. */
  text: string;
}

export interface AgentOrdersMission {
  constraint: string | null;
  source: string | null;
  explanation: string | null;
  /** confirm-before-execution vs act-and-report — the agent's current authority. */
  authority: string | null;
  authoritySource: string | null;
  route: string | null;
  /** Generic playbook rules explicitly suppressed right now, and why. Nothing
   *  else in the UI can answer "why is this agent ignoring that rule?". */
  suppressed?: Array<{ key: string; value: string; source: string; reason: string }>;
}

export interface AgentOrdersMode {
  mode: string;
  reason: string | null;
  setBy: string | null;
  /** Owner-directed vs the agent setting it on itself — different authority. */
  ownerDirected: boolean;
  setAt: string | null;
}

export interface AgentOrdersWakeMode {
  effective: string;
  overridden: boolean;
  defaultMode: string;
}

export interface AgentOrdersDirective {
  id: number;
  verbatimText: string;
  recordedBy: string;
  createdAtMs: number;
  sourceTurnRef: string | null;
  dispositionStatus: string | null;
}

export interface AgentOrdersFact {
  key: string;
  body: string;
  sourceRef?: string | null;
  possiblyStale?: boolean;
  /**
   * P-011: other agents already wrote to this key, or a prior version was settled
   * UNDECIDABLE (server: contested-fold.ts). ORTHOGONAL to `possiblyStale` —
   * that one says the fact's own source moved underneath it, this one says people
   * disagreed about the answer — so both render, and neither collapses into a
   * single "suspect" badge that would lose which question to go settle.
   *
   * Absent when uncontested, never `false`: the fold reads only superseded rows,
   * so its silence means "no dispute in the version chain", not "verified agreed",
   * and a reassuring "uncontested" badge would claim the second.
   *
   * Every field OPTIONAL, per the standing wire-skew convention — the SPA rebuilds
   * on the vite hot path while the sidecar reloads only on restart.
   */
  contested?: {
    settledUndecidable?: boolean;
    settledBy?: string | null;
    priorAuthors?: string[];
    priorVersions?: number;
    note?: string;
  };
}

/** An owner-gated blocker. `claim` is the ask; `recheck` is the probe that
 *  tests whether it still stands. Mirrors WallEntry (carry-note.ts). */
export interface AgentOrdersWall {
  claim: string;
  recheck?: string;
  sinceMs?: number;
}

/** A carried claim about external state + the probe that falsifies it.
 *  `verified` absent ⇒ the claim is PREDICTED, not confirmed. */
export interface AgentOrdersCheck {
  claim: string;
  recheck?: string;
  verified?: string;
  sinceMs?: number;
}

export interface AgentOrdersHeldItem {
  id: string;
  title: string | null;
  checkpoint: string | null;
  checkpointUpdatedAtMs: number | null;
}

export interface AgentOrdersCarry {
  /** cold ⇒ each wake rebuilds from the checkpoint, so the checkpoint is the
   *  agent's ONLY memory and staleness is a correctness problem, not a nuisance. */
  mode: 'warm' | 'cold' | null;
  generation: number | null;
  loopActive: boolean;
  loopIntervalSec: number | null;
  note: string | null;
  noteUpdatedAtMs: number | null;
  /** We read successfully and the agent never wrote a note — a finding about
   *  the AGENT, distinct from a failed read (which lands in `unavailable`). */
  neverWritten: boolean;
  heldItems?: AgentOrdersHeldItem[];
  checks?: AgentOrdersCheck[];
  citedRefs?: string[];
  /** Cited refs that have since gone terminal — the #1 stale-conclusion tell. */
  citedRefsTerminal?: string[];
  postNoteInbox?: { count: number; lines: string[] } | null;
  awaits?: Array<{ eventKey: string; note: string | null }>;
}

export interface AgentOrders {
  ownerId: string;
  mission: AgentOrdersMission | null;
  modes?: AgentOrdersMode[];
  wakeMode: AgentOrdersWakeMode | null;
  walls?: AgentOrdersWall[];
  directives?: AgentOrdersDirective[];
  directivesTotalOpen?: number;
  facts?: AgentOrdersFact[];
  carry: AgentOrdersCarry | null;
  /** What this agent's own last `coord:orient` left OUT (P-005).
   *
   *  ⚠ `null`/absent means NO RECORDING — the session has not oriented since the
   *  recording existed, or the read failed. It must NEVER be rendered as
   *  "nothing was withheld"; see Disclosures.tsx. */
  disclosures?: RecordedOrientDisclosures | null;
  /** The SHARED obligation + delta projection (P-018) — the same rows the
   *  agent's own turn-start block rendered, projected at the `agent-orders`
   *  sink with `committed: null` so an OBSERVER sees the full standing set
   *  rather than the delta-suppressed subset the agent saw this turn.
   *
   *  ⚠ absent/`null` means NOT RECORDED — an operator predating the field, or a
   *  read that threw (then the key is also in `unavailable`). It must NEVER be
   *  rendered as "they were told nothing"; an empty ARRAY is that. */
  obligationRows?: OrientationRow[] | null;
  unavailable?: AgentOrdersSignalKey[];
}

/**
 * Staleness verdict for a carried artifact, given the agent's carry mode.
 *
 * Mirrors `carryStaleness` in adv-agent-orders.ts so the panel can grade an age
 * without a round-trip. Kept in sync by the shared-threshold test rather than by
 * importing across the server/client boundary.
 */
export function carryStaleness(
  ageMs: number | null,
  mode: 'warm' | 'cold' | null,
): 'fresh' | 'aging' | 'stale' | 'unknown' {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  const minutes = ageMs / 60_000;
  if (mode === 'cold') {
    if (minutes <= 5) return 'fresh';
    if (minutes <= 20) return 'aging';
    return 'stale';
  }
  if (minutes <= 20) return 'fresh';
  if (minutes <= 90) return 'aging';
  return 'stale';
}

/** Compact age string for the panel's age chips ("4m", "3h 12m", "2d"). */
export function formatAgeShort(ageMs: number | null): string | null {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return null;
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** Lazy-load one agent's orders through sync. `enabled` lets the caller skip
 *  the fetch entirely while the panel is collapsed — the whole reason this is a
 *  separate query. */
export function useAgentOrders(
  ownerId: string | null,
  enabled = true,
): { orders: AgentOrders | null; error: string | null; loading: boolean } {
  const query = useSyncQuery<AgentOrders>({
    queryName: 'agentOrders.byOwner',
    args: ownerId ? { ownerId } : undefined,
    enabled: !!ownerId && enabled,
  });
  return {
    orders: query.data?.[0] ?? null,
    error: query.error ? String(query.error) : null,
    loading: query.loading,
  };
}
