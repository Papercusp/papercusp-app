/**
 * Operator host binding for `@papercusp/ipc-endpoint-server`.
 *
 * The IPC server itself — wire protocol, dispatch loop, sys:http bridge —
 * is the generic, host-agnostic `@papercusp/ipc-endpoint-server` package
 * (extracted per papercusp-systems-abstraction-2026-05-29, P-030). This
 * file is the thin Papercusp-operator adapter: it supplies the `host`
 * seam (projected-tool lookup + dispatch from the operator's registry,
 * plus the active workspace id) and re-exports a host-bound
 * `startEndpointIpcServer` so existing call sites (the boot site in
 * instrumentation-node.ts and dev_ipc_echo_e2e.test.ts) pass exactly the
 * options they always did — no `host` at the call site.
 *
 * Resolving lookup/dispatch from `@papercusp/agent-mcp` (which re-exports
 * the @papercusp/tooldef engine) is what guarantees the IPC server reads
 * the SAME projected-tool registry singleton that `@/lib/agent-tools`
 * populates at boot. See `apps/operator/lib/endpoint-ipc/PROTOCOL.md` for
 * the wire spec and trust model.
 */

import os from 'node:os';
import path from 'node:path';
import { readdirSync, rmSync } from 'node:fs';
import {
  startEndpointIpcServer as startEndpointIpcServerCore,
  type EndpointIpcServer,
  type IpcEndpointHost,
  type StartEndpointIpcServerOptions as CoreStartEndpointIpcServerOptions,
} from '@papercusp/ipc-endpoint-server';
import {
  lookupByMcpName,
  dispatchProjectedToolStream,
} from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../workspace-registry';
import { readSuperuserToken } from '../superuser-token';

/** The Papercusp-operator host binding for the generic IPC server. */
const operatorHost: IpcEndpointHost = {
  lookupByMcpName,
  dispatchProjectedToolStream,
  getWorkspaceId: () => activeWorkspaceId(),
};

/**
 * Operator-facing options — the generic options minus `host`, which the
 * adapter injects. Lets callers pass `{ socketPath, deps, allowedTools,
 * logger }` exactly as before the extraction.
 */
export type StartEndpointIpcServerOptions = Omit<
  CoreStartEndpointIpcServerOptions,
  'host'
>;

export type { EndpointIpcServer };

/**
 * Operator socket path: `~/.papercusp/sockets/<pid>.sock` (Linux/macOS)
 * or `\\.\pipe\papercusp-<pid>` (Windows). The generic package defaults
 * to a neutral tmpdir path; the operator brand lives here so the Rust
 * sidecar bootstrap finds the socket where it expects.
 *
 * TCP-loopback (WSL2 / Windows desktop): the Windows desktop runs THIS
 * sidecar inside WSL2, where `process.platform==='linux'` — so the Unix
 * branch below would create a Unix socket the Windows-native webview host
 * can't reach, and the named-pipe branch never fires. That is exactly why
 * the endpoint-IPC bypass has been silently OFF on Windows (fact
 * `windows-ipc-bypass-off-wsl2`): the host's guard rejects the non-pipe
 * path → IPC disabled → `/api` falls back to WebView2 HTTP under the
 * ~6-connection-per-host cap. The desktop launcher sets `PAPERCUSP_IPC_TCP=1`
 * (it can't be self-detected from inside WSL2) to request a TCP-loopback
 * endpoint instead: WSL2's localhost-forwarding makes `127.0.0.1:<port>`
 * reachable from the Windows host — the same mechanism that exposes the
 * operator HTTP port. Ephemeral port `0`; the server resolves + reports the
 * real bound port in the discovery file. See WI-3395.
 */
export function defaultSocketPath(pid: number = process.pid): string {
  if (process.env.PAPERCUSP_IPC_TCP === '1') return 'tcp://127.0.0.1:0';
  if (process.platform === 'win32') return `\\\\.\\pipe\\papercusp-${pid}`;
  return path.join(os.homedir(), '.papercusp', 'sockets', `${pid}.sock`);
}

/** Is `pid` a live process? Same semantics as the voice-socket reaper's
 *  `ownerPidAlive` (local-audio-socket.ts): `process.kill(pid,0)` succeeds ⇒
 *  alive; ESRCH ⇒ dead; EPERM ⇒ exists but owned by another user ⇒ treat as
 *  ALIVE (never reap a live process's socket just because we can't signal it). */
function endpointPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * GC orphaned `<pid>.sock` endpoint-ipc files left by operators that never ran a
 * graceful `close()` — a crash, SIGKILL, OOM-kill, or terminal close all skip it,
 * so the file lingers on disk forever (WI-5999). This is the endpoint-ipc sibling
 * of `gcDeadVoiceSockets` (EI-3290) in local-audio-socket.ts, which reaps the
 * SAME `~/.papercusp/sockets/` directory's `voice-<pid>.sock` files — that regex
 * deliberately does not match this bare `<pid>.sock` naming, so the two reapers
 * coexist without stepping on each other's files. Skips our own pid and any file
 * whose pid is still alive. Best-effort + isolated: a readdir/unlink failure
 * never blocks startup. `isAlive` is injectable for tests. Returns the count reaped.
 */
export function gcDeadEndpointSockets(
  dir: string = path.join(os.homedir(), '.papercusp', 'sockets'),
  isAlive: (pid: number) => boolean = endpointPidAlive,
): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // dir absent — nothing to GC
  }
  let reaped = 0;
  for (const name of entries) {
    const m = /^(\d+)\.sock$/.exec(name);
    if (!m) continue; // not our bare-pid naming (e.g. voice-<pid>.sock) — leave it
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isAlive(pid)) continue; // a live operator owns it — keep
    try {
      rmSync(path.join(dir, name), { force: true });
      reaped++;
    } catch {
      /* raced with another reaper / perms — skip */
    }
  }
  return reaped;
}

/**
 * Start the endpoint IPC server bound to the operator host. Thin wrapper
 * over `@papercusp/ipc-endpoint-server` that injects the operator's
 * registry lookup/dispatch + active-workspace resolution, plus the
 * operator-branded handshake token, socket path, and upstream base — the
 * package itself stays project-agnostic.
 */
export function startEndpointIpcServer(
  options: StartEndpointIpcServerOptions = {},
): Promise<EndpointIpcServer> {
  // WI-5999: reap orphaned <pid>.sock files from dead operators before adding
  // ours, so ~/.papercusp/sockets/ doesn't grow unbounded across restarts/crashes.
  // Scoped to ONLY the real, unconfigured production path — i.e. exactly the
  // condition under which `defaultSocketPath()` below resolves to
  // `~/.papercusp/sockets/<pid>.sock`. A caller passing an explicit `socketPath`
  // (every test in this package does, into a tmpdir) or a TCP/named-pipe
  // endpoint never touches this directory, so it's skipped entirely — the same
  // hermeticity `gcDeadVoiceSockets`'s callers get via PAPERCUSP_VOICE_IPC_DIR,
  // achieved here by simply never reaping outside the real default path.
  if (
    options.socketPath === undefined &&
    process.env.PAPERCUSP_IPC_TCP !== '1' &&
    process.platform !== 'win32'
  ) {
    try {
      const dir = path.join(os.homedir(), '.papercusp', 'sockets');
      const reaped = gcDeadEndpointSockets(dir);
      if (reaped > 0) console.error(`[endpoint-ipc] GC'd ${reaped} orphaned endpoint socket(s) from dead pids`);
    } catch {
      /* GC is best-effort — never block IPC startup */
    }
  }
  return startEndpointIpcServerCore({
    ...options,
    host: operatorHost,
    // The Rust client (papercusp-desktop) strips this exact prefix.
    readyToken: options.readyToken ?? 'PAPERCUSP_IPC_READY',
    socketPath: options.socketPath ?? defaultSocketPath(),
    upstreamBaseUrl:
      options.upstreamBaseUrl ??
      process.env.PAPERCUSP_OPERATOR_BASE ??
      // Bootstrap starts IPC before the migration gate lets the HTTP server
      // assign PORT. Match hono-host's listener precedence now; otherwise the
      // socket for an isolated host can proxy every request to another host.
      `http://127.0.0.1:${process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? 3070}`,
    // In-boundary credential for the sys:http bridge. The webview rides IPC
    // for same-origin /api/* fetches, but its HttpOnly `papercusp_session`
    // cookie can't ride the bridge (JS can't forward it nor honor Set-Cookie),
    // so cookie-gated admin routes (`auth: { trust: ['verified','trusted'] }`,
    // per the D3 posture) would see only `unverified-loopback` and 403. The
    // webview is the trusted in-boundary shell — the same boundary that lets
    // endpoint_invoke synthesize an `operator` principal (see server.ts) — so
    // we present the operator's own loopback superuser bearer on the bridge's
    // upstream hop. `principalFromSuperuserToken` resolves it to
    // `trust: 'trusted'` (loopback-gated; NOT the `?superuser=1` gate-bypass),
    // which clears the gate while role/quota/capability checks still run.
    // Read per request so a rotated token is picked up without a restart.
    sysHttpInjectHeaders:
      options.sysHttpInjectHeaders ??
      (() => {
        const token = readSuperuserToken();
        return token ? { authorization: `Bearer ${token}` } : undefined;
      }),
  });
}
