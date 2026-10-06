/**
 * Provisioning for system:<name> principals.
 *
 * Creates a fresh bearer and writes it to two PG tables:
 *   1. harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
 *   2. harness_shared.token_index (token, kind='system', slug='system:<name>', workspace_id)
 *
 * Was previously also duplicated to `<papercuspRoot>/system/<name>/config.json`
 * for read-access by the operator's dispatch routes — that file is gone;
 * routes now read the bearer from token_index via apps/operator/lib/system-principal.ts.
 *
 * Idempotent per (workspace, name): re-running with the same name skips
 * if a row already exists (use `force: true` to rotate the bearer).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { withWorkspace } from '@papercusp/db-org';
import { PRINCIPAL_INVALIDATE_CHANNEL } from './auth';

/**
 * Tell every live auth cache (auth.ts LISTEN) that this principal's
 * capabilities changed. Runs inside the write tx — PG queues the NOTIFY
 * and delivers it on commit (dropped on rollback).
 */
async function notifyPrincipalChanged(tx: Sql, workspaceId: string, slug: string): Promise<void> {
  const payload = JSON.stringify({ workspace_id: workspaceId, slug });
  await tx`SELECT pg_notify(${PRINCIPAL_INVALIDATE_CHANNEL}, ${payload})`;
}

export interface ProvisionSystemPrincipalArgs {
  workspaceId: string;
  name: string;
  capabilities: string[];
  papercuspRoot: string;
  force?: boolean;
}

export interface ProvisionResult {
  workspaceId: string;
  name: string;
  /** The freshly-minted bearer — present ONLY when a bearer was created (initial
   *  provision) or rotated (`force`). ABSENT on a capabilities-only RECONCILE, which
   *  leaves the existing bearer untouched (there is no new bearer to return). */
  bearer?: string;
  /** Display label kept for log/UI surfaces; refers to where the bearer
   *  USED TO be written. The actual source of truth is now PG (token_index). */
  configPath: string;
  rotated: boolean;
  /** True when an ALREADY-PROVISIONED principal's capabilities were brought up to the
   *  code-defined set IN PLACE (additive, NO bearer rotation). EI-2048. */
  reconciled?: boolean;
}

/**
 * The ADDITIVE capability-reconcile decision (EI-2048), pure + exported for tests.
 * Returns the caps in `code` that `stored` lacks (`missing`) and the union to persist
 * (`merged`). NEVER removes a stored cap not in `code` — shrinking a principal's caps is
 * an attended `force` reprovision, not an automatic forceless-deploy side effect. When
 * `missing` is empty the live row is already current and the caller writes nothing.
 */
export function reconcileCapabilities(
  stored: readonly string[],
  code: readonly string[],
): { missing: string[]; merged: string[] } {
  const have = new Set(stored);
  const missing = code.filter((c) => !have.has(c));
  return { missing, merged: missing.length ? [...stored, ...missing] : [...stored] };
}

export function normalizeCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

function genBearer(): string {
  return randomBytes(32).toString('base64url');
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function provisionSystemPrincipal(
  args: ProvisionSystemPrincipalArgs,
): Promise<ProvisionResult | null> {
  const { workspaceId, name, capabilities, papercuspRoot, force } = args;
  const configPath = `${papercuspRoot}/system/${name}/config.json`;

  return withWorkspace(workspaceId, async (tx) => {
    const existing = await tx<Array<{ bearer_hash: string; capabilities: unknown }>>`
      SELECT bearer_hash, capabilities
        FROM harness_shared.system_principals
       WHERE workspace_id = ${workspaceId} AND name = ${name}
       LIMIT 1
    `;
    if (existing.length > 0 && !force) {
      // EI-2048: a capability ADDED in code (e.g. operator's memory:*/locks:* grant on
      // 2026-06-20) never reached an already-provisioned row — provision-without-force
      // used to be a pure no-op, and the only way to apply it (`force`) ROTATES the
      // bearer, breaking every live connection. So reconcile capabilities IN PLACE,
      // ADDITIVELY: grant the caps the code-defined set has that the live row lacks, and
      // NEVER auto-revoke (shrinking a principal's caps stays an attended `force`
      // reprovision — auto-revoking under a live session is the dangerous direction). The
      // bearer is untouched (zero token churn / no broken connections); NOTIFY makes
      // auth.ts's cache reload. A normal (forceless) deploy now self-heals cap drift.
      const storedCaps = normalizeCapabilities(existing[0].capabilities);
      const { missing, merged } = reconcileCapabilities(storedCaps, capabilities);
      if (missing.length === 0) return null; // already current — a true no-op
      await tx`
        UPDATE harness_shared.system_principals
           SET capabilities = ${JSON.stringify(merged)}::jsonb
         WHERE workspace_id = ${workspaceId} AND name = ${name}
      `;
      await notifyPrincipalChanged(tx, workspaceId, `system:${name}`);
      return { workspaceId, name, configPath, rotated: false, reconciled: true };
    }
    const bearer = genBearer();
    const bearerHash = hash(bearer);
    if (existing.length > 0) {
      // Rotate.
      await tx`
        UPDATE harness_shared.system_principals
           SET bearer_hash = ${bearerHash},
               capabilities = ${JSON.stringify(capabilities)}::jsonb
         WHERE workspace_id = ${workspaceId} AND name = ${name}
      `;
      await tx`
        DELETE FROM harness_shared.token_index
         WHERE kind = 'system'
           AND harness_slug = ${`system:${name}`}
           AND workspace_id = ${workspaceId}
      `;
    } else {
      await tx`
        INSERT INTO harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
        VALUES (${workspaceId}, ${name}, ${bearerHash}, ${JSON.stringify(capabilities)}::jsonb)
      `;
    }
    await tx`
      INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
      VALUES (${bearer}, 'system', ${`system:${name}`}, ${workspaceId})
      ON CONFLICT (token) DO UPDATE
        SET kind = 'system', harness_slug = ${`system:${name}`}, workspace_id = ${workspaceId}
    `;
    await notifyPrincipalChanged(tx, workspaceId, `system:${name}`);

    return {
      workspaceId,
      name,
      bearer,
      configPath,
      rotated: existing.length > 0,
    };
  });
}

export interface StartPiSessionArgs {
  workspaceId: string;
  sessionId: string;
  capabilities?: string[];
  /** Exact canonical MCP tool names. A PI session never infers this from URL `?tools=`. */
  allowedTools: string[];
  /** Absolute durable expiry. Defaults to one day for non-interactive PI sessions. */
  expiresAt?: Date;
}

export interface PiSessionResult {
  bearer: string;
  sessionId: string;
}

export const DEFAULT_PI_CAPABILITIES = [
  'tasks:read',
  'goals:read',
  'harness:read',
  'messages:read',
  'search:read',
];

export const DEFAULT_PI_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export async function startPiSession(
  args: StartPiSessionArgs,
): Promise<PiSessionResult> {
  const { workspaceId, sessionId } = args;
  const caps = args.capabilities === undefined ? DEFAULT_PI_CAPABILITIES : args.capabilities;
  const allowedTools = [...new Set(args.allowedTools.map((name) => name.trim()).filter(Boolean))];
  const expiresAt = args.expiresAt ?? new Date(Date.now() + DEFAULT_PI_SESSION_TTL_MS);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new TypeError('pi_session_expiry_must_be_in_the_future');
  }
  return withWorkspace(workspaceId, async (tx) => {
    const bearer = genBearer();
    const bearerHash = hash(bearer);
    await tx`
      INSERT INTO harness_shared.pi_sessions
        (workspace_id, session_id, bearer_hash, capabilities, allowed_tools, expires_at)
      VALUES (
        ${workspaceId}, ${sessionId}, ${bearerHash}, ${JSON.stringify(caps)}::jsonb,
        ${JSON.stringify(allowedTools)}::jsonb, ${expiresAt}
      )
    `;
    await tx`
      INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
      VALUES (${bearer}, 'pi', ${`pi:${sessionId}`}, ${workspaceId})
    `;
    await notifyPrincipalChanged(tx, workspaceId, `pi:${sessionId}`);
    return { bearer, sessionId };
  });
}

export async function endPiSession(workspaceId: string, sessionId: string): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.pi_sessions
         SET ended_at = now()
       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
    `;
    await tx`
      DELETE FROM harness_shared.token_index
       WHERE kind = 'pi' AND harness_slug = ${`pi:${sessionId}`} AND workspace_id = ${workspaceId}
    `;
    await notifyPrincipalChanged(tx, workspaceId, `pi:${sessionId}`);
  });
}
