/**
 * Which lifecycle reactions an admission rule runs (linear-asana-task-sync-2026-10-05 P-003).
 *
 * Stored as `admission_rules.lifecycle` (migration 1387). An empty object means the defaults: every
 * reaction on, and completion moves the source to `done` (owner answer #1417, plan D-006). A work
 * item admitted by a person, not a rule, also gets the defaults. lifecycle.ts runs the reactions.
 *
 * Kept free of other work-admission imports so admission-rules.ts can validate a rule's lifecycle
 * without an import cycle through lifecycle.ts.
 */

import { isTicketStatusCategory, type TicketStatusCategory } from '../data-sources/ticket-vocabulary';

export interface AdmissionLifecycle {
  /** On claim: move the source to `in-progress` and comment who picked it up. */
  claim: boolean;
  /** On needs-human / blocked: comment the question the item is waiting on. */
  hold: boolean;
  /** On completion: comment the completion summary and move the source to `completeCategory`. */
  complete: boolean;
  /** The workflow category a completed item's source moves to. */
  completeCategory: TicketStatusCategory;
  /** On an outside close or cancel: drop an unclaimed item, hold a claimed one for its holder. */
  externalClose: boolean;
  /** On an outside reopen of a finished item that the rule still matches: reopen the item. */
  reopen: boolean;
}

export const DEFAULT_ADMISSION_LIFECYCLE: Readonly<AdmissionLifecycle> = Object.freeze({
  claim: true,
  hold: true,
  complete: true,
  completeCategory: 'done',
  externalClose: true,
  reopen: true,
});

const SWITCHES = ['claim', 'hold', 'complete', 'externalClose', 'reopen'] as const;

/**
 * Validates a lifecycle setting supplied by a caller and returns it with defaults filled in.
 * Unknown keys and wrong types are refused (`admission_rule_invalid:`), so a misspelt switch
 * cannot silently leave a reaction on.
 */
export function parseAdmissionLifecycle(raw: unknown): AdmissionLifecycle {
  if (raw === undefined || raw === null) return { ...DEFAULT_ADMISSION_LIFECYCLE };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('admission_rule_invalid: lifecycle must be an object');
  }
  const input = raw as Record<string, unknown>;
  const known = new Set<string>([...SWITCHES, 'completeCategory']);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `admission_rule_invalid: unknown lifecycle key(s) ${unknown.join(', ')}; allowed: ${[...known].join(', ')}`,
    );
  }
  const out: AdmissionLifecycle = { ...DEFAULT_ADMISSION_LIFECYCLE };
  for (const key of SWITCHES) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new Error(`admission_rule_invalid: lifecycle.${key} must be a boolean`);
    out[key] = input[key] as boolean;
  }
  if (input.completeCategory !== undefined) {
    if (typeof input.completeCategory !== 'string' || !isTicketStatusCategory(input.completeCategory)) {
      throw new Error('admission_rule_invalid: lifecycle.completeCategory must be a ticket status category');
    }
    out.completeCategory = input.completeCategory;
  }
  return out;
}

/**
 * The lifecycle a stored rule runs. Stored values were validated on write, so this only fills
 * defaults; a malformed stored value (hand-edited row) falls back to the defaults rather than
 * stopping the sync that reads it.
 */
export function resolveAdmissionLifecycle(stored: unknown): AdmissionLifecycle {
  try {
    return parseAdmissionLifecycle(stored);
  } catch {
    return { ...DEFAULT_ADMISSION_LIFECYCLE };
  }
}
