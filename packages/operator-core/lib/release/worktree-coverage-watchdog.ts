/**
 * worktree-coverage-watchdog — WI-3612 (EI-8820 follow-up sweep, item #2): detect a git
 * worktree that is carrying uncommitted edits but that NO git-sync routine (or documented
 * intentional exclusion) covers.
 *
 * THE GAP this closes: EI-8820 found + fixed the ACUTE bug (a `PreToolUse` guard now BLOCKS
 * an agent edit that resolves to a non-canonical linked worktree — see
 * `apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh`), but that guard only stops a
 * FUTURE edit from landing there; nothing detects a worktree that ALREADY has dirty state no
 * routine will ever commit. WI-3449 (2026-07-09, settings-page audit) was stranded for hours
 * this exact way — an agent worked inside the linked `env-trees/staging` worktree, and only a
 * peer noticing the feature "never landed" caught it.
 *
 * WHAT COUNTS AS COVERED, three ways (checked in order):
 *   1. It IS the canonical tree itself (git-sync's own commit target).
 *   2. Its path matches a documented, deliberately-uncovered pattern — the repo's own
 *      workspace map (`system/repo-conventions` + this repo's CLAUDE.md) names these
 *      explicitly: `-release` / `-checkpoint` suffixed sibling trees (reset + swept every
 *      deploy/checkpoint run — dirty state there is EXPECTED, not stranded work), the
 *      `env-trees/<id>` D-006 env-operator serving trees (`env-tree-prepare.ts` — force-
 *      recreatable from `origin/<branch>` on every provision, deliberately never committed),
 *      and `.papercusp/worktrees/<slug>` migration/synthesis isolation trees (their OWN
 *      dedicated sync path, not git-sync's).
 *   3. Nothing else. A dirty worktree that matches NEITHER of the above is a genuine finding
 *      — most likely a stray worktree an agent created (or worked inside) that no routine will
 *      ever commit, i.e. exactly the WI-3449 class.
 *
 * Cheap by design (WI-3612 asked for a "cheap recurring check"): no DB round-trip, no
 * install_slug→path resolution — it shells `git worktree list --porcelain` from the canonical
 * tree (which enumerates every linked worktree of THIS repo) and `git status --porcelain` on
 * each, so it is O(worktrees), typically single digits. Process-level (`managedSetInterval`,
 * matching the git-sync-stall-watchdog / green-stall-watchdog siblings) — best-effort, must
 * never fail boot, logs + notifies on a genuine finding rather than paging urgently (this is a
 * "someone should look" signal, not a "code is stranding right now" page).
 *
 * Kill-switch: PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG='0'.
 */
import { execFile } from 'node:child_process';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  gitSidecarEnabled,
  isSidecarInfrastructureFault,
  noteSidecarFallback,
  runGitViaSpawnerSidecar,
  type GitRunResult,
} from '../fleet/git-via-sidecar';

export interface WorktreeInfo {
  /** Absolute worktree path, as reported by `git worktree list --porcelain`. */
  path: string;
  /** True when `git status --porcelain` reports ≥1 line for this worktree (uncommitted
   *  changes, staged or not — tracked or untracked). */
  dirty: boolean;
  /** Number of `git status --porcelain` lines, for a more informative log line. */
  dirtyFileCount: number;
}

/**
 * Deliberately-excluded path patterns — kept as REGEXES (not exact strings) so they match
 * regardless of which sibling-repo layout / workspace root a given install uses (this repo's
 * own siblings are `papercup-release`/`papercup-checkpoint`/`papercusp-checkpoint`, but the
 * pattern intentionally isn't pinned to those exact names — see the class of trees named in
 * repo-conventions § workspace map + this file's header comment). Exported so the detector's
 * behavior is independently documented + testable, not buried in the classifier.
 */
export const KNOWN_UNCOVERED_WORKTREE_PATTERNS: readonly RegExp[] = [
  // Deploy artifact / green-checkpoint test trees — reset + swept every run by design.
  /-release(\/|$)/,
  /-checkpoint(\/|$)/,
  // D-006 env-operator serving trees (env-tree-prepare.ts) — force-recreated from
  // origin/<branch> on every provision; never meant to be committed.
  /\.papercusp(-workspaces\/[^/]+\/\.papercusp)?\/env-trees\//,
  // Migration/synthesis isolation worktrees — their OWN dedicated sync path.
  /\.papercusp\/worktrees\//,
  // Release-cut trees (`*-relcut-NNNN`, `*-relcut-NNNN-stable`) — cut from a pinned ref
  // for a release and left dirty by design, same class as -release/-checkpoint above.
  // Measured 2026-08-14: papercusp-relcut-0016 and -0017-stable each carry 1 dirty file
  // permanently, so without this they are a standing false positive on every sweep.
  /-relcut-/,
];

/**
 * Pure: classify which of `worktrees` are UNCOVERED — dirty, not the canonical tree, and not
 * matching a documented exclusion pattern. Exported for unit testing without real git.
 */
export function findUncoveredDirtyWorktrees(
  worktrees: readonly WorktreeInfo[],
  canonicalPath: string,
  patterns: readonly RegExp[] = KNOWN_UNCOVERED_WORKTREE_PATTERNS,
): WorktreeInfo[] {
  return worktrees.filter((wt) => {
    if (!wt.dirty) return false;
    if (wt.path === canonicalPath) return false;
    return !patterns.some((re) => re.test(wt.path));
  });
}

export interface WorktreeCoverageDeps {
  /** Run a git command in `cwd`, returning stdout (throws on non-zero exit). Injected for
   *  tests; default shells out via execFile. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  log?: (message: string) => void;
}

function runGitLocal(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve(stdout.toString());
    });
  });
}

/** Seams for {@link runWatchdogGit}; production uses the real sidecar + local spawn. */
export interface WatchdogGitSeams {
  sidecarEnabled?: () => boolean;
  viaSidecar?: (args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<GitRunResult>;
  local?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
  onFallback?: (e: unknown) => void;
}

/**
 * The default git runner. On the bg-host it runs git inside the spawner sidecar.
 * The sibling-checkout pass runs three git calls per checkout across ~50
 * checkouts, and a fork() from the big host process costs ~200 ms each at
 * ~12 GB RSS. One pass measured 161 forks and ~32 s of blocked main thread
 * (WI-10005446, 2026-10-02 11:00:46-11:03:56Z). A sidecar fault falls back to
 * a local spawn: degraded, never broken. A non-zero git exit rejects exactly
 * as the local path does.
 */
export async function runWatchdogGit(
  args: string[],
  cwd: string,
  seams: WatchdogGitSeams = {},
): Promise<string> {
  const env = args[0] === 'status'
    ? { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    : process.env;
  const enabled = seams.sidecarEnabled ?? (() => gitSidecarEnabled('PAPERCUSP_WORKTREE_COVERAGE_SPAWN_SIDECAR'));
  const onFallback = seams.onFallback ?? ((e: unknown) => noteSidecarFallback('worktree-coverage', e));
  if (enabled()) {
    let res: GitRunResult | null = null;
    try {
      // Pass THIS process's env: the sidecar otherwise runs git under its own env.
      res = await (seams.viaSidecar ?? runGitViaSpawnerSidecar)(args, cwd, 30_000, env);
    } catch (e) {
      onFallback(e);
    }
    if (res && isSidecarInfrastructureFault(res)) {
      onFallback(new Error(res.stderr));
      res = null;
    }
    if (res) {
      if (res.code !== 0) throw new Error(res.stderr.trim() || `git ${args[0] ?? ''} exited ${res.code}`);
      return res.stdout;
    }
  }
  return (seams.local ?? runGitLocal)(args, cwd, env);
}

function defaultRunGit(args: string[], cwd: string): Promise<string> {
  return runWatchdogGit(args, cwd);
}

/** Parse `git worktree list --porcelain` output into the set of absolute worktree paths. */
export function parseWorktreeListPorcelain(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

/**
 * Enumerate every linked worktree of the repo containing `canonicalPath`, with each one's
 * dirty state. Best-effort per-worktree: a worktree whose `git status` fails (e.g. deleted
 * off disk since `worktree list` last ran) is skipped rather than failing the whole scan.
 */
export async function listWorktreesWithDirtyState(
  canonicalPath: string,
  deps: WorktreeCoverageDeps = {},
): Promise<WorktreeInfo[]> {
  const runGit = deps.runGit ?? defaultRunGit;
  const listOut = await runGit(['worktree', 'list', '--porcelain'], canonicalPath);
  const paths = parseWorktreeListPorcelain(listOut);
  const results: WorktreeInfo[] = [];
  for (const path of paths) {
    try {
      const statusOut = await runGit(['status', '--porcelain'], path);
      const lines = statusOut.split('\n').filter((l) => l.trim().length > 0);
      results.push({ path, dirty: lines.length > 0, dirtyFileCount: lines.length });
    } catch {
      // Worktree vanished / inaccessible since `worktree list` ran — not this watchdog's
      // concern (a missing tree can't strand uncommitted work); skip it.
    }
  }
  return results;
}

export interface WorktreeCoverageCheckResult {
  uncovered: WorktreeInfo[];
}

/**
 * EI-9922: true when a git error is "this dir is not a git repository" — the EXPECTED
 * state on a PACKAGED install (there is no checkout, hence no worktrees to cover). On
 * that error this watchdog has nothing to do and should stay silent rather than log a
 * scary "pass failed" line on every boot + hourly sweep (it was one of the ~15+
 * 'fatal: not a git repository' boot-log lines). A genuine git fault (a real repo whose
 * `git worktree list` failed for another reason) is NOT this and still logs. Exported
 * for direct unit testing.
 */
export function isNotARepoError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not a git repository/i.test(msg);
}

/**
 * One watchdog pass: list worktrees, classify, log + best-effort notify on any genuine
 * finding. Never throws (mirrors the git-sync-stall-watchdog / green-stall-watchdog
 * process-level siblings — a detector must not be able to crash the host it watches).
 */
export async function checkWorktreeCoverage(
  canonicalPath: string,
  deps: WorktreeCoverageDeps = {},
): Promise<WorktreeCoverageCheckResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const worktrees = await listWorktreesWithDirtyState(canonicalPath, deps);
    const uncovered = findUncoveredDirtyWorktrees(worktrees, canonicalPath);
    if (uncovered.length > 0) {
      const detail = uncovered.map((w) => `${w.path} (${w.dirtyFileCount} dirty)`).join('; ');
      // A log line, not a notifyAttention() push/SSE alert: this is a "someone should
      // look eventually" signal (drift that accumulates over hours), not an urgent page —
      // notifyAttention's own doc reserves its 'needs-human' kind for ≥high-importance
      // items, which this genuinely isn't. The operator log + this function's return
      // value (a caller — an admin diagnostic route, a future scheduled digest — can
      // surface it more visibly) are the right-weight channel for a cheap, infrequent
      // sweep like this one.
      log(
        `[worktree-coverage-watchdog] ${uncovered.length} worktree(s) carry uncommitted edits ` +
          `no known routine/exclusion covers — likely stranded work (WI-3449 class): ${detail}`,
      );
    }
    return { uncovered };
  } catch (e) {
    // EI-9922: a PACKAGED install has no git checkout — `git worktree list` fatals with
    // "not a git repository". That is the EXPECTED no-op state (nothing to cover), not a
    // fault worth a boot-log line every boot + hour, so go quiet on it. Any OTHER git
    // failure (a real repo that errored for another reason) still logs, tagged.
    if (!isNotARepoError(e)) {
      log(`[worktree-coverage-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
    return { uncovered: [] };
  }
}

let watchdogTimer: ManagedHandle | null = null;

/** Default sweep cadence — this is a "someone should look" signal, not an urgent page, and
 *  the condition it catches (an agent working inside a stray worktree) develops over at least
 *  minutes-to-hours, so an hourly sweep is ample per WI-3612's "cheap" ask. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep. Idempotent.
 * Kill-switch: PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG='0'.
 */
export function startWorktreeCoverageWatchdog(
  canonicalPath: string,
  opts: WorktreeCoverageDeps & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = (): void => {
    void checkWorktreeCoverage(canonicalPath, opts);
    // WI-38857: the linked-worktree pass above CANNOT see a sibling clone of another repo.
    // Both legs share this one timer so there is a single watchdog surface (and a single
    // kill-switch) rather than two schedules reporting on overlapping trees.
    void checkGitSyncCoverage(canonicalPath, opts);
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('worktree-coverage-watchdog', intervalMs, run, { category: 'watchdog' });
}

// ---------------------------------------------------------------------------
// Sibling-CLONE coverage — WI-38857 (detector) / EI-20443492691207801 (the loss)
//
// Everything above can only ever see LINKED WORKTREES OF ONE REPO: it enumerates
// with `git worktree list --porcelain` run inside the canonical checkout, so an
// independent CLONE of a DIFFERENT repo sitting next to it in the workspace root
// is structurally invisible — not "missed", *unreachable*. That is exactly how
// ~/papercupai-workspace/sidestage accumulated 54 dirty files / 1,406 insertions
// whose content existed in NO git object store, while a healthy hive checkout of
// the same repo synced normally two directories away. The same blind spot was
// hiding ~9 more dirty sibling checkouts at the time this was written
// (papercup-improvement-runner 22 dirty / ~70d, papercusp-desktop 18 / ~67d,
// storewolf-central-server 13, Storewolf-Libs 13, ...).
//
// Coverage is decided by the AUTHORITATIVE signal, never a directory marker: an
// ACTIVE harness_shared.routines row with target_role='system:git-sync' whose
// install_slug resolves, through the harness registry (ProjectEntry {slug,path}),
// to that checkout's realpath. WI-38857 records why a per-directory marker proxy
// (".papercusp/blueprint.yaml" et al) is wrong — it reports the canonical papercusp
// tree itself as unregistered though it is definitely swept, so a guard built on it
// emits confident false positives AND misses real gaps.
// ---------------------------------------------------------------------------

/** A git checkout found by scanning a workspace root (a CLONE, not a linked worktree). */
export interface CheckoutInfo extends WorktreeInfo {
  /** Committer epoch (seconds) of HEAD, or null when the checkout has no commits.
   *  Reported for triage only — staleness is NOT part of the uncovered verdict. */
  lastCommitEpochSec: number | null;
}

/** An ACTIVE git-sync routine whose registry path no longer exists on disk — the
 *  INVERSE failure WI-38857 asks for: coverage that looks present but sweeps nothing. */
export interface StaleCoverage {
  installSlug: string;
  path: string;
}

export interface GitSyncCoverage {
  /** Realpath-normalized checkout paths an active git-sync routine actually resolves to. */
  coveredPaths: string[];
  staleCoverage: StaleCoverage[];
}

/** Trailing-slash-insensitive comparison key. `git worktree list` and a readdir join
 *  disagree about trailing slashes, and an unnormalized compare silently reports a
 *  covered tree as uncovered. */
export function normalizeCheckoutPath(p: string): string {
  const trimmed = p.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

/**
 * Pure: resolve ACTIVE git-sync install slugs against registry entries, splitting into
 * paths that ARE covered and coverage rows pointing at a path that no longer exists.
 * `existingPaths` is the set of paths confirmed present on disk (injected, so this stays
 * pure and unit-testable without a filesystem).
 */
export function resolveGitSyncCoverage(
  activeGitSyncSlugs: readonly string[],
  projects: readonly { slug: string; path: string }[],
  existingPaths: ReadonlySet<string>,
): GitSyncCoverage {
  const bySlug = new Map(projects.map((p) => [p.slug, normalizeCheckoutPath(p.path)]));
  const coveredPaths: string[] = [];
  const staleCoverage: StaleCoverage[] = [];
  for (const slug of activeGitSyncSlugs) {
    const path = bySlug.get(slug);
    // A routine whose slug has NO registry entry resolves to no path at all: it cannot
    // make any checkout covered, and it is not "stale coverage of a path" either — there
    // is no path to have gone missing. Silently contributing nothing is correct.
    if (!path) continue;
    if (existingPaths.has(path)) coveredPaths.push(path);
    else staleCoverage.push({ installSlug: slug, path });
  }
  return { coveredPaths, staleCoverage };
}

/**
 * One INSTANCE-SPECIFIC checkout that a human/agent investigated and judged to hold no
 * work at risk — deliberately a different mechanism from KNOWN_UNCOVERED_WORKTREE_PATTERNS
 * above, which covers whole CLASSES of tree that are dirty BY DESIGN (release, checkpoint,
 * relcut, env-trees) and can never strand anything.
 *
 * These entries are the opposite: ordinary checkouts that COULD strand work and happened
 * not to, as of one dated investigation. Recording them as a plain regex in the by-design
 * list would silence them permanently and throw away the reason — so each entry carries
 * its reason, its date, and its work-item, and re-arms on drift (below).
 */
export interface TriagedCheckoutScopeOut {
  /** Matched against the normalized absolute checkout path. */
  pattern: RegExp;
  /** WHY this checkout's uncommitted content is not work at risk. Written for the next
   *  reader who has to decide whether the exclusion still holds. */
  reason: string;
  /** ISO date the triage was performed. */
  triagedAt: string;
  /** The work-item carrying the full evidence. */
  workItem: string;
  /**
   * Dirty-file count measured AT TRIAGE TIME. The verdict was reached against that exact
   * dirty set, so it cannot speak for a different one: if the count no longer matches,
   * uncommitted content appeared or changed since the investigation and the checkout
   * RE-ARMS (reported as uncovered again).
   *
   * This is what stops a scope-out from rotting into permanent blindness — the failure
   * mode this whole detector exists to prevent, one level up (an alarm nobody can act on
   * decays into an ignorable alarm; an exclusion nobody can revisit decays into a blind
   * spot). Cheap, and it fails toward alarming rather than toward silence.
   */
  dirtyFileCountAtTriage: number;
}

/**
 * Checkouts triaged under WI-38888 and found to carry nothing at risk. Every one was
 * verified to have ZERO unpushed commits (so only working-tree content was ever in
 * question) and to have its dirty content either superseded upstream or non-source.
 */
export const TRIAGED_CHECKOUT_SCOPE_OUTS: readonly TriagedCheckoutScopeOut[] = [
  {
    pattern: /\/papercusp-desktop$/,
    reason:
      'Not a shadow: the live SIB_SIDECAR build-artifact donor (2.2G prebuilt) that ' +
      '~/bin/papercusp-dev-window.sh symlinks in to avoid a full sidecar rebuild. Its source ' +
      'diffs are all superseded by the papercusp/papercusp-desktop SUBMODULE (verified ' +
      'per-file: main.rs embedder refactor, native_terminal BLUE_FROST_TERMINAL_BG, ' +
      'build-desktop-sidecar.sh better-sqlite3/embedder — the submodule went further on each). ' +
      'MUST NOT be onboarded (would auto-commit 2.2G of build artifacts) or deleted. ' +
      'NB the count below is 18 = 17 modified TRACKED files + the untracked src-tauri/icons/' +
      'the-hive/ directory, whose icons also exist in the submodule; `git status --porcelain` ' +
      'counts that "??" line, so a 17 here (tracked diffs only) would re-arm this entry forever.',
    triagedAt: '2026-08-15',
    workItem: 'WI-38888',
    dirtyFileCountAtTriage: 18,
  },
  {
    pattern: /\/papercup-improvement-runner$/,
    reason:
      'A stale (2026-06-05) clone of the monorepo. 21 of its 22 dirty files are ort-wasm ' +
      'build artifacts; the only source file, coord-inbox-bus.ts, adds a maybeCloseListener() ' +
      'PG-listener cleanup that is ALREADY LIVE in the monorepo at the identical call site ' +
      '(and the live version went further — 345 lines vs this clone\'s 258).',
    triagedAt: '2026-08-15',
    workItem: 'WI-38888',
    dirtyFileCountAtTriage: 22,
  },
  {
    pattern: /\/papercusp-registry$/,
    reason:
      'Both dirty files are non-work: next-env.d.ts is Next.js-autogenerated ("should not be ' +
      'edited") and drifted only in a routes.d.ts import path, and next.config.js adds ' +
      'typescript.ignoreBuildErrors + eslint.ignoreDuringBuilds — a local build-suppression ' +
      'hack that would be actively undesirable to preserve.',
    triagedAt: '2026-08-15',
    workItem: 'WI-38888',
    dirtyFileCountAtTriage: 2,
  },
  {
    pattern: /\/templates-mirror$/,
    reason:
      'Its one dirty file (template-kit/src/composition.ts) drops composesWith resolution from ' +
      'validateTemplateSet UNCONDITIONALLY — dead exploratory residue superseded by the ' +
      'canonical monorepo templates, which solve the same problem better via an ' +
      'allowExternalComposesWith opt-in that keeps strict registry mode as the default (present ' +
      'in all 3 app-scope roots, tracked and clean, and used by their composition-integrity checks).',
    triagedAt: '2026-08-15',
    workItem: 'WI-38888',
    dirtyFileCountAtTriage: 1,
  },
];

/**
 * Pure: the scope-out decision for one checkout.
 *
 * Returns the matching entry only when it still SPEAKS FOR this checkout's current state.
 * A path match whose dirty-file count has drifted returns `{ entry, drifted: true }` — the
 * caller must treat that as uncovered (re-armed), because the recorded verdict was reached
 * against a different dirty set and cannot vouch for the new content.
 */
export function matchTriagedScopeOut(
  path: string,
  dirtyFileCount: number,
  scopeOuts: readonly TriagedCheckoutScopeOut[] = TRIAGED_CHECKOUT_SCOPE_OUTS,
): { entry: TriagedCheckoutScopeOut; drifted: boolean } | null {
  const normalized = normalizeCheckoutPath(path);
  const entry = scopeOuts.find((s) => s.pattern.test(normalized));
  if (!entry) return null;
  return { entry, drifted: dirtyFileCount !== entry.dirtyFileCountAtTriage };
}

/**
 * Pure: classify which scanned checkouts are UNCOVERED — carrying uncommitted work with
 * no active git-sync routine resolving to them.
 *
 * Deliberately NOT part of the verdict: staleness. A tree dirty for 70 days and a tree
 * dirty for 70 seconds are the same defect (nothing will ever commit either); adding an
 * age floor would only have hidden the ~70-day cases that motivated this.
 */
export function findUncoveredDirtyCheckouts(
  checkouts: readonly CheckoutInfo[],
  opts: {
    canonicalPath: string;
    coveredPaths: readonly string[];
    /** Linked worktrees of the canonical repo — already judged by the pass above; excluded
     *  here so one tree can never produce two findings. */
    linkedWorktreePaths?: readonly string[];
    patterns?: readonly RegExp[];
    /** Dated, reasoned per-checkout exclusions; each re-arms if its dirty set drifts. */
    scopeOuts?: readonly TriagedCheckoutScopeOut[];
  },
): CheckoutInfo[] {
  const patterns = opts.patterns ?? KNOWN_UNCOVERED_WORKTREE_PATTERNS;
  const scopeOuts = opts.scopeOuts ?? TRIAGED_CHECKOUT_SCOPE_OUTS;
  const canonical = normalizeCheckoutPath(opts.canonicalPath);
  const covered = new Set(opts.coveredPaths.map(normalizeCheckoutPath));
  const linked = new Set((opts.linkedWorktreePaths ?? []).map(normalizeCheckoutPath));
  return checkouts.filter((c) => {
    const path = normalizeCheckoutPath(c.path);
    if (!c.dirty) return false;
    if (path === canonical) return false;
    if (covered.has(path)) return false;
    if (linked.has(path)) return false;
    if (patterns.some((re) => re.test(path))) return false;
    // A triaged scope-out suppresses the finding ONLY while its dirty set is unchanged.
    const scoped = matchTriagedScopeOut(path, c.dirtyFileCount, scopeOuts);
    if (scoped && !scoped.drifted) return false;
    return true;
  });
}

export interface GitSyncCoverageDeps extends WorktreeCoverageDeps {
  /** Absolute paths of the immediate children of `root`. Injected for tests. */
  listChildDirs?: (root: string) => Promise<string[]>;
  /** Resolve symlinks; `~/papercupai-workspace/papercup` is a SYMLINK to the canonical
   *  `papercusp` tree, so without this it is scanned twice under two names. */
  realpath?: (p: string) => Promise<string>;
  pathExists?: (p: string) => Promise<boolean>;
  /** install_slugs of ACTIVE `target_role='system:git-sync'` routines. */
  loadActiveGitSyncSlugs?: () => Promise<string[]>;
  loadRegistryProjects?: () => Promise<{ slug: string; path: string }[]>;
}

async function defaultListChildDirs(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(root, e.name));
}

async function defaultPathExists(p: string): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultRealpath(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function defaultLoadActiveGitSyncSlugs(): Promise<string[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ install_slug: string }>>`
    SELECT DISTINCT install_slug
      FROM harness_shared.routines
     WHERE active = true AND target_role = 'system:git-sync'
  `;
  return rows.map((r) => r.install_slug);
}

async function defaultLoadRegistryProjects(): Promise<{ slug: string; path: string }[]> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const registry = await loadHarnessRegistry();
  return (registry.projects ?? []).map((p) => ({ slug: p.slug, path: p.path }));
}

/**
 * Enumerate the git CHECKOUTS directly under `root` (one level — these are sibling clones,
 * not a recursive tree walk), each with its dirty-file count and HEAD commit time.
 * Deduped by realpath. Best-effort per entry: a directory that is not a checkout, or whose
 * git commands fail, is skipped rather than failing the sweep.
 */
export async function listSiblingCheckoutsWithDirtyState(
  root: string,
  deps: GitSyncCoverageDeps = {},
): Promise<CheckoutInfo[]> {
  const runGit = deps.runGit ?? defaultRunGit;
  const listChildDirs = deps.listChildDirs ?? defaultListChildDirs;
  const realpath = deps.realpath ?? defaultRealpath;

  const children = await listChildDirs(root);
  const seen = new Set<string>();
  const results: CheckoutInfo[] = [];
  for (const child of children) {
    const path = normalizeCheckoutPath(await realpath(child));
    if (seen.has(path)) continue; // the papercup -> papercusp symlink lands here
    seen.add(path);
    try {
      // Only a checkout ROOT counts. A subdirectory of one would report its parent's
      // dirty state and be reported under a path no routine is ever keyed to.
      const top = normalizeCheckoutPath((await runGit(['rev-parse', '--show-toplevel'], path)).trim());
      if (top !== path) continue;
      const statusOut = await runGit(['status', '--porcelain'], path);
      const lines = statusOut.split('\n').filter((l) => l.trim().length > 0);
      let lastCommitEpochSec: number | null = null;
      try {
        const ts = (await runGit(['log', '-1', '--format=%ct'], path)).trim();
        lastCommitEpochSec = ts ? Number.parseInt(ts, 10) : null;
        if (Number.isNaN(lastCommitEpochSec)) lastCommitEpochSec = null;
      } catch {
        lastCommitEpochSec = null; // a checkout with no commits yet
      }
      results.push({ path, dirty: lines.length > 0, dirtyFileCount: lines.length, lastCommitEpochSec });
    } catch {
      // Not a git checkout, or git failed on it — nothing this detector can say.
    }
  }
  return results;
}

export interface GitSyncCoverageCheckResult {
  uncovered: CheckoutInfo[];
  staleCoverage: StaleCoverage[];
  /** False when the authoritative coverage set could not be loaded. `uncovered` is then
   *  EMPTY BY CONSTRUCTION — read it as "not measured", never as "nothing is stranded". */
  coverageResolved: boolean;
}

/**
 * One sibling-clone coverage pass. Never throws (same contract as checkWorktreeCoverage).
 *
 * If the coverage set cannot be resolved, this reports NOTHING rather than guessing:
 * without the registry+routines join every dirty sibling looks uncovered, and a detector
 * that alarms without its authoritative input trains everyone to ignore it.
 */
export async function checkGitSyncCoverage(
  canonicalPath: string,
  deps: GitSyncCoverageDeps = {},
): Promise<GitSyncCoverageCheckResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const empty: GitSyncCoverageCheckResult = { uncovered: [], staleCoverage: [], coverageResolved: false };
  try {
    const { dirname } = await import('node:path');
    const pathExists = deps.pathExists ?? defaultPathExists;
    const loadSlugs = deps.loadActiveGitSyncSlugs ?? defaultLoadActiveGitSyncSlugs;
    const loadProjects = deps.loadRegistryProjects ?? defaultLoadRegistryProjects;

    let activeSlugs: string[];
    let projects: { slug: string; path: string }[];
    try {
      [activeSlugs, projects] = await Promise.all([loadSlugs(), loadProjects()]);
    } catch (e) {
      log(
        `[worktree-coverage-watchdog] git-sync coverage NOT MEASURED this pass ` +
          `(registry/routines unavailable: ${e instanceof Error ? e.message : String(e)}) — ` +
          `reporting nothing rather than guessing`,
      );
      return empty;
    }

    const existing = new Set<string>();
    for (const p of projects) {
      if (await pathExists(p.path)) existing.add(normalizeCheckoutPath(p.path));
    }
    const { coveredPaths, staleCoverage } = resolveGitSyncCoverage(activeSlugs, projects, existing);

    const root = dirname(normalizeCheckoutPath(canonicalPath));
    const checkouts = await listSiblingCheckoutsWithDirtyState(root, deps);

    let linkedWorktreePaths: string[] = [];
    try {
      const runGit = deps.runGit ?? defaultRunGit;
      linkedWorktreePaths = parseWorktreeListPorcelain(
        await runGit(['worktree', 'list', '--porcelain'], canonicalPath),
      );
    } catch {
      // Packaged install / not a repo — the linked set is simply empty.
    }

    const uncovered = findUncoveredDirtyCheckouts(checkouts, {
      canonicalPath,
      coveredPaths,
      linkedWorktreePaths,
    });

    if (uncovered.length > 0) {
      const detail = uncovered
        .map((c) => {
          const age =
            c.lastCommitEpochSec === null
              ? 'no commits'
              : `last commit ${Math.floor((Date.now() / 1000 - c.lastCommitEpochSec) / 3600)}h ago`;
          return `${c.path} (${c.dirtyFileCount} dirty, ${age})`;
        })
        .join('; ');
      log(
        `[worktree-coverage-watchdog] ${uncovered.length} sibling checkout(s) carry uncommitted ` +
          `work with NO active git-sync routine covering them — work there is stranded ` +
          `(WI-38857 / EI-20443492691207801 class): ${detail}`,
      );

      // A RE-ARMED triage is different news from a never-triaged checkout: someone already
      // established this tree held nothing at risk, and that verdict has just been
      // invalidated by new content. Say so explicitly — reporting it as a generic finding
      // would waste the one signal the scope-out mechanism exists to produce.
      const reArmed = uncovered
        .map((c) => ({ c, scoped: matchTriagedScopeOut(c.path, c.dirtyFileCount) }))
        .filter((r) => r.scoped?.drifted);
      if (reArmed.length > 0) {
        log(
          `[worktree-coverage-watchdog] ${reArmed.length} of those had been TRIAGED as holding ` +
            `no work at risk and have since CHANGED — the recorded verdict no longer covers ` +
            `their contents; re-triage: ` +
            reArmed
              .map(
                ({ c, scoped }) =>
                  `${c.path} (${scoped!.entry.dirtyFileCountAtTriage} dirty at triage ` +
                  `${scoped!.entry.triagedAt} per ${scoped!.entry.workItem}, now ${c.dirtyFileCount})`,
              )
              .join('; '),
        );
      }
    }
    if (staleCoverage.length > 0) {
      log(
        `[worktree-coverage-watchdog] ${staleCoverage.length} active git-sync routine(s) resolve ` +
          `to a path that no longer exists — coverage that sweeps nothing: ` +
          staleCoverage.map((s) => `${s.installSlug} -> ${s.path}`).join('; '),
      );
    }
    return { uncovered, staleCoverage, coverageResolved: true };
  } catch (e) {
    if (!isNotARepoError(e)) {
      log(
        `[worktree-coverage-watchdog] git-sync coverage pass failed (non-fatal): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return empty;
  }
}
