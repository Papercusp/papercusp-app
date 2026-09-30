/** Shared scope, identity and error rail for the seven public blueprint
 * operation tools (P-017, plan blueprint-backed-work-item-execution-2026-09-23
 * D-009). Every transport (MCP, /api/agent-tools HTTP, OpenAPI clients)
 * reaches the same projected dispatcher and therefore this one rail.
 *
 * These are principal-gated defineTools, so the handler receives the
 * framework's field-by-field legacy ctx (define-tool.ts registerLegacyAsProjected):
 * `principal` and `uiClientId` arrive; the transport's `workspaceId`,
 * `harnessSlug` and `isSuperuser` do NOT. The rail therefore derives scope only
 * from the authenticated principal — which is also the only sound source:
 *
 * - the workspace is the principal's. A transport-supplied workspace (a bare
 *   `?workspace=` on the HTTP catch-all) never reaches the handler, so it
 *   cannot widen the service's admin-handle queries into another workspace;
 * - the caller is the principal slug, or `<slug>/<client>` when the transport
 *   carries a client id. That client id (`?client=` / the MCP mount's client
 *   param) is caller-chosen and unverified — the shared identity resolver
 *   returns it verbatim for a principal — so it is only ever a sub-identity of
 *   the authenticated principal, never another caller's id. Synthesized
 *   principals (power-user, signed spawn) carry slug === client, unchanged;
 * - a handle minted in another workspace is refused before the service runs;
 *   its harness is bound by the durable receipt (harness is not an
 *   authorization boundary for a workspace-scoped principal);
 * - caller-caused service refusals surface as `invalid_input`; any other
 *   error stays a `handler_error` because it is a defect, not a caller mistake. */
import { getOrgPg } from '@papercusp/db-org';
import { UnauthorizedToolError } from '@papercusp/agent-mcp';
import { InvalidInputError } from '@papercusp/tooldef';
import type { Sql } from 'postgres';
import { isAllHarnessSentinel } from '../_harness-scope';
import { operationCallerId } from '../coordination/identity';
import { isBlueprintOperationRefusal } from '../../blueprint/operation-refusal';
import type { BlueprintOperationHandle } from '../../blueprint/operation-service';

/** The subset of the principal-gated handler ctx this rail may rely on. */
export interface OperationToolContext {
  principal?: { slug?: string; workspaceId?: string | null } | null;
  uiClientId?: string | null;
}

export interface OperationScope {
  sql: Sql;
  workspaceId: string;
  callerId: string;
}

function concrete(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '*' && !isAllHarnessSentinel(trimmed) ? trimmed : null;
}

/** The operation caller: the authenticated principal, optionally narrowed to
 * one of its own sessions by the transport client id. */
export function resolveOperationScope(ctx: OperationToolContext): OperationScope {
  const slug = ctx.principal?.slug?.trim();
  if (!slug) throw new UnauthorizedToolError('blueprint operations require an authenticated principal');
  const workspaceId = concrete(ctx.principal?.workspaceId);
  if (!workspaceId) {
    throw new UnauthorizedToolError('blueprint operations require a principal bound to a concrete workspace');
  }
  return { sql: getOrgPg().sql, workspaceId, callerId: operationCallerId(slug, ctx.uiClientId) };
}

function refuse(code: string, message: string): never {
  throw new InvalidInputError(`${code}: ${message}`);
}

/** A handle is usable only inside the workspace it was minted for. */
export function checkHandleScope(scope: OperationScope, handle: BlueprintOperationHandle): void {
  if (handle.workspaceId !== scope.workspaceId) {
    refuse('scope_mismatch', 'blueprint operation handle belongs to a different workspace');
  }
}

/** Run a service call, mapping typed caller refusals to `invalid_input`. */
export async function runOperation<T>(call: () => Promise<T>): Promise<{ data: T }> {
  try {
    return { data: await call() };
  } catch (error) {
    if (isBlueprintOperationRefusal(error)) refuse(error.code, error.message);
    throw error;
  }
}

export const OPERATION_TOOL_SEE_ALSO = [
  'blueprint:submit (start an operation; returns the handle)',
  'blueprint:status (current phase/outcome)',
  'blueprint:result (settled outcome and validated output)',
  'blueprint:events (cursor-paged event history)',
] as const;
