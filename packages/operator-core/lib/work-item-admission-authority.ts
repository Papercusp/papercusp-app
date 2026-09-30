/** Transport-authenticated identity for original-item recovery. No saved grants or bearers. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { appliedExecutionRevision, lookupByMcpName, papercuspGateBypass, sameKernelRevision, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { preflightDispatchStack } from '@papercusp/tooldef';
import { decodeOperatorSecretKey } from './operator-secret-key';
import { readSuperuserToken } from './superuser-token';
import { synthesizeDispatchPrincipal } from './endpoint-route/routes/transport/role-principal-caps';
import { resolveConcreteHarnessSlug } from './agent-tools/_harness-scope';
import { runWithWorkspaceIfConcrete } from './workspace-als';
import type { AdmissionRecoveryScope } from './work-item-admission-recovery';

const admissionContextSchema = z.object({
  workspaceId: z.string().min(1), harnessSlug: z.string().min(1),
  profile: z.enum(['engineer', 'power']),
  runId: z.string().min(1), spawnId: z.string().min(1),
  parentSpawnId: z.string().nullable(), chunkId: z.string().nullable(),
  featureId: z.string().nullable(), planRunSessionId: z.string().nullable(),
  transport: z.literal('mcp'),
  codeMode: z.boolean().optional(),
}).strict();
export const admissionAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('superuser'), credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.string().min(1), context: admissionContextSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('signed-spawn'), credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.string().min(1), expiresAtSec: z.number().finite().nonnegative(),
    context: admissionContextSchema.optional(),
  }).strict(),
]);
export type AdmissionRecoveryAuthority = z.infer<typeof admissionAuthoritySchema>;
/** Private context field set ONLY at successful transport authentication. Never a tool arg. */
export type AdmissionAuthorityContext = { admissionRecoveryAuthority?: AdmissionRecoveryAuthority };
export const admissionCredentialDigest = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

export class AdmissionAuthorityRefused extends Error {}

/** Called on the authenticated dispatch context, never on caller-supplied args. */
export function bindAdmissionAuthority(
  ctx: UnifiedToolContext & AdmissionAuthorityContext,
): AdmissionRecoveryAuthority | undefined {
  if (!ctx.admissionRecoveryAuthority) return undefined;
  // The final dispatcher stamps its verified applied revision on the handler.
  // That observation is renewable through the current control anchor, and is
  // deliberately NOT persisted as a grant or replayed as today's applied state.
  // An unverified input snapshot still cannot be silently dropped.
  const applied = appliedExecutionRevision(ctx.kernelEnforcement, 'enforce');
  const verifiedAppliedStamp = Boolean(ctx.kernelEnforcement?.decision === 'allow' &&
    ctx.kernelEnforcement.applied === true && applied && ctx.executionRevision &&
    sameKernelRevision(applied, ctx.executionRevision) && ctx.appliedExecutionRevision &&
    sameKernelRevision(applied, ctx.appliedExecutionRevision));
  if (ctx.kernelState || ctx.kernelOwnership || ctx.kernelBoundary || ctx.dispatchBoundary ||
      ctx.requestedExecutionRevision || (ctx.appliedExecutionRevision && !verifiedAppliedStamp) || ctx.reactionCause ||
      ctx.telemetrySurface) {
    throw new AdmissionAuthorityRefused('explicit kernel/reaction dispatch context is not renewable for admission recovery');
  }
  const harnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
  if (!harnessSlug) return undefined;
  const bound = admissionAuthoritySchema.safeParse({
    ...ctx.admissionRecoveryAuthority,
    context: {
      workspaceId: ctx.workspaceId, harnessSlug,
      profile: ctx.profile ?? 'engineer', runId: ctx.runId, spawnId: ctx.spawnId,
      parentSpawnId: ctx.parentSpawnId ?? null, chunkId: ctx.chunkId ?? null,
      featureId: ctx.featureId ?? null, planRunSessionId: ctx.planRunSessionId ?? null,
      transport: ctx.transport, ...(ctx.codeMode !== undefined ? { codeMode: ctx.codeMode } : {}),
    },
  });
  if (!bound.success) throw new AdmissionAuthorityRefused('original authenticated dispatch context is incomplete');
  return bound.data;
}

/**
 * Renew the ORIGINAL authenticated credential, then rebuild CURRENT grants. A role
 * label in presence, isSuperuser alone, and a saved gateBypass are not credentials.
 * Power-user/PI and legacy requests have no renewable proof here and fail closed.
 */
export async function admissionReplayContext(
  sql: Sql, scope: AdmissionRecoveryScope, caller: string, value: unknown,
): Promise<UnifiedToolContext> {
  const parsed = admissionAuthoritySchema.safeParse(value);
  if (!parsed.success) throw new AdmissionAuthorityRefused('authenticated recovery binding missing; retry this same item through its authenticated dispatch door');
  const authority = parsed.data;
  if (!authority.context) throw new AdmissionAuthorityRefused('original dispatch context missing; renew this same item through authenticated dispatch');
  if (authority.context.workspaceId !== scope.workspaceId) {
    throw new AdmissionAuthorityRefused('original dispatch workspace does not match the recovery workspace');
  }
  const isSuperuser = authority.kind === 'superuser';
  if (isSuperuser) {
    const token = readSuperuserToken();
    if (!token || admissionCredentialDigest(token) !== authority.credentialSha256) {
      throw new AdmissionAuthorityRefused('original superuser credential was revoked or rotated');
    }
  } else {
    if (authority.expiresAtSec !== 0 && authority.expiresAtSec < Math.floor(Date.now() / 1000)) {
      throw new AdmissionAuthorityRefused('original signed-spawn credential expired');
    }
    const [key] = await sql<{ value_b64: string }[]>`
      SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key'`;
    if (!key || admissionCredentialDigest(decodeOperatorSecretKey(key.value_b64, 'spawn-signing-key')) !== authority.credentialSha256) {
      throw new AdmissionAuthorityRefused('original signed-spawn credential was revoked or rotated');
    }
  }
  return {
    ...authority.context, uiClientId: caller,
    role: authority.role as UnifiedToolContext['role'], isSuperuser, sigVerifiedSpawn: !isSuperuser,
    principal: await synthesizeDispatchPrincipal(sql, {
      workspaceId: scope.workspaceId, role: authority.role, isSuperuser, sigVerifiedSpawn: !isSuperuser,
    }),
    // Recompute today's policy; never deserialize a stored bypass or capability list.
    gateBypass: papercuspGateBypass({ isSuperuser, isPowerUser: false, role: authority.role }),
    signal: new AbortController().signal, log: () => {}, emit: () => {}, progress: () => {},
  };
}

/** All canonical gates, no tool handler. Preflight is NOT an invocation/completion receipt. */
export async function authorizeAdmissionReplay(
  sql: Sql, scope: AdmissionRecoveryScope,
  request: { caller: string; target: string; authority?: AdmissionRecoveryAuthority; note?: string; body?: string },
): Promise<void> {
  const ctx = await admissionReplayContext(sql, scope, request.caller, request.authority);
  const { PROJECTED_DEPS } = await import('./projected-tool-deps');
  // Background hosts need the same definitions as the public dispatch, not a
  // synthetic "permission tool" whose declarations can drift from the real tools.
  await import('./agent-tools/coordination/tools/dispatch');
  await import('./agent-tools/work_items/claim');
  for (const [name, input] of [
    ['coord:dispatch', {
      to: request.target, harness: scope.harnessSlug, workItemIds: [scope.workItemId],
      note: request.note ?? `Resume original work item ${scope.workItemId}`,
      ...(request.body !== undefined ? { body: request.body } : {}), resumeAdmission: true,
    }],
    ['work_items:claim', { row: `${scope.workItemId},${request.target},${scope.harnessSlug}` }],
  ] as const) {
    const tool = lookupByMcpName(name);
    if (!tool) throw new AdmissionAuthorityRefused(`canonical ${name} definition unavailable`);
    if (ctx.profile === 'power' && tool.profile === 'engineer') {
      throw new AdmissionAuthorityRefused(`${name}: tool_not_available_for_profile`);
    }
    const verdict = await runWithWorkspaceIfConcrete(scope.workspaceId, () =>
      preflightDispatchStack(tool, name, input, ctx, PROJECTED_DEPS));
    if (!verdict.allowed) throw new AdmissionAuthorityRefused(`${name}: ${verdict.error?.message ?? 'current authority denied'}`);
  }
}
