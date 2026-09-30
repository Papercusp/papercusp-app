/**
 * claim-hold-guard — WI-5946: `work_items:claim`'s by-id path never checked
 * `payload._claimHold` at all.
 *
 * Reproduced live (2026-07-26): EI-1416 carries `payload._claimHold:true` +
 * `held_open_reason: "RESTORED by fleet leader... explicit policy-tier human gate (D-003)...
 * must NOT be opportunistically self-picked... Do not clear without owner sign-off."` —
 * a live security-sensitive item (latent IDOR / tenant-isolation bypass). Despite that,
 * `work_items:claim { id: 'EI-1416' }` succeeded with no refusal and no warning. The claim-hold
 * mechanism already gates TWO other surfaces — self-select (claim_next / scheduler:get_next
 * skip `_claimHold` rows) and a non-holder's terminal transition (`setWorkItemState`'s
 * held-open guard, EI-8993) — but never the by-id CLAIM path, so a drain-fleet member routing
 * around a claim-path bug exactly as `scheduler:get_next`'s own advice suggests ("list with
 * work_items:claimable... take a specific row with work_items:claim { id }") could silently
 * self-pick an item an owner explicitly gated off-limits.
 *
 * This module mirrors `work_items:hold_open`'s existing clear-guard EXACTLY (same
 * `looksLikePolicyGate` predicate, same `force` + `ownerOverride` two-tier assertion,
 * EI-18672701535825889) applied to the CLAIM operation instead of the CLEAR operation — one
 * predicate, two enforcement points, never a drifting second copy. And it mirrors
 * `release-force-guard.ts`'s audit-row + notify shape for a bypassed gate, so a forced
 * claim-hold bypass leaves the SAME forensic trail a forced release does.
 *
 * Deliberately does NOT gate on "who set the hold" the way hold_open's clear does (a holder
 * clearing their OWN hold needs no force) — claiming is a DIFFERENT actor's action from
 * setting the hold in the D-003 pattern (a leader parks an item FOR a named owner to later
 * claim), so uniform friction (force required regardless of who set it) is the safe default;
 * the claim-hold stays in place after a forced claim (this module never clears it) — a leader
 * can still lift it explicitly via `work_items:hold_open { clear:true }` when it should no
 * longer gate the item at all.
 */
import { looksLikePolicyGate, readWorkItemClaimHoldProvenance } from '../../work-items';

export interface ClaimHoldRefusal {
  error: 'claim_hold_blocked' | 'policy_gate_requires_owner_override';
  heldBy: string;
  heldReason: string | null;
  convention: 'held_open (lease)' | 'claim_hold (durable park)';
  hint: string;
}

/**
 * Does `payload` carry an active `_claimHold`, and — if `force`/`ownerOverride` do not clear
 * it — what refusal should the caller see? `null` ⇒ the claim may proceed (either unheld, or
 * the caller's force/ownerOverride combination clears the gate).
 */
export function assessClaimHoldGuard(
  payload: unknown,
  opts: { force?: boolean; ownerOverride?: boolean; holderGuidance?: string | null },
): ClaimHoldRefusal | null {
  const provenance = readWorkItemClaimHoldProvenance(payload);
  const prior = provenance.heldOpen ?? provenance.parked;
  if (!prior) return null;
  const holderGuidance = opts.holderGuidance?.trim();
  const holderGuidanceSuffix = holderGuidance ? ` ${holderGuidance}` : '';
  const convention: ClaimHoldRefusal['convention'] = provenance.heldOpen
    ? 'held_open (lease)'
    : 'claim_hold (durable park)';
  if (looksLikePolicyGate(prior.reason) && !opts.ownerOverride) {
    return {
      error: 'policy_gate_requires_owner_override',
      heldBy: prior.by,
      heldReason: prior.reason,
      convention,
      hint:
        `held for a policy-tier reason ("${(prior.reason ?? '').slice(0, 160)}") — ` +
        'force:true alone is refused for a policy gate. Pass ownerOverride:true only with genuine owner ' +
        'sign-off (EI-18672701535825889), or coordinate with the holder/owner instead of claiming past it.' +
        holderGuidanceSuffix,
    };
  }
  if (!opts.force) {
    return {
      error: 'claim_hold_blocked',
      heldBy: prior.by,
      heldReason: prior.reason,
      convention,
      hint:
        `parked out of self-select by ${prior.by}${prior.reason ? ` ("${prior.reason.slice(0, 160)}")` : ''} ` +
        '(WI-5946) — a claim-hold is a deliberate, durable exclusion, not incidental staleness. Coordinate ' +
        'with the holder/leader (coord:send), or pass force:true to claim past it anyway (audited + both ' +
        'notified). The hold itself is left in place — use work_items:hold_open { clear:true } to lift it.' +
        holderGuidanceSuffix,
    };
  }
  return null;
}

/** Forensic audit row — mirrors release-force-guard.ts's recordForceReleaseAudit shape.
 *  Fire-and-forget; never throws (the claim already happened). */
export async function recordClaimHoldBypassAudit(
  actor: string,
  itemId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../workspace-registry'),
    ]);
    const { sql } = getOrgPg();
    const id = `wi-force-claim-hold-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, 'work_items:claim:force_claim_hold', itemId, JSON.stringify(details), activeWorkspaceId()],
    );
  } catch (err) {
    console.warn('[work_items:claim] claim-hold bypass audit write failed:', (err as Error)?.message);
  }
}

/** Notify the hold's holder (coord inbox — read on resume even if dead now) and the owner
 *  (attention channel) that their claim-hold was claimed past. Never throws. */
export async function notifyClaimHoldBypass(
  ident: { ownerId: string },
  input: {
    itemId: string;
    heldBy: string;
    heldReason: string | null;
    convention: ClaimHoldRefusal['convention'];
    harness?: string | null;
  },
): Promise<void> {
  const reasonSnippet = (input.heldReason ?? '').slice(0, 140);
  try {
    const { sendMessage } = await import('../coordination/messages');
    await sendMessage(ident as never, {
      to: [input.heldBy],
      summary: `⚠ ${input.itemId} was CLAIMED PAST your ${input.convention} claim-hold by ${ident.ownerId}${reasonSnippet ? ` — hold reason: ${reasonSnippet}` : ''}`,
      harnessSlug: input.harness ?? undefined,
      extra: { auto: true, lifecycle: 'claim_hold_bypass', work_item: input.itemId, convention: input.convention },
    });
  } catch (err) {
    console.warn('[work_items:claim] claim-hold bypass holder-notify failed:', (err as Error)?.message);
  }
  try {
    const { notifyAttention } = await import('../../attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title: `work_items:claim force — ${input.itemId}`,
      body: `${ident.ownerId} claimed ${input.itemId} PAST a claim-hold set by ${input.heldBy} (${input.convention})${reasonSnippet ? `: ${reasonSnippet}` : ''}`,
      importance: 'high',
      harnessSlug: input.harness ?? undefined,
      data: { workItem: input.itemId, heldBy: input.heldBy, convention: input.convention },
    });
  } catch (err) {
    console.warn('[work_items:claim] claim-hold bypass owner-notify failed:', (err as Error)?.message);
  }
}
