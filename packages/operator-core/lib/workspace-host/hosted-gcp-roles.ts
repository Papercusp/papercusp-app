/**
 * The two Papercusp-hosted custom roles (D-399), DERIVED from the code constants rather than
 * hand-maintained in the cloud console (WI-10005251).
 *
 * The permission lists in hosted-gcp-hosting.ts were the only definition of what an
 * organization's account may do, but nothing wrote them to GCP: the live roles were created by
 * hand, and when WI-10005210 added `compute.instances.setScheduling` to the code, the live HOST
 * role silently kept 38 permissions. A hosted spot create would have been refused by GCP while
 * the code and its unit tests said the role covered it (measured 2026-10-02 03:15Z).
 *
 * Two halves, deliberately held by different identities:
 * - ATTEST ({@link runPapercuspHostedRoleAttestation}): the control plane reads both roles on the
 *   standing health cadence and files one finding per drifted role. Reading needs only
 *   `iam.roles.get` on the hosting project (`roles/iam.roleViewer` on the delegation source).
 * - DERIVE ({@link reconcilePapercuspHostedRoles}): set each role to exactly its code list,
 *   creating or undeleting it when needed. That needs `iam.roles.create/update/undelete`, and it
 *   runs under an OPERATOR identity (scripts/workspace-host/reconcile-hosted-gcp-roles.ts), never
 *   the control plane's: the control plane may already GRANT these two roles to any organization
 *   account, so letting it also REDEFINE them would let it widen every grant it hands out (for
 *   example by adding `iam.serviceAccounts.actAs`, which the HOST role deliberately lacks).
 *
 * Drift in either direction counts. A MISSING permission breaks a provider feature; an EXTRA one
 * means the live grant is wider than the reviewed code, which is the security-relevant case.
 */
import {
  PAPERCUSP_HOSTED_HOST_PERMISSIONS,
  PAPERCUSP_HOSTED_HOST_ROLE_ID,
  PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS,
  PAPERCUSP_HOSTED_OBSERVER_ROLE_ID,
} from './hosted-gcp-hosting';

const IAM_ROOT = 'https://iam.googleapis.com/v1/projects';

export interface PapercuspHostedRoleSpec {
  roleId: string;
  title: string;
  description: string;
  permissions: readonly string[];
}

/** What each live role must be. Titles and descriptions are used only when a role is created. */
export const PAPERCUSP_HOSTED_ROLE_SPECS: readonly PapercuspHostedRoleSpec[] = [
  {
    roleId: PAPERCUSP_HOSTED_HOST_ROLE_ID,
    title: 'Papercusp hosted workspace host',
    description: 'D-399: see packages/operator-core/lib/workspace-host/hosted-gcp-hosting.ts',
    permissions: PAPERCUSP_HOSTED_HOST_PERMISSIONS,
  },
  {
    roleId: PAPERCUSP_HOSTED_OBSERVER_ROLE_ID,
    title: 'Papercusp hosted workspace observer',
    description: 'D-399: see packages/operator-core/lib/workspace-host/hosted-gcp-hosting.ts',
    permissions: PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS,
  },
];

/** A live custom role as GCP returns it, reduced to what the reconcile needs. */
export interface PapercuspHostedLiveRole {
  includedPermissions: string[];
  etag: string | null;
  /** GCP keeps a deleted custom role for 7 days; it grants nothing until undeleted. */
  deleted: boolean;
}

export interface PapercuspHostedRoleDrift {
  roleId: string;
  /** No role by this id (never created, or purged after deletion). */
  absent: boolean;
  /** The role exists but is soft-deleted, so its bindings grant nothing. */
  deleted: boolean;
  /** In code, not in the live role: a provider feature that GCP will refuse. */
  missing: string[];
  /** In the live role, not in code: a grant wider than the reviewed code. */
  extra: string[];
}

export function papercuspHostedRoleDrift(
  spec: PapercuspHostedRoleSpec,
  live: PapercuspHostedLiveRole | null,
): PapercuspHostedRoleDrift {
  if (!live) return { roleId: spec.roleId, absent: true, deleted: false, missing: [...spec.permissions].sort(), extra: [] };
  const held = new Set(live.includedPermissions);
  const wanted = new Set(spec.permissions);
  return {
    roleId: spec.roleId,
    absent: false,
    deleted: live.deleted,
    missing: [...wanted].filter((permission) => !held.has(permission)).sort(),
    extra: [...held].filter((permission) => !wanted.has(permission)).sort(),
  };
}

export function papercuspHostedRoleDrifted(drift: PapercuspHostedRoleDrift): boolean {
  return drift.absent || drift.deleted || drift.missing.length > 0 || drift.extra.length > 0;
}

/** A GCP call that answered with a status other than the ones the caller handles. */
export class PapercuspHostedRoleApiError extends Error {
  override readonly name = 'PapercuspHostedRoleApiError';
  constructor(
    readonly operation: string,
    readonly status: number,
    excerpt: string,
  ) {
    super(`gcp_papercusp_hosted_role_${operation}_failed:${status}:${excerpt}`);
  }
}

async function excerpt(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    return '';
  }
}

interface RoleCallInput {
  projectId: string;
  accessToken: string;
  fetch?: typeof fetch;
}

function roleUrl(projectId: string, roleId: string, suffix = ''): string {
  return `${IAM_ROOT}/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}${suffix}`;
}

function headers(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
}

/** Read one role, or null when no role by that id exists. */
export async function readPapercuspHostedRole(input: RoleCallInput & { roleId: string }): Promise<PapercuspHostedLiveRole | null> {
  const fetchImpl = input.fetch ?? fetch;
  const response = await fetchImpl(roleUrl(input.projectId, input.roleId), { headers: headers(input.accessToken) });
  if (response.status === 404) return null;
  if (!response.ok) throw new PapercuspHostedRoleApiError('read', response.status, await excerpt(response));
  const role = (await response.json()) as { includedPermissions?: string[]; etag?: string; deleted?: boolean };
  return { includedPermissions: role.includedPermissions ?? [], etag: role.etag ?? null, deleted: role.deleted === true };
}

/** Read both roles and diff them against code. Read-only: needs `iam.roles.get` and nothing else. */
export async function attestPapercuspHostedRoles(input: RoleCallInput): Promise<PapercuspHostedRoleDrift[]> {
  const drifts: PapercuspHostedRoleDrift[] = [];
  for (const spec of PAPERCUSP_HOSTED_ROLE_SPECS) {
    drifts.push(papercuspHostedRoleDrift(spec, await readPapercuspHostedRole({ ...input, roleId: spec.roleId })));
  }
  return drifts;
}

export interface PapercuspHostedRoleReconcileOutcome {
  roleId: string;
  /** The drift read before any change. */
  before: PapercuspHostedRoleDrift;
  action: 'unchanged' | 'would-change' | 'created' | 'updated' | 'undeleted-and-updated';
}

/**
 * Set each role to exactly its code list. Dry run unless `apply`. The update is a read-modify-
 * write under the role's etag, so a concurrent hand edit makes GCP refuse the write (409/412)
 * and the role is re-read rather than overwritten blind.
 */
export async function reconcilePapercuspHostedRoles(
  input: RoleCallInput & { apply: boolean },
): Promise<PapercuspHostedRoleReconcileOutcome[]> {
  const fetchImpl = input.fetch ?? fetch;
  const outcomes: PapercuspHostedRoleReconcileOutcome[] = [];
  for (const spec of PAPERCUSP_HOSTED_ROLE_SPECS) {
    let before: PapercuspHostedRoleDrift | null = null;
    let action: PapercuspHostedRoleReconcileOutcome['action'] | null = null;
    for (let attempt = 1; attempt <= 3 && !action; attempt += 1) {
      const live = await readPapercuspHostedRole({ ...input, fetch: fetchImpl, roleId: spec.roleId });
      const drift = papercuspHostedRoleDrift(spec, live);
      before ??= drift;
      // On a retry this means a concurrent writer already set the code list: still unchanged by us.
      if (!papercuspHostedRoleDrifted(drift)) {
        action = 'unchanged';
        break;
      }
      if (!input.apply) {
        action = 'would-change';
        break;
      }
      if (!live) {
        const created = await fetchImpl(`${IAM_ROOT}/${encodeURIComponent(input.projectId)}/roles`, {
          method: 'POST',
          headers: headers(input.accessToken),
          body: JSON.stringify({
            roleId: spec.roleId,
            role: { title: spec.title, description: spec.description, stage: 'GA', includedPermissions: [...spec.permissions] },
          }),
        });
        if (created.ok) action = 'created';
        else if (created.status !== 409) throw new PapercuspHostedRoleApiError('create', created.status, await excerpt(created));
        continue;
      }
      let etag = live.etag;
      let undeleted = false;
      if (live.deleted) {
        const restored = await fetchImpl(roleUrl(input.projectId, spec.roleId, ':undelete'), {
          method: 'POST',
          headers: headers(input.accessToken),
          body: JSON.stringify(etag ? { etag } : {}),
        });
        if (!restored.ok) {
          if (restored.status === 409 || restored.status === 412) continue;
          throw new PapercuspHostedRoleApiError('undelete', restored.status, await excerpt(restored));
        }
        etag = ((await restored.json()) as { etag?: string }).etag ?? null;
        undeleted = true;
      }
      const updated = await fetchImpl(roleUrl(input.projectId, spec.roleId, '?updateMask=includedPermissions'), {
        method: 'PATCH',
        headers: headers(input.accessToken),
        body: JSON.stringify({ includedPermissions: [...spec.permissions], ...(etag ? { etag } : {}) }),
      });
      if (updated.ok) action = undeleted ? 'undeleted-and-updated' : 'updated';
      else if (updated.status !== 409 && updated.status !== 412) {
        throw new PapercuspHostedRoleApiError('update', updated.status, await excerpt(updated));
      }
    }
    if (!action) throw new Error(`gcp_papercusp_hosted_role_contended:${spec.roleId}`);
    outcomes.push({ roleId: spec.roleId, before: before!, action });
  }
  return outcomes;
}

/** The operator command that repairs drift (DERIVE). Quoted in every finding. */
export function papercuspHostedRoleRepairCommand(projectId: string): string {
  return `npx tsx scripts/workspace-host/reconcile-hosted-gcp-roles.ts --project=${projectId} --apply`;
}

export function papercuspHostedRoleWatchdogKey(projectId: string, roleId: string): string {
  return `hosted-gcp-role-drift:${projectId}:${roleId}`;
}

export function papercuspHostedRoleAttestationUnreadableKey(projectId: string): string {
  return `hosted-gcp-role-attestation-unreadable:${projectId}`;
}

export interface PapercuspHostedRoleFinding {
  watchdogKey: string;
  title: string;
  body: string;
}

export function papercuspHostedRoleDriftFinding(projectId: string, drift: PapercuspHostedRoleDrift): PapercuspHostedRoleFinding {
  const state = drift.absent ? 'does not exist' : drift.deleted ? 'is deleted' : 'differs from code';
  const lines = [
    `The live custom role projects/${projectId}/roles/${drift.roleId} ${state}.`,
    `missing (in code, not live; GCP refuses these provider calls): ${drift.missing.length ? drift.missing.join(', ') : 'none'}`,
    `extra (live, not in code; the grant is wider than the reviewed code): ${drift.extra.length ? drift.extra.join(', ') : 'none'}`,
    '',
    'Source of truth: PAPERCUSP_HOSTED_HOST_PERMISSIONS / PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS in',
    'packages/operator-core/lib/workspace-host/hosted-gcp-hosting.ts (WI-10005251).',
    `Repair under an operator identity that holds iam.roles.update (dry run first, without --apply):`,
    `  ${papercuspHostedRoleRepairCommand(projectId)}`,
    'If the live permission is the intended one, add it to the code constant instead and redeploy.',
    'Filed by the standing workspace-host health pass; it re-files only after this item is closed.',
  ];
  return {
    watchdogKey: papercuspHostedRoleWatchdogKey(projectId, drift.roleId),
    title: `Papercusp-hosted GCP role ${drift.roleId} has drifted from code`,
    body: lines.join('\n'),
  };
}

export interface PapercuspHostedRoleAttestationRuntime {
  /** The hosting project, or null when this controller does not run Papercusp-hosted hosts. */
  projectId: string | null;
  accessToken(): Promise<string>;
  fetch?: typeof fetch;
  openFindingExists(watchdogKey: string): Promise<boolean>;
  fileFinding(finding: PapercuspHostedRoleFinding): Promise<void>;
}

export type PapercuspHostedRoleAttestationResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'attested'; projectId: string; drifts: PapercuspHostedRoleDrift[]; filed: string[] }
  | { kind: 'read-failed'; projectId: string; error: string; filed: string[] };

/**
 * One standing attestation. Never throws: a failure is the result, so the health tick that runs
 * it is never broken by it. A permission refusal (401/403) is itself filed, because it means the
 * detector is blind, which is exactly how this drift went unseen; other read failures are left to
 * the next tick.
 */
export async function runPapercuspHostedRoleAttestation(
  runtime: PapercuspHostedRoleAttestationRuntime,
): Promise<PapercuspHostedRoleAttestationResult> {
  const projectId = runtime.projectId;
  if (!projectId) return { kind: 'skipped', reason: 'no Papercusp hosting project configured' };
  const filed: string[] = [];
  const file = async (finding: PapercuspHostedRoleFinding) => {
    if (await runtime.openFindingExists(finding.watchdogKey)) return;
    await runtime.fileFinding(finding);
    filed.push(finding.watchdogKey);
  };
  let drifts: PapercuspHostedRoleDrift[];
  try {
    drifts = await attestPapercuspHostedRoles({ projectId, accessToken: await runtime.accessToken(), fetch: runtime.fetch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PapercuspHostedRoleApiError && (error.status === 401 || error.status === 403)) {
      try {
        await file({
          watchdogKey: papercuspHostedRoleAttestationUnreadableKey(projectId),
          title: `Cannot attest the Papercusp-hosted GCP roles in ${projectId}: role read refused`,
          body: [
            `The standing role attestation (WI-10005251) could not read the hosted roles: ${message}`,
            'Until it can, the live roles can drift from the code constants unnoticed.',
            `Grant the control plane's delegation source read-only access to role definitions:`,
            `  gcloud projects add-iam-policy-binding ${projectId} --member=serviceAccount:<delegation source> --role=roles/iam.roleViewer`,
          ].join('\n'),
        });
      } catch (fileError) {
        return { kind: 'read-failed', projectId, error: `${message}; filing failed: ${String(fileError)}`, filed };
      }
    }
    return { kind: 'read-failed', projectId, error: message, filed };
  }
  for (const drift of drifts) {
    if (!papercuspHostedRoleDrifted(drift)) continue;
    try {
      await file(papercuspHostedRoleDriftFinding(projectId, drift));
    } catch (error) {
      console.warn(`[hosted-gcp-roles] filing drift for ${drift.roleId} failed: ${String(error)}`);
    }
  }
  return { kind: 'attested', projectId, drifts, filed };
}

/** A one-line summary for the health tick's log, or null when both roles match code. */
export function papercuspHostedRoleAttestationSummary(result: PapercuspHostedRoleAttestationResult): string | null {
  if (result.kind === 'skipped') return null;
  if (result.kind === 'read-failed') return `[hosted-gcp-roles] ${result.projectId}: attestation read failed: ${result.error}`;
  const drifted = result.drifts.filter(papercuspHostedRoleDrifted);
  if (drifted.length === 0) return null;
  const parts = drifted.map(
    (drift) =>
      `${drift.roleId}${drift.absent ? ' absent' : ''}${drift.deleted ? ' deleted' : ''}` +
      ` missing=[${drift.missing.join(',')}] extra=[${drift.extra.join(',')}]`,
  );
  return `[hosted-gcp-roles] ${result.projectId}: DRIFT ${parts.join(' | ')}${result.filed.length ? ` (filed ${result.filed.length})` : ''}`;
}
