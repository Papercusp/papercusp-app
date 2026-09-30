/**
 * saved-prompts-projection.ts — the pure PG-row → on-disk command-file
 * layer for cross-client saved prompts (plan saved-prompts-cross-client).
 *
 * Renders a saved prompt into the file format each client reads, and
 * writes / removes those files behind a managed-marker guard so a user's
 * hand-authored command is never clobbered. Filesystem-only: no PG, no
 * transport awareness — the store (saved-prompts-store) and the launch
 * path compose these primitives.
 *
 * Two formats cover all three clients (D-002):
 *   - Claude / OMP → `.claude/commands/<name>.md`. OMP reads Claude
 *     commands natively (`omp config`: commands.enableClaudeUser/Project).
 *   - Codex → `$CODEX_HOME/prompts/<name>.md` — plain body, filename = command.
 *
 * Server-only.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The subset of a `saved_prompts` row the projector needs to render a file. */
export interface ProjectablePrompt {
  name: string;
  body: string;
  description?: string | null;
  argHint?: string | null;
  /** Archived (outline-deleted) rows never materialize; their files get pruned. */
  archivedAt?: string | null;
}

/**
 * Marker stamped into every file we own. The overwrite + prune guards key
 * on it: a same-named file lacking the marker is treated as hand-authored
 * and never touched (D-006).
 */
export const MANAGED_MARKER = '<!-- papercusp:managed -->';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A saved-prompt name is the slash command (`/name`): strict slug, no dots/slashes. */
export function validatePromptName(name: string): boolean {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** Render the Claude/OMP command file: optional YAML frontmatter, marker, body. */
export function renderClaudeCommand(p: ProjectablePrompt): string {
  const fm: string[] = [];
  if (p.description) fm.push(`description: ${p.description}`);
  if (p.argHint) fm.push(`argument-hint: ${p.argHint}`);
  const head = fm.length ? `---\n${fm.join('\n')}\n---\n` : '';
  const body = p.body.endsWith('\n') ? p.body : `${p.body}\n`;
  return `${head}${MANAGED_MARKER}\n${body}`;
}

/** Render the Codex prompt file: marked plain markdown, no frontmatter. */
export function renderCodexPrompt(p: ProjectablePrompt): string {
  const body = p.body.endsWith('\n') ? p.body : `${p.body}\n`;
  return `${MANAGED_MARKER}\n${body}`;
}

function isManaged(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}

export interface WriteResult {
  written: boolean;
  reason?: 'unmanaged_exists';
}

/** Write a command file, refusing to clobber an existing UNmanaged file. */
export function writeManagedCommandFile(
  dir: string,
  filename: string,
  contents: string,
): WriteResult {
  const path = join(dir, filename);
  if (existsSync(path) && !isManaged(path)) {
    return { written: false, reason: 'unmanaged_exists' };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, contents, { mode: 0o644 });
  return { written: true };
}

export interface RemoveResult {
  removed: boolean;
}

/** Remove a command file only if it is one we own (carries the marker). */
export function removeManagedCommandFile(dir: string, filename: string): RemoveResult {
  const path = join(dir, filename);
  if (!existsSync(path) || !isManaged(path)) return { removed: false };
  rmSync(path, { force: true });
  return { removed: true };
}

/** Remove managed `*.md` files whose basename isn't in `keep`; leave unmanaged + kept. */
export function pruneManagedCommands(dir: string, keep: Set<string>): { removed: string[] } {
  if (!existsSync(dir)) return { removed: [] };
  const removed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const base = entry.slice(0, -3);
    if (keep.has(base)) continue;
    const path = join(dir, entry);
    if (!isManaged(path)) continue;
    rmSync(path, { force: true });
    removed.push(base);
  }
  return { removed };
}

export interface MaterializeResult {
  written: number;
  skipped: number;
}

/**
 * Render `prompts` with `render` and write each into `dir`, then prune our
 * stale managed files. Rows with an invalid name are skipped (counted), as
 * are unmanaged-file collisions. The full set of valid names is the keep-set
 * for pruning, so a removed/renamed prompt's file is cleaned up.
 */
function writeCommands(
  dir: string,
  prompts: readonly ProjectablePrompt[],
  render: (p: ProjectablePrompt) => string,
): MaterializeResult {
  let written = 0;
  let skipped = 0;
  const keep = new Set<string>();
  for (const p of prompts) {
    if (!validatePromptName(p.name)) {
      skipped++;
      continue;
    }
    // Pure FOLDER nodes (empty body — Quick Panel outline organizer rows,
    // migration 598) never materialize as slash commands. Deliberately NOT
    // added to the keep-set: a prompt emptied into a folder gets its stale
    // managed file pruned. ARCHIVED rows (outline delete, WI-4840 D-004) are
    // treated the same way — skipped and pruned, so an archived prompt's
    // slash command disappears with it and an unarchive brings it back.
    if (p.body.trim().length === 0 || (p.archivedAt !== undefined && p.archivedAt !== null)) {
      skipped++;
      continue;
    }
    keep.add(p.name);
    const res = writeManagedCommandFile(dir, `${p.name}.md`, render(p));
    if (res.written) written++;
    else skipped++;
  }
  pruneManagedCommands(dir, keep);
  return { written, skipped };
}

/** Materialize the Claude/OMP command files for a scope's prompts into `dir`. */
export function writeClaudeCommands(dir: string, prompts: readonly ProjectablePrompt[]): MaterializeResult {
  return writeCommands(dir, prompts, renderClaudeCommand);
}

/** Materialize the Codex prompt files for a scope's prompts into `dir`. */
export function writeCodexPrompts(dir: string, prompts: readonly ProjectablePrompt[]): MaterializeResult {
  return writeCommands(dir, prompts, renderCodexPrompt);
}
