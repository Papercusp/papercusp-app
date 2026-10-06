/**
 * Provider-neutral outbound dispatch for the shared `mail:*` and `calendar:*`
 * verbs (plan generalized-integrations-google-migration-cupboard-workflows-
 * 2026-10-05, P-007; design authority D-014).
 *
 * A verb names a canonical datatype and a capability, never a provider. This
 * module picks the owner's connected source for that datatype, decides which
 * provider serves it, and refuses by name, before any provider call, when the
 * choice is ambiguous or the provider lacks the capability:
 *
 *  - `outbound_source_ambiguous:<datatype> (connected: <provider>:<account>, …)`
 *    when several sources fit and the caller chose none. It never picks the
 *    first one: that would act as an identity nobody chose.
 *  - `provider_capability_unsupported:<provider>:<capability>` when the
 *    selected source's provider does not declare the capability. There is no
 *    fallback to another provider.
 *
 * The host rails (addressee trust, deliverability, the disclosure ledger,
 * draft-versus-send) are NOT here. They run in the verbs, before anything here
 * dispatches, and identically for every provider.
 */
import type postgres from 'postgres';
import type { HostFetch } from '@papercusp/plugin-sdk';
import {
  listOwnedExternalTriggerSources,
  type OwnedExternalTriggerSourceRow,
} from '../external-triggers/source-store';
import { providerRegistry, type ProviderRegistry, type RegisteredProvider } from '../integrations/provider-registry';
import { createSourceHostFetch } from '../integrations/source-host-fetch';
import { resolveProviderServices } from '../integrations/service-credentials';
import { string, type OutboundContext } from './resolve';

/** Canonical datatypes the shared outbound verbs write. */
export type OutboundDatatype = 'email-message' | 'calendar-event';

/**
 * The outbound capability vocabulary (D-014.2). Each is passed to `invoke` as
 * `{ source, capability, args: { operation, … } }`:
 *  - `mail.draft`: operation `create` | `update` | `read`
 *  - `mail.send`: operation `message` | `draft`
 *  - `calendar.write`: operation `create` | `update`
 */
export const OUTBOUND_CAPABILITIES = {
  mailDraft: 'mail.draft',
  mailSend: 'mail.send',
  calendarWrite: 'calendar.write',
} as const;

/**
 * The provider serving a source. Every outbound source is served by a
 * registered provider since P-009 (Gmail and Google Calendar are bundled
 * provider plugins); a source whose kind has no registered provider is not an
 * outbound candidate at all.
 */
export type OutboundProvider = { kind: 'registered'; id: string; entry: RegisteredProvider };

export interface OutboundTarget extends OutboundContext {
  source: OwnedExternalTriggerSourceRow;
  datatype: OutboundDatatype;
  provider: OutboundProvider;
}

export interface OutboundDispatchDeps {
  /** Registry holding the providers; the process-wide one by default. */
  registry?: ProviderRegistry;
  /** Builds the provider's `host.fetch`; production binds the selected source's token. */
  hostFetchFor?: (sql: postgres.Sql, target: OutboundTarget) => HostFetch;
  /** The fetch behind the default `host.fetch` (tests mock HTTP here). */
  hostFetchImpl?: typeof fetch;
}

/** A refusal raised before any provider call because the provider lacks the capability. */
export class ProviderCapabilityUnsupported extends Error {
  constructor(
    readonly providerId: string,
    readonly capability: string,
  ) {
    super(`provider_capability_unsupported:${providerId}:${capability}`);
    this.name = 'ProviderCapabilityUnsupported';
  }
}

function providerForKind(kind: string, registry: ProviderRegistry): OutboundProvider | null {
  const entry = registry.get(kind);
  return entry ? { kind: 'registered', id: entry.descriptor.id, entry } : null;
}

function producesDatatype(provider: OutboundProvider, datatype: OutboundDatatype): boolean {
  return provider.entry.descriptor.datatypes.includes(datatype);
}

function capabilitiesOf(provider: OutboundProvider): readonly string[] {
  return provider.entry.descriptor.capabilities;
}

function needsCredential(provider: OutboundProvider): boolean {
  return Boolean(provider.entry.descriptor.oauth);
}

interface Candidate {
  row: OwnedExternalTriggerSourceRow;
  provider: OutboundProvider;
}

/** `(connected: <provider>:<account>, …)` — what the caller could have chosen between. */
function connectedSuffix(pool: readonly Candidate[]): string {
  if (!pool.length) return '';
  const labels = pool.map(({ row, provider }) => `${provider.id}:${string(row.providerAccountId) || row.id}`);
  return ` (connected: ${labels.join(', ')})`;
}

/**
 * Select the owner's source for `datatype` and the provider that serves it.
 *
 * The pool is every owned source whose provider produces the datatype. An
 * explicit `sourceId` or `providerAccountId` narrows it. Ambiguity is judged
 * over that pool, not over the sources that happen to offer the capability: the
 * account a message is sent AS is the owner's choice, and the only account able
 * to send is still not the one they chose.
 */
export async function resolveCapabilitySource(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    datatype: OutboundDatatype;
    /** Every capability the verb will invoke; all are checked before any call. */
    capabilities: readonly string[];
    sourceId?: string | null;
    /** The account address to act as, matched case-insensitively. */
    providerAccountId?: string | null;
    defaultInstallSlug?: string;
  },
  deps: Pick<OutboundDispatchDeps, 'registry'> = {},
): Promise<OutboundTarget> {
  const registry = deps.registry ?? providerRegistry();
  const owned = await listOwnedExternalTriggerSources(sql, params.workspaceId, params.userId);
  const candidates: Candidate[] = owned.flatMap((row) => {
    const provider = providerForKind(row.kind, registry);
    return provider && producesDatatype(provider, params.datatype) ? [{ row, provider }] : [];
  });

  let pool = candidates;
  const sourceId = string(params.sourceId);
  if (sourceId) {
    pool = pool.filter(({ row }) => row.id === sourceId);
    if (!pool.length) {
      throw new Error(`outbound_source_not_connected:${params.datatype}:${sourceId}${connectedSuffix(candidates)}`);
    }
  }
  const account = string(params.providerAccountId).toLowerCase();
  if (account) {
    const byAccount = pool.filter(({ row }) => string(row.providerAccountId).toLowerCase() === account);
    if (!byAccount.length) {
      // Name what IS connected: the account the caller meant is in that set.
      throw new Error(`outbound_source_account_not_connected:${params.datatype}:${account}${connectedSuffix(pool)}`);
    }
    pool = byAccount;
  }
  if (pool.length > 1) throw new Error(`outbound_source_ambiguous:${params.datatype}${connectedSuffix(pool)}`);
  const selected = pool[0];
  if (!selected) throw new Error(`outbound_source_not_connected:${params.datatype}`);

  const { row: source, provider } = selected;
  if (source.ownerUserId !== params.userId) {
    // Defence in depth: the query already scopes by owner, so reaching here
    // means the ownership contract itself is broken.
    throw new Error(`outbound_source_owner_mismatch:${provider.id}`);
  }
  if (source.status === 'disabled' || source.status === 'error') {
    throw new Error(`outbound_source_unavailable:${provider.id}:${source.status}`);
  }
  if (needsCredential(provider) && !source.credentialRef) {
    throw new Error(`outbound_source_credential_missing:${provider.id}`);
  }
  const offered = capabilitiesOf(provider);
  const missing = params.capabilities.find((capability) => !offered.includes(capability));
  if (missing) throw new ProviderCapabilityUnsupported(provider.id, missing);

  return {
    source,
    provider,
    datatype: params.datatype,
    installSlug: string(source.config.installSlug) || params.defaultInstallSlug || 'papercusp',
    userId: params.userId,
  };
}

/**
 * Invoke one capability on the selected source's registered provider, through a
 * `host.fetch` bound to exactly that source. Returns the provider's result
 * object; the verb validates the fields it needs with {@link resultString}.
 */
export async function invokeOutboundProvider(
  sql: postgres.Sql,
  target: OutboundTarget,
  capability: string,
  args: Record<string, unknown>,
  deps: OutboundDispatchDeps = {},
): Promise<Record<string, unknown>> {
  const { provider } = target;
  // Re-checked at the call: the resolver already refused, but a verb invoking a
  // capability it did not ask the resolver about must not reach the provider.
  if (!provider.entry.descriptor.capabilities.includes(capability)) {
    throw new ProviderCapabilityUnsupported(provider.id, capability);
  }
  const fetch =
    deps.hostFetchFor?.(sql, target) ??
    createSourceHostFetch(sql, {
      providerId: provider.id,
      workspaceId: target.source.workspaceId,
      harness: target.installSlug,
      registry: deps.registry,
      fetchImpl: deps.hostFetchImpl,
      sourceIds: [target.source.id],
    });
  const services = await resolveProviderServices(provider.entry.descriptor.serviceCredentials);
  const result = await provider.entry.adapter.invoke(
    { source: target.source.id, capability, args, ...(services ? { services } : {}) },
    { fetch },
  );
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`provider_result_invalid:${provider.id}:${capability}`);
  }
  return result as Record<string, unknown>;
}

/** A string field of a provider result; `required` fields refuse when absent. */
export function resultString(
  result: Record<string, unknown>,
  field: string,
  target: OutboundTarget,
  capability: string,
  required = true,
): string {
  const value = string(result[field]);
  if (!value && required) throw new Error(`provider_result_invalid:${target.provider.id}:${capability}:${field}`);
  return value;
}

/** A string-list field of a provider result (a bare string counts as one entry). */
export function resultStrings(result: Record<string, unknown>, field: string): string[] {
  const value = result[field];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.map((entry) => string(entry)).filter(Boolean);
}
