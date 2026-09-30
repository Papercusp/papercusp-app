#!/usr/bin/env -S npx tsx
/**
 * Full reactivity round-trip e2e — papercusp-dogfood-v5 P-018/P-019/P-020.
 *
 * Closes the loop:
 *   PG trigger (emit_change_notify) → pg_notify('sync_invalidate', ...)
 *     → apps/operator/lib/sync-sse.ts LISTEN
 *     → /api/zero-harness/sse SSE endpoint
 *     → THIS script's EventSource consumer
 *
 * Drives the LIVE running operator at :3055 (or :3070 fallback). Side
 * effects on the live PG: applies migration 078 (idempotent
 * CREATE OR REPLACE FUNCTION), creates a unique-named throwaway test
 * table, attaches the trigger, exercises it, drops the table.
 *
 * Throwaway. Clean up always runs in the finally block.
 *
 * Run with:
 *   cd apps/operator && npx tsx scripts/verify-reactivity-e2e.ts
 *
 * Exits 0 on pass; 1 on any timeout or assertion failure.
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '@papercusp/operator-core/lib/embedded-pg-discovery';

// Resolve via embedded-pg discovery (env → ~/.papercusp/embedded-pg.json →
// native fallback). Native PG `papercusp` was renamed `papercusp_legacy`, so
// a hardcoded :5432 DSN no longer works against the desktop's embedded-pg.
const PG_URL = getHarnessAdminUrl();

function tableName(): string {
  return `reactivity_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function discoverOperatorPort(): Promise<number> {
  for (const p of [3055, 3070]) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/zero-harness/sse`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.body) {
        // Read one chunk and bail; we just need to confirm reachability.
        const reader = res.body.getReader();
        await reader.read();
        try { await reader.cancel(); } catch {}
        return p;
      }
    } catch { /* try next */ }
  }
  throw new Error('no operator reachable on :3055 or :3070');
}

interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

class SseClient {
  private port: number;
  private abort: AbortController;
  public events: SseEvent[] = [];
  public ready: Promise<void>;

  constructor(port: number) {
    this.port = port;
    this.abort = new AbortController();
    this.ready = this.start();
  }

  private async start(): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.port}/api/zero-harness/sse`, {
      signal: this.abort.signal,
    });
    if (!res.body) throw new Error('no SSE body');
    this.parse(res.body);
  }

  private async parse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let blankIdx;
        // Process whole events separated by \n\n.
        while ((blankIdx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, blankIdx);
          buf = buf.slice(blankIdx + 2);
          const ev: Partial<SseEvent> = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data = (ev.data ? (ev.data as string) + '\n' : '') + line.slice(5).trim();
            else if (line.startsWith('id:')) ev.id = line.slice(3).trim();
          }
          if (ev.event && ev.data != null) {
            try { ev.data = JSON.parse(ev.data as string); } catch { /* keep string */ }
            this.events.push(ev as SseEvent);
          }
        }
      }
    } catch (e: unknown) {
      // Aborted — fine.
      const err = e as { name?: string };
      if (err.name !== 'AbortError') console.error('[sse-parse-error]', e);
    }
  }

  close(): void {
    this.abort.abort();
  }
}

async function main(): Promise<void> {
  const tbl = tableName();
  console.log(`[e2e] test table: harness_shared.${tbl}`);

  const port = await discoverOperatorPort();
  console.log(`[e2e] operator reachable on :${port}`);

  const sql = postgres(PG_URL, { max: 1, idle_timeout: 5 });

  let pass = false;
  let failureReason = '';
  let sse: SseClient | null = null;
  try {
    // STEP 1: the emit_change_notify() trigger function is part of the baseline
    // schema (000-baseline.sql), applied on operator boot. The migration squash
    // (self-contained-migration-baseline-2026-06-02) folded the old standalone
    // 078-emit-change-notify.sql into the baseline, so there's no file to re-apply
    // — verify the function exists instead (fail loudly if the baseline is missing).
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'harness_shared' AND p.proname = 'emit_change_notify'
      ) AS exists`;
    if (!exists) {
      throw new Error('harness_shared.emit_change_notify() missing — baseline schema not applied?');
    }
    console.log('[e2e] emit_change_notify() present (baseline schema)');

    // STEP 2: create the throwaway test table.
    await sql.unsafe(`
      CREATE TABLE harness_shared.${tbl} (
        id   serial PRIMARY KEY,
        note text NOT NULL
      );
    `);
    console.log(`[e2e] created ${tbl}`);

    // STEP 3: attach the trigger.
    await sql.unsafe(`
      CREATE OR REPLACE TRIGGER emit_change_notify_trg
        AFTER INSERT OR UPDATE OR DELETE
        ON harness_shared.${tbl}
        FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
    `);
    console.log('[e2e] trigger attached');

    // STEP 4: subscribe to SSE BEFORE firing the INSERT so we don't
    // miss the event.
    sse = new SseClient(port);
    await sse.ready;
    console.log('[e2e] SSE consumer attached');
    // Give the operator a beat to register the new subscriber.
    await new Promise((r) => setTimeout(r, 250));

    // STEP 5: INSERT a row. The trigger fires inside the txn.
    await sql.unsafe(`INSERT INTO harness_shared.${tbl} (note) VALUES ('e2e-probe')`);
    console.log('[e2e] INSERT fired; awaiting SSE event...');

    const expectedName = `harness_shared.${tbl}.changed`;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const hit = sse.events.find(
        (e) =>
          (e.event === 'invalidate' || e.event === 'update') &&
          (e.data as { name?: string })?.name === expectedName,
      );
      if (hit) {
        console.log(`[e2e] ✓ received event: ${hit.event}`);
        console.log(`[e2e] ✓ payload: ${JSON.stringify(hit.data)}`);
        const args = (hit.data as { args?: { op?: string } }).args;
        if (args?.op !== 'INSERT') {
          failureReason = `op mismatch: expected INSERT, got "${args?.op}"`;
        } else {
          pass = true;
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!pass && !failureReason) {
      failureReason = `timed out waiting for event with name="${expectedName}" after 4s`;
      console.log(`[e2e] events seen so far (${sse.events.length}):`);
      for (const e of sse.events.slice(-5)) {
        console.log(`  - event=${e.event} data=${JSON.stringify(e.data).slice(0, 200)}`);
      }
    }

    // STEP 6: also try UPDATE + DELETE for completeness.
    if (pass) {
      const beforeCount = sse.events.length;
      await sql.unsafe(`UPDATE harness_shared.${tbl} SET note='e2e-mut' WHERE id=1`);
      await sql.unsafe(`DELETE FROM harness_shared.${tbl} WHERE id=1`);
      const seen = await waitFor(sse, expectedName, 'UPDATE', beforeCount, 3000);
      const seenD = await waitFor(sse, expectedName, 'DELETE', beforeCount, 3000);
      if (!seen) { pass = false; failureReason = 'UPDATE event not seen'; }
      else if (!seenD) { pass = false; failureReason = 'DELETE event not seen'; }
      else console.log('[e2e] ✓ UPDATE + DELETE events also received');
    }
  } finally {
    if (sse) sse.close();
    try {
      await sql.unsafe(`DROP TABLE IF EXISTS harness_shared.${tbl}`);
      console.log(`[e2e] dropped ${tbl}`);
    } catch (e) {
      console.error('[e2e] cleanup failed (manual cleanup needed):', e);
    }
    await sql.end({ timeout: 1 });
  }

  if (pass) {
    console.log('\n[e2e] PASS — full reactivity round-trip works against the live operator');
    process.exit(0);
  } else {
    console.error(`\n[e2e] FAIL — ${failureReason}`);
    process.exit(1);
  }
}

async function waitFor(
  sse: SseClient,
  name: string,
  op: string,
  fromIdx: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = sse.events.slice(fromIdx).find(
      (e) =>
        (e.data as { name?: string; args?: { op?: string } })?.name === name &&
        (e.data as { args?: { op?: string } })?.args?.op === op,
    );
    if (hit) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

main().catch((e) => {
  console.error('FATAL:', e?.stack ?? e);
  process.exit(1);
});
