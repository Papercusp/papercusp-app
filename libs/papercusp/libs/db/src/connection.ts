/**
 * Postgres connection layer for the harness store.
 *
 * Backing DB: `papercusp` on the same Postgres instance Paperclip uses.
 * Schemas: `harness_shared` (cross-cutting) + `harness_<slug>` (per-harness).
 *
 * Two client surfaces:
 *   - getOrgPg()              → admin client (search_path = harness_shared, public);
 *                               use for cross-harness reads/writes (UNION views,
 *                               projects, messages).
 *   - getHarnessPg(slug)      → per-harness client (search_path = harness_<slug>,
 *                               harness_shared, public); unqualified
 *                               `harness_features` resolves to that harness's table.
 *
 * Both expose:
 *   - `.sql`        — the postgres-js template tag (raw SQL, async)
 *   - `.drizzle`    — Drizzle ORM instance bound to the same client
 *
 * `getOrgPgListener()` exposes a separate direct admin connection for LISTEN-only
 * consumers. It must not be routed through the transaction pooler: PgBouncer can
 * discard asynchronous NotificationResponse packets when a transaction-pooled
 * server connection is no longer linked to its client.
 *
 * Connection URL:
 *   $HARNESS_DATABASE_URL  (defaults to harness_app role on localhost)
 */
import { createRequire } from 'node:module';
import postgres, { Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as sharedSchema from './schema';
import {
  describeStoreIdentityMismatch,
  parseStoreIdentity,
  pinOrVerifyStoreIdentity,
  _resetStoreIdentityForTests,
} from './store-identity';
import { getResourceProfile } from '../../../../../packages/operator-core/lib/resource-profile';
// Pure helper (no host config needed — takes explicit args), so the generic lib
// directly. The configured binding above is used for the memoized profile.
import { boundedOrgPoolMax } from '@papercusp/resource-profile';
// EI-19485014132257783: this process's own acquisition counters, so a deadline
// error can LEAD with measured numbers instead of a 3-step manual probe that
// itself queues behind the saturated pool it is meant to diagnose.
import {
  ACQUIRE_QUEUE_LOCATION_RESIDUAL,
  beginAcquire,
  describeAcquirePressure,
  createPgDiagnosticHooks,
  recordPoolMax,
} from './acquire-registry';
import { stampedTag } from './build-stamp';

// This package is `"type": "module"`, so ESM has no ambient `require`.
// `createRequire` gives us a synchronous loader for the lazy node-builtin
// reads below (kept lazy so the module can be imported without touching
// the filesystem in a no-fs environment).
//
// LAZY CREATION (not just lazy USE): calling `createRequire(import.meta.url)` at
// MODULE SCOPE crashes any non-node consumer of this module. The operator SPA
// pulls connection.ts in via the route tree and externalizes `node:module` for the
// browser (→ `createRequire` is undefined), so an EAGER top-level call threw at
// module eval — "createRequire is not a function" — and blanked the ENTIRE desktop
// app on load. Defer the createRequire to first use so importing this module is
// browser-safe; the node-builtin reads below only ever run server-side. (Mirrors
// the same lazy pattern in resource-profile/src/index.ts.)
let _nodeRequire: ReturnType<typeof createRequire> | undefined;
const nodeRequire = (id: string): unknown =>
  (_nodeRequire ??= createRequire(import.meta.url))(id);
import * as generatedSchema from './schema/generated';
import * as generatedRelations from './schema/generated-relations';
// EI-9265 / EI-13076 / EI-18698602043482898: the bigint-as-number type shape
// and the raw Date/jsonb serializer restorers live in `./raw-serializers`
// (deliberately dependency-free of `drizzle-orm`) so test fixtures that must
// avoid pulling in `drizzle-orm/postgres-js` (see
// `packages/operator-core/test/_org-test-db.ts`'s docstring) can import them
// directly. Re-exported here for existing consumers of `./connection` /
// the package barrel.
import {
  PG_BIGINT_AS_NUMBER_TYPES,
  PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  PG_TIMESTAMPTZ_AS_STRING_TYPES,
  restoreRawDateSerializers,
  restoreRawJsonbSerializer,
  seedBuiltinArrayTypes,
  installNumericArrayTyping,
} from './raw-serializers';
export {
  PG_BIGINT_AS_NUMBER_TYPES,
  PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  PG_TIMESTAMPTZ_AS_STRING_TYPES,
  restoreRawDateSerializers,
  restoreRawJsonbSerializer,
  // WI-41207: hand-rolled clients that must BEHAVE like the canonical ones (test fixtures,
  // conformance suites, one-off scripts) call this for the same reason they call the two above.
  seedBuiltinArrayTypes,
  // EI-21301868186403490: same reason — a hand-rolled client otherwise sends number arrays as text[].
  installNumericArrayTyping,
};

// The `./schema` barrel re-exports `generated` + `generatedRelations` as nested
// namespace objects (so callers can `import { generated } from '@papercusp/db-org'`).
// Those nested namespaces are NOT Tables/Relations — handing them inside a
// `drizzle({ schema })` map makes drizzle's relational-config extraction read
// `.constructor` off a non-table object and crash with
// "Cannot read properties of null (reading 'constructor')". Strip them so the
// schema drizzle sees is table/relation-only; direct importers still get the
// namespaces straight from the barrel.
const { generated: _omitGeneratedNs, generatedRelations: _omitGeneratedRelationsNs, ...sharedTables } = sharedSchema;
void _omitGeneratedNs;
void _omitGeneratedRelationsNs;

// Merged schema for the typed Drizzle instance (`.db`). Includes all
// 125 introspected tables + their relation graph + the hand-written
// per-harness factory helpers. Drizzle deduplicates identically-named
// table refs internally; the hand-written `auditLog`/`projects`/etc.
// shadow the same PG tables that `generated.audit_logInHarness_shared`
// covers, which is fine — both accessors point at the same rows.
const fullSchema = {
  ...sharedTables,
  ...generatedSchema,
  ...generatedRelations,
};

// Read env at connection time so test fixtures (which set
// HARNESS_DATABASE_URL after this module is imported) take effect.
//
// Resolution chain (added 2026-05-12 — superseded the bare native fallback):
//   1. Explicit env (HARNESS_DATABASE_URL / HARNESS_ADMIN_DATABASE_URL,
//      then DATABASE_URL as an endpoint pin — admin DSN as-is, app role
//      re-keyed onto its host:port). Set by Tauri main when spawning the
//      desktop sidecar, and by every managed host's systemd unit — that
//      path always wins.
//   2. Discovery file at $HOME/.papercusp/embedded-pg.json — written
//      by the desktop's Rust main on embedded-PG ready, deleted on
//      shutdown. Lets `apps/operator npm run dev` (no env set) share
//      the SAME embedded PG the desktop is running.
//   3. Native :5432 fallback — only when neither (1) nor (2) is
//      available. Same string as before so nothing breaks for users
//      who don't run the desktop.
//
// Cached per-process so we don't fs-stat every connection. Re-reading
// would also produce stale results when the desktop port changes
// across restarts — env-set callers (Tauri sidecar) get a fresh module
// load anyway.
let _resolvedAppUrl: string | null = null;
let _resolvedAppUrlSource: 'env' | 'discovery' | null = null;
let _resolvedAdminUrl: string | null = null;
let _resolvedAdminUrlSource: 'env' | 'discovery' | null = null;
// Test resets intentionally rotate this process between independent Postgres clusters. Identity
// probes are fire-and-forget, so closing an old pool cannot guarantee its already-issued probe's
// `.then` callback runs before the replacement pool is built. Fence those pre-reset callbacks or
// they can poison the replacement generation with a correctly-read but now-stale identity.
// Production never calls `_resetForTests`, so its process-lifetime identity contract is unchanged.
let _identityProbeTestGeneration = 0;
/**
 * `appPassword` is harness_app's password when the advertiser keys roles to per-host
 * secrets (a multi-account hosted VM, WI-10003627); absent ⇒ the DEV default applies.
 */
export type DiscoveryEndpoint = {
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  appPassword?: string;
};

/** harness_app's password from an advertised `appUrl`, or undefined. */
function appPasswordFromUrl(appUrl: unknown): string | undefined {
  if (typeof appUrl !== 'string' || !appUrl) return undefined;
  try {
    const u = new URL(appUrl);
    return u.password ? decodeURIComponent(u.password) : undefined;
  } catch {
    return undefined;
  }
}

/** Is `pid` still running? Injected into _parseDiscoveryJson so tests stay pure. */
export function _defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ the process exists, we just don't own it. Anything else ⇒ gone.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Is `port` actually in LISTEN state right now? Injected into
 * _parseDiscoveryJson (mirrors _defaultIsPidAlive) so tests stay pure.
 *
 * EI-19384906720464601: this is the port-listening gate `libs/generic/embedded-pg-discovery`
 * already carries (`isDiscoveredPortServed`, landed 2026-08-01 after a measured outage — a
 * discovery file's writer pid was alive, nothing was listening on its advertised port, and
 * the pid-only gate waved every consumer straight into an ECONNREFUSED storm). connection.ts
 * is the resolver behind `getOrgPg()` — the hottest DB read path — and had NO port gate at
 * all, so the same failure mode was uncaught on the highest-traffic caller.
 *
 * DELIBERATELY DUPLICATED rather than imported from `@papercusp/embedded-pg-discovery`: that
 * package statically `import`s `node:fs` at module scope, and this file's `nodeRequire` lazy-
 * require pattern above exists SPECIFICALLY because an eager Node-only import here has
 * previously blanked the entire desktop app (see the comment on `nodeRequire`) — the operator
 * SPA pulls this module in via the route tree and externalizes `node:module`/`node:fs` for the
 * browser. Importing the generic package would reintroduce that exact crash. A full collapse
 * of connection.ts's resolver onto the generic one (this function's real fix) is tracked
 * separately — it also has to carry PgBouncer rerouting, the PAPERCUSP_PG_PORT early-boot
 * fallback, and this file's own caching/pool-invalidation semantics, which is why it wasn't
 * folded into this narrower parity fix (see EI-19384906720464601's own body for the reasoning).
 *
 * Same /proc/net/tcp{,6} LISTEN scan as the generic lib's `listeningPorts()`. Linux-only by
 * construction (/proc); everywhere else this declines to judge (returns true) rather than
 * reject a healthy config, matching the generic lib's degradation contract.
 */
export function _defaultIsPortServed(port: number): boolean {
  try {
    const fs = nodeRequire('node:fs') as typeof import('node:fs');
    const TCP_LISTEN = '0A';
    // Read BOTH tcp and tcp6: a server bound to `::` (dual-stack, the common default)
    // appears ONLY in tcp6, so checking tcp alone would report a perfectly healthy
    // port as dead. `readAny` tracks whether /proc was readable at all, distinct
    // from "readable but the port wasn't in it".
    let readAny = false;
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let raw: string;
      try {
        raw = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      readAny = true;
      for (const line of raw.split('\n').slice(1)) {
        // sl  local_address rem_address st ...  — local_address is HEXIP:HEXPORT
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4 || cols[3] !== TCP_LISTEN) continue;
        const hexPort = cols[1]?.split(':')[1];
        if (hexPort && parseInt(hexPort, 16) === port) return true;
      }
    }
    return !readAny; // /proc unreadable → decline to judge (true); readable but absent → false
  } catch {
    return true; // /proc unavailable on this platform — decline to judge, never reject
  }
}

/**
 * Parse the embedded-pg discovery file's JSON into a connection endpoint.
 *
 * The WRITER (apps/operator/bin/serve.ts) records `{ url, port, pid, startedAt }`
 * — it has never written a `host` key. This used to gate on `parsed.host && parsed.port`,
 * which made step 2 of the resolution chain above DEAD CODE: every env-less caller fell
 * silently through to the native fallback. That is not a harmless miss —
 *   • on a dev box that also runs the desktop it selects the WRONG DATABASE (native :5432
 *     instead of the desktop's embedded PG) with no error, and
 *   • on a packaged install, which has no :5432 at all, it is ECONNREFUSED.
 * The second is how it was caught: ~200 "unit" suites reddened on a packaged install
 * (they open a pool transitively via app code) while passing on every box with a stray
 * native :5432. So parse the `url` the writer actually emits — the same field
 * libs/host-platform/src/desktop.ts already reads — and keep the legacy `{host,port}`
 * shape working for any older file still on disk.
 *
 * Exported for tests: pure apart from the injected liveness/port probes, so the shape
 * contract is pinned directly.
 */
export function _parseDiscoveryJson(
  raw: string,
  isPidAlive: (pid: number) => boolean = _defaultIsPidAlive,
  isPortServed: (port: number) => boolean = _defaultIsPortServed,
): DiscoveryEndpoint | null {
  let parsed: {
    url?: string;
    appUrl?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    pid?: number;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // STALE-FILE GUARD. serve.ts writes this file but never unlinks it (there is no
  // unlink of EMBEDDED_PG_JSON anywhere in serve.ts, despite the chain comment above
  // claiming it is "deleted on shutdown"). Now that discovery actually resolves, a
  // leftover file from a stopped desktop would point every env-less caller at a DEAD
  // port — strictly worse than the native fallback it replaced. The file records the
  // writer's pid, so ignore it once that process is gone. Files with no pid (older
  // desktops) are trusted as before.
  if (typeof parsed?.pid === 'number' && !isPidAlive(parsed.pid)) return null;
  if (parsed?.url) {
    try {
      const u = new URL(parsed.url);
      const port = Number(u.port) || Number(parsed.port);
      if (u.hostname && port) {
        // PORT-LISTENING GUARD (EI-19384906720464601, mirrors the generic resolver's
        // isDiscoveredPortServed): the pid gate above proves the writer PROCESS exists,
        // not that it is SERVING on the advertised port — the file is written at
        // startup, before the port is necessarily bound, and a bind failure leaves a
        // live pid pointing at a dead port forever. A live-pid, dead-port file passed
        // the pid-only gate and sent every consumer into an ECONNREFUSED storm
        // (measured 2026-08-01 on the generic resolver's copy of this exact bug). A
        // dead port here is treated the same as a dead pid: null, no legacy fallback
        // within this same file — there is no reason to trust a DIFFERENT host/port
        // pair from the same stale file once the primary one is confirmed dead.
        if (!isPortServed(port)) return null;
        return {
          host: u.hostname,
          port,
          // Embedded-pg uses fixed passwords; callers default them when absent.
          user: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
          appPassword: appPasswordFromUrl(parsed.appUrl),
        };
      }
    } catch {
      // unparseable url — fall through to the legacy {host,port} shape
    }
  }
  if (parsed?.port && parsed?.host) {
    if (!isPortServed(parsed.port)) return null;
    return parsed;
  }
  return null;
}

/**
 * Discovery endpoints PROVEN to be a different Postgres cluster than the one this
 * process pinned — quarantined for the process lifetime (plan
 * outage-must-not-be-silent-2026-08-02, the enforcement half of D-001).
 *
 * ## Why detection was not enough
 *
 * `validateDiscoveryTargetOnce` already identifies an impostor store by cluster
 * `system_identifier` and latches the violation. But it only ever wrote to
 * `console.error` and a diagnostic getter: NOTHING refused. So on 2026-08-02 22:40Z an
 * ephemeral operator's freshly-migrated embedded Postgres — alive, listening, and
 * schema-complete, so the pid gate, the port gate and the WI-5244 schema check all
 * PASSED — kept answering `not_found` for every record in the real store for ~13
 * minutes fleet-wide. A confident wrong answer is worse than an outage: an outage
 * announces itself, and this did not.
 *
 * The pid and port gates ask "is something there?". Identity asks "is it OURS?", and it
 * is the only one of the three an impostor cannot satisfy. Quarantining on that answer
 * is what turns the existing detection into a refusal.
 *
 * ## Why a process-lifetime Set and not a re-probe
 *
 * The discovery file FLAPS (three clusters inside one 24-minute window on 2026-08-03).
 * A check that re-trusted an endpoint as soon as it looked healthy again would readmit
 * the same impostor on its next appearance, which is the "it recovered, so there is
 * nothing to see" failure this plan exists to eliminate. Once an endpoint is proven
 * foreign, this process is done with it.
 */
const _quarantinedDiscoveryEndpoints = new Set<string>();

/**
 * `host:port` for an endpoint, normalized so the two spellings of loopback compare
 * equal. Returns null for anything unparseable — an endpoint we cannot NAME is one we
 * must never quarantine (see `quarantineDiscoveryEndpointIfProvenForeign`'s fail-soft
 * contract).
 */
function endpointKey(host: string | undefined, port: string | number | undefined): string | null {
  if (!host) return null;
  const p = String(port || NATIVE_PG_PORT);
  return `${NATIVE_PG_HOSTS.has(host) ? '127.0.0.1' : host}:${p}`;
}

function endpointKeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return endpointKey(u.hostname, u.port);
  } catch {
    return null;
  }
}

/**
 * Act on a positive store-identity mismatch by refusing the offending endpoint.
 *
 * FAIL-SOFT BY CONSTRUCTION — every uncertain path returns without quarantining, so the
 * worst case is today's detect-only behaviour, never a healthy endpoint rejected. Three
 * conditions must ALL hold:
 *
 *  1. A positive mismatch (both identities read successfully). Guaranteed by the caller:
 *     `pinOrVerifyStoreIdentity` only yields `mismatch` for two determinate reads, and
 *     `indeterminate` never reaches here.
 *  2. The OBSERVED endpoint is the one the discovery file currently advertises — i.e.
 *     this pool really is discovery-sourced. An env-pinned pool is never quarantined:
 *     env is the trusted rung, and refusing it would leave nothing to fall back TO.
 *     (`maybePgbouncer` only rewrites host:5432, so a discovery-sourced ephemeral port
 *      reaches us intact and this comparison is meaningful.)
 *  3. The PINNED endpoint is NOT that same discovery endpoint. This is the clause that
 *     keeps the fix from inverting itself: if the pin were itself established from the
 *     discovery file, quarantining "the endpoint that disagrees with the pin" would
 *     banish the REAL store and enshrine the impostor. Ordering is not guaranteed — the
 *     pin is whichever pool was probed first — so it is checked rather than assumed.
 *
 * On quarantine the affected pools are torn down explicitly. That teardown cannot be
 * left to the existing change-detection in `appUrl()`: that block lives INSIDE
 * `if (disc)`, so once discovery starts returning null the branch is skipped entirely
 * and a pool already built on the impostor would keep serving it — the fix would land
 * and do nothing.
 */
export function _quarantineDiscoveryEndpointIfProvenForeign(
  pinned: { url: string },
  observed: { url: string },
): boolean {
  const disc = readDiscoveryFile({ applyQuarantine: false });
  const discKey = disc ? endpointKey(disc.host, disc.port) : null;
  if (!discKey) return false; // no discovery endpoint in play — nothing to attribute

  const observedKey = endpointKeyFromUrl(observed.url);
  if (!observedKey || observedKey !== discKey) return false; // (2) not discovery-sourced

  const pinnedKey = endpointKeyFromUrl(pinned.url);
  if (!pinnedKey || pinnedKey === discKey) return false; // (3) the pin came from here

  if (!_quarantinedDiscoveryEndpoints.has(discKey)) {
    _quarantinedDiscoveryEndpoints.add(discKey);
    console.error(
      `[connection] QUARANTINED discovery endpoint ${discKey}: its cluster system_identifier ` +
        `differs from the one this process pinned (${pinnedKey}), so it is a DIFFERENT ` +
        `Postgres cluster, not ours. Refusing it for the lifetime of this process and ` +
        `falling back to the next resolution source. Every pool built on it is being torn ` +
        `down; the next call rebuilds. See ~/.papercusp/embedded-pg.json for the rewrite.`,
    );
  }

  // Tear down anything already built on the impostor so the next call re-resolves.
  for (const end of [_adminClient, _adminLosslessBigintClient, _appOrgClient]) {
    if (!end) continue;
    try { end.end({ timeout: 1 }).catch(() => {}); } catch {}
  }
  _adminClient = null;
  _adminDrizzle = null;
  _adminDb = null;
  _adminClientUrl = null;
  _adminLosslessBigintClient = null;
  _adminLosslessBigintClientUrl = null;
  _appOrgClient = null;
  _appOrgDrizzle = null;
  _appOrgDb = null;
  _appOrgClientUrl = null;
  // Drop the memoized decisions too, so the next appUrl()/adminUrl() re-resolves through
  // the quarantine rather than returning the impostor URL it last decided on.
  if (_resolvedAppUrlSource === 'discovery') { _resolvedAppUrl = null; _resolvedAppUrlSource = null; }
  if (_resolvedAdminUrlSource === 'discovery') { _resolvedAdminUrl = null; _resolvedAdminUrlSource = null; }
  return true;
}

/** Test-only — inspect/reset the quarantine between cases. */
export function _quarantinedDiscoveryEndpointsForTests(): string[] {
  return [..._quarantinedDiscoveryEndpoints];
}
export function _resetDiscoveryQuarantineForTests(): void {
  _quarantinedDiscoveryEndpoints.clear();
}

function readDiscoveryFile(opts?: { applyQuarantine?: boolean }): DiscoveryEndpoint | null {
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1') return null;
  try {
    // Lazy require so this module can be imported in environments
    // without `node:fs` (browser, edge runtime). The drizzle/postgres
    // path is server-only in practice but be defensive.
    const fs = nodeRequire('node:fs') as typeof import('node:fs');
    const os = nodeRequire('node:os') as typeof import('node:os');
    // EI-13917: honor PAPERCUSP_HOME (the established isolation escape hatch —
    // packages/operator-core/lib/papercusp-root.ts) before the box-wide
    // `~/.papercusp`, mirroring the matching writer-side fix in
    // apps/operator/bin/serve.ts. A caller that scoped its OWN PAPERCUSP_HOME
    // (an isolated gate/smoke-test instance) should discover ITS OWN
    // embedded-pg.json, never accidentally pick up the box-canonical one.
    const papercuspDir = process.env.PAPERCUSP_HOME || `${os.homedir()}/.papercusp`;
    const path = `${papercuspDir}/embedded-pg.json`;
    const endpoint = _parseDiscoveryJson(fs.readFileSync(path, 'utf8'));
    // IDENTITY GATE (the third and last gate, after pid and port). The other two ask
    // whether something is THERE; this one asks whether it is OURS, and it is the only
    // question an alive, listening, schema-complete impostor cannot pass. Skipped when
    // the quarantine logic itself is asking, so it can still see the raw endpoint it is
    // deciding about.
    if (endpoint && opts?.applyQuarantine !== false) {
      const key = endpointKey(endpoint.host, endpoint.port);
      if (key && _quarantinedDiscoveryEndpoints.has(key)) return null;
    }
    return endpoint;
  } catch {
    // missing / unreadable — fall through to native fallback
  }
  return null;
}
/** The last URL `appUrl()` actually served — the baseline the harness-pool rebind compares against. */
let _servedAppUrl: string | null = null;

/**
 * EI-19462929205805752 — the per-harness pools were the last cached pools with no
 * stale-rebind guard. They are built with `appUrl()` (see `getHarnessPg`), but
 * nothing evicted them when that URL moved: `_harnessClients` was touched only by
 * LRU pressure and `_resetForTests`, so a discovery rebind left every harness pool
 * bound to the dead endpoint until the process exited. Same shape as
 * EI-19285027465993737, which the org pools were guarded against and these were not.
 *
 * WHY THE GUARD LIVES HERE and not on `getHarnessPg`'s cache-hit path — this is the
 * whole design point, and the reason the filed asymmetry dissolves. That hit path
 * deliberately returns the cached handle WITHOUT recomputing `appUrl()`, so a
 * comparison there would have to manufacture a fresh URL, dragging
 * `readDiscoveryFile()`'s synchronous `readFileSync` onto a path that currently
 * avoids it entirely. `appUrl()` has already computed both sides by the time it
 * returns, so detecting the change where it HAPPENS is free, where detecting it
 * where it is USED is not.
 *
 * LIVENESS (the honest limit): this fires only when something calls `appUrl()`.
 * A process whose only DB traffic is repeated `getHarnessPg` cache HITS would not
 * notice a rebind. That is not the real shape — `withWorkspace()` takes
 * `getOrgPgApp()` on every workspace-scoped call, and a harness cache MISS calls
 * `appUrl()` itself — but it is a condition, not a proof, so it is stated rather
 * than papered over. Closing it completely requires paying the readFileSync above.
 */
function endHarnessPoolsOnAppUrlRebind(): void {
  if (_harnessClients.size === 0) return;
  const n = _harnessClients.size;
  for (const h of _harnessClients.values()) {
    try {
      void h.sql.end({ timeout: 1 }).catch(() => {});
    } catch {
      /* best-effort: a failed drain must not block the rebind */
    }
  }
  _harnessClients.clear();
  // Deliberately noisy, and deliberately WITHOUT the URL: these DSNs carry
  // passwords, and `endStalePool` logs the label alone for the same reason.
  console.warn(`[db] app URL changed — ended ${n} per-harness pool(s) bound to the old endpoint`);
}

/**
 * Records the URL `appUrl()` is about to return and evicts the per-harness pools
 * whenever it differs from the previous one. Wrapping every return point (rather
 * than only the discovery branch) is what makes the cover total: it catches
 * discovery→discovery, discovery→ABSENT/native, native→discovery and env→* alike.
 * The discovery branch's own `_resolvedAppUrl` compare cannot do this job, because
 * the native fallback is returned WITHOUT being cached there — which is exactly the
 * discovery→ABSENT transition that caused the original incident.
 */
function noteServedAppUrl(url: string): string {
  if (_servedAppUrl !== null && _servedAppUrl !== url) endHarnessPoolsOnAppUrlRebind();
  _servedAppUrl = url;
  return url;
}

function appUrl(): string {
  // Single funnel: every resolution path returns through here, so a future branch
  // added to resolveAppUrl() inherits the rebind guard instead of having to
  // remember its own teardown — the failure mode this whole class came from.
  return noteServedAppUrl(resolveAppUrl());
}

function resolveAppUrl(): string {
  if (_resolvedAppUrl && _resolvedAppUrlSource === 'env') return _resolvedAppUrl;
  if (process.env.HARNESS_DATABASE_URL) {
    _resolvedAppUrl = process.env.HARNESS_DATABASE_URL;
    _resolvedAppUrlSource = 'env';
    return _resolvedAppUrl;
  }
  // DATABASE_URL pins the ENDPOINT (host:port/db) but carries admin creds; keep
  // the app role by re-keying it with the fixed harness_app convention creds.
  // WI-5244 class: every managed host (systemd units, deploy) sets DATABASE_URL
  // but not HARNESS_DATABASE_URL — without this rung they fell through to the
  // discovery file, which ANY local desktop/server install can rewrite; a
  // packaged Papercusp Server did exactly that (08:29Z 2026-07-17) and pointed
  // the shared bg-host's pools at its empty embedded PG (routines engine read
  // "0 active routines" → box-wide git-sync/kettle/scout stall).
  // WI-7424: HARNESS_ADMIN_DATABASE_URL is an endpoint pin for the APP role too,
  // and must be honored here in the SAME precedence order adminUrl() uses
  // (HARNESS_ADMIN_DATABASE_URL, then DATABASE_URL). It was missing: a process
  // pinned ONLY via HARNESS_ADMIN_DATABASE_URL — which is exactly the WI-7180
  // papercup-dev-api pin, and the shape every integration test that env-routes a
  // throwaway admin DSN takes — got a protected ADMIN pool and an APP pool that
  // still fell through to the discovery file. So the hijack this rung exists to
  // stop stayed open on the app half, silently: the two pools resolve to
  // DIFFERENT databases, which reads as data "disappearing" between an admin
  // write and an app read rather than as a connection fault.
  for (const pinVar of ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL'] as const) {
    const pinned = process.env[pinVar];
    if (!pinned) continue;
    try {
      const u = new URL(pinned);
      _resolvedAppUrl = `postgresql://harness_app:harness_app_pwd@${u.hostname}:${u.port || 5432}${u.pathname || '/papercusp'}`;
      _resolvedAppUrlSource = 'env';
      return _resolvedAppUrl;
    } catch {
      // unparseable pin — try the next pin, then the discovery file
    }
  }
  const disc = readDiscoveryFile();
  if (disc) {
    // Discovery file ships harness_admin creds; for the app role we
    // know the convention (harness_app/harness_app_pwd) since both
    // are auto-created by embedded-postgres-server with fixed pwds.
    // A multi-account host advertises harness_app's per-host password (WI-10003627);
    // otherwise the documented DEV default applies.
    const appSecret = encodeURIComponent(disc.appPassword ?? 'harness_app_pwd');
    const url = `postgresql://harness_app:${appSecret}@${disc.host}:${disc.port}/papercusp`;
    if (url !== _resolvedAppUrl) {
      _resolvedAppUrl = url;
      _resolvedAppUrlSource = 'discovery';
      // Discovery URL changed — invalidate cached pool so next
      // getOrgPgApp() call rebuilds. Mirror of the adminUrl()
      // invalidation block below (E2E round-13 bug #33 — app-side
      // half of the same pattern).
      if (_appOrgClient) {
        try { _appOrgClient.end({ timeout: 1 }).catch(() => {}); } catch {}
        _appOrgClient = null;
        _appOrgDrizzle = null;
        _appOrgDb = null;
      }
    }
    return _resolvedAppUrl;
  }
  // Never cache the native fallback.
  // EMBEDDED-PG PORT HONORING: the embedded PG the sidecar/desktop launches is advertised via
  // PAPERCUSP_PG_PORT (serve.mjs sets it after starting pg). The native fallback is reached BEFORE
  // the discovery file / HARNESS_DATABASE_URL is ready, so it MUST use that port — hardcoding 5432
  // made an EARLY getOrgPg caller (e.g. the home=<none> owner-bootstrap-admit) connect to a
  // nonexistent :5432 on a fresh VM → unhandled pool error → sidecar crash. Falls back to 5432
  // only when PAPERCUSP_PG_PORT is unset (a real native-PG-on-5432 host).
  return `postgresql://harness_app:harness_app_pwd@localhost:${Number(process.env.PAPERCUSP_PG_PORT) || 5432}/papercusp`;
}
function adminUrl(): string {
  // Env is stable for process lifetime → safe to cache.
  if (_resolvedAdminUrl && _resolvedAdminUrlSource === 'env') return _resolvedAdminUrl;
  if (process.env.HARNESS_ADMIN_DATABASE_URL) {
    _resolvedAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    _resolvedAdminUrlSource = 'env';
    return _resolvedAdminUrl;
  }
  // DATABASE_URL is the admin DSN on every managed host (systemd units, deploy
  // env) — it must beat the discovery file, which any local desktop/server
  // install can rewrite (WI-5244 class; see appUrl above for the incident).
  if (process.env.DATABASE_URL) {
    _resolvedAdminUrl = process.env.DATABASE_URL;
    _resolvedAdminUrlSource = 'env';
    return _resolvedAdminUrl;
  }
  // Discovery file can change (desktop restart / port shuffle) — re-read
  // every call. Never cache the native fallback (poisons pool when
  // operator boots before desktop writes the discovery file).
  const disc = readDiscoveryFile();
  // Embedded-pg always uses fixed passwords, so we don't strictly need the
  // password in the discovery file — fall back to the known default.
  // This handles desktops that wrote the discovery file before we added the
  // password field (release v0.0.1).
  if (disc?.host && disc?.port) {
    const user = disc.user || 'harness_admin';
    const pwd = disc.password || 'harness_admin_pwd';
    const url = `postgresql://${user}:${pwd}@${disc.host}:${disc.port}/papercusp`;
    if (url !== _resolvedAdminUrl) {
      _resolvedAdminUrl = url;
      _resolvedAdminUrlSource = 'discovery';
      // Discovery URL changed — invalidate cached pool so next call rebuilds.
      if (_adminClient) {
        try { _adminClient.end({ timeout: 1 }).catch(() => {}); } catch {}
        _adminClient = null;
        _adminDrizzle = null;
        _adminDb = null;
      }
      // Mirror the invalidation for the lossless-bigint pool (EI-18789855771421275)
      // — otherwise it keeps serving the stale target after a discovery-file change.
      if (_adminLosslessBigintClient) {
        try { _adminLosslessBigintClient.end({ timeout: 1 }).catch(() => {}); } catch {}
        _adminLosslessBigintClient = null;
      }
    }
    return _resolvedAdminUrl;
  }
  // EMBEDDED-PG PORT HONORING — see appUrl() native fallback above (same sidecar release fix):
  // honor PAPERCUSP_PG_PORT (the embedded PG's advertised port) so an early getOrgPg caller
  // before the discovery file/env is ready connects to the real embedded PG, not a nonexistent
  // :5432 (which crashed the sidecar on any host without a stray 5432 PG).
  return `postgresql://harness_admin:harness_admin_pwd@localhost:${Number(process.env.PAPERCUSP_PG_PORT) || 5432}/papercusp`;
}
/** Test-only — clears cached URLs so a test that mutates env between cases sees the change. */
export function _resetUrlCacheForTests(): void {
  _resolvedAppUrl = null;
  _resolvedAdminUrl = null;
}

/** Test-only — resolve the app/admin URLs through the live chain (env → discovery → fallback). */
export function _resolveUrlsForTests(): { app: string; admin: string } {
  return { app: appUrl(), admin: adminUrl() };
}

/**
 * The SINGLE predicate that decides whether org pools route through PgBouncer
 * (transaction pooling). EVERY PgBouncer-conditional site must consult this —
 * `maybePgbouncer` + `resolveOrgPoolMax` here, and `withWorkspace` + `harnessQuery`
 * in workspace-context.ts — so they can NEVER disagree. A split (URL routes through
 * the pooler but the per-tx `SET LOCAL search_path` doesn't fire) would silently
 * break search_path resolution under pooling.
 *
 * P-004 of backend-connection-scaling-2026-06-17 — DEFAULT-ON, not a dark flag
 * ("finished work must not ship dark"):
 *   - `PAPERCUSP_PGBOUNCER=1` → force ON  (explicit override)
 *   - `PAPERCUSP_PGBOUNCER=0` → force OFF (kill-switch — instant, fleet-wide revert)
 *   - unset → derive: ON for a SERVER-class host (the dev box + any dedicated /
 *     native-PG production server), OFF for laptop/workstation — which is every
 *     Tauri DESKTOP (embedded PG: no pooler runs there, so routing to :6432 would
 *     break it). hostClass is the robust discriminator: a real embedded desktop is
 *     laptop/workstation-class, never `server`.
 *
 * NB: we deliberately gate on physical-core-derived machine class, NOT
 * `getResourceProfile().hostClass` — `hostClass` is intentionally derived from
 * `ResourceSignals.cores` (`os.availableParallelism()`, cgroup-CPU-quota-aware:
 * see its doc comment — "how much work can I, THIS PROCESS, actually do at
 * once"), which is exactly right for agent/queue/pool-size caps but the WRONG
 * signal for "is the underlying Postgres a shared native instance worth
 * pooling" — that is a property of the MACHINE Postgres runs on, not of
 * whichever one CPU-quota-limited client process happens to be asking. This is
 * the identical confusion `deriveDatabaseTuning` was fixed for under WI-5456 (a
 * 16-core-quota bg-host on a 128-core box derived a fictional `max_connections`
 * from its own quota) — `physicalCores` (`os.cpus().length`, NOT quota-aware)
 * exists precisely so machine-property decisions can bypass a process's own
 * quota. bug-drain-200k (2026-07-21): confirmed live on THIS box —
 * `papercup-bg-host.service` carries `CPUQuota=1600%` (16 cores), so
 * `hostClass` read `'workstation'` for it despite the box being a genuine
 * 128-core / 512-max_connections server, and it opened dozens of DIRECT
 * connections instead of routing through :6432 — a real contributor to the
 * PG-connection-saturation regression (EI-18217560711347466). Also deliberately
 * NOT `embeddedPg` — `detectEmbeddedPg()` reports `embeddedPg=true` for ANY host
 * that sets an explicit DATABASE_URL, so it misfires on the dev box / a
 * dedicated server pointing at native PG via env (verified live: dev box
 * reports embeddedPg=true). That detection flaw is tracked separately;
 * physical-core class sidesteps it here, same as hostClass did.
 */
export function pgbouncerEnabled(): boolean {
  const flag = process.env.PAPERCUSP_PGBOUNCER;
  if (flag === '1') return true;
  if (flag === '0') return false;
  // An explicit PAPERCUSP_PG_PORT means THIS process owns its own dedicated,
  // isolated embedded Postgres (smoke-test witnesses, desktop sidecars,
  // Hetzner rig instances) — never the box's shared native PG. The real
  // dev/staging operators on a 'server'-class host NEVER set this (they attach
  // to the shared native PG via HARNESS_ADMIN_DATABASE_URL / DATABASE_URL /
  // the discovery file), so this is a safe, exclusive signal. Rerouting such a
  // process's org pool through the box-wide PgBouncer (which fronts the
  // SHARED native PG — see /etc/pgbouncer/pgbouncer.ini) would silently
  // connect it to a totally different, already-populated database instead of
  // its own freshly-booted empty one, defeating per-process isolation
  // entirely (WI-1666: a "fresh, isolated" hive-from-repo smoke witness read
  // pre-existing shared_repo_binding_cache rows because getOrgPg() routed
  // through :6432 → the box's real native PG, bypassing the witness's own
  // empty embedded PG bound to its explicit PAPERCUSP_PG_PORT). Confirmed live
  // on the shared dev box 2026-07-02: the witness's own embedded PG (port
  // 19532) had 0 matching rows; the box's native PG (port 5432, what :6432
  // pools to) had the exact "existing" rows the bug reported.
  if (process.env.PAPERCUSP_PG_PORT) return false;
  try {
    const { signals } = getResourceProfile();
    const machineCores = Math.floor(signals.physicalCores ?? signals.cores);
    return Number.isFinite(machineCores) && machineCores > 16;
  } catch {
    return false; // resource-profile unreadable → safe default (direct)
  }
}

/** The box's own native-PG default (NATIVE_FALLBACK in embedded-pg-discovery.ts) —
 *  the ONLY thing the local PgBouncer instance fronts. See {@link maybePgbouncer}. */
const NATIVE_PG_HOSTS = new Set(['localhost', '127.0.0.1']);
const NATIVE_PG_PORT = '5432';

/**
 * When {@link pgbouncerEnabled}, route an org pool URL through the local PgBouncer
 * (transaction pooling) on `PAPERCUSP_PGBOUNCER_PORT` (default 6432) — C2 of
 * backend-connection-scaling-2026-06-17. This is what lets thousands of concurrent
 * agent tool-calls multiplex onto a bounded set of PG backends.
 *
 * Correct under pooling because the connect-time `search_path` (NOT preserved by
 * transaction pooling) is re-applied per-transaction by withWorkspace/harnessQuery
 * (C1-2, landed). Listeners (sync-sse, *-bus) + the watchdog tick lock use
 * `getHarnessAdminUrl()` and are intentionally NOT rerouted — LISTEN and
 * session-level advisory locks are session-bound and MUST bypass a transaction
 * pooler (C2-2 / P-001). Per-harness `getHarnessPg` pools also stay DIRECT (D-005).
 *
 * EI-2437: only reroute when the incoming URL ALREADY targets the box's own
 * native-PG default (localhost/127.0.0.1:5432 — NATIVE_FALLBACK). The local
 * PgBouncer instance fronts THAT native instance and nothing else, so a URL that
 * already points somewhere else — a testcontainer's random ephemeral port
 * (integration tests env-routing `HARNESS_ADMIN_DATABASE_URL` at a throwaway DB),
 * a future remote/managed PG — is an EXPLICIT override the caller made on
 * purpose. Rerouting it anyway would silently connect through the pooler to the
 * SHARED native PG instead, which either 404s ("no such database: org_<rand>",
 * confusing because the DB genuinely exists — just not on :5432) or, worse,
 * silently reads/writes a totally different, already-populated database (the
 * same class of bug WI-1666 fixed one layer up in {@link pgbouncerEnabled} for
 * the `PAPERCUSP_PG_PORT`-isolated-process case). This closes the class fully:
 * WI-1666 stopped an isolated PROCESS from being rerouted; this stops an
 * isolated URL (set without the process-wide `PAPERCUSP_PG_PORT` signal, e.g. a
 * single test's env-routing block) from being rerouted too — no per-test
 * `PAPERCUSP_PGBOUNCER=0` opt-out needed anymore.
 */
export function maybePgbouncer(url: string): string {
  if (!pgbouncerEnabled()) return url;
  try {
    const u = new URL(url);
    const port = u.port || NATIVE_PG_PORT; // an omitted port means Postgres's own default (5432)
    if (!NATIVE_PG_HOSTS.has(u.hostname) || port !== NATIVE_PG_PORT) return url;
    const poolerPort = Number(process.env.PAPERCUSP_PGBOUNCER_PORT) || 6432;
    u.host = `127.0.0.1:${poolerPort}`;
    return u.toString();
  } catch {
    return url; // unparseable — leave the direct URL untouched
  }
}

let _adminClient: Sql | null = null;
let _adminDrizzle: ReturnType<typeof drizzle> | null = null;
let _adminDb: ReturnType<typeof drizzle<typeof fullSchema>> | null = null;
// Dedicated direct LISTEN client for cross-workspace consumers that cannot use
// the transaction-pooled getOrgPg() client. This is intentionally separate from
// the query pool: postgres-js's listen state is session-bound and PgBouncer's
// transaction mode may discard NotificationResponse packets on an unlinked
// server connection.
let _orgListenerClient: Sql | null = null;
let _orgListenerClientUrl: string | null = null;
// EI-18789855771421275: a SEPARATE, small, dedicated pool for callers that must
// see exact bigint (int8) values — see getOrgPgLosslessBigint() below.
let _adminLosslessBigintClient: Sql | null = null;

// The URL each cached admin pool was ACTUALLY BUILT WITH. Tracked separately
// from `_resolvedAdminUrl` (which records what resolution last *decided*) —
// they are different questions, and the gap between them is the bug below.
let _adminClientUrl: string | null = null;
let _adminLosslessBigintClientUrl: string | null = null;

/**
 * A cached pool must never outlive the URL that justified it
 * (EI-19285027465993737).
 *
 * THE INCIDENT (2026-08-01, fleet-wide). A desktop booted an embedded PG,
 * registered `~/.papercusp/embedded-pg.json` on port 19715, and died. The
 * shared operator had lazily pooled against it, and every DB-backed MCP tool
 * on the box then failed with `ECONNREFUSED 127.0.0.1:19715` until a manual
 * restart — a port that appears in NO config file, which is what made it hard
 * to read.
 *
 * WHY THE EXISTING GUARDS DID NOT CATCH IT. There were three, and each is
 * sound on its own axis:
 *   - `_parseDiscoveryJson` pid-liveness — checked at RESOLUTION time, so it
 *     correctly began reporting "absent" once the pid died;
 *   - `adminUrl()`'s teardown — fires only on discovery→DIFFERENT-discovery.
 *     It lives inside `if (disc?.host && disc?.port)`, so discovery→ABSENT
 *     (a clean desktop shutdown, or exactly this dead-pid case) falls through
 *     to the native-fallback `return` and tears nothing down;
 *   - `validateDiscoveryTargetOnce` — fires once, at build.
 * All three ask "what SHOULD we connect to?". None asks "what is the live pool
 * ACTUALLY bound to?" — so resolution was returning the correct native URL the
 * entire time the pool was serving a dead port. That gap is the whole bug.
 *
 * This closes it by comparing against what was BUILT rather than what was
 * decided, which makes the rebind total: it covers discovery→absent,
 * discovery→env, env→discovery, a pgbouncer toggle, and any future source, so
 * no new resolution path can reintroduce the class by forgetting its own
 * teardown. The `adminUrl()` teardown is now redundant but harmless — left in
 * place because it also invalidates on a path this cannot see (it runs even
 * when no pool is subsequently requested).
 *
 * Teardown is best-effort and non-blocking: draining a pool that points at a
 * dead endpoint must never delay the caller that is trying to escape it.
 */
export function endStalePool(
  client: Sql | null,
  builtWith: string | null,
  url: string,
  label: string,
): boolean {
  if (!client || builtWith === url) return false;
  try {
    void client.end({ timeout: 1 }).catch(() => {});
  } catch {
    /* best-effort: a failed drain must not block the rebind */
  }
  // Deliberately noisy: this fires when the DB endpoint moved under a running
  // process, which is rare, load-bearing, and was previously invisible.
  console.warn(`[db] ${label} pool rebound: target changed since it was built — rebuilding`);
  return true;
}
type HarnessClient = {
  sql: Sql;
  drizzle: ReturnType<typeof drizzle>;
  db: ReturnType<typeof drizzle<typeof fullSchema>>;
  lastUsed: number;
};
const _harnessClients = new Map<string, HarnessClient>();

// LRU cap on per-harness pools. Workspaces touch many slugs over time and
// each pool keeps a long-lived idle conn — without a cap we'd blow past
// Postgres's max_connections=100 (audit found 83 idle conns from a single
// session). When the cap is exceeded, the LRU entry is `.end()`-ed and
// dropped so its socket goes back to Postgres immediately.
const HARNESS_POOL_CAP = Math.max(
  1,
  Number(process.env.PAPERCUSP_HARNESS_POOL_CAP) || 8,
);

function evictHarnessPoolsIfFull(): void {
  while (_harnessClients.size >= HARNESS_POOL_CAP) {
    let oldestSlug: string | null = null;
    let oldestTs = Infinity;
    for (const [slug, h] of _harnessClients) {
      if (h.lastUsed < oldestTs) { oldestTs = h.lastUsed; oldestSlug = slug; }
    }
    if (!oldestSlug) return;
    const evict = _harnessClients.get(oldestSlug);
    _harnessClients.delete(oldestSlug);
    if (evict) {
      // Fire-and-forget; .end() drains in-flight queries with a short timeout.
      evict.sql.end({ timeout: 2 }).catch(() => {});
    }
  }
}

/**
 * A short, stable `application_name` so every pooled connection is attributable
 * in `pg_stat_activity` (the connection-exhaustion incident on 2026-06-17 was
 * hard to diagnose precisely because the org/harness pools were anonymous — only
 * su-lock + migrations tagged themselves). Format `pcusp:<label>:p<pid>`, capped
 * at PG's 63-byte NAMEDATALEN-1 limit. C0-2 of backend-connection-scaling-2026-06-17.
 */
function pgAppName(label: string): string {
  const s = `pcusp:${label}:p${process.pid}`;
  return s.length > 63 ? s.slice(0, 63) : s;
}

/**
 * Reusable startup-options fragment for hand-rolled LONG-LIVED `postgres(url, {...})`
 * pools/singletons OUTSIDE the canonical getOrgPg()/getHarnessPg()/getOrgPgApp()
 * clients — a dedicated LISTEN bus, a singleton background poller, a shared utility
 * pool, etc. (EI-18122461766429683: root-caused a server-wide PG connection
 * saturation crit — 87+ idle, permanently-unattributed `application_name:'postgres.js'`
 * connections had accumulated across the su-lock pools and ~9 operator-core singleton
 * pools/listeners that each hand-roll their own `postgres(...)` call instead of going
 * through `buildClient()`. Every one of those was missing BOTH fixes below.)
 *
 * 1. Tags the connection with a `pcusp:<label>:p<pid>` application_name (pgAppName)
 *    so it is attributable in `pg_stat_activity` / `dev:pg_health` — the ALTER-DATABASE
 *    default some pools relied on for this (e.g. su-lock's `papercusp_su` database)
 *    does NOT work: postgres-js always sends its own `application_name: 'postgres.js'`
 *    startup parameter, which overrides a database-level SET default.
 * 2. Applies the SAME dead-client zombie-detection GUCs `buildClient()` applies
 *    (WI-3816's `client_connection_check_interval` + tightened TCP keepalives): a
 *    long-lived pool's OWNING PROCESS can die (crash, restart, `dev:restart`, an
 *    abrupt kill without a clean `.end()`) without the TCP FIN reliably reaching
 *    Postgres, leaving its backend connection idle FOREVER — nothing server-side
 *    reaps it, since the client-side `idle_timeout` option only runs while the
 *    (now-dead) client process is alive to execute it. `client_connection_check_interval`
 *    makes the BACKEND itself detect the dead socket and abort, independent of the
 *    client's survival.
 *
 * Only startup params — safe to add unconditionally here because every caller of
 * this helper connects DIRECT (via `getHarnessAdminUrl()`/`adminUrl()`, never through
 * `maybePgbouncer()`), so there is no transaction-pooler in front to reject them (see
 * `buildConnectionOptions`'s `pooled` branch for the case where that DOES matter).
 *
 * Usage: `postgres(url, { ...longLivedPoolConnectionOptions('coord-inbox-bus'), max: 1 })`
 * — spread FIRST so a call site's own `onnotice`/`connection` overrides still win if it
 * has a reason to.
 */
export function longLivedPoolConnectionOptions(label: string): {
  onnotice: () => void;
  connection: Record<string, string>;
} {
  return {
    onnotice: () => {},
    connection: {
      application_name: pgAppName(label),
      client_connection_check_interval: '30000',
      tcp_keepalives_idle: '30',
      tcp_keepalives_interval: '10',
      tcp_keepalives_count: '3',
    },
  };
}

/**
 * Seconds a POOLED connection may sit idle before postgres-js closes it.
 *
 * ⚠ postgres-js defaults `idle_timeout` to **0 = never close**. That default is the
 * single root cause of the fleet-wide connection saturation this exists to bound:
 * `buildClient()` has always set 30s (so org pools self-drain — measured live at
 * max_idle 29s), but the ~13 hand-rolled `postgres(...)` pools that bypass
 * `buildClient` and only spread {@link longLivedPoolConnectionOptions} inherited the
 * 0 default and held their backends OPEN FOREVER. Live 2026-07-26: 294 idle vs 3
 * active connections, 343/512 of `max_connections`.
 *
 * Why an idle timeout is the DURABLE bound (and per-process `max` tuning is not):
 * the number of node processes on this box is unbounded and grows with the fleet, so
 * any cap derived from an expected process count (`PAPERCUSP_EXPECTED_OPERATOR_PROCS`)
 * drifts the moment the fleet scales. An idle timeout instead makes total backends
 * proportional to CONCURRENT ACTIVITY, which is genuinely bounded by real work.
 *
 * 🚫 NOT for LISTEN pools. A `LISTEN` connection is idle BY DESIGN — it holds a
 * subscription and does nothing between notifications — so applying this to one closes
 * the subscription and silently breaks notification delivery. Those pools must declare
 * `idle_timeout: 0` explicitly (see the `pool-idle-timeout-declared` guard test, which
 * fails the build if any pool site leaves the choice implicit).
 *
 * Shares `PAPERCUSP_DB_IDLE_TIMEOUT` with `buildClient` so the two can never drift.
 */
export function poolIdleTimeoutSec(): number {
  return Math.max(0, Number(process.env.PAPERCUSP_DB_IDLE_TIMEOUT) || 30);
}

/**
 * Detect the configuration combination that reintroduced client-pool starvation
 * on the release host (EI-20245956069519471): an explicit per-process pool cap
 * alongside PgBouncer. The cap may be intentional for a test or a constrained
 * deployment, so this is a loud diagnostic rather than a runtime override.
 */
export function explicitOrgPoolOverrideWarning(): string | null {
  const override = Number(process.env.PAPERCUSP_DB_POOL_MAX);
  if (!pgbouncerEnabled() || !Number.isFinite(override) || override <= 0) return null;
  return (
    `PAPERCUSP_DB_POOL_MAX=${Math.floor(override)} is explicitly pinned while PgBouncer is enabled; ` +
    'this caps per-process client slots and bypasses resource-profile sizing'
  );
}

/**
 * Size of each org pool (getOrgPg admin + getOrgPgApp app). C1-1 of
 * backend-connection-scaling-2026-06-17. An explicit `PAPERCUSP_DB_POOL_MAX`
 * wins; otherwise the resource-profile size, but BOUNDED so that
 * (2 org pools × expected operator processes) + fixed overhead cannot exceed the
 * host-tuned ceiling — the guard the P4-3 regression lacked (it sized each pool to
 * 52 with no awareness of the 2-pool × N-process multiplication or the DB ceiling).
 * Behind a transaction pooler (PAPERCUSP_PGBOUNCER=1) the app pool maps to local
 * pooler *client* slots, not PG backends, so it keeps the full resource-profile
 * size — that decoupling is the whole point of C2.
 */
export const VITEST_ORG_POOL_MAX = 4;

/**
 * True when this process is a VITEST WORKER — one of N sibling processes, not a
 * long-lived operator. See {@link resolveOrgPoolMax} for why that distinction
 * changes the pool budget by an order of magnitude.
 *
 * A `VITEST` sniff rather than a dedicated env seam because the budget must be
 * right for EVERY worker without each suite remembering to opt in — the failure
 * mode is a stampede, and a stampede is exactly what an opt-in misses. (The
 * `assertRealPgAllowed` seam nearby is deliberately env-based for the opposite
 * reason: it must be overridable per test file.)
 */
function isVitestWorker(): boolean {
  return Boolean(process.env.VITEST);
}

function resolveOrgPoolMax(): number {
  const envOverride = Number(process.env.PAPERCUSP_DB_POOL_MAX);
  const profile = getResourceProfile();
  // EI-19448641861408544: under vitest, EVERY WORKER IS ITS OWN PROCESS with its
  // own admin + app org pools, and `expectedProcesses` below defaults to 2 — a
  // number that is right for the operator and wrong by an order of magnitude
  // here. Measured 2026-08-08 on this box: a worker resolved max=52 PER POOL, so
  // ~15 workers of one `npm run test:affected` could demand ~1,560 connections
  // against a 512-slot server. Measured 2026-08-03 they actually held 90 idle
  // checked-out connections and starved the LIVE operator's write path
  // fleet-wide — every peer's work_items:checkpoint / facts:assert — while every
  // read-side probe said the database was healthy (39ms reads, 344/512 conns).
  // That is the whole trap: server capacity does not decide CLIENT-pool
  // saturation, so "the DB looks fine" is the EXPECTED reading during it.
  //
  // 4, not the 1-2 the issue proposed: a test worker runs its files sequentially
  // so it needs very little concurrency, but a flow that legitimately nests an
  // acquisition inside another would DEADLOCK at max:1 rather than merely queue,
  // and a deadlock in the test tier is a worse failure than the one being fixed.
  // An explicit PAPERCUSP_DB_POOL_MAX still wins, so a suite that genuinely
  // needs more can say so.
  if (isVitestWorker() && !(Number.isFinite(envOverride) && envOverride > 0)) {
    return VITEST_ORG_POOL_MAX;
  }
  const desired =
    Number.isFinite(envOverride) && envOverride > 0
      ? Math.max(1, Math.floor(envOverride))
      : profile.pgPoolMax;
  // WI-5456: `profile.database.maxConnections` is derived from `physicalCores` (the
  // real machine), NOT the cgroup-quota-scoped `cores` every other cap here uses —
  // see ResourceSignals.physicalCores. Before that fix, a CPU-quota-limited systemd
  // unit (e.g. papercup-bg-host.service's CPUQuota=1600% on a 128-core box) derived
  // maxConnections from its OWN ~16-core quota (clamp(16*4,100,1000)=100) instead of
  // the live server's real max_connections (512), which starved this budget math to
  // its poolMax=1 floor — collapsing the ENTIRE process's getOrgPg() traffic onto one
  // connection and turning any single ≥2-3s query into a critical routines-tick pool
  // shed (371 shed events observed, every 30-90s). Fixing the ceiling upstream (not
  // here) keeps this call a one-liner and fixes every other maxConnections consumer
  // (pg-autotune, embedded-pg boot flags) the same way.
  return boundedOrgPoolMax({
    desired,
    maxConnections: profile.database.maxConnections,
    superuserReserved: profile.database.superuserReservedConnections,
    expectedProcesses: Math.max(1, Number(process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS) || 2),
    behindPooler: pgbouncerEnabled(),
  });
}

// WI-832 — DI seam for a DEFAULT statement_timeout on the org pools. This low-level
// db lib must NOT read operator-core runtime config (layering); instead the boot path
// INJECTS a provider (mirrors how the locks host injects getTxnTimeouts). Default
// `() => 0` ⇒ NO statement_timeout GUC is emitted ⇒ byte-identical to today (the admin
// pool stays deliberately unbounded — migrations share it). When the operator wires a
// non-zero value (behind papercusp-txn-timeouts-config, owner-gated live flip), every
// NEW pooled connection gets that per-statement cap, bounding the whole interactive-
// write class at the source. The migration runner OPTS OUT per-txn (SET LOCAL
// statement_timeout = 0), so a non-zero default can never kill a long migration.
let _adminStatementTimeoutMsProvider: () => number = () => 0;
export function setAdminPoolStatementTimeoutProvider(fn: () => number): void {
  _adminStatementTimeoutMsProvider = typeof fn === 'function' ? fn : () => 0;
}
/** The currently-configured default statement_timeout (ms) for new org connections;
 *  0 / falsy / negative ⇒ unset (no GUC). Read at connection-construction time. */
function adminStatementTimeoutMs(): number {
  let v = 0;
  try {
    v = Math.trunc(_adminStatementTimeoutMsProvider() || 0);
  } catch {
    v = 0; // a throwing provider must never break connection construction.
  }
  return v > 0 ? v : 0;
}

/**
 * Pure builder for the postgres-js `connection` STARTUP-options block — extracted +
 * exported so the PgBouncer-safety invariant is unit-testable without a live DB.
 *
 * `idle_in_transaction_session_timeout` + `statement_timeout` are libpq STARTUP
 * parameters. A transaction pooler (PgBouncer) REJECTS unknown startup parameters
 * (`unsupported startup parameter: <name>`) unless they're in `ignore_startup_parameters`,
 * AND a connect-time GUC does not survive transaction pooling anyway (each transaction may
 * land on a different server backend). So when `pooled`, we OMIT both — under pooling the
 * real enforcement is per-TRANSACTION `SET LOCAL` (withWorkspace / harnessQuery /
 * in-workspace-txn re-apply statement_timeout + search_path per tx) and PgBouncer's own
 * `idle_transaction_timeout` covers the EI-49 idle-in-tx guard. A DIRECT connection keeps
 * both (no pooler to reject them; the GUCs persist on the long-lived session).
 * `search_path` + `application_name` are always sent: application_name is a standard
 * allowed startup param, and search_path is already in the pooler's
 * `ignore_startup_parameters` (re-applied per-tx under pooling).
 *
 * Fixes `unsupported startup parameter: statement_timeout` on pooled plans:* (org-pool)
 * writes — a fleet-wide intermittent failure once PgBouncer is in front of the org pools.
 */
export function buildConnectionOptions(opts: {
  searchPath: string;
  applicationName: string;
  idleInTxMs: number;
  stmtTimeoutMs: number;
  pooled: boolean;
  /** WI-3816: ms between the backend polling its socket for a dead/gone client
   *  (0 ⇒ the GUC's own off-default). Same PgBouncer-safety class as the two
   *  timeouts above — omitted when pooled. */
  clientConnCheckMs?: number;
}): Record<string, string> {
  const c: Record<string, string> = {
    search_path: opts.searchPath,
    application_name: opts.applicationName,
  };
  if (!opts.pooled) {
    c.idle_in_transaction_session_timeout = String(opts.idleInTxMs);
    if (opts.stmtTimeoutMs > 0) c.statement_timeout = String(opts.stmtTimeoutMs);
    // WI-3816: the 2026-07-10 ClientWrite-zombie incident — a backend whose query
    // completed but whose CLIENT is gone/not-reading survives pg_cancel_backend
    // and holds its pool slot until an operator manually pg_terminate_backend's
    // it (4h fleet-wide MCP-timeout outage, root cause of WI-3792's aftermath).
    // client_connection_check_interval makes the backend itself notice the dead
    // socket and abort — defaults to 0 (off) on every PG install, embedded or
    // native, so this must be set explicitly; no config-file edit needed since
    // it is a PGC_USERSET GUC (settable as a libpq startup param, same class as
    // the two timeouts above). Also tighten the OS-level TCP keepalive probe
    // (PG's own 2h default is far too slow to matter here) so a network-level
    // dead peer (not just an app-level unresponsive one) is caught quickly too.
    if (opts.clientConnCheckMs && opts.clientConnCheckMs > 0) {
      c.client_connection_check_interval = String(opts.clientConnCheckMs);
      c.tcp_keepalives_idle = '30';
      c.tcp_keepalives_interval = '10';
      c.tcp_keepalives_count = '3';
    }
  }
  return c;
}

/**
 * EI-19311807188719573 — the UNIT-layer real-database rail.
 *
 * A unit test has no legitimate reason to open a real Postgres connection, and until
 * this existed nothing said so. That silence is not theoretical: it is how the
 * premise-probes fleet gate red happened. A concurrently-resolved leg escaped
 * `vi.mock` (two un-memoized `import()`s of one module resolving to different
 * instances), read the LIVE `WI-6560` row instead of the fixture, and the assertion
 * passed for as long as production data happened to agree with it — then went red for
 * the whole fleet the moment that row was closed, landing on whoever was unlucky
 * rather than whoever caused it.
 *
 * WHY THE GUARD IS HERE, at `buildClient`, rather than at `getOrgPg`: this is the one
 * choke point every real pool passes through, whichever accessor asked for it
 * (getOrgPg / getOrgPgApp / harness clients) and whichever source resolved the URL
 * (HARNESS_ADMIN_DATABASE_URL, DATABASE_URL, the discovery file, the native
 * fallback). Guarding an accessor would leave the siblings open — the exact
 * fix-one-site-leave-the-class mistake that produced the bug above.
 *
 * WHY AN ENV SEAM rather than a `vitest` sniff: `vi.mock` is per-file and hoisted, so
 * a setup file cannot mock this module for every test; and the integration layer
 * legitimately builds real clients against a throwaway testcontainer. The unit layer
 * opts in explicitly (libs/test-config/src/setup-no-real-pg.ts), the integration layer
 * never sets the var, and a unit test that genuinely needs a live pool can unset it in
 * its own body — which runs after the setup file, exactly like the PAPERCUSP_PGBOUNCER
 * and PAPERCUSP_SKIP_PG_DISCOVERY precedents in setup-hermetic-env.ts.
 *
 * The message names the offending pool AND the fix, because the alternative symptom is
 * a confusing connection timeout that reads like flakiness rather than a rule.
 */
function assertRealPgAllowed(label: string, connectionUrl: string): void {
  if (process.env.PAPERCUSP_FORBID_REAL_PG !== '1') return;
  // Redact credentials — this string lands in test output and CI logs.
  const safeTarget = connectionUrl.replace(/\/\/[^@/]*@/, '//<redacted>@');
  // ONE LINE, deliberately. The first measured run of this rail blocked 196 real
  // connections across the operator-core unit suite — and most call sites FAIL OPEN
  // (`buildHiveRekeyBootDeps fail-open: …`, `inbox-wake arm failed (non-fatal)`), so they
  // CATCH this error and log it rather than failing. A multi-line message therefore
  // multiplies into ~1000 lines of noise that buries the real test output. The rail's
  // value is preventing the connection, which happens whether or not anyone reads the
  // text; the full rationale lives in this function's doc comment and in the setup file,
  // where it is read once instead of printed hundreds of times.
  throw new Error(
    `A UNIT test tried to open a REAL Postgres connection (pool "${label}" → ${safeTarget}). ` +
      `Unit tests must not touch a live database — inject the module's own seam double, or ` +
      `rename the file *.integration.test.ts to run it against a testcontainer. [EI-19311807188719573]`,
  );
}

function buildClient(
  connectionUrl: string,
  searchPath: string[],
  maxOverride?: number,
  label = 'pool',
  pooled = false,
  // EI-18789855771421275: override the bigint (oid 20) type parser. Defaults to
  // PG_BIGINT_AS_NUMBER_TYPES (every existing caller's byte-identical behavior);
  // pass `{}` for a client that must NOT silently round a bigint outside
  // Number's safe range — see getOrgPgLosslessBigint(). Other opt-in parsers,
  // such as PG_TIMESTAMPTZ_AS_STRING_TYPES, can be supplied through this map.
  // `any` mirrors PG_BIGINT_AS_NUMBER_TYPES's own typing below — postgres-js's
  // `types` option is generic over the exact custom-type shape, which isn't
  // worth threading through this internal helper's signature.
  typesOverride: any = PG_BIGINT_AS_NUMBER_TYPES,
): Sql {
  assertRealPgAllowed(label, connectionUrl);
  const sp = searchPath.map((s) => `"${s.replace(/"/g, '""')}"`).join(', ');
  // The desktop ships embedded-postgres-server (real PG over TCP); the URL
  // carries a normal host:port, so no host override is needed. The legacy
  // pglite unix-socket path was removed 2026-06-01.
  // EI-49: bound how long a pooled connection may sit idle INSIDE an open
  // transaction. A plans:* (or any) MCP WRITE whose transport drops mid-call
  // returns its connection to the pool still BEGIN-open, holding a
  // transaction-scoped advisory lock (pg_advisory_xact_lock; withPlanLock) that
  // only releases on COMMIT/ROLLBACK — wedging the plans subsystem fleet-wide
  // until that exact connection is reused or the process restarts (harness_admin
  // can't pg_terminate_backend a harness_app session, so the only operator-side
  // clear was a :3070 restart). Setting this GUC at connection startup makes
  // Postgres auto-terminate the stuck idle-in-transaction backend, releasing its
  // locks WITHOUT an operator restart. A healthy transaction is never idle
  // (between statements) this long — afterWrite already runs outside the tx
  // (EI-118), and statement execution is bounded by statement_timeout, not this.
  // Seconds; override via PAPERCUSP_DB_IDLE_IN_TX_TIMEOUT. Sent as the GUC's
  // default unit (ms). Falsy/0 → 60 (kept on; this is pure defense-in-depth).
  const idleInTxMs =
    Math.max(0, Number(process.env.PAPERCUSP_DB_IDLE_IN_TX_TIMEOUT) || 60) * 1000;
  // WI-832: configured default per-statement cap (0 ⇒ unset; see the seam above).
  const stmtTimeoutMs = adminStatementTimeoutMs();
  // WI-3816: dead-client detection interval (seconds ⇒ ms; PG's own GUC unit is ms).
  // Default 30s: frequent enough to catch a ClientWrite zombie well before it can
  // exhaust a pool, cheap enough (one extra poll/30s per idle backend) to leave on
  // everywhere. 0 disables (kept as an escape hatch, not because 0 is ever a good
  // default). Override via PAPERCUSP_DB_CLIENT_CHECK_INTERVAL (seconds).
  const clientConnCheckMs =
    Math.max(0, Number(process.env.PAPERCUSP_DB_CLIENT_CHECK_INTERVAL) || 30) * 1000;
  // EI-2582: bound the connect attempt UNDER TEST so an unmocked PG access in a
  // unit test fails fast (~5s, with a clear connection error) instead of silently
  // hanging until the 60s vitest timeout — which reads as a "slow test", not the
  // real cause (a new PG-touching step added to a flow like harness:create without
  // a per-test `vi.doMock`). Unit tests must mock the db layer (or live in a
  // *.integration.test.ts against a real DB); a healthy integration DB connects in
  // well under 5s, so this never trips a real connection. Left UNSET outside tests
  // to preserve the embedded-pg boot-race tolerance — a background worker may
  // legitimately wait for embedded PG to finish coming up before its first connect.
  // Override (any env) via PAPERCUSP_DB_CONNECT_TIMEOUT (seconds; 0 disables).
  const connectTimeoutSec =
    Number(process.env.PAPERCUSP_DB_CONNECT_TIMEOUT) ||
    (process.env.VITEST ? 5 : 0);
  // Hoisted out of the options literal so the acquire registry can report it
  // (EI-19485014132257783). postgres-js keeps its queue/connection lists in a
  // closure, so `max` is the only pool-sizing fact obtainable without reaching
  // into internals — and the error needs it to say "N waiting against a max of M".
  const poolMax = Math.max(1, maxOverride ?? resolveOrgPoolMax());
  recordPoolMax(label, poolMax);
  const client = postgres(connectionUrl, {
    onnotice: () => {},
    // WI-10000316: postgres.js emits this once at terminal ReadyForQuery.
    // recordPgResult immediately reduces the raw query to a bounded family and
    // never retains SQL text, parameters, or rows.
    ...createPgDiagnosticHooks(label),
    ...(connectTimeoutSec > 0 ? { connect_timeout: connectTimeoutSec } : {}),
    // PgBouncer-safe startup options. Under transaction pooling the statement_timeout +
    // idle_in_transaction_session_timeout GUCs are NOT sent at startup (the pooler rejects
    // them as "unsupported startup parameter", and a connect-time GUC doesn't survive a
    // transaction pool); they're enforced per-tx via SET LOCAL instead. WI-832's
    // statement_timeout therefore stays a per-tx cap under pooling. See buildConnectionOptions.
    connection: buildConnectionOptions({
      searchPath: sp,
      applicationName: pgAppName(label),
      idleInTxMs,
      stmtTimeoutMs,
      pooled,
      clientConnCheckMs,
    }),
    // Skip postgres-js's prepared-statement plan caching. ~80% of the
    // ~1.1s cold-reconnect cost we measured was prepared-statement
    // registration on a fresh connection. Disabling it makes cold
    // reconnects ~300ms instead of ~1100ms. Per-query cost goes up
    // slightly (no plan caching), but our queries are simple SELECTs
    // and the trade is overwhelmingly worth it for polling-heavy dev.
    // Production is unaffected because connections in prod live long
    // enough that the one-time prepare cost amortizes anyway.
    // P-013 D-030: prepare:true was measured on workload C (c8, both arms) and
    // moved neither arm end to end; the binding cost is awaited round trips.
    prepare: false,
    // Pool size: explicit override > env var > adaptive default from resource-profile.
    // Adaptive sizing derives from host resources (cores/memory/PG-type): laptop with
    // embedded PG gets a small pool (~4–7 conns), server with native PG gets a larger
    // pool (~52–64). Env override for backward compatibility; explicit maxOverride is
    // used if provided by the caller (currently unused, reserved for future direct-pool
    // configuration). P4-3 of operator-scalability-event-loop-2026-06-16.
    max: poolMax,
    // Auto-close connections that sit idle for >30s. Prevents per-harness
    // pools from accumulating idle conns indefinitely (Next.js dev mode
    // module re-instantiation otherwise leaks the prior pool's sockets).
    // Override via PAPERCUSP_DB_IDLE_TIMEOUT (seconds; 0 disables).
    idle_timeout: poolIdleTimeoutSec(),
    // BIGINT → number. Our timestamps and attempt counts fit safely in Number's
    // 2^53 range; expected_cost_cents won't realistically exceed it. Override
    // case-by-case if a column ever needs full BIGINT precision. Shared
    // constant (EI-9265) so hand-rolled test/script clients can mirror this
    // exactly instead of silently drifting — see PG_BIGINT_AS_NUMBER_TYPES.
    // Callers needing exact bigint precision (no silent >2^53 rounding) pass
    // `typesOverride: {}` — see getOrgPgLosslessBigint (EI-18789855771421275).
    // EI-19331550321709126: PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES is merged in
    // UNCONDITIONALLY (not part of the overridable `typesOverride`) — a bare
    // OID-1114 `timestamp` value must parse as UTC on every canonical
    // connection, independent of whichever bigint behavior the caller chose.
    types: { ...typesOverride, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
  });
  // EI-13076: pre-arm the date-OID serializers as sticky accessors BEFORE any
  // drizzle() wrap can replace them with transparent passthroughs — see
  // restoreRawDateSerializers. Without this, a raw `sql` Date param on this
  // shared client throws (Buffer.byteLength(Date)) after the first drizzle
  // wrap — including runtime `drizzle(tx)` calls that share this options object.
  restoreRawDateSerializers(client);
  // EI-18698602043482898: same fix for the jsonb/json OIDs — see
  // restoreRawJsonbSerializer. Without this, whichever of `sql.json(v)` /
  // `${JSON.stringify(v)}::jsonb` doesn't match drizzle's mutated state
  // silently double-encodes (or throws).
  restoreRawJsonbSerializer(client);
  // WI-41207: seed postgres-js's array-type map with the built-in element->array OIDs so
  // `sql.array(...)` is correctly typed on the FIRST query of this pool. Without it that query
  // is built against an empty map, the array parameter silently degrades to its ELEMENT type,
  // and the server rejects it with "op ANY/ALL (array) requires array on right side" — while the
  // identical call a moment later succeeds. See seedBuiltinArrayTypes for the full mechanism.
  seedBuiltinArrayTypes(client);
  // EI-21301868186403490: postgres-js has no `number` case in inferType and coerces the miss to
  // TEXT, so `sql.array([1, 2, 3])` is declared text[] and the server rejects it with "operator
  // does not exist: integer = text" — on a WARMED pool too, which is why the seeding above cannot
  // help. This types number arrays as int8[] (float8[] when a value is not a safe integer).
  installNumericArrayTyping(client);
  return client;
}

export interface OrgPgHandle {
  sql: Sql;
  /**
   * @deprecated since Phase 1 of the Drizzle migration. Equivalent to
   * `.db` but only the 5 hand-written tables are in its schema config.
   * New code should use `.db` to access all 125 introspected tables.
   */
  drizzle: ReturnType<typeof drizzle>;
  /**
   * Drizzle instance bound to the full introspected schema (all 125
   * tables + relation graph). Use this for typed queries:
   *   const { db } = getOrgPg();
   *   await db.select().from(generated.projectsInHarness_shared);
   *   const rows = await db.query.projectsInHarness_shared.findMany();
   */
  db: ReturnType<typeof drizzle<typeof fullSchema>>;
  schema: typeof sharedSchema;
}

/**
 * Typed-result wrapper around a raw postgres-js template tag. Use when
 * you want to keep the raw SQL (search-path tricks, custom CTEs,
 * tsvector ops, NOTIFY) but get back a typed row array:
 *
 *   type Row = { id: string; ts: number };
 *   const rows = await typedSql<Row>(getOrgPg().sql)`
 *     SELECT id, ts FROM audit_log WHERE actor = ${actor}
 *   `;
 *
 * Returns plain arrays (drops postgres-js's Result metadata). Use the
 * raw `.sql\`...\`` template directly if you need that metadata.
 */
export function typedSql<R = Record<string, unknown>>(
  client: Sql,
): (strings: TemplateStringsArray, ...params: unknown[]) => Promise<R[]> {
  return async (strings, ...params) => {
    const rows = await (client as any)(strings, ...params);
    return rows as R[];
  };
}

/**
 * WI-5244 class (2): a discovery-file target is a SPOOFABLE trust point — ANY
 * local install can rewrite ~/.papercusp/embedded-pg.json (a packaged Papercusp
 * Server did exactly that on 2026-07-17 08:29Z and pointed the shared bg-host's
 * pools at its own empty, partial-schema `papercusp` DB; nothing alarmed, so the
 * drift surfaced ~40 minutes later as a confusing mid-gate `column … does not
 * exist` failure). Env-pinned URLs (DATABASE_URL / HARNESS_*_DATABASE_URL — i.e.
 * every managed host: systemd units, deploy) are inherently trusted and are NOT
 * re-validated here; this covers ONLY the specifically spoofable discovery-file
 * path, firing once per newly-built pool. Fire-and-forget + fail-soft by design:
 * a validation-query failure (including the DB being briefly unreachable) must
 * never affect the real pool or block/throw on the caller.
 */
/**
 * STORE IDENTITY (plan outage-must-not-be-silent-2026-08-02, D-001) — why the WI-5244
 * check above is necessary but NOT sufficient, and why this runs on EVERY pool.
 *
 * The schema check asks *"is this a plausible papercusp database?"*. On 2026-08-02 22:40Z
 * the answer was yes and the database was still the wrong one: an ephemeral operator
 * instance's embedded Postgres, freshly migrated with 433 tables. It was alive, listening,
 * and schema-complete — so the pid gate, the port gate and the WI-5244 check all PASSED —
 * and it answered `not_found` for every record in the real store. A confident wrong answer,
 * indistinguishable from data loss, for ~13 minutes fleet-wide.
 *
 * `system_identifier` is the discriminator none of those three has: initdb assigns it per
 * cluster and it never changes, so an impostor cluster cannot share ours while our own
 * restarts, port shuffles and reconnects keep it. See store-identity.ts for the full lineage.
 *
 * Two deliberate scope choices:
 *
 *  - **Identity is probed for EVERY managed pool, not just discovery-sourced ones**, unlike
 *    the WI-5244 schema check. The pin must be established from the TRUSTED env/native path
 *    at boot; if only spoofable pools were probed, the first impostor to be observed would
 *    become the pin and legitimise itself. Pinning early is what makes the later comparison
 *    mean anything.
 *  - **Fail-soft on an unreadable probe, loud on a positive mismatch.** A query error, a
 *    missing column, an old server — anything that merely prevents the check — is
 *    `indeterminate` and changes nothing, mirroring the generic resolver's rule that a check
 *    which cannot run must never reject a healthy configuration. Only two successfully-read,
 *    genuinely different identities are ever treated as a violation.
 */
function validateDiscoveryTargetOnce(
  sql: Sql,
  label: string,
  opts: { url: string; checkSchema: boolean },
): void {
  const probeGeneration = _identityProbeTestGeneration;
  void sql<Array<{ t: string | null; system_identifier: string | null; database: string | null }>>`
      SELECT to_regclass('harness_shared.schema_migrations')::text AS t,
             (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
             current_database() AS database`
    .then((rows) => {
      // `_resetForTests` may have retired this pool while the fire-and-forget query was in
      // flight. Its result belongs to the old test generation and must not pin or reject the
      // replacement cluster (EI-20321995598569419).
      if (probeGeneration !== _identityProbeTestGeneration) return;
      if (opts.checkSchema && !rows[0]?.t) {
        console.error(
          `[connection] WI-5244: the ${label} pool resolved via the discovery file ` +
            `(~/.papercusp/embedded-pg.json) but harness_shared.schema_migrations does not ` +
            `exist at that target — this looks like an IMPOSTOR/mismatched papercusp DB, ` +
            `not the real managed database. Check ~/.papercusp/embedded-pg.json for a recent ` +
            `rewrite by another local install (see WI-5244).`,
        );
      }
      const verdict = pinOrVerifyStoreIdentity(parseStoreIdentity(rows), opts.url);
      if (verdict.kind === 'mismatch') {
        console.error(
          `${describeStoreIdentityMismatch(verdict.pinned, verdict.observed)}\n  pool: ${label}`,
        );
        // ENFORCE, don't merely report. The latched violation stays the durable record
        // (that is what diagnostics read), but a detector that only narrates lets the
        // impostor keep answering — which is exactly how ~13 minutes of confident wrong
        // answers happened with this very check already deployed and firing.
        _quarantineDiscoveryEndpointIfProvenForeign(verdict.pinned, verdict.observed);
      }
    })
    .catch(() => {
      // fail-soft — never let a validation-query error affect the real pool
    });
}

/**
 * Admin (cross-harness) client. Use for views/aggregations/projects/messages.
 *
 * search_path includes `papercusp_shared` so the Papercup-specific tables
 * (messages, message_recipients, message_comments, directive_summaries) that
 * were extracted into their own schema in Stage 2 of the framework split
 * remain reachable from unqualified queries (e.g. legacy `INSERT INTO messages`).
 */
export function getOrgPg(): OrgPgHandle {
  // Call adminUrl() on every invocation so its discovery-file
  // change detection fires — it invalidates _adminClient internally
  // when the discovery URL has changed. Previously this was only
  // called once at first-client-build, so background workers that
  // booted before the desktop wrote a new embedded-pg.json caught
  // the old port forever (E2E round-13 bug #33).
  const url = maybePgbouncer(adminUrl());
  // …and then compare it to what the LIVE pool was actually built with, which
  // is what finally closes that same bug class for good (EI-19285027465993737).
  if (endStalePool(_adminClient, _adminClientUrl, url, 'org-admin')) {
    _adminClient = null;
    _adminDrizzle = null;
    _adminDb = null;
  }
  if (!_adminClient) {
    // pooled = pgbouncerEnabled(): the url above is maybePgbouncer(adminUrl()), which only
    // reroutes to the pooler when enabled — so the connection is pooled iff that's true.
    _adminClient = buildClient(url, ['harness_shared', 'papercusp_shared', 'public'], undefined, 'org-admin', pgbouncerEnabled());
    _adminClientUrl = url;
    _adminDrizzle = drizzle(_adminClient, { schema: sharedTables });
    _adminDb = drizzle(_adminClient, { schema: fullSchema });
    // WI-5244(2): only the discovery-file source is spoofable — env-pinned managed
    // hosts are already trusted, so skip the check there (cheap, but not free).
    validateDiscoveryTargetOnce(_adminClient, 'admin', {
      url,
      checkSchema: _resolvedAdminUrlSource === 'discovery',
    });
  }
  return {
    sql: _adminClient,
    drizzle: _adminDrizzle!,
    db: _adminDb!,
    schema: sharedSchema,
  };
}

/**
 * A DEDICATED, caller-owned org-admin client for a short-lived process.
 *
 * WI-638180: `getOrgPg()` hands back a process-wide singleton, so a library
 * that opens it can never close it — ending that pool would sever the operator
 * host's own database access. A one-shot CLI (the test runners' governed
 * admission seam) needs the opposite lifetime: its own pool, closed the moment
 * its last operation settles, so the process can exit on an empty event loop
 * instead of being pinned open by idle PgBouncer sockets.
 *
 * This is built through the same `buildClient` chokepoint as `getOrgPg()` —
 * same URL resolution, pgbouncer routing, type parsers, serializer repairs and
 * store-identity validation — so a dedicated client behaves identically to the
 * shared one. It is deliberately NOT cached: the caller owns it and MUST
 * `await sql.end(...)` it. Default pool `max` is small because a short-lived
 * process wants the fewest sockets that still allow its concurrent work.
 */
export function createDedicatedOrgPg(
  label: string,
  options: { readonly max?: number } = {},
): { sql: Sql; url: string } {
  const url = maybePgbouncer(adminUrl());
  const poolLabel = `org-admin-${label}`;
  const sql = buildClient(
    url,
    ['harness_shared', 'papercusp_shared', 'public'],
    Math.max(1, Math.floor(options.max ?? 2)),
    poolLabel,
    pgbouncerEnabled(),
  );
  validateDiscoveryTargetOnce(sql, poolLabel, {
    url,
    checkSchema: _resolvedAdminUrlSource === 'discovery',
  });
  return { sql, url };
}

/**
 * Direct admin LISTEN client for cross-workspace invalidation consumers.
 *
 * `getOrgPg()` deliberately routes its query pool through PgBouncer's
 * transaction mode on server-class hosts. That mode is correct for ordinary
 * request/response queries but not for LISTEN: a session-bound subscription
 * cannot survive transaction-pool reassignment, and PgBouncer logs/discards
 * NotificationResponse packets arriving on an unlinked server connection.
 * Keep this client on the resolved admin URL without `maybePgbouncer()` and
 * keep it alive while idle because idleness is the subscription's purpose.
 *
 * The URL is resolved on every call so discovery-file endpoint changes rebind
 * this client through the same built-with-vs-resolved guard as the query pools.
 */
export function getOrgPgListener(): { sql: Sql } {
  const url = adminUrl();
  if (endStalePool(_orgListenerClient, _orgListenerClientUrl, url, 'org-admin-listener')) {
    _orgListenerClient = null;
    _orgListenerClientUrl = null;
  }
  if (!_orgListenerClient) {
    assertRealPgAllowed('org-admin-listener', url);
    _orgListenerClient = postgres(url, {
      ...longLivedPoolConnectionOptions('org-admin-listener'),
      max: 1,
      // LISTEN is idle by design; an idle timeout would silently drop the subscription.
      idle_timeout: 0,
      prepare: false,
    });
    _orgListenerClientUrl = url;
  }
  return { sql: _orgListenerClient };
}

/**
 * Default ceiling for {@link withDbCallDeadline} — comfortably under the ~300s
 * generic "no response or progress" idle-timeout an MCP client transport
 * imposes on a stuck call, so a deadline-wrapped call fails fast with a clear
 * cause well before the caller's own transport times out silently.
 */
export const DEFAULT_DB_CALL_DEADLINE_MS = 45_000;

/**
 * Thrown by {@link withDbCallDeadline} when the wrapped DB call does not
 * settle within its deadline.
 *
 * ## `pool` makes this MEASURE instead of speculate (EI-19485014132257783)
 *
 * The old message asserted one confident cause — "this most often means the
 * pool's INITIAL connection attempt failed" — which sent every reader chasing a
 * dead endpoint. Measured 2026-08-08, the real mechanism behind the fleet-wide
 * repeats was the other one entirely: CLIENT-side acquire-queue saturation with
 * Postgres demonstrably healthy (344/512 connections, reads at 39ms). "The
 * database looks fine" is the EXPECTED reading during that failure, not
 * evidence against it.
 *
 * So when a `pool` is known, the acquire registry's own counters lead the
 * message and the speculation follows as fallback. The registry is per-process
 * and zero-I/O by construction: any diagnostic query would queue behind the
 * exact saturation it is trying to report.
 */
export class DbCallDeadlineError extends Error {
  readonly label: string;
  readonly deadlineMs: number;
  readonly elapsedMs: number;
  /** The pool label the acquisition was against (`org-app`/`org-admin`), when known. */
  readonly pool: string | null;
  /** The measured acquire-pressure line, or null when nothing was measured. */
  readonly measured: string | null;
  /**
   * True only when this process measured a recent successful acquisition or a
   * client-side saturation/queue verdict for the pool. An unmeasured or stale
   * pool may still be a dead endpoint, so those deadlines stay non-retryable.
   */
  readonly retryable: boolean;
  constructor(label: string, deadlineMs: number, elapsedMs: number, pool?: string) {
    const measured = pool ? describeAcquirePressure(pool) : null;
    // A decisive measurement has already answered "which cause"; re-printing the
    // cause fork after it would bury the answer under the procedure it replaces.
    const tail = measured?.decisive
      ? ACQUIRE_QUEUE_LOCATION_RESIDUAL
      : `Two causes present identically at this point — (a) the pool's resolved endpoint is ` +
        `unreachable and postgres.js is silently retrying its INITIAL connect forever without ` +
        `rejecting (WI-7097), or (b) the CLIENT pool's acquire queue is saturated while the ` +
        `server is perfectly healthy. Server capacity does NOT decide (b), so ` +
        `dev:service_health / pg_stat_activity looking fine is not evidence against it — ` +
        `check this process's own pcusp:${pool ?? '<pool>'}:p<pid> rows and ` +
        `PAPERCUSP_DB_POOL_MAX before the endpoint (WI-7097).`;
    super(
      // Stamped with the emitting BUILD — see build-stamp.ts (EI-19484133375867605).
      `${stampedTag('db-call-deadline')} "${label}" did not resolve within ${deadlineMs}ms ` +
        `(waited ${elapsedMs}ms). ` +
        (measured
          ? `${measured.text} `
          : `No acquire measurements were available for this call, so both causes are still open. `) +
        tail,
    );
    this.name = 'DbCallDeadlineError';
    this.label = label;
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
    this.pool = pool ?? null;
    this.measured = measured?.text ?? null;
    this.retryable = measured?.decisive === true;
  }
}

/** Options for the narrow pre-handler retry used by dispatch seams. */
export interface RetryOnRetryableDbDeadlineOptions {
  /** Additional attempts after the first. Defaults to two. */
  retries?: number;
  /** Linear backoff base in milliseconds. Defaults to 150ms. */
  backoffMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional observability hook before each retry. */
  onRetry?: (attempt: number, error: DbCallDeadlineError) => void;
}

const defaultDbDeadlineRetrySleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry only a deadline that the local acquire registry proved is pool
 * pressure, never an ambiguous/dead-endpoint deadline.
 *
 * This is intentionally a generic wrapper rather than a retry inside the
 * checkpoint handler: callers must use it around a transaction that has not
 * entered the caller's handler yet. A `DbCallDeadlineError` from a decisive
 * queue/saturation measurement means the acquisition did not complete in the
 * first attempt, while the transaction's own `expired()` guard prevents its
 * eventual late connection from invoking the handler. Retrying that
 * pre-handler acquisition cannot duplicate the later write; retrying the whole
 * tool after an ambiguous deadline could.
 */
export async function retryOnRetryableDbDeadline<T>(
  run: () => Promise<T>,
  opts: RetryOnRetryableDbDeadlineOptions = {},
): Promise<T> {
  const retries = Math.max(0, Math.floor(opts.retries ?? 2));
  const backoffMs = Math.max(0, opts.backoffMs ?? 150);
  const sleep = opts.sleep ?? defaultDbDeadlineRetrySleep;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run();
    } catch (error) {
      const deadline = error instanceof DbCallDeadlineError ? error : null;
      if (!deadline?.retryable || attempt >= retries) throw error;
      opts.onRetry?.(attempt + 1, deadline);
      await sleep(backoffMs * (attempt + 1));
    }
  }
  throw new Error('retryOnRetryableDbDeadline: unreachable');
}

/**
 * Caller-facing deadline for ONE DB round trip — WI-7097.
 *
 * Root cause this guards against (verified in `node_modules/postgres/src/connection.js`):
 * `closed()` special-cases a pool's FIRST ("initial") connection attempt — on
 * failure it calls `reconnect()` with exponential backoff FOREVER, and never
 * invokes `error()`/`queryError()` to reject the caller's pending query. So a
 * query issued while the pool is still in that "never yet connected" state
 * (e.g. right after boot against a not-yet-up embedded PG, or a genuinely dead
 * endpoint) neither resolves nor rejects — the caller's only signal ends up
 * being whatever generic idle-timeout ITS OWN transport happens to impose
 * (e.g. an MCP client's blanket 300s "no response or progress" abort), with
 * zero information about the real cause.
 *
 * This is deliberately NOT a substitute for `connect_timeout` (see this
 * file's `connectTimeoutSec`, left disabled outside tests on purpose to
 * tolerate a slow embedded-pg cold boot): it bounds one CALLER's wait, not
 * the pool's retry policy, so anything that legitimately needs to wait out a
 * boot race is unaffected as long as it doesn't itself call through this
 * wrapper. When the deadline wins the race, the underlying query/connection
 * attempt is NOT cancelled — it keeps retrying in the background exactly as
 * before; this only stops the caller from waiting on it.
 *
 * Usage: `await withDbCallDeadline(sql\`SELECT …\`, { label: '…' })`.
 */
export function withDbCallDeadline<T>(
  promise: Promise<T>,
  opts: { ms?: number; label: string },
): Promise<T> {
  const ms = opts.ms ?? DEFAULT_DB_CALL_DEADLINE_MS;
  const label = opts.label;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DbCallDeadlineError(label, ms, Date.now() - startedAt));
    }, ms);
    // Never hold the process open on this timer alone.
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Default ceiling for {@link withAcquisitionDeadline} — the ACQUISITION phase
 * only (connect + BEGIN + the SET_CONFIG statements), never the caller's own
 * work. Generous on purpose: this box runs a large agent fleet, so a legitimate
 * pool wait under contention can take seconds, and a false positive here would
 * fail a call that was merely queued. 45s is still finite, which is the entire
 * point — see below.
 */
export const DEFAULT_TX_ACQUIRE_DEADLINE_MS = Math.max(
  1_000,
  Number(process.env.PAPERCUSP_DB_TX_ACQUIRE_DEADLINE_MS) || 45_000,
);

/**
 * Phase-scoped deadline: bound the part of a DB call that happens BEFORE the
 * caller's callback runs, and disarm the moment it starts — P-022 / D-020.
 *
 * WHY THIS EXISTS AND WHY {@link withDbCallDeadline} CANNOT BE USED INSTEAD.
 * `withDbCallDeadline` races an ENTIRE promise, so wrapping `sql.begin(...)`
 * with it would also bound the caller's handler and kill legitimately long
 * tools. The hang this guards against happens strictly earlier: against a dead
 * endpoint, postgres-js's `closed()` special-cases a pool's FIRST connection
 * attempt and calls `reconnect()` with exponential backoff FOREVER without ever
 * invoking `error()`/`queryError()` — so the caller's query is never rejected
 * and the call blocks at `sql.begin()` BEFORE its handler runs. That is what
 * took 100% of MCP dispatch down on 2026-08-03 (including `coord:whoami`) while
 * `/api/health` stayed at 2ms on the unaffected ADMIN pool; only a process
 * restart cleared it.
 *
 * `run` receives:
 *  - `disarm()`  — call once the caller's own work is about to begin.
 *  - `expired()` — true if the deadline already fired. CHECK THIS before
 *    invoking the caller's callback and throw if set: `Promise.race` does not
 *    cancel the losing promise, so without the check a timed-out transaction
 *    would still run the handler with nobody awaiting its result. Throwing
 *    inside the `sql.begin` callback rolls the transaction back instead.
 *
 * `opts.pool` is the `buildClient` label of the pool being acquired from
 * (`org-app` / `org-admin`). Passing it registers this acquisition in the
 * acquire registry, which is what lets a breach report MEASURED waiting/held
 * counts instead of the manual 3-step probe — see `acquire-registry.ts`. It is
 * optional so a caller with no single identifiable pool still gets the guard.
 */
export function withAcquisitionDeadline<T>(
  run: (phase: { disarm: () => void; expired: () => boolean }) => Promise<T>,
  opts: { ms?: number; label: string; pool?: string },
): Promise<T> {
  const ms = opts.ms ?? DEFAULT_TX_ACQUIRE_DEADLINE_MS;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let expired = false;
  // Registered BEFORE the first await so this caller counts itself among the
  // waiters its own error reports — "18 waiting, oldest 44.9s" includes you.
  const ticket = opts.pool ? beginAcquire(opts.pool) : null;
  const clearDeadlineTimer = () => {
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  // What `run` receives: the connection is in hand and the caller's own work is
  // about to begin, so stop the clock AND move this ticket waiting -> held.
  const disarm = () => {
    clearDeadlineTimer();
    ticket?.acquired();
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      expired = true;
      settled = true;
      // Constructed while this ticket is still WAITING, on purpose: the snapshot
      // in the message is the state at the moment of the breach.
      reject(new DbCallDeadlineError(opts.label, ms, Date.now() - startedAt, opts.pool));
    }, ms);
    // Never hold the process open on this timer alone.
    timer.unref?.();
  });
  let work: Promise<T>;
  try {
    work = Promise.resolve(run({ disarm, expired: () => expired }));
  } catch (error) {
    clearDeadlineTimer();
    ticket?.release();
    return Promise.reject(error);
  }
  return Promise.race([work, deadline]).finally(() => {
    clearDeadlineTimer();
    // Must run on EVERY exit path — a ticket that is never released leaks a
    // waiter and inflates every later snapshot, which would make this
    // diagnostic worse than none.
    ticket?.release();
  });
}

/**
 * Admin client WITHOUT the bigint→number override (EI-18789855771421275).
 *
 * `getOrgPg()` deliberately converts int8/bigserial (oid 20) to a JS `number`
 * for convenience (EI-9265) — correct for the columns callers actually rely on
 * (which fit safely under 2^53), but WRONG for arbitrary agent-supplied SQL: a
 * `pg_stat_statements.queryid`, a snowflake work-item id, or any other genuine
 * 64-bit value beyond `Number.MAX_SAFE_INTEGER` gets silently ROUNDED — and the
 * rounded value is a syntactically valid bigint that just matches ZERO rows,
 * which reads as a legitimate empty result, not an error (see the EI for the
 * full incident: an agent nearly recorded a false "already fixed, zero calls"
 * verdict because of this).
 *
 * Use for ANY surface that runs ad-hoc/agent-authored SQL and returns bigint
 * columns verbatim (currently: `pgReadQuery` / `dev:pg_query`) — NOT for
 * application code with known-safe numeric columns, which should keep using
 * `getOrgPg()`/`getOrgPgApp()` so existing `typeof x === 'number'` assumptions
 * (WI-3880) keep holding. Deliberately a SEPARATE, small (`max: 2`), dedicated
 * pool rather than mutating the shared admin client's parser: postgres-js's
 * `options.parsers` map is one shared object across every concurrent query on
 * that client, so a per-call override would race every OTHER concurrent
 * `getOrgPg()` caller on this heavily-parallel box.
 *
 * With no override, postgres-js's OWN default oid-20 parser applies — an int8
 * column comes back as an exact-precision JS STRING (the same reason
 * node-postgres does this by default too). Reflected in `processConnectionCeiling`'s
 * `fixedOverhead` (+2) so the connection-budget guard stays honest about this pool.
 */
export function getOrgPgLosslessBigint(): { sql: Sql } {
  const url = maybePgbouncer(adminUrl());
  // Same rebind guard as getOrgPg — this pool is built from the SAME adminUrl(),
  // so it is vulnerable to the identical stale-target bug and must not be left
  // serving a dead endpoint after its sibling recovers (EI-19285027465993737).
  if (endStalePool(_adminLosslessBigintClient, _adminLosslessBigintClientUrl, url, 'org-admin-lossless-bigint')) {
    _adminLosslessBigintClient = null;
  }
  if (!_adminLosslessBigintClient) {
    _adminLosslessBigintClient = buildClient(
      url,
      ['harness_shared', 'papercusp_shared', 'public'],
      2,
      'org-admin-lossless-bigint',
      pgbouncerEnabled(),
      // No bigint override — postgres-js's own default (exact string) applies.
      // Preserve OID-1184 text too; Date would discard microseconds from an
      // arbitrary agent-authored SQL result (EI-21569018799980044).
      PG_TIMESTAMPTZ_AS_STRING_TYPES,
    );
    _adminLosslessBigintClientUrl = url;
  }
  return { sql: _adminLosslessBigintClient };
}

let _appOrgClient: Sql | null = null;
let _appOrgDrizzle: ReturnType<typeof drizzle> | null = null;
let _appOrgDb: ReturnType<typeof drizzle<typeof fullSchema>> | null = null;
// The URL the cached APP pool was ACTUALLY BUILT WITH — the app-side counterpart
// of `_adminClientUrl` (connection.ts:694). See the rebind guard in getOrgPgApp().
let _appOrgClientUrl: string | null = null;

/**
 * App-role org client. Same search_path as `getOrgPg()` but uses the
 * `harness_app` role, which is SUBJECT to RLS policies on
 * `harness_shared.*`. Required for the workspace-scoping contract:
 * `withWorkspace()` opens a transaction on this client and issues
 * `SET LOCAL app.workspace_id` so RLS predicates can filter by it.
 *
 * Use `getOrgPg()` only for migrations and tooling that intentionally
 * spans workspaces (the harness_admin role bypasses RLS).
 */
export function getOrgPgApp(): OrgPgHandle {
  // Call appUrl() on every invocation — see comment in getOrgPg().
  const url = maybePgbouncer(appUrl());
  // …and then COMPARE it to what the live pool was built with. Without this the
  // recomputed `url` was dead code on the cache-hit path: appUrl()'s own teardown
  // (connection.ts:480) lives inside `if (disc)`, so it fires only on
  // discovery→DIFFERENT-discovery and misses discovery→ABSENT — the dead-pid /
  // clean-shutdown shape that IS the EI-19285027465993737 incident. That hole was
  // closed for the two admin pools and left open on the app pool, which is the one
  // every workspace-scoped MCP call takes via withWorkspace() (EI-19461720588871359).
  if (endStalePool(_appOrgClient, _appOrgClientUrl, url, 'org-app')) {
    _appOrgClient = null;
    _appOrgDrizzle = null;
    _appOrgDb = null;
  }
  if (!_appOrgClient) {
    // pooled = pgbouncerEnabled() (url = maybePgbouncer(appUrl())) — see getOrgPg().
    _appOrgClient = buildClient(url, ['harness_shared', 'papercusp_shared', 'public'], undefined, 'org-app', pgbouncerEnabled());
    _appOrgClientUrl = url;
    _appOrgDrizzle = drizzle(_appOrgClient, { schema: sharedTables });
    _appOrgDb = drizzle(_appOrgClient, { schema: fullSchema });
    // WI-5244(2) + store identity — see the matching check in getOrgPg() above.
    validateDiscoveryTargetOnce(_appOrgClient, 'app', {
      url,
      checkSchema: _resolvedAppUrlSource === 'discovery',
    });
  }
  return {
    sql: _appOrgClient,
    drizzle: _appOrgDrizzle!,
    db: _appOrgDb!,
    schema: sharedSchema,
  };
}

/**
 * Per-harness client with search_path scoped to that harness's schema.
 * Unqualified `harness_features` resolves to harness_<slug>.harness_features.
 * Shared tables remain reachable as `projects`, `messages`, etc.
 *
 * `papercusp_shared` is included so org.ts message-bus queries running with a
 * per-harness client (e.g. department harnesses) still resolve unqualified
 * `messages`, `message_recipients`, etc.
 */
export function getHarnessPg(slug: string) {
  const cached = _harnessClients.get(slug);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }
  evictHarnessPoolsIfFull();
  const schemaName = sharedSchema.slugToSchemaName(slug);
  const perHarnessMax = Math.max(1, Number(process.env.PAPERCUSP_HARNESS_DB_POOL_MAX) || 1);
  // PgBouncer-safety (backend-connection-scaling-2026-06-17 C2): the per-harness
  // pools rely on a CONNECT-TIME search_path (`harness_<slug>` first) so unqualified
  // `harness_features` etc. resolve to this harness's schema. Transaction pooling does
  // NOT preserve a connect-time search_path, and the ~18 legacy `getLegacyClient(slug)`
  // / direct `getHarnessPg(slug).sql` call sites issue multi-statement AUTOCOMMIT
  // queries that can't be transparently wrapped. So these pools INTENTIONALLY stay
  // DIRECT (bypass maybePgbouncer) even under PAPERCUSP_PGBOUNCER=1. This is cheap: the
  // harness pools are LRU-capped at HARNESS_POOL_CAP (8) × perHarnessMax (1) per process
  // — NOT the connection bloat (that's the org pools, ~48 each, which DO get pooled).
  // The pooler-safe alternative for new code is `harnessQuery(slug, fn)` (per-tx
  // SET LOCAL search_path on the pooled org-app pool); migrating the legacy sites onto
  // it is the follow-up that lets even these pools route through the pooler.
  const sql = buildClient(appUrl(), [schemaName, 'harness_shared', 'papercusp_shared', 'public'], perHarnessMax, `harness:${slug}`);
  const dz = drizzle(sql, { schema: sharedTables });
  const db = drizzle(sql, { schema: fullSchema });
  const handle: HarnessClient = { sql, drizzle: dz, db, lastUsed: Date.now() };
  _harnessClients.set(slug, handle);
  return handle;
}

/**
 * The worst-case number of PG connections THIS process can open across all its
 * pools. C0-4 of backend-connection-scaling-2026-06-17: the 2026-06-17 outage
 * was a pool-sizing change (each org pool sized to pgPoolMax=52 on a 100-slot DB)
 * shipping without the DB ceiling being raised to match. This makes that math
 * explicit so a boot-time guard can catch the next such regression loudly.
 *
 * `fixedOverhead` covers the admin-pg-cache (ADMIN_PG_CACHE_MAX=8, in
 * packages/operator-core) + the 6 long-lived LISTEN connections (sync-sse,
 * coord-inbox, pending-events, fleet-assignment, agent-activity, and the
 * agent-mcp principal-invalidation listener) — both live in other packages, so
 * they're a documented constant here — + the small (max 2) dedicated
 * `getOrgPgLosslessBigint()` pool (EI-18789855771421275).
 */
export function processConnectionCeiling(): {
  poolMax: number;
  orgPools: number;
  harnessPools: number;
  fixedOverhead: number;
  total: number;
} {
  const poolMax = resolveOrgPoolMax();
  const orgPools = poolMax * 2; // getOrgPg (admin) + getOrgPgApp (app/RLS)
  const perHarnessMax = Math.max(1, Number(process.env.PAPERCUSP_HARNESS_DB_POOL_MAX) || 1);
  const harnessPools = HARNESS_POOL_CAP * perHarnessMax;
  const fixedOverhead =
    8 /* admin-pg-cache */ +
    6 /* LISTEN buses, incl. agent-mcp principal invalidation */ +
    2 /* org-admin-lossless-bigint pool */;
  return { poolMax, orgPools, harnessPools, fixedOverhead, total: orgPools + harnessPools + fixedOverhead };
}

/**
 * Pure verdict for {@link logConnectionBudget} (EI-3379 — unit-testable, no DB). The
 * worst-case PG-BACKEND pressure this process group contributes vs the live
 * max_connections.
 *
 * Under a transaction pooler the org pools are pgbouncer CLIENT slots, NOT PG backends
 * — pgbouncer bounds real backends at default_pool_size regardless of process count —
 * so they do NOT multiply the per-process backend ceiling. Only the DIRECT pools open
 * backends that scale with process count: per-harness `getHarnessPg` (stays direct,
 * D-005), the LISTEN buses, the admin cache, the watchdog tick-lock (the fixedOverhead).
 * Counting the pooled org pools as direct is what made the budget log cry false DANGER
 * on every correctly-pooled multi-worker boot (a 15-worker cluster reported ~1104 vs a
 * live, pgbouncer-bounded 199/512).
 */
export function connectionBudgetStatus(opts: {
  orgPools: number;
  harnessPools: number;
  fixedOverhead: number;
  pooled: boolean;
  expectedProcesses: number;
  liveMax: number;
}): { directPerProc: number; fleetWorst: number; danger: boolean } {
  const directPerProc = (opts.pooled ? 0 : opts.orgPools) + opts.harnessPools + opts.fixedOverhead;
  const procs = Math.max(1, Math.floor(opts.expectedProcesses) || 1);
  const fleetWorst = directPerProc * procs;
  const danger = opts.liveMax > 0 && fleetWorst > opts.liveMax * 0.9;
  return { directPerProc, fleetWorst, danger };
}

/**
 * Log this process's connection ceiling vs the LIVE `max_connections`, warning
 * loudly when the fleet-wide worst case would approach the ceiling. Best-effort
 * (queries PG; silent if unreachable). `expectedProcesses` defaults from
 * PAPERCUSP_EXPECTED_OPERATOR_PROCS (the dev box runs :3070 + :3170 → 2). C0-4.
 */
export async function logConnectionBudget(
  log: (m: string) => void = (m) => console.warn(m),
): Promise<void> {
  const { orgPools, harnessPools, fixedOverhead, poolMax } = processConnectionCeiling();
  const poolOverrideWarning = explicitOrgPoolOverrideWarning();
  let liveMax = 0;
  try {
    const rows = (await getOrgPg().sql`SELECT current_setting('max_connections')::int AS m`) as {
      m: number;
    }[];
    liveMax = rows[0]?.m ?? 0;
  } catch {
    // PG unreachable at boot — skip (the diagnostic is non-fatal).
  }
  const expectedProcs = Math.max(1, Number(process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS) || 2);
  const pooled = pgbouncerEnabled();
  const { directPerProc, fleetWorst, danger } = connectionBudgetStatus({
    orgPools,
    harnessPools,
    fixedOverhead,
    pooled,
    expectedProcesses: expectedProcs,
    liveMax,
  });
  // EI-3379: when pooled, org pools are pgbouncer client slots (real backends bounded by
  // default_pool_size, not by process count), so they're excluded from the per-process
  // backend tally and flagged as such — the warning now reflects DIRECT backend pressure.
  const orgNote = pooled
    ? `org ${orgPools} @ poolMax ${poolMax} POOLED (pgbouncer client slots; backends bounded by default_pool_size)`
    : `org ${orgPools} @ poolMax ${poolMax}`;
  const head =
    `[pg-budget] pid ${process.pid}: <=${directPerProc} direct conns/process ` +
    `(${orgNote} + harness ${harnessPools} + cache/listeners ${fixedOverhead}); ` +
    `~${fleetWorst} direct across ${expectedProcs} proc(s)`;
  const configNote = poolOverrideWarning ? ` — WARNING: ${poolOverrideWarning}` : '';
  if (danger) {
    const remedy = pooled
      ? `Run \`npx tsx scripts/pg-autotune.ts --apply\` (raise the ceiling to the host) or lower ` +
        `PAPERCUSP_HARNESS_POOL_CAP / PAPERCUSP_EXPECTED_OPERATOR_PROCS — org pools are already pooled, ` +
        `so the DIRECT pools (harness + LISTEN + admin) are the pressure.`
      : `Run \`npx tsx scripts/pg-autotune.ts --apply\` (raise the ceiling to the host), lower ` +
        `PAPERCUSP_DB_POOL_MAX, or front PG with PgBouncer.`;
    log(`${head} — DANGER vs live max_connections=${liveMax}. ${remedy}${configNote}`);
  } else {
    log(`${head} vs live max_connections=${liveMax || '?'} — ok${configNote}`);
  }
}

/**
 * Test-only: close all open pools so a different DATABASE_URL can be used.
 *
 * EI-14436: this MUST also clear the resolved-URL cache (`_resolvedAdminUrl` /
 * `_resolvedAppUrl`), not just the client pools. `adminUrl()`/`appUrl()` cache
 * an 'env'-sourced URL as stable "for process lifetime" and short-circuit
 * BEFORE re-reading `process.env` on every subsequent call — so a test that
 * mutates `HARNESS_ADMIN_DATABASE_URL`/`HARNESS_DATABASE_URL`/`DATABASE_URL`
 * AFTER an earlier (unrelated) call in the same worker process already resolved
 * + cached the admin/app URL from a DIFFERENT env value (e.g. a shell-inherited
 * `DATABASE_URL` pointing at the real native/dev database) would find this
 * function a no-op for its purpose: it nulls the pools, but the next
 * getOrgPg()/getOrgPgApp() call rebuilds them against the SAME STALE cached
 * URL, silently reconnecting to the wrong database. Observed live: every
 * summarizeOpenPlacements() assertion in placement-watchdog.integration.test.ts
 * queried the real dev DB's 200+ unrelated harness rows instead of the
 * test's own throwaway container, reading back an empty result deterministically
 * (100% reproduction in isolation, not a race) because the test's own env-var
 * reassignment in beforeAll never took effect. A handful of call sites already
 * worked around this by calling the separate `_resetUrlCacheForTests()` before
 * `_resetForTests()` (see sync/pot-git/serve-wiring.integration.test.ts) — fold
 * that into the one test-reset entrypoint so every caller gets it for free
 * instead of relying on each test file to know this footgun exists.
 */
export async function _resetForTests() {
  // Invalidate callbacks from identity probes issued by pools this reset is about to retire.
  // postgres-js pool shutdown does not order a detached promise's `.then` callback ahead of the
  // caller building its replacement pool, which previously let a stale ambient probe race a
  // testcontainer pin and report a false cross-store violation.
  _identityProbeTestGeneration += 1;
  // Test fixtures deliberately rotate between independent Postgres clusters. The production
  // identity pin is process-lifetime, but retaining it across this test-only reset makes the
  // replacement fixture look like a WRONG STORE and trips fail-on-console before the fixture
  // can run. Reset all test-only identity state with the pools it describes.
  _resetStoreIdentityForTests();
  _resetUrlCacheForTests();
  if (_adminClient) {
    await _adminClient.end({ timeout: 1 }).catch(() => {});
  }
  _adminClient = null;
  _adminDrizzle = null;
  _adminDb = null;
  _adminClientUrl = null;
  if (_orgListenerClient) {
    await _orgListenerClient.end({ timeout: 1 }).catch(() => {});
  }
  _orgListenerClient = null;
  _orgListenerClientUrl = null;
  if (_adminLosslessBigintClient) {
    await _adminLosslessBigintClient.end({ timeout: 1 }).catch(() => {});
  }
  _adminLosslessBigintClient = null;
  _adminLosslessBigintClientUrl = null;
  if (_appOrgClient) {
    await _appOrgClient.end({ timeout: 1 }).catch(() => {});
  }
  _appOrgClient = null;
  _appOrgDrizzle = null;
  _appOrgDb = null;
  // Clear the built-with URLs alongside their pools. Harmless today (endStalePool
  // returns false whenever the client is null, so a stale `builtWith` self-corrects
  // on the next build) but leaving a reset half-done is the trap that produced this
  // whole bug class — a var that records what a pool was built with must die with it.
  _appOrgClientUrl = null;
  for (const h of _harnessClients.values()) {
    await h.sql.end({ timeout: 1 }).catch(() => {});
  }
  _harnessClients.clear();
  // Same rule the block above states for `_appOrgClientUrl`: a var that records what
  // a pool was built with must die with the pool. Leaving `_servedAppUrl` set across
  // a reset would make the FIRST appUrl() of the next test compare against the
  // previous test's endpoint and evict a pool nothing was wrong with.
  _servedAppUrl = null;
}
