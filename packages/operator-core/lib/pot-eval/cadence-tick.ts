/**
 * cadence-tick.ts — pure decision core for the Hive-evaluation battery cadence (HE-07, P-050),
 * the SIBLING of the IQ-battery's monthly gen-N tick (lib/iq-battery/cadence-tick.ts).
 *
 * The Hive-eval battery's pulse: per cron tick (monthly), decide whether to run ONE budget-capped
 * SCORED generation of the seeded scenario corpus against the current code, so the Hive's
 * good/efficient/fast composite becomes a TREND (the acceptance yardstick for the queen plans, D-007).
 *
 * Gates, in order (all hard — identical discipline to the IQ-battery, the gym precedent):
 *   1. REFUSE without an owner-set `payload_template.budgetUsd` — a whole-Hive generation is REAL
 *      LLM spend (the owner-gated P-051 cost); unattended spend requires an explicit cap, never a
 *      default.
 *   2. REFUSE when the code SHA is unknowable (no git): a generation without an identity can't be
 *      trended or deduped.
 *   3. SKIP when a generation already exists at the current (workspace, SHA) — generation identity
 *      IS the code SHA (the hive_eval_instances UNIQUE(workspace_id, code_sha, genome_id)); unchanged
 *      code = nothing new to measure. Also the durable-step-replay double-spend guard.
 *   4. A failed generation is RETURNED, never thrown — the handler is one durable step, and a thrown
 *      step invites an engine replay (= a second paid generation). Mirrors the IQ-battery / gym tick.
 *
 * All deps are injected so the gates are unit-testable without PG / git / LLM spend.
 */

/** Cadence defaults: the full seeded corpus, 1 repeat, a modest bee cap (the live cost knob). */
export const HIVE_EVAL_CADENCE_DEFAULT_REPEATS = 1;
export const HIVE_EVAL_CADENCE_DEFAULT_BEE_CAP = 4;

export interface HiveEvalRunRequest {
  /** Harness the throwaway hives + solver bees spawn under (the routine's install_slug). */
  harness: string;
  /** Hard total-spend ceiling — the owner-set budget. */
  capUsd: number;
  /** Scenario ids to run; empty/omitted = the whole seeded corpus. */
  scenarioIds?: readonly string[];
  repeats: number;
  beeCap: number;
  /** Plumbing-only mode: run + record + score, skip the optional LLM judge ($0 judge spend). */
  dryRun: boolean;
}

export type HiveEvalRunFn = (req: HiveEvalRunRequest) => Promise<void>;

export interface HiveEvalCadenceDeps {
  /** Short solver code SHA — the generation identity (buildManifest's exact form). */
  currentCodeSha(): string;
  /** Does a baseline instance already exist at (workspace, sha)? (genome_id IS NULL rows.) */
  generationExists(codeSha: string): Promise<boolean>;
  /** Run + score one whole generation (default: the live runHiveEvalGeneration over P-051 ports). */
  runBattery: HiveEvalRunFn;
  log(msg: string): void;
}

export interface HiveEvalCadenceInput {
  installSlug: string;
  /** The routine's payload_template — `budgetUsd` (required), `scenarioIds`, `repeats`, `beeCap`, `dryRun`. */
  payload: Record<string, unknown> | null;
}

export type HiveEvalCadenceOutcome =
  | { action: 'refused'; reason: string }
  | { action: 'skipped'; codeSha: string; reason: string }
  | { action: 'ran'; codeSha: string; capUsd: number }
  | { action: 'failed'; codeSha: string; error: string };

/** Owner-set budget from the payload: a finite number > 0, or null (= refuse). */
export function ownerBudgetUsd(payload: Record<string, unknown> | null): number | null {
  const raw = payload?.budgetUsd;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

const intAtLeast1 = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : dflt;

function scenarioIdsOf(payload: Record<string, unknown> | null): readonly string[] | undefined {
  const raw = payload?.scenarioIds;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return ids.length > 0 ? ids : undefined;
}

export async function runHiveEvalCadenceTick(
  deps: HiveEvalCadenceDeps,
  input: HiveEvalCadenceInput,
): Promise<HiveEvalCadenceOutcome> {
  const budget = ownerBudgetUsd(input.payload);
  if (budget == null) {
    const reason =
      'REFUSING unattended Hive-eval generation: no owner-set budgetUsd in the routine payload_template ' +
      '(a whole-Hive run is real LLM spend — P-051). Set it via the seeder (--budget) or the routines admin.';
    deps.log(`[pot-eval-battery] ${reason}`);
    return { action: 'refused', reason };
  }

  const codeSha = deps.currentCodeSha();
  if (!codeSha || codeSha === 'unknown') {
    const reason = 'REFUSING: code SHA unknowable (no git?) — a generation needs an identity to trend/dedupe.';
    deps.log(`[pot-eval-battery] ${reason}`);
    return { action: 'refused', reason };
  }

  if (await deps.generationExists(codeSha)) {
    const reason = `generation at ${codeSha} already measured — unchanged code (or a replayed tick); nothing new to benchmark`;
    deps.log(`[pot-eval-battery] skip — ${reason}`);
    return { action: 'skipped', codeSha, reason };
  }

  const req: HiveEvalRunRequest = {
    harness: input.installSlug,
    capUsd: budget,
    scenarioIds: scenarioIdsOf(input.payload),
    repeats: intAtLeast1(input.payload?.repeats, HIVE_EVAL_CADENCE_DEFAULT_REPEATS),
    beeCap: intAtLeast1(input.payload?.beeCap, HIVE_EVAL_CADENCE_DEFAULT_BEE_CAP),
    dryRun: input.payload?.dryRun === true,
  };
  deps.log(
    `[pot-eval-battery] running generation ${codeSha} — harness=${req.harness} cap=$${req.capUsd} ` +
      `repeats=${req.repeats} beeCap=${req.beeCap}${req.scenarioIds ? ` scenarios=${req.scenarioIds.join(',')}` : ' (full corpus)'}` +
      `${req.dryRun ? ' DRY-RUN' : ''}`,
  );
  try {
    await deps.runBattery(req);
    deps.log(`[pot-eval-battery] generation ${codeSha} complete (cap $${req.capUsd})`);
    return { action: 'ran', codeSha, capUsd: req.capUsd };
  } catch (err) {
    // Logged, NOT thrown — a thrown durable step replays the handler (= double spend).
    const error = err instanceof Error ? err.message : String(err);
    deps.log(`[pot-eval-battery] generation ${codeSha} FAILED: ${error}`);
    return { action: 'failed', codeSha, error };
  }
}
