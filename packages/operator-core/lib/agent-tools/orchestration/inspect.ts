import { AGENT_ROLES, defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { durableRuntimeTools, type ToolResult } from '@papercusp/tooldef';
import type { ProjectedTool } from '@papercusp/tooldef';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import type { CapabilityManifestV1, RecipeBindingSchemaV1 } from '../../recipe-contract';
import { inspectScriptContract } from './contract-preflight';
import type { RefusalContract } from '../../capability-envelope/identity-refusal-contract';
import { inspectDurability } from './durability-inspection';
import { getDurableOrchestrationStatus } from '../../dbos/durable-orchestration-workflow';
import {
  orchestrationPolicyFailure,
  orchestrationSourceArgsSchema,
  type OrchestrationScriptSource,
  type OrchestrationSourceArgs,
} from './public-contract';
import {
  savedRecipeAdapterFor,
  type SavedRecipeAdapter,
  type SavedRecipeSelector,
} from './saved-recipe-adapter';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const dataResult = (payload: unknown): ToolResult => ({ data: payload }) as unknown as ToolResult;

export async function inspectOrchestration(
  args: OrchestrationSourceArgs,
  ctx: UnifiedToolContext,
  deps: {
    recipes?: SavedRecipeAdapter;
    inspectScript?: typeof inspectScriptContract;
    projectedTools?: readonly ProjectedTool[];
    durableStatus?: typeof getDurableOrchestrationStatus;
  } = {},
): Promise<ToolResult> {
  const policyFailure = orchestrationPolicyFailure(args, 'inspect');
  if (policyFailure) return dataResult(policyFailure);
  if (args.durableRun) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId || !args.durableRun.workflowId.startsWith(`orchestrate-durable:${workspaceId}:`)) {
      return dataResult({
        ok: false,
        phase: 'preflight',
        executed: false,
        error: {
          code: 'capability_denied',
          message: 'durable run does not belong to the current workspace',
          path: 'durableRun.workflowId',
          refusal: {
            observed: { workflowId: args.durableRun.workflowId, workspaceId: workspaceId ?? null },
            liftsWhen:
              `durableRun.workflowId starts with 'orchestrate-durable:<current workspaceId>:' and the session has a ` +
              'workspace. Pass the workflowId of a run started in THIS workspace, or call from a session scoped to the ' +
              'workspace that owns the run (a run is never inspectable across workspaces)',
            whoCanMakeItTrue: ['self', 'owner'],
          } satisfies RefusalContract,
        },
      });
    }
    const status = await (deps.durableStatus ?? getDurableOrchestrationStatus)(args.durableRun.workflowId);
    return status
      ? dataResult({ ok: true, durableRun: status })
      : dataResult({
          ok: false,
          phase: 'preflight',
          executed: false,
          error: {
            code: 'durable_run_not_found',
            message: 'no DBOS durable orchestration run exists for this workflowId',
            path: 'durableRun.workflowId',
          },
        });
  }
  const adapter = deps.recipes ?? savedRecipeAdapterFor(ctx);
  const inspectScript = deps.inspectScript ?? inspectScriptContract;

  let script = args.script as OrchestrationScriptSource;
  let manifest: CapabilityManifestV1 | undefined;
  let continuation: Record<string, unknown> | undefined;
  let source: Record<string, unknown> = { kind: 'script', script };

  if (args.recipe) {
    const inspected = await adapter.inspect(args.recipe as SavedRecipeSelector);
    if (!inspected.ok) return dataResult(inspected);
    const recipe = inspected.recipe;
    const recipeSource = recipe.script;
    if (typeof recipeSource !== 'string' || recipeSource.length === 0) {
      return dataResult({
        ok: false,
        phase: 'preflight',
        executed: false,
        error: { code: 'recipe_schema_stale', message: 'saved recipe has no executable script', path: 'recipe.script' },
      });
    }
    script = {
      source: recipeSource,
      ...(typeof recipe.title === 'string' ? { title: recipe.title } : {}),
      ...(typeof recipe.description === 'string' ? { description: recipe.description } : {}),
      ...(recipe.bindingSchema ? { bindingSchema: recipe.bindingSchema as RecipeBindingSchemaV1 } : {}),
    };
    manifest = recipe.capabilityManifest as CapabilityManifestV1 | undefined;
    continuation = { recipe: inspected.continuation };
    source = { kind: 'recipe', recipe: inspected.recipe, continuation };
  }

  const checked = await inspectScript({
    script,
    bindings: args.bindings,
    lifecycle: args.execution?.lifecycle,
    ...(manifest ? { manifest } : {}),
    ctx,
  });
  if (!checked.ok) return dataResult(checked);
  const durable = args.execution?.durability === 'durable';
  const projectedTools = deps.projectedTools ?? listAllProjectedTools();
  const durability = await inspectDurability({
    script: script.source,
    bindings: checked.contract.bindings,
    calls: checked.staticCalls,
    tools: durable ? [...projectedTools, ...durableRuntimeTools()] : projectedTools,
    ...(args.recipe && typeof continuation?.recipe === 'object' && continuation.recipe !== null
      ? { recipeRevision: (continuation.recipe as { revision: string }).revision }
      : {}),
  });

  return dataResult({
    ok: true,
    source,
    normalized: {
      script,
      ...(continuation ?? {}),
      bindingSchema: checked.contract.bindingSchema ?? null,
      bindings: {
        values: checked.contract.bindings.inputs,
        secretRefs: Object.keys(checked.contract.bindings.secretRefs),
        resourceRefs: checked.contract.bindings.resourceRefs,
      },
      staticToolCalls: checked.staticCalls,
      toolsUsed: checked.staticToolNames,
      requirements: checked.contract.requirements,
      manifest: checked.manifest,
      replay: checked.contract.replay,
      durability,
      portability: checked.contract.portability,
      execution: {
        requestedMode: args.execution?.mode ?? 'server',
        mode: 'server',
        deprecatedAuto: args.execution?.mode === 'auto',
        lifecycle: args.execution?.lifecycle ?? 'foreground',
        ...(durable ? { durability: 'durable' } : {}),
        timeoutSec: args.timeoutSec ?? (durable ? 3_600 : 30),
      },
      capture: {
        mode: args.recipe ? 'reuse' : (args.capture?.mode ?? 'auto'),
      },
    },
    diagnostics: args.execution?.mode === 'auto'
      ? [{ code: 'execution_mode_deprecated', message: 'execution.mode:auto is an alias for server' }]
      : [],
  });
}

const orchestrateInspectTool = defineTool({
  name: 'orchestrate:inspect',
  description:
    'Side-effect-free normalization and current-caller preflight for one fresh script or saved recipe, or status inspection for one durable run. Revalidates bindings, recipe revision/authority, tools, capabilities, topology, lifecycle and timeout without dispatching nested tools.',
  guidance: {
    when: 'Before running an unfamiliar saved recipe or a capability-declaring/bound script.',
    notWhen: 'You only need recipe discovery; use orchestrate:search.',
    chaining: 'orchestrate:inspect { script|recipe } → orchestrate:run with the same exact source and bindings; inspect durableRun.workflowId for status/result',
    seeAlso: ['orchestrate:search', 'orchestrate:run'],
  },
  capability: 'recipes:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: orchestrationSourceArgsSchema,
  handler(args, ctx) {
    return inspectOrchestration(args, ctx);
  },
});

export default orchestrateInspectTool;
