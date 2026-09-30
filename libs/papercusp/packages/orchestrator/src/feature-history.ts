/**
 * Feature history block — composed for prompt injection (Phase 1) and
 * MCP-tool exposure (`features:history`, Phase 4a).
 *
 * Read path is **PG-only by design** (architecture principle: PG is
 * canonical; do not mirror to FS for read paths). The mirror writes
 * that exist today in `apps/operator/lib/operator-notes.ts` are legacy
 * — this module deliberately ignores the FS files and reads PG.
 *
 * Sources:
 *   - `harness_shared.harness_feature_notes` — operator-supplied notes
 *     keyed by (workspace_id, harness_slug, feature_id). Single mutable
 *     `content` column. Updated_at for freshness.
 *   - `harness_shared.harness_feature_debug_notes` — debugger-role
 *     findings, single mutable `content` per feature.
 *   - `harness_shared.feature_audit_consolidated` — append-only log of
 *     status / attempt transitions.
 *
 * Token budget: hard caps per section (notes 4k, debug 4k, audit 10
 * rows ≈ 1.5k). Empty sections are silently skipped so the rendered
 * block stays compact when there's no history yet.
 *
 * Cache-invalidation discipline: the rendered block changes per
 * (feature, turn). It MUST live in the trailing volatile section of
 * the prompt (after runtime context), never before the cacheable
 * preamble. See `prompt-build.ts` for ordering.
 */
import type { OrchestratorPg } from './invoke';

export interface FeatureHistoryInput {
  /** PG handle. Returns '' if undefined. */
  pg?: OrchestratorPg;
  /** Workspace scope. Returns '' if undefined. */
  workspaceId?: string;
  /** Harness slug — schema is harness_<slug-with-underscores>. */
  harnessSlug: string;
  /** Feature ID like F-AUTH-001. */
  featureId: string;
  /** Per-section character caps. Defaults: notes 4000, debug 4000. */
  notesMaxChars?: number;
  debugMaxChars?: number;
  /** Last N audit rows. Default 10. */
  auditRows?: number;
  /** Max related features (tag-overlap or in see_also). Default 5. */
  relatedMax?: number;
  /** Pending feature-addressed messages cap. Default 10. */
  messagesMax?: number;
}

interface AuditRow {
  ts: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
}

/**
 * Render a markdown block summarizing the feature's current state +
 * recent activity. Empty string when no PG handle is available or no
 * data is found — caller is responsible for omitting the section
 * header in that case.
 */
export async function fetchFeatureHistory(input: FeatureHistoryInput): Promise<string> {
  if (!input.pg || !input.workspaceId) return '';
  const notesMax = input.notesMaxChars ?? 4000;
  const debugMax = input.debugMaxChars ?? 4000;
  const auditRows = input.auditRows ?? 10;
  const relatedMax = input.relatedMax ?? 5;
  const messagesMax = input.messagesMax ?? 10;

  const pg = input.pg;
  const ws = input.workspaceId;
  const slug = input.harnessSlug;
  const fid = input.featureId;
  // Per-harness messages live in `harness_<slug-with-underscores>.messages`.
  // Build the schema-qualified table reference outside the parallel set
  // so the Promise.all read keeps a uniform shape.
  const msgSchema = `harness_${slug.replace(/-/g, '_')}`;

  // Independent reads in parallel — none should block the others.
  const [notesRow, debugRow, auditList, related, messages] = await Promise.all([
    pg`
      SELECT content, updated_at
        FROM harness_shared.harness_feature_notes
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND feature_id = ${fid}
       LIMIT 1
    `.catch(() => [] as Array<{ content: string; updated_at: number }>),
    pg`
      SELECT content, mtime_ms
        FROM harness_shared.harness_feature_debug_notes
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND feature_id = ${fid}
       LIMIT 1
    `.catch(() => [] as Array<{ content: string; mtime_ms: number }>),
    pg`
      SELECT ts, field, old_value, new_value, actor
        FROM harness_shared.feature_audit_consolidated
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND feature_id = ${fid}
       ORDER BY ts DESC
       LIMIT ${auditRows}
    `.catch(() => [] as AuditRow[]),
    // Related features: union of tag-overlap and see_also expansion.
    // Single CTE-style query so we get one round-trip. Self-excluded.
    fetchRelatedFeatures(pg, slug, fid, relatedMax)
      .catch(() => [] as RelatedRow[]),
    // Pending feature-addressed messages. Schema reference is built
    // dynamically (slug-with-underscores) — postgres-js doesn't accept
    // a tagged-template parameter for table names, so we use unsafe
    // for the table identifier. Slug regex was validated by callers
    // upstream (state.ts), so the schema name is safe.
    fetchFeatureMessages(pg, msgSchema, fid, messagesMax)
      .catch(() => [] as FeatureMessageRow[]),
  ]);

  const sections: string[] = [];

  if (notesRow.length > 0 && typeof notesRow[0].content === 'string' && notesRow[0].content.trim().length > 0) {
    sections.push('### Notes');
    sections.push(truncate(notesRow[0].content, notesMax));
  }

  if (debugRow.length > 0 && typeof debugRow[0].content === 'string' && debugRow[0].content.trim().length > 0) {
    sections.push('### Debugger findings');
    sections.push(truncate(debugRow[0].content, debugMax));
  }

  if (auditList.length > 0) {
    sections.push('### Recent activity');
    for (const row of auditList as AuditRow[]) {
      sections.push(formatAuditRow(row));
    }
  }

  if (related.length > 0) {
    sections.push('### Related features');
    for (const row of related as RelatedRow[]) {
      sections.push(formatRelatedRow(row));
    }
  }

  if (messages.length > 0) {
    sections.push('### Messages from other features');
    for (const row of messages as FeatureMessageRow[]) {
      sections.push(formatMessageRow(row));
    }
  }

  if (sections.length === 0) return '';

  // Header with feature ID so the LLM can refer back to it unambiguously.
  return [`## This feature's history (${fid})`, ...sections].join('\n');
}

interface RelatedRow {
  feature_id: string;
  title: string;
  status: string;
  tags: string[] | null;
  relation_kind: 'tag' | 'see_also' | 'both';
}

async function fetchRelatedFeatures(
  pg: OrchestratorPg,
  slug: string,
  fid: string,
  limit: number,
): Promise<RelatedRow[]> {
  // First read the source feature's tags + see_also.
  const src = await pg<Array<{ tags: unknown; see_also: string[] | null }>>`
    SELECT tags, see_also
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${fid}
     LIMIT 1
  `;
  if (src.length === 0) return [];
  const srcTags: string[] = Array.isArray(src[0].tags)
    ? (src[0].tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  const srcSeeAlso: string[] = Array.isArray(src[0].see_also) ? src[0].see_also : [];
  if (srcTags.length === 0 && srcSeeAlso.length === 0) return [];

  return pg<RelatedRow[]>`
    SELECT feature_id, title, status,
           (SELECT array_agg(value) FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb))) AS tags,
           CASE
             WHEN feature_id = ANY(${srcSeeAlso}::text[]) AND tags ?| ${srcTags}::text[] THEN 'both'
             WHEN feature_id = ANY(${srcSeeAlso}::text[]) THEN 'see_also'
             ELSE 'tag'
           END AS relation_kind
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug}
       AND feature_id <> ${fid}
       AND (
         feature_id = ANY(${srcSeeAlso}::text[])
         OR (${srcTags.length > 0}::boolean AND tags ?| ${srcTags}::text[])
       )
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT ${limit}
  `;
}

function formatRelatedRow(row: RelatedRow): string {
  const tags = (row.tags ?? []).join(', ');
  const tagPart = tags ? ` [${tags}]` : '';
  const relPart = row.relation_kind === 'both'
    ? ' (tag+see-also)'
    : row.relation_kind === 'see_also'
    ? ' (see-also)'
    : ' (tag)';
  return `- \`${row.feature_id}\` (${row.status})${tagPart} — ${row.title}${relPart}`;
}

interface FeatureMessageRow {
  id: string;
  created_at: Date | string | number;
  from_slug: string;
  from_feature_id: string | null;
  kind: string;
  subject: string;
  body: string | null;
}

async function fetchFeatureMessages(
  pg: OrchestratorPg,
  schema: string,
  toFeatureId: string,
  limit: number,
): Promise<FeatureMessageRow[]> {
  // Identifier is a per-harness schema; slug was already normalized to
  // [a-z0-9_-] by upstream callers (state.harnessSlug). The pg-js
  // tagged template doesn't bind identifiers, so we string-build the
  // schema portion. Status filter restricted to 'pending' so dismissed
  // ('archived') messages drop out of the prompt automatically.
  const sql = `
    SELECT id, created_at, from_slug, from_feature_id, kind, subject, body
      FROM ${schema}.messages
     WHERE to_feature_id = $1
       AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT $2
  `;
  // postgres-js exposes `unsafe` on the tagged-template fn for raw
  // queries with positional params. The OrchestratorPg type only
  // promises the tagged-template signature, so we widen here.
  const pgAny = pg as unknown as { unsafe: (q: string, p?: unknown[]) => Promise<FeatureMessageRow[]> };
  if (typeof pgAny.unsafe !== 'function') return [];
  return pgAny.unsafe(sql, [toFeatureId, limit]);
}

function formatMessageRow(row: FeatureMessageRow): string {
  const ts = typeof row.created_at === 'string' || typeof row.created_at === 'number'
    ? new Date(row.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z')
    : row.created_at instanceof Date
    ? row.created_at.toISOString().replace(/\.\d{3}Z$/, 'Z')
    : String(row.created_at);
  const from = row.from_feature_id
    ? `${row.from_slug}/${row.from_feature_id}`
    : row.from_slug;
  // Body trimmed to ~400 chars per message so a flood doesn't blow the
  // 3k cap. Full body is reachable via messages:feature_inbox MCP tool.
  const body = (row.body ?? '').slice(0, 400);
  return `- ${ts} from \`${from}\` [${row.kind}] **${row.subject}**\n  ${body}`;
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n\n[…truncated, exceeded ' + maxChars + ' chars]';
}

/** Format one audit row as a markdown bullet. Compact: `- <iso> <field>: <old> → <new> (actor)`. */
function formatAuditRow(row: AuditRow): string {
  const iso = new Date(Number(row.ts)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const oldS = renderAuditValue(row.old_value);
  const newS = renderAuditValue(row.new_value);
  const arrow = oldS === '' ? `→ ${newS}` : `${oldS} → ${newS}`;
  return `- ${iso} \`${row.field}\` ${arrow} (${row.actor})`;
}

function renderAuditValue(v: string | null): string {
  if (v === null || v === undefined) return '';
  // Audit values are stored as JSON.stringify'd strings — strip outer
  // quotes for readability while preserving non-string values verbatim.
  if (typeof v === 'string' && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}
