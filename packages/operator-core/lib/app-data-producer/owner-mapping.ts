/**
 * P-003 — the platform-user → app-owner mapping.
 *
 * Platform-side, a canonical row is owned by `(workspace_id, user_id)`: a uuid
 * FK to `harness_shared.users`. App-side, every store read is scoped by an
 * opaque `ownerId` string that the app takes from the `sub` of a JWT it
 * verifies itself. The two identifier spaces are unrelated, and NOTHING in a
 * provider payload may be allowed to bridge them.
 *
 * That is the whole point of this module. A wrong mapping does not raise an
 * error anywhere — it silently delivers one person's mail into another
 * person's app. So the relation is read from an explicit, deliberately
 * configured table and never inferred, guessed, or defaulted. This mirrors
 * `createPersonalVaultExternalSinkForSource`, which resolves its target user
 * from the source's server-owned `ownerUserId` under the same rule.
 *
 * The two failure modes are asymmetric, and only one is caught by a schema:
 *  - MISSING mapping → nothing to deliver to. Loud by construction: callers use
 *    `requireAppOwnerId`, which throws. Never falls back to the platform uuid.
 *  - WRONG mapping → delivers to a real, live, WRONG app owner. A schema cannot
 *    catch a typo'd-but-plausible owner id, so the one shape it CAN catch —
 *    two platform users pointing at a single app owner — is enforced by the
 *    `app_owner_mappings_owner_unique` constraint in migration 1029.
 */
import type { Sql } from 'postgres';

/**
 * Apps the producer can deliver to.
 *
 * Deliberately a code constant rather than a database CHECK: registering an app
 * already requires code (its JWT audience and signing secret), so keeping the
 * list here means adding one is a code change instead of a code change AND a
 * migration. The table's own CHECK only enforces the slug SHAPE.
 */
export const PRODUCER_APPS = ['email', 'calendar'] as const;
export type ProducerApp = (typeof PRODUCER_APPS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AppOwnerMapping {
  workspaceId: string;
  userId: string;
  app: ProducerApp;
  ownerId: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isProducerApp(value: string): value is ProducerApp {
  return (PRODUCER_APPS as readonly string[]).includes(value);
}

/**
 * The app's JWT audience, derived from the slug in exactly ONE place.
 *
 * The apps verify `audience: "papercusp-email"` / `"papercusp-calendar"`
 * (apps/sidecar/src/auth.ts). Deriving it here rather than storing a second
 * copy per row means the audience cannot drift away from the app it names —
 * a stored audience column would be a second spelling of a fact the slug
 * already determines.
 */
export function appAudience(app: ProducerApp): string {
  return `papercusp-${app}`;
}

function assertApp(app: string): ProducerApp {
  if (!isProducerApp(app)) {
    throw new Error(`app_owner_mapping_unknown_app:${app} (known: ${PRODUCER_APPS.join(', ')})`);
  }
  return app;
}

function assertUserId(userId: string): string {
  const normalized = userId.trim();
  if (!UUID_RE.test(normalized)) throw new Error(`app_owner_mapping_user_id_invalid:${userId}`);
  return normalized;
}

function assertWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error('app_owner_mapping_workspace_required');
  return normalized;
}

/**
 * Resolve the app owner for one platform user, or null when none is configured.
 *
 * Returns null rather than throwing so a producer sweeping many users can SKIP
 * the unmapped ones and report them, instead of one unconfigured user aborting
 * everyone's delivery. Use `requireAppOwnerId` on a single-target path.
 */
export async function resolveAppOwnerId(
  sql: Sql,
  workspaceId: string,
  userId: string,
  app: string,
): Promise<string | null> {
  const rows = await sql<{ owner_id: string }[]>`
    SELECT owner_id
      FROM harness_shared.app_owner_mappings
     WHERE workspace_id = ${assertWorkspaceId(workspaceId)}
       AND user_id = ${assertUserId(userId)}
       AND app = ${assertApp(app)}
     LIMIT 1
  `;
  return rows[0]?.owner_id ?? null;
}

/**
 * Resolve the app owner, or throw.
 *
 * The error names the exact missing row so an operator can act on it directly.
 * There is no fallback on purpose: defaulting to the platform uuid would
 * "work" — the app would happily create a store scoped to a subject nobody
 * authenticates as, and the data would land somewhere real but unreachable.
 */
export async function requireAppOwnerId(
  sql: Sql,
  workspaceId: string,
  userId: string,
  app: string,
): Promise<string> {
  const ownerId = await resolveAppOwnerId(sql, workspaceId, userId, app);
  if (!ownerId) {
    throw new Error(
      `app_owner_mapping_required:${app}:${userId} — configure it with setAppOwnerMapping; the producer never infers an app owner from a platform user id`,
    );
  }
  return ownerId;
}

/** Every mapping for one app — the producer's work list for a sweep. */
export async function listAppOwnerMappings(
  sql: Sql,
  workspaceId: string,
  app?: string,
): Promise<AppOwnerMapping[]> {
  const workspace = assertWorkspaceId(workspaceId);
  const rows = app === undefined
    ? await sql<AppOwnerMappingRow[]>`
        SELECT workspace_id, user_id, app, owner_id, note, created_at, updated_at
          FROM harness_shared.app_owner_mappings
         WHERE workspace_id = ${workspace}
         ORDER BY app, user_id
      `
    : await sql<AppOwnerMappingRow[]>`
        SELECT workspace_id, user_id, app, owner_id, note, created_at, updated_at
          FROM harness_shared.app_owner_mappings
         WHERE workspace_id = ${workspace}
           AND app = ${assertApp(app)}
         ORDER BY user_id
      `;
  return rows.map(toMapping);
}

interface AppOwnerMappingRow {
  workspace_id: string;
  user_id: string;
  app: string;
  owner_id: string;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

function toMapping(row: AppOwnerMappingRow): AppOwnerMapping {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    app: assertApp(row.app),
    ownerId: row.owner_id,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Configure one mapping (upsert on the primary key).
 *
 * Re-pointing an existing user at a DIFFERENT app owner is allowed — that is a
 * legitimate reconfiguration. Pointing a SECOND platform user at an app owner
 * already claimed by another is not, and the unique constraint rejects it;
 * the error is rewritten here into something an operator can act on, because
 * the raw Postgres text names a constraint rather than the hazard.
 */
export async function setAppOwnerMapping(
  sql: Sql,
  input: { workspaceId: string; userId: string; app: string; ownerId: string; note?: string | null },
): Promise<AppOwnerMapping> {
  const ownerId = input.ownerId.trim();
  if (!ownerId) throw new Error('app_owner_mapping_owner_id_required');
  const workspaceId = assertWorkspaceId(input.workspaceId);
  const userId = assertUserId(input.userId);
  const app = assertApp(input.app);

  try {
    const rows = await sql<AppOwnerMappingRow[]>`
      INSERT INTO harness_shared.app_owner_mappings
        (workspace_id, user_id, app, owner_id, note)
      VALUES (${workspaceId}, ${userId}, ${app}, ${ownerId}, ${input.note ?? null})
      ON CONFLICT (workspace_id, user_id, app) DO UPDATE
        SET owner_id = EXCLUDED.owner_id,
            note = EXCLUDED.note,
            updated_at = now()
      RETURNING workspace_id, user_id, app, owner_id, note, created_at, updated_at
    `;
    return toMapping(rows[0]!);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('app_owner_mappings_owner_unique')) {
      throw new Error(
        `app_owner_mapping_owner_taken:${app}:${ownerId} — that app owner is already mapped to a different platform user. Two users sharing one app owner would merge their data in that app's store.`,
      );
    }
    throw error;
  }
}

/** Remove one mapping. Returns whether a row was actually deleted. */
export async function deleteAppOwnerMapping(
  sql: Sql,
  workspaceId: string,
  userId: string,
  app: string,
): Promise<boolean> {
  const rows = await sql<{ owner_id: string }[]>`
    DELETE FROM harness_shared.app_owner_mappings
     WHERE workspace_id = ${assertWorkspaceId(workspaceId)}
       AND user_id = ${assertUserId(userId)}
       AND app = ${assertApp(app)}
    RETURNING owner_id
  `;
  return rows.length > 0;
}
