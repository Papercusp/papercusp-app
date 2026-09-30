/**
 * Desktop `HostPlatform` impl — node:fs + os.homedir + embedded-PG discovery.
 *
 * Default for Tauri (process running under the desktop sidecar), the
 * standalone `cd papercusp-desktop && npm run dev` operator, and tests
 * that don't explicitly register a different impl.
 *
 * Resolution logic mirrors what `apps/operator/lib/embedded-pg-discovery.ts`
 * has been doing pre-interface. Same env precedence, same discovery-file
 * path, same native fallback — only the call shape changes.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import type { HostPlatform } from './index';

const NATIVE_FALLBACK =
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

let cachedDbUrl: string | null = null;

function resolveHarnessAdminUrl(): string {
  if (cachedDbUrl) return cachedDbUrl;

  const fromEnv =
    process.env.HARNESS_ADMIN_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.PAPERCUSP_PG_URL;
  if (fromEnv) {
    cachedDbUrl = fromEnv;
    return cachedDbUrl;
  }

  // EI-13917: honor PAPERCUSP_HOME before the box-wide `~/.papercusp` — mirrors
  // the matching fix in connection.ts / serve.ts. A caller with its own isolated
  // PAPERCUSP_HOME (a gate/smoke-test instance) must discover ITS OWN discovery
  // file, never the box-canonical one.
  const papercuspDir = process.env.PAPERCUSP_HOME || join(osHomedir(), '.papercusp');
  const discoveryPath = join(papercuspDir, 'embedded-pg.json');
  try {
    const raw = readFileSync(discoveryPath, 'utf8');
    const parsed = JSON.parse(raw) as { url?: string; port?: number };
    if (parsed?.url) {
      cachedDbUrl = parsed.url;
      return cachedDbUrl;
    }
  } catch {
    // file missing or unparseable — fall through
  }

  cachedDbUrl = NATIVE_FALLBACK;
  return cachedDbUrl;
}

export const desktopHostPlatform: HostPlatform = {
  readTextFileSync(absolutePath: string): string | null {
    try {
      return readFileSync(absolutePath, 'utf8');
    } catch {
      return null;
    }
  },

  fileExistsSync(absolutePath: string): boolean {
    try {
      if (!existsSync(absolutePath)) return false;
      return statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  },

  homedir(): string {
    return osHomedir();
  },

  getHarnessAdminUrl(): string {
    return resolveHarnessAdminUrl();
  },
};

/** Test-only — clears the database-URL cache between tests. */
export function _resetDesktopHostPlatformCacheForTests(): void {
  cachedDbUrl = null;
}
