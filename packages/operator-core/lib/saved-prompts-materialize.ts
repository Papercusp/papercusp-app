/**
 * saved-prompts-materialize.ts — compose the store (PG rows) with the
 * projector (on-disk files) for the two scopes, resolving the per-client
 * target directories.
 *
 * - Claude/OMP: workspace prompts → `<workspace HOME>/.claude/commands`,
 *   harness prompts → `<harness repo>/.claude/commands`. OMP reads both
 *   natively (D-002); the harness dir is committed (D-003).
 * - Codex: a flat `<$CODEX_HOME>/prompts` dir written per session (Phase 4);
 *   harness prompts overlay workspace prompts (harness wins a name clash).
 *
 * The PG-composing functions default the `sql` handle to `getOrgPg()`, so a
 * caller passes only ids; tests inject `sql` + `dir`. The workspace-HOME
 * resolution is the launcher's `$HOME` (P-012) — verify the desktop remap.
 *
 * Server-only.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listSavedPrompts } from './saved-prompts-store';
import { writeClaudeCommands, writeCodexPrompts, type MaterializeResult } from './saved-prompts-projection';
import { resolveProjectDir } from './spawn-config';

function db(sql?: postgres.Sql): postgres.Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * The HOME the launched client uses, under which `.claude/` lives.
 *
 * P-012: the launchers (console-launch / bootstrap-role|su) set `PAPERCUSP_HOME`
 * but do NOT remap the child's unix `$HOME`, so the client inherits the
 * operator's HOME — `os.homedir()`. On the desktop product the operator's HOME
 * IS the per-workspace dir (`~/.papercusp-workspaces/<id>`), so this resolves
 * to the "workspace folder"; on a dev box it is the real home, which is also
 * where the user's ambient `claude` reads user-scope commands. Either way it is
 * the directory the client actually reads, which is the only thing that makes
 * the prompt invokable. (If a launcher ever remaps the child HOME per-workspace,
 * this resolver must change to match it.)
 */
export function workspaceHomeDir(): string {
  return homedir();
}

/** `<HOME>/.claude/commands` — Claude user scope + OMP user scope. */
export function workspaceCommandsDir(): string {
  return join(workspaceHomeDir(), '.claude', 'commands');
}

/** `<harness repo>/.claude/commands` — Claude/OMP project scope. Null if unregistered. */
export async function harnessCommandsDir(workspaceId: string, slug: string): Promise<string | null> {
  const projectDir = await resolveProjectDir(slug, workspaceId);
  return projectDir ? join(projectDir, '.claude', 'commands') : null;
}

export interface MaterializeOpts {
  sql?: postgres.Sql;
  /** Override the resolved target dir (tests). */
  dir?: string;
}

/** Project the workspace-global prompts to the workspace HOME's Claude/OMP commands dir. */
export async function materializeWorkspacePrompts(
  workspaceId: string,
  opts: MaterializeOpts = {},
): Promise<MaterializeResult> {
  const rows = await listSavedPrompts(db(opts.sql), workspaceId, { kind: 'workspace' });
  return writeClaudeCommands(opts.dir ?? workspaceCommandsDir(), rows);
}

/** Project a harness's prompts to its repo's Claude/OMP commands dir (committed). */
export async function materializeHarnessPrompts(
  workspaceId: string,
  slug: string,
  opts: MaterializeOpts = {},
): Promise<MaterializeResult> {
  const dir = opts.dir ?? (await harnessCommandsDir(workspaceId, slug));
  if (!dir) return { written: 0, skipped: 0 };
  const rows = await listSavedPrompts(db(opts.sql), workspaceId, { kind: 'harness', slug });
  return writeClaudeCommands(dir, rows);
}

/**
 * Write a session's saved prompts into a Codex home's flat `prompts/` dir:
 * the workspace-global prompts always, plus the harness's when the session is
 * harness-scoped. Harness prompts overlay workspace prompts on a name clash
 * (written last → win the file). Called from writeRoleCodexHome /
 * writeSuCodexHome at launch (Phase 4).
 */
export async function materializeCodexPrompts(
  codexHome: string,
  workspaceId: string,
  slug: string | null,
  opts: { sql?: postgres.Sql } = {},
): Promise<MaterializeResult> {
  const sql = db(opts.sql);
  const workspace = await listSavedPrompts(sql, workspaceId, { kind: 'workspace' });
  const harness = slug ? await listSavedPrompts(sql, workspaceId, { kind: 'harness', slug }) : [];
  return writeCodexPrompts(join(codexHome, 'prompts'), [...workspace, ...harness]);
}
