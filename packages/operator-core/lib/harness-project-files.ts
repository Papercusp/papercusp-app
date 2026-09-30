/**
 * Per-harness "project files" — SPEC.md, AGENTS.md, validation-contract.md,
 * and config.json — stored in `harness_shared.harness_project_files`.
 *
 * Migration 034: PG is canonical; the disk mirrors that the route handlers
 * write are best-effort, for editor convenience. Optimistic concurrency via
 * the `version` column — callers may supply `expectedVersion` to detect a
 * concurrent edit and rebase.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 2) so the `/api/harness/:slug/spec` routes can migrate to
 * `defineTool` without dragging the route file back through `_hono/`.
 */

export interface ProjectFiles {
  spec: string | null;
  agents: string | null;
  contract: string | null;
  config: string | null;
  version: number;
}

export async function loadProjectFiles(slug: string): Promise<ProjectFiles> {
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const rows = await sql<Array<ProjectFiles>>`
    SELECT spec, agents, contract, config, version
      FROM harness_shared.harness_project_files
     WHERE harness_slug = ${slug}
     LIMIT 1
  `;
  return rows[0] ?? { spec: null, agents: null, contract: null, config: null, version: 0 };
}

/**
 * Concurrency conflict thrown by `saveProjectFiles` when `expectedVersion`
 * is provided but does not match the row's current version. Carries the
 * server-observed version so the caller can resolve.
 */
export class ProjectFilesVersionConflict extends Error {
  readonly currentVersion: number;
  constructor(slug: string, expected: number, current: number) {
    super(`spec version conflict on ${slug}: expected ${expected}, current ${current}`);
    this.name = 'ProjectFilesVersionConflict';
    this.currentVersion = current;
  }
}

export async function saveProjectFiles(
  slug: string,
  patch: { spec?: string; agents?: string; contract?: string; config?: string },
  opts: { expectedVersion?: number } = {},
): Promise<{ version: number }> {
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const now = Date.now();

  // Two paths: with OCC (expectedVersion set) → UPDATE-only with the
  // version guard; without OCC → upsert with version bumped on update.
  let version = 0;
  if (typeof opts.expectedVersion === 'number') {
    const updated = await sql<Array<{ version: number }>>`
      UPDATE harness_shared.harness_project_files
         SET spec       = COALESCE(${patch.spec ?? null}, spec),
             agents     = COALESCE(${patch.agents ?? null}, agents),
             contract   = COALESCE(${patch.contract ?? null}, contract),
             config     = COALESCE(${patch.config ?? null}, config),
             updated_at = ${now},
             version    = version + 1
       WHERE harness_slug = ${slug}
         AND version = ${opts.expectedVersion}
       RETURNING version
    `;
    if (updated.length === 0) {
      const cur = await sql<Array<{ version: number }>>`
        SELECT version FROM harness_shared.harness_project_files
         WHERE harness_slug = ${slug} LIMIT 1
      `;
      if (cur.length === 0 && opts.expectedVersion === 0) {
        await sql`
          INSERT INTO harness_shared.harness_project_files
            (harness_slug, spec, agents, contract, config, updated_at, version)
          VALUES
            (${slug}, ${patch.spec ?? null}, ${patch.agents ?? null},
             ${patch.contract ?? null}, ${patch.config ?? null}, ${now}, 1)
          ON CONFLICT (harness_slug) DO NOTHING
        `;
        const created = await sql<Array<{ version: number }>>`
          SELECT version FROM harness_shared.harness_project_files
           WHERE harness_slug = ${slug} LIMIT 1
        `;
        version = created[0]?.version ?? 1;
      } else {
        throw new ProjectFilesVersionConflict(slug, opts.expectedVersion, cur[0]?.version ?? 0);
      }
    } else {
      version = updated[0].version;
    }
  } else {
    const rows = await sql<Array<{ version: number }>>`
      INSERT INTO harness_shared.harness_project_files
        (harness_slug, spec, agents, contract, config, updated_at, version)
      VALUES
        (${slug}, ${patch.spec ?? null}, ${patch.agents ?? null},
         ${patch.contract ?? null}, ${patch.config ?? null}, ${now}, 1)
      ON CONFLICT (harness_slug) DO UPDATE SET
        spec       = COALESCE(EXCLUDED.spec, harness_shared.harness_project_files.spec),
        agents     = COALESCE(EXCLUDED.agents, harness_shared.harness_project_files.agents),
        contract   = COALESCE(EXCLUDED.contract, harness_shared.harness_project_files.contract),
        config     = COALESCE(EXCLUDED.config, harness_shared.harness_project_files.config),
        updated_at = EXCLUDED.updated_at,
        version    = harness_shared.harness_project_files.version + 1
      RETURNING version
    `;
    version = rows[0]?.version ?? 1;
  }

  const { notifySyncInvalidate } = await import('./sync-sse');
  await notifySyncInvalidate('harnessProjectFiles.byHarness', { harnessSlug: slug });
  return { version };
}
