/**
 * Repair drizzle-kit's rendering of an empty PostgreSQL text-array default.
 *
 * PostgreSQL represents `DEFAULT '{}'` as an empty array, but drizzle-kit can
 * render that catalog value as `.array().default([""])`, which is an array
 * containing one empty string. Keep this transform separate from the CLI so
 * it can be regression-tested without connecting to the live database.
 *
 * @param {string} schema drizzle-kit's generated schema source
 * @returns {{ schema: string, fixed: number }} the repaired source and the
 *   number of broken defaults replaced
 */
export function repairEmptyArrayDefaults(schema) {
  const broken = /\.array\(\)\.default\(\[""\]\)/g;
  const fixed = schema.match(broken)?.length ?? 0;
  return {
    schema: schema.replace(broken, '.array().default([])'),
    fixed,
  };
}
