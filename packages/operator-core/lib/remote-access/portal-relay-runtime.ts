/**
 * The relay connector of a relay-linked local install (external-app-access P-008, D-031 #7).
 *
 * It is the SAME outbound connector a Papercusp-hosted machine runs (HostedWorkspaceConnectorClient
 * + HostedWorkspaceHostSessionAdapter, built by createHostedWorkspaceHostRuntime), in a local mode:
 *   - only the app-http and app-key-mint channels are served (LOCAL_RELAY_CHANNEL_KINDS); a pty,
 *     desktop or operator-http open is refused, because each would give the portal a terminal,
 *     the screen, or loopback-trusted access to a home computer;
 *   - no D-421 agent spawn transform is installed (that is ensureHostedWorkspaceHostRuntime's,
 *     for a hosted VM's customer account) and the bound workspace is NOT made current: this
 *     install's own workspace choice stays the user's;
 *   - no desktop backend.
 * App calls reach the operator with the deny-only ingress marker (D-015), so keys and scopes are
 * checked exactly as on the own-tunnel path.
 *
 * One connector per process, pinned (pinModuleState). Only the host singleton runs it; the
 * reconciler in relay-opt-in.ts decides that.
 */
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import type { HostedWorkspaceHostRuntime } from '../workspace-host/hosted-workspace-host-runtime';

export interface PortalRelayConnectorStatus {
  readonly running: boolean;
  /** The portal's binding arrived: the link is live end to end. */
  readonly bound: boolean;
  readonly startedAt: string | null;
  /** Why the connector ended on its own, if it did ('revoked' = the portal ended the link). */
  readonly terminal: { reason: string; detail: string; at: string } | null;
}

interface RunningConnector {
  readonly runtime: HostedWorkspaceHostRuntime;
  readonly url: string;
  readonly bearerDigest: string;
  readonly startedAt: Date;
}

const state = pinModuleState('@papercusp/operator-core.remote-access.portal-relay-runtime', () => ({
  current: null as RunningConnector | null,
  terminal: null as { reason: string; detail: string; at: Date } | null,
}));

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export type CreatePortalRelayRuntime = (input: {
  url: string;
  bearer: string;
  workspaceRoot: string;
  onTerminal: (reason: string, detail: string) => void;
}) => Promise<HostedWorkspaceHostRuntime>;

/** Production factory: loaded lazily so a process that never links pulls none of it in. */
export const createLocalRelayRuntime: CreatePortalRelayRuntime = async (input) => {
  const [{ createHostedWorkspaceHostRuntime }, { LOCAL_RELAY_CHANNEL_KINDS }] = await Promise.all([
    import('../workspace-host/hosted-workspace-host-runtime'),
    import('../workspace-host/hosted-session-host'),
  ]);
  return createHostedWorkspaceHostRuntime({
    url: input.url,
    bearer: input.bearer,
    workspaceRoot: input.workspaceRoot,
    allowedChannelKinds: LOCAL_RELAY_CHANNEL_KINDS,
    onTerminal: (reason, detail) => input.onTerminal(reason, detail),
    onWarning: (message) => console.warn(`[portal-relay] ${message}`),
  });
};

export function portalRelayConnectorRunning(): boolean {
  return state.current !== null;
}

/** Start the connector with this bearer and URL; a no-op when it already runs with both. */
export async function startPortalRelayConnector(
  input: { url: string; bearer: string; workspaceRoot: string },
  create: CreatePortalRelayRuntime = createLocalRelayRuntime,
): Promise<void> {
  const bearerDigest = digest(input.bearer);
  const current = state.current;
  if (current && current.url === input.url && current.bearerDigest === bearerDigest) return;
  stopPortalRelayConnector('relay_reconfigured');
  state.terminal = null;
  let runtime: HostedWorkspaceHostRuntime | null = null;
  runtime = await create({
    url: input.url,
    bearer: input.bearer,
    workspaceRoot: input.workspaceRoot,
    onTerminal: (reason, detail) => {
      state.terminal = { reason, detail, at: new Date() };
      // A terminal client never dials again; forget it so the reconciler sees it stopped.
      if (state.current?.runtime === runtime) state.current = null;
    },
  });
  state.current = { runtime, url: input.url, bearerDigest, startedAt: new Date() };
  runtime.start();
}

export function stopPortalRelayConnector(reason = 'relay_off'): void {
  const current = state.current;
  if (!current) return;
  state.current = null;
  current.runtime.stop(reason);
}

export function portalRelayConnectorStatus(): PortalRelayConnectorStatus {
  const current = state.current;
  const terminal = state.terminal;
  return {
    running: current !== null,
    bound: current?.runtime.binding !== null && current?.runtime.binding !== undefined,
    startedAt: current ? current.startedAt.toISOString() : null,
    terminal: terminal ? { reason: terminal.reason, detail: terminal.detail, at: terminal.at.toISOString() } : null,
  };
}

/** The reason the connector last ended on its own, consumed once by the reconciler. */
export function takePortalRelayTerminal(): { reason: string; detail: string } | null {
  const terminal = state.terminal;
  if (!terminal) return null;
  state.terminal = null;
  return { reason: terminal.reason, detail: terminal.detail };
}

/** Test seam. */
export function resetPortalRelayRuntimeForTests(): void {
  state.current?.runtime.stop('test_reset');
  state.current = null;
  state.terminal = null;
}
