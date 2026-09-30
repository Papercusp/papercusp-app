/**
 * cadence-tick.ts — pure decision core for the monthly gen-N IQ-battery routine
 * (self-improvement-consume-edges-2026-06-12 P-033 / B-12).
 *
 * The benchmark's pulse: per cron tick (monthly), decide whether to run ONE
 * budget-capped IQ-battery generation through the gen-0 beekeeper runner
 * (`beekeeper-gen0-runner.ts` — whose judge rides `@papercusp/eval-battery`,
 * THE engine per the ratified 06-09 reconciliation). All deps are injected so
 * the gates are unit-testable without PG / git / LLM spend.
 *
 * Gates, in order (all hard):
 *   1. REFUSE without an owner-set budget — the gym's safety precedent
 *      (`lib/gym/autoloop-tick.ts`: a null budget is INELIGIBLE; unattended
 *      spend requires an explicit cap). The budget is the routine's
 *      `payload_template.budgetUsd`, owner-set via the seeder or the routines
 *      admin — never defaulted here.
 *   2. REFUSE when the solver code SHA is unknowable (no git): a generation
 *      without an identity can neither be trended nor deduped.
 *   3. SKIP when a generation already exists at the current (workspace, SHA).
 *      Generation identity IS the code SHA — mig 217's partial unique index
 *      pins one baseline instance per (workspace_id, code_sha) WHERE genome_id
 *      IS NULL, so unchanged code = no new generation to measure. This is also
 *      the durable-step-replay / double-fire spend guard.
 *   4. A failed battery is RETURNED as an outcome, never thrown — the handler
 *      runs as one durable step, and a thrown step invites an engine replay
 *      (= a second paid run). Mirrors `gym-actions.ts`.
 */

/** Battery shape defaults for a cadence run (gen-0 precedent: 1 case × 4 variants). */
export const CADENCE_DEFAULT_CASES_PER_VARIANT = 1;
export const CADENCE_DEFAULT_REPEATS = 1;

export interface BenchmarkRunRequest {
  /** Harness the solver bees spawn into (the routine's install_slug). */
  harness: string;
  /** Hard total-spend ceiling — the owner-set budget, enforced by makeSpend. */
  capUsd: number;
  casesPerVariant: number;
  repeats: number;
  /** Plumbing-only mode: administer + persist, skip the judge ($0 judge spend). */
  dryRun: boolean;
}

export type BenchmarkRunFn = (req: BenchmarkRunRequest) => Promise<void>;

export interface BenchmarkCadenceDeps {
  /** Short solver code SHA — the generation identity (buildManifest's exact form). */
  currentCodeSha(): string;
  /** Does a baseline instance already exist at (workspace, sha)? (genome_id IS NULL rows.) */
  generationExists(codeSha: string): Promise<boolean>;
  /** Run one battery generation (default: runGen0Battery). */
  runBattery: BenchmarkRunFn;
  log(msg: string): void;
}

export interface BenchmarkCadenceInput {
  installSlug: string;
  /** The routine's payload_template — `budgetUsd` (required), `casesPerVariant`, `repeats`, `dryRun`. */
  payload: Record<string, unknown> | null;
}

export type BenchmarkCadenceOutcome =
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

export async function runBenchmarkCadenceTick(
  deps: BenchmarkCadenceDeps,
  input: BenchmarkCadenceInput,
): Promise<BenchmarkCadenceOutcome> {
  const budget = ownerBudgetUsd(input.payload);
  if (budget == null) {
    const reason =
      'REFUSING unattended IQ-battery run: no owner-set budgetUsd in the routine payload_template ' +
      '(gym precedent — unattended spend requires an explicit cap). Set it via the seeder (--budget) or the routines admin.';
    deps.log(`[iq-battery-gen] ${reason}`);
    return { action: 'refused', reason };
  }

  const codeSha = deps.currentCodeSha();
  if (!codeSha || codeSha === 'unknown') {
    const reason = 'REFUSING: solver code SHA unknowable (no git?) — a generation needs an identity to trend/dedupe.';
    deps.log(`[iq-battery-gen] ${reason}`);
    return { action: 'refused', reason };
  }

  if (await deps.generationExists(codeSha)) {
    const reason = `generation at ${codeSha} already measured — unchanged code (or a replayed tick); nothing new to benchmark`;
    deps.log(`[iq-battery-gen] skip — ${reason}`);
    return { action: 'skipped', codeSha, reason };
  }

  const req: BenchmarkRunRequest = {
    harness: input.installSlug,
    capUsd: budget,
    casesPerVariant: intAtLeast1(input.payload?.casesPerVariant, CADENCE_DEFAULT_CASES_PER_VARIANT),
    repeats: intAtLeast1(input.payload?.repeats, CADENCE_DEFAULT_REPEATS),
    dryRun: input.payload?.dryRun === true,
  };
  deps.log(
    `[iq-battery-gen] running generation ${codeSha} — harness=${req.harness} cap=$${req.capUsd} ` +
      `cases=${req.casesPerVariant} repeats=${req.repeats}${req.dryRun ? ' DRY-RUN' : ''}`,
  );
  try {
    await deps.runBattery(req);
    deps.log(`[iq-battery-gen] generation ${codeSha} complete (cap $${req.capUsd})`);
    return { action: 'ran', codeSha, capUsd: req.capUsd };
  } catch (err) {
    // Logged, NOT thrown — a thrown durable step replays the handler (= double spend).
    const error = err instanceof Error ? err.message : String(err);
    deps.log(`[iq-battery-gen] generation ${codeSha} FAILED: ${error}`);
    return { action: 'failed', codeSha, error };
  }
}
