/**
 * Bench host wiring (memory-backend-benchmark-2026-06-05 P-006, D-009):
 * the live benchmark runs with its OWN `configureMemory` host — the
 * operator's seams (admin URL, credentials, embedder cascade) reused
 * verbatim, but the memory tables pointed at an isolated `bench_memory`
 * schema so `harness_shared.memory_*` is never touched, and the SQLite
 * event-history forced in-memory so nothing lands under ~/.papercusp.
 *
 * The bench is its OWN process — `configureMemory` is process-global,
 * so this never affects the running operator.
 *
 * Exported as reusable pieces (not just the runner's internals) so the
 * scale tier (P-010) and any future bench rides the same wiring.
 */
import { existsSync } from 'node:fs';

import { Client } from 'pg';

import { configureMemory, memoryHost, pgClientFields, VEC_TABLE } from '@papercusp/memory';
import type { ResolvedVecMode } from '@papercusp/memory';
// Side-effect import: wires the operator host (admin URL, credentials,
// embedder cascade) that we then override schema-wise below.
import '../configure';

/**
 * The bench's isolated schema — **UNIQUE PER RUN** (pid-suffixed).
 *
 * ⚠ This used to be the fixed string `'bench_memory'`, shared by every bench
 * process in the fleet. That is a collision by construction, and it bit twice
 * in one day (2026-07-13):
 *
 *  1. EI-10854 — two runs seeded the SAME schema concurrently and cross-
 *     contaminated each other's corpus. Both runs' numbers were garbage, and
 *     *nothing said so* — the bench happily reported a scorecard.
 *  2. Then the EI-10854 fix (make `ensureBenchSchema` DROP+recreate at run
 *     START, so a killed run's leftovers can't contaminate the next one) turned
 *     that silent corruption into an ACTIVE one: a second run's DROP CASCADE
 *     destroys the tables a first run is mid-seed on → `relation
 *     "bench_memory.memory_canonical" does not exist`.
 *
 * That second failure is *louder*, which is an improvement — but the root cause
 * was never the cleanup semantics, it was the SHARED NAME. Two runs must not be
 * able to address the same schema at all. A pid suffix makes collision
 * impossible rather than merely detectable.
 *
 * Override with PAPERCUSP_BENCH_SCHEMA to attach to a specific schema (e.g. to
 * inspect a finished run's rows before they are dropped).
 */
export const BENCH_SCHEMA = process.env.PAPERCUSP_BENCH_SCHEMA ?? `bench_memory_${process.pid}`;

/** Matches any run's bench schema (incl. the legacy fixed `bench_memory`). */
const BENCH_SCHEMA_PREFIX = 'bench_memory';

/**
 * Re-point the memory host at an isolated schema (default the bench's).
 * The operator seams (admin URL, credentials, embedder cascade, the
 * session-extraction rung) carry over verbatim. Also used by the live
 * session-extraction integration probe (`../session-extraction-live.ts`),
 * which runs in its own schema so concurrent bench runs can't collide.
 */
export function setupBenchMemoryHost(schema: string = BENCH_SCHEMA): void {
  const base = memoryHost(); // the operator host '../configure' just wired
  configureMemory({
    ...base,
    schema,
    localStoreDir: null, // in-memory mem0 history — nothing under ~/.papercusp
    backend: 'mem0', // the bench constructs backends directly; keep the default sane
  });
}

/** Open a pg client against the same DB the memory host resolves. */
export async function benchPgClient(): Promise<Client> {
  const fields = await pgClientFields();
  const client = new Client(fields);
  await client.connect();
  return client;
}

/**
 * Create an isolated schema + the memory tables CLONED from the live
 * `harness_shared` definitions via `CREATE TABLE (LIKE ... INCLUDING ALL)`
 * — columns, defaults, CHECK constraints, and indexes track production BY
 * CONSTRUCTION. Idempotent.
 *
 * WHY clone instead of hand-mirroring DDL: the previous hand-written copy
 * drifted from production TWICE in one day (2026-07-13, WI-4509) —
 * (1) migration 547's memory_vec_harrier (1024-dim) was missing, so every
 * PG-backed seed failed on a missing relation once the 07-10 embedder eval
 * made harrier the active mode (EI-10793); (2) migration 578's temporal-lite
 * columns (valid_at/invalid_at/superseded_by) were missing, so every
 * canonical search threw `column c.valid_at does not exist` and the whole
 * bench read as zero recall. A clone of the live table cannot drift.
 *
 * The vec-table set still derives from the shared VEC_TABLE map
 * (vec-write.ts) — the same single source the write path uses. NOTE: LIKE
 * does not copy FOREIGN KEYS, so the bench vec tables carry no FK to
 * memory_canonical — harmless here: recall JOINs canonical (an orphaned vec
 * row can never surface), and cleanup is a whole-schema DROP CASCADE.
 *
 * ⚠ It DROPS the schema first: a run's corpus MUST start empty. Idempotence
 * belongs at the START of a run, not to the politeness of the previous one's
 * cleanup (EI-10854). This used to be CREATE-IF-NOT-EXISTS, which silently
 * seeded ON TOP of whatever was already there — so a bench killed mid-flight
 * (its cleanup DROP never ran) left rows behind that contaminated the NEXT
 * run's corpus, and the numbers came out quietly wrong rather than failing.
 * Same hazard within a single `--keep` run, where backend B seeded on top of
 * backend A.
 *
 * ⚠ The old version of this comment claimed "callers are sequential (one
 * backend context at a time), so the drop can never race a live sibling." That
 * reasoning is only true WITHIN ONE PROCESS — it silently assumed no other bench
 * process exists. It does: `BENCH_SCHEMA` is now pid-unique precisely because a
 * second run's DROP CASCADE otherwise destroys a first run's tables mid-seed.
 * The drop below is safe because the schema is OURS ALONE, not because callers
 * are sequential.
 */
export async function ensureBenchSchema(client: Client, schema: string = BENCH_SCHEMA): Promise<void> {
  await reapOrphanBenchSchemas(client);
  await dropBenchSchema(client, schema);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`
    CREATE TABLE ${schema}.memory_canonical
      (LIKE harness_shared.memory_canonical INCLUDING ALL)
  `);
  for (const mode of Object.keys(VEC_TABLE) as ResolvedVecMode[]) {
    const vec = VEC_TABLE[mode];
    await client.query(`
      CREATE TABLE ${schema}.${vec}
        (LIKE harness_shared.${vec} INCLUDING ALL)
    `);
  }
}

/**
 * Drop bench schemas left behind by runs that are no longer alive.
 *
 * A pid-unique schema cannot collide, but it CAN leak: a run killed before its
 * cleanup (SIGKILL, OOM, a crashed host) leaves `bench_memory_<pid>` behind
 * forever. So each run reaps its dead predecessors — a schema is orphaned iff
 * its pid no longer exists in /proc. Also reaps the LEGACY fixed `bench_memory`
 * schema, which no current run owns.
 *
 * Deliberately best-effort: a reap failure must never fail a bench run (it is
 * hygiene, not correctness — correctness comes from the pid-unique name).
 */
export async function reapOrphanBenchSchemas(client: Client): Promise<string[]> {
  const reaped: string[] = [];
  try {
    const { rows } = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
      [`${BENCH_SCHEMA_PREFIX}%`],
    );
    for (const { nspname } of rows) {
      if (nspname === BENCH_SCHEMA) continue; // ours — handled by the caller's drop
      const m = /^bench_memory_(\d+)$/.exec(nspname);
      // The legacy bare `bench_memory` has no owner pid → always orphaned.
      if (m && existsSync(`/proc/${m[1]}`)) continue; // a LIVE peer run owns it
      await dropBenchSchema(client, nspname);
      reaped.push(nspname);
    }
  } catch {
    /* hygiene only — never fail a run on a reap error */
  }
  return reaped;
}

/**
 * Drop an isolated schema entirely (the run's cleanup). Retries on a lock
 * timeout (55P03): the mem0 client's pooled connections can still be
 * releasing when the drop fires, and a blocked DROP once killed a whole
 * run's report — give stragglers a moment instead of failing the run.
 */
export async function dropBenchSchema(client: Client, schema: string = BENCH_SCHEMA): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.query(`SET lock_timeout = '10s'`);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== '55P03' || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}
