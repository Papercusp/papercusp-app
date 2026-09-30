/**
 * blocked-on-status.ts — the read-time diff of an AUTHORED `blockedOn` against
 * live state (coord-derived-fields-2026-08-31 P-005, D-003).
 *
 * The field's own doc-comment has promised this since it shipped: *"structured
 * so the blocker … can be shown to have gone stale"* (message-fields.ts). This
 * module is that mechanism — the exact shape `staleBasis` gives `basedOn`,
 * applied to waits, and the reason D-003 made `ref` mandatory: a real ref is
 * diffable; prose never was.
 *
 * ── WHY AT READ, NOT AT SEND ─────────────────────────────────────────────────
 *
 * `staleBasis` diffs at SEND because its question — "had the basis already
 * moved when the sender wrote this?" — is only answerable at that moment. A
 * blocker's question is the reverse: "has it cleared SINCE?", which keeps
 * changing after the row is immutable, so the verdict must be computed against
 * live state each time a reader looks (the derived-plan-slug rule: stamp what
 * is fixed at write time; derive at read what is live).
 *
 * ── NEVER FABRICATE ──────────────────────────────────────────────────────────
 *
 * A verdict is emitted ONLY from an unambiguous ledger:
 *   · kind 'work-item' → the item's live status (terminal ⇒ cleared, with when)
 *   · kind 'event'     → a LATCHED gate declaration's fired_at (event_awaits
 *                        policy='announce'), the same latch events:await trusts
 * 'process' / 'agent' / 'owner' / 'other' get NO verdict — a process's
 * liveness, an agent's progress, an owner's decision have no single ledger row
 * that settles "cleared", and a guessed verdict is worse than none (based-on.ts
 * states the rule; it binds here identically). Fail-soft everywhere: any error
 * ⇒ unannotated entries, never a failed read.
 */

import { getOrgPg } from '@papercusp/db-org';

/** Envelope/entry key the annotation rides. */
export const BLOCKED_ON_STATUS_FIELD = 'blockedOnStatus';

export interface BlockedOnStatusStamp {
  /** The authored blocker's kind + ref, echoed so the reader can match it. */
  kind: 'work-item' | 'event';
  ref: string;
  /**
   * 'cleared-since-send'   — it resolved after the message was sent: the wait
   *                          the sender described is OVER.
   * 'already-cleared-at-send' — it had resolved BEFORE the send: the sender
   *                          cited a stale blocker (the staleBasis flavour).
   * 'pending'              — still open; `state` carries the live status.
   */
  verdict: 'cleared-since-send' | 'already-cleared-at-send' | 'pending';
  /** Live state at read time (a work-item status, or 'fired'). */
  state?: string;
  /** ISO — when it cleared, when determinable. */
  clearedAt?: string;
}

interface AuthoredBlockedOnRef {
  kind: 'work-item' | 'event';
  ref: string;
}

const TERMINAL_STATES = new Set(['done', 'resolved', 'deprecated', 'dropped']);

/** PURE — collect the diffable authored blockers from one coord entry's sections. */
export function collectBlockedOnRefs(entry: Record<string, unknown>): AuthoredBlockedOnRef[] {
  const sections = entry.sections;
  if (!Array.isArray(sections)) return [];
  const out: AuthoredBlockedOnRef[] = [];
  for (const s of sections) {
    if (!s || typeof s !== 'object') continue;
    const b = (s as Record<string, unknown>).blockedOn;
    if (!b || typeof b !== 'object') continue;
    const kind = (b as Record<string, unknown>).kind;
    const ref = (b as Record<string, unknown>).ref;
    if ((kind === 'work-item' || kind === 'event') && typeof ref === 'string' && ref.trim()) {
      out.push({ kind, ref: ref.trim() });
    }
  }
  return out;
}

/** PURE — verdict from a resolved ledger row + the message's send time. */
export function blockedOnVerdict(input: {
  kind: 'work-item' | 'event';
  ref: string;
  sentAtMs: number;
  /** Terminal/fired timestamp (ms) when the blocker has cleared; null when open. */
  clearedAtMs: number | null;
  /** Live state label (work-item status, or 'fired'). */
  state?: string;
}): BlockedOnStatusStamp {
  if (input.clearedAtMs == null) {
    return { kind: input.kind, ref: input.ref, verdict: 'pending', ...(input.state ? { state: input.state } : {}) };
  }
  return {
    kind: input.kind,
    ref: input.ref,
    verdict: input.clearedAtMs > input.sentAtMs ? 'cleared-since-send' : 'already-cleared-at-send',
    ...(input.state ? { state: input.state } : {}),
    clearedAt: new Date(input.clearedAtMs).toISOString(),
  };
}

/**
 * Annotate a bounded page of inbox/feed entries with live blocker verdicts.
 * One keyed query per ledger over the whole page (the annotateSuperseded
 * shape), fail-soft and non-mutating — losing the marker must never cost the
 * caller their inbox.
 */
export async function annotateBlockedOnStatus<T extends Record<string, unknown>>(
  entries: T[],
  opts: { workspaceId: string },
): Promise<T[]> {
  try {
    const wanted = new Map<string, { entry: number; refs: AuthoredBlockedOnRef[] }>();
    const workItemIds = new Set<string>();
    const eventKeys = new Set<string>();
    entries.forEach((entry, i) => {
      const refs = collectBlockedOnRefs(entry);
      if (!refs.length) return;
      wanted.set(String(entry.msg_id ?? i), { entry: i, refs });
      for (const r of refs) (r.kind === 'work-item' ? workItemIds : eventKeys).add(r.ref);
    });
    if (!wanted.size) return entries;

    const { sql } = getOrgPg();
    const itemState = new Map<string, { state: string; clearedAtMs: number | null }>();
    if (workItemIds.size) {
      const rows = await sql<{ feature_id: string; status: string; closed_ts: string | null; state_changed_at: Date | null }[]>`
        SELECT feature_id, status, closed_ts, state_changed_at
          FROM harness_shared.work_items
         WHERE workspace_id = ${opts.workspaceId}
           AND feature_id = ANY(${[...workItemIds]})`;
      for (const r of rows) {
        const terminal = TERMINAL_STATES.has(r.status);
        const clearedAtMs = terminal
          ? (r.closed_ts != null ? Number(r.closed_ts) : r.state_changed_at ? new Date(r.state_changed_at).getTime() : Date.now())
          : null;
        itemState.set(r.feature_id, { state: r.status, clearedAtMs });
      }
    }
    const eventFired = new Map<string, number>();
    if (eventKeys.size) {
      // The LATCH: a declared gate's announce row records fired_at durably —
      // the same row events:await's already_fired path trusts.
      const rows = await sql<{ event_key: string; fired_at: Date | null }[]>`
        SELECT event_key, max(fired_at) AS fired_at
          FROM harness_shared.event_awaits
         WHERE workspace_id = ${opts.workspaceId}
           AND policy = 'announce'
           AND event_key = ANY(${[...eventKeys]})
           AND fired_at IS NOT NULL
         GROUP BY event_key`;
      for (const r of rows) if (r.fired_at) eventFired.set(r.event_key, new Date(r.fired_at).getTime());
    }

    return entries.map((entry) => {
      const hit = wanted.get(String(entry.msg_id ?? ''));
      if (!hit) return entry;
      const sentAtMs = Date.parse(String(entry.ts ?? '')) || 0;
      const stamps: BlockedOnStatusStamp[] = [];
      for (const r of hit.refs) {
        if (r.kind === 'work-item') {
          const live = itemState.get(r.ref);
          if (!live) continue; // unknown item — no verdict, never a guess
          stamps.push(blockedOnVerdict({ kind: r.kind, ref: r.ref, sentAtMs, clearedAtMs: live.clearedAtMs, state: live.state }));
        } else {
          const firedAtMs = eventFired.get(r.ref);
          if (firedAtMs == null) continue; // no latch row — undeterminable, no verdict
          stamps.push(blockedOnVerdict({ kind: r.kind, ref: r.ref, sentAtMs, clearedAtMs: firedAtMs, state: 'fired' }));
        }
      }
      return stamps.length ? { ...entry, [BLOCKED_ON_STATUS_FIELD]: stamps } : entry;
    });
  } catch {
    return entries; // unannotated, but complete
  }
}

/** Render the ACTIONABLE verdicts as a compact suffix (the staleBasis shape).
 *  'pending' is deliberately not rendered — the sender said they were waiting
 *  and they still are; the news is when that stops being true. */
export function renderBlockedOnStatusSuffix(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const cleared = value.filter(
    (s): s is BlockedOnStatusStamp =>
      !!s && typeof s === 'object' &&
      ((s as BlockedOnStatusStamp).verdict === 'cleared-since-send' ||
        (s as BlockedOnStatusStamp).verdict === 'already-cleared-at-send'),
  );
  if (!cleared.length) return '';
  const rendered = cleared.slice(0, 3).map((s) => {
    const now = s.state && s.state !== 'fired' ? ` (now ${s.state})` : '';
    return s.verdict === 'cleared-since-send'
      ? `${s.ref} cleared since send${now}`
      : `${s.ref} had ALREADY cleared at send${now}`;
  });
  return ` ⛓ blocker: ${rendered.join('; ')}`;
}
