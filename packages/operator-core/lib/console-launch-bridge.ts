/**
 * console-launch-bridge.ts — the Windows desktop-bridge for AGENT-invoked
 * terminal launches (WI-3289).
 *
 * THE GAP THIS CLOSES: on a Windows install the operator runs INSIDE the
 * `papercup-runtime` WSL2 distro. Anything it spawns via WSL interop lands in
 * SESSION 0 — the services window-station — invisible to the interactive
 * desktop (VM-verified 2026-07-02, see native_console.rs D-002 header). The
 * ONLY process that can open a visible terminal is the Session-1
 * `papercusp-desktop.exe` shell, reached through its webview via the Tauri
 * `console_launch` command. The USER path already rides it (native-console.ts
 * falls back to Tauri on a 501); the AGENT path (capability:terminal,
 * fleet:launch-on-plan) had no way there and hard-501'd "Linux/macOS only".
 *
 * THE MECHANISM (same rails as attention.notify, D-007): the operator keeps
 * the secret-capable ConsoleEnvelope in memory and emits only an opaque,
 * single-use ticket on the existing sync SSE bus. The desktop webview's
 * DesktopConsoleLaunchBridge component ignores tickets targeted at a different
 * UI client, redeems its ticket for the envelope (POST
 * /agent-mcp/console/launch-claim), invokes the Tauri `console_launch` command,
 * and reports back (POST
 * /agent-mcp/console/launch-result), which resolves the pending promise.
 * No webview attached / no Tauri / nobody claims → the request times out and
 * the caller gets a loud, actionable error instead of a silent no-window "ok"
 * (the WI-1886 failure class).
 *
 * In-memory by design: a launch request is a live RPC on THIS operator
 * process — an operator restart mid-flight should fail the caller's await,
 * never replay a stale window spawn from persisted state.
 */
import { randomUUID } from 'node:crypto';
import type { ConsoleEnvelope } from './console-launcher';
import { notifySyncInvalidate } from './sync-sse';

/** SSE event name the desktop webview listens for (DesktopConsoleLaunchBridge). */
export const CONSOLE_LAUNCH_REQUEST_EVENT = 'console.launch-request';

/**
 * How long the operator waits for a webview to claim + complete a launch.
 * Generous on purpose: the Rust side may relay fs ops through `wsl.exe`
 * (WI-2149) and cold-start wt.exe; but bounded so a headless/closed desktop
 * fails the agent's call loudly instead of hanging a tool turn.
 */
export const DESKTOP_BRIDGE_TIMEOUT_MS = 30_000;

export interface BridgeLaunchResult {
  ok: boolean;
  /** Windows-namespace pid from Rust's Command::spawn().id() — DISPLAY-ONLY.
   *  Never feed it to WSL-side liveness checks (foreign pid namespace — see
   *  console-record.ts's "deliberately does not accept a pid" header). */
  pid: number | null;
  error: string | null;
}

interface PendingLaunch {
  claimed: boolean;
  envelope: ConsoleEnvelope | null;
  targetClientId: string | null;
  timer: NodeJS.Timeout;
  resolve: (r: BridgeLaunchResult) => void;
}

export interface ConsoleLaunchClaimResult {
  granted: boolean;
  envelope?: ConsoleEnvelope;
}

export interface RemoteWorkspaceConsoleLaunchOptions {
  /** UI client id of the desktop connection that initiated the action. */
  targetClientId: string;
  /** Saved local psu connection profile. It is passed as one validated argv cell. */
  profileName: string;
  cwd?: string;
  timeoutMs?: number;
  label?: string | null;
}

const CONNECTION_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const pending = new Map<string, PendingLaunch>();

/** Test-only visibility: how many requests are currently in flight. */
export function pendingBridgeLaunchCount(): number {
  return pending.size;
}

/**
 * Ask the desktop shell to spawn a terminal for `envelope`. Resolves when a
 * webview reports the Tauri `console_launch` result, or with a timeout error
 * when no desktop shell claims the request in time. Never throws.
 */
export async function requestDesktopConsoleLaunch(opts: {
  envelope: ConsoleEnvelope;
  /** Optional exact UI client target. Null keeps ordinary first-eligible-desktop behavior. */
  targetClientId?: string | null;
  label?: string | null;
  planSlug?: string | null;
  timeoutMs?: number;
}): Promise<BridgeLaunchResult> {
  const ticket = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DESKTOP_BRIDGE_TIMEOUT_MS;
  const targetClientId = opts.targetClientId?.trim() || null;

  const result = new Promise<BridgeLaunchResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(ticket);
      resolve({
        ok: false,
        pid: null,
        error:
          `no desktop shell answered the console-launch request within ${timeoutMs}ms — ` +
          'the Papercusp desktop window must be OPEN (its webview relays the spawn to the ' +
          'Tauri console_launch command; the WSL operator cannot open a Session-1 window itself)',
      });
    }, timeoutMs);
    timer.unref?.();
    pending.set(ticket, {
      claimed: false,
      envelope: opts.envelope,
      targetClientId,
      timer,
      resolve,
    });
  });

  // The envelope remains server-side until the intended desktop atomically
  // redeems the ticket. The SSE stream is observable by every attached SPA;
  // broadcasting raw shell text or env here would turn the sync bus into a
  // secret-bearing transport and let an unrelated webview win the request.
  try {
    await notifySyncInvalidate(CONSOLE_LAUNCH_REQUEST_EVENT, {
      ticket,
      targetClientId,
      label: opts.label ?? null,
      planSlug: opts.planSlug ?? null,
    });
  } catch (e: any) {
    const p = pending.get(ticket);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(ticket);
      return { ok: false, pid: null, error: `sync-bus emit failed: ${e?.message ?? e}` };
    }
  }

  return result;
}

/**
 * Atomically redeem a launch ticket. A target mismatch does not consume it;
 * an accepted claim returns the envelope exactly once and clears the retained
 * copy immediately. Unknown, expired, and replayed tickets are refused.
 */
export function claimConsoleLaunch(ticket: string, clientId: string): ConsoleLaunchClaimResult {
  const p = pending.get(ticket);
  if (!p || p.claimed || !p.envelope || !clientId) return { granted: false };
  if (p.targetClientId && p.targetClientId !== clientId) return { granted: false };
  const envelope = p.envelope;
  p.claimed = true;
  p.envelope = null;
  return { granted: true, envelope };
}

/**
 * Webview callback with the Tauri `console_launch` outcome. Returns false when
 * the request is unknown (expired / double-report) — harmless, just ignored.
 */
export function completeConsoleLaunch(
  ticket: string,
  result: { ok: boolean; pid?: number | null; error?: string | null },
): boolean {
  const p = pending.get(ticket);
  if (!p || !p.claimed) return false;
  clearTimeout(p.timer);
  pending.delete(ticket);
  p.resolve({
    ok: result.ok,
    pid: result.pid ?? null,
    error: result.error ?? (result.ok ? null : 'console_launch failed'),
  });
  return true;
}

/**
 * Request a native terminal that enters a saved remote-workspace connection.
 *
 * The profile name is deliberately the only command-shaped input and is
 * allow-listed to a single shell-safe argv cell. Provider credentials and
 * connection details remain in the local 0600 profile store; neither the SSE
 * event nor the operator-side envelope carries them.
 */
export async function requestRemoteWorkspaceConsoleLaunch(
  opts: RemoteWorkspaceConsoleLaunchOptions,
): Promise<BridgeLaunchResult> {
  if (!CONNECTION_PROFILE_NAME_RE.test(opts.profileName)) {
    return {
      ok: false,
      pid: null,
      error:
        'connection profile name is invalid — expected 1-64 letters, digits, dots, underscores, or hyphens, beginning with a letter or digit',
    };
  }
  if (!opts.targetClientId.trim()) {
    return { ok: false, pid: null, error: 'target client id is required' };
  }

  const envelope: ConsoleEnvelope = {
    cwd: opts.cwd ?? process.cwd(),
    env: {},
    mcpJsonContents: '',
    greetingCmd: `psu --connect=${opts.profileName}`,
    needsSuperuserBootstrap: false,
    sessionId: randomUUID(),
  };
  return requestDesktopConsoleLaunch({
    envelope,
    targetClientId: opts.targetClientId,
    timeoutMs: opts.timeoutMs,
    label: opts.label ?? `Remote workspace · ${opts.profileName}`,
  });
}
