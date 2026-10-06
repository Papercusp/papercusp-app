/**
 * The production `host.fetch` for one provider, resolved per SOURCE (plan
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * D-014.4).
 *
 * The connector sync driver and outbound capability dispatch both reach a
 * provider's API through this one function, so there is exactly one token path:
 * the access token injected is the one stored for the named source's own
 * account, refreshed through the connection lifecycle. Nothing else in the host
 * mints provider credentials for a provider call.
 */
import type postgres from 'postgres';
import type { HostFetch } from '@papercusp/plugin-sdk';
import { getExternalTriggerSource } from '../external-triggers/source-store';
import { ensureBuiltinConnectionAdapters } from './builtin-connection-adapters';
import { connectionAccessToken } from './connection-lifecycle';
import { createHostFetch, HostFetchError } from './host-fetch';
import { providerRegistry, type ProviderRegistry } from './provider-registry';

export interface SourceHostFetchOptions {
  providerId: string;
  workspaceId: string;
  /** Install slug whose token store holds the source credentials. */
  harness: string;
  registry?: ProviderRegistry;
  fetchImpl?: typeof fetch;
  /**
   * Restrict the fetch to these source ids. Outbound dispatch binds it to the
   * one source the verb selected, so a provider cannot spend another account of
   * the same provider (another user's, in a shared workspace) by naming its id.
   * Omitted only by the sync driver, which syncs every source of the provider.
   */
  sourceIds?: readonly string[];
  /** Error to throw when the source's account must be reconnected. */
  reconnectRequired?: (reason: string) => Error;
}

export function createSourceHostFetch(sql: postgres.Sql, opts: SourceHostFetchOptions): HostFetch {
  // First-party sources (Google, Facebook) carry `<plugin>:<field>` credential
  // refs whose token store is reached through a registered connection adapter.
  // Registering here, on the one production token path, means a process that
  // has never served an OAuth route still resolves those tokens (WI-10006541:
  // the connector driver failed every Google source with "no access token").
  ensureBuiltinConnectionAdapters();
  const allowed = opts.sourceIds ? new Set(opts.sourceIds) : null;
  return createHostFetch(opts.providerId, {
    registry: opts.registry ?? providerRegistry(),
    fetchImpl: opts.fetchImpl,
    async resolveSource(sourceId) {
      if (allowed && !allowed.has(sourceId)) return null;
      const row = await getExternalTriggerSource(sql, opts.workspaceId, sourceId);
      return row ? { sourceId: row.id, providerId: row.kind } : null;
    },
    async accessToken(resolved) {
      const row = await getExternalTriggerSource(sql, opts.workspaceId, resolved.sourceId);
      const token = await connectionAccessToken(sql, {
        workspaceId: opts.workspaceId,
        harness: opts.harness,
        credentialRef: row?.credentialRef ?? null,
      });
      if ('reconnectRequired' in token) {
        throw (
          opts.reconnectRequired?.(token.reason) ??
          new HostFetchError(
            'token-unavailable',
            `host.fetch: source "${resolved.sourceId}" must be reconnected (${token.reason})`,
          )
        );
      }
      return token.accessToken;
    },
  });
}
