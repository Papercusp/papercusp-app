/**
 * hosted-desktop-channel.ts — the PURE half of P-013's hosted browser desktop
 * viewer (plan `agent-virtual-desktops-2026-08-23`, D-023).
 *
 * Separated from the workspace-host adapter for the same reason P-012 split
 * `x-server-backend.ts` (pure argv) from `kasmvnc-credentials.ts` (spawns
 * `kasmvncpasswd`): everything security-deciding lives here and is unit-testable
 * with no KasmVNC install, no sockets, and no relay. The side-effecting half —
 * dialling the sandbox's loopback WebSocket and pumping frames — consumes these
 * decisions rather than re-deriving them.
 *
 * ## What this module decides
 *
 * 1. **Which credential a viewer gets.** D-020 splits a desktop session into a
 *    view-only user and a `-w` control user with independently random secrets.
 *    The mapping from the relay's existing `observer` / `controller` role onto
 *    that pair is the whole privilege boundary of the hosted viewer, so it is one
 *    named function with one test, not an inline ternary at the dial site.
 * 2. **That the dial target is loopback.** D-020's honesty clause records that
 *    the BYOC lane degrades "no listener, ever" to "loopback-only listener behind
 *    a ticket gate". That property is established when the server is SPAWNED
 *    (`x-server-backend.ts` passes `-interface 127.0.0.1`), and it is re-checked
 *    HERE, at the moment we dial. The two checks fail differently: the spawn-time
 *    one is about how we start a server we control, this one is about where we
 *    are about to send a credential.
 * 3. **How often a connected viewer heartbeats the registry row** (D-008 rule 4).
 *
 * ## The dependency direction is deliberate
 *
 * This leaf imports from `./x-server-backend`, `./kasmvnc-credentials` and
 * `./desktop-lifecycle` and is imported BY the workspace-host adapter. It never
 * imports from `../workspace-host/*`, so the desktop plane stays independently
 * testable and the hosted relay remains one consumer of it rather than its owner.
 */
import {
  KASMVNC_CONTROL_USER,
  KASMVNC_LOOPBACK_INTERFACE,
  KASMVNC_VIEW_USER,
} from './x-server-backend';
import type { KasmvncSessionCredentials } from './kasmvnc-credentials';

/**
 * The viewer role, structurally identical to the hosted relay's
 * `HostedHostTabRole`. Restated here rather than imported so this leaf does not
 * depend on the workspace-host module it serves; the adapter passes its own role
 * value straight in and the compiler checks the two agree.
 */
export type HostedDesktopRole = 'observer' | 'controller';

/** The product-facing name for each role, as the plan and the audit trail say it. */
export type HostedDesktopAction = 'watch' | 'takeover';

export interface HostedDesktopGrant {
  /** `watch` for an observer, `takeover` for a controller. */
  action: HostedDesktopAction;
  /** The kasmvncpasswd user this viewer authenticates as. */
  user: string;
  /** That user's secret. Exactly one of the session's two secrets — never both. */
  secret: string;
  /**
   * Whether KasmVNC will accept input from this viewer. Derived from the role,
   * not configurable: it mirrors which credential was handed out, so a caller
   * cannot hold a view-only credential and still believe it may forward input.
   */
  inputAllowed: boolean;
  /** Audit action name, so watch and takeover are distinguishable in the log. */
  auditAction: 'desktop_watch_started' | 'desktop_takeover_started';
}

/**
 * Map a relay role onto exactly one of the session's two credentials.
 *
 * WHY THIS IS A FUNCTION AND NOT A TERNARY: the returned object carries ONE
 * secret. An observer's grant does not contain the control secret in an unread
 * field, so a serialisation bug, a log line, or a spread into an envelope cannot
 * leak write access to a watcher. That is a structural property — it holds
 * because the value was never assembled, not because every call site remembered
 * to strip it — and it is what the accompanying test pins.
 */
export function hostedDesktopGrant(
  role: HostedDesktopRole,
  credentials: Pick<KasmvncSessionCredentials, 'view' | 'control'>,
): HostedDesktopGrant {
  if (role === 'controller') {
    return {
      action: 'takeover',
      user: credentials.control.user,
      secret: credentials.control.secret,
      inputAllowed: true,
      auditAction: 'desktop_takeover_started',
    };
  }
  return {
    action: 'watch',
    user: credentials.view.user,
    secret: credentials.view.secret,
    inputAllowed: false,
    auditAction: 'desktop_watch_started',
  };
}

/** The expected users, re-exported so a caller need not reach past this module. */
export const HOSTED_DESKTOP_USERS = {
  watch: KASMVNC_VIEW_USER,
  takeover: KASMVNC_CONTROL_USER,
} as const;

export interface HostedDesktopEndpoint {
  host: string;
  port: number;
}

export class HostedDesktopEndpointError extends Error {
  constructor(readonly code: 'endpoint_absent' | 'endpoint_not_loopback' | 'endpoint_port_invalid', message: string) {
    super(message);
    this.name = 'HostedDesktopEndpointError';
  }
}

/**
 * Refuse to dial anything but the sandbox's loopback listener.
 *
 * THIS THROWS ON PURPOSE. A boolean predicate would be the natural shape, but the
 * failure it guards against is a caller that ignores the answer and dials anyway
 * with a live credential in hand. A throw cannot be ignored by omission; a
 * `false` can. The one place this is allowed to be soft is a session that serves
 * no endpoint at all (`Xvfb` is started `-nolisten tcp`), which is still an error
 * here because the hosted viewer has nothing to attach to — it is simply a
 * different, clearer code.
 */
export function assertLoopbackDesktopEndpoint(
  endpoint: HostedDesktopEndpoint | null | undefined,
): HostedDesktopEndpoint {
  if (!endpoint) {
    throw new HostedDesktopEndpointError(
      'endpoint_absent',
      'hosted-desktop-channel — this desktop session serves no endpoint (an Xvfb backend is started -nolisten tcp); ' +
        'the hosted viewer requires a kasmvnc session',
    );
  }
  if (endpoint.host !== KASMVNC_LOOPBACK_INTERFACE) {
    throw new HostedDesktopEndpointError(
      'endpoint_not_loopback',
      `hosted-desktop-channel — refusing to dial ${endpoint.host}: D-020 binds the sandbox listener to ` +
        `${KASMVNC_LOOPBACK_INTERFACE} and the hosted viewer reaches it only through the outbound relay`,
    );
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65_535) {
    throw new HostedDesktopEndpointError(
      'endpoint_port_invalid',
      `hosted-desktop-channel — invalid websocket port ${String(endpoint.port)}`,
    );
  }
  return { host: endpoint.host, port: endpoint.port };
}

/*
 * The viewer heartbeat cadence used to live here. It moved to
 * `./desktop-lifecycle` when P-014 gave the LOCAL viewer lane a heartbeat too:
 * the value is a pure derivation of that file's idle-threshold table, and two
 * lanes in different directories now depend on it, so it belongs beside the
 * policy it derives from rather than inside the hosted lane's channel module.
 * Import `desktopViewerHeartbeatMs` / `DESKTOP_VIEWER_HEARTBEAT_DIVISOR` from
 * `./desktop-lifecycle`.
 */

/**
 * A viewer channel's identity, as the adapter tracks it while attached.
 *
 * `desktopSessionId` is what the heartbeat touches; `action` is what the audit
 * trail records. Both are captured at attach time so a detach can be audited
 * even after the underlying session row is gone.
 */
export interface HostedDesktopAttachment {
  channelId: string;
  desktopSessionId: string;
  action: HostedDesktopAction;
  endpoint: HostedDesktopEndpoint;
}

/**
 * Whether the registry row should still be heartbeated.
 *
 * Expressed over the attached SET rather than a per-channel flag: two tabs
 * watching one desktop is one heartbeat, and closing one of them must not stop
 * it. Returning false is the signal to clear the interval.
 */
export function desktopViewersHold(attachments: ReadonlyMap<string, HostedDesktopAttachment>): boolean {
  return attachments.size > 0;
}
