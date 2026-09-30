/**
 * GET     /api/desktop/preflight — environment readiness checks (node,
 *   postgres, omp, bash, harness, claude, soft prereqs).
 * OPTIONS /api/desktop/preflight — CORS preflight.
 *
 * Ported from app/api/desktop/preflight/route.ts. `auth: 'public'` —
 * faithful to the route's prior posture (no auth check; permissive
 * `Access-Control-Allow-Origin: *`).
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { harnessRoot } from '@papercusp/harness/paths';
import { defineTool } from '@papercusp/agent-mcp';

const exec = promisify(execFile);

type CheckStatus = 'ok' | 'missing' | 'error';

interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
  optional?: boolean;
}

async function checkBinary(bin: string, args: string[] = ['--version']): Promise<Check> {
  try {
    const { stdout, stderr } = await exec(bin, args, { timeout: 5000 });
    const out = (stdout || stderr).trim().split(/\r?\n/)[0] ?? '';
    return { name: bin, status: 'ok', detail: out };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // gh ships bundled in the desktop sidecar (build-desktop-sidecar.sh →
      // sidecar/bin/gh), but a GUI launch's operator process rarely has it on
      // PATH — so the Setup Wizard's "Sign in to GitHub" button would read as
      // "not installed". Probe the bundled location + common installs.
      if (bin === 'gh') {
        const candidates = [
          `${process.cwd()}/bin/gh`,
          `${process.cwd()}/../bin/gh`,
          '/usr/local/bin/gh',
          '/opt/homebrew/bin/gh',
        ];
        for (const path of candidates) {
          if (existsSync(path)) {
            try {
              const probe = await exec(path, args, { timeout: 5000 });
              const out = (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0] ?? '';
              return { name: bin, status: 'ok', detail: `${out} (bundled)` };
            } catch {/* fall through */}
          }
        }
      }
      return { name: bin, status: 'missing', detail: `${bin} not on PATH` };
    }
    return { name: bin, status: 'error', detail: String(err?.message ?? err) };
  }
}

/**
 * Check for pi (omp). GUI app launches on macOS often miss the user's
 * login-shell PATH so 'omp' alone may fail even when installed. Probe
 * well-known absolute locations as a fallback.
 */
async function checkPi(): Promise<Check> {
  const direct = await checkBinary('omp');
  if (direct.status === 'ok') return { ...direct, name: 'pi' };

  const bundledOmp = process.cwd() ? `${process.cwd()}/bin/omp` : '';
  const candidates = [
    bundledOmp,
    `${bundledOmp}.exe`,
    '/usr/local/bin/omp',
    '/opt/homebrew/bin/omp',
    `${process.env.HOME ?? ''}/.cargo/bin/omp`,
    `${process.env.HOME ?? ''}/.local/bin/omp`,
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) {
      const probe = await checkBinary(path);
      if (probe.status === 'ok') return { ...probe, name: 'pi', detail: `${probe.detail} (at ${path})` };
    }
  }
  return {
    name: 'pi',
    status: 'missing',
    detail: 'omp not on PATH or known install paths',
    hint: 'Install it from Setup (`papercusp setup`) or run `psu --agent=omp` and accept the install prompt — both download the omp binary from https://github.com/can1357/oh-my-pi releases. (`@oh-my-pi/cli` on npm is a dead ref; do not use it.)',
  };
}

async function checkPostgres(): Promise<Check> {
  // Preferred desktop path: embedded-postgres-server on a workspace-scoped
  // TCP port. Probe the loopback port.
  if (process.env.PAPERCUSP_USE_EMBEDDED_PG === '1') {
    const portStr = process.env.PAPERCUSP_PG_PORT;
    const port = portStr ? Number(portStr) : NaN;
    if (!Number.isFinite(port) || port <= 0) {
      return {
        name: 'postgres',
        status: 'missing',
        detail: 'PAPERCUSP_USE_EMBEDDED_PG=1 but PAPERCUSP_PG_PORT unset/invalid',
        hint: 'embedded-postgres-server may still be starting; reload in a few seconds.',
      };
    }
    return await new Promise<Check>((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (status: CheckStatus, detail: string) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* ignore */ }
        resolve({ name: 'postgres', status, detail });
      };
      socket.setTimeout(2000);
      socket.once('connect', () => finish('ok', `embedded-postgres on 127.0.0.1:${port}`));
      socket.once('timeout', () => finish('missing', `embedded-postgres 127.0.0.1:${port} timeout`));
      socket.once('error', (e) => finish('missing', `embedded-postgres 127.0.0.1:${port} unreachable (${e.message})`));
      socket.connect(port, '127.0.0.1');
    });
  }
  // Dev-box / external-PG path: probe native Postgres on 127.0.0.1:5432
  // (the embedded-PG path above is the shipping path).
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (status: CheckStatus, detail: string) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ name: 'postgres', status, detail });
    };
    socket.setTimeout(8000);
    socket.once('connect', () => finish('ok', '127.0.0.1:5432 reachable'));
    socket.once('timeout', () => finish('missing', '127.0.0.1:5432 timeout'));
    socket.once('error', (e: any) => finish('missing', `127.0.0.1:5432 ${e?.code ?? 'unreachable'}`));
    socket.connect(5432, '127.0.0.1');
  });
}

function checkHarnessDir(): Check {
  const harnessRootPath = harnessRoot();
  const orchBinDir = `${harnessRootPath}/../orchestrator/bin`;
  // Packaged desktop ships self-contained esbuild bundles (invoke-once.mjs);
  // dev has the .ts entries (run via tsx). Either satisfies "orchestrator present".
  const candidates = [`${orchBinDir}/invoke-once.mjs`, `${orchBinDir}/run.ts`, `${orchBinDir}/invoke-once.ts`];
  if (!candidates.some((p) => existsSync(p))) {
    return {
      name: 'harness',
      status: 'missing',
      detail: `orchestrator bin not found in ${orchBinDir}`,
      hint: 'Reinstall workspace deps (npm install) so @papercusp/orchestrator + @papercusp/harness resolve; PAPERCUSP_HARNESS_DIR overrides if set.',
    };
  }
  return { name: 'harness', status: 'ok', detail: harnessRootPath };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Soft-prerequisite CLIs: harness flows shell out to these, but most
// developer machines have them. Reported as optional so the bootstrap
// UI can show "install these to unlock all flows" without blocking boot.
const SOFT_PREREQS: Array<{ name: string; hint: string }> = [
  { name: 'git', hint: 'Bundled on Windows; macOS: install Xcode CLT (xcode-select --install); Linux: apt/dnf install git. Required by harness worktree + version-detection flows.' },
  { name: 'tar', hint: 'macOS/Linux ship tar by default. Windows 10+ has tar.exe — if missing, update Windows. Required by snapshot publish/fork.' },
  { name: 'curl', hint: 'macOS/Linux ship curl by default. Windows 10+ has curl.exe. Required by harness fetch flows.' },
  { name: 'gh', hint: 'GitHub CLI — bundled on most platforms. Used by the Setup Wizard\'s "Sign in to GitHub" button. Install: https://cli.github.com/' },
];

async function checkSoftPrereq(name: string, hint: string): Promise<Check> {
  const probe = await checkBinary(name);
  if (probe.status === 'ok') return { ...probe, optional: true };
  return { ...probe, hint, optional: true };
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/desktop/preflight',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/desktop/preflight',
  auth: 'public',
  async handler() {
    const [node, claude, bash, postgres, pi, ...softs] = await Promise.all([
      checkBinary('node'),
      checkBinary('claude'),
      checkBinary('bash'),
      checkPostgres(),
      checkPi(),
      ...SOFT_PREREQS.map((p) => checkSoftPrereq(p.name, p.hint)),
    ]);
    // claude is optional (only required if AGENT_BACKEND=claude-code).
    const claudeOptional: Check = { ...claude, optional: true, hint: claude.status === 'ok'
      ? undefined
      : 'Optional unless AGENT_BACKEND=claude-code. Install: https://docs.anthropic.com/en/docs/claude-code/setup' };
    const harness = checkHarnessDir();
    const checks = [node, postgres, pi, bash, harness, claudeOptional, ...softs];
    const required = checks.filter((c) => !c.optional);
    const allOk = required.every((c) => c.status === 'ok');
    return Response.json({ ok: allOk, checks }, { headers: CORS_HEADERS });
  },
});

export default [get, options];
