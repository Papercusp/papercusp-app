/**
 * The own tunnel's local processes (external-app-access P-009, D-001):
 *
 *   - the external-ingress listener (P-004), opened through a seam the host registers, so the
 *     wizard can open it without a restart;
 *   - the cloudflared connector (`cloudflared tunnel run`), a managed child with the tunnel's run
 *     token in its ENVIRONMENT (TUNNEL_TOKEN), never on its command line where `ps` would show it;
 *   - the one-click Cloudflare sign-in (`cloudflared tunnel login`), run with an isolated HOME so
 *     it never touches a cert.pem the user already has in ~/.cloudflared.
 *
 * Process state is pinned per process (pinModuleState). Only the operator that owns background
 * work runs the connector; `reconcileOwnTunnel` (service.ts) decides that.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSpawn } from '../task-manager/managed-spawn';
import { parseArgoTunnelCert, parseLoginUrl, type ArgoTunnelLogin } from './config';

export interface IngressListenerSeam {
  /** Open the external-ingress listener on this loopback port (idempotent for the same port). */
  open(port: number): Promise<void> | void;
  close(): Promise<void> | void;
  currentPort(): number | null;
}

interface ConnectorState {
  readonly child: ChildProcess;
  readonly taskId: string | null;
  readonly token: string;
  readonly startedAt: Date;
  exit: { code: number | null; signal: string | null; at: Date } | null;
  readonly logTail: string[];
}

export type LoginState = 'waiting' | 'complete' | 'failed';
interface LoginSession {
  readonly child: ChildProcess;
  readonly homeDir: string;
  state: LoginState;
  loginUrl: string | null;
  login: ArgoTunnelLogin | null;
  error: string | null;
  output: string;
}

const state = pinModuleState('@papercusp/operator-core.own-tunnel.runtime', () => ({
  ingress: null as IngressListenerSeam | null,
  connector: null as ConnectorState | null,
  login: null as LoginSession | null,
}));

const LOG_TAIL_LINES = 40;
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

// ── external-ingress listener seam ──────────────────────────────────────────────────────────────

export function configureIngressListener(seam: IngressListenerSeam | null): void {
  state.ingress = seam;
}

export function ingressListenerPort(): number | null {
  return state.ingress?.currentPort() ?? null;
}

/** Make the listener match `port` (null closes it). False when no host registered the seam. */
export async function ensureIngressListener(port: number | null): Promise<boolean> {
  const seam = state.ingress;
  if (!seam) return false;
  const current = seam.currentPort();
  if (port === null) {
    if (current !== null) await seam.close();
    return true;
  }
  if (current === port) return true;
  if (current !== null) await seam.close();
  await seam.open(port);
  return true;
}

// ── cloudflared binary ──────────────────────────────────────────────────────────────────────────

export function papercuspDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAPERCUSP_HOME?.trim() || path.join(homedir(), '.papercusp');
}

/**
 * Where cloudflared is: PAPERCUSP_CLOUDFLARED_BIN, then Papercusp's own bin directory, then PATH.
 * Null when it is not installed; the wizard then tells the user how to install it.
 */
export function resolveCloudflaredBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const explicit = env.PAPERCUSP_CLOUDFLARED_BIN?.trim();
  if (explicit) return isFile(explicit) ? explicit : null;
  const own = path.join(papercuspDataDir(env), 'bin', exe);
  if (isFile(own)) return own;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

// ── connector ───────────────────────────────────────────────────────────────────────────────────

export interface StartConnectorOptions {
  readonly bin: string;
  /** Tests pass a plain spawn; production uses the task ledger (managedSpawn). */
  readonly spawnChild?: (bin: string, args: string[], options: SpawnOptions) => Promise<{ child: ChildProcess; taskId: string | null }>;
}

async function defaultSpawnChild(bin: string, args: string[], options: SpawnOptions) {
  const res = await managedSpawn(
    bin,
    args,
    {
      class: 'sidecar',
      title: 'own-tunnel:cloudflared',
      argv: [bin, ...args],
      launchedBy: 'own-tunnel:runtime',
      planSlug: 'external-app-access-to-workspaces-2026-09-29',
      detail: { subsystem: 'own-tunnel', provider: 'cloudflare' },
    },
    { spawnOptions: options },
  );
  return { child: res.child, taskId: res.taskId };
}

function pushTail(tail: string[], chunk: Buffer | string) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    tail.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
    if (tail.length > LOG_TAIL_LINES) tail.shift();
  }
}

export function connectorRunning(): boolean {
  const c = state.connector;
  return !!c && c.exit === null;
}

/** Start `cloudflared tunnel run` with this run token; a no-op when it already runs with it. */
export async function startConnector(runToken: string, opts: StartConnectorOptions): Promise<void> {
  if (connectorRunning() && state.connector!.token === runToken) return;
  await stopConnector();
  const args = ['tunnel', '--no-autoupdate', 'run'];
  const { child, taskId } = await (opts.spawnChild ?? defaultSpawnChild)(opts.bin, args, {
    env: { ...process.env, TUNNEL_TOKEN: runToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const conn: ConnectorState = { child, taskId, token: runToken, startedAt: new Date(), exit: null, logTail: [] };
  child.stdout?.on('data', (d) => pushTail(conn.logTail, d));
  child.stderr?.on('data', (d) => pushTail(conn.logTail, d));
  child.on('exit', (code, signal) => {
    conn.exit = { code, signal: signal ?? null, at: new Date() };
  });
  child.on('error', (err) => {
    pushTail(conn.logTail, `spawn error: ${err.message}`);
    conn.exit ??= { code: null, signal: null, at: new Date() };
  });
  state.connector = conn;
}

export async function stopConnector(timeoutMs = 5_000): Promise<void> {
  const c = state.connector;
  if (!c || c.exit !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      c.child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    t.unref?.();
    c.child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    c.child.kill('SIGTERM');
  });
}

export interface ConnectorStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly taskId: string | null;
  readonly startedAt: string | null;
  readonly exit: { code: number | null; signal: string | null; at: string } | null;
  readonly logTail: readonly string[];
}

export function connectorStatus(): ConnectorStatus {
  const c = state.connector;
  if (!c) return { running: false, pid: null, taskId: null, startedAt: null, exit: null, logTail: [] };
  return {
    running: c.exit === null,
    pid: c.child.pid ?? null,
    taskId: c.taskId,
    startedAt: c.startedAt.toISOString(),
    exit: c.exit ? { ...c.exit, at: c.exit.at.toISOString() } : null,
    // The run token never reaches a log line we return (cloudflared does not print it; belt and braces).
    logTail: c.logTail.map((l) => l.split(c.token).join('[run-token]')),
  };
}

// ── one-click Cloudflare sign-in ────────────────────────────────────────────────────────────────

export function loginHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(papercuspDataDir(env), 'cloudflared-login');
}

/**
 * Start `cloudflared tunnel login` under an isolated HOME and wait (briefly) for the sign-in URL.
 * The user opens the URL, picks a zone, and cloudflared writes cert.pem; `loginStatus` then reports
 * the account, zone and API token it holds.
 */
export async function startLogin(opts: {
  bin: string;
  homeDir?: string;
  spawnFn?: typeof spawn;
  urlWaitMs?: number;
}): Promise<{ loginUrl: string | null; state: LoginState }> {
  cancelLogin();
  const homeDir = opts.homeDir ?? loginHomeDir();
  const certDir = path.join(homeDir, '.cloudflared');
  mkdirSync(certDir, { recursive: true, mode: 0o700 });
  const cert = path.join(certDir, 'cert.pem');
  // cloudflared refuses to overwrite an existing cert; keep the old one aside rather than delete it.
  if (existsSync(cert)) renameSync(cert, `${cert}.prev-${Date.now()}`);

  const child = (opts.spawnFn ?? spawn)(opts.bin, ['tunnel', 'login'], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const session: LoginSession = { child, homeDir, state: 'waiting', loginUrl: null, login: null, error: null, output: '' };
  state.login = session;
  const onData = (d: Buffer | string) => {
    session.output = (session.output + String(d)).slice(-8000);
    session.loginUrl ??= parseLoginUrl(session.output);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const killer = setTimeout(() => {
    if (session.state === 'waiting') {
      session.state = 'failed';
      session.error = 'Cloudflare sign-in timed out after 10 minutes';
      child.kill('SIGTERM');
    }
  }, LOGIN_TIMEOUT_MS);
  killer.unref?.();
  child.on('error', (err) => {
    session.state = 'failed';
    session.error = err.message;
  });
  child.on('exit', (code) => {
    clearTimeout(killer);
    if (session.state !== 'waiting') return;
    const parsed = existsSync(cert) ? parseArgoTunnelCert(readFileSync(cert, 'utf8')) : null;
    if (code === 0 && parsed) {
      session.state = 'complete';
      session.login = parsed;
    } else {
      session.state = 'failed';
      session.error = parsed ? `cloudflared exited with ${code}` : `sign-in did not complete (cloudflared exited with ${code})`;
    }
  });

  const deadline = Date.now() + (opts.urlWaitMs ?? 10_000);
  while (session.state === 'waiting' && !session.loginUrl && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { loginUrl: session.loginUrl, state: session.state };
}

export interface LoginStatus {
  readonly state: LoginState | 'idle';
  readonly loginUrl: string | null;
  readonly error: string | null;
  readonly accountId: string | null;
  readonly zoneId: string | null;
}

export function loginStatus(): LoginStatus {
  const s = state.login;
  if (!s) return { state: 'idle', loginUrl: null, error: null, accountId: null, zoneId: null };
  return { state: s.state, loginUrl: s.loginUrl, error: s.error, accountId: s.login?.accountId ?? null, zoneId: s.login?.zoneId ?? null };
}

/** The completed sign-in, with its API token (server-side only). */
export function completedLogin(): ArgoTunnelLogin | null {
  return state.login?.state === 'complete' ? state.login.login : null;
}

export function cancelLogin(): void {
  const s = state.login;
  if (s && s.state === 'waiting') {
    s.state = 'failed';
    s.error = 'cancelled';
    s.child.kill('SIGTERM');
  }
  state.login = null;
}
