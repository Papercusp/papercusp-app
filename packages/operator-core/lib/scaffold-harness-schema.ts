/**
 * Inline TypeScript replacement for bin/scaffold-harness-schema.sh.
 *
 * Creates the per-harness `harness_<slug>` schema containing ONLY auto-updatable
 * views over the slug-keyed harness_shared.*_consolidated tables — no physical
 * per-harness tables (harness-state-storage-unification-2026-06-01, D-007).
 * Views: harness_features, harness_issues, agent_runs, harness_snapshots
 * (migration 032), agent_chats (116), feature_audit (118), supervisor_notes +
 * directive_summaries (119), executed_actions (120). Retired:
 * config_token (token_index is authoritative), harness_proposals
 * (harness_proposals_shared is authoritative). `messages` (120) is no longer
 * minted for NEW harnesses (retire-work-item-mail-surface-2026-07-26,
 * P-003) — existing per-harness `messages` views are left in place, this
 * scaffolder just stops creating new ones.
 *
 * Idempotent. Called from add-project flow and onboard-action flow so a
 * new harness install needs no out-of-process bash.
 */
import { getOrgPg } from '@papercusp/db-org';

/**
 * The per-harness PG schema name for a slug: lowercase, hyphens→underscores.
 * Matches harnessSchemaName in libs/papercusp/libs/db/src/shared-schema.ts.
 * Exported so deprovision paths (pot:dissolve, create rollback) target the SAME
 * schema scaffoldHarnessSchema created — a raw `harness_<slug>` for a hyphenated
 * slug is both the wrong name AND a `DROP SCHEMA` syntax error.
 */
export function harnessSchemaName(slug: string): string {
  return 'harness_' + slug.toLowerCase().replace(/-/g, '_');
}

export async function scaffoldHarnessSchema(slug: string): Promise<void> {
  const schema = harnessSchemaName(slug);
  const { sql } = getOrgPg();

  // Per-harness schema only — every per-harness relation is now an auto-updatable
  // VIEW over a slug-keyed harness_shared.*_consolidated table (created below);
  // there are NO physical per-harness tables. Retired: config_token (token_index
  // is the authoritative token store), harness_proposals (harness_proposals_shared
  // is authoritative, fs-watcher-fed), feature_audit (writes go to consolidated),
  // and agent_chats / messages / executed_actions / supervisor_notes /
  // directive_summaries (migrations 116/118/119/120).
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS ${schema};

    GRANT USAGE ON SCHEMA ${schema} TO harness_app, harness_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO harness_app, harness_admin;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO harness_app, harness_admin;
  `);
  // harness_zero powers Zero WS for the web deploy path. Keep grants.
  // Wrapped in try/catch so harness scaffolding still works in environments
  // where Zero is intentionally absent (e.g. test rigs).
  try {
    await sql.unsafe(`
      GRANT USAGE ON SCHEMA ${schema} TO harness_zero;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO harness_zero;
    `);
  } catch { /* harness_zero absent — skip grants */ }

  // Auto-updatable views (Migration 032 pattern). Filtered on harness_slug
  // WITH CHECK OPTION so writers that include harness_slug pass through
  // and ones that don't are caught at INSERT time.
  await sql.unsafe(`
    CREATE OR REPLACE VIEW ${schema}.harness_features AS
      SELECT * FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    CREATE OR REPLACE VIEW ${schema}.harness_issues AS
      SELECT * FROM harness_shared.harness_issues_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    CREATE OR REPLACE VIEW ${schema}.agent_runs AS
      SELECT * FROM harness_shared.agent_runs_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    CREATE OR REPLACE VIEW ${schema}.harness_snapshots AS
      SELECT * FROM harness_shared.harness_snapshots_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    CREATE OR REPLACE VIEW ${schema}.agent_chats AS
      SELECT * FROM harness_shared.agent_chats_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    -- Column defaults so writers that omit these on INSERT pass through.
    -- harness_slug satisfies WITH CHECK OPTION.
    --
    -- NO workspace_id DEFAULT here, deliberately (WI-5243 / the WI-5125 class).
    -- This block used to mirror migration 116's workspace_id SET DEFAULT
    -- 'default', which made every writer that omitted the column file its row
    -- under the WRONG tenant while the INSERT still reported success — 181
    -- unreadable agent_chats rows, surfacing as a chat panel that spun forever.
    -- The active workspace is only knowable IN-PROCESS, so a literal here is a
    -- guess. Writers stamp it explicitly (activeWorkspaceId()), and
    -- harness_shared.fill_workspace_id_from_projects() is the BEFORE INSERT
    -- derive-net. Migration 616 dropped these defaults from existing schemas;
    -- re-adding one here would silently reintroduce the bug for every NEW
    -- harness (which is exactly how this scaffolder cloned it in the first place).
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN updated_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN transcript SET DEFAULT '[]'::jsonb;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN total_input_tokens SET DEFAULT 0;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN total_output_tokens SET DEFAULT 0;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN total_cost_usd_cents SET DEFAULT 0;

    CREATE OR REPLACE VIEW ${schema}.supervisor_notes AS
      SELECT * FROM harness_shared.supervisor_notes_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';
    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;
    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN body SET DEFAULT '';
    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN source SET DEFAULT '';

    CREATE OR REPLACE VIEW ${schema}.directive_summaries AS
      SELECT * FROM harness_shared.directive_summaries_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';
    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN source SET DEFAULT 'ceo';
    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN summary SET DEFAULT '';
    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;

    CREATE OR REPLACE VIEW ${schema}.executed_actions AS
      SELECT * FROM harness_shared.executed_actions_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    ALTER VIEW ${schema}.executed_actions ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ${schema}.harness_features,
      ${schema}.harness_issues,
      ${schema}.agent_runs,
      ${schema}.harness_snapshots,
      ${schema}.agent_chats,
      ${schema}.supervisor_notes,
      ${schema}.directive_summaries,
      ${schema}.executed_actions
      TO harness_app, harness_admin;
  `);
  try {
    await sql.unsafe(`
      GRANT SELECT ON
        ${schema}.harness_features,
        ${schema}.harness_issues,
        ${schema}.agent_runs,
        ${schema}.harness_snapshots,
        ${schema}.agent_chats,
        ${schema}.supervisor_notes,
        ${schema}.directive_summaries,
        ${schema}.executed_actions
        TO harness_zero;
    `);
  } catch { /* harness_zero absent — skip grants */ }
}

/**
 * Drop a harness's per-harness schema — the inverse of scaffoldHarnessSchema.
 * Targets the SAME sanitized name (harnessSchemaName), so it is correct for
 * hyphenated slugs. Used by pot:dissolve + the pot:create rollback.
 */
export async function dropHarnessSchema(slug: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${harnessSchemaName(slug)} CASCADE`);
}
