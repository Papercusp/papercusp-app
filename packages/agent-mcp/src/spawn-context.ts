/**
 * Parses the seven per-spawn URL params from inbound MCP requests.
 *
 * Used by the MCP transport (apps/operator/app/api/[transport]/route.ts)
 * to derive the spawn context from the URL the orchestrator baked into
 * each spawn's `.mcp.json` (PR 4 of plugin-MCP-host).
 *
 * URL shape:
 *   ?harness=<slug?>&workspace=<id>&role=<role>
 *   &run=<runId>&spawn=<spawnId>
 *   &feature=<id?>&chunk=<id?>&parent_spawn=<id?>&client=<uiClientId?>
 *   &detector=<private failure-loop session key?>
 *
 * Required: workspace, role, run, spawn.
 * Optional: harness (a WORKSPACE-LEVEL role session — operator/planner
 *           launched without a harness, hive-agent-tabs P-003; absent →
 *           `harnessSlug` is the `'*'` unscoped sentinel, the same value
 *           the superuser path uses — harness-scoped tools then answer
 *           `harness_required` until a per-call harness is named),
 *           feature, chunk, parent_spawn (set by Phase 9 spawn-of-spawn),
 *           client (UI client id; when an agent is invoked from a
 *           browser tab, the tab's client_id is baked here so tools
 *           like `ui:dispatch` can default to it).
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (D4).
 */

import type { AgentRole } from '@papercusp/plugin-sdk';

export interface PluginRequestContext {
  workspaceId: string;
  harnessSlug: string;
  role: AgentRole;
  featureId: string | null;
  chunkId: string | null;
  runId: string;
  spawnId: string;
  parentSpawnId: string | null;
  uiClientId: string | null;
  detectorSessionKey: string | null;
}

export class InvalidRequestContextError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`request URL is missing required params: ${missing.join(', ')}`);
    this.missing = missing;
    this.name = 'InvalidRequestContextError';
  }
}

export function parseRequestContext(url: URL | string): PluginRequestContext {
  const u = typeof url === 'string' ? new URL(url) : url;
  const harnessSlug = (u.searchParams.get('harness') ?? '').trim();
  const workspaceId = (u.searchParams.get('workspace') ?? '').trim();
  const role = (u.searchParams.get('role') ?? '').trim() as AgentRole;
  const runId = (u.searchParams.get('run') ?? '').trim();
  const spawnId = (u.searchParams.get('spawn') ?? '').trim();
  const featureRaw = (u.searchParams.get('feature') ?? '').trim();
  const chunkRaw = (u.searchParams.get('chunk') ?? '').trim();
  const parentRaw = (u.searchParams.get('parent_spawn') ?? '').trim();
  const clientRaw = (u.searchParams.get('client') ?? '').trim();
  const detectorRaw = (u.searchParams.get('detector') ?? '').trim();

  const missing: string[] = [];
  if (!workspaceId) missing.push('workspace');
  if (!role) missing.push('role');
  if (!runId) missing.push('run');
  if (!spawnId) missing.push('spawn');
  if (missing.length > 0) throw new InvalidRequestContextError(missing);

  return {
    // Absent harness = a workspace-level role session (operator/planner,
    // hive-agent-tabs P-003) → the '*' unscoped sentinel (same as superuser).
    harnessSlug: harnessSlug || '*',
    workspaceId,
    role,
    runId,
    spawnId,
    featureId: featureRaw.length > 0 ? featureRaw : null,
    chunkId: chunkRaw.length > 0 ? chunkRaw : null,
    parentSpawnId: parentRaw.length > 0 ? parentRaw : null,
    uiClientId: clientRaw.length > 0 ? clientRaw : null,
    detectorSessionKey: detectorRaw.length > 0 ? detectorRaw : null,
  };
}
