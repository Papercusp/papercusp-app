/**
 * Read-side column projection shared by the two physical work-item families.
 *
 * The result `projection` argument is normally a post-handler reduction, but
 * callers that select only a small work-item field should not make Postgres
 * return and postgres-js parse the entire JSONB payload first. Keep the
 * storage policy here so issue and feature readers cannot drift.
 */

export type WorkItemPayloadProjection = 'full' | 'none' | 'completionEvidence';

export interface WorkItemReadOptions {
  /**
   * Issue-family body projection. Feature-family summaries are kept because
   * they are part of that table's canonical row shape.
   */
  includeBody?: boolean;
  /**
   * `none` returns a typed NULL payload; `completionEvidence` returns only the
   * `_completionEvidence` member, wrapped under the original payload key so
   * existing mappers preserve terminal-evidence semantics.
   */
  payloadProjection?: WorkItemPayloadProjection;
}

const PAYLOAD_COLUMN = /(^|,\s*)payload(\s*,)/;

/**
 * Replace only the returned payload column in a canonical column allowlist.
 * WHERE predicates may still read the physical payload; this helper changes
 * the SELECT projection and keeps the original row arity/key.
 */
export function projectWorkItemColumns(
  columns: string,
  projection: WorkItemPayloadProjection = 'full',
): string {
  if (projection === 'full') return columns;
  const replacement =
    projection === 'none'
      ? 'NULL::jsonb AS payload'
      : "jsonb_build_object('_completionEvidence', payload -> '_completionEvidence') AS payload";
  return columns.replace(PAYLOAD_COLUMN, `$1${replacement}$2`);
}
