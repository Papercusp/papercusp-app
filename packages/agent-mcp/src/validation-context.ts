/**
 * Request context available while Standard Schema argument validation runs.
 *
 * MCP validation happens before a tool handler enters its database transaction,
 * so validators that need a workspace cannot rely on the handler's context.
 * Keep this context in the lowest shared package and use AsyncLocalStorage so
 * concurrent tool calls never borrow one another's workspace.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface ValidationContext {
  workspaceId: string;
}

const validationContext =
  typeof AsyncLocalStorage === 'function' ? new AsyncLocalStorage<ValidationContext>() : undefined;

/** The workspace explicitly associated with the current validation, if any. */
export function currentValidationWorkspaceId(): string | undefined {
  return validationContext?.getStore()?.workspaceId;
}

/** Run validation with the principal's workspace available to dynamic validators. */
export function runWithValidationWorkspace<T>(workspaceId: string | undefined, fn: () => T): T {
  if (!workspaceId || workspaceId === '*') return fn();
  return validationContext ? validationContext.run({ workspaceId }, fn) : fn();
}
