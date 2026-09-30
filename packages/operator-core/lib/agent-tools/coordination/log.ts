/**
 * log.ts — the operator's single CoordEventLog instance. Every extracted
 * channel module (messages, handoffs, escalations, plan-events) reads/writes
 * through this one seam.
 *
 * Backend: `PgCoordLog` over the org embedded-pg handle —
 * `harness_shared.coord_event_log`, workspace-scoped (default 'default',
 * parity with coord_presence). This is the FS→PG cutover
 * (coord-channels-pg-port P-005 / D-001 / D-002): channels now live in
 * Postgres alongside presence, not in `coord/*.jsonl`. The two host seams
 * are injected exactly as presence.ts wires PgPresenceStore — the org PG
 * handle (`getSql`) and the flag-gated table bootstrap (`ensureSchema`).
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { PgCoordLog, DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { CoordEventLog } from '@papercusp/coordination/event-log';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { activeWorkspaceId } from '../../workspace-registry';
import { systemDistinctId } from '../../flag-distinct-id';

// workspace-data-isolation-leaks-2026-06-17 F-C1: scope the coord plane to the
// ACTIVE workspace instead of the single shared `default` partition — flag-gated
// (papercusp-coord-per-workspace). DEFAULT ON — the cutover COMPLETED and is
// graduated (corrected 2026-07-12, WI-4238/EI-1548: this comment used to say
// "default OFF — reversible kill-switch", which is now stale — see
// FLAGS.COORD_PER_WORKSPACE's own comment in libs/flags/src/types.ts for the
// live corpus numbers that make flipping it OFF a DATA-STRANDING move, not a
// safe restore). The PgCoordLog resolver must be SYNC, so cache the flag
// (machine-global) refreshed on an initial read + every flag change — exactly
// the lexicon/configure.ts pattern.
//
// WI-6588: the unloaded state used to be a hardcoded `false` ⇒ `'default'` —
// the DEAD pre-cutover partition. That is the OPPOSITE of what the flag
// actually resolves to: `FLAG_DEFAULTS` is derived as `!DARK_FLAGS.has(key)`
// and COORD_PER_WORKSPACE is graduated (not dark), so its default is ON. Every
// coord read landing before the fire-and-forget refresh resolved therefore read
// a partition with zero rows and reported it as an empty log with `error:null`
// — indistinguishable from "no mail". Measured: with a 300ms override-store
// load (the operator installs a PG-backed one in flag-bus.ts, so `getFlag`
// does real I/O), 4 of 6 sampled reads over the first 400ms resolved to
// `'default'`. It is a RACE on `getFlag` latency, not a deterministic first
// call — which is exactly why it corrupted verification: a single-shot probe
// can pass for the wrong reason.
//
// Two independent guards, because they cover different callers:
//  1. seed the cache from the flag's OWN DEFAULT, so the sync resolver's
//     unloaded answer matches the resolved one in every deployment that has not
//     overridden the flag (and a `getFlag` FAILURE falls back there too, rather
//     than to the dead partition);
//  2. `coordScopeReady()` — awaited by every `coordLog` method below — so the
//     async path does not guess at all.
//
// EI-18825928993608425: every line below that touches the flags surface is
// reached through `ensureCoordFlagInit()` — NEVER at module scope. Importing
// this module must have no load-time side effect, because the coord graph is
// transitively imported by a large and GROWING set of suites, and a module-scope
// read of a NAMED export makes the whole module un-importable under a partial
// `vi.mock('@papercusp/flags')` that omits it. That fails at COLLECTION time, so
// it reds the entire suite (and therefore the fleet's gate), not one test.
//
// This has now fired TWICE on this same file, from two different exports:
// `onFlagChange` (WI-6449) and then `FLAG_DEFAULTS` (WI-6588 → 2 suites red on
// 2026-07-28). The census is why it keeps recurring: 89 test files mock
// flags/server without `onFlagChange` and 22 mock flags without `FLAG_DEFAULTS`
// — each one latent until its subject happens to grow a coord import, a change
// whose author has no reason to connect it to a flags mock they never touched.
// Patching mocks treats the symptom N times; this removes the coupling once.
const COORD_PER_WORKSPACE_DEFAULT = (): boolean => FLAG_DEFAULTS[FLAGS.COORD_PER_WORKSPACE];
/** null until `ensureCoordFlagInit()` seeds it from the flag's own default. */
let coordPerWorkspaceOn: boolean | null = null;
let coordFlagLoaded = false;
let coordFlagFirstLoad: Promise<void> | null = null;
let coordFlagInitDone = false;

/**
 * Idempotent lazy init — the ONLY place this module touches the flags surface.
 *
 * Seeds the sync cache from the flag's own default and subscribes to changes,
 * exactly as the old module-scope code did, but on FIRST USE rather than on
 * import. Production behavior is unchanged: every `coordLog` method already
 * awaits `coordScopeReady()`, so no coord read is ever scoped by an assumed
 * value — the flag load simply starts at the first coord call instead of at
 * import. A consumer that imports the coord graph without ever using it (which
 * is exactly what a transitively-importing test suite does) now touches nothing.
 */
function ensureCoordFlagInit(): void {
  // Set FIRST: `coordScopeReady()` below calls back into this function, and the
  // flag is what makes that re-entrancy terminate.
  if (coordFlagInitDone) return;
  coordFlagInitDone = true;
  // SEED ONLY IF UNRESOLVED (`??=`, never `=`). `refreshCoordPerWorkspace()` is
  // exported and may already have resolved a REAL value before the first call
  // that inits us — a plain assignment here silently clobbers it back to the
  // default. That is not hypothetical: it reds log.test.ts's "flag is OFF" case,
  // which sets an override, awaits the refresh, and then reads the scope.
  coordPerWorkspaceOn ??= COORD_PER_WORKSPACE_DEFAULT();
  onFlagChange((key) => {
    if (key === null || key === FLAGS.COORD_PER_WORKSPACE) void refreshCoordPerWorkspace();
  });
  void coordScopeReady();
}
/**
 * Re-read the COORD_PER_WORKSPACE flag into the sync cache. Fired on an initial
 * read + every flag change (the lexicon/configure.ts pattern). Exported so tests
 * can drive the cache DETERMINISTICALLY (set a flag override → await this →
 * assert) instead of racing the fire-and-forget module-load refresh — which is
 * brittle once the flag's DEFAULT flips (it graduated default-ON in WI-599).
 */
export async function refreshCoordPerWorkspace(): Promise<void> {
  try {
    coordPerWorkspaceOn = await getFlag(FLAGS.COORD_PER_WORKSPACE, systemDistinctId());
  } catch {
    // WI-6588: fall back to the flag's DEFAULT, never to the dead 'default'
    // partition — an unreachable flag store must not silently re-point coord at
    // a partition the cutover retired.
    coordPerWorkspaceOn = COORD_PER_WORKSPACE_DEFAULT();
  } finally {
    coordFlagLoaded = true;
  }
}
/**
 * Resolves once the flag cache has been loaded at least once (WI-6588).
 *
 * Every `coordLog` method awaits this before delegating, so no coord read or
 * write is ever scoped by a merely-assumed flag value. After the first load it
 * is a resolved promise — one microtask, no I/O. Exported so a caller doing its
 * OWN targeted `coord_event_log` query through `coordWorkspaceId()`/`coordSql()`
 * can take the same guarantee.
 */
export function coordScopeReady(): Promise<void> {
  ensureCoordFlagInit();
  if (coordFlagLoaded) return Promise.resolve();
  coordFlagFirstLoad ??= refreshCoordPerWorkspace();
  return coordFlagFirstLoad;
}

/** The coord scope to use NOW (F-C1): the request's active workspace when the
 *  flag is ON, else the legacy shared `default` partition. Before the flag cache
 *  has loaded this answers from the flag's DEFAULT rather than assuming OFF
 *  (WI-6588) — an unloaded cache must not silently name a retired partition. */
export function coordScopeWorkspace(): string {
  // Seeds the cache from the flag's own default on the very first call, so the
  // sync answer here is the flag's DEFAULT (never a hardcoded/dead partition)
  // even before the async refresh has resolved — the WI-6588 guarantee, now
  // established on first use instead of at import.
  ensureCoordFlagInit();
  return coordPerWorkspaceOn ? activeWorkspaceId() : DEFAULT_COORD_WORKSPACE;
}

function makeDefaultLog(): CoordEventLog {
  return new PgCoordLog({
    getSql: () => getOrgPg().sql,
    // Tables are defined by the migration baseline now; the host seam is a no-op.
    ensureSchema: async () => {},
    // F-C1: resolve the workspace per call (flag-gated) so one operator coordLog
    // scopes coord to the request's workspace instead of one shared partition.
    getWorkspaceId: () => coordScopeWorkspace(),
  });
}

let impl: CoordEventLog = makeDefaultLog();

/**
 * Swap the backing CoordEventLog. Tests inject `new InMemoryCoordLog()` so the
 * channel modules exercise the real fold logic without touching — and
 * polluting — the live `harness_shared.coord_event_log`. Call `resetCoordLog()`
 * in afterEach to restore the PG backend.
 */
export function configureCoordLog(next: CoordEventLog): void {
  impl = next;
}

/** Restore the default PgCoordLog backend (afterEach in tests). */
export function resetCoordLog(): void {
  impl = makeDefaultLog();
}

/**
 * The operator's single CoordEventLog seam. A stable object that delegates to
 * the currently-configured backend, so the channel modules can `import
 * { coordLog }` once while tests swap the implementation underneath.
 *
 * Every method awaits {@link coordScopeReady} first (WI-6588). The seam is
 * async, but the workspace resolver underneath it is SYNC, so without this a
 * read issued before the flag cache loaded was scoped by an ASSUMED flag value
 * — and answered from the retired `'default'` partition with `error:null`. One
 * already-resolved promise per call once loaded; no I/O.
 */
export const coordLog: CoordEventLog = {
  appendLine: async (surface, writerKey, line) => {
    await coordScopeReady();
    return impl.appendLine(surface, writerKey, line);
  },
  appendLineIfAbsent: async (surface, writerKey, line) => {
    await coordScopeReady();
    return impl.appendLineIfAbsent(surface, writerKey, line);
  },
  readLines: async (surface, opts) => {
    await coordScopeReady();
    return impl.readLines(surface, opts);
  },
  putEvent: async (surface, msgId, record) => {
    await coordScopeReady();
    return impl.putEvent(surface, msgId, record);
  },
  putEventIfAbsent: async (surface, msgId, record) => {
    await coordScopeReady();
    return impl.putEventIfAbsent(surface, msgId, record);
  },
  putEvents: async (surface, records) => {
    await coordScopeReady();
    return impl.putEvents(surface, records);
  },
  readEvents: async (surface) => {
    await coordScopeReady();
    return impl.readEvents(surface);
  },
  readEventsBounded: async (surface, opts) => {
    await coordScopeReady();
    return impl.readEventsBounded(surface, opts);
  },
  readLinesBounded: async (surface, opts) => {
    await coordScopeReady();
    return impl.readLinesBounded(surface, opts);
  },
  getEvent: async (surface, msgId) => {
    await coordScopeReady();
    return impl.getEvent(surface, msgId);
  },
  readEventsBoundedCursor: async (surface, opts) => {
    await coordScopeReady();
    return impl.readEventsBoundedCursor(surface, opts);
  },
  readLinesBoundedCursor: async (surface, opts) => {
    await coordScopeReady();
    return impl.readLinesBoundedCursor(surface, opts);
  },
};

/**
 * The coordination workspace the currently-configured backend reads/writes.
 * A caller running its OWN targeted `coord_event_log` query (e.g.
 * readAckedMsgIds' fast path) scopes it to THIS workspace so it stays
 * consistent with `coordLog.readLines` / `appendLine` — never assuming
 * `'default'`. PG backends expose `workspaceId`; the in-memory double and any
 * other generic backend don't, so fall back to the default scope.
 */
export function coordWorkspaceId(): string {
  return (impl as Partial<{ workspaceId: string }>).workspaceId ?? DEFAULT_COORD_WORKSPACE;
}

/**
 * The postgres handle the currently-configured backend reads/writes. A targeted
 * `coord_event_log` query (e.g. readAckedMsgIds' fast path) must run on THIS
 * handle — in production it's `getOrgPg().sql`, but a swapped seam (tests, a
 * non-default backend) points at a different DB, so reaching for `getOrgPg()`
 * independently would query the wrong database. Backends without a PG handle
 * (the in-memory double) fall back to `getOrgPg().sql` — those tests don't drive
 * the PG fast path.
 */
export function coordSql(): Sql {
  const maybe = impl as Partial<{ getSql: () => Sql }>;
  return typeof maybe.getSql === 'function' ? maybe.getSql() : getOrgPg().sql;
}

/**
 * Whether the currently-configured backend is the PG one — i.e. a targeted
 * `coord_event_log` query through `coordSql()` will hit the SAME store the seam
 * reads/writes. A swapped seam without a PG handle (the in-memory / fs double
 * used in tests) returns false: there `coordSql()` falls back to `getOrgPg()`,
 * which is a DIFFERENT (empty/unrelated) store, so a raw fast-path query would
 * silently return zero rows instead of the double's seeded data. Callers running
 * an EI-401-style SQL pushdown (readInbox / readAckedMsgIds) gate on this so the
 * pushdown is taken ONLY when it's guaranteed to read the seam's own store, and
 * the in-memory/fs seam keeps using the seam's `readLines` (correct, just slower).
 */
export function coordHasPgFastPath(): boolean {
  return typeof (impl as Partial<{ getSql: () => Sql }>).getSql === 'function';
}
