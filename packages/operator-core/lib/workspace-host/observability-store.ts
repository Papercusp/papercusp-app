import { randomUUID } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { assertWorkspaceHostDomainState, assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';
import type {
  WorkspaceHostControllerAuthority,
  WorkspaceHostProviderConnection,
  WorkspaceHostDesiredSpec,
  WorkspaceHostDomainState,
  WorkspaceHostHealthAttestation,
  WorkspaceHostImageRef,
  WorkspaceHostLifecycleAction,
  WorkspaceHostObservation,
  WorkspaceHostRuntimeRelease,
  WorkspaceHostResourceCheckpoint,
  WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import { notifySyncInvalidate } from '../sync-sse';

export const WORKSPACE_HOST_CONTROL_QUERY = 'workspaceHosts.control';

type JsonRecord = Record<string, unknown>;
type ConnectionStatus = 'connected' | 'degraded' | 'invalid';
type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed';
type TimelineLevel = 'info' | 'warn' | 'error';
type LogStream = 'cloud-init' | 'systemd' | 'controller';

function lifecycleActionInvalidatesHealth(action: WorkspaceHostLifecycleAction): boolean {
  return action === 'start' || action === 'stop' || action === 'restart';
}

export class WorkspaceHostControllerFenceError extends Error {
  constructor(readonly hostId: string) {
    super(`workspace-host controller authority or host generation is stale for '${hostId}'`);
    this.name = 'WorkspaceHostControllerFenceError';
  }
}

/**
 * WI-10005312: `error.code` of the terminal row recorded when the fence refuses an operation
 * before it began. Without it, a request already answered 202 had no row at all, so the
 * timeline it was pointed at could never show the failure. A refused row never ran on the
 * host: it never holds authority, never counts as a prior operation, and never displaces an
 * in-flight operation as the host's current progress.
 */
export const WORKSPACE_HOST_FENCE_REFUSED_CODE = 'controller_fence_refused';

const SECRET_KEY = /(?:authorization|cookie|password|passphrase|secret|token|private.?key|access.?key)/i;
const SAFE_REFERENCE_KEY = /(?:credential|secret|token|key)ref$/i;
const PRIVATE_KEY = /-----BEGIN [^-\n]*(?:PRIVATE KEY|SECRET)[^-\n]*-----[\s\S]*?-----END [^-\n]*-----/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+@/gi;
const SENSITIVE_QUERY = /([?&](?:access_token|api_key|client_secret|password|signature|token)=)[^&#\s]+/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactWorkspaceHostText(value: string): string {
  return value
    .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(BEARER, '$1 [REDACTED]')
    .replace(URL_PASSWORD, '$1[REDACTED]@')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(AWS_ACCESS_KEY, '[REDACTED AWS ACCESS KEY]')
    .replace(JWT, '[REDACTED JWT]');
}

/** Redact before persistence. Audit export applies this again as defense in depth. */
export function redactWorkspaceHostValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactWorkspaceHostText(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  // An Error's `name`/`message`/`stack`/`cause` are NON-ENUMERABLE, so the generic Object.entries()
  // branch below builds `{}` from one and silently destroys the only diagnostic a failed operation
  // has. That is not hypothetical: callers such as initialization-runner deliberately pass the
  // thrown reason ONLY through `error` so it can be redacted here rather than interpolated into a
  // human-facing message, and every one of those failures persisted as `error: {}`. Project the
  // non-enumerable fields explicitly — still redacted — and keep any own enumerable properties the
  // thrower attached (`code`, `status`, ...).
  if (value instanceof Error) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const error: JsonRecord = {
      name: redactWorkspaceHostText(value.name),
      message: redactWorkspaceHostText(value.message),
    };
    if (typeof value.stack === 'string') error.stack = redactWorkspaceHostText(value.stack);
    if (value.cause !== undefined) error.cause = redactWorkspaceHostValue(value.cause, seen);
    for (const [key, entry] of Object.entries(value as unknown as JsonRecord)) {
      if (key in error) continue;
      error[key] =
        SECRET_KEY.test(key) && !SAFE_REFERENCE_KEY.test(key) ? '[REDACTED]' : redactWorkspaceHostValue(entry, seen);
    }
    seen.delete(value);
    return error;
  }
  if (Array.isArray(value)) return value.map((entry) => redactWorkspaceHostValue(entry, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    out[key] =
      SECRET_KEY.test(key) && !SAFE_REFERENCE_KEY.test(key) ? '[REDACTED]' : redactWorkspaceHostValue(entry, seen);
  }
  seen.delete(value);
  return out;
}

function json(value: unknown): unknown {
  return value == null ? null : redactWorkspaceHostValue(value);
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function credentialReferenceDisplay(value: string): string {
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? 'resolver';
  return `${scheme}://[configured]`;
}

async function pushControl(): Promise<void> {
  await notifySyncInvalidate(WORKSPACE_HOST_CONTROL_QUERY);
}

/**
 * Run a workspace-host read/write against an already-authenticated transaction
 * when the caller owns one (the hosted browser path), otherwise preserve the
 * ordinary workspace wrapper used by local/desktop callers.
 *
 * The hosted RLS policies need `app.organization_id`, `app.workspace_id`, and
 * `SET LOCAL ROLE hosted_app` from `withTenantContext`. Opening a nested
 * `withWorkspace` transaction here would erase that scope and silently turn a
 * correctly authenticated hosted request into an empty result. Keeping this
 * tiny seam in the store lets both profiles share the exact SQL projection.
 */
function inWorkspace<T>(workspaceId: string, tx: Sql | undefined, fn: (query: Sql) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : withWorkspace(workspaceId, fn);
}

async function requireWorkspaceHostControllerAuthority(
  query: Sql,
  workspaceId: string,
  hostId: string,
  operationId: string | undefined,
  authority: WorkspaceHostControllerAuthority | undefined,
): Promise<void> {
  if (!authority) return;
  const rows = await query<Array<{ id: string }>>`
    SELECT host.id
    FROM harness_shared.workspace_hosts AS host
    WHERE host.workspace_id = ${workspaceId}
      AND host.id = ${hostId}
      AND host.controller_id = ${authority.controllerId}
      AND host.controller_fence = ${authority.fence}
      AND (
        ${operationId ?? null}::text IS NULL
        OR EXISTS (
          SELECT 1
          FROM harness_shared.workspace_host_operations AS operation
          WHERE operation.workspace_id = host.workspace_id
            AND operation.id = ${operationId ?? null}
            AND operation.host_id = host.id
            AND operation.controller_id = host.controller_id
            AND operation.controller_fence = host.controller_fence
            AND operation.desired_revision = host.desired_revision
            -- A refused operation never held authority, even when its stale request happens
            -- to name the host's current controller and revision (WI-10005312).
            AND operation.error->>'code' IS DISTINCT FROM ${WORKSPACE_HOST_FENCE_REFUSED_CODE}
        )
      )
    FOR SHARE OF host
  `;
  if (!rows[0]) throw new WorkspaceHostControllerFenceError(hostId);
}

export interface WorkspaceHostConnectionInput {
  workspaceId: string;
  id: string;
  target: string;
  label: string;
  credentialRef: string;
  /** Non-secret metadata required to resolve the opaque credential reference. */
  provider?: Readonly<Record<string, unknown>>;
  status: ConnectionStatus;
  /** Non-secret principal proved by the latest successful provider validation. */
  authenticatedIdentity?: string;
  statusDetail?: string;
  lastValidatedAt?: string;
  scopes?: readonly unknown[];
  regions?: readonly unknown[];
  sizes?: readonly unknown[];
  images?: readonly unknown[];
  networks?: readonly unknown[];
  diskPricePerGiBMonth?: number;
}

export async function upsertWorkspaceHostConnection(input: WorkspaceHostConnectionInput, tx?: Sql): Promise<void> {
  assertWorkspaceHostSecretIsolation(input.provider, 'workspaceHost.connection.provider');
  const providerConfig = json(input.provider ?? {});
  await inWorkspace(input.workspaceId, tx, async (query) => {
    await query`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref, provider_config, status, authenticated_identity, status_detail,
        last_validated_at, scopes, regions, sizes, images, networks,
        disk_price_per_gib_month, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.id}, ${input.target}, ${input.label},
        ${input.credentialRef}, ${query.json(providerConfig as never)}, ${input.status},
        ${input.authenticatedIdentity?.trim() || null}, ${input.statusDetail ?? null},
        ${input.lastValidatedAt ?? null}, ${query.json(json(input.scopes ?? []) as never)},
        ${query.json(json(input.regions ?? []) as never)}, ${query.json(json(input.sizes ?? []) as never)},
        ${query.json(json(input.images ?? []) as never)}, ${query.json(json(input.networks ?? []) as never)},
        ${input.diskPricePerGiBMonth ?? null}, now()
      )
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        target = EXCLUDED.target,
        label = EXCLUDED.label,
        credential_ref = EXCLUDED.credential_ref,
        provider_config = EXCLUDED.provider_config,
        status = EXCLUDED.status,
        -- A failed/transport-class refresh proves no replacement identity. Preserve the last
        -- authenticated principal unless a successful validation supplied a new one.
        authenticated_identity = COALESCE(EXCLUDED.authenticated_identity, harness_shared.workspace_host_connections.authenticated_identity),
        status_detail = EXCLUDED.status_detail,
        last_validated_at = EXCLUDED.last_validated_at,
        scopes = EXCLUDED.scopes,
        regions = EXCLUDED.regions,
        sizes = EXCLUDED.sizes,
        images = EXCLUDED.images,
        networks = EXCLUDED.networks,
        disk_price_per_gib_month = EXCLUDED.disk_price_per_gib_month,
        updated_at = now()
    `;
  });
}

export interface StoredWorkspaceHostConnection {
  id: string;
  label?: string;
  target: string;
  status: ConnectionStatus;
  authenticatedIdentity?: string;
  statusDetail?: string;
  connection: WorkspaceHostProviderConnection;
}

/** Read the exact credential reference selected by a provisioning request. */
export async function readWorkspaceHostConnection(
  workspaceId: string,
  connectionId: string,
  tx?: Sql,
): Promise<StoredWorkspaceHostConnection | null> {
  return inWorkspace(workspaceId, tx, async (query) => {
    const rows = await query<
      Array<{
        id: string;
        label: string;
        target: string;
        credential_ref: string;
        provider_config: JsonRecord;
        status: ConnectionStatus;
        authenticated_identity: string | null;
        status_detail: string | null;
      }>
    >`
      SELECT id, label, target, credential_ref, provider_config, status, authenticated_identity, status_detail
      FROM harness_shared.workspace_host_connections
      WHERE workspace_id = ${workspaceId} AND id = ${connectionId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      target: row.target,
      status: row.status,
      ...(row.authenticated_identity ? { authenticatedIdentity: row.authenticated_identity } : {}),
      ...(row.status_detail ? { statusDetail: row.status_detail } : {}),
      connection: {
        target: row.target,
        cloudCredentialRef: { kind: 'cloud', ref: row.credential_ref },
        ...(Object.keys(row.provider_config ?? {}).length > 0 ? { provider: row.provider_config } : {}),
      },
    };
  });
}

/**
 * Hosts on one connection that still hold — or are acquiring — cloud resources: every host whose
 * desired state is not `absent`. `destroying` counts (its resources still exist), and a NULL state
 * counts too, so an unreadable row can never make room under a cap. Feeds the per-connection
 * instance cap (`instance-cap.ts`, aws-byoc-gcp-parity-2026-10-01 P-007).
 */
export async function listLiveWorkspaceHostIdsOnConnection(
  workspaceId: string,
  connectionId: string,
  tx?: Sql,
): Promise<string[]> {
  return inWorkspace(workspaceId, tx, async (query) => {
    const rows = await query<Array<{ id: string }>>`
      SELECT id
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId}
        AND connection_id = ${connectionId}
        AND desired_state IS DISTINCT FROM 'absent'
      ORDER BY created_at, id
    `;
    return rows.map((row) => row.id);
  });
}

export interface WorkspaceHostInput {
  workspaceId: string;
  id: string;
  name: string;
  connectionId: string;
  target: string;
  scopeLabel: string;
  region: string;
  size: string;
  image: string;
  diskGiB: number;
  network: string;
  estimatedMonthlyUsd?: number;
  desiredState: string;
  observedState: string;
  /** Defaults support expand-first rollout; explicit values are validated as one domain state. */
  hostGeneration?: number;
  desiredRevision?: number;
  observedRevision?: number;
  runtimeRelease?: WorkspaceHostRuntimeRelease;
  controllerAuthority?: WorkspaceHostControllerAuthority;
  observedAt?: string;
  endpoint?: string;
  recoverability?: { kind: 'snapshot' | 'backup' | 'none'; label: string; updatedAt?: string };
  /**
   * The provisioning intent this host was created from (migration 956).
   *
   * Recorded by the provisioner so later lifecycle actions — initialization above all — can
   * recover WHICH cloud instance this host is instead of re-deriving it from the observed
   * columns. Omitting it on a later upsert PRESERVES the stored spec rather than clearing it:
   * an observation refresh must never erase provisioning intent.
   */
  desiredSpec?: WorkspaceHostDesiredSpec;
}

export async function upsertWorkspaceHost(input: WorkspaceHostInput): Promise<void> {
  const recoverability = input.recoverability ?? { kind: 'none' as const, label: 'No recovery point recorded' };
  // Credential REFERENCES are expected here; credential MATERIAL never is. Asserting before the
  // write means a spec carrying secret material fails loudly at the boundary instead of being
  // persisted and later exported by the audit route.
  if (input.desiredSpec) assertWorkspaceHostSecretIsolation(input.desiredSpec, 'workspaceHost.desiredSpec');
  const hostGeneration = input.hostGeneration ?? 1;
  const desiredRevision = input.desiredRevision ?? 1;
  const observedRevision = input.observedRevision ?? 0;
  assertWorkspaceHostDomainState({
    workspaceId: input.workspaceId,
    hostId: input.id,
    hostGeneration,
    connectionId: input.connectionId,
    desiredRevision,
    observedRevision,
    ...(input.runtimeRelease ? { runtimeRelease: input.runtimeRelease } : {}),
    ...(input.controllerAuthority ? { controllerAuthority: input.controllerAuthority } : {}),
  });
  const desiredSpec = input.desiredSpec ? JSON.stringify(input.desiredSpec) : null;
  await withWorkspace(input.workspaceId, async (tx) => {
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO harness_shared.workspace_hosts (
        workspace_id, id, name, connection_id, target, scope_label, region, size,
        image, disk_gib, network, estimated_monthly_usd, desired_state,
        observed_state, observed_at, endpoint, recoverability_kind,
        recoverability_label, recoverability_updated_at, desired_spec,
        host_generation, desired_revision, observed_revision, runtime_release,
        controller_id, controller_fence, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.id}, ${input.name}, ${input.connectionId},
        ${input.target}, ${input.scopeLabel}, ${input.region}, ${input.size},
        ${input.image}, ${input.diskGiB}, ${input.network}, ${input.estimatedMonthlyUsd ?? null},
        ${input.desiredState}, ${input.observedState}, ${input.observedAt ?? null},
        ${input.endpoint ?? null}, ${recoverability.kind}, ${recoverability.label},
        ${recoverability.updatedAt ?? null}, ${desiredSpec}::jsonb,
        ${hostGeneration}, ${desiredRevision}, ${observedRevision},
        ${input.runtimeRelease === undefined ? null : tx.json(input.runtimeRelease as never)},
        ${input.controllerAuthority?.controllerId ?? null}, ${input.controllerAuthority?.fence ?? 0}, now()
      )
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        name = EXCLUDED.name,
        connection_id = EXCLUDED.connection_id,
        target = EXCLUDED.target,
        scope_label = EXCLUDED.scope_label,
        region = EXCLUDED.region,
        size = EXCLUDED.size,
        image = EXCLUDED.image,
        disk_gib = EXCLUDED.disk_gib,
        network = EXCLUDED.network,
        estimated_monthly_usd = EXCLUDED.estimated_monthly_usd,
        desired_state = EXCLUDED.desired_state,
        observed_state = EXCLUDED.observed_state,
        observed_at = EXCLUDED.observed_at,
        endpoint = EXCLUDED.endpoint,
        recoverability_kind = EXCLUDED.recoverability_kind,
        recoverability_label = EXCLUDED.recoverability_label,
        recoverability_updated_at = EXCLUDED.recoverability_updated_at,
        -- PRESERVE, don't clobber: an observation refresh omits the spec, and provisioning
        -- intent must survive it. Only a caller that actually supplies a spec replaces one.
        desired_spec = COALESCE(EXCLUDED.desired_spec, harness_shared.workspace_hosts.desired_spec),
        -- Same host id means the same replaceable Host. Generation changes require a NEW id;
        -- omission on an observation refresh preserves every domain/control field.
        host_generation = CASE
          WHEN ${input.hostGeneration === undefined} THEN harness_shared.workspace_hosts.host_generation
          ELSE EXCLUDED.host_generation
        END,
        desired_revision = CASE
          WHEN ${input.desiredRevision === undefined} THEN harness_shared.workspace_hosts.desired_revision
          ELSE EXCLUDED.desired_revision
        END,
        observed_revision = CASE
          WHEN ${input.observedRevision === undefined} THEN harness_shared.workspace_hosts.observed_revision
          ELSE EXCLUDED.observed_revision
        END,
        runtime_release = COALESCE(EXCLUDED.runtime_release, harness_shared.workspace_hosts.runtime_release),
        controller_id = COALESCE(EXCLUDED.controller_id, harness_shared.workspace_hosts.controller_id),
        controller_fence = CASE
          WHEN EXCLUDED.controller_id IS NULL THEN harness_shared.workspace_hosts.controller_fence
          ELSE EXCLUDED.controller_fence
        END,
        updated_at = now()
      WHERE (${input.hostGeneration === undefined} OR EXCLUDED.host_generation = harness_shared.workspace_hosts.host_generation)
        AND (
          EXCLUDED.controller_id IS NULL
          OR harness_shared.workspace_hosts.controller_id IS NULL
          OR (
            EXCLUDED.controller_id = harness_shared.workspace_hosts.controller_id
            AND EXCLUDED.controller_fence = harness_shared.workspace_hosts.controller_fence
          )
          OR EXCLUDED.controller_fence > harness_shared.workspace_hosts.controller_fence
        )
      RETURNING id
    `;
    // PostgreSQL reports a successful statement when ON CONFLICT's WHERE clause rejects the
    // update. That outcome is a stale controller/generation refusal, not a successful no-op:
    // returning normally would let the losing controller proceed to its next provider mutation.
    if (!rows[0]) throw new WorkspaceHostControllerFenceError(input.id);
  });
}

/** Why a host's recorded provisioning intent could not be returned. */
export type WorkspaceHostDesiredSpecMiss = 'host-not-found' | 'no-recorded-spec';

export interface WorkspaceHostDesiredSpecLookup {
  desired: WorkspaceHostDesiredSpec | null;
  /** Set only when `desired` is null — which of the two distinct causes applied. */
  miss?: WorkspaceHostDesiredSpecMiss;
  /** The connection the host was provisioned through; a hosted credential ref resolves only via it. */
  connectionId?: string;
}

/**
 * Read back the provisioning intent recorded for one host.
 *
 * The two null cases are deliberately DISTINGUISHED rather than collapsed. "No such host" and
 * "a host that predates migration 956, or was written by a provisioner that recorded no intent"
 * demand different responses — the first is a bad request, the second is a host that cannot be
 * initialized until its provisioner records what it built. Returning a bare null for both would
 * force every caller to re-query to tell them apart, and the likely failure is that none would.
 */
export async function readWorkspaceHostDesiredSpec(
  workspaceId: string,
  hostId: string,
): Promise<WorkspaceHostDesiredSpecLookup> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = (await tx`
      SELECT desired_spec, connection_id
        FROM harness_shared.workspace_hosts
       WHERE workspace_id = ${workspaceId} AND id = ${hostId}
       LIMIT 1
    `) as Array<{ desired_spec: unknown; connection_id: string }>;

    if (rows.length === 0) return { desired: null, miss: 'host-not-found' as const };
    const spec = rows[0]?.desired_spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { desired: null, miss: 'no-recorded-spec' as const };
    }
    return { desired: spec as WorkspaceHostDesiredSpec, connectionId: rows[0]!.connection_id };
  });
}

export interface StoredWorkspaceHostDestroyTarget extends Pick<
  WorkspaceHostDomainState,
  'hostGeneration' | 'desiredRevision' | 'observedRevision' | 'runtimeRelease' | 'controllerAuthority'
> {
  id: string;
  name: string;
  connectionId: string;
  target: string;
  observedState: string;
  recoverability?: {
    kind: 'snapshot' | 'backup' | 'none';
    label: string;
    updatedAt?: string;
  };
  desired: WorkspaceHostDesiredSpec;
  resources: readonly {
    resource: WorkspaceHostResourceRef;
    registeredAt: string;
  }[];
}

/**
 * Recover the exact provider graph a later destroy must plan from.
 *
 * Provision and destroy use different operation ids, so operation-scoped replay rows alone are
 * insufficient here. This read deliberately selects the last applied/unchanged identity for every
 * provider resource and deduplicates lifecycle observations of the same resource. A destroy caller
 * must never reconstruct provider ids from the desired spec or from naming conventions.
 */
export async function readWorkspaceHostDestroyTarget(
  workspaceId: string,
  hostId: string,
  tx?: Sql,
): Promise<StoredWorkspaceHostDestroyTarget | null> {
  return inWorkspace(workspaceId, tx, async (query) => {
    const hosts = (await query`
      SELECT id, name, connection_id, target, observed_state, desired_spec,
             recoverability_kind, recoverability_label, recoverability_updated_at,
             host_generation, desired_revision, observed_revision, runtime_release,
             controller_id, controller_fence
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
      LIMIT 1
    `) as Array<{
      id: string;
      name: string;
      connection_id: string;
      target: string;
      observed_state: string;
      desired_spec: unknown;
      recoverability_kind: 'snapshot' | 'backup' | 'none';
      recoverability_label: string;
      recoverability_updated_at: Date | string | null;
      host_generation: number;
      desired_revision: number;
      observed_revision: number;
      runtime_release: WorkspaceHostRuntimeRelease | null;
      controller_id: string | null;
      controller_fence: number;
    }>;
    const host = hosts[0];
    if (!host) return null;
    if (!host.desired_spec || typeof host.desired_spec !== 'object' || Array.isArray(host.desired_spec)) {
      throw new Error(`Workspace host '${hostId}' has no recorded desired spec`);
    }

    // An identity is registered iff its LATEST row says it exists. A resource confirmed absent on a
    // different row than the one that registered it would otherwise stay registered forever: an
    // AWS upgrade terminates the original instance on its own step row, under a different logical
    // key than the provision row that recorded it (WI-10005971). GCP's same-name re-insert is the
    // newest row for its identity, so it stays registered.
    const rows = (await query`
      SELECT target, kind, provider_id, parent_provider_id, region, zone, state, updated_at
      FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId}
        AND host_id = ${hostId}
        AND state IN ('applied', 'unchanged', 'absent')
        AND target IS NOT NULL
        AND kind IS NOT NULL
        AND provider_id IS NOT NULL
      ORDER BY updated_at DESC, logical_key
    `) as Array<{
      target: WorkspaceHostResourceRef['target'];
      kind: string;
      provider_id: string;
      parent_provider_id: string | null;
      region: string | null;
      zone: string | null;
      state: string;
      updated_at: Date | string;
    }>;
    const seen = new Set<string>();
    const resources: Array<{ resource: WorkspaceHostResourceRef; registeredAt: string }> = [];
    for (const row of rows) {
      const key = `${row.target}:${row.kind}:${row.provider_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.state === 'absent') continue;
      resources.push({
        resource: {
          target: row.target,
          kind: row.kind,
          providerId: row.provider_id,
          ...(row.parent_provider_id ? { parentProviderId: row.parent_provider_id } : {}),
          ...(row.region ? { region: row.region } : {}),
          ...(row.zone ? { zone: row.zone } : {}),
        },
        registeredAt: iso(row.updated_at) ?? new Date(0).toISOString(),
      });
    }
    return {
      id: host.id,
      name: host.name,
      connectionId: host.connection_id,
      target: host.target,
      observedState: host.observed_state,
      recoverability: {
        kind: host.recoverability_kind,
        label: host.recoverability_label,
        ...(iso(host.recoverability_updated_at) ? { updatedAt: iso(host.recoverability_updated_at) } : {}),
      },
      hostGeneration: host.host_generation,
      desiredRevision: host.desired_revision,
      observedRevision: host.observed_revision,
      ...(host.runtime_release ? { runtimeRelease: host.runtime_release } : {}),
      ...(host.controller_id
        ? { controllerAuthority: { controllerId: host.controller_id, fence: host.controller_fence } }
        : {}),
      desired: host.desired_spec as WorkspaceHostDesiredSpec,
      resources,
    };
  });
}

/** Persist the user-visible lifecycle boundary without erasing the stored provisioning intent. */
export async function updateWorkspaceHostLifecycleState(input: {
  workspaceId: string;
  hostId: string;
  state: 'destroying' | 'absent';
  observedAt?: string;
  discard?: boolean;
  recoverability?: {
    kind: 'snapshot' | 'backup' | 'none';
    label: string;
    updatedAt?: string;
  };
  operationId?: string;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}): Promise<void> {
  const recoverability = input.recoverability ?? (input.discard === true
    ? {
        kind: 'none' as const,
        label: 'Discarded without a recovery point',
        updatedAt: input.observedAt ?? new Date().toISOString(),
      }
    : null);
  await withWorkspace(input.workspaceId, async (tx) => {
    await requireWorkspaceHostControllerAuthority(
      tx,
      input.workspaceId,
      input.hostId,
      input.operationId,
      input.controllerAuthority,
    );
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET desired_state = ${input.state},
          observed_state = ${input.state},
          observed_at = ${input.observedAt ?? new Date().toISOString()},
          endpoint = CASE WHEN ${input.state} = 'absent' THEN NULL ELSE endpoint END,
          recoverability_kind = CASE
            WHEN ${recoverability !== null} THEN ${recoverability?.kind ?? 'none'}
            ELSE recoverability_kind
          END,
          recoverability_label = CASE
            WHEN ${recoverability !== null} THEN ${recoverability?.label ?? 'No recovery point recorded'}
            ELSE recoverability_label
          END,
          recoverability_updated_at = CASE
            WHEN ${recoverability !== null} THEN ${recoverability?.updatedAt ?? input.observedAt ?? new Date().toISOString()}
            ELSE recoverability_updated_at
          END,
          -- WI-10004969: reaching 'absent' under a destroy operation means the host converged on
          -- that operation's desired revision. Without this, every destroyed host stayed at
          -- observed_revision < desired_revision forever and release.cleanup's convergence
          -- predicate could never pass. Same GREATEST rule as recordWorkspaceHostObservation.
          observed_revision = CASE
            WHEN ${input.state} <> 'absent' OR ${input.operationId ?? null}::text IS NULL THEN observed_revision
            ELSE GREATEST(
              observed_revision,
              COALESCE((
                SELECT operation.desired_revision
                FROM harness_shared.workspace_host_operations operation
                WHERE operation.workspace_id = ${input.workspaceId}
                  AND operation.id = ${input.operationId ?? null}
                  AND operation.host_id = ${input.hostId}
                  AND operation.action = 'destroy'
              ), observed_revision)
            )
          END,
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.hostId}
    `;
  });
}

/**
 * Record a recovery point taken from a host that stays in service (WI-10002470). Unlike
 * `updateWorkspaceHostLifecycleState` this never touches the host's desired/observed state — a
 * snapshot of a running host must not move it toward destroy — and it is controller-fenced exactly
 * like every other write an operation makes.
 */
export async function recordWorkspaceHostRecoveryPoint(input: {
  workspaceId: string;
  hostId: string;
  recoverability: {
    kind: 'snapshot' | 'backup';
    label: string;
    updatedAt: string;
  };
  operationId?: string;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}): Promise<void> {
  await withWorkspace(input.workspaceId, async (tx) => {
    await requireWorkspaceHostControllerAuthority(
      tx,
      input.workspaceId,
      input.hostId,
      input.operationId,
      input.controllerAuthority,
    );
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET recoverability_kind = ${input.recoverability.kind},
          recoverability_label = ${input.recoverability.label},
          recoverability_updated_at = ${input.recoverability.updatedAt},
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.hostId}
    `;
  });
}

/**
 * Record the base image a successful `upgrade` moved the host onto (WI-10002494). Both copies move
 * together: the `image` column the UI reads and `desired_spec.image`, which every later recreate
 * (repair, restore) builds from — leaving either on the pre-upgrade image made the next recreate
 * silently revert the host. Controller-fenced like every other write an operation makes.
 *
 * `runtimeRelease` is the release the recreated host's bootstrap installed. Omitted keeps the
 * recorded one (a rollback boots the pre-upgrade instance, so its release never changed); without
 * it an upgraded host read its pre-upgrade runtime forever (WI-10002798).
 */
export async function recordWorkspaceHostImage(input: {
  workspaceId: string;
  hostId: string;
  image: WorkspaceHostImageRef;
  runtimeRelease?: WorkspaceHostRuntimeRelease;
  operationId?: string;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}): Promise<void> {
  await withWorkspace(input.workspaceId, async (tx) => {
    await requireWorkspaceHostControllerAuthority(
      tx,
      input.workspaceId,
      input.hostId,
      input.operationId,
      input.controllerAuthority,
    );
    const image = {
      id: input.image.id,
      ...(input.image.version ? { version: input.image.version } : {}),
    };
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET image = ${image.id},
          desired_spec = CASE
            WHEN desired_spec IS NULL THEN desired_spec
            ELSE jsonb_set(desired_spec, '{image}', ${tx.json(image as never)}, true)
          END,
          runtime_release = COALESCE(
            ${input.runtimeRelease === undefined ? null : tx.json(input.runtimeRelease as never)}::jsonb,
            runtime_release
          ),
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.hostId}
    `;
  });
  await pushControl();
}

export interface WorkspaceHostOperationInput {
  workspaceId: string;
  operationId: string;
  hostId: string;
  action: WorkspaceHostLifecycleAction;
  status?: OperationStatus;
  percent?: number;
  message?: string;
  request?: unknown;
  /** First write of an operation may take over only with a strictly newer fencing token. */
  controllerAuthority?: WorkspaceHostControllerAuthority;
  /** Provision uses revision 1; later lifecycle operations default to the next revision. */
  desiredRevision?: number;
}

async function beginFencedWorkspaceHostOperation(input: WorkspaceHostOperationInput): Promise<void> {
  const percent = Math.max(0, Math.min(100, Math.round(input.percent ?? 0)));
  const invalidatesHealth = lifecycleActionInvalidatesHealth(input.action);
  await withWorkspace(input.workspaceId, async (tx) => {
    let desiredRevision = input.desiredRevision ?? null;
    if (input.controllerAuthority) {
      const existing = await tx<
        Array<{
          host_id: string;
          action: WorkspaceHostLifecycleAction;
          desired_revision: number | null;
          controller_id: string | null;
          controller_fence: number | null;
          request_matches: boolean;
          error_code: string | null;
        }>
      >`
        SELECT host_id, action, desired_revision, controller_id, controller_fence,
               error->>'code' AS error_code,
               request IS NOT DISTINCT FROM ${input.request === undefined ? null : tx.json(json(input.request) as never)}::jsonb AS request_matches
        FROM harness_shared.workspace_host_operations
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.operationId}
        LIMIT 1
      `;
      if (existing[0]) {
        if (
          existing[0].host_id !== input.hostId ||
          existing[0].action !== input.action ||
          existing[0].controller_id !== input.controllerAuthority.controllerId ||
          existing[0].controller_fence !== input.controllerAuthority.fence ||
          (input.desiredRevision !== undefined && existing[0].desired_revision !== input.desiredRevision) ||
          !existing[0].request_matches
        ) {
          throw new WorkspaceHostControllerFenceError(input.hostId);
        }
        // A refused row records an earlier attempt of THIS request that never began. A retry
        // (DBOS re-runs a failed step with the same input) runs the fence again below, and an
        // admitted retry replaces the refusal in place via the INSERT's conflict clause.
        if (existing[0].error_code !== WORKSPACE_HOST_FENCE_REFUSED_CODE) {
          await requireWorkspaceHostControllerAuthority(
            tx,
            input.workspaceId,
            input.hostId,
            input.operationId,
            input.controllerAuthority,
          );
          return;
        }
      }

      const controlled = await tx<Array<{ desired_revision: number }>>`
        UPDATE harness_shared.workspace_hosts
        SET desired_revision = CASE
              WHEN ${desiredRevision}::bigint IS NULL THEN desired_revision + 1
              ELSE ${desiredRevision}::bigint
            END,
            controller_id = ${input.controllerAuthority.controllerId},
            controller_fence = ${input.controllerAuthority.fence},
            updated_at = now()
        WHERE workspace_id = ${input.workspaceId}
          AND id = ${input.hostId}
          AND (
            ${desiredRevision}::bigint IS NULL
            OR ${desiredRevision}::bigint > desired_revision
            OR (
              -- A host's FIRST operation may claim the revision its row was written with. Restore
              -- is a first operation too: it writes the replacement Host at the new revision, then
              -- opens its operation there — requiring "strictly newer" fenced that out forever.
              ${input.action} IN ('provision', 'restore')
              AND ${desiredRevision}::bigint = desired_revision
              AND NOT EXISTS (
                SELECT 1 FROM harness_shared.workspace_host_operations prior
                WHERE prior.workspace_id = ${input.workspaceId} AND prior.host_id = ${input.hostId}
                  -- A first operation that FAILED, with no recovery in flight, never brought the
                  -- host into existence, so a retry is still the host's first operation. Counting
                  -- it fenced every retry of a failed first provision forever (WI-10005307).
                  AND NOT (
                    prior.action IN ('provision', 'restore')
                    AND prior.status = 'failed'
                    AND prior.recovery_state = 'none'
                  )
                  -- A refused operation never ran, so it is never a prior operation (WI-10005312);
                  -- counting one refused start would fence every later provision retry.
                  AND prior.error->>'code' IS DISTINCT FROM ${WORKSPACE_HOST_FENCE_REFUSED_CODE}
              )
            )
          )
          AND (
            controller_id IS NULL
            OR (controller_id = ${input.controllerAuthority.controllerId} AND controller_fence = ${input.controllerAuthority.fence})
            OR ${input.controllerAuthority.fence} > controller_fence
          )
        RETURNING desired_revision
      `;
      if (!controlled[0]) throw new WorkspaceHostControllerFenceError(input.hostId);
      desiredRevision = controlled[0].desired_revision;
    }
    if (invalidatesHealth) {
      // WI-10005373: a liveness-changing operation makes the previous health sample stale at
      // admission. Clear it before provider mutation so a partial stop cannot remain displayed
      // as healthy, and a quick start cannot inherit a timestamp the standing pass treats as fresh.
      await tx`
        UPDATE harness_shared.workspace_hosts
        SET health_status = NULL,
            health_attested_at = NULL,
            health_checks = '[]'::jsonb,
            updated_at = now()
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.hostId}
      `;
    }
    await tx`
      INSERT INTO harness_shared.workspace_host_operations (
        workspace_id, id, host_id, action, status, percent, message, request,
        desired_revision, controller_id, controller_fence, started_at, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.operationId}, ${input.hostId}, ${input.action},
        ${input.status ?? 'queued'}, ${percent}, ${redactWorkspaceHostText(input.message ?? '')},
        ${input.request === undefined ? null : tx.json(json(input.request) as never)},
        ${desiredRevision}, ${input.controllerAuthority?.controllerId ?? null},
        ${input.controllerAuthority?.fence ?? null},
        ${input.status === 'running' ? new Date().toISOString() : null}, now()
      )
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        status = EXCLUDED.status,
        percent = EXCLUDED.percent,
        message = EXCLUDED.message,
        request = EXCLUDED.request,
        error = NULL,
        desired_revision = EXCLUDED.desired_revision,
        controller_id = EXCLUDED.controller_id,
        controller_fence = EXCLUDED.controller_fence,
        started_at = EXCLUDED.started_at,
        finished_at = NULL,
        updated_at = now()
      -- Only an earlier refusal of this same request is replaced; a live row is never touched.
      WHERE workspace_host_operations.error->>'code' = ${WORKSPACE_HOST_FENCE_REFUSED_CODE}
    `;
  });
}

export async function beginWorkspaceHostOperation(input: WorkspaceHostOperationInput): Promise<void> {
  try {
    await beginFencedWorkspaceHostOperation(input);
    if (lifecycleActionInvalidatesHealth(input.action)) await pushControl();
  } catch (error) {
    if (error instanceof WorkspaceHostControllerFenceError) {
      try {
        await recordWorkspaceHostOperationRefusal(input, error);
      } catch (recordError) {
        // The refusal itself is the caller's answer; failing to record it must not replace it.
        console.error(
          `[workspace-host] could not record fence refusal for operation ${input.operationId}: ${
            recordError instanceof Error ? recordError.message : String(recordError)
          }`,
        );
      }
    }
    throw error;
  }
}

/**
 * WI-10005312: a fence refusal rolls back the transaction that would have written the
 * operation row, so a request already answered 202 had no row and its timeline never showed
 * the failure. Record a terminal row OUTSIDE that transaction (like
 * {@link recordWorkspaceHostOperationTerminalFailure}). `DO NOTHING` on conflict: an existing
 * row belongs to an earlier attempt or a different request and is never overwritten.
 */
async function recordWorkspaceHostOperationRefusal(
  input: WorkspaceHostOperationInput,
  error: WorkspaceHostControllerFenceError,
): Promise<void> {
  const described = { code: WORKSPACE_HOST_FENCE_REFUSED_CODE, cause: error };
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.workspace_host_operations (
        workspace_id, id, host_id, action, status, percent, message, request, error,
        desired_revision, controller_id, controller_fence, finished_at, updated_at
      )
      -- From the host row: a refusal for a host that does not exist has no timeline to show it
      -- on, so nothing is written. A lifecycle request without an explicit revision asked for
      -- the next one; the controller-authority check constraint requires a positive revision.
      SELECT ${input.workspaceId}, ${input.operationId}, host.id, ${input.action}, 'failed', 0,
             ${redactWorkspaceHostText(`refused before it began: ${error.message}`)},
             ${input.request === undefined ? null : tx.json(json(input.request) as never)},
             ${tx.json(json(described) as never)},
             COALESCE(${input.desiredRevision ?? null}::bigint, host.desired_revision + 1),
             ${input.controllerAuthority?.controllerId ?? null},
             ${input.controllerAuthority?.fence ?? null}, now(), now()
      FROM harness_shared.workspace_hosts AS host
      WHERE host.workspace_id = ${input.workspaceId} AND host.id = ${input.hostId}
      ON CONFLICT (workspace_id, id) DO NOTHING
    `;
  });
}

/**
 * WI-10002527: the raw `request.plan` an operation stored when it began, or null before it has. A
 * lifecycle resume executes that plan instead of re-planning (lifecycle-runner.ts).
 */
export async function readWorkspaceHostOperationPlan(workspaceId: string, operationId: string): Promise<unknown> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<Array<{ plan: unknown }>>`
      SELECT request->'plan' AS plan
      FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND id = ${operationId}
      LIMIT 1
    `;
    return rows[0]?.plan ?? null;
  });
}

export async function updateWorkspaceHostOperation(input: {
  workspaceId: string;
  operationId: string;
  status: OperationStatus;
  percent: number;
  message: string;
  error?: unknown;
  /** Validated public request, enriched when asynchronous admission finishes credential checks. */
  request?: Readonly<Record<string, unknown>>;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}): Promise<void> {
  if (input.request !== undefined) assertWorkspaceHostSecretIsolation(input.request, 'workspaceHost.operation.request');
  const percent = Math.max(0, Math.min(100, Math.round(input.percent)));
  await withWorkspace(input.workspaceId, async (tx) => {
    const operations = await tx<Array<{ host_id: string }>>`
      SELECT host_id FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.operationId}
      LIMIT 1
    `;
    const hostId = operations[0]?.host_id;
    if (hostId) {
      await requireWorkspaceHostControllerAuthority(
        tx,
        input.workspaceId,
        hostId,
        input.operationId,
        input.controllerAuthority,
      );
    }
    await tx`
      UPDATE harness_shared.workspace_host_operations
      SET status = ${input.status},
          percent = ${percent},
          message = ${redactWorkspaceHostText(input.message)},
          error = ${input.error === undefined ? null : tx.json(json(input.error) as never)},
          request = CASE WHEN ${input.request !== undefined} THEN ${input.request === undefined ? null : tx.json(json(input.request) as never)}::jsonb ELSE request END,
          started_at = CASE WHEN ${input.status} = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
          finished_at = CASE WHEN ${input.status} IN ('succeeded', 'failed') THEN now() ELSE NULL END,
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.operationId}
    `;
  });
}

/**
 * Record a workflow's TERMINAL failure on its operation row (WI-10001739 link 2).
 *
 * Without this, a DBOS step that exhausts its retries throws out of the workflow and NOTHING ever
 * marks the operation. The row keeps its last-known status and a stale `updated_at`, so it looks
 * alive; ~20 minutes later the hosted-lifecycle reconciler reaps it on recency alone and
 * SYNTHESIZES `{"code":"hosted_lifecycle_recovery_exhausted"}` — erasing the real cause. Measured
 * 2026-09-17: a destroy died 73s in and was reported 20.2min later under that fabricated code.
 *
 * Deliberately NOT `updateWorkspaceHostOperation`, in three ways that each matter:
 *  1. No `controllerAuthority`. Recording that a workflow died must not itself be fenced out, or
 *     the failure that matters most is precisely the one that goes unrecorded.
 *  2. `percent` is left UNCHANGED. A destroy that reached 99% must not be rewritten to 0 — that
 *     number is the only surviving evidence of how far teardown actually got.
 *  3. It never overwrites an already-terminal row, so a late throw cannot flip a `succeeded`
 *     operation to `failed`.
 *
 * Expressing all three as flags on `updateWorkspaceHostOperation` would make that function's
 * contract strictly worse (an authority-optional, percent-optional, sometimes-no-op writer), so
 * this is a separate narrow verb rather than an extension of it.
 *
 * @returns true if this call was the writer of record; false if the row was already terminal.
 */
export async function recordWorkspaceHostOperationTerminalFailure(input: {
  workspaceId: string;
  operationId: string;
  message: string;
  error: unknown;
}): Promise<boolean> {
  // `json` -> redactWorkspaceHostValue already preserves a thrown Error readably (name/message,
  // the full `cause` chain, circular-safe) and redacts secrets inside it. Hand-rolling a
  // {name, message} shape here would silently drop the cause chain — which for this defect is the
  // most valuable part, since the underlying provider error is nested inside the DBOS wrapper.
  const described = { code: 'workflow_terminal_failure', cause: input.error };
  return await withWorkspace(input.workspaceId, async (tx) => {
    const rows = await tx<Array<{ id: string }>>`
      UPDATE harness_shared.workspace_host_operations
      SET status = 'failed',
          message = ${redactWorkspaceHostText(input.message)},
          error = ${tx.json(json(described) as never)},
          finished_at = now(),
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.operationId}
        AND status NOT IN ('succeeded', 'failed')
      RETURNING id
    `;
    return rows.length > 0;
  });
}

export async function upsertWorkspaceHostResourceCheckpoint(input: {
  workspaceId: string;
  hostId: string;
  operationId: string;
  checkpoint: WorkspaceHostResourceCheckpoint;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}): Promise<void> {
  const { checkpoint } = input;
  const resource = checkpoint.providerResource;
  await withWorkspace(input.workspaceId, async (tx) => {
    await requireWorkspaceHostControllerAuthority(
      tx,
      input.workspaceId,
      input.hostId,
      input.operationId,
      input.controllerAuthority,
    );
    await tx`
      INSERT INTO harness_shared.workspace_host_resources (
        workspace_id, host_id, logical_key, operation_id, state, attempts,
        retry_class, retry_after_ms, target, kind, provider_id,
        parent_provider_id, region, zone, provider_request_id,
        deletion_confirmation, error, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.hostId}, ${checkpoint.logicalKey}, ${input.operationId},
        ${checkpoint.state}, ${checkpoint.attempts}, ${checkpoint.retryClass ?? null},
        ${checkpoint.retryAfterMs ?? null}, ${resource?.target ?? null}, ${resource?.kind ?? null},
        ${resource?.providerId ?? null}, ${resource?.parentProviderId ?? null},
        ${resource?.region ?? null}, ${resource?.zone ?? null},
        ${checkpoint.providerRequestId ?? null},
        ${checkpoint.deletionConfirmation === undefined ? null : tx.json(json(checkpoint.deletionConfirmation) as never)},
        ${checkpoint.error === undefined ? null : tx.json(json({ message: checkpoint.error }) as never)}, now()
      )
      ON CONFLICT (workspace_id, host_id, logical_key) DO UPDATE SET
        operation_id = EXCLUDED.operation_id,
        state = EXCLUDED.state,
        attempts = EXCLUDED.attempts,
        retry_class = EXCLUDED.retry_class,
        retry_after_ms = EXCLUDED.retry_after_ms,
        target = EXCLUDED.target,
        kind = EXCLUDED.kind,
        provider_id = EXCLUDED.provider_id,
        parent_provider_id = EXCLUDED.parent_provider_id,
        region = EXCLUDED.region,
        zone = EXCLUDED.zone,
        provider_request_id = EXCLUDED.provider_request_id,
        deletion_confirmation = EXCLUDED.deletion_confirmation,
        error = EXCLUDED.error,
        updated_at = now()
    `;
  });
}

interface ResourceCheckpointDbRow {
  logical_key: string;
  state: WorkspaceHostResourceCheckpoint['state'];
  attempts: number;
  retry_class: WorkspaceHostResourceCheckpoint['retryClass'] | null;
  retry_after_ms: number | null;
  target: string | null;
  kind: string | null;
  provider_id: string | null;
  parent_provider_id: string | null;
  region: string | null;
  zone: string | null;
  provider_request_id: string | null;
  deletion_confirmation: unknown;
  error: unknown;
}

function checkpointError(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return undefined;
}

/**
 * Hydrate only checkpoints belonging to this stable operation. Filtering by operation id prevents
 * a new operation on the same host from treating an older resource graph as its own replay state.
 */
export async function readWorkspaceHostResourceCheckpoints(
  workspaceId: string,
  hostId: string,
  operationId: string,
): Promise<WorkspaceHostResourceCheckpoint[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<ResourceCheckpointDbRow[]>`
      SELECT logical_key, state, attempts, retry_class, retry_after_ms,
             target, kind, provider_id, parent_provider_id, region, zone,
             provider_request_id, deletion_confirmation, error
      FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId}
        AND host_id = ${hostId}
        AND operation_id = ${operationId}
      ORDER BY logical_key
    `;
    return rows.map((row) => {
      const providerResource =
        row.target && row.kind && row.provider_id
          ? {
              target: row.target,
              kind: row.kind,
              providerId: row.provider_id,
              ...(row.parent_provider_id ? { parentProviderId: row.parent_provider_id } : {}),
              ...(row.region ? { region: row.region } : {}),
              ...(row.zone ? { zone: row.zone } : {}),
            }
          : undefined;
      const deletionConfirmation =
        row.deletion_confirmation && typeof row.deletion_confirmation === 'object'
          ? (row.deletion_confirmation as WorkspaceHostResourceCheckpoint['deletionConfirmation'])
          : undefined;
      return {
        logicalKey: row.logical_key,
        state: row.state,
        attempts: row.attempts,
        ...(row.retry_class ? { retryClass: row.retry_class } : {}),
        ...(row.retry_after_ms != null ? { retryAfterMs: row.retry_after_ms } : {}),
        ...(providerResource ? { providerResource } : {}),
        ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
        ...(deletionConfirmation ? { deletionConfirmation } : {}),
        ...(checkpointError(row.error) ? { error: checkpointError(row.error) } : {}),
      };
    });
  });
}

export interface WorkspaceHostTimelineEventInput {
  workspaceId: string;
  hostId: string;
  operationId: string;
  id?: string;
  occurredAt?: string;
  phase: string;
  status: OperationStatus;
  level?: TimelineLevel;
  source?: string;
  message: string;
  details?: unknown;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}

export async function appendWorkspaceHostEvent(input: WorkspaceHostTimelineEventInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await withWorkspace(input.workspaceId, async (tx) => {
    await requireWorkspaceHostControllerAuthority(
      tx,
      input.workspaceId,
      input.hostId,
      input.operationId,
      input.controllerAuthority,
    );
    await tx`
      INSERT INTO harness_shared.workspace_host_events (
        workspace_id, id, host_id, operation_id, occurred_at, phase,
        status, level, source, message, details
      ) VALUES (
        ${input.workspaceId}, ${id}, ${input.hostId}, ${input.operationId},
        ${input.occurredAt ?? new Date().toISOString()}, ${input.phase}, ${input.status},
        ${input.level ?? 'info'}, ${input.source ?? 'controller'},
        ${redactWorkspaceHostText(input.message)},
        ${input.details === undefined ? null : tx.json(json(input.details) as never)}
      )
      ON CONFLICT (workspace_id, id) DO NOTHING
    `;
  });
  return id;
}

export interface WorkspaceHostLogInput {
  id?: string;
  operationId?: string;
  observedAt?: string;
  stream: LogStream;
  unit?: string;
  level?: TimelineLevel;
  message: string;
  metadata?: unknown;
}

export async function appendWorkspaceHostLogs(
  workspaceId: string,
  hostId: string,
  entries: readonly WorkspaceHostLogInput[],
): Promise<string[]> {
  if (entries.length === 0) return [];
  const rows = entries.map((entry) => ({ ...entry, id: entry.id ?? randomUUID() }));
  await withWorkspace(workspaceId, async (tx) => {
    for (const entry of rows) {
      await tx`
        INSERT INTO harness_shared.workspace_host_logs (
          workspace_id, id, host_id, operation_id, observed_at, stream,
          unit, level, message, metadata
        ) VALUES (
          ${workspaceId}, ${entry.id}, ${hostId}, ${entry.operationId ?? null},
          ${entry.observedAt ?? new Date().toISOString()}, ${entry.stream}, ${entry.unit ?? null},
          ${entry.level ?? 'info'}, ${redactWorkspaceHostText(entry.message)},
          ${entry.metadata === undefined ? null : tx.json(json(entry.metadata) as never)}
        )
        ON CONFLICT (workspace_id, id) DO NOTHING
      `;
    }
  });
  await pushControl();
  return rows.map((entry) => entry.id);
}

export async function recordWorkspaceHostObservation(
  workspaceId: string,
  observation: WorkspaceHostObservation,
  control?: { operationId: string; controllerAuthority: WorkspaceHostControllerAuthority },
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await requireWorkspaceHostControllerAuthority(
      tx,
      workspaceId,
      observation.host.hostId,
      control?.operationId,
      control?.controllerAuthority,
    );
    await tx`
      UPDATE harness_shared.workspace_hosts AS host
      SET desired_state = CASE
            -- Older provision/restore writers stored the transitional observed state as
            -- intent. Repair only through that still-current operation, never by copying
            -- the observed state (a stopped VM still has running provision intent).
            WHEN host.desired_state = 'provisioning' AND EXISTS (
              SELECT 1 FROM harness_shared.workspace_host_operations AS operation
              WHERE operation.workspace_id = host.workspace_id
                AND operation.host_id = host.id
                AND operation.id = ${control?.operationId ?? null}
                AND operation.action IN ('provision', 'restore', 'repair')
                AND operation.desired_revision = host.desired_revision
                AND operation.controller_id = ${control?.controllerAuthority.controllerId ?? null}
                AND operation.controller_fence = ${control?.controllerAuthority.fence ?? null}
                AND operation.controller_id = host.controller_id
                AND operation.controller_fence = host.controller_fence
            ) THEN 'running'
            ELSE host.desired_state
          END,
          observed_state = ${observation.state},
          observed_at = ${observation.observedAt},
          version_drift = ${tx.json(json(observation.drift) as never)},
          observed_revision = CASE
            WHEN ${control?.operationId ?? null}::text IS NULL THEN observed_revision
            ELSE GREATEST(
              observed_revision,
              COALESCE((
                SELECT desired_revision
                FROM harness_shared.workspace_host_operations
                WHERE workspace_id = ${workspaceId} AND id = ${control?.operationId ?? null}
              ), observed_revision)
            )
          END,
          updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${observation.host.hostId}
    `;
  });
  await pushControl();
}

export async function recordWorkspaceHostHealth(
  workspaceId: string,
  attestation: WorkspaceHostHealthAttestation,
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET health_status = ${attestation.status},
          health_attested_at = ${attestation.observedAt},
          health_checks = ${tx.json(json(attestation.checks) as never)},
          -- An attestation that does not carry a bootstrap version did not MEASURE one; absence
          -- must not erase the version a bootstrap already reported (the soak attests every few
          -- minutes and never reads it).
          bootstrap_version = COALESCE(${attestation.bootstrapVersion ?? null}, bootstrap_version),
          updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${attestation.hostId}
    `;
  });
}

export async function recordWorkspaceHostSignals(input: {
  workspaceId: string;
  hostId: string;
  endpoint?: string;
  tunnelStatus?: unknown;
  costSignals?: readonly unknown[];
  quotaSignals?: readonly unknown[];
  operationId?: string;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}): Promise<void> {
  await withWorkspace(input.workspaceId, async (tx) => {
    await requireWorkspaceHostControllerAuthority(
      tx,
      input.workspaceId,
      input.hostId,
      input.operationId,
      input.controllerAuthority,
    );
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET endpoint = coalesce(${input.endpoint ?? null}, endpoint),
          tunnel_status = coalesce(${input.tunnelStatus === undefined ? null : tx.json(json(input.tunnelStatus) as never)}, tunnel_status),
          cost_signals = coalesce(${input.costSignals === undefined ? null : tx.json(json(input.costSignals) as never)}, cost_signals),
          quota_signals = coalesce(${input.quotaSignals === undefined ? null : tx.json(json(input.quotaSignals) as never)}, quota_signals),
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.hostId}
    `;
  });
}

interface ConnectionDbRow {
  id: string;
  target: string;
  label: string;
  credential_ref: string;
  provider_config: JsonRecord;
  status: ConnectionStatus;
  authenticated_identity: string | null;
  status_detail: string | null;
  last_validated_at: Date | string | null;
  scopes: unknown[];
  regions: unknown[];
  sizes: unknown[];
  images: unknown[];
  networks: unknown[];
  disk_price_per_gib_month: string | number | null;
}
interface HostDbRow {
  id: string;
  name: string;
  connection_id: string;
  target: string;
  scope_label: string;
  region: string;
  size: string;
  image: string;
  disk_gib: number;
  network: string;
  estimated_monthly_usd: string | number | null;
  desired_state: string;
  observed_state: string;
  observed_at: Date | string | null;
  created_at: Date | string;
  endpoint: string | null;
  recoverability_kind: 'snapshot' | 'backup' | 'none';
  recoverability_label: string;
  recoverability_updated_at: Date | string | null;
  health_status: string | null;
  health_attested_at: Date | string | null;
  health_checks: unknown[];
  bootstrap_version: string | null;
  version_drift: unknown[];
  tunnel_status: JsonRecord;
  cost_signals: unknown[];
  quota_signals: unknown[];
  host_generation: number;
  desired_revision: number;
  observed_revision: number;
  runtime_release: WorkspaceHostRuntimeRelease | null;
  controller_id: string | null;
  controller_fence: number;
}
interface OperationDbRow {
  id: string;
  host_id: string;
  action: string;
  status: OperationStatus;
  percent: number;
  message: string;
  request: unknown;
  error: unknown;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  updated_at: Date | string;
  desired_revision: number | null;
  controller_id: string | null;
  controller_fence: number | null;
}
interface ResourceDbRow {
  host_id: string;
  logical_key: string;
  operation_id: string;
  state: string;
  attempts: number;
  retry_class: string | null;
  target: string | null;
  kind: string | null;
  provider_id: string | null;
  parent_provider_id: string | null;
  region: string | null;
  zone: string | null;
  provider_request_id: string | null;
  deletion_confirmation: unknown;
  error: unknown;
  updated_at: Date | string;
}
interface EventDbRow {
  id: string;
  host_id: string;
  operation_id: string;
  occurred_at: Date | string;
  phase: string;
  status: OperationStatus;
  level: TimelineLevel;
  source: string;
  message: string;
  details: unknown;
}
interface LogDbRow {
  id: string;
  host_id: string;
  operation_id: string | null;
  observed_at: Date | string;
  stream: LogStream;
  unit: string | null;
  level: TimelineLevel;
  message: string;
  metadata: unknown;
}

function capabilities(state: string, hasSnapshot = false): Record<string, boolean> {
  return {
    start: state === 'stopped',
    stop: state === 'running' || state === 'degraded',
    repair: state !== 'absent' && state !== 'destroying',
    snapshot: state === 'running' || state === 'stopped' || state === 'degraded',
    restore: hasSnapshot && ['running', 'stopped', 'degraded', 'absent'].includes(state),
    destroy: state !== 'absent' && state !== 'destroying',
  };
}

export async function readWorkspaceHostControl(workspaceId: string, tx?: Sql): Promise<unknown[]> {
  return inWorkspace(workspaceId, tx, async (query) => {
    const connections = await query<ConnectionDbRow[]>`
      SELECT id, target, label, credential_ref, provider_config, status, status_detail, last_validated_at,
             authenticated_identity, scopes, regions, sizes, images, networks, disk_price_per_gib_month
      FROM harness_shared.workspace_host_connections
      ORDER BY target, label, id
    `;
    const hosts = await query<HostDbRow[]>`
      SELECT id, name, connection_id, target, scope_label, region, size, image,
             disk_gib, network, estimated_monthly_usd, desired_state, observed_state,
             -- created_at is the one column that still means "when this host was
             -- provisioned": it is deliberately absent from the upsert's ON CONFLICT
             -- UPDATE set above, so an observation refresh moves observed_at and
             -- leaves it alone.
             observed_at, created_at, endpoint, recoverability_kind, recoverability_label,
             recoverability_updated_at, health_status, health_attested_at, health_checks,
             bootstrap_version, version_drift, tunnel_status, cost_signals, quota_signals,
             host_generation, desired_revision, observed_revision, runtime_release,
             controller_id, controller_fence
      FROM harness_shared.workspace_hosts
      ORDER BY updated_at DESC, id
    `;
    const operations = await query<OperationDbRow[]>`
      SELECT DISTINCT ON (host_id)
             id, host_id, action, status, percent, message, request, error,
             created_at, started_at, finished_at, updated_at,
             desired_revision, controller_id, controller_fence
      FROM harness_shared.workspace_host_operations AS operation
      ORDER BY host_id,
               -- A refused request never ran, so it never displaces an in-flight operation as
               -- the host's current progress; otherwise it competes by recency (WI-10005312).
               (operation.error->>'code' IS NOT DISTINCT FROM ${WORKSPACE_HOST_FENCE_REFUSED_CODE}
                 AND EXISTS (
                   SELECT 1 FROM harness_shared.workspace_host_operations AS live
                   WHERE live.workspace_id = operation.workspace_id
                     AND live.host_id = operation.host_id
                     AND live.status IN ('queued', 'running')
                 )),
               updated_at DESC, id DESC
    `;
    const resources = await query<ResourceDbRow[]>`
      SELECT host_id, logical_key, operation_id, state, attempts, retry_class,
             target, kind, provider_id, parent_provider_id, region, zone,
             provider_request_id, deletion_confirmation, error, updated_at
      FROM harness_shared.workspace_host_resources
      ORDER BY host_id, logical_key
    `;
    const events = await query<EventDbRow[]>`
      SELECT e.id, e.host_id, e.operation_id, e.occurred_at, e.phase,
             e.status, e.level, e.source, e.message, e.details
      FROM harness_shared.workspace_host_events e
      JOIN (
        SELECT DISTINCT ON (host_id) workspace_id, host_id, id
        FROM harness_shared.workspace_host_operations AS operation
        -- Same pick as the operation projection above (WI-10005312).
        ORDER BY host_id,
                 (operation.error->>'code' IS NOT DISTINCT FROM ${WORKSPACE_HOST_FENCE_REFUSED_CODE}
                   AND EXISTS (
                     SELECT 1 FROM harness_shared.workspace_host_operations AS live
                     WHERE live.workspace_id = operation.workspace_id
                       AND live.host_id = operation.host_id
                       AND live.status IN ('queued', 'running')
                   )),
                 updated_at DESC, id DESC
      ) latest ON latest.workspace_id = e.workspace_id
              AND latest.host_id = e.host_id
              AND latest.id = e.operation_id
      ORDER BY e.occurred_at, e.id
    `;
    const logs = await query<LogDbRow[]>`
      SELECT id, host_id, operation_id, observed_at, stream, unit, level, message, metadata
      FROM (
        SELECT l.*, row_number() OVER (PARTITION BY host_id ORDER BY observed_at DESC, id DESC) AS rn
        FROM harness_shared.workspace_host_logs l
      ) recent
      WHERE rn <= 20
      ORDER BY host_id, observed_at DESC, id DESC
    `;

    const latestOperation = new Map(operations.map((row) => [row.host_id, row]));
    const eventsByOperation = new Map<string, EventDbRow[]>();
    for (const event of events) {
      const list = eventsByOperation.get(event.operation_id) ?? [];
      list.push(event);
      eventsByOperation.set(event.operation_id, list);
    }
    const resourcesByHost = new Map<string, ResourceDbRow[]>();
    for (const resource of resources) {
      const list = resourcesByHost.get(resource.host_id) ?? [];
      list.push(resource);
      resourcesByHost.set(resource.host_id, list);
    }
    const logsByHost = new Map<string, LogDbRow[]>();
    for (const log of logs) {
      const list = logsByHost.get(log.host_id) ?? [];
      list.push(log);
      logsByHost.set(log.host_id, list);
    }

    const connectionRows = connections.map((row) => ({
      kind: 'connection' as const,
      id: row.id,
      target: row.target,
      label: row.label,
      status: row.status,
      authenticatedIdentity: row.authenticated_identity ?? undefined,
      credentialRef: credentialReferenceDisplay(row.credential_ref),
      provider: row.provider_config,
      lastValidatedAt: iso(row.last_validated_at),
      statusDetail: row.status_detail ?? undefined,
      scopes: row.scopes,
      regions: row.regions,
      sizes: row.sizes,
      images: row.images,
      networks: row.networks,
      diskPricePerGiBMonth: row.disk_price_per_gib_month == null ? undefined : Number(row.disk_price_per_gib_month),
    }));

    const hostRows = hosts.map((row) => {
      // A fully absent host is a tombstone, not an active controller target. Its
      // latest operation may be a stale running row left behind by an interrupted
      // destroy, so do not project that row as current progress.
      const operation =
        row.desired_state === 'absent' && row.observed_state === 'absent'
          ? undefined
          : latestOperation.get(row.id);
      const hostResources = resourcesByHost.get(row.id) ?? [];
      return {
        kind: 'workspace' as const,
        id: row.id,
        name: row.name,
        connectionId: row.connection_id,
        target: row.target,
        scopeLabel: row.scope_label,
        region: row.region,
        size: row.size,
        image: row.image,
        diskGiB: row.disk_gib,
        network: row.network,
        estimatedMonthlyUsd: row.estimated_monthly_usd == null ? undefined : Number(row.estimated_monthly_usd),
        desiredState: row.desired_state,
        observedState: row.observed_state,
        hostGeneration: row.host_generation,
        desiredRevision: row.desired_revision,
        observedRevision: row.observed_revision,
        runtimeRelease: row.runtime_release ?? undefined,
        controllerAuthority: row.controller_id
          ? { controllerId: row.controller_id, fence: row.controller_fence }
          : undefined,
        observedAt: iso(row.observed_at),
        provisionedAt: iso(row.created_at),
        providerResourceId:
          hostResources.find((resource) => resource.kind === 'vm')?.provider_id ??
          hostResources.find((resource) => resource.provider_id)?.provider_id ??
          undefined,
        endpoint: row.endpoint ?? undefined,
        recoverability: {
          kind: row.recoverability_kind,
          label: row.recoverability_label,
          updatedAt: iso(row.recoverability_updated_at),
        },
        capabilities: capabilities(row.observed_state, hostResources.some((resource) => resource.kind === 'snapshot' && resource.state === 'applied' && Boolean(resource.provider_id))),
        resources: hostResources.map((resource) => ({
          logicalKey: resource.logical_key,
          kind: resource.kind,
          state: resource.state,
          providerId: resource.provider_id,
          providerRequestId: resource.provider_request_id,
          deletionConfirmation: resource.deletion_confirmation,
          attempts: resource.attempts,
          retryClass: resource.retry_class,
          updatedAt: iso(resource.updated_at),
          error: resource.error,
        })),
        health: row.health_status
          ? {
              status: row.health_status,
              attestedAt: iso(row.health_attested_at),
              checks: row.health_checks,
              bootstrapVersion: row.bootstrap_version ?? undefined,
            }
          : undefined,
        versionDrift: row.version_drift,
        tunnel: row.tunnel_status,
        costSignals: row.cost_signals,
        quotaSignals: row.quota_signals,
        logs: (logsByHost.get(row.id) ?? []).map((log) => ({
          id: log.id,
          operationId: log.operation_id ?? undefined,
          observedAt: iso(log.observed_at),
          stream: log.stream,
          unit: log.unit ?? undefined,
          level: log.level,
          message: log.message,
          metadata: log.metadata,
        })),
        operation: operation
          ? {
              id: operation.id,
              action: operation.action,
              status: operation.status,
              percent: operation.percent,
              message: operation.message,
              request: operation.request,
              error: operation.error,
              desiredRevision: operation.desired_revision ?? undefined,
              controllerAuthority: operation.controller_id
                ? { controllerId: operation.controller_id, fence: operation.controller_fence }
                : undefined,
              startedAt: iso(operation.started_at ?? operation.created_at),
              finishedAt: iso(operation.finished_at),
              events: (eventsByOperation.get(operation.id) ?? []).map((event) => ({
                id: event.id,
                ts: iso(event.occurred_at),
                phase: event.phase,
                status: event.status,
                level: event.level,
                source: event.source,
                message: event.message,
                details: event.details,
              })),
            }
          : undefined,
      };
    });
    return [...connectionRows, ...hostRows];
  });
}

export async function exportWorkspaceHostAudit(workspaceId: string, hostId: string): Promise<JsonRecord | null> {
  const result = await withWorkspace(workspaceId, async (tx) => {
    const hosts = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_hosts WHERE id = ${hostId} LIMIT 1
    `;
    if (!hosts[0]) return null;
    const operations = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_operations WHERE host_id = ${hostId}
      ORDER BY created_at, id
    `;
    const resources = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_resources WHERE host_id = ${hostId}
      ORDER BY logical_key
    `;
    const events = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_events WHERE host_id = ${hostId}
      ORDER BY occurred_at, id
    `;
    const logs = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_logs WHERE host_id = ${hostId}
      ORDER BY observed_at, id
    `;
    return {
      schemaVersion: 'papercusp-workspace-host-audit-v1',
      exportedAt: new Date().toISOString(),
      host: hosts[0],
      operations,
      resources,
      events,
      logs,
    };
  });
  return result ? (redactWorkspaceHostValue(result) as JsonRecord) : null;
}
