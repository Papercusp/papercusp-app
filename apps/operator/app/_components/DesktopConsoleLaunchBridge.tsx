'use client';

/**
 * DesktopConsoleLaunchBridge — the webview half of the Windows agent
 * console-launch bridge (WI-3289; operator half: lib/console-launch-bridge.ts).
 *
 * On a Windows install the operator runs inside the `papercup-runtime` WSL2
 * distro and CANNOT open a visible terminal itself (its spawns land in
 * Session 0 — see native_console.rs D-002). The only Session-1 process that
 * can is the desktop shell, via the Tauri `console_launch` command. The user
 * "+" button already reaches it renderer-side (native-console.ts); this
 * component gives AGENT-invoked launches (capability:terminal,
 * fleet:launch-on-plan) the same reach:
 *
 *   1. the operator emits only an opaque `console.launch-request` ticket and
 *      optional target UI-client id, retaining the ConsoleEnvelope in memory;
 *   2. this component ignores another client's ticket, then atomically CLAIMS
 *      its own ticket and receives the envelope from the claim response;
 *   3. invokes the Tauri `console_launch` command with that envelope;
 *   4. POSTs launch-result, resolving the agent's await with ok/error.
 *
 * Mounted once at the app root next to DesktopAttentionNotifier, and rides
 * the sync transport's OWN stream via `onSyncBusEvent` for the same
 * socket-starvation reason documented there (never a second EventSource).
 * Non-Tauri surfaces (plain browser tabs) ignore the event entirely — they
 * cannot invoke Tauri commands, and claiming without spawning would eat the
 * request. All failures are reported back to the operator so the agent gets
 * a real error instead of a timeout.
 */
import { useEffect } from 'react';
import { onSyncBusEvent } from '@papercusp/sync';
import { getOrCreateClientId } from '@papercusp/operator-core/lib/ui/client-id';
import { canUseContentOriginDesktopActions, isDesktop } from '@/lib/ipc-status-tauri';

const CONSOLE_LAUNCH_REQUEST_EVENT = 'console.launch-request';

interface ConsoleEnvelope {
  cwd: string;
  env: Record<string, string>;
  mcpJsonContents: string;
  greetingCmd: string;
  needsSuperuserBootstrap: boolean;
  sessionId: string;
}

interface LaunchRequestArgs {
  ticket?: string;
  targetClientId?: string | null;
  label?: string | null;
  planSlug?: string | null;
}

interface LaunchClaimResponse {
  status?: string;
  granted?: boolean;
  envelope?: ConsoleEnvelope;
}

async function postJson(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => null);
}

async function handleLaunchRequest(args: LaunchRequestArgs): Promise<void> {
  const ticket = args.ticket;
  const clientId = getOrCreateClientId();
  if (!ticket || !clientId) return;
  if (args.targetClientId && args.targetClientId !== clientId) return;
  if (!await canUseContentOriginDesktopActions()) {
    // A plain browser must leave an untargeted ticket available for the real
    // desktop shell. A Tauri webview, however, can identify that its
    // content-origin IPC bridge is unavailable and fail its own request
    // immediately instead of making the agent wait for the 30s timeout.
    if (!isDesktop()) return;
    const claim = await postJson('/api/agent-mcp/console/launch-claim', {
      ticket,
      clientId,
    }) as LaunchClaimResponse | null;
    if (!claim || claim.granted !== true) return;
    await postJson('/api/agent-mcp/console/launch-result', {
      ticket,
      ok: false,
      error:
        'Tauri desktop bridge unavailable — reopen the Papercusp desktop window before retrying',
    }).catch(() => {
      /* operator unreachable — its timeout is the backstop */
    });
    return;
  }

  // The envelope is returned exactly once by the atomic claim. It never rides
  // the broadcast SSE stream, and a wrong client id cannot consume the ticket.
  const claim = await postJson('/api/agent-mcp/console/launch-claim', {
    ticket,
    clientId,
  }) as LaunchClaimResponse | null;
  if (!claim || claim.granted !== true) return;
  const envelope = claim.envelope;

  if (!envelope?.cwd || typeof envelope.greetingCmd !== 'string') {
    await postJson('/api/agent-mcp/console/launch-result', {
      ticket,
      ok: false,
      error: 'console launch ticket returned an invalid envelope',
    }).catch(() => {
      /* operator unreachable — its timeout is the backstop */
    });
    return;
  }

  // From here on WE own the request: every outcome must be reported back, or
  // the agent's call blocks until the operator-side timeout.
  try {
    const { commands } = await import('@papercusp/operator-core/lib/tauri-bindings');
    const launchFn = (commands as {
      consoleLaunch?: (e: ConsoleEnvelope) => Promise<unknown>;
    }).consoleLaunch;
    if (typeof launchFn !== 'function') {
      throw new Error('Tauri bindings missing console_launch');
    }
    const result = (await launchFn(envelope)) as
      | { status: 'ok'; pid?: number | null }
      | { status: 'err'; error: string }
      | null;
    if (result && 'status' in result && result.status === 'ok') {
      await postJson('/api/agent-mcp/console/launch-result', {
        ticket,
        ok: true,
        pid: typeof result.pid === 'number' ? result.pid : null,
      });
    } else {
      const error =
        (result as { error?: string } | null)?.error ?? 'console_launch returned no result';
      await postJson('/api/agent-mcp/console/launch-result', { ticket, ok: false, error });
    }
  } catch (e: any) {
    await postJson('/api/agent-mcp/console/launch-result', {
      ticket,
      ok: false,
      error: e?.message ?? String(e),
    }).catch(() => {
      /* operator unreachable — its timeout is the backstop */
    });
  }
}

export default function DesktopConsoleLaunchBridge() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    return onSyncBusEvent((ev) => {
      if (ev.name !== CONSOLE_LAUNCH_REQUEST_EVENT) return;
      void handleLaunchRequest((ev.args ?? {}) as LaunchRequestArgs);
    });
  }, []);
  return null;
}
