/**
 * dev-deploy-state — the read-only release-gate snapshot behind the dev admin
 * rail's Deploy panel (plan dev-admin-sidebar-2026-06-05, P-006 / D-004).
 *
 * The #10 "my edit reverted" antidote: surfaces that the live operator's green
 * `:3070` runs from a SEPARATE release checkout (`papercup-release`) pinned to a
 * green ref, N commits / X hours behind `main`. A missing edit then reads as
 * *not-yet-deployed*, not *reverted*.
 *
 * Self-contained on purpose: it replicates the small slice of the release lib's
 * config + git primitives it needs (paths/refs + `git` shell-outs) rather than
 * importing `apps/operator/lib/release/*`. operator-core must not depend back on
 * apps/operator (wrong dependency direction), and the release lib also carries a
 * deploy/rollback surface this read panel must never reach. The refs/paths mirror
 * `release-config.ts` exactly (same env seams) so the two never drift.
 *
 * READ-ONLY (D-004): this computes + returns state. It never advances `ready`,
 * never deploys, never restarts — the deploy chokepoint stays the release-gate
 * agent's job.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from './fleet/git-via-sidecar';
import { type CellUnknown, cellUnknown, formatCellUnknown } from './cell-contract';

const pexec = promisify(execFile);

/**
 * Run git for the snapshot, THROWING on failure (every caller wraps this in
 * try/catch → null, so the throw is the contract).
 *
 * Routes through the SPAWNER SIDECAR when one is enabled, falling back to a
 * local fork on any sidecar problem — so a sidecar fault degrades performance,
 * never correctness.
 *
 * ## Why (EI-18808838427010743 — measured on the live bg-host)
 *
 * `fork()` copies the calling process's page tables, so the parent-side cost of
 * spawning ANY child scales with the PARENT's RSS, charged as synchronous
 * system time on the main thread. Measured here: ~40 ms of blocked event loop
 * per GB of parent RSS. The bg-host runs at ~4 GB, so each git call forked from
 * it cost ~165 ms of dead loop — for commands git finishes in ~4 ms. This
 * snapshot sits behind a UI-POLLED sync query and fans out to ~6 git execs
 * (`commitRef` ×N + 3× `aheadCount`), so it was a top application-attributable
 * event-loop cost; /proc sampling still caught it forking from bg-host after
 * the pot-git seam was rerouted.
 *
 * argv is kept EXACTLY as it was (`-C <repo>` doing the repo selection, cwd
 * left at the process cwd) so the sidecar path cannot change how a missing or
 * repo-less path reports.
 */
/** A REAL non-zero git exit (not a sidecar fault) — must not trigger a local retry. */
class GitExitError extends Error {}

/** Options for the read-only release-gate snapshot. */
export interface DevDeployStateOptions {
  /**
   * Permit the git runner to lazily boot the spawner sidecar. The default keeps
   * the existing hot-path behavior; pure diagnostic compositions can opt out
   * so a standalone read never creates an agent-spawn transport.
   */
  useSpawnerSidecar?: boolean;
}

async function git(repo: string, args: string[], useSpawnerSidecar: boolean): Promise<string> {
  const argv = ['-C', repo, ...args];
  if (useSpawnerSidecar && gitSidecarEnabled('PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR')) {
    try {
      const r = await runGitViaSpawnerSidecar(argv, process.cwd(), 60_000, process.env);
      // Preserve the throwing contract: pexec rejects on a non-zero exit.
      if (r.code !== 0) {
        throw new GitExitError(`git ${argv.join(' ')} exited ${r.code}: ${r.stderr.trim()}`);
      }
      return r.stdout.trim();
    } catch (e) {
      // A non-zero git exit is a REAL result, not a sidecar fault — rethrow it
      // rather than re-running the same failing command locally. Sniffing the
      // message would be fragile; the sentinel type cannot collide.
      if (e instanceof GitExitError) throw e;
      noteSidecarFallback('dev-deploy', e);
    }
  }
  const { stdout } = await pexec('git', argv, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/** A commit identity: sha + commit epoch-ms + subject line. */
export interface CommitRef {
  sha: string;
  shortSha: string;
  committedAtMs: number;
  subject: string;
}

/**
 * ⚠ NAMING (EI-11012 — read before you add a field here).
 *
 * The staging→main migration (staging-branch-pipeline-2026-06-06) made the GREEN PIN the
 * `main` BRANCH and the churning integration branch `staging` — see release-config.ts:126-129
 * ("the green pin is the `main` BRANCH (FF-advanced from green `staging`), not a separate
 * `ready` ref"). This module's fields were NOT renamed with it, so for ~5 weeks every field
 * here SAID "main"/"ready" and MEANT something else:
 *
 *     OLD (lying)          ACTUALLY MEASURED                       NOW
 *     mainHead             staging HEAD                            stagingHead
 *     ready                main HEAD (the green pin)               greenPin
 *     deployedBehindMain   deployed vs STAGING                     deployedBehindStaging
 *     readyBehindMain      main vs STAGING  ← the staging buffer   greenPinBehindStaging
 *     deployedBehindReady  deployed vs MAIN ← the real deploy gap  deployedBehindGreenPin
 *
 * That naming had a live cost: why-chain's deploy stage degraded on `readyBehindMain > 0`,
 * believing it meant "the tip hasn't been promoted". It actually means "staging is ahead of
 * main" — the NORMAL steady state of this fleet (git-sync commits staging continuously; the
 * green-checkpoint FFs main only hourly, only when green). So the deploy stage reported
 * `degraded` essentially ALWAYS, and because the why-chain stops at the first degraded stage,
 * it SHADOWED every real downstream cause. Keep these names honest.
 */
export interface DevDeployState {
  /** The churning integration tree git-sync commits to (resolves `staging` + `main`). */
  integrationRoot: string;
  /** The separate checkout the live `:3070` operator actually runs from. */
  releaseRoot: string;
  /** The green-pin ref name — the `main` BRANCH (`releaseRef`). */
  releaseRef: string;
  /** The integration branch name — `staging`, the agent firehose. */
  integrationBranch: string;

  /** `staging` HEAD — the churning integration branch (NOT main). */
  stagingHead: CommitRef | null;
  /**
   * EI-19341938682536275 — the LOCAL remote-tracking ref `origin/<integrationBranch>`, i.e.
   * what git-sync last SUCCEEDED in pushing. A plain `git push` updates this ref as a side
   * effect of a successful push (no network call needed here to read it), so it stays current
   * for free on every tick that actually reaches origin — and stays FROZEN the instant pushing
   * stops working, which is exactly the signal `stagingAheadOfOrigin` below needs. null when the
   * repo has no `origin` remote (e.g. a packaged/repo-less install, or a fresh test checkout) or
   * the ref hasn't been fetched/pushed yet — treated as "unmeasured", never as caught-up.
   */
  originHead: CommitRef | null;
  /**
   * THE SAFETY-CRITICAL LEG (EI-19341938682536275, split out of WI-6996's origin-freeze
   * incident): commits `staging` has that `origin/<integrationBranch>` doesn't — i.e. NOT YET
   * BACKED UP OFF THIS BOX. Unlike `greenPinBehindStaging` below (which is essentially ALWAYS
   * > 0 by design, since the gate runs hourly while commits happen continuously — EI-11012),
   * git-sync commits AND pushes in the same tick, so in healthy operation this sits at 0 between
   * ticks and only climbs when pushing itself is stuck. A nonzero value here is NEVER "normal
   * buffer" the way `greenPinBehindStaging` is, however small — during the 2026-08-02 outage this
   * fleet's own `dev:why` reported "99 commits … normal" while ~82 of them had reached nowhere
   * off-box for 6h. null when `originHead` is null (unmeasured, never treated as caught-up).
   */
  stagingAheadOfOrigin: number | null;
  /** The green pin = `main` HEAD — the last commit the full-suite gate passed, i.e. what a
   *  deploy WOULD ship. null if unset. */
  greenPin: CommitRef | null;
  /** What the release checkout (the live `:3070`) is ACTUALLY running. */
  deployed: CommitRef | null;
  /** Best-effort wall-clock of the last deploy (release worktree HEAD mtime). */
  deployedAtMs: number | null;

  /** Commits `staging` has that the DEPLOYED ref doesn't (staging→live distance; spans the
   *  un-green-checkpointed buffer, so it is NOT by itself a deploy fault). */
  deployedBehindStaging: number | null;
  /** THE STAGING BUFFER: commits `staging` has that the green pin (`main`) doesn't — i.e. work
   *  committed but not yet green-checkpointed. NORMAL and almost always > 0 on this fleet.
   *  ⚠ NOT a deploy fault. Do NOT degrade the deploy stage on it (EI-11012). A buffer that stays
   *  large for a long time is a GATE/promotion concern (is the gate still advancing main?), and
   *  belongs to a time-thresholded gate signal — not to a `> 0` boolean here. */
  greenPinBehindStaging: number | null;
  /** THE REAL DEPLOY GAP: commits the green pin (`main`) has that the deployed ref doesn't —
   *  green, shippable, and NOT YET LIVE on :3070. This is the one field a deploy-stage health
   *  check should fire on. */
  deployedBehindGreenPin: number | null;
  /** True iff the green pin (`main`) is exactly at `staging` HEAD — the whole buffer is green. */
  greenPinAtStagingHead: boolean | null;

  /** Non-fatal problems gathering the snapshot (a ref didn't resolve, etc.). */
  errors: string[];
}

/** Resolve the release paths/refs the same way release-config.ts does (env seams). */
/**
 * Memoized `git rev-parse --show-toplevel`. Resolved AT MOST ONCE per process:
 * the repo root cannot change under a running operator, and this probe sits
 * behind a UI-POLLED sync query (dev-glances), so re-forking git on every poll
 * bought nothing. In a PACKAGED install there is no repo at all, so each poll
 * forked a doomed git AND let its `fatal: not a git repository` reach the
 * operator's stderr — 3,247 of them in one 0.0.8 mac install's serve.log,
 * burying real errors (WI-4368). `stderr: 'ignore'` keeps a repo-less install
 * silent; the memo keeps it from re-asking.
 */
let cachedToplevel: string | null = null;
function gitToplevel(): string {
  if (cachedToplevel != null) return cachedToplevel;
  try {
    cachedToplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    cachedToplevel = process.cwd();
  }
  return cachedToplevel;
}

function resolveConfig(): Pick<
  DevDeployState,
  'integrationRoot' | 'releaseRoot' | 'releaseRef' | 'integrationBranch'
> {
  // PAPERCUSP_INTEGRATION_ROOT is exported into the :3070 operator's unit env
  // (the release-gate cutover). Off that env, derive from cwd's git toplevel.
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT || gitToplevel();
  const parent = path.dirname(integrationRoot);
  const releaseRoot = process.env.PAPERCUSP_RELEASE_ROOT ?? path.join(parent, 'papercup-release');
  // staging→main model (staging-branch-pipeline-2026-06-06): the integration
  // branch (agent firehose) is `staging`; the green pin is the `main` BRANCH.
  // Field names below predate the rename and read generically: `stagingHead` = the
  // integration branch (staging) HEAD; `ready` = the green pin (main); the
  // behind-counts are measured against those. Mirrors release-config.ts.
  return {
    integrationRoot,
    releaseRoot,
    releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? 'main',
    integrationBranch: process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging',
  };
}

// EI-18788901632987174: git exits 128 for BOTH "the ref doesn't exist" and most
// other invocation failures, so exit code alone can't separate them — only the
// stderr text can. This is git's OWN wording for "the revision genuinely does
// not resolve" (verified live against git log -1 <bad-ref>^{commit}); anything
// else that reaches the catch below (a missing repo dir, "not a git
// repository", a lock, an exec/ENOENT failure, a sidecar fault) is a REAL
// invocation failure, not an absent ref, and must NOT match this.
const REF_ABSENT_STDERR = /unknown revision or path not in the working tree|not a valid object name|bad revision/i;

/**
 * Classify a failed `commitRef` attempt's error message into the two
 * cell-contract codes that matter here — split out as a pure function (no git,
 * no fs) so the classification itself is directly unit-testable without
 * spawning a real git process per branch. See {@link commitRef}.
 */
export function classifyCommitRefFailure(ref: string, repo: string, message: string): CellUnknown {
  return REF_ABSENT_STDERR.test(message)
    ? cellUnknown('not-applicable', `ref ${ref} does not exist in ${repo}`)
    : cellUnknown('resolver-failed', `git failed resolving ${ref} in ${repo}: ${message}`);
}

/**
 * Resolve a ref's sha + commit date + subject in `repo`. Distinguishes the two
 * ways this can fail (cell-contract.ts's in-band-unknown discipline) instead of
 * collapsing both into the same bare `null`:
 *   - the ref genuinely does not exist (`not-applicable` — final, no lever:
 *     retrying resolves nothing, e.g. a fresh clone, `main` never promoted);
 *   - the git invocation itself failed (`resolver-failed` — retry-or-escalate:
 *     the value may well exist; a broken repo, an fs/lock error, an exec
 *     failure, a sidecar fault that also failed locally).
 * `ref` is `null` in both cases — every existing caller that treats the return
 * value as `CommitRef | null` (a truthy/falsy check) is UNCHANGED; `unknown`
 * is the new, additive, in-band reason a caller MAY branch on.
 */
interface CommitRefResult {
  ref: CommitRef | null;
  /** Non-null iff `ref` is null — WHY it's null, per cell-contract.ts. */
  unknown: CellUnknown | null;
}

async function commitRef(repo: string, ref: string, useSpawnerSidecar: boolean): Promise<CommitRefResult> {
  try {
    // ONE `git log -1` fork/exec resolves+peels the ref AND formats sha + committer
    // epoch + subject, replacing the former 3-exec fan-out (rev-parse --verify ^{commit}
    // + show -s %ct + show -s %s). `log -1 <ref>^{commit}` peels a branch/tag to its
    // commit and exits non-zero (→ caught → unknown) on an unresolvable ref — the exact
    // same contract as the old rev-parse --verify. %s is git's single-LINE subject, so
    // the two %n separators split cleanly (sha \n ct \n subject); an empty subject
    // yields a trailing empty field, handled by `rest.join`. Cutting commitRef 3→1 exec
    // drops the whole snapshot fan-out from ~12 to ~6 git fork/execs — the #1
    // application-attributable event-loop cost under the poll storm (P-009 cpuprofile
    // attribution, mcp-reliability-hardening-2026-07-11: git spawn from THIS file was
    // ≈59% of real on-loop work during the Jul-10 4–6s-lag saturation).
    const out = await git(repo, ['log', '-1', '--format=%H%n%ct%n%s', ref + '^{commit}'], useSpawnerSidecar);
    const [sha, ct, ...rest] = out.split('\n');
    return {
      ref: {
        sha,
        shortSha: sha.slice(0, 8),
        committedAtMs: Number(ct) * 1000,
        subject: rest.join('\n'),
      },
      unknown: null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ref: null, unknown: classifyCommitRefFailure(ref, repo, message) };
  }
}

/** Count of commits in `from..to` within `repo`, or null on failure. */
async function aheadCount(repo: string, from: string, to: string, useSpawnerSidecar: boolean): Promise<number | null> {
  try {
    const out = await git(repo, ['rev-list', '--count', from + '..' + to], useSpawnerSidecar);
    return Number(out);
  } catch {
    return null;
  }
}

/**
 * Best-effort last-deploy wall-clock: mtime of the release checkout's real HEAD
 * ref file.
 *
 * The release checkout is a LINKED WORKTREE (`git worktree add`), so
 * `<releaseRoot>/.git` is not a directory — it's a static `gitdir: <path>`
 * pointer FILE written once at worktree-creation time and never rewritten
 * afterwards. A `git checkout` / `git reset --hard` inside the worktree
 * updates the ref file at `<pointer-target>/HEAD` (under the MAIN repo's
 * `.git/worktrees/<name>/`), not the pointer file itself. Statting the
 * pointer file (as this used to) therefore returns the worktree's CREATION
 * time forever, silently making every past + future deploy look like it
 * happened on day one — the exact symptom behind WI-1623 ("deployedAt
 * ~month-stale" when deploys were in fact landing).
 *
 * So: resolve the real per-worktree admin dir by parsing the pointer file
 * (same `gitdir:\s*(.+)` shape `classify-tree.ts` already parses for worktree
 * detection) and stat ITS `HEAD`, which git does touch on every checkout.
 * Falls back to the plain non-worktree case (`.git` is a real directory) and,
 * failing everything, to the old best-effort stats so this never regresses to
 * throwing or silently returning null on a shape we haven't seen.
 */
function lastDeployMtime(releaseRoot: string): number | null {
  const gitPath = path.join(releaseRoot, '.git');
  try {
    const st = fs.statSync(gitPath);
    if (st.isDirectory()) {
      // Not a worktree (a plain/standalone checkout) — HEAD lives right here.
      return Math.round(fs.statSync(path.join(gitPath, 'HEAD')).mtimeMs);
    }
    if (st.isFile()) {
      const raw = fs.readFileSync(gitPath, 'utf-8');
      const match = raw.match(/^gitdir:\s*(.+?)\s*$/m);
      const target = match?.[1];
      if (target) {
        // Resolve relative-to-worktree-root pointer targets too (git usually
        // writes an absolute path, but tolerate a relative one defensively).
        const realGitDir = path.isAbsolute(target) ? target : path.join(releaseRoot, target);
        return Math.round(fs.statSync(path.join(realGitDir, 'HEAD')).mtimeMs);
      }
    }
  } catch {
    /* fall through to the best-effort candidates below */
  }
  // Last resort: the pre-fix behavior. Wrong for a worktree, but better than
  // null when the shape above didn't match (e.g. .git missing entirely).
  const candidates = [path.join(releaseRoot, '.git', 'HEAD'), path.join(releaseRoot, '.git')];
  for (const c of candidates) {
    try {
      return Math.round(fs.statSync(c).mtimeMs);
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Compute the current release-gate snapshot. Pure read — shells `git` against the
 * integration + release checkouts; mutates nothing. Resolves a partial snapshot
 * with `errors[]` populated rather than throwing, so the panel always renders.
 *
 * NOT exported — every caller goes through the cached `devDeployState()` wrapper
 * below. One call here fans out ~8 `git` subprocess fork/execs (4×commitRef, each
 * a single `git log -1`, + 4×aheadCount `rev-list` — EI-19341938682536275 added the
 * `origin/<branch>` resolve + its ahead-count, both LOCAL, no network). git spawning on the request-
 * worker loop has been pinned by cpuprofile attribution as the single largest
 * application-attributable event-loop cost TWICE — round-4 P-015
 * (infra-perf-reliability-audit-round4, ~26% of real on-CPU work) and again
 * P-009 (mcp-reliability-hardening-2026-07-11, ≈59% of on-loop work in the Jul-10
 * 4–6s-lag storm) — amplified by the poll storm hitting system-health +
 * sync-resolver `dev.deployState`. Two levers keep it off the hot path: this
 * fan-out was halved 12→6 execs (commitRef 3→1, P-009) and the cache below
 * collapses concurrent/rapid callers to one fan-out per TTL.
 */
async function computeDevDeployState(opts: DevDeployStateOptions = {}): Promise<DevDeployState> {
  const useSpawnerSidecar = opts.useSpawnerSidecar ?? true;
  const cfg = resolveConfig();
  const errors: string[] = [];

  // cfg.integrationBranch === 'staging' (the churning firehose); cfg.releaseRef === 'main'
  // (the green pin). The bindings are named for what they HOLD — see the naming note above.
  // EI-19341938682536275: `origin/<integrationBranch>` is resolved LOCALLY (the remote-tracking
  // ref a successful `git push` already updates as a side effect) — no network call, same cost
  // class as the other 3 resolves below.
  const [stagingHeadR, greenPinR, deployedR, originHeadR] = await Promise.all([
    commitRef(cfg.integrationRoot, cfg.integrationBranch, useSpawnerSidecar),
    commitRef(cfg.integrationRoot, cfg.releaseRef, useSpawnerSidecar),
    commitRef(cfg.releaseRoot, 'HEAD', useSpawnerSidecar),
    commitRef(cfg.integrationRoot, `origin/${cfg.integrationBranch}`, useSpawnerSidecar),
  ]);
  // Every downstream reader keeps the plain `CommitRef | null` shape it always
  // had — only `errors[]` (below) additionally consumes the `unknown` reason.
  const stagingHead = stagingHeadR.ref;
  const greenPin = greenPinR.ref;
  const deployed = deployedR.ref;
  const originHead = originHeadR.ref;

  // EI-18788901632987174: report WHY, not just THAT — `unknown` distinguishes
  // "this ref does not exist" (final) from "the git call itself failed"
  // (retry-or-escalate); formatCellUnknown falls back to generic code prose
  // if a call site ever constructs one with no detail.
  if (stagingHeadR.unknown) errors.push(formatCellUnknown(stagingHeadR.unknown));
  if (greenPinR.unknown) errors.push(formatCellUnknown(greenPinR.unknown));
  if (deployedR.unknown) errors.push(formatCellUnknown(deployedR.unknown));
  // EI-19341938682536275: an absent `origin/<branch>` ref is a NORMAL state (no `origin`
  // remote configured at all — a packaged install, a fresh local-only checkout) and must
  // NOT degrade the snapshot the way the required refs above do. Only a genuine git-
  // invocation failure (`resolver-failed`) is worth surfacing here; "the ref doesn't exist"
  // (`not-applicable`) just means `originHead`/`stagingAheadOfOrigin` stay null.
  if (originHeadR.unknown && originHeadR.unknown.code === 'resolver-failed') {
    errors.push(formatCellUnknown(originHeadR.unknown));
  }

  // All counts are measured in the integration tree (it has every object — the
  // release worktree shares its object store). deployed must be reachable there.
  // aheadCount(from, to) = `rev-list --count from..to` = commits `to` has that `from` lacks.
  const [deployedBehindStaging, greenPinBehindStaging, deployedBehindGreenPin, stagingAheadOfOrigin] = await Promise.all([
    // live :3070 → staging tip (spans the un-checkpointed buffer; not a fault on its own)
    deployed && stagingHead ? aheadCount(cfg.integrationRoot, deployed.sha, stagingHead.sha, useSpawnerSidecar) : Promise.resolve(null),
    // green pin (main) → staging tip = THE STAGING BUFFER (normal; not a deploy fault)
    greenPin && stagingHead ? aheadCount(cfg.integrationRoot, greenPin.sha, stagingHead.sha, useSpawnerSidecar) : Promise.resolve(null),
    // live :3070 → green pin (main) = THE REAL DEPLOY GAP (green but not shipped)
    deployed && greenPin ? aheadCount(cfg.integrationRoot, deployed.sha, greenPin.sha, useSpawnerSidecar) : Promise.resolve(null),
    // origin/<branch> → staging tip = THE SAFETY-CRITICAL UNPUSHED LEG (never "normal")
    originHead && stagingHead ? aheadCount(cfg.integrationRoot, originHead.sha, stagingHead.sha, useSpawnerSidecar) : Promise.resolve(null),
  ]);

  return {
    ...cfg,
    stagingHead,
    originHead,
    stagingAheadOfOrigin,
    greenPin,
    deployed,
    deployedAtMs: lastDeployMtime(cfg.releaseRoot),
    deployedBehindStaging,
    greenPinBehindStaging,
    deployedBehindGreenPin,
    greenPinAtStagingHead: greenPinBehindStaging == null ? null : greenPinBehindStaging === 0,
    errors,
  };
}

// ─── Short-TTL single-flight cache ────────────────────────────────────────────
// The release-gate snapshot is a display read whose underlying git refs only move
// on a commit / deploy (seconds-to-minutes granularity), yet `devDeployState()`
// is called from poll-storm-amplified hot paths — system-health/compute,
// sync-resolver `dev.deployState`, and the pipeline-stats/position tools — each
// firing ~10 `git` fork/execs on the request-worker event loop with no reuse.
// Under the ~70-agent reconnect/poll storm that pegged a single core, this was
// the #1 application-attributable on-loop cost (P-015 cpuprofile attribution).
//
// The cache does two things: (1) memoises the resolved snapshot for a short TTL
// so rapid repeat reads skip git entirely, and (2) shares the in-flight promise
// (single-flight) so a BURST of concurrent callers collapses to ONE git fan-out
// instead of N. TTL is read per-call so it's runtime-tunable and test-overridable
// (set PAPERCUSP_DEPLOY_STATE_TTL_MS=0 to disable, e.g. when a test mutates refs
// then re-reads). Default 10s (raised from 3s in P-009): the underlying refs only
// move on the git-sync commit (minutes) / deploy (≤15min, ~46s of :3070 downtime)
// cadence, so a read-only display panel is fully live at 10s resolution while the
// steady per-TTL git drip that survives single-flight during an 8-minute poll storm
// drops ~3× (480/3s→480/10s fan-outs). Combined with the 12→6 exec halving above,
// git fork/exec load on the loop falls ~6–7× under the storm.

interface DeployStateCacheEntry {
  at: number;
  value: Promise<DevDeployState>;
  useSpawnerSidecar: boolean;
}
let deployStateCache: DeployStateCacheEntry | null = null;

function deployStateTtlMs(): number {
  const raw = process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS;
  if (raw == null || raw === '') return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

/**
 * Cached, single-flight release-gate snapshot. Identical signature + return
 * contract to the underlying compute (READ-ONLY; resolves a partial snapshot with
 * `errors[]` rather than throwing). Concurrent + rapid callers within the TTL
 * window share one `git` fan-out; see the cache note above.
 */
export async function devDeployState(opts: DevDeployStateOptions = {}): Promise<DevDeployState> {
  const useSpawnerSidecar = opts.useSpawnerSidecar ?? true;
  const ttl = deployStateTtlMs();
  const now = Date.now();
  if (
    ttl > 0 &&
    deployStateCache &&
    deployStateCache.useSpawnerSidecar === useSpawnerSidecar &&
    now - deployStateCache.at < ttl
  ) {
    return deployStateCache.value;
  }
  const value = computeDevDeployState({ useSpawnerSidecar });
  if (ttl > 0) {
    const entry: DeployStateCacheEntry = { at: now, value, useSpawnerSidecar };
    deployStateCache = entry;
    // computeDevDeployState resolves-with-errors rather than throwing, but if it
    // ever rejects, drop the entry so the next call retries instead of caching it.
    value.catch(() => {
      if (deployStateCache === entry) deployStateCache = null;
    });
  }
  return value;
}

/** Clear the snapshot cache — for tests that mutate refs/env then re-read. */
export function resetDevDeployStateCache(): void {
  deployStateCache = null;
}
