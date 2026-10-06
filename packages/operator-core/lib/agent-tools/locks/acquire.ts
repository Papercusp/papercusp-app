/**
 * locks:acquire — claim a set of files for exclusive editing.
 *
 * Phase 2: wait subsystem wired. The flow when `wait: { max_sec: N }`
 * is set follows the 6-step LISTEN-before-INSERT protocol from
 * su-agent-coordination-v3-2026-05-14.md §7.4 (step 4 dropped per
 * audit 4 #4):
 *
 *   1. subscribeWorkspace (LISTEN ch_coord_<wsId>) — outside any txn
 *   2. inWorkspaceTxn → tryAcquire
 *        if granted: unsubscribe; return ok
 *   3. inWorkspaceTxn → cap check + INSERT INTO agent_lock_waiters
 *        if cap exceeded: unsubscribe; return waiter_cap_exceeded
 *   4. await notification, with 30s ceiling (audit 4 #3 — silent drop
 *      detection)
 *   5. on wake: readWaiterStatus
 *        if granted: unsubscribe; return ok
 *        if waiting: GOTO 4
 *   6. on timeout: expireWaiter; unsubscribe; return busy + ticket_id
 *
 * Critical: step 1 (LISTEN) MUST happen BEFORE step 3 (INSERT).
 * Notifications are buffered by PG between LISTEN and the first wake,
 * so a grant that fires during step 3's commit is delivered when step
 * 4 starts awaiting. Reverse the order and the wakeup is lost.
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readFileLockIdentity } from './identity';
import { enrichBusy } from './enrich-busy';
import { inWorkspaceTxn } from './in-workspace-txn';
import { acquireWithContentionRetry, isWorkspaceContended } from './contention-retry';
import {
  expireWaiter,
  getTxPool,
  normalizePaths,
  pokeWorkspace,
  readQueue,
  readWaiterStatus,
  tryAcquire,
  tryInsertWaiter,
  type AcquireBusy,
} from './su-lock-store';
import {
  subscribeWorkspace,
  TooManyActiveWorkspacesError,
} from './workspace-listener';
import { ensureGrantListener, lockGrantKey } from './lock-grant-bridge';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait } from '../../events/await/store';
import { startAwaitSweeper } from '../../events/await/engine';
import { resolveAgentIdentity } from '../coordination/identity';
import { checkGoalModeEditGuard } from './goal-mode-edit-guard';
import { readAgentStateStamp } from '../../agent-state-stamp';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import {
  noteShaTokenGrant,
  shaTokenForGrant,
  type ShaTokenGrant,
} from '../../authority/sha-token-registry';
import {
  FILE_LOCK_OP_KINDS,
  emitAcquireLockEvents,
  type FileLockAcquireParams,
  type FileLockAcquireResult,
} from '../../authority/file-lock-authority-ops';
import { recordLockEvent } from '../../authority/lock-event-stream';
import { projectLockWaitOperationalBrief } from '../../operational-brief/wait-brief';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC, MAX_LOCK_WAIT_SEC as MAX_WAIT_SEC } from './lock-config';
import { hardText, LIMITS } from '../limits';
import { isExternalLockKey, resolveExternalPathLockIdentity } from './external-path';
import { resolveExplicitFileLockDomain } from './coordination-domain';
import { isTransientPgConnectionError } from '../../host-benign-errors';
import { validateExplicitRepoPaths } from '../work_items/_derive-paths';

/** wake_on_grant queue window (await-event-primitive D-005): how long a
 *  SLEEPING waiter's ticket stays grant-eligible. It must cover the longest
 *  legal holder lease; otherwise a waiter can expire before a valid 1h holder
 *  is even grantable. A larger deployment override remains honored. */
const configuredWakeQueueWindowSec = Number(
  process.env.PAPERCUSP_LOCK_WAKE_QUEUE_SEC ?? 1800,
);
const WAKE_QUEUE_WINDOW_SEC = Math.max(
  MAX_TTL_SEC,
  Number.isFinite(configuredWakeQueueWindowSec) && configuredWakeQueueWindowSec > 0
    ? Math.floor(configuredWakeQueueWindowSec)
    : MAX_TTL_SEC,
);

/** Silent-drop ceiling: every iteration of the await wakes after at
 *  most this many ms so we can re-check waiter status if the LISTEN
 *  connection died without delivering. */
const WAIT_CEILING_MS = 30_000;

/** Progress event cadence during wait — surfaces live wait state
 *  (elapsed, ahead_count, busy snapshot) to the agent's progress
 *  display so it isn't blocked silently. Independent of the wake
 *  mechanism; fires regardless of why the await woke. */
const PROGRESS_TICK_MS = 10_000;

export default defineTool({
  name: 'locks:acquire',
  description:
    'Claim repository or authorized home-directory/XDG-runtime files for exclusive editing. A workspace-global file-lock surface: omit `harness` and `workspace`; use `coordination_domain` only when the physical checkout differs. Pass repo-relative POSIX `paths`; pass current-user home or XDG_RUNTIME_DIR files via absolute `external_paths` (mapped to edit-hook reserved keys). Pass the required short `intent` so a blocked peer can see what this lock is for. Do not pass a top-level `goal_ref`: the server derives lock attribution from the caller\'s current agent-state stamp, not caller input.',
  guidance: {
    // P-011: response documentation lives in `returns`, which promptWeight() does not
    // sum (description + when + notWhen + chaining + byRole only) — the WI-9334 pattern.
    // The wake_on_grant guidance that used to duplicate itself here and in `chaining`
    // now lives only in `chaining`.
    returns:
      'ok + lock_id on success, or busy + contention details (current holder, their intent, and the expiry) on a conflict.',
    when: 'When a session lacks lock hooks, claim its atomic edit set; for a DELIBERATE multi-file change acquire once and release after the edits so git-sync can commit them; managed Codex/Claude/OMP homes hook apply_patch/Edit/Write automatically.',
    notWhen:
      'Read-only inspection needs no claim. In a hooked session, do not wrap incidental edits in manual acquire/release.',
    chaining:
      'On ok: finish the atomic edits → locks:release { lock_id }; git-sync excludes live-locked paths. If the edit is still uncommitted, omit published_sha; pass published_sha only when you have actually published a lowercase 40–64-character hexadecimal commit SHA. On busy PREFER wake_on_grant:true → END YOUR TURN; grant re-invokes you with lock_id + running TTL — never poll or hold the turn. Block only when you need the lock this turn and the holder is about to finish; events:cancel + locks:cancel_wait retracts a queued wake.',
    seeAlso: [
      'locks:acquire_granular (a directory/subtree, not a single file set)',
      'locks:acquire_resource (a named shared resource — dev server, db schema)',
      'locks:release (drop the lock after committing)',
    ],
    // EI-21988514956470475: `mode` is the THIRD documented-looking key rejected here
    // with no pointer to the remedy (after `coordination_domain`, EI-21104703429792156).
    // `seeAlso` already names both sibling tools, but it is guidance-surface only — the
    // caller who needs it is on the FAILURE path, where they saw just "this tool accepts
    // ONLY: …". That reads as "exclusivity is not selectable here", and the filed item
    // called `mode` "documented" although no doc pairs it with locks:acquire: the shape
    // comes from locks:acquire_resource, whose `mode: 'exclusive'` appears verbatim in
    // CLAUDE.md's mutation-probe recipe. Zero prompt weight (argRedirects is excluded
    // from describeFromGuidance), paid for only on the rejection that needs it.
    argRedirects: {
      // Explicit drop shape: this remedy has no replacement destination, so it
      // must not be parsed as a same-tool path or a cross-tool call.
      mode: {
        drop: true,
        note: 'file locks have NO mode — they are ALWAYS exclusive-per-path, so there is nothing for `mode` to select: drop the key and the lock you get IS the exclusive one you were asking for. `mode` belongs to the sibling lock families — locks:acquire_resource { resource, mode: shared|exclusive } for a NAMED resource (dev server, db schema), and locks:acquire_granular { path, mode: IS|IX|S|SIX|X } for a directory/subtree intention lock.',
      },
      // EI-21713580465105839: filed together with `mode` — the same caller carried BOTH
      // keys over from the locks:acquire_resource shape. `mode` alone was covered, so the
      // rejection still read as a bare key list for half the report. Unlike `mode` (which
      // has no counterpart here) the remedy is a RENAME, not a drop: dropping it loses the
      // required field and produces a second rejection.
      reason: 'this tool spells that `intent` (required, one line, shown to a peer whose edit this lock blocks) — RENAME the key rather than dropping it, or the retry fails again on a missing `intent`. `reason` is the spelling used by the named-resource family, locks:acquire_resource { resource, mode, reason }.',
      // EI-22380017954531073. Authored as a LOCAL target (`ttl_sec — …`) per D-004 of
      // tool-contract-repair-2026-09-05: a bare prose target fails the path regex and
      // renders "it is written by <the sentence>", telling a caller who used the wrong
      // key on the RIGHT tool that some other tool owns their data.
      //
      // Why a redirect and not an accepted alias: this tool's args are deliberately
      // snake_case throughout (ttl_sec, external_paths, wake_on_grant, pending_edit,
      // coordination_domain), so a camelCase guess is SYSTEMATIC here rather than a
      // one-off typo, and accepting one spelling would leave the other five surprising.
      ttlSec:
        'ttl_sec — this tool spells every arg snake_case (ttl_sec, external_paths, wake_on_grant, pending_edit), unlike most of the catalog: RENAME the key rather than dropping it. Dropping it is not harmless — the lock silently takes the DEFAULT TTL instead of the lifetime you asked for, so a long edit can have its lock expire underneath it.',
      resource: {
        tool: 'locks:acquire_resource',
        args: { resource: '<registered resource>', mode: 'exclusive', reason: '<why>' },
        note: 'locks:acquire takes repo-relative `paths` (files), never a named `resource`. A named resource must be registered first (locks:register_resource) and is listed by locks:list',
      },
    },
  },
  capability: 'locks:write',
  // Framework default per-tool timeoutSec is 60s. wait.max_sec can
  // be up to MAX_WAIT_SEC (the lock-config cap), so we'd be killed mid-wait at 60s.
  // Bump above MAX_WAIT_SEC with a margin for the final-busy retry
  // + unsubscribe + progress-emit work that runs after wait_until.
  timeoutSec: MAX_WAIT_SEC + 30,
  requirePrincipal: false,
  // EI-20189550491880126: the handler never reads ctx.tx. It performs its own
  // inWorkspaceTxn work and may await authority/listener paths, so retaining
  // the host ambient workspace transaction would pin an org-app pool slot for
  // the whole acquire and make unrelated lock calls time out under fleet load.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    paths: z.array(z.string().min(1)).max(50).optional().describe('repo-relative POSIX file paths (no ./, .., backslashes, or absolute paths)'),
    coordination_domain: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'absolute canonical repository checkout root (not a harness/workspace slug) supplied by a client edit hook when its operator checkout differs from the edited tree, e.g. /workspace/papercusp',
      ),
    external_paths: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('absolute files below the current user home or XDG_RUNTIME_DIR; managed Papercusp repository files use their repository-domain identity, while ordinary files map to @external/home/* or @external/runtime/* keys shared with automatic edit hooks'),
    intent: hardText(LIMITS.SHORT_TITLE),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
    wait: z
      .object({
        max_sec: z
          .number()
          .int()
          .nonnegative()
          .describe(
            `Blocking same-turn wait in seconds. A value above ${MAX_WAIT_SEC} is CLAMPED to ${MAX_WAIT_SEC} (not rejected) — the turn cannot block longer than the tool's own timeout. For a longer wait, end your turn with wake_on_grant:true instead.`,
          ),
      })
      .optional(),
    wake_on_grant: z
      .boolean()
      .optional()
      .describe(
        'On contention: queue a waiter ticket + a one-shot wake subscription and return IMMEDIATELY (no held turn). End your turn; when the grant cascade reaches your ticket you are re-invoked with the lock_id (TTL running). Takes precedence over wait.',
      ),
    pending_edit: z
      .object({
        file: z.string().min(1).describe('The single repo-relative path to edit — MUST equal paths[0].'),
        old_string: z.string().min(1).describe('Exact text to replace — must occur EXACTLY ONCE in the current file.'),
        new_string: z.string().describe('Replacement text.'),
      })
      .optional()
      .describe(
        'APPLY-ON-GRANT: attach the concrete edit you were going to make (the Edit-tool contract). Requires wake_on_grant + a single-file claim (paths must be exactly [pending_edit.file]). On grant the server applies it iff old_string still matches exactly once, then notifies you PASSIVELY (no wake). If the holder changed that region it is NOT applied and you are woken to redo it — i.e. it degrades to plain wake_on_grant. Best for a small, provably-non-conflicting edit to a high-contention shared file. SINGLE HUNK ONLY (EI-11057): if your real change needs a COMPANION hunk elsewhere in the SAME file (e.g. adding an import alongside a new call site, or a decl+every-ref rename), do NOT use pending_edit for just one half — an apply-on-grant that lands only the body hunk while a needed import/decl is missing ships a compile-broken file to the shared tree. For a multi-hunk edit, skip pending_edit and use a plain `wake_on_grant:true` (no pending_edit) so you land ALL hunks together after the grant.',
      ),
  }).superRefine((args, ctx) => {
    const total = (args.paths?.length ?? 0) + (args.external_paths?.length ?? 0);
    if (total === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass at least one repo-relative `paths` entry or absolute home/runtime `external_paths` entry' });
    if (total > 50) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at most 50 total paths may be acquired in one call' });
    if (args.pending_edit && (args.external_paths?.length ?? 0) > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending_edit'], message: 'pending_edit supports repository paths only; edit external files after the lock grant' });
    }
  }),
  result: z
    .object({
      ok: z.unknown().optional(),
      lock_id: z.unknown().optional(),
      owner: z.unknown().optional(),
      expires_ts: z.unknown().optional(),
      held: z.unknown().optional(),
      newly_held: z.unknown().optional(),
      busy: z.unknown().optional(),
      contention: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain: defaultCoordinationDomain } = readFileLockIdentity(ctx);
    const explicitCoordinationDomain = args.coordination_domain !== undefined;
    let coordinationDomain: string;
    try {
      coordinationDomain = resolveExplicitFileLockDomain(args.coordination_domain, defaultCoordinationDomain);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    let paths: string[];
    try {
      const externalIdentities = (args.external_paths ?? []).map((path) =>
        resolveExternalPathLockIdentity(path),
      );
      const managedDomains = [
        ...new Set(
          externalIdentities
            .map((identity) => identity.coordinationDomain)
            .filter((domain): domain is string => domain !== undefined),
        ),
      ];

      // A single acquire returns one lock id and therefore one coordination
      // domain. Managed suite-app files must use their physical repository
      // domain + repo-relative path, exactly like the native edit hooks; mixing
      // that identity with an ordinary HOME/runtime file would otherwise put
      // one of the two files in the wrong namespace.
      if (managedDomains.length > 1) {
        return errorResult(
          `external_paths span multiple managed repositories (${managedDomains.join(', ')}). ` +
            'Acquire each repository domain separately so one lock id cannot mix physical namespaces.',
        );
      }
      if (managedDomains.length === 1) {
        const managedDomain = managedDomains[0]!;
        if (explicitCoordinationDomain && coordinationDomain !== managedDomain) {
          return errorResult(
            `external path resolves inside managed repository ${JSON.stringify(managedDomain)}, ` +
              `but coordination_domain resolves to ${JSON.stringify(coordinationDomain)}. ` +
              'Use the managed repository root as coordination_domain or omit it.',
          );
        }
        if (!explicitCoordinationDomain) coordinationDomain = managedDomain;
        if (externalIdentities.some((identity) => identity.coordinationDomain === undefined)) {
          return errorResult(
            'external_paths mix a managed repository file with an ordinary HOME/runtime file. ' +
              'Acquire those namespaces in separate calls so each lock uses its canonical domain.',
          );
        }
      }

      paths = normalizePaths([
        ...(args.paths ?? []),
        ...externalIdentities.map((identity) => identity.path),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResult({ ok: false, error: msg });
    }

    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    // Caller-DX (watchdog P-006): an over-cap wait is CLAMPED to MAX_WAIT_SEC,
    // not zod-rejected. The ceiling is a hard constraint — it must return before
    // the ~55s MCP client deadline (EI-21389299859182434: the old 300s cap made
    // every >55s blocking wait die client-side with -32001/unknown outcome while
    // the server blocked on), and the tool itself is killed at MAX_WAIT_SEC+30.
    // A longer wait belongs to wake_on_grant. Agents repeatedly bounced off the
    // old `.max(300)` rejection — clamp + advise.
    const requestedWaitSec = args.wait?.max_sec ?? 0;
    const waitClamped = requestedWaitSec > MAX_WAIT_SEC;
    const maxWaitSec = waitClamped ? MAX_WAIT_SEC : requestedWaitSec;
    const startedAt = Date.now();
    // Snapshot once, before either the instant-grant or queued-edit path. An owner can
    // hold several work-items and change its active goal while a waiter is blocked; the
    // queue-time pointer is the only honest attribution for the eventual edit.
    const goalRef = readAgentStateStamp(ownerId).goalRef ?? undefined;

    // ── GOAL-mode never-implement gate (EI-20581099901890760) ────────────
    // An automatic per-edit hook claim (intent 'PreToolUse:*') by a session
    // whose REGISTERED mode is 'goal' is refused with a teaching reason; the
    // edit hook feeds `reason` back to the model verbatim. Flag-gated
    // (GOAL_MODE_EDIT_DENY, default ON), fail-open, and scoped so fleet
    // members that merely INHERIT goal context are never touched — see
    // goal-mode-edit-guard.ts for the full rationale.
    {
      const denyReason = await checkGoalModeEditGuard({
        workspaceId: resolveAgentIdentity(ctx).workspaceId,
        ownerId,
        intent: args.intent,
      });
      if (denyReason) {
        return jsonResult({ ok: false, reason: denyReason, busy: [] });
      }
    }

    // ── pending_edit guardrails (EI-9033) ───────────────────────────
    // Apply-on-grant is single-file + wake-only by construction. Validate the
    // shape up front so a malformed request fails loudly here rather than
    // silently queueing a waiter whose edit can never satisfy the guardrail.
    let pendingEdit: { file: string; old_string: string; new_string: string; goal_ref?: string } | undefined;
    if (args.pending_edit) {
      if (!args.wake_on_grant) {
        return errorResult('pending_edit requires wake_on_grant:true (apply-on-grant runs on the wake queue, not a blocking wait).');
      }
      let editFile: string;
      try {
        editFile = normalizePaths([args.pending_edit.file])[0];
      } catch (err: unknown) {
        return errorResult(`pending_edit.file invalid: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (paths.length !== 1 || paths[0] !== editFile) {
        return errorResult('pending_edit is single-file only: paths must be exactly [pending_edit.file].');
      }
      pendingEdit = {
        file: editFile,
        old_string: args.pending_edit.old_string,
        new_string: args.pending_edit.new_string,
        goal_ref: goalRef,
      };
    }

    // ── Fast path: try once, no wait ─────────────────────────────────
    // fed-reanchor-2026-06-06 P-060 (cutover 2): route the acquire DECISION through the
    // file-lock authority. On a single box (no remote peers) routeFileLockOp's cached
    // fast-path runs `op.local()` directly — byte-identical to the pre-cutover path.
    // Cross-machine, the elected Hive authority serializes the acquire (one winner across
    // Swarms editing the same physical repo). DEFENSIVE: any fault in the routing layer
    // degrades to the raw local acquire, so the worst case on the fleet's hot per-edit
    // path is exactly today's behavior. The WAIT / wake_on_grant queue below stays local
    // (cross-machine waiter coherence is a documented further step).
    const localAcquire = (): Promise<Awaited<ReturnType<typeof tryAcquire>>> =>
      inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
        tryAcquire(tx, {
          coordinationDomain,
          owner: ownerId,
          ownerLabel,
          paths,
          intent: args.intent,
          ttlSec,
          goalRef,
          automatic: args.intent.startsWith('PreToolUse:'),
        }),
        { paths },
      );

    let first: Awaited<ReturnType<typeof tryAcquire>> & { sha_token?: ShaTokenGrant };
    // P-015 (WI-1550): when the grant is decided LOCALLY (we are the authority, or
    // fail-open/no-peers) rather than relayed to a remote authority, this peer must
    // append the lock-event itself — a remote authority already records its own
    // grants inside buildFileLockAuthorityHandlers, so only the local/fail-open vias
    // need it here. `routedScope` is the resolved harness/hive scope key (unset for
    // an unmanaged domain, where there's no federated stream to append to anyway).
    let emitScope: string | undefined;
    try {
      // EI-13189: retry a TRANSIENT per-workspace advisory-lock timeout (pg
      // 57014/55P03 — WorkspaceContendedError) before surfacing it to the caller.
      // This is the SAME `acquireWithContentionRetry` backoff the PreToolUse
      // per-edit hook (file-lock-guard.ts) and git-sync already ride out under
      // load; the explicit `locks:acquire` MCP tool never had it wired in, so a
      // background-sync contention dip on a busy workspace produced a
      // user-visible `workspace_contended` failure with an UNKNOWN holder —
      // exactly the routine-background-sync symptom this item reported.
      const routed = await acquireWithContentionRetry(() =>
        routeFileLockOp<Awaited<ReturnType<typeof tryAcquire>> & { sha_token?: ShaTokenGrant }>(
          coordinationDomain,
          {
            local: localAcquire,
            remote: {
              kind: FILE_LOCK_OP_KINDS.acquire,
              payload: {
                owner: ownerId,
                ownerLabel,
                paths,
                intent: args.intent,
                ttlSec,
                goalRef,
                automatic: args.intent.startsWith('PreToolUse:'),
                coordinationDomain,
              } satisfies FileLockAcquireParams,
              decode: (raw) => decodeRemoteAcquire(raw, paths, ttlSec),
            },
          },
        ),
      );
      first = routed.value;
      if (routed.via !== 'remote-authority') emitScope = routed.scope;
    } catch (err) {
      // Same-workspace contention outlasted the retries above (P-015): surface a
      // structured result rather than leaking a raw PG error to the agent.
      // EI-9478: this is NOT "held by another agent" — no holder is enumerable
      // because we never got the per-workspace serialization lock (often the
      // caller's OWN parallel edit, or a starved pool). A bare `busy: []` made
      // the edit hook fabricate a foreign-holder denial; return an explicit
      // transient reason instead so callers retry rather than queue a wake.
      // `WorkspaceContendedError` normally comes from @papercusp/locks, but
      // transport/package boundaries can preserve only its discriminating
      // name/pgCode (or expose the original postgres `code`). Use the shared
      // structural classifier so a final raw 57014/55P03 is never leaked as
      // handler_error merely because `instanceof` crossed a module boundary.
      if (isWorkspaceContended(err)) return workspaceContended();
      // Defensive fallback: a fault in the authority-routing layer must never break the
      // live per-edit lock path — degrade to the raw local acquire (pre-cutover behavior),
      // itself contention-retried for the same reason as the primary path above.
      // (The routing layer faulted before resolving a scope, so this rare recovery path
      // doesn't emit a lock-event — best-effort capture, never worth failing the acquire.)
      try {
        first = await acquireWithContentionRetry(localAcquire);
      } catch (err2) {
        if (isWorkspaceContended(err2)) return workspaceContended();
        throw err2;
      }
    }

    if (first.ok) {
      // Notify firehose removed at the source (D-002, fleet-coordination-painpoints):
      // lock_acquired had no push-consumer — an agent learns contention on its own acquire.
      //
      // G-0 (P-033) sha-token stamp: a remote-authority grant carries the
      // authority's token (sha_token via decodeRemoteAcquire); a local /
      // fail-open grant computes it from the local registry. Recorded AFTER
      // computing so this grant doesn't shadow the prior holder's state. The
      // wait/wake_on_grant queue grants below stay unstamped — that queue is
      // the documented machine-local residual.
      const held = first.held ?? paths;
      // WI-1549: pass `ownerId` so a holder re-acquiring its OWN
      // expired-but-unreleased grant isn't misreported as unsynced risk.
      const shaToken = first.sha_token ?? shaTokenForGrant(coordinationDomain, held, Date.now(), ownerId);
      noteShaTokenGrant(coordinationDomain, held, ownerId, first.expires_ts.getTime());
      // WI-1550 (P-015): append the instant-handover lock-event for a LOCALLY-decided
      // grant (see the emitScope comment above). No-ops when this scope isn't federating
      // (the installed sink degrades to a no-op) — always safe to call.
      if (emitScope) {
        emitAcquireLockEvents((event) => void recordLockEvent(event), {
          scope: emitScope,
          owner: ownerId,
          paths: held,
          expiresAtMs: first.expires_ts.getTime(),
          ts: Date.now(),
        });
      }
      return ok(
        ownerId,
        ownerLabel,
        first.lock_id,
        first.expires_ts,
        first.held,
        undefined,
        shaToken,
        first.newly_held,
        missingRepoPathWarning(paths, coordinationDomain),
      );
    }

    // A final-write race is not ordinary holder contention. The competing
    // row may have disappeared before the snapshot, so busy=[] is expected
    // and must remain an explicit retryable outcome rather than entering the
    // wake queue or rendering "held by another agent" with no holder.
    if ('retryable' in first && first.retryable) {
      return await upsertRace(first.busy);
    }

    if ('reason' in first && first.reason === 'queued_waiter' && maxWaitSec === 0 && !args.wake_on_grant) {
      return jsonResult({
        ok: false,
        reason: 'queued_waiter',
        busy: await enrichBusy(first.busy, { ownerId }),
        advice: 'An earlier lock-wait ticket is ahead for this path. `busy` lists active holders only; use locks:queue { paths } to inspect ticket order, or wake_on_grant:true to join the queue.',
      });
    }

    // ── wake_on_grant: queue + sleep instead of block/poll ──────────────
    // (await-event-primitive-2026-06-05 D-005/P-008.) Insert a long-window
    // waiter ticket + a one-shot wake await on its grant key, return NOW.
    // The grant cascade stays single-grant control-plane; the bridge turns
    // the grant NOTIFY (or the sweep's waiter-truth read) into the wake.
    if (args.wake_on_grant) {
      startAwaitSweeper();
      // The wake queue's waiter INSERT takes the same workspace advisory
      // transaction lock as the fast acquire path. Under concurrent workspace
      // activity that lock can transiently time out (57014/55P03), so retry
      // the whole transaction before surfacing a false wake-queue failure.
      const inserted = await acquireWithContentionRetry(() =>
        inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
          tryInsertWaiter(tx, {
            coordinationDomain,
            owner: ownerId,
            ownerLabel,
            paths,
            intent: args.intent,
            ttlSec,
            maxWaitSec: WAKE_QUEUE_WINDOW_SEC,
            goalRef,
            pendingEdit,
          }),
          { paths },
        ),
      );
      if (!inserted.ok) {
        return jsonResult({ ok: false, reason: inserted.reason, busy: await enrichBusy(first.busy, { ownerId }) });
      }
      if ('self_granted' in inserted) {
        return ok(
          ownerId,
          ownerLabel,
          inserted.lock_id,
          inserted.expires_ts,
          inserted.held,
          undefined,
          undefined,
          undefined,
          missingRepoPathWarning(paths, coordinationDomain),
        );
      }

      const identity = resolveAgentIdentity(ctx);
      const { handle, note: handleNote } = await captureWakeHandleForOwner(ownerId);
      const awaitRow = await registerAwait({
        subscriberId: ownerId,
        eventKey: lockGrantKey(inserted.ticket_id),
        policy: 'wake',
        note: `lock wait: ${paths.join(', ')} — ${args.intent}`,
        wakeHandle: handle,
        // The bridge fires the key on ANY terminal ticket state, so the await
        // timeout is only the backstop behind the backstop.
        timeoutBehavior: 'wake',
        timeoutSec: WAKE_QUEUE_WINDOW_SEC + 120,
      });
      // NOTIFY fast path (best-effort; the sweep reconciler is load-bearing).
      await ensureGrantListener(coordinationDomain, identity.workspaceId ?? undefined);

      const queuedBusy = await enrichBusy(first.busy, { ownerId });
      // P-010 (OP-BRIEF-P010-WAIT): the queued wake path is the one lock outcome that blocks
      // the caller across turns, so it is the only one that carries a wait brief.
      const operationalBrief = projectLockWaitOperationalBrief({
        ticketId: inserted.ticket_id,
        paths,
        waitUntil: inserted.wait_until,
        wakeAwait: awaitRow,
        holders: queuedBusy,
        applyOnGrant: pendingEdit !== undefined,
      });

      return jsonResult({
        ok: false,
        queued_for_wake: true,
        ...(pendingEdit ? { apply_on_grant: true } : {}),
        ticket_id: inserted.ticket_id,
        await_id: awaitRow.id,
        queue_window_sec: WAKE_QUEUE_WINDOW_SEC,
        wake_handle: handleNote,
        busy: queuedBusy,
        ...(operationalBrief ? { operational_brief: operationalBrief } : {}),
        advice: pendingEdit
          ? `Queued WITH your edit attached (apply-on-grant). END YOUR TURN. On grant the server applies your edit to ${pendingEdit.file} iff old_string still matches exactly once, then drops a PASSIVE inbox note (category lock-edit-applied) — you are NOT woken and the lock is released for you. Only if the region changed under the holder are you woken (granted:true) to redo it. Retract with locks:cancel_wait + events:cancel.`
          : 'Queued. END YOUR TURN — you will be re-invoked when the grant cascade reaches your ticket (the wake carries lock_id + TTL, already running: edit, then locks:release). If the window lapses without a grant you are woken with granted:false. Retract with locks:cancel_wait + events:cancel.',
      });
    }

    if (maxWaitSec === 0) {
      return await busy(first.busy);
    }

    // ── Wait path ────────────────────────────────────────────────────
    // Step 1: subscribe to the workspace channel BEFORE we INSERT.
    // The listener is a bare wake-bus; we'll filter by our ticket_id
    // once we know it.
    let ticketId: string | null = null;
    let wakeResolve: (() => void) | null = null;
    // pendingWake buffers a notification that arrived BEFORE we
    // entered the await (e.g., cascade fired between readWaiterStatus
    // and the while loop). Without this, the callback would discard
    // the wake (wakeResolve is null) and we'd wait up to the 30s
    // ceiling to re-poll. Bug-#14 fix.
    let pendingWake = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    let progressTimer: ManagedHandle | null = null;

    // Capture ctx.progress safely — UnifiedToolContext exposes it
    // when the transport supports streaming; older shapes / shim
    // callers may not have it.
    const emitProgress = (ctx as { progress?: (pct: number | undefined, msg?: string) => void }).progress
      ?? (() => undefined);

    try {
      try {
        unsubscribe = await subscribeWorkspace(coordinationDomain, (tid /* ignored kind */) => {
          if (ticketId && tid === ticketId) {
            pendingWake = true;
            if (wakeResolve) {
              const r = wakeResolve;
              wakeResolve = null;
              r();
            }
          }
        });
      } catch (err: unknown) {
        if (err instanceof TooManyActiveWorkspacesError) {
          return await tooManyWorkspaces(first.busy);
        }
        throw err;
      }

      // Step 2: already attempted above (first try). It returned busy,
      // so proceed to INSERT.

      // Step 3: INSERT INTO agent_lock_waiters.
      //
      // EI-19382183884861720: same transient-connection exposure class as
      // EI-19324204900062056 below (a pgbouncer transaction-pool reclaim
      // mid-flight rejects the in-flight query with CONNECTION_CLOSED,
      // which postgres-js only recovers from on the NEXT query) — but here
      // it fires on the FIRST write of the wait path, before any ticket
      // exists, which matches the reproduced symptom (`locks:acquire` with
      // a blocking `wait` dying immediately, not after minutes of polling).
      // Nothing has committed yet (the connection dropped before/during the
      // transaction, so PG rolled it back), so a single clean retry on
      // postgres-js's auto-reconnected pool is safe — unlike the read-path
      // fix below, there is no partial ticket state to reconcile.
      const insertOnce = () =>
        inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
          tryInsertWaiter(tx, {
            coordinationDomain,
            owner: ownerId,
            ownerLabel,
            paths,
            intent: args.intent,
            ttlSec,
            maxWaitSec,
            goalRef,
          }),
          { paths },
        );
      let inserted: Awaited<ReturnType<typeof insertOnce>>;
      try {
        inserted = await insertOnce();
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        inserted = await insertOnce();
      }

      if (!inserted.ok) {
        return jsonResult({ ok: false, reason: inserted.reason, busy: await enrichBusy(first.busy, { ownerId }) });
      }

      // Self-grant — the path freed between our first busy-return and
      // tryInsertWaiter's pre-insert acquire attempt. No waiter was
      // queued; we already hold the lock.
      if ('self_granted' in inserted) {
        // notify firehose removed at the source (D-002)
        return ok(ownerId, ownerLabel,
          inserted.lock_id,
          inserted.expires_ts,
          inserted.held,
          Math.floor((Date.now() - startedAt) / 1000),
          undefined,
          undefined,
          missingRepoPathWarning(paths, coordinationDomain),
        );
      }

      ticketId = inserted.ticket_id;
      const waitUntilMs = inserted.wait_until.getTime();
      // EI-19921385348146413: readWaiterStatus's status union has FIVE arms
      // ('waiting' | 'granted' | 'expired' | 'cancelled' | 'missing'), but only
      // 'cancelled'/'expired' were treated as terminal below — 'missing' (the
      // waiter row itself vanished: janitor sweep, external DELETE, workspace
      // teardown) fell into the same bucket as 'waiting' and spun to the full
      // wait.max_sec deadline polling a row that no longer exists. Track WHY we
      // bail so the final response can name the real cause instead of folding
      // every non-grant outcome into an undifferentiated timeout/busy snapshot.
      let terminalReason: 'cancelled' | 'expired' | 'released' | 'waiter_vanished' | undefined;

      // Phase 2 polish: 10s progress heartbeat with elapsed +
      // ahead_count + busy snapshot. Independent of the wake mechanism
      // so the agent sees liveness even when nothing has moved.
      const emitProgressTick = async () => {
        try {
          const sql = getTxPool();
          const q = await readQueue(sql, { coordinationDomain, paths });
          const mine = ticketId
            ? q.waiting.find((w) => w.ticket_id === ticketId)
            : undefined;
          const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
          emitProgress(
            undefined,
            JSON.stringify({
              phase: 'waiting',
              ticket_id: ticketId,
              elapsed_sec: elapsedSec,
              ahead_count: mine?.ahead_count ?? null,
              busy: q.active_locks
                .filter((l) => paths.includes(l.path))
                .map((l) => ({
                  path: l.path,
                  owner_label: l.owner_label,
                  intent: l.intent,
                  expires_ts: l.expires_ts.toISOString(),
                })),
            }),
          );
        } catch {
          // Best-effort — progress events should never break the wait.
        }
      };
      progressTimer = managedSetInterval('lock-wait-progress', PROGRESS_TICK_MS, () => {
        void emitProgressTick();
      }, { category: 'lifecycle', instanced: true });
      // Emit one immediately so the agent sees state before the first
      // 10s tick fires.
      void emitProgressTick();

      // Re-check status immediately — a grant cascade could have fired
      // between our LISTEN+INSERT and now.
      //
      // EI-19382183884861720: this is the ONE `readWaiterStatus`/pooled-
      // connection call in the wait path EI-19324204900062056's transient-
      // connection treatment did not reach — it runs BEFORE the step 4-5
      // loop that fix protects, on the exact same `sqlPool`, so a pgbouncer
      // transaction-pool reclaim here threw CONNECTION_CLOSED straight out
      // of the tool handler (an opaque MCP -32603) rather than degrading
      // like every other query on this connection already does. This is
      // the most likely site for the reported "dies... immediately"
      // symptom, since it fires right after step 3's INSERT, before any
      // loop iteration has run. Treat it identically to the loop's own
      // handling below: skip this one check and fall through into the
      // step 4-5 loop, which re-polls on postgres-js's auto-reconnected
      // pool — the outer `waitUntilMs` bound still governs.
      const sqlPool = getTxPool();
      try {
        const status = await readWaiterStatus(sqlPool, ticketId);
        if (status.status === 'granted' && status.granted_lock_id) {
          return ok(ownerId, ownerLabel,
            status.granted_lock_id,
            status.granted_expires_ts ?? new Date(Date.now() + ttlSec * 1000),
            status.paths ?? paths,
            Math.floor((Date.now() - startedAt) / 1000),
            undefined,
            undefined,
            missingRepoPathWarning(status.paths ?? paths, coordinationDomain),
          );
        }
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        // Transient connection blip — fall through to the step 4-5 loop
        // below, which re-polls on the reconnected pool.
      }

      // Step 4-5: await loop with 30s ceiling.
      while (Date.now() < waitUntilMs) {
        // If a notification arrived BEFORE we got here (race between
        // readWaiterStatus and the await), short-circuit the wait and
        // re-read status. Bug-#14 fix.
        if (pendingWake) {
          pendingWake = false;
        } else {
          const remaining = waitUntilMs - Date.now();
          const ceiling = Math.min(remaining, WAIT_CEILING_MS);
          let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
          await new Promise<void>((resolve) => {
            wakeResolve = resolve;
            ceilingTimer = setTimeout(() => {
              // Ceiling fired — fall through to re-poll.
              if (wakeResolve) {
                const r = wakeResolve;
                wakeResolve = null;
                r();
              }
            }, ceiling);
          });
          // Clear the ceiling timer in case the LISTEN wake fired first;
          // without this, a stale timer from iteration N could fire
          // during iteration N+1's await and trigger a spurious wake.
          if (ceilingTimer !== null) clearTimeout(ceilingTimer);
          wakeResolve = null;
        }

        // Bug-#13 fix: nudge the workspace before reading status.
        // If a holder's lock expired without an explicit release (TTL
        // lapse), nothing else in PG fires the cascade. The poke runs
        // the janitor + cascade for our workspace; if we should now
        // be granted, the status read below picks that up.
        //
        // EI-19324204900062056: a long blocking wait can outlive a
        // server-side connection (pgbouncer's transaction-pooling
        // reclaim, or a PG-server-side reset) — postgres-js's pool
        // reconnects transparently on the NEXT query, but the query
        // IN FLIGHT when the connection dropped rejects with
        // CONNECTION_CLOSED/CONNECT_TIMEOUT (the same transient class
        // pg-transient-retry.ts + host-benign-errors.ts already
        // classify as self-healing elsewhere). Previously that raw
        // rejection propagated out of the tool handler and killed the
        // whole call with an opaque MCP -32603, indistinguishable at
        // the call site from a dead operator/datastore. Treat it the
        // same as a silent notification drop: skip this tick, loop
        // back and re-poll on the reconnected pool — the outer
        // `waitUntilMs` bound still governs, so this cannot spin
        // forever, and a genuinely non-transient error still rethrows.
        try {
          await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
            pokeWorkspace(tx, coordinationDomain),
          );

          const status = await readWaiterStatus(sqlPool, ticketId);
          if (status.status === 'granted' && status.granted_lock_id) {
            return ok(ownerId, ownerLabel,
              status.granted_lock_id,
              status.granted_expires_ts ?? new Date(Date.now() + ttlSec * 1000),
              status.paths ?? paths,
              Math.floor((Date.now() - startedAt) / 1000),
              undefined,
              undefined,
              missingRepoPathWarning(status.paths ?? paths, coordinationDomain),
            );
          }
          if (
            status.status === 'cancelled' ||
            status.status === 'expired' ||
            status.status === 'released' ||
            status.status === 'missing'
          ) {
            // External cancel, DB-side expiry, or the waiter row itself vanished
            // (EI-19921385348146413) — all three are TERMINAL, not transient, so
            // bail immediately instead of polling to the full deadline.
            terminalReason = status.status === 'missing' ? 'waiter_vanished' : status.status;
            break;
          }
          // status === 'waiting' → loop back, await again.
        } catch (err: unknown) {
          if (!isTransientPgConnectionError(err)) throw err;
          // Transient connection blip mid-wait — the next iteration's
          // queries run on postgres-js's auto-reconnected pool.
        }
      }

      // Step 6: timeout — mark expired and return busy snapshot.
      //
      // EI-19324204900062056: this is the SAME transient-connection
      // exposure as the poll loop above, on the tail end where a wait
      // legitimately ran to its own deadline. Degrade to a structured
      // "can't confirm final state" response instead of crashing the
      // call — the caller still has ticket_id and can retry with
      // wake_on_grant:true (which does not hold the turn/connection
      // open and so isn't exposed to this class at all).
      try {
        await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) => {
          if (ticketId) await expireWaiter(tx, ticketId);
        });
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        return waitConnectionUnstable(ticketId);
      }

      // Re-read the current busy snapshot (may differ from the initial
      // first.busy if some paths freed but others didn't).
      let finalBusy:
        | { won: true; lockId: string; expires: Date; held: string[] }
        | { won: false; busy: AcquireBusy[]; reason?: 'queued_waiter' };
      try {
        finalBusy = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) => {
          const r = await tryAcquire(tx, {
            coordinationDomain,
            owner: ownerId,
            ownerLabel,
            paths,
            intent: args.intent,
            ttlSec,
            goalRef,
          });
          if (r.ok) {
            // Lucky race — got it after timeout fired but before re-read.
            return { won: true as const, lockId: r.lock_id, expires: r.expires_ts, held: r.held };
          }
          return {
            won: false as const,
            busy: r.busy,
            ...('reason' in r && r.reason === 'queued_waiter' ? { reason: r.reason } : {}),
          };
        }, { paths });
      } catch (err: unknown) {
        if (!isTransientPgConnectionError(err)) throw err;
        return waitConnectionUnstable(ticketId);
      }

      if (finalBusy.won) {
        // notify firehose removed at the source (D-002)
        return ok(ownerId, ownerLabel,
          finalBusy.lockId,
          finalBusy.expires,
          finalBusy.held,
          Math.floor((Date.now() - startedAt) / 1000),
          undefined,
          undefined,
          missingRepoPathWarning(finalBusy.held, coordinationDomain),
        );
      }

      return jsonResult({
        ok: false,
        busy: await enrichBusy(finalBusy.busy),
        ticket_id: ticketId,
        // EI-19921385348146413: name the real terminal cause instead of an
        // undifferentiated busy/timeout snapshot. Absent ⇒ genuine wait.max_sec
        // timeout (the loop condition ran out, not a status-driven break).
        ...(terminalReason
          ? {
              reason: terminalReason,
              ...(terminalReason === 'waiter_vanished'
                ? {
                    reason_detail:
                      'the waiter row disappeared mid-wait (janitor sweep, external DELETE, or workspace teardown) — nothing could ever have granted this ticket; retry acquire from scratch',
                  }
                : {}),
            }
          : 'reason' in finalBusy && finalBusy.reason
            ? { reason: finalBusy.reason }
            : { reason: 'timeout' }),
        ...(waitClamped
          ? {
              wait_clamped: {
                requested_sec: requestedWaitSec,
                capped_sec: MAX_WAIT_SEC,
                advice:
                  `wait was capped at ${MAX_WAIT_SEC}s (the blocking ceiling — the call must return before the ~55s MCP client deadline). For a longer wait, retry with wake_on_grant:true and END YOUR TURN — you are re-invoked when the grant cascade reaches your ticket.`,
              },
            }
          : {}),
      });
    } finally {
      if (progressTimer) {
        progressTimer.stop();
        progressTimer = null;
      }
      if (unsubscribe) {
        await unsubscribe().catch(() => undefined);
      }
    }
  },
});

/**
 * EI-22077619752041149: this tool declares an object-rooted `result` schema,
 * which tool-projection advertises to MCP clients as `outputSchema` — and the
 * MCP spec then requires `structuredContent` on every non-error response.
 * Strict clients (codex-rs) fail the whole envelope when it is missing, even
 * though the acquire already executed server-side ("the mutation executes
 * despite the invalid response envelope"). Every response path therefore
 * returns the JSON text AND its structured twin through this one constructor;
 * the dispatch layer passes a handler-set `structuredContent` through
 * untouched (attachRequestedStructuredContent skips when it is already
 * present, and reencodableJsonPayload declines to re-encode such a result).
 */
function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function ok(
  owner: string,
  ownerLabel: string,
  lockId: string,
  expires: Date,
  held: string[],
  waitedSec?: number,
  // G-0 (P-033): the sha-token stamp — requiredSha = the prior holder's
  // published head (build on it; check ancestry vs local staging via the
  // hive-git grade helpers), unsyncedRisk = the prior grant expired without a
  // release. Present on fast-path grants of hive-scoped file locks.
  shaToken?: ShaTokenGrant,
  newlyHeld?: string[],
  pathWarning?: string,
) {
  return jsonResult({
    ok: true,
    lock_id: lockId,
    // #5 — echo the server-resolved owner so the caller can
    // verify which identity the lock was taken under.
    owner,
    owner_label: ownerLabel,
    expires_ts: expires.toISOString(),
    held,
    ...(newlyHeld !== undefined ? { newly_held: newlyHeld } : {}),
    ...(waitedSec !== undefined ? { waited_sec: waitedSec } : {}),
    ...(shaToken
      ? { sha_token: { required_sha: shaToken.requiredSha, unsynced_risk: shaToken.unsyncedRisk } }
      : {}),
    ...(pathWarning ? { path_warning: pathWarning } : {}),
  });
}

/**
 * Warn when a successful grant names an in-tree path that is absent from the
 * physical checkout. This is deliberately advisory: lock callers may reserve
 * a file they are about to create, and unit/integration callers may use
 * synthetic lock keys. External home-directory and XDG-runtime keys are
 * logical reservations, not repository paths, so they are excluded from the
 * probe.
 */
function missingRepoPathWarning(
  paths: readonly string[],
  coordinationDomain: string,
): string | undefined {
  const repoPaths = paths.filter((path) => !isExternalLockKey(path));
  // A relative or unavailable domain is a synthetic/uninspectable lock
  // namespace. Do not turn that absence of filesystem evidence into a warning.
  if (!isAbsolute(coordinationDomain) || repoPaths.length === 0 || !existsSync(coordinationDomain)) {
    return undefined;
  }

  try {
    const unresolved = validateExplicitRepoPaths(repoPaths, { repoRoot: coordinationDomain });
    if (!unresolved || unresolved.missing.length === 0) return undefined;
    const noun = unresolved.missing.length === 1 ? 'path' : 'paths';
    return (
      `locks:acquire granted ${unresolved.missing.length} repo-relative ${noun} that do NOT exist under ` +
      `coordination_domain ${JSON.stringify(coordinationDomain)}: ${unresolved.missing.join(', ')}. ` +
      'This is advisory only; the lock remains held so new-file and synthetic-path workflows continue to work. ' +
      'Re-read the canonical path spelling before editing an existing file.'
    );
  } catch {
    // A filesystem advisory must never fail an otherwise valid lock grant.
    return undefined;
  }
}

function errorResult(error: string) {
  return jsonResult({ ok: false, error });
}

/** EI-9478: the advisory-lock wait timed out before the service could identify
 * a holder. Distinct `reason` plus an explicit unknown holder keeps readers
 * from rendering the timeout as either a foreign hold or proof of no hold. */
function workspaceContended() {
  return jsonResult({
    ok: false,
    reason: 'workspace_contended',
    transient: true,
    holder: 'unknown',
    busy: [],
    advice:
      'The lock service could not serialize this call in time (advisory-lock timeout). Holder identity is unknown; this does not prove the requested files are unheld. Do NOT queue wake_on_grant for this timeout because no waiter ticket was returned; retry the operation with backoff or inspect the lock-service state.',
  });
}

/** The final upsert result changed under us before a stable holder snapshot
 * could be observed. This is safe to retry, but is not safe to interpret as
 * a confirmed file holder (especially when `busy` is empty). */
async function upsertRace(busyRows: AcquireBusy[]) {
  return jsonResult({
    ok: false,
    reason: 'upsert_race',
    transient: true,
    retryable: true,
    holder: 'unknown',
    busy: await enrichBusy(busyRows),
    advice:
      'The lock changed during the final acquire write and no stable holder snapshot was confirmed. Retry the acquire from scratch; do NOT queue wake_on_grant for this response.',
  });
}

/** EI-19324204900062056: a blocking wait's DB connection dropped (pgbouncer
 * transaction-pooling reclaim / a PG-server-side reset) and did not
 * reconnect in time to confirm the final state. Distinct, structured
 * `reason` — never a thrown/opaque MCP error — so the caller can tell this
 * apart from "held by another agent" and retry via wake_on_grant (which
 * doesn't hold a connection open across the wait, so isn't exposed to this
 * class). The ticket may still be granted server-side later; wake_on_grant
 * picks that up. */
function waitConnectionUnstable(ticketId: string | null) {
  return jsonResult({
    ok: false,
    reason: 'wait_connection_unstable',
    transient: true,
    ticket_id: ticketId,
    busy: [],
    advice:
      'The lock service could not confirm the final wait state (a transient DB connection blip outlived the blocking wait). No holder is confirmed to block you. Retry with wake_on_grant:true and END YOUR TURN instead of a long blocking wait.',
  });
}

async function busy(busyRows: AcquireBusy[]) {
  return jsonResult({ ok: false, busy: await enrichBusy(busyRows) });
}

async function tooManyWorkspaces(busyRows: AcquireBusy[]) {
  return jsonResult({ ok: false, reason: 'too_many_active_workspaces', busy: await enrichBusy(busyRows) });
}

/**
 * Map a remote-authority `FileLockAcquireResult` back to the local `tryAcquire` result
 * shape. Only runs on the cross-machine path (a remote Swarm is the authority) — never at
 * N=1, where routeFileLockOp short-circuits to `op.local()`. Busy rows cross the wire as
 * path+owner only; the caller's `enrichBusy` re-hydrates owner_label/intent from presence.
 */
function decodeRemoteAcquire(
  raw: unknown,
  paths: string[],
  ttlSec: number,
): Awaited<ReturnType<typeof tryAcquire>> & { sha_token?: ShaTokenGrant } {
  const r = raw as FileLockAcquireResult;
  if (r.ok) {
    return {
      ok: true,
      lock_id: r.lockId ?? '',
      expires_ts: r.expiresTs ? new Date(r.expiresTs) : new Date(Date.now() + ttlSec * 1000),
      held: paths,
      newly_held: r.newlyHeld ?? paths,
      // G-0 (P-033): the AUTHORITY's sha-token stamp rides the remote grant.
      ...(r.shaToken ? { sha_token: r.shaToken } : {}),
    };
  }
  const fallbackExpiry = new Date(Date.now() + ttlSec * 1000);
  const busyRows = (r.busy ?? []).map((b) => ({
    path: b.path,
    owner: b.owner,
    owner_label: null,
    intent: '',
    expires_ts: fallbackExpiry,
  }));
  if (r.retryable && r.reason === 'upsert_race') {
    return {
      ok: false,
      busy: busyRows,
      reason: r.reason,
      retryable: true,
    };
  }
  if (r.reason === 'queued_waiter') {
    return { ok: false, busy: busyRows, reason: 'queued_waiter' };
  }
  return { ok: false, busy: busyRows };
}
