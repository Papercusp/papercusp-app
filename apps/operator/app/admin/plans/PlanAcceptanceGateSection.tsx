'use client';

import { useSyncQuery } from '@papercusp/sync';
import { parseAsString, useQueryState } from 'nuqs';

import type { PlanAcceptanceGateVerdictRow } from '@papercusp/operator-core/lib/sync-resolver/plan-acceptance-gate-verdict';
import type { AcceptanceBarContractSnapshot } from '@papercusp/operator-core/lib/acceptance-bar-contract-snapshot';
import { requirementSections } from '@papercusp/operator-core/lib/requirement-contract';
import { WorkRefPill } from '../../_components/chat/WorkRefPill';
import { CHAT_WORK_ITEM_POPUP_PARAM, encodeScopedRef } from '../../_components/chat/chat-ref-popup-params';

/**
 * P-011 — the plan-surface view of the ACCEPTANCE GATE verdict: rubric role/verdict and
 * the EXACT blocker.
 *
 * `evaluatePlanAcceptanceGate` is called by `plans:set-status` and the unshipped-plans
 * audit and NOWHERE else, so its verdict was reachable only by attempting a ship. A
 * human could not see which rubric a plan is judged against, who graded it, or what
 * would refuse — until they tried and were refused.
 *
 * ⚠ THE RENDERING RULE, and it runs OPPOSITE to the sibling coverage section. There, the
 * findings are advisory and must not look like failures (D-018). Here the codes ARE real
 * refusals, so a blocker renders as a blocker — and the honesty burden moves onto the
 * PASSES instead. Five states are satisfied-but-not-clean, and flattening any of them
 * into a green claims a verification that did not happen:
 *
 *   · `skipped` — the gate did not APPLY. Nothing was checked.
 *   · `forcedPast` — a human waived the code-truth family with a recorded reason. The
 *     gate exists to make that visible ("a force that is easy to hide is worth very
 *     little"), so the waiver and its reason are rendered, never summarized away.
 *   · `vettedUnderWaiver` — the rubric was vetted over a consult nobody critiqued
 *     (EI-20821478338037350). Allowed, but the reader is entitled to know.
 *   · `gradedVia:'minimum'` — the grading came from a peer the relevance router did
 *     NOT match, taken as a below-floor minimum-fill because nobody above the floor
 *     was available (unified-responder-selection-critique-and-grading-2026-08-30
 *     D-002, which accepts that cost knowingly and asks that it not be rediscovered
 *     as a surprise). The grading is real; the expertise behind it is not vouched for.
 *   · `unknownRatedCriteria` — the authoritative grader explicitly said one or more
 *     outcomes were not assessable. The process gate may pass, but those outcomes
 *     were not verified and must remain visible.
 */

export const PLAN_ACCEPTANCE_GATE_PARAM = 'gate';

export function PlanAcceptanceGateSection({ slug }: { slug: string }) {
  const [openSlug, setOpenSlug] = useQueryState(PLAN_ACCEPTANCE_GATE_PARAM, parseAsString);
  const [, setOpenWorkItem] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);
  const open = openSlug === slug;

  const query = useSyncQuery<PlanAcceptanceGateVerdictRow>({
    queryName: 'plans.acceptanceGate',
    args: { planSlug: slug },
    enabled: open && Boolean(slug),
  });
  const row = query.loading ? null : (query.data?.[0] ?? null);

  // A pass with a caveat is NOT a clean pass. Computed once so the badge and the body
  // cannot disagree about it.
  const caveated = Boolean(
    row &&
      (row.skipped ||
        row.forcedPast ||
        row.vettedUnderWaiver ||
        row.gradedVia === 'minimum' ||
        (row.unknownRatedCriteria?.length ?? 0) > 0),
  );
  const badge = !row
    ? ''
    : row.unavailableReason
      ? ' — unavailable'
      : row.skipped
        ? ' — not checked'
        : !row.satisfied
          ? ' — BLOCKED'
          : caveated
            ? ' — passed with caveats'
            : ' — passed';

  return (
    <section className="pc-plan-gate" aria-label="Acceptance gate">
      <div className="pc-now-hero__row">
        <button
          type="button"
          data-testid="plan-acceptance-gate-toggle"
          aria-expanded={open}
          aria-controls={`plan-acceptance-gate-${slug}`}
          onClick={() => void setOpenSlug(open ? null : slug)}
        >
          Acceptance gate{badge}
        </button>
      </div>

      {open ? (
        <div id={`plan-acceptance-gate-${slug}`}>
          {query.loading ? (
            <div className="det-label">Evaluating the acceptance gate…</div>
          ) : !row || row.unavailableReason ? (
            /* The gate never throws by contract, so a failure here is infrastructure —
               and must never be shown as a pass. */
            <div className="det-label" data-testid="plan-acceptance-gate-unavailable">
              Acceptance gate could not be evaluated. This is NOT evidence that the plan
              would pass.
            </div>
          ) : (
            <>
              {/* NOT CHECKED ≠ PASSED. */}
              {row.skipped ? (
                <div className="det-label" data-testid="plan-acceptance-gate-skipped">
                  ⓘ Gate did NOT APPLY ({row.skipped.replace(/-/g, ' ')}) — nothing was
                  checked. This is not a pass.
                </div>
              ) : null}

              {/* THE EXACT BLOCKER. A real refusal, rendered as one. */}
              {!row.satisfied && row.code ? (
                <div data-testid="plan-acceptance-gate-blocking">
                  <div className="det-label">
                    ⛔ Ship BLOCKED — <strong>{row.code}</strong>
                  </div>
                  {/* The gate's teaching message is rendered VERBATIM: it names the
                      concrete next action, and summarizing it throws that away. */}
                  {row.message ? <div>{row.message}</div> : null}
                </div>
              ) : null}

              {/* A RECORDED WAIVER. Never silent — that is the whole point of stamping it. */}
              {row.forcedPast ? (
                <div data-testid="plan-acceptance-gate-forced">
                  <div className="det-label">
                    ⚠ Code-truth checks WAIVED by an explicit force — this plan did not
                    satisfy them
                  </div>
                  <div>Reason: {row.forcedPast.reason}</div>
                  <div className="det-label">
                    Waived: {row.forcedPast.checks.join(', ') || '(none recorded)'}
                  </div>
                </div>
              ) : null}

              {/* Vetted over a consult nobody critiqued (EI-20821478338037350). */}
              {row.vettedUnderWaiver ? (
                <div className="det-label" data-testid="plan-acceptance-gate-vetting-waiver">
                  ⚠ Rubric vetted under waiver — consult {row.vettedUnderWaiver.consultId}{' '}
                  received NO external critique
                  {row.vettedUnderWaiver.reason ? `: ${row.vettedUnderWaiver.reason}` : ''}
                </div>
              ) : null}

              {row.unknownRatedCriteria && row.unknownRatedCriteria.length > 0 ? (
                <div className="det-label" data-testid="plan-acceptance-gate-unknown">
                  ⚠ Authoritative grading marked these criteria UNKNOWN (not verified):{' '}
                  {row.unknownRatedCriteria.join(', ')}
                </div>
              ) : null}

              {/* RUBRIC ROLE + VERDICT. */}
              <div className="det-label" data-testid="plan-acceptance-gate-rubric">
                {row.rubricId
                  ? `Judged against rubric: ${row.rubricId}`
                  : 'No acceptance rubric resolved for this plan.'}
              </div>
              <div className="det-label" data-testid="plan-acceptance-gate-grader">
                {row.gradedBy
                  ? `Independently graded by: ${row.gradedBy}`
                  : 'No independent grading recorded — a self-grading does not satisfy this gate.'}
              </div>

              {/* Below-floor minimum-fill grading (D-002). Rendered beside the grader
                  rather than as a blocker: the ship is allowed, and what the reader
                  needs is that the router did not vouch for this grader's expertise. */}
              {row.gradedVia === 'minimum' ? (
                <div className="det-label" data-testid="plan-acceptance-gate-grader-minimum">
                  ⚠ Grader selected BELOW the relevance floor (minimum-fill) — nobody the
                  router matched was available, so this grading carries no expertise match
                </div>
              ) : null}
            </>
          )}
          {!query.loading && row ? (
            <RequirementContractView
              snapshot={row.acceptanceBarContractSnapshot}
              onOpenWork={(id) => void setOpenWorkItem(encodeScopedRef(row.acceptanceBarContractSnapshot?.plan?.harnessSlug, id))}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function evidenceOutcome(details: Record<string, unknown>): string {
  const adequacy = details.adequacy;
  if (adequacy && typeof adequacy === 'object' && 'outcome' in adequacy && typeof adequacy.outcome === 'string') {
    return adequacy.outcome;
  }
  return 'outcome not recorded';
}

function RequirementContractView({ snapshot, onOpenWork }: {
  snapshot: AcceptanceBarContractSnapshot | null | undefined;
  onOpenWork: (id: string) => void;
}) {
  if (!snapshot) return <p role="status" data-testid="requirement-details-unavailable">
    Requirement details are unavailable. Acceptance is unverified.
  </p>;
  const complete = snapshot.completeness.complete && !snapshot.completeness.truncated;
  const author = snapshot.grading.authorVerdict;
  const accepted = (bar: AcceptanceBarContractSnapshot['bars'][number]) => snapshot.applicable && complete &&
    bar.readiness.state === 'ready' && bar.grading.state === 'pass' &&
    snapshot.grading.vetting.state === 'current' && author.state === 'accepted';
  const allAccepted = snapshot.bars.length > 0 && snapshot.bars.every(accepted);
  const workRef = (id: string) => <WorkRefPill id={id} kind="work-item"
    href={`/admin/plans?${new URLSearchParams({ plan: snapshot.planSlug, gate: snapshot.planSlug,
      [CHAT_WORK_ITEM_POPUP_PARAM]: encodeScopedRef(snapshot.plan?.harnessSlug, id) })}`}
    onActivate={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpenWork(id);
    }} />;

  return <section className="pc-requirements" aria-label="Requirements">
    <h3>Requirements</h3>
    <ol className="pc-requirements__flow" aria-label="Requirement acceptance flow">
      {['Build and run checks', 'Evidence', 'Independent grade', 'Author acceptance', 'Accepted'].map((step) =>
        <li key={step}>{step}</li>)}
    </ol>
    <p data-testid="requirements-acceptance-state">{allAccepted ? 'All requirements accepted.' : 'Acceptance incomplete.'}</p>
    <p>Passing tests alone do not establish acceptance. Failures return to implementation; release checks and deployment follow acceptance.</p>
    {!complete ? <p role="status" data-testid="requirements-incomplete">
      {snapshot.completeness.truncated ? 'This is a partial history: a source reached its read limit.' : 'Some contract sources could not be verified.'}
      {' '}Acceptance remains unverified.
    </p> : null}
    {!snapshot.applicable ? <p>Legacy contract: adoption and original intent may not be recorded. No acceptance is inferred.</p> : null}
    {snapshot.readiness.nextRepair ? <p><strong>Next:</strong> {snapshot.readiness.nextRepair.action}</p> : null}
    {snapshot.bars.length === 0 ? <p>No unified requirements are recorded for this plan.</p> : null}
    {snapshot.bars.map((bar) => {
      const sections = bar.requirement ?? requirementSections({ key: bar.criterionKey, model: bar.model,
        driftMarkers: bar.falsifier, method: bar.method, check: bar.check ?? undefined,
        replication: bar.replication ?? undefined, requiredScope: bar.requiredScope,
        evidencePlane: bar.evidencePlane ?? undefined, requiredTestLayers: bar.requiredTestLayers,
        passRatings: bar.passRatings, mandatory: bar.mandatory ?? undefined });
      const intent = sections.intent;
      return <details className="pc-requirement" key={bar.barKey} data-testid={`requirement-${bar.barKey}`}>
        <summary><strong>{bar.barKey} — {bar.title || bar.criterionKey}</strong>
          <span className="pc-requirement__state">{accepted(bar) ? 'Accepted' : 'Not accepted'}</span>
        </summary>
        <div className="pc-requirement__body">
          <div className="pc-requirement__sections">
            <section aria-label={`${bar.barKey} Intent`}>
              <h4>Intent</h4>
              <p className="pc-requirement__prose">{intent?.request || 'Original intent was not recorded.'}</p>
              {intent?.rationale ? <p><strong>Why:</strong> {intent.rationale}</p> : null}
              {intent?.constraints?.length ? <><strong>Constraints</strong><ul>{intent.constraints.map((value) => <li key={value}>{value}</li>)}</ul></> : null}
              {intent?.sourceRefs?.length ? <><strong>Original sources</strong><ul>{intent.sourceRefs.map((ref) =>
                <li key={ref}>{/^https?:\/\//i.test(ref) ? <a href={ref} rel="noreferrer">{ref}</a> : <code>{ref}</code>}</li>)}</ul></> : null}
            </section>
            <section aria-label={`${bar.barKey} Acceptance`}>
              <h4>Acceptance (BAR)</h4>
              <p className="pc-requirement__prose">{sections.acceptance.condition || 'Success condition not recorded.'}</p>
              <p><strong>Falsifier:</strong> {sections.acceptance.falsifier || 'Not recorded.'}</p>
              <dl>
                <dt>Required scope</dt><dd>{sections.acceptance.requiredScope.join(', ') || 'Not recorded'}</dd>
                <dt>Evidence plane</dt><dd>{sections.acceptance.evidencePlane || 'Not recorded'}</dd>
                <dt>Required proof depth</dt><dd>{sections.acceptance.requiredTestLayers.join(', ') || 'Not recorded'}</dd>
                <dt>Passing ratings</dt><dd>{sections.acceptance.passRatings.join(', ') || 'Not recorded'}</dd>
                <dt>Role</dt><dd>{bar.role || 'Not recorded'}{bar.mandatory ? ' · required' : ''}</dd>
              </dl>
              {bar.coversBarKeys.length ? <p>Discloses: {bar.coversBarKeys.join(', ')}. Disclosure does not replace an outcome.</p> : null}
            </section>
            <section aria-label={`${bar.barKey} Verification`}>
              <h4>Verification</h4>
              <p className="pc-requirement__prose">{sections.verification.method || 'Verification method not recorded.'}</p>
              {sections.verification.check ? <details><summary>Check definition</summary>
                <pre>{JSON.stringify(sections.verification.check, null, 2)}</pre></details> : <p>No structured check recorded.</p>}
              {sections.verification.replication ? <p className="pc-requirement__prose"><strong>Replication:</strong> {sections.verification.replication}</p> : null}
              <p>Proof: {bar.proof.state} · adequacy: {bar.proof.adequacy?.state || 'not recorded'}</p>
              <p>Independent grade: {bar.grading.state}{bar.grading.rating ? ` (${bar.grading.rating})` : ''}</p>
              <p>Author verdict: {author.state}</p>
            </section>
          </div>
          <section aria-label={`${bar.barKey} Linked work`}>
            <h4>Linked work and validation</h4>
            {bar.mappings.length ? <ul>{bar.mappings.map((mapping) => <li key={`${mapping.specId}:${mapping.planItemId}`}>
              {mapping.planItemId} ({mapping.planItemStatus || 'status unknown'}) · {mapping.specId} revision {mapping.specRevision}
              {mapping.sourceValId ? ` · ${mapping.sourceValId}` : ''}
            </li>)}</ul> : <p>No validation mapping recorded.</p>}
            {bar.workContracts.length ? <ul>{bar.workContracts.map((work) => <li key={`${work.workItemId}:${work.specId}:${work.specRevision}`}>
              {workRef(work.workItemId)} · {work.specId} revision {work.specRevision} · {work.current ? 'current contract' : 'historical contract'}
            </li>)}</ul> : <p>No implementation contract recorded.</p>}
          </section>
          <section aria-label={`${bar.barKey} Evidence history`}>
            <h4>Evidence history</h4>
            {bar.proof.history?.length ? <ul className="pc-requirement__history">{bar.proof.history.map((entry) => <li key={entry.id}>
              <strong>{evidenceOutcome(entry.details)}</strong> · <code>{entry.evidenceRef}</code>
              <p>{workRef(entry.workItemId)} · {entry.specId} revision {entry.specRevision} · {entry.matchesCurrentSpec ? 'current spec' : 'historical spec'}</p>
              <p>Freshness: {entry.currentness.comparisonSupplied ? entry.currentness.overall : 'not compared'} · {entry.observedAt}</p>
              {entry.testRunId ? <p>Test run: {entry.testRunId}</p> : null}
              <details><summary>Evidence details</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details>
            </li>)}</ul> : <p>{bar.proof.evidenceRefs.length ? 'Detailed history is unavailable in this snapshot.' : 'No evidence recorded.'}</p>}
          </section>
          <section aria-label={`${bar.barKey} Review history`}>
            <h4>Review history</h4>
            {bar.grading.history?.length ? <ul className="pc-requirement__history">{bar.grading.history.map((review) => <li key={review.scorecardId}>
              {workRef(review.scorecardId)} · <strong>{review.role}</strong> · {review.createdBy || 'identity not recorded'}
              <p>Rubric revision {review.rubricRevision ?? 'not recorded'} · {review.currentRevision ? 'current revision' : 'historical revision'}
                {review.retracted ? ' · retracted' : ''}{!review.complete ? ' · incomplete' : ''}</p>
              {review.rating ? <p>Rating: {review.rating}. {review.evidence}</p> : null}
              {review.authorVerdict ? <p>Author verdict: {review.authorVerdict}. {review.reasoning}</p> : null}
              {review.supersedes ? <p>Reviews / supersedes: {workRef(review.supersedes)}</p> : null}
              {review.supersededBy ? <p>Followed by: {workRef(review.supersededBy)}</p> : null}
              <p>{review.createdAt}{review.selectedVia === 'minimum' ? ' · grader selected below relevance floor' : ''}</p>
            </li>)}</ul> : <p>No detailed review history recorded.</p>}
          </section>
        </div>
      </details>;
    })}
  </section>;
}
