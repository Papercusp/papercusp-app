/**
 * `papercusp operator <subcmd>` — surface for the operator behavior layer.
 *
 * Subcommands:
 *   audit-prefs                     List preferences.md entries (numbered).
 *   audit-prefs --remove <N>        Drop the Nth entry (1-based).
 *   audit-prefs --filter <mode>     Restrict to user-typed | operator-proposed | all.
 *
 * Workspace selection: respects `--workspace <id>` flag. Defaults to the
 * `current` field of `~/.papercusp-workspaces/registry.json` (matches the
 * operator app's `activeWorkspaceId()` lookup).
 *
 * v1.5 deferred from operator-features-plan-v5 §4. Per-entry remove is also
 * available via `/settings/operator` UI; this CLI is for headless / scripted
 * audit (e.g. `papercusp operator audit-prefs --filter operator-proposed`
 * piped through grep).
 */
import { buildPgUrl, runQuery } from './pg-client.ts';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
// EI-18698602043482898: this file builds its OWN raw postgres() client (not
// the canonical getOrgPg()/getHarnessPg() — those go through buildClient,
// which already installs this fix). Without it, the RAW client's default
// jsonb serializer double-encodes `${JSON.stringify(x)}::jsonb` into a jsonb
// SCALAR STRING instead of the intended object — VERIFIED live against this
// exact function (savePrefs): jsonb_typeof came back 'string', not 'object',
// before this fix. See connection.ts's `restoreRawJsonbSerializer` doc for
// the full mechanism.
// eslint-disable-next-line import/no-relative-packages -- mirror the canonical client's postgres-js options without pulling in drizzle-orm
import { restoreRawJsonbSerializer } from '../../../libs/db/src/raw-serializers.ts';

interface RegistryShape {
  current?: string;
  workspaces?: { id: string }[];
}

/**
 * Resolve the workspaces root (`~/.papercusp-workspaces`), honoring
 * `PAPERCUSP_WORKSPACES_ROOT` before falling back to `homedir()`.
 *
 * Spawned CLI children can run with `HOME` remapped to a per-workspace dir
 * (P-051); a bare `homedir()` there resolves to a NESTED registry that
 * disagrees with the real one (agent-insights/workspaces-root-vs-remapped-home).
 * Mirrors `workspacesRoot()` in `@papercusp/operator-core`'s
 * `workspace-registry.ts` (kept local to avoid pulling in that module graph).
 */
function workspacesRootDir(): string {
  const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
  if (env && env.trim()) return env;
  return join(homedir(), '.papercusp-workspaces');
}

async function activeWorkspaceId(): Promise<string> {
  try {
    const raw = await fs.readFile(join(workspacesRootDir(), 'registry.json'), 'utf8');
    const reg = JSON.parse(raw) as RegistryShape;
    if (typeof reg.current === 'string' && reg.current) return reg.current;
  } catch { /* fallthrough */ }
  return 'default';
}

function adminUrl(): string {
  return process.env.HARNESS_ADMIN_DATABASE_URL
    ?? buildPgUrl({
      user: 'harness_admin',
      password: 'harness_admin_pwd',
      database: 'papercusp',
    });
}

interface PrefEntry {
  index: number; // 1-based
  date: string;  // ## YYYY-MM-DD section header
  body: string;  // raw line(s) of this entry
  tags: string[];
  isUserTyped: boolean;
  isOperatorProposed: boolean;
}

function parseEntries(markdown: string): PrefEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: PrefEntry[] = [];
  let currentDate = '';
  let buffer: string[] = [];
  const flush = () => {
    while (buffer.length > 0 && buffer[buffer.length - 1].trim() === '') buffer.pop();
    if (buffer.length === 0) return;
    const body = buffer.join('\n');
    const tags = Array.from(body.matchAll(/\[([A-Z][A-Z0-9_-]+(?:-\d{4}-\d{2}-\d{2})?)\]/g)).map((m) => m[1]);
    entries.push({
      index: entries.length + 1,
      date: currentDate,
      body,
      tags,
      isUserTyped: tags.some((t) => t === 'USER-TYPED'),
      isOperatorProposed: tags.some((t) => t.startsWith('OPERATOR-PROPOSED')),
    });
    buffer = [];
  };
  for (const line of lines) {
    const headerMatch = /^## (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (headerMatch) {
      flush();
      currentDate = headerMatch[1];
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      buffer.push(line);
    } else if (buffer.length > 0) {
      // continuation (indented sub-bullets, wrapped lines)
      buffer.push(line);
    }
  }
  flush();
  return entries;
}

function renderEntries(entries: PrefEntry[]): string {
  if (entries.length === 0) return '(no preference entries)\n';
  const out: string[] = [];
  for (const e of entries) {
    const provenance = e.isUserTyped ? 'user' : e.isOperatorProposed ? 'operator' : '?';
    out.push(`[${String(e.index).padStart(3, ' ')}] (${e.date}) <${provenance}>`);
    for (const ln of e.body.split('\n')) out.push(`        ${ln}`);
    out.push('');
  }
  return out.join('\n');
}

async function loadPrefs(workspaceId: string): Promise<string> {
  const rows = await runQuery<{ payload: { content?: string } }>(
    adminUrl(),
    `SELECT payload FROM harness_shared.operator_preferences WHERE workspace_id = '${workspaceId.replace(/'/g, "''")}'`,
  );
  if (!rows || rows.length === 0) return '';
  const p = rows[0].payload;
  return typeof p?.content === 'string' ? p.content : '';
}

async function savePrefs(workspaceId: string, content: string): Promise<void> {
  // Bind jsonb as `${JSON.stringify(x)}::jsonb`: the ::jsonb cast runs server-side, so it
  // yields a real jsonb OBJECT — NOT a jsonb string — under getOrgPg's drizzle-mutated
  // serializer, and it is portable to the getOrgPg client where sql.json() throws
  // (EI-607). NOT sql.json(), NOT a bare `${obj}`. But THIS client is a raw, un-mutated
  // `postgres()` instance (not getOrgPg), so it needs `restoreRawJsonbSerializer` applied
  // explicitly — without it this double-encodes into a jsonb SCALAR STRING instead of an
  // object (EI-18698602043482898, verified live against this exact function).
  const sql = postgres(adminUrl(), { max: 1, idle_timeout: 1, prepare: false, onnotice: () => {} });
  restoreRawJsonbSerializer(sql);
  try {
    await sql`
      INSERT INTO harness_shared.operator_preferences (workspace_id, payload, updated_at)
      VALUES (${workspaceId}, ${JSON.stringify({ content })}::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
    `;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

function rebuildMarkdown(entries: PrefEntry[]): string {
  const out: string[] = [];
  let lastDate = '';
  for (const e of entries) {
    if (e.date !== lastDate) {
      if (out.length > 0) out.push('');
      out.push(`## ${e.date}`);
      lastDate = e.date;
    }
    out.push(e.body);
  }
  return out.join('\n') + '\n';
}

export async function cmdOperator(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write([
      'Usage: papercusp operator <subcommand>',
      '',
      'Subcommands:',
      '  audit-prefs                     List preferences entries.',
      '  audit-prefs --remove <N>        Drop the Nth entry.',
      '  audit-prefs --filter <mode>     Restrict to user-typed | operator-proposed | all.',
      '  audit-prefs --workspace <id>    Override the active workspace.',
      '',
    ].join('\n'));
    return;
  }
  if (sub !== 'audit-prefs') {
    process.stderr.write(`unknown operator subcommand: ${sub}\n`);
    process.exit(2);
  }

  let removeAt: number | null = null;
  let filter: 'all' | 'user-typed' | 'operator-proposed' = 'all';
  let workspaceOverride: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remove') { removeAt = Number(argv[++i]); continue; }
    if (a === '--filter') {
      const v = argv[++i];
      if (v !== 'all' && v !== 'user-typed' && v !== 'operator-proposed') {
        process.stderr.write(`--filter must be one of: all | user-typed | operator-proposed\n`);
        process.exit(2);
      }
      filter = v;
      continue;
    }
    if (a === '--workspace') { workspaceOverride = argv[++i]; continue; }
    process.stderr.write(`unknown flag: ${a}\n`);
    process.exit(2);
  }

  const workspaceId = workspaceOverride ?? await activeWorkspaceId();
  const markdown = await loadPrefs(workspaceId);
  const all = parseEntries(markdown);

  if (removeAt !== null) {
    if (!Number.isInteger(removeAt) || removeAt < 1 || removeAt > all.length) {
      process.stderr.write(`--remove ${removeAt}: out of range (have ${all.length} entries)\n`);
      process.exit(2);
    }
    const removed = all[removeAt - 1];
    const remaining = all.filter((e) => e.index !== removeAt);
    await savePrefs(workspaceId, rebuildMarkdown(remaining));
    process.stdout.write(`removed entry ${removeAt}:\n${removed.body}\n`);
    return;
  }

  const view = all.filter((e) => {
    if (filter === 'user-typed') return e.isUserTyped;
    if (filter === 'operator-proposed') return e.isOperatorProposed;
    return true;
  });
  process.stdout.write(`workspace=${workspaceId} entries=${view.length}/${all.length} filter=${filter}\n\n`);
  process.stdout.write(renderEntries(view));
}
