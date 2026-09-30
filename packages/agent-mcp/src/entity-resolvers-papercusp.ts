/**
 * Papercusp's entity resolvers — the host half of
 * tool-arg-referential-integrity-2026-07-19 P-004 / D-001.
 *
 * `@papercusp/tooldef` ships the `entityRef` TYPE and the `entity-check` dispatch
 * step, but no entity knowledge: the engine cannot know what a "pot" is. This
 * module supplies the existence checks, registered as a load-time side effect in
 * the same way `capability-tiers-papercusp.ts` registers the tier resolver.
 *
 * REGISTERING A RESOLVER IS WHAT ACTIVATES ENFORCEMENT for a kind — an
 * `entityRef` arg whose kind has no resolver is skipped, not rejected. That
 * makes the rollout safely staged: convert args first (inert), land the DB
 * foreign key, register the resolver last.
 *
 * WHY A CACHED SET IS ENOUGH. The entity sets here are small — ~145 pots, ~240
 * harness slugs — so the whole valid set fits in memory and validation is an
 * O(1) lookup with ZERO per-call queries. The resolver interface is batched
 * anyway (it receives every value of its kind at once), so a kind that outgrows
 * this can switch to one `= ANY($1)` without changing a caller.
 *
 * The cache is TTL'd rather than event-driven on purpose: a stale entry can only
 * ever cause a FALSE REJECTION of a just-created entity, and a short TTL bounds
 * that to seconds — whereas a missed invalidation event would strand the cache
 * indefinitely. `invalidateEntityCache()` is exported so a create/dissolve path
 * can drop it immediately and skip even that window.
 */

import {
  setEntityResolver,
  setEntityEnum,
  type EntityEnumerator,
  type EntityResolver,
} from '@papercusp/tooldef';
import { similarity } from '@papercusp/operator-core/lib/operator-fuzzy-dedup';

/** How long a loaded entity set is trusted before a refresh. */
const CACHE_TTL_MS = 30_000;
/** Below this similarity a "did you mean" is noise, not help. */
const SUGGEST_THRESHOLD = 0.6;
/** Name the full valid set in an error only when it is this small. */
const MAX_ALLOWED_IN_ERROR = 25;

/**
 * Registration mode for the publishable entity vocabularies. Unit mode keeps
 * `tools/list` hermetic: the pot and harness sets are database-backed and are
 * intentionally not useful to enumerate in a unit process. Live mode is the
 * explicit escape hatch for production and integration tests that exercise the
 * real registry.
 */
export type PapercuspEntityRegistrationMode = 'unit' | 'live';

export interface PapercuspEntityRegistrationOptions {
  /** Override the environment-selected mode for this registration. */
  mode?: PapercuspEntityRegistrationMode;
}

/** A no-op vocabulary: no values means no enum is added to the JSON schema. */
const EMPTY_ENTITY_ENUM: EntityEnumerator = async () => [];

/**
 * The shared unit test config signals its DB rail with PAPERCUSP_FORBID_REAL_PG.
 * Keep this module independent of that generic package: it consumes the signal
 * only. The VITEST fallback also protects the hand-rolled agent-mcp test config;
 * a suite that genuinely needs the live registry must opt in with `mode: live`
 * (and, for a real DB, PAPERCUSP_ALLOW_DB_IN_TESTS=1).
 */
function defaultEntityRegistrationMode(): PapercuspEntityRegistrationMode {
  if (process.env.PAPERCUSP_ALLOW_DB_IN_TESTS === '1') return 'live';
  if (process.env.PAPERCUSP_FORBID_REAL_PG === '1' || process.env.VITEST) return 'unit';
  return 'live';
}

interface CacheEntry {
  values: Set<string>;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop a cached set (or all of them) — call after creating/removing an entity. */
export function invalidateEntityCache(kind?: string): void {
  if (kind) cache.delete(kind);
  else cache.clear();
}

/**
 * Load-through cache. A LOAD FAILURE IS NOT CACHED and is rethrown, so the
 * dispatch step's fail-open path takes over rather than us serving an empty set
 * — an empty set would reject every value, turning a transient DB blip into a
 * fleet-wide outage of every tool naming that entity.
 */
async function loadSet(kind: string, load: () => Promise<string[]>): Promise<Set<string>> {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.values;
  const values = new Set(await load());
  cache.set(kind, { values, loadedAt: Date.now() });
  return values;
}

/** Nearest known values for an unknown one, best first. */
function suggestFor(value: string, known: Iterable<string>): string[] {
  return [...known]
    .map((k) => ({ k, s: similarity(value, k) }))
    .filter((x) => x.s >= SUGGEST_THRESHOLD)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.k);
}

/**
 * Build a resolver over a small, fully-loadable set. Exported so a host can add
 * a kind without repeating the cache/suggest/allowed plumbing.
 */
export function makeSetResolver(kind: string, load: () => Promise<string[]>): EntityResolver {
  return async (values) => {
    const known = await loadSet(kind, load);
    const unknown = values.filter((v) => !known.has(v));
    if (!unknown.length) return { unknown: [] };
    const suggestions: Record<string, string[]> = {};
    for (const u of unknown) {
      const near = suggestFor(u, known);
      if (near.length) suggestions[u] = near;
    }
    return {
      unknown,
      suggestions,
      // Only offer the full set when it is short enough to read; otherwise the
      // nearest-match above is the useful signal and a dump is pure noise.
      ...(known.size <= MAX_ALLOWED_IN_ERROR ? { allowed: [...known].sort() } : {}),
    };
  };
}

/**
 * THE UNIT-TIER RAIL — why a database reach is refused here rather than merely timed out.
 *
 * `registerPapercuspEntityResolvers()` still runs at MODULE SCOPE (bottom of this file),
 * so merely IMPORTING this module arms a registration process-wide. Its default is now
 * environment-aware: production gets the real DB-backed loaders, while the unit tier gets
 * hermetic empty enum loaders. A test or integration harness that genuinely needs the live
 * registry must opt in with `{ mode: 'live' }` (or the documented env escape hatch).
 *
 * Measured 2026-08-12 (EI-20248980966812937): `entity-resolvers-papercusp.test.ts` →
 * "does not publish a pot enum" called `applyEntityRefEnums('pot')`, whose registered
 * loader is `loadPots`, which reads `harness_shared.pots`. With the org pool starved the
 * connection ACQUIRE never completed, vitest hit its 5s default, and the red PINNED THE
 * RELEASE GATE for the whole fleet. Neither the test nor its subject had changed since
 * 2026-07-19 — so the red was not reproducible from the diff, and triage went hunting a
 * regression in a file nobody had touched in three weeks.
 *
 * That is the whole defect class: a unit-tier test that fails on DATABASE LOAD rather
 * than on code. Note `statement_timeout` cannot save you — it bounds server-side
 * execution once a connection is already open, and the hang is upstream of that, in the
 * acquire.
 *
 * So this THROWS instead of waiting. A timeout would still be a load-sensitive gate leg,
 * just a faster one; refusing outright makes the failure deterministic, instant, and
 * self-explaining. It is placed in `sql()` — the single funnel both DB-backed loaders
 * (`loadPots`, `loadHarnessSlugs`) already share — so a loader added later inherits the
 * rail without anyone remembering it exists.
 *
 * Escape hatch: an INTEGRATION-tier test that genuinely needs the real registry sets
 * `PAPERCUSP_ALLOW_DB_IN_TESTS=1`. That is the tier where a live DB belongs.
 *
 * ⚠ WHY THIS ALSO WARNS ON A CHANNEL THE THROW CANNOT REACH. `applyEntityRefEnums`
 * FAILS OPEN by design — it catches an enumerator's error and simply publishes no enum,
 * because "discovery must never break" (libs/generic/tooldef/src/entity-ref.ts, and the
 * test that pins it: "fails open when an enumerator throws"). That contract is correct
 * and this rail does not fight it. But it means the throw below is SWALLOWED on the enum
 * path: the test stops hanging (the gate red is fixed, which is the point) and then
 * passes silently, teaching nobody. So emit the diagnosis on a channel the swallow
 * cannot eat. Without this, the fix would be invisible in exactly the situation it
 * exists for, which is the same "a bounded measurement rendered as a clean pass" trap
 * that made the original red so expensive to triage.
 */
function assertNotUnitTier(): void {
  if (!process.env.VITEST || process.env.PAPERCUSP_ALLOW_DB_IN_TESTS === '1') return;
  // Survives applyEntityRefEnums' deliberate fail-open catch. Keep the marker string
  // stable — the recurrence guard asserts on it.
  console.error(
    '[entity-resolvers-papercusp] UNIT-TIER DB REACH REFUSED — a unit test reached the ' +
      'live org database through an entity loader. See the thrown error below for the fix ' +
      '(bind a stub loader or opt into live mode explicitly). This warning exists because the enum overlay fails open and ' +
      'would otherwise swallow that error, letting the test pass silently.',
  );
  throw new Error(
    'entity-resolvers-papercusp: a UNIT-tier test reached the live org database via an ' +
      'entity enum/resolver loader (loadPots / loadHarnessSlugs read harness_shared). ' +
      'Refused deliberately: this exact path red-pinned the release gate for the whole ' +
      'fleet when the org pool was starved (EI-20248980966812937), and a DB-load-sensitive ' +
      'unit test is a false red nobody can reproduce from the diff.\n' +
      "FIX: bind a stub loader in the test — setEntityEnum('pot', async () => [...]) or " +
      "setEntityResolver('pot', ...) — and invalidateEntityCache() in afterEach. The real " +
      'subject of these assertions is almost never WHICH rows exist (the pot/harness enums ' +
      'are over-cap and publish nothing regardless), so a stub tests exactly what the ' +
      'assertion claims to test.\n' +
      'If this genuinely IS an integration test that needs the live registry, set ' +
      'PAPERCUSP_ALLOW_DB_IN_TESTS=1 — but put it in the integration tier, not here.',
  );
}

/** Lazily reach the org DB — importing it is side-effect-free, so this stays cheap. */
async function sql() {
  assertNotUnitTier();
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql;
}

/** The pot registry: harness_shared.pots.pot_home_slug. */
async function loadPots(): Promise<string[]> {
  const s = await sql();
  const rows = await s<{ pot_home_slug: string }[]>`
    SELECT DISTINCT pot_home_slug FROM harness_shared.pots WHERE pot_home_slug IS NOT NULL
  `;
  return rows.map((r) => r.pot_home_slug);
}

/**
 * Harness slugs actually in use. Deliberately sourced from the pot registry PLUS
 * the distinct slugs already present on work items: `harness_slug` is currently
 * free text carrying three different value-kinds (real pot slugs, synthetic
 * `operator:<workspace>` buckets, sentinels like `*`), and rejecting the ones
 * already in the data would break live tools before the P-006/P-007 backfill
 * normalizes them. Once that backfill lands, this narrows to the pot registry
 * alone and the FK becomes the real gate.
 */
async function loadHarnessSlugs(): Promise<string[]> {
  const s = await sql();
  const rows = await s<{ slug: string }[]>`
    SELECT DISTINCT pot_home_slug AS slug FROM harness_shared.pots WHERE pot_home_slug IS NOT NULL
    UNION
    SELECT DISTINCT harness_slug AS slug FROM harness_shared.work_items WHERE harness_slug IS NOT NULL
  `;
  return rows.map((r) => r.slug);
}

/**
 * Workspaces (tool-arg-referential-integrity-2026-07-19 P-004, remaining slice).
 *
 * `entityRef('workspace')` was already converted onto 8 arg sites (cupboard
 * install/publish/*.ts) back when P-001/P-002 landed, but no resolver was ever
 * registered for the kind — per the "unregistered kind is SKIPPED, not
 * rejected" contract, that left every one of those 8 sites completely
 * unenforced despite carrying the marker. This closes that gap.
 *
 * Small + cross-tenant by construction (there are ~9 workspaces on this host,
 * 2026-09-03) — well under the publish cap, so unlike pot/harness it is safe to
 * both enforce AND publish as a `tools/list` enum.
 */
async function loadWorkspaces(): Promise<string[]> {
  const s = await sql();
  const rows = await s<{ workspace_id: string }[]>`
    SELECT DISTINCT workspace_id FROM harness_shared.harness_registry WHERE workspace_id IS NOT NULL
  `;
  return rows.map((r) => r.workspace_id);
}

/**
 * Agent roles. Unlike pots/harnesses this is a CODE-DEFINED vocabulary, not a
 * table — so it is small, static (it changes only when the binary does), and
 * therefore the one kind here worth publishing into `tools/list`.
 *
 * It is nonetheless an OPEN set: plugins contribute `<plugin>:<role>` ids at
 * runtime that no startup enumeration can see. So the resolver accepts a
 * namespaced id, and the published fragment pairs the built-in enum with a
 * pattern for the tail (see `openPattern`) — advertising a closed list here
 * would be a lie that rejects legitimate plugin roles.
 */
const NAMESPACED_ROLE = /^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/;

async function loadRoles(): Promise<string[]> {
  const { AGENT_ROLES } = await import('./role-config');
  return [...AGENT_ROLES];
}

function makeRoleResolver(): EntityResolver {
  const inner = makeSetResolver('role', loadRoles);
  return async (values) => {
    // Namespaced plugin roles are valid-but-unenumerable: filter them out
    // before the set check so they are never reported unknown.
    const checkable = values.filter((v) => !NAMESPACED_ROLE.test(v));
    if (!checkable.length) return { unknown: [] };
    return inner(checkable);
  };
}

/**
 * Register Papercusp's resolvers (dispatch-time enforcement) and publishable
 * vocabularies (`tools/list` enums). Idempotent; safe to call more than once.
 *
 * ⚠ THE TWO ARE INTENTIONALLY NOT THE SAME SET. Enforcement is cheap — a cached
 * membership test — so every kind gets a resolver. PUBLISHING is a prompt-prefix
 * cost paid by every session, so it is capped: measured 2026-07-19, pots=142 and
 * harness slugs=428 are far past any sane cap and publish NOTHING (the
 * dispatch-time "unknown pot X — did you mean Y" stays their whole UX). Roles
 * (54, static) are under the cap and do publish. If you are tempted to raise a
 * cap so a big set publishes, price it first: an enum is re-serialized into
 * every arg site of every tool naming the kind, in every session.
 */
export function registerPapercuspEntityResolvers(
  options: PapercuspEntityRegistrationOptions = {},
): void {
  const mode = options.mode ?? defaultEntityRegistrationMode();
  const entityEnum = mode === 'unit' ? EMPTY_ENTITY_ENUM : undefined;

  setEntityResolver('pot', makeSetResolver('pot', loadPots));
  setEntityResolver('harness', makeSetResolver('harness', loadHarnessSlugs));
  setEntityResolver('role', makeRoleResolver());
  // The 8 `entityRef('workspace')` sites converted alongside P-001/P-002 had no
  // resolver until now — see the loadWorkspaces() doc comment above.
  setEntityResolver('workspace', makeSetResolver('workspace', loadWorkspaces));

  // Registered even though they are over-cap today: the cap is enforced inside
  // the overlay, so these publish nothing now and start publishing on their own
  // once the P-006/P-007 backfill collapses harness_slug onto the pot registry.
  setEntityEnum('pot', entityEnum ?? loadPots);
  setEntityEnum('harness', entityEnum ?? loadHarnessSlugs);
  setEntityEnum('role', loadRoles, {
    maxValues: 80,
    openPattern: NAMESPACED_ROLE.source,
  });
  // Workspaces (~9, 2026-09-03) are genuinely small — safe to publish, unlike
  // pot/harness/fleet.
  setEntityEnum('workspace', entityEnum ?? loadWorkspaces);
}

registerPapercuspEntityResolvers();
