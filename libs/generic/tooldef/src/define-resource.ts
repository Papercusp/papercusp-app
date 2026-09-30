/**
 * defineResource — symmetric to defineTool.
 *
 * Resources are declared via `defineResource({ uri, capability, read, list? })`
 * and placed in `src/resources/<group>/<verb>.ts`. The helper:
 *   - Derives the resource name from the file path:
 *     `resources/harness/list.ts` → `harness:list`. Override via `name`.
 *   - Looks up the tier from the capability per §10.6.1.
 *   - Self-registers into `resource-registry.ts`.
 *
 * The catalog is the result of importing `resources/**`.
 */

import { tierFor } from './capability-tiers';
import { registerResource } from './resource-registry';
import type { ResourceDefinition, ResourceDefinitionInput } from './types';

function deriveNameFromCallSite(): string | null {
  const ErrorAny = Error as unknown as {
    prepareStackTrace?: (err: Error, stack: unknown[]) => unknown;
  };
  const orig = ErrorAny.prepareStackTrace;
  try {
    ErrorAny.prepareStackTrace = (_err: Error, stack: unknown[]) => stack;
    const raw = new Error().stack as unknown as Array<{ getFileName?: () => string }>;
    // [0]=this fn, [1]=defineResource, [2]=caller (the resource file).
    const callerFile = raw?.[2]?.getFileName?.();
    if (!callerFile) return null;
    const match = /\/resources\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(callerFile);
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

export function defineResource(input: ResourceDefinitionInput): ResourceDefinition {
  const name = input.name ?? deriveNameFromCallSite();
  if (!name) {
    throw new Error(
      'defineResource: could not derive name from call site. ' +
      'Pass `name` explicitly or place the file under `resources/<group>/<verb>.ts`.',
    );
  }
  const description = input.description ?? `Resource ${name}`;
  const tier = tierFor(input.capability);

  const def: ResourceDefinition = {
    uri: input.uri,
    name,
    description,
    mimeType: input.mimeType ?? 'application/json',
    capability: input.capability,
    tier,
    list: input.list,
    read: input.read,
  };

  registerResource(def);
  return def;
}
