/**
 * Shared authenticated MCP host — registers tools, resources and prompts
 * on the installed SDK server. HTTP and native transports reuse this exact
 * registry, context verification, dispatch and result policy.
 *
 * Two parallel tool pipelines coexist on the same MCP endpoint:
 *
 *   1. Built-in tools — defined under `packages/agent-mcp/src/tools/`
 *      via `defineTool()` and registered into the agent-mcp legacy
 *      catalog. Auth: bearer header → Principal → existing dispatch().
 *      Migrated to the projected-tool registry in PR 0c.D.
 *
 *   2. Projected tools (PR 0c.A/B) — functions registered via
 *      registerProjectedTool() with manifest-declared expose.mcp.
 *      Auth: per-spawn URL query params (the seven from the
 *      orchestrator's per-spawn mcp.json). Routed via
 *      dispatchProjectedTool with role-allowlist and quota gates.
 *
 * Both pipelines share `tools/list` and `tools/call`; the dispatcher
 * routes by name (legacy catalog first, projected registry second).
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// STATIC value import, deliberately not `createRequire(import.meta.url)(…)`.
// The packed desktop sidecar is a single esbuild bundle with NO node_modules
// tree beside it (build-desktop-sidecar.sh: "serve.mjs has every inlinable
// module"), and every inlined module shares serve.mjs's own import.meta.url —
// so a runtime require of this specifier resolves against sidecar/ and throws
// ERR_MODULE_NOT_FOUND. That threw inside registerMcpHost(), was swallowed by
// the global unhandledRejection handler as "non-fatal … continuing boot", and
// left every /api/mcp request hanging with no response ever written. A static
// import is what esbuild can see, so the schemas are inlined into the bundle.
import * as sdk from '@modelcontextprotocol/sdk/types.js';
import {
  getCatalog,
  toArgsJsonSchema,
  applyEntityRefEnums,
  getPromptCatalog,
  getResourceCatalog,
  dispatch,
  resolveBearer,
  getPrompt,
  listResources,
  readResource,
  parseRequestContext,
  InvalidRequestContextError,
  lookup as lookupToolDefinitionByName,
  lookupByMcpName,
  resolveMcpName,
  listMcpProjections,
  applyToolManifest,
  papercuspGateBypass,
  sanitizeToolSchema,
  sanitizeToolSchemaCached,
  serializeToolResponse,
  formatOptsFromCtx,
  isSlashPromptName,
  DeltaToolClient,
  dispatchWithConveyedDelta,
  parsePayloadTier,
  type PayloadTier,
  type UnifiedToolContext,
  type Principal,
  type RequestOriginMetadata,
  type DeltaResponse,
} from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  dynamicSlashListings,
  resolveSlashToolForPrompt,
  slashToolVisibleTo,
  renderSlashPromptForTool,
  auditSlashPromptGet,
} from './_mcp-slash-prompts';
import type { AgentRole } from '@papercusp/plugin-sdk';
// Generic MCP↔dispatcher bridge primitives (plan P-031). The auth/spawn-context
// assembly below stays host-side; only the reusable, host-agnostic glue moved.
import {
  bearerFromExtra,
  urlFromExtra,
  headersFromExtra,
  dispatchProjectedToolToMcp,
  isDispatchValidationFailure,
} from '@papercusp/tooldef-mcp';
import { mcpDataPlaneDegradedAtFromExtra, mcpTraceIdFromExtra } from '../../../mcp-request-trace';
import { getOrgPg, retryOnRetryableDbDeadline, withWorkspace } from '@papercusp/db-org';
import { applyResultDoor, beginResultDoorAggregate, measureResultContextBytes } from '../../../result-door';
import { annotateStoreIdentitySuspectResult, mayAnnotateResultText } from './store-identity-suspect';
import {
  MAX_PICK_PATHS,
  PROJECTION_ARG,
  applyNamedViewToResult,
  applyResultProjection,
  parseProjection,
  projectionMaterializationFormat,
  takeNamedViewFromArgs,
} from '../../../result-projection';
import type { ProjectionSpec, ViewResolution } from '../../../result-projection';
import { resolveAgentIdentity } from '../../../agent-tools/coordination/identity';
import { SCRATCH_SCHEME } from '../../../scratch-uri';
import { canonicalCoordRole } from '../../../agent-tools/coordination/roles';
import {
  dispatchNeedsTx,
  effectiveDispatchWorkspace,
  synthesizeDispatchPrincipal,
  synthesizeResourcePrincipal,
  synthesizeTransportPrincipal,
} from './role-principal-caps';
import { runWithWorkspaceIfConcrete } from '../../../workspace-als';
import { capabilityMapText } from '../../../agent-tools/tools/capability-map';
import { isPluginNamespacedToolName, unknownToolReferral } from '../../../agent-tools/tools/unknown-tool-referral';
import { resolveDispatchTarget } from '../../../agent-tools/resolve-dispatch-target';
import {
  annotateFuzzyResult,
  resolveWithFuzzy,
  withFuzzyToolName,
  type FuzzyDispatchDeps,
  type FuzzyResolutionRecord,
} from '../../../agent-tools/fuzzy-dispatch';
import { tierFor } from '@papercusp/agent-mcp';
import { decodeToolsInvokeArgs } from '../../../agent-tools/tools/invoke-args';
import { getPluginHost } from '../../../plugin-host-runtime';
import {
  maybeBatchNudge,
  maybeOrientDedupNudge,
  maybeListFanoutPreempt,
  maybeStatePlaneNudge,
  canRoleActOnCodeRun,
  advisorySessionKey,
} from '../../../code-run-batch-nudge';
// EI-10892: detect the ok:true-but-every-field-blank code:run result — a mis-mapped
// response shape, which is the dominant tool-waste mode and invisible to the
// hard-failure-only efficiency telemetry.
import { maybeEmptyMappingHint } from '../../../empty-mapping-hint';
import { recordBatchNudgeFire } from '../../../code-run-nudge-telemetry';
import { authSafeToolsRemoveSet } from '../../../auth-config-overrides';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../../superuser-token';
import { isAppKeyShaped } from '../../../connected-apps/key';
import { reportedClientAddress, resolveAppKeyToken } from '../../../connected-apps/principal';
import { appKeyToolListFilter } from '../../../connected-apps/enforce';
import {
  admissionCredentialDigest,
  type AdmissionAuthorityContext,
  type AdmissionRecoveryAuthority,
} from '../../../work-item-admission-authority';
import { workspaceForCoordOwner } from '../../../adv-sessions';
import { activeWorkspaceId } from '../../../workspace-registry';
import { PLATFORM_POT_SLUG } from '../../../platform-pot-slug';
import { isReservedHarnesslessRoutineHost } from '../../../harness/routines/routine-host';
import {
  allowStalePlanRecoveryForMcpCall,
  isEngineeringDocsSentinel,
  resolveInheritedHarnessScope,
} from '../../../agent-tools/_harness-scope';
import { verifyExplicitPlanHarness } from '../../../agent-tools/plans/slug-scope';
import { DeltaProxySessionStore } from './delta-proxy-session-store';
import { goalHolderMayPlaceIntoLocalPot } from './goal-local-placement';
import {
  classifyAndConsumeFailure,
  logVerificationFailure,
  recordVerifiedSpawn,
  spawnSigFailureGuidance,
  verifySpawnParams,
} from '../../../spawn-signing';
import { verifyAccessToken } from '../../../power-user-token';
import {
  parseToolsAllowlist,
  parseCompactToolNames,
  applyCompactTier,
  filterListingsByAllowlist,
  getSessionSurface,
  activateSessionTools,
} from './tool-allowlist';
import { validIdempotencyKey, lookupStoredMcpResult, storeMcpResult, type StoredMcpResult } from './_mcp-result-replay';
import {
  takeStoredInitializeHandler,
  wrapInitializeWithInstructions,
  buildInitializeStageTelemetry,
  isNativeInstructionBudgetClient,
  type InitializeStageOutcome,
} from './_mcp-initialize-enrich';
import { buildMcpPrelude } from '../../../memory/mcp-prelude';
import { INSIGHTS_DIR } from '../../../memory/knowledge-read';
import { getSessionUserOrDefault } from '../../../auth';
import { advertisedArgsSchema } from '@papercusp/result-encoding';
import {
  collectEntityRefs,
  compactInputSchema,
  summaryGuidanceDescription,
  type ResultDoorSkipReason,
} from '@papercusp/tooldef';
import { MCP_SERVER_CAPABILITIES } from './mcp-contract';
import { withMcpDiagnosticWarnings, type McpCallResult } from './mcp-diagnostic-warnings';
import { parseMcpToolText } from './mcp-result-text';

export { MCP_SERVER_CAPABILITIES } from './mcp-contract';
export { withMcpDiagnosticWarnings } from './mcp-diagnostic-warnings';
export type { McpCallResult } from './mcp-diagnostic-warnings';

/* ─── Helpers ────────────────────────────────────────────────────────── */
// `bearerFromExtra` / `urlFromExtra` / `headersFromExtra` are imported from
// `@papercusp/tooldef-mcp` (P-031) — generic mcp-handler `extra` extractors.

/**
 * Load operator-side first-party tools only when a host is actually being
 * registered or serving a request. Importing this transport module is also
 * used by small helper probes and tsx boot guards; eagerly loading the full
 * tool graph there arms host listeners/timers before a request exists and can
 * keep a one-shot process alive indefinitely. The promise is shared so
 * concurrent HTTP/UDS initializers register the catalog exactly once, and a
 * failed load can retry on the next real request.
 */
let operatorToolsLoad: Promise<void> | null = null;

export function ensureOperatorToolsLoaded(): Promise<void> {
  if (!operatorToolsLoad) {
    operatorToolsLoad = import('../../../agent-tools/index')
      .then(() => undefined)
      .catch((error) => {
        operatorToolsLoad = null;
        throw error;
      });
  }
  return operatorToolsLoad;
}

const ENTITY_REF_SCHEMA_PRESENCE = new WeakMap<object, boolean>();

function hasEntityRefSchema(argsSchema: unknown): boolean {
  if (!argsSchema || typeof argsSchema !== 'object') return false;
  const cached = ENTITY_REF_SCHEMA_PRESENCE.get(argsSchema);
  if (cached !== undefined) return cached;
  const present = collectEntityRefs(argsSchema).length > 0;
  ENTITY_REF_SCHEMA_PRESENCE.set(argsSchema, present);
  return present;
}

function listingRegistryRevision(listing: unknown): string {
  const meta =
    listing && typeof listing === 'object'
      ? (listing as { _meta?: Record<string, unknown> })._meta
      : undefined;
  const revision = meta?.['papercusp/toolRegistryRevision'];
  return typeof revision === 'string' || typeof revision === 'number'
    ? String(revision)
    : 'unknown';
}

// `tools:invoke` returns the target's MCP-shaped result through the wrapper
// dispatcher, so the outer result-door choke point cannot inspect the target's
// ProjectedTool definition directly. Carry this one internal-only decision in
// `_meta` (which is not shown to the model) across that bridge, then consume it
// at the outer tools/call boundary. This preserves machine-readable target
// results such as dev:pg_query without weakening the door for ordinary targets.
const NESTED_RESULT_DOOR_SKIP_META = '__papercusp_nested_result_door_skip';

function isResultDoorSkipReason(value: unknown): value is ResultDoorSkipReason {
  return value === 'programmatic-caller' || value === 'oversize-by-design';
}

function nestedResultDoorSkipReason(result: McpCallResult): ResultDoorSkipReason | undefined {
  const reason = result._meta?.[NESTED_RESULT_DOOR_SKIP_META];
  return isResultDoorSkipReason(reason) ? reason : undefined;
}

function carryNestedResultDoorSkip(result: McpCallResult, reason: ResultDoorSkipReason | undefined): McpCallResult {
  if (!reason) return result;
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [NESTED_RESULT_DOOR_SKIP_META]: reason },
  };
}

function stripNestedResultDoorSkip(result: McpCallResult): McpCallResult {
  if (!result._meta || !(NESTED_RESULT_DOOR_SKIP_META in result._meta)) return result;
  const { [NESTED_RESULT_DOOR_SKIP_META]: _reason, ...meta } = result._meta;
  return { ...result, _meta: Object.keys(meta).length > 0 ? meta : undefined };
}

/**
 * A caller projection/view promotes the inner dispatch to a full source so the
 * reduction can search the complete result. That internal promotion is not an
 * explicit `payloadTier:'full'` request, but the generic tool serializer cannot
 * distinguish the two and stamps `_meta.explicitFullRequest` for both. Remove
 * the marker before the outer result door when the original context did not
 * already carry a caller-selected full tier or transport exemption.
 */
function stripImplicitProjectionFullRequest(
  result: McpCallResult,
  projectionNeedsFullSource: boolean,
  ctx: UnifiedToolContext,
): McpCallResult {
  if (
    !projectionNeedsFullSource ||
    ctx.contextTier === 'full' ||
    ctx.payloadTierOverride === 'full' ||
    ctx.transportCapExempt === true ||
    !result._meta ||
    !('explicitFullRequest' in result._meta)
  ) {
    return result;
  }
  const { explicitFullRequest: _implicitFullRequest, ...meta } = result._meta;
  return { ...result, _meta: Object.keys(meta).length > 0 ? meta : undefined };
}

const REQUEST_ORIGIN_QUERY_KEYS = new Set([
  'superuser',
  'power_user',
  'workspace',
  'harness',
  'role',
  'client',
  'agent',
  'model',
  'profile',
  'ctx_tier',
  'tools',
  'format',
  'structured',
  'delta',
  'plan_run',
  'all_workspaces',
  // EI-20267598379696870: how a caller DECLARES who chose the call (`&origin=hook`). Our hook
  // clients know what they are; inference is what corrupted the metric in the first place.
  'origin',
]);

const REQUEST_ORIGIN_HEADER_KEYS = [
  'host',
  'user-agent',
  'origin',
  'referer',
  'sec-fetch-site',
  'x-papercusp-client',
  'x-papercusp-workspace',
  'x-papercusp-profile',
  'x-papercusp-agent',
  'x-papercusp-model',
  'mcp-session-id',
  // EI-20267598379696870: the header form of the `origin` declaration above, for callers that
  // cannot shape their URL.
  'x-papercusp-call-origin',
] as const;

function buildMcpRequestOrigin(extra: unknown): RequestOriginMetadata | undefined {
  const url = urlFromExtra(extra);
  if (!url) return undefined;
  const headers = headersFromExtra(extra);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (REQUEST_ORIGIN_QUERY_KEYS.has(key)) query[key] = value;
  }
  const headerMeta: Record<string, string> = {};
  for (const key of REQUEST_ORIGIN_HEADER_KEYS) {
    const value = (headers.get(key) ?? '').trim();
    if (value) headerMeta[key] = value;
  }
  return {
    transport: 'mcp',
    connection: 'http',
    path: url.pathname,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headerMeta).length > 0 ? { headers: headerMeta } : {}),
  };
}

/**
 * Build the telemetry-only context for a request rejected before auth can
 * produce a normal spawn context. This deliberately trusts no authorization
 * claim: the context is used only to preserve the request's claimed scope and
 * origin in a best-effort error row, never for dispatch or presence updates.
 */
function mcpAuthFailureContext(extra: unknown): UnifiedToolContext | null {
  const url = urlFromExtra(extra);
  if (!url) return null;
  const headers = headersFromExtra(extra);
  const queryParam = (name: string): string => (url.searchParams.get(name) ?? '').trim();
  const headerParam = (name: string): string => (headers.get(name) ?? '').trim();
  const workspaceId = headerParam('x-papercusp-workspace') || queryParam('workspace');
  // Without an explicit claimed workspace, writing a row would mis-scope it to
  // a tenant guessed from process state. Keep the failure visible in logs, but
  // leave the workspace-scoped telemetry ledger untouched.
  if (!workspaceId) return null;

  const harnessSlug = headerParam('x-papercusp-harness') || queryParam('harness') || '*';
  const uiClientId = headerParam('x-papercusp-client') || queryParam('client') || headerParam('mcp-session-id');
  const role = canonicalCoordRole(queryParam('role') || 'operator') as AgentRole;
  const runId = queryParam('run') || `mcp-auth-failure-${globalThis.crypto.randomUUID()}`;
  const spawnId = queryParam('spawn') || `mcp-auth-failure-${globalThis.crypto.randomUUID()}`;
  const claimedSuperuser = queryParam('superuser') === '1';
  const claimedPowerUser = queryParam('power_user') === '1';

  return {
    workspaceId,
    harnessSlug,
    role,
    featureId: null,
    chunkId: null,
    runId,
    spawnId,
    parentSpawnId: null,
    uiClientId: uiClientId || null,
    // These are URL claims only. They allow the existing telemetry identity
    // resolver to retain a known session label, but no gate reads this ctx.
    ...(claimedSuperuser ? { isSuperuser: true } : {}),
    ...(claimedPowerUser ? { isPowerUser: true } : {}),
    profile: queryParam('profile') === 'power' ? 'power' : 'engineer',
    transport: 'mcp',
    requestOrigin: buildMcpRequestOrigin(extra),
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
  };
}

/**
 * Keep rejected MCP calls visible to the same tool_invocations ledger as
 * dispatched calls. Auth rejection happens before buildMcpToolContext and the
 * dispatcher, so this is the only recording point for a dark session.
 */
async function recordMcpAuthFailureTelemetry(
  toolName: string,
  extra: unknown,
  reason: string,
  projected: ReturnType<typeof lookupByMcpName>,
  callStartedAt: number,
): Promise<void> {
  const ctx = mcpAuthFailureContext(extra);
  if (!ctx) return;
  try {
    const roleQuota = ctx.role ? projected?.rolesQuota?.[ctx.role] : undefined;
    await PROJECTED_DEPS.recordInvocation?.({
      toolName,
      pluginName: projected?.pluginName ?? 'agent-mcp',
      ctx,
      windowKey: PROJECTED_DEPS.computeQuotaWindow?.(ctx, roleQuota, toolName).key ?? '',
      durationMs: Date.now() - callStartedAt,
      status: 'error',
      errorCode: 'mcp_auth_failed',
      errorMessage: reason,
      // Auth failed before input validation; do not persist untrusted args.
      metadataJson: { mcpAuthFailure: { reason, contextVerified: false } },
    });
  } catch (error) {
    // Telemetry is best-effort and must never change the auth rejection seen by
    // the caller (or turn a dark session into a different failure mode).
    console.warn(
      `[mcp-handler] auth-failure telemetry failed for ${toolName}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Fuzzy tool-name recovery deps (plan fuzzy-tool-name-resolution-2026-07-02, P-007 / D-008–D-010).
 * A mangled `tools/call` name is rewritten to its canonical registered name before the handler
 * runs and the reply is annotated; every non-exact outcome lands in `tool_invocations` as a
 * telemetry row keyed by the mangled name. Candidate scope (D-009) is the caller's LIVE surface:
 * a trimmed (`?tools=`) session only resolves inside its seed + tools:find-activated set.
 */
const MCP_FUZZY_DEPS: FuzzyDispatchDeps = {
  lookup: (name) => lookupByMcpName(name),
  resolve: resolveDispatchTarget,
  skip: isPluginNamespacedToolName,
  transport: 'mcp',
  modelOf: (extra) => urlFromExtra(extra)?.searchParams.get('model') ?? null,
  // D-007: a tool whose capability is high-tier is never fuzzy-resolved (write-effect tools are
  // additionally excluded by the resolver's own default `neverFuzzy`).
  tierOf: (mcpName) => {
    const caps = lookupByMcpName(mcpName)?.capabilities ?? [];
    return caps.some((c) => tierFor(c) === 'high') ? 'high' : undefined;
  },
  visibleFor: (extra) => {
    const url = urlFromExtra(extra);
    const seed = parseToolsAllowlist(url?.searchParams.get('tools'));
    if (!seed) return undefined;
    const ctx = mcpAuthFailureContext(extra);
    const allow = getSessionSurface(ctx?.uiClientId ?? null, seed);
    if (!allow) return undefined;
    return (tool) => {
      const n = tool.expose.mcp?.name;
      return n !== undefined && allow.has(n);
    };
  },
  record: recordFuzzyResolutionTelemetry,
};

async function recordFuzzyResolutionTelemetry(rec: FuzzyResolutionRecord, extra: unknown): Promise<void> {
  const ctx = mcpAuthFailureContext(extra);
  if (!ctx) return;
  try {
    await PROJECTED_DEPS.recordInvocation?.({
      toolName: rec.in,
      pluginName: 'agent-mcp',
      ctx,
      windowKey: '',
      durationMs: 0,
      status: 'ok',
      metadataJson: { fuzzyToolNameResolution: rec },
    });
  } catch (error) {
    console.warn(
      `[mcp-handler] fuzzy-resolution telemetry failed for ${rec.in}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

const DELTA_PROXY_SESSIONS = new DeltaProxySessionStore();

function deltaProxySession(sessionKey: string) {
  return DELTA_PROXY_SESSIONS.getOrCreate(sessionKey);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resultRows(result: McpCallResult): unknown[] {
  if (Array.isArray(result.structuredContent)) return result.structuredContent;
  const text = (result.content[0] as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string') throw new Error('delta proxy cannot parse non-text tool result');
  const parsed = parseMcpToolText(text);
  if (!Array.isArray(parsed)) {
    // Some semantic tools diff a flattened row set while returning a grouped object
    // (for example plans:attention). A generic proxy cannot reconstruct that
    // original body from row deltas, so it must leave those calls on the raw path.
    throw new Error('delta proxy supports array-shaped tool results only');
  }
  return parsed;
}

function resultDelta(result: McpCallResult): Record<string, unknown> | undefined {
  const delta = result._meta?.delta;
  return delta && typeof delta === 'object' ? (delta as Record<string, unknown>) : undefined;
}

function adaptDeltaResponse(result: McpCallResult): DeltaResponse {
  const delta = resultDelta(result);
  const mode = typeof delta?.mode === 'string' ? delta.mode : 'full';
  const cursor = typeof delta?.cursor === 'string' ? delta.cursor : undefined;
  const itemKeyField = typeof delta?.itemKeyField === 'string' ? delta.itemKeyField : undefined;
  if (mode === 'not_modified') return { mode: 'not_modified', cursor };
  if (mode === 'delta') {
    const text = (result.content[0] as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string') throw new Error('delta proxy cannot parse non-text delta result');
    return {
      mode: 'delta',
      cursor,
      checksum: typeof delta?.checksum === 'string' ? delta.checksum : undefined,
      changes: parseMcpToolText(text) as never,
      itemKeyField,
    };
  }
  return { mode: 'full', cursor, rows: resultRows(result), itemKeyField };
}

async function maybeRunWithDeltaProxy(input: {
  sessionKey: string;
  toolName: string;
  args: unknown;
  requestedFormat: string | undefined;
  explicitDelta: boolean;
  itemKeyField: string | undefined;
  runRaw: (requestedDelta: string | undefined, overrideDelta?: boolean) => Promise<McpCallResult>;
}): Promise<McpCallResult> {
  if (input.explicitDelta || !input.itemKeyField) return input.runRaw(undefined, false);
  const viewKey = `${input.toolName}:${input.requestedFormat ?? ''}:${stableJson(input.args ?? null)}`;
  const session = deltaProxySession(input.sessionKey);
  // A mutable box, not a bare `let` — `last` is reassigned inside the nested
  // `dispatchWithConveyedDelta` callback below, and TS's control-flow narrowing
  // does not track a `let` reassignment that happens inside a separate function
  // expression, so a later read of a bare `let` here mis-narrows to `never`.
  // Object-property reads aren't subject to that narrowing, so this sidesteps it.
  const lastBox: { value: McpCallResult | null } = { value: null };
  try {
    const out = await dispatchWithConveyedDelta(session.client, session.fields, viewKey, async (requestedDelta) => {
      // DeltaToolClient stores the opaque server cursor only; the tool protocol
      // expects the request mode plus cursor on the wire.
      lastBox.value = await input.runRaw(requestedDelta ? `not_modified~${requestedDelta}` : undefined, true);
      return adaptDeltaResponse(lastBox.value);
    });
    const finalResult = lastBox.value;
    if (!finalResult || finalResult.isError || out.mode === 'full') {
      return finalResult ?? input.runRaw(undefined, true);
    }
    const meta = resultDelta(finalResult);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out.rows) }],
      _meta: {
        ...(finalResult._meta ?? {}),
        delta: {
          ...(meta ?? {}),
          mode: 'full',
          reason: 'proxy_reconstructed',
        },
        deltaProxy: {
          servedMode: out.mode,
          reconstructedFull: true,
        },
      },
    };
  } catch {
    session.client.forget(viewKey);
    session.fields.delete(viewKey);
    return input.runRaw(undefined, true);
  }
}

/**
 * scoped-superuser-workspace-clamp exemption (EI-1810). A `crossWorkspace: true`
 * tool normally bypasses the per-workspace tx (getOrgPg admin handle) so an
 * UNSCOPED superuser session can call it — which is exactly why the clamp denies
 * such tools from a SCOPED superuser session (they could read across workspaces).
 * These specific tools are the exception: they are crossWorkspace ONLY to support
 * the unscoped path, but when called from a SCOPED session they confine themselves
 * to the caller's OWN workspace (resolve ctx.principal.workspaceId) and are
 * read-only — so a scoped session calling them never reads another workspace.
 *
 * The exemption lives HERE, in the gate, not as a self-asserted per-tool flag: a
 * tool author must not be able to bypass workspace isolation by setting a boolean on
 * their own def — each entry is reviewed as part of this security boundary.
 *
 *   - autonomy:decide — a pure advisory gate (capability intel:read, never mutates)
 *     that resolves the caller's workspace and reads only THAT workspace's autonomy
 *     policy. The Overwatch role runs workspace-scoped and its prompt mandates this
 *     tool, so the clamp made it deterministically unusable for the role (EI-1810).
 *   - memory:* (search/list/remember/update/forget) — the memory store is partitioned
 *     by USER-ID / HARNESS-SLUG, NOT by workspace (the handler reads getMemoryBackend,
 *     never ctx.tx). A scoped session calling these touches only its OWN user's /
 *     harness's memory — it never reads or writes another WORKSPACE's tenant data, so
 *     the clamp's threat model (cross-workspace tenant-data access) simply does not
 *     apply. They are crossWorkspace:true only so an UNSCOPED ('*') psu gets the admin
 *     handle (EI-2378); denying them from a scoped session would break legitimate
 *     same-user memory recall/writes for no isolation benefit. (Reads AND writes are
 *     listed: a write lands in the caller's own user/harness memory, crossing no
 *     workspace boundary — the "read-only" note above is autonomy:decide-specific.)
 */
const SCOPED_SAFE_CROSSWORKSPACE: ReadonlySet<string> = new Set([
  'autonomy:decide',
  // EI-1934: the WRITE sibling of autonomy:decide — SAME self-confining profile
  // (resolves ws from the caller's principal / activeWorkspaceId(), and records the
  // disposition row ONLY to that ws — record_disposition.ts:92-93,114-115).
  // crossWorkspace:true only so an UNSCOPED psu gets the admin handle; from a SCOPED
  // Queen session it crosses no workspace boundary, so the clamp must not deny it —
  // otherwise the Queen's decision-ledger audit is unusable from its normal scoped seat
  // (EI-1810's exemption must cover the whole autonomy:* decide+record family, not just decide).
  'autonomy:record_disposition',
  'memory:search',
  'memory:list',
  'memory:remember',
  'memory:update',
  'memory:forget',
  // search:* prose recall (session-search-scope-2026-07-05 live-smoke finding) —
  // read-only; crossWorkspace ONLY so an unscoped psu gets the admin handle for
  // the non-workspace-scoped operator_turns table (P-062 Phase 4). From a SCOPED
  // session the engine confines every source by the ctx workspaceId it is handed
  // (runFullTextSearch/runHybridSearch `workspaceId:` — each SearchSource's SQL
  // filters on it); operator_turns is host-global operator history, not another
  // workspace's tenant data. Denying these made prose recall (and the EI-6984
  // work_item dedup check) deterministically unusable for every workspace-scoped
  // psu session — the same failure shape as autonomy:decide (EI-1810).
  'search:fulltext',
  'search:semantic',
  // sessions:* (session-search-scope-2026-07-05 P-005/P-006) — read-only session
  // recall. session_turns confines to (workspace_id = $ws OR 'default') — the
  // 'default' rows are THIS HOST's local transcript files (claude/omp/codex
  // JSONL), which carry no workspace identity and are not tenant data (same
  // class as memory:*, partitioned by owner not workspace). The flagship flow —
  // `sessions:search { session:'self' }` compaction recovery — runs from
  // workspace-scoped psu sessions, exactly the caller the clamp would deny.
  'sessions:search',
  'sessions:read',
  'sessions:list',
  'sessions:timeline',
  // sessions:digest (EI-10888, added AFTER this allowlist's original P-005/P-006 pass —
  // EI-13175: it was never backported here, so a workspace-scoped psu session got
  // `workspace_forbidden` on a tool it never asked to span workspaces with). Same
  // self-confining profile as its sessions:* siblings above: its query filters
  // `WHERE (workspace_id = ctx.workspaceId OR workspace_id = 'default')` (digest.ts) —
  // it never reads another workspace's tenant data from a scoped caller.
  'sessions:digest',
  // pot_git:secrets_exemptions (WI-6641) — the RUNTIME, no-restart recovery lever
  // for a secrets-guard false positive (WI-5591). Its table is keyed BY workspace
  // (PK (workspace_id, path)) and every read/write filters on it, so a scoped call
  // is well-defined; crossWorkspace:true is here only so an UNSCOPED psu gets the
  // getOrgPg admin handle — the memory:*/autonomy:record_disposition profile. The
  // handler now REFUSES an explicit `workspaceId` naming another workspace, so a
  // scoped caller cannot cross out (self-confinement, secrets_exemptions.ts).
  //
  // Why this one matters more than the count suggests: a false positive FREEZES
  // ALL git egress for the hive until it is cleared (the guard baseline never
  // advances past a refused range, so the same blob is re-refused forever), and
  // the refusal message instructs the reader to run exactly this tool. Every
  // ordinary agent that trips the guard is workspace-scoped, so the documented
  // remedy was unreachable by precisely the population that needs it — the
  // EI-1810 failure shape, and a plausible reason the class kept recurring (this
  // was at least its third occurrence; it froze the publish plane ~8h on
  // 2026-07-28 while the fix had to be applied by hand with psql).
  'pot_git:secrets_exemptions',
]);

/** Whether a crossWorkspace tool is safe to call from a SCOPED superuser session —
 *  it SELF-CONFINES to the caller's own workspace (EI-1810). Self-confinement is
 *  the whole criterion; read-only is NOT required and never was — memory:remember /
 *  :update / :forget and autonomy:record_disposition are writes, and they qualify
 *  because they resolve their scope from the caller's principal and cannot be
 *  pointed at another workspace. A tool that accepts a caller-supplied workspace
 *  target does NOT qualify until it refuses a foreign one (cf. WI-6641).
 *  P-019: the runtime clamp:set_safe_tools dial can NARROW this allowlist (tighten-only) — a tool in
 *  the operator's safeToolsRemove set is treated as NOT safe (the clamp then denies it from a scoped
 *  session). It can only REMOVE entries, never add, so it can only tighten the cross-workspace gate. */
function isScopedSafeCrossWorkspaceTool(toolName: string): boolean {
  return SCOPED_SAFE_CROSSWORKSPACE.has(toolName) && !authSafeToolsRemoveSet().has(toolName);
}

/**
 * GLOBAL-config superuser admin tools exempt from the clamp's crossWorkspace denial.
 *
 * RATIONALE (security review — scoped-superuser-clamp follow-up). The clamp's threat
 * model is a scoped superuser reading another workspace's tenant DATA (a `crossWorkspace`
 * tool runs on the getOrgPg admin handle, which bypasses per-workspace RLS). The
 * `flags:*` family is categorically different: it is the ONE GLOBAL feature-flag store —
 * there is no per-workspace flag data, so confining it to a workspace protects no tenant
 * data. And denying it creates a CIRCULAR LOCKOUT: `flags:set` is the very control that
 * GOVERNS the clamp — a scoped superuser otherwise cannot disable the clamp (or flip any
 * global flag) without it, locking the operator out of its own controls. A superuser is
 * already god-mode at dispatch (`isSuperuser` bypasses role gates); managing GLOBAL config
 * is squarely within that authority. So the flag-admin family is reachable even from a
 * scoped superuser session. This widens NO per-workspace DATA reach — only the
 * global-config meta-controls. (Reviewed in the gate, not a self-asserted per-tool flag,
 * per the SCOPED_SAFE_CROSSWORKSPACE convention above.)
 */
const SUPERUSER_GLOBAL_FLAG_ADMIN: ReadonlySet<string> = new Set(['flags:get', 'flags:set', 'flags:list']);

/** Whether a tool is a GLOBAL-config superuser meta-control (the flag system) that a
 *  scoped superuser may reach despite the clamp — no tenant-data reach (see above). */
function isSuperuserGlobalFlagAdmin(toolName: string): boolean {
  return SUPERUSER_GLOBAL_FLAG_ADMIN.has(toolName);
}

/**
 * EI-22068944239934723: LAUNCH-shaped tools whose cross-hive `harness_forbidden` refusal
 * should also name the sanctioned route.
 *
 * The clamp itself is CORRECT and must not widen — it is the cross-tenant boundary
 * (P-006/P-007/P-008), so a papercusp-scoped session must not be able to launch a fleet
 * into a sibling hive. But `work_items:claim` and `work_items:get` already get tailored
 * cross-hive routes in this refusal while launch-shaped tools got a bare "no". The
 * reporting session held a goal worklist that legitimately named another hive's plan,
 * hit the bare refusal, and read it as "this work cannot be materialized at all" rather
 * than "this is the wrong door" — so it stopped instead of routing. A boundary that is
 * right to refuse is still wrong to refuse WITHOUT naming where the work can go.
 */
const CROSS_HIVE_LAUNCH_TOOLS: ReadonlySet<string> = new Set([
  'fleet:launch-on-plan',
  'fleet:create',
  'capability:launch-agent',
]);

/** The cross-hive route hint for a launch-shaped tool, or '' for any other tool. */
export function crossHiveLaunchHint(toolName: string, scopeHive: string): string {
  if (!CROSS_HIVE_LAUNCH_TOOLS.has(toolName)) return '';
  return (
    ` Launching into another hive is not available from a session confined to "${scopeHive}", by design. ` +
    'Either run the fleet from a session scoped to THAT hive, or use discovery:pots → pot:request_work ' +
    '(with an outbound work-request grant) to ask the owning Pot to do the work in its own domain. ' +
    "Note that `hive` on fleet:launch-on-plan selects which shared hive's federated SEAT-OFFERS to place " +
    "onto for placement:'remote' — it is a cross-MACHINE knob, not a cross-hive harness escape, so passing " +
    'it here will not lift this refusal.'
  );
}

/**
 * EI-22387683489943406: tools whose cross-hive refusal costs LATENCY rather than
 * work, because the target install already runs the same action for itself on a
 * schedule.
 *
 * The clamp is correct and must not widen — only PLATFORM_POT_SLUG gets the narrow
 * exemption below. But the bare refusal reads as "your work is stranded": the caller
 * asked for a commit, was told no, and was given nothing saying a commit is coming
 * anyway. Measured 2026-09-05: a session confined to `sb-devboard-hive` hit this
 * against `portal`, filed it as a MAJOR bug asserting "so WI-2142851 files remain
 * uncommitted" — and that consequence was false. `portal`'s own durable git-sync
 * routine committed that checkout 11 times in the following 100 minutes. Every
 * install carries its own git-sync routine (73/73 at the time of measurement), so
 * the refusal costs one cadence tick, not the commit.
 *
 * Six of those 73 were stale, so this hint must ROUTE TO A PROBE rather than promise
 * a sweep: the honest answer is "verify, and escalate only if that install's routine
 * is inactive". Same lesson as CROSS_HIVE_LAUNCH_TOOLS above — a boundary that is
 * right to refuse is still wrong to refuse without naming what happens next.
 */
const CROSS_HIVE_SELF_SWEEPING_TOOLS: ReadonlySet<string> = new Set(['git-sync:run']);

/**
 * The "this is latency, not lost work" hint for a self-sweeping tool, or '' for any
 * other tool.
 */
export function crossHiveSelfSweepHint(toolName: string, slug: string, scopeHive: string): string {
  if (!CROSS_HIVE_SELF_SWEEPING_TOOLS.has(toolName)) return '';
  return (
    ` This refusal costs LATENCY, not work: "${slug}" runs its own git-sync routine, which commits that ` +
    `checkout on its own cadence regardless of who fires it, so a session confined to "${scopeHive}" does ` +
    'not need to fire it. Before reporting the work uncommitted, wait one tick and verify against the ' +
    "checkout itself — TZ=UTC git -C <that checkout> log -3 --date=iso-strict-local --format='%cd %h %s'. " +
    "Escalate only when that verification shows the sweep is NOT happening (the install's git-sync routine " +
    'is inactive or failing); a refused manual fire is not by itself evidence of stranded work.'
  );
}

/**
 * EI-20206112532711097: docs-surface tools, whose `harness:'all'` refusal must name
 * `harness:'engineering'`.
 *
 * The clamp is CORRECT and must not widen — `'all'` is the cross-workspace escape and a
 * workspace-scoped session may not use it. But this refusal is worse than the bare "no"
 * that CROSS_HIVE_LAUNCH_TOOLS above was written for: its generic repair, "Name a concrete
 * harness in scope", is ACTIVELY WRONG for a docs read. The reporting session followed it
 * to `harness:'papercusp'` and got a different corpus — `resolveDocsHarness` maps the
 * `'engineering'` sentinel and `'all'` to the SAME `{ harnessSlug: 'papercusp',
 * engineering: true }` reference, while a plain `'papercusp'` resolves to
 * `engineering: false`, that harness's OWN doc surface, which does not contain
 * agent-insights/ or the framework reference.
 *
 * So the wrong repair does not fail loudly — it returns a weak or empty result from the
 * wrong corpus, which reads exactly like "no such page exists". That is the false-negative
 * class docs:search's own guidance already fights (EI-18894866320087268); this hint stops
 * the refusal from manufacturing it one layer earlier.
 *
 * `docs:index` / `docs:section` are excluded deliberately: they accept no `harness` arg, so
 * this branch can never fire for them.
 */
const ENGINEERING_DOCS_SURFACE_TOOLS: ReadonlySet<string> = new Set([
  'docs:get',
  'docs:search',
  'docs:outline',
  'docs:author',
]);

/** The `harness:'engineering'` repair for a docs-surface tool, or '' for any other tool. */
export function engineeringDocsSurfaceHint(toolName: string): string {
  if (!ENGINEERING_DOCS_SURFACE_TOOLS.has(toolName)) return '';
  return (
    " For a docs surface the in-scope repair is `harness:'engineering'`, NOT a concrete harness slug: " +
    "'engineering' resolves to the SAME engineering-reference corpus `harness:'all'` would have read " +
    '(agent-insights/ and the Papercusp framework reference), so substituting it loses nothing. Naming ' +
    "the harness that owns those docs instead (`harness:'papercusp'`) reads that harness's own doc " +
    'surface, which does NOT contain them — a weak or empty result there is the wrong corpus, not an ' +
    'absent page.'
  );
}

/**
 * EI-22344259264889593 / EI-22344366831358072: a session may execute in a
 * repo-less Hive while its canonical editable checkout remains the workspace's
 * platform/self Pot. The generic Hive clamp rejected both halves of the one
 * operational seam such a session needs: firing `git-sync:run` and inspecting
 * that exact routine through `routines:list`.
 *
 * This is deliberately NOT a general cross-Hive exception. Both tools must name
 * PLATFORM_POT_SLUG through one of their documented target spellings. The read
 * additionally requires the exact `git-sync` name filter and forbids rollup
 * because routines:list ignores its install/name filters in rollup mode. Thus it
 * can expose at most the single canonical git-sync row; broad routine reads and
 * arbitrary sibling targets remain forbidden.
 */
function isExplicitPlatformPotGitSyncTarget(toolName: string, arg: string, slug: string, callArgs: unknown): boolean {
  if ((arg !== 'installSlug' && arg !== 'harness') || slug !== PLATFORM_POT_SLUG) return false;
  if (toolName === 'git-sync:run') return true;
  if (toolName !== 'routines:list' || !callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) {
    return false;
  }
  const routineArgs = callArgs as Record<string, unknown>;
  return routineArgs.name === 'git-sync' && routineArgs.rollup !== true;
}

/**
 * The routine table also has deliberate harness-less hosts (`@...` and the
 * workspace id). They are not tenant harnesses, so the hive clamp must not
 * mistake an exact, one-row routine operation for a cross-hive escape. Keep
 * this exception narrower than a general reserved-slug allowlist: only the
 * documented routine control/read tools, only their install-slug spellings,
 * and only an exact routine name are admitted. Broad reads, rollups, and all
 * other tools remain behind the ordinary hive boundary.
 */
function isExplicitReservedHarnesslessRoutineTarget(
  toolName: string,
  arg: string,
  slug: string,
  callArgs: unknown,
  workspaceId: string,
): boolean {
  if ((arg !== 'installSlug' && arg !== 'harness') || !isReservedHarnesslessRoutineHost(slug, workspaceId)) {
    return false;
  }
  if (!callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) return false;
  const routineArgs = callArgs as Record<string, unknown>;
  const routineName = typeof routineArgs.name === 'string' ? routineArgs.name.trim() : '';
  if (!routineName || routineName === '*' || routineName.toLowerCase() === 'all') return false;
  if (toolName === 'routines:set') return arg === 'installSlug';
  return toolName === 'routines:list' && routineArgs.rollup !== true;
}

/**
 * Parse the seven per-spawn URL params and return a partial
 * UnifiedToolContext fragment. Returns null if any required params are
 * missing — the caller falls back to built-in-only listing (e.g. dev
 * pings against /api/mcp without harness context).
 */
export interface BuiltSpawnContext {
  workspaceId: string;
  /**
   * WI-6734: set to `'registry-fallback'` ONLY when this ctx's `workspaceId` was
   * NOT resolved from an explicit param/header/adv-session lookup, but GUESSED
   * from the box's active-workspace registry (the scoped-superuser-clamp's
   * untracked-session fallback, `activeWorkspaceId()`). That guess can be wrong
   * for a multi-workspace box, and every downstream tool call then silently
   * scopes to the wrong tenant — surfacing as a confident, well-formed
   * NOT-FOUND/empty result for data that is provably present elsewhere. Absent
   * (the overwhelmingly common case) means the workspace was actually resolved.
   * Consumed by `withMcpDiagnosticWarnings` to annotate every tool result for the
   * rest of this session, so a caller reading an unexpected empty/not-found
   * result is told to suspect scoping before concluding data loss.
   */
  workspaceResolution?: 'registry-fallback';
  /**
   * Millisecond timestamp stamped by the local MCP proxy after a recent
   * upstream retry/failure. Diagnostic only: it never changes dispatch or auth.
   */
  dataPlaneDegradedAtMs?: number;
  harnessSlug: string;
  role: AgentRole;
  featureId: string | null;
  chunkId: string | null;
  runId: string;
  spawnId: string;
  parentSpawnId: string | null;
  uiClientId: string | null;
  /** Private detector-only session key; never used as public coordination identity. */
  detectorSessionKey: string | null;
  /**
   * The CALLING agent's CLI backend + model, stamped by the launcher onto the session MCP URL
   * (`?agent=`/`?model=`; omp also via the `x-papercusp-agent`/`-model` headers). Folded onto the
   * tool ctx so fleet:launch-on-plan can inherit the caller's backend/model for a fleet it spawns
   * (fleet-launch-agent-inheritance-2026-07-03). Null when the launcher didn't stamp them.
   */
  callerAgent?: string | null;
  callerModel?: string | null;
  /**
   * True when this ctx's spawn-URL HMAC was VERIFIED (branch 2 below) — never
   * set on the unsigned soft-warn path. resolveAgentIdentity's 'signed-spawn'
   * branch keys on it to attribute client=-less invoke-route agents to the
   * stable harness slug (promote-policy-and-waves-2026-05-30 D-002, owner
   * option (c): least privilege — no su/power grant, never spawnId/runId).
   */
  sigVerifiedSpawn?: boolean;
  admissionRecoveryAuthority?: AdmissionRecoveryAuthority;
  /**
   * Plan-run conversation id, from `?plan_run=<uuid>` on the MCP URL.
   * Set by the plan-agent runner (plan-agent-launch-2026-05-21, P-011)
   * so `plans:*` write verbs attribute revisions to the launched run.
   * Null for every non-plan-run caller. Provenance label only.
   */
  planRunSessionId?: string | null;
  isSuperuser?: boolean;
  /**
   * True for the `workspace-power-user` tier (`?power_user=1`). These
   * calls run at the dispatch layer like superuser (`isSuperuser` is
   * also set) for the role-allowlist + capability bypass, but differ
   * in two ways: `workspaceId` is clamped to the verified token's
   * claim (never the URL), and the quota gate is NOT bypassed —
   * workspace quotas apply to power-users. See dispatch-stack.ts
   * quotaStep and the host quota policy (agent-mcp quota-policy.ts
   * papercuspComputeQuotaWindow, wired via PROJECTED_DEPS).
   */
  isPowerUser?: boolean;
  /**
   * Resolved caller profile — `'power'` for power-user tokens or SU
   * callers passing `?profile=power`; `'engineer'` otherwise.
   * Forwarded to `UnifiedToolContext.profile` for tool-list filtering
   * and call gating in the dispatcher.
   */
  profile?: 'engineer' | 'power' | 'generic';
  /**
   * Session payload tier (context-trimming-tiers D-004), from `?ctx_tier=`
   * on the MCP URL — env-expanded from PAPERCUSP_CONTEXT_TIER by psu (the
   * same channel as `?tools=`). Forwarded to `UnifiedToolContext.contextTier`
   * so defineTool `shape` projections apply; absent/invalid ⇒ 'full'
   * (unshaped — today's behavior, byte-identical).
   */
  contextTier?: PayloadTier;
  requestOrigin?: RequestOriginMetadata;
  /** Verified short-lived PI bearer used by a public Papercup chat mount. */
  authenticatedPrincipal?: Principal;
  /** Explicit proof that this MCP mount has a live interactive card responder. */
  interactiveCardCapability?: true;
}

type TransportClampTool = {
  name?: string;
  crossWorkspace?: boolean;
  profile?: string;
};

type ScopedSuperuserTransportClampResult =
  | {
      ok: true;
      args: Record<string, unknown>;
      effectiveHarnessSlug: string;
      scopedSuperuserClamp: boolean;
    }
  | { ok: false; result: McpCallResult };

/**
 * A loop carry-note READ is a recovery operation, not a cross-hive data escape:
 * `loop:checkpoint` explicitly documents `harness` as the way to read a note that
 * was stranded under another scope. Issue-family `work_items:checkpoint` writes
 * use the same narrow transport exception because EI-prefixed work items resolve
 * workspace-wide; the handler remains authoritative for the item's assignee and
 * refuses a write when its `not_holder` guard fails.
 *
 * Keep this exception narrow. It requires a concrete harness and either an omitted
 * ownerId (the normal self-read), the transport caller's resolved identity, or an
 * EI-prefixed checkpoint id. The wildcard/global harness spellings, feature-family
 * checkpoint ids, and another owner's loop note remain behind the regular hive
 * clamp.
 */
function isSelfOwnedCheckpointTransportException(
  toolName: string,
  callArgs: Record<string, unknown>,
  spawnCtx: BuiltSpawnContext,
): boolean {
  const requestedHarness = typeof callArgs.harness === 'string' ? callArgs.harness.trim() : '';
  if (!requestedHarness || requestedHarness === '*' || requestedHarness.toLowerCase() === 'all') return false;

  if (toolName === 'work_items:checkpoint') {
    // Match work_items:checkpoint's own runBulk selection: a non-empty `items`
    // array wins over the shorthand `id`, while an empty array falls back to it.
    // The handler's workspace-wide EI lookup plus `not_holder` check is the
    // authority for whether the resolved item is actually writable by this caller.
    const rawItems = Array.isArray(callArgs.items) && callArgs.items.length > 0
      ? callArgs.items
      : [callArgs.id];
    if (rawItems.length === 0) return false;

    return rawItems.every((rawItem) => {
      const id =
        rawItem && typeof rawItem === 'object'
          ? (rawItem as Record<string, unknown>).id
          : rawItem;
      return typeof id === 'string' && id.trim().startsWith('EI-');
    });
  }

  if (toolName !== 'loop:checkpoint' || callArgs.read !== true) return false;

  const requestedOwnerId = typeof callArgs.ownerId === 'string' ? callArgs.ownerId.trim() : '';
  if (!requestedOwnerId) return true;

  // The clamp runs only for scoped superuser contexts, and the same resolver is
  // what loop:checkpoint uses in its handler. In particular, client-less SU calls
  // resolve to the stable `su-loopback` identity rather than a per-request spawn id.
  return requestedOwnerId === resolveAgentIdentity(spawnCtx).ownerId;
}

/**
 * The coord:presence tool accepts singular and bounded collection aliases for
 * its targeted owner selector. Keep the transport hive-clamp exemption aligned
 * with that public schema before the tool boundary normalizes aliases to
 * `owner`/`owners`; otherwise an exact `ownerId` lookup is rejected before the
 * handler can honor the targeted workspace-wide exception.
 */
function hasTargetedPresenceSelector(callArgs: Record<string, unknown> | null): boolean {
  if (!callArgs) return false;
  const singular = ['owner', 'ownerId'].some(
    (key) => typeof callArgs[key] === 'string' && (callArgs[key] as string).trim().length > 0,
  );
  const bounded = ['owners', 'ownerIds'].some(
    (key) =>
      Array.isArray(callArgs[key]) &&
      (callArgs[key] as unknown[]).some((value) => typeof value === 'string' && value.trim().length > 0),
  );
  return singular || bounded;
}

/**
 * Keep the goal-authorized local placement escape identical on the direct and
 * nested MCP paths. The session SID is the stable owner for superuser calls;
 * signed spawns have no SID and use their stable spawn id instead.
 */
async function mayUseGoalLocalPlacement(
  toolName: string,
  spawnCtx: BuiltSpawnContext,
  scopeHive: string,
  targetHarness: string,
): Promise<boolean> {
  if (!CROSS_HIVE_LAUNCH_TOOLS.has(toolName)) return false;
  return goalHolderMayPlaceIntoLocalPot({
    workspaceId: spawnCtx.workspaceId,
    callerOwnerId: spawnCtx.uiClientId ?? spawnCtx.spawnId,
    scopeHive,
    targetHarness,
  });
}

/**
 * Apply the request-level profile, workspace, and hive clamps before a projected
 * tool runs. This is deliberately shared by direct `tools/call` and the nested
 * `ctx.dispatchTool` path behind `tools:invoke`: nested dispatch is still the
 * same caller's transport request and must not become a privilege bridge.
 */
async function applyScopedSuperuserTransportClamp(
  tool: TransportClampTool,
  spawnCtx: BuiltSpawnContext,
  inputArgs: Record<string, unknown>,
): Promise<ScopedSuperuserTransportClampResult> {
  const toolName = tool.name ?? '<unnamed tool>';
  let args = inputArgs;
  let effectiveHarnessSlug = spawnCtx.harnessSlug;
  const scopedSuperuserClamp =
    spawnCtx.isSuperuser === true &&
    spawnCtx.workspaceId !== '*' &&
    (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system'));

  if (spawnCtx.profile === 'power' && tool.profile === 'engineer') {
    return {
      ok: false,
      result: {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `tool_not_available_for_profile: "${toolName}" is not available in the power-engineer profile`,
          },
        ],
      },
    };
  }

  if (
    scopedSuperuserClamp &&
    tool.crossWorkspace === true &&
    !isScopedSafeCrossWorkspaceTool(toolName) &&
    !isSuperuserGlobalFlagAdmin(toolName)
  ) {
    return {
      ok: false,
      result: {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `workspace_forbidden: "${toolName}" spans workspaces, but this session is scoped to workspace "${spawnCtx.workspaceId}". Use an unscoped (--all-workspaces) superuser session to span workspaces.`,
          },
        ],
      },
    };
  }

  if (scopedSuperuserClamp) {
    const requestedHarness = typeof args.harness === 'string' ? args.harness.trim() : '';
    if (requestedHarness === 'all' || requestedHarness === '*') {
      if ((toolName === 'plans:list' || toolName === 'loop:arm') && spawnCtx.harnessSlug === '*') {
        const rest = { ...args };
        delete rest.harness;
        args = toolName === 'plans:list' ? { ...rest, workspaceWide: true } : rest;
      } else {
        return {
          ok: false,
          result: {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `harness_forbidden: harness:'${requestedHarness}' is the unscoped global escape; this session is scoped to workspace "${spawnCtx.workspaceId}". Name a concrete harness in scope, or use an unscoped (--all-workspaces) session.${engineeringDocsSurfaceHint(toolName)}`,
              },
            ],
          },
        };
      }
    }
  }

  if (scopedSuperuserClamp) {
    const requestedHarness = typeof args.harness === 'string' ? args.harness.trim() : '';
    if (requestedHarness && requestedHarness !== 'all' && requestedHarness !== '*') {
      const { resolveWorkspaceForHarnessSlugIn } = await import('../../../harness-core');
      let harnessWorkspace: string | null = null;
      try {
        harnessWorkspace = await resolveWorkspaceForHarnessSlugIn(spawnCtx.workspaceId, requestedHarness);
      } catch {
        // Ambiguous collisions and infrastructure failures fail open; the target
        // tool remains responsible for reporting an unresolved harness.
        harnessWorkspace = null;
      }
      if (harnessWorkspace && harnessWorkspace !== spawnCtx.workspaceId) {
        return {
          ok: false,
          result: {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `harness_forbidden: harness "${requestedHarness}" belongs to workspace "${harnessWorkspace}", but this session is scoped to workspace "${spawnCtx.workspaceId}". Name a harness in scope, or use an unscoped (--all-workspaces) superuser session.`,
              },
            ],
          },
        };
      }
    }
  }

  if (scopedSuperuserClamp && spawnCtx.harnessSlug !== '*') {
    const { potHomeSlugForHarness } = await import('../../../hive-federation');
    const { collectHarnessSlugArgs } = await import('../../hive-harness-arg-coverage');
    const scopeHive = await potHomeSlugForHarness(spawnCtx.workspaceId, spawnCtx.harnessSlug);
    if (scopeHive) {
      if (toolName.startsWith('cross_harness:')) {
        return {
          ok: false,
          result: {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `harness_forbidden: "${toolName}" reads other harnesses, but this session is confined to hive "${scopeHive}".`,
              },
            ],
          },
        };
      }

      const requestedHarness = typeof args.harness === 'string' ? args.harness.trim() : '';
      if (requestedHarness) {
        const isEngineeringDocsSurface =
          isEngineeringDocsSentinel(requestedHarness) &&
          (toolName === 'docs:get' ||
            toolName === 'docs:search' ||
            toolName === 'docs:outline' ||
            toolName === 'docs:author');
        const isPlatformPotGitSyncTarget = isExplicitPlatformPotGitSyncTarget(
          toolName,
          'harness',
          requestedHarness,
          args,
        );
        const isReservedHarnesslessRoutineTarget = isExplicitReservedHarnesslessRoutineTarget(
          toolName,
          'harness',
          requestedHarness,
          args,
          spawnCtx.workspaceId,
        );
        const isSelfOwnedCheckpointRead = isSelfOwnedCheckpointTransportException(toolName, args, spawnCtx);
        const escapesHive =
          !isEngineeringDocsSurface &&
          !isPlatformPotGitSyncTarget &&
          !isReservedHarnesslessRoutineTarget &&
          !isSelfOwnedCheckpointRead &&
          (requestedHarness === 'all' ||
            requestedHarness === '*' ||
            (await potHomeSlugForHarness(spawnCtx.workspaceId, requestedHarness)) !== scopeHive);
        // A resumed session may retain an ambient Hive while naming one exact,
        // store-backed plan. Read/decision recovery and the structured plan-lane
        // declaration share the same owner proof; every other tool keeps the
        // normal sibling-Hive rejection.
        const verifiedExactPlanRebind =
          escapesHive &&
          (toolName === 'plans:get' || toolName === 'plans:add-decision' || toolName === 'coord:declare-intent') &&
          (await verifyExplicitPlanHarness(spawnCtx, requestedHarness, args));
        const goalLocalPlacement =
          escapesHive && (await mayUseGoalLocalPlacement(toolName, spawnCtx, scopeHive, requestedHarness));
        if (verifiedExactPlanRebind || goalLocalPlacement) {
          effectiveHarnessSlug = requestedHarness;
        } else if (escapesHive) {
          const crossHiveClaimHint =
            toolName === 'work_items:claim'
              ? ' For cross-Pot work, use discovery:pots → pot:request_work with an outbound work-request grant; direct work_items:claim is per-Hive.'
              : '';
          const requestedIds: unknown[] = [];
          if (typeof args.id === 'string') requestedIds.push(args.id);
          if (Array.isArray(args.ids)) requestedIds.push(...args.ids);
          const allRequestedIdsAreIssueFamily =
            requestedIds.length > 0 && requestedIds.every((id) => typeof id === 'string' && id.startsWith('EI-'));
          const crossHiveWorkItemReadHint =
            toolName === 'work_items:get'
              ? allRequestedIdsAreIssueFamily
                ? ` For an ID-based work_items:get read, retry with the caller's harness "${spawnCtx.harnessSlug}" (or omit \`harness\` entirely); do not copy a returned row's canonical harness into this argument. An EI-prefixed id resolves WORKSPACE-wide — the \`harness\` argument is not applied to that lookup at all — so this retry WILL find the row.`
                : ` For an ID-based work_items:get read, retry with the caller's harness "${spawnCtx.harnessSlug}"; do not copy a returned row's canonical harness into this argument. Note: a WI-/F- (feature-family) id genuinely IS scoped to its owning harness, so this retry will NOT resolve a row that belongs to a different one — there is currently no cross-hive escape for a feature-family id from a hive-confined session.`
              : '';
          return {
            ok: false,
            result: {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `harness_forbidden: harness "${requestedHarness}" is outside this session's hive "${scopeHive}".${crossHiveClaimHint}${crossHiveWorkItemReadHint}${crossHiveLaunchHint(toolName, scopeHive)}${crossHiveSelfSweepHint(toolName, requestedHarness, scopeHive)}`,
                },
              ],
            },
          };
        }
      }

      const requestedHarnessSlug = typeof args.harness_slug === 'string' ? args.harness_slug.trim() : '';
      if (requestedHarnessSlug) {
        const escapesHive =
          requestedHarnessSlug === 'all' ||
          requestedHarnessSlug === '*' ||
          (await potHomeSlugForHarness(spawnCtx.workspaceId, requestedHarnessSlug)) !== scopeHive;
        if (escapesHive) {
          return {
            ok: false,
            result: {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `harness_forbidden: harness_slug "${requestedHarnessSlug}" is outside this session's hive "${scopeHive}".`,
                },
              ],
            },
          };
        }
      }

      const scopeArgRaw = typeof args.scope === 'string' ? args.scope.trim() : '';
      if (scopeArgRaw) {
        let scopeRefRaw = '';
        for (const key of ['scopeRef', 'scope_ref', 'ref']) {
          if (typeof args[key] === 'string' && (args[key] as string).trim()) {
            scopeRefRaw = (args[key] as string).trim();
            break;
          }
        }
        const scopeNamedHarness = scopeArgRaw.startsWith('harness:')
          ? scopeArgRaw.slice('harness:'.length).trim()
          : scopeArgRaw === 'harness'
            ? scopeRefRaw
            : '';
        if (scopeNamedHarness) {
          const escapesHive =
            scopeNamedHarness === 'all' ||
            scopeNamedHarness === '*' ||
            (await potHomeSlugForHarness(spawnCtx.workspaceId, scopeNamedHarness)) !== scopeHive;
          if (escapesHive) {
            return {
              ok: false,
              result: {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `harness_forbidden: scope "${scopeArgRaw}" names harness "${scopeNamedHarness}", which is outside this session's hive "${scopeHive}". A cross-hive item filed this way could not later be claimed, commented on, or closed by this session.`,
                  },
                ],
              },
            };
          }
        }
      }

      const requestedHive = typeof args.hive === 'string' ? args.hive.trim() : '';
      if (requestedHive && requestedHive !== scopeHive) {
        return {
          ok: false,
          result: {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `hive_forbidden: hive "${requestedHive}" is outside this session's hive "${scopeHive}".`,
              },
            ],
          },
        };
      }

      for (const { arg, slug } of collectHarnessSlugArgs(args, { toolName })) {
        if (
          isExplicitPlatformPotGitSyncTarget(toolName, arg, slug, args) ||
          isExplicitReservedHarnesslessRoutineTarget(toolName, arg, slug, args, spawnCtx.workspaceId)
        ) continue;
        const escapesHive =
          slug === 'all' || slug === '*' || (await potHomeSlugForHarness(spawnCtx.workspaceId, slug)) !== scopeHive;
        if (escapesHive) {
          return {
            ok: false,
            result: {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `harness_forbidden: ${arg} "${slug}" names a harness outside this session's hive "${scopeHive}". A cross-hive call made this way could not later be claimed, commented on, or closed by this session.${crossHiveSelfSweepHint(toolName, slug, scopeHive)}`,
                },
              ],
            },
          };
        }
      }

      const targetedPresenceOwner = toolName === 'coord:presence' && hasTargetedPresenceSelector(args);
      const forbiddenPresenceScope =
        toolName === 'coord:presence' &&
        (args.scope === 'all' || (args.scope === 'workspace' && !targetedPresenceOwner));
      if (forbiddenPresenceScope) {
        return {
          ok: false,
          result: {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `hive_forbidden: coord:presence scope:'${String(args.scope)}' spans past this session's hive "${scopeHive}" — browse your hive by default, or use a targeted { owner } lookup for one workspace peer.`,
              },
            ],
          },
        };
      }
    }
  }

  if ((spawnCtx.isPowerUser || scopedSuperuserClamp) && Object.keys(args).length > 0) {
    const workspaceTargetArgs = ['workspace', 'workspaceId'] as const;
    for (const key of workspaceTargetArgs) {
      if (key in args) args = { ...args, [key]: spawnCtx.workspaceId };
    }
  }

  return { ok: true, args, effectiveHarnessSlug, scopedSuperuserClamp };
}

/**
 * Outcome of building a spawn ctx from an inbound MCP request:
 *   - `none` — no URL params at all; legacy bearer dispatch may apply.
 *   - `ok` — verified (or superuser-bypassed) spawn ctx.
 *   - `failed` — URL claimed a spawn ctx but verification failed.
 *               Caller MUST reject (do NOT fall through to bearer).
 */
export type TrySpawnContextResult =
  | { kind: 'none' }
  | { kind: 'ok'; ctx: BuiltSpawnContext }
  | { kind: 'failed'; reason: string };

// In-process, per-request authority carrier for authenticated connection
// transports. Never read a client-supplied `_meta` field as a verified context.
const verifiedConnectionRequests = new WeakMap<object, BuiltSpawnContext>();

export function pinVerifiedMcpRequest(
  requestInfo: object,
  ctx: BuiltSpawnContext,
  connection?: 'uds',
): object {
  const pinned = Object.freeze({ ...requestInfo });
  verifiedConnectionRequests.set(pinned, connection ? {
    ...ctx,
    // Only the in-process listener supplies this value. Never infer the
    // physical connection from model metadata or credential URL/header text.
    requestOrigin: { ...ctx.requestOrigin, transport: 'mcp', connection },
  } : ctx);
  return pinned;
}

/**
 * Build the per-call spawn context from URL params + headers.
 *
 * Three entry shapes:
 *   1. `?superuser=1` + loopback + valid bearer → operator-tier ctx,
 *      no signature check (the bearer file IS the credential).
 *   2. Per-spawn URL with `harness=&workspace=&role=&run=&spawn=&exp=&sig=`
 *      — sig is verified via HMAC against the PG-stored signing key.
 *      Failures are logged to spawn_sig_verification_failures.
 *   3. Unsigned URL (no sig, no exp) — only honored when
 *      PAPERCUSP_REQUIRE_SPAWN_SIG != '1'. As of 2026-05-11 the
 *      operator runs with PAPERCUSP_REQUIRE_SPAWN_SIG=1 by default
 *      (apps/operator/.env.local), so unsigned URLs hard-reject and
 *      the soft-warn fallback below is dead code unless someone
 *      explicitly unsets the env var. Kept for the (uncommon) case
 *      of re-rolling out a new signing scheme.
 */
export async function tryBuildSpawnContext(
  extra: unknown,
  options: { allowStalePlanRecovery?: boolean } = {},
): Promise<TrySpawnContextResult> {
  const info = (extra as { requestInfo?: object } | undefined)?.requestInfo;
  const verified = info && verifiedConnectionRequests.get(info);
  if (verified) return { kind: 'ok', ctx: verified };
  const url = urlFromExtra(extra);
  if (!url) return { kind: 'none' };
  const requestOrigin = buildMcpRequestOrigin(extra);
  const dataPlaneDegradedAtMs = mcpDataPlaneDegradedAtFromExtra(extra);

  // Plan-run provenance (plan-agent-launch-2026-05-21, P-006). Folded
  // onto every built ctx below; the plan-agent runner (P-011) sets it,
  // it is null for all other callers. A provenance label for plan
  // revisions, never a gate — read anywhere is safe.
  const planRunSessionId = (url.searchParams.get('plan_run') ?? '').trim() || null;
  // Private detector identity is transported independently from the public
  // coordination owner. Signed spawns parse it below through parseRequestContext;
  // privileged transports do not use that parser, so preserve the same optional
  // query carrier here instead of silently collapsing detector state by owner.
  const detectorSessionKey = (url.searchParams.get('detector') ?? '').trim() || null;

  // ── (1) Superuser ───────────────────────────────────────────────
  if (url.searchParams.get('superuser') === '1') {
    const headers = headersFromExtra(extra);
    if (!isLoopbackRequest(headers)) return { kind: 'failed', reason: 'superuser_non_loopback' };
    const bearer = bearerFromExtra(extra);
    if (!isValidSuperuserBearer(bearer)) return { kind: 'failed', reason: 'superuser_invalid_bearer' };
    const wsParam = (url.searchParams.get('workspace') ?? '').trim();
    const harnessUrlParam = (url.searchParams.get('harness') ?? '').trim();
    const clientParam = (url.searchParams.get('client') ?? '').trim();
    // Per-session identity for SU agents (su-locks coordination), sourced
    // in precedence order:
    //   1. `x-papercusp-client` header — the per-launch PAPERCUSP_SID.
    //      Claude/Codex bake the SID into `?client=` directly (they can
    //      env-interpolate the MCP url); OMP can't interpolate its url, but
    //      it DOES resolve header values at connect time, so its mcp.json
    //      carries `x-papercusp-client: !printf %s "$PAPERCUSP_SID"`
    //      (install-standalone-mcp.sh). This is the deliberate, stable
    //      per-launch owner — and it's the SAME PAPERCUSP_SID the OMP/cc
    //      lock hook reads, so a shell's interactive calls + its hook share
    //      one owner (no manual-claim-vs-hook self-deadlock). Header-first
    //      so it overrides OMP's static per-machine `?client=`.
    //   2. `?client=` — the SID claude/codex bake into the url via env
    //      expansion (`?client=${PAPERCUSP_SID}`), and what the channel
    //      hooks (one-shot POSTs, no MCP session) use to pass a per-session
    //      id directly. EXPLICIT-SID-BEFORE-TRANSPORT-ID (EI-7066,
    //      2026-07-03): this used to rank BELOW Mcp-Session-Id, so a claude
    //      session that reconnected mid-life (a cold-loop RECYCLE respawn, a
    //      dropped MCP transport) silently swapped to a fresh per-connection
    //      identity — loop:arm keyed one ownerId but the post-reconnect
    //      loop:checkpoint keyed another, the carry-note anchored on the
    //      wrong owner, and the cold loop silently stayed warm. An explicit
    //      per-launch SID — header OR param — always outranks the transport id.
    //   3. `Mcp-Session-Id` — the Streamable-HTTP transport's per-connection
    //      id, if the server assigned one. LAST resort: it is per-CONNECTION
    //      (interactive calls and the hook are separate connections →
    //      different ids → the lock self-deadlock; reconnects → identity
    //      fracture), so it only identifies callers that supplied no SID at all.
    const headerClient = (headers.get('x-papercusp-client') ?? '').trim();
    const mcpSessionId = (headers.get('mcp-session-id') ?? '').trim();
    const suIdentity = headerClient || clientParam || mcpSessionId;
    // Workspace, in precedence order (psu-workspace-scoping fix — without
    // this, every claude/omp SU session ran as '*' and workspace-scoped
    // tools failed "no workspace transaction" regardless of the psu picker):
    //   1. `x-papercusp-workspace` header — OMP's per-launch carrier (it
    //      can't env-interpolate its mcp.json url; headers resolve at
    //      connect time via `!printf`).
    //   2. `?workspace=` URL param — claude's `${PAPERCUSP_WORKSPACE:-}`
    //      env-expanded user-level template, codex's baked per-session
    //      config, and the per-launch .mcp.json writers.
    //   3. The adv_sessions row recorded for this SID at launch — covers
    //      stale user-level configs and resumed sessions whose env lost
    //      PAPERCUSP_WORKSPACE. SID sources only (mcp-session-id is a
    //      transport id, never an adv row key).
    //   4. '*' — unscoped, exactly the pre-fix behavior.
    const headerWs = (headers.get('x-papercusp-workspace') ?? '').trim();
    let workspaceId = headerWs || wsParam;
    const sidForLookup = headerClient || clientParam;
    // Harness, same precedence as workspace above (WI-4393): `x-papercusp-harness`
    // header (OMP's per-launch carrier — omp-integration.ts's buildMcpEntry) first,
    // then `?harness=` (claude's `${PAPERCUSP_HARNESS_SLUG:-}` env-expanded url —
    // claude-integration.ts's buildClaudeMcpEntry). Without the header leg, every
    // OMP session baked a static harness-less URL and the initialize-time memory
    // prelude (buildMcpPrelude) never fired a harness-scoped recall for su-* OMP
    // sessions (zero port=initialize ledger stamps, live-verified in the WI).
    const headerHarness = (headers.get('x-papercusp-harness') ?? '').trim();
    const explicitHarness = headerHarness || harnessUrlParam;
    let harnessParam = explicitHarness;
    // A workspace supplied on the MCP URL is an explicit isolation boundary.
    // Do not let an ambient plan/claim from the session's previous workspace
    // make the new workspace unusable; the resolver may still retain any
    // binding that is valid in the selected workspace.
    const explicitWorkspaceScope = Boolean(headerWs || wsParam);
    if (!workspaceId && sidForLookup) {
      workspaceId = (await workspaceForCoordOwner(sidForLookup)) ?? '';
    }
    // WI-6734: set ONLY by the registry-fallback branch below — a GUESS, not a
    // verified resolution. Threaded onto the built ctx so the dispatch layer can
    // warn the caller that an empty/not-found result may reflect wrong-workspace
    // scoping rather than genuine absence (see withMcpDiagnosticWarnings below).
    let workspaceResolution: 'registry-fallback' | undefined;
    // scoped-superuser-workspace-clamp-2026-06-18 (P-006 / D-004), flag-gated:
    // safe-by-default. When the clamp flag is ON, a superuser session must resolve
    // to a CONCRETE workspace (which the existing effectiveDispatchWorkspace then
    // confines — a concrete workspaceId ignores any per-call `workspace` arg) OR
    // explicitly opt into unscoped god-mode. An UNRESOLVED workspace no longer
    // SILENTLY becomes '*' (the root of the demonstrated cross-workspace reach) —
    // it is rejected, so psu passes a workspace, or opts in via ?workspace=* /
    // ?all_workspaces=1 for deliberate cross-workspace admin. Flag OFF → unchanged
    // (the `workspaceId || '*'` fallback below), byte-identical.
    if (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system')) {
      const optedUnscoped = workspaceId === '*' || url.searchParams.get('all_workspaces') === '1';
      if (!workspaceId && !optedUnscoped) {
        // mcp-outage-triage-2026-07-02: an UNTRACKED session (resumed claude whose
        // env lost PAPERCUSP_WORKSPACE and whose fresh SID has no adv row — the hole
        // resumeEnvFor's doc names) used to hard-fail here, leaving the session
        // permanently TOOLLESS (the client gives up after ~4 tools/list retries).
        // Scope it to the box's active workspace instead: ONE concrete workspace
        // (registry `current` / PAPERCUSP_WORKSPACE_ID pin — never '*'), so the
        // clamp's no-silent-god-mode guarantee is intact while the session stays
        // usable. The reject remains only for the can't-happen empty resolution.
        const active = activeWorkspaceId();
        if (active) {
          console.warn(
            `[mcp] superuser session '${suIdentity || '(no sid)'}' carried no workspace and the SID→adv-row ` +
              `fallback missed — scoping to the active workspace '${active}' (registry fallback).`,
          );
          workspaceId = active;
          workspaceResolution = 'registry-fallback';
        } else {
          return { kind: 'failed', reason: 'scoped_superuser_workspace_unresolved' };
        }
      }
    }
    // P-006 (fleet-friction-remediation): every transport call now inherits a
    // missing harness through the same canonical chain used by scheduler:get_next.
    // This is the load-bearing seam for nested tools:invoke, coord:presence, and
    // events:await: they all receive this rebuilt ctx instead of each inventing a
    // session-brief-only fallback. Explicit URL/header scope still wins. A stale,
    // ambiguous, or failed durable read is a deterministic refusal; only a genuinely
    // missing binding remains operator scope ('*').
    if (sidForLookup) {
      const inheritedHarness = await resolveInheritedHarnessScope({
        explicitHarness,
        ownerId: sidForLookup,
        workspaceId: workspaceId || '*',
        sessionHarness: null,
        allowStaleAmbientFallback: explicitWorkspaceScope,
        // coord:orient is the one transport call that can re-declare intent and
        // clear a retired launch-bound plan. Keep the recovery opt-in so all
        // ordinary calls remain fail-closed on stale durable bindings.
        allowStalePlanFallback: options.allowStalePlanRecovery === true,
      });
      if (inheritedHarness.kind === 'harness') {
        harnessParam = inheritedHarness.slug;
      } else if (inheritedHarness.kind === 'all') {
        harnessParam = '*';
      } else if (inheritedHarness.reason !== 'missing') {
        const source = inheritedHarness.source ? ` at ${inheritedHarness.source}` : '';
        return {
          kind: 'failed',
          reason: `harness_scope_${inheritedHarness.reason}${source}${inheritedHarness.detail ? `: ${inheritedHarness.detail}` : ''}`,
        };
      }
    }
    // Profile: header (OMP) > URL param (claude env-expanded / install-baked).
    const headerProfile = (headers.get('x-papercusp-profile') ?? '').trim();
    const profileParam = headerProfile || url.searchParams.get('profile');
    // Role: an OPTIONAL catalog-narrowing param (token-usage-reduction P-011).
    // An operator-initiated SU-bearer spawn (writeSignedSpawnMcp branch 1)
    // carries the spawned agent's actual role here so tools/list advertises
    // that role's catalog instead of the full operator-tier surface (392
    // tools / ~291KB) — dispatch capability is unchanged (isSuperuser still
    // bypasses role gates), only the ADVERTISED surface narrows. Absent →
    // 'operator', the historical psu behavior.
    const roleParam = (url.searchParams.get('role') ?? '').trim();
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    return {
      kind: 'ok',
      ctx: {
        workspaceId: workspaceId || '*',
        ...(workspaceResolution ? { workspaceResolution } : {}),
        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),
        harnessSlug: harnessParam || '*',
        // Canonicalize old-spelling roles here too (see the matching comment on the
        // signed role-scoped branch above) — isSuperuser bypasses the gates so this
        // only affects the ADVERTISED tools/list catalog, but an old spelling should
        // still narrow to the SAME catalog its canonical name would.
        role: (roleParam ? canonicalCoordRole(roleParam) : 'operator') as AgentRole,
        featureId: null,
        chunkId: null,
        // Per-request UUID, not the 'standalone' sentinel — see
        // http-projection.ts:~233 (audit5) for the cross-cancellation
        // hazard that the shared sentinel created.
        runId: globalThis.crypto.randomUUID(),
        spawnId: `ephemeral-${Array.from(buf)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}`,
        parentSpawnId: null,
        uiClientId: suIdentity.length > 0 ? suIdentity : null,
        detectorSessionKey,
        // Caller backend + model (fleet-launch-agent-inheritance-2026-07-03): psu stamps them onto
        // the per-session MCP URL (omp: applyOmpMcpUrlParams; claude/codex: env-interpolated URL),
        // with the `x-papercusp-agent`/`-model` headers as a parallel carrier. fleet:launch-on-plan
        // reads these to default a spawned fleet's backend/model to the CURRENT caller's own.
        callerAgent:
          (headers.get('x-papercusp-agent') ?? '').trim() || (url.searchParams.get('agent') ?? '').trim() || null,
        callerModel:
          (headers.get('x-papercusp-model') ?? '').trim() || (url.searchParams.get('model') ?? '').trim() || null,
        planRunSessionId,
        isSuperuser: true,
        admissionRecoveryAuthority: {
          kind: 'superuser',
          credentialSha256: admissionCredentialDigest(bearer!),
          role: roleParam ? canonicalCoordRole(roleParam) : 'operator',
        },
        // gateBypass is computed in buildMcpToolContext from isSuperuser/isPowerUser.
        // SU callers testing the power profile pass ?profile=power (or the
        // x-papercusp-profile header — psu's per-launch --profile carrier).
        profile: profileParam === 'power' ? 'power' : 'engineer',
        // Session payload tier (context-trimming-tiers D-004) — env-expanded by
        // psu into the user-level MCP URL, like `tools=`.
        contextTier: parsePayloadTier(url.searchParams.get('ctx_tier')),
        requestOrigin,
      },
    };
  }

  // ── (1-app) Connected-app key ────────────────────────────────────
  // external-app-access-to-workspaces-2026-09-29 P-002. An external app
  // authenticates with `Authorization: Bearer pcapp_<id>_<secret>` and nothing
  // else: the key alone names its workspace and capabilities. A presented key
  // is TERMINAL — one that does not verify is refused here, never retried as a
  // signed spawn or a local/loopback caller (plan D-015). Every URL parameter
  // that would widen or re-point authority is refused outright; an optional
  // `workspace=` must name the key's own workspace.
  const appBearer = bearerFromExtra(extra);
  if (isAppKeyShaped(appBearer)) {
    const forbidden = ['role', 'spawn', 'harness', 'sig', 'exp', 'superuser', 'power_user', 'principal'].find(
      (key) => url.searchParams.has(key),
    );
    if (forbidden) return { kind: 'failed', reason: `connected_app_forbidden_param:${forbidden}` };
    const resolved = await resolveAppKeyToken(appBearer, {
      ip: reportedClientAddress(headersFromExtra(extra)),
    });
    if (!resolved || !resolved.ok) {
      return { kind: 'failed', reason: `connected_app_invalid_key:${resolved?.reason ?? 'malformed'}` };
    }
    const principal = resolved.principal;
    const requestedWorkspace = (url.searchParams.get('workspace') ?? '').trim();
    if (requestedWorkspace && requestedWorkspace !== principal.workspaceId) {
      return { kind: 'failed', reason: 'connected_app_workspace_mismatch' };
    }
    const clientParam = (url.searchParams.get('client') ?? '').trim();
    return {
      kind: 'ok',
      ctx: {
        workspaceId: principal.workspaceId,
        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),
        harnessSlug: '*',
        role: 'papercup' as AgentRole,
        featureId: null,
        chunkId: null,
        runId: globalThis.crypto.randomUUID(),
        spawnId: principal.slug,
        parentSpawnId: null,
        uiClientId: clientParam || null,
        detectorSessionKey: null,
        planRunSessionId,
        profile: 'engineer',
        requestOrigin,
        authenticatedPrincipal: principal,
      },
    };
  }

  // ── (1a) Public Papercup PI principal ────────────────────────────
  // `workspace=` used to enter the signed-spawn parser before bearer auth, so
  // strict mode rejected this mount as an unsigned spawn. Authenticate the
  // short-lived PI bearer first and derive its workspace; its own capabilities
  // remain the dispatch gate.
  if (url.searchParams.get('principal') === 'pi') {
    const forbidden = ['role', 'spawn', 'harness', 'sig', 'exp', 'superuser', 'power_user'].find((key) =>
      url.searchParams.has(key),
    );
    if (forbidden) return { kind: 'failed', reason: `pi_principal_forbidden_param:${forbidden}` };
    const principal = await resolveBearer(bearerFromExtra(extra));
    if (!principal) return { kind: 'failed', reason: 'pi_principal_invalid_bearer' };
    if (principal.kind !== 'pi') return { kind: 'failed', reason: 'pi_principal_wrong_kind' };
    const requestedWorkspace = (url.searchParams.get('workspace') ?? '').trim();
    if (!requestedWorkspace || requestedWorkspace !== principal.workspaceId) {
      return { kind: 'failed', reason: 'pi_principal_workspace_mismatch' };
    }
    const clientParam = (url.searchParams.get('client') ?? '').trim();
    return {
      kind: 'ok',
      ctx: {
        workspaceId: principal.workspaceId,
        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),
        harnessSlug: '*',
        role: 'papercup' as AgentRole,
        featureId: null,
        chunkId: null,
        runId: globalThis.crypto.randomUUID(),
        spawnId: principal.slug,
        parentSpawnId: null,
        uiClientId: clientParam || null,
        detectorSessionKey: null,
        planRunSessionId,
        profile: 'engineer',
        requestOrigin,
        authenticatedPrincipal: principal,
        interactiveCardCapability: true,
      },
    };
  }

  // ── (1b) Power-user ─────────────────────────────────────────────
  // `?power_user=1` + loopback + valid HMAC access token. Unlike
  // superuser, the workspace is clamped to the token's claim — any
  // `?workspace=` in the URL is ignored. See power-user-token.ts and
  // docs/plans/omp-power-user-bundle-2026-05-20.md §4.1.
  if (url.searchParams.get('power_user') === '1') {
    const headers = headersFromExtra(extra);
    if (!isLoopbackRequest(headers)) {
      return { kind: 'failed', reason: 'power_user_non_loopback' };
    }
    const claims = await verifyAccessToken(bearerFromExtra(extra));
    if (!claims) {
      return { kind: 'failed', reason: 'power_user_invalid_token' };
    }
    const harnessParam = (url.searchParams.get('harness') ?? '').trim();
    const clientParam = (url.searchParams.get('client') ?? '').trim();
    // Same per-session source as the superuser path (highest precedence):
    // an OMP power-user launch carries its PAPERCUSP_SID via the
    // x-papercusp-client header (it can't interpolate the SID into the url).
    const headerClient = (headers.get('x-papercusp-client') ?? '').trim();
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    return {
      kind: 'ok',
      ctx: {
        // Clamp: workspace comes from the verified token, NOT the URL.
        workspaceId: claims.workspaceId,
        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),
        // Harness is within-workspace; resolveHarnessPaths resolves it
        // against the clamped workspace, so reading it from the URL
        // can't cross the workspace boundary.
        harnessSlug: harnessParam || '*',
        role: 'operator' as AgentRole,
        featureId: null,
        chunkId: null,
        runId: globalThis.crypto.randomUUID(),
        spawnId: `poweruser-${Array.from(buf)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}`,
        parentSpawnId: null,
        // Coordination owner identity (file-locking #2). Default: the
        // token's auth_session_id — stable per power-user session. But
        // the OMP coord hook mints a per-PROCESS owner and passes it
        // via `?client=`; when present we honor it so per-process lock
        // identity is UNCONDITIONAL — not contingent on the bundle
        // token being minted fresh per OMP launch. `uiClientId` is the
        // coordination owner LABEL only (locks / presence / messages);
        // it is NOT a security boundary — the workspace clamp above
        // (from the verified token) is. So an explicit `?client=` is
        // safe to honor: it relabels the owner, it cannot escalate.
        uiClientId: headerClient || (clientParam.length > 0 ? clientParam : claims.authSessionId),
        detectorSessionKey,
        planRunSessionId,
        // Dispatch-layer parity with superuser (operator-tier catalog
        // + synthesized system principal + workspace tx). The clamp
        // above is the security boundary that distinguishes the tiers.
        isSuperuser: true,
        isPowerUser: true,
        // gateBypass (role+cap, NOT quota for power-user) is computed in
        // buildMcpToolContext from isSuperuser/isPowerUser.
        // Power-user tokens always imply the power profile.
        profile: 'power',
        contextTier: parsePayloadTier(url.searchParams.get('ctx_tier')),
        requestOrigin,
      },
    };
  }

  // ── (2) / (3) Per-spawn URL — verify signature if present ───────
  const hasSig = url.searchParams.has('sig');
  const hasExp = url.searchParams.has('exp');
  const requireSig = process.env.PAPERCUSP_REQUIRE_SPAWN_SIG === '1';
  const headers = headersFromExtra(extra);
  // `headers` is a Headers — use .get() (case-insensitive). The old
  // pickHeader() took a plain record and bracket-indexed it; on a
  // Headers instance that silently returned undefined every time.
  const remoteAddr = headers.get('x-forwarded-for');
  const userAgent = headers.get('user-agent');

  // A URL "claims a spawn context" if it carries any of the load-bearing
  // params an attacker would need to escalate (role/spawn/workspace).
  // Bare /api/mcp with no params at all isn't trying to escalate
  // anything — it's a probe / health check / pre-spawn discovery — so
  // we shouldn't audit-log it as a sig-missing failure in strict mode.
  // (Calling tools/list on it lists the catalog for a LOCAL caller only —
  // an outside caller gets mcp_auth_failed, see resolveVisibleToolListings;
  // tools/call falls through to the "none" path which rejects with
  // invalid_request_context.)
  const claimsSpawn =
    url.searchParams.has('role') || url.searchParams.has('spawn') || url.searchParams.has('workspace');

  let sigVerified = false;
  let verifiedKeySha256: string | undefined;
  if (hasSig || hasExp) {
    const v = await verifySpawnParams(url, { includeKeyDigest: true });
    if (!v.ok) {
      const spawn = url.searchParams.get('spawn');
      const role = url.searchParams.get('role');
      const harness = url.searchParams.get('harness');
      // WI-3190: classify a strand (a spawn this process previously authenticated,
      // now rejected because its key was rotated) apart from an attack, and dedupe
      // the alert. This is the single mutating consume — do it once.
      const classification = classifyAndConsumeFailure(v.reason, spawn);
      await logVerificationFailure({
        reason: v.reason,
        claimedRole: role,
        claimedHarness: harness,
        claimedWorkspace: url.searchParams.get('workspace'),
        claimedSpawn: spawn,
        expClaim: hasExp ? Number(url.searchParams.get('exp')) : null,
        remoteAddr,
        userAgent,
        classification,
      });
      if (classification === 'rotation_strand') {
        // A previously-working session just lost all tool access to a key rotation.
        // Loud + structured (console.error, not warn) so it stands out in the
        // operator journal as an actionable re-spawn, not routine escalation noise.

        console.error(
          `[spawn-signing][INCIDENT] rotation_strand — a previously-authenticated spawn was just ` +
            `rejected (signing key rotated out from under it). spawn=${spawn} role=${role} ` +
            `harness=${harness}. It will ZOMBIE unless re-spawned or switched to scripts/mcp-call.mjs.`,
        );
      } else {
        console.warn(
          `[spawn-signing] rejected MCP request: ${v.reason} (role=${role}, ` + `harness=${harness}, spawn=${spawn})`,
        );
      }
      // Enrich the agent-visible reason with actionable self-recovery guidance
      // (WI-3190 ask c) while keeping the stable `spawn_sig_<reason>` token prefix
      // that surfaces at both tools/call and tools/list.
      return { kind: 'failed', reason: `spawn_sig_${v.reason} — ${spawnSigFailureGuidance(v.reason)}` };
    }
    sigVerified = true;
    verifiedKeySha256 = v.keySha256;
    // WI-3190: remember this spawn so a later rotation-strand is recognisable.
    recordVerifiedSpawn({
      spawn: url.searchParams.get('spawn'),
      role: url.searchParams.get('role'),
      harness: url.searchParams.get('harness'),
      workspace: url.searchParams.get('workspace'),
    });
  } else if (requireSig && claimsSpawn) {
    await logVerificationFailure({
      reason: 'missing_sig_required_mode',
      claimedRole: url.searchParams.get('role'),
      claimedHarness: url.searchParams.get('harness'),
      claimedWorkspace: url.searchParams.get('workspace'),
      claimedSpawn: url.searchParams.get('spawn'),
      remoteAddr,
      userAgent,
    });
    return {
      kind: 'failed',
      reason: `spawn_sig_missing_sig_required_mode — ${spawnSigFailureGuidance('missing_sig_required_mode')}`,
    };
  } else {
    // Soft-warn period: allow unsigned URLs but log so we can see the
    // transition progress.
    if (url.searchParams.has('role') || url.searchParams.has('spawn')) {
      console.warn(
        '[spawn-signing] accepting UNSIGNED spawn URL (set PAPERCUSP_REQUIRE_SPAWN_SIG=1 to reject). ' +
          `role=${url.searchParams.get('role')} harness=${url.searchParams.get('harness')} ` +
          `spawn=${url.searchParams.get('spawn')}`,
      );
    }
  }

  try {
    const parsed = parseRequestContext(url);
    return {
      kind: 'ok',
      ctx: {
        workspaceId: parsed.workspaceId,
        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),
        harnessSlug: parsed.harnessSlug,
        // Canonicalize pre-rename role spellings (bee→cup, queen→mug, sentinel→
        // papercup, overwatch→kettle, scout→blender) here, at the one point every
        // downstream gate (role-allowlist in dispatch-stack.ts, AND
        // loadRoleCapabilities/synthesizeDispatchPrincipal below) reads `ctx.role`
        // from. Without this, a caller whose spawn URL still carries an old-spelling
        // `role=bee` gets a principal literally named `system:bee`, which has NO
        // entry in BLUEPRINT_ROLE_CAPS (only the canonical `cup` key exists) — every
        // capability-gated tool call 100%-fails with `missing_capability`, e.g.
        // `capability:git` (EI-667), even though the canonical `cup` role already
        // carries it. canonicalCoordRole is identity for an already-canonical role,
        // so this is a no-op for every current spawn.
        role: canonicalCoordRole(parsed.role) as AgentRole,
        featureId: parsed.featureId,
        chunkId: parsed.chunkId,
        runId: parsed.runId,
        spawnId: parsed.spawnId,
        parentSpawnId: parsed.parentSpawnId,
        uiClientId: parsed.uiClientId,
        detectorSessionKey: parsed.detectorSessionKey,
        planRunSessionId,
        sigVerifiedSpawn: sigVerified,
        ...(sigVerified && verifiedKeySha256
          ? {
              admissionRecoveryAuthority: {
                kind: 'signed-spawn' as const,
                credentialSha256: verifiedKeySha256,
                role: canonicalCoordRole(parsed.role),
                expiresAtSec: Number(url.searchParams.get('exp')),
              },
            }
          : {}),
        // Spawned agents get their tier from the per-spawn mcp.json URL
        // (context-trimming-tiers D-004; the orchestrator threads it).
        contextTier: parsePayloadTier(url.searchParams.get('ctx_tier')),
        requestOrigin,
      },
    };
  } catch (err) {
    if (err instanceof InvalidRequestContextError) return { kind: 'none' };
    throw err;
  }
}

function builtinInputSchema(tool: ReturnType<typeof getCatalog>[number]): Record<string, unknown> {
  // Zod 4: use the built-in toJSONSchema (the legacy `zod-to-json-schema` package
  // returns just `{ $schema }` against zod 4 schemas — empty inputSchemas for every
  // built-in) — but go through tooldef's GUARDED wrapper, never a raw call.
  //
  // An unrepresentable args schema (almost always a trailing `.transform()`) throws
  // here for the WHOLE catalog, not one tool: this runs inside the tools/list map, so
  // one bad schema takes down tool discovery for every client. Raw, the throw is a bare
  // adapter message naming nothing — un-greppable, and mis-triaged as an infra/zod break
  // (EI-10996 / WI-4596). toArgsJsonSchema names the offending tool and the likely cause.
  const json = toArgsJsonSchema(tool.name, tool.args);
  delete (json as Record<string, unknown>).$schema;
  // Registry write-positional tools advertise a single `row` string (P-008).
  const advertised = advertisedArgsSchema(tool.name, json);
  // Objectify boolean sub-schemas (z.unknown() → `true`) so strict consumers
  // (Ollama's Go tool-schema parser) accept the surface. See tool-schema-sanitize.ts.
  return sanitizeToolSchema(advertised);
}

/* ─── Resolved tool-context helpers ──────────────────────────────────── */

// Harness paths resolution is shared with the HTTP catch-all so both
// transports give plugin tools a populated ctx.projectDir.
import { resolveHarnessPaths as resolveHarnessPathsImpl } from '../../../resolve-harness-paths';

// Plugin spawn + secret impls are shared with the HTTP catch-all
// (apps/operator/app/api/plugins/[...path]/route.ts) so both transports
// see the same ctx.spawn / ctx.secret behavior.
import { pluginSpawnImpl, secretImpl, makeSecretResolver } from '../../../plugin-spawn-impl';

/* ─── Quota + invocation persistence ─────────────────────────────────── */
// PROJECTED_DEPS lives in @/lib/projected-tool-deps so the IPC server
// (and any future transport) can reuse the same telemetry + quota
// implementation. Don't fork the SQL across transports.
import { PROJECTED_DEPS, backfillResultDoorOutputRef, wrapOperatorKernelSpawn } from '../../../projected-tool-deps';
import { isPreferredDoor } from '../../../code-run-batch-nudge';

// EI-18803497769946984: names a tool that is holding the ambient workspace transaction
// past ~45s, before Postgres's 60s idle timeout kills the backend and the caller gets a
// bare CONNECTION_CLOSED naming neither. Its own module so it is unit-testable without
// importing this handler's tool catalog + PG deps.
import { warnIfHoldingWorkspaceTxTooLong } from './idle-tx-warning';

/**
 * Bind the tx + principal a projected tool needs, then run `run` under that ctx.
 * The ONE place the "how does a projected tool get its workspace tx" decision
 * lives — shared by the direct tools/call path AND the tools:invoke re-dispatch
 * (dispatchTool), so the two can never drift apart again:
 *   - crossWorkspace tool → the admin (rolbypassrls) handle, so it spans
 *     workspaces (RLS never hides another workspace's rows).
 *   - ordinary concrete-workspace tool → the principal is synthesized in its
 *     OWN short-lived tx (committed immediately), then the handler runs with
 *     NO ambient tx held open.
 *   - needsWorkspaceTx tool (concrete workspace) → a withWorkspace(ws)
 *     harness_app tx +
 *     a least-privilege synthesized principal, held open for the WHOLE handler.
 *   - unscoped ('*') non-crossWorkspace tool → runs tx-less (its own
 *     "workspace= arg required" fallback fires).
 *
 * EI-6982: tools:invoke previously reused the OUTER call's ctx (built for
 * tools:invoke itself — requirePrincipal:false, so NO tx/principal was
 * synthesized), which made EVERY crossWorkspace/needsTx target (memory:*,
 * flags:set, harness:list, …) throw "requires a workspace-scoped call" from an
 * unscoped psu/fleet session. Routing both dispatch paths through this helper is
 * the durable fix.
 *
 * EI-18808330244321407: transaction retention is explicit opt-in. The former
 * default wrapped essentially every scoped tool for its entire handler, even
 * though only a small minority read `ctx.tx`; slow non-DB work then sat idle in
 * a transaction until Postgres killed it. An ordinary tool now gets only the
 * short principal-synthesis transaction. A handler that actually reads
 * `ctx.tx` declares `needsWorkspaceTx: true`, and only that branch retains the
 * transaction. Generic tooldef dispatch also installs a fail-loud getter so an
 * undeclared access throws `WorkspaceTxNotDeclaredError` immediately.
 */
async function dispatchWithSynthesizedTx<T>(
  tool: {
    name?: string;
    crossWorkspace?: boolean;
    needsWorkspaceTx?: boolean;
    /** Legacy compatibility metadata; transaction-free is now the default. */
    skipWorkspaceTx?: boolean;
    requirePrincipal?: boolean;
  },
  spawnCtx: BuiltSpawnContext,
  baseCtx: UnifiedToolContext,
  run: (ctx: UnifiedToolContext) => Promise<T>,
): Promise<T> {
  // P-062 — crossWorkspace tools span workspaces: hand them the admin
  // (rolbypassrls) handle, never a workspace-scoped harness_app tx. Checked
  // before needsTx so it also covers the superuser/'*' discovery case
  // (e.g. papercusp:list_workspaces). Tools that read getOrgPg() directly are
  // unaffected (they ignore ctx.tx).
  if (tool.crossWorkspace === true) {
    const { sql: adminTx } = getOrgPg();
    const ctx: UnifiedToolContext = {
      ...baseCtx,
      tx: adminTx,
      principal: await synthesizeDispatchPrincipal(adminTx, spawnCtx),
    };
    return runWithWorkspaceIfConcrete(spawnCtx.workspaceId, () => run(ctx));
  }
  // EI-20226130855047135: role-gated tools explicitly declare that their
  // handlers do not require a principal. A superuser/power-user already has
  // the capability bypass needed by the dispatch stack, and a tool that also
  // opts out of its ambient workspace transaction does not need a short
  // principal-synthesis transaction either. Keeping that probe out of the
  // org-app pool leaves recovery/discovery tools callable while the pool is
  // saturated. Signed role callers still take the existing synthesis path so
  // their capability grants remain enforced.
  if (
    tool.needsWorkspaceTx !== true &&
    tool.requirePrincipal === false &&
    baseCtx.gateBypass?.capability === true &&
    dispatchNeedsTx(spawnCtx)
  ) {
    // Keep the transport-auth principal synthesized by buildMcpToolContext.
    // This branch deliberately skips the DB probe, but telemetry still needs
    // the caller provenance on its settled row.
    const ctx: UnifiedToolContext = { ...baseCtx, tx: undefined };
    return runWithWorkspaceIfConcrete(spawnCtx.workspaceId, () => run(ctx));
  }
  // EI-18808330244321407: default path. Preserve needsTx scoping for principal
  // synthesis, but commit that short transaction before the handler starts.
  if (tool.needsWorkspaceTx !== true && dispatchNeedsTx(spawnCtx)) {
    const ctxWs = spawnCtx.workspaceId;
    // The handler deliberately opted out of retaining an ambient transaction,
    // but role/capability gating still needs a short principal-synthesis tx.
    // Under fleet pressure that short acquisition can hit the 45s deadline even
    // while sibling calls are succeeding. Retry ONLY this pre-handler seam when
    // the acquire registry proves queue/saturation pressure; the expired()
    // guard in withWorkspace prevents a late first connection from invoking the
    // handler, so this cannot duplicate the tool's later write. Ambiguous or
    // dead-endpoint deadlines remain non-retryable.
    const principal = await retryOnRetryableDbDeadline(() =>
      withWorkspace(ctxWs, (tx) => synthesizeDispatchPrincipal(tx, spawnCtx)),
    );
    const ctx: UnifiedToolContext = { ...baseCtx, tx: undefined, principal };
    return runWithWorkspaceIfConcrete(ctxWs, () => run(ctx));
  }
  if (tool.needsWorkspaceTx === true && dispatchNeedsTx(spawnCtx)) {
    const ctxWs = spawnCtx.workspaceId;
    return runWithWorkspaceIfConcrete(ctxWs, () =>
      // A deadline from withWorkspace fires before its callback starts, so a
      // retry here cannot repeat the tool handler or any of its side effects.
      // Only retry when the DB layer measured decisive pool pressure; an
      // ambiguous/dead-endpoint deadline remains terminal for this attempt.
      retryOnRetryableDbDeadline(() =>
        withWorkspace(ctxWs, async (tx) => {
          const ctx: UnifiedToolContext = {
            ...baseCtx,
            tx,
            principal: await synthesizeDispatchPrincipal(tx, spawnCtx),
          };
          // EI-18808330244321407: this is the ONE branch that holds a transaction open
          // for the whole handler, so it is the only one that can trip the 60s idle
          // timeout. Name the tool while we still can.
          return warnIfHoldingWorkspaceTxTooLong(tool.name ?? '<unnamed tool>', run(ctx));
        }),
      ),
    );
  }
  return runWithWorkspaceIfConcrete(spawnCtx.workspaceId, () => run(baseCtx));
}

/**
 * Build a full UnifiedToolContext for an MCP tool invocation. Combines:
 *   - spawn fields parsed from URL
 *   - per-call helpers (log, progress, spawn, secret)
 *   - resolved harness paths
 *   - per-call AbortSignal (dispatcher composes its own timeout signal)
 *   - progress wired to MCP `notifications/progress` when the calling
 *     client supplied a progressToken in `_meta`
 */
// Exported for tests; not part of the route's public surface.
// eslint-disable-next-line @typescript-eslint/naming-convention
export async function __buildMcpToolContext_forTests(
  ...args: Parameters<typeof buildMcpToolContext>
): Promise<UnifiedToolContext> {
  return buildMcpToolContext(...args);
}

/**
 * A projection consumes the complete intermediate result in-process, then only
 * its reduction crosses the model-facing transport. Promote that intermediate
 * context instead of synthesizing a framework-reserved tool argument: raw
 * ProjectedTool registrations must never observe transport controls in args.
 */
function projectionMaterializationContext(
  ctx: UnifiedToolContext,
  needsFullSource: boolean,
  needsStructuredSource = false,
  sourceProjection?: ProjectionSpec | null,
): UnifiedToolContext {
  // A structured `pick` still needs JSON even when the caller explicitly
  // supplied a payload tier. Previously the full-source promotion flag also
  // controlled this format choice, so an explicit nested `payloadTier:'full'`
  // left the target on the implicit compact/TOON format and `pick` failed open
  // as a non-JSON body. Keep the tier decision separate: an explicit target
  // tier remains authoritative, while the in-process materialization is JSON
  // whenever the projection needs structured fields.
  if (!needsFullSource && !needsStructuredSource) return ctx;
  const promoted = needsFullSource
    ? {
        contextTier: 'full' as const,
        payloadTierOverride: 'full' as const,
        transportCapExempt: true,
      }
    : {};
  return {
    ...ctx,
    ...(sourceProjection ? { sourceProjection } : {}),
    // `pick` classifies the materialized text as JSON. MCP's implicit compact
    // default may select TOON, so force JSON only for this in-process source;
    // the caller's explicit format remains the final wire-format choice.
    requestedFormat: projectionMaterializationFormat(ctx.requestedFormat, needsStructuredSource),
    ...promoted,
  };
}

/**
 * A projection on the outer `tools:invoke` call is intended for the target
 * result, not the wrapper's guidance text. Forward it into the target args so
 * the re-dispatch path applies it at the same boundary as a direct call.
 *
 * Keep an explicitly nested projection untouched: that is a deliberate
 * two-level call, where the nested stage reduces the target and the outer
 * stage reduces the wrapper result.
 */
// Generic in the args type so the return PRESERVES what the caller passed in. The two outcomes
// are "hand back the input untouched" and "hand back a Record built from it", and declaring the
// first as `unknown` widened away the caller's narrowing — so a caller holding a
// Record<string, unknown> could not assign the result back to its own variable. `T | Record` is
// exact: it collapses to Record for a Record caller and stays unknown for an unknown one. This
// is a type-level change only; every runtime path below is untouched.
function forwardToolsInvokeProjection<T>(
  toolName: string,
  dispatchArgs: T,
  projectionSpec: ProjectionSpec | null,
): { dispatchArgs: T | Record<string, unknown>; projectionSpec: ProjectionSpec | null } {
  if (toolName !== 'tools:invoke' || !projectionSpec || !dispatchArgs || typeof dispatchArgs !== 'object') {
    return { dispatchArgs, projectionSpec };
  }

  const invokeArgs = dispatchArgs as Record<string, unknown>;
  const nestedArgs = decodeToolsInvokeArgs(invokeArgs.args);
  const nestedRecord =
    nestedArgs && typeof nestedArgs === 'object' && !Array.isArray(nestedArgs)
      ? (nestedArgs as Record<string, unknown>)
      : nestedArgs === undefined
        ? {}
        : null;
  if (!nestedRecord || PROJECTION_ARG in nestedRecord) {
    return { dispatchArgs, projectionSpec };
  }

  return {
    dispatchArgs: {
      ...invokeArgs,
      args: { ...nestedRecord, [PROJECTION_ARG]: projectionSpec },
    },
    projectionSpec: null,
  };
}

/**
 * Same rescue as `forwardToolsInvokeProjection`, for the OTHER framework-reserved
 * dispatch control. A `payloadTier` on the outer `tools:invoke` call is aimed at the
 * TARGET tool's payload shaping — the wrapper has no payload of its own worth tiering
 * — but `tools:invoke` re-dispatches with `args.args` alone (see agent-tools/tools/
 * invoke.ts), so an un-forwarded outer tier never reaches the target at all.
 *
 * Left unforwarded it fails SILENTLY rather than loudly: the call still returns
 * ok:true, just trimmed, and the only tell is `_shapeNote.tier` — which a caller who
 * explicitly asked for 'full' has no reason to re-read. That made `projection` (which
 * has a forwarder) and `payloadTier` (which did not) behave oppositely from the same
 * outer position on the same tool. EI-21245922047633177.
 *
 * An explicitly nested `payloadTier` is left untouched: that is the caller being
 * specific about the target, and it wins. The outer copy is deliberately KEPT — it
 * shapes the wrapper's own result and is what the `projectionNeedsFullSource` check
 * below reads.
 */
const PAYLOAD_TIER_ARG = 'payloadTier' as const;

// Exported for tests; not part of the route's public surface (same convention as
// __buildMcpToolContext_forTests above).
export function forwardToolsInvokePayloadTier<T>(toolName: string, dispatchArgs: T): T | Record<string, unknown> {
  if (toolName !== 'tools:invoke' || !dispatchArgs || typeof dispatchArgs !== 'object') {
    return dispatchArgs;
  }

  const invokeArgs = dispatchArgs as Record<string, unknown>;
  if (!(PAYLOAD_TIER_ARG in invokeArgs)) return dispatchArgs;

  const nestedArgs = decodeToolsInvokeArgs(invokeArgs.args);
  const nestedRecord =
    nestedArgs && typeof nestedArgs === 'object' && !Array.isArray(nestedArgs)
      ? (nestedArgs as Record<string, unknown>)
      : nestedArgs === undefined
        ? {}
        : null;
  if (!nestedRecord || PAYLOAD_TIER_ARG in nestedRecord) {
    return dispatchArgs;
  }

  return {
    ...invokeArgs,
    args: { ...nestedRecord, [PAYLOAD_TIER_ARG]: invokeArgs[PAYLOAD_TIER_ARG] },
  };
}

/**
 * EI-22390450916579377: plugin tools register incrementally while the cached
 * plugin-host promise warms after an operator restart. A plugin-shaped
 * tools:invoke target can therefore miss even though a sibling verb from the
 * same plugin is already callable. Give that one transient family a short
 * chance to finish registering, then resolve exactly once more.
 *
 * The bound is deliberately far below the plugin host's 60s sweep budget: a
 * slow/hung plugin must still fail quickly with the existing diagnostic. Core
 * `ns:verb` misses never enter this path, and already-registered tools retain
 * the synchronous fast lookup in dispatchTool.
 */
export const PLUGIN_TOOL_RERESOLVE_BUDGET_MS = 5_000;
export async function resolveMcpTargetAfterPluginHostWarm(
  toolName: string,
  deps: {
    resolve?: typeof resolveMcpName;
    warm?: () => Promise<unknown>;
    budgetMs?: number;
  } = {},
): Promise<ReturnType<typeof resolveMcpName>> {
  const resolve = deps.resolve ?? resolveMcpName;
  const initial = resolve(toolName);
  if (initial?.expose?.mcp || !isPluginNamespacedToolName(toolName)) return initial;

  const requestedBudget = deps.budgetMs ?? PLUGIN_TOOL_RERESOLVE_BUDGET_MS;
  const budgetMs =
    Number.isFinite(requestedBudget) && requestedBudget > 0 ? requestedBudget : PLUGIN_TOOL_RERESOLVE_BUDGET_MS;
  const warm = deps.warm ?? getPluginHost;
  try {
    await raceDeadline<unknown | undefined>(
      budgetMs,
      () => Promise.resolve().then(warm),
      () => undefined,
    );
  } catch {
    // The host records discovery failures in plugins:runtime_status. A failed
    // warm must preserve the ordinary unknown_tool response, not turn a miss
    // into a transport-level exception. Re-resolve because earlier tools in a
    // failed incremental sweep may still have registered successfully.
  }
  return resolve(toolName);
}

async function buildMcpToolContext(
  spawn: BuiltSpawnContext,
  progressToken: string | number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification: ((notif: { method: string; params: Record<string, unknown> }) => Promise<void>) | undefined,
  // The projected tool's owning plugin (revive-plugin-system D-004). When the
  // call targets a real plugin tool, ctx.secret resolves through that plugin's
  // encrypted plugin_configs (then env); first-party tools ('agent-mcp') and
  // tool-less probes get the env-only resolver.
  pluginName?: string,
  // Client-negotiated result format (token-efficient-tool-result-formats P-009),
  // from `_meta.format` on the tools/call params or `?format=` on the MCP URL.
  // The result serializer reads it; absent ⇒ the MCP transport default (compact).
  requestedFormat?: string,
  // Opt-in for lossless `structuredContent` alongside the compact text (P-010),
  // from `_meta.structured` / `?structured=1`. OFF by default.
  requestedStructured?: boolean,
  // Client-negotiated freshness request (agent-tool-delta-protocol D-001), from
  // `_meta.delta` / `?delta=` on the MCP URL. Threaded to ctx.requestedDelta so
  // the result serializer can honor a `not_modified` request on a delta-capable tool.
  requestedDelta?: string,
  // Validated `_meta.idempotencyKey`, threaded to ctx so tools with durable
  // side effects can derive stable per-request identifiers across retries.
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<UnifiedToolContext> {
  // Unscoped context: workspaceId/harnessSlug may be '*' — the superuser door,
  // or a WORKSPACE-LEVEL signed role session (operator/planner launched without
  // a harness, hive-agent-tabs P-003). Skip path resolution; per-tool fallbacks
  // ("workspace=/harness= arg required") will fire.
  const paths =
    spawn.workspaceId === '*' || spawn.harnessSlug === '*'
      ? { projectDir: undefined as unknown as string, stateDir: undefined as unknown as string }
      : await resolveHarnessPathsImpl(spawn.harnessSlug, spawn.workspaceId);
  // Plugin handlers call ctx.emit / ctx.progress. When the MCP client
  // supplied a progressToken, fan each call to JSON-RPC notifications
  // over the agent's MCP session. Otherwise no-op (client opted out).
  //
  // emit('<name>', data) → notifications/papercusp/event with { event, data }
  //   (Papercusp-specific extension; standard MCP clients ignore unknown methods.)
  // emit('progress', payload) → ALSO fires notifications/progress
  //   (MCP-spec-compliant; built-in MCP UIs use this for progress bars.)
  //
  // ctx.progress(pct, msg) is a thin alias over emit('progress', { progress, total, message? }).
  const emit: UnifiedToolContext['emit'] =
    progressToken !== undefined && sendNotification
      ? (name, data) => {
          // JSON-RPC can't carry binary natively. Uint8Array would
          // JSON.stringify to {"0":...} (one numeric key per byte) —
          // corrupted on the wire. Match the HTTP transport's behavior:
          // base64-encode binary payloads. Structural check is cheap
          // and catches both schema-declared and schema-undeclared
          // binary emits.
          let wireData: unknown = data;
          if (data instanceof Uint8Array) {
            wireData = {
              $papercuspBinary: true,
              encoding: 'base64',
              data: Buffer.from(data).toString('base64'),
            };
          }
          // Papercusp extension notification — always fires.
          sendNotification({
            method: 'notifications/papercusp/event',
            params: { progressToken, event: name, data: wireData },
          }).catch((err) => {
            console.warn(
              `[mcp-tool] sendNotification(papercusp/event) failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          // Spec-compliance: also fire the standard progress notification
          // for the 'progress' wire event so MCP-aware clients that only
          // know about notifications/progress still get a progress signal.
          if (name === 'progress' && data !== null && typeof data === 'object' && !(data instanceof Uint8Array)) {
            sendNotification({
              method: 'notifications/progress',
              params: { progressToken, ...(data as Record<string, unknown>) },
            }).catch((err) => {
              console.warn(
                `[mcp-tool] sendNotification(progress) failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        }
      : () => {
          /* streaming disabled by client (no progressToken) */
        };
  const progress: UnifiedToolContext['progress'] = (pct, msg) => {
    emit('progress', {
      progress: typeof pct === 'number' ? pct : 0,
      total: 100,
      ...(msg ? { message: msg } : {}),
    });
  };
  // activateTools — expand THIS session's live tool surface at runtime
  // (dynamic-tool-surface-2026-07-01). Grows the session's mutable allowlist
  // (keyed by the su session identity uiClientId, seeded from the connect-time
  // ?tools=) and, if something new was added, fires the standard
  // notifications/tools/list_changed so a listChanged-capable client (omp,
  // codex) re-fetches tools/list and can call the surfaced tools. Gated only on
  // sendNotification (session-level, NOT progressToken like emit/progress).
  // No-op for un-seeded (full-catalog / Claude) sessions: activateSessionTools
  // returns false when no surface entry exists, so no notification is sent.
  const activateTools: UnifiedToolContext['activateTools'] = (toolNames) => {
    const added = activateSessionTools(spawn.uiClientId, toolNames);
    if (added && sendNotification) {
      sendNotification({
        method: 'notifications/tools/list_changed',
        params: {},
      }).catch((err) => {
        console.warn(
          `[mcp-tool] sendNotification(tools/list_changed) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return added;
  };
  // dispatchTool — the engine behind the tools:invoke meta-tool
  // (dynamic-tool-surface-2026-07-01). Routes a call to ANY projected tool
  // server-side under THIS caller's context (via the ctxRef holder, so the
  // target is gated EXACTLY as a direct call — dispatchProjectedToolToMcp
  // applies the role-allowlist + quota + profile gates against `ctx`). The
  // universal reachability path for a client that can't grow its own tool list.
  const ctxRef: { current: UnifiedToolContext | undefined } = { current: undefined };
  const dispatchToolExact: UnifiedToolContext['dispatchTool'] = async (toolName, toolArgs) => {
    // WI-3930: resolve TOLERANTLY — an agent commonly pastes a tool name into
    // tools:invoke in the underscore/group_verb (`curation_state-of-pot`) or
    // fully client-mangled (`mcp__papercusp-su__curation_state-of-pot`) form it
    // sees in its own advertised list, not the canonical colon form. Exact match
    // is still the fast path; the normalized fallback (unambiguous only) saves a
    // wasted unknown-tool round-trip. Dispatch downstream under the CANONICAL
    // registered name so telemetry/quota attribution keys off the real tool.
    const target = isPluginNamespacedToolName(toolName)
      ? await resolveMcpTargetAfterPluginHostWarm(toolName)
      : resolveMcpName(toolName);
    if (!target?.expose?.mcp) {
      // EI-9011 (generalized): moment-of-failure referral — closest catalog matches +
      // the tools:find/tools:invoke routing hint, so a typo'd or client-format name
      // never reads as "the tool doesn't exist".
      return { isError: true, content: [{ type: 'text' as const, text: unknownToolReferral(toolName) }] };
    }
    const canonicalName = target.expose.mcp.name;

    // EI-19386035445533031: `projection` is a DISPATCH-level reserved arg (see
    // the direct tools/call path above, which strips it from `dispatchArgs`
    // before the tool's own schema validation ever sees it). This re-dispatch
    // path used to skip that step entirely, so a caller who — following the
    // result-door footer's own advice — nested `projection` inside
    // `tools:invoke({ name, args: { ..., projection } })` got a hard
    // "Unrecognized key: projection" from the TARGET tool's strict validator:
    // the footer taught a knob this path could not accept. Mirror the direct
    // path exactly: strip + validate here (fail-closed on a malformed spec,
    // same error shape), then apply it to the result below (fail-open) so
    // `tools:invoke` behaves identically to a direct call.
    let dispatchToolArgs: Record<string, unknown> =
      toolArgs && typeof toolArgs === 'object' ? (toolArgs as Record<string, unknown>) : {};
    // `ctx.dispatchTool` is also the in-process entry point used by code/recipe
    // orchestration. The transport `tools/call` path applies this forwarding
    // before invoking the `tools:invoke` wrapper, but nested callers arrive here
    // directly and would otherwise lose an outer payloadTier before the wrapper
    // re-dispatches the target (EI-21584932731440718).
    dispatchToolArgs = forwardToolsInvokePayloadTier(canonicalName, dispatchToolArgs) as Record<string, unknown>;
    let projectionSpec: ProjectionSpec | null = null;
    let projectionNeedsFullSource = false;
    if (PROJECTION_ARG in dispatchToolArgs) {
      const parsed = parseProjection(dispatchToolArgs[PROJECTION_ARG]);
      if (!parsed.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                `projection_invalid: ${parsed.error}\n` +
                `The \`projection\` argument reduces ANY tool result: ` +
                `{ pick?: ["results[].id"], pipe?: [{ op:"grep", pattern:"..." }, { op:"head", n:20 }] }. ` +
                `A single \`pick\` list accepts at most ${MAX_PICK_PATHS} paths; split larger selections across calls. ` +
                `An ARRAY-root body (a bare list result) is selected with "[].field", not "field". ` +
                `Operators: grep (fixed/ignoreCase/invert/before/after/context), head, tail, sort, uniq, cut, count.`,
            },
          ],
        };
      }
      projectionSpec = parsed.spec;
      const { [PROJECTION_ARG]: _stripped, ...rest } = dispatchToolArgs;
      dispatchToolArgs = rest;
      // P-008: caller projection must see the MATERIALIZED source, not an
      // excerpt already cut by defineTool's session tier / hard ceiling. An
      // explicit caller payloadTier still wins; otherwise promote only the
      // INNER dispatch context. Do not synthesize a tool argument: framework
      // controls stay transport-only even for raw ProjectedTool registrations.
      projectionNeedsFullSource = !('payloadTier' in dispatchToolArgs);
    }
    // Named result views (P-001). Resolved through the SAME helper the direct
    // path uses, so the two cannot drift — which is the failure this seam has
    // already had once, when nested dispatch fell behind on free-form
    // projection. Fail-CLOSED on an unknown name: it is the caller's bug and is
    // knowable without running anything, and silently returning the full
    // payload would hand back exactly what the caller declined to pay for.
    const takenView = takeNamedViewFromArgs(dispatchToolArgs, canonicalName);
    if (takenView.kind === 'error') {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: takenView.error }],
      };
    }
    let namedView: Extract<ViewResolution, { ok: true }> | null = null;
    if (takenView.kind === 'view') {
      namedView = takenView.resolved;
      dispatchToolArgs = takenView.args;
      // Same rationale as projection: a view must select over the MATERIALIZED
      // source, not an excerpt a tier already cut.
      projectionNeedsFullSource = !('payloadTier' in dispatchToolArgs);
    }
    // EI-22052744493834331: nested `ctx.dispatchTool` (the `tools:invoke` re-dispatch
    // path) is still the SAME transport request as a direct `tools/call` and must not
    // become a privilege bridge around the scoped-superuser workspace/hive clamp — see
    // applyScopedSuperuserTransportClamp's own doc comment. Apply it here, against the
    // OUTER session's unclamped `spawn` context, BEFORE computing effectiveWs: the clamp
    // force-overwrites any `workspace`/`workspaceId` target arg to the confined value
    // (and rejects an escaping `harness`/hive arg outright), so effectiveDispatchWorkspace
    // below then resolves against ALREADY-CLAMPED args, mirroring the direct path's order.
    const clampResult = await applyScopedSuperuserTransportClamp(
      { name: canonicalName, crossWorkspace: target.crossWorkspace, profile: target.profile },
      spawn,
      dispatchToolArgs,
    );
    if (!clampResult.ok) {
      return clampResult.result;
    }
    dispatchToolArgs = clampResult.args;
    // EI-6982: bind the tx/principal the TARGET tool needs — NOT the outer
    // tools:invoke ctx (requirePrincipal:false, so tx-less). Without this, every
    // crossWorkspace/needsTx target (memory:*, flags:set, harness:list, …) threw
    // "requires a workspace-scoped call" from an unscoped session. Honor a per-call
    // `workspace` arg on the target too, so an unscoped superuser can
    // `tools:invoke { name:'harness:list', args:{ workspace } }` exactly as a direct
    // call would (effectiveDispatchWorkspace). Shared with the direct tools/call
    // path via dispatchWithSynthesizedTx so the two can't drift.
    const effectiveWs = effectiveDispatchWorkspace(spawn, dispatchToolArgs);
    const spawnCtx: BuiltSpawnContext =
      effectiveWs === spawn.workspaceId && clampResult.effectiveHarnessSlug === spawn.harnessSlug
        ? spawn
        : { ...spawn, workspaceId: effectiveWs, harnessSlug: clampResult.effectiveHarnessSlug };
    const baseCtx: UnifiedToolContext =
      effectiveWs === ctxRef.current!.workspaceId && clampResult.effectiveHarnessSlug === ctxRef.current!.harnessSlug
        ? ctxRef.current!
        : { ...ctxRef.current!, workspaceId: effectiveWs, harnessSlug: clampResult.effectiveHarnessSlug };
    const dispatched = (await dispatchWithSynthesizedTx(target, spawnCtx, baseCtx, (ctx) => {
      const materializationCtx = projectionMaterializationContext(
        ctx,
        projectionNeedsFullSource,
        projectionSpec?.pick !== undefined,
        projectionSpec,
      );
      return dispatchProjectedToolToMcp(target, canonicalName, dispatchToolArgs, materializationCtx, PROJECTED_DEPS);
    })) as McpCallResult;
    const freeFormProjected = projectionSpec
      ? applyResultProjection(dispatched, projectionSpec, { toolName: canonicalName, effect: target.effect })
      : dispatched;
    const projectedDispatched = namedView ? applyNamedViewToResult(freeFormProjected, namedView) : freeFormProjected;
    const doorInput = stripImplicitProjectionFullRequest(
      projectedDispatched,
      projectionNeedsFullSource,
      ctxRef.current!,
    );
    // A projected call was temporarily promoted to payloadTier:'full' above.
    // Do not carry the target's door exemption across that seam: a successful
    // projection is already small so the outer door is a no-op, while a
    // fail-open/miss must be bounded instead of leaking the full promoted body.
    return carryNestedResultDoorSkip(
      doorInput,
      // A NAMED VIEW is promoted to full source exactly like a projection, so it
      // must drop the exemption on the same terms: a successful view is already
      // budget-bounded (the door is a no-op), and a fail-open must be bounded
      // rather than leak the full promoted body.
      projectionSpec || namedView ? undefined : target.skipResultDoor,
    );
  };
  // Fuzzy tool-name recovery for the tools:invoke re-dispatch seam (P-007 / D-008). Exact and
  // canonical names go straight through; a typo'd name that resolves is dispatched under the
  // canonical name and the reply annotated. No `extra` here (an in-process call), so the
  // candidate set is the full catalog — tools:invoke already reaches any catalog tool.
  const dispatchTool: UnifiedToolContext['dispatchTool'] = async (toolName, toolArgs) => {
    if (resolveMcpName(toolName) !== undefined) return dispatchToolExact(toolName, toolArgs);
    const fuzzy = await resolveWithFuzzy(toolName, undefined, MCP_FUZZY_DEPS);
    if (fuzzy.kind !== 'rewrite') return dispatchToolExact(toolName, toolArgs);
    const res = await dispatchToolExact(fuzzy.name, toolArgs);
    return fuzzy.record.outcome === 'resolved' && Array.isArray((res as { content?: unknown }).content)
      ? (annotateFuzzyResult(res as never, {
          input: toolName,
          resolvedName: fuzzy.name,
          distance: fuzzy.record.distance,
        }) as typeof res)
      : res;
  };
  const builtCtx: UnifiedToolContext & AdmissionAuthorityContext = {
    activateTools,
    dispatchTool,
    workspaceId: spawn.workspaceId,
    harnessSlug: spawn.harnessSlug,
    // No-tx tools still need a principal-shaped provenance stamp for
    // tool_invocations. Transaction-backed dispatch replaces this lightweight
    // value with the capability-enriched principal below.
    principal: synthesizeTransportPrincipal(spawn),
    projectDir: paths.projectDir,
    stateDir: paths.stateDir,
    role: spawn.role,
    featureId: spawn.featureId,
    chunkId: spawn.chunkId,
    runId: spawn.runId,
    spawnId: spawn.spawnId,
    parentSpawnId: spawn.parentSpawnId,
    uiClientId: spawn.uiClientId,
    failureLoopSessionKey: spawn.detectorSessionKey,
    callerAgent: spawn.callerAgent ?? null,
    callerModel: spawn.callerModel ?? null,
    sigVerifiedSpawn: spawn.sigVerifiedSpawn ?? false,
    admissionRecoveryAuthority: spawn.admissionRecoveryAuthority,
    planRunSessionId: spawn.planRunSessionId ?? null,
    isSuperuser: spawn.isSuperuser ?? false,
    isPowerUser: spawn.isPowerUser ?? false,
    ...(spawn.interactiveCardCapability ? { interactiveCardCapability: true as const } : {}),
    gateBypass: papercuspGateBypass({
      isSuperuser: spawn.isSuperuser ?? false,
      isPowerUser: spawn.isPowerUser ?? false,
      // EI-2048: testing-phase full tool access for trusted roles (queen/bee/
      // overwatch/sentinel/scout/operator) — they get the same role+capability
      // bypass as superuser so a missing grant can't masquerade as another bug.
      role: spawn.authenticatedPrincipal ? null : spawn.role,
    }),
    // Tool-list filtering only distinguishes power-vs-not (slashToolVisibleTo:
    // `profile === 'power'`), so the GENERIC profile (domain-generic-hive P-025) maps to
    // engineer-like visibility here — its DISTINCT behavior (no papercup CLAUDE.md splice)
    // lives in the playbook path (role-launch-spec), not tool gating. Coerce so the
    // narrow UnifiedToolContext.profile never has to carry 'generic'.
    profile: spawn.profile === 'generic' ? 'engineer' : (spawn.profile ?? 'engineer'),
    // Payload tier (context-trimming-tiers D-004) — absent ⇒ 'full' at resolution.
    contextTier: spawn.contextTier,
    // EI-20720054720826414: the executable spelling of a raw-args re-call on
    // THIS host, rendered into every bounded payload's recovery `next` in place
    // of the abstract "route through your host's raw-args dispatch path". This
    // is the platform-wide truth (su + roles both dispatch via tools:invoke),
    // stated ONCE here rather than hand-rolled per tool (work_items:get's
    // bespoke _shapeNote was the drift this replaces).
    rawDispatchTemplate: "tools:invoke { name:'{tool}', args:{ …original args, payloadTier:'full' } }",
    requestedFormat,
    requestedStructured,
    requestedDelta,
    idempotencyKey,
    requestOrigin: spawn.requestOrigin,
    log: (msg) => {
      console.log(`[mcp-tool][${spawn.harnessSlug}/${spawn.role}/${spawn.spawnId}] ${msg}`);
    },
    progress,
    emit,
    transport: 'mcp',
    spawn: pluginSpawnImpl,
    secret:
      pluginName && pluginName !== 'agent-mcp'
        ? makeSecretResolver({ harnessSlug: spawn.harnessSlug, pluginName })
        : secretImpl,
    signal: signal ?? new AbortController().signal,
  };
  // Close the ctxRef loop so dispatchTool routes the target through THIS ctx.
  // Native/plugin subprocesses cross a second execution boundary inside the
  // handler. Keep the existing capability/path checks in `pluginSpawnImpl`,
  // then apply the same D-030 kernel seat used by projected dispatch. The
  // adapter is deliberately evidence-neutral here (no tool-name confinement
  // inference); a live activation owner may install richer state through the
  // shared projected-deps resolver.
  if (typeof wrapOperatorKernelSpawn === 'function') {
    builtCtx.spawn = wrapOperatorKernelSpawn(
      pluginSpawnImpl,
      builtCtx,
      [],
      pluginName ? `plugin:${pluginName}:spawn` : 'native:shell',
    );
  }
  ctxRef.current = builtCtx;
  return builtCtx;
}

/* ─── MCP handler ────────────────────────────────────────────────────── */

/**
 * Static MCP `initialize.instructions` field — surfaced to LLM clients
 * (Claude Code, OMP) at session start as additional system-prompt
 * context.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 1, P-003).
 *
 * Nudges agents toward the three-layer memory pattern. This is the STATIC
 * base; per-session dynamic enrichment (mem0 fan-out + insights index via
 * `buildMcpPrelude`) is wired in the setup callback below by DELEGATING to
 * the SDK's own initialize handler and appending to its `instructions` —
 * see `_mcp-initialize-enrich.ts`
 * (memory-delivery-unification-2026-07-12 P-001; the old "SDK doesn't
 * expose a clean hook" deferral is closed).
 *
 * Disabled via PAPERCUSP_SU_MEMORY_INJECTION=off when needed.
 */
const PAPERCUSP_MCP_INSTRUCTIONS = `Get oriented ONCE per session-with-context (a user task you have
not seen this run) — by whichever of these two routes your host gave you:

  **ROUTE A — an \`## Orientation\` block already arrived in this turn.** Your held
  work-items, unanswered directed messages, and whether a wake source (armed loop)
  exists came WITH it: the server read them for you. Do NOT spend a
  \`coord:orient\` round-trip re-fetching them — you are oriented. Claim your lane
  with \`coord:declare-intent { intent, items }\`, and reach for
  \`coord:orient\` only for what that block deliberately EXCLUDES: the claimable
  backlog, full inbox bodies, a mem0 recall. Judge by PRESENCE ONLY — the block is
  emitted just when that state CHANGES, and only to hosts that inject it, so its
  ABSENCE never means "you are oriented".

  **ROUTE B — no such block.** Bootstrap in ONE call:
  **\`coord:orient { intent }\`** — pass your one-line intent for the
  task. In a SINGLE round-trip it returns your current assignments
  (+ lane + load), the claimable backlog, your unread inbox summary,
  the recent plan-events delta, AND a mem0 recall for \`intent\` — and
  it DECLARES \`intent\` to peers so they see what you're working on.
  After a SUCCESSFUL orient, do NOT separately call \`coord:plan-events\`,
  \`memory:search\`, \`coord:inbox\`, or \`coord:declare-intent\` — orient's
  result ALREADY contains them (plan-events delta + inbox summary + a mem0
  recall) and ALREADY declared your intent; re-calling them just re-pays the
  round-trip orient collapsed. Reach for one individually only for a detail
  orient deliberately bounds (full inbox bodies, or a mem0 query OTHER than
  your intent).

  - **Claim your lane.** When the work is plan items, pass them:
    \`coord:orient { intent, planSlug, planItems: ['P-001', …] }\` CLAIMS
    those items for you (and releases ones you've moved off). An unclaimed
    lane is invisible to the Mug and peers, so work gets double-placed.
    (Flipping an item \`wip\` via \`plans:set-status\` also auto-claims;
    \`done\` releases. A \`claim_conflict\` means a live peer holds it —
    coordinate with the holder, don't take it.)
  - **mem0 (what you know).** orient's recall uses \`intent\` as the query;
    pass \`harness\` for project-specific facts. Each mem0 hit carries an
    \`id\` — if the user later contradicts something, \`memory:forget\`
    that id. Use \`memoryQuery\` for a different query, or call
    \`memory:search\` directly. A recall hit is BINDING context, not flavor:
    if a recalled fact prescribes a behavior for THIS task, follow it — or
    explicitly say why you're not.
  - **insights (how things work).** When you hit a confusing failure,
    \`docs:search\` the \`agent-insights/\` section before grepping code —
    many "weird bugs" already have a written runbook.
  - **State answers NOW; only the append-only log answers EVER.** \`coord:presence\` /
    \`fleet:assignments\` are LIVE-STATE — who is alive, who holds what RIGHT NOW; an ended
    agent loses its fleet_slug and its presence row is TTL-reaped, so they CANNOT answer an
    *ever / was / missed / history* question. Route those to \`coord:catch-up { audience }\`
    (as a member of the fleet/topic) or \`coord:feed { audience }\` (the firehose) instead —
    never a state tool. Full map:
    \`docs:search\` \`agent-insights/presence-vs-history-who-is-on-what\`.

Right layer for READS and WRITES — the memory↔docs boundary:
  - **HOW IT WORKS** (a runbook, a failure mode, why-something-is, a hard-won gotcha):
    READ via \`docs:search\` the \`agent-insights/\` section; WRITE a new/updated MDX under
    \`apps/operator-docs/src/content/docs/agent-insights/\` with a \`documents:\` frontmatter
    anchor to the code it describes. This is the RIGHT place — a doc is code-ANCHORED,
    drift-TRACKED (the freshness sweep) and AUTO-HEALED (the doc-steward); a mem0 vector cannot
    be anchored/swept/auto-rewritten, so how-it-works left only in mem0 silently rots. Do NOT
    park a runbook in mem0.
  - **WHY a subsystem/decision is the way it is** (the rationale behind a design, not how it works):
    READ via \`rationale:feed { topic }\` — a topic-keyed projection over the relevant
    plan-decisions + work-items + insights, kept fresh by the event engine (\`topics:list\` for the
    topic, then \`plans:get\`/\`docs:get\` on an entry's \`ref\` for the full text). The discoverable
    "why" layer — reach for it before grepping plans/decisions by hand.
  - **A durable PERSONAL/PREFERENCE fact** (who the user is, a convention, an owner pref):
    READ via \`memory:search\`; WRITE via \`memory:remember\`. Keep mem0 entries SHORT, and when
    the why already lives in a doc/plan store only the non-derivable fact + a POINTER
    (\`[[<plan-slug>]]\`, \`/internal/docs/agent-insights/<slug>\`), never a copied paragraph.
  - **In-flight state** → coord; **derivable session state** (X shipped, migration N, N tests)
    → the plan / work-item, never memory.
See the plans \`papercusp-su-memory-2026-05-25\` and
\`tool-call-batching-wrappers-2026-06-21\`.`;

/**
 * Wall-clock cap on the per-session initialize enrichment (P-001). Session
 * establishment must stay snappy: past this, the enrichment resolves null
 * and the client gets the static instructions. buildMemoryContextBlock has
 * its own op-deadline posture; this bounds the WHOLE enrich path (including
 * the PG user lookup). Env-tunable; 0 = unbounded (raceDeadline semantics —
 * the kill switch for the whole prelude stays PAPERCUSP_SU_MEMORY_INJECTION=off).
 */
const INITIALIZE_ENRICH_DEADLINE_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_MCP_INIT_ENRICH_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_500;
})();

/** Fast initialize calls stay silent; this is the upstream stage-telemetry threshold. */
const INITIALIZE_STAGE_SLOW_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_MCP_INIT_STAGE_SLOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_500;
})();

function mcpInstructionsForServer(): string | undefined {
  // dynamic-tool-surface D-011: append the compact CAPABILITY MAP so a trimmed session (the
  // default now) knows WHAT exists to search for — discoverability at ~1-2k instead of the
  // ~165k of full descriptions. Harmless for a `full`/eager session (it already sees every
  // tool). Gated off with the memory injection kill-switch for parity.
  if (process.env.PAPERCUSP_SU_MEMORY_INJECTION === 'off') return undefined;
  return `${PAPERCUSP_MCP_INSTRUCTIONS}\n\n${capabilityMapText()}`;
}

/**
 * Resolve the MCP tool listings visible to THIS session — the single walk
 * shared by `tools/list` and the dynamic slash projection on `prompts/list`,
 * so the slash surface mirrors the tool surface by construction
 * (slash-exposure-tool-catalog-2026-06-12 P-004).
 *
 * Strict mode (default since 2026-05-11): listings mirror tools/call — a
 * FAILED spawn context yields nothing. Returning the full catalog to an
 * unsigned/forged URL would:
 *   1. leak the tool surface to probing without an audit trail
 *      (tools/list failures aren't logged); and
 *   2. let `role=operator` in an unsigned URL surface the operator-tier
 *      catalog without role-allowlist filtering, because
 *      tryBuildSpawnContext returns kind=failed and role falls back to
 *      `undefined` (no filter applied).
 * Soft-warn behavior is preserved when kind='none' (no spawn params at
 * all — e.g. a bare /api/mcp probe).
 *
 * Listing shape notes carried from the original tools/list body:
 *   - The projected-tool registry mirrors every built-in (defineTool
 *     auto-registers there) AND carries plugin tools — one iteration
 *     covers both; iterating getCatalog() on top would double-emit.
 *   - `applyToolManifest` pins the surface to the tool manifest (if
 *     configured) so the catalog the SDK inlines is byte-stable across
 *     reconnects/reloads; `manifestBypass=1` returns the full set so the
 *     snapshot generator can (re)write the manifest. See tool-manifest.ts.
 *   - `?tools=a:b,c:d` (voice-persona P-009) is an opt-in listing
 *     allowlist — a caller naming a small working set sees ONLY those
 *     tools. Listing hint only; tools/call is unaffected. tool-allowlist.ts.
 */
async function resolveVisibleToolListings(extra: unknown): Promise<
  | { kind: 'failed'; reason: string }
  | {
      kind: 'ok' | 'none';
      spawnRes: TrySpawnContextResult;
      listings: ReturnType<typeof listMcpProjections>;
    }
> {
  await ensureOperatorToolsLoaded();
  const spawnRes = await tryBuildSpawnContext(extra);
  // WI-574 (loud auth-fail): carry the rejection reason so tools/list can fail LOUDLY instead of
  // silently advertising an empty tool list (which is indistinguishable from a healthy server).
  if (spawnRes.kind === 'failed') return { kind: 'failed', reason: spawnRes.reason };
  // external-app-access P-004 (D-012 side finding): a bare, unauthenticated probe
  // lists the catalog only for a LOCAL caller. Outside traffic (a tunnel, a relay, a
  // non-loopback Host) with no auth context gets the loud auth failure instead of a
  // pre-auth catalog disclosure.
  if (spawnRes.kind === 'none' && !isLoopbackRequest(headersFromExtra(extra))) {
    return { kind: 'failed', reason: 'unauthenticated_non_local' };
  }
  const role = spawnRes.kind === 'ok' ? spawnRes.ctx.role : undefined;
  const rawProfile = spawnRes.kind === 'ok' ? spawnRes.ctx.profile : undefined;
  // GENERIC profile (P-025) → engineer-like tool visibility (the manifest filter only gates
  // power); coerce so the narrow listMcpProjections param need not carry 'generic'.
  const profile = rawProfile === 'generic' ? 'engineer' : rawProfile;
  const bypass = urlFromExtra(extra)?.searchParams.get('manifestBypass') === '1';
  let result = applyToolManifest(listMcpProjections(role, profile), { bypass });
  if (spawnRes.kind === 'ok' && spawnRes.ctx.authenticatedPrincipal) {
    const caps = spawnRes.ctx.authenticatedPrincipal.capabilities;
    result = result.filter((listing) => {
      const name = (listing as { name?: unknown }).name;
      if (typeof name !== 'string') return false;
      const projected = lookupByMcpName(name);
      return projected !== undefined && projected.capabilities.every((capability) => caps.has(capability));
    });
    // external-app-access P-003: an app key sees only the tools its scopes let it call —
    // the same policy the dispatch kernel seat enforces (connected-apps/enforce.ts).
    const appFilter = await appKeyToolListFilter(
      spawnRes.ctx.authenticatedPrincipal,
      spawnRes.ctx.workspaceId,
    );
    if (appFilter) {
      result = result.filter((listing) => {
        const name = (listing as { name?: unknown }).name;
        return typeof name === 'string' && appFilter(name);
      });
    }
  }
  // `?tools=` is the SEED, not a hard cap (dynamic-tool-surface-2026-07-01): a
  // seeded session's surface GROWS at runtime via ctx.activateTools (tools:find)
  // + notifications/tools/list_changed. getSessionSurface returns that live set
  // (created on this first tools/list, re-fetched-and-grown on later ones), or
  // the raw seed when there's no stable session key, or null (full catalog) when
  // there's no seed at all. Keyed by the su session identity (uiClientId).
  const seed = parseToolsAllowlist(urlFromExtra(extra)?.searchParams.get('tools'));
  const sessionKey = spawnRes.kind === 'ok' ? spawnRes.ctx.uiClientId : null;
  const allow = getSessionSurface(sessionKey, seed);
  // `?tools_compact=` is the SECOND axis of the same decision (deterministic-
  // tool-definition-delivery-2026-09-21): `?tools=` says WHICH tools are
  // advertised, this says HOW MUCH of each one ships. A named tool keeps its
  // full callable contract — only prose is removed — so the two params together
  // express full / compact / deferred instead of the all-or-nothing admission
  // that forced seven high-demand heavies out of the seed entirely. Absent ⇒
  // nothing is compacted, byte-identical to the previous behaviour. Applied
  // AFTER the allowlist filter so a compact name that is not advertised is
  // simply never reached.
  const compact = parseCompactToolNames(urlFromExtra(extra)?.searchParams.get('tools_compact'));
  return {
    kind: spawnRes.kind,
    spawnRes,
    listings: applyCompactTier(
      filterListingsByAllowlist(result, allow),
      compact,
      compactInputSchema,
      summaryGuidanceDescription,
    ),
  };
}

/**
 * prompts/get for the dynamic `tool:*` namespace (slash-exposure P-005):
 * resolve the slash-exposed tool, re-check session visibility with the SAME
 * predicates listMcpProjections applies, render the invoke-with-elicitation
 * instruction, and record slash-origin telemetry. Context requirements
 * mirror tools/call: a failed spawn ctx is rejected, and a bare probe with
 * no spawn params gets invalid_request_context. Mechanics live in
 * `_mcp-slash-prompts.ts` (testable without an HTTP harness).
 */
async function getSlashPrompt(
  promptName: string,
  args: Record<string, string>,
  extra: unknown,
): Promise<{ description?: string; messages: unknown[] }> {
  const spawnRes = await tryBuildSpawnContext(extra);
  if (spawnRes.kind === 'failed') {
    throw new Error(`request_rejected: ${spawnRes.reason}`);
  }
  if (spawnRes.kind === 'none') {
    throw new Error(
      'invalid_request_context: slash prompts require harness/workspace/role/run/spawn URL query params, or ?superuser=1 + bearer',
    );
  }
  const tool = resolveSlashToolForPrompt(promptName);
  if (!tool || !slashToolVisibleTo(tool, spawnRes.ctx.role, spawnRes.ctx.profile)) {
    throw new Error(`unknown_prompt: no slash-exposed tool for "${promptName}" in this session`);
  }
  const rendered = renderSlashPromptForTool(tool, args);
  void auditSlashPromptGet(spawnRes.ctx, tool.expose.mcp!.name, Object.keys(args));
  return { description: rendered.description, messages: rendered.messages };
}

/** Reuse these options for every connection; negotiation remains SDK-owned. */
export function mcpHostServerOptions() {
  return { capabilities: MCP_SERVER_CAPABILITIES, instructions: mcpInstructionsForServer() };
}

/** Register the complete operator protocol on a transport-independent SDK server. */
export function registerMcpHost(server: McpServer): void {
  server.server.setRequestHandler(sdk.ListToolsRequestSchema, async (_req: unknown, extra: unknown) => {
    // Shared visibility walk — see resolveVisibleToolListings above
    // (strict-mode + manifest + allowlist semantics documented there).
    const vis = await resolveVisibleToolListings(extra);
    if (vis.kind === 'failed') {
      // WI-574 (loud auth-fail): a REJECTED auth context (expired per-spawn signed URL, invalid
      // superuser bearer, bad signature) must NOT return a silent empty tool list — that is
      // indistinguishable from a healthy server with no tools and is the root of the "toolless
      // session that looks connected" class. Throw a specific JSON-RPC error so the client + agent
      // KNOW the session is unauthenticated and WHY. (Mirrors tools/call, which already hard-fails
      // a rejected spawn ctx.) A bare no-params probe is `kind:'none'`, not 'failed', and still lists.
      throw new Error(
        `mcp_auth_failed: ${vis.reason} — this MCP session is UNAUTHENTICATED, so it exposes NO tools ` +
          '(this is NOT "a healthy server with zero tools"). Typical causes: an EXPIRED per-spawn signed ' +
          'URL token (re-mint/reconnect) or a missing/invalid superuser bearer. Fix the credential and reconnect.',
      );
    }
    const filtered = vis.listings;
    // Objectify boolean sub-schemas (z.unknown() → `true`) so strict
    // consumers (Ollama) can parse the surface. This is THE tools/list
    // the HTTP MCP transport serves (OMP/Claude/Codex bundles); applied
    // post-manifest so pinned schemas are covered too. tool-schema-sanitize.ts.
    return {
      tools: await Promise.all(
        filtered.map(async (t) => {
          const tt = t as { name?: string; inputSchema?: unknown; outputSchema?: unknown };
          const out: Record<string, unknown> = { ...t };
          // MCP clients use the standard annotation to decide whether a
          // failed connection can safely replay a call. Keep the listing
          // spread above so registry metadata in `_meta` survives while
          // adding the effect-derived hint to the standard field.
          const projected = typeof tt.name === 'string' ? lookupByMcpName(tt.name) : undefined;
          const registryRevision = listingRegistryRevision(t);
          const listingVariant = projected && tt.inputSchema === projected.inputSchema ? 'full' : 'derived';
          if (projected?.effect) {
            const existingAnnotations =
              out.annotations && typeof out.annotations === 'object' && !Array.isArray(out.annotations)
                ? (out.annotations as Record<string, unknown>)
                : {};
            out.annotations = {
              ...existingAnnotations,
              readOnlyHint: projected.effect === 'read',
            };
          }
          if (tt.inputSchema) {
            // Registry write-positional tools advertise a single `row` string
            // (token-efficient-agent-io P-008) so the model emits a positional
            // row; every other tool advertises its real args schema. Applied
            // before sanitize so the swapped schema is objectified too.
            const advertised =
              typeof tt.name === 'string'
                ? advertisedArgsSchema(tt.name, tt.inputSchema as Record<string, unknown>)
                : (tt.inputSchema as Record<string, unknown>);
            // Publish small entity vocabularies as enums (P-004b). The listing
            // carries only the CONVERTED schema, so the entity-ref sites are
            // read back off the tool's live args schema by name; a listing with
            // no resolvable def (a plugin/pinned entry) simply gets no overlay.
            // Entity-ref markers are WeakMap-keyed on the RAW Zod args-schema object
            // identity (entity-ref.ts), so this needs the raw `ToolDefinition.args`
            // from the legacy tool registry — `ProjectedTool` (lookupByMcpName) only
            // carries the already-converted JSON `inputSchema`, a different object
            // that was never entityRef()-marked, so it can never match here.
            const def = typeof tt.name === 'string' ? lookupToolDefinitionByName(tt.name) : null;
            const hasLiveEntityOverlay = Boolean(def?.args && hasEntityRefSchema(def.args));
            if (hasLiveEntityOverlay) {
              // Enum fragments can change while the process stays live, so this
              // deliberately remains uncached. It is a small minority of the
              // catalog; caching the static majority removes the reconnect-time
              // deep-clone/GC burst without serving a stale vocabulary.
              await applyEntityRefEnums(def!.args, advertised);
              out.inputSchema = sanitizeToolSchema(advertised);
            } else {
              out.inputSchema = sanitizeToolSchemaCached(
                `${registryRevision}:${tt.name ?? '(anonymous)'}:${listingVariant}`,
                advertised,
              );
            }
          }
          // outputSchema (P-010) gets the same boolean-subschema objectification,
          // but with position:'output' (EI-22064217935223876): unlike inputSchema,
          // outputSchema is read back by the MCP client SDK to validate the tool's
          // REAL return value, so it must NOT force `type: 'object'` onto a
          // z.unknown()/z.any() result field whose actual value is a string, number,
          // array, or boolean — see tool-schema-sanitize.ts's `SanitizePosition` doc.
          if (tt.outputSchema) {
            out.outputSchema = sanitizeToolSchemaCached(
              `${registryRevision}:${tt.name ?? '(anonymous)'}:output`,
              tt.outputSchema,
              'output',
            );
          }
          return out;
        }),
      ),
    };
  });

  server.server.setRequestHandler(
    sdk.CallToolRequestSchema,
    withFuzzyToolName(
    async (
      req: {
        params: {
          name: string;
          arguments?: Record<string, unknown>;
          _meta?: {
            progressToken?: string | number;
            format?: string;
            idempotencyKey?: string;
            delta?: string;
            /** Canonical aggregate-output cohort supplied by a turn-aware client. */
            outputGroupId?: string | number;
            /** Compatibility alias used by clients that already expose a turn id. */
            turnId?: string | number;
          };
        };
      },
      extra: unknown,
    ) => {
      await ensureOperatorToolsLoaded();
      const toolName = req.params.name;
      // Wall-clock at handler entry. The dispatcher stamps its own startedAt for
      // a real dispatch; this one exists for the paths that answer WITHOUT
      // dispatching — today the idempotency replay branch, whose telemetry row
      // records how long serving the stored result took (WI-6792).
      const callStartedAt = Date.now();
      // `let` (not const): the scoped-superuser clamp may RE-RESOLVE a wildcard
      // `harness:'all'` on plans:list into a workspace-wide read of the session's
      // own workspace (F-A1) before dispatch — see the clamp block below.
      let args = req.params.arguments ?? {};
      const progressToken = req.params._meta?.progressToken;
      // Write idempotency / result replay (audit P-046 / EI-68): a caller
      // that passes `_meta.idempotencyKey` gets its result persisted under
      // that key; re-calling with the SAME key replays the stored outcome
      // instead of re-executing — so a write whose response died on a
      // dropped connection is recoverable, not re-fired. Opt-in per call.
      const idempotencyKey = validIdempotencyKey(req.params._meta?.idempotencyKey);
      // Result-format negotiation (P-009): per-call `_meta.format` wins over a
      // connection-level `?format=` on the MCP URL (how a client declares
      // compact/json once at setup). Absent ⇒ the transport default (compact).
      const requestedFormat = req.params._meta?.format ?? urlFromExtra(extra)?.searchParams.get('format') ?? undefined;
      const requestedStructured =
        (req.params._meta as { structured?: boolean } | undefined)?.structured === true ||
        urlFromExtra(extra)?.searchParams.get('structured') === '1';
      // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, D-001): a
      // per-call `_meta.delta` wins over a connection-level `?delta=` (mirrors
      // `?format=`). The HARNESS — not the model — sets this and owns cursor
      // storage + base-presence tracking; absent ⇒ no negotiation (serve full).
      const requestedDelta = req.params._meta?.delta ?? urlFromExtra(extra)?.searchParams.get('delta') ?? undefined;
      const explicitDelta =
        req.params._meta?.delta !== undefined || urlFromExtra(extra)?.searchParams.has('delta') === true;
      // mcp-handler passes the protocol's RequestHandlerExtra here,
      // which exposes a sendNotification function bound to the right
      // session. Use it to fire notifications/progress events.
      const sendNotification = (
        extra as {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
        }
      )?.sendNotification;

      // Dispatch priority:
      //   1. Projected dispatcher when a spawn ctx is present (per-spawn
      //      URL OR ?superuser=1 + bearer). This is the path that
      //      honors isSuperuser bypass + role allowlist + per-window
      //      quota. Every defineTool() entry is in the projected
      //      registry, so this covers all first-party tools too.
      //   2. Legacy bearer-only dispatch ONLY when no spawn ctx — e.g.
      //      in-process callers or one-off bearer-authed hits that
      //      don't supply URL params.
      //   3. Unknown.
      //
      // Prior to 2026-05-11 the order was reversed: the legacy bearer
      // dispatch ran first for anything in getCatalog(), which made
      // ?superuser=1 fail with `invalid_bearer` for ~24 first-party
      // tools (harness:*, tasks:*, messages:*, intel:*, features:*,
      // papercusp:list_workspaces, …) because the superuser token
      // isn't a registered principal. See docs/endpoint-system/
      // superuser-mode.mdx — the bypass logic lives in
      // dispatch-projected.ts, never in dispatch().
      const projected = lookupByMcpName(toolName);
      // EI-9510: the replay-store round-trip (lookupStoredMcpResult /
      // storeMcpResult, both awaited on the hot path below) only matters for
      // a WRITE — a read-only tool has no mutation to double-apply, so
      // replaying it is a pure no-op. P-005 makes the proxy inject
      // `_meta.idempotencyKey` on every call regardless, so without this
      // gate every read pays one extra awaited INSERT + one extra lookup
      // round-trip too. `projected.effect` ('read'|'write') is inferred
      // from the tool's capability suffix at defineTool time — skip both
      // the lookup and the store when it resolves to 'read'.
      const skipReplayForReadOnly = projected?.effect === 'read';
      const spawnRes = await tryBuildSpawnContext(extra, {
        // A stale bound plan can otherwise prevent the recovery bootstrap from
        // reaching the current fleet binding that would scope this request.
        // Direct declare-intent is admitted only for an explicit self-clear;
        // all non-clear declarations remain fail-closed on stale bindings.
        allowStalePlanRecovery: allowStalePlanRecoveryForMcpCall(toolName, args),
      });

      // Hard-fail spawn ctx with invalid signature — do NOT fall through
      // to legacy bearer dispatch. That's the whole point of the
      // verification step.
      if (spawnRes.kind === 'failed') {
        await recordMcpAuthFailureTelemetry(toolName, extra, spawnRes.reason, projected, callStartedAt);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `request_rejected: ${spawnRes.reason}`,
            },
          ],
        };
      }

      if (projected && spawnRes.kind === 'ok') {
        // Normally the session harness remains authoritative for the whole
        // request. The one narrow exception below (plans:get + an exact
        // plan-slug owner verified against the workspace index) rebinds this
        // effective value after the hive clamp has proved the caller named a
        // real row. Keep this separate from spawnRes.ctx: the signed/session
        // context is the original ambient scope, while dispatch gets the
        // verified read target.
        let effectiveHarnessSlug = spawnRes.ctx.harnessSlug;
        // Profile gate: power-profile callers cannot invoke Group A tools
        // even if they know the name. Mirrors the tools/list filter so
        // direct-name calls can't bypass the listing restriction.
        if (spawnRes.ctx.profile === 'power' && projected.profile === 'engineer') {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `tool_not_available_for_profile: "${toolName}" is not available in the power-engineer profile`,
              },
            ],
          };
        }
        // scoped-superuser-workspace-clamp (P-006/P-007), flag-gated. A SCOPED
        // superuser session (concrete workspaceId, not '*') is confined to its
        // workspace: (a) a crossWorkspace tool — which bypasses the workspace tx
        // (getOrgPg) and spans workspaces by design (see the P-062 admin-ctx
        // branch below) — is DENIED, UNLESS it is on the scoped-safe allowlist
        // (self-confines to the caller's own workspace + read-only; EI-1810);
        // (b) its per-call `workspace` arg is overwritten with the clamped
        // workspace (mirrors the power-user clamp). Only an UNSCOPED ('*')
        // superuser may span. Flag OFF → no-op.
        const scopedSuperuserClamp =
          spawnRes.ctx.isSuperuser === true &&
          spawnRes.ctx.workspaceId !== '*' &&
          (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system'));
        if (
          scopedSuperuserClamp &&
          projected.crossWorkspace === true &&
          !isScopedSafeCrossWorkspaceTool(toolName) &&
          // GLOBAL-config superuser meta-controls (flags:*) are exempt — they touch no
          // per-workspace tenant data, and denying flags:set circularly locks the
          // operator out of the very control that governs this clamp. See
          // SUPERUSER_GLOBAL_FLAG_ADMIN above for the security review.
          !isSuperuserGlobalFlagAdmin(toolName)
        ) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `workspace_forbidden: "${toolName}" spans workspaces, but this session is scoped to workspace "${spawnRes.ctx.workspaceId}". Use an unscoped (--all-workspaces) superuser session to span workspaces.`,
              },
            ],
          };
        }
        // scoped-superuser-workspace-clamp (P-008, security half): a scoped session
        // may NOT use the harness:'all'/'*' GLOBAL escape — resolvePlanScope maps it
        // to PAPERCUSP_WORKSPACE_ID/papercup, a cross-scope read. Re-resolve only
        // the two workspace-safe operations that have an in-workspace meaning:
        // plans:list reads this workspace's plans, and loop:arm resolves this
        // workspace's formal home pot before materializing its concrete routine.
        // Every other tool still rejects the global escape.
        if (scopedSuperuserClamp) {
          const ah =
            args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness === 'string'
              ? ((args as Record<string, unknown>).harness as string).trim()
              : '';
          if (ah === 'all' || ah === '*') {
            // F-A1 (leaks D-4 / clamp D-002): for a WORKSPACE-scoped session
            // (ctx.harnessSlug '*', not pinned to a hive), harness:'all'/'*' on
            // plans:list means "THIS workspace's plans" and loop:arm means
            // "this workspace's formal home pot" — never the global
            // PAPERCUSP_WORKSPACE_ID/papercup escape. Drop the wildcard before
            // dispatch; each handler then applies its own concrete workspace
            // resolution. Scoped narrowly: only these tools, only the workspace
            // tier — a HIVE-pinned session's global scope still rejects, and any
            // OTHER tool's 'all'/'*' has no safe in-workspace meaning.
            if (
              (toolName === 'plans:list' || toolName === 'loop:arm') &&
              spawnRes.ctx.harnessSlug === '*' &&
              args &&
              typeof args === 'object'
            ) {
              const rest = { ...(args as Record<string, unknown>) };
              delete rest.harness;
              args = toolName === 'plans:list' ? { ...rest, workspaceWide: true } : rest;
            } else {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `harness_forbidden: harness:'${ah}' is the unscoped global escape; this session is scoped to workspace "${spawnRes.ctx.workspaceId}". Name a concrete harness in scope, or use an unscoped (--all-workspaces) session.${engineeringDocsSurfaceHint(toolName)}`,
                  },
                ],
              };
            }
          }
        }
        // scoped-superuser-workspace-clamp (P-017, workspace tier): a concrete per-call
        // `harness` arg that resolves to a DIFFERENT workspace is REJECTED. The
        // plans/work-item readers derive a harness's workspace from the harness REGISTRY
        // (resolvePlanScope → resolveWorkspaceForHarnessSlug), NOT the clamped
        // ctx.workspaceId — so a scoped session could otherwise name a foreign-workspace
        // harness and read its plans even though crossWorkspace tools + harness:'all' are
        // already denied (the gap su-c5b1c's active-ws-first fallback narrowed but left
        // open via its cross-ws scan). We resolve the harness's workspace EXPLICITLY
        // against the session's own workspace — the request-scoped ALS is not yet pinned
        // to the clamped workspace at this point, so we pass ctx.workspaceId by hand
        // (the hive-tier clamp below does the same with potHomeSlugForHarness). The
        // hive tier is a FINER same-workspace/different-hive check that composes on top.
        // Fail-OPEN on an infra error / unresolvable-or-ambiguous slug (P-006); fail-CLOSED
        // only on a CONFIRMED foreign resolution.
        if (scopedSuperuserClamp) {
          const ah =
            args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness === 'string'
              ? ((args as Record<string, unknown>).harness as string).trim()
              : '';
          if (ah && ah !== 'all' && ah !== '*') {
            const { resolveWorkspaceForHarnessSlugIn } = await import('../../../harness-core');
            let harnessWs: string | null = null;
            try {
              harnessWs = await resolveWorkspaceForHarnessSlugIn(spawnRes.ctx.workspaceId, ah);
            } catch {
              // Ambiguous cross-workspace collision (resolver throws) or an infra error:
              // fail OPEN — let the tool resolve/fail loud rather than block a same-name slug.
              harnessWs = null;
            }
            if (harnessWs && harnessWs !== spawnRes.ctx.workspaceId) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `harness_forbidden: harness "${ah}" belongs to workspace "${harnessWs}", but this session is scoped to workspace "${spawnRes.ctx.workspaceId}". Name a harness in scope, or use an unscoped (--all-workspaces) session.`,
                  },
                ],
              };
            }
          }
        }
        // Hive tier (P-014a; owner-ratified 2026-06-18 — AUTO-CONFINE on harness).
        // When a scoped-superuser session's concrete harness belongs to a hive,
        // it is confined to THAT hive's subtree: (a) cross_harness:* tools (which
        // read OTHER harnesses) are denied; (b) a per-call `harness` arg that
        // escapes the hive — harness:'all'/'*', or a harness in a different hive —
        // is rejected. Subtree membership = potHomeSlugForHarness(harness) ===
        // scopeHive (the hive home AND each member resolve to the home; D-006).
        // The harder half — confining the workspace-global coord/fleet/search/
        // memory surfaces per-hive (P-014b) — is a separate multi-subsystem change.
        if (scopedSuperuserClamp && spawnRes.ctx.harnessSlug !== '*') {
          const { potHomeSlugForHarness } = await import('../../../hive-federation');
          // EI-21910110662818467: the generic harness-arg sweep below. Kept in its
          // own module so the SAME predicate that decides "this arg names a
          // harness" is what the coverage detector
          // (scripts/check-harness-arg-coverage.ts) audits the registry with —
          // clamp and detector cannot drift apart into two opinions.
          const { collectHarnessSlugArgs } = await import('../../hive-harness-arg-coverage');
          const scopeHive = await potHomeSlugForHarness(spawnRes.ctx.workspaceId, spawnRes.ctx.harnessSlug);
          if (scopeHive) {
            if (toolName.startsWith('cross_harness:')) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `harness_forbidden: "${toolName}" reads other harnesses, but this session is confined to hive "${scopeHive}".`,
                  },
                ],
              };
            }
            const argHarness =
              args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness === 'string'
                ? ((args as Record<string, unknown>).harness as string).trim()
                : '';
            if (argHarness) {
              // EI-20224778911207159: the engineering docs sentinel names
              // Papercusp's static framework reference, not a tenant harness.
              // docs:get/search/outline/author handlers already resolve it to the
              // engineering surface and gate it to superusers; do not let the
              // hive clamp reject the documented workspace-scoped route before
              // those handlers can run. Keep the exemption tool-specific so a
              // caller cannot use the literal "engineering" as a general
              // cross-hive escape.
              const isEngineeringDocsSurface =
                isEngineeringDocsSentinel(argHarness) &&
                (toolName === 'docs:get' ||
                  toolName === 'docs:search' ||
                  toolName === 'docs:outline' ||
                  toolName === 'docs:author');
              const isPlatformPotGitSyncTarget = isExplicitPlatformPotGitSyncTarget(
                toolName,
                'harness',
                argHarness,
                args,
              );
              const isReservedHarnesslessRoutineTarget = isExplicitReservedHarnesslessRoutineTarget(
                toolName,
                'harness',
                argHarness,
                args,
                spawnRes.ctx.workspaceId,
              );
              const isSelfOwnedCheckpointRead = isSelfOwnedCheckpointTransportException(toolName, args, spawnRes.ctx);
              const escapes =
                !isEngineeringDocsSurface &&
                !isPlatformPotGitSyncTarget &&
                !isReservedHarnesslessRoutineTarget &&
                !isSelfOwnedCheckpointRead &&
                (argHarness === 'all' ||
                  argHarness === '*' ||
                  (await potHomeSlugForHarness(spawnRes.ctx.workspaceId, argHarness)) !== scopeHive);
              // A resumed fleet leader can retain an ambient Hive while
              // naming the owning harness of one exact plan. Verify the row
              // in this workspace BEFORE rebinding dispatch. Keep this
              // exemption deliberately narrow: plans:get is the exact-plan
              // read recovery surface, plans:add-decision is the cross-lane
              // ruling writer, and coord:declare-intent is the structured
              // plan-lane claim whose current_plan_slug is verified here.
              // Every other tool/query keeps the normal sibling-Hive rejection.
              const verifiedExactPlanRebind =
                escapes &&
                (toolName === 'plans:get' ||
                  toolName === 'plans:add-decision' ||
                  toolName === 'coord:declare-intent') &&
                (await verifyExplicitPlanHarness(spawnRes.ctx, argHarness, args));
              const goalLocalPlacement =
                escapes && (await mayUseGoalLocalPlacement(toolName, spawnRes.ctx, scopeHive, argHarness));
              if (verifiedExactPlanRebind || goalLocalPlacement) {
                effectiveHarnessSlug = argHarness;
              } else if (escapes) {
                const crossHiveClaimHint =
                  toolName === 'work_items:claim'
                    ? ' For cross-Pot work, use discovery:pots → pot:request_work with an outbound work-request grant; direct work_items:claim is per-Hive.'
                    : '';
                // EI-21920346945864571: the bare hint below ("retry with the
                // caller's harness") was reported as untrustworthy — an agent
                // reasoned that retrying under its OWN (different) harness could
                // not possibly resolve a row canonically owned by a DIFFERENT
                // harness, and skipped the retry entirely. That reasoning is
                // right for a feature-family id (WI-/F-), which genuinely IS
                // scoped by harness in the underlying query
                // (`getFeatureWorkItemOnly`) — but WRONG for an issue-family id
                // (EI-<snowflake>): `getWorkItem`'s issue-family branch
                // (`getIssue`) never applies the `harness` argument at all (see
                // the doc comment on `getWorkItem` in work-items.ts) and resolves
                // by workspace instead, so the exact retry this hint suggests
                // DOES find the row. Tell the caller which case they are in
                // instead of leaving them to guess.
                const requestedIds: unknown[] = [];
                if (args && typeof args === 'object') {
                  const a = args as Record<string, unknown>;
                  if (typeof a.id === 'string') requestedIds.push(a.id);
                  if (Array.isArray(a.ids)) requestedIds.push(...a.ids);
                }
                const allRequestedIdsAreIssueFamily =
                  requestedIds.length > 0 && requestedIds.every((id) => typeof id === 'string' && id.startsWith('EI-'));
                const crossHiveWorkItemReadHint =
                  toolName === 'work_items:get'
                    ? allRequestedIdsAreIssueFamily
                      ? ` For an ID-based work_items:get read, retry with the caller's harness "${spawnRes.ctx.harnessSlug}" (or omit \`harness\` entirely); do not copy a returned row's canonical harness into this argument. An EI-prefixed id resolves WORKSPACE-wide — the \`harness\` argument is not applied to that lookup at all — so this retry WILL find the row.`
                      : ` For an ID-based work_items:get read, retry with the caller's harness "${spawnRes.ctx.harnessSlug}"; do not copy a returned row's canonical harness into this argument. Note: a WI-/F- (feature-family) id genuinely IS scoped to its owning harness, so this retry will NOT resolve a row that belongs to a different one — there is currently no cross-hive escape for a feature-family id from a hive-confined session.`
                    : '';
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text' as const,
                      text: `harness_forbidden: harness "${argHarness}" is outside this session's hive "${scopeHive}".${crossHiveClaimHint}${crossHiveWorkItemReadHint}${crossHiveLaunchHint(toolName, scopeHive)}${crossHiveSelfSweepHint(toolName, argHarness, scopeHive)}`,
                    },
                  ],
                };
              }
            }
            // P-016/P-014b: the harness check above keys on `harness`, but the
            // search + memory surfaces (search:fulltext/semantic, memory:search/
            // list/remember) scope by `harness_slug` — a hive-scoped session could
            // otherwise target a SIBLING-hive harness's prose/recall through that
            // arg. Reject a `harness_slug` that resolves outside the hive subtree
            // (same escapes rule as `harness`).
            const argHarnessSlug =
              args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness_slug === 'string'
                ? ((args as Record<string, unknown>).harness_slug as string).trim()
                : '';
            if (argHarnessSlug) {
              const escapes =
                argHarnessSlug === 'all' ||
                argHarnessSlug === '*' ||
                (await potHomeSlugForHarness(spawnRes.ctx.workspaceId, argHarnessSlug)) !== scopeHive;
              if (escapes) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text' as const,
                      text: `harness_forbidden: harness_slug "${argHarnessSlug}" is outside this session's hive "${scopeHive}".`,
                    },
                  ],
                };
              }
            }
            // WI-1345963: the two checks above key on the arg NAMES `harness` and
            // `harness_slug`, but several tools name a harness through `scope`:
            //   • improvements:capture takes scope:'harness:<slug>' — and its OWN
            //     schema recommends that spelling ("prefer scope:'harness:foo' for
            //     new calls") while documenting `harness` as a mere compatibility
            //     alias. So the RECOMMENDED spelling escaped this gate while the
            //     deprecated one hit it — exactly backwards.
            //   • facts:assert / facts:list take scope:'harness' + scopeRef
            //     (aliases scope_ref / ref).
            // Confirmed hole, not theory (harness_shared.tool_invocations @
            // 2026-08-30T15:15:24.754Z): a session confined to hive 'papercusp'
            // passed NO `harness` arg and scope:'harness:calendar', and planted
            // EI-21891461660239266 in hive 'calendar'. It could then neither claim,
            // comment on, nor close the row it had created — work_items:get/claim/
            // comment all refuse it — so the item is stranded `open` forever and
            // reads to every later agent as outstanding work.
            // Every harness-naming spelling belongs in the ONE list below: adding a
            // new one is a line here, not a sixth bypass found in production.
            const scopeArgRaw =
              args && typeof args === 'object' && typeof (args as Record<string, unknown>).scope === 'string'
                ? ((args as Record<string, unknown>).scope as string).trim()
                : '';
            if (scopeArgRaw) {
              const scopeRefRaw = ((): string => {
                if (!args || typeof args !== 'object') return '';
                const a = args as Record<string, unknown>;
                for (const k of ['scopeRef', 'scope_ref', 'ref']) {
                  if (typeof a[k] === 'string') {
                    const v = (a[k] as string).trim();
                    if (v) return v;
                  }
                }
                return '';
              })();
              // Only the harness-naming forms; 'workspace' | 'owner' | 'role' |
              // 'work_item' | 'all' | 'hive' name no harness and are left to the
              // dedicated checks below (coord:presence) and to the tools themselves.
              const scopeNamedHarness = scopeArgRaw.startsWith('harness:')
                ? scopeArgRaw.slice('harness:'.length).trim()
                : scopeArgRaw === 'harness'
                  ? scopeRefRaw
                  : '';
              if (scopeNamedHarness) {
                const escapes =
                  scopeNamedHarness === 'all' ||
                  scopeNamedHarness === '*' ||
                  (await potHomeSlugForHarness(spawnRes.ctx.workspaceId, scopeNamedHarness)) !== scopeHive;
                if (escapes) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: 'text' as const,
                        text: `harness_forbidden: scope "${scopeArgRaw}" names harness "${scopeNamedHarness}", which is outside this session's hive "${scopeHive}". A cross-hive item filed this way could not later be claimed, commented on, or closed by this session.`,
                      },
                    ],
                  };
                }
              }
            }
            // P-016/P-014b: confine the workspace-GLOBAL read surfaces (coord/
            // fleet/presence) per-hive. The harness-arg + cross_harness checks
            // above cover the harness-keyed reads; this closes the surfaces that
            // read by a `hive` arg or a cross-hive `scope` selector.
            // (a) A `hive` arg naming a DIFFERENT hive is an explicit sibling-hive
            //     read on any tool (coord:presence, pot:get/status, coord:wake, …)
            //     → reject (a hive slug means the same thing on every tool).
            // (b) coord:presence is the one read surface with a hive|workspace|all
            //     scope selector. Workspace-wide roster BROWSING still widens out of
            //     the caller's Hive and is rejected. A targeted `{ owner }` lookup is
            //     different: presence-snapshot intentionally defaults that exact-row
            //     lookup to workspace scope even when `scope` is omitted, so spelling
            //     the already-effective `scope:'workspace'` explicitly must not fail at
            //     this earlier transport gate. `scope:'all'` remains forbidden even for
            //     a targeted lookup because it crosses the workspace boundary.
            // search/memory stay workspace-scoped via the per-workspace F-C1
            // foundation; a per-hive subtree-narrowing of free-text search/recall is
            // a tracked follow-on (P-016b) — latent today (live workspace == 1 hive).
            const hiveArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
            const argHive = hiveArgs && typeof hiveArgs.hive === 'string' ? hiveArgs.hive.trim() : '';
            if (argHive && argHive !== scopeHive) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `hive_forbidden: hive "${argHive}" is outside this session's hive "${scopeHive}".`,
                  },
                ],
              };
            }
            // (c) EI-21910110662818467: GENERIC sweep over every OTHER top-level
            // arg whose NAME designates a harness. The four branches above read
            // fixed spellings LITERALLY, and that list has only ever grown
            // reactively — after each bypass was found in production
            // (harness -> harness_slug -> hive -> scope -> scope:'harness:<slug>').
            // A census of the live registry (837 tools / 3996 top-level args)
            // measured 12 further harness-naming spellings that no branch read,
            // several of which genuinely route: `harnessSlug` alone is declared by
            // 34 tools and OVERRIDES ctx (roles/list.ts:38 passes it straight to
            // resolveConcreteHarnessSlug), so a confined session could read another
            // hive through it with nothing to stop the call.
            //
            // This sweep covers new spellings automatically instead of waiting for
            // a sixth bypass. It deliberately SKIPS the four literal args above:
            // those carry bespoke narrow exemptions (engineering-docs surfaces, the
            // plans:get / plans:add-decision fleet-leader case) that re-checking
            // generically would silently discard. Non-string values yield nothing,
            // so a numeric `harnessLimit` or a boolean widener is skipped without
            // needing an allowlist entry.
            // `toolName` matters: a bare `slug` is a feature slug on features:*
            // but "the pot's home-harness slug" on pot:* — and pot:obliterate
            // is the sharp end of getting that wrong.
            for (const { arg, slug } of collectHarnessSlugArgs(args, { toolName })) {
              if (
                isExplicitPlatformPotGitSyncTarget(toolName, arg, slug, args) ||
                isExplicitReservedHarnesslessRoutineTarget(toolName, arg, slug, args, spawnRes.ctx.workspaceId)
              ) continue;
              const escapesHive =
                slug === 'all' ||
                slug === '*' ||
                (await potHomeSlugForHarness(spawnRes.ctx.workspaceId, slug)) !== scopeHive;
              if (escapesHive) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text' as const,
                      text: `harness_forbidden: ${arg} "${slug}" names a harness outside this session's hive "${scopeHive}". A cross-hive call made this way could not later be claimed, commented on, or closed by this session.${crossHiveSelfSweepHint(toolName, slug, scopeHive)}`,
                    },
                  ],
                };
              }
            }
            const targetedPresenceOwner = toolName === 'coord:presence' && hasTargetedPresenceSelector(hiveArgs);
            const forbiddenPresenceScope =
              toolName === 'coord:presence' &&
              (hiveArgs?.scope === 'all' || (hiveArgs?.scope === 'workspace' && !targetedPresenceOwner));
            if (forbiddenPresenceScope) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `hive_forbidden: coord:presence scope:'${String(hiveArgs?.scope)}' spans past this session's hive "${scopeHive}" — browse your hive by default, or use a targeted { owner } lookup for one workspace peer.`,
                  },
                ],
              };
            }
          }
        }
        // Power-user / scoped-superuser workspace clamp (defense in depth). The
        // ctx's workspaceId is already clamped, so any tool reading
        // ctx.workspaceId is safe. But a handful of tools accept an explicit
        // workspace-target ARG used as a filter. We overwrite that arg with the
        // clamped workspace before the tool sees it — this defends every tool,
        // present and future, without a per-tool audit.
        //
        // WI-6641: BOTH spellings, `workspace` AND `workspaceId`. The original
        // audit (2026-05-20) found only ui:list_clients and hardcoded its spelling,
        // so the "defends every tool, present and future" claim above silently did
        // not hold for the other one — a scoped session could hand
        // `workspaceId: '<someone-else>'` straight through. Three tools spell it
        // that way today (pot_git:secrets_exemptions, substrate:revoke_contributor,
        // substrate:revoke_self_device — the last two being REVOCATION writes), and
        // nothing stopped a fourth. Clamp on the ARG NAME, not on a tool list.
        const WORKSPACE_TARGET_ARGS = ['workspace', 'workspaceId'] as const;
        let dispatchArgs = args;

        // P-020 / D-041: the caller-specified PROJECTION stage — the reduction
        // operators bash gets from pipes, available on EVERY tool rather than
        // as a per-tool param. Reserved at the DISPATCH layer, so `projection`
        // is stripped before the tool's own schema validation sees it (tool
        // schemas are additionalProperties:false; an unstripped key would be
        // rejected as unknown by every tool in the catalog).
        //
        // Validated HERE, before dispatch, and fail-CLOSED: a malformed spec
        // is the caller's bug, it is knowable without running anything, and a
        // caller who asked for `head 20` must never be silently handed 4,000
        // lines they did not agree to pay for. A spec that is well-formed but
        // does not FIT the result fails open instead — see applyResultProjection.
        let projectionSpec: ProjectionSpec | null = null;
        let projectionNeedsFullSource = false;
        if (
          dispatchArgs &&
          typeof dispatchArgs === 'object' &&
          PROJECTION_ARG in (dispatchArgs as Record<string, unknown>)
        ) {
          const raw = (dispatchArgs as Record<string, unknown>)[PROJECTION_ARG];
          const parsed = parseProjection(raw);
          if (!parsed.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    `projection_invalid: ${parsed.error}\n` +
                    `The \`projection\` argument reduces ANY tool result: ` +
                    `{ pick?: ["results[].id"], pipe?: [{ op:"grep", pattern:"..." }, { op:"head", n:20 }] }. ` +
                    `A single \`pick\` list accepts at most ${MAX_PICK_PATHS} paths; split larger selections across calls. ` +
                    `Operators: grep (fixed/ignoreCase/invert/before/after/context), head, tail, sort, uniq, cut, count.`,
                },
              ],
            };
          }
          projectionSpec = parsed.spec;
          const { [PROJECTION_ARG]: _stripped, ...rest } = dispatchArgs as Record<string, unknown>;
          dispatchArgs = rest;
          // P-008: projection is exhaustive only when it runs over the
          // materialized source. Payload shaping happens inside defineTool,
          // before this transport-level stage; without the reserved full
          // override, coord:orient's 18KB ceiling can discard the selected
          // field before `pick` sees it. Preserve an explicit caller tier;
          // otherwise promote only the inner dispatch context so neither
          // reserved control is exposed to the target's validated args.
          projectionNeedsFullSource = !('payloadTier' in dispatchArgs);
        }
        const forwardedToolsInvokeProjection = forwardToolsInvokeProjection(toolName, dispatchArgs, projectionSpec);
        dispatchArgs = forwardedToolsInvokeProjection.dispatchArgs;
        projectionSpec = forwardedToolsInvokeProjection.projectionSpec;
        // The sibling control takes the same route, for the same reason: an outer
        // payloadTier is meant for the re-dispatched TARGET, and tools:invoke would
        // otherwise drop it silently. EI-21245922047633177.
        dispatchArgs = forwardToolsInvokePayloadTier(toolName, dispatchArgs);
        // Named result views (P-001) — the DIRECT path. Same helper, same
        // semantics as the nested `tools:invoke` path above; routing both
        // through one function is what keeps them from drifting.
        const takenView = takeNamedViewFromArgs(dispatchArgs as Record<string, unknown> | undefined, toolName);
        if (takenView.kind === 'error') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: takenView.error }],
          };
        }
        let namedView: Extract<ViewResolution, { ok: true }> | null = null;
        if (takenView.kind === 'view') {
          namedView = takenView.resolved;
          dispatchArgs = takenView.args;
          projectionNeedsFullSource = !('payloadTier' in dispatchArgs);
        }
        if ((spawnRes.ctx.isPowerUser || scopedSuperuserClamp) && args && typeof args === 'object') {
          for (const key of WORKSPACE_TARGET_ARGS) {
            if (key in (args as Record<string, unknown>)) {
              dispatchArgs = { ...(dispatchArgs as Record<string, unknown>), [key]: spawnRes.ctx.workspaceId };
            }
          }
        }
        // Durable coordination/replay keys stay scoped to the caller's STABLE identity: uiClientId
        // (the per-session SID for SU/power sessions, where spawnId is per-request) falling back
        // to spawnId (stable for signed orchestrator spawns). Advisory nudge state has a narrower
        // lifetime and must additionally isolate independent MCP transport connections that happen
        // to carry the same stable SID; see `nudgeSessionKey` below.
        const replayOwnerKey = spawnRes.ctx.uiClientId ?? spawnRes.ctx.spawnId;
        const transportSessionId = (() => {
          const sdkSessionId = (extra as { sessionId?: unknown })?.sessionId;
          if (typeof sdkSessionId === 'string' && sdkSessionId.trim()) return sdkSessionId.trim();
          // mcp-handler's current stateless POST adapter does not populate SDK `sessionId`, but
          // clients may still carry the protocol's connection marker in this request header.
          return headersFromExtra(extra).get('mcp-session-id')?.trim() || null;
        })();
        // Keep the stable owner as the prefix for attribution, but scope all process-local
        // advisory rings/one-shot guards to the actual MCP transport when one is available.
        // Reconnects intentionally receive a fresh advisory window; durable identity continuity
        // remains on replayOwnerKey for coordination, replay, and result-door aggregation.
        const nudgeSessionKey = advisorySessionKey(replayOwnerKey, transportSessionId);
        // P-006 / D-014: reserve the aggregate cohort at REQUEST START. A
        // turn-aware client supplies outputGroupId/turnId; older MCP clients
        // use beginResultDoorAggregate's explicit best-effort start cohort.
        // Reserving here (rather than when the result completes) keeps a slow
        // member of a parallel fan-out in the same cohort as its siblings.
        const aggregateScope = beginResultDoorAggregate({
          sessionKey: replayOwnerKey,
          outputGroupId: req.params._meta?.outputGroupId ?? req.params._meta?.turnId,
          startedAtMs: callStartedAt,
        });
        // Superuser per-call workspace scoping (EI-30) — the inverse of the
        // power-user clamp. An unscoped superuser session (workspaceId '*')
        // that passes a concrete `workspace` arg dispatches under THAT
        // workspace (tx synthesis + ALS pin below), exactly as ?workspace=X
        // would have. See effectiveDispatchWorkspace for the rationale.
        const effectiveWs = effectiveDispatchWorkspace(spawnRes.ctx, dispatchArgs);
        const effectiveSpawnCtx =
          effectiveHarnessSlug === spawnRes.ctx.harnessSlug
            ? spawnRes.ctx
            : { ...spawnRes.ctx, harnessSlug: effectiveHarnessSlug };
        const dispatchSpawnCtx =
          effectiveWs === effectiveSpawnCtx.workspaceId
            ? effectiveSpawnCtx
            : { ...effectiveSpawnCtx, workspaceId: effectiveWs };
        const baseCtx = await buildMcpToolContext(
          dispatchSpawnCtx,
          progressToken,
          sendNotification,
          projected.pluginName,
          requestedFormat,
          requestedStructured,
          requestedDelta,
          idempotencyKey ?? undefined,
          (extra as { signal?: AbortSignal } | undefined)?.signal,
        );
        // Cancellation may arrive during asynchronous context construction.
        // Do not dispatch a new mutation after that already-aborted request.
        baseCtx.signal.throwIfAborted();
        // Replay lookup (P-046 / EI-68) — a call carrying an idempotencyKey whose
        // outcome is already stored is answered from the store WITHOUT re-running
        // the tool. Best-effort: a store outage degrades to normal execution,
        // never an error.
        //
        // Placement (WI-6792): after the profile/hive gates — so a replay grants
        // nothing a fresh call wouldn't — AND after `baseCtx`, which is the whole
        // reason it sits here rather than ~30 lines earlier. Returning before
        // dispatch means the dispatcher's own recordTelemetry never fires, so a
        // replayed call used to land in NO tool_invocations row at all: it was
        // indistinguishable from a call that never happened. During the WI-6752
        // window the mcp-proxy re-sent already-dispatched POSTs, a large share of
        // traffic was served from replay, and the resulting hole read as a
        // 13-minute fleet-wide WRITE GAP — several agents chased writes that were
        // never lost. Recording the row needs a UnifiedToolContext, and building
        // it here (rather than synthesizing a stub) is what makes the replay row
        // carry the SAME attribution — role, run/spawn, harness, coord owner,
        // transport — a fresh call would have written, so the two are directly
        // comparable in one query. Nothing between the old position and here has
        // a side effect: effectiveDispatchWorkspace is pure and
        // buildMcpToolContext is construction plus one registry-backed path read.
        if (idempotencyKey && !skipReplayForReadOnly) {
          try {
            const stored = await lookupStoredMcpResult(replayOwnerKey, idempotencyKey);
            if (stored) {
              // Telemetry gets its OWN try/catch, deliberately not the outer one:
              // a throw caught outside would fall through to normal execution and
              // RE-RUN the tool — double-applying the very write this branch
              // exists to protect. A telemetry failure must cost a row, never a
              // duplicated mutation.
              try {
                // Same window the dispatcher would have resolved (initExecution),
                // so a replay row groups with the real calls it accompanies.
                const roleQuota = baseCtx.role ? projected.rolesQuota?.[baseCtx.role] : undefined;
                const recordInvocation = PROJECTED_DEPS.recordInvocation;
                // Telemetry is best-effort and must not hold a replay hostage:
                // the stored mutation result is already available, while this
                // write can contend on the invocation ledger under load. Start
                // the call in a microtask so synchronous throws are captured too,
                // then detach both the telemetry promise and its rejection.
                void Promise.resolve()
                  .then(() =>
                    recordInvocation?.({
                      toolName,
                      pluginName: projected.pluginName,
                      ctx: baseCtx,
                      windowKey: PROJECTED_DEPS.computeQuotaWindow?.(baseCtx, roleQuota, toolName).key ?? '',
                      durationMs: Date.now() - callStartedAt,
                      // NOT 'ok' — quota counts `status='ok'` rows, and a replay does
                      // no work, so 'ok' would charge the caller for a call that never
                      // ran. See the RecordInvocationInput['status'] note.
                      status: 'replayed',
                      args: dispatchArgs,
                      // The retry key, so a storm is groupable by the key being
                      // re-sent — the one field the row cannot otherwise recover.
                      metadataJson: { replayIdempotencyKey: idempotencyKey },
                    }),
                  )
                  .catch((err) => {
                    console.warn(
                      `[mcp-replay] telemetry failed for ${toolName} (key=${idempotencyKey}): ` +
                        (err instanceof Error ? err.message : String(err)),
                    );
                  });
              } catch (err) {
                // Building the detached telemetry chain is best-effort too.
                // Keep this guard for unusual synchronous failures such as a
                // throwing getter on the projected dependency object.
                console.warn(
                  `[mcp-replay] telemetry failed for ${toolName} (key=${idempotencyKey}): ` +
                    (err instanceof Error ? err.message : String(err)),
                );
              }
              const storedResult = stored as {
                content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
                isError?: boolean;
                _meta?: Record<string, unknown>;
                structuredContent?: unknown;
              };
              // P-006 / D-014: a replay is still model-facing output. Stored
              // outcomes were already per-result-doored before persistence,
              // but this request must consume the CURRENT aggregate cohort or
              // retry fan-out can bypass the one-budget invariant entirely.
              const replayedResult = projected.skipResultDoor
                ? storedResult
                : applyResultDoor(storedResult, {
                    toolName,
                    workspaceId: dispatchSpawnCtx.workspaceId,
                    runId: dispatchSpawnCtx.runId ?? null,
                    ownerId: (() => {
                      try {
                        // Signed role sessions read scratch resources as the
                        // HMAC-bound client, not the synthesized role principal.
                        return resolveAgentIdentity(
                          dispatchSpawnCtx.sigVerifiedSpawn &&
                          !dispatchSpawnCtx.authenticatedPrincipal &&
                          !dispatchSpawnCtx.isSuperuser &&
                          !dispatchSpawnCtx.isPowerUser
                            ? dispatchSpawnCtx
                            : baseCtx,
                        ).ownerId;
                      } catch {
                        return null;
                      }
                    })(),
                    aggregateScope,
                    ...(projectionSpec?.pick ? { preservePaths: projectionSpec.pick } : {}),
                  });
              return withMcpDiagnosticWarnings(replayedResult, dispatchSpawnCtx);
            }
          } catch (err) {
            console.warn(
              `[mcp-replay] lookup failed for ${toolName} (key=${idempotencyKey}): ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
        // Legacy first-party tools (defineTool with default
        // requirePrincipal=true) hard-require ctx.principal + ctx.tx
        // in their projected wrapper (see registerLegacyAsProjected
        // in packages/agent-mcp/src/define-tool.ts:198). ANY concrete-
        // workspace call — ?superuser=1 OR a signed role-scoped agent —
        // synthesizes a principal + opens a workspace tx so those tools
        // run (a role-scoped caller is authenticated by its verified
        // signed URL). workspaceId='*' (no workspace chosen) still fails
        // those tools — caller must pass ?workspace=X. (dispatchWithSynthesizedTx
        // below applies dispatchNeedsTx itself.)
        // Generic projected-dispatch → MCP-result mapping (P-031,
        // @papercusp/tooldef-mcp). Same shape/behavior as before: success →
        // { content }, failure → { isError, content:["<code>: <message>"] }.
        // tooldef-mcp returns an SDK-neutral McpToolCallResult; cast it to the
        // mutable shape the MCP SDK's setRequestHandler accepts (same shape the
        // legacy branch below returns) at this host boundary.
        // Written by the raceDeadline callbacks below, read by the persist block
        // after dispatchWithSynthesizedTx resolves.
        //
        // WI-6868 — these are a holder object rather than two plain `let`s ON
        // PURPOSE; do not "simplify" it back. TypeScript's control-flow analysis
        // does not track assignments made inside a nested function, so a
        // `let toolOutcome: Promise<McpCallResult> | null = null` stays narrowed to
        // `null` at the read site and the `&& toolOutcome` guard then narrows it to
        // `never` — which makes `.then` an error, silently types its `result`
        // parameter as `any`, and leaves the `as StoredMcpResult` cast unchecked.
        // A property reference keeps its declared type, so the guard narrows the way
        // the code actually behaves at runtime. (The `never` form typechecked as 2
        // errors that the file's tsc baseline of 3 masked entirely.)
        const raced: {
          /**
           * EI-19301511582594101: the tool's REAL outcome, captured so the replay
           * receipt can be persisted AFTER its transaction commits. Deliberately the
           * execute() promise and never the value dispatchWithSynthesizedTx returns:
           * on a P2-5 deadline those differ, and persisting the raced timeout
           * envelope would make every retry replay the timeout instead of the real
           * outcome.
           */
          toolOutcome: Promise<McpCallResult> | null;
          /**
           * Set when the deadline branch wins the race — the caller has already been
           * answered, so the receipt must be persisted in the BACKGROUND rather than
           * blocking the response on a tool that is still running server-side.
           */
          deadlineFired: boolean;
        } = { toolOutcome: null, deadlineFired: false };
        // P2-5 must cover workspace/principal synthesis as well as the tool
        // handler. Keep one deadline result and one deadline origin for both
        // races so a slow pre-dispatch acquisition cannot start a handler
        // after the caller has already received a timeout.
        const deadlineMs = effectiveMcpDeadlineMs(projected.timeoutSec);
        const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : null;
        const timeoutResult = (): McpCallResult => {
          raced.deadlineFired = true;
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                // EI-21570323060383850 / EI-21570305229276182: ECHO THE KEY. This branch tells the
                // caller to "retry with the same _meta.idempotencyKey" — but the key is injected
                // by the CLIENT on every call (see the `_meta.idempotencyKey` note above), so the
                // agent reading this error has never seen its value and cannot comply. Both items
                // were filed by callers who followed the instruction, found no key anywhere in the
                // envelope, and had to fall back to reconciling fleet assignments by hand — the
                // one outcome the replay contract exists to make unnecessary. An instruction that
                // names a value the reader cannot obtain is worse than none: it reads as a safe
                // path that silently isn't available.
                //
                // EI-21697542694243148: echoing the VALUE was necessary but NOT sufficient — the
                // message still named no DOOR that can send it back, and the reader's default
                // reading of "pass exactly that value" is to put it in the tool's arguments.
                // `_meta` is a TRANSPORT-level field (see `req.params._meta` in agent-mcp's
                // server), while every projected tool's args schema is additionalProperties:false,
                // so that literal compliance is rejected — reproduced verbatim as
                // `invalid_args: Unrecognized key: "_meta"`. `tools:invoke` has no passthrough
                // either (it takes {name,args} only), so for an agent on those doors the replay
                // contract was unreachable. The proxy respects a valid client-supplied key rather
                // than overwriting it (mcp-proxy/proxy.ts prepareForward), so the contract itself
                // works — only the instructions were missing the door. ptool's own client-side
                // `formatToolCallFailure` already names the flag AND warns against the args
                // mistake; these two messages now say the same thing, so whichever surface a
                // caller hits first gives the same actionable path.
                text: idempotencyKey
                  ? `request_timeout: tool "${toolName}" exceeded ${deadlineMs}ms (commit status is UNKNOWN: still running server-side. Before retrying, re-read the current state via the matching *:get/*:list to confirm whether it landed; once it completes, retry with the same _meta.idempotencyKey to replay its result instead of re-executing. This call's key is "${idempotencyKey}" — pass exactly that value; a fresh key re-executes the tool instead of replaying it. HOW to pass it: _meta.idempotencyKey is a TRANSPORT field, NOT an argument of this tool — adding it to the tool's JSON arguments is rejected as \`invalid_args: Unrecognized key: "_meta"\`, and tools:invoke has no passthrough for it. Replay via ptool's transport flag instead: \`apps/operator/scripts/ptool.mjs --idempotency-key ${idempotencyKey} ${toolName} --json '<the same args>'\` (ptool takes tool arguments only via --json/--json-file, never as bare positionals)).`
                  : `request_timeout: tool "${toolName}" exceeded ${deadlineMs}ms (commit status is UNKNOWN: still running server-side — this call had no idempotencyKey, so a blind retry now risks double-applying a mutation that may already have landed. Do NOT retry yet: first re-read the current state via the matching *:get/*:list to confirm whether it landed before deciding your next step. For future calls, supply the key up front via ptool's \`--idempotency-key <key>\` transport flag — NOT as a tool argument, since _meta is transport-level and tool schemas reject unknown args — so a timeout-retry can safely replay instead of re-executing).`,
              },
            ],
          };
        };
        const runDispatch = async (ctx: UnifiedToolContext): Promise<McpCallResult> => {
          // The tool execution as ONE promise, so the P2-5 deadline can return a
          // clean client error WITHOUT cancelling it: it completes server-side and
          // its outcome is still persisted (P-046/EI-68), so a retry with the same
          // idempotencyKey replays the outcome instead of re-running.
          const execute = async (): Promise<McpCallResult> => {
            // P-006 leg C: cap this model-facing result at the resultEach door
            // (spill-to-scratch + pointer). AFTER the delta proxy — a delta
            // result is skipped inside applyResultDoor (its content[0].text is
            // client-parsed JSON), and the proxy's internal full-body state
            // must stay undoored. BEFORE persistence, so a replay serves the
            // same doored bytes the client saw.
            // P-020 / D-041: the caller's projection runs BEFORE the door, so a
            // caller who asked for 20 lines gets 20 lines — not a door-truncated
            // slice of 4,000 plus a spill file to go page. Reduction the caller
            // ASKED for should pre-empt the door's fixed policy, never race it.
            const projectedResult = applyResultProjection(
              await maybeRunWithDeltaProxy({
                sessionKey: replayOwnerKey,
                toolName,
                args: dispatchArgs,
                requestedFormat,
                explicitDelta,
                itemKeyField: projected.delta?.itemKeyField,
                runRaw: async (autoRequestedDelta, overrideDelta = true) => {
                  const deltaCtx = overrideDelta ? { ...ctx, requestedDelta: autoRequestedDelta } : ctx;
                  const materializationCtx = projectionMaterializationContext(
                    deltaCtx,
                    projectionNeedsFullSource,
                    projectionSpec?.pick !== undefined,
                    projectionSpec,
                  );
                  return (await dispatchProjectedToolToMcp(
                    projected,
                    toolName,
                    dispatchArgs,
                    materializationCtx,
                    PROJECTED_DEPS,
                  )) as McpCallResult;
                },
              }),
              projectionSpec,
              { toolName, effect: projected?.effect },
            );
            // P-001 named views: applied AFTER free-form projection (so an
            // explicit `pick` still composes) and BEFORE the door, on the same
            // reasoning — a reduction the caller ASKED for pre-empts the
            // door's fixed policy rather than racing it.
            const viewedResult = namedView ? applyNamedViewToResult(projectedResult, namedView) : projectedResult;
            const doorInput = stripImplicitProjectionFullRequest(viewedResult, projectionNeedsFullSource, ctx);
            // EI-19386201256023240: a tool whose documented/near-exclusive
            // caller is a programmatic client (a shell hook `json.loads`-ing
            // the raw body — e.g. activity:report's hook_bundle fold — see
            // ProjectedTool.skipResultDoor) opts OUT of the door entirely: a
            // door-truncated body plus its prose footer is invalid JSON, so
            // such a caller's parse throws and fails open SILENTLY, dropping
            // the call's payload with no error anywhere.
            // WI-37843: the opt-out now carries its REASON, because a
            // MODEL-FACING tool can also be oversize by design (coord:orient,
            // the session bootstrap). Both skip the door; only the
            // programmatic one must also be spared appended prose (below).
            // A caller projection temporarily promotes an otherwise-unspecified
            // payload tier to full before dispatch. Let the shared door inspect
            // that result even for an exempt tool: a successful reduction fits
            // and passes byte-identically, while a fail-open/miss is bounded
            // instead of exporting the full promoted source.
            const resultDoorSkipReason =
              projectionSpec || namedView
                ? undefined
                : (projected.skipResultDoor ?? nestedResultDoorSkipReason(doorInput));
            const doored = resultDoorSkipReason
              ? doorInput
              : applyResultDoor(doorInput, {
                  toolName,
                  workspaceId: dispatchSpawnCtx.workspaceId,
                  runId: dispatchSpawnCtx.runId ?? null,
                  // P-023: key the per-session door override on the SAME identity
                  // config:doors-set-session stamps (resolveAgentIdentity, never runId).
                  ownerId: (() => {
                    try {
                      // Resource reads synthesize a principal whose slug is
                      // this signed session's client id. Match that identity
                      // when writing the owner-only spill manifest.
                      return resolveAgentIdentity(
                        dispatchSpawnCtx.sigVerifiedSpawn &&
                        !dispatchSpawnCtx.authenticatedPrincipal &&
                        !dispatchSpawnCtx.isSuperuser &&
                        !dispatchSpawnCtx.isPowerUser
                          ? dispatchSpawnCtx
                          : ctx,
                      ).ownerId;
                    } catch {
                      return null;
                    }
                  })(),
                  aggregateScope,
                  ...(projectionSpec?.pick ? { preservePaths: projectionSpec.pick } : {}),
                });
            // EI-19415249247575123: a `not_found` returned while this process is KNOWN to
            // have talked to a DIFFERENT Postgres cluster is a confidently wrong answer —
            // the most expensive shape available here, because an agent that trusts it
            // concludes its plan/work-item was deleted and may re-create it. The
            // store-identity latch already detects the condition and already says the right
            // thing; before this it had two consumers, both DIAGNOSTICS you must already
            // suspect a problem to call. Applied HERE because this is where every
            // model-facing tool result converges, so it covers all ~60 not_found-emitting
            // agent-tools and every future one with a single edit. Hot-path cost in the
            // healthy case is one module-level null check. Suppressing the PROSE keeps a
            // programmatic caller's body parseable (EI-19386201256023240) while still
            // stamping the machine-readable `_meta` marker.
            // WI-37843: gate that on the REASON, not on the mere fact of skipping the
            // door — see mayAnnotateResultText, which owns the rule. `'oversize-by-design'`
            // is a MODEL-FACING exemption: orient's reader is an agent, and "this not_found
            // may be from the WRONG database" is exactly the warning a bootstrap read must
            // not lose. Only `'programmatic-caller'` needs a byte-clean body.
            const result = annotateStoreIdentitySuspectResult(
              stripNestedResultDoorSkip(doored),
              mayAnnotateResultText(resultDoorSkipReason),
            );
            // EI-19389431406847252: the door spills to scratch but the telemetry
            // row for THIS call was already snapshotted+queued inside
            // runDispatchStack's `finally`, which runs BEFORE this point — so the
            // spill path never reaches tool_invocations.output_ref without an
            // explicit backfill. Best-effort, fire-and-forget (never block the
            // client response on it), and unconditional on result.isError — an
            // error result can still have spilled real bytes worth tracking.
            const doorMeta = (result._meta as Record<string, unknown> | undefined)?.resultDoor as
              | {
                  truncated?: boolean;
                  spillUri?: string;
                  // result-door.ts has always emitted this beside spillUri; it was simply not
                  // declared here, so the filesystem path was dropped on the floor. It is the
                  // join key that lets a later capability:read of the spill be correlated back
                  // to the run that produced it (that read records the path in its args_json).
                  spillPath?: string | null;
                  // result-door sets this when the spill could NOT be persisted. It is one of
                  // P-020's HARD rollback triggers: the door truncated the response and then
                  // failed to write the overflow anywhere, so those bytes are simply GONE —
                  // strictly worse than an unread spill, and previously unstamped.
                  spillFailed?: boolean;
                  originalChars?: number;
                  originalBytes?: number;
                  reason?: string;
                  aggregate?: { exceeded?: boolean };
                }
              | undefined;
            if (doorMeta?.truncated && (doorMeta.spillUri || isPreferredDoor(toolName))) {
              const originalBytes = doorMeta.originalBytes ?? doorMeta.originalChars ?? 0;
              void backfillResultDoorOutputRef({
                workspaceId: dispatchSpawnCtx.workspaceId,
                spawnId: dispatchSpawnCtx.spawnId,
                toolName,
                runId: dispatchSpawnCtx.runId ?? null,
                outputRef: doorMeta.spillUri ?? null,
                outputSize: doorMeta.spillUri ? originalBytes : null,
                // WI-40720 gap 3: this branch was `toolName === 'code:run'`, so a recipes:run or
                // orchestrate:run call could spill real bytes and record NO telemetry for them —
                // the rollout gates then graded a default-on orchestration suite on code:run
                // traffic alone. Widened to every preferred door via the one shared predicate.
                ...(isPreferredDoor(toolName)
                  ? {
                      metadataJson: {
                        returnedContextBytes: measureResultContextBytes(result),
                        spilledBytes: doorMeta.spillUri ? originalBytes : 0,
                        // BOTH spill addresses, because a later capability:read may name
                        // either one — the scratch FILE path (args_json.file_path) or the
                        // papercusp:// URI (args_json.uri). Stamping both is what makes
                        // spill-resolution measurable; matching only one shape under-counts
                        // reads that really happened.
                        //
                        // spillUri is duplicated here even though it is already the row's
                        // output_ref column, deliberately: the instrumentation rollup is
                        // contractually METADATA-ONLY and its guard test forbids the query
                        // from touching output_ref/content/result_text. Carrying the URI in
                        // metadata_json lets the correlation read it without breaching that.
                        ...(doorMeta.spillPath ? { spillPath: doorMeta.spillPath } : {}),
                        ...(doorMeta.spillUri ? { spillUri: doorMeta.spillUri } : {}),
                        // Stamped ALWAYS, not only when true: a hard trigger that is absent
                        // on the healthy path is indistinguishable from one never measured,
                        // which is how a rollback trigger silently reads as "no breaches".
                        spillFailed: doorMeta.spillFailed === true,
                        resultDoorReason: doorMeta.reason ?? 'per-result-budget-exceeded',
                        aggregateOutputEscape:
                          doorMeta.reason === 'aggregate-output-budget-exceeded' ||
                          doorMeta.aggregate?.exceeded === true,
                      },
                    }
                  : {}),
              }).catch((err) => {
                console.warn(
                  `[mcp-handler] backfillResultDoorOutputRef failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
            // EI-19301511582594101: the replay receipt is NOT persisted here.
            // It used to be, and that inverted the write order: `storeMcpResult`
            // commits on its OWN connection (getOrgPg()), while a needsTx tool's
            // writes are still UNCOMMITTED inside the `withWorkspace` transaction
            // that wraps this whole handler — so the success receipt became durable
            // BEFORE the work it attests to. If that final COMMIT then failed, a
            // `created:true` + real-id envelope outlived a row that never landed and
            // replayed for its full TTL. The store now happens after
            // dispatchWithSynthesizedTx resolves (tx committed), still before the
            // response is returned — see persistReplayReceipt below.
            // code-run batch nudge (code-run-token-frugality, owner directive 2026-06-23):
            // catch the eager same-tool-N× pattern at the decision point + steer the caller to
            // bundle the calls into one code:run. In-process, one-shot per (session, tool),
            // success-path only, code:run-capable callers only. The Map bump runs on every call
            // (cheap); getFlag is consulted ONLY when a hint actually fires (rare), so the hot
            // path stays a single in-memory increment. Best-effort — never affect the tool result.
            // Attached AFTER idempotent persistence so a replay serves the raw stored result.
            if (!result.isError) {
              // A delta-protocol result (`result._meta.delta` set — e.g. a delta-proxy
              // RECONSTRUCTED full body, mcp-handler-gating-matrix delta-proxy:845) carries a
              // single structured JSON payload in content[0].text that the client JSON.parses;
              // appending an advisory `[batch-hint]`/`[nudge]` text item corrupts that parse.
              // Only attach the advisory nudges to PLAIN-TEXT results.
              const canAttachAdvisory = (result._meta as Record<string, unknown> | undefined)?.delta == null;
              // SURFACE-AWARE (code-run-self-state-adoption-2026-07-03 P-004): a role-membership
              // check alone was dishonest — envelope-denied roles (overwatch/sentinel) and seeded
              // sessions whose surface lacked code:run were nudged, escalating banners included,
              // toward a tool they could not call. canRoleActOnCodeRun folds in the envelope deny;
              // codeRunInSurface switches the hint to the activate-first path (tools:find /
              // tools:invoke) when the live surface lacks the tool. Computed ONCE here — the
              // reactive nudge and the predictive hint (EI-10894) both need exactly this.
              const nudgeSurface = getSessionSurface(
                dispatchSpawnCtx.uiClientId ?? null,
                parseToolsAllowlist(urlFromExtra(extra)?.searchParams.get('tools')),
              );
              const canCodeRunHere =
                dispatchSpawnCtx.isSuperuser === true || canRoleActOnCodeRun(dispatchSpawnCtx.role);
              const codeRunInSurface = !nudgeSurface || nudgeSurface.has('code:run');
              try {
                const hint = maybeBatchNudge({
                  sessionKey: nudgeSessionKey,
                  toolName,
                  // P-001/P-003 (code-run-batch-adoption): args unwrap tools:invoke-routed calls
                  // to their inner tool and prefill the skeletons with the burst's real args.
                  args,
                  canCodeRun: canCodeRunHere,
                  codeRunInSurface,
                  // clusterTurns models inference turns from DISPATCH proximity.
                  // Completion time is duration-skewed, so parallel heterogeneous
                  // calls would otherwise look like several sequential turns.
                  now: callStartedAt,
                  // EI-21254965187146713: what the call actually COST. The nudge uses it to
                  // refuse to recommend a fold the code:run script budget would kill — the
                  // failure that made an agent pay for the sequential calls it discouraged,
                  // a timed-out script, AND the re-run.
                  durationMs: Date.now() - callStartedAt,
                });
                // Gate PER KIND: the same-tool trigger under CODE_RUN_BATCH_NUDGE; fan-out AND
                // pipeline (the chained variant of the same multi-tool trigger) under
                // CODE_RUN_FANOUT_NUDGE so the multi-tool family is one independent A/B knob —
                // telemetry records the kind verbatim, keeping pipeline vs fanout measurable.
                // getFlag is consulted ONLY when a hint actually fires (rare).
                if (hint && canAttachAdvisory) {
                  const nudgeFlag =
                    hint.kind === 'same-tool' ? FLAGS.CODE_RUN_BATCH_NUDGE : FLAGS.CODE_RUN_FANOUT_NUDGE;
                  if (await getFlag(nudgeFlag, 'system')) {
                    result.content = [
                      ...result.content,
                      { type: 'text' as const, text: `\n[batch-hint] ${hint.text}` },
                    ];
                    // P-005: record the fire (best-effort, fire-and-forget) so nudge→conversion
                    // is finally measurable — the A/B flags existed but fires were invisible.
                    // hint.tool = the EFFECTIVE tool (the inner verb for tools:invoke-routed
                    // calls), so fires attribute to the real verb, not the wrapper.
                    recordBatchNudgeFire({
                      sessionKey: nudgeSessionKey,
                      role: dispatchSpawnCtx.role,
                      kind: hint.kind,
                      toolName: hint.tool,
                      workspaceId: dispatchSpawnCtx.workspaceId,
                    });
                  }
                }
              } catch {
                // nudge is purely advisory; a failure must never change the tool outcome.
              }
              // shape-hint (EI-10892): the `ok:true`-but-every-field-blank result — the
              // DOMINANT waste mode, and the one nothing else measures. A code:run script
              // that maps the wrong response keys returns perfectly-formed rows with every
              // field empty; it looks like a true negative, so the agent burns further calls
              // (and an extra call just to JSON.stringify a raw result and learn the shape).
              // The efficiency panel cannot see any of it — it grades hard failures only.
              // Scoped to code:run because that is the one place an AGENT'S OWN field mapping
              // is applied; and deliberately conservative (rows must EXIST and be almost all
              // fully-blank), because falsely accusing a genuine empty result would teach
              // agents to distrust true negatives. Advisory: never changes the outcome.
              if (toolName === 'code:run' && canAttachAdvisory) {
                try {
                  const first = result.content?.[0] as { type?: string; text?: string } | undefined;
                  if (first?.type === 'text' && typeof first.text === 'string') {
                    const parsed: unknown = JSON.parse(first.text);
                    const body =
                      parsed && typeof parsed === 'object' && 'summary' in (parsed as Record<string, unknown>)
                        ? (parsed as Record<string, unknown>).summary
                        : parsed;
                    const shapeHint = maybeEmptyMappingHint(body, []);
                    if (shapeHint) {
                      result.content = [
                        ...result.content,
                        { type: 'text' as const, text: `\n[shape-hint] ${shapeHint.text}` },
                      ];
                    }
                  }
                } catch {
                  // Non-JSON body, or any parse failure — nothing to judge. Advisory only.
                }
              }
              // PREDICTIVE fan-out hint (EI-10894): the batch nudges above are all REACTIVE —
              // they key on MODEL turns already spent (not raw same-turn RPCs), so the waste is billed and only
              // then explained. A list verb that just returned >5 addressable rows IS the
              // fan-out, one call BEFORE it happens, so attach the code:run skeleton to THAT
              // result — ids already extracted — while batching still costs the agent nothing.
              // The payload is passed as a THUNK: the module runs its cheap gates (already
              // batching / not list-shaped / one-shot / capped) first and returns before the
              // JSON.parse for the overwhelming majority of calls, so the hot path pays a
              // couple of set lookups, not a parse of every tool result.
              try {
                const preempt = maybeListFanoutPreempt({
                  sessionKey: nudgeSessionKey,
                  toolName,
                  args,
                  canCodeRun: canCodeRunHere,
                  codeRunInSurface,
                  payload: () => {
                    const first = result.content?.[0] as { type?: string; text?: string } | undefined;
                    if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
                    return JSON.parse(first.text) as unknown;
                  },
                });
                if (preempt && canAttachAdvisory && (await getFlag(FLAGS.CODE_RUN_FANOUT_PREEMPT, 'system'))) {
                  result.content = [
                    ...result.content,
                    { type: 'text' as const, text: `\n[batch-hint] ${preempt.text}` },
                  ];
                  // Same fires table as the reactive kinds (kind='preempt') — so "did the
                  // PREDICTIVE hint convert better than the reactive ones?" is the existing
                  // conversion join with one more GROUP BY, not a new pipeline.
                  recordBatchNudgeFire({
                    sessionKey: nudgeSessionKey,
                    role: dispatchSpawnCtx.role,
                    kind: preempt.kind,
                    toolName: preempt.tool,
                    workspaceId: dispatchSpawnCtx.workspaceId,
                  });
                }
              } catch {
                // advisory only; a failure must never change the tool outcome.
              }
              // orient-dedup nudge (agent-tooling-token-efficiency P-009): catch a
              // coord:plan-events / coord:inbox / memory:search / coord:declare-intent fired right
              // after a SUCCESSFUL coord:orient — orient already returned (+ declared) exactly that
              // — and steer the caller back at orient's payload. Same in-process per-session map,
              // same injection point as the batch hint. Recording the orient timestamp is the only
              // common-path side effect; getFlag is consulted ONLY when a nudge actually fires (rare),
              // so it runs even with the flag OFF and flipping it takes effect immediately. Role-
              // agnostic (every agent uses orient). Best-effort — never affect the tool result.
              try {
                const orientHint = maybeOrientDedupNudge({
                  sessionKey: nudgeSessionKey,
                  toolName,
                });
                if (orientHint && canAttachAdvisory && (await getFlag(FLAGS.ORIENT_DEDUP_NUDGE, 'system'))) {
                  result.content = [...result.content, { type: 'text' as const, text: `\n[nudge] ${orientHint}` }];
                }
              } catch {
                // advisory only; a failure must never change the tool outcome.
              }
              // state-plane nudges (state-plane-adoption-2026-08-02 P-008): steer the agent
              // to state:read before it QUOTES a pipeline value into a durable write, and to
              // state:subscribe instead of polling a door. Same per-session map, same
              // injection point, same never-throw contract as the nudges above. Recording the
              // door/plane call is the only common-path side effect; getFlag is consulted ONLY
              // when a nudge actually fires (rare), so flipping the flag takes effect
              // immediately. Role-agnostic. Best-effort — never affect the tool result.
              try {
                const planeHint = maybeStatePlaneNudge({
                  sessionKey: nudgeSessionKey,
                  toolName,
                });
                if (planeHint && canAttachAdvisory && (await getFlag(FLAGS.STATE_PLANE_NUDGE, 'system'))) {
                  result.content = [...result.content, { type: 'text' as const, text: `\n[nudge] ${planeHint}` }];
                }
              } catch {
                // advisory only; a failure must never change the tool outcome.
              }
            }
            return result;
          };
          // P2-5 deadline: a tool exceeding its effective deadline returns a clean
          // error to the client (no silent tunnel drop); it keeps running + persists
          // for an idempotent retry to replay. EI-17177: the flat MCP_DEADLINE_MS
          // (55s) must NOT cut off a tool that legitimately declares a longer
          // `timeoutSec` (e.g. chat:ask_choice / other human-interaction tools at
          // 600s) — effectiveMcpDeadlineMs honors the tool's own budget instead.
          return raceDeadline<McpCallResult>(
            deadlineMs,
            () => {
              const outcome = execute();
              raced.toolOutcome = outcome;
              return outcome;
            },
            timeoutResult,
          );
        };
        // Establish the request-scoped workspace ALS for the duration of the
        // tool call (P-022) so handlers that resolve via `activeWorkspaceId()`
        // — harness resolution, not just the PG GUC `withWorkspace` sets — see
        // the CALLER's workspace, not the process-global `reg.current`. '*'
        // (superuser with no chosen workspace) stays unpinned.
        // Bind the tx/principal the target needs (crossWorkspace → admin handle;
        // needsTx → workspace tx) + run — the SAME helper the tools:invoke
        // re-dispatch path (dispatchTool) uses, so the two can never drift
        // (EI-6982). See dispatchWithSynthesizedTx for the P-062 crossWorkspace
        // rationale (admin handle, checked before needsTx, covers the '*'
        // discovery case).
        // Principal synthesis and workspace acquisition happen outside
        // runDispatchStack. If either fails, the generic dispatcher never
        // initializes its telemetry execution state, so preserve one row for
        // the pre-dispatch failure without duplicating rows after dispatch
        // has started.
        let dispatchStarted = false;
        const dispatchPreflight = async (): Promise<McpCallResult> => {
          try {
            return await dispatchWithSynthesizedTx(projected, dispatchSpawnCtx, baseCtx, async (ctx) => {
              // The outer race may have answered while acquisition or
              // principal synthesis was still in flight. Do not enter the
              // handler after that point; only a dispatch that had already
              // started is allowed to continue server-side after timeout.
              if (raced.deadlineFired || (deadlineAt !== null && Date.now() >= deadlineAt)) {
                raced.deadlineFired = true;
                throw new Error(`MCP dispatch deadline expired before tool "${toolName}" started`);
              }
              dispatchStarted = true;
              return runDispatch(ctx);
            });
          } catch (error) {
            if (!dispatchStarted) {
              try {
                const roleQuota = baseCtx.role ? projected.rolesQuota?.[baseCtx.role] : undefined;
                await PROJECTED_DEPS.recordInvocation?.({
                  toolName,
                  pluginName: projected.pluginName,
                  ctx: baseCtx,
                  windowKey: PROJECTED_DEPS.computeQuotaWindow?.(baseCtx, roleQuota, toolName).key ?? '',
                  durationMs: Date.now() - callStartedAt,
                  status: 'error',
                  errorMessage: error instanceof Error ? error.message : String(error),
                  args: dispatchArgs,
                });
              } catch (telemetryError) {
                console.warn(
                  `[mcp-handler] pre-dispatch telemetry failed for ${toolName}: ` +
                    (telemetryError instanceof Error ? telemetryError.message : String(telemetryError)),
                );
              }
            }
            throw error;
          }
        };
        const dispatched = await raceDeadline<McpCallResult>(deadlineMs, dispatchPreflight, timeoutResult);
        // EI-19301511582594101: persist the replay receipt HERE — after
        // dispatchWithSynthesizedTx has resolved, which is after the tool's
        // `withWorkspace` transaction has COMMITTED, and still before this result is
        // returned to the transport. That ordering is the whole fix: a receipt can no
        // longer be durable for a write that never committed.
        // Always keyed off `raced.toolOutcome` (the tool's real result), never `dispatched`
        // — on a deadline those differ, and storing the timeout envelope would make
        // every subsequent retry replay the timeout forever.
        if (idempotencyKey && !skipReplayForReadOnly && raced.toolOutcome) {
          const persist = raced.toolOutcome
            .then((result) => {
              // A projected-dispatch validation refusal means the handler never
              // ran. Do not burn the caller's key on that transient payload
              // mistake: a corrected request with the same key must validate and
              // execute. Handler-returned `isError` results remain ordinary
              // outcomes and are intentionally replayable.
              if (isDispatchValidationFailure(result)) return;
              return storeMcpResult({
                ownerKey: replayOwnerKey,
                idempotencyKey,
                toolName,
                workspaceId: dispatchSpawnCtx.workspaceId,
                result: result as StoredMcpResult,
              });
            })
            .catch((err: unknown) => {
              // Best-effort by contract: a store outage (or a tool that rejected, in
              // which case there is no outcome worth replaying) degrades to normal
              // execution, never an error to the caller.
              console.warn(
                `[mcp-replay] store failed for ${toolName} (key=${idempotencyKey}): ` +
                  (err instanceof Error ? err.message : String(err)),
              );
            });
          // Normal path: the tool has already settled, so this resolves immediately
          // and the receipt is durable before we answer. Deadline path: the caller
          // was answered already — let it persist in the background rather than
          // re-blocking the response we just raced to send.
          if (!raced.deadlineFired) await persist;
        }
        return withMcpDiagnosticWarnings(dispatched, dispatchSpawnCtx);
      }

      // Legacy bearer-only fallback (no spawn ctx supplied).
      const builtin = getCatalog().find((t) => t.name === toolName);
      if (builtin) {
        const bearer = bearerFromExtra(extra);
        const r = await dispatchLegacyWithDeadline({ toolName, args, bearer });
        if (!r.ok) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${r.error?.code}: ${r.error?.message}` }],
          };
        }
        // Format-aware serialization (P-005) — parity with the projected path.
        // This bearer-only legacy branch is still an MCP (agent) transport, so
        // it defaults to compact; honor `_meta.format`/`?format=` overrides.
        const resp = r.response!;
        if ('content' in resp) return resp;
        const serialized = serializeToolResponse(
          resp,
          formatOptsFromCtx({ requestedFormat, transport: 'mcp' }, lookupByMcpName(toolName)?.resultEligibility),
        );
        return {
          content: serialized.content,
          ...(Object.keys(serialized._meta).length > 0 ? { _meta: serialized._meta } : {}),
          ...(serialized.structuredContent !== undefined ? { structuredContent: serialized.structuredContent } : {}),
        };
      }

      // Projected tool exists but caller didn't supply a spawn ctx —
      // tell them what's missing instead of falling through to 'unknown'.
      if (projected && spawnRes.kind === 'none') {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'invalid_request_context: projected tool calls require harness/workspace/role/run/spawn URL query params, or ?superuser=1 + bearer',
            },
          ],
        };
      }

      // EI-9011 (generalized): moment-of-failure referral — closest catalog matches +
      // the tools:find/tools:invoke routing hint (see unknown-tool-referral.ts).
      return {
        isError: true,
        content: [{ type: 'text' as const, text: unknownToolReferral(toolName) }],
      };
    },
    MCP_FUZZY_DEPS,
    ),
  );

  // ── Resources ────────────────────────────────────────────────────
  /**
   * Resource requests share the MCP connection's transport authentication.
   * The superuser bearer is a file-backed break-glass credential, not an
   * agent-mcp token_index principal, so forwarding it to listResources/readResource
   * would make every scratch spill fail with invalid_bearer. Reuse the
   * already-validated spawn context and hand off its narrow resource principal;
   * ordinary bearer-only callers retain the legacy resolution path.
   */
  const synthesizeScratchResourcePrincipal = (ctx: BuiltSpawnContext): Principal | null => {
    if (ctx.authenticatedPrincipal) return ctx.authenticatedPrincipal;
    if (!ctx.workspaceId || ctx.workspaceId === '*') return null;

    let ownerId: string;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      return null;
    }

    if (ctx.isPowerUser) {
      return {
        kind: 'system',
        slug: ownerId,
        workspaceId: ctx.workspaceId,
        authMethod: 'bearer-token',
        trust: 'trusted',
        capabilities: new Set(),
      };
    }
    if (ctx.sigVerifiedSpawn === true) {
      return {
        kind: 'harness',
        slug: ownerId,
        workspaceId: ctx.workspaceId,
        authMethod: 'spawn-url',
        trust: 'trusted',
        capabilities: new Set(),
      };
    }
    return null;
  };

  const resourceAuthFromExtra = async (
    extra: unknown,
    resourceUri?: string,
  ): Promise<{ bearer: string } | { principal: Principal }> => {
    const url = urlFromExtra(extra);
    const usesTransportPrincipal =
      url?.searchParams.get('superuser') === '1' || url?.searchParams.get('principal') === 'pi';
    const usesScopedScratchPrincipal =
      resourceUri?.startsWith(`${SCRATCH_SCHEME}/`) === true &&
      (url?.searchParams.get('power_user') === '1' || url?.searchParams.has('role') === true);
    if (!usesTransportPrincipal && !usesScopedScratchPrincipal) return { bearer: bearerFromExtra(extra) };

    const spawnRes = await tryBuildSpawnContext(extra);
    if (spawnRes.kind === 'failed') {
      throw new Error(`mcp_auth_failed: ${spawnRes.reason}`);
    }
    if (spawnRes.kind === 'ok') {
      const principal = usesTransportPrincipal
        ? synthesizeResourcePrincipal(spawnRes.ctx)
        : synthesizeScratchResourcePrincipal(spawnRes.ctx);
      if (principal) return { principal };
    }
    if (usesScopedScratchPrincipal) {
      throw new Error('mcp_auth_failed: scratch_resource_requires_verified_identity');
    }
    return { bearer: bearerFromExtra(extra) };
  };

  server.server.setRequestHandler(sdk.ListResourcesRequestSchema, async (_req: unknown, extra: unknown) => {
    const r = await listResources(await resourceAuthFromExtra(extra));
    return { resources: r.ok ? (r.resources ?? []) : [] };
  });
  server.server.setRequestHandler(
    sdk.ReadResourceRequestSchema,
    async (req: { params: { uri: string } }, extra: unknown) => {
      const auth = await resourceAuthFromExtra(extra, req.params.uri);
      const r = await readResource({ uri: req.params.uri, ...auth });
      if (!r.ok) throw new Error(`${r.error?.code}: ${r.error?.message}`);
      return { contents: [r.contents!] };
    },
  );

  // ── Prompts ─────────────────────────────────────────────────────
  // Two prompt sources share prompts/list + prompts/get:
  //   1. STATIC definePrompt prompts (agent:role, …) — bearer-gated via
  //      listPrompts/getPrompt, unchanged.
  //   2. DYNAMIC slash projection (slash-exposure-tool-catalog-2026-06-12):
  //      every tool this session can see (the exact tools/list walk)
  //      surfaces as a `tool:*` prompt so agent clients render the whole
  //      catalog as slash commands. Flag-gated (SLASH_EXPOSURE, default ON).
  server.server.setRequestHandler(sdk.ListPromptsRequestSchema, async (_req: unknown, extra: unknown) => {
    await ensureOperatorToolsLoaded();
    const bearer = bearerFromExtra(extra);
    const prompts: Array<{
      name: string;
      description?: string;
      arguments?: unknown;
    }> = [];
    const publicStatic = () =>
      getPromptCatalog()
        .filter((p) => !p.capability)
        .map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
    if (!bearer) {
      prompts.push(...publicStatic());
    } else {
      const { listPrompts } = await import('@papercusp/agent-mcp');
      const r = await listPrompts(bearer);
      if (r.ok && r.prompts) {
        prompts.push(...r.prompts);
      } else {
        // The bearer didn't resolve to a principal — true of the
        // ?superuser=1 token, which is not a bearer-principal (see
        // superuser-mode docs). The pre-slash behavior returned NOTHING
        // here; serve the public (capability-less) static set instead so
        // superuser sessions keep agent:role etc.
        prompts.push(...publicStatic());
      }
    }
    if (await getFlag(FLAGS.SLASH_EXPOSURE, 'system')) {
      const vis = await resolveVisibleToolListings(extra);
      if (vis.kind !== 'failed') {
        prompts.push(...dynamicSlashListings(vis.listings));
      }
    }
    return { prompts };
  });
  server.server.setRequestHandler(
    sdk.GetPromptRequestSchema,
    async (req: { params: { name: string; arguments?: Record<string, string> } }, extra: unknown) => {
      await ensureOperatorToolsLoaded();
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, string>;
      if (isSlashPromptName(name)) {
        if (!(await getFlag(FLAGS.SLASH_EXPOSURE, 'system'))) {
          throw new Error('slash_exposure_disabled: the papercusp-slash-exposure flag is off');
        }
        return await getSlashPrompt(name, args, extra);
      }
      const bearer = bearerFromExtra(extra);
      const r = await getPrompt({ name, args, bearer });
      if (!r.ok) throw new Error(`${r.error?.code}: ${r.error?.message}`);
      return { description: r.result!.description, messages: r.result!.messages };
    },
  );

  // ── Initialize enrichment (memory-delivery-unification-2026-07-12 P-001) ──
  // Per-session `initialize.instructions`: delegate to the SDK's own stored
  // initialize handler (negotiation + client-info side effects stay
  // SDK-owned), then append the session-start memory prelude — user +
  // harness mem0 recall (harness-identity query per D-005) + the
  // agent-insights index. Auth-gated: a failed OR bare (`kind:'none'`)
  // spawn context gets the static text only — memories must never leak to
  // an unauthenticated probe. Deadline-bounded + never-throws: a slow or
  // broken memory backend can never stall or break session establishment.
  const sdkInitialize = takeStoredInitializeHandler(server.server);
  if (sdkInitialize) {
    // The wrapper is (req: unknown, extra: unknown) => Promise<unknown> —
    // deliberately SDK-shape-agnostic (it delegates to and returns the SDK's
    // OWN stored handler result, so the runtime shape is exactly what the
    // SDK produced; pinned against the real SDK in
    // __tests__/mcp-initialize-enrich.test.ts). The cast below only
    // re-admits the result type the wrapper's `unknown` erased.
    type StoredInitializeHandler = Parameters<typeof server.server.setRequestHandler>[1];
    server.server.setRequestHandler(
      sdk.InitializeRequestSchema,
      wrapInitializeWithInstructions(sdkInitialize, async (base, extra, timing) => {
        const traceId = mcpTraceIdFromExtra(extra) ?? globalThis.crypto.randomUUID();
        const stages = {
          sdkMs: timing.sdkMs,
          spawnContextMs: null as number | null,
          userLookupMs: null as number | null,
          preludeMs: null as number | null,
          enrichmentMs: 0,
          totalMs: 0,
        };
        const enrichmentStartedAt = Date.now();
        let outcome: InitializeStageOutcome = 'base';
        let timedOut = false;
        try {
          const enriched = await raceDeadline(
            INITIALIZE_ENRICH_DEADLINE_MS,
            async () => {
              const spawnStartedAt = Date.now();
              const spawnRes = await tryBuildSpawnContext(extra).finally(() => {
                stages.spawnContextMs = Date.now() - spawnStartedAt;
              });
              if (spawnRes.kind !== 'ok') return null;

              const userStartedAt = Date.now();
              const user = await getSessionUserOrDefault().finally(() => {
                stages.userLookupMs = Date.now() - userStartedAt;
              });
              const ctxWorkspace = spawnRes.ctx.workspaceId;
              const ctxHarness = spawnRes.ctx.harnessSlug;
              const preludeStartedAt = Date.now();
              const prelude = await buildMcpPrelude({
                userId: user.id,
                workspaceId: ctxWorkspace && ctxWorkspace !== '*' ? ctxWorkspace : activeWorkspaceId(),
                url: urlFromExtra(extra),
                // WI-4393: ctx.harnessSlug already resolved header (OMP)-vs-URL-param
                // (claude/codex) precedence in tryBuildSpawnContext — pass it explicitly
                // rather than making buildMcpPrelude re-parse `?harness=` alone, which
                // OMP's static per-launch URL never carries.
                harnessSlug: ctxHarness && ctxHarness !== '*' ? ctxHarness : null,
                insightsDir: INSIGHTS_DIR,
                // P-002 epoch dedup identity: the per-launch SID (uiClientId),
                // so initialize stamps the same ledger the turn-start/claim
                // ports will dedup against.
                ...(spawnRes.ctx.uiClientId ? { sessionId: spawnRes.ctx.uiClientId } : {}),
              }).finally(() => {
                stages.preludeMs = Date.now() - preludeStartedAt;
              });
              if (!prelude?.text) return null;
              return base ? `${base}\n\n${prelude.text}` : prelude.text;
            },
            () => {
              timedOut = true;
              return null;
            },
          );
          outcome = timedOut ? 'timeout' : enriched ? 'enriched' : 'base';
          return enriched;
        } catch (error) {
          outcome = 'error';
          throw error;
        } finally {
          stages.enrichmentMs = Date.now() - enrichmentStartedAt;
          stages.totalMs = Date.now() - timing.startedAtMs;
          const telemetry = buildInitializeStageTelemetry({
            traceId,
            pid: process.pid,
            outcome,
            slowMs: INITIALIZE_STAGE_SLOW_MS,
            stages,
          });
          if (telemetry) console.warn('[mcp-initialize-stage]', telemetry);
        }
      }, (req) => !isNativeInstructionBudgetClient(req)) as StoredInitializeHandler,
    );
  }

  void getResourceCatalog;
}

// P2-5 (operator-scalability-event-loop-2026-06-16): a server-side tool-call deadline.
// A tool exceeding this returns a CLEAN JSON-RPC error to the client instead of
// hanging to maxDuration / a silent tunnel drop. Set UNDER maxDuration (60s). 0
// disables. Env-tunable (PAPERCUSP_MCP_DEADLINE_MS).
const MCP_DEADLINE_MS = Number(process.env.PAPERCUSP_MCP_DEADLINE_MS) || 55_000;

// EI-17177: some tools (chat:ask_choice, operator/architect/oracle/agent_chats
// converse, sentinel-converse — every human-interaction tool) DECLARE a
// `timeoutSec` far past MCP_DEADLINE_MS (600s) because they legitimately block
// on a human's reply, not a hang. A margin added past the tool's own declared
// budget so ITS OWN dispatch-stack AbortController timeout (a clearer,
// tool-scoped "exceeded timeout of Xs" error) fires first in the normal
// exceeded-budget case; P2-5 stays the backstop for a tool that ignores its
// own abort signal and keeps running anyway.
const MCP_DEADLINE_TOOL_BUFFER_MS = 5_000;

/**
 * The actual deadline P2-5 races a tool call against: the greater of the flat
 * MCP_DEADLINE_MS floor and the tool's own declared `timeoutSec` (+ a buffer).
 * A tool that declares no timeoutSec (or one under the floor) keeps today's
 * flat 55s behavior unchanged; `baseDeadlineMs <= 0` (P2-5 disabled) always
 * stays disabled regardless of the tool's timeoutSec. Exported for unit tests.
 */
export function effectiveMcpDeadlineMs(
  toolTimeoutSec: number | null | undefined,
  baseDeadlineMs: number = MCP_DEADLINE_MS,
): number {
  if (!(baseDeadlineMs > 0)) return baseDeadlineMs;
  if (!toolTimeoutSec || !(toolTimeoutSec > 0)) return baseDeadlineMs;
  return Math.max(baseDeadlineMs, toolTimeoutSec * 1000 + MCP_DEADLINE_TOOL_BUFFER_MS);
}

/**
 * Race a tool dispatch against a deadline (P2-5). On expiry, resolve to `onTimeout()`
 * — a clean error result — so the client gets a definitive response, not a silent
 * drop. The `run()` promise is deliberately NOT cancelled: the tool finishes
 * server-side and (via runDispatch) persists its result, so a retry with the same
 * `_meta.idempotencyKey` replays the completed outcome rather than re-executing or
 * leaving a half-applied mutating write. `deadlineMs<=0` ⇒ no race (await run).
 */
export async function raceDeadline<T>(deadlineMs: number, run: () => Promise<T>, onTimeout: () => T): Promise<T> {
  const p = run();
  if (!(deadlineMs > 0)) return p;
  // Once the race settles on the timeout branch, the orphaned tool promise is still
  // in flight; its eventual rejection must not surface as an unhandledRejection.
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * WI-4760: the "legacy bearer-only fallback" branch (a builtin catalog tool
 * called with a bare bearer + no spawn ctx — e.g. an external MCP client like
 * Codex hitting the endpoint with just an Authorization header) used to
 * `await dispatch(...)` completely UNBOUNDED, unlike the projected path above
 * (P2-5) which already races every call against `effectiveMcpDeadlineMs`. A
 * wedged nested call inside ANY builtin tool's handler (a hung DB query, a
 * stuck subprocess, a blocked fetch) held the whole MCP request — and the
 * calling agent's turn — open indefinitely while the rest of the operator
 * stayed fully responsive (confirmed 2026-07-13: direct systemd +
 * checkpoint-log reads returned <1s during an >80s hang on exactly this
 * path). This races the same call against the same effective deadline the
 * projected path uses, so a hang here surfaces as a clean, attributed
 * timeout instead of a silent multi-minute stall — and logs enough to find
 * the wedged handler instead of just returning a generic error.
 *
 * Legacy (principal-gated) `ToolDefinition`s have no per-tool `timeoutSec`
 * (that field only exists on the newer `RoleToolDefinition`/`ProjectedTool`
 * shape used by the projected path), so this always falls back to the flat
 * `baseDeadlineMs` floor — same behavior as a projected tool that declares
 * nothing. `baseDeadlineMs` defaults to the module's `MCP_DEADLINE_MS` but is
 * injectable so the timeout branch is unit-testable without waiting out the
 * real flat deadline.
 */
export async function dispatchLegacyWithDeadline(
  opts: Parameters<typeof dispatch>[0],
  baseDeadlineMs: number = MCP_DEADLINE_MS,
): Promise<Awaited<ReturnType<typeof dispatch>>> {
  const deadlineMs = effectiveMcpDeadlineMs(null, baseDeadlineMs);
  return raceDeadline(
    deadlineMs,
    () => dispatch(opts),
    () => {
      // Attribution/telemetry: the legacy path has no idempotent replay
      // store (unlike the projected path), so log enough to find + fix the
      // wedge instead of promising a safe retry.
      console.warn(
        `[mcp-legacy-deadline] tool "${opts.toolName}" exceeded ${deadlineMs}ms on the legacy ` +
          `bearer-only dispatch path (no spawn ctx) — still running server-side; it is NOT ` +
          `cancelled and has no idempotent replay here, so investigate the handler for a missing ` +
          `timeout/abort on its own I/O (DB query, subprocess, fetch).`,
      );
      return {
        ok: false,
        error: {
          code: 'request_timeout',
          message:
            `tool "${opts.toolName}" exceeded ${deadlineMs}ms on the legacy dispatch path ` +
            `(commit status is UNKNOWN: still running server-side, not cancelled; this path has no idempotency-key replay, ` +
            `so re-check current state via the matching *:get/*:list before deciding whether to retry).`,
        },
      };
    },
  );
}
