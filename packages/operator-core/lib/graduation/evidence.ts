/**
 * Graduation evidence — PG glue (self-learning-frontier-2026-06-12 P-046 /
 * FB-19). Assembles the pure core's inputs from the rails that already hold
 * the facts; this module adds NO semantics of its own:
 *
 *   - resolved improvements + their idea lifecycle → engineer_issues
 *     (listIssues, organic-only — drill/replay/shadow rows never feed
 *     graduation evidence, D-002);
 *   - "the auto lane actually did it" → harness_shared.improvement_dispatches
 *     (outcome 'fixed');
 *   - fleet regression events → gym_champion_outcomes (verdict 'regressed')
 *     and fleet_ekg_shifts (severity 'major'). Both rails are DARK until
 *     P-001 arms them; each leg is best-effort (a missing table / read error
 *     reports the leg inactive rather than failing the scan) so the tracker
 *     is dormant-tolerant from day one.
 *
 * Resolution-time estimate: lifecycle.stateUpdatedAt IS the 'applied' flip for
 * applied/recurred rows; for already-verified rows the sweep moved it, so we
 * back-derive applied ≈ stateUpdatedAt − decayDays (the sweep records decay
 * days at flip time). Good to the sweep's cadence, which is all the window
 * math needs.
 */

import type { Sql } from 'postgres';
import { listIssues, type EngineerIssue } from '../issues-engineer';
import type { IdeaLifecyclePayload } from '../harness/improvements/lifecycle';
import { findingClassOf, type GraduationEvidenceItem, type RegressionEvent } from './core';

const DAY_MS = 86_400_000;

export interface GraduationEvidenceDeps {
  /** Resolved/closed organic improvement rows (bug|change). */
  listResolvedImprovements: () => Promise<EngineerIssue[]>;
  /** item_ids the auto lane dispatched AND resolved (dispatch outcome 'fixed'). */
  listAutoResolvedItemIds: () => Promise<Set<string>>;
  /** Gym champion regressions since `sinceMs` — [] when the rail is dark. */
  listGymRegressions: (sinceMs: number) => Promise<RegressionEvent[]>;
  /** Major EKG shifts since `sinceMs` — [] when the rail is dark. */
  listEkgRegressions: (sinceMs: number) => Promise<RegressionEvent[]>;
}

function lifecycleOf(issue: EngineerIssue): IdeaLifecyclePayload | null {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const l = p.ideaLifecycle;
  return l && typeof l === 'object' && typeof (l as { state?: unknown }).state === 'string'
    ? (l as IdeaLifecyclePayload)
    : null;
}

function payloadStr(issue: EngineerIssue, key: string): string | undefined {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  return typeof p[key] === 'string' && p[key] ? (p[key] as string) : undefined;
}

/**
 * Map issue rows to evidence items. Rows without an idea lifecycle (pre-P-031
 * legacy, or closed without the resolve back-edge) are not countable evidence
 * and are skipped — graduation counts only what the rails verified.
 */
export function evidenceItemsFromIssues(
  issues: readonly EngineerIssue[],
  autoResolvedIds: ReadonlySet<string>,
): GraduationEvidenceItem[] {
  const out: GraduationEvidenceItem[] = [];
  for (const issue of issues) {
    const lifecycle = lifecycleOf(issue);
    if (!lifecycle) continue;
    const state = lifecycle.state;
    if (state !== 'applied' && state !== 'verified' && state !== 'recurred') continue;
    const stateAtMs = Date.parse(lifecycle.stateUpdatedAt);
    if (!Number.isFinite(stateAtMs)) continue;
    const resolvedAtMs =
      state === 'verified' && typeof lifecycle.decayDays === 'number'
        ? stateAtMs - lifecycle.decayDays * DAY_MS
        : stateAtMs;
    out.push({
      id: issue.id,
      findingClass: findingClassOf({
        findingClass: payloadStr(issue, 'findingClass'),
        watchdogKey: payloadStr(issue, 'watchdogKey'),
        ideaType: lifecycle.ideaType,
        kind: issue.kind,
      }),
      resolvedAtMs,
      lifecycle: state,
      autoDispatched: autoResolvedIds.has(issue.id),
      // The lifecycle only reaches 'applied' through resolve-core's 'fixed'
      // path, where testsRun is enforced — having a lifecycle IS the evidence.
      hasEvidence: true,
    });
  }
  return out;
}

export interface GraduationEvidenceRead {
  items: GraduationEvidenceItem[];
  regressions: RegressionEvent[];
  /** Which regression rails actually answered — the report's honesty line. */
  legs: { gym: boolean; ekg: boolean };
}

/** Gather everything the core needs; regression legs are independently best-effort. */
export async function readGraduationEvidence(
  deps: GraduationEvidenceDeps,
  opts: { lookbackDays: number; nowMs: number },
): Promise<GraduationEvidenceRead> {
  const sinceMs = opts.nowMs - opts.lookbackDays * DAY_MS;
  const [issues, autoIds] = await Promise.all([deps.listResolvedImprovements(), deps.listAutoResolvedItemIds()]);
  const legs = { gym: true, ekg: true };
  let gym: RegressionEvent[] = [];
  let ekg: RegressionEvent[] = [];
  try {
    gym = await deps.listGymRegressions(sinceMs);
  } catch {
    legs.gym = false;
  }
  try {
    ekg = await deps.listEkgRegressions(sinceMs);
  } catch {
    legs.ekg = false;
  }
  return {
    items: evidenceItemsFromIssues(issues, autoIds),
    regressions: [...gym, ...ekg].sort((a, b) => a.atMs - b.atMs),
    legs,
  };
}

/** Live PG-backed deps. */
export function defaultGraduationEvidenceDeps(sql: Sql, workspaceId: string): GraduationEvidenceDeps {
  return {
    async listResolvedImprovements() {
      const [resolved, closed] = await Promise.all([
        listIssues({ state: 'resolved', kinds: ['bug', 'change'], signalOrigins: ['organic'], limit: 1000 }),
        listIssues({ state: 'closed', kinds: ['bug', 'change'], signalOrigins: ['organic'], limit: 1000 }),
      ]);
      return [...resolved, ...closed];
    },
    async listAutoResolvedItemIds() {
      const rows = await sql<{ item_id: string }[]>`
        SELECT DISTINCT item_id
          FROM harness_shared.improvement_dispatches
         WHERE workspace_id = ${workspaceId} AND outcome = 'fixed'
      `;
      return new Set(rows.map((r) => r.item_id));
    },
    async listGymRegressions(sinceMs) {
      const rows = await sql<{ evaluated_at: Date | string | null; accepted_at: Date | string; role: string; harness_slug: string }[]>`
        SELECT evaluated_at, accepted_at, role, harness_slug
          FROM harness_shared.gym_champion_outcomes
         WHERE workspace_id = ${workspaceId} AND verdict = 'regressed'
           AND accepted_at >= ${new Date(sinceMs)}
      `;
      return rows.map((r) => ({
        atMs: new Date(r.evaluated_at ?? r.accepted_at).getTime(),
        source: 'gym' as const,
        label: `gym champion regressed (${r.harness_slug}/${r.role})`,
      }));
    },
    async listEkgRegressions(sinceMs) {
      const rows = await sql<{ window_date: Date | string; feature: string }[]>`
        SELECT window_date, feature
          FROM harness_shared.fleet_ekg_shifts
         WHERE workspace_id = ${workspaceId} AND severity = 'major'
           AND window_date >= ${new Date(sinceMs)}::date
      `;
      return rows.map((r) => ({
        atMs: new Date(r.window_date).getTime(),
        source: 'ekg' as const,
        label: `major fleet-EKG shift (${r.feature})`,
      }));
    },
  };
}
