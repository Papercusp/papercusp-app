'use client';

/**
 * GoalModeStateSection — the read-only “what the agent sees” block in a goal
 * cockpit (shared-agent-obligations-and-briefs-2026-09-05 P-009).
 *
 * Policy stays on the server. This component renders only the server-selected
 * projection entries and its delivery receipt; it never re-ranks evaluations,
 * decides satisfaction, or substitutes an empty list for an unread state.
 *
 * The design-registry match was feedback.banner / HostCheckBanner. That host
 * component is deliberately fixed-position and performs acknowledgement I/O,
 * so embedding it here would be both visually and behaviorally wrong. We reuse
 * its alert semantics and the goal cockpit's established inline alarm/zone/row
 * primitives instead of introducing another visual language.
 */
import { goalModeStateView, type GoalModeStateInput } from './goal-detail-model';

function meta(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

function StateBanner({ state, notices }: { state: 'degraded' | 'unknown'; notices: string[] }) {
  const headline = state === 'unknown' ? 'Goal-mode state is unknown.' : 'Goal-mode state is degraded.';
  return (
    <div className="hud-goal__set-alarm" role="alert" data-testid={`goal-mode-${state}`}>
      <strong>{headline}</strong>{' '}
      {notices.length > 0 ? notices.join(' · ') : 'The server did not provide a reason.'}
    </div>
  );
}

export default function GoalModeStateSection({ state }: { state?: GoalModeStateInput | null }) {
  const view = goalModeStateView(state);

  return (
    <section className="hud-goal__section" data-testid="goal-mode-state" data-status={view.status}>
      <h3 className="pc-zone-title">
        Goal-mode state
        <span className="pc-zone-title__sub">— what the agent sees</span>
      </h3>

      {view.status === 'unknown' ? <StateBanner state="unknown" notices={view.notices} /> : null}
      {view.status === 'degraded' ? <StateBanner state="degraded" notices={view.notices} /> : null}

      {view.ownerId || view.portfolio ? (
        <div data-testid="goal-mode-portfolio">
          <p className="hud-goal__set-summary">
            {meta([
              view.ownerId ? `agent ${view.ownerId}` : null,
              view.portfolio?.status ? `goal ${view.portfolio.status}` : null,
              view.portfolio?.queue ?? null,
            ])}
          </p>
          {view.portfolio?.priorities.length ? (
            <p className="hud-goal__note" data-testid="goal-mode-priorities">
              Priorities: {view.portfolio.priorities.join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}

      {view.obligations.length > 0 ? (
        <ul className="hud-goal__rows" data-testid="goal-mode-obligations">
          {view.obligations.map((obligation) => (
            <li
              key={obligation.id}
              className="hud-goal__row"
              data-testid="goal-mode-obligation"
              data-status={obligation.status}
              style={{ alignItems: 'stretch', flexDirection: 'column', gap: 3 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span className="hud__chip">{obligation.status}</span>
                <strong className="hud-goal__row-title">{obligation.title}</strong>
              </div>
              {obligation.action ? (
                <p className="hud-goal__note" data-testid="goal-mode-primary-action">
                  <strong>Next:</strong> {obligation.action}
                </p>
              ) : null}
              {obligation.reason ? <p className="hud-goal__note">Why: {obligation.reason}</p> : null}
              <span className="hud-goal__row-meta">
                {meta([
                  obligation.demand == null ? 'demand unknown' : `demand ${obligation.demand}`,
                  obligation.deadline ? `due ${obligation.deadline}` : null,
                  obligation.age ? `age ${obligation.age}` : null,
                  obligation.sourceGeneration ? `source ${obligation.sourceGeneration}` : 'source unknown',
                ])}
              </span>
              {obligation.measurementFailure ? (
                <p className="hud-goal__set-alarm" data-testid="goal-mode-measurement-failure">
                  <strong>{obligation.measurementFailure.code ?? 'Measurement failed'}.</strong>{' '}
                  {obligation.measurementFailure.detail ?? 'No detail was supplied.'}
                  {obligation.measurementFailure.retry
                    ? ` Recovery: ${obligation.measurementFailure.retry}`
                    : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : view.empty === 'no-demand' ? (
        <p className="hud-goal__empty" data-testid="goal-mode-no-demand">
          No obligation is due in the current server evaluation.
        </p>
      ) : view.empty === 'overflow' ? (
        <p className="hud-goal__set-alarm" role="status" data-testid="goal-mode-overflow-empty">
          Primary obligations exist, but none fit this delivery projection. Use the detail path below.
        </p>
      ) : (
        <p className="hud-goal__empty" data-testid="goal-mode-unavailable">
          No obligation rows are available from this reading.
        </p>
      )}

      {view.entriesOmitted != null && view.entriesOmitted > 0 ? (
        <p className="hud-goal__note" data-testid="goal-mode-omissions">
          Showing {view.entriesDelivered ?? view.obligations.length} of {view.entriesAvailable ?? 'unknown'} primary
          obligations; {view.entriesOmitted} omitted
          {view.omissionReason ? ` (${view.omissionReason})` : ''}.
        </p>
      ) : null}

      <p className="hud-goal__row-meta" data-testid="goal-mode-provenance">
        {meta([
          view.sourceGeneration ? `agenda ${view.sourceGeneration}` : 'agenda generation unknown',
          view.observedAt ? `observed ${view.observedAt}` : 'observation time unknown',
        ])}
      </p>
      {view.detailRef ? (
        <p className="hud-goal__note" data-testid="goal-mode-detail-ref">
          Detail path: <code>{view.detailRef}</code>
        </p>
      ) : null}
    </section>
  );
}
