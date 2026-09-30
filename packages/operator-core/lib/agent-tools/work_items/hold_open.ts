/**
 * work_items:hold_open — hold a work-item OPEN in place, WITHOUT releasing your
 * claim (fleet-deltas-leader-primitives-2026-07-10 P-006; EI-8993 / EI-8973).
 *
 * The gap this closes: release { claimHold:true } is release-and-hold — the
 * leader pattern (WI-3548) is "I keep working/gating this item, but nobody may
 * close it or self-select it out from under me". hold_open stamps
 * `held_open_by` + `held_open_reason` on the payload (setWorkItemClaimHold):
 *   - claim_next / scheduler:get_next skip it (both claim floors honor _claimHold),
 *   - a TERMINAL transition by a NON-holder is refused (setWorkItemState's
 *     held-open guard) until the holder clears or closes it themselves,
 *   - the claim itself is untouched — the holder keeps working it.
 * `clear:true` lifts the hold (holder or force). The lifecycle note is
 * best-effort: a coord hiccup never un-holds the item.
 *
 * ⚠ EI-20710656847511624 — THIS TOOL IS THE WRONG ONE FOR A FENCE THAT MUST OUTLIVE YOU, and
 * its description now says so at CHOOSE time (it previously mentioned the sibling park only as
 * an AUDIT-time footnote, which is not where the decision gets made). The hold is a LEASE:
 * `sweepDeadOwnerControlState` / `reclaimStaleHoldOpens` match on `held_open_by = <dead owner>`
 * and lift the hold + `_claimHold` once the holder is past grace, so the item silently re-enters
 * the self-select pool when the fencing session dies. Both sweeps preserve a coexisting durable
 * park (`claim_hold_by`) and both exempt a policy-tier `held_open_reason` via the same shared
 * pattern constant — but that exemption keys off free-text reason WORDING, so it is not a
 * durability guarantee anyone should lean on.
 *   Measured: THREE agents in a row (2026-07-27 via a bare claim, su-89f241ac 2026-08-02 via
 * hold_open, su-a787d98c 2026-08-17 via hold_open) each fenced the SAME owner-gated live-money
 * items (WI-6175 / WI-5735) intending "permanent" and each got "until I die" — the 08-02 lease
 * was verified intact at 06:16Z and was gone by 08-17. When competent agents repeat a
 * predecessor's exact error, the defect is the AFFORDANCE, not the agents: the choose-time text
 * never mentioned the reaper. Both items are now durably parked via release { claimHold:true }.
 *
 * ⚠ EI-18672701535825889: `held_open_by`/`held_open_reason` is ONE of TWO `_claimHold`
 * provenance conventions, not the only one. `release { claimHold:true }` writes a SIBLING
 * convention — `claim_hold_by`/`claim_hold_reason` (a durable PARK: no reaper, no
 * terminal-transition gate, survives the parker's session ending — see
 * setWorkItemClaimHold's doc comment for the deliberate lease-vs-park split). An audit that
 * checks only this tool's fields will read every `claim_hold_by` row (the majority of held
 * rows on this harness) as unattributed — several are deliberate policy-tier human gates, not
 * corruption. Always read via `readWorkItemClaimHoldProvenance` (checks both), never
 * `readWorkItemHeldOpenBy` alone, when auditing why a row is held.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import {
  setWorkItemClaimHold,
  readWorkItemClaimHoldProvenance,
  looksLikePolicyGate,
} from '../../work-items';
import { lookupWorkItem } from './_lookup';

// EI-18672701535825889 / WI-5946: looksLikePolicyGate moved to work-items.ts so
// work_items:claim's claim-hold guard (claim.ts) shares the SAME predicate instead of a
// second copy that could drift — a reason naming a deliberate policy-tier human gate (a
// `D-NNN` decision id, the triage gate's own `triageDecision:"gate"` marker, or the literal
// phrase "policy-tier") must not be liftable/claimable by a bare `force:true`.

export default defineTool({
  name: 'work_items:hold_open',
  profile: 'engineer',
  description:
    'Hold a work-item OPEN without releasing your claim: stamps you as held_open_by (+ reason), excludes it from ' +
    'claim_next/scheduler self-select, and makes a terminal transition (done/resolved/closed/dropped) by anyone ELSE ' +
    'refuse until you clear it. { id, reason } to hold; { id, clear:true } to lift. Clearing another agent\'s hold ' +
    'needs force:true (leader override). ⚠ THIS HOLD IS A LEASE, NOT A PERMANENT FENCE: the WI-4531 dead-owner reaper ' +
    'lifts it once you are dead past grace, so the item re-enters self-select when your session ends. To fence ' +
    'anything that must OUTLIVE your session (an owner-gated item, a policy decision), use release { claimHold:true } ' +
    // P-011 prompt-weight: the burn_down audit pointer moved to the free `returns`, beside
    // the not_holder refusal that names the same two conventions (EI-22083648545226771).
    '— a durable PARK (claim_hold_by) no reaper touches.',
  guidance: {
    when:
      'You are gating an item — verifying, awaiting evidence, or keeping a recurring/leader item alive — and peers must ' +
      'neither close it nor self-select it while you do. Your claim stays; work continues.',
    notWhen:
      'You are WALKING AWAY from the item, or the fence must OUTLIVE your session — that is work_items:park (checkpoint ' +
      '+ release) or release { claimHold:true } (release + hold). Blocked on an external event/gate/runtime/human condition → ' +
      'work_items:set_blocker. Blocked by another work-item → work_items:link { rel:"blocks" }. Done → ' +
      'complete (a holder completing their own held item is allowed).',
    chaining:
      'work_items:hold_open { id, reason } → work → complete/set_state yourself (holder passes the guard), or hold_open { id, clear:true } to hand it back to normal lifecycle.',
    returns:
      'Hold: { ok, id, held:true, heldBy, reason, note? } (note is set when you re-stamped another agent\'s hold). ' +
      'Clear: { ok, id, held:false, clearedFrom }. Refusals: not_holder (+ heldBy, reason, convention — says whether ' +
      'you hit a held_open LEASE or a claim_hold DURABLE PARK), policy_gate_requires_owner_override (force:true alone ' +
      'is refused for a policy-tier reason; a policy-tier reason is also exempt from the reaper, but do NOT rely on ' +
      'reason wording for durability — park it), work_item_unreadable (a READ failure, not a missing item: retry ' +
      'rather than re-filing), clear_failed, hold_failed. Auditing why a row is held? read work_items:burn_down\'s ' +
      'parked reason — it checks both conventions.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).describe('the work-item id to hold open (or clear)'),
      reason: z.string().min(1).max(500).optional().describe('why it must stay open — stamped as held_open_reason + broadcast (required unless clear:true)'),
      clear: z.boolean().optional().describe('true lifts the hold instead of setting it'),
      force: z.boolean().optional().describe('clear ANOTHER agent\'s hold (leader override only; default false refuses with not_holder) — checked against BOTH claim-hold provenance conventions (held_open_by lease AND claim_hold_by durable park)'),
      ownerOverride: z
        .boolean()
        .optional()
        .describe(
          'REQUIRED (in addition to force) to clear a hold whose reason names a policy-tier gate (a D-NNN decision id, ' +
            'triageDecision:"gate", or "policy-tier") — force:true alone refuses it (EI-18672701535825889).',
        ),
      harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
    })
    .refine((a) => a.clear === true || Boolean(a.reason), { message: 'pass { reason } to hold, or { clear:true } to lift' }),
  result: z
    .object({
      ok: z.boolean().optional(),
      id: z.string().optional(),
      held: z.boolean().optional(),
      heldBy: z.string().nullable().optional(),
      reason: z.string().optional(),
      note: z.string().optional(),
      clearedFrom: z.unknown().optional(),
      error: z.string().optional(),
      convention: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null };
    const hint = args.harness ?? c.harnessSlug ?? undefined;
    const hintHarness = hint && hint !== '*' ? hint : undefined;
    const fail = (payload: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, id: args.id, ...payload }) }],
    });
    // WI-6746: an unreadable item must not be reported as an absent one — the caller is
    // about to place or clear a HOLD, and "not found" sends them to re-file or re-create
    // rather than retry. Absence and unreachability are different answers.
    const lookup = await lookupWorkItem(args.id, hintHarness);
    if (lookup.status === 'unreadable') {
      return fail({
        error: `work_item_unreadable — could not read '${args.id}' (${lookup.error}). This is a READ FAILURE, not a missing item: retry rather than re-filing it.`,
      });
    }
    if (lookup.status === 'missing') return fail({ error: `work_item '${args.id}' not found` });
    const item = lookup.item;
    // EI-18672701535825889: check BOTH claim-hold provenance conventions — a row held ONLY via
    // the durable-park convention (claim_hold_by, no held_open_by) previously slipped through
    // this guard entirely (readWorkItemHeldOpenBy alone returned null ⇒ `prior` falsy ⇒ no
    // not_holder check, no force required), silently clearing another agent's park.
    const provenance = readWorkItemClaimHoldProvenance(item.payload);
    const prior = provenance.heldOpen ?? provenance.parked;
    if (args.clear) {
      if (prior && prior.by !== ident.ownerId) {
        if (looksLikePolicyGate(prior.reason) && !args.ownerOverride) {
          return fail({
            error: 'policy_gate_requires_owner_override',
            heldBy: prior.by,
            reason: prior.reason,
            convention: provenance.heldOpen ? 'held_open (lease)' : 'claim_hold (durable park)',
            hint: `${args.id} is held for a policy-tier reason ("${(prior.reason ?? '').slice(0, 160)}") — force:true alone is refused for a policy gate. Pass ownerOverride:true only with genuine owner sign-off (EI-18672701535825889).`,
          });
        }
        if (!args.force) {
          return fail({
            error: 'not_holder',
            heldBy: prior.by,
            reason: prior.reason,
            convention: provenance.heldOpen ? 'held_open (lease)' : 'claim_hold (durable park)',
            hint: `Held by ${prior.by} (${provenance.heldOpen ? 'held_open lease' : 'claim_hold durable park'}), not you — coordinate with the holder (coord:send) or pass force:true (leader override).`,
          });
        }
      }
      const cleared = await setWorkItemClaimHold(args.id, false, { harness: item.harness ?? undefined });
      if (!cleared) return fail({ error: 'clear_failed' });
      await sendMessage(ident, {
        to: ['*'],
        summary: `🔓 ${args.id} hold-open CLEARED by ${ident.ownerId}${prior && prior.by !== ident.ownerId ? ` (was ${prior.by}, forced)` : ''} — normal lifecycle resumes`,
        harnessSlug: item.harness ?? undefined,
        extra: { auto: true, lifecycle: 'hold_open_clear', work_item: args.id },
      }).catch(() => {});
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, held: false, clearedFrom: prior?.by ?? null }) },
        ],
      };
    }
    const held = await setWorkItemClaimHold(args.id, true, {
      harness: item.harness ?? undefined,
      by: ident.ownerId,
      reason: args.reason,
    });
    if (!held) return fail({ error: 'hold_failed' });
    await sendMessage(ident, {
      to: ['*'],
      summary: `🔒 ${args.id} HELD OPEN by ${ident.ownerId} — no terminal transition by others until cleared: ${(args.reason ?? '').slice(0, 140)}`,
      harnessSlug: item.harness ?? undefined,
      extra: { auto: true, lifecycle: 'hold_open', work_item: args.id },
    }).catch(() => {});
    // EI-20710656847511624: state the lease's EXPIRY at the moment of the call. Three agents in
    // a row placed a hold_open intending a permanent fence and each got one the dead-owner sweep
    // lifted when their session ended; each had verified the hold APPLIED (has_hold=true,
    // still_claimable=false) and stopped there, because nothing in the response said the hold was
    // liveness-bound. A caller who reads only `{ ok:true, held:true }` must not be able to
    // conclude "fenced permanently". Emitted unconditionally — never inferred from reason prose,
    // which is exactly the free-text guessing the policy-gate exemption already shows is fragile.
    const policyExempt = looksLikePolicyGate(args.reason ?? null);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: args.id,
            held: true,
            heldBy: ident.ownerId,
            reason: args.reason,
            note: prior && prior.by !== ident.ownerId ? `re-stamped (was held by ${prior.by})` : undefined,
            durability: policyExempt ? 'lease (policy-tier exempt from reaping)' : 'lease (expires when you do)',
            leaseNote: policyExempt
              ? 'This is a LEASE (held_open_*), but its reason names a policy-tier gate, so the dead-owner sweeps exempt ' +
                'it from reaping. That exemption keys off reason WORDING, not intent — if this fence must outlive your ' +
                'session, do not lean on it: release { claimHold:true } writes a durable park (claim_hold_*) instead.'
              : 'This is a LEASE, NOT a permanent fence: the dead-owner sweeps lift it once you are dead past grace, and ' +
                'the item then re-enters the self-select pool. If this fence must OUTLIVE your session (an owner-gated ' +
                'item, a policy decision), use release { claimHold:true } — a durable park (claim_hold_*) no reaper ' +
                'touches (EI-20710656847511624).',
          }),
        },
      ],
    };
  },
});
