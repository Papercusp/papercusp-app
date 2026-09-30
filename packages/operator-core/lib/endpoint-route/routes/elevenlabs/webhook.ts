/**
 * POST /api/elevenlabs/webhook — EL Conv-AI agent webhook tool calls,
 * dispatched through the action registry.
 * Ported from app/api/elevenlabs/webhook/route.ts. `auth: 'public'` —
 * authenticated by its own EL signature check.
 */
import { randomUUID } from 'node:crypto';
import { activeWorkspaceId } from '../../../workspace-registry';
import { get, runCommand, runQuery } from '../../../commands/registry';
import { deliver as deliverToTab } from '../../../commands/session-registry';
import type { CommandContext, CommandResult } from '../../../commands/types';
import { verifyElevenLabsSignature } from '../../../elevenlabs-webhook-auth';
import '../../../commands/audit-server';
import '../../../commands/defs';
import { defineTool } from '@papercusp/agent-mcp';

interface ElevenLabsWebhookPayload {
  tool_name?: string;
  parameters?: unknown;
  conversation_id?: string;
  agent_id?: string;
  dynamic_variables?: {
    device_id?: string;
    workspace_id?: string;
    surface?: string;
    desktop_host?: string;
  };
  type?: string;
  data?: { tool_name?: string; parameters?: unknown };
}

export default defineTool({
  method: 'POST',
  path: '/elevenlabs/webhook',
  auth: 'public',
  async handler(req) {
    const rawBody = await req.text();
    const sig = verifyElevenLabsSignature({
      rawBody,
      signatureHeader: req.headers.get('elevenlabs-signature'),
    });
    if (!sig.ok) {
      return Response.json(
        { ok: false, error: { code: 'auth', message: `signature: ${sig.reason}`, retryable: false } },
        { status: 401 },
      );
    }
    let payload: ElevenLabsWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as ElevenLabsWebhookPayload;
    } catch {
      return Response.json(
        { ok: false, error: { code: 'invalid-json', message: 'body is not JSON', retryable: false } },
        { status: 400 },
      );
    }
    const toolName = payload.tool_name ?? payload.data?.tool_name;
    const parameters = payload.parameters ?? payload.data?.parameters ?? {};
    if (!toolName || typeof toolName !== 'string') {
      return Response.json(
        { ok: false, error: { code: 'no-tool', message: 'missing tool_name', retryable: false } },
        { status: 400 },
      );
    }
    const def = get(toolName);
    if (!def) {
      return Response.json(
        {
          ok: false,
          error: { code: 'unknown-tool', message: `no such registry tool: ${toolName}`, retryable: false },
        },
        { status: 404 },
      );
    }
    const dyn = payload.dynamic_variables ?? {};
    const surfaceRaw = typeof dyn.surface === 'string' ? dyn.surface : undefined;
    const surface: CommandContext['surface'] =
      surfaceRaw === 'mobile-android'
        ? 'mobile-android'
        : surfaceRaw === 'mobile-ios'
          ? 'mobile-ios'
          : surfaceRaw === 'mobile-unknown'
            ? 'mobile-unknown'
            : surfaceRaw === 'browser'
              ? 'browser'
              : undefined;
    const workspaceFromDyn =
      typeof dyn.workspace_id === 'string' && dyn.workspace_id ? dyn.workspace_id : undefined;
    const ctx: CommandContext = {
      agent: 'operator',
      workspace: workspaceFromDyn ?? activeWorkspaceId(),
      requestId: randomUUID(),
      surface,
      deviceId: typeof dyn.device_id === 'string' ? dyn.device_id : undefined,
    };
    let result: CommandResult;
    if (def.kind === 'command' && def.browser === 'required') {
      result = await deliverToTab(ctx.workspace, { id: toolName, args: parameters });
    } else if (def.kind === 'command') {
      result = await runCommand(toolName, parameters, ctx);
    } else {
      result = await runQuery(toolName, parameters, ctx);
    }
    return Response.json(result);
  },
});
