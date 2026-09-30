/**
 * Self-rebinding accessor for LONG-LIVED admin pools (EI-19306394439939264).
 *
 * ## Why this exists
 *
 * A cached pool must never outlive the URL that justified it. `connection.ts` learned
 * that the hard way (EI-19285027465993737) and fixed it for the two MANAGED admin
 * clients by tracking the URL each pool was ACTUALLY BUILT WITH and rebinding through
 * {@link endStalePool}. The insight there is the load-bearing one: every earlier guard
 * asked *"what SHOULD we connect to?"*, and none asked *"what is the live pool actually
 * bound to?"* — so URL resolution kept returning the correct address the whole time the
 * pool was serving a dead one.
 *
 * That fix did not reach the ~22 hand-rolled module-scoped pools built as
 * `postgres(getHarnessAdminUrl(), { ...longLivedPoolConnectionOptions(label) })`, which
 * cache a pool in a module-level `let` and track no URL at all.
 *
 * ## What this is — and, precisely, what it is NOT
 *
 * This is PREVENTIVE hardening of that defect class. It is **not** the fix for the
 * 2026-08-01 outage (WI-6739), and an earlier version of this comment wrongly said it was.
 * Every logger identifiable in that outage — `[await-event]` (`events/await/engine.ts:798`),
 * `[harness-status-sweep]`, `[expirable-registry]` and `[sync-sse] notify`
 * (`sync-sse.ts:137`, `getSql: () => getOrgPg().sql`) — reaches PG through the MANAGED
 * `getOrgPg()`, which `endStalePool` already rebinds. Those four logged 20,144 ×
 * `connect ECONNREFUSED 127.0.0.1:20216` — a dead embedded-pg port — over ~2h40m.
 *
 * The pools below carry the IDENTICAL defect and were very likely bound to that same dead
 * endpoint, but they are not separately identifiable in the logs, so nothing here claims
 * they caused the outage. They are simply the half of the class still unguarded — worth
 * closing because the trigger (an endpoint that moves under a cached pool) is unchanged.
 *
 * The outage was self-healable and did not self-heal. `:3070` has no `DATABASE_URL` — there
 * is no `.env.local` in `papercup-release` and no env file defines one — so it resolves via
 * DISCOVERY; with `~/.papercusp/embedded-pg.json` gone, `getHarnessAdminUrl()` correctly
 * returns the healthy native `:5432`. A pool that compared itself against that would have
 * rebound on its very next use. These pools never ask.
 *
 * ## What this gives a call site
 *
 * Replace the module-level `let pool` + lazy `postgres(...)` with one call. On every use it
 * re-resolves the admin URL and, if the endpoint moved since the pool was built, drains the
 * stale pool (best-effort, non-blocking) and rebuilds. When the URL is stable — the
 * overwhelming common case — it returns the identical cached instance, so this is
 * behaviour-preserving apart from the rebind.
 *
 *   const db = () => getLongLivedAdminPool('operator-continue-chains', { max: 4, prepare: false });
 *
 * `longLivedPoolConnectionOptions(label)` (pg_stat_activity attribution + dead-client
 * zombie-detection GUCs) and `poolIdleTimeoutSec()` (postgres-js defaults `idle_timeout`
 * to 0 = never close, the root cause of a past saturation crit) are applied for you, so a
 * migrated site cannot forget either. `extra` is spread LAST so a call site keeps the final
 * say on `max`/`prepare`/`onnotice`.
 *
 * ## Deliberately NOT for LISTEN connections
 *
 * A `LISTEN` connection carries subscription state that a silent rebuild would drop: the
 * caller would keep a live handle that no longer receives notifications — a worse failure
 * than the one being fixed, because it is silent. Those sites (e.g. `pending-events-listener`,
 * `coord-inbox-bus`) need a rebind that also re-issues their `LISTEN`, which belongs with the
 * code that owns the subscription. Use this for TRANSACTIONAL pools only.
 */
import postgres from 'postgres';
import {
  endStalePool,
  longLivedPoolConnectionOptions,
  poolIdleTimeoutSec,
  STORE_IDENTITY_SQL,
  parseStoreIdentity,
  pinOrVerifyStoreIdentity,
  describeStoreIdentityMismatch,
} from '@papercusp/db-org';

import { getHarnessAdminUrl } from './embedded-pg-discovery';

type Sql = ReturnType<typeof postgres>;
type PoolExtras = Parameters<typeof postgres>[1];

/** label → { the live pool, the URL it was BUILT with }. The second half is the fix. */
const _pools = new Map<string, { sql: Sql; url: string }>();

/**
 * Generation 3 — IDENTITY — applied to this seam (WI-7180).
 *
 * The header above frames generations 1 (resolution) and 2 (binding), and
 * `store-identity.ts` cites *this file* for that framing while calling itself generation 3.
 * It was then wired into `connection.ts`'s two managed clients only, via
 * `validateDiscoveryTargetOnce` — the sole two call sites in the tree. So the guard never
 * reached the seam its own lineage note is written against: every pool built here, across
 * 17 consumer modules, resolved through `getHarnessAdminUrl()` and probed nothing.
 *
 * That is precisely the path WI-7180 measured. Generations 1 and 2 cannot see it, and the
 * reason is exact rather than incidental: both reason about the ADDRESS. On 2026-08-02 the
 * impostor was alive, listening and freshly migrated, so every address-shaped check passed
 * and the reads were simply answered by the wrong cluster.
 *
 * ## Why the probe fires per BUILD rather than per call
 *
 * A build happens exactly twice: once lazily at first use, and again whenever
 * {@link endStalePool} observes the resolved URL has MOVED. The second case is the capture
 * itself, so probing at build covers the transition without adding a round-trip to the hot
 * path. The first case is just as load-bearing: it establishes the pin from whatever this
 * process legitimately started on, and a pin that is never established cannot later
 * disagree — which is why `connection.ts` probes every managed pool rather than only
 * discovery-sourced ones.
 *
 * ## Fail-soft, in both directions
 *
 * Fire-and-forget and fully swallowed: the probe can neither delay nor fail the pool it is
 * observing, preserving this accessor's synchronous contract. An unreadable result yields
 * `indeterminate` and changes nothing — the same rule already load-bearing in the generic
 * resolver's `listeningPorts()`: a check that cannot run must never reject a healthy
 * configuration. Only two successfully-read, genuinely different identities are a violation.
 *
 * DETECT, not refuse. The verdict latches in the shared state machine and surfaces on
 * `dev:pg_health`; it deliberately does not throw, so wiring this seam in cannot turn a
 * misconfiguration into an outage.
 */
function probeStoreIdentity(sql: Sql, label: string, url: string): void {
  try {
    void Promise.resolve(sql.unsafe(STORE_IDENTITY_SQL))
      .then((rows: unknown) => {
        const verdict = pinOrVerifyStoreIdentity(parseStoreIdentity(rows), url);
        if (verdict.kind === 'mismatch') {
          console.error(
            `${describeStoreIdentityMismatch(verdict.pinned, verdict.observed)}\n  pool: ${label}`,
          );
        }
      })
      .catch(() => {
        // fail-soft — a probe error must never affect the pool it is observing
      });
  } catch {
    // fail-soft — e.g. a driver without `.unsafe` (test doubles); never break the caller
  }
}

/**
 * Get (or lazily build) the long-lived admin pool registered under `label`, rebuilding it
 * if the resolved admin URL has moved since it was built.
 *
 * @param label stable identifier — also the `pcusp:<label>:p<pid>` application_name.
 * @param extra per-site postgres options (`max`, `prepare`, …); spread last, so it wins.
 */
export function getLongLivedAdminPool(label: string, extra?: PoolExtras): Sql {
  const url = getHarnessAdminUrl();
  const cached = _pools.get(label);
  if (cached) {
    // The whole point: compare against what the pool was BUILT with, not what
    // resolution last decided. Returns false (and does nothing) when they agree.
    if (!endStalePool(cached.sql, cached.url, url, label)) return cached.sql;
    _pools.delete(label);
  }
  const sql = postgres(url, {
    ...longLivedPoolConnectionOptions(label),
    idle_timeout: poolIdleTimeoutSec(),
    ...extra,
  });
  _pools.set(label, { sql, url });
  // Generation 3 — see probeStoreIdentity. Runs on the first build AND on every rebind,
  // which is the transition a store capture actually presents as.
  probeStoreIdentity(sql, label, url);
  return sql;
}

/** The URL a label's pool is currently bound to (diagnostics/tests); null if unbuilt. */
export function boundAdminPoolUrl(label: string): string | null {
  return _pools.get(label)?.url ?? null;
}

/** Test-only — drops the registry so a test can observe a rebuild across URL changes. */
export function _resetLongLivedAdminPoolsForTests(): void {
  _pools.clear();
}
