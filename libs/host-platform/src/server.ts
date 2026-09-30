/**
 * Server `HostPlatform` stub — env-only resolution; throws on filesystem
 * access.
 *
 * Used by hosts that don't have a local user filesystem: multi-tenant
 * webapp deploys (Phase 8), CI test environments, future browser hosts
 * (in principle).
 *
 * The throw-on-fs design is intentional. We don't want a server host to
 * silently fall back to reading `/etc/whatever` or `/home/whoever` — every
 * fs touch that worked on desktop is something the server has to either
 * (a) wire through a real storage backend (PG, object store), or
 * (b) drop entirely. The thrown error message names the call site so the
 * fix is mechanical.
 *
 * Consumers that need to work on both desktop and server must avoid
 * `readTextFileSync` / `fileExistsSync` / `homedir` — those are
 * host-specific by definition. Database URL is provided via env on the
 * server, same shape as desktop.
 */

import type { HostPlatform } from './index';

function notAvailable(method: string): never {
  throw new Error(
    `host-platform/server: ${method} is not available on the server host. ` +
      'Server hosts must source data from env vars, PG, or an object store ' +
      '— not from a local filesystem. If this is a desktop-only code path, ' +
      'guard the call site with a host capability check before reaching it.',
  );
}

export const serverHostPlatform: HostPlatform = {
  readTextFileSync(absolutePath: string): string | null {
    notAvailable(`readTextFileSync('${absolutePath}')`);
  },

  fileExistsSync(absolutePath: string): boolean {
    notAvailable(`fileExistsSync('${absolutePath}')`);
  },

  homedir(): string {
    notAvailable('homedir()');
  },

  getHarnessAdminUrl(): string {
    const fromEnv =
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      process.env.DATABASE_URL ??
      process.env.PAPERCUSP_PG_URL;
    if (!fromEnv) {
      throw new Error(
        'host-platform/server: getHarnessAdminUrl() needs HARNESS_ADMIN_DATABASE_URL, ' +
          'DATABASE_URL, or PAPERCUSP_PG_URL in env. Server hosts have no ' +
          'embedded-pg discovery file and no native-PG fallback.',
      );
    }
    return fromEnv;
  },
};
