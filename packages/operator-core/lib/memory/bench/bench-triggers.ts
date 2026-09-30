/**
 * Reproduce the live memory tables' TRIGGERS inside a bench schema (WI-10004107).
 *
 * WHY THIS EXISTS. `ensureBenchSchema` clones each live memory table with
 * `CREATE TABLE <bench>.<t> (LIKE harness_shared.<t> INCLUDING ALL)`. `INCLUDING ALL`
 * copies columns, defaults, NOT NULL / CHECK constraints, indexes, generated columns,
 * identity, comments and storage. It NEVER copies triggers. Migration 1093
 * (applied 2026-09-02) made `memory_vec_<mode>.row_kind` NOT NULL with no default,
 * filled by a BEFORE INSERT trigger that stamps it from `memory_canonical`. The clone
 * kept the NOT NULL and lost the trigger, so every bench vector insert failed with
 * `null value in column "row_kind" ... violates not-null constraint`. `seedCorpus`
 * swallowed each failure, and every hybrid-pg bench measured an EMPTY store for four
 * weeks without reporting it.
 *
 * So the bench clones triggers FROM THE CATALOG instead of hand-copying the one that
 * bit: every live, non-internal trigger on a cloned table must have its trigger
 * FUNCTION classified in {@link BENCH_TRIGGER_FUNCTION_POLICY}. `clone` rewrites the
 * function and trigger definitions into the bench schema; `skip` omits the trigger
 * with a stated reason. A function with no entry is a hard error, so the next
 * migration that adds a trigger to these tables fails the bench loudly instead of
 * silently changing what it measures.
 *
 * Every rewritten definition is checked so it cannot reach a live table: it must
 * not mention `harness_shared` at all, it must target the bench schema, and every
 * `<bench>.<name>` it references must be a cloned table or a cloned function.
 */
import type { Client } from 'pg';

export type BenchTriggerPolicy = { action: 'clone' } | { action: 'skip'; reason: string };

/**
 * What the bench does with each live trigger FUNCTION on the cloned memory tables.
 * Keyed by function name, so one entry covers the same function on every table.
 */
export const BENCH_TRIGGER_FUNCTION_POLICY: Readonly<Record<string, BenchTriggerPolicy>> = {
  // 1093: vec row_kind is NOT NULL with no default; this stamps it from the canonical row.
  stamp_memory_vec_row_kind: { action: 'clone' },
  // 1093: keeps the vec mirror in step when a canonical row's generated kind flips.
  propagate_memory_row_kind: { action: 'clone' },
  // Fills a NULL harness_slug from payload.fed_harness_slug; reads no table.
  stamp_memory_federation_slug: { action: 'clone' },
  capture_substrate_outbox: {
    action: 'skip',
    reason:
      'federation outbox capture: bench rows must never be queued for federation, and the outbox table is not cloned',
  },
};

/** One live trigger, as read from the catalog with `search_path = pg_catalog`. */
export interface LiveTriggerRow {
  table: string;
  trigger: string;
  functionName: string;
  /** `pg_trigger.tgenabled`: 'O' origin, 'A' always, 'R' replica, 'D' disabled. */
  enabled: string;
  triggerDef: string;
  functionDef: string;
}

export interface BenchTriggerClonePlan {
  /** Function definitions first, then triggers, in execution order. */
  statements: string[];
  cloned: Array<{ table: string; trigger: string }>;
  skipped: Array<{ table: string; trigger: string; reason: string }>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const LIVE_SCHEMA_REF = /"?harness_shared"?\./g;

function rewriteIntoSchema(def: string, schema: string): string {
  return def.replace(LIVE_SCHEMA_REF, `${schema}.`);
}

function assertConfined(
  kind: 'function' | 'trigger',
  name: string,
  def: string,
  schema: string,
  allowed: ReadonlySet<string>,
): void {
  if (/harness_shared/.test(def)) {
    throw new Error(
      `bench ${kind} ${name}: the rewritten definition still references harness_shared, so it could write to a live table. Refusing to install it.`,
    );
  }
  const refs = def.matchAll(new RegExp(`\\b${schema}\\.([a-z_][a-z0-9_]*)`, 'g'));
  for (const [, ref] of refs) {
    if (!allowed.has(ref)) {
      throw new Error(
        `bench ${kind} ${name}: references ${schema}.${ref}, which the bench does not clone. Clone that table too, or mark the trigger function 'skip' in BENCH_TRIGGER_FUNCTION_POLICY.`,
      );
    }
  }
}

/**
 * Pure planner: classify every live trigger and produce the SQL that reproduces the
 * `clone` ones inside `schema`. Throws on an unclassified function or on any
 * definition that is not fully confined to the bench schema.
 */
export function planBenchTriggerClones(
  rows: readonly LiveTriggerRow[],
  schema: string,
  clonedTables: readonly string[],
  policy: Readonly<Record<string, BenchTriggerPolicy>> = BENCH_TRIGGER_FUNCTION_POLICY,
): BenchTriggerClonePlan {
  if (!IDENT.test(schema)) throw new Error(`bench schema name is not a plain identifier: ${schema}`);

  const unclassified = rows.filter((r) => !policy[r.functionName]);
  if (unclassified.length > 0) {
    const list = unclassified.map((r) => `${r.table}.${r.trigger} -> ${r.functionName}()`).join(', ');
    throw new Error(
      `live memory table(s) carry trigger(s) the bench does not know how to reproduce: ${list}. ` +
        `CREATE TABLE (LIKE ... INCLUDING ALL) never copies triggers, so an unreproduced trigger silently changes ` +
        `what the bench measures (WI-10004107). Classify each function in BENCH_TRIGGER_FUNCTION_POLICY ` +
        `(packages/operator-core/lib/memory/bench/bench-triggers.ts).`,
    );
  }

  const plan: BenchTriggerClonePlan = { statements: [], cloned: [], skipped: [] };
  const toClone: LiveTriggerRow[] = [];
  for (const row of rows) {
    const p = policy[row.functionName];
    if (p.action === 'skip') {
      plan.skipped.push({ table: row.table, trigger: row.trigger, reason: p.reason });
    } else if (row.enabled === 'D') {
      plan.skipped.push({ table: row.table, trigger: row.trigger, reason: 'disabled on the live table' });
    } else {
      toClone.push(row);
    }
  }

  const functionNames = [...new Set(toClone.map((r) => r.functionName))];
  const allowed = new Set<string>([...clonedTables, ...functionNames]);

  for (const name of functionNames) {
    const live = toClone.find((r) => r.functionName === name)!;
    const def = rewriteIntoSchema(live.functionDef, schema);
    if (!def.startsWith(`CREATE OR REPLACE FUNCTION ${schema}.${name}(`)) {
      throw new Error(`bench function ${name}: rewritten definition does not create ${schema}.${name}(); got: ${def.slice(0, 120)}`);
    }
    assertConfined('function', name, def, schema, allowed);
    plan.statements.push(def);
  }

  for (const row of toClone) {
    const def = rewriteIntoSchema(row.triggerDef, schema);
    if (!def.includes(` ON ${schema}.${row.table} `) || !def.includes(`EXECUTE FUNCTION ${schema}.${row.functionName}(`)) {
      throw new Error(`bench trigger ${row.trigger}: rewritten definition does not target ${schema}.${row.table}; got: ${def}`);
    }
    assertConfined('trigger', row.trigger, def, schema, allowed);
    plan.statements.push(def);
    plan.cloned.push({ table: row.table, trigger: row.trigger });
  }

  return plan;
}

/** Live, non-internal triggers on the named `harness_shared` tables, with their functions. */
const LIVE_TRIGGERS_SQL = `
  SELECT c.relname AS "table", t.tgname AS "trigger", p.proname AS "functionName",
         t.tgenabled::text AS "enabled",
         pg_get_triggerdef(t.oid) AS "triggerDef", pg_get_functiondef(p.oid) AS "functionDef"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal
     AND n.nspname = 'harness_shared'
     AND c.relname = ANY($1::text[])
   ORDER BY c.relname, t.tgname`;

/**
 * Read the live triggers on `tables` and install the `clone` ones into `schema`.
 * The catalog read runs with `search_path = pg_catalog` so `pg_get_triggerdef`
 * always schema-qualifies the live table (an unqualified name would dodge the rewrite).
 */
export async function cloneLiveTriggers(
  client: Client,
  schema: string,
  tables: readonly string[],
): Promise<BenchTriggerClonePlan> {
  let rows: LiveTriggerRow[];
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path TO pg_catalog');
    rows = (await client.query<LiveTriggerRow>(LIVE_TRIGGERS_SQL, [tables])).rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  const plan = planBenchTriggerClones(rows, schema, tables);
  for (const sql of plan.statements) await client.query(sql);
  return plan;
}
