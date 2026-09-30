/**
 * Debugger-output capture + just-in-time FS materialization.
 *
 * Architectural rule (see docs/MEMORY_AND_CACHE.md): PG is canonical
 * for `harness_feature_debug_notes`. The FS path
 * `<stateDir>/debug/<fid>.md` is a transient projection.
 *
 * The debugger role writes to that FS path directly via its prompt
 * (the role tells the agent to put findings there). We can't redirect
 * the agent's filesystem write at the prompt layer, so the flow is:
 *
 *   1. After `invoke debugger` returns, we read whatever the agent
 *      wrote at `<stateDir>/debug/<fid>.md` and UPSERT into PG.
 *      `captureDebuggerOutput()` does this.
 *   2. Before `invoke worker`/`invoke validator`/etc., we materialize
 *      from PG → FS so the next role's prompt-driven file read sees
 *      content sourced from PG. `materializeFeatureDebugNote()` does
 *      this. Mirrors the feature-notes.ts pattern exactly.
 *
 * This way PG owns the durable copy, and the FS file at any given
 * moment is either (a) freshly materialized from PG, (b) freshly
 * written by the debugger and captured to PG within the same invoke,
 * or (c) absent if neither has happened. Never stale-relative-to-PG.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrchestratorPg } from './invoke';

export interface DebugNoteContext {
  pg?: OrchestratorPg;
  workspaceId?: string;
  harnessSlug: string;
  featureId: string;
  /** State directory (typically `<projectDir>/.papercusp`). */
  stateDir: string;
}

/**
 * Read `<stateDir>/debug/<fid>.md` (whatever the debugger just wrote)
 * and UPSERT to `harness_shared.harness_feature_debug_notes`. PG row
 * becomes canonical from this point.
 *
 * Best-effort: if the file is absent (debugger didn't produce one) OR
 * the UPSERT fails (PG down), returns `{captured:false}` and the
 * caller proceeds. The bash run.sh comment block referenced an
 * `/api/internal/feature-debug-note-event` poster path that was never
 * built; this function is the in-process replacement for that intent.
 */
export async function captureDebuggerOutput(
  input: DebugNoteContext,
): Promise<{ captured: boolean; bytes: number }> {
  if (!input.pg || !input.workspaceId) return { captured: false, bytes: 0 };
  const filePath = join(input.stateDir, 'debug', `${input.featureId}.md`);
  if (!existsSync(filePath)) return { captured: false, bytes: 0 };
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return { captured: false, bytes: 0 };
  }
  if (!content.trim()) return { captured: false, bytes: 0 };
  try {
    const now = Date.now();
    await input.pg`
      INSERT INTO harness_shared.harness_feature_debug_notes
        (workspace_id, harness_slug, feature_id, content, mtime_ms)
      VALUES
        (${input.workspaceId}, ${input.harnessSlug}, ${input.featureId}, ${content}, ${now})
      ON CONFLICT (workspace_id, harness_slug, feature_id)
      DO UPDATE SET content = EXCLUDED.content, mtime_ms = EXCLUDED.mtime_ms
    `;
    return { captured: true, bytes: content.length };
  } catch {
    return { captured: false, bytes: 0 };
  }
}

/**
 * Materialize `harness_feature_debug_notes` row → `<stateDir>/debug/<fid>.md`.
 * Wraps a PG read; no file is written if the row is empty/absent.
 *
 * Called before worker/validator invocations so the role prompt's "read
 * .papercusp/debug/<fid>.md if present" instruction sees fresh content
 * sourced from PG. Best-effort.
 */
export async function materializeFeatureDebugNote(
  input: DebugNoteContext,
): Promise<{ written: boolean; path: string }> {
  const filePath = join(input.stateDir, 'debug', `${input.featureId}.md`);
  if (!input.pg || !input.workspaceId) {
    return { written: false, path: filePath };
  }
  try {
    const rows = await input.pg<Array<{ content: string }>>`
      SELECT content
        FROM harness_shared.harness_feature_debug_notes
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
