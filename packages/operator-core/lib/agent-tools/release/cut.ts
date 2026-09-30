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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readIdentity } from '../locks/identity';
import { resolveBashTaskProvenance } from '../capability/bash-task-provenance';
import { loopLaunchRefusal } from '../../verification-attempts/loop-gate';
import type { ResolveIdentityCtx } from '../coordination/identity';
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

const cutRootArg = z
  .string()
  .min(1)
  .describe(
    'Optional registered, clean Git worktree selector. Accepts a registered project slug, the linked worktree path, or that worktree\'s papercusp-desktop path.',
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
  listWorktrees?: (repoPath: string) => CutWorktree[];
  status?: (worktreePath: string) => string;
  canonicalPath?: (candidate: string) => string;
  desktopStatus?: (desktopRoot: string) => string;
  desktopHeadMatches?: (worktreeRoot: string) => boolean;
  headFile?: (desktopRoot: string, relativePath: string) => string;
  readFile?: (absolutePath: string) => string;
  exists?: (absolutePath: string) => boolean;
}

export interface CutRootResolutionOptions {
  /** A completed seed may be reused only when the remaining tracked edits are the
   * exact idempotent version bump written by release-local.sh for this version. */
  reuseSeedVersion?: string;
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
] as const;

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
  throw new Error(`unsupported release resume path: ${relativePath}`);
}

/** Validate the only dirty-tree shape that a reuseSeed retry may erase. The
 * superproject sees a dirty submodule while the submodule itself must contain
 * only release-local.sh's exact version-field rewrites. */
export function validateReleaseResumeResidue(input: {
  superprojectStatus: string;
  desktopStatus: string;
  desktopHeadMatches?: boolean;
  version: string;
  files: Readonly<Record<string, { head: string; worktree: string }>>;
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
      return { ok: false, reason: `desktop status contains a non-worktree modification: ${line}` };
    }
    const relativePath = line.slice(3);
    if (!allowed.has(relativePath)) {
      return { ok: false, reason: `desktop status contains non-cutter path: ${relativePath}` };
    }
    const file = input.files[relativePath];
    if (!file) return { ok: false, reason: `missing residue snapshot for ${relativePath}` };
    let expected: string;
    try {
      expected = expectedVersionFile(relativePath, file.head, input.version);
    } catch (err) {
      return { ok: false, reason: `could not validate ${relativePath}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (file.worktree !== expected) {
      return { ok: false, reason: `${relativePath} contains changes beyond the requested ${input.version} version bump` };
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
    reuseSeed?: boolean;
    migrationBootSmokeOverride?: MigrationBootSmokeOverride;
  },
  operation?: BeginCutOperationResult | null,
): CutRuntimeEnv {
  return {
    ownerName: args.ownerName,
    ownerEmail: args.ownerEmail,
    reuseSeed: args.reuseSeed,
    ...(args.migrationBootSmokeOverride
      ? { migrationBootSmokeOverride: args.migrationBootSmokeOverride }
      : {}),
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
 * DEGRADES rather than blocks. If the ledger write fails, the cut still fires — exactly
 * as every manual cut did before — because failing a release over a bookkeeping write
 * would be worse than cutting unmanaged. What it must NOT do is degrade SILENTLY: the
 * reason is returned and surfaced on the tool response, since "this cut is unmanaged and
 * cannot be resumed" is precisely the fact an operator needs at the 35-minute mark.
 */
async function openCutOperation(input: {
  version: string;
  channel: Channel;
  platform: Platform | null;
  sourceSha: string;
  desktopRoot: string;
  workItemId?: string | null;
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
async function cutWorkItemId(ctx: unknown): Promise<string | null> {
  try {
    return (await resolveBashTaskProvenance(ctx as ResolveIdentityCtx, null)).workItemId;
  } catch {
    return null;
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

function defaultListWorktrees(repoPath: string): CutWorktree[] {
  const stdout = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return parseWorktreeList(String(stdout));
}

export function defaultWorktreeStatus(worktreePath: string): string {
  return String(
    execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      // This is a proof read, not an opportunity to refresh the index. On a
      // newly materialized 38-submodule release tree Git's optional index write
      // exceeded the otherwise adequate 10s guard; the identical read-only
      // status completed in 0.41s and preserved the full cleanliness result.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }),
  );
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
      for (const worktree of listWorktrees(project.path)) {
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
    dirty = status(selected.path);
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
    const desktopStatus = (deps.desktopStatus ?? ((root: string) => execFileSync(
      'git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' },
    )))(desktopRoot);
    const files: Record<string, { head: string; worktree: string }> = {};
    const headFile = deps.headFile ?? ((root: string, relativePath: string) => execFileSync(
      'git', ['-C', root, 'show', `HEAD:${relativePath}`], { encoding: 'utf8' },
    ));
    const readFile = deps.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, 'utf8'));
    for (const line of desktopStatus.split('\n').filter(Boolean)) {
      const relativePath = line.slice(3);
      if ((RELEASE_RESUME_VERSION_PATHS as readonly string[]).includes(relativePath)) {
        files[relativePath] = {
          head: headFile(desktopRoot, relativePath),
          worktree: readFile(path.join(desktopRoot, relativePath)),
        };
      }
    }
    const residue = validateReleaseResumeResidue({
      superprojectStatus: dirty,
      desktopStatus,
      desktopHeadMatches:
        dirty.trimEnd() === ' M papercusp-desktop'
          ? (
              deps.desktopHeadMatches ??
              ((root: string) => {
                try {
                  execFileSync('git', [
                    '-C',
                    root,
                    'diff',
                    '--quiet',
                    '--ignore-submodules=dirty',
                    'HEAD',
                    '--',
                    'papercusp-desktop',
                  ]);
                  return true;
                } catch {
                  return false;
                }
              })
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

  if (options.reuseSeedVersion) {
    const seedManifest = path.join(selected.path, 'papercusp-desktop', 'src-tauri', 'seed', 'manifest.json');
    const exists = deps.exists ?? existsSync;
    if (!exists(seedManifest)) {
      return {
        ok: false,
        reason: `root_resume_seed_missing — reuseSeed requires the completed seed manifest at '${seedManifest}'`,
      };
    }
  }

  return {
    ok: true,
    selector: requested,
    worktreeRoot: selected.path,
    desktopRoot: path.join(selected.path, 'papercusp-desktop'),
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
    'CUT a LOCAL Papercusp desktop release — build+sign installer(s) for the owner to upload (⛔ artifacts stay LOCAL; never create a GitHub Release). Every run/run-leg requires sourceSha, the exact 40-char superproject commit; drift refuses before writes. op:prepare-tag is the separate, explicit remote-ref write required before a brand-new version: create-only force-with-lease, dry-run unless confirm:true, never overwrites a mismatched tag. op:preflight (go/no-go). op:run (fire the WHOLE cut detached; dry-run unless confirm:true; operator role). op:run-leg (fire ONE platform leg on its own unit, for a fleet-split cut; same gate). op:abort-leg (stop one leg). op:status (poll; `platform` = one leg). op:gate-status (read/establish the shared BUILD_SHA gate for version+channel so split legs cannot drift onto different shas). op:handoff (collect signed artifacts+sha256 — leg-agnostic). op:reclaim (list/remove stale cut worktrees; dry-run unless confirm+targets).',
  guidance: {
    when:
      'Cutting a desktop release. Brand-new version: preflight → prepare-tag{sourceSha,confirm:true} → run{sourceSha,confirm:true} → poll status → verify → handoff. Fleet-split (one agent per leg): prepare the tag once, then each agent gate-status first (agree on ONE buildSha) → run-leg{platform,confirm:true} → poll status{platform} → once every leg is done, handoff (collects across all legs).',
    notWhen: "Not the web operator (:3070 — release:deploy) or the green-checkpoint verdict (release:checkpoint-run). Never publish to GitHub.",
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
      mac: z.boolean().optional().describe(MAC_LEG_ARGUMENT_DESCRIPTION),
      windows: z.boolean().optional().describe(WINDOWS_LEG_ARGUMENT_DESCRIPTION),
      arm64: z.boolean().optional().describe('Include the linux-arm64 cross-compile leg.'),
      root: cutRootArg.optional(),
      // The same release context callers carry through every operation. With
      // version + sourceSha (channel defaults to alpha), preflight also checks the
      // exact remote release tag the cut requires (EI-24611322499942803).
      version: z.string().min(1).optional().describe('Release version. With sourceSha, preflight also checks the exact remote release tag.'),
      channel: z.enum(['stable', 'beta', 'alpha']).optional().describe('Release channel for the tag check (default alpha).'),
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/).optional().describe('Exact source commit. With version, preflight blocks when the remote release tag is missing or points elsewhere.'),
    }),
    z.object({
      op: z.literal('prepare-tag'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease).'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/).describe('Exact 40-char superproject commit the new release tag must name.'),
      root: cutRootArg.optional(),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN. true ⇒ create the missing exact remote tag under an absence lease.'),
    }),
    z.object({
      op: z.literal('run'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/).describe('Exact 40-char superproject commit authorized for this cut.'),
      mac: z.boolean().optional().describe(MAC_LEG_ARGUMENT_DESCRIPTION),
      windows: z.boolean().optional().describe(WINDOWS_LEG_ARGUMENT_DESCRIPTION),
      arm64: z.boolean().optional().describe('Include the linux-arm64 cross-compile leg.'),
      root: cutRootArg.optional(),
      ownerName: cutOwnerNameArg,
      ownerEmail: cutOwnerEmailArg,
      reuseSeed: cutReuseSeedArg,
      migrationBootSmokeOverride: migrationBootSmokeOverrideArg.optional().describe('Exceptional exact-source bypass only after an independent full replay passes. Requires a durable proofRef and is audited before launch.'),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN (preview the exact command). true ⇒ fire the detached LOCAL cut.'),
    }),
    z.object({
      op: z.literal('status'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).optional().describe('Poll ONE leg (WI-4233) instead of the legacy whole-cut unit.'),
      // Keep the status poll compatible with release-cut callers that carry the
      // version/channel context through every operation. Status remains host-wide
      // (and therefore does not use these values to select a unit), but rejecting
      // them contradicts the tool's published union-level accepted-args contract.
      version: z.string().min(1).optional().describe('Optional release version carried as caller context; status is host-wide.'),
      channel: z.enum(['stable', 'beta', 'alpha']).optional().describe('Optional release channel carried as caller context; status is host-wide.'),
    }),
    z.object({
      op: z.literal('handoff'),
      version: z.string().min(1).describe('The version whose cut artifacts to collect for the owner.'),
      root: cutRootArg.optional(),
    }),
    z.object({
      op: z.literal('run-leg'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).describe('Which platform leg to fire on its own unit.'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/).describe('Exact 40-char superproject commit authorized for this leg.'),
      root: cutRootArg.optional(),
      ownerName: cutOwnerNameArg,
      ownerEmail: cutOwnerEmailArg,
      reuseSeed: cutReuseSeedArg,
      migrationBootSmokeOverride: migrationBootSmokeOverrideArg.optional().describe('Exceptional exact-source bypass only after an independent full replay passes. Requires a durable proofRef and is audited before launch.'),
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
      confirm: z.boolean().optional().describe('false/absent ⇒ DRY RUN (list verdicts). true ⇒ remove the named targets.'),
      minIdleHours: z.number().min(0).max(24 * 60).optional().describe('HEAD must not have moved within this window (default 24).'),
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
          reason: 'targets_required — confirm:true removes only paths named from a dry-run list; run without confirm first.',
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
      const result = preflightCut(legsFrom(args), { root: selected.desktopRoot, release });
      return json({
        ok: true,
        op: 'preflight',
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        ...result,
        note: result.go
          ? "Ready to cut. release:cut{op:run,version,channel,confirm:true} fires it detached. LOCAL-only — hand the owner the artifacts (op:handoff), never publish to GitHub."
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
      const selected = await resolveCutRoot(args.root);
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
            wouldRun: prepareTagPreview('<registered-isolated-worktree>/papercusp-desktop', args.version, channel, args.sourceSha),
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
          async () => String(
            execFileSync(path.join(selected.desktopRoot, 'bin', 'release-local.sh'), [args.version, channel], {
              cwd: selected.desktopRoot,
              encoding: 'utf8',
              timeout: 120_000,
              maxBuffer: 4 * 1024 * 1024,
              env: {
                ...process.env,
                PAPERCUSP_RELEASE_PREPARE_TAG_SHA: args.sourceSha,
                PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM: '1',
              },
            }),
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
        return json({ ok: false, op: 'prepare-tag', refused: true, version: args.version, channel, sourceSha: args.sourceSha, tag, reason });
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

    // ── status: read-only poll (whole-cut, or one leg with `platform`) ──
    if (args.op === 'status') {
      const status = readCutStatus({ platform: args.platform });
      const unit = cutUnitFor(args.platform);
      const legNote = args.platform ? `leg '${args.platform}' (unit ${unit})` : `unit ${unit}`;
      const note =
        status.state === 'running'
          ? `A cut is in flight (${legNote}). Poll again; the log tail is above. Do NOT start a second cut${args.platform ? ' for this leg' : ''}.`
          : status.state === 'done'
            ? `The last ${legNote} finished OK. ${args.platform ? "Once every leg is done, run papercusp-desktop/bin/verify-provenance.sh <leg-out-dir> --health-sha <sha> --require-signed, then release:cut{op:handoff,version}." : 'Run papercusp-desktop/bin/verify-provenance.sh <leg-out-dir> --health-sha <sha> --require-signed for each leg, then release:cut{op:handoff,version} to collect the artifacts for the owner.'}`
            : status.state === 'failed'
              ? `The last ${legNote} FAILED (exit ${status.exitCode}). Inspect the log tail above / ${status.logPath}; fix and re-run.`
              : status.state === 'interrupted'
                ? `The last ${legNote} was INTERRUPTED before its DONE sentinel was written. ${
                    status.operation?.operationId
                      ? `It ran under managed operation ${status.operation.operationId}, so its committed phase receipts survive — a re-run resumes from the last one rather than rebuilding.`
                      : 'It ran UNMANAGED (no operation id on the started marker), so there are no phase receipts to resume from — a re-run rebuilds from the start.'
                  } Inspect the log tail above / ${status.logPath}; fix or intentionally restart it.`
              : `No cut in flight and no recent result for ${legNote} on this host.`;
      return json({ ok: true, op: 'status', ...(args.platform ? { platform: args.platform } : {}), ...status, note });
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
      const { gate, created } = readOrCreateGate(args.version, args.channel as Channel, ownerLabel, { root: selected.desktopRoot });
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
      const selected = await resolveCutRoot(
        args.root,
        undefined,
        args.reuseSeed ? { reuseSeedVersion: args.version } : undefined,
      );
      if (!selected.ok) return json({ ok: false, op: 'run-leg', refused: true, reason: selected.reason });

      const pre = preflightCut(legs, {
        platform,
        root: selected.desktopRoot,
        release: { version: args.version, channel, sourceSha: args.sourceSha },
      });
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
          cutRuntimeEnv(args),
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
            ? `Pass confirm:true to fire the detached LOCAL ${platform} leg (unit ${cutUnitFor(platform)}). Then poll release:cut{op:status,platform:'${platform}'}.`
            : `⚠ preflight is NOT green for this leg — resolve first: ${pre.blockers.join('; ')}. confirm:true would fire anyway.`,
        });
      }

      // expensive-verification-loops P-002: a cut for a work item that keeps failing
      // slow attempts waits for an audit on the item, before any side effect below.
      const cutWorkItem = await cutWorkItemId(ctx);
      const loopRefusal = await loopLaunchRefusal({
        workspaceId: activeWorkspaceId(), workItemId: cutWorkItem, background: true, timeoutMs: 0,
      });
      if (loopRefusal) return json({ ...loopRefusal, op: 'run-leg', refused: true });

      const { ownerLabel } = readIdentity(ctx);
      const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
      let migrationBootSmokeOverrideAuditId: string | null = null;
      if (args.migrationBootSmokeOverride) {
        try {
          migrationBootSmokeOverrideAuditId = await recordCutAudit('migration-boot-smoke-override', actor, {
            version: args.version, channel, platform,
            ...args.migrationBootSmokeOverride,
          }, true);
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
      });
      const launch = await launchDetachedCut({
        version: args.version,
        channel,
        expectedSourceSha: args.sourceSha,
        runtime: cutRuntimeEnv(args, managed.operation),
        legs,
        platform,
        root: selected.desktopRoot,
        orchestratorRoot,
      });
      await recordCutAudit('run-leg', actor, {
        platform,
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        root: selected.desktopRoot,
        orchestratorRoot,
        legs,
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
    const selected = await resolveCutRoot(
      args.root,
      undefined,
      args.reuseSeed ? { reuseSeedVersion: args.version } : undefined,
    );
    if (!selected.ok) return json({ ok: false, op: 'run', refused: true, reason: selected.reason });

    // Refuse to start a second cut over an in-flight one (structured, so the caller waits).
    const pre = preflightCut(legs, {
      root: selected.desktopRoot,
      release: { version: args.version, channel, sourceSha: args.sourceSha },
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
        cutRuntimeEnv(args),
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
    const cutWorkItem = await cutWorkItemId(ctx);
    const loopRefusal = await loopLaunchRefusal({
      workspaceId: activeWorkspaceId(), workItemId: cutWorkItem, background: true, timeoutMs: 0,
    });
    if (loopRefusal) return json({ ...loopRefusal, op: 'run', refused: true });

    const { ownerLabel } = readIdentity(ctx);
    const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
    let migrationBootSmokeOverrideAuditId: string | null = null;
    if (args.migrationBootSmokeOverride) {
      try {
        migrationBootSmokeOverrideAuditId = await recordCutAudit('migration-boot-smoke-override', actor, {
          version: args.version, channel,
          ...args.migrationBootSmokeOverride,
        }, true);
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
    });
    const launch = await launchDetachedCut({
      version: args.version,
      channel,
      expectedSourceSha: args.sourceSha,
      runtime: cutRuntimeEnv(args, managed.operation),
      legs,
      root: selected.desktopRoot,
      orchestratorRoot,
    });
    await recordCutAudit('run', actor, {
      version: args.version,
      channel,
      sourceSha: args.sourceSha,
      root: selected.desktopRoot,
      orchestratorRoot,
      legs,
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
