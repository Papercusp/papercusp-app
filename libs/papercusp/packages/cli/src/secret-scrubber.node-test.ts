/**
 * Tests for the secret scrubber.
 *
 * Run with:
 *   cd packages/papercusp-cli && npx tsx --test src/secret-scrubber.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanFilesForSecrets,
  replaceSecretsWithPlaceholders,
  formatFindings,
} from './secret-scrubber.ts';

describe('scanFilesForSecrets', () => {
  it('returns no findings on clean input', () => {
    const result = scanFilesForSecrets([
      { path: 'src/index.ts', contents: 'export const greeting = "hello";' },
    ]);
    assert.equal(result.findings.length, 0);
    assert.equal(result.hardReject.length, 0);
    assert.equal(result.scanned, 1);
  });

  it('hard-rejects .env files regardless of contents', () => {
    const result = scanFilesForSecrets([
      { path: '.env', contents: 'JUST_A_COMMENT=true' },
      { path: 'apps/foo/.env.local', contents: '' },
    ]);
    assert.equal(result.hardReject.length, 2);
    assert.deepEqual(
      result.hardReject.map((r) => r.path).sort(),
      ['.env', 'apps/foo/.env.local'],
    );
  });

  it('detects Anthropic API key', () => {
    const fakeKey = 'sk-ant-' + 'a'.repeat(64);
    const result = scanFilesForSecrets([
      { path: 'src/server.ts', contents: `const key = '${fakeKey}';` },
    ]);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].rule, 'anthropic-api-key');
    assert.equal(result.findings[0].placeholderName, 'ANTHROPIC_API_KEY');
  });

  it('detects Cloudflare API token', () => {
    const fakeKey = 'cfut_' + 'b'.repeat(50);
    const result = scanFilesForSecrets([
      { path: 'wrangler.toml', contents: `CLOUDFLARE_API_TOKEN = "${fakeKey}"` },
    ]);
    // Will detect both: cloudflare-api-token AND env-shaped-secret. Both fine.
    assert.ok(result.findings.length >= 1);
    assert.ok(result.findings.some((f) => f.rule === 'cloudflare-api-token'));
  });

  it('detects GitHub PAT', () => {
    const fakeKey = 'ghp_' + 'c'.repeat(40);
    const result = scanFilesForSecrets([
      { path: 'README.md', contents: `\nGITHUB_TOKEN=${fakeKey}\n` },
    ]);
    assert.ok(result.findings.some((f) => f.rule === 'github-pat'));
  });

  it('detects generic env-shaped secrets', () => {
    const result = scanFilesForSecrets([
      { path: 'config.txt', contents: 'YOUTUBE_API_KEY="some-secret-value-1234567890abcd"' },
    ]);
    assert.ok(result.findings.some((f) => f.rule === 'env-shaped-secret'));
    const finding = result.findings.find((f) => f.rule === 'env-shaped-secret')!;
    assert.equal(finding.placeholderName, 'YOUTUBE_API_KEY');
  });

  it('detects JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = scanFilesForSecrets([
      { path: 'curl.sh', contents: `curl -H "Authorization: Bearer ${jwt}" ...` },
    ]);
    assert.ok(result.findings.some((f) => f.rule === 'jwt'));
  });

  it('detects private key blocks', () => {
    const result = scanFilesForSecrets([
      { path: 'cert.txt', contents: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...\n-----END RSA PRIVATE KEY-----' },
    ]);
    assert.ok(result.findings.some((f) => f.rule === 'private-key-block'));
  });

  it('skips lockfiles + binary files', () => {
    const result = scanFilesForSecrets([
      { path: 'package-lock.json', contents: '{}' },
      { path: 'pnpm-lock.yaml', contents: '' },
      { path: 'logo.png', contents: null },
    ]);
    assert.equal(result.findings.length, 0);
    assert.equal(result.scanned, 0);
    assert.equal(result.skipped, 3);
  });
});

describe('replaceSecretsWithPlaceholders', () => {
  it('replaces matches with ${PLACEHOLDER_NAME}', () => {
    const fakeKey = 'sk-ant-' + 'd'.repeat(64);
    const files = [
      { path: 'src/server.ts', contents: `const key = '${fakeKey}';` },
    ];
    const scan = scanFilesForSecrets(files);
    const updated = replaceSecretsWithPlaceholders(files, scan.findings);
    assert.equal(updated.size, 1);
    const updatedContent = updated.get('src/server.ts')!;
    assert.ok(!updatedContent.includes(fakeKey));
    assert.ok(updatedContent.includes('${ANTHROPIC_API_KEY}'));
  });

  it('handles multiple findings in the same file', () => {
    const ghpKey = 'ghp_' + 'e'.repeat(40);
    const ytKey = 'YOUTUBE_API_KEY="some-secret-value-1234567890abcd"';
    const files = [
      { path: 'config.txt', contents: `${ghpKey}\n${ytKey}` },
    ];
    const scan = scanFilesForSecrets(files);
    const updated = replaceSecretsWithPlaceholders(files, scan.findings);
    const updatedContent = updated.get('config.txt')!;
    assert.ok(!updatedContent.includes(ghpKey));
    assert.ok(updatedContent.includes('${GITHUB_PAT}'));
  });
});

describe('formatFindings', () => {
  it('produces a clean message for clean input', () => {
    const result = scanFilesForSecrets([
      { path: 'src/index.ts', contents: 'const x = 1;' },
    ]);
    const out = formatFindings(result);
    assert.match(out, /No secrets found/);
  });

  it('lists hard-rejects + findings', () => {
    const result = scanFilesForSecrets([
      { path: '.env', contents: '' },
      { path: 'src/x.ts', contents: 'const k = "ghp_' + 'a'.repeat(40) + '";' },
    ]);
    const out = formatFindings(result);
    assert.match(out, /HARD-REJECTED/);
    assert.match(out, /SECRETS DETECTED/);
  });
});
