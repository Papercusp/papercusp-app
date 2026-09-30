import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

async function main() {
  const PG_URL = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
  const path = join(homedir(), '.restart-org', 'directives.json');
  if (!existsSync(path)) { console.log('no directives.json'); return; }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const directives = data.directives ?? [];
  console.log('found', directives.length, 'directives');

  const sql = postgres(PG_URL, { onnotice: () => {} });
  const now = Date.now();
  const rows = directives.map((d: any) => ({
    id: d.id, title: d.title, body: d.body, status: d.status,
    created_by: d.created_by, created_ts: d.created_ts,
    deadline_ts: d.deadline_ts ?? null, budget_cents: d.budget_cents ?? null,
    priority: d.priority ?? null,
    assigned_departments: JSON.stringify(d.assignedDepartments ?? []),
    linked_project_ids: JSON.stringify(d.linkedProjectIds ?? []),
    updated_ts: now,
  }));
  if (rows.length > 0) {
    await sql`
      INSERT INTO papercusp_shared.directives ${sql(rows, 'id', 'title', 'body', 'status', 'created_by', 'created_ts', 'deadline_ts', 'budget_cents', 'priority', 'assigned_departments', 'linked_project_ids', 'updated_ts')}
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, body = EXCLUDED.body, status = EXCLUDED.status,
        deadline_ts = EXCLUDED.deadline_ts, budget_cents = EXCLUDED.budget_cents,
        priority = EXCLUDED.priority,
        assigned_departments = EXCLUDED.assigned_departments,
        linked_project_ids = EXCLUDED.linked_project_ids,
        updated_ts = EXCLUDED.updated_ts
    `;
  }
  const result = await sql<{c: string}[]>`SELECT count(*)::text AS c FROM papercusp_shared.directives`;
  console.log('PG total:', result[0].c);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
