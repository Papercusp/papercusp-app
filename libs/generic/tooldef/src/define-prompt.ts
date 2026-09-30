/**
 * definePrompt — symmetric to defineTool / defineResource.
 *
 * Place files under `src/prompts/<group>/<verb>.ts`. The macro derives
 * the prompt name from the file path and self-registers.
 */

import { tierFor } from './capability-tiers';
import { registerPrompt } from './prompt-registry';
import type { PromptDefinition, PromptDefinitionInput } from './types';

function deriveNameFromCallSite(): string | null {
  const ErrorAny = Error as unknown as {
    prepareStackTrace?: (err: Error, stack: unknown[]) => unknown;
  };
  const orig = ErrorAny.prepareStackTrace;
  try {
    ErrorAny.prepareStackTrace = (_err: Error, stack: unknown[]) => stack;
    const raw = new Error().stack as unknown as Array<{ getFileName?: () => string }>;
    const callerFile = raw?.[2]?.getFileName?.();
    if (!callerFile) return null;
    const match = /\/prompts\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(callerFile);
    if (!match) return null;
    const group = match[1];
    let verb = match[2];
    if (verb === 'index') verb = 'default';
    return `${group}:${verb}`;
  } catch {
    return null;
  } finally {
    ErrorAny.prepareStackTrace = orig;
  }
}

export function definePrompt(input: PromptDefinitionInput): PromptDefinition {
  const name = input.name ?? deriveNameFromCallSite();
  if (!name) {
    throw new Error(
      'definePrompt: could not derive name from call site. ' +
      'Pass `name` explicitly or place the file under `prompts/<group>/<verb>.ts`.',
    );
  }
  const description = input.description ?? `Prompt ${name}`;
  // Public prompts (no capability) are tier "low" by default.
  const tier = input.capability ? tierFor(input.capability) : 'low';

  const def: PromptDefinition = {
    name,
    description,
    capability: input.capability,
    tier,
    arguments: input.arguments,
    render: input.render,
  };

  registerPrompt(def);
  return def;
}
