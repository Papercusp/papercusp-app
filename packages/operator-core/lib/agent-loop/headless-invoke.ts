/**
 * Operator host for orchestrator's injected owned-loop execution port
 * (own-tui-full-divorce-2026-08-24 P-010).
 *
 * Dependency direction is deliberate: orchestrator declares the structural
 * port and knows nothing about operator-core; this module imports that type,
 * binds the real ModelPort + principal-aware capability dispatcher, and emits
 * the same bounded LoopEvent wire objects the interactive chat lane uses.
 * invoke.ts serializes those objects as NDJSON and owns run-output persistence.
 */
import {
  dispatchProjectedTool,
  lookupByMcpName,
} from '@papercusp/agent-mcp';
import type { OwnedLoopInvokePort } from '@papercusp/orchestrator';
import '../agent-tools/index';
import {
  capabilityToolset,
  type DispatchResult,
  type ToolDispatcher,
} from './capability-toolset';
import { runLoopChatTurn } from './chat-engine';
import type { ModelPort } from './model-port';
import type { ApprovalPort, LoopTool } from './loop';
import {
  flushPendingTelemetry,
  PROJECTED_DEPS,
} from '../projected-tool-deps';

export interface OperatorOwnedLoopPortOptions {
  /** Test seam; production uses createRoutedModelPort inside chat-engine. */
  modelPort?: ModelPort;
  /** Test/specialized-host seam; production derives capability:* tools. */
  tools?: LoopTool[];
  /** Test seam. Production flushes the shared deferred tool ledger once/turn. */
  flushTelemetry?: () => Promise<void>;
}

const unattendedApprovalPort: ApprovalPort = {
  async requestApproval() {
    // Headless fleet workers have no interactive responder. Tool confinement,
    // role gates, quota, and telemetry remain enforced by dispatchProjectedTool;
    // HITL is an interactive policy layer, not the security boundary (D-011).
    return { approved: true, reason: 'headless owned-loop execution' };
  },
};

function buildCapabilityTools(
  request: Parameters<OwnedLoopInvokePort['invoke']>[0],
): LoopTool[] {
  const dispatchCtx = {
    workspaceId: request.workspaceId,
    harnessSlug: request.harnessSlug,
    role: request.role,
    runId: request.runId,
    spawnId: (process.env.PAPERCUSP_SPAWN_ID ?? '').trim() || `agent-loop-${request.runId}`,
    featureId: request.featureId,
    chunkId: request.chunkId,
    log: () => { /* */ },
    progress: () => { /* */ },
    emit: () => { /* */ },
    signal: request.signal,
    spawn: async () => {
      throw new Error('spawn not available inside the owned loop');
    },
    secret: async () => null,
    // A chunk implementation runs in its scratch cwd; capability:bash/edit/
    // write must resolve there, not in the harness's canonical project root.
    projectDir: request.cwd,
    stateDir: request.stateDir,
  };
  const dispatch: ToolDispatcher = async (name, args) => {
    const tool = lookupByMcpName(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      };
    }
    // The direct in-process host must carry the SAME dispatch deps as MCP/HTTP.
    // Passing `{}` here used to execute the tool successfully while silently
    // skipping tool_invocations telemetry, making D-015's MCP gate impossible.
    const result = await dispatchProjectedTool(
      tool,
      name,
      args,
      dispatchCtx as never,
      PROJECTED_DEPS,
    );
    if (!result.ok || !result.result) {
      return {
        isError: true,
        content: [{ type: 'text', text: result.error?.message ?? `dispatch of ${name} failed` }],
      };
    }
    return result.result as DispatchResult;
  };
  return capabilityToolset({ dispatch });
}

/** Build the operator-owned implementation of orchestrator's one-shot port. */
export function createOperatorOwnedLoopPort(
  options: OperatorOwnedLoopPortOptions = {},
): OwnedLoopInvokePort {
  return {
    async invoke(request) {
      const tools = options.tools ?? buildCapabilityTools(request);
      const flushTelemetry = options.flushTelemetry ?? flushPendingTelemetry;
      try {
        const result = await runLoopChatTurn({
          chatId: request.runId,
          workspaceId: request.workspaceId,
          // invoke.ts's assembled prompt is already the subprocess USER message
          // (persona + runtime context + task). Keep that priority unchanged.
          system: '',
          transcript: [{
            role: 'user',
            content: request.prompt,
            ts: new Date().toISOString(),
          }],
          sink: {
            event(_name, data) {
              request.emit(data);
            },
          },
          model: request.model,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
          tools,
          approvals: unattendedApprovalPort,
          ...(options.modelPort ? { port: options.modelPort } : {}),
        });

        if (result.errorMessage) {
          return { exitCode: 1, stderr: result.errorMessage };
        }
        if (result.stopReason === 'aborted') {
          return { exitCode: 130, stderr: 'owned-loop turn aborted' };
        }
        return { exitCode: 0 };
      } finally {
        // The writer is deferred per tool for latency; the one-shot worker
        // boundary is the honest place to make its whole run durable.
        await flushTelemetry();
      }
    },
  };
}
