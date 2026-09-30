/**
 * /admin — auto-generated CRUD UI for every drizzle table registered
 * in `lib/admin-tables.ts`. Sibling of /dev/tables (read-only
 * inspection); /admin is the write surface.
 *
 * Forms are rendered from the column metadata of the drizzle schema —
 * column type → input type, NOT NULL → required, hasDefault → optional.
 * Bodies are validated server-side via `schemaOf(t).insert.parse` in
 * the generic API factory; the UI surfaces those zod issues inline.
 *
 * Adding a new admin table is two lines in `lib/admin-tables.ts`. No
 * bespoke page, no form code.
 */
import TableAdmin from '../_components/TableAdmin';

export const dynamic = 'force-dynamic';

export default function AdminPage() {
  return <TableAdmin />;
}
