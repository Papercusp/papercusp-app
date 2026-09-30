/**
 * WI-2142026 — detect a key that declares SAFETY-SLOT INTENT in its own spelling
 * (`wall-unified-web-portal-blocked-on-byoc-gates`) while passing no `slot:`
 * argument, so the writer is told the protection they think they have is absent.
 *
 * WHY THIS EXISTS. The `wall:` / `dead-end:` / `guard-rail:` slots are cap-exempt,
 * long-TTL and never-drop, and ALL of that is keyed on the normalized key PREFIX
 * (`capPopulationPredicate` in agent-facts/store.ts; the TTL defaults beside it).
 * The normalizers that PRODUCE that prefix (`normalizeWallSlot` and friends in
 * ./assert) run only when the caller passes `slot:`. So a caller who spells the
 * intent into the key instead gets an ordinary, evictable, 7-day row that reads
 * like a wall to every human and to no part of the machine — with no warning.
 *
 * Measured 2026-09-02 on workspace/papercusp-workspace: BOTH `wall-`-prefixed
 * near-miss keys in the scope had been cap-evicted, one of them that same hour in
 * a 16-victim trim while carrying a live owner-gated blocker ("Plan
 * unified-web-portal-2026-08-29 CANNOT reach `shipped` until BYOC live-host
 * gates"). The ordinary population sits permanently at 200/200, so an unprotected
 * near-miss key is not unlucky — it is scheduled.
 *
 * ⚠ WARN, NEVER AUTO-NORMALIZE. Rewriting `wall-foo` to `wall:foo` would change
 * the UPSERT KEY: the next re-assert of the caller's own fact would land on a
 * different row, forking the fact and orphaning the original under a key nobody
 * queries. The caller is the only party who can safely make that move, which is
 * why this module reports and does not repair.
 *
 * ⚠ LEADING TOKEN ONLY, DELIBERATELY. A trailing token cannot carry intent:
 * `p2p-gate-attestation-two-account-owner-wall` IS a wall, but
 * `auth-401-is-not-an-owner-wall` and `push-403-is-https-identity-not-owner-wall`
 * are conclusions asserting the exact OPPOSITE, and
 * `cold-loop-refires-into-date-qualified-weekly-wall` is a conclusion about walls
 * in general. Firing on those would nag every writer whose fact merely MENTIONS a
 * wall — which is how an advisory earns being ignored, taking the true positives
 * with it. The conservative line is the one that keeps this signal worth reading.
 *
 * PURE — no I/O, no clock, no db. Deliberately importable on its own so the
 * detector can be measured against real keys without standing up an assert.
 */

/** The slots whose protection is keyed on a normalized key prefix. */
export type SafetySlot = 'wall' | 'dead-end' | 'guard-rail';

/**
 * One near-miss finding. `suggestedKey` is what the caller would end up with by
 * passing `slot` and dropping the hand-spelled token — i.e. the key the
 * normalizer would have produced — so the receipt can show the exact repair
 * rather than describing it.
 */
export interface SafetySlotKeyIntent {
  slot: SafetySlot;
  /** The leading token exactly as the caller spelled it, separator included. */
  matchedPrefix: string;
  /** The key that `slot: '<slot>'` would have produced from the remainder. */
  suggestedKey: string;
}

/**
 * The canonical prefixes, mirrored from the store's own constants by VALUE here
 * rather than imported, because this module must stay free of the store's db
 * imports. The pairing is pinned by a test that imports both and asserts they
 * agree, so a rename in the store fails there instead of silently disabling the
 * canonical-form check below (which would make this detector fire on already
 * correct keys).
 */
export const CANONICAL_SLOT_PREFIXES: Readonly<Record<SafetySlot, string>> = {
  wall: 'wall:',
  'dead-end': 'dead-end:',
  'guard-rail': 'guard-rail:',
};

/**
 * Leading-token spellings that declare intent for each slot. Separator-tolerant
 * (`dead-end` / `deadend` / `dead_end`) because the thing being detected IS a
 * caller improvising a spelling; a detector that only understood the one correct
 * improvisation would miss the population it exists for.
 */
const INTENT_TOKENS: ReadonlyArray<{ slot: SafetySlot; pattern: RegExp }> = [
  { slot: 'wall', pattern: /^wall([-_.])/i },
  { slot: 'dead-end', pattern: /^dead[-_]?end([-_.])/i },
  { slot: 'guard-rail', pattern: /^guard[-_]?rail([-_.])/i },
];

/**
 * Report safety-slot intent spelled into `key` that will NOT be honoured.
 *
 * Returns null — meaning "nothing to warn about" — when:
 *  - `slot` was passed (the normalizer already produces the canonical key);
 *  - the key is ALREADY in canonical form (the store's prefix checks protect it,
 *    with or without the argument — this is the case WI-2141838 fixed);
 *  - no leading intent token is present;
 *  - the token is the whole key, leaving no remainder to suggest a repair from.
 */
export function detectSafetySlotKeyIntent(
  key: string,
  slot?: SafetySlot | null,
): SafetySlotKeyIntent | null {
  // An explicit slot means the caller is on the supported path; whatever they
  // spelled, the normalizer is about to produce the canonical key.
  if (slot) return null;

  const trimmed = key.trim();
  if (!trimmed) return null;

  // Already canonical ⇒ already protected. Checked before the intent tokens so a
  // correct `dead-end:foo` is never reported as a near-miss of itself (its
  // leading token matches `dead[-_]?end` followed by... a colon, which is not in
  // the separator class — but relying on that coincidence would be fragile, and
  // the colon IS the thing that makes the key correct).
  const lower = trimmed.toLowerCase();
  for (const prefix of Object.values(CANONICAL_SLOT_PREFIXES)) {
    if (lower.startsWith(prefix)) return null;
  }

  for (const { slot: candidate, pattern } of INTENT_TOKENS) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const matchedPrefix = match[0];
    const remainder = trimmed.slice(matchedPrefix.length).trim();
    // "wall-" with nothing after it declares no subject; there is no repair to
    // suggest and no fact worth protecting under an empty key.
    if (!remainder) return null;
    return {
      slot: candidate,
      matchedPrefix,
      suggestedKey: `${CANONICAL_SLOT_PREFIXES[candidate]}${remainder}`,
    };
  }

  return null;
}

/**
 * The receipt payload for a detected near-miss. Separated from the detector so
 * the wording lives beside the tool's other disclosures and the detector stays a
 * pure predicate that a test can measure without asserting on prose.
 */
export interface SafetySlotIntentWarning extends SafetySlotKeyIntent {
  note: string;
}

/** Build the caller-facing disclosure for a detected near-miss. PURE. */
export function buildSafetySlotIntentWarning(
  intent: SafetySlotKeyIntent,
): SafetySlotIntentWarning {
  return {
    ...intent,
    note:
      `This key starts with "${intent.matchedPrefix}", which reads as ${intent.slot === 'wall' ? 'an' : 'a'} ` +
      `'${intent.slot}' slot — but the slot was NOT applied, because slot protection is keyed on the ` +
      `normalized "${CANONICAL_SLOT_PREFIXES[intent.slot]}" prefix and is only produced by passing ` +
      `slot:'${intent.slot}'. As written, this fact is an ORDINARY row: it takes a seat in the capped ` +
      `population (so any agent's next assert can evict it), gets the ordinary TTL instead of the slot's, ` +
      `renders with no marker, and is absent from never-drop folds. It will fail SILENTLY — it simply ` +
      `stops appearing. Re-assert with slot:'${intent.slot}' to get the protection ` +
      `(key becomes "${intent.suggestedKey}"). ` +
      `This was NOT auto-corrected on purpose: rewriting the key would change the upsert target, so your ` +
      `next re-assert would fork a second fact and orphan this one. If the ordinary-row behaviour is what ` +
      `you meant, rename the key so it does not claim protection it does not have.`,
  };
}
