/**
 * The git-sync pipeline — git-sync-auto-commit. The pure-ish unit (inject `runGit`
 * + `repoPath` to test); `git-sync-action.ts` wraps it with locks, conflict
 * escalation + resolver, and routine-metadata recording.
 *
 * Syncs the WHOLE repo to origin — dynamically + recursively, no hardcoded list:
 *   - `syncOneRepo` is the per-repo primitive: commit dirty (whole-tree `git add -A`)
 *     → fetch → merge (handles diverged / non-fast-forward) → push. On a merge
 *     conflict it aborts to a CLEAN tree and reports the conflict (agents must never
 *     see a half-merged tree).
 *   - Submodules are discovered at runtime via `git submodule status --recursive`
 *     (auto-adjusts to whatever submodules exist, to any nesting depth — add/remove
 *     one and it's picked up with no code change) and synced **deepest-first**, so a
 *     child's commit is on its origin before any parent's pointer to it is pushed →
 *     a fresh clone of pushed `main` always resolves the entire tree. Each level's
 *     pointer bump shows up as a dirty change when its parent is synced.
 *   - The superproject is synced last.
 *   - EI-18689553108460319: whether the SUPERPROJECT pushes (`GitSyncConfig.push`) and
 *     whether SUBMODULES push to their own origins (`GitSyncConfig.pushSubmoduleOrigins`)
 *     are INDEPENDENT knobs. A bridged/p2p-only hive sets `push:false` so its bridge
 *     writer stays the sole pusher of the hive's own canonical superproject refs — that
 *     never implies submodules (unrelated, independently-hosted GitHub libs) should also
 *     go commit-only; nothing else ever pushes them, so doing so silently strands their
 *     history forever (8 days / 65 commits observed on `libs/generic/sync` before this fix).
 *
 * git-sync DELIBERATELY `git add -A`s each repo (unlike the SCOPED git-export
 * committer in `git-committer.ts`) — owning the whole-tree commit is its entire
 * purpose (it's why agents stop committing).
 *
 * WI-1416: the pass is CHECKPOINTABLE — three phases (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) run under the injectable
 * `RunGitSyncOpts.step` seam so a durable caller records one DBOS
 * operation_output per phase, and every git subprocess is time-bounded (the hang
 * guard below). See GitSyncStepRunner for the replay-safety contract.
 */
import { spawn } from 'node:child_process';
import { collectChildOutput } from '../../child-output.js';
import { processGroupLifetime } from '../../fleet/process-group-lifetime';
import { withGitFetchHeadroom } from './git-fetch-headroom';
import { lstat, open, readFile, readlink, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLiveLockHoldingsForRepo } from './live-lock-coordinates';
import { projectDirForSlug } from '../../operator-notes';
import { gitSidecarEnabled, isSidecarInfrastructureFault, noteSidecarFallback, runGitViaSpawnerSidecar } from '../../fleet/git-via-sidecar';
import { detectContentOffenders, parseDirtyPaths, type ContentOffender } from './content-guard';
import { detectUnsafeDeletions, normalizeModulePath, RESOLVABLE_EXTS } from './deletion-import-guard';
import { detectWholesaleDeletion } from './wholesale-deletion-guard';
import { detectQuarantineImporters } from './quarantine-import-guard';
import { DEFAULT_CONTENT_DETECTORS, type ContentDetector } from '../../content-lint/registry';
import { armedMigrationFilename } from '../../migration-reservation';
import {
  groupFilesForAttribution,
  attributionMapForRepo,
  diffDerivedSubject,
  parseNumstat,
  DEFAULT_GIT_SYNC_SUBJECT,
  type FileAttribution,
  type AttributionRosterEntry,
} from './git-sync-attribution';

export type RunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const envMs = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/** Subcommands that touch the network (a hung remote must fail fast, not stall the fire). */
const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);

/** Repos at the same depth have separate git dirs; parents still wait for children. */
const SUBMODULE_SYNC_CONCURRENCY = 4;

/**
 * WI-5111: git-sync commits under the box's GLOBAL git identity, which on every
 * shared dev box is the OWNER's own `user.name`/`user.email` (agents never commit
 * under their own identity — CLAUDE.md "git-sync owns commit + push — you do
 * neither"). The result: `git blame` / `git log --format=%an` on EVERY line of
 * EVERY file returns the owner's name, indistinguishable from the owner having
 * typed the change himself. This is not a harmless dead end (an agent that trusts
 * blame just gets "unknown") — it is a FALSE-POSITIVE generator (an agent gets a
 * confident, wrong, and highly plausible answer). Observed harm: a release-fixer's
 * blame-the-regression triage escalated an AGENT's own incomplete migration to the
 * owner as a blocker, in the second person ("YOUR migration ... YOU updated"),
 * entirely on the strength of `git blame` (escalation mro7nmi5, 2026-07-17).
 *
 * Fix: EVERY git-sync commit is made under this bot identity via `-c user.name=`
 * / `-c user.email=` (per-invocation override — never touches the box's global git
 * config, so an interactive `git commit` elsewhere on the box is unaffected).
 * Blame now visibly shows a bot, an agent cannot form "the owner wrote this", and
 * a REAL owner commit (there are none on this tree going forward, but historical
 * ones stay as-is) is trivially distinguishable from the automation. Prepended
 * BEFORE the subcommand in the argv (gitSubcommand already special-cases `-c`
 * pairs when reading past them for the timeout/network classification above).
 */
export const GIT_SYNC_BOT_NAME = 'papercusp-git-sync';
/**
 * GitHub rejects pushes whose commit author email is not verified on the
 * authenticated account. Keep the bot name for attribution, but use the
 * papercupai no-reply identity already used by the repository's publishing
 * path so automated superproject pushes are accepted.
 */
export const GIT_SYNC_BOT_EMAIL = 'papercupai@users.noreply.github.com';
const GIT_SYNC_IDENTITY_ARGS = ['-c', `user.name=${GIT_SYNC_BOT_NAME}`, '-c', `user.email=${GIT_SYNC_BOT_EMAIL}`];

/** The git SUBCOMMAND in an argv — skipping leading global flags AND the separate
 *  value a `-c`/`-C` option consumes (`['-c','x=y','fetch']` → 'fetch', not 'x=y'). */
const gitSubcommandIndex = (args: string[]): number => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') {
      i++; // the option's value rides in the NEXT token
      continue;
    }
    if (a.startsWith('-')) continue;
    return i;
  }
  return -1;
};

const gitSubcommand = (args: string[]): string => {
  const index = gitSubcommandIndex(args);
  return index >= 0 ? args[index] : '';
};

/** These read-only commands need no optional Git locks while offloaded. */
const GIT_SIDECAR_READ_ONLY_COMMANDS = new Set([
  'rev-parse', 'cat-file', 'ls-files', 'ls-tree', 'merge-base', 'rev-list',
  'for-each-ref',
]);

/** Network commands whose native progress stream can drive the idle watchdog.
 * Git suppresses progress when stderr is not a TTY unless `--progress` is explicit;
 * git-sync always pipes stderr, so without this flag a healthy multi-GB fetch looks
 * exactly like a wedged child until it finishes. */
const GIT_PROGRESS_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'clone']);

const withGitProgress = (args: string[]): string[] => {
  const index = gitSubcommandIndex(args);
  if (index < 0 || !GIT_PROGRESS_SUBCOMMANDS.has(args[index])) return args;
  if (args.includes('--progress') || args.includes('--no-progress')) return args;
  return [...args.slice(0, index + 1), '--progress', ...args.slice(index + 1)];
};

/**
 * WI-1416 hang guard: the idle ceiling for one git subprocess. Local commands retain
 * the original wall-clock behavior. Network commands refresh this deadline whenever
 * their forced progress stream advances, so a healthy large transfer may outlive four
 * minutes while a silent/wedged remote still fails fast. The independent hard ceiling
 * below prevents an endlessly-chatty broken child from living forever.
 *
 * Env-tunable: PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS (idle),
 * PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS, PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS.
 */
export const gitTimeoutMsFor = (args: string[]): number =>
  GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? envMs('PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS', 4 * 60_000)
    : envMs('PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS', 6 * 60_000);

export const gitHardTimeoutMsFor = (args: string[], idleTimeoutMs = gitTimeoutMsFor(args)): number =>
  GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? Math.max(idleTimeoutMs, envMs('PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS', 60 * 60_000))
    : idleTimeoutMs;

/** Spawn `git <args>` in `cwd`, capturing exit code + output, bounded by `timeoutMs`
 *  (never throws, never hangs). Exported so the hang guard is directly testable.
 *  WI-3793: now backed by the shared, defensively-guarded
 *  `isSidecarEnabledFromEnv` (same enable/mode-var pattern every node-child
 *  sidecar shares) instead of a hand-rolled inline check — behavior is
 *  unchanged (this was already the ONE call site with the `_MODE` guard). */
export function gitSyncSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gitSidecarEnabled('PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR', env);
}

export interface GitRunExecutionOptions {
  /** Called whenever the local git child emits output or the command settles. */
  onProgress?: () => void;
  /** Abort a git child when its owning git-sync fire is declared stalled. */
  signal?: AbortSignal;
}

const runGitLocalBounded = (
  args: string[],
  cwd: string,
  idleTimeoutMs: number,
  hardTimeoutMs: number,
  progressAware: boolean,
  options: GitRunExecutionOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
    // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
    // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
    // parsing is then reliable at the root, rather than depending on the operator's locale.
    //
    // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
    // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
    // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
    // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
    // this marker the hook would run the affected suite on the scheduled push and wedge
    // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
    // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
    const child = spawn('git', args, {
      cwd,
      // Referenced and awaited: this creates a group for cancellation, not an
      // independent job. Helpers must exit before the owning leases release.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
        PAPERCUSP_GIT_SYNC_PUSH: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const out = collectChildOutput(child);
    const groupLifetime = processGroupLifetime(child, (message) => out.stderr.append(`\ngit ${message}`));
    let settled = false;
    let terminating = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleCheck: ReturnType<typeof setImmediate> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener = (): void => {};
    const reportProgress = (): void => {
      try {
        options.onProgress?.();
      } catch {
        // Progress accounting is diagnostic-only and must never break git.
      }
    };
    const clearTimers = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (idleCheck) clearImmediate(idleCheck);
      idleCheck = null;
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (killTimer) clearTimeout(killTimer);
      removeAbortListener();
      reportProgress();
      resolve({ code: terminating ? -1 : code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const terminate = (reason: string): void => {
      if (settled || terminating) return;
      terminating = true;
      clearTimers();
      out.stderr.append(
        `${out.stderr.peek() ? '\n' : ''}git ${args.join(' ')} ${reason} — killed by the git-sync hang guard`,
      );
      // SIGTERM permits Git lock-file cleanup. Escalate against the same group,
      // but never equate sending a signal or exhausting a grace with actual exit.
      groupLifetime.signal('SIGTERM');
      killTimer = setTimeout(() => groupLifetime.signal('SIGKILL'), 10_000);
      killTimer.unref?.();
    };
    const armIdleTimer = (): void => {
      if (!progressAware || settled || terminating) return;
      if (idleTimer) clearTimeout(idleTimer);
      if (idleCheck) clearImmediate(idleCheck);
      idleCheck = null;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        // Match the sidecar's pipe-progress contract: after a delayed parent
        // loop, POLL must see already-written bytes before this idle verdict.
        // Keep the separate absolute deadline unchanged.
        idleCheck = setImmediate(() => {
          idleCheck = null;
          terminate(`made no output progress for ${idleTimeoutMs}ms`);
        });
        // This one-shot verdict must also run when the child emits nothing;
        // unref would let POLL wait for child close or the hard deadline.
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    if (progressAware) {
      // `collectChildOutput` owns decoding; these listeners only observe byte
      // arrival and therefore cannot split/corrupt a multi-byte character.
      const onOutput = (): void => {
        reportProgress();
        armIdleTimer();
      };
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      armIdleTimer();
      hardTimer = setTimeout(
        () => terminate(`exceeded the ${hardTimeoutMs}ms hard ceiling despite output progress`),
        hardTimeoutMs,
      );
      hardTimer.unref?.();
    } else {
      hardTimer = setTimeout(() => terminate(`timed out after ${hardTimeoutMs}ms`), hardTimeoutMs);
      hardTimer.unref?.();
    }
    if (options.signal) {
      const onAbort = (): void => terminate('aborted by the git-sync stall guard');
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => {
      out.stderr.append(String(e));
      // A failed spawn has no child to drain. Other errors are not exit proof.
      if (child.pid === undefined) finish(-1);
    });
    child.on('close', async (code) => {
      await groupLifetime.waitForExit();
      finish(code ?? -1);
    });
  });

export const runGitBounded = async (
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: GitRunExecutionOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  withGitFetchHeadroom(args,
    (guardedArgs, signal) => runGitBoundedUnchecked(guardedArgs, cwd, timeoutMs, { ...options, signal }),
    options.signal);

const runGitBoundedUnchecked = async (
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: GitRunExecutionOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  if (options.signal?.aborted) return { code: -1, stdout: '', stderr: 'git aborted before spawn' };
  // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
  // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
  // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
  // parsing is then reliable at the root, rather than depending on the operator's locale.
  //
  // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
  // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
  // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
  // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
  // this marker the hook would run the affected suite on the scheduled push and wedge
  // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
  // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
  const network = GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args));
  const effectiveArgs = network ? withGitProgress(args) : args;
  const hardTimeoutMs = gitHardTimeoutMsFor(args, timeoutMs);
  // git-sync is unattended. A credential helper may answer, but an interactive
  // prompt can never make progress and would otherwise survive until the network
  // hang guard fires.
  const env = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    PAPERCUSP_GIT_SYNC_PUSH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  // Cancellable calls bind dispatch to a verified server/connection and retain
  // this promise through transport recovery until child exit is proven. Only a
  // failure BEFORE dispatch rejects into local fallback; a lost execution result
  // resolves as unknown and must never replay a mutation.
  const readOnly = GIT_SIDECAR_READ_ONLY_COMMANDS.has(gitSubcommand(args));
  if (gitSyncSidecarEnabled()) {
    try {
      options.onProgress?.();
      const result = await runGitViaSpawnerSidecar(effectiveArgs, cwd, hardTimeoutMs,
        options.signal && readOnly ? { ...env, GIT_OPTIONAL_LOCKS: '0' } : env, {
        idleTimeoutMs: network ? timeoutMs : undefined,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      options.onProgress?.();
      return result;
    } catch (e) {
      // Was a console.warn PER CALL — the opposite failure from warn-once, and
      // just as unhelpful: a sustained outage buries the log without ever
      // stating a rate. The shared seam bounds the cadence and carries the
      // cumulative count.
      noteSidecarFallback('git-sync', e);
      if (options.signal?.aborted) {
        return { code: -1, stdout: '', stderr: 'git aborted after sidecar transport loss' };
      }
    }
  }
  return runGitLocalBounded(effectiveArgs, cwd, timeoutMs, hardTimeoutMs, network, options);
};

/** Spawn `git <args>` in `cwd` with the default per-subcommand ceiling (never throws). */
const defaultRunGit: RunGit = (args, cwd) => runGitBounded(args, cwd, gitTimeoutMsFor(args));

/** No Git child ran on a sidecar admission refusal; do not diagnose a Git merge conflict. */
export function gitSyncPreDispatchError(result: Awaited<ReturnType<RunGit>>): string | null {
  return isSidecarInfrastructureFault(result)
    ? `git-sync sidecar infrastructure refusal before Git dispatch: ${result.stderr.slice(0, 300)}`
    : null;
}

const TOOL_CATALOG_GENERATOR_PATH = 'scripts/gen-tool-catalog.ts';
const TOOL_CATALOG_ARTIFACT_PATH = '.papercusp/tool-catalog.json';
const TOOL_CATALOG_TRACKED_PATHS = [TOOL_CATALOG_GENERATOR_PATH, TOOL_CATALOG_ARTIFACT_PATH] as const;

/** The exact source surface guarded by affected-tests.mjs's gen:tool-catalog:check entry. */
export function affectsToolCatalog(path: string): boolean {
  return (
    (path.startsWith('packages/operator-core/lib/agent-tools/') && !path.endsWith('.test.ts')) ||
    (path.startsWith('packages/agent-mcp/src/') && !path.endsWith('.test.ts')) ||
    (path.startsWith('libs/generic/tooldef/src/') && !path.endsWith('.test.ts')) ||
    path === TOOL_CATALOG_GENERATOR_PATH ||
    path === TOOL_CATALOG_ARTIFACT_PATH
  );
}

export interface ToolCatalogGeneratorResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunToolCatalogGenerator = (repoPath: string) => Promise<ToolCatalogGeneratorResult>;

export interface ToolCatalogRegeneratorContext {
  runGit: RunGit;
  repoPath: string;
  log: (message: string) => void;
}

export type ToolCatalogRegenerator = (context: ToolCatalogRegeneratorContext) => Promise<void>;

/**
 * Run the catalog writer in a bounded child. The generator cold-imports the full
 * registry, so a peer's half-written tool module can make that import hang or
 * fail; neither condition may wedge the fleet-wide git-sync commit path.
 */
const defaultRunToolCatalogGenerator: RunToolCatalogGenerator = (repoPath) =>
  new Promise((resolve) => {
    const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_TOOL_CATALOG_TIMEOUT_MS', 60_000);
    const child = spawn(join(repoPath, 'node_modules', '.bin', 'tsx'), [TOOL_CATALOG_GENERATOR_PATH], {
      cwd: repoPath,
      env: process.env,
    });
    const out = collectChildOutput(child);
    let settled = false;
    let timedOut = false;
    let closeFallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}tool-catalog regeneration timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // A broken child implementation must not defeat the timeout by never
      // emitting close after the kill.
      closeFallback = setTimeout(() => finish(-1), 5_000);
      closeFallback.unref?.();
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
  });

/**
 * Regenerate the tracked tool catalog immediately before the superproject
 * commit when a dirty source path can affect it. This is intentionally
 * FAIL-SOFT: status/tracking checks, generator throws, nonzero exits, and
 * timeouts are logged and return normally so a transient registry refactor can
 * never stop git-sync from committing the rest of the shared tree.
 */
export async function regenerateToolCatalogBeforeCommit(
  context: ToolCatalogRegeneratorContext,
  runGenerator: RunToolCatalogGenerator = defaultRunToolCatalogGenerator,
): Promise<void> {
  const { runGit, repoPath, log } = context;
  try {
    const status = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
    if (status.code !== 0) {
      log(`[git-sync] ${repoPath}: could not inspect dirty paths for tool-catalog regeneration — skipping fail-soft`);
      return;
    }
    const affected = parseDirtyPaths(status.stdout).filter(affectsToolCatalog);
    if (affected.length === 0) return;

    // Do not run this papercusp-specific generator in arbitrary repositories
    // that merely happen to contain a similarly named dirty path.
    const tracked = await runGit(['ls-files', '--', ...TOOL_CATALOG_TRACKED_PATHS], repoPath);
    const trackedPaths = new Set(
      tracked.stdout
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
    );
    if (tracked.code !== 0 || !TOOL_CATALOG_TRACKED_PATHS.every((path) => trackedPaths.has(path))) return;

    const artifactPath = join(repoPath, TOOL_CATALOG_ARTIFACT_PATH);
    let original: string | null = null;
    try {
      original = await readFile(artifactPath, 'utf8');
    } catch {
      /* missing artifact is restored to missing if the writer fails */
    }

    let result: ToolCatalogGeneratorResult;
    try {
      result = await runGenerator(repoPath);
    } catch (e) {
      result = { code: -1, stdout: '', stderr: String(e) };
    }
    if (result.code !== 0) {
      // A synchronous write can truncate before throwing. Restore the pre-run
      // artifact so a failed repair never turns a merely stale catalog into a
      // corrupt one that the catch-all commit could publish.
      try {
        if (original == null) await unlink(artifactPath).catch(() => {});
        else await writeFile(artifactPath, original, 'utf8');
      } catch (e) {
        log(`[git-sync] ${repoPath}: failed to restore tool catalog after generator failure: ${String(e)}`);
      }
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
      log(
        `[git-sync] ${repoPath}: tool-catalog regeneration failed (${detail}) — continuing with the commit fail-soft; the downstream catalog check remains the detector`,
      );
      return;
    }
    log(
      `[git-sync] ${repoPath}: regenerated ${TOOL_CATALOG_ARTIFACT_PATH} before commit (${affected.length} catalog-affecting dirty path(s))`,
    );
  } catch (e) {
    log(
      `[git-sync] ${repoPath}: tool-catalog pre-commit repair threw (${String(e)}) — continuing with the commit fail-soft`,
    );
  }
}

const DECLARATIONS_GENERATOR_PATH = 'scripts/gen-declarations.ts';
const DECLARATIONS_CONFIG_PATH = 'tsconfig.declarations.json';
const DECLARATIONS_PACKAGE_INPUTS = ['package.json', 'package-lock.json'] as const;
const DECLARATIONS_TRACKED_PATHS = [DECLARATIONS_GENERATOR_PATH, DECLARATIONS_CONFIG_PATH] as const;

interface DeclarationPair {
  source: string;
  artifact: string;
}

/** Map either half of an `.mjs` → generated `.d.mts` pair to both paths. */
export function generatedDeclarationPair(path: string): DeclarationPair | null {
  if (path.endsWith('.mjs')) return { source: path, artifact: path.replace(/\.mjs$/, '.d.mts') };
  if (path.endsWith('.d.mts')) return { source: path.replace(/\.d\.mts$/, '.mjs'), artifact: path };
  return null;
}

/** Inputs whose dirty working-tree bytes may change the tracked declaration projection. */
export function affectsGeneratedDeclarations(path: string): boolean {
  return (
    path === DECLARATIONS_GENERATOR_PATH ||
    path === DECLARATIONS_CONFIG_PATH ||
    DECLARATIONS_PACKAGE_INPUTS.includes(path as (typeof DECLARATIONS_PACKAGE_INPUTS)[number]) ||
    generatedDeclarationPair(path) !== null
  );
}

export interface GeneratedDeclarationsGeneratorResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunGeneratedDeclarationsGenerator = (repoPath: string) => Promise<GeneratedDeclarationsGeneratorResult>;

export type GeneratedDeclarationsRepairResult =
  | { status: 'not-needed'; atomicPaths: string[] }
  | { status: 'regenerated'; atomicPaths: string[] }
  /** The status census was unavailable, so only declaration-related paths are deferred. */
  | { status: 'deferred'; atomicPaths: string[]; detail: string }
  | { status: 'blocked'; atomicPaths: string[]; detail: string };

export type GeneratedDeclarationsRegenerator = (
  context: ToolCatalogRegeneratorContext,
) => Promise<GeneratedDeclarationsRepairResult>;

/**
 * Run declaration emit in a bounded child. Unlike the tool-catalog repair, a
 * failure is returned to the caller as `blocked`: committing the source without
 * its generated declaration is the exact torn-snapshot class this seam closes.
 */
const defaultRunGeneratedDeclarationsGenerator: RunGeneratedDeclarationsGenerator = (repoPath) =>
  new Promise((resolve) => {
    const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_DECLARATIONS_TIMEOUT_MS', 120_000);
    const child = spawn(join(repoPath, 'node_modules', '.bin', 'tsx'), [DECLARATIONS_GENERATOR_PATH], {
      cwd: repoPath,
      env: process.env,
    });
    const out = collectChildOutput(child);
    let settled = false;
    let timedOut = false;
    let closeFallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}declaration regeneration timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      closeFallback = setTimeout(() => finish(-1), 5_000);
      closeFallback.unref?.();
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
  });

/** A status read is a cheap census, but it can still lose a race with the
 * sidecar/admission layer. Retry that read briefly before deciding whether the
 * declaration repair is blocked; a one-off infrastructure miss must not turn
 * into a whole-tree commit wedge. */
export const DECLARATION_STATUS_MAX_RETRIES = 3;
export const DECLARATION_STATUS_RETRY_BASE_DELAY_MS = 100;

type DeclarationStatusRead = { paths: string[] } | { detail: string };

async function readDeclarationStatus(
  runGit: RunGit,
  repoPath: string,
  log: (message: string) => void,
  phase: 'before' | 'after',
): Promise<DeclarationStatusRead> {
  let detail = 'unknown git status failure';
  for (let attempt = 0; attempt <= DECLARATION_STATUS_MAX_RETRIES; attempt++) {
    try {
      const result = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
      if (result.code === 0) return { paths: parseDirtyPaths(result.stdout) };
      detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
    } catch (error) {
      detail = String(error).slice(0, 300);
    }
    if (attempt === DECLARATION_STATUS_MAX_RETRIES) break;
    const retry = attempt + 1;
    const delayMs = DECLARATION_STATUS_RETRY_BASE_DELAY_MS * 2 ** attempt;
    log(
      `[git-sync] ${repoPath}: declaration ${phase}-status read failed (${detail}) — ` +
        `retrying after ${delayMs}ms (attempt ${retry}/${DECLARATION_STATUS_MAX_RETRIES})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { detail: `could not inspect dirty paths ${phase} declaration regeneration: ${detail}` };
}

const declarationTrackedInventoryArgs = [
  'ls-files',
  '--',
  ...DECLARATIONS_TRACKED_PATHS,
  ...DECLARATIONS_PACKAGE_INPUTS,
  '*.mjs',
  '*.d.mts',
];

function declarationAtomicPathsFromTrackedPaths(trackedPaths: ReadonlySet<string>): string[] {
  const atomicPaths = new Set<string>();
  for (const path of [...DECLARATIONS_TRACKED_PATHS, ...DECLARATIONS_PACKAGE_INPUTS]) {
    if (trackedPaths.has(path)) atomicPaths.add(path);
  }
  for (const path of trackedPaths) {
    const pair = generatedDeclarationPair(path);
    if (pair && trackedPaths.has(pair.source) && trackedPaths.has(pair.artifact)) {
      atomicPaths.add(pair.source);
      atomicPaths.add(pair.artifact);
    }
  }
  return [...atomicPaths].sort();
}

/**
 * Regenerate tracked declaration pairs before git-sync snapshots the tree.
 *
 * The tracked-pair check keeps this Papercusp-specific writer out of arbitrary
 * repositories and avoids treating hand-written `.d.mts` siblings as generated.
 * `atomicPaths` is consumed by the attribution layer: every affected source and
 * artifact is withheld from per-agent commits and lands together in the single
 * catch-all commit. A failed emit is fail-CLOSED for the superproject commit;
 * publishing a stale pair and relying on the gate to red later is not recovery.
 */
export async function regenerateGeneratedDeclarationsBeforeCommit(
  context: ToolCatalogRegeneratorContext,
  runGenerator: RunGeneratedDeclarationsGenerator = defaultRunGeneratedDeclarationsGenerator,
): Promise<GeneratedDeclarationsRepairResult> {
  const { runGit, repoPath, log } = context;
  try {
    const status = await readDeclarationStatus(runGit, repoPath, log, 'before');
    if ('detail' in status) {
      // We cannot safely infer which pair is dirty, but we can still inventory
      // the enrolled declaration surface. Defer those paths only and let the
      // rest of the tree commit; if even the inventory is unavailable, retain
      // the old fail-closed behavior because there is no safe exclusion set.
      let tracked: GeneratedDeclarationsGeneratorResult;
      try {
        tracked = await runGit(declarationTrackedInventoryArgs, repoPath);
      } catch (error) {
        return { status: 'blocked', atomicPaths: [], detail: `${status.detail}; ${String(error).slice(0, 300)}` };
      }
      if (tracked.code !== 0) {
        const inventoryDetail = (tracked.stderr || tracked.stdout || `exit ${tracked.code}`).trim().slice(0, 300);
        return {
          status: 'blocked',
          atomicPaths: [],
          detail: `${status.detail}; declaration inventory failed: ${inventoryDetail}`,
        };
      }
      const trackedPaths = new Set(
        tracked.stdout
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
      );
      if (!DECLARATIONS_TRACKED_PATHS.every((path) => trackedPaths.has(path))) {
        return { status: 'not-needed', atomicPaths: [] };
      }
      const atomicPaths = declarationAtomicPathsFromTrackedPaths(trackedPaths);
      log(
        `[git-sync] ${repoPath}: declaration ${status.detail} — deferring ${atomicPaths.length} ` +
          'declaration-related path(s) while continuing with the unlocked tree',
      );
      return { status: 'deferred', atomicPaths, detail: status.detail };
    }
    const dirtyBefore = status.paths;
    if (!dirtyBefore.some(affectsGeneratedDeclarations)) return { status: 'not-needed', atomicPaths: [] };

    // One bounded inventory read gives us both canonical-surface proof and the
    // enrolled source/artifact pairs. Git's `*.mjs` pathspec recurses here.
    const tracked = await runGit(declarationTrackedInventoryArgs, repoPath);
    const trackedPaths = new Set(
      tracked.stdout
        .split('\n')
        .map((path) => path.trim())
        .filter(Boolean),
    );
    if (tracked.code !== 0 || !DECLARATIONS_TRACKED_PATHS.every((path) => trackedPaths.has(path))) {
      return { status: 'not-needed', atomicPaths: [] };
    }

    const isTrackedPair = (pair: DeclarationPair): boolean =>
      trackedPaths.has(pair.source) && trackedPaths.has(pair.artifact);
    const hasMetaInput = dirtyBefore.some(
      (path) =>
        path === DECLARATIONS_GENERATOR_PATH ||
        path === DECLARATIONS_CONFIG_PATH ||
        DECLARATIONS_PACKAGE_INPUTS.includes(path as (typeof DECLARATIONS_PACKAGE_INPUTS)[number]),
    );
    const affectedPairs = dirtyBefore
      .map(generatedDeclarationPair)
      .filter((pair): pair is DeclarationPair => pair !== null && isTrackedPair(pair));
    if (!hasMetaInput && affectedPairs.length === 0) return { status: 'not-needed', atomicPaths: [] };

    let result: GeneratedDeclarationsGeneratorResult;
    try {
      result = await runGenerator(repoPath);
    } catch (error) {
      result = { code: -1, stdout: '', stderr: String(error) };
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
      log(
        `[git-sync] ${repoPath}: declaration regeneration failed (${detail}) — deferring the superproject commit so source and generated artifacts cannot split`,
      );
      return {
        status: 'blocked',
        atomicPaths: [...new Set(affectedPairs.flatMap((pair) => [pair.source, pair.artifact]))],
        detail,
      };
    }

    // The writer may dirty several outputs after a config/compiler-input change.
    // Re-read status and expand every enrolled dirty half back to its complete pair.
    const after = await readDeclarationStatus(runGit, repoPath, log, 'after');
    if ('detail' in after) {
      const atomicPaths = declarationAtomicPathsFromTrackedPaths(trackedPaths);
      log(
        `[git-sync] ${repoPath}: ${after.detail} — deferring ${atomicPaths.length} ` +
          'declaration-related path(s) while continuing with the unlocked tree',
      );
      return { status: 'deferred', atomicPaths, detail: after.detail };
    }
    const dirtyAfter = after.paths;
    const atomicPaths = new Set<string>();
    for (const path of dirtyAfter) {
      const pair = generatedDeclarationPair(path);
      if (pair && isTrackedPair(pair)) {
        atomicPaths.add(pair.source);
        atomicPaths.add(pair.artifact);
      } else if (
        path === DECLARATIONS_GENERATOR_PATH ||
        path === DECLARATIONS_CONFIG_PATH ||
        DECLARATIONS_PACKAGE_INPUTS.includes(path as (typeof DECLARATIONS_PACKAGE_INPUTS)[number])
      ) {
        atomicPaths.add(path);
      }
    }
    log(
      `[git-sync] ${repoPath}: regenerated tracked declarations before commit (${affectedPairs.length} dirty pair(s), ${atomicPaths.size} atomic path(s))`,
    );
    return { status: 'regenerated', atomicPaths: [...atomicPaths] };
  } catch (error) {
    const detail = String(error).slice(0, 300);
    log(
      `[git-sync] ${repoPath}: declaration pre-commit repair threw (${detail}) — deferring the superproject commit fail-closed`,
    );
    return { status: 'blocked', atomicPaths: [], detail };
  }
}

const TOOL_ROUTING_GENERATOR_PATH = 'scripts/gen-tool-routing.ts';
const TOOL_ROUTING_TABLE_PATH = 'packages/operator-core/lib/bash-substitution/routing-table.ts';
const TOOL_ROUTING_PAIRS_PREFIX = 'packages/operator-core/lib/bash-substitution/pairs/';
const TOOL_ROUTING_TRACKED_PATHS = [TOOL_ROUTING_GENERATOR_PATH, TOOL_ROUTING_TABLE_PATH] as const;

/** The exact source surface that can change the generated tool-routing projection. */
export function affectsToolRouting(path: string): boolean {
  return (
    (path.startsWith(TOOL_ROUTING_PAIRS_PREFIX) && path.endsWith('.ts') && !path.endsWith('.test.ts')) ||
    path === TOOL_ROUTING_TABLE_PATH ||
    path === TOOL_ROUTING_GENERATOR_PATH
  );
}

export interface ToolRoutingCheckResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunToolRoutingCheck = (repoPath: string) => Promise<ToolRoutingCheckResult>;

export interface ToolRoutingCheckerContext {
  runGit: RunGit;
  repoPath: string;
  log: (message: string) => void;
}

export type ToolRoutingChecker = (context: ToolRoutingCheckerContext) => Promise<void>;

/**
 * Run the generated routing check in a bounded child. The generator reads the
 * canonical doc-part store, so a broken DB/client or a half-written peer module
 * must be observable without allowing it to wedge the fleet-wide git-sync pass.
 */
const defaultRunToolRoutingCheck: RunToolRoutingCheck = (repoPath) =>
  new Promise((resolve) => {
    const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_TOOL_ROUTING_TIMEOUT_MS', 60_000);
    const child = spawn(join(repoPath, 'node_modules', '.bin', 'tsx'), [TOOL_ROUTING_GENERATOR_PATH, '--check'], {
      cwd: repoPath,
      env: process.env,
    });
    const out = collectChildOutput(child);
    let settled = false;
    let timedOut = false;
    let closeFallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}tool-routing check timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // A broken child implementation must not defeat the timeout by never
      // emitting close after the kill.
      closeFallback = setTimeout(() => finish(-1), 5_000);
      closeFallback.unref?.();
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
  });

/**
 * Run the generated tool-routing drift check immediately before the
 * superproject commit when a routing source is dirty. This is intentionally
 * FAIL-SOFT: status/tracking checks, checker errors, nonzero exits, and timeouts
 * are logged and return normally so a stale generated projection cannot wedge
 * git-sync's commit of the rest of the shared tree.
 */
export async function checkToolRoutingBeforeCommit(
  context: ToolRoutingCheckerContext,
  runCheck: RunToolRoutingCheck = defaultRunToolRoutingCheck,
): Promise<void> {
  const { runGit, repoPath, log } = context;
  try {
    const status = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
    if (status.code !== 0) {
      log(`[git-sync] ${repoPath}: could not inspect dirty paths for tool-routing check — skipping fail-soft`);
      return;
    }
    const affected = parseDirtyPaths(status.stdout).filter(affectsToolRouting);
    if (affected.length === 0) return;

    // Do not run this Papercusp-specific check in arbitrary repositories that
    // merely happen to contain one routing-shaped dirty path.
    const tracked = await runGit(['ls-files', '--', ...TOOL_ROUTING_TRACKED_PATHS], repoPath);
    const trackedPaths = new Set(
      tracked.stdout
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
    );
    if (tracked.code !== 0 || !TOOL_ROUTING_TRACKED_PATHS.every((path) => trackedPaths.has(path))) return;

    let result: ToolRoutingCheckResult;
    try {
      result = await runCheck(repoPath);
    } catch (e) {
      result = { code: -1, stdout: '', stderr: String(e) };
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
      log(
        `[git-sync] ${repoPath}: generated tool-routing check failed (${detail}) — continuing with the commit fail-soft; run \`npm run gen:tool-routing\` to repair`,
      );
      return;
    }
    log(
      `[git-sync] ${repoPath}: generated tool-routing check passed before commit (${affected.length} routing-affecting dirty path(s))`,
    );
  } catch (e) {
    log(
      `[git-sync] ${repoPath}: tool-routing pre-commit check threw (${String(e)}) — continuing with the commit fail-soft`,
    );
  }
}

const GITHUB_HTTPS_INSTEAD_OF_ARGS = ['-c', 'url.https://github.com/.insteadOf=git@github.com:'] as const;

const GITHUB_SSH_HOST_RE = String.raw`github\.com(?:-[A-Za-z0-9_-]+)?`;

/** Process-local insteadOf prefix for canonical GitHub SSH URLs and simple
 * per-account SSH-config aliases such as `github.com-git-graph`. A dot is not
 * allowed in the alias suffix, so a lookalike DNS name cannot be canonicalized
 * to GitHub by this recovery path. */
const githubSshInsteadOfPrefix = (url: string): string | null => {
  const trimmed = url.trim();
  const scp = new RegExp(`^(git@${GITHUB_SSH_HOST_RE}:)`, 'i').exec(trimmed);
  if (scp?.[1]) return scp[1];
  const ssh = new RegExp(`^(ssh://git@${GITHUB_SSH_HOST_RE}/)`, 'i').exec(trimmed);
  return ssh?.[1] ?? null;
};

/**
 * The one SSH-auth failure for which git-sync has an equivalent configured
 * credential plane to try. Keep this exact: network failures, repository
 * authorization failures, and non-GitHub SSH hosts need their original error.
 */
export const isGitHubSshPublicKeyFailure = (result: { stdout: string; stderr: string }): boolean =>
  new RegExp(`git@${GITHUB_SSH_HOST_RE}:\\s*Permission denied \\(publickey\\)\\.?`, 'i').test(
    `${result.stdout}\n${result.stderr}`,
  );

/** A missing local SSH-config alias for a GitHub account is a transport-plane
 * failure with the same safe HTTPS equivalent as a missing SSH key. */
export const isGitHubSshAliasResolutionFailure = (result: { stdout: string; stderr: string }): boolean =>
  new RegExp(`ssh:\\s*Could not resolve hostname github\\.com-[A-Za-z0-9_-]+:`, 'i').test(
    `${result.stdout}\n${result.stderr}`,
  );

/** GitHub can authenticate an SSH key successfully and still reject every write because the
 *  account behind that key has no verified email. The configured HTTPS credential may belong to
 *  a different, write-capable automation account, so this is the same credential-plane failure
 *  class as a missing SSH key — but only after the configured remote is proven to be GitHub SSH. */
export const isGitHubSshEmailVerificationFailure = (result: { stdout: string; stderr: string }): boolean =>
  /(?:remote:\s*)?You must verify your email address\.?/i.test(`${result.stdout}\n${result.stderr}`);

const isGitHubSshRemoteUrl = (url: string): boolean => githubSshInsteadOfPrefix(url) !== null;

/**
 * Retry one GitHub fetch/push through the existing HTTPS credential helper when
 * SSH has no usable public key. The -c override is process-local: canonical
 * remotes and .gitmodules remain untouched, and no credential is put in argv.
 */
const runNetworkGitWithGitHubHttpsFallback = async (
  runGit: RunGit,
  args: string[],
  cwd: string,
  log: (message: string) => void,
): ReturnType<RunGit> => {
  const first = await runGit(args, cwd);
  const command = gitSubcommand(args);
  const publicKeyFailure = isGitHubSshPublicKeyFailure(first);
  const emailVerificationFailure = isGitHubSshEmailVerificationFailure(first);
  const aliasResolutionFailure = isGitHubSshAliasResolutionFailure(first);
  if (
    first.code === 0 ||
    (command !== 'fetch' && command !== 'push') ||
    (!publicKeyFailure && !emailVerificationFailure && !aliasResolutionFailure)
  ) {
    return first;
  }

  let insteadOfArgs: readonly string[] = GITHUB_HTTPS_INSTEAD_OF_ARGS;
  // Unlike the canonical public-key error, GitHub's email-policy response and an
  // unresolved account alias do not prove the configured remote URL shape. Read
  // the remote and derive its exact process-local prefix; an HTTPS, non-GitHub,
  // or dotted lookalike host must retain its original failure.
  if (emailVerificationFailure || aliasResolutionFailure) {
    const remote = args[1];
    if (!remote) return first;
    const remoteUrl = isGitHubSshRemoteUrl(remote)
      ? remote
      : (await runGit(['remote', 'get-url', remote], cwd)).stdout.trim();
    const insteadOfPrefix = githubSshInsteadOfPrefix(remoteUrl);
    if (!insteadOfPrefix) return first;
    insteadOfArgs = ['-c', `url.https://github.com/.insteadOf=${insteadOfPrefix}`];
  }

  log(
    `[git-sync] ${cwd}: GitHub SSH ${
      publicKeyFailure
        ? 'publickey authentication failed'
        : aliasResolutionFailure
          ? 'account host alias could not resolve'
          : 'account requires email verification'
    } during ${command}; retrying once through configured HTTPS credentials`,
  );
  return runGit([...insteadOfArgs, ...args], cwd);
};

/** GitHub hard-rejects blobs ≥100MB (pre-receive) — a committed oversized blob makes
 *  the whole unpushed range PERMANENTLY unpushable (EI-18: 10.4GB of Rust target/
 *  artifacts wedged the push for 20h). Stay safely under. */
export const DEFAULT_MAX_BLOB_BYTES = 95 * 1024 * 1024;
/**
 * WI-5738: cap on the CUMULATIVE size of one auto-commit's dirty set. Set well
 * under the publish guard's DEFAULT_MAX_PUBLISH_TOTAL_BYTES (500 MB) so the
 * commit-side gate — where the response is a cheap exclusion — always fires
 * BEFORE the publish-side one, where the only response was a terminal refusal.
 * The headroom also absorbs several commits accumulating between publish ticks.
 */
export const DEFAULT_MAX_COMMIT_TOTAL_BYTES = 250 * 1024 * 1024;

export interface GitSyncConfig {
  /** Push the SUPERPROJECT to its origin after committing/merging (default true).
   *  Does NOT control submodule pushes — see `pushSubmoduleOrigins` (EI-18689553108460319:
   *  these used to share one flag, so a bridged/p2p-only hive setting this false to keep
   *  the bridge writer the sole pusher of the hive's own canonical refs silently ALSO
   *  stranded every submodule's commits — unrelated vendored libraries with their own
   *  GitHub origins that nothing else ever pushes). */
  push?: boolean;
  /** Sync submodules too (default true). When true, ALL submodules are synced
   *  recursively — discovery is dynamic, never a fixed list. */
  pushSubmodules?: boolean;
  /** Push SUBMODULE repos to THEIR OWN origins (defaults to `push`) — independent of `push`,
   *  which now controls the superproject only (EI-18689553108460319). A bridged/p2p-only
   *  hive's `push:false` exists so the bridge writer stays the sole pusher of the hive's
   *  own canonical superproject refs (github-bridge-hive-egress P-003/S-1); that rationale
   *  does not extend to submodules, each an independent GitHub repo the bridge never
   *  touches. Non-legacy callers also require owning-hive authorization at each push. */
  pushSubmoduleOrigins?: boolean;
  /** Reconcile the SUPERPROJECT worktree with its configured Git remote
   *  (fetch + merge) before an optional push. Default true.
   *
   *  Non-legacy P2P hives set this false: their dedicated GitHub-ingress leg
   *  imports GitHub heads into the bare P2P store and their worktree-bridge leg
   *  advances the checkout from the admitted canonical staging ref. Running a
   *  second direct origin merge here bypasses that admission path and makes an
   *  installer seed look perpetually unconverted when the two histories are
   *  intentionally unrelated. Submodule origin syncing remains independent. */
  reconcileSuperprojectOrigin?: boolean;
  /**
   * Reconcile a fully represented release `main` commit into a commit-only
   * `staging` worktree without importing any GitHub content (default false).
   *
   * Bridged hives deliberately disable `reconcileSuperprojectOrigin`: GitHub
   * ingress/admission and the P2P worktree bridge own content flow. Frozen
   * repair promotion can nevertheless leave `main` as a sibling whose exact
   * tree changes are already present on staging. When this explicit knob is
   * enabled, git-sync may record only that proven ancestry with an `ours`
   * merge. The helper declines on an unrelated lineage or any differing tree
   * entry, so this never bypasses admission for new content.
   */
  bridgeContainedReleaseMainOnCommitOnly?: boolean;
  /** Branch to sync when a repo is on a branch / for the superproject (default 'main'). */
  branch?: string;
  /** Remote name (default 'origin'). */
  remote?: string;
  /** Commit subject (a default is used otherwise). */
  message?: string;
  /** Dirty files larger than this are EXCLUDED from the auto-commit and reported
   *  (`oversized` on the outcome) instead of wedging the push forever
   *  (default DEFAULT_MAX_BLOB_BYTES). */
  maxBlobBytes?: number;
  /** WI-5738: dirty files are excluded largest-first once the CUMULATIVE dirty
   *  set exceeds this (default DEFAULT_MAX_COMMIT_TOTAL_BYTES) — the gate that
   *  catches a bulk accident whose individual files are all under maxBlobBytes. */
  maxCommitTotalBytes?: number;
}

/** One (sub)repo that hit a merge conflict during a pass. */
export interface RepoConflict {
  /** Which repo conflicted: 'superproject' or a submodule path (repo-relative). */
  scope: string;
  conflictedFiles: string[];
}
/** One (sub)repo that errored (e.g. a push that wasn't a recoverable non-ff). */
export interface RepoError {
  scope: string;
  message: string;
}
/** A dirty file excluded from the auto-commit because it exceeds maxBlobBytes. */
export interface OversizedFile {
  path: string;
  sizeBytes: number;
  /**
   * Which byte guard caused this file to be left out of the commit. Per-file
   * exclusions predate this field and intentionally omit it; absence means the
   * per-file guard for backwards-compatible result shapes. The cumulative guard
   * sets `cumulative-limit` so alarms do not misattribute a small file to GitHub's
   * individual-blob ceiling.
   */
  exclusionReason?: 'cumulative-limit';
}
/** An oversized file, qualified by which repo it sits in. */
export interface ScopedOversized extends OversizedFile {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}
/** A content-guard offender (EI-438), qualified by which repo it sits in. The
 *  action layer escalates these + dispatches a content-fixer (git-sync-action). */
export interface ScopedContentError extends ContentOffender {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}

/**
 * EI-20402093158205519: a submodule that is POPULATED on disk and holds uncommitted
 * TRACKED changes, but is absent from `.git/config` (`git submodule init` never ran).
 * `git submodule status` marks it '-', discovery skips it, and git-sync therefore never
 * visits the repo at all — so the edits are invisible to every tick, forever, with no
 * error anywhere. Measured on the sidestage hive 2026-08-14: 7 of 8 submodules '-'-flagged
 * but fully populated; discovery returned 1 path; 3 tracked files sat stranded across two
 * repos while the routine reported a clean 'synced' every tick.
 *
 * This is NOT an error the pass can fix, and deliberately does NOT make the pass
 * `status:'error'` — that would defer the superproject push on EVERY tick and wedge the
 * whole hive over a condition git-sync must not auto-resolve (registering a deliberately
 * pinned worktree would fetch/merge/push it and UNPIN it). It rides its own escalation
 * row instead: visible and queryable, non-blocking, self-clearing.
 */
export interface StrandedSubmodule {
  /** Repo-relative submodule path, e.g. 'libs/papergrid'. */
  path: string;
  /** Count of TRACKED modified files. Untracked scratch (.vitest-tmp/ &c.) is excluded
   *  on purpose — counting it would cry wolf on every tick a test run is in flight. */
  trackedFiles: number;
  /** The tracked porcelain paths, capped for the escalation body. */
  files: string[];
}

/** A live edit lock that must be preserved as structured, actionable provenance. */
export interface GitSyncLockHolding {
  path: string;
  owner: string;
  intent: string;
  /** The active work-item/goal associated with this lock, when stamped by locks:acquire. */
  goalRef?: string;
}

/** A dirty path excluded from this pass because a live editor holds its lock. */
export interface GitSyncSkippedPath {
  scope: string;
  path: string;
  owner: string;
  intent: string;
}

/** True when two repo-relative paths overlap as a file or directory lock. */
function gitSyncPathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// P-009 / WI-10002596: moved to ./live-lock-coordinates (pure, dependency-free) so that
// consumers mocking this module still exercise the real coordinate mapping.
export { mapLiveLockHoldingsForRepo, nestedInstallRepoPrefix } from './live-lock-coordinates';

/**
 * Expand a live-lock exclusion to the rest of the same edit cohort.
 *
 * A live file lock is a per-file lease, but an agent's edit is often a coherent
 * multi-file change (source + test, or migration + code). The automatic hook can
 * release those leases at different times, so excluding only the rows visible in
 * this tick lets an already-unlocked sibling reach HEAD alone. The edit ledger
 * attribution map is the durable bridge to that sibling: it records each granted
 * path with the work-item active at edit time.
 *
 * Only a holding with a non-empty goalRef seeds a cohort. A legacy/null goal is
 * intentionally left at the old per-path behavior: grouping unknown work under an
 * owner would conflate unrelated edits. The caller still always protects every
 * directly live-held path, whether or not attribution is available.
 *
 * Pure and exported so the TTL-skew regression is testable without a live lock DB or
 * a git subprocess. `paths` contains only dirty paths (plus a directly held path
 * when its lock names a directory); clean files do not need a pathspec exclusion.
 */
export function expandAtomicLiveLockExclusions(
  dirtyFiles: readonly string[],
  holdings: readonly GitSyncLockHolding[],
  attribution?: ReadonlyMap<string, FileAttribution>,
): { paths: string[]; groups: Array<{ key: string; owner: string; goalRef: string; paths: string[] }> } {
  const dirty = [...new Set(dirtyFiles.map((path) => path.trim()).filter(Boolean))];
  const groups = new Map<string, { owner: string; goalRef: string; paths: Set<string> }>();
  const directPaths = new Set<string>();

  for (const holding of holdings) {
    const path = holding.path.trim();
    if (!path || !dirty.some((file) => gitSyncPathsOverlap(file, path))) continue;
    directPaths.add(path);
    const owner = holding.owner.trim();
    const goalRef = holding.goalRef?.trim() ?? '';
    if (!owner || !goalRef) continue;
    const key = JSON.stringify([owner, goalRef]);
    let group = groups.get(key);
    if (!group) {
      group = { owner, goalRef, paths: new Set<string>() };
      groups.set(key, group);
    }
    group.paths.add(path);
  }

  if (groups.size > 0 && attribution) {
    for (const file of dirty) {
      const a = attribution.get(file);
      if (!a || !a.agent.trim()) continue;
      for (const workItem of a.workItems ?? []) {
        const key = JSON.stringify([a.agent.trim(), workItem.trim()]);
        const group = groups.get(key);
        if (group && workItem.trim()) group.paths.add(file);
      }
    }
  }

  const paths = new Set(directPaths);
  const outputGroups: Array<{ key: string; owner: string; goalRef: string; paths: string[] }> = [];
  for (const [key, group] of groups) {
    const pathsForGroup = [...group.paths].sort();
    for (const path of pathsForGroup) paths.add(path);
    outputGroups.push({ key, owner: group.owner, goalRef: group.goalRef, paths: pathsForGroup });
  }
  outputGroups.sort((a, b) => a.key.localeCompare(b.key));
  return { paths: [...paths].sort(), groups: outputGroups };
}

const NPM_MANIFEST_BASENAMES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);

/** True for an npm manifest or lockfile this repository tracks (never one inside node_modules). */
export function isNpmManifestPath(path: string): boolean {
  const segments = path.trim().split('/');
  const base = segments[segments.length - 1] ?? '';
  return NPM_MANIFEST_BASENAMES.has(base) && !segments.includes('node_modules');
}

/**
 * EI-24649116564770033 / WI-10004077: npm manifests in one repository are ONE unit.
 *
 * A dependency change touches a workspace `package.json`, usually the root `package.json`,
 * and the single root lockfile, which records every workspace at once. When any dirty
 * manifest is withheld this pass (a live lock, an oversized or content-guard exclusion),
 * committing the others lands half the change: observed, operator-core's new dependency
 * reached HEAD without its root workspace entry or lockfile, so a clean `npm ci` of that
 * commit fails. So a withheld dirty manifest withholds every other dirty manifest in the
 * same repository until they can land together.
 *
 * Returns only the ADDITIONAL paths to withhold, plus the withheld manifests that caused it.
 * A lock on a CLEAN manifest triggers nothing: no half of any change is being held back.
 */
export function expandNpmManifestClosure(
  dirtyFiles: readonly string[],
  excludedPaths: readonly string[],
): { paths: string[]; triggers: string[] } {
  const excluded = excludedPaths.map((path) => path.trim()).filter(Boolean);
  const dirtyManifests = [...new Set(dirtyFiles.map((path) => path.trim()).filter(isNpmManifestPath))].sort();
  const isExcluded = (file: string) => excluded.some((path) => gitSyncPathsOverlap(file, path));
  const triggers = dirtyManifests.filter(isExcluded);
  if (triggers.length === 0) return { paths: [], triggers: [] };
  return { paths: dirtyManifests.filter((file) => !isExcluded(file)), triggers };
}

/**
 * The aggregate result of one whole-repo pass. `pushed`/`merged` name the scopes
 * ('superproject' or submodule paths) that were pushed to / merged from origin, so
 * a caller can report exactly what moved. A pass NO LONGER stops at the first
 * conflict: it reconciles every submodule it can, COLLECTS conflicts/errors, and
 * only defers the superproject (see runGitSync). `status` is the worst outcome:
 * any conflict → 'conflict', else any error → 'error', else 'synced'/'nothing'.
 */
export type GitSyncOutcome = {
  /** Number of dirty paths measured across every repo visited by this pass. */
  dirtyPathCount: number;
  /** Number of local commits created across every repo during this pass. */
  committedCount: number;
  /** Dirty files excluded from this pass's auto-commits for exceeding maxBlobBytes
   *  (EI-18). Non-empty = someone must gitignore/remove them — this NEVER self-heals;
   *  the caller escalates. Present on every status ('nothing' included: an
   *  oversized-only dirty tree commits nothing but still reports). */
  oversized: ScopedOversized[];
  /**
   * Dirty files excluded by the cumulative commit-size guard. This is a
   * compatibility-preserving view of `oversized`: the latter still carries the
   * complete quarantine set used by the commit/escalation pipeline, while this
   * field lets metadata readers distinguish individually oversized blobs from
   * individually-valid files peeled to keep one commit under the total budget.
   */
  bulkExcluded?: ScopedOversized[];
  /** Dirty files EXCLUDED from this pass's auto-commits because a content detector
   *  flagged them (EI-438 — e.g. an .mdx that won't compile). Like `oversized`, the
   *  rest of the tree still commits (D-001 quarantine-don't-stall); the action layer
   *  escalates these + dispatches a content-fixer, which self-heals on a later tick.
   *  Present on every status. */
  contentErrors: ScopedContentError[];
  /** EI-20402093158205519: populated-but-unregistered submodules holding uncommitted
   *  tracked work this pass could not see (see StrandedSubmodule). Present on every
   *  status — a strand is orthogonal to whether the visible tree synced, and reporting
   *  it ONLY on failure is precisely the silence that let it run for hours: the pass
   *  that strands work is otherwise a perfectly clean 'synced'.
   *
   *  `null` means NOT MEASURED this pass (discovery failed, or a submodulePaths override
   *  bypassed it) and is deliberately distinct from `[]` (measured, nothing stranded).
   *  Collapsing the two would let an unmeasured pass retire a live warning — the exact
   *  failure mode this whole field exists to prevent, reintroduced one level up. The
   *  nullable type forces every consumer to decide which it is. */
  strandedSubmodules: StrandedSubmodule[] | null;
  /** Live-lock paths excluded this pass. Other unlocked paths may still sync. */
  skippedPaths?: GitSyncSkippedPath[];
  /**
   * Scopes whose fetch+merge stage completed successfully this pass, even when a
   * later push failed. This is distinct from `merged`: it proves that the merge
   * stage ran without a conflict and is safe for escalation clearing.
   */
  mergeCompleted?: string[];
} & (
  | { status: 'nothing' }
  | { status: 'synced'; headSha: string; pushed: string[]; merged: string[] }
  | { status: 'conflict'; conflicts: RepoConflict[]; errors: RepoError[]; pushed: string[]; merged: string[] }
  | { status: 'error'; errors: RepoError[]; pushed: string[]; merged: string[] }
  | { status: 'skipped-locked' }
);

/**
 * WI-1416: the seam a durable caller (git-sync-action inside a DBOS routineFire)
 * threads checkpointing through. Each pipeline PHASE (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) runs under `step(name, fn)` so the
 * workflow records one operation_output per phase: the executor reaper sees genuine
 * progress (function_id > 0), and a crashed/resumed fire REPLAYS completed phases
 * from their checkpoints instead of re-running them. Defaults to a passthrough
 * (unit tests / fireGitSyncNow outside any workflow).
 *
 * REPLAY SAFETY (the hard constraint): every phase is idempotent against a re-run —
 * a replayed commit finds a clean tree (`nothing to commit` is benign), a replayed
 * push is `Everything up-to-date`, a replayed merge re-fetches — so neither a DBOS
 * step retry nor a reaped-and-requeued fire can double-commit.
 */
export type GitSyncStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface RunGitSyncOpts {
  /**
   * Override the repo path (manual-fire pin + tests); else resolve via
   * `projectDirForSlug(slug)`. An explicit null is authoritative: the caller
   * already performed a scoped lookup and found no registered tree.
   */
  repoPath?: string | null;
  /** Inject the git runner (tests). */
  runGit?: RunGit;
  /** Authorize every push at the child-process boundary, including transport and
   * non-fast-forward retries. Non-legacy hive callers must supply the owner gate.
   * A refusal leaves local commits intact and is reported as a publication error. */
  beforePush?: (args: readonly string[], cwd: string) => Promise<void>;
  /** Called whenever the default git runner observes command progress. */
  onProgress?: () => void;
  /** Abort a default git child when the owning fire is declared stalled. */
  signal?: AbortSignal;
  /** WI-1416: run each pipeline phase as a checkpointed durable step (see
   *  GitSyncStepRunner). Default: plain passthrough execution. */
  step?: GitSyncStepRunner;
  config?: GitSyncConfig;
  /** Override submodule discovery (tests). Repo-relative paths. */
  submodulePaths?: string[];
  /**
   * Caller-supplied paths that must remain outside this tick's commits. Paths are
   * superproject-root-relative, matching the live roster/current_files contract;
   * submodule paths are mapped to that repo's relative coordinate space below.
   */
  excludePaths?: string[];
  /** Initial live lock holdings, including clean-held paths; replaced by a successful authoritative refresh. */
  liveLockHoldings?: GitSyncLockHolding[];
  /**
   * Re-read the live edit-lock plane immediately before staging each dirty repo.
   * The callback returns superproject-root-relative holdings; runGitSync maps
   * them into each repo's coordinate space before passing them to commitOneRepo.
   * A successful refresh replaces the initial holdings; explicit excludePaths
   * remain protected. A rejected refresh fails closed and prevents staging.
   */
  refreshLiveLockHoldings?: () => Promise<GitSyncLockHolding[]>;
  /** Override the content-guard detector registry (tests / future extension).
   *  Defaults to DEFAULT_CONTENT_DETECTORS (mdx + smart-quotes). Pass [] to disable. */
  contentDetectors?: ContentDetector[];
  /** EI-17: the deletion-import guard (kill-switch: FLAGS.GIT_SYNC_DELETION_GUARD).
   *  Default true. When false, a dirty deletion is never checked against surviving
   *  imports — byte-identical to pre-EI-17 behavior (the instant off-switch on this
   *  shared commit path, no deploy needed, mirroring GIT_SYNC_CONTENT_GUARD). */
  deletionGuard?: boolean;
  /** Read a repo-relative file's working-tree text for the content guard (tests).
   *  Defaults to fs read; null on any error. */
  readText?: (repoPath: string, relPath: string) => Promise<string | null>;
  /** Write a repo-relative file's working-tree text for deterministic content repairs (tests).
   *  Defaults to fs write; the content guard re-checks its CAS before calling this. */
  writeText?: (repoPath: string, relPath: string, text: string) => Promise<void>;
  log?: (m: string) => void;
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): the caller supplies the live roster of active
   *  agents + their declared files (built flag-gated from coord presence). When present, git-sync
   *  derives a per-repo attribution map and peels per-agent commits; when absent (flag OFF / no
   *  caller) commits are unchanged (today's single whole-tree commit). DERIVED, never authored. */
  loadRoster?: () => Promise<AttributionRosterEntry[]>;
  /** WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS, default ON): commit subjects are DIFF-derived
   *  (`sync(<areas>): <what> (<n> files, +A/-D)`) with the agent's intent line demoted to
   *  the commit body. false = the pre-WI-38594 subjects (intent line / message stem). */
  diffSubjects?: boolean;
  /** WI-EI-20224214315801764: override the age floor for crash-left `tmp_pack_*` files. */
  staleTempPackMs?: number;
  /** Test seam for proving whether a candidate temp pack is still open by a process.
   *  `null` means the state is unknown; unknown is always preserved. */
  isTempPackOpen?: (path: string) => Promise<boolean | null>;
  /** WI-39922: pre-superproject-commit repair for the tracked tool catalog.
   *  Defaults to the conditional, bounded, fail-soft regenerator above. */
  toolCatalogRegenerator?: ToolCatalogRegenerator;
  /** EI-21444216858331991: pre-superproject-commit declaration projection repair.
   *  Defaults to the conditional bounded writer above. Unlike the catalog repair,
   *  this is fail-closed because a torn source/declaration pair is a false gate red. */
  generatedDeclarationsRegenerator?: GeneratedDeclarationsRegenerator;
  /** EI-20428405431869483: pre-superproject-commit generated routing drift check.
   *  Defaults to the conditional, bounded, fail-soft checker above. */
  toolRoutingChecker?: ToolRoutingChecker;
  /** Fail-closed check for newly armed migration files before git-sync stages or commits them. */
  migrationReservationChecker?: MigrationReservationChecker;
}

/** Default content-guard file reader — the working-tree bytes that `add -A` would
 *  commit; null on any error (gone/binary/permission) so the guard fails open. */
const defaultReadText = async (repoPath: string, relPath: string): Promise<string | null> => {
  try {
    return await readFile(join(repoPath, relPath), 'utf8');
  } catch {
    return null;
  }
};

/** Default content-guard writer — UTF-8 working-tree text for deterministic repairs. */
const defaultWriteText = async (repoPath: string, relPath: string, text: string): Promise<void> => {
  await writeFile(join(repoPath, relPath), text, 'utf8');
};

const isDirty = async (runGit: RunGit, repo: string): Promise<boolean> => {
  const r = await runGit(['status', '--porcelain'], repo);
  return r.code === 0 && r.stdout.trim().length > 0;
};

/** Candidate HEAD paths for the same module resolution key used by the
 * quarantine-import guard. The exact path is checked first, then the normal JS/
 * TS extensions and directory index forms so a quarantined `foo.ts` does not
 * infect an importer when a committed `foo.js` or `foo/index.ts` still resolves. */
function headModuleCandidates(relPath: string): string[] {
  const normalized = normalizeModulePath(relPath);
  return [
    ...new Set([
      relPath,
      ...RESOLVABLE_EXTS.map((ext) => `${normalized}${ext}`),
      ...RESOLVABLE_EXTS.map((ext) => `${normalized}/index${ext}`),
    ]),
  ];
}

async function isModuleResolvableAtHead(
  runGit: RunGit,
  repoPath: string,
  relPath: string,
  log: (m: string) => void,
): Promise<boolean> {
  for (const candidate of headModuleCandidates(relPath)) {
    try {
      const result = await runGit(['cat-file', '-e', `HEAD:${candidate}`], repoPath);
      if (result.code === 0) return true;
    } catch (e) {
      // A HEAD probe is a safety refinement, not a reason to wedge git-sync. If
      // it cannot be measured, retain the guard's conservative quarantine.
      log(`[quarantine-import-guard] HEAD probe failed for ${relPath}: ${String(e)}`);
      return false;
    }
  }
  return false;
}

/** Current branch name, or null when HEAD is detached. */
const currentBranch = async (runGit: RunGit, repo: string): Promise<string | null> => {
  const r = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** The remote's default branch — `git rev-parse --abbrev-ref <remote>/HEAD` →
 *  "<remote>/main" → "main". Resolves the sync branch for a DETACHED HEAD (P-004):
 *  a fresh `git submodule update` leaves submodules detached, and they must sync to
 *  their OWN default (main), not the superproject's branch. Null when <remote>/HEAD
 *  isn't set. */
const remoteDefaultBranch = async (runGit: RunGit, repo: string, remote: string): Promise<string | null> => {
  const r = await runGit(['rev-parse', '--abbrev-ref', `${remote}/HEAD`], repo);
  if (r.code !== 0) return null;
  const ref = r.stdout.trim();
  if (!ref || ref.endsWith('/HEAD')) return null; // unset → the literal "<remote>/HEAD"
  return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
};

/**
 * Retained installer-seed snapshot refs (`origin/papercusp-seed-snapshot-<uuid>`), cut by
 * the git seed provider at depth=1 (seed-provider-git.ts). One always points at the
 * synthetic one-commit seed root, so it is the TRIGGER for `transplantInstallerSeedSnapshot`
 * below — never a preservation branch git-sync may reconcile against. Reading it as
 * "HEAD is already preserved at origin/<branch>" short-circuits the conversion into a
 * no-op `nothing` and leaves every seeded install wedged on its synthetic root
 * (measured 2026-09-06: seed-provider-git.test.ts red at tip for exactly this).
 */
const SEED_SNAPSHOT_REF_PREFIX = 'papercusp-seed-snapshot-';
const isSeedSnapshotRef = (branch: string): boolean => branch.startsWith(SEED_SNAPSHOT_REF_PREFIX);

/** Remote-tracking branches whose tip is exactly the checked-out HEAD.
 *
 * A detached submodule can be intentionally preserved on a non-default branch
 * (for example `origin/restart-pin-<sha>`), while its dormant local `main` has
 * unrelated work. Exact-tip proof lets git-sync continue the preserved branch
 * without moving or merging either history. `origin/HEAD` is a symbolic alias,
 * not a branch target, and is deliberately excluded — as is a retained
 * installer-seed snapshot ref, which is conversion input, not a branch to follow.
 */
const remoteBranchesPointingAtHead = async (runGit: RunGit, repo: string, remote: string): Promise<string[]> => {
  const refs = await runGit(
    ['for-each-ref', '--format=%(refname:strip=3)', '--points-at=HEAD', `refs/remotes/${remote}/`],
    repo,
  );
  if (refs.code !== 0) return [];
  return [
    ...new Set(
      refs.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((branch) => branch.length > 0 && branch !== 'HEAD' && !isSeedSnapshotRef(branch)),
    ),
  ].sort();
};

/** Choose only a proved-unambiguous exact-tip branch. The remote default wins
 * when it is one of several aliases; otherwise multiple candidates are a real
 * direction fork and must retain the existing fail-closed path. */
const preferredRemoteBranchAtHead = (branches: readonly string[], remoteDefault: string | null): string | null => {
  if (remoteDefault && branches.includes(remoteDefault)) return remoteDefault;
  return branches.length === 1 ? branches[0] : null;
};

type BranchAttachmentResult = { branch: string } | { error: string };

/**
 * Attach a detached repo before its first auto-commit. A submodule freshly checked
 * out by `git submodule update` is normally detached, but committing there without a
 * branch leaves the new commit reachable only through the worktree's detached HEAD.
 * Create the repo's own default branch when it is absent. When an existing local
 * branch is a strict ancestor of detached HEAD, atomically fast-forward that ref and
 * attach it: `git submodule update` can legitimately advance the detached checkout
 * without moving the dormant local branch. Never move a branch backward or across
 * divergent history: that is evidence of work git-sync must not destroy.
 */
const ensureBranchAttachedForCommit = async (
  runGit: RunGit,
  repo: string,
  remote: string,
  defaultBranch: string,
  log: (m: string) => void,
): Promise<BranchAttachmentResult> => {
  const attached = await currentBranch(runGit, repo);
  if (attached) return { branch: attached };

  const remoteDefault = await remoteDefaultBranch(runGit, repo, remote);
  const exactRemoteBranches = await remoteBranchesPointingAtHead(runGit, repo, remote);
  const preservedRemoteBranch = preferredRemoteBranchAtHead(exactRemoteBranches, remoteDefault);
  const branch = preservedRemoteBranch ?? remoteDefault ?? defaultBranch;
  if (!branch) {
    return { error: `${repo}: detached HEAD has no branch target to attach before commit` };
  }
  if (preservedRemoteBranch && preservedRemoteBranch !== remoteDefault) {
    log(
      `[git-sync] ${repo}: detached HEAD is already preserved at ${remote}/${preservedRemoteBranch}; ` +
        `attaching that exact-tip branch instead of default '${remoteDefault ?? defaultBranch}'`,
    );
  }

  const head = await runGit(['rev-parse', 'HEAD'], repo);
  const headSha = head.stdout.trim();
  if (head.code !== 0 || !headSha) {
    return {
      error: `${repo}: cannot resolve detached HEAD before attaching '${branch}': ${(head.stderr || head.stdout).trim()}`,
    };
  }

  const localRef = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo);
  if (localRef.code === 0) {
    const localTip = await runGit(['rev-parse', `refs/heads/${branch}`], repo);
    const localSha = localTip.stdout.trim();
    if (localTip.code !== 0 || !localSha) {
      return { error: `${repo}: cannot resolve existing local branch '${branch}' before attaching` };
    }
    if (localSha !== headSha) {
      const ancestry = await runGit(['merge-base', '--is-ancestor', localSha, headSha], repo);
      if (ancestry.code === 0) {
        // Compare-and-swap the dormant branch ref. The expected-old argument is
        // load-bearing: if a peer moves the branch after our ancestry read, git
        // refuses instead of overwriting their new tip.
        const fastForward = await runGit(['update-ref', `refs/heads/${branch}`, headSha, localSha], repo);
        if (fastForward.code !== 0) {
          return {
            error:
              `${repo}: failed to fast-forward existing local branch '${branch}' from ` +
              `${localSha.slice(0, 12)} to detached HEAD ${headSha.slice(0, 12)}: ` +
              `${(fastForward.stderr || fastForward.stdout).trim()}`,
          };
        }
        log(
          `[git-sync] ${repo}: fast-forwarded dormant '${branch}' from ` +
            `${localSha.slice(0, 12)} to detached HEAD ${headSha.slice(0, 12)}`,
        );
      } else if (ancestry.code === 1) {
        return {
          error:
            `${repo}: refusing to attach detached HEAD to divergent local branch '${branch}' ` +
            `(local ${localSha.slice(0, 12)} cannot fast-forward to HEAD ${headSha.slice(0, 12)})`,
        };
      } else {
        return {
          error:
            `${repo}: cannot compare existing local branch '${branch}' with detached HEAD before attaching: ` +
            `${(ancestry.stderr || ancestry.stdout).trim()}`,
        };
      }
    }
    const attach = await recoverIndexLockContention(
      await runGit(['switch', branch], repo),
      () => runGit(['switch', branch], repo),
      runGit,
      repo,
      'git switch',
      log,
    );
    if (attach.code !== 0) {
      return {
        error: `${repo}: failed to attach detached HEAD to existing '${branch}': ${(attach.stderr || attach.stdout).trim()}`,
      };
    }
    log(`[git-sync] ${repo}: attached detached HEAD to existing '${branch}' at the same tip`);
    return { branch };
  }
  if (localRef.code !== 1) {
    return {
      error: `${repo}: could not determine whether local branch '${branch}' exists: ${(localRef.stderr || localRef.stdout).trim()}`,
    };
  }

  const create = await recoverIndexLockContention(
    await runGit(['switch', '--create', branch], repo),
    () => runGit(['switch', '--create', branch], repo),
    runGit,
    repo,
    'git switch --create',
    log,
  );
  if (create.code !== 0) {
    return {
      error: `${repo}: failed to create '${branch}' from detached HEAD: ${(create.stderr || create.stdout).trim()}`,
    };
  }
  log(`[git-sync] ${repo}: created and attached '${branch}' at detached HEAD`);
  return { branch };
};

const headSha = async (runGit: RunGit, repo: string): Promise<string> => {
  const r = await runGit(['rev-parse', 'HEAD'], repo);
  return r.stdout.trim();
};

const conflictedFiles = async (runGit: RunGit, repo: string): Promise<string[]> => {
  const r = await runGit(['diff', '--name-only', '--diff-filter=U'], repo);
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
};

type SeedSnapshotTransplant =
  | { status: 'not-seed' }
  | { status: 'transplanted'; backupRef: string; replayedCommits: number }
  | { status: 'error'; message: string };

/**
 * WI-37969 / WI-6824: a depth=1 installer seed is intentionally a synthetic,
 * one-commit ROOT history. After restore, `origin` is repointed at the real
 * repository, so the first fetch necessarily produces two unrelated histories.
 * Treating that as an ordinary merge wedges every seeded install before its P2P
 * legs (`fatal: refusing to merge unrelated histories`).
 *
 * The seed provider's contract has always been "restore offline, then replace the
 * snapshot with the fetched delta" (its integration test previously did a manual
 * `reset --hard FETCH_HEAD`). This is the production-safe form of that conversion:
 *
 *  - require BOTH the exact synthetic-root subject and the bundle clone's retained
 *    `origin/papercusp-seed-snapshot-*` ref pointing at that root; an arbitrary
 *    unrelated-history rewrite therefore stays a loud error;
 *  - create a recovery ref before changing history;
 *  - with no post-restore commits, adopt the fetched branch exactly;
 *  - otherwise rebase every post-restore commit onto the fetched branch, preserving
 *    local work. A conflict aborts cleanly and leaves the recovery ref + old branch
 *    intact; it never falls through to `--allow-unrelated-histories`.
 */
async function transplantInstallerSeedSnapshot(
  runGit: RunGit,
  repo: string,
  remoteRef: string,
  remote: string,
  log: (m: string) => void,
): Promise<SeedSnapshotTransplant> {
  const roots = await runGit(['rev-list', '--max-parents=0', 'HEAD'], repo);
  const rootShas = roots.code === 0 ? roots.stdout.trim().split('\n').filter(Boolean) : [];
  if (rootShas.length !== 1) return { status: 'not-seed' };
  const seedRoot = rootShas[0];

  const subject = await runGit(['show', '-s', '--format=%s', seedRoot], repo);
  if (subject.code !== 0 || !/^papercusp seed snapshot (?:HEAD|[0-9a-f]{7,64})$/.test(subject.stdout.trim())) {
    return { status: 'not-seed' };
  }

  const snapshotRefs = await runGit(
    ['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}/${SEED_SNAPSHOT_REF_PREFIX}*`],
    repo,
  );
  if (snapshotRefs.code !== 0 || !snapshotRefs.stdout.split('\n').some((sha) => sha.trim() === seedRoot)) {
    return { status: 'not-seed' };
  }

  const head = await runGit(['rev-parse', '--verify', 'HEAD'], repo);
  if (head.code !== 0 || !head.stdout.trim()) {
    return { status: 'error', message: 'seed snapshot transplant could not resolve HEAD' };
  }
  const originalHead = head.stdout.trim();
  const count = await runGit(['rev-list', '--count', `${seedRoot}..HEAD`], repo);
  if (count.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant could not enumerate post-restore commits: ${count.stderr.trim() || count.stdout.trim()}`,
    };
  }
  const replayedCommits = Number.parseInt(count.stdout.trim(), 10) || 0;
  const backupRef = `refs/papercusp/seed-recovery/${originalHead}`;
  const backup = await runGit(['update-ref', backupRef, originalHead], repo);
  if (backup.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant could not create recovery ref ${backupRef}: ${backup.stderr.trim() || backup.stdout.trim()}`,
    };
  }

  if (replayedCommits === 0) {
    const adopt = await runGit(['reset', '--hard', remoteRef], repo);
    if (adopt.code !== 0) {
      return {
        status: 'error',
        message: `seed snapshot transplant could not adopt ${remoteRef} (recovery ref ${backupRef}): ${adopt.stderr.trim() || adopt.stdout.trim()}`,
      };
    }
  } else {
    const replay = await runGit(['rebase', '--rebase-merges', '--onto', remoteRef, seedRoot], repo);
    if (replay.code !== 0) {
      const replayOut = `${replay.stdout}\n${replay.stderr}`.trim();
      await runGit(['rebase', '--abort'], repo);
      return {
        status: 'error',
        message: `seed snapshot transplant could not replay ${replayedCommits} post-restore commit(s) onto ${remoteRef} (aborted clean; recovery ref ${backupRef}): ${replayOut.slice(0, 300)}`,
      };
    }
  }

  const related = await runGit(['merge-base', '--is-ancestor', remoteRef, 'HEAD'], repo);
  if (related.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant did not produce a descendant of ${remoteRef} (recovery ref ${backupRef})`,
    };
  }
  log(
    `[git-sync] ${repo}: converted installer seed snapshot ${seedRoot.slice(0, 12)} to ${remoteRef}; ` +
      `${replayedCommits === 0 ? 'no post-restore commits' : `replayed ${replayedCommits} post-restore commit(s)`}; recovery ref ${backupRef}`,
  );
  return { status: 'transplanted', backupRef, replayedCommits };
}

/** WI-6824: a merge that fails with ZERO conflicted paths is classified `error`, and that
 *  message is the ONLY record of it — git-sync NULLs `last_error` on the next healthy tick,
 *  so an INTERMITTENT failure leaves nothing to correlate against afterwards (a fault that
 *  alarmed the fleet for ~10h across 39 sweeps left zero occurrences in 12h of journald, and
 *  was consequently not reproducible from any on-disk state).
 *
 *  Resolve the ref pair the merge ACTUALLY used, so the next flap identifies which pair was
 *  unrelated instead of being unfixable-by-inspection. `merge-base` is the discriminator:
 *  it exits non-zero with no output exactly when the histories are unrelated, which is the
 *  reported failure. `git-dir` + `url` are here because the cheapest way to get a genuine
 *  unrelated-history refusal between two healthy repos is to resolve the WRONG repository —
 *  a stale submodule git-dir path (libs/generic/chat-protocol still resolves its git-dir
 *  through the pre-move `.git/modules/libs/chat-protocol`) would present exactly this way,
 *  and no amount of after-the-fact inspection of the intended repo can distinguish it. */
const describeFailedMerge = async (
  runGit: RunGit,
  repo: string,
  remote: string,
  branch: string,
  attempt: 'initial' | 'non-ff-retry',
): Promise<string> => {
  const read = async (args: string[]): Promise<string> => {
    const r = await runGit(args, repo);
    const out = r.stdout.trim();
    return r.code === 0 && out ? out : '<none>';
  };
  const remoteRef = `${remote}/${branch}`;
  const head = await read(['rev-parse', '--short', 'HEAD']);
  const remoteSha = await read(['rev-parse', '--short', '--verify', remoteRef]);
  // exits 1 with empty stdout when there is NO common ancestor — i.e. the refusal itself.
  const rawBase = await read(['merge-base', 'HEAD', remoteRef]);
  const base = rawBase === '<none>' ? 'NONE(unrelated)' : rawBase.slice(0, 12);
  const gitDir = await read(['rev-parse', '--absolute-git-dir']);
  const url = await read(['config', '--get', `remote.${remote}.url`]);
  return `attempt=${attempt} HEAD=${head} ${remoteRef}=${remoteSha} merge-base=${base} git-dir=${gitDir} url=${url}`;
};

// Exported for the non-FF detection table test (test-coverage-gap G21): a git
// wording change must fail a test, not silently turn retriable rejections into
// hard escalations.
export function rejectedNonFastForward(r: { stdout: string; stderr: string }): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(`${r.stdout}\n${r.stderr}`);
}

/** A non-zero `git commit` that simply had nothing staged (e.g. every dirty file was
 *  excluded as oversized) — benign, NOT a real commit failure. Anything else (index.lock
 *  race, corrupt index, hook abort) IS a failure we must surface (P-002). */
function nothingToCommit(r: { stdout: string; stderr: string }): boolean {
  return /nothing to commit|no changes added to commit|nothing added to commit/i.test(`${r.stdout}\n${r.stderr}`);
}

/** Repo-relative paths that made `git add` FATAL because they are embedded git repos with no
 *  commit ("error: '<path>' does not have a commit checked out"). Extracted so git-sync can
 *  EXCLUDE them + retry rather than silently stranding the WHOLE tree (2026-06-30 root cause:
 *  one nested no-commit .git under .papercusp/.vitest-tmpdir fatal-ed `git add -A`, so nothing
 *  committed for ~7h). Exported for unit testing. */
export function addFailureStrayPaths(output: string): string[] {
  const out: string[] = [];
  const re = /error: '([^']+)' does not have a commit checked out/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    out.push(m[1].replace(/\/+$/, '')); // git prints a trailing slash for a dir; pathspec wants it clean
  }
  return [...new Set(out)];
}

/** Protected paths that made `git add` fatal because they are already ignored.
 *
 * `git add -A -- . :(exclude,literal)<path>` normally lets a live editor keep a
 * dirty path out of git-sync's catch-all commit. Git still treats that negative
 * pathspec as an explicit mention, though, and refuses the whole add when the path
 * is ignored (for example a transient nested `package-lock.json`). The ignore rule
 * already protects the file, so the safe retry is to omit ONLY that redundant
 * exclusion pathspec — never `-f` the ignored artifact into the commit.
 */
export function addFailureIgnoredPaths(output: string): string[] {
  const match = output.match(
    /The following paths are ignored by one of your \.gitignore files:\s*\n([\s\S]*?)(?:\nhint:|$)/i,
  );
  if (!match) return [];
  return [
    ...new Set(
      match[1]
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean),
    ),
  ];
}

/** Protected exclusion pathspecs made redundant by an ignored-path add failure.
 *
 * Git may report the ignored directory ancestor rather than each explicitly
 * mentioned descendant (for example `apps/shop/.astro` for protected files
 * beneath that directory). Map that report back to only the exact protected
 * path or its descendants; unrelated protections must stay in the retry.
 */
export function ignoredProtectedExclusions(output: string, excludePaths: readonly string[]): string[] {
  const ignoredPaths = addFailureIgnoredPaths(output)
    .map((path) => path.replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  return excludePaths.filter((excludePath) => {
    const normalizedExclude = excludePath.replace(/^\.\/+/, '').replace(/\/+$/, '');
    return ignoredPaths.some(
      (ignoredPath) => normalizedExclude === ignoredPath || normalizedExclude.startsWith(`${ignoredPath}/`),
    );
  });
}

/** The stable fatal emitted when a pathspec tries to traverse a symlink.
 * Exported so a Git wording change fails a focused test instead of silently
 * disabling the protected-path preflight. */
export function isPathspecBeyondSymbolicLinkFailure(output: string): boolean {
  return /fatal:\s+pathspec .* is beyond a symbolic link/i.test(output);
}

export type ProtectedPathExclusionPreflight = {
  ignoredUntracked: Set<string>;
  beyondSymlink: Set<string>;
};

/**
 * Classify protected paths that cannot safely appear as negative pathspecs.
 *
 * `git check-ignore` intentionally does not report tracked paths unless
 * `--no-index` is supplied. That default is load-bearing here: a tracked file
 * may still be covered by a later ignore rule, but its exclusion pathspec must
 * remain in the staging command so git-sync does not commit the protected
 * mutation. Conversely, an ignored untracked path is already excluded by Git's
 * normal ignore handling; passing it as a negative pathspec makes `git add`
 * reject the entire command. Probe one path per invocation: `-z` is only valid
 * with `--stdin`, while this injected RunGit seam has no stdin channel, and
 * parsing line-delimited output would be unsafe for legal filenames containing
 * newlines. With one path, the exit status is the answer and `--` keeps leading
 * dashes literal. Exit code 1 means "not ignored". Git exits 128 when the
 * protected path is a descendant of a symlink; `git add -A` does not traverse
 * that symlink, but the explicit negative pathspec makes the entire add fatal,
 * so classify that population separately and omit only those impossible
 * pathspecs. Any other non-zero result fails open by returning no matches and
 * preserving all exclusions for the existing add-failure recovery path.
 */
export async function classifyProtectedPathExclusions(
  runGit: RunGit,
  repoPath: string,
  paths: readonly string[],
): Promise<ProtectedPathExclusionPreflight> {
  const ignoredUntracked = new Set<string>();
  const beyondSymlink = new Set<string>();
  // A protected path needs its own check: check-ignore's non-stdin output quotes
  // unusual filenames, so a batched result cannot be mapped back losslessly.
  // Bound concurrency instead of serializing one git process per live lock.
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (!failed && next < paths.length) {
        const path = paths[next++];
        const result = await runGit(['check-ignore', '--', path], repoPath);
        if (result.code === 0) ignoredUntracked.add(path);
        else if (result.code === 1) continue;
        else if (isPathspecBeyondSymbolicLinkFailure(`${result.stdout}\n${result.stderr}`)) beyondSymlink.add(path);
        else failed = true;
      }
    }),
  );
  if (failed) return { ignoredUntracked: new Set<string>(), beyondSymlink: new Set<string>() };
  return { ignoredUntracked, beyondSymlink };
}

/** The `git add`/`git commit` fatal for a held index lock ("Unable to create
 *  '….git/index.lock': File exists"). Exported for unit testing (a git wording
 *  change must fail a test, not silently disable the self-heal below). */
export function isIndexLockFailure(output: string): boolean {
  return /Unable to create '[^']*index\.lock': File exists/i.test(output);
}

/** The `git submodule sync` fatal for a held repository config lock. Git names
 * the destination config file in the error even though the sentinel on disk is
 * its `.lock` sibling. Exported so wording drift fails a focused test. */
export function isConfigLockFailure(output: string): boolean {
  return /could not lock config file [^\r\n]*[/\\]config: File exists/i.test(output);
}

/** The `git add -A` fatal for a path that vanished between git's tree-walk
 *  enumeration and its stat call ("fatal: unable to stat '<path>': No such file or
 *  directory") — a benign race with ANY process in this heavily-concurrent fleet
 *  that writes atomically (write `<file>.tmp.<pid>.<hash>` sibling, then
 *  rename/remove over the real file): git enumerates the tmp sibling right before
 *  the writer renames/removes it, so the subsequent stat 404s even though the file
 *  legitimately existed a moment earlier. The window is a handful of milliseconds
 *  wide (EI-18094449017685490), so a bounded immediate retry resolves it instead of
 *  stranding the whole tick's commit on one transient, already-gone path. Exported
 *  for unit testing (a git wording change must fail a test, not silently disable
 *  the retry below). */
export function isTransientStatFailure(output: string): boolean {
  return /fatal: unable to stat '[^']*': No such file or directory/i.test(output);
}

/** Bounded retry budget for {@link isTransientStatFailure} — the race window is a
 *  few ms wide (one process's write-tmp+rename), so this is generous, not a
 *  long-poll. Exported so the unit test doesn't hardcode a magic number twice. */
export const TRANSIENT_STAT_FAILURE_MAX_RETRIES = 3;
const TRANSIENT_STAT_FAILURE_RETRY_DELAY_MS = 150;

/** A live git writer can hold `.git/index.lock` only briefly while it replaces the
 * index. Retry that specific contention before surfacing an error, but keep the
 * budget small so a genuinely wedged writer still reaches the stale-lock guard. */
export const INDEX_LOCK_CONTENTION_MAX_RETRIES = 3;
export const INDEX_LOCK_CONTENTION_RETRY_BASE_DELAY_MS = 100;

/** `git submodule sync` writes repository config through `.git/config.lock`, so
 * it can race the same short-lived local git writers as the index path above.
 * Keep the retry budget deliberately small: a live writer normally releases in
 * milliseconds, while a persistent lock still reaches the stale-lock guard and
 * the loud error path in this same tick. */
export const CONFIG_LOCK_CONTENTION_MAX_RETRIES = 3;
export const CONFIG_LOCK_CONTENTION_RETRY_BASE_DELAY_MS = 100;

/** A lock YOUNGER than this is treated as live contention (git rewrites the lock
 *  file as it builds the new index, so an in-flight writer keeps the mtime fresh);
 *  older = the writer is dead and the lock is an orphan. git-sync ticks run ~2min
 *  apart, so a real writer is never this old between ticks. */
export const STALE_INDEX_LOCK_MS = 90_000;

/**
 * STALE-LOCK SELF-HEAL (2026-07-04): a git process killed mid-`add -A` leaves
 * `.git/index.lock` behind, and every subsequent tick then fails with the same
 * "File exists" fatal — FOREVER, until a human deletes the file (observed live:
 * 3 consecutive failed ticks + a fleet-wide alert for a 6.8MB orphaned lock).
 * This clears the lock ONLY when it is provably stale (mtime older than
 * `staleMs` — an active writer keeps it fresh), so a live racing git process is
 * never robbed of its lock; a fresh-lock failure stays an error and the NEXT
 * tick (by which time the orphan has aged past the threshold) heals it. Resolves
 * the git dir via `rev-parse --absolute-git-dir` so submodules (whose `.git` is
 * a file, not a dir) work too. Returns true when the caller should retry.
 */
/**
 * Does any live process on this host still hold `lockPath` open? Scans
 * `/proc/<pid>/fd/*` (Linux) for a descriptor resolving to the lock; on a host
 * without /proc (macOS) asks `lsof` instead (WI-10003529). Fails CLOSED when
 * neither instrument can answer: `true` = "assume held", because
 * a wrongly-kept orphan costs one more failed tick (the next tick re-checks)
 * while a wrongly-unlinked live lock truncates the index (EI-22703121889295786).
 */
export async function lockHasLiveHolder(
  lockPath: string,
  deps: {
    procHolder?: (p: string) => Promise<boolean | null>;
    lsofHolder?: (p: string) => Promise<boolean | null>;
  } = {},
): Promise<boolean> {
  const viaProc = await (deps.procHolder ?? procLockHolder)(lockPath);
  if (viaProc !== null) return viaProc;
  // WI-10003529: no /proc (macOS). Before this fallback the function returned
  // `true` here unconditionally, so on a Mac a lock orphaned by a restart was
  // never reclaimed and every later git-sync tick failed until a human deleted
  // it (P-203 Mac VM, 2026-09-27: two locks aged 50-70 min, lsof proved no holder).
  const viaLsof = await (deps.lsofHolder ?? lsofLockHolder)(lockPath);
  return viaLsof ?? true; // neither instrument could prove absence → assume held
}

/** WI-10003529: ask `lsof` whether any process holds `lockPath` open.
 *  true = held, false = PROVEN not held (rc 1, no output at all), null = the
 *  instrument could not answer (binary missing, timeout, any stderr), which the
 *  caller treats as held. `-w` silences lsof's unrelated stat() warnings, which
 *  would otherwise turn every Mac answer into `null`. */
export async function lsofLockHolder(
  lockPath: string,
  run: (bin: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> = runLsof,
): Promise<boolean | null> {
  for (const bin of ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof']) {
    const r = await run(bin, ['-t', '-w', '--', lockPath]);
    if (r.missing) continue;
    if (r.code === 0 && /^\d+$/m.test(r.stdout)) return true;
    if (r.code === 1 && r.stdout.trim() === '' && r.stderr.trim() === '') return false;
    return null;
  }
  return null;
}

function runLsof(
  bin: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { code: number | null; stdout: string; stderr: string; missing?: boolean }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Boundary-safe decoding (WI-6728): lsof prints paths, which may be non-ASCII.
    const out = collectChildOutput(child);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout: out.stdout.text(), stderr: out.stderr.text() || 'lsof timed out' });
    }, 10_000);
    child.on('error', (e: NodeJS.ErrnoException) =>
      done({ code: null, stdout: out.stdout.text(), stderr: String(e.message), missing: e.code === 'ENOENT' }),
    );
    child.on('close', (code) => done({ code, stdout: out.stdout.text(), stderr: out.stderr.text() }));
  });
}

/** Linux: scan `/proc/<pid>/fd/*` for a descriptor resolving to `lockPath`.
 *  null = no usable /proc on this host (the caller falls back to lsof). */
async function procLockHolder(lockPath: string): Promise<boolean | null> {
  let pids: string[];
  try {
    pids = (await readdir('/proc')).filter((n) => /^[0-9]+$/.test(n));
  } catch {
    return null;
  }
  if (pids.length === 0) return null;
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue; // process exited or not ours to inspect — cannot be holding it on our behalf
    }
    for (const fd of fds) {
      try {
        if ((await readlink(`/proc/${pid}/fd/${fd}`)) === lockPath) return true;
      } catch {
        /* fd closed between readdir and readlink */
      }
    }
  }
  return false;
}

async function clearStaleGitLock(
  runGit: RunGit,
  repoPath: string,
  lockName: 'index.lock' | 'config.lock',
  log: (m: string) => void,
  deps: {
    statMtimeMs?: (p: string) => Promise<number | null>;
    unlinkFile?: (p: string) => Promise<void>;
    now?: () => number;
    staleMs?: number;
    /** LIVE-HOLDER GUARD (EI-22703121889295786): mtime alone is NOT proof the
     *  writer is dead — a `git add -A` walking a multi-MB tree can hold
     *  `index.lock` open for >90s without touching its mtime, and unlinking it
     *  under a live writer is exactly how the canonical index was truncated to
     *  0 bytes. Returns true when some live process still has the lock open. */
    hasLiveHolder?: (lockPath: string) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const statMtimeMs =
    deps.statMtimeMs ??
    (async (p: string) => {
      try {
        return (await lstat(p)).mtimeMs;
      } catch {
        return null;
      }
    });
  const unlinkFile = deps.unlinkFile ?? unlink;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_INDEX_LOCK_MS;
  const hasLiveHolder = deps.hasLiveHolder ?? lockHasLiveHolder;
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (gd.code !== 0) return false;
  const lockPath = join(gd.stdout.trim(), lockName);
  const mtime = await statMtimeMs(lockPath);
  if (mtime === null) return true; // already gone (holder finished/cleaned up) — just retry
  const ageMs = now() - mtime;
  if (ageMs < staleMs) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is FRESH (${Math.round(ageMs / 1000)}s old) — live contention, not touching it; this tick fails and the next one self-heals if the writer died`,
    );
    return false;
  }
  if (await hasLiveHolder(lockPath)) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is ${Math.round(ageMs / 1000)}s old but a LIVE process still holds it open — FRESH-BY-HOLDER, not touching it (unlinking under a live writer truncates the index; EI-22703121889295786)`,
    );
    return false;
  }
  try {
    await unlinkFile(lockPath);
  } catch (e) {
    log(`[git-sync] ${repoPath}: could not unlink stale ${lockName}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(
    `[git-sync] ${repoPath}: cleared STALE ${lockName} (${Math.round(ageMs / 1000)}s old — its writer is dead) and retrying (previously: every tick failed until a human removed it)`,
  );
  return true;
}

export async function clearStaleIndexLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: Parameters<typeof clearStaleGitLock>[4] = {},
): Promise<boolean> {
  return clearStaleGitLock(runGit, repoPath, 'index.lock', log, deps);
}

type GitCommandResult = Awaited<ReturnType<RunGit>>;

/**
 * Apply the same bounded live-contention + stale-orphan recovery to every Git
 * operation that writes the index. `git add` already used this policy; keeping
 * it here also covers the immediately-following `git commit`, which can lose a
 * fresh index.lock race to a different writer after staging succeeded.
 */
async function recoverIndexLockContention(
  initial: GitCommandResult,
  runAttempt: () => Promise<GitCommandResult>,
  runGit: RunGit,
  repoPath: string,
  operation: string,
  log: (m: string) => void,
): Promise<GitCommandResult> {
  let result = initial;
  if (result.code === 0 || !isIndexLockFailure(`${result.stdout}\n${result.stderr}`)) return result;

  const cleared = await clearStaleIndexLock(runGit, repoPath, log);
  if (cleared) result = await runAttempt();

  for (
    let attempt = 1;
    result.code !== 0 &&
    isIndexLockFailure(`${result.stdout}\n${result.stderr}`) &&
    attempt <= INDEX_LOCK_CONTENTION_MAX_RETRIES;
    attempt++
  ) {
    const delayMs = INDEX_LOCK_CONTENTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    log(
      `[git-sync] ${repoPath}: '${operation}' hit live index.lock contention — retrying after ${delayMs}ms (attempt ${attempt}/${INDEX_LOCK_CONTENTION_MAX_RETRIES})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await runAttempt();
  }

  // A live holder can die during the bounded retries. Re-run the age-checked
  // orphan guard once more; it never removes a still-fresh writer's lock.
  if (result.code !== 0 && isIndexLockFailure(`${result.stdout}\n${result.stderr}`)) {
    const clearedAfterRetry = await clearStaleIndexLock(runGit, repoPath, log);
    if (clearedAfterRetry) result = await runAttempt();
  }
  return result;
}

interface ConfigLockSnapshot {
  mtimeMs: number;
  size: number;
  dev?: number;
  ino?: number;
}

interface ClearStaleConfigLockDeps {
  inspectLock?: (p: string) => Promise<ConfigLockSnapshot | null>;
  isOpen?: (p: string) => Promise<boolean | null>;
  unlinkFile?: (p: string) => Promise<void>;
  now?: () => number;
  staleMs?: number;
}

/** Clear an orphaned empty Git metadata lock left by a dead writer (including
 * a sandbox mount-point artifact). These metadata locks are more sensitive than
 * the replaceable index: age alone is insufficient evidence. Delete only a
 * zero-byte lock that is old, has no open descriptor, and has not changed during
 * inspection. */
export async function clearStaleHolderlessEmptyGitLock(
  runGit: RunGit,
  repoPath: string,
  lockName: 'config.lock' | 'shallow.lock',
  log: (m: string) => void,
  deps: ClearStaleConfigLockDeps = {},
): Promise<boolean> {
  const inspectLock =
    deps.inspectLock ??
    (async (p: string): Promise<ConfigLockSnapshot | null> => {
      try {
        const st = await lstat(p);
        return { mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino };
      } catch {
        return null;
      }
    });
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;
  const unlinkFile = deps.unlinkFile ?? unlink;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_INDEX_LOCK_MS;

  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (gd.code !== 0) return false;
  const lockPath = join(gd.stdout.trim(), lockName);
  const before = await inspectLock(lockPath);
  if (before === null) return true;

  const ageMs = now() - before.mtimeMs;
  if (ageMs < staleMs) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is FRESH (${Math.round(ageMs / 1000)}s old) — live contention, not touching it`,
    );
    return false;
  }
  if (before.size !== 0) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is old but NONEMPTY (${before.size} bytes) — cannot prove it is an orphan, not touching it`,
    );
    return false;
  }

  const open = await isOpen(lockPath);
  if (open !== false) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is old and empty but ${open ? 'still OPEN' : 'holder state is UNKNOWN'} — not touching it`,
    );
    return false;
  }

  // Close the inspection-to-unlink race enough to catch replacement or a writer
  // touching the sentinel while the descriptor scan ran. A changed file is no
  // longer the empty orphan we proved above, so leave it for the next tick.
  const after = await inspectLock(lockPath);
  if (after === null) return true;
  if (
    after.mtimeMs !== before.mtimeMs ||
    after.size !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  ) {
    log(`[git-sync] ${repoPath}: ${lockName} changed during orphan inspection — not touching it`);
    return false;
  }

  try {
    await unlinkFile(lockPath);
  } catch (e) {
    log(`[git-sync] ${repoPath}: could not unlink stale ${lockName}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(
    `[git-sync] ${repoPath}: cleared STALE empty holderless ${lockName} (${Math.round(ageMs / 1000)}s old) and retrying`,
  );
  return true;
}

/** Clear an orphaned `.git/config.lock` left by a dead config writer. */
export async function clearStaleConfigLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: ClearStaleConfigLockDeps = {},
): Promise<boolean> {
  return clearStaleHolderlessEmptyGitLock(runGit, repoPath, 'config.lock', log, deps);
}

/** A crash-left `index-pack` file is safe to consider only after this age floor. */
export const STALE_TEMP_PACK_MS = 30 * 60_000;

type TempPackEntry = { name: string; size: number; mtimeMs: number; nlink: number };

async function gitDirForRepo(runGit: RunGit, repoPath: string): Promise<string> {
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  return gd.code === 0 ? gd.stdout.trim() : '';
}

const ZERO_BYTE_LOOSE_OBJECT_REPORT_LIMIT = 20;

/**
 * A canonical loose object lives at `objects/<2 hex>/<38 hex>`. Git writes it
 * through a temporary file and atomically renames the completed payload, so a
 * regular zero-byte file at that final name is corruption, never an in-flight
 * writer. Detect it before fetch: otherwise Git's `bad object HEAD`/mmap error
 * is flattened into the generic "fetch failed; HEAD has unpushed commits"
 * branch and the same checkout can fail silently for dozens of routine ticks.
 *
 * Detection is deliberately non-destructive. The object may be a local-only
 * commit that no remote can restore, so automatic deletion would destroy the
 * only remaining identity needed for reflog/working-tree recovery.
 */
async function findZeroByteLooseObjects(runGit: RunGit, repoPath: string): Promise<string[]> {
  const gitDir = await gitDirForRepo(runGit, repoPath);
  if (!gitDir) return [];
  let fanouts: string[];
  try {
    fanouts = await readdir(join(gitDir, 'objects'));
  } catch {
    return [];
  }

  const corrupt: string[] = [];
  for (const fanout of fanouts.sort()) {
    if (!/^[0-9a-f]{2}$/i.test(fanout)) continue;
    let names: string[];
    try {
      names = await readdir(join(gitDir, 'objects', fanout));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{38}$/i.test(name)) continue;
      try {
        const st = await lstat(join(gitDir, 'objects', fanout, name));
        if (st.isFile() && st.size === 0) corrupt.push(`${fanout}${name}`.toLowerCase());
      } catch {
        // A concurrent maintenance process may remove or repack the object.
      }
      if (corrupt.length >= ZERO_BYTE_LOOSE_OBJECT_REPORT_LIMIT) return corrupt;
    }
  }
  return corrupt;
}

async function listTempPackEntries(
  runGit: RunGit,
  repoPath: string,
): Promise<{ gitDir: string; entries: TempPackEntry[] }> {
  const gitDir = await gitDirForRepo(runGit, repoPath);
  if (!gitDir) return { gitDir: '', entries: [] };
  let names: string[];
  try {
    names = await readdir(join(gitDir, 'objects', 'pack'));
  } catch {
    return { gitDir, entries: [] };
  }
  const entries: TempPackEntry[] = [];
  for (const name of names) {
    if (!/^tmp_pack_[^/]+$/.test(name)) continue;
    try {
      const st = await lstat(join(gitDir, 'objects', 'pack', name));
      if (st.isFile()) entries.push({ name, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink });
    } catch {
      // A concurrent fetch may have finalized or removed the temp file.
    }
  }
  return { gitDir, entries };
}

/**
 * A failed `git fetch` can leave `index-pack`'s incoming pack at
 * `.git/objects/pack/tmp_pack_*`. The temp name is deliberately not a valid
 * reachable pack ref; Git only renames it after the pack is complete. Snapshot
 * the names before fetch and remove ONLY new regular files after a failed fetch.
 * This avoids deleting an older leak (or a peer's pre-existing temp pack) while
 * reclaiming a large partial pack immediately instead of waiting for age-based GC.
 */
export async function listTempPackFiles(runGit: RunGit, repoPath: string): Promise<Map<string, number>> {
  const { entries } = await listTempPackEntries(runGit, repoPath);
  const result = new Map<string, number>();
  for (const entry of entries) result.set(entry.name, entry.size);
  return result;
}

/**
 * `tmp_pack_*` has no Git index and therefore cannot be reached by a ref while it
 * retains its temporary name. Keep the additional checks explicit: an index/keep
 * sidecar, an advertised pack entry, or a hard link means another Git process may
 * have made the file reachable, so the scavenger must leave it alone.
 */
async function tempPackHasReferences(gitDir: string, entry: TempPackEntry): Promise<boolean> {
  if (entry.nlink > 1) return true;
  const packPath = join(gitDir, 'objects', 'pack', entry.name);
  for (const suffix of ['.idx', '.keep']) {
    try {
      await lstat(`${packPath}${suffix}`);
      return true;
    } catch {
      // No sidecar — keep checking the other proof surfaces.
    }
  }
  try {
    const advertised = await readFile(join(gitDir, 'objects', 'info', 'packs'), 'utf8');
    if (advertised.split('\n').some((line) => line.includes(entry.name))) return true;
  } catch {
    // `objects/info/packs` is optional; absence is not evidence of a reference.
  }
  return false;
}

/** Return true when `/proc` proves a descriptor currently names the candidate. */
async function procSeesOpenFile(path: string): Promise<boolean | null> {
  const canonical = await realpath(path).catch(() => null);
  if (!canonical) return null;
  let pids: string[];
  try {
    pids = await readdir('/proc');
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        if (target === canonical || target === `${canonical} (deleted)`) return true;
      } catch {
        // Processes can exit or close a descriptor while the directory is scanned.
      }
    }
  }
  return false;
}

/** macOS has no `/proc`; `lsof` is part of the base system and is read-only here. */
async function lsofSeesOpenFile(path: string): Promise<boolean | null> {
  return await new Promise<boolean | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('lsof', ['-t', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout = collectChildOutput(child).stdout;
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 && stdout.text().trim().length > 0));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, 1000);
    timer.unref?.();
  });
}

/** A targeted native Linux descriptor check. A serial JS walk over every
 * /proc/<pid>/fd took 34s for the two index proofs on this host, and turned
 * the real-git repair guard into a 60s test timeout. fuser checks the same
 * target in one process; errors and timeouts remain unknown (fail closed).
 * A host without fuser retains the existing /proc fallback. */
async function fuserSeesOpenFile(path: string): Promise<boolean | null | 'unavailable'> {
  return await new Promise<boolean | null | 'unavailable'>((resolve) => {
    let settled = false;
    let sawStderr = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean | null | 'unavailable'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('fuser', ['-s', path], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (chunk) => {
      if (String(chunk).trim()) sawStderr = true;
    });
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ENOENT' ? 'unavailable' : null));
    child.once('close', (code) => finish(code === 0 ? true : code === 1 && !sawStderr ? false : null));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, 12_000);
    timer.unref?.();
  });
}

async function defaultOpenFileCheck(path: string): Promise<boolean | null> {
  if (process.platform === 'linux') {
    const targeted = await fuserSeesOpenFile(path);
    return targeted === 'unavailable' ? await procSeesOpenFile(path) : targeted;
  }
  if (process.platform === 'darwin') return lsofSeesOpenFile(path);
  return null;
}

/**
 * The minimum byte length of a Git index with its fixed header and SHA-1
 * checksum. Git's index starts with a 12-byte `DIRC` header and ends with a
 * 20-byte repository-hash checksum. A shorter file can only be a torn write;
 * it is not a usable empty index. (SHA-256 repositories have a larger
 * checksum, so this floor remains deliberately conservative and still catches
 * the zero/short index class this guard protects.)
 */
export const MIN_VALID_GIT_INDEX_BYTES = 12 + 20;

export interface GitIndexFileSnapshot {
  size: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
  /** `lstat().isFile()`. Optional for injected test seams; undefined means regular. */
  isFile?: boolean;
}

export interface InvalidIndexPreflightDeps {
  /** Read one path without following a symlink. ENOENT is returned as null. */
  inspectFile?: (path: string) => Promise<GitIndexFileSnapshot | null>;
  /** `true` = a writer has the path open, `false` = no writer, `null` = unknown. */
  isOpen?: (path: string) => Promise<boolean | null>;
  /** Override the minimum size for deterministic format/edge tests. */
  minimumBytes?: number;
}

export type InvalidIndexPreflightResult =
  | { status: 'unavailable'; reason: string }
  | { status: 'absent' | 'valid'; indexPath: string; size?: number; minimumBytes: number }
  | { status: 'repaired'; indexPath: string; previousSize: number; size: number; minimumBytes: number }
  | { status: 'refused' | 'error'; indexPath: string; reason: string; previousSize?: number; minimumBytes: number };

const defaultIndexFileSnapshot = async (path: string): Promise<GitIndexFileSnapshot | null> => {
  try {
    const st = await lstat(path);
    return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, isFile: st.isFile() };
  } catch (error) {
    // An absent index is a normal state for a newly-created repository. Other
    // errors (permissions, I/O, a disappearing mount) are uncertainty and are
    // handled by the caller as a fail-closed refusal.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const sameGitIndexSnapshot = (a: GitIndexFileSnapshot, b: GitIndexFileSnapshot): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino && a.isFile === b.isFile;

/**
 * Detect and safely rebuild a torn `.git/index` before any status/submodule
 * census can mistake the checkout for a clean tree.
 *
 * The repair is intentionally narrow and non-destructive: only an existing
 * regular index shorter than the fixed header+checksum floor is eligible, and
 * `git read-tree HEAD` rebuilds the replaceable index without changing the
 * working tree. Before invoking it we prove that no process has the index open,
 * no `index.lock` exists, and the file did not change during inspection. Any
 * unknown/live state refuses the repair. The default `runGit` supplied by
 * `runGitSync` is the bounded runner, so the read-tree itself cannot wedge a
 * scheduled tick; injected runners remain available for deterministic tests.
 */
export async function preflightInvalidIndex(
  runGit: RunGit,
  repoPath: string,
  log: (message: string) => void,
  deps: InvalidIndexPreflightDeps = {},
): Promise<InvalidIndexPreflightResult> {
  const minimumBytes = Math.max(1, Math.floor(deps.minimumBytes ?? MIN_VALID_GIT_INDEX_BYTES));
  const inspectFile = deps.inspectFile ?? defaultIndexFileSnapshot;
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;

  let gitDirResult: GitCommandResult;
  try {
    gitDirResult = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  } catch (error) {
    // A caller-supplied fake or a path that is not a Git checkout cannot be
    // preflighted. Preserve the existing fail-soft behavior for that case; a
    // real canonical checkout always resolves this command successfully.
    return { status: 'unavailable', reason: `could not resolve the Git directory: ${String(error)}` };
  }
  const gitDir = gitDirResult.stdout.trim();
  if (gitDirResult.code !== 0 || !gitDir) {
    return {
      status: 'unavailable',
      reason: `could not resolve the Git directory: ${(gitDirResult.stderr || gitDirResult.stdout || 'unknown error').trim()}`,
    };
  }

  const indexPath = join(gitDir, 'index');
  const lockPath = join(gitDir, 'index.lock');
  const refuse = (
    reason: string,
    status: 'refused' | 'error' = 'refused',
    previousSize?: number,
  ): InvalidIndexPreflightResult => {
    log(
      `[git-sync] ${repoPath}: refusing invalid Git index preflight — ${reason}; leaving the index and working tree untouched`,
    );
    return { status, indexPath, reason, previousSize, minimumBytes };
  };
  const inspect = async (path: string): Promise<GitIndexFileSnapshot | null | 'unknown'> => {
    try {
      return await inspectFile(path);
    } catch {
      return 'unknown';
    }
  };

  const before = await inspect(indexPath);
  if (before === 'unknown') return refuse(`could not inspect ${indexPath}`);
  if (before === null) return { status: 'absent', indexPath, minimumBytes };
  if (before.isFile === false) return refuse(`${indexPath} is not a regular file`, 'error', before.size);
  if (before.size >= minimumBytes) return { status: 'valid', indexPath, size: before.size, minimumBytes };

  // The lock's mere presence is enough to refuse: even a stale-looking lock
  // may belong to a writer whose descriptor we cannot observe. Existing
  // index.lock recovery remains responsible for its own age-checked path.
  const lock = await inspect(lockPath);
  if (lock === 'unknown') return refuse(`could not determine whether ${lockPath} exists`, 'refused', before.size);
  if (lock !== null) {
    let lockOpen: boolean | null = null;
    try {
      lockOpen = await isOpen(lockPath);
    } catch {
      // Unknown is deliberately retained in the message below.
      lockOpen = null;
    }
    return refuse(
      `${lockPath} is present${lockOpen === true ? ' and open by a writer' : lockOpen === null ? ' (writer state unknown)' : ''}`,
      'refused',
      before.size,
    );
  }

  let open: boolean | null;
  try {
    open = await isOpen(indexPath);
  } catch {
    open = null;
  }
  if (open !== false) {
    return refuse(
      open === true ? `${indexPath} is open by a live writer` : `could not prove that ${indexPath} has no live writer`,
      'refused',
      before.size,
    );
  }

  // Re-stat immediately before repair. A changed file may already have been
  // repaired by its owner; accept that valid replacement, but never overwrite
  // another short/torn replacement whose provenance we cannot prove.
  const stable = await inspect(indexPath);
  if (stable === 'unknown') return refuse(`could not re-stat ${indexPath} before repair`, 'refused', before.size);
  if (stable === null) return refuse(`${indexPath} disappeared during preflight`, 'refused', before.size);
  if (stable.isFile === false)
    return refuse(`${indexPath} became non-regular during preflight`, 'refused', before.size);
  if (!sameGitIndexSnapshot(before, stable)) {
    if (stable.size >= minimumBytes) {
      return { status: 'valid', indexPath, size: stable.size, minimumBytes };
    }
    return refuse(`${indexPath} changed during preflight`, 'refused', before.size);
  }

  // Repeat both safety proofs after the re-stat so a lock/writer that appeared
  // during the first inspection cannot be clobbered by read-tree.
  const lockBeforeRepair = await inspect(lockPath);
  if (lockBeforeRepair === 'unknown')
    return refuse(`could not re-check ${lockPath} before repair`, 'refused', before.size);
  if (lockBeforeRepair !== null) return refuse(`${lockPath} appeared during preflight`, 'refused', before.size);
  try {
    open = await isOpen(indexPath);
  } catch {
    open = null;
  }
  if (open !== false) {
    return refuse(
      open === true
        ? `${indexPath} became open by a live writer during preflight`
        : `writer state for ${indexPath} became unknown during preflight`,
      'refused',
      before.size,
    );
  }

  let repair: GitCommandResult;
  try {
    // This is the bounded local git seam in production (`runGitBounded` via
    // runGitSync); never use execFileSync here, which could wedge the routine.
    repair = await runGit(['read-tree', 'HEAD'], repoPath);
  } catch (error) {
    return refuse(`bounded git read-tree HEAD threw: ${String(error)}`, 'error', before.size);
  }
  if (repair.code !== 0) {
    return refuse(
      `bounded git read-tree HEAD failed: ${(repair.stderr || repair.stdout || `exit ${repair.code}`).trim().slice(0, 300)}`,
      'error',
      before.size,
    );
  }

  const after = await inspect(indexPath);
  if (after === 'unknown' || after === null || after.isFile === false || after.size < minimumBytes) {
    return refuse(`git read-tree HEAD completed but ${indexPath} is still invalid`, 'error', before.size);
  }
  const lockAfterRepair = await inspect(lockPath);
  if (lockAfterRepair === 'unknown' || lockAfterRepair !== null) {
    return refuse(`${lockPath} remained after git read-tree HEAD`, 'error', before.size);
  }
  log(
    `[git-sync] ${repoPath}: repaired invalid Git index (${before.size} bytes < ${minimumBytes}) via bounded git read-tree HEAD; working-tree content was preserved`,
  );
  return { status: 'repaired', indexPath, previousSize: before.size, size: after.size, minimumBytes };
}

export interface TempPackScavengeDeps {
  now?: () => number;
  staleMs?: number;
  isOpen?: (path: string) => Promise<boolean | null>;
  unlinkFile?: (path: string) => Promise<void>;
}

/**
 * Remove only crash-left temp packs. Every deletion requires all of these proofs:
 * the entry is an old regular `tmp_pack_*` file, has no Git sidecar/reference or
 * hard link, no process has it open, and its size/mtime/type remain unchanged across
 * a second stat. Unknown open-state is fail-closed. This is intentionally separate
 * from failed-fetch cleanup: that path is same-attempt freshness based and remains
 * unchanged so it cannot delete a peer's pre-existing file.
 */
export async function scavengeStaleTempPacks(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: TempPackScavengeDeps = {},
): Promise<{ removed: string[]; bytesReclaimed: number }> {
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_TEMP_PACK_MS;
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;
  const unlinkFile = deps.unlinkFile ?? unlink;
  const { gitDir, entries } = await listTempPackEntries(runGit, repoPath);
  if (!gitDir) return { removed: [], bytesReclaimed: 0 };
  const packDir = join(gitDir, 'objects', 'pack');
  const removed: string[] = [];
  let bytesReclaimed = 0;
  const nowMs = now();

  for (const entry of entries) {
    if (entry.mtimeMs > nowMs - staleMs || entry.mtimeMs > nowMs) continue;
    const path = join(packDir, entry.name);
    try {
      if (await tempPackHasReferences(gitDir, entry)) continue;
      if ((await isOpen(path)) !== false) continue;
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.size !== entry.size ||
        current.mtimeMs !== entry.mtimeMs ||
        current.nlink > 1 ||
        (await tempPackHasReferences(gitDir, {
          ...entry,
          size: current.size,
          mtimeMs: current.mtimeMs,
          nlink: current.nlink,
        })) ||
        (await isOpen(path)) !== false
      )
        continue;
      await unlinkFile(path);
      removed.push(entry.name);
      bytesReclaimed += entry.size;
    } catch (e) {
      log(
        `[git-sync] ${repoPath}: could not prune stale temp pack ${entry.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { removed, bytesReclaimed };
}

export async function pruneFailedFetchTempPacks(
  runGit: RunGit,
  repoPath: string,
  beforeFetch: Map<string, number>,
  log: (m: string) => void,
): Promise<{ removed: string[]; bytesReclaimed: number }> {
  const afterFetch = await listTempPackFiles(runGit, repoPath);
  const removed: string[] = [];
  let bytesReclaimed = 0;
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  const gitDir = gd.code === 0 ? gd.stdout.trim() : '';
  if (!gitDir) return { removed, bytesReclaimed };
  const packDir = join(gitDir, 'objects', 'pack');

  for (const [name, size] of afterFetch) {
    if (beforeFetch.has(name)) continue;
    try {
      // `lstat` + the anchored name filter keep this unlink scoped to a regular
      // temp pack in THIS repo's object store; symlinks and directories are left.
      const current = await lstat(join(packDir, name));
      if (!current.isFile()) continue;
      await unlink(join(packDir, name));
      removed.push(name);
      bytesReclaimed += size;
    } catch (e) {
      log(
        `[git-sync] ${repoPath}: could not prune failed-fetch temp pack ${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { removed, bytesReclaimed };
}

/** `git submodule status` row → path. Row is "<flag><sha> <path> (<describe>)". */
const submoduleStatusRowPath = (l: string): string | undefined => l.slice(1).trim().split(/\s+/)[1];

/**
 * The strand census itself, over ALREADY-FETCHED `git submodule status --recursive`
 * lines. Extracted (EI-20459175302238839) so the release preflight can measure the
 * SAME condition without running a sync pass — one copy of the logic, never two.
 *
 * Callers must preserve the measured-vs-unmeasured distinction themselves: this
 * returns the census for lines it was GIVEN, so handing it the empty list from a
 * FAILED `submodule status` would manufacture a false all-clear. Both callers below
 * only reach it on the exit-0 path.
 */
const strandCensusFromStatusLines = async (
  runGit: RunGit,
  repo: string,
  lines: string[],
  log: (msg: string) => void = () => {},
): Promise<StrandedSubmodule[]> => {
  // EI-20402093158205519: a '-' row means only that `submodule.<name>.url` is absent from
  // .git/config (`git submodule init` never ran). It says NOTHING about whether the
  // worktree is POPULATED — and a populated one can hold real, uncommitted agent work.
  // This path's test is therefore strictly WEAKER than the .gitmodules fallback below,
  // which lstats `<path>/.git`; and because the fallback runs ONLY when discovery FAILS,
  // the weak test governs the normal (exit 0) case. Measured on the sidestage tree
  // 2026-08-14: 7 of 8 submodules '-'-prefixed but fully populated, discovery returned
  // exactly 1 path, and three tracked files sat uncommitted with no error on any tick —
  // git-sync never visited those repos at all. Silence is the defect: SAY SO. Reporting
  // (not auto-syncing) is deliberate — these worktrees are commonly parked on deliberate
  // detached pins, so pulling them into the normal path would fetch/merge/push and UNPIN
  // them. Registering is the operator's call; losing the work silently is not.
  const stranded: StrandedSubmodule[] = [];
  for (const l of lines) {
    if (l[0] !== '-') continue;
    const p = submoduleStatusRowPath(l);
    if (!p) continue;
    try {
      await lstat(join(repo, p, '.git')); // populated worktree, just unregistered
    } catch {
      continue; // genuinely uninitialized — nothing on disk to strand
    }
    const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=no'], join(repo, p));
    // Count TRACKED modifications only: scratch/untracked churn (e.g. .vitest-tmp/) would
    // otherwise cry wolf on every tick that a test run happens to be in flight.
    const rows = dirty.code === 0 ? dirty.stdout.split('\n').filter(Boolean) : [];
    if (rows.length > 0) {
      stranded.push({
        path: p,
        trackedFiles: rows.length,
        // Porcelain v1 row is "XY <path>"; keep the paths so the escalation can name the
        // actual files a human must rescue, not just a count they then have to go find.
        files: rows.slice(0, 20).map((r) => r.slice(3).trim()),
      });
    }
  }
  if (stranded.length > 0) {
    const list = stranded.map((s) => `${s.path} (${s.trackedFiles} tracked file(s))`).join(', ');
    log(
      `[git-sync] ⚠ STRANDED WORK: ${stranded.length} POPULATED but UNREGISTERED submodule(s) hold uncommitted tracked changes ` +
        `that git-sync cannot see and will NEVER commit: ${list} — ` +
        `they are absent from .git/config (no submodule.<name>.url), so 'git submodule status' marks them '-' and discovery skips them. ` +
        `Fix with: git submodule init <path> (idempotent; copies the .gitmodules URL into .git/config), then re-check the pin before the next tick.`,
    );
  }
  return stranded;
};

/**
 * EI-20459175302238839: measure the strand census for `repo` WITHOUT running a sync
 * pass — the read a release/deploy preflight needs, since a strand means the committed
 * state a release artifact is built FROM is missing work that exists only on this box.
 *
 * Returns `null` for NOT MEASURED (`git submodule status` failed), deliberately distinct
 * from `[]` (measured, nothing stranded) — the same contract as
 * `GitSyncOutcome.strandedSubmodules`. A consumer that collapses the two reintroduces
 * exactly the silence this census exists to break, so callers must branch on `null`
 * explicitly rather than treating a falsy/empty result as an all-clear.
 */
export const censusStrandedSubmodules = async (
  runGit: RunGit,
  repo: string,
  log: (msg: string) => void = () => {},
): Promise<StrandedSubmodule[] | null> => {
  const r = await runGit(['submodule', 'status', '--recursive'], repo);
  if (r.code !== 0) {
    log(
      `[strand-census] submodule discovery FAILED in ${repo} (${(r.stderr || r.stdout || 'no output').trim().slice(0, 200)}) — ` +
        `census NOT MEASURED (null); this is not an all-clear.`,
    );
    return null;
  }
  return strandCensusFromStatusLines(runGit, repo, r.stdout.split('\n').filter(Boolean), log);
};

/**
 * Recursively discover submodule paths (repo-relative), DEEPEST-FIRST. Dynamic —
 * reads the live submodule tree (`git submodule status --recursive`), never a
 * hardcoded list. Skips uninitialized submodules (leading '-'). Deepest-first so a
 * child lands on its origin before a parent's pointer to it is pushed.
 */
// Exported for the stray-gitlink fallback regression test (2026-07-01).
export const discoverSubmodulesRecursive = async (
  runGit: RunGit,
  repo: string,
  log: (msg: string) => void = () => {},
  /** EI-20402093158205519: receives the strand census whenever this pass actually MEASURED
   *  it (the `git submodule status` exit-0 path), including the empty result — an empty
   *  census is a real all-clear the caller uses to clear a stale escalation. Deliberately
   *  NOT called on the discovery-failure fallback: we did not measure, and reporting an
   *  unmeasured [] there would read as an all-clear and silently retire a live warning. */
  onStrandCensus?: (stranded: StrandedSubmodule[]) => void,
): Promise<string[]> => {
  const r = await runGit(['submodule', 'status', '--recursive'], repo);
  if (r.code === 0) {
    const lines = r.stdout.split('\n').filter(Boolean);
    const paths = lines
      .filter((l) => l[0] !== '-') // skip uninitialized
      .map(submoduleStatusRowPath)
      .filter((p): p is string => Boolean(p));
    // The census body lives in `strandCensusFromStatusLines` (EI-20459175302238839) so the
    // release preflight can measure the SAME condition without running a sync pass — one
    // copy of the logic, and the same single `submodule status` call on this path.
    //
    // MUST be computed on its own statement, NOT inline as `onStrandCensus?.(await …)`:
    // an optional CALL short-circuits its own ARGUMENTS, so with no callback supplied the
    // census would never run and its ⚠ STRANDED WORK log would silently vanish — which is
    // the warning this whole mechanism exists to emit. The log is the point; the callback
    // is only delivery.
    const stranded = await strandCensusFromStatusLines(runGit, repo, lines, log);
    // Fire even when EMPTY: the caller needs the all-clear to retire a stale escalation.
    // Only on this (measured) path — see the param doc.
    onStrandCensus?.(stranded);
    return paths.sort((a, b) => b.split('/').length - a.split('/').length);
  }
  // ONE stray index gitlink with no .gitmodules mapping (e.g. a test's temp repo swept in
  // by an auto-commit) makes `git submodule status --recursive` exit 128 — and a silent []
  // here strands EVERY submodule's commits, every tick, while the routine keeps reporting
  // "synced" (2026-07-01: `.papercusp/scratch/tmp/relgit-*` did exactly this for days).
  // Never silently skip the pass: SAY SO, then fall back to the .gitmodules mapping
  // (authoritative for top-level paths; nested submodules wait until the stray is removed —
  // `git rm --cached <stray-path>` is the operator fix, named in the log line).
  log(
    `[git-sync] submodule discovery FAILED (${(r.stderr || r.stdout || 'no output').trim().slice(0, 200)}) — ` +
      `falling back to .gitmodules top-level paths; if this names a stray gitlink, fix with: git rm --cached <path>`,
  );
  const cfg = await runGit(['config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`], repo);
  if (cfg.code !== 0) return [];
  const paths: string[] = [];
  for (const line of cfg.stdout.split('\n')) {
    const p = line.trim().split(/\s+/)[1];
    if (!p) continue;
    try {
      await lstat(join(repo, p, '.git')); // initialized submodules only (worktree has .git)
      paths.push(p);
    } catch {
      /* uninitialized — skip */
    }
  }
  return paths.sort((a, b) => b.split('/').length - a.split('/').length);
};

/** One `git stash` entry, identified by its underlying commit SHA (stable across
 *  ticks — unlike `stash@{N}`, which is purely POSITIONAL and shifts whenever an
 *  older entry is popped/dropped). */
export interface StashEntry {
  sha: string;
  subject: string;
  /** Committer date of the stash commit, ISO-8601 (`%cI`), or '' when git omitted it.
   *  EI-19449313204576061: WITHOUT this the detector can only report "not in my
   *  baseline", which it then RENDERED as "🚨 NEW" — a conclusion about creation time
   *  it had never observed. A stash's age is the decisive falsifier and costs one
   *  extra `--format` token, so it is carried on the entry rather than re-derived. */
  createdAt: string;
}

/**
 * WI-3072 (recurrence guard for the EI-7685 class — an agent ran `git stash` on the
 * shared staging tree and it silently sat there looking like vanished work): list
 * one repo's current stash entries. Read-only, never throws — a `git stash list`
 * failure (odd env, detached/bare repo) reads as empty, same fail-open posture as
 * the other best-effort git-sync primitives in this file.
 */
export async function listStashEntries(runGit: RunGit, repoPath: string): Promise<StashEntry[]> {
  const r = await runGit(['stash', 'list', '--format=%H%x1f%cI%x1f%s'], repoPath);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // Subject is LAST and may itself contain the separator in pathological cases —
      // take the first two fields positionally and rejoin the remainder.
      const parts = line.split('\x1f');
      const sha = parts[0] ?? '';
      const createdAt = parts[1] ?? '';
      const subject = parts.slice(2).join('\x1f');
      return { sha, createdAt, subject };
    })
    .filter((e) => e.sha.length > 0);
}

/** How recent a stash must be for the watchdog to treat it as live, at-risk work.
 *  git-sync ticks every few minutes, so anything stashed within a day is plausibly a
 *  current agent's in-flight work (the EI-7685 case the detector exists for); older
 *  than that is archaeology, and calling it "NEW" is what trained agents to reach for
 *  `stash pop`/`drop` on a shared tree. */
export const STASH_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: split not-yet-known stash entries into the ones that are genuinely RECENT
 * (worth an urgent broadcast) and the ones that merely became VISIBLE to the detector
 * now despite predating it (worth a quiet notice at most).
 *
 * EI-19449313204576061: "not in my baseline" and "new" are different claims, and the
 * detector only ever observed the first. An entry with an unparseable/absent date is
 * treated as RECENT — fail toward surfacing, never toward silently swallowing a real
 * stash, since a missed genuine stash is the expensive direction (EI-7685).
 */
export function partitionStashEntriesByAge<T extends StashEntry>(
  entries: readonly T[],
  nowMs: number,
  recentWindowMs: number = STASH_RECENT_WINDOW_MS,
): { recent: T[]; preExisting: T[] } {
  const recent: T[] = [];
  const preExisting: T[] = [];
  for (const e of entries) {
    const t = e.createdAt ? Date.parse(e.createdAt) : Number.NaN;
    if (Number.isNaN(t) || nowMs - t <= recentWindowMs) recent.push(e);
    else preExisting.push(e);
  }
  return { recent, preExisting };
}

/** Human-readable age for an alarm line — the field whose absence let a 13-week-old
 *  stash read as an emergency. Returns 'unknown age' when the date is missing. */
export function describeStashAge(entry: StashEntry, nowMs: number): string {
  const t = entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN;
  if (Number.isNaN(t)) return 'unknown age';
  const days = Math.floor((nowMs - t) / (24 * 60 * 60 * 1000));
  if (days >= 1) return `created ${entry.createdAt.slice(0, 10)}, ${days}d old`;
  const hours = Math.floor((nowMs - t) / (60 * 60 * 1000));
  return `created ${entry.createdAt.slice(0, 10)}, ${hours}h old`;
}

/** Pure: which of `current`'s stash entries were never in `knownShas` — i.e. genuinely
 *  NEW since the last check. Exported so the comparison logic is unit-testable with
 *  zero git subprocess involved (mirrors the other pure `*FromRows`/`*From*` helpers
 *  in this codebase). */
export function newStashEntries(current: StashEntry[], knownShas: readonly string[]): StashEntry[] {
  const known = new Set(knownShas);
  return current.filter((e) => !known.has(e.sha));
}

type RepoSyncResult = {
  /** Dirty paths measured before this repo's commit stage. */
  dirtyPathCount: number;
  /** Local commits created by this repo during this pass. */
  committedCount: number;
  oversized: OversizedFile[];
  contentErrors: ContentOffender[];
  mergeCompleted?: boolean;
  skippedPaths?: GitSyncSkippedPath[];
} & (
  | { status: 'nothing' }
  | { status: 'synced'; pushed: boolean; merged: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'skipped-locked' }
  | { status: 'error'; message: string }
);

/**
 * Dirty (modified/untracked) files exceeding maxBytes — detected BEFORE `add -A` so
 * the auto-commit can EXCLUDE them (EI-18: GitHub hard-rejects >100MB blobs, and one
 * committed oversized blob makes the unpushed range permanently unpushable; recovery
 * is manual history surgery). Uses `status --porcelain -z` (NUL-separated, unquoted —
 * robust to spaces/specials in paths) with `-uall` (P-001): WITHOUT it a brand-new
 * directory collapses to a single `?? dir/` entry whose `lstat` is a directory and is
 * skipped, hiding an oversized file INSIDE it — then `add -A` commits it and wedges the
 * push forever (the exact EI-18 incident class). `-uall` lists every untracked file
 * individually so each oversized blob is seen + excluded.
 */
// Exported for the exact-boundary table test (test-coverage-gap G22): the size
// comparison is strict `>` — a file AT maxBytes must be INCLUDED, not excluded.
export async function findOversizedDirtyFiles(
  runGit: RunGit,
  repoPath: string,
  maxBytes: number,
): Promise<OversizedFile[]> {
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out: OversizedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) continue; // deletions have no blob to size
    try {
      const st = await lstat(join(repoPath, path));
      if (st.isFile() && st.size > maxBytes) out.push({ path, sizeBytes: st.size });
    } catch {
      /* a racing build artifact vanished mid-pass — nothing to commit, skip */
    }
  }
  return out;
}

/**
 * WI-5738 — the CUMULATIVE sibling of `findOversizedDirtyFiles`, and the gate
 * that should have stopped the 2026-07-20 incident at source.
 *
 * `findOversizedDirtyFiles` is PER-FILE. On 2026-07-20 an extracted AppImage
 * was auto-committed as **2,261 MB across thousands of files** whose largest
 * single blob was 90.3 MB — comfortably under the 95 MB per-file cap. Every
 * file passed individually, the whole thing was committed, and the aggregate
 * then breached the publish guard's 500 MB TOTAL cap one layer downstream,
 * where the only available response was to refuse (terminally). The per-file
 * cap cannot see a bulk accident; the total cap can only see it too late.
 *
 * So: measure the aggregate HERE, where the response is still cheap and
 * correct — exclude the files from the commit and leave them dirty, exactly as
 * the oversized/content guards already do ("quarantine, don't stall"): the
 * offending tree is peeled off and the fleet's real work still commits this tick.
 *
 * ORDERING (EI-21906459740652039). This used to peel purely largest-first, on the
 * stated premise that "a bulk accident is dominated by a few big artifacts while
 * genuine source edits are small". That premise is right about ACCIDENTS and wrong
 * about this repo: the largest dirty-file class here is not an accident, it is the
 * legitimate generated docs mirror. Measured 2026-08-30, 81 of 95 dirty files —
 * and all 20 of the largest — were `apps/operator/public/internal/docs/**`, so
 * largest-first peeled essentially the whole mirror EVERY time the cap tripped, by
 * construction. A `npm run docs:rebuild` therefore sat uncommitted for 13h while
 * git-sync reported success, and the served docs went stale under every agent that
 * read them.
 *
 * The premise is repaired, not abandoned: rank by "is this an UNEXPECTED artifact"
 * rather than by raw size. Declared regenerable projections are peeled LAST — only
 * once peeling every unexpected artifact still leaves the set over the cap — so the
 * guard's real purpose (a stray 90MB blob, a 2,261MB extracted AppImage) is intact
 * while a declared generated output is never starved by it.
 *
 * Deliberately NOT a hard failure: a legitimately large commit is possible, and
 * refusing to commit at all would just relocate the wedge upstream.
 */
export async function findBulkDirtyExcess(
  runGit: RunGit,
  repoPath: string,
  maxTotalBytes: number,
  alreadyExcluded: ReadonlySet<string> = new Set(),
): Promise<OversizedFile[]> {
  const paths = await dirtyFiles(runGit, repoPath);
  const sized: OversizedFile[] = [];
  let total = 0;
  for (const path of paths) {
    if (alreadyExcluded.has(path)) continue; // its bytes are not being committed
    try {
      const st = await lstat(join(repoPath, path));
      if (!st.isFile()) continue;
      sized.push({ path, sizeBytes: st.size });
      total += st.size;
    } catch {
      /* a racing build artifact vanished mid-pass — nothing to commit, skip */
    }
  }
  if (total <= maxTotalBytes) return [];
  // Peel the largest until the remainder fits — but a DECLARED regenerable
  // projection is only eligible once every unexpected artifact has been peeled and
  // the set is still over the cap (EI-21906459740652039; see the header).
  sized.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const excluded: OversizedFile[] = [];
  const deferredProjections: OversizedFile[] = [];
  const probe = { spent: 0 };
  for (const f of sized) {
    if (total <= maxTotalBytes) break;
    if (await isRegenerableProjection(repoPath, f.path, probe)) {
      deferredProjections.push(f);
      continue;
    }
    excluded.push({ ...f, exclusionReason: 'cumulative-limit' });
    total -= f.sizeBytes;
  }
  for (const f of deferredProjections) {
    if (total <= maxTotalBytes) break;
    excluded.push({ ...f, exclusionReason: 'cumulative-limit' });
    total -= f.sizeBytes;
  }
  return excluded;
}

/**
 * EI-21906459740652039 — the ONE tracked tree that is a build MIRROR rather than a
 * source of truth. Its canonical source is `apps/operator-docs/src/content/docs` (or
 * the docs datastore via `docs:author`), and `npm run docs:rebuild` regenerates it
 * wholesale. It needs a declared prefix rather than the self-declaring banner below
 * for exactly the reason the PreToolUse generated-file guard has to special-case the
 * same tree: most of its artifacts predate the banner convention, and many (pagefind
 * fragments, images) are binary and can never carry one.
 */
const INTERNAL_DOCS_MIRROR_PREFIX = 'apps/operator/public/internal/docs/';

/** Head bytes / lines / line-length of the self-declaring generated-artifact banner —
 *  the same measured predicate the PreToolUse generated-file guard keys on, so a file
 *  that opts IN there is automatically protected here too, with no second list to
 *  maintain. The 300-char line cap is load-bearing: without it a minified `.js.map`
 *  matches on a banner embedded inside its `sourcesContent` blob. */
const GENERATED_BANNER_SCAN_BYTES = 4096;
const GENERATED_BANNER_SCAN_LINES = 10;
const GENERATED_BANNER_MAX_LINE_CHARS = 300;
/** Cap on how many files one peel may OPEN to ask the banner question. Beyond it the
 *  answer degrades to the prefix rules alone (i.e. back to today's largest-first
 *  behaviour), so a pathological dirty set of hundreds of thousands of small files can
 *  never turn a size guard into an I/O storm. */
const GENERATED_BANNER_PROBE_BUDGET = 500;

/** PURE: does this header DECLARE the file a generated artifact? Both tokens must sit
 *  on ONE line — "do not edit" alone matches prose about something else, "generated"
 *  alone matches any file that discusses generation. */
export function declaresGeneratedBanner(head: string): boolean {
  const lines = head.split('\n', GENERATED_BANNER_SCAN_LINES);
  for (const raw of lines) {
    if (raw.length > GENERATED_BANNER_MAX_LINE_CHARS) continue;
    const l = raw.toLowerCase();
    if (!l.includes('generated')) continue;
    if (l.includes('do not edit') || l.includes("don't edit") || l.includes('do-not-edit')) return true;
  }
  return false;
}

/**
 * Is this dirty path a DECLARED, regenerable projection — something whose absence from
 * a commit costs a `npm run <generator>` rather than lost work? Used only to ORDER the
 * cumulative peel (above); it never excludes anything by itself, so a false positive
 * costs at most that one file being peeled later than a stray artifact would be.
 *
 * Every arm is a truth this module ALREADY declares, not a new hand-maintained list:
 * the tool-catalog artifact git-sync regenerates itself before each commit, the
 * `.d.mts` half of a generated declaration pair, the internal-docs build mirror, and —
 * self-arming, so a NEW generated artifact is covered for free — a file whose own
 * header says it is generated.
 */
export async function isRegenerableProjection(
  repoPath: string,
  path: string,
  probe: { spent: number } = { spent: 0 },
): Promise<boolean> {
  if (path === TOOL_CATALOG_ARTIFACT_PATH) return true;
  if (path.startsWith(INTERNAL_DOCS_MIRROR_PREFIX)) return true;
  if (path.endsWith('.d.mts') && generatedDeclarationPair(path) !== null) return true;
  if (probe.spent >= GENERATED_BANNER_PROBE_BUDGET) return false;
  probe.spent += 1;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(join(repoPath, path), 'r');
    const buf = Buffer.alloc(GENERATED_BANNER_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, GENERATED_BANNER_SCAN_BYTES, 0);
    return declaresGeneratedBanner(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    /* vanished mid-pass / unreadable — treat as an ordinary artifact */
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Enumerate every dirty path (modified/added/deleted/untracked), repo-relative, in the
 *  same path-space as the oversized/content excludes. `-z` keeps paths with spaces/newlines
 *  intact; a rename/copy origin path (the 2nd `-z` field) is skipped. Exported for P-004 tests. */
export async function dirtyFiles(runGit: RunGit, repoPath: string): Promise<string[]> {
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++; // -z rename/copy: skip the origin path that follows
    out.push(e.slice(3));
  }
  return out;
}

/** Enumerate the paths currently in Git's index, losslessly for legal filenames. */
async function stagedFiles(runGit: RunGit, repoPath: string): Promise<string[]> {
  const r = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], repoPath);
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * EI-22494259338317391: a negative pathspec only prevents `git add` from
 * changing the matching index entries; it does not remove an entry that was
 * staged earlier (for example by `git checkout <sha> -- <path>`). Since the
 * eventual `git commit` includes the whole index, clear only those pre-staged
 * protected entries before any attribution or catch-all staging phase.
 *
 * The working tree is intentionally untouched. The next tick can stage the
 * protected content once its lock is gone, while unrelated pre-staged work
 * remains available for this commit. `-z` keeps legal filenames lossless.
 */
async function unstagePreStagedProtectedPaths(
  runGit: RunGit,
  repoPath: string,
  excludePaths: readonly string[],
  log: (message: string) => void,
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const normalizedExcludes = [
    ...new Set(excludePaths.map((path) => path.trim().replace(/^\.\/+|\/+$/g, '')).filter(Boolean)),
  ];
  if (normalizedExcludes.length === 0) return { ok: true, paths: [] };

  const staged = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], repoPath);
  if (staged.code !== 0) {
    return {
      ok: false,
      error: `could not inspect pre-staged protected paths: ${(staged.stderr || staged.stdout).trim().slice(0, 300)}`,
    };
  }
  const protectedStaged = [
    ...new Set(
      staged.stdout
        .split('\0')
        .filter(Boolean)
        .filter((path) => normalizedExcludes.some((exclude) => gitSyncPathsOverlap(path, exclude))),
    ),
  ];
  if (protectedStaged.length === 0) return { ok: true, paths: [] };

  const unstage = await runGit(['reset', '-q', 'HEAD', '--', ...protectedStaged], repoPath);
  if (unstage.code !== 0) {
    return {
      ok: false,
      error: `could not unstage protected paths: ${(unstage.stderr || unstage.stdout).trim().slice(0, 300)}`,
    };
  }
  log(
    `[git-sync] ${repoPath}: removed ${protectedStaged.length} pre-staged protected path(s) from the commit index ` +
      `(${protectedStaged.join(', ')}) — working-tree edits remain locked`,
  );
  return { ok: true, paths: protectedStaged };
}

/** The CI-skip suffix git-sync's message carries (e.g. ` [skip ci]`), so every per-agent
 *  commit skips CI exactly like the catch-all. Empty when the message has no such marker. */
function skipCiSuffix(message: string): string {
  const m = message.match(/(\[skip ci\])\s*$/i);
  return m ? ` ${m[1]}` : '';
}

/**
 * P-004 (git-sync-dx-hardening): peel each declaring agent's dirty files into its OWN commit
 * (intent subject + a Co-Authored-By trailer), preserving the CI-skip marker. Excluded files
 * (oversized / content offenders) stay quarantined. The catch-all (agent=null) group is left
 * for the caller's existing whole-tree commit. Never throws; a real commit failure returns an
 * error. Exported for the P-004 commit-grouping test (injected runGit, no real repo).
 */
export async function commitAttributedGroups(
  runGit: RunGit,
  repoPath: string,
  attribution: Map<string, FileAttribution>,
  excludePaths: string[],
  message: string,
  opts: { diffSubjects?: boolean } = {},
): Promise<{ committedAny: boolean; committedCount: number; error?: string }> {
  const excludeSet = new Set(excludePaths);
  const dirty = (await dirtyFiles(runGit, repoPath)).filter((f) => !excludeSet.has(f));
  const groups = groupFilesForAttribution(dirty, attribution);
  const suffix = skipCiSuffix(message);
  let committedAny = false;
  let committedCount = 0;
  for (const g of groups) {
    if (g.agent === null || g.files.length === 0) continue; // catch-all handled by the caller's add -A
    await runGit(['add', '--', ...g.files], repoPath);
    // WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): the subject describes the DIFF (what this
    // commit actually contains — from the just-staged numstat); the agent's intent line
    // (the pre-WI-38594 subject) rides as the first BODY paragraph, ahead of the
    // provenance trailers, so it stays greppable without masquerading as a diff summary.
    // A failed numstat only drops the ±counts — never blocks the commit.
    let subject = g.subject;
    let intentBody: string | null = null;
    if (opts.diffSubjects !== false) {
      const ns = await runGit(['diff', '--cached', '--numstat', '--', ...g.files], repoPath);
      subject = diffDerivedSubject(g.files, ns.code === 0 ? parseNumstat(ns.stdout) : undefined);
      if (g.subject && g.subject !== DEFAULT_GIT_SYNC_SUBJECT) intentBody = g.subject;
    }
    const args = [...GIT_SYNC_IDENTITY_ARGS, 'commit', '--no-verify', '-m', `${subject}${suffix}`];
    if (intentBody) args.push('-m', intentBody);
    if (g.coAuthor) args.push('-m', `Co-Authored-By: ${g.coAuthor}`);
    // P-004 (deterministic-commit-workitem-attribution-2026-06-22): bounded provenance
    // trailers so the commit↔work-item link travels IN git history (and is read back
    // post-sync into git_sync_commit_attribution). Deterministic — from the ledger-derived
    // attribution, no LLM (D-004/D-006).
    if (g.agent) args.push('-m', `Papercusp-Agent: ${g.agent}`);
    if (g.workItems && g.workItems.length > 0) {
      args.push('-m', `Papercusp-Work-Item: ${g.workItems.slice(0, 20).join(', ')}`);
    }
    if (g.sessionId) args.push('-m', `Papercusp-Session: ${g.sessionId}`);
    if (g.planSlug) args.push('-m', `Papercusp-Plan: ${g.planSlug}`);
    const c = await runGit(args, repoPath);
    if (c.code === 0) {
      committedAny = true;
      committedCount += 1;
    } else if (!nothingToCommit(c)) {
      return {
        committedAny,
        committedCount,
        error: `attributed commit failed: ${(c.stderr || c.stdout).trim().slice(0, 300)}`,
      };
    }
  }
  return { committedAny, committedCount };
}

/** The knobs the COMMIT half of one repo's sync needs (stage + content-guard + commit). */
interface CommitRepoOpts {
  /** Public scope name used in skipped-path diagnostics. */
  scope: string;
  remote: string;
  defaultBranch: string;
  message: string;
  maxBlobBytes: number;
  maxCommitTotalBytes: number;
  contentDetectors: ContentDetector[];
  deletionGuard: boolean;
  readText: (repoPath: string, relPath: string) => Promise<string | null>;
  writeText: (repoPath: string, relPath: string, text: string) => Promise<void>;
  log: (m: string) => void;
  staleTempPackMs: number;
  isTempPackOpen?: (path: string) => Promise<boolean | null>;
  /** Caller-supplied protected paths in THIS repo's relative coordinate space. */
  excludePaths: string[];
  /** Protected paths in this repo's coordinate space, with holder provenance. */
  protectedHoldings: GitSyncLockHolding[];
  /** Re-read live holdings immediately before staging this repo. */
  refreshLiveLockHoldings?: () => Promise<GitSyncLockHolding[]>;
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): path→agent map for THIS repo. When present
   *  + non-empty, dirty files are peeled into per-agent commits first; the catch-all
   *  `git add -A` commit (today's behavior) sweeps the remainder. Absent/empty = byte-identical
   *  to today's single commit. */
  attribution?: Map<string, FileAttribution>;
  /** Source/generated pairs that must bypass per-agent peeling and land together
   *  in the catch-all commit. They remain stageable; this is NOT an exclusion. */
  forceCatchAllPaths?: string[];
  /** WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): diff-derived commit subjects (see RunGitSyncOpts). */
  diffSubjects?: boolean;
  /** Fail-closed reservation check for newly armed migration files, before staging. */
  migrationReservationChecker?: MigrationReservationChecker;
}

/** The commit-stage seam for the shared migration reservation admission guard. */
export type MigrationReservationChecker = (dirtyPaths: readonly string[]) => Promise<void>;

const migrationPaths = (paths: readonly string[]): string[] =>
  paths.filter((path) => armedMigrationFilename(path) !== null);

async function checkMigrationReservations(
  options: CommitRepoOpts,
  paths: readonly string[],
): Promise<string | null> {
  if (!options.migrationReservationChecker) return null;
  const candidates = migrationPaths(paths);
  if (candidates.length === 0) return null;
  try {
    await options.migrationReservationChecker(candidates);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}


/** The network half intentionally needs fewer knobs than the commit half.
 * Keeping this contract narrow prevents a caller that already completed
 * `commitOneRepo` from fabricating commit-only scope/lock fields merely to fetch,
 * reconcile, and push. */
type ReconcileRepoOpts = Pick<
  CommitRepoOpts,
  'remote' | 'defaultBranch' | 'log' | 'staleTempPackMs' | 'isTempPackOpen'
> & { doPush: boolean };

/** JSON-serializable — checkpointed as the superproject `git-sync:pointer-bump` step output. */
interface CommitRepoResult {
  committedLocal: boolean;
  dirtyPathCount: number;
  committedCount: number;
  oversized: OversizedFile[];
  contentErrors: ContentOffender[];
  skippedPaths?: GitSyncSkippedPath[];
  /** A REAL add/commit failure (index.lock race, corrupt index, embedded-repo fatal) —
   *  surfaced by the caller as a repo error. `nothing to commit` is NOT an error. */
  error?: string;
}

const DEPENDENCY_GENERATION_STORE = '.papercusp/dependency-generations';

/**
 * WI-42354 made dependency-generation stores self-ignoring, but an ignore rule
 * cannot hide paths that an older git-sync already committed. Those legacy
 * index entries keep recording selector/pin heartbeat timestamps forever.
 *
 * Git-sync owns the index, so repair the residue at the same seam: remove the
 * reserved host-local store from the index while leaving every runtime byte on
 * disk. The store's own `*` ignore rule then prevents the catch-all add below
 * from reintroducing it. This is replay-safe; after the deletion commit,
 * `ls-files` returns nothing and the helper becomes a no-op.
 */
async function untrackLegacyDependencyGenerationStore(
  runGit: RunGit,
  repoPath: string,
  log: (message: string) => void,
): Promise<{ ok: true; trackedCount: number } | { ok: false; error: string }> {
  const tracked = await runGit(['ls-files', '-z', '--', DEPENDENCY_GENERATION_STORE], repoPath);
  if (tracked.code !== 0) {
    return {
      ok: false,
      error: `could not census tracked dependency-generation runtime paths: ${(tracked.stderr || tracked.stdout)
        .trim()
        .slice(0, 300)}`,
    };
  }
  const paths = tracked.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return { ok: true, trackedCount: 0 };

  const removed = await runGit(
    ['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', DEPENDENCY_GENERATION_STORE],
    repoPath,
  );
  if (removed.code !== 0) {
    return {
      ok: false,
      error: `could not untrack dependency-generation runtime paths: ${(removed.stderr || removed.stdout)
        .trim()
        .slice(0, 300)}`,
    };
  }
  log(
    `[git-sync] ${repoPath}: removed ${paths.length} legacy tracked dependency-generation runtime path(s) ` +
      'from the index; cached-only repair preserved the ignored host-local store on disk',
  );
  return { ok: true, trackedCount: paths.length };
}

/**
 * WI-1416: the COMMIT half of one repo's sync — stage (`add -A` with oversized +
 * content-guard excludes) + commit. Replay-safe by construction: on an
 * already-committed (clean) tree it is a no-op (`nothing to commit` is benign), so
 * a durable-step re-run or a reaped-and-requeued fire cannot double-commit.
 */
async function commitOneRepo(runGit: RunGit, repoPath: string, o: CommitRepoOpts): Promise<CommitRepoResult> {
  const { message } = o;
  // A routine heartbeat says only that a git call settled. Name slow pre-stage
  // phases so a live lease can be diagnosed without guessing from its age.
  let phaseStartedAt = performance.now();
  const noteSlowPhase = (phase: string): void => {
    const now = performance.now();
    const elapsedMs = Math.round(now - phaseStartedAt);
    if (elapsedMs >= 10_000) o.log(`[git-sync] ${o.scope}: slow commit pre-stage ${phase} (${elapsedMs}ms)`);
    phaseStartedAt = now;
  };
  let committedLocal = false;
  let committedCount = 0;
  let oversized: OversizedFile[] = [];
  let contentErrors: ContentOffender[] = [];
  let skippedPaths: GitSyncSkippedPath[] = [];
  // A torn index makes `git status` report an empty census and would therefore
  // strand every working-tree edit. Preflight before the first status call for
  // both the superproject and each submodule. The helper is idempotent, so the
  // root-level preflight (needed before submodule discovery) may have already
  // established a valid index.
  const indexPreflight = await preflightInvalidIndex(runGit, repoPath, o.log);
  noteSlowPhase('index preflight');
  if (indexPreflight.status === 'refused' || indexPreflight.status === 'error') {
    return {
      committedLocal: false,
      dirtyPathCount: 0,
      committedCount,
      error: `invalid-index preflight refused the commit: ${indexPreflight.reason}`,
      oversized,
      contentErrors,
      skippedPaths: [],
    };
  }
  const dependencyGenerationRepair = await untrackLegacyDependencyGenerationStore(runGit, repoPath, o.log);
  noteSlowPhase('dependency generation repair');
  if (!dependencyGenerationRepair.ok) {
    return {
      committedLocal: false,
      dirtyPathCount: 0,
      committedCount,
      error: dependencyGenerationRepair.error,
      oversized,
      contentErrors,
      skippedPaths: [],
    };
  }
  const dirty = await dirtyFiles(runGit, repoPath);
  noteSlowPhase('dirty census');
  const dirtyPathCount = dirty.length;
  const migrationCandidates = migrationPaths(dirty);
  const preStageMigrationError = await checkMigrationReservations(o, migrationCandidates);
  noteSlowPhase('migration reservation');
  if (preStageMigrationError) {
    // A migration may have been staged by an earlier process before this tick's
    // reservation check. Remove only the refused migration paths; leave every
    // unrelated index entry and every working-tree byte recoverable for the next
    // tick.
    const unstage = await unstagePreStagedProtectedPaths(runGit, repoPath, migrationCandidates, o.log);
    const unstageError = unstage.ok ? '' : `; could not unstage refused migration paths: ${unstage.error}`;
    o.log(
      `[git-sync] ${o.scope}: migration reservation preflight refused ${migrationCandidates.join(', ')}: ` +
        `${preStageMigrationError}${unstageError}`,
    );
    return {
      committedLocal: false,
      dirtyPathCount,
      committedCount,
      error: `migration reservation preflight failed: ${preStageMigrationError}${unstageError}`,
      oversized,
      contentErrors,
      skippedPaths,
    };
  }
  const hasDirtyFiles = await isDirty(runGit, repoPath);
  noteSlowPhase('dirty check');
  if (hasDirtyFiles) {
    const attachment = await ensureBranchAttachedForCommit(runGit, repoPath, o.remote, o.defaultBranch, o.log);
    noteSlowPhase('branch attachment');
    if ('error' in attachment) {
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount,
        error: attachment.error,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
    // EI-18 guard: never bake an unpushable blob into the range. Oversized dirty
    // files are excluded from the commit (`:(exclude,literal)` pathspecs) and
    // reported; everything else still syncs this tick.
    oversized = await findOversizedDirtyFiles(runGit, repoPath, o.maxBlobBytes);
    noteSlowPhase('oversized file scan');
    // WI-5738: the CUMULATIVE gate. Individually-fine files can still add up to
    // an accident (2,261 MB of extracted AppImage in files all < 95 MB, on
    // 2026-07-20) that the downstream publish guard could then only refuse,
    // terminally. Catch it here, where excluding is enough.
    const bulk = await findBulkDirtyExcess(
      runGit,
      repoPath,
      o.maxCommitTotalBytes,
      new Set(oversized.map((f) => f.path)),
    );
    noteSlowPhase('bulk size scan');
    if (bulk.length > 0) {
      o.log(
        `[git-sync] cumulative dirty set exceeds ${o.maxCommitTotalBytes} bytes — excluding ${bulk.length} large file(s) ` +
          `from this commit (left dirty): ${bulk
            .slice(0, 5)
            .map((f) => `${f.path} (${f.sizeBytes}B)`)
            .join('; ')}`,
      );
      oversized = [...oversized, ...bulk];
    }
    // EI-438 content guard (P-001/P-002, D-001): a dirty file that fails a content
    // detector (an .mdx that won't compile, a curly quote used as code) is EXCLUDED
    // from this commit and left dirty for the content-fixer — so one broken file
    // never stalls the rest of the tree's commit (quarantine, don't stall). Fails
    // OPEN: a throwing detector is skipped, never a blocker.
    contentErrors = await detectContentOffenders({
      runGit,
      repoPath,
      readText: (rel) => o.readText(repoPath, rel),
      writeText: (rel, text) => o.writeText(repoPath, rel, text),
      detectors: o.contentDetectors,
      log: o.log,
    });
    noteSlowPhase('content detectors');
    // EI-19932544083689229 quarantine-import guard (remedy #1 — ATOMICITY): a file
    // quarantined above (oversized, or excluded by a content detector — i.e. a file
    // that will have ZERO history in HEAD this tick) must not be committed WITHOUT
    // also holding back any OTHER dirty file — e.g. its own `*.test.*` sibling — that
    // imports it. Otherwise the importer commits alone and HEAD carries an
    // unresolvable relative import forever (an isolated checkout, e.g.
    // green-checkpoint's candidate build, gets the importer without its subject and
    // fails deterministically on every run). Quarantine the PAIR, never just the
    // broken half. Runs to a fixed point (a chain of dirty importers is caught too).
    //
    // Deliberately computed BEFORE the deletion guard below (not merged with its
    // output): a deletion-guard offender is a DIFFERENT shape — it excludes the
    // DELETION, so the file stays PRESENT in HEAD with its prior content, and a
    // dirty file importing it resolves FINE. Folding deletion offenders into this
    // guard's "infectious" set would falsely quarantine an unrelated clean importer.
    const preDeletionQuarantined = [...new Set([...oversized.map((f) => f.path), ...contentErrors.map((c) => c.file)])];
    // EI-17: a dirty DELETION whose module a surviving file still (relatively)
    // imports is excluded exactly like a content offender — see
    // deletion-import-guard.ts for why this can't be folded into the per-file
    // content-detector registry above (it's a cross-file check on the deletion
    // SET, not a single file's own text).
    // WI-39377: BEFORE the per-deletion import check, ask whether the deletion SET is a
    // wipe at all. detectUnsafeDeletions looks for a SURVIVING importer, so it is
    // structurally blind to a total wipe (no survivors => no finding) — which is exactly
    // how four SideStage submodules were committed down to zero-file trees and pushed.
    // Shares the deletionGuard flag: both are "should this deletion be committed?".
    if (o.deletionGuard) {
      const wipeErrors = await detectWholesaleDeletion({ runGit, repoPath, log: o.log });
      if (wipeErrors.length > 0) contentErrors = [...contentErrors, ...wipeErrors];
      noteSlowPhase('wholesale deletion guard');
    }
    if (o.deletionGuard) {
      const deletionErrors = await detectUnsafeDeletions({
        runGit,
        repoPath,
        readText: (rel) => o.readText(repoPath, rel),
        log: o.log,
      });
      if (deletionErrors.length > 0) contentErrors = [...contentErrors, ...deletionErrors];
      noteSlowPhase('unsafe deletion guard');
    }
    if (preDeletionQuarantined.length > 0) {
      const dirtyForScan = await dirtyFiles(runGit, repoPath);
      const importerErrors = await detectQuarantineImporters({
        readText: (rel) => o.readText(repoPath, rel),
        dirtyFiles: dirtyForScan,
        alreadyQuarantined: preDeletionQuarantined,
        isResolvableAtHead: (rel) => isModuleResolvableAtHead(runGit, repoPath, rel, o.log),
        log: o.log,
      });
      if (importerErrors.length > 0) contentErrors = [...contentErrors, ...importerErrors];
      noteSlowPhase('quarantined importer guard');
    }
    // The action's initial lock census protects the setup window, but the
    // submodule and guard phases above can take long enough for a peer to
    // acquire another edit lock. Refresh as late as possible, before any
    // attribution add or catch-all staging command, and fail closed if the
    // lock plane cannot be read.
    let protectedHoldings = o.protectedHoldings;
    let effectiveExcludePaths = [...o.excludePaths, ...protectedHoldings.map((holding) => holding.path)];
    if (o.refreshLiveLockHoldings) {
      let refreshedHoldings: GitSyncLockHolding[];
      try {
        refreshedHoldings = await o.refreshLiveLockHoldings();
        noteSlowPhase('live lock refresh');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        o.log(`[git-sync] ${o.scope}: live lock refresh failed (fail-closed) — ${detail}`);
        return {
          committedLocal: false,
          dirtyPathCount,
          committedCount,
          error: `live lock refresh failed (fail-closed): ${detail}`,
          oversized,
          contentErrors,
          skippedPaths,
        };
      }
      // The strict lock-plane read is authoritative, including releases. A
      // union with the setup snapshot would strand completed edits for the
      // rest of a long tick. Keep explicit exclusions separate from holdings.
      const byPath = new Map<string, GitSyncLockHolding>();
      for (const holding of refreshedHoldings) {
        const path = holding.path.trim();
        if (path.length > 0) byPath.set(path, { ...holding, path });
      }
      protectedHoldings = [...byPath.values()];
      effectiveExcludePaths = [
        ...new Set([...o.excludePaths, ...refreshedHoldings.map((holding) => holding.path.trim()).filter(Boolean)]),
      ];
    }
    const directSkippedHoldings = protectedHoldings.filter((holding) =>
      dirty.some((file) => gitSyncPathsOverlap(file, holding.path)),
    );
    const atomicExclusions = expandAtomicLiveLockExclusions(dirty, protectedHoldings, o.attribution);
    skippedPaths = directSkippedHoldings.map((holding) => ({
      scope: o.scope,
      path: holding.path,
      owner: holding.owner,
      intent: holding.intent,
    }));
    if (skippedPaths.length > 0) {
      o.log(
        `[git-sync] ${o.scope}: excluding live-locked dirty path(s) while committing the unlocked remainder: ` +
          skippedPaths.map((p) => `${p.path} (${p.owner}: ${p.intent})`).join('; '),
      );
      if (atomicExclusions.groups.some((group) => group.paths.length > 1)) {
        o.log(
          `[git-sync] ${o.scope}: keeping ${atomicExclusions.groups.length} live edit cohort(s) atomic ` +
            `(owner + goal_ref); deferring grouped dirty path(s): ` +
            atomicExclusions.groups
              .filter((group) => group.paths.length > 1)
              .map((group) => `${group.owner}/${group.goalRef} [${group.paths.join(', ')}]`)
              .join('; '),
        );
      }
    }
    // A live lock can protect either a new module or a changed export in a
    // tracked module. In both cases, publishing a dirty importer alone can
    // produce an incomplete HEAD. Hold dirty importers and their transitive
    // chain whenever their dependency is excluded by a live lock. Unlike the
    // content guard above, resolving the old module at HEAD is not enough:
    // its old exports may not satisfy the importer's new symbols.
    if (atomicExclusions.paths.length > 0) {
      const liveLockImporterErrors = await detectQuarantineImporters({
        readText: (rel) => o.readText(repoPath, rel),
        dirtyFiles: dirty,
        alreadyQuarantined: atomicExclusions.paths,
        exclusionLabel: 'live-lock exclusion',
        log: o.log,
      });
      if (liveLockImporterErrors.length > 0) contentErrors = [...contentErrors, ...liveLockImporterErrors];
      noteSlowPhase('live lock importer guard');
    }
    // Exclude BOTH oversized + content offenders (incl. unsafe deletions + quarantined
    // importers) from the auto-commit (deduped — a file can be both). Everything else
    // still syncs this tick.
    const baseExcludePaths = [
      ...new Set([
        ...effectiveExcludePaths,
        // liveLockHoldings is the provenance-rich authority. Keep its paths safe
        // even if a caller omitted the parallel excludePaths projection.
        ...atomicExclusions.paths,
        ...oversized.map((f) => f.path),
        ...contentErrors.map((c) => c.file),
      ]),
    ];
    // EI-24649116564770033: a withheld dirty manifest holds back every other dirty manifest
    // in this repo, so a dependency change never lands without its root entry or lockfile.
    const manifestClosure = expandNpmManifestClosure(dirty, baseExcludePaths);
    if (manifestClosure.paths.length > 0) {
      o.log(
        `[git-sync] ${o.scope}: keeping npm manifests atomic — ${manifestClosure.triggers.join(', ')} ` +
          `withheld this pass, so also deferring ${manifestClosure.paths.join(', ')}`,
      );
    }
    const excludePaths = [...new Set([...baseExcludePaths, ...manifestClosure.paths])];
    const preStagedProtected = await unstagePreStagedProtectedPaths(runGit, repoPath, excludePaths, o.log);
    noteSlowPhase('protected path unstage');
    if (!preStagedProtected.ok) {
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount,
        error: preStagedProtected.error,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
    // EI-21026041751032400: a live protected-path lock can name an ignored
    // untracked artifact. Git already omits that artifact from `add -A`, but
    // rejects the whole command when the artifact is also mentioned as a
    // negative pathspec. Filter only that population before either the
    // attribution path-specific adds or the catch-all stage; tracked ignored
    // paths remain protected by their exclusion pathspec.
    const protectedPathPreflight = await classifyProtectedPathExclusions(runGit, repoPath, excludePaths);
    noteSlowPhase('protected path preflight');
    const ignoredUntrackedExcludes = protectedPathPreflight.ignoredUntracked;
    const beyondSymlinkExcludes = protectedPathPreflight.beyondSymlink;
    const omittedPreflightExcludes = new Set([...ignoredUntrackedExcludes, ...beyondSymlinkExcludes]);
    const stagingExcludePaths = excludePaths.filter((path) => !omittedPreflightExcludes.has(path));
    if (ignoredUntrackedExcludes.size > 0) {
      o.log(
        `[git-sync] ${repoPath}: pre-filtering ignored untracked protected path(s) ` +
          `[${[...ignoredUntrackedExcludes].join(', ')}] from staging pathspecs — Git already excludes them`,
      );
    }
    if (beyondSymlinkExcludes.size > 0) {
      o.log(
        `[git-sync] ${repoPath}: pre-filtering protected path(s) beyond a symbolic link ` +
          `[${[...beyondSymlinkExcludes].join(', ')}] from staging pathspecs — Git cannot traverse the symlink in a pathspec and add -A does not traverse its target`,
      );
    }
    let committedAny = false;
    // P-004: when an attribution map is supplied (flag GIT_SYNC_DERIVED_ATTRIBUTION on), peel
    // each declaring agent's dirty files into its OWN commit (intent subject + Co-Authored-By)
    // BEFORE the catch-all. Absent/empty → no-op, so the flag-OFF path stays byte-identical.
    if (o.attribution && o.attribution.size > 0) {
      const res = await commitAttributedGroups(
        runGit,
        repoPath,
        o.attribution,
        [...stagingExcludePaths, ...migrationCandidates, ...(o.forceCatchAllPaths ?? [])],
        message,
        { diffSubjects: o.diffSubjects },
      );
      if (res.error) {
        // STRANDING GUARD (2026-06-30): a failed per-agent attributed commit — e.g. an
        // index.lock race under heavy fleet contention — must NEVER short-circuit the
        // catch-all `git add -A` sweep below. Returning here strands the unattributed
        // REMAINDER: untracked NEW files (a new tool/module) whose `import` was already
        // committed in an earlier tick. The result is an UNBUILDABLE tree — "the agent's
        // code went missing", and every deploy preflight dies on `Cannot find module`.
        // Log it and FALL THROUGH; the catch-all commits everything still dirty (the
        // failed group's files + the remainder), so no file is ever left behind.
        o.log(
          `[git-sync] ${repoPath}: attributed-commit phase errored (${res.error}); falling through to the catch-all 'git add -A' sweep so no file strands`,
        );
      }
      committedAny = res.committedAny;
      committedCount += res.committedCount;
    }
    // Catch-all = today's single whole-tree commit: sweeps the unattributed remainder (or
    // EVERYTHING when no attribution), including anything a path-specific add missed (rename
    // origin-sides, etc.). Byte-identical to the pre-P-004 commit path.
    const buildAddArgs = (extraExcludes: string[], omittedExcludes: readonly string[] = []): string[] => {
      const omitted = new Set(omittedExcludes);
      const ex = [...new Set([...stagingExcludePaths, ...extraExcludes])].filter((path) => !omitted.has(path));
      return ex.length === 0 ? ['add', '-A'] : ['add', '-A', '--', '.', ...ex.map((p) => `:(exclude,literal)${p}`)];
    };
    // STRANDING GUARD (2026-06-30 ROOT CAUSE): a stray EMBEDDED git repo with no commit
    // ("error: '<path>' does not have a commit checked out") makes `git add -A` FATAL
    // (exit 128) → stages NOTHING → `git commit` reports "nothing" → the WHOLE tree strands
    // silently, every tick, for hours (a green-checkpoint test left a nested .git under
    // .papercusp/.vitest-tmpdir/). The add's exit code was previously UNCHECKED, so the fatal
    // was invisible. Now: check it; on that specific failure, parse the offending path(s),
    // EXCLUDE them, and retry ONCE so one stray repo can't strand everyone's work; if it STILL
    // fails, return a LOUD 'error' (caught by the git-sync-stall watchdog + escalation) instead
    // of silently reporting 'nothing'.
    let omittedIgnoredExcludes: string[] = [];
    let addRes = await runGit(buildAddArgs([]), repoPath);
    if (addRes.code !== 0) {
      // WI-40170: a protected path may ALSO be ignored. Git treats even a
      // negative pathspec as an explicit ignored-path mention and aborts the
      // entire add. The ignore rule already excludes it, so remove only those
      // redundant pathspecs and retry; never force-add the ignored file.
      const ignored = ignoredProtectedExclusions(`${addRes.stdout}\n${addRes.stderr}`, excludePaths);
      if (ignored.length > 0) {
        omittedIgnoredExcludes = ignored;
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' rejected ignored protected path(s) [${ignored.join(', ')}] — ` +
            'omitting those redundant exclusion pathspecs and retrying without force-adding ignored files',
        );
        addRes = await runGit(buildAddArgs([], omittedIgnoredExcludes), repoPath);
      }
      const stray = addFailureStrayPaths(`${addRes.stdout}\n${addRes.stderr}`);
      if (stray.length > 0) {
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' FAILED on embedded/uncommitted repo(s) [${stray.join(', ')}] — excluding + retrying so the rest of the tree still commits (previously: silent strand)`,
        );
        addRes = await runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
      }
      // TRANSIENT-ENOENT SELF-HEAL (EI-18094449017685490): git's tree-walk
      // enumerated a path an instant before some other process's atomic
      // write-tmp+rename made it vanish. This is NOT a stray embedded repo and NOT
      // a held index lock — it's a benign, fast-resolving race, so retry the exact
      // same add a bounded few times (immediate; the writer's rename completes in
      // milliseconds) rather than failing the whole tick's commit on one
      // already-gone temp file.
      for (
        let attempt = 1;
        addRes.code !== 0 &&
        isTransientStatFailure(`${addRes.stdout}\n${addRes.stderr}`) &&
        attempt <= TRANSIENT_STAT_FAILURE_MAX_RETRIES;
        attempt++
      ) {
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' hit a transient ENOENT (a concurrent atomic-write race enumerated a path that vanished before stat) — retrying (attempt ${attempt}/${TRANSIENT_STAT_FAILURE_MAX_RETRIES})`,
        );
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_STAT_FAILURE_RETRY_DELAY_MS));
        addRes = await runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
      }
      // STALE-LOCK SELF-HEAL (2026-07-04): a dead git process's orphaned index.lock
      // otherwise fails EVERY tick until a human clears it. Provably-stale only —
      // see clearStaleIndexLock.
      addRes = await recoverIndexLockContention(
        addRes,
        () => runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath),
        runGit,
        repoPath,
        'git add -A',
        o.log,
      );
      if (addRes.code !== 0) {
        return {
          committedLocal: false,
          dirtyPathCount,
          committedCount,
          error: `git add -A failed — the tree would strand uncommitted: ${(addRes.stderr || addRes.stdout).trim().slice(0, 300)}`,
          oversized,
          contentErrors,
          skippedPaths,
        };
      }
    }
    // Keep migration files out of any commit whose reservation changed or became
    // unreadable after the pre-stage check. Only the migration paths are unstaged;
    // unrelated work remains staged and can be committed on the next tick.
    if (o.migrationReservationChecker) {
      const stagedMigrationPaths = await stagedFiles(runGit, repoPath);
      const postStageMigrationError = await checkMigrationReservations(o, stagedMigrationPaths);
      if (postStageMigrationError) {
        const refused = migrationPaths(stagedMigrationPaths);
        const unstage = await unstagePreStagedProtectedPaths(runGit, repoPath, refused, o.log);
        const unstageError = unstage.ok ? '' : `; could not unstage refused migration paths: ${unstage.error}`;
        o.log(
          `[git-sync] ${o.scope}: post-stage migration reservation check refused ${refused.join(', ')}: ` +
            `${postStageMigrationError}${unstageError}`,
        );
        return {
          committedLocal: committedAny,
          dirtyPathCount,
          committedCount,
          error: `migration reservation check after staging failed: ${postStageMigrationError}${unstageError}`,
          oversized,
          contentErrors,
          skippedPaths,
        };
      }
    }
    // WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): the catch-all subject too is derived from
    // what is ACTUALLY staged (numstat over the staged set); the original message (the
    // sweep's intent/default stem, incl. its own [skip ci]) is demoted to the body for
    // traceability. Numstat failure or an empty staged set falls back to `message` alone
    // — byte-identical to the pre-WI-38594 commit.
    const commitArgs = [...GIT_SYNC_IDENTITY_ARGS, 'commit', '--no-verify'];
    let catchAllSubjected = false;
    if (o.diffSubjects !== false) {
      const ns = await runGit(['diff', '--cached', '--numstat'], repoPath);
      if (ns.code === 0) {
        const stats = parseNumstat(ns.stdout);
        if (stats.length > 0) {
          const subject = diffDerivedSubject(
            stats.map((s) => s.file),
            stats,
          );
          commitArgs.push('-m', `${subject}${skipCiSuffix(message)}`, '-m', message);
          catchAllSubjected = true;
        }
      }
    }
    if (!catchAllSubjected) commitArgs.push('-m', message);
    let c = await runGit(commitArgs, repoPath);
    c = await recoverIndexLockContention(c, () => runGit(commitArgs, repoPath), runGit, repoPath, 'git commit', o.log);
    if (c.code === 0) {
      committedAny = true;
      committedCount += 1;
    } else if (!nothingToCommit(c)) {
      // P-002: a real commit failure (index.lock race, corrupt index, a hook) is NOT
      // a merge conflict. If the still-dirty tree fell through to the merge phase it
      // would abort as a phantom 'conflict' with zero conflicted files and dispatch a
      // merge-resolver at nothing, while the true failure (agents' work not landing)
      // stayed invisible. Surface it as an error.
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount,
        error: `commit failed: ${(c.stderr || c.stdout).trim().slice(0, 300)}`,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
    committedLocal = committedAny;
  }
  return { committedLocal, dirtyPathCount, committedCount, oversized, contentErrors, skippedPaths };
}

/** JSON-serializable — checkpointed as the superproject `git-sync:push` step output. */
type ReconcilePushResult =
  | { status: 'nothing'; mergeCompleted?: boolean }
  | { status: 'synced'; pushed: boolean; merged: boolean; mergeCompleted?: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string; mergeCompleted?: boolean };

export type ContainedAncestryBridgeResult =
  | { status: 'not-needed' }
  | { status: 'bridged'; sourceRef: string; joinedSha: string; changedPaths: string[] }
  | { status: 'declined'; reason: string }
  | { status: 'error'; message: string };

export type ContainedReleaseMainBridgeResult = ContainedAncestryBridgeResult;

const CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS = 200;

/**
 * Join an arbitrary source commit into the current branch's ancestry without
 * changing the current branch's tree.
 *
 * This bridge is deliberately fail-closed. It runs only for the staging branch,
 * and only when EVERY path changed exclusively on the source has the exact same
 * Git tree entry (mode + object id, including deletions and gitlinks) at local
 * HEAD. Once proven, an `ours` merge records the source as a parent while
 * preserving the current tree. A mismatch is a no-op: callers never fabricate
 * ancestry over unrepresented content.
 *
 * Frozen-repair verification calls this with its local `repairHead` BEFORE any
 * main advance. git-sync's recovery wrapper below calls it with `origin/main`
 * when an older gate already promoted a sibling repair head.
 */
export async function bridgeContainedCommitIntoCurrentBranch(
  runGit: RunGit,
  repoPath: string,
  sourceRef: string,
  opts: { log: (message: string) => void },
): Promise<ContainedAncestryBridgeResult> {
  const exists = await runGit(['rev-parse', '--verify', '--quiet', sourceRef], repoPath);
  if (exists.code !== 0) return { status: 'not-needed' };

  const alreadyContained = await runGit(['merge-base', '--is-ancestor', sourceRef, 'HEAD'], repoPath);
  if (alreadyContained.code === 0) return { status: 'not-needed' };
  if (alreadyContained.code !== 1) {
    return { status: 'error', message: `could not compare HEAD with ${sourceRef}` };
  }

  const base = await runGit(['merge-base', 'HEAD', sourceRef], repoPath);
  const mergeBase = base.stdout.trim();
  if (base.code !== 0 || !mergeBase) {
    return { status: 'declined', reason: `${sourceRef} has no merge base with HEAD` };
  }

  const changed = await runGit(['diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${sourceRef}`], repoPath);
  if (changed.code !== 0) {
    return { status: 'error', message: `could not enumerate ${sourceRef}-only paths` };
  }
  const changedPaths = changed.stdout.split('\0').filter(Boolean);
  if (changedPaths.length > CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS) {
    return {
      status: 'declined',
      reason: `${sourceRef} changes ${changedPaths.length} paths (cap ${CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS})`,
    };
  }

  for (const file of changedPaths) {
    const [onSource, onHead] = await Promise.all([
      runGit(['ls-tree', sourceRef, '--', file], repoPath),
      runGit(['ls-tree', 'HEAD', '--', file], repoPath),
    ]);
    if (onSource.code !== 0 || onHead.code !== 0) {
      return { status: 'error', message: `could not compare '${file}' across ${sourceRef} and HEAD` };
    }
    if (onSource.stdout.trim() !== onHead.stdout.trim()) {
      return {
        status: 'declined',
        reason: `${sourceRef}-only path '${file}' is not represented exactly on HEAD`,
      };
    }
  }

  const merge = await runGit([...GIT_SYNC_IDENTITY_ARGS, 'merge', '--no-edit', '-s', 'ours', sourceRef], repoPath);
  if (merge.code !== 0) {
    await runGit(['merge', '--abort'], repoPath);
    return {
      status: 'error',
      message: `contained ${sourceRef} ancestry bridge failed: ${(merge.stderr || merge.stdout).trim().slice(0, 300)}`,
    };
  }
  const joined = await runGit(['rev-parse', 'HEAD'], repoPath);
  const joinedSha = joined.stdout.trim();
  if (joined.code !== 0 || !joinedSha) {
    return { status: 'error', message: `contained ${sourceRef} bridge committed but HEAD could not be resolved` };
  }

  opts.log(
    `[git-sync] ${repoPath}: bridged fully-represented ${sourceRef} into current ancestry ` +
      `without changing the current tree (${changedPaths.length} source-only path(s))`,
  );
  return { status: 'bridged', sourceRef, joinedSha, changedPaths };
}

/** Refresh and reconcile the release gate's `main` lineage into canonical
 * staging. This is the post-incident wrapper; pre-promotion repair verification
 * reuses {@link bridgeContainedCommitIntoCurrentBranch} with its local head. */
export async function bridgeContainedReleaseMain(
  runGit: RunGit,
  repoPath: string,
  opts: { remote: string; branch: string; log: (message: string) => void },
): Promise<ContainedReleaseMainBridgeResult> {
  if (opts.branch !== 'staging') return { status: 'not-needed' };

  const mainRef = `${opts.remote}/main`;
  const fetched = await runNetworkGitWithGitHubHttpsFallback(
    runGit,
    ['fetch', opts.remote, 'main'],
    repoPath,
    opts.log,
  );
  if (fetched.code !== 0) {
    return {
      status: 'declined',
      reason: `could not refresh ${mainRef}: ${(fetched.stderr || fetched.stdout).trim().slice(0, 240)}`,
    };
  }
  return bridgeContainedCommitIntoCurrentBranch(runGit, repoPath, mainRef, {
    log: opts.log,
  });
}

/** WI-10003527: `--deepen` rung sizes for {@link deepenShallowUntilMergeBase}; `--unshallow` is the last rung. */
export const SHALLOW_MERGE_BASE_DEEPEN_RUNGS = [64, 512, 4096] as const;

type ShallowDeepenOutcome =
  | { status: 'not-shallow' }
  | { status: 'found'; rung: string }
  | { status: 'exhausted'; message: string };

/**
 * WI-10003527: a SHALLOW clone has no merge-base with `<remote>/<branch>` until
 * enough history is present, and a plain `git fetch` never supplies it once the
 * remote tip is already local. Measured on the P-203 Mac VM: depth-1 submodules
 * (HEAD 8564ae4 depth 1, origin/main 4c32764 depth 1, HEAD really 26 commits
 * behind) failed `git merge` with "refusing to merge unrelated histories" on 55
 * consecutive ticks, because the merge leg's only no-merge-base recovery was the
 * installer-seed transplant, which a plain shallow clone never matches.
 *
 * Deepen in bounded rungs until `merge-base HEAD <remoteRef>` resolves, ending
 * with `--unshallow`. If the repo is complete and there is STILL no merge-base,
 * the histories really are unrelated: report it and let the caller keep that a
 * loud error (never `--allow-unrelated-histories`).
 */
async function deepenShallowUntilMergeBase(
  runGit: RunGit,
  repo: string,
  remote: string,
  branch: string,
  remoteRef: string,
  log: (m: string) => void,
): Promise<ShallowDeepenOutcome> {
  const isShallow = async (): Promise<boolean> => {
    const r = await runGit(['rev-parse', '--is-shallow-repository'], repo);
    return r.code === 0 && r.stdout.trim() === 'true';
  };
  if (!(await isShallow())) return { status: 'not-shallow' };
  const rungs = [
    ...SHALLOW_MERGE_BASE_DEEPEN_RUNGS.map((n) => ({ label: `--deepen=${n}`, arg: `--deepen=${n}` })),
    { label: '--unshallow', arg: '--unshallow' },
  ];
  let lastError = '';
  for (const rung of rungs) {
    const fetched = await runNetworkGitWithGitHubHttpsFallback(runGit, ['fetch', rung.arg, remote, branch], repo, log);
    if (fetched.code !== 0) {
      lastError = `fetch ${rung.label} failed: ${(fetched.stderr || fetched.stdout).trim().slice(0, 240)}`;
      log(`[git-sync] ${repo}: shallow deepen ${lastError}`);
      continue;
    }
    const base = await runGit(['merge-base', 'HEAD', remoteRef], repo);
    if (base.code === 0) {
      log(`[git-sync] ${repo}: shallow repo had no merge-base with ${remoteRef}; ${rung.label} recovered one`);
      return { status: 'found', rung: rung.label };
    }
    if (!(await isShallow())) {
      return { status: 'exhausted', message: `repo is complete after ${rung.label} and still has no merge-base with ${remoteRef}` };
    }
  }
  return { status: 'exhausted', message: lastError || `no merge-base with ${remoteRef} after every deepen rung` };
}

/**
 * WI-1416: the RECONCILE+PUSH half of one repo's sync — resolve branch → fetch →
 * merge (handles diverged/behind) → push (one non-FF retry). Replay-safe: a re-run
 * re-fetches, proves an already-pushed HEAD is aligned, and skips the authenticated no-op push.
 */
async function reconcileAndPushOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: ReconcileRepoOpts,
  /** whether the commit half made a local commit this pass (drives the fetch-failure
   *  classification + the final nothing/synced verdict). */
  committedLocal: boolean,
): Promise<ReconcilePushResult> {
  const { remote, doPush } = o;
  // P-004: a detached HEAD (a fresh `git submodule update` leaves submodules detached)
  // must sync to the repo's OWN remote default branch (origin/HEAD → e.g. 'main'), NOT
  // the superproject's configured branch — o.defaultBranch carries 'staging' for the
  // live superproject, and using it for a detached submodule would push that submodule's
  // commits to the wrong branch and fail every tick with no clear cause. origin/HEAD
  // resolves the right branch; o.defaultBranch is only the last resort when even that is
  // unknown (and is now passed per-repo: 'main' for submodules, cfg.branch for the super).
  // P-011: HEAD's branch → the remote default (origin/HEAD) → the per-repo last-resort
  // default. If we reach the last resort the branch is a GUESS — make it LOUD (a wrong
  // guess would otherwise surface only as an opaque "push failed" escalation).
  const attachedBranch = await currentBranch(runGit, repoPath);
  const ownRemoteDefault = await remoteDefaultBranch(runGit, repoPath, remote);
  const exactRemoteBranches = await remoteBranchesPointingAtHead(runGit, repoPath, remote);
  const preservedRemoteBranch = preferredRemoteBranchAtHead(exactRemoteBranches, ownRemoteDefault);
  let resolvedBranch = attachedBranch ?? preservedRemoteBranch ?? ownRemoteDefault;

  // A clean attached branch can be a local, task-specific name whose exact HEAD
  // was deliberately published under a preservation branch. Fetching the absent
  // same-name branch falsely reports the already-safe gitlink as unpushed. Use
  // the exact remote proof only before this pass creates a new local commit; a
  // newly advanced branch still has to publish under its attached name.
  if (attachedBranch && !committedLocal && preservedRemoteBranch && preservedRemoteBranch !== attachedBranch) {
    const attachedRemoteRef = await runGit(
      ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${attachedBranch}`],
      repoPath,
    );
    if (attachedRemoteRef.code === 1) {
      resolvedBranch = preservedRemoteBranch;
      o.log(
        `[git-sync] ${repoPath}: local branch '${attachedBranch}' has no ${remote} tracking ref, but HEAD is ` +
          `already preserved at ${remote}/${preservedRemoteBranch}; reconciling the proved remote branch`,
      );
    }
  } else if (!attachedBranch && preservedRemoteBranch && preservedRemoteBranch !== ownRemoteDefault) {
    o.log(
      `[git-sync] ${repoPath}: detached HEAD is already preserved at ${remote}/${preservedRemoteBranch}; ` +
        'reconciling that exact-tip remote branch',
    );
  }
  const branch = resolvedBranch ?? o.defaultBranch;
  if (!resolvedBranch) {
    o.log(
      `[git-sync] ${repoPath}: could not resolve a branch from HEAD or ${remote}/HEAD — falling back to '${o.defaultBranch}' (a wrong guess will fail the push; P-011)`,
    );
  }

  const stale = await scavengeStaleTempPacks(runGit, repoPath, o.log, {
    staleMs: o.staleTempPackMs,
    isOpen: o.isTempPackOpen,
  });
  if (stale.removed.length > 0) {
    o.log(
      `[git-sync] ${repoPath}: stale tmp_pack cleanup; pruned ${stale.removed.length} unopened unreferenced file(s), reclaimed ${stale.bytesReclaimed} bytes`,
    );
  }
  const zeroByteLooseObjects = await findZeroByteLooseObjects(runGit, repoPath);
  if (zeroByteLooseObjects.length > 0) {
    return {
      status: 'error',
      message:
        `local Git object database corrupt: ${zeroByteLooseObjects.length} zero-byte loose object(s): ` +
        `${zeroByteLooseObjects.join(', ')}; repair required before fetch`,
    };
  }
  const tempPacksBeforeFetch = await listTempPackFiles(runGit, repoPath);
  const fetch = await runNetworkGitWithGitHubHttpsFallback(runGit, ['fetch', remote, branch], repoPath, o.log);
  if (fetch.code !== 0) {
    const reclaimed = await pruneFailedFetchTempPacks(runGit, repoPath, tempPacksBeforeFetch, o.log);
    const cleanupNote =
      reclaimed.removed.length > 0
        ? `; pruned ${reclaimed.removed.length} newly-created unreferenced tmp_pack file(s), reclaimed ${reclaimed.bytesReclaimed} bytes`
        : '';
    if (cleanupNote) o.log(`[git-sync] ${repoPath}: failed fetch cleanup${cleanupNote}`);
    // Fetch failed (offline / transient). GAP-4: when we're meant to push and HEAD has
    // commits not on the last-known origin tip, those commits are NOT on origin — return
    // 'error' so runGitSync DEFERS the superproject. Otherwise the superproject would
    // commit + push a gitlink pointing at an unpushed submodule commit, which a fresh
    // clone can't resolve (this actually corrupted origin once). With push disabled, a
    // local commit is the expected local-only result.
    if (doPush) {
      const rl = await runGit(['rev-list', '--count', `${remote}/${branch}..HEAD`], repoPath);
      const aheadCount = rl.code === 0 ? Number.parseInt(rl.stdout.trim(), 10) || 0 : 1; // ref missing → assume unpushed
      if (committedLocal || aheadCount > 0) {
        return {
          status: 'error',
          message: `fetch failed; HEAD has unpushed commits not on ${remote}/${branch} (cannot reconcile)${cleanupNote}`,
        };
      }
      return { status: 'nothing' };
    }
    return committedLocal ? { status: 'synced', pushed: false, merged: false } : { status: 'nothing' };
  }

  const remoteRef = `${remote}/${branch}`;
  let seedTransplanted = false;
  const base = await runGit(['merge-base', 'HEAD', remoteRef], repoPath);
  // WI-10003527: a shallow clone first gets the history a merge-base needs; only a
  // repo that still has none (not shallow, or genuinely unrelated) reaches the seed path.
  const deepened =
    base.code !== 0
      ? await deepenShallowUntilMergeBase(runGit, repoPath, remote, branch, remoteRef, o.log)
      : null;
  if (base.code !== 0 && deepened?.status !== 'found') {
    if (deepened?.status === 'exhausted') o.log(`[git-sync] ${repoPath}: shallow deepen exhausted: ${deepened.message}`);
    const seed = await transplantInstallerSeedSnapshot(runGit, repoPath, remoteRef, remote, o.log);
    if (seed.status === 'error') return { status: 'error', message: seed.message };
    seedTransplanted = seed.status === 'transplanted';
  }

  // WI-5111: a non-fast-forward merge creates its own commit under the box's git
  // identity too — same bot-identity override as the commit calls above, so a
  // merge commit git-sync makes is never misattributed to the owner either.
  // WI-10003529: the merge writes the index too, so it gets the same stale-orphan
  // recovery as add/commit. A clean submodule never runs `git add`, so before this
  // its merge was the FIRST index writer to meet an orphaned index.lock — and it
  // returned "merge failed (no conflicted paths)" every tick forever (P-203 Mac VM,
  // libs/papercusp-db, 2026-09-27: lock 65+ min old, lsof proved no holder).
  const mergeArgs = [...GIT_SYNC_IDENTITY_ARGS, 'merge', '--no-edit', `${remote}/${branch}`];
  const merge = await recoverIndexLockContention(
    await runGit(mergeArgs, repoPath),
    () => runGit(mergeArgs, repoPath),
    runGit,
    repoPath,
    'git merge',
    o.log,
  );
  if (merge.code !== 0) {
    const infrastructureError = gitSyncPreDispatchError(merge);
    if (infrastructureError) return { status: 'error', message: infrastructureError };
    const conflicted = await conflictedFiles(runGit, repoPath);
    const mergeOut = `${merge.stdout}\n${merge.stderr}`.trim();
    await runGit(['merge', '--abort'], repoPath); // clean tree
    // P-002: a failed merge with NO unmerged paths is not a content conflict a
    // merge-resolver can fix (e.g. "local changes would be overwritten", "not
    // something we can merge") — surface as error, don't dispatch a resolver at it.
    if (conflicted.length === 0) {
      // WI-6824: the ref pair rides in the MESSAGE, not a second log call — runGitSync's
      // `absorb` already logs every error verbatim, so the message is what reaches both
      // the journal and `last_error`. One channel, no divergence between the two records.
      const diag = await describeFailedMerge(runGit, repoPath, remote, branch, 'initial');
      return { status: 'error', message: `merge failed (no conflicted paths) [${diag}]: ${mergeOut.slice(0, 300)}` };
    }
    return { status: 'conflict', conflictedFiles: conflicted };
  }
  // A successful merge is evidence that this repo's merge stage completed cleanly,
  // even when it produced no merge commit. Keep that proof alive if a later push
  // fails: conflict resolution and push success are independent facts.
  let mergeCompleted = true;
  let mergedNew = seedTransplanted || !/Already up to date/i.test(merge.stdout);

  // Frozen repair heads are allowed to prove a patch, but canonical staging remains
  // the only branch git-sync publishes. If a previously-promoted repair head is a
  // sibling whose exact content is already represented here, join only its ancestry
  // before pushing staging. The helper declines on any content uncertainty.
  if (doPush && branch === 'staging') {
    const releaseBridge = await bridgeContainedReleaseMain(runGit, repoPath, {
      remote,
      branch,
      log: o.log,
    });
    if (releaseBridge.status === 'error') {
      return { status: 'error', message: releaseBridge.message, mergeCompleted };
    }
    if (releaseBridge.status === 'bridged') mergedNew = true;
    if (releaseBridge.status === 'declined') {
      o.log(`[git-sync] ${repoPath}: release-main ancestry bridge declined — ${releaseBridge.reason}`);
    }
  }

  let pushed = false;
  if (doPush) {
    // The successful fetch + merge gives us a current remote-tracking ref. When
    // HEAD has no commits beyond it, an authenticated push can move nothing and
    // should not be allowed to fail the whole harness on an unrelated credential
    // policy (EI-20328688606935149). If the comparison itself fails, retain the
    // existing push behavior so uncertainty can never strand a real commit.
    const ahead = await runGit(['rev-list', '--count', `${remoteRef}..HEAD`], repoPath);
    const aheadText = ahead.stdout.trim();
    const aheadCount = ahead.code === 0 && /^\d+$/.test(aheadText) ? Number.parseInt(aheadText, 10) : null;
    if (aheadCount !== 0) {
      let push = await runNetworkGitWithGitHubHttpsFallback(
        runGit,
        ['push', remote, `HEAD:${branch}`],
        repoPath,
        o.log,
      );
      if (push.code !== 0 && rejectedNonFastForward(push)) {
        // A peer pushed between our fetch and push — re-fetch + re-merge once.
        await runNetworkGitWithGitHubHttpsFallback(runGit, ['fetch', remote, branch], repoPath, o.log);
        const m2 = await recoverIndexLockContention(
          await runGit(mergeArgs, repoPath),
          () => runGit(mergeArgs, repoPath),
          runGit,
          repoPath,
          'git merge (non-ff retry)',
          o.log,
        );
        if (m2.code !== 0) {
          const infrastructureError = gitSyncPreDispatchError(m2);
          if (infrastructureError) return { status: 'error', message: infrastructureError };
          const conflicted = await conflictedFiles(runGit, repoPath);
          const m2Out = `${m2.stdout}\n${m2.stderr}`.trim();
          await runGit(['merge', '--abort'], repoPath);
          if (conflicted.length === 0) {
            const diag = await describeFailedMerge(runGit, repoPath, remote, branch, 'non-ff-retry');
            return { status: 'error', message: `merge failed (no conflicted paths) [${diag}]: ${m2Out.slice(0, 300)}` };
          }
          return { status: 'conflict', conflictedFiles: conflicted };
        }
        // The retry merge also completed cleanly; retain the positive proof for a
        // subsequent push error. A retry conflict/error returns above without proof.
        mergeCompleted = true;
        mergedNew = mergedNew || !/Already up to date/i.test(m2.stdout);
        push = await runNetworkGitWithGitHubHttpsFallback(runGit, ['push', remote, `HEAD:${branch}`], repoPath, o.log);
      }
      if (push.code !== 0) {
        return {
          status: 'error',
          message: `push failed: ${push.stderr.trim() || push.stdout.trim()}`,
          mergeCompleted,
        };
      }
      pushed = !/Everything up-to-date/i.test(`${push.stdout}\n${push.stderr}`);
    }
  }

  if (!committedLocal && !mergedNew && !pushed) return { status: 'nothing', mergeCompleted };
  return { status: 'synced', pushed, merged: mergedNew, mergeCompleted };
}

/**
 * Sync ONE repo (superproject or a single submodule) to origin: commit dirty →
 * fetch → merge (reconciling a diverged/behind remote) → push. Never throws.
 * Composed from the two halves above (each independently checkpointable for the
 * superproject; submodules run both halves inside one phase step).
 */
async function syncOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: CommitRepoOpts & { remote: string; defaultBranch: string; doPush: boolean },
): Promise<RepoSyncResult> {
  const c = await commitOneRepo(runGit, repoPath, o);
  if (c.skippedPaths && c.skippedPaths.length > 0) {
    return {
      status: 'skipped-locked',
      dirtyPathCount: c.dirtyPathCount,
      committedCount: c.committedCount,
      skippedPaths: c.skippedPaths,
      oversized: c.oversized,
      contentErrors: c.contentErrors,
    };
  }
  if (c.error) {
    return {
      status: 'error',
      message: c.error,
      dirtyPathCount: c.dirtyPathCount,
      committedCount: c.committedCount,
      oversized: c.oversized,
      contentErrors: c.contentErrors,
    };
  }
  const r = await reconcileAndPushOneRepo(runGit, repoPath, o, c.committedLocal);
  return {
    ...r,
    dirtyPathCount: c.dirtyPathCount,
    committedCount: c.committedCount,
    oversized: c.oversized,
    contentErrors: c.contentErrors,
  };
}

/**
 * Run one git-sync pass for `slug`. Syncs all submodules (recursively, deepest-first)
 * then the superproject. Returns a structured outcome; never throws. The caller
 * (git-sync-action) handles `conflict` (escalation + resolver, scoped to each repo
 * that conflicted) and records metadata.
 *
 * A conflict in ONE submodule no longer aborts the whole pass: every other submodule
 * still gets reconciled + pushed (a wedged libs/X must not block libs/Y). Conflicts +
 * errors are COLLECTED. The superproject, however, is only synced when EVERY submodule
 * reconciled — pushing the superproject while a submodule's local commits aren't yet on
 * its origin would publish a gitlink a fresh clone can't resolve. So a single
 * unreconciled submodule defers the superproject push to a later (clean) tick.
 */
export async function runGitSync(slug: string, opts: RunGitSyncOpts = {}): Promise<GitSyncOutcome> {
  /**
   * An action-level stall guard can abort the owning fire while a git child is
   * still draining its SIGTERM/SIGKILL grace period.  Check the signal at the
   * command seam as well as in the child runner: otherwise a late child result
   * could let this pipeline start the next git phase after its locks were
   * already released.
   */
  const throwIfAborted = (): void => {
    if (!opts.signal?.aborted) return;
    const reason = opts.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error('git-sync action aborted by its liveness guard');
  };
  const reportProgress = (): void => {
    try {
      opts.onProgress?.();
    } catch {
      // Progress accounting is diagnostic-only and must never break git-sync.
    }
  };
  const baseRunGit: RunGit =
    opts.runGit ??
    ((args, cwd) =>
      runGitBounded(args, cwd, gitTimeoutMsFor(args), {
        onProgress: reportProgress,
        signal: opts.signal,
      }));
  const runGit: RunGit = async (args, cwd) => {
    throwIfAborted();
    reportProgress();
    if (gitSubcommand(args) === 'push' && opts.beforePush) {
      try {
        await opts.beforePush(args, cwd);
      } catch (error) {
        throwIfAborted();
        return {
          code: 1,
          stdout: '',
          stderr: `git-sync publication refused: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      throwIfAborted();
    }
    const startedAt = performance.now();
    try {
      const result = await baseRunGit(args, cwd);
      reportProgress();
      throwIfAborted();
      return result;
    } finally {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (elapsedMs >= 10_000) {
        const scope = repo && cwd.startsWith(`${repo}/`) ? cwd.slice(repo.length + 1) : 'superproject';
        log(`[git-sync] ${scope}: slow git ${gitSubcommand(args)} call (${elapsedMs}ms, includes dispatch/admission/child/transport)`);
      }
    }
  };
  const cfg = opts.config ?? {};
  const remote = cfg.remote ?? 'origin';
  const branch = cfg.branch ?? 'main';
  const doPush = cfg.push !== false;
  // EI-18689553108460319: submodule origin-push is INDEPENDENT of the superproject's
  // `push` flag — see the GitSyncConfig doc comment for why they must not share one knob.
  //
  // WI-6016: but that independence is OPT-IN, not the default. Defaulting it to `true`
  // regardless of `push` made the knob fail-OPEN and silently regressed the S0
  // no-direct-push invariant (AH-6, code-plane-federation.test.ts, 2026-06-20): a
  // JOINER — `decideGitSyncPush({ joinerSide: true })`, a read-only member clone whose
  // contribution path is fork-PR — carries push:false for a completely different reason
  // than a bridged hive does, and it must push NOTHING, ANYWHERE. A bare `push:false`
  // does not say WHICH reason applies, so the safe default is to follow `push` and let
  // the one caller that genuinely wants the split (git-sync-action's hive-mode override,
  // where the bridge owns only the SUPERPROJECT's canonical refs — never an
  // independently-hosted submodule library) opt back in EXPLICITLY.
  const doSubPush = cfg.pushSubmoduleOrigins !== undefined ? cfg.pushSubmoduleOrigins : doPush;
  const doSub = cfg.pushSubmodules !== false;
  const reconcileSuperprojectOrigin = cfg.reconcileSuperprojectOrigin !== false;
  const bridgeContainedReleaseMainOnCommitOnly = cfg.bridgeContainedReleaseMainOnCommitOnly === true;
  const message = cfg.message ?? `chore(git-sync): auto-commit ${slug} [skip ci]`;
  const maxBlobBytes = cfg.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const maxCommitTotalBytes = cfg.maxCommitTotalBytes ?? DEFAULT_MAX_COMMIT_TOTAL_BYTES;
  // WI-6824: this default was `() => {}`, and the SOLE production caller
  // (git-sync-action.ts) passes no `log` — so every line below was discarded in
  // production: oversized exclusions, content quarantines, merge conflicts, merge
  // ERRORS, and the P-011 branch-guess warning whose own comment says "make it LOUD".
  // That is why an unrelated-history merge failure could alarm the fleet for ~10h
  // across 39 sweeps while leaving ZERO occurrences in journald, recorded only in
  // routine metadata that the next healthy tick nulls. Defaulting to a REAL sink fixes
  // the class rather than one call site: a caller can no longer go dark by omission,
  // only by explicitly passing a silent log. Every call site here is an exceptional
  // event — a healthy tick still logs nothing.
  const log = opts.log ?? ((m: string) => console.warn(m));
  // WI-1416: the checkpoint seam — each phase below runs under `step` so a durable
  // caller records one operation_output per phase (see GitSyncStepRunner).
  const step: GitSyncStepRunner = opts.step ?? (async (_name, fn) => fn());
  // EI-438 content guard seams (default registry + fs reader; injectable for tests).
  const contentDetectors = opts.contentDetectors ?? DEFAULT_CONTENT_DETECTORS;
  const deletionGuard = opts.deletionGuard ?? true;
  const readText = opts.readText ?? defaultReadText;
  const writeText = opts.writeText ?? defaultWriteText;
  const toolCatalogRegenerator = opts.toolCatalogRegenerator ?? regenerateToolCatalogBeforeCommit;
  const generatedDeclarationsRegenerator =
    opts.generatedDeclarationsRegenerator ?? regenerateGeneratedDeclarationsBeforeCommit;
  const toolRoutingChecker = opts.toolRoutingChecker ?? checkToolRoutingBeforeCommit;
  const protectedPaths = [...new Set((opts.excludePaths ?? []).map((path) => path.trim()).filter(Boolean))];
  const protectedHoldings = (opts.liveLockHoldings ?? [])
    .map((holding) => ({
      path: holding.path.trim(),
      owner: holding.owner,
      intent: holding.intent,
      ...(holding.goalRef?.trim() ? { goalRef: holding.goalRef.trim() } : {}),
    }))
    .filter((holding) => holding.path.length > 0);
  const refreshLiveLockHoldingsForRepo = opts.refreshLiveLockHoldings
    ? (repoRelPrefix: string, knownSubmodulePaths: readonly string[]) => async (): Promise<GitSyncLockHolding[]> =>
        mapLiveLockHoldingsForRepo(await opts.refreshLiveLockHoldings!(), repoRelPrefix, knownSubmodulePaths)
    : undefined;
  const repoO = {
    remote,
    defaultBranch: branch,
    message,
    doPush,
    maxBlobBytes,
    maxCommitTotalBytes,
    contentDetectors,
    deletionGuard,
    readText,
    writeText,
    log,
    staleTempPackMs: opts.staleTempPackMs ?? STALE_TEMP_PACK_MS,
    isTempPackOpen: opts.isTempPackOpen,
    diffSubjects: opts.diffSubjects ?? true,
    migrationReservationChecker: opts.migrationReservationChecker,
    excludePaths: protectedPaths,
  };

  const repo = opts.repoPath === undefined ? await projectDirForSlug(slug) : opts.repoPath;
  if (!repo) {
    return {
      status: 'error',
      dirtyPathCount: 0,
      committedCount: 0,
      errors: [{ scope: 'superproject', message: `no repo path registered for harness '${slug}'` }],
      pushed: [],
      merged: [],
      mergeCompleted: [],
      oversized: [],
      bulkExcluded: [],
      contentErrors: [],
      // No repo to inspect: nothing was measured, so null (never []) — an all-clear we
      // did not earn would retire a live strand escalation.
      strandedSubmodules: null,
    };
  }

  // Run before `git submodule status --recursive`: that census reads the
  // superproject index and otherwise turns a torn zero-byte index into a
  // misleading empty-submodule/clean-tree result. A refusal is surfaced as a
  // normal repo error; an unavailable probe is retained as the legacy fail-soft
  // path used by injected non-repository test seams.
  const rootIndexPreflight = await preflightInvalidIndex(runGit, repo, log);
  if (rootIndexPreflight.status === 'refused' || rootIndexPreflight.status === 'error') {
    return {
      status: 'error',
      dirtyPathCount: 0,
      committedCount: 0,
      errors: [
        {
          scope: 'superproject',
          message: `invalid-index preflight refused the sync: ${rootIndexPreflight.reason}`,
        },
      ],
      pushed: [],
      merged: [],
      mergeCompleted: [],
      oversized: [],
      bulkExcluded: [],
      contentErrors: [],
      strandedSubmodules: null,
    };
  }

  // P-004: the live roster (active agents + their declared files) for THIS tick, supplied by
  // the caller flag-gated. Empty when the flag is OFF (or no caller) → no attribution, today's
  // single-commit behavior. Read ONCE; per-repo maps are derived below (super + each submodule).
  const roster = opts.loadRoster ? await opts.loadRoster() : [];

  /** One phase's collected results — JSON-serializable so it checkpoints as a step output. */
  interface PhaseCollect {
    dirtyPathCount: number;
    committedCount: number;
    conflicts: RepoConflict[];
    errors: RepoError[];
    pushed: string[];
    merged: string[];
    mergeCompleted: string[];
    oversized: ScopedOversized[];
    contentErrors: ScopedContentError[];
    skippedPaths: GitSyncSkippedPath[];
    /** Checkpoint the census with the phase. Outer mutable state disappears on replay,
     *  turning a measured [] into null and changing the reconstructed outcome. */
    strandedSubmodules: StrandedSubmodule[] | null;
    /** Persist the discovered repo coordinates so a resumed pointer-bump can still
     * filter submodule-relative protected paths out of the superproject stage. */
    submodulePaths: string[];
    didSomething: boolean;
  }
  const emptyPhase = (): PhaseCollect => ({
    dirtyPathCount: 0,
    committedCount: 0,
    conflicts: [],
    errors: [],
    pushed: [],
    merged: [],
    mergeCompleted: [],
    oversized: [],
    contentErrors: [],
    skippedPaths: [],
    strandedSubmodules: null,
    submodulePaths: [],
    didSomething: false,
  });

  const absorb = (into: PhaseCollect, scope: string, r: RepoSyncResult): void => {
    into.dirtyPathCount += r.dirtyPathCount ?? 0;
    into.committedCount += r.committedCount ?? 0;
    if (r.mergeCompleted) into.mergeCompleted.push(scope);
    if (r.oversized.length > 0) {
      into.oversized.push(...r.oversized.map((f) => ({ scope, ...f })));
      log(
        `[git-sync] ${scope}: EXCLUDED ${r.oversized.length} oversized file(s) from the auto-commit (${r.oversized.map((f) => `${f.path} ${(f.sizeBytes / 1048576).toFixed(1)}MB`).join(', ')}) — gitignore or remove them (${slug})`,
      );
    }
    if (r.contentErrors.length > 0) {
      // EI-438 (D-001): broken files were EXCLUDED from this commit + left dirty for the
      // content-fixer; the rest of the tree still committed. Like oversized, this does
      // NOT defer the superproject (the (sub)repo's commit WITHOUT the broken file IS on
      // its origin, so the parent gitlink resolves).
      into.contentErrors.push(...r.contentErrors.map((c) => ({ scope, ...c })));
      log(
        `[git-sync] ${scope}: QUARANTINED ${r.contentErrors.length} broken file(s) from the auto-commit (${r.contentErrors.map((c) => `${c.file} [${c.detectorKey}]`).join(', ')}) — content-fixer dispatched (${slug})`,
      );
    }
    if (r.skippedPaths && r.skippedPaths.length > 0) into.skippedPaths.push(...r.skippedPaths);
    if (r.status === 'conflict') {
      into.conflicts.push({ scope, conflictedFiles: r.conflictedFiles });
      log(
        `[git-sync] ${scope}: merge conflict (${r.conflictedFiles.join(', ')}) — aborted clean, continuing (${slug})`,
      );
    } else if (r.status === 'error') {
      into.errors.push({ scope, message: r.message });
      log(`[git-sync] ${scope}: ${r.message} — continuing (${slug})`);
    } else if (r.status === 'synced') {
      into.didSomething = true;
      if (r.pushed) into.pushed.push(scope);
      if (r.merged) into.merged.push(scope);
    }
  };

  // PHASE `git-sync:submodules` — every submodule, deepest-first (dynamic recursive
  // discovery). Each is independent: a conflict/error in one is collected; the rest
  // still sync. Runs as ONE checkpointed step: the expensive multi-repo half of the
  // pass, after which a resumed fire never re-commits/re-pushes the submodules.
  const sub = await step('git-sync:submodules', async (): Promise<PhaseCollect> => {
    const out = emptyPhase();
    let subPaths: string[] = [];
    if (doSub) {
      // EI-20329530284626235: `.gitmodules` is the canonical transport declaration,
      // but an initialized submodule keeps a copied URL in its own `remote.origin.url`.
      // That copy survives later `.gitmodules` changes, so git-sync could keep pushing
      // through a stale HTTPS credential path even after the canonical URL moved to SSH.
      // Reconcile the copies before discovery or any submodule fetch/push. A failure is
      // correctness-relevant: continuing would knowingly use an unverified transport,
      // so report it and defer the superproject push like every other submodule error.
      let urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);
      // EI-20345390379109755: an interrupted config writer (or a fleet-sandbox
      // mask artifact) can strand a zero-byte `.git/config.lock`. The index
      // phase already self-heals its equivalent lock; apply the same age guard
      // here, then retry once. A fresh lock is never touched.
      if (urlSync.code !== 0 && isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`)) {
        const cleared = await clearStaleConfigLock(runGit, repo, log);
        if (cleared) urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);

        // EI-20347384139844425: a fresh config.lock is live contention, not an
        // orphan we may delete. It is nevertheless normally gone within a few
        // milliseconds. Retry the exact idempotent sync with the same bounded
        // exponential-backoff pattern as live index.lock contention; persistent
        // failures still surface and the next guard can remove only a lock that
        // has since become provably stale.
        for (
          let attempt = 1;
          urlSync.code !== 0 &&
          isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`) &&
          attempt <= CONFIG_LOCK_CONTENTION_MAX_RETRIES;
          attempt++
        ) {
          const delayMs = CONFIG_LOCK_CONTENTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          log(
            `[git-sync] ${repo}: canonical submodule URL sync hit live config.lock contention — retrying after ${delayMs}ms (attempt ${attempt}/${CONFIG_LOCK_CONTENTION_MAX_RETRIES})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);
        }

        if (urlSync.code !== 0 && isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`)) {
          const clearedAfterRetry = await clearStaleConfigLock(runGit, repo, log);
          if (clearedAfterRetry) urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);
        }
      }
      if (urlSync.code !== 0) {
        const detail = (urlSync.stderr || urlSync.stdout || 'no output').trim().slice(0, 300);
        const message = `canonical submodule URL sync failed: ${detail}`;
        out.errors.push({ scope: 'submodule-config', message });
        log(`[git-sync] submodule-config: ${message} — deferring submodule work and superproject push (${slug})`);
        return out;
      }
      subPaths = opts.submodulePaths
        ? [...opts.submodulePaths].sort((a, b) => b.split('/').length - a.split('/').length)
        : await discoverSubmodulesRecursive(runGit, repo, log, (census) => {
            // EI-20402093158205519: record the strand census measured by THIS pass. An
            // explicit submodulePaths override (tests) skips discovery entirely and so
            // measures nothing — this stays null, and null never implies an all-clear.
            out.strandedSubmodules = census;
          });
      out.submodulePaths = [...subPaths];
    }
    const syncSubmodule = (s: string): Promise<RepoSyncResult> =>
      // P-004: a submodule's last-resort default is its own 'main' (resolved via
      // origin/HEAD first), never the superproject's branch (cfg.branch = 'staging').
      // EI-18689553108460319: submodules push under `doSubPush`, NOT the superproject's
      // `doPush` — a bridged/p2p-only hive's push:false must not silently strand every
      // submodule's commits too (see GitSyncConfig.pushSubmoduleOrigins).
      syncOneRepo(runGit, join(repo, s), {
        ...repoO,
        scope: s,
        doPush: doSubPush,
        defaultBranch: 'main',
        // The caller supplies workspace/superproject-root-relative paths, while
        // git commands inside a submodule use that submodule's own root. This is
        // the same coordinate mapping used by git-sync attribution.
        excludePaths: protectedPaths
          .filter((path) => path.startsWith(`${s}/`))
          .map((path) => path.slice(s.length + 1))
          .filter(Boolean),
        protectedHoldings: protectedHoldings
          .filter((holding) => holding.path.startsWith(`${s}/`))
          .map((holding) => ({ ...holding, path: holding.path.slice(s.length + 1) }))
          .filter((holding) => holding.path.length > 0),
        refreshLiveLockHoldings: refreshLiveLockHoldingsForRepo?.(s, subPaths),
        attribution: attributionMapForRepo(roster, s, repo),
      });
    // WI-10003100: syncing every repo serially delayed the superproject commit
    // behind a 338s submodule phase on a 38-submodule checkout. Sync only
    // independent repos together; finish every child depth before starting a
    // parent so a parent's pushed gitlink always resolves on the child origin.
    for (let depthStart = 0; depthStart < subPaths.length; ) {
      const depth = subPaths[depthStart]!.split('/').length;
      let depthEnd = depthStart + 1;
      while (depthEnd < subPaths.length && subPaths[depthEnd]!.split('/').length === depth) depthEnd++;
      for (let batchStart = depthStart; batchStart < depthEnd; batchStart += SUBMODULE_SYNC_CONCURRENCY) {
        const batch = subPaths.slice(batchStart, Math.min(batchStart + SUBMODULE_SYNC_CONCURRENCY, depthEnd));
        // allSettled is a safety barrier: an unexpected rejection must not let a
        // sibling start more Git commands after the action releases its locks.
        const results = await Promise.allSettled(batch.map(syncSubmodule));
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          if (result.status === 'rejected') throw result.reason;
          absorb(out, batch[i]!, result.value);
        }
      }
      depthStart = depthEnd;
    }
    return out;
  });
  const strandedSubmodules = sub.strandedSubmodules;
  // `submodulePaths` is part of the checkpointed phase output. The fallback keeps
  // compatibility with an older in-flight checkpoint created before that field
  // existed when the caller supplied an explicit path list.
  const submodulePaths = sub.submodulePaths ?? opts.submodulePaths ?? [];

  // Superproject last. An unreconciled submodule defers its PUSH — and ONLY its push.
  // (Oversized exclusions defer nothing: the submodule's commit — without the big
  // file — IS on its origin, so the parent gitlink resolves fine.)
  //
  // EI-20182436053613562: the deferral used to gate the local COMMIT as well, which is
  // strictly more than the invariant needs. Publishing a superproject commit whose
  // gitlinks reference unpushed submodule commits is what breaks a fresh clone, so the
  // PUSH must wait. A local commit publishes nothing, cannot strand a gitlink, and is
  // what the release gate cuts its candidate from (it reads local `staging` and never
  // fetches). Gating it too meant ONE permanently-failing submodule push — a GitHub 403
  // that no retry can ever clear — froze every agent's ordinary, non-submodule work in
  // the shared dirty tree indefinitely: measured at 12h and 24 dirty paths, including
  // untracked files that existed on no other disk and were therefore not even
  // recoverable from the reflog. This log line always SAID "deferring superproject
  // push"; now the code does only that.
  const supr = emptyPhase();
  let superHeadSha: string | undefined;
  const pushBlocked = sub.conflicts.length > 0 || sub.errors.length > 0;
  // A submodule-relative protected path is valid for `git add` inside that
  // submodule, but Git rejects the same pathspec from the superproject with
  // "Pathspec ... is in submodule". Keep only paths in the superproject's own
  // coordinate space for its catch-all stage; each submodule received its mapped
  // exclusions above.
  const superprojectExcludePaths = protectedPaths.filter(
    (path) => !submodulePaths.some((s) => path === s || path.startsWith(`${s}/`)),
  );
  const superprojectProtectedHoldings = protectedHoldings.filter(
    (holding) => !submodulePaths.some((s) => holding.path === s || holding.path.startsWith(`${s}/`)),
  );

  // PHASE `git-sync:pointer-bump` — superproject stage + content-guard + commit (this
  // commit is what bakes the bumped submodule pointers in). ALWAYS runs.
  const commitRes = await step('git-sync:pointer-bump', async () => {
    // EI-20428405431869483: detect generated routing drift while the dirty source
    // is still present, before the catch-all commit makes the source clean.
    try {
      await toolRoutingChecker({ runGit, repoPath: repo, log });
    } catch (e) {
      log(
        `[git-sync] ${repo}: tool-routing pre-commit check threw (${String(e)}) — continuing with the commit fail-soft`,
      );
    }
    // WI-39922: close the edit→auto-commit window that let a stale tracked catalog
    // reach the green gate hours later. Keep the catch HERE even though the default
    // implementation is defensive: an injected/future regenerator must never turn
    // this repair into a fleet-wide commit wedge.
    try {
      await toolCatalogRegenerator({ runGit, repoPath: repo, log });
    } catch (e) {
      log(
        `[git-sync] ${repo}: tool-catalog pre-commit repair threw (${String(e)}) — continuing with the commit fail-soft`,
      );
    }
    // EI-21444216858331991: a scheduled candidate was cut two seconds after an
    // `.mjs` source commit and eleven minutes before its generated `.d.mts` repair.
    // Regenerate here, then force every affected pair past per-agent peeling so
    // the source and projection share the same catch-all commit. Failure is
    // deliberately fail-closed: a dirty tree is recoverable; a published torn
    // snapshot can freeze `main` for the entire fleet.
    let declarationRepair: GeneratedDeclarationsRepairResult;
    try {
      declarationRepair = await generatedDeclarationsRegenerator({ runGit, repoPath: repo, log });
    } catch (e) {
      declarationRepair = { status: 'blocked', atomicPaths: [], detail: String(e).slice(0, 300) };
    }
    if (declarationRepair.status === 'blocked') {
      const dirtyPathCount = (await dirtyFiles(runGit, repo)).length;
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount: 0,
        error: `generated declaration repair blocked the commit: ${declarationRepair.detail}`,
        oversized: [],
        contentErrors: [],
        skippedPaths: [],
      };
    }
    // A failed status census is different from a failed declaration emit: the
    // latter has a known incoherent projection and must stop the whole commit,
    // while the former can safely defer the enrolled declaration surface once
    // its tracked paths have been inventoried. Keep those paths out of both
    // attribution and catch-all staging so unrelated work still lands.
    const deferredDeclarationPaths = declarationRepair.status === 'deferred' ? declarationRepair.atomicPaths : [];
    if (declarationRepair.status === 'deferred') {
      log(
        `[git-sync] ${repo}: declaration status census unavailable — deferring ${deferredDeclarationPaths.length} ` +
          'declaration-related path(s) while committing the unlocked remainder',
      );
    }
    return commitOneRepo(runGit, repo, {
      ...repoO,
      scope: 'superproject',
      excludePaths: [...superprojectExcludePaths, ...deferredDeclarationPaths],
      protectedHoldings: superprojectProtectedHoldings,
      refreshLiveLockHoldings: refreshLiveLockHoldingsForRepo?.('', submodulePaths),
      attribution: attributionMapForRepo(roster, '', repo),
      forceCatchAllPaths: declarationRepair.status === 'regenerated' ? declarationRepair.atomicPaths : [],
    });
  });
  const commitMetrics = {
    dirtyPathCount: commitRes.dirtyPathCount,
    committedCount: commitRes.committedCount,
  };
  let repoResult: RepoSyncResult;
  if (commitRes.skippedPaths && commitRes.skippedPaths.length > 0 && !commitRes.committedLocal) {
    repoResult = {
      status: 'skipped-locked',
      ...commitMetrics,
      skippedPaths: commitRes.skippedPaths,
      oversized: commitRes.oversized,
      contentErrors: commitRes.contentErrors,
    };
  } else if (commitRes.error) {
    repoResult = {
      status: 'error',
      ...commitMetrics,
      message: commitRes.error,
      oversized: commitRes.oversized,
      contentErrors: commitRes.contentErrors,
      skippedPaths: commitRes.skippedPaths,
    };
  } else if (pushBlocked) {
    // Committed locally (or there was nothing to commit); the network half waits for a
    // tick on which every submodule reconciled. Same shape reconcileAndPushOneRepo
    // returns for its own committed-but-did-not-push case (the offline path).
    superHeadSha = await headSha(runGit, repo);
    repoResult = commitRes.committedLocal
      ? {
          status: 'synced',
          ...commitMetrics,
          pushed: false,
          merged: false,
          oversized: commitRes.oversized,
          contentErrors: commitRes.contentErrors,
          skippedPaths: commitRes.skippedPaths,
        }
      : {
          status: 'nothing',
          ...commitMetrics,
          oversized: commitRes.oversized,
          contentErrors: commitRes.contentErrors,
          skippedPaths: commitRes.skippedPaths,
        };
    log(
      `[git-sync] ${sub.conflicts.length} conflict(s) + ${sub.errors.length} error(s) in submodules — superproject ${commitRes.committedLocal ? 'COMMITTED locally' : 'had nothing to commit'}, deferring only its push (${slug})`,
    );
  } else if (!reconcileSuperprojectOrigin) {
    // EI-20232774599730947: a bridged/p2p-only member is truly commit-only at
    // this layer. GitHub ingress + admission and the P2P worktree bridge own
    // remote-to-worktree flow; fetching/merging origin here is both redundant
    // and unsafe for an installer seed whose local P2P lineage intentionally
    // remains unrelated to GitHub main.
    //
    // WI-40066: a frozen repair may still have advanced release main on a
    // sibling commit after its exact patch already landed through canonical
    // staging. Legacy mode repairs that ancestry inside reconcileAndPushOneRepo,
    // but this branch deliberately never calls the origin/staging reconciler.
    // A bridged caller can opt into the same fail-closed proof as a standalone
    // checkpointed phase: fetch main, require every main-only tree entry to be
    // byte-identical, then record only the ancestry. The later P2P legs publish
    // and integrate this HEAD; this phase itself still pushes nothing.
    const releaseBridge = bridgeContainedReleaseMainOnCommitOnly
      ? await step('git-sync:push', () =>
          bridgeContainedReleaseMain(runGit, repo, {
            remote,
            branch,
            log,
          }),
        )
      : { status: 'not-needed' as const };
    superHeadSha = await headSha(runGit, repo);
    if (releaseBridge.status === 'error') {
      repoResult = {
        status: 'error',
        ...commitMetrics,
        message: releaseBridge.message,
        oversized: commitRes.oversized,
        contentErrors: commitRes.contentErrors,
        skippedPaths: commitRes.skippedPaths,
      };
    } else {
      if (releaseBridge.status === 'declined') {
        log(`[git-sync] ${repo}: release-main ancestry bridge declined — ${releaseBridge.reason}`);
      }
      const bridged = releaseBridge.status === 'bridged';
      repoResult =
        commitRes.committedLocal || bridged
          ? {
              status: 'synced',
              ...commitMetrics,
              pushed: false,
              merged: bridged,
              oversized: commitRes.oversized,
              contentErrors: commitRes.contentErrors,
              skippedPaths: commitRes.skippedPaths,
            }
          : {
              status: 'nothing',
              ...commitMetrics,
              oversized: commitRes.oversized,
              contentErrors: commitRes.contentErrors,
              skippedPaths: commitRes.skippedPaths,
            };
    }
  } else {
    // PHASE `git-sync:push` — superproject fetch + merge + push (the network half).
    const pushRes = await step('git-sync:push', async () => ({
      ...(await reconcileAndPushOneRepo(runGit, repo, { ...repoO, defaultBranch: branch }, commitRes.committedLocal)),
      headSha: await headSha(runGit, repo),
    }));
    superHeadSha = pushRes.headSha;
    repoResult = {
      ...pushRes,
      ...commitMetrics,
      oversized: commitRes.oversized,
      contentErrors: commitRes.contentErrors,
      skippedPaths: commitRes.skippedPaths,
    };
  }
  absorb(supr, 'superproject', repoResult);

  const conflicts = [...sub.conflicts, ...supr.conflicts];
  const errors = [...sub.errors, ...supr.errors];
  const pushed = [...sub.pushed, ...supr.pushed];
  const merged = [...sub.merged, ...supr.merged];
  const mergeCompleted = [...sub.mergeCompleted, ...supr.mergeCompleted];
  const oversized = [...sub.oversized, ...supr.oversized];
  const bulkExcluded = oversized.filter((f) => f.exclusionReason === 'cumulative-limit');
  const contentErrors = [...sub.contentErrors, ...supr.contentErrors];
  // Older in-flight checkpoints predate the skipped-path census. Replay must
  // reconstruct those phase outputs as an empty census rather than throwing or
  // turning a clean replay into an error.
  const skippedPaths = [...(sub.skippedPaths ?? []), ...(supr.skippedPaths ?? [])];
  const dirtyPathCount = (sub.dirtyPathCount ?? 0) + (supr.dirtyPathCount ?? 0);
  const committedCount = (sub.committedCount ?? 0) + (supr.committedCount ?? 0);
  const didSomething = sub.didSomething || supr.didSomething;

  if (conflicts.length > 0)
    return {
      status: 'conflict',
      dirtyPathCount,
      committedCount,
      conflicts,
      errors,
      pushed,
      merged,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      skippedPaths,
      strandedSubmodules,
    };
  if (errors.length > 0)
    return {
      status: 'error',
      dirtyPathCount,
      committedCount,
      errors,
      pushed,
      merged,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      skippedPaths,
      strandedSubmodules,
    };
  // A live lock is a partial exclusion, not a fleet-wide stop. Report the legacy
  // skipped verdict only when every visible dirty path was protected and the pass
  // made no progress anywhere. A pass that committed/pushed an unlocked sibling is
  // `synced` and still carries skippedPaths for observability + the next retry.
  if (skippedPaths.length > 0 && !didSomething)
    return {
      status: 'skipped-locked',
      dirtyPathCount,
      committedCount,
      skippedPaths,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      strandedSubmodules,
    };
  // NOTE 'nothing' carries the census too. A tick that commits nothing is the MOST likely
  // one to be stranding work — the visible tree is clean precisely because the dirty repo
  // is invisible — so this is the last status that should omit it.
  if (!didSomething)
    return {
      status: 'nothing',
      dirtyPathCount,
      committedCount,
      skippedPaths,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      strandedSubmodules,
    };
  // superHeadSha comes from the push step's checkpoint; a 'synced' verdict implies that
  // step ran (blocked/commit-error passes return above). Fallback read for safety only.
  return {
    status: 'synced',
    dirtyPathCount,
    committedCount,
    headSha: superHeadSha ?? (await headSha(runGit, repo)),
    pushed,
    merged,
    mergeCompleted,
    oversized,
    bulkExcluded,
    contentErrors,
    skippedPaths,
    strandedSubmodules,
  };
}
