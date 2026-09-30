/**
 * locks:acquire_granular — acquire a multi-granularity intention lock (D-005).
 *
 * A NODE is a point in the harness path tree: a file, a directory/subtree, or
 * the harness root (""). A request locks its leaf in the requested mode + places
 * the matching intention lock (IS/IX) on every ancestor up to the root, so a
 * harness-level GRANULAR lock and a file-level GRANULAR lock see each other
 * (Gray 1976). All-or-nothing: you get the whole lock-set or a conflict list.
 *
 * ⚠ SCOPE BOUND (EI-20471899135452182) — the Gray property holds WITHIN this
 * domain only. `tryAcquireGranular` conflict-checks `agent_granular_locks` and
 * nothing else; the classic file lock (`locks:acquire`, and every automatic
 * PreToolUse edit-hook claim) conflict-checks `agent_file_locks` and nothing
 * else. The two are mutually invisible, in BOTH directions. So a root X is NOT
 * an exclusive snapshot of the working tree: peer edits land under it freely.
 * That false expectation is what cost the WI-39007 release lane its snapshot.
 * Bridging the domains is an open lock-authority decision — until it lands, do
 * not describe this lock as excluding per-file edits.
 * `doc-claims/granular-lock-cross-domain.ts` fails the day that changes.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readFileLockIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryAcquireGranular, validatePath } from './su-lock-store';
import { notifyPlanLockChange } from './notify-lock-change';
import { hardText, LIMITS } from '../limits';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC } from './lock-config';

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'locks:acquire_granular',
  description:
    'Acquire a multi-granularity intention lock on a path NODE (a file, a directory/subtree, or the harness root ""). mode "X" = own the subtree exclusively (a directory lock for a refactor, or a file write); "S" = read the whole subtree; "SIX" = read the subtree while writing one node; IS/IX are the intention modes (usually derived for you). The lock places the matching intention on every ancestor incl. the harness root, so a harness-exclusive (X on "") conflicts with any descendant GRANULAR lock. ⚠ It does NOT exclude classic file locks (locks:acquire, and every automatic per-edit hook claim) — a separate domain the granular conflict check never reads — so a root X is NOT an exclusive snapshot of the tree and peer edits still land under it. All-or-nothing — you get the whole lock-set or a conflict list. Release with locks:release_granular.',
  guidance: {
    when:
      'A directory/subtree refactor (X on a dir), reading a whole subtree (S), or coordinating file-vs-harness-level work when a single-file lock is too narrow. Use "" for the harness root.',
    notWhen:
      'A single-file edit: rely on the per-edit hook or use locks:acquire. Cross-resource coordination (dev server, DB schema): use locks:acquire_resource. Not as a mutex for non-file operations like fleet setup or work-item/plan changes.',
    chaining: 'locks:acquire_granular → do the work → locks:release_granular. On conflict, inspect conflicts and pivot/retry.',
    seeAlso: [
      'locks:acquire (a single deliberate multi-file claim, not a subtree)',
      'locks:acquire_resource (a registered resource, not a path)',
      'locks:release_granular (drop the subtree lock)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    path: z.string().max(4096).describe('Repo-relative node: a file, a directory/subtree, or "" for the harness root.'),
    mode: z.enum(['IS', 'IX', 'S', 'SIX', 'X']),
    intent: hardText(LIMITS.SHORT_TITLE).optional(),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readFileLockIdentity(ctx);
    // Root ("") is legal here (the harness node); validate any non-root path the
    // same way file locks do (reject absolute / traversal / over-long).
    if (args.path !== '') {
      try {
        validatePath(args.path);
      } catch (e) {
        return json({ ok: false, error: (e as Error).message });
      }
    }
    const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
      tryAcquireGranular(tx, {
        coordinationDomain,
        path: args.path,
        mode: args.mode,
        owner: ownerId,
        ownerLabel,
        intent: args.intent ?? '',
        ttlSec: args.ttl_sec ?? DEFAULT_TTL_SEC,
      }),
    );
    if (!r.ok) {
      return json({ ok: false, reason: r.reason, conflicts: r.conflicts });
    }
    // P-025: push the acquire to the plan lock banner (post-commit; no-ops for
    // non-plan paths). See notify-lock-change.ts for why the per-call dedupe
    // window is load-bearing (D-042).
    notifyPlanLockChange([args.path]);
    return json({
      ok: true,
      lock_id: r.lock_id,
      mode: args.mode,
      locks: r.locks,
      expires_ts: r.expires_ts.toISOString(),
    });
  },
});
