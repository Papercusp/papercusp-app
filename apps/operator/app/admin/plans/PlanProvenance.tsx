'use client';

import { useSyncQuery } from '@papercusp/sync';
import { parseAsString, useQueryState } from 'nuqs';
import { useMemo } from 'react';

import type {
  PlanItemProvenanceRow,
  PlanProvenanceView,
  PlanRequestRow,
  ProvenanceQuote,
} from '@papercusp/operator-core/lib/plan-provenance-read';

/**
 * plan-item-provenance-2026-09-29 P-005 (R-6) — where each plan item came from, and what
 * the owner asked for, on the plan detail view.
 *
 * The activation audit already held this evidence, but only behind a tool call: nobody
 * saw that an item traced to nothing the owner said, or that a request was quietly
 * dropped. This panel renders the `plans.provenance` read model (P-004) and follows
 * three rulings:
 *
 *  · D-006 — the per-item chip is visible WITHOUT expanding anything. Collapsed sections
 *    are where this evidence went unread before, so the item list is never folded; only
 *    the quoted turns behind a chip expand. "What you asked for" keeps the read model's
 *    order: rejected, then open, then repaired, then covered. A request the plan does not
 *    do is the most valuable line on the panel.
 *  · D-007 — the label never overclaims owner speech. "Your words" appears only for an
 *    affirmative owner verdict. `unknown` is "origin unknown", never the owner and never
 *    the agent: a lookup miss is not evidence of either.
 *  · Expansion state lives in nuqs (`prov=<slug>:<item|req>:<id>`), so `ui:get_state`
 *    can see which quote a human opened.
 *
 * The subscription is NOT gated on a toggle (unlike the spec-coverage census): the
 * chips are the deliverable, and a chip behind a click is the unread-fold R-6 forbids.
 */

export const PLAN_PROVENANCE_PARAM = 'prov';

type ItemLabel = PlanItemProvenanceRow['label'];
type Disposition = PlanRequestRow['disposition'];

const UNRESOLVED_REASON_TEXT: Record<NonNullable<PlanItemProvenanceRow['reason']>, string> = {
  no_mapping: 'no request maps to it',
  no_owner_ref: 'cites only non-owner turns',
  derived_source_not_owner_backed: 'derived from an item that is not owner-backed',
  agent_added_reason_missing: 'agent-added without a reason',
};

/** The chip text for one item — P-005's Yours / Derived from … / Agent-added / Not audited. */
export function itemChipText(item: Pick<PlanItemProvenanceRow, 'label' | 'derivedFrom' | 'reason'>): string {
  switch (item.label) {
    case 'owner':
      return 'Yours';
    case 'derived':
      return item.derivedFrom && item.derivedFrom.length > 0
        ? `Derived from ${item.derivedFrom.join(', ')}`
        : 'Derived';
    case 'agent-added':
      return 'Agent-added';
    case 'unresolved':
      return item.reason ? `Unresolved: ${UNRESOLVED_REASON_TEXT[item.reason]}` : 'Unresolved';
    case 'not-audited':
      return 'Not audited';
  }
}

/**
 * Who a quoted turn belongs to (D-007). Only an affirmative owner verdict may say
 * "Your words"; `owner` is the read model's own statement of that, so it is asked, not
 * re-derived from a verdict list kept here.
 */
export function speakerText(quote: Pick<ProvenanceQuote, 'owner' | 'verdict'>): string {
  if (quote.owner) return 'Your words';
  switch (quote.verdict) {
    case 'not-user-turn':
      return "The agent's words";
    case 'agent-injected':
      return 'Injected by the system';
    case 'machine-surface':
      return 'Machine-generated';
    case 'synthetic':
      return 'Synthetic turn';
    default:
      // `unknown`, and any verdict added later: never the owner, never the agent.
      return 'Origin unknown';
  }
}

const DISPOSITION_TEXT: Record<Disposition, string> = {
  rejected: 'Not doing',
  open: 'Open',
  repaired: 'Added after an omission',
  covered: 'Covered',
};

const LABEL_ORDER: ItemLabel[] = ['owner', 'derived', 'agent-added', 'unresolved', 'not-audited'];
const LABEL_COUNT_TEXT: Record<ItemLabel, string> = {
  owner: 'yours',
  derived: 'derived',
  'agent-added': 'agent-added',
  unresolved: 'unresolved',
  'not-audited': 'not audited',
};

function Quotes({ quotes, id }: { quotes: ProvenanceQuote[]; id: string }) {
  if (quotes.length === 0) {
    return (
      <div id={id} className="pc-plan-prov__quotes det-label">
        No source turn is cited.
      </div>
    );
  }
  return (
    <div id={id} className="pc-plan-prov__quotes">
      {quotes.map((quote) => (
        <blockquote
          key={quote.ref}
          className={`pc-plan-prov__quote${quote.owner ? ' is-owner' : ''}`}
          data-testid="plan-provenance-quote"
          data-verdict={quote.verdict}
        >
          <div className="det-label">
            <strong>{speakerText(quote)}</strong> · <code>{quote.ref}</code>
          </div>
          {quote.excerpt != null ? (
            <div className="pc-plan-prov__excerpt">{quote.excerpt}</div>
          ) : (
            <div className="det-label">Turn text could not be read.</div>
          )}
        </blockquote>
      ))}
    </div>
  );
}

export function PlanProvenance({ slug, harnessSlug }: { slug: string; harnessSlug?: string | null }) {
  const [openKey, setOpenKey] = useQueryState(PLAN_PROVENANCE_PARAM, parseAsString);
  const args = useMemo(
    () => (harnessSlug ? { planSlug: slug, harnessSlug } : { planSlug: slug }),
    [slug, harnessSlug],
  );
  const query = useSyncQuery<PlanProvenanceView>({
    queryName: 'plans.provenance',
    args,
    enabled: Boolean(slug),
  });
  const view = query.loading ? null : (query.data?.[0] ?? null);

  const keyOf = (kind: 'item' | 'req', id: string) => `${slug}:${kind}:${id}`;
  const toggle = (key: string) => void setOpenKey(openKey === key ? null : key);

  if (query.loading) {
    return (
      <section className="pc-plan-prov" aria-label="Item provenance">
        <div className="det-label">Reading item provenance…</div>
      </section>
    );
  }
  if (!view) {
    // A failed read and an all-owner plan are different facts.
    return (
      <section className="pc-plan-prov" aria-label="Item provenance">
        <div className="det-label" data-testid="plan-provenance-unavailable">
          Item provenance unavailable. This is NOT evidence that the items trace to your
          words.
        </div>
      </section>
    );
  }

  const counts = LABEL_ORDER.filter((label) => view.counts[label] > 0)
    .map((label) => `${view.counts[label]} ${LABEL_COUNT_TEXT[label]}`)
    .join(' · ');

  return (
    <section className="pc-plan-prov" aria-label="Item provenance">
      <div className="pc-now-hero__row">
        <strong>Where these items came from</strong>
        {counts ? <span className="det-label"> — {counts}</span> : null}
      </div>

      {view.status === 'no-audit' ? (
        <div className="det-label" data-testid="plan-provenance-no-audit">
          No activation audit is recorded, so no item is traced to your words yet.
        </div>
      ) : (
        <div className="det-label" data-testid="plan-provenance-audit">
          Audit #{view.audit?.auditSeq}
          {view.auditedRevision ? ` of revision r${view.auditedRevision.seq}` : ''}
          {view.audit?.createdBy ? ` by ${view.audit.createdBy}` : ''}
          {view.grandfathered
            ? ' — recorded before item provenance was stored; labels are computed now'
            : view.audit?.enforced === false
              ? ' — recorded as a warning: unresolved items did not block activation'
              : ''}
        </div>
      )}

      {/* The staleness line: the chips describe the audited plan, not necessarily this one. */}
      {view.stale ? (
        <div className="det-label" data-testid="plan-provenance-stale">
          ⚠ The plan changed after its audit
          {view.auditedRevision && view.currentRevision
            ? ` (audited r${view.auditedRevision.seq}, now r${view.currentRevision.seq})`
            : ''}
          {view.unauditedItems.length > 0
            ? `; ${view.unauditedItems.length} item(s) added since: ${view.unauditedItems.join(', ')}`
            : ''}
          . Re-audit before trusting these labels.
        </div>
      ) : null}

      <ul className="pc-plan-prov__items" data-testid="plan-provenance-items">
        {view.items.map((item) => {
          const key = keyOf('item', item.itemId);
          const open = openKey === key;
          const panelId = `plan-provenance-${slug}-item-${item.itemId}`;
          return (
            <li key={item.itemId} data-testid="plan-provenance-item" data-item-id={item.itemId}>
              <button
                type="button"
                className={`pc-plan-prov__chip pc-plan-prov__chip--${item.label}`}
                data-testid="plan-provenance-chip"
                data-label={item.label}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(key)}
              >
                {itemChipText(item)}
              </button>{' '}
              <strong>{item.itemId}</strong> {item.text}
              {item.label === 'agent-added' && item.agentReason ? (
                <div className="det-label">Agent&apos;s reason: {item.agentReason}</div>
              ) : null}
              {open ? <Quotes quotes={item.sources} id={panelId} /> : null}
            </li>
          );
        })}
      </ul>

      {view.status === 'audited' ? (
        <div data-testid="plan-provenance-requests">
          <div className="pc-now-hero__row">
            <strong>What you asked for</strong>
          </div>
          {view.requests.length === 0 ? (
            <div className="det-label">The audit mapped no requests.</div>
          ) : (
            <ul className="pc-plan-prov__requests">
              {view.requests.map((request) => {
                const key = keyOf('req', request.mappingId);
                const open = openKey === key;
                const panelId = `plan-provenance-${slug}-req-${request.mappingId}`;
                return (
                  <li
                    key={request.mappingId}
                    data-testid="plan-provenance-request"
                    data-disposition={request.disposition}
                  >
                    <button
                      type="button"
                      className={`pc-plan-prov__chip pc-plan-prov__chip--${request.disposition}`}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => toggle(key)}
                    >
                      {DISPOSITION_TEXT[request.disposition]}
                    </button>{' '}
                    {request.requirement}
                    {request.planTargets.length > 0 ? (
                      <span className="det-label"> → {request.planTargets.join(', ')}</span>
                    ) : null}
                    {open ? <Quotes quotes={request.sources} id={panelId} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {view.unresolvedBlockers.length > 0 ? (
            <div data-testid="plan-provenance-blockers">
              <div className="det-label">Unresolved blockers</div>
              {view.unresolvedBlockers.map((blocker) => (
                <div key={blocker}>• {blocker}</div>
              ))}
            </div>
          ) : null}
          {view.rejectedOrSuperseded.length > 0 ? (
            <div>
              <div className="det-label">Rejected or superseded</div>
              {view.rejectedOrSuperseded.map((entry) => (
                <div key={entry}>• {entry}</div>
              ))}
            </div>
          ) : null}
          {view.repairedOmissions.length > 0 ? (
            <div>
              <div className="det-label">Omissions repaired during the audit</div>
              {view.repairedOmissions.map((entry) => (
                <div key={entry}>• {entry}</div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
