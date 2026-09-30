'use client';

/**
 * AgentOrders — the LEFT panel of the session popup's two-panel dossier
 * (session-chat-popup-direction-d-2026-08-02 P-014, owner ask 2026-08-02:
 * "Two panels: told on the left, did on the right").
 *
 * ── Why left, and why a separate panel at all ───────────────────────────────
 * With Orders on the left the three columns read in CAUSAL order: what the
 * agent was told → the conversation → what the agent did. The right rail
 * (AgentDossier) is behaviour; this one is the instructions that produced it.
 * They also change at completely different rates — orders shift when a mode
 * flips or a fact is asserted (minutes to days), activity shifts every turn —
 * and mixing those two cadences in one column is what made the original rail
 * read as a wall of text.
 *
 * ── The content rule (owner ask, verbatim) ──────────────────────────────────
 * "EVERYTHIGN that could be returnied from orient/the carry brief that you
 * showed me were missing from the panel should be in the panel. So make a spot
 * for all these things." Every field the orient/carry-brief diff identified has
 * a section here, including the ones that are usually empty — an empty section
 * that NAMES what it would hold is how a reader learns the signal exists.
 *
 * ── Three states, never two (plan D-003) ────────────────────────────────────
 * "The read failed", "genuinely none", and "the agent never wrote one" are
 * three different conclusions about an agent's health. `unavailable` carries
 * the first, `neverWritten` the third, and neither is allowed to render as the
 * plain empty state. This is the `unavailableSignals` lesson
 * (EI-18694403367371331) applied to a whole panel.
 *
 * ── Staleness is rendered, not buried ───────────────────────────────────────
 * The carry data model carries three fields that exist purely to DATE it, plus
 * the cited-ref drift tell. A checkpoint written a dozen turns ago is close to
 * worthless, so its age renders at the same weight as its content — and its
 * severity is graded against the agent's carry mode, because for a COLD agent
 * the checkpoint IS its memory across wakes.
 */

import { useMemo } from 'react';
import {
  carryStaleness,
  formatAgeShort,
  useAgentOrders,
  type AgentOrders as AgentOrdersDTO,
  type AgentOrdersSignalKey,
} from './use-agent-orders';
import { RailCluster, RailQuiet, RailSectionHead, useRailCollapse } from './rail-sections';
import { Disclosures, FACTS_DISCLOSURE_KEYS, READ_DISCLOSURE_KEYS } from './Disclosures';
import './AgentOrders.css';

/** A section that could not be read, rendered so it can never be mistaken for
 *  an empty one. */
function Unavailable({ what }: { what: string }): React.JSX.Element {
  return (
    <div className="pc-orders__unavailable" data-testid="orders-unavailable">
      ⚠ couldn’t read {what} — this is not “none”
    </div>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <div className="pc-orders__empty">{text}</div>;
}

/** Age chip whose tone is graded against the agent's carry mode. */
function AgeChip({
  atMs,
  mode,
  nowMs,
}: {
  atMs: number | null | undefined;
  mode: 'warm' | 'cold' | null;
  nowMs: number;
}): React.JSX.Element | null {
  if (atMs == null) return null;
  const age = nowMs - atMs;
  const verdict = carryStaleness(age, mode);
  const label = formatAgeShort(age);
  if (!label) return null;
  return (
    <span className={`pc-orders__age pc-orders__age--${verdict}`} data-verdict={verdict}>
      {label}
    </span>
  );
}

export interface AgentOrdersProps {
  ownerId: string;
  /** False while the panel is collapsed — skips the fetch entirely. */
  enabled?: boolean;
  /**
   * The caller's roster/session lookup could not find this owner. `false` is
   * deliberately distinct from an omitted value: an omitted value preserves
   * the standalone /adv consumer's existing query behaviour, while `false`
   * prevents a default mission from being presented for an id that has no
   * recorded agent behind it.
   */
  ownerKnown?: boolean;
  onClose?: () => void;
  headerControl?: React.ReactNode;
}

export default function AgentOrders({
  ownerId,
  enabled = true,
  ownerKnown,
  onClose,
  headerControl,
}: AgentOrdersProps): React.JSX.Element {
  const unknownOwner = ownerKnown === false;
  const { orders, error, loading } = useAgentOrders(ownerId || null, enabled && !unknownOwner);
  const nowMs = useMemo(() => Date.now(), []);
  /* Collapse state lives in the URL, shared with the Activity rail — see
     rail-sections.tsx for why one param and why not useState. */
  const rail = useRailCollapse();

  const unavailable = useMemo(
    () => new Set<AgentOrdersSignalKey>(orders?.unavailable ?? []),
    [orders?.unavailable],
  );

  const carry = orders?.carry ?? null;
  const carryMode = carry?.mode ?? null;

  return (
    <aside className="pc-orders" aria-label="Agent orders" data-testid="agent-orders">
      {/* The ZONE title (owner-approved Framed look, artifact 6379bb65): a
          vertical zone is tall and narrow, so a full-width filled bar across its
          top costs nothing you care about — unlike the three horizontal bands,
          which are named by an inline cap inside their existing row. It is
          sticky, so the column never scrolls away from its own name. */}
      <header className="pc-orders__tag pc-zone-title">
        {headerControl ?? <>
        <span className="pc-orders__tag-name">Orders</span>
        {/* "they", not "it" [owner 2026-08-02]: an agent is referred to as a
            person throughout this UI, and the singular they keeps that voice
            without gendering a session. */}
        <span className="pc-orders__tag-sub pc-zone-title__sub">— what they were told</span>
        {onClose ? (
          <button
            type="button"
            className="pc-orders__close pc-zone-title__close"
            onClick={onClose}
            aria-label="Hide orders panel"
            data-testid="agent-orders-close"
          >
            ✕
          </button>
        ) : null}
        </>}
      </header>

      {/* The whole payload is new on the wire (see use-agent-orders.ts): an
          operator predating it serves nothing, which must read as "this
          operator can't answer", never as "the agent has no orders". */}
      {unknownOwner ? (
        <div className="pc-orders__sec" data-testid="orders-owner-unknown">
          <Empty text="No agent with this id was found in the current roster or session history." />
        </div>
      ) : null}
      {!unknownOwner && !orders && !loading ? (
        <div className="pc-orders__sec">
          <Unavailable what={error ? `orders (${error})` : 'orders from this operator'} />
        </div>
      ) : null}
      {!unknownOwner && !orders && loading ? (
        <div className="pc-orders__sec">
          <Empty text="Loading orders…" />
        </div>
      ) : null}

      {!unknownOwner && orders ? (
        <>
          {/* Two clusters, not six peers (P-005 / Treatment C3). The split is
              the same one that justified splitting Orders from Activity in the
              first place: instructions the agent RECEIVED change on the scale of
              minutes-to-days, while what it is CARRYING is state it wrote itself
              and that goes stale. Grouping them says which of the two a reader
              is looking at without adding a single pixel of fill or stroke. */}
          <RailCluster label="What they were told" />

          {/* ── Mission: the section that explains every other section ── */}
          <section
            className="pc-orders__sec pc-orders__sec--mission"
            id="pc-orders-mission"
            data-collapsed={rail.closed('o-mission') ? 'true' : 'false'}
          >
            <RailSectionHead
              sectionId="o-mission"
              label="Mission"
              className="pc-orders__h"
              closed={rail.closed('o-mission')}
              onToggle={() => rail.toggle('o-mission')}
            />
            {unavailable.has('mission') ? (
              <Unavailable what="the instruction precedence" />
            ) : orders.mission ? (
              <>
                <div className="pc-orders__kv">
                  <span className="k">effective</span>
                  <span className="v">{orders.mission.constraint ?? '—'}</span>
                </div>
                <div className="pc-orders__kv">
                  <span className="k">authority</span>
                  <span
                    className="v"
                    data-authority={orders.mission.authority ?? undefined}
                  >
                    {orders.mission.authority ?? '—'}
                  </span>
                </div>
                <div className="pc-orders__kv">
                  <span className="k">route</span>
                  <span className="v">{orders.mission.route ?? '—'}</span>
                </div>
                {orders.mission.explanation ? (
                  <p className="pc-orders__note">{orders.mission.explanation}</p>
                ) : null}
                {/* Nothing else in the UI can answer "why is this agent
                    ignoring that rule?" — a suppressed rule looks identical to
                    a disobeyed one until you can see the suppression. */}
                {(orders.mission.suppressed ?? []).length > 0 ? (
                  <div className="pc-orders__suppressed" data-testid="orders-suppressed">
                    {(orders.mission.suppressed ?? []).map((s, i) => (
                      <div className="pc-orders__row" key={`${s.key}:${s.value}:${i}`}>
                        <span className="pc-orders__glyph pc-orders__glyph--off">◇</span>
                        <span className="pc-orders__txt" title={s.reason}>
                          suppressed: {s.value}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <Empty text="No resolved mission on record." />
            )}
          </section>

          {/* ── Modes + wake mode ── */}
          <section
            className="pc-orders__sec"
            id="pc-orders-modes"
            data-collapsed={rail.closed('o-modes') ? 'true' : 'false'}
          >
            <RailSectionHead
              sectionId="o-modes"
              label="Modes"
              className="pc-orders__h"
              closed={rail.closed('o-modes')}
              onToggle={() => rail.toggle('o-modes')}
            >
              {(orders.modes ?? []).length > 0 ? (
                <span className="pc-orders__n">{(orders.modes ?? []).length}</span>
              ) : null}
            </RailSectionHead>
            {unavailable.has('modes') ? (
              <Unavailable what="the mode registry" />
            ) : (orders.modes ?? []).length > 0 ? (
              (orders.modes ?? []).map((m) => (
                <div className="pc-orders__row" key={m.mode}>
                  <span
                    className={`pc-orders__glyph ${m.ownerDirected ? 'pc-orders__glyph--owner' : ''}`}
                    title={m.ownerDirected ? 'owner-directed' : 'set by the agent itself'}
                  >
                    ◆
                  </span>
                  <span className="pc-orders__txt">
                    <b>{m.mode.toUpperCase()}</b>
                    {m.ownerDirected ? (
                      <span className="pc-orders__badge">owner</span>
                    ) : m.setBy ? (
                      <span className="pc-orders__badge pc-orders__badge--self">self</span>
                    ) : null}
                    {m.reason ? <span className="pc-orders__reason">{m.reason}</span> : null}
                  </span>
                </div>
              ))
            ) : (
              <Empty text="No modes registered — default posture." />
            )}

            {/* Wake mode is here because it is an instruction ABOUT the agent,
                and because it is load-bearing for the composer directly above:
                a manual-mode agent has every wake STAGED, so a message sent
                from this popup is a silent no-op reported as "Sent". */}
            {unavailable.has('wakeMode') ? (
              <Unavailable what="wake mode" />
            ) : orders.wakeMode ? (
              <div className="pc-orders__kv" data-testid="orders-wake-mode">
                <span className="k">wakes</span>
                <span className="v" data-wake={orders.wakeMode.effective}>
                  {orders.wakeMode.effective === 'manual'
                    ? 'manual — staged for you to release'
                    : 'auto — delivered immediately'}
                  {orders.wakeMode.overridden ? (
                    <span className="pc-orders__badge">override</span>
                  ) : null}
                </span>
              </div>
            ) : null}
          </section>

          {/* ── Owner directives, verbatim ──
              Settled (nothing open) it is one dim line, not a bordered card with
              "No open owner directives." sitting in it — the quiet-empty rule.
              The card comes back the instant something is open, and that is the
              point: the frame is what says "there is something here". */}
          {(orders.directives ?? []).length === 0 && (orders.directivesTotalOpen ?? 0) === 0 ? (
            <RailQuiet label="Owner directives" none="none open" testId="rail-quiet-directives" />
          ) : (
          <section
            className="pc-orders__sec"
            id="pc-orders-directives"
            data-collapsed={rail.closed('o-directives') ? 'true' : 'false'}
            /* An open owner directive is the one thing in this rail that is
               waiting on a HUMAN, so the card is toned like the Walls card
               rather than sitting in the same grey as the rest. */
            data-attn={(orders.directivesTotalOpen ?? 0) > 0 ? 'true' : undefined}
          >
            <RailSectionHead
              sectionId="o-directives"
              label="Owner directives"
              className="pc-orders__h"
              closed={rail.closed('o-directives')}
              onToggle={() => rail.toggle('o-directives')}
            >
              {(orders.directivesTotalOpen ?? 0) > 0 ? (
                <span className="pc-orders__n pc-orders__n--hot">
                  {orders.directivesTotalOpen}
                </span>
              ) : null}
            </RailSectionHead>
            {(orders.directives ?? []).length > 0 ? (
              <>
                {(orders.directives ?? []).map((d) => (
                  <blockquote className="pc-orders__verbatim" key={d.id}>
                    {d.verbatimText}
                    <cite className="pc-orders__cite">
                      {formatAgeShort(nowMs - d.createdAtMs) ?? ''}
                      {d.dispositionStatus ? ` · ${d.dispositionStatus}` : ' · open'}
                    </cite>
                    {/* P-010 — WHERE THIS QUOTE CAME FROM. Both fields have been
                        on the DTO since it was written and neither reached the
                        screen, so every directive rendered with exactly the
                        authority of every other one.

                        That is the failure this line exists to make visible.
                        `orders:record` sets `sourceTurnRef` ONLY when
                        `resolveRelayProvenance` matched the verbatim text to an
                        owner-verified turn in the recording agent's own
                        transcript; otherwise it is null and the stamp stays
                        'unverified'. `recordedBy` is the AGENT that filed it,
                        never the author — so an unanchored quote is one an
                        agent attributed to the owner with nothing behind it,
                        which is precisely the shape WI-3532 traced: an agent's
                        own note-to-self promoted, compaction by compaction,
                        into "the owner said".

                        THE ABSENT CASE IS THE FINDING, so — unlike a missing
                        DURATION under D-010 §1 — it renders LOUDLY rather than
                        as nothing. A duration we could not compute is a
                        measurement nobody took; an unanchored directive is a
                        PROPERTY of the record itself. Saying nothing here would
                        leave it looking identical to a verified one, which is
                        the status quo this replaces.

                        And it is a provenance report, never an accusation:
                        "unverified" says the anchor is missing, not that the
                        quote is false. Most legitimately predate the stamp. */}
                    <div
                      className="pc-orders__prov"
                      data-verified={d.sourceTurnRef ? 'true' : 'false'}
                      data-testid="orders-directive-provenance"
                      title={
                        d.sourceTurnRef
                          ? `Matched to an owner turn in the recording agent's transcript: ${d.sourceTurnRef}`
                          : 'No owner turn was matched to this text. It may still be genuine — a directive recorded before the provenance stamp existed, or relayed from elsewhere — but nothing here proves it. Verify with sessions:search before treating it as an owner order.'
                      }
                    >
                      recorded by {d.recordedBy}
                      <span className="pc-orders__sep" aria-hidden="true"> · </span>
                      {d.sourceTurnRef ? (
                        <>
                          <span className="pc-orders__prov-mark">✓ owner turn</span>{' '}
                          <span className="pc-orders__prov-ref">{d.sourceTurnRef}</span>
                        </>
                      ) : (
                        <span className="pc-orders__prov-mark">no source turn on record</span>
                      )}
                    </div>
                  </blockquote>
                ))}
                {(orders.directivesTotalOpen ?? 0) > (orders.directives ?? []).length ? (
                  <div className="pc-orders__empty">
                    showing {(orders.directives ?? []).length} of {orders.directivesTotalOpen}
                  </div>
                ) : null}
              </>
            ) : (
              <Empty text="No open owner directives." />
            )}
          </section>
          )}

          {/* ── Standing facts ── */}
          {/* P-005: the facts disclosures sit OUTSIDE both branches, because the
              branch that needs them most is the QUIET one. "none in scope" is a
              lie when the fold ran narrowed — the agent was never shown its
              facts, so their absence is not evidence that none stand, and
              RailQuiet's own contract ("I don't know must never be quieter than
              nothing") is the same distinction one state over. */}
          {(orders.facts ?? []).length === 0 ? (
            <RailQuiet label="Standing facts" none="none in scope" testId="rail-quiet-facts" />
          ) : (
          <section
            className="pc-orders__sec"
            id="pc-orders-facts"
            data-collapsed={rail.closed('o-facts') ? 'true' : 'false'}
          >
            <RailSectionHead
              sectionId="o-facts"
              label="Standing facts"
              className="pc-orders__h"
              closed={rail.closed('o-facts')}
              onToggle={() => rail.toggle('o-facts')}
            >
              {(orders.facts ?? []).length > 0 ? (
                <span className="pc-orders__n">{(orders.facts ?? []).length}</span>
              ) : null}
            </RailSectionHead>
            {(orders.facts ?? []).length > 0 ? (
              (orders.facts ?? []).map((f) => (
                <div className="pc-orders__row" key={f.key}>
                  <span className="pc-orders__glyph pc-orders__glyph--fact">§</span>
                  <span className="pc-orders__txt" title={f.key}>
                    {f.body}
                    {f.possiblyStale ? (
                      <span className="pc-orders__badge pc-orders__badge--warn">
                        source drifted
                      </span>
                    ) : null}
                    {/* P-011 — BESIDE "source drifted", never instead of it.
                        The two answer different questions and a fact can carry
                        both: `possiblyStale` says this fact's own source moved
                        underneath it (go re-read the source), `contested` says
                        other agents already wrote to this key or settled it
                        UNDECIDABLE (go read the argument). Merging them into one
                        "suspect" badge would tell the reader something is wrong
                        while hiding which thing to go do about it.

                        MARK, NEVER SUPPRESS — the house rule for this whole
                        family. A contested fact is not a false fact: re-asserting
                        over a settled key is sometimes exactly right, and only
                        the reader can tell. So the fact renders in full and the
                        badge sits next to it.

                        `settledUndecidable` gets its OWN word because it is the
                        strongest case in the family: someone already worked the
                        question and concluded it could not be settled with what
                        they had. An agent who reads "contested" may go argue; one
                        who reads "settled undecidable" knows to go find the
                        `settledBy` evidence instead. */}
                    {f.contested ? (
                      <span
                        className="pc-orders__badge pc-orders__badge--warn"
                        data-testid="orders-fact-contested"
                        data-undecidable={f.contested.settledUndecidable ? 'true' : undefined}
                        title={
                          f.contested.note ||
                          'Other agents have already written to this key. Read the version history before re-asserting.'
                        }
                      >
                        {f.contested.settledUndecidable ? 'settled undecidable' : 'contested'}
                        {(f.contested.priorAuthors?.length ?? 0) > 0
                          ? ` · ${f.contested.priorAuthors!.length} prior author${
                              f.contested.priorAuthors!.length === 1 ? '' : 's'
                            }`
                          : ''}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))
            ) : (
              <Empty text="No standing facts in scope." />
            )}
          </section>
          )}
          <Disclosures
            recorded={orders.disclosures}
            keys={FACTS_DISCLOSURE_KEYS}
            testId="disclosures-facts"
          />

          {/* ── What its last orient left out ──
              The other three markers qualify reads that have no section of their
              own in this rail (the claimable backlog, announced gates, recipes).
              They get one shared line rather than three bespoke ones, and they
              render only when the agent's own orient actually cut something. */}
          <Disclosures
            recorded={orders.disclosures}
            keys={READ_DISCLOSURE_KEYS}
            testId="disclosures-reads"
          />

          {/* ── Turn-start obligations, verbatim (P-018) ──
              THE SAME OBJECT turn-start rendered, not a second assembly of it.
              `obligationRows` is `projectOrientationRows(state, 'agent-orders')`
              from packages/operator-core/lib/turn-start-orientation.ts — the one
              projection `renderOrientationLines` now delegates to — so this
              section and the agent's own turn-start block cannot disagree about
              "what was this agent told". Every section above decomposes a single
              class richly; this one is the ground truth they decompose.

              Rendered at the agent-orders sink with `committed: null`, so an
              OBSERVER sees the full standing set rather than the delta-suppressed
              subset the agent itself saw this turn — deliberately MORE than
              turn-start showed, which is exactly the latitude the item grants
              ("the HUD may render more"). It is never LESS, and never different.

              Absent/null ⇒ no projection was read (an operator predating the
              field, or the read threw and landed in `unavailable`) — which must
              read as "we can't answer", never as "they were told nothing". An
              empty ARRAY is the real "nothing standing" and is the quiet line. */}
          {unavailable.has('obligationRows') ? (
            <section className="pc-orders__sec" id="pc-orders-obligations">
              <Unavailable what="the turn-start obligations" />
            </section>
          ) : (orders.obligationRows ?? []).length === 0 ? (
            <RailQuiet
              label="Turn-start obligations"
              none={orders.obligationRows ? 'nothing standing' : 'not recorded'}
              testId="rail-quiet-obligations"
            />
          ) : (
          <section
            className="pc-orders__sec"
            id="pc-orders-obligations"
            data-collapsed={rail.closed('o-obligations') ? 'true' : 'false'}
          >
            <RailSectionHead
              sectionId="o-obligations"
              label="Turn-start obligations"
              className="pc-orders__h"
              closed={rail.closed('o-obligations')}
              onToggle={() => rail.toggle('o-obligations')}
            >
              <span className="pc-orders__n">{(orders.obligationRows ?? []).length}</span>
            </RailSectionHead>
            {(orders.obligationRows ?? []).map((row, i) => (
              /* classId+order is the projection's own identity, but it is not
                 guaranteed unique across a re-projection, so `i` disambiguates
                 rather than risking the duplicate-key crash the perf docs call
                 out. The row's CLASS is surfaced as a data attribute, not a
                 badge: an observer cross-checking a line against the section
                 that decomposes it needs to know which class emitted it. */
              <div
                className="pc-orders__row"
                key={`${row.classId}:${row.order}:${i}`}
                data-class-id={row.classId}
                data-testid="orders-obligation-row"
              >
                <span className="pc-orders__txt">{row.text}</span>
              </div>
            ))}
          </section>
          )}

          <RailCluster label="What they’re carrying" />

          {/* ── Walls: blocked on the owner ── */}
          {(orders.walls ?? []).length === 0 ? (
            <RailQuiet label="Walls" none="nothing blocked on you" testId="rail-quiet-walls" />
          ) : (
          <section
            className="pc-orders__sec"
            id="pc-orders-walls"
            data-collapsed={rail.closed('o-walls') ? 'true' : 'false'}
            /* A wall is something blocked on the READER. It is the only card in
               this rail that is addressed to them, so it wears the warn tone. */
            data-attn={(orders.walls ?? []).length > 0 ? 'true' : undefined}
          >
            <RailSectionHead
              sectionId="o-walls"
              label="Walls"
              className="pc-orders__h"
              closed={rail.closed('o-walls')}
              onToggle={() => rail.toggle('o-walls')}
            >
              {(orders.walls ?? []).length > 0 ? (
                <span className="pc-orders__n pc-orders__n--hot">
                  {(orders.walls ?? []).length}
                </span>
              ) : null}
            </RailSectionHead>
            {(orders.walls ?? []).length > 0 ? (
              (orders.walls ?? []).map((w, i) => (
                <div className="pc-orders__wall" key={`${w.claim}:${i}`}>
                  <span className="pc-orders__wall-ask">{w.claim}</span>
                  <span className="pc-orders__wall-meta">
                    {w.sinceMs ? `waiting ${formatAgeShort(nowMs - w.sinceMs) ?? ''}` : 'waiting'}
                    {w.recheck ? ` · recheck: ${w.recheck}` : ''}
                  </span>
                </div>
              ))
            ) : (
              <Empty text="Nothing blocked on you." />
            )}
          </section>
          )}

          {/* ── Carry: what it is tracking, and how old that is ──
              Quiet ONLY for the genuinely-none case. `unavailable` keeps its
              card because "couldn't read it" must never render quieter than
              "nothing" (plan D-003), and so does `neverWritten`, which is an
              emptiness that is itself the finding — an agent looping with no
              carry-note loses its thread at the next cold wake. Both are
              handled inside the card below; only a wholly absent carry object
              reaches this branch. */}
          {!unavailable.has('carry') && !carry ? (
            <RailQuiet label="Carry" none="no carry state" testId="rail-quiet-carry" />
          ) : (
          <section
            className="pc-orders__sec"
            id="pc-orders-carry"
            data-collapsed={rail.closed('o-carry') ? 'true' : 'false'}
          >
            <RailSectionHead
              sectionId="o-carry"
              label="Carry"
              className="pc-orders__h"
              closed={rail.closed('o-carry')}
              onToggle={() => rail.toggle('o-carry')}
            >
              {carryMode ? (
                <span
                  className="pc-orders__n"
                  title={
                    carryMode === 'cold'
                      ? 'Cold carry: every wake rebuilds from the checkpoint, so the checkpoint is this agent’s only memory.'
                      : 'Warm carry: each wake resumes the live context.'
                  }
                >
                  {carryMode}
                </span>
              ) : null}
            </RailSectionHead>
            {unavailable.has('carry') ? (
              <Unavailable what="the carry brief" />
            ) : carry ? (
              <>
                <div className="pc-orders__kv">
                  <span className="k">loop</span>
                  <span className="v">
                    {carry.loopActive
                      ? `armed${carry.loopIntervalSec ? ` · every ${carry.loopIntervalSec}s` : ''}`
                      : 'not armed'}
                  </span>
                </div>

                {/* neverWritten is a FINDING about the agent, not a gap in our
                    data — an agent running a loop with no carry-note loses its
                    thread at the next cold wake. Say so plainly. */}
                {carry.neverWritten ? (
                  <div className="pc-orders__empty" data-testid="orders-carry-never">
                    No carry-note ever written{carry.loopActive ? ' — a cold wake would start blank' : ''}.
                  </div>
                ) : (
                  <>
                    <div className="pc-orders__sub">
                      carry-note
                      <AgeChip atMs={carry.noteUpdatedAtMs} mode={carryMode} nowMs={nowMs} />
                    </div>
                    <blockquote className="pc-orders__verbatim pc-orders__verbatim--note">
                      {carry.note}
                    </blockquote>
                  </>
                )}

                {(carry.heldItems ?? []).length > 0 ? (
                  <>
                    <div className="pc-orders__sub">checkpoints</div>
                    {(carry.heldItems ?? []).map((h) => (
                      <div className="pc-orders__row" key={h.id}>
                        <span className="pc-orders__glyph">▪</span>
                        <span className="pc-orders__txt">
                          <b>{h.id}</b>
                          {h.checkpoint ? (
                            <span className="pc-orders__reason">{h.checkpoint}</span>
                          ) : (
                            <span className="pc-orders__reason pc-orders__reason--none">
                              never checkpointed
                            </span>
                          )}
                        </span>
                        <AgeChip atMs={h.checkpointUpdatedAtMs} mode={carryMode} nowMs={nowMs} />
                      </div>
                    ))}
                  </>
                ) : null}

                {/* The #1 stale-conclusion tell, per carry-brief.ts itself. */}
                {(carry.citedRefsTerminal ?? []).length > 0 ? (
                  <div className="pc-orders__drift" data-testid="orders-cited-drift">
                    ⚠ cited and since changed: {(carry.citedRefsTerminal ?? []).join(', ')}
                  </div>
                ) : null}

                {carry.postNoteInbox && carry.postNoteInbox.count > 0 ? (
                  <div className="pc-orders__kv">
                    <span className="k">since note</span>
                    <span className="v">
                      {carry.postNoteInbox.count} directed message
                      {carry.postNoteInbox.count === 1 ? '' : 's'} — the note predates them
                    </span>
                  </div>
                ) : null}

                {(carry.checks ?? []).length > 0 ? (
                  <>
                    <div className="pc-orders__sub">checks</div>
                    {(carry.checks ?? []).map((c, i) => (
                      <div className="pc-orders__row" key={`${c.claim}:${i}`}>
                        <span
                          className={`pc-orders__glyph ${c.verified ? 'pc-orders__glyph--ok' : ''}`}
                          title={c.verified ? 'verified' : 'predicted — not yet confirmed'}
                        >
                          {c.verified ? '✓' : '?'}
                        </span>
                        <span className="pc-orders__txt">
                          {c.claim}
                          {c.recheck ? (
                            <span className="pc-orders__reason">probe: {c.recheck}</span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}

                {(carry.awaits ?? []).length > 0 ? (
                  <>
                    <div className="pc-orders__sub">awaits that survive a respawn</div>
                    {(carry.awaits ?? []).map((a) => (
                      <div className="pc-orders__row" key={a.eventKey}>
                        <span className="pc-orders__glyph">◉</span>
                        <span className="pc-orders__txt" title={a.note ?? undefined}>
                          {a.eventKey}
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              <Empty text="No carry state." />
            )}
          </section>
          )}
        </>
      ) : null}
    </aside>
  );
}
