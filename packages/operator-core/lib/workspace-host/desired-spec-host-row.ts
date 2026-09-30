/**
 * The ONE projection of a `WorkspaceHostDesiredSpec` onto the denormalized
 * `harness_shared.workspace_hosts` columns.
 *
 * WHY THIS IS SHARED RATHER THAN INLINE. Two independent callers must write a host row from
 * the same spec, and they must agree COLUMN FOR COLUMN:
 *
 *   - the provisioning runner, which persists the spec before creating the resource graph
 *     it governs (`provisioning-runner.ts`), and
 *   - hosted workspace admission, which must create the host row BEFORE the customer
 *     workspace binding because `customer_workspaces.workspace_host_id` is NOT NULL and
 *     FKs `workspace_hosts` (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, D-381/D-383).
 *
 * A second hand-written mapping would diverge silently: both writers target the same row by
 * `(workspace_id, id)`, so a disagreement does not fail — it OVERWRITES, and the row then
 * describes a host nobody asked for. Keeping the projection in one function makes that class
 * of drift impossible rather than merely unlikely.
 *
 * `id` is derived from `desired.hostId` because that is what the runner itself treats as the
 * host's identity (`nonEmpty(input.desired.hostId, 'desired.hostId')`). The spec carries the
 * identity; the row does not get to invent a different one.
 *
 * Deliberately PURE and free of lifecycle state: `desiredState`/`observedState`,
 * revisions, generation and controller authority are the CALLER's to supply, because they
 * describe where that caller is in the lifecycle, not what the spec asks for.
 */
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { WorkspaceHostInput } from './observability-store';

/** Exactly the `WorkspaceHostInput` fields that are a function of the desired spec alone. */
export type WorkspaceHostSpecColumns = Pick<
  WorkspaceHostInput,
  'id' | 'target' | 'scopeLabel' | 'region' | 'size' | 'image' | 'diskGiB' | 'network'
>;

/**
 * Human-readable network label for the host row.
 *
 * `provider.network` is non-secret provider-specific desired state with no fixed schema, so
 * this narrows defensively and falls back to `provider-managed` rather than throwing: a
 * missing cosmetic label must never fail a provision.
 */
export function workspaceHostNetworkLabel(desired: WorkspaceHostDesiredSpec): string {
  const network = desired.provider?.network;
  if (!network || typeof network !== 'object' || Array.isArray(network)) return 'provider-managed';
  const record = network as Record<string, unknown>;
  if (typeof record.networkName === 'string' && record.networkName.trim()) return record.networkName.trim();
  if (typeof record.mode === 'string' && record.mode.trim()) return record.mode.trim();
  return 'provider-managed';
}

/** Project the desired spec onto the host-row columns it determines. */
export function workspaceHostSpecColumns(desired: WorkspaceHostDesiredSpec): WorkspaceHostSpecColumns {
  return {
    id: desired.hostId,
    target: desired.target,
    scopeLabel: desired.scope.id,
    region: desired.region,
    size: desired.size,
    image: desired.image.id,
    diskGiB: desired.data.volumeGiB,
    network: workspaceHostNetworkLabel(desired),
  };
}
