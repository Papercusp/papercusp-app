/**
 * `runTransferDistill` — the SHARED transfer-harness orchestration
 * (flag → learning-governor → tick), the single source of truth both the
 * `system:transfer-distill` routine action AND the `transfer:distill` deterministic
 * blueprint step (deterministic-blueprints-migration-2026-06-13 P-121 / D-004) run.
 * Extracting it is what makes the migration provably behavior-neutral: the blueprint
 * path and the routine path call the SAME gated tick, same flag, same governor
 * preflight. Mirrors `lib/negative-space/mine.ts` + `lib/neologism/mine.ts`.
 *
 * IMPORTANT (D-009): transfer's student-transfer tests run a GOVERNED replay
 * battery (an `llmCall` via lib/replay, ledgered on `frontier:replay-harness`), NOT
 * a fleet agent spawn via spawnInvokeOnce — there is NO spawnInvokeOnce/coordSpawn
 * path anywhere in lib/transfer. So transfer as a blueprint is a DETERMINISTIC
 * pipeline (the llmCall lives inside the tick), not a `spawn-roles` hybrid, and this
 * migration is behavior-neutral, NOT a re-route of the replay onto the fleet launch
 * chokepoint (that would be a behavior change — see D-009).
 *
 * Gates (unchanged from transfer-distill-action.ts):
 *   - the `papercusp-transfer-harness` flag (default OFF — the frontier D-001 arming
 *     gate). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 *   - the learning-governor preflight (enforcement 'governor', FB-01). Refuse ⇒
 *     `{ ran: false, skipReason: 'governor-refused', governorReason }`.
 * Past both gates the tick runs (it never throws — runTransferTick swallows its own
 * errors into the result; the caller's durable wrapper is belt-and-braces).
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers each
 * pass their own seams — the action keeps its exported `setTransfer*` setters, the
 * op keeps its own, and there is still ONE orchestration.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { GovernorVerdict } from '../learning-governor/core';
import { transferGovernorGate } from './governor';
import { transferOptionsFromPayload } from './gate';
import { runTransferTick, type TransferTickDeps, type TransferTickResult } from './tick';

export interface TransferDistillDeps {
  /** Flag check (default: the live `papercusp-transfer-harness` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `transferGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Tick deps (default: the live PG/LLM/replay-backed `defaultTransferTickDeps`). */
  tickDeps?: TransferTickDeps | null;
}

export interface TransferDistillOutcome {
  /** True iff the tick actually ran (both gates passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off' | 'governor-refused';
  /** The governor refusal reason (when `skipReason === 'governor-refused'`). */
  governorReason?: string;
  /** The tick result (present iff `ran`). */
  result?: TransferTickResult;
}

/**
 * Run one transfer-distill cycle behind the flag + governor gates. The live tick
 * deps pull the PG pool + memory-backend graph lazily — neither may load (or throw)
 * before the flag + governor checks in a hermetic process — so the default is
 * imported only when both gates pass.
 */
export async function runTransferDistill(
  input: { workspaceId: string; installSlug: string; payload?: unknown },
  deps: TransferDistillDeps = {},
): Promise<TransferDistillOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.TRANSFER_HARNESS, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? transferGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const opts = transferOptionsFromPayload(input.payload);
  const tickDeps =
    deps.tickDeps ??
    (await import('./live-deps')).defaultTransferTickDeps(
      (await import('@papercusp/db-org')).getOrgPg().sql,
      input.workspaceId,
    );
  const result = await runTransferTick(input.workspaceId, tickDeps, opts);
  return { ran: true, result };
}
