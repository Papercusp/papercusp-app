/**
 * PG-canonical text artifacts (Migration 035, Phase 2).
 *
 * Reads/writes for free-form text files keyed (harness_slug, rel_path).
 * The on-disk files at `<harness_dir>/.papercusp/<rel_path>` are written
 * as best-effort mirrors on each save so tools running INSIDE the
 * harness process (orchestrator, workers, plugin scripts) see the same
 * content. PG remains canonical.
 *
 * The orchestrator's role-prompt + snapshot-state read these files
 * directly: supervisor-notes.md, issues.md, memory/*.md, prompts/*.md,
 * etc. If a write only lands in PG and never on disk, the operator UI
 * reads it via loadTextArtifact but the orchestrator/worker is blind
 * to it (verified at round 18: PG=146986b vs file=148628b drift on
 * sheets/issues.md after operator-side edits).
 *
 * Path normalization: PG keys are relative-to-harness-dir (no leading
 * `.papercusp/`). Some callers pass paths with `.papercusp/` prefix (e.g. the
 * memory-file UI uses MEMORY_MAP entries that include the prefix); those
 * get stripped here so reads/writes always hit the same row. Disk path
 * always restores `<harness_dir>/.papercusp/<key>`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getOrgPg, generated, typedSql } from '@papercusp/db-org';
import { and, eq, sql } from 'drizzle-orm';

const t = generated.harnessTextArtifactsInHarnessShared;
import { loadHarnessRegistry } from './harness-registry';
import { notifySyncInvalidate } from './sync-sse';
import { activeWorkspaceId } from './workspace-registry';

/**
 * workspace_id stamp for operator-side writes (EI-280): this lib runs on the
 * admin handle (RLS-bypass), so without an explicit stamp every insert minted
 * a blank-workspace row — invisible to the RLS-scoped artifacts:* agent tools
 * and a poison pill for their upserts. Stamp the operator's active workspace;
 * on conflict, adopt a blank-stamped legacy row (never re-home a properly
 * stamped one).
 */
const adoptBlankWorkspace = sql`CASE WHEN ${t.workspaceId} = '' THEN EXCLUDED.workspace_id ELSE ${t.workspaceId} END`;

function normalizeRelPath(rel: string): string {
  // Drop leading `.papercusp/` so the PG key is consistent with the bare
  // relative-to-harness-dir convention.
  return rel.replace(/^\.papercusp\//, '');
}

async function notifyTextArtifactChange(slug: string, _key: string): Promise<void> {
  // Generic invalidation — clients subscribed to harnessTextArtifact.byHarness
  // refetch. The query returns all rows for the slug, so per-relPath args
  // would be ignored. (Renamed from byHarnessAndPath in the eager-fetch arc.)
  await notifySyncInvalidate('harnessTextArtifact.byHarness', {
    harnessSlug: slug,
  });
}

/** Resolve `<harness_dir>/.papercusp/<rel_path>` for the given slug. Returns
 *  null when the harness isn't in the registry (operator-side write to a
 *  not-yet-registered harness — ignore the disk mirror in that case). */
async function diskPathFor(slug: string, key: string): Promise<string | null> {
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return null;
  return join(project.path, '.papercusp', key);
}

/** Best-effort mirror to disk. PG row is canonical; disk is for the
 *  orchestrator/worker process to read via `<harness_dir>/.papercusp/<rel>`. */
async function mirrorToDisk(slug: string, key: string, content: string): Promise<void> {
  try {
    const path = await diskPathFor(slug, key);
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  } catch {
    /* file write failed — PG already won; orchestrator will see stale on
     *  disk until next write. Acceptable for V1; the alternative (failing
     *  the PG write) trades a worse failure mode (silent UI loss). */
  }
}

export async function loadTextArtifact(slug: string, relPath: string): Promise<string | null> {
  const key = normalizeRelPath(relPath);
  const { db } = getOrgPg();
  const rows = await db
    .select({ content: t.content })
    .from(t)
    .where(and(eq(t.harnessSlug, slug), eq(t.relPath, key)))
    .limit(1);
  return rows[0]?.content ?? null;
}

export interface SaveTextArtifactOpts {
  /** Override the disk mirror path. Default: `<project.path>/.papercusp/<rel_path>`.
   *  Use for files whose canonical disk location is NOT under .papercusp/ —
   *  e.g. .mcp.json at project root, .claude/settings.json. The PG row is
   *  always keyed by the rel_path passed in, regardless of disk location. */
  customDiskPath?: string;
}

export async function saveTextArtifact(slug: string, relPath: string, content: string, opts: SaveTextArtifactOpts = {}): Promise<void> {
  const key = normalizeRelPath(relPath);
  const { db } = getOrgPg();
  const now = Date.now();
  await db
    .insert(t)
    .values({ harnessSlug: slug, relPath: key, content, updatedAt: now, workspaceId: activeWorkspaceId() })
    .onConflictDoUpdate({
      target: [t.harnessSlug, t.relPath],
      set: {
        content: sql`EXCLUDED.content`,
        updatedAt: sql`EXCLUDED.updated_at`,
        workspaceId: adoptBlankWorkspace,
      },
    });
  if (opts.customDiskPath) {
    try {
      await mkdir(dirname(opts.customDiskPath), { recursive: true });
      await writeFile(opts.customDiskPath, content, 'utf8');
    } catch { /* mirror best-effort */ }
  } else {
    await mirrorToDisk(slug, key, content);
  }
  await notifyTextArtifactChange(slug, key);
}

export async function appendTextArtifact(slug: string, relPath: string, suffix: string): Promise<void> {
  const key = normalizeRelPath(relPath);
  const { db } = getOrgPg();
  const now = Date.now();
  // PG-side `||` concat keeps the append atomic. Drizzle's `set` accepts
  // raw sql snippets for cases the query-builder can't express cleanly.
  // RETURNING comes back typed via .returning({ content }).
  const rows = await db
    .insert(t)
    .values({ harnessSlug: slug, relPath: key, content: suffix, updatedAt: now, workspaceId: activeWorkspaceId() })
    .onConflictDoUpdate({
      target: [t.harnessSlug, t.relPath],
      set: {
        content: sql`${t.content} || EXCLUDED.content`,
        updatedAt: sql`EXCLUDED.updated_at`,
        workspaceId: adoptBlankWorkspace,
      },
    })
    .returning({ content: t.content });
  const merged = rows[0]?.content ?? suffix;
  await mirrorToDisk(slug, key, merged);
  await notifyTextArtifactChange(slug, key);
}

export async function deleteTextArtifact(slug: string, relPath: string): Promise<void> {
  const key = normalizeRelPath(relPath);
  const { db } = getOrgPg();
  await db.delete(t).where(and(eq(t.harnessSlug, slug), eq(t.relPath, key)));
  // Don't unlink the file — the harness contract may have a different
  // process (orchestrator, harness-CLI) treating the file as primary. A
  // PG delete from the operator UI just stops mirroring; the file stays
  // until something else removes it.
  await notifyTextArtifactChange(slug, key);
}
