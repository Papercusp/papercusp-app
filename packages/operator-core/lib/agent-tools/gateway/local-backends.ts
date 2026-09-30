/**
 * gateway:local_backend_* — agent control surface for the LOCAL inference-backend pool
 * (local-concurrent-inference-2026-07-02 P-004, D-002): register/list/remove a llama-server |
 * vllm | ollama backend in the durable registry (local-backend-store.ts), then hot-apply the
 * change to the RUNNING gateway (POST :8788/admin/reload — the SAME endpoint accounts:register
 * uses for the Claude/Codex pool, so this is parity, not a new mechanism).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
// Local backends are a per-workspace DURABLE registry, so register/list/remove all resolve
// through `resolveConcreteWorkspaceId`: the `'*'` superuser READ sentinel is not a storable
// workspace value, and the `x ?? ctx.workspaceId ?? … ?? activeWorkspaceId()` form these three
// sites used lets a truthy `'*'` win so the fallback never fires. Register-under-'*' +
// list-from-concrete is the same invisible-write / unremovable-row shape as the account-pin bug
// (EI-20208335287200289), and list must resolve identically to the writes or it cannot see them.
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  registerLocalBackend,
  listLocalBackends,
  removeLocalBackend,
  LOCAL_BACKEND_KINDS,
} from '../../inference-gateway/local-backend-store';

const gwBase = () => `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
const ok = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...p }) }] });
const fail = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...p }) }] });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Best-effort LIVE apply — the durable write already happened; a failed/unreachable gateway just
 *  means it picks this up on its next 30s local-backend poll instead of immediately (mirrors
 *  accounts:pin's "saved durably but live apply failed" pattern). */
async function applyLive(): Promise<{ appliedLive: boolean; warn?: string }> {
  const r = await fetch(`${gwBase()}/admin/reload`, { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(
    (e) => ({ ok: false, status: 0, _e: errMsg(e) }) as unknown as Response,
  );
  return r.ok ? { appliedLive: true } : { appliedLive: false, warn: 'saved durably but live apply to the gateway failed (it will load on the next ~30s poll)' };
}

export const gatewayLocalBackendRegisterTool = defineTool({
  name: 'gateway:local_backend_register',
  description:
    "Register (or update) a LOCAL inference backend — llama-server/vllm/ollama — in the durable registry, then hot-apply it to the running gateway (POST :8788/admin/reload). An OpenAI-compatible request to the gateway's `/v1/chat/completions` whose `model` matches one of `models` routes to this backend (least-loaded across backends serving that model). Upserts by `id`. Returns {ok, backend, appliedLive}.",
  guidance: {
    when: 'Standing up (or re-pointing / re-tuning) a local llama-server/vllm/ollama backend so the gateway can route to it (local-concurrent-inference-2026-07-02 D-002).',
    notWhen: 'Registering a Claude/Codex cloud account — that is accounts:register (a different pool).',
    chaining: 'gateway:local_backend_register → gateway:local_backend_list (confirm) → gateway:status / GET :8788/admin/local-backends (confirm health).',
    seeAlso: ['gateway:local_backend_list', 'gateway:local_backend_remove', 'gateway:reload'],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe("Stable backend id (upsert key), e.g. 'ornith-llama-server'."),
    kind: z.enum(LOCAL_BACKEND_KINDS).describe('llama-server | vllm | ollama'),
    baseUrl: z.string().min(1).describe("Backend's OpenAI-compatible root, e.g. 'http://127.0.0.1:8081' (no trailing /v1)."),
    models: z.array(z.string().min(1)).min(1).describe('Model ids this backend serves — matched against an incoming request\'s "model" field.'),
    maxConcurrent: z.number().int().positive().optional().describe('Max in-flight requests before this backend is skipped for least-loaded routing. Default 4.'),
    enabled: z.boolean().optional().describe('false = registered but out of rotation (park it without deleting it, e.g. swapping ollama↔llama-server). Default true.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler({ id, kind, baseUrl, models, maxConcurrent, enabled, workspace }, ctx) {
    const ws = resolveConcreteWorkspaceId(workspace, ctx?.workspaceId, ctx?.principal?.workspaceId);
    try {
      const backend = await registerLocalBackend({ id, kind, baseUrl, models, maxConcurrent, enabled, workspaceId: ws });
      const live = await applyLive();
      return ok({ backend, ...live });
    } catch (e) {
      return fail({ error: `gateway:local_backend_register failed: ${errMsg(e)}` });
    }
  },
});

export const gatewayLocalBackendListTool = defineTool({
  name: 'gateway:local_backend_list',
  description:
    'List registered local inference backends (the DURABLE registry — for LIVE health + in-flight, hit GET :8788/admin/local-backends via gateway:status\'s sibling route, or fetch it directly). Returns {ok, backends}.',
  guidance: {
    when: "Checking what's registered before register/remove, or confirming a register/remove landed.",
    notWhen: 'You need LIVE health/in-flight — that is process state on the running gateway, not this durable list.',
    chaining: 'gateway:local_backend_list → gateway:local_backend_register / gateway:local_backend_remove.',
    seeAlso: ['gateway:local_backend_register', 'gateway:local_backend_remove'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler({ workspace }, ctx) {
    const ws = resolveConcreteWorkspaceId(workspace, ctx?.workspaceId, ctx?.principal?.workspaceId);
    try {
      const backends = await listLocalBackends({ workspaceId: ws });
      return ok({ backends });
    } catch (e) {
      return fail({ error: `gateway:local_backend_list failed: ${errMsg(e)}` });
    }
  },
});

export const gatewayLocalBackendRemoveTool = defineTool({
  name: 'gateway:local_backend_remove',
  description:
    'Remove a local inference backend from the durable registry, then hot-apply the removal to the running gateway (POST :8788/admin/reload). To take a backend OUT of rotation without deleting it (e.g. swapping ollama↔llama-server), prefer gateway:local_backend_register with `enabled:false`. Returns {ok, removed, appliedLive}.',
  guidance: {
    when: 'Decommissioning a local backend that no longer exists / should never be routed to again.',
    notWhen: 'Temporarily pausing it — gateway:local_backend_register { id, enabled:false } keeps the registration for later.',
    chaining: 'gateway:local_backend_list (find the id) → gateway:local_backend_remove.',
    seeAlso: ['gateway:local_backend_register', 'gateway:local_backend_list'],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('Backend id to remove (see gateway:local_backend_list).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler({ id, workspace }, ctx) {
    const ws = resolveConcreteWorkspaceId(workspace, ctx?.workspaceId, ctx?.principal?.workspaceId);
    try {
      const removed = await removeLocalBackend(id, { workspaceId: ws });
      const live = removed ? await applyLive() : { appliedLive: false };
      return ok({ removed, ...live });
    } catch (e) {
      return fail({ error: `gateway:local_backend_remove failed: ${errMsg(e)}` });
    }
  },
});
