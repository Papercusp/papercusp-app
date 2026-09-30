#!/usr/bin/env node
/**
 * Ensure the Playwright browser cache exists before an e2e run.
 *
 * The cache is intentionally checked by its INSTALLATION_COMPLETE sentinel,
 * rather than by a hard-coded revision: Playwright updates revisions regularly.
 * Set PLAYWRIGHT_BROWSERS_PATH to isolate the cache (or to `0` for the package
 * local cache).  PLAYWRIGHT_INSTALL_COMMAND may override the install command
 * for controlled environments; the default is `npx playwright install`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const require = createRequire(import.meta.url);

const repoRoot = resolve(new URL('..', import.meta.url).pathname);

export function browserCachePath(env = process.env) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === '0') return join(repoRoot, 'node_modules', 'playwright-core', '.local-browsers');
  return resolve(configured || join(env.HOME || process.cwd(), '.cache', 'ms-playwright'));
}

export function requiredBrowsers(env = process.env) {
  // Playwright's `chromium` project launches chromium-headless-shell in headless
  // mode. Checking only the full Chromium bundle therefore produces a false
  // healthy result when disk reclamation deletes the headless-shell directory.
  return (env.PLAYWRIGHT_BROWSERS || 'chromium,chromium-headless-shell,ffmpeg')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

export function hasBrowserInstall(cacheDir, browser, revision) {
  if (!existsSync(cacheDir)) return false;
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const cacheName = browser.replaceAll('-', '_');
  const prefix = revision ? `${cacheName}-${revision}` : `${cacheName}-`;
  return entries.some((entry) =>
    entry.isDirectory() && (revision ? entry.name === prefix : entry.name.startsWith(prefix)) &&
    existsSync(join(cacheDir, entry.name, 'INSTALLATION_COMPLETE')),
  );
}

export function expectedBrowserRevision(browser) {
  try {
    const packageJson = require.resolve('playwright-core/package.json');
    const registry = JSON.parse(readFileSync(join(resolve(packageJson, '..'), 'browsers.json'), 'utf8'));
    const entry = registry.browsers.find((item) => item.name === browser);
    return entry?.revision || null;
  } catch {
    return null;
  }
}

export function missingPlaywrightBrowsers({ env = process.env } = {}) {
  const cacheDir = browserCachePath(env);
  return requiredBrowsers(env).filter((browser) => {
    const revision = expectedBrowserRevision(browser);
    return !hasBrowserInstall(cacheDir, browser, revision || undefined);
  });
}

export function ensurePlaywrightBrowsers({ env = process.env, run = spawnSync } = {}) {
  const cacheDir = browserCachePath(env);
  const missing = missingPlaywrightBrowsers({ env });
  if (missing.length === 0) {
    return { installed: true, cacheDir, missing: [], ranInstall: false };
  }

  const command = env.PLAYWRIGHT_INSTALL_COMMAND || `npx playwright install ${missing.join(' ')}`;
  const result = run(command, {
    cwd: repoRoot,
    env: { ...env, PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || cacheDir },
    shell: true,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Playwright browser installation failed (exit ${result.status}). Command: ${command}`);
  }
  const stillMissing = missingPlaywrightBrowsers({ env });
  if (stillMissing.length) {
    throw new Error(`Playwright install completed without INSTALLATION_COMPLETE for: ${stillMissing.join(', ')} (cache: ${cacheDir})`);
  }
  return { installed: true, cacheDir, missing: [], ranInstall: true };
}

if (isCliEntry(import.meta.url)) {
  try {
    if (process.argv.includes('--check')) {
      const missing = missingPlaywrightBrowsers();
      if (missing.length) throw new Error(`missing browser installation(s): ${missing.join(', ')}`);
      console.log(`Playwright browsers ready in ${browserCachePath()}`);
      process.exit(0);
    }
    const result = ensurePlaywrightBrowsers();
    console.log(result.ranInstall ? `Playwright browsers installed in ${result.cacheDir}` : `Playwright browsers ready in ${result.cacheDir}`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    console.error('Set PLAYWRIGHT_INSTALL_COMMAND to a reachable installer or run `npx playwright install`.');
    process.exitCode = 1;
  }
}
