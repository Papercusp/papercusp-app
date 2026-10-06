#!/usr/bin/env node
/**
 * with-test-pg — run a command against a THROWAWAY, fully-migrated Postgres.
 *
 *   node scripts/with-test-pg.mjs -- node scripts/affected-tests.mjs --all
 *
 * Why this exists (WI-123's other half): ~30 "unit"-tier suites never touch PG
 * directly, but the app code they import resolves a pool through
 * libs/papercusp/libs/db/src/connection.ts. With no env set that chain lands on the
 * native `localhost:5432/papercusp`. CI already papers over this by running a
 * postgres service container + scripts/ci-provision-pg.mjs ("dev-box parity"); a dev
 * box papers over it by happening to run native PG. A PACKAGED install has neither,
 * so those suites ECONNREFUSE there — ~200 reds that are pure environment, not defects.
 *
 * This gives any host the same parity without a service container: the packaged app
 * already ships the PG binaries (@embedded-postgres/*) and all the migrations, so we
 * boot our own postmaster on a free port, into a temp datadir, and point the child at
 * it by env.
 *
 * It is deliberately NOT the product's embedded PG. That one holds the user's real
 * pot; a test suite must never open a pool against it. We pass explicit
 * HARNESS_*_DATABASE_URL (step 1 of the resolution chain, so it beats both the
 * discovery file and the native fallback) and the unit layer additionally pins
 * PAPERCUSP_SKIP_PG_DISCOVERY=1 (libs/test-config/src/setup-hermetic-env.ts).
 *
 * Teardown is best-effort but unconditional: the postmaster is stopped and the temp
 * datadir removed on normal exit, on a failing child, and on SIGINT/SIGTERM.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sep = process.argv.indexOf('--');
const cmd = sep >= 0 ? process.argv.slice(sep + 1) : [];
const options = sep >= 0 ? process.argv.slice(2, sep) : process.argv.slice(2);
const operatorApi = options.length === 1 && options[0] === '--isolated-runtime=operator-api';
const isolatedRuntime = operatorApi || (options.length === 1 && options[0] === '--isolated-runtime');
if (cmd.length === 0 || (options.length > 0 && !isolatedRuntime)) {
  console.error('usage: node scripts/with-test-pg.mjs [--isolated-runtime[=operator-api]] -- <command> [args...]');
  process.exit(2);
}

/** The migrations dir: the monorepo path, else the packaged sidecar's copy. */
function resolveSqlDir() {
  const candidates = [
    join(ROOT, 'libs/papercusp/libs/db/sql'),
    join(ROOT, 'sidecar/db-sql'),
    process.env.PAPERCUSP_PG_SQL_DIR,
  ].filter(Boolean);
  const hit = candidates.find((d) => existsSync(d));
  if (!hit) throw new Error(`no migrations dir found (looked in: ${candidates.join(', ')})`);
  return hit;
}

/** Ask the OS for a free TCP port. Never hardcode 5432 — that is the host's own PG. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const { startEmbeddedPostgresServer } = await import(
  '../libs/papercusp/packages/embedded-postgres-server/src/index.js'
);

const dataDir = await mkdtemp(join(tmpdir(), 'papercusp-test-pg-'));
const runtimeRoot = isolatedRuntime ? await mkdtemp(join(tmpdir(), 'papercusp-test-runtime-')) : null;
const runtimeId = isolatedRuntime ? `test-runtime-${randomUUID().slice(0, 12)}` : null;
const port = await freePort();
const sqlDir = resolveSqlDir();

let pg = null;
let profileProcess = null;
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (profileProcess && profileProcess.exitCode === null && profileProcess.signalCode === null) {
    const exited = new Promise((res) => profileProcess.once('exit', res));
    try { process.kill(-profileProcess.pid, 'SIGTERM'); } catch { /* already exited */ }
    await Promise.race([exited, new Promise((res) => setTimeout(res, 5000))]);
    if (profileProcess.exitCode === null && profileProcess.signalCode === null) {
      try { process.kill(-profileProcess.pid, 'SIGKILL'); } catch { /* already exited */ }
      await exited;
    }
  }
  try {
    await pg?.stop();
  } catch {
    /* best effort — we still want the datadir gone */
  }
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`[with-test-pg] booting throwaway PG on :${port} (datadir ${dataDir})`);
console.log(`[with-test-pg] migrations: ${sqlDir}`);

try {
  pg = await startEmbeddedPostgresServer({ dataDir, port, dbSqlDir: sqlDir, onLog: () => {} });
} catch (e) {
  console.error(`[with-test-pg] failed to start postgres: ${e?.stack ?? e}`);
  await cleanup();
  process.exit(1);
}
console.log(`[with-test-pg] ready — ${pg.urls.admin.replace(/:[^:@]*@/, ':***@')}`);

let runtimeEnv = {};
if (runtimeRoot && runtimeId) {
  const home = join(runtimeRoot, 'home');
  const papercuspHome = join(home, '.papercusp');
  const workspacesRoot = join(runtimeRoot, 'workspaces');
  await Promise.all([
    mkdir(papercuspHome, { recursive: true }),
    mkdir(join(workspacesRoot, runtimeId), { recursive: true }),
    mkdir(join(runtimeRoot, 'xdg-runtime'), { recursive: true, mode: 0o700 }),
    mkdir(join(runtimeRoot, 'tmp'), { recursive: true }),
  ]);
  await writeFile(join(workspacesRoot, 'registry.json'), JSON.stringify({
    current: runtimeId,
    workspaces: [{ id: runtimeId, name: 'Disposable background test', createdAt: Date.now() }],
  }), { mode: 0o600 });
  const httpPort = await freePort();
  const ptyPort = await freePort();
  if (httpPort === ptyPort || httpPort === port || ptyPort === port) {
    console.error('[with-test-pg] isolated runtime port collision — refusing to launch');
    await cleanup();
    process.exit(1);
  }
  runtimeEnv = {
    HOME: home,
    PAPERCUSP_HOME: papercuspHome,
    PAPERCUSP_IDENTITY_DIR: join(papercuspHome, 'identity'),
    PAPERCUSP_WORKSPACES_ROOT: workspacesRoot,
    PAPERCUSP_WORKSPACE: runtimeId,
    PAPERCUSP_WORKSPACE_ID: runtimeId,
    PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${httpPort}`,
    PAPERCUSP_API_BASE: `http://127.0.0.1:${httpPort}`,
    HARNESS_ADMIN_DATABASE_URL: pg.urls.admin,
    HARNESS_DATABASE_URL: pg.urls.app,
    PAPERCUSP_HONO_PORT: String(httpPort),
    OPERATOR_DEV_PORT: String(httpPort),
    OPERATOR_DEV_PTY_PORT: String(ptyPort),
    PAPERCUSP_BIND_HOST: '127.0.0.1',
    PAPERCUSP_BACKGROUND_WORKERS: operatorApi ? '0' : '1',
    PAPERCUSP_DBOS_ENABLE: operatorApi ? '0' : '1',
    PAPERCUSP_DBOS_ORCHESTRATOR: operatorApi ? '0' : '1',
    // The test starts explicit background work; global scheduled routines may
    // otherwise act on the shared checkout or external services during boot.
    PAPERCUSP_DBOS_ROUTINES: '0',
    PAPERCUSP_DBOS_TIMERS: '0',
    PAPERCUSP_DBOS_AUTOLOOP: '0',
    DBOS__VMID: runtimeId,
    DBOS__APPVERSION: runtimeId,
    PAPERCUSP_CLUSTER: '0',
    PAPERCUSP_CLUSTER_WORKERS: '0',
    PAPERCUSP_SPAWNER_SIDECAR: '0',
    PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '0',
    PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR: '0',
    PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '0',
    PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR: '0',
    PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '0',
    XDG_DATA_HOME: join(runtimeRoot, 'xdg-data'),
    XDG_CACHE_HOME: join(runtimeRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'xdg-config'),
    XDG_RUNTIME_DIR: join(runtimeRoot, 'xdg-runtime'),
    TMPDIR: join(runtimeRoot, 'tmp'),
  };
}

const childEnv = { ...process.env };
if (isolatedRuntime) {
  // Start from no ambient operator identity, endpoints, IPC or credentials.
  // HOME alone is insufficient: an inherited PAPERCUSP_SUBSTRATE_IPC_SOCKET,
  // API base or DHT bootstrap can still join the running operator.
  for (const key of Object.keys(childEnv)) {
    if (/^(PAPERCUSP_|HARNESS_|DBOS__|PG[A-Z]|DATABASE_URL$|AWS_|AZURE_|GOOGLE_|GCP_|OPENAI_|ANTHROPIC_|GITHUB_|GH_|CLOUDSDK_|DOCKER_|GIT_ASKPASS$|GIT_CONFIG_|SSH_AUTH_SOCK$|CODEX_HOME$|VITEST(?:_|$)|DBUS_SESSION_BUS_ADDRESS$|GNOME_KEYRING_CONTROL$)/i.test(key)) {
      delete childEnv[key];
    }
  }
}
if (operatorApi) {
  // A request journey needs the same isolation as a background test, but must
  // not boot DBOS/substrate owners or load an ONNX model in the request host.
  // Reuse the actual registry and sidecar factory in a separate owned process;
  // never inherit the live sidecar, register the shared checkout, or disable
  // the host's memory watchdog. Preflight completes BEFORE the command starts.
  runtimeEnv.PAPERCUSP_POT_HOME_SLUG = runtimeId;
  // Tunnel connectors must use the host's maintained no-local-trust listener,
  // never the desktop loopback API (which can mint pairing tokens).
  let ingressPort;
  do { ingressPort = await freePort(); }
  while ([port, Number(runtimeEnv.PAPERCUSP_HONO_PORT), Number(runtimeEnv.OPERATOR_DEV_PTY_PORT)].includes(ingressPort));
  runtimeEnv.PAPERCUSP_EXTERNAL_INGRESS_PORT = String(ingressPort);
  const profileSource = `
    import { mkdir } from 'node:fs/promises';
    import { join } from 'node:path';
    import { saveHarnessRegistry, loadHarnessRegistry } from './packages/operator-core/lib/harness-registry.ts';
    import { createEmbedSidecarServer } from './packages/operator-core/lib/memory/embed-sidecar-server.ts';
    import { getOrgPg, upsertRoutine } from '@papercusp/db-org';
    import { releaseGateTile } from './packages/operator-core/lib/device-monitoring.ts';
    const id = process.env.PAPERCUSP_WORKSPACE_ID;
    const home = join(process.env.PAPERCUSP_WORKSPACES_ROOT, id, 'operator-home');
    await mkdir(home, { recursive: true });
    await saveHarnessRegistry({ projects: [{ slug: id, path: home, harness_kind: 'hive' }] }, id);
    const registry = await loadHarnessRegistry(id, { fresh: true });
    if (!registry.projects.some(p => p.slug === id && p.path === home)) throw new Error('private home harness was not registered');
    // Inbox refuses an unmeasured system source. An empty disposable database
    // has no pipeline at all, so register an explicitly PAUSED fixture through
    // the maintained routine store. Never manufacture a green verdict or arm
    // a release action against the developer's checkout.
    const { sql } = getOrgPg();
    await upsertRoutine(sql, { workspaceId: id, installSlug: id,
      name: 'green-checkpoint', triggerKind: 'api', triggerConfig: {},
      targetRole: 'operator', active: false, nextFireAt: null }, () => null);
    const pause = { reason: 'Disposable operator-api fixture; publication disabled',
      pausedBy: id, pausedAtMs: Date.now() };
    await sql\`UPDATE harness_shared.routines SET metadata = \${sql.json({ pause })}
      WHERE workspace_id = \${id} AND install_slug = \${id} AND name = 'green-checkpoint'\`;
    const gate = await releaseGateTile(id);
    if (!gate || gate.gate !== 'wedged' || !gate.red) {
      throw new Error('private paused pipeline was not measured; refusing request journey');
    }
    const sidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false });
    const port = await sidecar.listening;
    process.on('SIGTERM', async () => { await sidecar.close(); process.exit(0); });
    process.send({ ready: true, url: 'http://127.0.0.1:' + port, homeHarness: id });
  `;
  try {
    profileProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', profileSource], {
      cwd: ROOT, env: { ...childEnv, ...runtimeEnv, PAPERCUSP_PG_PORT: String(port), PAPERCUSP_SKIP_PG_DISCOVERY: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
    });
    let errors = '';
    for (const stream of [profileProcess.stdout, profileProcess.stderr]) {
      stream.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-6000); });
    }
    const ready = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('operator-api profile preflight timed out: ' + errors)), 45000);
      const failed = (error) => { clearTimeout(timer); rej(error); };
      profileProcess.once('error', failed);
      profileProcess.once('exit', (code, signal) => failed(new Error('operator-api profile exited ' + code + '/' + signal + ': ' + errors)));
      profileProcess.once('message', (message) => { clearTimeout(timer); res(message); });
    });
    if (!ready?.ready || ready.homeHarness !== runtimeId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url)) {
      throw new Error('operator-api profile returned an invalid private identity');
    }
    const response = await fetch(ready.url + '/healthz', { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    if (!response.ok || health.pid !== profileProcess.pid || !health.capabilities?.includes('POST /embed')) {
      throw new Error('operator-api private embedding sidecar failed capability/owner preflight');
    }
    runtimeEnv.PAPERCUSP_EMBED_SIDECAR_URL = ready.url;
    console.log('[with-test-pg] operator-api preflight ready — private home harness, measured paused pipeline and embedding sidecar; background/DBOS disabled');
  } catch (error) {
    console.error('[with-test-pg] operator-api preflight failed: ' + (error?.stack ?? error));
    await cleanup();
    process.exit(1);
  }
}
const child = spawn(cmd[0], cmd.slice(1), {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...childEnv,
    // PAPERCUSP_PG_PORT is the repo's OWN isolation lever for "this process owns a
    // dedicated PG" (see connection.ts's two native fallbacks and its pgbouncer
    // opt-out, and harness-invoke-once.ts: "getHarnessAdminUrl() honors
    // PAPERCUSP_PG_PORT, so isolated ..."). Both resolvers build their fallback URL
    // from it, which is all the throwaway PG needs.
    //
    // Deliberately NOT exporting HARNESS_ADMIN_DATABASE_URL / HARNESS_DATABASE_URL:
    // those are step 1 of the resolution chain, and injecting them changes the
    // behaviour of the very code under test — it broke harness-invoke-once.test.ts's
    // env-resolution cases (52/52 → 2 failures) purely because the runner had set
    // them. A test harness must not perturb the tests it runs.
    PAPERCUSP_PG_PORT: String(port),
    // Belt-and-braces: the unit layer pins this too, but a non-vitest child (a script,
    // a CLI) must also never resolve the *product's* live embedded PG.
    PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    ...runtimeEnv,
  },
  detached: isolatedRuntime,
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (isolatedRuntime && child.pid) {
      try { process.kill(-child.pid, sig); } catch { /* already exited */ }
    } else child.kill(sig);
  });
}

child.on('error', async (error) => {
  console.error(`[with-test-pg] child failed to start: ${error.message}`);
  await cleanup();
  process.exitCode = 1;
});

child.on('exit', async (code, signal) => {
  if (isolatedRuntime && child.pid) {
    // A short-lived assertion can spawn a long-lived test host. Reap its owned
    // process group before deleting the private DB/identity it was using.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  await cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
