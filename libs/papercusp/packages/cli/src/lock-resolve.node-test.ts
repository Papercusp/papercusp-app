/**
 * Tests for lock-resolve.ts. Run with:
 *   cd libs/papercusp/packages/cli && node --test --import tsx src/lock-resolve.node-test.ts
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _resetPapercuspRootForTests, papercuspPath } from './papercusp-root.ts';

// lock-resolve.ts captures its root-derived directories at module load time.
// Set an isolated root before importing it so an interrupted test process can
// never leave lockresolve-* fixtures in the operator's real global-plugins dir.
const previousPapercuspHome = process.env.PAPERCUSP_HOME;
const testHome = mkdtempSync(join(tmpdir(), `lock-resolve-test-${process.pid}-`));
process.env.PAPERCUSP_HOME = testHome;
_resetPapercuspRootForTests();

const { resolveRequires, resolveLockfile } = await import('./lock-resolve.ts');

const PREFIX = `lockresolve-${process.pid}`;
const GLOBAL_DIR = papercuspPath('global-plugins');

const allSlugs: string[] = [];

async function makePlugin(suffix: string, requires: string[] = [], recommends: string[] = []): Promise<string> {
  const slug = `${PREFIX}-${suffix}`;
  allSlugs.push(slug);
  const dir = join(GLOBAL_DIR, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'papercusp.json'),
    JSON.stringify({
      name: slug,
      version: '0.1.0',
      kind: 'plugin',
      capabilities: [],
      requires: requires.map((s) => `${PREFIX}-${s}`),
      recommends: recommends.map((s) => `${PREFIX}-${s}`),
    }),
  );
  return slug;
}

after(async () => {
  try {
    await fs.rm(testHome, { recursive: true, force: true });
  } finally {
    if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = previousPapercuspHome;
    _resetPapercuspRootForTests();
  }
});

afterEach(async () => {
  for (const s of allSlugs) {
    await fs.rm(join(GLOBAL_DIR, s), { recursive: true, force: true });
  }
  allSlugs.length = 0;
});

describe('resolveRequires', () => {
  it('returns just the root when no requires', async () => {
    const root = await makePlugin('lone');
    const r = await resolveRequires(root);
    assert.equal(r.pinned.length, 1);
    assert.equal(r.pinned[0].slug, root);
    assert.equal(r.pinned[0].requiredBy, 'user');
  });

  it('walks transitive requires leaf-first', async () => {
    const leaf = await makePlugin('leaf');
    const mid = await makePlugin('mid', ['leaf']);
    const root = await makePlugin('root', ['mid']);
    const r = await resolveRequires(root);
    assert.deepEqual(
      r.pinned.map((p) => p.slug),
      [leaf, mid, root],
    );
    assert.equal(r.pinned[0].requiredBy, mid);
    assert.equal(r.pinned[1].requiredBy, root);
    assert.equal(r.pinned[2].requiredBy, 'user');
  });

  it('dedupes diamond dependencies (visits each node exactly once)', async () => {
    const leaf = await makePlugin('leaf');
    const a = await makePlugin('a', ['leaf']);
    const b = await makePlugin('b', ['leaf']);
    const root = await makePlugin('root', ['a', 'b']);
    const r = await resolveRequires(root);
    const slugs = r.pinned.map((p) => p.slug);
    assert.equal(new Set(slugs).size, slugs.length, 'no duplicates');
    assert.ok(slugs.includes(leaf));
    assert.ok(slugs.includes(a));
    assert.ok(slugs.includes(b));
  });

  it('breaks cycles', async () => {
    const a = await makePlugin('a', ['b']);
    const b = await makePlugin('b', ['a']);
    const r = await resolveRequires(a);
    // No infinite loop, both included.
    assert.equal(r.pinned.length, 2);
  });

  it('reports missing requires without crashing', async () => {
    const root = await makePlugin('root', ['ghost']);
    const r = await resolveRequires(root);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0], `${PREFIX}-ghost`);
  });

  it('surfaces recommends without including them in pinned', async () => {
    const root = await makePlugin('root', [], ['rec']);
    const r = await resolveRequires(root);
    assert.deepEqual(r.recommended, [`${PREFIX}-rec`]);
    assert.equal(r.pinned.find((p) => p.slug === `${PREFIX}-rec`), undefined);
  });
});

describe('resolveLockfile', () => {
  it('returns empty for missing harness lockfile', async () => {
    const r = await resolveLockfile(`${PREFIX}-nonexistent-harness`);
    assert.deepEqual(r, { pinned: [], recommended: [], missing: [] });
  });
});
