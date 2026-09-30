/**
 * `runIqBatteryGen` — the SHARED IQ-battery cadence orchestration (build the live
 * cadence deps → `runBenchmarkCadenceTick`), the single source of truth both the
 * (retired) `system:iq-battery-gen` routine action AND the `iq-battery:gen`
 * deterministic blueprint step ran (deterministic-blueprints-migration-2026-06-13 /
 * D-004 — provably behavior-neutral: one gated tick, one orchestration).
 *
 * IQ-battery is a TRUE HYBRID (deterministic cadence-decide → governed fleet-bee
 * spawns → deterministic persist). Per D-013, its bee spawns ALREADY route through
 * `spawnAgentInHarness → cup:spawn → spawnInvokeOnce` (the ONE governed launch
 * chokepoint), so the migration keeps the spawn INTERNAL to the op (Option A — like
 * regret's replay), NOT a `spawn-roles` step: the bees take a corpus-case BRIEF, not
 * a harness role/persona, so spawn-roles' role-fan-out contract is the wrong fit.
 *
 * Gate (unchanged from benchmark-actions.ts): NOT a flag/learning-governor loop —
 * the cadence-tick REFUSES without an owner-set `payload.budgetUsd` (the gym's
 * unattended-spend precedent), REFUSES on an unknowable code SHA, and SKIPS when a
 * generation already exists at the current (workspace, SHA) — the durable-replay /
 * double-spend guard. The battery itself is the UNCHANGED gen-0 runner.
 *
 * Deps are injectable PARAMETERS (the op's test seam passes fakes — no PG/git/LLM).
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  runBenchmarkCadenceTick,
  type BenchmarkCadenceDeps,
  type BenchmarkCadenceOutcome,
  type BenchmarkRunFn,
} from './cadence-tick';

/**
 * Default: the live gen-0 runner, imported lazily so the routines boot path never
 * loads the bee/judge graph. `parseGen0Args([])` supplies the committed defaults
 * (timeouts, rate-retry policy); only the cadence-owned knobs are set.
 */
const defaultRunBattery: BenchmarkRunFn = async (req) => {
  const { runGen0Battery, parseGen0Args } = await import('./beekeeper-gen0-runner');
  await runGen0Battery({
    ...parseGen0Args([]),
    harness: req.harness,
    capUsd: req.capUsd,
    casesPerVariant: req.casesPerVariant,
    repeats: req.repeats,
    dryRun: req.dryRun,
  });
};

export interface IqBatteryGenDeps {
  /** Battery runner (default: the live gen-0 runner). */
  runBattery?: BenchmarkRunFn;
  /** Short solver code SHA (default: buildManifest's exact form — keeps dedupe byte-identical). */
  currentCodeSha?: () => string;
  /** Does a baseline instance already exist at (workspace, sha)? (default: live PG query.) */
  generationExists?: (codeSha: string) => Promise<boolean>;
  log?: (msg: string) => void;
  /**
   * Page the owner when the cadence tick can't produce a generation this cycle
   * (default: `notifyAttention`). EI-13049: a monthly cadence has ~30-day detection
   * latency by design if a `failed`/`refused` outcome pages no one — the next tick
   * is a month away, so this fires at the source instead of relying on a watchdog
   * to notice the trend went stale.
   */
  notifyOutcome?: (outcome: BenchmarkCadenceOutcome, ctx: { installSlug: string }) => Promise<void>;
}

export async function runIqBatteryGen(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: IqBatteryGenDeps = {},
): Promise<BenchmarkCadenceOutcome> {
  let currentCodeSha = deps.currentCodeSha;
  if (!currentCodeSha) {
    // buildManifest is the runner's own identity derivation — using it keeps the
    // dedupe SHA byte-identical to what the battery stamps on the instance.
    const { buildManifest } = await import('./beekeeper-gen0-runner');
    currentCodeSha = () => buildManifest(input.workspaceId).manifest.codeSha;
  }
  const generationExists =
    deps.generationExists ??
    (async (codeSha: string) => {
      const { sql } = getOrgPg();
      // EI-13049 dedupe trap: an instance row alone is NOT proof a generation was
      // measured — a runner that dies before its first `startRun` (crash, OOM, a
      // killed process) leaves a baseline instance row with ZERO cup_keeper_runs,
      // which then PERMANENTLY blocks retry at that SHA under the old
      // instance-existence-only check (the next code change is the only way out).
      // Require at least one linked run so an aborted/empty instance never
      // satisfies the gate.
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM harness_shared.cup_keeper_instances i
         WHERE i.workspace_id = ${input.workspaceId} AND i.code_sha = ${codeSha} AND i.genome_id IS NULL
           AND EXISTS (
             SELECT 1 FROM harness_shared.cup_keeper_runs r WHERE r.instance_id = i.instance_id
           )
         LIMIT 1`;
      return rows.length > 0;
    });

  const notifyOutcome =
    deps.notifyOutcome ??
    (async (outcome: BenchmarkCadenceOutcome, ctx: { installSlug: string }) => {
      // Best-effort — `notifyAttention` already swallows its own delivery errors;
      // this try/catch only guards the dynamic import itself.
      try {
        const { notifyAttention } = await import('../attention-notify');
        const body =
          outcome.action === 'failed'
            ? `IQ-battery generation ${outcome.codeSha} FAILED: ${outcome.error}. This is a monthly cadence — the next tick is ~30 days away, so this won't self-heal.`
            : outcome.action === 'refused'
              ? `IQ-battery cadence REFUSED to run: ${outcome.reason}. This is a monthly cadence — the next tick is ~30 days away, so this won't self-heal.`
              : '';
        await notifyAttention({
          kind: 'needs-human',
          title: `IQ-battery cadence ${outcome.action} — ${ctx.installSlug}`,
          body,
          harnessSlug: ctx.installSlug,
          importance: 'high',
          data: { source: 'iq-battery-gen', action: outcome.action },
        });
      } catch (e) {
        (deps.log ?? console.log)(`[iq-battery-gen] notifyOutcome failed: ${(e as Error)?.message ?? e}`);
      }
    });

  const cadenceDeps: BenchmarkCadenceDeps = {
    currentCodeSha,
    generationExists,
    runBattery: deps.runBattery ?? defaultRunBattery,
    log: deps.log ?? ((m) => console.log(m)),
  };
  const outcome = await runBenchmarkCadenceTick(cadenceDeps, {
    installSlug: input.installSlug,
    payload: input.payload ?? null,
  });
  // EI-13049 silent-failure fix: a monthly cadence can't rely on "wait for the next
  // tick" to self-heal from a failure/refusal — that's ~30 days away — so page here,
  // at the source, the moment the cycle produces neither a generation nor a clean skip.
  if (outcome.action === 'failed' || outcome.action === 'refused') {
    await notifyOutcome(outcome, { installSlug: input.installSlug });
  }
  return outcome;
}
