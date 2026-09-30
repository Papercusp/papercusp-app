/**
 * `runPromptAblation` — the SHARED prompt-sedimentology orchestration
 * (flag → learning-governor → cap-bound cycle → spend ledger), the single source of
 * truth both the `system:prompt-ablation` routine action AND the `prompt:ablation`
 * deterministic blueprint step (deterministic-blueprints-migration-2026-06-13 P-121 /
 * D-004) run. Extracting it is what makes the migration provably behavior-neutral:
 * the blueprint path and the routine path call the SAME gated cycle, same flag, same
 * governor preflight, same per-cycle cap, same spend ledger.
 *
 * IMPORTANT (D-009): the cycle's two arms (baseline vs ablated) replay the
 * llm-testing `su` suite via the operator runner deps — direct `llmCall`s (SUT + sim
 * + judge), NOT fleet agent spawns via spawnInvokeOnce (there is NO spawnInvokeOnce
 * path in lib/ablation). So prompt-ablation as a blueprint is a DETERMINISTIC
 * pipeline (the llmCalls live inside the cycle), not a `spawn-roles` hybrid, and this
 * migration is behavior-neutral — see D-009.
 *
 * Gates (unchanged from prompt-ablation-action.ts):
 *   - the `papercusp-prompt-ablation` flag (default OFF — the frontier D-001 arming
 *     gate). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 *   - the learning-governor preflight (enforcement 'governor', FB-01). Refuse ⇒
 *     `{ ran: false, skipReason: 'governor-refused', governorReason }`.
 * Past both, the verdict's `remainingUsd` is the runner's HARD per-cycle cap. The
 * replay-sample leg + the live runner are wired by the caller (the boot-path glue
 * discipline — neither carries a production default in lib/ablation). Realized spend
 * is ledgered (accumulate) on loop `prompt-ablation`; ledgering is best-effort. The
 * cycle never throws upward — the caller's durable wrapper is belt-and-braces.
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers each
 * pass their own seams — the action keeps its exported `setPromptAblation*` setters,
 * the op keeps its own, and there is still ONE orchestration.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { GovernorVerdict } from '../learning-governor/core';
import { recordLearningSpend } from '../learning-governor/store';
import { promptAblationGovernorGate, PROMPT_ABLATION_LOOP_ID } from './governor';
import { makeAblationReplayLeg } from './replay-leg';
import {
  runAblationCycle,
  type AblationCycleConfig,
  type AblationCycleDeps,
  type AblationCycleResult,
} from './runner';

/** Run one shadow-ablation cycle (the cap-bound runner + the wired replay leg). */
export type PromptAblationCycleRunner = (
  cfg: AblationCycleConfig,
  deps: AblationCycleDeps,
) => Promise<AblationCycleResult>;

/** Ledger realized cycle spend on the prompt-ablation loop (accumulate). */
export type PromptAblationSpendRecorder = (input: {
  workspaceId: string;
  costUsd: number;
  runRef: string;
}) => Promise<void>;

export interface PromptAblationDeps {
  /** Flag check (default: the live `papercusp-prompt-ablation` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `promptAblationGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Cycle runner (default: the live `runAblationCycle`). */
  runner?: PromptAblationCycleRunner | null;
  /** Spend recorder (default: accumulate on loop `prompt-ablation` via recordLearningSpend). */
  recordSpend?: PromptAblationSpendRecorder | null;
}

export interface PromptAblationOutcome {
  /** True iff the cycle actually ran (both gates passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off' | 'governor-refused';
  /** The governor refusal reason (when `skipReason === 'governor-refused'`). */
  governorReason?: string;
  /** The cycle result (present iff `ran`). */
  result?: AblationCycleResult;
}

/** Map a routine payload_template onto the cycle config; the governor cap is the hard bound. */
function cycleConfigFromPayload(
  workspaceId: string,
  payload: unknown,
  capUsd: number | null,
): AblationCycleConfig {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const cfg: AblationCycleConfig = { workspaceId, maxCycleCostUsd: capUsd };
  if (Array.isArray(p.scenarioIds) && p.scenarioIds.every((s) => typeof s === 'string')) {
    cfg.scenarioIds = p.scenarioIds as string[];
  }
  if (typeof p.repeat === 'number' && Number.isInteger(p.repeat) && p.repeat >= 1 && p.repeat <= 5) {
    cfg.repeat = p.repeat;
  }
  if (typeof p.ruleKey === 'string' && p.ruleKey.trim()) cfg.ruleKey = p.ruleKey.trim();
  if (typeof p.ledgerWindowDays === 'number' && p.ledgerWindowDays > 0) {
    cfg.ledgerWindowDays = p.ledgerWindowDays;
  }
  return cfg;
}

/**
 * Run one shadow-ablation cycle behind the flag + governor gates, then ledger its
 * realized spend. The live runner drags the whole llm-testing/replay import chains
 * (module-scope PG codegen) — none of that loads before the gates in a hermetic
 * process — so the production runner/replay-leg/recorder are resolved lazily only
 * when both gates pass.
 */
export async function runPromptAblation(
  input: { workspaceId: string; installSlug: string; payload?: unknown },
  deps: PromptAblationDeps = {},
): Promise<PromptAblationOutcome> {
  const flag =
    deps.flag ??
    (async (slug: string) => {
      const { FLAGS } = await import('@papercusp/flags');
      const { getFlag } = await import('@papercusp/flags/server');
      return getFlag(FLAGS.PROMPT_ABLATION, `routine:${slug}`);
    });
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? promptAblationGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  // per-cycle verdicts report the cap itself in remainingUsd — the hard bound the
  // runner enforces mid-suite.
  const cfg = cycleConfigFromPayload(input.workspaceId, input.payload, verdict.remainingUsd);

  // The replay-sample leg (FB-06 substrate) is wired HERE — runAblationCycle's deps
  // carry no production default for it (the default-on-flag-glue-vs-hermetic-unit-
  // tests discipline). It rides the REPLAY loop's own flag + governor budget and
  // degrades to a recorded skip until the replay harness arms at P-001.
  const sql = getOrgPg().sql;
  const runner = deps.runner ?? runAblationCycle;
  const result = await runner(cfg, { sql, replayLeg: makeAblationReplayLeg({ sql }) });

  if (result.costUsd > 0) {
    const record =
      deps.recordSpend ??
      (async (rec: { workspaceId: string; costUsd: number; runRef: string }) => {
        await recordLearningSpend(getOrgPg().sql, {
          workspaceId: rec.workspaceId,
          loopId: PROMPT_ABLATION_LOOP_ID,
          costUsd: rec.costUsd,
          runRef: rec.runRef,
          note: 'shadow-ablation cycle',
          accumulate: true,
        });
      });
    try {
      await record({ workspaceId: input.workspaceId, costUsd: result.costUsd, runRef: result.runRowId });
    } catch (e) {
      // Best-effort: the evidence row is already persisted; the ledger hole is
      // logged, never fatal (the registrants.ts contract).
      console.warn(
        '[prompt-ablation] spend ledgering failed (cycle row stands):',
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { ran: true, result };
}
