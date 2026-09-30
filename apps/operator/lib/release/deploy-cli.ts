/**
 * Deploy CLI — the single human/agent entry to the deploy chokepoint
 * (plan release-gate-ready-branch-2026-06-04, Phase 2).
 *
 *   tsx deploy-cli.ts                 # PLAN ONLY — gather + print (review mode)
 *   tsx deploy-cli.ts --execute       # deploy the green `main` branch
 *   tsx deploy-cli.ts --deploy-commit <sha> --execute   # D-009 escape hatch (un-green, loud)
 *
 * AUTO-SERVE (staging-branch-pipeline-2026-06-06): the `system:release-trigger`
 * routine runs `--execute` itself when green `main` is ahead of the release
 * checkout. A human (or the release-manager agent, for incidents) can do the
 * same. The safe default deploys the GREEN pin (releaseRef = `main`); deploying
 * an un-green commit requires --deploy-commit/--force and emits a loud audit
 * broadcast.
 *
 * Flags: --target <ref> | --deploy-commit <sha> | --force | --no-drain
 *        | --no-rollback | --drain-sec <n> | --execute
 *        | --allow-stranded-submodules   (EI-20459175302238839 — ship despite
 *          uncommitted tracked work in an unregistered submodule; loud + audited.
 *          NOTE: --force does NOT bypass this gate; they guard different things —
 *          --force is about an UN-GREEN commit, this is about MISSING work.)
 *
 * `main` is exported + fully injectable (argv + the gather/deps/execute seams)
 * so the gate's exit-code chokepoint is unit-tested without launching a real
 * deploy (deploy-cli.test.ts). The top-level `main().then(process.exit)` runs
 * ONLY when invoked as the CLI (the ESM `require.main === module` guard), so an
 * `import` of this module is side-effect-free.
 */

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
// EI-20459175302238839: TYPE-ONLY (erased at runtime), so importing this module still
// pulls in none of the git-sync runtime — the real census is lazy-imported below, the
// same pattern as recordRefusedDeploy.
import type { StrandedSubmodule } from '@papercusp/operator-core/lib/harness/git-sync/run-git-sync';
import { operatorHomeHarnessSlug } from '@papercusp/operator-core/lib/harness/operator-home-harness';
import { releaseConfig, type ReleaseConfig } from './release-config';
import {
  gatherPlan as realGatherPlan,
  executeDeploy as realExecuteDeploy,
  type DeployDeps,
  type DeployPlan,
  type DeployResult,
  type ExecuteOpts,
} from './deploy';
import { realDeps, realRunUnderDeployLock } from './deploy-deps';
import type { RealDepsOpts } from './deploy-deps';
import type { DeployParityEvent } from './deploy-parity';

/** The marker the deploy CLI prints its plan JSON behind, so the release-trigger routine
 *  parses ONE delimited line instead of brace-slicing all of stdout (P-008). MUST stay in
 *  sync with the literal in release-actions.ts. */
export const DEPLOY_PLAN_MARKER = '__DEPLOY_PLAN__';

/**
 * Injectable seams for `main`. Every field defaults to the real wiring, so the
 * production CLI behaves exactly as before; tests override the seams to drive
 * the gate's branches (refuse / proceed / forced) against stubs — no git, no
 * drain, no restart, no real deploy.
 */
export interface DeployCliDeps {
  /** argv to parse (default `process.argv`). */
  argv?: string[];
  /** Resolved release config (default `releaseConfig()`). */
  cfg?: ReleaseConfig;
  /** Gather the (side-effect-free) deploy plan (default the real git-only `gatherPlan`). */
  gatherPlan?: (cfg: ReleaseConfig, opts: { target?: string; force?: boolean }) => Promise<DeployPlan>;
  /** Build the real-effect deploy deps (default `realDeps`). */
  makeDeps?: (cfg: ReleaseConfig, opts: RealDepsOpts) => DeployDeps;
  /** Run the deploy mechanics (default the real `executeDeploy`). */
  executeDeploy?: (cfg: ReleaseConfig, plan: DeployPlan, deps: DeployDeps, opts: ExecuteOpts) => Promise<DeployResult>;
  /** stdout sink (default `console.log`). */
  out?: (s: string) => void;
  /** stderr sink (default `console.error`). */
  err?: (s: string) => void;
  /** Record the `refused` pipeline event on the exit-2 gate (default the real
   *  recordRefusedDeploy). Tests inject a no-op so they never write live telemetry —
   *  otherwise the refused-path test (and the gate's own `test:affected` run) would spew
   *  fake `refused` rows with the fixture sha into production pipeline_events. */
  recordRefused?: (targetSha: string) => Promise<void>;
  /**
   * EI-20459175302238839: measure POPULATED-but-UNREGISTERED submodules holding
   * uncommitted TRACKED work in the integration tree — work no sweep can carry, so it
   * exists on exactly one box and in no git history while the artifact we are about to
   * ship is built from committed state without it.
   *
   * Returns `null` for NOT MEASURED, deliberately distinct from `[]` (measured, clean) —
   * the same contract as `GitSyncOutcome.strandedSubmodules`. Injected so the gate's
   * branches are unit-testable against stubs, with no git and no real submodules.
   */
  censusStranded?: (integrationRoot: string) => Promise<StrandedSubmodule[] | null>;
  /** EI-18835078701597295: record the `coalesced` pipeline event when this attempt
   *  yields to a holder. The CLI is ONE PROCESS PER ATTEMPT, so "how many attempts in
   *  a row have coalesced" cannot live in memory here — it has to be durable, or the
   *  consecutive-coalesce alarm has nothing to count. Same injectable shape (and same
   *  reason) as `recordRefused`: tests inject a no-op so a coalesce-path test never
   *  writes fixture rows into production pipeline_events. */
  recordCoalesced?: (ev: { holder: string | null; holderAlive: boolean | null }) => Promise<void>;
  /** P-015 deploy honesty: record the parity consequence of a COMPLETED deploy —
   *  a successful FORCED (un-green) deploy opens the `deploy-parity:<harness>`
   *  condition + standing fact (tested≠deployed is now loud + durable); a
   *  successful GREEN deploy clears them and verifies main==origin/main
   *  (default the real recordDeployParityAfterDeploy). Same injectable shape
   *  (and same reason) as `recordRefused`: tests inject a no-op so they never
   *  write live facts / coord broadcasts from a stubbed deploy. */
  recordParity?: (ev: DeployParityEvent) => Promise<void>;
  /** EI-13729: single-flight the ENTIRE gather+execute flow (default
   *  `realRunUnderDeployLock` — the `release-deploy` resource, try-only). A
   *  concurrent `--execute` while another holds it COALESCES (skips, exit 0)
   *  instead of racing the shared release checkout. Tests inject a stub that
   *  always "acquires" so they exercise the flow without touching PG. */
  runUnderDeployLock?: <T>(
    fn: () => Promise<T>,
  ) => Promise<
    | { acquired: true; result: T }
    /** EI-18833814302562374: `holderAlive` distinguishes yielding to a LIVE deploy
     *  from blocking on a GHOST. true = holder's pid is running; false = verifiably
     *  dead (should have been reclaimed — report it loudly); null = the owner shape
     *  carries no host-local pid, so liveness is genuinely unknown. */
    | { acquired: false; holder: string | null; holderAlive?: boolean | null }
  >;
}

/**
 * The deploy CLI entrypoint. Returns the process exit code:
 *   0 — plan-only, noop, or a successful deploy
 *   1 — a deploy ran but failed
 *   2 — REFUSED: an un-green target without --force/--deploy-commit, OR stranded
 *       submodule work without --allow-stranded-submodules (the gate)
 *
 * Pure over its injected deps — `process.exit` is the caller's job (the
 * top-level guard below), so a test can assert the returned code directly.
 */
export async function main(injected: DeployCliDeps = {}): Promise<number> {
  const argv = injected.argv ?? process.argv;
  const out = injected.out ?? ((s: string) => console.log(s));
  const err = injected.err ?? ((s: string) => console.error(s));
  const gatherPlan = injected.gatherPlan ?? realGatherPlan;
  const makeDeps = injected.makeDeps ?? realDeps;
  const executeDeploy = injected.executeDeploy ?? realExecuteDeploy;
  const recordRefused = injected.recordRefused ?? recordRefusedDeploy;
  const recordCoalesced = injected.recordCoalesced ?? recordCoalescedDeploy;
  const recordParity = injected.recordParity ?? recordDeployParityAfterDeploy;
  const runUnderDeployLock = injected.runUnderDeployLock ?? realRunUnderDeployLock;
  const censusStranded = injected.censusStranded ?? realCensusStrandedSubmodules;

  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const cfg = injected.cfg ?? releaseConfig();
  const deployCommit = arg('--deploy-commit');
  const force = has('--force') || !!deployCommit;
  const target = deployCommit ?? arg('--target');
  const execute = has('--execute');

  // EI-13729: the full gather-through-execute flow, extracted so the
  // --execute path can run it UNDER the release-deploy single-flight lock
  // (below) instead of directly. Read-only / unchanged when `execute` is
  // false — a plan-only invocation never touches the lock.
  const runDeployFlow = async (): Promise<number> => {
    const plan = await gatherPlan(cfg, { target, force });

    // The pretty plan goes to STDERR (human-readable); STDOUT carries ONLY the single
    // marker line. CRITICAL for cross-version compat: the release-trigger runs this CLI
    // from the integration tree, so a DEPLOYED (older) release-trigger — which still
    // brace-slices stdout `slice(indexOf('{'), lastIndexOf('}'))` — runs THIS newer CLI.
    // Two JSON objects on stdout (pretty + marker) made that slice span both + the marker
    // text → invalid JSON → "could not parse deploy plan" → NO deploys (the pipeline
    // wedged on 2026-06-09). One object on stdout keeps the old brace-slice (it lands on
    // the marker JSON, which carries `.plan`) AND the new marker parse both working.
    err(JSON.stringify({ mode: execute ? 'execute' : 'plan', config: { releaseRoot: cfg.releaseRoot, releaseRef: cfg.releaseRef, unit: cfg.systemdUnit }, plan }, null, 2));
    out(`${DEPLOY_PLAN_MARKER} ${JSON.stringify({ mode: execute ? 'execute' : 'plan', plan })}`);

    if (plan.warnings.length) {
      err('\n⚠ WARNINGS:');
      for (const w of plan.warnings) err(`   - ${w}`);
    }

    if (!execute) {
      err('\n[deploy] PLAN ONLY — pass --execute to run. (The release-manager reviews this diff + the staged migrations before go/no-go.)');
      return 0;
    }

    if (plan.noop) {
      err('[deploy] release checkout already at target AND the live process is serving it — nothing to deploy.');
      return 0;
    }

    // WI-5864: NOT logged-then-skipped like noop above — restartOnly proceeds
    // into the normal deploy flow below (executeDeploy skips just the swap
    // step); this line only makes the "why is a deploy running when the
    // checkout already matches" case loud instead of looking like a full
    // re-deploy for no reason.
    if (plan.restartOnly) {
      err(
        `[deploy] checkout already at target (${plan.targetSha.slice(0, 8)}) but the live process is serving ` +
          `${plan.servingSha ?? (plan.servingReachable ? 'a different build' : 'an UNCONFIRMED sha (health probe unreachable)')} — ` +
          `restart-only deploy (no checkout swap).`,
      );
    }

    // Safe default: refuse a non-green target unless explicitly forced (D-009).
    if (!plan.green && !force) {
      err(`\n[deploy] REFUSING: target is not the green \`${cfg.releaseRef}\` pin.`);
      err('         Override with --deploy-commit <sha> or --force (deploys an UN-GREEN state; loud + audited).');
      // P-008: record the gate refusal so /admin/git's deploy stats fold it — the 'refused'
      // status was counted by the fold but never written by anything. Best-effort.
      await recordRefused(plan.targetSha).catch(() => {});
      return 2;
    }

    // EI-20459175302238839 — STRANDED SUBMODULE GATE. A submodule that is POPULATED but
    // absent from .git/config (`git submodule init` never ran) is invisible to git-sync:
    // it holds uncommitted TRACKED work no sweep can ever carry, so the change lives on
    // exactly one box and in no history, while the artifact we are about to ship is built
    // from committed state WITHOUT it. Nothing fails and nothing alerts — the pass that
    // strands the work is otherwise a perfectly clean 'synced'. Twice in one week that
    // shipped: WI-38933 (a token-kit patch existing in no history, so only that box could
    // `npm ci`) and WI-38945 (libs/sse export conditions absent from the built image →
    // production crash-loop). git-sync ALREADY measures this every tick and merely LOGS
    // it; this gate is the one condition that makes the existing signal refuse instead of
    // scroll past while a release ships from the affected tree.
    const allowStranded = has('--allow-stranded-submodules');
    // A census failure must never wedge every deploy, so a throw folds into the same
    // NOT-MEASURED branch as an explicit null instead of crashing the CLI.
    const stranded = await censusStranded(cfg.integrationRoot).catch(() => null);
    if (stranded === null) {
      // NOT MEASURED is deliberately NOT an all-clear — collapsing those two is the exact
      // silence this census exists to break. But it does NOT refuse either: `git submodule
      // status --recursive` exits non-zero on ONE stray gitlink anywhere in the tree (a
      // known recurring condition — a swept-in temp repo did it for days on 2026-07-01),
      // so failing closed here would trade a strand RISK for a pipeline-wedge CERTAINTY.
      // Say loudly that the check did not run, and why.
      err(
        `\n⚠ [deploy] STRANDED-SUBMODULE CHECK DID NOT RUN for ${cfg.integrationRoot} — census NOT MEASURED. ` +
          `This is NOT an all-clear: uncommitted tracked work in an unregistered submodule would be invisible to this deploy. ` +
          `Usually a stray gitlink makes 'git submodule status --recursive' exit non-zero — fix with: git rm --cached <path>.`,
      );
    } else if (stranded.length > 0) {
      const list = stranded
        .map((s) => `${s.path} (${s.trackedFiles} tracked file(s): ${s.files.slice(0, 5).join(', ')})`)
        .join('; ');
      if (!allowStranded) {
        err(
          `\n[deploy] REFUSING: ${stranded.length} populated but UNREGISTERED submodule(s) hold uncommitted tracked work ` +
            `that git-sync can NEVER commit — ${list}`,
        );
        err('         This deploy would ship committed state WITHOUT that work (the WI-38945 shape: a clean-looking release that crash-loops).');
        err('         Rescue it first: git submodule init <path> (idempotent), then let git-sync commit it.');
        err('         Override with --allow-stranded-submodules (ships known-missing work; loud + audited).');
        await recordRefused(plan.targetSha).catch(() => {});
        return 2;
      }
      err(
        `\n🚨 DEPLOYING WITH STRANDED WORK — ${stranded.length} unregistered submodule(s) hold uncommitted tracked ` +
          `changes this release does NOT contain: ${list}`,
      );
    }

    const deps = makeDeps(cfg, {
      noDrain: has('--no-drain'),
      drainSec: arg('--drain-sec') ? Number(arg('--drain-sec')) : undefined,
    });

    // D-009: a forced un-green deploy is loud + audited before it runs.
    if (!plan.green) {
      err(`\n🚨 FORCED UN-GREEN DEPLOY — deploying a commit that is NOT the green \`${cfg.releaseRef}\` pin. This bypasses the quality gate.`);
      await deps
        .broadcast(
          `🚨 FORCED un-green deploy of ${plan.targetSha.slice(0, 8)} (NOT green \`${cfg.releaseRef}\`) — escape hatch (D-009), by release-deploy`,
          `Target ${plan.targetSha} is not the green ${cfg.releaseRef} pin. Commits: ${plan.commits.length}. Staged migrations: ${plan.migrations.join(', ') || 'none'}.`,
        )
        .catch(() => {});
    }

    // EI-20459175302238839: an ACKED strand bypass is audited like the forced un-green
    // deploy above — knowingly shipping an artifact that omits work only one box has is at
    // least as consequential as knowingly shipping an un-green commit.
    if (stranded && stranded.length > 0) {
      await deps
        .broadcast(
          `🚨 Deploy of ${plan.targetSha.slice(0, 8)} SHIPPED WITH STRANDED WORK — ${stranded.length} unregistered submodule(s), --allow-stranded-submodules`,
          `Populated but unregistered submodules held uncommitted tracked work this release does NOT contain: ` +
            `${stranded.map((s) => `${s.path} (${s.trackedFiles} tracked file(s))`).join('; ')}. ` +
            `Rescue with: git submodule init <path>, then let git-sync commit it.`,
        )
        .catch(() => {});
    }

    const res = await executeDeploy(cfg, plan, deps, { rollbackOnFailure: !has('--no-rollback') });
    out(JSON.stringify({ ok: res.ok, rolledBack: res.rolledBack, error: res.error, steps: res.steps }, null, 2));
    // P-015 deploy honesty — best-effort AFTER the result is known: a forced
    // success opens the tested≠deployed fact + condition; a green success
    // clears them. Must never change the exit code (same rule as the other
    // telemetry writers here).
    await recordParity({
      ok: res.ok,
      green: plan.green,
      targetSha: plan.targetSha,
      installSlug: process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug(),
      integrationRoot: cfg.integrationRoot,
    }).catch(() => {});
    return res.ok ? 0 : 1;
  };

  if (!execute) return runDeployFlow();

  // EI-13729: single-flight the whole gather+execute flow around the ONE
  // chokepoint every deploy trigger (auto-serve, manual --execute,
  // release:deploy op:trigger) funnels through. TRY-ONLY — a concurrent
  // attempt COALESCES instead of computing (and then racing) a plan that may
  // already be stale by the time it would run.
  const lockOutcome = await runUnderDeployLock(runDeployFlow);
  if (!lockOutcome.acquired) {
    // EI-18833814302562374 Defect 3: "COALESCED" alone reads as correct, polite
    // single-flighting — the system standing down for a peer — and is IDENTICAL
    // whether the holder is a live deploy or a crashed process's leaked lease.
    // An agent reading it concludes "a deploy is already running, wait for it"
    // and waits for something that will never happen. Always state liveness.
    const liveness =
      lockOutcome.holderAlive === true
        ? 'holder is ALIVE — a real deploy is in progress; standing down is correct'
        : lockOutcome.holderAlive === false
          ? 'holder is DEAD (pid not running) — this is a LEAKED lease, not a running deploy; ' +
            'it should have been reclaimed automatically, so treat this as a bug worth filing'
          : 'holder liveness UNKNOWN (owner string carries no host-local pid) — ' +
            'do NOT assume a deploy is running; verify before waiting on it';
    err(
      `\n[deploy] COALESCED — another deploy already holds the release-deploy lock ` +
        `(${lockOutcome.holder ?? 'unknown holder'}); ${liveness}. ` +
        `Skipping this attempt rather than racing the shared release checkout.`,
    );
    out(
      `${DEPLOY_PLAN_MARKER} ${JSON.stringify({
        mode: 'execute',
        coalesced: true,
        holder: lockOutcome.holder,
        holderAlive: lockOutcome.holderAlive ?? null,
      })}`,
    );
    // EI-18835078701597295: the stderr line above is read by whoever happens to be
    // looking; nothing counts it. A wedged (live-but-stuck) holder, or one whose owner
    // string carries no parseable pid, is never reclaimed — so every later attempt
    // coalesces politely and delivery halts with NOTHING paging. The 3h
    // release-deploy-staleness watchdog only sees the downstream symptom. Persisting the
    // coalesce is what lets `deploy-coalesce-stall-detect` alarm on the CAUSE, which is
    // visible on the SECOND failed acquire. Best-effort by construction: a telemetry
    // failure must never change a deploy's exit code.
    await recordCoalesced({
      holder: lockOutcome.holder,
      holderAlive: lockOutcome.holderAlive ?? null,
    }).catch(() => {});
    return 0;
  }
  return lockOutcome.result;
}

/**
 * EI-20459175302238839: the real strand census. Lazy-imports operator-core so an
 * `import` of this module stays light (the same reason as recordRefusedDeploy below) —
 * the static import above is TYPE-ONLY and erased.
 *
 * Returns `null` for NOT MEASURED, distinct from `[]` (measured, clean); the gate
 * branches on that explicitly rather than treating an empty/falsy result as an all-clear.
 */
async function realCensusStrandedSubmodules(integrationRoot: string): Promise<StrandedSubmodule[] | null> {
  const { censusStrandedSubmodules, runGitBounded } = await import(
    '@papercusp/operator-core/lib/harness/git-sync/run-git-sync'
  );
  // 30s per git call: `submodule status --recursive` plus one `status` per unregistered
  // submodule, on a tree with ~40 of them. Generous, and bounded so a hung git cannot
  // stall the deploy chokepoint indefinitely.
  return censusStrandedSubmodules((args, cwd) => runGitBounded(args, cwd, 30_000), integrationRoot);
}

/** P-008: append a `refused` deploy event to the /admin/git pipeline history when the
 *  gate declines an un-green --execute. Lazy-imports operator-core so an `import` of this
 *  module stays light; best-effort (a stats-log failure must never affect the gate). */
async function recordRefusedDeploy(targetSha: string): Promise<void> {
  const { appendPipelineEvent } = await import('@papercusp/operator-core/lib/harness/git-sync/pipeline-events');
  let workspaceId = '*';
  try {
    const { activeWorkspaceId } = await import('@papercusp/operator-core/lib/workspace-registry');
    workspaceId = activeWorkspaceId();
  } catch {
    /* no active workspace (standalone) — '*' is the pipeline_events default */
  }
  await appendPipelineEvent({
    workspaceId,
    installSlug: process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug(),
    kind: 'deploy',
    status: 'refused',
    detail: { targetSha: targetSha.slice(0, 12), reason: 'not-green and not --force' },
  });
}

/** EI-18835078701597295: persist a coalesced attempt to the pipeline history so the
 *  consecutive-coalesce alarm has something to count. Mirrors `recordStaleLockReclaim`
 *  in deploy-deps.ts (lazy import, swallow everything) — the deploy path must never
 *  fail because telemetry did. `holderAlive:false` is recorded verbatim rather than
 *  normalized away: it is the field that distinguishes a healthy queue behind a live
 *  deploy from a leaked lease the reclaim should already have taken. */
async function recordCoalescedDeploy(ev: { holder: string | null; holderAlive: boolean | null }): Promise<void> {
  try {
    const { appendPipelineEvent } = await import('@papercusp/operator-core/lib/harness/git-sync/pipeline-events');
    let workspaceId = '*';
    try {
      const { activeWorkspaceId } = await import('@papercusp/operator-core/lib/workspace-registry');
      workspaceId = activeWorkspaceId();
    } catch {
      /* no active workspace (standalone) — '*' is the pipeline_events default */
    }
    await appendPipelineEvent({
      workspaceId,
      installSlug: process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug(),
      kind: 'deploy',
      status: 'coalesced',
      detail: { holder: ev.holder, holderAlive: ev.holderAlive },
    });
  } catch {
    /* best-effort */
  }
}

/** P-015: the real parity recorder — lazy-imports the module (which itself
 *  lazy-imports its PG/coord deps) so an `import` of this CLI stays light. */
async function recordDeployParityAfterDeploy(ev: DeployParityEvent): Promise<void> {
  const { recordDeployParity, realDeployParityDeps } = await import('./deploy-parity');
  await recordDeployParity(ev, await realDeployParityDeps());
}

// Run as the CLI only — the ESM equivalent of `require.main === module`,
// bundle-safe (see isCliEntry / EI-650). An `import` of this module (a test,
// the release-trigger plan-parse) is side-effect-free.
if (isCliEntry(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[deploy] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(1);
    });
}
