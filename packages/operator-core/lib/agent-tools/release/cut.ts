/**
 * release:cut — the agent-facing LOCAL desktop-release cutter + hand-off orchestrator
 * (desktop-update-center-and-release-tooling P-5 Unit B).
 *
 * The orchestrator layer over the build-agents' primitives (their D-001): it composes
 * `papercusp-desktop/bin/release-local.sh` (the build/sign/provenance cut) and points at
 * the RELEASE-RUNBOOK verification scripts (bin/verify-provenance.sh / bin/vm-preflight.sh /
 * bin/install-and-relaunch-verify.sh) as the ship-gate sequence. It gives the cut what
 * `release:deploy` gives the deploy: a preflight go/no-go, a DETACHED launch (a 35–60 min
 * build can't be an awaited tool call), status polling, and a structured hand-off.
 *
 * ⛔ Artifact cuts are LOCAL-only (papercusp-desktop/RELEASE-RUNBOOK.md; owner directive 2026-07-08: "we are
 * no longer using GitHub for our releases — build the installer locally and I'll upload
 * it"). Every path here runs the cut with PAPERCUSP_PUBLISH_GITHUB=0 (release-local.sh
 * skips its superseded tag-push + GitHub-Release steps) and `handoff` returns the local
 * artifact paths + sha256 for the OWNER to upload. `prepare-tag` is the one explicit,
 * separately confirmed remote-ref write: it creates a missing exact tag with a
 * force-with-lease expecting absence. It never creates a GitHub Release or uploads bytes.
 *
 * Ops (discriminated on `op`):
 *   - preflight  — READ-ONLY go/no-go: signing key, cutter + verify scripts present, no cut
 *                  already in flight, VM reminders for requested mac/windows legs.
 *   - prepare-tag — explicitly create the exact release tag required by the dogfood pin.
 *                  Dry-run unless confirm:true; refuses to overwrite an existing mismatch.
 *   - run        — fire the LOCAL cut DETACHED (survives compaction/relaunch). Dry-run
 *                  unless confirm:true. Heavy + owner-walled → operator-config-write role.
 *                  Audited. Refuses if a cut is already in flight.
 *   - status     — READ-ONLY: is a cut in flight? / its exit code + log tail once done.
 *                  Pass `platform` to poll ONE leg's own unit (see run-leg) instead of the
 *                  legacy whole-cut unit.
 *   - handoff    — collect the version's signed artifacts + sha256 + manifests/provenance
 *                  for the owner; flags any unsigned artifact (a ship blocker). Leg-
 *                  agnostic — collects across every platform's output under one shared
 *                  target tree regardless of whether it came from op:run or N op:run-legs.
 *   - run-leg    — WI-4233 fleet-split support: fire ONE platform leg (linux/mac/windows/
 *                  arm64) on its OWN detached unit/log/done, so N agents can each drive +
 *                  poll their own leg through this audited orchestrator instead of raw
 *                  bash. Same dry-run/confirm/role-gate/audit contract as op:run.
 *   - abort-leg  — stop one platform leg's unit (best-effort). Same role gate as run.
 *   - gate-status — READ (or, for the first caller, ESTABLISH) the shared BUILD_SHA gate
 *                  for a (version, channel): the single honest sha every leg/agent on this
 *                  box should be cutting against, so independent legs can't silently drift
 *                  onto different shas if the tree moves (git-sync) between their runs.
 */

import { z } from 'zod';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readIdentity } from '../locks/identity';
import { BashProvenanceRefusal, resolveBashTaskProvenance } from '../capability/bash-task-provenance';
import { loopLaunchRefusal } from '../../verification-attempts/loop-gate';
import type { ResolveIdentityCtx } from '../coordination/identity';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { runGovernedOperation } from '../../resource-governor/execution';
import { loadHarnessRegistry, type HarnessRegistry } from '../../harness-registry';
import {
  executeCutReclaim,
  gatherCutReclaimPlan,
  renderReclaimPlan,
  type ReleaseRecord,
} from '../../release-cut-reclaim';
import {
  launchDetachedCut,
  readCutStatus,
  collectHandoff,
  preflightCut,
  desktopReleaseTag,
  buildCutArgv,
  desktopRoot,
  canonicalDesktopRoot,
  integrationRoot,
  isValidVersion,
  isValidSourceSha,
  validateMigrationBootSmokeOverride,
  CHANNELS,
  CUT_UNIT,
  PLATFORMS,
  cutUnitFor,
  cutUnitForTask,
  cutLogFor,
  cutDoneFor,
  legsForPlatform,
  abortLeg,
  readOrCreateGate,
  type Channel,
  type CutLegs,
  type CutRuntimeEnv,
  type MigrationBootSmokeOverride,
  type Platform,
} from '../../release-cut-launch';
import {
  beginCutOperation,
  readSourceGitlinks,
  type BeginCutOperationResult,
} from '../../release-cut-operation';
import { markSpawned } from '../../task-manager/store';

const cutRootArg = z
  .string()
  .min(1)
  .describe(
    'Optional registered Git worktree selector. Write operations require a clean worktree; read-only handoff/status can inspect a dirty root. Accepts a project slug, linked worktree path, or its papercusp-desktop path.',
  );

const cutOwnerNameArg = z
  .string()
  .min(1)
  .max(500)
  .describe(
    'Human owner name supplied at run time for the finished-byte identity audit. Never persist it in the release tree.',
  );
const cutOwnerEmailArg = z
  .string()
  .min(1)
  .max(1000)
  .optional()
  .describe('Optional comma-separated owner email literals for the same runtime-only identity audit.');
const cutReuseSeedArg = z
  .boolean()
  .optional()
  .describe('Retry-only: reuse the already-completed seed in this isolated cut root (PAPERCUSP_SKIP_SEED_CUT=1).');
const cutSeedFindingProofArg = z.string().trim().min(1).optional().describe(
  'Private reviewed exact-content seed finding proof (D-140). The credential gate still scans every seed file and validates source, epoch keys, config, authentication and plaintext evidence; changed or missing evidence refuses the cut.',
);
const cutSeedUuidIdempotencyArg = z.object({
  plansPath: z.string().startsWith('/'),
  plansSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceStoreDir: z.string().startsWith('/'),
  censusPath: z.string().startsWith('/'),
  censusSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().optional().describe(
  'D166 private source-bound UUID row-drop plan/hash, exact census config/hash, and frozen ORIGINAL source store. Census context persists for output-only doc projections after the one-use row plan is cleared. Requires a fresh cut; forbids reuse/seedless, refresh and sparse mode. Does not waive independent source containment, artifact coverage or GO.',
);
const cutFullHistoryArg = z
  .boolean()
  .optional()
  .describe(
    'Re-cut Git with full reachable history by passing PAPERCUSP_SEED_DEPTH as a present-empty value. Omit/false keeps the release default depth 1. Requires a fresh seed cut.',
  );
const cutSeedlessArg = z
  .boolean()
  .optional()
  .describe(
    'Explicit seedless build: require src-tauri/seed to contain only the canonical placeholder, then skip the seed cut without enabling retry residue. Mutually exclusive with reuseSeed.',
  );

export const RELEASE_SEEDLESS_PLACEHOLDER_NAME = 'SEEDLESS_RELEASE.txt';
export const RELEASE_SEEDLESS_PLACEHOLDER_CONTENT =
  'Papercusp release seed intentionally omitted; first boot uses the cold-join path.\n';

interface CutWorktree {
  path: string;
  prunable: boolean;
}

export interface CutRootSelection {
  desktopRoot: string;
  selector?: string;
  worktreeRoot?: string;
}

export type CutRootResolution =
  | ({ ok: true } & CutRootSelection)
  | { ok: false; reason: string };

export interface CutRootResolutionDeps {
  loadRegistry?: (workspaceId: string) => Promise<HarnessRegistry>;
  listWorktrees?: (repoPath: string) => CutWorktree[] | Promise<CutWorktree[]>;
  status?: (worktreePath: string) => string | Promise<string>;
  canonicalPath?: (candidate: string) => string;
  desktopStatus?: (desktopRoot: string) => string | Promise<string>;
  desktopHeadMatches?: (worktreeRoot: string) => boolean | Promise<boolean>;
  headFile?: (desktopRoot: string, relativePath: string) => string | Promise<string>;
  readFile?: (absolutePath: string) => string;
  exists?: (absolutePath: string) => boolean;
  readDir?: (absolutePath: string) => string[];
  isRegularFile?: (absolutePath: string) => boolean;
  makeDir?: (absolutePath: string) => void;
  writeFile?: (absolutePath: string, content: string) => void;
}

export interface CutRootResolutionOptions {
  /** A completed seed may be reused only when the remaining tracked edits are the
   * exact idempotent version bump written by release-local.sh for this version. */
  reuseSeedVersion?: string;
  /** A new seedless cut keeps normal clean-root enforcement and accepts only the
   * canonical placeholder under src-tauri/seed. It never admits retry residue. */
  seedless?: boolean;
  /**
   * WI-10003598: a read-only op (handoff) inspects a finished cut, and a
   * finished cut always leaves its root dirty (the version bump, the moved gitlink and
   * tracked sidecar build output). They skip the clean-worktree gate that protects the
   * write ops; the root must still be a registered cut worktree.
   */
  readOnly?: boolean;
}

export const RELEASE_RESUME_VERSION_PATHS = [
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.lock',
] as const;

const RELEASE_RESUME_STAGED_SIDECAR_ROOTS = ['serve.mjs', 'spa', 'db-sql', 'prompts', 'harness'] as const;

function releaseResumeSidecarSourcePath(relativePath: string): string | null {
  const prefix = 'src-tauri/env-sidecars/staging/';
  if (!relativePath.startsWith(prefix)) return null;
  const stagedRelativePath = relativePath.slice(prefix.length);
  const segments = stagedRelativePath.split('/');
  if (
    !stagedRelativePath ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !RELEASE_RESUME_STAGED_SIDECAR_ROOTS.some((root) => root === segments[0])
  ) {
    return null;
  }
  return 'src-tauri/sidecar/' + stagedRelativePath;
}

function expectedVersionFile(relativePath: string, head: string, version: string): string {
  if (relativePath === 'package.json' || relativePath === 'src-tauri/tauri.conf.json') {
    // Preserve the source bytes when validating release-owned residue. JSON.parse/
    // stringify would canonicalize escaped literals (for example `\\u2713` in a
    // shell command string) and reject an otherwise exact version-only bump.
    const matches = head.match(/^(\s*"version"\s*:\s*)"[^"]*"(\s*,?\s*)$/gm) ?? [];
    if (matches.length !== 1) throw new Error(`expected exactly one top-level version field, found ${matches.length}`);
    return head.replace(/^(\s*"version"\s*:\s*)"[^"]*"(\s*,?\s*)$/m, `$1"${version}"$2`);
  }
  if (relativePath === 'src-tauri/Cargo.toml') {
    return head.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  }
  if (relativePath === 'src-tauri/Cargo.lock') {
    const sections = head.split('[[package]]\n');
    const matchingIndexes: number[] = [];
    sections.forEach((section, index) => {
      if (section.split('\n').some((line) => line === 'name = "papercusp-desktop"')) {
        matchingIndexes.push(index);
      }
    });
    if (matchingIndexes.length !== 1) {
      throw new Error('expected exactly one papercusp-desktop package entry, found ' + matchingIndexes.length);
    }
    const targetIndex = matchingIndexes[0]!;
    let versionLines = 0;
    sections[targetIndex] = sections[targetIndex]!
      .split('\n')
      .map((line) => {
        if (!line.startsWith('version = "') || !line.endsWith('"')) return line;
        versionLines += 1;
        return 'version = "' + version + '"';
      })
      .join('\n');
    if (versionLines !== 1) {
      throw new Error('expected exactly one version field for papercusp-desktop, found ' + versionLines);
    }
    return sections.join('[[package]]\n');
  }
  throw new Error('unsupported release resume path: ' + relativePath);
}

/** Validate release-owned residue left by a completed-seed retry. Version files
 * must be exact requested-version rewrites; staged environment sidecars must be
 * byte-identical to their committed source under src-tauri/sidecar. */
export function validateReleaseResumeResidue(input: {
  superprojectStatus: string;
  desktopStatus: string;
  desktopHeadMatches?: boolean;
  version: string;
  files: Readonly<Record<string, { head?: string; worktree: string; expectedSource?: string }>>;
}): { ok: true } | { ok: false; reason: string } {
  const desktopLines = input.desktopStatus.split('\n').filter(Boolean);
  const expectedSuper = desktopLines.length > 0 ? ' m papercusp-desktop' : '';
  // Porcelain v1 folds a submodule's lowercase `m` into `M`, which can also
  // mean its checked-out commit moved. Accept that encoding only with separate
  // proof that the desktop gitlink still matches the frozen superproject.
  const porcelainResidue =
    desktopLines.length > 0 &&
    input.superprojectStatus.trimEnd() === ' M papercusp-desktop' &&
    input.desktopHeadMatches === true;
  if (input.superprojectStatus.trimEnd() !== expectedSuper && !porcelainResidue) {
    return { ok: false, reason: `superproject status is not the single expected dirty submodule (${JSON.stringify(input.superprojectStatus)})` };
  }

  const allowed = new Set<string>(RELEASE_RESUME_VERSION_PATHS);
  for (const line of desktopLines) {
    if (!line.startsWith(' M ')) {
      return { ok: false, reason: 'desktop status contains a non-worktree modification: ' + line };
    }
    const relativePath = line.slice(3);
    const sidecarSourcePath = releaseResumeSidecarSourcePath(relativePath);
    const isVersionPath = allowed.has(relativePath);
    if (!isVersionPath && sidecarSourcePath === null) {
      return { ok: false, reason: 'desktop status contains non-cutter path: ' + relativePath };
    }
    const file = input.files[relativePath];
    if (!file) return { ok: false, reason: 'missing residue snapshot for ' + relativePath };
    if (isVersionPath) {
      if (file.head === undefined) {
        return { ok: false, reason: 'missing HEAD snapshot for ' + relativePath };
      }
      let expected: string;
      try {
        expected = expectedVersionFile(relativePath, file.head, input.version);
      } catch (err) {
        return {
          ok: false,
          reason: 'could not validate ' + relativePath + ': ' + (err instanceof Error ? err.message : String(err)),
        };
      }
      if (file.worktree !== expected) {
        return { ok: false, reason: relativePath + ' contains changes beyond the requested ' + input.version + ' version bump' };
      }
    } else {
      if (file.expectedSource === undefined) {
        return { ok: false, reason: 'missing trusted sidecar source snapshot for ' + relativePath };
      }
      if (file.worktree !== file.expectedSource) {
        return { ok: false, reason: relativePath + ' differs from its committed source sidecar ' + sidecarSourcePath };
      }
    }
  }
  return { ok: true };
}

/** The runtime env every cut / leg launch runs release-local.sh with.
 *
 * Centralised deliberately: there are four launch sites (run + run-leg, each with a
 * dry-run preview and a real launch), and a fifth that forgot `canonicalDesktopRoot`
 * would silently reintroduce the lost-version-bump class (WI-10001570). That failure
 * is invisible at cut time and only surfaces a release later, when every source build
 * still reports the previous version — so it must not be re-derived per call site. */
function cutRuntimeEnv(
  args: {
    ownerName: string;
    ownerEmail?: string;
    fullHistory?: boolean;
    deferTag?: boolean;
    reuseSeed?: boolean;
    seedFindingProof?: string;
    seedUuidIdempotency?: CutRuntimeEnv['seedUuidIdempotency'];
    seedless?: boolean;
    migrationBootSmokeOverride?: MigrationBootSmokeOverride;
  },
  operation?: BeginCutOperationResult | null,
  harnessSlug?: string | null,
): CutRuntimeEnv {
  return {
    ownerName: args.ownerName,
    ownerEmail: args.ownerEmail,
    ...(harnessSlug ? { harnessSlug } : {}),
    ...(args.fullHistory ? { fullHistory: true } : {}),
    ...(args.deferTag ? { deferTag: true } : {}),
    reuseSeed: args.reuseSeed,
    ...(args.seedFindingProof ? { seedFindingProof: args.seedFindingProof } : {}),
    ...(args.seedUuidIdempotency ? { seedUuidIdempotency: args.seedUuidIdempotency } : {}),
    ...(args.seedless ? { seedless: true } : {}),
    ...(args.migrationBootSmokeOverride ? { migrationBootSmokeOverride: args.migrationBootSmokeOverride } : {}),
    // P-001: present ⇒ release-local.sh runs its phase journal and the cut becomes
    // resumable and discoverable; absent ⇒ unchanged unmanaged behavior. buildCutEnv
    // refuses a half-set pair, so these two always travel together.
    releaseTaskId: operation?.taskId,
    releaseOperationId: operation?.operationId,
    enqueuedAtMs: operation ? Date.now() : undefined,
    // release-local.sh derives its own ROOT from where the script lives, so a cut
    // launched against an isolated worktree must be TOLD where canonical is — its
    // .git is an independent clone and the push leg is deleted under LOCAL-only,
    // so otherwise the bump has no route back and dies with the worktree.
    // The tree git-sync commits, never the serving checkout (WI-10003596).
    canonicalDesktopRoot: canonicalDesktopRoot(),
    // Restores parity with a manual `bin/release-local.sh` run, where this lever has
    // always worked because a shell passes its whole environment down. The detached cut
    // is launched with an explicit env allowlist, so without this the operator's own
    // setting is silently dropped (EI-23917342543376581). Read here rather than inside
    // buildCutEnv so that builder stays pure and unit-testable.
    headSnapshotTimeoutMs: parsePositiveIntEnv(process.env.PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS),
  };
}

/**
 * Open the managed-release operation for a cut about to fire (P-001), so the cut runs
 * with a phase journal and is discoverable after an operator restart.
 *
 * Fails closed. A cut without a registered task service cannot be safely tracked or
 * stopped through the task manager, so callers must refuse before launching it.
 */
async function openCutOperation(input: {
  version: string;
  channel: Channel;
  platform: Platform | null;
  sourceSha: string;
  desktopRoot: string;
  workItemId?: string | null;
  harnessSlug?: string | null;
}): Promise<{ operation: BeginCutOperationResult | null; reason?: string }> {
  try {
    const operation = await beginCutOperation({
      identity: {
        version: input.version,
        channel: input.channel,
        platform: input.platform,
        sourceSha: input.sourceSha,
        gitlinks: readSourceGitlinks(integrationRoot(), input.sourceSha),
      },
      cwd: input.desktopRoot,
      workItemId: input.workItemId ?? null,
      harnessSlug: input.harnessSlug ?? null,
    });
    return { operation };
  } catch (error) {
    return {
      operation: null,
      reason: `managed release journal unavailable — this cut runs UNMANAGED and cannot be resumed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * The work-item a cut serves (expensive-verification-loops P-001: a cut is an expensive
 * verification attempt). Same unambiguous-held-claim rule as capability:bash, and
 * fail-soft: an unattributable cut still fires, just unlinked.
 */
async function cutWorkItemId(
  ctx: unknown,
  explicitWorkItemId?: string,
): Promise<{ workItemId: string | null; refusal?: string }> {
  try {
    const provenance = await resolveBashTaskProvenance(ctx as ResolveIdentityCtx, null, undefined, {
      explicitWorkItemId,
      requireExplicitForMultipleHeldItems: true,
    });
    return { workItemId: provenance.workItemId };
  } catch (error) {
    return explicitWorkItemId || error instanceof BashProvenanceRefusal
      ? { workItemId: null, refusal: error instanceof Error ? error.message : String(error) }
      : { workItemId: null };
  }
}

/** A malformed override is IGNORED, never fatal: cut-seed-cli refuses a bad value, and
 *  killing a release cut over a stray env var would be worse than using the derived
 *  deadline. Returns undefined for anything that is not a usable positive integer. */
function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseWorktreeList(stdout: string): CutWorktree[] {
  return stdout
    .split(/\n\n+/)
    .map((block) => {
      let worktreePath = '';
      let prunable = false;
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length).trim();
        if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
      }
      return { path: worktreePath, prunable };
    })
    .filter((worktree) => worktree.path.length > 0);
}

/**
 * WI-10005193: run a child to completion WITHOUT blocking the event loop.
 *
 * release:cut is an MCP tool, so every child it runs executes on the OPERATOR MAIN THREAD.
 * The previous execFileSync calls held that thread for the child's whole lifetime. Measured on
 * :3170 at 2026-10-02T02:28:01Z: an event-loop-sentinel stall profile attributed 54% of samples to
 * execFileSync < defaultListWorktrees / defaultWorktreeStatus < resolveCutRoot. resolveCutRoot runs
 * `git worktree list` once PER REGISTERED PROJECT (~50 checkouts). prepare-tag held the thread for
 * up to its 120s timeout, which is past the sentinel's 20s wedge threshold: a SIGKILL of the host.
 *
 * Callback-style execFile (not promisify) keeps a single mockable seam. stdin is closed at spawn, as
 * execFileSync did, so a child that reads stdin sees EOF instead of waiting forever.
 */
export function runFileAsync(file: string, args: readonly string[], options: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { maxBuffer: 1024 * 1024, ...options, encoding: 'utf8' as const },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
    child?.stdin?.end();
  });
}

async function defaultListWorktrees(repoPath: string): Promise<CutWorktree[]> {
  const stdout = await runFileAsync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return parseWorktreeList(stdout);
}

export async function defaultWorktreeStatus(worktreePath: string): Promise<string> {
  return runFileAsync('git', ['-C', worktreePath, 'status', '--porcelain'], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
    // This is a proof read, not an opportunity to refresh the index. On a
    // newly materialized 38-submodule release tree Git's optional index write
    // exceeded the otherwise adequate 10s guard; the identical read-only
    // status completed in 0.41s and preserved the full cleanliness result.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function defaultCanonicalPath(candidate: string): string {
  return path.resolve(candidate);
}

/** Auto-managed checkouts can be replaced underneath a long cut by git-sync,
 * green-checkpoint, or release deploy. Artifact cuts must use a dedicated exact-SHA
 * worktree prepared through setup-release-checkout.sh instead. */
export function isAutoManagedCutWorktree(worktreePath: string): boolean {
  return new Set([
    'papercup',
    'papercusp',
    'papercup-release',
    'papercusp-release',
    'papercup-checkpoint',
    'papercusp-checkpoint',
    'papercup-staging',
    'papercusp-staging',
  ]).has(path.basename(path.resolve(worktreePath)));
}

function validateCutRootSeedMode(
  desktop: string,
  deps: CutRootResolutionDeps,
  options: CutRootResolutionOptions,
): string | null {
  if (options.reuseSeedVersion && options.seedless) {
    return 'root_seed_mode_conflict — reuseSeed and seedless are mutually exclusive';
  }
  if (options.reuseSeedVersion) {
    const seedManifest = path.join(desktop, 'src-tauri', 'seed', 'manifest.json');
    const exists = deps.exists ?? existsSync;
    if (!exists(seedManifest)) {
      return `root_resume_seed_missing — reuseSeed requires the completed seed manifest at '${seedManifest}'`;
    }
  }
  if (options.seedless) {
    const seedRoot = path.join(desktop, 'src-tauri', 'seed');
    const placeholder = path.join(seedRoot, RELEASE_SEEDLESS_PLACEHOLDER_NAME);
    const exists = deps.exists ?? existsSync;
    if (!exists(seedRoot)) return null;
    const readDir = deps.readDir ?? ((absolutePath: string) => readdirSync(absolutePath));
    const isRegularFile = deps.isRegularFile ?? ((absolutePath: string) => lstatSync(absolutePath).isFile());
    const readFile = deps.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, 'utf8'));
    try {
      const entries = [...readDir(seedRoot)].sort();
      if (entries.length === 0) return null;
      if (entries.length !== 1 || entries[0] !== RELEASE_SEEDLESS_PLACEHOLDER_NAME) {
        return (
          `root_seedless_shape_invalid — '${seedRoot}' must contain exactly ` +
          `${RELEASE_SEEDLESS_PLACEHOLDER_NAME}; found ${entries.length === 0 ? '<empty>' : entries.join(', ')}`
        );
      }
      if (!isRegularFile(placeholder)) {
        return `root_seedless_shape_invalid — '${placeholder}' must be a regular file (not a directory or symlink)`;
      }
      if (readFile(placeholder) !== RELEASE_SEEDLESS_PLACEHOLDER_CONTENT) {
        return `root_seedless_shape_invalid — '${placeholder}' does not contain the canonical seedless marker`;
      }
    } catch (err) {
      return (
        `root_seedless_shape_unreadable — could not verify placeholder-only seed root '${seedRoot}': ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }
  return null;
}

export function prepareSeedlessCutRoot(
  desktop: string,
  deps: CutRootResolutionDeps = {},
): string | null {
  const seedRoot = path.join(desktop, 'src-tauri', 'seed');
  const placeholder = path.join(seedRoot, RELEASE_SEEDLESS_PLACEHOLDER_NAME);
  const exists = deps.exists ?? existsSync;
  const readDir = deps.readDir ?? ((absolutePath: string) => readdirSync(absolutePath));
  const makeDir = deps.makeDir ?? ((absolutePath: string) => mkdirSync(absolutePath, { recursive: true }));
  const writeFile = deps.writeFile ?? ((absolutePath: string, content: string) => {
    writeFileSync(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
  });
  try {
    if (!exists(seedRoot)) makeDir(seedRoot);
    const entries = [...readDir(seedRoot)].sort();
    if (entries.length === 0) writeFile(placeholder, RELEASE_SEEDLESS_PLACEHOLDER_CONTENT);
  } catch (err) {
    return (
      `root_seedless_prepare_failed — could not materialize '${placeholder}': ` +
      (err instanceof Error ? err.message : String(err))
    );
  }
  return validateCutRootSeedMode(desktop, deps, { seedless: true });
}

type CutSeedModeResolution =
  | { ok: true; mode: 'fresh' | 'reuse' | 'seedless'; rootOptions: CutRootResolutionOptions }
  | { ok: false; reason: string };

function resolveCutSeedMode(args: {
  version: string;
  fullHistory?: boolean;
  reuseSeed?: boolean;
  seedless?: boolean;
  seedUuidIdempotency?: CutRuntimeEnv['seedUuidIdempotency'];
}): CutSeedModeResolution {
  if (args.seedUuidIdempotency && (args.reuseSeed || args.seedless)) {
    return { ok: false, reason: 'seed_uuid_mode_conflict — UUID plans require a fresh frozen-source cut' };
  }
  if (args.reuseSeed && args.seedless) {
    return { ok: false, reason: 'seed_mode_conflict — reuseSeed and seedless are mutually exclusive' };
  }
  if (args.fullHistory && (args.reuseSeed || args.seedless)) {
    return {
      ok: false,
      reason:
        'seed_history_mode_conflict — fullHistory requires a fresh Git seed cut and cannot accompany reuseSeed or seedless',
    };
  }
  if (args.reuseSeed) {
    return { ok: true, mode: 'reuse', rootOptions: { reuseSeedVersion: args.version } };
  }
  if (args.seedless) {
    return { ok: true, mode: 'seedless', rootOptions: { seedless: true } };
  }
  return { ok: true, mode: 'fresh', rootOptions: {} };
}

/**
 * Resolve the optional cut root without allowing an arbitrary filesystem path.
 * Explicit selectors must identify a non-prunable linked worktree belonging to a
 * project in the active harness registry, and that worktree must be clean at the
 * moment of the read. The cutter itself receives the worktree's desktop subdir.
 */
export async function resolveCutRoot(
  selector: string | undefined,
  deps: CutRootResolutionDeps = {},
  options: CutRootResolutionOptions = {},
): Promise<CutRootResolution> {
  if (options.reuseSeedVersion && options.seedless) {
    return { ok: false, reason: 'root_seed_mode_conflict — reuseSeed and seedless are mutually exclusive' };
  }
  if (selector === undefined) {
    const implicitDesktopRoot = desktopRoot();
    const implicitWorktreeRoot = path.dirname(implicitDesktopRoot);
    if (isAutoManagedCutWorktree(implicitWorktreeRoot)) {
      return {
        ok: false,
        reason:
          `root_not_isolated — default cut root '${implicitWorktreeRoot}' is auto-managed and can move during a build; ` +
          'prepare a dedicated exact-SHA worktree with setup-release-checkout.sh and pass it via root',
      };
    }
    if (options.seedless) {
      const seedModeError = validateCutRootSeedMode(implicitDesktopRoot, deps, { seedless: true });
      if (seedModeError) return { ok: false, reason: seedModeError };
    }
    return { ok: true, desktopRoot: implicitDesktopRoot };
  }
  const requested = selector.trim();
  if (!requested) return { ok: false, reason: 'bad_root — selector must not be blank' };

  const loadRegistry = deps.loadRegistry ?? ((workspaceId: string) => loadHarnessRegistry(workspaceId));
  const listWorktrees = deps.listWorktrees ?? defaultListWorktrees;
  const status = deps.status ?? defaultWorktreeStatus;
  const canonical = deps.canonicalPath ?? defaultCanonicalPath;
  let registry: HarnessRegistry;
  try {
    registry = await loadRegistry(activeWorkspaceId());
  } catch (err) {
    return {
      ok: false,
      reason: `root_unavailable — could not read the active harness registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const candidates = new Map<string, CutWorktree>();
  const projects = registry.projects.filter((project) => project.path.trim().length > 0);
  for (const project of projects) {
    try {
      for (const worktree of await listWorktrees(project.path)) {
        if (worktree.prunable) continue;
        candidates.set(canonical(worktree.path), worktree);
      }
    } catch {
      // A repo-less/non-Git registered project is not a valid cut-root carrier.
    }
  }

  const requestedPath = canonical(requested);
  const requestedDesktopParent = path.basename(requestedPath) === 'papercusp-desktop'
    ? canonical(path.dirname(requestedPath))
    : null;
  let selected: CutWorktree | undefined;
  if (requestedDesktopParent) selected = candidates.get(requestedDesktopParent);
  if (!selected) selected = candidates.get(requestedPath);
  if (!selected) {
    const project = projects.find((candidate) => candidate.slug === requested);
    if (project) selected = candidates.get(canonical(project.path));
  }
  if (!selected) {
    return {
      ok: false,
      reason:
        `root_not_registered — '${requested}' is not a linked worktree of any project registered in the active workspace; ` +
        'select a registered project slug or a path from `git worktree list --porcelain`.',
    };
  }

  let dirty: string;
  try {
    dirty = await status(selected.path);
  } catch (err) {
    return {
      ok: false,
      reason: `root_unreadable — could not inspect git status for '${selected.path}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (dirty.trim().length > 0 && !options.readOnly) {
    if (!options.reuseSeedVersion) {
      return {
        ok: false,
        reason: `root_not_clean — selected worktree '${selected.path}' has uncommitted changes; release cuts require a clean worktree`,
      };
    }
    const desktopRoot = path.join(selected.path, 'papercusp-desktop');
    const desktopStatus = await (deps.desktopStatus ?? ((root: string) => runFileAsync(
      'git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'],
    )))(desktopRoot);
    const files: Record<string, { head?: string; worktree: string; expectedSource?: string }> = {};
    const headFile = deps.headFile ?? ((root: string, relativePath: string) => runFileAsync(
      'git', ['-C', root, 'show', `HEAD:${relativePath}`],
    ));
    const readFile = deps.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, 'utf8'));
    for (const line of desktopStatus.split('\n').filter(Boolean)) {
      const relativePath = line.slice(3);
      const sidecarSourcePath = releaseResumeSidecarSourcePath(relativePath);
      const isVersionPath = (RELEASE_RESUME_VERSION_PATHS as readonly string[]).includes(relativePath);
      if (isVersionPath || sidecarSourcePath !== null) {
        try {
          files[relativePath] = {
            ...(isVersionPath ? { head: await headFile(desktopRoot, relativePath) } : {}),
            ...(sidecarSourcePath ? { expectedSource: await headFile(desktopRoot, sidecarSourcePath) } : {}),
            worktree: readFile(path.join(desktopRoot, relativePath)),
          };
        } catch {
          // The validator below fails closed when an expected snapshot cannot be read.
        }
      }
    }
    const residue = validateReleaseResumeResidue({
      superprojectStatus: dirty,
      desktopStatus,
      desktopHeadMatches:
        dirty.trimEnd() === ' M papercusp-desktop'
          ? await (
              deps.desktopHeadMatches ??
              ((root: string) =>
                runFileAsync('git', [
                  '-C',
                  root,
                  'diff',
                  '--quiet',
                  '--ignore-submodules=dirty',
                  'HEAD',
                  '--',
                  'papercusp-desktop',
                ]).then(
                  () => true,
                  () => false,
                ))
            )(selected.path)
          : undefined,
      version: options.reuseSeedVersion,
      files,
    });
    if (!residue.ok) {
      return {
        ok: false,
        reason: `root_resume_residue_invalid — selected worktree '${selected.path}' is not a safe release-owned retry: ${residue.reason}`,
      };
    }
  }
  if (isAutoManagedCutWorktree(selected.path)) {
    return {
      ok: false,
      reason:
        `root_not_isolated — selected worktree '${selected.path}' is auto-managed and can be replaced during a cut; ` +
        'prepare a dedicated exact-SHA worktree with setup-release-checkout.sh',
    };
  }

  const selectedDesktopRoot = path.join(selected.path, 'papercusp-desktop');
  const seedModeError = validateCutRootSeedMode(selectedDesktopRoot, deps, options);
  if (seedModeError) return { ok: false, reason: seedModeError };

  return {
    ok: true,
    selector: requested,
    worktreeRoot: selected.path,
    desktopRoot: selectedDesktopRoot,
  };
}

const json = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

/** Append a forensic audit row. An exceptional migration-smoke bypass requires a
 * successful write BEFORE launch; ordinary cut telemetry preserves best effort. */
/** harness_shared.releases — the registry record-release-cli writes; published_at marks
 *  a published release. Read for op:reclaim's "latest published" protection. */
async function loadReleaseRecords(): Promise<ReleaseRecord[]> {
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT version, git_sha, cut_at, published_at FROM harness_shared.releases WHERE workspace_id = $1`,
    [activeWorkspaceId()],
  )) as unknown as Array<{ version: string; git_sha: string | null; cut_at: Date | string; published_at: Date | string | null }>;
  return rows.map((r) => ({
    version: r.version,
    gitSha: r.git_sha,
    cutAtMs: new Date(r.cut_at).getTime(),
    publishedAtMs: r.published_at === null ? null : new Date(r.published_at).getTime(),
  }));
}

async function recordCutAudit(op: string, actor: string, details: Record<string, unknown>, required = false): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const id = `relcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, 'release:cut', op, JSON.stringify(details), activeWorkspaceId()],
    );
    return id;
  } catch (err) {
    if (required) throw new Error(`release_cut_audit_required — ${(err as Error)?.message ?? String(err)}`);
    console.warn('[release:cut] audit write failed:', (err as Error)?.message);
    return null;
  }
}

const migrationBootSmokeOverrideArg = z.object({
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/).describe('Exact superproject SHA of the independent successful migration replay; must equal cut sourceSha.'),
  proofRef: z.string().min(1).describe('Durable reference to the full successful exact-source replay result.'),
  reason: z.string().min(1).describe('Why this cut must bypass the frozen source test after that independent proof.'),
});

const legsFrom = (a: { mac?: boolean; windows?: boolean; arm64?: boolean }): CutLegs => ({
  mac: a.mac,
  windows: a.windows,
  arm64: a.arm64,
});

const MAC_LEG_ARGUMENT_DESCRIPTION =
  'Include the macOS leg (cross-compiled on Linux via bin/build-mac-cross.sh; no VM or SSH).';
const WINDOWS_LEG_ARGUMENT_DESCRIPTION =
  'Include the Windows leg (cross-compiled on Linux via bin/build-windows-cross.sh; no VM or SSH).';

function prepareTagPreview(desktop: string, version: string, channel: Channel, sourceSha: string): string {
  const script = path.join(desktop, 'bin', 'release-local.sh');
  return (
    `PAPERCUSP_RELEASE_PREPARE_TAG_SHA='${sourceSha}' ` +
    `PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM='1' ` +
    `'${script}' '${version}' '${channel}'`
  );
}

export default defineTool({
  name: 'release:cut',
  profile: 'engineer',
  description:
    'Cut a LOCAL Papercusp desktop release for owner upload; never publish a GitHub Release. Run/run-leg need the exact 40-char superproject sourceSha and refuse drift before writes. For new versions, prepare-tag creates only the missing remote tag (dry-run unless confirm:true; never overwrites a mismatch). preflight checks go/no-go; operator-gated run launches the full cut detached; run-leg launches one platform leg on its own unit. Both are dry-run unless confirm:true. Non-Linux legs require completed same-version Linux artifacts in the selected Cargo target slot; missing artifacts fail before gates. abort-leg stops a leg; status polls the latest host-wide cut by default or a selected registered root when root is supplied; gate-status reads/establishes the shared version/channel BUILD_SHA; handoff collects signed artifacts and hashes; reclaim lists/removes stale cut worktrees (dry-run unless confirm:true with targets).',
  guidance: {
    when: 'Cutting a desktop release. New version: preflight → prepare-tag{sourceSha,confirm:true} → run{sourceSha,confirm:true} → status → verify → handoff. Fleet-split: prepare the tag once, build and verify Linux first, then each non-Linux agent gate-status to agree on one buildSha before run-leg{platform,sourceSha,confirm:true}; poll each leg and hand off after all finish. Single-platform cuts use run with the requested platform enabled.',
    notWhen:
      'Not the web operator (:3070 — release:deploy) or the green-checkpoint verdict (release:checkpoint-run). Never publish to GitHub.',
    seeAlso: [
      'papercusp-desktop/bin/verify-provenance.sh, papercusp-desktop/bin/vm-preflight.sh, and papercusp-desktop/bin/install-and-relaunch-verify.sh (the RELEASE-RUNBOOK ship-gates this cut composes)',
      'release:deploy (deploy the WEB operator to :3070 — a different target)',
      'release:checkpoint-run (the green-checkpoint verdict producer)',
    ],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // EI-18803497769946984: every op here shells out (bin/release-local.sh, systemd
  // polls, sha256 collection) and none reads ctx.tx. Holding the dispatcher's
  // ambient workspace transaction across a child process that can outlast
  // idle_in_transaction_session_timeout (60s) gets the backend killed, and the
  // caller sees a bare "write CONNECTION_CLOSED 127.0.0.1:6432" naming neither
  // the tool nor the cause. A cut is minutes long, so this is not a near miss.
  skipWorkspaceTx: true,
  // Broad allowlist (preflight/status/handoff are read-only reaches); the WRITE op (run)
  // self-gates on the operator-config-write role inside the handler — cutting a real build
  // is heavy + owner-walled, mirroring release:deploy{op:force}.
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 10 } },
  args: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('preflight'),
      deferTag: z.boolean().optional().describe('Approved build-only run: defer the tag check until a containment receipt matches the built sourceSha; no candidate/GO/publication.'),
      mac: z.boolean().optional().describe(MAC_LEG_ARGUMENT_DESCRIPTION),
      windows: z.boolean().optional().describe(WINDOWS_LEG_ARGUMENT_DESCRIPTION),
      arm64: z.boolean().optional().describe('Include the linux-arm64 cross-compile leg.'),
      root: cutRootArg.optional(),
      // The same release context callers carry through every operation. With
      // version + sourceSha (channel defaults to alpha), preflight also checks the
      // exact remote release tag the cut requires (EI-24611322499942803).
      version: z
        .string()
        .min(1)
        .optional()
        .describe('Release version. With sourceSha, preflight also checks the exact remote release tag.'),
      channel: z
        .enum(['stable', 'beta', 'alpha'])
        .optional()
        .describe('Release channel for the tag check (default alpha).'),
      sourceSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional()
        .describe(
          'Exact source commit. With version, preflight blocks when the remote release tag is missing or points elsewhere.',
        ),
    }),
    z.object({
      op: z.literal('prepare-tag'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease).'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .describe('Exact 40-char superproject commit the new release tag must name.'),
      root: cutRootArg.optional(),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN. true ⇒ create the missing exact remote tag under an absence lease.'),
    }),
    z.object({
      op: z.literal('run'),
      deferTag: z.boolean().optional().describe('Approved build-only run: create no tags or canonical version writeback. Bind the exact tag only after a matching containment receipt; no candidate/GO/publication.'),
      work_item_id: z.string().trim().min(1).max(120).optional()
        .describe('Held work-item for this cut and its slow-attempt gate. Required when you hold multiple items; overrides a stale session goal stamp.'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .describe('Exact 40-char superproject commit authorized for this cut.'),
      mac: z.boolean().optional().describe(MAC_LEG_ARGUMENT_DESCRIPTION),
      windows: z.boolean().optional().describe(WINDOWS_LEG_ARGUMENT_DESCRIPTION),
      arm64: z.boolean().optional().describe('Include the linux-arm64 cross-compile leg.'),
      root: cutRootArg.optional(),
      ownerName: cutOwnerNameArg,
      ownerEmail: cutOwnerEmailArg,
      fullHistory: cutFullHistoryArg,
      reuseSeed: cutReuseSeedArg,
      seedFindingProof: cutSeedFindingProofArg,
      seedUuidIdempotency: cutSeedUuidIdempotencyArg,
      seedless: cutSeedlessArg,
      migrationBootSmokeOverride: migrationBootSmokeOverrideArg
        .optional()
        .describe(
          'Exceptional exact-source bypass only after an independent full replay passes. Requires a durable proofRef and is audited before launch.',
        ),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN (preview the exact command). true ⇒ fire the detached LOCAL cut.'),
    }),
    z.object({
      op: z.literal('status'),
      root: cutRootArg.optional(),
      platform: z
        .enum(PLATFORMS as [Platform, ...Platform[]])
        .optional()
        .describe('Poll ONE leg (WI-4233) instead of the legacy whole-cut unit.'),
      // Keep the status poll compatible with release-cut callers that carry version/
      // channel context through every operation. `root` selects root-scoped status.
      version: z
        .string()
        .min(1)
        .optional()
        .describe('Optional release version carried as caller context; status is host-wide.'),
      channel: z
        .enum(['stable', 'beta', 'alpha'])
        .optional()
        .describe('Optional release channel carried as caller context; status is host-wide.'),
      sourceSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional()
        .describe('Optional exact source commit carried as caller context; status is host-wide.'),
    }),
    z.object({
      op: z.literal('handoff'),
      version: z.string().min(1).describe('The version whose cut artifacts to collect for the owner.'),
      root: cutRootArg.optional(),
    }),
    z.object({
      op: z.literal('run-leg'),
      deferTag: z.boolean().optional().describe('Approved build-only leg: create no tags or canonical version writeback. Bind the exact tag only after a matching containment receipt; no candidate/GO/publication.'),
      work_item_id: z.string().trim().min(1).max(120).optional()
        .describe('Held work-item for this cut and its slow-attempt gate. Required when you hold multiple items; overrides a stale session goal stamp.'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).describe('Which platform leg to fire on its own unit.'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .describe('Exact 40-char superproject commit authorized for this leg.'),
      root: cutRootArg.optional(),
      ownerName: cutOwnerNameArg,
      ownerEmail: cutOwnerEmailArg,
      fullHistory: cutFullHistoryArg,
      reuseSeed: cutReuseSeedArg,
      seedFindingProof: cutSeedFindingProofArg,
      seedUuidIdempotency: cutSeedUuidIdempotencyArg,
      seedless: cutSeedlessArg,
      migrationBootSmokeOverride: migrationBootSmokeOverrideArg
        .optional()
        .describe(
          'Exceptional exact-source bypass only after an independent full replay passes. Requires a durable proofRef and is audited before launch.',
        ),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN (preview the exact command). true ⇒ fire the detached LOCAL leg.'),
    }),
    z.object({
      op: z.literal('abort-leg'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).describe('Which platform leg to stop.'),
    }),
    z.object({
      op: z.literal('gate-status'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease).'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      root: cutRootArg.optional(),
    }),
    z.object({
      op: z.literal('reclaim'),
      targets: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe('confirm:true only: registered worktree paths from the dry-run list to remove.'),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN (list verdicts). true ⇒ remove the named targets.'),
      minIdleHours: z
        .number()
        .min(0)
        .max(24 * 60)
        .optional()
        .describe('HEAD must not have moved within this window (default 24).'),
    }),
  ]),
  async handler(args, ctx) {
    // ── reclaim: list (dry-run) or remove stale cut worktrees (EI-23968726111761920) ──
    if (args.op === 'reclaim') {
      if (args.confirm && !isOperatorConfigWriteRole(ctx.role)) {
        return json({
          ok: false,
          op: 'reclaim',
          refused: true,
          reason: `role_forbidden — release:cut{op:reclaim,confirm:true} deletes worktrees and requires an operator-config write role (you are role:${ctx.role ?? 'unknown'}).`,
        });
      }
      if (args.confirm && !args.targets?.length) {
        return json({
          ok: false,
          op: 'reclaim',
          refused: true,
          reason:
            'targets_required — confirm:true removes only paths named from a dry-run list; run without confirm first.',
        });
      }
      const plan = await gatherCutReclaimPlan({
        repoPath: integrationRoot(),
        isAutoManaged: isAutoManagedCutWorktree,
        releaseVersionPaths: RELEASE_RESUME_VERSION_PATHS,
        loadReleases: loadReleaseRecords,
        ...(args.minIdleHours !== undefined ? { minIdleHours: args.minIdleHours } : {}),
      });
      if (!args.confirm) {
        return json({
          ok: true,
          op: 'reclaim',
          dryRun: true,
          ...renderReclaimPlan(plan),
          note: 'DRY RUN — nothing removed. reclaimable = lease-identified cut, unprotected; namedOnly = no cut record, removed only if named. confirm:true + targets removes (diffs archived first).',
        });
      }
      const { ownerLabel } = readIdentity(ctx);
      const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
      await recordCutAudit('reclaim', actor, { phase: 'intent', targets: args.targets }, true);
      const result = await executeCutReclaim(plan, args.targets ?? []);
      await recordCutAudit('reclaim', actor, { phase: 'result', targets: args.targets, result });
      return json({ op: 'reclaim', dryRun: false, ...result });
    }
    // ── preflight: read-only go/no-go ──
    if (args.op === 'preflight') {
      const selected = await resolveCutRoot(args.root);
      if (!selected.ok) return json({ ok: false, op: 'preflight', refused: true, reason: selected.reason });
      const release =
        args.version && args.sourceSha
          ? { version: args.version, channel: (args.channel ?? 'alpha') as Channel, sourceSha: args.sourceSha }
          : undefined;
      const result = preflightCut(legsFrom(args), {
        root: selected.desktopRoot, release, ...(args.deferTag ? { deferTag: true } : {}),
      });
      return json({
        ok: true,
        op: 'preflight',
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        ...result,
        deferTag: args.deferTag === true,
        note: result.go
          ? args.deferTag
            ? 'Ready for build-only cut. Tags and canonical version writeback are deferred; matching containment receipt and exact tag binding required before candidate/GO/publication.'
            : 'Ready to cut. release:cut{op:run,version,channel,confirm:true} fires it detached. LOCAL-only — hand the owner the artifacts (op:handoff), never publish to GitHub.'
          : `Not ready — resolve the blocker(s) first: ${result.blockers.join('; ')}`,
      });
    }

    // ── prepare-tag: the one explicit remote-ref write ──
    // A LOCAL artifact cut still never publishes to GitHub. This separate op
    // satisfies the dogfood clone pin for a brand-new version without hiding a
    // remote mutation inside the build, and its empty force-with-lease refuses
    // to overwrite a ref created concurrently or at a different source.
    if (args.op === 'prepare-tag') {
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'prepare-tag',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix.`,
        });
      }
      if (!isValidSourceSha(args.sourceSha)) {
        return json({
          ok: false,
          op: 'prepare-tag',
          refused: true,
          reason: `bad_source_sha '${args.sourceSha ?? '<missing>'}' — expected an exact 40-character lowercase superproject commit.`,
        });
      }
      if (args.confirm && !isOperatorConfigWriteRole(ctx.role)) {
        return json({
          ok: false,
          op: 'prepare-tag',
          refused: true,
          reason: `role_forbidden — release:cut{op:prepare-tag,confirm:true} requires an operator-config write role (the isOperatorConfigWriteRole set — operator-equivalent write authority, NOT any su/worker role) (you are role:${ctx.role ?? 'unknown'}).`,
        });
      }

      const channel = args.channel as Channel;
      // Ref-only operation: a completed speculative build leaves version/sidecar
      // residue in its isolated root. Do not apply the clean-build precondition
      // here; the helper still validates the exact commit and create-only lease.
      const selected = await resolveCutRoot(args.root, undefined, { readOnly: true });
      const tag = desktopReleaseTag(args.version, channel);
      if (!selected.ok) {
        // An implicit auto-managed checkout is unsafe for the write, but a
        // dry-run can still show the exact ref and command shape needed to
        // prepare an isolated root. Explicit invalid roots remain refusals.
        if (!args.confirm && args.root === undefined && selected.reason.startsWith('root_not_isolated')) {
          return json({
            ok: true,
            op: 'prepare-tag',
            dry_run: true,
            ready: false,
            version: args.version,
            channel,
            sourceSha: args.sourceSha,
            tag,
            remoteRefWrite: true,
            githubRelease: false,
            artifactUpload: false,
            wouldRun: prepareTagPreview(
              '<registered-isolated-worktree>/papercusp-desktop',
              args.version,
              channel,
              args.sourceSha,
            ),
            blocker: selected.reason,
            note: 'Prepare and register a dedicated exact-SHA worktree, then pass its root to preview or confirm the tag write.',
          });
        }
        return json({ ok: false, op: 'prepare-tag', refused: true, reason: selected.reason });
      }
      const wouldRun = prepareTagPreview(selected.desktopRoot, args.version, channel, args.sourceSha);
      if (!args.confirm) {
        return json({
          ok: true,
          op: 'prepare-tag',
          dry_run: true,
          version: args.version,
          channel,
          sourceSha: args.sourceSha,
          tag,
          root: selected.desktopRoot,
          ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
          remoteRefWrite: true,
          githubRelease: false,
          artifactUpload: false,
          wouldRun,
          note:
            `Pass confirm:true to create missing origin refs/tags/${tag} at the exact source under a create-only lease. ` +
            'If origin is GitHub the TAG becomes visible there; this never creates a GitHub Release or uploads artifacts.',
        });
      }

      let commandOutput = '';
      try {
        commandOutput = await runGovernedOperation(
          {
            workspaceId: activeWorkspaceId(),
            namespace: 'release-prepare-tag',
            owner: 'release:cut:prepare-tag',
            admissionClass: 'process',
            demand: { cpuWeight: 1, memoryBytes: 512 * 1024 * 1024, fileDescriptors: 3 },
            payloadRef: `release:cut:prepare-tag:${args.version}:${channel}`,
            metadata: { version: args.version, channel },
          },
          async () =>
            (
              await runFileAsync(path.join(selected.desktopRoot, 'bin', 'release-local.sh'), [args.version, channel], {
                cwd: selected.desktopRoot,
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
                env: {
                  ...process.env,
                  PAPERCUSP_RELEASE_PREPARE_TAG_SHA: args.sourceSha,
                  PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM: '1',
                },
              })
            ).trim(),
        );
      } catch (err) {
        const reason = `prepare_tag_failed — ${err instanceof Error ? err.message : String(err)}`;
        const { ownerLabel } = readIdentity(ctx);
        await recordCutAudit('prepare-tag', `${ownerLabel} (role:${ctx.role ?? 'unknown'})`, {
          version: args.version,
          channel,
          sourceSha: args.sourceSha,
          tag,
          root: selected.desktopRoot,
          created: false,
          reason,
        });
        return json({
          ok: false,
          op: 'prepare-tag',
          refused: true,
          version: args.version,
          channel,
          sourceSha: args.sourceSha,
          tag,
          reason,
        });
      }

      const { ownerLabel } = readIdentity(ctx);
      await recordCutAudit('prepare-tag', `${ownerLabel} (role:${ctx.role ?? 'unknown'})`, {
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        tag,
        root: selected.desktopRoot,
        created: true,
      });
      return json({
        ok: true,
        op: 'prepare-tag',
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        tag,
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        remoteRefWrite: true,
        githubRelease: false,
        artifactUpload: false,
        output: commandOutput,
        note: `Exact release tag ${tag} is prepared. The artifact cut remains LOCAL-only and must still receive sourceSha=${args.sourceSha}.`,
      });
    }

    // ── status: read-only poll (latest host-wide cut, or one registered root) ──
    if (args.op === 'status') {
      const selected = args.root === undefined
        ? undefined
        : await resolveCutRoot(args.root, undefined, { readOnly: true });
      if (selected && !selected.ok) {
        return json({ ok: false, op: 'status', refused: true, reason: selected.reason });
      }
      const status = readCutStatus({
        platform: args.platform,
        ...(selected ? { root: selected.desktopRoot } : {}),
      });
      const unit = status.operation?.taskId ? cutUnitForTask(status.operation.taskId) : cutUnitFor(args.platform);
      const legNote = args.platform ? `leg '${args.platform}' (unit ${unit})` : `unit ${unit}`;
      const scopeNote = selected ? `for root ${selected.desktopRoot}` : 'on this host';
      const note =
        status.state === 'running'
          ? `A cut is in flight (${legNote}). Poll again; the log tail is above. Do NOT start a second cut${args.platform ? ' for this leg' : ''}.`
          : status.state === 'done'
            ? `The last ${legNote} finished OK. ${args.platform ? 'Once every leg is done, run papercusp-desktop/bin/verify-provenance.sh <leg-out-dir> --health-sha <sha> --require-signed, then release:cut{op:handoff,version}.' : 'Run papercusp-desktop/bin/verify-provenance.sh <leg-out-dir> --health-sha <sha> --require-signed for each leg, then release:cut{op:handoff,version} to collect the artifacts for the owner.'}`
            : status.state === 'failed'
              ? `The last ${legNote} FAILED (exit ${status.exitCode}). Inspect the log tail above / ${status.logPath}; fix and re-run.`
              : status.state === 'interrupted'
                ? `The last ${legNote} was INTERRUPTED before its DONE sentinel was written. ${
                    status.operation?.operationId
                      ? `It ran under managed operation ${status.operation.operationId}, so its committed phase receipts survive — a re-run resumes from the last one rather than rebuilding.`
                      : 'It ran UNMANAGED (no operation id on the started marker), so there are no phase receipts to resume from — a re-run rebuilds from the start.'
                  } Inspect the log tail above / ${status.logPath}; fix or intentionally restart it.`
              : `No cut in flight and no recent result for ${legNote} ${scopeNote}.`;
      return json({
        ok: true,
        op: 'status',
        ...(selected ? {
          root: selected.desktopRoot,
          ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        } : {}),
        ...(args.platform ? { platform: args.platform } : {}),
        ...status,
        unit,
        note,
      });
    }

    // ── handoff: collect the LOCAL deliverable ──
    if (args.op === 'handoff') {
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'handoff',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix.`,
        });
      }
      const selected = await resolveCutRoot(args.root, {}, { readOnly: true });
      if (!selected.ok) return json({ ok: false, op: 'handoff', refused: true, reason: selected.reason });
      const h = collectHandoff(args.version, { root: selected.desktopRoot });
      if (!h.found) {
        return json({
          ok: false,
          op: 'handoff',
          found: false,
          version: args.version,
          root: selected.desktopRoot,
          targetRoot: h.targetRoot,
          scannedRoots: h.scannedRoots,
          reason: `no ${args.version} artifacts under ${h.scannedRoots.length > 0 ? h.scannedRoots.join(', ') : h.targetRoot} — cut it first (release:cut{op:run}) or check the version.`,
        });
      }
      // Missing sigs on NON-updater artifacts (dmg / setup.exe / .bin slices / deb) are
      // expected — only updater-feed artifacts (.app.tar.gz / .AppImage / .nsis.zip) hard-block
      // (WI-4243: the old blanket check false-alarmed "unsigned dmg — do NOT hand over").
      const sigInfo =
        h.unsignedInfoNames.length > 0
          ? ` (${h.unsignedInfoNames.length} non-updater artifact(s) have no .sig — expected, not a blocker: ${h.unsignedInfoNames.join(', ')})`
          : '';
      return json({
        ok: true,
        op: 'handoff',
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        ...h,
        shipGate:
          h.unsignedNames.length > 0
            ? `⚠ ${h.unsignedNames.length} UPDATER artifact(s) are UNSIGNED (${h.unsignedNames.join(', ')}) — the updater can't verify them. Do NOT hand these over; re-cut with the signing key present.${sigInfo}`
            : `All updater artifacts are signed.${sigInfo} Run the ship-gate before hand-off: papercusp-desktop/bin/verify-provenance.sh <leg-out-dir> --health-sha <leg sha> --require-signed per leg for a release cut (use the leg's own health sha; never substitute the DEV :3070 health sha). --require-signed enforces D-019's published signable suffixes; DiskSpanning .bin slices are intentionally excluded, while their normalized .zip remains signature-required.`,
        note: 'LOCAL-only hand-off: give the OWNER these local paths + sha256 to upload. ⚠ Windows Inno *-setup-N.bin payload slices MUST be uploaded into the same directory as their setup.exe. Never publish to GitHub.',
      });
    }

    // ── gate-status: read, or (first caller) establish, the shared BUILD_SHA gate ──
    if (args.op === 'gate-status') {
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'gate-status',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix.`,
        });
      }
      const selected = await resolveCutRoot(args.root);
      if (!selected.ok) return json({ ok: false, op: 'gate-status', refused: true, reason: selected.reason });
      const { ownerLabel } = readIdentity(ctx);
      const { gate, created } = readOrCreateGate(args.version, args.channel as Channel, ownerLabel, {
        root: selected.desktopRoot,
      });
      return json({
        ok: true,
        op: 'gate-status',
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        created,
        ...gate,
        note: created
          ? `Gate established: buildSha=${gate.buildSha}${gate.dirty ? ' (DIRTY — the -dirty guard will refuse a leg unless PAPERCUSP_ALLOW_DIRTY=1)' : ''}. Every peer's op:gate-status for ${args.version}/${args.channel} now reads back this SAME sha — pass it to your fleet so every leg cuts against it.`
          : `Existing gate (derived by ${gate.derivedBy} at ${gate.derivedAt}) — buildSha=${gate.buildSha}. If YOUR leg's own release-local.sh run reports a DIFFERENT sha, STOP: the tree moved between legs (git-sync) — do not mix artifacts from different shas into one hand-off.`,
      });
    }

    // ── abort-leg: stop one platform leg's unit (operator-gated) ──
    if (args.op === 'abort-leg') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        return json({
          ok: false,
          op: 'abort-leg',
          refused: true,
          reason: `role_forbidden — release:cut{op:abort-leg} requires an operator-config write role (the isOperatorConfigWriteRole set — operator-equivalent write authority, NOT any su/worker role) (you are role:${ctx.role ?? 'unknown'}).`,
        });
      }
      const platform = args.platform as Platform;
      const result = abortLeg(platform);
      const { ownerLabel } = readIdentity(ctx);
      await recordCutAudit('abort-leg', `${ownerLabel} (role:${ctx.role ?? 'unknown'})`, { platform, ...result });
      return json({
        ok: result.stopped,
        op: 'abort-leg',
        platform,
        ...result,
        note: result.stopped
          ? `Stop requested for the ${platform} leg (unit ${result.unit}). Its log/done files (${cutLogFor(platform)} / ${cutDoneFor(platform)}) are left for post-mortem — the next op:run-leg for this platform clears the done sentinel itself.`
          : `Stop failed (${result.reason ?? 'unknown'}) — the unit may already be inactive; check release:cut{op:status,platform:'${platform}'}.`,
      });
    }

    // ── run-leg: fire ONE platform leg detached (operator-gated write, WI-4233) ──
    if (args.op === 'run-leg') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `role_forbidden — release:cut{op:run-leg} requires an operator-config write role (the isOperatorConfigWriteRole set — operator-equivalent write authority, NOT any su/worker role) (you are role:${ctx.role ?? 'unknown'}). Cutting a real build is heavy + owner-walled. preflight/status/handoff/gate-status are open.`,
        });
      }
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix (e.g. 0.0.8, 1.2.3-rc.1).`,
        });
      }
      if (!isValidSourceSha(args.sourceSha)) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `bad_source_sha '${args.sourceSha ?? '<missing>'}' — expected the exact 40-character lowercase superproject commit authorized for this cut.`,
        });
      }
      const overrideError = validateMigrationBootSmokeOverride(args.migrationBootSmokeOverride, args.sourceSha);
      if (overrideError) return json({ ok: false, op: 'run-leg', refused: true, reason: overrideError });
      const channel = args.channel as Channel;
      const platform = args.platform as Platform;
      const legs = legsForPlatform(platform);
      const orchestratorRoot = desktopRoot();
      const seedMode = resolveCutSeedMode(args);
      if (!seedMode.ok) return json({ ok: false, op: 'run-leg', refused: true, reason: seedMode.reason });
      const selected = await resolveCutRoot(args.root, undefined, seedMode.rootOptions);
      if (!selected.ok) return json({ ok: false, op: 'run-leg', refused: true, reason: selected.reason });

      const pre = preflightCut(legs, {
        platform,
        root: selected.desktopRoot,
        release: { version: args.version, channel, sourceSha: args.sourceSha },
        ...(args.deferTag ? { deferTag: true } : {}),
      });
      const orderingNote =
        platform === 'linux'
          ? ''
          : ' A non-Linux run-leg reuses Linux and requires a completed same-version Linux leg with artifacts in the selected Cargo target slot. For a single-command cut, use op:run with the requested platform enabled so Linux and that platform build together.';
      const inFlight = pre.checks.find((c) => c.name === 'no-cut-in-flight');
      if (inFlight && !inFlight.ok) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `cut_in_flight — ${inFlight.detail}`,
        });
      }

      if (!args.confirm) {
        const argv = buildCutArgv(
          selected.desktopRoot,
          args.version,
          channel,
          legs,
          args.sourceSha,
          '<PATH>',
          cutRuntimeEnv(args, null, resolveConcreteHarnessSlug(undefined, ctx)),
          platform,
          orchestratorRoot,
        );
        return json({
          ok: true,
          op: 'run-leg',
          dry_run: true,
          platform,
          version: args.version,
          channel,
          sourceSha: args.sourceSha,
          seedMode: seedMode.mode,
          fullHistory: args.fullHistory === true,
          deferTag: args.deferTag === true,
          migrationBootSmokeOverride: args.migrationBootSmokeOverride ?? null,
          root: selected.desktopRoot,
          orchestratorRoot,
          ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
          legs,
          localOnly: true,
          unit: cutUnitFor(platform),
          preflight: { go: pre.go, blockers: pre.blockers },
          wouldRun: `systemd-run ${argv.join(' ')}`,
          note: pre.go
            ? `Pass confirm:true to fire the detached LOCAL ${platform} leg (unit ${cutUnitFor(platform)}). Then poll release:cut{op:status,platform:'${platform}'}.${orderingNote}`
            : `⚠ preflight is NOT green for this leg — resolve first: ${pre.blockers.join('; ')}. confirm:true would fire anyway.${orderingNote}`,
        });
      }

      // expensive-verification-loops P-002: a cut for a work item that keeps failing
      // slow attempts waits for an audit on the item, before any side effect below.
      const provenance = await cutWorkItemId(ctx, args.work_item_id);
      if (provenance.refusal) return json({ ok: false, op: 'run-leg', refused: true, reason: provenance.refusal });
      const cutWorkItem = provenance.workItemId;
      const loopRefusal = await loopLaunchRefusal({
        workspaceId: activeWorkspaceId(),
        workItemId: cutWorkItem,
        background: true,
        timeoutMs: 0,
      });
      if (loopRefusal) return json({ ...loopRefusal, op: 'run-leg', refused: true });
      if (seedMode.mode === 'seedless') {
        const seedlessError = prepareSeedlessCutRoot(selected.desktopRoot);
        if (seedlessError) return json({ ok: false, op: 'run-leg', refused: true, reason: seedlessError });
      }

      const { ownerLabel } = readIdentity(ctx);
      const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
      let migrationBootSmokeOverrideAuditId: string | null = null;
      if (args.migrationBootSmokeOverride) {
        try {
          migrationBootSmokeOverrideAuditId = await recordCutAudit(
            'migration-boot-smoke-override',
            actor,
            {
              version: args.version,
              channel,
              platform,
              ...args.migrationBootSmokeOverride,
            },
            true,
          );
        } catch (err) {
          return json({ ok: false, op: 'run-leg', refused: true, reason: (err as Error).message });
        }
      }
      const managed = await openCutOperation({
        version: args.version,
        channel,
        platform,
        sourceSha: args.sourceSha,
        desktopRoot: selected.desktopRoot,
        workItemId: cutWorkItem,
        harnessSlug: resolveConcreteHarnessSlug(undefined, ctx),
      });
      if (!managed.operation) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: managed.reason ?? 'task ledger unavailable — refusing an unmanaged cut',
        });
      }
      const launch = await launchDetachedCut({
        version: args.version,
        channel,
        expectedSourceSha: args.sourceSha,
        runtime: cutRuntimeEnv(args, managed.operation, resolveConcreteHarnessSlug(undefined, ctx)),
        legs,
        platform,
        root: selected.desktopRoot,
        orchestratorRoot,
      });
      if (launch.launched) {
        // buildCutArgv uses Type=notify and sends READY only after the task marker and
        // stable cut-slot flock are in place, so the reserved task service is live here.
        await markSpawned(managed.operation.taskId, { confined: true, scopeUnit: launch.unit });
      }
      await recordCutAudit('run-leg', actor, {
        platform,
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        root: selected.desktopRoot,
        orchestratorRoot,
        legs,
        seedMode: seedMode.mode,
        fullHistory: args.fullHistory === true,
        deferTag: args.deferTag === true,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        localOnly: true,
        launched: launch.launched,
        unit: launch.unit,
        // The operation id is the only durable handle on this cut; an audit entry without
        // it cannot be joined to the journal row later.
        operationId: launch.operationId,
        migrationBootSmokeOverrideAuditId,
        taskId: launch.taskId,
        ...(managed.reason ? { managedSkipReason: managed.reason } : {}),
        ...(launch.reason ? { reason: launch.reason } : {}),
      });
      return json({
        ok: launch.launched,
        op: 'run-leg',
        platform,
        launched: launch.launched,
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        legs,
        seedMode: seedMode.mode,
        fullHistory: args.fullHistory === true,
        deferTag: args.deferTag === true,
        root: selected.desktopRoot,
        orchestratorRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        localOnly: true,
        unit: launch.unit,
        logPath: launch.logPath,
        managed: launch.operationId !== null,
        operationId: launch.operationId,
        migrationBootSmokeOverrideAuditId,
        taskId: launch.taskId,
        ...(managed.reason ? { managedSkipReason: managed.reason } : {}),
        ...(launch.reason ? { reason: launch.reason } : {}),
        note: launch.launched
          ? `LOCAL ${platform} leg started (detached). Poll release:cut{op:status,platform:'${platform}'}. Once EVERY leg is done: run papercusp-desktop/bin/verify-provenance.sh <leg-out-dir> --health-sha <sha> --require-signed per leg → release:cut{op:handoff,version} (handoff already collects across every leg's artifacts under the shared target tree).`
          : `Leg NOT launched — likely already in flight (see reason). Re-check release:cut{op:status,platform:'${platform}'}.`,
      });
    }

    // ── run: fire the detached LOCAL cut (operator-gated write) ──
    // args.op === 'run'
    if (!isOperatorConfigWriteRole(ctx.role)) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `role_forbidden — release:cut{op:run} requires an operator-config write role (the isOperatorConfigWriteRole set — operator-equivalent write authority, NOT any su/worker role) (you are role:${ctx.role ?? 'unknown'}). Cutting a real build is heavy + owner-walled. preflight/status/handoff are open.`,
      });
    }
    if (!isValidVersion(args.version)) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix (e.g. 0.0.8, 1.2.3-rc.1).`,
      });
    }
    if (!isValidSourceSha(args.sourceSha)) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `bad_source_sha '${args.sourceSha ?? '<missing>'}' — expected the exact 40-character lowercase superproject commit authorized for this cut.`,
      });
    }
    const overrideError = validateMigrationBootSmokeOverride(args.migrationBootSmokeOverride, args.sourceSha);
    if (overrideError) return json({ ok: false, op: 'run', refused: true, reason: overrideError });
    const channel = args.channel as Channel;
    const legs = legsFrom(args);
    const orchestratorRoot = desktopRoot();
    const seedMode = resolveCutSeedMode(args);
    if (!seedMode.ok) return json({ ok: false, op: 'run', refused: true, reason: seedMode.reason });
    const selected = await resolveCutRoot(args.root, undefined, seedMode.rootOptions);
    if (!selected.ok) return json({ ok: false, op: 'run', refused: true, reason: selected.reason });

    // Refuse to start a second cut over an in-flight one (structured, so the caller waits).
    const pre = preflightCut(legs, {
      root: selected.desktopRoot,
      release: { version: args.version, channel, sourceSha: args.sourceSha },
      ...(args.deferTag ? { deferTag: true } : {}),
    });
    const inFlight = pre.checks.find((c) => c.name === 'no-cut-in-flight');
    if (inFlight && !inFlight.ok) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `cut_in_flight — ${inFlight.detail}`,
      });
    }

    if (!args.confirm) {
      const argv = buildCutArgv(
        selected.desktopRoot,
        args.version,
        channel,
        legs,
        args.sourceSha,
        '<PATH>',
        cutRuntimeEnv(args, null, resolveConcreteHarnessSlug(undefined, ctx)),
        undefined,
        orchestratorRoot,
      );
      return json({
        ok: true,
        op: 'run',
        dry_run: true,
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        seedMode: seedMode.mode,
        fullHistory: args.fullHistory === true,
        deferTag: args.deferTag === true,
        migrationBootSmokeOverride: args.migrationBootSmokeOverride ?? null,
        root: selected.desktopRoot,
        orchestratorRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        legs,
        localOnly: true,
        preflight: { go: pre.go, blockers: pre.blockers },
        wouldRun: `systemd-run ${argv.join(' ')}`,
        note: pre.go
          ? 'Pass confirm:true to fire the detached LOCAL cut (PAPERCUSP_PUBLISH_GITHUB=0 — no GitHub publish). Then poll release:cut{op:status}. ~35–60 min for a tri-platform cut.'
          : `⚠ preflight is NOT green — resolve first: ${pre.blockers.join('; ')}. confirm:true would fire anyway.`,
      });
    }

    // expensive-verification-loops P-002: same loop gate as run-leg.
    const provenance = await cutWorkItemId(ctx, args.work_item_id);
    if (provenance.refusal) return json({ ok: false, op: 'run', refused: true, reason: provenance.refusal });
    const cutWorkItem = provenance.workItemId;
    const loopRefusal = await loopLaunchRefusal({
      workspaceId: activeWorkspaceId(),
      workItemId: cutWorkItem,
      background: true,
      timeoutMs: 0,
    });
    if (loopRefusal) return json({ ...loopRefusal, op: 'run', refused: true });
    if (seedMode.mode === 'seedless') {
      const seedlessError = prepareSeedlessCutRoot(selected.desktopRoot);
      if (seedlessError) return json({ ok: false, op: 'run', refused: true, reason: seedlessError });
    }

    const { ownerLabel } = readIdentity(ctx);
    const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
    let migrationBootSmokeOverrideAuditId: string | null = null;
    if (args.migrationBootSmokeOverride) {
      try {
        migrationBootSmokeOverrideAuditId = await recordCutAudit(
          'migration-boot-smoke-override',
          actor,
          {
            version: args.version,
            channel,
            ...args.migrationBootSmokeOverride,
          },
          true,
        );
      } catch (err) {
        return json({ ok: false, op: 'run', refused: true, reason: (err as Error).message });
      }
    }
    const managed = await openCutOperation({
      version: args.version,
      channel,
      platform: null,
      sourceSha: args.sourceSha,
      desktopRoot: selected.desktopRoot,
      workItemId: cutWorkItem,
      harnessSlug: resolveConcreteHarnessSlug(undefined, ctx),
    });
    if (!managed.operation) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: managed.reason ?? 'task ledger unavailable — refusing an unmanaged cut',
      });
    }
    const launch = await launchDetachedCut({
      version: args.version,
      channel,
      expectedSourceSha: args.sourceSha,
      runtime: cutRuntimeEnv(args, managed.operation, resolveConcreteHarnessSlug(undefined, ctx)),
      legs,
      root: selected.desktopRoot,
      orchestratorRoot,
    });
    if (launch.launched) {
      // buildCutArgv uses Type=notify and sends READY only after the task marker and
      // stable cut-slot flock are in place, so the reserved task service is live here.
      await markSpawned(managed.operation.taskId, { confined: true, scopeUnit: launch.unit });
    }
    await recordCutAudit('run', actor, {
      version: args.version,
      channel,
      sourceSha: args.sourceSha,
      root: selected.desktopRoot,
      orchestratorRoot,
      legs,
      seedMode: seedMode.mode,
      fullHistory: args.fullHistory === true,
      deferTag: args.deferTag === true,
      ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
      localOnly: true,
      launched: launch.launched,
      unit: launch.unit,
      operationId: launch.operationId,
      migrationBootSmokeOverrideAuditId,
      taskId: launch.taskId,
      ...(managed.reason ? { managedSkipReason: managed.reason } : {}),
      ...(launch.reason ? { reason: launch.reason } : {}),
    });
    return json({
      ok: launch.launched,
      op: 'run',
      launched: launch.launched,
      version: args.version,
      channel,
      sourceSha: args.sourceSha,
      legs,
      seedMode: seedMode.mode,
      fullHistory: args.fullHistory === true,
      deferTag: args.deferTag === true,
      root: selected.desktopRoot,
      orchestratorRoot,
      ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
      localOnly: true,
      unit: launch.unit,
      logPath: launch.logPath,
      managed: launch.operationId !== null,
      operationId: launch.operationId,
      migrationBootSmokeOverrideAuditId,
      taskId: launch.taskId,
      ...(managed.reason ? { managedSkipReason: managed.reason } : {}),
      ...(launch.reason ? { reason: launch.reason } : {}),
      note: launch.launched
        ? 'LOCAL cut started (detached, ~35–60 min). Poll release:cut{op:status}; this connection is not tied to the build. When done: run papercusp-desktop/bin/verify-provenance.sh <leg-out-dir> --health-sha <sha> --require-signed per leg → release:cut{op:handoff,version}.'
        : 'Cut NOT launched — likely a cut is already in flight (see reason). Re-check release:cut{op:status}.',
    });
  },
});
