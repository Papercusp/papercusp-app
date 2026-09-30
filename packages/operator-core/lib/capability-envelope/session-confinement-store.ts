/**
 * session-confinement-store — the server-side state behind a launch-declared session
 * confinement, and the resolver that binds it to a calling session.
 * (directed-pair-work-items-2026-08-25 P-004, obligation (a) of D-016; design D-017.)
 *
 * THE KEY IS THE COORD IDENTITY, NEVER A REQUEST ARG
 * --------------------------------------------------
 * `resolveAgentIdentity(ctx).ownerId` is transport-resolved — the `Mcp-Session-Id` header
 * for a superuser session, the HMAC-verified `client=` param for a spawn — and `identity.ts`
 * REFUSES to attribute an unverified one (EI-318). A confinement the caller supplies is one
 * the caller can omit, which is not a confinement; this module therefore never reads the
 * request, only `ctx`.
 *
 * WHY A POPULATION ID MUST BE REFUSED (D-017 §2 — the hazard)
 * ----------------------------------------------------------
 * `resolveAgentIdentity` answers with the SHARED constant `SUPERUSER_FALLBACK_CLIENT_ID`
 * (`'su-loopback'`) for any superuser session that arrives without a per-session client id,
 * and `mcp-call-<pid>` for one-shot `mcp-call.mjs` invocations. Those name a POPULATION, not
 * a session. Keyed on one, a confinement meant for a single implementer would bind every
 * client-less su session on the box — the owner's own interactive session and the pair's own
 * director included — and silently, because a refusal looks identical whether it was aimed at
 * you or inherited from a stranger. `isTransportOnlyIdentity()` already exists for the
 * mirror-image hazard (it stops a transport fallback taking CREDIT for a completion); here it
 * stops one taking BLAME for a confinement. Guarded on BOTH sides: the write refuses to store
 * such a key, the read refuses to apply one.
 *
 * WHY IMPORT IS PURE AND PRIMING IS LAZY
 * -------------------------------------
 * Module-scope IO in this package has form: an eager `operator-state-pg` read at import time
 * opened a real Postgres connection during collection and reddened 8 operator-core suites
 * (WI-39930). So importing this module only ASSIGNS the resolver; the first dispatch that
 * actually consults it primes the cache and arms the refresh timer.
 *
 * WHY THE FIRST CALL AWAITS BUT THE REST DO NOT
 * --------------------------------------------
 * Fail-open on a cold cache is forced, not chosen (D-017 §4): unconfined is the default for
 * every session in the fleet, so a fail-closed miss would deny every dispatch on the box.
 * Ordering closes the window in the launch case — the launch writes the confinement, which
 * primes this process's cache, BEFORE the implementer is spawned. It does not close the
 * OPERATOR-RESTART case, where the cache starts empty with a confined session already live.
 * So the first consult awaits one priming read; every later consult reads the sync cache.
 * That is one await per process, not one per dispatch.
 */
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { pinModuleState } from '@papercusp/module-singleton';

import { isTransportOnlyIdentity, resolveAgentIdentity } from '../agent-tools/coordination/identity';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import type { SessionToolConfinement } from './session-confinement';
import { setSessionConfinementResolver } from './session-confinement-port';

/** One stored confinement, with the expiry that keeps the table from accumulating dead rows. */
export interface StoredSessionConfinement {
  readonly confinement: SessionToolConfinement;
  readonly declaredAt: string;
  readonly expiresAt: string;
}

/** The `operator_session_confinements` payload: one map, keyed by coord ownerId. */
export interface SessionConfinementsPayload {
  sessions?: Record<string, StoredSessionConfinement>;
}

const STATE_TABLE = 'operator_session_confinements' as const;

/** 12h — long enough for any real pair engagement, short enough that a leak self-heals. */
const DEFAULT_TTL_SEC = 12 * 60 * 60;

const state = pinModuleState('@papercusp/operator-core.session-confinement-store', () => ({
  /** The sync cache the dispatch hot path reads. Empty until primed. */
  cache: {} as Record<string, StoredSessionConfinement>,
  /** Memoized priming promise — one per process, not one per dispatch. */
  priming: undefined as Promise<void> | undefined,
  /** Whether the periodic refresh has been armed (lazily, on first consult). */
  armed: false,
}));

function isExpired(row: StoredSessionConfinement, nowMs: number): boolean {
  const t = Date.parse(row.expiresAt);
  // An unparseable expiry is treated as EXPIRED. A confinement is a narrowing, so the
  // conservative reading of a corrupt row is "do not apply it" — the alternative would let a
  // malformed row confine a session forever with no way to age out.
  return !Number.isFinite(t) || t <= nowMs;
}

/** Read the table into the sync cache, dropping expired rows. */
export async function refreshSessionConfinements(): Promise<void> {
  const payload = (await readOperatorState<SessionConfinementsPayload>(STATE_TABLE)) ?? {};
  const rows = payload.sessions ?? {};
  const nowMs = Date.now();
  const live: Record<string, StoredSessionConfinement> = {};
  for (const [ownerId, row] of Object.entries(rows)) {
    if (!row?.confinement || isExpired(row, nowMs)) continue;
    // Defence in depth: a population-keyed row must never bind, even if one reached the
    // table by a path that skipped the write guard.
    if (isTransportOnlyIdentity(ownerId)) continue;
    live[ownerId] = row;
  }
  state.cache = live;
}

/**
 * Prime once per process, and arm the periodic refresh on the same first consult.
 * Never rejects: a store that cannot be read leaves the session UNCONFINED (the forced
 * default) and says so loudly, rather than taking every dispatch on the box down with it.
 */
export function ensureSessionConfinementsReady(): Promise<void> {
  if (state.priming) return state.priming;
  state.priming = (async () => {
    try {
      await refreshSessionConfinements();
    } catch (err) {
      console.error(
        '[session-confinement] priming read failed — sessions treated as UNCONFINED until the next refresh',
        err,
      );
    }
    if (!state.armed) {
      state.armed = true;
      // Visible in schedule:inventory as a config-memo refresh, per the no-bare-setInterval rule.
      managedSetInterval(
        'config-refresh:session-confinements',
        60_000,
        () => {
          void refreshSessionConfinements().catch(() => {
            /* transient; the next tick retries */
          });
        },
        // D-004: honestly a VIOLATION, not a must-sample. This re-reads a PG-backed
        // store and rebuilds a derived cache every 60s regardless of whether anything
        // changed and regardless of subscriber presence. Postgres can emit change
        // events and this repo already has an invalidation bus (notifySyncInvalidate),
        // so the push path is available and merely unwired — which is exactly the sin
        // D-004 wants COUNTED rather than excused. Converting it to invalidate-on-write
        // is the real fix; classifying it 'must-sample' would only hide it.
        { category: 'cache', classification: 'violation' },
      );
    }
  })();
  return state.priming;
}

/**
 * The sync lookup the resolver performs. Returns null for an unknown, expired, or
 * population-keyed owner — all three mean "this session is not confined".
 */
export function sessionConfinementFor(
  ownerId: string | null | undefined,
): SessionToolConfinement | null {
  if (!ownerId || isTransportOnlyIdentity(ownerId)) return null;
  const row = state.cache[ownerId];
  if (!row || isExpired(row, Date.now())) return null;
  return row.confinement;
}

/**
 * Declare a confinement for one session. Called by the paired launch BEFORE the implementer
 * process is spawned, so the row exists before the confined session does (D-017 §4).
 *
 * Refuses a population-shaped owner id outright: storing one is the D-017 §2 hazard, and a
 * refusal at the write is what keeps the bad key from ever existing.
 */
export async function declareSessionConfinement(args: {
  ownerId: string;
  confinement: SessionToolConfinement;
  ttlSec?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ownerId = args.ownerId?.trim();
  if (!ownerId) return { ok: false, reason: 'ownerId is required' };
  if (isTransportOnlyIdentity(ownerId)) {
    return {
      ok: false,
      reason:
        `refusing to confine '${ownerId}': that is a transport-only identity shared by every ` +
        `client-less session, not one session. Confining it would bind unrelated sessions ` +
        `(including the owner's own). Launch the implementer with a per-session identity first.`,
    };
  }
  if (!args.confinement?.denyTools?.length) {
    return { ok: false, reason: 'confinement must deny at least one tool' };
  }

  const ttlSec = args.ttlSec && args.ttlSec > 0 ? args.ttlSec : DEFAULT_TTL_SEC;
  const now = Date.now();
  const payload = (await readOperatorState<SessionConfinementsPayload>(STATE_TABLE)) ?? {};
  const sessions = { ...(payload.sessions ?? {}) };

  // Prune while we hold the payload — the write path is the natural place to age the table out.
  for (const [key, row] of Object.entries(sessions)) {
    if (!row?.confinement || isExpired(row, now)) delete sessions[key];
  }

  sessions[ownerId] = {
    confinement: args.confinement,
    declaredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSec * 1000).toISOString(),
  };

  await writeOperatorState<SessionConfinementsPayload>(STATE_TABLE, { ...payload, sessions });
  // Same-process immediacy: the launch primes THIS process's cache before it spawns the
  // implementer, so there is no window in the launch case.
  await refreshSessionConfinements();
  return { ok: true };
}

/** Lift a confinement (engagement over, or the session ended). Idempotent. */
export async function releaseSessionConfinement(ownerId: string): Promise<void> {
  const payload = (await readOperatorState<SessionConfinementsPayload>(STATE_TABLE)) ?? {};
  const sessions = { ...(payload.sessions ?? {}) };
  if (!(ownerId in sessions)) return;
  delete sessions[ownerId];
  await writeOperatorState<SessionConfinementsPayload>(STATE_TABLE, { ...payload, sessions });
  await refreshSessionConfinements();
}

/** Test seam: replace the sync cache without touching Postgres. */
export function __setSessionConfinementCacheForTest(
  rows: Record<string, StoredSessionConfinement>,
): void {
  state.cache = { ...rows };
}

/** Test seam: mark priming already done so a unit test never reaches Postgres. */
export function __markSessionConfinementsPrimedForTest(): void {
  state.priming = Promise.resolve();
  state.armed = true;
}

// ── Install ────────────────────────────────────────────────────────────────────────
// D-017 §5: binding installation to the module the dispatcher already imports removes the
// "boot path forgot to install it" class. This gate's failure mode is SILENT — no resolver
// means every session is unconfined, with nothing thrown and nothing logged — so an install
// step that can be skipped is exactly the wrong shape. Assignment only; no IO at import.
setSessionConfinementResolver(
  (ctx) => {
    let ownerId: string | null = null;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId ?? null;
    } catch {
      // Unattributable ctx — it cannot be the implementer, whose identity is established at
      // spawn. Nothing to look up.
      return null;
    }
    return sessionConfinementFor(ownerId);
  },
  { ensureReady: ensureSessionConfinementsReady },
);
