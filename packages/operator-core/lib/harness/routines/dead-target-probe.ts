/**
 * dead-target-probe — the I/O half of the dead-target routine reaper
 * (dead-target-routine-reaper-2026-08-30 P-002, from EI-19278517916030043).
 *
 * Gathers the structural facts about ONE install's tree and hands them to the pure decider in
 * `dead-target-routine-reaper.ts`. Everything that can be decided lives there; everything that
 * must touch the world lives here, so the interesting cases stay unit-testable.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT (D-003). `resolveProject` returns `null` for BOTH
 * "this slug is not registered" and "the registry could not be read" — the cross-workspace read
 * is wrapped in a bare catch that falls through to null (harness-core.ts:246-260), and
 * `resolveProject` returns that same null after its retired-slug alias fallback also misses
 * (:263-283). A reaper that keys a destructive action on a falsy path check would therefore, on
 * one transient registry hiccup, park every routine of every install it could not resolve.
 * So this probe DISCRIMINATES the two at the source, using the primitive the codebase already
 * built for exactly this distinction: `resolveWorkspaceForHarnessSlug` throws
 * `RegistryReadUnavailableError` specifically so that "nothing was found" is not returned as
 * the same null a genuine absence returns (harness-core.ts:379-408). The result is a tagged
 * union the decider cannot collapse.
 *
 * BOUNDED BY CONTRACT. Every filesystem and git call is wrapped so that a hang, an EACCES, or
 * an unparseable result becomes `null` / `'unknown'` — never a `false` that reads as absence.
 * There is deliberately no `git fsck`: it is O(repo) and this runs on a sweep across every
 * install. Instead we run the two cheap reads that the failing workload itself performs — a
 * HEAD resolve and an index-reading `status` — because the ei669 corruption surfaced precisely
 * there (`invalid object 100644 d75c463ae7… for '.papercusp/blueprint.yaml'` came out of
 * git-sync's commit, i.e. an index→object read), and a probe that cannot see the failure the
 * routine is dying on would be worse than no probe.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { resolveProject, resolveWorkspaceForHarnessSlug } from '../../harness-core';
import type { GitObjectStoreState, TargetProbe, TargetResolution } from './dead-target-routine-reaper';

// Lazy + memoized, NOT promisified at module scope (EI-10161): under a narrow
// `vi.mock('node:child_process')` `execFile` is undefined, and an eager `promisify` throws at
// IMPORT time — crashing every test file that reaches this module, even one that never calls it.
let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

/** Bound on each individual git read. Env-overridable; a sweep runs this per install. */
export function probeTimeoutMs(): number {
  const n = Number(process.env.PAPERCUSP_DEAD_TARGET_PROBE_TIMEOUT_MS ?? 5000);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/**
 * Git's own vocabulary for "the object store cannot be read". Matched against stderr.
 *
 * Deliberately NOT included: `not a git repository` (that is ABSENT, a different verdict) and
 * `did not match any file(s) known to git` (a path argument mistake, not corruption). A pattern
 * that over-matches here would turn an ordinary git error into a park, which is the failure
 * mode this whole design is arranged to avoid.
 */
const CORRUPTION_PATTERNS: readonly RegExp[] = [
  /invalid object/i,
  /could not get object info/i,
  /\bbad object\b/i,
  /object file .* is empty/i,
  /loose object .* is corrupt/i,
  /error: object file/i,
  /unable to read tree/i,
  /corrupt(ed)? (loose object|packfile|index)/i,
];

/** PURE: does this git stderr indicate an unreadable object store? Exported for unit testing. */
export function looksCorrupt(stderr: string | null | undefined): boolean {
  if (!stderr) return false;
  return CORRUPTION_PATTERNS.some((re) => re.test(stderr));
}

/** PURE: does this git stderr indicate there is simply no repository here? */
export function looksLikeNoRepo(stderr: string | null | undefined): boolean {
  if (!stderr) return false;
  return /not a git repository|does not appear to be a git repository/i.test(stderr);
}

/**
 * Three-valued existence check. `null` means WE COULD NOT TELL — an EACCES, an ELOOP, a
 * filesystem that hung. Only a real ENOENT/ENOTDIR is reported as `false`, because `false` is
 * the single observation in this whole subsystem that is allowed to lead to a park.
 */
export function existsTriState(path: string): boolean | null {
  try {
    statSync(path);
    return true;
  } catch (e: any) {
    const code = e?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    return null;
  }
}

async function runGit(cwd: string, args: string[], timeout: number): Promise<{ ok: boolean; stderr: string; timedOut: boolean }> {
  try {
    const { stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: true, stderr: String(stderr ?? ''), timedOut: false };
  } catch (e: any) {
    // `killed` + SIGTERM is how promisified execFile reports a timeout kill.
    const timedOut = Boolean(e?.killed) || e?.signal === 'SIGTERM' || e?.code === 'ETIMEDOUT';
    return { ok: false, stderr: String(e?.stderr ?? e?.message ?? ''), timedOut };
  }
}

/**
 * Inspect the git object store under an EXISTING root. Never throws.
 *
 * Runs the two cheap reads the failing workload performs, in increasing cost: resolve HEAD,
 * then read the index. `--untracked-files=no` keeps `status` off the expensive worktree scan
 * while still forcing the index→object reads where the ei669 corruption lived.
 */
export async function probeGitObjectStore(
  root: string,
  timeout = probeTimeoutMs(),
): Promise<{ state: GitObjectStoreState; error: string | null }> {
  const gitPath = existsTriState(join(root, '.git'));
  if (gitPath === false) return { state: 'absent', error: null };
  if (gitPath === null) return { state: 'unknown', error: 'could not stat .git' };

  for (const args of [
    ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    ['status', '--porcelain', '--untracked-files=no'],
  ]) {
    const r = await runGit(root, args, timeout);
    if (r.ok) continue;
    if (r.timedOut) return { state: 'unknown', error: `git ${args[0]} timed out after ${timeout}ms` };
    if (looksCorrupt(r.stderr)) return { state: 'corrupt', error: r.stderr.trim().slice(0, 500) };
    if (looksLikeNoRepo(r.stderr)) return { state: 'absent', error: null };
    // A non-zero exit we cannot classify is NOT evidence of corruption. `rev-parse --verify
    // --quiet` also exits non-zero on an unborn HEAD (a freshly-init'd repo), which is a
    // perfectly healthy tree — reporting that as corrupt would park a brand-new pot.
    return { state: 'unknown', error: r.stderr.trim().slice(0, 500) || `git ${args[0]} exited non-zero` };
  }

  return { state: 'readable', error: null };
}

/**
 * Resolve an install slug to an on-disk root, keeping "not registered" and "could not read the
 * registry" DISTINCT. See the module header — this is the whole point of the file.
 */
export async function resolveTarget(installSlug: string, workspaceId?: string): Promise<TargetResolution> {
  let project: Awaited<ReturnType<typeof resolveProject>> = null;
  try {
    project = await resolveProject(installSlug, workspaceId);
  } catch (e: any) {
    return { kind: 'read-failed', detail: String(e?.message ?? e).slice(0, 300) };
  }

  if (project?.path) return { kind: 'resolved', path: project.path };
  if (project) return { kind: 'read-failed', detail: 'registry entry resolved but carries no path' };

  // resolveProject returned null — which of the two meanings? Ask the primitive that throws
  // rather than returns null when it could not complete a read.
  try {
    await resolveWorkspaceForHarnessSlug(installSlug);
    return { kind: 'unresolvable' };
  } catch (e: any) {
    // RegistryReadUnavailableError (a leg never completed a read) or the ambiguous
    // multi-workspace collision Error. Both mean WE CANNOT TELL, which is not absence.
    return { kind: 'read-failed', detail: String(e?.message ?? e).slice(0, 300) };
  }
}

/**
 * Probe ONE install. Call this once per install per sweep — never once per routine; a pot with
 * four routines must not pay four filesystem+git probes for one answer.
 *
 * Never throws: anything unexpected lands in `probeError`, which the decider treats as
 * "the probe did not complete" and refuses to act on.
 */
export async function probeTarget(
  installSlug: string,
  workspaceId: string,
  opts: { timeoutMs?: number } = {},
): Promise<TargetProbe> {
  const timeout = opts.timeoutMs ?? probeTimeoutMs();
  try {
    const resolution = await resolveTarget(installSlug, workspaceId);
    if (resolution.kind !== 'resolved') {
      return { installSlug, workspaceId, resolution };
    }

    const rootExists = existsTriState(resolution.path);
    if (rootExists !== true) {
      // Nothing under an absent (or unreadable) root is worth probing, and reporting a git
      // state here would let the decider name the wrong fault.
      return { installSlug, workspaceId, resolution, rootExists };
    }

    const harnessDirExists = existsTriState(join(resolution.path, '.papercusp'));
    const git = await probeGitObjectStore(resolution.path, timeout);
    return {
      installSlug,
      workspaceId,
      resolution,
      rootExists,
      harnessDirExists,
      gitObjectStore: git.state,
      gitError: git.error,
    };
  } catch (e: any) {
    return {
      installSlug,
      workspaceId,
      resolution: { kind: 'read-failed', detail: 'probe threw' },
      probeError: String(e?.message ?? e).slice(0, 300),
    };
  }
}
