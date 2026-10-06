/**
 * git-pipeline-position — "where is my change, and is it live?" in ONE read
 * (git-sync-dx-hardening-2026-06-17 P-002 / EI-1164).
 *
 * Given a repo-relative PATH or a commit SHA, resolve its position along the
 * release pipeline plus its publication side leg:
 *   delivery: committed locally → green-checkpoint → `main` → live `:3070`
 *   publish:  committed locally → `origin/staging` (durability / peer visibility)
 *
 * `origin/staging` is a real health signal and a real data-loss boundary. For a
 * commit-only/bridged member it is NOT an input to the local staging→main→:3070
 * delivery path; keeping it visible while excluding it from `blockedOn` is the
 * distinction this surface exists to make.
 *
 * The three audits all hit the same DX tax: answering this took 4+ forensic git
 * + PG + curl commands. This joins it. Reuses `devDeployState` (the integration
 * tree root + the deployed sha) and `gitPipelineSnapshot` (the green-checkpoint
 * gate / stall context).
 *
 * READ-ONLY: no `git fetch`, no mutation — it reads the already-fetched origin
 * refs (git-sync fetches every tick) so it can never perturb the pipeline.
 *
 * A submodule path resolves inside that submodule for its nested commit history,
 * while its staging position is measured through the superproject's gitlink —
 * the exact pathspec confusion the audits flagged; the result is annotated so
 * the reader isn't misled.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { hostname } from 'node:os';
import { devDeployState, type DevDeployState } from './dev-deploy-state';
import {
  gitPipelineSnapshot,
  projectGreenCheckpointPause,
  type GateFailingTestsProvenance,
  type GitPipelineSnapshot,
} from './git-pipeline-stats';
import type { GitSyncSkippedPath } from './harness/git-sync/run-git-sync';
// EI-19447523039740352. Safe direction: release-deploy-launch imports git-pipeline-STATS,
// never git-pipeline-POSITION, so this does not close an import cycle.
import { readDeployInFlight, type DeployInFlight } from './release-deploy-launch';
import { probeServiceStart, resolveServiceStartMs } from './agent-tools/dev/systemd-service-probe';
import { RESTART_TARGET_UNITS } from './agent-tools/dev/restart-target-units';
import {
  classifyPathsAgainstCandidate,
  markerAtCandidateForPath,
  gitReadForRepo,
  markerAtCommit,
  type MarkerContainment,
  type MissingReason,
  type PathContainment,
} from './candidate-contains';
import { cellUnknown, formatCellUnknown, type CellUnknown } from './cell-contract';
import { gitRefContains } from './git-ref-contains';
import { describeRefusal, refuseAnswer, type RefusedAnswer } from './field-reliability';
import {
  describeRefireBudget,
  projectRetriageCell,
  type RetriageCellProjection,
} from './release/in-flight-retriage';
import {
  GATE_ABORT_DETAIL_LIVENESS_MARKER,
  gateAbortDetailAtRead,
  gateAbortLever,
  gateAbortRefireClause,
  gateAbortVintage,
} from './release/gate-abort-status';
import { formatIdleAge } from './format/relative-time';
import {
  reconcileGateVerdictFreshnessWithCheckpointRun,
  reconcileGateVerdictFreshnessWithPinnedRepair,
  reconcileGateVerdictFreshnessWithRepairQueue,
  type GateVerdictFreshness,
} from './release/gate-verdict-freshness';
import { dispatchedSweepMatcher } from './routines-dispatch-derivation';
import { readGateOwnership, type CellOwnership } from './coord/gate-ownership';
import { readGateCandidateFailures, type GateCandidateFailures } from './gate-candidate-failures';
import { composeGateOwnerBrief, type GateOwnerBrief } from './gate-owner-brief';
import { listRuntimeVintage, type RuntimeVintageRow } from './runtime-vintage';
import { projectCheckpointQualificationState } from './release/checkpoint-qualification-transaction';
// P-004: the two pure projections behind `gate.greenCheckpoint.freezeDisposition` and
// `gate.greenCheckpoint.convergence`. Both are rung-1 DERIVE over records this resolver
// already loads — no second I/O path that could disagree with the first.
import {
  projectFreezeDispositionCell,
  type FreezeDispositionCellProjection,
} from './release/freeze-disposition';
import {
  isJudgingPinnedActiveRepair,
  projectFrozenRepairConvergenceCell,
  type FrozenRepairConvergenceCellProjection,
} from './release/frozen-candidate-repair-queue';
import { isAuthoritativeJudgingShaSource, type JudgingShaSource } from './judging-sha-source';
import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from './fleet/git-via-sidecar';
import {
  realListPtyHostInstances,
  resolveServingRuntimes,
  selectServingRuntimes,
  servingRuntimesLead,
  type ServingRuntimeBundleState,
  type ServingRuntimeEntry,
} from './serving-runtimes';

import { createCache } from '@papercusp/cache';
import { pinModuleState } from '@papercusp/module-singleton';

const pexec = promisify(execFile);

/**
 * Bound each subprocess on this hot read independently. A wedged git or systemd
 * probe must degrade its leg to UNKNOWN through the existing fail-soft paths rather
 * than hold `dev:pipeline_position` past the MCP transport deadline.
 */
export const GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS = 5_000;

/** Injectable git runner (returns trimmed stdout, or null on any failure). */
export type GitRunner = (repo: string, args: string[]) => Promise<string | null>;

export function gitPipelinePositionSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', env);
}

export const realGit: GitRunner = async (repo, args) => {
  const argv = ['-C', repo, ...args];
  const env = args[0] === 'status'
    ? { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    : process.env;
  // EI-22737582656157929: a decisive bg-host CPU profile attributed 23.9% of real sampled CPU
  // to this runner's native spawn calls. Reuse the existing small-process git sidecar rather
  // than forking from the multi-GB bg host. A real non-zero git result remains a fail-soft null;
  // only a sidecar transport failure falls through to the identical local command, and that
  // fallback is counted/circuit-broken by the shared seam.
  if (gitPipelinePositionSidecarEnabled()) {
    try {
      const result = await runGitViaSpawnerSidecar(
        argv,
        process.cwd(),
        GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
        env,
      );
      return result.code === 0 ? result.stdout.trim() : null;
    } catch (error) {
      noteSidecarFallback('git-pipeline-position', error);
    }
  }
  try {
    const { stdout } = await pexec('git', argv, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
      ...(args[0] === 'status' ? { env } : {}),
    });
    return stdout.trim();
  } catch {
    return null;
  }
};

/**
 * EI-24040329952723202 — TOTAL wall-clock budget for the git reads of ONE `gitPipelinePosition`
 * call. The per-subprocess cap above bounds each read, but one call issues ~40 of them in
 * sequential waves, so 5s x N has no upper bound: the invocation ledger showed a p95 of 17.8s
 * and a 67.5s outlier against the 60s MCP abort. Past this budget further reads are NOT
 * spawned; they resolve null, exactly as a wedged git already does, so each leg degrades to
 * UNKNOWN through the existing fail-soft paths. Keep it well under the MCP deadline INCLUDING
 * one in-flight subprocess ({@link GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS}) and the non-git legs.
 */
export const GIT_PIPELINE_POSITION_TOTAL_BUDGET_MS = 35_000;

export interface GitReadBudgetOptions {
  budgetMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Fired ONCE, on the first read refused for budget. */
  onExhausted?: () => void;
}

export interface GitReadBudgetStats {
  requested: number;
  spawned: number;
  /** Reads answered from an identical in-flight/settled read of THIS call. */
  deduped: number;
  /** Reads refused because the total budget was spent. */
  refused: number;
}

/**
 * Per-call wrapper over a {@link GitRunner}: (1) identical reads (same repo + argv) share ONE
 * subprocess — a measured call ran `log -1 HEAD -- <path>` 5x concurrently, each ~3.3s under
 * contention, so the duplicates were pure amplification; (2) once the total budget is spent,
 * later reads resolve null without spawning. Safe ONLY for read-only git, which is all this
 * module runs. The memo is scoped to the wrapper, so it never outlives one call and a caller
 * that wants a fresh read simply makes a fresh call.
 */
export function withGitReadBudget(
  base: GitRunner,
  opts: GitReadBudgetOptions = {},
): { git: GitRunner; stats: GitReadBudgetStats } {
  const budgetMs = opts.budgetMs ?? GIT_PIPELINE_POSITION_TOTAL_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const memo = new Map<string, Promise<string | null>>();
  const stats: GitReadBudgetStats = { requested: 0, spawned: 0, deduped: 0, refused: 0 };
  const git: GitRunner = (repo, args) => {
    stats.requested += 1;
    const key = `${repo}\u0000${args.join('\u0000')}`;
    const hit = memo.get(key);
    if (hit) {
      stats.deduped += 1;
      return hit;
    }
    if (now() - startedAt >= budgetMs) {
      if (stats.refused === 0) opts.onExhausted?.();
      stats.refused += 1;
      return Promise.resolve(null);
    }
    stats.spawned += 1;
    const pending = base(repo, args);
    memo.set(key, pending);
    return pending;
  };
  return { git, stats };
}

/** Is `sha` an ancestor-or-equal of `ref` (i.e. does ref's history contain it)? */
async function refContains(git: GitRunner, repo: string, ref: string, sha: string): Promise<boolean | null> {
  // Ancestor-or-equal via `merge-base` (git-ref-contains.ts): the earlier
  // `rev-list --count ${ref}..${sha}` read miscounted whenever `ref` headed a run of
  // repair-queue admission commits (dated 2000-01-01), so every path read
  // `inMain:false, deployed:false` on a release that contained it.
  // D-038 axis 2 — NEVER derive a verdict from an absence: a failed read stays null,
  // never `false`, or an agent waits for a stage it already passed.
  return gitRefContains((args) => git(repo, args), ref, sha);
}

/**
 * WI-38367: the age (ms) of the OLDEST commit reachable from `to` but not `from` —
 * the OLD END of the buffer between two refs.
 *
 * This is the measurement that tells an advance which MOVED the buffer apart from one
 * which CONSUMED it. A partial-green salvage (WI-38218) promotes the longest green
 * PREFIX, so the tip end of the buffer moves while its old end does not; only this
 * value distinguishes the two, and it does so without knowing the mechanism's name
 * (see `mainBufferStallReason`). Deliberately the same signal
 * `green-stall-watchdog.computeMainBehindStaging` derives for
 * `evaluateMainBehindStaging` — one property, measured the same way in both places.
 *
 * Tri-state per this module's standing rule: `null` = the git read FAILED or the range
 * is empty (unknown — never a verdict), a number = a measured age.
 */
async function oldestCommitAgeMs(
  git: GitRunner,
  repo: string,
  from: string,
  to: string,
  now: number = Date.now(),
): Promise<number | null> {
  // `--reverse` puts the OLDEST commit of the range first; `%ct` is the committer
  // timestamp in epoch seconds. (`--max-count=1 --reverse` would NOT work: git limits
  // first and reverses after, so it returns the NEWEST commit.)
  const out = await git(repo, ['log', '--format=%ct', '--reverse', `${from}..${to}`]);
  if (out === null || out === '') return null;
  const oldest = Number(out.split('\n')[0]);
  if (!Number.isFinite(oldest)) return null;
  return Math.max(0, now - oldest * 1000);
}

/**
 * WI-6646: the newest commit touching `relPath` that `ref` ALREADY contains.
 *
 * Used to tell the two ways a leg's `false` can arise apart. `targetSha` is "the newest
 * commit touching this path ANYWHERE", so `ref` not containing it means either (a) this
 * file has genuinely never landed in `ref`, or (b) it has, repeatedly, and a peer simply
 * committed to it more recently than the caller. Those demand opposite advice — "wait for
 * the pipeline" versus "your change may already be there, settle it with a marker" — and
 * are indistinguishable from the boolean alone.
 *
 * Tri-state on purpose, per this module's standing rule that an absence is never a
 * verdict: `null` = the git read FAILED (unknown), `{ sha: null }` = the read SUCCEEDED
 * and found no such commit (a measured absence), `{ sha }` = measured presence.
 */
async function newestTouchingInRef(
  git: GitRunner,
  repo: string,
  ref: string,
  relPath: string,
): Promise<{ sha: string | null } | null> {
  const out = await git(repo, ['log', '-1', '--pretty=%H', ref, '--', relPath]);
  if (out === null) return null;
  return { sha: out === '' ? null : out };
}

/**
 * EI-18694888339365359: the LOCAL `origin/staging` remote-tracking ref can lag
 * arbitrarily behind the true remote tip — this module deliberately never runs
 * `git fetch` (see the module doc), so it depends on git-sync's own periodic
 * fetch to keep that ref fresh, and a read between ticks sees a stale ref.
 * Confirmed live: `refContains` against the local ref said the target commit
 * was NOT on origin/staging while `git ls-remote origin refs/heads/staging`
 * showed the target WAS the exact remote tip — release:trace then emitted a
 * BLOCKING "not-on-origin-staging" constraint and told the agent to
 * `git-sync:await` a push that had already happened, parking it forever on an
 * already-satisfied condition.
 *
 * `git ls-remote` queries the remote's ref advertisement over the network
 * WITHOUT fetching any objects or touching a single local ref — it stays
 * exactly as read-only/non-perturbing as the rest of this module while giving
 * an authoritative, always-current tip. Exact-tip equality is the degenerate
 * containment case. For an older target, the tip's object must also be present
 * locally so `refContains` can inspect ancestry; if it is not, return UNKNOWN
 * rather than turning an unreadable graph into a false measurement.
 */
async function isRemoteTipContaining(
  git: GitRunner,
  repo: string,
  remoteRef: string,
  sha: string,
): Promise<boolean | null> {
  const out = await git(repo, ['ls-remote', 'origin', remoteRef]);
  if (!out) return null;
  const tip = out.split(/\s+/)[0]?.toLowerCase();
  if (!tip) return null;
  if (tip === sha.toLowerCase()) return true;
  // This is the containment rescue for a stale local remote-tracking ref. The
  // remote tip may be unavailable locally; refContains then returns null and
  // the caller preserves the local false/unknown result instead of guessing.
  return refContains(git, repo, tip, sha);
}

export interface PipelinePositionInput {
  path?: string;
  sha?: string;
  /**
   * EI-18797292094433710 — a distinctive literal string from the CALLER'S OWN change.
   * Supplying it upgrades `changeInCandidate` from "does the candidate carry this file
   * byte-for-byte" (which a peer's later commit to the same file breaks, permanently, on
   * any hot shared file) to the question actually being asked: "is MY change in the
   * commit the gate is judging?" Not derivable — git-sync commits the whole tree under
   * one identity, so no commit is identifiably "yours".
   */
  marker?: string;
}

/* ------------------------------------------------------------------------- *
 * EI-10895 — the RUNTIME-OWNER map.
 *
 * The pipeline this tool tracks (commit → origin/staging → green main → :3070)
 * is the activation path for exactly ONE process: the release operator. But the
 * box runs several other long-lived hosts, and every one of them executes
 * `npx tsx` STRAIGHT FROM THE STAGING WORKING TREE — no build, no dist/, no
 * release checkout:
 *
 *   inference gateway (:8788)  WorkingDirectory=<staging>   tsx packages/operator-core/lib/inference-gateway/bin.ts
 *   bg-host (routines/DBOS)    WorkingDirectory=<staging>   tsx bin/hono-host.ts (BACKGROUND_WORKERS=1)
 *   embed-sidecar (:3384)      WorkingDirectory=<staging>   esbuild-bundles on ExecStartPre, then runs it
 *
 * For code owned by those hosts the file ON DISK IS ALREADY WHAT RUNS on the
 * next start — so the ONLY thing between your edit and it being live is a
 * RESTART. Reporting `deployed ✗` and advising "sleep on the deploy
 * (deploy:await)" for such a path is not just unhelpful, it is WRONG: the
 * deploy will happily land and the behavior will not change, because the
 * process that runs that code never reads the release checkout. (This cost me
 * an hour on WI-4541 — a gateway admission fix, waiting on a deploy that could
 * never have activated it.)
 * ------------------------------------------------------------------------- */

/** The long-lived process that actually EXECUTES a given source path. */
export type RuntimeHost = 'operator-release' | 'gateway' | 'bg-host' | 'embed-sidecar' | 'tauri-desktop' | 'psu-pty-host';

/** A `dev:restart { target }` value. */
export type RestartTargetName = 'dev' | 'staging' | 'gateway' | 'bg-host' | 'embed-sidecar';

export interface RuntimeOwnership {
  host: RuntimeHost;
  /**
   * Does the release pipeline (git-sync → green main → :3070 deploy) actually
   * carry this code into the process that runs it? FALSE for staging-tree
   * hosts and fresh-invocation CLIs — for those, a deploy is a no-op and the
   * activation is either a restart or the next invocation, respectively.
   */
  releasePipelineApplies: boolean;
  /** The `dev:restart` target that loads the edit, when a restart is the activation.
   * Null means there is no restart lever (compiled code or a fresh-invocation CLI). */
  restartTarget: RestartTargetName | null;
  /** One line: how THIS edit becomes live. */
  activation: string;
}

interface RuntimeOwnerEntry {
  match: RegExp;
  /**
   * A path can be executed by MORE than one long-lived process (EI-16183's
   * sibling bug, WI-5440): `own` is normally a single `RuntimeOwnership`, but
   * for a file with genuinely distinct consumers on DIFFERENT activation
   * routes, list all of them — `classifyRuntimeOwners` returns the full set,
   * so a caller who collapses to one (the legacy `classifyRuntimeOwner`)
   * never silently hides the other route.
   */
  own: RuntimeOwnership | RuntimeOwnership[];
}

/* -------------------------------------------------------------------------
 * ⛔ DO NOT "just derive this from the import graph". It was measured (WI-10671)
 * and it does not work — the answer is wrong in the DANGEROUS direction.
 *
 * This map is hand-maintained and its dual-owner entries were each found one at
 * a time at real cost (WI-5440, WI-6961 x2, WI-6659). `routines-dispatch-
 * derivation.ts` then removed the hand-edit for ONE class and argues the general
 * case persuasively ("the only fix robust to a skipped suite is one that needs
 * no human action at all"). That reads as a mandate to derive the whole map.
 * It is not, and the reason is not density — it is that THE EDGES WHICH DECIDE
 * RUNTIME OWNERSHIP ARE MOSTLY NOT STATIC IMPORT EDGES:
 *
 *   - `session-port/service.ts` is reachable only via `import()` INSIDE AN HTTP
 *     ROUTE (endpoint-route/routes/adv/sessions.ts:118) — operator-served, yet
 *     a static-graph walk calls it worker-only.
 *   - `sync/hyperbee/perf/runner.ts` is never imported; it is spawned as a `tsx`
 *     CLI (testing-domains-registry.ts:821). NEITHER host owns it.
 *   - `pr-host/poll-daemon.ts` arrives by a bare SIDE-EFFECT registration
 *     (register-system-actions.ts:259) that BOTH hosts load.
 *   - the worker boundary itself is dynamic: `dbos/bootstrap.ts:289`
 *     `await import('./routines-workflow')`, gated on BACKGROUND_WORKERS=1.
 *
 * So a derived map mis-classifies operator-served code as bg-host-only — the
 * WI-6961 "opposite lie", strictly worse than today's conservative
 * DEFAULT_OWNER. `sharedHostCaveat`'s "we cannot know from the path alone which
 * host the caller cares about" is the CORRECT position, not a TODO. This map
 * being hand-maintained is the honest encoding of something that is not
 * statically decidable — extend it per incident, deliberately.
 *
 * Full measurement + the four false-positive classes:
 * /internal/docs/agent-insights/runtime-ownership-is-not-statically-decidable
 * ------------------------------------------------------------------------- */
const RUNTIME_OWNERS: RuntimeOwnerEntry[] = [
  // WI-5440: success-metrics.ts has TWO real consumers on DIFFERENT activation
  // routes — the scout ideation cycle (bg-host, routinesTick) AND
  // buildProgramSuccessReport, called by the `blender:success-metrics` MCP tool
  // which is served by the RELEASE-CHECKOUT operator (the ordinary
  // staging→green-gate→deploy path). Collapsing to bg-host-only (the broader
  // `lib/scout/` rule below) sent a live activation decision the wrong way
  // during the 0.0.11-alpha release watch. Must be listed BEFORE the broader
  // `lib/scout/` rule so this specific, dual-owner file wins.
  {
    match: /^packages\/operator-core\/lib\/scout\/success-metrics\.ts$/,
    own: [
      {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation:
          'Scout\'s ideation cycle reads this via the `scout` deterministic blueprint\'s `blender:cycle` step, dispatched by routinesTick — which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). For THAT consumer it loads on RESTART: dev:restart { target: "bg-host", confirm: true } — a deploy never carries it (EI-11120).',
      },
      {
        host: 'operator-release',
        releasePipelineApplies: true,
        restartTarget: 'staging',
        activation:
          'buildProgramSuccessReport, called by the `blender:success-metrics` MCP tool, is served by the RELEASE-CHECKOUT operator (:3070) — for THAT consumer the ordinary staging→green-gate→deploy pipeline is the activation path (or dev:restart { target: "staging", confirm: true } to exercise it now on :3170).',
      },
    ],
  },
  // WI-6961: bash-substitution/fires.ts has TWO real consumers on DIFFERENT
  // activation routes, so the WI-5440 plural form applies rather than the
  // bg-host-only default the routinesTick guard would otherwise expect.
  // Confirmed by tracing import sites, not by directory heuristic.
  {
    match: /^packages\/operator-core\/lib\/bash-substitution\/fires\.ts$/,
    own: [
      {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation:
          'resolveFireCompliance is dispatched by routinesTickImpl (dbos/routines-workflow.ts), which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). For THAT consumer it loads on RESTART: dev:restart { target: "bg-host", confirm: true } — a deploy never carries it.',
      },
      {
        host: 'operator-release',
        releasePipelineApplies: true,
        restartTarget: 'staging',
        activation:
          'recordFiresDetached is called from agent-tools/locks/check_command.ts — the PreToolUse bash-substitution gate, served by the RELEASE-CHECKOUT operator (:3070). For THAT consumer the ordinary staging→green-gate→deploy pipeline is the activation path (or dev:restart { target: "staging", confirm: true } to exercise it now on :3170).',
      },
    ],
  },
  // WI-6961: workspace-registry.ts is dispatched by routinesTick AND imported by
  // a large set of operator-served modules (sync resolvers via adv-agent-orders,
  // role-capability-grants, user-preferences, operator-notes, issues-engineer,
  // …). Classifying it bg-host-only would be wrong in the OPPOSITE direction of
  // the usual failure: it would tell an agent a deploy does NOT make their edit
  // live when, for the operator-served consumers, it does.
  {
    match: /^packages\/operator-core\/lib\/workspace-registry\.ts$/,
    own: [
      {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation:
          'Dispatched by routinesTickImpl (bg-host only). For THAT consumer it loads on RESTART: dev:restart { target: "bg-host", confirm: true } — a deploy never carries it.',
      },
      {
        host: 'operator-release',
        releasePipelineApplies: true,
        restartTarget: 'staging',
        activation:
          'activeWorkspaceId() is read by operator-served paths (sync resolvers, user-preferences, operator-notes, issues-engineer, role-capability-grants) on the RELEASE-CHECKOUT operator (:3070) — for THOSE consumers the ordinary staging→green-gate→deploy pipeline is the activation path (or dev:restart { target: "staging", confirm: true } to exercise it now on :3170).',
      },
    ],
  },
  // WI-4996: these three `*-sidecar-spawn.ts` supervisor modules live under a
  // directory that (correctly, for most of its files) maps to the sidecar they
  // supervise — but the SUPERVISOR itself runs in the SUPERVISING process, not
  // the sidecar it spawns/adopts. All three are called ONLY from
  // apps/operator/bin/host-bootstrap.ts, gated on `backgroundWorkers &&
  // !utilityHost` (i.e. exclusively bg-host boot code) — confirmed by tracing
  // every import site, not by directory heuristic. Must be listed BEFORE the
  // broader `inference-gateway/` rule below so the specific match wins.
  {
    match: /^packages\/operator-core\/lib\/inference-gateway\/gateway-sidecar-spawn\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the BG-HOST supervisor that spawns/adopts the gateway sidecar (ensureGatewaySidecar/registerGatewaySidecarShutdownHooks are called ONLY from apps/operator/bin/host-bootstrap.ts, gated on backgroundWorkers && !utilityHost) — it runs INSIDE bg-host, NOT inside the :8788 gateway process itself (WI-4996). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. Restarting "gateway" restarts the wrong — and far more disruptive, fleet-wide LLM-egress — process; it will NOT load this edit.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/fleet\/spawner-sidecar-spawn\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the BG-HOST supervisor that spawns/adopts the fleet spawner sidecar (spawnSpawnerSidecar is called from apps/operator/bin/host-bootstrap.ts — gated on backgroundWorkers && !utilityHost — plus git-sync/orchestrator-runner, both bg-host-side) — it runs INSIDE bg-host, not a separate process (WI-4996). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/sync\/hyperbee\/substrate-sidecar-spawn\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the BG-HOST supervisor that spawns/adopts the hyperbee substrate sidecar (wired via substrate-boot-wrapper, called ONLY from apps/operator/bin/host-bootstrap.ts, gated on backgroundWorkers && !utilityHost) — it runs INSIDE bg-host, not a separate process (WI-4996). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/inference-gateway\//,
    own: {
      host: 'gateway',
      releasePipelineApplies: false,
      restartTarget: 'gateway',
      activation:
        'The inference gateway (:8788) runs `npx tsx packages/operator-core/lib/inference-gateway/bin.ts` STRAIGHT FROM THIS TREE — no build, no deploy. Your edit is already on its disk; it loads on RESTART: dev:restart { target: "gateway", confirm: true }. Do NOT wait on a deploy — it cannot activate this code.',
    },
  },
  {
    match: /(^|\/)embed-sidecar/,
    own: {
      host: 'embed-sidecar',
      releasePipelineApplies: false,
      restartTarget: 'embed-sidecar',
      activation:
        'The embedding sidecar (:3384) esbuild-bundles its source from THIS TREE on every start (ExecStartPre) — no deploy involved. It loads on RESTART: dev:restart { target: "embed-sidecar", confirm: true }.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/dbos\//,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'DBOS workflows / routines EXECUTE in bg-host, which runs `npx tsx bin/hono-host.ts` from THIS TREE (PAPERCUSP_BACKGROUND_WORKERS=1) — not from the release checkout. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. The :3070 deploy does not carry it.',
    },
  },
  // EI-21863351526928940: packages/backup/** (the kopia per-workspace backup
  // system) is consumed by TWO genuinely distinct hosts — confirmed by tracing
  // every exported symbol's real importers, not by directory heuristic:
  //   - bg-host: periodic-workflows.ts's `backupCadence` / `backupOrphanCleanup`
  //     / `backupRecoveryDebrisCleanup` DBOS scheduled workflows call
  //     runBackupSchedulerTick / sweepOrphanSnapshots / sweepRecoveryDebrisTick
  //     directly, and dbos/backup-workflow.ts's own steps call workspaceBackupFor.
  //   - operator-release: the `backup:*` MCP tools (agent-tools/backup/*.ts),
  //     the `/api/backups/*` HTTP routes (endpoint-route/routes/backups/*.ts,
  //     routes/admin/backup-orphan-cleanup.ts, routes/plugins/uninstall.ts,
  //     credentials.ts, branch-actions.ts, cupboard/install-io.ts), and the
  //     boot-time migration guards (db-boot-migrate.ts / agent-tools/db/migrate.ts,
  //     which run in EVERY operator process, release and staging alike) all call
  //     into this package directly too — served by :3070/:3170.
  // The reported symptom's own file, `packages/backup/src/hook.ts`, is imported
  // only by workspace-backup.ts and orphan-cleanup.ts INSIDE this package — but
  // those feed straight into WorkspaceBackup / sweepOrphanSnapshots, which the
  // trace above shows on BOTH routes. A bg-host-ONLY classification (the shape
  // the filed bug proposed) would be the WI-6961 "opposite lie": it would tell
  // an agent editing e.g. agent-tools/backup/snapshot_create.ts's dependency
  // that a deploy can never carry it, when for that consumer it does. So this
  // is the WI-5440 plural (dual-consumer) shape, not a bg-host-only rule.
  {
    match: /^packages\/backup\//,
    own: [
      {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation:
          'The backup DBOS scheduled workflows (backupCadence / backupOrphanCleanup / backupRecoveryDebrisCleanup in periodic-workflows.ts, plus dbos/backup-workflow.ts) call directly into this package and only run when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). For THAT consumer it loads on RESTART: dev:restart { target: "bg-host", confirm: true } — a deploy never carries it (EI-21863351526928940).',
      },
      {
        host: 'operator-release',
        releasePipelineApplies: true,
        restartTarget: 'staging',
        activation:
          'This package is ALSO called directly by operator-served surfaces: the `backup:*` MCP tools (agent-tools/backup/*.ts), the `/api/backups/*` HTTP routes, and boot-time migration guards (db-boot-migrate.ts / db:migrate). For THOSE consumers the ordinary staging→green-gate→deploy pipeline is the activation path (or dev:restart { target: "staging", confirm: true } to exercise it now on :3170).',
      },
    ],
  },
  // EI-22090053297465523: fleet-transition-sweep-action.ts dynamically imports
  // this helper from a registered system action. It is therefore executed by
  // routinesTick in bg-host even though it is not itself an `*-action.ts` file
  // and is not one of the direct routines-workflow sweep targets. Keep this
  // dependency mapping narrow: the surrounding routines directory still
  // contains operator-served modules that must retain the default owner.
  {
    match: /^packages\/operator-core\/lib\/harness\/routines\/fleet-control-reconcile\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This helper is dynamically imported by the `fleet-transition-sweep` system action, which routinesTick dispatches only when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-22090053297465523).',
    },
  },
  // EI-11120: `system:<action>` routine handlers (register-system-actions.ts's
  // side-effect registry + every `*-action.ts` it wires in — git-sync, scout-cycle,
  // blueprint-run, improvement-implement, ...) plus the dispatch machinery itself are
  // driven EXCLUSIVELY by `routinesTick`, which only arms when
  // `PAPERCUSP_BACKGROUND_WORKERS=1` (host-bootstrap.ts) — the operator API hosts
  // (:3070 release, :3170 staging) boot with BACKGROUND_WORKERS=0 (request-only) and
  // never execute this code at all. A fix here lands + gates + deploys to :3070 and is
  // STILL inert until bg-host itself is restarted (the exact silent-inertness this
  // classification exists to surface). Must be listed BEFORE the broad
  // `packages/operator-core/lib/` fallthrough below.
  {
    match:
      /^packages\/operator-core\/lib\/harness\/routines\/(register-system-actions|system-actions|routine-host)\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the routine-dispatch engine (routinesTick + the system-action registry) — it only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 boot request-only (BACKGROUND_WORKERS=0) and never execute it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  // WI-6659: the rules above catch code reached through the `system:<action>`
  // REGISTRY. But `routinesTickImpl` (lib/dbos/routines-workflow.ts) also dispatches
  // ~24 sweeps by DIRECT `await import(...)`, bypassing the registry entirely — so
  // they matched no rule and fell through to DEFAULT_OWNER, reporting `deployed ✓` +
  // `nextAction: null` for code :3070 never executes. That cost ~30min and a false
  // "the fix is live" conclusion on WI-6639: bg-host had been running 4h45m of
  // pre-fix code while this tool reported the change live. `routines-workflow.ts`
  // itself is covered (the `lib/dbos/` rule above); its dispatch TARGETS were not.
  //
  // Two tiers, because the targets are not uniform — see the guard test
  // (git-pipeline-position-routines-tick.test.ts), which re-derives this set from
  // routines-workflow.ts's actual imports and FAILS when sweep #25 is added without
  // a rule here. That guard is what makes this a class fix rather than a one-off.
  {
    // Tier 1 — bg-host ONLY. Verified: no non-test importer outside the bg-host
    // sweep set itself, so a deploy can never be the activation path for any consumer.
    match:
      /^packages\/operator-core\/lib\/(harness\/routines\/(reconcile-loop-routines|reconcile-plan-runs|autoloop-chronic-failure|claim|learning-loop-health-sweep|tsc-red-sweep)|rubric-staleness-watchdog|wall-lapse-watchdog|agent-state-divergence-sweep|agent-plane-measurement-sweep|release-deploy-staleness-watchdog|search\/session-ingest-lag-watchdog|sync\/hyperbee\/cold-join-(canary|executor))\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is a periodic sweep dispatched DIRECTLY by `routinesTickImpl` (lib/dbos/routines-workflow.ts), not through the `system:<action>` registry — routinesTick only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 boot request-only and never execute it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (WI-6659 / EI-11120).',
    },
  },
  {
    // Tier 2 — genuinely DUAL-consumer (WI-5440 plural shape). Each of these is swept
    // by routinesTick in bg-host AND read by operator-served surfaces (agent-tools MCP
    // handlers, sync-resolver, endpoint-route). Reporting either route alone sends half
    // the callers to the wrong activation lever, so both are returned.
    match:
      /^packages\/operator-core\/lib\/(pot\/(watchdog|placement-watchdog|started|throughput)|overwatch\/watchdog|harness\/routines\/loop-fire|autoloop)\.ts$/,
    own: [
      {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation:
          'The SWEEP/tick half of this module is dispatched by `routinesTickImpl`, which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). For THAT consumer it loads on RESTART: dev:restart { target: "bg-host", confirm: true } — a deploy never carries it (WI-6659).',
      },
      {
        host: 'operator-release',
        releasePipelineApplies: true,
        restartTarget: 'staging',
        activation:
          'This module is ALSO read by operator-served surfaces (agent-tools MCP handlers / sync-resolver / endpoint-route). For THAT consumer the ordinary staging→green-gate→deploy pipeline is the activation path (or dev:restart { target: "staging", confirm: true } to exercise it now on :3170).',
      },
    ],
  },
  {
    // Covers both the singular (`foo-action.ts`) and plural (`foo-actions.ts`,
    // e.g. improvement-actions.ts, coord-invariant-actions.ts) naming used across
    // this directory's registered `system:<action>` handlers.
    match: /^packages\/operator-core\/lib\/harness\/routines\/.*-actions?\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is a `system:<action>` routine handler, dispatched by routinesTick — which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 boot request-only (BACKGROUND_WORKERS=0) and never invoke it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  // WI-39787: the thin `system:<action>` file is not the only source module
  // executed by a routine. These guards are imported by bg-host-only routine
  // actions (or the bg-host loop reconciler) and therefore need the same
  // activation verdict as their action seams. Without this explicit dependency
  // mapping, an edit to e.g. stalled-loops-guard.ts fell through to
  // DEFAULT_OWNER and looked deploy-carried even though :3070 never loads it.
  // Keep this list deliberately narrow: the runtime-owner map cannot safely
  // infer ownership for every static import, since shared helpers also have
  // operator-served consumers (WI-10671).
  {
    match:
      /^packages\/operator-core\/lib\/harness\/routines\/(loop-unreachable|pty-host-wedge|stalled-loops)-guard\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is a guard implementation executed by a bg-host-only routine action or loop reconciler, which runs from the staging tree when PAPERCUSP_BACKGROUND_WORKERS=1. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (WI-39787).',
    },
  },
  // acceptance-runtime-plane-not-main-2026-09-23: the psu-pty host-events ingest is
  // executed ONLY by its `system:psu-pty-host-events-ingest` action in bg-host. Its other
  // importers (the seed script, bespoke-active-seeds-check, routine-classification) read
  // the routine NAME, never the ingest logic. Unmapped, it fell through to DEFAULT_OWNER
  // and reported `deployed:false, blockedOn:gate` for code bg-host had been running for
  // an hour — and the implementer and the independent grader both waited on main for it.
  {
    match: /^packages\/operator-core\/lib\/harness\/routines\/psu-pty-host-events-ingest\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'The psu-pty host-events ingest runs only inside its `system:psu-pty-host-events-ingest` routine action, dispatched by routinesTick in bg-host (PAPERCUSP_BACKGROUND_WORKERS=1), which bundles the canonical tree on every start. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it.',
    },
  },
  // The psu pty host is imported in-process by psu-launcher.mjs, one process per psu
  // session, loaded from the canonical tree at LAUNCH. No deploy and no service restart
  // carries it: every NEW session runs the current file; a running session keeps the
  // version it launched with. `servingRuntimes` reports how many live sessions are current.
  {
    match: /^apps\/operator\/scripts\/psu-(pty-host|launcher)\.mjs$/,
    own: {
      host: 'psu-pty-host',
      releasePipelineApplies: false,
      restartTarget: null,
      activation:
        'Loaded in-process by psu-launcher.mjs when each psu session LAUNCHES, from the canonical tree. Every new psu session runs the current file; already-running sessions keep the version they launched with (relaunch/carry-respawn a session to pick it up). A :3070 deploy never changes it.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/blueprint\/blueprint-run-action\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'The `system:blueprint-run` routine handler — the seam every deterministic-blueprint learning loop (scout, negative-space, red-queen, ...) fires through. Dispatched by routinesTick, which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/scout\//,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'Scout\'s ideation cycle runs exclusively through the routine dispatch (the `scout` deterministic blueprint\'s `blender:cycle` step, fired via `system:blueprint-run`), which only executes when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host) — :3070/:3170 never run it. A deployed fix to this code is INERT until bg-host is restarted: dev:restart { target: "bg-host", confirm: true } (EI-11120 — this exact silent-inertness cost WI-4475 a wasted deploy-and-wait cycle).',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/harness\/git-sync\//,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'The git-sync pipeline (run-git-sync + its eligibility/escalation/reconcile helpers) executes only from the `system:git-sync` routine handler, dispatched by routinesTick — which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 never execute it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  {
    match: /^papercusp-desktop\/src-tauri\//,
    own: {
      host: 'tauri-desktop',
      releasePipelineApplies: false,
      restartTarget: null,
      activation:
        'Rust/Tauri shell code — it is COMPILED into the desktop binary, not served by any host. Neither a deploy nor a `dev:restart` activates it: rebuild the shell (`cd papercusp-desktop && npm run dev`).',
    },
  },
  // EI-19323821719374642: green-checkpoint.ts has ZERO non-test importers repo-wide (verified by
  // grep) — it is never `await import`ed or loaded in-process by any long-lived host. It exists
  // purely as a standalone CLI. The scheduled `system:green-checkpoint` path launches it as a
  // fresh child through release-actions.ts's runScript; the manual `release:checkpoint-run` path
  // launches it in a detached transient systemd unit. Both set their working directory to the
  // STAGING integration root. Absent this entry the path fell
  // through to DEFAULT_OWNER (operator-release, releasePipelineApplies:true) — which told an
  // agent to wait on a :3070 DEPLOY for code a deploy can never carry, and produced a false "gate
  // deadlock" diagnosis during a live green-checkpoint incident (four agents mid-incident; it
  // survived only because the finding was labelled a question rather than asserted).
  //
  // `host: 'bg-host'` names the scheduled trigger owner, not a literal claim that this runs
  // INSIDE the bg-host process. `restartTarget: null` is load-bearing: every invocation is a
  // fresh spawn, so a long-lived-process staleness probe and restart lever are both inapplicable.
  {
    match: /^apps\/operator\/lib\/release\/green-checkpoint\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: null,
      activation:
        'green-checkpoint.ts is a fresh CLI process on every run: the scheduled `system:green-checkpoint` path spawns it as a child and manual `release:checkpoint-run` uses a detached transient unit, both from the STAGING integration tree. A :3070 deploy NEVER changes what this file executes, and no long-lived host restart is involved. Your edit is already what the NEXT invocation runs — wait for the periodic cron tick, or fire one now with release:checkpoint-run.',
    },
  },
  // EI-19369080695408825 — MUST STAY LAST. The catch-all for routinesTick-dispatched
  // sweeps, DERIVED from routines-workflow.ts's real `await import(...)` set rather than
  // hand-copied (see routines-dispatch-derivation.ts for why, and for the failure
  // direction: it degrades to never-matching, never to matching-everything).
  //
  // Because `classifyRuntimeOwners` returns the FIRST match, every hand-written rule above
  // still wins — including the WI-5440 dual-consumer entries, which must keep reporting
  // BOTH routes and would be wrongly collapsed to bg-host-only if this rule preceded them.
  // So this changes the answer for exactly one population: a NEW sweep no rule covers yet,
  // which today falls through to DEFAULT_OWNER and gets reported as `deployed ✓` for code
  // the :3070 operator never executes. That mislabel red-pinned the shared gate twice in
  // one day (sweeps #25 and #26) — not because it was undetectable, but because detecting
  // it depended on an author running a suite they could skip.
  //
  // Adding sweep #27 now needs no edit here at all.
  {
    get match(): RegExp {
      return dispatchedSweepMatcher();
    },
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is a periodic sweep dispatched DIRECTLY by `routinesTickImpl` (lib/dbos/routines-workflow.ts), not through the `system:<action>` registry — routinesTick only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 boot request-only and never execute it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (WI-6659 / EI-11120).',
    },
  },
];

const DEFAULT_OWNER: RuntimeOwnership = {
  host: 'operator-release',
  releasePipelineApplies: true,
  restartTarget: 'staging',
  activation:
    'Served by the operator. The green pipeline carries it to the live :3070 operator (release checkout) — or restart the staging host to exercise it NOW on :3170: dev:restart { target: "staging", confirm: true }.',
};

/**
 * EI-20242154394397741: `confirm` is the deliberate drain/restart gate, while
 * `authorize` is the separate audited enablement gate. Runtime ownership text
 * predates the latter and used to hand callers a guaranteed `restart_withheld`
 * response. Normalize every concrete restart recipe at the boundary so the
 * many hand-authored ownership entries cannot drift back to the incomplete form.
 */
function withRestartAuthorization(text: string): string {
  return text.replace(
    /dev:restart \{ target: ("[^"]+"), confirm: true \}/g,
    'dev:restart { target: $1, confirm: true, authorize: true, reason: "<why>" }',
  );
}

/**
 * ALL processes that run this path — a path can have more than one consumer
 * on DIFFERENT activation routes (WI-5440: e.g. a file read by both a
 * bg-host-only routine AND an operator-served MCP tool). Returns the full
 * list, always in the order declared on `RUNTIME_OWNERS` (single-owner paths
 * — the overwhelming majority — get a 1-element array). `null` when we cannot
 * tell (a sha-only probe), which conservatively keeps the default
 * release-pipeline reading.
 */
export function classifyRuntimeOwners(relPath: string | null | undefined): RuntimeOwnership[] | null {
  if (!relPath) return null;
  const p = relPath.replace(/^\.?\//, '');
  const hit = RUNTIME_OWNERS.find((r) => r.match.test(p));
  const owners = hit ? (Array.isArray(hit.own) ? hit.own : [hit.own]) : [DEFAULT_OWNER];
  return owners.map((owner) => ({ ...owner, activation: withRestartAuthorization(owner.activation) }));
}

/**
 * Which process runs this path — and therefore whether the release pipeline is
 * the activation path for it at all. `null` when we cannot tell (a sha-only
 * probe), which conservatively keeps the default release-pipeline reading.
 *
 * EI-16183/WI-5440: this collapses to the FIRST-declared owner and so hides
 * any second consumer a path may have — kept only for callers that
 * genuinely want a single best-guess answer (and for back-compat). Prefer
 * `classifyRuntimeOwners` (plural) for anything that acts on the result,
 * so a dual-owner path is never silently routed as single-owner.
 */
export function classifyRuntimeOwner(relPath: string | null | undefined): RuntimeOwnership | null {
  const owners = classifyRuntimeOwners(relPath);
  return owners ? owners[0] : null;
}

/**
 * Shared code (operator-core / libs) is ALSO loaded by the staging-tree hosts,
 * so a deploy is not necessarily what makes YOUR behavior change. Surfaced as a
 * note rather than a reclassification: we cannot know from the path alone which
 * host the caller cares about.
 */
function sharedHostCaveat(relPath: string | null): string | null {
  if (!relPath) return null;
  const p = relPath.replace(/^\.?\//, '');
  if (!/^(packages\/operator-core\/lib|libs)\//.test(p)) return null;
  return 'Shared code: this path is ALSO loaded by the staging-tree hosts (gateway :8788, bg-host routines, :3170) which run tsx from this tree — not from the release checkout. If the behavior you are testing runs in one of THOSE, a deploy will not change it; restart that host (dev:restart { target }).';
}

export type PipelinePositionAssessment =
  | 'live'
  | 'restart-required'
  | 'uncommitted'
  | 'awaiting-push'
  | 'awaiting-gate'
  | 'awaiting-deploy';
export type GateVerdictAssessment =
  | 'inconclusive'
  | 'repair-head-red'
  | 'red-stale'
  | 'red-current'
  | 'not-firing'
  | 'passing-buffered'
  | 'passing-current';
export type GateCandidateAssessment =
  | 'no-active-run'
  | 'candidate-not-yet-published'
  | 'judging-current-path'
  | 'judging-without-current-path'
  | 'frozen-candidate-contains-path'
  | 'frozen-candidate-without-path'
  | 'inferred-candidate';

// The judged-sha provenance vocabulary lives in a leaf module so the cell registration can
// derive `headlineSource.authoritative` from it without importing this (git/systemd/pg) file.
export {
  AUTHORITATIVE_JUDGING_SHA_SOURCES,
  isAuthoritativeJudgingShaSource,
  type JudgingShaSource,
} from './judging-sha-source';
export type DeployedShaAssessment =
  | 'executing'
  | 'restart-required'
  | 'process-unverified'
  | 'serving-not-probeable';
export type MainBehindStagingAssessment = 'caught-up' | 'normal-buffer' | 'gate-stalled';

export interface PipelineAssessments {
  pipelinePosition: PipelinePositionAssessment | null;
  gateVerdict: GateVerdictAssessment | null;
  gateCandidate: GateCandidateAssessment | null;
  gateOwnership: CellOwnership['assessment'] | null;
  deployedSha: DeployedShaAssessment | null;
  mainBehindStaging: MainBehindStagingAssessment | null;
}

/** PURE. Adjacent stages must agree; a later true never excuses an earlier false. */
export function assessPipelinePosition(input: {
  targetSha: string | null;
  dirtyUncommitted: boolean;
  positions: PipelinePosition['positions'];
  positionsUnknown: readonly string[];
  positionsNewerCommit: readonly string[];
  servingStartedSinceCodeChange: boolean | null;
}): PipelinePositionAssessment | null {
  if (
    (!input.targetSha && !input.dirtyUncommitted) ||
    input.positionsUnknown.length > 0 ||
    input.positionsNewerCommit.length > 0
  ) {
    return null;
  }
  const { committedLocal, onStaging, inMain, deployed } = input.positions;
  if ((onStaging && !committedLocal) || (inMain && !onStaging) || (deployed && !inMain)) return null;
  // EI-24049239243821100: a dirty path is 'uncommitted' however far its LAST COMMIT
  // travelled. The positions describe that older commit, not the edit on disk, so
  // gating this on `!committedLocal` let a dirty file whose previous commit was
  // deployed read 'live' — the tool told an author their uncommitted fix was running.
  if (input.dirtyUncommitted) return 'uncommitted';
  if (committedLocal && !onStaging) return 'awaiting-push';
  if (onStaging && !inMain) return 'awaiting-gate';
  if (inMain && !deployed) return 'awaiting-deploy';
  if (!deployed) return null;
  if (input.servingStartedSinceCodeChange === true) return 'live';
  if (input.servingStartedSinceCodeChange === false) return 'restart-required';
  return null;
}

/** The `gate.inconclusive.status` values that record a SERIALIZED REPAIR HOLD rather than an
 *  abort: the frozen queue, not the full-suite verdict path, owns progress on the lineage. */
const REPAIR_HOLD_INCONCLUSIVE_STATUSES: ReadonlySet<string> = new Set([
  'repair-in-progress',
  'repair-staging-mismatch',
]);

type RepairHeadVerdict = NonNullable<
  NonNullable<PipelinePosition['gate']['repairQueue']>['verdictProvenance']
>['repairHeadVerdict'];

export function assessGateVerdict(input: {
  inconclusive: { status: string } | null;
  consecutiveReds: number;
  verdictStale: boolean;
  fireStale: boolean;
  mainBehindStaging: boolean | null;
  verdictUnknownLegs: readonly string[];
  /**
   * WI-10004092: `gate.repairQueue?.verdictProvenance?.repairHeadVerdict ?? null`. Optional so
   * existing callers keep today's behaviour; omitted/null is read as "no verdict on the repair
   * head" and keeps the weaker `inconclusive` rather than claiming a red nobody measured.
   */
  repairHeadVerdict?: RepairHeadVerdict | null;
}): GateVerdictAssessment | null {
  if (input.inconclusive !== null) {
    // WI-10004092: a repair hold latches `gate.inconclusive` on EVERY tick — a crash before the
    // queue was read and a completed verify that measured the repair head red both write
    // `status: 'repair-in-progress'`. Returning 'inconclusive' for both made the red invisible:
    // the code never changed, so an `op:'changed'` subscriber on this cell slept straight
    // through it (measured 2026-09-30: repairHead 7652f8c9 went red at 01:59Z, watch never fired).
    // The queue's own per-head provenance is what separates them, so a hold whose CURRENT head
    // has a recorded red is a code verdict, not an abort. A head not yet judged stays
    // 'inconclusive' — that is the honest "no verdict on this head yet".
    const head = input.repairHeadVerdict ?? null;
    if (
      REPAIR_HOLD_INCONCLUSIVE_STATUSES.has(input.inconclusive.status) &&
      (head === 'full-gate-red' || head === 'same-as-frozen-full-gate-red')
    ) {
      return 'repair-head-red';
    }
    return 'inconclusive';
  }
  if (input.verdictUnknownLegs.includes('gate.consecutiveReds')) return null;
  if (input.consecutiveReds > 0) return input.verdictStale ? 'red-stale' : 'red-current';
  if (input.fireStale) return 'not-firing';
  if (input.verdictUnknownLegs.includes('gate.stalled')) return null;
  if (input.mainBehindStaging === null || input.verdictUnknownLegs.includes('verdictProvenance.mainFastForwarded'))
    return null;
  return input.mainBehindStaging ? 'passing-buffered' : 'passing-current';
}

/**
 * EI-21347137633438058: a stale verdict must never dispatch a caller to fix the
 * failures it names and then re-run the checkpoint against that same verdict.
 * The assessment surface already carries the safe action for this state; keep this
 * small projection at the stage boundary so `nextAction` cannot contradict it.
 *
 * Only stale-verdict advice is rewritten. A null lever (for example, a measured
 * in-flight run) and an unrelated lever (for example, a migration blocker) retain
 * their existing meaning.
 */
export function staleVerdictSafeLever(
  reasonCode: PipelinePosition['gate']['verdictStaleReasonCode'],
  lever: string | null,
): string | null {
  if (reasonCode === null || lever === null) return lever;
  if (!/fix the reds|release:checkpoint-run/i.test(lever)) return lever;
  return `Verify the CURRENT candidate before fixing anything — the named failures may belong to a run that has already been abandoned (stale verdict: ${reasonCode}).`;
}

/**
 * EI-22173032622074833 — the sibling of `staleVerdictSafeLever` above, for the OTHER state in
 * which a re-cut lever contradicts the mechanism that owns it.
 *
 * `release:checkpoint-run` ALWAYS cuts a FRESH candidate at tip (`candidateSource: tip`; it
 * exposes no candidate arg), so firing it while a frozen repair queue is live discards that
 * queue and restarts the treadmill freeze-and-converge (P-013 / D-007) exists to prevent.
 *
 * The queue's OWN `nextAction` already encodes the safe move for every state it can be in, so
 * this DEFERS to it rather than inventing second advice:
 *   • non-null, recoverable — "do NOT retire it … release:repair-queue { op: 'converge' }",
 *     which is also the precise answer to "the judged candidate predates my commit":
 *     converging lands the fix ON the judged lineage instead of re-cutting away from it.
 *   • non-null, terminal — the retire recipe, for a decision the mechanism itself called
 *     finished (`hold-dispatch-infeasible` / `hold-exhausted`).
 *   • null — the queue is NOT retirable (live fixer, active dispatch reservation, or unknown
 *     liveness). That is where firing is MOST wrong, and it is the one case with no
 *     queue-authored sentence to defer to, so say so explicitly rather than letting the
 *     re-cut lever stand.
 *
 * Why a projection at the stage boundary rather than one more arm in the lever ternary: that
 * ternary ALREADY has a `g.repairQueue?.nextAction` arm, but it sits in the branch reached
 * only when the judged candidate ALREADY CONTAINS the change. A frozen candidate necessarily
 * ages behind a tree ~100 agents commit to continuously, which makes `notInCandidate` the
 * STEADY STATE of a live queue rather than a corner case — so the existing arm is unreachable
 * in exactly the state that matters. That gap is why this was filed four separate times
 * (EI-21347137633438058, EI-22065259669472144, EI-22133273714016740, EI-22173032622074833)
 * against a lever that already appeared to handle repair queues. The existing arm is left in
 * place: it still outranks the `inconclusive` / `fireStale` / stalled arms for levers that
 * never name a checkpoint run, which is a different job from this veto.
 *
 * Only re-cut advice is rewritten. A null lever (nothing to fire) and an unrelated lever
 * (`git-sync:run`, `db:migrate`) keep their existing meaning, exactly as in
 * `staleVerdictSafeLever`.
 */
export function frozenRepairQueueSafeLever(
  repairQueue: PipelinePosition['gate']['repairQueue'],
  lever: string | null,
): string | null {
  if (!repairQueue) return lever;
  if (lever === null) return null;
  if (!/release:checkpoint-run/i.test(lever)) return lever;
  if (repairQueue.nextAction) return repairQueue.nextAction;
  // `nextAction: null` is `retireAllowed:false` — the queue is held by something live. Name
  // WHICH, because a bare "do not fire" with no reason is the advice readers talk themselves
  // out of.
  const pin = (repairQueue.frozenCandidate ?? repairQueue.candidate).slice(0, 12);
  const why =
    repairQueue.retireRefusal === 'live-fixer'
      ? 'a live fixer holds it'
      : repairQueue.retireRefusal === 'active-dispatch-reservation'
        ? 'a dispatch reservation is active on it'
        : repairQueue.retireRefusal === 'liveness-unknown'
          ? "its fixer's liveness is UNKNOWN, which is not evidence the fixer is gone"
          : `its phase (${repairQueue.phase}) is not one a retire may act on`;
  // ⚠ This sentence must NOT contain the tokens `staleVerdictSafeLever` matches
  // (`release:checkpoint-run` / `fix the reds`). It composes OUTSIDE this function, so a veto
  // that named the verb literally would be rewritten into the stale-verdict caution whenever a
  // stale verdict and a live queue coincide — silently dropping the reason and the converge
  // instruction. `safeGateLever` and its test pin that interaction.
  return (
    `Do NOT cut a fresh candidate — a frozen repair queue is live on candidate ${pin} ` +
    `(${repairQueue.phase}, decision '${repairQueue.decision}') and ${why}, so it cannot even be retired. ` +
    `A checkpoint run always cuts a fresh candidate at tip and would discard this queue. ` +
    `Land your fix on the judged lineage with release:repair-queue { op: 'converge', paths: ['<your changed path>'] }.`
  );
}

/**
 * The gate stage's two lever vetoes, composed in the order that keeps both meaningful.
 *
 * The frozen-repair-queue veto runs INNERMOST deliberately. Run the other way round, a stale
 * verdict rewrites a `release:checkpoint-run` lever into its own "verify the current
 * candidate" caution, which no longer matches the re-cut pattern — so the repair queue's
 * concrete `op: 'converge'` instruction would be silently swallowed whenever BOTH conditions
 * hold. Neither order can emit re-cut advice while a queue is live; this order also keeps the
 * actionable half.
 */
export function safeGateLever(gate: PipelinePosition['gate'], lever: string | null): string | null {
  return staleVerdictSafeLever(gate.verdictStaleReasonCode, frozenRepairQueueSafeLever(gate.repairQueue, lever));
}

export function assessGateCandidate(input: {
  judgingSha: string | null;
  judgingShaSource?: ChangeInCandidate['judgingShaSource'];
  judgingContainsPath?: boolean | null;
  verdictUnknownLegs: readonly string[];
  checkpointRunInFlight?: Pick<NonNullable<PipelinePosition['gate']['checkpointRunInFlight']>, 'active'> | null;
}): GateCandidateAssessment | null {
  if (input.judgingSha === null) {
    // P-009 / WI-41252: candidate publication trails process liveness during setup.
    // An authoritative active reading with no sha is therefore a live run whose
    // candidate is NOT YET PUBLISHED, never a measured absence. Returning
    // `no-active-run` here handed callers permission to fire into that setup window.
    if (input.checkpointRunInFlight?.active === true) return 'candidate-not-yet-published';
    // EI-21862849770458561: `checkpointRunInFlight === undefined/null` means the mapper
    // (`mapCheckpointRunInFlight`) could not measure liveness at all (both its cache and
    // live-lock reads came back empty/failed) — genuinely UNKNOWN, not a measured "not
    // active". `checkpointRunInFlight?.active === true` above is false in that case too,
    // so without this guard an unmeasured liveness read fell through to the same
    // `no-active-run` branch as a confidently-measured absence, contradicting that code's
    // own "a measured absence, not a failed read" meaning and steering a reader into
    // firing release:checkpoint-run when a run could in fact still be in flight.
    if (input.checkpointRunInFlight == null) return null;
    return input.verdictUnknownLegs.includes('changeInCandidate.judgingSha') ? null : 'no-active-run';
  }
  if (!isAuthoritativeJudgingShaSource(input.judgingShaSource)) return 'inferred-candidate';
  if (
    input.verdictUnknownLegs.includes('changeInCandidate.judgingContainsPath') ||
    input.judgingContainsPath === null ||
    input.judgingContainsPath === undefined
  )
    return null;
  // A 'repair-queue' sha with NO run in flight is the FROZEN candidate the next run resumes,
  // not a run judging right now — say so with its own codes, whose safe action is the
  // converge lever (never a re-cut). While a run IS active it resumed that same candidate
  // (freeze-and-converge), so the in-flight codes are the right reading.
  if (input.judgingShaSource === 'repair-queue' && input.checkpointRunInFlight?.active !== true)
    return input.judgingContainsPath ? 'frozen-candidate-contains-path' : 'frozen-candidate-without-path';
  return input.judgingContainsPath ? 'judging-current-path' : 'judging-without-current-path';
}

/**
 * WI-2141716. `servingStartedSinceCodeChange === null` is NOT one condition — it is two,
 * and they take OPPOSITE actions:
 *
 *  • the probe RAN and failed / lacked an operand (`resolver-failed`, `insufficient-data`)
 *    → retrying can genuinely turn this into an answer → `process-unverified`, whose
 *      safeAction is "re-probe the serving runtime".
 *  • no probe was ATTEMPTED because there is structurally no serving process to identify
 *    (`not-applicable`) → the two reachable cases are a sha-only read, where
 *    `evaluateServing` returns at its `if (!runtime)` branch with "No path was given
 *    (sha-only probe)", and a `tauri-desktop`/no-unit path. Re-probing can NEVER answer
 *    either → `serving-not-probeable`, whose lever is to ask a different QUESTION.
 *
 * Collapsing the second into the first is a retry-forever verdict: the caller is told to
 * re-probe, the answer cannot change, and it re-probes again. Measured cost — ended session
 * su-bf563dcb (2026-09-01) rode that loop for a day against `deploy.3070.sha` and filed ~10
 * near-duplicate items restating "deployed=true has no runtime evidence" (EI-22086002727188952,
 * EI-22084770820502553, EI-22082457721042350, EI-22080574287702981, EI-22079623943027181,
 * EI-22078186418153630, EI-22078125171565738, EI-22074933047196116, EI-22024451685900594).
 *
 * `evaluateServing` already computes the distinction and records it on
 * `serving.unknownReason.code`; this function's only job is to stop discarding it.
 */
export function assessDeployedSha(input: {
  deployedSha: string | null;
  servingStartedSinceCodeChange: boolean | null;
  /**
   * `serving.unknownReason?.code ?? null` — the reason the serving stage could not answer.
   * Optional so existing callers keep today's behaviour; omitted/null is read as UNKNOWN
   * and keeps the retry-shaped verdict rather than silently claiming the stronger one.
   */
  servingUnknownCode?: CellUnknown['code'] | null;
  verdictUnknownLegs: readonly string[];
}): DeployedShaAssessment | null {
  if (input.deployedSha === null || input.verdictUnknownLegs.includes('deployedSha')) return null;
  if (input.servingStartedSinceCodeChange === true) return 'executing';
  if (input.servingStartedSinceCodeChange === false) return 'restart-required';
  if (input.servingUnknownCode === 'not-applicable') return 'serving-not-probeable';
  return 'process-unverified';
}

export function assessMainBehindStaging(input: {
  mainBehindStaging: boolean | null;
  fireStale: boolean;
  verdictUnknownLegs: readonly string[];
}): MainBehindStagingAssessment | null {
  if (input.mainBehindStaging === null || input.verdictUnknownLegs.includes('verdictProvenance.mainFastForwarded'))
    return null;
  if (!input.mainBehindStaging) return 'caught-up';
  return input.fireStale ? 'gate-stalled' : 'normal-buffer';
}

export interface PipelinePosition {
  input: { path: string | null; sha: string | null };
  repoRoot: string;
  /** Set when the path resolved inside a submodule. */
  submodule: string | null;
  /**
   * EI-18715870370005934: set when the caller passed a SUPERPROJECT sha together
   * with a submodule path. The superproject stores only a gitlink for a
   * submodule, so that sha resolves to no content and no commit inside the
   * submodule; we resolve the gitlink and report positions for the PINNED
   * submodule commit instead. Non-null means "the sha you asked about is not the
   * sha these positions describe" — the mapping is recorded here so the
   * substitution is never silent.
   */
  submodulePin: { superprojectSha: string; submoduleSha: string } | null;
  /** The commit whose pipeline position we report. */
  targetSha: string | null;
  targetShortSha: string | null;
  targetSubject: string | null;
  /** The path has uncommitted edits in the working tree (not yet committed). */
  dirtyUncommitted: boolean;
  positions: {
    committedLocal: boolean;
    onStaging: boolean;
    inMain: boolean;
    deployed: boolean;
  };
  /** Six decision-ready conclusions derived once from this resolver payload. */
  assessments: PipelineAssessments;
  /**
   * D-038 axis 2 + D-039's HOIST: the `positions.*` legs whose git read FAILED, so
   * their boolean is `false` by DEGRADATION rather than by measurement. Empty means
   * every leg was genuinely measured. `workingTree` (EI-24049239243821100) names the
   * path's `git status` read: when it failed, `dirtyUncommitted: false` is not
   * evidence the path is clean.
   *
   * WHY THIS IS RESULT-LEVEL AND NOT A PER-LEG FLAG: a qualifier a caller can skip
   * past is how the defect survives contact with a hurried consumer, which is why
   * systemd hoists `unitsUnknown[]` and `dev:listening_ports` hoists `ownerHidden`.
   * A non-empty array here means at least one `false` above is NOT evidence the
   * stage was not reached — do not report "not yet, wait" on it.
   */
  positionsUnknown: string[];
  /**
   * WI-6646 — the MARKER verdict for the two legs that lag (`inMain`, `deployed`),
   * present only when the caller named a `marker`.
   *
   * WHY THE LEGS NEED IT AT ALL. With a `path`, `targetSha` is resolved as "the NEWEST
   * commit touching this path" (`git log -1 -- <path>`), and every leg is then answered
   * about THAT commit. On a shared file in this tree that commit is routinely a PEER'S,
   * committed after yours by the whole-tree git-sync sweep — so `inMain: false` means
   * "the newest commit touching this file has not reached main", NOT "your change has
   * not reached main". Measured 2026-07-28: 43 of the 54 paths then diverging between
   * main and staging reported `inMain: false` while a real change to that same file WAS
   * already in main.
   *
   * That is the identical newer-commit trap `changeInCandidate.judgingContainsPath`
   * carries — but these legs shipped without either of its two mitigations (no
   * `missingReason` to explain the false, no `marker` to settle it), and they are the
   * legs the `summary`, `stages[]`, `blockedOn` and `nextAction` are all derived from.
   *
   * A DEFINITIVE marker verdict CORRECTS the leg it belongs to, in BOTH directions:
   * reading the ref's own version of the file is a direct measurement of the question
   * being asked, so it supersedes the commit-ancestry proxy — the same precedent as the
   * `ls-remote` correction of a stale local `origin/staging` ref. An UNKNOWN marker read
   * never corrects anything.
   */
  positionsMarker: {
    marker: string;
    onStaging: MarkerContainment | null;
    inMain: MarkerContainment | null;
    deployed: MarkerContainment | null;
  } | null;
  /**
   * WI-6646 — legs whose `false` is a NEWER-COMMIT ARTIFACT: the ref does not contain
   * `targetSha`, but it DOES contain an earlier commit touching this same path, so the
   * file has already landed changes there and this `false` may not be about the caller's
   * change at all. Hoisted to the result for the same reason as `positionsUnknown` — a
   * per-leg qualifier a hurried consumer can skip past is how the defect survives.
   *
   * Empty is the good case. A named leg means: do not report "not yet, wait" on it —
   * re-call with `marker` set to a literal string from your own change to settle it.
   */
  positionsNewerCommit: string[];
  deployedSha: string | null;
  gate: {
    /**
     * `null` = the stall signal was not measured. `GitPipelineSnapshot.gate.stalled`
     * became `boolean | null` in 0a097dae4d (deriveInRoutineGateStalled). This
     * resolver already branches on `=== null` and hoists the leg into
     * `verdictUnknown`, but the declared type still said `boolean`.
     */
    stalled: boolean | null;
    consecutiveReds: number;
    /**
     * The gate writer's current actionable failing-file set. Optional for old fixtures and
     * snapshots; an explicit empty array is distinct from an absent/unknown field.
     */
    failingTests?: string[];
    /** Same-surface proof for whether the failingTests array was actually measured. */
    failingTestsMeasured?: boolean | null;
    /** P-005: names whether failingTests is measured, carried, not measured, or unknown. */
    failingTestsProvenance?: GateFailingTestsProvenance;
    lastGreenAtMs: number | null;
    /** WI-282: the green-checkpoint is WEDGED / not firing (visible even at 0 reds). */
    fireStale: boolean;
    fireStaleReason: string | null;
    /** Deliberate green-checkpoint pause; when present it outranks cached gate verdicts. */
    pause?: NonNullable<GitPipelineSnapshot['routines']['greenCheckpoint']>['pause'];
    /**
     * P-004 — WHO owns this gate incident (`green-stall:<harness>`): the singleton
     * work-item, its explicit `claimState`, and the lease.
     *
     * OPTIONAL for the same reason as `checkpointRunInFlight` below: a required
     * field here would strand every `PipelinePosition` fixture in the suite that
     * has no opinion about ownership. An omitting caller reads as UNKNOWN.
     *
     * ⚠ Do NOT read `claimState: 'no-object'` as "the gate is healthy" — it means
     * nobody owns the condition, which is equally true of a green gate and of a red
     * one nobody has filed yet. Gate health is `consecutiveReds`/`verdictStale`.
     */
    ownership?: CellOwnership;
    /**
     * EI-18793581783459047: is a green-checkpoint SUITE run active RIGHT NOW — so a
     * caller about to launch a heavy local suite (test:affected, a multi-file
     * test:file re-verify) can see it would be CONTENDING with the gate's own suite
     * for host CPU/memory. Filed after a live incident: an agent re-verifying gate
     * reds ran `npm run test:file` over 9 files while the gate's own isolation
     * re-run phase (which exists to tell flake from real break) was starved by the
     * combined load into a false "still failing" verdict on files that passed
     * cleanly moments later, unloaded.
     *
     * TWO sources, combined — see `activeSource` for which one answered:
     *
     *  1. The green-checkpoint RUN LOCK, read LIVE on this call
     *     (`isCheckpointRunLockHeldCheap`). Fork-free (one `owner.json` read plus a
     *     `kill(pid,0)` liveness check), and it sees BOTH origins — every run, manual
     *     or cron, holds that same lock for its whole duration. This is the
     *     authoritative liveness answer.
     *  2. The `dev.gitPipeline` background derived-read cache (recomputed on roughly
     *     every routine tick, ttl 90s — see derived-reads/producers.ts), which
     *     supplies the run DETAIL the lock cannot know (candidate, refire provenance).
     *
     * EI-19395922387569240 — why the lock read had to be wired in. This leg used to be
     * cache-ONLY, and `{ active: false }` was documented (and consumed, at the gate
     * lever) as "MEASURED idle". It was not measured: it was a reading of a snapshot of
     * unbounded age. Measured 2026-08-03 on the live box, both directions were already
     * wrong in the DB — the `papercusp-workspace` row was 90.9s old against its own 90s
     * ttl, and a second row sat 7.03 HOURS stale still asserting `active: true,
     * candidate f990615f, elapsedSec 314`. A stale `false` is the expensive one: it
     * routes the gate lever to "wait out the quiet-cut window, then
     * release:checkpoint-run" — i.e. it recommends firing a manual run into a live one,
     * the exact 🚨 action CLAUDE.md forbids because it discards an in-flight rescue.
     *
     * `null`/`undefined` still means UNKNOWN (no cached snapshot AND no lock reading —
     * both reads failed) — never "not active".
     *
     * OPTIONAL rather than required (unlike most legs on this interface) so
     * this addition does not force every existing `PipelinePosition` fixture
     * across the test suite to grow a new field it has no opinion about — a
     * caller that omits it gets the same UNKNOWN treatment as an explicit
     * `null`.
     */
    checkpointRunInFlight?: {
      active: boolean;
      /** Provenance of the systemd user-manager query behind this cached run reading. */
      systemd?: NonNullable<GitPipelineSnapshot['activeRun']>['systemd'];
      /** Checkpoint CLI result-marker presence from the most recent finished manual run. */
      terminalMarker?: boolean;
      /**
       * EI-20427717764878875: has the run that is active RIGHT NOW already published its verdict?
       * A number is the instant it did; `null` means it is genuinely still deciding.
       *
       * ⚠ READ THIS AGAINST `terminalMarker` DIRECTLY ABOVE — they are easy to conflate and answer
       * different questions. `terminalMarker` is about the most recent FINISHED MANUAL run; this is
       * about the CURRENTLY ACTIVE one, on any origin. Neither substitutes for the other, and that
       * exact conflation is why this field had to exist.
       *
       * WHY IT MATTERS MORE THAN IT LOOKS. A green-checkpoint run does not exit when it decides: it
       * continues into re-triage and the longest-clean-prefix salvage with its marker still live.
       * So `elapsedSec` measures the PROCESS, not the DECISION, and without this field "68 minutes
       * and still no verdict" is indistinguishable from "decided at 52 minutes, salvaging since".
       * Two agents burned ~1h on that distinction on 2026-08-14, and the natural response to an
       * apparently-overdue run is to fire a manual `release:checkpoint-run` — which discards an
       * in-flight rescue and costs a full suite. With this, elapsed-vs-verdict is computable.
       *
       * ABSENT means UNKNOWN, never "still deciding": the field is emitted only on the branch where
       * the run's own `inFlightCandidate` marker answered. A run reported from the retriage marker
       * or the probe simply did not publish this, exactly as an absent marker is unknown elsewhere
       * on this interface.
       */
      verdictWrittenAtMs?: number | null;
      /** EI-210996: systemd-owned abnormal-terminal evidence for that finished run. */
      terminalEvidence?: {
        source: 'systemd-exec-stop-post';
        candidate: string | null;
        serviceResult: string;
        exitCode: string;
        exitStatus: string;
        abnormal: boolean;
      };
      /**
       * EI-19395922387569240: WHERE `active` came from, because the two sources have very
       * different trust — the same reasoning as `candidateSource` below.
       *
       *  - `'run-lock'` — read LIVE on this call from the run lock, liveness-verified via
       *    `kill(pid,0)`. `active` is true AS OF NOW, for both origins (manual and cron).
       *  - `'process-authority'` — the pre-lock process was identified from its gate
       *    authority env, exact integration root, and unified cgroup. Also measured live;
       *    unlike argv matching, prompt text cannot manufacture it.
       *  - absent — the cached derived-read answered. `active` is only as good as
       *    `asOfAgeMs`, which can be arbitrarily large (measured: 7h). Treat an old
       *    cache-backed reading as a HINT, not a measurement, in EITHER direction.
       *
       * Emitted only when a live authority answered, so the cache-only reply shape is unchanged.
       */
      activeSource?: 'run-lock' | 'process-authority';
      /** P-009: the run is in the pre-lock startup/materialization interval and was
       * identified from its gate authority stamps, exact integration-root env, and
       * unified cgroup. Present only with activeSource='process-authority'. */
      processAuthority?: {
        workspace: string;
        harness: string;
        cgroupPath: string;
        pid: number;
      };
      /** Best-effort candidate sha the live run is judging.
       *
       * EI-19327704778173646 — this used to say "from its log head", which was the bug: a
       * head-read takes the FIRST `checkpointing candidate` line, and a run that auto-refired
       * has emitted a later one, so the reported sha was the ABANDONED candidate. It now
       * reports the run's CURRENT candidate.
       *
       * Consequence for readers: this value CAN legitimately change between two reads of the
       * SAME run (green-checkpoint recurses in-process onto tip and re-pins its checkout while
       * pid/started_at stay fixed), and a candidate newer than `startedAtMs` is the expected
       * signature of a healthy auto-refire — NOT corruption, and NOT a reason to fire a manual
       * run (that discards the in-flight rescue and costs a full suite). When it has moved,
       * `initialCandidate`/`refireObserved` below say so explicitly instead of leaving you to
       * infer it from two reads. */
      candidate: string | null;
      /** WI-7035: WHERE `candidate` came from, because the two sources have different trust.
       *
       *  - `'retriage-marker'` — the run's OWN published `inFlightRetriage` marker in Postgres.
       *    An authoritative observation of what this run is judging. Only ever present once the
       *    run has REFIRED, which is the uncommon case.
       *  - `'in-flight-candidate'` — the run's OWN published `inFlightCandidate` marker
       *    (EI-19931692050586322). Equally authoritative, and it covers the COMMON case: it is
       *    written at candidate-final time on every invocation, including a run's first
       *    candidate. Before this existed as a read, an ordinary non-refiring cron run could
       *    only ever be reported as `'run-probe'`.
       *  - `'run-probe'` — derived by probing the run. On a MANUAL run that is its `/tmp` unit
       *    log (an observation); on a CRON run the manual unit is inactive and the probe falls
       *    back to the checkpoint checkout's live HEAD, which is an INFERENCE that can change
       *    between two reads and is only right while that checkout is pinned to the candidate.
       *
       *  The first two are observations and interchangeable in trust; prefer either over
       *  `'run-probe'`, which is a hint. `'run-probe'` remains REACHABLE by design — both
       *  markers are best-effort writes that swallow their own errors, so a live run can
       *  legitimately publish neither, and the honest answer then is the labelled inference
       *  rather than a fabricated observation. */
      candidateSource?: 'retriage-marker' | 'in-flight-candidate' | 'run-probe';
      /** EI-19327704778173646: the candidate this run STARTED on, present only once it has
       *  re-candidated. Provenance only — never verify a fix against this sha. */
      initialCandidate?: string | null;
      /** EI-19327704778173646: true when the run demonstrably re-candidated mid-flight.
       *  Absent/false is NOT proof no refire happened, only that none was visible.
       *  ⚠ Before WI-7035 this could NEVER be true for a cron-fired run: it was derived
       *  purely from the `/tmp` unit log, which only MANUAL runs write. Prefer
       *  `inRetriageWindow`, which is marker-backed and works on both paths. */
      refireObserved?: boolean;
      /** WI-7035: an auto-refire is running RIGHT NOW for this run — i.e. you are inside the
       *  re-triage window CLAUDE.md tells you never to fire a manual `release:checkpoint-run`
       *  into (doing so discards the rescue and costs a full suite). Marker-backed, so unlike
       *  `refireObserved` it is readable on a cron-fired run. Absent when no marker is in
       *  flight — which means "no refire in flight", NOT "unknown". */
      inRetriageWindow?: true;
      /** WI-7035: the candidate this refire MOVED OFF (marker `fromCandidate`). A red you are
       *  still reasoning about may belong to this sha, which the run has already discarded. */
      fromCandidate?: string | null;
      /** WI-7035: the CHARGED rescue budget — `refireAttempt` of `maxRefires` used.
       *  ⚠ EI-19343516395023183: this is NOT "how many refires have happened", and on its own it
       *  is NOT "how much budget is left". Since EI-19343532231631821 it advances ONLY on a refire
       *  whose failures overlap the set already being rescued (a FAILED rescue), so a run five
       *  successful rescues deep still reads 0 — read `totalRefires`/`absoluteCeiling` alongside
       *  it, or `describeRefireBudget()` (release/in-flight-retriage.ts), which reports both. */
      refireAttempt?: number;
      maxRefires?: number;
      /** EI-19343516395023183: refires PERFORMED this run, charged or not — the counter that
       *  actually climbs on the healthy path, bounded by `absoluteCeiling` (= maxRefires × 3).
       *  Absent on a marker written before EI-19343532231631821 (⇒ unknown, not zero). */
      totalRefires?: number;
      absoluteCeiling?: number;
      /** Latest advancing heartbeat observed by the derived-read probe. */
      progressAtMs?: number | null;
      /** Current phase published by the active checkpoint run, when readable. */
      currentPhase?: string | null;
      startedAtMs: number | null;
      elapsedSec: number | null;
      /** How stale this reading is: ms since the cache was last computed. `null`
       *  when the cache carried no computedAt (should not happen once populated). */
      asOfAgeMs: number | null;
    } | null;
    /**
     * EI-19325520469216548: is the recorded RED still trustworthy? PROJECTED from
     * `git-pipeline-stats`'s `evaluateGateVerdictFreshness` (WI-4489 + EI-19346660748445728's
     * candidate-fossil rule) — the SAME computation the /admin/git panel already shows, but
     * until this fix it was silently dropped when this tool's `gate` object was built, so a
     * caller reading `consecutiveReds`/`stalled` here saw an undifferentiated red with no way
     * to tell "genuinely broken" from "the quiet-cut judged a commit before your fix landed".
     * `false` on a green gate (0 reds) or when nothing proves staleness — never treat `false`
     * as "definitely a real regression", only as "nothing here says otherwise".
     */
    verdictStale: boolean;
    /**
     * WI-1752145: WHEN the cached verdict beside it was observed (`gate_health.observedAt`) —
     * the vintage of `stalled` / `consecutiveReds` / `failingTests`, which are the fields a
     * reader acts on and which carried no stamp on this surface at all.
     *
     * It was already being computed one module over (`git-pipeline-stats.ts` resolves it to
     * feed `evaluateGateVerdictFreshness`) and then DROPPED here, so the only thing that
     * survived the projection was the derived `verdictStale` boolean. That is the same defect
     * as EI-19325520469216548 — cited at the very destructure that discards it — one field
     * over: a caller could be told a verdict was stale but never how old it was, and could not
     * tell "observed 40 seconds ago" from "observed last Tuesday".
     *
     * ⚠ Null means the blob carried no readable stamp — NOT "fresh".
     */
    verdictObservedAtMs: number | null;
    /** Human-readable reason `verdictStale` fired, or null when it did not. */
    verdictStaleReason: string | null;
    /** WHICH rule fired — see `GateVerdictFreshness.reasonCode` in gate-verdict-freshness.ts.
     *  ONLY `'pin-advance'` is hard proof a green already happened; the others — including
     *  `'pin-advance-unordered'` (EI-20571364274022293: the pin moved, but possibly BEFORE this
     *  red streak began) — prove only that the cached red is UNVERIFIED, not that the gate is
     *  green. Null when `verdictStale` is false. */
    /**
     * DERIVED from the evaluator that produces it, never re-declared (derived-truth ladder).
     * This was a hand-copied duplicate of the union and silently went stale the moment a new
     * reason code was added (WI-10002059 added 'repair-converging'), stranding the assignment
     * below with a TS2322 whose text elides the offending member behind "...22 more...".
     * `git-pipeline-stats.ts` already sourced it this way; both now share one definition.
     */
    verdictStaleReasonCode: GateVerdictFreshness['reasonCode'];
    /** EI-19325520469216548: how stale the judged candidate was at verdict time, in ms — present
     *  even when it falls short of the 'candidate-fossil' threshold (the routine ~4min quiet-cut
     *  lag is normal). Null when unmeasured. */
    candidateAgeMs: number | null;
    /** EI-19325520469216548: commits that landed on staging after the judged candidate was cut —
     *  the concrete count behind `candidateAgeMs`. A non-zero value on a red gate right after you
     *  just committed a fix is a first-hand reason to suspect the red predates it, with no need
     *  to pass `paths` to `release:checkpoint-run` to learn that. Null when unmeasured. */
    commitsBehindTip: number | null;
    /** EI-19325520469216548 (follow-up to WI-4533): the short sha of the candidate the current
     *  `consecutiveReds`/`failingTests` verdict pertains to (`gate_health.observedCandidate`).
     *  Null when there is no verdict, or on a blob predating this field. */
    observedCandidate: string | null;
    /**
     * EI-19405864032365760: the last tick ABORTED without rendering a verdict.
     *
     * ⚠ "and none is coming until the named condition clears" is TRUE ONLY FOR SOME OF THESE —
     * EI-21290961259437085. The statuses that reach here are `RECORDED_INCONCLUSIVE_STATUSES`
     * (release/gate-abort-status.ts), and they split three ways: a STANDING condition
     * (`migrations-pending` — a schema known to be behind; `repair-staging-mismatch`), a TRANSIENT
     * kill that latches nothing (`infra-inconclusive` per EI-20767792192323374, where the gate's own
     * vite-node cache was deleted mid-run so its ~4,800 failing files are a HOST fault and not a
     * claim about the code; `deadline-exceeded`; `cancelled`, an external SIGTERM), and PEER-OWNED
     * progress (`repair-in-progress`). `nextAction` and the summary sentence BOTH branch on that
     * classification — treating them uniformly as a standing blocker is precisely the defect that
     * told a fleet to clear a nonexistent condition while warning it off the one action that helps.
     *
     * ⚠ READ BEFORE `consecutiveReds`/`failingTests`. An abort is deliberately not counted as a
     * red, which leaves those counters frozen on the PREVIOUS verdict — so when this is non-null
     * they are STALE BY CONSTRUCTION and describe a candidate that is no longer what holds the
     * pipeline. Measured 2026-08-03: ~2.5h of a fleet reading "Gate is RED — the reds are yours
     * to fix" and chasing unrelated test files while one pending migration was the real blocker.
     * Null once any real verdict lands.
     */
    inconclusive: {
      status: string;
      candidate: string | null;
      detail: string | null;
      observedAtMs: number | null;
    } | null;
    repairQueue?: GitPipelineSnapshot['gate']['repairQueue'];
    /**
     * P-025: preserve the persisted queue read disposition beside the normalized queue.
     * `repairQueue: null` is compatible with both true absence and a present row whose
     * schema this build cannot parse; this field keeps those cases distinct.
     */
    repairQueueRead?: GitPipelineSnapshot['gate']['repairQueueRead'];
    /**
     * WI-2141736 P-004 — IS FREEZE-AND-CONVERGE ACTUALLY ON RIGHT NOW, AND IF NOT WHY NOT.
     *
     * The question `repairQueue` structurally cannot answer: a null queue is equally
     * "the owner turned the freeze off", "the gate just retired a frozen candidate" and
     * "nothing is frozen, all is well". `state` separates those (`off` / `retired` / `none`),
     * and `reason` carries the sentence that previously existed only in a per-run log.
     *
     * ⚠ `null` means NOT MEASURED, not healthy — and check `observedAtMs` before treating a
     * value as current: a `retired` left behind by a run hours ago describes history.
     */
    freezeAndConverge?: GitPipelineSnapshot['gate']['freezeAndConverge'];
    /**
     * main-green-status-visible-2026-09-03 P-004 — IS THE QUEUE CONVERGING, and how long
     * has it been at it?
     *
     * The third leg of the frozen-candidate subject, and the one that separates a working
     * freeze from a treadmill: `repairQueue` says WHICH sha is frozen, `freezeAndConverge`
     * says WHETHER the mechanism is acting, and this says WHETHER THAT ACTION IS WORKING —
     * `shrinkTotal` (failingFirst - failingNow, positive = shrinking), `ageMs`,
     * `admissionRounds`, and the per-round deltas behind them.
     *
     * ⚠ `converging` is TRI-STATE and `null` means NOT YET KNOWABLE (fewer than two rounds
     * recorded), never "not converging". ⚠ `null` on the whole record means NOT MEASURED —
     * check `observedAtMs` before treating a value as current.
     */
    convergence?: FrozenRepairConvergenceCellProjection;
    /**
     * main-green-status-visible-2026-09-03 P-004 — the CELLED reading of `freezeAndConverge`.
     *
     * Same record, one derivation. It exists because the stored `state` union cannot express
     * the two readings that matter most to a caller: `not-measured` (no readable record —
     * which a `state`-only reader must default, and both plausible defaults are wrong and
     * calm-sounding) and `stale` (a record past its freshness window, e.g. a `retired` left
     * behind hours ago and read as current).
     *
     * ⚠ ALWAYS an object — `code: 'no-disposition-recorded'` is the unmeasured answer, never `null`.
     */
    freezeDisposition?: FreezeDispositionCellProjection;
    /**
     * main-green-status-visible-2026-09-03 P-009 — IS AN AUTO-REFIRE / RE-TRIAGE IN FLIGHT,
     * i.e. must I stand down before firing a manual `release:checkpoint-run`?
     *
     * The CELLED reading of `checkpointRunInFlight` directly above — same leg, one
     * derivation, computed here rather than re-read. It exists because the question had no
     * READ at all: the only ways to learn you were inside the window were to provoke
     * `release:checkpoint-run`'s refusal (after deciding to act) or to dig the marker out of
     * routine metadata by hand. CLAUDE.md gives it a standalone 🚨 alarm block, which is the
     * tell that it is expensive and repeatedly got wrong.
     *
     * ⚠ ALWAYS an object — `code: 'no-run-reading'` is the unmeasured answer, never `null`. And
     * `standDown` is TRUE on `no-run-reading`: unknown HOLDS you rather than releasing you,
     * because collapsing an unmeasured reading to "nothing in flight" is precisely the
     * destructive green-light this cell withholds.
     */
    retriage?: RetriageCellProjection;
    /**
     * WI-1702869 — HOW MANY TEST FILES FAIL ON THE FROZEN CANDIDATE, and for each, whether
     * its fix is ALREADY contained in `repairHead`. The one number gate triage needs and the
     * one no instrument returned, which is why agents hand-wrote `test_runs` SQL and got it
     * wrong (measured 2026-08-31: "45 → 29 failing" reported when the true answer was ONE
     * failing file whose fix had already landed).
     *
     * ⚠ Read `candidateFailures.scope` before quoting any count from here: `filesJudged` is
     * the AFFECTED RADIUS, not the full suite, so an empty failing list is NOT "the gate is
     * green". `null` when there is no frozen repair queue to answer about.
     */
    candidateFailures: GateCandidateFailures | null;
    /**
     * gate-audit-hardening-2026-08-31 P-001 — the composed, vintage-stamped owner brief:
     * is main green / why not / who owns it / is remediation alive, answered in ONE leg
     * (cell `gate.greenCheckpoint.ownerBrief`). Composed purely from values THIS resolver
     * already computed — one derivation, no new I/O — with every leg carrying the vintage
     * of its underlying observation, so two readers quoting it cannot silently diverge.
     */
    ownerBrief: GateOwnerBrief | null;
    /** Routine-owned logical qualification state, projected from the same snapshot row. */
    qualification: NonNullable<GitPipelineSnapshot['gate']['qualification']>;
  };
  /**
   * EI-7846: provenance for the CURRENT gate/deploy verdict — distinct from the
   * per-target `positions` above (which answer "where is THIS path/sha"), this
   * answers "what does the pipeline consider green right now, and did the live
   * deploy actually come from that verdict, or was it pinned/forced ahead of or
   * behind it?" Derived entirely from already-loaded `deploy` state
   * (git-pipeline-stats.ts's `GitPipelineSnapshot.deploy`, the same
   * `devDeployState()` the /admin Git tab reads) — no new git calls except the
   * one ancestor check for `deployOrigin`.
   */
  verdictProvenance: {
    /** The full sha of `ready` — the green pin the LAST full-suite gate verdict produced. */
    lastGreenSha: string | null;
    lastGreenShortSha: string | null;
    /** How long ago that commit was made (ms) — the age of the current green pin. */
    lastGreenAgeMs: number | null;
    /**
     * True iff the green pin (`main` HEAD) is exactly at `staging` HEAD — i.e. there is
     * no un-checkpointed staging buffer. ⚠ DESPITE THE NAME, `false` here is the fleet's
     * NORMAL steady state (staging outruns the ~hourly green-checkpoint) and does NOT by
     * itself mean main has stopped advancing — `ready` IS `main` HEAD by this module's
     * own definition (see the naming note atop dev-deploy-state.ts), so "main vs the
     * green pin" can never diverge; what this field actually measures is the green pin
     * vs `staging`. WI-6357 / EI-18790908999972569: an earlier version of this comment
     * claimed "main is fully fast-forwarded to the newest green verdict", which does not
     * describe what is computed and is what led `false` to be read as a stall. For the
     * real stall signal, see `mainBufferIsStale`, which requires the buffer to have
     * outlived the pipeline's own normal cadence, not merely exist.
     */
    mainFastForwarded: boolean | null;
    /**
     * Whether the requested target commit is an ancestor of the recorded green pin.
     * This is deliberately separate from `positions.inMain`: main can contain a
     * force-deployed or otherwise newer commit while the last tested pin still lags.
     * `null` means the exact relationship could not be measured (or is not applicable,
     * such as a nested submodule commit).
     */
    targetIncludedInGreenPin?: boolean | null;
    /**
     * Whether the exact requested target commit is an ancestor of the candidate named by
     * `gate_health.observedCandidate` — i.e. whether that recorded gate verdict was produced
     * from a tree that contains the caller's fix commit.
     *
     * This is deliberately a raw containment measurement, not a gate-health conclusion and
     * not a lever recommendation. `false` means the observed candidate genuinely predates or
     * diverges from the target; `null` means the relationship was not measurable (no target,
     * no observed candidate, a submodule boundary, or a failed git read).
     */
    targetIncludedInObservedCandidate?: boolean | null;
    /**
     * THE SAME MEASUREMENT AS `mainFastForwarded`, IN THE POLARITY AGENTS ASK IN:
     * `true` means main IS behind staging (a buffer exists). A PROJECTION, not a second
     * derivation (axis 5) — both are the one `greenPinAtStagingHead` read, negated from
     * a single local, so they cannot drift apart; `null` (unmeasured) propagates as
     * `null` rather than becoming a confident `true`.
     *
     * ⚠ WHY BOTH EXIST — do not "simplify" this away. The state cell is named
     * `git.mainBehindStaging` because that is the question agents ask and hand-copy, but
     * `CellSpec.headline` is a FIELD PATH and axis 5 forbids a surface from re-deriving
     * (negating) what it projects. So the correctly-polarised value must exist HERE or
     * the cell answers its own name backwards — which it did, until
     * EI-20046248345042252: `state:read { cell: 'git.mainBehindStaging' }` returned
     * `false` while main sat 22 commits behind staging, because it projected
     * `mainFastForwarded` unchanged.
     *
     * ⚠ `true` IS NOT A FAULT. A buffer is the fleet's normal steady state (see
     * `mainFastForwarded` above); the stall signal is `mainBufferIsStale`, which requires
     * the buffer to have outlived the pipeline's own cadence.
     */
    mainBehindStaging?: boolean | null;
    /**
     * WI-38367: the age (ms) of the OLDEST commit on `staging` that `main` does not have —
     * the OLD END of the staging buffer. `null` = unmeasured (no buffer, or the git read
     * failed); never read a `null` as "the buffer is fresh".
     *
     * ⚠ This is NOT `lastGreenAgeMs`, and the two are not interchangeable.
     * `lastGreenAgeMs` is the age of the commit the pin SITS AT, which on a quiet fleet is
     * legitimately hours old with a one-minute-old buffer ahead of it. Only THIS field says
     * how long the pipeline has been failing to consume the backlog — which is why
     * `mainBufferStallReason` needs it to tell a gate that advanced the tip end apart from
     * one that is actually catching main up.
     */
    stagingBufferAgeMs?: number | null;
    /** Commits `ready` has that the deployed ref doesn't (0 once the live host has
     *  caught up to the latest green verdict). */
    deployedBehindGreenPin: number | null;
    /**
     * 'gate-green': the deployed sha IS the last green pin (normal auto-deploy path).
     * 'stale-behind-gate': deployed is an ancestor of `ready` — safe lag, will catch
     *   up on the next release-trigger tick.
     * 'ahead-of-gate': deployed carries commits `ready` does NOT — it was force-deployed
     *   past the gate (release:deploy --execute bypassing the green pin), not sourced
     *   from a full-suite green verdict. Flag this before trusting "deployed" as "tested".
     * 'unknown': insufficient data (no `ready` pin, or no deployed sha) to classify.
     */
    deployOrigin: 'gate-green' | 'stale-behind-gate' | 'ahead-of-gate' | 'unknown';
  };
  /**
   * unified-agent-state-plane-2026-07-27 P-007 — D-038 axis 2 + D-039's HOIST for the
   * three VERDICT legs, the ones agents were demonstrably hand-copying:
   * `gate.consecutiveReds`, `deployedSha`, `verdictProvenance.mainFastForwarded`.
   *
   * Empty means all three were genuinely measured. A non-empty entry means the leg it
   * names is NOT evidence of anything — and each of the three degrades into a value
   * that reads as GOOD NEWS, which is why they need hoisting rather than a comment:
   *   · `gate.consecutiveReds` → `0`, which reads as "the gate is passing";
   *   · `deployedSha` → `null`, which reads as "nothing is deployed";
   *   · `verdictProvenance.mainFastForwarded` → `null`, which reads as "no opinion".
   *
   * WHY RESULT-LEVEL AND NOT A PER-FIELD QUALIFIER: identical reasoning to
   * `positionsUnknown` above — a qualifier a caller can skip past is how the defect
   * survives contact with a hurried consumer. This one differs from `positionsUnknown`
   * in ONE way, deliberately: it carries the ENUMERATED `CellUnknown` rather than a
   * bare leg name, because `not-applicable` (a final answer) and `resolver-failed`
   * (retry-or-escalate) demand OPPOSITE caller behaviour and a name cannot express
   * which one it was. See cell-contract.ts for why that enum exists at all.
   */
  verdictUnknown: Array<{ leg: string; unknown: CellUnknown }>;
  /**
   * Kept for back-compat. PREFER `gitSync` — this single word cannot answer the
   * question callers actually have: `'synced'` is reachable with nothing pushed.
   */
  gitSyncLastStatus: string | null;
  /**
   * P-002 (EI-18753105351266788): the commit leg and the push leg are SEPARATE,
   * and `lastStatus` collapses them. run-git-sync already computes per-repo
   * pushed/merged/conflict/error detail and the snapshot already carries it — it
   * was simply dropped here, leaving agents to infer "reached origin" from a word
   * that does not mean that. EI-18750935999066024 is the cost: origin/staging
   * frozen 2h52m with 19 stranded commits, read as "not yet".
   */
  gitSync: GitSyncLegs;
  /**
   * EI-10895: which process actually RUNS this path, and therefore whether the
   * staging→main→:3070 pipeline is its activation path at all. `null` for a
   * sha-only probe (no path to classify). This is `runtimes[0]` — kept for
   * back-compat; a dual-consumer path (WI-5440) is fully described only in
   * `runtimes`, never in this single field.
   */
  runtime: RuntimeOwnership | null;
  /**
   * WI-5440: ALL processes that run this path (usually 1). When this has more
   * than one entry, the path has genuinely distinct consumers on different
   * activation routes — a single `runtime`/`activation` answer would be
   * WRONG for at least one of them. `null` for a sha-only probe.
   */
  runtimes: RuntimeOwnership[] | null;
  /**
   * P-003: whether the process that RUNS this path has actually loaded the code —
   * process truth, deliberately not derived from git. `deployed` answers a
   * different question and must never be read as "live".
   */
  serving: ServingTruth;
  /**
   * EVERY long-lived host's generation for this path, not just the one the
   * ownership map happens to name.
   *
   * `serving` answers for `runtimes[0]` alone. That is the right answer for a
   * single-owner path and a silently INCOMPLETE one otherwise — and "otherwise"
   * includes every operator-core module a bg-host routine imports transitively,
   * because the ownership map keys on path patterns and cannot see the import
   * graph. This leg probes all hosts unconditionally, so a host that is running
   * (or not running) your code can never go unreported.
   *
   * Read it in BOTH directions. `runningYourCode: false` ⇒ that host needs a
   * restart. `true` while another host is `false` ⇒ your change is ALREADY
   * executing somewhere, and a deploy is not a precondition for observing it.
   */
  runtimeGenerations: RuntimeGeneration[];
  /**
   * acceptance-runtime-plane-not-main-2026-09-23 P-001: every runtime that EXECUTES this
   * path (owners from the runtime map, plus the canonical-tree hosts for shared library
   * code), each with its OWN measured build identity and a three-valued
   * `containsChange`. `positions.deployed` answers only for :3070; this answers "where is
   * my change running right now", which is what acceptance evidence actually needs.
   * Empty for a sha-only probe.
   */
  servingRuntimes: ServingRuntimeEntry[];
  /**
   * P-004: does the commit the GATE is judging actually contain this path's current
   * content? Every other field here answers "where is my change in the pipeline";
   * this one answers the question that comes first and was unanswerable —
   * "is the thing being judged even my code?".
   */
  changeInCandidate: ChangeInCandidate;
  /**
   * P-006: whether the next git-sync tick will sweep this change into a commit, and
   * how much of the tree it takes with it. `changeInCandidate` answers "is the judged
   * commit my code"; this answers the question one step earlier — "what commit is
   * about to be MADE out of my half-finished tree, and can the gate judge it".
   */
  sweepExposure: SweepExposure;
  /**
   * git-pipeline-agent-state-2026-07-26 P-001: per-stage POSITION x HEALTH.
   * Delivery stages are ordered source→live; the `pushed` stage is an explicitly
   * labelled publish side leg for commit-only/bridged members (durability / peer
   * visibility), not a delivery prerequisite. A normal pushing member keeps the
   * historical delivery-plane semantics.
   *
   * `positions` above answers only "is my change past this stage?". A boolean
   * cannot distinguish "not yet, wait" from "this leg is dead, waiting is
   * futile" — and that single missing dimension is behind most filed pipeline
   * confusion (a 2h52m push freeze read as "not yet"; `deployed ✓` read as
   * "live" while the process served older code, filed 4x independently).
   */
  stages: StageState[];
  /**
   * P-005: the DELIVERY stage actually holding this change up — the first pending
   * `plane:'delivery'` stage in source→live order — or `null` when delivery is live.
   * A pending/broken `plane:'publish'` stage remains serious, but never populates this field.
   */
  blockedOn: StageName | null;
  /**
   * P-005: the ONE thing to do about it, or `null` when waiting is the honest answer.
   *
   * Read WITH `blockedOn`: null/null means live; a stage with a null action means the leg
   * is healthy and will advance on its own. See deriveBlocker for why those three states
   * must stay distinct.
   */
  nextAction: string | null;
  /** One human-readable line. */
  summary: string;
  notes: string[];
}

/**
 * P-002: git-sync's two legs, reported separately. `status` is the raw routine word
 * kept for continuity; every other field is what actually answers "did my work
 * reach origin, and is that leg even alive?".
 */
export interface GitSyncLegs {
  status: string | null;
  /** When the last tick completed, and how long ago — the liveness of the leg itself. */
  lastSyncedAtMs: number | null;
  syncAgeMs: number | null;
  /** >0 means the routine is FAULTING, not merely idle. */
  consecutiveErrorTicks: number;
  /** Dirty paths whose live edit locks deferred their entire repo commit group. */
  skippedPaths: GitSyncSkippedPath[];
  /**
   * Repos the last tick actually PUSHED. Empty with status 'synced' is the trap —
   * BUT only when this member is supposed to push at all. Read `pushMode` first:
   * on a commit-only member an empty list is the CORRECT, designed result.
   */
  pushedRepos: string[];
  mergedRepos: string[];
  conflicts: string[];
  errors: string[];
  /**
   * EI-18812945811758018 — the member's EFFECTIVE push mode: `'push'`, or
   * `'commit-only:<reason>'` (reason = the hive git mode `bridged`/`p2p-only`, or
   * `config`). `null` = UNKNOWN (a routine row written before git-sync recorded it).
   *
   * This exists because an empty `pushedRepos` means OPPOSITE things in the two cases,
   * and without the mode a reader cannot tell them apart: on a bridged hive git-sync is
   * commit-only by design and the GitHub bridge is the sole origin pusher, so "nothing
   * pushed" is healthy and `git-sync:run` can never change it.
   */
  pushMode: string | null;
  /**
   * EI-19341723994516667: the p2p own-head-publish leg's self-report, from the SAME
   * git-sync routine row (`metadata.own_head_publish`) — the mechanism that actually
   * advances origin on a commit-only (bridged) member. See `origin-freshness.ts` for
   * the full model; this is the same signal, read for the `pushed` stage's message
   * rather than the standalone watchdog.
   *
   * Optional/nullable throughout: pre-WI-5738 routine rows never wrote this key, and
   * a NON-bridged (legacy, pushing) member never will — absence must read as
   * "unmeasured", never as "healthy" or "faulted".
   */
  ownHeadPublish?: {
    /** A refusal CODE (e.g. 'secrets', 'total-over-cap'), or null when not refusing. */
    refused: string | null;
    /** true = admitted but still not caught up (WI-6996); false = fully drained; null = unknown. */
    backlogRemains: boolean | null;
    /** What actually became servable (the last publish CAS-wrote). */
    publishedSha: string | null;
    /** The worktree head this leg judged on its last tick. */
    sha: string | null;
  } | null;
}

/**
 * True when this member does not push to origin at all, by design — so an empty
 * `pushedRepos` / a lagging origin is NOT evidence of a fault, and no forced sync
 * can help. `null` (unknown, pre-record rows) is deliberately NOT treated as
 * commit-only: absent evidence must not silently suppress a real push fault.
 */
export function isCommitOnlyMember(legs: Pick<GitSyncLegs, 'pushMode'>): boolean {
  return typeof legs.pushMode === 'string' && legs.pushMode.startsWith('commit-only');
}

/**
 * git-sync ticks roughly every 10 min, so a tick age past ~2.5 intervals means the
 * routine is not merely between ticks — it has stopped advancing. Used only to
 * classify HEALTH; never to claim a position.
 */
export const GIT_SYNC_STALE_AFTER_MS = 25 * 60_000;

/**
 * P-003: process truth for the SERVING stage.
 *
 * `deployed` is a GIT fact — "the release checkout's HEAD is at my sha". It says
 * nothing about whether the long-lived process that answers requests has ever
 * LOADED that code. Four agents filed that gap independently
 * (EI-18740960754854672, EI-18741985436324043, EI-18741004371760803,
 * EI-18746827803289687), which makes it a missing state surface rather than four
 * careless readings.
 *
 * TWO evidence sources answer it, and `evidence` says which one did:
 *
 *  - `health-sha` (WI-2141731, PREFERRED) — the serving process's OWN
 *    `/api/health` sha, compared against the deployed sha. This is an
 *    OBSERVATION of the process rather than a comparison of two fragile
 *    timestamps, and it needs no path, so a sha-only probe can use it.
 *  - `start-time` (the fallback) — "did this process start AFTER the code it
 *    runs last changed?". Used verbatim whenever health does not answer.
 *
 * WHY the health sha is trustworthy, since it is NOT free of the caveat this
 * comment used to state absolutely ("the checkout can advance under a process
 * that already imported the old modules"): `getBuildInfo()` prefers the
 * deploy-set `PAPERCUSP_BUILD_SHA`, then a bundle's baked sha, and only then
 * falls back to `git rev-parse HEAD` of the running checkout — a read that is
 * NOT by itself a loaded-code identity. What makes the fallback sound is WHEN
 * it runs: `apps/operator/bin/serve.ts` resolves it at MODULE LOAD (EI-9002)
 * and `build-info.ts` caches it for the process's life, so the value is the
 * checkout as of THIS PROCESS'S BOOT, which is exactly the code it imported.
 *
 * That invariant is load-bearing and otherwise unguarded, so it is pinned by a
 * test (`build-info` boot-warm guard): make the resolve lazy-at-request and the
 * sha silently becomes a live checkout read, which on a git-sync-swept tree
 * would report a sha the process is NOT running — failing toward a confident
 * false "live". Hence `evidence`: a caller must always be able to tell an
 * observation from an inference.
 */
export interface ServingTruth {
  /** The long-lived process this verdict describes (the path's primary runtime owner). */
  host: RuntimeHost | null;
  /** Its systemd --user unit. `null` for a host that has none (tauri-desktop is compiled). */
  unit: string | null;
  pid: number | null;
  startedAtMs: number | null;
  /**
   * When the code THIS host loads last changed:
   *  - `deploy`     — a release-checkout host receives code AT DEPLOY TIME, so the
   *                   deploy is the moment its code changed.
   *  - `file-mtime` — a working-tree tsx host imports the file itself, so the file's
   *                   own mtime is what a restart would pick up (committed or not).
   */
  codeAsOfMs: number | null;
  codeAsOfSource: 'deploy' | 'file-mtime' | null;
  /**
   * Did the process start AFTER that moment? `true` = it has actually loaded the
   * code. `false` = it PREDATES the code and is executing an older snapshot.
   * `null` = unknown — never guessed in either direction.
   */
  startedSinceCodeChange: boolean | null;
  /** Minutes the process is behind the code, when it predates it. */
  behindMin: number | null;
  /** The concrete command that makes the code live, when it is not. */
  restartLever: string | null;
  /**
   * EI-19447523039740352: set when a deploy is ALREADY RUNNING and that deploy is
   * what `restartLever` would have triggered — so the lever must NOT be offered.
   *
   * The staleness this stage detects (`startedSinceCodeChange:false`) is the NORMAL
   * mid-deploy state, not an edge case: a deploy lands the files first and restarts
   * the process late, so every healthy deploy passes through a window where the
   * process legitimately predates its code. Offering the restart lever in that
   * window tells the caller to fire a SECOND deploy against the shared release
   * checkout — which `release:deploy` refuses by design, naming that exact collision
   * as the hazard its guard exists to prevent. Reported live: an agent read
   * `nextAction` (documented as "the ONE lever") mid-deploy and was one call away
   * from firing it.
   *
   * `null` therefore means "not known to be superseded", NOT "no deploy is running":
   * an unreadable systemd degrades to null and keeps the lever, because wrongly
   * SUPPRESSING it would strand a caller whose process really is stale with no
   * deploy coming. Only an affirmative in-flight reading suppresses.
   */
  restartSupersededBy: ServingRestartSuperseded | null;
  /**
   * WHICH evidence produced `startedSinceCodeChange` — `health-sha` (the process
   * reported its own build sha) or `start-time` (the timestamp inference).
   * `null` when the verdict is unknown, so nothing was concluded from either.
   *
   * Reported rather than inferred by the caller because the two are NOT equally
   * strong and must not be presented as if they were: `start-time` establishes
   * "it restarted after the code changed", which is a strictly weaker claim than
   * "it is running THIS sha" (a restart that loaded DIFFERENT code than expected
   * satisfies the first and fails the second).
   */
  evidence: 'health-sha' | 'start-time' | null;
  /** The sha the serving process reported for itself, when it answered. */
  reportedSha: string | null;
  /**
   * Why the answer is `null`, when it is — ENUMERATED, never prose (D-038 axis 2
   * corollary). `code` is what a caller branches on (`not-applicable` is a final
   * answer; `resolver-failed` is retry-or-escalate); `detail` carries the human
   * sentence this field used to hold on its own.
   */
  unknownReason: CellUnknown | null;
}

/**
 * Why the serving restart lever is being WITHHELD — something is already doing it.
 * Structured rather than a boolean so the caller can say WHICH deploy and since when,
 * which is what makes "wait" actionable instead of merely quiet.
 */
export interface ServingRestartSuperseded {
  kind: 'deploy-in-flight';
  /** The transient systemd unit currently deploying (e.g. `papercup-auto-deploy`). */
  unit: string;
  /** When that deploy started, when systemd's timestamp parsed; null otherwise. */
  startedAtMs: number | null;
  /** systemd ActiveState — `deactivating` still counts, the :3070 restart happens late. */
  activeState: string | null;
}

/**
 * Which long-lived process actually serves each runtime host. NOT the same as
 * `RuntimeOwnership.restartTarget`: an `operator-release` path's restartTarget is
 * `staging` (the :3170 host you bounce to EXERCISE an edit), while the process
 * SERVING it in production is the :3070 release operator. Conflating the two
 * would probe the wrong process and report a confident wrong answer.
 */
const SERVING_UNIT_BY_HOST: Record<RuntimeHost, string | null> = {
  'operator-release': RESTART_TARGET_UNITS.dev,
  gateway: RESTART_TARGET_UNITS.gateway,
  'bg-host': RESTART_TARGET_UNITS['bg-host'],
  'embed-sidecar': RESTART_TARGET_UNITS['embed-sidecar'],
  // Compiled into the desktop binary — no unit serves it, so no process probe can answer.
  'tauri-desktop': null,
  // One process per psu session, each loaded at its own launch — there is no single unit;
  // `servingRuntimes` answers it with per-session instance counts instead.
  'psu-pty-host': null,
};

/** The lever that makes code live for each host, given its restart target. */
function servingRestartLever(rt: RuntimeOwnership): string | null {
  if (rt.host === 'tauri-desktop') {
    return 'Rebuild the desktop shell: cd papercusp-desktop && npm run dev';
  }
  if (rt.host === 'operator-release') {
    // The :3070 host loads the RELEASE checkout, so the lever is a real deploy
    // (which restarts it) — a bare restart would only re-load the same old checkout.
    return 'PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute';
  }
  return rt.restartTarget
    ? `dev:restart { target: "${rt.restartTarget}", confirm: true, authorize: true, reason: "<why>" }`
    : null;
}

/** A standalone CLI that reads the working tree at invocation time has no serving daemon
 * to probe or restart. `tauri-desktop` also has no restart target, but it is compiled rather
 * than fresh-invoked and therefore keeps its separate not-applicable branch below. */
function isFreshInvocationRuntime(rt: RuntimeOwnership): boolean {
  return !rt.releasePipelineApplies && rt.restartTarget === null && rt.host !== 'tauri-desktop';
}

/**
 * PURE verdict for the serving stage — no probing, so it is directly testable.
 * Unknown inputs produce `startedSinceCodeChange: null` with a REASON, never a
 * fabricated true/false: a wrong "yes, it's live" here is exactly the failure
 * this surface exists to remove.
 */
export function evaluateServing(args: {
  runtime: RuntimeOwnership | null;
  process: { pid: number | null; startedAtMs: number | null } | null;
  codeAsOfMs: number | null;
  codeAsOfSource: 'deploy' | 'file-mtime' | null;
  /**
   * EI-19447523039740352: whether a deploy is running RIGHT NOW. Optional so every
   * existing caller keeps today's behaviour; omitted/null is read as UNKNOWN, which
   * keeps the lever rather than hiding it.
   */
  deployInFlight?: {
    active: boolean;
    unit: string;
    activeState: string | null;
    startedAtMs: number | null;
    source: 'systemd' | 'systemd-unavailable';
  } | null;
  /**
   * WI-2141731: the serving process's OWN reported build sha, already fetched by
   * the caller. A PURE INPUT on purpose — this function is documented as doing no
   * probing, and it is the only directly-testable part of the stage, so the fetch
   * stays in the impure resolver and only its RESULT arrives here.
   *
   * `null` (did not answer / not probed) falls through to the start-time
   * inference completely unchanged, which is what keeps this strictly additive.
   */
  servingHealthSha?: string | null;
  /** The sha believed deployed, to compare `servingHealthSha` against. */
  deployedSha?: string | null;
}): ServingTruth {
  const { runtime, process: proc, codeAsOfMs, codeAsOfSource, deployInFlight } = args;
  const host = runtime?.host ?? null;
  const freshInvocation = runtime ? isFreshInvocationRuntime(runtime) : false;
  const unit = host && !freshInvocation ? SERVING_UNIT_BY_HOST[host] : null;
  const restartLever = runtime ? servingRestartLever(runtime) : null;
  const base: ServingTruth = {
    host,
    unit,
    pid: proc?.pid ?? null,
    startedAtMs: proc?.startedAtMs ?? null,
    codeAsOfMs,
    codeAsOfSource,
    startedSinceCodeChange: null,
    behindMin: null,
    evidence: null,
    reportedSha: null,
    restartLever,
    // Scoped to `operator-release` ON PURPOSE. That host's lever IS a deploy
    // (servingRestartLever returns deploy-cli for it), so a running deploy really
    // does supersede it. Every other host restarts via `dev:restart` — a deploy
    // performs no such restart, so a stale gateway/bg-host is NOT superseded by one
    // and must keep its lever. Suppressing there would be the mirror-image bug:
    // telling a caller to wait for something that is never going to happen.
    //
    // `source` is checked because `active:false` from an unreadable systemd means
    // UNKNOWN, not idle (see readDeployInFlight) — and only an AFFIRMATIVE active
    // reading may withhold a lever.
    restartSupersededBy:
      host === 'operator-release' && deployInFlight?.active === true && deployInFlight.source === 'systemd'
        ? {
            kind: 'deploy-in-flight',
            unit: deployInFlight.unit,
            startedAtMs: deployInFlight.startedAtMs,
            activeState: deployInFlight.activeState,
          }
        : null,
    unknownReason: null,
  };

  // WI-2141731 — DIRECT EVIDENCE FIRST, and deliberately ABOVE the `!runtime`
  // return: the whole point of the health sha is that it needs no path, so this
  // is what makes a sha-only probe answerable instead of permanently
  // not-applicable (the retry-forever loop WI-2141716 fixed the verdict for).
  //
  // Strictly additive: it only fires when the process actually answered AND we
  // have a deployed sha to compare against. Every other case falls through to
  // the untouched inference below.
  const reportedSha = normalizeSha(args.servingHealthSha);
  const deployedShaForCompare = normalizeSha(args.deployedSha);
  // `executing === null` means the two could not be compared at all, which is
  // NOT a verdict — fall through to the inference rather than publish one.
  const executing =
    reportedSha && deployedShaForCompare ? compareShas(reportedSha, deployedShaForCompare) : null;
  if (executing !== null) {
    return {
      ...base,
      startedSinceCodeChange: executing,
      // NOT derivable from two shas — it is a duration, and the whole point here
      // is that we did not use timestamps. Null is the honest answer; a caller
      // that needs "how far behind" must fall back to the inference.
      behindMin: null,
      evidence: 'health-sha',
      reportedSha,
      unknownReason: null,
    };
  }

  if (!runtime) {
    return {
      ...base,
      unknownReason: cellUnknown(
        'not-applicable',
        'No path was given (sha-only probe), and the serving process did not report its own sha, so no serving process can be identified.',
      ),
    };
  }
  if (freshInvocation) {
    return {
      ...base,
      // "Live" for this route means the next invocation will execute the current source.
      // There is deliberately no persistent pid/start time and no restart lever to wait on.
      pid: null,
      startedAtMs: null,
      startedSinceCodeChange: true,
      unknownReason: null,
    };
  }
  if (!unit) {
    return {
      ...base,
      // BOTH branches are `not-applicable`, not `resolver-failed`: nothing was
      // attempted and failed here — there is structurally no process to ask
      // about, so no retry can ever turn this into an answer.
      unknownReason: cellUnknown(
        'not-applicable',
        host === 'tauri-desktop'
          ? 'This code is COMPILED into the desktop binary — no server process serves it, so "is it running?" is answered by rebuilding the shell, not by a process probe.'
          : 'No systemd unit is known for this host.',
      ),
    };
  }
  // Number.isFinite, not `=== null`: these two timestamps come from a subprocess
  // parse and from free-form deploy state respectively, so `undefined` and `NaN`
  // are both reachable — and BOTH slip past a null check. An arithmetic comparison
  // against one then yields `false` (reading as the confident "it is stale!") and a
  // `NaN` minute count in the message. A diagnostic surface must degrade to an
  // honest UNKNOWN, never to a confident wrong verdict rendered with "NaNm".
  const startedAtMs = Number.isFinite(base.startedAtMs as number) ? (base.startedAtMs as number) : null;
  const codeMs = Number.isFinite(codeAsOfMs as number) ? (codeAsOfMs as number) : null;
  if (startedAtMs === null) {
    return {
      ...base,
      // The probe RAN and came back empty — a later read may well succeed, so
      // the caller's lever is retry-or-escalate, not "stop asking".
      unknownReason: cellUnknown(
        'resolver-failed',
        `Could not read ${unit}'s start time (not running, no systemd, or a non-Linux host) — serving state is UNKNOWN, which is not the same as "live".`,
      ),
    };
  }
  if (codeMs === null) {
    return {
      ...base,
      // Distinct from the case above: ONE of the two operands read fine. More
      // INPUT is the lever, which is a different response from retrying a probe
      // that failed outright — exactly the branch prose could not express.
      unknownReason: cellUnknown(
        'insufficient-data',
        `Read ${unit} (pid ${base.pid}) but not when its code last changed, so the two cannot be compared — serving state is UNKNOWN, not "live".`,
      ),
    };
  }

  const startedSinceCodeChange = startedAtMs > codeMs;
  return {
    ...base,
    startedSinceCodeChange,
    behindMin: startedSinceCodeChange ? null : Math.max(1, Math.round((codeMs - startedAtMs) / 60_000)),
    evidence: 'start-time',
  };
}

/** Trimmed, lower-cased sha, or null for anything that is not usable as one. */
function normalizeSha(raw: string | null | undefined): string | null {
  const s = raw?.trim().toLowerCase();
  return s && /^[0-9a-f]+$/.test(s) ? s : null;
}

/**
 * Do the two shas identify the same commit? `null` means CANNOT COMPARE.
 *
 * A prefix compare, because the two are legitimately different LENGTHS: the
 * health endpoint reports `git rev-parse --short HEAD` (10 chars here) while the
 * deployed sha is the full 40. Comparing them with `===` would report a MISMATCH
 * for every healthy deploy — a confident false "restart required".
 *
 * The three-valued return is the load-bearing part, and a two-valued one was
 * WRONG here in a way a test caught: a prefix too short to be unique is not
 * evidence of a MISMATCH, it is the absence of evidence. Returning `false` for it
 * published a confident "stale, restart required" built on a comparison that was
 * never valid; `null` falls through to the start-time inference instead. The
 * 7-char floor is where a prefix stops colliding with unrelated commits by
 * coincidence.
 */
function compareShas(a: string, b: string): boolean | null {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 7) return null;
  return longer.startsWith(shorter);
}

/**
 * One long-lived host's CODE GENERATION for the queried path: did this process
 * start AFTER the code it would run last changed?
 *
 * Deliberately NOT derived from `RUNTIME_OWNERS`. That map is a hand-maintained
 * list of path patterns, i.e. an approximation of the IMPORT GRAPH, and it fails
 * in the confident direction: an unlisted path silently falls to `DEFAULT_OWNER`
 * (`operator-release` only) and is reported with authoritative prose rather than
 * as unknown. Every operator-core module a bg-host routine reaches TRANSITIVELY
 * is misclassified that way unless somebody hand-added it — `lib/dbos/` is
 * listed, but the modules it imports are not.
 *
 * So this leg probes every long-lived host UNCONDITIONALLY and reports each one's
 * own verdict. It cannot inherit the ownership map's blind spot because it does
 * not consult it.
 */
export interface RuntimeGeneration {
  /** systemd --user unit. */
  unit: string;
  /** Human label for the process ("bg-host (routines/sweeps)"). */
  label: string;
  pid: number | null;
  startedAtMs: number | null;
  /** When the code THIS host would run last changed. */
  codeAsOfMs: number | null;
  /**
   * Which clock `codeAsOfMs` came from — they are not interchangeable.
   * `deploy` for the release checkout (:3070 receives code at deploy time);
   * `file-mtime` for a staging-tree tsx host (it imports the file itself, so
   * the file's own mtime is what a restart would pick up).
   */
  codeAsOfSource: 'deploy' | 'file-mtime' | null;
  /**
   * TRUE  — this process started after the code last changed ⇒ it IS running it.
   * FALSE — it started before ⇒ it is running an older generation.
   * NULL  — undecidable; never fabricated (see evaluateServing's note).
   */
  runningYourCode: boolean | null;
  /** Minutes the process start precedes the code change, when it is behind. */
  behindMin: number | null;
  /**
   * The identity THIS exact process reported after boot. This is joined by
   * local host + pid + report-after-process-start, never inferred from the
   * checkout or from a systemd unit name (both can describe code the process
   * has not loaded yet).
   */
  loadedIdentity: RuntimeLoadedIdentity | null;
  /** Why `loadedIdentity` is absent. Null iff an identity is present. */
  loadedIdentityUnknown: CellUnknown | null;
  /** How this host's code becomes current. */
  activationLever: string;
  unknownReason: CellUnknown | null;
}

export interface RuntimeLoadedIdentity {
  source: 'runtime-vintage';
  unit: string;
  host: string;
  treeSha: string | null;
  bundleVersion: string | null;
  buildTime: string | null;
  reportedAt: string;
}

/**
 * The long-lived hosts that execute repo code, and how each RECEIVES it.
 *
 * `papercup-staging-api` is here even though it is not a `RuntimeHost` — it is a
 * real process running the staging working tree, and it is one of the two hosts
 * that can be running a fix while `:3070` still is not.
 */
const GENERATION_HOSTS: ReadonlyArray<{
  unit: string;
  label: string;
  releasePipelineApplies: boolean;
  activationLever: string;
}> = [
  {
    unit: RESTART_TARGET_UNITS.dev,
    label: ':3070 release operator',
    releasePipelineApplies: true,
    activationLever:
      'the green pipeline (git-sync → green main → deploy), or PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute to force it now',
  },
  {
    unit: RESTART_TARGET_UNITS.staging,
    label: ':3170 staging operator',
    releasePipelineApplies: false,
    activationLever: 'dev:restart { target: "staging", confirm: true } — a deploy is a no-op for this host',
  },
  {
    unit: RESTART_TARGET_UNITS['bg-host'],
    label: 'bg-host (routines, sweeps, watchdogs)',
    releasePipelineApplies: false,
    activationLever: 'dev:restart { target: "bg-host", confirm: true } — a deploy is a no-op for this host',
  },
];

/**
 * PURE verdict for the runtime-generation leg — no probing, so it is directly
 * testable. Same contract as `evaluateServing`: an undecidable input yields
 * `runningYourCode: null` WITH a reason, never a fabricated boolean.
 */
export function evaluateRuntimeGenerations(
  probes: ReadonlyArray<{
    unit: string;
    label: string;
    releasePipelineApplies: boolean;
    activationLever: string;
    process: { pid: number | null; startedAtMs: number | null } | null;
    codeAsOfMs: number | null;
    /**
     * RELEASE-PIPELINE HOSTS ONLY: does the release checkout's copy of this file
     * DIFFER from the working tree? Ignored for staging-tree hosts, which import
     * the working-tree file itself so content identity is trivially satisfied.
     *
     * Without this the release host's verdict is a confident answer to the WRONG
     * question. `startedAtMs > deployedAtMs` establishes only "this process
     * restarted since its last deploy" — it says nothing about WHICH version got
     * deployed. Caught by live exercise (WI-9974): on the very path that motivated
     * this leg, :3070 reported `runningYourCode: true` while its checkout provably
     * lacked the change (0 occurrences of the new symbol). A true that means
     * something other than what it says is worse than the gap this leg closes.
     */
    contentDiffers?: boolean | null;
  }>,
): RuntimeGeneration[] {
  return probes.map((p) => {
    const codeAsOfSource: 'deploy' | 'file-mtime' | null =
      p.codeAsOfMs === null ? null : p.releasePipelineApplies ? 'deploy' : 'file-mtime';
    const base: RuntimeGeneration = {
      unit: p.unit,
      label: p.label,
      pid: p.process?.pid ?? null,
      startedAtMs: p.process?.startedAtMs ?? null,
      codeAsOfMs: p.codeAsOfMs,
      codeAsOfSource,
      runningYourCode: null,
      behindMin: null,
      loadedIdentity: null,
      loadedIdentityUnknown: cellUnknown(
        'insufficient-data',
        `No boot-reported build/content identity was joined for ${p.unit}.`,
      ),
      activationLever: withRestartAuthorization(p.activationLever),
      unknownReason: null,
    };
    // Content identity is checked FIRST for a release host, because it can settle
    // the answer on its own: a deployed copy that differs from your tree is not
    // your code no matter how recently the process restarted.
    if (p.releasePipelineApplies) {
      if (p.contentDiffers === true) {
        return {
          ...base,
          runningYourCode: false,
          unknownReason: null,
        };
      }
      if (p.contentDiffers !== false) {
        return {
          ...base,
          unknownReason: cellUnknown(
            'insufficient-data',
            `Could not compare ${p.unit}'s deployed copy of this file against the working tree, so whether it runs YOUR version is UNKNOWN. Process start vs deploy time cannot answer it alone — that only shows the process restarted since some deploy, not which content that deploy carried.`,
          ),
        };
      }
    }
    if (base.startedAtMs === null) {
      return {
        ...base,
        unknownReason: cellUnknown(
          'insufficient-data',
          `Could not read ${p.unit}'s start time (not running, no systemd, or a non-Linux host) — this host's generation is UNKNOWN, which is NOT the same as "stale" or as "current".`,
        ),
      };
    }
    if (base.codeAsOfMs === null) {
      return {
        ...base,
        unknownReason: cellUnknown(
          'insufficient-data',
          `Read ${p.unit} (pid ${base.pid}) but not when the code it runs last changed, so the two cannot be compared — UNKNOWN, not "current".`,
        ),
      };
    }
    const runningYourCode = base.startedAtMs > base.codeAsOfMs;
    return {
      ...base,
      runningYourCode,
      behindMin: runningYourCode ? null : Math.max(1, Math.round((base.codeAsOfMs - base.startedAtMs) / 60_000)),
    };
  });
}

/**
 * Join the process-time verdict to the existing boot-time runtime-vintage
 * ledger. A pid alone is insufficient because remote hosts can reuse it, and a
 * stale row can survive until a later process reuses the same pid. Requiring the
 * local host AND a report at/after this process start makes the receipt about
 * the currently loaded process rather than a similarly named runtime.
 */
export function attachRuntimeLoadedIdentities(
  generations: ReadonlyArray<RuntimeGeneration>,
  rows: ReadonlyArray<RuntimeVintageRow>,
  localHost: string,
): RuntimeGeneration[] {
  return generations.map((generation) => {
    if (generation.pid === null || generation.startedAtMs === null) {
      return {
        ...generation,
        loadedIdentity: null,
        loadedIdentityUnknown: cellUnknown(
          'insufficient-data',
          `Cannot join ${generation.unit}'s boot identity without its current pid and process start time.`,
        ),
      };
    }
    const row = rows.find((candidate) => {
      const reportedAtMs = Date.parse(candidate.reportedAt);
      return (
        candidate.host === localHost &&
        candidate.pid === generation.pid &&
        Number.isFinite(reportedAtMs) &&
        reportedAtMs >= generation.startedAtMs!
      );
    });
    if (!row) {
      return {
        ...generation,
        loadedIdentity: null,
        loadedIdentityUnknown: cellUnknown(
          'insufficient-data',
          `No current runtime-vintage row matches ${generation.unit} pid ${generation.pid} on ${localHost}; the process has not reported a verifiable loaded identity.`,
        ),
      };
    }
    if (!row.treeSha && !row.bundleVersion) {
      return {
        ...generation,
        loadedIdentity: null,
        loadedIdentityUnknown: cellUnknown(
          'insufficient-data',
          `Runtime-vintage matched ${generation.unit} pid ${generation.pid}, but reported neither treeSha nor bundleVersion.`,
        ),
      };
    }
    return {
      ...generation,
      loadedIdentity: {
        source: 'runtime-vintage',
        unit: row.unit,
        host: row.host,
        treeSha: row.treeSha,
        bundleVersion: row.bundleVersion,
        buildTime: row.buildTime,
        reportedAt: row.reportedAt,
      },
      loadedIdentityUnknown: null,
    };
  });
}

/**
 * The note this whole leg exists to emit: hosts DISAGREE about which generation
 * of your code they run.
 *
 * The recurring, expensive misreading is one-directional. `deploy.3070.sha` has
 * not moved ⇒ "my change is not live anywhere" ⇒ wait for a deploy. But the
 * staging-tree hosts restart on their own schedule, well ahead of the release
 * deploy, so a fix is routinely ALREADY EXECUTING in bg-host/staging while
 * `:3070` still runs the old generation. An agent that only needs to OBSERVE the
 * code running (measure it, reproduce a bug, confirm a watchdog stopped firing)
 * is not blocked at all — and that is invisible from every git-shaped check.
 *
 * Returns null when the hosts agree (nothing to say) or when too few of them
 * could be decided to claim a disagreement.
 */
export function runtimeGenerationDivergenceNote(
  gens: ReadonlyArray<RuntimeGeneration>,
  relPath: string | null,
): string | null {
  const decided = gens.filter((g) => g.runningYourCode !== null);
  if (decided.length < 2) return null;
  const current = decided.filter((g) => g.runningYourCode === true);
  const behind = decided.filter((g) => g.runningYourCode === false);
  if (current.length === 0 || behind.length === 0) return null;
  const where = relPath ? ` for ${relPath}` : '';
  return (
    `RUNTIME GENERATIONS DIVERGE${where}: ` +
    `${current.map((g) => `${g.unit} (${g.label})`).join(' + ')} ALREADY run this code as it stands — each started after it last changed. ` +
    // `behindMin` is null when the host is behind for a reason that is not restart
    // LAG — a release checkout serving different content is out of date by content,
    // not by minutes, and "~nullm behind" is how that leaked into the prose.
    `${behind
      .map(
        (g) =>
          `${g.unit} (${g.label}, ${g.behindMin === null ? 'serving DIFFERENT content' : `~${g.behindMin}m behind`})`,
      )
      .join(' + ')} do NOT. ` +
    `If you only need to OBSERVE this code running — measure it, reproduce against it, confirm a routine's behaviour changed — it is ALREADY LIVE on the hosts listed first and you are NOT blocked on a deploy. ` +
    `A deploy is required only to activate it on the release checkout. ` +
    `Do not read an unmoved deploy sha as "my change is not running anywhere".`
  );
}

/**
 * P-004 (EI-18752644493166307): whether the commit the GATE judges contains this
 * path's current content.
 *
 * The gate checks out a COMMITTED candidate into an isolated tree — it cannot see
 * the working tree, and the quiet-cut routinely steps the candidate BACK from the
 * tip. So "is my change committed / pushed" (which `positions` answers) does not
 * imply "the run about to red is testing my code".
 *
 * When it isn't, the verdict is actively misleading rather than merely useless: the
 * suite reds on the PRE-FIX failure with the PRE-FIX count, which reads as *your fix
 * did not work* instead of *your fix was not present*, and sends the caller off to
 * re-debug correct code. That misread — not the wasted run — is what this measures
 * away.
 *
 * TWO candidates, because they answer different questions:
 *  - `judgingSha`       the run that is ALREADY IN FLIGHT. Its verdict is the one
 *                       about to land, so this is what to read a red against.
 *  - `nextCandidateSha` what a `release:checkpoint-run` fired RIGHT NOW would judge
 *                       (post quiet-cut). This is what to check BEFORE firing.
 * Both are `null` when no run is active / nothing could be resolved, and every
 * `contains` verdict is three-valued — an unresolvable read is `null` (unknown),
 * never `false` (and never a silent `true`).
 */
export interface ChangeInCandidate {
  /**
   * The commit an in-flight gate run is judging, if one is active.
   *
   * ⚠ EI-19311755730915969 — NOT A LIVENESS SIGNAL. This answers WHICH commit, not
   * WHETHER a run is alive: the "if one is active" half is a convention applied by one
   * production resolver, unenforced by this type and by the pure evaluator, so a value
   * that outlives the run it described reads exactly like a live one. Branching on its
   * non-nullness to mean "a verdict is coming, so wait" reported `nextAction: null` on a
   * gate that had been red for ~6.7h holding main for the whole fleet. For run liveness
   * use `gate.checkpointRunInFlight.active`, which is measured and has an explicit
   * UNKNOWN state.
   */
  judgingSha: string | null;
  /**
   * WI-36259 — WHERE `judgingSha` came from, because the two sources have very different
   * trust. Mirrors `checkpointRunInFlight.candidateSource`, whose doc comment explains the
   * distinction at length; this is the SAME provenance, carried onto the field the
   * `gate.greenCheckpoint.candidate` cell actually serves.
   *
   *  - `'retriage-marker'` — the run's OWN published `inFlightRetriage` marker. An
   *    authoritative observation of what this run is judging.
   *  - `'run-probe'` — derived by probing the run (`checkActiveCheckpointRun`). On a MANUAL
   *    run that is its `/tmp` unit log (an observation); on a CRON run the probe falls back
   *    to the checkpoint checkout's live HEAD, which is an INFERENCE.
   *  - absent — there is no judged sha to attribute (`judgingSha` is null).
   *
   * ⚠ Until WI-36259 this field did not exist AND `judgingSha` was marker-BLIND: it took
   * `checkActiveCheckpointRun`'s probe value unconditionally, while the marker sat loaded
   * one field away and was passed only to `checkpointRunInFlight`. So during a re-triage
   * window — exactly when the candidate matters most — this field and
   * `checkpointRunInFlight.candidate` named DIFFERENT shas for the same subject, and this
   * one named the ABANDONED candidate. CLAUDE.md meanwhile told agents the cell's sha was
   * "already marker-preferred per WI-7035"; WI-7035 only ever fixed `checkpointRunInFlight`.
   */
  judgingShaSource?: JudgingShaSource;
  /**
   * Does that candidate carry this path's WORKING-TREE content? null = not comparable.
   * Omitted when `judgingShaSource === 'run-probe'`: the checkout-head inference can change
   * between reads and cannot support a containment verdict about the run.
   *
   * EI-20429780229915918 — this is a verdict about THE PATH THE CALLER PASSED, never about
   * "the caller's change". The two coincide only when that path is one they edited. Against
   * a fixed probe path (the natural choice for a monitoring loop that wants comparable
   * readings across wakes) it is `true` on nearly every read while carrying no information
   * about the fix at all. For "is MY change in the candidate", the instrument is
   * `markerJudging` — see its doc-comment below.
   */
  judgingContainsPath?: boolean | null;
  /**
   * P-022 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #3): does the
   * frozen queue's ADMISSION LEDGER carry this path on the judged lineage? `true` = an
   * admission named it (changed or unchanged-identical); `false` = a queue is frozen and no
   * admission names it — the lever is `release:repair-queue { op:'admit', paths:[…] }`;
   * `null` / absent = no frozen queue, so an ordinary commit IS the judged lineage and the
   * question does not arise. Sits beside `judgingContainsPath`, which compares BLOBS: the
   * two disagree exactly when a later edit (yours or a peer's) moved staging's content
   * after the admission, and that disagreement is the diagnosis.
   */
  admittedToLineage?: boolean | null;
  /** The commit a checkpoint fired right now would judge (post quiet-cut). */
  nextCandidateSha: string | null;
  nextContainsPath: boolean | null;
  /** When a verdict is false: which lever fixes it (uncommitted / newer-commit / absent). */
  missingReason: MissingReason | null;
  /**
   * P-011 (main-green-status-visible-2026-09-03) — set when the path lives inside a
   * SUBMODULE: which one, the path relative to it, and the submodule commit each candidate
   * PINS (its gitlink). The verdicts above were computed INSIDE that submodule against the
   * pinned commit — the superproject stores only the gitlink, so a superproject blob read
   * is ABSENT for every submodule path and used to leave this cell `not-applicable`, i.e.
   * the five-command hand recipe in CLAUDE.md. A `false` with `missingReason:'newer-commit'`
   * here means the SUPERPROJECT gitlink bump is what the candidate lacks. A null pin = the
   * gitlink could not be read, or the candidate predates the submodule.
   */
  submodule: { path: string; relPath: string; judgingPin: string | null; nextPin: string | null } | null;
  /**
   * EI-18797292094433710 — containment of a caller-supplied MARKER, when one was given.
   *
   * `judgingContainsPath` compares the file's CURRENT content, so it answers "does the
   * candidate carry exactly what I have?" and not "is MY change in it". These diverge
   * whenever a peer commits to the same file after you, and on this tree that is the
   * common case rather than the exotic one. The marker settles it: a distinctive string
   * from the caller's own change either IS or IS NOT in the judged commit, whatever else
   * moved. When present, this OUTRANKS the blob-identity verdict for deciding whether a
   * re-fire is warranted — see `evaluateChangeInCandidate`.
   */
  markerJudging: MarkerContainment | null;
  markerNext: MarkerContainment | null;
  /** One line: what these verdicts mean, and the concrete next move. */
  detail: string | null;
}

/** Nothing measurable — a sha-only probe, or an unresolved candidate. (A submodule path IS
 *  measured since P-011: the classifier resolves the gitlink and compares inside the sub.) */
const NO_CHANGE_IN_CANDIDATE: ChangeInCandidate = {
  judgingSha: null,
  judgingContainsPath: null,
  nextCandidateSha: null,
  nextContainsPath: null,
  missingReason: null,
  submodule: null,
  markerJudging: null,
  markerNext: null,
  detail: null,
};

/**
 * EI-19325709344484737 — is the marker only PARTIALLY present in `judged`?
 *
 * `present` is a substring test, so it answers "does this string appear", not "is my
 * change here". Those diverge for any marker that is not unique to the edit: a generic
 * identifier already in the file makes a pre-fix candidate read as carrying the change.
 *
 * The counts are already computed on both sides, and a judged count strictly BELOW the
 * tip count is positive proof the judged tree lacks occurrences the change added. That
 * is a definitive NEGATIVE (it can only under-claim: a change that adds no new
 * occurrence of the marker is simply not detected, which is the pre-existing behaviour).
 *
 * Returns false whenever either side is unmeasured — never invent a partial verdict from
 * a missing count.
 */
export function markerPartialAgainst(
  judged: MarkerContainment | null | undefined,
  tip: MarkerContainment | null | undefined,
): boolean {
  if (!judged || !tip) return false;
  if (judged.present !== true || tip.present !== true) return false;
  if (typeof judged.count !== 'number' || typeof tip.count !== 'number') return false;
  return judged.count < tip.count;
}

/**
 * WI-41208. Does `atRef` show a STRICT net change in marker occurrences against
 * `baseline` — i.e. positive evidence that the caller's own change reached that ref?
 *
 * Extracted as a pure predicate for one reason: it is the boolean that decides whether
 * a `false` position leg is CORRECTED to `true`, and correcting it wrongly reports
 * unshipped work as live. A guard that decides that must be directly falsifiable, and
 * the marker legs it feeds are reachable only through a full `gitPipelinePosition` run.
 *
 * BOTH sides must be counts taken from a tree that actually HAS the file.
 * `markerAtCommit` returns a DEFINITIVE `{ present:false, count:0, pathPresent:false }`
 * when `ls-tree` is empty — the ref has no such path at all. That legitimate zero is not
 * a measurement of the change's occurrences, and admitting it made `0 < baseline` read as
 * a "strict net-decrease": a brand-new file, absent from `origin/staging` and
 * `origin/main`, had `onStaging`/`inMain`/`deployed` all corrected to true, with
 * `blockedOn`/`nextAction` going null and the position rendering `live`.
 *
 * Like `markerPartialAgainst`, this can only ever UNDER-claim: a change that adds or
 * removes no occurrence of the marker is simply not detected, which is the pre-existing
 * behaviour and is safe. Returns null whenever either side is unmeasured or path-absent —
 * never invent a verdict from a missing count.
 */
export function markerNetChange(
  atRef: MarkerContainment | null | undefined,
  baseline: MarkerContainment | null | undefined,
): 'added' | 'removed' | null {
  if (!atRef || !baseline) return null;
  if (atRef.pathPresent !== true || baseline.pathPresent !== true) return null;
  if (typeof atRef.count !== 'number' || typeof baseline.count !== 'number') return null;
  if (atRef.count > baseline.count) return 'added';
  if (atRef.count < baseline.count) return 'removed';
  return null;
}

/** The two candidate shas the gate machinery can name, resolved together. */
export interface GateCandidates {
  /** Candidate of the run in flight right now, or null when none is. */
  judgingSha: string | null;
  /** Candidate a fresh launch would pick (quiet-cut applied). */
  nextCandidateSha: string | null;
  /**
   * WI-36259 — provenance of `judgingSha`, see `ChangeInCandidate.judgingShaSource`.
   * OPTIONAL so the many existing `GateCandidates` fixtures (and the injectable
   * `deps.resolveGateCandidates`) do not strand on a required field they have no opinion
   * about — the trap CLAUDE.md's `lint:required-field-strands` exists for. A probe-only
   * resolver that omits it is read as `'run-probe'` by `reconcileGateCandidates`.
   */
  judgingShaSource?: JudgingShaSource;
}

/**
 * The frozen repair queue as `reconcileGateCandidates` needs it — structural, so the
 * snapshot's richer row and a two-field test fixture both satisfy it.
 */
export interface FrozenQueueForReconcile {
  candidate?: string | null;
  frozenCandidate?: string | null;
  phase?: string | null;
  /**
   * WI-10002104 — the queue's MOVABLE repair head. Required to answer `judgingSha` at all
   * during the phases below; OPTIONAL on the structural type so existing two-field fixtures
   * do not strand (the `lint:required-field-strands` trap CLAUDE.md names). The real caller
   * passes `snap.gate.repairQueue`, whose `repairHead` is non-optional, so production reads
   * supply it with no call-site change.
   */
  repairHead?: string | null;
}

/**
 * WI-10002104 — the phases in which the gate resumes the queue's MOVABLE `repairHead`
 * rather than its immutable frozen candidate.
 *
 * ⚠ This is NOT a convention; it mirrors `decideFrozenCandidateRepairQueue`
 * (`./release/frozen-candidate-repair-queue`), which is the authority on what the next run
 * actually materializes:
 *   - `'ready-to-verify'`  → `{ kind: 'verify-repair',  candidate: queue.repairHead, runSuite: true }`
 *   - `'ready-to-promote'` → `{ kind: 'promote-repair', candidate: queue.repairHead }`
 *   - `'ready-to-test'`    → `{ kind: 'test-candidate', candidate: queue.candidate }`
 *   - `'awaiting-fixer'`   → dispatch/wait, `runSuite: false` — renders NO suite verdict, so
 *                            the frozen candidate the recorded red was computed on stands.
 *   - `'blocked'`          → excluded entirely below.
 * `git-pipeline-position.judging-sha-tracks-gate-policy.test.ts` pins this set against that
 * policy by CALLING it for every phase, so a phase added there — or one that changes which
 * sha it resumes — fails the build instead of silently making this cell lie again.
 */
export const REPAIR_HEAD_RESUMING_PHASES = ['ready-to-verify', 'ready-to-promote'] as const;

/**
 * The sha a frozen repair queue pins, or null when the queue is absent or no longer the
 * gate's subject. `'blocked'` (attempts / wall-clock exhausted) is excluded on purpose: a
 * blocked queue is awaiting retire or escape, so "the next run resumes this candidate" no
 * longer holds and the probe is the honest fallback.
 *
 * ⚠ WI-10002104 — "the sha this queue pins" is PHASE-DEPENDENT, and answering it with the
 * frozen candidate unconditionally inverted the one error this cell exists to prevent. Once
 * a fix is admitted the phase becomes `ready-to-verify` and the gate materializes
 * `repairHead` (measured: a live run logged `release checkout ready … detached
 * e6360c1ba375…`, the repairHead, while this function returned frozen candidate 6234b578…).
 * Because `reconcileGateCandidates` is deliberately called BEFORE blob containment, a wrong
 * sha here does not merely mis-name the headline — `judgingContainsPath` is then measured
 * against the abandoned candidate too, so the headline and its own falsifier agree and the
 * caller is told `judging-without-current-path`: "do not read this run's verdict as a
 * judgement on your change", stamped `authoritative: true`, about a run judging exactly
 * that change. That is the corroborating-pair failure the call site's comment warns of.
 */
export function frozenQueueCandidate(queue: FrozenQueueForReconcile | null | undefined): string | null {
  if (!queue) return null;
  if (queue.phase === 'blocked') return null;
  const resumesRepairHead = (REPAIR_HEAD_RESUMING_PHASES as readonly string[]).includes(queue.phase ?? '');
  /**
   * The `??` chain still falls back to the frozen candidate when a caller's fixture carries
   * no `repairHead`: a phase-appropriate best answer beats returning null and degrading the
   * whole read to the checkout-head probe.
   */
  const sha = resumesRepairHead
    ? (queue.repairHead ?? queue.frozenCandidate ?? queue.candidate ?? null)
    : (queue.frozenCandidate ?? queue.candidate ?? null);
  return typeof sha === 'string' && sha.length > 0 ? sha : null;
}

/**
 * WI-36259 — RECONCILE the probe-derived gate candidate with the run's OWN published
 * re-triage marker, and say which one answered.
 *
 * ⚠ This exists because the resolver produced TWO shas for ONE subject and they could
 * disagree. `mapCheckpointRunInFlight` already prefers the marker for
 * `checkpointRunInFlight.candidate` (WI-7035); `changeInCandidate.judgingSha` — the
 * headline of the `gate.greenCheckpoint.candidate` cell, and the value CLAUDE.md points
 * triagers at — took the marker-blind probe instead. During a re-triage window that is the
 * ABANDONED candidate, so a containment check ran against a commit the gate had already
 * stopped judging.
 *
 * It takes the ALREADY-COMPUTED `checkpointRunInFlight` rather than re-reading the marker,
 * deliberately: the cell contract's axis 5 is "ONE derivation, many lenses — surfaces may
 * PROJECT or subset it and may NEVER re-derive it". A second marker read here would be a
 * second derivation of the same fact, i.e. the very thing that produced this bug.
 *
 * Pure, so the precedence is unit-testable without a repo or a live gate run.
 */
export function reconcileGateCandidates(
  candidates: GateCandidates,
  inFlight:
    | { candidate: string | null; candidateSource?: 'retriage-marker' | 'in-flight-candidate' | 'run-probe' }
    | null
    | undefined,
  /**
   * main-green-status-visible-2026-09-03 P-011 follow-up: the frozen repair queue, when one
   * is live. Precedence is marker > repair-queue > run-probe. The queue outranks the probe
   * because under freeze-and-converge a live run RESUMES the frozen candidate by
   * construction, while the probe on a CRON run is the checkout's HEAD — an inference the
   * refusal below already declines to answer containment from. It ranks BELOW the run's own
   * markers because those are observations of THIS run, and a re-fire can legitimately move
   * the run onto a newer candidate before the queue row learns of it.
   */
  repairQueue?: FrozenQueueForReconcile | null,
): GateCandidates {
  /**
   * `candidateSource: 'retriage-marker'` is only ever set when the marker was present AND
   * the run was active (`mapCheckpointRunInFlight`: `const marker = active && retriage ? …`),
   * so this single check already carries the liveness guard — no separate `active` test,
   * which would couple this to a second liveness derivation.
   *
   * EI-19931692050586322: `'in-flight-candidate'` carries the SAME guarantees — set only when
   * that marker was present and the run was active — and is likewise an observation the run
   * published about itself, so it is authoritative here too. Precedence between the two is
   * already settled upstream (a refire supersedes the candidate the run started on, so the
   * mapper consults the candidate marker only when there is no refire marker); this side just
   * has to stop treating "not the retriage marker" as "therefore an inference".
   */
  const markerSource =
    inFlight?.candidateSource === 'retriage-marker' || inFlight?.candidateSource === 'in-flight-candidate'
      ? inFlight.candidateSource
      : null;
  const markerSha = markerSource ? inFlight!.candidate : null;
  if (markerSha && markerSource) {
    return { ...candidates, judgingSha: markerSha, judgingShaSource: markerSource };
  }
  /**
   * No marker, but a frozen repair queue: its candidate is the sha the recorded verdict was
   * computed on and the sha the next run resumes, so it is the judged subject whether or
   * not a run happens to be alive at the instant of the read.
   */
  const frozen = frozenQueueCandidate(repairQueue);
  if (frozen) {
    return { ...candidates, judgingSha: frozen, judgingShaSource: 'repair-queue' };
  }
  /**
   * No marker. The probe's answer stands — but it is only ATTRIBUTED when it actually named
   * a sha: labelling a `null` judgingSha `'run-probe'` would assert provenance for a value
   * that does not exist, and a consumer branching on "is this attributed" would read it as
   * a real, merely-untrusted candidate.
   */
  return candidates.judgingSha
    ? { ...candidates, judgingShaSource: candidates.judgingShaSource ?? 'run-probe' }
    : candidates;
}

/**
 * A checkout-head candidate is a useful hint about where the run may be, but it is not an
 * observation of what the run is judging. Returning its path-blob comparison as a boolean
 * launders that inference into a verdict-shaped field — the exact P-004 failure mode.
 */
function inferredJudgingContainmentRefusal(): RefusedAnswer {
  return refuseAnswer({
    question: 'Does the in-flight run judge a candidate that contains your change?',
    because:
      "judgingShaSource='run-probe' is a checkout-head inference, not a candidate marker published by the run; " +
      "it can change between reads and cannot establish what this run's verdict includes.",
    insteadRead:
      "gate.checkpointRunInFlight.candidate when candidateSource is 'retriage-marker' or 'in-flight-candidate', " +
      "or checkpoint:await for the run's own published candidate",
  });
}

/**
 * Pure: turn the two candidates + their per-path containment into the caller-facing
 * verdict. Separated from the git/systemd reads so the phrasing — which is the whole
 * deliverable here — is unit-testable without a repo.
 */
import { renderAdmitCommand } from './release/repair-manifest';

/**
 * P-022 (D-007 #3): is `relPath` carried by the frozen queue's admission ledger? Pure over
 * the diagnostic's `admissions` so the tool, the cell and the completion guard all answer
 * from the same rows. `null` when there is no frozen queue (the question does not arise).
 */
export function admittedToLineageFor(
  queue:
    | { admissions?: readonly { paths?: readonly string[]; unchanged?: readonly string[] }[] | null }
    | null
    | undefined,
  relPath: string | null,
): boolean | null {
  if (!queue || !relPath) return null;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  const target = norm(relPath);
  if (!target) return null;
  return (queue.admissions ?? []).some((a) =>
    [...(a.paths ?? []), ...(a.unchanged ?? [])].some((p) => norm(p) === target),
  );
}

export function evaluateChangeInCandidate(args: {
  relPath: string | null;
  candidates: GateCandidates;
  judging: PathContainment | null;
  next: PathContainment | null;
  markerJudging?: MarkerContainment | null;
  markerNext?: MarkerContainment | null;
  /** P-011: the submodule the path lives in, when it does — carried through verbatim. */
  submodule?: ChangeInCandidate['submodule'];
  /** P-022: the admission-ledger verdict for `relPath` (`admittedToLineageFor`); omitted = no queue. */
  admittedToLineage?: boolean | null;
}): ChangeInCandidate {
  const core = evaluateChangeInCandidateCore(args);
  const admittedToLineage = args.admittedToLineage;
  if (admittedToLineage === undefined || admittedToLineage === null || !args.relPath) return core;
  // The ledger verdict only ADDS to the blob verdict: it never overrides a refusal or a
  // marker verdict, it explains the one case the blob compare cannot — content that moved
  // after (or never went through) an admission — and names the D-007 lever.
  const lever = renderAdmitCommand([args.relPath]);
  const clause =
    admittedToLineage === false
      ? core.judgingContainsPath === true
        ? ` The judged blob happens to equal staging's, but NO admission names this path — the frozen queue's ledger does not carry it (D-007): ${lever}.`
        : ` Not in the admission ledger on the judged lineage either — the lever is ${lever} (after git-sync commits the edit).`
      : core.judgingContainsPath === false
        ? ` An admission DOES carry this path on the lineage, so the mismatch is a LATER edit (yours or a peer's) that moved staging's content after it — admit again only if that edit is yours.`
        : ' Admitted to the judged lineage (D-007 ledger).';
  return {
    ...core,
    admittedToLineage,
    detail: core.detail ? `${core.detail}${clause}` : clause.trim(),
  };
}

function evaluateChangeInCandidateCore(args: {
  relPath: string | null;
  candidates: GateCandidates;
  judging: PathContainment | null;
  next: PathContainment | null;
  markerJudging?: MarkerContainment | null;
  markerNext?: MarkerContainment | null;
  submodule?: ChangeInCandidate['submodule'];
}): ChangeInCandidate {
  const { relPath, candidates, judging, next } = args;
  if (!relPath) return NO_CHANGE_IN_CANDIDATE;
  const markerJudging = args.markerJudging ?? null;
  const markerNext = args.markerNext ?? null;
  const submodule = args.submodule ?? null;
  const inferredJudgingContainment =
    candidates.judgingShaSource === 'run-probe' && candidates.judgingSha !== null;
  const judgingContainmentRefusal = inferredJudgingContainment ? inferredJudgingContainmentRefusal() : null;
  const base: ChangeInCandidate = {
    judgingSha: candidates.judgingSha,
    // WI-36259: carried through so the cell can say WHERE its headline came from. Spread
    // conditionally — an absent source must stay absent rather than becoming an explicit
    // `undefined` key, which serialises differently and would read as a declared unknown.
    ...(candidates.judgingShaSource ? { judgingShaSource: candidates.judgingShaSource } : {}),
    ...(judgingContainmentRefusal
      ? {}
      : { judgingContainsPath: judging ? judging.inCandidate : null }),
    nextCandidateSha: candidates.nextCandidateSha,
    nextContainsPath: next ? next.inCandidate : null,
    missingReason: judging?.reason ?? next?.reason ?? null,
    submodule,
    markerJudging,
    markerNext,
    detail: judgingContainmentRefusal ? describeRefusal(judgingContainmentRefusal) : null,
  };
  // P-011: for a submodule path every verdict below was computed against the submodule
  // commit the candidate PINS, so say so — and name the hop that actually moves it.
  const viaSubmodule = (pin: string | null): string =>
    submodule
      ? ` (resolved through submodule '${submodule.path}': the candidate pins submodule commit ${pin ? pin.slice(0, 12) : '<unreadable>'}, and the comparison was made inside it)`
      : '';
  const submoduleBumpClause = submodule
    ? ` This path is inside submodule '${submodule.path}', so what the candidate lacks is the SUPERPROJECT gitlink bump — git-sync's superproject commit — not the submodule commit itself; no hand-run \`git -C ${submodule.path} rev-parse\` recipe is needed to establish that.`
    : '';

  // The source itself is the uncertainty. Do not let a marker or a path comparison derived
  // from this inferred candidate reintroduce the verdict-shaped answer we just withheld.
  if (judgingContainmentRefusal) return base;

  /**
   * EI-18797292094433710: when the caller named a marker, IT is the answer — it speaks
   * to "is my change in there", which is the question, while blob identity only speaks
   * to "is the whole file identical", which is not. So this runs BEFORE the
   * content-identity branches and returns outright; letting those run first would
   * re-emit the ambiguity the marker just resolved.
   */
  /**
   * EI-19311755730915969: this says "the gate's JUDGED candidate", never "the run IN
   * FLIGHT". `judgingSha` names WHICH commit was judged; it cannot support a claim about
   * a run being alive right now, and phrasing it as liveness is what let a reader
   * conclude "someone else has this, wait" from a completed run. Run liveness has its own
   * measured field (`gate.checkpointRunInFlight.active`) and its own three states,
   * including UNKNOWN — see the gate stage's lever.
   */
  const markerVerdict = (m: MarkerContainment, sha: string | null, which: 'judged' | 'next'): string | null => {
    const at = sha?.slice(0, 12);
    if (m.present === true) {
      const times = m.count === 1 ? 'once' : `${m.count}×`;
      /**
       * EI-19325709344484737: presence is a SUBSTRING test, so it can only ever prove
       * the marker string is there — never that YOUR CHANGE is. When the marker is a
       * generic identifier that already occurred in the file, `present` is true for a
       * candidate cut BEFORE the fix, and the exoneration below is confidently wrong.
       *
       * Measured 2026-08-02 on candidate 1ee32228: marker 'backingTables' occurred 14×
       * in the judged candidate and 16× at tip. The candidate did NOT carry the fix
       * (`git show <candidate>:<path> | grep harness_shared.operator_turns` → 0 hits),
       * yet this said "DOES carry your change ... Do NOT re-fire". Believing it would
       * have left main pinned behind a run that provably could not green.
       *
       * The count differential is the cheap discriminator and both numbers are already
       * computed — a judged count BELOW the tip count is positive proof the judged tree
       * is missing occurrences the change added. Say so instead of exonerating.
       */
      // `count` is `number | null` (null = unmeasured), so narrow ONCE here rather than
      // asserting: a null count must never render as "null×" or drive arithmetic.
      const judgedCount = m.count;
      const tipCount = markerNext?.count ?? null;
      if (which === 'judged' && markerPartialAgainst(m, markerNext) && judgedCount !== null && tipCount !== null) {
        return (
          `The gate's judged candidate (${at}) carries the marker ${times}, but tip has it ` +
          `${tipCount}× — so the judged tree is MISSING ${tipCount - judgedCount} ` +
          `occurrence(s) your change added. It carries only PART of the change. Treat a RED from ` +
          `it as UNPROVEN, not as a verdict on your code. Note the marker cannot settle this on ` +
          `its own: it is a substring test, so a marker that already existed in the file reads as ` +
          `"present" for a candidate cut before your fix. Settle it through the canonical ` +
          `exact-ancestry reader: call release:trace { sha: '<the commit that introduced your fix>' } ` +
          `and read gate.fixCommitContainment.verdict. Do NOT hand-run merge-base or settle it with ` +
          `release:checkpoint-run's callerEditsInCandidate: it compares the path's CURRENT ` +
          `content, so any peer commit to the same file after yours reports it missing even when ` +
          `your fix is in the candidate (EI-19326775809436764). Or re-call with a marker string ` +
          `UNIQUE to your change.`
        );
      }
      return which === 'judged'
        ? `The gate's judged candidate (${at}) DOES carry your change TO ${relPath} — the marker occurs ${times} in its version of this file. ` +
            `That verdict IS a real verdict on ${relPath}: a RED there is about your change to THIS file, not about a missing one. ` +
            `Do NOT re-fire FOR ${relPath} — you already have a run that includes it. ` +
            `This verdict is PER-PATH, not per-run: if your session changed other files too, they may land in a different commit and this candidate may NOT carry them — ` +
            `re-check each other changed path separately (its own dev:pipeline_position / marker call) before concluding no re-fire is needed for the whole change-set.` +
            (judgedCount !== null && judgedCount > 1
              ? ` (Caveat: the marker occurs ${times}, so it is not unique to your change — if it is a common identifier ` +
                `rather than a string your edit introduced, confirm exact ancestry through ` +
                `release:trace { sha: '<the commit that introduced your fix>' } and read ` +
                `gate.fixCommitContainment.verdict; do not derive it from a hand-run merge-base.)`
              : '')
        : `A checkpoint fired now would judge ${at}, which DOES carry your change TO ${relPath} (marker occurs ${times}). This is per-path — other changed files may not be in this same candidate.`;
    }
    if (m.present === false) {
      const why = m.pathPresent === false ? ' (that commit has no such file at all)' : '';
      return which === 'judged'
        ? `The gate's judged candidate (${at}) does NOT carry your change — the marker is absent from its version of this file${why}. ` +
            `A RED from it is NOT evidence your change failed; it is testing code without it.`
        : `A checkpoint fired now would judge ${at}, which does NOT carry your change (marker absent${why}).`;
    }
    return null;
  };

  if (markerJudging && markerJudging.present !== null) {
    return { ...base, detail: markerVerdict(markerJudging, candidates.judgingSha, 'judged') };
  }
  if (markerNext && markerNext.present !== null && !candidates.judgingSha) {
    return { ...base, detail: markerVerdict(markerNext, candidates.nextCandidateSha, 'next') };
  }

  const lever = (reason: MissingReason | null): string => {
    switch (reason) {
      case 'uncommitted':
        return 'The edit is still only in the working tree, which the gate cannot see. Commit it first: git-sync:run.';
      case 'absent':
        return 'That file does not exist at all in the judged commit (it is new). Commit it first: git-sync:run.';
      case 'newer-commit':
        // EI-18797292094433710: this branch used to read "re-fire once the commit ages
        // past the quiet window". That is the one lever that must NOT be offered here.
        // `inCandidate` compares the path's CURRENT content, so a PEER's later commit to
        // the same file produces this exact reading even when the candidate already
        // carries YOUR change — and on a hot shared file it never clears, because the
        // tip is always newer than the quiet-cut candidate. Following the old advice
        // restarts a ~55min suite clock for nothing; it did so twice during a 3h+
        // fleet-wide outage whose fix was sitting in every candidate the whole time.
        return (
          'It IS committed, but the file has been committed AGAIN since the candidate was cut (the quiet-cut steps the candidate back ~4 min). ' +
          'This does NOT by itself mean YOUR change is missing — a peer commit to the same file reads identically. ' +
          'SETTLE IT IN ONE CALL instead of guessing: re-call with `marker` set to a distinctive string from your own change ' +
          '(a new function name, an error message, an id you added) and this verdict becomes definitive either way.' +
          submoduleBumpClause
        );
      default:
        return '';
    }
  };

  // The in-flight run's verdict is the one about to land, so it outranks the
  // hypothetical next candidate whenever both are known.
  if (base.judgingContainsPath === false) {
    // EI-18797292094433710: 'newer-commit' is NOT the same claim as the other two.
    // uncommitted/absent mean the candidate provably cannot see your work, so "a RED
    // is not evidence your change failed" is true. newer-commit only means the file
    // MOVED since the cut — which a peer's edit causes just as readily as your own —
    // so asserting the same exoneration there tells the caller to disregard a verdict
    // that may be a real verdict on their code, and to re-fire for one they already
    // have. State the ambiguity instead of resolving it in the wrong direction.
    if (base.missingReason === 'newer-commit') {
      return {
        ...base,
        detail:
          `The gate's judged candidate (${base.judgingSha?.slice(0, 12)}) carries an EARLIER version of this file. ` +
          `Whether YOUR change is in it is UNRESOLVED from the path alone. ${lever(base.missingReason)} ` +
          // EI-19311755730915969: this used to end "a verdict is already coming from this
          // run" — a liveness claim `judgingSha` cannot make. The advice that survives is
          // the one this line is actually for: do not re-fire on an unresolved reading.
          `Do not re-fire on the strength of this line alone.`,
      };
    }
    return {
      ...base,
      detail:
        `The gate's judged candidate (${base.judgingSha?.slice(0, 12)}) does NOT contain this file's current content${viaSubmodule(submodule?.judgingPin ?? null)}. ` +
        `A RED from that run is NOT evidence your change failed — it is testing code without it. ${lever(base.missingReason)}`,
    };
  }
  if (base.judgingContainsPath === true) {
    /**
     * EI-20429780229915918: this used to end "so its verdict is a real verdict on your
     * change" — a claim about the CALLER'S change that a path comparison cannot support.
     * It holds only when `relPath` is a file the caller actually edited, and nothing here
     * knows whether it is.
     *
     * The failure is not exotic. An agent monitoring a red gate across wakes picks ONE
     * stable path as a probe so successive readings are comparable; every read then
     * returns `judgingContainsPath: true`, about a file unrelated to the fix, and this
     * sentence told it the fix was in the candidate. Measured near-miss: the 4th red on
     * candidate 75c1ee3ea189 failed on routing-table.test.ts whose fix landed LATER in
     * 075291b75eaf — the candidate did NOT carry the fix while this line said the verdict
     * was about it. What stopped the wrong branch firing was a facts:list read, not any
     * signal from here.
     *
     * Note the asymmetry this repairs: every `false` arm above is carefully hedged (the
     * newer-commit arm refuses to exonerate and routes to `marker`), while the `true` —
     * the direction that fails SILENTLY, because a `true` about the wrong subject is
     * indistinguishable from a `true` about the right one — carried no caution at all.
     *
     * Deliberately NOT a blanket downgrade of the signal: for a path the caller did edit,
     * blob identity with the working tree does mean the change is in, and that reading
     * stays. Name the subject, then route to the instrument that answers the question the
     * caller is actually asking.
     */
    return {
      ...base,
      detail:
        `The gate's judged candidate (${base.judgingSha?.slice(0, 12)}) DOES carry the current content of ${relPath}${viaSubmodule(submodule?.judgingPin ?? null)}. ` +
        `If ${relPath} is a file YOU changed, that is a real verdict on your change to it. ` +
        `But this compares THE PATH YOU PASSED, not your change: if ${relPath} is a fixed probe path you reuse across wakes — or any file you did not edit — a true here is the expected reading and says NOTHING about whether your fix is in the candidate. ` +
        `To settle "is MY change in", re-call with \`marker\` set to a distinctive string your change introduced.`,
    };
  }
  if (base.nextContainsPath === false) {
    return {
      ...base,
      detail:
        `A checkpoint fired right now would judge ${base.nextCandidateSha?.slice(0, 12)}, which does NOT contain this file's current content — ` +
        `firing now buys a verdict on code without your change. ${lever(base.missingReason)}`,
    };
  }
  if (base.nextContainsPath === true) {
    return {
      ...base,
      detail: `A checkpoint fired now would judge ${base.nextCandidateSha?.slice(0, 12)}, which DOES carry this file's current content.`,
    };
  }
  return base;
}

/**
 * P-006 (EI-18735166063643844, EI-18739606737220804): in this repo an agent CANNOT
 * commit atomically. git-sync owns commit and fires on a fixed interval, sweeping
 * whatever happens to be on disk at that instant into one `chore(git-sync):
 * auto-commit` under its own authorship — mid-edit, mid-refactor, mid-anything.
 *
 * So a multi-file change has a WINDOW in which a partial (often non-compiling)
 * intermediate becomes a real commit, and the green-checkpoint can cut its candidate
 * INSIDE that window and faithfully judge it. The cost is measured, not theoretical:
 * a candidate cut at 14:09 produced 29 failures for a retirement whose dependent-fix
 * commit landed at 14:36 — every one of them already green at tip, and a peer spent a
 * wake triaging code that was never broken.
 *
 * What this surface can honestly add is the WINDOW and the BLAST RADIUS: how many
 * paths the next sweep will take (never just yours — git-sync commits the whole tree)
 * and when it fires. Deliberately NO lever: nothing an agent can call makes the commit
 * atomic, and inventing one here would be the fabricated-action failure P-005's null
 * levers exist to prevent. This is a timing fact you act on by finishing the set.
 */
export interface SweepExposure {
  /**
   * The probed path has uncommitted edits, so the next git-sync tick WILL commit it —
   * whatever state it is in. False for a clean path and for a sha-only probe.
   */
  exposed: boolean;
  /**
   * How many paths in the WHOLE tree the next sweep would take — the blast radius,
   * which is the number that matters: >1 means the sweep cannot cut your change alone.
   * `null` when not measured (clean path / sha-only probe / unreadable status).
   */
  dirtyPathCount: number | null;
  /** A bounded sample of them, so a caller can see whether the sweep spans more than its own edit. */
  dirtyPathSample: string[];
  /** ms until git-sync's next scheduled tick; null when the routine's next fire is unknown. */
  nextSweepInMs: number | null;
  detail: string | null;
}

/** Nothing to be exposed to — a clean path, or a sha-only probe. */
const NO_SWEEP_EXPOSURE: SweepExposure = {
  exposed: false,
  dirtyPathCount: null,
  dirtyPathSample: [],
  nextSweepInMs: null,
  detail: null,
};

/** How many dirty paths to name before summarising the rest as a count. */
const SWEEP_SAMPLE_LIMIT = 6;

/**
 * Pure: turn the dirty set + the sweep clock into the caller-facing exposure. Split
 * from the git read for the same reason evaluateChangeInCandidate is — the phrasing IS
 * the deliverable, and it must be testable without a repo mid-refactor.
 */
export function evaluateSweepExposure(args: {
  dirtyUncommitted: boolean;
  /** Tree-wide dirty paths (`git status --porcelain`), or null when not measured. */
  dirtyPaths: string[] | null;
  /** git-sync's next scheduled fire (epoch ms), from the routine row. */
  nextSweepAtMs: number | null;
  nowMs?: number;
}): SweepExposure {
  const { dirtyUncommitted, dirtyPaths, nextSweepAtMs } = args;
  if (!dirtyUncommitted) return NO_SWEEP_EXPOSURE;

  const now = args.nowMs ?? Date.now();
  // Never `=== null` a timestamp that came from free-form routine state: `undefined`
  // slips straight through and renders as "NaN min" (the carry note from P-003).
  // A next-fire already in the past means the tick is DUE, not negative — clamp to 0.
  const nextSweepInMs = Number.isFinite(nextSweepAtMs) ? Math.max(0, (nextSweepAtMs as number) - now) : null;
  const count = dirtyPaths ? dirtyPaths.length : null;
  const sample = (dirtyPaths ?? []).slice(0, SWEEP_SAMPLE_LIMIT);

  const when =
    nextSweepInMs === null
      ? 'at its next tick'
      : nextSweepInMs < 60_000
        ? 'within the next MINUTE'
        : `in ~${Math.round(nextSweepInMs / 60_000)} min`;

  // The single-file case is a genuinely different answer, not a weaker version of the
  // multi-file one: one dirty path cannot be cut into a partial set, so the sweep is
  // simply how the change gets committed. Saying "⚠ a broken intermediate may be
  // judged" there would be a false alarm, and a surface that cries wolf on the common
  // case is how the real multi-file warning gets skimmed past.
  if (count !== null && count <= 1) {
    return {
      exposed: true,
      dirtyPathCount: count,
      dirtyPathSample: sample,
      nextSweepInMs,
      detail:
        `git-sync will commit this file ${when} under its own message (\`chore(git-sync): auto-commit\`) — ` +
        `you do not commit here. Nothing else in the tree is dirty, so the sweep cannot cut a partial set.`,
    };
  }

  const radius =
    count === null
      ? 'the whole tree'
      : `all ${count} dirty path(s)` +
        (sample.length
          ? ` (${sample.join(', ')}${count > sample.length ? `, +${count - sample.length} more` : ''})`
          : '');

  return {
    exposed: true,
    dirtyPathCount: count,
    dirtyPathSample: sample,
    nextSweepInMs,
    detail:
      `⚠ SWEEP-EXPOSED: git-sync commits the WHOLE TREE, so its next tick (${when}) takes ${radius} in ONE auto-commit — ` +
      `including any file you are mid-way through. The green-checkpoint can then cut its candidate at that commit and ` +
      `faithfully judge the intermediate, producing a red that does NOT reproduce at tip (EI-18735166063643844). ` +
      `You cannot make this atomic — git-sync owns commit — so either finish the set before the tick, or read a red ` +
      `landing in this window against the candidate sha before believing it (dev:pipeline_position reports containment).`,
  };
}

/** A diagnostic stage. Delivery stages are ordered source->live; publish is a side leg. */
export type StageName = 'committed' | 'pushed' | 'gate' | 'main' | 'deployed' | 'serving';

/** Whether this stage can block :3070 delivery or only off-box publication/durability. */
export type StagePlane = 'delivery' | 'publish';

/** Where MY change sits relative to a stage. `na` = this stage is not on my change's activation route at all. */
export type StagePosition = 'past' | 'pending' | 'na';

/**
 * Whether the stage ITSELF is moving — the dimension a position boolean cannot express.
 * `advancing` normal · `stalled` not progressing, waiting will probably not help ·
 * `disabled` deliberately off · `broken` faulted · `unknown` not measured here.
 */
export type StageHealth = 'advancing' | 'stalled' | 'disabled' | 'broken' | 'unknown';

export interface StageState {
  name: StageName;
  /** `pushed` is publish-only; every other current stage is on the delivery plane. */
  plane: StagePlane;
  position: StagePosition;
  health: StageHealth;
  /** Why it reads this way, and the concrete lever when it is not advancing. */
  detail: string | null;
  /**
   * P-005: the ONE concrete thing that moves this stage, extracted from `detail` prose
   * into a field — or `null` when waiting genuinely IS the correct move.
   *
   * The distinction is the point. Every stage can produce prose; only some have an
   * action. Burying "there is nothing to do but wait" inside a paragraph that also
   * explains the mechanism reads as "here is a problem", and an agent that must
   * decide-from-prose which of six stages owns the next move is doing the work this
   * surface exists to do for it. `null` here is a POSITIVE answer, not a missing one.
   */
  lever: string | null;
}

/**
 * EI-19326284032085138 — the PROGRESS term `gate.stalled` / `gate.consecutiveReds` lack.
 *
 * Both are derived from a count of consecutive RED VERDICTS and nothing else, so a candidate
 * whose failing set is being repaired run-over-run and one that is genuinely wedged render
 * IDENTICALLY on `stages[].health`. `stalled` is documented above as "not progressing, waiting
 * will probably not help" — a claim about the FUTURE that a backward-looking red tally cannot
 * support, and the counter says nothing about whether the tree is getting healthier.
 *
 * The discriminator already existed and was already on this struct: `gate.candidateFailures`
 * (`gate-candidate-failures.ts`; cell `gate.candidateFailures.stillBrokenCount`) compares each
 * failing file's blob on the frozen candidate against `repairHead`, which is exactly the
 * converging-vs-wedged question. It was computed, tested, and then ignored by this derivation.
 * This function only READS it — it introduces no new measurement.
 *
 * ⚠ THE DEFAULT IS `unknown`, AND THAT IS THE WHOLE SAFETY ARGUMENT. Exactly ONE reading earns
 * `converging`; absent, unavailable, truncated, unmeasured and none-failing all fall through to
 * `unknown`, which leaves today's verdict byte-for-byte untouched. A gate that reads healthy
 * BECAUSE its progress data went missing is the reassuring-degradation failure this surface
 * exists to prevent, so absence must never be able to produce the good news.
 */
export type GateProgressReading = 'converging' | 'outstanding' | 'unknown';

export function gateCandidateProgress(cf: GateCandidateFailures | null | undefined): GateProgressReading {
  // No frozen repair queue, or the read failed: the other fields are explicitly "not evidence".
  if (!cf || cf.unavailable !== null) return 'unknown';
  // A capped list is a BOUNDED measurement, never a total — `alreadyFixedCount === files.length`
  // then means "every file WE COULD SEE is fixed", and the files past the cap are unexamined.
  // Reporting convergence off a truncated sample is precisely a floor read as a total.
  if (cf.truncated) return 'unknown';
  switch (cf.assessment) {
    case 'repairs-outstanding':
      // At least one failing file is still broken at repairHead: real work remains.
      return 'outstanding';
    case 'non-test-leg-failing':
      // P-007: a red lint/perf/desktop/delta leg with no landed fix is real work too — the
      // one kind the file counts cannot see, which is exactly why it must not fall through
      // to `unknown` (where it would leave a wedged gate reading neutral).
      return 'outstanding';
    case 'all-fixes-contained':
      // Every failing file's fix is already in repairHead, awaiting re-verification. This is
      // freeze-and-converge working as designed — the next run re-tests that sha.
      return 'converging';
    // 'none-failing' is NOT convergence. Zero failing TEST files while reds are counted means
    // the red is not in the leg this cell measures — the lint/perf/desktop/delta legs and the
    // main fast-forward are separate (see `scope` / `nonTestLegsMeasured` / `nonTestLegs.perLeg`).
    // Calling that "converging" would hand a green-ish reading to a gate wedged on a leg this
    // function cannot see. 'unmeasured' and 'no-frozen-candidate' are absent subjects outright.
    case 'none-failing':
    case 'unmeasured':
    case 'no-frozen-candidate':
      return 'unknown';
  }
}

/**
 * WI-6357 / EI-18790908999972569 — how long a nonzero staging→main buffer
 * (`verdictProvenance.mainFastForwarded === false`) may persist before it stops
 * being NORMAL lag and starts being a genuine main-stall signal.
 *
 * A nonzero buffer BY ITSELF is the ordinary steady state on this fleet: staging
 * (git-sync commits continuously) outruns the green-checkpoint, which fires only
 * ~hourly and takes up to ~55min per run — so `mainFastForwarded === false` reads
 * true on virtually every healthy call. Firing 'stalled' on that alone reproduces
 * the EI-11012 anti-pattern this same module already fixed once for the deploy
 * stage, just under a new field name.
 *
 * 2h sits comfortably past any single normal cycle (cadence + one suite run) while
 * still catching a genuine multi-hour stall — it is also the window from the
 * incident that first motivated tracking this at all (EI-18719549079738452, a
 * torn git-sync candidate silently wedging retriage for ~2h while `gate.stalled`/
 * `consecutiveReds` both read clean).
 */
export const MAIN_BUFFER_STALL_MS = 2 * 60 * 60 * 1000;

/**
 * WI-38367: WHY the staging→main buffer looks stuck — the two triggers need OPPOSITE
 * responses from the reader, so they must not collapse into one boolean.
 *   · 'no-green'              the gate has produced no green verdict in the window; it
 *                             is not running / not passing. Go look at the gate.
 *   · 'unproductive-advance'  the gate IS greening, and main IS moving — but the old end
 *                             of the backlog has not moved with it. Nothing is wedged;
 *                             the promotions are not consuming this buffer. Telling this
 *                             reader "the gate has recorded no NEW green verdict" would
 *                             send them hunting a gate that is running fine.
 */
export type MainBufferStallReason = 'no-green' | 'unproductive-advance';

/**
 * Is the staging→main buffer's AGE — not merely its existence — suspicious, and why?
 *
 * `mainFastForwarded !== false` (no buffer, or unmeasured) is never stale — a
 * buffer that doesn't exist can't be stuck, and a `null` (unmeasured) must not be
 * read as a confident stall (axis 2: a missing measurement is not a negative
 * result). Otherwise, staleness is judged against `gate.lastGreenAtMs`: a RECENT
 * green verdict with a buffer still ahead of it is the expected in-between state
 * of a fleet whose commits outpace its checkpoint cadence; only a buffer that has
 * outlived `MAIN_BUFFER_STALL_MS` since the last green verdict is worth surfacing
 * — `gate.lastGreenAtMs === null` (no green verdict measured yet) is likewise left
 * unstale rather than asserted stuck.
 *
 * ⚠ WI-38367 / D-005 on `main-gate-recovery-2026-08-12` — the recency test above is a
 * PROXY, and WI-38218's partial-green salvage broke it: promoting the longest green
 * PREFIX resets `lastGreenAt` on every pass while the old end of the backlog never
 * moves, so "greened within the window" stopped implying "main is catching up". Left
 * alone, this helper reports `advancing` / "normal, not a stall" about a main that is
 * hundreds of commits behind and falling further — the same false all-clear WI-38340
 * fixed one surface over, in `evaluateMainBehindStaging`.
 *
 * So a recent green only suppresses when it is CORROBORATED by the buffer's own age:
 * a real advance `t` ago leaves the oldest un-promoted commit no older than `t` plus
 * one suite cut. `stagingBufferAgeMs` measures that directly, exactly as the watchdog's
 * `behindMs` does — deliberately NOT by testing for the `advanced-prefix` status,
 * which is a taxonomy that the next mechanism to move `main` without consuming the
 * backlog would not appear in (a manual prefix promotion already doesn't).
 *
 * An unmeasured `stagingBufferAgeMs` cannot corroborate OR refute, and this surface's
 * standing rule is that a missing measurement never manufactures a verdict — so it
 * leaves the pre-existing recency suppression exactly as it was rather than alarming.
 *
 * Pure + directly unit-testable, mirroring `computeStages`'s own contract.
 */
export function mainBufferStallReason(
  input: {
    gate: Pick<PipelinePosition['gate'], 'lastGreenAtMs'>;
    mainFastForwarded: boolean | null;
    /** Age of the OLDEST un-promoted commit — `verdictProvenance.stagingBufferAgeMs`. */
    stagingBufferAgeMs?: number | null;
  },
  now: number = Date.now(),
): MainBufferStallReason | null {
  if (input.mainFastForwarded !== false) return null;
  if (input.gate.lastGreenAtMs === null) return null;
  const greenAgeMs = now - input.gate.lastGreenAtMs;
  if (greenAgeMs > MAIN_BUFFER_STALL_MS) return 'no-green';
  const bufferAgeMs = input.stagingBufferAgeMs;
  if (bufferAgeMs == null) return null;
  // Motion without progress: the gate advanced within the window, yet the buffer's old
  // end is further back than that advance could possibly have left it.
  return bufferAgeMs > greenAgeMs + MAIN_BUFFER_STALL_MS ? 'unproductive-advance' : null;
}

/** Boolean projection of `mainBufferStallReason` — never a second derivation. */
export function mainBufferIsStale(
  input: Parameters<typeof mainBufferStallReason>[0],
  now: number = Date.now(),
): boolean {
  return mainBufferStallReason(input, now) !== null;
}

/**
 * WI-10006493: the last git-sync pass's deliberate deferral of the queried path, if any.
 *
 * git-sync defers a dirty path for three reasons: a live edit lock (`owner` + `intent`), a
 * migration whose number reservation was refused (`migration-reservation`), or a superproject
 * path held back with such a migration by the dependency fence (`migration-dependency-fence`).
 * In all three a forced sync defers the path again, so `git-sync:run` is not a lever. The
 * returned `lever` names what actually unblocks the path, and deliberately does NOT contain
 * the `git-sync:run` token, because callers copy the lever verbatim.
 *
 * `skippedPaths` entries are repo-relative within their `scope` (a submodule path, or
 * `superproject`); the queried path is superproject-relative, so the two are joined first.
 * Pure: matches against the snapshot the resolver already read.
 */
export function gitSyncDeferralFor(
  path: string | null,
  gitSync: Pick<GitSyncLegs, 'skippedPaths' | 'syncAgeMs'>,
): { reason: 'edit-lock' | 'migration-reservation' | 'migration-dependency-fence'; detail: string; lever: string } | null {
  if (!path) return null;
  const want = path.replace(/^\.\//, '');
  const entry = (gitSync.skippedPaths ?? []).find((s) => {
    const full = !s.scope || s.scope === 'superproject' ? s.path : `${s.scope}/${s.path}`;
    return full === want;
  });
  if (!entry) return null;
  const when =
    gitSync.syncAgeMs === null || gitSync.syncAgeMs === undefined
      ? 'The last git-sync pass'
      : `The last git-sync pass (~${Math.max(0, Math.round(gitSync.syncAgeMs / 60_000))} min ago)`;
  const listOr = (xs: readonly string[] | undefined, none: string): string =>
    xs && xs.length > 0 ? xs.join(', ') : none;

  if ('owner' in entry) {
    return {
      reason: 'edit-lock',
      detail:
        `${when} deferred this path because a live edit lock covers it (held by ${entry.owner}: "${entry.intent}"). ` +
        'git-sync excludes locked paths from every commit, so forcing git-sync:run skips it again until the lock is released or expires.',
      lever: `release the edit lock on this path (held by ${entry.owner}) — check locks:queue first: if it is already released, the next sweep commits the path`,
    };
  }
  if (entry.reason === 'migration-reservation') {
    return {
      reason: 'migration-reservation',
      detail:
        `${when} deferred this migration because its number reservation was refused: ${entry.detail}. ` +
        'git-sync re-checks the reservation on every pass, so forcing git-sync:run defers it again until the reservation is valid.',
      lever:
        'reserve a migration number with node scripts/next-migration.mjs --name <slug> --intent "..." and rename this file to the printed path; it commits on the next sweep after that',
    };
  }
  const migrations = listOr(entry.blockingMigrations, 'an unidentified migration');
  const authors = listOr(entry.blockingAgents, 'unattributed');
  const workItems = listOr(entry.blockingWorkItems, 'none recorded');
  return {
    reason: 'migration-dependency-fence',
    detail:
      `${when} held this path behind the migration dependency fence: ${entry.detail}. ` +
      `Blocking migration(s): ${migrations}; author(s): ${authors}; work-item(s): ${workItems}. ` +
      'The fence holds the path for as long as that migration\'s reservation is refused, so forcing git-sync:run defers it again.',
    lever:
      `unblock the migration first — ${migrations} (author: ${authors}; work-item: ${workItems}) needs a valid reservation ` +
      '(node scripts/next-migration.mjs, then rename it); this path commits with it on the next sweep after that',
  };
}

/**
 * Derive the stage table from state the caller ALREADY computed — this function
 * makes no git calls and adds no measurement, so it is pure and unit-testable.
 * P-002/P-003/P-004 replace the `unknown` healths with real signals.
 */
export function computeStages(
  p: Pick<
    PipelinePosition,
    | 'dirtyUncommitted'
    | 'positions'
    | 'gate'
    | 'verdictProvenance'
    | 'runtime'
    | 'gitSyncLastStatus'
    | 'gitSync'
    | 'serving'
    | 'changeInCandidate'
    | 'sweepExposure'
  > & {
    /**
     * EI-24049239243821100: read only for its `workingTree` leg (a failed `git status`).
     * The resolver always passes it; a caller that omits it has no failed legs to report.
     */
    positionsUnknown?: readonly string[];
    /**
     * WI-10006493: the queried path, read only to match it against the last git-sync pass's
     * `skippedPaths`. The resolver always passes it; a caller that omits it gets no deferral match.
     */
    input?: { path: string | null };
  },
  /**
   * WI-6525: set when there is genuinely nothing to measure a position for — no
   * commit ever touched the path (and it is not merely a brand-new dirty file), an
   * explicit sha failed to resolve, or neither a path nor a sha was supplied. When
   * set, the `committed` stage (first in stage order) reports this directly with
   * its own lever, so `deriveBlocker` never falls through to the `gate` stage's
   * "fix the reds" lever for a change that was never resolvable in the first place.
   */
  targetUnresolvedDetail: string | null = null,
  /**
   * WI-1752145: injected so the abort-vintage sentence below is deterministically testable in
   * BOTH directions — a fresh abort must render its age WITHOUT a staleness marker, and a stale
   * one must render the marker. A disclosure that cannot be shown to stay silent on fresh input
   * is one that passes vacuously.
   */
  nowMs: number = Date.now(),
): StageState[] {
  // A path whose runtime does NOT go through the release pipeline (bg-host, gateway,
  // embed-sidecar) is never carried by staging->main->:3070 at all: reporting those
  // stages as "pending" would tell the caller to wait for something that will never
  // happen to their file. EI-11120 cost a real deploy-and-wait cycle to this exact
  // misreading, so those stages are `na` with the activation lever attached.
  const rt = p.runtime;
  const releaseApplies = rt ? rt.releasePipelineApplies : true;
  // EI-21302702663327936 / EI-21271731610759140: normalize through
  // withRestartAuthorization like the `activation` (owners map) and
  // `activationLever` legs — a bare `{ confirm: true }` recommendation is a
  // call the live gate REFUSES (restart_withheld: the enablement gate also
  // needs authorize:true + reason), so agents copying it verbatim fired the
  // repeated-tool-error watchdog. This was the third emission path, missed
  // by the 2026-08-12 fix that added the helper.
  const naDetail = rt
    ? withRestartAuthorization(
        `Not on this path's activation route — it runs in ${rt.host}, which does not read the release checkout. It goes live on RESTART: dev:restart { target: "${rt.restartTarget}", confirm: true }.`,
      )
    : null;
  const off = (name: StageName): StageState => ({
    name,
    plane: 'delivery',
    position: 'na',
    health: 'disabled',
    detail: naDetail,
    // An `na` stage is not on this change's route at all, so it never owns the next move —
    // the RESTART that does is the serving stage's lever, not this one's.
    lever: null,
  });

  const stages: StageState[] = [];

  // committed — about MY CHANGE, not merely the path. `positions.committedLocal`
  // means "this path exists at some commit", which reads as "my change is
  // committed" and is the single most-misread signal in this surface.
  //
  // P-006: `git-sync:run` is a TREE-WIDE sweep, not a commit of your file. Told to an
  // agent halfway through a multi-file refactor, the unqualified lever is an
  // instruction to commit the broken intermediate ON PURPOSE and hand it to the gate —
  // exactly the shape EI-18735166063643844 measured happening by accident. The lever
  // stays (it is still the right move once the set is complete); the blast radius rides
  // with it so the caller can tell which situation they are in.
  const sweep = p.sweepExposure;
  const multiFileSweep = sweep.dirtyPathCount !== null && sweep.dirtyPathCount > 1;
  // EI-24049239243821100: an unreadable working tree cannot put this stage behind us —
  // "committed" is exactly the question the failed `git status` could not answer.
  const workingTreeUnknown = !p.dirtyUncommitted && (p.positionsUnknown?.includes('workingTree') ?? false);
  // WI-10006493: git-sync:run is only the lever when a sync CAN commit this path. When the last
  // pass deliberately deferred it (a migration guard, or a live edit lock), forcing another pass
  // defers it again, so the blocker and its owner are named instead.
  const deferral = p.dirtyUncommitted ? gitSyncDeferralFor(p.input?.path ?? null, p.gitSync) : null;
  stages.push({
    name: 'committed',
    plane: 'delivery',
    position: p.positions.committedLocal && !p.dirtyUncommitted && !workingTreeUnknown ? 'past' : 'pending',
    health: p.dirtyUncommitted
      ? 'stalled'
      : workingTreeUnknown
        ? 'unknown'
        : targetUnresolvedDetail
          ? 'stalled'
          : 'advancing',
    detail: deferral
      ? deferral.detail
      : p.dirtyUncommitted
      ? 'Uncommitted edits in the working tree. The release gate checks out a COMMITTED candidate and cannot see the tree, so this change is invisible to it until git-sync commits. Force it now: git-sync:run.' +
        (sweep.detail ? ` ${sweep.detail}` : '')
      : workingTreeUnknown
        ? 'The working-tree status read failed, so whether this path has uncommitted edits is unknown. Treat nothing past this stage as proof the edit on disk is live.'
        : targetUnresolvedDetail,
    lever: deferral
      ? deferral.lever
      : p.dirtyUncommitted
      ? multiFileSweep
        ? `git-sync:run (commit the working tree — the gate cannot see it) — ⚠ this sweeps ALL ${sweep.dirtyPathCount} dirty paths in the tree, not just yours; only fire it once the set is complete`
        : 'git-sync:run (commit the working tree — the gate cannot see it)'
      : workingTreeUnknown
        ? 're-call dev:pipeline_position — the git status read failed, so this stage was not measured'
        : targetUnresolvedDetail
          ? 'verify the path/sha is correct and re-call — there is nothing here for git-sync or the release gate to advance, so neither firing a sync nor greening the gate will resolve this'
          : null,
  });

  // pushed — P-002. The push leg fails INDEPENDENTLY of the commit leg, and its
  // failure is silent: commits keep accumulating locally while origin freezes. The
  // health here is what tells a caller whether waiting can possibly help.
  const gs = p.gitSync;
  const stale = gs.syncAgeMs !== null && gs.syncAgeMs > GIT_SYNC_STALE_AFTER_MS;
  // EI-18812945811758018: a COMMIT-ONLY member never pushes to origin by design (bridged
  // / p2p-only hive: the GitHub bridge writer is the sole origin pusher). Reporting that
  // leg as 'advancing' with a `git-sync:run` lever is actively misleading — it reads as
  // "the push is late / broken, force it", and the forced run commits and pushes nothing.
  // 'disabled' is the honest health: this leg is not going to move here, ever.
  //
  // A genuine FAULT still outranks this: a commit-only member can still hit merge
  // conflicts or error ticks on its commit/fetch/merge half, and those must stay loud.
  const commitOnly = isCommitOnlyMember(gs);
  // EI-19341723994516667: the p2p own-head-publish leg's self-report — read ONLY for a
  // commit-only member (a pushing member's origin leg is git-sync's push, not this).
  // `ohp` null means "unmeasured" (a pre-WI-5738 routine row, or the field genuinely
  // absent) and must NOT be read as either healthy or faulted.
  const ohp = commitOnly ? (gs.ownHeadPublish ?? null) : null;
  const ohpRefused = ohp?.refused ?? null;
  const ohpBacklog = ohp?.backlogRemains === true;
  const pushedHealth: StageHealth =
    gs.consecutiveErrorTicks > 0 || gs.errors.length > 0
      ? 'broken'
      : gs.conflicts.length > 0
        ? 'broken'
        : stale
          ? 'stalled'
          : commitOnly
            ? ohpRefused
              ? 'broken'
              : ohpBacklog
                ? 'stalled'
                : 'disabled'
            : 'advancing';
  const pushedDetail = ((): string | null => {
    if (gs.consecutiveErrorTicks > 0 || gs.errors.length > 0) {
      return `git-sync is FAULTING (${gs.consecutiveErrorTicks} consecutive error tick(s))${
        gs.errors.length ? `: ${gs.errors.slice(0, 2).join('; ')}` : ''
      }. Commits may keep landing locally while origin stays frozen — waiting will not clear this.`;
    }
    if (gs.conflicts.length > 0) {
      return `git-sync hit merge CONFLICTS (${gs.conflicts.slice(0, 3).join(', ')}) — a merge-resolver must clear them before anything reaches origin.`;
    }
    if (stale) {
      return `git-sync's last tick was ${Math.round((gs.syncAgeMs ?? 0) / 60_000)} min ago (ticks are ~10 min) — the leg is not advancing, so this is not simply "not yet".`;
    }
    if (commitOnly) {
      // Say the DESIGN out loud, and name the lever that actually moves origin. Without
      // this the reader sees "committed, not on origin, pushed NOTHING" and reasonably
      // concludes the push is broken (EI-18812945811758018 was filed as a CRITICAL bug
      // on exactly that reading, by an agent who had already forced a sync to no effect).
      const reason = gs.pushMode?.slice('commit-only:'.length) || 'unknown';
      const base = `This member is COMMIT-ONLY (${reason}) — it never pushes to origin, by design, so an empty push list is CORRECT and git-sync:run cannot change it.`;
      // EI-19341723994516667: "greening the gate" was DISPROVED as the blanket lever —
      // WI-6996 measured staging 29 commits AHEAD of the green pin while origin sat
      // frozen for ~6h; the actual mechanism (publish-guard.ts) admits a range purely
      // on CONTENT checks (oversized blobs, secrets), never on release-gate greenness.
      // So distinguish what is ACTUALLY blocking this leg instead of defaulting to the
      // gate, which a caller cannot green their way out of here.
      if (ohpRefused) {
        return `${base} Its p2p publish leg is REFUSING to publish (${ohpRefused}) — THAT is what is holding origin back, NOT the green gate: publish admission is a content/security check (oversized blobs, secrets), entirely independent of the release pipeline. Greening the gate will not help. Inspect \`metadata.own_head_publish\` on the git-sync routine + the git-sync journal for the offending commit.`;
      }
      if (ohpBacklog) {
        const trail =
          ohp?.publishedSha && ohp?.sha
            ? ` (published head ${ohp.publishedSha.slice(0, 8)} trails the worktree head ${ohp.sha.slice(0, 8)})`
            : '';
        return `${base} Its p2p publish leg is ADMITTED but carrying an UNDRAINED BACKLOG${trail} — the namespace head is falling permanently behind. This is NOT the green gate: greening it will not move this leg. Inspect \`metadata.own_head_publish\` (\`publishedSha\` vs \`sha\`, \`blockedAtCommit\`/\`oversizedCommit\`) for what is throttling the per-tick slice.`;
      }
      return `${base} Origin advances via the p2p publish/bridge-egress path, which admits a range on CONTENT checks alone (oversized blobs, secrets) — it is NOT gated by the release/green-checkpoint gate, so greening that gate will not move this leg.${ohp ? ' No fault is currently reported on the publish leg' : ' The publish leg is unmeasured on this row (no `own_head_publish` metadata yet)'} — waiting is correct.`;
    }
    if (!p.positions.onStaging) {
      return `Committed locally but NOT yet on origin/staging. Status "${gs.status ?? 'unknown'}" does NOT mean pushed — the last tick pushed ${
        gs.pushedRepos.length ? gs.pushedRepos.join(', ') : 'NOTHING'
      }. Force one: git-sync:run.`;
    }
    return null;
  })();
  // The push leg is the clearest case for a null lever: when it is simply BETWEEN ticks,
  // waiting is not a fallback, it is the right answer — git-sync will push within ~10 min.
  // A lever here would invite a needless forced run. But a FAULTED leg will never
  // self-clear, so waiting there is the wrong answer and must not read the same.
  const pushedLever = !p.positions.onStaging
    ? gs.conflicts.length > 0
      ? 'a merge-resolver must clear the git-sync conflicts — this leg cannot self-heal'
      : commitOnly && (ohpRefused || ohpBacklog)
        ? // A genuine own-head-publish fault: git-sync:run cannot touch this leg at all —
          // don't reuse the COMMIT-leg lever below, which would send the reader to force a
          // sync that changes nothing (the exact bug this fixes).
          ohpRefused
          ? 'inspect `metadata.own_head_publish` on the git-sync routine for the refusal code + the git-sync journal for the offending commit — NOT the green gate (publish admission is a content/security check, independent of it)'
          : 'inspect `metadata.own_head_publish` on the git-sync routine (`publishedSha` vs `sha`, `blockedAtCommit`/`oversizedCommit`) for what is throttling the slice — NOT the green gate'
        : pushedHealth === 'broken' || pushedHealth === 'stalled'
          ? // A commit-only member still has a COMMIT leg that can stall, and git-sync:run
            // does move that — but never describe it as fixing a push it will never do.
            commitOnly
            ? 'git-sync:run (the COMMIT leg is not advancing — this member never pushes; it will not put anything on origin)'
            : 'git-sync:run (the push leg is not advancing on its own)'
          : null
    : null;
  stages.push({
    name: 'pushed',
    // A bridged/commit-only member commits locally and relies on the p2p bridge
    // for origin publication; that origin leg is durability-only for :3070.
    plane: commitOnly ? 'publish' : 'delivery',
    position: p.positions.onStaging ? 'past' : 'pending',
    health: pushedHealth,
    detail: pushedDetail,
    lever: pushedLever,
  });

  if (!releaseApplies) {
    stages.push(off('gate'), off('main'), off('deployed'));
  } else {
    const g = p.gate;
    // EI-21337656680788367: a red counter with an EXPLICITLY measured empty failing-file
    // set is not an actionable code-red verdict. This is the signature produced when the
    // gate repeatedly defers before its suite (for example, dependency materialisation
    // cannot acquire pc-heavy): the counters remain non-zero, but there is no test to fix.
    // Keep absent `failingTests` as UNKNOWN so older snapshots/fixtures do not gain a false
    // materialisation diagnosis.
    const redWithoutFailingTests =
      g.consecutiveReds > 0 && Array.isArray(g.failingTests) && g.failingTests.length === 0;
    // EI-19326284032085138: the progress term. `pause`/`fireStale` still OUTRANK it, and must:
    // a paused or non-firing gate is broken however converged its candidate is, because nothing
    // is coming to re-verify those contained fixes.
    const gateProgress = gateCandidateProgress(g.candidateFailures);
    const gateHealth: StageHealth = g.pause
      ? 'broken'
      : g.fireStale
      ? 'broken'
      : g.stalled || g.consecutiveReds > 0
        ? // A red streak whose frozen candidate is CONVERGING is not "waiting will probably not
          // help" — it is the repair queue doing its job, with re-verification the only next step.
          // Every other progress reading, `unknown` included, keeps the pre-existing verdict.
          gateProgress === 'converging'
          ? 'advancing'
          : 'stalled'
        : 'advancing';
    // P-004: a red gate and a candidate that lacks your change are the SAME reading
    // for a caller unless something separates them — and the wrong separation is the
    // expensive one (re-debugging a correct fix). So when the candidate provably does
    // not carry this file, that fact LEADS the gate detail, ahead of the red count.
    const cic = p.changeInCandidate;
    /**
     * EI-18797292094433710: a MARKER verdict outranks blob identity everywhere the old
     * reading drove behaviour, not just in the phrasing. When the caller named a marker
     * and the judged commit carries it, the candidate DOES contain the change even
     * though the file is no longer byte-identical (a peer moved it) — so this must not
     * count as `notInCandidate`, or the warning and the lever both keep firing on a
     * question that has already been answered.
     */
    /**
     * EI-19325709344484737: a PARTIAL marker must not silence the warning or the lever.
     * When the judged candidate carries fewer occurrences than tip, it demonstrably lacks
     * part of the change, so treating it as "present" here reproduces the original bug in
     * the place that actually drives behaviour — `judgedRunCoversChange` feeds the
     * "nothing to do, a verdict is coming" arm, which is what leaves main pinned.
     */
    const judgedContainmentRefused = cic.judgingShaSource === 'run-probe' && cic.judgingSha !== null;
    const markerSaysPresent =
      !judgedContainmentRefused &&
      !markerPartialAgainst(cic.markerJudging, cic.markerNext) &&
      (cic.markerJudging?.present === true || (!cic.judgingSha && cic.markerNext?.present === true));
    const notInCandidate = !markerSaysPresent && (cic.judgingContainsPath === false || cic.nextContainsPath === false);
    /** The judged run demonstrably covers this change — by identity OR by marker. */
    const judgedRunCoversChange = !judgedContainmentRefused && (cic.judgingContainsPath === true || markerSaysPresent);
    /**
     * EI-19311755730915969 — LIVENESS IS `gate.checkpointRunInFlight.active`, NEVER
     * `cic.judgingSha`.
     *
     * Both "a verdict is coming, so wait" arms in the lever below used to key off
     * `judgingSha` being non-null. That value names WHICH commit the gate judged; only
     * its production resolver gates it on a live probe, and nothing in the type or the
     * pure evaluator enforces that — so a reading that outlives the run it described
     * renders as a live one. On 2026-08-02 that produced the exact false all-clear this
     * surface exists to prevent: a gate red ~6.7h with the reds already fixed in the
     * tree reported `lever: null` -> `nextAction: null` -> "nothing to do — this leg is
     * advancing on its own", while main was held for the entire fleet.
     *
     * THREE STATES, and folding the third into either of the others IS the bug:
     *   active === true   a suite really is running — a verdict IS coming.
     *   active === false  idle — nothing is coming on its own. ⚠ EI-19395922387569240:
     *                     this only earns the word MEASURED when
     *                     `activeSource === 'run-lock'`. A process-authority source is
     *                     emitted only for active:true; without either source the reading came from
     *                     a cache of unbounded age (measured: 7h), and a stale `false`
     *                     routes this very lever to "fire release:checkpoint-run" — into
     *                     a run that may be live. `livenessNote` says which one it is.
     *   absent / null     UNKNOWN. The cache had no snapshot (cold DB, first routine
     *                     tick, failed read) — and it was absent from the very payload
     *                     that misled the filer, 14 min before the same call returned
     *                     `{ active: false }`. It must NEVER read as "in flight":
     *                     defaulting to the reassuring answer is precisely how this
     *                     failed silently, and an unknown is not evidence of an absence.
     *
     * EI-18797292094433710 is PRESERVED by this, not weakened: a genuinely in-flight run
     * still suppresses the re-fire, because `active === true` is exactly the condition
     * that fix was reaching for when it reached for `judgingSha`.
     */
    const runInFlight = g.checkpointRunInFlight?.active === true;
    // P-009 / WI-41252: liveness is published before the candidate during setup.
    // This is a deliberate WAIT state. Until the live run publishes its sha there
    // is no honest containment verdict, and every re-fire lever is unsafe.
    const candidateNotYetPublished = runInFlight && cic.judgingSha === null;
    const runInFlightUnknown = g.checkpointRunInFlight == null;
    const gateBlocked = gateHealth === 'stalled' || gateHealth === 'broken';
    /**
     * A BLOCKED gate is where "is a verdict coming?" decides what the caller does next,
     * so the answer — INCLUDING "we do not know" — belongs in the sentence rather than
     * being inferred from a lever's absence. Inferring it is what went wrong: the caller
     * read a null lever as "someone else has this", which is a claim no absent value can
     * make.
     */
    const livenessNote = g.pause || !gateBlocked
      ? ''
      : runInFlight
        ? ` A gate run IS in flight${
            g.checkpointRunInFlight?.elapsedSec != null
              ? ` (running ~${Math.max(1, Math.round(g.checkpointRunInFlight.elapsedSec / 60))}m)`
              : ''
          } — its verdict is coming, so do NOT fire a second one: the gate is a singleton, a second fire is REFUSED, and escalating to replaceStale is the EI-11667 replace-storm that starved the gate for 2h.`
        : runInFlightUnknown
          ? ' Whether a gate run is in flight is UNKNOWN on this call (the run-liveness cache held no snapshot) — that is NOT evidence none is running, and it is NOT a reason to wait for a verdict.'
          : // EI-19395922387569240: only claim "measured" when the LIVE run lock answered.
            // A cache-backed idle is a reading of the past, and saying "measured" of it is
            // what let a stale `false` send callers to fire a run into a live one.
            g.checkpointRunInFlight?.activeSource === 'run-lock'
            ? ' NO gate run is in flight (measured live via the run lock) — no verdict is coming on its own, so waiting cannot clear this.'
            : ` NO gate run is in flight according to the run-liveness CACHE${
                g.checkpointRunInFlight?.asOfAgeMs != null
                  ? ` (computed ${Math.round(g.checkpointRunInFlight.asOfAgeMs / 1000)}s ago)`
                  : ''
              } — the live lock read did not answer, so treat this as a hint, not a measurement, before firing anything.`;
    // P-004 (gate-verdict-liveness-and-repair-reliability-2026-08-31): APPEND the
    // shared standing pause banner — who holds the gate, since when, and when it
    // auto-resumes (or that nothing will). `fireStaleReason` carries it
    // (projectGreenCheckpointPause composes it, so the surfaces cannot drift).
    //
    // ⚠ APPEND, never REPLACE — and keep the ORIGINAL sentence whole. Both halves are
    // load-bearing to EI-21271222700908558's assertions here: the "DELIBERATELY PAUSED"
    // phrase readers match on, AND the pause reason. A caller may hand-build a `gate`
    // whose `fireStaleReason` carries neither (fixtures do), so deriving either from it
    // loses a signal. The mild reason-duplication in production is the cost of a
    // rendering that cannot drop information for ANY caller shape.
    const pauseDetail = g.pause
      ? `Gate is DELIBERATELY PAUSED (active:false)${g.pause.reason ? `: ${g.pause.reason}` : ''} — no scheduled fire can occur until the hold is resumed.` +
        (g.fireStaleReason ? ` ${g.fireStaleReason}` : '')
      : null;
    const repairQueueDetail = g.repairQueue
      ? `Frozen repair queue ${(
          g.repairQueue.frozenCandidate ?? g.repairQueue.candidate
        ).slice(0, 12)} is ${g.repairQueue.phase} with mutable repairHead ${g.repairQueue.repairHead.slice(0, 12)} ` +
        `(age ${Math.round(g.repairQueue.ageMs / 60_000)}m, fixer ${g.repairQueue.fixerSpawnId ?? 'none'} ` +
        `${g.repairQueue.fixerAlive === null ? 'liveness unknown' : g.repairQueue.fixerAlive ? 'live' : 'not live'}, decision ${g.repairQueue.decision}; ` +
        // WI-10000287: this sentence used to read `'no suite ran on repairHead'`, selected by a
        // `currentStatus === 'no-suite'` field that has since been removed. Two defects, both
        // fixed here. (1) TENSE/SCOPE: it was emitted while a suite WAS running on the repairHead
        // — nothing in this read model observes process liveness, so the honest claim is about a
        // COMPLETED result, and it must say so loudly enough that a reader does not act on it as
        // a liveness verdict. (2) FAIL-OPEN: the old optional chain compared `undefined` against
        // `'no-suite'`, so a queue with NO verdictProvenance fell to the else-branch and rendered
        // "isolated repair suite result is recorded" — asserting a green that was never measured.
        // Absent provenance is now its own branch and reads as UNKNOWN.
        `${
          !g.repairQueue.verdictProvenance
            ? 'no verdict provenance recorded — this queue\'s suite result is UNKNOWN, not green'
            : g.repairQueue.verdictProvenance.repairHeadVerdict === 'isolated-repair-green'
              ? 'an isolated repair suite result is recorded'
              : 'no COMPLETED suite result for this repairHead yet — a suite may be running RIGHT NOW; this field never observes liveness, so check `node scripts/proc-guard.mjs check green-checkpoint` before concluding the gate is idle'
        }).`
      : null;
    const gateDetail = g.pause
      ? pauseDetail
      : notInCandidate
      ? `${cic.detail}${
          gateHealth === 'stalled'
            ? cic.missingReason === 'newer-commit'
              ? // EI-18797292094433710: do NOT hand out the exoneration here. The file
                // only moved since the cut, so the red may be a REAL red on this
                // change; telling the caller to disregard it is how a genuine
                // regression gets waved through as "stale candidate".
                ` (The gate is also RED — ${g.consecutiveReds} consecutive. Resolve the ancestor check above BEFORE deciding whether that red is yours — it may well be.)`
              : ` (The gate is also RED — ${g.consecutiveReds} consecutive — but do NOT read that red as your change failing until a run that CONTAINS it completes.)`
            : ''
        }`
      : repairQueueDetail
        ? repairQueueDetail
      : // EI-19405864032365760: an ABORTED tick outranks the red streak, because the streak is
        // stale BY CONSTRUCTION whenever one is recorded — the abort judged no code, so the
        // counters still describe an older run whose candidate and failing tests are no longer
        // what is holding the pipeline. Reporting the streak here is what sent a fleet after
        // unrelated test files for ~2.5h during the 2026-08-03 migrations-pending freeze, while
        // the one-line true cause was recorded nowhere a reader looks. Ordered ABOVE fireStale
        // too: an aborting gate is still firing on schedule, so `fireStale` is false and its
        // "fire one with release:checkpoint-run" advice would be actively wrong — a fresh run
        // aborts at the same preflight.
        g.inconclusive
        ? // EI-21290961259437085: the refire clause is DERIVED, never asserted here. This
          // sentence used to claim "firing another run will abort the same way" for every
          // abort — already false for the two statuses whose LEVERS had been corrected
          // (deadline-exceeded/WI-39841, infra-inconclusive/EI-20767792192323374) and false
          // again for 'cancelled', which merely RECORDS an external SIGTERM. Both this
          // sentence and the lever below now read the same table, so a status cannot be
          // right in one and wrong in the other.
          `Gate ABORTED before judging (${g.inconclusive.status}) — it rendered NO verdict${gateAbortRefireClause(
            g.inconclusive.status,
          )} ${g.inconclusive.detail ?? 'See the green-checkpoint log for the blocking condition.'}${
            // WI-1752145: the abort's OWN age, on the sentence a reader acts on. This record is
            // LATCHED — written by a scoped jsonb_set that does NOT advance the top-level
            // `observedAt` — so it persists until a later tick overwrites it, and every other
            // vintage on this payload describes the VERDICT instead. Stating the age
            // unconditionally is the vintage stamp; the WARNING is gated on it actually being
            // old, so a fresh abort is not decorated and the marker keeps its meaning.
            g.inconclusive.detail?.includes(GATE_ABORT_DETAIL_LIVENESS_MARKER)
              ? ''
              : (() => {
                  const v = gateAbortVintage({
                    status: g.inconclusive!.status,
                    observedAtMs: g.inconclusive!.observedAtMs,
                    nowMs,
                  });
                  // The warning already states the age, so the bare parenthetical is for the
                  // fresh case ONLY — otherwise a stale abort prints its age twice in one
                  // sentence, which reads as two separate observations rather than one.
                  if (v.warning) return ` ${v.warning}`;
                  return v.age === null ? '' : ` (Abort observed ${v.age} ago.)`;
                })()
          }${
            g.consecutiveReds > 0
              ? ` ⚠ The gate counters still show ${g.consecutiveReds} consecutive red(s)${
                  g.observedCandidate ? ` on ${g.observedCandidate}` : ''
                } — that is the PREVIOUS verdict, not this one. Do not chase those failing tests: this tick judged no code at all.`
              : ''
          }`
        : g.fireStale
          ? `The green-checkpoint is NOT FIRING${g.fireStaleReason ? ` (${g.fireStaleReason})` : ''} — no verdict is coming until that is fixed. Waiting will not help; fire one with release:checkpoint-run.`
          : redWithoutFailingTests
            ? `Gate counters report RED (${g.consecutiveReds} consecutive), but the same gate snapshot records zero failing tests — there is no code-red target to fix. Inspect the latest green-checkpoint run/materialisation blocker before re-firing; do not chase historical test names.`
          : // EI-19326284032085138: a converging candidate reads `advancing`, which would otherwise
            // leave `detail: null` — "nothing to say" — on a gate showing a long red streak. That is
            // the one reading a caller cannot be left to interpret alone, so it is spelled out, with
            // the scope caveat attached: this cell measures the TEST leg of the frozen candidate only.
            gateProgress === 'converging' && (g.consecutiveReds > 0 || g.stalled)
            ? `Gate is RED (${g.consecutiveReds} consecutive) but the frozen candidate is CONVERGING, not wedged: all ${
                g.candidateFailures?.alreadyFixedCount ?? 0
              } of its failing file(s) already have their fix in repairHead, so they are awaiting re-verification — there is nothing to go fix.${
                // The reading NAMES ITS OWN SUBJECT. A convergence claim is a statement about one
                // (candidate → repairHead) pair, and the failure mode a peer measured on the
                // sibling `inconclusive` block (2026-08-31: a 'migrations-pending' verdict served
                // ~1h after the migration it declared impossible had applied) is a load-bearing
                // field that does not say what it is about. Unlike that block, this term is
                // computed live per call — a fresh test_runs read plus `git rev-parse` blob
                // comparisons — never served from the cached gate_health snapshot; printing both
                // shas is what lets a reader confirm that rather than take it on trust.
                g.candidateFailures?.candidateSha && g.candidateFailures?.repairHeadSha
                  ? ` (Measured live against candidate ${g.candidateFailures.candidateSha.slice(
                      0,
                      12,
                    )} → repairHead ${g.candidateFailures.repairHeadSha.slice(0, 12)}, not read from the cached gate snapshot.)`
                  : ''
              } ⚠ Scope: that covers the gate's affected-test leg on this candidate only; the lint/perf/desktop/delta legs and the main fast-forward are separate and are ${
                g.candidateFailures?.nonTestLegsMeasured === 'measured'
                  ? `measured — ${
                      g.candidateFailures.nonTestLegs?.shrink.failingLegs ?? 0
                    } leg(s) still failing${
                      g.candidateFailures.nonTestLegs?.shrink.failingLegIds.length
                        ? `: ${g.candidateFailures.nonTestLegs.shrink.failingLegIds.join(', ')}`
                        : ''
                    }`
                  : 'NOT recorded — no leg measurement exists for this cycle, which is not the same as "no legs failing"'
              } here.`
          : gateHealth === 'stalled'
            ? `Gate is RED (${g.consecutiveReds} consecutive) — main is held for everyone until it greens. The reds are yours to fix, not a queue to wait in.${
                gateProgress === 'outstanding' && g.candidateFailures
                  ? g.candidateFailures.assessment === 'non-test-leg-failing'
                    ? // P-007: the file counts are all zero here BY CONSTRUCTION, so rendering them
                      // ("0 of 0 failing files…") would explain a red with nothing. Name the leg.
                      ` No failing TEST file is still broken, but non-test leg(s) ${
                        g.candidateFailures.nonTestLegs?.outstanding.join(', ') || '(unnamed)'
                      } are RED at repairHead with no landed fix — repair THAT LEG so it passes on top of the frozen candidate (a path match is not evidence about a leg, D-005).`
                    : ` ${g.candidateFailures.stillBrokenCount} of ${g.candidateFailures.failingFileCount} failing file(s) have an UNCHANGED blob at repairHead; the other ${g.candidateFailures.alreadyFixedCount} already carry their fix and are NOT yours to re-fix.${
                      // An unchanged TEST blob is not proof of an unfixed file — the repair
                      // may sit in a non-test carrier the test exercises. Saying "still
                      // broken" here sent agents to re-fix already-repaired files (measured
                      // 2026-09-02: 3 of 3). Name the check instead of asserting the verdict.
                      g.candidateFailures.stillBrokenNeedsRunCount > 0
                        ? ` ⚠ ${g.candidateFailures.stillBrokenNeedsRunCount} of those are UNCONFIRMED — other files moved between the two refs, so a fix may be riding a non-test file. Run that ONE file at repairHead before treating it as work.`
                        : ''
                    }`
                  : ''
              }`
            : null;
    stages.push({
      name: 'gate',
      plane: 'delivery',
      position: p.positions.inMain ? 'past' : 'pending',
      health: gateHealth,
      detail: gateDetail === null ? null : `${gateDetail}${livenessNote}`,
      // Containment outranks the gate's own health: firing a verdict on a candidate that
      // cannot see your change buys nothing, so fixing THAT comes before greening reds.
      lever: safeGateLever(
        g,
        !p.positions.inMain
          ? candidateNotYetPublished
            ? null
            : notInCandidate
              ? cic.missingReason === 'uncommitted' || cic.missingReason === 'absent'
                ? 'git-sync:run (the judged candidate does not contain your change yet)'
                : // EI-18797292094433710: 'newer-commit' with a run ALREADY IN FLIGHT must
                // not route to a re-fire. The file merely moved since the cut — a peer's
                // edit does that too — so the in-flight candidate may already carry the
                // change, and a re-fire would throw away a verdict that is minutes from
                // landing to start a fresh ~55min clock (done twice during a 3h+ outage
                // whose fix was in every candidate). Same reasoning as the
                // judgingContainsPath===true arm below: a verdict is coming, so wait.
                //
                // EI-19311755730915969: "is one in flight" is `checkpointRunInFlight.active`,
                // not `cic.judgingSha` — see the three-state note above. An UNKNOWN reading
                // falls through to the lever deliberately: the caller is told the truth by
                // `livenessNote`, and `release:checkpoint-run` REFUSES a second fire anyway,
                // so a needless fire attempt is cheap while a false "wait" costs hours.
                  runInFlight
                  ? null
                  : 'wait out the quiet-cut window (~4 min), then release:checkpoint-run — the judged candidate predates your commit'
              : // A run is ALREADY IN FLIGHT judging a candidate that carries this change: a
              // verdict covering it is coming, so waiting is the correct move and there is
              // nothing to fire. Telling the caller to run release:checkpoint-run here is
              // actively wrong — the gate is a singleton, so a second fire is REFUSED, and
              // reaching for replaceStale to "unstick" it is the EI-11667 replace-storm that
              // starved the gate of every verdict for 2h. Found by dogfooding this surface on
              // a live stale red whose in-flight run already carried the fix.
              //
              // EI-19311755730915969: same re-key as above. This arm is the one that reported
              // "nothing to do" on a gate that had been red for 6.7h with NOTHING running.
              runInFlight && judgedRunCoversChange
              ? null
              : // EI-19405864032365760: an ABORTED tick has a lever, and it is NOT the one the two
                // arms below would hand out. `fireStale` is false (the gate IS firing, on schedule,
                // and aborting each time) and the red streak belongs to an older run, so both
                // "fire a checkpoint run" and "fix the reds" send the reader at the wrong thing —
                // a re-fire aborts identically at the same preflight, and the named failing tests
                // are not what is holding the pipeline. Route to the blocking condition instead.
                g.pause
                ? null
                : g.repairQueue?.nextAction
                ? g.repairQueue.nextAction
                : g.inconclusive
                ? g.inconclusive.status === 'migrations-pending'
                  ? 'db:migrate (the gate aborts before judging while a migration is pending — apply it, THEN the next scheduled run judges normally; firing one now aborts the same way)'
                  : // EI-20767792192323374: an infra abort is the one abort where RE-FIRING IS the
                    // lever — the condition is transient host weather (something deleted the runner's
                    // temp root mid-suite), not a standing blocker, so the generic "re-firing aborts
                    // the same way" below would be false and would tell the reader to wait on nothing.
                    // The load caveat is the point: firing into the same pressure repeats the fault.
                    g.inconclusive.status === 'infra-inconclusive'
                    ? "release:checkpoint-run once the box is quiet (the gate's own module cache was deleted mid-run — a HOST fault, so it rendered no verdict; ⚠ do NOT triage the files the last red named, they are innocent)"
                    : // WI-39841: a deadline-kill is the OTHER abort where the generic arm below
                      // would be actively wrong. "Re-firing aborts the same way" is false — there
                      // is no standing blocker to clear, the run simply ran out of clock, and the
                      // next one may well finish. But it is not the infra case either: the lever
                      // is the run's BUDGET vs its WORKLOAD, not host weather. And the strongest
                      // thing to say is what NOT to do: this tick recorded no verdict, so any
                      // failing files still on display belong to an older run.
                      g.inconclusive.status === 'deadline-exceeded'
                      ? 'release:checkpoint-run (the last run was SIGTERMd at its suite budget before it could record a verdict — nothing is blocking a re-fire; ⚠ do NOT triage the files an earlier red named, they are not what stopped it. If it keeps dying at the deadline, the run needs more budget or less work — that is the fix, not triage)'
                      : // EI-21290961259437085: the remaining recorded statuses route through the
                        // shared classification instead of inheriting the standing-condition
                        // wording. 'cancelled' is the live case that motivated this: an external
                        // SIGTERM (exit 143) RECORDS a kill and latches nothing, so both clauses of
                        // the old generic text — "clear the abort condition" and "re-firing aborts
                        // the same way" — were false, and it told a whole fleet to wait on nothing.
                        // ⚠ The generic wording is still CORRECT for a genuine standing condition
                        // and is still what `gateAbortLever` returns for one; this is a routing fix,
                        // not a blanket claim that aborts never block a re-fire.
                        gateAbortLever(g.inconclusive.status)
                : g.fireStale
                  ? 'release:checkpoint-run (the green-checkpoint is not firing — no verdict is coming on its own)'
                  : redWithoutFailingTests
                    ? 'inspect the latest green-checkpoint run/materialisation blocker (the gate records no failing tests to fix), then release:checkpoint-run once that blocker clears'
                  : gateHealth === 'stalled'
                    ? 'fix the reds, then release:checkpoint-run — a red gate holds main for everyone and is yours to green, not a queue to wait in'
                    : null
          : null,
      ),
    });

    // WI-6357 / EI-18790908999972569: a nonzero staging buffer is the fleet's normal
    // steady state (see MAIN_BUFFER_STALL_MS above) — reporting 'stalled' on its mere
    // existence cried wolf on virtually every healthy call and buried the ONE thing
    // that actually determines whether main is stuck: the gate's own health (main only
    // advances as a consequence of a green verdict, per the `lever: null` note below),
    // or — when the gate itself reads clean — a buffer that has genuinely outlived the
    // pipeline's normal cadence (mainBufferIsStale). `gateBlocked` is hoisted above the
    // gate stage (EI-19311755730915969) — the gate's own liveness note needs it too.
    const mainStallReason = mainBufferStallReason({
      gate: g,
      mainFastForwarded: p.verdictProvenance.mainFastForwarded,
      stagingBufferAgeMs: p.verdictProvenance.stagingBufferAgeMs,
    });
    const bufferAgeHours =
      p.verdictProvenance.stagingBufferAgeMs != null
        ? (p.verdictProvenance.stagingBufferAgeMs / 3_600_000).toFixed(1)
        : '?';
    stages.push({
      name: 'main',
      plane: 'delivery',
      position: p.positions.inMain ? 'past' : 'pending',
      health: gateBlocked || mainStallReason !== null ? 'stalled' : 'advancing',
      detail: gateBlocked
        ? 'main cannot advance past the last green pin while the gate is blocked — see the gate stage above, which is what is actually holding it back.'
        : mainStallReason === 'no-green'
          ? `the gate has recorded no NEW green verdict in over ${Math.round(MAIN_BUFFER_STALL_MS / 3_600_000)}h while a staging buffer waits — so main still sits at the LAST green pin and cannot advance until the gate greens again. NOTE this measures the buffer's AGE, not that main is behind the current pin: main is normally exactly AT it, so do not go diffing main against the pin to confirm this (it will look fine and read as a false alarm). May be a silent retriage (EI-18719549079738452) rather than genuine health; worth a closer look, not necessarily broken.`
          : // WI-38367: the OPPOSITE remedy from the branch above, so it gets its own
            // sentence — the gate here is running and greening, and sending this reader
            // to go un-wedge it wastes the trip. What is wrong is that the promotions
            // are not consuming THIS backlog (the partial-green-salvage signature).
            mainStallReason === 'unproductive-advance'
            ? `the gate IS greening and main IS advancing — but the oldest un-promoted commit is still ~${bufferAgeHours}h old, so those advances are moving the TIP end of the staging buffer, not consuming it (the WI-38218 partial-green-salvage signature: the longest green PREFIX is promoted while the tip stays red). Do NOT read this as a wedged gate — it is running. The question to ask is what keeps failing at the tip; \`release:checkpoint-run\`'s own reds name it.`
            : p.verdictProvenance.mainFastForwarded === false
              ? 'a staging buffer awaits the next green-checkpoint run before main catches up — normal, not a stall.'
              : null,
      // main advances only as a CONSEQUENCE of a green verdict — there is no lever that
      // acts on it directly, so anything offered here would send the caller at the wrong
      // stage. The gate above owns this move.
      lever: null,
    });

    // 'ahead-of-gate' means the live code was force-deployed PAST the gate, so
    // "deployed" does not imply "tested" — the existing deployOrigin comment says
    // to flag exactly this, so surface it as a health, not a footnote.
    const ahead = p.verdictProvenance.deployOrigin === 'ahead-of-gate';
    stages.push({
      name: 'deployed',
      plane: 'delivery',
      position: p.positions.deployed ? 'past' : 'pending',
      health: ahead ? 'broken' : 'advancing',
      detail: ahead
        ? 'The deployed sha carries commits the green pin does NOT — it was force-deployed past the gate. "deployed" does not mean "tested" here.'
        : null,
      // Only offer the force-deploy once the change is actually IN main — suggesting it
      // earlier would ship a sha that does not carry the change, which looks like progress
      // and is not. release-trigger ships a green pin within ~15 min on its own, so this is
      // the "you may not need to do anything" case; the lever exists for when you do.
      lever:
        !p.positions.deployed && p.positions.inMain
          ? 'PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute (or wait ≤15 min for release-trigger)'
          : null,
    });
  }

  // serving — P-003. Process truth, deliberately NOT derived from git. This is the
  // stage that separates "the bytes are on disk at the right sha" from "the process
  // answering requests has executed them", and it is the ONLY stage that can say
  // `past`. A change is live when BOTH are true: the code reached this host's source
  // (the deploy, for a release-checkout host — already `na` for a working-tree host,
  // which reads the tree directly) AND the process started after the code changed.
  const sv = p.serving;
  const codeReachedHost = releaseApplies ? p.positions.deployed : true;
  const servingHealth: StageHealth =
    sv.startedSinceCodeChange === false ? 'stalled' : sv.startedSinceCodeChange === true ? 'advancing' : 'unknown';
  const servingDetail = ((): string | null => {
    if (p.runtime && isFreshInvocationRuntime(p.runtime)) {
      return 'This is a fresh-invocation CLI: the next run loads the current staging-tree source directly, so no serving daemon restart is required.';
    }
    if (sv.startedSinceCodeChange === false) {
      const src =
        sv.codeAsOfSource === 'deploy'
          ? 'the last deploy'
          : sv.codeAsOfSource === 'file-mtime'
            ? 'this file changing on disk'
            : 'the code changing';
      const stale =
        `The process serving this code (${sv.unit}, pid ${sv.pid}) started ~${sv.behindMin}m BEFORE ${src} — ` +
        `it is executing an OLDER snapshot, so "deployed" here does NOT mean "running". `;
      // EI-19447523039740352: "Waiting cannot fix this" is FALSE while a deploy is
      // running — the deploy restarts this host itself, and firing the lever now is
      // a concurrent deploy against the shared release checkout. Say so instead.
      if (sv.restartSupersededBy) {
        const since = sv.restartSupersededBy.startedAtMs
          ? ` (started ${new Date(sv.restartSupersededBy.startedAtMs).toISOString()})`
          : '';
        return (
          stale +
          `A deploy is ALREADY RUNNING (${sv.restartSupersededBy.unit}${since}) and it restarts this host itself, ` +
          `so waiting IS the correct action. Do NOT fire ${sv.restartLever} — that is a second, concurrent deploy ` +
          `against the shared release checkout, which release:deploy refuses by design.`
        );
      }
      return stale + `Waiting cannot fix this; it takes a restart: ${sv.restartLever}.`;
    }
    if (sv.startedSinceCodeChange === null) {
      return sv.unknownReason ? formatCellUnknown(sv.unknownReason) : null;
    }
    if (!codeReachedHost) {
      // The process is current, but MY change hasn't reached its source yet — the
      // deployed stage owns that, so don't editorialise here.
      return null;
    }
    return `${sv.unit} (pid ${sv.pid}) started after the code it runs last changed, so it has actually loaded it.`;
  })();
  stages.push({
    name: 'serving',
    plane: 'delivery',
    position: codeReachedHost && sv.startedSinceCodeChange === true ? 'past' : 'pending',
    health: servingHealth,
    detail: servingDetail,
    // A restart is the lever ONLY once the code has actually reached this host — offering
    // it while the deploy is still pending would restart the process onto the SAME old
    // code and read as "I did the thing and nothing changed" (EI-11120's shape).
    //
    // ...and NOT while a deploy is mid-flight (EI-19447523039740352). This reuses the
    // existing `lever:null` semantics rather than adding a concept: chooseNextAction
    // turns a null lever into `nextAction:null`, which renderBlocked already prints as
    // "WAITING AT SERVING (nothing to do — this leg is advancing on its own)" — the
    // literally correct advice here, since the running deploy performs the restart.
    lever: codeReachedHost && sv.startedSinceCodeChange === false && !sv.restartSupersededBy ? sv.restartLever : null,
  });

  return stages;
}

/**
 * P-005: the single next lever, and which stage owns it.
 *
 * `stages[]` gives six position×health readings; this answers the question a caller
 * actually arrives with — "is my change live, and if not what is the ONE thing blocking
 * it". That task cost 11 tool calls and 4 hand-diffs on 2026-07-26 and still went wrong
 * twice, because deciding WHICH of six stages owns the next move was left to the reader.
 *
 * The first pending DELIVERY stage in source→live order is the blocker. The publish
 * side leg is deliberately excluded: origin/staging is a real durability/peer-visibility
 * signal, but the green-checkpoint resolves local `staging` and deploy resolves local
 * `main`, so a publish freeze cannot honestly answer "what blocks :3070 delivery?".
 * `na` stages are skipped because they are not on this change's activation route.
 *
 * THE THREE STATES ARE DISTINCT, and collapsing any two is the bug this must not have:
 *   blockedOn null, nextAction null  → nothing is pending; the change is live.
 *   blockedOn set,  nextAction null  → blocked, and WAITING IS CORRECT (a healthy leg
 *                                      between ticks). Inventing a lever here is worse
 *                                      than none: it manufactures busywork and, for the
 *                                      push/deploy legs, an unnecessary forced run.
 *   blockedOn set,  nextAction set   → blocked, and here is the one thing to do.
 */
export function deriveBlocker(stages: StageState[]): {
  blockedOn: StageName | null;
  nextAction: string | null;
  /** The stage `nextAction` belongs to — differs from `blockedOn` when a LATER stage is the actionable one. */
  actionOwner: StageName | null;
} {
  // Missing `plane` is treated as delivery for compatibility with callers compiled
  // against the pre-EI-193312 StageState shape. computeStages always emits it.
  const pending = stages.filter((s) => s.position === 'pending' && s.plane !== 'publish');
  if (!pending.length) return { blockedOn: null, nextAction: null, actionOwner: null };

  // `blockedOn` is where the change sits on the DELIVERY route. A later delivery stage
  // cannot advance until an earlier one has; a publish side leg is independent.
  const blockedOn = pending[0].name;

  // But the ACTION may belong further down. Caught by a live run: a change sitting at a
  // healthy `pushed` leg (git-sync pushes within ~10 min — genuinely "wait") with the gate
  // RED at 5 consecutive reds behind it reported nextAction: null, i.e. "nothing to do",
  // while a red gate held main for the whole fleet. That is a FALSE ALL-CLEAR on the one
  // thing the caller most owns ("the reds are yours to fix, not a queue to wait in").
  //
  // So scan the pending stages IN ORDER for the first real lever. An earlier stage's lever
  // still wins when it has one — you cannot usefully green a gate for a change that is not
  // committed yet — but a self-advancing leg no longer masks an actionable stage behind it.
  const owner = pending.find((s) => s.lever !== null) ?? null;
  return { blockedOn, nextAction: owner?.lever ?? null, actionOwner: owner?.name ?? null };
}

/**
 * EI-24049239243821100: the tree agents EDIT, which is what every working-tree read in
 * {@link gitPipelinePosition} is about (dirty status, the path's last commit, HEAD
 * containment, marker and mtime reads).
 *
 * `PAPERCUSP_INTEGRATION_ROOT` names the tree the PROCESS serves, and those are two
 * different trees on :3170: `50-staging-checkout.conf` points it at the committed
 * `papercusp-staging` mirror, on purpose, so the host runs committed code. Reading the
 * working tree there answered every question about the mirror — a path with an
 * uncommitted edit read clean and `live`. `PAPERCUSP_CANONICAL_TREE` is the explicit
 * edit-tree declaration the lock hooks already honor (coordination-domain.ts), and the
 * staging drop-in declares it. Where it is unset the serving tree IS the edit tree
 * (:3070, bg-host), so the integration root is the right answer there.
 */
export function resolveEditTreeRoot(integrationRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.PAPERCUSP_CANONICAL_TREE?.trim();
  return declared ? path.resolve(declared) : integrationRoot;
}

export interface PipelinePositionDeps {
  git?: GitRunner;
  /** EI-24040329952723202: override the per-call git read budget / clock. TESTS only — the default is the real budget. */
  gitReadBudget?: Pick<GitReadBudgetOptions, 'budgetMs' | 'now'>;
  /** EI-24049239243821100: the edit-tree resolution; defaults to {@link resolveEditTreeRoot}. */
  resolveEditTreeRoot?: (integrationRoot: string) => string;
  loadDeploy?: () => Promise<DevDeployState>;
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
  /**
   * P-003: when a systemd unit's main process started. Injected by TESTS only —
   * the default really probes (D-001). A null-by-default dep here would leave the
   * 4x-filed "deployed != running" gap unfixed while looking implemented, which is
   * the ship-it-dark failure this plan exists to avoid.
   */
  probeUnitStart?: (unit: string) => Promise<{ pid: number | null; startedAtMs: number | null } | null>;
  /**
   * WI-2141731: ask the serving process for its OWN build sha (`/api/health`).
   * Injected by TESTS only — the default really probes, for the same reason
   * `probeUnitStart` does. Fail-soft by contract: it resolves `null` on ANY
   * error, so a wedged host degrades this stage to today's inference instead of
   * hanging every `state:read` / `dev:pipeline_position` / `release:trace`.
   */
  probeServingHealthSha?: () => Promise<string | null>;
  /** WI-38455: boot-reported identity rows joined to the exact current process. */
  loadRuntimeVintage?: () => Promise<RuntimeVintageRow[]>;
  /** Injectable local hostname for the host+pid identity join. */
  localRuntimeHost?: string;
  /** P-001 (acceptance-runtime-plane): per-port `/api/health` sha for servingRuntimes. */
  probeHealthSha?: (port: number) => Promise<string | null>;
  /** WI-10005936: a bundling host's `/api/health` report of the bundle it booted. */
  probeHealthBundle?: (port: number) => Promise<ServingRuntimeBundleState | null>;
  /** P-001: `/proc/<pid>/cgroup`, to join a unit's child process to its runtime-vintage row. */
  readCgroup?: (pid: number) => Promise<string | null>;
  /** P-001: live psu sessions (each loaded psu-pty-host.mjs at its own launch). */
  listPtyHostInstances?: () => Promise<Array<{ pid: number; startedAtMs: number }> | null>;
  /** EI-19447523039740352: is a deploy running right now (so the serving restart lever is moot). */
  readDeployInFlight?: () => Promise<DeployInFlight>;
  /** P-003: mtime (ms) of a repo-relative file — what a working-tree tsx host would load. */
  fileMtimeMs?: (absPath: string) => Promise<number | null>;
  /**
   * P-004: the two gate candidates (in-flight run + what a fresh launch would judge).
   * Injected by TESTS only — the default really reads systemd + git, for the same
   * reason `probeUnitStart` does: a null-by-default dep would ship the containment
   * check dark while looking implemented.
   */
  resolveGateCandidates?: (root: string) => Promise<GateCandidates>;
  /**
   * EI-18793581783459047: the cached `dev.gitPipeline` derived-read's `activeRun`
   * leg + its `computedAt`. Injected by TESTS only — the default reads the real
   * derived-read cache (D-003: never a live compute/probe from this call; see the
   * `gate.checkpointRunInFlight` field doc for why a cache read is the right cost
   * tradeoff here, unlike `resolveGateCandidates` above which DOES fork systemctl).
   * Returns `null` on any failure or cache-miss — best-effort, never throws.
   */
  readCheckpointRunSnapshot?: () => Promise<{
    activeRun: GitPipelineSnapshot['activeRun'];
    computedAtMs: number | null;
  } | null>;
  /**
   * EI-19395922387569240: the LIVE run-lock liveness read that corrects the cached
   * `activeRun` above. Injected by TESTS only — the default really reads the lock, for
   * the same reason `probeUnitStart` and `readFileBytes` do: a null-by-default dep would
   * ship the correction dark while looking implemented, leaving `{ active: false }` still
   * claiming to be measured.
   *
   * This does NOT violate D-003 ("a reader never computes"). That rule's stated cost
   * objection is the systemctl FORK that `resolveGateCandidates` pays; this is one
   * `owner.json` read plus a `kill(pid,0)` — the very cost profile
   * `isCheckpointRunLockHeldCheap` was created for (WI-4310) and is already used on
   * system-health's every-computation path. Returns `null` on any failure — best-effort,
   * never throws, and a `null` degrades this leg to exactly its previous cache-only
   * behaviour rather than to a wrong answer.
   */
  readCheckpointRunLock?: (root: string) => Promise<CheckpointRunLockReading | null>;
  /**
   * EI-19327418148563597: raw bytes of a repo-relative file, for the release-content-drift
   * check (does the RELEASE checkout :3070 serves differ from the tree the caller is
   * reading?). Injected by TESTS only — the default really reads the filesystem, for the
   * same reason `fileMtimeMs` does: a null-by-default dep would ship the check dark while
   * looking implemented. Returns `null` (never throws) on any read failure — a missing file
   * is UNKNOWN, not evidence of a match or a mismatch.
   */
  readFileBytes?: (absPath: string) => Promise<Buffer | null>;
  /**
   * P-004: resolve WHO owns the gate's `green-stall:<harness>` condition. Injected
   * by TESTS only — the default really queries Postgres, deliberately, for the same
   * reason `readFileBytes` does: a null-by-default dep would ship the ownership
   * block dark while looking implemented. Fail-soft to `no-object`, never throws.
   */
  readGateOwnership?: () => Promise<CellOwnership>;
  /**
   * WI-1702869: resolve the failing-files-on-the-frozen-candidate answer. Injected by
   * TESTS only — the default really queries Postgres and really runs the blob compares,
   * for the same reason `readGateOwnership` does: a null-by-default dep would ship the
   * cell dark while looking implemented. Fail-soft; never throws.
   */
  readGateCandidateFailures?: typeof readGateCandidateFailures;
}

/**
 * Default checkpoint-run-in-flight read: the CACHED `dev.gitPipeline` derived-read
 * (recomputed on a routine tick, ttl 90s — derived-reads/producers.ts), never a
 * live systemd probe from this call (D-003: a reader never computes). Best-effort
 * in every direction — a registry miss, a stale-flag DB read failure, or the
 * producer module failing to import all degrade to `null` (UNKNOWN), never a
 * thrown error on the pipeline-position hot path.
 */
const realReadCheckpointRunSnapshot = async (): Promise<{
  activeRun: GitPipelineSnapshot['activeRun'];
  computedAtMs: number | null;
} | null> => {
  try {
    const { readDerivedSnapshot } = await import('./derived-reads/registry');
    await import('./derived-reads/producers'); // side-effect: registers the producer
    const snap = await readDerivedSnapshot<GitPipelineSnapshot[]>('dev.gitPipeline');
    const row = snap.payload?.[0];
    if (!row) return null;
    return { activeRun: row.activeRun ?? null, computedAtMs: snap.meta.computedAt };
  } catch {
    return null;
  }
};

/**
 * Default LIVE run-lock read (EI-19395922387569240): `isCheckpointRunLockHeldCheap` —
 * the ONE source that answers "is a green-checkpoint suite running right now" for BOTH
 * origins, because every run holds this same lock for its whole duration. Fork-free, and
 * fail-soft in every direction: a missing/unreadable lock file, a dead owner pid, or the
 * module failing to import all degrade to `null` (the cache-only path), never a throw on
 * the `dev:pipeline_position` hot path.
 *
 * `root` is `deploy.integrationRoot` — the SAME root `git-pipeline-stats` already passes
 * to `checkActiveCheckpointRun`, which matters because `checkpointRunLockDirMirror`
 * HASHES the root string: a different spelling would hash to a different lock dir and
 * report `held: false` forever, i.e. a silent false negative. The 2026-08-03 premise
 * ("both units export the identical `PAPERCUSP_INTEGRATION_ROOT`") stopped holding when
 * :3170 moved onto the `papercusp-staging` mirror (EI-22636310973765418); since
 * EI-24049239243821100 `root` is the canonical EDIT tree ({@link resolveEditTreeRoot}),
 * which is the tree bg-host's green-checkpoint uses as `cfg.integrationRoot` when it
 * ACQUIRES the lock — so both operators hash the same string again.
 */
interface CheckpointRunLockReading {
  held: boolean;
  elapsedSec: number | null;
  /** Positive liveness source. Clear readings remain run-lock measurements. */
  source?: 'run-lock' | 'process-authority';
  /** Approximate lock-owner start, derived from the same live elapsed reading. */
  startedAtMs?: number | null;
  /** Verified lock-owner PID, when the underlying probe can provide it. */
  pid?: number | null;
  processAuthority?: {
    workspace: string;
    harness: string;
    cgroupPath: string;
    pid: number;
  };
}

const realReadCheckpointRunLock = async (root: string): Promise<CheckpointRunLockReading | null> => {
  try {
    const { isCheckpointRunLockHeldCheap, readCheckpointProcessAuthorityCheap } =
      await import('./release-checkpoint-launch');
    const reading = isCheckpointRunLockHeldCheap(root);
    if (!reading.held) {
      const authority = await readCheckpointProcessAuthorityCheap(root);
      if (authority.probeFailed) return null;
      if (
        authority.active &&
        authority.pid !== null &&
        authority.cgroupPath &&
        authority.workspace &&
        authority.harness
      ) {
        return {
          held: true,
          elapsedSec: authority.elapsedSec,
          startedAtMs: authority.startedAtMs,
          pid: authority.pid,
          source: 'process-authority',
          processAuthority: {
            workspace: authority.workspace,
            harness: authority.harness,
            cgroupPath: authority.cgroupPath,
            pid: authority.pid,
          },
        };
      }
    }
    return {
      ...reading,
      source: 'run-lock',
      // The lock probe computes elapsedSec from owner.json's acquisition timestamp. Preserve
      // that same identity for the mapper instead of allowing a cached systemd run's start
      // timestamp to pair with this lock's elapsed reading.
      startedAtMs: reading.held && reading.elapsedSec != null ? Date.now() - reading.elapsedSec * 1000 : null,
    };
  } catch {
    return null;
  }
};

/**
 * How fresh BOTH a cached reading and the run it describes have to be for us to let the
 * cache stand against a `held: false` lock read. The producer's ttl is 90s and it recomputes
 * on every ~2min routine tick, so anything inside this window was observed by the systemctl
 * probe very recently.
 *
 * This window exists for ONE documented blind spot, not as general distrust of the lock:
 * `isCheckpointRunLockHeldCheap` "misses a manual-unit run that hasn't (yet) raced for
 * the shared run-lock" (its own doc). During that startup sliver the systemd probe sees a
 * run the lock does not, so a FRESH cached `active: true` for a run that is ITSELF still in
 * this startup window outranks `held: false`. A freshly-computed cache entry for a 120m-old
 * run is not startup evidence: after that run releases its lock, retaining the cached
 * `active` resurrects a finished run for 90s (EI-20444707119723892). Once either age exceeds
 * this window, the live lock wins.
 */
const CHECKPOINT_CACHE_TRUSTED_MS = 90_000;

/**
 * systemd's ExecMainStartTimestamp and the run-lock's acquisition timestamp are recorded at
 * adjacent points while the same process starts. They are not byte-identical, so allow a small
 * bounded skew when joining the two observations. A larger gap means a back-to-back run, not
 * clock noise, and cached detail must not be reused.
 */
const CHECKPOINT_RUN_IDENTITY_TOLERANCE_MS = 30_000;

/**
 * Pure: shape the cached `dev.gitPipeline` derived-read's `activeRun` + its
 * staleness into the `gate.checkpointRunInFlight` leg (EI-18793581783459047).
 * Separated from the cache read so the mapping is unit-testable without a DB.
 */
export function mapCheckpointRunInFlight(
  cached: { activeRun: GitPipelineSnapshot['activeRun']; computedAtMs: number | null } | null,
  nowMs: number = Date.now(),
  /**
   * WI-7035: the run's OWN published re-triage marker (`gate_health.inFlightRetriage`, already
   * freshness-checked by `parseInFlightRetriage`). AUTHORITATIVE when present — it is what the
   * running process published about itself, not something inferred about it from outside.
   *
   * Why this argument has to exist: the refire provenance carried on `activeRun`
   * (`refireObserved`/`initialCandidate`) is parsed from `/tmp/<unit>.log`, and ONLY manually-fired
   * runs write that log. A cron-fired run takes the `held_externally` branch of
   * `checkActiveCheckpointRun`, which returns before the log parse and reports the checkpoint
   * checkout's live HEAD instead. So on the cron path — the ordinary hourly gate — the tool could
   * never report a refire at all, which made CLAUDE.md's 🚨 "never fire a manual run inside the
   * re-triage window" rule unenforceable from the very tool agents are pointed at. Measured live
   * 2026-08-02: marker said `refireAttempt 1/2`, this leg emitted neither field.
   */
  retriage?: {
    fromCandidate: string;
    refiringCandidate: string;
    refireAttempt: number;
    maxRefires: number;
    /** EI-19343516395023183: the OTHER bound. `refireAttempt` advances only on a FAILED rescue, so
     *  a run whose rescues all succeed holds it at 0 while this climbs to `absoluteCeiling` — read
     *  either alone and you report budget remaining when there is none. Optional: a marker written
     *  before EI-19343532231631821 has neither. */
    totalRefires?: number;
    absoluteCeiling?: number;
  } | null,
  /**
   * EI-19395922387569240: the LIVE run-lock reading, or `null`/omitted when it could not be
   * taken (in which case this mapper behaves exactly as it did before — cache-only).
   * AUTHORITATIVE for liveness: it is an observation of NOW, pid-verified, and blind to
   * neither origin, whereas `cached` is a snapshot of unbounded age.
   */
  liveLock?: CheckpointRunLockReading | null,
  /**
   * EI-19931692050586322: the run's OWN published `inFlightCandidate` marker, already
   * freshness-checked by `parseInFlightCandidate`. Authoritative, exactly like `retriage` —
   * the difference is COVERAGE, not trust: `retriage` exists only after a refire, whereas this
   * is written at candidate-final time on every invocation, so it answers the common case of
   * an ordinary cron run on its first candidate. Without it that run could only ever be
   * reported as `'run-probe'`, which this tool itself labels not authoritative.
   *
   * Optional and nullable on purpose: the write is best-effort and swallows its own errors, so
   * a genuinely live run can publish nothing. Omitted/null simply falls through to the probe.
   */
  candidateMarker?: {
    candidate: string;
    refireDepth: number;
    quietCutApplied: boolean;
    pid: number;
    /** EI-20427717764878875. OPTIONAL so no existing caller or fixture constructing this narrowed
     *  shape is stranded; the real caller passes the fully-parsed marker, which always carries it. */
    verdictWrittenAtMs?: number | null;
  } | null,
): PipelinePosition['gate']['checkpointRunInFlight'] {
  const cachedRun = cached?.activeRun ?? null;
  // UNKNOWN only when BOTH reads are absent. Previously a missing cache alone forced this,
  // so a cold DB or a failed read left `dev:pipeline_position` unable to answer "is a run in
  // flight" at all — even though the lock could have answered it for free.
  if (!cachedRun && !liveLock) return null;

  const cacheAgeMs = cached && cached.computedAtMs !== null ? Math.max(0, nowMs - cached.computedAtMs) : null;
  const cachedActive = cachedRun?.active === true;
  const cacheIsTrusted = cacheAgeMs !== null && cacheAgeMs <= CHECKPOINT_CACHE_TRUSTED_MS;
  const cachedRunAgeMs = cachedActive
    ? cachedRun!.startedAtMs !== null
      ? Math.max(0, nowMs - cachedRun!.startedAtMs)
      : cachedRun!.elapsedSec !== null
        ? Math.max(0, cachedRun!.elapsedSec * 1000 + (cacheAgeMs ?? 0))
        : null
    : null;
  const cacheCoversStartup = cacheIsTrusted && cachedRunAgeMs !== null && cachedRunAgeMs <= CHECKPOINT_CACHE_TRUSTED_MS;

  // Liveness precedence. A held lock is positive, pid-verified evidence and always wins. A
  // NOT-held lock wins too, EXCEPT against a still-trusted cached `active` (the manual-run
  // startup sliver documented on CHECKPOINT_CACHE_TRUSTED_MS) — that one case is the only
  // way a run can exist that the lock cannot see.
  const lockDecides = liveLock != null && (liveLock.held || !(cachedActive && cacheCoversStartup));
  const active = lockDecides ? liveLock!.held : cachedActive;

  // Does the cached DETAIL describe the run we are now reporting? Comparing only `active`
  // aliases every active run to every other active run. In particular, a cache for run A can
  // be active while the live lock has already moved to run B, which used to mix A.startedAtMs
  // with B.elapsedSec. Join on the two run-start observations before reusing any cached detail;
  // an unjoinable live lock is deliberately UNKNOWN rather than permission to guess.
  const liveLockStartedAtMs =
    liveLock?.held === true
      ? Number.isFinite(liveLock.startedAtMs)
        ? (liveLock.startedAtMs as number)
        : liveLock.elapsedSec != null && Number.isFinite(liveLock.elapsedSec)
          ? nowMs - liveLock.elapsedSec * 1000
          : null
      : null;
  const cachedIdentityMatchesLiveLock =
    liveLock?.held !== true ||
    (cachedRun?.active === true &&
      cachedRun.startedAtMs !== null &&
      liveLockStartedAtMs !== null &&
      Math.abs(cachedRun.startedAtMs - liveLockStartedAtMs) <= CHECKPOINT_RUN_IDENTITY_TOLERANCE_MS);
  const cachedDescribesNow = cachedRun != null && cachedRun.active === active && cachedIdentityMatchesLiveLock;
  const candidate = cachedDescribesNow ? cachedRun!.candidate : null;
  // When a live lock answers, derive BOTH timing fields from that same lock identity. The
  // cached elapsed is frozen at cache-compute time and the cached start may belong to another
  // active run; using either beside the live lock would recreate the mixed-run verdict.
  const startedAtMs =
    liveLock?.held === true ? (liveLockStartedAtMs ?? null) : cachedDescribesNow ? cachedRun!.startedAtMs : null;
  const elapsedSec =
    liveLock?.held === true ? (liveLock.elapsedSec ?? null) : cachedDescribesNow ? cachedRun!.elapsedSec : null;
  // EI-19327704778173646: carry the refire provenance through. This destructure is
  // exact-field, so a new leg is DROPPED unless it is threaded explicitly — which is why
  // the marker never reached a caller before. Emitted only on an actual refire, so the
  // common (no-refire) shape is unchanged.
  // Gated on cachedDescribesNow for the same reason candidate/timings are: refire provenance
  // about a run the lock says is over is not provenance about anything current.
  const refireObserved = cachedDescribesNow && cachedRun!.refireObserved === true;
  // EI-21128357978208107: progress and phase are run detail, not liveness. Carry them only
  // when the cached detail is joined to the run currently reported above; otherwise a stale
  // cache can make an old run look like the live run's heartbeat/phase.
  const progressAtMs = active && cachedDescribesNow ? cachedRun!.progressAtMs : undefined;
  const currentPhase = active && cachedDescribesNow ? cachedRun!.currentPhase : undefined;
  const systemd = cachedDescribesNow ? cachedRun!.systemd : undefined;
  // Terminal marker/evidence are facts about the most recently finished unit, not detail
  // about the run that is active now. A live lock can release between the derived snapshot
  // and this read while the cached row still says `active:true`; applying the active-run
  // identity join to these immutable post-unit facts would erase the only evidence that an
  // external StopUnit cancelled the candidate. Keep them whenever the final liveness answer
  // is idle, while the candidate/timing/progress fields above remain identity-bound.
  const terminalMarker = !active && cachedRun?.terminalMarker !== undefined ? cachedRun.terminalMarker : undefined;
  const terminalEvidence = !active && cachedRun?.terminalEvidence ? cachedRun.terminalEvidence : undefined;
  // The marker only describes a LIVE run; attaching it to an idle probe would assert a refire
  // is in flight for a run that has already finished.
  const marker = active && retriage ? retriage : null;
  // EI-19931692050586322: same liveness gate, same reason — a candidate marker attached to a run
  // the lock says is over would assert that a finished run is judging something right now.
  // Consulted ONLY when there is no refire marker: a refire supersedes the candidate the run
  // started on, so `retriage` legitimately wins where both exist.
  const candMarker = active && !marker && candidateMarker ? candidateMarker : null;
  return {
    active,
    ...(systemd !== undefined ? { systemd } : {}),
    ...(terminalMarker !== undefined ? { terminalMarker } : {}),
    ...(terminalEvidence ? { terminalEvidence } : {}),
    // Emitted only when the lock answered, so the cache-only shape is byte-identical to before.
    ...(lockDecides ? { activeSource: liveLock?.source ?? ('run-lock' as const) } : {}),
    ...(active && liveLock?.source === 'process-authority' && liveLock.processAuthority
      ? { processAuthority: liveLock.processAuthority }
      : {}),
    // The marker is an observation the run published about ITSELF; `candidate` here is at best a
    // log read and at worst (cron) a live-worktree inference. Prefer the observation.
    candidate: marker ? marker.refiringCandidate : candMarker ? candMarker.candidate : candidate,
    ...(marker
      ? {
          candidateSource: 'retriage-marker' as const,
          inRetriageWindow: true as const,
          fromCandidate: marker.fromCandidate,
          refireAttempt: marker.refireAttempt,
          maxRefires: marker.maxRefires,
          // EI-19343516395023183: emitted only when the marker carries them, so the pre-
          // EI-19343532231631821 shape is unchanged and a caller can tell "0 refires" from
          // "this run predates the counter" instead of reading an invented 0.
          ...(typeof marker.totalRefires === 'number' ? { totalRefires: marker.totalRefires } : {}),
          ...(typeof marker.absoluteCeiling === 'number' ? { absoluteCeiling: marker.absoluteCeiling } : {}),
          // A refire IS a re-candidation, so this stays true on the cron path too — where the
          // log-derived flag below can never fire.
          refireObserved: true as const,
          initialCandidate: marker.fromCandidate,
        }
      : candMarker
        ? {
            // EI-19931692050586322: an OBSERVATION the run published about itself, so it
            // outranks the probe below exactly as the retriage marker does.
            candidateSource: 'in-flight-candidate' as const,
            // EI-20427717764878875: emitted UNCONDITIONALLY on this branch, null included. Omitting
            // it when null would collapse "this run is genuinely still deciding" into "no field
            // here", which is the one distinction the field exists to make — and the reader's next
            // move differs completely between them.
            verdictWrittenAtMs: candMarker.verdictWrittenAtMs ?? null,
            // `refireDepth > 0` IS a re-candidation the run reported. On the cron path the
            // log-derived `refireObserved` can never fire (only manual runs write that log),
            // so without this an in-process rescue stayed invisible whenever the refire marker
            // was absent — the same blind spot WI-7035 closed for the retriage half.
            ...(candMarker.refireDepth > 0 ? { refireObserved: true as const } : {}),
          }
        : {
            ...(candidate != null ? { candidateSource: 'run-probe' as const } : {}),
            ...(refireObserved
              ? { initialCandidate: cachedRun!.initialCandidate ?? null, refireObserved: true as const }
              : {}),
          }),
    startedAtMs,
    elapsedSec,
    ...(progressAtMs !== undefined ? { progressAtMs } : {}),
    ...(currentPhase !== undefined ? { currentPhase } : {}),
    // Still the CACHE's age (that is what the field documents), so it stays null when the
    // lock answered with no cache behind it — there is no cache to be stale.
    asOfAgeMs: cacheAgeMs,
  };
}

/**
 * Default gate-candidate resolution: the SAME functions `release:checkpoint-run`
 * itself uses, so this surface and that tool can never disagree about which commit
 * is being judged — a disagreement between them would recreate the exact
 * false-confidence this check exists to remove.
 *
 * Imported lazily: `release-checkpoint-launch` pulls in spawnSync/systemctl plumbing
 * that a sha-only or submodule probe never needs, and this module is on the hot path
 * of `dev:pipeline_position`.
 */
export const realResolveGateCandidates = async (root: string): Promise<GateCandidates> => {
  try {
    const { checkActiveCheckpointRun, currentCheckpointCandidate } = await import('./release-checkpoint-launch');
    const { runSyncWithAsyncExec, execFileResultShared } = await import('./sync-exec-replay');
    // WI-10005261: these probes are sync and exec-injected. A spawnSync exec here blocked the
    // operator main thread (98.6% of a measured sentinel stall), so they run under
    // record/replay: every git/systemctl call goes through async execFile, and the final pass
    // is a faithful re-execution against the fetched results.
    const { value } = await runSyncWithAsyncExec(
      (execFn) => {
        const active = checkActiveCheckpointRun(root, execFn);
        // checkActiveCheckpointRun ALREADY resolves the quiet-cut candidate internally (it
        // spreads `...current` into its result) whenever a run is active — only pay for the
        // second resolution when it did not, or this hot path (CLAUDE.md points agents here
        // for "is my edit live") runs the same 4-5 git reads twice per call.
        const nextCandidateSha =
          active.current_candidate !== undefined
            ? active.current_candidate
            : currentCheckpointCandidate(root, execFn).current_candidate;
        return {
          // Only a genuinely ACTIVE run has a judging sha. `current_candidate` describes a
          // HYPOTHETICAL fresh launch and must never be reported as "what is being judged"
          // (EI-18695275971973546 cost a wrong fleet-wide broadcast to that exact conflation).
          judgingSha: active.active ? (active.candidate ?? null) : null,
          nextCandidateSha,
        };
      },
      // EI-24852529885337741: concurrent callers repeat these exact git reads in ~1 s bursts;
      // the shared memo gives each argv one child per 2 s.
      (cmd, args) => execFileResultShared(cmd, args, { timeout: GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS }),
    );
    return value;
  } catch {
    return { judgingSha: null, nextCandidateSha: null };
  }
};

/** Default unit-start probe: the shared systemd probe, mapped into ms. */
/** EI-19447523039740352. Never throws: an unreadable systemd degrades to
 *  `source:'systemd-unavailable'`, which evaluateServing reads as UNKNOWN (keeps the lever). */
const realReadDeployInFlight = (): Promise<DeployInFlight> => readDeployInFlight();

// WI-10550: `resolveServiceStartMs` prefers the probe's MEASURED /proc start over
// the `etimes`-derived one. That derivation is biased LATE (whole-second truncation
// + a Date.now() read after the probe's subprocesses return — 0.6-0.76s under load
// on this host), and a late-looking start makes `runningYourCode = startedAtMs >
// codeAsOfMs` more likely TRUE. This detector exists to refuse exactly that
// unearned YES, so the derivation is a fallback for hosts without /proc, never a
// preference. Preference order + rationale live on the helper.
const probeUnitStartUncached = async (unit: string): Promise<{ pid: number | null; startedAtMs: number | null } | null> =>
  // EI-24356772206513832: this diagnostic already keeps its release Git reads
  // local. A failed spawner-sidecar startup otherwise adds its 10s timeout to
  // the systemd probe before it falls back to the same local command. Several
  // unit probes share this read, so use the bounded local exec path directly.
  resolveServiceStartMs(await probeServiceStart(unit, (command, args, options) => pexec(command, args, options)), Date.now());

/**
 * jev-memory-timeouts-to-zero-2026-10-01 D-001: ONE unit-start probe per unit per
 * {@link UNIT_START_PROBE_TTL_MS}, shared by every concurrent caller.
 *
 * One `gitPipelinePosition({ path })` probes the serving unit, every
 * GENERATION_HOSTS unit, and the serving-runtime census, and
 * `deploymentPositionForEvidence` runs up to 12 paths in parallel. Unmemoized,
 * that was ~10 local forks per path (systemctl + ps per unit). Each fork froze a
 * 1.5-4 GB operator's event loop for 16-55 ms (bpftrace 2026-10-01: 30 systemctl
 * + 30 ps in 30 s on :3170, 6.0 s of a 60 s window frozen in one :3070 worker).
 * Soft TTL = hard TTL, so an expired entry is re-probed BLOCKING and is never
 * served stale. Within the 2 s window a just-restarted unit can still read its
 * previous start, which errs toward "not yet running your code", the
 * conservative direction for this detector. Null results are cached too
 * (`cacheEmpty`), so an unreadable systemd is not re-forked per path.
 */
export const UNIT_START_PROBE_TTL_MS = 2_000;

const unitStartProbe = pinModuleState('@papercusp/operator-core.git-pipeline-position.unit-start-probe', () => ({
  cache: createCache(),
}));

/** Memoized unit-start probe; `uncached` is injectable for tests. */
export function probeUnitStartShared(
  unit: string,
  uncached: (unit: string) => Promise<{ pid: number | null; startedAtMs: number | null } | null> = probeUnitStartUncached,
): Promise<{ pid: number | null; startedAtMs: number | null } | null> {
  return unitStartProbe.cache.getOrSet('host-local', `unit-start:${unit}`, () => uncached(unit), {
    softTtlMs: UNIT_START_PROBE_TTL_MS,
    hardTtlMs: UNIT_START_PROBE_TTL_MS,
    cacheEmpty: true,
  });
}

const realProbeUnitStart = (unit: string): Promise<{ pid: number | null; startedAtMs: number | null } | null> =>
  probeUnitStartShared(unit);

/** Test-only: drop memoized unit-start probes. */
export function resetUnitStartProbeCacheForTest(): void {
  unitStartProbe.cache = createCache();
}

/**
 * WI-2141731 — the release operator's own `/api/health` origin.
 *
 * Scoped to `operator-release` ON PURPOSE, and it is the one host whose sha is
 * real evidence:
 *  - it is the host the `deploy.3070.sha` cell is ABOUT, so it is the only one
 *    with a deployed sha to compare against; and
 *  - `/api/health` is served by the non-bundled operator, whose entrypoint warms
 *    `getBuildInfo()` at module load. A BUNDLED host (bg-host) deliberately
 *    reports `sha: null` rather than the checkout's HEAD (EI-21647996938145436),
 *    so probing one could only ever return null anyway.
 * Probing the others would invent port mappings for no obtainable answer.
 */
const SERVING_HEALTH_URL = 'http://127.0.0.1:3070/api/health';
/** Long enough for a healthy loopback answer, short enough that a wedged :3070
 *  cannot become latency in every pipeline read. */
const SERVING_HEALTH_TIMEOUT_MS = 1_000;
/** Cheap in-process memo. The resolver is called repeatedly (often several times
 *  per agent turn) and a deploy cannot land inside this window, so re-probing
 *  buys nothing and only multiplies the failure surface. */
const SERVING_HEALTH_TTL_MS = 5_000;
let servingHealthCache: { atMs: number; sha: string | null } | null = null;

/**
 * Default health-sha probe. FAIL-SOFT IS THE WHOLE CONTRACT: every path —
 * timeout, refused connection, non-200, unparseable body, missing field —
 * resolves `null`, which the verdict reads as "no direct evidence" and falls
 * back to the start-time inference. It must be impossible for this to throw or
 * hang, because it sits under `state:read`, `dev:pipeline_position` and
 * `release:trace`.
 *
 * (Not `probeHttpReachable`: that helper answers REACHABILITY and discards the
 * body we need, and its escalating retries run to ~8.75s — the opposite of the
 * bounded single attempt a hot resolver can afford.)
 */
const realProbeServingHealthSha = async (): Promise<string | null> => {
  const now = Date.now();
  if (servingHealthCache && now - servingHealthCache.atMs < SERVING_HEALTH_TTL_MS) return servingHealthCache.sha;
  let sha: string | null = null;
  try {
    const res = await fetch(SERVING_HEALTH_URL, { signal: AbortSignal.timeout(SERVING_HEALTH_TIMEOUT_MS) });
    if (res.ok) {
      const body: unknown = await res.json();
      const raw = (body as { sha?: unknown } | null)?.sha;
      sha = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    }
  } catch {
    sha = null;
  }
  servingHealthCache = { atMs: now, sha };
  return sha;
};

/** Test-only — drop the health-sha memo so a case cannot inherit a peer's probe. */
export function _resetServingHealthCacheForTest(): void {
  servingHealthCache = null;
}

/** Default file-mtime reader. Fail-soft: an unreadable path is UNKNOWN, never 0. */
const realFileMtimeMs = async (absPath: string): Promise<number | null> => {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(absPath)).mtimeMs;
  } catch {
    return null;
  }
};

/** Default file-bytes reader (EI-19327418148563597). Fail-soft: an unreadable path is
 *  UNKNOWN (null), never an empty buffer — an empty buffer would read as a real, matching
 *  0-byte file rather than "could not read this". */
const realReadFileBytes = async (absPath: string): Promise<Buffer | null> => {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(absPath);
  } catch {
    return null;
  }
};

/**
 * EI-19327418148563597: while a red gate blocks deploys, `:3070`'s release checkout can
 * lag the staging tree by HOURS, not the usual ~15 minutes — long enough that profiling
 * the live box measures pre-fix code while the fix already sits, verified, in the tree
 * open in front of you (three separate targets turned out to be exactly this on
 * 2026-08-02, one of them ~90% of live DB time). Pure byte comparison: `differs: true`
 * means whatever `:3070` served for this path when read is NOT what the working tree
 * holds for it. `differs: null` means one or both reads failed/were skipped — never
 * reported as a match, since an unreadable release copy is not evidence it is identical.
 */
export function evaluateReleaseContentDrift(args: { workingBytes: Buffer | null; releaseBytes: Buffer | null }): {
  differs: boolean | null;
} {
  const { workingBytes, releaseBytes } = args;
  if (workingBytes === null || releaseBytes === null) return { differs: null };
  return { differs: !workingBytes.equals(releaseBytes) };
}

/**
 * EI-18715870370005934: resolve the GITLINK a superproject commit pins for a
 * submodule — `git ls-tree <superSha> <submodulePath>` => `160000 commit <sha>`.
 *
 * This is the half of the check that nobody hand-composes correctly. A
 * superproject commit does NOT contain submodule file content, only a gitlink,
 * so every naive cross-boundary probe (`git show <superSha>:<submodulePath>`,
 * `git status --porcelain <submodulePath>`, `git log -- <submodulePath>`)
 * returns EMPTY — which reads as "absent" / "clean" rather than "wrong question".
 * The failure mode is an ABSENCE THAT READS AS EVIDENCE, and both wrong answers
 * are the safe-sounding ones, so they compose into a confident false negative
 * ("my instrumentation isn't in this build — abort the run").
 */
async function resolveSubmodulePin(
  git: GitRunner,
  root: string,
  superSha: string,
  submodulePath: string,
): Promise<string | null> {
  const pin = await readSubmodulePin(git, root, superSha, submodulePath);
  return pin?.sha ?? null;
}

/**
 * Read a superproject ref's submodule gitlink without collapsing a failed read
 * into a measured absence. `null` means git failed; `{ sha: null }` means the
 * ref was read successfully but carries no gitlink at this path.
 */
async function readSubmodulePin(
  git: GitRunner,
  root: string,
  superRef: string,
  submodulePath: string,
): Promise<{ sha: string | null } | null> {
  const out = await git(root, ['ls-tree', superRef, submodulePath]);
  if (out === null) return null;
  const m = /^160000\s+commit\s+([0-9a-f]{7,40})\b/.exec(out.trim());
  return { sha: m?.[1] ?? null };
}

/**
 * P-006: paths out of `git status --porcelain`. A record is `XY <path>`, and a rename
 * is `XY <old> -> <new>` — take the NEW path, since that is what the sweep commits.
 *
 * It must NOT slice fixed columns, and this is not fastidiousness — a `slice(3)`
 * version shipped and lost the first character of the first path on the very first
 * live probe (`ackages/operator-core/...`). Cause: `realGit` returns `stdout.trim()`,
 * so the leading space of an unstaged ` M path` record survives on every line EXCEPT
 * the first, where the trim ate it. No fixture could catch that — fixtures do not go
 * through realGit — and the corruption is silent: a plausible-looking path that simply
 * is not the file.
 *
 * The trim stays (every other caller of realGit depends on it); the tolerance belongs
 * here. Matching the status FIELD instead of a column offset handles ` M x`, `MM x`,
 * `?? x`, `R  a -> b` and the trimmed `M x` alike — the {1,2} backtracks when the
 * second character turns out to be the start of the path rather than a status flag.
 */
export function parsePorcelainPaths(out: string): string[] {
  const RECORD = /^([ MADRCU?!]{1,2}) (.*)$/;
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .map((l) => RECORD.exec(l)?.[2] ?? null)
    .filter((rest): rest is string => rest !== null && rest.length > 0)
    .map((rest) => {
      const arrow = rest.indexOf(' -> ');
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, '');
    })
    .filter((p) => p.length > 0);
}

/** Parse `.gitmodules` submodule paths (best-effort). */
async function submodulePaths(git: GitRunner, root: string): Promise<string[]> {
  const out = await git(root, ['config', '--file', '.gitmodules', '--get-regexp', 'path']);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((p): p is string => !!p);
}

/** Pure: render the one-line human summary from the resolved facts. */
/**
 * P-003: what the summary is allowed to say after `deployed ✓`.
 *
 * This used to be an unconditional ` (live)` derived from `positions.deployed` —
 * a GIT fact stating a PROCESS conclusion. That one word is the thing four agents
 * independently filed: it reads as "your change is running" when the serving
 * process may have booted long before the deploy and still be executing older
 * code. Never claim "live" without process evidence.
 */
function servingNote(p: Pick<PipelinePosition, 'positions' | 'serving'>): string {
  const sv = p.serving;
  if (sv.startedSinceCodeChange === false) {
    // EI-19447523039740352: mid-deploy, the honest note is "wait", not the lever.
    if (sv.restartSupersededBy) {
      return ` ⚠ not live YET — ${sv.unit} has been up ~${sv.behindMin}m longer than the code it serves, but a deploy (${sv.restartSupersededBy.unit}) is ALREADY RUNNING and restarts it; wait, do not fire a second deploy`;
    }
    return ` ⚠ but NOT LIVE — ${sv.unit} has been up ~${sv.behindMin}m longer than the code it serves (still running the older snapshot; ${sv.restartLever})`;
  }
  if (!p.positions.deployed) return '';
  if (sv.startedSinceCodeChange === true) return ' (live — the serving process started after this code landed)';
  return ' (deployed, but whether the serving process has loaded it is UNKNOWN — not confirmed live)';
}

/**
 * P-006: the one-line form of `sweepExposure` — empty unless the sweep would take MORE
 * than this one file, because only then is there something the reader does not already
 * know from "+uncommitted edits".
 */
function sweepClause(sweep: SweepExposure): string {
  if (!sweep.exposed || sweep.dirtyPathCount === null || sweep.dirtyPathCount <= 1) return '';
  const when =
    sweep.nextSweepInMs === null
      ? 'next git-sync tick'
      : sweep.nextSweepInMs < 60_000
        ? 'next git-sync tick (DUE — under a minute)'
        : `next git-sync tick (~${Math.round(sweep.nextSweepInMs / 60_000)} min)`;
  return ` — SWEEP-EXPOSED: the ${when} commits all ${sweep.dirtyPathCount} dirty paths as ONE auto-commit, and the gate can cut its candidate there and judge that intermediate`;
}

/**
 * P-005: the lead clause — the answer to "is my change live, and if not what is the one
 * thing blocking it", placed FIRST because that is the question the caller arrived with.
 *
 * Everything after it is supporting evidence. The old summary opened with a row of ticks,
 * which is a state DUMP: correct, complete, and leaving the reader to work out which of
 * six positions owns their next move. That derivation is exactly what went wrong twice on
 * 2026-07-26.
 */
function leadClause(p: Omit<PipelinePosition, 'summary'>): string {
  if (!p.blockedOn) {
    const publishPending = p.stages.some((stage) => stage.name === 'pushed' && stage.plane === 'publish' && stage.position === 'pending');
    return publishPending ? 'DELIVERY LIVE — ' : '';
  }
  // A clean tree with a target commit that is not reachable from HEAD is a
  // detached/remote candidate, not an uncommitted local change. Calling this
  // "AT COMMITTED" (or "WAITING AT COMMITTED") reads the false boolean as an
  // affirmative position and sends the caller looking at the wrong lever.
  // Name the measured condition directly; there is no local action until HEAD
  // contains the target.
  if (
    p.blockedOn === 'committed' &&
    !p.positions.committedLocal &&
    !p.dirtyUncommitted &&
    !p.positionsUnknown.includes('committedLocal')
  ) {
    return p.nextAction
      ? `WAITING FOR HEAD CONTAINMENT → ${p.nextAction}. `
      : 'WAITING FOR HEAD CONTAINMENT (target commit is not reachable from HEAD; nothing to do locally). ';
  }
  const at = p.blockedOn.toUpperCase();
  if (p.blockedOn === 'gate' && p.gate.pause) {
    // P-004: carry the SAME standing banner the gate detail renders — this is the one
    // line a caller reads before deciding whether the gate is failing or merely off,
    // and it must name the holder and the auto-resume deadline, not just the reason.
    // Appended after the existing phrase for the same reason as `pauseDetail` above.
    const reason = p.gate.pause.reason ? `: ${p.gate.pause.reason}` : '';
    return (
      `BLOCKED AT GATE — green-checkpoint is DELIBERATELY PAUSED (active:false)${reason}; no scheduled fire can occur until the hold is resumed. ` +
      (p.gate.fireStaleReason ? `${p.gate.fireStaleReason} ` : '')
    );
  }
  if (!p.nextAction) {
    // EI-22162745262638300: a measured gate wait is only a release-plane wait.
    // The implementation/acceptance plane remains usable on staging/current-build,
    // so a bare "nothing to do" sentence strands work that does not need main/:3070.
    if (p.blockedOn === 'gate') {
      return (
        'WAITING AT GATE (the release verdict is advancing on its own). ' +
        'Continue implementation and non-final verification on staging/current-build; ' +
        'wait for this gate only for final shipment or a deployed-only check. '
      );
    }
    return `WAITING AT ${at} (nothing to do — this leg is advancing on its own). `;
  }
  // When the lever belongs to a LATER stage than where the change sits, say both: "the leg
  // you are on is fine, but this one is not". Collapsing them would either hide that the
  // change is still upstream, or hide that something downstream is actionable now.
  const owner = p.stages.find((s) => s.lever === p.nextAction && s.position === 'pending');
  return owner && owner.name !== p.blockedOn
    ? `AT ${at} (advancing on its own) — but ${owner.name.toUpperCase()} IS BLOCKED → ${p.nextAction}. `
    : `BLOCKED AT ${at} → ${p.nextAction}. `;
}

/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-001: when the change is ALREADY
 * executing on a runtime other than the release operator, say so FIRST — before any
 * gate/deploy prose — because that is the fact that decides whether the reader waits.
 * `servingRuntimesLead` returns null whenever it has nothing to add, so every other
 * summary is unchanged.
 */
export function summarizePosition(p: Omit<PipelinePosition, 'summary'>): string {
  const lead = servingRuntimesLead(p.servingRuntimes);
  const body = summarizePositionBody(p);
  return lead ? `${lead}${body}` : body;
}

function summarizePositionBody(p: Omit<PipelinePosition, 'summary'>): string {
  const tick = (b: boolean) => (b ? '✓' : '✗');
  const label = p.input.path ?? p.input.sha ?? '(none)';
  if (!p.targetSha) {
    return `${label}: no commit found${p.dirtyUncommitted ? ' (uncommitted edits present, not yet committed)' : ''}.`;
  }
  const subj = p.targetSubject ? ` "${p.targetSubject.slice(0, 60)}"` : '';
  // P-006: the bare "+uncommitted edits" is true but reads as a note about ONE file.
  // When the sweep would take several, that is a different fact — a broken intermediate
  // can be committed and judged — and it belongs in the one line most readers stop at.
  // Rendered into `dirty` rather than appended at the end so EVERY summary branch
  // (submodule, non-release runtime, the main line) carries it without three edits.
  const dirty = p.dirtyUncommitted ? ` ⚠ +uncommitted edits${sweepClause(p.sweepExposure)}` : '';

  // WI-5440: a path with MULTIPLE consumers on different activation routes —
  // naming only one (the old single-`runtime` behavior) can confidently route
  // an activation decision the WRONG way for whichever consumer isn't named.
  // Lead with the split itself; per-consumer detail lives in `runtimes`.
  if (p.runtimes && p.runtimes.length > 1) {
    const hosts = p.runtimes.map((r) => r.host).join(' + ');
    return `${label} @${p.targetShortSha}${subj}: MULTIPLE CONSUMERS on different activation routes (${hosts}) — see \`runtimes\` for each one's own host + activation; do not assume a single deploy or restart activates ALL of them.${dirty}`;
  }

  // EI-10895: for a path the release pipeline does NOT carry, the deploy ticks are
  // not just noise — a `deployed ✗` reads as "still stuck in the pipeline" and sends
  // the agent off to wait for a deploy that can never activate the code. Lead with
  // the ACTIVATION instead, and demote the git ticks to what they actually mean here
  // (durability + peer visibility, not liveness).
  if (p.runtime && !p.runtime.releasePipelineApplies) {
    // P-003: for a working-tree host the ONLY question that matters is whether it
    // has restarted since this file changed — the git ticks cannot answer it, and
    // this is the exact shape of the bg-host-runs-stale-routine-code class.
    const sv = p.serving;
    const live = isFreshInvocationRuntime(p.runtime)
      ? ' ✓ fresh-invocation route: the next run loads the current staging-tree source directly; no host restart is required.'
      : sv.startedSinceCodeChange === false
        ? ` ⚠ RUNNING STALE: ${sv.unit} started ~${sv.behindMin}m before this file last changed on disk, so the host is still executing the OLD version — ${sv.restartLever}.`
        : sv.startedSinceCodeChange === true
          ? ` ✓ ${sv.unit} started after this file last changed, so the running host has loaded it.`
          : '';
    // EI-18752644493166307: the parenthetical below used to end at "even an uncommitted
    // edit is what it loads on restart" — true for the RESTART consumer, and read by an
    // agent as blanket permission to fire the gate dirty. The green-checkpoint is a
    // SECOND consumer of the same file and judges a COMMITTED candidate, so for IT an
    // uncommitted edit is invisible. One reassurance, two consumers, opposite answers:
    // qualify it rather than letting the true half cover the false one.
    const freshInvocation = isFreshInvocationRuntime(p.runtime);
    const gateBlind =
      p.dirtyUncommitted && !freshInvocation
        ? ' ⚠ but the GREEN GATE is a different consumer of this same file and judges a COMMITTED candidate — your uncommitted edit is INVISIBLE to it, so a gate run fired now tests the code WITHOUT it (commit first: git-sync:run).'
        : '';
    const sourceRead = freshInvocation
      ? 'the next invocation reads THIS TREE directly, including an uncommitted edit.'
      : 'the running host reads THIS TREE, so even an uncommitted edit is what it loads on restart.';
    return `${label} @${p.targetShortSha}${subj}: runs in ${p.runtime.host} — NOT carried by the staging→main→:3070 deploy.${live} ${
      p.runtime.activation
    } (git position: committed ${tick(p.positions.committedLocal)} · staging ${tick(
      p.positions.onStaging,
    )}${dirty} — durability/peer-visibility only; ${sourceRead})${gateBlind}`;
  }

  if (p.submodule) {
    // EI-18715870370005934: when the reported sha is NOT the sha the caller asked
    // about (they passed a superproject commit; we resolved its gitlink), say so
    // in the one line most readers stop at — a silent substitution here is the
    // same confidently-wrong reading this fix exists to prevent.
    const pin = p.submodulePin
      ? ` — superproject ${p.submodulePin.superprojectSha.slice(0, 9)} PINS submodule commit ${p.submodulePin.submoduleSha.slice(0, 9)}; positions are for the PINNED commit, not the superproject one (the superproject holds only a gitlink, so \`git show\`/\`git status\` on this path from the root return empty and read as "absent"/"clean")`
      : '';
    return `${label} @${p.targetShortSha}${subj} [submodule ${p.submodule}]: committed ${tick(
      p.positions.committedLocal,
    )} · staging-candidate ${tick(p.positions.onStaging)}${dirty} — superproject→main→deploy chain not tracked for submodule paths.${pin}`;
  }
  // EI-18719549079738452: a torn git-sync candidate (impl + its matching fixture
  // landing as two separate commits) can red a scheduled run whose failure does
  // not reproduce at tip — the retriage machinery (green-checkpoint.ts's
  // classifyRedAgainstTip) recognizes this and works to auto-refire, but while
  // that plays out `gate.consecutiveReds` reads 0 / `gate.stalled` reads false
  // (the LAST *recorded* verdict was clean, or none has landed yet this cycle) —
  // so the three branches above all fall through to '', and the summary reads
  // as fully healthy while `main` sits behind the latest green pin. That silent
  // combination is what turned a bounded, self-healing retriage window into an
  // invisible ~2h stall on 2026-07-26 (the incident this note is named for) —
  // nothing in the one-line summary told a reader "green" and "not advancing"
  // were BOTH true at once. Name the combination instead of staying silent on it.
  const gateNote =
    !p.positions.inMain && p.gate.stalled === null && p.gate.pause == null
      ? ' (green gate STALL STATUS UNKNOWN — the condition or watchdog inputs were not fully measured)'
      : !p.positions.inMain && p.gate.pause
        ? ` (green gate DELIBERATELY PAUSED: ${p.gate.pause.reason ?? 'no pause reason recorded'})`
      : !p.positions.inMain && p.gate.fireStale
      ? ` (green gate WEDGED — not firing: ${p.gate.fireStaleReason ?? 'stale'})`
      : !p.positions.inMain && p.gate.stalled
        ? ` (green gate STALLED: ${p.gate.consecutiveReds} reds)`
        : !p.positions.inMain && p.gate.consecutiveReds > 0
          ? ` (gate red: ${p.gate.consecutiveReds})`
          : // WI-6357 / EI-18790908999972569: gated on BUFFER AGE, not mere existence — a
            // nonzero buffer is the fleet's normal steady state (see MAIN_BUFFER_STALL_MS),
            // so the un-aged version of this check fired on virtually every healthy call
            // and taught readers to scroll past the exact combination it exists to catch.
            !p.positions.inMain &&
              p.gate.consecutiveReds === 0 &&
              mainBufferIsStale({
                gate: p.gate,
                mainFastForwarded: p.verdictProvenance.mainFastForwarded,
                stagingBufferAgeMs: p.verdictProvenance.stagingBufferAgeMs,
              })
            ? ` (gate reports 0 reds, but main has NOT fast-forwarded to the last green pin ${
                p.verdictProvenance.lastGreenShortSha ?? '?'
              } for over ${Math.round(MAIN_BUFFER_STALL_MS / 3_600_000)}h — may be an in-flight retriage/refire or another hold consecutiveReds doesn't capture; not necessarily broken, but don't read this as fully healthy)`
            : '';
  // P-004: when the judged candidate provably lacks this file's content, that outranks
  // every tick above it — the ticks describe where the change IS, this describes whether
  // the verdict about to land is even about it. Appended last so it is the final thing
  // read, which is where a caller stops.
  // EI-18797292094433710: a marker that CONFIRMS containment is still worth saying — the
  // caller asked — but it is reassurance, not a warning, and rendering it behind ⚠ would
  // re-create the alarm this fix exists to silence.
  const cicSum = p.changeInCandidate;
  /**
   * EI-19325709344484737: a PARTIAL marker (judged carries fewer occurrences than tip) is
   * a WARNING, not reassurance. Rendering it behind ✓ is precisely how a candidate that
   * lacked the fix read as an all-clear — the ✓ is the glyph a hurried caller stops at.
   */
  const markerPartial = markerPartialAgainst(cicSum.markerJudging, cicSum.markerNext);
  const judgedContainmentRefused = cicSum.judgingShaSource === 'run-probe' && cicSum.judgingSha !== null;
  const markerConfirmed =
    !judgedContainmentRefused &&
    !markerPartial &&
    (cicSum.markerJudging?.present === true || (!cicSum.judgingSha && cicSum.markerNext?.present === true));
  const markerDenied =
    cicSum.markerJudging?.present === false || (!cicSum.judgingSha && cicSum.markerNext?.present === false);
  const candidateNote = judgedContainmentRefused
    ? ` ⚠ ${cicSum.detail}`
    : markerConfirmed
      ? ` ✓ ${cicSum.detail}`
      : markerPartial || markerDenied || cicSum.judgingContainsPath === false || cicSum.nextContainsPath === false
        ? ` ⚠ ${cicSum.detail}`
        : '';
  const publishStage = p.stages.find((stage) => stage.name === 'pushed');
  const publishSideLeg = publishStage?.plane === 'publish';
  const publishState = publishSideLeg
    ? p.positions.onStaging
      ? `origin-publish ${tick(true)}`
      : `origin-publish ${tick(false)} (${(publishStage?.health ?? 'unknown').toUpperCase()} ` +
        `PUBLISH/DURABILITY side leg — peer visibility and off-box recovery are at risk; ` +
        `local staging→main→:3070 delivery is unaffected${
          publishStage?.lever ? `; publish remedy: ${publishStage.lever}` : ''
        })`
    : `staging ${tick(p.positions.onStaging)}`;
  return `${leadClause(p)}${label} @${p.targetShortSha}${subj}: committed ${tick(p.positions.committedLocal)} · ${publishState} · main ${tick(p.positions.inMain)}${gateNote} · deployed ${tick(p.positions.deployed)}${servingNote(
    p,
  )}${dirty}.${candidateNote}`;
}

export async function gitPipelinePosition(
  inp: PipelinePositionInput,
  deps: PipelinePositionDeps = {},
): Promise<PipelinePosition> {
  const baseGit = deps.git ?? realGit;
  // This is a read-only diagnostic hot path.  Do not lazily boot or queue behind
  // the host spawner sidecar while resolving the release refs: when the checkpoint
  // gate is already stalled, that IPC hop can hold the whole pipeline-position read
  // until the MCP deadline.  The release status/trace readers use the same local-git
  // policy; keep the defaults here aligned so the primary diagnostic cannot wedge
  // while reporting on the wedge (EI-21306970701615848).
  const loadDeploy = deps.loadDeploy ?? (() => devDeployState({ useSpawnerSidecar: false }));
  const loadSnapshot =
    deps.loadSnapshot ?? (() => gitPipelineSnapshot(undefined, { useSpawnerSidecar: false }));

  const notes: string[] = [];
  // EI-24040329952723202: ONE de-duplicating, budgeted git runner for this whole call — identical
  // reads share a subprocess and, once the total budget is spent, later reads resolve null (UNKNOWN).
  const gitBudgetMs = deps.gitReadBudget?.budgetMs ?? GIT_PIPELINE_POSITION_TOTAL_BUDGET_MS;
  const { git } = withGitReadBudget(baseGit, {
    ...deps.gitReadBudget,
    onExhausted: () =>
      notes.push(
        `Git read budget (${Math.round(gitBudgetMs / 1000)}s) was spent mid-read: later git reads were NOT run, so the legs that needed them read UNKNOWN (never "not contained"). Re-call when the host is less contended.`,
      ),
  });
  // EI-21544761852770720: these are independent read-only snapshots, but this hot
  // path historically awaited them in series.  On a busy host each can take
  // several seconds, leaving `state:read` with almost no margin under its 10s
  // totality bound.  Start both together; every downstream consumer still sees
  // one settled deploy snapshot and one settled pipeline snapshot from this call.
  const [deploy, snap] = await Promise.all([loadDeploy(), loadSnapshot()]);
  // EI-24049239243821100: every read below asks about the tree agents EDIT (dirty
  // status, the path's last commit, HEAD containment, marker and mtime reads).
  // `deploy.integrationRoot` answers a different question — the tree THIS process
  // serves — and on :3170 that is the clean `papercusp-staging` mirror, so every
  // working-tree read there described the mirror and an edited path read clean + live.
  const root = (deps.resolveEditTreeRoot ?? resolveEditTreeRoot)(deploy.integrationRoot);
  if (root !== deploy.integrationRoot) {
    notes.push(
      `Working-tree reads use the canonical edit tree ${root} (PAPERCUSP_CANONICAL_TREE), not this process's serving checkout ${deploy.integrationRoot}.`,
    );
  }
  const deployedSha = deploy.deployed?.sha ?? null;

  // EI-21544761852770720: these path-independent probes used to start only after
  // every git containment read had completed. Start them as soon as `root` exists;
  // their values are still consumed at the original semantic boundary below.
  const checkpointRunCachedPromise = (deps.readCheckpointRunSnapshot ?? realReadCheckpointRunSnapshot)();
  const checkpointRunLockLivePromise = (deps.readCheckpointRunLock ?? realReadCheckpointRunLock)(root);
  const gateOwnershipPromise = (deps.readGateOwnership ?? readGateOwnership)();

  // Resolve a submodule, if the path is inside one. `superRelPath` keeps the path the
  // caller actually asked about (superproject-relative); `relPath` is rewritten to the
  // submodule-relative form for the nested-repo history reads below.
  let submodule: string | null = null;
  let gitDir = root;
  const superRelPath = inp.path ? inp.path.replace(/^\.?\//, '') : null;
  let relPath = superRelPath;
  // EI-18797292094433710: an all-whitespace marker would match everywhere and read as a
  // confident positive, so it is treated as "not supplied" rather than trusted.
  const marker = inp.marker?.trim() ? inp.marker : null;
  if (relPath) {
    const subs = await submodulePaths(git, root);
    const hit = subs.find((s) => relPath === s || relPath!.startsWith(s + '/'));
    if (hit) {
      submodule = hit;
      gitDir = path.join(root, hit);
      relPath = relPath.slice(hit.length).replace(/^\//, '');
      notes.push(
        `Path is inside submodule '${hit}'; commit history is resolved in that nested repo, while staging inclusion is checked through the superproject's origin/staging gitlink.`,
      );
    }
  }

  // Candidate discovery is independent of target-sha and position containment.
  // Avoid the systemd-backed probe for sha-only and missing-path reads, but overlap it
  // with the remaining path work when applicable. P-011: a SUBMODULE path needs the
  // candidates too — its containment is now measured through the gitlink each
  // candidate pins, so skipping the probe here would leave the cell with no sha to
  // resolve that gitlink against.
  const gateCandidatesPromise = relPath ? (deps.resolveGateCandidates ?? realResolveGateCandidates)(root) : null;

  // Dirty (uncommitted) check for a path.
  let dirtyUncommitted = false;
  // P-006: the blast radius of the next sweep — the WHOLE tree, not this path. Read
  // only when the probed path is itself dirty, so a clean probe pays nothing for it
  // (this module is on dev:pipeline_position's hot path).
  let dirtyPaths: string[] | null = null;
  // EI-24049239243821100: a FAILED status read (non-zero exit, the subprocess timeout)
  // is not a clean tree. `GitRunner` yields null for it, and `!!st` used to fold that
  // into `dirtyUncommitted: false`, i.e. a confident "clean" that let the assessment
  // reach 'live'. It is hoisted as the `workingTree` leg of `positionsUnknown` below.
  let workingTreeUnknown = false;
  if (inp.path) {
    const st = await git(gitDir, ['status', '--porcelain', '--', relPath || '.']);
    workingTreeUnknown = st === null;
    dirtyUncommitted = !!st && st.length > 0;
    if (workingTreeUnknown) {
      notes.push(
        `Could not read the working-tree status of '${relPath || '.'}' (git status failed or timed out), so whether it has uncommitted edits is UNKNOWN — not clean. Re-call before trusting any position below.`,
      );
    }
    if (dirtyUncommitted) {
      const all = await git(gitDir, ['status', '--porcelain']);
      dirtyPaths = all === null ? null : parsePorcelainPaths(all);
    }
  }

  // Resolve the target sha: explicit sha, else the path's last commit.
  let targetSha: string | null = null;
  let submodulePin: PipelinePosition['submodulePin'] = null;
  if (inp.sha) {
    targetSha = (await git(gitDir, ['rev-parse', '--verify', `${inp.sha}^{commit}`])) ?? null;
    // EI-18715870370005934: a submodule path given with a SUPERPROJECT sha (the
    // overwhelmingly common case — "is my change in the build at <gate sha>?",
    // where the only sha an agent has is the superproject's). That sha does not
    // exist in the submodule's object store, so the rev-parse above fails and we
    // used to report `targetSha: null` + "did not resolve" — a bare ABSENCE, from
    // the very tool CLAUDE.md points agents at for "is my edit live". Resolve the
    // gitlink instead and report the pinned submodule commit, which is what the
    // caller actually meant.
    if (!targetSha && submodule) {
      const pinned = await resolveSubmodulePin(git, root, inp.sha, submodule);
      if (pinned) {
        targetSha = pinned;
        submodulePin = { superprojectSha: inp.sha, submoduleSha: pinned };
        notes.push(
          `'${inp.sha}' is a SUPERPROJECT commit and does not exist inside submodule '${submodule}' — ` +
            `resolved its gitlink instead: that superproject commit PINS submodule commit ${pinned.slice(0, 12)}, ` +
            `and all positions below are reported for that pinned commit. ` +
            `Hand-rolled equivalents (\`git show ${inp.sha.slice(0, 12)}:${submodule}/<file>\`, ` +
            `\`git status --porcelain ${submodule}/<file>\`) return EMPTY here and read as "absent"/"clean" — ` +
            `they are the wrong question, not a negative answer. To inspect content: ` +
            `\`git -C ${submodule} show ${pinned.slice(0, 12)}:<path-inside-submodule>\`.`,
        );
      }
    }
    if (!targetSha) notes.push(`SHA '${inp.sha}' did not resolve in ${submodule ?? 'the superproject'}.`);
  } else if (relPath) {
    targetSha = await git(gitDir, ['log', '-1', '--pretty=%H', '--', relPath]);
    if (!targetSha)
      notes.push(
        `No commit has touched '${relPath}' yet${dirtyUncommitted ? ' (it is newly created / uncommitted)' : ''}.`,
      );
  } else {
    notes.push('Provide a path or a sha.');
  }

  const targetSubject = targetSha ? await git(gitDir, ['log', '-1', '--pretty=%s', targetSha]) : null;
  const targetShortSha = targetSha ? targetSha.slice(0, 9) : null;

  const positions = {
    committedLocal: false,
    onStaging: false,
    inMain: false,
    deployed: false,
  };
  // D-039 HOIST. The booleans above stay booleans so every existing consumer is
  // unchanged, but a leg whose git read FAILED must not be indistinguishable from
  // one that honestly read `false`. Naming the leg here is the result-level
  // qualifier a caller who never inspects each position still cannot miss —
  // modelled directly on `unitsUnknown[]` and `ownerHidden`.
  const positionsUnknown: string[] = [];
  if (workingTreeUnknown) positionsUnknown.push('workingTree');
  /** WI-6646 — legs whose false is a newer-commit artifact (see PipelinePosition). */
  const positionsNewerCommit: string[] = [];
  /** WI-6646 — per-leg marker verdicts, populated only when a marker was supplied. */
  const markerLegs: {
    onStaging: MarkerContainment | null;
    inMain: MarkerContainment | null;
    deployed: MarkerContainment | null;
  } = { onStaging: null, inMain: null, deployed: null };
  const readLeg = (name: string, v: boolean | null): boolean => {
    if (v === null) {
      positionsUnknown.push(name);
      return false; // degraded, and SAID so — not a measurement
    }
    return v;
  };
  // WI-6484: `!targetSha` USUALLY means there is NOTHING TO MEASURE — an explicit
  // sha never resolved, neither a path nor a sha was supplied, or no commit has
  // EVER touched this path AND it doesn't even exist dirty in the working tree
  // (the overwhelmingly likely cause: a typo'd/renamed/wrong-submodule path) — not
  // that the four legs below were measured and genuinely came back false. Without
  // this hoist, `positions.*` silently stays at its initialized `false`, and the
  // ONLY channel that distinguishes "measured false" from "nothing to measure" for
  // a consumer that reads just the headline (notably the `git.pipelinePosition`
  // state cell, whose `positionsUnknown` hoist is exactly that channel) never
  // fires — "deployed: false" then reads as "not deployed yet, wait for it", when
  // waiting is in fact infinite.
  //
  // EXEMPTION, reconciled with the "brand-new dirty file" case just below (P-006 /
  // D-039): when the path IS dirty (exists uncommitted in the working tree) and no
  // sha was explicitly requested, "not committed yet" is a genuine, confident,
  // actionable MEASUREMENT — the git log read succeeded and correctly found
  // nothing, because the file simply has not been committed. That is one of the
  // commonest reads there is (an agent checking whether its own new file landed),
  // and hoisting it would make the hoist noisy for exactly that common case. So the
  // hoist applies to every `!targetSha` case EXCEPT this one.
  const noCommitButDirtyPath = !inp.sha && !!relPath && dirtyUncommitted;
  // WI-6525: when there is genuinely NOTHING TO MEASURE (this same condition below),
  // the `gate` stage's "fix the reds" lever was previously unreachable to
  // distinguish from a real, measured red — a typo'd path (no commit, not dirty)
  // read identically to "committed, sitting behind a red gate" and sent the caller
  // to green a gate that has nothing to do with their file. Capture WHY nothing
  // resolved here, in-band, so the `committed` stage (which sits before `gate` in
  // stage order) can report the true blocker directly instead of falling through.
  const targetUnresolvedDetail: string | null =
    !targetSha && !noCommitButDirtyPath
      ? inp.sha
        ? `SHA '${inp.sha}' did not resolve in ${submodule ?? 'the superproject'} — check it is a full/valid commit hash in this repo. This is not a git-sync or release-gate issue; a bad/typo'd sha has nothing for either to act on.`
        : relPath
          ? `No commit has ever touched '${relPath}', and it does not exist (dirty or committed) in the working tree either — this usually means a typo, a renamed/moved file, or the wrong path/submodule. This is NOT a git-sync or release-gate issue: waiting will not resolve it, and greening the gate will not either. Double-check the path and re-call.`
          : 'Neither a path nor a sha was supplied, so there is no commit to resolve a position for.'
      : null;
  if (!targetSha && !noCommitButDirtyPath) {
    positionsUnknown.push('committedLocal', 'onStaging', 'inMain', 'deployed');
  }
  if (targetSha) {
    if (submodule) {
      positions.committedLocal = readLeg('committedLocal', await refContains(git, gitDir, 'HEAD', targetSha));
      // The release gate judges the SUPERPROJECT candidate. Its submodule
      // version is the gitlink pinned by origin/staging, so nested origin/HEAD
      // is not evidence that this commit is in the candidate. Compare the
      // target nested commit against that pinned nested commit instead.
      const stagingPin = await readSubmodulePin(git, root, 'origin/staging', submodule);
      if (stagingPin === null) {
        positions.onStaging = readLeg('onStaging', null);
        notes.push(
          `Could not read the superproject origin/staging gitlink for submodule '${submodule}', so onStaging is unknown (not a measured miss).`,
        );
      } else if (stagingPin.sha === null) {
        positions.onStaging = readLeg('onStaging', false);
        notes.push(
          `Superproject origin/staging has no gitlink for submodule '${submodule}', so the nested commit is not in that candidate.`,
        );
      } else {
        positions.onStaging = readLeg('onStaging', await refContains(git, gitDir, stagingPin.sha, targetSha));
        notes.push(
          `Submodule onStaging was measured against the superproject origin/staging gitlink (${stagingPin.sha.slice(0, 12)}), not nested origin/HEAD.`,
        );
      }
    } else {
      // All four local containment reads are independent once targetSha is known.
      // Start them together, then preserve the existing result interpretation and
      // conditional read-only remote rescues below.
      const [committedLocalRead, onStagingRead, inMainRead, deployedRead] = await Promise.all([
        refContains(git, gitDir, 'HEAD', targetSha),
        refContains(git, root, 'origin/staging', targetSha),
        refContains(git, root, 'origin/main', targetSha),
        deployedSha ? refContains(git, root, deployedSha, targetSha) : Promise.resolve(null),
      ]);
      positions.committedLocal = readLeg('committedLocal', committedLocalRead);
      positions.onStaging = readLeg('onStaging', onStagingRead);
      positions.inMain = readLeg('inMain', inMainRead);
      positions.deployed = deployedSha
        ? readLeg('deployed', deployedRead)
        : readLeg('deployed', null);
      // EI-18694888339365359 / WI-38372: the local ref said "not present" — before
      // believing that (and letting a caller block/park on it), check the actual
      // remote tip via ls-remote (no fetch, no local mutation). Exact-tip equality
      // is the degenerate case; when the target is behind the current tip, a local
      // ancestry read corrects the stale remote-tracking ref for the common case.
      const remoteStagingContainsPromise = !positions.onStaging
        ? isRemoteTipContaining(git, root, 'refs/heads/staging', targetSha)
        : Promise.resolve(null);
      const remoteMainContainsPromise = !positions.inMain
        ? isRemoteTipContaining(git, root, 'refs/heads/main', targetSha)
        : Promise.resolve(null);
      const [remoteStagingContains, remoteMainContains] = await Promise.all([
        remoteStagingContainsPromise,
        remoteMainContainsPromise,
      ]);
      if (!positions.onStaging && remoteStagingContains === true) {
        positions.onStaging = true;
        // ls-remote is a DIRECT measurement of the remote tip, so it supersedes an
        // unreadable local ref — the leg is answered, not degraded, and must drop
        // out of the hoist or it would report a resolved leg as unknown.
        const staleIdx = positionsUnknown.indexOf('onStaging');
        if (staleIdx >= 0) positionsUnknown.splice(staleIdx, 1);
        notes.push(
          'The local origin/staging ref was stale (git-sync had not yet fetched this push); ' +
            'confirmed via `git ls-remote` (no local mutation) and local ancestry that the target ' +
            'commit IS contained in the current remote tip, so onStaging was corrected to true.',
        );
      }
      // WI-38372: origin/main is subject to the same stale remote-tracking-ref
      // failure as origin/staging. Apply the same read-only tip-containment rescue
      // so an older commit already in the remote main history is not reported as
      // waiting at the gate merely because the local ref has not been fetched.
      if (!positions.inMain && remoteMainContains === true) {
        positions.inMain = true;
        const staleIdx = positionsUnknown.indexOf('inMain');
        if (staleIdx >= 0) positionsUnknown.splice(staleIdx, 1);
        notes.push(
          'The local origin/main ref was stale (git-sync had not yet fetched this promotion); ' +
            'confirmed via `git ls-remote` (no local mutation) and local ancestry that the target ' +
            'commit IS contained in the current remote tip, so inMain was corrected to true.',
        );
      }
      // P-007 CORRECTION. This previously read: "No deployedSha is NOT an unreadable leg
      // — there is simply nothing deployed to compare against, which is a genuine
      // `false`, not a degraded one." That premise does not survive checking the source.
      // `deployedSha` comes from `devDeployState().deployed`, which is `commitRef(releaseRoot,
      // 'HEAD')` — and dev-deploy-state.ts pushes 'could not resolve HEAD of release
      // checkout …' onto `errors[]` whenever it comes back null. So a null deployedSha is a
      // FAILED READ of the release checkout, not an empty one; there is no "nothing is
      // deployed" state that reaches here without an error beside it.
      //
      // Which makes the `false` DEGRADED, and it was being asserted as a measurement
      // thirty lines below the hoist built to prevent exactly that — the same axis-2
      // defect P-006 fixed in `refContains`, surviving in the same function because a
      // comment asserted the reading instead of checking it. Name the leg.
      /* --------------------------------------------------------------------- *
       * WI-6646 — the newer-commit correction for the two lagging legs.
       *
       * Both legs above answer about `targetSha`, which with a `path` is THE NEWEST
       * COMMIT TOUCHING THAT PATH — a peer's, whenever a peer touched the file after
       * you (the norm here: git-sync commits the whole shared tree under one identity).
       * So a `false` is about that commit, not about the caller's change, and the tool's
       * headline question is "is MY edit live". Two mitigations, mirroring exactly what
       * `changeInCandidate` already carries for the identical trap:
       *
       *   1. `marker` SETTLES it — read the ref's own version of the file and look for
       *      the caller's literal string. That is a direct measurement of the question,
       *      so a definitive verdict CORRECTS the leg in both directions (precedent: the
       *      `ls-remote` correction of a stale `origin/staging` above). An unknown read
       *      corrects nothing and is reported as unknown.
       *   2. Without a marker, EXPLAIN the false rather than leaving it to be misread as
       *      "not yet, wait": if the ref already contains an EARLIER commit touching this
       *      path, name the leg in `positionsNewerCommit` and point at the marker lever.
       * --------------------------------------------------------------------- */
      if (relPath) {
        const gitReadForMarker = gitReadForRepo(git, root);
        // `committedLocal` is deliberately absent and is the ONLY leg that is: `targetSha`
        // is resolved by `git log` against HEAD, so it is an ancestor of HEAD by
        // construction and that leg cannot be a newer-commit artifact. The other three
        // all answer about a ref that can legitimately lag behind the caller's change.
        const legs: ReadonlyArray<readonly ['onStaging' | 'inMain' | 'deployed', string | null]> = [
          ['onStaging', 'origin/staging'],
          ['inMain', 'origin/main'],
          ['deployed', deployedSha],
        ];
        // EI-19325915429897280: a marker verdict of `present === true` used to
        // unconditionally exonerate the leg (positionsMarker) — but `present` only
        // answers "does this string occur in ref's version of the file", not "does
        // YOUR change occur". A marker that isn't unique to the edit (a pre-existing
        // identifier, a common symbol) makes ANY candidate read as carrying the
        // change, exactly as EI-19325709344484737's sibling bug did for
        // changeInCandidate/markerJudging — fixed there via `markerPartialAgainst`'s
        // count-comparison; this leg had no equivalent. Establish ONE baseline —
        // the marker's count at `targetSha`'s PARENT, i.e. the file immediately
        // before the current path tip. A later same-path commit may make that
        // baseline already contain the caller's marker; each ref can then fall back
        // to its own earlier path commit's parent below.
        const targetMarkerBaseline = marker
          ? await markerAtCommit(gitReadForMarker, `${targetSha}~1`, relPath, marker)
          : null;
        const targetMarkerBaselineCount =
          typeof targetMarkerBaseline?.count === 'number' ? targetMarkerBaseline.count : null;

        for (const [leg, ref] of legs) {
          if (!ref) continue;
          // Only a leg reading FALSE can be a newer-commit artifact; a true leg is
          // already the answer the caller wants and needs no second opinion.
          if (positions[leg]) continue;
          // A leg that is false BY DEGRADATION is already hoisted in positionsUnknown.
          // Re-labelling it as a newer-commit artifact would replace an honest "unknown"
          // with a confident wrong story about why.
          if (positionsUnknown.includes(leg)) continue;

          // Read this before the marker branch so a later same-path commit can supply
          // the candidate's own parent as a second, change-specific baseline. The
          // target's parent is no longer the caller's pre-change state once a peer has
          // committed to the path after the caller's change.
          const earlier = await newestTouchingInRef(git, root, ref, relPath);

          if (marker) {
            const verdict = await markerAtCommit(gitReadForMarker, ref, relPath, marker);
            markerLegs[leg] = verdict;
            /* ------------------------------------------------------------------ *
             * EI-21443291930356119 — the two available baselines answer DIFFERENT
             * questions, and only ONE of them is sound in both directions.
             *
             *  · `${targetSha}~1` — the HEAD side's pre-change state. A ref holding
             *    MORE occurrences than this cannot be explained by the ref merely
             *    lagging, so it is real evidence for an ADDED marker. It is NOT
             *    evidence for a removed one: FEWER occurrences than the HEAD side's
             *    parent is *exactly* what a ref that PREDATES the marker looks like.
             *    Accepting that reading reported `inMain`/`deployed` true — summary
             *    `live`, `blockedOn` null — for a change sitting behind a red gate,
             *    in refs whose version of the file contained the marker ZERO times.
             *    Same false-live outcome WI-41208 fixed for the path-absent zero;
             *    this is the same trap one step in, with the path genuinely present.
             *
             *  · `${earlier.sha}~1` — REF-INTERNAL: did the ref's OWN newest commit
             *    to this path move the marker count? That measures a change inside
             *    the ref's history, so a DECREASE there really is the ref carrying a
             *    marker-removing change rather than the ref being old. Sound in both
             *    directions, which is why the removed direction may rest only on it.
             *
             * So: measure the ref-internal baseline whenever one exists and prefer
             * it; let the target-parent baseline settle the ADDED direction alone.
             * ------------------------------------------------------------------ */
            const refInternalBaselineSha =
              earlier?.sha && earlier.sha !== targetSha ? `${earlier.sha}~1` : null;
            const refInternalBaseline: MarkerContainment | null = refInternalBaselineSha
              ? await markerAtCommit(gitReadForMarker, refInternalBaselineSha, relPath, marker)
              : null;
            // `markerNetChange` owns the two rules a strict count comparison needs —
            // never bare presence, and never a count from a tree that does not have
            // the file at all. It is unit-tested against a deliberately-wrong control;
            // see WI-41208 for the failure it exists to stop.
            const refInternalChange = markerNetChange(verdict, refInternalBaseline);
            const targetParentChange = markerNetChange(verdict, targetMarkerBaseline);
            let markerBaseline: MarkerContainment | null = targetMarkerBaseline;
            let markerBaselineSha = `${targetSha}~1`;
            let netChange: 'added' | 'removed' | null =
              targetParentChange === 'added' ? 'added' : null;
            if (refInternalChange && refInternalBaselineSha) {
              netChange = refInternalChange;
              markerBaseline = refInternalBaseline;
              markerBaselineSha = refInternalBaselineSha;
            }
            const markerBaselineCount = typeof markerBaseline?.count === 'number' ? markerBaseline.count : null;
            const strictlyAdded = netChange === 'added';
            const strictlyRemoved = netChange === 'removed';
            if (targetParentChange === 'removed' && netChange === null) {
              notes.push(
                `${leg}: your marker occurs ${verdict.count}× in ${ref} against ${targetMarkerBaselineCount}× at ` +
                  `${targetSha.slice(0, 9)}~1 — FEWER, not more. That is what a ref carrying a marker-DELETING ` +
                  `change looks like AND what a ref that simply PREDATES the marker looks like, and a count on ` +
                  `the HEAD side cannot tell them apart. ${
                    refInternalBaselineSha
                      ? `${ref}'s own newest commit to this path (${(earlier?.sha ?? '').slice(0, 9)}) shows no change in occurrences either`
                      : `${ref} has no earlier same-path commit to measure the drop against`
                  }, so the leg is left as measured: an unprovable "your change is live" is the expensive error here.`,
              );
            }
            if (strictlyAdded || strictlyRemoved) {
              positions[leg] = true;
              notes.push(
                `${leg}: CORRECTED to true by the marker. The newest commit touching '${relPath}' ` +
                  `(${targetSha.slice(0, 9)}) is not in ${ref} — but ${ref}'s own version of the file ` +
                  `contains your marker ${verdict.count}× against a baseline of ${markerBaselineCount}× at ` +
                  `${markerBaselineSha.slice(0, 9)} (before the marker-bearing change), a strict net-${strictlyAdded ? 'increase' : 'decrease'} ` +
                  `in occurrences, so YOUR change IS there. The false was about a later commit to the same file, ` +
                  `not about your change.`,
              );
              continue;
            }
            if (verdict.present === true) {
              if (typeof markerBaselineCount === 'number') {
                notes.push(
                  `${leg}: marker '${marker}' is present in ${ref} (${verdict.count}×), but it is NOT unique ` +
                    `to your change — it already occurred ${markerBaselineCount}× before your change (at ` +
                    `${markerBaselineSha.slice(0, 9)}), so its presence in ${ref} proves nothing either way. Pick a ` +
                    `marker string your change introduced, not a pre-existing identifier.`,
                );
              } else {
                notes.push(
                  `${leg}: marker '${marker}' is present in ${ref}, but the baseline count before your change ` +
                    `could not be measured (${markerBaseline?.unknownReason?.detail ?? 'unknown reason'}), so ` +
                    `presence alone does not prove YOUR change is there.`,
                );
              }
              // Fall through (not `continue`) — leave positions[leg] as measured
              // (false) and let the newer-commit explanation below still fire, same
              // as the unmeasured (present === null) case just below.
            } else if (verdict.present === false) {
              notes.push(
                `${leg}: confirmed NOT present — ${ref}'s version of '${relPath}' does not contain your ` +
                  `marker${verdict.pathPresent === false ? ' (the path does not exist there at all)' : ''}. ` +
                  `This is a genuine miss, not a newer-commit artifact.`,
              );
              continue;
            }
            // present === null (unknown), or the measured count did not strictly
            // change against the baseline: fall through to the explanation below,
            // which is still better than a bare false, but never claim the marker settled it.
          }

          if (earlier === null) continue; // read failed — say nothing rather than guess
          if (earlier.sha && earlier.sha !== targetSha) {
            positionsNewerCommit.push(leg);
            notes.push(
              `${leg} is FALSE ABOUT A NEWER COMMIT, not necessarily about your change: the newest commit ` +
                `touching '${relPath}' is ${targetSha.slice(0, 9)}, which ${ref} does not contain — but ${ref} ` +
                `DOES already contain ${earlier.sha.slice(0, 9)}, an earlier commit to the same file. On a ` +
                `shared file that later commit is routinely a peer's. SETTLE IT IN ONE CALL: re-call with ` +
                `\`marker\` set to a distinctive literal string from your own change.`,
            );
          }
        }
      }
    }
  } else if (!relPath || inp.sha) {
    /**
     * P-007. No target sha, so NOTHING above was measured — and the four `false`s are
     * therefore not evidence. Two of the three ways to get here need saying:
     *   · neither a path nor a sha was passed (the GLOBAL cell reads, which ask about
     *     the gate/deploy legs and have no per-path subject at all);
     *   · a sha was passed and did not resolve.
     * The third — a path given whose file has no commit yet — is deliberately NOT
     * hoisted: there the `log` read SUCCEEDED and found nothing, so "not committed, not
     * on staging, not deployed" is a measured absence and an honest answer.
     *
     * Without this, a no-target read reported `deployed: false` with an EMPTY
     * positionsUnknown — the identical "false by degradation, indistinguishable from
     * false by measurement" defect P-006 fixed in `refContains`, reachable by simply
     * omitting an argument.
     */
    for (const leg of ['committedLocal', 'onStaging', 'inMain', 'deployed']) {
      if (!positionsUnknown.includes(leg)) positionsUnknown.push(leg);
    }
  }

  // These three reads are mutually independent.  Serialising them made the
  // cell resolver's wall time equal to the sum of a cache read, a live lock
  // probe, and an indexed ownership lookup.  Keep their individual fail-soft
  // semantics while paying only the slowest leg's latency.
  const [checkpointRunCached, checkpointRunLockLive, gateOwnership] = await Promise.all([
    checkpointRunCachedPromise,
    checkpointRunLockLivePromise,
    gateOwnershipPromise,
  ]);
  // WI-1702869 / WI-2146319: the failing-files-on-the-frozen-candidate answer. This
  // projection must ALWAYS return a stable object. A true absent queue is an explicit
  // `no-frozen-candidate` reading; a present-but-unreadable row is `unmeasured` and
  // carries its raw candidate/repairHead/phase identity. Returning null here drops the
  // cell's declared evidence paths and makes a newer writer look like "nothing frozen".
  const persistedQueue = snap.gate.repairQueue ?? null;
  const unreadableQueue = snap.gate.repairQueueRead?.status === 'unreadable' ? snap.gate.repairQueueRead : null;
  const candidateFailures = await (deps.readGateCandidateFailures ?? readGateCandidateFailures)({
    candidateSha: persistedQueue?.frozenCandidate ?? persistedQueue?.candidate ?? unreadableQueue?.candidate ?? null,
    repairHeadSha: persistedQueue?.repairHead ?? unreadableQueue?.repairHead ?? null,
    root,
    submodulePaths: persistedQueue ? await submodulePaths(git, root) : [],
    // `readGateCandidateFailures` only branches on the unreadable disposition;
    // readable queue identity is already supplied through candidateSha/repairHeadSha.
    // The snapshot deliberately projects a readable row down to schemaVersion, so
    // do not pretend that compact projection is the full persisted queue union.
    repairQueueRead: unreadableQueue,
    // WI-2143253: already parsed by git-pipeline-stats (a second key off the same
    // `gate_health` blob it loaded, never a second query) — thread it through so
    // `gate.candidateFailures.nonTestLegs` can name which lint/perf/desktop/delta
    // leg is failing, instead of the bare `postSuiteMeasured` tri-state boolean.
    repairTickLegs: snap.gate.repairTickLegs ?? null,
    // P-003: the cycle's per-leg LIFECYCLE, distinct from the tick measurement above.
    // One tick says what it just ran; only the lifecycle says whether a leg's own
    // re-run has since passed — which is the half "did its fix land" needs.
    queueLegs: persistedQueue?.legs ?? null,
    // Reuse this invocation's sidecar-aware runner. Without this, candidate-failure blob reads
    // silently instantiate their own local-fork runner inside the same multi-GB process.
    git,
  });
  // WI-7035: `snap.gate.inFlightRetriage` is already loaded and freshness-checked by
  // git-pipeline-stats (parseInFlightRetriage) — it was simply never consulted here, so the
  // authoritative answer sat one field away from the inferred one. Passing it makes the
  // re-triage window visible on the CRON path, where the log-derived provenance cannot reach.
  // EI-19395922387569240: the LIVE liveness read that keeps `active` from being a claim about
  // a snapshot's past. Fork-free, so it is safe on this hot path; fail-soft to null, which
  // degrades this leg to its previous cache-only behaviour.
  const checkpointRunInFlight = mapCheckpointRunInFlight(
    checkpointRunCached,
    Date.now(),
    snap.gate.inFlightRetriage,
    checkpointRunLockLive,
    // EI-19931692050586322: the sibling marker, loaded and freshness-checked by the same
    // git-pipeline-stats pass. Threading it is what lets an ordinary non-refiring run report an
    // authoritative candidate instead of the `'run-probe'` inference.
    snap.gate.inFlightCandidate,
  );
  // The freshness evaluator only sees the cached gate-health timestamps. During every healthy
  // long-running suite those timestamps necessarily look writer-starved until the run completes.
  // Reconcile that one ambiguous classification with the LIVE run-lock measurement, while
  // preserving cache-only/unknown liveness and every stronger freshness rule.
  // WI-10002059: a THIRD cause of "fired without a verdict" that rule 2 blamed on the run-lock.
  // While freeze-and-converge holds a frozen candidate, runs execute to COMPLETION and return
  // 'repair-in-progress', which is never banked — so the timestamps look identical to a skipped
  // fire while the gate is healthy. Applied AFTER the run-lock reconciler so a live run still
  // wins: "wait for this run" is more immediate than the convergence it sits inside.
  // WI-10002121: the THIRD link, and the only one that RELEASES a classification rather than
  // refining it. Rule 5 ('candidate-fossil') judges the candidate's wall-clock age, on the premise
  // that an old candidate was selected by ACCIDENT. Under freeze-and-converge that premise is
  // inverted: the queue pins one immutable sha on purpose and its head ages by design, so rule 5
  // tells a reader to re-judge at tip and NOT to fix the named tests — backwards on both halves,
  // since that red IS the signature the queue needs and re-cutting discards the queue (D-007).
  // D-004 records the write-side withholding rule and this read-side release as a COUPLED PAIR.
  // Ordering note: this keys on 'candidate-fossil' and the two inner links key on
  // 'writer-starved', so all three are disjoint — the nesting is for readability, not precedence.
  const gateFreshness = reconcileGateVerdictFreshnessWithPinnedRepair(
    reconcileGateVerdictFreshnessWithRepairQueue(
      reconcileGateVerdictFreshnessWithCheckpointRun(
        {
          stale: snap.gate.verdictStale,
          reason: snap.gate.verdictStaleReason,
          reasonCode: snap.gate.verdictStaleReasonCode ?? null,
          candidateAgeMs: snap.gate.candidateAgeMs,
        },
        checkpointRunInFlight,
      ),
      {
        status: snap.gate.inconclusive?.status ?? null,
        phase: snap.gate.repairQueue?.phase ?? null,
      },
    ),
    {
      // The JUDGED sha, never the tip and never the frozen pin: the exemption is about what this
      // verdict actually measured. The single shared predicate owns the comparison (including the
      // blocked-queue negative) so the read and write sides cannot drift.
      judgingPinnedActiveRepair:
        snap.gate.observedCandidate != null &&
        isJudgingPinnedActiveRepair({
          candidate: snap.gate.observedCandidate,
          repairQueue: snap.gate.repairQueue ?? null,
        }),
    },
  );
  // P-005: ONE reading, used both by ownerBrief below and verdictProvenance later.
  // Hoisting the local avoids either composer re-reading deploy state or the two
  // reader-facing answers deriving opposite polarities independently.
  const greenPinAtStagingHead = snap.deploy?.greenPinAtStagingHead ?? null;
  const stagingHeadSha = snap.deploy?.stagingHead?.sha ?? null;
  // D-013/P-011: promotion is a relationship between the exact sha THIS verdict judged
  // and the main pin the WRITER recorded beside it. The ordinary staging buffer is a
  // different axis. Resolve the three independent ancestry questions concurrently; a
  // failed git read remains null and therefore cannot manufacture promotion or absorption.
  const judgedSha = snap.gate.observedCandidate ?? null;
  const verdictMainPin = snap.gate.lastMainPin ?? null;
  const [mainContainsJudgedSha, stagingContainsMainPin, stagingContainsJudgedSha] = await Promise.all([
    verdictMainPin && judgedSha ? refContains(git, root, verdictMainPin, judgedSha) : Promise.resolve(null),
    stagingHeadSha && verdictMainPin
      ? refContains(git, root, stagingHeadSha, verdictMainPin)
      : Promise.resolve(null),
    stagingHeadSha && judgedSha ? refContains(git, root, stagingHeadSha, judgedSha) : Promise.resolve(null),
  ]);
  const gate = {
    stalled: snap.gate.stalled,
    consecutiveReds: snap.gate.consecutiveReds,
    failingTests: snap.gate.failingTests,
    failingTestsMeasured: snap.gate.failingTestsMeasured,
    failingTestsProvenance: snap.gate.failingTestsProvenance ?? 'unknown',
    lastGreenAtMs: snap.gate.lastGreenAtMs,
    ...(() => {
      const pauseProjection = projectGreenCheckpointPause(snap.routines?.greenCheckpoint ?? null);
      return {
        fireStale: pauseProjection.fireStale || snap.gate.fireStale,
        fireStaleReason: pauseProjection.fireStaleReason ?? snap.gate.fireStaleReason,
        pause: pauseProjection.pause,
      };
    })(),
    checkpointRunInFlight,
    // EI-19325520469216548: PROJECTED straight from the snapshot — git-pipeline-stats already
    // computes all five (evaluateGateVerdictFreshness + its two enrichments), and until now they
    // were dropped here, so a caller of THIS tool (the one every agent role is told to reach for)
    // saw only an undifferentiated red while /admin/git, reading the same snapshot directly,
    // already showed the full staleness verdict.
    verdictStale: gateFreshness.stale,
    // WI-1752145: the vintage BEHIND `gateFreshness.stale`. git-pipeline-stats already resolved
    // it (`gate.verdictObservedAtMs`) to compute the boolean above and it was discarded here —
    // the same projection-boundary drop EI-19325520469216548 names three fields up. Passing the
    // raw stamp through is what lets the summary say HOW stale, not merely THAT it is.
    verdictObservedAtMs: snap.gate.verdictObservedAtMs ?? null,
    verdictStaleReason: gateFreshness.reason,
    verdictStaleReasonCode: gateFreshness.reasonCode,
    candidateAgeMs: snap.gate.candidateAgeMs,
    commitsBehindTip: snap.gate.commitsBehindTip,
    observedCandidate: snap.gate.observedCandidate,
    // EI-19405864032365760: same projection reasoning as the five above — git-pipeline-stats
    // already resolves the abort record, and dropping it here is what left `dev:pipeline_position`
    // (the surface every role is pointed at) reporting a stale red as the pipeline's blocker.
    inconclusive: snap.gate.inconclusive
      ? {
          ...snap.gate.inconclusive,
          detail: gateAbortDetailAtRead({
            status: snap.gate.inconclusive.status,
            detail: snap.gate.inconclusive.detail,
            observedAtMs: snap.gate.inconclusive.observedAtMs,
            nowMs: Date.now(),
          }),
        }
      : null,
    repairQueue: snap.gate.repairQueue ?? null,
    repairQueueRead: snap.gate.repairQueueRead ?? { status: 'absent' },
    // WI-2141736 P-004. Also beside `repairQueue`, and for the opposite reason to
    // candidateFailures below: this is the answer for when there IS no queue. `repairQueue:
    // null` cannot distinguish "the owner switched the freeze off", "the gate just retired a
    // frozen candidate" and "nothing is frozen, all is well" — and that is the exact
    // ambiguity that let freeze-and-converge sit off fleet-wide for a day unnoticed.
    // Null here means NOT MEASURED, never healthy.
    freezeAndConverge: snap.gate.freezeAndConverge ?? null,
    // P-004. The third leg of the same subject, and the one that answers whether the
    // freeze is WORKING rather than merely ON. Already DERIVED and persisted on every
    // queue write (`buildFrozenRepairConvergenceGateHealth`, rung 1 of the derived-truth
    // ladder) — it was simply never projected here, so "is this converging or is it a
    // treadmill?" was answerable only by grepping per-run checkpoint logs.
    //
    // ⚠ ALWAYS AN OBJECT, never null: `code: 'no-cycle-recorded'` with null fields is the
    // unmeasured answer. A bare null would both break the cell contract (the declared
    // assessment path must exist in every live payload) and re-create the ambiguity this
    // item exists to remove.
    convergence: projectFrozenRepairConvergenceCell(snap.gate.convergence ?? null),
    // P-004. The CELLED reading of `freezeAndConverge` directly above — same record, one
    // derivation, computed here rather than re-read, so the two can never disagree. It
    // adds exactly what the raw record cannot express: `not-measured` (absent) and `stale`
    // (present but past its freshness window), the two readings a caller branching on the
    // stored `state` union has to invent a default for.
    freezeDisposition: projectFreezeDispositionCell(snap.gate.freezeAndConverge ?? null, Date.now()),
    // P-009. The CELLED reading of `checkpointRunInFlight` — projected from the leg already
    // mapped above rather than from a second query, so the answer on the plane and the answer
    // one field away cannot disagree. The raw marker rides alongside for `failingFiles` alone,
    // which the mapped leg does not project, and is consulted only once that leg has settled
    // that a refire IS in flight.
    //
    // ⚠ ALWAYS AN OBJECT, never null — same contract as the two projections above.
    retriage: projectRetriageCell(checkpointRunInFlight, snap.gate.inFlightRetriage, Date.now()),
    // WI-1702869. Sits beside `repairQueue` because it is the same subject read one level
    // deeper: the queue says WHICH sha is frozen, this says WHAT IS FAILING on it and
    // whether each failure is already repaired at repairHead.
    candidateFailures,
    qualification: snap.gate.qualification ?? projectCheckpointQualificationState(null),
    // P-004: WHO owns this red, so a reader can see the incident is already
    // claimed before filing another work-item about it. One indexed SELECT,
    // fail-soft to `no-object` — same cost/safety profile as checkpointRunInFlight.
    // ⚠ `no-object` means "nobody owns it", NOT "the gate is fine" — gate health is
    // consecutiveReds/verdictStale; ownership is orthogonal. See CellOwnership.
    ownership: gateOwnership,
    // gate-audit-hardening-2026-08-31 P-001: assigned right below, once the pieces it
    // composes exist on this literal — see composeGateOwnerBrief for the doctrine.
    ownerBrief: null as GateOwnerBrief | null,
  };
  // ONE derivation, no new I/O: every input is a value this resolver already computed.
  gate.ownerBrief = composeGateOwnerBrief({
    nowMs: Date.now(),
    consecutiveReds: gate.consecutiveReds,
    failingTests: gate.failingTests,
    failingTestsMeasured: gate.failingTestsMeasured,
    failingTestsProvenance: gate.failingTestsProvenance,
    mainBehindStaging: greenPinAtStagingHead === null ? null : !greenPinAtStagingHead,
    promotion: {
      judgedSha,
      mainPin: verdictMainPin,
      mainContainsJudgedSha,
      stagingHead: stagingHeadSha,
      stagingContainsMainPin,
      stagingContainsJudgedSha,
      stagingBufferPresent: greenPinAtStagingHead === null ? null : !greenPinAtStagingHead,
    },
    lastGreenAtMs: gate.lastGreenAtMs,
    verdictObservedAtMs: gate.verdictObservedAtMs,
    fireStale: gate.fireStale,
    verdictStale: gate.verdictStale,
    inconclusive: gate.inconclusive,
    repairQueue: gate.repairQueue ?? null,
    ownership: gateOwnership,
    // P-007: the NAMED non-test legs, from the same candidateFailures value this literal
    // already carries — so the brief can never read all-clear while a lint/perf/desktop/
    // delta leg is red, and its whyNot names the leg instead of an empty test list.
    nonTestLegs:
      candidateFailures == null
        ? null
        : {
            measured: candidateFailures.nonTestLegsMeasured,
            outstanding: candidateFailures.nonTestLegs?.outstanding ?? [],
          },
  });
  // EI-18793581783459047: surfaced as a NOTE (not folded into the tight one-line
  // `summary`, which is already densely tuned) so a caller about to launch a heavy
  // local suite sees it without this module's terse summary format growing a new
  // branch for an orthogonal concern (host contention, not "where is my change").
  if (checkpointRunInFlight?.active) {
    const since = checkpointRunInFlight.startedAtMs
      ? `${Math.round((Date.now() - checkpointRunInFlight.startedAtMs) / 60_000)}m ago`
      : 'an unknown time ago';
    notes.push(
      `GATE RUN IN FLIGHT (started ${since}${checkpointRunInFlight.candidate ? `, judging ${checkpointRunInFlight.candidate.slice(0, 12)}` : ''}): ` +
        `launching a heavy local suite (test:affected, a multi-file test:file re-verify) RIGHT NOW would contend with it for host ` +
        `CPU/memory and can starve its isolation re-run phase into a false red on code that is actually fine (EI-18793581783459047). ` +
        `Consider waiting for it to finish, or scoping your own re-verify to just the files you changed.`,
    );
    // WI-7035: the re-triage window, stated in words. `inRetriageWindow` is marker-backed, so
    // unlike the log-derived `refireObserved` it is readable on a cron-fired run — which is the
    // path the hourly gate actually takes, and the path on which several agents spent 2026-08-02
    // reasoning about a candidate the run had already discarded.
    if (checkpointRunInFlight.inRetriageWindow) {
      // EI-19343516395023183: budget wording comes from the ONE shared helper, not a local
      // comparison. The local one tested `refireAttempt >= maxRefires` — the CHARGED counter,
      // which since EI-19343532231631821 does not advance on a SUCCESSFUL rescue. So a run at
      // `totalRefires 5/6` (one red away from the absolute ceiling, where the next red really
      // does stick) read as `attempt 0/2` with no warning at all: budget reported as remaining
      // in exactly the case there is almost none.
      const budget =
        checkpointRunInFlight.refireAttempt != null && checkpointRunInFlight.maxRefires != null
          ? describeRefireBudget({
              refireAttempt: checkpointRunInFlight.refireAttempt,
              maxRefires: checkpointRunInFlight.maxRefires,
              totalRefires: checkpointRunInFlight.totalRefires,
              absoluteCeiling: checkpointRunInFlight.absoluteCeiling,
            })
          : null;
      notes.push(
        `GATE IS MID-RESCUE — do NOT fire a manual release:checkpoint-run. This run hit a red, ` +
          `re-tested at tip, and AUTO-REFIRED onto ${(checkpointRunInFlight.candidate ?? '?').slice(0, 12)} ` +
          `(${budget?.label ?? 'refire budget unknown'}), abandoning ` +
          `${(checkpointRunInFlight.fromCandidate ?? '?').slice(0, 12)}. Firing a manual run now DISCARDS that ` +
          `rescue and costs a full suite. Two consequences worth reading twice: (1) a red you are still ` +
          `diagnosing may belong to the ABANDONED candidate, so re-check it against the one above before ` +
          `spending anything on it; (2) pid/started_at stay FIXED across a refire, so an advancing candidate ` +
          `under an unchanged start time is the healthy signature — not corruption.` +
          (budget?.atCap
            ? ` ⚠ This is the LAST refire — at the cap the next red STICKS and a human lever starts to matter.`
            : ''),
      );
    }
  }

  // EI-19325520469216548: surfaced as a NOTE — same rationale as the checkpointRunInFlight
  // block above — so a caller reading `gate.consecutiveReds`/`gate.stalled` at a glance still
  // gets the warning even without inspecting the nested `gate.verdictStale*` fields. Gated on
  // `stalled` (not just `consecutiveReds > 0`) so a red that hasn't crossed the alert threshold
  // yet doesn't grow extra noise on every single read; a caller reasoning about the raw count
  // still has the fields above regardless of this note firing.
  if (gate.verdictStale && gate.stalled) {
    notes.push(
      `⚠ THIS RED MAY BE STALE (do not go re-fix the test(s) it names on this evidence alone): ${gate.verdictStaleReason ?? 'the recorded verdict is unverified'}` +
        // WI-1752145: WHEN this verdict was observed — the vintage of the `consecutiveReds` /
        // `stalled` / `failingTests` a reader is being warned about. `verdictStale` said THAT
        // the reading was unverified; it could not say HOW OLD, because the stamp behind it was
        // dropped at this module's projection boundary. Distinct from `candidateAgeMs` below,
        // which is the age of the judged COMMIT at verdict time — a different clock answering a
        // different question, and the one that was standing in for this.
        (gate.verdictObservedAtMs != null
          ? ` The verdict itself was observed ${formatIdleAge((Date.now() - gate.verdictObservedAtMs) / 1000)} ago.`
          : '') +
        (gate.candidateAgeMs != null
          ? ` — the judged candidate was ${Math.round(gate.candidateAgeMs / 60_000)}min old at verdict time` +
            (gate.commitsBehindTip != null && gate.commitsBehindTip > 0
              ? ` (${gate.commitsBehindTip} commit(s) landed on staging that it never saw)`
              : '') +
            '.'
          : '.') +
        (gate.verdictStaleReasonCode === 'pin-advance'
          ? ' This reason is HARD PROOF a green already happened — the streak may be safely treated as reset.'
          : gate.verdictStaleReasonCode === 'run-in-flight'
            ? ' A green-checkpoint run is already active and its verdict is pending — do NOT fire release:checkpoint-run or fix the named failure while it runs; wait for this run to finish.'
            : ' Re-judge at tip (release:checkpoint-run) or wait for the next verdict before spending time on the named failure.'),
    );
  }

  // WI-1752145: the same hoist for the ABORT record, which had none. `inconclusive.status` is a
  // load-bearing claim — it outranks the red streak in the gate sentence — and it is LATCHED:
  // release-actions.ts writes it through a scoped jsonb_set that deliberately does not disturb
  // the verdict blob, so the top-level `observedAt` (and therefore every other age on this
  // payload) keeps describing the VERDICT while this record silently ages beside it. Measured
  // drift on live rows: +4s on one install, +5.7 DAYS on another.
  //
  // Gated on the record being provably stale or provably unstamped, exactly like the note above
  // is gated on `stalled`: a caveat that prints on every read is one a reader stops seeing, and
  // the fresh case is already served by the age now printed in the gate sentence itself.
  if (gate.inconclusive) {
    const abortVintage = gateAbortVintage({
      status: gate.inconclusive.status,
      observedAtMs: gate.inconclusive.observedAtMs,
      nowMs: Date.now(),
    });
    if (abortVintage.warning) {
      notes.push(
        `${abortVintage.warning} (Gate abort '${gate.inconclusive.status}'${
          gate.inconclusive.candidate ? ` on ${gate.inconclusive.candidate}` : ''
        }.)`,
      );
    }
  }

  // EI-7846: verdict provenance, derived from the snapshot's already-loaded deploy
  // state (ready = the green pin; greenPinAtStagingHead / deployedBehindGreenPin are already
  // computed there) — no new I/O except the one ancestor check for deployOrigin.
  const ready = snap.deploy?.greenPin ?? null;
  let deployOrigin: PipelinePosition['verdictProvenance']['deployOrigin'] = 'unknown';
  if (ready && deployedSha) {
    if (deployedSha === ready.sha) {
      deployOrigin = 'gate-green';
    } else {
      // Is the deployed sha an ancestor-or-equal of the green pin (safe lag), or does
      // it carry commits the green pin doesn't (force-deployed past the gate)?
      const deployedIsAncestorOfReady = await refContains(git, root, ready.sha, deployedSha);
      // Same axis-2 rule as the position legs: a FAILED read must not collapse into
      // a confident 'ahead-of-gate'. Leave the origin unstated rather than asserting
      // the opposite of what could not be measured.
      if (deployedIsAncestorOfReady !== null) {
        deployOrigin = deployedIsAncestorOfReady ? 'stale-behind-gate' : 'ahead-of-gate';
      }
    }
  }
  // ONE reading, two polarities. The local was hoisted before ownerBrief composition;
  // both fields below and that headline read the SAME value, so they cannot drift apart.
  // WI-38367: the old END of the staging buffer, measured ONLY when a buffer actually
  // exists — the healthy `greenPinAtStagingHead === true` case pays no subprocess at
  // all, and the range this walks is by definition the buffer itself. It lives here
  // rather than in devDeployState() because that one is behind the UI's poll storm
  // (see its cache note); this path is dev:pipeline_position's alone.
  const stagingBufferAgeMs =
    greenPinAtStagingHead === false && ready && stagingHeadSha
      ? await oldestCommitAgeMs(git, root, ready.sha, stagingHeadSha)
      : null;
  // The green pin is a separate authority from origin/main. In particular, a
  // force-deployed commit can already be in main while remaining outside the last
  // full-suite-tested pin. Measure the ancestry in the same direction as
  // `deployedIsAncestorOfReady` below: does the green pin's history contain targetSha?
  // EI-19342701023112373: the green pin and the gate's observed candidate are different
  // authorities. The former says whether a fix has ever been promoted; only the latter says
  // whether the verdict an agent is looking at was computed from a tree containing that fix.
  // Reuse the same absence-safe ancestry primitive as every position leg: a failed git read
  // stays null and must never collapse into a confident `not_contained` verdict. The reads
  // are independent, so keep them concurrent on this latency-sensitive diagnostic path.
  const observedCandidateSha = snap.gate?.observedCandidate ?? null;
  const [targetIncludedInGreenPin, targetIncludedInObservedCandidate] = await Promise.all([
    !submodule && targetSha && ready ? refContains(git, root, ready.sha, targetSha) : Promise.resolve(null),
    !submodule && targetSha && observedCandidateSha
      ? refContains(git, root, observedCandidateSha, targetSha)
      : Promise.resolve(null),
  ]);
  const verdictProvenance: PipelinePosition['verdictProvenance'] = {
    lastGreenSha: ready?.sha ?? null,
    lastGreenShortSha: ready?.shortSha ?? null,
    lastGreenAgeMs: ready ? Date.now() - ready.committedAtMs : null,
    mainFastForwarded: greenPinAtStagingHead,
    targetIncludedInGreenPin,
    targetIncludedInObservedCandidate,
    // The polarity the `git.mainBehindStaging` cell is NAMED after (EI-20046248345042252).
    // An unmeasured `null` stays `null` — negating it would manufacture a confident `true`.
    mainBehindStaging: greenPinAtStagingHead === null ? null : !greenPinAtStagingHead,
    stagingBufferAgeMs,
    deployedBehindGreenPin: snap.deploy?.deployedBehindGreenPin ?? null,
    deployOrigin,
  };

  /**
   * P-007 — the axis-2 hoist for the three verdict legs. Each degrades into a value
   * that reads as good news, so each one that is NOT a measurement is named here.
   */
  const verdictUnknown: PipelinePosition['verdictUnknown'] = [];

  if (!submodule && targetSha && ready && targetIncludedInGreenPin === null) {
    verdictUnknown.push({
      leg: 'verdictProvenance.targetIncludedInGreenPin',
      unknown: cellUnknown(
        'resolver-failed',
        `The green pin ${ready.sha.slice(0, 12)} and target ${targetSha.slice(0, 12)} resolved, but their ancestry could not be measured.`,
      ),
    });
  }

  // Leg 1 — the red streak. PROJECTED from the snapshot, never re-derived here: only
  // git-pipeline-stats can see whether `gate_health` carried a counter, because it
  // applies the `?? 0` that destroys the distinction (axis 5 — one derivation, many
  // lenses). `undefined` is a pre-P-007 snapshot fixture, not a report of "measured";
  // treat only an explicit CellUnknown as a claim.
  if (snap.gate?.countersUnknown) {
    verdictUnknown.push({ leg: 'gate.consecutiveReds', unknown: snap.gate.countersUnknown });
  }
  if (snap.gate?.stalled === null) {
    verdictUnknown.push({
      leg: 'gate.stalled',
      unknown: cellUnknown(
        'insufficient-data',
        'The stall condition or watchdog verdict was not measured or was suppressed; null is unknown, not an all-clear.',
      ),
    });
  }

  // P-005 leg — ownership could not be READ. Hoisted rather than left in-band
  // because the alternative reading ("nobody owns this red, go file one") is the
  // reassuring one, and a caller that skips the per-field qualifier lands on it.
  if (gate.ownership?.unknown) {
    verdictUnknown.push({ leg: 'gate.ownership.claimState', unknown: gate.ownership.unknown });
  }

  // Leg 2 — the deployed sha. See the positions.deployed correction above for why a
  // null here is a failed read rather than an empty one. `deploy.errors` carries the
  // reason text and was, until now, loaded and discarded by this resolver — the only
  // place the WHY exists, so it goes in `detail` rather than being re-invented.
  if (deployedSha === null) {
    const why = deploy.errors?.length ? ` (${deploy.errors.join('; ')})` : '';
    verdictUnknown.push({
      leg: 'deployedSha',
      unknown: cellUnknown(
        'resolver-failed',
        `the release checkout's HEAD did not resolve, so what :3070 is running is unknown${why}. This is a FAILED read of ${deploy.releaseRoot}, not evidence that nothing is deployed.`,
      ),
    });
  }

  // Leg 3 — main-vs-staging. `greenPinAtStagingHead` is null only when the green pin or
  // the staging head failed to resolve, so ask those two operands DIRECTLY rather than
  // sniffing the error strings for a match.
  //
  // The code is `resolver-failed` for every case, and that is a deliberate refusal to
  // over-report: `commitRef` catches its git failure and returns null, so "this ref does
  // not exist yet" and "the git call failed" arrive here as the SAME null. Splitting
  // them into insufficient-data vs resolver-failed would be inventing a distinction the
  // measurement cannot support — precisely what axis 2's enum exists to stop. Filed
  // upstream instead; see cell-contract.ts on why a fabricated code is worse than a
  // coarse one, since each code implies a different caller response.
  if (verdictProvenance.mainFastForwarded === null) {
    const missing: string[] = [];
    if (!snap.deploy) missing.push('the deploy snapshot itself');
    else {
      if (!snap.deploy.greenPin) missing.push(`the green pin (${snap.deploy.releaseRef ?? 'main'})`);
      if (!snap.deploy.stagingHead) missing.push(`the staging head (${snap.deploy.integrationBranch ?? 'staging'})`);
    }
    verdictUnknown.push({
      leg: 'verdictProvenance.mainFastForwarded',
      unknown: cellUnknown(
        'resolver-failed',
        missing.length
          ? `${missing.join(' and ')} did not resolve, so whether main is fast-forwarded to the newest green pin could not be measured`
          : 'both operands resolved but the commit-count between them did not, so whether main is fast-forwarded to the newest green pin could not be measured',
      ),
    });
  }
  // Leg 4 is pushed further down, once `changeInCandidate` has been resolved — see the
  // note there for why that leg exists at all.

  // EI-10895: classify against the SUPERPROJECT-relative path (a submodule path is
  // resolved inside its own repo above, but the runtime map keys on the repo-relative
  // path the caller passed).
  const runtimes = classifyRuntimeOwners(inp.path ?? null);
  const runtime = runtimes ? runtimes[0] : null;
  if (runtimes && runtimes.length > 1) {
    notes.push(
      `This path has ${runtimes.length} distinct consumers on DIFFERENT activation routes (${runtimes
        .map((r) => r.host)
        .join(
          ' + ',
        )}) — see \`runtimes\` for each one's own host/activation; do not act on \`runtime\`/\`activation\` alone.`,
    );
  }
  const caveat = runtime?.releasePipelineApplies ? sharedHostCaveat(inp.path ?? null) : null;
  if (caveat) notes.push(caveat);

  // P-003: process truth for the serving stage. WHICH moment we compare the process
  // start against depends on how its host receives code, and getting that wrong
  // inverts the answer:
  //   - a RELEASE-CHECKOUT host (:3070) gets code at DEPLOY time;
  //   - a WORKING-TREE tsx host (bg-host / gateway / embed-sidecar) imports the file
  //     itself, so the file's own mtime is what a restart would pick up — committed
  //     or not, which is why an uncommitted edit is already "the code" for those.
  const servingUnit = runtime && !isFreshInvocationRuntime(runtime) ? SERVING_UNIT_BY_HOST[runtime.host] : null;
  let servingProcess: { pid: number | null; startedAtMs: number | null } | null = null;
  if (servingUnit) {
    servingProcess = await (deps.probeUnitStart ?? realProbeUnitStart)(servingUnit);
  }
  let codeAsOfMs: number | null = null;
  let codeAsOfSource: 'deploy' | 'file-mtime' | null = null;
  if (runtime && servingUnit) {
    if (runtime.releasePipelineApplies) {
      codeAsOfMs = deploy.deployedAtMs ?? null;
      codeAsOfSource = 'deploy';
    } else if (inp.path) {
      codeAsOfMs = await (deps.fileMtimeMs ?? realFileMtimeMs)(path.join(root, inp.path.replace(/^\.?\//, '')));
      codeAsOfSource = 'file-mtime';
    }
  }
  // EI-19447523039740352: only `operator-release`'s lever IS a deploy, so only it can be
  // superseded by one — skip the systemctl round-trip entirely for every other host,
  // where the answer could not change the verdict.
  const deployInFlight =
    runtime?.host === 'operator-release' ? await (deps.readDeployInFlight ?? realReadDeployInFlight)() : null;
  // WI-2141731: ask the release operator for its OWN sha — direct evidence of the
  // code it is executing, where today's verdict can only INFER it from two
  // timestamps. Gated to the cases where the answer can actually decide something:
  //   - `operator-release` (the host the deployed sha describes), or
  //   - a sha-only probe (`runtime === null`), which has no host to infer from and
  //     is precisely the read that was structurally unanswerable before; and
  //   - only when a deployed sha exists to compare against — otherwise the probe
  //     could not change the verdict and is a round-trip for nothing.
  const deployedShaForServing = deploy.deployed?.sha ?? null;
  const servingHealthApplies = (runtime === null || runtime.host === 'operator-release') && !!deployedShaForServing;
  const servingHealthSha = servingHealthApplies
    ? await (deps.probeServingHealthSha ?? realProbeServingHealthSha)()
    : null;
  const serving = evaluateServing({
    runtime,
    process: servingProcess,
    codeAsOfMs,
    codeAsOfSource,
    deployInFlight,
    servingHealthSha,
    deployedSha: deployedShaForServing,
  });

  // Every long-lived host's own generation for this path — independent of the
  // ownership map, which cannot see the import graph (see RuntimeGeneration).
  // Probed in parallel; each host fails soft to UNKNOWN on its own.
  // Does the RELEASE CHECKOUT's copy of this file differ from the working tree?
  // Computed ONCE here and consumed twice: by the generation verdict below (where
  // it is load-bearing — see the contentDiffers note on evaluateRuntimeGenerations)
  // and by the LIVE-CODE-DIFFERS note further down, which used to read the files
  // itself.
  //
  // Kept behind the SAME ownership gate the drift note always used. Widening it to
  // every path would let this leg decide the release row for a path the map says
  // :3070 does not serve — but it would also read the release checkout for a
  // working-tree-only path, which EI-19327418148563597 deliberately pinned as
  // wasted IO. When we do not read it, the release row degrades to UNKNOWN with a
  // reason, which is the honest answer and strictly better than today's no-row.
  let releaseContentDiffers: boolean | null = null;
  if (runtime?.releasePipelineApplies && inp.path && deploy.releaseRoot) {
    const relForRead = inp.path.replace(/^\.?\//, '');
    const readBytes = deps.readFileBytes ?? realReadFileBytes;
    const [workingBytes, releaseBytes] = await Promise.all([
      readBytes(path.join(root, relForRead)),
      readBytes(path.join(deploy.releaseRoot, relForRead)),
    ]);
    releaseContentDiffers = evaluateReleaseContentDrift({ workingBytes, releaseBytes }).differs;
  }

  let runtimeGenerations: RuntimeGeneration[] = [];
  let servingRuntimes: ServingRuntimeEntry[] = [];
  if (inp.path) {
    const probeUnit = deps.probeUnitStart ?? realProbeUnitStart;
    const mtimeOf = deps.fileMtimeMs ?? realFileMtimeMs;
    const workingTreeMtimeMs = await mtimeOf(path.join(root, inp.path.replace(/^\.?\//, '')));
    const probed = await Promise.all(
      GENERATION_HOSTS.map(async (h) => ({
        unit: h.unit,
        label: h.label,
        releasePipelineApplies: h.releasePipelineApplies,
        activationLever: h.activationLever,
        process: await probeUnit(h.unit),
        // A release-checkout host receives code at DEPLOY time; a staging-tree
        // tsx host imports the file itself, so the file's own mtime is what a
        // restart would load (committed or not).
        codeAsOfMs: h.releasePipelineApplies ? (deploy.deployedAtMs ?? null) : workingTreeMtimeMs,
        contentDiffers: h.releasePipelineApplies ? releaseContentDiffers : null,
      })),
    );
    const vintageRows = await (deps.loadRuntimeVintage ?? (() => listRuntimeVintage().catch(() => [])))();
    runtimeGenerations = attachRuntimeLoadedIdentities(
      evaluateRuntimeGenerations(probed),
      vintageRows,
      deps.localRuntimeHost ?? hostname(),
    );
    const divergence = runtimeGenerationDivergenceNote(runtimeGenerations, inp.path);
    if (divergence) notes.push(divergence);

    // P-001 (acceptance-runtime-plane-not-main-2026-09-23): per-runtime containment,
    // each runtime measured against ITS OWN build identity — never the :3070 flag.
    const servingPath = superRelPath ?? inp.path.replace(/^\.?\//, '');
    const servingGitRead = gitReadForRepo(git, root);
    const servingSubmodules = { submodules: submodule ? [submodule] : [] };
    const containmentBySha = new Map<string, Promise<{ contains: boolean | null; unknown: CellUnknown | null }>>();
    servingRuntimes = await resolveServingRuntimes(selectServingRuntimes(servingPath, runtimes), {
      probeUnitStart: probeUnit,
      probeHealthSha: deps.probeHealthSha,
      probeHealthBundle: deps.probeHealthBundle,
      vintageRows,
      localHost: deps.localRuntimeHost ?? hostname(),
      readCgroup: deps.readCgroup,
      fileMtimeMs: workingTreeMtimeMs,
      listPtyHostInstances: deps.listPtyHostInstances ?? realListPtyHostInstances,
      blobContainsAt: (sha) => {
        let pending = containmentBySha.get(sha);
        if (!pending) {
          pending = classifyPathsAgainstCandidate(servingGitRead, sha, [servingPath], 'HEAD', servingSubmodules).then(
            ([row]) => ({ contains: row?.inCandidate ?? null, unknown: row?.unknownReason ?? null }),
          );
          containmentBySha.set(sha, pending);
        }
        return pending;
      },
    }).catch(() => []);
  }

  if (serving.startedSinceCodeChange === false) {
    notes.push(
      serving.restartSupersededBy
        ? `SERVING STALE CODE, BUT A DEPLOY IS ALREADY RUNNING (${serving.restartSupersededBy.unit}): ${serving.unit} (pid ${serving.pid}) started ~${serving.behindMin}m before the code it runs last changed, and the in-flight deploy restarts it. WAIT — do not fire a second deploy against the shared release checkout.`
        : `SERVING STALE CODE: ${serving.unit} (pid ${serving.pid}) started ~${serving.behindMin}m before the code it runs last changed. A git-derived "deployed" does not mean this process is running your change — ${serving.restartLever}`,
    );
  }

  // EI-19327418148563597: for a release-pipeline path, also check whether what :3070
  // actually SERVES for this file differs from the tree the caller is reading — a
  // red-gate deploy freeze can leave that gap open for hours, and a caller profiling
  // the live box off it would otherwise measure code the diff below never shows them.
  // Reuses the single comparison computed above rather than re-reading both files.
  if (runtime?.releasePipelineApplies && inp.path && deploy.releaseRoot) {
    if (releaseContentDiffers === true) {
      notes.push(
        `LIVE CODE DIFFERS FROM SOURCE: :3070 is serving a DIFFERENT version of ${inp.path} than the tree you are reading (release checkout: ${deploy.releaseRoot}). Any profiling or live measurement taken against :3070 for this path reflects that OTHER version — diff the two before designing a fix from what you measured. This gap widens the longer the gate stays red and deploys stay blocked.`,
      );
    }
  }

  // P-004: is the commit the gate judges even this file's code?
  //
  // P-011 (main-green-status-visible-2026-09-03): this used to be scoped to a
  // SUPERPROJECT path — the gate judges the superproject, which stores only a gitlink
  // for a submodule, so a superproject blob read across that boundary compares nothing
  // (the absence-reads-as-evidence trap resolveSubmodulePin exists for), and a submodule
  // path was answered `not-applicable`. That left ~37 submodules — every DB migration
  // among them — to a five-command hand recipe in CLAUDE.md. The classifier below is
  // gitlink-aware (`classifySubmodulePath`: resolve the pin the candidate carries, then
  // compare blobs INSIDE the submodule), so a submodule path is now measured the same
  // way, keyed on the SUPERPROJECT-relative path the caller asked about, and the pins
  // themselves are surfaced as `changeInCandidate.submodule` so a false verdict names
  // the hop that actually moves it (the superproject gitlink bump).
  let changeInCandidate: ChangeInCandidate = NO_CHANGE_IN_CANDIDATE;
  if (relPath && superRelPath) {
    /**
     * WI-36259 — reconcile the probe against the marker BEFORE anything downstream reads
     * `judgingSha`. Placement is load-bearing: `shas` on the very next line drives the blob
     * containment classification, so reconciling here is what makes the falsifier
     * (`judgingContainsPath`) answer about the sha the gate is ACTUALLY judging. Doing it
     * after would leave the headline correct and its own falsifier measuring the abandoned
     * candidate — a worse state than before, because the two would look corroborating.
     */
    const candidates = reconcileGateCandidates(
      await gateCandidatesPromise!,
      checkpointRunInFlight,
      snap.gate?.repairQueue ?? null,
    );
    const shas = [candidates.judgingSha, candidates.nextCandidateSha].filter((s): s is string => !!s);
    const gitRead = gitReadForRepo(git, root);
    // P-011: the submodule was already resolved once above from `.gitmodules`; hand the
    // classifier that answer instead of letting it re-discover the list per sha. An empty
    // list is the explicit "plain superproject path" form.
    const containmentOpts = { submodules: submodule ? [submodule] : [] };
    const byShaEntries = await Promise.all(
      [...new Set(shas)].map(
        async (sha) =>
          [sha, (await classifyPathsAgainstCandidate(gitRead, sha, [superRelPath], 'HEAD', containmentOpts))[0]] as const,
      ),
    );
    const bySha = new Map(byShaEntries);
    // P-011: the gitlink each candidate carries for the submodule — the `PIN` the hand
    // recipe made agents compute themselves. null = unreadable, or no gitlink there.
    let submoduleField: ChangeInCandidate['submodule'] = null;
    if (submodule) {
      const sub = submodule; // `let` narrowing does not survive into the closure below
      const pinFor = async (sha: string | null): Promise<string | null> =>
        sha ? ((await readSubmodulePin(git, root, sha, sub))?.sha ?? null) : null;
      const [judgingPin, nextPin] = await Promise.all([
        pinFor(candidates.judgingSha),
        candidates.nextCandidateSha === candidates.judgingSha
          ? pinFor(candidates.judgingSha)
          : pinFor(candidates.nextCandidateSha),
      ]);
      submoduleField = { path: submodule, relPath, judgingPin, nextPin };
    }
    // EI-18797292094433710: only paid for when the caller actually named a marker —
    // this is the hot path CLAUDE.md points agents at for "is my edit live".
    // The binding this uses is the GUARDED one at the top of the function, deliberately:
    // it is already a local `const` (so the truthiness narrowing does survive into the
    // async closure below — that concern is real for `inp.marker`, but not for a const),
    // and it is the only binding that screens an all-whitespace marker. Re-reading
    // `inp.marker` here instead would type-check identically while silently restoring the
    // hazard: zod's min(3) admits "   ", which `split` then matches against every run of
    // indentation in the file — a large count, `present: true`, and a CONFIDENT WRONG
    // "the candidate carries your change", which is the one failure this module exists to
    // make impossible.
    const markerBySha = new Map<string, MarkerContainment>();
    if (marker) {
      // P-011: `markerAtCandidateForPath` resolves the gitlink for a submodule path and
      // counts inside the pinned submodule commit; a plain path goes straight through to
      // `markerAtCommit`. Never call `markerAtCommit` on a superproject-relative
      // submodule path — its '' from `ls-tree` reads as a DEFINITIVE "not in the candidate".
      const markerEntries = await Promise.all(
        [...new Set(shas)].map(
          async (sha) =>
            [sha, await markerAtCandidateForPath(gitRead, sha, superRelPath, marker, containmentOpts)] as const,
        ),
      );
      for (const [sha, m] of markerEntries) markerBySha.set(sha, m);
    }
    const judgingClassification = candidates.judgingSha ? (bySha.get(candidates.judgingSha) ?? null) : null;
    changeInCandidate = evaluateChangeInCandidate({
      relPath: superRelPath,
      candidates,
      judging: judgingClassification,
      next: candidates.nextCandidateSha ? (bySha.get(candidates.nextCandidateSha) ?? null) : null,
      markerJudging: candidates.judgingSha ? (markerBySha.get(candidates.judgingSha) ?? null) : null,
      markerNext: candidates.nextCandidateSha ? (markerBySha.get(candidates.nextCandidateSha) ?? null) : null,
      submodule: submoduleField,
      // P-022: the ledger verdict rides beside the blob verdict — same diagnostic the
      // gate-owner brief and /admin/git read, so the three cannot disagree about "admitted".
      admittedToLineage: admittedToLineageFor(snap.gate?.repairQueue ?? null, superRelPath),
    });
    // P-011: a submodule path whose containment could NOT be measured (gitlink unreadable,
    // submodule not checked out) is hoisted on the containment leg with the classifier's
    // OWN enumerated reason — `resolver-failed`, retry-or-escalate — never the final
    // `not-applicable` this branch used to emit for every submodule path.
    if (
      submodule &&
      judgingClassification &&
      judgingClassification.inCandidate === null &&
      judgingClassification.unknownReason &&
      changeInCandidate.judgingContainsPath === null &&
      changeInCandidate.judgingShaSource !== 'run-probe'
    ) {
      verdictUnknown.push({ leg: 'changeInCandidate.judgingContainsPath', unknown: judgingClassification.unknownReason });
    }
    // EI-18797292094433710: suppressed when a marker proved the judged commit carries the
    // change — the file not being byte-identical is then a peer's edit, not a miss, and
    // shouting "DOES NOT CONTAIN" at that is the false alarm that cost the outage.
    const markerProvedPresent =
      changeInCandidate.markerJudging?.present === true ||
      (!changeInCandidate.judgingSha && changeInCandidate.markerNext?.present === true);
    if (
      !markerProvedPresent &&
      (changeInCandidate.judgingContainsPath === false || changeInCandidate.nextContainsPath === false)
    ) {
      notes.push(`CANDIDATE DOES NOT CONTAIN THIS FILE: ${changeInCandidate.detail}`);
    }
  }

  // P-004: a run-probe candidate is an inferred checkout-head read, so the path comparison
  // above deliberately omitted its verdict-shaped boolean. Keep the refusal in-band as a
  // resolver-failed leg: callers must not read the omitted field as a measured null/negative,
  // and the summary must carry the same refusal for readers who do not inspect the hoist.
  if (changeInCandidate.judgingShaSource === 'run-probe' && changeInCandidate.judgingSha !== null) {
    verdictUnknown.push({
      leg: 'changeInCandidate.judgingContainsPath',
      unknown: cellUnknown(
        'resolver-failed',
        changeInCandidate.detail ?? describeRefusal(inferredJudgingContainmentRefusal()),
      ),
    });
  }

  /**
   * P-007 leg 4 — `changeInCandidate.judgingSha`, the headline of the
   * `gate.greenCheckpoint.candidate` cell. It goes `null` TWO ways, and only one of
   * them is an answer:
   *   · no gate run is in flight — a MEASURED absence and a final answer. Not hoisted:
   *     "nothing is judging right now" is exactly what the caller asked. (`missingReason`
   *     is legitimately null here too; that is not an unexplained absence.)
   *   · a sha-only probe — there is no path to compare, so the question does not apply.
   *
   * The second is `not-applicable`: FINAL, no lever, do not retry. It must not read as
   * "no run in flight", which invites the caller to wait for a verdict that will never
   * be about their code.
   *
   * A SUBMODULE path used to be a third `not-applicable` way here ("the gate judges the
   * superproject, which stores only a gitlink"). P-011 (main-green-status-visible-
   * 2026-09-03) removed it: the containment leg now resolves that gitlink and measures
   * inside the submodule, so a submodule path either gets a real verdict or — when the
   * gitlink cannot be read — a `resolver-failed` hoist on
   * `changeInCandidate.judgingContainsPath` with the classifier's own reason (see the
   * containment block above). Reinstating a blanket `not-applicable` here would re-hide
   * the ~37 submodules behind the hand recipe this item retired.
   *
   * ⚠ WHY `missingReason` DOES NOT COVER THIS, though it looks like the obvious hoist.
   * It answers a DIFFERENT question: when a containment verdict came back FALSE, which
   * lever fixes it (uncommitted / newer-commit / absent). It is null in the case above
   * — nothing was compared, so no lever applies. Reporting the reason as FREE-TEXT
   * `detail` instead is the very mistake cell-contract.ts was written about: three
   * surfaces independently reported the reason as prose, which a human can read and a
   * program cannot branch on. The prose stays (it is genuinely useful); the branchable
   * code is here.
   */
  if (!relPath) {
    verdictUnknown.push({
      leg: 'changeInCandidate.judgingSha',
      unknown: cellUnknown(
        'not-applicable',
        'this was a sha-only probe, so there is no path whose presence in the judged candidate could be checked — not "no run is in flight"',
      ),
    });
  }

  if (verdictUnknown.length > 0) {
    notes.push(
      `${verdictUnknown.length} verdict leg(s) were NOT measured, so their reported values are defaults rather than evidence: ` +
        verdictUnknown.map((v) => `${v.leg} [${v.unknown.code}] — ${formatCellUnknown(v.unknown)}`).join(' | '),
    );
  }

  // P-006: the sweep window. `routines.gitSync.nextFireAtMs` is the scheduler's own
  // next-fire, so this reports when the commit will ACTUALLY happen rather than
  // re-deriving it from an assumed interval that a retuned routine would falsify.
  const sweepExposure = evaluateSweepExposure({
    dirtyUncommitted,
    dirtyPaths,
    nextSweepAtMs: snap.routines?.gitSync?.nextFireAtMs ?? null,
  });
  if (sweepExposure.exposed && (sweepExposure.dirtyPathCount ?? 0) > 1) {
    notes.push(`SWEEP-EXPOSED: ${sweepExposure.detail}`);
  }

  const verdictUnknownLegs = verdictUnknown.map((v) => v.leg);
  const assessments: PipelineAssessments = {
    pipelinePosition: assessPipelinePosition({
      targetSha,
      dirtyUncommitted,
      positions,
      positionsUnknown,
      positionsNewerCommit,
      servingStartedSinceCodeChange: serving.startedSinceCodeChange,
    }),
    gateVerdict: assessGateVerdict({
      inconclusive: gate.inconclusive,
      consecutiveReds: gate.consecutiveReds,
      verdictStale: gate.verdictStale,
      fireStale: gate.fireStale,
      mainBehindStaging: verdictProvenance.mainBehindStaging ?? null,
      verdictUnknownLegs,
      repairHeadVerdict: gate.repairQueue?.verdictProvenance?.repairHeadVerdict ?? null,
    }),
    gateCandidate: assessGateCandidate({
      judgingSha: changeInCandidate.judgingSha,
      judgingShaSource: changeInCandidate.judgingShaSource,
      judgingContainsPath: changeInCandidate.judgingContainsPath,
      verdictUnknownLegs,
      checkpointRunInFlight,
    }),
    gateOwnership: gate.ownership?.assessment ?? null,
    deployedSha: assessDeployedSha({
      deployedSha,
      servingStartedSinceCodeChange: serving.startedSinceCodeChange,
      servingUnknownCode: serving.unknownReason?.code ?? null,
      verdictUnknownLegs,
    }),
    mainBehindStaging: assessMainBehindStaging({
      mainBehindStaging: verdictProvenance.mainBehindStaging ?? null,
      fireStale: gate.fireStale,
      verdictUnknownLegs,
    }),
  };

  // Everything computeStages needs, before the stage table — and before deriveBlocker,
  // which reads that table to pick blockedOn/nextAction.
  const preStages: Omit<PipelinePosition, 'summary' | 'stages' | 'blockedOn' | 'nextAction'> = {
    input: { path: inp.path ?? null, sha: inp.sha ?? null },
    repoRoot: root,
    submodule,
    submodulePin,
    targetSha,
    targetShortSha,
    targetSubject,
    dirtyUncommitted,
    positions,
    assessments,
    positionsUnknown,
    positionsMarker: marker
      ? { marker, onStaging: markerLegs.onStaging, inMain: markerLegs.inMain, deployed: markerLegs.deployed }
      : null,
    positionsNewerCommit,
    verdictProvenance,
    verdictUnknown,
    deployedSha,
    gate,
    gitSyncLastStatus: snap.gitSync.lastStatus,
    // Defensive by intent, not to appease a fixture: `snap.gitSync` is parsed out of
    // free-form routine METADATA, so any of these can legitimately be absent on an
    // older/partial row. A diagnostic surface that throws when a field is missing is
    // strictly worse than one that reports a benign default — an agent trying to find
    // out why its change is stuck must never be answered with a TypeError.
    gitSync: {
      status: snap.gitSync?.lastStatus ?? null,
      lastSyncedAtMs: snap.gitSync?.lastSyncedAtMs ?? null,
      syncAgeMs:
        snap.gitSync?.lastSyncedAtMs === null || snap.gitSync?.lastSyncedAtMs === undefined
          ? null
          : Date.now() - snap.gitSync.lastSyncedAtMs,
      consecutiveErrorTicks: snap.gitSync?.consecutiveErrorTicks ?? 0,
      pushedRepos: snap.gitSync?.lastPushed ?? [],
      mergedRepos: snap.gitSync?.lastMerged ?? [],
      conflicts: snap.gitSync?.lastConflicts ?? [],
      errors: snap.gitSync?.lastErrors ?? [],
      skippedPaths: snap.gitSync?.skippedPaths ?? [],
      pushMode: snap.gitSync?.pushMode ?? null,
      ownHeadPublish: snap.gitSync?.ownHeadPublish ?? null,
    },
    runtime,
    runtimes,
    serving,
    runtimeGenerations,
    servingRuntimes,
    changeInCandidate,
    sweepExposure,
    notes,
  };
  const stages = computeStages(preStages, targetUnresolvedDetail);
  // `actionOwner` is consumed by the summary's lead clause (which re-finds it from
  // `stages`), so it is not part of the public position shape.
  const { blockedOn, nextAction } = deriveBlocker(stages);
  const base: Omit<PipelinePosition, 'summary'> = { ...preStages, stages, blockedOn, nextAction };
  return { ...base, summary: summarizePosition(base) };
}
