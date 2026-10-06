/**
 * locks:release — release locks and fire the grant cascade.
 *
 * Inside the same transaction, runs grant_cascade(coordinationDomain, now())
 * which iterates FIFO waiters and grants any whose paths are now free.
 * NOTIFY fires inside the cascade function; the app doesn't need to
 * loop the result.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readFileLockIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { acquireWithContentionRetry } from './contention-retry';
import { readResourceLockStatus, releaseGranular, tryRelease } from './su-lock-store';
import { notifyPlanLockChange } from './notify-lock-change';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import {
  FILE_LOCK_OP_KINDS,
  emitReleaseLockEvents,
  isNativeEditProofForPaths,
  type FileLockReleaseParams,
  type NativeEditProof,
} from '../../authority/file-lock-authority-ops';
import { recordLockEvent } from '../../authority/lock-event-stream';
import { noteShaTokenRelease } from '../../authority/sha-token-registry';
import { recordEditAttribution } from '../../edit-attribution';
import { recordRestrictedEditBeforeRelease } from '../../personal-vault/git-sync-hold';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { resolveExplicitFileLockDomain } from './coordination-domain';
import { domainsHoldingLocks, ownedLocksForPaths, type OwnedLockPaths } from './owner-lock-domains';
import { releaseAllOwnedLocks } from './release-all-owned';

const lockIdSchema = z.string().uuid({
  error: (issue) => {
    const input = issue.input;
    if (typeof input === 'string') {
      const lengthHint =
        input.length < 36
          ? ` The value is ${input.length} characters long and may be truncated; complete UUIDs are 36 characters.`
          : ` The value is ${input.length} characters long, but it is not a valid UUID.`;
      return `Invalid UUID for lock id.${lengthHint} Use the complete id returned by locks:acquire or locks:queue.`;
    }
    return 'Invalid UUID for lock id. Use the complete id returned by locks:acquire or locks:queue.';
  },
});

export default defineTool({
  name: 'locks:release',
  description:
    'Release one or many held lock sets, including classic file-lock and granular intention-lock UUIDs. Single: pass lock_id (with optional paths filter for classic file locks), paths to select your active locks across every coordination domain (classic file-lock rows only), or all_mine=true. Many: pass lock_ids:[…]. Path-only selection is caller-owned and grouped by lock_id before release. A named-resource UUID is rejected with guidance to use locks:release_resource. Fires the classic file-lock grant cascade for waiting agents.',
  guidance: {
    when: 'Immediately after the edit is committed. Pass paths to release your active rows when the lock_id is unavailable; this resolves across coordination domains and releases only the requested paths. Release several known lock sets at once via lock_ids:[…]. On context loss / restart, call with all_mine=true to release everything. If recovering from locks:queue, pass the active row\'s lock_id.',
    notWhen: 'Mid-edit. The lock should outlive the edit by enough that no other agent races between release and PR merge.',
    chaining: 'locks:acquire or locks:acquire_granular → work → locks:release { lock_id } or { lock_ids:[…] }. If a classic file-lock id was lost, locks:queue → select your active row\'s lock_id → locks:release { lock_id }. Or: session-end → locks:release { all_mine: true }.',
    seeAlso: [
      'locks:release_granular (for a subtree/directory lock)',
      'locks:release_resource (for a named-resource lock)',
      'locks:heartbeat (extend a long edit instead of releasing early)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  // The handler owns its own workspace transactions for file/resource release
  // and only reads ctx for caller identity. Do not reserve an ambient org-app
  // transaction before the handler runs; under pool contention that can make
  // release fail before it can free a valid lock.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    lock_id: lockIdSchema.optional(),
    lock_ids: z.array(lockIdSchema).min(1).max(200).optional(),
    paths: z
      .array(z.string())
      .optional()
      .describe('path filter for a selected lock_id, or a path-only selector for your active locks across all coordination domains'),
    coordination_domain: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('physical repository root supplied by a client edit hook when releasing a lock acquired through another operator checkout'),
    all_mine: z.boolean().optional(),
    // G-0 (P-033) publish-then-release: the head sha you published to your
    // hive-git namespace before releasing. The authority stamps the NEXT grant
    // of these paths with it as requiredSha, so the next holder builds on your
    // work. Omit when you released without publishing.
    published_sha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    native_edit_proof: z
      .object({
        success: z.literal(true),
        source: z.enum(['claude', 'codex', 'omp']),
        tool: z.string().min(1).optional(),
        tools: z.array(z.string().min(1)).min(1).optional(),
        paths: z.array(z.string().min(1)).min(1),
      })
      .refine((proof) => Boolean(proof.tool) || (proof.tools?.length ?? 0) > 0, {
        message: 'native_edit_proof requires tool or tools',
      })
      .optional(),
  })
    .refine(
      (a) => Boolean(a.lock_id) || (a.lock_ids?.length ?? 0) > 0 || Boolean(a.all_mine) || (a.paths?.length ?? 0) > 0,
      { message: 'pass lock_id, lock_ids, all_mine=true, or one or more paths' },
    )
    .refine(
      (a) => !a.all_mine || ((a.lock_ids?.length ?? 0) === 0 && !a.lock_id && (a.paths?.length ?? 0) === 0),
      { message: 'all_mine=true cannot be combined with lock_id(s) or paths' },
    ),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain: defaultCoordinationDomain } = readFileLockIdentity(ctx);
    let coordinationDomain: string;
    try {
      coordinationDomain = resolveExplicitFileLockDomain(args.coordination_domain, defaultCoordinationDomain);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }],
      };
    }
    const lockIds = mergeIds(args.lock_id, args.lock_ids);

    const hasPathSelector = (args.paths?.length ?? 0) > 0;
    if (lockIds.length === 0 && !args.all_mine && !hasPathSelector) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'locks:release requires lock_id, all_mine=true, or one or more paths to select caller-owned locks',
            }),
          },
        ],
      };
    }
    if (args.all_mine && (lockIds.length > 0 || hasPathSelector)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'locks:release accepts either all_mine=true or selected lock_id(s)/paths, not both',
            }),
          },
        ],
      };
    }

    if (args.all_mine) {
      const result = await releaseAllOwnedLocks({
        ownerId,
        primaryCoordinationDomain: coordinationDomain,
        source: resolveAgentIdentity(ctx),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              released: result.released,
              ...(result.crossDomainReleased.length > 0
                ? { cross_domain_released: result.crossDomainReleased }
                : {}),
              held_before: result.heldBefore,
              granular_released: result.granularReleased,
              resources_released: result.resourcesReleased,
              owner: ownerId,
              owner_label: ownerLabel,
            }),
          },
        ],
      };
    }

    /**
     * EI-20405390083792304. `heldBefore` is how many live locks this owner held in
     * this coordination domain at release time, so an empty `released` is no longer
     * ambiguous: 0 ⇒ the owner held nothing (correct no-op); >0 ⇒ the owner held
     * locks the selector did not match (a release that silently did nothing while
     * answering ok:true).
     *
     * NULLABLE ON PURPOSE — null means NOT DETERMINED, and is never collapsed to 0.
     * A routed release whose peer authority predates this field would otherwise be
     * rendered as "you held nothing", which is exactly the false reassurance this
     * change exists to remove; the honest answer there is "unknown".
     */
    type ReleaseOutcome = {
      released: string[];
      heldBefore: number | null;
      granularReleased?: number;
      wrongPlane?: {
        resource?: string;
        mode?: string;
        status?: string;
      };
    };

    /**
     * EI-20405390083792304 (ROOT FIX). The domains this owner ACTUALLY holds
     * live locks in — resolved from the lock rows themselves rather than
     * guessed from a candidate list. Lives in `./owner-lock-domains` because
     * `locks:heartbeat` hits the identical "selected by lock_id alone, domain
     * unknown at this call site" problem (EI-20413003247462580); see that
     * module for why a fixed candidate list cannot work for file locks.
     */

    async function releaseInDomain(
      domain: string,
      lockId: string | undefined,
      allMine: boolean,
      paths: string[] | undefined = args.paths,
    ): Promise<ReleaseOutcome> {
      const localRelease = (): Promise<ReleaseOutcome> =>
        inWorkspaceTxn(domain, ownerId, async (tx) =>
          tryRelease(tx, {
            coordinationDomain: domain,
            owner: ownerId,
            lockId,
            paths,
            allMine,
          }),
          { paths },
        );

      /**
       * Post-release side-effects, deliberately funnelled through ONE helper so
       * a future release path cannot pick up half of them: every `return` from
       * releaseFileLocks goes through here.
       */
      // P-014: set when the restricted-owner path below already wrote this edit's
      // ledger row before the release, so the post-release write does not repeat it.
      let restrictedEditPreRecorded = false;
      const onFileLocksReleased = (released: string[] | undefined): void => {
        // G-0 (P-033): remember the published sha for the next grant. On the
        // remote-authority path the authority records it too (from the routed
        // payload); this local note keeps the local-authority + fail-open paths
        // covered and is a harmless mirror otherwise.
        if (released && released.length > 0) {
          noteShaTokenRelease(domain, released, args.published_sha ?? null, Date.now());
        }
        // EI-21641025582934324: a lock grant proves ownership intent, not a
        // mutation. Attribute only after a successful recognized native edit
        // proof whose paths exactly equal the rows actually released.
        const proof = args.native_edit_proof as NativeEditProof | undefined;
        if (!restrictedEditPreRecorded && released && isNativeEditProofForPaths(proof, released)) {
          const identity = resolveAgentIdentity(ctx);
          void recordEditAttribution({
            repoRoot: domain,
            files: released,
            agentId: ownerId,
            intent: `PostToolUse:${proof.source}:${proof.tool ?? proof.tools?.join(',') ?? 'native-edit'}`,
            workspaceId: identity.workspaceId ?? undefined,
            contributor: identity.userId ?? undefined,
          });
        }
        // P-025: push the release to the plan lock banner. Uses the paths the
        // store actually released rather than `args.paths`, which is absent on
        // the lock_id and all-mine releases. No-ops for non-plan paths; see
        // notify-lock-change.ts for why the per-call dedupe window matters here
        // (acquire and release share one bus key — D-042).
        notifyPlanLockChange(released ?? []);
      };
      // P-014 (WI-10005571, D-006): when the owner holds an active personal disclosure,
      // write this edit's ledger row BEFORE the lock goes away, so git-sync's census
      // holds the path with no instant where it sees neither the lock nor the hold.
      // Throws disclosure_ledger_unavailable (the lock is kept) when the row cannot be
      // written. An unrestricted owner pays one indexed existence check and nothing else.
      const preReleaseProof = args.native_edit_proof as NativeEditProof | undefined;
      const preReleasePaths = Array.isArray(preReleaseProof?.paths) ? preReleaseProof.paths : [];
      if (preReleasePaths.length > 0 && isNativeEditProofForPaths(preReleaseProof, preReleasePaths)) {
        const identity = resolveAgentIdentity(ctx);
        restrictedEditPreRecorded = await recordRestrictedEditBeforeRelease({
          repoRoot: domain,
          files: preReleasePaths,
          ownerId,
          intent: `PostToolUse:${preReleaseProof.source}:${preReleaseProof.tool ?? preReleaseProof.tools?.join(',') ?? 'native-edit'}`,
          workspaceId: identity.workspaceId ?? undefined,
          contributor: identity.userId ?? undefined,
        });
      }
      try {
        const routed = await acquireWithContentionRetry(() =>
          routeFileLockOp<ReleaseOutcome>(
            domain,
            {
              local: localRelease,
              remote: {
                kind: FILE_LOCK_OP_KINDS.release,
                payload: {
                  owner: ownerId,
                  lockId,
                  paths,
                  allMine,
                  coordinationDomain: domain,
                  publishedSha: args.published_sha ?? null,
                  nativeEditProof: args.native_edit_proof as NativeEditProof | undefined,
                } satisfies FileLockReleaseParams,
                decode: (raw) => {
                  const r = raw as { released?: string[]; heldBefore?: number };
                  return {
                    released: r.released ?? [],
                    // `?? null`, never `?? 0`: a peer authority that does not send
                    // the field leaves the count UNKNOWN, and reporting unknown as
                    // 0 would assert "you held nothing" on no evidence.
                    heldBefore: typeof r.heldBefore === 'number' ? r.heldBefore : null,
                  };
                },
              },
            },
          ),
        );
        onFileLocksReleased(routed.value.released);
        // WI-1550 (P-015): a LOCALLY-decided release (we are the authority, or
        // fail-open/no-peers/unmanaged) never appended its own instant-handover
        // lock-event before this fix — only a release relayed to a REMOTE authority
        // did (inside buildFileLockAuthorityHandlers). Mirror that capture here.
        // No-ops when the scope isn't federating (the installed sink degrades to a
        // no-op) — always safe to call.
        if (routed.via !== 'remote-authority' && routed.scope && routed.value.released && routed.value.released.length > 0) {
          emitReleaseLockEvents((event) => void recordLockEvent(event), {
            scope: routed.scope,
            owner: ownerId,
            released: routed.value.released,
            ts: Date.now(),
            publishedSha: args.published_sha ?? null,
          });
        }
        return routed.value;
      } catch {
        // Routing-layer fault before a scope was resolved — degrade to the raw
        // local release (pre-cutover behavior). No lock-event emitted here, same
        // rationale as the acquire-side fallback in acquire.ts.
        const local = await acquireWithContentionRetry(localRelease);
        onFileLocksReleased(local.released);
        return local;
      }
    }

    /** Domains the fallback below actually reached into, for the reply. */
    const crossDomainReleases: Array<{ coordination_domain: string; released: string[] }> = [];

    /**
     * EI-20405390083792304 (ROOT FIX). Release in the caller's domain FIRST —
     * that path is unchanged and pays nothing new — and only when it frees
     * NOTHING, resolve where the owner's locks actually live and release there
     * too. Ordering mirrors `candidateResourceLockDomains()`'s documented shape
     * ("the caller's own domain is tried FIRST... the special-domain families
     * are tried only as a fallback when the first attempt finds nothing"), so
     * the hot path keeps its exact previous cost and the extra read happens only
     * in the case that was previously a SILENT NO-OP.
     *
     * The bug this closes, measured live: a lock acquired by the PreToolUse hook
     * under a HIVE tree's domain could not be released by its own holder, because
     * an agent's bare `locks:release` resolves `<workspace_root>/papercusp`. The
     * caller got `ok:true, released:[]` — indistinguishable from "you held
     * nothing" — and the lock sat until TTL while peers stayed blocked. It also
     * meant `all_mine:true` at session end could not clear hive locks AT ALL.
     */
    async function releaseFileLocks(
      lockId: string | undefined,
      allMine = false,
      paths: string[] | undefined = args.paths,
    ): Promise<ReleaseOutcome> {
      const primary = await releaseInDomain(coordinationDomain, lockId, allMine, paths);
      if (primary.released.length > 0) return primary;

      let others: string[] = [];
      try {
        others = await domainsHoldingLocks({ ownerId, lockId, exclude: coordinationDomain });
      } catch {
        // The resolve is a best-effort widening of a release that already
        // returned. Never fail the caller's release because the lookup faulted;
        // the same-domain granular fallback below can still make progress.
      }

      const released = [...primary.released];
      let heldBefore = primary.heldBefore;
      for (const domain of others) {
        const extra = await releaseInDomain(domain, lockId, allMine, paths);
        if (extra.released.length > 0) {
          crossDomainReleases.push({ coordination_domain: domain, released: extra.released });
          released.push(...extra.released);
        }
        // Sum what we can see. `null` (a peer authority that does not report the
        // count) stays null — an unknown must not be laundered into a number.
        if (heldBefore !== null && extra.heldBefore !== null) heldBefore += extra.heldBefore;
        else if (extra.heldBefore === null) heldBefore = null;
      }

      // EI-21334189824335572: lock UUIDs are globally shaped but stored in two
      // path-lock tables. Once the classic plane has proved it released no
      // rows, try the owner-checked granular plane in the caller's domain. A
      // path filter deliberately disables this fallback because granular
      // lock-sets are all-or-nothing and cannot honor a partial path release.
      let granularReleased = 0;
      if (released.length === 0 && lockId && (paths?.length ?? 0) === 0) {
        const granular = await acquireWithContentionRetry(() =>
          inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
            releaseGranular(tx, coordinationDomain, ownerId, lockId),
          ),
        );
        granularReleased = granular.released;
        if (heldBefore !== null) heldBefore += granularReleased;
      }

      // EI-21584799597256192: classic and granular lock IDs are both UUIDs,
      // but named-resource locks use the same shape in a separate table. A
      // resource UUID cannot be released by this file-lock surface; without
      // this probe the caller receives ok:true, released:[], held_before:0 and
      // can falsely conclude that its resource hold is gone. Only pay for the
      // diagnostic after both path-lock planes proved they released nothing.
      let wrongPlane: ReleaseOutcome['wrongPlane'];
      if (released.length === 0 && granularReleased === 0 && lockId && (paths?.length ?? 0) === 0) {
        try {
          const resourceStatus = await acquireWithContentionRetry(() =>
            // readResourceLockStatus keys by globally unique lock_id, so the
            // transaction's coordination domain need not match the resource's
            // domain (host-global/workspace-scoped resources are valid here).
            inWorkspaceTxn(coordinationDomain, ownerId, (tx) => readResourceLockStatus(tx, lockId)),
          );
          if (resourceStatus.status !== 'missing') {
            wrongPlane = {
              resource: resourceStatus.resource,
              mode: resourceStatus.mode,
              status: resourceStatus.status,
            };
          }
        } catch {
          // This is an additive diagnostic. If the read cannot complete, retain
          // the existing honest file-lock result instead of failing a release
          // that may simply refer to an unknown/expired UUID.
        }
      }

      return {
        released,
        heldBefore,
        ...(granularReleased > 0 ? { granularReleased } : {}),
        ...(wrongPlane ? { wrongPlane } : {}),
      };
    }

    if (lockIds.length === 0 && hasPathSelector) {
      let selected: OwnedLockPaths[];
      try {
        selected = await ownedLocksForPaths({ ownerId, paths: args.paths ?? [] });
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `locks:release could not resolve caller-owned locks for paths: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }

      const env = await runBulk(
        selected,
        async (item) => {
          const before = crossDomainReleases.length;
          const result = await releaseFileLocks(item.lockId, false, item.paths);
          const crossed = crossDomainReleases.slice(before);
          return {
            ok: true as const,
            lock_id: item.lockId,
            requested_paths: item.paths,
            released: result.released,
            ...(crossed.length > 0 ? { cross_domain_released: crossed } : {}),
            held_before: result.heldBefore,
          };
        },
        { keyOf: (item) => ({ lock_id: item.lockId }) },
      );
      return bulkContent(env);
    }

    if (lockIds.length > 0) {
      const env = await runBulk(
        lockIds,
        async (lockId) => {
          const before = crossDomainReleases.length;
          const result = await releaseFileLocks(lockId);
          // Attribute only the entries THIS lock_id produced — the array is
          // shared across the bulk loop.
          const crossed = crossDomainReleases.slice(before);
          if (result.wrongPlane) {
            return {
              ok: false as const,
              lock_id: lockId,
              error: 'lock_id_belongs_to_named_resource_plane',
              note: 'Use locks:release_resource { lock_id } to release a named-resource lock.',
              ...(result.wrongPlane.resource ? { resource: result.wrongPlane.resource } : {}),
              ...(result.wrongPlane.mode ? { mode: result.wrongPlane.mode } : {}),
              ...(result.wrongPlane.status ? { status: result.wrongPlane.status } : {}),
            };
          }
          return {
            ok: true as const,
            lock_id: lockId,
            released: result.released,
            ...(result.granularReleased
              ? { granular_released: result.granularReleased }
              : {}),
            ...(crossed.length > 0 ? { cross_domain_released: crossed } : {}),
            // EI-20405390083792304: per-lock, so one dud id in a bulk release is
            // visible instead of averaging into the batch looking successful.
            held_before: result.heldBefore,
          };
        },
        { keyOf: (lockId) => ({ lock_id: lockId }) },
      );
      return bulkContent(env);
    }

    throw new Error('locks:release invariant violated: validated request reached no release branch');
  },
});
