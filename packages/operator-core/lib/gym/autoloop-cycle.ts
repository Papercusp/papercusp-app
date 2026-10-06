/**
 * runOneAutoloopCycle — the CALLABLE gym-cycle machinery (learning-system-audit
 * P-031), factored out of the old `gym-loop-run.ts` main() so the
 * `system:gym-cycle` routine action can run a cycle IN-PROCESS (no shell-out)
 * and the CLI (`gym-loop-run.ts`) stays a thin wrapper around the same code.
 *
 * One call = one bounded autoloop run for ONE harness: provision a dedicated
 * ephemeral gym PG (testcontainer), seed a tiny substrate repo, boot a headless
 * gym-operator, run `runOptimizationLoop` over `buildLoopDeps` (baseline →
 * propose → evaluate → gate → record), then tear everything down. Execution
 * data lands in the ephemeral gym DB; the control plane (proposals / autoloop
 * config / QD archive) goes to `opts.controlSql` (the LIVE operator DB when
 * called from the routine action) or `GYM_LOOP_CONTROL_DSN`, else the gym DB.
 *
 * Two modes (opts.fake / env GYM_LOOP_FAKE=1): fake agent + fake judge + fake
 * proposer = ZERO-LLM assembly check; real mode runs the real pipeline + the
 * frozen Opus judge, bounded by maxCycles × a hard budgetUsd (D-019).
 *
 * ALWAYS human-gated here: autoPromote is false — the loop records proposals
 * for review and the human promotes via gym:accept (D-020).
 *
 * P-032: `opts.candidateDirections` (triage-routed gym ideas from the
 * improvements backlog) flow into the proposer's context as candidate
 * directions; absent/empty ⇒ byte-identical proposer prompt to before.
 */
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { moduleRepoRoot } from '../module-repo-root';
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { provisionGymDatabase, GYM_PROVISION_PG_IMAGE } from './gym-db-init';
import { sweepOrphanedGymPgContainers } from './gym-pg-orphan-sweep';
import { readGymGates } from '../gym-gates';
import { buildGymOperatorBootSpec, scrubLauncherClaudeSessionEnv } from './boot-spec';
import { createGymRunnerPorts } from './runner-ports';
import { buildLoopDeps, type LoopTask } from './loop-deps';
import { materialisePapercuspSubstrate } from './papercusp-corpus-tasks';
import { createGymSubstrateRoot, sweepOrphanedGymSubstrates } from './gym-substrate-orphan-sweep';
import { runOptimizationLoop, type LoopResult } from './loop';
import { makeLoopProposalRecorder, setAutoloop, getAutoloop } from './control-plane';
import { gatherChampionOutcomeEntries } from './post-acceptance-outcomes';
import { makeLoopQdSeams } from './qd/archive-recorder';
import { resolveLocalEliteOutcomeSigner } from './qd/local-elite-signer';
import { readPoolAggregates } from './read-api';
import { copyRunAnalyticsToDurable } from './store';
import { GYM_JUDGE_RUBRIC_V1, rubricHash } from './judge-scoring';
import type { JudgeLlmCall } from './judge';
import type { GymLlmCall } from './task-generator';
import { spawnGymOperatorWithRetry } from './operator-ready';
import { findFreeBasePort } from '../deployment/p2p-perf-tier3/free-port-base';
import { gatewayLlmEnv, gatewayPort, resolveSpawnGatewayEnv } from '../inference-gateway/spawn-env';
import { activeWorkspaceId } from '../workspace-registry';
import { resolveGymAccountWorkspace } from './account-workspace';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';
import { bindNativeGymLlmCalls } from './proposer';

// Anchored on the checkout, not on this module's directory: this module is inlined into the
// esbuild host bundle, where import.meta.url is the bundle's URL, so both a `..` climb and a
// sibling `fixtures/` path resolved outside the checkout (P-016; see module-repo-root.ts).
const REPO_ROOT = moduleRepoRoot(import.meta.url);
const FAKE_AGENT = join(REPO_ROOT, 'packages/operator-core/lib/gym/fixtures/fake-agent.mjs');

// EI-18154750714519366: the gym-operator's default port used to be the FIXED 3976 — on a busy
// box where a routine cycle (or a leftover process) already holds it, a concurrent manual
// verification cycle's waitForOperatorReady silently passes against that OTHER operator (a
// different ephemeral gym DB) while gymSql polls the freshly-provisioned DB, producing a
// spurious "relation dbos.workflow_status does not exist" instead of a clear port-collision
// error. Probe an actually-free ephemeral port instead (mirrors the p2p-perf-tier3 chaos
// suites' findFreeBasePort — same collision class, same fix). An explicit GYM_LOOP_PORT / opts.port
// still wins outright (manual pinning, e.g. two intentionally-concurrent cycles on distinct ports).
const GYM_LOOP_PORT_RANGE = { rangeStart: 39_000, rangeEnd: 40_000 } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mask credentials in postgres DSNs (safe for logs / reports). */
export const maskDsn = (s: string): string => s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]*(@)/g, '$1***$2');

/** Two pools on one tiny substrate: a train task (drives the proposer) + a frozen dev-anchor.
 *
 *  ⚠ EVERY TASK HERE IS `corpus: 'synthetic'` AND SAYS SO (P-003). These three tasks
 *  ("add /health", "expose /version", "add /ready") run against `substrateFiles`
 *  below — a 4-line generated stub whose only build gate is `node --check`. A prompt
 *  that wins here has proven it can edit a toy file, nothing more. The label is what
 *  makes that legible downstream: it rides into gym_tasks.corpus and is what the
 *  `fitness-signal-is-real` release gate (P-011) fails on. Replacing this function
 *  with a REAL corpus is P-001; until then the honest reading of every champion
 *  crowned from it is "synthetic". */
function fixedTasks(): { tasks: LoopTask[]; substrateFiles: Array<{ path: string; content: string }> } {
  const common = { repoUrl: '__SET_AT_RUNTIME__', repoCommit: '__SET_AT_RUNTIME__', projectContext: 'A tiny Node service (index.js) with a minimal HTTP handler.', corpus: 'synthetic' as const };
  return {
    tasks: [
      { taskId: 'gym-loop-health', pool: 'train', spec: 'Add a health endpoint so operators can check the service is alive.', intent: 'Operators need a liveness probe for the service.', ...common },
      { taskId: 'gym-loop-version', pool: 'dev-anchor', spec: 'Expose the service version on a /version route.', intent: 'Operators need to see which build is running.', ...common },
      // D-014/P-028 real-anchor: scored every cycle but NEVER optimized (excluded from the
      // train/dev-anchor aggregation in buildLoopDeps.evaluate) — the falsifiability check.
      // NOTE: a faithful real-anchor is a corpus of REAL shipped features with known outcomes;
      // this synthetic stand-in exercises the MECHANISM (pool → scored-not-optimized → read-api
      // surfacing). Populating it with real features is the data-gathering follow-up.
      { taskId: 'gym-loop-ready', pool: 'real-anchor', spec: 'Add a readiness endpoint that reports the service can accept traffic.', intent: 'A representative shipped feature: operators gate traffic on a readiness signal.', ...common },
    ],
    substrateFiles: [
      // Buildable package so the chunk-loop L1 gate (`npm run typecheck`) is meaningful — see ab-run.ts.
      { path: 'package.json', content: JSON.stringify({ name: 'gym-substrate', version: '0.0.0', private: true, type: 'module', scripts: { typecheck: 'node --check index.js' } }, null, 2) + '\n' },
      { path: 'index.js', content: 'export function handle(req){ return { status: 404 }; }\n' },
      { path: 'README.md', content: '# gym loop substrate\nA tiny Node (ESM) service. `npm run typecheck` is the build gate.\n' },
    ],
  };
}

/** Fake judge: deterministic composite from trace length (zero LLM) — assembly check only. */
const fakeJudge: JudgeLlmCall = async (opts) => {
  const userLen = opts.messages.map((m) => m.content).join('').length;
  const c = 5 + (userLen % 5);
  return { text: JSON.stringify({ d1: c, d2: c, d3: c, rationale: 'fake-judge assembly check' }), costUsd: 0, inputTokens: 10, outputTokens: 10 };
};

/** Fake proposer: a fixed prompts-only edit (zero LLM) — assembly check only. */
const fakeProposer: GymLlmCall = async () => ({
  text: JSON.stringify({ promptOverrides: { worker: '# Worker\nBefore finishing, RE-READ the acceptance criteria and confirm each is met.' }, rationale: 'targets the worst train task' }),
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

export interface RunOneAutoloopCycleOptions {
  /** Workspace the run is scoped to (default env GYM_LOOP_WORKSPACE / 'gym-loop-ws'). */
  workspaceId?: string;
  /** Fake (zero-LLM) assembly mode (default env GYM_LOOP_FAKE === '1'). */
  fake?: boolean;
  /** Cycles to run this call (default env GYM_LOOP_MAX_CYCLES / 1). */
  maxCycles?: number;
  /** Repeats per (variant × task) — P-025 judge-noise averaging (default env GYM_LOOP_REPEATS / 1). */
  repeats?: number;
  /** Hard spend cap for THIS call (D-019). Default env GYM_LOOP_BUDGET_USD; real mode falls back to $50. */
  budgetUsd?: number | null;
  /** P-032: triage-routed gym ideas, pre-formatted — the proposer's candidate directions. */
  candidateDirections?: string[];
  /**
   * CALLER-OWNED control-plane client (proposals/autoloop/QD live here). Never
   * closed by this call. Takes precedence over controlDsn/GYM_LOOP_CONTROL_DSN.
   */
  controlSql?: Sql;
  /** Control-plane DSN this call opens AND closes itself (default env GYM_LOOP_CONTROL_DSN). */
  controlDsn?: string;
  /**
   * Write the gym_autoloop_config row around the run (the standalone-CLI behavior:
   * enabled:true + budget + running before; idle/paused + spentUsd OVERWRITE after).
   * The routine action passes FALSE — the tick core owns running→idle + spend
   * ACCUMULATION there (autoloop-tick.ts). Default true (CLI compatibility).
   */
  manageAutoloopRow?: boolean;
  /** Gym-operator HTTP port. Default: env GYM_LOOP_PORT if set, else a probed-free ephemeral port
   *  (GYM_LOOP_PORT_RANGE) — never a fixed default, so concurrent cycles never collide. */
  port?: number;
  /** Real-mode agent command (default env GYM_LOOP_AGENT_CMD / claude sonnet). */
  agentCmd?: string;
  /** Proposer model (default: the canonical learning model). */
  proposerModel?: string;
  /** QD novelty weight ∈ [0,1] (P-011/D-008; default env GYM_LOOP_NOVELTY_WEIGHT / 0.3). */
  noveltyWeight?: number;
  log?: (msg: string) => void;
}

export interface AutoloopCycleOutcome {
  /** True iff the loop completed ≥1 cycle without tripping the breaker. */
  ok: boolean;
  /** The loop result (spend/accepts/breaker), or null when the run errored before finishing. */
  result: LoopResult | null;
  /** The full diagnostic report (mode, loop, pool aggregates, error, operator log tail). */
  report: Record<string, unknown>;
}

/**
 * Run ONE bounded, human-gated autoloop cycle for `slug`. Never calls
 * process.exit; never throws for a failed run (inspect `outcome.ok` /
 * `report.error`). All existing in-loop gates apply: the budget cap
 * (runOptimizationLoop's budgetUsd), the rate-limit pause+resume
 * (runWithRatePause inside loop/loop-deps), and the arithmetic circuit
 * breaker (auto-revert + breakerTripped).
 */
export async function runOneAutoloopCycle(
  slug: string,
  opts: RunOneAutoloopCycleOptions = {},
): Promise<AutoloopCycleOutcome> {
  const FAKE = opts.fake ?? process.env.GYM_LOOP_FAKE === '1';
  // Explicit pin (opts.port or GYM_LOOP_PORT) always wins; otherwise probe a genuinely-free
  // ephemeral port so concurrent/manual cycles on this box never collide (see
  // GYM_LOOP_PORT_RANGE above for the full rationale — EI-18154750714519366).
  const explicitPort = opts.port ?? (process.env.GYM_LOOP_PORT !== undefined ? Number(process.env.GYM_LOOP_PORT) : undefined);
  const PORT = explicitPort ?? (await findFreeBasePort({ count: 1, ...GYM_LOOP_PORT_RANGE }));
  // WI-5675: the cycle spans TWO workspace AXES that a single `WS` used to conflate:
  //  - DURABLE_WS — the workspace the cycle is FOR. Every write that must OUTLIVE the run
  //    (gym_proposals, the autoloop row, QD archive, champion outcomes, gym gates, the
  //    run-analytics copy into harness_gym_durable) scopes here, because the owner's /gym
  //    tab reads RLS-scoped to THIS workspace. Production passes it explicitly
  //    (autoloop-tick → gym-actions, from the enabled gym_autoloop_config row); a CLI run
  //    resolves like account routing does (explicit env → process pin → active workspace).
  //  - EPHEMERAL_WS — the ISOLATED data workspace the throwaway gym stack runs under
  //    (gym-operator boot pin, runner ports, per-run harness provisioning). Isolation here
  //    is BY DESIGN: run e07ea777 (2026-07-20) proved candidate-harness provisioning
  //    breaks under the owner's workspace (resolveProject NULL for gymcand* slugs).
  //  The old single `WS` sent the durable writes under 'gym-loop-ws', so the owner's /gym
  //  tab showed 0 rows forever despite completed runs (WI-5675 — same class as WI-5125).
  const DURABLE_WS =
    opts.workspaceId ??
    (process.env.GYM_LOOP_WORKSPACE?.trim() || undefined) ??
    resolveGymAccountWorkspace(process.env, activeWorkspaceId);
  const EPHEMERAL_WS = process.env.GYM_LOOP_EPHEMERAL_WORKSPACE?.trim() || 'gym-loop-ws';
  const MAX_CYCLES = Math.max(1, opts.maxCycles ?? Number(process.env.GYM_LOOP_MAX_CYCLES ?? 1));
  const REPEATS = Math.max(1, opts.repeats ?? Number(process.env.GYM_LOOP_REPEATS ?? 1));
  const BUDGET_USD =
    opts.budgetUsd !== undefined
      ? opts.budgetUsd
      : process.env.GYM_LOOP_BUDGET_USD
        ? Number(process.env.GYM_LOOP_BUDGET_USD)
        : FAKE
          ? null
          : 50;
  const REAL_AGENT_CMD = opts.agentCmd ?? process.env.GYM_LOOP_AGENT_CMD ?? 'claude -p --model claude-sonnet-4-6';
  const PROPOSER_MODEL = opts.proposerModel ?? process.env.GYM_LOOP_PROPOSER_MODEL ?? LEARNING_MODEL_SPEC;
  const NOVELTY_WEIGHT = Math.min(1, Math.max(0, opts.noveltyWeight ?? Number(process.env.GYM_LOOP_NOVELTY_WEIGHT ?? 0.3)));
  const manageRow = opts.manageAutoloopRow ?? true;
  const log = opts.log ?? ((m: string) => process.stdout.write(`[gym-loop] ${m}\n`));

  // FB-16 / EI-368 follow-up: route the gym's IN-PROCESS judge + proposer through the pacing
  // gateway when the INFERENCE_GATEWAY flag is ON. Spawned pipeline agents already egress through
  // it (operator-spawn.ts merges gatewaySpawnEnv → ANTHROPIC_BASE_URL at the spawn chokepoint), but
  // the in-process anthropic-direct llmCalls (judgeCall/proposerCall in loop-deps.ts) never pass
  // through that chokepoint — on the live :3070 cycle they hit api.anthropic.com directly with the
  // org-blocked OAuth → LlmCallError 401, opening the circuit every tick. Point the anthropic-direct
  // SDK (PAPERCUSP_ANTHROPIC_URL) AND any claude-CLI subprocess (ANTHROPIC_BASE_URL) at the localhost
  // gateway so every gym LLM call egresses through the bound pool account, exactly like the agents.
  // Flag-OFF → unchanged (direct egress). Respects an explicit pre-set override.
  // The FULL gateway auto-routing env for the spawned gym-operator (and, by inheritance, its role
  // subprocesses: director/worker/validator/CURATOR/documenter). Empty unless the gateway is on.
  let gymSpawnGatewayEnv: Record<string, string> = {};
  if (!FAKE && (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) {
    for (const [k, v] of Object.entries(gatewayLlmEnv(true))) {
      // Respect an explicit pre-set override (e.g. a test or a manual GYM_LOOP run).
      if (!process.env[k]) process.env[k] = v;
    }
    // Owner directive 2026-07-20 (WI-5637): PIN the gym to the gateway's AUTO account mode. The thin
    // gatewayLlmEnv above only sets ANTHROPIC_BASE_URL — enough for the IN-PROCESS judge/proposer SDK
    // (it reads PAPERCUSP_ANTHROPIC_URL) but NOT for a `claude` CLI role subprocess: without
    // ANTHROPIC_AUTH_TOKEN the CLI ignores the base URL and auths on its LOCAL ~/.claude login
    // (scrubLauncherClaudeSessionEnv/boot-spec deliberately point it there, EI-232), which lacks 1M
    // usage credits → the curator died "API Error: Usage credits required for 1M context". Resolve the
    // full spawn env with account:'auto' so the gateway auto-selects a CREDITED pool account (+ failover)
    // and reinjects its OAuth: adds ANTHROPIC_AUTH_TOKEN (CLI sends) + PAPERCUSP_ACCOUNT_ROUTING_MODE=auto.
    // Merged into the gym-operator spawn env (below) so every role subprocess inherits it. Fail-soft:
    // resolveSpawnGatewayEnv throws only if the pool has NO allowed claude account — in that case we
    // fall back to the base-URL-only routing rather than aborting the cycle.
    // WI-5637 (account-routing workspace): account routing is an OPERATOR-CREDENTIAL
    // concern, NOT a data-isolation one. The account pool
    // (harness_shared.operator_account_pool) is WORKSPACE-SCOPED (per-workspace JSONB,
    // mig 190) and lives in the OPERATOR's real workspace — NOT the ephemeral gym DATA
    // workspace WS (='gym-loop-ws'), which has no pool row. The first cut passed WS, so
    // resolveSpawnGatewayEnv({account:'auto'}) called loadAccountPool('gym-loop-ws'),
    // found zero allowed claude accounts, and THREW "account route 'auto' has no allowed
    // claude account in the pool" → the catch left gymSpawnGatewayEnv EMPTY → the curator
    // subprocess got no ANTHROPIC_AUTH_TOKEN → auth'd on the local ~/.claude login →
    // "API Error: Usage credits required for long context" (429). Route account selection
    // against the operator's CREDENTIAL workspace instead: an explicit override, else the
    // process pin, else the operator's active workspace (papercusp-workspace in the
    // routine host, where the pool lives). Data writes scope per-axis: DURABLE_WS
    // for control-plane/durable rows, EPHEMERAL_WS for the throwaway gym stack (WI-5675).
    const accountRoutingWs = resolveGymAccountWorkspace(process.env, activeWorkspaceId);
    try {
      gymSpawnGatewayEnv = await resolveSpawnGatewayEnv({
        workspaceId: accountRoutingWs,
        slug,
        account: 'auto',
        backend: 'claude',
        role: 'gym',
      });
      log(`inference-gateway spawn-route: account workspace='${accountRoutingWs}' → ${Object.keys(gymSpawnGatewayEnv).length} env key(s) injected into role subprocesses`);
    } catch (e) {
      log(`inference-gateway auto-route unavailable for account workspace '${accountRoutingWs}' (${(e as Error).message.split('\n')[0]}) — falling back to base-URL routing; the CURATOR MAY 429 (WI-5637)`);
    }
    log(`inference-gateway ON (account=auto) → routing gym LLM calls through http://127.0.0.1:${gatewayPort()}`);
  }

  const HEX = randomBytes(4).toString('hex');
  const DB_NAME = `papercusp_gym_loop_${HEX}`;

  let pgContainer: StartedPostgreSqlContainer | undefined;
  let operator: ChildProcess | undefined;
  let logFd: number | undefined;

  // WI-40255: `finally` cannot run after SIGKILL/OOM/host restart, so reclaim
  // prior multi-GB hard-linked substrate roots before creating another one.
  // The owner sentinel makes this safe when multiple cycles share this process.
  const substrateSweep = sweepOrphanedGymSubstrates({ parentDir: dirname(REPO_ROOT) });
  if (substrateSweep.swept.length > 0) {
    log(`substrate orphan sweep: reclaimed ${substrateSweep.swept.length} root(s) (${substrateSweep.swept.join(', ')})`);
  }
  if (substrateSweep.errors.length > 0) {
    log(`substrate orphan sweep: ${substrateSweep.errors.length} non-fatal error(s)`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'gym-loop-'));
  // ⚠ NOT under `scratch`. The substrate is a `--local` clone of the real repo,
  // which HARDLINKS the object store instead of copying ~9.9G — and hardlinks
  // cannot cross filesystems. On this box /tmp is a separate device from the
  // workspace, so a /tmp dest fails with "Invalid cross-device link". Placed
  // next to the checkout (outside it, so git-sync never sees it) and torn down
  // alongside `scratch`.
  const substrateRoot = createGymSubstrateRoot(dirname(REPO_ROOT)).root;
  const substrateDir = join(substrateRoot, 'substrate');
  // The runner's clones (gymbaseline*/gymcand*) are themselves `--local`
  // hardlinked clones OF THE SUBSTRATE, so they hit the same cross-device wall
  // if placed under the /tmp `scratch` root (first live run 2026-08-16 failed
  // EXDEV exactly there). They live beside the substrate instead — same device,
  // torn down with `substrateRoot`.
  const cloneScratch = join(substrateRoot, 'scratch');
  mkdirSync(cloneScratch);
  const opLogPath = join(tmpdir(), `gym-loop-op-${HEX}.log`);
  let gymUri = '';
  let gymSql: postgres.Sql | undefined;
  let controlSql: Sql | undefined;
  let ownsControlSql = false;
  let result: LoopResult | null = null;
  let ok = false;
  const report: Record<string, unknown> = {
    mode: FAKE ? 'fake (zero-LLM)' : 'real',
    port: PORT,
    maxCycles: MAX_CYCLES,
    repeats: REPEATS,
    budgetUsd: BUDGET_USD,
    harnessSlug: slug,
    noveltyWeight: NOVELTY_WEIGHT,
    candidateDirections: opts.candidateDirections?.length ?? 0,
    // WI-5675: both workspace axes in the report, so a run whose durable writes land
    // invisibly (wrong workspace vs the owner's /gym view) is diagnosable at a glance.
    durableWorkspace: DURABLE_WS,
    ephemeralWorkspace: EPHEMERAL_WS,
  };

  try {
    // 1. Dedicated gym DB (execution data). Self-heal sweep FIRST (WI-4332): reclaims
    // any orphaned container a crashed prior gym run left behind before Ryuk could reap it.
    await sweepOrphanedGymPgContainers({ image: GYM_PROVISION_PG_IMAGE }).catch(() => {});
    log(`workspaces: durable='${DURABLE_WS}' (owner-visible writes) · ephemeral='${EPHEMERAL_WS}' (throwaway gym stack)`);
    log('provisioning gym DB …');
    // max_connections=500: the gym-operator opens MANY pools per process (org + per-harness
    // + cache/listeners ≈ 69/proc) and the CLI's gymSql + spawned role agents add more, which
    // blows past PG's default max_connections=100 → `sorry, too many clients already`, killing
    // the pipeline before any proposal is recorded (WI-5630). Mirrors blueprint-cycle.ts.
    pgContainer = await new PostgreSqlContainer(GYM_PROVISION_PG_IMAGE)
      .withDatabase('papercusp_loop')
      .withCommand(['postgres', '-c', 'max_connections=500'])
      .start();
    ({ databaseUri: gymUri } = await provisionGymDatabase({ maintenanceUri: pgContainer.getConnectionUri(), dbName: DB_NAME }));
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });
    // Control plane (proposals/autoloop/QD) → caller's client, else a DSN we open, else the gym DB.
    const controlDsn = opts.controlDsn ?? process.env.GYM_LOOP_CONTROL_DSN;
    if (opts.controlSql) {
      controlSql = opts.controlSql;
    } else if (controlDsn) {
      controlSql = postgres(controlDsn, { max: 2, onnotice: () => {}, prepare: false });
      ownsControlSql = true;
    } else {
      controlSql = gymSql;
    }

    // 2. REAL substrate: a pinned, sparse, dependency-ready clone of the actual
    // Papercusp repo, with ONE COMMIT PER TASK whose tree carries the rewound
    // implementation.
    //
    // This replaces the former toy repo — a 4-line stub service with a
    // hand-written "add /health" task that no one ever needed and no real test
    // guarded. D-004 (owner): "IT SHOULD BE PUTTING THE REAL PAPERCUSP APP
    // THROUGH THE GYM". Each task now rewinds ONE genuinely shipped
    // implementation file inside the real repo and is scored by the REAL test
    // that shipped with it, so fitness is an observed test outcome (D-002)
    // rather than a judge's opinion of a fake.
    //
    // The per-task commit is what makes this honest: the runner clones from the
    // object store and never sees a working tree, so pinning tasks at the
    // corpus pin would hand the agent the SHIPPED file and every oracle would
    // pass on turn zero while still reporting corpus:'real' (D-007).
    // `papercuspTaskToGymTask` refuses that by construction.
    const { tasks: materialised } = await materialisePapercuspSubstrate({
      sourceRepo: REPO_ROOT,
      destDir: substrateDir,
    });
    // `.papercusp/config.json` + `blueprint.yaml` are NOT written here any more.
    // They are gitignored in the real repo, so writing them into the substrate's
    // WORKING TREE would never reach the runner (it clones from the object
    // store). `materialisePapercuspSubstrate` commits them beneath every task
    // commit and asserts they landed — see GYM_HARNESS_FILES.
    const tasks: LoopTask[] = materialised.map((m) => m.gymTask);
    const taskHash = createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
    log(`substrate: real papercusp @ ${materialised[0]?.descriptor.pinCommit.slice(0, 12)} — ${tasks.length} real tasks`);

    // 3. Boot the gym-operator (fake or real agent).
    const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: REPO_ROOT,
      harnessCommit,
      gymDatabaseUrl: gymUri,
      honoPort: PORT,
      workspaceId: EPHEMERAL_WS,
      agentCmd: FAKE ? `node ${FAKE_AGENT}` : REAL_AGENT_CMD,
      agentModels: FAKE ? {} : undefined,
    });
    logFd = openSync(opLogPath, 'w');
    log(`booting gym-operator on :${PORT} (mode=${FAKE ? 'fake' : 'real'}, log → ${opLogPath}) …`);
    // EI-368: readiness (DBOS launched), not liveness — and fail fast with the
    // boot-log tail if the operator dies mid-migration instead of letting the
    // first pipeline call hit a half-migrated dbos schema.
    // EI-18157486989132279: retry the boot ONCE, but only on an actual crash —
    // a transient mid-git-sync-commit read of a half-written shared-tree file
    // can make the tsx/esbuild transform throw during boot; a respawn a few
    // seconds later reads past the write. A bare readiness timeout is not
    // retried (see spawnGymOperatorWithRetry's doc comment).
    operator = await spawnGymOperatorWithRetry({
      command: spec.command,
      args: spec.args,
      spawnOptions: {
        cwd: spec.cwd,
        // EI-232: scrub the launcher Claude-Code session's env so real-mode gym
        // agents auth against ~/.claude, not this session's per-session config dir.
        // WI-5637: merge the gateway auto-routing env AFTER the scrub so ANTHROPIC_AUTH_TOKEN +
        // account routing survive (the scrub only strips CLAUDE_* session vars) and the role
        // subprocesses egress via a credited pool account instead of the local ~/.claude login.
        env: { ...scrubLauncherClaudeSessionEnv({ ...process.env, ...spec.env, PAPERCUSP_FLEET_SANDBOX: '0', PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0', NODE_ENV: 'production', PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none' }), ...gymSpawnGatewayEnv },
        stdio: ['ignore', logFd, logFd],
        detached: true,
      },
      baseUrl: `http://127.0.0.1:${PORT}`,
      timeoutMs: 120_000,
      logPath: opLogPath,
      onRetry: (err) => log(`operator boot crashed, retrying once (${err.message.split('\n')[0]}) …`),
    });
    log('operator ready (DBOS launched)');

    // 4. LLM calls — imported lazily so fake mode never loads the llm-client graph.
    // GYM-1 layer-4 hardening (2026-07-02): a single transient network blip
    // ("TypeError: fetch failed" — undici, no HTTP status) killed a whole
    // provisioned cycle 16s in (14:42:49, same window as other outbound flakiness
    // on this box). A provisioned cycle is EXPENSIVE (container + operator boot
    // ~2.5min). Retry only bare-network failures with complete measured-zero
    // spend; unknown/positive failed spend must reach reservation settlement
    // without being replaced by a later receipt. The gateway owns HTTP retries.
    const rawGymLlm = FAKE ? null : await import('../llm-testing/llm-client');
    const nativeCalls = rawGymLlm ? bindNativeGymLlmCalls(rawGymLlm.llmCall, slug, { log }) : null;
    const judge: JudgeLlmCall = FAKE
      ? fakeJudge
      : nativeCalls!.judge;
    const proposer: GymLlmCall = FAKE
      ? fakeProposer
      : nativeCalls!.proposer;

    // 5. Ports + loop deps.
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const suToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
    const ports = createGymRunnerPorts({
      operatorBaseUrl: `http://127.0.0.1:${PORT}`,
      gymSql,
      superuserToken: suToken,
      workspaceId: EPHEMERAL_WS,
      // The spawn URL's baked workspace claim can carry the DURABLE axis (or the
      // host 'default' home) rather than the ephemeral one — seed the pipeline
      // principals under all of them (see ensureGymPipelinePrincipals).
      principalSeedWorkspaceIds: [DURABLE_WS],
    });
    // F1-6/P-014 (D-005 hole 3): resolve THIS peer's announce device key as the elite-outcome
    // signer, so an accepted champion federates with a device-signed outcome proof
    // (outcome-VERIFIED on receivers that resolve our device — anti-lift parity) rather than
    // the bare federatable boolean. Best-effort + cache-first (no network in the cycle): a cold
    // box / non-federating env yields undefined → tier-1 unsigned federation (still admitted).
    // Skipped in FAKE assembly mode (no keychain touch; that workspace never federates anyway).
    const eliteOutcomeSigner = FAKE ? undefined : await resolveLocalEliteOutcomeSigner();
    if (eliteOutcomeSigner) {
      log(`elite outcome-signing ON (device ${eliteOutcomeSigner.devicePubkeyBase64.slice(0, 8)}…)`);
    }
    report.eliteOutcomeSigning = Boolean(eliteOutcomeSigner);
    // P-010/P-011 (D-008): the QD record + novelty seams over ONE live archive (+ a shared
    // variantId→descriptor cache), so noveltyForVariant's reads see recordArchive's writes.
    const qdSeams = makeLoopQdSeams(controlSql, { workspaceId: DURABLE_WS, harnessSlug: slug }, { outcomeSigner: eliteOutcomeSigner });
    // P-030 (B-09): measured post-acceptance outcomes of past champions prime the
    // proposer. Defensive — a read failure yields [] and the cycle proceeds.
    const championOutcomes = await gatherChampionOutcomeEntries(controlSql, { workspaceId: DURABLE_WS, harnessSlug: slug });
    report.championOutcomes = championOutcomes.length;
    const deps = buildLoopDeps({
      gymSql,
      ports,
      judgeCall: judge,
      proposerCall: proposer,
      proposerModel: PROPOSER_MODEL,
      // WI-5697: reuse this run's own random token (already minted above for the ephemeral
      // DB name / log path) so every candidate id is unique PER RUN, not just per cycle —
      // without this, autoloop cycles (almost always maxCycles=1) always minted "cand-c1",
      // so once that id's proposal rows were decided ONCE, every later run's recordProposal
      // silently no-op'd against the already-decided row (control-plane.ts recordProposal's
      // `ON CONFLICT ... WHERE status = 'pending'`) and never minted a new gym_proposals row.
      runId: HEX,
      tasks,
      rubric: GYM_JUDGE_RUBRIC_V1,
      baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
      harnessCommit,
      // The per-run gym harness provisioning happens inside the EPHEMERAL operator.
      workspaceId: EPHEMERAL_WS,
      scratchRoot: cloneScratch,
      timeoutMs: FAKE ? 240_000 : 1_200_000,
      pollIntervalMs: 3000,
      maxDistillChars: 60_000,
      repeats: REPEATS, // P-025
      // P-032: triage-routed gym ideas → the proposer's candidate directions (additive).
      candidateDirections: opts.candidateDirections,
      // P-030: recent champion post-acceptance outcome lines (additive priming).
      championOutcomes,
      // Human-gated (D-020): the loop records proposals for review; the human promotes via gym:accept.
      recordProposal: makeLoopProposalRecorder(controlSql, { workspaceId: DURABLE_WS, harnessSlug: slug }),
      // P-010 (D-008): feed each evaluated variant into the QD novelty/diversity archive.
      recordArchive: qdSeams.recordArchive,
      // P-011 (D-008): the distance-from-archive novelty signal for QD parent selection.
      noveltyForVariant: qdSeams.noveltyForVariant,
      // F1-4/P-014: publish an accepted candidate's niche elite to the hive (the live SEND
      // path elites were missing). Best-effort in the loop; tier-1 (no device signer yet).
      federateAcceptedElite: qdSeams.federateAcceptedElite,
    });

    // 6. (CLI mode) mark autoloop running, run the loop, then settle the status.
    if (manageRow) {
      await setAutoloop(controlSql, { workspaceId: DURABLE_WS, harnessSlug: slug, enabled: true, budgetUsd: BUDGET_USD, status: 'running' });
    }
    log(`running loop: maxCycles=${MAX_CYCLES} budget=${BUDGET_USD === null ? '∞' : '$' + BUDGET_USD} (auto-promote: winners crowned post-run — owner mandate 2026-07-19) …`);
    const runStartedAtMs = Date.now();
    result = await runOptimizationLoop(
      {
        // live-configurability-audit P-012: per-harness gym gates (operator_gym_gates), settable via
        // gym:set-gates; empty store ⇒ DEFAULT_GYM_GATES (the former inline placeholder). The human
        // gate reviews each proposal anyway, so these only steer the loop's advisory verdict.
        thresholds: await readGymGates(slug, DURABLE_WS),
        baselineMeanCost: 1,
        baselineOfRecord: 0,
        dropThreshold: 1000,
        maxCycles: MAX_CYCLES,
        budgetUsd: BUDGET_USD,
        proposerModel: PROPOSER_MODEL,
        autoPromote: false,
        provenance: {
          evaluatorHash: createHash('sha256').update('gym-gate-engine:v1').digest('hex'),
          rubricHash: rubricHash(GYM_JUDGE_RUBRIC_V1),
          taskHash,
          codeHash: harnessCommit,
        },
        // P-011 (D-008): quality-diversity parent selection when a novelty weight is set (>0);
        // unset ⇒ the loop falls back to legacy fitness-headroom selection (unchanged).
        ...(NOVELTY_WEIGHT > 0 ? { qualityDiversity: { noveltyWeight: NOVELTY_WEIGHT } } : {}),
      },
      deps,
    );

    // Owner mandate 2026-07-19 ("no human in the loop"): decide this run's
    // proposals by their measured result — positive dev-anchor delta promotes
    // the challenger to champion via the SAME atomic path a human accept used
    // (prompt-override write + champion-outcome tracking); the rest reject.
    // The ledger stays the audit trail. Fail-soft: a decide error leaves rows
    // pending for the next run (or a manual decision) rather than aborting.
    try {
      const { autoDecideRunProposals } = await import('./control-plane');
      const decided = await autoDecideRunProposals(controlSql, {
        workspaceId: DURABLE_WS,
        harnessSlug: slug,
        sinceMs: runStartedAtMs,
      });
      log(`auto-decided proposals: ${decided.accepted} promoted, ${decided.rejected} rejected`);
      report.autoDecided = decided;
    } catch (err) {
      log(`auto-decide failed (rows stay pending): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (manageRow) {
      await setAutoloop(controlSql, {
        workspaceId: DURABLE_WS,
        harnessSlug: slug,
        status: result.breakerTripped ? 'paused' : 'idle',
        spentUsd: result.spentUsd,
      });
    }

    report.loop = result;
    // WI-5674: a skipped candidate (propose/evaluate threw) is otherwise invisible — no
    // proposal, no cycle row, no curator, nothing new in /gym. Surface the concrete reason
    // loudly so the silent-skip failure mode is diagnosable from the run log + report.
    if (result.skipReasons.length > 0) {
      for (const r of result.skipReasons) log(`⚠ CANDIDATE SKIPPED — ${r}`);
      report.skipReasons = result.skipReasons;
    }
    report.autoloop = await getAutoloop(controlSql, { workspaceId: DURABLE_WS, harnessSlug: slug });
    // D-014/P-028 falsifiability surface: train vs real-anchor composite per variant. If the
    // train aggregate climbs across variants while the real-anchor stays flat, the loop is
    // optimizing a proxy (the real-anchor is scored every cycle but never optimized).
    const rh = rubricHash(GYM_JUDGE_RUBRIC_V1);
    report.trainByVariant = await readPoolAggregates(gymSql, 'train', rh);
    report.realAnchorByVariant = await readPoolAggregates(gymSql, 'real-anchor', rh);

    // Persist this cycle's run analytics to the DURABLE live-DB harness_gym read-cache
    // (P-011) BEFORE the ephemeral gym PG is torn down, so the gym UI's Cycles/Variants/
    // Frontier tabs read persisted data. Only when a distinct durable control DB is wired
    // (the routine action's live org pool) — in standalone/fake mode controlSql === gymSql,
    // so there is nothing durable to copy to. Best-effort: a copy failure never fails the
    // cycle (the proposals already landed via the control-plane recorder).
    if (gymSql && controlSql && controlSql !== gymSql) {
      try {
        const copied = await copyRunAnalyticsToDurable(gymSql, controlSql, { workspaceId: DURABLE_WS, harnessSlug: slug });
        report.durableAnalytics = copied;
        log(`durable run-analytics copied → live DB: ${copied.cycles} cycle(s), ${copied.variants} variant(s), ${copied.runs} run(s), ${copied.scores} score(s)`);
      } catch (err) {
        report.durableAnalyticsError = err instanceof Error ? err.message : String(err);
        log(`durable run-analytics copy failed (non-fatal): ${report.durableAnalyticsError}`);
      }
    }

    ok = result.cycles >= 1 && !result.breakerTripped;
  } catch (err) {
    report.error = String(err);
  } finally {
    if (controlSql && ownsControlSql) { try { await controlSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (gymSql) { try { await gymSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (operator?.pid) {
      try { process.kill(-operator.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2500);
      try { process.kill(-operator.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (logFd !== undefined) { try { report.operatorLogTail = maskDsn(readFileSync(opLogPath, 'utf8').split('\n').slice(-20).join('\n')); } catch { /* ignore */ } }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    // The substrate lives on the workspace device (see substrateRoot above), so
    // it is NOT swept by the /tmp cleanup and needs its own teardown — a ~570MB
    // sparse checkout leaked per cycle otherwise.
    try { rmSync(substrateRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (pgContainer) await pgContainer.stop(); } catch { /* ignore */ }
  }

  return { ok, result, report };
}
