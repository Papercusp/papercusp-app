/**
 * capability:git — run a git subcommand. A thin wrapper that spawns `git` with
 * argv directly (no shell, so no quoting hazards), routed through dispatch so a
 * distinct `capability:git` capability can be gated by the envelope separately
 * from arbitrary bash (P-010, `agent-capability-confinement-2026-06-13`).
 *
 * `push` is REFUSED — git-sync owns commit+push on the shared tree (mirrors the
 * fleet's `Bash(git push:*)` deny). Everything else (status/diff/log/add/commit
 * within a worktree) is allowed; output spills to a log if large.
 */

import { spawn as childSpawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { augmentedSpawnPath, resolveBin } from '../../plugin-spawn-impl';
import { resolveCapabilityBaseDir } from './base-dir';
import { INLINE_OUTPUT_CAP, scratchDir } from './bash-jobs';
import {
  assertCapabilitySandboxAvailable,
  buildCapabilitySandboxCommand,
  capabilityExecSandboxPolicy,
  scrubExecEnv,
} from './exec-sandbox';

/**
 * Exported so the bash-substitution audit can PIN its model to it
 * (`pairs/model-drift.test.ts`, WI-6157/D-015): `pairs/git-read.ts` claims a
 * closed list of read subcommands as substitutable, and every one of them must
 * be a subcommand this tool actually accepts. Refusing a new subcommand here
 * without removing it there would make the registry advise a substitution that
 * returns `refused`.
 */
export const REFUSED_SUBCOMMANDS = new Set(['push']);

const scratchCloneSpec = z.object({
  source: z
    .string()
    .min(1)
    .optional()
    .describe('Local repository path (absolute, or relative to cwd). Defaults to cwd/project dir. Remote URLs are refused.'),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe('Commit-ish to pin exactly and check out detached. Defaults to HEAD.'),
  destination: z
    .string()
    .min(1)
    .optional()
    .describe('Optional absolute, non-existing destination below the OS temp directory. Omit to create one safely.'),
  submodules: z
    .boolean()
    .optional()
    .describe('Materialise locally checked-out submodules at their exact pins (default true). No network fallback.'),
});

const cwdArg = z
  .string()
  .optional()
  .describe('Working dir (absolute, or relative to the project dir). Defaults to the project dir. In scratchClone mode it is the default source/base.');

const gitToolArgs = z.union([
  z.object({
    args: z.array(z.string()).min(1).describe('git arguments, e.g. ["status","--porcelain"] or ["diff","--stat"].'),
    cwd: cwdArg,
    scratchClone: z.never().optional(),
  }),
  z.object({
    args: z.never().optional(),
    cwd: cwdArg,
    scratchClone: scratchCloneSpec.describe('Guarded, cheap, disposable local clone. Use instead of ad-hoc `git clone`/copy commands for scratch work.'),
  }),
]);

export interface ScratchCloneResult {
  path: string;
  source: string;
  requestedRef: string;
  sha: string;
  submodules: number;
  borrowedRepositories: number;
}

export interface ScratchCloneOptions {
  source: string;
  ref?: string;
  destination?: string;
  includeSubmodules?: boolean;
  stateDir?: string;
  signal?: AbortSignal;
  sandboxEnabled?: boolean;
  sandboxRequired?: boolean;
}

interface ScratchCloneContext {
  stateDir: string | undefined;
  signal: AbortSignal;
  sandboxEnabled: boolean;
  sandboxRequired: boolean;
  submodules: number;
}

interface ScratchSubmodule {
  path: string;
}

const MAX_SCRATCH_SUBMODULES = 256;
const MAX_SCRATCH_SUBMODULE_DEPTH = 8;

function strictlyWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function parseScratchGitmodules(text: string): ScratchSubmodule[] {
  const out: ScratchSubmodule[] = [];
  let current: ScratchSubmodule | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[submodule\s+"[^"]+"\]$/.test(line)) {
      current = { path: '' };
      out.push(current);
      continue;
    }
    if (!current || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^path\s*=\s*(.*)$/.exec(line);
    if (match) current.path = match[1].trim();
  }
  return out.filter((entry) => entry.path.length > 0);
}

function scratchError(label: string, output: string): Error {
  const detail = output.trim();
  return new Error(`${label}${detail ? `: ${detail}` : ''}`);
}

async function gitStep(
  argv: string[],
  cwd: string,
  ctx: ScratchCloneContext,
  label: string,
): Promise<string> {
  const result = await runGit(
    argv,
    cwd,
    ctx.stateDir,
    ctx.signal,
    ctx.sandboxEnabled,
    ctx.sandboxRequired,
  );
  if (result.code !== 0) throw scratchError(label, result.output);
  return result.output.trim();
}

async function localRepositoryRoot(path: string, ctx: ScratchCloneContext, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute local path.`);
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`${label} is not an existing local directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = await gitStep(['rev-parse', '--show-toplevel'], canonical, ctx, `${label} is not a Git working tree`);
  const canonicalRoot = await realpath(root);
  if (!isAbsolute(canonicalRoot)) throw new Error(`${label} resolved to a non-absolute Git root.`);
  return canonicalRoot;
}

async function createOwnedTempDestination(requested?: string): Promise<string> {
  const tempRoot = await realpath(tmpdir());
  if (!requested) return mkdtemp(join(tempRoot, 'papercusp-git-scratch-'));
  if (!isAbsolute(requested)) throw new Error('scratchClone.destination must be absolute.');

  const parent = await realpath(dirname(requested));
  const destination = resolve(parent, basename(requested));
  if (!strictlyWithin(tempRoot, destination)) {
    throw new Error(`scratchClone.destination must be below the OS temp directory (${tempRoot}).`);
  }
  try {
    // Atomic ownership boundary: cleanup is allowed only after THIS mkdir succeeds.
    // An existing path (including a symlink) is never entered, modified, or removed.
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    throw new Error(`scratchClone.destination must not already exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  return destination;
}

async function verifyBorrowedObjects(destination: string): Promise<void> {
  const alternates = await readFile(join(destination, '.git', 'objects', 'info', 'alternates'), 'utf8').catch(() => '');
  if (!alternates.trim()) {
    throw new Error(`git clone did not create an object-store alternate for ${destination}; refusing a clone that may have copied its pack.`);
  }
}

async function materialiseLocalSubmodules(
  sourceRoot: string,
  destinationRoot: string,
  parentSha: string,
  ctx: ScratchCloneContext,
  depth: number,
): Promise<void> {
  const gitmodules = await readFile(join(destinationRoot, '.gitmodules'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const entries = parseScratchGitmodules(gitmodules);
  if (entries.length === 0) return;
  if (depth >= MAX_SCRATCH_SUBMODULE_DEPTH) {
    throw new Error(`scratchClone submodule nesting exceeds the safe depth limit (${MAX_SCRATCH_SUBMODULE_DEPTH}).`);
  }
  if (ctx.submodules + entries.length > MAX_SCRATCH_SUBMODULES) {
    throw new Error(`scratchClone submodule count exceeds the safe limit (${MAX_SCRATCH_SUBMODULES}).`);
  }

  // Preflight the whole level before cloning any child. A partial submodule tree
  // can make a test/lint produce a confident false answer, so there is no network
  // fallback and no "best effort" branch here.
  const ready: Array<{ source: string; destination: string; pin: string; path: string }> = [];
  for (const entry of entries) {
    if (isAbsolute(entry.path) || entry.path.split(/[\\/]+/).includes('..')) {
      throw new Error(`scratchClone refuses unsafe submodule path: ${entry.path}`);
    }
    const sourceCandidate = resolve(sourceRoot, entry.path);
    const destination = resolve(destinationRoot, entry.path);
    if (!strictlyWithin(sourceRoot, sourceCandidate) || !strictlyWithin(destinationRoot, destination)) {
      throw new Error(`scratchClone submodule path escapes its repository: ${entry.path}`);
    }
    const source = await localRepositoryRoot(sourceCandidate, ctx, `local submodule ${entry.path}`);
    if (source !== await realpath(sourceCandidate)) {
      throw new Error(`local submodule ${entry.path} is not checked out at its declared path.`);
    }
    const pin = await gitStep(
      ['rev-parse', '--verify', '--end-of-options', `${parentSha}:${entry.path}`],
      sourceRoot,
      ctx,
      `cannot resolve submodule pin for ${entry.path}`,
    );
    await gitStep(
      ['rev-parse', '--verify', '--end-of-options', `${pin}^{commit}`],
      source,
      ctx,
      `local submodule ${entry.path} does not contain pinned commit ${pin}`,
    );
    ready.push({ source, destination, pin, path: entry.path });
  }

  ctx.submodules += ready.length;
  for (const child of ready) {
    // Checkout materialises a gitlink as an empty directory. It is inside the
    // root directory this tool atomically created, so replacing it is safe.
    await rm(child.destination, { recursive: true, force: true });
    await gitStep(
      ['clone', '--local', '--shared', '--no-checkout', '--quiet', '--', child.source, child.destination],
      destinationRoot,
      ctx,
      `failed to clone local submodule ${child.path}`,
    );
    await verifyBorrowedObjects(child.destination);
    await gitStep(
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', child.pin],
      child.destination,
      ctx,
      `failed to check out local submodule ${child.path} at ${child.pin}`,
    );
    await gitStep(['remote', 'remove', 'origin'], child.destination, ctx, `failed to remove origin from submodule ${child.path}`);
    await materialiseLocalSubmodules(child.source, child.destination, child.pin, ctx, depth + 1);
  }
}

/**
 * Create a disposable, exact-ref local clone without copying the source pack.
 *
 * This is the guarded counterpart to ad-hoc agent shell clones (WI-38848). It
 * deliberately reuses the real-Git recipe proven by lint-as-committed:
 * `clone --local --shared --no-checkout` followed by detached checkout. Every
 * destination is atomically created by this function, so the failure cleanup
 * can never delete a caller/peer-owned directory.
 */
export async function createScratchClone(options: ScratchCloneOptions): Promise<ScratchCloneResult> {
  const ctx: ScratchCloneContext = {
    stateDir: options.stateDir,
    signal: options.signal ?? new AbortController().signal,
    sandboxEnabled: options.sandboxEnabled ?? false,
    sandboxRequired: options.sandboxRequired ?? false,
    submodules: 0,
  };
  const source = await localRepositoryRoot(options.source, ctx, 'scratchClone.source');
  const requestedRef = options.ref ?? 'HEAD';
  const sha = await gitStep(
    ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{commit}`],
    source,
    ctx,
    `scratchClone.ref does not resolve to a commit (${requestedRef})`,
  );

  const destination = await createOwnedTempDestination(options.destination);
  if (strictlyWithin(source, destination) || strictlyWithin(destination, source) || source === destination) {
    await rm(destination, { recursive: true, force: true });
    throw new Error('scratchClone source and destination must not contain one another.');
  }

  let complete = false;
  try {
    await gitStep(
      ['clone', '--local', '--shared', '--no-checkout', '--quiet', '--', source, destination],
      dirname(destination),
      ctx,
      'scratchClone failed to borrow the source repository',
    );
    await verifyBorrowedObjects(destination);
    await gitStep(
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', sha],
      destination,
      ctx,
      `scratchClone failed to check out ${sha}`,
    );
    await gitStep(['remote', 'remove', 'origin'], destination, ctx, 'scratchClone failed to remove origin');
    if (options.includeSubmodules !== false) {
      await materialiseLocalSubmodules(source, destination, sha, ctx, 0);
    }
    complete = true;
    return {
      path: destination,
      source,
      requestedRef,
      sha,
      submodules: ctx.submodules,
      borrowedRepositories: 1 + ctx.submodules,
    };
  } finally {
    if (!complete) await rm(destination, { recursive: true, force: true });
  }
}

export default defineTool({
  name: 'capability:git',
  description:
    'Run a git subcommand (argv, no shell), or create a guarded cheap local scratch clone that borrows object stores. `push` is refused (git-sync owns push).',
  guidance: {
    when: 'Inspect/stage git state, or make an ephemeral local checkout. For scratch work use scratchClone: it pins a detached ref, borrows packs, skips untracked node_modules, materialises only resolvable local submodules, and removes origins.',
    notWhen: 'Pushing (refused — git-sync owns push). Remote/network clones or persistent product checkouts. Arbitrary shell — use capability:bash.',
    chaining: 'Read form: capability:git { args: ["status","--porcelain"] }. Scratch form: capability:git { scratchClone: { ref: "HEAD" } } → use returned path; OS temp cleanup remains the lifecycle owner.',
    seeAlso: [
      'capability:bash (run an arbitrary shell command)',
      'dev:pipeline_position (where a committed edit is in the pipeline)',
    ],
  },
  capability: 'capability:git',
  requirePrincipal: false,
  // EI-18803497769946984: shells out to git (a fetch/clone can run minutes) and never
  // reads ctx.tx — holding the ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s), surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 120,
  args: gitToolArgs,
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    // Resolve the same server-owned profile as capability:bash. A confined git
    // subprocess cannot silently downgrade to raw host execution.
    const sandboxPolicy = await capabilityExecSandboxPolicy(ctx);

    if ('scratchClone' in args && args.scratchClone) {
      const requestedSource = args.scratchClone.source ?? cwd;
      const source = isAbsolute(requestedSource) ? requestedSource : resolve(cwd, requestedSource);
      try {
        const result = await createScratchClone({
          source,
          ref: args.scratchClone.ref,
          destination: args.scratchClone.destination,
          includeSubmodules: args.scratchClone.submodules,
          stateDir: ctx.stateDir,
          signal: ctx.signal,
          sandboxEnabled: sandboxPolicy.enabled,
          sandboxRequired: sandboxPolicy.required,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'scratchClone',
              ...result,
              detached: true,
              remotesRemoved: true,
              objectStorage: 'borrowed-local-alternates',
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              reason: 'scratch_clone_failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }

    const argv = args.args;
    const sub = argv.find((a) => !a.startsWith('-')) ?? '';
    if (REFUSED_SUBCOMMANDS.has(sub)) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'refused', message: `git ${sub} is refused — git-sync owns push on the shared tree.` }) },
        ],
        isError: true,
      };
    }
    // EI-20881501070735530: this was `ctx.projectDir ?? process.cwd()` — the ONE
    // capability tool missed when EI-1754 migrated read/write/edit/inspect/bash to
    // the shared resolver. A superuser ctx has `projectDir: undefined`, so git ran
    // in the :3070 operator's own cwd — the RELEASE checkout's `apps/operator/`
    // subdir (a different worktree, pinned to green `main`). Measured: `rev-parse
    // --show-toplevel` returned papercup-release with prefix `apps/operator/`, so a
    // repo-relative pathspec after `--` resolved to `apps/operator/<path>`, matched
    // nothing, and printed nothing at exit 0 — a confident FALSE ABSENCE for every
    // agent using `git log -- <path>` for landing/containment triage.
    const r = await runGit(
      argv,
      cwd,
      ctx.stateDir,
      ctx.signal,
      sandboxPolicy.enabled,
      sandboxPolicy.required,
    );
    const truncated = r.output.length > INLINE_OUTPUT_CAP;
    let logPath: string | undefined;
    let output = r.output;
    if (truncated) {
      logPath = join(scratchDir(ctx.stateDir), `git-${crypto.randomUUID().slice(0, 12)}.log`);
      try { createWriteStream(logPath, { flags: 'w' }).end(r.output); } catch { /* ignore */ }
      output = `${r.output.slice(0, INLINE_OUTPUT_CAP)}\n… [truncated — full output: ${logPath}]`;
    }
    // The cwd is part of the ANSWER, not debug noise: every result below is scoped
    // to this directory (and, for a worktree, to ITS branch). capability:bash has
    // always printed its cwd; capability:git printing none is what let the wrong-tree
    // reading above look like a normal empty result. (EI-20881501070735530)
    const header = `git ${argv.join(' ')} · exit ${r.code ?? 'null'} · cwd ${cwd}${truncated ? ` · spilled → ${logPath}` : ''}`;
    const body = output || `(no output)${emptyPathspecNote(argv, r.code, output, cwd)}`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n${body}` }],
      isError: r.code === null,
    };
  },
});

/**
 * The other half of EI-20881501070735530, kept even though the cwd bug above is
 * fixed: `git <cmd> -- <pathspec>` that matches NOTHING prints nothing and exits
 * **0**, so a wrong path (a typo, a submodule path queried from the superproject,
 * a path that only exists on another branch) is indistinguishable from a real
 * "no commits touch this file". That is the false-absence class this repo keeps
 * paying for, and here the instrument can just say which reading it is.
 *
 * Deliberately narrow: it fires ONLY when an explicit `--` pathspec was given and
 * the command still produced nothing at exit 0. It must never fire on a legitimate
 * empty result such as `git diff` over a clean tree, so no heuristic guesses at
 * bare trailing operands.
 *
 * Exported for unit testing.
 */
export function emptyPathspecNote(argv: string[], code: number | null, output: string, cwd: string): string {
  if (code !== 0 || output.trim() !== '') return '';
  const sep = argv.indexOf('--');
  if (sep === -1) return '';
  const pathspecs = argv.slice(sep + 1);
  if (pathspecs.length === 0) return '';
  return (
    `\n⚠ pathspec matched nothing in ${cwd} — git prints nothing and exits 0 for BOTH ` +
    `"no commits touch this path" and "this path does not exist here", so this is not ` +
    `evidence of absence. Pathspec: ${pathspecs.join(' ')}. Re-check with a positive ` +
    `control (the same query for a path you know is tracked), and note that a path inside ` +
    `a git SUBMODULE never matches from the superproject — run it with cwd set to the submodule.`
  );
}

/** Exported for direct unit testing (mirrors bash-jobs.ts's runForeground export) —
 *  decouples the env-scrub regression test from the flag/DB plumbing the
 *  `handler` above resolves `sandboxEnabled` through. */
export function runGit(
  argv: string[],
  cwd: string,
  _stateDir: string | undefined,
  signal: AbortSignal,
  sandboxEnabled = false,
  sandboxRequired = false,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const spawnPath = augmentedSpawnPath();
    const decision = buildCapabilitySandboxCommand(
      { cmd: [resolveBin('git', spawnPath), ...argv], cwd },
      { enabled: sandboxEnabled, required: sandboxRequired },
    );
    assertCapabilitySandboxAvailable(decision, cwd);
    if (sandboxEnabled && !decision.sandboxed) {
      console.warn(
        `[capability:git] exec-sandbox enabled but ${decision.reason} — running unsandboxed in the operator process (cwd ${cwd})`,
      );
    }
    const child = childSpawn(decision.binary, decision.argv, {
      cwd,
      // EI-1617: allowlist, not a full process.env passthrough — this subprocess
      // previously inherited every operator secret (DB creds, webhook/JWT
      // secrets, session keys, …) for no reason a `git status`/`diff`/`commit`
      // needs. See exec-sandbox.ts's scrubExecEnv.
      env: { ...scrubExecEnv(process.env), PATH: spawnPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const cap = 8 * 1024 * 1024;
    const onData = (b: Buffer): void => {
      if (output.length < cap) output += b.toString('utf8');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const onAbort = (): void => { child.kill('SIGKILL'); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code: null, output: output + `\n[spawn error] ${err instanceof Error ? err.message : String(err)}` });
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code, output });
    });
  });
}
