/**
 * resource-allotments.ts — P-201 two-axis allotment store (p2p-work-distribution).
 *
 * The persistence behind the /res Resources board: a host hands its account
 * pools (remote axis) + local GPUs (local axis) to the fleets in its hive tree,
 * each with a share cap. Backed by harness_shared.resource_allotments (mig 473).
 *
 * LOCAL, per-machine (M19) — no federation: the resource is THIS machine's, so
 * unlike grant-store.ts there is no hive-slug / epoch / CDC machinery. Keyed by
 * (workspace, fleet, resource_kind, resource_ref). M11: a row's EXISTENCE is the
 * opt-in (default zero); share_pct is the cap. Caps not reservations (D-008) —
 * contention resolves at claim time (P-202), not here.
 *
 * Mirrors the grant-store PG access pattern: getOrgPg().sql + a shared
 * writer/reader workspace resolver (the WI-1564 one-helper invariant).
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { MODEL_EFFORT_LEVELS, type ModelEffort } from '../agent-config-constants';
import type { OrgSql } from '../work-items';

/**
 * 'account' + 'gpu' are the P-201 two-axis capacity kinds (share-capped).
 * 'agent_slot' (agent-allocation-framework-2026-07-03 D-002) is delegated
 * AGENT SEATS — count-capped via `quantity`, mig 486. Budget/claim math
 * (axisForResourceKind) deliberately excludes agent_slot: a seat is launch
 * capacity, not a spend axis.
 */
export type ResourceKind = 'account' | 'gpu' | 'agent_slot';
export type AllotmentStatus = 'active' | 'paused';

/**
 * pot-seat-pools-prose-ux-2026-07-18 D-002: who within a POT-scoped allotment's
 * pot may draw on it. 'trusted-members' = this host's local trust list
 * (checked at claim); 'whole-pot' = deliberate wider opt-in. Never set for a
 * fleet-scoped row (grantee is a single named fleet, no audience narrowing).
 */
export type AllotmentAudience = 'trusted-members' | 'whole-pot';
export const ALLOTMENT_AUDIENCES: readonly AllotmentAudience[] = ['trusted-members', 'whole-pot'];

function isAllotmentAudience(v: unknown): v is AllotmentAudience {
  return v === 'trusted-members' || v === 'whole-pot';
}

/** D-002 seat-count bounds: quantity must be an integer in [1, this]. */
export const AGENT_SLOT_MAX_QUANTITY = 1000;

/**
 * The structured trio an agent_slot's `axis` carries (D-002/D-003). `account`
 * is the inference-GATEWAY selection — 'AUTO' (draw from the fleet's allocated
 * accounts) or a pool id — never a raw credential.
 */
export interface AgentSlotAxis {
  model: string;
  effort: ModelEffort;
  account: string;
}

/**
 * The DERIVED resource_ref for an agent_slot row: the slot template
 * '<model>:<effort>:<account>' (e.g. 'opus:xhigh:AUTO'). The store always
 * derives it from the validated axis trio so ref↔axis can never disagree —
 * a caller-supplied resourceRef is ignored for agent_slot.
 */
export function agentSlotRef(axis: Pick<AgentSlotAxis, 'model' | 'effort' | 'account'>): string {
  return `${axis.model}:${axis.effort}:${axis.account}`;
}

export interface ResourceAllotment {
  workspaceId: string;
  /** The grantee — exactly one of fleetSlug/potSlug is non-null (P-001). */
  fleetSlug: string | null;
  /** Pot-scoped grantee (P-001): the shared-hive/pot slug this allotment targets. */
  potSlug: string | null;
  /** Required iff potSlug is set (D-002); null for a fleet-scoped row. */
  audience: AllotmentAudience | null;
  resourceKind: ResourceKind;
  resourceRef: string;
  /** Share cap as a percent (0–100). Remote axis: % of pool budget; local axis: % of GPU time/slots. Stored 0 for agent_slot (count-capped). */
  sharePct: number;
  /** Seat COUNT cap (D-002) — set (1..AGENT_SLOT_MAX_QUANTITY) for agent_slot rows, null for the share-capped kinds. */
  quantity: number | null;
  /** P-201 forward seam: { dollarCapUsd, modelClassWeights, windows, allowedModels, preemptClass, slots }. For agent_slot: the { model, effort, account } trio (AgentSlotAxis). */
  axis: Record<string, unknown>;
  status: AllotmentStatus;
  createdByGithubUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type AllotmentWriteResult =
  | { ok: true; allotment: ResourceAllotment }
  | { ok: false; refusal: { code: string; detail: string } };

/**
 * Resolve the workspace partition a write/read uses from the caller's resolved
 * identity workspace — the same one-helper-shared-by-writer-and-reader invariant
 * as resolveP2pGrantWorkspace. `undefined` = unresolvable (null / '*' / empty /
 * the legacy 'default' partition), which callers must refuse rather than strand.
 */
export function resolveAllotmentWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identWorkspaceId?.trim();
  return ws && ws !== '*' && ws !== DEFAULT_COORD_WORKSPACE ? ws : undefined;
}

function isResourceKind(v: unknown): v is ResourceKind {
  return v === 'account' || v === 'gpu' || v === 'agent_slot';
}

function isModelEffort(v: unknown): v is ModelEffort {
  return typeof v === 'string' && (MODEL_EFFORT_LEVELS as readonly string[]).includes(v);
}

interface AllotmentRow {
  workspace_id: string;
  fleet_slug: string | null;
  pot_slug: string | null;
  audience: string | null;
  resource_kind: string;
  resource_ref: string;
  share_pct: number;
  quantity: number | string | null;
  axis: Record<string, unknown> | null;
  status: string;
  created_by_github_user_id: string | number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToAllotment(r: AllotmentRow): ResourceAllotment {
  return {
    workspaceId: r.workspace_id,
    fleetSlug: r.fleet_slug,
    potSlug: r.pot_slug,
    audience: isAllotmentAudience(r.audience) ? r.audience : null,
    resourceKind: r.resource_kind as ResourceKind,
    resourceRef: r.resource_ref,
    sharePct: Number(r.share_pct),
    quantity: r.quantity == null ? null : Number(r.quantity),
    axis: r.axis ?? {},
    status: r.status as AllotmentStatus,
    createdByGithubUserId:
      r.created_by_github_user_id == null ? null : Number(r.created_by_github_user_id),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export interface ListAllotmentsArgs {
  /** The caller's RESOLVED identity workspace. */
  workspaceId: string | null | undefined;
  /** Restrict to one fleet (the P-202 claim-authority read). Omit for the whole board. */
  fleetSlug?: string;
  /** Restrict to one pot-scoped grantee (P-001). Omit for the whole board. */
  potSlug?: string;
  /** Include paused rows (default false — the board shows active contributions). */
  includePaused?: boolean;
}

/** Read allotments for the /res board (whole workspace), one fleet, or one pot (claim authority). */
export async function listResourceAllotments(
  args: ListAllotmentsArgs,
  sqlOverride?: OrgSql,
): Promise<ResourceAllotment[]> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) return [];
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT * FROM harness_shared.resource_allotments
     WHERE workspace_id = ${ws}
       ${args.fleetSlug ? sql`AND fleet_slug = ${args.fleetSlug}` : sql``}
       ${args.potSlug ? sql`AND pot_slug = ${args.potSlug}` : sql``}
       ${args.includePaused ? sql`` : sql`AND status = 'active'`}
     ORDER BY fleet_slug, pot_slug, resource_kind, resource_ref
  `) as unknown as AllotmentRow[];
  return rows.map(rowToAllotment);
}

export interface SetAllotmentArgs {
  workspaceId: string | null | undefined;
  /** The grantee — exactly one of fleetSlug/potSlug required (P-001). */
  fleetSlug?: string;
  /** Pot-scoped grantee (P-001): hand this resource to a whole pot (audience-
   *  gated) instead of one named fleet. Mutually exclusive with fleetSlug. */
  potSlug?: string;
  /** Required iff potSlug is set (D-002 — no silent default); refused if set
   *  alongside fleetSlug (audience is a pot-scoped concept only). */
  audience?: AllotmentAudience;
  resourceKind: ResourceKind | string;
  /** Resource identity for account/gpu (required there). IGNORED for agent_slot — the ref is DERIVED from the axis trio (agentSlotRef). */
  resourceRef?: string;
  /** Share cap 0–100 — required for account/gpu; ignored for agent_slot (stored 0, count-capped instead). */
  sharePct?: number;
  /** Seat COUNT cap — required for agent_slot (integer 1..AGENT_SLOT_MAX_QUANTITY); must be absent for account/gpu (stored NULL). */
  quantity?: number | null;
  /** For agent_slot: MUST carry the { model, effort, account } trio (D-002); extra seam fields pass through. */
  axis?: Record<string, unknown>;
  status?: AllotmentStatus;
  /** The setting host's numeric GitHub id (display/audit). */
  createdByGithubUserId?: number | null;
}

/**
 * Validate an agent_slot write's axis trio + quantity (D-002/D-003). Returns a
 * structured refusal, or the normalized trio + derived ref on success. All
 * checks are pre-SQL, mirroring the store's loud-refusal discipline.
 */
function validateAgentSlot(args: SetAllotmentArgs):
  | { ok: true; axis: AgentSlotAxis; ref: string; quantity: number }
  | { ok: false; refusal: { code: string; detail: string } } {
  const axis = args.axis ?? {};
  const model = typeof axis.model === 'string' ? axis.model.trim() : '';
  if (!model || model.includes(':')) {
    return {
      ok: false,
      refusal: {
        code: 'invalid_model',
        detail: `agent_slot requires axis.model (non-empty, no ':' — colons are the slot-ref separators); got ${JSON.stringify(axis.model ?? null)}.`,
      },
    };
  }
  if (!isModelEffort(axis.effort)) {
    return {
      ok: false,
      refusal: {
        code: 'invalid_effort',
        detail: `agent_slot requires axis.effort ∈ ${MODEL_EFFORT_LEVELS.join('|')}; got ${JSON.stringify(axis.effort ?? null)}.`,
      },
    };
  }
  const account = typeof axis.account === 'string' ? axis.account.trim() : '';
  if (!account || account.includes(':')) {
    return {
      ok: false,
      refusal: {
        code: 'invalid_account',
        detail: `agent_slot requires axis.account (a gateway account/pool id or 'AUTO'; non-empty, no ':'); got ${JSON.stringify(axis.account ?? null)}.`,
      },
    };
  }
  if (args.quantity == null) {
    return {
      ok: false,
      refusal: {
        code: 'quantity_required',
        detail: 'agent_slot allotments are COUNT-capped (D-002): quantity is required.',
      },
    };
  }
  if (
    !Number.isInteger(args.quantity) ||
    args.quantity < 1 ||
    args.quantity > AGENT_SLOT_MAX_QUANTITY
  ) {
    return {
      ok: false,
      refusal: {
        code: 'quantity_out_of_range',
        detail: `quantity must be an integer 1..${AGENT_SLOT_MAX_QUANTITY} (got ${String(args.quantity)}).`,
      },
    };
  }
  const trio: AgentSlotAxis = { model, effort: axis.effort, account };
  return { ok: true, axis: trio, ref: agentSlotRef(trio), quantity: args.quantity };
}

/** Upsert an allotment (one per (fleet, resource) on this machine). Re-allocating is an UPSERT of the cap. */
export async function setResourceAllotment(
  args: SetAllotmentArgs,
  sqlOverride?: OrgSql,
): Promise<AllotmentWriteResult> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail: `Allotment write refused: unresolvable workspace partition (got ${JSON.stringify(args.workspaceId ?? null)}).`,
      },
    };
  }
  if (!isResourceKind(args.resourceKind)) {
    return { ok: false, refusal: { code: 'invalid_resource_kind', detail: `resource_kind must be account|gpu|agent_slot (got '${String(args.resourceKind)}').` } };
  }
  // P-001 grantee: exactly one of fleetSlug/potSlug. Audience is required iff
  // potSlug is set (D-002 — no silent default at the tool boundary) and
  // refused if paired with fleetSlug (audience is a pot-scoped concept only).
  const fleetSlug = args.fleetSlug?.trim() || undefined;
  const potSlug = args.potSlug?.trim() || undefined;
  if (!fleetSlug && !potSlug) {
    return {
      ok: false,
      refusal: { code: 'grantee_required', detail: 'exactly one of fleetSlug/potSlug is required.' },
    };
  }
  if (fleetSlug && potSlug) {
    return {
      ok: false,
      refusal: { code: 'grantee_conflict', detail: 'fleetSlug and potSlug are mutually exclusive — exactly one names the grantee.' },
    };
  }
  if (potSlug && !isAllotmentAudience(args.audience)) {
    return {
      ok: false,
      refusal: {
        code: 'audience_required',
        detail: `a pot-scoped allotment requires audience ∈ ${ALLOTMENT_AUDIENCES.join('|')} (D-002 — no silent default); got ${JSON.stringify(args.audience ?? null)}.`,
      },
    };
  }
  if (fleetSlug && args.audience != null) {
    return {
      ok: false,
      refusal: { code: 'audience_not_applicable', detail: 'audience only applies to a pot-scoped (potSlug) allotment, not a fleet-scoped one.' },
    };
  }
  const audience: AllotmentAudience | null = potSlug ? (args.audience as AllotmentAudience) : null;
  // Per-kind cap discipline (D-002): account/gpu are share-capped (0–100 %),
  // agent_slot is count-capped (quantity 1..AGENT_SLOT_MAX_QUANTITY) with the
  // ref DERIVED from the validated axis trio.
  let resourceRef: string;
  let sharePct: number;
  let quantity: number | null;
  let axis: Record<string, unknown>;
  if (args.resourceKind === 'agent_slot') {
    const slot = validateAgentSlot(args);
    if (!slot.ok) return { ok: false, refusal: slot.refusal };
    resourceRef = slot.ref;
    sharePct = 0;
    quantity = slot.quantity;
    // The validated trio wins over any caller-passed axis fields; extra
    // forward-seam fields pass through untouched.
    axis = { ...(args.axis ?? {}), ...slot.axis };
  } else {
    if (!args.resourceRef?.trim()) {
      return { ok: false, refusal: { code: 'resource_required', detail: 'resourceRef is required.' } };
    }
    if (
      typeof args.sharePct !== 'number' ||
      !Number.isFinite(args.sharePct) ||
      args.sharePct < 0 ||
      args.sharePct > 100
    ) {
      return { ok: false, refusal: { code: 'invalid_share_pct', detail: `sharePct must be 0–100 (got ${String(args.sharePct)}).` } };
    }
    resourceRef = args.resourceRef;
    sharePct = Math.round(args.sharePct);
    quantity = null; // share-capped kinds carry no count (DB CHECK resource_allotments_quantity)
    axis = args.axis ?? {};
  }
  const sql = sqlOverride ?? getOrgPg().sql;
  const status: AllotmentStatus = args.status ?? 'active';
  // jsonb bind: getOrgPg's pooled sql THROWS on sql.json() (prepare:false mis-binds it —
  // see agent-governor-pg-store.ts / the usage-events integration test). Bind the axis
  // object as `${JSON.stringify(x)}::jsonb` instead. Do NOT "fix" this back to sql.json().
  // The ON CONFLICT target differs per grantee kind (two partial unique indexes,
  // mig 626 — a compound PK can't have a nullable column) so the insert branches.
  //
  // Two independent `if`/`else` statements (NOT one ternary expression) deliberately:
  // a ternary sharing one expression context makes TS unify both `sql\`...\`` tagged-
  // template calls' overload resolution, and the second branch's optional (`| undefined`)
  // grantee then fails against the type already pinned by the first branch (TS2769
  // "No overload matches this call" / parameter type resolved to `never`). Splitting
  // into separate statements gives each call its own independent overload resolution.
  let rows: AllotmentRow[];
  if (potSlug) {
    rows = (await sql`
      INSERT INTO harness_shared.resource_allotments
        (workspace_id, pot_slug, audience, resource_kind, resource_ref, share_pct, quantity, axis, status, created_by_github_user_id)
      VALUES
        (${ws}, ${potSlug}, ${audience}, ${args.resourceKind}, ${resourceRef}, ${sharePct}, ${quantity},
         ${JSON.stringify(axis)}::text::jsonb, ${status}, ${args.createdByGithubUserId ?? null})
      ON CONFLICT (workspace_id, pot_slug, resource_kind, resource_ref) WHERE pot_slug IS NOT NULL
      DO UPDATE SET share_pct = EXCLUDED.share_pct,
                    quantity = EXCLUDED.quantity,
                    axis = EXCLUDED.axis,
                    status = EXCLUDED.status,
                    audience = EXCLUDED.audience,
                    updated_at = now()
      RETURNING *
    `) as unknown as AllotmentRow[];
  } else {
    // fleetSlug is guaranteed non-empty here: the grantee_required/grantee_conflict
    // checks above already enforce exactly one of fleetSlug/potSlug is set.
    const fleetSlugSafe = fleetSlug as string;
    rows = (await sql`
      INSERT INTO harness_shared.resource_allotments
        (workspace_id, fleet_slug, resource_kind, resource_ref, share_pct, quantity, axis, status, created_by_github_user_id)
      VALUES
        (${ws}, ${fleetSlugSafe}, ${args.resourceKind}, ${resourceRef}, ${sharePct}, ${quantity},
         ${JSON.stringify(axis)}::text::jsonb, ${status}, ${args.createdByGithubUserId ?? null})
      ON CONFLICT (workspace_id, fleet_slug, resource_kind, resource_ref) WHERE fleet_slug IS NOT NULL
      DO UPDATE SET share_pct = EXCLUDED.share_pct,
                    quantity = EXCLUDED.quantity,
                    axis = EXCLUDED.axis,
                    status = EXCLUDED.status,
                    updated_at = now()
      RETURNING *
    `) as unknown as AllotmentRow[];
  }
  return { ok: true, allotment: rowToAllotment(rows[0]) };
}

export interface RemoveAllotmentArgs {
  workspaceId: string | null | undefined;
  /** Exactly one of fleetSlug/potSlug identifies the row to remove (P-001);
   *  mirrors the set-form grantee. Neither validated loudly here (matches the
   *  pre-P-001 remove behavior: an unmatched grantee is just `removed: 0`). */
  fleetSlug?: string;
  potSlug?: string;
  resourceKind: ResourceKind | string;
  resourceRef: string;
}

/** Remove an allotment (the /res chip's × — revokes the fleet's or pot's draw on this resource). Returns rows removed. */
export async function removeResourceAllotment(
  args: RemoveAllotmentArgs,
  sqlOverride?: OrgSql,
): Promise<{ ok: true; removed: number }> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) return { ok: true, removed: 0 };
  const sql = sqlOverride ?? getOrgPg().sql;
  const potSlug = args.potSlug?.trim() || undefined;
  const rows = (await sql`
    DELETE FROM harness_shared.resource_allotments
     WHERE workspace_id = ${ws}
       AND ${potSlug ? sql`pot_slug = ${potSlug}` : sql`fleet_slug = ${args.fleetSlug ?? ''}`}
       AND resource_kind = ${args.resourceKind}
       AND resource_ref = ${args.resourceRef}
    RETURNING fleet_slug
  `) as unknown as { fleet_slug: string }[];
  return { ok: true, removed: rows.length };
}
