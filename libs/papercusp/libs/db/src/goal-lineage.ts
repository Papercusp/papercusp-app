/**
 * Goal-lineage helper: walk up from a feature → its parent feature(s) → goal.
 *
 * Wraps the harness_shared.task_lineage() Postgres function defined in
 * 005-goals-events-routines.sql. Returns the chain ordered from the
 * starting feature outward (level 0) up to the goal (level 99).
 *
 * Worker prompts inject this as "## Why this matters" so agents always
 * see the full strategic context of the work they're doing.
 */

import type { Sql } from 'postgres';

export interface LineageRow {
  level: number;
  kind: 'task' | 'goal';
  id: string;
  title: string;
}

function validateSchema(schemaName: string): void {
  if (!/^harness_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`invalid schema name: ${schemaName}`);
  }
}

/**
 * Get the full lineage of a feature: itself → ancestors → goal.
 *
 * Returns rows ordered by level (0 first = the feature itself).
 * If the feature has no parent_id, only the feature row is returned.
 * If goal_id is set, the lineage ends with a row of kind='goal'.
 */
export async function getFeatureLineage(
  sql: Sql,
  schemaName: string,
  harnessSlug: string,
  featureId: string
): Promise<LineageRow[]> {
  validateSchema(schemaName);
  const rows = await sql<LineageRow[]>`
    SELECT level, kind, id, title
      FROM harness_shared.task_lineage(
        ${schemaName}::text,
        ${harnessSlug}::text,
        ${featureId}::text
      )
  `;
  return rows.map((r) => ({ ...r, level: Number(r.level) }));
}

/**
 * Format lineage as markdown for prompt injection.
 *
 * Output:
 *   ## Why this matters (your goal lineage)
 *   - Task: Implement OAuth login flow
 *     - because → Set up authentication system (parent task)
 *       - because → Build user management module (parent task)
 *         - because → GOAL: Ship habit-tracker mobile app to TestFlight by EOM
 */
export function formatLineageForPrompt(lineage: LineageRow[]): string {
  if (lineage.length === 0) return '';
  const lines: string[] = ['## Why this matters (your goal lineage)'];

  for (let i = 0; i < lineage.length; i++) {
    const row = lineage[i];
    const indent = '  '.repeat(i);
    if (row.kind === 'goal') {
      lines.push(`${indent}- because → **GOAL**: ${row.title}`);
    } else if (i === 0) {
      lines.push(`${indent}- Task: ${row.title}`);
    } else {
      lines.push(`${indent}- because → ${row.title} (parent task)`);
    }
  }

  return lines.join('\n');
}

/**
 * Insert a new goal. Convenience for plugins / installs.
 */
export async function createGoal(
  sql: Sql,
  input: {
    id: string;
    installSlug: string;
    title: string;
    body?: string | null;
    parentId?: string | null;
    budgetCents?: number | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<{ id: string }> {
  const metadataStr = input.metadata ? JSON.stringify(input.metadata) : null;
  await sql`
    INSERT INTO harness_shared.goals
      (id, install_slug, title, body, parent_id, budget_cents, metadata)
    VALUES (
      ${input.id},
      ${input.installSlug},
      ${input.title},
      ${input.body ?? null},
      ${input.parentId ?? null},
      ${input.budgetCents ?? null},
      ${metadataStr}::text::jsonb
    )
  `;
  return { id: input.id };
}

/**
 * List goals for an install.
 */
export async function listGoals(
  sql: Sql,
  installSlug: string
): Promise<Array<{ id: string; title: string; body: string | null; parentId: string | null; budgetCents: number | null; status: string }>> {
  const rows = await sql<any[]>`
    SELECT id, title, body, parent_id, budget_cents, status
      FROM harness_shared.goals
     WHERE install_slug = ${installSlug}
       AND status = 'active'
     ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    parentId: r.parent_id,
    budgetCents: r.budget_cents !== null ? Number(r.budget_cents) : null,
    status: r.status,
  }));
}
