/**
 * resource:delegate — the ONE delegation write path for the /res Resources board
 * (agent-allocation-framework-2026-07-03 P-002, D-004).
 *
 * A host hands its resources to a fleet: an account pool or a local GPU with a
 * share-% cap (the autonomous-loop capacity axis), or agent SEATS — kind
 * 'agent_slot': N × model·effort on a gateway-linked account (D-002/D-003).
 * Agents and the /res UI are BOTH callers of the same core (`delegateResource`):
 * the MCP tool wraps the store; the p2p-allotment-set loopback wraps this core.
 *
 * Layering (deliberate, per the plan): the STORE (p2p/resource-allotments.ts)
 * owns ALL field validation + the typed refusal shapes (workspace_unresolved /
 * fleet_required / resource_required / invalid_resource_kind / invalid_share_pct
 * and, for agent_slot once P-001 lands: invalid_model / invalid_effort /
 * invalid_account / quantity_required / quantity_out_of_range). This layer only
 * SHAPES the D-004 call onto the store contract and passes refusals through —
 * so the tool inherits P-001's agent_slot validation the moment the store
 * lands, and refuses agent_slot loudly (invalid_resource_kind) until then.
 *
 * agent_slot mapping (the P-001 pinned contract, 2026-07-03 su-504db):
 *   - the (model, effort, account) trio lives IN `axis`; the store DERIVES
 *     resourceRef = `${model}:${effort}:${account}` (ref↔axis can't disagree).
 *     We compose the same ref here only as the remove-row key + a pre-P-001
 *     non-empty placeholder — derivation wins on write.
 *   - `quantity` is top-level (mig 486; int 1..1000), required for agent_slot.
 *   - sharePct is IGNORED for agent_slot (stored as 0 — slots cap by COUNT).
 *   - account defaults to 'AUTO' AT THIS LAYER (D-003: the gateway draws from
 *     the fleet's allocated accounts) — the store stores it verbatim.
 *
 * Allotments are LOCAL/per-machine (M19). D-005 (P-007): an agent_slot
 * delegation ALSO federates as a standing SEAT-OFFER — the success path below
 * fires p2p/offer-store-publish.ts best-effort (set → open/paused, remove →
 * cancelled) so the fleet owner's operator sees this machine's seats; the
 * gateway account id itself never crosses the wire.
 *
 * pot-seat-pools-prose-ux-2026-07-18 P-001: the grantee generalizes from
 * "always exactly one fleet" to "exactly one of fleetSlug/potSlug" — a
 * pot-scoped allotment hands the resource to a whole pot (audience-gated:
 * 'trusted-members' | 'whole-pot', REQUIRED for the pot form, D-002) instead
 * of one named fleet. The store owns the xor + audience validation; this
 * layer only threads the fields through (to setResourceAllotment /
 * removeResourceAllotment / the seat-offer publish, which targets the pot's
 * hive topic instead of the fleet owner when potSlug is set).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import {
  ALLOTMENT_AUDIENCES,
  removeResourceAllotment,
  setResourceAllotment,
  type AllotmentAudience,
  type ResourceAllotment,
  type SetAllotmentArgs,
} from '../../p2p/resource-allotments';
import type { OrgSql } from '../../work-items';
import { trackDetached } from '../../detached-imports';

/** D-003: the gateway-auto account sentinel a slot defaults to at the tool layer. */
export const AUTO_ACCOUNT = 'AUTO';

/** P-001 forward seam: SetAllotmentArgs grows a first-class `quantity` with mig 486. */
type StoreSetArgs = SetAllotmentArgs & { quantity?: number };

export interface DelegateResourceInput {
  /** The caller's RESOLVED identity workspace (the store refuses unresolvable ones). */
  workspaceId: string | null | undefined;
  /** The grantee — exactly one of fleetSlug/potSlug (pot-seat-pools-prose-ux-2026-07-18 P-001; the store refuses otherwise). */
  fleetSlug?: string;
  /** Pot-scoped grantee (P-001): hand this resource to a whole pot (audience-gated) instead of one named fleet. */
  potSlug?: string;
  /** Required iff potSlug is set (D-002 — no silent default at the tool boundary); refused alongside fleetSlug. */
  audience?: AllotmentAudience;
  /** account | gpu | agent_slot — the store owns kind validation. */
  kind: string;
  /** account/gpu: the pool/GPU id (required by the store). agent_slot: optional — derived from the trio. */
  ref?: string;
  /** account/gpu share cap 0–100 (store-validated). Ignored for agent_slot. */
  sharePct?: number;
  /** agent_slot: seat COUNT (store caps 1..1000). */
  count?: number;
  /** agent_slot trio (axis). account defaults to AUTO here (D-003/D-004). */
  model?: string;
  effort?: string;
  account?: string;
  /** Extra axis passthrough (the P-201 forward seam for account/gpu; merged under the trio for agent_slot). */
  axis?: Record<string, unknown>;
  status?: 'active' | 'paused';
  /** Revoke the fleet's draw on the resource (the /res chip's ×). */
  remove?: boolean;
  /** The setting host's numeric GitHub id (display/audit). */
  createdByGithubUserId?: number | null;
  /** WI-5211/EI-16667: the shared-hive home slug to advertise an agent_slot seat
   *  in when this workspace hosts MORE THAN ONE shared hive. REQUIRED in that
   *  case for a fleet-scoped (non-potSlug) agent_slot set — omitting it is now a
   *  loud `hive_required` refusal (not a silent publish-skip): a multi-hive
   *  workspace can't disambiguate which hive to advertise into, and the seat
   *  would otherwise be delegated locally but never discoverable pot-wide.
   *  Ignored for a single-hive workspace, a potSlug-scoped delegation (the pot
   *  names its hive directly), and account/gpu kinds. */
  hive?: string;
}

export type DelegateResourceResult =
  | { ok: true; action: 'set'; allotment: ResourceAllotment }
  | { ok: true; action: 'remove'; removed: number }
  | { ok: false; refusal: { code: string; detail: string } };

/** Compose the agent_slot row key (`model:effort:account`) — mirrors the store's derivation. */
function slotRef(model: string, effort: string, account: string): string {
  return `${model}:${effort}:${account}`;
}

/**
 * The shared delegation core — the MCP tool AND the /res loopback both call this.
 * Maps the D-004 shape onto the store contract, passes store refusals through
 * untouched, and fires the board's sync invalidate on success.
 */
export async function delegateResource(
  input: DelegateResourceInput,
  opts?: {
    sqlOverride?: OrgSql;
    skipInvalidate?: boolean;
    /** Test seam only — overrides the ambiguous-hive check's scope resolver. */
    resolveScopeOverride?: typeof resolveWorkspaceHiveScope;
  },
): Promise<DelegateResourceResult> {
  const isSlot = input.kind === 'agent_slot';
  // agent_slot trio: explicit fields win; an axis-shaped caller (the loopback) may
  // carry them inside `axis`; account defaults to AUTO at this layer (D-003).
  const axisIn = input.axis ?? {};
  const model = (input.model ?? (typeof axisIn.model === 'string' ? axisIn.model : ''))?.trim() ?? '';
  const effort = (input.effort ?? (typeof axisIn.effort === 'string' ? axisIn.effort : ''))?.trim() ?? '';
  const account =
    ((input.account ?? (typeof axisIn.account === 'string' ? axisIn.account : ''))?.trim() || AUTO_ACCOUNT);

  // The row identity: account/gpu use the caller's ref; agent_slot rows key on the
  // derived template (the store re-derives on write; this composed one is the
  // remove-row key + the pre-P-001 non-empty placeholder).
  const resourceRef = isSlot ? (input.ref?.trim() || slotRef(model, effort, account)) : (input.ref ?? '');

  // EI-16667 (D-003 fail-closed/loud-refusal invariant): an agent_slot set on a
  // workspace with MULTIPLE shared hives can't disambiguate which hive the P2P
  // seat-offer publish should advertise into. Without this check the local
  // allotment write silently succeeded (ok:true) while the federation leg
  // silently no-op'd (offer-store-publish.ts: no_single_shared_hive:many) — a
  // caller had no way to tell the seat never became discoverable pot-wide. A
  // pot-scoped delegation (potSlug) already names its hive directly, and a
  // ZERO-shared-hive workspace stays fail-SOFT on purpose (a single-machine dev
  // box must still be able to delegate seats — see offer-store-publish.ts
  // header): only the genuinely ambiguous 'many' case, with no disambiguator,
  // refuses loudly instead of silently creating a locally-orphaned allotment.
  if (isSlot && !input.remove && !input.potSlug && !input.hive?.trim()) {
    const resolveScope = opts?.resolveScopeOverride ?? resolveWorkspaceHiveScope;
    const scope = await resolveScope(input.workspaceId ?? '');
    if (scope.kind === 'many') {
      return {
        ok: false,
        refusal: {
          code: 'hive_required',
          detail:
            `this workspace has ${scope.candidates.length} shared hives — pass \`hive\` ` +
            `(one of: ${scope.candidates.join(', ')}) so the seat-offer publish can ` +
            'disambiguate which one to advertise the seat in; without it the seat ' +
            'would be delegated locally but never discoverable pot-wide',
        },
      };
    }
  }

  const invalidate = async () => {
    if (opts?.skipInvalidate) return;
    try {
      // The /res board reads `p2p.allotments` with NO args → name-only invalidate
      // (an args-scoped emit would never match — the adding-a-sync-query gotcha).
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('p2p.allotments');
    } catch {
      /* best-effort — the board self-heals on next read */
    }
  };

  // D-005 (P-007): an agent_slot delegation federates as a standing SEAT-OFFER
  // (p2p/offer-store-publish.ts) so the fleet owner's operator sees this
  // machine's seats — set → open/paused, remove → cancelled. Best-effort +
  // fire-and-forget: the LOCAL allotment write never waits on (or fails with)
  // the offer leg. Skipped under a test-schema override (unit tests must not
  // publish; both production callers — the MCP tool and the /res loopback —
  // pass no override).
  const publishSeatOffer = (args: { removed: boolean; count: number; paused: boolean }) => {
    if (!isSlot || opts?.sqlOverride) return;
    // A remove-by-ref caller may omit the trio — recover it from the row key
    // (`model:effort:account`; no part contains a colon by construction).
    let [m, e, a] = [model, effort, account];
    if (!m || !e) {
      const parts = resourceRef.split(':');
      m = m || parts[0] || '';
      e = e || parts[1] || '';
      a = parts[2] || a || AUTO_ACCOUNT;
    }
    if (!m || !e) return; // nothing derivable — never publish a junk trio
    void trackDetached(import('../../p2p/offer-store-publish'))
      .then((mod) =>
        mod.publishSeatOfferForDelegationBestEffort({
          workspaceId: input.workspaceId,
          fleetSlug: input.fleetSlug,
          potSlug: input.potSlug,
          audience: input.audience,
          model: m,
          effort: e,
          account: a,
          count: args.count,
          paused: args.paused,
          removed: args.removed,
          ...(input.hive ? { hiveOverride: input.hive } : {}),
        }),
      )
      // EI-19304844689981989: this used to be `.catch(() => {})`. It only ever
      // catches a failure to LOAD the publish module, but that swallow was the
      // second of two, so a seat could fail to federate with no signal at all.
      // Still non-fatal to the local allotment write — just no longer silent.
      .catch((e: unknown) => {
        console.warn(`[resource:delegate] seat-offer publish leg unavailable: ${String(e)}`);
      });
  };

  if (input.remove) {
    const removed = await removeResourceAllotment(
      {
        workspaceId: input.workspaceId,
        fleetSlug: input.fleetSlug,
        potSlug: input.potSlug,
        resourceKind: input.kind,
        resourceRef,
      },
      opts?.sqlOverride,
    );
    await invalidate();
    // Cancel the federated seat-offer even when 0 rows matched locally — a
    // stray offer with no backing allotment must not keep advertising seats
    // (the publish leg no-ops when no offer exists).
    publishSeatOffer({ removed: true, count: 1, paused: false });
    return { ok: true, action: 'remove', removed: removed.removed };
  }

  const storeArgs: StoreSetArgs = {
    workspaceId: input.workspaceId,
    fleetSlug: input.fleetSlug,
    potSlug: input.potSlug,
    audience: input.audience,
    resourceKind: input.kind,
    resourceRef,
    // account/gpu: absent → NaN → the store's invalid_share_pct refusal (store-owned).
    // agent_slot: sharePct is ignored by the store (stored as 0 — slots cap by count).
    sharePct: isSlot ? 0 : typeof input.sharePct === 'number' ? input.sharePct : Number.NaN,
    axis: isSlot ? { ...axisIn, model, effort, account } : input.axis,
    status: input.status,
    createdByGithubUserId: input.createdByGithubUserId ?? null,
  };
  if (isSlot) storeArgs.quantity = input.count;

  const result = await setResourceAllotment(storeArgs, opts?.sqlOverride);
  if (!result.ok) return { ok: false, refusal: result.refusal };
  await invalidate();
  publishSeatOffer({
    removed: false,
    count: result.allotment.quantity ?? input.count ?? 1,
    paused: result.allotment.status === 'paused',
  });
  return { ok: true, action: 'set', allotment: result.allotment };
}

export default defineTool({
  name: 'resource:delegate',
  profile: 'engineer',
  description:
    "Delegate this host's resources to a fleet OR a whole pot (D-004/P-001): kind 'account'|'gpu' (share-% cap) or 'agent_slot' (N × model·effort seats on a gateway account; account 'AUTO' draws from the fleet's allocated accounts). Exactly one of fleetSlug/potSlug names the grantee; potSlug requires audience ('trusted-members'|'whole-pot', no silent default). Re-delegating the same grantee+kind+ref UPDATES the cap; remove:true revokes. Allotments are LOCAL to this machine (M19); an agent_slot delegation also auto-publishes a standing seat-offer over P2P (fleet owner or the pot's hive topic, audience-gated) — best-effort, account id stays local. Returns {ok, action, allotment|removed} or a typed refusal.",
  guidance: {
    when:
      "Handing fleet capacity: 'assign 5 xhigh opus seats to fleet X' → resource:delegate { fleetSlug:'x', kind:'agent_slot', model:'opus', effort:'xhigh', count:5 } (account omitted = AUTO). 'offer N seats to pot P, trusted members only' → { potSlug:'p', audience:'trusted-members', kind:'agent_slot', model, effort, count }. Account/GPU pools take sharePct instead of count. Also the revoke path (remove:true).",
    notWhen:
      'READING current allotments (the /res board or p2p.allotments query). Spawning agents that CONSUME seats (fleet:launch-on-plan). Registering/editing gateway accounts (accounts:*).',
    chaining:
      "fleet:create/join → resource:delegate { kind:'agent_slot', model, effort, count } → launch-from-seats consumes them (P-005). Delegate account pools FIRST if slots use 'AUTO' (D-003).",
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleetSlug: z.string().min(1).optional().describe('the fleet receiving the delegation — exactly one of fleetSlug/potSlug required'),
    potSlug: z.string().min(1).optional().describe('P-001: the whole POT receiving the delegation instead of one fleet — exactly one of fleetSlug/potSlug required; requires `audience`'),
    audience: z
      .enum(ALLOTMENT_AUDIENCES as unknown as [AllotmentAudience, ...AllotmentAudience[]])
      .optional()
      .describe("P-001/D-002: required iff potSlug is set (who in the pot may draw on it); refused alongside fleetSlug"),
    kind: z
      .enum(['account', 'gpu', 'agent_slot'])
      .describe("account|gpu = %-capped capacity; agent_slot = count-capped seats (D-002)"),
    ref: z
      .string()
      .min(1)
      .optional()
      .describe("account/gpu: the pool/GPU id (required). agent_slot: ignored — derived as 'model:effort:account'"),
    sharePct: z.number().min(0).max(100).optional().describe('account/gpu share cap 0–100'),
    count: z.number().int().min(1).optional().describe('agent_slot: number of seats (store caps at 1000)'),
    model: z.string().min(1).optional().describe('agent_slot: the model the seats run'),
    effort: z.string().min(1).optional().describe('agent_slot: reasoning effort (low|medium|high|xhigh|max — store-validated)'),
    account: z
      .string()
      .min(1)
      .optional()
      .describe("agent_slot: gateway account the seats bill to; omit for 'AUTO' (gateway picks from the fleet's pool)"),
    status: z.enum(['active', 'paused']).optional().describe("pause a delegation without removing it (default 'active')"),
    remove: z.boolean().optional().describe("revoke the delegation for (fleet, kind, ref) instead of setting it"),
    hive: z
      .string()
      .min(1)
      .optional()
      .describe(
        'agent_slot: shared-hive home slug to advertise the seat in — REQUIRED (loud `hive_required` refusal otherwise) when THIS workspace has >1 shared hive and potSlug is not set, since the cross-machine seat-offer publish can\'t disambiguate which hive to advertise into. Ignored on a single-hive workspace or a potSlug-scoped delegation.',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);

    // Best-effort actor resolution (X9: display/audit only; the resource is this machine's).
    let createdByGithubUserId: number | null = null;
    try {
      const { resolveUsageActor } = await import('../../harness/usage-actor');
      createdByGithubUserId = (await resolveUsageActor().catch(() => null))?.githubUserId ?? null;
    } catch {
      /* audit-only field — never block the write */
    }

    const result = await delegateResource({
      workspaceId: ident.workspaceId,
      fleetSlug: args.fleetSlug,
      potSlug: args.potSlug,
      audience: args.audience,
      kind: args.kind,
      ref: args.ref,
      sharePct: args.sharePct,
      count: args.count,
      model: args.model,
      effort: args.effort,
      account: args.account,
      status: args.status,
      remove: args.remove,
      hive: args.hive,
      createdByGithubUserId,
    });

    // Canonical ToolResponse shape — the framework owns wire encoding (the
    // tool-data-shape ratchet: never hand-roll content:[{ text: JSON.stringify }]).
    if (!result.ok) {
      return { data: { ok: false, error: result.refusal.code, detail: result.refusal.detail } };
    }
    return {
      data:
        result.action === 'remove'
          ? { ok: true, action: 'remove', removed: result.removed }
          : { ok: true, action: 'set', allotment: result.allotment },
    };
  },
});
