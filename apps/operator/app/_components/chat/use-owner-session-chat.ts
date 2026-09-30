'use client';

/**
 * The wiring behind a live agent conversation, apart from any one surface that
 * renders it (goals-tab-improvement-2026-08-09 D-011).
 *
 * WHY THIS MODULE EXISTS. `SessionChatModal` grew all of this inline, so the
 * *renderer* (`LiveSessionChat` → `OperatorChat` → `PapercupChat`) was
 * reusable but the wiring around it was not: resolving the owner's session,
 * building the SSE `streamUrl`, and the send state machine. The goal popup now
 * embeds the same conversation (D-011), and copying that wiring would have
 * forked it — the exact thing D-005 ("generalize OperatorChat... never fork a
 * second chat renderer") exists to prevent, one layer down.
 *
 * The stakes are concrete rather than stylistic. `buildSessionStreamUrl`
 * carries the `ended=1` archive fallback (EI-16982) — an ended session's
 * transcript is GC'd within ~2h, and without that flag the backend's
 * rematerialize path silently never fires. `useSessionSend` carries P-002's
 * echo ordering: the message is recorded BEFORE the await so it appears the
 * instant you hit enter, and un-renders if the send fails. A second copy of
 * either would not look broken — it would just quietly lack a fix that was
 * expensive to find the first time.
 *
 * DIRECTION: this module imports nothing from `SessionChatModal`; the modal
 * imports from here. Keeping one direction is what makes the extraction safe
 * to reuse from a second surface without a cycle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NativeSessionHandle } from '@papercusp/operator-core/lib/native-session-handles';
import {
  parseAgentTimelineEntries,
  type AgentTimelineEntry,
} from '@papercusp/operator-core/lib/cross-boundary-event-contracts';
import { recordSentEcho, settleSentEcho } from './sent-message-echo';

export type SessionStreamKey = 'sessionId' | 'codexSessionKey' | 'codexRolloutId' | 'ompThreadId';

export interface SessionListRow {
  source_kind: string;
  session_id: string;
  active?: boolean;
  last_ts: string | null;
  /** The exact query key `/api/adv/session/thinking` expects for this row. */
  stream_key?: SessionStreamKey;
  /**
   * WI-41496 — an omp row's adv-session id, which is what names the session's
   * transcript HOME.
   *
   * `ompThreadId` alone identifies the FILE but not the directory tree it lives
   * in: a psu-launched omp agent writes to
   * `~/.papercusp/su-omp-homes/session-<advId>/agent/sessions/…`, never to the
   * shared `~/.omp` home the route falls back to. Without this the stream
   * resolved nothing and every omp conversation popup rendered empty while the
   * transcript was being written. Optional — the server sweeps the per-session
   * homes when it is absent, which is slower but keeps a deep-link working.
   */
  omp_session_key?: string | number | null;
}

/** The runtime handles already present on an advRoster.list row. */
export interface SessionRosterHint {
  agent?: string | null;
  advSessionId?: number | null;
  sessionId?: string | null;
  ompThreadId?: string | null;
  nativeSession?: NativeSessionHandle | null;
  /**
   * The roster's verdict on whether this session's transcript RESOLVES AT ALL
   * (adv-roster's `thinkingResolvable`). Only `false` carries information here:
   * the server already probed the recorded session id and found no transcript.
   *
   * It has to travel with the hint because `sessionTargetFromRoster` below
   * hardcodes `active: true` for a claude native handle — correct as a liveness
   * statement, but it means `buildSessionStreamUrl`'s existing
   * `resolved.active === false` leg can NEVER fire on the roster path, so a
   * session whose transcript was rotated away never reached the
   * rematerialize-from-archive fallback and rendered an empty pane instead
   * (EI-16982's gap, WI-2680's symptom). Passing it separately keeps `active`
   * honest — an unresolvable transcript is not the same claim as an ended
   * session, and the modal branches on `resolved.active === false` for its
   * "session ended" copy.
   */
  thinkingResolvable?: boolean;
}

async function listOwnerSessions(ownerId: string): Promise<SessionListRow[]> {
  const r = await fetch('/api/admin/coordination/sessions/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: ownerId, limit: 10 }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`sessions:list → ${r.status}: ${text.slice(0, 200)}`);
  let body: { sessions?: SessionListRow[] };
  try {
    body = JSON.parse(text) as { sessions?: SessionListRow[] };
  } catch {
    throw new Error('sessions:list returned a non-JSON response');
  }
  return body.sessions ?? [];
}

/** Resolve the most relevant CLAUDE session for this owner via the existing
 *  sessions:list admin proxy. Kept as the no-roster compatibility path. */
export async function resolveOwnerClaudeSession(ownerId: string): Promise<SessionListRow | null> {
  const sessions = await listOwnerSessions(ownerId);
  // Prefer the live/active fallback row (EI-11403), else the newest indexed
  // claude session — sessions:list is already newest-first.
  return (
    sessions.find((s) => s.source_kind === 'claude' && s.active) ??
    sessions.find((s) => s.source_kind === 'claude') ??
    null
  );
}

/**
 * Turn the roster's canonical native handle into the stream route's exact key.
 * Pure and exported because mixing up a Codex rollout UUID with an adv-row id
 * produces a healthy SSE connection with an empty transcript — a silent miss.
 */
export function sessionTargetFromRoster(hint: SessionRosterHint): SessionListRow | null {
  const native = hint.nativeSession;
  if (native?.backend === 'claude' && native.sessionId) {
    return {
      source_kind: 'claude',
      session_id: native.sessionId,
      stream_key: 'sessionId',
      active: true,
      last_ts: null,
    };
  }
  if (native?.backend === 'codex') {
    if (native.rolloutId) {
      return {
        source_kind: 'codex',
        session_id: native.rolloutId,
        stream_key: 'codexRolloutId',
        active: true,
        last_ts: null,
      };
    }
    if (hint.advSessionId != null) {
      return {
        source_kind: 'codex',
        session_id: String(hint.advSessionId),
        stream_key: 'codexSessionKey',
        active: true,
        last_ts: null,
      };
    }
  }
  if (native?.backend === 'omp' && native.ompThreadId) {
    return {
      source_kind: 'omp',
      session_id: native.ompThreadId,
      stream_key: 'ompThreadId',
      active: true,
      last_ts: null,
      omp_session_key: hint.advSessionId ?? null,
    };
  }

  // Compatibility with a roster payload from before `nativeSession` shipped.
  const agent = hint.agent?.trim().toLowerCase();
  if ((agent === 'claude' || agent === 'papercup') && hint.sessionId) {
    return {
      source_kind: 'claude',
      session_id: hint.sessionId,
      stream_key: 'sessionId',
      active: true,
      last_ts: null,
    };
  }
  if (agent === 'codex' && hint.advSessionId != null) {
    return {
      source_kind: 'codex',
      session_id: String(hint.advSessionId),
      stream_key: 'codexSessionKey',
      active: true,
      last_ts: null,
    };
  }
  if (agent === 'omp' && hint.ompThreadId) {
    return {
      source_kind: 'omp',
      session_id: hint.ompThreadId,
      stream_key: 'ompThreadId',
      active: true,
      last_ts: null,
      omp_session_key: hint.advSessionId ?? null,
    };
  }
  return null;
}

function streamKeyForSource(sourceKind: string): SessionStreamKey {
  if (sourceKind === 'codex') return 'codexRolloutId';
  if (sourceKind === 'omp') return 'ompThreadId';
  return 'sessionId';
}

/** Resolve the owner against the roster handle first, then the indexed history. */
export async function resolveOwnerSession(
  ownerId: string,
  hint: SessionRosterHint = {},
): Promise<SessionListRow | null> {
  const rosterTarget = sessionTargetFromRoster(hint);
  if (rosterTarget) return rosterTarget;

  const sessions = await listOwnerSessions(ownerId);
  const preferred = hint.agent?.trim().toLowerCase();
  const sourceKind = preferred === 'codex' || preferred === 'omp' ? preferred : preferred ? 'claude' : null;
  const matching = sessions.filter((s) => sourceKind
    ? s.source_kind === sourceKind
    : ['claude', 'codex', 'omp'].includes(s.source_kind));
  const row = matching.find((s) => s.active) ?? matching[0] ?? null;
  return row ? { ...row, stream_key: row.stream_key ?? streamKeyForSource(row.source_kind) } : null;
}

/**
 * What actually happened to a sent message — P-002 (the wake-mode correctness
 * bug).
 *
 * The old banner said "Sent — the agent is woken if it's live" unconditionally,
 * which is not a claim this code was ever in a position to make. Two routine
 * states make it false:
 *   - the agent is in `coord:wake-mode` MANUAL, where wakes are STAGED for the
 *     owner to release rather than delivered. The message is real and queued,
 *     but the agent is not working on it and will not until released;
 *   - no live session picked the wake up at all (`recipient_absent`).
 * Both reported as unqualified success, which is the worst kind of wrong: the
 * human walks away believing they have asked for something.
 *
 * Rather than pre-reading wake-mode and guessing, we report what the send
 * RESPONSE says — the authority on what the platform did with it. That also
 * catches the absent case for free, which a wake-mode pre-check would not.
 */
export type SendDelivery =
  /** Legacy response shape: old servers called the queue count `woken`. */
  | { kind: 'woken'; count: number }
  | { kind: 'staged' }
  | { kind: 'absent' }
  | { kind: 'queued' };

/** Read the delivery outcome out of a coord:send response. PURE → unit-tested. */
export function deliveryFromSendResponse(body: unknown): SendDelivery {
  const first = (body as { results?: Array<Record<string, unknown>> } | null)?.results?.[0];
  if (!first) return { kind: 'queued' };
  const wake = first.wake as { queued?: number; woken?: number; staged?: number | boolean } | undefined;
  if (wake) {
    // Current coord:send responses distinguish durable queueing from execution.
    // A queued wake is not a pickup receipt, so keep the UI on the honest warning
    // banner. The woken fallback is retained only for older server responses.
    if (typeof wake.queued === 'number') return { kind: 'queued' };
    if (typeof wake.woken === 'number' && wake.woken > 0) return { kind: 'woken', count: wake.woken };
    // A staged wake is the manual-mode case: accepted, held for release.
    if (wake.staged) return { kind: 'staged' };
  }
  if (first.recipient_absent === true) return { kind: 'absent' };
  if (first.staged === true) return { kind: 'staged' };
  // Delivered to the inbox with no wake attempted/reported — it will be read at
  // the agent's next turn. Honest middle ground, not a claim of attention.
  return { kind: 'queued' };
}

/** Send a live message to the session's owner. Exported for tests. */
export async function sendToSessionOwner(ownerId: string, body: string): Promise<SendDelivery> {
  const r = await fetch('/api/admin/coord/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: [ownerId],
      summary: body.length > 80 ? `${body.slice(0, 77)}…` : body,
      body,
      wake: 'required',
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`coord:send → ${r.status}: ${text.slice(0, 200)}`);
  // A non-JSON 200 is not a failure to report to the user — the message WAS
  // accepted; we simply cannot characterise the delivery. Degrade to the
  // weakest honest claim rather than inventing a stronger one.
  try {
    return deliveryFromSendResponse(JSON.parse(text));
  } catch {
    return { kind: 'queued' };
  }
}

/** The search deep-link params. All absent on an ordinary open, which leaves
 *  the stream on its unchanged tail backfill. */
export interface SessionStreamFocus {
  /** Stream the session the MATCH is in, not the owner's latest. */
  focusSessionId?: string | null;
  focusTerm?: string | null;
  focusAnchorTs?: string | null;
}

export interface OwnerHistoryPageResponse {
  entries: AgentTimelineEntry[];
  hasMore: boolean;
  cursor: string | null;
}

/** Build the same-route JSON page URL from an ordinary owner-scoped SSE URL. */
export function buildOwnerHistoryPageUrl(streamUrl: string, cursor: string | null): string | null {
  if (!cursor) return null;
  try {
    const current = new URL(streamUrl, 'http://papercusp.local');
    const owner = current.searchParams.get('historyOwner');
    if (!owner) return null;
    const query = new URLSearchParams({
      historyPage: '1',
      historyOwner: owner,
      historyCursor: cursor,
    });
    return `/api/adv/session/thinking?${query.toString()}`;
  } catch {
    return null;
  }
}

/** Load and validate one older stable-owner history page. */
export async function fetchOwnerHistoryPage(
  streamUrl: string,
  cursor: string,
): Promise<OwnerHistoryPageResponse> {
  const url = buildOwnerHistoryPageUrl(streamUrl, cursor);
  if (!url) throw new Error('This conversation has no owner-history cursor');
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`owner history → ${response.status}: ${text.slice(0, 200)}`);
  let body: { entries?: unknown; hasMore?: unknown; cursor?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error('owner history returned a non-JSON response');
  }
  const entries = parseAgentTimelineEntries(body.entries);
  if (
    !entries
    || typeof body.hasMore !== 'boolean'
    || !(typeof body.cursor === 'string' || body.cursor === null)
    || (body.hasMore && !body.cursor)
  ) throw new Error('owner history returned an invalid page');
  return { entries, hasMore: body.hasMore, cursor: body.cursor };
}

/**
 * Build the `/api/adv/session/thinking` SSE URL. PURE → unit-tested.
 *
 * Returns null when there is nothing to stream yet, which is the signal the
 * renderer must NOT be mounted: `useAgentThinkingStream` only skips its
 * harness-run-log default URL when `streamUrl` is already truthy at call time.
 */
export function buildSessionStreamUrl(
  ownerId: string | null,
  resolved: SessionListRow | null,
  focus: SessionStreamFocus = {},
  roster: Pick<SessionRosterHint, 'thinkingResolvable'> = {},
): string | null {
  if (!ownerId || !resolved) return null;
  /* A search deep-link streams the session the MATCH is in, not the owner's
     latest. When they differ the target is by definition an earlier link in the
     respawn chain and therefore ended, so it also needs `ended=1` below to
     reach the rematerialize-from-archive fallback (EI-16982);
     `resolved.active` describes the LATEST session and would say otherwise. */
  const streamSessionId = focus.focusSessionId || resolved.session_id;
  const isEarlierSession = streamSessionId !== resolved.session_id;
  // A search result's session id is the native corpus id. For Codex that is a
  // rollout UUID even when the current live row is addressed by adv-row key.
  const streamKey = isEarlierSession
    ? streamKeyForSource(resolved.source_kind)
    : (resolved.stream_key ?? streamKeyForSource(resolved.source_kind));
  const p = new URLSearchParams({ [streamKey]: streamSessionId });
  if (streamKey === 'sessionId') p.set('owner', ownerId);
  /* Ordinary conversation opens are keyed by the stable coordination owner,
     not by one native transcript epoch. The server uses this explicit scope
     only for the bounded HISTORY backfill; it still follows `streamSessionId`
     for live appends. Keep search deep-links session-scoped: their whole point
     is to open the exact native transcript that owns the match, and widening
     that anchored window back to the owner chain would make its entry index
     address a different list. */
  if (!focus.focusSessionId) p.set('historyOwner', ownerId);
  /* WI-41496: an omp thread id names the transcript FILE; the adv-session id
     names the HOME it lives in (`su-omp-homes/session-<id>/agent/sessions`).
     Send it whenever we have it — the route's per-session-home sweep is the
     fallback for when we do not, not the intended path. Skipped for an EARLIER
     session in a respawn chain: the key belongs to the row we resolved, and
     pointing a different session's home at this thread id would search the
     wrong tree (harmlessly, but it would also skip the sweep that would have
     found it). */
  if (streamKey === 'ompThreadId' && !isEarlierSession && resolved.omp_session_key != null) {
    p.set('ompSessionKey', String(resolved.omp_session_key));
  }
  // EI-16982: an ended session's on-disk transcript is routinely GC'd within
  // ~2h of archiving (session-dir-gc.ts); the backend already has a
  // rematerialize-from-archive fallback (WI-3990) gated on `ended=1`, but it
  // silently never fires unless the caller passes it. `resolved.active` is the
  // server-stamped liveness we already have in hand here — reuse it rather than
  // inventing a new signal.
  // P-012: the third way to reach the same fallback — the ROSTER already told
  // us this session's recorded id resolves to no transcript. `resolved.active`
  // cannot carry that on the roster path (`sessionTargetFromRoster` stamps
  // `active: true` for a claude handle), so without this leg the one case the
  // archive fallback exists for was also the one case that never requested it.
  // This is the same gate `thinkingStreamUrl` (AgentsRunningPill) already
  // applies; the two surfaces build the same URL and should not disagree.
  if (resolved.active === false || isEarlierSession || roster.thinkingResolvable === false) p.set('ended', '1');
  /* `find` + `anchorTs` are the route's EXISTING contract
     (session-anchor-window.ts): it streams the whole transcript through a
     bounded collector and returns a window CENTERED on the matched entry, then
     emits an `anchor` event naming it. Without them the route backfills the
     TAIL, and a search hit is almost never in the tail. */
  if (focus.focusTerm) p.set('find', focus.focusTerm);
  if (focus.focusAnchorTs) p.set('anchorTs', focus.focusAnchorTs);
  return `/api/adv/session/thinking?${p.toString()}`;
}

export interface OwnerSessionChat {
  /** Null until the session resolves — and the gate on mounting the renderer. */
  streamUrl: string | null;
  resolved: SessionListRow | null;
  resolving: boolean;
  resolveError: string | null;
  send: (text: string) => void;
  sending: boolean;
  sendError: string | null;
  /** The DELIVERY OUTCOME of the last send, not a boolean. Null = none yet. */
  sentOk: SendDelivery | null;
}

/**
 * Everything a surface needs to host one agent's live conversation.
 *
 * Pass `ownerId: null` when there is no agent (or the host is closed) — the
 * hook resolves nothing, opens no stream, and returns a null `streamUrl`. That
 * is deliberate rather than incidental: a closed or agent-less host must not
 * hold a live query open, and D-011 requires that an agent-less goal render a
 * plain statement rather than an inert composer.
 */
export function useOwnerSessionChat(
  ownerId: string | null,
  focus: SessionStreamFocus = {},
  rosterHint: SessionRosterHint = {},
): OwnerSessionChat {
  const [resolved, setResolved] = useState<SessionListRow | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState<SendDelivery | null>(null);

  useEffect(() => {
    setResolved(null);
    setResolveError(null);
    setSendError(null);
    setSentOk(null);
    if (!ownerId) return;
    let cancelled = false;
    setResolving(true);
    resolveOwnerSession(ownerId, rosterHint)
      .then((s) => {
        if (!cancelled) setResolved(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setResolveError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    ownerId,
    rosterHint.agent,
    rosterHint.advSessionId,
    rosterHint.sessionId,
    rosterHint.ompThreadId,
    rosterHint.nativeSession,
  ]);

  const { focusSessionId, focusTerm, focusAnchorTs } = focus;
  const rosterThinkingResolvable = rosterHint.thinkingResolvable;
  const streamUrl = useMemo(
    () =>
      buildSessionStreamUrl(
        ownerId,
        resolved,
        { focusSessionId, focusTerm, focusAnchorTs },
        { thinkingResolvable: rosterThinkingResolvable },
      ),
    [ownerId, resolved, focusSessionId, focusTerm, focusAnchorTs, rosterThinkingResolvable],
  );

  const send = useCallback(
    (text: string) => {
      if (!ownerId) return;
      setSendError(null);
      setSentOk(null);
      setSending(true);
      /* P-002: record the send BEFORE awaiting it, so the message appears in the
         transcript the instant you hit enter rather than a round-trip later. The
         optimism is settled either way below — a failed send un-renders (the
         error banner is what reports it), because a message that never left must
         not sit in the conversation looking like part of it. */
      const echoId = recordSentEcho(ownerId, text);
      sendToSessionOwner(ownerId, text)
        .then((delivery) => {
          setSentOk(delivery);
          settleSentEcho(ownerId, echoId, 'sent');
        })
        .catch((e: unknown) => {
          setSendError(e instanceof Error ? e.message : String(e));
          settleSentEcho(ownerId, echoId, 'failed');
        })
        .finally(() => setSending(false));
    },
    [ownerId],
  );

  return { streamUrl, resolved, resolving, resolveError, send, sending, sendError, sentOk };
}
