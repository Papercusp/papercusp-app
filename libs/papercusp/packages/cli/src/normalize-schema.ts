/**
 * Normalize manifest.schema into a list of `{schemaName?, ddlPath}` rows.
 * Accepts:
 *   - Single PluginSchemaDef object: `{schemaName, ddlPath}`
 *   - Array of PluginSchemaDef objects.
 *   - Legacy string-only array of DDL paths.
 *   - Anything else -> empty list.
 */
export function normalizeSchemaField(input: unknown): Array<{ schemaName?: string; ddlPath: string }> {
  if (!input) return [];
  const rows: Array<{ schemaName?: string; ddlPath: string }> = [];
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    if (typeof item === 'string') {
      rows.push({ ddlPath: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as { schemaName?: unknown; ddlPath?: unknown };
      if (typeof obj.ddlPath === 'string' && obj.ddlPath.length > 0) {
        rows.push({
          schemaName: typeof obj.schemaName === 'string' ? obj.schemaName : undefined,
          ddlPath: obj.ddlPath,
        });
      }
    }
  }
  return rows;
}
