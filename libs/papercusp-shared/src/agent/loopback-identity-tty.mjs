/**
 * D-424 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, P-326, WI-10003195): run an
 * INTERACTIVE agent CLI — psu's PTY child — as another local account reached over a loopback
 * transport (on a hosted workspace host: the customer workspace account, over the pinned
 * loopback SSH vector).
 *
 * WHY THIS IS NOT `buildLoopbackIdentitySpawn` (spawn-transform.ts). That transform serves the
 * non-interactive chat path: it streams its setup header over the transport's STDIN and pipes
 * the rest of stdin to the agent. A New Session runs the agent's TUI inside a PTY, so the
 * transport must allocate a remote TTY (`ssh -tt`) and stdin IS the terminal — a header written
 * into it would be echoed and line-disciplined. So the TTY path runs in two hops:
 *
 *   stage  non-TTY transport, header on stdin: create the spawn dirs, write the shipped files and
 *          home links, assert claude's pre-turn launch flags on the target account (P-326, see
 *          claudeLaunchReadiness), and write the exec header (argv/env/cwd) to a 0600 file. Prints
 *          its path.
 *   exec   TTY transport: `node -e <exec wrapper> <header path>` reads + unlinks the header and
 *          runs the agent with the remote TTY inherited, cleaning the spawn dir on exit.
 *
 * Plain .mjs (with a .d.mts) so psu — plain node, no TS loader — and the TS operator import ONE
 * implementation, the same arrangement as model-capacity.mjs.
 *
 * What crosses to the target account is deliberately narrow: only argv files under an explicit
 * `shipFileRoots` allowlist (psu's rendered system-prompt file), and only allowlisted env names,
 * never one that looks like a credential. The target account's own agent config (its credential,
 * MCP servers, hooks) is what the agent uses; the operator's is never forwarded (D-422).
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, posix, resolve as resolvePath, sep } from 'node:path';

/** psu reads the operator-built spec from this env var; absent means "spawn as yourself". */
export const AGENT_IDENTITY_SPEC_ENV = 'PAPERCUSP_AGENT_IDENTITY_SPEC';
export const AGENT_IDENTITY_SPEC_VERSION = 1;
const HEADER_VERSION = 1;
const DEFAULT_MAX_SHIPPED_BYTES = 16 * 1024 * 1024;
const DEFAULT_STAGE_TIMEOUT_MS = 30_000;
const SUPPORTED_BACKENDS = new Set(['claude', 'codex', 'omp']);
/** Env names that look like a credential never cross, whatever the allowlist says. */
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|CREDENTIAL|COOKIE|PRIVATE)/i;
const BASE_ENV_ALLOW = ['TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NO_COLOR', 'FORCE_COLOR'];
/**
 * P-326: the per-cwd `~/.claude.json` flags that gate an interactive prompt in the claude TUI.
 * Same set psu's local launch pre-accepts (operator-core `ensureProjectTrust`); a prompt nobody
 * can answer parks the agent before its first turn.
 */
export const CLAUDE_PROJECT_LAUNCH_FLAGS = Object.freeze([
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
  'hasCompletedProjectOnboarding',
]);

export class AgentIdentityTtyRefusedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentIdentityTtyRefusedError';
    this.code = code;
  }
}

const refused = (code, message) => new AgentIdentityTtyRefusedError(code, message);

const READ_HEADER = String.raw`function readExact(n) { const b = Buffer.alloc(n); let o = 0; while (o < n) { let r; try { r = fs.readSync(0, b, o, n - o, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; } if (r === 0) throw new Error('agent stage header truncated'); o += r; } return b; }
let len = ''; for (;;) { const c = readExact(1).toString('latin1'); if (c === '\n') break; len += c; if (!/^[0-9]{1,10}$/.test(len)) throw new Error('agent stage header length invalid'); }
const h = JSON.parse(readExact(Number(len)).toString('utf8'));`;

/** Stage hop, run as the target account with the header on stdin. */
export const AGENT_IDENTITY_TTY_STAGE_SOURCE = String.raw`'use strict';
const fs = require('fs'); const path = require('path');
${READ_HEADER}
if (h.v !== 1) throw new Error('agent stage header version ' + h.v + ' unsupported');
for (const d of h.dirs) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
for (const f of h.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true, mode: 0o700 }); fs.writeFileSync(f.path, Buffer.from(f.data, 'base64'), { mode: f.mode }); fs.chmodSync(f.path, f.mode); }
for (const l of h.links) { let present = false; try { fs.lstatSync(l.path); present = true; } catch {} if (!present && fs.existsSync(l.target)) fs.symlinkSync(l.target, l.path); }
const assertJson = (file, mutate) => {
  let cur = {};
  if (fs.existsSync(file)) {
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { process.stderr.write('agent stage: left unparseable ' + file + ' untouched: ' + e.message + '\n'); return; }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) { process.stderr.write('agent stage: left non-object ' + file + ' untouched\n'); return; }
  }
  if (!mutate(cur)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.agent-stage.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const r = h.claudeLaunchReady;
if (r) {
  assertJson(r.globalConfigPath, (c) => {
    let changed = false;
    if (c.hasCompletedOnboarding !== true) { c.hasCompletedOnboarding = true; changed = true; }
    if (!c.projects || typeof c.projects !== 'object' || Array.isArray(c.projects)) { c.projects = {}; changed = true; }
    const p = c.projects[r.cwd] && typeof c.projects[r.cwd] === 'object' ? c.projects[r.cwd] : {};
    for (const k of r.projectFlags) if (p[k] !== true) { p[k] = true; changed = true; }
    c.projects[r.cwd] = p;
    return changed;
  });
  assertJson(r.settingsPath, (s) => {
    if (s.skipDangerousModePermissionPrompt === true) return false;
    s.skipDangerousModePermissionPrompt = true;
    return true;
  });
}
fs.writeFileSync(h.execHeaderPath, JSON.stringify({ v: 1, argv: h.argv, env: h.env, cwd: h.cwd, cleanup: h.cleanup }), { mode: 0o600, flag: 'wx' });
process.stdout.write(h.execHeaderPath + '\n');
`;

/**
 * Exec hop, run as the target account under the remote TTY. The agent stays in this process's
 * foreground group (NOT detached): the TTY delivers ^C and SIGWINCH to the whole group, so this
 * wrapper ignores SIGINT/SIGQUIT and forwards only the hang-up/termination signals.
 */
export const AGENT_IDENTITY_TTY_EXEC_SOURCE = String.raw`'use strict';
const fs = require('fs'); const cp = require('child_process');
const file = process.argv[1];
let h;
try { h = JSON.parse(fs.readFileSync(file, 'utf8')); } finally { try { fs.unlinkSync(file); } catch {} }
const cleanup = () => { for (const d of h.cleanup || []) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };
if (h.v !== 1) { process.stderr.write('agent exec header version ' + h.v + ' unsupported\n'); cleanup(); process.exit(126); }
const child = cp.spawn(h.argv[0], h.argv.slice(1), { cwd: h.cwd, env: h.env, stdio: 'inherit' });
process.on('SIGINT', () => {}); process.on('SIGQUIT', () => {});
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on('error', (e) => { process.stderr.write('agent spawn failed: ' + e.message + '\n'); cleanup(); process.exit(127); });
child.on('exit', (code, signal) => { cleanup(); process.exit(code == null ? 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGHUP' ? 1 : 15) : code); });
`;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function requireString(spec, key) {
  const value = spec[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw refused('agent_identity_spec_invalid', `agent identity spec: '${key}' must be a non-empty string`);
  }
  return value;
}

function requireTransport(spec, key) {
  const t = spec[key];
  if (!t || typeof t.command !== 'string' || !Array.isArray(t.args) || !t.args.every((a) => typeof a === 'string')) {
    throw refused('agent_identity_spec_invalid', `agent identity spec: '${key}' must be { command, args: string[] }`);
  }
  return t;
}

function stringArray(spec, key) {
  const value = spec[key] ?? [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw refused('agent_identity_spec_invalid', `agent identity spec: '${key}' must be a string array`);
  }
  return value;
}

/** Parse + validate a spec (a JSON string from the env, or an object). */
export function parseAgentIdentitySpec(raw) {
  let spec = raw;
  if (typeof raw === 'string') {
    try {
      spec = JSON.parse(raw);
    } catch (error) {
      throw refused('agent_identity_spec_invalid', `agent identity spec is not JSON: ${error.message}`);
    }
  }
  if (!spec || typeof spec !== 'object') throw refused('agent_identity_spec_invalid', 'agent identity spec must be an object');
  if (spec.v !== AGENT_IDENTITY_SPEC_VERSION) {
    throw refused('agent_identity_spec_invalid', `agent identity spec version ${spec.v} unsupported`);
  }
  for (const key of ['identity', 'nodePath', 'toolchainBin', 'remoteHome', 'spawnRoot', 'localHome']) requireString(spec, key);
  requireTransport(spec, 'stageTransport');
  requireTransport(spec, 'execTransport');
  for (const key of ['remotePath', 'shipFileRoots', 'envAllow', 'envAllowPrefixes', 'forbiddenSecretFiles']) stringArray(spec, key);
  if (stringArray(spec, 'remotePath').length === 0) {
    throw refused('agent_identity_spec_invalid', "agent identity spec: 'remotePath' must name at least one directory");
  }
  return spec;
}

function underRoot(path, roots) {
  const target = resolvePath(path);
  return roots.some((root) => {
    const r = resolvePath(root);
    return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

function readSecrets(files, readFile) {
  const secrets = [];
  for (const file of files) {
    try {
      const value = String(readFile(file, 'utf8')).trim();
      if (value.length >= 16) secrets.push(value);
    } catch {
      /* an absent secret file cannot leak */
    }
  }
  return secrets;
}

/**
 * P-326: where the TARGET account's claude keeps the state its TUI consults before the first
 * turn. psu launches claude interactively (`--dangerously-skip-permissions`, a kickoff turn), and
 * psu's own launch-readiness self-heal only ever touched the SPAWNING account's home — so on a
 * hosted host every New Session parked on the first-run wizard / folder-trust / bypass-accept
 * prompts that nobody can answer (measured on owner-test r55: no transcript after 3m20s; the same
 * launch took its turn once these flags were set). The stage hop, which already runs as the
 * target, asserts exactly these flags: idempotent, every other key preserved, never a credential
 * or MCP server (D-422 — the account's own agent config stays what the agent uses).
 */
function claudeLaunchReadiness(env, remoteHome, cwd) {
  const configDir = env.CLAUDE_CONFIG_DIR;
  return {
    globalConfigPath: configDir ? posix.join(configDir, '.claude.json') : posix.join(remoteHome, '.claude.json'),
    settingsPath: posix.join(configDir ?? posix.join(remoteHome, '.claude'), 'settings.json'),
    cwd,
    projectFlags: [...CLAUDE_PROJECT_LAUNCH_FLAGS],
  };
}

/**
 * Pure planning: the stage hop (command, args, stdin) and the exec hop (the PTY command).
 * `request` is exactly what psu would have spawned: { command, args, env, cwd }.
 */
export function planAgentIdentityTty(rawSpec, request, deps = {}) {
  const spec = parseAgentIdentitySpec(rawSpec);
  const exists = deps.exists ?? existsSync;
  const stat = deps.stat ?? statSync;
  const readFile = deps.readFile ?? readFileSync;
  const newId = deps.newId ?? randomUUID;

  const backend = basename(String(request.command ?? ''));
  if (!SUPPORTED_BACKENDS.has(backend)) {
    throw refused(
      'agent_backend_unsupported',
      `cannot run '${request.command}' as ${spec.identity}: only ${[...SUPPORTED_BACKENDS].join('/')} agent CLIs cross to that account`,
    );
  }
  const agentCommand = posix.join(spec.toolchainBin, backend);
  for (const required of [spec.nodePath, agentCommand]) {
    if (!exists(required)) {
      throw refused(
        'agent_toolchain_missing',
        `cannot run ${backend} as ${spec.identity}: the agent toolchain has no ${required} ` +
          '(this host was bootstrapped before D-423 or without that agent installed; upgrade the workspace host)',
      );
    }
  }

  const spawnId = newId();
  const ephemeralRoot = posix.join(spec.spawnRoot, spawnId);
  const filesRoot = posix.join(ephemeralRoot, 'files');
  const maxBytes = spec.maxShippedBytes ?? DEFAULT_MAX_SHIPPED_BYTES;
  const shipRoots = stringArray(spec, 'shipFileRoots');
  const files = [];
  let shipped = 0;
  const argv = [agentCommand];
  (request.args ?? []).forEach((rawArg, index) => {
    const arg = String(rawArg);
    let isFile = false;
    if (isAbsolute(arg) && shipRoots.length > 0 && underRoot(arg, shipRoots)) {
      try {
        isFile = stat(arg).isFile();
      } catch {
        isFile = false;
      }
    }
    if (!isFile) {
      argv.push(arg);
      return;
    }
    const data = Buffer.from(readFile(arg));
    shipped += data.length;
    if (shipped > maxBytes) {
      throw refused('agent_spawn_payload_too_large', `files shipped to ${spec.identity} exceed ${maxBytes} bytes`);
    }
    const remote = posix.join(filesRoot, `${index}-${basename(arg)}`);
    files.push({ path: remote, mode: 0o600, data: data.toString('base64') });
    argv.push(remote);
  });

  const allow = new Set([...BASE_ENV_ALLOW, ...stringArray(spec, 'envAllow')]);
  const prefixes = stringArray(spec, 'envAllowPrefixes');
  const env = {};
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (value === undefined || value === null) continue;
    if (SECRET_NAME_RE.test(key)) continue;
    if (allow.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) env[key] = String(value);
  }
  env.HOME = spec.remoteHome;
  env.PATH = stringArray(spec, 'remotePath').join(':');
  if (!env.TERM) env.TERM = 'xterm-256color';

  const links = [];
  for (const link of spec.homeLinks ?? []) {
    const dir = env[link.envVar];
    if (dir) links.push({ path: posix.join(dir, link.name), target: posix.join(spec.remoteHome, link.homeRelative) });
  }

  const secrets = readSecrets(stringArray(spec, 'forbiddenSecretFiles'), readFile);
  if (secrets.length > 0) {
    const plain = JSON.stringify({ argv, env });
    const decoded = files.map((f) => Buffer.from(f.data, 'base64'));
    for (const secret of secrets) {
      if (plain.includes(secret) || decoded.some((data) => data.includes(secret))) {
        throw refused(
          'agent_spawn_forbidden_secret',
          `refusing to run an agent as ${spec.identity}: a forbidden operator secret would cross to that identity`,
        );
      }
    }
  }

  const execHeaderPath = posix.join(ephemeralRoot, 'exec.json');
  const cwd = spec.remoteCwd ?? spec.remoteHome;
  const header = {
    v: HEADER_VERSION,
    dirs: [spec.spawnRoot, ephemeralRoot, filesRoot],
    files,
    links,
    argv,
    env,
    cwd,
    cleanup: [ephemeralRoot],
    execHeaderPath,
    ...(backend === 'claude' ? { claudeLaunchReady: claudeLaunchReadiness(env, spec.remoteHome, cwd) } : {}),
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const node = shellQuote(spec.nodePath);
  const transportEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: spec.localHome,
    TERM: env.TERM,
  };
  return {
    spawnId,
    identity: spec.identity,
    stage: {
      command: spec.stageTransport.command,
      args: [...spec.stageTransport.args, `exec ${node} -e ${shellQuote(AGENT_IDENTITY_TTY_STAGE_SOURCE)}`],
      input: Buffer.concat([Buffer.from(`${json.length}\n`, 'latin1'), json]),
      env: transportEnv,
    },
    exec: {
      command: spec.execTransport.command,
      args: [
        ...spec.execTransport.args,
        `exec ${node} -e ${shellQuote(AGENT_IDENTITY_TTY_EXEC_SOURCE)} ${shellQuote(execHeaderPath)}`,
      ],
      env: transportEnv,
      execHeaderPath,
      identity: spec.identity,
    },
  };
}

/**
 * Run the stage hop synchronously and return the exec hop for the caller's PTY spawn.
 * A stage failure is a NAMED refusal carrying the transport's stderr tail.
 */
export function stageAgentIdentityTty(rawSpec, request, deps = {}) {
  const plan = planAgentIdentityTty(rawSpec, request, deps);
  const spec = parseAgentIdentitySpec(rawSpec);
  const run = deps.spawnSync ?? spawnSync;
  const result = run(plan.stage.command, plan.stage.args, {
    input: plan.stage.input,
    env: plan.stage.env,
    timeout: spec.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const stderrTail = String(result.stderr ?? '').trim().split('\n').slice(-5).join(' | ');
  if (result.error) {
    throw refused('agent_identity_stage_failed', `staging the agent as ${plan.identity} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw refused(
      'agent_identity_stage_failed',
      `staging the agent as ${plan.identity} exited ${result.status ?? result.signal}${stderrTail ? `: ${stderrTail}` : ''}`,
    );
  }
  const printed = String(result.stdout ?? '').trim();
  if (printed !== plan.exec.execHeaderPath) {
    throw refused(
      'agent_identity_stage_failed',
      `staging the agent as ${plan.identity} reported '${printed || '(nothing)'}' instead of ${plan.exec.execHeaderPath}`,
    );
  }
  return plan.exec;
}
