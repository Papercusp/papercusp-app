/**
 * Agent spawn transform — the one seam that decides WHICH IDENTITY an agent
 * CLI child runs as.
 *
 * `runAgentChat` stages its per-spawn config dirs (CODEX_HOME, the omp agent
 * dir, an isolated claude config dir) and then asks {@link planAgentSpawn} how
 * to spawn. With no transform configured (dev box, desktop) the answer is the
 * spawn exactly as staged. A host that must run customer-driven agents under a
 * DIFFERENT OS identity (a hosted workspace host: plan
 * byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 D-421) configures a transform
 * once at boot; {@link buildLoopbackIdentitySpawn} is the generic transform for
 * "run it as another local account reached through a command transport such
 * as loopback SSH".
 *
 * Why a transport and not setuid: the operator runs with NoNewPrivileges, so a
 * UID transition cannot happen in-process. The transport already authenticates
 * as the target account, and the staged files travel in a length-prefixed
 * header on stdin to a small inline wrapper that recreates them under the
 * target account's home — nothing is written to a path both identities share.
 *
 * What crosses to the target identity is deliberately narrow: the staged
 * files, the spawn's argv, and ONLY the environment keys the spawn itself
 * added or changed relative to the operator's own environment. The operator's
 * inherited environment (its tokens, database URLs, service config) is never
 * forwarded.
 */

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';

/** A per-spawn directory `runAgentChat` staged locally before spawning. */
export interface AgentSpawnStagedDir {
  readonly path: string;
  /**
   * True for a caller-owned dir that must survive across turns (a resumable
   * session store). It maps to a stable remote path and is never deleted.
   */
  readonly persistent: boolean;
}

export interface AgentSpawnRequest {
  readonly backend: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  /** The environment the spawn would run with (the operator env plus spawn additions). */
  readonly env: NodeJS.ProcessEnv;
  readonly stagedDirs: readonly AgentSpawnStagedDir[];
}

export interface AgentSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** Bytes the caller writes to the child's stdin before anything else. */
  readonly stdinPrelude?: Buffer;
  /** Human-readable identity label for logs, e.g. `papercusp-workspace@127.0.0.1`. */
  readonly identity?: string;
}

export type AgentSpawnTransform = (request: AgentSpawnRequest) => AgentSpawnPlan;

const state = pinModuleState('@papercusp/papercusp-shared.agent-spawn-transform', () => ({
  transform: undefined as AgentSpawnTransform | undefined,
}));

/** Install (or with `undefined`, remove) the process-wide agent spawn transform. */
export function configureAgentSpawnTransform(transform: AgentSpawnTransform | undefined): void {
  state.transform = transform;
}

/** Whether a transform is installed — for diagnostics and tests. */
export function agentSpawnTransformConfigured(): boolean {
  return state.transform !== undefined;
}

/** Resolve how to spawn: the installed transform's plan, or the request unchanged. */
export function planAgentSpawn(request: AgentSpawnRequest): AgentSpawnPlan {
  const transform = state.transform;
  if (!transform) {
    return { command: request.command, args: [...request.args], cwd: request.cwd, env: request.env };
  }
  return transform(request);
}

/** A symlink the wrapper creates inside a mapped dir when the name is absent there. */
export interface LoopbackIdentityHomeLink {
  /** Env var whose (mapped) value names the directory to link into. */
  readonly envVar: string;
  /** Entry name inside that directory, e.g. `auth.json`. */
  readonly name: string;
  /** Target path relative to the target identity's home, e.g. `.codex/auth.json`. */
  readonly homeRelative: string;
}

export interface LoopbackIdentitySpawnOptions {
  /** Transport executable, e.g. `/usr/bin/ssh`. */
  readonly transportCommand: string;
  /** Transport argv up to and including the destination; the remote command is appended. */
  readonly transportArgs: readonly string[];
  /** Label recorded on the plan. */
  readonly identity: string;
  /** Absolute node binary the target identity can execute (runs the inline wrapper). */
  readonly nodePath: string;
  /** Absolute home directory of the target identity. */
  readonly remoteHome: string;
  /** Absolute directory under `remoteHome` where per-spawn dirs are materialized. */
  readonly spawnRoot: string;
  /** The operator's own home; PATH entries under it are not forwarded. */
  readonly localHome: string;
  /** The environment to diff against — normally `process.env`. */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Keys forwarded from the spawn env even when unchanged, e.g. `LANG`. */
  readonly passthroughEnv?: readonly string[];
  /**
   * Explicit PATH for the target identity. When set it REPLACES the forwarded
   * operator PATH entirely: the operator's PATH can name directories the
   * target identity cannot read (a release tree holding launcher wrappers),
   * and a bare agent command resolved through one of those fails with a bare
   * EACCES instead of a named error (plan byoc D-423).
   */
  readonly remotePath?: readonly string[];
  readonly homeLinks?: readonly LoopbackIdentityHomeLink[];
  /**
   * Secrets that must never reach the target identity. If any appears in the
   * forwarded argv, env or staged files the spawn is REFUSED.
   */
  readonly forbiddenSecrets?: readonly string[];
  /** Upper bound on the total bytes of staged files shipped per spawn. */
  readonly maxShippedBytes?: number;
  /** Id source for the ephemeral spawn dir; injectable for tests. */
  readonly newId?: () => string;
}

export class AgentSpawnRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentSpawnRefusedError';
  }
}

/** Header version understood by {@link LOOPBACK_IDENTITY_WRAPPER_SOURCE}. */
export const LOOPBACK_IDENTITY_HEADER_VERSION = 1;

interface HeaderFile { readonly path: string; readonly mode: number; readonly data: string }
interface HeaderLink { readonly path: string; readonly target: string }
export interface LoopbackIdentityHeader {
  readonly v: number;
  readonly dirs: readonly string[];
  readonly files: readonly HeaderFile[];
  readonly links: readonly HeaderLink[];
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** Ephemeral dirs the wrapper removes after the agent exits. */
  readonly cleanup: readonly string[];
}

const DEFAULT_MAX_SHIPPED_BYTES = 16 * 1024 * 1024;

/**
 * Inline wrapper run as the target identity (`node -e`). Reads `<len>\n<json>`
 * from stdin exactly (no over-read), recreates the staged dirs/files/links,
 * spawns the agent with the header's env, pipes the REST of stdin to it, and
 * tears the agent down if the transport session goes away.
 */
export const LOOPBACK_IDENTITY_WRAPPER_SOURCE = String.raw`'use strict';
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
function readExact(n) { const b = Buffer.alloc(n); let o = 0; while (o < n) { let r; try { r = fs.readSync(0, b, o, n - o, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; } if (r === 0) throw new Error('agent spawn header truncated'); o += r; } return b; }
let len = ''; for (;;) { const c = readExact(1).toString('latin1'); if (c === '\n') break; len += c; if (!/^[0-9]{1,10}$/.test(len)) throw new Error('agent spawn header length invalid'); }
const h = JSON.parse(readExact(Number(len)).toString('utf8'));
if (h.v !== 1) throw new Error('agent spawn header version ' + h.v + ' unsupported');
for (const d of h.dirs) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
for (const f of h.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true, mode: 0o700 }); fs.writeFileSync(f.path, Buffer.from(f.data, 'base64'), { mode: f.mode }); fs.chmodSync(f.path, f.mode); }
for (const l of h.links) { let present = false; try { fs.lstatSync(l.path); present = true; } catch {} if (!present && fs.existsSync(l.target)) fs.symlinkSync(l.target, l.path); }
const child = cp.spawn(h.argv[0], h.argv.slice(1), { cwd: h.cwd, env: h.env, stdio: ['pipe', 'inherit', 'inherit'], detached: true });
const cleanup = () => { for (const d of h.cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };
const kill = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => kill(sig));
const parent = process.ppid;
const watch = setInterval(() => { if (process.ppid !== parent) kill('SIGTERM'); }, 2000);
child.on('error', (e) => { process.stderr.write('agent spawn failed: ' + e.message + '\n'); clearInterval(watch); cleanup(); process.exit(127); });
child.on('exit', (code, signal) => { clearInterval(watch); cleanup(); process.exit(code == null ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code); });
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function walkFiles(root: string, out: { rel: string; mode: number; data: Buffer }[], rel = ''): void {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = join(root, entryRel);
    const st = lstatSync(full);
    if (st.isDirectory()) walkFiles(root, out, entryRel);
    else if (st.isFile()) out.push({ rel: entryRel, mode: st.mode & 0o777, data: readFileSync(full) });
    // Symlinks are not shipped: they point into the OPERATOR's filesystem
    // (e.g. its own ~/.codex/auth.json). Target-home links are declared via
    // `homeLinks` instead, so they resolve inside the target identity's home.
  }
}

/**
 * Build a transform that runs every agent spawn as another local account
 * reached through `transportCommand transportArgs… <remote command>`.
 */
export function buildLoopbackIdentitySpawn(options: LoopbackIdentitySpawnOptions): AgentSpawnTransform {
  const maxBytes = options.maxShippedBytes ?? DEFAULT_MAX_SHIPPED_BYTES;
  const newId = options.newId ?? randomUUID;
  const forbidden = (options.forbiddenSecrets ?? []).filter((s) => s.length >= 8);

  return (request) => {
    const spawnId = newId();
    const ephemeralRoot = posix.join(options.spawnRoot, spawnId);
    const mapping = request.stagedDirs.map((dir, index) => {
      const remote = dir.persistent
        ? posix.join(options.spawnRoot, 'persist', createHash('sha256').update(dir.path).digest('hex').slice(0, 16))
        : posix.join(ephemeralRoot, `${index}-${basename(dir.path)}`);
      return { local: dir.path, remote, persistent: dir.persistent };
    });
    // Longest local path first so a nested staged dir wins over its parent.
    const ordered = [...mapping].sort((a, b) => b.local.length - a.local.length);
    const mapValue = (value: string): string => {
      let result = value;
      for (const m of ordered) result = result.split(m.local).join(m.remote);
      return result;
    };

    const files: HeaderFile[] = [];
    let shipped = 0;
    for (const m of mapping) {
      const found: { rel: string; mode: number; data: Buffer }[] = [];
      walkFiles(m.local, found);
      for (const f of found) {
        shipped += f.data.length;
        if (shipped > maxBytes) {
          throw new AgentSpawnRefusedError('agent_spawn_payload_too_large', `staged files exceed ${maxBytes} bytes`);
        }
        files.push({ path: posix.join(m.remote, f.rel), mode: f.mode, data: f.data.toString('base64') });
      }
    }

    const env: Record<string, string> = {};
    for (const key of options.passthroughEnv ?? []) {
      const value = request.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(request.env)) {
      if (value === undefined || key === 'PATH') continue;
      if (options.baseEnv[key] === value) continue;
      env[key] = mapValue(value);
    }
    if (env.HOME === undefined) env.HOME = options.remoteHome;
    if (options.remotePath) {
      env.PATH = options.remotePath.join(':');
    } else {
      const localHome = options.localHome.replace(/\/+$/, '');
      const forwardedPath = (request.env.PATH ?? '')
        .split(':')
        .filter((entry) => entry && entry !== localHome && !entry.startsWith(`${localHome}/`));
      env.PATH = [posix.join(options.remoteHome, '.local', 'bin'), ...forwardedPath].join(':');
    }

    const links: HeaderLink[] = [];
    for (const link of options.homeLinks ?? []) {
      const dir = env[link.envVar];
      if (!dir) continue;
      links.push({ path: posix.join(dir, link.name), target: posix.join(options.remoteHome, link.homeRelative) });
    }

    const argv = [request.command, ...request.args.map(mapValue)];
    const mappedCwd = request.cwd === undefined ? undefined : mapValue(request.cwd);
    const cwd = mappedCwd !== undefined && mapping.some((m) => mappedCwd.startsWith(m.remote))
      ? mappedCwd
      : options.remoteHome;

    const header: LoopbackIdentityHeader = {
      v: LOOPBACK_IDENTITY_HEADER_VERSION,
      dirs: [options.spawnRoot, ...mapping.map((m) => m.remote)],
      files,
      links,
      argv,
      env,
      cwd,
      cleanup: mapping.some((m) => !m.persistent) ? [ephemeralRoot] : [],
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');

    if (forbidden.length > 0) {
      const decodedFiles = files.map((f) => Buffer.from(f.data, 'base64'));
      const plainText = JSON.stringify({ argv, env });
      for (const secret of forbidden) {
        if (plainText.includes(secret) || decodedFiles.some((data) => data.includes(secret))) {
          throw new AgentSpawnRefusedError(
            'agent_spawn_forbidden_secret',
            `refusing to run an agent as ${options.identity}: a forbidden operator secret would cross to that identity`,
          );
        }
      }
    }

    return {
      command: options.transportCommand,
      args: [
        ...options.transportArgs,
        `exec ${shellQuote(options.nodePath)} -e ${shellQuote(LOOPBACK_IDENTITY_WRAPPER_SOURCE)}`,
      ],
      cwd: undefined,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: options.localHome },
      stdinPrelude: Buffer.concat([Buffer.from(`${json.length}\n`, 'latin1'), json]),
      identity: options.identity,
    };
  };
}
