/**
 * Quick end-to-end test: generate a release-history page from synthetic data
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { renderIndexHtml, renderHistoryJson, renderPlanPageHtml, type HydratedRelease } from './release-history-page.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-release-'));

const mockRelease: HydratedRelease = {
  row: {
    version: '0.0.9',
    channel: 'alpha',
    cutAt: new Date('2026-07-13T00:00:00Z'),
    publishedAt: new Date('2026-07-13T01:00:00Z'),
    changelogMd: '## Highlights\n\n- Fixed auto-update on Windows\n- Added keyboard shortcut support\n\n## Also in this release\n\n23 smaller fixes and improvements.',
    workItemIds: ['WI-1', 'WI-2'],
    planSlugs: ['auto-update'],
    artifacts: [
      {
        product: 'gui',
        platform: 'linux-x86_64',
        name: 'Papercusp_0.0.9_amd64.AppImage',
        url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_amd64.AppImage',
        size: 3_500_000_000,
        sha256: 'abc123def456789',
      },
    ],
    gitSha: 'deadbeef1234',
    cutBy: 'test-agent',
    notes: null,
  },
  items: [
    { id: 'WI-1', title: 'Fix auto-update check on Windows', planSlug: 'auto-update' },
    { id: 'WI-2', title: 'Add Cmd+K shortcut for search', planSlug: 'auto-update' },
  ],
  plans: [
    {
      slug: 'auto-update',
      title: 'Auto-update reliability',
      status: 'shipped',
      content: '# Auto-update reliability\n\nFixed critical issues with the update check and manifest discovery.',
      itemCount: 2,
    },
  ],
  internalCount: 0,
};

try {
  // Test 1: Render index.html
  const indexHtml = renderIndexHtml([mockRelease], {
    generatedAt: new Date('2026-07-13T00:00:00Z'),
    analytics: {
      host: 'https://api.posthog.com',
      projectKey: 'phc_test123',
    },
    redact: [],
  });

  fs.writeFileSync(path.join(tmpDir, 'index.html'), indexHtml, 'utf8');
  console.log('✓ index.html generated:', path.join(tmpDir, 'index.html'));

  // Verify it contains key elements
  if (!indexHtml.includes('Papercusp releases')) throw new Error('Missing title');
  if (!indexHtml.includes('0.0.9')) throw new Error('Missing version');
  if (!indexHtml.includes('Fixed auto-update')) throw new Error('Missing changelog');
  if (!indexHtml.includes('document.referrer')) throw new Error('Missing analytics beacon');
  if (!indexHtml.includes('noindex')) throw new Error('Missing noindex meta tag');
  console.log('✓ index.html contains all required elements');

  // Test 2: Render history.json
  const historyJson = renderHistoryJson([mockRelease], {
    generatedAt: new Date('2026-07-13T00:00:00Z'),
    analytics: null,
    redact: [],
  });

  fs.writeFileSync(path.join(tmpDir, 'history.json'), historyJson, 'utf8');
  const parsed = JSON.parse(historyJson);
  if (parsed.releases[0].version !== '0.0.9') throw new Error('history.json version mismatch');
  if (parsed.releases[0].tag !== 'desktop-v0.0.9-alpha') throw new Error('history.json tag mismatch');
  console.log('✓ history.json generated and parses correctly');

  // Test 3: Render plan page
  const planHtml = renderPlanPageHtml(mockRelease.plans[0], {
    generatedAt: new Date('2026-07-13T00:00:00Z'),
    analytics: null,
    redact: [],
    version: '0.0.9',
  });

  fs.mkdirSync(path.join(tmpDir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'plans', 'auto-update.html'), planHtml, 'utf8');
  if (!planHtml.includes('Auto-update reliability')) throw new Error('Missing plan title');
  if (!planHtml.includes('Fixed critical issues')) throw new Error('Missing plan content');
  console.log('✓ plan page generated');

  // Test 4: Verify no secrets leaked
  const allContent = [indexHtml, historyJson, planHtml].join('\n');
  if (allContent.includes('$current_url')) throw new Error('Leaked PostHog $current_url');
  if (allContent.includes('window.location')) throw new Error('Leaked window.location');
  if (allContent.includes('location.href')) throw new Error('Leaked location.href');
  console.log('✓ No secrets leaked in generated pages');

  console.log('\n✅ All end-to-end tests passed!');
  console.log('   Generated site:', tmpDir);
  process.exit(0);
} catch (e) {
  console.error('❌ Test failed:', (e as Error).message);
  process.exit(1);
}
