import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { readHostedHttp1AcceptanceConfig } from './e2e/_hosted-http1-config';

const acceptance = readHostedHttp1AcceptanceConfig();

/**
 * Live-only P-029 profile. Chromium is forced off HTTP/2 and QUIC, and the
 * spec proves the negotiated protocol from CDP rather than trusting the flags.
 * Traces/video stay off because they can retain credentialed request headers;
 * the spec attaches a deliberately redacted JSON receipt instead.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /hosted-http1-acceptance\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 8 * 60_000,
  reporter: [
    ['list'],
    ['json', { outputFile: join(acceptance.evidenceDir, 'playwright-results.json') }],
  ],
  outputDir: join(acceptance.evidenceDir, 'artifacts'),
  use: {
    baseURL: acceptance.origin,
    storageState: acceptance.storageStatePath,
    proxy: acceptance.proxyServer ? { server: acceptance.proxyServer } : undefined,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    launchOptions: {
      args: [
        '--disable-http2',
        '--disable-quic',
        '--disable-features=UseDnsHttpsSvcbAlpn',
      ],
    },
  },
  projects: [{ name: 'chromium-http1', use: { ...devices['Desktop Chrome'] } }],
  webServer: undefined,
});
