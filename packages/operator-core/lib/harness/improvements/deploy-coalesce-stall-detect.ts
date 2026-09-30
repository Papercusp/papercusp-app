/**
 * Consecutive-deploy-coalesce watchdog collector (EI-18835078701597295).
 *
 * THE GAP THIS CLOSES. `release-deploy` is a try-only single-flight lock (EI-13729): a
 * deploy that cannot take it COALESCES — stands down politely and exits 0. That is
 * correct exactly once. The dead-holder reclaim (EI-18674647773291145 /
 * EI-18833814302562374) self-heals the common leak, but it is deliberately conservative
 * and only fires for a holder whose owner string embeds a host-local pid AND whose pid is
 * definitively gone. It does NOT fire for:
 *   1. a LIVE-but-WEDGED holder (hung migration, hung drain, a child blocked on IO) —
 *      coalescing is "correct" by the single-flight rule, so every later attempt stands
 *      down politely, forever, while the pin goes stale;
 *   2. an owner shape carrying no parseable pid (a foreign holder of the lock, a manual
 *      `locks:acquire`, a future caller with a different identity convention);
 *   3. a pid that is alive but RECYCLED onto an unrelated process (PID wrap happens ~daily
 *      on this box under fleet load) — reads as ALIVE, so it is never reclaimed.
 * In all three, delivery halts and nothing pages.
 *
 * WHY NOT JUST LEAN ON THE STALENESS WATCHDOG. `release-deploy-staleness-watchdog.ts` does
 * now page properly (WI-6228/EI-16537 gave it notifyAttention + a severe-event broadcast +
 * a `harness_escalations` row) — an earlier version of this item's description, written
 * before that landed, says it only logs, and that is out of date. What remains true is the
 * part that matters: it alarms on the downstream SYMPTOM (the green pin sitting
 * deployable-but-not-live) on a 3h threshold. This condition's signature is visible on the
 * SECOND failed acquire. Alarming on the CAUSE is minutes instead of hours.
 *
 * SHAPE. Mirrors release-deploy-staleness-detect.ts exactly: a pure decider + a thin IO
 * collector, its own structural finding type so this module needs no import from the large
 * watchdog.ts, registered at the one collector site there. WORKSPACE-GLOBAL (there is one
 * release pipeline, one shared release checkout) — deliberately NOT a
 * HARNESS_SCOPED_WATCHDOG_SOURCES entry.
 */
import type { PipelineEventRow } from '../git-sync/pipeline-events';

/** dedup key — ONE stable global finding, so re-fires inside the same stall episode
 *  collapse onto a single open EI instead of spamming one per tick. */
const FINDING_KEY = 'deploy-coalesce-stall';

/**
 * How many consecutive coalesced deploy attempts before this alarms. Default 3 (the item's
 * proposed N: one coalesce is normal single-flighting, two is plausible under a slow
 * deploy, three in a row means nothing is getting through). `<=0` DISABLES the whole
 * sweep (kill switch), matching `deployStalenessThresholdSec`'s convention.
 */
export function deployCoalesceStreakThreshold(): number {
  const n = Number(process.env.PAPERCUSP_DEPLOY_COALESCE_STREAK_THRESHOLD ?? 3);
  return Number.isFinite(n) ? n : 3;
}

/**
 * Deploy statuses that represent a completed ATTEMPT and therefore RESET the streak.
 *
 * The distinction is load-bearing and is the easiest thing to get wrong here. Only these
 * four mean "an attempt reached a verdict". Everything else a deploy can emit
 * (`stale-lock-reclaimed`, `certification-launched`, `certification-failed`) is a
 * BREADCRUMB emitted *alongside* an attempt, not an outcome of one — counting a breadcrumb
 * as a reset would clear a genuine stall the moment any unrelated deploy telemetry landed,
 * which is precisely the silent-failure mode this watchdog exists to remove. Unknown
 * future statuses are ignored (neither reset nor coalesce) for the same reason: a new
 * breadcrumb must not be able to blind the alarm.
 */
const ATTEMPT_OUTCOME_STATUSES = new Set(['ok', 'failed', 'rolled-back', 'refused']);

export interface DeployCoalesceEvent {
  status: string;
  detail?: Record<string, unknown> | null;
  createdAtMs?: number;
}

/**
 * How recent the newest coalesce must be for the condition to count as CURRENT. Default 1h
 * (well past the ≤15-min release-trigger cadence, so an ordinary gap never trips it).
 *
 * Without this bound the decider reads pure history: if deploy attempts simply STOP after a
 * coalesce run — the fleet quiets down, or the stall is cleared by something that emits no
 * deploy event — the last three rows stay coalesces forever and this alarms on them forever,
 * re-firing long after the condition cleared. That is the same false-alarm shape
 * EI-20101010229759029 hit on the sibling staleness watchdog, where a clock that also ran
 * during red-gate windows left the alarm pre-tripped before auto-serve got a single chance.
 * An alarm nobody can clear by fixing the problem is worse than no alarm: it trains readers
 * to ignore the channel.
 */
export function deployCoalesceMaxAgeMs(): number {
  const n = Number(process.env.PAPERCUSP_DEPLOY_COALESCE_MAX_AGE_MS ?? 3_600_000);
  return Number.isFinite(n) && n > 0 ? n : 3_600_000;
}

export interface DeployCoalesceStreakInput {
  /** `deploy`-kind pipeline events, NEWEST FIRST (as `recentPipelineEvents` returns them). */
  events: DeployCoalesceEvent[];
  /** Consecutive coalesces required to escalate; `<=0` disables. */
  threshold: number;
  /** epoch ms "now" — injected so the decider stays deterministic in tests. */
  now?: number;
  /** Newest coalesce must be within this window to count as CURRENT (see above). */
  maxAgeMs?: number;
}

export interface DeployCoalesceStreakVerdict {
  escalate: boolean;
  /** Consecutive coalesced attempts at the head of the timeline. */
  streak: number;
  /** What tripped it — or null when nothing did. */
  trigger: 'dead-holder' | 'streak' | null;
  /** Holder of the most recent coalesce, when known. */
  holder: string | null;
  /** Liveness of that holder: true=live, false=verifiably dead (a BUG), null=unknowable. */
  holderAlive: boolean | null;
  /** Human-readable reason — becomes the finding body / the "why not" for a healthy read. */
  reason: string;
}

function readHolder(detail: Record<string, unknown> | null | undefined): {
  holder: string | null;
  holderAlive: boolean | null;
} {
  const holder = typeof detail?.holder === 'string' ? detail.holder : null;
  const alive = detail?.holderAlive;
  return { holder, holderAlive: alive === true ? true : alive === false ? false : null };
}

/**
 * Pure decider — no DB, no clock. Scans newest-first and counts the run of coalesced
 * attempts at the head of the timeline.
 *
 * TWO independent escalation rules, and the first is not a special case of the second:
 *   · `holderAlive === false` on the most recent coalesce escalates on the FIRST
 *     occurrence. A verifiably-dead holder means the reclaim did not take a lease it
 *     should have — that is a bug in the self-heal path, not a queue behind a real
 *     deploy, and waiting for two more attempts to confirm it just adds latency to a
 *     condition already proven by one observation.
 *   · otherwise, `streak >= threshold` escalates (the slow, ordinary stall).
 */
export function evaluateDeployCoalesceStreak(input: DeployCoalesceStreakInput): DeployCoalesceStreakVerdict {
  const { events, threshold } = input;
  if (threshold <= 0) {
    return {
      escalate: false,
      streak: 0,
      trigger: null,
      holder: null,
      holderAlive: null,
      reason: 'kill switch (PAPERCUSP_DEPLOY_COALESCE_STREAK_THRESHOLD<=0)',
    };
  }

  let streak = 0;
  let head: DeployCoalesceEvent | null = null;
  for (const ev of events) {
    if (ev.status === 'coalesced') {
      if (head === null) head = ev;
      streak += 1;
      continue;
    }
    // A completed attempt ends the run; any other status is a breadcrumb — skip it.
    if (ATTEMPT_OUTCOME_STATUSES.has(ev.status)) break;
  }

  const { holder, holderAlive } = readHolder(head?.detail);
  const holderLabel = holder ?? 'unknown holder';

  // Is the condition CURRENT? A streak read out of pure history keeps alarming after the
  // stall clears (see deployCoalesceMaxAgeMs). Only applied when the row actually carries a
  // timestamp — a caller that supplies none gets the unbounded read it asked for.
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? deployCoalesceMaxAgeMs();
  const headAgeMs = head?.createdAtMs != null ? now - head.createdAtMs : null;
  if (headAgeMs != null && headAgeMs > maxAgeMs) {
    return {
      escalate: false,
      streak,
      trigger: null,
      holder,
      holderAlive,
      reason:
        `${streak} consecutive coalesce(s), but the most recent is ${Math.round(headAgeMs / 60_000)}m old ` +
        `(older than the ${Math.round(maxAgeMs / 60_000)}m currency window) — deploy attempts have stopped ` +
        `rather than piling up, so this is history, not a live stall.`,
    };
  }

  if (streak > 0 && holderAlive === false) {
    return {
      escalate: true,
      streak,
      trigger: 'dead-holder',
      holder,
      holderAlive,
      reason:
        `The most recent deploy attempt coalesced behind a holder whose pid is VERIFIABLY DEAD ` +
        `(${holderLabel}). This is a leaked lease, not a running deploy: the dead-holder reclaim ` +
        `should have taken it automatically and did not, so deploys are blocked behind a ghost. ` +
        `Escalating on the first occurrence — one observation already proves it` +
        (streak > 1 ? ` (${streak} consecutive coalesces so far).` : '.'),
    };
  }

  if (streak >= threshold) {
    const liveness =
      holderAlive === true
        ? `The holder's pid IS running, so the reclaim correctly will not touch it — suspect a WEDGED deploy (hung migration, hung drain, a child blocked on IO) rather than a crashed one.`
        : `The holder's liveness is UNKNOWN (its owner string carries no host-local pid), so the reclaim cannot evaluate it and never will — this lock will not self-heal.`;
    return {
      escalate: true,
      streak,
      trigger: 'streak',
      holder,
      holderAlive,
      reason:
        `${streak} consecutive deploy attempts have coalesced behind ${holderLabel} without a single ` +
        `attempt completing. ${liveness} Delivery is halted: every trigger (auto-serve, manual ` +
        `--execute, release:deploy op:trigger) funnels through this one lock and is standing down.`,
    };
  }

  return {
    escalate: false,
    streak,
    trigger: null,
    holder,
    holderAlive,
    reason:
      streak === 0
        ? 'no coalesced deploy attempts at the head of the timeline'
        : `${streak} consecutive coalesce(s), below the threshold of ${threshold}`,
  };
}

/** Structurally a WatchdogSignal (own type so this pure module needs no import from the
 *  large watchdog.ts) — mapped 1:1 onto one at the collector-registration site. */
export interface DeployCoalesceStallFinding {
  source: 'deploy-coalesce-stall';
  key: typeof FINDING_KEY;
  title: string;
  body: string;
  severity: 'major';
  kind: 'bug';
  scope: 'operator';
  paths: string[];
}

/** Pure: an escalating verdict → a finding, or none. */
export function detectDeployCoalesceStall(verdict: DeployCoalesceStreakVerdict): DeployCoalesceStallFinding[] {
  if (!verdict.escalate) return [];
  // STABLE title — deliberately NO streak count or timestamp in it. WatchdogSignal.title is
  // the search-first dedup key: a title reading "coalesced 3x" stops matching the next tick's
  // "4x" and re-files a fresh EI on every attempt. The counts live in the body.
  const title =
    verdict.trigger === 'dead-holder'
      ? 'Deploys are coalescing behind a VERIFIABLY DEAD lock holder — a leaked lease the reclaim should have taken'
      : 'Deploys are coalescing consecutively — delivery is halted behind a lock holder that is not finishing';
  return [
    {
      source: 'deploy-coalesce-stall' as const,
      key: FINDING_KEY,
      title,
      body:
        `Watchdog signal (deploy-coalesce-stall, EI-18835078701597295): ${verdict.reason}\n\n` +
        `Holder: ${verdict.holder ?? 'unknown'} — liveness ${
          verdict.holderAlive === true ? 'ALIVE' : verdict.holderAlive === false ? 'DEAD' : 'UNKNOWN'
        }. Consecutive coalesced attempts: ${verdict.streak}.\n\n` +
        `This alarms on the CAUSE. The release-deploy-staleness watchdog also covers this ` +
        `territory, but only via the downstream symptom (the green pin sitting ` +
        `deployable-but-not-live) on a 3h threshold — whereas a coalesce run is visible on the ` +
        `second failed acquire.\n\n` +
        `TO DIAGNOSE: \`locks:list\` for the \`release-deploy\` resource to see the holder and its ` +
        `lease expiry, then check whether that pid is alive and actually progressing (a two-sample ` +
        `/proc delta over its process TREE, not a single-shot %cpu, which reads a busy wrapper's ` +
        `idle parent as idle). A holder that is alive but wedged needs killing by task id ` +
        `(\`processes:kill { taskId }\`, never by name); one that is dead means the reclaim path ` +
        `itself is broken and that is the bug to fix.`,
      severity: 'major' as const,
      kind: 'bug' as const,
      scope: 'operator' as const,
      paths: [
        'apps/operator/lib/release/deploy-cli.ts',
        'apps/operator/lib/release/deploy-deps.ts',
        'packages/operator-core/lib/harness/improvements/deploy-coalesce-stall-detect.ts',
      ],
    },
  ];
}

/**
 * The collector that feeds the pure decider. Reads the `deploy` slice of the pipeline
 * history — the durable record the deploy CLI writes on every coalesce — and hands it to
 * `evaluateDeployCoalesceStreak`. WORKSPACE-GLOBAL: no workspaceId, there is one release
 * pipeline. Fail-soft: any error reading history is reported as a note, never thrown (a
 * watchdog collector that crashes its host guards nothing).
 */
export async function collectDeployCoalesceStallSignals(
  opts: { installSlug?: string; limit?: number } = {},
): Promise<{ signals: DeployCoalesceStallFinding[]; note?: string }> {
  const threshold = deployCoalesceStreakThreshold();
  if (threshold <= 0) {
    return { signals: [], note: 'kill switch (PAPERCUSP_DEPLOY_COALESCE_STREAK_THRESHOLD<=0)' };
  }
  try {
    const { recentPipelineEvents } = await import('../git-sync/pipeline-events');
    const { operatorHomeHarnessSlug } = await import('../operator-home-harness');
    const installSlug = opts.installSlug ?? (process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug());
    // Kind-filtered in SQL: the limit has to bound DEPLOY rows, not all pipeline rows, or a
    // burst of git_sync events truncates the window and hides a real streak.
    const rows: PipelineEventRow[] = await recentPipelineEvents(installSlug, opts.limit ?? 25, undefined, {
      kinds: ['deploy'],
    });
    const verdict = evaluateDeployCoalesceStreak({
      events: rows.map((r) => ({ status: r.status, detail: r.detail, createdAtMs: r.createdAtMs })),
      threshold,
    });
    return { signals: detectDeployCoalesceStall(verdict) };
  } catch (e) {
    return {
      signals: [],
      note: `deploy-coalesce-stall collector errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
