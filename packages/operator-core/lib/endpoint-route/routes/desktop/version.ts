/**
 * GET /api/desktop/version  (+ OPTIONS preflight)
 *
 * Returns minimal "what's running" info for the harness UI's bottom-right
 * pill — running version + sha, started-at, is-desktop. Used to detect
 * server restarts (sha change between polls → amber pill → click-to-reload).
 *
 * Ported from app/api/desktop/version/route.ts (Next handler) to the
 * endpoint-system framework — R1 pilot of endpoint-route-migration.
 * `auth: 'public'` preserves the original behavior (the route had no
 * auth); revisit in R5 if version info should be gated.
 *
 * WI-4245: this route used to detect sha/version ITSELF — a live
 * `git rev-parse` off `process.cwd()` plus a search over relative
 * `papercusp-desktop/package.json` candidate paths, and a phantom
 * `PAPERCUSP_DESKTOP_VERSION` env var release-local.sh never actually sets.
 * None of that resolves in a packaged build (no bundled `.git`, no sibling
 * package.json at any of those relative paths from the packaged sidecar's
 * cwd) — every packaged install fell through to "vdev · unknown". `/api/health`
 * (misc/health.ts) already solves exactly this via `getBuildInfo()`
 * (build-info.ts), which prefers the baked `PAPERCUSP_BUILD_SHA`/
 * `PAPERCUSP_BUILD_VERSION` env vars a packaged build's release-local.sh
 * actually exports into the running sidecar — reuse that single source of
 * truth here instead of a second, less-robust detector.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getBuildInfo } from '../../../build-info';

const startedAtMs = Date.now();

const { sha: buildSha, version: appVersion } = getBuildInfo();

export interface DesktopVersionPayload {
  appVersion: string;
  sidecarSha: string;
  sidecarStartedAtMs: number;
  nowMs: number;
  isDesktop: boolean;
}

/**
 * Pure payload builder — exported so the "does it actually surface baked
 * provenance" behavior is unit-testable without fighting this module's
 * import-time `getBuildInfo()` memoization. `sha` is coerced to the old
 * "unknown" sentinel when null: `sidecarSha` is a non-null string on the
 * wire (VersionBadge's restart detection compares it directly).
 */
export function buildDesktopVersionPayload(
  buildInfo: { sha: string | null; version: string },
  opts: { startedAtMs: number; nowMs: number; isDesktop: boolean },
): DesktopVersionPayload {
  return {
    appVersion: buildInfo.version,
    sidecarSha: buildInfo.sha ?? 'unknown',
    sidecarStartedAtMs: opts.startedAtMs,
    nowMs: opts.nowMs,
    isDesktop: opts.isDesktop,
  };
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/version',
    auth: 'public',
    handler() {
      return new Response(
        JSON.stringify(
          buildDesktopVersionPayload(
            { sha: buildSha, version: appVersion },
            { startedAtMs, nowMs: Date.now(), isDesktop: process.env.PAPERCUSP_DESKTOP === '1' },
          ),
        ),
        { headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
      );
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/version',
    auth: 'public',
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
