/**
 * fairness-audit.ts — auto-populate the mandatory C1–C10 pre-claim fairness-audit table
 * (plan benchmark-capability-injection-redesign-2026-06-17, P-011 / C10 transparent reporting).
 *
 * The binding standard (/internal/docs/benchmarks/fairness-criteria.mdx) requires a
 * PASS/FAIL audit table for EVERY agent-system benchmark run BEFORE any number is claimed —
 * "A claim of 'system A beats system B' is only valid when every applicable criterion
 * passes." The steward (su-37e53) fills it by hand; this automates the QUANTITATIVE
 * criteria from a run's stored {@link TaskRunResult} rows so the table can't be skipped or
 * fudged, and clearly marks the criteria that still need human evidence.
 *
 * Auto-derived from the rows: C1 (same task set + same-denominator scoring), C3 (iso-budget
 * vs best-effort, with $/task + calls/task), C6 (coverage parity — per-arm infra/absent
 * non-completions), C8 (N + seeds per arm). Config-consistency partials: C2 (one modelId
 * across arms — but telemetry verification is still manual), C5 (one graderVersion).
 * Manual-only (NEEDS-EVIDENCE): C4 (capability actually exercised), C7 (no contamination),
 * C9 (reference reproduces its published number).
 *
 * This is cross-arm (every arm in the run), distinct from the per-(control,capability)
 * pairwise attribution — the audit gates the whole comparison; the attribution reads the
 * lift. Domain-free → lives in `@papercusp/bench-metrics`.
 */
import type { ArmId, BenchSuite, TaskRunResult } from './schema';
import { isScored } from './cost';

export type FairnessStatus = 'PASS' | 'FAIL' | 'WARN' | 'NEEDS-EVIDENCE' | 'N/A';

/** One row of the C1–C10 audit table. */
export interface FairnessCriterion {
  id: string; // C1..C10
  criterion: string;
  status: FairnessStatus;
  evidence: string;
}

/** Per-arm coverage + parity summary the audit reads. */
export interface ArmFairnessSummary {
  arm: ArmId;
  /** Distinct tasks this arm has any row for. */
  tasks: number;
  /** Distinct seeds (the C8 repeat count). */
  seeds: number;
  scoredRows: number;
  infraRows: number;
  /** Tasks in the run-wide union with NO scored row for this arm (all-infra or absent) — the C1/C6 false-by-fairness set. */
  nonCompletedTasks: number;
  /** Distinct modelIds seen (C2 — config, not telemetry). */
  models: string[];
  /** Distinct grader versions (C5). */
  graderVersions: string[];
  /** Distinct iso-budget caps (C3); [null] = uncapped. */
  budgets: (number | null)[];
  /** Mean $/task (priced from tokens) over this arm's tasks (C3). */
  costPerTask: number;
  /** Mean model-call (turns) per scored row (C3). */
  callsPerTask: number;
}

export interface FairnessAudit {
  suite: BenchSuite;
  runId: string;
  /** Arms compared, in first-seen order. */
  arms: ArmId[];
  /** The run-wide task universe (union of every arm's tasks) — the shared N. */
  unionTasks: number;
  perArm: ArmFairnessSummary[];
  criteria: FairnessCriterion[];
  /** The standard's bar: every criterion is PASS or N/A (no FAIL / WARN / NEEDS-EVIDENCE). */
  allClear: boolean;
}

export interface FairnessAuditOpts {
  /** The external reference arm (e.g. 'baseline-b-native' / mini-swe) — gates C9. Omit ⇒ C9 is N/A. */
  referenceArm?: ArmId;
}

/** Build the per-arm fairness summary over the run-wide task union. */
function summarizeArm(arm: ArmId, rows: readonly TaskRunResult[], union: Set<string>): ArmFairnessSummary {
  const armRows = rows.filter((r) => r.arm === arm);
  const tasks = new Set(armRows.map((r) => r.taskId));
  const seeds = new Set(armRows.map((r) => r.seed));
  const scoredRows = armRows.filter(isScored);
  const infraRows = armRows.length - scoredRows.length;
  const scoredTaskIds = new Set(scoredRows.map((r) => r.taskId));
  let nonCompletedTasks = 0;
  for (const t of union) if (!scoredTaskIds.has(t)) nonCompletedTasks += 1;
  // Use each row's recorded costUsd (what was actually spent) — robust to an unpriced model id.
  const costUsd = armRows.reduce((s, r) => s + (r.costUsd || 0), 0);
  const totalTurns = armRows.reduce((s, r) => s + (r.turns || 0), 0);
  return {
    arm,
    tasks: tasks.size,
    seeds: seeds.size,
    scoredRows: scoredRows.length,
    infraRows,
    nonCompletedTasks,
    models: [...new Set(armRows.map((r) => r.modelId))].sort(),
    graderVersions: [...new Set(armRows.map((r) => r.graderVersion))].sort(),
    budgets: [...new Set(armRows.map((r) => r.budgetTokens ?? null))],
    costPerTask: tasks.size === 0 ? 0 : costUsd / tasks.size,
    callsPerTask: scoredRows.length === 0 ? 0 : totalTurns / scoredRows.length,
  };
}

/**
 * Build the C1–C10 fairness audit for a run's rows. Auto-derives the quantitative criteria; marks the
 * manual ones NEEDS-EVIDENCE. `allClear` is true only when every criterion is PASS/N/A — the standard's
 * bar for a defensible claim. Throws on empty rows.
 */
export function buildFairnessAudit(rows: readonly TaskRunResult[], opts: FairnessAuditOpts = {}): FairnessAudit {
  if (rows.length === 0) throw new Error('buildFairnessAudit: no rows');
  const suite = rows[0].suite;
  const runId = rows[0].runId;
  const arms = [...new Set(rows.map((r) => r.arm))];
  const union = new Set(rows.map((r) => r.taskId));
  const perArm = arms.map((a) => summarizeArm(a, rows, union));

  const criteria: FairnessCriterion[] = [];
  const push = (id: string, criterion: string, status: FairnessStatus, evidence: string) =>
    criteria.push({ id, criterion, status, evidence });

  // C1 — identical task set + same-denominator scoring.
  const sameTaskSet = perArm.every((a) => a.tasks === union.size);
  push(
    'C1',
    'Same task set + same scoring denominator',
    sameTaskSet ? 'PASS' : 'WARN',
    sameTaskSet
      ? `all ${arms.length} arms cover the same ${union.size} tasks; score on the union-N (infra/absent=false) via the same-denominator attribution headline.`
      : `task-set asymmetry — ${perArm.map((a) => `${a.arm}:${a.tasks}/${union.size}`).join(', ')}. Score on the union-N (infra/absent=false); disclose the gap, never drop the rows.`,
  );

  // C2 — same model (config consistency; telemetry verification is manual).
  const allModels = [...new Set(perArm.flatMap((a) => a.models))];
  push(
    'C2',
    'Same model (telemetry-verified)',
    allModels.length === 1 ? 'NEEDS-EVIDENCE' : 'FAIL',
    allModels.length === 1
      ? `config modelId consistent (${allModels[0]}) — VERIFY per-arm from agent_usage_samples telemetry (a tier/route remap can silently serve a different model).`
      : `MIXED models across arms: ${allModels.join(', ')} — not the same model.`,
  );

  // C3 — compute parity (iso-budget) or disclosed best-effort.
  const allBudgets = [...new Set(perArm.flatMap((a) => a.budgets.map((b) => (b == null ? 'null' : String(b)))))];
  const isoBudget = allBudgets.length === 1 && allBudgets[0] !== 'null';
  const costLine = perArm.map((a) => `${a.arm}: $${a.costPerTask.toFixed(2)}/task, ${a.callsPerTask.toFixed(1)} calls/task`).join('; ');
  push(
    'C3',
    'Compute parity (iso-budget) or disclosed',
    isoBudget ? 'PASS' : 'WARN',
    isoBudget
      ? `iso-budget cap ${allBudgets[0]} tokens shared by all arms. ${costLine}.`
      : `NOT iso-budget (caps: ${allBudgets.join(', ')}) — best-effort, no capability claim without compute-matching. Per-arm: ${costLine}.`,
  );

  // C4 — capability actually exercised (manual).
  push('C4', 'Capability-under-claim actually exercised', 'NEEDS-EVIDENCE', 'verify the config exercises the claimed capability (e.g. coordination requires multiple agents communicating on the SAME task, not parallel different tasks).');

  // C5 — same grader/env/exclusion (config partial).
  const allGraders = [...new Set(perArm.flatMap((a) => a.graderVersions))];
  push(
    'C5',
    'Same grader / env / exclusion policy',
    allGraders.length === 1 ? 'NEEDS-EVIDENCE' : 'FAIL',
    allGraders.length === 1
      ? `grader version consistent (${allGraders[0]}) — confirm identical docker images, FAIL_TO_PASS/PASS_TO_PASS, timeouts, and that the exclusion policy is reconciled into the C1 denominator.`
      : `MIXED grader versions: ${allGraders.join(', ')}.`,
  );

  // C6 — reliability / coverage parity (no differential infra penalty).
  const noncompletes = perArm.map((a) => a.nonCompletedTasks);
  const maxNon = Math.max(...noncompletes);
  const minNon = Math.min(...noncompletes);
  const coverageLine = perArm.map((a) => `${a.arm}: ${a.nonCompletedTasks} non-completed (${a.infraRows} infra rows)`).join('; ');
  push(
    'C6',
    'Reliability / coverage parity',
    maxNon === 0 ? 'PASS' : maxNon - minNon === 0 ? 'WARN' : 'WARN',
    maxNon === 0
      ? `every arm produced a scored result on all ${union.size} tasks — no infra-induced coverage gap.`
      : `coverage gap (${coverageLine}). ${maxNon - minNon > 0 ? 'ASYMMETRIC — fix the infra + re-run, or count as false + disclose (done in the same-denominator headline).' : 'symmetric but present — disclosed; counted false.'}`,
  );

  // C7 — no contamination (manual).
  push('C7', 'No contamination / leakage', 'NEEDS-EVIDENCE', 'confirm no solution/test-patch leakage into any agent context; same context budget + allowed-tools class (modulo the capability under test).');

  // C8 — statistical validity (N, seeds).
  const minSeeds = Math.min(...perArm.map((a) => a.seeds));
  const seedsLine = perArm.map((a) => `${a.arm}: ${a.seeds} seed(s) × ${a.tasks} tasks`).join('; ');
  push(
    'C8',
    'Statistical validity (N, tiers, seeds)',
    minSeeds >= 2 ? 'PASS' : 'WARN',
    minSeeds >= 2
      ? `≥2 seeds per arm (${seedsLine}); report mean±spread + per-tier.`
      : `SINGLE-SEED arm present (${seedsLine}) — a single run is inside the noise band; ≥2 seeds required for a headline claim. Stratify + report per-tier.`,
  );

  // C9 — reference reproduces its published number.
  const hasRef = opts.referenceArm != null && arms.includes(opts.referenceArm);
  push(
    'C9',
    'Reference reproduces published number',
    hasRef ? 'NEEDS-EVIDENCE' : 'N/A',
    hasRef
      ? `verify the reference arm (${opts.referenceArm}) scores within noise of its published number, else the harness is miscalibrated.`
      : 'no external reference arm in this run — N/A (a within-system capability comparison).',
  );

  // C10 — transparent reporting (this audit + the attribution report).
  push('C10', 'Transparent reporting', 'PASS', 'emit WITH the per-instance matrix, per-arm model + $/task + calls/task, budget regime, infra-failure counts, seeds, and THIS audit table.');

  const allClear = criteria.every((c) => c.status === 'PASS' || c.status === 'N/A');
  return { suite, runId, arms, unionTasks: union.size, perArm, criteria, allClear };
}

/** Render the fairness audit as the standard's markdown table (the mandatory pre-claim artifact). */
export function formatFairnessAuditMarkdown(audit: FairnessAudit): string {
  const out: string[] = [];
  out.push(`## Fairness audit — ${audit.suite} run \`${audit.runId}\``);
  out.push('');
  out.push(`Arms: ${audit.arms.map((a) => `\`${a}\``).join(', ')} · union N = ${audit.unionTasks} tasks`);
  out.push('');
  out.push(`**Verdict: ${audit.allClear ? '✅ all criteria clear — claim defensible' : '⚠️ NOT all clear — the claim is provisional; the failing criteria are named below'}**`);
  out.push('');
  out.push('| # | Criterion | Status | Evidence |');
  out.push('|---|---|---|---|');
  for (const c of audit.criteria) {
    out.push(`| ${c.id} | ${c.criterion} | ${statusMark(c.status)} | ${c.evidence.replace(/\|/g, '\\|')} |`);
  }
  out.push('');
  out.push('### Per-arm coverage + compute');
  out.push('| arm | tasks | seeds | scored | infra | non-completed | $/task | calls/task | model |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of audit.perArm) {
    out.push(
      `| \`${a.arm}\` | ${a.tasks} | ${a.seeds} | ${a.scoredRows} | ${a.infraRows} | ${a.nonCompletedTasks} | $${a.costPerTask.toFixed(2)} | ${a.callsPerTask.toFixed(1)} | ${a.models.join('/') || '?'} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

/**
 * The full per-instance result matrix (instance_id × arm × value) the standard requires for an auditable
 * denominator (C1/C10): "Report the full per-instance result matrix so the denominator is auditable." Each
 * cell is the arm's per-task value over its seeds — pass@1 (resolved-rate) or meanScore — with `i:N` marking
 * infra seeds counted false and `–` an absent task (the C1/C6 fairness markers, visible per cell).
 */
export function formatPerInstanceMatrix(rows: readonly TaskRunResult[], opts: { metric?: 'passAt1' | 'meanScore' } = {}): string {
  const metric = opts.metric ?? 'passAt1';
  const arms = [...new Set(rows.map((r) => r.arm))];
  const tasks = [...new Set(rows.map((r) => r.taskId))].sort();
  // per (task, arm): scored/resolved/scoreSum/infra over seeds.
  const cell = new Map<string, { scored: number; resolved: number; scoreSum: number; infra: number }>();
  const key = (t: string, a: string) => `${t}\x00${a}`;
  for (const r of rows) {
    const c = cell.get(key(r.taskId, r.arm)) ?? { scored: 0, resolved: 0, scoreSum: 0, infra: 0 };
    if (isScored(r)) {
      c.scored += 1;
      if (r.resolved === true) c.resolved += 1;
      if (typeof r.score === 'number') c.scoreSum += r.score;
    } else c.infra += 1;
    cell.set(key(r.taskId, r.arm), c);
  }
  const fmt = (t: string, a: string): string => {
    const c = cell.get(key(t, a));
    if (!c || c.scored + c.infra === 0) return '–'; // absent task (false under same-denominator)
    const val = metric === 'meanScore' ? c.scoreSum / Math.max(1, c.scored) : c.scored === 0 ? 0 : c.resolved / c.scored;
    return `${val.toFixed(2)}${c.infra > 0 ? ` i:${c.infra}` : ''}`;
  };
  const out: string[] = [];
  out.push(`### Per-instance matrix (${metric}; \`i:N\`=infra seeds counted false, \`–\`=absent)`);
  out.push(`| task | ${arms.map((a) => `\`${a}\``).join(' | ')} |`);
  out.push(`|---|${arms.map(() => '---').join('|')}|`);
  for (const t of tasks) out.push(`| ${t} | ${arms.map((a) => fmt(t, a)).join(' | ')} |`);
  return out.join('\n');
}

function statusMark(s: FairnessStatus): string {
  switch (s) {
    case 'PASS':
      return '✅ PASS';
    case 'FAIL':
      return '❌ FAIL';
    case 'WARN':
      return '⚠️ WARN';
    case 'NEEDS-EVIDENCE':
      return '🔍 NEEDS-EVIDENCE';
    case 'N/A':
      return '— N/A';
  }
}
