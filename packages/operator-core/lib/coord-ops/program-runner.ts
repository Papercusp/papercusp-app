/**
 * `runProgramCore` — the **adapter** that maps a papercusp `Blueprint` onto the
 * generic `@papercusp/step-program` runner (`coordination-ops-as-blueprint-
 * primitives-2026-06-04` P-005 / D-005; extracted to the generic lib by
 * generalize-libs-to-generic-2026-06-05 #5). The pure step-program interpreter +
 * runner now live in `@papercusp/step-program`; this thin layer supplies the
 * papercusp-specific bindings:
 *
 *   - **scope** — `buildScope` knob-defaults the payload + injects work_item/caller
 *     (the coord-op domain shape) into the initial scope.
 *   - **the op-registry seam** — `inlineRunOp` resolves `call.op` against the
 *     coord-op registry, validates the interpolated args against the op's Zod
 *     `argsSchema`, and runs it. The durable DBOS path injects its own `runOp`
 *     (each op a checkpointed step). This is the "inject the op registry" seam.
 *   - **the `resolve` convention** — a gate op named `resolve` counts as a
 *     decisive resolution (the generic runner otherwise keys off
 *     `gateResult.resolved === true`).
 *   - **recursion** — `maxDepth` from `bp.recursion`, `depth` from `ctx.depth`.
 *
 * Stamping `ctx.blueprintId = bp.id` lets `orchestrator:spawn-roles` resolve a
 * spawned program role's prompt from the OWNING blueprint's prompts dir
 * (forkable-blueprint design, D-006). Recursion-safe: every program run owns a
 * fresh ctx, so each stamps its own bp.id without clobbering a parent's.
 */
import type { Blueprint } from '@papercusp/orchestrator/blueprint';
import {
  runProgram,
  type Scope,
  type OpCall,
  type RunOp as GenericRunOp,
  type ProgramOutcome,
} from '@papercusp/step-program';
import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import type { CoordOpCtx } from './types.js';
import { requireCoordOp } from './registry.js';

export type { OpCall, ProgramOutcome };

/** A coord-op invocation runner — the generic `RunOp` bound to a `CoordOpCtx`. */
export type RunOp = GenericRunOp<CoordOpCtx>;

export interface RunProgramArgs {
  blueprint: Blueprint;
  payload: Record<string, unknown>;
  ctx: CoordOpCtx;
  runOp: RunOp;
}

/** Knob keys that default a program's payload when the caller omits them. */
const PAYLOAD_DEFAULT_KEYS = ['quorum', 'max_voters', 'timeout_s', 'budget', 'lenses', 'ask_timeout_s'] as const;

/** Build the initial scope: payload (knob-defaulted) + work_item + caller + knobs. */
export function buildScope(bp: Blueprint, payload: Record<string, unknown>, ctx: CoordOpCtx): Scope {
  const knobs = (bp.knobs ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...payload };
  for (const k of PAYLOAD_DEFAULT_KEYS) {
    if (merged[k] === undefined && knobs[k] !== undefined) merged[k] = knobs[k];
  }
  return {
    payload: merged,
    knobs,
    work_item: { id: ctx.workItemId ?? null },
    caller: ctx.callerId ?? ctx.identity.ownerId,
  };
}

/**
 * Run a program-mode blueprint to its gate decision via the generic step-program
 * runner. Throws only on a structural problem (a non-program spine, an
 * unregistered op); a gate that doesn't resolve returns a non-resolved outcome.
 */
export async function runProgramCore(input: RunProgramArgs): Promise<ProgramOutcome> {
  const { blueprint: bp, payload, ctx, runOp } = input;

  // Stamp which blueprint is executing so ops that need it can read ctx.blueprintId
  // — chiefly `orchestrator:spawn-roles`, which threads it to the spawn so a program
  // role (`voter`/`advocate`) resolves its prompt from this blueprint's prompts dir.
  ctx.blueprintId = bp.id;

  const scope = buildScope(bp, payload, ctx);
  const hasGate = (bp.spine.gate?.length ?? 0) > 0;

  const outcome = await runProgram<CoordOpCtx>({
    program: { steps: bp.spine.steps ?? [], gate: bp.spine.gate },
    scope,
    ctx,
    runOp,
    // `depth` is THIS program's recursion level; `maxDepth` is the deepest level
    // allowed to run (`?? 1` matches the RecursionSchema default for a raw
    // blueprint; a schema-parsed one always carries recursion.maxDepth).
    depth: ctx.depth,
    maxDepth: bp.recursion?.maxDepth ?? 1,
    // The coord convention: a `resolve` gate op is a decisive resolution.
    isResolved: (op, res) => op === 'resolve' || res?.resolved === true,
    // The condition language (adopt-event-rules-engines D-002): a spine `when` is
    // the canonical `@papercusp/rules` `MatchMap`/`DataCondition`, evaluated against
    // the bound scope — the SAME matcher the event-reaction rules + the P1 adoptions
    // use. Replaces the legacy step-program string-expr DSL for the spine.
    evalWhen: (when, scope) => evaluateDataCondition(when as DataCondition, scope),
    log: ctx.log,
    programId: bp.id,
  });

  // A DETERMINISTIC pipeline (no gate — deterministic-blueprints-migration-2026-06-13
  // P-010) "resolves" by running every step. The generic runner reports an absent
  // gate as `no-gate-match` / unresolved (correct for a decision program that fell
  // through), so map a completed gateless run to a clean terminal `done`.
  if (!hasGate && outcome.outcome === 'no-gate-match') {
    return { ...outcome, outcome: 'done', resolved: true };
  }
  return outcome;
}

/**
 * The inline `runOp`: validate the interpolated args against the op's schema and
 * call `run` directly (no DBOS step). Used for nested programs (recursion) + unit
 * tests. The Zod parse coerces the interpolated args (e.g. a `{{ payload.quorum }}`
 * that interpolated to the number 3 is validated as a number).
 */
export const inlineRunOp: RunOp = async (call, ctx) => {
  const op = requireCoordOp(call.op);
  const parsed = op.argsSchema.parse(call.args);
  return op.run(parsed, ctx);
};
