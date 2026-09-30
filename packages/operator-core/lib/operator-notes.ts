/**
 * Operator-notes — feature-scoped guidance the user writes to steer a worker.
 *
 * Storage: **PG-canonical, file-on-demand** (refactored 2026-05-09).
 *   - Source of truth: `harness_shared.harness_feature_notes`
 *     (PG, migration 025). Compound key (workspace_id, harness_slug,
 *     feature_id) lets agents query "all notes for harness X" or "notes
 *     touching feature Y across all harnesses" cleanly.
 *   - File path `<projectDir>/.papercusp/notes/<featureId>.md` is no
 *     longer written by `appendOperatorNote`. It's materialized
 *     just-in-time by `materializeNoteToFile()` — the orchestrator
 *     calls this before spawning a worker/validator/debugger so the
 *     worker prompt's "read .papercusp/notes/<feature>.md if present"
 *     instruction still works. The file is a transient projection of
 *     PG, valid for the lifetime of one invocation.
 *
 * Architectural rule (see MEMORY_AND_CACHE.md): no PG↔FS mirror.
 * Persisted state is in PG; if a downstream tool needs a file, wrap
 * the PG read.
 *
 * Format mirrors `.papercusp/supervisor-notes.md`:
 *
 *   ## <author> <ISO-8601 timestamp>
 *
 *   <body, free-form markdown>
 *
 * Each block separated by a blank line. The `content` column holds the
 * full markdown body; reads return it verbatim alongside the parsed
 * block array.
 *
 * This is the Phase A "Steer" primitive — async guidance the worker reads on
 * its next dispatch. No new agent invocation; no new UI surface beyond a
 * write endpoint. Phase B (real-time chat) is a separate primitive.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql } from 'drizzle-orm';

import { loadHarnessRegistry } from './harness-registry';
import { activeWorkspaceId } from './workspace-registry';

const t = generated.harnessFeatureNotesInHarnessShared;

export interface OperatorNoteBlock {
  /** Author identifier — typically 'user' but could be a tool slug. */
  author: string;
  /** ISO-8601 timestamp when the block was written. */
  ts: string;
  /** Body content (unparsed markdown). */
  body: string;
}

export interface ReadOperatorNotesResult {
  /** Raw notes content (empty string if no row exists yet). */
  raw: string;
  /** Parsed blocks, oldest first. */
  blocks: OperatorNoteBlock[];
}

/** Resolve harness slug → project directory via the registry. */
export async function projectDirForSlug(slug: string, workspaceId?: string): Promise<string | null> {
  return (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug)?.path ?? null;
}

/**
 * Display path for the operator-notes UI (where the legacy file used to
 * live). Returned by the write endpoint so the UI can surface "stored as
 * <path>" without leaking the PG implementation. Pure path math; no I/O.
 */
export function notesPathFor(projectDir: string, featureId: string): string {
  return join(projectDir, '.papercusp', 'notes', `${featureId}.md`);
}

async function readNotesContent(slug: string, featureId: string): Promise<string | null> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ content: t.content })
    .from(t)
    .where(and(eq(t.workspaceId, ws), eq(t.harnessSlug, slug), eq(t.featureId, featureId)))
    .limit(1);
  return rows[0]?.content ?? null;
}

async function writeNotesContent(slug: string, featureId: string, content: string): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const now = Date.now();
  await db
    .insert(t)
    .values({ workspaceId: ws, harnessSlug: slug, featureId: featureId, content, updatedAt: now })
    .onConflictDoUpdate({
      target: [t.workspaceId, t.harnessSlug, t.featureId],
      set: { content: sql`EXCLUDED.content`, updatedAt: sql`EXCLUDED.updated_at` },
    });
}

/**
 * Append an operator note block to the (workspace, harness, feature) row.
 * Creates the row on first write. Returns the display path (kept for the
 * UI's "stored as" indicator) plus the timestamp of the new block.
 */
export async function appendOperatorNote(opts: {
  slug: string;
  featureId: string;
  content: string;
  author?: string;
}): Promise<{ path: string; ts: string } | { error: string }> {
  const { slug, featureId, content, author = 'user' } = opts;

  if (!content || !content.trim()) return { error: 'content is required' };
  if (!/^F-[A-Z0-9-]+$/i.test(featureId)) return { error: `invalid featureId: ${featureId}` };

  const projectDir = await projectDirForSlug(slug);
  if (!projectDir) return { error: `harness "${slug}" not registered` };

  const ts = new Date().toISOString();
  const existing = await readNotesContent(slug, featureId);

  // Block prefix gets a leading double-newline only if there's prior content;
  // avoids a double-blank-line at the start while keeping blocks separated.
  const prefix = existing ? '\n\n' : '';
  const block = `${prefix}## ${author} ${ts}\n\n${content.trim()}\n`;
  const merged = (existing ?? '') + block;

  await writeNotesContent(slug, featureId, merged);

  // No FS mirror — PG is canonical. The orchestrator materializes
  // `.papercusp/notes/<fid>.md` from PG just-in-time before each
  // worker/validator/debugger invocation; see materializeNoteToFile.
  const filePath = notesPathFor(projectDir, featureId);
  // SSE invalidate so other open tabs (and desktop clients on SSE
  // transport) refetch immediately. WS clients pick up the change via
  // logical replication automatically; the notify is harmless extra
  // PG NOTIFY traffic on that path.
  try {
    const { notifySyncInvalidate } = await import('./sync-sse');
    await notifySyncInvalidate('featureNotes.byHarness', { harnessSlug: slug });
  } catch { /* notify is best-effort */ }
  return { path: filePath, ts };
}

/**
 * Materialize the operator note for (slug, featureId) to its FS path.
 * Wraps a PG read — no file is created if the row is empty/absent.
 *
 * Called by the orchestrator at invoke time (worker/validator/debugger
 * roles) so the role prompt's "read .papercusp/notes/<fid>.md if present"
 * instruction sees fresh content sourced from PG.
 *
 * Best-effort: a write failure (read-only fs, disk full) does not throw;
 * the worker simply runs without the note file, which the prompt
 * already handles via "if present".
 */
export async function materializeNoteToFile(opts: {
  slug: string;
  featureId: string;
  projectDir: string;
}): Promise<{ written: boolean; path: string }> {
  const filePath = notesPathFor(opts.projectDir, opts.featureId);
  try {
    const content = await readNotesContent(opts.slug, opts.featureId);
    if (!content || !content.trim()) return { written: false, path: filePath };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return { written: true, path: filePath };
  } catch {
    return { written: false, path: filePath };
  }
}

/**
 * Parse a notes body into blocks. The header regex matches `## <author> <ISO ts>`
 * lines; bodies run from one header to the next. Returns blocks oldest first.
 */
export function parseNotes(raw: string): OperatorNoteBlock[] {
  const blocks: OperatorNoteBlock[] = [];
  if (!raw.trim()) return blocks;

  // Header: `## <author> <ISO timestamp>` at start of line.
  const headerRe = /^## (\S+) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*$/gm;
  const headers: { author: string; ts: string; bodyStart: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(raw)) !== null) {
    headers.push({
      author: m[1],
      ts: m[2],
      headerEnd: m.index + m[0].length,
      bodyStart: m.index + m[0].length,
    });
  }
  for (let i = 0; i < headers.length; i++) {
    const next = headers[i + 1];
    const start = headers[i].headerEnd;
    const end = next ? raw.indexOf(`## ${next.author} ${next.ts}`, start) : raw.length;
    blocks.push({
      author: headers[i].author,
      ts: headers[i].ts,
      body: raw.slice(start, end).trim(),
    });
  }
  return blocks;
}

/**
 * Read all operator notes for a feature. Reads PG first; if the on-disk
 * mirror has additional blocks the worker wrote directly via tool use,
 * pull those in too. Returns `{ raw: '', blocks: [] }` when neither
 * source has anything (not an error — feature simply has no notes).
 */
export async function readOperatorNotes(
  slug: string,
  featureId: string,
): Promise<ReadOperatorNotesResult | { error: string }> {
  if (!/^F-[A-Z0-9-]+$/i.test(featureId)) return { error: `invalid featureId: ${featureId}` };
  const projectDir = await projectDirForSlug(slug);
  if (!projectDir) return { error: `harness "${slug}" not registered` };

  const pgContent = await readNotesContent(slug, featureId);

  // Read the on-disk mirror too — if the worker appended blocks via
  // tool use, those won't be in PG. Best-effort.
  let fileContent: string | null = null;
  try {
    const { readFile } = await import('node:fs/promises');
    fileContent = await readFile(notesPathFor(projectDir, featureId), 'utf8');
  } catch {
    /* file missing — fine, PG is enough */
  }

  // Merge by block dedup on (author, ts) — file may have blocks PG
  // doesn't and vice versa. Most recent ts wins on collision.
  const pgBlocks = pgContent ? parseNotes(pgContent) : [];
  const fileBlocks = fileContent ? parseNotes(fileContent) : [];
  const byKey = new Map<string, OperatorNoteBlock>();
  for (const b of pgBlocks) byKey.set(`${b.author}\0${b.ts}`, b);
  for (const b of fileBlocks) byKey.set(`${b.author}\0${b.ts}`, b);
  const blocks = [...byKey.values()].sort((a, b) => a.ts.localeCompare(b.ts));

  if (blocks.length === 0) return { raw: '', blocks: [] };
  const raw = blocks.map((b) => `## ${b.author} ${b.ts}\n\n${b.body}\n`).join('\n');
  return { raw, blocks };
}
