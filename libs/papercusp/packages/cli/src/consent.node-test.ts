/**
 * Tests for consent.ts. Run with:
 *   cd libs/papercusp/packages/cli && npx tsx --test src/consent.test.ts
 *
 * Covers the CI fast-paths + the sticky-extend mechanic — interactive prompt
 * flows are exercised by integration smoke, not unit tests.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  capsHash,
  diffCapabilitiesSinceGrant,
  isAlreadyExtended,
  netNewCapabilitiesSinceGrant,
  priorGrantsFor,
  promptConsent,
} from './consent.ts';

import { papercuspRoot, _resetPapercuspRootForTests } from './papercusp-root.ts';

// WI-3106 (was flagged flaky by the watchdog as EI-7835): run against an
// ISOLATED PAPERCUSP_HOME, same pattern as plugin-cli.test.ts (EI-214).
// Previously this suite resolved ROOT/grantedPath/extendedPath against the
// REAL shared ~/.papercusp-workspaces/*/granted-capabilities.json +
// extended-grants.json (backing them up in before() and wiping them clean in
// EVERY beforeEach()) — on a shared dev box running many concurrent fleet
// agents, any other process touching those same real files during a test run
// raced against this suite's own backup/wipe/restore cycle, and a killed run
// could skip after()'s restore entirely, leaking a wiped state into real
// capability grants. A /tmp root can never collide with real state no matter
// how the process dies. (consent.ts now resolves its paths lazily for
// exactly this reason — keep it that way, matching plugin-cli.ts's
// convention.)
process.env.PAPERCUSP_HOME = mkdtempSync(join(tmpdir(), 'consent-test-'));
_resetPapercuspRootForTests();

const ROOT = papercuspRoot();
const grantedPath = join(ROOT, 'granted-capabilities.json');
const extendedPath = join(ROOT, 'extended-grants.json');

after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(grantedPath, { force: true });
  await fs.rm(extendedPath, { force: true });
});

describe('capsHash', () => {
  it('is deterministic regardless of input order', () => {
    const h1 = capsHash(['c', 'a', 'b']);
    const h2 = capsHash(['a', 'b', 'c']);
    assert.equal(h1, h2);
  });
  it('changes when capabilities change', () => {
    const h1 = capsHash(['a', 'b']);
    const h2 = capsHash(['a', 'b', 'c']);
    assert.notEqual(h1, h2);
  });
  it('returns the sha256- prefix', () => {
    assert.match(capsHash(['x']), /^sha256-[0-9a-f]{32}$/);
  });
});

describe('promptConsent CI flags', () => {
  const testManifest = {
    name: '@scope/test-plugin',
    version: '0.1.0',
    kind: 'plugin' as const,
    description: 'test plugin',
    capabilities: ['secrets:read:CF_TOKEN', 'http:fetch:api.example.com', 'tasks:read'],
  };

  it('--accept-capabilities=current grants only the current harness', async () => {
    const r = await promptConsent({
      manifest: testManifest,
      harnessSlug: 'h-a',
      acceptCurrentHarness: true,
    });
    assert.equal(r.granted, true);
    assert.equal(r.source, 'ci');
    assert.equal(r.extended, false);
    assert.deepEqual(await priorGrantsFor(testManifest.name, testManifest.version), ['h-a']);
    assert.equal(await isAlreadyExtended(testManifest.name, testManifest.version), false);
  });

  it('--accept-capabilities=all writes to extended-grants.json', async () => {
    const r = await promptConsent({
      manifest: testManifest,
      harnessSlug: 'h-a',
      acceptAllHarnesses: true,
    });
    assert.equal(r.granted, true);
    assert.equal(r.extended, true);
    assert.equal(r.source, 'extended');
    assert.equal(await isAlreadyExtended(testManifest.name, testManifest.version), true);
  });

  it('subsequent harnesses auto-skip after extend-to-all', async () => {
    await promptConsent({
      manifest: testManifest,
      harnessSlug: 'h-a',
      acceptAllHarnesses: true,
    });
    const r = await promptConsent({
      manifest: testManifest,
      harnessSlug: 'h-b',
      // No CI flag — would have prompted, but extended-grants.json kicks in.
    });
    assert.equal(r.granted, true);
    assert.equal(r.extended, true);
    assert.equal(r.source, 'extended');
    const grants = await priorGrantsFor(testManifest.name, testManifest.version);
    assert.deepEqual(grants.sort(), ['h-a', 'h-b']);
  });

  it('records the same caps hash for the same caps', async () => {
    const r1 = await promptConsent({
      manifest: testManifest,
      harnessSlug: 'h-a',
      acceptCurrentHarness: true,
    });
    const r2 = await promptConsent({
      manifest: { ...testManifest, capabilities: [...testManifest.capabilities].reverse() },
      harnessSlug: 'h-b',
      acceptCurrentHarness: true,
    });
    assert.equal(r1.grantedCapsHash, r2.grantedCapsHash);
  });
});

describe('netNewCapabilitiesSinceGrant', () => {
  const slug = '@scope/upgradable';

  it('returns all caps when no prior grant exists', async () => {
    const newCaps = ['a', 'b'];
    const out = await netNewCapabilitiesSinceGrant(slug, '0.1.0', newCaps, 'h-a');
    assert.deepEqual(out, newCaps);
  });

  it('returns only net-new caps when prior grant exists', async () => {
    await promptConsent({
      manifest: { name: slug, version: '0.1.0', kind: 'plugin', capabilities: ['a', 'b'] },
      harnessSlug: 'h-a',
      acceptCurrentHarness: true,
    });
    const out = await netNewCapabilitiesSinceGrant(slug, '0.2.0', ['a', 'b', 'c'], 'h-a');
    assert.deepEqual(out, ['c']);
  });

  it('returns empty when new manifest is a strict subset', async () => {
    await promptConsent({
      manifest: { name: slug, version: '0.1.0', kind: 'plugin', capabilities: ['a', 'b', 'c'] },
      harnessSlug: 'h-a',
      acceptCurrentHarness: true,
    });
    const out = await netNewCapabilitiesSinceGrant(slug, '0.2.0', ['a', 'b'], 'h-a');
    assert.deepEqual(out, []);
  });

  it('looks across all prior versions when computing net-new', async () => {
    await promptConsent({
      manifest: { name: slug, version: '0.1.0', kind: 'plugin', capabilities: ['a'] },
      harnessSlug: 'h-a',
      acceptCurrentHarness: true,
    });
    await promptConsent({
      manifest: { name: slug, version: '0.2.0', kind: 'plugin', capabilities: ['b'] },
      harnessSlug: 'h-a',
      acceptCurrentHarness: true,
    });
    const out = await netNewCapabilitiesSinceGrant(slug, '0.3.0', ['a', 'b', 'c'], 'h-a');
    assert.deepEqual(out, ['c']);
  });
});

describe('diffCapabilitiesSinceGrant', () => {
  it('returns null on first install (no prior grant)', async () => {
    const r = await diffCapabilitiesSinceGrant('@scope/x', 'h-1', ['a', 'b']);
    assert.equal(r, null);
  });

  it('returns added + removed against the prior grant', async () => {
    await promptConsent({
      manifest: { name: '@scope/x', version: '0.1.0', kind: 'plugin', capabilities: ['a', 'b', 'c'] },
      harnessSlug: 'h-1',
      acceptCurrentHarness: true,
    });
    const r = await diffCapabilitiesSinceGrant('@scope/x', 'h-1', ['a', 'b', 'd', 'e']);
    assert.ok(r);
    assert.equal(r!.priorVersion, '0.1.0');
    assert.deepEqual(r!.added.sort(), ['d', 'e']);
    assert.deepEqual(r!.removed.sort(), ['c']);
  });

  it('uses the most recent prior grant when multiple exist', async () => {
    await promptConsent({
      manifest: { name: '@scope/x', version: '0.1.0', kind: 'plugin', capabilities: ['a'] },
      harnessSlug: 'h-1',
      acceptCurrentHarness: true,
    });
    await new Promise((r) => setTimeout(r, 5));  // ensure grantedAt differs
    await promptConsent({
      manifest: { name: '@scope/x', version: '0.2.0', kind: 'plugin', capabilities: ['a', 'b'] },
      harnessSlug: 'h-1',
      acceptCurrentHarness: true,
    });
    const r = await diffCapabilitiesSinceGrant('@scope/x', 'h-1', ['a', 'b', 'c']);
    assert.ok(r);
    assert.equal(r!.priorVersion, '0.2.0');
    assert.deepEqual(r!.added, ['c']);
    assert.deepEqual(r!.removed, []);
  });

  it('returns empty added/removed when caps match exactly', async () => {
    await promptConsent({
      manifest: { name: '@scope/x', version: '0.1.0', kind: 'plugin', capabilities: ['a', 'b'] },
      harnessSlug: 'h-1',
      acceptCurrentHarness: true,
    });
    const r = await diffCapabilitiesSinceGrant('@scope/x', 'h-1', ['b', 'a']);
    assert.ok(r);
    assert.deepEqual(r!.added, []);
    assert.deepEqual(r!.removed, []);
  });
});
