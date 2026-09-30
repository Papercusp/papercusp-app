#!/usr/bin/env node
/**
 * substrate-status — one-screen substrate diagnostic CLI.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Hits the operator's substrate JSON endpoints + prints a compact
 * status report. Same data as /admin/dogfood-substrate but in a
 * terminal-friendly form so monitoring scripts, CI, and `+` console
 * launches can surface the substrate state without a browser.
 *
 * Reads:
 *   - PAPERCUSP_API_BASE (default http://127.0.0.1:3070)
 *
 * Exit codes:
 *   0  flag off OR every harness healthy
 *   1  any harness is degraded / unhealthy / booting (or boot map empty)
 *   2  fetch failed entirely (operator unreachable)
 *
 * Formatting + verdict mapping lives in
 * lib/sync/hyperbee/format-cli.ts (unit-tested). This script is a
 * thin fetch + print wrapper.
 */

import { formatSubstrateStatus } from '@papercusp/operator-core/lib/sync/hyperbee/format-cli';

const baseUrl = (process.env.PAPERCUSP_API_BASE ?? 'http://127.0.0.1:3070').replace(
  /\/$/,
  '',
);

interface FetchOk<T> {
  ok: T;
  err?: never;
}
interface FetchErr {
  err: string;
  ok?: never;
}
type FetchResult<T> = FetchOk<T> | FetchErr;

async function get<T = unknown>(path: string): Promise<FetchResult<T>> {
  try {
    const res = await fetch(baseUrl + path, { cache: 'no-store' });
    if (!res.ok) return { err: `HTTP ${res.status}` };
    return { ok: (await res.json()) as T };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

interface StatusResponse {
  enabled?: boolean;
  bootedCount?: number;
  booted?: Array<{ workspaceId: string; harnessSlug: string }>;
}

interface HealthResponse {
  harnesses?: Parameters<typeof formatSubstrateStatus>[0]['harnesses'];
  summary?: Parameters<typeof formatSubstrateStatus>[0]['summary'];
}

async function main(): Promise<void> {
  const status = await get<StatusResponse>('/api/admin/dogfood-substrate-status');
  if ('err' in status && status.err) {
    console.error(`✗ substrate-status fetch failed: ${status.err}`);
    process.exit(2);
  }
  const ok = status.ok ?? {};
  const enabled = ok.enabled === true;
  const bootedCount =
    typeof ok.bootedCount === 'number'
      ? ok.bootedCount
      : Array.isArray(ok.booted)
        ? ok.booted.length
        : 0;

  if (!enabled || bootedCount === 0) {
    const out = formatSubstrateStatus({ enabled, bootedCount });
    for (const line of out.lines) console.log(line);
    // NOT process.exit(): the loop above can emit well past what a pipe flushes
    // synchronously, and exit() does not drain it — piping this status would drop the
    // tail. See scripts/check-undrained-stdout-exit.mjs.
    process.exitCode = out.exitCode;
    return;
  }

  const health = await get<HealthResponse>('/api/admin/dogfood-substrate-health');
  if ('err' in health && health.err) {
    console.error(`✗ substrate-health fetch failed: ${health.err}`);
    process.exit(2);
  }
  const hok = health.ok ?? {};

  const out = formatSubstrateStatus({
    enabled,
    bootedCount,
    harnesses: hok.harnesses ?? [],
    summary: hok.summary ?? null,
  });
  for (const line of out.lines) console.log(line);
  // NOT process.exit() — see above. Last statement, so exitCode alone suffices.
  process.exitCode = out.exitCode;
}

main().catch((e) => {
  console.error('substrate-status: unexpected error:', e);
  process.exit(2);
});
