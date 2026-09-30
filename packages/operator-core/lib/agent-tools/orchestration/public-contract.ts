import { z } from 'zod';
import {
  capabilityRequirementSchema,
  recipeContractFailure,
  recipeBindingSchemaV1Schema,
  type RecipeContractFailure,
} from '../../recipe-contract';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';

export const orchestrationScriptSourceSchema = z
  .object({
    source: z.string().min(1).max(20_000),
    bindingSchema: recipeBindingSchemaV1Schema.optional(),
    requires: z.array(capabilityRequirementSchema).max(200).optional(),
    title: z.string().max(120).optional(),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const orchestrationRecipeSelectorSchema = z
  .object({
    id: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    // recipes:get / recipes:search own the proof schema and recipes:run repeats
    // its authoritative validation. The facade preserves this value unchanged.
    authority: z.unknown().optional(),
  })
  .strict();

export const orchestrationBindingsSchema = z
  .object({ values: z.record(z.string(), z.unknown()) })
  .strict();

export const orchestrationExecutionPolicySchema = z
  .object({
    // Accept the retired value at the transport edge so the handler can return
    // the public typed diagnostic instead of an opaque Zod rejection.
    mode: z.enum(['server', 'auto', 'client']).optional(),
    lifecycle: z.enum(['foreground', 'background']).optional(),
    /** Explicit opt-in to the DBOS-backed per-tool-step execution path. */
    durability: z.literal('durable').optional(),
  })
  .strict();

export const durableOrchestrationRunSchema = z
  .object({ workflowId: z.string().min(1).max(512) })
  .strict();

export const durableOrchestrationControlSchema = z.discriminatedUnion('action', [
  z.object({
    workflowId: z.string().min(1).max(512),
    action: z.literal('cancel'),
  }).strict(),
  z.object({
    workflowId: z.string().min(1).max(512),
    action: z.literal('signal'),
    topic: z.string().min(1).max(120),
    message: z.unknown().optional(),
    idempotencyKey: z.string().min(1).max(512).optional(),
  }).strict(),
]);

export const orchestrationCapturePolicySchema = z
  .object({
    mode: z.enum(['auto', 'never']).optional(),
    title: z.string().max(120).optional(),
    description: z.string().max(2_000).optional(),
    tags: z.array(z.string().min(1).max(80)).max(50).optional(),
  })
  .strict();

export const orchestrationSourceArgsSchema = z
  .object({
    script: orchestrationScriptSourceSchema.optional(),
    recipe: orchestrationRecipeSelectorSchema.optional(),
    /** Status inspection for an already-admitted durable run. */
    durableRun: durableOrchestrationRunSchema.optional(),
    /** Cancel or signal an already-admitted durable run. */
    durableControl: durableOrchestrationControlSchema.optional(),
    bindings: orchestrationBindingsSchema.optional(),
    execution: orchestrationExecutionPolicySchema.optional(),
    capture: orchestrationCapturePolicySchema.optional(),
    timeoutSec: z.number().int().min(1).max(3_600).optional(),
    /** Existing canonical work item this run belongs to. It is linked only; no item is created. */
    workItemId: z.string().min(1).max(120).optional(),
    /** Compatibility preview carried through code:run / recipes:run. */
    dryRun: z.boolean().optional(),
    /** Exact revision + binding pin returned by orchestrate:inspect. Optional
     * for existing foreground callers and required for durable execution. */
    inspectionPin: z.object({
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      bindingsSha256: z.string().regex(/^[0-9a-f]{64}$/),
      recipeRevision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).strict().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (
      args.timeoutSec !== undefined &&
      args.timeoutSec > FOREGROUND_TIMEOUT_CEILING_MS / 1000 &&
      args.execution?.durability !== 'durable'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeoutSec'],
        message: `foreground timeout cannot exceed ${FOREGROUND_TIMEOUT_CEILING_MS / 1000} seconds`,
      });
    }
  });

export type OrchestrationScriptSource = z.infer<typeof orchestrationScriptSourceSchema>;
export type OrchestrationRecipeSelector = z.infer<typeof orchestrationRecipeSelectorSchema>;
export type OrchestrationBindings = z.infer<typeof orchestrationBindingsSchema>;
export type DurableOrchestrationRun = z.infer<typeof durableOrchestrationRunSchema>;
export type DurableOrchestrationControl = z.infer<typeof durableOrchestrationControlSchema>;
export type OrchestrationSourceArgs = z.infer<typeof orchestrationSourceArgsSchema>;

/** Transport-valid requests can still be rejected before any nested dispatch. */
export function orchestrationPolicyFailure(
  args: OrchestrationSourceArgs,
  operation: 'inspect' | 'run' = 'run',
): RecipeContractFailure | null {
  const sourceCount = Number(Boolean(args.script)) + Number(Boolean(args.recipe));
  const selectorCount = sourceCount + Number(Boolean(args.durableRun)) + Number(Boolean(args.durableControl));
  if (selectorCount !== 1) {
    return recipeContractFailure(
      selectorCount > 1 ? 'ambiguous_source' : 'source_missing',
      selectorCount > 1
        ? 'pass exactly one of script, recipe, durableRun or durableControl'
        : `pass ${operation === 'inspect' ? 'script, recipe or durableRun' : 'script, recipe or durableControl'}`,
      { path: selectorCount > 1 ? 'script|recipe|durableRun|durableControl' : 'script' },
    );
  }
  if (args.durableRun) {
    return operation === 'inspect'
      ? null
      : recipeContractFailure(
          'execution_mode_unavailable',
          'durableRun status is read through orchestrate:inspect',
          { path: 'durableRun' },
        );
  }
  if (args.durableControl) {
    return operation === 'run'
      ? null
      : recipeContractFailure(
          'execution_mode_unavailable',
          'durableControl is sent through orchestrate:run',
          { path: 'durableControl' },
        );
  }
  if (args.execution?.mode === 'client') {
    return recipeContractFailure(
      'execution_mode_unavailable',
      'client execution is not an orchestration backend; use server mode or call a native compatibility door directly',
      { path: 'execution.mode' },
    );
  }
  const durable = args.execution?.durability === 'durable';
  const background = args.execution?.lifecycle === 'background';
  if (background && !durable) {
    return recipeContractFailure(
      'lifecycle_unavailable',
      'background orchestration requires execution.durability:"durable"',
      { path: 'execution.lifecycle' },
    );
  }
  if (durable && !background) {
    return recipeContractFailure(
      'lifecycle_unavailable',
      'durable orchestration requires execution.lifecycle:"background"',
      { path: 'execution.lifecycle' },
    );
  }
  if (durable && !args.script) {
    return recipeContractFailure(
      'durable_replay_unsafe',
      'durable execution currently accepts a pinned fresh script; saved recipes remain foreground-only',
      { path: 'script' },
    );
  }
  if (durable && operation === 'run' && !args.inspectionPin) {
    return recipeContractFailure(
      'durable_replay_unsafe',
      'durable execution requires the exact inspectionPin returned by orchestrate:inspect',
      { path: 'inspectionPin' },
    );
  }
  if (durable && args.dryRun === true) {
    return recipeContractFailure(
      'execution_mode_unavailable',
      'dryRun is a foreground preview and cannot admit a durable background run',
      { path: 'dryRun' },
    );
  }
  if (durable && args.capture) {
    return recipeContractFailure(
      'execution_mode_unavailable',
      'capture policy is foreground-only; durable runs execute the exact pinned script without creating a recipe',
      { path: 'capture' },
    );
  }
  return null;
}
