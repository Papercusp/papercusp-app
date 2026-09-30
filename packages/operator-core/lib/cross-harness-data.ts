/**
 * Cross-harness supervisor-notes/recent-activity readers.
 *
 * Used by both the legacy /api/_hono/cross-harness routes and the
 * cross_harness:* MCP tools so they share one implementation.
 *
 * Supervisor notes live in `harness_<slug>.supervisor_notes`; cross-workspace
 * audit rows live in `harness_shared.audit_log` (workspace-scoped).
 *
 * (The former readInbox/readOutbox/MessageRow/ReadInboxOpts mail readers were
 * retired — plan retire-work-item-mail-surface-2026-07-26 P-002.)
 */

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

// A harness slug feeds a schema IDENTIFIER into `sql.unsafe` below (`${schema}.
// messages`), so it MUST be validated before interpolation — postgres-js does
// no escaping for `.unsafe` string concatenation. Harness slugs are [a-z0-9_-]
// (migration 044's `'harness_' || lower(replace(slug,'-','_'))`); the sibling
// agent-mcp `messages:inbox` tool guards the SAME vector with this regex (audit
// P-029). A dot would survive into the identifier (postgres-js splits dotted
// identifiers into qualified parts), so dots are rejected too.
const SLUG_RE = /^[a-z0-9_-]+$/i;

/**
 * Map a harness slug to its PG schema name (`harness_<lower-slug, hyphens→
 * underscores>`). Throws on a slug that isn't a single safe identifier segment
 * — the schema name is interpolated raw into `sql.unsafe`, so an unvalidated
 * slug would be a SQL-injection vector (mirrors `messages:inbox`'s guard).
 */
export function slugToSchema(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid harness slug ${JSON.stringify(slug)}`);
  }
  return 'harness_' + slug.replace(/-/g, '_').toLowerCase();
}

export interface SupervisorNoteRow {
  id: string;
  body: string;
  source: string | null;
  created_at: string;
}

export interface RecentActivityRow {
  ts: string;
  action: string;
  subject: string | null;
  actor: string | null;
}

export async function readSupervisorNotes(slug: string, limitRaw = 10): Promise<SupervisorNoteRow[]> {
  const limit = Math.min(Math.max(1, limitRaw), 100);
  const schema = slugToSchema(slug);
  const { sql } = getOrgPg();
  return (await sql.unsafe(
    `SELECT id, body, source, created_at
       FROM ${schema}.supervisor_notes
      ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )) as SupervisorNoteRow[];
}

export async function readRecentActivity(limitRaw = 20): Promise<RecentActivityRow[]> {
  const limit = Math.min(Math.max(1, limitRaw), 200);
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    return await tx<RecentActivityRow[]>`
      SELECT to_char(to_timestamp(ts / 1000.0), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS ts,
             action,
             subject,
             actor
        FROM harness_shared.audit_log
       ORDER BY ts DESC
       LIMIT ${limit}
    `;
  });
}
