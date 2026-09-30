/**
 * presence-transition-emitter — the COMMITMENT-SCOPED presence feeder for the
 * mid-turn coord rail (context-injection-audit-2026-07-28 P-039, design settled
 * in D-012; filed as EI-18872678095307319).
 *
 * THE MEASURED GAP. Automatic context injection carries ZERO presence/liveness:
 * `turn-start-memory.ts` returns exactly two blocks (the CTRL:transition delta
 * and the mem0 block), and every writer of `coord_event_log` is an EXPLICIT
 * agent action (`coord:send`, `coord:escalate`). So a peer dying produces
 * NOTHING — an agent blocked on that peer learns only by polling, or never.
 *
 * THIS IS AN EMITTER, NOT A CHANNEL. D-002 already ratified the coord rail for
 * mid-turn delivery and it is fully built: `coord_event_log` lands `[coord+N]`
 * INSIDE a turn, `coord-inbox-bus` carries the watermark/cursor dedup, and
 * `renderInjection` already renders one compressed line per delta. Nothing here
 * adds a fold, a budget, or a transport — it only WRITES to the rail that exists.
 *
 * ⚠ THE HARD CONSTRAINT FROM D-012 — emit ONLY when the transition intersects the
 * RECEIVING agent's own commitments. A standing roster broadcast is REJECTED: it
 * would recreate this plan's own Phase 8 "unbudgeted injection channel" defect,
 * duplicate what `coord:orient` already pulls cheaply, and be pure noise in the
 * common solo session. Being commitment-scoped is what makes this SELF-BUDGETING
 * — silent when nothing relevant changed — which is the whole reason it is
 * allowed to exist without a budget of its own.
 *
 * WHICH STATES FIRE, and why this differs from its sibling. `fleet-transition-events.ts`
 * fires on `ended` ONLY, because its audience is a LEADER MONITOR where a false
 * alarm is itself a bug (WI-4400: `draining`/`suspect` need a wake confirmation
 * before a coordinator may assume the owner is gone). Here the audience is
 * different in kind: not "someone watching the fleet" but "someone whose own next
 * step is BLOCKED on this specific peer". For them `suspect` is actionable news —
 * it changes whether they keep waiting — and the commitment scoping bounds the
 * blast radius to exactly the agents already stuck. So this module fires on both,
 * and LABELS them differently (`DEAD` vs `NOT RESPONDING (unconfirmed)`) so an
 * unconfirmed suspicion can never read as a confirmed death. Recorded as D-039.
 *
 * PURE core + injectable seams (the fleet-transition-events.ts / fleet-drained-events.ts
 * discipline): no PG, no IO, no clock in this file, so the detector and the
 * intersection arithmetic unit-test without a database. The IO half lives in
 * `presence-transition-commitments.ts`; the sweep that drives it in
 * `harness/routines/presence-transition-sweep-action.ts`.
 */

/** The liveness verdicts this emitter treats as newsworthy for a blocked peer. */
export type PresenceAlertState = 'ended' | 'suspect';

/**
 * `ended` is the shared oracle's CONFIRMED-dead verdict; `suspect` is an
 * unconfirmed stall. Both are reported, never conflated — see the module header.
 */
const ALERT_STATES: ReadonlySet<string> = new Set<PresenceAlertState>(['ended', 'suspect']);

/** One agent as a sweep observes it — the minimal projection of the presence row. */
export interface PresenceObservation {
  agentId: string;
  /** The shared liveness oracle's verdict (live | parked | draining | suspect | ended | recorded). */
  sessionState: string | null;
}

/** One detected liveness crossing, before any commitment is considered. */
export interface PresenceEdge {
  agentId: string;
  /** The state crossed INTO — always one of ALERT_STATES. */
  to: PresenceAlertState;
  /** The state crossed FROM, for the line. */
  from: string | null;
}

/** Index a sweep's observations for the next sweep's comparison. */
export function indexPresenceObservations(
  observations: readonly PresenceObservation[],
): Map<string, PresenceObservation> {
  return new Map(observations.map((o) => [o.agentId, o]));
}

/**
 * PURE: which agents crossed INTO a newsworthy liveness state between the
 * previous sweep and this one.
 *
 * EDGE-ONLY, by the two rules `detectFleetTransitions` establishes and for the
 * same reasons — a monitor that cries wolf is a broken monitor:
 *
 *   1. An agent with NO previous observation never fires. A first sighting is not
 *      a crossing we witnessed; without this, the first sweep after any operator
 *      restart would alert on every historically-dead row it happens to see.
 *   2. An agent already in an alert state does not re-fire while it STAYS there.
 *      `ended` persists until the TTL reaper evicts the row, so re-firing would
 *      turn one death into a per-sweep wake storm for everyone blocked on it.
 *
 * A `suspect → ended` crossing DOES fire again, deliberately: it is a genuine
 * escalation from "unconfirmed" to "confirmed", and it is the transition that
 * tells a waiting agent to stop hoping. Rule 2 only suppresses a re-fire INTO
 * THE SAME state.
 *
 * An agent that DISAPPEARS between sweeps is NOT treated as a death: the row may
 * equally have been TTL-reaped. Disappearance-as-death would be a guess, and the
 * point of a push signal is that the reader can trust it.
 *
 * Deterministic order (agentId) so callers and tests are stable.
 */
export function detectPresenceEdges(
  prev: ReadonlyMap<string, PresenceObservation>,
  next: readonly PresenceObservation[],
): PresenceEdge[] {
  const edges: PresenceEdge[] = [];
  for (const o of next) {
    const before = prev.get(o.agentId);
    if (!before) continue; // rule 1 — a first sighting is not a crossing

    const to = o.sessionState ?? '';
    if (!ALERT_STATES.has(to)) continue;
    // rule 2 — no re-fire while it STAYS in the same alert state (but
    // suspect → ended is a real escalation and does fire).
    if (before.sessionState === to) continue;

    edges.push({ agentId: o.agentId, to: to as PresenceAlertState, from: before.sessionState });
  }
  edges.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return edges;
}

/**
 * Why a given receiver cares about a given transitioned agent. The three classes
 * D-012 names, and nothing else — each one is a commitment the receiver has
 * ALREADY made, which is what bounds this emitter's audience.
 */
export type CommitmentKind =
  /** The receiver asked this agent something and is still awaiting the reply. */
  | 'awaiting-reply'
  /** The receiver is blocked in the lock queue behind a lock this agent holds. */
  | 'blocked-on-lock'
  /** The receiver has an armed await on a work-item this agent is holding. */
  | 'awaiting-held-item';

/** One receiver's commitment on one agent, as the IO half resolves it. */
export interface Commitment {
  /** The agent who will RECEIVE the line. */
  receiverId: string;
  /** The agent whose liveness changed. */
  subjectId: string;
  kind: CommitmentKind;
  /** Short specifics for the line — a msg_id, a lock path, a work-item id. */
  detail?: string;
}

/** One line to write to the coord rail: an edge that intersected a commitment. */
export interface PresenceNotice {
  receiverId: string;
  subjectId: string;
  edge: PresenceEdge;
  commitments: Commitment[];
  summary: string;
}

/** How the receiver is told what a state means. `suspect` must never read as a
 *  confirmed death — see the module header. */
function stateLabel(to: PresenceAlertState): string {
  return to === 'ended' ? 'is DEAD' : 'is NOT RESPONDING (unconfirmed — may recover)';
}

/** The human half of each commitment class, in the receiver's own terms: what
 *  THEY are now stuck on, not what happened to the peer. */
function commitmentPhrase(c: Commitment): string {
  switch (c.kind) {
    case 'awaiting-reply':
      return `you are awaiting their reply${c.detail ? ` (${c.detail})` : ''}`;
    case 'blocked-on-lock':
      return `you are queued behind their lock${c.detail ? ` on ${c.detail}` : ''}`;
    case 'awaiting-held-item':
      return `you are awaiting ${c.detail ?? 'a work-item'}, which they hold`;
  }
}

/** What the receiver should DO — the reason this is worth a line at all. A
 *  notice that only reports a fact makes the reader derive the consequence.
 *
 *  These lines stay ACTIONABLE without asserting the future, and that
 *  distinction is load-bearing (EI-21337853199637756). `ended` is derived from
 *  the owner's most-recent RECORDED SESSION — `endedRecordedOwnerIds` takes the
 *  latest `adv_sessions` row by `started_at` and asks whether `ended_at` is set.
 *  That is a fact about a SESSION, stamped onto an ownerId, and the same ownerId
 *  routinely comes back: a carry-respawn, `claude --resume`, or a relaunch
 *  resumes it under the identical id and can still answer. So non-arrival is not
 *  something this emitter is in a position to know.
 *
 *  It was also measured false: an alert asserted "that reply is not coming" at
 *  12:06Z and the reply arrived from that same ownerId at 12:33:54Z, 27 minutes
 *  later. An agent that believes the assertion abandons a thread that is still
 *  alive. So: tell the receiver to stop BLOCKING (which is always sound, because
 *  they cannot know WHEN it resumes), never that the thing will never arrive.
 *  `presence-transition-emitter.test.ts` pins this as a guard over every remedy
 *  string, so a future edit cannot quietly reintroduce the certainty. */
function remedy(to: PresenceAlertState, kinds: ReadonlySet<CommitmentKind>): string {
  if (to === 'suspect') return 'it may recover — re-check before abandoning the wait';
  if (kinds.has('blocked-on-lock')) return 'do not block on them releasing that lock — expect a reaper release, or take it up';
  if (kinds.has('awaiting-held-item')) return 'do not block on that await firing from them — reclaim the item or re-place the work';
  return 'do not keep blocking on that reply — chase it another way if you still need it';
}

/**
 * PURE: join detected edges against resolved commitments, producing at most ONE
 * notice per (receiver, subject) pair however many commitments they share.
 *
 * The de-duplication is the point. An agent can easily hold two commitments on
 * the same dying peer (awaiting a reply AND queued behind their lock); emitting
 * a line each would be the noise this design exists to avoid, and the receiver
 * needs ONE line telling them everything they are now stuck on.
 *
 * A receiver is never told about ITSELF — an agent's own transition is not news
 * to it, and self-addressing would produce a line at exactly the moment the
 * session is least able to act on it.
 *
 * Deterministic order (receiver, then subject) so the sweep's writes and the
 * tests are stable.
 */
export function selectPresenceNotices(
  edges: readonly PresenceEdge[],
  commitments: readonly Commitment[],
): PresenceNotice[] {
  if (edges.length === 0 || commitments.length === 0) return [];
  const edgeBySubject = new Map(edges.map((e) => [e.agentId, e]));

  // (receiver, subject) → the commitments they hold on that subject.
  const grouped = new Map<string, { receiverId: string; subjectId: string; items: Commitment[] }>();
  for (const c of commitments) {
    if (!c.receiverId || !c.subjectId) continue;
    if (c.receiverId === c.subjectId) continue; // never alert an agent about itself
    if (!edgeBySubject.has(c.subjectId)) continue; // no crossing ⇒ no line (the silent case)
    const key = `${c.receiverId}\0${c.subjectId}`;
    const slot = grouped.get(key) ?? { receiverId: c.receiverId, subjectId: c.subjectId, items: [] };
    slot.items.push(c);
    grouped.set(key, slot);
  }

  const notices: PresenceNotice[] = [];
  for (const { receiverId, subjectId, items } of grouped.values()) {
    const edge = edgeBySubject.get(subjectId);
    if (!edge) continue;
    const kinds = new Set(items.map((i) => i.kind));
    const because = items.map(commitmentPhrase).join('; ');
    notices.push({
      receiverId,
      subjectId,
      edge,
      commitments: items,
      summary:
        `peer ${shortId(subjectId)} ${stateLabel(edge.to)} (${edge.from ?? 'unknown'} → ${edge.to}) — ` +
        `${because}. ${remedy(edge.to, kinds)}`,
    });
  }
  notices.sort((a, b) => a.receiverId.localeCompare(b.receiverId) || a.subjectId.localeCompare(b.subjectId));
  return notices;
}

/**
 * Compact agent handle for the line body. The rendered `[coord+N]` line already
 * carries the SENDER's short handle (this emitter's system id), so the SUBJECT
 * has to be named in the text or the reader cannot tell who died. Mirrors
 * `shortHandle` in coord-schema.ts rather than importing it, to keep this file
 * dependency-free and unit-testable in isolation.
 */
function shortId(ownerId: string): string {
  if (!ownerId) return '?';
  const stripped = ownerId.replace(/^(su|omp|cc|codex)-/, '');
  const m = stripped.match(/[A-Za-z0-9]+/);
  const core = (m ? m[0] : stripped).slice(0, 5);
  return core || ownerId.slice(0, 5);
}
