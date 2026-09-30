/**
 * `runHiveEvalGen` — the SHARED Hive-evaluation cadence orchestration (build the live cadence deps
 * → `runHiveEvalCadenceTick`), the single source of truth the `pot-eval:gen` deterministic
 * blueprint step runs (HE-07, P-050). The SIBLING of `runIqBatteryGen` (iq-battery/gen-loop.ts) —
 * same gated-tick discipline, its own slice + tables (D-006/D-011).
 *
 * Per cadence: REFUSE without an owner-set `payload.budgetUsd` (a whole-Hive generation is real LLM
 * spend — the gym's unattended-spend precedent), REFUSE on an unknowable code SHA, SKIP when a
 * generation already exists at the current (workspace, SHA) — the durable-replay / double-spend
 * guard — else run + score ONE generation of the seeded scenario corpus.
 *
 * THE LIVE RUNNER IS BOUND (P-063 / D-011): the default `runBattery` is now the live whole-Hive
 * generation — `makeLiveHivePorts(liveHiveOps)` + the replay score extractor → `runHiveEvalGeneration`.
 * P-051 is a BUDGET-FLIP, not a build: the cadence MECHANISM (schedule / budget-gate / SHA-dedupe /
 * refuse-safely) plus the live ports are complete; arming is the owner's budget + routine-active
 * (`tsx lib/hive-eval/seed-hive-eval-routine.ts --active --budget=<usd>`). Binding the live runner is
 * SAFE because the budget gate still refuses every unattended tick until the owner sets a budget.
 *
 * Deps are injectable PARAMETERS (the op's test seam passes fakes — no PG/git/LLM).
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  runHiveEvalCadenceTick,
  type HiveEvalCadenceDeps,
  type HiveEvalCadenceOutcome,
  type HiveEvalRunFn,
  type HiveEvalRunRequest,
} from './cadence-tick';

/** Fixed base seed for the live generation (per-run seed = seed + repeat — reproducible, P-022). */
const LIVE_HIVE_EVAL_SEED = 1;

/**
 * The LIVE Hive-eval generation runner, bound over the owner-gated whole-Hive ports (P-063 / D-011):
 * `makeLiveHivePorts(liveHiveOps)` + the replay extractor → `runHiveEvalGeneration`. Lazy-imports the
 * hive/score graph so the routines boot path never loads it (mirrors the IQ-battery sibling). The
 * cadence's budget gate still REFUSES every tick without an owner-set budgetUsd — so binding this
 * spends nothing until P-051.
 */
function makeLiveRunBattery(workspaceId: string): HiveEvalRunFn {
  return async (req: HiveEvalRunRequest) => {
    const [
      { makeLiveHivePorts },
      { liveHiveOps },
      { makeReplayExtractor },
      { runHiveEvalGeneration },
      { createPgHiveEvalStore },
      { HIVE_EVAL_SCENARIOS },
      { buildManifest },
    ] = await Promise.all([
      import('./live-ports'),
      import('./live-ops'),
      import('./live-capture'),
      import('./generation-runner'),
      import('./store-pg'),
      import('./scenarios'),
      import('../iq-battery/beekeeper-gen0-runner'),
    ]);

    // Identity: the SAME codeSha the cadence dedupes on (buildManifest's short SHA) so the stamped
    // instance and the dedupe query agree byte-for-byte; a hive-eval-scoped instanceId + slice.
    const { manifest } = buildManifest(workspaceId);
    const ids = req.scenarioIds ?? [];
    const scenarios = ids.length > 0 ? HIVE_EVAL_SCENARIOS.filter((s) => ids.includes(s.id)) : HIVE_EVAL_SCENARIOS;
    const numRuns = Math.max(1, scenarios.length * req.repeats);

    const { sql } = getOrgPg();
    // The owner budget is the TOTAL ceiling; record it per-run. The REAL spend bound on the live
    // drive is the per-run timeout + beeCap + always-pause-on-timeout (first-live-run validates the
    // actual spend, P-051) — `budgetUsdCap` is the recorded determinism control, not a hard meter.
    await runHiveEvalGeneration(
      {
        instance: {
          instanceId: `hive-eval-${manifest.codeSha}-${workspaceId}`,
          workspaceId,
          codeSha: manifest.codeSha,
          genomeId: undefined,
          batterySliceId: 'hive-eval',
          createdAt: manifest.createdAt,
        },
        scenarios,
        repeats: req.repeats,
        seed: LIVE_HIVE_EVAL_SEED,
        budgetUsdCap: req.capUsd / numRuns,
        beeCap: req.beeCap,
      },
      {
        store: createPgHiveEvalStore(sql),
        ports: makeLiveHivePorts(liveHiveOps({ workspaceId }), { workspaceId }),
        // The score is judge-free by default (the deterministic floor + gate IS the score, D-015);
        // `req.dryRun` is already the effective mode since no LLM judge is wired here.
        extractor: makeReplayExtractor(),
      },
    );
  };
}

export interface HiveEvalGenDeps {
  /** Generation runner (default: the bound live runner — makeLiveHivePorts + replay extractor). */
  runBattery?: HiveEvalRunFn;
  /** Short code SHA (default: buildManifest's exact form — keeps dedupe byte-identical). */
  currentCodeSha?: () => string;
  /** Does a baseline instance already exist at (workspace, sha)? (default: live PG query.) */
  generationExists?: (codeSha: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

export async function runHiveEvalGen(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: HiveEvalGenDeps = {},
): Promise<HiveEvalCadenceOutcome> {
  let currentCodeSha = deps.currentCodeSha;
  if (!currentCodeSha) {
    // buildManifest is the runner's own identity derivation — using it keeps the dedupe SHA
    // byte-identical to what the generation stamps on the hive_eval instance.
    const { buildManifest } = await import('../iq-battery/beekeeper-gen0-runner');
    currentCodeSha = () => buildManifest(input.workspaceId).manifest.codeSha;
  }
  const generationExists =
    deps.generationExists ??
    (async (codeSha: string) => {
      const { sql } = getOrgPg();
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM harness_shared.pot_eval_instances
         WHERE workspace_id = ${input.workspaceId} AND code_sha = ${codeSha} AND genome_id IS NULL
         LIMIT 1`;
      return rows.length > 0;
    });

  const cadenceDeps: HiveEvalCadenceDeps = {
    currentCodeSha,
    generationExists,
    runBattery: deps.runBattery ?? makeLiveRunBattery(input.workspaceId),
    log: deps.log ?? ((m) => console.log(m)),
  };
  return runHiveEvalCadenceTick(cadenceDeps, { installSlug: input.installSlug, payload: input.payload ?? null });
}
