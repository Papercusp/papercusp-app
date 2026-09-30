/**
 * Feature operator-notes — just-in-time PG → FS projection.
 *
 * Architectural rule (see docs/MEMORY_AND_CACHE.md): PG is canonical
 * for `harness_feature_notes`. The FS path `<stateDir>/notes/<fid>.md`
 * is a transient projection materialized right before a worker /
 * validator / debugger spawn so the role prompt's "read
 * .papercusp/notes/<feature>.md if present" instruction sees fresh
 * content. No mirror; no two-way sync.
 *
 * Operator UI writes to PG; this module reads PG; the file lives on
 * disk only as long as the next overwrite or external cleanup.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrchestratorPg } from './invoke';

export interface MaterializeNoteInput {
  pg?: OrchestratorPg;
  workspaceId?: string;
  harnessSlug: string;
  featureId: string;
  /** State directory (typically `<projectDir>/.papercusp`). */
  stateDir: string;
}

export interface MaterializeNoteResult {
  /** True if a file was written (PG row had non-empty content). */
  written: boolean;
  /** Absolute path of the target file (whether or not it was written). */
  path: string;
}

/**
 * Materialize the (workspace, slug, feature) note row to
 * `<stateDir>/notes/<fid>.md`. Best-effort: returns `written:false`
 * when the row is missing/empty OR when PG is unavailable. Never
 * throws — the worker prompt already says "if present" so a missing
 * file is functionally equivalent to "no notes."
 */
export async function materializeFeatureNote(
  input: MaterializeNoteInput,
): Promise<MaterializeNoteResult> {
  const filePath = join(input.stateDir, 'notes', `${input.featureId}.md`);
  if (!input.pg || !input.workspaceId) {
    return { written: false, path: filePath };
  }
  try {
    const rows = await input.pg<Array<{ content: string }>>`
      SELECT content
        FROM harness_shared.harness_feature_notes
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND feature_id = ${input.featureId}
       LIMIT 1
    `;
    const content = rows[0]?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { written: false, path: filePath };
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return { written: true, path: filePath };
  } catch {
    return { written: false, path: filePath };
  }
}
