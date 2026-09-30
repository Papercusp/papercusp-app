/**
 * Zod schemas derived from the generated Drizzle schema.
 *
 * This is the single source of truth for runtime validation everywhere
 * the codebase touches a table — API route bodies, plugin SDK config
 * schemas, MCP tool arguments, and react-hook-form forms.
 *
 * Usage:
 *   import { generated, createInsertSchema } from '@papercusp/db-org';
 *   const InsertGoal = createInsertSchema(generated.goalsInHarness_shared);
 *   const body = InsertGoal.parse(await req.json());
 *
 * Or import the curried helper:
 *   import { schemaOf } from '@papercusp/db-org/zod';
 *   const { insert, select, update } = schemaOf(generated.goalsInHarness_shared);
 *
 * Drizzle-zod auto-handles:
 *   - NOT NULL → required, NULLABLE → optional
 *   - SQL defaults → optional in insert, required in select
 *   - text/jsonb/bigint/timestamptz → string/unknown/number/number
 *   - generated/identity columns → omitted from insert
 *
 * Why a runtime helper instead of code-gen: drizzle-zod's introspection
 * is fast (~ms per table) and runs at module load. A pre-generated
 * `zod-schemas.ts` would also work but would drift unless wired into
 * the same CI hook as zero-drift-check.mjs. The runtime form is simpler
 * and gives identical type inference via `z.infer<typeof ...>`.
 */
import type { Table } from 'drizzle-orm';
import {
  createInsertSchema as _createInsertSchema,
  createSelectSchema as _createSelectSchema,
  createUpdateSchema as _createUpdateSchema,
} from 'drizzle-zod';

export const createInsertSchema = _createInsertSchema;
export const createSelectSchema = _createSelectSchema;
export const createUpdateSchema = _createUpdateSchema;

/**
 * Curried convenience: returns all three schemas for a table at once.
 *
 * Useful when an MCP tool needs both the insert shape (for args) and
 * the select shape (for the return type), or when a CRUD route wires
 * all three to method handlers.
 */
export function schemaOf<T extends Table>(table: T) {
  return {
    insert: _createInsertSchema(table),
    select: _createSelectSchema(table),
    update: _createUpdateSchema(table),
  };
}
