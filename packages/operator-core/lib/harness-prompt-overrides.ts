/**
 * Workspace-owned per-harness prompt overrides — the PG home for what used to
 * live in the harness folder at `.papercusp/prompts/<role>.md`. (Phase 1b of
 * harnesses-across-workspaces, decision D-7.)
 *
 * Keyed by (workspace_id, harness_slug, role): the SAME harness linked into two
 * workspaces gets independent overrides, and linking a folder no longer shares
 * its prompt tuning. This is the per-(workspace,harness) layer of the 3-tier
 * resolution (repo base role prompt → workspace default → THIS override); the
 * resolver + the orchestrator read-repoint + the D-6 seed/reset land on top of
 * this store in follow-up commits.
 *
 * Additive: this only introduces the store + CRUD. Nothing reads it for live
 * prompt assembly yet, so it changes no existing behavior.
 */
import { getOrgPg } from '@papercusp/db-org';

// NOTE: the `harness_shared.harness_prompt_overrides` table is defined in
// `000-baseline.sql`; harness_app/harness_admin grants come from migration 109.
// The lazy runtime `ensureHarnessPromptOverridesTable()` `CREATE TABLE IF NOT
// EXISTS` + `GRANT` that used to run before each op was redundant (a "schema =
// migrations only" no-op) and was removed in
// self-contained-migration-baseline-2026-06-02 (P-008b-remainder).

/** The override markdown for (workspace, harness, role), or null when unset. */
export async function getPromptOverride(
  workspaceId: string,
  harnessSlug: string,
  role: string,
): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ prompt_md: string }[]>`
    SELECT prompt_md FROM harness_shared.harness_prompt_overrides
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND role = ${role}
     LIMIT 1
  `;
  return rows.length > 0 ? rows[0].prompt_md : null;
}

/** Upsert the override markdown for (workspace, harness, role). */
export async function setPromptOverride(
  workspaceId: string,
  harnessSlug: string,
  role: string,
  promptMd: string,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.harness_prompt_overrides (workspace_id, harness_slug, role, prompt_md, updated_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${role}, ${promptMd}, ${Date.now()})
    ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE
      SET prompt_md = EXCLUDED.prompt_md, updated_at = EXCLUDED.updated_at
  `;
}

/** Remove the override for (workspace, harness, role). Returns true if one existed. */
export async function deletePromptOverride(
  workspaceId: string,
  harnessSlug: string,
  role: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    DELETE FROM harness_shared.harness_prompt_overrides
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND role = ${role}
     RETURNING role
  `;
  return rows.length > 0;
}

/** Remove ALL overrides for a harness in a workspace (D-6 reset-all = clear →
    the orchestrator falls back to the committed repo default). Returns the count. */
export async function clearAllPromptOverrides(
  workspaceId: string,
  harnessSlug: string,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql`
    DELETE FROM harness_shared.harness_prompt_overrides
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
     RETURNING role
  `;
  return rows.length;
}

/** All overrides for a harness in a workspace, by role. */
export async function listPromptOverrides(
  workspaceId: string,
  harnessSlug: string,
): Promise<Array<{ role: string; promptMd: string; updatedAt: number }>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ role: string; prompt_md: string; updated_at: string }[]>`
    SELECT role, prompt_md, updated_at FROM harness_shared.harness_prompt_overrides
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
     ORDER BY role
  `;
  return rows.map((r) => ({ role: r.role, promptMd: r.prompt_md, updatedAt: Number(r.updated_at) }));
}
