/**
 * locks:release_granular — release a multi-granularity intention lock-set (D-005).
 *
 * Frees the whole lock-set acquired under one lock_id: the leaf node + every
 * ancestor intention lock placed with it. Owner-checked — you can only drop your
 * own rows (a leaked lock_id can't release someone else's hold).
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readFileLockIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { releaseGranular } from './su-lock-store';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

export default defineTool({
  name: 'locks:release_granular',
  description:
    'Release one or many granular intention lock-sets you hold, by lock_id or lock_ids. Frees each leaf node + all of its ancestor intention locks. Owner-checked.',
  guidance: {
    when: 'As soon as the subtree/directory work the lock guarded is done. Release several selected lock sets at once via lock_ids:[…].',
    notWhen: 'While still working under the lock. Release is owner-checked — you can only drop your own lock-set.',
    chaining: 'locks:acquire_granular → work → locks:release_granular { lock_id } or { lock_ids:[…] }.',
    seeAlso: [
      'locks:acquire_granular (the paired acquire)',
      'locks:release (for per-file edit locks)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      lock_id: z.string().uuid().optional(),
      lock_ids: z.array(z.string().uuid()).min(1).max(200).optional(),
    })
    .refine((a) => Boolean(a.lock_id) || (a.lock_ids?.length ?? 0) > 0, {
      message: 'pass lock_id for one, or lock_ids:[…] for many',
    }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readFileLockIdentity(ctx);
    const lockIds = mergeIds(args.lock_id, args.lock_ids);
    const env = await runBulk(
      lockIds,
      async (lockId) => {
        const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
          releaseGranular(tx, coordinationDomain, ownerId, lockId),
        );
        return { ok: true as const, lock_id: lockId, released: r.released };
      },
      { keyOf: (lockId) => ({ lock_id: lockId }) },
    );
    return bulkContent(env);
  },
});
