/**
 * git-sync:run — fire the git-sync routine action ONCE, on demand (WI-1320).
 *
 * Closes the force-deploy-ships-stale-staging asymmetry: a (force-)deploy ships
 * whatever is COMMITTED on staging, so if git-sync is lagging or wedged, the deploy
 * ships a STALE tree (the 2026-06-30 incident — I had to hand-commit to land work).
 * git-sync otherwise has NO manual lever (only routines:set cron/pause), unlike the
 * deploy (release:deploy op:trigger/force). This invokes the SAME `system:git-sync`
 * action a cron tick runs (lock, content-guard, attribution, commit + push) via the
 * shared fireGitSyncNow, so an agent OR the deploy/gate process can make staging
 * current immediately rather than waiting for the next (≤3-min) tick.
 */
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { projectDirForSlug } from '../../operator-notes';
import { fireGitSyncNow, type GitSyncFireOutcome } from '../../harness/git-sync/git-sync-action';
import {
  GIT_SYNC_LOCK_RETRY_EVENT,
  isSystemGitSyncHolder,
  resourceReleasedEventKey,
} from '../../harness/git-sync/git-sync-events';
import { withBoundedTimeout } from '../../bounded-timeout';
import { clampText, LIMITS, softText } from '../limits';
import { requestOnlyHost } from '../../background-workers';

const execFileP = promisify(execFile);

/**
 * EI-9425: fireGitSyncNow runs the FULL commit+push across the superproject + every
 * submodule (lock, content-guard, attribution) — under PG/lock pressure (the same class
 * as WI-3818's fleet:status legs) this routinely exceeds the ~60s MCP transport budget,
 * so the tool watchdog saw a 94% timeout/error rate (tool_invocations, 2026-07-10) even
 * though the underlying commit/push frequently still lands moments later. Bound the fire
 * call so a slow tick degrades to an honest "still running" response well before the hard
 * transport cutoff, instead of the caller getting an opaque aborted-signal timeout.
 */
export const GIT_SYNC_RUN_BUDGET_MS = 45_000;

const GIT_SYNC_COMMITTED_EVENT = 'git-sync:committed';

/**
 * WI-4940: `git rev-parse HEAD` itself has NO bound — the ~120s hang the reporter
 * observed (a WI-4938 caller had to terminate its wait) happened AFTER the
 * commit had already landed, during the post-fire HEAD probe. Both probes use
 * a bounded `execFile`, and a degraded fire skips the post-fire probe so the
 * 45s fire budget cannot be extended by another child-process wait. Under
 * disk/IO stall or fleet-wide git-process contention a bare `execFile` can hang
 * indefinitely with no signal back to the caller — an ambiguous-write response-loss
 * class exactly like the one GIT_SYNC_RUN_BUDGET_MS exists to prevent for the fire
 * itself. Bound it the same way: a slow/hung `git rev-parse` degrades to `null`
 * (the function's existing catch-all outcome) instead of hanging the whole tool call.
 */
const HEAD_SHA_TIMEOUT_MS = 5_000;
const GIT_STATUS_MAX_BUFFER = 4 * 1024 * 1024;
const GIT_STATUS_MAX_PATHS = 200;

async function headSha(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: repoDir, timeout: HEAD_SHA_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
}

interface GitSyncPreview {
  repo_path: string | null;
  head_sha: string | null;
  dirty: boolean | null;
  dirty_paths: string[] | null;
  dirty_paths_truncated: boolean;
  error: string | null;
}

/**
 * Inspect the selected checkout without entering the git-sync action. This is
 * intentionally a best-effort read: a preview must never turn an unreadable
 * repository into a false clean-tree claim.
 */
async function previewGitSync(repoDir: string): Promise<GitSyncPreview> {
  const head = await headSha(repoDir);
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain=v1', '-z', '-uall'], {
      cwd: repoDir,
      timeout: HEAD_SHA_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const entries = stdout.split('\0').filter(Boolean);
    const dirtyPaths = entries.map((entry) => (entry.length >= 3 ? entry.slice(3) : entry));
    return {
      repo_path: repoDir,
      head_sha: head,
      dirty: dirtyPaths.length > 0,
      dirty_paths: dirtyPaths.slice(0, GIT_STATUS_MAX_PATHS),
      dirty_paths_truncated: dirtyPaths.length > GIT_STATUS_MAX_PATHS,
      error: null,
    };
  } catch (error) {
    return {
      repo_path: repoDir,
      head_sha: head,
      dirty: null,
      dirty_paths: null,
      dirty_paths_truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default defineTool({
  name: 'git-sync:run',
  profile: 'engineer',
  description:
    "FIRE git-sync NOW — run the git-sync routine action once on demand instead of waiting for the ≤3-min cron tick. Mutating fires must execute on the background-worker host; a request-only operator refuses before entering git-sync, while dryRun:true remains a read-only preview everywhere. The response distinguishes a LOCAL commit from CONFIRMED origin egress: on bridged/commit-only hives, status:'committed' + remote_egress.confirmed:false means wait for git-sync:egressed:<sha> or verify the remote ref before claiming delivery. The manual lever git-sync otherwise lacks (only routines:set cron/pause exists). Same action a cron tick runs (lock, content-guard, attribution). release:deploy fires this first, then follows the normal publication/gate path.",
  capability: 'operator:write',
  guidance: {
    when: 'You need the latest work COMMITTED right now — before a (force-)deploy or gate run, or to recover when git-sync is lagging/wedged. (git-sync also auto-runs every ~3 min; this just fires it on demand.) Use dryRun:true first when you only need to inspect the selected checkout.',
    notWhen:
      'Do not fire it through a request-only operator (:3070/:3170 on the canonical dev box); route the mutation to the background-worker MCP host. To retune the cadence or pause git-sync, use routines:set. To deploy, release:deploy (which already fires git-sync first).',
    chaining:
      'git-sync:run { dryRun:true } → review preview → git-sync:run → release:deploy { op:status } → op:trigger / op:force (now shipping current staging).',
  },
  requirePrincipal: false,
  // The COMMIT lever of the three-part release pipeline (COMMIT → git-sync:run,
  // VERDICT → release:checkpoint-run, DEPLOY → release:deploy) — see this file's
  // header comment. checkpoint-run and deploy already widened their invoke
  // allowlist to the full red-fix cohort + dropped the operator-config-write
  // in-handler gate (EI-7426: that gate is for tools that MUTATE fleet-wide
  // config; firing an already-scheduled, idempotent action is not that). This
  // tool is the same shape — it just fires the SAME `system:git-sync` action a
  // cron tick already runs on its own ≤3-min cycle — but was missed when
  // EI-7426 fixed its two siblings, so release-fixer (told by its own persona
  // to poll for its fix landing on staging HEAD before firing checkpoint-run)
  // kept hitting a structural role-reject trying to speed that up
  // (repeated-tool-error watchdog, EI-18117741153424215). Mirror the sibling
  // tools' allowlist exactly.
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    installSlug: z
      .string()
      .max(120)
      .optional()
      .describe('Install slug whose git-sync to fire (default: the operator home harness).'),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Alias for installSlug when using the standard per-call harness scope argument.'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview the selected checkout without firing git-sync, committing, or pushing.'),
    reason: softText(LIMITS.SHORT_TITLE)
      .optional()
      .describe(
        "OPTIONAL: why you are firing git-sync by hand. Recorded to this call's tool_invocations metadata as an audit trail; it does not change the synchronization decision. Never rejected for length or terseness; clamped if very long.",
      ),
  }),
  async handler(args, ctx) {
    // No in-handler role gate: firing git-sync is a SAFE, idempotent op — it runs
    // the same commit+push action a cron tick already fires on its own ≤3-min
    // cycle, self-locks against a concurrent tick, and mutates no config (see the
    // agentRoles note above). Access control is the invoke allowlist.
    // `harness` is the standard per-call scope spelling used by the operator
    // tools and by ptool's --harness convenience flag. Keep installSlug as the
    // canonical name for existing callers, but accept the alias so a caller
    // does not have to learn this tool's internal routine vocabulary.
    const slug = args.installSlug ?? args.harness ?? operatorHomeHarnessSlug();
    const workspaceId = activeWorkspaceId();

    // Resolve the workspace-scoped tree ONCE, then pin that exact path through
    // the HEAD probes and the action. Re-resolving inside the action used to let
    // ambient workspace state select a sibling checkout after these probes had
    // measured a different tree.
    const repoDir = await projectDirForSlug(slug, workspaceId);

    if (args.dryRun) {
      const preview: GitSyncPreview = repoDir
        ? await previewGitSync(repoDir)
        : {
            repo_path: null,
            head_sha: null,
            dirty: null,
            dirty_paths: null,
            dirty_paths_truncated: false,
            error: `No repository path is registered for install "${slug}".`,
          };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              fired: false,
              dry_run: true,
              slug,
              status: 'preview',
              preview,
              note: 'Read-only preview; git-sync was not fired and no commit or push was attempted.',
            }),
          },
        ],
      };
    }

    // EI-23216061848335411 / WI-10000734: a manual call used to execute inside
    // whichever request-serving process received it. On the split dev topology,
    // :3070 intentionally runs the older green release while :3271 runs current
    // staging background code. A :3070 call therefore escaped its 45s response
    // budget and later emitted a legacy v2 staging-advance without the owning
    // hive's countersignature, after the current host had already emitted v3.
    // The bridge correctly rejected it, freezing origin/staging. Reuse the same
    // request-only topology predicate that keeps background machinery off these
    // hosts: previews are harmless above, but a mutation must run where the
    // scheduled routine and current authority code live.
    if (requestOnlyHost()) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              fired: false,
              slug,
              status: 'refused',
              success: false,
              committed: false,
              reason: 'request-only-host',
              retry: {
                tool: 'git-sync:run',
                host_role: 'background-workers',
                dev_box_url: 'http://127.0.0.1:3271',
              },
              note:
                'This operator declares PAPERCUSP_BACKGROUND_WORKERS=0 and cannot execute a mutating git-sync fire. ' +
                'Route the same call to the current background-worker MCP host with the sanctioned CLI ' +
                '(node scripts/mcp-call.mjs git-sync:run --json-file <args.json> --client <your-su-id> --port 3271); ' +
                'run it in your client\'s background mode and inspect its log because the fire may exceed a foreground timeout. ' +
                'Or let the scheduled routine run. dryRun:true remains available here.',
            }),
          },
        ],
      };
    }

    const before = repoDir ? await headSha(repoDir) : null;

    const fired = await withBoundedTimeout<GitSyncFireOutcome | undefined>(
      () => fireGitSyncNow(slug, workspaceId, repoDir),
      {
        fallback: undefined,
        timeoutMs: GIT_SYNC_RUN_BUDGET_MS,
        label: 'git-sync:run fireGitSyncNow',
      },
    );

    // A degraded fire has already reached the caller's response budget. Do not
    // spend another bounded git probe before returning the explicit in-progress
    // or error result; the fire may still be running in the background.
    const after = repoDir && !fired.degraded ? await headSha(repoDir) : null;
    const outcome = fired.value;
    const pushedScopes = outcome && 'pushed' in outcome ? outcome.pushed : [];
    const superprojectPushConfirmed = pushedScopes.includes('superproject');
    // EI-20474698737216059: `GitSyncOutcome.status === 'synced'` means the LOCAL
    // pipeline created/advanced a commit. On bridged/commit-only hives the
    // superproject deliberately does not push here; a later bridge leg owns origin
    // egress. Forwarding the internal word as the tool's top-level status made a
    // local commit look like origin/staging had advanced even when `pushed` was
    // empty. Keep the internal outcome intact for diagnostics, but make the
    // caller-facing status and egress proof say what actually happened.
    const committedWithoutConfirmedEgress = outcome?.status === 'synced' && !superprojectPushConfirmed;
    const status = fired.degraded
      ? fired.reason === 'error'
        ? 'error'
        : 'in_progress'
      : committedWithoutConfirmedEgress
        ? 'committed'
        : (outcome?.status ?? 'unknown');
    const committed = Boolean(before && after && before !== after) || outcome?.status === 'synced';
    const success = outcome?.status === 'synced' || outcome?.status === 'nothing';
    const remoteEgress =
      outcome?.status === 'synced'
        ? superprojectPushConfirmed
          ? {
              status: 'confirmed',
              confirmed: true,
              pushed_scopes: pushedScopes,
              evidence: 'outcome.pushed includes superproject',
            }
          : {
              status: 'unverified',
              confirmed: false,
              pushed_scopes: pushedScopes,
              evidence: 'outcome.pushed does not include superproject',
              completion_event: { key: `git-sync:egressed:${outcome.headSha}`, payload_field: 'sha' },
              await_tool: 'events:await',
            }
        : undefined;
    // A timeout means the fire was accepted but its promise is still running in the
    // background. Keep that state explicitly non-terminal and hand the caller the
    // existing commit event + durable routine fields that settle/prove it, rather than
    // making `ok:true, committed:false` look like a completed no-op.
    const continuation =
      fired.degraded && fired.reason === 'timeout'
        ? {
            completion_event: { key: GIT_SYNC_COMMITTED_EVENT, payload_field: 'sha' },
            await_tool: 'git-sync:await',
            progress_ref: {
              // `routines:list` is the callable reader for this routine row. Keep the
              // selector executable and name the projected `health` paths so a caller
              // can follow the continuation without guessing at the backing table.
              surface: 'routines:list',
              tool: 'routines:list',
              args: { installSlug: slug, name: 'git-sync' },
              workspace_id: workspaceId,
              install_slug: slug,
              target_role: 'system:git-sync',
              // `last_status` is written before the GitHub bridge/P2P post-legs;
              // the activity marker is the writer-backed terminality check.
              fields: [
                'health.fire_started_at',
                'health.last_status',
                'health.last_synced_at',
                'health.head_sha',
                'health.git_sync_activity',
              ],
            },
          }
        : outcome?.status === 'skipped'
          ? {
              // A lock skip is terminal for THIS fire, but not for the requested
              // synchronization. Whether a TARGETED retry signal is coming depends on
              // the refusal CLASS, so only advertise an await that will actually fire.
              //
              ...(outcome.reason === 'held_exclusive'
                ? {
                    completion_event: {
                      key: resourceReleasedEventKey(outcome.blockedOn ?? ''),
                      payload_fields: ['resource', 'workspaceId', 'releasedAtMs'],
                    },
                    await_tool: 'events:await',
                  }
                : {
                    completion_event: {
                      key: GIT_SYNC_LOCK_RETRY_EVENT,
                      payload_fields: ['installSlug', 'workspaceId', 'resource', 'reason', 'holders'],
                    },
                    await_tool: 'events:await',
                  }),
              // `agent_resource_locks` is an implementation table in the separate
              // papercusp_su substrate, so it is not a describable `dev:pg_query`
              // relation. Point the continuation at the registered workspace-global
              // diagnostic instead, including an executable selector for the blocked
              // resource. The direct tool reference prevents the caller from having
              // to reverse-engineer the backing table or database before retrying.
              progress_ref: {
                surface: 'locks:list',
                tool: 'locks:list',
                args: outcome.blockedOn ? { resource: outcome.blockedOn } : {},
                workspace_id: workspaceId,
                install_slug: slug,
                resource: outcome.blockedOn ?? null,
                fields: ['resources[].holders', 'resources[].held', 'holders', 'draining'],
              },
            }
          : undefined;
    const blockedByInFlightGitSync =
      outcome?.status === 'skipped' &&
      outcome.reason === 'held_exclusive' &&
      outcome.holders?.some((holder) => isSystemGitSyncHolder(holder, slug));
    const note = fired.degraded
      ? fired.reason === 'error'
        ? `git-sync fire failed before it returned an outcome: ${fired.errorMessage ?? 'unknown error'}.`
        : `git-sync fired but did not finish within ${GIT_SYNC_RUN_BUDGET_MS}ms — status is in_progress; ` +
          'the action may still commit/push or self-skip. Re-check the routine outcome before re-firing.'
      : outcome?.status === 'synced'
        ? superprojectPushConfirmed
          ? 'git-sync completed a local commit and confirmed the superproject push in outcome.pushed.'
          : `git-sync completed local commit ${outcome.headSha}, but origin/staging egress is NOT confirmed ` +
            '(outcome.pushed does not include superproject). This is not a delivery signal; await ' +
            `git-sync:egressed:${outcome.headSha} or verify the remote ref before claiming publication.`
        : outcome?.status === 'nothing'
          ? 'git-sync completed with status nothing; no repo changes were committed.'
          : outcome?.status === 'skipped'
            ? outcome.reason === 'held_exclusive'
              ? // This is emitted at the actual release boundary, not at refusal
                // time, so it cannot wake into the same held_exclusive state.
                `git-sync skipped: ${blockedByInFlightGitSync ? 'an in-flight git-sync auto-commit' : 'a peer'} holds ` +
                `${outcome.blockedOn ?? 'the git-sync resource'} ` +
                '(held_exclusive). Wait for the exact resource release event in ' +
                'continuation.completion_event, then retry git-sync:run. Your changes are ' +
                'not lost; continuation.progress_ref retains live holder state.'
              : `git-sync completed with status skipped (${outcome.reason}); await ${GIT_SYNC_LOCK_RETRY_EVENT} ` +
                'for the next lock-retry signal and inspect continuation.progress_ref for live holder state.'
            : outcome?.status === 'conflict' || outcome?.status === 'error'
              ? `git-sync completed with status ${outcome.status}; inspect outcome errors/conflicts.`
              : 'git-sync returned no structured outcome; treat the result as unknown and inspect the routine log.';
    // The metadata seam is overwrite-not-merge. Keep the caller's reason on this same
    // stamp as any future git-sync outcome metadata so a later stamp cannot erase it.
    ctx.metadata?.({
      ...(args.reason != null ? { fireReason: clampText(args.reason, LIMITS.SHORT_TITLE) } : {}),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: !fired.degraded,
            fired: true,
            slug,
            status,
            success,
            committed,
            head_before: before,
            head_after: after,
            ...(remoteEgress ? { remote_egress: remoteEgress } : {}),
            ...(outcome ? { outcome } : {}),
            ...(fired.degraded ? { degraded: true } : {}),
            ...(fired.errorMessage ? { error: fired.errorMessage } : {}),
            ...(continuation ? { continuation } : {}),
            note,
          }),
        },
      ],
    };
  },
});
