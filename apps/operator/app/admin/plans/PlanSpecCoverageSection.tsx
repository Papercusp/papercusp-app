'use client';

import { useSyncQuery } from '@papercusp/sync';
import { parseAsString, useQueryState } from 'nuqs';
import { useMemo } from 'react';

import type { PlanSpecCoverageRow } from '@papercusp/operator-core/lib/sync-resolver/plan-spec-coverage';

/**
 * P-011 — the plan-surface view of P-008's spec-coverage census.
 *
 * Before this, `evaluatePlanSpecCoverageGate`'s verdict was reachable only by ATTEMPTING
 * A SHIP: a human saw THAT `plans:set-status` refused and never WHICH clauses are
 * uncovered, at WHICH revision — and never anything at all while the plan was still
 * green. This renders the same verdict the ship path enforces, continuously.
 *
 * ⚠ THE RENDERING RULE IS THE DELIVERABLE (D-018). The gate REPORTS far more than it
 * REFUSES, and the panel must show a blocker for EXACTLY what the gate refuses on — no
 * more (a human sent to fix something no gate blocks on) and no less (a real refusal
 * dressed as a note, so the ship fails without warning).
 *
 *   · A REFUSAL is `satisfied === false && mode === 'enforced'` — ASKED OF THE GATE, not
 *     re-derived from a list of codes kept here. P-013 widened the refusing set from
 *     `spec_proof_stale` alone to include `spec_clause_unproven`; a hand-kept list would
 *     have gone quietly stale and under-reported the new one.
 *   · `reports[]` — ungraded adequacy, undeclared falsifiers, and anything the plan is not
 *     yet ELIGIBLE to be refused on. ADVISORY. `wouldBlock` on a report-only verdict is
 *     the migration lane: real findings that do not refuse YET.
 *   · `spec_coverage_unavailable` — a deliberate fail-open degradation, not a refusal.
 *
 * Under P-008/D-018 unproven clauses were listed here as permanently advisory because the
 * refusal was P-013's to make. P-013 made it; they refuse now, on eligible plans.
 *
 * A FLOOR IS NEVER SHOWN AS A TOTAL. When the evidence census truncates, every count
 * becomes a floor and the gate itself degrades to report-only. The truncation notice
 * renders BESIDE the counts rather than under a "details" fold, because a bounded
 * measurement presented as a confident number is precisely the defect the boundedness
 * block was added to prevent.
 */

export const PLAN_SPEC_COVERAGE_PARAM = 'speccov';

export function PlanSpecCoverageSection({
  slug,
  harnessSlug,
}: {
  slug: string;
  harnessSlug?: string | null;
}) {
  const [openSlug, setOpenSlug] = useQueryState(PLAN_SPEC_COVERAGE_PARAM, parseAsString);
  const open = openSlug === slug;

  const args = useMemo(
    () => (harnessSlug ? { planSlug: slug, harnessSlug } : { planSlug: slug }),
    [slug, harnessSlug],
  );

  const query = useSyncQuery<PlanSpecCoverageRow>({
    queryName: 'plans.specCoverage',
    args,
    enabled: open && Boolean(slug),
  });
  const row = query.loading ? null : (query.data?.[0] ?? null);

  // ⚠ DERIVED from the gate's own verdict, never from a list of codes maintained here.
  //
  // This read `row?.code === 'spec_proof_stale'` — correct while that was the only code
  // that could refuse, and silently wrong the moment P-013 added `spec_clause_unproven`:
  // the panel would have rendered a REAL ship blocker as an advisory note, which is the
  // precise failure the header warns about in the other direction. The gate already
  // publishes `satisfied` and `mode` as its own statement of whether it can refuse, so
  // asking it beats re-deriving it — and a third refusing code needs no change here.
  const blocking = row ? !row.satisfied && row.mode === 'enforced' : false;
  const truncated = Boolean(
    row?.bounded?.truncatedByLimit || row?.bounded?.adequacyTruncatedByLimit,
  );

  return (
    <section className="pc-plan-speccov" aria-label="Spec coverage">
      <div className="pc-now-hero__row">
        <button
          type="button"
          data-testid="plan-spec-coverage-toggle"
          aria-expanded={open}
          aria-controls={`plan-spec-coverage-${slug}`}
          onClick={() => void setOpenSlug(open ? null : slug)}
        >
          Spec coverage
          {row?.clauses ? ` (${row.clauses.enforceable} enforceable)` : ''}
        </button>
      </div>

      {open ? (
        <div id={`plan-spec-coverage-${slug}`}>
          {query.loading ? (
            <div className="det-label">Censusing spec coverage…</div>
          ) : !row || row.unavailableReason ? (
            /* A failed census and a clean census are different facts. Never let a
               resolver error render as "this plan has full coverage". */
            <div className="det-label" data-testid="plan-spec-coverage-unavailable">
              Spec coverage unavailable (the census could not run). This is NOT evidence
              that the plan&apos;s clauses are covered.
            </div>
          ) : !row.applicable && row.clauses?.total === 0 ? (
            <div className="det-label" data-testid="plan-spec-coverage-none">
              This plan has adopted no first-class spec clauses, so there is no proof
              freshness to check. Adopting any clause makes this gate enforcing at ship
              time.
            </div>
          ) : (
            <>
              {/* THE REFUSAL. The only thing on this panel entitled to look like one. */}
              {blocking ? (
                <div data-testid="plan-spec-coverage-blocking">
                  <div className="det-label">
                    ⛔ Ship BLOCKED — {row.coverage?.staleProof ?? 0} clause(s) proven only
                    at a superseded revision
                  </div>
                  {(row.coverage?.staleProofClauses ?? []).map((c) => (
                    <div key={c.specId}>
                      {/* The revision never leaves the specId's side: a coverage claim
                          without the revision it was earned against is the thing this
                          plan exists to end. */}
                      • <strong>{c.specId}</strong> ({c.planItemId}): proof at r
                      {c.provenRevisions.join('/r')}, clause now r{c.currentRevision}
                    </div>
                  ))}
                </div>
              ) : null}

              {/* DEGRADED, not refused — a read failure deliberately fails open so an
                  infrastructure blip cannot freeze every ship. */}
              {row.code === 'spec_coverage_unavailable' ? (
                <div className="det-label" data-testid="plan-spec-coverage-degraded">
                  ⓘ Coverage census degraded to report-only — the gate declined to guess
                  rather than refuse. Four independent gates still enforce alongside it.
                </div>
              ) : null}

              {/* BOUNDEDNESS beside the counts, never hidden: a floor read as a total is
                  the defect the `bounded` block exists to prevent. */}
              {truncated ? (
                <div className="det-label" data-testid="plan-spec-coverage-truncated">
                  ⚠ Census TRUNCATED at its row cap ({row.bounded?.evidenceRowsRead ?? 0} of
                  max {row.bounded?.evidenceCensusLimit ?? 0} evidence rows read
                  {row.bounded?.adequacyTruncatedByLimit
                    ? `; adequacy capped at ${row.bounded.adequacyClauseLimit} clauses`
                    : ''}
                  ). Every count below is a FLOOR, not a total, and the freshness refusal
                  is withheld rather than guessed.
                </div>
              ) : null}

              {row.clauses && row.coverage ? (
                <div data-testid="plan-spec-coverage-counts">
                  <div className="det-label">
                    Clauses: {row.clauses.total} total · {row.clauses.enforceable}{' '}
                    enforceable · {row.clauses.exempt} exempt · {row.clauses.draft} draft ·{' '}
                    {row.clauses.inactive} inactive
                  </div>
                  <div className="det-label">
                    Coverage: {row.coverage.proven} proven at current revision ·{' '}
                    {row.coverage.staleProof} stale proof · {row.coverage.unproven} unproven
                  </div>
                  {row.adequacy ? (
                    <div className="det-label">
                      Adequacy scorecards: {row.adequacy.graded} graded ·{' '}
                      {row.adequacy.ungraded} ungraded
                    </div>
                  ) : null}
                  {/* D-016: an undeclared falsifier is an honest, gradeable gap. Stated
                      as a count rather than omitted, because omission reads as
                      "all declared". */}
                  <div className="det-label">
                    Falsifiers declared: {row.clauses.falsifierDeclared} of{' '}
                    {row.clauses.enforceable} enforceable
                  </div>
                </div>
              ) : null}

              {/* ADVISORY. Labelled as such in literal words, because a list of gaps
                  under no label reads as a list of failures. */}
              {row.reports.length > 0 ? (
                <div data-testid="plan-spec-coverage-reports">
                  <div className="det-label">
                    Advisory — reported, not enforced (nothing here blocks a ship)
                  </div>
                  {row.reports.map((r) => (
                    <div key={r}>• {r.replace(/-/g, ' ')}</div>
                  ))}
                  {(row.coverage?.unprovenSpecIds ?? []).length > 0 ? (
                    <div className="det-label">
                      Unproven: {(row.coverage?.unprovenSpecIds ?? []).join(', ')}
                    </div>
                  ) : null}
                  {(row.adequacy?.ungradedSpecIds ?? []).length > 0 ? (
                    <div className="det-label">
                      Ungraded: {(row.adequacy?.ungradedSpecIds ?? []).join(', ')}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* The gate's own mode, carried verbatim rather than re-derived — deriving
                  it here would eventually contradict D-018. */}
              <div className="det-label" data-testid="plan-spec-coverage-mode">
                Gate mode: {row.mode}
                {row.mode === 'report-only'
                  ? ' — this gate cannot refuse in its current state'
                  : ''}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
