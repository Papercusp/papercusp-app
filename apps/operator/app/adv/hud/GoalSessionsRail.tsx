'use client';

/**
 * GoalSessionsRail — the goal popup's SESSIONS zone.
 *
 * [owner 2026-08-10] approved the mockup with two changes: "just put the pane on
 * the right side, to the left of the 'WORK — what sits under this goal' pane",
 * and "when you implement the design mimic the design of the fleet leader/fleet
 * member pane in the conversation popup equivalent in the sessions tab".
 *
 * So this file deliberately borrows FleetPeersRail's markup vocabulary rather
 * than inventing a second one — the same `pc-peers` / `pc-peer` classes, the
 * same two-line row (identity above, state below), the same role glyph, and the
 * same COLUMN_WORD state words, IMPORTED from that file so the two rails cannot
 * drift into describing the same agent with different words.
 *
 * PRESENTATIONAL ONLY. Every rule about membership, grouping, ordering and
 * classification lives in the pure, unit-tested `goal-sessions.ts`, exactly as
 * FleetPeersRail defers to `fleet-peers.ts`.
 *
 * ── Why empty sections still render ─────────────────────────────────────────
 * The Work rail hides its empty sections; this one must not. The five types are
 * the goal's COVERAGE MODEL, so a goal with no drain fleet and no test agent is
 * reporting a gap — and a hidden section would make "no drain fleet" read as
 * "no drain section exists", which is the opposite of a finding.
 */
import { Tooltip } from '../../harness/Tooltip';
import FleetRoleGlyph from '../../_components/FleetRoleGlyph';
import { COLUMN_WORD } from '../../_components/chat/FleetPeersRail';
import { useChatClock } from '../../_components/chat/message-timestamp';
import { formatAge } from './hud-board-model';
import type { GoalSessionRow, GoalSessionsModel } from './goal-sessions';

function SessionRow({
  row,
  isMember,
  onSelect,
}: {
  row: GoalSessionRow;
  /** Renders the nesting elbow. Members indent under their lead rather than
   *  getting their own heading — the lead is the addressable thing, and a flat
   *  list loses which member belongs to which fleet once a goal runs two. */
  isMember: boolean;
  /** Absent ⇒ render read-only. A row that looks clickable and is not is worse
   *  than one that plainly is not — FleetPeersRail's own rule. */
  onSelect?: (ownerId: string) => void;
}) {
  const age = formatAge(row.sinceSec);

  const body = (
    <>
      <span className="pc-peer__r1">
        <span className="pc-peer__dot" data-col={row.column} aria-hidden="true" />
        <FleetRoleGlyph role={row.isLead ? 'leader' : 'member'} className="pc-peer__glyph" />
        <span className="pc-peer__handle">{row.handle}</span>
        {/* NO `cup` pane-kind badge here, deliberately — FleetPeersRail has one
            and this rail otherwise mimics it line for line.

            The Mug/Kettle/cup nursery tier is RETIRED (`papercusp-mug-kettle-
            system`, default-OFF *is* the delivered end state; `cup:spawn`
            refuses), so nothing can create a cup any more. A brand-new surface
            that renders a badge for it propagates a retired concept into code
            written after its retirement — and it read to the mug/kettle surface
            guard as a new ungated entry point, which is the correct reading of
            a new file naming that surface even though this was only ever a
            display badge. The honest fix is not to baseline the entry or to
            argue the guard down: it is to not ship the retired concept.

            Historical rows can still carry agentPaneKind 'cup'; they render as
            ordinary sessions, which is what they are. */}
        {row.contextPct != null ? (
          /* null is NOT 0 — an unmeasured context rendered as 0% reads as
             "plenty of room left", so an unsampled session shows nothing. */
          <span className="pc-peer__ctx" data-hot={row.contextPct >= 60 ? 'true' : undefined}>
            {row.contextPct}%
          </span>
        ) : null}
      </span>
      <span className="pc-peer__r2">
        <span className="pc-peer__state" data-col={row.column}>
          {/* An ended session says so IN WORDS, ahead of its last state.
              `column` is the state it STOPPED in, kept deliberately as history
              (a test agent that ended while `working` is evidence the testing
              ran) — but rendered alone it claims the agent is working now, on a
              rail whose heading asks exactly that. The CSS greys the dot too;
              this text is the cue that survives a colour-blind reader, a
              high-contrast theme, or a screen reader, none of which can see the
              dot change. Matches SessionChatModal, which spells the terminal
              state out rather than tinting it. */}
          {row.ended ? <>ended&nbsp;· </> : null}
          {COLUMN_WORD[row.column]}
          {age ? ` ${age}` : ''}
        </span>
        {row.intent ? <span className="pc-peer__intent"> · {row.intent}</span> : null}
      </span>
    </>
  );

  /* On the <li> in BOTH branches, never on the inner button. A row that is a
     button and a row that is not are different ELEMENTS, so hanging the test
     hooks on the inner one would make `[data-testid=goal-session-row]` select a
     <button> here and an <li> there — and any selector combining it with
     `[data-member]` would then silently match nothing in one of the two
     states. The wrapper is the row; what is inside it is a rendering detail. */
  const common = {
    'data-testid': 'goal-session-row',
    'data-owner': row.ownerId,
    'data-member': isMember ? 'true' : undefined,
    /* Ended sessions are KEPT and marked rather than dropped — a finished test
       agent is evidence the testing happened. The mark is an attribute so the
       styling stays in CSS and the row keeps the board's own state word. */
    'data-ended': row.ended ? 'true' : undefined,
    className: isMember ? 'pc-peers__nest' : undefined,
  } as const;

  if (!onSelect) {
    return (
      <li {...common} title={row.reason}>
        <span className="pc-peer">{body}</span>
      </li>
    );
  }

  return (
    <li {...common}>
      {/* The shared Tooltip primitive, NOT a `title=` attribute — a native title
          is unreachable by keyboard and on touch, and `lint:design-primitives`
          fails a title on a <button> for exactly that reason.

          `side="left"` because this rail sits at the popup's right edge; a
          tooltip opening right would render off the window. */}
      <Tooltip label={row.reason} side="left">
        <button
          type="button"
          className="pc-peer pc-peer--btn"
          onClick={() => onSelect(row.ownerId)}
          /* Spells out the DESTINATION: the visible row is a handle and a state
             word, neither of which says that pressing it opens a conversation. */
          aria-label={`Open ${row.handle}'s conversation — ${row.reason}`}
        >
          {body}
        </button>
      </Tooltip>
    </li>
  );
}

export default function GoalSessionsRail({
  model,
  onSelectSession,
  onClose,
}: {
  model: GoalSessionsModel;
  /** Switch the popup to this session. OPTIONAL: a host that cannot re-target
   *  passes nothing and the rows render read-only rather than as buttons that
   *  do nothing. The rail degrades; it never lies about being interactive. */
  onSelectSession?: (ownerId: string) => void;
  onClose: () => void;
}) {
  // Subscribed only so the rendered ages re-paint between roster pushes; the
  // ORDERING and the state words come from the derived model, so this can never
  // disagree with it.
  useChatClock();

  return (
    <aside className="pc-peers" aria-label="Sessions working on this goal">
      {/* Mirrors the Work rail's title bar so the two goal zones read as one set
          rather than one plus an imitation. */}
      <header className="pc-zone-title" data-testid="goal-sessions-zone-title">
        <span>Sessions</span>
        <span className="pc-zone-title__sub">— who’s working on it</span>
        <button
          type="button"
          className="pc-zone-title__close"
          onClick={onClose}
          aria-label="Hide sessions"
        >
          ✕
        </button>
      </header>

      <div className="pc-peers__head">
        <span className="pc-peers__count">
          {model.total} session{model.total === 1 ? '' : 's'}
        </span>
      </div>

      <div className="pc-peers__list">
        {model.sections.map((s) => (
          <ul className="pc-peers__group" key={s.id} data-section={s.id}>
            <li className="pc-peers__cap" aria-hidden="true" data-muted={s.count === 0 ? 'true' : undefined}>
              <span>{s.caption}</span>
              <span className="pc-peers__cap-n">{s.count}</span>
            </li>
            {s.count === 0 ? (
              <li className="pc-peers__empty" data-testid="goal-sessions-empty">
                {s.emptyLine}
              </li>
            ) : (
              /* Each lead is IMMEDIATELY followed by its own members. Rendering
                 every lead and then every member — which is what a `.map` per
                 role would do — reads fine with one fleet and silently reparents
                 the members the moment a goal runs two. */
              s.groups.flatMap((g) => [
                <SessionRow
                  key={g.lead.ownerId}
                  row={g.lead}
                  isMember={false}
                  onSelect={onSelectSession}
                />,
                ...g.members.map((m) => (
                  <SessionRow key={m.ownerId} row={m} isMember onSelect={onSelectSession} />
                )),
              ])
            )}
          </ul>
        ))}
      </div>
    </aside>
  );
}
