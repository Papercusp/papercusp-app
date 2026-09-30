/**
 * Live test for the consolidated emit_change_notify trigger.
 *
 * Verifies that:
 *   1. The LIVE emit_change_notify() definition (extracted from the
 *      squashed 000-baseline.sql — migration 078 was folded into it)
 *      emits on the `sync_invalidate` channel.
 *   2. Payload shape matches sync-sse.ts SyncEvent contract:
 *      { name: '<schema>.<table>.changed', args: { workspace_id, op } }
 *   3. Trigger fires on INSERT / UPDATE / DELETE.
 *   4. workspace_id GUC is captured when set.
 *
 * Brings its own embedded PG on a non-default port — does NOT touch the
 * user's running operator dev/prod or any existing PG. Cleans up after.
 */
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-relative — resolved from THIS script's location, not a hardcoded box path. */
const BASELINE_PATH = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/000-baseline.sql', import.meta.url),
);

/**
 * Extract the live emit_change_notify() definition from the baseline dump.
 * Testing the archived 078 copy would green-light a stale function if the
 * baseline ever diverged; the baseline IS what a fresh install runs.
 */
function extractEmitChangeNotify() {
  const baseline = readFileSync(BASELINE_PATH, 'utf-8');
  const m = baseline.match(
    /CREATE OR REPLACE FUNCTION harness_shared\.emit_change_notify\(\)[\s\S]*?\$\$;/,
  );
  if (!m) {
    throw new Error(
      `emit_change_notify() not found in ${BASELINE_PATH} — did the baseline regenerate with a different shape?`,
    );
  }
  return m[0];
}

function nowMs() { return Date.now(); }

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'pg-trigger-test-'));
  const port = 16780; // arbitrary unused port
  console.log(`[test] booting embedded PG18 at port ${port}, dataDir=${dataDir}`);
  const t0 = nowMs();

  let pgHandle = null;
  let sysSql = null;
  let listenerSql = null;
  let writerSql = null;
  try {
    pgHandle = await startEmbeddedPostgresServer({
      dataDir,
      port,
      dbName: 'papercusp',
    });
    console.log(`[test] PG ready in ${nowMs() - t0}ms`);

    sysSql = postgres({
      host: 'localhost', port, user: 'postgres', password: 'postgres',
      database: 'papercusp', max: 1,
    });

    // 1) Apply the live trigger-function definition from the baseline.
    const sql078 = extractEmitChangeNotify();
    // We need the harness_shared schema first, since the function lives there.
    await sysSql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared;`);
    await sysSql.unsafe(sql078);
    console.log(`[test] applied live emit_change_notify from baseline`);

    // 2) Create a small test table and attach the trigger.
    await sysSql.unsafe(`
      CREATE TABLE harness_shared.trigger_test (
        id   serial PRIMARY KEY,
        name text NOT NULL
      );
    `);
    await sysSql.unsafe(`
      CREATE TRIGGER trigger_test_emit
        AFTER INSERT OR UPDATE OR DELETE
        ON harness_shared.trigger_test
        FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
    `);
    console.log(`[test] attached trigger to harness_shared.trigger_test`);

    // 3) Open a dedicated LISTEN connection.
    listenerSql = postgres({
      host: 'localhost', port, user: 'postgres', password: 'postgres',
      database: 'papercusp', max: 1, idle_timeout: 0,
    });

    const received = [];
    await listenerSql.listen('sync_invalidate', (raw) => {
      try {
        received.push(JSON.parse(raw));
      } catch (e) {
        console.error(`[test] failed to parse: ${raw}`);
      }
    });
    console.log(`[test] LISTEN sync_invalidate ready`);

    // 4) Open a writer connection that sets the workspace_id GUC.
    writerSql = postgres({
      host: 'localhost', port, user: 'postgres', password: 'postgres',
      database: 'papercusp', max: 1,
    });
    await writerSql.unsafe(`SET papercusp.workspace_id = 'ws-test-abc'`);

    // 5) Fire INSERT / UPDATE / DELETE in sequence.
    await writerSql.unsafe(`INSERT INTO harness_shared.trigger_test (name) VALUES ('row-1')`);
    await writerSql.unsafe(`UPDATE harness_shared.trigger_test SET name = 'row-1-mut' WHERE id = 1`);
    await writerSql.unsafe(`DELETE FROM harness_shared.trigger_test WHERE id = 1`);

    // 6) Give NOTIFYs a moment to arrive.
    await new Promise((r) => setTimeout(r, 250));

    // 7) Assert.
    console.log(`\n[test] received ${received.length} notifications:`);
    for (const ev of received) console.log(`  ${JSON.stringify(ev)}`);

    let failures = 0;
    function expect(cond, msg) {
      if (!cond) { console.error(`  FAIL: ${msg}`); failures++; }
      else { console.log(`  OK:   ${msg}`); }
    }
    console.log(`\n[test] assertions:`);
    expect(received.length === 3, `received exactly 3 events (got ${received.length})`);
    if (received.length >= 1) {
      const ev = received[0];
      expect(ev.name === 'harness_shared.trigger_test.changed',
        `INSERT event name = "harness_shared.trigger_test.changed" (got "${ev.name}")`);
      expect(ev.args?.op === 'INSERT', `INSERT event args.op = "INSERT" (got "${ev.args?.op}")`);
      expect(ev.args?.workspace_id === 'ws-test-abc',
        `INSERT event args.workspace_id captured (got "${ev.args?.workspace_id}")`);
    }
    if (received.length >= 2) {
      expect(received[1].args?.op === 'UPDATE',
        `UPDATE event args.op = "UPDATE" (got "${received[1].args?.op}")`);
    }
    if (received.length >= 3) {
      expect(received[2].args?.op === 'DELETE',
        `DELETE event args.op = "DELETE" (got "${received[2].args?.op}")`);
    }

    // 8) Test the no-GUC fallback case (workspace_id should be null).
    const writer2 = postgres({
      host: 'localhost', port, user: 'postgres', password: 'postgres',
      database: 'papercusp', max: 1,
    });
    const beforeCount = received.length;
    await writer2.unsafe(`INSERT INTO harness_shared.trigger_test (name) VALUES ('no-guc')`);
    await new Promise((r) => setTimeout(r, 150));
    const noGucEv = received[beforeCount];
    expect(noGucEv?.args?.workspace_id === null || noGucEv?.args?.workspace_id === undefined,
      `INSERT without GUC → args.workspace_id is null/undefined (got ${JSON.stringify(noGucEv?.args?.workspace_id)})`);
    await writer2.end();

    // 9) Test trigger coexistence with a pre-existing trigger (the
    // P-019 part 2 case: existing consolidated tables already have
    // sync triggers; my emit_change_notify must not conflict).
    await sysSql.unsafe(`
      CREATE TABLE harness_shared.coexist_test (
        id   serial PRIMARY KEY,
        name text NOT NULL
      );
    `);
    // Pre-existing trigger that writes to a side table — simulates
    // the existing sync_consolidated_trg shape.
    await sysSql.unsafe(`
      CREATE TABLE harness_shared.coexist_side (
        from_id integer NOT NULL,
        op text NOT NULL
      );
      CREATE OR REPLACE FUNCTION harness_shared.coexist_side_fn() RETURNS TRIGGER AS $body$
      BEGIN
        INSERT INTO harness_shared.coexist_side (from_id, op)
        VALUES (COALESCE(NEW.id, OLD.id), TG_OP);
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
      CREATE TRIGGER coexist_side_trg
        AFTER INSERT OR UPDATE OR DELETE ON harness_shared.coexist_test
        FOR EACH ROW EXECUTE FUNCTION harness_shared.coexist_side_fn();
    `);
    // Now ALSO attach emit_change_notify on the same table.
    await sysSql.unsafe(`
      CREATE OR REPLACE TRIGGER emit_change_notify_trg
        AFTER INSERT OR UPDATE OR DELETE ON harness_shared.coexist_test
        FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
    `);
    const beforeCo = received.length;
    await writerSql.unsafe(`INSERT INTO harness_shared.coexist_test (name) VALUES ('co')`);
    await new Promise((r) => setTimeout(r, 150));
    expect(received.length === beforeCo + 1,
      `coexisting trigger: emit_change_notify still fires when another trigger is attached (got ${received.length - beforeCo} new events, expected 1)`);
    const coRows = await sysSql`SELECT * FROM harness_shared.coexist_side`;
    expect(coRows.length === 1,
      `coexisting trigger: pre-existing trigger STILL fires (got ${coRows.length} side rows, expected 1)`);
    expect(received[beforeCo]?.name === 'harness_shared.coexist_test.changed',
      `coexisting trigger: emit_change_notify payload correct (got "${received[beforeCo]?.name}")`);

    if (failures > 0) {
      console.error(`\n[test] FAILED: ${failures} assertion(s) failed`);
      process.exit(1);
    } else {
      console.log(`\n[test] PASS — consolidated trigger emits on sync_invalidate with correct shape`);
    }
  } finally {
    try { if (listenerSql) await listenerSql.end({ timeout: 1 }); } catch {}
    try { if (writerSql) await writerSql.end({ timeout: 1 }); } catch {}
    try { if (sysSql) await sysSql.end({ timeout: 1 }); } catch {}
    try { if (pgHandle?.stop) await pgHandle.stop(); } catch (e) {
      console.error(`[test] stop failed (best-effort): ${e.message}`);
    }
    try { await rm(dataDir, { recursive: true, force: true }); } catch {}
    console.log(`[test] cleaned up`);
  }
}

main().catch((e) => {
  console.error(`[test] fatal: ${e.stack || e.message}`);
  process.exit(1);
});
