'use client';

/**
 * PotHealthPane — the full-height view that REPLACES the chat body while the
 * header Pot Health toggle is on.
 *
 * REBUILT for the su-only era (retire-mug-kettle-su-only-2026-08-09, P-018..P-021,
 * design ratified as that plan's D-032). The previous pane answered "what do the
 * Mug and Kettle each decide from" — two sections mirroring two minds that no
 * longer run. It now answers the three questions that survive them:
 *
 *   🎯 GOALS      — what the pot is POINTED AT: each goal's kill criterion, its
 *                   tripwire bars, and its spend against ceiling.
 *   📈 THROUGHPUT — is it WORKING, and what needs the owner.
 *   👥 SU AGENTS  — who is DRIVING: liveness, lane, and current intent.
 *
 * Sections are ordered by the QUESTION each answers, following the convention
 * `goal-detail-model.ts` states for the goal surfaces — not by the order the
 * resolvers happened to be written.
 *
 * ── Two rulings from D-032 that are easy to undo by accident ────────────────
 *
 * 1. LIVENESS IS `sessionState`, AND IT COMES FROM `fleet.status`. It is the
 *    ONLY sync query that exposes it (sync-resolver/index.ts:859, sole
 *    occurrence tree-wide). `dev.coordPresence` CANNOT be substituted here: it
 *    resolves to `PresenceRecord[]`, which carries `stale`/`heartbeatAt`/
 *    `lastActiveAt` and no `sessionState` at all — so a pane built on it can
 *    only derive liveness from a heartbeat, and a warm-dead session is
 *    heartbeat-fresh while `sessionState` is already 'ended'. The OLD pane made
 *    exactly that mistake (`kettleOk = live.alive`) and rendered a dead Kettle
 *    as healthy.
 *
 * 2. THE GOALS SECTION IS ONE QUERY. `goals.list` already carries kill
 *    criterion, tripwires, budget and spend per goal, so there is no reason to
 *    fan out a `goals.detail` per goal — that would be an SSE-live N+1 against
 *    a ~40-query registry and a 6-connection host cap.
 *
 * Data is reuse-first: every query here already existed, and the goal readouts
 * are computed by IMPORTING the HUD's pure derivation rather than restating it,
 * so the two surfaces cannot disagree about a burn rate or a tripwire.
 */

import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Activity, Target, Users } from 'lucide-react';
import {
  agoText,
  burnLine,
  ceilingLine,
  killCriterionLine,
  tripwireBars,
  type GoalDetailGoalInput,
} from '../adv/hud/goal-detail-model';
import { compactAge, compactCount } from './pot-health-format';

/* ── Wire shapes, narrowed to what this pane renders ──────────────────────── */

/** One row of `goals.list`. Extends the HUD's derivation input rather than
 *  redeclaring its fields, which is what makes the imported helpers directly
 *  applicable (D-032 §3: `GoalSummaryRow` is structurally assignable to it). */
interface PotGoalRow extends GoalDetailGoalInput {
  /** Real activity. Deliberately NOT `updatedAt` — see `staleness` below. */
  lastActivityAt?: string | null;
}

/** `goals.list` returns ONE envelope row, not a list of goals. */
interface GoalsEnvelope {
  goals: PotGoalRow[];
  portfolioSpendUsd: number;
  portfolioPots: number;
}

/** One agent as `fleet.status` returns it. `sessionState` is the liveness
 *  verdict from the shared presence oracle — see the header note. */
interface FleetAgentRow {
  ownerId: string;
  label: string;
  role: string | null;
  intent: string | null;
  planSlug: string | null;
  potSlug: string | null;
  fleetSlug: string | null;
  fleetRole: string | null;
  sessionState: string | null;
  lastActiveSecAgo: number | null;
}

interface WorkItemStatRow {
  kind: string;
  state: string;
  n: number;
  terminal: boolean;
}

/** `workItems.delta24h`. Fields are read defensively (`?? 0`) because this row
 *  is a per-kind rollup and a kind with no movement may omit a counter. */
interface WorkItemDeltaRow {
  kind?: string | null;
  opened?: number | null;
  closed?: number | null;
}

interface AttentionCountsRow {
  decisionItems: number;
  decisionPlans: number;
  alerts: number;
  total: number;
  /**
   * TRUE when the server's 8s attention deadline fired and these counts are its
   * graceful EMPTY fallback rather than a real answer (WI-39779 shipped the bit;
   * WI-39802 wired it in here, where dropping it from this type was what silently
   * discarded it).
   *
   * OPTIONAL on purpose, exactly as `inbox/use-inbox-pending.ts` declares it: a
   * pre-WI-39779 server omits the field, and defaulting that to `false` keeps
   * this pane reading precisely as it does today rather than flipping every
   * attention readout into the unknown state.
   */
  degraded?: boolean;
}

interface SpendRow {
  h1: { spendUsd: number; calls: number };
  h24: { spendUsd: number; calls: number };
}

/* ── Liveness ─────────────────────────────────────────────────────────────── */

type Tone = 'ok' | 'warn' | 'bad';

/**
 * `sessionState` → dot tone.
 *
 * This is a LIVENESS verdict, not one of the status/severity/kind palettes that
 * `app/harness/theme.ts` single-sources — so it is mapped to the pane's existing
 * tone CLASSES here rather than to colours, and adds no competing colour table.
 *
 * An ABSENT verdict is deliberately NOT 'ok'. The oracle having no reading is a
 * different thing from a live agent, and rendering it green is the precise
 * failure this pane was rebuilt to stop.
 */
function livenessTone(state: string | null | undefined): Tone {
  switch (state) {
    case 'live':
      return 'ok';
    case 'parked':
    case 'draining':
    case 'recorded':
      return 'warn';
    case 'suspect':
    case 'ended':
      return 'bad';
    default:
      return 'warn';
  }
}

/** The word shown beside the dot. Never invents one for a missing verdict. */
function livenessWord(state: string | null | undefined): string {
  return state == null || state === '' ? 'unknown' : state;
}

/* ── Degraded-attention vocabulary ────────────────────────────────────────────
 *
 * The `plans.attentionCounts` read has an 8s server deadline whose graceful
 * fallback is an EMPTY feed, which derives to all-zeros (WI-39779). These are
 * what the pane says INSTEAD of presenting that empty as fact.
 *
 * There are two labels because the pane's two attention readouts degrade
 * DIFFERENTLY — see `attentionDegraded` below. Keep them as text the user can
 * act on ("unavailable, not zero"), never a bare glyph: the mark alone is the
 * thing a reader most reliably interprets as "nothing". */
const ATTENTION_FLOOR_LABEL =
  'At least this many need you — the attention read timed out, so part of this count is missing';
const ATTENTION_UNKNOWN_LABEL =
  'Could not load what needs you — this count is unavailable, not zero';
/** The KV value for a PURE attention readout whose read degraded. Matches the
 *  pane's existing word for an absent reading (`livenessWord` → 'unknown'). */
const ATTENTION_UNKNOWN_TEXT = 'unknown — read timed out';

/* ── Small presentational helpers ─────────────────────────────────────────── */

/** One label → value line in a card's kv grid, with an optional liveness dot. */
function KvRow({ k, v, tone }: { k: string; v: string; tone?: Tone }) {
  return (
    <>
      <span className="op-ph-k">{k}</span>
      <span className="op-ph-v">
        {tone != null && <span className={`op-pot-dot ${tone}`} aria-hidden="true" />}
        {v}
      </span>
    </>
  );
}

/**
 * One tripwire, as a labelled bar.
 *
 * An UNMEASURED tripwire renders as an explicitly unread bar with no fill —
 * never as a zero. Zero is a reading; showing one where none was taken is the
 * failure `goal-detail-model.ts` documents at length, and it is preserved here
 * by reading `measured` rather than inferring it from `pct`.
 */
function TripwireBar({ bar }: { bar: ReturnType<typeof tripwireBars>[number] }) {
  return (
    <div className="op-ph-bar-row" title={bar.title}>
      <span className="op-ph-bar-label">{bar.label}</span>
      <span className={`op-ph-bar ${bar.tone}`}>
        {bar.pct != null && (
          <span className="op-ph-bar-fill" style={{ width: `${bar.pct}%` }} aria-hidden="true" />
        )}
      </span>
      <span className="op-ph-bar-value">{bar.valueText}</span>
      {/* A reading nobody measured must not read like one that was
          (EI-21605510614702802). Only for a reading that EXISTS — an unread bar
          already says so, and a second caveat there would be noise.

          A SIBLING of the value, not a child: `.op-ph-bar-value` is asserted on
          by textContent, and more importantly it should contain the value and
          nothing else — nesting the marker inside it makes both the assertion
          and a screen reader run "$310 of $500" and "hand-set" together. */}
      {bar.measured && !bar.derived ? <span className="op-ph-bar-handset">hand-set</span> : null}
    </div>
  );
}

/* ── The pane ─────────────────────────────────────────────────────────────── */

export function PotHealthPane() {
  const nowMs = Date.now();

  // Every query below already existed; none is new, and none is polled — the
  // pane only mounts while the toggle is on, so these unsubscribe on close.
  const goalsQ = useSyncQuery<GoalsEnvelope>({
    queryName: 'goals.list',
    args: {},
    staleTime: 30_000,
  });
  const agentsQ = useSyncQuery<FleetAgentRow>({
    queryName: 'fleet.status',
    args: {},
    staleTime: 15_000,
  });
  const statsQ = useSyncQuery<WorkItemStatRow>({
    queryName: 'workItems.stats',
    args: {},
    staleTime: 30_000,
  });
  const deltaQ = useSyncQuery<WorkItemDeltaRow>({
    queryName: 'workItems.delta24h',
    args: {},
    staleTime: 60_000,
  });
  const attentionQ = useSyncQuery<AttentionCountsRow>({
    queryName: 'plans.attentionCounts',
    args: {},
    staleTime: 30_000,
  });
  const spendQ = useSyncQuery<SpendRow>({
    queryName: 'usage.spend',
    args: {},
    staleTime: 60_000,
  });

  const goalsEnvelope = goalsQ.data?.[0];
  const goals = useMemo(
    () => (goalsEnvelope?.goals ?? []).filter((g) => g != null),
    [goalsEnvelope],
  );
  const agents = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);
  const stats = useMemo(() => statsQ.data ?? [], [statsQ.data]);
  const delta = useMemo(() => deltaQ.data ?? [], [deltaQ.data]);
  const attention = attentionQ.data?.[0];
  const spend = spendQ.data?.[0];

  const liveAgents = useMemo(
    () => agents.filter((a) => a.sessionState === 'live').length,
    [agents],
  );

  const openItems = useMemo(
    () => stats.filter((s) => !s.terminal).reduce((acc, s) => acc + s.n, 0),
    [stats],
  );

  // The accumulator is annotated explicitly: `WorkItemDeltaRow`'s counters are
  // nullable (a kind with no movement may omit one), and without the type
  // argument the reduce widens the accumulator to the nullable row shape — so
  // the sums, and every consumer of them below, inherit a null they can never
  // actually hold.
  const movement = useMemo(
    () =>
      delta.reduce<{ opened: number; closed: number }>(
        (acc, d) => ({
          opened: acc.opened + (d.opened ?? 0),
          closed: acc.closed + (d.closed ?? 0),
        }),
        { opened: 0, closed: 0 },
      ),
    [delta],
  );

  /**
   * "Needs you" — the count that earns the owner's attention.
   *
   * Composed from WORKSPACE-SCOPED inputs only: goals parked on the owner plus
   * the plan attention tiers. `harnessEscalations.byHarness` is deliberately NOT
   * folded in — it is scoped to a single harness, and mixing one harness's
   * escalations into a total whose other terms span the whole workspace would
   * produce a number that is silently wrong in a way nobody could read off the
   * screen. A scope-correct escalation source can be added later; a
   * scope-mixed one cannot be un-trusted once shipped.
   */
  const needYou = useMemo(
    () =>
      goals.reduce((acc, g) => acc + (g.needsHuman ?? 0), 0) +
      (attention?.decisionItems ?? 0) +
      (attention?.decisionPlans ?? 0),
    [goals, attention],
  );

  /**
   * TRUE when the attention counts are the server's deadline fallback, not a
   * real answer. Read it before believing ANY attention zero on this pane.
   *
   * The two readouts it governs need DIFFERENT honest renderings, which is the
   * whole subtlety and the reason this is not a copy of the sidebar's badge:
   *
   *  - `needYou` is a MIXED aggregate. Its goals term comes from `goals.list`
   *    and is unaffected by the attention deadline, so a degraded read still
   *    leaves a real FLOOR — "at least N" — not total ignorance.
   *  - the throughput rows below are PURE attention, so a degraded read leaves
   *    nothing at all. They render `unknown`, and must never keep the all-clear
   *    dot that only a REAL zero earns.
   *
   * (OperatorChatSidebar is the pure case throughout and renders an
   * indeterminate mark. Do not copy that treatment onto the chip, which has a
   * floor worth stating; do not copy the chip's floor onto a pure readout,
   * which has no floor to state.)
   */
  const attentionDegraded = attention?.degraded === true;

  const cold = !goalsEnvelope && agents.length === 0 && !attention && !spend;
  if (cold) {
    return (
      <div className="op-ph" role="region" aria-label="Pot health">
        <div className="op-pot-empty op-ph-loading">Loading pot health…</div>
      </div>
    );
  }

  return (
    <div className="op-ph" role="region" aria-label="Pot health">
      {/* Ambient digest — the glance, restated at the top of the full view so it
          survives the mode switch. */}
      <div className="op-ph-chips">
        <span className="op-ph-chip">{goals.length} goals</span>
        <span className={`op-ph-chip ${liveAgents > 0 ? 'ok' : 'warn'}`}>
          {liveAgents} driving
        </span>
        <span className="op-ph-chip">{compactCount(openItems)} open</span>
        <span className="op-ph-chip">
          +{compactCount(movement.opened)} / −{compactCount(movement.closed)} 24h
        </span>
        {spend != null && (
          <span className="op-ph-chip">${spend.h24.spendUsd.toFixed(2)} 24h</span>
        )}
        {/* MIXED aggregate: on a degraded attention read the goals term is
            still a real reading, so state the FLOOR rather than the total —
            and when there is no floor to state, say so instead of vanishing.
            A missing chip is what made the pane assert "nothing needs you". */}
        {attentionDegraded ? (
          needYou > 0 ? (
            <span className="op-ph-chip bad" title={ATTENTION_FLOOR_LABEL}>
              ≥{compactCount(needYou)} need you
            </span>
          ) : (
            <span className="op-ph-chip warn" title={ATTENTION_UNKNOWN_LABEL}>
              ? need you
            </span>
          )
        ) : (
          needYou > 0 && (
            <span className="op-ph-chip bad">{compactCount(needYou)} need you</span>
          )
        )}
      </div>

      <div className="op-ph-body">
        {/* ── 🎯 GOALS — what the pot is pointed at ──────────────────────── */}
        <h3 className="op-ph-sec goal">
          <Target size={12} strokeWidth={2} aria-hidden="true" />
          What the pot is pointed at
          <span className="op-ph-sec-d">goals</span>
        </h3>

        {!goalsEnvelope && <div className="op-pot-empty">Loading goals…</div>}
        {goalsEnvelope && goals.length === 0 && (
          <div className="op-pot-empty">
            no goals — nothing is steering this pot
          </div>
        )}
        {goals.map((g) => {
          const kill = killCriterionLine(g);
          const ceiling = ceilingLine(g);
          const burn = burnLine(g, nowMs);
          const bars = tripwireBars(g);
          const seen = agoText(g.lastActivityAt, nowMs);
          return (
            <section className="op-ph-card goal" key={g.id} aria-label={`Goal ${g.title}`}>
              <h4 className="op-ph-card-h">
                {g.title}
                <span className="op-ph-card-n">{g.status}</span>
              </h4>

              {/* The kill criterion leads, because a goal that cannot stop is
                  the failure GOAL mode exists to bound. */}
              <div className={`op-ph-kill${kill.missing ? ' missing' : ''}`}>{kill.text}</div>

              <div className="op-ph-kv">
                <KvRow
                  k="ceiling"
                  v={ceiling.text}
                  tone={ceiling.over ? 'bad' : ceiling.pct != null && ceiling.pct >= 80 ? 'warn' : 'ok'}
                />
                {burn != null && (
                  <KvRow k="burn" v={burn.text} tone={burn.urgent ? 'warn' : 'ok'} />
                )}
                <KvRow
                  k="work"
                  v={`${g.potCount ?? 0} pots · ${g.openWorkItems ?? 0} open${
                    (g.needsHuman ?? 0) > 0 ? ` · ${g.needsHuman} need you` : ''
                  }`}
                  tone={(g.needsHuman ?? 0) > 0 ? 'warn' : 'ok'}
                />
                {/* `lastActivityAt`, not `updatedAt`: `updatedAt` moves on a
                    title/status/budget edit, so a retitled dead goal would read
                    as fresh (cf. WI-37650). */}
                {seen != null && <KvRow k="last activity" v={seen} />}
              </div>

              {bars.length > 0 && (
                <div className="op-ph-bars">
                  {bars.map((b) => (
                    <TripwireBar bar={b} key={b.key} />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {/* ── 📈 THROUGHPUT + ATTENTION — is it working, what needs you ──── */}
        <h3 className="op-ph-sec flow">
          <Activity size={12} strokeWidth={2} aria-hidden="true" />
          Is it working
          <span className="op-ph-sec-d">throughput &amp; attention</span>
        </h3>

        <section className="op-ph-card flow" aria-label="Throughput and attention">
          <h4 className="op-ph-card-h">Throughput &amp; attention</h4>
          <div className="op-ph-kv">
            <KvRow k="open work" v={`${openItems} items`} />
            <KvRow
              k="last 24h"
              v={`${movement.opened} opened · ${movement.closed} closed`}
              tone={movement.closed >= movement.opened ? 'ok' : 'warn'}
            />
            {/* PURE attention: a degraded read leaves NOTHING here, so these
                render `unknown` and drop the dot entirely. The all-clear `ok`
                dot is earned only by a REAL zero — keeping it on a timed-out
                read is the confident-wrong reading WI-39779 added the bit for. */}
            {attention != null && (
              <KvRow
                k="needs a decision"
                v={
                  attentionDegraded
                    ? ATTENTION_UNKNOWN_TEXT
                    : `${attention.decisionItems} items · ${attention.decisionPlans} plans`
                }
                tone={
                  attentionDegraded
                    ? undefined
                    : attention.decisionItems + attention.decisionPlans > 0
                      ? 'warn'
                      : 'ok'
                }
              />
            )}
            {attention != null && (
              <KvRow
                k="alerts"
                v={attentionDegraded ? ATTENTION_UNKNOWN_TEXT : `${attention.alerts}`}
                tone={attentionDegraded ? undefined : attention.alerts > 0 ? 'bad' : 'ok'}
              />
            )}
            {spend != null && (
              <KvRow
                k="spend"
                v={`$${spend.h1.spendUsd.toFixed(2)} last hour · $${spend.h24.spendUsd.toFixed(2)} last 24h (${spend.h24.calls} calls)`}
              />
            )}
            {goalsEnvelope != null && (
              <KvRow
                k="portfolio"
                v={`$${goalsEnvelope.portfolioSpendUsd.toFixed(2)} across ${goalsEnvelope.portfolioPots} pots`}
              />
            )}
          </div>
        </section>

        {/* ── 👥 SU AGENTS — who is driving ─────────────────────────────── */}
        <h3 className="op-ph-sec agent">
          <Users size={12} strokeWidth={2} aria-hidden="true" />
          Who is driving
          <span className="op-ph-sec-d">su agents</span>
        </h3>

        <section className="op-ph-card agent" aria-label="Agents">
          <h4 className="op-ph-card-h">
            Agents
            {agents.length > 0 && (
              <span className="op-ph-card-n">
                {liveAgents} live of {agents.length}
              </span>
            )}
          </h4>
          {agents.length === 0 ? (
            <div className="op-pot-empty">nobody is driving this pot right now</div>
          ) : (
            <ul className="op-pot-list op-ph-agents">
              {agents.map((a) => {
                const tone = livenessTone(a.sessionState);
                const lane = a.fleetSlug
                  ? `${a.fleetSlug}${a.fleetRole ? ` · ${a.fleetRole}` : ''}`
                  : (a.planSlug ?? a.role ?? '—');
                return (
                  <li className="op-ph-agent" key={a.ownerId}>
                    <span className={`op-pot-dot ${tone}`} aria-hidden="true" />
                    <span className="op-ph-agent-id">{a.label}</span>
                    <span className="op-ph-agent-state">{livenessWord(a.sessionState)}</span>
                    <span className="op-ph-agent-lane">{lane}</span>
                    <span className="op-ph-agent-intent">{a.intent ?? 'no declared intent'}</span>
                    <span className="op-ph-agent-age">
                      {a.lastActiveSecAgo == null
                        ? '—'
                        : compactAge(nowMs - a.lastActiveSecAgo * 1000, nowMs)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
