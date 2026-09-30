/**
 * capability-attribution-report.ts — the operator-core WIRING that connects stored benchmark run-results to
 * the generic per-capability attribution layer (plan benchmark-capability-injection-redesign-2026-06-17, P-011).
 *
 * `@papercusp/bench-metrics` owns the pure attribution math ({@link buildCapabilityAttribution} +
 * {@link buildCrossSuiteAttribution}); this file is the thin adapter that reads a run's persisted
 * `TaskRunResult` rows (the `benchmark_run_result` table, via the reproducibility store's
 * {@link listRunResults}), groups them by suite, and produces a per-suite attribution + the cross-suite
 * headline roll-up. So the moment a capability-injection run lands, "which capability lifted which suite/task,
 * at what cost" is ONE call away — no re-scoring, no bespoke per-suite glue.
 *
 * A suite is attributed only when it carries the CONTROL arm (default `vanilla`); a suite without it (e.g. a
 * coding run whose arms are papercusp/baseline, not the injection profiles) is SKIPPED with a reason rather
 * than failing the whole run — surfaced in `skippedSuites` so the omission is honest, never silent.
 *
 * The store reader is INJECTED (default = the real `listRunResults`) so this unit-tests with a fake — NO PG.
 */
import type {
  ArmId,
  CapabilityAttributionOpts,
  CapabilityAttributionReport,
  CrossSuiteAttribution,
  FairnessAudit,
  TaskRunResult,
} from '@papercusp/bench-metrics';
import {
  buildCapabilityAttribution,
  buildCrossSuiteAttribution,
  buildFairnessAudit,
  formatAttributionLines,
  formatFairnessAuditMarkdown,
  DEFAULT_CONTROL_ARM,
} from '@papercusp/bench-metrics';

/** The injected row reader — defaults to the reproducibility store's `listRunResults`. */
export type RunResultReader = (opts: { runId: string }) => Promise<TaskRunResult[]>;

/** A suite that couldn't be attributed (e.g. no control arm), kept so the omission is explicit. */
export interface SkippedSuite {
  suite: string;
  reason: string;
}

/** The full attribution for one run: per-suite reports + the cross-suite headline + what was skipped. */
export interface RunCapabilityAttribution {
  runId: string;
  control: ArmId;
  /** One report per suite that carried the control arm. */
  perSuite: CapabilityAttributionReport[];
  /** The headline matrix + per-capability roll-up across the attributed suites. */
  crossSuite: CrossSuiteAttribution;
  /** The mandatory C1–C10 fairness audit, one per suite (cross-arm; gates the claim — binding standard). */
  audits: FairnessAudit[];
  /** Suites present in the run but not attributed (with the reason). */
  skippedSuites: SkippedSuite[];
}

export interface BuildRunAttributionOpts {
  /** The store reader (default: the real `listRunResults`, lazy-imported so a fake test never loads PG). */
  reader?: RunResultReader;
  /** Workspace scope for the default reader. */
  workspace?: string;
  /** Attribution knobs (control arm, capabilityArms allow-list, pricing/CI opts) forwarded to bench-metrics. */
  attribution?: CapabilityAttributionOpts;
}

/** The real default reader — the reproducibility store, lazy-imported so a pure-fake test never loads PG. */
async function defaultReader(scope: { workspace?: string } = {}): Promise<RunResultReader> {
  const store = await import('../reproducibility/store');
  const ws = scope.workspace ? { workspace: scope.workspace } : {};
  return (opts) => store.listRunResults({ ...opts, ...ws });
}

/**
 * Build the per-capability attribution for a completed run. Reads the run's `TaskRunResult` rows, groups by
 * suite, and attributes each suite that carries the control arm; rolls the per-suite reports into the
 * cross-suite headline. Returns null when the run has no rows (an unknown / not-yet-emitted runId).
 *
 * Per-suite attribution failures (a suite with no control arm) are caught and recorded in `skippedSuites`,
 * never thrown — one un-attributable suite must not lose the rest of the run's attribution.
 */
export async function buildRunCapabilityAttribution(
  runId: string,
  opts: BuildRunAttributionOpts = {},
): Promise<RunCapabilityAttribution | null> {
  const reader = opts.reader ?? (await defaultReader({ workspace: opts.workspace }));
  const rows = await reader({ runId });
  if (!rows.length) return null;

  const control = opts.attribution?.control ?? DEFAULT_CONTROL_ARM;

  // Group rows by suite, preserving first-seen suite order (listRunResults orders by suite already).
  const bySuite = new Map<string, TaskRunResult[]>();
  for (const r of rows) {
    const arr = bySuite.get(r.suite) ?? [];
    arr.push(r);
    bySuite.set(r.suite, arr);
  }

  const perSuite: CapabilityAttributionReport[] = [];
  const audits: FairnessAudit[] = [];
  const skippedSuites: SkippedSuite[] = [];
  for (const [suite, suiteRows] of bySuite) {
    // The fairness audit gates EVERY suite's claim (binding standard) — compute it even for suites we cannot
    // attribute (no control arm): the C1–C10 table still applies cross-arm.
    try {
      audits.push(buildFairnessAudit(suiteRows));
    } catch {
      /* empty suite — unreachable (bySuite groups only non-empty) */
    }
    try {
      perSuite.push(buildCapabilityAttribution(suiteRows, opts.attribution));
    } catch (e) {
      skippedSuites.push({ suite, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    runId,
    control,
    perSuite,
    crossSuite: buildCrossSuiteAttribution(perSuite),
    audits,
    skippedSuites,
  };
}

/* ----------------------------- markdown rendering ----------------------------- */

/** A 2-decimal value delta, signed. */
function fmtDelta(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

/**
 * Render a {@link RunCapabilityAttribution} as a readable markdown artifact — the cross-suite headline
 * matrix, the per-suite narrative lines ({@link formatAttributionLines}), the skipped suites, and the
 * honest-framing caveats. Pure (no IO) so it unit-tests without a store; the CLI writes the string to a file.
 * This is the owner-facing surface: the moment a run lands, "which capability lifted which suite/task, at what
 * cost" reads straight out of one `.md`.
 */
export function formatRunAttributionMarkdown(run: RunCapabilityAttribution): string {
  const out: string[] = [];
  out.push(`# Capability attribution — run \`${run.runId}\``);
  out.push('');
  out.push(`Control arm: \`${run.control}\``);
  out.push('');

  // Cross-suite headline (per-capability roll-up).
  out.push('## Cross-suite headline');
  out.push('');
  if (run.crossSuite.rollup.length === 0) {
    out.push('_No capability arms attributed (no suite carried the control arm)._');
  } else {
    out.push('| capability | suites | mean Δ | significant | Pareto-better | tasks ↑ | tasks ↓ |');
    out.push('|---|---|---|---|---|---|---|');
    for (const r of run.crossSuite.rollup) {
      out.push(
        `| \`${r.capability}\` | ${r.suites} | ${fmtDelta(r.meanValueDelta)} | ${r.suitesSignificant}/${r.suites} | ${r.suitesParetoBetter}/${r.suites} | ${r.totalUnlocked} | ${r.totalRegressed} |`,
      );
    }
    out.push('');
    out.push('_Mean Δ mixes pass@1 and meanScore across suites of different metrics — read the per-suite lines for the honest per-metric number._');
  }
  out.push('');

  // Per-suite narrative lines.
  out.push('## Per suite');
  out.push('');
  for (const rep of run.perSuite) {
    out.push(`### ${rep.suite} (${rep.metric})`);
    const lines = formatAttributionLines(rep);
    if (lines.length === 0) out.push('_no capability arms_');
    else for (const l of lines) out.push(`- ${l}`);
    out.push('');
  }

  // Fairness audits (the mandatory C1–C10 pre-claim table per suite — binding standard).
  if (run.audits.length) {
    out.push('## Fairness audits (pre-claim — binding)');
    out.push('');
    for (const audit of run.audits) {
      out.push(formatFairnessAuditMarkdown(audit));
    }
  }

  // Skipped suites (honest about what wasn't attributed).
  if (run.skippedSuites.length) {
    out.push('## Skipped suites');
    out.push('');
    for (const s of run.skippedSuites) out.push(`- \`${s.suite}\`: ${s.reason}`);
    out.push('');
  }

  // Caveats — carried from the attribution reports (D-008/D-011).
  const caveats = run.crossSuite.caveats;
  if (caveats.length) {
    out.push('## Caveats');
    out.push('');
    for (const c of caveats) out.push(`- ${c}`);
    out.push('');
  }

  return out.join('\n');
}
