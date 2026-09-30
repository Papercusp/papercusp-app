/**
 * Graduation tracker tick (self-learning-frontier-2026-06-12 P-046 / FB-19) —
 * the injectable scan `system:graduation-scan` runs: read the evidence rails,
 * compute per-class standings (core.ts), and file ONE owner report per newly
 * eligible (class, tier) through the shared capture core.
 *
 * The report rides the normal rails (D-008): capture → scored digest → P-040
 * ranked queue → Queen triage → owner gate. It files kind=change (judgment-
 * shaped: a policy-widening ask) with paths pointing at policy.ts — which is
 * under the protected-path patterns, so the report is STRUCTURALLY barred
 * from the auto lane it asks to widen. Dedup: watchdogKey
 * `graduation:<class>:n<tier>` under dedupScope 'all' — an owner-rejected
 * tier stays rejected; the next report only files when the streak reaches the
 * NEXT tier (doubled evidence, new key).
 *
 * Idempotent: standings are a full recompute over the rails; filing dedups on
 * the watchdogKey — a replayed tick is a clean no-op.
 */

import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from '../harness/improvements/capture-core';
import {
  buildGraduationReport,
  computeGraduationStandings,
  DEFAULT_GRADUATION_POLICY,
  GRADUATION_REPORT_CLASS,
  type ClassGraduationStanding,
  type GraduationPolicy,
} from './core';
import {
  defaultGraduationEvidenceDeps,
  readGraduationEvidence,
  type GraduationEvidenceDeps,
} from './evidence';
import type { Sql } from 'postgres';

export interface GraduationTickOptions extends GraduationPolicy {
  /** Evidence lookback for the regression rails (days). */
  lookbackDays: number;
  /** Cap on owner reports filed per tick (the digest is a human surface). */
  maxReportsPerTick: number;
  /** Compute + log standings, file nothing (the supervised dry mode). */
  mineOnly: boolean;
}

export const DEFAULT_GRADUATION_TICK_OPTIONS: GraduationTickOptions = {
  ...DEFAULT_GRADUATION_POLICY,
  lookbackDays: 90,
  maxReportsPerTick: 3,
  mineOnly: false,
};

/** Tune from the routine's payload_template — every knob owner-overridable. */
export function graduationOptionsFromPayload(payload: unknown): GraduationTickOptions {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const num = (k: string, fallback: number): number =>
    typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : fallback;
  const d = DEFAULT_GRADUATION_TICK_OPTIONS;
  return {
    threshold: Math.max(1, num('threshold', d.threshold)),
    recurrenceWindowDays: Math.max(1, num('recurrenceWindowDays', d.recurrenceWindowDays)),
    neverGraduateClassPatterns: Array.isArray(p.neverGraduateClassPatterns)
      ? (p.neverGraduateClassPatterns as unknown[]).filter((x): x is string => typeof x === 'string')
      : d.neverGraduateClassPatterns,
    lookbackDays: Math.max(1, num('lookbackDays', d.lookbackDays)),
    maxReportsPerTick: Math.max(0, num('maxReportsPerTick', d.maxReportsPerTick)),
    mineOnly: p.mineOnly === true,
  };
}

export interface GraduationTickDeps {
  evidence: GraduationEvidenceDeps;
  fileReport: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  nowMs: () => number;
}

export function defaultGraduationTickDeps(sql: Sql, workspaceId: string): GraduationTickDeps {
  return {
    evidence: defaultGraduationEvidenceDeps(sql, workspaceId),
    fileReport: (input) => captureImprovement(input),
    nowMs: () => Date.now(),
  };
}

export interface GraduationTickResult {
  classes: number;
  eligible: string[];
  filed: string[];
  declined: number;
  legs: { gym: boolean; ekg: boolean };
  standings: ClassGraduationStanding[];
}

export async function runGraduationTick(
  deps: GraduationTickDeps,
  opts: GraduationTickOptions = DEFAULT_GRADUATION_TICK_OPTIONS,
): Promise<GraduationTickResult> {
  const nowMs = deps.nowMs();
  const read = await readGraduationEvidence(deps.evidence, { lookbackDays: opts.lookbackDays, nowMs });
  const standings = computeGraduationStandings(read.items, read.regressions, opts, nowMs);
  const eligible = standings.filter((s) => s.eligible);

  const filed: string[] = [];
  let declined = 0;
  if (!opts.mineOnly) {
    for (const standing of eligible.slice(0, opts.maxReportsPerTick)) {
      const report = buildGraduationReport(standing, opts);
      const legsLine =
        `\n\nRegression-rail coverage this scan: gym ${read.legs.gym ? 'LIVE' : 'inactive'} · ` +
        `EKG ${read.legs.ekg ? 'LIVE' : 'inactive'} (an inactive rail contributed no events — read the evidence accordingly).`;
      const res = await deps.fileReport({
        title: report.title,
        kind: 'change',
        body: report.body + legsLine,
        severity: 'major',
        subTopic: 'self-learning',
        scope: 'operator',
        watchdogKey: report.watchdogKey,
        dedupScope: 'all',
        sourceRole: 'system',
        origin: 'organic',
        findingClass: GRADUATION_REPORT_CLASS,
        createdBy: 'graduation-tracker',
        // The would-be implementation path — under the protected-path patterns,
        // so the policy tier forces this ask to the HUMAN lane structurally.
        paths: ['packages/operator-core/lib/harness/improvements/policy.ts'],
      });
      if (res.created && res.issue) filed.push(res.issue.id);
      else declined += 1;
    }
  }

  return {
    classes: standings.length,
    eligible: eligible.map((s) => s.findingClass),
    filed,
    declined,
    legs: read.legs,
    standings,
  };
}
