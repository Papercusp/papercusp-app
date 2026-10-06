import type {
  WorkspaceHostCatalogQuery,
  WorkspaceHostConnectionValidation,
  WorkspaceHostDesiredSpec,
  WorkspaceHostImage,
  WorkspaceHostPriceEstimate,
  WorkspaceHostProviderConnection,
  WorkspaceHostRegion,
  WorkspaceHostScope,
  WorkspaceHostSize,
  WorkspaceHostSpendObservation,
} from '@papercusp/deployment-driver';
import { createWorkspaceHostSpendObservation } from '@papercusp/deployment-driver';
import {
  GCP_DEFAULT_WORKSPACE_HOST_IMAGE,
  GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF,
  acquireGcpAdcAuth,
  fetchGcpApiJson,
  type ApiError as GcpTransportError,
  type GcpResolvedAuth,
} from '../cloud-workspaces/gcp-preflight';
import type {
  GcpComputeDiskStatus,
  GcpComputeInstanceStatus,
  GcpComputeSnapshotStatus,
  GcpDiskInsertInput,
  GcpDiskObservation,
  GcpFirewallInsertInput,
  GcpFirewallObservation,
  GcpInstanceInsertInput,
  GcpInstanceMetadataInput,
  GcpInstanceGuestAttribute,
  GcpInstanceObservation,
  GcpNatInsertInput,
  GcpNatObservation,
  GcpNetworkInsertInput,
  GcpOperationObservation,
  GcpOperationRef,
  GcpResourceObservation,
  GcpRouterInsertInput,
  GcpRouterObservation,
  GcpSnapshotInsertInput,
  GcpSnapshotObservation,
  GcpSubnetworkInsertInput,
  GcpWorkspaceHostApiClient,
  GcpWorkspaceHostInventoryRequest,
  GcpWorkspaceHostInventorySnapshot,
} from './gcp-provider';
import { GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS, gcpWorkspaceHostLabelValue } from './gcp-safety';

const COMPUTE_API = 'https://compute.googleapis.com/compute/v1';
const BIGQUERY_API = 'https://bigquery.googleapis.com/bigquery/v2';
const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BIGQUERY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const BIGQUERY_LOCATION = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
const GCP_LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const GCP_LABEL_VALUE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const CANONICAL_UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;

/** Hard product ceiling for one billing-export query. */
export const GCP_BILLING_EXPORT_MAX_BYTES_BILLED = 10_000_000_000n;

export interface GcpBillingExportDescriptor {
  readonly schemaVersion: 'gcp-billing-export-v1';
  /** Project that owns the export table and is billed for the query job. */
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly location?: string;
  /** Resource-label key whose value is the immutable Papercusp run id. */
  readonly labelKey: string;
  /** BigQuery maximumBytesBilled, kept as an exact decimal string. */
  readonly maximumBytesBilled: string;
}

export interface GcpBillingExportReadInput {
  readonly descriptor?: unknown;
  readonly runId: string;
  readonly usageStartAt: string;
  readonly usageEndAt: string;
}

export type GcpBillingExportRetryReason =
  | 'missing-config'
  | 'invalid-config'
  | 'permission'
  | 'rate-limited'
  | 'transport'
  | 'query-rejected'
  | 'query-pending'
  | 'no-data'
  | 'malformed-result'
  | 'multiple-currencies';

export type GcpBillingExportReadResult =
  | {
      readonly status: 'observed';
      readonly retryable: false;
      readonly observation: WorkspaceHostSpendObservation;
      readonly jobReference: { readonly projectId: string; readonly jobId: string; readonly location?: string };
      readonly totalBytesProcessed?: string;
      readonly cacheHit?: boolean;
    }
  | {
      readonly status: 'retryable';
      readonly retryable: true;
      readonly reason: GcpBillingExportRetryReason;
      readonly jobReference?: { readonly projectId: string; readonly jobId: string; readonly location?: string };
    };

export interface GcpBillingExportReaderOptions {
  acquireAuth?: () => Promise<GcpResolvedAuth>;
  fetch?: typeof fetch;
  now?: () => string;
}

interface RawBigQueryQueryResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  totalBytesProcessed?: string;
  cacheHit?: boolean;
  pageToken?: string;
  errors?: unknown[];
  schema?: { fields?: Array<{ name?: string; type?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function descriptorString(
  value: Record<string, unknown>,
  key: keyof GcpBillingExportDescriptor,
  pattern: RegExp,
): string {
  const candidate = typeof value[key] === 'string' ? value[key].trim() : '';
  if (!pattern.test(candidate)) throw new Error(`gcp_billing_export_${key}_invalid`);
  return candidate;
}

/** Validate the only provider-controlled identifiers interpolated into GoogleSQL. */
export function parseGcpBillingExportDescriptor(value: unknown): GcpBillingExportDescriptor {
  if (!record(value) || value.schemaVersion !== 'gcp-billing-export-v1') {
    throw new Error('gcp_billing_export_descriptor_invalid');
  }
  const projectId = descriptorString(value, 'projectId', GCP_PROJECT_ID);
  const datasetId = descriptorString(value, 'datasetId', BIGQUERY_IDENTIFIER);
  const tableId = descriptorString(value, 'tableId', BIGQUERY_IDENTIFIER);
  const labelKey = descriptorString(value, 'labelKey', GCP_LABEL_KEY);
  const maximumBytesBilled = descriptorString(value, 'maximumBytesBilled', CANONICAL_UNSIGNED_INTEGER);
  const maximum = BigInt(maximumBytesBilled);
  if (maximum <= 0n || maximum > GCP_BILLING_EXPORT_MAX_BYTES_BILLED) {
    throw new Error('gcp_billing_export_maximumBytesBilled_out_of_range');
  }
  const location = value.location === undefined ? undefined : descriptorString(value, 'location', BIGQUERY_LOCATION);
  return {
    schemaVersion: 'gcp-billing-export-v1',
    projectId,
    datasetId,
    tableId,
    ...(location ? { location } : {}),
    labelKey,
    maximumBytesBilled,
  };
}

function timestamp(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) throw new Error(`gcp_billing_export_${label}_invalid`);
  return normalized;
}

function billingQuery(descriptor: GcpBillingExportDescriptor): string {
  const table = `${descriptor.projectId}.${descriptor.datasetId}.${descriptor.tableId}`;
  return [
    'WITH totals AS (',
    '  SELECT',
    '    currency,',
    '    CAST(ROUND(SUM(cost) * 1000000) AS INT64) AS gross_micros,',
    '    CAST(ROUND(SUM(IFNULL((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit), 0)) * 1000000) AS INT64) AS credit_micros',
    `  FROM \`${table}\``,
    '  WHERE usage_start_time >= @usage_start_at',
    '    AND usage_start_time < @usage_end_at',
    '    AND EXISTS (SELECT 1 FROM UNNEST(labels) AS label WHERE label.key = @label_key AND label.value = @run_id)',
    '  GROUP BY currency',
    ')',
    'SELECT currency, gross_micros, credit_micros, gross_micros + credit_micros AS net_micros',
    'FROM totals',
    'ORDER BY currency',
  ].join('\n');
}

function retryable(reason: GcpBillingExportRetryReason): GcpBillingExportReadResult {
  return { status: 'retryable', retryable: true, reason };
}

function queryJobReference(
  value: RawBigQueryQueryResponse['jobReference'],
): { projectId: string; jobId: string; location?: string } | undefined {
  const projectId = value?.projectId?.trim();
  const jobId = value?.jobId?.trim();
  if (!projectId || !jobId) return undefined;
  const location = value?.location?.trim();
  return { projectId, jobId, ...(location ? { location } : {}) };
}

function classifyBillingError(error: unknown): GcpBillingExportRetryReason {
  const status = (error as GcpHttpError | undefined)?.status;
  if ((error as GcpHttpError | undefined)?.throttled === true || status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'permission';
  if (status === 400) return 'query-rejected';
  return 'transport';
}

/** Read one cumulative run-cost snapshot from the supported Cloud Billing export. */
export class GoogleBigQueryBillingExportReader {
  private readonly acquireAuth: () => Promise<GcpResolvedAuth>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;

  constructor(options: GcpBillingExportReaderOptions = {}) {
    this.acquireAuth = options.acquireAuth ?? acquireGcpAdcAuth;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async read(input: GcpBillingExportReadInput): Promise<GcpBillingExportReadResult> {
    if (input.descriptor === undefined) return retryable('missing-config');
    let descriptor: GcpBillingExportDescriptor;
    let usageStartAt: string;
    let usageEndAt: string;
    try {
      descriptor = parseGcpBillingExportDescriptor(input.descriptor);
      if (!GCP_LABEL_VALUE.test(input.runId)) throw new Error('gcp_billing_export_run_id_invalid');
      usageStartAt = timestamp(input.usageStartAt, 'usage_start_at');
      usageEndAt = timestamp(input.usageEndAt, 'usage_end_at');
      if (Date.parse(usageEndAt) <= Date.parse(usageStartAt)) {
        throw new Error('gcp_billing_export_usage_window_invalid');
      }
    } catch {
      return retryable('invalid-config');
    }

    let raw: RawBigQueryQueryResponse;
    try {
      const auth = await this.acquireAuth();
      raw = await fetchGcpApiJson<RawBigQueryQueryResponse>(
        this.fetchImpl,
        auth.accessToken,
        `${BIGQUERY_API}/projects/${encodeURIComponent(descriptor.projectId)}/queries`,
        {
          method: 'POST',
          body: JSON.stringify({
            query: billingQuery(descriptor),
            useLegacySql: false,
            parameterMode: 'NAMED',
            maximumBytesBilled: descriptor.maximumBytesBilled,
            maxResults: '2',
            timeoutMs: 10_000,
            ...(descriptor.location ? { location: descriptor.location } : {}),
            queryParameters: [
              { name: 'usage_start_at', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: usageStartAt } },
              { name: 'usage_end_at', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: usageEndAt } },
              { name: 'label_key', parameterType: { type: 'STRING' }, parameterValue: { value: descriptor.labelKey } },
              { name: 'run_id', parameterType: { type: 'STRING' }, parameterValue: { value: input.runId } },
            ],
          }),
        },
      );
    } catch (error) {
      return retryable(classifyBillingError(error));
    }

    const jobReference = queryJobReference(raw.jobReference);
    if (raw.jobComplete !== true) {
      return {
        status: 'retryable',
        retryable: true,
        reason: 'query-pending',
        ...(jobReference ? { jobReference } : {}),
      };
    }
    if (raw.errors?.length) return retryable('query-rejected');
    if (raw.pageToken) return retryable('multiple-currencies');
    if (!jobReference) return retryable('malformed-result');
    // A completed zero-row query is still a provider read: keep its job so the caller can cite it
    // (a canary's preRunZeroBaseline is exactly this read, taken before the run label exists).
    if (!raw.rows?.length) return { ...retryable('no-data'), jobReference };
    if (raw.rows.length !== 1) return retryable('multiple-currencies');

    const expectedFields = ['currency:STRING', 'gross_micros:INTEGER', 'credit_micros:INTEGER', 'net_micros:INTEGER'];
    const fields = (raw.schema?.fields ?? []).map(
      ({ name, type }) => `${name ?? ''}:${type === 'INT64' ? 'INTEGER' : (type ?? '')}`,
    );
    const cells = raw.rows[0]?.f?.map(({ v }) => v);
    if (
      fields.length !== expectedFields.length ||
      fields.some((field, index) => field !== expectedFields[index]) ||
      cells?.length !== expectedFields.length ||
      typeof cells[0] !== 'string' ||
      !/^[A-Z]{3}$/.test(cells[0]) ||
      cells.slice(1).some((cell) => typeof cell !== 'string' || !CANONICAL_INTEGER.test(cell))
    ) {
      return retryable('malformed-result');
    }
    if (
      raw.totalBytesProcessed !== undefined &&
      (!CANONICAL_UNSIGNED_INTEGER.test(raw.totalBytesProcessed) ||
        BigInt(raw.totalBytesProcessed) > BigInt(descriptor.maximumBytesBilled))
    ) {
      return retryable('malformed-result');
    }

    try {
      const observation = createWorkspaceHostSpendObservation({
        currency: cells[0],
        grossMicros: cells[1] as string,
        creditMicros: cells[2] as string,
        netMicros: cells[3] as string,
        observedAt: this.now(),
        providerEvidenceRef: `gcp://bigquery/projects/${jobReference.projectId}/jobs/${jobReference.jobId}`,
      });
      return {
        status: 'observed',
        retryable: false,
        observation,
        jobReference,
        ...(raw.totalBytesProcessed ? { totalBytesProcessed: raw.totalBytesProcessed } : {}),
        ...(typeof raw.cacheHit === 'boolean' ? { cacheHit: raw.cacheHit } : {}),
      };
    } catch {
      return retryable('malformed-result');
    }
  }
}

export function createGcpBillingExportReader(
  options: GcpBillingExportReaderOptions = {},
): GoogleBigQueryBillingExportReader {
  return new GoogleBigQueryBillingExportReader(options);
}

/**
 * The error the shared transport throws. Imported rather than re-declared: a second copy of this
 * shape is how the `throttled` signal came to be read by one classifier and not the other.
 */
type GcpHttpError = GcpTransportError;

const SAFE_CONNECTION_VALIDATION_PROBLEMS: Readonly<Record<string, string>> = {
  gcp_workspace_host_project_id_missing: 'GCP connection project is missing; reconnect with an explicit project.',
  gcp_workspace_host_connection_project_mismatch: 'GCP connection project does not match its selected scope.',
  gcp_workspace_host_scope_must_be_project: 'GCP connection scope must select a project.',
  gcp_workspace_host_cloud_credential_ref_must_use_safe_google_chain:
    'GCP credential reference is not bound to an approved resolver.',
  gcp_workspace_host_service_account_key_forbidden:
    'GCP service-account key credentials are forbidden for this connection.',
  gcp_gcloud_active_user_count_invalid:
    'GCP active-user credential resolution failed: exactly one active gcloud account is required.',
  gcp_gcloud_active_user_unavailable:
    'GCP active-user credential resolution failed: the active gcloud account is unavailable.',
  gcp_gcloud_active_user_service_account_forbidden:
    'GCP active-user credential resolution failed: the active gcloud account must be a human user.',
  gcp_gcloud_active_user_token_unavailable:
    'GCP active-user credential resolution failed: an access token is unavailable.',
  gcp_gcloud_active_user_token_empty: 'GCP active-user credential resolution failed: the access token was empty.',
  gcp_workspace_host_project_unreadable: 'GCP Compute project is unreadable.',
};

interface SafeConnectionValidationProblem {
  readonly message: string;
  /** Transport-class failures are retryable; a settled credential/configuration fault is not. */
  readonly retryable: boolean;
}

/**
 * Map a validation failure to a caller-safe problem string plus a retry classification.
 *
 * Every credential- and configuration-class failure this client can raise carries a code that is
 * present in SAFE_CONNECTION_VALIDATION_PROBLEMS. An error reaching the final branch is therefore
 * NOT a credential fault by construction — it is the Compute API being unreachable, hung up on, or
 * answering with a body we could not read. Reporting those as a credential problem sends the
 * operator to re-check credentials that were never in question, and treating them as terminal
 * fails a lifecycle action that a 2-second retry would have completed.
 */
function safeConnectionValidationProblem(error: unknown): SafeConnectionValidationProblem {
  const status = (error as GcpHttpError | undefined)?.status;
  if (typeof status === 'number') {
    // 401/403 are settled answers about this credential; 408/429/5xx are the API asking us to retry.
    // A throttle is the exception that status alone cannot see: Google rate-limits with 403, so
    // without this a rate-limited validation reports the credential as disproved and fails a
    // lifecycle action that a backoff would have completed.
    const throttled = (error as GcpHttpError | undefined)?.throttled === true;
    return {
      message: throttled
        ? `GCP Compute validation was rate limited (HTTP ${status})`
        : `GCP Compute validation failed (HTTP ${status})`,
      retryable: throttled || status === 408 || status === 429 || status >= 500,
    };
  }
  const code = error instanceof Error ? error.message : '';
  const mapped = SAFE_CONNECTION_VALIDATION_PROBLEMS[code];
  if (mapped) return { message: mapped, retryable: false };
  return {
    message:
      'GCP Compute API was unreachable or returned an unreadable response; the connection itself was not disproved.',
    retryable: true,
  };
}

interface RawOperation {
  name?: string;
  status?: 'PENDING' | 'RUNNING' | 'DONE';
  zone?: string;
  region?: string;
  clientOperationId?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
  /** Set by Compute when the operation failed: the status a synchronous call would have returned. */
  httpErrorStatusCode?: number;
}

interface RawResource {
  name?: string;
  selfLink?: string;
  labels?: Record<string, string>;
}

interface RawDisk extends RawResource {
  status?: GcpComputeDiskStatus;
  users?: string[];
  sizeGb?: string;
  type?: string;
  sourceImage?: string;
  diskEncryptionKey?: { kmsKeyName?: string };
}

interface RawInstance extends RawResource {
  /** uint64, which the Compute API serializes as a decimal string. */
  id?: string;
  status?: GcpComputeInstanceStatus;
  machineType?: string;
  scheduling?: {
    provisioningModel?: string;
    instanceTerminationAction?: string;
    automaticRestart?: boolean;
    onHostMaintenance?: string;
  };
  tags?: { items?: string[] };
  networkInterfaces?: Array<{
    network?: string;
    subnetwork?: string;
    stackType?: 'IPV4_ONLY';
    networkIP?: string;
    accessConfigs?: Array<{
      name?: string;
      type?: 'ONE_TO_ONE_NAT';
      natIP?: string;
      networkTier?: 'PREMIUM';
    }>;
  }>;
  disks?: Array<{
    boot?: boolean;
    autoDelete?: boolean;
    source?: string;
    deviceName?: string;
    mode?: 'READ_WRITE';
  }>;
  serviceAccounts?: Array<{ email?: string; scopes?: string[] }>;
  metadata?: { fingerprint?: string; items?: Array<{ key?: string; value?: string }> };
}

interface RawGuestAttributes {
  queryPath?: string;
  queryValue?: {
    items?: Array<{ namespace?: string; key?: string; value?: string }>;
  };
}

interface RawNat {
  name?: string;
  natIpAllocateOption?: string;
  sourceSubnetworkIpRangesToNat?: string;
  minPortsPerVm?: number;
  enableEndpointIndependentMapping?: boolean;
  subnetworks?: Array<{ name?: string; sourceIpRangesToNat?: string[] }>;
}

interface RawRouter extends RawResource {
  network?: string;
  region?: string;
  fingerprint?: string;
  nats?: RawNat[];
}

interface RawMachineType {
  name?: string;
  guestCpus?: number;
  memoryMb?: number;
  deprecated?: { state?: string };
}

interface RawImage extends RawResource {
  architecture?: string;
  creationTimestamp?: string;
  deprecated?: { state?: string };
  /** GCP reports this as a decimal string, e.g. "32". */
  diskSizeGb?: string;
}

export interface GcpWorkspaceHostApiClientOptions {
  acquireAuth?: () => Promise<GcpResolvedAuth>;
  /** Use only for a client created for one short inspection; never share it across operations. */
  reuseAuthWithinInstance?: boolean;
  /** Exact hosted resolver reference bound to acquireAuth; never a wildcard scheme grant. */
  credentialRef?: string;
  fetch?: typeof fetch;
  now?: () => string;
  /** Resolve this family for discovery, but return only its exact immutable member id. */
  imageFamily?: {
    project: string;
    family: string;
    label?: string;
  };
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`gcp_workspace_host_${label}_missing`);
  return normalized;
}

function segment(value: string, label: string): string {
  return encodeURIComponent(required(value, label));
}

function lastSegment(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\/+$/, '');
  return normalized ? normalized.slice(normalized.lastIndexOf('/') + 1) : undefined;
}

function zoneRegion(zone: string): string {
  const match = required(zone, 'zone').match(/^(.+)-[a-z]$/);
  if (!match?.[1]) throw new Error('gcp_workspace_host_zone_region_invalid');
  return match[1];
}

function resourcePath(value: string, prefix: string): string {
  const normalized = required(value, 'resource_ref');
  return normalized.includes('/') ? normalized : `${prefix}/${normalized}`;
}

function numberValue(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function projectFromConnection(connection: WorkspaceHostProviderConnection, boundCredentialRef?: string): string {
  if (connection.target !== 'gcp') throw new Error(`gcp_workspace_host_target_${connection.target}_invalid`);
  const credentialRef = connection.cloudCredentialRef.ref.trim();
  const local = credentialRef.startsWith('adc://') || credentialRef === GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF;
  if (!local && credentialRef !== boundCredentialRef) {
    throw new Error('gcp_workspace_host_cloud_credential_ref_must_use_safe_google_chain');
  }
  if (connection.scope && connection.scope.kind !== 'project') {
    throw new Error('gcp_workspace_host_scope_must_be_project');
  }
  const providerProject =
    typeof connection.provider?.projectId === 'string' ? connection.provider.projectId.trim() : undefined;
  const scopeProject = connection.scope?.id.trim();
  if (providerProject && scopeProject && providerProject !== scopeProject) {
    throw new Error('gcp_workspace_host_connection_project_mismatch');
  }
  return required(scopeProject || providerProject, 'project_id');
}

function assertCatalogProject(query: WorkspaceHostCatalogQuery, projectId: string): void {
  if (query.scope.kind !== 'project' || query.scope.id !== projectId) {
    throw new Error('gcp_workspace_host_catalog_project_mismatch');
  }
}

function observedResource(raw: RawResource, observedAt: string): GcpResourceObservation {
  return {
    name: required(raw.name, 'resource_name'),
    ...(raw.selfLink ? { selfLink: raw.selfLink } : {}),
    ...(raw.labels ? { labels: raw.labels } : {}),
    observedAt,
  };
}

function attachedNames(users: readonly string[] | undefined): string[] {
  return (users ?? []).map(lastSegment).filter((name): name is string => !!name);
}

/**
 * Operation error codes a backoff clears: the operation-error spelling of the transport's
 * GCP_RATE_LIMIT_REASONS (gcp-preflight.ts). Deliberately NOT `QUOTA_EXCEEDED`, for the same reason
 * the transport excludes `quotaExceeded`: a spent quota does not refill on a retry.
 */
const GCP_OPERATION_THROTTLE_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_OPERATION_RATE_EXCEEDED',
  'RESOURCE_NOT_READY',
]);

function operationError(raw: RawOperation): GcpOperationObservation['error'] | undefined {
  const entries = raw.error?.errors ?? [];
  if (entries.length === 0) return undefined;
  const codes = [...new Set(entries.map(({ code }) => code).filter((code): code is string => !!code))];
  const status = raw.httpErrorStatusCode;
  return {
    ...(codes[0] ? { code: codes[0] } : {}),
    message: codes.length > 0 ? `GCP operation failed (${codes.join(', ')})` : 'GCP operation failed',
    ...(typeof status === 'number' && Number.isInteger(status) ? { status } : {}),
    ...(codes.some((code) => GCP_OPERATION_THROTTLE_CODES.has(code)) ? { throttled: true } : {}),
  };
}

function asOperation(
  raw: RawOperation,
  known: Omit<GcpOperationRef, 'name'> & { name?: string },
  observedAt?: string,
): GcpOperationRef | GcpOperationObservation {
  const scope = raw.zone ? 'zone' : raw.region ? 'region' : known.scope;
  const location = lastSegment(raw.zone ?? raw.region) ?? known.location;
  const common: GcpOperationRef = {
    name: required(raw.name ?? known.name, 'operation_name'),
    projectId: known.projectId,
    scope,
    ...(location ? { location } : {}),
    requestId: known.requestId,
  };
  if (!observedAt) return common;
  return {
    ...common,
    status: raw.status ?? 'PENDING',
    observedAt,
    ...(operationError(raw) ? { error: operationError(raw) } : {}),
  };
}

/** Exported for tests: the insert request that re-creates `raw` with its retained data disk. */
export function recreateInput(
  raw: RawInstance,
  bootDisk: RawDisk | undefined,
  zone: string,
): GcpInstanceInsertInput | undefined {
  const boot = raw.disks?.find((disk) => disk.boot === true);
  const data = raw.disks?.find((disk) => disk.boot !== true);
  const network = raw.networkInterfaces?.[0];
  const account = raw.serviceAccounts?.[0];
  const sourceImage = bootDisk?.sourceImage;
  const bootSize = numberValue(bootDisk?.sizeGb);
  if (
    !raw.name ||
    !raw.machineType ||
    !boot ||
    !data?.source ||
    !data.deviceName ||
    !network?.network ||
    !network.subnetwork ||
    !sourceImage ||
    !bootSize ||
    !bootDisk?.type
  ) {
    return undefined;
  }
  const access = network.accessConfigs?.[0];
  const metadata = (raw.metadata?.items ?? [])
    .filter(
      (item): item is { key: string; value: string } => typeof item.key === 'string' && typeof item.value === 'string',
    )
    .map(({ key, value }) => ({ key, value }));
  return {
    name: raw.name,
    zone,
    machineType: raw.machineType,
    labels: raw.labels ?? {},
    tags: { items: raw.tags?.items ?? [] },
    networkInterfaces: [
      {
        network: network.network,
        subnetwork: network.subnetwork,
        stackType: 'IPV4_ONLY',
        ...(access
          ? {
              accessConfigs: [
                {
                  name: 'External NAT',
                  type: 'ONE_TO_ONE_NAT',
                  networkTier: 'PREMIUM',
                },
              ] as const,
            }
          : {}),
      },
    ],
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage,
          diskSizeGb: bootSize,
          diskType: bootDisk.type,
          ...(bootDisk.diskEncryptionKey?.kmsKeyName
            ? { diskEncryptionKey: { kmsKeyName: bootDisk.diskEncryptionKey.kmsKeyName } }
            : {}),
        },
      },
      {
        boot: false,
        autoDelete: false,
        source: data.source,
        deviceName: data.deviceName,
        mode: 'READ_WRITE',
      },
    ],
    // An instance created without an identity is re-created without one.
    ...(account?.email ? { serviceAccounts: [{ email: account.email, scopes: account.scopes ?? [] }] as const } : {}),
    metadata: { items: metadata },
    // A spot host is re-created as spot, so an upgrade never silently moves it to on-demand.
    ...(raw.scheduling?.provisioningModel === 'SPOT'
      ? {
          scheduling: {
            provisioningModel: 'SPOT',
            instanceTerminationAction: raw.scheduling.instanceTerminationAction === 'DELETE' ? 'DELETE' : 'STOP',
            automaticRestart: false,
            onHostMaintenance: 'TERMINATE',
          } as const,
        }
      : {}),
  };
}

/** ADC-backed, raw-REST implementation of the GCP workspace-host client seam. */
export class GoogleComputeWorkspaceHostApiClient implements GcpWorkspaceHostApiClient {
  private readonly acquireAuth: () => Promise<GcpResolvedAuth>;
  private readonly boundCredentialRef?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly imageFamily: { project: string; family: string; label?: string };

  constructor(options: GcpWorkspaceHostApiClientOptions = {}) {
    const resolveAuth = options.acquireAuth ?? acquireGcpAdcAuth;
    if (options.reuseAuthWithinInstance) {
      let inspectionAuth: Promise<GcpResolvedAuth> | undefined;
      this.acquireAuth = () => (inspectionAuth ??= resolveAuth());
    } else {
      this.acquireAuth = resolveAuth;
    }
    this.boundCredentialRef = options.credentialRef?.trim() || undefined;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    const imageFamily = options.imageFamily ?? GCP_DEFAULT_WORKSPACE_HOST_IMAGE;
    const label = options.imageFamily?.label?.trim();
    this.imageFamily = {
      project: required(imageFamily.project, 'image_project'),
      family: required(imageFamily.family, 'image_family'),
      ...(label ? { label } : {}),
    };
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const auth = await this.acquireAuth();
    return fetchGcpApiJson<T>(this.fetchImpl, auth.accessToken, url, init);
  }

  private async requestWithAuth<T>(auth: GcpResolvedAuth, url: string, init: RequestInit = {}): Promise<T> {
    return fetchGcpApiJson<T>(this.fetchImpl, auth.accessToken, url, init);
  }

  private async getOrUndefined<T>(url: string): Promise<T | undefined> {
    try {
      return await this.request<T>(url);
    } catch (error) {
      if ((error as GcpHttpError).status === 404) return undefined;
      throw error;
    }
  }

  private projectBase(projectId: string): string {
    return `${COMPUTE_API}/projects/${segment(projectId, 'project_id')}`;
  }

  private async mutate(
    projectId: string,
    scope: GcpOperationRef['scope'],
    location: string | undefined,
    requestId: string,
    url: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<GcpOperationRef> {
    const separator = url.includes('?') ? '&' : '?';
    const raw = await this.request<RawOperation>(`${url}${separator}requestId=${segment(requestId, 'request_id')}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return asOperation(raw, { projectId, scope, ...(location ? { location } : {}), requestId }) as GcpOperationRef;
  }

  async validateConnection(connection: WorkspaceHostProviderConnection): Promise<WorkspaceHostConnectionValidation> {
    const checkedAt = this.now();
    try {
      const projectId = projectFromConnection(connection, this.boundCredentialRef);
      const auth = await this.acquireAuth();
      const project = await this.requestWithAuth<{ name?: string }>(auth, `${this.projectBase(projectId)}?fields=name`);
      if (!project.name) throw new Error('gcp_workspace_host_project_unreadable');
      return {
        ok: true,
        checkedAt,
        ...(auth.identity ? { identity: auth.identity } : {}),
        warnings: [],
        errors: [],
      };
    } catch (error) {
      const problem = safeConnectionValidationProblem(error);
      return {
        ok: false,
        checkedAt,
        warnings: [],
        errors: [problem.message],
        retryable: problem.retryable,
      };
    }
  }

  async listScopes(connection: WorkspaceHostProviderConnection): Promise<readonly WorkspaceHostScope[]> {
    const projectId = projectFromConnection(connection, this.boundCredentialRef);
    return [{ kind: 'project', id: projectId, label: projectId }];
  }

  async listRegions(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostRegion[]> {
    const projectId = projectFromConnection(connection, this.boundCredentialRef);
    assertCatalogProject(query, projectId);
    const base = this.projectBase(projectId);
    const [regions, zones] = await Promise.all([
      this.request<{ items?: Array<{ name?: string; status?: string }> }>(
        `${base}/regions?maxResults=500&fields=items(name,status)`,
      ),
      this.request<{ items?: Array<{ name?: string; status?: string; region?: string }> }>(
        `${base}/zones?maxResults=500&fields=items(name,status,region)`,
      ),
    ]);
    return (regions.items ?? [])
      .filter((region): region is { name: string; status?: string } => !!region.name)
      .filter((region) => !query.region || region.name === query.region)
      .map((region) => ({
        id: region.name,
        label: region.name,
        available: region.status === 'UP',
        zones: (zones.items ?? [])
          .filter((zone) => lastSegment(zone.region) === region.name && zone.status === 'UP' && !!zone.name)
          .map((zone) => zone.name!),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listSizes(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostSize[]> {
    const projectId = projectFromConnection(connection, this.boundCredentialRef);
    assertCatalogProject(query, projectId);
    const url = new URL(`${this.projectBase(projectId)}/aggregated/machineTypes`);
    url.searchParams.set('maxResults', '500');
    // The field mask must retain the cursor: the first page may contain only
    // another region, even when the selected region has hundreds of sizes.
    url.searchParams.set('fields', 'nextPageToken,items/*/machineTypes(name,guestCpus,memoryMb,deprecated)');
    if (query.region) {
      if (!/^[a-z][a-z0-9-]*$/.test(query.region)) throw new Error('invalid_region');
      // Filter at GCP as well as below so a regional catalog does not need to
      // transfer every machine type in every zone worldwide.
      url.searchParams.set('filter', `zone eq .*${query.region}-.*`);
    }
    const sizes = new Map<string, WorkspaceHostSize>();
    const seenPageTokens = new Set<string>();
    for (;;) {
      const result = await this.request<{
        items?: Record<string, { machineTypes?: RawMachineType[] }>;
        nextPageToken?: string;
      }>(url.toString());
      for (const [scope, group] of Object.entries(result.items ?? {})) {
        const zone = scope.startsWith('zones/') ? scope.slice('zones/'.length) : undefined;
        if (!zone || (query.region && !zone.startsWith(`${query.region}-`))) continue;
        for (const raw of group.machineTypes ?? []) {
          if (!raw.name || !Number.isFinite(raw.guestCpus) || !Number.isFinite(raw.memoryMb)) continue;
          const available = !raw.deprecated || raw.deprecated.state === 'ACTIVE';
          const current = sizes.get(raw.name);
          sizes.set(raw.name, {
            id: raw.name,
            label: raw.name,
            cpuCount: Number(raw.guestCpus),
            memoryMiB: Number(raw.memoryMb),
            available: available || current?.available === true,
            ...(available ? {} : { constraints: [`Deprecated by GCP (${raw.deprecated?.state ?? 'unknown'})`] }),
          });
        }
      }
      if (!result.nextPageToken) break;
      if (seenPageTokens.has(result.nextPageToken)) throw new Error('gcp_machine_type_pagination_cycle');
      seenPageTokens.add(result.nextPageToken);
      url.searchParams.set('pageToken', result.nextPageToken);
    }
    return [...sizes.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async listImages(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostImage[]> {
    const projectId = projectFromConnection(connection, this.boundCredentialRef);
    assertCatalogProject(query, projectId);
    const image = await this.request<RawImage>(
      `${COMPUTE_API}/projects/${segment(this.imageFamily.project, 'image_project')}/global/images/family/${segment(this.imageFamily.family, 'image_family')}`,
    );
    const architecture =
      image.architecture === 'ARM64' ? 'arm64' : image.architecture === 'X86_64' ? 'x86_64' : undefined;
    if (query.architecture && architecture && query.architecture !== architecture) return [];
    const name = required(image.name, 'image_name');
    return [
      {
        id: `projects/${this.imageFamily.project}/global/images/${name}`,
        version: name,
        label:
          this.imageFamily.label ??
          (this.imageFamily.project === GCP_DEFAULT_WORKSPACE_HOST_IMAGE.project &&
          this.imageFamily.family === GCP_DEFAULT_WORKSPACE_HOST_IMAGE.family
            ? `Ubuntu 24.04 LTS (${name})`
            : `${this.imageFamily.family} (${name})`),
        ...(architecture ? { architecture } : {}),
        signed: true,
        ...(image.creationTimestamp ? { publishedAt: image.creationTimestamp } : {}),
        ...(image.deprecated ? { deprecated: image.deprecated.state !== 'ACTIVE' } : {}),
      },
    ];
  }

  /**
   * Read the source image's minimum boot-disk size for admission-time provisioning validation.
   * Unlike the mutation-time fallback below, this method is strict: a plan must not begin
   * creating network or data-disk resources when the image floor cannot be established.
   */
  async getImageDiskSizeGb(sourceImage: string): Promise<number> {
    const ref = required(sourceImage, 'source_image');
    const url = /^https?:\/\//.test(ref) ? ref : `${COMPUTE_API}/${ref.replace(/^\/+/, '')}`;
    const image = await this.request<RawImage>(url);
    const diskSizeGb = numberValue(image.diskSizeGb);
    if (diskSizeGb === undefined || diskSizeGb <= 0) {
      throw new Error(`GCP source image '${ref}' did not report a valid disk size`);
    }
    return diskSizeGb;
  }

  async estimatePrice(
    _desired: WorkspaceHostDesiredSpec,
    _connection: WorkspaceHostProviderConnection,
  ): Promise<WorkspaceHostPriceEstimate> {
    return {
      currency: 'USD',
      hourlyAmount: 0,
      observedAt: this.now(),
      confidence: 'unknown',
      lineItems: [{ kind: 'provider-pricing', description: 'Authoritative GCP pricing unavailable', hourlyAmount: 0 }],
    };
  }

  async inventoryManagedResources(
    request: GcpWorkspaceHostInventoryRequest,
  ): Promise<GcpWorkspaceHostInventorySnapshot> {
    const projectId = required(request.projectId, 'inventory_project_id');
    const region = required(request.region, 'inventory_region');
    const workspaceLabel = gcpWorkspaceHostLabelValue(required(request.workspaceId, 'inventory_workspace_id'));
    for (const [kind, names] of Object.entries(request.deterministicNames)) {
      if (names.length === 0) throw new Error(`gcp_workspace_host_inventory_${kind}_names_empty`);
    }
    const filter = encodeURIComponent(
      `labels.${GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed} = true AND ` +
        `labels.${GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId} = ${workspaceLabel}`,
    );
    const base = this.projectBase(projectId);
    const instancesUrl = `${base}/aggregated/instances?filter=${filter}&maxResults=500&fields=nextPageToken,items/*/instances(name,selfLink,labels)`;
    const disksUrl = `${base}/aggregated/disks?filter=${filter}&maxResults=500&fields=nextPageToken,items/*/disks(name,selfLink,labels)`;
    const snapshotsUrl = `${base}/global/snapshots?filter=${filter}&maxResults=500&fields=nextPageToken,items(name,selfLink,labels)`;
    // Completeness is a teardown safety claim. Preserve the cursor in the field mask and exhaust
    // each collection, including empty intermediate pages, before making that claim.
    const readPages = async <T>(initialUrl: string): Promise<T[]> => {
      const url = new URL(initialUrl);
      const pages: T[] = [];
      const seen = new Set<string>();
      for (;;) {
        const page = await this.request<T & { nextPageToken?: string }>(url.toString());
        pages.push(page);
        if (!page.nextPageToken) return pages;
        if (seen.has(page.nextPageToken)) throw new Error('gcp_inventory_pagination_cycle');
        seen.add(page.nextPageToken);
        url.searchParams.set('pageToken', page.nextPageToken);
      }
    };
    const [instances, disks, snapshots] = await Promise.all([
      readPages<{ items?: Record<string, { instances?: RawResource[] }> }>(instancesUrl),
      readPages<{ items?: Record<string, { disks?: RawResource[] }> }>(disksUrl),
      readPages<{ items?: RawResource[] }>(snapshotsUrl),
    ]);
    const observedAt = this.now();
    const observed: GcpWorkspaceHostInventorySnapshot['observed'][number][] = [];
    const addListed = (
      kind: 'vm' | 'disk',
      groups: Record<string, { instances?: RawResource[]; disks?: RawResource[] }> | undefined,
      collection: 'instances' | 'disks',
    ) => {
      for (const [scope, group] of Object.entries(groups ?? {})) {
        const zone = scope.startsWith('zones/') ? scope.slice('zones/'.length) : undefined;
        if (!zone) continue;
        for (const raw of group[collection] ?? []) {
          const item = observedResource(raw, observedAt);
          observed.push({
            resource: { target: 'gcp', kind, providerId: item.name, parentProviderId: projectId, zone },
            labels: item.labels ?? {},
            observedAt,
          });
        }
      }
    };
    for (const page of instances) addListed('vm', page.items, 'instances');
    for (const page of disks) addListed('disk', page.items, 'disks');
    for (const raw of snapshots.flatMap((page) => page.items ?? [])) {
      const item = observedResource(raw, observedAt);
      observed.push({
        resource: { target: 'gcp', kind: 'snapshot', providerId: item.name, parentProviderId: projectId },
        labels: item.labels ?? {},
        observedAt,
      });
    }

    const addDeterministic = (
      kind: 'network' | 'subnetwork' | 'firewall' | 'router' | 'nat',
      name: string,
      item: GcpResourceObservation | undefined,
    ) => {
      if (!item) return;
      observed.push({
        resource: {
          target: 'gcp',
          kind,
          providerId: name,
          parentProviderId: projectId,
          ...(kind === 'network' || kind === 'firewall' ? {} : { region }),
        },
        labels: item.labels ?? {},
        observedAt: item.observedAt,
      });
    };
    const deterministicReads = await Promise.all([
      ...request.deterministicNames.networks.map(async (name) =>
        addDeterministic('network', name, await this.getNetwork(projectId, name)),
      ),
      ...request.deterministicNames.subnetworks.map(async (name) =>
        addDeterministic('subnetwork', name, await this.getSubnetwork(projectId, region, name)),
      ),
      ...request.deterministicNames.firewalls.map(async (name) =>
        addDeterministic('firewall', name, await this.getFirewall(projectId, name)),
      ),
      ...request.deterministicNames.routers.map(async (name) =>
        addDeterministic('router', name, await this.getRouter(projectId, region, name)),
      ),
      ...request.deterministicNames.nats.map(async ({ routerName, name }) =>
        addDeterministic('nat', name, await this.getNat(projectId, region, routerName, name)),
      ),
    ]);
    void deterministicReads;
    const deterministicEvidence = (
      kind: 'firewall' | 'subnetwork' | 'network' | 'router' | 'nat',
      names: readonly string[],
    ) => ({
      kind,
      strategy: 'deterministic-name' as const,
      providerEvidenceRef: `gcp://compute/projects/${projectId}/${kind}-inventory/${names.join(',')}`,
      deterministicNames: [...names],
    });
    return {
      complete: true,
      observed,
      inventoryEvidence: [
        { kind: 'vm', strategy: 'managed-labels', providerEvidenceRef: instancesUrl },
        { kind: 'disk', strategy: 'managed-labels', providerEvidenceRef: disksUrl },
        deterministicEvidence('firewall', request.deterministicNames.firewalls),
        deterministicEvidence('subnetwork', request.deterministicNames.subnetworks),
        deterministicEvidence('network', request.deterministicNames.networks),
        { kind: 'snapshot', strategy: 'managed-labels', providerEvidenceRef: snapshotsUrl },
        deterministicEvidence('router', request.deterministicNames.routers),
        deterministicEvidence(
          'nat',
          request.deterministicNames.nats.map(({ name }) => name),
        ),
      ],
    };
  }

  async getNetwork(projectId: string, name: string): Promise<GcpResourceObservation | undefined> {
    const raw = await this.getOrUndefined<RawResource>(
      `${this.projectBase(projectId)}/global/networks/${segment(name, 'network_name')}`,
    );
    return raw ? observedResource(raw, this.now()) : undefined;
  }

  async getSubnetwork(projectId: string, region: string, name: string): Promise<GcpResourceObservation | undefined> {
    const raw = await this.getOrUndefined<RawResource>(
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/subnetworks/${segment(name, 'subnetwork_name')}`,
    );
    return raw ? observedResource(raw, this.now()) : undefined;
  }

  async getFirewall(projectId: string, name: string): Promise<GcpFirewallObservation | undefined> {
    const raw = await this.getOrUndefined<
      RawResource & {
        direction?: 'INGRESS';
        sourceRanges?: string[];
        targetTags?: string[];
        allowed?: Array<{ IPProtocol?: string; ports?: string[] }>;
      }
    >(`${this.projectBase(projectId)}/global/firewalls/${segment(name, 'firewall_name')}`);
    if (!raw) return undefined;
    if (raw.direction !== 'INGRESS') throw new Error('gcp_workspace_host_firewall_direction_invalid');
    return {
      ...observedResource(raw, this.now()),
      direction: 'INGRESS',
      sourceRanges: raw.sourceRanges ?? [],
      targetTags: raw.targetTags ?? [],
      allowed: (raw.allowed ?? [])
        .filter((rule): rule is { IPProtocol: 'tcp'; ports?: string[] } => rule.IPProtocol === 'tcp')
        .map((rule) => ({
          IPProtocol: 'tcp',
          ports: rule.ports ?? [],
        })) as unknown as GcpFirewallObservation['allowed'],
    };
  }

  private getRawRouter(projectId: string, region: string, name: string): Promise<RawRouter | undefined> {
    return this.getOrUndefined<RawRouter>(
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/routers/${segment(name, 'router_name')}`,
    );
  }

  async getRouter(projectId: string, region: string, name: string): Promise<GcpRouterObservation | undefined> {
    const raw = await this.getRawRouter(projectId, region, name);
    if (!raw) return undefined;
    return {
      ...observedResource(raw, this.now()),
      network: required(lastSegment(raw.network), 'router_network'),
      region,
      natNames: (raw.nats ?? []).map(({ name: natName }) => required(natName, 'nat_name')),
    };
  }

  async getNat(
    projectId: string,
    region: string,
    routerName: string,
    name: string,
  ): Promise<GcpNatObservation | undefined> {
    const router = await this.getRawRouter(projectId, region, routerName);
    const nat = router?.nats?.find((candidate) => candidate.name === name);
    if (!router || !nat) return undefined;
    if (
      nat.natIpAllocateOption !== 'AUTO_ONLY' ||
      nat.sourceSubnetworkIpRangesToNat !== 'LIST_OF_SUBNETWORKS' ||
      nat.minPortsPerVm !== 64 ||
      nat.enableEndpointIndependentMapping !== false ||
      nat.subnetworks?.length !== 1 ||
      nat.subnetworks[0]?.sourceIpRangesToNat?.length !== 1 ||
      nat.subnetworks[0]?.sourceIpRangesToNat?.[0] !== 'ALL_IP_RANGES'
    ) {
      throw new Error('gcp_workspace_host_nat_policy_invalid');
    }
    const subnetwork = required(lastSegment(nat.subnetworks?.[0]?.name), 'nat_subnetwork');
    return {
      name: required(nat.name, 'nat_name'),
      selfLink:
        `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/routers/` +
        `${segment(routerName, 'router_name')}/nats/${segment(name, 'nat_name')}`,
      observedAt: this.now(),
      routerName,
      network: required(lastSegment(router.network), 'router_network'),
      subnetwork,
      region,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
    };
  }

  async getDisk(projectId: string, zone: string, name: string): Promise<GcpDiskObservation | undefined> {
    const raw = await this.getOrUndefined<RawDisk>(
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks/${segment(name, 'disk_name')}`,
    );
    if (!raw) return undefined;
    return {
      ...observedResource(raw, this.now()),
      status: raw.status ?? 'CREATING',
      attachedInstanceNames: attachedNames(raw.users),
      ...(numberValue(raw.sizeGb) !== undefined ? { sizeGb: numberValue(raw.sizeGb) } : {}),
    };
  }

  async getInstance(projectId: string, zone: string, name: string): Promise<GcpInstanceObservation | undefined> {
    const raw = await this.getOrUndefined<RawInstance>(
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances/${segment(name, 'instance_name')}`,
    );
    if (!raw) return undefined;
    const bootName = lastSegment(raw.disks?.find((disk) => disk.boot === true)?.source);
    const bootDisk = bootName
      ? await this.getOrUndefined<RawDisk>(
          `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks/${segment(bootName, 'boot_disk_name')}`,
        )
      : undefined;
    const recreated = recreateInput(raw, bootDisk, zone);
    const model = raw.scheduling?.provisioningModel;
    return {
      ...observedResource(raw, this.now()),
      ...(model === 'SPOT' || model === 'STANDARD' ? { provisioningModel: model } : {}),
      status: raw.status ?? 'PROVISIONING',
      ...(raw.id !== undefined && raw.id !== null ? { instanceId: String(raw.id) } : {}),
      attachedDiskNames: (raw.disks ?? [])
        .map(({ source }) => lastSegment(source))
        .filter((item): item is string => !!item),
      ...(raw.networkInterfaces?.[0]?.networkIP ? { internalIp: raw.networkInterfaces[0].networkIP } : {}),
      ...(raw.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
        ? { externalIp: raw.networkInterfaces[0].accessConfigs[0].natIP }
        : {}),
      ...(bootDisk?.sourceImage ? { sourceImage: bootDisk.sourceImage } : {}),
      ...(raw.metadata?.fingerprint ? { metadataFingerprint: raw.metadata.fingerprint } : {}),
      ...(recreated ? { recreateInput: recreated } : {}),
    };
  }

  async getInstanceGuestAttributes(
    projectId: string,
    zone: string,
    name: string,
    queryPath: string,
  ): Promise<readonly GcpInstanceGuestAttribute[]> {
    const path = required(queryPath, 'guest_attribute_query_path');
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) {
      throw new Error('guest_attribute_query_path has an invalid value');
    }
    const raw = await this.request<RawGuestAttributes>(
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances/${segment(name, 'instance_name')}` +
        `/getGuestAttributes?queryPath=${encodeURIComponent(path)}`,
    );
    return (raw.queryValue?.items ?? []).map((item, index) => ({
      namespace: required(item.namespace, `guest attribute namespace ${index}`),
      key: required(item.key, `guest attribute key ${index}`),
      value: required(item.value, `guest attribute value ${index}`),
    }));
  }

  async getSnapshot(projectId: string, name: string): Promise<GcpSnapshotObservation | undefined> {
    const raw = await this.getOrUndefined<
      RawResource & { status?: GcpComputeSnapshotStatus; sourceDisk?: string; creationTimestamp?: string }
    >(`${this.projectBase(projectId)}/global/snapshots/${segment(name, 'snapshot_name')}`);
    if (!raw) return undefined;
    const sourceDisk = lastSegment(raw.sourceDisk);
    return {
      ...observedResource(raw, this.now()),
      status: raw.status ?? 'CREATING',
      ...(sourceDisk ? { sourceDisk } : {}),
      ...(raw.creationTimestamp ? { createdAt: raw.creationTimestamp } : {}),
    };
  }

  insertNetwork(projectId: string, input: GcpNetworkInsertInput, requestId: string): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'global',
      undefined,
      requestId,
      `${this.projectBase(projectId)}/global/networks`,
      'POST',
      input,
    );
  }

  insertSubnetwork(
    projectId: string,
    region: string,
    input: GcpSubnetworkInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const { region: _region, ...body } = input;
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/subnetworks`,
      'POST',
      { ...body, network: resourcePath(body.network, 'global/networks') },
    );
  }

  insertFirewall(projectId: string, input: GcpFirewallInsertInput, requestId: string): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'global',
      undefined,
      requestId,
      `${this.projectBase(projectId)}/global/firewalls`,
      'POST',
      { ...input, network: resourcePath(input.network, 'global/networks') },
    );
  }

  insertRouter(
    projectId: string,
    region: string,
    input: GcpRouterInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const { region: _region, ...body } = input;
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/routers`,
      'POST',
      { ...body, network: resourcePath(body.network, 'global/networks') },
    );
  }

  async insertNat(
    projectId: string,
    region: string,
    input: GcpNatInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const router = await this.getRawRouter(projectId, region, input.routerName);
    if (!router) throw new Error(`gcp_workspace_host_router_${input.routerName}_missing`);
    const otherNats = (router.nats ?? []).filter(({ name }) => name !== input.name);
    if (otherNats.length > 0) throw new Error('gcp_workspace_host_managed_router_contains_foreign_nat');
    const body = {
      name: input.routerName,
      network: resourcePath(input.network, 'global/networks'),
      ...(router.fingerprint ? { fingerprint: router.fingerprint } : {}),
      nats: [
        {
          name: input.name,
          natIpAllocateOption: input.natIpAllocateOption,
          sourceSubnetworkIpRangesToNat: input.sourceSubnetworkIpRangesToNat,
          minPortsPerVm: input.minPortsPerVm,
          enableEndpointIndependentMapping: input.enableEndpointIndependentMapping,
          subnetworks: [
            {
              name: resourcePath(input.subnetwork, `regions/${region}/subnetworks`),
              sourceIpRangesToNat: ['ALL_IP_RANGES'],
            },
          ],
        },
      ],
    };
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/routers/${segment(input.routerName, 'router_name')}`,
      'PATCH',
      body,
    );
  }

  insertDisk(projectId: string, zone: string, input: GcpDiskInsertInput, requestId: string): Promise<GcpOperationRef> {
    const { zone: _zone, type, sourceSnapshot, ...rest } = input;
    const body = {
      ...rest,
      type: resourcePath(type, `zones/${zone}/diskTypes`),
      ...(sourceSnapshot ? { sourceSnapshot: resourcePath(sourceSnapshot, 'global/snapshots') } : {}),
    };
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks`,
      'POST',
      body,
    );
  }

  /**
   * The source image's own size, which is the hard floor for any boot disk created from it.
   *
   * Derived rather than configured on purpose: GCP rejects a boot disk smaller than its image, so
   * a hardcoded default silently becomes un-provisionable the moment the image outgrows it — which
   * is exactly what happened when the 30 GiB default met a 32 GiB workspace-host image. Reading it
   * from the image keeps the floor correct as the image grows. Returns undefined when the image
   * cannot be read, so an unrelated lookup failure never blocks a provision that would succeed.
   */
  private async sourceImageDiskSizeGb(sourceImage: string): Promise<number | undefined> {
    try {
      return await this.getImageDiskSizeGb(sourceImage);
    } catch {
      return undefined;
    }
  }

  async insertInstance(
    projectId: string,
    zone: string,
    input: GcpInstanceInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const { zone: _zone, ...rest } = input;
    const region = zoneRegion(zone);
    const bootParams = rest.disks[0].initializeParams;
    // Never shrink a caller's larger request — only raise it to the image's floor.
    const imageFloorGb = await this.sourceImageDiskSizeGb(bootParams.sourceImage);
    const bootDiskSizeGb =
      imageFloorGb === undefined ? bootParams.diskSizeGb : Math.max(bootParams.diskSizeGb, imageFloorGb);
    const body = {
      ...rest,
      machineType: resourcePath(rest.machineType, `zones/${zone}/machineTypes`),
      networkInterfaces: rest.networkInterfaces.map((network) => ({
        ...network,
        network: resourcePath(network.network, 'global/networks'),
        subnetwork: resourcePath(network.subnetwork, `regions/${region}/subnetworks`),
      })),
      disks: [
        {
          ...rest.disks[0],
          initializeParams: {
            ...bootParams,
            diskSizeGb: bootDiskSizeGb,
            diskType: resourcePath(bootParams.diskType, `zones/${zone}/diskTypes`),
          },
        },
        { ...rest.disks[1], source: resourcePath(rest.disks[1].source, `zones/${zone}/disks`) },
      ],
    };
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances`,
      'POST',
      body,
    );
  }

  createSnapshot(
    projectId: string,
    zone: string,
    input: GcpSnapshotInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const { sourceDisk, ...body } = input;
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks/${segment(sourceDisk, 'source_disk')}/createSnapshot`,
      'POST',
      body,
    );
  }

  startInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.instanceAction(projectId, zone, name, requestId, 'start');
  }

  stopInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.instanceAction(projectId, zone, name, requestId, 'stop');
  }

  resetInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.instanceAction(projectId, zone, name, requestId, 'reset');
  }

  setInstanceMetadata(
    projectId: string,
    zone: string,
    name: string,
    input: GcpInstanceMetadataInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances/${segment(name, 'instance_name')}/setMetadata`,
      'POST',
      input,
    );
  }

  private instanceAction(
    projectId: string,
    zone: string,
    name: string,
    requestId: string,
    action: 'start' | 'stop' | 'reset',
  ): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances/${segment(name, 'instance_name')}/${action}`,
      'POST',
    );
  }

  deleteInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteZonal(projectId, zone, 'instances', name, requestId);
  }

  deleteDisk(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteZonal(projectId, zone, 'disks', name, requestId);
  }

  private deleteZonal(
    projectId: string,
    zone: string,
    collection: 'instances' | 'disks',
    name: string,
    requestId: string,
  ): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/${collection}/${segment(name, 'resource_name')}`,
      'DELETE',
    );
  }

  deleteFirewall(projectId: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteGlobal(projectId, 'firewalls', name, requestId);
  }

  deleteNetwork(projectId: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteGlobal(projectId, 'networks', name, requestId);
  }

  async deleteNat(
    projectId: string,
    region: string,
    routerName: string,
    name: string,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const router = await this.getRawRouter(projectId, region, routerName);
    if (!router) throw new Error(`gcp_workspace_host_router_${routerName}_missing`);
    const nats = (router.nats ?? []).filter(({ name: candidate }) => candidate !== name);
    const body = {
      name: routerName,
      network: required(router.network, 'router_network'),
      ...(router.fingerprint ? { fingerprint: router.fingerprint } : {}),
      nats,
    };
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/routers/${segment(routerName, 'router_name')}`,
      'PATCH',
      body,
    );
  }

  deleteRouter(projectId: string, region: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/routers/${segment(name, 'router_name')}`,
      'DELETE',
    );
  }

  private deleteGlobal(
    projectId: string,
    collection: 'firewalls' | 'networks',
    name: string,
    requestId: string,
  ): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'global',
      undefined,
      requestId,
      `${this.projectBase(projectId)}/global/${collection}/${segment(name, 'resource_name')}`,
      'DELETE',
    );
  }

  deleteSubnetwork(projectId: string, region: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/subnetworks/${segment(name, 'subnetwork_name')}`,
      'DELETE',
    );
  }

  async waitForOperation(operation: GcpOperationRef, signal?: AbortSignal): Promise<GcpOperationObservation> {
    const scopePath =
      operation.scope === 'global'
        ? 'global/operations'
        : operation.scope === 'region'
          ? `regions/${segment(required(operation.location, 'operation_region'), 'operation_region')}/operations`
          : `zones/${segment(required(operation.location, 'operation_zone'), 'operation_zone')}/operations`;
    const raw = await this.request<RawOperation>(
      `${this.projectBase(operation.projectId)}/${scopePath}/${segment(operation.name, 'operation_name')}/wait`,
      { method: 'POST', signal },
    );
    return asOperation(raw, operation, this.now()) as GcpOperationObservation;
  }
}

export function createGcpWorkspaceHostApiClient(
  options: GcpWorkspaceHostApiClientOptions = {},
): GoogleComputeWorkspaceHostApiClient {
  return new GoogleComputeWorkspaceHostApiClient(options);
}
