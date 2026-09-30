/**
 * Persistence for app keys and service keys in harness_shared.connected_apps
 * (external-app-access-to-workspaces-2026-09-29 P-002, P-015; migrations 1244, 1252).
 *
 * connected_apps holds everything outside a workspace that may act in it:
 * paired phones (kind='mobile', see ../device-store.ts), app keys (kind='app')
 * and service keys for unattended apps (kind='service', see ./service-keys.ts).
 * Every function here filters to the bearer-carrying kinds ('app', 'service'),
 * so a key can never be presented as a phone and a phone id can never verify
 * as a key.
 *
 * Two connection modes, same split as device-store:
 *   - Management (create / list / pause / resume / revoke / rotate) runs inside
 *     `withWorkspace()`, so the workspace RLS policy bounds what a caller can
 *     touch.
 *   - Verification (`verifyAppKey`) runs on the admin connection with no
 *     workspace GUC: the auth chain has to resolve the key BEFORE it knows the
 *     workspace. It reads one row by primary key and returns only what the
 *     caller needs to build a principal.
 *
 * The secret is never stored. `createAppKey` and `rotateAppKey` return the full
 * key exactly once; the row keeps sha256(key) in token_hash (see ./key.ts), and
 * after a rotation the previous digest in previous_token_hash until the overlap
 * window ends.
 */

import type { Sql } from 'postgres';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { networkOf, type AppKeyUseOutcome } from './network';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { appKeyHashMatches, mintAppKey, parseAccessToken, parseAppKey } from './key';
import {
  appScopeToolOf,
  validateAppKeyScopes,
  type AppKeyScopeProblem,
  type AppScopeRow,
  type AppScopeTool,
} from './scope-policy';
import {
  previousKeyStillValid,
  resolveSpendCap,
  rotationOverlapSec,
  type AppKeyKind,
} from './service-keys';

export type { AppKeyKind } from './service-keys';

export interface AppKeyScopes {
  /** Capability strings the key is granted (the dispatch capability-check enforces them). */
  capabilities?: string[];
  /**
   * The tools the key may call: exact `group:verb` names or `group:*`. Absent or empty means
   * NONE — an app key is default-deny (P-003, see ./scope-policy.ts).
   */
  tools?: string[];
  /** When present and non-empty, the only harnesses a call may name. Absent = any harness. */
  harnesses?: string[];
}

export interface AppKeyLimits {
  [limit: string]: unknown;
}

/** A key as the rest of the system sees it — never carries token_hash or previous_token_hash. */
export interface AppKeyRow {
  id: string;
  /**
   * Who created the key. Display and audit data only: a service key belongs to the workspace and
   * keeps working after its creator leaves the organization (D-007), so nothing authorizes on it.
   */
  user_email: string;
  workspace_id: string;
  kind: AppKeyKind;
  label: string | null;
  scopes: AppKeyScopes;
  limits: AppKeyLimits;
  paired_at: Date;
  expires_at: Date | null;
  paused_at: Date | null;
  revoked_at: Date | null;
  last_seen: Date | null;
  last_ip: string | null;
  /** LLM spending ceiling in US cents (required for kind='service', R-13). Null = no per-key cap. */
  spend_cap_cents: number | null;
  /** Trailing window for the cap, in seconds. Null = the key's whole lifetime. */
  spend_cap_window_sec: number | null;
  /** When the key was last rotated. Null = never. */
  rotated_at: Date | null;
  /** While set and in the future, the key's previous secret still authenticates (R-11). */
  previous_token_valid_until: Date | null;
  /**
   * Set when the service key is an OAuth client-credentials client (P-016, migration 1261): how it
   * authenticates at the token endpoint. Such a key is refused as a bearer ('token_endpoint_only');
   * the app exchanges it for short-lived access tokens instead. Null = an ordinary bearer key.
   */
  client_auth: ClientAuthMethod | null;
}

export type ClientAuthMethod = 'client_secret' | 'private_key_jwt';

export type AppKeyRefusal =
  | 'malformed'
  | 'unknown'
  | 'mismatch'
  | 'rotated'
  | 'revoked'
  | 'paused'
  | 'expired'
  /** A client-credentials secret presented as a bearer: it is only valid at the token endpoint. */
  | 'token_endpoint_only'
  /**
   * The key's workspace has Remote access switched off (P-010, D-025): the instant kill switch.
   * Every app key, service key and access token of that workspace is refused until it is back on.
   */
  | 'remote_access_off';

/**
 * The workspace's Remote access switch, read in the same query as the key (D-025). Required on
 * every row a verdict is computed from, so a loader that forgets to read it does not compile — and
 * a row where it is not literally `true` is refused, so a missing value fails closed.
 */
export interface RemoteAccessState {
  remote_access_enabled: boolean;
}

/** The access token a bearer presented (P-016). Its principal is still the parent key. */
export interface AccessTokenGrant {
  id: string;
  scopes: AppKeyScopes;
  expires_at: Date;
}

export type AppKeyVerdict =
  | {
      ok: true;
      app: AppKeyRow;
      /** True when the key presented is the previous secret, inside its rotation overlap window. */
      viaPreviousKey: boolean;
      /** Present when the bearer was a client-credentials access token rather than the key itself. */
      accessToken?: AccessTokenGrant;
    }
  | { ok: false; reason: AppKeyRefusal };

export interface CreateAppKeyOptions {
  workspaceId: string;
  userEmail: string;
  label: string;
  /** 'app' (default) or 'service' (an unattended app's key, P-015 — a spending cap is required). */
  kind?: AppKeyKind;
  capabilities?: readonly string[];
  /** Exact `group:verb` names or `group:*`. Omitted = the key can call nothing (default-deny). */
  tools?: readonly string[];
  /** The only harnesses a call may name. Omitted = any harness in the workspace. */
  harnesses?: readonly string[];
  expiresAt?: Date | null;
  limits?: AppKeyLimits;
  /** LLM spending ceiling in US cents. Required when kind='service' (see ./service-keys.ts). */
  spendCapCents?: number | null;
  /** Trailing window for the cap in seconds. Omitted = 30 days; null = the key's whole lifetime. */
  spendCapWindowSec?: number | null;
  /**
   * The tool catalog used to check exact `tools` entries against the capabilities each tool
   * declares. Defaults to the live projected catalog; tests pass their own.
   */
  knownTools?: ReadonlyMap<string, AppScopeTool>;
}

/** Thrown by `createAppKey` when the requested scopes include something no key may hold. */
export class AppKeyScopeError extends Error {
  constructor(readonly problems: readonly AppKeyScopeProblem[]) {
    super(
      `app key scopes refused: ${problems.map((p) => `${p.field} "${p.value}" — ${p.reason}`).join('; ')}`,
    );
    this.name = 'AppKeyScopeError';
  }
}

/** The live projected catalog, keyed by MCP name, in the shape the scope policy reads. */
export function projectedToolScopeCatalog(): ReadonlyMap<string, AppScopeTool> {
  const out = new Map<string, AppScopeTool>();
  for (const tool of listAllProjectedTools()) {
    const name = tool.expose.mcp?.name;
    if (!name) continue;
    out.set(name, appScopeToolOf(name, tool));
  }
  return out;
}

export interface CreatedAppKey {
  app: AppKeyRow;
  /** The full key. Show it to the user once; it cannot be recovered later. */
  key: string;
}

/** Every bearer-carrying kind, as SQL. Phones (kind='mobile') are never matched. */
const KEY_KINDS_SQL = `kind IN ('app', 'service')`;

// spend_cap_cents is bigint (the same shape as goals.budget_cents); postgres.js would return it as
// a string, so it is read back as float8, which is exact for every accepted cap.
const APP_COLUMNS = `id, user_email, workspace_id, kind, label, scopes, limits,
  paired_at, expires_at, paused_at, revoked_at, last_seen, last_ip,
  spend_cap_cents::float8 AS spend_cap_cents, spend_cap_window_sec,
  rotated_at, previous_token_valid_until, client_auth`;

/**
 * The Remote access switch of the key's workspace (migration 1263, D-025), as a column of a query
 * over `harness_shared.connected_apps` (unaliased). No settings row = on.
 */
const REMOTE_ACCESS_COLUMN = `COALESCE((SELECT s.enabled FROM harness_shared.connected_app_access_settings s
   WHERE s.workspace_id = harness_shared.connected_apps.workspace_id), true) AS remote_access_enabled`;

/** The scope fields a caller may ask for, before normalization. */
export type AppKeyScopeRequest = Pick<CreateAppKeyOptions, 'capabilities' | 'tools' | 'harnesses' | 'knownTools'>;

/**
 * Normalize requested scopes (dedupe, trim) and check them against the scope policy. Throws
 * `AppKeyScopeError` when any entry is something no key may hold (a hard-denied tool, an unknown
 * exact tool, a malformed entry). Every path that creates a key goes through this — the
 * "Connect an app" route, the device-code sign-in (P-005) and the access tools (P-012) — so no
 * issuance path can grant what another would refuse.
 */
export function resolveAppKeyScopes(req: AppKeyScopeRequest): AppKeyScopes {
  const scopes: AppKeyScopes = { capabilities: [...new Set(req.capabilities ?? [])] };
  if (req.tools?.length) scopes.tools = [...new Set(req.tools.map((t) => t.trim()))];
  if (req.harnesses?.length) scopes.harnesses = [...new Set(req.harnesses.map((h) => h.trim()))];
  // The catalog only matters when exact tools are named; capability rules need no catalog.
  const catalog = req.knownTools ?? (scopes.tools?.length ? projectedToolScopeCatalog() : undefined);
  const problems = validateAppKeyScopes(scopes, catalog);
  if (problems.length > 0) throw new AppKeyScopeError(problems);
  return scopes;
}

/** What `insertAppKey` needs once the scopes (and cap) are already resolved. */
export interface InsertAppKeyInput {
  workspaceId: string;
  userEmail: string;
  label: string;
  scopes: AppKeyScopes;
  /** Defaults to 'app'. A 'service' row must carry spendCapCents (migration 1252 CHECK). */
  kind?: AppKeyKind;
  limits?: AppKeyLimits;
  expiresAt?: Date | null;
  spendCapCents?: number | null;
  spendCapWindowSec?: number | null;
}

/**
 * Mint a key and insert its row inside an EXISTING workspace transaction (the caller's
 * `withWorkspace` callback). Lets a caller make the key part of a larger atomic step — the
 * device-code exchange consumes its grant and creates the key in one transaction, so two
 * concurrent polls can never both receive a key. `scopes` must come from `resolveAppKeyScopes`
 * and the cap from `resolveSpendCap`.
 */
export async function insertAppKey(tx: Sql, input: InsertAppKeyInput): Promise<CreatedAppKey> {
  const minted = mintAppKey();
  const kind: AppKeyKind = input.kind ?? 'app';
  const rows = await tx<AppKeyRow[]>`
    INSERT INTO harness_shared.connected_apps
      (id, user_email, workspace_id, kind, label, scopes, limits, token_hash, expires_at, paired_at,
       spend_cap_cents, spend_cap_window_sec)
    VALUES (${minted.id}, ${input.userEmail}, ${input.workspaceId}, ${kind}, ${input.label},
            ${JSON.stringify(input.scopes)}::jsonb, ${JSON.stringify(input.limits ?? {})}::jsonb,
            ${minted.tokenHash}, ${input.expiresAt ?? null}, now(),
            ${input.spendCapCents ?? null}, ${input.spendCapWindowSec ?? null})
    RETURNING ${tx.unsafe(APP_COLUMNS)}
  `;
  const app = rows[0];
  if (!app) throw new Error('insertAppKey: insert returned no row');
  return { app, key: minted.key };
}

/**
 * Create an app key (kind 'app', the default) or a service key (kind 'service'). Throws
 * `AppKeyScopeError` for scopes no key may hold and `SpendCapError` (./service-keys.ts) for a
 * missing or malformed spending cap — a service key without a cap is refused here (R-13).
 */
export async function createAppKey(opts: CreateAppKeyOptions): Promise<CreatedAppKey> {
  const kind: AppKeyKind = opts.kind ?? 'app';
  const cap = resolveSpendCap(kind, opts);
  const scopes = resolveAppKeyScopes(opts);
  return withWorkspace(opts.workspaceId, (tx) =>
    insertAppKey(tx, {
      workspaceId: opts.workspaceId,
      userEmail: opts.userEmail,
      label: opts.label,
      kind,
      scopes,
      limits: opts.limits,
      expiresAt: opts.expiresAt,
      ...cap,
    }),
  );
}

/** Create a service key for an unattended app (P-015). The spending cap is required. */
export async function createServiceKey(
  opts: Omit<CreateAppKeyOptions, 'kind' | 'spendCapCents'> & { spendCapCents: number },
): Promise<CreatedAppKey> {
  return createAppKey({ ...opts, kind: 'service' });
}

/** Every app and service key in a workspace, newest first — revoked ones included, flagged by revoked_at. */
export async function listAppKeys(workspaceId: string): Promise<AppKeyRow[]> {
  return withWorkspace(workspaceId, async (tx) => tx<AppKeyRow[]>`
    SELECT ${tx.unsafe(APP_COLUMNS)}
      FROM harness_shared.connected_apps
     WHERE ${tx.unsafe(KEY_KINDS_SQL)}
     ORDER BY paired_at DESC
  `);
}

/** Pause (true) or resume (false) a key. Returns false when no live key has that id. */
export async function setAppKeyPaused(workspaceId: string, id: string, paused: boolean): Promise<boolean> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<{ id: string }[]>`
    UPDATE harness_shared.connected_apps
       SET paused_at = CASE WHEN ${paused}::boolean THEN now() ELSE NULL END
     WHERE id = ${id} AND ${tx.unsafe(KEY_KINDS_SQL)} AND revoked_at IS NULL
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * Revoke a key permanently. Returns false when no live key has that id. Revocation also ends any
 * rotation overlap: a revoked row refuses every secret it ever had.
 */
export async function revokeAppKey(workspaceId: string, id: string): Promise<boolean> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<{ id: string }[]>`
    UPDATE harness_shared.connected_apps
       SET revoked_at = now()
     WHERE id = ${id} AND ${tx.unsafe(KEY_KINDS_SQL)} AND revoked_at IS NULL
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * Replace a live key's scopes (the Remote access screen's "edit scope", P-010). `scopes` must come
 * from `resolveAppKeyScopes`, so an edit can never grant what creation would refuse. Takes effect
 * on the key's next call: the dispatch seat reads the row per call (`loadAppScopeRow`), and access
 * tokens are evaluated against their parent's scopes too. Returns null when no live key has that id.
 */
export async function setAppKeyScopes(workspaceId: string, id: string, scopes: AppKeyScopes): Promise<AppKeyRow | null> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<AppKeyRow[]>`
    UPDATE harness_shared.connected_apps
       SET scopes = ${JSON.stringify(scopes)}::jsonb
     WHERE id = ${id} AND ${tx.unsafe(KEY_KINDS_SQL)} AND revoked_at IS NULL
    RETURNING ${tx.unsafe(APP_COLUMNS)}
  `);
  return rows[0] ?? null;
}

export interface RotatedAppKey extends CreatedAppKey {
  /** The instant the previous key stops authenticating (== rotation time for a zero overlap). */
  previousKeyValidUntil: Date;
}

/**
 * Rotate a key (P-015, R-11/R-12): mint a NEW secret for the same id — so scopes, spending cap and
 * audit identity carry over — and keep the old secret valid for `overlapSec` (default one day,
 * 0 = immediate cutover). Returns the new key once, or null when no live key has that id.
 *
 * One UPDATE, so it is atomic: every right-hand side reads the row as it was BEFORE the update, so
 * `previous_token_hash = token_hash` captures the secret being replaced. Only one previous secret
 * is kept; rotating again inside the window retires the oldest secret immediately.
 */
export async function rotateAppKey(
  workspaceId: string,
  id: string,
  opts: { overlapSec?: number | null; now?: Date } = {},
): Promise<RotatedAppKey | null> {
  const overlap = rotationOverlapSec(opts.overlapSec);
  const now = opts.now ?? new Date();
  const validUntil = new Date(now.getTime() + overlap * 1000);
  const minted = mintAppKey(id);
  const rows = await withWorkspace(workspaceId, async (tx) => tx<AppKeyRow[]>`
    UPDATE harness_shared.connected_apps
       SET previous_token_hash        = token_hash,
           previous_token_valid_until = ${validUntil},
           token_hash                 = ${minted.tokenHash},
           rotated_at                 = ${now}
     WHERE id = ${id} AND ${tx.unsafe(KEY_KINDS_SQL)} AND revoked_at IS NULL
    RETURNING ${tx.unsafe(APP_COLUMNS)}
  `);
  const app = rows[0];
  if (!app) return null;
  return { app, key: minted.key, previousKeyValidUntil: validUntil };
}

/** A stored key row as verification reads it: the public row, both digests and the workspace switch. */
export type StoredAppKeyRow = AppKeyRow &
  RemoteAccessState & {
    token_hash: string | null;
    previous_token_hash?: string | null;
  };

/**
 * The verdict for a presented key against its stored row — pure, so every rule is testable
 * without a database. Order of checks:
 *
 *   1. The secret must hash to the current digest, or to the previous digest while the rotation
 *      overlap window is open (R-11). A previous secret after its window is `rotated` (R-12); any
 *      other secret is `mismatch`. These come first, so only a holder of a real secret for this id
 *      ever learns the key's state.
 *   2. Revocation outranks pause outranks expiry in the reported reason.
 *   3. Then the workspace's Remote access switch (P-010, D-025): switched off, every key of the
 *      workspace is `remote_access_off`. It ranks below the key's own state, so a key revoked on
 *      the screen still reports `revoked` (R-40) whatever the switch says.
 *
 * Nothing here reads who created the key: a service key belongs to the workspace, so a change in
 * its creator's organization membership cannot refuse it (D-007, R-10).
 *
 *   4. A client-credentials key (client_auth set, P-016) is refused as a bearer
 *      (`token_endpoint_only`); only the token endpoint verifies it, with `at: 'token-endpoint'`.
 */
export function appKeyVerdictOf(
  row: StoredAppKeyRow | null | undefined,
  key: string,
  now: Date,
  opts: { at?: 'bearer' | 'token-endpoint' } = {},
): AppKeyVerdict {
  if (!parseAppKey(key)) return { ok: false, reason: 'malformed' };
  if (!row) return { ok: false, reason: 'unknown' };
  const {
    token_hash: tokenHash,
    previous_token_hash: previousHash,
    remote_access_enabled: remoteAccessEnabled,
    ...app
  } = row;
  let viaPreviousKey = false;
  if (!appKeyHashMatches(key, tokenHash)) {
    if (!appKeyHashMatches(key, previousHash)) return { ok: false, reason: 'mismatch' };
    if (!previousKeyStillValid(app.previous_token_valid_until, now)) return { ok: false, reason: 'rotated' };
    viaPreviousKey = true;
  }
  const state = parentStateRefusal(app, remoteAccessEnabled, now);
  if (state) return { ok: false, reason: state };
  if (app.client_auth && opts.at !== 'token-endpoint') return { ok: false, reason: 'token_endpoint_only' };
  return { ok: true, app, viaPreviousKey };
}

/**
 * Revocation outranks pause outranks expiry outranks the workspace switch, for a key and for every
 * token it issued. The switch refuses unless it is literally `true`, so a missing value fails closed.
 */
function parentStateRefusal(
  app: AppKeyRow,
  remoteAccessEnabled: boolean,
  now: Date,
): 'revoked' | 'paused' | 'expired' | 'remote_access_off' | null {
  if (app.revoked_at) return 'revoked';
  if (app.paused_at) return 'paused';
  if (app.expires_at && app.expires_at.getTime() <= now.getTime()) return 'expired';
  if (remoteAccessEnabled !== true) return 'remote_access_off';
  return null;
}

/** An access-token row as verification reads it. */
export interface StoredAccessTokenRow {
  id: string;
  token_hash: string;
  app_id: string;
  scopes: AppKeyScopes;
  expires_at: Date;
}

/**
 * The verdict for a presented access token (P-016) — pure. The token's own digest and expiry come
 * first; then the PARENT key's state, so revoking, pausing or expiring the client refuses every
 * token it issued on the next call. The parent must still be a client-credentials key: switching a
 * key out of that mode ends its tokens too. The verdict names the parent as the app.
 */
export function accessTokenVerdictOf(
  token: StoredAccessTokenRow | null | undefined,
  parentRow: (AppKeyRow & RemoteAccessState) | null | undefined,
  presented: string,
  now: Date,
): AppKeyVerdict {
  const parsed = parseAccessToken(presented);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (!token || token.id !== parsed.id) return { ok: false, reason: 'unknown' };
  if (!appKeyHashMatches(presented, token.token_hash)) return { ok: false, reason: 'mismatch' };
  if (token.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  if (!parentRow) return { ok: false, reason: 'revoked' };
  const { remote_access_enabled: remoteAccessEnabled, ...parent } = parentRow;
  if (parent.id !== token.app_id || parent.kind !== 'service' || !parent.client_auth) {
    return { ok: false, reason: 'revoked' };
  }
  const state = parentStateRefusal(parent, remoteAccessEnabled, now);
  if (state) return { ok: false, reason: state };
  return {
    ok: true,
    app: parent,
    viaPreviousKey: false,
    accessToken: { id: token.id, scopes: token.scopes, expires_at: token.expires_at },
  };
}

/**
 * Verify a presented bearer: an app or service key (`pcapp_`, by `appKeyVerdictOf`) or a
 * client-credentials access token (`pcat_`, by `accessTokenVerdictOf`). Refuses a malformed
 * bearer, an unknown id, a secret that does not hash to a live digest, a key or token that is
 * revoked, paused or past its expiry, and a client-credentials key presented as a bearer.
 */
export async function verifyAppKey(key: string, now: Date = new Date()): Promise<AppKeyVerdict> {
  const { sql } = getOrgPg();
  const token = parseAccessToken(key);
  if (token) {
    const tokens = await sql<StoredAccessTokenRow[]>`
      SELECT id, token_hash, app_id, scopes, expires_at
        FROM harness_shared.connected_app_access_tokens
       WHERE id = ${token.id}
       LIMIT 1
    `;
    const row = tokens[0];
    const parents = row
      ? await sql<(AppKeyRow & RemoteAccessState)[]>`
          SELECT ${sql.unsafe(APP_COLUMNS)}, ${sql.unsafe(REMOTE_ACCESS_COLUMN)}
            FROM harness_shared.connected_apps
           WHERE id = ${row.app_id} AND ${sql.unsafe(KEY_KINDS_SQL)} LIMIT 1`
      : [];
    return accessTokenVerdictOf(row, parents[0], key, now);
  }
  const parsed = parseAppKey(key);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const rows = await sql<StoredAppKeyRow[]>`
    SELECT ${sql.unsafe(APP_COLUMNS)}, token_hash, previous_token_hash, ${sql.unsafe(REMOTE_ACCESS_COLUMN)}
      FROM harness_shared.connected_apps
     WHERE id = ${parsed.id} AND ${sql.unsafe(KEY_KINDS_SQL)}
     LIMIT 1
  `;
  return appKeyVerdictOf(rows[0], key, now);
}

/**
 * The key row the token endpoint authenticates a client against (P-016): the stored row with both
 * digests and the registered public JWK. Admin connection, like `verifyAppKey`. Null when no key
 * has that id.
 */
export async function loadClientKeyRow(
  id: string,
): Promise<(StoredAppKeyRow & { client_jwk: Record<string, unknown> | null }) | null> {
  const { sql } = getOrgPg();
  const rows = await sql<(StoredAppKeyRow & { client_jwk: Record<string, unknown> | null })[]>`
    SELECT ${sql.unsafe(APP_COLUMNS)}, token_hash, previous_token_hash, client_jwk,
           ${sql.unsafe(REMOTE_ACCESS_COLUMN)}
      FROM harness_shared.connected_apps
     WHERE id = ${id} AND ${sql.unsafe(KEY_KINDS_SQL)}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * The scope row the dispatch seat evaluates for an ACCESS TOKEN (P-016): the parent's state and
 * workspace with the token's own (possibly narrowed) scopes and the earlier of the two expiries.
 * The seat evaluates this AND the parent row, so a scope removed from the parent after issue
 * applies to live tokens too. Null when the token is gone or no longer belongs to that key.
 */
export async function loadAccessTokenScopeRow(tokenId: string, appId: string): Promise<AppScopeRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<(AppScopeRow & { token_expires_at: Date })[]>`
    SELECT a.id, a.workspace_id, t.scopes, a.revoked_at, a.paused_at, a.expires_at, t.expires_at AS token_expires_at
      FROM harness_shared.connected_app_access_tokens t
      JOIN harness_shared.connected_apps a ON a.id = t.app_id
     WHERE t.id = ${tokenId} AND t.app_id = ${appId}
       AND a.kind = 'service' AND a.client_auth IS NOT NULL
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const { token_expires_at: tokenExpiresAt, ...scopeRow } = row;
  const parentExpiry = scopeRow.expires_at ? new Date(scopeRow.expires_at).getTime() : Infinity;
  return { ...scopeRow, expires_at: new Date(Math.min(parentExpiry, new Date(tokenExpiresAt).getTime())) };
}

/** Thrown by `setClientCredentialsMode` for a mode no row may hold. */
export class ClientCredentialsModeError extends Error {
  constructor(readonly code: 'not_service_key' | 'invalid_jwk') {
    super(code === 'not_service_key' ? 'only a service key can be a client-credentials client' : 'client_jwk must be a public JWK');
    this.name = 'ClientCredentialsModeError';
  }
}

/**
 * Switch a live service key into client-credentials mode (`client_secret` or `private_key_jwt` with
 * a public JWK), or back to an ordinary bearer key (`null`). Leaving the mode, or changing it, ends
 * every access token the key issued. Returns null when no live key has that id; throws
 * `ClientCredentialsModeError` for an app key or a JWK that is not a validated public key.
 */
export async function setClientCredentialsMode(
  workspaceId: string,
  id: string,
  mode: { auth: ClientAuthMethod; jwk?: Record<string, unknown> | null } | null,
): Promise<AppKeyRow | null> {
  const jwk = mode?.auth === 'private_key_jwt' ? mode.jwk ?? null : null;
  if (mode?.auth === 'private_key_jwt' && !jwk) throw new ClientCredentialsModeError('invalid_jwk');
  return withWorkspace(workspaceId, async (tx) => {
    const current = await tx<{ kind: AppKeyKind }[]>`
      SELECT kind FROM harness_shared.connected_apps
       WHERE id = ${id} AND ${tx.unsafe(KEY_KINDS_SQL)} AND revoked_at IS NULL`;
    if (!current[0]) return null;
    if (mode && current[0].kind !== 'service') throw new ClientCredentialsModeError('not_service_key');
    const rows = await tx<AppKeyRow[]>`
      UPDATE harness_shared.connected_apps
         SET client_auth = ${mode?.auth ?? null},
             client_jwk  = ${jwk ? JSON.stringify(jwk) : null}::jsonb
       WHERE id = ${id} AND ${tx.unsafe(KEY_KINDS_SQL)} AND revoked_at IS NULL
      RETURNING ${tx.unsafe(APP_COLUMNS)}`;
    await tx`DELETE FROM harness_shared.connected_app_access_tokens WHERE app_id = ${id}`;
    return rows[0] ?? null;
  });
}

/**
 * The fields the scope policy needs, read fresh for one call (P-003). Admin connection, like
 * `verifyAppKey`: the dispatch seat reads the row by primary key before it trusts any workspace.
 * Null when no key has that id. Reading per call (not caching the row on the principal) is
 * what makes pause, revoke and a scope change take effect on the very next call.
 */
export async function loadAppScopeRow(id: string): Promise<AppScopeRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<AppScopeRow[]>`
    SELECT id, workspace_id, scopes, revoked_at, paused_at, expires_at
      FROM harness_shared.connected_apps
     WHERE id = ${id} AND ${sql.unsafe(KEY_KINDS_SQL)}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/** The fields an alert about a key shows (P-011): its label, kind and workspace. */
export async function loadAlertedAppRow(id: string): Promise<{ id: string; workspace_id: string; kind: string; label: string | null } | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ id: string; workspace_id: string; kind: string; label: string | null }>>`
    SELECT id, workspace_id, kind, label FROM harness_shared.connected_apps
     WHERE id = ${id} AND ${sql.unsafe(KEY_KINDS_SQL)}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Record that a key was just used. At most one write a minute per key (or on an
 * address change), so a busy app does not turn every request into an UPDATE.
 * Best-effort: callers must not fail a request because this did.
 *
 * Reports what the use found (P-011, D-028): the key's FIRST use ever (`first_used_at` is set by
 * the one write that finds it null), and a network the key was never used from before (a new row
 * in `connected_app_networks`). The row lock on the key serializes concurrent first calls, so only
 * one of them reports `firstUse`. The address is caller-reported: alerts only, never authorization.
 */
export async function recordAppKeyUse(id: string, ip: string | null): Promise<AppKeyUseOutcome> {
  const { sql } = getOrgPg();
  const network = networkOf(ip);
  const rows = await sql<Array<{ first_use: boolean | null; new_network: string | null }>>`
    WITH used AS (
      UPDATE harness_shared.connected_apps
         SET last_seen = now(), last_ip = COALESCE(${ip}, last_ip),
             first_used_at = COALESCE(first_used_at, now())
       WHERE id = ${id} AND ${sql.unsafe(KEY_KINDS_SQL)}
         AND (last_seen IS NULL
              OR last_seen < now() - interval '60 seconds'
              OR (${ip}::text IS NOT NULL AND last_ip IS DISTINCT FROM ${ip}))
      RETURNING workspace_id, first_used_at = now() AS first_use
    ), seen AS (
      INSERT INTO harness_shared.connected_app_networks (app_id, workspace_id, network)
      SELECT ${id}, workspace_id, ${network}::text FROM used WHERE ${network}::text IS NOT NULL
      ON CONFLICT (app_id, network) DO NOTHING
      RETURNING network
    )
    SELECT (SELECT first_use FROM used) AS first_use, (SELECT network FROM seen) AS new_network
  `;
  return { firstUse: rows[0]?.first_use === true, newNetwork: rows[0]?.new_network ?? null };
}
