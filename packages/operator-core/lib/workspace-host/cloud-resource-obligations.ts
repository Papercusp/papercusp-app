/**
 * cloud-resource-obligations.ts — the durable per-resource teardown obligation ledger
 * (closes EI-21915296593490861).
 *
 * WHY THIS EXISTS
 * ----------------
 * P-046 agents repeatedly create real, metered GCP infra (custom networks, subnets,
 * Cloud Routers, Cloud NATs) because the project default network has no NAT and a
 * clean-room/Packer guest cannot reach the internet without one. Until now the
 * teardown obligation was recorded ONLY as prose in a work-item checkpoint ("Tear down
 * after the release run", "TEARDOWN OWED — this is a standing GCP cost"). Nothing
 * enforced or detected it, and prose does not survive the creating agent's death:
 * WI-40474 measured three successive holders dying/stalling in sequence while the
 * obligation sat undischarged in checkpoint text across every handoff (~18h and
 * counting at filing time).
 *
 * This module makes the obligation a ROW in harness_shared.cloud_resource_obligations
 * (migration 1040), not a paragraph — written at (or shortly after) the moment the
 * resource is created, keyed to the resource identity itself. Detection then no longer
 * depends on any one agent's session surviving to hand off the prose: `recordEscalation`
 * and `selectCloudResourceObligationsToEscalate` are consumed by a scheduled DBOS
 * workflow (`cloudResourceObligationSweep` in periodic-workflows.ts) that runs on its
 * own cadence, independent of every agent's liveness.
 *
 * SCOPE: this module tracks and ESCALATES stale obligations. It does not itself call any
 * cloud provider API to enumerate or delete resources — the filing agent (and this
 * module's own author) hit the same gap: `compute.routers.list` is denied to the only
 * working credential available in-session. Actual teardown remains a human/infra-owner
 * action taken against the escalation work-item this sweep files. What this closes is
 * the detector gap the issue names as "the second bug": a network-tier resource created
 * outside the typed `gcp-safety.ts` provisioning/destroy workflow (see that file's
 * `censusGcpWorkspaceHostResources`, which already covers router/nat/network/subnetwork
 * kinds but is only ever invoked as a step WITHIN a create/destroy call — never on an
 * owner-independent schedule) previously had no durable record and no sweep at all.
 *
 * Server-only.
 */
import type postgres from 'postgres';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { DEFAULT_WORKSPACE_HOST_SOAK_POLICY } from './soak';

export const CLOUD_RESOURCE_OBLIGATION_VERSION = 'cloud-resource-obligations-v1';

/** Default grace before a fresh obligation becomes escalation-eligible: one working day. */
export const CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS = 21_600_000; // 6h, matches migration default

/** Minimum time between successive escalations of the SAME obligation (avoid re-filing every tick). */
export const CLOUD_RESOURCE_OBLIGATION_DEFAULT_ESCALATION_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Hard ceiling on IN-USE suppression, measured from the obligation's own creation.
 *
 * An obligation whose originating work-item is still non-terminal is not a leak — the
 * resource is still being used by live work (see `openSourceWorkItemKeys` below). But an
 * open work-item must never become a permanent cloaking device: a stalled or abandoned
 * holder would otherwise hide a genuinely leaked, metered resource forever. Past this
 * ceiling the obligation escalates anyway, with the still-open source named in the body
 * so the reader knows the suppression was overridden rather than never applied.
 */
export const CLOUD_RESOURCE_OBLIGATION_IN_USE_SUPPRESSION_CEILING_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/**
 * A healthy running-host attestation is considered current for the soak sampler's
 * maximum allowed gap. After three missed five-minute samples, fail toward escalation.
 */
export const CLOUD_RESOURCE_ACTIVE_HOST_HEALTH_FRESHNESS_MS =
  DEFAULT_WORKSPACE_HOST_SOAK_POLICY.intervalMs * DEFAULT_WORKSPACE_HOST_SOAK_POLICY.maxGapIntervals;

/**
 * Key for the "is this obligation's originating work-item still open?" lookup.
 *
 * Composite on (workspaceId, sourceWorkItemId) rather than the bare work-item id: the
 * sweep is workspace-independent and reads every open obligation across the install, so
 * a bare id could match a same-named row in a different tenant and suppress a real leak.
 * Encoded with JSON.stringify so no separator character has to be assumed illegal in
 * either identifier.
 */
export function cloudResourceObligationSourceKey(workspaceId: string, sourceWorkItemId: string): string {
  return JSON.stringify([workspaceId, sourceWorkItemId]);
}

/** Workspace-host ids are tenant-local, so in-use keys include the workspace. */
export function cloudResourceObligationHostKey(workspaceId: string, hostId: string): string {
  return JSON.stringify([workspaceId, hostId]);
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

export interface CloudResourceObligationRow {
  id: number;
  workspaceId: string;
  provider: string;
  resourceKind: string;
  resourceId: string;
  incarnationId?: string;
  projectId: string;
  /**
   * Location (migration 1168) — what makes a row ADDRESSABLE, not merely named. GCP deletes
   * are addressed: a zonal kind without `zone`, or a regional kind without `region`, cannot
   * have a delete call constructed for it at all. See {@link CLOUD_RESOURCE_DELETE_CONTRACT}.
   */
  zone: string;
  region: string;
  /** The enclosing resource a kind is addressed THROUGH — for `nat`, its owning Cloud Router. */
  parentResourceId: string;
  hostId: string;
  purpose: string;
  createdByOwnerId: string;
  sourceWorkItemId: string;
  createdAtMs: number;
  graceMs: number;
  teardownOwed: boolean;
  closedAtMs: number | null;
  closedReason: string;
  lastEscalatedAtMs: number | null;
  escalationWorkItemId: string;
  updatedAtMs: number;
}

export interface CloudResourceObligationRecordInput {
  workspaceId: string;
  /** Only 'gcp' is accepted today; the column CHECK constraint enforces this too. */
  provider: 'gcp';
  resourceKind: string;
  resourceId: string;
  /** Immutable provider allocation identity; required for GCP VMs, whose names are reusable. */
  incarnationId?: string;
  projectId?: string;
  /** Zonal kinds (vm, disk) MUST supply this or the row is born unreclaimable. */
  zone?: string;
  /** Regional kinds (subnetwork, router, nat) MUST supply this or the row is born unreclaimable. */
  region?: string;
  /** For `nat`: the owning Cloud Router name that `delete-nat` addresses it through. */
  parentResourceId?: string;
  hostId?: string;
  purpose?: string;
  createdByOwnerId?: string;
  sourceWorkItemId?: string;
  graceMs?: number;
}

/** Row → typed shape. postgres.js returns bigint/timestamptz columns as string | Date; normalize both. */
function toRow(raw: Record<string, unknown>): CloudResourceObligationRow {
  const toMs = (value: unknown): number => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') return Date.parse(value);
    throw new Error(`cloud resource obligation: unexpected timestamp shape ${typeof value}`);
  };
  const toMsOrNull = (value: unknown): number | null => (value == null ? null : toMs(value));
  return {
    id: Number(raw.id),
    workspaceId: String(raw.workspace_id),
    provider: String(raw.provider),
    resourceKind: String(raw.resource_kind),
    resourceId: String(raw.resource_id),
    incarnationId: String(raw.incarnation_id ?? ''),
    projectId: String(raw.project_id ?? ''),
    zone: String(raw.zone ?? ''),
    region: String(raw.region ?? ''),
    parentResourceId: String(raw.parent_resource_id ?? ''),
    hostId: String(raw.host_id ?? ''),
    purpose: String(raw.purpose ?? ''),
    createdByOwnerId: String(raw.created_by_owner_id ?? ''),
    sourceWorkItemId: String(raw.source_work_item_id ?? ''),
    createdAtMs: toMs(raw.created_at),
    graceMs: Number(raw.grace_ms),
    teardownOwed: Boolean(raw.teardown_owed),
    closedAtMs: toMsOrNull(raw.closed_at),
    closedReason: String(raw.closed_reason ?? ''),
    lastEscalatedAtMs: toMsOrNull(raw.last_escalated_at),
    escalationWorkItemId: String(raw.escalation_work_item_id ?? ''),
    updatedAtMs: toMs(raw.updated_at),
  };
}

/**
 * Write the obligation at (or immediately after) resource-creation time. Idempotent on
 * (workspaceId, provider, resourceKind, resourceId, incarnationId): a re-call for the same
 * provider allocation is a no-op (`created: false`), while a different incarnation reopens
 * the same address's obligation and replaces its close state.
 */
export async function recordCloudResourceObligation(
  sql: postgres.Sql,
  input: CloudResourceObligationRecordInput,
): Promise<{ id: number; created: boolean }> {
  requireNonEmpty(input.workspaceId, 'workspaceId');
  requireNonEmpty(input.resourceKind, 'resourceKind');
  requireNonEmpty(input.resourceId, 'resourceId');
  const incarnationId = input.incarnationId?.trim() ?? '';
  if (input.resourceKind === 'vm') requireNonEmpty(incarnationId, 'incarnationId');
  const graceMs = input.graceMs ?? CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error('graceMs must be a non-negative safe integer');
  const rows = await sql<{ id: number; inserted: boolean }[]>`
    INSERT INTO harness_shared.cloud_resource_obligations
      (workspace_id, provider, resource_kind, resource_id, incarnation_id, project_id, zone, region,
       parent_resource_id, host_id, purpose, created_by_owner_id, source_work_item_id, grace_ms)
    VALUES
      (${input.workspaceId}, ${input.provider}, ${input.resourceKind}, ${input.resourceId}, ${incarnationId},
       ${input.projectId ?? ''}, ${input.zone ?? ''}, ${input.region ?? ''},
       ${input.parentResourceId ?? ''}, ${input.hostId ?? ''},
       ${input.purpose ?? ''}, ${input.createdByOwnerId ?? ''},
       ${input.sourceWorkItemId ?? ''}, ${graceMs})
    ON CONFLICT (workspace_id, provider, resource_kind, resource_id) DO UPDATE
       SET incarnation_id = EXCLUDED.incarnation_id,
           project_id = EXCLUDED.project_id,
           zone = EXCLUDED.zone,
           region = EXCLUDED.region,
           parent_resource_id = EXCLUDED.parent_resource_id,
           host_id = EXCLUDED.host_id,
           purpose = EXCLUDED.purpose,
           created_by_owner_id = EXCLUDED.created_by_owner_id,
           source_work_item_id = EXCLUDED.source_work_item_id,
           created_at = CASE
             WHEN cloud_resource_obligations.incarnation_id = ''
              AND cloud_resource_obligations.closed_at IS NULL
             THEN cloud_resource_obligations.created_at
             ELSE now()
           END,
           grace_ms = EXCLUDED.grace_ms,
           teardown_owed = true,
           closed_at = NULL,
           closed_reason = '',
           last_escalated_at = CASE
             WHEN cloud_resource_obligations.incarnation_id = ''
              AND cloud_resource_obligations.closed_at IS NULL
             THEN cloud_resource_obligations.last_escalated_at
             ELSE NULL
           END,
           escalation_work_item_id = CASE
             WHEN cloud_resource_obligations.incarnation_id = ''
              AND cloud_resource_obligations.closed_at IS NULL
             THEN cloud_resource_obligations.escalation_work_item_id
             ELSE ''
           END,
           updated_at = now()
     WHERE cloud_resource_obligations.incarnation_id IS DISTINCT FROM EXCLUDED.incarnation_id
    RETURNING id, true AS inserted
  `;
  if (rows.length > 0) return { id: Number(rows[0]!.id), created: true };
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM harness_shared.cloud_resource_obligations
     WHERE workspace_id = ${input.workspaceId}
       AND provider = ${input.provider}
       AND resource_kind = ${input.resourceKind}
       AND resource_id = ${input.resourceId}
       AND incarnation_id = ${incarnationId}
  `;
  if (existing.length === 0) throw new Error('cloud resource obligation upsert raced past both the insert and the read');
  return { id: Number(existing[0]!.id), created: false };
}

/**
 * The event shape a provider reports when it confirms a resource into existence. Declared
 * structurally on purpose: this module stays free of any provider import, so wiring the ledger
 * to a creation path can never introduce a cycle.
 */
export interface CloudResourceCreatedEventLike {
  readonly resource: {
    readonly kind: string;
    readonly providerId: string;
    readonly incarnationId?: string;
    readonly parentProviderId?: string;
    /**
     * WI-10001673: `WorkspaceHostResourceRef` has carried these all along
     * (libs/generic/deployment-driver/src/workspace-host-types.ts). Declaring them here is
     * what stops the observer from discarding the resource's ADDRESS on the way to the
     * ledger — without them every zonal/regional row is born unreclaimable.
     */
    readonly region?: string;
    readonly zone?: string;
  };
  /** From the live apply context — one provider serves many workspaces. */
  readonly workspaceId: string;
  /**
   * WI-10001673: the workspace-host this resource was created FOR. REQUIRED, and per-event for
   * the same reason `workspaceId` is: it was first modeled on the observer BINDING below, which
   * is constructed once at the DBOS composition root where no host is in scope, so it spread to
   * nothing on every event and all 23 rows created after migration 1168 were born `host_id=''`.
   * A provider that cannot name the host owns a row it can never reclaim, so this is not
   * optional — an empty address must be a loud write, never a quiet default.
   */
  readonly hostId: string;
  /**
   * The enclosing resource this one is addressed THROUGH — for kind=nat, the Cloud Router that
   * owns the NAT config, since `delete-nat` takes `routerName`. Legitimately absent for kinds
   * addressed directly, which is why this one IS optional where `hostId` is not.
   */
  readonly parentResourceId?: string;
}

export interface CloudResourceObligationObserverBinding {
  sql: postgres.Sql;
  purpose?: string;
  createdByOwnerId?: string;
  sourceWorkItemId?: string;
  graceMs?: number;
  /**
   * The workspace-host this provider is applying for. Every GCP delete step carries `hostId`
   * and the provider asserts the target's managed-label identity against it before deleting,
   * so an obligation recorded without one can be escalated but never reclaimed.
   */
  hostId?: string;
}

/**
 * Bind the ledger to a provider's creation seam — the PRODUCING half this module was built for.
 *
 * Until this is attached to a real creation path, the sweep below runs faithfully over a table
 * nothing writes to, and reports "no outstanding obligations" for a project full of live metered
 * resources. That is strictly worse than having no detector: the table, migration and passing
 * tests make the system look instrumented, so its silence reads as an all-clear rather than as
 * absence (WI-10001672 — a canary VM + NAT ran 11 days and produced no signal at all).
 *
 * Every creation is recorded, not just the obviously-metered kinds: a network or firewall still
 * owes teardown, and the existing real rows in this table are exactly that release-network family.
 * Recording is idempotent, so a replayed or retried step re-reports harmlessly.
 */
export function createCloudResourceObligationObserver(
  binding: CloudResourceObligationObserverBinding,
): (event: CloudResourceCreatedEventLike) => Promise<void> {
  return async (event) => {
    await recordCloudResourceObligation(binding.sql, {
      workspaceId: event.workspaceId,
      provider: 'gcp',
      resourceKind: event.resource.kind,
      resourceId: event.resource.providerId,
      ...(event.resource.incarnationId ? { incarnationId: event.resource.incarnationId } : {}),
      ...(event.resource.parentProviderId ? { projectId: event.resource.parentProviderId } : {}),
      ...(event.resource.zone ? { zone: event.resource.zone } : {}),
      ...(event.resource.region ? { region: event.resource.region } : {}),
      // The EVENT wins over the binding. The binding's `hostId` survives only as a fallback for
      // a caller that composes one provider per host; the composition root does not, which is
      // why relying on it alone left every row unaddressable (WI-10001673).
      ...(event.hostId || binding.hostId ? { hostId: event.hostId || binding.hostId } : {}),
      ...(event.parentResourceId ? { parentResourceId: event.parentResourceId } : {}),
      ...(binding.purpose ? { purpose: binding.purpose } : {}),
      ...(binding.createdByOwnerId ? { createdByOwnerId: binding.createdByOwnerId } : {}),
      ...(binding.sourceWorkItemId ? { sourceWorkItemId: binding.sourceWorkItemId } : {}),
      ...(binding.graceMs !== undefined ? { graceMs: binding.graceMs } : {}),
    });
  };
}

/**
 * Close the obligation — the resource was actually torn down (or confirmed to have
 * never existed). Idempotent: closing an already-closed row is a no-op.
 */
export async function closeCloudResourceObligation(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    provider: string;
    resourceKind: string;
    resourceId: string;
    incarnationId?: string;
    /**
     * When the destroy was confirmed by a NOT-FOUND provider read rather than by the delete's own
     * response, the provider cannot name the incarnation it proved gone — there is nothing left to
     * read one from. An absence read at T still proves every incarnation that existed at or before
     * T is gone, so with no `incarnationId` this closes the open row iff it was (re)recorded at or
     * before T. A same-name replacement is recorded after T (reopen resets `created_at`), so its
     * obligation stays open. Without this, an incarnation-stamped VM row whose delete timed out and
     * was confirmed on the reconciling read stayed owed forever and escalated a phantom
     * (WI-10003510: r55 canary VM, 2026-09-27).
     */
    confirmedAbsentAt?: string;
    reason: string;
  },
): Promise<{ closed: boolean; staleIncarnation?: boolean }> {
  requireNonEmpty(input.reason, 'reason');
  const incarnationId = input.incarnationId?.trim() ?? '';
  const confirmedAbsentAt = input.confirmedAbsentAt?.trim() ?? '';
  if (!incarnationId && confirmedAbsentAt && Number.isFinite(Date.parse(confirmedAbsentAt))) {
    const absentRows = await sql<{ id: number }[]>`
      UPDATE harness_shared.cloud_resource_obligations
         SET closed_at = now(), closed_reason = ${input.reason}, teardown_owed = false, updated_at = now()
       WHERE workspace_id = ${input.workspaceId}
         AND provider = ${input.provider}
         AND resource_kind = ${input.resourceKind}
         AND resource_id = ${input.resourceId}
         AND created_at <= ${confirmedAbsentAt}::timestamptz
         AND closed_at IS NULL
       RETURNING id
    `;
    if (absentRows.length > 0) return { closed: true };
  }
  const rows = await sql<{ id: number }[]>`
    UPDATE harness_shared.cloud_resource_obligations
       SET closed_at = now(), closed_reason = ${input.reason}, teardown_owed = false, updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND provider = ${input.provider}
       AND resource_kind = ${input.resourceKind}
       AND resource_id = ${input.resourceId}
       AND (incarnation_id = ${incarnationId}
         OR (${incarnationId} <> '' AND incarnation_id = ''))
       AND closed_at IS NULL
     RETURNING id
  `;
  if (rows.length > 0) return { closed: true };
  if (incarnationId) {
    const current = await sql<{ incarnation_id: string }[]>`
      SELECT incarnation_id FROM harness_shared.cloud_resource_obligations
       WHERE workspace_id = ${input.workspaceId}
         AND provider = ${input.provider}
         AND resource_kind = ${input.resourceKind}
         AND resource_id = ${input.resourceId}
    `;
    if (current.length > 0 && current[0]!.incarnation_id && current[0]!.incarnation_id !== incarnationId) {
      return { closed: false, staleIncarnation: true };
    }
  }
  return { closed: false };
}

/**
 * The event shape a provider reports when it CONFIRMS a resource out of existence — the
 * consuming mirror of `CloudResourceCreatedEventLike`. Declared structurally for the same
 * reason as its twin: this module stays free of any provider import, so binding the ledger
 * to a destroy path can never introduce a cycle.
 */
export interface CloudResourceDestroyedEventLike {
  readonly resource: {
    /**
     * The provider's own delete-op name (e.g. `delete-instance`). Deliberately the OP and not
     * the resource kind: the two vocabularies disagree for the most expensive resource — the op
     * is `delete-instance` while the recorded row's kind is `vm` — so a caller that derived a
     * kind by stripping a `delete-` prefix would close nothing for the VM and report success.
     * The mapping is owned once, by {@link CLOUD_RESOURCE_DELETE_CONTRACT}, and inverted here.
     */
    readonly deleteOp: string;
    readonly providerId: string;
    readonly incarnationId?: string;
    /** When the provider proved the resource absent (see `closeCloudResourceObligation`). */
    readonly confirmedAbsentAt?: string;
  };
  /** From the live apply context — one provider serves many workspaces. */
  readonly workspaceId: string;
  /** Why it was closed; defaults to the provider-confirmed-destroy reason. */
  readonly reason?: string;
}

export interface CloudResourceObligationCloseObserverBinding {
  sql: postgres.Sql;
  /** Defaults to 'gcp' — the only provider whose creation seam is currently bound. */
  provider?: string;
  /**
   * Called when a confirmed destroy matched NO open obligation row. This is deliberately a
   * seam rather than a silent `closed:false`: an unmatched close is indistinguishable from a
   * correct one at the call site, and swallowing it rebuilds the exact failure this ledger
   * exists to detect — a table that looks instrumented while reporting all-clear.
   */
  onUnmatched?: (event: CloudResourceDestroyedEventLike) => void;
}

/**
 * Bind the ledger to a provider's DESTROY seam — the CONSUMING half.
 *
 * `closeCloudResourceObligation` was correct from the day it was written and had ZERO
 * production callers, so every row stayed `teardown_owed = true` forever and the sweep
 * escalated on phantoms. That poisons the leak detector rather than merely failing to help:
 * a REAL leak becomes indistinguishable from a torn-down one.
 *
 * Closing is per-confirmed-delete on purpose. Gating on an aggregate census means one slow
 * or timed-out read discards the terminal evidence for every resource in the operation,
 * which is how a fully-deleted host still ended `failed @99%` with "provider census is not
 * clean" (EI-23459044188861686).
 */
export function createCloudResourceObligationCloseObserver(
  binding: CloudResourceObligationCloseObserverBinding,
): (event: CloudResourceDestroyedEventLike) => Promise<{ closed: boolean; staleIncarnation?: boolean }> {
  return async (event) => {
    const resourceKind = cloudResourceKindForDeleteOp(event.resource.deleteOp);
    if (!resourceKind) {
      // An unmapped delete-op means the provider grew a delete this ledger cannot address.
      // Surfacing it is the whole point: silently returning `closed:false` is how the VM's
      // op/kind disagreement would have stayed invisible.
      binding.onUnmatched?.(event);
      return { closed: false };
    }
    const result = await closeCloudResourceObligation(binding.sql, {
      workspaceId: event.workspaceId,
      provider: binding.provider ?? 'gcp',
      resourceKind,
      resourceId: event.resource.providerId,
      ...(event.resource.incarnationId ? { incarnationId: event.resource.incarnationId } : {}),
      ...(event.resource.confirmedAbsentAt ? { confirmedAbsentAt: event.resource.confirmedAbsentAt } : {}),
      reason: event.reason ?? 'provider confirmed destroy',
    });
    if (!result.closed && !result.staleIncarnation) binding.onUnmatched?.(event);
    return result;
  };
}

/** Every still-open, teardown-owed obligation — the sweep's whole input. */
export async function listOpenCloudResourceObligations(
  sql: postgres.Sql,
  opts: { workspaceId?: string } = {},
): Promise<CloudResourceObligationRow[]> {
  const rows = opts.workspaceId
    ? await sql<Record<string, unknown>[]>`
        SELECT * FROM harness_shared.cloud_resource_obligations
         WHERE closed_at IS NULL AND teardown_owed AND workspace_id = ${opts.workspaceId}
         ORDER BY created_at ASC
      `
    : await sql<Record<string, unknown>[]>`
        SELECT * FROM harness_shared.cloud_resource_obligations
         WHERE closed_at IS NULL AND teardown_owed
         ORDER BY created_at ASC
      `;
  return rows.map(toRow);
}

/** Stamp that an escalation was just filed/refreshed for this obligation. */
export async function markCloudResourceObligationEscalated(
  sql: postgres.Sql,
  id: number,
  workItemId: string,
): Promise<void> {
  requireNonEmpty(workItemId, 'workItemId');
  await sql`
    UPDATE harness_shared.cloud_resource_obligations
       SET last_escalated_at = now(), escalation_work_item_id = ${workItemId}, updated_at = now()
     WHERE id = ${id}
  `;
}

export interface CloudResourceObligationEscalationCandidate {
  id: number;
  workspaceId: string;
  provider: string;
  resourceKind: string;
  resourceId: string;
  projectId: string;
  purpose: string;
  sourceWorkItemId: string;
  createdAtMs: number;
  ageMs: number;
  /** true when a prior escalation already exists (this is a re-nudge, not the first). */
  hadPriorEscalation: boolean;
  priorEscalationWorkItemId: string;
  /**
   * true when this escalated DESPITE its originating work-item still being open — i.e.
   * in-use suppression was overridden by the age ceiling. Distinguishes "nobody owns
   * this" from "the owner is still running but has held it far too long".
   */
  suppressionCeilingOverridden: boolean;
}

export interface CloudResourceObligationEscalationOptions {
  /**
   * Keys (see {@link cloudResourceObligationSourceKey}) of obligations whose originating
   * work-item is still NON-terminal. Those resources are in active use, not leaked, and
   * are suppressed until the age ceiling below.
   *
   * OMITTED means "not established" and suppresses nothing — every caller that cannot
   * answer the question keeps the pre-existing escalate-on-time behaviour. Failing toward
   * escalation is deliberate: an escalation files a work-item for a human/agent to judge,
   * whereas a wrong suppression silently hides a metered resource.
   */
  openSourceWorkItemKeys?: ReadonlySet<string>;
  /**
   * Composite keys of hosts whose desired/observed state is running and whose healthy
   * attestation is fresh. Omitted means the probe was not established, so suppress nothing.
   */
  freshHealthyActiveHostKeys?: ReadonlySet<string>;
  /** Composite keys for hosts bound to an active customer workspace. */
  activeCustomerWorkspaceHostKeys?: ReadonlySet<string>;
  /** Override the in-use suppression ceiling (measured from obligation creation). */
  inUseSuppressionCeilingMs?: number;
}

/**
 * PURE decision logic — no I/O, unit-testable without a database. Given the open rows
 * a sweep tick just read, decide which are escalation-eligible right now:
 *   - past their own grace period (createdAtMs + graceMs <= evaluatedAtMs), AND
 *   - never escalated before, OR the last escalation is older than escalateCooldownMs
 *     (so a live escalation work-item is re-nudged rather than silently going stale,
 *     but not re-filed every single tick), AND
 *   - NOT still in use — no fresh healthy active-host attestation or active customer
 *     workspace binding, and its originating work-item is terminal, unknown, or the
 *     in-use suppression ceiling has elapsed.
 *
 * The in-use gate exists because "teardown owed 23.1h" carries NO information about
 * whether the originating work finished: this sweep is owner-independent by design, so
 * it fires on schedule regardless. Measured 2026-08-31, all four open obligations shared
 * one still-open source work-item (WI-40474) whose holder was live and mid-Packer-run;
 * the sweep filed four "undischarged resource" bugs against infrastructure that was
 * actively in use, and would have re-filed all four every 12h until that work closed.
 * Deleting on that evidence would have broken a live release cut.
 *
 * Ordered oldest-first — the longest-standing obligation is the most urgent one.
 */
export function selectCloudResourceObligationsToEscalate(
  rows: readonly CloudResourceObligationRow[],
  evaluatedAtMs: number,
  escalateCooldownMs: number = CLOUD_RESOURCE_OBLIGATION_DEFAULT_ESCALATION_COOLDOWN_MS,
  options: CloudResourceObligationEscalationOptions = {},
): CloudResourceObligationEscalationCandidate[] {
  if (!Number.isFinite(evaluatedAtMs)) throw new Error('evaluatedAtMs must be finite');
  if (!Number.isSafeInteger(escalateCooldownMs) || escalateCooldownMs < 0) {
    throw new Error('escalateCooldownMs must be a non-negative safe integer');
  }
  const ceilingMs = options.inUseSuppressionCeilingMs ?? CLOUD_RESOURCE_OBLIGATION_IN_USE_SUPPRESSION_CEILING_MS;
  if (!Number.isSafeInteger(ceilingMs) || ceilingMs < 0) {
    throw new Error('inUseSuppressionCeilingMs must be a non-negative safe integer');
  }
  const openSourceKeys = options.openSourceWorkItemKeys;
  const out: CloudResourceObligationEscalationCandidate[] = [];
  for (const row of rows) {
    if (row.closedAtMs !== null || !row.teardownOwed) continue; // caller should already filter; re-assert
    const pastGrace = row.createdAtMs + row.graceMs <= evaluatedAtMs;
    if (!pastGrace) continue;
    const dueForNudge = row.lastEscalatedAtMs === null || evaluatedAtMs - row.lastEscalatedAtMs >= escalateCooldownMs;
    if (!dueForNudge) continue;
    const ageMs = evaluatedAtMs - row.createdAtMs;
    const sourceStillOpen =
      openSourceKeys !== undefined &&
      row.sourceWorkItemId !== '' &&
      openSourceKeys.has(cloudResourceObligationSourceKey(row.workspaceId, row.sourceWorkItemId));
    const freshHealthyHostIsActive =
      options.freshHealthyActiveHostKeys !== undefined &&
      row.hostId !== '' &&
      options.freshHealthyActiveHostKeys.has(cloudResourceObligationHostKey(row.workspaceId, row.hostId));
    const activeCustomerWorkspaceIsInUse =
      options.activeCustomerWorkspaceHostKeys !== undefined &&
      row.hostId !== '' &&
      options.activeCustomerWorkspaceHostKeys.has(cloudResourceObligationHostKey(row.workspaceId, row.hostId));
    // Open source work is suppressed only within its age ceiling; active-host proof has its own freshness bound.
    if (sourceStillOpen && ageMs < ceilingMs) continue;
    // A healthy host or active customer binding owns its resources without source work.
    if (freshHealthyHostIsActive || activeCustomerWorkspaceIsInUse) continue;
    out.push({
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      projectId: row.projectId,
      purpose: row.purpose,
      sourceWorkItemId: row.sourceWorkItemId,
      createdAtMs: row.createdAtMs,
      ageMs,
      hadPriorEscalation: row.lastEscalatedAtMs !== null,
      priorEscalationWorkItemId: row.escalationWorkItemId,
      suppressionCeilingOverridden: sourceStillOpen,
    });
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/**
 * Which of these obligations' originating work-items are still NON-terminal?
 *
 * Terminal vocabulary is DERIVED from ANY_FAMILY_TERMINAL_STATES rather than re-listed
 * here — the obligation ledger sees both work-item families, and a hand-copied status
 * list is exactly the drift that made `dropped` invisible to a sibling consumer for a
 * month (EI-21921121818266895).
 */
export async function readOpenSourceWorkItemKeys(
  sql: postgres.Sql,
  rows: readonly CloudResourceObligationRow[],
): Promise<Set<string>> {
  const workspaceIds = [...new Set(rows.map((r) => r.workspaceId).filter((s) => s !== ''))];
  const sourceIds = [...new Set(rows.map((r) => r.sourceWorkItemId).filter((s) => s !== ''))];
  if (workspaceIds.length === 0 || sourceIds.length === 0) return new Set();
  const found = (await sql`
    SELECT workspace_id, feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ANY(${workspaceIds as string[]}::text[])
       AND feature_id = ANY(${sourceIds as string[]}::text[])
       AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
  `) as unknown as Array<Record<string, unknown>>;
  const out = new Set<string>();
  for (const raw of found) {
    out.add(cloudResourceObligationSourceKey(String(raw.workspace_id ?? ''), String(raw.feature_id ?? '')));
  }
  return out;
}

/**
 * Which obligations belong to a currently running, freshly healthy workspace host?
 * The bounded attestation window is tied to the host soak cadence: three missed samples
 * make the state unknown, so the sweep falls back to escalation instead of hiding a leak.
 */
export async function readFreshHealthyActiveHostKeys(
  sql: postgres.Sql,
  rows: readonly CloudResourceObligationRow[],
  evaluatedAtMs: number,
  freshnessMs: number = CLOUD_RESOURCE_ACTIVE_HOST_HEALTH_FRESHNESS_MS,
): Promise<Set<string>> {
  if (!Number.isFinite(evaluatedAtMs)) throw new Error('evaluatedAtMs must be finite');
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs <= 0) {
    throw new Error('freshnessMs must be a positive safe integer');
  }
  const hostPairs = [
    ...new Map(
      rows
        .filter((row) => row.workspaceId !== '' && row.hostId !== '')
        .map((row) => [cloudResourceObligationHostKey(row.workspaceId, row.hostId), row] as const),
    ).values(),
  ];
  if (hostPairs.length === 0) return new Set();
  const workspaceIds = hostPairs.map((row) => row.workspaceId);
  const hostIds = hostPairs.map((row) => row.hostId);
  const requestedKeys = new Set(hostPairs.map((row) => cloudResourceObligationHostKey(row.workspaceId, row.hostId)));
  const freshAfter = new Date(evaluatedAtMs - freshnessMs).toISOString();
  const evaluatedAt = new Date(evaluatedAtMs).toISOString();
  const found = (await sql`
    SELECT workspace_id, id AS host_id
      FROM harness_shared.workspace_hosts
     WHERE (workspace_id, id) IN (
       SELECT * FROM unnest(${workspaceIds as string[]}::text[], ${hostIds as string[]}::text[])
     )
       AND desired_state = 'running'
       AND observed_state = 'running'
       AND observed_revision = desired_revision
       AND health_status = 'healthy'
       AND health_attested_at >= ${freshAfter}::timestamptz
       AND health_attested_at <= ${evaluatedAt}::timestamptz
  `) as unknown as Array<Record<string, unknown>>;
  const out = new Set<string>();
  for (const raw of found) {
    const key = cloudResourceObligationHostKey(String(raw.workspace_id ?? ''), String(raw.host_id ?? ''));
    if (requestedKeys.has(key)) out.add(key);
  }
  return out;
}

/**
 * Which obligations belong to hosts still bound to an active customer workspace.
 * Health may be unknown during an upgrade, but an active customer binding means the
 * resources are still in use. Leave ledger rows open for the provider-destroy observer
 * to close when teardown actually occurs.
 */
export async function readActiveCustomerWorkspaceHostKeys(
  sql: postgres.Sql,
  rows: readonly CloudResourceObligationRow[],
): Promise<Set<string>> {
  const hostPairs = [
    ...new Map(
      rows
        .filter((row) => row.workspaceId !== '' && row.hostId !== '')
        .map((row) => [cloudResourceObligationHostKey(row.workspaceId, row.hostId), row] as const),
    ).values(),
  ];
  if (hostPairs.length === 0) return new Set();
  const workspaceIds = hostPairs.map((row) => row.workspaceId);
  const hostIds = hostPairs.map((row) => row.hostId);
  const requestedKeys = new Set(hostPairs.map((row) => cloudResourceObligationHostKey(row.workspaceId, row.hostId)));
  const found = (await sql<Array<Record<string, unknown>>>`
    SELECT workspace_id, workspace_host_id AS host_id
      FROM harness_shared.customer_workspaces
     WHERE (workspace_id, workspace_host_id) IN (
       SELECT * FROM unnest(${workspaceIds as string[]}::text[], ${hostIds as string[]}::text[])
     )
       AND state = 'active'
  `) as unknown as Array<Record<string, unknown>>;
  const out = new Set<string>();
  for (const raw of found) {
    const key = cloudResourceObligationHostKey(String(raw.workspace_id ?? ''), String(raw.host_id ?? ''));
    if (requestedKeys.has(key)) out.add(key);
  }
  return out;
}

/**
 * Default age at which an obligation becomes RECLAMATION-eligible (as opposed to merely
 * escalation-eligible at `graceMs`, 6h by default).
 *
 * Deliberately far beyond the escalation grace AND beyond one escalation cooldown (12h):
 * by the time anything is deleted, an escalation work-item has existed for at least half a
 * day with nobody discharging it. Escalating is cheap and reversible; deleting is neither,
 * so the two thresholds must not be the same number.
 */
export const CLOUD_RESOURCE_OBLIGATION_DEFAULT_RECLAIM_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

export interface CloudResourceDeleteContractEntry {
  /** The provider delete op this kind is torn down with (`GcpStepInput`, gcp-provider.ts). */
  readonly op: string;
  /** Location fields that MUST be non-empty on the ledger row, or the delete cannot be built. */
  readonly requires: readonly ('zone' | 'region' | 'parentResourceId')[];
}

/**
 * How each resource kind is ADDRESSED for deletion. A GCP delete is not "name the thing" —
 * zonal kinds need their zone, regional kinds their region, and a Cloud NAT is addressed
 * THROUGH its owning router. This table is what makes "can this row even be deleted?" a
 * decidable question instead of a runtime surprise at the provider call.
 *
 * Kinds absent here (e.g. `snapshot`, which the census enumerates but the provider has no
 * delete op for) are UNSUPPORTED, and say so rather than silently never being reclaimed.
 *
 * DERIVED-TRUTH NOTE: this restates a mapping owned by gcp-provider.ts, which this module
 * deliberately cannot import (the whole point of the structural/duck-typed seam above — an
 * import here would cycle the ledger into the provider graph). It is therefore PINNED by a
 * source-text parity test rather than hand-maintained: see
 * cloud-resource-obligations.delete-contract-parity.test.ts, which fails if the provider's
 * kind→op ordering or its delete union drifts from this table.
 */
export const CLOUD_RESOURCE_DELETE_CONTRACT: Readonly<Record<string, CloudResourceDeleteContractEntry>> = {
  vm: { op: 'delete-instance', requires: ['zone'] },
  disk: { op: 'delete-disk', requires: ['zone'] },
  firewall: { op: 'delete-firewall', requires: [] },
  nat: { op: 'delete-nat', requires: ['region', 'parentResourceId'] },
  router: { op: 'delete-router', requires: ['region'] },
  subnetwork: { op: 'delete-subnetwork', requires: ['region'] },
  network: { op: 'delete-network', requires: [] },
};

/**
 * Delete-op -> recorded resource kind, DERIVED by inverting the contract above rather than
 * hand-written. That contract is already parity-tested against the provider's delete union, so a
 * new deletable kind cannot appear unmapped here without failing those tests — exactly the
 * property a second hand-maintained copy would silently lose.
 *
 * This inversion is the reason the destroy seam reports a `deleteOp` instead of a kind: the two
 * vocabularies agree for six of the seven ops and disagree for the most expensive one
 * (`delete-instance` <-> `vm`), so deriving a kind by stripping a `delete-` prefix would close
 * nothing for the VM and still report success (EI-23459044188861686).
 */
export const CLOUD_RESOURCE_DELETE_OP_KIND: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CLOUD_RESOURCE_DELETE_CONTRACT).map(([kind, entry]) => [entry.op, kind]),
  ),
);

/** Resolve a provider delete-op to the resource kind the create side recorded. */
export function cloudResourceKindForDeleteOp(deleteOp: string): string | undefined {
  return CLOUD_RESOURCE_DELETE_OP_KIND[deleteOp];
}

/** The concrete arguments a provider delete step needs. Structural — no provider import. */
export interface CloudResourceDeleteAddress {
  op: string;
  projectId: string;
  resourceName: string;
  hostId: string;
  zone?: string;
  region?: string;
  /** `delete-nat` addresses the NAT config through its owning Cloud Router. */
  routerName?: string;
}

export type CloudResourceAddressability =
  | { addressable: true; address: CloudResourceDeleteAddress }
  | { addressable: false; op: string | null; missing: readonly string[] };

/**
 * Can a delete call be constructed for this row RIGHT NOW, from the ledger alone?
 *
 * PURE. Returns the concrete address or the exact list of what is missing — never a
 * boolean, because "no" without "missing which field" is precisely the answer that got
 * this ledger built wrong twice: a caller that cannot name the gap silently skips the row,
 * and a skipped metered resource is indistinguishable from a clean ledger.
 */
export function describeCloudResourceDeleteAddress(
  row: Pick<
    CloudResourceObligationRow,
    'resourceKind' | 'resourceId' | 'projectId' | 'zone' | 'region' | 'parentResourceId' | 'hostId'
  >,
): CloudResourceAddressability {
  const entry = CLOUD_RESOURCE_DELETE_CONTRACT[row.resourceKind];
  if (!entry) return { addressable: false, op: null, missing: [`unsupported-kind:${row.resourceKind}`] };
  const missing: string[] = [];
  if (row.resourceId.trim() === '') missing.push('resourceId');
  if (row.projectId.trim() === '') missing.push('projectId');
  if (row.hostId.trim() === '') missing.push('hostId');
  for (const field of entry.requires) {
    if (row[field].trim() === '') missing.push(field);
  }
  if (missing.length > 0) return { addressable: false, op: entry.op, missing };
  return {
    addressable: true,
    address: {
      op: entry.op,
      projectId: row.projectId,
      resourceName: row.resourceId,
      hostId: row.hostId,
      ...(entry.requires.includes('zone') ? { zone: row.zone } : {}),
      ...(entry.requires.includes('region') ? { region: row.region } : {}),
      ...(entry.requires.includes('parentResourceId') ? { routerName: row.parentResourceId } : {}),
    },
  };
}

export type CloudResourceReclamationBlockedReason =
  /** Past the reclaim TTL but no escalation has ever fired for it. */
  | 'never-escalated'
  /** Its originating work-item is still non-terminal — the resource may be in active use. */
  | 'source-work-item-open'
  /** The ledger row cannot address the resource (see `missing`). */
  | 'unaddressable';

export interface CloudResourceReclamationCandidate {
  id: number;
  workspaceId: string;
  provider: string;
  resourceKind: string;
  resourceId: string;
  sourceWorkItemId: string;
  escalationWorkItemId: string;
  createdAtMs: number;
  ageMs: number;
  address: CloudResourceDeleteAddress;
}

export interface CloudResourceReclamationBlocked {
  id: number;
  workspaceId: string;
  provider: string;
  resourceKind: string;
  resourceId: string;
  sourceWorkItemId: string;
  createdAtMs: number;
  ageMs: number;
  reason: CloudResourceReclamationBlockedReason;
  /** For `unaddressable`: exactly which fields are absent. Empty for the other reasons. */
  missing: readonly string[];
}

export interface CloudResourceReclamationPlan {
  evaluatedAtMs: number;
  reclaimAfterMs: number;
  /** Rows a reclaimer may delete now — every rail below already satisfied. */
  reclaim: readonly CloudResourceReclamationCandidate[];
  /**
   * Rows PAST the reclaim TTL that must not be deleted, each with why. This list is the
   * whole point of returning a plan rather than a filtered array: a past-due resource that
   * cannot be reclaimed is a louder signal than one that can, and dropping it on the floor
   * is how a leak becomes invisible.
   */
  blocked: readonly CloudResourceReclamationBlocked[];
}

export interface CloudResourceReclamationOptions {
  reclaimAfterMs?: number;
  /**
   * Keys (see {@link cloudResourceObligationSourceKey}) whose originating work-item is still
   * NON-terminal. As in the escalation path, OMITTED means "not established" — but the two
   * paths fail in OPPOSITE directions on purpose. Escalation fails toward acting (filing a
   * bug is cheap); reclamation fails toward NOT acting, because a wrong delete is
   * unrecoverable. So an unestablished source state BLOCKS reclamation rather than allowing
   * it, and there is deliberately no age-ceiling override here: "held far too long" justifies
   * a louder escalation, never an unilateral delete of something still claimed as in use.
   */
  openSourceWorkItemKeys?: ReadonlySet<string>;
}

/**
 * PURE decision logic for ENFORCED TEARDOWN — the half `runCloudResourceObligationSweepOnce`
 * has never had. Given open obligations, decide which may actually be deleted now.
 *
 * Scoped STRICTLY to rows in this ledger, which is the safety property that matters: it
 * iterates obligations WE recorded at creation time, so it can never propose deleting
 * infrastructure nobody registered. That is not a detail — the project these rows live in
 * also hosts unrelated long-lived infrastructure, and a label- or name-matching reaper
 * (see `censusGcpWorkspaceHostResources`) has a far wider blast radius by construction.
 *
 * Every rail must hold before a row is reclaimable:
 *   1. open + teardown still owed;
 *   2. older than `reclaimAfterMs` (well past the escalation grace);
 *   3. an escalation has ALREADY fired — nothing is ever deleted that no one was told
 *      about, which makes a silent delete structurally impossible rather than merely
 *      discouraged;
 *   4. its originating work-item is terminal (or established-absent);
 *   5. the row can address the resource.
 *
 * Ordered oldest-first: the longest-standing obligation is the most expensive one.
 */
export function planCloudResourceObligationReclamation(
  rows: readonly CloudResourceObligationRow[],
  evaluatedAtMs: number,
  options: CloudResourceReclamationOptions = {},
): CloudResourceReclamationPlan {
  if (!Number.isFinite(evaluatedAtMs)) throw new Error('evaluatedAtMs must be finite');
  const reclaimAfterMs = options.reclaimAfterMs ?? CLOUD_RESOURCE_OBLIGATION_DEFAULT_RECLAIM_AFTER_MS;
  if (!Number.isSafeInteger(reclaimAfterMs) || reclaimAfterMs < 0) {
    throw new Error('reclaimAfterMs must be a non-negative safe integer');
  }
  const openSourceKeys = options.openSourceWorkItemKeys;
  const reclaim: CloudResourceReclamationCandidate[] = [];
  const blocked: CloudResourceReclamationBlocked[] = [];
  for (const row of rows) {
    if (row.closedAtMs !== null || !row.teardownOwed) continue;
    const ageMs = evaluatedAtMs - row.createdAtMs;
    if (ageMs < reclaimAfterMs) continue; // not yet due — neither reclaimable nor a finding
    const common = {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      sourceWorkItemId: row.sourceWorkItemId,
      createdAtMs: row.createdAtMs,
      ageMs,
    };
    if (row.lastEscalatedAtMs === null) {
      blocked.push({ ...common, reason: 'never-escalated', missing: [] });
      continue;
    }
    // Unknown source state blocks: see the fail-toward-not-acting note on the options type.
    const sourceStillOpen =
      row.sourceWorkItemId !== '' &&
      (openSourceKeys === undefined ||
        openSourceKeys.has(cloudResourceObligationSourceKey(row.workspaceId, row.sourceWorkItemId)));
    if (sourceStillOpen) {
      blocked.push({ ...common, reason: 'source-work-item-open', missing: [] });
      continue;
    }
    const addressability = describeCloudResourceDeleteAddress(row);
    if (!addressability.addressable) {
      blocked.push({ ...common, reason: 'unaddressable', missing: addressability.missing });
      continue;
    }
    reclaim.push({ ...common, escalationWorkItemId: row.escalationWorkItemId, address: addressability.address });
  }
  reclaim.sort((a, b) => a.createdAtMs - b.createdAtMs);
  blocked.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return { evaluatedAtMs, reclaimAfterMs, reclaim, blocked };
}

/**
 * Minimal structural shape of `captureImprovement` (capture-core.ts) — duck-typed
 * rather than imported, so this workspace-host module does not pull in the whole
 * improvements-capture dependency graph. Kept deliberately narrow to exactly the
 * fields the sweep uses; `watchdogKey` is what makes a re-nudge COALESCE onto the
 * same work-item (bumping repeatCount) instead of filing a sibling.
 */
export interface CloudResourceObligationCaptureDep {
  (input: {
    title: string;
    kind: 'bug';
    body?: string;
    severity?: 'critical' | 'major' | 'minor' | 'nit';
    watchdogKey: string;
    createdBy?: string;
  }): Promise<{ ok: true; created: boolean; issue?: { id: string } }>;
}

/**
 * Resolves one escalation work-item whose obligations are ALL discharged (WI-10003512).
 * The DBOS wiring flips it to `resolved` under the watchdog auto-close terminal owner, so
 * an exact-key recurrence (the same resource name leaking again) REOPENS that row via
 * capture-core instead of minting a sibling.
 */
export interface CloudResourceObligationEscalationResolveDep {
  (input: { workspaceId: string; workItemId: string; reason: string }): Promise<void>;
}

export interface CloudResourceObligationSweepDeps {
  capture: CloudResourceObligationCaptureDep;
  /**
   * OMITTED keeps the escalate-only sweep. Supplied, the sweep also retires every open
   * escalation whose referencing obligations have all closed — without it, each discharged
   * leak left a phantom "Undischarged …" bug open forever (24 measured 2026-09-27).
   */
  resolveEscalation?: CloudResourceObligationEscalationResolveDep;
}

export interface CloudResourceObligationSweepResult {
  candidates: number;
  escalated: number;
  errors: Array<{ id: number; error: string }>;
  /** Escalations retired this tick; present only when `resolveEscalation` was supplied. */
  resolved?: number;
}

/** An open escalation work-item whose every referencing obligation is closed. */
export interface DischargedCloudResourceObligationEscalation {
  workspaceId: string;
  workItemId: string;
  /** `<kind> <resourceId>` for each obligation that referenced the escalation. */
  resources: string[];
  closedReasons: string[];
  lastClosedAtMs: number;
}

/**
 * Escalations that should no longer be open: every obligation row pointing at the work-item
 * is closed, and the work-item itself is still non-terminal. One open row sharing the
 * escalation (a same-name replacement that already re-escalated onto it) keeps it open.
 * A replacement still inside its grace period does not reference the item yet; if it later
 * leaks, capture's exact-key recurrence reopens the resolved row.
 */
export async function listDischargedOpenCloudResourceObligationEscalations(
  sql: postgres.Sql,
): Promise<DischargedCloudResourceObligationEscalation[]> {
  const rows = (await sql`
    SELECT o.workspace_id,
           o.escalation_work_item_id,
           array_agg(o.resource_kind || ' ' || o.resource_id ORDER BY o.id) AS resources,
           array_agg(DISTINCT o.closed_reason) AS closed_reasons,
           max(o.closed_at) AS last_closed_at
      FROM harness_shared.cloud_resource_obligations o
     WHERE o.escalation_work_item_id <> ''
     GROUP BY o.workspace_id, o.escalation_work_item_id
    HAVING bool_and(o.closed_at IS NOT NULL)
       AND EXISTS (
         SELECT 1
           FROM harness_shared.work_items w
          WHERE w.workspace_id = o.workspace_id
            AND w.feature_id = o.escalation_work_item_id
            AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
       )
     ORDER BY max(o.closed_at) ASC
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((raw) => ({
    workspaceId: String(raw.workspace_id ?? ''),
    workItemId: String(raw.escalation_work_item_id ?? ''),
    resources: Array.isArray(raw.resources) ? raw.resources.map(String) : [],
    closedReasons: Array.isArray(raw.closed_reasons)
      ? raw.closed_reasons.map(String).filter((s) => s !== '')
      : [],
    lastClosedAtMs: raw.last_closed_at ? new Date(raw.last_closed_at as string | Date).getTime() : Number.NaN,
  }));
}

/**
 * The whole sweep tick body, split out of the DBOS wrapper so it is testable without
 * a scheduler (mirrors reclaimOrphanPgssStatsOnce / runRecipeHygieneOnce). Reads every
 * open obligation, decides which are escalation-eligible, and files/refreshes a durable
 * bug work-item for each via the injected `capture` dependency — the OWNER-INDEPENDENT
 * half of the fix: this function runs on the DBOS scheduler's own process, so detection
 * does not depend on the creating agent's session, or any agent's session, surviving.
 *
 * A per-candidate capture failure is recorded in `errors` and does not abort the rest
 * of the sweep — one bad row must never strand every other obligation's escalation.
 */
export async function runCloudResourceObligationSweepOnce(
  sql: postgres.Sql,
  deps: CloudResourceObligationSweepDeps,
  opts: { evaluatedAtMs?: number; escalateCooldownMs?: number; inUseSuppressionCeilingMs?: number } = {},
): Promise<CloudResourceObligationSweepResult> {
  const evaluatedAtMs = opts.evaluatedAtMs ?? Date.now();
  const open = await listOpenCloudResourceObligations(sql);
  const errors: Array<{ id: number; error: string }> = [];
  // Which of these are still in ACTIVE USE? An open source work-item, a fresh healthy
  // host attestation, or an active customer-workspace binding can establish use. A failed
  // probe falls back to escalation, never to suppression.
  let openSourceWorkItemKeys: ReadonlySet<string> | undefined;
  try {
    openSourceWorkItemKeys = await readOpenSourceWorkItemKeys(sql, open);
  } catch (err) {
    errors.push({ id: 0, error: `source work-item state read failed: ${(err as Error).message}` });
    openSourceWorkItemKeys = undefined;
  }
  let freshHealthyActiveHostKeys: ReadonlySet<string> | undefined;
  try {
    freshHealthyActiveHostKeys = await readFreshHealthyActiveHostKeys(sql, open, evaluatedAtMs);
  } catch (err) {
    errors.push({ id: 0, error: 'active workspace-host state read failed: ' + (err as Error).message });
    freshHealthyActiveHostKeys = undefined;
  }
  let activeCustomerWorkspaceHostKeys: ReadonlySet<string> | undefined;
  try {
    activeCustomerWorkspaceHostKeys = await readActiveCustomerWorkspaceHostKeys(sql, open);
  } catch (err) {
    errors.push({ id: 0, error: 'active customer-workspace binding read failed: ' + (err as Error).message });
    activeCustomerWorkspaceHostKeys = undefined;
  }
  const candidates = selectCloudResourceObligationsToEscalate(open, evaluatedAtMs, opts.escalateCooldownMs, {
    openSourceWorkItemKeys,
    freshHealthyActiveHostKeys,
    activeCustomerWorkspaceHostKeys,
    inUseSuppressionCeilingMs: opts.inUseSuppressionCeilingMs,
  });
  let escalated = 0;
  for (const c of candidates) {
    try {
      const ageHours = (c.ageMs / 3_600_000).toFixed(1);
      const watchdogKey = `cloud-resource-obligation:${c.provider}:${c.resourceKind}:${c.resourceId}`;
      const title =
        `Undischarged ${c.provider.toUpperCase()} ${c.resourceKind} '${c.resourceId}' — teardown owed ` +
        `${ageHours}h, nothing has closed it`;
      const body =
        `A ${c.provider} ${c.resourceKind} named '${c.resourceId}'` +
        (c.projectId ? ` (project ${c.projectId})` : '') +
        ` was created ${ageHours}h ago and has not been marked torn down.\n\n` +
        (c.purpose ? `Purpose recorded at creation: ${c.purpose}\n\n` : '') +
        (c.sourceWorkItemId ? `Originating work-item: ${c.sourceWorkItemId}\n\n` : '') +
        `This is an OWNER-INDEPENDENT sweep of harness_shared.cloud_resource_obligations ` +
        `(migration 1040, id=${c.id}) — it fires on a schedule and does not depend on the creating ` +
        `agent's session surviving. It cannot itself verify or delete the resource (no working cloud ` +
        `credential is available to this sweep); whoever picks this up should (a) verify via the ` +
        `provider console/API whether the resource still exists, (b) tear it down if it is no longer ` +
        `needed, and (c) call closeCloudResourceObligation({ workspaceId:'${c.workspaceId}', ` +
        `provider:'${c.provider}', resourceKind:'${c.resourceKind}', resourceId:'${c.resourceId}', ` +
        `reason:'<what you found>' }) (packages/operator-core/lib/workspace-host/` +
        `cloud-resource-obligations.ts) once discharged, so this escalation stops re-firing.` +
        (c.hadPriorEscalation
          ? `\n\nThis is a RE-NUDGE — a prior escalation ${c.priorEscalationWorkItemId} was filed for ` +
            `this same resource and appears to still be open.`
          : '') +
        (c.suppressionCeilingOverridden
          ? `\n\n⚠ THE ORIGINATING WORK-ITEM ${c.sourceWorkItemId} IS STILL OPEN. Obligations whose ` +
            `source work-item is still running are normally suppressed as in-use rather than filed as ` +
            `leaks; this one escalated because it has been open for ` +
            `${(c.ageMs / 3_600_000).toFixed(1)}h, past the ` +
            `${(CLOUD_RESOURCE_OBLIGATION_IN_USE_SUPPRESSION_CEILING_MS / 3_600_000).toFixed(0)}h ceiling. ` +
            `So do NOT assume the resource is abandoned: confirm with ${c.sourceWorkItemId}'s holder ` +
            `before tearing anything down. Either that work is genuinely still using it (in which case ` +
            `the resource is fine and the WORK-ITEM is what has stalled), or the work-item has been ` +
            `abandoned open and both it and the resource need closing.`
          : '');
      const result = await deps.capture({
        title,
        kind: 'bug',
        body,
        severity: 'major',
        watchdogKey,
        createdBy: 'system:cloud-resource-obligation-sweep',
      });
      const workItemId = result.issue?.id;
      if (workItemId) {
        await markCloudResourceObligationEscalated(sql, c.id, workItemId);
        escalated += 1;
      }
    } catch (err) {
      errors.push({ id: c.id, error: (err as Error).message });
    }
  }
  if (!deps.resolveEscalation) return { candidates: candidates.length, escalated, errors };
  // WI-10003512: retire escalations whose obligations have all been discharged. The
  // escalation body tells its reader to close the obligation "so this escalation stops
  // re-firing" — this is the half that makes that closure also close the work-item.
  let resolved = 0;
  let discharged: DischargedCloudResourceObligationEscalation[] = [];
  try {
    discharged = await listDischargedOpenCloudResourceObligationEscalations(sql);
  } catch (err) {
    errors.push({ id: 0, error: `discharged-escalation read failed: ${(err as Error).message}` });
  }
  for (const d of discharged) {
    const closedAt = Number.isFinite(d.lastClosedAtMs) ? new Date(d.lastClosedAtMs).toISOString() : 'unknown';
    const reason =
      `every obligation this escalation tracked is closed (${d.resources.join(', ')}; last closed ${closedAt}` +
      (d.closedReasons.length > 0 ? `; recorded reason: ${d.closedReasons.join(' | ')}` : '') +
      ')';
    try {
      await deps.resolveEscalation({ workspaceId: d.workspaceId, workItemId: d.workItemId, reason });
      resolved += 1;
    } catch (err) {
      errors.push({ id: 0, error: `escalation ${d.workItemId} resolve failed: ${(err as Error).message}` });
    }
  }
  return { candidates: candidates.length, escalated, errors, resolved };
}
