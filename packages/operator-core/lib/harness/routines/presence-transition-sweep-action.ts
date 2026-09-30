/**
 * presence-transition-sweep-action — the driver for the P-039 presence emitter
 * (context-injection-audit-2026-07-28, design settled in D-012).
 *
 * WHY A SWEEP AND NOT A TRANSITION SITE. Death is the ABSENCE of a write: nothing
 * happens at the moment an agent dies, a verdict merely becomes derivable. So
 * there is no call site to co-fire from, exactly as `fleet-transition-sweep-action.ts`
 * and `fleet-drained-events.ts` document for their own computed conditions.
 *
 * WHY THIS IS STILL "PUSH, NOT POLL" — the trade this plan keeps making: one
 * sweep for the whole box replaces N agents each polling `coord:presence` on
 * their own clock and BURNING A TURN to do it. The blocked agent does nothing;
 * the substrate does the looking, and the notice rides the coord rail it already
 * reads mid-turn.
 *
 * RELATIONSHIP TO `fleet-transition-sweep` — adjacent, deliberately NOT merged.
 * That sweep publishes FLEET-SCOPED awaitable event keys for a LEADER who has
 * explicitly parked on them (`events:await { event: 'fleet:member-dead:<slug>' }`
 * or `fleet:member-left:<slug>`),
 * and it drops every agent with no fleet. This one writes COMMITMENT-SCOPED coord
 * lines to whoever is blocked, fleet or not, with no registration at all. Same
 * observation source, different audience, different transport, different
 * predicate — merging them would mean one of the two audiences gets the wrong
 * signal. The observation gather is what is shared, and it is shared by reusing
 * the same oracle rather than by copying a query.
 *
 * THE PREVIOUS SNAPSHOT IS IN-PROCESS, ON PURPOSE — same justification as its
 * sibling: a lost snapshot costs at most one MISSED edge, once, on the sweep
 * after a restart (the detector's first-sighting rule then re-arms every agent),
 * where persisting it would buy that rare edge at the cost of a table, a
 * migration and a write every sweep.
 */

import { moduleEvaluationCount, pinModuleState } from '@papercusp/module-singleton';
import { groupByAgent, listFleetAssignments, type AgentAssignment } from '../../fleet/assignments';
import {
  reconcileWakeability,
  RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
} from '../../agent-tools/fleet/assignments';
import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';
import {
  detectPresenceEdges,
  indexPresenceObservations,
  selectPresenceNotices,
  type Commitment,
  type PresenceNotice,
  type PresenceObservation,
} from '../../presence-transition-emitter';
import { gatherCommitmentsOn } from '../../presence-transition-commitments';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

/** The system sender these notices are attributed to. Machine-authored, so the
 *  coord write seam stamps `expects:'none'` for it automatically. */
const PRESENCE_ALERT_IDENTITY: AgentIdentity = {
  ownerId: 'system:presence-transition',
  ownerLabel: 'presence-transition',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/**
 * The previous sweep's observations, keyed by agentId — PINNED to the realm
 * (EI-21904761023329235), not a bare module-scoped `let`. `previousObservations`
 * used to be reassigned directly (`previousObservations = indexPresenceObservations(...)`),
 * which is exactly the shared-lib-singleton anti-pattern this repo's CLAUDE.md
 * documents: if the loader ever produces a SECOND module record for this file
 * (a tsx CJS/ESM double-load, a bare-vs-relative import, a symlinked
 * node_modules copy), each record gets its OWN binding and a tick answered by
 * record B never sees what record A wrote — a partial, silently-blind detector
 * that looks complete. `pinModuleState` returns one shared object no matter how
 * many times this module is evaluated, so state lives on `.previousObservations`
 * of that object and is mutated in place (or the property reassigned), never the
 * module-level binding itself. Best-effort by design — see the header note. */
const presenceSweepState = pinModuleState<{ previousObservations: Map<string, PresenceObservation> }>(
  '@papercusp/operator-core.presence-transition-sweep-action.previousObservations',
  () => ({ previousObservations: new Map<string, PresenceObservation>() }),
);

/** Test-only: forget the previous snapshot so cases don't cross-contaminate. */
export function __resetPresenceTransitionSnapshotForTests(): void {
  presenceSweepState.previousObservations = new Map();
}

/**
 * Gather one round of liveness observations for EVERY agent — through the same
 * pipeline `fleet:assignments` uses, so a sweep verdict can never disagree with
 * what an agent would read for itself.
 *
 * ⚠ Unlike `gatherFleetObservations`, this deliberately does NOT filter to
 * fleeted agents. A solo or unfleeted agent's death is invisible to the fleet
 * feed by design, but it is precisely the case this emitter exists for: whoever
 * is blocked on them is blocked regardless of anyone's fleet membership.
 */
export async function gatherPresenceObservations(): Promise<PresenceObservation[]> {
  // `reconcileWakeability` WRITES `sessionState` onto the rows it is handed but
  // `AgentAssignment` does not declare the field — so the widened row type has to
  // be named here (same reason as gatherFleetObservations).
  type ObservableAgent = AgentAssignment & { sessionState?: SessionState | null };
  const agents: ObservableAgent[] = groupByAgent(await listFleetAssignments({}));
  if (agents.length === 0) return [];

  // Best-effort: a degraded liveness read must produce UNKNOWN fields, never a
  // thrown sweep. An unknown never fires (the detector only fires on a crossing
  // INTO a known alert state), so a degraded read is silent, not a false alarm.
  const withLiveness = await reconcileWakeability(
    agents,
    undefined,
    undefined,
    undefined,
    undefined,
    RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
  ).catch(() => agents);
  return withLiveness.map((a) => ({
    agentId: a.agentId,
    sessionState: a.sessionState ?? null,
  }));
}

/** Re-read one subject's liveness immediately before a queued notice is written. */
async function gatherCurrentPresenceObservation(
  agentId: string,
): Promise<Pick<PresenceObservation, 'sessionState'> | null> {
  type ObservableAgent = AgentAssignment & { sessionState?: SessionState | null };
  const agents = groupByAgent(await listFleetAssignments({ agent: agentId }));
  const subject = agents.find((agent) => agent.agentId === agentId);
  if (!subject) return null;
  const [reconciled] = await reconcileWakeability(
    [subject as ObservableAgent],
    undefined,
    undefined,
    undefined,
    undefined,
    RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
  );
  return { sessionState: reconciled?.sessionState ?? null };
}

/** Injectable seams so the sweep unit-tests without PG or the coord rail. */
export interface PresenceTransitionSweepDeps {
  gather?: () => Promise<PresenceObservation[]>;
  gatherCommitments?: (subjectIds: readonly string[]) => Promise<Commitment[]>;
  /**
   * Last-moment subject recheck before a queued notice is delivered. `null`
   * means the subject disappeared; an omitted/unknown state keeps the original
   * notice because a failed read is not evidence that the edge recovered.
   */
  currentObservation?: (agentId: string) => Promise<Pick<PresenceObservation, 'sessionState'> | null>;
  deliver?: (notice: PresenceNotice) => Promise<void>;
}

/**
 * Write one notice to the coord rail, addressed to the single blocked agent.
 *
 * `kind: 'presence_alert'` gives it its own glyph in the `[coord+N]` block and
 * keeps it out of the kind='message' unanswered-directed aggregate. The rail
 * itself does the rest: `coord-inbox-bus` picks the row up on its cursor and
 * `renderInjection` lands it mid-turn — no fold, no budget, no new channel.
 */
async function deliverNotice(notice: PresenceNotice): Promise<void> {
  await sendMessage(PRESENCE_ALERT_IDENTITY, {
    to: [notice.receiverId],
    kind: 'presence_alert',
    summary: notice.summary,
    extra: { auto: true },
  });
}

/**
 * Run one sweep: observe every agent, detect the liveness crossings against the
 * previous snapshot, resolve who had committed something to the crossers, and
 * write one line to each of them.
 *
 * Returns the number of notices written so the routine can log a count and tests
 * can assert without reading the rail.
 *
 * THE SNAPSHOT IS ADVANCED EVEN WHEN NOTHING FIRED — that is what makes the NEXT
 * sweep able to see a crossing. It is also advanced before delivery, so a
 * delivery failure cannot cause the same edge to re-fire on every later sweep.
 */
export async function runPresenceTransitionSweep(deps: PresenceTransitionSweepDeps = {}): Promise<number> {
  const gather = deps.gather ?? gatherPresenceObservations;
  const gatherCommitments = deps.gatherCommitments ?? gatherCommitmentsOn;
  const deliver = deps.deliver ?? deliverNotice;

  const prevSizeBeforeUpdate = presenceSweepState.previousObservations.size;
  const observations = await gather();
  const edges = detectPresenceEdges(presenceSweepState.previousObservations, observations);
  presenceSweepState.previousObservations = indexPresenceObservations(observations);
  // TEMPORARY diagnostic (EI-21904761023329235), trimmed to fire ONLY on the
  // suspicious case — a previous snapshot of size 0 on a NON-first tick (i.e.
  // this module has been evaluated more than once in this realm). A genuinely
  // first tick also has prevSizeBefore===0, but pairing it with
  // moduleEvaluationCount lets a reader tell "first tick, expected" apart from
  // "state silently reset again", instead of firing unconditionally every
  // minute. Remove once pinModuleState has been observed live for a while with
  // no further duplication.
  const evaluations = moduleEvaluationCount(
    '@papercusp/operator-core.presence-transition-sweep-action.previousObservations',
  );
  if (prevSizeBeforeUpdate === 0) {
    console.log(
      `[presence-transition-sweep][DIAG] pid=${process.pid} moduleEvaluations=${evaluations} ` +
        `prevSizeBefore=0 obsCount=${observations.length} edges=${edges.length} ` +
        `(first tick if moduleEvaluations<=1; otherwise state was unexpectedly empty)`,
    );
  }
  // The overwhelmingly common case: nothing crossed. Cost stops here — no
  // commitment read, no write, nothing on anyone's rail.
  if (edges.length === 0) return 0;

  const commitments = await gatherCommitments(edges.map((e) => e.agentId));
  const notices = selectPresenceNotices(edges, commitments);
  const currentObservation = deps.currentObservation ?? gatherCurrentPresenceObservation;
  const currentBySubject = new Map<string, Promise<Pick<PresenceObservation, 'sessionState'> | null | undefined>>();
  const recheck = (subjectId: string) => {
    const existing = currentBySubject.get(subjectId);
    if (existing) return existing;
    const current = Promise.resolve()
      .then(() => currentObservation(subjectId))
      // A degraded recheck must preserve the original notice: an unknown read
      // is not evidence that a liveness edge recovered.
      .catch(() => undefined);
    currentBySubject.set(subjectId, current);
    return current;
  };

  let delivered = 0;
  for (const notice of notices) {
    const current = await recheck(notice.subjectId);
    // Suppress stale notices when the subject changed state after edge detection.
    // The next sweep observes that new state and can emit a fresh, correctly
    // labelled edge instead. `null` means the subject is no longer present;
    // `undefined`/null sessionState means the recheck was inconclusive, so keep
    // the original signal fail-open.
    if (current === null) continue;
    if (current && current.sessionState !== null && current.sessionState !== notice.edge.to) continue;
    // Per-notice fail-soft: one undeliverable line must not swallow the rest.
    try {
      await deliver(notice);
      delivered += 1;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[presence-transition-sweep] deliver to ${notice.receiverId} failed: ${msg}`);
    }
  }
  return delivered;
}

/** Is the emitter enabled? Default ON — a finished, tested feeder that ships
 *  dark is dead code. OFF is the clean kill-switch: the rail simply goes back to
 *  carrying no presence lines, exactly as it did before this landed. */
async function presenceAlertsEnabled(): Promise<boolean> {
  try {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    return await getFlag(FLAGS.COORD_PRESENCE_TRANSITION_ALERTS, 'coord-presence-transition-alerts');
  } catch {
    // A flags hiccup must not silently disable a default-ON feature.
    return true;
  }
}

registerSystemAction('presence-transition-sweep', async (_ctx: SystemActionCtx) => {
  if (!(await presenceAlertsEnabled())) return;
  const fired = await runPresenceTransitionSweep();
  // Only speak when something actually crossed AND intersected a commitment —
  // this runs every minute, and a per-tick "swept, nothing to report" line is
  // the log noise that trains readers to filter the channel out.
  if (fired > 0) console.log(`[presence-transition-sweep] delivered ${fired} presence alert(s)`);
});
