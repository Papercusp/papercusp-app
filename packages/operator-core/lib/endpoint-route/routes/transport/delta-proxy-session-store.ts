import { DeltaToolClient } from '@papercusp/agent-mcp';
import { TtlMap } from '../../../ttl-map';

/**
 * The proxy's cursor and reconstructed row bases are an optimization: when a
 * session is evicted, the next request can safely refetch a full result.
 * Keep the retention window aligned with the delta protocol's cursor age.
 */
export const DELTA_PROXY_SESSION_TTL_MS = 5 * 60_000;
export const DELTA_PROXY_SESSION_MAX_ENTRIES = 1024;

export interface DeltaProxySession {
  client: DeltaToolClient;
  fields: Map<string, string>;
}

export class DeltaProxySessionStore {
  private readonly sessions: TtlMap<DeltaProxySession>;
  private readonly now: () => number;

  constructor(options: {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {}) {
    this.sessions = new TtlMap<DeltaProxySession>({
      ttlMs: options.ttlMs ?? DELTA_PROXY_SESSION_TTL_MS,
      maxEntries: options.maxEntries ?? DELTA_PROXY_SESSION_MAX_ENTRIES,
    });
    this.now = options.now ?? Date.now;
  }

  getOrCreate(sessionKey: string): DeltaProxySession {
    const now = this.now();
    const existing = this.sessions.get(sessionKey, now);
    if (existing) return existing;

    const session: DeltaProxySession = {
      client: new DeltaToolClient(),
      fields: new Map<string, string>(),
    };
    this.sessions.set(sessionKey, session, now);
    return session;
  }

  get size(): number {
    return this.sessions.size;
  }
}
