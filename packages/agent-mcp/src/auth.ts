/**
 * Bearer-token resolution → Principal.
 *
 * The bearer is looked up in `harness_shared.token_index`; the row's
 * (kind, slug, workspace_id) determines the principal. Capabilities are
 * loaded from the principal's table:
 *   - kind='harness' → harness's role config (out of scope for MCP v1;
 *     this server doesn't admit harness bearers as direct callers).
 *   - kind='system'  → harness_shared.system_principals.capabilities
 *   - kind='pi'      → harness_shared.pi_sessions.capabilities plus an
 *     optional exact tool-name scope (only if not ended and expires_at is future).
 *
 * In-memory cap state is keyed by (workspace_id, principal_slug) in a
 * bounded TTL+LRU cache (negative results included). Principal writes
 * (provisioning.ts) emit a NOTIFY on PRINCIPAL_INVALIDATE_CHANNEL that
 * this module LISTENs to in order to invalidate eagerly; the TTL bounds
 * staleness if the LISTEN is unavailable.
 */

import { createHash } from 'node:crypto';
import { getOrgPg, getOrgPgListener, withWorkspace, withDbCallDeadline } from '@papercusp/db-org';
import type { Principal } from '@papercusp/tooldef';
import { BRAIN_PRINCIPAL_ROLE } from './role-config';

/**
 * The RBAC `roles` a resolved principal carries (the fail-closed `requireRoles`
 * dispatch axis). Derived from the principal's verified identity — NEVER
 * caller-asserted. Today only the operator's own system principal is "the brain"
 * (unify-agent-spawn-chokepoint P-006); a spawned worker/scoper/etc. carries none,
 * so a `requireRoles:[BRAIN_PRINCIPAL_ROLE]` tool admits only the brain (+ superuser).
 */
function rolesForPrincipal(kind: 'system' | 'pi', slug: string): ReadonlySet<string> | undefined {
  if (kind === 'system' && (slug === 'system:operator' || slug === 'operator')) {
    return new Set([BRAIN_PRINCIPAL_ROLE]);
  }
  return undefined;
}

/**
 * NOTIFY channel for principal capability changes. Emitters live in
 * provisioning.ts (the single capability write site) — `pg_notify` inside the
 * write tx, so the signal is delivered on commit and dropped on rollback.
 * Payload: JSON `{ workspace_id, slug }` (slug as stored in token_index,
 * e.g. "system:operator" / "pi:<session_id>").
 */
export const PRINCIPAL_INVALIDATE_CHANNEL = 'agent_mcp_principal_invalidate';

/** Positive entries: revocation lag is bounded by this even if LISTEN is down. */
const CACHE_TTL_MS = 60_000;
/** Negative entries (ended session / missing row / hash mismatch): short, so a
 *  just-provisioned principal racing a probe isn't blocked for long. */
const NEGATIVE_TTL_MS = 15_000;
/** LRU bound — pi sessions accumulate one entry each (EI-79 contributor). */
const CACHE_MAX = 512;

type LruEntry<V> = { value: V; expiresAt: number };

/**
 * Shared TTL+LRU read: an expired entry is deleted + reported as a miss;
 * otherwise its recency is refreshed (Map iterates in insertion order, so
 * re-inserting moves the entry to the tail and eviction always takes the head).
 * The wrapper (not the bare value) lets a cached `null` negative result be
 * distinguished from a miss.
 */
function lruGet<V>(map: Map<string, LruEntry<V>>, key: string): LruEntry<V> | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    map.delete(key);
    return undefined;
  }
  map.delete(key);
  map.set(key, entry);
  return entry;
}

/**
 * Shared TTL+LRU write: evict the insertion-order head at the cap. A falsy value
 * (a negative result — revoked / missing / out-of-scope) takes the shorter
 * negative TTL so a just-provisioned principal racing a probe isn't masked long.
 */
function lruSet<V>(map: Map<string, LruEntry<V>>, key: string, value: V, maxAgeMs?: number): void {
  if (!map.has(key) && map.size >= CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.delete(key);
  const defaultTtl = value ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  const ttl = maxAgeMs === undefined ? defaultTtl : Math.min(defaultTtl, Math.max(1, maxAgeMs));
  map.set(key, { value, expiresAt: Date.now() + ttl });
}

/** (workspace_id, principal_slug) → resolved Principal capabilities. */
const CACHE = new Map<string, LruEntry<Principal | null>>();

/**
 * bearer-hash → token_index identity (kind/slug/workspace). The token→identity
 * mapping is immutable for a live token (tokens are minted once; revocation is a
 * row delete), so caching it lifts the per-call admin SELECT off the hot path
 * (operator-scalability-event-loop-2026-06-16 P1-3) without weakening
 * revocation: authorization still flows through the capability load below, which
 * is itself TTL- + NOTIFY-bounded. Keyed by the bearer's sha256, never the raw
 * secret. A miss / out-of-scope kind is cached negatively (shorter TTL) so a
 * bad bearer hammering the server doesn't re-run the SELECT every call.
 */
type TokenIdentity = { kind: 'system' | 'pi'; slug: string; workspaceId: string };
const TOKEN_INDEX_CACHE = new Map<string, LruEntry<TokenIdentity | null>>();

function cacheKey(workspaceId: string, slug: string): string {
  return `${workspaceId}:${slug}`;
}

let listenerStarted = false;
let listenerWarned = false;

/**
 * Start the LISTEN that makes `invalidate()` fire on capability writes.
 * Lazy (first resolveBearer) + idempotent; fails open — without it the TTL
 * still bounds revocation lag at CACHE_TTL_MS instead of "until restart".
 */
function ensureInvalidationListener(): void {
  if (listenerStarted) return;
  listenerStarted = true;
  // LISTEN is session-bound and must stay off getOrgPg(), whose query pool is
  // intentionally routed through PgBouncer transaction mode on server hosts.
  // PgBouncer can discard NotificationResponse packets from an unlinked server
  // connection; the dedicated db-org listener client remains direct and idle-safe.
  const { sql } = getOrgPgListener();
  // Unit tests (and any non-postgres-js stand-in) mock sql as a bare tagged
  // template without .listen — skip silently there.
  const listen = (sql as unknown as { listen?: unknown }).listen;
  if (typeof listen !== 'function') return;
  void sql
    .listen(PRINCIPAL_INVALIDATE_CHANNEL, (payload: string) => {
      try {
        const parsed = JSON.parse(payload) as { workspace_id?: unknown; slug?: unknown };
        if (typeof parsed.workspace_id === 'string' && typeof parsed.slug === 'string') {
          invalidate(parsed.workspace_id, parsed.slug);
          return;
        }
      } catch {
        // fall through to the safe fallback
      }
      CACHE.clear();
      TOKEN_INDEX_CACHE.clear();
    })
    .catch((err: unknown) => {
      listenerStarted = false; // retry on a later resolve
      if (!listenerWarned) {
        listenerWarned = true;
        console.warn(
          '[agent-mcp auth] principal-invalidate LISTEN failed (TTL still bounds staleness):',
          err,
        );
      }
    });
}

function bearerHash(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex');
}

/**
 * Resolve a bearer to its token_index identity, served from TOKEN_INDEX_CACHE
 * (keyed by bearer hash). A missing row OR an out-of-scope kind (harness bearers
 * aren't admitted as direct MCP callers in v1) is cached as a negative result.
 */
async function resolveTokenIdentity(
  bearer: string,
  bearerHashHex: string,
): Promise<TokenIdentity | null> {
  const hit = lruGet(TOKEN_INDEX_CACHE, bearerHashHex);
  if (hit) return hit.value;

  // token_index lookup is admin-context — needs to read across workspaces
  // to find which workspace this bearer belongs to. RLS bypass is handled
  // at the role level: harness_admin has BYPASSRLS (per
  // sql/010-workspace-scoping-rls.sql's documented intent and the
  // matching `ALTER ROLE harness_admin BYPASSRLS` granted at provisioning
  // time). Without that grant the policy `workspace_id =
  // current_setting('app.workspace_id', true)` would filter out every
  // row because the GUC is unset outside withWorkspace.
  const { sql } = getOrgPg();
  // token_index column is named `harness_slug` per the original 008 migration.
  // It holds slugs for harnesses; for system: and pi: principals (added in
  // 009) the same column stores the prefixed slug (e.g. "system:operator").
  //
  // WI-7097: this is the FIRST admin-pool query on essentially every
  // uncached MCP tool dispatch (bearer resolution runs before any tool
  // handler executes). If the admin pool has never yet connected — a
  // not-yet-up embedded PG, a genuinely dead endpoint — postgres.js silently
  // retries the INITIAL connect forever without ever rejecting this query
  // (see withDbCallDeadline's doc comment), so wrap it: a stuck resolve now
  // fails fast with a clear cause instead of hanging every dispatched tool
  // call until the transport's own generic ~300s idle-timeout.
  const rows = await withDbCallDeadline(
    sql<
      Array<{ token: string; kind: string; harness_slug: string; workspace_id: string }>
    >`
    SELECT token, kind, harness_slug, workspace_id
      FROM harness_shared.token_index
     WHERE token = ${bearer}
     LIMIT 1
  `,
    { label: 'resolveTokenIdentity: token_index lookup (admin pool)' },
  );
  const row = rows[0];
  if (!row || (row.kind !== 'system' && row.kind !== 'pi')) {
    // Missing row, or a harness bearer (out of scope for v1) — cache negatively.
    lruSet(TOKEN_INDEX_CACHE, bearerHashHex, null);
    return null;
  }
  const identity: TokenIdentity = {
    kind: row.kind,
    slug: row.harness_slug,
    workspaceId: row.workspace_id,
  };
  lruSet(TOKEN_INDEX_CACHE, bearerHashHex, identity);
  return identity;
}

export async function resolveBearer(bearer: string): Promise<Principal | null> {
  if (!bearer) return null;

  // bearer → token_index identity, served from a per-bearer-hash cache (the
  // identity is immutable for a live token — see TOKEN_INDEX_CACHE). The hash is
  // also the capability-load credential, so compute it once here.
  const bh = bearerHash(bearer);
  const identity = await resolveTokenIdentity(bearer, bh);
  if (!identity) return null;
  const { kind, slug, workspaceId } = identity;

  ensureInvalidationListener();

  // Cache check — negative entries (ended sessions etc.) are cached too, so a
  // dead bearer hammering the server doesn't re-load capabilities every call.
  const ck = cacheKey(workspaceId, slug);
  const cached = lruGet(CACHE, ck);
  if (cached) return cached.value;

  const authz = await loadPrincipalAuthorization(workspaceId, kind, slug, bh);
  if (!authz) {
    lruSet(CACHE, ck, null);
    return null;
  }

  // Bearer-token-resolved principals are 'trusted' — the bearer hash was
  // verified against the row in PG. authMethod stays 'bearer-token'
  // for both 'system' (operator self / superuser shell) and 'pi' kinds.
  const roles = rolesForPrincipal(kind, slug);
  const principal: Principal = {
    kind,
    slug,
    workspaceId,
    capabilities: authz.capabilities,
    authMethod: 'bearer-token',
    trust: 'trusted',
    ...(authz.allowedTools === undefined ? {} : { allowedTools: authz.allowedTools }),
    ...(roles ? { roles } : {}),
  };
  const expiresInMs = authz.expiresAtMs === undefined ? undefined : authz.expiresAtMs - Date.now();
  if (expiresInMs !== undefined && expiresInMs <= 0) {
    lruSet(CACHE, ck, null);
    return null;
  }
  lruSet(CACHE, ck, principal, expiresInMs);
  return principal;
}

interface PrincipalAuthorization {
  capabilities: ReadonlySet<string>;
  allowedTools?: ReadonlySet<string>;
  /** PI session expiry as epoch milliseconds; system principals do not expire here. */
  expiresAtMs?: number;
}

async function loadPrincipalAuthorization(
  workspaceId: string,
  kind: 'system' | 'pi',
  slug: string,
  expectedHash: string,
): Promise<PrincipalAuthorization | null> {
  return withWorkspace(workspaceId, async (tx) => {
    if (kind === 'system') {
      const name = slug.startsWith('system:') ? slug.slice('system:'.length) : slug;
      const rows = await tx<Array<{ bearer_hash: string; capabilities: unknown }>>`
        SELECT bearer_hash, capabilities
          FROM harness_shared.system_principals
         WHERE workspace_id = ${workspaceId} AND name = ${name}
         LIMIT 1
      `;
      if (!rows.length) return null;
      if (rows[0].bearer_hash !== expectedHash) return null;
      return { capabilities: setOf(rows[0].capabilities) };
    }
    // pi
    const sessionId = slug.startsWith('pi:') ? slug.slice('pi:'.length) : slug;
    const rows = await tx<Array<{
      bearer_hash: string;
      capabilities: unknown;
      allowed_tools: unknown;
      ended_at: Date | null;
      expires_at: Date | string;
    }>>`
      SELECT bearer_hash, capabilities, allowed_tools, ended_at, expires_at
        FROM harness_shared.pi_sessions
       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
         AND expires_at > now()
       LIMIT 1
    `;
    if (!rows.length) return null;
    if (rows[0].ended_at) return null;
    if (rows[0].bearer_hash !== expectedHash) return null;
    const expiresAtMs = new Date(rows[0].expires_at).getTime();
    if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) return null;
    return {
      capabilities: setOf(rows[0].capabilities),
      ...(rows[0].allowed_tools === null || rows[0].allowed_tools === undefined
        ? {}
        : { allowedTools: setOf(rows[0].allowed_tools) }),
      expiresAtMs,
    };
  });
}

function setOf(raw: unknown): ReadonlySet<string> {
  if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === 'string'));
  return new Set();
}

/**
 * EI-... (WI-6154): look up a `kind='system'` principal's capabilities BY ROLE
 * NAME, with NO bearer-hash check — this is for INTROSPECTION/SIMULATION only
 * (e.g. `agent_tools:list { asRole }` answering "what would this role see?"),
 * never for real auth. `resolveBearer`/`loadCapabilities` above require a
 * verified bearer hash and MUST stay the only path a real dispatch trusts.
 *
 * Returns `null` when no system_principals row exists for that role name
 * (the role has no restricted principal — a caller simulating it should NOT
 * synthesize a capability gate that wouldn't exist in reality) — distinct
 * from an EMPTY set (a row exists but grants zero capabilities, e.g. the
 * intentionally-capability-less `worker` row). Callers must not conflate the
 * two: `null` ⇒ skip the capability gate (matches "no principal" dispatch
 * behavior); an empty set ⇒ enforce the gate with zero grants (matches a real
 * worker's dispatch-time denial).
 */
export async function lookupSystemPrincipalCapabilitiesByRole(
  workspaceId: string,
  role: string,
): Promise<ReadonlySet<string> | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<Array<{ capabilities: unknown }>>`
      SELECT capabilities
        FROM harness_shared.system_principals
       WHERE workspace_id = ${workspaceId} AND name = ${role}
       LIMIT 1
    `;
    if (!rows.length) return null;
    return setOf(rows[0].capabilities);
  });
}

/** Invalidate cache entry. Called by the LISTEN handler when capabilities change. */
export function invalidate(workspaceId: string, slug: string): void {
  CACHE.delete(cacheKey(workspaceId, slug));
}

/** Test-only. */
export function _resetAuthCacheForTests(): void {
  CACHE.clear();
  TOKEN_INDEX_CACHE.clear();
  listenerStarted = false;
  listenerWarned = false;
}

/** Test-only — TTL/bound constants for the cache tests. */
export const _authCacheTuning = {
  ttlMs: CACHE_TTL_MS,
  negativeTtlMs: NEGATIVE_TTL_MS,
  max: CACHE_MAX,
} as const;
