/**
 * recipient-resolve.ts — validate + resolve coord:send recipients against the
 * live roster (owner ask 2026-06-17: the SYSTEM, not just the prompt, must fail
 * loudly when you address an agent that doesn't exist — and a SHORT ownerId
 * prefix must resolve to the FULL id so the inbox-wake key matches).
 *
 * Why this exists: coord:send's wake fires the EXACT key
 * `coord:inbox-wake:<ownerId>`, which only the owner of that full id watches
 * (see inbox-wake.ts). A short prefix (e.g. `su-df00939e` for
 * `su-df00939e-1f16-…`) injected the message but fired a key nobody watched →
 * `woken:0`, and a typo'd id silently "succeeded" the same way. This resolves a
 * unique prefix to the full ownerId and rejects a recipient that matches no
 * known agent — so the wake lands and a bad id is a loud error, not a no-op.
 */

import { listPresence } from './presence';
import { listRecordedLiveSessions } from '../../adv-sessions';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { listLiveSessionPresence } from '../../sync/hyperbee/session-presence-store';
import { listRunningNurseryAliasRows } from './nursery-alias-liveness';

/** Wildcards + audience selectors that bypass concrete-recipient validation —
 *  sendMessage expands these itself (`*`/`human` broadcast; `@plan:`/`@role:`/
 *  `@wave:`/`@user:` are audience selectors). */
export function isSelectorOrWildcard(id: string): boolean {
  return id === '*' || id === 'human' || id === '' || id.startsWith('@');
}

export interface RecipientResolution {
  /** The `to[]` to actually send: selectors/wildcards passthrough + concrete
   *  ids resolved to their FULL ownerId. */
  resolved: string[];
  /** Concrete ids that matched no known agent (typos / dead-and-swept). */
  unknown: string[];
  /** Concrete ids whose prefix matched MORE than one known agent. */
  ambiguous: { id: string; matches: string[] }[];
}

export type ExplicitAgentOwnerResolution =
  | { ok: true; ownerId: string }
  | {
      ok: false;
      code: 'assignee_empty' | 'assignee_not_agent' | 'assignee_unknown' | 'assignee_ambiguous';
      message: string;
      candidates?: string[];
    };

/** Find current owner IDs for a concrete recipient using its supplied prefix
 * or short-handle substring. A stale full ID is not proof of a successor. */
function matchingOwnerIds(id: string, knownOwnerIds: readonly string[]): string[] {
  let matches = knownOwnerIds.filter((k) => k.startsWith(id));
  if (matches.length === 0) matches = knownOwnerIds.filter((k) => k.includes(id));
  return matches;
}

/** PURE core (unit-tested): resolve each `to` entry against the known ownerId
 *  set. selector/wildcard → passthrough; exact known id → keep; unique PREFIX of
 *  one known id → the full id; prefix → >1 known id → ambiguous; no match →
 *  unknown. */
export function resolveRecipientsAgainst(
  to: readonly string[],
  knownOwnerIds: readonly string[],
): RecipientResolution {
  const known = new Set(knownOwnerIds);
  const resolved: string[] = [];
  const unknown: string[] = [];
  const ambiguous: { id: string; matches: string[] }[] = [];
  for (const id of to) {
    if (isSelectorOrWildcard(id)) {
      resolved.push(id);
      continue;
    }
    if (known.has(id)) {
      resolved.push(id);
      continue;
    }
    // Prefix match (e.g. 'su-93a38' → 'su-93a3872a-…'), then a SUBSTRING fallback so
    // the SHORT HANDLE shown in the [coord+N] injection / inbox — a mid-uuid segment
    // like '93a38' for 'su-93a3872a-…', which is NOT a prefix — resolves directly,
    // without a separate coord:presence lookup to reply (owner ask 2026-06-19).
    const matches = matchingOwnerIds(id, knownOwnerIds);
    if (matches.length === 1) resolved.push(matches[0]);
    else if (matches.length > 1) ambiguous.push({ id, matches });
    else unknown.push(id);
  }
  return { resolved, unknown, ambiguous };
}

/** Remote (federated session-grain) ownerIds — P-007 (cross-machine-coord-
 *  parity): remote agents resolve exactly like local ones. Wide window (4x
 *  stale) keeps a quiet-but-alive remote session addressable (a message
 *  injects; wake honesty is the receipts leg, P-008). Best-effort: empty on
 *  error / no workspace (mig 434 not applied, single box). */
export async function remoteSessionOwnerIds(workspaceId?: string | null): Promise<Set<string>> {
  return new Set((await remoteSessionsByOwnerId(workspaceId)).keys());
}

/** P-010: remote sessions with their last-seen beat (epoch ms), so a caller can
 *  classify FRESH (likely wakeable on arrival) vs STALE (probably gone — an
 *  honest miss without a round-trip). Same wide addressability window. */
export async function remoteSessionsByOwnerId(
  workspaceId?: string | null,
): Promise<Map<string, number>> {
  if (!workspaceId) return new Map();
  try {
    const rows = await listLiveSessionPresence({
      workspaceId,
      staleMs: PRESENCE_STALE_MS * 4,
    });
    return new Map(rows.map((r) => [r.owner_id, r.last_seen_ms]));
  } catch {
    return new Map();
  }
}

// EI-9299 (coord probe-pair canary SLO breach, 2026-07-10): every sendMessage/
// appendAck with ANY concrete (non-selector) recipient — i.e. virtually every
// coord write — fired 3 parallel roster reads (listPresence,
// listRecordedLiveSessions, listLiveSessionPresence) via readKnownOwnerIds,
// even when the recipient is already a full known ownerId needing zero
// resolution. Under heavy concurrent fleet activity (dozens of live agents
// each sending/acking constantly) this tripled the DB read load on the coord
// write hot path and was the measured root cause of a probe cycle where the
// baseline control (SELECT 1, no roster read) stayed fast (415ms) while the
// ping/ack steps (each resolving recipients through this path) took
// 22173ms/14052ms — the exact "coord write path slow, DB at large fine"
// signature the canary's own attribution model (classifyBreach) flags.
// A short in-process TTL memo collapses that burst of near-simultaneous
// roster reads into one shared fetch per cache window. Safe: both callers
// (resolveRecipients, resolveBestEffortAgainstRoster) already treat this
// roster as a best-effort / eventually-consistent snapshot — resolveBestEffort
// passes an already-exact full ownerId through unchanged whether or not it
// appears in a few-seconds-stale roster (isSelectorOrWildcard/known.has short-
// circuits it BEFORE any prefix/substring matching is attempted), and
// resolveRecipients' hard-reject path is no less racy than today against a
// JUST-registered agent (presence writes were never synchronous with a
// concurrent read anyway).
const ROSTER_CACHE_TTL_MS = 2_000;
interface RosterCacheEntry {
  at: number;
  promise: Promise<string[]>;
}
const rosterCache = new Map<string, RosterCacheEntry>();
const ROSTER_CACHE_KEY_NONE = '\0';

/** Test-only: clear the roster memoization cache so a freshly-mocked roster
 *  read takes effect immediately instead of serving a stale cached result
 *  from an earlier call in the same TTL window. */
export function resetKnownOwnerIdsCache(): void {
  rosterCache.clear();
}

function readKnownOwnerIds(workspaceId?: string | null): Promise<string[]> {
  const key = workspaceId ?? ROSTER_CACHE_KEY_NONE;
  const now = Date.now();
  const cached = rosterCache.get(key);
  if (cached && now - cached.at < ROSTER_CACHE_TTL_MS) return cached.promise;
  const promise = fetchKnownOwnerIds(workspaceId);
  rosterCache.set(key, { at: now, promise });
  // Don't let a transient failure poison the cache for the whole TTL window —
  // a fresh call after a rejection re-fetches instead of repeatedly serving
  // (and callers repeatedly catching) the same failure.
  promise.catch(() => {
    if (rosterCache.get(key)?.promise === promise) rosterCache.delete(key);
  });
  return promise;
}

async function fetchKnownOwnerIds(workspaceId?: string | null): Promise<string[]> {
  const [presenceRes, recordedRes, remoteRes, nurseryRes] = await Promise.allSettled([
    listPresence({ workspaceId }),
    listRecordedLiveSessions({ workspaceId }),
    // P-007: the unified-roster leg — remote su-/bee ownerIds from
    // shared_session_presence, so direct addressing, prefix, AND short-handle
    // resolution all work cross-machine (the parity ask). Best-effort.
    remoteSessionOwnerIds(workspaceId),
    // EI-21987499463893160: a running nursery launch can be addressable only by
    // its spawned_agents aliases (spawn_id/session_owner/run_id) before it has
    // written coord_presence or adv_sessions. Keep this local source in the
    // authoritative set so a remote echo cannot shadow or make it ambiguous.
    listRunningNurseryAliasRows({ workspaceId }),
  ]);
  const ids = new Set<string>();
  // Collect the LOCAL identities first (this machine's own presence + recorded
  // live sessions). These are authoritative — a locally-homed ownerId belongs to
  // the local agent, full stop.
  const localIds = new Set<string>();
  if (presenceRes.status === 'fulfilled') {
    for (const p of presenceRes.value) {
      ids.add(p.ownerId);
      localIds.add(p.ownerId);
    }
  }
  if (recordedRes.status === 'fulfilled') {
    for (const s of recordedRes.value) {
      if (s.coordOwnerId) {
        ids.add(s.coordOwnerId);
        localIds.add(s.coordOwnerId);
      }
    }
  }
  if (nurseryRes.status === 'fulfilled') {
    for (const row of nurseryRes.value) {
      if (row.alias) {
        ids.add(row.alias);
        localIds.add(row.alias);
      }
    }
  }
  if (remoteRes.status === 'fulfilled') {
    for (const id of remoteRes.value) {
      // H1 (audit D-013): the LOCAL roster is AUTHORITATIVE for its own ownerIds.
      // shared_session_presence is device-signed but owner_id is sender-declared
      // free text, so an admitted-but-hostile member can gossip a session claiming a
      // LOCAL ownerId (e.g. 'queen' or a local su-<uuid>). A remote row is admitted
      // as a resolvable id ONLY when it does not collide with a locally-homed
      // identity — a colliding remote claim is never the SOURCE of that id being
      // known, so it can't repoint / shadow the local agent. (The upstream control
      // is the presence-gossip pipeline binding the announcing github_user_id to the
      // signer's attestation; this is the receiver-side belt-and-suspenders.)
      if (!localIds.has(id)) ids.add(id);
    }
  }
  return [...ids];
}

/** Host-bound wrapper: resolve `to` against the UNIFIED roster (local presence
 *  + recorded live sessions + P-007 federated session-grain presence), so a
 *  remote hive peer's su-/bee ownerId resolves exactly like a local one. An
 *  `unknown` is therefore a hard error everywhere: nobody local OR remote
 *  claims the id. */
export async function resolveRecipients(
  to: readonly string[],
  workspaceId?: string | null,
): Promise<RecipientResolution> {
  let knownOwnerIds: string[];
  try {
    knownOwnerIds = await readKnownOwnerIds(workspaceId);
  } catch {
    knownOwnerIds = []; // roster unavailable → fail open below
  }
  // No roster to validate against (empty / unavailable — tests, a fresh box, a
  // federated-only recipient) → DON'T reject; pass everything through. The hard
  // unknown-recipient error only fires when we actually HAVE a roster to check,
  // so an absent roster never turns a legitimate send into a false failure.
  if (knownOwnerIds.length === 0) {
    return { resolved: [...to], unknown: [], ambiguous: [] };
  }
  return resolveRecipientsAgainst(to, knownOwnerIds);
}

/** Resolve one work-item assignee against the same unified roster as coord:send,
 *  but fail closed when no roster is available. Placement cannot safely inherit
 *  resolveRecipients' intentional send-path fail-open behavior: an unverified
 *  owner would strand a real claim. The caller itself is known from the request
 *  identity and does not need a roster read. */
export async function resolveExplicitAgentOwnerId(
  raw: string,
  callerOwnerId: string,
  workspaceId?: string | null,
): Promise<ExplicitAgentOwnerResolution> {
  const input = raw.trim();
  if (!input) {
    return { ok: false, code: 'assignee_empty', message: 'Assignee must name a known agent ownerId.' };
  }
  if (input === 'self' || input === callerOwnerId) return { ok: true, ownerId: callerOwnerId };
  if (isSelectorOrWildcard(input)) {
    return {
      ok: false,
      code: 'assignee_not_agent',
      message: `Assignee '${input}' is a selector or wildcard, not one concrete agent ownerId.`,
    };
  }

  let knownOwnerIds: string[] = [];
  try {
    knownOwnerIds = await readKnownOwnerIds(workspaceId);
  } catch {
    // A roster read failure is not evidence that the supplied id is a valid owner.
    // The assignment boundary must refuse instead of persisting a phantom holder.
  }
  const resolution = resolveRecipientsAgainst([input], knownOwnerIds);
  if (resolution.resolved.length === 1) return { ok: true, ownerId: resolution.resolved[0]! };
  const ambiguous = resolution.ambiguous[0];
  if (ambiguous) {
    return {
      ok: false,
      code: 'assignee_ambiguous',
      message: `Assignee '${input}' matches more than one agent ownerId (${ambiguous.matches.join(', ')}). Pass the full ownerId.`,
      candidates: ambiguous.matches,
    };
  }
  return {
    ok: false,
    code: 'assignee_unknown',
    message: `Assignee '${input}' does not resolve to a known workspace ownerId; no work-item claim was made. Pass a current full ownerId from coord:presence.`,
  };
}

/** PURE best-effort core: rewrite each entry to its FULL ownerId when a unique
 *  prefix or caller-supplied short-handle substring matches, otherwise leave it UNCHANGED (the silent twin of
 *  resolveRecipientsAgainst — for the shared message/wake layers where a hard
 *  fail would break federation + broadcasts). selector/wildcard, exact match,
 *  ambiguous, and unknown all pass through untouched; only a unique prefix is
 *  rewritten. */
export function resolveBestEffort(
  to: readonly string[],
  knownOwnerIds: readonly string[],
): string[] {
  const known = new Set(knownOwnerIds);
  return to.map((id) => {
    if (isSelectorOrWildcard(id) || known.has(id)) return id;
    const matches = matchingOwnerIds(id, knownOwnerIds);
    return matches.length === 1 ? matches[0] : id;
  });
}

/** Host wrapper: resolve `to` best-effort against the live roster. SKIPS the
 *  roster read entirely when every entry is a selector/wildcard (broadcasts pay
 *  nothing), and FAILS SOFT (returns `to` unchanged) if the roster read errors —
 *  resolution must never break a send/wake. */
export async function resolveBestEffortAgainstRoster(
  to: readonly string[],
  workspaceId?: string | null,
): Promise<string[]> {
  if (!to.some((id) => !isSelectorOrWildcard(id))) return [...to];
  try {
    return resolveBestEffort(to, await readKnownOwnerIds(workspaceId));
  } catch {
    return [...to];
  }
}

/**
 * EI-9971 (coord-invariant wake-queue depth/age growth): "is `id` a KNOWN
 * agent?" — local presence, a recorded live session, or a federated remote
 * peer — reusing the SAME short-TTL roster cache `resolveBestEffortAgainstRoster`
 * already reads, so calling this alongside it costs nothing extra.
 *
 * Root cause this exists to fix: `resolveBestEffort` (by design, for message
 * delivery) passes a NEVER-matched id through UNCHANGED rather than rejecting
 * it — correct for injecting a message (a typo'd/garbage `to[]` entry still
 * lands the send; a genuinely-unknown-to-THIS-host federated peer must not be
 * silently dropped). But a caller that gates a PERSISTENT side effect on "is
 * this a real agent" (inbox-wake.ts staging a `pending_wakes` row for a
 * manual-mode target) has no way to tell "resolved to a real agent" apart from
 * "passed through because nothing matched" — so a garbage id (e.g. a bad
 * `coord:send { to: ['B'] }`) silently stages a wake row that can NEVER be
 * reviewed/released (nobody named 'B' exists) and sits as pure debris until
 * the hourly dead-owner sweep's grace window lapses, inflating the
 * wake-queue-depth invariant in the meantime. Observed live 2026-07-12:
 * owner_id='B' staged 5× (coalesced), source='me', workspace_id='default'.
 *
 * Returns `null` when the roster is empty/unavailable — callers MUST treat
 * that as "cannot tell, assume known" (fail OPEN), never as "unknown": an
 * unavailable roster must never suppress a legitimate wake (same fail-soft
 * discipline as `resolveRecipients`/`resolveBestEffortAgainstRoster` above).
 */
export async function knownOwnerIdSet(workspaceId?: string | null): Promise<Set<string> | null> {
  try {
    const ids = await readKnownOwnerIds(workspaceId);
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
}
