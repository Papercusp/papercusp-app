import {
  checkScript,
  durableRuntimeTools,
  ensureParseCheckReady,
  type ProjectedTool,
} from '@papercusp/tooldef';
import {
  listAllProjectedTools,
  roleScopedToolNames,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import {
  deriveLegacyForegroundManifest,
  preflightRecipeContract,
  projectedToolName,
  type CapabilityManifestV1,
  type CurrentCallerCapabilityCatalog,
  type LogicalCapability,
  type RecipeBindingSet,
  type RecipeContractFailure,
  type PreflightRecipeContractValue,
  type ReplayClass,
} from '../../recipe-contract';
import { validateRecipeScriptAgainstCatalog } from '../recipes/recipe-schema-validation';
import type { OrchestrationScriptSource } from './public-contract';

/** Prevent a script from recursively entering either public execution door. */
export const ORCHESTRATION_RECURSION_EXCLUSIONS = new Set([
  'code:run',
  'orchestrate:run',
]);

const projectedNames = (tools: readonly ProjectedTool[]): Set<string> =>
  new Set(
    tools
      .map((tool) => tool.expose.mcp?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

const hasEvery = (names: ReadonlySet<string>, required: readonly string[]): boolean =>
  required.every((name) => names.has(name));

/** Current implementation plus the current caller's live role envelope. */
export function currentCallerRecipeCatalog(
  tools: readonly ProjectedTool[],
  allowedTools: ReadonlySet<string>,
): CurrentCallerCapabilityCatalog {
  const allTools = projectedNames(tools);
  const availableCapabilities = new Set<LogicalCapability>([
    'content:image',
    'content:audio',
    'lifecycle:durable',
  ]);
  const allowedCapabilities = new Set<LogicalCapability>([
    'content:image',
    'content:audio',
    'lifecycle:durable',
  ]);
  const families: Array<{ capability: LogicalCapability; tools: string[] }> = [
    { capability: 'execution:shell', tools: ['capability:bash'] },
    {
      capability: 'execution:background-task',
      tools: ['capability:bash', 'capability:bash_output', 'capability:bash_kill'],
    },
    {
      capability: 'execution:pty',
      tools: [
        'capability:pty_open',
        'capability:pty_write_stdin',
        'capability:pty_resize',
        'capability:pty_read_screen',
        'capability:pty_kill',
      ],
    },
  ];
  for (const family of families) {
    if (hasEvery(allTools, family.tools)) availableCapabilities.add(family.capability);
    if (hasEvery(allowedTools, family.tools)) allowedCapabilities.add(family.capability);
  }
  return {
    projectedTools: allTools,
    allowedTools,
    availableCapabilities,
    allowedCapabilities,
    topology: { hostSame: true },
  };
}

export function runtimeRecipeReplayClass(
  staticToolNames: readonly string[],
  tools: readonly ProjectedTool[],
): ReplayClass {
  const effects = new Map(
    tools
      .map((tool) => [tool.expose.mcp?.name, tool.effect] as const)
      .filter((entry): entry is readonly [string, 'read' | 'write' | undefined] => typeof entry[0] === 'string'),
  );
  return staticToolNames.every((name) => effects.get(name) === 'read')
    ? 'read-only'
    : 'non-replayable';
}

export interface OrchestrationCallerSurface {
  tools: ReturnType<typeof listAllProjectedTools>;
  allowed: ReadonlySet<string>;
  catalog: CurrentCallerCapabilityCatalog;
}

export function orchestrationCallerSurface(
  ctx: UnifiedToolContext,
  options: { durable?: boolean } = {},
): OrchestrationCallerSurface {
  const projected = listAllProjectedTools();
  const runtimeTools = options.durable ? durableRuntimeTools() : [];
  const tools = [...projected, ...runtimeTools];
  const allowed = new Set(roleScopedToolNames(projected, ctx.role, ORCHESTRATION_RECURSION_EXCLUSIONS));
  for (const tool of runtimeTools) {
    const name = tool.expose.mcp?.name;
    if (name) allowed.add(name);
  }
  return { tools, allowed, catalog: currentCallerRecipeCatalog(tools, allowed) };
}

export interface ScriptContractInspection {
  ok: true;
  staticToolNames: string[];
  staticCalls: ReturnType<typeof checkScript>['calls'];
  manifest: CapabilityManifestV1;
  bindingSchema?: OrchestrationScriptSource['bindingSchema'];
  contract: PreflightRecipeContractValue;
}

function unavailableRefFailure(code: 'capability_unavailable' | 'capability_denied', ref: string): RecipeContractFailure {
  return {
    ok: false,
    phase: 'preflight',
    executed: false,
    error: {
      code,
      message:
        code === 'capability_denied'
          ? `current caller may not invoke ${ref}`
          : `statically referenced tool ${ref} is unavailable`,
      path: 'script.source',
      capability: `tools:${projectedToolName(ref)}`,
    },
  };
}

export async function inspectScriptContract(input: {
  script: OrchestrationScriptSource;
  bindings?: RecipeBindingSet;
  lifecycle?: 'foreground' | 'background';
  manifest?: unknown;
  ctx: UnifiedToolContext;
  /** Test/composition seam for a caller-owned projected catalog. Production
   * calls omit this and always rebuild the live current-caller surface. */
  surface?: OrchestrationCallerSurface;
}): Promise<ScriptContractInspection | RecipeContractFailure> {
  const surface = input.surface ?? orchestrationCallerSurface(input.ctx, {
    durable: input.lifecycle === 'background',
  });
  await ensureParseCheckReady();
  const catalogAnalysis = checkScript(input.script.source, surface.tools);
  if (!catalogAnalysis.ok) {
    return unavailableRefFailure('capability_unavailable', catalogAnalysis.unknownRefs[0] ?? 'unknown');
  }
  const callerAnalysis = checkScript(input.script.source, surface.tools, surface.allowed);
  if (!callerAnalysis.ok) {
    return unavailableRefFailure('capability_denied', callerAnalysis.unknownRefs[0] ?? 'unknown');
  }

  const schema = await validateRecipeScriptAgainstCatalog(
    input.script.source,
    surface.tools,
    surface.allowed,
  );
  if (!schema.ok) {
    return {
      ok: false,
      phase: 'preflight',
      executed: false,
      error: {
        code: input.manifest === undefined ? 'script_invalid' : 'recipe_schema_stale',
        message: schema.issues[0]?.message ?? 'script does not match the current tool catalog',
        path: schema.issues[0]?.path ?? 'script.source',
      },
    };
  }

  const staticToolNames = [...new Set(schema.staticToolNames.map(projectedToolName))].sort();
  let manifest = input.manifest;
  if (manifest === undefined) {
    const derived = deriveLegacyForegroundManifest(staticToolNames);
    const requirements = new Map(
      derived.requirements.map((requirement) => [requirement.capability, requirement]),
    );
    for (const requirement of input.script.requires ?? []) {
      requirements.set(requirement.capability, requirement);
    }
    if (input.lifecycle === 'background') {
      requirements.set('lifecycle:durable', { capability: 'lifecycle:durable' });
    }
    manifest = {
      ...derived,
      requirements: [...requirements.values()].sort((a, b) =>
        a.capability.localeCompare(b.capability)),
      ...(input.lifecycle === 'background'
        ? {
            lifecycle: { allowed: ['background'] as const, default: 'background' as const },
            replay: {
              class: 'checkpointed' as const,
              reason: 'durable orchestration checkpoints each nested tool call in the runtime',
            },
          }
        : { replay: { class: runtimeRecipeReplayClass(staticToolNames, surface.tools) } }),
    } satisfies CapabilityManifestV1;
  }

  const contract = preflightRecipeContract({
    manifest,
    bindingSchema: input.script.bindingSchema,
    bindings: input.bindings,
    staticToolNames,
    lifecycle: input.lifecycle ?? 'foreground',
    derivedReplayClass: input.lifecycle === 'background'
      ? 'checkpointed'
      : runtimeRecipeReplayClass(staticToolNames, surface.tools),
    catalog: surface.catalog,
  });
  if (!contract.ok) return contract;

  return {
    ok: true,
    staticToolNames,
    staticCalls: callerAnalysis.calls,
    manifest: contract.value.manifest,
    ...(contract.value.bindingSchema ? { bindingSchema: contract.value.bindingSchema } : {}),
    contract: contract.value,
  };
}
