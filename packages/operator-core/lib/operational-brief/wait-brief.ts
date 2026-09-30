/**
 * Lock/await wait operational briefs — plan use-existing-router-for-review-requests-2026-09-08
 * P-010, spec OP-BRIEF-P010-WAIT.
 *
 * A brief exists ONLY for a wait that materially blocks the caller across turns:
 *  - a `lock-wait`: a `locks:acquire { wake_on_grant:true }` that QUEUED a waiter ticket
 *    and registered a one-shot wake await on its grant key — the caller ends its turn and
 *    stays blocked until the grant cascade reaches the ticket;
 *  - an `await-wait`: a pending one-shot `events:await` wake registration.
 *
 * Everything else is a synchronous outcome and gets NO brief — an instant grant, a busy
 * refusal the caller did not queue on, a blocking same-turn wait that already returned, an
 * `already_fired` latch, a fired/cancelled/lapsed await, a standing (non-one-shot) watch, a
 * `notify` subscription, an `announce` declaration. The projections return `null` for those,
 * so a caller cannot wrap a synchronous read as a brief by accident: presence IS the claim
 * that the wait blocks.
 *
 * Both projections read only records the lock and await stores already own (the waiter
 * ticket, the holder snapshot, the `event_awaits` row, the announcement that declared the
 * key, the event catalog). Nothing is stored; there is no second wait ledger.
 */
import type { AwaitRow } from '../events/await/types';
import { finalizeOperationalBrief, known, unknown, type BriefField, type OperationalBrief } from './brief';

const LOCK_WAITER_SOURCE = 'agent_lock_waiters';
const LOCK_HOLDER_SOURCE = 'agent_locks holder snapshot';
const AWAIT_SOURCE = 'event_awaits';
const ANNOUNCEMENT_SOURCE = 'events:emit announce declaration';
const CATALOG_SOURCE = 'events:catalog emitter';

/** A current holder of a path the waiter queued on (the `busy` rows locks:acquire returns). */
export interface LockWaitHolder {
  path: string;
  owner: string;
  owner_label?: string | null;
  intent: string;
  /** ISO timestamp the holder's lease lapses. */
  expires_ts: string;
  holder_intent?: string;
  /** The holder's declared intent has moved off this lock and they are not focused on it. */
  holder_intent_diverged?: boolean;
}

export interface ProjectLockWaitBriefInput {
  ticketId: string;
  paths: readonly string[];
  /** The waiter ticket's queue-window end (agent_lock_waiters.wait_until). */
  waitUntil: Date | string;
  /** The wake await registered on the ticket's grant key; null when none was registered. */
  wakeAwait: AwaitRow | null;
  holders: readonly LockWaitHolder[];
  /** An edit was attached for apply-on-grant (EI-9033). */
  applyOnGrant?: boolean;
  nowMs?: number;
}

export type LockWaitBriefFacts = {
  ticketId: string;
  paths: string[];
  awaitId: BriefField<number>;
  grantEventKey: BriefField<string>;
  holders: BriefField<LockWaitHolder[]>;
  holderLeaseEndsAt: BriefField<string>;
  applyOnGrant: boolean;
  onWindowLapse: string;
  retract: string;
};

export type LockWaitOperationalBrief = OperationalBrief<LockWaitBriefFacts>;

export interface AwaitWaitAnnouncement {
  announcedBy: string;
  /** sessionState of the declarer when it was read ('ended' = gone). */
  declaredByLiveness?: string | null;
  liveSuccessorIds?: readonly string[];
}

/**
 * Why no emitter can be named even though the key is not an orphan:
 *  - `pattern`: a glob await; every matching key has its own emitter;
 *  - `fired-uncatalogued`: the key has fired before but its family is not catalogued;
 *  - `declared-out-of-scope`: an announcement the caller cannot see declared the key.
 */
export type AwaitEmitterHint = 'pattern' | 'fired-uncatalogued' | 'declared-out-of-scope';

export interface ProjectAwaitWaitBriefInput {
  wakeAwait: AwaitRow;
  /** The declaration that announced this exact key, when it is an announced gate. */
  announcement?: AwaitWaitAnnouncement | null;
  /** The catalogued emitter for the key's family, when the key matches one. */
  catalogEmitter?: string | null;
  /** Why the emitter is unnameable when it is not an orphan (see AwaitEmitterHint). */
  emitterHint?: AwaitEmitterHint | null;
  /** The registration found no known emitter for the key (it may only ever time out). */
  noKnownEmitter?: boolean;
  /** The wake-handle note captured at registration (why a handle is absent, if it is). */
  wakeHandleNote?: string | null;
  nowMs?: number;
}

export type AwaitWaitBriefFacts = {
  awaitId: number;
  eventKey: string;
  onTimeout: 'wake' | 'expire';
  wakeHandle: BriefField<string>;
  payloadFiltered: boolean;
  announced: boolean;
  retract: string;
};

export type AwaitWaitOperationalBrief = OperationalBrief<AwaitWaitBriefFacts>;

/** Why a registered await row does NOT materially block its subscriber, or null when it does. */
export function awaitNotBlockingReason(row: AwaitRow, nowMs: number = Date.now()): string | null {
  if (row.policy !== 'wake') return `policy ${row.policy} never re-invokes the subscriber`;
  if (row.once === false) return 'a standing watch re-arms on every fire; it is not a one-shot wait';
  if (row.firedAt) return `already fired (${row.firedReason ?? 'event'}) at ${row.firedAt}`;
  if (row.cancelledAt) return `cancelled at ${row.cancelledAt}`;
  if (row.expiresTs && Date.parse(row.expiresTs) <= nowMs) return `lapsed at ${row.expiresTs}`;
  return null;
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}

function holderText(h: LockWaitHolder): string {
  const who = h.owner_label ? `${h.owner} (${h.owner_label})` : h.owner;
  const orphan = h.holder_intent_diverged ? ' — holder has moved to other work; likely orphaned' : '';
  return `${h.path} held by ${who} for "${h.intent}" until ${h.expires_ts}${orphan}`;
}

/**
 * Brief for a queued `wake_on_grant` lock wait, or null when the wait does not block:
 * no wake await was registered, the await already fired/was cancelled, or the ticket's
 * queue window has already closed.
 */
export function projectLockWaitOperationalBrief(input: ProjectLockWaitBriefInput): LockWaitOperationalBrief | null {
  const nowMs = input.nowMs ?? Date.now();
  const wake = input.wakeAwait;
  if (!wake || awaitNotBlockingReason(wake, nowMs) !== null) return null;
  const windowEnd = iso(input.waitUntil);
  if (Date.parse(windowEnd) <= nowMs) return null;

  const holders = [...input.holders];
  const owners = [...new Set(holders.map((h) => h.owner))];
  const owner: BriefField<string | null> =
    owners.length > 0
      ? known(owners.join(', '), LOCK_HOLDER_SOURCE)
      : unknown('the acquire returned no holder snapshot; read locks:queue { paths } for the current holder');
  const leaseEnd = holders.reduce<string | null>(
    (latest, h) => (latest === null || Date.parse(h.expires_ts) > Date.parse(latest) ? h.expires_ts : latest),
    null,
  );
  const retract = `locks:cancel_wait { ticket_id: '${input.ticketId}' } + events:cancel { await_id: ${wake.id} }`;
  const orphaned = holders.filter((h) => h.holder_intent_diverged).map((h) => h.owner);
  const grantDelivery = input.applyOnGrant
    ? 'On grant the server applies your attached edit and drops a passive inbox note; you are woken only if the region changed and the edit must be redone.'
    : 'On grant you are re-invoked with lock_id and a running TTL: edit, then locks:release.';
  const orphanAdvice =
    orphaned.length > 0
      ? ` ${[...new Set(orphaned)].join(', ')} declared other work since taking the lock: coord:send them once asking them to release it.`
      : '';

  return finalizeOperationalBrief<LockWaitBriefFacts>({
    surface: 'lock-wait',
    subject: `lock ${input.paths.join(', ')} (ticket ${input.ticketId})`,
    state: known(input.applyOnGrant ? 'queued-for-wake (apply-on-grant)' : 'queued-for-wake', LOCK_WAITER_SOURCE),
    owner,
    nextAction: known(`END YOUR TURN. ${grantDelivery}${orphanAdvice}`, LOCK_WAITER_SOURCE),
    blockers:
      holders.length > 0
        ? known(holders.map(holderText), LOCK_HOLDER_SOURCE)
        : unknown('the acquire returned no holder snapshot'),
    lastVerified: known(
      {
        ref: `lock waiter ticket ${input.ticketId} · event_awaits#${wake.id}`,
        at: wake.createdAt,
        summary: 'waiter ticket queued and one-shot wake await registered on its grant key',
      },
      LOCK_WAITER_SOURCE,
    ),
    deadline: known<string | null>(windowEnd, `${LOCK_WAITER_SOURCE}.wait_until`),
    facts: {
      ticketId: input.ticketId,
      paths: [...input.paths],
      awaitId: known(wake.id, AWAIT_SOURCE),
      grantEventKey: known(wake.eventKey, AWAIT_SOURCE),
      holders: holders.length > 0 ? known(holders, LOCK_HOLDER_SOURCE) : unknown('the acquire returned no holder snapshot'),
      holderLeaseEndsAt: leaseEnd
        ? known(leaseEnd, LOCK_HOLDER_SOURCE)
        : unknown('no holder lease was reported, so the earliest possible grant is unknown'),
      applyOnGrant: input.applyOnGrant === true,
      onWindowLapse: `If ${windowEnd} passes without a grant you are woken with granted:false; re-run locks:acquire { wake_on_grant:true } to queue again.`,
      retract,
    },
  });
}

function awaitOwner(input: ProjectAwaitWaitBriefInput): BriefField<string | null> {
  if (input.announcement?.announcedBy) return known(input.announcement.announcedBy, ANNOUNCEMENT_SOURCE);
  if (input.catalogEmitter) return known(input.catalogEmitter, CATALOG_SOURCE);
  switch (input.emitterHint) {
    case 'pattern':
      return unknown('a pattern await matches many keys; the first to fire wakes you and each has its own emitter');
    case 'fired-uncatalogued':
      return unknown('this key has fired before, but its family is not registered in events:catalog, so its emitter cannot be named');
    case 'declared-out-of-scope':
      return unknown('an announcement outside your discovery scope declared this key; its declarer is not visible to this read');
    default:
      break;
  }
  return unknown(
    'no agent declared this key and it matches no catalogued emitter family; nobody is known to fire it',
  );
}

function awaitBlockers(input: ProjectAwaitWaitBriefInput): string[] {
  const row = input.wakeAwait;
  const out = [`waiting for ${row.eventKey} to fire`];
  const a = input.announcement;
  if (a && a.declaredByLiveness === 'ended' && (a.liveSuccessorIds?.length ?? 0) === 0) {
    out.push(`the declarer ${a.announcedBy} has ended and no live successor carries the emit duty`);
  }
  if (input.noKnownEmitter) out.push('no emitter is known to fire this exact key; it may only ever time out');
  return out;
}

function awaitNextAction(input: ProjectAwaitWaitBriefInput, owner: BriefField<string | null>): string {
  const row = input.wakeAwait;
  const who = owner.status === 'known' && owner.value ? owner.value : 'its emitter';
  const byDeadline = row.expiresTs ? ` by ${row.expiresTs}` : '';
  if (input.noKnownEmitter) {
    return `Nothing is known to fire ${row.eventKey}: confirm with the party that owns this completion that it will emit this EXACT key (events:catalog lists catalogued keys), or events:cancel { await_id: ${row.id} } and await the right key. Otherwise END YOUR TURN.`;
  }
  if (row.timeoutBehavior === 'expire') {
    return `END YOUR TURN. If ${row.eventKey} has not fired${byDeadline} this await EXPIRES SILENTLY and nothing wakes you: keep another wake source (loop:arm) or re-register with on_timeout:'wake'.`;
  }
  return `END YOUR TURN. You are re-invoked when ${row.eventKey} fires, or with a timeout wake${byDeadline}. On a timeout wake, check that ${who} is progressing before re-arming; a stalled emitter is your blocker to diagnose.`;
}

/**
 * Brief for a pending one-shot `events:await` wake registration, or null when the row does
 * not materially block (fired, cancelled, lapsed, standing watch, notify/announce row).
 */
export function projectAwaitWaitOperationalBrief(input: ProjectAwaitWaitBriefInput): AwaitWaitOperationalBrief | null {
  const row = input.wakeAwait;
  const nowMs = input.nowMs ?? Date.now();
  if (awaitNotBlockingReason(row, nowMs) !== null) return null;
  const owner = awaitOwner(input);
  const wakeHandle: BriefField<string> = row.wakeHandle
    ? known(row.wakeHandle.kind, AWAIT_SOURCE)
    : unknown(
        `no session wake handle was captured at registration${input.wakeHandleNote ? ` (${input.wakeHandleNote})` : ''}; delivery falls back to whatever live channel reaches the subscriber`,
      );
  return finalizeOperationalBrief<AwaitWaitBriefFacts>({
    surface: 'await-wait',
    subject: row.eventKey,
    state: known('waiting', AWAIT_SOURCE),
    owner,
    nextAction: known(awaitNextAction(input, owner), AWAIT_SOURCE),
    blockers: known(awaitBlockers(input), AWAIT_SOURCE),
    lastVerified: known(
      { ref: `event_awaits#${row.id}`, at: row.createdAt, summary: 'one-shot wake await registered and pending' },
      AWAIT_SOURCE,
    ),
    deadline: row.expiresTs
      ? known<string | null>(row.expiresTs, `${AWAIT_SOURCE}.expires_ts`)
      : known<string | null>(null, `${AWAIT_SOURCE}.expires_ts`),
    facts: {
      awaitId: row.id,
      eventKey: row.eventKey,
      onTimeout: row.timeoutBehavior,
      wakeHandle,
      payloadFiltered: row.payloadFilter != null,
      announced: Boolean(input.announcement?.announcedBy),
      retract: `events:cancel { await_id: ${row.id} }`,
    },
  });
}
