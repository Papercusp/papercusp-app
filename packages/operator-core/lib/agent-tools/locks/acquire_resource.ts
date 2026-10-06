/**
 * locks:acquire_resource — acquire a NAMED resource (shared/exclusive).
 *
 * Sibling to locks:acquire (which is file-path + exclusive only). A named
 * resource (registered in agent_resource_registry) takes MANY shared
 * holders + at most ONE exclusive holder, gated by a writer-priority
 * drain (plan named-resource-locks-drain; D-009 separate table, D-010
 * registered-names-only). For mode 'exclusive' with wait.max_drain_sec>0,
 * blocks until shared holders drain or the timeout fires.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryAcquireResource, type ResourceHolder } from './su-lock-store';
import { acquireResourceExclusiveWithWait } from './resource-acquire-wait';
import { endedSessionOwners } from './ended-session-owners';
import { acquireWithContentionRetry, isWorkspaceContended } from './contention-retry';
import { resourceLockDomain } from './coordination-domain';
import { ensureResourceDomainKindsFresh } from './resource-domain-kinds';
import {
  findCrossDomainResourceConflicts,
  CROSS_DOMAIN_CONFLICT_HINT,
} from './cross-domain-conflict';
import { broadcastResourceDrainStart } from './resource-broadcast';
import { hardText, LIMITS } from '../limits';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC, MAX_LOCK_WAIT_SEC as MAX_WAIT_SEC } from './lock-config';

function holderJson(h: ResourceHolder) {
  return {
    owner: h.owner,
    owner_label: h.owner_label,
    mode: h.mode,
    status: h.status,
    reason: h.reason,
    expires_ts: h.expires_ts.toISOString(),
  };
}

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** EI-218338: interactive named-resource acquires fail fast on same-workspace
 * contention, but must not leak the raw PG handler error. There is no holder
 * snapshot when the advisory workspace gate timed out, so make that uncertainty
 * explicit instead of fabricating either a foreign holder or a free resource. */
function workspaceContended(error: unknown) {
  const source = error as { pgCode?: unknown; code?: unknown };
  const pgCode =
    typeof source?.pgCode === 'string'
      ? source.pgCode
      : typeof source?.code === 'string'
        ? source.code
        : undefined;
  return json({
    ok: false,
    reason: 'workspace_contended',
    transient: true,
    retryable: true,
    holder: 'unknown',
    holders: [],
    ...(pgCode ? { pg_code: pgCode } : {}),
    advice:
      'The lock service could not serialize this call in time (advisory-lock timeout). Holder identity is unknown; this does not prove the requested resource is unheld. Retry the operation or inspect locks:list; do not treat this as a confirmed holder conflict.',
  });
}

/**
 * EI-24431892879107061: resolve the `wait.max_drain_sec` | `wait.max_sec` alias
 * pair ONCE, here, so every downstream site sees one value (same discipline as
 * work_items:list's sourcePlanSlug|plan pair). An empty `wait: {}` stays
 * rejected — before the alias, `max_drain_sec` was required, and silently
 * treating `{}` as "no wait" would change a refusal into a different behavior.
 */
export function resolveWaitSec(
  wait: { max_drain_sec?: number; max_sec?: number } | undefined,
): number {
  if (wait === undefined) return 0;
  const { max_drain_sec: drain, max_sec: sec } = wait;
  if (drain !== undefined && sec !== undefined && drain !== sec) {
    throw new Error(
      '`wait.max_drain_sec` and `wait.max_sec` are the SAME cap (alias-group:max_drain_sec|max_sec) — pass only one. You passed both with different values, so which one wins would be ambiguous.',
    );
  }
  const resolved = drain ?? sec;
  if (resolved === undefined) {
    throw new Error(
      '`wait` needs `max_drain_sec` (alias: `max_sec`) — e.g. wait:{max_drain_sec:0} for an immediate refusal, or up to the lock-config cap to wait for shared holders to drain.',
    );
  }
  return resolved;
}

export default defineTool({
  name: 'locks:acquire_resource',
  description:
    `Acquire a NAMED resource (must be registered; see locks:list). mode:"shared" = "I am using it" (many coexist); mode:"exclusive" = "I need to restart/mutate it" (granted only once shared holders drain to zero). For exclusive, set wait:{max_drain_sec:N} (≤${MAX_WAIT_SEC}) to block while existing shared holders finish — new shared acquisitions are refused meanwhile. Release with locks:release_resource.`,
  guidance: {
    when: 'Before relying on a shared resource (mode shared), or before a destructive action on it like restarting the dev server (mode exclusive). Registered resources only — check locks:list.',
    notWhen: 'File edits — use locks:acquire only for deliberate multi-file claims or when hook diagnostics say the per-edit hook is unavailable. An unregistered ad-hoc name — register it first (locks are useless if names diverge).',
    chaining: 'shared: acquire_resource{mode:shared} → use it → release_resource. exclusive restart: acquire_resource{mode:exclusive,wait:{max_drain_sec}} → on ok+held do the restart → release_resource (signals it is back up).',
    seeAlso: [
      'locks:list (find the exact registered resource name + rule first)',
      'locks:release_resource (release after use / after a restart)',
      'locks:heartbeat_resource (keep a long hold alive past its TTL)',
    ],
  },
  capability: 'locks:write',
  // exclusive wait can block up to max_drain_sec; bump past it with margin.
  timeoutSec: MAX_WAIT_SEC + 30,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    resource: z.string().min(1).max(200),
    mode: z.enum(['shared', 'exclusive']),
    reason: hardText(LIMITS.ANNOTATION).optional(),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
    // EI-24431892879107061: the sibling `locks:acquire` spells its bounded wait
    // `wait.max_sec`; callers carry that spelling over (142 invalid-input vs 4389
    // ok since 09-27, each a wasted round-trip). Declare the sibling spelling as
    // a schema-visible alias (alias-group:max_drain_sec|max_sec) rather than
    // teaching callers via rejection — the two names mean the SAME cap here.
    wait: z
      .object({
        max_drain_sec: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_WAIT_SEC)
          .optional()
          .describe(
            'Max seconds an exclusive request waits for shared holders to drain. Alias: `max_sec` (alias-group:max_drain_sec|max_sec). Pass exactly one of the two.',
          ),
        max_sec: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_WAIT_SEC)
          .optional()
          .describe(
            "Alias for `max_drain_sec` (alias-group:max_drain_sec|max_sec) — the SAME wait cap; locks:acquire spells it wait.max_sec. Passing both with different values is rejected.",
          ),
      })
      .optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel } = readIdentity(ctx);
    // WI-562584: load the registry's DECLARED domain kinds before resolving, so
    // a resource whose domain cannot be inferred from its name (git-sync's
    // per-install `extra_lock_resources`) still lands in the domain its
    // system-side acquirer holds it in. TTL-bounded and coalesced — at most one
    // read per 30s across every acquire — and it never throws: a failed read
    // leaves the name inference below exactly as it was.
    await ensureResourceDomainKindsFresh();
    // WI-5960: route through the resource's OWN domain (host-global / workspace-
    // scoped / caller-tree), not unconditionally the file-lock (repo-root) domain
    // — a `git-sync:<slug>` (or `release-deploy`/`dev-server`) acquire under the
    // wrong domain is invisible to that resource's real system-side acquirer.
    const coordinationDomain = resourceLockDomain(args.resource);
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    const reason = args.reason ?? '';
    // EI-22433934758916322: a bounded exclusive drain can legitimately occupy
    // the handler for up to 45s. Forward the wait loop's five-second ticks to
    // the transport so an MCP client sees liveness and refreshes its idle clock
    // instead of treating a still-progressing acquisition as an unknown-outcome
    // timeout. Older direct/shim callers may not provide progress.
    const emitProgress =
      (ctx as { progress?: (pct: number | undefined, msg?: string) => void }).progress ?? (() => undefined);

    // WI-562584: the domain above is INFERRED from the resource name, and a
    // wrong inference used to fail OPEN — granting over a live hold that the
    // holder could not see (git-sync's `extra_lock_resources` are the live
    // case: it holds them all under the workspace domain, they advertise no
    // family, so this acquire lands in the caller-tree domain). Refuse instead
    // of granting an exclusivity that does not hold. Read cannot see another
    // checkout's domain, so this adds no cross-tree false conflicts.
    let crossDomain;
    try {
      crossDomain = await findCrossDomainResourceConflicts({
        resource: args.resource,
        targetDomain: coordinationDomain,
        requestedMode: args.mode,
        owner: ownerId,
      });
    } catch (err) {
      // Fail CLOSED: an unanswered exclusivity question is not permission.
      return json({
        ok: false,
        reason: 'cross_domain_check_failed',
        error: err instanceof Error ? err.message : String(err),
        hint: 'Could not read the sibling lock coordination domains, so it is unknown whether a peer holds this resource. Retry; if it persists, check the locks store with locks:list.',
      });
    }
    if (crossDomain.length > 0) {
      return json({
        ok: false,
        reason: 'held_in_other_domain',
        holders: crossDomain,
        hint: CROSS_DOMAIN_CONFLICT_HINT,
      });
    }

    if (args.mode === 'shared') {
      let r: Awaited<ReturnType<typeof tryAcquireResource>>;
      try {
        // EI-21993817406733718: a transient workspace advisory-lock timeout
        // must not turn a recoverable contention dip into a user-visible
        // acquire failure. Retry the complete transaction so each attempt
        // gets a fresh serialization boundary.
        r = await acquireWithContentionRetry(() =>
          inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
            tryAcquireResource(tx, {
              coordinationDomain,
              resource: args.resource,
              mode: 'shared',
              owner: ownerId,
              ownerLabel,
              reason,
              ttlSec,
            }),
          ),
        );
      } catch (error) {
        if (isWorkspaceContended(error)) return workspaceContended(error);
        throw error;
      }
      if (!r.ok) return json({ ok: false, reason: r.reason, holders: r.holders.map(holderJson) });
      return json({
        ok: true,
        lock_id: r.lock_id,
        mode: 'shared',
        status: r.status,
        owner: ownerId,
        expires_ts: r.expires_ts.toISOString(),
      });
    }

    // exclusive
    const maxWaitSec = resolveWaitSec(args.wait);
    const coordId = resolveAgentIdentity(ctx);
    let r: Awaited<ReturnType<typeof acquireResourceExclusiveWithWait>>;
    try {
      // Retry the whole exclusive protocol: contention can happen while
      // acquiring its workspace transaction, and each retry must rebuild the
      // wait/listen lifecycle from a clean attempt.
      r = await acquireWithContentionRetry(() =>
        acquireResourceExclusiveWithWait({
          coordinationDomain,
          owner: ownerId,
          ownerLabel,
          resource: args.resource,
          reason,
          ttlSec,
          maxWaitSec,
          // P-009: tell the shared holders to release when the drain begins.
          onDrainStart: (holders) =>
            broadcastResourceDrainStart({ source: coordId, resource: args.resource, holders, reason }),
          onTick: ({ waited_sec, holders }) => {
            emitProgress(
              undefined,
              JSON.stringify({
                phase: 'draining',
                elapsed_sec: waited_sec,
                max_drain_sec: maxWaitSec,
                remaining_sec: Math.max(0, maxWaitSec - waited_sec),
                holders: holders.map(holderJson),
              }),
            );
          },
          // EI-22365267258322901: an exclusive held by an ended agent session
          // must be reclaimed before reporting held_exclusive. The wait helper
          // is fail-safe and only condemns owners that the shared liveness
          // oracle identifies as definitively ended.
          deadOwnerOracle: endedSessionOwners,
        }),
      );
    } catch (error) {
      if (isWorkspaceContended(error)) return workspaceContended(error);
      throw error;
    }

    if (r.ok && r.status === 'held') {
      return json({
        ok: true,
        lock_id: r.lock_id,
        mode: 'exclusive',
        status: 'held',
        owner: ownerId,
        waited_sec: r.waited_sec,
        // D-001 fencing token — pass to a downstream action's stale-fence check.
        fence_seq: r.fence_seq,
      });
    }
    if (r.ok && r.status === 'draining') {
      // maxWaitSec was 0 — accepted but not yet effective; caller decides.
      return json({
        ok: true,
        lock_id: r.lock_id,
        mode: 'exclusive',
        status: 'draining',
        owner: ownerId,
        holders: r.holders.map(holderJson),
      });
    }
    if (!r.ok && r.reason === 'drain_timeout') {
      return json({
        ok: false,
        reason: 'drain_timeout',
        lock_id: r.lock_id,
        waited_sec: r.waited_sec,
        holders: r.holders.map(holderJson),
      });
    }
    // conflict (held_exclusive / holds_shared / unknown_resource)
    return json({ ok: false, reason: r.reason, holders: (r.holders ?? []).map(holderJson) });
  },
});
