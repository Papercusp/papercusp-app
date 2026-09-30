/**
 * GYM WAKE-MODE E2E — hive-loop-e2e-testing-2026-06-10 P-006 (D-002/D-003).
 *
 * The single test that covers what nothing else covers: the AUTONOMOUS trigger
 * chain, links 1→4, on a real booted operator. Every other gym runnable starts
 * each pipeline explicitly (`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES=none` + a
 * manual `POST /admin/dbos/pipeline/start`); this one boots the gym-operator
 * with the autoloop ON, queues toy feature(s), then TOUCHES NOTHING:
 *
 *   1. Trigger — the blueprint declares `triggers.schedule`; the routine row is
 *      materialized via the production `materializeBlueprintTriggers`; the DBOS
 *      `routinesTick` claims it and fires `system:blueprint-run`.
 *   2. Queen turn — blueprint-run resolves the harness blueprint, consults the
 *      autoloop fire-gate (`checkFireGate`), and fires the spine decider via the
 *      invoke route (`recordFire` → `harness_shared.autoloop_state`).
 *   3+4. Spawn + pipeline — the 30s `orchestratorTick` sweeps the harness
 *      (`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES=<slug>`), the frontier picks the
 *      queued feature, `ensureFeaturePipeline` runs director→worker→validator to
 *      DONE, the finalizer fires exactly once, and `refillHarnessOnSettle` starts
 *      the next queued feature off the freed slot.
 *
 * PASS = every queued feature reaches `passed` purely via that chain, and the
 * four oracle families hold on the real PG state (`evaluateWakeOracles`).
 *
 * Isolation is the gym boot-spec (D-003): dedicated testcontainer PG with all
 * three DSN keys pinned, own `DBOS__APPVERSION`, loopback-only port. Two modes:
 *
 *   fake (DEFAULT; GYM_WAKE_FAKE!=0) — `fixtures/fake-wake-agent.mjs`, zero LLM.
 *      The wake-mode fake VALIDATOR records its verdict in PG so the autoloop
 *      converges (without it the frontier re-dispatches the never-passing
 *      feature forever — the documented fixture artifact).
 *   real (GYM_WAKE_FAKE=0) — real agents on a HAIKU-class model, 1 feature,
 *      capped turns (D-004 cost control).
 *
 * Run:  cd apps/operator && npx tsx ../../packages/operator-core/lib/gym/wake-mode-run.ts
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { provisionGymDatabase, GYM_PROVISION_PG_IMAGE } from './gym-db-init';
import { sweepOrphanedGymPgContainers } from './gym-pg-orphan-sweep';
import { buildGymOperatorBootSpec, scrubLauncherClaudeSessionEnv } from './boot-spec';
import { materializeBlueprintTriggers } from '../blueprint/materialize-triggers';
import { maskDsn } from './autoloop-cycle';
import { assembleRawTrace } from './collector';
import { distillTrace } from './distill';
import { judgeGymRun, type JudgeLlmCall, type GymScore } from './judge';
import { GYM_JUDGE_RUBRIC_V1 } from './judge-scoring';
import { spawnGymOperatorWithRetry } from './operator-ready';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const FAKE_WAKE_AGENT = join(__dirname, 'fixtures/fake-wake-agent.mjs');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Pure: the wake-mode blueprint ───────────────────────────────────────────

export interface WakeBlueprintOptions {
  /** 6-field crontab for the bp-schedule trigger (test-compressed cadence). */
  cron: string;
  /** dispatch.concurrency — 1 serializes pipelines so the slot-refill liveness
   *  oracle ("a freed slot starts the next queued feature") is observable. */
  concurrency: number;
}

/**
 * The throwaway harness's `.papercusp/blueprint.yaml`: extends the built-in
 * `coding-factory` blueprint and declares its OWN autoloop trigger — enablement per the
 * production model ("the blueprint carries its own autoloop", lib/autoloop.ts).
 * Pure (unit-tested through the real blueprint loader + trigger derivation).
 */
export function wakeBlueprintYaml(slug: string, opts: WakeBlueprintOptions): string {
  return [
    '# hive-loop-e2e P-006 wake-mode — a throwaway coding harness whose blueprint',
    '# declares its OWN autoloop trigger (the autonomous chain under test).',
    `id: ${slug}`,
    'extends: coding-factory',
    'version: 0.0.1',
    'triggers:',
    '  schedule:',
    `    - { cron: "${opts.cron}", action: "system:blueprint-run" }`,
    'dispatch:',
    `  concurrency: ${opts.concurrency}`,
    '  priority: plan-order',
    '',
  ].join('\n');
}

// ─── Judge scoring (P-007): collect → distill → frozen judge → threshold ────

export interface WakeJudgeResult {
  composite: number;
  threshold: number;
  d1: number;
  d2: number;
  d3: number;
  rationale: string;
  costUsd: number;
}

/** Deterministic zero-LLM judge for fake mode — same shape as autoloop-cycle's. */
export const fakeWakeJudge: JudgeLlmCall = async (opts) => {
  const userLen = opts.messages.map((m) => m.content).join('').length;
  const c = 6 + (userLen % 4); // 6..9 — always above any sane threshold
  return {
    text: JSON.stringify({ d1: c, d2: c, d3: c, rationale: 'fake-judge wake-mode assembly check' }),
    costUsd: 0,
    inputTokens: 10,
    outputTokens: 10,
  };
};

/**
 * Judge the produced work of a settled wake run (P-007): read the per-role
 * transcripts (harness_run_output) + `git diff <seed> HEAD` in the substrate,
 * distill to a judge-sized trace, score with the FROZEN rubric, and compare
 * the weighted composite to `threshold`. The same collect→distill→judge spine
 * the gym loop uses, applied to the autonomous full-chain run.
 */
export async function judgeWakeRun(opts: {
  sql: postgres.Sql;
  slug: string;
  substrateDir: string;
  seedCommit: string;
  intent: string;
  projectContext: string;
  judgeCall: JudgeLlmCall;
  threshold: number;
  maxDistillChars?: number;
}): Promise<WakeJudgeResult> {
  const rows = await opts.sql<{ run_id: string; role: string | null; out_body: string }[]>`
    SELECT run_id, role, out_body FROM harness_shared.harness_run_output
     WHERE harness_slug = ${opts.slug} ORDER BY started_at ASC`;
  const diff = execFileSync('git', ['-C', opts.substrateDir, 'diff', opts.seedCommit, 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const rawTrace = assembleRawTrace({
    diff,
    runOutputs: rows.map((r) => ({ runId: r.run_id, role: r.role ?? '', outBody: r.out_body })),
    terminalState: 'passed',
  });
  const distilled = distillTrace(rawTrace, { maxChars: opts.maxDistillChars ?? 60_000 });
  const score: GymScore = await judgeGymRun(
    {
      intent: opts.intent,
      projectContext: opts.projectContext,
      distilledTrace: distilled.text,
      rubric: GYM_JUDGE_RUBRIC_V1,
    },
    { llmCall: opts.judgeCall },
  );
  return {
    composite: score.composite,
    threshold: opts.threshold,
    d1: score.d1,
    d2: score.d2,
    d3: score.d3,
    rationale: score.rationale,
    costUsd: score.costUsd,
  };
}

// ─── Pure: the four oracle families over collected evidence ─────────────────

export interface WakeEvidence {
  /** The feature ids the run queued (the toy features). */
  featureIds: string[];
  /** Terminal feature rows read from PG. */
  features: Array<{ id: string; status: string }>;
  /** Every `pipeline:<slug>:…` DBOS workflow (id + status). */
  pipelines: Array<{ id: string; status: string }>;
  /** Max concurrently-live (PENDING/ENQUEUED) pipelines observed while polling. */
  maxConcurrentPipelines: number;
  /** The blueprint-declared per-harness concurrency cap. */
  cap: number;
  /** The pipeline turn ceiling in force (PAPERCUSP_DBOS_PIPELINE_MAX_TURNS). */
  maxTurns: number;
  /** Checkpointed `decide-*` step count per pipeline workflow. */
  decideStepsByPipeline: Record<string, number>;
  /** Checkpointed `finalize-done` step count per pipeline workflow. */
  finalizeStepsByPipeline: Record<string, number>;
  /** `harness_shared.autoloop_state` rows for the harness (the fire-gate ledger). */
  deciderFires: Array<{ role: string; lastStatus: string | null; consecutiveErrors: number }>;
  /** Completed `routineFire` DBOS workflows (link 1: routinesTick claimed + fired). */
  routineFireRuns: number;
  /** The bp-schedule-* routine row was materialized. */
  routineSeeded: boolean;
  /** Run-output rows still running (exit_code IS NULL) after settle + drain. */
  runningRunOutputRows: number;
  /** Nursery rows stuck `status='running'` after settle. */
  runningNurseryRows: number;
  /** P-007: the judge verdict on the produced work (absent = judging not run). */
  judge?: WakeJudgeResult;
}

/**
 * The plan's four oracle families (Liveness / Safety / Resources / Hygiene)
 * plus the trigger-chain evidence (links 1–2), evaluated over PG-state evidence.
 * Pure — directly unit-testable; the runner feeds it real collected state.
 */
export function evaluateWakeOracles(ev: WakeEvidence): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  // ── Liveness: every queued feature reached DONE via an autonomous pipeline ──
  for (const fid of ev.featureIds) {
    const f = ev.features.find((x) => x.id === fid);
    if (!f) failures.push(`liveness: feature ${fid} missing from PG`);
    else if (f.status !== 'passed') failures.push(`liveness: feature ${fid} ended '${f.status}', expected 'passed'`);
    const mine = ev.pipelines.filter((w) => w.id.includes(`:${fid}:e`));
    if (mine.length === 0) failures.push(`liveness: no autonomous pipeline ever started for ${fid}`);
    else if (!mine.some((w) => w.status === 'SUCCESS'))
      failures.push(`liveness: no SUCCESS pipeline for ${fid} (saw: ${mine.map((w) => w.status).join(', ')})`);
  }

  // ── Trigger chain (links 1–2): the loop self-started — nothing manual ──
  if (!ev.routineSeeded) failures.push('trigger: the bp-schedule-* routine was never materialized');
  if (ev.routineFireRuns < 1)
    failures.push('trigger: routinesTick never fired the bp-schedule routine (no completed routineFire workflow)');
  if (ev.deciderFires.length === 0)
    failures.push('trigger: the decider was never fired through the fire-gate (no autoloop_state row)');

  // ── Safety: finalizer exactly once; turn ceiling respected ──
  for (const [wf, n] of Object.entries(ev.finalizeStepsByPipeline)) {
    if (n !== 1) failures.push(`safety: finalizer ran ${n}× for ${wf} (must be exactly once)`);
  }
  for (const [wf, n] of Object.entries(ev.decideStepsByPipeline)) {
    if (n > ev.maxTurns) failures.push(`safety: ${wf} took ${n} decide turns > maxTurns ${ev.maxTurns}`);
  }

  // ── Resources: concurrent pipelines never exceeded the declared cap ──
  if (ev.maxConcurrentPipelines > ev.cap)
    failures.push(`resources: observed ${ev.maxConcurrentPipelines} concurrent pipelines > cap ${ev.cap}`);

  // ── Hygiene: nothing left running after settle ──
  if (ev.runningRunOutputRows > 0)
    failures.push(`hygiene: ${ev.runningRunOutputRows} run-output row(s) still running after settle`);
  if (ev.runningNurseryRows > 0)
    failures.push(`hygiene: ${ev.runningNurseryRows} nursery row(s) stuck 'running' after settle`);

  // ── Quality (P-007): the judged composite clears the threshold ──
  if (ev.judge && ev.judge.composite < ev.judge.threshold)
    failures.push(
      `quality: judged composite ${ev.judge.composite.toFixed(2)} < threshold ${ev.judge.threshold} ` +
        `(d1=${ev.judge.d1} d2=${ev.judge.d2} d3=${ev.judge.d3})`,
    );

  return { pass: failures.length === 0, failures };
}

// ─── The runner ──────────────────────────────────────────────────────────────

export interface WakeModeOptions {
  /** Fake (zero-LLM) mode. Default: env GYM_WAKE_FAKE !== '0' (fake). */
  fake?: boolean;
  /** Gym-operator port (default env GYM_WAKE_PORT / 3978). */
  port?: number;
  workspaceId?: string;
  /** Throwaway harness slug. Must not contain `t<digit>` (the fake director's
   *  idempotency-key turn parse); default 'wakehive'. */
  slug?: string;
  /** Toy features to queue. Default: 2 fake (exercises slot refill), 1 real (D-004). */
  featureCount?: number;
  /** Blueprint dispatch.concurrency (default 1 — serializes, refill observable). */
  concurrency?: number;
  /** Pipeline turn ceiling (PAPERCUSP_DBOS_PIPELINE_MAX_TURNS on the operator). */
  maxTurns?: number;
  /** Whole-run deadline in minutes (default 10 fake / 60 real). */
  timeoutMin?: number;
  /** bp-schedule trigger cron (default every 15s — test-compressed cadence). */
  routineCron?: string;
  /** Real-mode agent command. Default HAIKU-class per D-004 cost control. */
  agentCmd?: string;
  /**
   * P-007: judge the produced work and assert composite ≥ this threshold.
   * Default: env GYM_WAKE_JUDGE_THRESHOLD, else 5 when GYM_WAKE_JUDGE=1, else
   * judging is skipped. Fake mode scores with the deterministic fakeWakeJudge;
   * real mode uses the frozen rubric's real judge (one LLM call).
   */
  judgeThreshold?: number | null;
  /** Override the judge LLM call (tests). */
  judgeCall?: JudgeLlmCall;
  /** Keep the scratch dir on exit (debugging). */
  keep?: boolean;
  log?: (msg: string) => void;
}

export interface WakeModeOutcome {
  ok: boolean;
  evidence: WakeEvidence | null;
  report: Record<string, unknown>;
}

export async function runGymWakeMode(opts: WakeModeOptions = {}): Promise<WakeModeOutcome> {
  // Subscription-paced CODE backend for any real-LLM legs (same as the other gym runnables).
  process.env.LLM_TEST_BACKEND = process.env.LLM_TEST_BACKEND ?? 'claude-code';

  const FAKE = opts.fake ?? process.env.GYM_WAKE_FAKE !== '0';
  const PORT = opts.port ?? Number(process.env.GYM_WAKE_PORT ?? 3978);
  const WS = opts.workspaceId ?? process.env.GYM_WAKE_WORKSPACE ?? 'gym-wake-ws';
  const SLUG = opts.slug ?? process.env.GYM_WAKE_SLUG ?? 'wakehive';
  const FEATURES = Math.max(1, opts.featureCount ?? (FAKE ? 2 : 1));
  const CONCURRENCY = Math.max(1, opts.concurrency ?? 1);
  const MAX_TURNS = Math.max(3, opts.maxTurns ?? (FAKE ? 30 : 40));
  const TIMEOUT_MIN = Math.max(2, opts.timeoutMin ?? Number(process.env.GYM_WAKE_TIMEOUT_MIN ?? (FAKE ? 10 : 60)));
  const CRON = opts.routineCron ?? '*/15 * * * * *';
  // D-004: real mode runs a haiku-class model — cheap by default; callers opt up.
  const REAL_AGENT_CMD = opts.agentCmd ?? process.env.GYM_WAKE_AGENT_CMD ?? 'claude -p --model claude-haiku-4-5-20251001';
  // P-007: the judge threshold (composite is 0–10 under the frozen rubric).
  const JUDGE_THRESHOLD =
    opts.judgeThreshold !== undefined
      ? opts.judgeThreshold
      : process.env.GYM_WAKE_JUDGE_THRESHOLD
        ? Number(process.env.GYM_WAKE_JUDGE_THRESHOLD)
        : process.env.GYM_WAKE_JUDGE === '1'
          ? 5
          : null;
  const log = opts.log ?? ((m: string) => process.stdout.write(`[gym-wake] ${m}\n`));

  const HEX = randomBytes(4).toString('hex');
  const DB_NAME = `papercusp_gym_wake_${HEX}`;
  const featureIds = Array.from({ length: FEATURES }, (_, i) => `F-${i + 1}`);

  let pgContainer: StartedPostgreSqlContainer | undefined;
  let operator: ChildProcess | undefined;
  let logFd: number | undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'gym-wake-'));
  const substrateDir = join(scratch, 'substrate');
  const opLogPath = join(tmpdir(), `gym-wake-op-${HEX}.log`);
  let gymSql: postgres.Sql | undefined;
  let evidence: WakeEvidence | null = null;
  let ok = false;
  const report: Record<string, unknown> = {
    mode: FAKE ? 'fake (zero-LLM)' : 'real',
    harnessSlug: SLUG,
    workspaceId: WS,
    featureIds,
    concurrency: CONCURRENCY,
    maxTurns: MAX_TURNS,
    routineCron: CRON,
    startedBy: 'autoloop only — this run never calls pipeline/start',
  };

  try {
    // 1. Dedicated gym PG (full migration baseline + preminted spawn-signing key).
    // Self-heal sweep FIRST (WI-4332): reclaims any orphaned container a crashed
    // prior gym run left behind before Ryuk could reap it.
    await sweepOrphanedGymPgContainers({ image: GYM_PROVISION_PG_IMAGE }).catch(() => {});
    log('provisioning gym DB …');
    // max_connections=500: same as autoloop-cycle/blueprint-cycle — the gym operator's many
    // pools + agents exceed PG's default 100 → `sorry, too many clients already` (WI-5630).
    pgContainer = await new PostgreSqlContainer(GYM_PROVISION_PG_IMAGE)
      .withDatabase('papercusp_wake')
      .withCommand(['postgres', '-c', 'max_connections=500'])
      .start();
    const { databaseUri: gymUri } = await provisionGymDatabase({
      maintenanceUri: pgContainer.getConnectionUri(),
      dbName: DB_NAME,
    });
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });

    // 2. The throwaway harness tree: tiny buildable substrate + a blueprint that
    //    DECLARES its own autoloop trigger (the production enablement model).
    mkdirSync(join(substrateDir, '.papercusp'), { recursive: true });
    writeFileSync(join(substrateDir, '.papercusp', 'blueprint.yaml'), wakeBlueprintYaml(SLUG, { cron: CRON, concurrency: CONCURRENCY }));
    writeFileSync(
      join(substrateDir, '.papercusp', 'config.json'),
      JSON.stringify({ worktrees: { enabled: false }, parallelWorkers: { workingStateCheck: 'npm run typecheck' } }),
    );
    writeFileSync(
      join(substrateDir, 'package.json'),
      JSON.stringify({ name: 'wake-substrate', version: '0.0.0', private: true, type: 'module', scripts: { typecheck: 'node --check index.js' } }, null, 2) + '\n',
    );
    writeFileSync(join(substrateDir, 'index.js'), 'export function handle(req){ return { status: 404 }; }\n');
    writeFileSync(join(substrateDir, 'README.md'), '# wake-mode substrate\nA tiny Node (ESM) service.\n');
    execFileSync('git', ['init', '-q'], { cwd: substrateDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'add', '-A'], { cwd: substrateDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'commit', '-qm', 'seed'], { cwd: substrateDir });
    const seedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: substrateDir, encoding: 'utf8' }).trim();

    // 3. Boot the gym-operator with the autoloop ON — the one thing every other
    //    gym runnable turns off. autoloopScope=<slug> arms the 30s orchestrator
    //    sweep for exactly this harness; PAPERCUSP_DBOS_ROUTINES=1 (boot-spec)
    //    arms routinesTick for the bp-schedule trigger.
    const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    report.harnessCommit = harnessCommit;
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: REPO_ROOT,
      harnessCommit,
      gymDatabaseUrl: gymUri,
      honoPort: PORT,
      workspaceId: WS,
      autoloopScope: SLUG,
      agentCmd: FAKE ? `node ${FAKE_WAKE_AGENT}` : REAL_AGENT_CMD,
      agentModels: FAKE ? {} : undefined,
    });
    logFd = openSync(opLogPath, 'w');
    log(`booting gym-operator on :${PORT} (mode=${FAKE ? 'fake' : 'real'}, autoloop=${SLUG}, log → ${opLogPath}) …`);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...spec.env,
      PAPERCUSP_FLEET_SANDBOX: '0',
      PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0',
      NODE_ENV: 'production',
      // Pin the orchestrator ON (default-on, but the launcher env must not leak an opt-out).
      PAPERCUSP_DBOS_ORCHESTRATOR: '1',
      // Test-compressed cadences + the safety turn ceiling under test.
      PAPERCUSP_DBOS_ROUTINES_CRONTAB: '*/10 * * * * *',
      PAPERCUSP_DBOS_PIPELINE_MAX_TURNS: String(MAX_TURNS),
    };
    // Hermeticity (real mode auth, EI-232): a Claude-Code launcher session
    // carries its OWN per-session CLAUDE_CONFIG_DIR + nested-session markers.
    // If those leak into the gym operator, every spawned `claude -p` agent
    // auths against the LAUNCHER session's rotating OAuth and 401s mid-run
    // (observed live). The production fleet's spawns run with the
    // user-global ~/.claude — match it. (Shared with every other gym
    // runnable's spawn via boot-spec.ts — this was the original fix site;
    // the others were found still leaking and scrubbed the same way.)
    scrubLauncherClaudeSessionEnv(childEnv);
    // Explicit credential-dir OVERRIDE (the deliberate cousin of the accidental
    // leak above): when the user-global ~/.claude is headless-broken (`claude -p`
    // sends a server-rejected access token and never refreshes — observed
    // 2026-06-10), point the gym's agents at a known-good config dir.
    if (process.env.GYM_WAKE_CLAUDE_CONFIG_DIR) {
      childEnv.CLAUDE_CONFIG_DIR = process.env.GYM_WAKE_CLAUDE_CONFIG_DIR;
    }
    // EI-368: readiness (DBOS launched) + fail-fast on child death, with boot-log tail.
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
        env: childEnv,
        stdio: ['ignore', logFd, logFd],
        detached: true,
      },
      baseUrl: `http://127.0.0.1:${PORT}`,
      timeoutMs: 120_000,
      logPath: opLogPath,
      onRetry: (err) => log(`operator boot crashed, retrying once (${err.message.split('\n')[0]}) …`),
    });
    log('operator ready (DBOS launched)');

    // 4. Register the harness (the same public route the other gym runnables use).
    const res = await fetch(`http://127.0.0.1:${PORT}/api/harness/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, path: substrateDir }),
    });
    if (!res.ok) throw new Error(`register ${SLUG} → ${res.status}: ${await res.text()}`);
    const regBody = (await res.json().catch(() => ({}))) as { provisioning?: { ok?: boolean; error?: string } };
    if (regBody.provisioning && regBody.provisioning.ok === false)
      throw new Error(`register ${SLUG}: scaffold failed: ${regBody.provisioning.error ?? 'unknown'}`);
    log(`registered ${SLUG} ← ${substrateDir}`);

    // 5. Materialize the blueprint's declared schedule trigger into
    //    harness_shared.routines — the PRODUCTION function harness:create calls.
    const bp = loadBlueprintFromFile(join(substrateDir, '.papercusp', 'blueprint.yaml')).blueprint;
    const routines = await materializeBlueprintTriggers(SLUG, bp, { sql: gymSql, workspaceId: WS });
    if (routines.length !== 1) throw new Error(`expected 1 materialized bp-schedule routine, got ${routines.length}`);
    report.routine = routines[0];
    log(`materialized ${routines[0].name} (${routines[0].cron} → ${routines[0].targetRole})`);

    // 6. Queue the toy feature(s) — the blueprint-run work-item insert shape.
    const now = Date.now();
    for (const fid of featureIds) {
      await gymSql`
        INSERT INTO harness_shared.work_items
          (harness_slug, feature_id, title, summary, status, attempts,
           item_kind, needs_human_review, workspace_id, ts, created_ts, updated_ts)
        VALUES (${SLUG}, ${fid}, ${'Toy feature ' + fid + ': add a marker file'},
                ${'Touch nothing after filing: the autoloop must pick this up, run the pipeline to DONE, and free its slot. The change itself is trivial — add/append a marker file in the repo root and commit it.'},
                'open', 0, 'feature', FALSE, ${WS}, ${now}, ${now}, ${now})
        ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
    }
    // work-item-status-full-unify P-007: 'open' is the unified claimable token (was 'todo');
    // a 'todo' feature sits outside the ['open'] claim floor so the autoloop never picks it up.
    log(`queued ${featureIds.join(', ')} (status open) — touching nothing from here`);

    // 7. TOUCH NOTHING. Observe (read-only) until every feature passes and its
    //    pipeline settles, sampling the resources oracle as we go.
    const deadline = Date.now() + TIMEOUT_MIN * 60_000;
    let maxConcurrent = 0;
    let settled = false;
    while (Date.now() < deadline) {
      const live = await gymSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM dbos.workflow_status
         WHERE workflow_uuid LIKE ${'pipeline:' + SLUG + ':%'} AND status IN ('PENDING','ENQUEUED')`;
      maxConcurrent = Math.max(maxConcurrent, live[0]?.n ?? 0);
      const feats = await gymSql<{ feature_id: string; status: string }[]>`
        SELECT feature_id, status FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${SLUG}`;
      const allPassed = featureIds.every((fid) => feats.find((f) => f.feature_id === fid)?.status === 'passed');
      if (allPassed && (live[0]?.n ?? 0) === 0) {
        settled = true;
        break;
      }
      await sleep(3000);
    }
    report.settled = settled;
    report.maxConcurrentPipelines = maxConcurrent;

    // 8. Stop the cadence (the wake chain has done its job; a fire mid-collection
    //    would just look like an in-flight run) and let in-flight invokes drain.
    await gymSql`UPDATE harness_shared.routines SET active = false WHERE install_slug = ${SLUG}`;
    await sleep(8000);

    // 9. Collect evidence (read-only) + evaluate the oracles.
    const features = (
      await gymSql<{ feature_id: string; status: string }[]>`
        SELECT feature_id, status FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${SLUG} ORDER BY feature_id`
    ).map((r) => ({ id: r.feature_id, status: r.status }));
    const pipelines = (
      await gymSql<{ workflow_uuid: string; status: string }[]>`
        SELECT workflow_uuid, status FROM dbos.workflow_status
         WHERE workflow_uuid LIKE ${'pipeline:' + SLUG + ':%'} ORDER BY workflow_uuid`
    ).map((r) => ({ id: r.workflow_uuid, status: r.status }));
    const steps = await gymSql<{ workflow_uuid: string; function_name: string; n: number }[]>`
      SELECT workflow_uuid, function_name, count(*)::int AS n
        FROM dbos.operation_outputs
       WHERE workflow_uuid LIKE ${'pipeline:' + SLUG + ':%'}
       GROUP BY workflow_uuid, function_name`;
    const decideStepsByPipeline: Record<string, number> = {};
    const finalizeStepsByPipeline: Record<string, number> = {};
    for (const s of steps) {
      if (/^decide-\d+$/.test(s.function_name))
        decideStepsByPipeline[s.workflow_uuid] = (decideStepsByPipeline[s.workflow_uuid] ?? 0) + s.n;
      if (s.function_name === 'finalize-done')
        finalizeStepsByPipeline[s.workflow_uuid] = (finalizeStepsByPipeline[s.workflow_uuid] ?? 0) + s.n;
    }
    const deciderFires = (
      await gymSql<{ role: string; last_status: string | null; consecutive_errors: number }[]>`
        SELECT role, last_status, consecutive_errors FROM harness_shared.autoloop_state
         WHERE harness_slug = ${SLUG}`
    ).map((r) => ({ role: r.role, lastStatus: r.last_status, consecutiveErrors: Number(r.consecutive_errors ?? 0) }));
    const routineFireRuns = (
      await gymSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM dbos.workflow_status
         WHERE name = 'routineFire' AND status = 'SUCCESS'`
    )[0]?.n ?? 0;
    const runningRunOutputRows = (
      await gymSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.harness_run_output
         WHERE harness_slug = ${SLUG} AND exit_code IS NULL`
    )[0]?.n ?? 0;
    const runningNurseryRows = (
      await gymSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.spawned_agents WHERE status = 'running'`
    )[0]?.n ?? 0;

    // P-007: judge the produced work (when a threshold is set). Fake mode uses
    // the deterministic fakeWakeJudge; real mode the frozen rubric's real judge
    // (one LLM call, lazily imported so fake mode never loads the llm graph).
    let judge: WakeJudgeResult | undefined;
    if (JUDGE_THRESHOLD != null && Number.isFinite(JUDGE_THRESHOLD)) {
      const judgeCall: JudgeLlmCall =
        opts.judgeCall ?? (FAKE ? fakeWakeJudge : (await import('../llm-testing/llm-client')).llmCall);
      log(`judging produced work (threshold ${JUDGE_THRESHOLD}, judge=${FAKE && !opts.judgeCall ? 'fake' : 'real'}) …`);
      judge = await judgeWakeRun({
        sql: gymSql,
        slug: SLUG,
        substrateDir,
        seedCommit,
        intent:
          'Toy features for the autonomous-loop E2E: each adds/append a marker file in the repo root and commits it, untouched by humans.',
        projectContext: 'A tiny Node (ESM) service seeded for the wake-mode E2E; `npm run typecheck` is the build gate.',
        judgeCall,
        threshold: JUDGE_THRESHOLD,
      });
      log(`judge composite ${judge.composite.toFixed(2)} (threshold ${JUDGE_THRESHOLD})`);
    }

    evidence = {
      featureIds,
      features,
      pipelines,
      maxConcurrentPipelines: maxConcurrent,
      cap: CONCURRENCY,
      maxTurns: MAX_TURNS,
      decideStepsByPipeline,
      finalizeStepsByPipeline,
      deciderFires,
      routineFireRuns,
      routineSeeded: routines.length === 1,
      runningRunOutputRows,
      runningNurseryRows,
      ...(judge ? { judge } : {}),
    };
    const verdict = evaluateWakeOracles(evidence);
    report.evidence = evidence;
    report.failures = verdict.failures;
    ok = verdict.pass;
  } catch (err) {
    report.error = String(err);
  } finally {
    if (gymSql) {
      try {
        await gymSql.end({ timeout: 5 });
      } catch {
        /* ignore */
      }
    }
    if (operator?.pid) {
      try {
        process.kill(-operator.pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      await sleep(2500);
      try {
        process.kill(-operator.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (logFd !== undefined) {
      try {
        report.operatorLogTail = maskDsn(readFileSync(opLogPath, 'utf8').split('\n').slice(-25).join('\n'));
      } catch {
        /* ignore */
      }
    }
    if (opts.keep || process.env.GYM_WAKE_KEEP === '1') log(`kept scratch at ${scratch}`);
    else {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      if (pgContainer) await pgContainer.stop();
    } catch {
      /* ignore */
    }
  }

  return { ok, evidence, report };
}
