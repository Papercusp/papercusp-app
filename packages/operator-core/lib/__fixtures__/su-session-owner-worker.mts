/**
 * Worker-process fixture for su-session-owner-routing.integration.test.ts
 * (WI-10003879). One forked process = one operator cluster worker.
 *
 * Runs the PRODUCTION owner-rpc worker side on this process's real IPC channel
 * and the PRODUCTION su-session-owner-routing module. The only substitutions are
 * the database reads/writes (owner record, durable row, owner-turn receipts and
 * client leases), injected through each module's test seam so no Postgres is
 * needed. The engine is a real SuSessionHost with an executor that exists only
 * in the process that opened it — exactly the state a PUI launch leaves on the
 * worker that served it.
 */
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionCapabilities,
  type SuSessionDescriptor,
} from '@papercusp/chat-protocol';
import { startWorkerOwnerRpc } from '../cluster-owner-rpc.ts';
import { SuSessionHost, registerSuSessionHost } from '../su-session-host.ts';
import { _resetSuClientLeaseForTest } from '../su-session-client-lease.ts';
import type { SuSessionCommandStore } from '../su-session-commands.ts';
import type { SuSessionHostOwner } from '../su-session-persistence.ts';
import {
  _configureSuSessionRoutingForTest,
  createForwardedSuSessionEventResponse,
  localSuSessionHostOwner,
  resolveSuSessionRoute,
  runRoutedSuSessionOp,
} from '../su-session-owner-routing.ts';

const supported = { state: 'supported', implementation: 'native' } as const;
const capabilities: SuSessionCapabilities = {
  commands: {
    owner_turn: supported,
    interrupt: supported,
    resume: supported,
    fork: { state: 'unsupported', reason: 'fixture has no fork' },
    focus: { state: 'supported', implementation: 'host' },
    end: supported,
  },
  features: {
    'tool-events': supported, 'interactive-cards': supported, 'reasoning-stream': supported, usage: supported,
    compaction: supported, approvals: supported, context: supported, modes: supported,
  },
};

export const ADDRESS = { workspaceId: 'fixture-workspace', harnessSlug: 'fixture', agentChatId: 'chat-owner-routing' };

function descriptor(): SuSessionDescriptor<'claude'> {
  return {
    identity: {
      agentChatId: ADDRESS.agentChatId, advSessionId: 77, backend: 'claude', nativeSessionId: 'native-77',
      ownerId: 'su-fixture', workspaceId: ADDRESS.workspaceId, harnessSlug: ADDRESS.harnessSlug,
    },
    lifecycle: 'starting', runtimeGeneration: 1, role: 'su', model: 'claude-fixture', accountServed: null,
    accountRoute: 'default', carry: 'warm', modes: [], capabilities,
    backendExtension: { backend: 'claude', configDir: '/tmp/fixture-claude', configDirSource: 'live-process' },
  };
}

// What this worker's database read "would" return for the owner record.
let ownerRecord: SuSessionHostOwner | null = null;
const receipts = new Map<string, { fingerprint: string; outcome?: unknown }>();
const commandStore: SuSessionCommandStore = {
  async reserve(command, fingerprint) {
    const existing = receipts.get(command.commandId);
    if (existing) return { created: false, receipt: existing as never };
    const receipt = { fingerprint };
    receipts.set(command.commandId, receipt);
    return { created: true, receipt: receipt as never };
  },
  async finish(command, _fingerprint, outcome) {
    const r = receipts.get(command.commandId);
    if (r) r.outcome = outcome;
  },
};
_configureSuSessionRoutingForTest({
  readOwner: async () => ownerRecord,
  readDurable: async () => null,
  commandStore,
});
_resetSuClientLeaseForTest({ grant: async () => undefined, renew: async () => undefined, detach: async () => true, expired: async () => [] });

let host: SuSessionHost<'claude'> | null = null;
const executed: string[] = [];

startWorkerOwnerRpc();

async function handle(message: any): Promise<unknown> {
  switch (message.op) {
    case 'open-engine': {
      // What a launch does on the worker that served it: attach an engine and
      // record itself as the owner.
      host = new SuSessionHost<'claude'>({
        descriptor: descriptor(),
        runtimeReady: () => true,
        executeCommand: async (command, ctx) => {
          executed.push(`${command.type}:${process.pid}`);
          ctx.emit({ type: 'assistant_text', text: `owner ${process.pid} handled ${command.type}` } as never);
          return { status: 'completed' };
        },
      });
      registerSuSessionHost(host);
      host.transition('ready', 'fixture engine ready');
      return { owner: localSuSessionHostOwner() };
    }
    case 'set-owner-record':
      ownerRecord = message.owner;
      return { ok: true };
    case 'route': {
      const outcome = await runRoutedSuSessionOp(ADDRESS, message.request);
      if (outcome instanceof Response) return { status: outcome.status, body: await outcome.json(), servedBy: null };
      return { status: outcome.result.status, body: outcome.result.body, servedBy: outcome.servedBy };
    }
    case 'route-kind':
      return { kind: (await resolveSuSessionRoute(ADDRESS)).kind };
    case 'emit': {
      host!.emit({ type: 'assistant_text', text: message.text } as never);
      return { ok: true };
    }
    case 'executed':
      return { executed };
    case 'stream': {
      // Open the forwarded SSE stream and read until `untilText` shows up.
      const route = await resolveSuSessionRoute(ADDRESS);
      if (route.kind !== 'remote') return { error: `route was ${route.kind}` };
      const controller = new AbortController();
      const response = await createForwardedSuSessionEventResponse(
        new Request('http://fixture/events', { signal: controller.signal }), ADDRESS, route.owner,
      );
      if (!response) return { error: 'owner fell back' };
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + (message.timeoutMs ?? 20_000);
      while (!text.includes(message.untilText) && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), 500)),
        ]);
        if (chunk && !chunk.done) text += decoder.decode(chunk.value, { stream: true });
        if (chunk && chunk.done) break;
        // Ask the test to publish on the owner once the stream is open.
        if (message.signalOpen && !text.includes('__opened__')) {
          text += '__opened__';
          process.send!({ type: 'fixture:stream-open', seq: message.seq });
        }
      }
      controller.abort();
      return { text, servedBy: response.headers.get('X-Papercusp-Su-Session-Served-By') };
    }
    default:
      return { error: `unknown op ${message.op}` };
  }
}

process.on('message', async (message: any) => {
  if (message?.type !== 'fixture:op') return;
  try {
    process.send!({ type: 'fixture:result', seq: message.seq, out: await handle(message) });
  } catch (error) {
    process.send!({ type: 'fixture:result', seq: message.seq, out: { error: String(error) } });
  }
});

process.on('disconnect', () => process.exit(0));

process.send!({ type: 'fixture:ready', pid: process.pid });
