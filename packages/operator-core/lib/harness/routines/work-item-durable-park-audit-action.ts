/** On-demand deterministic report-only action for Phase 7 durable-park audits. */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { notifySyncInvalidate } from '../../sync-sse';
import {
  DEFAULT_AGENT_REVIEW_OVERDUE_HOURS,
  runWorkItemDurableParkAudit,
  runWorkItemDurableParkReconciliation,
  WORK_ITEM_DURABLE_PARK_AUDIT,
  type DurableParkAuditReport,
  type DurableParkReconcileDecision,
  type DurableParkReconcileResult,
} from '../../work-items-durable-park-audit';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface DurableParkAuditActionDeps {
  run: (ctx: SystemActionCtx) => Promise<DurableParkAuditReport | DurableParkReconcileResult>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function artifactPath(payload: Record<string, unknown>, runId: string, suffix: string): string {
  const explicit = typeof payload.artifactPath === 'string' ? payload.artifactPath.trim() : '';
  if (explicit) return explicit;
  const safe = runId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  return `reports/durable-parks/${safe}-${suffix}.json`;
}

/**
 * Which branch a routine payload selects.
 *
 * Exported so the REPORT-ONLY property of the P-022 daily backstop is testable
 * without a live database: `audit` is the default and the only branch the
 * scheduled row may ever take (D-018/D-022/D-023 — a durable park is never
 * cleared by age, parker death, or model judgment). `reconcile` mutates, and is
 * reachable only from an explicit on-demand invocation that names it.
 *
 * Anything other than the exact string `'reconcile'` — absent, empty, misspelled,
 * a truthy object — falls back to the reporting branch, so a malformed payload
 * degrades to reading rather than to clearing parks.
 */
export function selectDurableParkAuditMode(payload: Record<string, unknown>): 'audit' | 'reconcile' {
  return payload.mode === 'reconcile' ? 'reconcile' : 'audit';
}

async function productionRun(ctx: SystemActionCtx): Promise<DurableParkAuditReport | DurableParkReconcileResult> {
  if (process.env.VITEST) throw new Error('production durable-park audit must not run from a unit test');
  const payload = ctx.payloadTemplate ?? {};
  const explicit = typeof payload.runId === 'string' ? payload.runId.trim() : '';
  const runId = explicit || DBOS.workflowID?.trim() || `${WORK_ITEM_DURABLE_PARK_AUDIT}:${randomUUID()}`;
  if (selectDurableParkAuditMode(payload) === 'reconcile') {
    const decisions = Array.isArray(payload.decisions) ? (payload.decisions as DurableParkReconcileDecision[]) : [];
    return runWorkItemDurableParkReconciliation({
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.installSlug,
      runId,
      actor: typeof payload.actor === 'string' ? payload.actor : '',
      decisions,
      artifactPath: artifactPath(payload, runId, 'reconcile'),
    });
  }
  return runWorkItemDurableParkAudit({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId,
    reviewOverdueHours: positiveInteger(payload.reviewOverdueHours, DEFAULT_AGENT_REVIEW_OVERDUE_HOURS),
    artifactPath: artifactPath(payload, runId, 'evidence-matrix'),
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemDurableParkAuditAction(overrides: Partial<DurableParkAuditActionDeps> = {}) {
  const deps: DurableParkAuditActionDeps = {
    run: productionRun,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_DURABLE_PARK_AUDIT}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    if (result.schemaVersion === 'durable-park-reconcile-v1') {
      deps.log(
        `${ctx.installSlug}: run=${result.runId} requested=${result.requested} ` +
          `cleared=${result.cleared} unchanged=${result.unchanged} artifact=${result.artifactPath}`,
      );
    } else {
      deps.log(
        `${ctx.installSlug}: run=${result.runId} parks=${result.population.axes.durableParks} ` +
          `missing=${result.unparkConditions.missing} unresolved=${result.unparkConditions.unresolved} ` +
          `livenessFlagged=${result.releaseConditionHealth.flagged} ` +
          `unreachable=${result.releaseConditionHealth.statusCounts.unreachable} ` +
          `satisfiedStillParked=${result.releaseConditionHealth.statusCounts['satisfied-still-parked']} ` +
          `overdueReviews=${result.overdueReviews.rows.length} reportOnly=true`,
      );
    }
  };
}

// P-022: this action now has a STANDING daily report-only row
// (`seed-work-item-durable-park-audit-routine.ts`, registered in
// BESPOKE_ACTIVE_SEEDS), so a missing row must be LOUD again. It was declared
// `on-demand` while the only invocations were per-call reconcile runs; leaving it
// that way after wiring the daily backstop would exempt the very routine whose
// absence is the failure this phase exists to close — the audit sat un-seeded and
// never once ticked precisely because nothing was checking for its row.
// On-demand reconcile invocations are unaffected: `scheduling` governs only the
// code↔data row cross-check, never dispatch.
registerSystemAction(WORK_ITEM_DURABLE_PARK_AUDIT, makeWorkItemDurableParkAuditAction(), {
  scheduling: 'standing',
});
