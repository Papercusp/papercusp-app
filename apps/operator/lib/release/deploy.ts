/**
 * The restart-as-deploy chokepoint — plan release-gate-ready-branch-2026-06-04,
 * Phase 2 (D-005). The ONE path that moves `ready` into what-the-fleet-runs.
 *
 *   drain → snapshot → swap release checkout to target → apply staged migrations
 *     → restart → health + path-verify → broadcast        (rollback on failure)
 *
 * Two halves, per D-011:
 *   - MECHANICS (this file): a deterministic, tested scaffold. You never want an
 *     LLM to forget to snapshot, so the steps + their order + rollback are code.
 *   - JUDGMENT (the release-manager agent, Claude Opus 4.8 @ xhigh): go/no-go on
 *     the gathered plan, migration-risk review, post-deploy rollback decision.
 *     The agent calls `gatherPlan` (review) then `executeDeploy` (act).
 *
 * Safe default: deploys the GREEN `ready` ref. `--deploy-commit <sha>`/`--force`
 * deploys a specific un-green commit (D-009) — loud + audited.
 *
 * All external effects go through an injected `DeployDeps`, so the whole
 * orchestration + rollback is unit-tested against stubs and the real wiring
 * (`realDeps`, deploy-deps.ts) is exercised against a throwaway unit/DB.
 */

import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import {
  releaseTriggerControlBlockReason,
  type RoutineInfo,
} from '@papercusp/operator-core/lib/git-pipeline-stats';
import type { LiveReleaseCertification } from '@papercusp/operator-core/lib/release/live-release-certification';
import {
  git,
  revParse,
  refExists,
  currentSha,
  isAncestor,
  commitsBetween,
  commitShasBetween,
  migrationsBetween,
  changedFiles,
} from './git-ops';
import { assessRisk, type RiskAssessment } from './risk-tier';
import type { ReleaseConfig } from './release-config';
import type { MigrateResult } from './migrate';
import type { HealthResult } from './health-probe';
import { fetchServingSha, type ServingShaProbe } from './health-probe';

/**
 * Repo-relative path of the papercusp-desktop submodule gitlink in the
 * superproject (desktop-submodule-of-papercup-2026-06-09 D-002). A git-sync
 * pointer bump to the submodule appears in the superproject's
 * `git diff --name-only` as exactly this single path.
 */
export const DESKTOP_SUBMODULE_PATH = 'papercusp-desktop';

/**
 * True when EVERY changed path is the desktop submodule gitlink (or under it):
 * the delta between the running release checkout and green `main` is a
 * desktop-only pointer bump the `:3070` operator never builds or uses
 * (desktop-submodule-of-papercup-2026-06-09 D-003). The auto-serve trigger uses
 * this to SKIP a deploy that would otherwise drain + restart the live operator
 * for a shell-only change. An empty list is NOT desktop-only — that's the noop
 * case, gated separately.
 */
export function isDesktopOnlyDelta(changedPaths: string[]): boolean {
  if (changedPaths.length === 0) return false;
  return changedPaths.every(
    (p) => p === DESKTOP_SUBMODULE_PATH || p.startsWith(`${DESKTOP_SUBMODULE_PATH}/`),
  );
}

export interface SnapshotInfo {
  snapshotId: number;
  kopiaSnapshotId: string;
}

export interface DeployPlan {
  target: string;
  targetSha: string;
  currentReleaseSha: string | null;
  /** target is a descendant of the current release sha (a clean FF swap). */
  isFastForward: boolean;
  /** target === the green `ready` ref. */
  green: boolean;
  forced: boolean;
  commits: string[];
  /** EI-14601: full-length SHA of every commit in `currentReleaseSha..targetSha`
   *  (any order) — lets the deploy-landed emit fire the per-sha awaitable key for
   *  every commit this deploy actually included, not just `targetSha` (the tip). */
  commitShas: string[];
  migrations: string[];
  warnings: string[];
  /**
   * WI-5864: true ONLY when the checkout is at target AND the LIVE serving
   * process (per `servingSha`) is ALSO at target — a checkout match alone is
   * NOT sufficient (see `restartOnly`). When `servingSha` can't be confirmed
   * (`!servingReachable`), this is conservatively `false` — an unconfirmed
   * match is never treated as "nothing to deploy".
   */
  noop: boolean;
  /** WI-5864: the sha the LIVE process (querying `cfg.operatorHealthUrl`) is
   *  actually serving right now — a SHORT sha, or null when unconfirmed. */
  servingSha: string | null;
  /** WI-5864: true when the health probe for `servingSha` succeeded (2xx +
   *  parsed) — false means "couldn't confirm", not "confirmed mismatched". */
  servingReachable: boolean;
  /**
   * WI-5864: the checkout is ALREADY at target (no `swap` needed) but the
   * live process is not (yet) serving it — either a confirmed mismatch or an
   * unconfirmed serving sha. `executeDeploy` skips `snapshot`+`swap` and goes
   * straight to preflight → migrate → restart → health → verify-paths. This
   * is what makes a deploy that crashed between `swap` and `restart`
   * SELF-HEALING on the very next tick instead of permanently noop: the
   * checkout never needs to move again, only the process needs restarting.
   */
  restartOnly: boolean;
  /** Every changed path between the running release checkout and target is the
   *  papercusp-desktop submodule gitlink — a shell-only pointer bump the operator
   *  deploy can skip (D-003). false when nothing, or anything non-desktop, changed. */
  desktopOnly: boolean;
  /** Phase 5: auto vs review tier (auto = docs/tests only, no migrations → unattended-safe). */
  risk: RiskAssessment;
}

export interface StepLog {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface DeployResult {
  ok: boolean;
  plan: DeployPlan;
  steps: StepLog[];
  snapshot?: SnapshotInfo | null;
  migrations?: MigrateResult;
  rolledBack: boolean;
  error?: string;
}

export interface DeployDeps {
  /** Acquire exclusive(dev-server) with a drain, run fn, release (broadcast back-up). */
  withDrain<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Freshly read the release-trigger control row after the detached deploy has
   * acquired its drain but before its first mutation. Ordinary deploys fail
   * closed on a missing/inactive/unreadable row; `plan.forced` is the explicit
   * audited bypass.
   */
  readReleaseTriggerControl(): Promise<RoutineInfo | null>;
  /** P-010: re-read specialized live/federation certification for the exact
   * target after the drain and immediately before the first mutation. */
  readLiveReleaseCertification(targetSha: string): Promise<LiveReleaseCertification>;
  /** Snapshot before swapping (D-008). null when snapshotting is disabled. */
  snapshot(reason: string): Promise<SnapshotInfo | null>;
  /** Swap the release checkout to `targetSha` (setup-release-checkout.sh). node_modules
   *  sync is the setup script's own on-disk decision (`--node-modules auto`); the old
   *  git-based lockfile signal was structurally blind and is removed (P-015). */
  runSetup(targetSha: string): Promise<void>;
  /** Build the release checkout's untracked host bundle. Fail-loud: a stale
   *  last-known-good fallback is not a successful deploy (WI-41242). */
  bundleHost(): Promise<void>;
  /** Apply staged migrations to the operator DB, fail-loud (D-007). */
  migrate(deployedSha: string | null): Promise<MigrateResult>;
  /** Restart the operator (systemctl) so it boots the release checkout. */
  restart(): Promise<void>;
  /** Poll /api/health until healthy or timeout. */
  health(): Promise<HealthResult>;
  /** Read the SHA reported by the process that is actually serving traffic. */
  servingSha(): Promise<ServingShaProbe>;
  /** Confirm every runtime read resolves under the release checkout. */
  verifyPaths(): Promise<{ ok: boolean; failures: string[] }>;
  /** PRE-CUTOVER boot check (mcp-host-availability-resilience-2026-06-22 P-001):
   *  import the swapped release checkout's side-effect-free host-handler module
   *  graph (all routes + the agent-tools/MCP registry) in a child process,
   *  resolving against ITS node_modules — WITHOUT starting a server or bootstrap.
   *  A missing/incomplete dep throws MODULE_NOT_FOUND here, so the deploy aborts
   *  BEFORE the live `:3070` cutover instead of crash-looping systemd after the
   *  restart. `ok:false` ⇒ do not cut over (the OLD process keeps serving). */
  preflight(): Promise<{ ok: boolean; error?: string }>;
  /** Restore the workspace/DB from a snapshot (rollback of schema). */
  restoreSnapshot(snap: SnapshotInfo): Promise<void>;
  /** coord:send broadcast. */
  broadcast(summary: string, body?: string): Promise<void>;
  /** Emit an awaitable event onto the shared await/notify bus (release:deployed /
   *  release:deploy-failed). INJECTED (WI-2399) instead of a hard dynamic import
   *  of the await engine inside executeDeploy: for that emit alone the mechanics
   *  used to reach past the deps seam, so a unit test that forgot to `vi.mock` the
   *  engine fired a REAL event onto the shared bus (EI-7287 — two phantom
   *  deploy:await wakes). Now it's a required dep, so TypeScript forces every
   *  caller to wire an emitter and no test can emit by default; the sole prod
   *  caller (realDeps) forwards to emitAwaitedEvent. AWAITED at the call site
   *  (EI-5993): deploy-cli process.exit()s right after executeDeploy resolves, so
   *  a fire-and-forget emit would race that exit and almost never fire. */
  emitEvent(opts: { key: string; summary?: string; payload?: unknown; source?: string }): Promise<void>;
  /** Append a `deploy` row to harness_shared.pipeline_events (the /admin/git
   *  history). Lives HERE (not in the release-trigger routine) because the
   *  routine's host dies at this deploy's own restart step — only the deploy
   *  process itself survives to record the outcome (2026-06-06 10:31: the
   *  first auto-deploy's health/rollback/broadcast/event were all lost that
   *  way). Optional: stub tests omit it. */
  recordEvent?(ev: { status: 'ok' | 'rolled-back' | 'failed'; detail: Record<string, unknown> }): Promise<void>;
  log(s: string): void;
}

/**
 * The deploy go/no-go *warnings* policy as a declarative `@papercusp/rules`
 * table (adopt-event-rules-engines D-003): each entry is a `DataCondition` over
 * the gathered facts → a warning string the release-manager weighs before
 * go/no-go. This is the declarable layer *between* the scripted mechanics
 * (`executeDeploy`, which stays imperative) and the agent's judgment — NOT a
 * hard gate. Order is the surfacing order.
 */
const DEPLOY_WARNING_RULES: { cond: DataCondition; warn: (f: DeployWarningFacts) => string }[] = [
  {
    cond: { all: [{ green: { equals: false } }, { forced: { equals: false } }] },
    warn: () => 'target is NOT the green `ready` ref and --force was not set',
  },
  {
    cond: { all: [{ currentReleaseSha: { truthy: true } }, { isFastForward: { equals: false } }] },
    warn: () => 'target is not a fast-forward of the current release — a non-FF code swap',
  },
  {
    cond: { migrationCount: { gt: 0 } },
    warn: (f) => `${f.migrationCount} staged migration(s) will apply atomically at deploy`,
  },
];

interface DeployWarningFacts {
  green: boolean;
  forced: boolean;
  currentReleaseSha: string | null;
  isFastForward: boolean;
  migrationCount: number;
}

/** Run the declarative warning rules over the gathered facts, in surfacing order. */
function deployWarnings(facts: DeployWarningFacts): string[] {
  return DEPLOY_WARNING_RULES.filter((r) => evaluateDataCondition(r.cond, facts)).map((r) => r.warn(facts));
}

/**
 * Gather the deploy plan WITHOUT side effects — the release-manager reviews this
 * (diff + staged migrations) before go/no-go. Git-only + one cheap, non-retrying
 * health read (`deps.fetchServingSha`, WI-5864) — still safe: the health read
 * never throws and never blocks (a single `requestTimeoutMs`-bounded fetch).
 */
export async function gatherPlan(
  cfg: ReleaseConfig,
  opts: { target?: string; force?: boolean } = {},
  deps: { fetchServingSha?: (url: string) => Promise<ServingShaProbe> } = {},
): Promise<DeployPlan> {
  const fetchServingShaFn = deps.fetchServingSha ?? ((url: string) => fetchServingSha(url));
  const targetRef = opts.target ?? cfg.releaseRef;
  const targetSha = await revParse(cfg.integrationRoot, targetRef);
  const readySha = (await refExists(cfg.integrationRoot, cfg.releaseRef))
    ? await revParse(cfg.integrationRoot, cfg.releaseRef)
    : null;
  const green = readySha !== null && targetSha === readySha;

  let currentReleaseSha: string | null = null;
  try {
    currentReleaseSha = await currentSha(cfg.releaseRoot);
  } catch {
    currentReleaseSha = null; // release checkout not set up yet
  }

  const isFastForward = currentReleaseSha
    ? await isAncestor(cfg.integrationRoot, currentReleaseSha, targetSha)
    : true;
  const commits = await commitsBetween(cfg.integrationRoot, currentReleaseSha, targetSha);
  const commitShas = await commitShasBetween(cfg.integrationRoot, currentReleaseSha, targetSha);
  const migrations = await migrationsBetween(cfg.integrationRoot, currentReleaseSha, targetSha);

  // Phase 5 risk-tier: classify from ALL changed files + the staged migrations'
  // content (so destructive DDL is flagged) — auto vs review.
  const allChanged = await changedFiles(cfg.integrationRoot, currentReleaseSha, targetSha);
  // D-003: a desktop-only pointer bump (every changed path under papercusp-desktop)
  // must not auto-redeploy the operator (which never builds/uses the shell).
  const desktopOnly = isDesktopOnlyDelta(allChanged);
  const migrationContents: Record<string, string> = {};
  for (const m of migrations) {
    try {
      migrationContents[m] = await git(cfg.integrationRoot, ['show', `${targetSha}:${m}`]);
    } catch {
      /* file unreadable at ref — leave it out; the path alone already forces review */
    }
  }
  const risk = assessRisk(allChanged, migrations, migrationContents);

  const warnings = deployWarnings({
    green,
    forced: !!opts.force,
    currentReleaseSha,
    isFastForward,
    migrationCount: migrations.length,
  });

  // WI-5864: the checkout matching `targetSha` is necessary but NOT sufficient
  // for "nothing to deploy" — the LIVE process may have crashed between `swap`
  // and `restart` on a PRIOR attempt, leaving the checkout at target while the
  // old process is still what's actually serving. Confirm against the live
  // serving sha (a short sha — compare with startsWith, not ===) before
  // declaring noop; an unconfirmed read is treated as a mismatch, never as a
  // silent pass.
  const checkoutAtTarget = currentReleaseSha === targetSha;
  let servingSha: string | null = null;
  let servingReachable = false;
  if (checkoutAtTarget) {
    // Only need this read when the checkout already matches — it's the ONLY
    // case where the answer changes noop/restartOnly; skip the network call
    // entirely otherwise (a real code delta is never noop regardless).
    const probe = await fetchServingShaFn(cfg.operatorHealthUrl);
    servingSha = probe.sha;
    servingReachable = probe.reachable;
  }
  const servingAtTarget = checkoutAtTarget && servingReachable && !!servingSha && targetSha.startsWith(servingSha);
  const noop = checkoutAtTarget && servingAtTarget;
  const restartOnly = checkoutAtTarget && !servingAtTarget;

  return {
    target: targetRef,
    targetSha,
    currentReleaseSha,
    isFastForward,
    green,
    forced: !!opts.force,
    commits,
    commitShas,
    migrations,
    warnings,
    noop,
    servingSha,
    servingReachable,
    restartOnly,
    desktopOnly,
    risk,
  };
}

export interface ExecuteOpts {
  rollbackOnFailure?: boolean;
}

/**
 * Execute the deploy mechanics in order, inside the drain, with rollback on any
 * failure of swap/bundle/migrate/restart/health/serving-sha/verify. Pure
 * orchestration over deps.
 */
export async function executeDeploy(
  cfg: ReleaseConfig,
  plan: DeployPlan,
  deps: DeployDeps,
  opts: ExecuteOpts = {},
): Promise<DeployResult> {
  const rollbackOnFailure = opts.rollbackOnFailure ?? true;
  const steps: StepLog[] = [];
  const short = (s: string | null) => (s ? s.slice(0, 8) : 'none');

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    deps.log(`▶ ${name}`);
    const t = Date.now();
    try {
      const r = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t });
      return r;
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  return deps.withDrain(async (): Promise<DeployResult> => {
    const prevReleaseSha = plan.currentReleaseSha;
    let snapshot: SnapshotInfo | null = null;
    let migrations: MigrateResult | undefined;
    // Track how far the deploy got, so rollback only undoes what actually happened:
    //   migrateRan  → migrations were applied (need a DB restore on rollback)
    //   liveCutover → :3070 was restarted into the new release (need a live restart back)
    // A pre-cutover failure (e.g. preflight) leaves BOTH false ⇒ the live process never
    // changed ⇒ rollback just reverts the tree, zero downtime.
    let migrateRan = false;
    let liveCutover = false;

    // EI-20512352412751871: the agent-facing status read happens BEFORE the
    // detached deploy process launches. A safety pause can land in that gap, so
    // status gating alone has a TOCTOU hole. Re-read the SAME canonical control
    // row here, inside the drain and immediately before snapshot (the first
    // deploy mutation). This guard intentionally sits OUTSIDE the rollback try:
    // a pure control refusal changed nothing and must not run rollback, emit a
    // deploy-failed event, or broadcast a false deploy failure. Force is the one
    // explicit, audited bypass.
    if (plan.forced) {
      deps.log('forced deploy: explicitly bypassing release-trigger control and live-certification guards');
    } else {
      try {
        await step('release-trigger-control', async () => {
          const control = await deps.readReleaseTriggerControl();
          const refusal = releaseTriggerControlBlockReason(control);
          if (refusal) throw new Error(refusal);
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        const error = `ordinary deploy refused before mutation: ${detail}`;
        deps.log(`✖ ${error}`);
        return { ok: false, plan, steps, snapshot, migrations, rolledBack: false, error };
      }
      try {
        await step('live-certification', async () => {
          const certification = await deps.readLiveReleaseCertification(plan.targetSha);
          if (!certification.certified) {
            throw new Error(
              `exact-SHA live certification ${certification.status}: ${certification.reason}`,
            );
          }
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        const error = `ordinary deploy refused before mutation: ${detail}`;
        deps.log(`✖ ${error}`);
        return { ok: false, plan, steps, snapshot, migrations, rolledBack: false, error };
      }
    }

    try {
      snapshot = await step('snapshot', () => deps.snapshot(`pre-deploy ${short(plan.targetSha)}`));
      // WI-5864: `restartOnly` means the checkout is ALREADY at target (a prior
      // deploy attempt swapped it and then crashed before restarting) — running
      // `runSetup` again would be redundant at best and, worse, would silently
      // mask a rollback/manual-recovery signal that the tree isn't what we think.
      // The whole point of this plan flag is that the ONLY remaining step is
      // getting the live process to load what's already on disk.
      if (plan.restartOnly) {
        deps.log(
          `restart-only: checkout already at ${short(plan.targetSha)} (serving ${plan.servingSha ?? 'unknown'}) — skipping swap, restarting into it`,
        );
      } else {
        await step('swap', () => deps.runSetup(plan.targetSha));
      }
      // dist-host/hono-host.mjs is deliberately UNTRACKED, so swapping the git
      // checkout cannot update the code the operator actually executes. Build
      // it explicitly before preflight/cutover; bundle-host fails non-zero when
      // it had to retain stale bytes (WI-41242).
      await step('bundle-host', () => deps.bundleHost());
      // PRE-CUTOVER boot check (P-001): confirm the swapped checkout can load its
      // module graph BEFORE touching live :3070. If a botched swap left node_modules
      // incomplete (→ MODULE_NOT_FOUND), we catch it here while the OLD process is
      // still serving — no crash-loop, and rollback reverts the tree without a restart.
      const preflight = await step('preflight', () => deps.preflight());
      if (!preflight.ok) {
        throw new Error(
          `pre-cutover boot check failed — release checkout would not boot, refusing to cut over :3070: ${preflight.error ?? 'unknown'}`,
        );
      }
      // The checkout now points at targetSha, but :3070 is still serving the
      // pre-cutover revision. A guarded migration must judge THAT revision;
      // checking checkout HEAD here would incorrectly certify same-deploy code.
      const deployedSha = plan.restartOnly ? plan.servingSha : plan.currentReleaseSha;
      migrations = await step('migrate', () => deps.migrate(deployedSha));
      migrateRan = true;
      await step('restart', () => deps.restart());
      liveCutover = true;

      const health = await step('health', () => deps.health());
      if (!health.healthy) throw new Error(`health probe failed after restart: ${health.error ?? 'unhealthy'}`);
      const serving = await step('serving-sha', () => deps.servingSha());
      if (!serving.reachable || !serving.sha || !plan.targetSha.startsWith(serving.sha)) {
        throw new Error(
          `serving process sha mismatch after restart: expected ${short(plan.targetSha)}, got ${serving.sha ?? 'unavailable'}` +
            (serving.error ? ` (${serving.error})` : ''),
        );
      }
      const verify = await step('verify-paths', () => deps.verifyPaths());
      if (!verify.ok) throw new Error(`release-path verify failed: ${verify.failures.join('; ')}`);

      // EI-10361: report-mode memory-canary verdict never throws (health.healthy
      // stayed true above) but a `degraded` reading is worth a loud note in the
      // deploy broadcast — this IS the value of catching it here instead of
      // waiting for the next scheduled 05:45 canary tick.
      const canary = health.memoryCanary;
      const canaryNote =
        canary?.reachable && canary.ran && canary.status === 'degraded'
          ? ` ⚠️ memory recall canary DEGRADED post-deploy (r@10=${canary.rAt10 ?? '—'}, zeroHitRate=${canary.zeroHitRate ?? '—'}) — report-only, deploy not blocked; investigate before the next scheduled tick.`
          : '';

      // EI-18798501894652068: the human-readable "N migration(s)" count below must
      // come from the SAME array the payload serialises (`plan.migrations`, the
      // staged/git-diff list) — never from `migrations.appliedCount`, which counts
      // only what THIS migrate() invocation newly applied and can legitimately be
      // LOWER (e.g. 0) when a prior deploy attempt already applied them, even though
      // this deploy still carries them and a reader deciding whether to run
      // db:check_drift needs to see that. A summary and a payload disagreeing about
      // one deploy is worse than either being terse: the summary is what gets read,
      // so it must never undercount what the payload (correctly) lists.
      const migrationCount = plan.migrations.length;
      await step('broadcast', () =>
        deps.broadcast(
          `✅ deployed ${short(plan.targetSha)} (${plan.commits.length} commit(s), ${migrationCount} migration(s))${canaryNote ? ' ⚠️ memory canary degraded' : ''}`,
          `Release gate: advanced release checkout ${short(prevReleaseSha)} → ${short(plan.targetSha)}. ` +
            `Staged migrations: ${plan.migrations.join(', ') || 'none'}.${canaryNote}`,
        ),
      );
      // await-event-primitive-2026-06-05 P-015: deploy-landed is awaitable —
      // the standard "my change reaches GREEN :3070 on the next deploy"
      // deferral can now SLEEP on `release:deployed` instead of being a
      // hand-tracked re-verify chore.
      // AWAITED (not void, EI-5993 fix): deploy-cli process.exit()s right after
      // main() resolves, same as recordEvent below — a fire-and-forget emit here
      // raced that exit and was almost always killed before it fired, so every
      // caller `events:await`-ing `release:deployed` timed out despite the deploy
      // succeeding. Now via the INJECTED deps.emitEvent (WI-2399), not a hard
      // dynamic import — the swallow keeps a bus hiccup from failing a good deploy.
      try {
        const summary = `deployed ${short(plan.targetSha)} (${plan.commits.length} commit(s), ${migrationCount} migration(s))`;
        const payload = { sha: plan.targetSha, commits: plan.commits.length, migrations: plan.migrations };
        // GLOBAL key — wake on the NEXT deploy of any sha (the payload.sha says which).
        await deps.emitEvent({ key: 'release:deployed', summary, payload, source: 'release-gate' });
        // PER-SHA key (event-await-… P-102) — "did MY sha land?" without payload-
        // filtering the global. An agent that knows its target sha awaits exactly it.
        await deps.emitEvent({ key: `release:deployed:${plan.targetSha}`, summary, payload, source: 'release-gate' });
        // EI-14601: a batched fast-forward lands EVERY commit in `plan.commitShas`, not
        // just the tip — an agent awaiting the exact sha of an EARLIER commit in this
        // same batch would otherwise time out forever (its sha never equals
        // `plan.targetSha`) despite its fix actually shipping. Fire the same per-sha key
        // for each other commit this deploy included so `deploy:await{sha}` (and a raw
        // events:await keyed on it) wakes for any of them, not only the batch's tip.
        for (const sha of plan.commitShas) {
          if (sha === plan.targetSha) continue; // already emitted above
          await deps.emitEvent({
            key: `release:deployed:${sha}`,
            summary: `deployed (as part of ${short(plan.targetSha)}, ${short(sha)} included)`,
            payload: { sha, deployedAs: plan.targetSha, commits: plan.commits.length, migrations: plan.migrations },
            source: 'release-gate',
          });
        }
      } catch {
        /* a bus hiccup must never fail an otherwise-successful deploy */
      }
      // AWAITED (not void): deploy-cli process.exit()s right after main()
      // resolves — a dangling append would be killed before the row lands.
      if (deps.recordEvent) {
        await deps
          .recordEvent({
            status: 'ok',
            detail: { targetSha: plan.targetSha.slice(0, 12), commits: plan.commits.length, migrations: plan.migrations.length },
          })
          .catch(() => {});
      }
      return { ok: true, plan, steps, snapshot, migrations, rolledBack: false };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      deps.log(`✖ deploy failed: ${error}`);
      let rolledBack = false;
      if (rollbackOnFailure && prevReleaseSha) {
        try {
          // Always revert the on-disk tree to the prior (consistent) sha.
          await step('rollback-code', () => deps.runSetup(prevReleaseSha));
          // The host bundle is untracked too. Reverting source without rebuilding
          // would leave the failed target's bundle behind and make the rollback
          // only cosmetic.
          await step('rollback-bundle-host', () => deps.bundleHost());
          // DB restore only when migrations were actually APPLIED — a pre-cutover
          // failure (e.g. preflight) aborts before `migrate`, so the schema is
          // unchanged and a (destructive) workspace restore must be skipped.
          if (snapshot && migrateRan && plan.migrations.length > 0) {
            await step('rollback-db', () => deps.restoreSnapshot(snapshot!));
          }
          if (liveCutover) {
            // :3070 was already restarted into the bad release. Before restarting back
            // onto prev, VERIFY prev still boots (P-002): a heuristic runSetup can leave
            // prev-code + target-node_modules inconsistent (the documented "rollback ALSO
            // failed → manual recovery" class). If prev won't boot, don't restart into a
            // SECOND crash-loop — fall through to the loud manual-recovery broadcast.
            const rollbackPreflight = await step('rollback-preflight', () => deps.preflight());
            if (rollbackPreflight.ok) {
              await step('rollback-restart', () => deps.restart());
              const h = await step('rollback-health', () => deps.health());
              rolledBack = h.healthy;
            } else {
              deps.log(
                `✖ rollback preflight failed — prev checkout will not boot either (${rollbackPreflight.error ?? 'unknown'}); skipping restart, manual recovery needed`,
              );
            }
          } else {
            // PRE-CUTOVER failure: the live :3070 is still the pre-deploy process and
            // never went down, so there is nothing to restart. THIS is the path that
            // turns a botched deploy from a crash-loop into a no-op (P-001).
            //
            // But "the tree is back to prev" is a claim about the CHECKOUT, and the
            // live process being up is no evidence for it (WI-6648): `rollback-code`
            // above ran the SAME heuristic runSetup the cutover branch distrusts, so it
            // can leave prev-code against target-node_modules here too. Verify it rather
            // than asserting it — the cutover branch's P-002 reasoning applies
            // identically, only the consequence is deferred: nothing restarts *now*, so
            // an unbootable tree stays silent (health probes read 200 off the old
            // process) until the next restart by anyone, long after this deploy reported
            // `rolled-back`.
            const rollbackPreflight = await step('rollback-preflight', () => deps.preflight());
            rolledBack = rollbackPreflight.ok;
            if (rolledBack) {
              deps.log('pre-cutover failure — tree reverted to prev; live :3070 untouched (no restart, no downtime)');
            } else {
              deps.log(
                `✖ rollback preflight failed — the reverted checkout will NOT boot (${rollbackPreflight.error ?? 'unknown'}); ` +
                  `live :3070 is still serving the pre-deploy process, but the NEXT restart of it will fail — manual recovery needed`,
              );
            }
          }
        } catch (re) {
          deps.log(`✖ rollback ALSO failed: ${re instanceof Error ? re.message : re}`);
        }
      }
      await deps
        .broadcast(
          `❌ deploy of ${short(plan.targetSha)} FAILED${
            rolledBack ? ` — rolled back to ${short(prevReleaseSha)}` : ' and ROLLBACK FAILED — operator may need manual recovery'
          }: ${error}`,
        )
        .catch(() => {});
      // P-015: a failure is as awaitable as a success — a deploy-blocked
      // agent learns the bad news now, not at its timeout.
      // AWAITED (not void, EI-5993): same process.exit() race as the success path.
      // Via the INJECTED deps.emitEvent (WI-2399), not a hard dynamic import.
      await deps
        .emitEvent({
          key: 'release:deploy-failed',
          summary: `deploy of ${short(plan.targetSha)} FAILED${rolledBack ? ' (rolled back)' : ' (rollback failed)'}: ${error}`,
          payload: { sha: plan.targetSha, rolledBack, error },
          source: 'release-gate',
        })
        .catch(() => {});
      if (deps.recordEvent) {
        await deps
          .recordEvent({
            status: rolledBack ? 'rolled-back' : 'failed',
            detail: { targetSha: plan.targetSha.slice(0, 12), commits: plan.commits.length, migrations: plan.migrations.length, error: error.slice(0, 300) },
          })
          .catch(() => {});
      }
      return { ok: false, plan, steps, snapshot, migrations, rolledBack, error };
    }
  });
}
