/**
 * StaticListProvider — the `EgressProvider` over a fixed, owner-provisioned IP inventory (B-PROV).
 *
 * This is the realistic NEAR-TERM backend: the 8 Rayobyte IPs running in production today (per
 * WI-288's own verify-result) were provisioned manually and registered one-by-one via
 * `accounts:register{egress}` — exactly the shape a static list captures. `egress:provision
 * {provider:'static', accountId, config:{entries}}` turns that same manual list into a
 * programmatically-drawable pool: `allocate` hands out the next unassigned entry (idempotent per
 * accountId — repeat-allocating for an account that already holds one returns that SAME entry
 * instead of handing out a second), `release` frees an entry back.
 *
 * Assignment bookkeeping is held IN-MEMORY for this provider instance's lifetime (reset on a fresh
 * `createStaticListProvider` call / process restart). That is a deliberate simplification, not a
 * correctness gap: the DURABLE source of truth for "account X's live egress" is the account pool row
 * `egress:provision` writes via `accounts:register` (PG-backed), not this provider's own memory — a
 * restart just means the next `allocate()` call re-derives from a fresh, empty map and could pick an
 * entry another (still-registered) account already holds. The caller layer
 * (`agent-tools/egress/egress.ts`) is expected to run `egress:list` / `accounts:list` to sanity-check
 * before provisioning at real scale; today's actual usage is a handful of IPs, provisioned rarely.
 */
import { probeAllocationHealth, type HealthProbeDeps } from './health-probe';
import type { EgressAllocation, EgressHealth, EgressProvider } from './types';

export interface StaticListEntry {
  /** Stable id for this inventory entry — the allocation id `release`/`healthcheck` key. */
  id: string;
  proxyUrl?: string;
  localAddress?: string;
  meta?: Record<string, unknown>;
}

export interface StaticListProviderConfig {
  /** The fixed IP inventory to allocate from. Must be non-empty. */
  entries: StaticListEntry[];
}

export function createStaticListProvider(
  config: StaticListProviderConfig,
  deps: HealthProbeDeps = {},
): EgressProvider {
  const entries = config.entries;
  if (!entries || entries.length === 0) {
    throw new Error("egress: static provider requires a non-empty config.entries (the fixed IP inventory)");
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const assignedTo = new Map<string, string>(); // entryId -> accountId

  function entryAssignedTo(accountId: string): StaticListEntry | undefined {
    for (const [entryId, acct] of assignedTo) {
      if (acct === accountId) return byId.get(entryId);
    }
    return undefined;
  }

  function toAllocation(e: StaticListEntry, accountId: string | undefined): EgressAllocation {
    return { id: e.id, proxyUrl: e.proxyUrl, localAddress: e.localAddress, accountId, meta: e.meta };
  }

  return {
    name: 'static',
    async allocate(accountId) {
      const existing = entryAssignedTo(accountId);
      if (existing) return toAllocation(existing, accountId);
      const free = entries.find((e) => !assignedTo.has(e.id));
      if (!free) {
        throw new Error('egress: static provider pool exhausted — every entry is assigned (release one first, or add more entries)');
      }
      assignedTo.set(free.id, accountId);
      return toAllocation(free, accountId);
    },
    async release(id) {
      assignedTo.delete(id);
    },
    async list() {
      return entries.map((e) => toAllocation(e, assignedTo.get(e.id)));
    },
    async healthcheck(id): Promise<EgressHealth> {
      const e = byId.get(id);
      if (!e) return { reachable: false, error: 'egress_allocation_not_found' };
      return probeAllocationHealth(e, deps);
    },
  };
}
