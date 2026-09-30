import type { Sql } from 'postgres';

/** The complete persisted state needed to restore one routine exactly. */
export interface RoutineSnap {
  triggerConfig: Record<string, unknown>;
  payloadTemplate: Record<string, unknown>;
  active: boolean;
  nextFireAtIso: string | null;
  groupSlug: string | null;
  metadata: Record<string, unknown>;
}

interface RoutineRow {
  trigger_config: Record<string, unknown> | null;
  payload_template: Record<string, unknown> | null;
  active: boolean;
  next_fire_at: Date | string | number | null;
  group_slug: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * A routine that was read authoritatively but disappeared before a follow-up
 * control mutation could use the snapshot. Callers can distinguish this
 * reconciliation outcome from an invalid initial target or an unrelated DB
 * failure without matching an error message.
 */
export class RoutineTargetMissingError extends Error {
  readonly code = 'routine_target_missing' as const;

  constructor(
    readonly installSlug: string,
    readonly routineName: string,
  ) {
    super(`routine not found: ${installSlug}/${routineName} (use routines:list to see names)`);
    this.name = 'RoutineTargetMissingError';
  }
}

export function isRoutineTargetMissingError(error: unknown): error is RoutineTargetMissingError {
  return (
    error instanceof RoutineTargetMissingError ||
    (isRecord(error) && error.code === 'routine_target_missing')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the JSON stored in a control audit row before using it as a restore
 * target. Audit rows are durable input, so malformed/legacy rows must fail
 * closed rather than partially restoring a routine.
 */
export function parseRoutineSnap(value: unknown): RoutineSnap | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.triggerConfig) || !isRecord(value.payloadTemplate) || !isRecord(value.metadata)) return null;
  if (typeof value.active !== 'boolean') return null;
  if (value.nextFireAtIso !== null && typeof value.nextFireAtIso !== 'string') return null;
  if (value.groupSlug !== null && typeof value.groupSlug !== 'string') return null;
  return {
    triggerConfig: value.triggerConfig,
    payloadTemplate: value.payloadTemplate,
    active: value.active,
    nextFireAtIso: value.nextFireAtIso,
    groupSlug: value.groupSlug,
    metadata: value.metadata,
  };
}

/**
 * Canonicalize object key order (recursively, sorted) so a JSON.stringify
 * comparison is independent of insertion order. Exported for any caller that
 * needs to order-independently compare a JSON-ish VALUE directly (routines:set's
 * verify step compares just `payload_template`, not a whole RoutineSnap, so it
 * cannot reuse routineSnapEqual below) — see routines/set.ts's `verify`.
 */
export function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

/** Compare snapshots by value, independent of JSON object-key insertion order. */
export function routineSnapEqual(left: RoutineSnap, right: RoutineSnap): boolean {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

export async function readRoutineSnap(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  name: string,
): Promise<RoutineSnap> {
  const rows = await sql<RoutineRow[]>`
    SELECT trigger_config, payload_template, active, next_fire_at, group_slug, metadata
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = ${name}
     LIMIT 1`;
  if (rows.length === 0) throw new RoutineTargetMissingError(installSlug, name);
  const row = rows[0];
  const nextDate = row.next_fire_at == null ? null : new Date(row.next_fire_at);
  return {
    triggerConfig: row.trigger_config ?? {},
    payloadTemplate: row.payload_template ?? {},
    active: row.active,
    nextFireAtIso: nextDate && !Number.isNaN(nextDate.getTime()) ? nextDate.toISOString() : null,
    groupSlug: row.group_slug ?? null,
    metadata: row.metadata ?? {},
  };
}

export interface ResolvedRoutineSnap {
  installSlug: string;
  snapshot: RoutineSnap;
}

/**
 * Resolve a name-only routines:set target without widening an ordinary home-harness
 * lookup. The operator-home row remains the compatibility default; only when that
 * exact row is absent do we search the workspace for a unique same-name row (for
 * example a workspace singleton under `@singleton`). Multiple matches are refused
 * so a name-only mutation can never silently choose the wrong install.
 */
export async function resolveRoutineSnap(
  sql: Sql,
  workspaceId: string,
  defaultInstallSlug: string,
  name: string,
): Promise<ResolvedRoutineSnap> {
  try {
    return {
      installSlug: defaultInstallSlug,
      snapshot: await readRoutineSnap(sql, workspaceId, defaultInstallSlug, name),
    };
  } catch (error) {
    if (!isRoutineTargetMissingError(error)) throw error;
    const candidates = await sql<Array<{ install_slug: string }>>`
      SELECT install_slug
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND name = ${name}
       ORDER BY install_slug`;
    if (candidates.length === 0) throw error;
    const slugs = [...new Set(candidates.map((row) => row.install_slug))];
    if (slugs.length !== 1) {
      throw new Error(
        `routine name is ambiguous: ${name} exists under install slugs ${slugs.join(', ')}; pass installSlug to select one`,
      );
    }
    const installSlug = slugs[0]!;
    return {
      installSlug,
      snapshot: await readRoutineSnap(sql, workspaceId, installSlug, name),
    };
  }
}

export async function writeRoutineSnap(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  name: string,
  snap: RoutineSnap,
): Promise<void> {
  // The FK (workspace_id, group_slug) requires an assigned group to exist.
  // Match routines:set's existing behavior by creating a blank group row on
  // first assignment; routines:group-set fills in its metadata.
  if (snap.groupSlug) {
    await sql`
      INSERT INTO harness_shared.routine_groups (workspace_id, slug)
      VALUES (${workspaceId}, ${snap.groupSlug})
      ON CONFLICT (workspace_id, slug) DO NOTHING`;
  }
  await sql`
    UPDATE harness_shared.routines
       SET trigger_config = ${JSON.stringify(snap.triggerConfig)}::text::jsonb,
           payload_template = ${JSON.stringify(snap.payloadTemplate)}::text::jsonb,
           active = ${snap.active},
           next_fire_at = ${snap.nextFireAtIso}::timestamptz,
           group_slug = ${snap.groupSlug},
           metadata = ${JSON.stringify(snap.metadata)}::text::jsonb,
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = ${name}`;
}
