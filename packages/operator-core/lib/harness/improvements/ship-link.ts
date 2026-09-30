/**
 * ship-link.ts — the links-5–6 observability assertion
 * (hive-loop-e2e-testing-2026-06-10 P-011).
 *
 * Landed work flows: git-sync commits the integration tree (`staging`) →
 * green-checkpoint (hourly) fast-forwards `main` to a green staging commit →
 * release-trigger deploys green `main`. This collector asserts the FLOW, not
 * any single hop: when the OLDEST staging commit not yet reachable from `main`
 * is older than `maxLagHours`, the ship link is stuck — git-sync stopped,
 * the checkpoint routine stopped running, or the gate has been persistently
 * red — and the canary's (or anyone's) landed work is not shipping. This is
 * exactly the failure class the per-hop signals miss: `routine-failure` sees a
 * THROWN checkpoint, the `release-not-green` escalation sees a RED gate, but a
 * silently-not-running link shows up only as lag.
 *
 * An assertion over the existing pipeline, not a new one: pure git reads, no
 * writes. Skips (with a note) when `PAPERCUSP_INTEGRATION_ROOT` is unset — the
 * same env the release host exports for the release lib (release-config.ts);
 * ref names follow the same `PAPERCUSP_RELEASE_REF` / `PAPERCUSP_INTEGRATION_BRANCH`
 * overrides.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CollectorResult, WatchdogSignal } from './watchdog';

const exec = promisify(execFile);

export interface ShipLinkState {
  /** Unix SECONDS of the oldest staging commit not reachable from main; null = main is up to date. */
  oldestUnshippedSec: number | null;
  /** How many staging commits main is behind. */
  behindCount: number;
}

/** Pure: the lag decision. Fires when unshipped work is older than the lag bar. */
export function shipLinkSignalsFromState(
  state: ShipLinkState,
  opts: { maxLagHours?: number; nowMs?: number; releaseRef?: string; integrationBranch?: string } = {},
): WatchdogSignal[] {
  const maxLagHours = opts.maxLagHours ?? 6;
  const nowMs = opts.nowMs ?? Date.now();
  const releaseRef = opts.releaseRef ?? 'main';
  const integrationBranch = opts.integrationBranch ?? 'staging';
  if (state.oldestUnshippedSec == null) return [];
  const lagHours = (nowMs - state.oldestUnshippedSec * 1000) / 3_600_000;
  if (lagHours < maxLagHours) return [];
  return [{
    source: 'ship-link-stuck',
    key: `${integrationBranch}->${releaseRef}`,
    title: `The ship link (${integrationBranch} → ${releaseRef}) is not flowing`,
    body:
      `Watchdog signal (ship-link-stuck): the oldest ${integrationBranch} commit not yet in ${releaseRef} is ` +
      `~${Math.round(lagHours)}h old (${state.behindCount} commit(s) behind; lag bar ${maxLagHours}h). Landed work — ` +
      `including the daily canary's — is not reaching ${releaseRef}: either git-sync stopped committing/pushing, ` +
      `the green-checkpoint routine stopped running, or the gate has been red for hours (check the ` +
      `release-not-green escalation + /admin/git).`,
    severity: 'major',
    kind: 'bug',
  }];
}

/** Read the staging→main gap from the integration tree (oldest unshipped commit + count). */
export async function readShipLinkState(
  integrationRoot: string,
  releaseRef: string,
  integrationBranch: string,
): Promise<ShipLinkState> {
  const { stdout } = await exec(
    'git',
    ['-C', integrationRoot, 'log', `${releaseRef}..${integrationBranch}`, '--format=%ct', '--reverse'],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { oldestUnshippedSec: null, behindCount: 0 };
  return { oldestUnshippedSec: Number(lines[0]), behindCount: lines.length };
}

/**
 * The collector (registered in defaultPapercuspCollectors). Skips with a note
 * off the release host (env unset) or on any git failure — the link monitor
 * must never become its own noise source.
 */
export async function collectShipLinkSignals(
  opts: { maxLagHours?: number } = {},
): Promise<CollectorResult> {
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (!integrationRoot) {
    return { signals: [], note: 'skipped: PAPERCUSP_INTEGRATION_ROOT unset (not the release host)' };
  }
  const releaseRef = process.env.PAPERCUSP_RELEASE_REF?.trim() || 'main';
  const integrationBranch = process.env.PAPERCUSP_INTEGRATION_BRANCH?.trim() || 'staging';
  try {
    const state = await readShipLinkState(integrationRoot, releaseRef, integrationBranch);
    return { signals: shipLinkSignalsFromState(state, { ...opts, releaseRef, integrationBranch }) };
  } catch (e) {
    return { signals: [], note: `skipped: git read failed (${e instanceof Error ? e.message : e})` };
  }
}
