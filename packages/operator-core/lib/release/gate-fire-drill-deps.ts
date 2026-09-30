/**
 * IO seams for the gate fire drill (P-016) — the `sync-batch-delta-check-deps.ts` shape.
 * Every decision lives in `./gate-fire-drill.ts`; this module only binds the real world:
 * the detached launcher, systemd, the pipeline-events ledger, the P-003 evaluator, and
 * the severe-event pager. Lazy-imported by the action so a broken leg cannot poison boot.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { getOrgPg } from '@papercusp/db-org';
import { appendPipelineEvent } from '../harness/git-sync/pipeline-events';
import { readVerdictRateWindow, evaluateVerdictRateAlarm } from './gate-verdict-rate-alarm';
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from './green-checkpoint-schedule';
import type { GateFireDrillDeps, DrillOutcome, GateFireDrillState } from './gate-fire-drill';

/** pipeline_events kind for the drill's own outcome rows (the drill's durable trace). */
export const GATE_FIRE_DRILL_KIND = 'gate_fire_drill' as const;

/** Load ceiling: refuse to drill when 1-min loadavg exceeds cores × this factor. */
export const DRILL_LOAD_FACTOR = 1.5;

export interface BuildGateFireDrillDepsOpts {
  installSlug: string;
  workspaceId: string;
  /** Integration tree root (resolved by the action via integrationRoot()). */
  root: string;
}

function unitActive(unit: string): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim();
    return out === 'active' || out === 'activating';
  } catch {
    // is-active exits non-zero for inactive/failed/not-found — all "not active".
    return false;
  }
}

export function buildGateFireDrillDeps(opts: BuildGateFireDrillDepsOpts): GateFireDrillDeps {
  const target = { workspaceId: opts.workspaceId, installSlug: opts.installSlug };
  const sql = () => getOrgPg().sql;

  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    async readGateState(): Promise<GateFireDrillState> {
      const rows = await sql()<{ gh: Record<string, unknown> | null }[]>`
        SELECT metadata->'gate_health' AS gh
          FROM harness_shared.routines
         WHERE name = 'green-checkpoint'
           AND install_slug = ${opts.installSlug}
         LIMIT 1`;
      const gh = (rows[0]?.gh ?? {}) as { consecutiveReds?: number };
      const consecutiveReds = Number(gh.consecutiveReds ?? 0) || 0;

      // Fail CLOSED on the hold reads: `unknown` counts as held — a drill must be
      // provably authorized to spend a launch, the same bar release:checkpoint-run sets.
      const { readQualificationAdmission, readManualRunAdmission } = await import('../release-checkpoint-config');
      const [qual, manual] = await Promise.all([
        readQualificationAdmission({ workspaceId: opts.workspaceId }),
        readManualRunAdmission({ workspaceId: opts.workspaceId }),
      ]);
      const held = qual.status !== 'clear' || manual.status !== 'clear';

      const { checkpointUnitForRoot } = await import('../release-checkpoint-launch');
      const runInFlight = unitActive(checkpointUnitForRoot(opts.root));

      const loadOk = os.loadavg()[0] <= os.cpus().length * DRILL_LOAD_FACTOR;

      return { gateRed: consecutiveReds > 0, consecutiveReds, runInFlight, held, loadOk };
    },

    async launchDrillRun() {
      const { launchDetachedCheckpoint } = await import('../release-checkpoint-launch');
      // Default (recording) target on purpose: a `target: null` run writes no P-001
      // anchor, which would blind the drill's own assertion. No force / replaceStale —
      // the drill must never displace a real run; a refusal is a skip.
      const res = await launchDetachedCheckpoint({ root: opts.root });
      return { launched: res.launched, unit: res.unit, reason: res.reason };
    },

    async waitForRunUp(unit, budgetMs) {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        if (unitActive(unit)) return true;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      return unitActive(unit);
    },

    async killRun(unit) {
      try {
        execFileSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: 60_000 });
      } catch {
        // fall through to the poll — stop can exit non-zero while still taking effect
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (!unitActive(unit)) return true;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      return !unitActive(unit);
    },

    readWindow: (windowMs) => readVerdictRateWindow(sql(), target, { windowMs }),
    evaluate: evaluateVerdictRateAlarm,
    suiteBudgetMs: () => GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,

    async recordOutcome(o: DrillOutcome) {
      await appendPipelineEvent({
        workspaceId: opts.workspaceId,
        installSlug: opts.installSlug,
        kind: GATE_FIRE_DRILL_KIND,
        status: o.status,
        detail: {
          reason: o.reason,
          detail: o.detail,
          counterfactualGateRed: o.counterfactualGateRed,
          ...(o.unit ? { unit: o.unit } : {}),
          ...(o.window ? { window: o.window } : {}),
          ...(o.alarm ? { alarm: o.alarm } : {}),
          startedAtMs: o.startedAtMs,
          finishedAtMs: o.finishedAtMs,
        },
      });
    },

    async alarmDetectorFailure(o: DrillOutcome) {
      const { broadcastSevereEvent } = await import('../severe-event-broadcast');
      await broadcastSevereEvent({
        summary:
          `[${opts.installSlug}] GATE FIRE DRILL FAILED (${o.reason}) — a deliberately killed checkpoint run was ` +
          `NOT fully visible to the P-003 verdict-liveness alarm path on ${opts.installSlug}. This is a detector ` +
          `regression: a real verdict blackout would go unpaged. Repair the detection chain, not any test.`,
        body: `${o.detail}\n\nunit: ${o.unit ?? 'n/a'}\nwindow: ${JSON.stringify(o.window ?? null)}\nalarm: ${JSON.stringify(o.alarm ?? null)}\n(evaluator gateRed input is counterfactual by drill design)`,
        category: 'severe-event',
        // One condition per harness; re-alarms each failing drill (no oneShot): a drill
        // fires at most weekly, so re-alarm spam is bounded by construction and a second
        // failure SHOULD re-page.
        conditionKey: `gate-drill-detector:${opts.installSlug}`,
      });
    },
  };
}
