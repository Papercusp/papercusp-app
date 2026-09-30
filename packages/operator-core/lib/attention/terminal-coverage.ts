/**
 * Terminal-disposition policy per AttentionKind
 * (autonomous-inbox-resolution-2026-08-31 P-003).
 *
 * ## What this closes
 *
 * An attention item is only ever CLEARED by a terminal action — `resolve`,
 * `drop`, `ack`, `dismiss`, `grant`, `mark-done` — dispatched through
 * {@link ../attention/terminal-action-dispatch dispatchAttentionTerminalAction}.
 * Everything else in {@link NAVIGATE_ACTION_IDS} only opens a sub-surface.
 *
 * Measured 2026-08-31 against the live adapters + dispatcher, BEFORE this
 * module existed: 9 of the 15 kinds offered NO terminal action at all, and the
 * two largest populations were among them — `work-item-needs-human` (46% of the
 * bulk-run ledger) and `dark-flag-ratification` (14%). That is why the resolver
 * (and the owner's own click) could terminally dispose of only ~17% of the
 * queue: not a confidence problem and not an authority problem, but the simple
 * absence of any action that ends the item. Widening autonomy over a kind with
 * no terminal action buys exactly nothing, which is why P-005's authority
 * ladder is blocked on this item.
 *
 * ## The distinction this module exists to force
 *
 * Two materially different things both "clear a card", and conflating them is
 * how an inbox starts lying:
 *
 *  - `source-mutating` — the action changes the row the card is DERIVED from
 *    (clear a work-item's owner gate, close a conversation, close a session
 *    gate). The card cannot re-derive because the reason for it is gone. This
 *    is the honest disposition whenever a mutable source row exists.
 *
 *  - `acknowledgement` — the card is derived from something the operator cannot
 *    mutate at all (a static `KNOWN_DARK_FLAGS` entry compiled into
 *    `libs/flags`, a smoke-test result, a heuristic nudge over closed gates).
 *    Its only honest terminal is the durable operator triage record
 *    (`inbox:triage { action:'resolve' }`), which the readers already honour:
 *    `applyTriage` tiers it to "Handled by operator" and
 *    `readTriagedHandledItemIds` suppresses it from curation + the wake brief.
 *
 * Applying an `acknowledgement` to a kind that HAS a mutable source is the bug
 * this classification prevents: the card vanishes while the work-item still
 * demands a human, so the queue looks drained and the owner is still blocking
 * an agent. That failure has a precedent in this very subsystem —
 * EI-21675115869134466, where `payload.needsHuman` stayed set and the rows kept
 * coming back.
 *
 * ## Why a hand-written map at all
 *
 * Per the derived-truth ladder, the ACTION IDS and the dispatcher branches are
 * code and are never restated here — `terminal-coverage.test.ts` DERIVES both
 * (it drives the real adapters and probes the real dispatcher) and fails if
 * this map disagrees. What is stored here is only the part code cannot know:
 * which class of disposition is CORRECT for the kind, and why. That is rung 4
 * (curated judgment), pinned by rung 2 (a divergence test).
 */

import type { AttentionActionId, AttentionKind } from './types';

export type TerminalDispositionClass = 'source-mutating' | 'acknowledgement' | 'none';

/**
 * The delegation axis for an attention disposition (P-005).
 *
 * This is deliberately a three-way partition rather than a boolean.  A
 * `delegable` disposition may be handled by the Queen once its category and
 * confidence gates pass; `owner-by-right` is the owner's judgement even when
 * the Queen is armed; and `never-auto` is a permanent floor (signals,
 * autonomy-widening grants, and protected surfaces).  Keeping this on the
 * existing terminal policy means terminal class and authority cannot drift in
 * separate per-kind registries.
 */
export const ATTENTION_DELEGATIONS = [
  'delegable',
  'owner-by-right',
  'never-auto',
] as const;
export type AttentionDelegation = (typeof ATTENTION_DELEGATIONS)[number];

/** Runtime guard for persisted/configured authority values in downstream items. */
export function isAttentionDelegation(value: unknown): value is AttentionDelegation {
  return typeof value === 'string' && ATTENTION_DELEGATIONS.includes(value as AttentionDelegation);
}

export interface AttentionTerminalPolicy {
  /** Which class of terminal disposition is CORRECT for this kind. */
  class: TerminalDispositionClass;
  /** Who may apply the disposition under the authority ladder (P-005). */
  authority: AttentionDelegation;
  /** Why — the judgment the class encodes. Read by the audit test's failure message. */
  why: string;
}

/**
 * The acknowledgement-class action ids. A kind classified `acknowledgement`
 * resolves through the shared `inbox:triage` branch of the dispatcher rather
 * than a per-kind effect, so its offered terminal action must be one of these.
 */
export const ACKNOWLEDGEMENT_ACTION_IDS: ReadonlySet<AttentionActionId> = new Set<AttentionActionId>([
  'ack',
  'dismiss',
  'resolve',
  'mark-done',
]);

export const ATTENTION_TERMINAL_POLICY: Record<AttentionKind, AttentionTerminalPolicy> = {
  'plan-item': {
    class: 'source-mutating',
    authority: 'owner-by-right',
    why: 'The card is a plan document item; mark-done/drop writes plans:set-status, so the item stops being needs-human at the source.',
  },
  'coord-escalation': {
    class: 'source-mutating',
    authority: 'delegable',
    why: 'coord:resolve closes the escalation row and (best-effort) delivers the owner pick back to the asker.',
  },
  'coord-message': {
    class: 'source-mutating',
    authority: 'delegable',
    why: 'coord:ack marks the message acknowledged on its own row.',
  },
  'smoke-fail': {
    class: 'acknowledgement',
    authority: 'never-auto',
    why: 'Derived from a smoke-test RESULT. The operator cannot make a past run pass; acknowledging records that the failure was seen. Fixing it is engineering work with its own work-item, not an inbox disposition.',
  },
  'operator-report': {
    class: 'acknowledgement',
    authority: 'never-auto',
    why: 'A status report from an operator turn — nothing to mutate; the triage record IS the disposition (its long-standing behaviour, now named).',
  },
  improvement: {
    class: 'source-mutating',
    authority: 'delegable',
    why: 'Dismiss writes improvements:triage { decision:"reject" }, closing the idea at its source so the recall matcher reports it already decided.',
  },
  'standing-approval': {
    class: 'source-mutating',
    authority: 'never-auto',
    why: 'Grant/dismiss writes the standing-approval decision; the candidate stops being pending.',
  },
  conversation: {
    class: 'source-mutating',
    authority: 'delegable',
    why: 'conversations:resolve sets the row resolved and captures the accepted answer for the next asker.',
  },
  'scout-grade': {
    class: 'acknowledgement',
    authority: 'delegable',
    why: 'A rollup NUDGE over ungraded ideas — grading is optional feedback, so there is no per-item source state an inbox action should mutate. Dismissing records that the owner declined the nudge.',
  },
  'work-item-needs-human': {
    class: 'source-mutating',
    authority: 'owner-by-right',
    why: 'The card is a live work_items row gated on status=needs-human (feature family) or payload.needsOwnerAction/needsHuman (issue family). Resolve clears that gate and returns the item to the agents; Drop closes it. An acknowledgement here would hide the card while the agent stays blocked — the exact EI-21675115869134466 failure.',
  },
  'owner-wall': {
    class: 'source-mutating',
    authority: 'never-auto',
    why: 'A wall names a capability only the owner can supply. A work-item-backed wall clears the same owner gate as work-item-needs-human; a loop-carry-note wall has no operator-writable row and degrades to acknowledgement by ref shape. Neither is an agent judgement the ladder may manufacture.',
  },
  'dark-flag-ratification': {
    class: 'acknowledgement',
    authority: 'owner-by-right',
    why: 'Derived from the static DARK_FLAGS allowlist compiled into libs/flags. NOTHING an operator writes at runtime can remove the entry — graduating a flag is a source edit + a shrink of a shrink-only allowlist. Confirming it stays dark is therefore the only honest terminal, and it is a real owner decision, not a hide.',
  },
  'blocked-session': {
    class: 'source-mutating',
    authority: 'delegable',
    why: 'An open session_pending_gates row; closing the gate is exactly what the watcher/hook does when the ask clears.',
  },
  'work-item-blocked': {
    class: 'source-mutating',
    authority: 'never-auto',
    why: 'A live blocked work_items row — Drop closes it with the caller rationale as completion evidence rather than leaving a permanently blocked row in the alert feed.',
  },
  'unhandled-directive': {
    class: 'acknowledgement',
    authority: 'never-auto',
    why: 'Derived live from the directive store: an open owner directive whose session ended with no live fleet leader or holder. Closing it is orders:disposition by the session that adopts it (any session may, once it is unhandled), reached through Discuss; acknowledging records that the owner saw it and chose to leave it open.',
  },
  'decision-owed': {
    class: 'acknowledgement',
    authority: 'never-auto',
    why: 'A mechanical heuristic over ALREADY-CLOSED ask gates with no matching plans:add-decision. Recording the decision is separate deliberate work (the navigate action); dismissing records the honest verdict that no decision was owed.',
  },
};

/**
 * Backwards-compatible public name for the authority map, now DERIVED from the
 * one per-kind policy table instead of maintained as a second registry.
 */
export const ATTENTION_KIND_AUTHORITY: Record<AttentionKind, AttentionDelegation> =
  Object.fromEntries(
    Object.entries(ATTENTION_TERMINAL_POLICY).map(([kind, policy]) => [kind, policy.authority]),
  ) as Record<AttentionKind, AttentionDelegation>;

/** The policy for a kind, or `null` when the string is not a known AttentionKind. */
export function terminalPolicyFor(kind: string): AttentionTerminalPolicy | null {
  return (ATTENTION_TERMINAL_POLICY as Record<string, AttentionTerminalPolicy | undefined>)[kind] ?? null;
}

/** The delegation rung for a kind, or `null` for an unknown kind. */
export function delegationFor(kind: string): AttentionDelegation | null {
  return terminalPolicyFor(kind)?.authority ?? null;
}

/**
 * True when this kind's terminal disposition is the shared operator
 * acknowledgement (a durable `inbox:triage` resolve) rather than a per-kind
 * source mutation.
 */
export function isAcknowledgementKind(kind: string): boolean {
  return terminalPolicyFor(kind)?.class === 'acknowledgement';
}
