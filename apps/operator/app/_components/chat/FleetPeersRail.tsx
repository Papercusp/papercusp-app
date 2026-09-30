'use client';

/**
 * FleetPeersRail — the conversation popup's FOURTH zone
 * (chat-popup-fleet-peers-rail-2026-08-09 P-002).
 *
 * [owner 2026-08-09] "when an agent is a member or leader of a fleet, can an
 * additional panel to the right of the activity panel show up showing all their
 * peers (leader & members)... Clicking on a peer should update the conversation
 * popup to display that peer."
 *
 * So the popup now reads left-to-right as: what they were TOLD (Orders) → the
 * conversation → what they are DOING (Activity) → who they are WITH (this). The
 * newest and most situational rail sits furthest from the transcript, which is
 * also why D-002 makes it the first to give way when width runs out.
 *
 * PRESENTATIONAL ONLY. It takes an already-derived `FleetPeersModel` and renders
 * it; the derivation (and every rule about grouping, ordering and what counts as
 * a fleet) lives in the pure, unit-tested `fleet-peers.ts`. The caller derives
 * because the caller ALSO needs the answer — a null model means "no rail, no
 * toggle, and don't widen the popup", which are layout decisions this component
 * cannot make from inside itself.
 *
 * ── Why the state mark is driven by the board's COLUMN, not by `liveness` ────
 * WI-6636 measured what happens when a fleet surface trusts `liveness`: it is
 * heartbeat freshness alone, and a PARKED agent — idle between turns, holding
 * its inbox wake — keeps beating, so it reads 'live' forever. On the default
 * board that mislabelled 110 of 133 cards. The column verdict already folds in
 * the shared liveness oracle, so a peer here reads the same as the same agent on
 * the board behind the popup. Never re-derive a private live/idle vocabulary in
 * this file.
 *
 * ── The leader-brief overlay (popup-agent-state-coverage-2026-08-18) ─────────
 * When the viewed agent leads this fleet, the rail additionally renders what
 * `fleet:leader-brief` — the object that leader is actually handed — says about
 * each member. That overlay is GLYPHS ON EXISTING ROWS plus one bounded block
 * at the top; it adds no rows, because the rail's fixed height is a constraint
 * paid for after one agent's 32 locks made it ~2,000px tall (D-003). The
 * derivation is the pure, unit-tested `leader-brief-alerts.ts` — this file
 * renders it and decides nothing.
 *
 * The overlay is ADDITIVE and never overrides the board column: a member can be
 * `working` on the board and dormant in the brief at the same time, and that
 * pair IS the finding. Suppressing one to make the row consistent would delete
 * exactly the signal the plan exists to surface.
 */
import { useMemo } from 'react';
import { Tooltip } from '../../harness/Tooltip';
import FleetRoleGlyph from '../FleetRoleGlyph';
import { useChatClock } from './message-timestamp';
import { formatAge, type HudColumnId } from '../../adv/hud/hud-board-model';
import type { FleetPeer, FleetPeersModel } from './fleet-peers';
import type { FleetAlertsModel, FleetMetricsModel, LeaderBriefAlertsModel, MemberAlert } from './leader-brief-alerts';

/** The state word under each peer. Terse on purpose: this column is ~248px and
 *  the row's job is to be scanned, not read. The full sentence rides in `title`
 *  (the board's own `reason`), so nothing is lost — it is one hover away. */
export const COLUMN_WORD: Record<HudColumnId, string> = {
  'needs-you': 'needs you',
  blocked: 'blocked',
  stalled: 'stalled',
  working: 'working',
  parked: 'parked',
};

/** The alert marks for one row. Each glyph carries its own sentence in a native
 *  `title` — legal on a span (the design-primitives rule bans it on buttons,
 *  links and tabs, which is why the ROW's reason goes through `Tooltip`), and
 *  the same sentences are appended to the row tooltip so a keyboard or touch
 *  user reaches them too. */
function PeerAlertGlyphs({ alerts }: { alerts: MemberAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <span className="pc-peer__alerts" data-testid="peer-alert-glyphs">
      {alerts.map((a) => (
        <span
          key={a.key}
          className="pc-peer__alert"
          data-sev={a.severity}
          data-alert={a.key}
          title={a.title}
        >
          {a.glyph}
        </span>
      ))}
    </span>
  );
}

function PeerRow({
  peer,
  alerts,
  onSelect,
}: {
  peer: FleetPeer;
  /** Leader-brief alerts for THIS member, most-severe first. Empty/absent means
   *  "nothing the brief flagged" — which is only an all-clear when a brief was
   *  actually read; the rail's own block says whether it was. */
  alerts?: MemberAlert[];
  /** Absent ⇒ render read-only. A row that looks clickable and is not is worse
   *  than one that plainly is not — see the rail's own `onSelectPeer` doc. */
  onSelect?: (ownerId: string) => void;
}) {
  const age = formatAge(peer.sinceSec);
  const clickable = onSelect != null && !peer.isCurrent;
  const rowAlerts = alerts ?? [];
  // The board's own sentence FIRST, then what the brief adds. Both, never one:
  // the column says how this row scored, the alerts say what that score cannot
  // see, and a reader needs the pair to act.
  const reason =
    rowAlerts.length > 0
      ? [peer.reason, ...rowAlerts.map((a) => a.title)].join(' · ')
      : peer.reason;

  const body = (
    <>
      <span className="pc-peer__r1">
        <span className="pc-peer__dot" data-col={peer.column} aria-hidden="true" />
        <FleetRoleGlyph role={peer.isLeader ? 'leader' : 'member'} className="pc-peer__glyph" />
        <span className="pc-peer__handle">{peer.handle}</span>
        {peer.agentPaneKind === 'cup' ? <span className="pc-peer__kind">cup</span> : null}
        <PeerAlertGlyphs alerts={rowAlerts} />
        {peer.isCurrent ? (
          <span className="pc-peer__here">viewing</span>
        ) : peer.contextPct != null ? (
          /* null is NOT 0 — an unmeasured context rendered as 0% reads as
             "plenty of room left", so an unsampled peer shows nothing here. */
          <span className="pc-peer__ctx" data-hot={peer.contextPct >= 60 ? 'true' : undefined}>
            {peer.contextPct}%
          </span>
        ) : null}
      </span>
      <span className="pc-peer__r2">
        <span className="pc-peer__state" data-col={peer.column}>
          {COLUMN_WORD[peer.column]}
          {age ? ` ${age}` : ''}
        </span>
        {peer.intent ? <span className="pc-peer__intent"> · {peer.intent}</span> : null}
      </span>
    </>
  );

  if (!clickable) {
    return (
      <li
        className="pc-peer"
        data-current={peer.isCurrent ? 'true' : undefined}
        aria-current={peer.isCurrent ? 'true' : undefined}
        data-testid="fleet-peer-row"
        title={reason}
      >
        {body}
      </li>
    );
  }

  return (
    <li>
      {/* The shared Tooltip primitive, NOT a `title=` attribute — a native title
          is unreachable by keyboard and on touch, and `lint:design-primitives`
          fails a title on a <button> for exactly that reason. It carries the
          board's full `reason` sentence, which the row itself truncates to a
          state word plus an ellipsized intent.

          `side="left"` because this rail is the popup's right edge: a tooltip
          opening right would render off the window. */}
      <Tooltip label={reason} side="left">
        <button
          type="button"
          className="pc-peer pc-peer--btn"
          onClick={() => onSelect!(peer.ownerId)}
          data-testid="fleet-peer-row"
          data-owner={peer.ownerId}
          /* The label spells out the DESTINATION, because the visible row is a
             handle and a state word — neither of which says that pressing it
             navigates. It repeats the reason so a screen-reader user gets what
             the tooltip shows a sighted one. */
          aria-label={`Open ${peer.handle}'s conversation — ${reason}`}
        >
          {body}
        </button>
      </Tooltip>
    </li>
  );
}

/**
 * The fleet-level alert block (P-004).
 *
 * ALWAYS VISIBLE when it applies — [owner 2026-08-18] approved the mockups
 * that draw it that way and D-007 records the ruling; it is deliberately NOT
 * folded behind the right-edge `⚠ N locks ›` pattern. It renders nothing at all
 * on a clean fleet, so its absence is the all-clear and its presence is news.
 *
 * Bounded by construction (D-003): a handful of one-line rows, each with its
 * reason on hover. The reasons are the brief's own sentences — a flag rendered
 * without the reason behind it is the bare-complaint shape the brief's own
 * comments warn about, because the flag says IF and only the reason says WHY.
 */
function FleetAlertsBlock({ fleet }: { fleet: FleetAlertsModel }) {
  return (
    <section className="pc-peers__alerts" data-testid="fleet-alert-block" aria-label="Fleet alerts">
      <header className="pc-peers__alerts-cap">
        <span>Fleet alerts</span>
        <span className="pc-peers__cap-n">{fleet.alerts.length}</span>
      </header>
      {fleet.alerts.map((a) => (
        <div
          key={a.key}
          className="pc-peers__alert"
          data-sev={a.severity}
          data-alert={a.key}
          title={a.detail ?? undefined}
          role="status"
        >
          <span className="pc-peers__alert-mark" aria-hidden="true">
            ▲
          </span>
          <span className="pc-peers__alert-text">{a.text}</span>
        </div>
      ))}
      {fleet.capacity ? (
        <div className="pc-peers__alert-kv" data-testid="fleet-alert-capacity">
          <span>capacity</span>
          <span>{fleet.capacity}</span>
        </div>
      ) : null}
      {/* Only ever rendered when the block is already open for another reason.
          A leader must be able to tell "my checks ran and found nothing" from
          "my checks are not running" — a reason-only field cannot say it, and
          that is the same false-clean the invariants exist to catch. */}
      {fleet.invariantsNote ? (
        <div className="pc-peers__alert-kv" data-testid="fleet-alert-invariants-ok">
          <span>invariants</span>
          <span>{fleet.invariantsNote}</span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Canonical WORK scope, kept separate from member alerts because the two count
 * different populations. The three visible rows are an atomic tuple: stock,
 * population/spec/window, and exactness/freshness. Omitting any one would make
 * the surviving count unsafe to compare with another fleet read (D-005).
 */
function FleetMetricsBlock({ metrics }: { metrics: FleetMetricsModel }) {
  const accessible = `Fleet work scope: ${metrics.remaining}; ${metrics.scope}; ${metrics.quality}. ${metrics.detail}`;
  return (
    <section
      className="pc-peers__alerts pc-peers__metrics"
      data-testid="fleet-metrics-block"
      data-status={metrics.status}
      aria-label={accessible}
      title={metrics.detail}
    >
      <header className="pc-peers__alerts-cap">
        <span>Work scope</span>
        <span className="pc-peers__cap-n">{metrics.status}</span>
      </header>
      <div className="pc-peers__alert-kv" data-testid="fleet-metrics-remaining">
        <span>remaining</span>
        <span>{metrics.remaining}</span>
      </div>
      <div className="pc-peers__alert-kv" data-testid="fleet-metrics-scope">
        <span>scope</span>
        <span>{metrics.scope}</span>
      </div>
      <div className="pc-peers__alert-kv" data-testid="fleet-metrics-quality">
        <span>quality</span>
        <span>{metrics.quality}</span>
      </div>
    </section>
  );
}

export default function FleetPeersRail({
  model,
  alerts,
  onSelectPeer,
  onClose,
  headerControl,
}: {
  model: FleetPeersModel;
  /**
   * The leader-brief overlay, or null/absent when there is none (the viewed
   * agent leads nothing, the brief has not arrived, or the read was skipped).
   * ABSENT IS NOT AN ALL-CLEAR: it means the rail has nothing extra to say, and
   * the rail must not imply the fleet was checked and found healthy.
   */
  alerts?: LeaderBriefAlertsModel | null;
  /**
   * Switch the popup to this peer. OPTIONAL: a host that cannot re-target the
   * popup (it does not own the open-agent param) passes nothing, and the rows
   * render as plain read-only entries rather than buttons that do nothing. The
   * rail degrades; it never lies about being interactive.
   */
  onSelectPeer?: (ownerId: string) => void;
  onClose: () => void;
  headerControl?: React.ReactNode;
}) {
  // Subscribed only so the rendered ages re-paint between roster pushes; the
  // ORDERING and the state words come from the model the caller derived, so this
  // never disagrees with it.
  useChatClock();

  const memberCount = model.members.length;
  const style = useMemo(
    () => (model.fleetColor ? ({ '--hud-fleet': model.fleetColor } as React.CSSProperties) : undefined),
    [model.fleetColor],
  );

  return (
    <aside className="pc-peers" aria-label={`Fleet ${model.fleetSlug}`} style={style}>
      {/* Mirrors the Orders and Activity title bars so the four columns read as
          one set rather than three plus an addition. */}
      <header className="pc-zone-title" data-testid="peers-zone-title">
        {headerControl ?? <>
        <span>Fleet</span>
        {/* "they", matching the voice the other two rails use. */}
        <span className="pc-zone-title__sub">— who they’re with</span>
        <button
          type="button"
          className="pc-zone-title__close"
          onClick={onClose}
          aria-label="Hide fleet peers"
        >
          ✕
        </button>
        </>}
      </header>

      <div className="pc-peers__head">
        <span className="pc-peers__swatch" aria-hidden="true" />
        <span className="pc-peers__slug" title={model.fleetSlug}>
          {model.fleetSlug}
        </span>
        <span className="pc-peers__count">
          {model.total} agent{model.total === 1 ? '' : 's'}
        </span>
      </div>

      {/* Present ONLY when something needs a human — the absence of this bar is
          itself information, so an all-clear fleet stays quiet. */}
      {model.warning ? (
        <div className="pc-peers__warn" data-testid="fleet-peers-warning" role="status">
          {model.warning}
        </div>
      ) : null}

      {/* Above the roster on purpose: these are fleet-WIDE findings, and several
          of them (a starved spec, a gated lane, a pause) are the REASON the rows
          below look calm. Reading the rows first and this second is how a leader
          concludes the fleet is fine. */}
      {alerts?.metrics ? <FleetMetricsBlock metrics={alerts.metrics} /> : null}
      {alerts?.fleet ? <FleetAlertsBlock fleet={alerts.fleet} /> : null}

      <div className="pc-peers__list">
        <ul className="pc-peers__group">
          <li className="pc-peers__cap" aria-hidden="true">
            <span>Leader</span>
          </li>
          {model.leader ? (
            <PeerRow
              peer={model.leader}
              alerts={alerts?.byMember[model.leader.ownerId]}
              onSelect={onSelectPeer}
            />
          ) : (
            /* Stated, never omitted: a fleet with members and no leader cannot be
               driven — nobody reclaims a dead member's claim or opens the gates
               the members are parked on. Silently rendering no Leader section
               would read as "not applicable" rather than "broken". */
            <li className="pc-peers__empty" data-testid="fleet-peers-no-leader">
              No leader — nobody is reclaiming stalled claims or opening this
              fleet’s gates.
            </li>
          )}
        </ul>

        <ul className="pc-peers__group">
          <li className="pc-peers__cap" aria-hidden="true">
            <span>Members</span>
            <span className="pc-peers__cap-n">{memberCount}</span>
          </li>
          {memberCount === 0 ? (
            <li className="pc-peers__empty">No other members are live right now.</li>
          ) : (
            model.members.map((p) => (
              <PeerRow
                key={p.ownerId}
                peer={p}
                alerts={alerts?.byMember[p.ownerId]}
                onSelect={onSelectPeer}
              />
            ))
          )}
        </ul>
      </div>
    </aside>
  );
}
