/**
 * saved-prompts-store.ts — PG CRUD for cross-client saved prompts
 * (`harness_shared.saved_prompts`, migration 105). Canonical store; the
 * on-disk command files are a projection of these rows (D-001).
 *
 * Transport-agnostic: every function takes the `sql` handle so the same
 * code serves a principal-gated tool's `ctx.tx`, the launch path's
 * workspace-resolved `getOrgPg()` connection, and the integration test's
 * testcontainer handle. Scope is explicit (`workspace` ⇒ harness_slug
 * NULL; `harness` ⇒ harness_slug = slug); rows are always filtered by
 * workspace_id (RLS is defense-in-depth on top).
 *
 * Server-only.
 */
import type postgres from 'postgres';

export type PromptScope = { kind: 'workspace' } | { kind: 'harness'; slug: string };

export interface SavedPromptRow {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  name: string;
  body: string;
  description: string | null;
  argHint: string | null;
  createdAt: string;
  updatedAt: string;
  /** Organizer columns (migration 598, quick-panel-saved-prompts-2026-07-13). */
  parentId: string | null;
  position: string | null;
  title: string | null;
  collapsed: boolean;
  pinned: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  archivedAt: string | null;
  /** Workflowy-style checkoff (migration 606); NULL = active. Visual only — see D-003. */
  completedAt: string | null;
}

export interface UpsertSavedPromptInput {
  workspaceId: string;
  scope: PromptScope;
  name: string;
  body: string;
  description?: string | null;
  argHint?: string | null;
}

type DbRow = {
  id: string;
  workspace_id: string;
  harness_slug: string | null;
  name: string;
  body: string;
  description: string | null;
  arg_hint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  parent_id: string | null;
  position: string | null;
  title: string | null;
  collapsed: boolean;
  pinned: boolean;
  usage_count: number;
  last_used_at: Date | string | null;
  archived_at: Date | string | null;
  completed_at: Date | string | null;
};

const asIso = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const asIsoOrNull = (v: Date | string | null): string | null => (v === null ? null : asIso(v));

function mapRow(r: DbRow): SavedPromptRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    name: r.name,
    body: r.body,
    description: r.description,
    argHint: r.arg_hint,
    createdAt: asIso(r.created_at),
    updatedAt: asIso(r.updated_at),
    parentId: r.parent_id,
    position: r.position,
    title: r.title,
    collapsed: r.collapsed,
    pinned: r.pinned,
    usageCount: r.usage_count,
    lastUsedAt: asIsoOrNull(r.last_used_at),
    archivedAt: asIsoOrNull(r.archived_at),
    completedAt: asIsoOrNull(r.completed_at),
  };
}

/** List the prompts for exactly one scope (workspace-global, or a single harness). */
export async function listSavedPrompts(
  sql: postgres.Sql,
  workspaceId: string,
  scope: PromptScope,
): Promise<SavedPromptRow[]> {
  const rows =
    scope.kind === 'harness'
      ? await sql<DbRow[]>`
          SELECT * FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${scope.slug}
           ORDER BY name`
      : await sql<DbRow[]>`
          SELECT * FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug IS NULL
           ORDER BY name`;
  return rows.map(mapRow);
}

/** Insert a prompt, or update body/description/arg_hint in place for an existing same-scope name. */
export async function upsertSavedPrompt(
  sql: postgres.Sql,
  input: UpsertSavedPromptInput,
): Promise<SavedPromptRow> {
  const slug = input.scope.kind === 'harness' ? input.scope.slug : null;
  const rows = await sql<DbRow[]>`
    INSERT INTO harness_shared.saved_prompts
      (workspace_id, harness_slug, name, body, description, arg_hint, updated_at)
    VALUES (
      ${input.workspaceId}, ${slug}, ${input.name}, ${input.body},
      ${input.description ?? null}, ${input.argHint ?? null}, now()
    )
    ON CONFLICT (workspace_id, COALESCE(harness_slug, ''), name)
    DO UPDATE SET body = EXCLUDED.body,
                  description = EXCLUDED.description,
                  arg_hint = EXCLUDED.arg_hint,
                  updated_at = now()
    RETURNING *`;
  return mapRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Outline-node CRUD (quick-panel-saved-prompts-2026-07-13). Id-based, because
// the organizer renames titles and moves nodes — `name` stays the stable
// slash-command key, auto-derived from the title on create.
// ---------------------------------------------------------------------------

/** Derive a valid kebab `name` from a free-text title ('' → 'prompt'). */
export function slugifyPromptName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug.length > 0 ? slug : 'prompt';
}

export interface CreatePromptNodeInput {
  workspaceId: string;
  scope: PromptScope;
  title: string;
  /** '' marks a pure folder node (skipped by the slash-command projector). */
  body: string;
  parentId?: string | null;
  position?: string | null;
  description?: string | null;
  argHint?: string | null;
}

/**
 * Insert an outline node. `name` is derived from the title and suffixed
 * (-2, -3, …) until unique within the scope, so free-text titles never
 * collide with the slash-command key's uniqueness.
 */
export async function createPromptNode(
  sql: postgres.Sql,
  input: CreatePromptNodeInput,
): Promise<SavedPromptRow> {
  const slug = input.scope.kind === 'harness' ? input.scope.slug : null;
  const base = slugifyPromptName(input.title);
  for (let attempt = 0; ; attempt += 1) {
    const name =
      attempt === 0
        ? base
        : attempt < 50
          ? `${base}-${attempt + 1}`
          : `${base}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const rows = await sql<DbRow[]>`
        INSERT INTO harness_shared.saved_prompts
          (workspace_id, harness_slug, name, title, body, description, arg_hint,
           parent_id, position, updated_at)
        VALUES (
          ${input.workspaceId}, ${slug}, ${name}, ${input.title || null}, ${input.body},
          ${input.description ?? null}, ${input.argHint ?? null},
          ${input.parentId ?? null}, ${input.position ?? null}, now()
        )
        RETURNING *`;
      return mapRow(rows[0]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err; // not a unique violation
    }
  }
}

export interface UpdatePromptNodePatch {
  title?: string;
  body?: string;
  description?: string | null;
  argHint?: string | null;
  collapsed?: boolean;
  pinned?: boolean;
  /** true checks the node off (keeps an existing timestamp); false clears it. */
  completed?: boolean;
}

/** Patch a node's editable fields by id (scoped to the workspace). Null when unknown. */
export async function updatePromptNodeById(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
  patch: UpdatePromptNodePatch,
): Promise<SavedPromptRow | null> {
  const rows = await sql<DbRow[]>`
    UPDATE harness_shared.saved_prompts SET
      title       = COALESCE(${patch.title ?? null}, title),
      body        = COALESCE(${patch.body ?? null}, body),
      description = ${patch.description !== undefined ? patch.description : sql`description`},
      arg_hint    = ${patch.argHint !== undefined ? patch.argHint : sql`arg_hint`},
      collapsed   = COALESCE(${patch.collapsed ?? null}, collapsed),
      pinned      = COALESCE(${patch.pinned ?? null}, pinned),
      completed_at = ${
        patch.completed === undefined
          ? sql`completed_at`
          : patch.completed
            ? sql`COALESCE(completed_at, now())`
            : null
      },
      updated_at  = now()
    WHERE workspace_id = ${workspaceId} AND id = ${id}
    RETURNING *`;
  return rows.length ? mapRow(rows[0]) : null;
}

export interface MovePromptNodeAssignment {
  id: string;
  parentId: string | null;
  position: string;
}

/** Apply a batch of move assignments (one logical outline move) atomically. */
export async function movePromptNodes(
  sql: postgres.Sql,
  workspaceId: string,
  assignments: MovePromptNodeAssignment[],
): Promise<number> {
  if (assignments.length === 0) return 0;
  let updated = 0;
  await sql.begin(async (tx) => {
    for (const a of assignments) {
      const res = await tx`
        UPDATE harness_shared.saved_prompts
           SET parent_id = ${a.parentId}, position = ${a.position}, updated_at = now()
         WHERE workspace_id = ${workspaceId} AND id = ${a.id}`;
      updated += res.count;
    }
  });
  return updated;
}

/**
 * Archive a node AND its whole subtree (Workflowy-undoable delete, D-004).
 * Only rows not already archived are stamped, and exactly those ids are
 * returned — the caller holds them as the undo set for unarchivePromptNodes.
 */
export async function archivePromptSubtree(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM harness_shared.saved_prompts
       WHERE workspace_id = ${workspaceId} AND id = ${id}
      UNION ALL
      SELECT c.id FROM harness_shared.saved_prompts c
        JOIN subtree s ON c.parent_id = s.id
       WHERE c.workspace_id = ${workspaceId}
    )
    UPDATE harness_shared.saved_prompts p
       SET archived_at = now(), updated_at = now()
      FROM subtree s
     WHERE p.id = s.id AND p.archived_at IS NULL
    RETURNING p.id`;
  return rows.map((r) => r.id);
}

/** Restore archived nodes by id (the undo of archivePromptSubtree). */
export async function unarchivePromptNodes(
  sql: postgres.Sql,
  workspaceId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await sql`
    UPDATE harness_shared.saved_prompts
       SET archived_at = NULL, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::uuid[])
       AND archived_at IS NOT NULL`;
  return res.count;
}

/** Delete a node by id; the parent_id FK cascades to the whole subtree. */
export async function removePromptNodeById(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const res = await sql`
    DELETE FROM harness_shared.saved_prompts
     WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  return res.count > 0;
}

/** Record a use (copy): bump usage_count, stamp last_used_at. */
export async function recordPromptUse(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<void> {
  await sql`
    UPDATE harness_shared.saved_prompts
       SET usage_count = usage_count + 1, last_used_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${id}`;
}

/** Delete one prompt by scope + name; returns true iff a row was removed. */
export async function removeSavedPrompt(
  sql: postgres.Sql,
  workspaceId: string,
  scope: PromptScope,
  name: string,
): Promise<boolean> {
  const res =
    scope.kind === 'harness'
      ? await sql`
          DELETE FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${scope.slug} AND name = ${name}`
      : await sql`
          DELETE FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug IS NULL AND name = ${name}`;
  return res.count > 0;
}
