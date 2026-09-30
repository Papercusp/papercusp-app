/**
 * _baseline-coord-fixture.ts — shared wiring for the coordination-area
 * *.integration.test.ts files (BRIEF-test-coverage-fu-coordination-federation-area:
 * coord-inbox-bus producer, presence.sweepStalePresence, topics-feed).
 *
 * NOT a test file (no `.test.ts` suffix → the layered glob never collects it).
 * It points the coordination modules' OWN connections at the integration-tier
 * baseline-schema DB that `baseline-schema.globalSetup` stood up (the same DB the
 * plans/cross_harness suites `inject('baselineSchemaDsn')` against). Those modules
 * resolve their PG from env at call time:
 *   - getOrgPg()           — the peek / sweep / tag-enrich reads (harness_app)
 *   - getHarnessAdminUrl() — the coord-inbox-bus LISTEN connection  (harness_admin)
 * so we re-point both env URLs and drop every memoized URL/pool so the next call
 * rebuilds against the baseline DB.
 *
 * Mirrors agent-tools/plans/__tests__/_pg-tool-fixture.ts, adding the
 * embedded-pg-discovery URL-cache reset that the LISTEN resolver memoizes
 * separately from the db-org connection cache.
 *
 * The injected DSN connects as the container superuser (`it_admin`); the
 * globalSetup also created the convention `harness_app` (RLS-subject) +
 * `harness_admin` (superuser) roles, so we re-point exactly as embedded-pg + the
 * dev box wire them. The returned `admin` client (harness_admin, RLS-bypassing)
 * is for direct seed/cleanup of the shared coord tables.
 */
import { inject } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import {
  acquireBaselineSchemaMutex,
  releaseBaselineSchemaMutex,
} from '@papercusp/test-config/baseline-schema-mutex';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes (not re-exported from the index)
import { _resetUrlCacheForTests } from '../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from './embedded-pg-discovery';

export interface BaselineCoordFixture {
  /** Admin (superuser, RLS-bypassing) client for seed/cleanup of the shared coord tables. */
  admin: postgres.Sql;
  /** Tear down: close the admin client + reset every cached pool/URL the modules memoized. */
  dispose: () => Promise<void>;
}

function withUser(dsn: string, user: string, password: string): string {
  const u = new URL(dsn);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * Cross-process mutex serializing every consumer of THIS fixture
 * (EI-18683737202696167). `baselineSchemaDsn` is ONE Postgres container
 * `.withReuse()`d by every concurrent Vitest process on the box (all
 * packages, all fleet agents at once — see baseline-schema-global-setup.ts),
 * and every consumer of this fixture directly TRUNCATEs GLOBAL
 * `harness_shared` tables (coord_presence, plan_item_claims,
 * plan_item_assignments, coord_event_log, adv_sessions, coord_links,
 * pending_wakes, fleet_membership_events, …) in its own `beforeEach` — so two
 * files using this fixture AT THE SAME TIME on the same box race each
 * other's truncate → seed → assert cycles: one file's INSERTs land inside
 * another's read window, surfacing as unexplained extra rows/agentIds the
 * reading file never seeded itself (observed live:
 * assignments.integration.test.ts polluted by
 * stalled-claim-collector.integration.test.ts's `su-held-holder` /
 * `su-stalled-holder` seeds, both via `coord_presence`).
 *
 * A Postgres SESSION-level advisory lock — held on a dedicated single
 * connection from `setupBaselineCoordFixture()` until `dispose()` — makes
 * only one such file active against the shared tables at a time. This is a
 * root-cause fix for the WHOLE CLASS (every current + future consumer of
 * this one fixture), not a per-file patch. Session-scoped locks self-heal on
 * a crash (Postgres releases the lock the instant the holding connection
 * dies), so a killed/OOM'd process can never wedge every other file. The
 * acquire is budget-bounded (not an unbounded blocking `pg_advisory_lock`)
 * so a genuinely-stuck holder surfaces as a clear timeout instead of hanging
 * the fleet's test run forever.
 *
 * ⚠ THE LOCK ITSELF NOW LIVES IN `@papercusp/test-config/baseline-schema-mutex`,
 * not here. It protects the reused CONTAINER's global tables, not this module, and
 * consumers outside this fixture (apps/operator's psu-launcher/psu-resume suites hit
 * the same `harness_shared.adv_sessions` from a separate process) must be able to take
 * the SAME lock. Publishing it at the level of the shared resource is what closes that
 * hole; `libs/test-config/src/baseline-schema-mutex-coverage.test.ts` is the guard.
 */
async function acquireFixtureMutex(dsn: string): Promise<postgres.Sql> {
  return acquireBaselineSchemaMutex(dsn, { label: 'setupBaselineCoordFixture' });
}

async function releaseFixtureMutex(lockClient: postgres.Sql): Promise<void> {
  await releaseBaselineSchemaMutex(lockClient);
}

/**
 * Re-point the coordination modules at the injected baseline DB + hand back an
 * admin client. Call once in `beforeAll`.
 */
export async function setupBaselineCoordFixture(): Promise<BaselineCoordFixture> {
  const dsn = inject('baselineSchemaDsn');

  // EI-2627: globalSetup's own health check (EI-2433) ran once, potentially
  // minutes before this beforeAll — long enough on a heavily-loaded fleet box
  // for a transient startup blip, or (rarer) real reaping/recycling of the
  // shared baseline container. Confirm reachability with a bounded retry
  // before repointing env vars, so a genuine failure surfaces as an actionable
  // "this is known local-environment churn" error instead of a cryptic raw
  // "no such database: papercusp_it" deep inside a later query.
  await assertPgReachable(dsn, 'setupBaselineCoordFixture');
  if (process.env.PAPERCUSP_DEBUG_FIXTURE_DSN === '1') {
    const u = new URL(dsn);
    console.error(`[DEBUG_FIXTURE_DSN] pid=${process.pid} host=${u.host} db=${u.pathname}`);
  }

  // EI-18683737202696167: serialize against every OTHER file using this
  // fixture (see the doc comment on acquireFixtureMutex) BEFORE we truncate
  // or seed anything against the shared tables.
  const lockClient = await acquireFixtureMutex(dsn);

  // The injected DSN points at a throwaway testcontainer with NO PgBouncer in front. On a
  // SERVER-class host (the dev box / a dedicated CI server), pgbouncerEnabled() derives ON from
  // hostClass even with PAPERCUSP_PGBOUNCER unset — so getOrgPg()'s maybePgbouncer() would rewrite
  // these reads to 127.0.0.1:6432 (the box's pooler), connecting to the WRONG Postgres and tripping
  // a FATAL 08P01 (protocol violation) under transaction pooling. Force the kill-switch OFF + skip
  // PG discovery so getOrgPg honours the env DSN's host:port verbatim. (Same guard the
  // feature-content-federation integration test uses; the symptom is dev-box-only because CI hosts
  // are workstation-class, so the suite is green there and red here.)
  const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
  const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  const prevReadLinesCache = process.env.PAPERCUSP_COORD_READLINES_CACHE;
  const prevReadEventsCache = process.env.PAPERCUSP_COORD_READEVENTS_CACHE;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  // WI-3937/WI-3993's readLines/readEvents in-process caches are built for an
  // append-only table with rare, eventually-consistent-after-5-min-TTL GC
  // deletes — NOT for a table that gets hard TRUNCATEd between test cases (as
  // every consumer of this fixture's `admin` client does, via `beforeEach`
  // seed-isolation). A cache entry surviving a TRUNCATE still holds the
  // PRE-truncate rows; the next delta read then finds the SAME msg_id
  // reinserted at a fresh `id` and APPENDS it (dedup is by `id`, not
  // `msg_id`), producing a phantom duplicate envelope for the remainder of
  // the test file's 5-minute TTL window (EI-9450 — readInbox pushdown vs.
  // reference() went out of sync because reference()'s readLines() call hit
  // this stale cache while the SQL fast path always reads fresh). Disable
  // both caches for the coordination integration-test fixture: no test using
  // this fixture exercises the cache mechanism itself (that lives in
  // event-log-conformance.test.ts, which does not use this fixture), so the
  // kill switches are a safe, zero-behavior-change fix scoped to the actual
  // root cause (test-only TRUNCATE isolation colliding with a
  // production-shaped cache assumption) rather than the individual test.
  process.env.PAPERCUSP_COORD_READLINES_CACHE = '0';
  process.env.PAPERCUSP_COORD_READEVENTS_CACHE = '0';
  process.env.HARNESS_DATABASE_URL = withUser(dsn, 'harness_app', 'harness_app_pwd');
  process.env.HARNESS_ADMIN_DATABASE_URL = withUser(dsn, 'harness_admin', 'harness_admin_pwd');
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  await _resetForTests();

  const admin = postgres(withUser(dsn, 'harness_admin', 'harness_admin_pwd'), {
    max: 4,
    onnotice: () => {},
    connection: { search_path: 'harness_shared, papercusp_shared, public' },
  });

  const dispose = async () => {
    await admin.end({ timeout: 5 }).catch(() => {});
    delete process.env.HARNESS_DATABASE_URL;
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    if (prevReadLinesCache === undefined) delete process.env.PAPERCUSP_COORD_READLINES_CACHE;
    else process.env.PAPERCUSP_COORD_READLINES_CACHE = prevReadLinesCache;
    if (prevReadEventsCache === undefined) delete process.env.PAPERCUSP_COORD_READEVENTS_CACHE;
    else process.env.PAPERCUSP_COORD_READEVENTS_CACHE = prevReadEventsCache;
    _resetUrlCacheForTests();
    _resetHarnessAdminUrlCacheForTests();
    await _resetForTests();
    // EI-18683737202696167: release the shared-fixture mutex LAST, once this
    // file's env/cache state is fully torn down, so the next waiter's
    // truncate/seed cycle never overlaps this file's cleanup.
    await releaseFixtureMutex(lockClient);
  };

  return { admin, dispose };
}
