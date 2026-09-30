/**
 * stale-source.ts — flag a standing fact whose SOURCE WORK-ITEM has closed (EI-10947).
 *
 * THE BUG THIS EXISTS TO KILL. A fact is folded VERBATIM into every relevant orient
 * and is explicitly BINDING context ("if a recalled fact prescribes a behavior for
 * THIS task, follow it"). Agents therefore use facts as carry-notes, and a carry-note
 * is usually an IMPERATIVE anchored to a work-item:
 *
 *     key:  ei-10539-dist-atomic-swap-in-progress
 *     body: "... NEXT: implement EI-10539"      sourceRef: wi:EI-10539
 *
 * Complete EI-10539 and nothing happens. The fact keeps folding, verbatim, into every
 * future orient — telling the agent (and every successor) to go do work that is already
 * done and verified. Observed 2026-07-13 (su-71d9f8a2); it is the fact surface's worst
 * failure mode, because the whole point of the channel is that it is TRUSTED.
 *
 * The system already HAD everything needed to catch it: the fact carries
 * `sourceRef: wi:EI-10539`, and EI-10539 went terminal. Nothing ever joined the two.
 * This module is that join.
 *
 * WHY MARK AND NOT AUTO-RETRACT. The obvious fix — "source item closed ⇒ drop the
 * fact" — is WRONG, and the counterexample is easy to hit: a durable CONCLUSION
 * anchored to the item that PROVED it ("derived/negative claims get unearned
 * confidence", sourceRef wi:EI-10951) stays true forever precisely BECAUSE that item
 * was completed. Auto-retract would delete the fact at the moment it became load-
 * bearing. A closed source item does not mean "false", it means "the ground under this
 * has moved — re-verify" — and only the reader can tell an expired imperative from a
 * proven conclusion. So we hand the reader the fact AND the flag, and let them judge.
 * (This is the same discipline as EI-10951: state the derived claim WITH its caveat,
 * rather than acting on it as if it were certain.)
 */
import type { AgentFact } from '../../agent-facts/store';
import { parseRefToken } from '../coordination/ref-hydrate';
import { hydrateRefs } from '../coordination/ref-hydrate-resolve';

/**
 * Work-item states that mean the source item is CLOSED. Kept deliberately broad —
 * a false "may be stale" flag costs the reader one glance; a missed one re-runs the
 * EI-10539 failure (an agent redoing finished work on a stale instruction).
 */
export const TERMINAL_ITEM_STATES: ReadonlySet<string> = new Set([
  'done',
  'resolved',
  'deprecated',
  'wont_do',
  'wontdo',
  'cancelled',
  'canceled',
  'closed',
  'merged',
  'shipped',
]);

/** The staleness flag attached to a fact whose source work-item has closed. */
export interface FactSourceStaleness {
  /** The work-item the fact is anchored to (e.g. "EI-10539"). */
  sourceItem: string;
  /** Its CURRENT state, read at fold/list time (not the assert-time stamp). */
  sourceItemState: string;
  /** Rendered loudly wherever the fact is delivered. */
  note: string;
}

export type FactWithStaleness = AgentFact & { sourceStale?: FactSourceStaleness };

/**
 * hydrateRefs labels a work-item as `EI-10539 [bug/resolved]` — kind/state in
 * brackets. Pull the state out of the trailing bracket group.
 * PURE — unit-tested without PG.
 */
export function parseStateFromLabel(label: string | undefined): string | null {
  if (!label) return null;
  const m = /\[([^\]]+)\]\s*$/.exec(label.trim());
  if (!m) return null;
  const inner = m[1] ?? '';
  // `kind/state` (the WI resolver's shape) — else treat the whole group as the state.
  const parts = inner.split('/');
  const state = (parts.length > 1 ? parts[parts.length - 1] : inner).trim().toLowerCase();
  return state || null;
}

/** PURE: is this label's state terminal? Unit-tested without PG. */
export function isTerminalLabel(label: string | undefined): boolean {
  const state = parseStateFromLabel(label);
  return state !== null && TERMINAL_ITEM_STATES.has(state);
}

/**
 * Attach `sourceStale` to any fact whose sourceRef names a work-item that is now
 * in a terminal state. ONE batched hydrateRefs call for the whole fold (facts
 * anchored to the same item resolve once), so the cost is a single extra read per
 * orient — and only when at least one fact carries a typed work-item ref.
 *
 * FAIL-SOFT BY CONTRACT, matching every other leg of the fold: if the lookup errors
 * we return the facts UNMARKED rather than failing the orient. A missed flag degrades
 * to today's behaviour; a thrown error would break orientation itself.
 */
export async function markStaleSourceFacts<T extends AgentFact>(
  facts: readonly T[],
): Promise<Array<T & { sourceStale?: FactSourceStaleness }>> {
  if (facts.length === 0) return [];

  // Only typed WORK-ITEM refs can go stale this way (a msg/owner-turn anchor has no
  // lifecycle; a free-text anchor has nothing to resolve).
  const refByFact = new Map<number, string>();
  const tokens = new Map<string, ReturnType<typeof parseRefToken>>();
  facts.forEach((f, i) => {
    if (!f.sourceRef) return;
    const ref = parseRefToken(f.sourceRef);
    if (!ref || ref.kind !== 'work-item') return;
    const id = f.sourceRef.replace(/^wi:/i, '').trim().toUpperCase();
    if (!id) return;
    refByFact.set(i, id);
    if (!tokens.has(id)) tokens.set(id, ref);
  });
  if (refByFact.size === 0) return facts.map((f) => ({ ...f }));

  let stateById = new Map<string, string>();
  try {
    const refs = [...tokens.values()].filter((r): r is NonNullable<typeof r> => Boolean(r));
    const hydrated = await hydrateRefs(refs, { budget: { snippetChars: 1, maxRefs: refs.length } });
    const ids = [...tokens.keys()];
    hydrated.forEach((h, i) => {
      const id = ids[i];
      if (!id || !h?.ok) return;
      const state = parseStateFromLabel(h.label);
      if (state) stateById.set(id, state);
    });
  } catch {
    // Fail-soft: an unmarked fold is today's behaviour; a thrown orient is not.
    stateById = new Map();
  }

  return facts.map((f, i) => {
    const id = refByFact.get(i);
    const state = id ? stateById.get(id) : undefined;
    if (!id || !state || !TERMINAL_ITEM_STATES.has(state)) return { ...f };
    return {
      ...f,
      sourceStale: {
        sourceItem: id,
        sourceItemState: state,
        note:
          `⚠ MAY BE STALE — this fact's source item ${id} is ${state.toUpperCase()}. It is still being folded ` +
          `verbatim as binding context. If it was a carry-note ("next: do X"), the work is DONE and this is now ` +
          `an instruction to redo it: facts:retract { key: "${f.key}", reason: "source item is terminal" }. If it is a durable conclusion the closed ` +
          `item PROVED, it stands — re-assert to refresh its TTL and silence this.`,
      },
    };
  });
}
