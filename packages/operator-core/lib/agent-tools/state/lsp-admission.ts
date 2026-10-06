/** State-plane lens over the daemon-owned admission queue; never an operator-local mirror. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { readLspDaemonAdmission, readLspDaemonHealth } from '../../code-intelligence/lsp-daemon-client';
import type { LspAdmissionSnapshot } from '../../code-intelligence/lsp-admission';
import type { LspDaemonAnswer } from '../../code-intelligence/lsp-daemon-protocol';

export async function buildLspRuntimeStatePayload(
  workspaceId: string,
  read: (workspaceId: string) => Promise<NonNullable<LspDaemonAnswer['daemonRuntime']>> = readLspDaemonHealth,
) {
  try {
    const runtime = await read(workspaceId);
    if (!Number.isFinite(runtime.sampledAtMs) || Math.abs(Date.now() - runtime.sampledAtMs) > 30_000)
      throw new Error('daemon runtime inventory is unmeasured or stale');
    const readiness = runtime.servers.map(server => ({ language: server.language, rootPath: server.rootPath,
      taskId: server.taskId, certified: server.certifiedReadiness, unproven: server.unprovenReadiness,
      quiescent: server.quiescent, pendingProgress: server.pendingProgress, progressGeneration: server.progressGeneration }));
    return { runtime, readiness, runtimeAssessment: runtime.enabled ? runtime.overall : 'unknown',
      readinessAssessment: !runtime.enabled || !runtime.servers.length ? 'unknown' :
        readiness.some(server => server.unproven.length || server.pendingProgress || server.quiescent === false) ? 'unproven' : 'reported',
      runtimeMeasurement: 'measured', runtimeUnknown: [] as string[] };
  } catch (error) {
    return { runtime: null, readiness: null, runtimeAssessment: 'unknown', readinessAssessment: 'unknown', runtimeMeasurement: 'unknown',
      runtimeUnknown: [`daemon-runtime: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export async function buildLspAdmissionStatePayload(
  workspaceId: string,
  read: (workspaceId: string) => Promise<LspAdmissionSnapshot> = readLspDaemonAdmission,
  readRuntime: Parameters<typeof buildLspRuntimeStatePayload>[1] = readLspDaemonHealth,
) {
  const runtime = await buildLspRuntimeStatePayload(workspaceId, readRuntime);
  try {
    const admission = await read(workspaceId);
    if (admission.measured !== true || !Number.isFinite(admission.sampledAtMs) ||
        Math.abs(Date.now() - admission.sampledAtMs) > 30_000) throw new Error('daemon admission snapshot is unmeasured or stale');
    return { ...runtime, admission, assessment: admission.assessment, measurement: 'measured', unknown: [] as string[] };
  } catch (error) {
    return { ...runtime, admission: null, assessment: 'unknown', measurement: 'unknown',
      unknown: [`daemon-admission: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export default defineTool({
  name: 'lsp:admission_snapshot',
  description: 'Resolver for registered LSP admission, warm-server population and per-intent readiness cells; reads their owning daemon over its existing RPC transport.',
  guidance: {
    when: 'As the registered resolver for lsp.admission, lsp.warmServers and lsp.readiness.',
    notWhen: 'To submit code-intelligence work or mutate the daemon.',
    chaining: 'Use state:read for lsp.admission (class queue and settlement), lsp.warmServers (actual inventory) or lsp.readiness (per-intent proof and progress).',
  },
  // @cell-lens lsp.admission
  // @cell-lens lsp.warmServers
  // @cell-lens lsp.readiness
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({}),
  async handler(_args, ctx) {
    const payload = await buildLspAdmissionStatePayload(ctx.workspaceId ?? activeWorkspaceId());
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
