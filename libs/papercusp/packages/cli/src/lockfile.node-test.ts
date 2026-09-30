/**
 * Tests for lockfile.ts. Run with:
 *   cd libs/papercusp/packages/cli && node --test --import tsx src/lockfile.node-test.ts
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import {
  addToLock,
  checkRetractionStates,
  lockPath,
  readLock,
  removeFromLock,
  validateLockAgainstInstalled,
  writeLock,
  type Lockfile,
  type RetractionState,
} from './lockfile.ts';

import { papercuspPath } from './papercusp-root.ts';
const HARNESS = `lockfile-test-${process.pid}`;
const HARNESS_DIR = papercuspPath('harnesses', HARNESS);
const GLOBAL_DIR = papercuspPath('global-plugins');
const FAKE_INSTALLED = `lockfile-test-fake-plugin-${process.pid}`;
const FAKE_INSTALL_DIR = join(GLOBAL_DIR, FAKE_INSTALLED);

before(async () => {
  await fs.mkdir(HARNESS_DIR, { recursive: true });
});

after(async () => {
  await fs.rm(HARNESS_DIR, { recursive: true, force: true });
  await fs.rm(FAKE_INSTALL_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(lockPath(HARNESS), { force: true });
  await fs.rm(FAKE_INSTALL_DIR, { recursive: true, force: true });
});

describe('lockfile read/write', () => {
  it('returns an empty lock when no file exists', async () => {
    const lock = await readLock(HARNESS);
    assert.equal(lock.lockfileVersion, 1);
    assert.equal(lock.harness, HARNESS);
    assert.deepEqual(lock.entries, {});
  });

  it('round-trips an entry', async () => {
    await addToLock(HARNESS, 'a', {
      version: '0.1.0',
      integrity: 'sha256-x',
      kind: 'plugin',
      grantedCapsHash: 'sha256-cap',
      requiredBy: 'user',
      addedAt: '2026-04-27T00:00:00Z',
    });
    const lock = await readLock(HARNESS);
    assert.equal(lock.entries['a'].version, '0.1.0');
    assert.equal(lock.entries['a'].requiredBy, 'user');
  });

  it('removeFromLock deletes the entry', async () => {
    await addToLock(HARNESS, 'a', {
      version: '0.1.0',
      integrity: 'sha256-x',
      kind: 'plugin',
      grantedCapsHash: null,
      requiredBy: 'user',
      addedAt: '2026-04-27T00:00:00Z',
    });
    await removeFromLock(HARNESS, 'a');
    const lock = await readLock(HARNESS);
    assert.equal(lock.entries['a'], undefined);
  });

  it('rejects unsupported lockfileVersion', async () => {
    const badLock: Lockfile = { lockfileVersion: 2 as unknown as 1, harness: HARNESS, entries: {} };
    await fs.writeFile(lockPath(HARNESS), JSON.stringify(badLock));
    await assert.rejects(() => readLock(HARNESS), /unsupported lockfileVersion/);
  });
});

describe('validateLockAgainstInstalled', () => {
  it('reports missing plugins', async () => {
    await addToLock(HARNESS, 'never-installed', {
      version: '0.1.0',
      integrity: 'sha256-x',
      kind: 'plugin',
      grantedCapsHash: null,
      requiredBy: 'user',
      addedAt: '2026-04-27T00:00:00Z',
    });
    const r = await validateLockAgainstInstalled(HARNESS);
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    assert.match(r.missing[0], /never-installed/);
  });

  it('reports version mismatches', async () => {
    await fs.mkdir(FAKE_INSTALL_DIR, { recursive: true });
    await fs.writeFile(
      join(FAKE_INSTALL_DIR, 'papercusp.json'),
      JSON.stringify({ name: FAKE_INSTALLED, version: '0.2.0' }),
    );
    await addToLock(HARNESS, FAKE_INSTALLED, {
      version: '0.1.0',
      integrity: 'sha256-x',
      kind: 'plugin',
      grantedCapsHash: null,
      requiredBy: 'user',
      addedAt: '2026-04-27T00:00:00Z',
    });
    const r = await validateLockAgainstInstalled(HARNESS);
    assert.equal(r.ok, false);
    assert.match(r.missing[0], /have 0\.2\.0/);
  });

  it('passes when everything is installed at the pinned version', async () => {
    await fs.mkdir(FAKE_INSTALL_DIR, { recursive: true });
    await fs.writeFile(
      join(FAKE_INSTALL_DIR, 'papercusp.json'),
      JSON.stringify({ name: FAKE_INSTALLED, version: '0.1.0' }),
    );
    await addToLock(HARNESS, FAKE_INSTALLED, {
      version: '0.1.0',
      integrity: 'sha256-x',
      kind: 'plugin',
      grantedCapsHash: null,
      requiredBy: 'user',
      addedAt: '2026-04-27T00:00:00Z',
    });
    const r = await validateLockAgainstInstalled(HARNESS);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
  });
});

// ─── Retraction check (live HTTP fixture) ──────────────────────────────────

interface FakeStatus { slug: string; retracted: RetractionState; reason: string | null }

function startFakeRegistry(states: Record<string, FakeStatus>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (!req.url?.startsWith('/v1/installed-status')) {
        res.writeHead(404).end();
        return;
      }
      const u = new URL(req.url, 'http://localhost');
      const slugs = (u.searchParams.get('slugs') ?? '').split(',');
      const packages = slugs.map((s) => states[s] ?? { slug: s, retracted: 'active', reason: null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ packages }));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('checkRetractionStates', () => {
  it('deprecated → warn, proceed', async () => {
    await addToLock(HARNESS, 'pkg-d', { version: '0.1.0', integrity: 'sha256-x', kind: 'plugin', grantedCapsHash: null, requiredBy: 'user', addedAt: '2026-04-27T00:00:00Z' });
    const reg = await startFakeRegistry({ 'pkg-d': { slug: 'pkg-d', retracted: 'deprecated', reason: 'use v2' } });
    try {
      const r = await checkRetractionStates(HARNESS, reg.url);
      assert.equal(r.status, 'warn');
      assert.deepEqual(r.warned, ['pkg-d']);
      assert.deepEqual(r.blocked, []);
    } finally {
      await reg.close();
    }
  });

  it('withdrawn → block unless --allow-withdrawn', async () => {
    await addToLock(HARNESS, 'pkg-w', { version: '0.1.0', integrity: 'sha256-x', kind: 'plugin', grantedCapsHash: null, requiredBy: 'user', addedAt: '2026-04-27T00:00:00Z' });
    const reg = await startFakeRegistry({ 'pkg-w': { slug: 'pkg-w', retracted: 'withdrawn', reason: 'gone' } });
    try {
      const blocked = await checkRetractionStates(HARNESS, reg.url, { allowWithdrawn: false });
      assert.equal(blocked.status, 'block');
      assert.deepEqual(blocked.blocked, ['pkg-w']);
      const allowed = await checkRetractionStates(HARNESS, reg.url, { allowWithdrawn: true });
      assert.equal(allowed.status, 'warn');
      assert.deepEqual(allowed.warned, ['pkg-w']);
    } finally {
      await reg.close();
    }
  });

  it('quarantined → block always', async () => {
    await addToLock(HARNESS, 'pkg-q', { version: '0.1.0', integrity: 'sha256-x', kind: 'plugin', grantedCapsHash: null, requiredBy: 'user', addedAt: '2026-04-27T00:00:00Z' });
    const reg = await startFakeRegistry({ 'pkg-q': { slug: 'pkg-q', retracted: 'quarantined', reason: 'CVE' } });
    try {
      const blocked = await checkRetractionStates(HARNESS, reg.url, { allowWithdrawn: true });
      assert.equal(blocked.status, 'block');
      assert.deepEqual(blocked.blocked, ['pkg-q']);
    } finally {
      await reg.close();
    }
  });

  it('registry network failure produces a soft warn (not block)', async () => {
    await addToLock(HARNESS, 'pkg-x', { version: '0.1.0', integrity: 'sha256-x', kind: 'plugin', grantedCapsHash: null, requiredBy: 'user', addedAt: '2026-04-27T00:00:00Z' });
    // Bind to a port we know is closed (zero ➜ ephemeral, then close immediately).
    const reg = await startFakeRegistry({});
    await reg.close();
    const r = await checkRetractionStates(HARNESS, reg.url);
    assert.equal(r.status, 'ok');
    assert.equal(r.notes.length >= 1, true);
    assert.match(r.notes[0], /retraction check skipped/);
  });

  it('empty lockfile is a no-op', async () => {
    const reg = await startFakeRegistry({});
    try {
      const r = await checkRetractionStates(HARNESS, reg.url);
      assert.equal(r.status, 'ok');
      assert.deepEqual(r.notes, []);
    } finally {
      await reg.close();
    }
  });
});
