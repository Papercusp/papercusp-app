'use client';

/**
 * Lint banner (P-206).
 *
 * Renders a slim banner under the plan-actions strip when plans:lint
 * returns errors or warnings for the open plan. Click a finding to
 * scroll the matching item ([data-plan-item="P-NNN"]) or decision
 * heading (#D-NNN) into view — reusing the P-106 highlight pulse.
 *
 * Re-fetches:
 *   - On mount and whenever the slug changes (usePlanLint dep).
 *   - On window focus (usePlanLint dep).
 *   - After every assisted write — caller bumps the `tick` prop via
 *     PlanDetail.onChanged.
 *
 * Legacy and exempt plans render nothing — the parser+lint already
 * skip them upstream.
 */

import type { LintFinding, PlanLintReport } from './plans-api';

interface Props {
  report: PlanLintReport | null | undefined;
  /** Editor container scope for scroll-to-finding (same ref the
   *  jump-to-item typeahead uses). */
  scopeRef: React.RefObject<HTMLElement | null>;
}

export default function LintBanner({ report, scopeRef }: Props) {
  if (!report || report.exempt || report.legacy) return null;
  const total = report.errors.length + report.warnings.length;
  if (total === 0) return null;

  const onClickFinding = (f: LintFinding) => {
    const scope = scopeRef.current;
    if (!scope) return;
    const dest = findFindingTarget(scope, f);
    if (!dest) return;
    dest.scrollIntoView({ block: 'center', behavior: 'smooth' });
    dest.classList.add('pc-plan-highlight');
    setTimeout(() => dest.classList.remove('pc-plan-highlight'), 1500);
  };

  return (
    <div
      className={`pc-lint-banner pc-lint-banner--${report.errors.length ? 'error' : 'warn'}`}
      role="status"
      aria-live="polite"
    >
      <header className="pc-lint-banner__head">
        <strong>
          {report.errors.length ? `${report.errors.length} error${report.errors.length === 1 ? '' : 's'}` : null}
          {report.errors.length && report.warnings.length ? ', ' : null}
          {report.warnings.length
            ? `${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}`
            : null}
        </strong>
      </header>
      <ul className="pc-lint-banner__findings">
        {report.errors.map((f, i) => (
          <li key={`e-${i}`}>
            <button type="button" className="pc-lint-banner__finding pc-lint-banner__finding--error" onClick={() => onClickFinding(f)}>
              <span className="pc-lint-banner__code">{f.code}</span>
              <span className="pc-lint-banner__msg">{f.message}</span>
            </button>
          </li>
        ))}
        {report.warnings.map((f, i) => (
          <li key={`w-${i}`}>
            <button type="button" className="pc-lint-banner__finding pc-lint-banner__finding--warn" onClick={() => onClickFinding(f)}>
              <span className="pc-lint-banner__code">{f.code}</span>
              <span className="pc-lint-banner__msg">{f.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function findFindingTarget(scope: HTMLElement, f: LintFinding): HTMLElement | null {
  if (f.itemId) {
    return scope.querySelector<HTMLElement>(`[data-plan-item="${f.itemId}"]`);
  }
  if (f.decisionId) {
    const byId = scope.querySelector<HTMLElement>(`#${CSS.escape(f.decisionId)}`);
    if (byId) return byId;
    for (const h of Array.from(scope.querySelectorAll<HTMLElement>('h3'))) {
      if ((h.textContent ?? '').trim().startsWith(f.decisionId)) return h;
    }
  }
  return null;
}
