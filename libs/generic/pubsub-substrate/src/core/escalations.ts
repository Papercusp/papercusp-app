/**
 * escalations.ts — escalation record shapes + the append-only resolve
 * fold. PURE.
 *
 * agent-coordination-architecture-v2 §6.4 (#9). An escalation is an
 * immutable event; a resolution is a SIBLING event with kind
 * 'escalation_resolved' + related_msg_id (P-012). The open/resolved
 * state is DERIVED by folding the resolve events over the opens —
 * `foldResolved` overlays one, `foldEscalations` does the whole set.
 * The per-event-file I/O lives behind the CoordEventLog seam.
 */

import { type CoordEnvelope } from './envelope';

/**
 * Escalation severity. As of queen-autonomy-policy-2026-06-13 (P-013) this is no
 * longer an independent risk scale — it is a labeled band of the canonical
 * `risk_tier` (trivial · low · moderate · high · critical). The fold lives in the
 * operator (`attention/types.ts` `severityToRiskTier`: blocker→critical,
 * question→high, advisory→low); this generic lib keeps the human-facing label
 * and stays decoupled from the risk vocabulary.
 */
export type EscalationSeverity = 'blocker' | 'question' | 'advisory';

export interface EscalationOption {
  id: string;
  label: string;
}

export interface OpenEscalationInput {
  severity: EscalationSeverity;
  summary: string;
  body?: string;
  plan_slug?: string;
  options?: EscalationOption[];
}

export interface ResolveInput {
  msg_id: string;
  choice: string;
  note?: string;
  /** Identity of the resolver (often the human, surfaced through ctx). */
  resolver?: string;
}

export interface EscalationRecord extends CoordEnvelope {
  kind: 'escalation';
  severity: EscalationSeverity;
  options?: EscalationOption[];
  /**
   * Read-time overlay: null while open, populated by folding the sibling
   * `escalation_resolved` event. Never persisted as non-null on the open
   * record.
   */
  resolved: null | {
    choice: string;
    ts: string;
    by?: string;
    note?: string;
  };
}

/** The append-only resolution event. */
export interface EscalationResolvedEvent extends CoordEnvelope {
  kind: 'escalation_resolved';
  related_msg_id: string;
  choice: string;
  /** Reopen generation this resolution closes; legacy rows are generation 0. */
  generation?: number;
  by?: string;
  note?: string;
}

/**
 * Append-only compensation for a resolution. The original escalation and every
 * resolution remain immutable; the fold treats this as the next lifecycle
 * generation becoming open again.
 */
export interface EscalationReopenedEvent extends CoordEnvelope {
  kind: 'escalation_reopened';
  related_msg_id: string;
  generation: number;
  by?: string;
  note?: string;
}

/** Overlay a resolve event onto an open record's `resolved` field. */
export function foldResolved(
  open: EscalationRecord,
  ev: EscalationResolvedEvent | undefined,
): EscalationRecord {
  if (!ev) return { ...open, resolved: null };
  const resolved: NonNullable<EscalationRecord['resolved']> = {
    choice: ev.choice,
    ts: ev.ts,
  };
  if (ev.by !== undefined) resolved.by = ev.by;
  if (ev.note !== undefined) resolved.note = ev.note;
  return { ...open, resolved };
}

/**
 * Build the map of resolution events keyed by the escalation they
 * resolve. If more than one resolution exists for the same escalation
 * (a concurrent double-resolve that beat the idempotency check), the
 * earliest by (ts, msg_id) wins — deterministic.
 */
export function indexResolves(
  resolves: EscalationResolvedEvent[],
  reopens: EscalationReopenedEvent[] = [],
): Map<string, EscalationResolvedEvent> {
  const generationByTarget = new Map<string, number>();
  for (const event of reopens) {
    if (!Number.isInteger(event.generation)) continue;
    generationByTarget.set(
      event.related_msg_id,
      Math.max(generationByTarget.get(event.related_msg_id) ?? 0, event.generation),
    );
  }
  const sorted = [...resolves].sort(
    (a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id),
  );
  const byTarget = new Map<string, EscalationResolvedEvent>();
  for (const ev of sorted) {
    const eventGeneration = Number.isInteger(ev.generation) ? ev.generation! : 0;
    if (eventGeneration !== (generationByTarget.get(ev.related_msg_id) ?? 0)) continue;
    if (!byTarget.has(ev.related_msg_id)) byTarget.set(ev.related_msg_id, ev);
  }
  return byTarget;
}

/**
 * The msg_id of the `escalation_resolved` event that resolves `escalationMsgId`.
 *
 * A resolve is TERMINAL and one-per-escalation, so its identity is fully
 * determined by its target — a freshly-minted id never expressed anything true
 * about it, and it actively caused harm (WI-10769): N concurrent resolves of the
 * same escalation landed as N distinct rows, which no unique index could collapse
 * and which the reader above had to paper over by picking the earliest. Deriving
 * the id makes "at most one resolve per escalation" a property of the KEY, which
 * is the only place it can be enforced across processes.
 *
 * Deliberately NOT a hash: the id stays human-legible and greppable back to its
 * escalation, which is how the duplicate storms were diagnosed in the first place.
 * The `res-` prefix cannot collide with `newMsgId()` output (which starts `ms`).
 *
 * ⚠ Read-side compatibility: resolves are indexed by `related_msg_id`, never by
 * their own msg_id (see `indexResolves` above), so rows written before this
 * existed — with random ids — still fold correctly. Do not "migrate" them.
 */
export function resolvedEventId(escalationMsgId: string, generation = 0): string {
  return generation === 0 ? `res-${escalationMsgId}` : `res-${escalationMsgId}-g${generation}`;
}

/** Deterministic one-per-generation id for an append-only reopen compensation. */
export function reopenedEventId(escalationMsgId: string, generation: number): string {
  return `reopen-${escalationMsgId}-g${generation}`;
}

/** The generation a subsequent resolve/reopen belongs to. */
export function escalationGeneration(
  escalationMsgId: string,
  reopens: readonly EscalationReopenedEvent[],
): number {
  return reopens.reduce(
    (max, event) =>
      event.related_msg_id === escalationMsgId && Number.isInteger(event.generation)
        ? Math.max(max, event.generation)
        : max,
    0,
  );
}

/**
 * Fold open escalations with their resolution events. Optionally filter
 * by open/resolved. Sorted ascending by (ts, msg_id).
 */
export function foldEscalations(
  opens: EscalationRecord[],
  resolves: EscalationResolvedEvent[],
  opts: { status?: 'open' | 'resolved'; reopens?: EscalationReopenedEvent[] } = {},
): EscalationRecord[] {
  const byTarget = indexResolves(resolves, opts.reopens ?? []);
  const out: EscalationRecord[] = [];
  for (const open of opens) {
    const folded = foldResolved(open, byTarget.get(open.msg_id));
    if (opts.status === 'open' && folded.resolved != null) continue;
    if (opts.status === 'resolved' && folded.resolved == null) continue;
    out.push(folded);
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}
