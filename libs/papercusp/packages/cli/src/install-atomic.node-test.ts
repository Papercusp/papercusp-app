/**
 * Integration tests for `papercusp install` atomic-staging behavior (PR #6).
 *
 * Real bug class this guards against: a transient marketplace 503 / 404 /
 * truncated tarball / bad-manifest tarball used to wipe the existing
 * install before downloading, leaving the user with nothing. The PR
 * switched to download-into-staging + atomic-rename-into-place. These
 * tests pin both the happy path AND the failure-preserves-existing path.
 *
 * Run with:
 *   cd libs/papercusp/packages/cli && node --test --import tsx src/install-atomic.node-test.ts
 *
 * Each test spawns the real `papercusp install` CLI against a per-test
 * mock HTTP marketplace served on a random port. The mock validates the
 * download path and returns a real-shape tarball (or an injected error
 * status) — same artifact format the real marketplace serves.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { spawnSync, spawn as spawnAsync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(__dirname, '..', 'bin', 'papercusp');
const REPO_ROOT = resolve(__dirname, '../../../../..');
const REPO_BIN = join(REPO_ROOT, 'node_modules', '.bin');

/** Build a real gzipped tarball containing papercusp.json + index.js so the
 *  CLI's tar extract + manifest validate paths actually run. */
async function buildFakeTarball(opts: {
  name: string;
  version: string;
  kind?: 'plugin' | 'template';
  capabilities?: string[];
  manifestExtras?: Record<string, unknown>;
}): Promise<Buffer> {
  const stagingDir = await fs.mkdtemp(join(tmpdir(), 'install-atomic-tar-'));
  try {
    const manifest = {
      name: opts.name,
      version: opts.version,
      kind: opts.kind ?? 'plugin',
      capabilities: opts.capabilities ?? [],
      ...(opts.manifestExtras ?? {}),
    };
    await fs.writeFile(join(stagingDir, 'papercusp.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(join(stagingDir, 'index.js'), `module.exports = { name: '${opts.name}' };\n`);
    const out = spawnSync('tar', ['czf', '-', '-C', stagingDir, 'papercusp.json', 'index.js'], { stdio: ['ignore', 'pipe', 'inherit'] });
    if (out.status !== 0) throw new Error('tar build failed');
    return out.stdout;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

interface MockMarketplace {
  url: string;
  port: number;
  /** Override the response for a specific (path, status). Most recent
   *  registration wins; useful for switching catalog vs download. */
  setHandler(path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): void;
  close(): Promise<void>;
}

async function startMockMarketplace(): Promise<MockMarketplace> {
  const handlers = new Map<string, (req: any, res: any) => void>();
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const h = handlers.get(path);
    if (!h) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `no mock handler for ${path}` }));
      return;
    }
    h(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setHandler: (path, handler) => handlers.set(path, handler),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Run the real papercusp CLI with the given env, capturing exit + output. */
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    PATH: `${REPO_BIN}:${process.env.PATH ?? ''}`,
  };
  // Node's test runner injects worker-context env vars into child processes.
  // The real CLI is not a test worker; inheriting them can leave the subprocess
  // alive indefinitely under node:test isolation instead of exiting after work.
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  return await new Promise((resolve) => {
    const child = spawnAsync(CLI_BIN, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      stderr += `\nspawn error: ${CLI_BIN} timed out after 15000ms`;
      child.kill('SIGTERM');
    }, 15_000);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${err.message}` });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code: code ?? (signal ? 143 : -1), stdout, stderr });
    });
  });
}

let mp: MockMarketplace;
let testHome: string;

before(async () => {
  mp = await startMockMarketplace();
});

after(async () => {
  await mp.close();
});

describe('papercusp install — atomic staging', () => {
  it('happy path: downloads + extracts + manifest validated → install dir contains manifest', async () => {
    testHome = await fs.mkdtemp(join(tmpdir(), 'install-atomic-home-'));
    const slug = 'mp-happy';
    const version = '0.1.0';
    const tarball = await buildFakeTarball({ name: slug, version, capabilities: ['tasks:read'] });

    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: [version], kind: 'plugin', latest: { kind: 'plugin', capabilities: ['tasks:read'] } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(tarball);
    });

    const r = await runCli(['install', slug], {
      PAPERCUSP_HOME: testHome,
      PAPERCUSP_MARKETPLACE_URL: mp.url,
      PAPERCUSP_ACCEPT_CAPABILITIES: '1',
    });
    assert.equal(r.code, 0, `install failed:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const installDir = join(testHome, 'global-plugins', slug);
    const manifestPath = join(installDir, 'papercusp.json');
    assert.ok(existsSync(manifestPath), `expected manifest at ${manifestPath}`);
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(m.name, slug);
    assert.equal(m.version, version);
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it('failed download (HTTP 503) preserves the existing install — staging is cleaned up', async () => {
    testHome = await fs.mkdtemp(join(tmpdir(), 'install-atomic-home-'));
    const slug = 'mp-preserve';

    // Seed a working v0.1.0 install via the happy path first.
    const v1 = await buildFakeTarball({ name: slug, version: '0.1.0', capabilities: ['tasks:read'] });
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.1.0'], kind: 'plugin', latest: { kind: 'plugin', capabilities: ['tasks:read'] } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.1.0`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(v1);
    });
    const r1 = await runCli(['install', slug], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.equal(r1.code, 0, `seed install failed: ${r1.stderr}`);

    const installDir = join(testHome, 'global-plugins', slug);
    const v1Manifest = JSON.parse(await fs.readFile(join(installDir, 'papercusp.json'), 'utf8'));
    assert.equal(v1Manifest.version, '0.1.0');

    // Now try to install v0.2.0 but make the download 503.
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.2.0', '0.1.0'], kind: 'plugin', latest: { kind: 'plugin', capabilities: ['tasks:read'] } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.2.0`, (_req, res) => {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'service unavailable' }));
    });

    const r2 = await runCli(['install', `${slug}@0.2.0`], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.notEqual(r2.code, 0, 'expected install to fail on 503');

    // Atomic-staging contract: the v0.1.0 install survives the failed
    // attempt. (Pre-PR-#6 behavior: install dir wiped before download
    // started, then user left with nothing.)
    assert.ok(existsSync(join(installDir, 'papercusp.json')), 'v0.1.0 manifest must still exist after failed v0.2.0 install');
    const surviving = JSON.parse(await fs.readFile(join(installDir, 'papercusp.json'), 'utf8'));
    assert.equal(surviving.version, '0.1.0', 'surviving install must still be v0.1.0 — atomic install never overwrote it');

    // No staging dir should remain (finally-clause cleanup).
    const globalPlugins = join(testHome, 'global-plugins');
    const entries = await fs.readdir(globalPlugins);
    const staged = entries.filter((e) => e.startsWith(`.${slug}-staging-`));
    assert.equal(staged.length, 0, `staging dirs should be cleaned up; found: ${staged.join(', ')}`);

    await fs.rm(testHome, { recursive: true, force: true });
  });

  it('bad-manifest tarball is rejected before swap → existing install preserved', async () => {
    testHome = await fs.mkdtemp(join(tmpdir(), 'install-atomic-home-'));
    const slug = 'mp-badmanifest';

    // Seed v0.1.0
    const v1 = await buildFakeTarball({ name: slug, version: '0.1.0', capabilities: [] });
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.1.0'], kind: 'plugin', latest: { kind: 'plugin' } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.1.0`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(v1);
    });
    const r1 = await runCli(['install', slug], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.equal(r1.code, 0, `seed install failed: ${r1.stderr}`);

    // v0.2.0 tarball has a manifest with the WRONG slug — manifest validation should reject it.
    const v2Wrong = await buildFakeTarball({ name: 'wrong-slug-not-mp-badmanifest', version: '0.2.0' });
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.2.0', '0.1.0'], kind: 'plugin', latest: { kind: 'plugin' } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.2.0`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(v2Wrong);
    });

    const r2 = await runCli(['install', `${slug}@0.2.0`], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.notEqual(r2.code, 0, 'expected install to fail on manifest mismatch');

    // v0.1.0 must survive — manifest validation should have happened in the
    // staging dir before any rename.
    const installDir = join(testHome, 'global-plugins', slug);
    const surviving = JSON.parse(await fs.readFile(join(installDir, 'papercusp.json'), 'utf8'));
    assert.equal(surviving.version, '0.1.0');
    assert.equal(surviving.name, slug);

    await fs.rm(testHome, { recursive: true, force: true });
  });
});
