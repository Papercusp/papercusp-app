/**
 * locks:heartbeat — extend a lock's TTL.
 *
 * extended=false means the lock had already expired or been stolen.
 * The agent should re-acquire if it still wants to edit.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readFileLockIdentity } from './identity';
import { SuLocksCoordinator } from './coordinator';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { resolveExplicitFileLockDomain } from './coordination-domain';
import { domainsHoldingLocks } from './owner-lock-domains';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC } from './lock-config';

export default defineTool({
  name: 'locks:heartbeat',
  description:
    'Extend a held lock\'s TTL. Returns extended=true on success; extended=false means the lock had already expired or been stolen.',
  guidance: {
    when: 'For edits expected to take >15 min, call once at the halfway mark.',
    notWhen: 'For short edits — the default 20-min TTL covers it. Heartbeating every minute is wasteful.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      lock_id: z.string().uuid().optional().describe('single lock id to heartbeat'),
      lock_ids: z.array(z.string().uuid()).min(1).max(200).optional().describe('lock ids to heartbeat in one call'),
      ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
      coordination_domain: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'absolute canonical repository checkout root (not a harness/workspace slug) supplied by a client edit hook when its operator checkout differs from the edited tree, e.g. /workspace/papercusp',
        ),
    })
    .refine((a) => Boolean(a.lock_id) || (a.lock_ids?.length ?? 0) > 0, {
      message: 'pass `lock_id` or `lock_ids`',
    }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain: callerDomain } = readFileLockIdentity(ctx);
    const coordinationDomain = resolveExplicitFileLockDomain(args.coordination_domain, callerDomain);
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;

    // Dispatch through the shared FileClaimCoordinator interface
    // (file-locking #11). heartbeat is the one locks:* tool whose
    // contract maps 1:1 onto the cross-backend interface — see the
    // file-locking plan §11 for why acquire/release/cancel_wait do
    // not. SuLocksCoordinator.heartbeat reads only claim.claimId +
    // claim.owner, so a minimal claim suffices.
    const heartbeatInDomain = async (domain: string, lockId: string) => {
      const coordinator = new SuLocksCoordinator({ coordinationDomain: domain });
      return coordinator.heartbeat({ claimId: lockId, owner: ownerId, paths: [], expiresAt: null }, ttlSec * 1000);
    };

    const lockIds = mergeIds(args.lock_id, args.lock_ids);
    const env = await runBulk(
      lockIds,
      async (lockId) => {
        const result = await heartbeatInDomain(coordinationDomain, lockId);
        if (result.ok) {
          return {
            ok: true,
            lock_id: lockId,
            extended: true,
            expires_ts: result.claim.expiresAt?.toISOString() ?? null,
            owner: ownerId,
            owner_label: ownerLabel,
            coordination_domain: coordinationDomain,
          };
        }

        /**
         * EI-20413003247462580. `tryHeartbeat` pins
         * `coordination_domain = $1` in its WHERE clause, so a lock held in
         * ANOTHER domain does not match and comes back
         * `extended:false` — indistinguishable from expired/stolen/not-yours.
         * That is four conditions behind one error string, and the one the
         * legacy message never named is the one that actually fires here: a
         * lock_id carries no domain, so an agent calling bare
         * `locks:heartbeat` from the canonical tree cannot extend the lock a
         * PreToolUse hook acquired in a hive tree. Its lock then expires
         * mid-edit while it believes it is heartbeating.
         *
         * Sibling of EI-20405390083792304 (the same cause in locks:release);
         * this one at least fails LOUDLY, which is why it is the lesser bug.
         * Resolve the domain FROM the rows and retry there.
         */
        const others = await domainsHoldingLocks({ ownerId, lockId, exclude: coordinationDomain });
        for (const domain of others) {
          const retry = await heartbeatInDomain(domain, lockId);
          if (retry.ok) {
            return {
              ok: true,
              lock_id: lockId,
              extended: true,
              expires_ts: retry.claim.expiresAt?.toISOString() ?? null,
              owner: ownerId,
              owner_label: ownerLabel,
              coordination_domain: domain,
              // The caller asked in one domain and we extended in another —
              // say so, rather than letting a silent cross-domain success
              // teach the caller its domain argument does not matter.
              cross_domain_extended: { requested: coordinationDomain, actual: domain },
            };
          }
        }

        return {
          ok: false,
          lock_id: lockId,
          extended: false,
          expires_ts: null,
          owner: ownerId,
          owner_label: ownerLabel,
          coordination_domain: coordinationDomain,
          error: 'not_found_or_not_yours_or_expired',
          // Name the domain actually searched. The legacy message listed
          // three causes and omitted the fourth (wrong domain); a caller
          // that can see WHERE we looked can tell "my lock is elsewhere"
          // from "my lock is gone" without re-deriving it from the schema.
          searched_coordination_domains: [coordinationDomain, ...others],
        };
      },
      { keyOf: (lockId) => ({ lock_id: lockId }) },
    );

    return bulkContent(env);
  },
});
