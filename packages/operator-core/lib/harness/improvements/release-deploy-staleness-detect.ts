/**
 * Release-deploy-staleness watchdog collector (EI-9136).
 *
 * `release-deploy-staleness-watchdog.ts` (WI-1623) already computes, correctly,
 * whether the green pin has sat deployable-but-not-live past a threshold — but its
 * ONLY output on a stale finding is a `console.warn` + a row in the separate
 * `hive_watchdog_fires` ledger (via `recordFire`). Neither reaches a human or an
 * agent: server stdout nobody tails, and a ledger nothing surfaces to the
 * improvement queue. EI-9136 is exactly this gap made concrete — the release pin
 * sat 12h+ behind tip (owner-facing rubrics UI invisible the whole time) and
 * NOBODY WAS PAGED, because the alert never left the process that raised it.
 *
 * This module is the missing wire: it reuses the EXISTING pure decider
 * (`evaluateDeployStaleness`) and the existing pipeline snapshot
 * (`gitPipelineSnapshot` + `computeDeployStatus`) — no re-derived logic — and maps
 * a stale verdict onto a `WatchdogSignal`-shaped finding so it flows through the
 * SAME collector → capture → fleet-visible-EI pipeline every other watchdog source
 * already uses (mirrors dark-flag-age-detect.ts: a pure detector + a thin IO
 * collector, no import from the large watchdog.ts, its own structural type so it
 * needs no WatchdogSource union member... except release/deploy state genuinely
 * IS operator-scoped like dark-flag-age, so it registers the same way).
 *
 * WORKSPACE-GLOBAL (one release pipeline, not per-harness) — deliberately NOT a
 * HARNESS_SCOPED_WATCHDOG_SOURCES entry. No flag gate: a healthy (non-stale)
 * pipeline emits nothing, and the underlying watchdog's own kill switch
 * (PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC<=0) already makes this a no-op when
 * disabled (the sweep call below returns thresholdMs<=0 ⇒ never stale).
 */
import {
  evaluateDeployStaleness,
  deployStalenessThresholdSec,
  type DeployStalenessVerdict,
} from '../../release-deploy-staleness-watchdog';

/** dedup key — ONE stable global finding, so re-fires within the same stale episode
 *  collapse to a single open EI instead of spamming a new one per tick. */
const FINDING_KEY = 'release-deploy-staleness';

/** Structurally a WatchdogSignal (own type so this pure module needs no import from
 *  the large watchdog.ts) — mapped 1:1 onto one at the collector-registration site. */
export interface ReleaseDeployStalenessFinding {
  source: 'release-deploy-staleness';
  key: typeof FINDING_KEY;
  title: string;
  body: string;
  severity: 'major';
  kind: 'change';
  scope: 'operator';
  paths: string[];
}

/**
 * Pure: a stale verdict → a finding, or none. Reuses `evaluateDeployStaleness`
 * (WI-1623) directly — this module adds NO staleness logic of its own, only the
 * missing "make it fleet-visible" wire.
 */
export function detectReleaseDeployStaleness(verdict: DeployStalenessVerdict): ReleaseDeployStalenessFinding[] {
  if (!verdict.stale) return [];
  return [
    {
      source: 'release-deploy-staleness' as const,
      key: FINDING_KEY,
      title: 'Release pin has sat deployable-but-not-live for an unreasonable time — owner-facing features may be invisible',
      body:
        `Watchdog signal (release-deploy-staleness, WI-1623's decider): ${verdict.reason}\n\n` +
        `This finding exists because the underlying sweep (release-deploy-staleness-watchdog.ts) only ` +
        `logs + records a ledger row on its own — nothing pages a human or an agent (EI-9136: a real ` +
        `12h+ stale window with owner-facing rubrics UI invisible went unnoticed). Check the release ` +
        `pipeline: \`routines:list\` for release-trigger/green-checkpoint health, and compare the ` +
        `release checkout's actual on-disk git state against the reported deployedAt.`,
      severity: 'major' as const,
      kind: 'change' as const,
      scope: 'operator' as const,
      paths: ['packages/operator-core/lib/release-deploy-staleness-watchdog.ts', 'apps/operator/lib/release/'],
    },
  ];
}

/**
 * The collector that feeds the pure detector. Reuses the existing `gitPipelineSnapshot`
 * + `computeDeployStatus` + `evaluateDeployStaleness` pipeline (no re-derived pipeline
 * logic) — this collector's only job is turning an already-computed stale verdict into
 * a signal the improvement-capture pipeline can see. WORKSPACE-GLOBAL: no workspaceId —
 * there is one release pipeline. Fail-soft: any error while reading pipeline state is
 * reported as a note, never thrown (a watchdog collector that crashes its host guards
 * nothing).
 */
export async function collectReleaseDeployStalenessSignals(opts: {
  now?: number;
  installSlug?: string;
} = {}): Promise<{ signals: ReleaseDeployStalenessFinding[]; note?: string }> {
  const thresholdSec = deployStalenessThresholdSec();
  if (thresholdSec <= 0) return { signals: [], note: 'kill switch (PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC<=0)' };
  try {
    const { gitPipelineSnapshot } = await import('../../git-pipeline-stats');
    const { computeDeployStatus } = await import('../../release-deploy-launch');
    const { operatorHomeHarnessSlug } = await import('../operator-home-harness');
    const installSlug = opts.installSlug ?? (process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug());
    const snap = await gitPipelineSnapshot(installSlug);
    const status = computeDeployStatus(snap);
    // EI-20101010229759029: this collector is the SECOND consumer of the decider, and it
    // built the same deployedAt-age-only input — so it filed the same false finding on its
    // own path. It only REPORTS on the condition (the sweep owns the clock), so it reads
    // the watermark rather than ticking it; an unresolvable read degrades to the fallback,
    // which labels itself inferred.
    const { readGreenDeployableSince } = await import('../../release-deploy-staleness-watchdog');
    const verdict = evaluateDeployStaleness({
      state: status.state,
      deployedAtMs: status.deploy.deployedAtMs,
      greenDeployableSinceMs: await readGreenDeployableSince(installSlug),
      now: opts.now ?? Date.now(),
      thresholdMs: thresholdSec * 1_000,
    });
    return { signals: detectReleaseDeployStaleness(verdict) };
  } catch (e) {
    return { signals: [], note: `release-deploy-staleness collector errored: ${e instanceof Error ? e.message : String(e)}` };
  }
}
