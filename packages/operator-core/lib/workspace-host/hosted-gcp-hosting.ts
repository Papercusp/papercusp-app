/**
 * "Use Papercusp's cloud" (D-399): reserve ONE workspace host for ONE organization inside
 * Papercusp's own GCP hosting project, enforced by GCP rather than by Papercusp's code alone.
 *
 * The organization's own Papercusp account (hosted-gcp-auth.ts, D-397) is the identity that
 * acts on its host, and it holds exactly two roles in the hosting project:
 * - OBSERVER, unconditional: project facts, lists (the destroy census filters them by label),
 *   operation polling, and IAP tunnelling (below). Nothing in it creates, changes or deletes
 *   a resource.
 * - HOST, conditioned on resource NAME: every mutating permission, but only for resources whose
 *   names carry the reserved host's prefixes ({@link gcpWorkspaceHostNamePrefixes}).
 * So GCP itself refuses a change to another tenant's machine even if Papercusp's own code
 * asked for one, and the customer holds no credential for the project at all: every action
 * routes through the control plane, which mints the organization's token for one hour.
 * The instance runs WITHOUT a service account, so nothing on it can reach the project either
 * (the HOST role deliberately lacks iam.serviceAccounts.actAs, so it cannot attach one).
 *
 * Measured 2026-09-23 06:01-06:05Z against papercusp-hosted-workspaces
 * (.papercusp/scratch/d399-iam-probe.log): with a condition of this shape, create was allowed
 * for the reserved prefix and denied for another on network, instance, disk and snapshot;
 * subnetwork, firewall, router and NAT creation were allowed; creating an instance with the
 * default service account was denied; project-wide instance listing was allowed.
 *
 * IAP TUNNELLING IS NOT NAME-SCOPED, because it cannot be. Measured 06:45-06:56Z
 * (.papercusp/scratch/d399-iap-probe-2.log, -3.log): IAP authorizes a tunnel against the
 * instance's NUMERIC id, so the name-conditioned grant was refused even for the reserved
 * host's own machine (with and without an `iap_tunnel/.../instances/<prefix>` clause), while
 * the same permission granted unconditionally reached it. The tunnel permission therefore sits
 * in the unconditional role. What still separates tenants on that path: the tunnel reaches
 * only port 22 (each host's firewall admits nothing else from the IAP range), a login needs
 * that host's own SSH key, and no tenant ever holds a token. The stricter shape is measured to
 * work (-3.log round B): a host-role clause
 * `resource.name == 'projects/<project NUMBER>/iap_tunnel/zones/<zone>/instances/<instance id>'`
 * admitted that instance and refused its neighbour. It needs the grant rewritten after every
 * instance (re)create, so it is tracked separately rather than done here.
 *
 * Capacity: an allow policy holds at most 1,500 principal appearances and each organization
 * uses two, so one hosting project serves roughly 700 organizations before it must shard.
 */
import { gcpWorkspaceHostNamePrefixes } from './gcp-provider';

/** The GCP project that holds every Papercusp-hosted workspace host. */
export const HOSTED_GCP_WORKSPACE_PROJECT_ENV = 'PAPERCUSP_HOSTED_GCP_WORKSPACE_PROJECT';

/** Where Papercusp-hosted hosts run. One region, so the name conditions stay short. */
export const PAPERCUSP_HOSTED_GCP_LOCATION = { region: 'us-central1', zone: 'us-central1-c' } as const;

export const PAPERCUSP_HOSTED_HOST_ROLE_ID = 'papercuspHostedWorkspaceHost';
export const PAPERCUSP_HOSTED_OBSERVER_ROLE_ID = 'papercuspHostedWorkspaceObserver';

/** Name-scoped by the grant's condition. No actAs: the instance holds no identity. */
export const PAPERCUSP_HOSTED_HOST_PERMISSIONS = [
  'compute.networks.create',
  'compute.networks.get',
  'compute.networks.delete',
  'compute.networks.updatePolicy',
  'compute.subnetworks.create',
  'compute.subnetworks.get',
  'compute.subnetworks.delete',
  'compute.subnetworks.use',
  'compute.firewalls.create',
  'compute.firewalls.get',
  'compute.firewalls.delete',
  'compute.routers.create',
  'compute.routers.get',
  'compute.routers.update',
  'compute.routers.delete',
  'compute.disks.create',
  'compute.disks.get',
  'compute.disks.delete',
  'compute.disks.createSnapshot',
  'compute.disks.use',
  'compute.disks.setLabels',
  'compute.instances.create',
  'compute.instances.get',
  'compute.instances.getGuestAttributes',
  'compute.instances.start',
  'compute.instances.stop',
  'compute.instances.reset',
  'compute.instances.delete',
  'compute.instances.setLabels',
  'compute.instances.setMetadata',
  'compute.instances.setTags',
  'compute.instances.osLogin',
  'compute.instances.osAdminLogin',
  'compute.snapshots.create',
  'compute.snapshots.get',
  'compute.snapshots.delete',
  'compute.snapshots.setLabels',
  'compute.snapshots.useReadOnly',
] as const;

/** Unconditional: read-only, plus the IAP tunnel that no name condition can scope. */
export const PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS = [
  'iap.tunnelInstances.accessViaIAP',
  'resourcemanager.projects.get',
  'serviceusage.services.get',
  'compute.projects.get',
  'compute.regions.get',
  'compute.regions.list',
  'compute.zones.get',
  'compute.zones.list',
  'compute.machineTypes.get',
  'compute.machineTypes.list',
  'compute.networks.list',
  'compute.subnetworks.list',
  'compute.firewalls.list',
  'compute.routers.list',
  'compute.disks.list',
  'compute.instances.list',
  'compute.snapshots.list',
  'compute.images.get',
  'compute.images.list',
  'compute.images.useReadOnly',
  'compute.zoneOperations.get',
  'compute.regionOperations.get',
  'compute.globalOperations.get',
] as const;

const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const CRM_ROOT = 'https://cloudresourcemanager.googleapis.com/v1/projects';
const COMPUTE_ROOT = 'https://compute.googleapis.com/compute/v1/projects';

export function hostedGcpWorkspaceProject(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const project = env[HOSTED_GCP_WORKSPACE_PROJECT_ENV]?.trim();
  if (!project) throw new Error('gcp_workspace_host_papercusp_hosting_project_unconfigured');
  if (!GCP_PROJECT_ID.test(project)) throw new Error('gcp_workspace_host_papercusp_hosting_project_invalid');
  return project;
}

export interface PapercuspHostingCondition {
  title: string;
  description: string;
  expression: string;
}

/**
 * The condition that confines a grant to one host: every collection a host creates in,
 * matched by the host's own name prefix. 8 clauses = 7 logical operators (GCP allows 12).
 */
export function papercuspHostingCondition(projectId: string, hostId: string): PapercuspHostingCondition {
  const { region, zone } = PAPERCUSP_HOSTED_GCP_LOCATION;
  const names = gcpWorkspaceHostNamePrefixes(hostId);
  const base = `projects/${projectId}`;
  const prefixes = [
    `${base}/global/networks/${names.resource}`,
    `${base}/regions/${region}/subnetworks/${names.resource}`,
    `${base}/global/firewalls/${names.resource}`,
    `${base}/regions/${region}/routers/${names.resource}`,
    `${base}/zones/${zone}/instances/${names.resource}`,
    `${base}/zones/${zone}/disks/${names.resource}`,
    `${base}/global/snapshots/${names.snapshot}`,
    `${base}/global/snapshots/${names.destroySnapshot}`,
  ];
  return {
    title: `papercusp-host ${hostId}`.slice(0, 100),
    description: `D-399: only the resources of Papercusp-hosted workspace host ${hostId}`,
    expression: prefixes.map((prefix) => `resource.name.startsWith('${prefix}')`).join(' || '),
  };
}

interface IamBinding {
  role: string;
  members: string[];
  condition?: { title?: string; description?: string; expression: string };
}

interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
  [key: string]: unknown;
}

/**
 * The bindings `member` should end up with: the observer role, plus exactly ONE host-role
 * binding naming `hostId`. Any earlier host binding for the member (a destroyed host's) is
 * removed, so an organization never holds two reservations. Returns null when the policy
 * already says exactly that.
 */
export function papercuspHostingBindings(
  bindings: readonly IamBinding[],
  input: { projectId: string; member: string; hostId: string },
): IamBinding[] | null {
  const observerRole = `projects/${input.projectId}/roles/${PAPERCUSP_HOSTED_OBSERVER_ROLE_ID}`;
  const hostRole = `projects/${input.projectId}/roles/${PAPERCUSP_HOSTED_HOST_ROLE_ID}`;
  const condition = papercuspHostingCondition(input.projectId, input.hostId);
  const observed = bindings.some(
    (binding) => binding.role === observerRole && !binding.condition && binding.members.includes(input.member),
  );
  const held = bindings.filter((binding) => binding.role === hostRole && binding.members.includes(input.member));
  if (
    observed &&
    held.length === 1 &&
    held[0]!.members.length === 1 &&
    held[0]!.condition?.expression === condition.expression
  ) {
    return null;
  }
  const next: IamBinding[] = [];
  for (const binding of bindings) {
    if (binding.role === hostRole && binding.members.includes(input.member)) {
      const members = binding.members.filter((member) => member !== input.member);
      if (members.length > 0) next.push({ ...binding, members });
      continue;
    }
    if (binding.role === observerRole && !binding.condition && !binding.members.includes(input.member)) {
      next.push({ ...binding, members: [...binding.members, input.member] });
      continue;
    }
    next.push(binding);
  }
  if (!observed && !next.some((binding) => binding.role === observerRole && !binding.condition)) {
    next.push({ role: observerRole, members: [input.member] });
  }
  next.push({ role: hostRole, members: [input.member], condition });
  return next;
}

export interface EnsurePapercuspHostingGrantInput {
  projectId: string;
  /** IAM member form of the organization's own account. */
  member: string;
  hostId: string;
  /** A token for an identity allowed to set THESE two roles on the hosting project. */
  accessToken(): Promise<string>;
  fetch?: typeof fetch;
}

/**
 * Write the organization's reservation into the hosting project's IAM policy. Read-modify-
 * write under the policy etag: a concurrent writer (another organization signing up) makes
 * GCP answer 409, and the whole read is retried so neither write is lost.
 */
export async function ensurePapercuspHostingGrant(input: EnsurePapercuspHostingGrantInput): Promise<void> {
  const fetchImpl = input.fetch ?? fetch;
  const project = encodeURIComponent(input.projectId);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const headers = { authorization: `Bearer ${await input.accessToken()}`, 'content-type': 'application/json' };
    const read = await fetchImpl(`${CRM_ROOT}/${project}:getIamPolicy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
    });
    if (!read.ok) {
      throw new Error(`gcp_workspace_host_papercusp_hosting_policy_read_failed:${read.status}:${await responseExcerpt(read)}`);
    }
    const policy = (await read.json()) as IamPolicy;
    const bindings = papercuspHostingBindings(policy.bindings ?? [], input);
    if (!bindings) return;
    const write = await fetchImpl(`${CRM_ROOT}/${project}:setIamPolicy`, {
      method: 'POST',
      headers,
      // Version 3 is required for any policy that carries a condition.
      body: JSON.stringify({ policy: { ...policy, version: 3, bindings } }),
    });
    if (write.ok) return;
    if (write.status !== 409) {
      const excerpt = await responseExcerpt(write);
      const message = `gcp_workspace_host_papercusp_hosting_policy_write_failed:${write.status}:${excerpt}`;
      // Measured: an organization account created a second earlier is refused as nonexistent on
      // about half of first binds (.papercusp/scratch/d399-bind-repro.log). IAM catches up.
      if (write.status === 400 && /service account .* does not exist/i.test(excerpt)) {
        throw new HostedGcpNotReadyError(message);
      }
      throw new Error(message);
    }
  }
  throw new Error('gcp_workspace_host_papercusp_hosting_policy_contended');
}

/**
 * GCP has not caught up with a change Papercusp just made (a new organization account, a
 * rate-limited creation). Nothing is wrong and nothing is owed by the customer: the same call
 * succeeds shortly, so callers report "still preparing" rather than a failure.
 */
export class HostedGcpNotReadyError extends Error {
  override readonly name = 'HostedGcpNotReadyError';
}

/** GCP's error text, bounded: the status alone cannot tell a propagation lag from a denial. */
async function responseExcerpt(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Whether the reservation is IN FORCE for the organization's token yet. A new binding takes
 * one to two minutes to propagate. Reading the reserved instance answers without creating
 * anything: 404 means the permission is effective and the host does not exist yet, 200 that
 * it exists, 403 that the grant has not propagated.
 */
export async function papercuspHostingGrantEffective(input: {
  projectId: string;
  hostId: string;
  accessToken: string;
  fetch?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = input.fetch ?? fetch;
  const instance = `${gcpWorkspaceHostNamePrefixes(input.hostId).resource}vm`;
  const { zone } = PAPERCUSP_HOSTED_GCP_LOCATION;
  const response = await fetchImpl(
    `${COMPUTE_ROOT}/${encodeURIComponent(input.projectId)}/zones/${zone}/instances/${instance}?fields=name`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (response.status === 200 || response.status === 404) return true;
  if (response.status === 403) return false;
  throw new Error(`gcp_workspace_host_papercusp_hosting_probe_failed:${response.status}`);
}
