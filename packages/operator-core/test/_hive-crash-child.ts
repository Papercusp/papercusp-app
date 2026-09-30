/**
 * _hive-crash-child.ts — child-process driver for the hive-loop crash-resume
 * E2E (plan hive-loop-e2e-testing-2026-06-10 P-002). NOT a test file — spawned
 * by lib/dbos/hive-loop-crash-resume.integration.test.ts.
 *
 * CRASH_MODE=crash:   boot DBOS, start the F-CRASH pipeline, and SIGKILL this
 *                     process MID-WORKER-STEP (after recording the invocation +
 *                     spawn row) — a true crash: no destructors, no cleanup.
 * CRASH_MODE=recover: boot DBOS against the SAME system DB + app version;
 *                     DBOS recovery resumes the PENDING workflow; wait for its
 *                     result, record it, exit 0.
 *
 * The fake runner is deterministic ACROSS processes: the director's decision is
 * a pure function of the turn parsed from the replay-stable idempotency key
 * (`<slug>:<feature>:<role>:t<turn>` — t0 → NEXT_WORKER, t1 → DONE), so the
 * recovered replay takes the same path with no in-memory state. Every runner
 * invocation lands in test_crash.invocations; the REAL runner's idempotency
 * contract (invoke() reuses the completed agent run for a key — ONE spawn per
 * key, ever) is emulated by test_crash.spawns (PK = key, ON CONFLICT DO NOTHING).
 */
import postgres from 'postgres';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { SpineSchema } from '@papercusp/orchestrator/blueprint';

const DSN = process.env.CRASH_DB_DSN!;
const MODE = process.env.CRASH_MODE!; // 'crash' | 'recover'
const SLUG = 'crash';
const FID = 'F-CRASH';

/**
 * The spine this durability test runs against, declared INLINE and passed on
 * `PipelineInput.spine` — deliberately NOT the runtime's no-spine fallback.
 *
 * What this test proves is DBOS crash-resume durability (the interrupted step
 * re-runs; the completed decide step replays from its checkpoint; the spawn is
 * reused), which needs only a two-role decider→worker shape. Which blueprint the
 * ENGINE happens to default to is an unrelated product choice, and letting it
 * leak in here made this test silently assert that choice: when the no-spine
 * fallback was repointed from `coding-factory` (decider `director`) to
 * `coding-solo` (decider `worker`, a single-agent benchmark ablation) on
 * 2026-07-20, `orchestratorRole` became `worker`, so the runner below SIGKILLed
 * the child during turn-0 DECIDE — one invocation row, role `worker`, and a red
 * that read like a lost INSERT rather than a changed default (EI-20631691687347174).
 * Pinning the spine makes the durability contract independent of that default.
 */
const CRASH_SPINE = SpineSchema.parse({
  decider: 'director',
  maxTurns: 10,
  edges: {
    NEXT_WORKER: { to: 'role', role: 'worker', extras: ['FEATURE_ID={feature}'] },
    DONE: { to: 'done' },
  },
  default: { to: 'idle' },
});

async function main(): Promise<void> {
  const sql = postgres(DSN, { max: 2, onnotice: () => {} });

  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: DSN,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'crash-v1', // SAME in both children — recovery is per-version
    runAdminServer: false,
  });

  // Register the workflow AFTER setConfig, BEFORE launch (mirrors bootstrap.ts).
  const wf = await import('../lib/dbos/orchestrator-workflow');

  wf.setPipelineInvokeRunner(async (_slug, role, _feature, key) => {
    await sql`INSERT INTO test_crash.invocations (key, role, pid, mode)
              VALUES (${key}, ${role}, ${process.pid}, ${MODE})`;
    await sql`INSERT INTO test_crash.spawns (key, role)
              VALUES (${key}, ${role}) ON CONFLICT (key) DO NOTHING`;
    if (role === 'director') {
      const turn = Number(/:t(\d+)$/.exec(key)?.[1] ?? '0');
      return { output: turn === 0 ? `NEXT_WORKER ${FID}` : 'DONE', exitCode: 0 };
    }
    if (role === 'worker' && MODE === 'crash') {
      // Die MID-STEP: invocation + spawn recorded, the step never completes.
      process.kill(process.pid, 'SIGKILL');
    }
    return { output: `ran ${role}`, exitCode: 0 };
  });

  wf.setPipelineFinalizer(async ({ outcome }) => {
    await sql`INSERT INTO test_crash.finalizes (outcome) VALUES (${outcome})`;
  });

  await DBOS.launch();

  if (MODE === 'crash') {
    await wf.startFeaturePipeline({
      harnessSlug: SLUG,
      featureId: FID,
      epoch: 0,
      workspaceId: 'ws-crash',
      spine: CRASH_SPINE,
    });
    // The worker step SIGKILLs us. Still alive after 60s = the pipeline never
    // reached the worker — bail loudly so the parent fails with a clear signal.
    await new Promise((r) => setTimeout(r, 60_000));
    console.error('[crash-child] still alive 60s after start — worker step never ran');
    process.exit(3);
  } else {
    const res = await DBOS.getResult<string>(`pipeline:${SLUG}:${FID}:e0`, 90);
    await sql`INSERT INTO test_crash.markers (k) VALUES (${`result:${res}`})`;
    await DBOS.shutdown();
    await sql.end({ timeout: 5 });
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('[crash-child] fatal:', e);
  process.exit(2);
});
