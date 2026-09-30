/**
 * P-501 canary-soak observations: the substantive pass predicates (C1-C6) of
 * the 72h post-GO canary, plus the hourly sampler that produces them.
 *
 * `validatePostGoReleaseCanary` used to accept any 72h window that had the
 * right candidate and timestamps — including one full of divergence
 * escalations and git-sync STALLED pages (WI-10002545). This module is the
 * missing half: a receipt must now carry hourly observations of the canary
 * hive's git-sync routine and bridge, and every predicate of runbook
 * `agent-insights/p2p-post-go-canary-and-owner-freeze-drill-runbook` must
 * hold across the whole window.
 *
 *   C1 divergence quiet     — every sample: divergence 'clear', no needs-owner, no bridge errors
 *   C2 no open escalation   — every sample: openEscalations === 0
 *   C3 no false alarms      — no page in the window adjudicated (or left un-adjudicated) as a false alarm
 *   C4 commit loop healthy  — active, fresh lastFiredAt, no watchdog alert, no two consecutive error/quarantined, no true-positive page
 *   C5 fork current         — bridge ran with a real egress target; fork head == egress head, allowing one lagging sample
 *   C6 alarms wired         — both alarm sources notify urgently, and a real page was delivered in the 14 days before evaluation
 *
 * D-044 (endgame plan): the soak runs on a hive whose bridge really egresses,
 * and it must not START if that egress has regressed to a skip —
 * `assertCanarySoakStartable` is that refusal, enforced by the producer's
 * first sample.
 */
import { getOrgPg } from '@papercusp/db-org';
import { loadHarnessRegistry } from '../../harness-registry';
import { BRIDGE_REMOTE_STAGING_REF } from './github-bridge-tick';
import { defaultRunGit, type RunGit } from './storage';

export const POST_GO_CANARY_SAMPLE_MAX_GAP_MS = 60 * 60 * 1_000;
export const POST_GO_CANARY_ALARM_RAIL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
/** A routine whose last fire is older than this many intervals is not healthy (C4). */
export const POST_GO_CANARY_STALE_FIRE_INTERVALS = 3;

const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const UNHEALTHY_STATUSES = new Set(['error', 'quarantined']);

export type PostGoCanaryObservation = {
  at: string;
  hive: string;
  active: boolean;
  lastFiredAt: string | null;
  lastStatus: string | null;
  watchdogAlerted: boolean;
  eligibilityAlerted: boolean;
  bridgeRan: boolean;
  bridgeSkipped: string | null;
  divergence: string | null;
  needsOwner: boolean;
  bridgeErrors: string[];
  egressTarget: string | null;
  egressHead: string | null;
  forkHead: string | null;
  openEscalations: number;
};

export type PostGoCanaryAlarm = {
  createdAt: string;
  title: string;
  /** Absent means nobody adjudicated it — that fails C3 as well. */
  adjudication?: 'false-alarm' | 'true-positive';
  ref?: string;
};

export type PostGoCanaryAlarmRail = {
  divergenceNotifiesUrgent: boolean;
  stallWatchdogNotifiesUrgent: boolean;
  deliveredPageAt: string;
  deliveredPageRef: string;
};

export type PostGoCanaryEvidence = {
  hive: string;
  routineIntervalSec: number;
  observations: PostGoCanaryObservation[];
  alarms: PostGoCanaryAlarm[];
  alarmRail: PostGoCanaryAlarmRail;
};

function ms(value: unknown): number {
  return Date.parse(typeof value === 'string' ? value : '');
}

function egressIsReal(sample: PostGoCanaryObservation): boolean {
  return (
    sample.bridgeRan === true &&
    typeof sample.egressTarget === 'string' &&
    sample.egressTarget !== '' &&
    sample.egressTarget !== 'skipped' &&
    GIT_OID.test(sample.egressHead ?? '')
  );
}

/**
 * D-044: refuse to start the soak on a sample whose bridge egress is not real.
 * Returns the refusal reasons; empty means the soak may start.
 */
export function canarySoakStartRefusals(sample: PostGoCanaryObservation): string[] {
  const reasons: string[] = [];
  if (sample.bridgeRan !== true) {
    reasons.push(`bridge did not run${sample.bridgeSkipped ? ` (skipped: ${sample.bridgeSkipped})` : ''}`);
  }
  if (!sample.egressTarget || sample.egressTarget === 'skipped') {
    reasons.push(`egress target is ${sample.egressTarget ?? 'absent'}`);
  }
  if (!GIT_OID.test(sample.egressHead ?? '')) reasons.push('egress head is absent');
  if (sample.divergence !== 'clear') reasons.push(`divergence is ${sample.divergence ?? 'absent'}`);
  if (sample.openEscalations !== 0) reasons.push(`${sample.openEscalations} open escalation(s)`);
  return reasons;
}

export function assertCanarySoakStartable(sample: PostGoCanaryObservation): void {
  const reasons = canarySoakStartRefusals(sample);
  if (reasons.length > 0) {
    throw new Error(`P-501 canary soak on ${sample.hive} cannot start: ${reasons.join('; ')}`);
  }
}

/**
 * Validate the substantive P-501 predicates over the canary window. Returns
 * error strings (empty = every predicate held for the whole window).
 */
export function validatePostGoCanaryEvidence(
  evidence: PostGoCanaryEvidence | undefined,
  window: { startedAt: string; finishedAt: string },
  evaluatedAt: string,
): string[] {
  const errors: string[] = [];
  if (!evidence || typeof evidence !== 'object') {
    return ['canary must carry P-501 observation evidence (hive, routineIntervalSec, observations, alarms, alarmRail)'];
  }
  const start = ms(window.startedAt);
  const finish = ms(window.finishedAt);
  const evaluated = ms(evaluatedAt);
  const hive = typeof evidence.hive === 'string' ? evidence.hive.trim() : '';
  if (!hive) errors.push('canary evidence must name the canary hive');
  const intervalSec = Number(evidence.routineIntervalSec);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    errors.push('canary evidence must carry the git-sync routineIntervalSec');
  }

  const samples = Array.isArray(evidence.observations) ? evidence.observations : [];
  if (samples.length === 0) {
    errors.push('canary must carry hourly observations of the canary hive');
  }

  // ── coverage: hourly, spanning the window, ordered, all on the named hive ──
  let previousAt = Number.NaN;
  samples.forEach((sample, index) => {
    const at = ms(sample?.at);
    const label = `observation ${index} (${sample?.at ?? 'no timestamp'})`;
    if (!Number.isFinite(at)) {
      errors.push(`${label} must carry an ISO-8601 timestamp`);
      return;
    }
    if (Number.isFinite(start) && Number.isFinite(finish) && (at < start || at > finish)) {
      errors.push(`${label} falls outside the canary window`);
    }
    if (sample.hive !== hive) errors.push(`${label} observes ${sample.hive}, not the canary hive ${hive}`);
    if (Number.isFinite(previousAt)) {
      if (at <= previousAt) errors.push(`${label} is not after the previous observation`);
      else if (at - previousAt > POST_GO_CANARY_SAMPLE_MAX_GAP_MS) {
        errors.push(`${label} leaves a gap over 1 hour since the previous observation`);
      }
    }
    previousAt = at;
  });
  if (samples.length > 0 && Number.isFinite(start) && Number.isFinite(finish)) {
    const first = ms(samples[0]?.at);
    const last = ms(samples[samples.length - 1]?.at);
    if (!(first - start <= POST_GO_CANARY_SAMPLE_MAX_GAP_MS)) {
      errors.push('the first observation must be taken within 1 hour of the canary start');
    }
    if (!(finish - last <= POST_GO_CANARY_SAMPLE_MAX_GAP_MS)) {
      errors.push('the last observation must be taken within 1 hour of the canary finish');
    }
  }

  samples.forEach((sample, index) => {
    if (!sample || !Number.isFinite(ms(sample.at))) return;
    const label = `observation ${index} (${sample.at})`;
    // C1 divergence quiet
    if (sample.divergence !== 'clear') errors.push(`C1: ${label} divergence is ${sample.divergence ?? 'absent'}`);
    if (sample.needsOwner === true) errors.push(`C1: ${label} bridge needs the owner`);
    if (!Array.isArray(sample.bridgeErrors) || sample.bridgeErrors.length > 0) {
      errors.push(`C1: ${label} bridge reports errors`);
    }
    // C2 no open escalation
    if (sample.openEscalations !== 0) {
      errors.push(`C2: ${label} has ${sample.openEscalations} open escalation(s) on the canary hive`);
    }
    // C4 commit loop healthy (per sample)
    if (sample.active !== true) errors.push(`C4: ${label} git-sync routine is not active`);
    if (sample.watchdogAlerted === true) errors.push(`C4: ${label} git-sync watchdog is alerted`);
    if (sample.eligibilityAlerted === true) errors.push(`C4: ${label} eligibility watchdog is alerted`);
    const fired = ms(sample.lastFiredAt);
    if (!Number.isFinite(fired)) {
      errors.push(`C4: ${label} git-sync routine has never fired`);
    } else if (
      Number.isFinite(intervalSec) &&
      ms(sample.at) - fired > POST_GO_CANARY_STALE_FIRE_INTERVALS * intervalSec * 1_000
    ) {
      errors.push(`C4: ${label} last fire is older than ${POST_GO_CANARY_STALE_FIRE_INTERVALS}x the routine interval`);
    }
    const previous = index > 0 ? samples[index - 1] : undefined;
    if (
      previous &&
      UNHEALTHY_STATUSES.has(previous.lastStatus ?? '') &&
      UNHEALTHY_STATUSES.has(sample.lastStatus ?? '')
    ) {
      errors.push(`C4: ${label} git-sync status is ${sample.lastStatus} for two consecutive samples`);
    }
    // C5 fork current via real egress (one lagging sample tolerated, never two in a row)
    if (!egressIsReal(sample)) {
      errors.push(
        `C5: ${label} bridge egress is not real (ran ${sample.bridgeRan === true}, target ${sample.egressTarget ?? 'absent'}, head ${sample.egressHead ?? 'absent'})`,
      );
    } else if (sample.forkHead !== sample.egressHead) {
      const previousLagged =
        previous !== undefined && egressIsReal(previous) && previous.forkHead !== previous.egressHead;
      if (previousLagged) errors.push(`C5: ${label} fork head still differs from the egress head a sample later`);
    }
  });
  const lastSample = samples[samples.length - 1];
  if (lastSample && egressIsReal(lastSample) && lastSample.forkHead !== lastSample.egressHead) {
    errors.push('C5: the fork head differs from the egress head at the final observation');
  }

  // C3 / C4 alarm adjudication: any page in the window is a failure, with the reason by kind.
  const alarms = Array.isArray(evidence.alarms) ? evidence.alarms : null;
  if (!alarms) errors.push('canary evidence must carry the alarm-history result (an empty list when quiet)');
  for (const alarm of alarms ?? []) {
    const at = ms(alarm?.createdAt);
    if (Number.isFinite(start) && Number.isFinite(finish) && Number.isFinite(at) && (at < start || at > finish)) {
      continue; // outside the window: not this soak's alarm
    }
    const label = `alarm "${alarm?.title ?? 'untitled'}" (${alarm?.createdAt ?? 'no timestamp'})`;
    if (alarm?.adjudication === 'true-positive') {
      errors.push(`C4: ${label} is a true positive — the commit loop was unhealthy during the soak`);
    } else if (alarm?.adjudication === 'false-alarm') {
      errors.push(`C3: ${label} is a watchdog false alarm`);
    } else {
      errors.push(`C3: ${label} was never adjudicated`);
    }
  }

  // C6 alarms wired
  const rail = evidence.alarmRail;
  if (rail?.divergenceNotifiesUrgent !== true || rail?.stallWatchdogNotifiesUrgent !== true) {
    errors.push('C6: both the divergence and the stall-watchdog alarms must notify with urgent importance');
  }
  const deliveredAt = ms(rail?.deliveredPageAt);
  if (
    !Number.isFinite(deliveredAt) ||
    !Number.isFinite(evaluated) ||
    deliveredAt > evaluated ||
    evaluated - deliveredAt > POST_GO_CANARY_ALARM_RAIL_MAX_AGE_MS
  ) {
    errors.push('C6: a real page must have been delivered within the 14 days before evaluation');
  }
  if (typeof rail?.deliveredPageRef !== 'string' || rail.deliveredPageRef.trim() === '') {
    errors.push('C6: the delivered page must carry a durable reference');
  }
  return errors;
}

// ── sampler ─────────────────────────────────────────────────────────────────

type OrgSql = ReturnType<typeof getOrgPg>['sql'];
type Registry = { projects: Array<{ slug: string; github_remote?: string; fork_remote?: string }> };

export type CanarySamplerDeps = {
  sql?: OrgSql;
  runGit?: RunGit;
  loadRegistry?: () => Promise<Registry>;
  now?: () => Date;
  workspaceId?: string;
};

const DEFAULT_WORKSPACE = 'papercusp-workspace';

function truthy(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Take one P-501 observation of `hive`: its git-sync routine row, the
 * bridge block in that row's metadata, the open-escalation count, and the
 * egress remote's staging head read with `git ls-remote`. Read-only.
 */
export async function capturePostGoCanaryObservation(
  hive: string,
  deps: CanarySamplerDeps = {},
): Promise<PostGoCanaryObservation> {
  const sql = deps.sql ?? getOrgPg().sql;
  const workspaceId = deps.workspaceId ?? DEFAULT_WORKSPACE;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const rows = await sql<Array<{ active: boolean; last_fired_at: Date | string | null; metadata: Record<string, unknown> | null }>>`
    SELECT active, last_fired_at, metadata
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${hive}
       AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`P-501 canary hive ${hive} has no git-sync routine`);
  const metadata = row.metadata ?? {};
  const bridge = metadata.github_bridge && typeof metadata.github_bridge === 'object'
    ? metadata.github_bridge as Record<string, unknown>
    : {};
  const escalations = await sql<Array<{ open: number | string }>>`
    SELECT count(*) AS open
      FROM harness_shared.harness_escalations
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${hive}
       AND escalation IS NOT NULL
  `;
  const egressTarget = typeof bridge.egress_target === 'string' ? bridge.egress_target : null;
  const egressHead = typeof bridge.egress_head === 'string' ? bridge.egress_head : null;

  let forkHead: string | null = null;
  if (egressTarget === 'fork' || egressTarget === 'upstream') {
    const entry = (await (deps.loadRegistry ?? loadHarnessRegistry)()).projects.find((p) => p.slug === hive);
    const remote = egressTarget === 'fork' ? entry?.fork_remote : entry?.github_remote;
    if (remote) {
      const result = await (deps.runGit ?? defaultRunGit)(
        ['ls-remote', '--refs', remote, BRIDGE_REMOTE_STAGING_REF],
        process.cwd(),
        { timeoutMs: 5 * 60_000 },
      );
      const oid = result.code === 0 ? result.stdout.trim().split(/\s+/)[0] ?? '' : '';
      forkHead = GIT_OID.test(oid) ? oid : null;
    }
  }

  return {
    at,
    hive,
    active: row.active === true,
    lastFiredAt: row.last_fired_at ? new Date(row.last_fired_at).toISOString() : null,
    lastStatus: typeof metadata.last_status === 'string' ? metadata.last_status : null,
    watchdogAlerted: truthy(metadata.watchdog_alerted),
    eligibilityAlerted: truthy(metadata.eligibility_alerted),
    bridgeRan: bridge.ran === true,
    bridgeSkipped: typeof bridge.skipped === 'string' ? bridge.skipped : null,
    divergence: typeof bridge.divergence === 'string' ? bridge.divergence : null,
    needsOwner: truthy(bridge.needs_owner),
    bridgeErrors: Array.isArray(bridge.errors) ? bridge.errors.map((e) => String(e)) : [],
    egressTarget,
    egressHead,
    forkHead,
    openEscalations: Number(escalations[0]?.open ?? 0),
  };
}

/**
 * Append one observation to a soak's sample list. An empty list is the soak
 * START, which is refused (D-044) unless the hive's bridge egress is real.
 */
export function appendCanaryObservation(
  existing: PostGoCanaryObservation[],
  sample: PostGoCanaryObservation,
): PostGoCanaryObservation[] {
  if (existing.length === 0) assertCanarySoakStartable(sample);
  const hive = existing[0]?.hive;
  if (hive !== undefined && hive !== sample.hive) {
    throw new Error(`P-501 sample for ${sample.hive} cannot join a soak observing ${hive}`);
  }
  return [...existing, sample];
}
