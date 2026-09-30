/**
 * Gather the scheduled-plan occurrences in a date window — the data source for
 * the Calendar tab (P-018/P-019) and the Queen eligible-routines pane (P-026).
 *
 * Plan: scheduled-recurring-plans-2026-06-16. The calendar is driven from these
 * backend-computed occurrences (one source of truth via the `rrule` lib; the
 * calendar UI lib stays swappable — D-004 / P-018). A template's recurrence is
 * expanded with `expandOccurrences`; a one-shot `scheduled_at` is added directly;
 * `expires_at` bounds the window. Instance plans (template_slug NOT NULL) are
 * excluded — only templates carry a schedule.
 */
import type { Sql } from 'postgres';
import { expandOccurrences, type ScheduleTrigger } from './schedule-next';

export interface ScheduledOccurrence {
  /** The template plan slug (stable identity; the calendar event's plan). */
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  /** The fire instant (epoch ms). */
  occurrenceMs: number;
  /** A recurring fire vs a one-shot `scheduled_at`. */
  kind: 'recurring' | 'one-shot';
  /** Whether the schedule is armed (firing) — disarmed schedules still render, dimmed. */
  scheduleActive: boolean;
  /** The most recent scheduled run's outcome, for at-a-glance health on the event. */
  lastOutcome: string | null;
}

interface PlanScheduleRow {
  plan_slug: string;
  harness_slug: string;
  title: string | null;
  schedule: ScheduleTrigger | null; // jsonb — round-trips as an object
  schedule_active: boolean | null;
  scheduled_at: Date | null;
  expires_at: Date | null;
}

/**
 * One row per scheduled plan (the raw authored schedule), regardless of any date
 * window — the source the calendar editor pre-fills from and the per-occurrence
 * EXDATE/RDATE drag reads (scheduled-recurring-plans-2026-06-16 P-020 / D-020).
 * Reuses the same harness_plans filter as the occurrence expansion, plus `tzid`.
 */
export interface PlanScheduleSummary {
  templateSlug: string;
  harnessSlug: string;
  title: string | null;
  /** The raw authored recurrence set (RRULE/cron/rdate/exdate + policy), or null for a pure one-shot. */
  schedule: ScheduleTrigger | null;
  /** One-shot fire time (ISO), or null. */
  scheduledAt: string | null;
  /** Recurrence end/deadline (ISO), or null. */
  expiresAt: string | null;
  tzid: string | null;
  scheduleActive: boolean;
}

export async function listPlanSchedules(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug?: string },
): Promise<PlanScheduleSummary[]> {
  const { workspaceId, harnessSlug } = opts;
  const rows = await sql<Array<PlanScheduleRow & { tzid: string | null }>>`
    SELECT plan_slug, harness_slug, title, schedule, schedule_active, scheduled_at, expires_at, tzid
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND template_slug IS NULL
       AND (schedule IS NOT NULL OR scheduled_at IS NOT NULL)
       ${harnessSlug ? sql`AND harness_slug = ${harnessSlug}` : sql``}
  `;
  return rows.map((r) => ({
    templateSlug: r.plan_slug,
    harnessSlug: r.harness_slug,
    title: r.title,
    schedule: r.schedule ?? null,
    scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    tzid: r.tzid ?? null,
    scheduleActive: r.schedule_active ?? false,
  }));
}

/**
 * All scheduled-plan occurrences within [rangeStartMs, rangeEndMs] across the
 * workspace (optionally one harness). `sql` is the explicit seam (admin pool in
 * prod, the testcontainers client in tests). Sorted by fire time. `limitPerPlan`
 * bounds a pathological sub-minute cadence over a wide window.
 */
export async function gatherScheduledOccurrences(
  sql: Sql,
  opts: {
    workspaceId: string;
    harnessSlug?: string;
    rangeStartMs: number;
    rangeEndMs: number;
    limitPerPlan?: number;
  },
): Promise<ScheduledOccurrence[]> {
  const { workspaceId, harnessSlug, rangeStartMs, rangeEndMs, limitPerPlan = 500 } = opts;
  if (rangeEndMs < rangeStartMs) return [];
  const rangeStart = new Date(rangeStartMs);
  const rangeEnd = new Date(rangeEndMs);

  const rows = await sql<PlanScheduleRow[]>`
    SELECT plan_slug, harness_slug, title, schedule, schedule_active, scheduled_at, expires_at
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND template_slug IS NULL
       AND (schedule IS NOT NULL OR scheduled_at IS NOT NULL)
       ${harnessSlug ? sql`AND harness_slug = ${harnessSlug}` : sql``}
  `;
  if (rows.length === 0) return [];

  // Last settled outcome per template — DISTINCT ON the most recent run.
  const slugs = rows.map((r) => r.plan_slug);
  const lastOutcomes = await sql<Array<{ plan_slug: string; outcome: string | null }>>`
    SELECT DISTINCT ON (plan_slug) plan_slug, outcome
      FROM harness_shared.plan_runs
     WHERE plan_slug = ANY(${slugs}) AND run_type = 'scheduled'
     ORDER BY plan_slug, launched_at DESC
  `;
  const outcomeBySlug = new Map(lastOutcomes.map((o) => [o.plan_slug, o.outcome]));

  const out: ScheduledOccurrence[] = [];
  for (const r of rows) {
    const scheduleActive = r.schedule_active ?? false;
    const lastOutcome = outcomeBySlug.get(r.plan_slug) ?? null;
    // expiry clamps the window end (the schedule deactivates on expiry — D-004)
    const effEnd = r.expires_at && r.expires_at.getTime() < rangeEndMs ? r.expires_at : rangeEnd;

    if (r.schedule) {
      for (const d of expandOccurrences(r.schedule, rangeStart, effEnd, limitPerPlan)) {
        out.push({
          templateSlug: r.plan_slug,
          title: r.title,
          harnessSlug: r.harness_slug,
          occurrenceMs: d.getTime(),
          kind: 'recurring',
          scheduleActive,
          lastOutcome,
        });
      }
    }
    if (r.scheduled_at) {
      const t = r.scheduled_at.getTime();
      if (t >= rangeStartMs && t <= effEnd.getTime()) {
        out.push({
          templateSlug: r.plan_slug,
          title: r.title,
          harnessSlug: r.harness_slug,
          occurrenceMs: t,
          kind: 'one-shot',
          scheduleActive,
          lastOutcome,
        });
      }
    }
  }
  out.sort((a, b) => a.occurrenceMs - b.occurrenceMs);
  return out;
}
