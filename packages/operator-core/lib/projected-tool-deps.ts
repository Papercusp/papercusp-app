/**
 * Shared DispatchProjectedDeps for the @papercusp/agent-mcp dispatcher.
 *
 * Both transports (HTTP via app/api/[transport]/route.ts AND IPC via
 * lib/endpoint-ipc/server.ts) need to plumb invocations into
 * harness_shared.tool_invocations for audit + quota lookup. This lives
 * here so adding a third transport doesn't fork the SQL.
 *
 * The IPC transport landed initially with deps:{} — no telemetry rows
 * landed for IPC calls and they were invisible to /dev → Sessions.
 * Wiring this shared deps closes deferred item 4 from the audit.
 *
 * Note: pending submodule migration to add a `transport` column on
 * tool_invocations, IPC calls cannot be distinguished from HTTP calls
 * at the SQL level. Telemetry consumers should infer transport from
 * spawn_id prefix (`ipc-` for IPC, none for HTTP/MCP) until the
 * column lands.
 */

import { generated, getOrgPg } from '@papercusp/db-org';
import { mergeRoleQuota } from './quota-overrides';
import {
  PASS_THROUGH,
  papercuspComputeQuotaWindow,
  sameKernelRevision,
  wrapKernelSpawn,
  type CapabilityEnvelopeVerdict,
  type DispatchProjectedDeps,
  type KernelContextState,
  type KernelEnforcementPort,
  type KernelEnforcementRequest,
  type KernelEnforcementResult,
  type KernelExecutionRevision,
  type PostInvokeEvent,
  type PreconditionFireRequest,
  type ToolDispatchOverrideFn,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import type { PluginSpawn } from '@papercusp/tooldef';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import { getOverride, PASS_THROUGH as TESTING_SHELL_PASS_THROUGH } from '@papercusp/testing-shell/llm';
import { recordToolAuthzEvent } from './tool-authz-audit';
import { maybeBeatPresenceOnDispatch } from './agent-tools/coordination/dispatch-heartbeat';
import { beginInFlightCall, endInFlightCall } from './in-flight-calls';
import { evaluateCapabilityEnvelope, ROLE_ENVELOPES } from './capability-envelope/policy';
import { checkSessionConfinement } from './capability-envelope/session-confinement-port';
// STATIC on purpose: the identity gate below is reached by DYNAMIC import inside
// a try/catch, and this predicate is what keeps the recovery door reachable when
// that import is what failed. A dynamic import here would reintroduce the exact
// circularity it exists to break. The module has no imports of its own.
import { isRecoveryDoorCall } from './capability-envelope/recovery-door';
// Dependency-free leaf, like recovery-door: building the lazy launch-record
// handle must not statically import the identity port it is handed to.
import { lazyIdentityLaunchRecord, type LoadedIdentityLaunchRecord } from './capability-envelope/lazy-launch-record';
import { selectNarrowedLaunchSpecBody } from './capability-envelope/identity-receipt-narrowing';
// Type-only: the identity gate itself is reached by DYNAMIC import (see the resolver).
import type { IdentityLaunchAuditStamp } from './capability-envelope/identity-grants-port';
import { checkAuditModeMutationGuard } from './capability-envelope/audit-mode-guard';
import { enforceAppKeyScope } from './connected-apps/enforce';
// Imported for its INSTALL side effect (D-017 §5): loading the store assigns the session
// confinement resolver. This gate fails SILENTLY when unresolved — no resolver means every
// session is unconfined, with nothing thrown and nothing logged — so installation is bound to
// the module the dispatcher already imports rather than to a boot step that can be skipped.
// The import itself performs no IO; the store primes lazily on its first consult.
import './capability-envelope/session-confinement-store';
// live-configurability-audit-2026-06-20 P-009 — runtime envelope overrides (D-010 sync-cache).
// Getters return empty when the dark flag is off ⇒ byte-identical envelope resolution.
import { envelopeRoleOverrides, envelopeProtectedAdditions } from './capability-envelope-overrides';
// live-configurability-audit-2026-06-20 P-020 — runtime telemetry-buffer sizing (D-010 sync-cache).
// Returns the baked defaults when the kill-switch flag is off / no override ⇒ byte-identical.
import { telemetryBufferConfig } from './telemetry-buffer-config';
import { recordDecisionLedger } from './decision-ledger/emit';
import { resolveAgentIdentity } from './agent-tools/coordination/identity';
import { readAgentStateStamp } from './agent-state-stamp';
import { classifyCallOrigin } from './telemetry-call-origin';
import { getServingHostIdentity } from './serving-host-identity';
import { recordMcpTraffic } from './coverage-census/attribution/sink';
import { observeFailureLoop } from './failure-loop-circuit-breaker';
import { goalKickoffRefusalPayload, isGoalKickoffGuardedTool, readGoalKickoffEvidence } from './goals/kickoff-evidence';
import { normalizeSessionActivation } from './session-activation';
import type { InvocationFrictionRef } from './harness/improvements/invocation-friction';
import { trackDetached } from './detached-imports';
import { pinModuleState } from '@papercusp/module-singleton';

/**
 * The role-scoped `papercusp` MCP surface can be discovered alongside the
 * superuser `papercusp-su` surface by an SU client. A judge-scoped call is
 * intentionally denied (judge is evidence-only, least-privileged by design —
 * its principal carries an empty capability set), but the generic denial
 * names only `system:judge`, hiding the authorized route and making a
 * server/configuration mismatch look like a missing user grant.
 *
 * This was originally scoped to ONE tool/capability pair (plans:audit /
 * plans:write, EI-21543450341912836) — and the identical root cause was then
 * independently re-filed against locks:acquire + capability:edit
 * (EI-21364232422724692), db:next-migration + db:migrate
 * (EI-21465277780923625), and memory:search (EI-21907885860611918). Every one
 * of those reports is the SAME failure: an su/operator session dispatched
 * through the plain `papercusp` server instead of the already-authorized
 * `papercusp-su` server, and got resolved as the judge principal instead of
 * its own identity. The tool/capability being denied is incidental to that
 * misrouting, so the hint fires for the judge-mismatch SHAPE regardless of
 * which tool/capability triggered it — an allowlist here just re-files this
 * bug against the next tool it happens to hit. `tools:invoke` preserves the
 * caller's principal, so recommending it from this judge session only repeats
 * the same denial; the hint must direct the caller to a DIFFERENT authorized
 * session instead.
 */
export function authorizationFailureHint(input: {
  toolName: string;
  missingCapability?: string;
  deniedRole?: string;
  allowedRoles?: readonly string[];
  ctx: UnifiedToolContext;
}): string | undefined {
  if (
    input.ctx.transport !== 'mcp' ||
    input.ctx.isSuperuser === true ||
    input.ctx.role !== 'judge' ||
    input.ctx.principal?.slug !== 'system:judge'
  ) {
    return undefined;
  }
  // Both denial shapes have the SAME remedy — a differently-scoped session — so they
  // share one sentence rather than drifting into two. The capability wording is kept
  // byte-identical to what it has always emitted.
  const lacks = input.missingCapability
    ? `this principal lacks ${input.missingCapability} for ${input.toolName}`
    : `role "${input.deniedRole ?? input.ctx.role}" is not on ${input.toolName}'s allowlist` +
      (input.allowedRoles?.length ? ` (allowed: ${input.allowedRoles.join(', ')})` : '');
  return (
    `This is a judge-scoped MCP session; ${lacks}. ` +
    '`tools:invoke` preserves the same judge principal, so do not retry it in this session: it will be denied identically. ' +
    'Use a separate authorized su/operator session through the papercusp-su MCP server to invoke the tool.'
  );
}

/**
 * Serialize to a Postgres-`jsonb`-safe JSON string. Postgres `jsonb` (and `text`)
 * cannot represent a NUL byte (U+0000) and rejects the `::jsonb` cast with
 * `unsupported Unicode escape sequence`. Tool args/metadata occasionally carry NUL
 * bytes (binary-ish payloads, truncated file reads, terminal output), which made
 * the whole `tool_invocations` row throw — silently dropping that tool call's
 * telemetry (the catch in `recordInvocationImpl` swallows it). Strip every NUL
 * from each string VALUE during serialization via a replacer (non-NUL content is
 * left untouched).
 */
export function jsonbSafeStringify(value: unknown): string {
  // Referenced via fromCharCode so a raw NUL byte never appears in this source.
  const NUL = String.fromCharCode(0);
  return JSON.stringify(value, (_key, val) =>
    typeof val === 'string' && val.includes(NUL) ? val.split(NUL).join('') : val,
  );
}

/**
 * The event-reaction system installs its `postInvoke` handler here at startup
 * (`lib/events` calls `setReactionPostInvoke`). Kept as a setter indirection —
 * not a direct import of the engine — so projected-tool-deps (loaded very early
 * by every transport) does NOT import the events module, avoiding the cycle
 * `events → dispatch-reaction → projected-tool-deps`. Unset ⇒ no reactions.
 */
let reactionPostInvoke: ((event: PostInvokeEvent) => void) | null = null;
export function setReactionPostInvoke(handler: ((event: PostInvokeEvent) => void) | null): void {
  reactionPostInvoke = handler;
}

/**
 * The PRECONDITION FIRE PORT (`requires:` auto-correct — autoloop-pot-operator-
 * rebuild D-006). Installed by `lib/events` alongside the postInvoke handler —
 * the corrective fire rides the SAME dispatch path as reactions
 * (`fireReactionInProcess`: auth-gated, audited, cause-chained). Same setter
 * indirection as above to avoid the `events → dispatch-reaction →
 * projected-tool-deps` cycle. Unset ⇒ auto-correct preconditions FAIL CLOSED
 * (the dispatcher rejects with a message naming the uninstalled port).
 */
let preconditionFire: ((req: PreconditionFireRequest) => Promise<void>) | null = null;
export function setPreconditionFire(handler: ((req: PreconditionFireRequest) => Promise<void>) | null): void {
  preconditionFire = handler;
}

/**
 * Optional operator-side policy resolver for the generic D-030 kernel port.
 * The resolver is installed by the activation/control-plane owner when it has
 * a richer live store. Keeping it behind a setter avoids a hard import cycle
 * from this shared dispatch adapter into the control-anchor implementation.
 */
let kernelEnforcementResolver: KernelEnforcementPort | null = null;

export function setKernelEnforcementResolver(resolver: KernelEnforcementPort | null): void {
  kernelEnforcementResolver = resolver;
}

/** Compatibility name used by early P-041 host adapters. */
export const setKernelEnforcementPort = setKernelEnforcementResolver;

function operatorKernelDenial(
  code: string,
  reason: string,
  policyRevision?: string | null,
  serverAudit?: KernelEnforcementResult['serverAudit'],
): KernelEnforcementResult {
  return {
    decision: 'deny',
    availability: 'available',
    applied: true,
    code,
    reason,
    ...(policyRevision !== undefined ? { policyRevision } : {}),
    ...(serverAudit ? { serverAudit } : {}),
  };
}

/**
 * Read the authoritative session activation/control projection for one kernel
 * request. This is deliberately a narrow read of the existing
 * `session_briefs.control_state` row — it does not create a second identity or
 * policy store. A missing row is the legacy path; a failed authority read is
 * NOT proof of a missing row and must not reopen an opted-in session.
 */
interface OperatorKernelState extends KernelContextState {
  identityLaunchRecord?: unknown;
  /** Selected adv_sessions row identity/version for immutable artifact replay. */
  identityLaunchRecordVersion?: { sessionId: string; rowVersion: string };
  /** How the server selected that row; a fallback is not caller attribution. */
  identityLaunchRecordSelection?: 'caller-row' | 'owner-workspace-fallback';
  /** The control anchor exists, but its owning adv_sessions row does not. */
  identityLaunchRecordMissing?: boolean;
  authorityUnavailable?: boolean;
  authorityUnavailableSources?: AuthorityUnavailableSource[];
  /** The server-resolved owner whose active launch/control rows were read. */
  operationOwnerId?: string;
  /** The workspace those rows were read under (the resolver's own scope). */
  operationWorkspaceId?: string;
  /** session_briefs.control_generation at the read, when a brief exists. */
  controlGeneration?: number;
}

type AuthorityUnavailableSource =
  | 'control-anchor-query-failed'
  | 'verified-caller-row-unavailable'
  | 'power-user-revocation-query-failed'
  | 'authority-reader-initialization-failed'
  | 'identity-policy-evaluation-failed';

/**
 * The launch record BODY, read only on an identity-resolution cache miss
 * (WI-10002721). Scoped to the same owner + workspace as the header read, and
 * returned with the row version it was read at so the gate can key the verdict
 * on the snapshot it actually judged. A throw propagates: the kernel resolver
 * fails closed on it exactly as on a failed control-anchor read.
 */
async function loadIdentityLaunchRecord(
  advSessionId: number | string | null,
  ownerId: string,
  workspaceId: string,
  receipts?: readonly unknown[],
): Promise<LoadedIdentityLaunchRecord | null> {
  if (advSessionId == null) return null;
  const { sql } = getOrgPg();
  // WI-10004801: identityHistory is narrowed to the requested receipts in
  // PostgreSQL — the retained history is most of a 13 MB record, and parsing it
  // on every cache miss is what spiked worker heaps (#1155).
  const rows = await selectNarrowedLaunchSpecBody(sql, {
    advSessionId, ownerId, workspaceId, revisions: receipts ?? null,
  });
  const row = rows[0];
  return row ? { record: row.launch_spec, rowVersion: row.launch_spec_xmin ?? null } : null;
}

/**
 * The launch-record header last read for an (owner, workspace), pinned to the
 * adv_sessions row version it was read at (WI-10002721). Immutable per
 * (id, xmin), so reuse is exact rather than a TTL guess; bounded like the
 * identity-resolution cache.
 */
interface LaunchHeader {
  sessionId: string;
  rowVersion: string;
  type: string | null;
  workspaceId: unknown;
  harnessSlug: unknown;
  hasAcceptedOperation: boolean;
  acceptedOperation: unknown;
}
const LAUNCH_HEADER_MEMO_MAX = 512;
const launchHeaderMemo = pinModuleState('@papercusp/operator-core.identity-launch-header-memo', () =>
  new Map<string, LaunchHeader>(),
);

function resolveLaunchHeader(
  memoKey: string,
  known: LaunchHeader | undefined,
  row: {
    adv_session_id: number | string | null;
    adv_session_xmin: string | null;
    launch_header_known?: boolean | null;
    launch_spec_type?: string | null;
    launch_spec_workspace_id?: unknown;
    launch_spec_harness_slug?: unknown;
    launch_spec_has_accepted_operation?: boolean | null;
    launch_spec_accepted_operation?: unknown;
  } | undefined,
): Pick<LaunchHeader, 'type' | 'workspaceId' | 'harnessSlug' | 'hasAcceptedOperation' | 'acceptedOperation'> {
  const read = {
    type: row?.launch_spec_type ?? null,
    workspaceId: row?.launch_spec_workspace_id ?? null,
    harnessSlug: row?.launch_spec_harness_slug ?? null,
    hasAcceptedOperation: row?.launch_spec_has_accepted_operation === true,
    acceptedOperation: row?.launch_spec_accepted_operation ?? null,
  };
  if (row?.adv_session_id == null || row.adv_session_xmin == null) return read;
  const sessionId = String(row.adv_session_id);
  const rowVersion = String(row.adv_session_xmin);
  // PostgreSQL skipped the header ONLY when it matched the version passed in;
  // re-check against that same captured entry so a concurrent memo write can
  // never pair one row version with another version's header.
  if (row.launch_header_known === true && known?.sessionId === sessionId && known.rowVersion === rowVersion) {
    launchHeaderMemo.delete(memoKey);
    launchHeaderMemo.set(memoKey, known);
    return known;
  }
  launchHeaderMemo.delete(memoKey);
  // Skipped but unpairable cannot happen (both sides come from `known`); if it
  // ever did, the nulls must not be remembered — this call fails closed on an
  // absent header and the next one re-reads it.
  if (row.launch_header_known === true) return read;
  launchHeaderMemo.set(memoKey, { sessionId, rowVersion, ...read });
  while (launchHeaderMemo.size > LAUNCH_HEADER_MEMO_MAX) {
    const oldest = launchHeaderMemo.keys().next().value;
    if (oldest === undefined) break;
    launchHeaderMemo.delete(oldest);
  }
  return read;
}

export async function readControlAnchorKernelState(
  request: KernelEnforcementRequest,
): Promise<OperatorKernelState | null> {
  let ownerId: string;
  try {
    ownerId = resolveAgentIdentity(request.ctx).ownerId;
  } catch {
    return null;
  }
  const workspaceId =
    request.ctx.workspaceId && request.ctx.workspaceId !== '*'
      ? request.ctx.workspaceId
      : request.ctx.principal?.workspaceId && request.ctx.principal.workspaceId !== '*'
        ? request.ctx.principal.workspaceId
        : null;
  if (!workspaceId) return null;

  // A native MCP caller may carry the exact adv_sessions row that the host
  // verified for its native CLI session. Without it, owner/workspace selection
  // can choose a re-armed dead predecessor whose started_at was refreshed.
  const requestedAdvSessionId = request.ctx.advSessionId;
  const callerAdvSessionId =
    typeof requestedAdvSessionId === 'number' &&
    Number.isSafeInteger(requestedAdvSessionId) &&
    requestedAdvSessionId > 0
      ? requestedAdvSessionId
      : null;

  const { sql } = getOrgPg();
  // WI-10002721: the hot read carries the launch record's HEADER only — its
  // type and the two top-level fields the identity gate keys and checks on —
  // never the body (live avg 884KB, max 3.9MB, JSON-parsed on the main thread
  // every preflight). The body is read by `loadIdentityLaunchRecord` on an
  // identity-resolution cache miss. The old `to_jsonb(s)->'launch_spec'` also
  // serialised the WHOLE adv_sessions row in PostgreSQL to extract one column.
  //
  // Even the header costs a full detoast: `jsonb_typeof` / `->` decompress the
  // whole TOASTed value (measured on a ~1MB spec: 203 shared buffers, 8.7ms of
  // PG CPU per preflight). A row version's header is immutable — any UPDATE
  // moves xmin — so the last header seen for this (owner, workspace) is passed
  // back in, and the CASE guards skip the detoast while the newest row is still
  // that exact (id, xmin) (measured: 16 buffers, 0.12ms).
  const memoKey = JSON.stringify([ownerId, workspaceId, callerAdvSessionId]);
  const knownHeader = launchHeaderMemo.get(memoKey);
  const knownId = knownHeader?.sessionId ?? null;
  const knownXmin = knownHeader?.rowVersion ?? null;
  let stateRow:
    | {
        control_state: unknown;
        control_generation: number | string | null;
        workspace_id: string | null;
        adv_session_id: number | string | null;
        adv_session_xmin: string | null;
        launch_header_known?: boolean | null;
        launch_spec_type?: string | null;
        launch_spec_workspace_id?: unknown;
        launch_spec_harness_slug?: unknown;
        launch_spec_has_accepted_operation?: boolean | null;
        launch_spec_accepted_operation?: unknown;
      }
    | undefined;
  let controlReadFailed = false;
  const authorityUnavailableSources: AuthorityUnavailableSource[] = [];
  try {
    const rows = await sql<Array<{
      control_state: unknown;
      control_generation: number | string | null;
      workspace_id: string | null;
      adv_session_id: number | string | null;
      adv_session_xmin: string | null;
      launch_header_known?: boolean | null;
      launch_spec_type?: string | null;
      launch_spec_workspace_id?: unknown;
      launch_spec_harness_slug?: unknown;
      launch_spec_has_accepted_operation?: boolean | null;
      launch_spec_accepted_operation?: unknown;
    }>>`
      SELECT b.control_state, b.control_generation, COALESCE(b.workspace_id, a.workspace_id) AS workspace_id,
             a.id AS adv_session_id, a.launch_header_known,
             a.launch_spec_type, a.launch_spec_workspace_id, a.launch_spec_harness_slug,
             a.launch_spec_has_accepted_operation, a.launch_spec_accepted_operation,
             a.launch_spec_xmin AS adv_session_xmin
        FROM (
          SELECT control_state, control_generation, workspace_id
            FROM harness_shared.session_briefs
           WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
           LIMIT 1
        ) b
        FULL JOIN (
          SELECT s.id, s.xmin::text AS launch_spec_xmin, s.workspace_id,
                 (s.id::text = ${knownId} AND s.xmin::text = ${knownXmin}) AS launch_header_known,
                 CASE WHEN s.id::text = ${knownId} AND s.xmin::text = ${knownXmin} THEN NULL
                      ELSE jsonb_typeof(s.launch_spec) END AS launch_spec_type,
                 CASE WHEN s.id::text = ${knownId} AND s.xmin::text = ${knownXmin} THEN NULL
                      ELSE s.launch_spec->'workspaceId' END AS launch_spec_workspace_id,
                 CASE WHEN s.id::text = ${knownId} AND s.xmin::text = ${knownXmin} THEN NULL
                      ELSE s.launch_spec->'harnessSlug' END AS launch_spec_harness_slug,
                 CASE WHEN s.id::text = ${knownId} AND s.xmin::text = ${knownXmin} THEN NULL
                      ELSE s.launch_spec ? 'acceptedOperation' END AS launch_spec_has_accepted_operation,
                 CASE WHEN s.id::text = ${knownId} AND s.xmin::text = ${knownXmin} THEN NULL
                      ELSE s.launch_spec->'acceptedOperation' END AS launch_spec_accepted_operation
            FROM harness_shared.adv_sessions s
           WHERE s.coord_owner_id = ${ownerId} AND s.workspace_id = ${workspaceId}
             AND (${callerAdvSessionId}::bigint IS NULL OR s.id = ${callerAdvSessionId})
           ORDER BY (s.ended_at IS NULL AND s.ended_by IS NULL) DESC, s.started_at DESC, s.id DESC
           LIMIT 1
        ) a ON true
       LIMIT 1
    `;
    stateRow = rows[0];
  } catch {
    // Unknown authority cannot authorize a new effect. In particular, neither
    // a missing migration nor a failed join is evidence of a legacy session.
    controlReadFailed = true;
    authorityUnavailableSources.push('control-anchor-query-failed');
    stateRow = undefined;
  }
  if (callerAdvSessionId !== null) {
    const selectedAdvSessionId =
      stateRow?.adv_session_id == null ? null : String(stateRow.adv_session_id);
    if (selectedAdvSessionId !== String(callerAdvSessionId)) {
      // A verified caller row that vanished (or no longer matches this owner
      // and workspace) is unavailable authority. Do not fall through to the
      // legacy missing-row recovery path or another session's launch record.
      controlReadFailed = true;
      authorityUnavailableSources.push('verified-caller-row-unavailable');
      stateRow = undefined;
    }
  }

  let powerUserRevoked = false;
  if (request.ctx.isPowerUser && request.ctx.uiClientId) {
    try {
      const rows = await sql<Array<{ revoked_at: Date | string | null }>>`
        SELECT revoked_at
          FROM harness_shared.power_user_sessions
         WHERE auth_session_id = ${request.ctx.uiClientId}
           AND workspace_id = ${workspaceId}
         LIMIT 1
      `;
      // Absence is intentionally not treated as revocation: older/in-process
      // callers can carry the power-user marker without this optional table.
      powerUserRevoked = rows.length > 0 && rows[0].revoked_at != null;
    } catch {
      // Failed credential-authority reads are not successful "not revoked"
      // reads. Preserve the same fail-closed posture as the control anchor.
      controlReadFailed = true;
      authorityUnavailableSources.push('power-user-revocation-query-failed');
    }
  }

  const raw = stateRow?.control_state;
  const stateObject = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
  let activation: KernelContextState['activation'] = null;
  let malformedActivation = false;
  if (stateObject && stateObject.activation != null) {
    try {
      activation = normalizeSessionActivation(stateObject.activation) ?? null;
    } catch {
      malformedActivation = true;
    }
  }
  const lifecycle = stateObject?.lifecycle && typeof stateObject.lifecycle === 'object' && !Array.isArray(stateObject.lifecycle)
    ? stateObject.lifecycle as Record<string, unknown>
    : null;
  // A release marker is a lifecycle tombstone, not a truthy convenience flag.
  // Treat the presence of the key (including a malformed/null value) as a
  // revocation signal so a partially-written or schema-drifted release cannot
  // accidentally reopen the session. The writer clears the key entirely on
  // resume; it never uses `released: null` as the clear representation.
  const hasReleaseMarker = Boolean(lifecycle && Object.prototype.hasOwnProperty.call(lifecycle, 'released'));
  const hasAnyState = Boolean(stateRow || powerUserRevoked || controlReadFailed);
  if (!hasAnyState) return null;

  const generation = stateRow?.control_generation == null ? null : String(stateRow.control_generation);
  // The SQL row carries an explicit joined-table identity so a null launch_spec
  // cannot be mistaken for an absent adv_sessions row. Only the latter opens
  // the narrow coord:orient recovery door; an existing row with a missing or
  // malformed launch_spec remains an ordinary stale-artifact denial.
  const identityLaunchRecordMissing = Boolean(
    stateRow &&
    Object.prototype.hasOwnProperty.call(stateRow, 'adv_session_id') &&
    stateRow.adv_session_id == null,
  );
  const launchSessionId = stateRow?.adv_session_id ?? null;
  const launchHeader = resolveLaunchHeader(memoKey, knownHeader, stateRow);
  const controlGeneration = generation === null ? NaN : Number(generation);
  return {
    operationOwnerId: ownerId,
    operationWorkspaceId: workspaceId,
    ...(Number.isSafeInteger(controlGeneration) && controlGeneration >= 0 ? { controlGeneration } : {}),
    ...(controlReadFailed ? {
      authorityUnavailable: true,
      authorityUnavailableSources: [...new Set(authorityUnavailableSources)],
    } : {}),
    ...(identityLaunchRecordMissing ? { identityLaunchRecordMissing: true } : {}),
    ...(stateRow && Object.prototype.hasOwnProperty.call(stateRow, 'launch_spec_type')
      ? { identityLaunchRecord: lazyIdentityLaunchRecord({
          isObject: launchHeader.type === 'object',
          workspaceId: launchHeader.workspaceId,
          harnessSlug: launchHeader.harnessSlug,
          hasAcceptedOperation: launchHeader.hasAcceptedOperation,
          acceptedOperation: launchHeader.acceptedOperation,
          load: (receipts) => loadIdentityLaunchRecord(launchSessionId, ownerId, workspaceId, receipts),
        }) } : {}),
    ...(stateRow?.adv_session_id != null && stateRow.adv_session_xmin != null
      ? { identityLaunchRecordVersion: {
          sessionId: String(stateRow.adv_session_id), rowVersion: String(stateRow.adv_session_xmin),
        }, identityLaunchRecordSelection: callerAdvSessionId !== null
          ? 'caller-row' as const : 'owner-workspace-fallback' as const } : {}),
    ...(activation ? { activation } : {}),
    ...(activation?.applied ? { appliedRevision: activation.applied } : {}),
    ...(generation ? { policyRevision: `control:${generation}` } : {}),
    ...(powerUserRevoked || malformedActivation || hasReleaseMarker ? { revoked: true } : {}),
  };
}

function evaluateOperatorKernelRequest(
  request: KernelEnforcementRequest,
  state: OperatorKernelState | undefined,
): KernelEnforcementResult {
  const policyRevision = state?.policyRevision ?? null;
  if (state?.authorityUnavailable) {
    return operatorKernelDenial(
      'policy-unavailable',
      'current session authority could not be read; no effect authorized',
      policyRevision,
      state.authorityUnavailableSources?.length
        ? { authorityUnavailableSources: state.authorityUnavailableSources }
        : undefined,
    );
  }
  if (state?.revoked === true) {
    return operatorKernelDenial('revoked', 'session or identity authority has been revoked', policyRevision);
  }

  const ownership = request.ownership ?? state?.ownership;
  if (ownership?.required) {
    let ownerId: string | null = null;
    try {
      ownerId = resolveAgentIdentity(request.ctx).ownerId ?? null;
    } catch {
      ownerId = null;
    }
    const expected = ownership.resourceOwnerId?.trim() || null;
    if (!ownerId || !expected || ownerId !== expected) {
      return operatorKernelDenial(
        'ownership',
        expected
          ? `resource ${ownership.resourceId ?? '(unknown)'} is owned by ${expected}, not this caller`
          : `resource ${ownership.resourceId ?? '(unknown)'} has no resolved owner`,
        policyRevision,
      );
    }
  }

  const activation = state?.activation;
  const applied = request.appliedRevision ?? state?.appliedRevision ?? activation?.applied ?? null;
  // A caller may explicitly request a revision, but a merely desired/prepared
  // session update is not itself a request and must not freeze a session. Soft
  // behavior updates continue under the last acknowledged applied revision.
  const requested = request.requestedRevision ?? state?.requestedRevision ?? null;
  if (requested && (!applied || !sameKernelRevision(requested, applied))) {
    return operatorKernelDenial(
      'stale-activation',
      `requested revision ${requested.specificationRevision}:${requested.stateRevision} is not the applied revision`,
      policyRevision,
    );
  }

  if (applied) {
    return {
      decision: 'allow',
      availability: 'available',
      applied: true,
      executionRevision: applied,
      revisionSource: 'applied',
      ...(policyRevision !== undefined ? { policyRevision } : {}),
    };
  }

  if (activation?.prepared) {
    return {
      decision: 'allow',
      availability: 'available',
      applied: false,
      executionRevision: activation.prepared,
      revisionSource: 'prepared',
      ...(policyRevision !== undefined ? { policyRevision } : {}),
    };
  }

  return { decision: 'allow', availability: 'unavailable', applied: false };
}

/**
 * EI-23703586803892464: a gate-side convergence request, raised only when the
 * identity gate resolved this session's artifact as `stale-artifact`.
 */
interface StaleArtifactHeal {
  ownerId: string;
  workspaceId: string;
  generation: number;
  desired: NonNullable<NonNullable<KernelContextState['activation']>['desired']>;
  appliedKey: string;
}

/** A failed convergence is retried no sooner than this, per exact revision pair. */
export const STALE_ARTIFACT_HEAL_RETRY_MS = 2_000;
const STALE_ARTIFACT_HEAL_MEMO_MAX = 1_000;
type StaleArtifactConverger =
  typeof import('./agent-tools/coordination/control-anchor').convergeActivationToLaunchRecord;
const staleArtifactHealState: { attempts: Map<string, number>; converge?: StaleArtifactConverger | null } =
  pinModuleState(
    '@papercusp/operator-core.projected-tool-deps.staleArtifactHeal',
    () => ({ attempts: new Map<string, number>(), converge: null as StaleArtifactConverger | null }),
  );

/**
 * Seam for the authority-safe convergence writer. `null` (the default) resolves
 * the real `convergeActivationToLaunchRecord` lazily; control-anchor is imported
 * dynamically because it sits above this module in the dependency graph. A unit
 * test injects its verdict here: a `vi.mock` of that dynamic import was measured
 * NOT to reach this call site (the resolver received the unmocked module record).
 */
export function setStaleArtifactConverger(converge: StaleArtifactConverger | null): void {
  staleArtifactHealState.converge = converge;
}

function isStaleArtifactResolution(result: KernelEnforcementResult): boolean {
  if (result.decision === 'deny') {
    const obligations = result.obligations as { capabilityUnsatisfied?: { cause?: unknown } } | undefined;
    return obligations?.capabilityUnsatisfied?.cause === 'stale-artifact';
  }
  // The recovery door (coord:orient / its dispatch wrapper) is admitted with no
  // grants on the same resolution; converge there too so the door runs with the
  // authority the launch already carries.
  return result.code === 'identity-recovery' && /stale-artifact/.test(result.reason ?? '');
}

function staleArtifactHealFor(state: OperatorKernelState): StaleArtifactHeal | null {
  const desired = state.activation?.desired;
  if (!desired || !state.operationOwnerId || !state.operationWorkspaceId) return null;
  if (state.controlGeneration === undefined) return null;
  const applied = state.activation?.applied ?? state.appliedRevision ?? null;
  return {
    ownerId: state.operationOwnerId,
    workspaceId: state.operationWorkspaceId,
    generation: state.controlGeneration,
    desired,
    appliedKey: applied ? `${applied.specificationRevision}:${applied.stateRevision}` : '-',
  };
}

/**
 * EI-23703586803892464: converge a `stale-artifact` session from the gate itself.
 *
 * Measured 2026-09-27 (12 owners in one hour): every carry-respawn writes the
 * successor's launch record and a restart-sourced `desired`, and the successor's
 * startup hooks (activity:report, coord:glance, flags:get) reach this gate 2-5s
 * BEFORE the first turn-start runs the relaunch convergence. Each of those calls
 * was denied `stale-artifact` although the process was already running `desired`.
 * Earlier variants of the same class bricked sessions until hand-written SQL.
 *
 * `convergeActivationToLaunchRecord` is the authority-safe writer: it moves
 * `applied` to `desired` only when the gate-selected launch record admits
 * `desired` AND no longer admits the current `applied` — i.e. only when it
 * replaces a certain total denial with the authority the launch already carries.
 * An in-place mode flip keeps the old `applied` admitted, so it never fires there,
 * and the delivery watermark is never touched (the CTRL text still awaits proof).
 * Running it here makes recovery a property of the gate: the first tool call of
 * ANY kind converges the session, instead of one particular hook.
 */
async function healStaleArtifactFromLaunchRecord(heal: StaleArtifactHeal): Promise<boolean> {
  const key = [
    heal.ownerId, heal.workspaceId,
    heal.desired.specificationRevision, heal.desired.stateRevision, heal.appliedKey,
  ].join('|');
  const attempts = staleArtifactHealState.attempts;
  const now = Date.now();
  const last = attempts.get(key);
  if (last !== undefined && now - last < STALE_ARTIFACT_HEAL_RETRY_MS) return false;
  if (attempts.size >= STALE_ARTIFACT_HEAL_MEMO_MAX) attempts.clear();
  attempts.set(key, now);
  try {
    const converge = staleArtifactHealState.converge
      ?? (await import('./agent-tools/coordination/control-anchor')).convergeActivationToLaunchRecord;
    const converged = await converge(heal.ownerId, heal.workspaceId, heal.generation, heal.desired);
    if (converged) attempts.delete(key);
    return converged;
  } catch {
    return false;
  }
}

/** Live control-anchor resolver installed by the operator bootstrap. */
export const controlAnchorKernelResolver: KernelEnforcementPort = async (request) => {
  const pending: { heal?: StaleArtifactHeal } = {};
  const first = await resolveControlAnchorKernelOnce(request, (heal) => { pending.heal = heal; });
  if (!pending.heal) return first;
  // Re-resolve from a fresh read only when the convergence actually wrote; the
  // second pass never heals again, so a session the launch record cannot vouch
  // for keeps its original denial.
  return (await healStaleArtifactFromLaunchRecord(pending.heal))
    ? resolveControlAnchorKernelOnce(request)
    : first;
};

function auditLaunchRowSelection(
  verdict: KernelEnforcementResult,
  state: OperatorKernelState | null,
): KernelEnforcementResult {
  const record = verdict.serverAudit?.identityLaunchRecord;
  if (!state?.identityLaunchRecordSelection || !record || typeof record !== 'object' || Array.isArray(record)) {
    return verdict;
  }
  // Extend the stamp for the record actually evaluated (including its loaded
  // xmin). Never substitute a presented owner or tool argument for this source.
  return {
    ...verdict,
    serverAudit: {
      ...verdict.serverAudit,
      identityLaunchRecord: { ...record, selection: state.identityLaunchRecordSelection },
    },
  };
}

async function resolveControlAnchorKernelOnce(
  request: KernelEnforcementRequest,
  onStaleArtifact?: (heal: StaleArtifactHeal) => void,
): Promise<KernelEnforcementResult> {
  let state: OperatorKernelState | null;
  try {
    state = await readControlAnchorKernelState(request);
  } catch {
    // Client initialization itself can fail before the SELECT's try/catch.
    // Never let that escape into the generic optional-port fail-soft handler.
    return operatorKernelDenial(
      'policy-unavailable',
      'session authority reader unavailable; no effect authorized',
      undefined,
      { authorityUnavailableSources: ['authority-reader-initialization-failed'] },
    );
  }
  const verdict = evaluateOperatorKernelRequest(request, state ?? undefined);
  if (verdict.decision === 'deny') return verdict;
  // Applied-state receipts and current policy are host-resolved. This common
  // seat runs for indirect/rule dispatch and native adapters, before exemptions.
  // An artifact the identity gate evaluated but does not govern leaves the
  // structural verdict in force; it still names the launch row it was judged
  // against, so every identity-bearing invocation persists a row reference (D-007).
  const ungoverned: { stamp?: IdentityLaunchAuditStamp } = {};
  if (state && Object.prototype.hasOwnProperty.call(state, 'identityLaunchRecord')) {
    try {
      const { checkIdentityGrantKernel } = await import('./capability-envelope/identity-grants-port');
      const grants = await checkIdentityGrantKernel(
        request, state, state.identityLaunchRecord, undefined, undefined,
        (stamp) => { ungoverned.stamp = stamp; },
      );
      if (grants) {
        if (onStaleArtifact && isStaleArtifactResolution(grants)) {
          const heal = staleArtifactHealFor(state);
          if (heal) onStaleArtifact(heal);
        }
        return auditLaunchRowSelection(grants, state);
      }
    } catch {
      // The generic optional port catches throws as unavailable/allow. This
      // resolver owns real authority, so it must publish an explicit denial —
      // with ONE exception, which is the difference between a degraded session
      // and a permanently mute one.
      //
      // The gate above is reached through a DYNAMIC import, so an identity-plane
      // fault takes out the recovery door along with everything else: the door's
      // own allow lives INSIDE the module that just failed to load, and the
      // blanket denial below then seals the session with no way to ask for help.
      // That is the self-sealing class (EI-23768233018723089) — recovery has so
      // far required an out-of-band sudo psql write, which is an accident of
      // this deployment rather than a designed break-glass.
      //
      // Admitting the door here confers NOTHING. `applied: false` carries no
      // grants; anything the wrapper forwards is preflighted again by this same
      // seat under its own name; and the structural verdict above has already
      // passed. Nor does refusing protect anything — a caller able to induce
      // this throw could instead present no launch record at all and take the
      // weaker `no-launch-record` door, so gating on "the port threw" bricks
      // honest sessions while stopping nobody. The predicate is imported
      // STATICALLY from a module with no imports of its own, so it cannot become
      // unavailable for the same reason the gate did.
      if (isRecoveryDoorCall(request.toolName, request.args)) {
        return {
          decision: 'allow',
          availability: 'available',
          applied: false,
          code: 'identity-recovery',
          reason: 'identity policy evaluation unavailable; the recovery door stays open',
        };
      }
      return operatorKernelDenial(
        'policy-unavailable',
        'identity policy evaluation unavailable; no effect authorized',
        undefined,
        { authorityUnavailableSources: ['identity-policy-evaluation-failed'] },
      );
    }
  }
  const resolved = ungoverned.stamp
    ? { ...verdict, serverAudit: { ...verdict.serverAudit, identityLaunchRecord: ungoverned.stamp } }
    : verdict;
  return auditLaunchRowSelection(resolved, state);
};

/** Install the DB-backed resolver exactly once at the host's bootstrap seam. */
export function installControlAnchorKernelResolver(): void {
  setKernelEnforcementResolver(controlAnchorKernelResolver);
}

/**
 * Default Papercusp implementation of the host-neutral kernel port.
 *
 * It consumes only explicit, host-resolved state. In particular it never
 * treats a capability/tool name as proof of shell confinement, and it never
 * turns a missing optional state row into a denial. A control-plane owner can
 * install a resolver with `setKernelEnforcementResolver` for a live DB-backed
 * activation/revocation read; the structural checks below still protect the
 * common path and make negative behavior unit-testable without PG.
 */
export const operatorKernelEnforcement: KernelEnforcementPort = async (request: KernelEnforcementRequest) => {
  // A connected-app key (external-app-access P-003) is limited to its own workspace, harnesses
  // and tool allowlist, and never reaches the hard-deny set. It runs FIRST and on every
  // boundary, ahead of the installed resolver, so no resolver can re-open what it refuses.
  // Never throws for an app principal (a failed read is an explicit denial).
  const appScope = await enforceAppKeyScope(request);
  if (appScope) return appScope;
  if (kernelEnforcementResolver) return kernelEnforcementResolver(request);
  return evaluateOperatorKernelRequest(request, request.ctx.kernelState);
};

/** Adapter alias matching the generic dependency field's migration names. */
export const kernelEnforcement = operatorKernelEnforcement;

/**
 * Native/shell boundary adapter for host code that exposes a `PluginSpawn`.
 * Capability declarations are passed as evidence to the policy port, never
 * interpreted here as proof that a binary is confined. The wrapped executor
 * is called only after an explicit allow.
 */
export function wrapOperatorKernelSpawn(
  spawn: PluginSpawn,
  ctx: UnifiedToolContext,
  capabilities: readonly string[] = [],
  toolName = 'native:shell',
): PluginSpawn {
  return wrapKernelSpawn(
    spawn,
    operatorKernelEnforcement,
    (bin, args, opts) => ({
      toolName,
      capabilities,
      args: { bin, args: [...args], options: opts ?? null },
      ctx,
    }),
  );
}

/** Naming alias for hosts that call the same adapter a native boundary. */
export const wrapOperatorNativeSpawn = wrapOperatorKernelSpawn;

async function readQuotaStateImpl(
  toolName: string,
  ctx: UnifiedToolContext,
  windowKey: string,
): Promise<{ count: number } | null> {
  // Captured into a local so the narrowing survives into the `sql.begin` closure below —
  // TS does not narrow a property access (`ctx.workspaceId`) across a function boundary.
  const workspaceId = ctx.workspaceId;
  if (!workspaceId) return null;
  // P-003: telemetry writes are deferred (see below), so a prior call's
  // tool_invocations row may still be queued. Drain it before counting so a
  // quota'd tool never under-counts. Cheap — only quota'd tools reach here
  // (capability:bash et al. have no quota and skip this gate entirely).
  await flushPendingTelemetry();
  try {
    const { sql } = getOrgPg();
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      return await tx.unsafe(
        // ('ok','refused') — NOT just 'ok'. A 'refused' row is a call that
        // dispatched and RAN (handler, gates, often a dedup index search) and then
        // returned isError. It was historically written as 'ok' and so has always
        // counted toward quota; splitting the status out (EI-20184794555427363)
        // must not quietly make refusals free, or a caller could spin refused calls
        // without limit. 'replayed' stays excluded — that one performs no work.
        `SELECT count(*)::int AS n FROM harness_shared.tool_invocations
          WHERE workspace_id = $1
            AND tool_name = $2
            AND role = $3
            AND window_key = $4
            AND status IN ('ok', 'refused')`,
        [workspaceId, toolName, ctx.role ?? '', windowKey],
      );
    });
    // postgres.js's tx.unsafe() resolves a RowList<Row[]> whose structural shape doesn't
    // sufficiently overlap with `{n:number}[]` for a direct `as` cast — go through `unknown`.
    const n = (result as unknown as Array<{ n: number }>)[0]?.n ?? 0;
    return { count: n };
  } catch (err) {
    console.warn(`[projected-tool-deps] readQuotaState failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

interface RecordInvocationInput {
  toolName: string;
  pluginName: string;
  ctx: UnifiedToolContext;
  windowKey: string;
  durationMs: number;
  status:
    | 'ok'
    | 'error'
    | 'quota-exceeded'
    | 'role-not-allowed'
    | 'timeout'
    | 'invalid-input'
    /**
     * EI-20184794555427363: the call dispatched cleanly and the handler then
     * self-reported failure by returning `isError: true` (a business-level
     * refusal), rather than throwing. Previously recorded as plain `ok`, which
     * made a refusal unfalsifiable from the ledger. See the fuller note on the
     * generic dispatcher's own status union (tooldef/src/dispatch-types.ts).
     *
     * UNLIKE `replayed`, this is NOT quota-neutral: the handler really ran. The
     * quota reader below counts ('ok','refused') for exactly that reason.
     */
    | 'refused'
    /**
     * WI-6792: the call was served from the idempotency-key replay store — the
     * tool never ran. Written by the MCP handler's replay branch, which returns
     * before dispatch and so never reaches the dispatcher's own recordTelemetry.
     *
     * DELIBERATELY its own member rather than 'ok' + a metadata flag:
     * readQuotaState counts `status = 'ok'` rows, so a replay that reused 'ok'
     * would charge the caller quota for work that was never performed. As its
     * own status it is queryable ("how much of this window was replay?") and
     * quota-neutral. No migration: tool_invocations.status has no CHECK
     * constraint (verified via pg_constraint), only NOT NULL.
     */
    | 'replayed';
  /**
   * Per-call correlation id from the dispatcher (see DispatchStartEvent['callId']).
   * Used to close THIS call's in-flight registry entry — the entry `onDispatchStart`
   * opened — without heuristic matching that would mis-settle an agent's concurrent
   * calls to the same tool. Absent for calls that never reached runDispatchStack
   * (the `replayed` branch returns before dispatch).
   */
  callId?: string;
  outputRef?: string | null;
  outputSize?: number | null;
  errorMessage?: string | null;
  /** Dispatcher error CLASS (P-007): persisted to harness_shared.tool_invocations.error_code. NULL on success. */
  errorCode?: string | null;
  args?: unknown;
  eventCount?: number;
  metadataJson?: Record<string, unknown> | null;
  /** Actual applied revision from the final kernel enforcement seat. */
  executionRevision?: KernelExecutionRevision | null;
  /** Structured kernel decisions for audit/debug consumers. */
  kernelPreflight?: KernelEnforcementResult | null;
  kernelEnforcement?: KernelEnforcementResult | null;
}

/* ─── P-003 deferred, batched telemetry writer ──────────────────────────────
 * recordTelemetry() is AWAITED in the dispatcher's `finally`
 * (runDispatchStack), so a synchronous per-call INSERT into
 * harness_shared.tool_invocations added a full PG round-trip (~10–50ms) to the
 * latency of EVERY tool call — the dominant per-call overhead for a tight
 * capability:bash loop (route-everything-through-definetool P-003; the quota
 * SELECT is already a no-op for no-quota tools like capability:bash).
 *
 * Telemetry is best-effort (errors already swallowed; NUL-byte rows already
 * dropped), so the write moves OFF the response path: each settled dispatch
 * SNAPSHOTS its row synchronously (cheap — JSON.stringify of args) and enqueues
 * it; a debounced background flusher writes the queue in BATCHED, per-workspace
 * transactions (one BEGIN/set_config/COMMIT amortized over many rows). The
 * awaited recordInvocation now resolves in ~microseconds.
 *
 * Correctness: readQuotaState drains the queue (flushPendingTelemetry) before
 * counting, so a quota'd tool never under-counts. Consumers needing synchronous
 * visibility (tests, llm-testing telemetry) can await flushPendingTelemetry().
 * The queue is hard-capped (drop-oldest) so a PG stall can never OOM the host. */

interface TelemetryRow {
  workspaceId: string;
  params: unknown[];
  friction?: InvocationFrictionRef;
}

/**
 * A shell variable that reached this sink without being expanded is never a
 * valid tenant key.  Keep this check deliberately broader than the two known
 * PAPERCUSP_* names: a future launcher variable must fail closed too, while
 * the legitimate workspace-global scope (`*`) remains unaffected.
 */
export function isUnresolvedTelemetryScopePlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith('$');
}

/* invoked_at is stamped EXPLICITLY (EI-7040): the writer is deferred + batched,
 * and Postgres `now()` is transaction-stable — leaving the column to its
 * DEFAULT gave every row in a flush batch ONE identical microsecond timestamp
 * (up to debounceMs after the actual call). That skewed time-series reads and
 * made batch-mates look like duplicate inserts (EI-7040's "2 identical rows"
 * were the statusline double-call sharing a flush). $26 carries the real
 * dispatch-settle time captured in buildTelemetryRow. */
const TELEMETRY_INSERT_SQL = `WITH caller AS (
  SELECT $1::text AS workspace_id, $25::text AS coord_owner_id
), resolved AS (
  SELECT c.*,
    (SELECT m.subject
       FROM harness_shared.agent_modes m
      WHERE m.workspace_id = c.workspace_id
        AND m.owner_id = c.coord_owner_id
        AND m.mode = 'goal' AND m.subject IS NOT NULL
      ORDER BY m.goal_lease_epoch DESC NULLS LAST, m.set_at DESC, m.owner_id DESC
      LIMIT 1) AS mode_goal_id,
    (SELECT b.goal_id
       FROM harness_shared.session_briefs b
      WHERE b.workspace_id = c.workspace_id
        AND b.owner_id = c.coord_owner_id
        AND b.goal_id IS NOT NULL
      ORDER BY b.updated_at DESC
      LIMIT 1) AS inherited_goal_id
  FROM caller c
), classified AS (
  SELECT r.*,
    COALESCE(r.mode_goal_id, r.inherited_goal_id) AS goal_id,
    r.coord_owner_id = (
      SELECT m.owner_id
        FROM harness_shared.agent_modes m
       WHERE m.workspace_id = r.workspace_id
         AND m.mode = 'goal'
         AND m.subject = r.mode_goal_id
       ORDER BY m.goal_lease_epoch DESC NULLS LAST, m.set_at DESC, m.owner_id DESC
       LIMIT 1
    ) AS is_sovereign_holder,
    COALESCE((
      SELECT e.fleet_slug IS NOT NULL
        FROM harness_shared.fleet_membership_events e
       WHERE e.workspace_id = r.workspace_id
         AND e.owner_id = r.coord_owner_id
       ORDER BY e.id DESC
       LIMIT 1
    ), false) AS in_drain_fleet
  FROM resolved r
)
INSERT INTO harness_shared.tool_invocations
   (workspace_id, harness_slug, plugin_name, tool_name, role,
    feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
    window_key, duration_ms, status, output_ref, output_size,
    error_message, args_json, transport, event_count, metadata_json,
    principal_kind, principal_auth_method, principal_trust, error_code,
    coord_owner_id, invoked_at,
    intent_event_id, assumption_set_id, goal_ref,
    call_origin, call_origin_source,
    serving_host, serving_process_id, serving_build_sha,
    goal_id, goal_actor_class)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17::jsonb,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26::timestamptz,
        $27,$28,$29,$30,$31,$32,$33,$34,
        c.goal_id,
        CASE
          WHEN c.goal_id IS NULL THEN NULL
          WHEN c.mode_goal_id IS NOT NULL AND c.is_sovereign_holder THEN 'holder-agent'
          WHEN c.in_drain_fleet THEN 'drain-fleet-member'
          ELSE 'goal-descendant-agent'
        END
   FROM classified c RETURNING id::text`;

// P-020: the telemetry-buffer sizing (maxPending / debounceMs / maxBatch) is now runtime-settable
// via telemetryBufferConfig() (canonical defaults TELEMETRY_BUFFER_DEFAULTS live in
// telemetry-buffer-config.ts). Kill-switch OFF / empty override ⇒ those defaults ⇒ byte-identical.

let telemetryQueue: TelemetryRow[] = [];
let telemetryFlushTimer: ReturnType<typeof setTimeout> | null = null;
let telemetryFlushInFlight: Promise<void> | null = null;
let telemetryDropped = 0;
let telemetryInsertErrorCount = 0;
let telemetryLastInsertErrorAt: string | null = null;
let telemetryInsertErrorToastSent = false;
let telemetryScopeRejectionWarned = false;
const frictionState = pinModuleState('@papercusp/operator-core.telemetry-friction', () => ({
  pending: 0, skipped: 0, errors: 0,
}));

export interface TelemetryHealth {
  droppedRows: number;
  insertErrorCount: number;
  lastInsertErrorAt: string | null;
  /** Committed invocation rows whose automatic probation delivery is busy/failed. */
  frictionSkippedCount: number;
  frictionErrorCount: number;
}

export function getTelemetryHealth(): TelemetryHealth {
  return {
    droppedRows: telemetryDropped,
    insertErrorCount: telemetryInsertErrorCount,
    lastInsertErrorAt: telemetryLastInsertErrorAt,
    frictionSkippedCount: frictionState.skipped,
    frictionErrorCount: frictionState.errors,
  };
}

export function __resetTelemetryHealthForTests(): void {
  telemetryQueue = [];
  telemetryDropped = 0;
  telemetryInsertErrorCount = 0;
  telemetryLastInsertErrorAt = null;
  telemetryInsertErrorToastSent = false;
  telemetryScopeRejectionWarned = false;
  frictionState.skipped = 0;
  frictionState.errors = 0;
}

/** Capture is bounded to one flush batch and enrolled in the existing detached
 * work registry. A busy capture never holds quota/spill readers or accumulates
 * another queue. Skipped/failed deliveries remain marked pending in invocation
 * telemetry for the existing watchdog, and are visible in telemetry health. */
function captureCommittedFriction(rows: readonly TelemetryRow[]): void {
  const inputs = rows.flatMap(row => row.friction?.id ? [row.friction] : []);
  if (!inputs.length) return;
  if (frictionState.pending) {
    frictionState.skipped += inputs.length;
    return;
  }
  frictionState.pending = inputs.length;
  void trackDetached((async () => {
    try {
      const { captureInvocationFriction } = await import('./harness/improvements/invocation-friction');
      for (const input of inputs) {
        try {
          await captureInvocationFriction(input);
        } catch (err) {
          frictionState.errors++;
          console.warn(`[projected-tool-deps] friction capture failed for invocation ${input.id}; invocation retained: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      frictionState.errors += inputs.length;
      console.warn(`[projected-tool-deps] friction consumer unavailable; invocations retained: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      frictionState.pending = 0;
    }
  })());
}

async function emitTelemetryInsertErrorToast(err: unknown): Promise<void> {
  try {
    const tl = generated.toastLogInHarnessShared;
    const { db } = getOrgPg();
    await db.insert(tl).values({
      level: 'error',
      message: 'Telemetry insert errors detected',
      description:
        'The deferred tool-invocation telemetry writer just swallowed its first insert error. dev:service_health now reports telemetry.insertErrorCount and telemetry.lastInsertErrorAt; dashboards may under-report fleet activity until this is fixed. First error: ' +
        (err instanceof Error ? err.message : String(err)),
      harnessSlug: null,
      createdAt: Date.now(),
      actionLabel: null,
      actionHref: null,
    });
    const { notifySyncInvalidate } = await import('./sync-sse');
    void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
  } catch {
    // Telemetry health notifications are best-effort and must never break the
    // already best-effort telemetry flush path.
  }
}

function recordTelemetryInsertError(err: unknown): void {
  telemetryInsertErrorCount++;
  telemetryLastInsertErrorAt = new Date().toISOString();
  if (!telemetryInsertErrorToastSent) {
    telemetryInsertErrorToastSent = true;
    void emitTelemetryInsertErrorToast(err);
  }
}

function scheduleTelemetryFlush(): void {
  if (telemetryFlushTimer || telemetryFlushInFlight) return;
  telemetryFlushTimer = setTimeout(() => {
    telemetryFlushTimer = null;
    void flushPendingTelemetry();
  }, telemetryBufferConfig().debounceMs);
  // Never keep the event loop alive just for a pending telemetry flush.
  (telemetryFlushTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Drain the deferred telemetry queue, writing it in batched per-workspace
 * transactions. Best-effort: a failed batch is logged and dropped (matching the
 * pre-defer swallow). Re-entrant-safe — a single in-flight flush; a concurrent
 * caller awaits it. Exported so quota reads + telemetry consumers can force
 * synchronous visibility.
 */
export async function flushPendingTelemetry(): Promise<void> {
  if (telemetryFlushInFlight) return telemetryFlushInFlight;
  if (telemetryQueue.length === 0) return;
  const run = (async () => {
    try {
      const { sql } = getOrgPg();
      while (telemetryQueue.length > 0) {
        const batch = telemetryQueue.splice(0, telemetryBufferConfig().maxBatch);
        // Group by workspace — RLS needs one set_config('app.workspace_id') per tx.
        const byWorkspace = new Map<string, TelemetryRow[]>();
        for (const row of batch) {
          const list = byWorkspace.get(row.workspaceId);
          if (list) list.push(row);
          else byWorkspace.set(row.workspaceId, [row]);
        }
        for (const [workspaceId, rows] of byWorkspace) {
          try {
            await sql.begin(async (tx) => {
              await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
              for (const row of rows) {
                // `TelemetryRow.params` is `unknown[]` (each row's values are snapshotted
                // generically at capture time); `tx.unsafe`'s param array type doesn't
                // sufficiently overlap with `unknown[]` for a direct cast, so go through
                // `unknown` first — derived from `tx` itself so this file need not import
                // postgres.js's ParameterOrJSON type.
                const inserted = await tx.unsafe<{ id: string }[]>(TELEMETRY_INSERT_SQL, row.params as unknown as Parameters<typeof tx.unsafe>[1]);
                if (row.friction && inserted?.[0]) row.friction.id = inserted[0].id;
              }
            });
          } catch (err) {
            recordTelemetryInsertError(err);
            console.warn(
              `[projected-tool-deps] telemetry flush batch failed (${rows.length} rows): ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          // Quota/spill readers await this flush too. Capture must not join
          // their response path, including when an earlier capture is stalled.
          captureCommittedFriction(rows);
        }
      }
    } finally {
      telemetryFlushInFlight = null;
    }
  })();
  telemetryFlushInFlight = run;
  return run;
}

/**
 * EI-19389431406847252: `output_ref` is NULL on every `tool_invocations` row
 * (324,661/324,661 measured over 36h) even for calls that demonstrably
 * SPILLED a result to scratch — because the door's own spill decision
 * (result-door.ts's `applyResultDoor`) happens in `_mcp-handler.ts`'s
 * `execute()`, strictly AFTER `runDispatchStack`'s `finally` has already
 * snapshotted + queued this call's telemetry row (recordTelemetry runs deep
 * inside the generic dispatch stack shared by every consumer — capabilities/
 * invoke, tools:invoke's inner re-dispatch, IPC — none of which should be
 * doored, so the door cannot move earlier without dooring paths it must not
 * touch). By the time the caller learns a spill happened, the row already
 * exists (queued, often already flushed).
 *
 * This BACKFILLS output_ref/output_size onto that already-written row via a
 * best-effort correlated UPDATE, rather than inserting a second row (which
 * would double-count `status='ok'` quota) or threading a per-row telemetry
 * handle through five generic layers.
 *
 * Correlation is deliberately NOT a hard foreign key — there is no per-call
 * nonce carried into `metadata_json` (adding one is a bigger, separate change).
 * It matches (workspace_id, spawn_id, tool_name, output_ref IS NULL, most
 * recent invoked_at) inside a short recency window, plus run_id when the
 * caller has one. For loopback SU/power-user sessions `runId` is minted FRESH
 * per MCP request (see ctx construction in _mcp-handler.ts — "Per-request
 * UUID, not the 'standalone' sentinel"), so that additional predicate makes
 * the match effectively exact for that traffic; for signed role-scoped/bee
 * spawns `run_id` is stable for the whole spawn and narrows nothing extra, so
 * two back-to-back calls of the SAME tool from the SAME spawn inside the
 * recency window could in principle backfill the wrong one of the pair. Good
 * enough for the stated purpose (spill-rate / paged-rate analytics in one
 * query instead of a two-source forensic reconstruction) — not a substitute
 * for an exact key.
 *
 * flushPendingTelemetry() first: the row this spill belongs to may still be
 * sitting in the in-memory queue (debounceMs default 10ms) — the UPDATE below
 * only sees committed rows. Best-effort throughout: any failure is logged and
 * swallowed, exactly like the rest of this file's telemetry writes.
 */
export async function backfillResultDoorOutputRef(input: {
  workspaceId: string | null | undefined;
  spawnId: string | null | undefined;
  toolName: string;
  runId?: string | null;
  outputRef?: string | null;
  outputSize?: number | null;
  /** Door-only facts unavailable when the dispatcher snapshots the row. Shallow
   * merged so handler-authored run metadata is preserved. */
  metadataJson?: Record<string, unknown>;
}): Promise<void> {
  // Captured into locals so the narrowing survives into the `sql.begin`
  // closure below — TS does not narrow a property access (`input.workspaceId`)
  // across a function boundary (same pattern as readQuotaStateImpl above).
  const workspaceId = input.workspaceId;
  const spawnId = input.spawnId;
  if (!workspaceId || !spawnId) return;
  if (!input.outputRef && !input.metadataJson) return;
  const toolName = input.toolName;
  const runId = input.runId ?? null;
  try {
    // Force the just-queued row to be durable before we try to UPDATE it.
    await flushPendingTelemetry();
    const { sql } = getOrgPg();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      await tx.unsafe(
        `UPDATE harness_shared.tool_invocations
            SET output_ref = COALESCE($1, output_ref),
                output_size = COALESCE($2, output_size),
                metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb
          WHERE id = (
            SELECT id FROM harness_shared.tool_invocations
             WHERE workspace_id = $4 AND spawn_id = $5 AND tool_name = $6
               AND ($1::text IS NULL OR output_ref IS NULL)
               AND invoked_at >= now() - interval '30 seconds'
               AND ($7::text IS NULL OR run_id = $7)
             ORDER BY invoked_at DESC
             LIMIT 1
          )`,
        [
          input.outputRef ?? null,
          input.outputSize ?? null,
          jsonbSafeStringify(input.metadataJson ?? {}),
          workspaceId,
          spawnId,
          toolName,
          runId,
        ],
      );
    });
  } catch (err) {
    console.warn(
      `[projected-tool-deps] backfillResultDoorOutputRef failed for ${input.toolName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * True when the dispatch refusal carried a ready-to-send corrected call
 * (`metadata.invalidInput.correctedCall`, written by the projected-tool-registry
 * validator). The caller already holds the fix, so the refusal is not auto-filed
 * as friction (review-system-rework-reduction-2026-09-23 D-010).
 */
export function refusalReturnedCorrectedCall(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const invalidInput = (metadata as { invalidInput?: unknown }).invalidInput;
  if (!invalidInput || typeof invalidInput !== 'object') return false;
  const corrected = (invalidInput as { correctedCall?: unknown }).correctedCall;
  return !!corrected && typeof corrected === 'object';
}

/**
 * Build the tool_invocations row params snapshot for one settled dispatch.
 * Synchronous + cheap (JSON.stringify of args); null when there is no workspace
 * to scope to. Pulls Principal audit fields off ctx.principal when present
 * (only the bearer/MCP path populates a real Principal; migration 076 made the
 * columns nullable so legacy gaps surface as NULL/'unknown' in /dev).
 */
function buildTelemetryRow(input: RecordInvocationInput): TelemetryRow | null {
  if (!input.ctx.workspaceId) return null;
  const harnessSlug = input.ctx.harnessSlug ?? '';
  if (
    isUnresolvedTelemetryScopePlaceholder(input.ctx.workspaceId) ||
    isUnresolvedTelemetryScopePlaceholder(harnessSlug)
  ) {
    // There is no safe normalization: guessing a tenant would be worse than
    // dropping best-effort telemetry. Warn once so the producing boundary is
    // diagnosable without turning a bad launcher into a log storm.
    if (!telemetryScopeRejectionWarned) {
      telemetryScopeRejectionWarned = true;
      console.warn(
        '[projected-tool-deps] refusing telemetry row with an unresolved workspace or harness scope placeholder',
      );
    }
    return null;
  }
  const p = (input.ctx.principal ?? null) as null | {
    kind?: string;
    authMethod?: string;
    trust?: string;
  };
  const argsJson = (() => {
    if (input.args === undefined || input.args === null) return null;
    try {
      const s = jsonbSafeStringify(input.args);
      if (s.length > 32768) {
        return JSON.stringify({ _truncated: true, _size: s.length });
      }
      return s;
    } catch {
      return null;
    }
  })();
  // Audit host provenance into metadata_json. Reactions answer "why did this
  // fire?"; requestOrigin answers "which loopback client surface sent this?"
  // for unattributed MCP calls that otherwise collapse to coord_owner_id
  // "loopback".
  const metadataJson = (() => {
    const reaction = input.ctx.reactionCause;
    const requestOrigin = input.ctx.requestOrigin;
    const kernel =
      input.executionRevision || input.kernelPreflight || input.kernelEnforcement
        ? {
            ...(input.executionRevision ? { executionRevision: input.executionRevision } : {}),
            ...(input.kernelPreflight ? { preflight: input.kernelPreflight } : {}),
            ...(input.kernelEnforcement ? { enforce: input.kernelEnforcement } : {}),
          }
        : null;
    const meta =
      input.metadataJson || reaction || requestOrigin || kernel
        ? {
            ...(input.metadataJson ?? {}),
            ...(requestOrigin ? { requestOrigin } : {}),
            ...(reaction ? { reaction } : {}),
            // Framework-owned kernel fields are applied after handler metadata
            // so a tool cannot spoof what revision actually ran.
            ...(kernel ? { kernel } : {}),
          }
        : null;
    return meta ? jsonbSafeStringify(meta) : null;
  })();
  // WI-1279: stamp the calling agent's coordination owner id so dev:sessions can
  // attribute/group a session by its agent (su-… interactive SU, the bee's s-…
  // spawn id, pus-… power-user). resolveAgentIdentity THROWS on an unattributable
  // ctx; telemetry is best-effort, so a throw → NULL (never breaks a tool call).
  let coordOwnerId: string | null = null;
  try {
    coordOwnerId = resolveAgentIdentity(input.ctx).ownerId ?? null;
  } catch {
    coordOwnerId = null;
  }
  const stamp = readAgentStateStamp(coordOwnerId);
  // EI-20267598379696870: WHO CHOSE this call — the model, or per-turn hook automation? Every
  // other provenance column on this table is identical for both populations, and hook traffic is
  // ~74% of it (measured 2026-08-12), so without this an agent-behavior metric reads mostly
  // automation — and directionally, since hooks emit only coordination verbs. `source` says
  // whether the caller DECLARED it or we inferred it, so a wrong guess is never mistakable for a
  // known fact. Pure + inline; see lib/telemetry-call-origin.ts.
  const callOrigin = classifyCallOrigin({
    requestOrigin: input.ctx.requestOrigin,
    spawnId: input.ctx.spawnId,
  });
  const servingHost = getServingHostIdentity();
  const invokedAt = new Date().toISOString();
  const deliveryMetadata = metadataJson ? JSON.parse(metadataJson) : {};
  // D-010 (review-system-rework-reduction-2026-09-23): a refusal that already
  // handed the caller its corrected call is not a defect worth a tracker row.
  // The call is still recorded below, and the repeated-tool-error watchdog still
  // reads it from this ledger, so recurring misuse of an affordance stays visible.
  const friction: InvocationFrictionRef | undefined =
    coordOwnerId && ['error', 'invalid-input', 'timeout'].includes(input.status) &&
    !/^(improvements:|system:improvement-)/.test(input.toolName) &&
    !refusalReturnedCorrectedCall(deliveryMetadata)
      ? {
          workspaceId: input.ctx.workspaceId, id: '',
        }
      : undefined;
  delete deliveryMetadata.frictionCapture;
  delete deliveryMetadata.frictionAttemptAt;
  if (friction) deliveryMetadata.frictionCapture = 'pending';
  return {
    workspaceId: input.ctx.workspaceId,
    ...(friction ? { friction } : {}),
    params: [
      input.ctx.workspaceId,
      harnessSlug,
      input.pluginName,
      input.toolName,
      input.ctx.role ?? '',
      input.ctx.featureId ?? null,
      input.ctx.chunkId ?? null,
      input.ctx.runId ?? null,
      input.ctx.spawnId ?? '',
      input.ctx.parentSpawnId ?? null,
      input.windowKey,
      input.durationMs,
      input.status,
      input.outputRef ?? null,
      input.outputSize ?? null,
      input.errorMessage ?? null,
      argsJson,
      // ctx.transport set by HTTP / MCP / IPC adapters. NULL for
      // direct-handler-call shims (the route shim path) where no transport is
      // actually involved at dispatch time.
      input.ctx.transport ?? null,
      input.eventCount ?? null,
      // Framework-owned marker overrides handler metadata. Pending delivery
      // survives skipped batches, failed capture and process restarts.
      Object.keys(deliveryMetadata).length ? jsonbSafeStringify(deliveryMetadata) : null,
      p?.kind ?? null,
      p?.authMethod ?? null,
      p?.trust ?? null,
      input.errorCode ?? null,
      coordOwnerId,
      // invoked_at (EI-7040): the dispatch-settle wall-clock, NOT the flush
      // time — see the note on TELEMETRY_INSERT_SQL.
      invokedAt,
      // P-009 / D-011 / D-014: the caller's DECLARED STATE at call time — the
      // intent it declared, the assumption watermark it had reached, and the
      // goal it holds. ONE Map.get off `coordOwnerId` (lib/agent-state-stamp);
      // no query, no computation, and a miss yields nulls rather than blocking.
      // Reuses the identity already resolved above, so an unattributable ctx
      // (coordOwnerId null) simply stamps three NULLs like it stamps no owner.
      stamp.intentEventId,
      stamp.assumptionSetId,
      stamp.goalRef,
      callOrigin.origin,
      callOrigin.source,
      // WI-1565914: WHICH HOST PROCESS served this call, and what code it had
      // loaded. Every other column here describes the CALLER; without these, a
      // behavioural difference between two concurrently-running hosts is
      // invisible, and `spawn_id` cannot stand in — it is a label, not a process
      // (all 490 subscription-driven pot:wake rows carry the literal
      // 'event-reaction'). Three process CONSTANTS off one cached read; a null
      // serving_build_sha means the loaded bytes are UNPROVEN and is never
      // backfilled with the checkout's HEAD. See lib/serving-host-identity.ts.
      servingHost.host,
      servingHost.processId,
      servingHost.buildSha,
    ],
  };
}

/**
 * EI-2112 — read-shaped board polls from the loopback command-palette bridge are
 * UI refresh, not agent activity, and must NOT be telemetered.
 *
 * `lib/capabilities/invoke.ts` stamps `ctx.spawnId='palette'` for every desktop
 * command-palette / dock invoke. The dock's wake-board pane POLLS a couple of
 * read-only coord board tools on a refresh tick; each poll wrote one
 * `harness_shared.tool_invocations` row, and together `coord:wake-queue{list}` +
 * `coord:wake-mode` (read) were ~817K rows/24h = 74.5% of the WHOLE telemetry
 * table (polled ~6.6×/sec, 24/7). The table is meant to reflect AGENT tool calls,
 * so those UI poll-reads are dropped at the sink.
 *
 * The predicate keys on the READ shape of each tool's args (`coord:wake-queue` is
 * read when `action` is absent or `list`; `coord:wake-mode` is read when `mode` is
 * absent). Scoped tight so it never hides real activity:
 *   - only the palette bridge identity (`spawn_id='palette'`) — a real agent spawn
 *     reading the board IS activity and still records;
 *   - only the READ shape — a palette ACTION through the same tool (a wake
 *     release/skip, a wake-mode set, …) is not read-shaped and still records, so
 *     the human-initiated audit trail is intact.
 *
 * Add a tool here only when it is BOTH (a) polled by a palette/dock UI surface on
 * a tick and (b) cleanly read-vs-write separable by args. Pure + exported for
 * unit tests.
 */
const PALETTE_POLL_READ_TOOLS: Record<string, (args: Record<string, unknown>) => boolean> = {
  // Wake-board snapshot: `list` (the default action) is the read; release / skip /
  // release_all / skip_all mutate and must stay audited.
  'coord:wake-queue': (a) => a.action === undefined || a.action === 'list',
  // Wake-mode: a read omits `mode` (a set carries one); agent absent = the GLOBAL
  // default read the board polls.
  'coord:wake-mode': (a) => a.mode === undefined,
};

export function isPaletteUiPollRead(input: {
  toolName: string;
  ctx: Pick<UnifiedToolContext, 'spawnId'>;
  args?: unknown;
}): boolean {
  if (input.ctx.spawnId !== 'palette') return false;
  const isRead = PALETTE_POLL_READ_TOOLS[input.toolName];
  if (!isRead) return false;
  const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>;
  return isRead(args);
}

async function recordInvocationImpl(input: RecordInvocationInput): Promise<void> {
  // Close this call's in-flight entry FIRST — before every early return below.
  // Placement is load-bearing: the palette-poll drop and the buildTelemetryRow bail
  // both `return` without writing a row, and settling after either of them would
  // leak an entry that then reports as a call still running. A leaked entry is worse
  // than a missing one, because it actively asserts work that is not happening.
  endInFlightCall(input.callId);
  // Keep the settle-time beat as a fallback for transport failures that happen
  // before the generic dispatcher can initialize its execution state and invoke
  // onDispatchStart. The shared throttle makes the normal start + settle pair
  // cheap while preserving the pre-dispatch liveness path.
  maybeBeatPresenceOnDispatch(input.ctx);
  // EI-2112: a pure UI poll-READ from the command-palette bridge (the desktop
  // dock's wake-board refresh tick, spawn_id='palette') is UI refresh, not agent
  // activity — it was 74.5% of the whole tool_invocations table. Drop it from
  // telemetry AFTER the presence beat (the dock surface still proves liveness);
  // the palette's mutating ACTIONS through the same tools are not read-shaped and
  // still record.
  if (isPaletteUiPollRead(input)) return;
  // Coverage-census attribution (plan deterministic-coverage-census-2026-08-17, P-004).
  // Inert unless PAPERCUSP_TEST_ATTRIBUTION=1. This is the single sink EVERY settled
  // `tools/call` reaches — including the replay branch — and `input.toolName` is the same
  // identity `providers/mcp-tools.ts` enumerates from the live catalog, so the observer and
  // the census name surfaces identically. Placed AFTER the palette-poll drop on purpose: a
  // dock UI refresh is not a test exercising a tool, and counting it as coverage would credit
  // a surface no test touches.
  try {
    recordMcpTraffic({ toolName: input.toolName, status: input.status });
  } catch {
    /* attribution is best-effort — never let it break a dispatch */
  }
  // P-003: snapshot the row synchronously, then enqueue + return. The actual PG
  // INSERT happens in a batched background flush, OFF the dispatcher's awaited
  // hot path.
  const row = buildTelemetryRow(input);
  if (!row) return;
  telemetryQueue.push(row);
  const maxPending = telemetryBufferConfig().maxPending;
  if (telemetryQueue.length > maxPending) {
    // Producer outran the PG writer (stall/backpressure) — shed oldest to keep
    // memory bounded. Telemetry is best-effort; a dropped row is acceptable.
    const dropped = telemetryQueue.length - maxPending;
    telemetryQueue.splice(0, dropped);
    telemetryDropped += dropped;
    if (telemetryDropped === dropped || telemetryDropped % 1000 === 0) {
      console.warn(`[projected-tool-deps] telemetry queue overflow — dropped ${telemetryDropped} row(s)`);
    }
  }
  scheduleTelemetryFlush();
}

/**
 * Capability-envelope port impl (agent-capability-confinement-2026-06-13 B-06 / P-012).
 * Runs the cheap, static, per-role evaluator; only on a beyond-envelope hit does it read
 * the enforce flag, so the within-envelope hot path stays pure-sync. Exempt callers
 * (SU / power-user / non-fleet / roleless) → null (the dispatch step no-ops). Enforce vs
 * observe is the CAPABILITY_ENVELOPE flag (default OFF ⇒ observe/shadow: annotate + log,
 * never block).
 */
async function checkCapabilityEnvelopeImpl(input: {
  toolName: string;
  capabilities: readonly string[];
  ctx: UnifiedToolContext;
  args: unknown;
}): Promise<CapabilityEnvelopeVerdict | null> {
  // P-003 / D-015 (directed-pair): the launch-declared SESSION confinement runs FIRST and is
  // deliberately NOT subject to the exemptions below it. evaluateCapabilityEnvelope returns
  // early on isSuperuser||isPowerUser before it even reads the role, so a role envelope cannot
  // bind a directed implementer — which must be su-tier because coord:* is identity-gated.
  // This gate is a self-imposed narrowing declared by the LAUNCHER, not a privilege ceiling,
  // so privilege is irrelevant to it. It is inert (null) for any session with no declared
  // confinement, i.e. every session until a paired fleet launches one.
  const confined = await checkSessionConfinement({ toolName: input.toolName, ctx: input.ctx });
  if (confined) return confined;

  // WI-2140596: AUDIT mode's read-only-toward-subject clause, mechanically. Same seat and
  // same reasoning as checkSessionConfinement above — this must run BEFORE the SU/power-user
  // exemption below (evaluateCapabilityEnvelope exempts isSuperuser||isPowerUser before it
  // even reads role), because the whole point is binding an su-tier session's own declared
  // AUDIT contract, not just a fleet role's envelope.
  const auditBlocked = await checkAuditModeMutationGuard({ toolName: input.toolName, ctx: input.ctx });
  if (auditBlocked) return auditBlocked;

  // P-009 (D-010): merge the runtime per-role overrides OVER the baked ROLE_ENVELOPES (per-role
  // replace) and union the tighten-only protected-floor additions. Both getters are SYNC and
  // return empty unless papercusp-capability-envelope-overrides is ON ⇒ off = byte-identical.
  const roleOverrides = envelopeRoleOverrides();
  const protectedAdditions = envelopeProtectedAdditions();
  const decision = evaluateCapabilityEnvelope({
    toolName: input.toolName,
    capabilities: input.capabilities,
    ctx: input.ctx,
    envelopes: Object.keys(roleOverrides).length > 0 ? { ...ROLE_ENVELOPES, ...roleOverrides } : undefined,
    protectedAdditions: protectedAdditions.length > 0 ? protectedAdditions : undefined,
  });
  if (!decision.applied) return null; // exempt — no verdict; ledger records posture 'auto'
  if (decision.withinEnvelope) return { decision: 'allow', posture: 'auto', applied: true };
  const enforce = await getFlag(FLAGS.CAPABILITY_ENVELOPE, 'system');
  return enforce
    ? {
        decision: 'deny',
        posture: 'rejected',
        applied: true,
        reason: decision.reason,
      }
    : {
        decision: 'observe',
        posture: 'gated',
        applied: true,
        reason: decision.reason,
      };
}

/**
 * Per-call override lookup. The llm-testing framework registers a
 * `ToolDispatchOverride` for a runId via lib/llm-testing/dispatch-override.
 * Here we connect the dispatcher to that registry: parse ctx.uiClientId
 * for the `llm-testing/<runId>` prefix and consult the registry by
 * runId. Anything else passes through.
 *
 * The override fires for EVERY dispatch under a tagged ctx — including
 * nested tool calls the brain makes during operator:converse — because
 * the dispatcher's uiClientId auto-fill (Phase 0) propagates the tag.
 *
 * Plan §10.4.
 */
const overrideToolImpl: ToolDispatchOverrideFn = async (toolName, args, ctx) => {
  const uic = ctx.uiClientId;
  if (typeof uic === 'string' && uic.startsWith('llm-testing/')) {
    const runId = uic.slice('llm-testing/'.length);
    const override = getOverride(runId);
    if (!override) return PASS_THROUGH;
    const result = await override.override(toolName, args);
    // `@papercusp/testing-shell`'s ToolDispatchOverride and `@papercusp/agent-mcp`'s
    // ToolDispatchOverrideFn each define their OWN `Symbol('PASS_THROUGH')` sentinel —
    // two distinct `unique symbol` values (a real bug the typecheck caught, not just a
    // type annoyance: dispatch-stack.ts's invokeStep compares the override's return
    // against the tooldef PASS_THROUGH via `!==`, so testing-shell's sentinel passing
    // through UNTRANSLATED would fail that comparison and be rendered as a bogus
    // ToolResult instead of falling through to the real handler). Translate at this
    // boundary so both packages can keep their own symbol without a new cross-package
    // dependency.
    return result === TESTING_SHELL_PASS_THROUGH ? PASS_THROUGH : result;
  }

  // WI-939561: the GOAL kickoff is an evidence-backed dispatch precondition,
  // not another instruction each create/launch door must remember to repeat.
  // This override runs after role/capability/authorize gates and before the
  // handler, at the ONE chokepoint shared by MCP, HTTP, IPC and tools:invoke's
  // inner re-dispatch. Ordinary callers and goal-descendant implementers have no
  // active mode='goal' row and pass through unchanged.
  if (isGoalKickoffGuardedTool(toolName, args)) {
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*'
        ? ctx.workspaceId
        : ctx.principal?.workspaceId && ctx.principal.workspaceId !== '*'
          ? ctx.principal.workspaceId
          : null;
    let ownerId: string | null = null;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId ?? null;
    } catch {
      // An unattributable principal cannot own an agent_modes row. Preserve the
      // pre-existing handler behavior (some owner/UI calls are intentionally
      // principal-only) instead of turning an identity gap into a global write
      // outage.
    }

    if (workspaceId && ownerId) {
      const evidence = await readGoalKickoffEvidence({
        workspaceId,
        ownerId,
        flushTelemetry: flushPendingTelemetry,
      });
      if (evidence.applies && !evidence.complete) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(goalKickoffRefusalPayload(toolName, evidence)),
            },
          ],
          isError: true,
        };
      }
      if (evidence.degradedReason) {
        // The mode read failed before applicability could be established. The
        // helper deliberately fails open for ordinary callers; keep the gap
        // visible rather than silently pretending the gate ran.
        console.warn(`[goal-kickoff-gate] ${evidence.degradedReason}`);
      }
    }
  }

  return PASS_THROUGH;
};

/** Shared deps singleton. Same object reference is safe to pass to
 *  multiple dispatchers — the impls are stateless. */
export const PROJECTED_DEPS: DispatchProjectedDeps = {
  // D-030 kernel seat: the generic dispatcher invokes this before any
  // decorators and immediately before handler execution. The resolver is
  // replaceable by the activation/control owner without changing the shared
  // transport adapter.
  kernelEnforcement: operatorKernelEnforcement,
  kernelPolicy: operatorKernelEnforcement,
  authorizationFailureHint,
  // Turn-level presence beat (liveness-hardening P-001): mark activity as soon
  // as a projected dispatch starts, so a long-running handler remains visible
  // while it is still in flight rather than only after settlement.
  onDispatchStart: ({ ctx, toolName, callId }) => {
    maybeBeatPresenceOnDispatch(ctx);
    // Open an in-flight entry so "is this agent executing right now?" is answerable
    // WHILE the handler runs, not only after it settles (EI-21548894457555139). The
    // presence beat above proves the agent is alive; it cannot say what it is doing,
    // which is why an idle member and one 20 minutes into a long call read alike.
    if (!callId) return;
    let ownerId: string | null = null;
    try {
      // Same resolution the telemetry row uses. THROWS on an unattributable ctx, so
      // it is guarded here exactly as it is there — an unattributed call still gets a
      // registry entry, just without an owner to group it under.
      ownerId = resolveAgentIdentity(ctx).ownerId ?? null;
    } catch {
      ownerId = null;
    }
    try {
      beginInFlightCall({ callId, toolName, ownerId, spawnId: ctx.spawnId ?? null });
    } catch {
      // The dispatcher swallows throws from this hook, but keep the failure contained
      // here too: a liveness marker must never be able to change a tool result.
    }
  },
  // Papercusp quota windowing: workers→chunk/perChunk, power-user→session,
  // everyone else→run/perRun (plan P-011, formerly baked in the engine).
  // P-018: a runtime per-(tool,role) override (quota:set_tool) is MERGED over the baked
  // rolesQuota[role] before the window/ceiling is resolved — empty override map ⇒ byte-identical.
  computeQuotaWindow: (ctx, roleQuota, toolName, input) =>
    papercuspComputeQuotaWindow(ctx, toolName ? mergeRoleQuota(roleQuota, toolName, ctx.role) : roleQuota, toolName, input),
  readQuotaState: readQuotaStateImpl,
  recordInvocation: recordInvocationImpl,
  overrideTool: overrideToolImpl,
  // Capability-envelope port (agent-capability-confinement B-06 / P-012). Evaluates the
  // cheap per-role envelope at the dispatch chokepoint; SU/non-fleet callers are exempt
  // (D-002). Enforce-vs-observe is the CAPABILITY_ENVELOPE flag (default OFF ⇒ shadow).
  checkCapabilityEnvelope: checkCapabilityEnvelopeImpl,
  // Event-reaction observation point (event-reaction-system D-001). Fires after
  // every tool settles; the host engine matches rules + schedules reactions.
  // Best-effort + non-blocking — swallow throws so a reaction never breaks its
  // trigger. The handler is installed by `lib/events` at startup.
  postInvoke: (event) => {
    // EI-6139: this is the one shared point where every transport's settled
    // result, canonical tool name, argument shape, and attributable agent meet.
    // The observer is synchronous/process-local and records no argument values;
    // the heavier insight/recipe lookup is deferred until mid-turn delivery
    // drains a third-failure signal.
    try {
      const ownerId = resolveAgentIdentity(event.ctx).ownerId;
      const callOrigin = classifyCallOrigin({
        requestOrigin: event.ctx.requestOrigin,
        spawnId: event.ctx.spawnId,
      });
      // Hook-owned dispatches are framework automation, not model retries. The
      // declaration is required here: inferred hook classifications remain
      // visible to the detector until their caller proves the provenance.
      if (!(callOrigin.origin === 'hook' && callOrigin.source === 'declared')) {
        observeFailureLoop({
          ownerId,
          detectorSessionKey: event.ctx.failureLoopSessionKey,
          toolName: event.toolName,
          args: event.args,
          result: event.result,
        });
      }
    } catch {
      // Identity gaps and detector faults must never break the triggering tool.
    }
    try {
      reactionPostInvoke?.(event);
    } catch {
      // a reaction must never break its trigger
    }
    // Decision-ledger action-chokepoint emit (agent-capability-confinement B-06 / P-011 ⨯
    // queen-autonomy D-012). Fire-and-forget; recordDecisionLedger swallows its own errors,
    // but guard anyway so the ledger can never break its trigger.
    try {
      recordDecisionLedger(event);
    } catch {
      // the ledger must never break its trigger
    }
  },
  // RFC tooldef-auth Phase 1b: persist every authorize allow/deny + policy bypass.
  auditAuth: (event) => {
    void recordToolAuthzEvent(event);
  },
  // Precondition auto-correct fire port (`requires:` — D-006). AWAITED by the
  // dispatcher's `preconditions` step; a throw (incl. "not installed") rejects
  // the trigger fail-closed. Installed by `lib/events` at startup.
  firePrecondition: async (req) => {
    if (!preconditionFire) {
      throw new Error('precondition fire port not installed (lib/events not loaded)');
    }
    await preconditionFire(req);
  },
  // RFC tooldef-auth Phase 3 (D1): default-deny ON. Audited 2026-05-31 — every built-in
  // is type-certain gated (defineTool requires `capability`; defineUITool routes through
  // it) and every bundled plugin tool declares capabilities + roles. So this denies
  // nothing currently registered. Its purpose is the fail-closed floor for a FUTURE /
  // third-party tool that forgets to declare a gate: it gets a loud `ungated` 403 (not
  // silent), telling the author to declare a capability/roles/requireRoles/authorize — or
  // mark the tool `public`. To re-verify before/after adding plugins: run
  // listUngatedProjectedTools() against the live registry (empty = clean). Reversible:
  // set false to revert to allow-by-omission.
  defaultDeny: true,
};
