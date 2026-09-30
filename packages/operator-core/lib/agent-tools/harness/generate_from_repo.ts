/**
 * harness:generate-from-repo — kind #1 harness creation (P-009 / D-023).
 *
 * Given an EXISTING git repo, deterministically infer an `extends: coding-factory`
 * blueprint override (cheap; no LLM — the gym optimizes the seed later, D-022),
 * validate it through the frozen engine, then COMPOSE `harness:create` to
 * scaffold the harness. A successfully created coding checkout is also wired
 * into the existing `system:git-sync` spine: local origin/default-branch
 * coordinates are persisted on the registry entry, then the standard seeder
 * creates its active, deterministically staggered routine. The detection
 * (`detectFromRepo`) covers the four D-023
 * signals — test command (VERIFIED by running it once), the tool set, the
 * monorepo/frontend structural flags, and a harvest of AGENTS.md/CLAUDE.md/
 * TESTING.md into the override.
 *
 * Skips (returns `{ ok:true, skipped:true }`) when the repo already carries a
 * `.papercusp/blueprint.yaml`. `dryRun` returns the generated + validated
 * override WITHOUT creating the harness — preview the seed before committing.
 *
 * harness-blueprint-orchestration-2026-06-03 P-009 / B3. Composes — does not
 * rewrite — `harness:create` (per su-adb1b); consumes the frozen
 * `resolveAndValidate` + `@papercusp/orchestrator/blueprint`.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAndValidate } from '../blueprint/_resolve';
import {
  detectFromRepo,
  detectFromRepoAsync,
  detectionToOverride,
  DEFAULT_TEST_TIMEOUT_MS,
  type DetectionResult,
} from '../../blueprint/detect-from-repo';
import { recordFromRepoStep } from '../../harness/from-repo-progress';
import {
  claimPendingMcpResult,
  finalizePendingMcpResult,
  PENDING_MCP_RESULT_STATE,
  type StoredMcpResult,
} from '../../endpoint-route/routes/transport/_mcp-result-replay';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import createTool from './create';

const TOOL_NAME = 'harness:generate-from-repo';

const text = (payload: Record<string, unknown>): StoredMcpResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
    .describe('Unique harness slug for the new harness'),
  path: z.string().min(1).describe('Absolute path to the existing git repo'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Detect + build + validate the override, but do NOT create the harness'),
  runTests: z.boolean().default(true).describe('Run the detected test command once to verify it (D-023)'),
  testTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_TEST_TIMEOUT_MS)
    .describe('Budget for the single test-verify run'),
});

type GenerateFromRepoArgs = z.infer<typeof argsSchema>;
type RepoDetector = (
  repoPath: string,
  opts: { runTests: boolean; testTimeoutMs: number },
) => DetectionResult | Promise<DetectionResult>;

const detachedRuns = new Map<string, Promise<void>>();

function replayOwnerKey(ctx: UnifiedToolContext): string | null {
  const owner = ctx.uiClientId ?? ctx.spawnId;
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}

function progress(
  ctx: UnifiedToolContext,
  progressId: string | undefined,
  step: 'detect' | 'create' | 'seed',
  status: 'running' | 'done' | 'error' | 'skipped',
  percent: number | undefined,
  detail: string,
): void {
  if (!progressId) return;
  try {
    recordFromRepoStep(progressId, step, status, { percent, detail });
  } catch {
    // Progress is UX-only; the generation result remains authoritative.
  }
  try {
    ctx.emit?.('from_repo_progress', {
      progressId,
      step,
      status,
      ...(percent == null ? {} : { percent }),
      ...(detail ? { detail } : {}),
    });
  } catch {
    // A disconnected MCP stream must not interrupt the detached operation.
  }
  try {
    ctx.progress?.(percent, detail);
  } catch {
    // Same best-effort posture for standard progress notifications.
  }
}

function acceptedResult(args: GenerateFromRepoArgs, progressId: string): StoredMcpResult {
  const path = resolvePath(args.path);
  return text({
    ok: true,
    accepted: true,
    status: 'in_progress',
    progressId,
    slug: args.slug,
    path,
    message:
      'Harness generation was accepted and is running asynchronously. ' +
      'Use the progressId for progress updates; retry with the same idempotency key to replay the terminal result.',
  });
}

function pendingResult(
  args: GenerateFromRepoArgs,
  progressId: string,
  ownerKey: string,
  idempotencyKey: string,
): StoredMcpResult {
  return {
    ...acceptedResult(args, progressId),
    _meta: {
      state: PENDING_MCP_RESULT_STATE,
      tool: TOOL_NAME,
      progressId,
      ownerKey,
      idempotencyKey,
      request: {
        slug: args.slug,
        path: resolvePath(args.path),
        runTests: args.runTests,
        testTimeoutMs: args.testTimeoutMs,
      },
    },
  };
}

function withoutPendingMarker(result: StoredMcpResult): StoredMcpResult {
  if (result._meta?.state !== PENDING_MCP_RESULT_STATE) return result;
  const { _meta: _pending, ...publicResult } = result;
  return publicResult;
}

function requestFromPendingMarker(
  result: StoredMcpResult,
  fallback: GenerateFromRepoArgs,
): GenerateFromRepoArgs {
  const marker = result._meta;
  const request = marker?.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return fallback;
  const candidate = request as Record<string, unknown>;
  return {
    ...fallback,
    ...(typeof candidate.slug === 'string' ? { slug: candidate.slug } : {}),
    ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    ...(typeof candidate.runTests === 'boolean' ? { runTests: candidate.runTests } : {}),
    ...(typeof candidate.testTimeoutMs === 'number' && Number.isFinite(candidate.testTimeoutMs)
      ? { testTimeoutMs: candidate.testTimeoutMs }
      : {}),
    dryRun: false,
  };
}

function progressIdFromPendingMarker(result: StoredMcpResult, fallback: string): string {
  const value = result._meta?.progressId;
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Detection summary for the tool response — omits the bulky harvested doc bodies (those live in the blueprint). */
function summarizeDetection(det: DetectionResult) {
  return {
    repoPath: det.repoPath,
    isGitRepo: det.isGitRepo,
    testCommand: det.testCommand
      ? {
          command: det.testCommand.command,
          source: det.testCommand.source,
          verified: det.testCommand.verified,
          exitCode: det.testCommand.exitCode,
          timedOut: det.testCommand.timedOut ?? false,
          durationMs: det.testCommand.durationMs,
        }
      : null,
    toolchains: det.toolchains,
    packageManager: det.packageManager,
    flags: det.flags,
    harvestedDocs: det.harvestedDocs.map((d) => ({ file: d.file, bytes: d.bytes, truncated: d.truncated })),
    notes: det.notes,
  };
}

async function runGeneration(
  args: GenerateFromRepoArgs,
  ctx: UnifiedToolContext,
  options: { detector?: RepoDetector; progressId?: string } = {},
): Promise<Record<string, unknown>> {
  const path = resolvePath(args.path);
  if (!existsSync(path)) return { ok: false, error: 'path does not exist' };

  progress(ctx, options.progressId, 'detect', 'running', 5, 'Detecting repository structure and verifying its test command');
  const detector = options.detector ?? detectFromRepo;
  const det = await detector(path, { runTests: args.runTests, testTimeoutMs: args.testTimeoutMs });
  progress(ctx, options.progressId, 'detect', 'done', 30, 'Repository detection completed');

  if (det.skip) {
    return { ok: true, skipped: true, reason: det.skip.reason, detection: summarizeDetection(det) };
  }

  // 2. Map detection → an `extends: coding-factory` override, and validate it through the engine.
  const override = detectionToOverride(args.slug, det);
  const validation = resolveAndValidate(override);
  if (validation.parseError || !validation.ok) {
    return {
      ok: false,
      error: 'generated blueprint invalid',
      parseError: validation.parseError,
      errors: validation.validation?.errors,
      warnings: validation.validation?.warnings,
      override,
      detection: summarizeDetection(det),
    };
  }

  const validationSummary = {
    ok: validation.ok,
    errors: validation.validation!.errors,
    warnings: validation.validation!.warnings,
  };

  // 3a. dryRun — return the seed for inspection, don't create the harness.
  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      slug: args.slug,
      override,
      yaml: stringifyYaml(override, { lineWidth: 100 }),
      validation: validationSummary,
      detection: summarizeDetection(det),
    };
  }

  progress(ctx, options.progressId, 'create', 'running', 45, 'Creating the managed harness');
  // 3b. Compose harness:create with the inline override (its handler writes the
  //     git-canonical .papercusp/blueprint.yaml + registers + provisions PG).
  const createRes = (await (options.progressId && ctx.dispatchTool
    ? ctx.dispatchTool('harness:create', { slug: args.slug, path, blueprint: override })
    : createTool.handler({ slug: args.slug, path, blueprint: override } as never, ctx))) as {
    content: { text: string }[];
  };
  const created = JSON.parse(createRes.content[0].text);
  if (!created.ok) {
    progress(ctx, options.progressId, 'create', 'error', 45, 'Harness creation failed');
    return {
      ok: false,
      error: 'harness:create failed',
      create: created,
      override,
      detection: summarizeDetection(det),
    };
  }
  progress(ctx, options.progressId, 'create', 'done', 70, 'Harness creation committed');

  // 4. A generated coding harness is a managed checkout even when it is not
  //    a Pot member. `harness:create` intentionally seeds git-sync only for
  //    explicit Pot members, so this existing-repo composition must close the
  //    standalone gap itself. Resolve the already-configured local origin,
  //    persist those coords atomically, then compose the SAME seeding spine
  //    used by Pot members. This keeps push/permission policy, active defaults,
  //    cron jitter, and idempotency in one place.
  progress(ctx, options.progressId, 'seed', 'running', 80, 'Persisting upstream coordinates and seeding git-sync');
  let upstream: Awaited<ReturnType<typeof import('../../harness/upstream-repo-context').resolveUpstreamRepoSource>> =
    null;
  let gitSync: import('../../harness/git-sync/git-sync-routine').SeedGitSyncRoutineOutcome | undefined;
  try {
    const workspaceId = resolveConcreteWorkspaceId(undefined, ctx?.workspaceId, ctx?.principal?.workspaceId);
    const [{ resolveUpstreamRepoSource }, { mutateHarnessRegistry }, { seedGitSyncRoutineForMember }] =
      await Promise.all([
        import('../../harness/upstream-repo-context'),
        import('../../harness-registry'),
        import('../../harness/git-sync/git-sync-routine'),
      ]);
    upstream = await resolveUpstreamRepoSource({ path });

    const entry = {
      slug: args.slug,
      path,
      ...(upstream?.github_remote ? { github_remote: upstream.github_remote } : {}),
      ...(upstream?.github_repository_id !== undefined
        ? { github_repository_id: upstream.github_repository_id }
        : {}),
      ...(upstream?.default_branch ? { github_default_branch: upstream.default_branch } : {}),
    };

    if (upstream) {
      await mutateHarnessRegistry(
        (reg) => ({
          ...reg,
          projects: reg.projects.map((project) => (project.slug === args.slug ? { ...project, ...entry } : project)),
        }),
        workspaceId,
      );
    }

    gitSync = await seedGitSyncRoutineForMember({
      workspaceId,
      installSlug: args.slug,
      entry,
      joinerSide: false,
    });
    progress(ctx, options.progressId, 'seed', 'done', 100, 'Upstream coordinates persisted and git-sync seeded');
  } catch (e) {
    // Same best-effort posture as harness:create's trigger/member seeds: a
    // control-plane hiccup must not erase a successfully created harness, but
    // the shaped result makes the missing durability explicit to the caller.
    gitSync = {
      seeded: false,
      reason: 'error',
      message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    };
    progress(ctx, options.progressId, 'seed', 'error', 80, 'Harness created, but upstream/git-sync setup failed');
  }

  return {
    ok: true,
    slug: created.slug,
    path: created.path,
    blueprintFile: created.blueprintFile,
    requiresRepo: created.requiresRepo,
    provisioning: created.provisioning,
    upstream: upstream
      ? {
          remote: upstream.github_remote,
          defaultBranch: upstream.default_branch,
          source: upstream.source,
        }
      : null,
    gitSync,
    validation: validationSummary,
    detection: summarizeDetection(det),
  };
}

function scheduleDetachedGeneration(
  args: GenerateFromRepoArgs,
  ctx: UnifiedToolContext,
  ownerKey: string,
  idempotencyKey: string,
  progressId: string,
): void {
  const key = `${ownerKey}\u0000${idempotencyKey}`;
  if (detachedRuns.has(key)) return;

  const run = new Promise<void>((resolve) => {
    setImmediate(() => {
      void (async () => {
        let result: StoredMcpResult;
        try {
          result = text(
            await runGeneration(args, ctx, {
              detector: detectFromRepoAsync,
              progressId,
            }),
          );
        } catch (error) {
          progress(ctx, progressId, 'detect', 'error', 5, 'Harness generation failed before completion');
          result = text({
            ok: false,
            error: 'harness:generate-from-repo background operation failed',
            message: error instanceof Error ? error.message : String(error),
          });
        }

        try {
          await finalizePendingMcpResult({
            ownerKey,
            idempotencyKey,
            toolName: TOOL_NAME,
            workspaceId: ctx.workspaceId!,
            result,
          });
        } catch (error) {
          // The operation has completed; a replay-store outage is observable in
          // logs but must not turn a successful harness creation into a failure.
          console.warn(
            `[harness:generate-from-repo] terminal replay finalize failed for key=${idempotencyKey}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      })().finally(() => {
        detachedRuns.delete(key);
        resolve();
      });
    });
  });
  detachedRuns.set(key, run);
}

export default defineTool({
  name: TOOL_NAME,
  description:
    'Generate a coding harness from an EXISTING git repo (kind #1 creation). Deterministically detects the test command (and VERIFIES it by running it once), the toolchain, monorepo/frontend flags, and harvests AGENTS.md/CLAUDE.md/TESTING.md into an `extends: coding-factory` blueprint override; validates it; then creates the harness via harness:create, persists its discovered origin/default branch, and seeds its active recurring git-sync routine. Skips if the repo already has .papercusp/blueprint.yaml. Use `dryRun` to preview the generated override without creating. Returns {ok, slug?, skipped?, override?, detection, validation, upstream?, gitSync?}.',
  guidance: {
    when: 'Onboarding an existing code repository as a managed coding harness — you want the blueprint inferred from the repo (test command, stack, monorepo/frontend) rather than authored by hand.',
    notWhen:
      'The repo already has a .papercusp/blueprint.yaml (it is skipped — edit the file instead). Creating a repo-less / research harness, or one whose blueprint you author explicitly — harness:create with blueprintId/blueprint. Generate-from-plan (kinds #2/#3) is out of scope.',
    chaining:
      'harness:generate-from-repo { slug, path, dryRun:true } → (inspect override) → harness:generate-from-repo { slug, path } (creates). Or blueprint:validate the returned override.',
    seeAlso: [
      'harness:create (create from a folder/blueprint instead of a repo)',
      'blueprint:validate (validate the returned override)',
      'harness:overview (inspect the generated harness)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: argsSchema,
  async handler(args, ctx) {
    const path = resolvePath(args.path);
    if (!existsSync(path)) return text({ ok: false, error: 'path does not exist' });

    // A normal direct/in-process call retains its historical synchronous
    // behavior. MCP calls with a caller-owned idempotency key take the
    // accepted/in-progress path so repository tests and harness creation
    // cannot occupy the request deadline.
    const ownerKey = replayOwnerKey(ctx);
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!args.dryRun && ctx.transport === 'mcp' && ownerKey && idempotencyKey && ctx.workspaceId && ctx.dispatchTool) {
      const progressId = randomUUID();
      const pending = pendingResult(args, progressId, ownerKey, idempotencyKey);
      progress(ctx, progressId, 'detect', 'running', 5, 'Queued asynchronous repository detection');

      let claim: Awaited<ReturnType<typeof claimPendingMcpResult>>;
      try {
        claim = await claimPendingMcpResult({
          ownerKey,
          idempotencyKey,
          toolName: TOOL_NAME,
          workspaceId: ctx.workspaceId,
          result: pending,
        });
      } catch (error) {
        return text({
          ok: false,
          error: 'could not reserve idempotency key for asynchronous generation',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }

      if (!claim.claimed) {
        // A terminal result can only normally reach here when the transport's
        // replay lookup raced or failed. Returning it is still safe: never start
        // a second harness creation for a key that already has an outcome.
        if (!claim.pending || !claim.result) return claim.result ?? acceptedResult(args, progressId);

        // A pending marker can outlive the process that scheduled its work.
        // Reconstruct the original request and re-arm the local single-flight
        // runner on a retry; in the same process the map makes this a no-op.
        const resumedProgressId = progressIdFromPendingMarker(claim.result, progressId);
        scheduleDetachedGeneration(
          requestFromPendingMarker(claim.result, args),
          ctx,
          ownerKey,
          idempotencyKey,
          resumedProgressId,
        );
        return withoutPendingMarker(claim.result);
      }

      scheduleDetachedGeneration(args, ctx, ownerKey, idempotencyKey, progressId);
      return acceptedResult(args, progressId);
    }

    return text(await runGeneration(args, ctx));
  },
});
