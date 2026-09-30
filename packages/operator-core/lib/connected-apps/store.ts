/**
 * Persistence for app keys in harness_shared.connected_apps
 * (external-app-access-to-workspaces-2026-09-29 P-002; migration 1244).
 *
 * connected_apps holds everything outside a workspace that may act in it:
 * paired phones (kind='mobile', see ../device-store.ts) and app keys
 * (kind='app', this module). Every function here filters kind='app', so an
 * app key can never be presented as a phone and a phone id can never verify
 * as an app key.
 *
 * Two connection modes, same split as device-store:
 *   - Management (create / list / pause / resume / revoke) runs inside
 *     `withWorkspace()`, so the workspace RLS policy bounds what a caller can
 *     touch.
 *   - Verification (`verifyAppKey`) runs on the admin connection with no
 *     workspace GUC: the auth chain has to resolve the key BEFORE it knows the
 *     workspace. It reads one row by primary key and returns only what the
 *     caller needs to build a principal.
 *
 * The secret is never stored. `createAppKey` returns the full key exactly once;
 * the row keeps sha256(key) in token_hash (see ./key.ts).
 */

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { appKeyHashMatches, mintAppKey, parseAppKey } from './key';
import {
  appScopeToolOf,
  validateAppKeyScopes,
  type AppKeyScopeProblem,
  type AppScopeRow,
  type AppScopeTool,
} from './scope-policy';

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

/** An app key as the rest of the system sees it — never carries token_hash. */
export interface AppKeyRow {
  id: string;
  user_email: string;
  workspace_id: string;
  kind: 'app';
  label: string | null;
  scopes: AppKeyScopes;
  limits: AppKeyLimits;
  paired_at: Date;
  expires_at: Date | null;
  paused_at: Date | null;
  revoked_at: Date | null;
  last_seen: Date | null;
  last_ip: string | null;
}

export type AppKeyRefusal = 'malformed' | 'unknown' | 'mismatch' | 'revoked' | 'paused' | 'expired';

export type AppKeyVerdict = { ok: true; app: AppKeyRow } | { ok: false; reason: AppKeyRefusal };

export interface CreateAppKeyOptions {
  workspaceId: string;
  userEmail: string;
  label: string;
  capabilities?: readonly string[];
  /** Exact `group:verb` names or `group:*`. Omitted = the key can call nothing (default-deny). */
  tools?: readonly string[];
  /** The only harnesses a call may name. Omitted = any harness in the workspace. */
  harnesses?: readonly string[];
  expiresAt?: Date | null;
  limits?: AppKeyLimits;
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

const APP_COLUMNS = `id, user_email, workspace_id, kind, label, scopes, limits,
  paired_at, expires_at, paused_at, revoked_at, last_seen, last_ip`;

export async function createAppKey(opts: CreateAppKeyOptions): Promise<CreatedAppKey> {
  const scopes: AppKeyScopes = { capabilities: [...new Set(opts.capabilities ?? [])] };
  if (opts.tools?.length) scopes.tools = [...new Set(opts.tools.map((t) => t.trim()))];
  if (opts.harnesses?.length) scopes.harnesses = [...new Set(opts.harnesses.map((h) => h.trim()))];
  // The catalog only matters when exact tools are named; capability rules need no catalog.
  const catalog = opts.knownTools ?? (scopes.tools?.length ? projectedToolScopeCatalog() : undefined);
  const problems = validateAppKeyScopes(scopes, catalog);
  if (problems.length > 0) throw new AppKeyScopeError(problems);
  const minted = mintAppKey();
  const rows = await withWorkspace(opts.workspaceId, async (tx) => tx<AppKeyRow[]>`
    INSERT INTO harness_shared.connected_apps
      (id, user_email, workspace_id, kind, label, scopes, limits, token_hash, expires_at, paired_at)
    VALUES (${minted.id}, ${opts.userEmail}, ${opts.workspaceId}, 'app', ${opts.label},
            ${JSON.stringify(scopes)}::jsonb, ${JSON.stringify(opts.limits ?? {})}::jsonb,
            ${minted.tokenHash}, ${opts.expiresAt ?? null}, now())
    RETURNING ${tx.unsafe(APP_COLUMNS)}
  `);
  const app = rows[0];
  if (!app) throw new Error('createAppKey: insert returned no row');
  return { app, key: minted.key };
}

/** Every app key in a workspace, newest first — revoked ones included, flagged by revoked_at. */
export async function listAppKeys(workspaceId: string): Promise<AppKeyRow[]> {
  return withWorkspace(workspaceId, async (tx) => tx<AppKeyRow[]>`
    SELECT ${tx.unsafe(APP_COLUMNS)}
      FROM harness_shared.connected_apps
     WHERE kind = 'app'
     ORDER BY paired_at DESC
  `);
}

/** Pause (true) or resume (false) a key. Returns false when no live key has that id. */
export async function setAppKeyPaused(workspaceId: string, id: string, paused: boolean): Promise<boolean> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<{ id: string }[]>`
    UPDATE harness_shared.connected_apps
       SET paused_at = CASE WHEN ${paused}::boolean THEN now() ELSE NULL END
     WHERE id = ${id} AND kind = 'app' AND revoked_at IS NULL
    RETURNING id
  `);
  return rows.length > 0;
}

/** Revoke a key permanently. Returns false when no live key has that id. */
export async function revokeAppKey(workspaceId: string, id: string): Promise<boolean> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<{ id: string }[]>`
    UPDATE harness_shared.connected_apps
       SET revoked_at = now()
     WHERE id = ${id} AND kind = 'app' AND revoked_at IS NULL
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * Verify a presented key. Refuses a malformed key, an unknown id, a secret that
 * does not hash to the stored digest, and a key that is revoked, paused, or past
 * its expiry. Revocation outranks pause outranks expiry in the reported reason.
 */
export async function verifyAppKey(key: string, now: Date = new Date()): Promise<AppKeyVerdict> {
  const parsed = parseAppKey(key);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { sql } = getOrgPg();
  const rows = await sql<(AppKeyRow & { token_hash: string | null })[]>`
    SELECT ${sql.unsafe(APP_COLUMNS)}, token_hash
      FROM harness_shared.connected_apps
     WHERE id = ${parsed.id} AND kind = 'app'
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  const { token_hash: tokenHash, ...app } = row;
  if (!appKeyHashMatches(key, tokenHash)) return { ok: false, reason: 'mismatch' };
  if (app.revoked_at) return { ok: false, reason: 'revoked' };
  if (app.paused_at) return { ok: false, reason: 'paused' };
  if (app.expires_at && app.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, app };
}

/**
 * The fields the scope policy needs, read fresh for one call (P-003). Admin connection, like
 * `verifyAppKey`: the dispatch seat reads the row by primary key before it trusts any workspace.
 * Null when no app key has that id. Reading per call (not caching the row on the principal) is
 * what makes pause, revoke and a scope change take effect on the very next call.
 */
export async function loadAppScopeRow(id: string): Promise<AppScopeRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<AppScopeRow[]>`
    SELECT id, workspace_id, scopes, revoked_at, paused_at, expires_at
      FROM harness_shared.connected_apps
     WHERE id = ${id} AND kind = 'app'
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Record that a key was just used. At most one write a minute per key (or on an
 * address change), so a busy app does not turn every request into an UPDATE.
 * Best-effort: callers must not fail a request because this did.
 */
export async function recordAppKeyUse(id: string, ip: string | null): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.connected_apps
       SET last_seen = now(), last_ip = COALESCE(${ip}, last_ip)
     WHERE id = ${id} AND kind = 'app'
       AND (last_seen IS NULL
            OR last_seen < now() - interval '60 seconds'
            OR (${ip}::text IS NOT NULL AND last_ip IS DISTINCT FROM ${ip}))
  `;
}
