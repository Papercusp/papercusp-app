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
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { appKeyHashMatches, mintAppKey, parseAppKey } from './key';
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
}

export type AppKeyRefusal = 'malformed' | 'unknown' | 'mismatch' | 'rotated' | 'revoked' | 'paused' | 'expired';

export type AppKeyVerdict =
  | {
      ok: true;
      app: AppKeyRow;
      /** True when the key presented is the previous secret, inside its rotation overlap window. */
      viaPreviousKey: boolean;
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
  rotated_at, previous_token_valid_until`;

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

/** A stored key row as verification reads it: the public row plus both digests. */
export type StoredAppKeyRow = AppKeyRow & {
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
 *
 * Nothing here reads who created the key: a service key belongs to the workspace, so a change in
 * its creator's organization membership cannot refuse it (D-007, R-10).
 */
export function appKeyVerdictOf(row: StoredAppKeyRow | null | undefined, key: string, now: Date): AppKeyVerdict {
  if (!parseAppKey(key)) return { ok: false, reason: 'malformed' };
  if (!row) return { ok: false, reason: 'unknown' };
  const { token_hash: tokenHash, previous_token_hash: previousHash, ...app } = row;
  let viaPreviousKey = false;
  if (!appKeyHashMatches(key, tokenHash)) {
    if (!appKeyHashMatches(key, previousHash)) return { ok: false, reason: 'mismatch' };
    if (!previousKeyStillValid(app.previous_token_valid_until, now)) return { ok: false, reason: 'rotated' };
    viaPreviousKey = true;
  }
  if (app.revoked_at) return { ok: false, reason: 'revoked' };
  if (app.paused_at) return { ok: false, reason: 'paused' };
  if (app.expires_at && app.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, app, viaPreviousKey };
}

/**
 * Verify a presented key: read its row by primary key and apply `appKeyVerdictOf`. Refuses a
 * malformed key, an unknown id, a secret that does not hash to a live digest, and a key that is
 * revoked, paused, or past its expiry.
 */
export async function verifyAppKey(key: string, now: Date = new Date()): Promise<AppKeyVerdict> {
  const parsed = parseAppKey(key);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { sql } = getOrgPg();
  const rows = await sql<StoredAppKeyRow[]>`
    SELECT ${sql.unsafe(APP_COLUMNS)}, token_hash, previous_token_hash
      FROM harness_shared.connected_apps
     WHERE id = ${parsed.id} AND ${sql.unsafe(KEY_KINDS_SQL)}
     LIMIT 1
  `;
  return appKeyVerdictOf(rows[0], key, now);
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
     WHERE id = ${id} AND ${sql.unsafe(KEY_KINDS_SQL)}
       AND (last_seen IS NULL
            OR last_seen < now() - interval '60 seconds'
            OR (${ip}::text IS NOT NULL AND last_ip IS DISTINCT FROM ${ip}))
  `;
}
