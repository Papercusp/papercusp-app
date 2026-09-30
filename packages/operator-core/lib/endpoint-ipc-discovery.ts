/**
 * Endpoint-IPC socket discovery file — the DEV counterpart to the stdout
 * `PAPERCUSP_IPC_READY socket=<path>` handshake.
 *
 * In the packaged desktop, Tauri spawns the operator as a sidecar with piped
 * stdout and reads the ready line to learn the IPC socket path. In DEV
 * (`npm run dev`), the desktop points its webview at an *externally*-run
 * operator (systemd `papercup-dev-api.service` or `dev:operator`) and so can
 * NOT read that operator's stdout. Without the socket path the Rust side
 * can't open the IPC client, `ipcFetch` falls back to native HTTP, and the
 * webview's on-demand `/api/*` fetches starve behind the long-lived SSE
 * streams in libsoup's 6-socket-per-origin pool — the Plans-tab
 * "loading… forever" bug.
 *
 * Fix: the operator publishes its resolved socket path to
 * `~/.papercusp/endpoint-ipc.json` on boot; the dev desktop polls + reads it
 * (see papercusp-desktop `main.rs` dev branch). Same `~/.papercusp/*.json`
 * convention as `embedded-pg.json`. Writing it in the packaged build too is
 * harmless (that path uses the stdout handshake) and keeps one code path.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, rm, rename, lstat } from 'node:fs/promises';
import { backgroundWorkersEnabled } from './background-workers';

const REL_DIR = '.papercusp';
const REL_FILE = 'endpoint-ipc.json';
/** Private initialize metadata; supplied by the client, never by the model. */
export const AGENT_MCP_AUTH_META = 'com.papercusp/connection';

/**
 * This instance's runtime directory: an explicit PAPERCUSP_HOME isolates it, empty/unset falls back to
 * `~/.papercusp`. The SAME resolution serve.ts uses for operator.json and the native desktop uses to READ this
 * file (papercusp-desktop main.rs `native_papercusp_dir`, EI-24161953656319715). Writer and reader must agree:
 * when they did not, every isolated verifier (VERIFY_TAURI_ISOLATED_DB sets PAPERCUSP_HOME) polled a directory
 * its operator never wrote, and /api sat on the capped HTTP fallback until the origin health check timed out.
 */
function discoveryDir(): string {
  return process.env.PAPERCUSP_HOME || join(homedir(), REL_DIR);
}

/** Absolute path to the discovery file in this instance's runtime directory. */
export function endpointIpcDiscoveryPath(): string {
  return join(discoveryDir(), REL_FILE);
}

/**
 * Per-port discovery file (EI-190). The legacy singleton above is
 * LAST-WRITER-WINS between operators — on the dev box BOTH :3070 (release)
 * and :3170 (staging) boot through host-bootstrap, so the desktop's /api
 * target was whichever operator restarted most recently, and a stale file
 * (dead writer pid) silently degraded /api to the HTTP fallback. Each
 * operator now ALSO publishes `endpoint-ipc.<port>.json`, so a reader can
 * target a specific operator deliberately — the desktop dev-wrapper's build
 * switcher reads the file matching its selected build (papercusp-desktop
 * src-tauri: read_dev_ipc_socket_for_port).
 */
export function endpointIpcDiscoveryPathForPort(port: number): string {
  return join(discoveryDir(), `endpoint-ipc.${port}.json`);
}

export interface EndpointIpcDiscovery {
  /** Unix-socket / named-pipe path the IPC server is listening on. */
  socketPath: string;
  /** Operator pid that owns the socket (lets a reader detect a stale file). */
  pid: number;
  /** Epoch-ms the server came up. */
  startedAt: number;
  /** The hono port this operator serves (EI-190; absent in legacy files). */
  port?: number;
  /** Coarse process role, persisted so request-only hosts can find a bg-host without probing its HTTP event loop. */
  processRole?: EndpointIpcProcessRole;
  /** Optional agent endpoint. Legacy UI readers keep using socketPath above. */
  agentMcp?: AgentMcpEndpoint;
}

export type EndpointIpcProcessRole = 'operator' | 'bg-host';

export interface AgentMcpEndpoint {
  version: 1;
  transport: 'uds';
  socketPath: string;
  operatorId: string;
  generation: string;
}

/** Logical operator identity; generations change at restart, this does not. */
export function agentMcpOperatorId(port: number, home = homedir()): string {
  return createHash('sha256').update(`${home}\0${port}`).digest('hex');
}

function validAgentEndpoint(value: unknown): value is AgentMcpEndpoint {
  const v = value as Partial<AgentMcpEndpoint> | null;
  return !!v && v.version === 1 && v.transport === 'uds' &&
    typeof v.socketPath === 'string' && v.socketPath.startsWith('/') &&
    typeof v.operatorId === 'string' && /^[a-f0-9]{64}$/.test(v.operatorId) &&
    typeof v.generation === 'string' && /^[a-f0-9-]{36}$/.test(v.generation);
}

function publicAgentEndpoint(value: AgentMcpEndpoint): AgentMcpEndpoint {
  const { version, transport, socketPath, operatorId, generation } = value;
  return { version, transport, socketPath, operatorId, generation };
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * Publish the resolved socket path: the per-port file (EI-190) plus the
 * legacy singleton for readers that predate it. Best-effort; throws only on
 * FS failure. The port comes from PAPERCUSP_HONO_PORT (set for the systemd
 * operators and the desktop-spawned sidecar; the sidecar's value is its
 * cold-start hint, which `serve --ensure` reuse may diverge from — harmless,
 * since the packaged desktop learns the socket via the stdout handshake, not
 * this file).
 */
export async function writeEndpointIpcDiscovery(
  socketPath: string,
  options: { agentMcp?: AgentMcpEndpoint; port?: number } = {},
): Promise<void> {
  const dir = discoveryDir();
  await mkdir(dir, { recursive: true });
  const port = options.port ?? (Number(process.env.PAPERCUSP_HONO_PORT) || 3070);
  if (options.agentMcp && !validAgentEndpoint(options.agentMcp)) throw new Error('Invalid MCP endpoint');
  const payload: EndpointIpcDiscovery = {
    socketPath,
    pid: process.pid,
    startedAt: Date.now(),
    port,
    processRole: backgroundWorkersEnabled() ? 'bg-host' : 'operator',
    ...(options.agentMcp ? { agentMcp: publicAgentEndpoint(options.agentMcp) } : {}),
  };
  const body = JSON.stringify(payload, null, 2);
  await writeAtomic(endpointIpcDiscoveryPathForPort(port), body);
  await writeAtomic(endpointIpcDiscoveryPath(), body);
  // EI-18763945004822208 item 2: sweep sibling discovery files whose
  // advertised pid is dead. Not the source of the ENOENT-storm bug (the Rust
  // reader now validates before dialing regardless — see
  // `discovery_socket_still_live` in papercusp-desktop), but ~90 stale
  // advertisements were observed piling up under `~/.papercusp` (mostly from
  // `scripts/verify-tauri-headless.sh`'s 33xxx/34xxx port families, which
  // never clean up after themselves) — hygiene only, best-effort, and must
  // never fail the real write above.
  try {
    await pruneStaleSiblingDiscoveryFiles(dir);
  } catch {
    /* best-effort hygiene only */
  }
}

/** `process.kill(pid, 0)` liveness probe — mirrors the same tiny helper
 * already duplicated in release-checkpoint-launch.ts / idle-session-reaper.ts
 * / test-desktop-reaper.ts (none of them export it, so this follows the same
 * local-copy convention rather than inventing a new shared surface for a
 * three-line check). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = genuinely dead. EPERM means a process WITH that pid exists but
    // we can't signal it (owned by another user) — that still proves alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Delete any `endpoint-ipc(.<port>)?.json` in `dir` whose advertised `pid` is
 * dead. Runs on every publish, so a box that keeps writing discovery files
 * (every dev restart, every headless verify run) also keeps cleaning up
 * after itself instead of accumulating stale entries forever. Never throws:
 * a missing dir, an unreadable/corrupt sibling file, or a delete race (the
 * file's own writer restarted in the meantime) are all silently skipped —
 * this is cleanup, not correctness.
 */
async function pruneStaleSiblingDiscoveryFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((n) => /^endpoint-ipc(\.\d+)?\.json$/.test(n))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          const j = JSON.parse(await readFile(path, 'utf8')) as Partial<EndpointIpcDiscovery>;
          const pid = Number(j?.pid);
          if (Number.isFinite(pid) && pid > 0 && !pidAlive(pid)) {
            await rm(path, { force: true });
          }
        } catch {
          /* unreadable/corrupt/raced-away — leave it for a future sweep */
        }
      }),
  );
}

/** Read the discovery file, or null when missing/corrupt. */
export async function readEndpointIpcDiscovery(): Promise<EndpointIpcDiscovery | null> {
  return readEndpointIpcDiscoveryFrom(endpointIpcDiscoveryPath());
}

/**
 * Read the PER-PORT discovery file (EI-190) for a specific operator port, or
 * null when missing/corrupt. Use this — not the legacy singleton above —
 * whenever the caller knows (or can resolve) which operator it actually cares
 * about: the singleton is LAST-WRITER-WINS across every operator on the box
 * (potentially many concurrent harness/fleet dev sessions each on their own
 * port), so at any given instant it may point at a DIFFERENT operator than
 * the one the caller means, including a dead one (EI-7760: this exact
 * mismatch produced a false "desktop IPC unreachable" alarm — see
 * desktop-health.ts's `resolveDesktopIpcDiscovery`).
 */
export async function readEndpointIpcDiscoveryForPort(port: number): Promise<EndpointIpcDiscovery | null> {
  return readEndpointIpcDiscoveryFrom(endpointIpcDiscoveryPathForPort(port));
}

async function readEndpointIpcDiscoveryFrom(path: string): Promise<EndpointIpcDiscovery | null> {
  try {
    const txt = await readFile(path, 'utf8');
    const j = JSON.parse(txt) as Partial<EndpointIpcDiscovery>;
    if (typeof j?.socketPath === 'string' && j.socketPath) {
      return {
        socketPath: j.socketPath,
        pid: Number(j.pid) || 0,
        startedAt: Number(j.startedAt) || 0,
        ...(Number.isFinite(j.port) ? { port: Number(j.port) } : {}),
        ...(j.processRole === 'operator' || j.processRole === 'bg-host' ? { processRole: j.processRole } : {}),
        ...(validAgentEndpoint(j.agentMcp) ? { agentMcp: publicAgentEndpoint(j.agentMcp) } : {}),
      };
    }
  } catch {
    /* missing / unreadable / corrupt → null */
  }
  return null;
}

/** Native clients must select a build/port, never the last-writer singleton. */
export async function readAgentMcpDiscoveryForPort(
  port: number,
  explicitHome?: string,
): Promise<EndpointIpcDiscovery | null> {
  const home = explicitHome ?? homedir();
  try {
    // No explicit home: read where this instance's operator writes (discoveryDir), so an isolated
    // PAPERCUSP_HOME client finds its own operator rather than the box's default one.
    const file = explicitHome === undefined
      ? endpointIpcDiscoveryPathForPort(port)
      : join(explicitHome, REL_DIR, `endpoint-ipc.${port}.json`);
    const fileStat = await lstat(file);
    if (!fileStat.isFile() || fileStat.uid !== process.getuid?.() || (fileStat.mode & 0o077)) return null;
    const descriptor = await readEndpointIpcDiscoveryFrom(file);
    if (!descriptor?.agentMcp || descriptor.port !== port ||
        descriptor.agentMcp.operatorId !== agentMcpOperatorId(port, home) ||
        !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || !pidAlive(descriptor.pid)) return null;
    const socket = await lstat(descriptor.agentMcp.socketPath);
    const dir = await lstat(dirname(descriptor.agentMcp.socketPath));
    if (!socket.isSocket() || socket.uid !== fileStat.uid || (socket.mode & 0o777) !== 0o600 ||
        !dir.isDirectory() || dir.uid !== fileStat.uid || (dir.mode & 0o777) !== 0o700) return null;
    return descriptor;
  } catch { return null; }
}
