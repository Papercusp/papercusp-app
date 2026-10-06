/**
 * locks:release_resource — release a held named-resource lock.
 *
 * Runs resource_grant_cascade inside the same txn: releasing the LAST
 * shared holder is exactly what completes a pending exclusive's drain (it
 * flips to held + NOTIFYs the waiter). Releasing an exclusive frees the
 * resource for new shared holders.
 *
 * NOTE (Phase 3, P-010): on an exclusive release we should also broadcast
 * "<resource> back up" to anyone who was refused while it was held. That
 * coord broadcast is not wired yet; the PG-side state is already correct.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryReleaseResource } from './su-lock-store';
import { acquireWithContentionRetry } from './contention-retry';
import { broadcastResourceBackUp } from './resource-broadcast';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { resourceLockDomain, candidateResourceLockDomains } from './coordination-domain';
import { ensureResourceDomainKindsFresh } from './resource-domain-kinds';
import { resourceLockIdDomains } from './resource-lock-id-domains';

const releaseItem = z.object({
  lock_id: z.string().uuid().optional(),
  resource: z.string().min(1).max(200).optional(),
}).refine((i) => Boolean(i.lock_id) || Boolean(i.resource), {
  message: 'each item requires lock_id or resource',
});

export default defineTool({
  name: 'locks:release_resource',
  description:
    'Release one or many named-resource locks you hold. Single: pass lock_id (preferred) or resource. Many: pass lock_ids:[…], resources:[…], or items:[{lock_id|resource}].',
  guidance: {
    when: 'As soon as you are done using a shared resource, or immediately after an exclusive action (e.g. the dev-server restart) completes. Release several selected resource locks at once via lock_ids/resources/items.',
    notWhen: 'While still using the resource. Do not release another agent\'s lock — release is owner-checked and only drops your own rows.',
    chaining: 'locks:acquire_resource → use/act → locks:release_resource { lock_id } or { lock_ids:[…] }.',
    seeAlso: [
      'locks:acquire_resource (the paired acquire)',
      'locks:heartbeat_resource (extend a long hold instead of releasing)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    lock_id: z.string().uuid().optional(),
    lock_ids: z.array(z.string().uuid()).min(1).max(200).optional(),
    resource: z.string().min(1).max(200).optional(),
    resources: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),
    items: z.array(releaseItem).min(1).max(200).optional(),
  }),
  async handler(args, ctx) {
    const { ownerId } = readIdentity(ctx);
    // WI-562584: same declared-domain load the acquire path does, for the same
    // reason — a release resolves the resource's domain by name, so it has to
    // resolve the SAME one the acquire did or it releases nothing. TTL-bounded,
    // coalesced, and never throws.
    await ensureResourceDomainKindsFresh();
    const lockIds = mergeIds(args.lock_id, args.lock_ids);
    const resources = [...(args.resource ? [args.resource] : []), ...(args.resources ?? [])];
    const bulkItems = args.items?.length
      ? args.items
      : [
          ...lockIds.map((lock_id) => ({ lock_id })),
          ...resources.map((resource) => ({ resource })),
        ];

    if (bulkItems.length === 0) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: 'locks:release_resource requires lock_id or resource' }) },
        ],
      };
    }

    async function announceBackUp(r: Awaited<ReturnType<typeof tryReleaseResource>>) {
      // P-010 + A4: releasing an exclusive frees the resource — tell the agents
      // who were WAITING on it (not the whole fleet) that it's back up.
      if (r.exclusiveResources.length > 0) {
        const coordId = resolveAgentIdentity(ctx);
        for (const res of r.exclusiveResources) {
          await broadcastResourceBackUp({ source: coordId, resource: res, waiters: r.waiters[res] ?? [] });
        }
      }
    }

    async function releaseOne(item: z.infer<typeof releaseItem>) {
      if (item.resource) {
        // WI-5960: the resource name is known — go straight to ITS domain
        // (host-global / workspace-scoped / caller-tree), matching whichever
        // domain locks:acquire_resource used to acquire it.
        const domain = resourceLockDomain(item.resource);
        // EI-22464497553650176: releasing the lease is the cleanup boundary;
        // ride out transient workspace contention instead of returning a
        // per-item failure that strands the caller's named-resource lock.
        const r = await acquireWithContentionRetry(() =>
          inWorkspaceTxn(domain, ownerId, (tx) =>
            tryReleaseResource(tx, { coordinationDomain: domain, owner: ownerId, resource: item.resource }),
          ),
        );
        await announceBackUp(r);
        return r;
      }
      // lock_id only — the resource name (and therefore its domain) is unknown
      // here, so try the caller's domain first (the common case, zero extra
      // cost), falling back to the special-domain families (WI-5960) only if
      // that finds neither a release nor matching expiry evidence.
      // WI-10004326: the lease's own recorded domain comes first (located by its
      // globally unique lock_id), so a lease acquired through another operator
      // install is released where it actually lives, not only where this
      // operator would infer it.
      const domains = item.lock_id
        ? await resourceLockIdDomains(ownerId, item.lock_id)
        : candidateResourceLockDomains();
      for (const domain of domains) {
        const r = await acquireWithContentionRetry(() =>
          inWorkspaceTxn(domain, ownerId, (tx) =>
            tryReleaseResource(tx, { coordinationDomain: domain, owner: ownerId, lockId: item.lock_id }),
          ),
        );
        if (r.released > 0 || (r.expired?.length ?? 0) > 0) {
          await announceBackUp(r);
          return r;
        }
      }
      return { released: 0, releasedModes: [], exclusiveResources: [], expired: [], waiters: {} };
    }

    const env = await runBulk(
      bulkItems,
      async (item) => {
        const r = await releaseOne(item);
        const expiredLocks = r.expired ?? [];
        return {
          ok: true as const,
          ...(item.lock_id ? { lock_id: item.lock_id } : {}),
          ...(item.resource ? { resource: item.resource } : {}),
          released: r.released,
          released_modes: r.releasedModes,
          exclusive_resources: r.exclusiveResources,
          expired: expiredLocks.length > 0,
          ...(expiredLocks.length > 0
            ? {
                warning: 'resource_lock_expired_before_release',
                note: 'The named-resource lock expired before release; the guarded window may have been unprotected.',
                expired_at: expiredLocks[0].expiredAt.toISOString(),
                expired_locks: expiredLocks.map((expired) => ({
                  lock_id: expired.lockId,
                  resource: expired.resource,
                  mode: expired.mode,
                  expired_at: expired.expiredAt.toISOString(),
                })),
              }
            : {}),
        };
      },
      {
        keyOf: (item) => ({
          ...(item.lock_id ? { lock_id: item.lock_id } : {}),
          ...(item.resource ? { resource: item.resource } : {}),
        }),
      },
    );
    return bulkContent(env);
  },
});
