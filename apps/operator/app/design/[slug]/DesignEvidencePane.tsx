'use client';

/**
 * Design evidence pane — the report-only fidelity report, for reviewers.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * Sibling of RegressionPane, and deliberately answering a different question.
 * RegressionPane asks "did this surface change since its baseline"; this pane
 * asks "does this surface match the design that was RATIFIED for it, and is the
 * threshold that judges it still trustworthy".
 *
 * Three things this pane refuses to do, each because the alternative reads as a
 * verdict it has not earned:
 *
 *   * It never renders a missing report as zeroes. "Not run here" and "run,
 *     nothing wrong" are opposite states and must not share a rendering.
 *   * It never renders an unmeasured noise floor as a number.
 *   * It says REPORT-ONLY in the header, because a reviewer who sees green rows
 *     will otherwise reasonably assume something is enforcing them. Under D-006
 *     nothing is, yet.
 */
import { useMemo } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';

interface ReportedClass {
  referenceClass: string;
  eligibility: 'gateable' | 'advisory-only';
  maxDiffRatio: number;
  effectiveNoise: number | null;
  regressionFloor: number | null;
  separation: number | null;
  explainUngateable?: string;
  captureRuntimeP50Ms: number | null;
  comparisonRuntimeP50Ms: number | null;
}

interface ReportedCase {
  caseId: string;
  referenceClass: string;
  leg: 'noise' | 'regression';
  diffRatio: number;
  verdict: 'pass' | 'fail' | 'invalid';
  invalidReason?: string;
  detail?: string;
  comparisonMs: number;
  asPredicted: boolean | null;
}

interface EvidenceReport {
  generatedAt: string;
  gating: false;
  policyVersion: string;
  engine: { engine: string; engineVersion: string };
  classes: ReportedClass[];
  cases: ReportedCase[];
  summary: {
    total: number;
    pass: number;
    fail: number;
    invalid: number;
    gateableClasses: number;
    advisoryOnlyClasses: number;
    predictionsMade: number;
    predictionsHeld: number;
  };
  selfCheck: {
    noiseThatFailed: string[];
    regressionsThatPassed: string[];
    consistent: boolean;
  };
  caveats: string[];
}

interface EvidenceResponse {
  present: boolean;
  generatedMtime: number | null;
  reportPath: string;
  report: EvidenceReport | null;
}

const mutedText = 'var(--fg-mute)';
const dimText = 'var(--fg-dim)';
const panelBorder = 'var(--border)';
const warnText = 'var(--warn)';
const badText = 'var(--bad)';
const goodText = 'var(--good)';

/** Ratios here are tiny (1e-5 territory); percent with fixed digits reads as 0.00%. */
function formatRatio(value: number | null): string {
  if (value === null) return 'unmeasured';
  if (value === 0) return '0';
  return value.toExponential(2);
}

export default function DesignEvidencePane() {
  const [filter, setFilter] = useQueryState(
    'evidenceFilter',
    parseAsStringEnum<'all' | 'unexpected' | 'noise' | 'regression'>([
      'all',
      'unexpected',
      'noise',
      'regression',
    ]).withDefault('all'),
  );

  const q = useSyncQuery<EvidenceResponse>({ queryName: 'designEvidence.report' });
  const payload = q.data?.[0] ?? null;
  const report = payload?.report ?? null;

  const cases = useMemo(() => {
    const all = report?.cases ?? [];
    const filtered =
      filter === 'all'
        ? all
        : filter === 'unexpected'
          ? all.filter((c) => c.asPredicted === false)
          : all.filter((c) => c.leg === filter);
    // Anything that contradicts the policy's own prediction sorts first: it is
    // the only category a reviewer must act on.
    return [...filtered].sort((a, b) => {
      const aBad = a.asPredicted === false ? 0 : 1;
      const bBad = b.asPredicted === false ? 0 : 1;
      if (aBad !== bBad) return aBad - bBad;
      return a.caseId.localeCompare(b.caseId);
    });
  }, [report, filter]);

  if (q.loading) return <p style={{ color: mutedText }}>Loading design evidence…</p>;
  if (q.error) return <p style={{ color: badText }}>Failed: {q.error.message}</p>;

  if (!payload?.present || report === null) {
    return (
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>Design evidence</h2>
        <p style={{ color: mutedText, fontSize: 13, maxWidth: 620 }}>
          No report has been produced in this checkout. Run <code>npm run design:evidence-report</code>{' '}
          to generate one, or download the <code>design-evidence-report</code> artifact from a CI run
          of the visual job.
        </p>
        <p style={{ color: dimText, fontSize: 12 }}>
          This is <strong>not</strong> a clean result — it is the absence of a measurement.
        </p>
      </div>
    );
  }

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
          Design evidence{' '}
          {/*
            Predictions held, NOT pass/fail. A regression case is supposed to
            fail, so a "4 fail" headline would report four problems where there
            are none.
          */}
          <span style={{ color: mutedText, fontWeight: 400 }}>
            {report.summary.predictionsHeld}/{report.summary.predictionsMade} predictions held
          </span>
        </h2>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 10,
            background: 'var(--bg-2)',
            color: dimText,
            fontSize: 11,
            fontWeight: 600,
          }}
          title="Under D-006 this report publishes evidence and blocks nothing."
        >
          REPORT-ONLY
        </span>
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {(['all', 'unexpected', 'noise', 'regression'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setFilter(b)}
              style={{
                padding: '4px 8px',
                borderRadius: 4,
                border: `1px solid ${filter === b ? 'var(--accent)' : panelBorder}`,
                background:
                  filter === b ? 'color-mix(in oklab, var(--accent), transparent 84%)' : 'transparent',
                color: filter === b ? 'var(--fg)' : dimText,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {b}
            </button>
          ))}
        </nav>
      </header>

      <p style={{ fontSize: 12, color: mutedText, marginTop: 0, marginBottom: 12 }}>
        policy <code>{report.policyVersion}</code> · engine <code>{report.engine.engine}</code>@
        {report.engine.engineVersion} · generated {new Date(report.generatedAt).toLocaleString()}
      </p>

      {!report.selfCheck.consistent && (
        <div
          style={{
            border: `1px solid ${badText}`,
            borderRadius: 6,
            padding: 12,
            marginBottom: 16,
            background: 'var(--bad-bg, var(--warn-bg))',
          }}
        >
          <strong style={{ color: badText, fontSize: 13 }}>
            The shipped threshold no longer matches the surface.
          </strong>
          <p style={{ fontSize: 12, color: dimText, margin: '6px 0 0' }}>
            {report.selfCheck.noiseThatFailed.length} unchanged surface(s) failed and{' '}
            {report.selfCheck.regressionsThatPassed.length} real change(s) passed. Re-calibrate and
            mint a new policy version — do not widen the threshold in place.
          </p>
        </div>
      )}

      <section style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px', color: dimText }}>
          Thresholds by reference class
        </h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {report.classes.map((cls) => (
            <li
              key={cls.referenceClass}
              style={{
                border: `1px solid ${panelBorder}`,
                borderLeft: `3px solid ${cls.eligibility === 'gateable' ? goodText : warnText}`,
                borderRadius: 6,
                padding: 10,
                background: 'var(--bg-1)',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 13, fontWeight: 500 }}>{cls.referenceClass}</code>
                <span
                  style={{
                    fontSize: 11,
                    color: cls.eligibility === 'gateable' ? goodText : warnText,
                    fontWeight: 500,
                  }}
                >
                  {cls.eligibility}
                </span>
                <span style={{ fontSize: 11, color: mutedText, marginLeft: 'auto' }}>
                  threshold {formatRatio(cls.maxDiffRatio)} · noise {formatRatio(cls.effectiveNoise)}{' '}
                  · smallest real change {formatRatio(cls.regressionFloor)}
                  {cls.separation === null ? '' : ` · ${cls.separation.toFixed(0)}× separation`}
                </span>
              </div>
              {cls.explainUngateable && (
                <p style={{ fontSize: 12, color: mutedText, margin: '6px 0 0' }}>
                  {cls.explainUngateable}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px', color: dimText }}>
          Cases ({cases.length})
        </h3>
        {cases.length === 0 ? (
          <p style={{ color: mutedText }}>No cases match.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
            {cases.map((c) => (
              <li
                key={c.caseId}
                style={{
                  border: `1px solid ${c.asPredicted === false ? badText : panelBorder}`,
                  borderRadius: 4,
                  padding: '6px 10px',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  background: c.asPredicted === false ? 'var(--warn-bg)' : 'var(--bg-1)',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color:
                      c.verdict === 'pass' ? goodText : c.verdict === 'fail' ? warnText : mutedText,
                    minWidth: 52,
                  }}
                >
                  {c.verdict}
                </span>
                <span style={{ fontSize: 11, color: dimText, minWidth: 76 }}>{c.leg}</span>
                <code style={{ fontSize: 12, color: 'var(--fg)' }}>{c.caseId}</code>
                <span style={{ fontSize: 11, color: mutedText, marginLeft: 'auto' }}>
                  diff {formatRatio(c.diffRatio)} · {c.comparisonMs.toFixed(1)}ms
                </span>
                {c.asPredicted === false && (
                  <span style={{ fontSize: 11, color: badText, width: '100%' }}>
                    contradicts the policy&rsquo;s own prediction for this leg
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', color: dimText }}>
          Scope of these numbers
        </h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: mutedText, fontSize: 12 }}>
          {report.caveats.map((caveat) => (
            <li key={caveat} style={{ marginBottom: 4 }}>
              {caveat}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
