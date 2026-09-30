/**
 * fleet-scoped-broadcast-default — a member of a fleet who addresses a message to
 * `['*']` almost always means "my fleet", not "every agent in the hive". A bare
 * `*` from every fleeted agent's per-wake status update is what floods every other
 * agent's inbox with cross-fleet chatter.
 *
 * So: when a FLEETED sender broadcasts (`to` includes `'*'`), rewrite the `'*'`
 * token to `@fleet:<slug>` (which the audience resolver already unions the fleet
 * LEADER into) — UNLESS the sender consciously claims a hive-wide broadcast
 * (`allHive:true`). A non-fleeted agent's `*` is left untouched (their broadcast IS
 * correctly scoped — they belong to no cohort). This mirrors coord:send's own
 * philosophy: the scoped/quiet thing is the default, and the broad thing must be
 * consciously claimed — and the rewrite is REPORTED, never silent.
 *
 * Pure + unit-tested; the IO (reading the sender's fleet from presence) stays in
 * the calling tool.
 */

/**
 * Envelope field persisting the CONSCIOUS hive-wide claim (`allHive:true` on a
 * real `'*'` broadcast) — stamped by tools/send.ts so the H5b detector
 * (allpot-broadcast-sweep.ts, P-010/WI-4175) can sweep exactly the claimed
 * blasts post-hoc. Deliberately NOT stamped on a plain non-fleeted sender's
 * bare `'*'` (normal traffic — live data: hundreds/day) — the flag marks the
 * override, not the wildcard.
 */
export const ALLHIVE_BROADCAST_FIELD = 'allHiveBroadcast';

export interface BroadcastScopeResult {
  /** The (possibly rewritten) recipient list to actually send to. */
  to: string[];
  /** Present iff a `'*'` was down-scoped to the sender's fleet — surfaced on the
   *  send result so the rewrite is transparent and teaches the override. */
  scoped?: { from: '*'; to: string; reason: string };
  /** True iff the sender consciously broadcast hive-wide (`allHive` + a real `'*'`)
   *  — the conscious-claim path, surfaced so an all-hive blast is never invisible. */
  allHive?: boolean;
}

/**
 * Fleet-scope a broadcast recipient list. See the module header for the rule.
 * - `allHive:true` → honor `'*'` verbatim (conscious hive-wide claim), flag it.
 * - sender not in a fleet, or `to` has no `'*'` → unchanged.
 * - otherwise → replace the `'*'` token with `@fleet:<senderFleet>` and report it.
 */
export function scopeBroadcastAudience(opts: {
  to: string[];
  senderFleet: string | null | undefined;
  allHive?: boolean;
}): BroadcastScopeResult {
  const { to, senderFleet, allHive } = opts;
  const hasWildcard = to.includes('*');
  if (allHive) {
    // Conscious hive-wide claim: leave `'*'` in place, but mark it so the send
    // result can surface (and audit) that this really did blast every agent.
    return hasWildcard ? { to, allHive: true } : { to };
  }
  if (!senderFleet || !hasWildcard) return { to };

  const fleetSelector = `@fleet:${senderFleet}`;
  const rewritten: string[] = [];
  for (const id of to) {
    // collapse the '*' token to the fleet selector; de-dupe throughout so a
    // wildcard sitting next to an explicit @fleet:<slug> can't double the recipient
    const mapped = id === '*' ? fleetSelector : id;
    if (!rewritten.includes(mapped)) rewritten.push(mapped);
  }
  return {
    to: rewritten,
    scoped: {
      from: '*',
      to: fleetSelector,
      reason:
        `you are a member of fleet '${senderFleet}', so a bare '*' broadcast was scoped to your fleet ` +
        `(${fleetSelector}, which includes your leader) rather than every agent in the hive. ` +
        `Pass allHive:true only if this genuinely must reach everyone (a system-wide issue / urgent notice).`,
    },
  };
}
