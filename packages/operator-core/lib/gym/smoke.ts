/**
 * Hermetic-runner SMOKE (P-001 end-to-end validation, zero LLM spend).
 *
 * Boots a dedicated headless gym-operator against a freshly-provisioned gym DB and
 * runs ONE fake-agent pipeline to terminal, then captures the trace + diff — proving
 * the runner→capture plumbing without a model. Run on demand:
 *   cd apps/operator && set -a; . ./.env.local; set +a; npx tsx lib/gym/smoke.ts
 *
 * Careful by construction: separate DB + free port + separate workspace (never the
 * live :3070), and teardown (kill operator, drop DB, rm scratch) runs in `finally`.
 * Bounded: the fake agent is instant, so the whole run is seconds.
 */
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
// A DEDICATED (non-reused) PG container for the smoke. The shared test-config
// getTestPg() uses .withReuse() + teardownTestPg() stops it, so a concurrent test (or
// another smoke run) stopping the shared container mid-run causes ECONNREFUSED — fatal
// to the long-lived operator the smoke boots. A dedicated container isolates the smoke.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { provisionGymDatabase, GYM_PROVISION_PG_IMAGE } from './gym-db-init';
import { sweepOrphanedGymPgContainers } from './gym-pg-orphan-sweep';
import { buildGymOperatorBootSpec, scrubLauncherClaudeSessionEnv } from './boot-spec';
import { spawnGymOperatorWithRetry } from './operator-ready';
import { collectTrace } from './collector';
import { distillTrace } from './distill';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const FAKE_AGENT = join(__dirname, 'fixtures/fake-agent.mjs');
const PORT = Number(process.env.GYM_SMOKE_PORT ?? 3971);
const HEX = randomBytes(4).toString('hex');
const DB_NAME = `papercusp_gym_smoke_${HEX}`;
const SLUG = `gymsmoke${HEX}`; // hyphen-free → valid unquoted PG schema harness_<slug>
const WS = 'gym-smoke-ws';
const FEATURE = 'F-GYM-SMOKE';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stdout.write(`[smoke] ${m}\n`);
/** Mask passwords in any postgres DSN so the report never leaks a secret. */
const mask = (s: string) => s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]*(@)/g, '$1***$2');

async function main(): Promise<void> {
  // The gym needs a PG where it can CREATE EXTENSION (superuser) — the dev box's
  // harness_admin is not superuser. A DEDICATED pgvector container (NOT the shared
  // reused getTestPg one) gives a superuser PG isolated from cross-process churn.
  let pgContainer: StartedPostgreSqlContainer | undefined;
  // Self-heal sweep FIRST (WI-4332): reclaims any orphaned container a crashed prior
  // gym run left behind before Ryuk could reap it.
  await sweepOrphanedGymPgContainers({ image: GYM_PROVISION_PG_IMAGE }).catch(() => {});
  pgContainer = await new PostgreSqlContainer(GYM_PROVISION_PG_IMAGE).withDatabase('papercusp_smoke').start();
  const maintenanceUri = pgContainer.getConnectionUri();

  let operator: ChildProcess | undefined;
  let logFd: number | undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'gym-smoke-'));
  // basename(cloneDir) MUST equal the slug: invoke-once derives the harness slug from
  // basename(PROJECT_DIR) when HARNESS_SLUG doesn't take, and the slug picks the PG
  // search_path schema (harness_<slug>). The real gym runner already does this
  // (cloneDirName === harnessSlug); the smoke must too.
  const cloneDir = join(scratch, SLUG);
  // Persist OUTSIDE scratch (which teardown rm's) so the operator log can be grepped
  // afterward to diagnose the worker's PG connection / search_path.
  const opLogPath = join(tmpdir(), `gym-smoke-op-${HEX}.log`);
  let gymUri = '';
  let ok = false;
  const report: Record<string, unknown> = {};

  try {
    // 1. Provision the dedicated gym DB.
    log(`provisioning gym DB ${DB_NAME} …`);
    ({ databaseUri: gymUri } = await provisionGymDatabase({ maintenanceUri, dbName: DB_NAME }));

    // 2. Throwaway substrate repo (a tiny git repo + .papercusp/config.json).
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(join(cloneDir, 'README.md'), '# gym smoke substrate\n');
    mkdirSync(join(cloneDir, '.papercusp'), { recursive: true });
    // chunk-loop OFF so the fake worker runs as a single invoke().
    writeFileSync(join(cloneDir, '.papercusp', 'config.json'), JSON.stringify({ worktrees: { enabled: false } }));
    execFileSync('git', ['init', '-q'], { cwd: cloneDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'add', '-A'], { cwd: cloneDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'commit', '-qm', 'seed'], { cwd: cloneDir });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    report.baseCommit = baseCommit;

    // 3. Boot the headless gym-operator.
    const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: REPO_ROOT,
      harnessCommit,
      gymDatabaseUrl: gymUri,
      honoPort: PORT,
      workspaceId: WS,
      agentCmd: `node ${FAKE_AGENT}`,
      agentModels: {},
    });
    logFd = openSync(opLogPath, 'w');
    log(`booting gym-operator on :${PORT} (log → ${opLogPath}) …`);
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
        // EI-232: scrub the launcher Claude-Code session's env so a real-mode gym
        // agent (should this smoke ever be pointed at one) auths against
        // ~/.claude, not this session's per-session config dir. This runnable is
        // fake-agent-only today (agentCmd above is always FAKE_AGENT), so the
        // leak is currently dormant here — scrubbed anyway for consistency with
        // every other gym runnable's spawn.
        env: scrubLauncherClaudeSessionEnv({
          ...process.env,
          ...spec.env,
          PAPERCUSP_FLEET_SANDBOX: '0',
          PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0',
          NODE_ENV: 'production',
          // Autoloop OFF — the smoke starts the pipeline EXPLICITLY (deterministic) via
          // the admin route + superuser token (the real gym wiring), not the 30s tick.
          PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none',
        }),
        stdio: ['ignore', logFd, logFd],
        detached: true, // own process group → teardown kills the whole npx→node tree
      },
      baseUrl: `http://127.0.0.1:${PORT}`,
      timeoutMs: 120_000,
      logPath: opLogPath,
      onRetry: (err) => log(`operator boot crashed, retrying once (${err.message.split('\n')[0]}) …`),
    });
    log('operator ready (DBOS launched)');

    // 4. Register the harness (scaffolds harness_<slug> + registry).
    const reg = await fetch(`http://127.0.0.1:${PORT}/api/harness/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, path: cloneDir }),
    });
    report.register = { status: reg.status, body: await reg.text() };
    log(`register → ${reg.status}`);

    // DIAGNOSTIC: did scaffold create the harness schema + the harness_features view?
    {
      const diag = postgres(gymUri, { max: 1, onnotice: () => {}, prepare: false });
      try {
        const sch = await diag<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = ${'harness_' + SLUG}`;
        report.harnessSchemaExists = sch[0].n > 0;
        const vw = await diag<{ x: boolean }[]>`SELECT to_regclass(${'harness_' + SLUG + '.harness_features'}) IS NOT NULL AS x`;
        report.harnessFeaturesViewExists = vw[0].x;
        const tbls = await diag<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = ${'harness_' + SLUG} ORDER BY table_name`;
        report.harnessSchemaObjects = tbls.map((t) => t.table_name);
      } finally {
        await diag.end({ timeout: 5 });
      }
    }

    // 5. File the feature — DIRECT PG insert into the consolidated table (the HTTP
    //    /features/import path goes through legacy SQLite which isn't scaffolded here).
    {
      const w = postgres(gymUri, { max: 1, onnotice: () => {}, prepare: false });
      try {
        await w`
          INSERT INTO harness_shared.work_items (harness_slug, feature_id, workspace_id, title, status)
          VALUES (${SLUG}, ${FEATURE}, ${WS}, ${'Smoke feature'}, ${'todo'})
          ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
        report.fileFeature = 'inserted (direct PG)';
        log('file feature → inserted (direct PG)');
      } finally {
        await w.end({ timeout: 5 });
      }
    }

    // 6. Start the pipeline EXPLICITLY (deterministic) via the admin route + the
    //    superuser bearer (elevates trust past the loopback allowlist). Token read
    //    from disk, never logged.
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const suToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
    report.superuserTokenPresent = suToken.length > 0;
    const start = await fetch(`http://127.0.0.1:${PORT}/api/admin/dbos/pipeline/start?superuser=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${suToken}` },
      body: JSON.stringify({ harnessSlug: SLUG, featureId: FEATURE }),
    });
    report.startPipeline = { status: start.status, body: (await start.text()).slice(0, 200) };
    log(`start pipeline → ${start.status}`);

    // 7. Poll the workflow status from the gym DB.
    const gym = postgres(gymUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const wfPrefix = `pipeline:${SLUG}:${FEATURE}:e`;
      let status = 'PENDING';
      // This smoke validates the CAPTURE CHAIN (boot→run→collect→distill), not the
      // fake-agent's convergence: the fake validator prints `[PASS]` but the orchestrator
      // reads feature status from PG (not stdout), so the feature stays 'failing' and the
      // pipeline runs a nondeterministic 25–123+ debugger/rework cycles before hitting its
      // iteration cap. Waiting for terminal SUCCESS is therefore inherently flaky. Instead
      // break as soon as a SUBSTANTIAL real multi-role pipeline has run (≥ MIN_RUNS rows) —
      // enough for a faithful real trace — or on a real terminal state, or the ceiling.
      const MIN_RUNS = 12;
      const deadline = Date.now() + 240_000;
      let runCount = 0;
      while (Date.now() < deadline) {
        const rows = await gym<{ status: string }[]>`
          SELECT status FROM dbos.workflow_status WHERE workflow_uuid LIKE ${wfPrefix + '%'} ORDER BY created_at DESC LIMIT 1`;
        status = rows[0]?.status ?? 'PENDING';
        if (status === 'SUCCESS' || status === 'ERROR' || status === 'RETRIES_EXCEEDED') break;
        const cnt = await gym<{ n: number }[]>`
          SELECT count(*)::int AS n FROM harness_shared.harness_run_output WHERE harness_slug = ${SLUG}`;
        runCount = cnt[0]?.n ?? 0;
        if (runCount >= MIN_RUNS) break; // enough real work captured — don't wait for the fake loop to cap out
        await sleep(2000);
      }
      report.workflowStatus = status; // observability (SUCCESS or healthy-PENDING); only ERROR/RETRIES_EXCEEDED fails
      report.brokeEarlyOnRunCount = status === 'PENDING' && runCount >= MIN_RUNS;
      log(`workflow status → ${status}`);

      // 8. Capture: feature status, run_output transcript rows, git diff in the clone.
      const feat = await gym<{ status: string }[]>`
        SELECT status FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${SLUG} AND feature_id = ${FEATURE}`;
      report.featureStatus = feat[0]?.status ?? null;
      const runs = await gym<{ run_id: string; role: string }[]>`
        SELECT run_id, role FROM harness_shared.harness_run_output WHERE harness_slug = ${SLUG} ORDER BY started_at`;
      report.runOutputRows = runs.length;
      report.roles = runs.map((r) => r.role);

      // 8b. P-002 trace collector — validate it assembles a REAL RawTrace from the real
      // run: per-role transcripts (harness_run_output.out_body) + the real `git diff
      // <base> HEAD` in the clone + terminal state, then writes a trace bundle. This is
      // the bridge "pipeline ran → scoreable trace"; previously only DI-fake-tested,
      // never against a real pipeline's output.
      {
        const traceDir = join(scratch, 'traces');
        mkdirSync(traceDir, { recursive: true });
        const { rawTrace, traceRef } = await collectTrace(
          { harnessSlug: SLUG, clonePath: cloneDir, baseCommit, terminalState: status, signals: { runOutputRows: runs.length } },
          {
            readRunOutputs: async (slug) => {
              const rows = await gym<{ run_id: string; role: string | null; out_body: string }[]>`
                SELECT run_id, role, out_body FROM harness_shared.harness_run_output
                 WHERE harness_slug = ${slug} ORDER BY started_at`;
              return rows.map((r) => ({ runId: r.run_id, role: r.role ?? '', outBody: r.out_body }));
            },
            gitDiff: async (clonePath, base) =>
              execFileSync('git', ['-C', clonePath, 'diff', base, 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
            writeBundle: async (text) => {
              const p = join(traceDir, `${SLUG}.trace.json`);
              writeFileSync(p, text);
              return p;
            },
          },
        );
        report.collector = {
          transcriptCount: rawTrace.roleTranscripts.length,
          diffBytes: rawTrace.diff.length,
          hasWorkerDiff: rawTrace.diff.includes('GYM_FAKE_WORK'),
          terminalState: rawTrace.terminalState,
          traceRefWritten: existsSync(traceRef),
        };
        log(`collector → ${rawTrace.roleTranscripts.length} transcripts, ${rawTrace.diff.length}B diff, bundle written=${existsSync(traceRef)}`);

        // 8c. P-029 distillation — validate distillTrace compresses the REAL RawTrace into
        // a bounded, judge-sized input (deterministic selection/budgeting, no LLM): the
        // hard char budget is respected, the diff section survives (the judge must see the
        // produced code), and the distillation is stable (it is itself a noise source, so
        // identical input must give identical output). Previously only fake-tested.
        const JUDGE_BUDGET = 60_000;
        const distilled = distillTrace(rawTrace, { maxChars: JUDGE_BUDGET });
        const distilled2 = distillTrace(rawTrace, { maxChars: JUDGE_BUDGET });
        const rawInputBytes = rawTrace.diff.length + rawTrace.roleTranscripts.reduce((n, t) => n + t.text.length, 0);
        const distillReport = {
          rawInputBytes,
          outputChars: distilled.text.length,
          withinBudget: distilled.text.length <= JUDGE_BUDGET,
          truncated: distilled.truncated,
          deterministic: distilled.text === distilled2.text,
          hasDiffSection: distilled.text.includes('## Diff'),
        };
        report.distill = distillReport;
        log(`distill → ${distilled.text.length}/${JUDGE_BUDGET} chars (from ${rawInputBytes}B), truncated=${distilled.truncated}, deterministic=${distillReport.deterministic}`);
      }
    } finally {
      await gym.end({ timeout: 5 });
    }

    // git: did the worker commit (a diff to capture)?
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    report.workerCommitted = head !== baseCommit;
    if (head !== baseCommit) {
      report.diffStat = execFileSync('git', ['diff', '--stat', baseCommit, head], { cwd: cloneDir, encoding: 'utf8' }).trim();
    }

    // PASS = the pipeline ran healthily (not a hard DBOS failure) AND produced a real
    // multi-role trace that the P-002 collector assembled + bundled AND the P-029
    // distillation compressed within the judge budget, deterministically, keeping the
    // diff. We do NOT require workflow SUCCESS: the fake-agent's feature stays 'failing'
    // so the pipeline cycles to its iteration cap (a fixture artifact), and the smoke's
    // job is to validate the capture chain, not that convergence. A real DBOS ERROR /
    // RETRIES_EXCEEDED still fails. (transcriptCount ≥ MIN_RUNS proves a real run.)
    const col = report.collector as { transcriptCount: number; traceRefWritten: boolean } | undefined;
    const dis = report.distill as { withinBudget: boolean; deterministic: boolean; hasDiffSection: boolean } | undefined;
    ok =
      report.workflowStatus !== 'ERROR' && report.workflowStatus !== 'RETRIES_EXCEEDED' &&
      !!col && col.transcriptCount >= 12 && col.traceRefWritten === true &&
      !!dis && dis.withinBudget === true && dis.deterministic === true && dis.hasDiffSection === true;
  } catch (err) {
    report.error = String(err);
  } finally {
    // Teardown — always.
    if (operator && operator.pid) {
      // detached → operator.pid is the group leader; negative pid kills the whole tree.
      try { process.kill(-operator.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2500);
      try { process.kill(-operator.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (logFd !== undefined) {
      try {
        report.operatorLogTail = mask(readFileSync(opLogPath, 'utf8').split('\n').slice(-25).join('\n'));
      } catch {
        /* ignore */
      }
    }
    // DIAGNOSTIC (in finally so a poll flake can't lose it): capture the worker
    // invoke's pg-bootstrap line (search_path / DB) to pin why harness_features
    // isn't resolved. Read both candidate log homes.
    try {
      let blob = '';
      const logsDir = join(cloneDir, '.papercusp', 'logs');
      if (existsSync(logsDir)) {
        report.harnessLogFiles = readdirSync(logsDir);
        for (const f of report.harnessLogFiles as string[]) {
          try { blob += readFileSync(join(logsDir, f), 'utf8') + '\n'; } catch { /* ignore */ }
        }
      }
      for (const p of [join(tmpdir(), `harness-${SLUG}.log`), `/tmp/harness-${SLUG}.log`]) {
        try { blob += readFileSync(p, 'utf8') + '\n'; } catch { /* ignore */ }
      }
      report.workerPgDiag = mask(
        blob.split('\n').filter((l) => /PG bootstrap|DATABASE_URL|embedded-pg|search_path|harness_features|getHarnessAdminUrl|USE_PG_STATE|connected|opted-out|verification/i.test(l)).slice(-30).join('\n'),
      ) || '(no worker run-log lines found)';
    } catch (e) {
      report.workerPgDiag = `capture err: ${String(e)}`;
    }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    // Stop the dedicated gym container (drops the gym DB with it).
    try { if (pgContainer) await pgContainer.stop(); } catch { /* ignore */ }
  }

  process.stdout.write('\n===== GYM SMOKE REPORT =====\n' + mask(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nSMOKE: PASS\n' : '\nSMOKE: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
