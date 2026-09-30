/**
 * `system:nightly-release-cut` — the daily Linux GUI-only nightly cutter
 * (WI-36794, Workstream H(a)).
 *
 * The durable routine is intentionally a very small dispatcher. A release cut is a
 * 30–40 minute build that must outlive the DBOS routine step, so the action launches
 * `bin/release-local.sh` through the task-manager's `managedSpawn` seam and returns.
 * The release checkout is supplied explicitly (`PAPERCUSP_NIGHTLY_RELEASE_ROOT`); the
 * canonical staging tree is never a valid cut root because release-local.sh rewrites
 * version files and commits them as part of its normal lifecycle.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { managedSpawn } from '../../task-manager/managed-spawn';
import { newTaskId } from '../../task-manager/types';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { RELEASE_REUSE_MAX_AGE_SEC } from '../../release-cut-launch';

export const NIGHTLY_RELEASE_ACTION = 'nightly-release-cut';
export const NIGHTLY_RELEASE_LOCK_PATH = path.join(os.tmpdir(), 'papercusp-nightly-release-cut.lock');
export const NIGHTLY_RELEASE_RUNTIME_MAX_SEC = 3 * 60 * 60;
export const NIGHTLY_RELEASE_MEMORY_MAX_BYTES = 24 * 1024 ** 3;
export const NIGHTLY_RELEASE_REUSE_MAX_AGE_SEC = RELEASE_REUSE_MAX_AGE_SEC;

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/;

/** Build a monotonically sortable nightly version from the stable desktop version.
 *
 * The channel is carried by the release tag (`desktop-v<version>-nightly`), so the
 * version deliberately contains only a date/time prerelease. Embedding `-nightly`
 * here would produce the misleading `...-nightly-nightly` tag. UTC makes retries on
 * hosts in different time zones converge on the same daily cut identity.
 */
export function nextNightlyVersion(baseVersion: string, now: Date = new Date()): string {
  const match = VERSION_RE.exec(baseVersion.trim());
  if (!match) throw new Error(`nightly release requires X.Y.Z with an optional prerelease (got ${JSON.stringify(baseVersion)})`);
  // The first nightly after a stable bumps to that stable line's next patch. A
  // subsequent nightly replaces the timestamp on the SAME prerelease line instead
  // of consuming a new stable patch every day.
  const patch = Number(match[3]) + (match[4] ? 0 : 1);
  const stamp = [
    now.getUTCFullYear().toString().padStart(4, '0'),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0'),
  ].join('') + `.${now.getUTCHours().toString().padStart(2, '0')}${now.getUTCMinutes().toString().padStart(2, '0')}`;
  return `${match[1]}.${match[2]}.${patch}-${stamp}`;
}

export function readDesktopVersion(desktopRoot: string): string {
  const file = path.join(desktopRoot, 'package.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`desktop package.json has no string version (${file})`);
  return parsed.version;
}

/** Read the desktop version from the exact submodule commit pinned by a
 * superproject source SHA. The staging working tree may already be ahead of
 * green main, so reading its package.json would bind a main cut to moving bytes. */
export function readDesktopVersionAtSource(sourceRoot: string, sourceSha: string): string {
  const treeLine = execFileSync('git', ['-C', sourceRoot, 'ls-tree', sourceSha, '--', 'papercusp-desktop'], {
    encoding: 'utf8',
  }).trim();
  const match = /^160000 commit ([0-9a-f]{40})\tpapercusp-desktop$/.exec(treeLine);
  if (!match) throw new Error(`source ${sourceSha} has no pinned papercusp-desktop gitlink`);
  const body = execFileSync(
    'git',
    ['-C', path.join(sourceRoot, 'papercusp-desktop'), 'show', `${match[1]}:package.json`],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(body) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`pinned papercusp-desktop ${match[1]} has no string version`);
  return parsed.version;
}

/** Every gitlink in the exact superproject tree, keyed by repository-relative path. */
export function readSourceGitlinks(sourceRoot: string, sourceSha: string): Record<string, string> {
  const gitmodules = execFileSync(
    'git',
    ['-C', sourceRoot, 'show', `${sourceSha}:.gitmodules`],
    { encoding: 'utf8' },
  );
  const paths = [...gitmodules.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
    .map((match) => match[1])
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`source ${sourceSha} has no unique committed .gitmodules paths`);
  }
  const output = execFileSync(
    'git',
    ['-C', sourceRoot, 'ls-tree', sourceSha, '--', ...paths],
    { encoding: 'utf8' },
  );
  const gitlinks: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line);
    if (match) gitlinks[match[2]] = match[1];
  }
  const missing = paths.filter((entry) => !Object.hasOwn(gitlinks, entry));
  if (missing.length > 0) {
    throw new Error(`source ${sourceSha} has non-gitlink submodule path(s): ${missing.join(', ')}`);
  }
  return Object.fromEntries(Object.entries(gitlinks).sort(([left], [right]) => left.localeCompare(right)));
}

export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

/** Resolve only a dedicated release checkout. Never fall back to the canonical tree. */
export function nightlyReleaseRoot(
  env: NodeJS.ProcessEnv = process.env,
  sourceRoot: string = integrationRoot(),
): string | null {
  const candidate = env.PAPERCUSP_NIGHTLY_RELEASE_ROOT?.trim();
  if (!candidate) return null;
  const root = path.resolve(candidate);
  const source = path.resolve(sourceRoot);
  if (root === source) return null;
  const base = path.basename(root);
  if (/^(papercup|papercusp)(-(staging|release|checkpoint))?$/.test(base)) return null;
  // The system action is allowed to materialize an absent checkout on first fire,
  // but only at a path whose name states its dedicated purpose. This keeps a typo
  // from turning setup-release-checkout.sh's reset+clean into a destructive write
  // against an arbitrary sibling repository.
  if (!/(?:^|[-_.])nightly(?:[-_.]|$)/i.test(base)) return null;
  if (existsSync(root) && !existsSync(path.join(root, 'papercusp-desktop', 'bin', 'release-local.sh'))) return null;
  return root;
}

export interface NightlyCutInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  version: string;
  sourceSha: string;
}

/** Pure command/env construction, kept exported for focused tests. */
export function buildNightlyCutInvocation(
  releaseRoot: string,
  sourceRoot: string,
  version: string,
  sourceSha: string,
  ownerName: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NightlyCutInvocation {
  const desktopRoot = path.join(releaseRoot, 'papercusp-desktop');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value;
  env.PAPERCUSP_BUILD_ROLES = 'gui';
  env.PAPERCUSP_ALLOW_INCOMPLETE_ROLES = '1';
  env.PAPERCUSP_PUBLISH_GITHUB = '0';
  env.PAPERCUSP_SKIP_MOBILE = '1';
  // Nightly is cut from a churning trunk checkout. Keep the provenance honest while
  // allowing the lenient nightly channel to produce a local artifact from dirty HEAD.
  env.PAPERCUSP_ALLOW_DIRTY = '1';
  env.PAPERCUSP_EXPECTED_SOURCE_SHA = sourceSha;
  env.PAPERCUSP_RELEASE_OWNER_NAME = ownerName.trim();
  env.PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC = String(NIGHTLY_RELEASE_REUSE_MAX_AGE_SEC);
  return {
    command: 'bash',
    // A local cut requires an exact remote tag so the packaged dogfood clone is
    // pinned. Run the create-if-absent operation through the CURRENT source's
    // release-owned script before materializing green main. The frozen source may
    // predate the prepare-tag operation (the first production fire hit exactly
    // that bootstrap boundary), while the actual cut must still execute entirely
    // from the exact green-main checkout. Both calls live in ONE managed task, so
    // DBOS recovery/concurrency sees a single flight.
    args: [
      '-c',
      'export PAPERCUSP_RELEASE_CHILD_STARTED_AT_MS="$(date +%s%3N)"; PAPERCUSP_RELEASE_PREPARE_TAG_SHA="$PAPERCUSP_EXPECTED_SOURCE_SHA" PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM=1 "$2/papercusp-desktop/bin/release-local.sh" "$1" nightly && "$2/apps/operator/bin/release/setup-release-checkout.sh" --integration "$2" --release "$3" --ref "$PAPERCUSP_EXPECTED_SOURCE_SHA" --node-modules force --node-modules-copy copy --node-modules-generation required --source-integrity object-sourced && cd "$3/papercusp-desktop" && bin/release-local.sh "$1" nightly',
      'nightly-release-cut',
      version,
      sourceRoot,
      releaseRoot,
    ],
    // First fire may create releaseRoot, so the spawn cwd must already exist.
    // The managed child changes into the freshly pinned desktop tree after the
    // shared release-checkout materializer succeeds.
    cwd: sourceRoot,
    env,
    version,
    sourceSha,
  };
}

interface CutLock {
  pid: number;
  version: string;
  startedAt: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cross-fire single-flight guard. The lock stores the child PID, not the routine
 * worker PID, so a bg-host restart cannot make a surviving build look idle. */
export function acquireNightlyLock(lockPath: string, version: string): boolean {
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<CutLock>;
    if (typeof current.pid === 'number' && pidAlive(current.pid)) return false;
  } catch {
    // Missing/corrupt lock is safe to replace — the child PID is the liveness oracle.
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* absent */
  }
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, version, startedAt: Date.now() } satisfies CutLock));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function replaceNightlyLockPid(lockPath: string, version: string, pid: number): void {
  writeFileSync(lockPath, JSON.stringify({ pid, version, startedAt: Date.now() } satisfies CutLock));
}

export function releaseNightlyLock(lockPath: string, pid: number): void {
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<CutLock>;
    if (current.pid === pid) unlinkSync(lockPath);
  } catch {
    /* already released or reclaimed */
  }
}

export interface NightlyCutRunResult {
  status: 'launched' | 'skipped';
  reason?: string;
  invocation?: NightlyCutInvocation;
  taskId?: string;
}

export async function runNightlyCut(
  ctx: Pick<SystemActionCtx, 'installSlug'> & Partial<Pick<SystemActionCtx, 'workspaceId'>>,
  opts: {
    env?: NodeJS.ProcessEnv;
    now?: Date;
    lockPath?: string;
    spawnFn?: typeof managedSpawn;
    readVersion?: (sourceRoot: string, sourceSha: string) => string;
    readGitlinks?: (sourceRoot: string, sourceSha: string) => Record<string, string>;
    sourceSha?: string;
    taskId?: string;
    operationId?: string;
  } = {},
): Promise<NightlyCutRunResult> {
  if (process.platform !== 'linux') return { status: 'skipped', reason: 'nightly cuts are Linux-only' };
  if (ctx.installSlug && ctx.installSlug !== operatorHomeHarnessSlug()) {
    return { status: 'skipped', reason: `not the operator-home harness (got ${ctx.installSlug})` };
  }
  const env = opts.env ?? process.env;
  const ownerName = env.PAPERCUSP_RELEASE_OWNER_NAME?.trim();
  if (!ownerName) return { status: 'skipped', reason: 'PAPERCUSP_RELEASE_OWNER_NAME is not configured' };
  const sourceRoot = integrationRoot();
  const root = nightlyReleaseRoot(env, sourceRoot);
  if (!root) return { status: 'skipped', reason: 'PAPERCUSP_NIGHTLY_RELEASE_ROOT is missing or not a dedicated release checkout' };
  const sourceSha = opts.sourceSha ?? execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'main^{commit}'], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) return { status: 'skipped', reason: 'could not resolve an exact 40-character source SHA' };
  const baseVersion = opts.readVersion
    ? opts.readVersion(sourceRoot, sourceSha)
    : readDesktopVersionAtSource(sourceRoot, sourceSha);
  const version = nextNightlyVersion(baseVersion, opts.now);
  const gitlinks = (opts.readGitlinks ?? readSourceGitlinks)(sourceRoot, sourceSha);
  const taskId = opts.taskId ?? newTaskId();
  const operationId = opts.operationId ?? randomUUID();
  const invocation = buildNightlyCutInvocation(root, sourceRoot, version, sourceSha, ownerName, env);
  invocation.env.PAPERCUSP_RELEASE_TASK_ID = taskId;
  invocation.env.PAPERCUSP_RELEASE_OPERATION_ID = operationId;
  invocation.env.PAPERCUSP_RELEASE_ENQUEUED_AT_MS = String(Date.now());
  const lockPath = opts.lockPath ?? NIGHTLY_RELEASE_LOCK_PATH;
  if (!acquireNightlyLock(lockPath, version)) return { status: 'skipped', reason: 'a nightly release cut is already running' };

  const spawn = opts.spawnFn ?? (managedSpawn as typeof managedSpawn);
  try {
    const managed = await spawn(
      invocation.command,
      invocation.args,
      {
        class: 'deploy',
        title: `nightly desktop release ${version}`,
        argv: [invocation.command, ...invocation.args],
        cwd: invocation.cwd,
        launchedBy: `system:${NIGHTLY_RELEASE_ACTION}`,
        harnessSlug: ctx.installSlug || operatorHomeHarnessSlug(),
        memoryMaxBytes: NIGHTLY_RELEASE_MEMORY_MAX_BYTES,
        runtimeMaxSec: NIGHTLY_RELEASE_RUNTIME_MAX_SEC,
        detail: {
          channel: 'nightly',
          version,
          sourceSha,
          release: {
            schemaVersion: 1,
            operationId,
            source: { sha: sourceSha, gitlinks },
            artifactIdentity: {
              kind: 'papercusp-desktop-release',
              channel: 'nightly',
              sourceSha,
              version,
            },
            credential: {
              generation: invocation.env.PAPERCUSP_RELEASE_CREDENTIAL_GENERATION ?? null,
              expiresAt: invocation.env.PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT ?? null,
            },
            cursor: 0,
            currentStage: null,
            currentState: null,
            spentOperationIds: [],
            receipts: [],
          },
        },
      },
      {
        workspaceId: ctx.workspaceId,
        taskId,
        spawnOptions: { cwd: invocation.cwd, env: invocation.env, detached: true, stdio: 'inherit' },
      },
    );
    const childPid = managed.child.pid;
    if (typeof childPid === 'number') replaceNightlyLockPid(lockPath, version, childPid);
    managed.child.once('close', () => {
      if (typeof childPid === 'number') releaseNightlyLock(lockPath, childPid);
    });
    managed.child.once('error', () => {
      if (typeof childPid === 'number') releaseNightlyLock(lockPath, childPid);
    });
    return { status: 'launched', invocation, taskId: managed.taskId };
  } catch (error) {
    releaseNightlyLock(lockPath, process.pid);
    return { status: 'skipped', reason: `managed nightly spawn failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

registerSystemAction(
  NIGHTLY_RELEASE_ACTION,
  async (ctx) => {
    const result = await runNightlyCut(ctx);
    if (result.status === 'skipped') console.warn(`[${NIGHTLY_RELEASE_ACTION}] skip: ${result.reason}`);
    else console.log(`[${NIGHTLY_RELEASE_ACTION}] launched ${result.invocation?.version} (task ${result.taskId ?? 'unledgered'})`);
  },
  // The action returns after enqueueing a managed child; a short routine step is the
  // correct timeout even though the child itself receives the three-hour budget above.
  { routineTimeoutMs: 30_000 },
);
