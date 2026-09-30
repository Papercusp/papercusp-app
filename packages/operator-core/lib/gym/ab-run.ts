/**
 * P-014 bounded A/B RUNNER — the milestone executor (run on capacity).
 *
 * Boots a dedicated headless gym-operator on a freshly-provisioned gym DB, then runs
 * `runAbEvaluation` over baseline + one candidate variant × the configured tasks × repeats,
 * and prints the three P-014 deliverables: per-(variant,task) judge-composite VARIANCE →
 * ε/δ/min-repeats (D-013), COST ($/run + projected $/cycle + $/converged-run, P-027), and
 * the A-vs-B COMPARISON (P-013). Teardown (kill operator, drop DB, rm scratch) in `finally`.
 *
 * Two modes (env GYM_AB_FAKE):
 *   GYM_AB_FAKE=1  → fake agent (fixtures/fake-agent.mjs) + fake judge → validates the WHOLE
 *                    assembly end-to-end with ZERO LLM spend.
 *   default (real) → real AGENT_CMD (GYM_AB_AGENT_CMD, e.g. `claude -p`) + the real
 *                    opus-4-8 judge. Run this only when the shared Claude session has capacity
 *                    (the judge + pipeline agents share its rate limit). ~$2.5/judge-call.
 *
 * Bounded (D-019): GYM_AB_REPEATS (default 2) × the fixed task set × 2 variants. Sized small.
 *
 *   cd apps/operator && set -a; . ./.env.local; set +a; \
 *     GYM_AB_FAKE=1 npx tsx lib/gym/ab-run.ts          # zero-LLM assembly check
 *     GYM_AB_REPEATS=3 npx tsx lib/gym/ab-run.ts        # real run (on capacity)
 */
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { provisionGymDatabase, GYM_PROVISION_PG_IMAGE } from './gym-db-init';
import { sweepOrphanedGymPgContainers } from './gym-pg-orphan-sweep';
import { buildGymOperatorBootSpec, scrubLauncherClaudeSessionEnv } from './boot-spec';
import { createGymRunnerPorts } from './runner-ports';
import { buildAbDeps } from './ab-runner-real';
import { runAbEvaluation, type AbConfig, type AbVariant, type AbTask } from './ab-runner';
import { GYM_JUDGE_RUBRIC_V1 } from './judge-scoring';
import { estimateConvergence } from './cost';
import type { JudgeLlmCall } from './judge';
import { spawnGymOperatorWithRetry } from './operator-ready';

// The gym judge + all gym agents use the CODE backend (the `claude` CLI), NOT anthropic-direct.
// The CLI drives the Anthropic subscription session (it paces/retries against the sub),
// whereas anthropic-direct hammers api.anthropic.com directly — which is what tripped the rate
// limit. Must be set BEFORE llm-client loads (its TEST_BACKEND is read at module init), so
// set it at module top; ab-run imports llm-client lazily inside main(). Overridable.
process.env.LLM_TEST_BACKEND = process.env.LLM_TEST_BACKEND ?? 'claude-code';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const FAKE_AGENT = join(__dirname, 'fixtures/fake-agent.mjs');
const PORT = Number(process.env.GYM_AB_PORT ?? 3972);
const HEX = randomBytes(4).toString('hex');
const DB_NAME = `papercusp_gym_ab_${HEX}`;
const WS = 'gym-ab-ws';
const FAKE = process.env.GYM_AB_FAKE === '1';
const REPEATS = Math.max(1, Number(process.env.GYM_AB_REPEATS ?? 2));
// All gym PIPELINE agents (scoper/worker/validator/curator/documenter/debugger/director)
// run on Sonnet 4.6 via a global --model on AGENT_CMD; with no AGENT_MODELS overrides every
// role inherits it. The JUDGE is a SEPARATE llmCall pinned to opus-4-8 (GYM_JUDGE_RUBRIC_V1)
// — and it ALSO routes through the claude-code backend (the CLI subscription), because the
// module top sets `LLM_TEST_BACKEND='claude-code'` (NOT the llm-client default of `anthropic-direct`/
// the Anthropic SDK). So judge + pipeline both use the claude CLI. This is gym-scoped only;
// the standard/prod agents are configured separately via operator_agent_config and untouched.
const REAL_AGENT_CMD = process.env.GYM_AB_AGENT_CMD ?? 'claude -p --model claude-sonnet-4-6';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stdout.write(`[ab-run] ${m}\n`);
const mask = (s: string) => s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]*(@)/g, '$1***$2');

/** A fixed, deliberately mildly-underspecified task on a tiny self-contained substrate. */
function fixedTask(): { task: AbTask; substrateFiles: Array<{ path: string; content: string }> } {
  return {
    task: {
      taskId: 'gym-ab-health',
      pool: 'train',
      repoUrl: '__SET_AT_RUNTIME__', // replaced with the per-run substrate clone source
      repoCommit: '__SET_AT_RUNTIME__',
      spec: 'Add a health endpoint so operators can check the service is alive.',
      intent: 'Operators need a liveness probe for the service.',
      projectContext: 'A tiny Node service (index.js) with a minimal HTTP handler.',
    },
    substrateFiles: [
      // A BUILDABLE package: the chunk-loop L1 gate (`npm run typecheck` → `node --check`,
      // dependency-free) passes on valid code + fails on a syntax error, so it is MEANINGFUL
      // (not a structural failure) and the chunk-loop worker model converges to a clean DONE.
      { path: 'package.json', content: JSON.stringify({ name: 'gym-substrate', version: '0.0.0', private: true, type: 'module', scripts: { typecheck: 'node --check index.js' } }, null, 2) + '\n' },
      { path: 'index.js', content: 'export function handle(req){ return { status: 404 }; }\n' },
      { path: 'README.md', content: '# gym A/B substrate\nA tiny Node (ESM) service. `npm run typecheck` is the build gate.\n' },
    ],
  };
}

/** A fake judge: deterministic composite from the trace length (zero LLM) — assembly check only. */
const fakeJudge: JudgeLlmCall = async (opts) => {
  const userLen = opts.messages.map((m) => m.content).join('').length;
  const c = 5 + (userLen % 5); // 5..9, varies a little so variance is non-trivial
  return { text: JSON.stringify({ d1: c, d2: c, d3: c, rationale: 'fake-judge assembly check' }), costUsd: 0, inputTokens: 10, outputTokens: 10 };
};

async function main(): Promise<void> {
  let pgContainer: StartedPostgreSqlContainer | undefined;
  let operator: ChildProcess | undefined;
  let logFd: number | undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'gym-ab-'));
  const substrateDir = join(scratch, 'substrate');
  const opLogPath = join(tmpdir(), `gym-ab-op-${HEX}.log`);
  let gymUri = '';
  let gymSql: postgres.Sql | undefined;
  let ok = false;
  const report: Record<string, unknown> = { mode: FAKE ? 'fake (zero-LLM)' : 'real', repeats: REPEATS };

  try {
    // 1. Dedicated gym DB. Self-heal sweep FIRST (WI-4332): reclaims any orphaned
    // container a crashed prior gym run left behind before Ryuk could reap it.
    await sweepOrphanedGymPgContainers({ image: GYM_PROVISION_PG_IMAGE }).catch(() => {});
    log('provisioning gym DB …');
    pgContainer = await new PostgreSqlContainer(GYM_PROVISION_PG_IMAGE).withDatabase('papercusp_ab').start();
    ({ databaseUri: gymUri } = await provisionGymDatabase({ maintenanceUri: pgContainer.getConnectionUri(), dbName: DB_NAME }));
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });

    // 2. Tiny substrate repo (one fixed task), pinned at its seed commit.
    const { task, substrateFiles } = fixedTask();
    mkdirSync(substrateDir, { recursive: true });
    mkdirSync(join(substrateDir, '.papercusp'), { recursive: true });
    // Production-fidelity: the REAL chunk-loop worker model (plan → per-chunk implement →
    // L1 typecheck gate → commit), with the gate pointed at the substrate's own dependency-free
    // `npm run typecheck` (the default `pnpm typecheck` fails structurally here — no pnpm/script).
    // The substrate is buildable (package.json above), so the gate is meaningful + runs converge.
    writeFileSync(join(substrateDir, '.papercusp', 'config.json'), JSON.stringify({ worktrees: { enabled: false }, parallelWorkers: { workingStateCheck: 'npm run typecheck' } }));
    for (const f of substrateFiles) writeFileSync(join(substrateDir, f.path), f.content);
    execFileSync('git', ['init', '-q'], { cwd: substrateDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'add', '-A'], { cwd: substrateDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'commit', '-qm', 'seed'], { cwd: substrateDir });
    const substrateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: substrateDir, encoding: 'utf8' }).trim();
    task.repoUrl = substrateDir;
    task.repoCommit = substrateCommit;

    // 3. Boot the gym-operator (fake or real agent).
    const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: REPO_ROOT,
      harnessCommit,
      gymDatabaseUrl: gymUri,
      honoPort: PORT,
      workspaceId: WS,
      agentCmd: FAKE ? `node ${FAKE_AGENT}` : REAL_AGENT_CMD,
      agentModels: FAKE ? {} : undefined,
    });
    logFd = openSync(opLogPath, 'w');
    log(`booting gym-operator on :${PORT} (mode=${FAKE ? 'fake' : 'real'}, log → ${opLogPath}) …`);
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
        // EI-232: scrub the launcher Claude-Code session's env so real-mode gym
        // agents auth against ~/.claude, not this session's per-session config dir.
        env: scrubLauncherClaudeSessionEnv({ ...process.env, ...spec.env, PAPERCUSP_FLEET_SANDBOX: '0', PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0', NODE_ENV: 'production', PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none' }),
        stdio: ['ignore', logFd, logFd],
        detached: true,
      },
      baseUrl: `http://127.0.0.1:${PORT}`,
      timeoutMs: 120_000,
      logPath: opLogPath,
      onRetry: (err) => log(`operator boot crashed, retrying once (${err.message.split('\n')[0]}) …`),
    });
    log('operator ready (DBOS launched)');

    // 4. Real judge llmCall — imported lazily so fake mode never loads the llm-client graph.
    const judge: JudgeLlmCall = FAKE ? fakeJudge : (await import('../llm-testing/llm-client')).llmCall;

    // 5. Ports + deps + config.
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const suToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
    const ports = createGymRunnerPorts({ operatorBaseUrl: `http://127.0.0.1:${PORT}`, gymSql, superuserToken: suToken, workspaceId: WS });
    const deps = buildAbDeps({
      gymSql,
      ports,
      llmCall: judge,
      // Fake pipelines cycle to a high iteration cap; give them room. Real agents converge sooner.
      timeoutMs: FAKE ? 240_000 : 1_200_000,
      pollIntervalMs: 3000,
      scratchRoot: scratch,
    });
    const variants: AbVariant[] = [
      { variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } },
      { variantId: 'cand-readback', label: 'worker re-reads acceptance', overlay: { promptOverrides: { worker: '# Worker\nBefore finishing, RE-READ the acceptance criteria and confirm each is met.' } } },
    ];
    const config: AbConfig = {
      variants,
      tasks: [task],
      repeats: REPEATS,
      rubric: GYM_JUDGE_RUBRIC_V1,
      harnessCommit,
      workspaceId: WS,
      scratchRoot: scratch,
      deriveOpts: { sigmaMultiple: 2, targetStandardError: 0.25 },
      maxDistillChars: 60_000,
    };

    // 6. Run the bounded A/B.
    log(`running A/B: ${variants.length} variants × ${config.tasks.length} task × ${REPEATS} repeats = ${variants.length * config.tasks.length * REPEATS} runs …`);
    const res = await runAbEvaluation(config, deps);

    // 7. The three P-014 deliverables.
    const acceptRate = 0.33; // placeholder for the $/converged-run projection (refine from real loop data)
    report.runs = res.outcomes.length;
    report.perTaskVariance = res.perTaskVariance;
    report.comparison = res.comparison;
    report.cost = {
      ...res.cost,
      convergenceProjection: estimateConvergence(res.cost.meanRunUsd * variants.length * config.tasks.length, acceptRate),
    };
    report.outcomes = res.outcomes.map((o) => ({ v: o.variantId, t: o.taskId, r: o.repeat, outcome: o.outcome, composite: o.composite, usd: o.pipelineUsd + o.judgeUsd }));
    ok = res.outcomes.length === variants.length * config.tasks.length * REPEATS;
  } catch (err) {
    report.error = String(err);
  } finally {
    if (gymSql) { try { await gymSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (operator?.pid) {
      try { process.kill(-operator.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2500);
      try { process.kill(-operator.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (logFd !== undefined) { try { report.operatorLogTail = mask(readFileSync(opLogPath, 'utf8').split('\n').slice(-20).join('\n')); } catch { /* ignore */ } }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (pgContainer) await pgContainer.stop(); } catch { /* ignore */ }
  }

  process.stdout.write('\n===== GYM A/B (P-014) REPORT =====\n' + mask(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nAB-RUN: OK\n' : '\nAB-RUN: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
