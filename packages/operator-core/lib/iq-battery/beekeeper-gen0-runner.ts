/**
 * beekeeper-gen0-runner.ts — the LIVE generation-0 IQ battery runner
 * (Apiary `apiary-generation-0-battery` P-004 / P-003 / P-005 / P-006).
 *
 * Replaces the PART-B stub (random scores, ephemeral getTestPg). This wires the REAL battery:
 *   - solver bees (gpt-5.6-sol @ xhigh — pinned via AGENT_MODELS) administer one corpus case each (P-001);
 *   - their REAL transcripts + signals are distilled + collected (P-002 / D-004);
 *   - a REAL Sol xhigh judge scores each run (P-003);
 *   - everything persists to the LIVE org PG via BeekeeperStorePg + iq_battery_metrics (D-005);
 *   - a hard total-$spend cap + a cost-estimate preamble + a --dry-run (skip-judge) mode (P-005).
 *
 * Trigger (P-006): this is the documented CLI the Queen places onto a bee as a real mission, so the
 * now-working Queen loop drives the baseline end-to-end (dogfood). It also runs standalone on the host.
 *
 * Usage:
 *   tsx beekeeper-gen0-runner.ts --harness=<slug> [--dry-run] [--cap=50] [--cases=1] [--repeats=1] \
 *                                [--workspace=<id>] [--timeout-ms=600000] [--poll-ms=5000]
 *
 *   --dry-run     administer + collect + persist runs, SKIP the judge → $0 judge spend (plumbing smoke, P-008)
 *   --cap=<usd>   hard total-spend ceiling; the run aborts the instant a charge would exceed it (default $50)
 *   --cases=<n>   cases per variant (default 1 → 4 judged cases for the first baseline; P-009)
 *   --repeats=<n> repeats per case for noise calibration (default 1)
 *
 * The pure pieces (parseGen0Args / makeSpend) are exported + unit-tested; the battery itself is live.
 */
import { execFileSync } from 'node:child_process';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { isCliEntry } from '../util/cli-entry';
import { runBeekeeperBattery, type BeekeeperConfig, type BeekeeperDeps } from './beekeeper-runner';
import { seedCorpus, type TaskVariant, type CorpusCase, type Rubric } from './corpus';
import { createMetricsCollector } from './collectors';
import { BeekeeperStorePg } from './beekeeper-store-pg';
import { makeBeeRunInstance, liveBeeRunDeps, makeLiveBeeTraceLoaders, type BeeRunDeps } from './bee-instance';
import { makeBeeCollectAndDistill } from './bee-trace';
import type { GymJudgeRubric } from '../gym/judge-scoring';
import type { JudgeLlmCall } from '../gym/judge';
import type { InstanceBootSpec } from './instance-manifest';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';

const VARIANTS: TaskVariant[] = ['fix-injected-bug', 'build-spec', 'find-the-flaw', 'answer-from-colony-memory'];

/** Conservative per-call estimates for the pre-flight cost preamble + the pre-emptive cap check. */
const JUDGE_COST_ESTIMATE_USD = 0.5; // conservative fixed preflight estimate retained across migration
const SOLVER_COST_ESTIMATE_USD = 1.5; // conservative fixed preflight estimate retained across migration

// ───────────────────────────── pure, unit-tested pieces ─────────────────────────────

export interface Gen0Args {
  dryRun: boolean;
  capUsd: number;
  casesPerVariant: number;
  repeats: number;
  /** Restrict to a CSV subset of variants (e.g. a 1-bee smoke); null = all four. */
  variants: string[] | null;
  workspaceId: string | null;
  harness: string | null;
  timeoutMs: number;
  pollMs: number;
  /** Max relaunches of a bee that fails on a transient rate-limit/overload. */
  maxRateRetries: number;
  /** Floor backoff before a rate-limit relaunch (ms); the server's retry-after wins when larger. */
  rateBackoffMs: number;
}

/** Parse the CLI flags. Pure (no env/PG); `--workspace`/`--harness` default null → resolved by main. */
export function parseGen0Args(argv: string[]): Gen0Args {
  const get = (name: string): string | undefined => {
    const pre = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(pre));
    return hit ? hit.slice(pre.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const num = (v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt;
    const x = Number(v);
    return Number.isFinite(x) ? x : dflt;
  };
  return {
    dryRun: has('dry-run'),
    capUsd: num(get('cap'), 50),
    casesPerVariant: Math.max(1, Math.floor(num(get('cases'), 1))),
    repeats: Math.max(1, Math.floor(num(get('repeats'), 1))),
    variants: (() => {
      const raw = get('variants');
      if (!raw) return null;
      const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
      return list.length ? list : null;
    })(),
    workspaceId: get('workspace') ?? null,
    harness: get('harness') ?? null,
    timeoutMs: num(get('timeout-ms'), 600_000),
    pollMs: num(get('poll-ms'), 5_000),
    maxRateRetries: Math.max(0, Math.floor(num(get('rate-retries'), 3))),
    rateBackoffMs: num(get('rate-backoff-ms'), 30_000),
  };
}

export class SpendCapError extends Error {
  constructor(public readonly capUsd: number, public readonly attemptedUsd: number) {
    super(`spend cap $${capUsd} would be exceeded (attempted total $${attemptedUsd.toFixed(4)}) — battery aborted`);
    this.name = 'SpendCapError';
  }
}

export interface Spend {
  readonly usd: number;
  readonly costMeasured: boolean;
  /** Check the next estimated charge BEFORE invoking the provider. */
  assertCanSpend(estimateUsd: number): void;
  markUnmeasured(): void;
  /** Record a charge already incurred, then throw if the total exceeds the cap. */
  charge(amount: number, label: string): void;
}

/** A hard total-spend ceiling. `charge` throws the instant a charge would cross `capUsd`. */
export function makeSpend(capUsd: number): Spend {
  let usd = 0;
  let costMeasured = true;
  return {
    get usd() {
      return usd;
    },
    get costMeasured() { return costMeasured; },
    markUnmeasured() { costMeasured = false; },
    assertCanSpend(estimateUsd) {
      if (!costMeasured) throw new Error('judge spend is unmeasured — further paid calls refused');
      if (usd + estimateUsd > capUsd) throw new SpendCapError(capUsd, usd + estimateUsd);
    },
    charge(amount: number) {
      if (!Number.isFinite(amount)) {
        costMeasured = false;
        throw new Error('judge charge is unmeasured');
      }
      const next = usd + Math.max(0, amount);
      usd = next;
      if (next > capUsd) throw new SpendCapError(capUsd, next);
    },
  };
}

/** Existing gen-0 spend rail around the judge, including charged failures and timeouts. */
export function makeCappedJudge(llmCall: JudgeLlmCall, spend: Spend, timeoutMs = 240_000): JudgeLlmCall {
  return async (opts) => {
    try { spend.assertCanSpend(JUDGE_COST_ESTIMATE_USD); }
    catch (error) { throw Object.assign(error as Error, { costUsd: 0 }); } // provider was never invoked
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reply;
    try {
      reply = await Promise.race([
        llmCall(opts),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`judge llmCall timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      const cost = (error as { costUsd?: unknown } | null)?.costUsd;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        try { spend.charge(cost, 'judge'); } catch { /* paid receipt recorded; preserve the provider error and its charge */ }
      } else spend.markUnmeasured();
      throw error;
    } finally { if (timer) clearTimeout(timer); }
    if (!Number.isFinite(reply.costUsd) || reply.costUsd < 0) {
      spend.markUnmeasured();
      throw new Error('judge charge is unmeasured');
    }
    try { spend.charge(reply.costUsd, 'judge'); }
    catch (error) { throw Object.assign(error as Error, { costUsd: reply.costUsd }); }
    return reply;
  };
}

/** The committed gen-0 GYM judge rubric (canonical Sol xhigh, deterministic settings). */
export function buildRubric(): GymJudgeRubric {
  return {
    version: 'gen0-v1',
    model: LEARNING_MODEL_SPEC,
    temperature: 0,
    thinkingBudgetTokens: 32_000,
    weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
    dimensions: {
      d1: 'Intent & spec fidelity: did the work achieve the high-level INTENT',
      d2: 'Code quality: clarity, minimality, and absence of needless complexity',
      d3: 'Process correctness: did the bee behave well (sound steps, no flailing)',
    },
  } as unknown as GymJudgeRubric;
}

/** The instance manifest = a fingerprint of the SOLVER under test (commit + model) for re-runnability. */
export function buildManifest(workspaceId: string): InstanceBootSpec {
  let codeSha = 'unknown';
  try {
    codeSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    /* not a git checkout / git absent — manifest still records model + ts */
  }
  return {
    manifest: {
      instanceId: `gen0-${codeSha}-${workspaceId}`,
      workspaceId,
      codeSha,
      createdAt: new Date(),
    },
    instanceUrl: `solver://bee/${LEARNING_MODEL_SPEC}@${codeSha}`,
  };
}

// ───────────────────────────── the live orchestration ─────────────────────────────

/** A judge that skips the real LLM call (dry-run): zero score, zero spend — validates plumbing. */
const dryRunJudge: JudgeLlmCall = async () => ({
  text: JSON.stringify({ d1: 0, d2: 0, d3: 0, rationale: 'dry-run (judge skipped)' }),
  json: { d1: 0, d2: 0, d3: 0, rationale: 'dry-run (judge skipped)' },
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

/** Pre-flight: fail loud with a clear message if the beekeeper schema isn't applied on the live PG. */
async function assertSchema(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ ok: boolean }[]>`
    SELECT to_regclass('harness_shared.cup_keeper_runs') IS NOT NULL
       AND to_regclass('iq_battery_cases') IS NOT NULL AS ok`;
  if (!rows[0]?.ok) {
    throw new Error(
      'beekeeper/iq-battery schema missing on the live org PG — apply migrations 179 + 180 (renamed to cup_keeper_* in migration 555) before running the baseline.',
    );
  }
}

/**
 * Load the seeded corpus back from iq_battery_cases — the in-memory corpus data carries NO `id`
 * (it's assigned at seed time via generateStableCaseId), and the battery keys runs by case id. One
 * single-value-bound query per variant (bulletproof binds), capped at `casesPerVariant`.
 */
async function loadSeededCorpus(
  sql: postgres.Sql,
  variants: TaskVariant[],
  casesPerVariant: number,
): Promise<CorpusCase[]> {
  const corpus: CorpusCase[] = [];
  for (const variant of variants) {
    const rows = await sql<
      {
        id: string;
        variant: string;
        title: string;
        prompt: string;
        ground_truth: Record<string, unknown>;
        rubric: unknown;
        rotation_index: number;
      }[]
    >`
      SELECT id, variant, title, prompt, ground_truth, rubric, rotation_index
        FROM iq_battery_cases
       WHERE variant = ${variant}
       ORDER BY rotation_index
       LIMIT ${casesPerVariant}`;
    for (const r of rows) {
      // jsonb may arrive parsed (object) or raw (string) depending on the pool's parse config —
      // normalize so groundTruth/rubric are always objects.
      const asObj = (v: unknown, dflt: unknown): unknown => {
        if (v == null) return dflt;
        if (typeof v === 'string') {
          try {
            return JSON.parse(v);
          } catch {
            return dflt;
          }
        }
        return v;
      };
      corpus.push({
        id: r.id,
        variant: r.variant as TaskVariant,
        title: r.title,
        prompt: r.prompt,
        groundTruth: asObj(r.ground_truth, {}) as Record<string, unknown>,
        rubric: asObj(r.rubric, { dimensions: [] }) as Rubric,
        rotationIndex: r.rotation_index,
        createdAt: new Date(),
      });
    }
  }
  return corpus;
}

/** Transfer the freshly-recorded cup_keeper_scores → iq_battery_metrics (the recurrence + Tests-tab source). */
async function transferMetrics(sql: postgres.Sql, instanceId: string): Promise<number> {
  const runs = await sql<{ run_id: string; case_id: string; case_variant: string }[]>`
    SELECT run_id, case_id, case_variant FROM harness_shared.cup_keeper_runs WHERE instance_id = ${instanceId}`;
  let transferred = 0;
  for (const run of runs) {
    const scores = await sql<
      {
        success: boolean;
        tokens_per_task: number | null;
        time_to_green_secs: number | null;
        first_attempt_pass: boolean;
        recurrence: number;
        escalation: boolean;
        recall_hit: number;
      }[]
    >`
      SELECT success, tokens_per_task, time_to_green_secs, first_attempt_pass, recurrence, escalation, recall_hit
        FROM harness_shared.cup_keeper_scores WHERE run_id = ${run.run_id} LIMIT 1`;
    const s = scores[0];
    if (!s) continue;
    // Idempotent transfer (D-005): iq_battery_metrics.run_id is a UUID column but the beekeeper
    // run_id is TEXT, so we can't store the run_id directly. Derive a DETERMINISTIC uuid from it
    // (md5(text)::uuid) so a re-run of the same beekeeper run maps to the SAME metric row and
    // ON CONFLICT (run_id, case_id) overwrites it — instead of gen_random_uuid() appending a fresh
    // duplicate every transfer (the bug that accreted 19 dup rows over the dev runs).
    await sql`
      INSERT INTO iq_battery_metrics (
        run_id, case_id, variant, success, tokens_per_solved_task, time_to_green_secs,
        first_attempt_pass, recurrence, escalation, recall_hit
      ) VALUES (
        md5(${run.run_id})::uuid, ${run.case_id}, ${run.case_variant}, ${s.success}, ${s.tokens_per_task},
        ${s.time_to_green_secs}, ${s.first_attempt_pass}, ${s.recurrence}, ${s.escalation}, ${s.recall_hit}
      )
      ON CONFLICT (run_id, case_id) DO UPDATE SET
        variant = EXCLUDED.variant,
        success = EXCLUDED.success,
        tokens_per_solved_task = EXCLUDED.tokens_per_solved_task,
        time_to_green_secs = EXCLUDED.time_to_green_secs,
        first_attempt_pass = EXCLUDED.first_attempt_pass,
        recurrence = EXCLUDED.recurrence,
        escalation = EXCLUDED.escalation,
        recall_hit = EXCLUDED.recall_hit,
        collected_at = now()`;
    transferred += 1;
  }
  return transferred;
}

/** Build the live deps (cap-wrapped solver + judge) + config, run the battery, transfer + report. */
export async function runGen0Battery(args: Gen0Args): Promise<void> {
  const workspaceId = args.workspaceId ?? activeWorkspaceId();
  if (!args.harness) throw new Error('--harness=<slug> is required (the harness the solver bees spawn into)');

  // Pin solver bees to the canonical Sol xhigh model deterministically (bees have no committed ROLE_MODEL_DEFAULTS
  // floor), and ENABLE the shared AIMD governor so a bee 429 halves the effective concurrency cap
  // (the "lower cap" half of the hit-limit → lower-cap → relaunch loop).
  const priorEnv = {
    AGENT_MODELS: process.env.AGENT_MODELS,
    PAPERCUSP_AGENT_GOVERNOR: process.env.PAPERCUSP_AGENT_GOVERNOR,
    PAPERCUSP_AGENT_GOVERNOR_PG: process.env.PAPERCUSP_AGENT_GOVERNOR_PG,
    LLM_TEST_BACKEND: process.env.LLM_TEST_BACKEND,
  };
  try {
    const merged = { ...(priorEnv.AGENT_MODELS ? safeJson(priorEnv.AGENT_MODELS) : {}), bee: LEARNING_MODEL_SPEC };
    process.env.AGENT_MODELS = JSON.stringify(merged);
    process.env.PAPERCUSP_AGENT_GOVERNOR = '1';
    process.env.PAPERCUSP_AGENT_GOVERNOR_PG = '1';
    const { sql } = getOrgPg();
    await assertSchema(sql);
    await seedCorpus(sql);

    const variants = args.variants ? VARIANTS.filter((v) => args.variants!.includes(v)) : VARIANTS;
    if (variants.length === 0) {
      throw new Error(`--variants matched none of the corpus variants; valid: ${VARIANTS.join(', ')}`);
    }
    const corpus: CorpusCase[] = await loadSeededCorpus(sql, variants, args.casesPerVariant);
    if (corpus.length === 0) {
      throw new Error(`no seeded cases for variants [${variants.join(', ')}] — seedCorpus may have failed`);
    }
    const spec = buildManifest(workspaceId);
    const config: BeekeeperConfig = {
      instanceSpec: spec,
      corpus,
      repeats: args.repeats,
      rubric: buildRubric(),
      maxDistillChars: 5_000,
    };

    const totalRuns = corpus.length * args.repeats;
    const estMax = totalRuns * (SOLVER_COST_ESTIMATE_USD + (args.dryRun ? 0 : JUDGE_COST_ESTIMATE_USD));
    console.log('=== Apiary generation-0 IQ battery ===');
    console.log(`workspace=${workspaceId} harness=${args.harness} solver=${LEARNING_MODEL_SPEC}`);
    console.log(`corpus=${corpus.length} cases × ${args.repeats} repeat(s) = ${totalRuns} runs`);
    console.log(`mode=${args.dryRun ? 'DRY-RUN (judge skipped)' : 'LIVE'}  cap=$${args.capUsd}  est-max≈$${estMax.toFixed(2)}`);
    if (estMax > args.capUsd) {
      console.warn(`⚠ estimated max ($${estMax.toFixed(2)}) exceeds cap ($${args.capUsd}) — the cap will abort the run partway. Raise --cap or lower --cases/--repeats.`);
    }

    const spend = makeSpend(args.capUsd);

    // Real runInstance, wrapped to charge solver cost against the cap. A bee that fails on a
    // transient rate-limit / overload is RELAUNCHED (maxRateRetries) — the fleet AIMD governor
    // lowers concurrency in parallel (enabled via PAPERCUSP_AGENT_GOVERNOR below).
    const beeDeps: BeeRunDeps = {
      ...liveBeeRunDeps({ sql, workspaceId, harness: args.harness, planSlug: 'apiary-generation-0-battery-2026-06-08' }),
      onRateLimitRetry: ({ spawnId, attempt, backoffMs, cls }) =>
        console.log(
          `  ↻ rate-limit relaunch: bee=${spawnId} cls=${cls} attempt=${attempt + 1}/${args.maxRateRetries} backoff=${Math.round(backoffMs / 1000)}s`,
        ),
    };
    const baseRunInstance = makeBeeRunInstance(
      { timeoutMs: args.timeoutMs, pollMs: args.pollMs, maxRateRetries: args.maxRateRetries, rateBackoffMs: args.rateBackoffMs },
      beeDeps,
    );

    // Real canonical judge unless dry-run; wrapped to pre-check + charge judge cost.
    const realJudge: JudgeLlmCall = (await import('../llm-testing/llm-client')).llmCall;
    // Bound each judge llmCall so a stuck/slow judge (e.g. an unreachable backend's internal retry
    // loop) errors only THIS case (battery → status 'errored', continues) instead of wedging the
    // whole sequential run. Preserve the existing four-minute compatibility ceiling.
    const judge: JudgeLlmCall = args.dryRun
      ? dryRunJudge
      : makeCappedJudge(realJudge, spend);

    const metricsCollector = await createMetricsCollector(sql);
    const deps: BeekeeperDeps = {
      store: new BeekeeperStorePg(sql),
      runInstance: async (input) => {
        spend.assertCanSpend(SOLVER_COST_ESTIMATE_USD);
        const handle = await baseRunInstance(input);
        spend.charge(handle.costUsd, 'solver');
        return handle;
      },
      collectAndDistill: makeBeeCollectAndDistill(makeLiveBeeTraceLoaders(sql)),
      collectMetrics: (input) => metricsCollector.collectMetrics(input),
      llmCall: judge,
      newRunId: (caseId, repeat) => `gen0-${spec.manifest.codeSha}-${(caseId ?? 'nocase').slice(0, 12)}-r${repeat}`,
      now: () => Date.now(),
    };

    console.log('\nrunning battery…');
    const result = await runBeekeeperBattery(config, deps);

    const scored = result.outcomes.filter((o) => o.status === 'scored').length;
    const errored = result.outcomes.filter((o) => o.status === 'errored').length;
    const rateLimited = result.outcomes.filter((o) => o.status === 'rate_limited').length;
    console.log('\n=== results ===');
    console.log(`scored=${scored} errored=${errored} rate_limited=${rateLimited} of ${result.totalCases}`);
    console.log(`meanComposite=${result.meanComposite.toFixed(3)} rubricHash=${result.rubricHash} spend≈$${spend.usd.toFixed(4)} costMeasured=${spend.costMeasured && result.costMeasured !== false}`);
    for (const o of result.outcomes) {
      console.log(`  ${o.caseVariant} ${o.runId}: ${o.status}${o.error ? ` — ${o.error}` : ` composite=${o.composite.toFixed(2)}`}`);
    }

    const transferred = await transferMetrics(sql, spec.manifest.instanceId);
    console.log(`\ntransferred ${transferred} score(s) → iq_battery_metrics`);
    console.log(`\n✓ gen-0 ${args.dryRun ? 'dry-run' : 'baseline'} complete (spend $${spend.usd.toFixed(4)} / cap $${args.capUsd})`);
  } finally {
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  await runGen0Battery(parseGen0Args(process.argv.slice(2)));
}

// ESM main-module guard: run only when invoked directly, NEVER on import (so tests
// don't spend) and NEVER when bundled into the desktop sidecar (see isCliEntry / EI-650).
if (isCliEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    });
}
