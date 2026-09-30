/**
 * affected-owners — identify the live sessions routed through an account at the
 * moment it is disabled, and format the at-risk alert (EI-15153, P-001 + detector).
 *
 * Incident (2026-07-17 ~20:30Z): inference account 'ownerhandle7' was org/subscription
 * DISABLED; the gateway correctly removed it from the pool + broadcast, BUT the
 * live sessions routing through it (su-b621dc7f mid-E2E, su-18f2fc5d) went cold
 * WITHOUT a handoff — orphaning claimed work. The gateway's org-disallowed
 * broadcast was untargeted ("to *"), so nobody knew WHICH sessions were at risk.
 *
 * This module is the PURE core of the fix: given a snapshot of the gateway's
 * per-owner routing ledger, it selects the owners whose LAST route was the
 * now-dead account (recently) — i.e. the sessions that did NOT successfully
 * fail over off it and are therefore at risk of a cold orphan — and formats the
 * at-risk line the disable escalation/broadcast now carries. Kept pure (no PG /
 * gateway internals) so it unit-tests directly; the gateway wires the snapshot
 * in (it owns `ownerLedger`) and launch.ts appends the formatted line to the
 * existing alert.
 *
 * Scope note: this module holds the PURE cores for BOTH halves — the DETECTOR
 * (identify + name who is at risk: {@link selectAffectedOwners} /
 * {@link formatAtRiskAlertSuffix}) AND the ACTING halves' message/formatting cores
 * ({@link buildSelfDrainWake} for the P-003 directed self-drain wake;
 * {@link formatOrphanedClaimsSuffix} for the P-004 surface-only reclaim list). The
 * launch.ts disable hook wires the IO (sendMessage + wakeRecipients + the claims
 * lookup); everything policy-bearing here stays pure + unit-tested. Per plan
 * account-disable-graceful-drain-2026-07-17 (D1 safest-first, D2 leader-surfaced):
 * P-003 + P-004 are ADDITIVE (a directed notify/wake to the affected owners, and a
 * read-only reclaim list on the already-firing alert) — NO auto-release lives here;
 * orphaned claims are auto-freed by the EXISTING periodic stale-claim reaper
 * (reclaimStaleWorkItemClaims) after its grace window, which stays the backstop.
 */

/** The fields of an owner's routing-ledger entry this selection needs — a
 *  structural subset of the gateway's internal OwnerLedgerEntry so the accessor
 *  is decoupled from the gateway's private shape. */
export interface OwnerRouteSnapshot {
  ownerId: string;
  /** The account this owner most-recently routed through (null = never routed). */
  lastAccount: string | null;
  /** Epoch ms of the owner's last routing activity. */
  lastAt: number;
}

/** How recent an owner's last activity must be to count as an at-risk LIVE
 *  session (vs. a long-idle ledger entry that happens to name the account). The
 *  disable fires moments after the affected sessions' 403s, so their lastAt is
 *  seconds old; this window is generous but still excludes stale entries. */
export const AFFECTED_OWNER_RECENCY_MS = 10 * 60_000;

/**
 * The owners at risk of an orphaned cold-death from `accountId` being disabled:
 * those whose LAST route was that account (they did not fail over off it) and
 * who were active within `recencyMs`. Sorted + de-duplicated for a stable alert.
 * An owner who successfully moved to another account has a different
 * `lastAccount` and is correctly excluded.
 */
export function selectAffectedOwners(
  entries: readonly OwnerRouteSnapshot[],
  accountId: string,
  nowMs: number,
  recencyMs: number = AFFECTED_OWNER_RECENCY_MS,
): string[] {
  if (!accountId) return [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.ownerId) continue;
    if (e.lastAccount !== accountId) continue;
    if (nowMs - e.lastAt > recencyMs) continue;
    seen.add(e.ownerId);
  }
  return [...seen].sort();
}

/**
 * The at-risk suffix appended to the org-disable escalation body + fleet
 * broadcast, so a leader/human sees exactly WHICH sessions to check instead of a
 * bare "account removed" notice. Empty string when no owner is at risk (so the
 * alert is unchanged in the common case), keeping the enrichment purely additive.
 */
export function formatAtRiskAlertSuffix(affectedOwners: readonly string[]): string {
  const atRisk = affectedOwners.filter((o) => Boolean(o));
  if (atRisk.length === 0) return '';
  return (
    ` ⚠ Live sessions that were routing through this account when it was disabled may now be ORPHANED — ` +
    `their next inference turn fails, so they cannot self-drain: ${atRisk.join(', ')}. ` +
    `A fleet leader should check + reclaim their in-flight claims (release a cold session's claim with a reason).`
  );
}

/** The directed self-drain notice+wake payload built for the at-risk owners
 *  (EI-15153 P-003). `to` is the concrete recipient set (deduped + sorted). */
export interface SelfDrainWake {
  to: string[];
  summary: string;
  body: string;
}

/**
 * P-003 — the best-effort self-drain wake payload for the sessions that were
 * routing through the now-disabled account. Pure: launch.ts sends it (sendMessage
 * to `to`) + fires the inbox-wake for the same set. Returns null when there is no
 * one to wake (no account id, or no affected owner) so the caller skips the send
 * entirely — the enrichment stays additive.
 *
 * The design tension (plan account-disable-graceful-drain-2026-07-17): the disabled
 * account's sessions cannot self-drain on the DEAD account (their next turn 403s).
 * But the gateway REMOVES the account from the pool BEFORE this fires, so a woken
 * session's next turn fails over to a HEALTHY account for one final turn — enough to
 * checkpoint + release. Harmless if the session is already dead (wake is a no-op).
 */
export function buildSelfDrainWake(
  accountId: string,
  affectedOwners: readonly string[],
): SelfDrainWake | null {
  const to = [...new Set(affectedOwners.filter((o) => Boolean(o)))].sort();
  if (!accountId || to.length === 0) return null;
  const summary = `Your inference account '${accountId}' was DISABLED — checkpoint + release your claims NOW before you go cold`;
  const body =
    `The inference account your session was routing through ('${accountId}') was just org/subscription-DISABLED and ` +
    `REMOVED from the gateway pool. Your NEXT inference turn routes through a HEALTHY account — use it to WIND DOWN ` +
    `cleanly, because you may lose inference after it: 1) flush your carry-note (loop:checkpoint) + each held work-item's ` +
    `in-flight state (work_items:checkpoint); 2) RELEASE every claim you can't finish this turn (work_items:release, with ` +
    `a reason like "account-disabled — handing off") so it re-enters the pool for a peer; 3) end your turn. If you cannot ` +
    `take another turn, your fleet leader has been alerted to reclaim your in-flight claims and the periodic stale-claim ` +
    `reaper requeues them after the grace window — but a clean self-release now is faster and loses no context.`;
  return { to, summary, body };
}

/** One at-risk owner's still-held, non-terminal claims (EI-15153 P-004,
 *  surface-only). The launch.ts hook fills `claims` from listWorkItems. */
export interface OrphanedClaim {
  ownerId: string;
  claims: { id: string; title: string }[];
}

/**
 * P-004 (surface-only) — the reclaim-list suffix appended to the org-disable
 * escalation body + broadcast: for each at-risk owner, the specific work-item ids
 * (with titles) they were still holding at disable time, so the leader gets a
 * CONCRETE reclaim list immediately instead of waiting out the periodic stale-claim
 * reaper's grace window (which remains the auto-release backstop). Pure — launch.ts
 * does the read; this only formats. Empty string when nobody is holding anything, so
 * the alert is unchanged in the common case (purely additive). Owners with no held
 * claims (already self-released, or a lookup miss) are dropped; the set is sorted for
 * a stable alert.
 */
export function formatOrphanedClaimsSuffix(orphans: readonly OrphanedClaim[]): string {
  const withClaims = orphans
    .filter((o) => o.ownerId && o.claims.length > 0)
    .slice()
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  if (withClaims.length === 0) return '';
  const lines = withClaims.map((o) => {
    const items = o.claims.map((c) => `${c.id}${c.title ? ` (${c.title})` : ''}`).join('; ');
    return `${o.ownerId} → ${items}`;
  });
  return (
    ` Still-held claims to RECLAIM if their owner does not self-release ` +
    `(release a cold session's claim with a reason): ${lines.join(' | ')}.`
  );
}
