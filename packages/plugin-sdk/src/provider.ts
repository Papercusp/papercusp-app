/**
 * Integration provider contract (generalized-integrations-google-migration-
 * cupboard-workflows-2026-10-05, D-006 / P-001).
 *
 * A provider is a plugin that declares a `provider` descriptor in its
 * manifest and implements a small request/response adapter. The descriptor is
 * pure data (validated at load and install time); the adapter is code. The
 * host owns everything stateful — connections, credentials, leases, cursors,
 * retry, health, receipts and grants. The provider owns HTTP details,
 * pagination and the mapping into canonical records.
 *
 * Providers never receive tokens. All network access goes through
 * `host.fetch({ source, request })`, which checks the URL against the declared
 * egress hosts and injects the access token for exactly that source.
 */

/** Contract versions this SDK understands. A descriptor naming any other version is refused. */
export const PROVIDER_CONTRACT_VERSIONS = [1] as const;
export type ProviderContractVersion = (typeof PROVIDER_CONTRACT_VERSIONS)[number];

/** Provider ids are stable, lowercase, and used inside `ext:<provider>:<event>` provenance keys. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
/** Canonical datatype ids (e.g. `email-message`, `calendar-event`, `ticket`). */
export const PROVIDER_DATATYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Capabilities are `<domain>.<verb>` (e.g. `mail.read`, `mail.draft`, `calendar.write`). */
export const PROVIDER_CAPABILITY_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/;
/** Egress hosts are exact hostnames or a single leading `*.` wildcard label. */
export const PROVIDER_EGRESS_HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface ProviderOAuthDescriptor {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce?: boolean;
  /** Reference to a host-held client registration. Never a client secret. */
  clientRegistrationRef?: string;
  /** Optional shared-credential group (e.g. one Google Workspace grant serving mail + calendar). */
  credentialGroup?: string;
  /**
   * Account-identity endpoint. The HOST fetches it with the fresh access token
   * after consent (the provider never sees the token) and reads the stable
   * account id at `idField` (dot path). Must be https and inside `egressHosts`.
   */
  identity?: ProviderOAuthIdentity;
}

export interface ProviderOAuthIdentity {
  url: string;
  idField: string;
  displayNameField?: string;
}

export interface ProviderDescriptor {
  /** Stable provider id, e.g. `gmail`, `google-calendar`, `outlook-mail`, `github-issues`. */
  id: string;
  /** Contract version the adapter implements. */
  contractVersion: number;
  displayName?: string;
  /** Canonical datatypes this provider's `syncPage` produces. */
  datatypes: string[];
  /** Capability subset `invoke` accepts. */
  capabilities: string[];
  /** OAuth connection descriptor; omitted for providers that need no account grant. */
  oauth?: ProviderOAuthDescriptor;
  /** Hosts `host.fetch` may reach for this provider. Everything else is refused. */
  egressHosts: string[];
  /** JSON Schema for per-source configuration (account/calendar choices etc.). */
  configSchema?: Record<string, unknown>;
  /**
   * Host-held service credentials, by reference (D-018.1). A request to one of
   * `hosts` carries the credential the host registered under `ref` instead of
   * the source account's token. Every host must also be in `egressHosts`. The
   * provider never sees either credential; it receives the credential's
   * non-secret parameters on `services[ref]` of each sync and invoke request.
   */
  serviceCredentials?: ProviderServiceCredential[];
}

export interface ProviderServiceCredential {
  ref: string;
  hosts: string[];
}

/** Non-secret parameters of each configured service credential, keyed by ref. Unconfigured refs are absent. */
export type ProviderServices = Record<string, Record<string, string>>;

/** Result of `invoke({ capability: 'sync.wake', args: { state } })` (D-018.2). */
export interface ProviderWakeResult {
  /** True when the source has new remote changes and should sync soon. */
  wake: boolean;
  /** Opaque wake state the host stores and passes back as `args.state` next time. */
  state?: string | null;
}

/** Capability a provider declares to be asked, on each driver tick, whether a source should sync now. */
export const PROVIDER_SYNC_WAKE_CAPABILITY = 'sync.wake';

/**
 * Result of `invoke({ capability: 'sync.adopt', args: { prior } })` (D-020). `prior` is the
 * source's pre-provider cursor state: its cursor object without the host-owned `provider` and
 * `wake` keys, e.g. what a retired host path wrote before this provider existed. The host asks
 * once, before the first page of a source whose cursor has no `provider` key.
 */
export interface ProviderAdoptResult {
  /** Provider cursor to start from, or null when there is nothing to adopt (a normal fresh start). */
  cursor: string | null;
  /** False when the adopted position still owes a historical backfill. */
  backfillComplete: boolean;
}

/** Capability a provider declares to adopt a source's pre-provider cursor state on its first pass. */
export const PROVIDER_SYNC_ADOPT_CAPABILITY = 'sync.adopt';

/** Sync request issued by the host-owned connector driver. */
export interface ProviderSyncRequest {
  /** Opaque source id. The provider never learns the account's credentials. */
  source: string;
  /** Opaque cursor returned by the previous page, or null for a fresh backfill. */
  cursor: string | null;
  mode: 'backfill' | 'incremental';
  /** Per-source configuration validated against the descriptor's configSchema. */
  config?: Record<string, unknown>;
  /** Parameters of the descriptor's configured service credentials (D-018.1). */
  services?: ProviderServices;
}

export interface ProviderRecord {
  /** One of the descriptor's declared datatypes. */
  datatype: string;
  /** Provider-native id, unique within the source. Host keys include the source id. */
  nativeId: string;
  /** Provider-native event name used for `ext:<provider>:<event>` provenance. */
  event: string;
  /** Canonical payload for the datatype. Provider-specific fields live under `extensions.<provider>`. */
  payload: Record<string, unknown>;
  /** ISO-8601 time the remote object last changed. */
  occurredAt?: string;
  /** True when the remote object was deleted. */
  deleted?: boolean;
  /**
   * Delivery identity of this record (D-017.3). When present the host dedupes
   * on it instead of a hash of the payload, so a once-only event (e.g. a mail
   * `message.received`) is never re-delivered when the payload changes (a label
   * edit) or the cursor replays. Omit it for version-scoped objects whose edits
   * are new deliveries.
   */
  version?: string;
}

export interface ProviderSyncPage {
  records: ProviderRecord[];
  /** Cursor to commit after the host durably admits `records`. */
  nextCursor: string | null;
  /** True when more pages are immediately available. */
  hasMore: boolean;
}

/** Signals the host interprets; a provider throws or returns these instead of retrying itself. */
export type ProviderSyncError =
  | { kind: 'cursor-expired'; message: string }
  | { kind: 'rate-limited'; retryAfterSeconds?: number; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'transient'; message: string };

export interface ProviderInvokeRequest {
  source: string;
  capability: string;
  args: Record<string, unknown>;
  /** Parameters of the descriptor's configured service credentials (D-018.1). */
  services?: ProviderServices;
}

export interface HostFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** UTF-8 body. Binary payloads are base64 with `bodyEncoding: 'base64'`. */
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
}

export interface HostFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
}

/** The only network path a provider has. The host enforces egress and injects the source's token. */
export type HostFetch = (input: { source: string; request: HostFetchRequest }) => Promise<HostFetchResponse>;

export interface ProviderHost {
  fetch: HostFetch;
}

/** Adapter a provider plugin implements. All three methods are request/response. */
export interface ProviderAdapter {
  describe(): ProviderDescriptor | Promise<ProviderDescriptor>;
  syncPage(request: ProviderSyncRequest, host: ProviderHost): Promise<ProviderSyncPage>;
  invoke(request: ProviderInvokeRequest, host: ProviderHost): Promise<unknown>;
}

/**
 * JSON-RPC wire protocol between the host and a `daemon` provider (D-006).
 * Newline-delimited JSON-RPC 2.0 on the daemon's stdin/stdout.
 *
 * host→daemon: `describe` (no params) → ProviderDescriptor;
 *   `syncPage` / `invoke` with {@link ProviderDaemonCallParams}.
 * daemon→host: `hostFetch` with {@link ProviderDaemonFetchParams} →
 *   HostFetchResponse. The `callToken` is valid only while the host call that
 *   issued it is in flight, and only for that call's `source`; the host
 *   injects the credential, so the daemon never sees a token.
 * The daemon must also answer `papercup.ping` (supervisor health check).
 */
export const PROVIDER_DAEMON_METHODS = {
  describe: 'provider.describe',
  syncPage: 'provider.syncPage',
  invoke: 'provider.invoke',
  hostFetch: 'host.fetch',
} as const;

export interface ProviderDaemonCallParams<R = ProviderSyncRequest | ProviderInvokeRequest> {
  request: R;
  callToken: string;
}

export interface ProviderDaemonFetchParams {
  callToken: string;
  source: string;
  request: HostFetchRequest;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  } catch {
    return false;
  }
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dups.add(value);
    seen.add(value);
  }
  return [...dups];
}

/** True when `host` is allowed by one of the descriptor's egress patterns. */
export function providerEgressAllows(egressHosts: readonly string[], host: string): boolean {
  const target = host.toLowerCase();
  return egressHosts.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === p;
  });
}

/**
 * Semantic validation of a provider descriptor. Returns a list of issues (empty = valid).
 * The JSON schema enforces shape; this enforces identity, version and value rules.
 */
export function validateProviderDescriptor(descriptor: unknown): string[] {
  const issues: string[] = [];
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return ['provider descriptor must be an object'];
  }
  const d = descriptor as Partial<ProviderDescriptor>;
  if (!isNonEmptyString(d.id) || !PROVIDER_ID_PATTERN.test(d.id)) {
    issues.push(`provider.id must match ${PROVIDER_ID_PATTERN}`);
  }
  if (!PROVIDER_CONTRACT_VERSIONS.includes(d.contractVersion as ProviderContractVersion)) {
    issues.push(
      `provider.contractVersion ${String(d.contractVersion)} is unsupported (supported: ${PROVIDER_CONTRACT_VERSIONS.join(', ')})`,
    );
  }
  const datatypes = Array.isArray(d.datatypes) ? d.datatypes : [];
  if (datatypes.length === 0) issues.push('provider.datatypes must declare at least one canonical datatype');
  for (const datatype of datatypes) {
    if (!isNonEmptyString(datatype) || !PROVIDER_DATATYPE_PATTERN.test(datatype)) {
      issues.push(`provider.datatypes entry "${String(datatype)}" is not a canonical datatype id`);
    }
  }
  for (const dup of duplicates(datatypes.filter(isNonEmptyString))) issues.push(`provider.datatypes repeats "${dup}"`);
  const capabilities = Array.isArray(d.capabilities) ? d.capabilities : [];
  for (const capability of capabilities) {
    if (!isNonEmptyString(capability) || !PROVIDER_CAPABILITY_PATTERN.test(capability)) {
      issues.push(`provider.capabilities entry "${String(capability)}" must be <domain>.<verb>`);
    }
  }
  for (const dup of duplicates(capabilities.filter(isNonEmptyString))) issues.push(`provider.capabilities repeats "${dup}"`);
  const egress = Array.isArray(d.egressHosts) ? d.egressHosts : [];
  if (egress.length === 0) issues.push('provider.egressHosts must declare at least one host');
  for (const host of egress) {
    if (!isNonEmptyString(host) || !PROVIDER_EGRESS_HOST_PATTERN.test(host.toLowerCase())) {
      issues.push(`provider.egressHosts entry "${String(host)}" must be a hostname or *.domain`);
    }
  }
  if (d.oauth !== undefined) {
    const oauth = d.oauth as Partial<ProviderOAuthDescriptor>;
    if (!isHttpsUrl(oauth.authorizeUrl)) issues.push('provider.oauth.authorizeUrl must be an https URL');
    if (!isHttpsUrl(oauth.tokenUrl)) issues.push('provider.oauth.tokenUrl must be an https URL');
    if (!Array.isArray(oauth.scopes) || !oauth.scopes.every(isNonEmptyString)) {
      issues.push('provider.oauth.scopes must be a list of scope strings');
    }
    for (const key of Object.keys(oauth)) {
      if (/secret/i.test(key)) issues.push(`provider.oauth.${key} must not carry a secret; use clientRegistrationRef`);
    }
    if (oauth.identity !== undefined) {
      const identity = oauth.identity as Partial<ProviderOAuthIdentity>;
      if (!isHttpsUrl(identity.url)) issues.push('provider.oauth.identity.url must be an https URL');
      if (!isNonEmptyString(identity.idField)) issues.push('provider.oauth.identity.idField must name the account id field');
    }
    for (const url of [oauth.authorizeUrl, oauth.tokenUrl, oauth.identity?.url]) {
      if (!isHttpsUrl(url)) continue;
      const host = new URL(url as string).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && !providerEgressAllows(egress.filter(isNonEmptyString), host)) {
        issues.push(`provider.oauth endpoint host "${host}" is not in provider.egressHosts`);
      }
    }
  }
  if (d.configSchema !== undefined && (typeof d.configSchema !== 'object' || d.configSchema === null || Array.isArray(d.configSchema))) {
    issues.push('provider.configSchema must be a JSON Schema object');
  }
  if (d.serviceCredentials !== undefined) {
    if (!Array.isArray(d.serviceCredentials)) {
      issues.push('provider.serviceCredentials must be a list of { ref, hosts }');
    } else {
      for (const [index, entry] of d.serviceCredentials.entries()) {
        const credential = (entry ?? {}) as Partial<ProviderServiceCredential>;
        if (!isNonEmptyString(credential.ref) || !PROVIDER_ID_PATTERN.test(credential.ref)) {
          issues.push(`provider.serviceCredentials[${index}].ref must be a lowercase credential reference`);
        }
        if (!Array.isArray(credential.hosts) || credential.hosts.length === 0) {
          issues.push(`provider.serviceCredentials[${index}].hosts must list at least one host`);
          continue;
        }
        for (const host of credential.hosts) {
          if (!isNonEmptyString(host) || !PROVIDER_EGRESS_HOST_PATTERN.test(host)) {
            issues.push(`provider.serviceCredentials[${index}].hosts entry '${String(host)}' is not a hostname`);
          } else if (!egress.includes(host)) {
            issues.push(`provider.serviceCredentials[${index}] host '${host}' is not in provider.egressHosts`);
          }
        }
      }
    }
  }
  return issues;
}

/** Manifest-level check run by the loader and the Cupboard installer. */
export function validateProviderDeclaration(manifest: { provider?: unknown }): string[] {
  if (manifest.provider === undefined) return [];
  return validateProviderDescriptor(manifest.provider);
}

/** True when `value` structurally implements the adapter (used before registering a js provider). */
export function isProviderAdapter(value: unknown): value is ProviderAdapter {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return typeof a.describe === 'function' && typeof a.syncPage === 'function' && typeof a.invoke === 'function';
}
