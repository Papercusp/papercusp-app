/**
 * Pre-snapshot DB dump hook for a workspace.
 *
 * Writes transactionally-consistent per-database dumps of the workspace's live DBs
 * into `<workspaceRoot>/db-dumps/` so kopia captures them in the same
 * snapshot as the file tree. Restoration path:
 *   1. Restore the snapshot to a clone.
 *   2. Import `pg-embedded.sql.gz` into a fresh PG via
 *      `scripts/restore-pg-dump.sh` (faster + more robust than restoring
 *      the raw data dir). Don't hand-roll `gzip -d` + `psql -f` — PG18's
 *      pg_dump wraps the dump in `\restrict`/`\unrestrict` markers that
 *      desync plain psql's COPY parser part-way through and eventually
 *      OOM it (EI-13868), and the import needs a superuser-capable role
 *      to run the dump's `CREATE EXTENSION` statements. The script strips
 *      the markers (safe for this self-generated, trusted dump) and runs
 *      the import as a superuser — see that script for the full story.
 *
 * The hook only handles per-workspace state. Host PG (:5432) and host
 * sqlite (Restart harness DBs) are the systemd kopia job's concern,
 * not this one.
 *
 * Failure modes:
 *   - PG not running: log + skip, snapshot still proceeds.
 *   - sqlite locked: log + skip, snapshot still proceeds.
 * Never throws — losing a dump is better than losing the snapshot.
 */

import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, readdir, stat, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createWriteStream, type Dirent } from 'node:fs';
import type { Readable } from 'node:stream';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';

interface HookContext {
  workspaceId: string;
  workspaceRoot: string;
}

// Embedded PG port is no longer fixed — desktop picks at boot and writes
// it to ~/.papercusp/embedded-pg.json (or honors PAPERCUSP_PG_PORT env).
// Use the discovery helper instead of a hardcoded port.
import { backupHost } from './config';
import { WORKSPACE_BACKUP_APPLICATION_NAME } from './application-names';
import {
  evaluateHostDumpCoverage,
  hostDumpStatusPath,
  probeSystemIdentifier,
  readHostDumpStatus,
} from './host-dump-coverage';

// Keep the hot-state dump bounded and restorable. A full database dump on the
// standing dev box includes multi-GB telemetry/audit streams and plugin schemas
// the harness_admin role cannot read; pg_dumpall also needs pg_authid privileges
// harness_admin deliberately lacks. Dump the complete harness_shared SCHEMA so a
// clean restore gets functions/triggers/indexes, but omit DATA for high-volume,
// derived telemetry tables. Release-critical state (plans, work items, backup
// metadata, settings, etc.) remains included with data.
//
// Exported (subpath @papercusp/backup/hook) so operator-core's chunk-store
// guard (search/chunks/derived-registrations.test.ts) fails when a registered
// chunk store is missing here: this package cannot import operator-core's
// registry, so the list is pinned by that test instead of derived.
export const HOT_SNAPSHOT_EXCLUDED_TABLE_DATA: readonly string[] = [
  'harness_shared.route_invocations',
  'harness_shared.tool_invocations',
  'harness_shared.harness_run_output',
  'harness_shared.test_runs',
  // Transcript stores are short-lived operational state. The hourly host-level
  // dump remains the recovery path for them; keeping them out of this hot
  // snapshot prevents a faithful-parts COPY from holding an AccessShareLock
  // across the whole pre-snapshot dump.
  'harness_shared.session_turns',
  'harness_shared.session_turn_chunks',
  'harness_shared.session_turn_parts',
  // Every chunk store is a derived cache its sync pass rebuilds from the parent
  // rows (generic-rag-chunking-2026-09-29); the shared store sits beside
  // session_turn_chunks for the same reason.
  'harness_shared.text_chunks',
  'harness_shared.decision_ledger',
  'harness_shared.agent_activity',
  'harness_shared.coord_event_log',
  'harness_shared.operator_turns',
  'harness_shared.pot_throughput_ticks',
  'harness_shared.substrate_outbox',
  'harness_shared.pipeline_events',
  'harness_shared.operator_curation_log',
  'harness_shared.backup_events',
  'harness_shared.memory_vec_openai',
  'harness_shared.event_wake_deliveries',
  'harness_shared.shared_presence',
  'harness_shared.benchmark_rollout',
  'harness_shared.benchmark_run_result',
  'harness_shared.spawned_agents',
  'harness_shared.agent_usage_samples',
  'harness_shared.telemetry_reports_archive',
  'harness_shared.audit_log',
  // Recall-quality telemetry is derived diagnostics, not restore-critical
  // state. It has grown to ~1.7 GB heap on the dev cluster (plus the
  // query-text companion) and was the remaining included COPY workload after
  // the transcript/archive exclusions; retaining it in every hot snapshot
  // makes the 15-minute dump watchdog elapse before the receipt can be marked
  // database-backed. The schema stays in the dump so the tables remain
  // available after restore; only their high-volume rows come from the
  // hourly host-level backup when needed.
  'harness_shared.memory_recall_stats',
  'harness_shared.memory_recall_query_text',
  // Gateway request bodies are a durable-admission spool, not workspace
  // state. Receipts retain these rows only until execution settles, and the
  // live table can still grow by tens of GiB between hourly sweeps. Keeping
  // the schema but omitting its bytea data prevents a transient request-body
  // backlog from making the per-workspace restore dump exceed its watchdog.
  'harness_shared.gateway_payload_blobs',
  // The same spool's body chunks (D-017, migration 1314): content-defined pieces of
  // those request bodies, kept only while a manifest row above references them.
  'harness_shared.gateway_payload_chunks',
  // Session-transcript archive blobs (~3 GB TOAST) + their parent metadata rows
  // (excluded together so a restore sees a clean absence, not dangling refs).
  // This pair dominated the dump — one 279s-mean COPY per snapshot, ~65% of the
  // output bytes (P-013, db-performance-remediation-2026-07-26). Archives stay
  // recoverable from the hourly host-level dump (db-backup.sh →
  // /mnt/data/Backup/db-dumps/pg/papercusp/), which includes all table data.
  'harness_shared.session_archives',
  'harness_shared.session_archive_files',
] as const;

const MIN_RESTORABLE_DUMP_BYTES = 10_000;
const PG_DUMP_TIMEOUT_MS = 15 * 60_000;
const GUARD_LOCK_WAIT_TIMEOUT_SEC = PG_DUMP_TIMEOUT_MS / 1000;
// Let the guard's own flock timeout report and exit before this backstop fires.
const GUARD_READINESS_TIMEOUT_MS = PG_DUMP_TIMEOUT_MS + 5_000;
const GUARD_READY_SIGNAL = 'KOPIA_BACKUP_GUARD_READY\n';
// Keep the database-side cancellation ahead of the Node watchdog. Killing the
// client alone can leave pg_dump's backend holding its transaction lock until
// PostgreSQL notices the broken connection (EI-21363741549000811).
const PG_DUMP_STATEMENT_TIMEOUT_MS = 10 * 60_000;
const PG_DUMP_LOCK_WAIT_TIMEOUT_MS = 30_000;
const GIB = 1024n * 1024n * 1024n;

/**
 * The host-level Postgres dump and the workspace hook share one database.
 * Both must enter the same cross-process guard before pg_dump starts; the
 * in-process `dumpQueue` below cannot coordinate with systemd's producer.
 *
 * Keep the override name aligned with the systemd scripts so tests and
 * isolated deployments can point every producer at one guard instance. The
 * installed symlink is the Linux production default (the versioned script
 * lives in apps/operator/scripts/systemd/ and requires flock and /proc).
 * Other platforms have no systemd producer to coordinate with; they retain
 * the in-process dump queue and the snapshot's database migration lock.
 */
export const WORKSPACE_BACKUP_GUARD_LABEL = 'workspace-db-dump';
const DEFAULT_BACKUP_GUARD_PATH = join(homedir(), '.config', 'kopia', 'kopia-backup-guard.sh');

/**
 * Resolve the shared backup guard at call time, rather than module load time,
 * so an embedding host can configure its command before the first snapshot.
 * A guard that is already active is inherited from the enclosing Kopia
 * snapshot process; re-entering its wait-mode flock would deadlock the hook.
 */
export function resolveKopiaBackupGuard(): string | null {
  if (process.env.KOPIA_BACKUP_GUARD_ACTIVE === '1') return null;
  return process.env.KOPIA_BACKUP_GUARD_BIN?.trim()
    || (process.platform === 'linux' ? DEFAULT_BACKUP_GUARD_PATH : null);
}

const GUARD_LOG_LINE_PREFIX = 'KOPIA_BACKUP_GUARD ';
const MAX_PENDING_GUARD_LOG_CHARS = 8_192;

/**
 * Re-emit the guard's own decision lines from the captured stderr stream.
 *
 * The wait-mode guard writes its `KOPIA_BACKUP_GUARD ... label=workspace-db-dump`
 * lines to stderr so they cannot corrupt the SQL dump on stdout, and this hook
 * captures that stderr only to quote it on failure. That left every waiting /
 * started / finished line for this producer out of the journal, so a hot sweep
 * preempted by a deploy- or migration-triggered dump could not be attributed
 * to its caller (WI-10004871: two of fourteen preemptions on 2026-10-01 had no
 * identifiable waiter). Forwarding to the host process's stderr lands them in
 * the journal of whichever unit ran the hook. pg_dump's own stderr is not
 * forwarded: it is already quoted in the failure result.
 */
export function createGuardLogForwarder(
  write: (line: string) => void = (line) => { process.stderr.write(`${line}\n`); },
): (chunk: Buffer | string) => void {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.startsWith(GUARD_LOG_LINE_PREFIX)) write(line);
      newline = pending.indexOf('\n');
    }
    // A producer that never ends its line must not grow this buffer unbounded.
    if (pending.length > MAX_PENDING_GUARD_LOG_CHARS) pending = '';
  };
}

/**
 * Terminate one spawned command and every descendant that remains in its
 * isolated POSIX process group.
 *
 * The workspace dump normally starts through the shell backup guard. Killing
 * only that direct child leaves its pg_dump grandchild alive and reparented to
 * systemd; before WI-10000839 that orphan also inherited the guard's flock and
 * blocked the hourly recovery-point dump for hours. `detached` below creates a
 * group whose id is the direct child's pid, so a negative-pid signal has exact
 * spawn-tree scope. Windows has no POSIX process groups and keeps the direct
 * ChildProcess fallback.
 */
export function terminateSpawnTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  detached: boolean,
  signal: NodeJS.Signals = 'SIGKILL',
): void {
  if (detached && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      // ESRCH means the isolated group is already gone. Any other failure may
      // still permit the direct-child fallback below.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Stable application identity used by migration preflight and lock monitors
 * to distinguish the workspace's pg_dump transaction from ordinary readers. */
export { WORKSPACE_BACKUP_APPLICATION_NAME } from './application-names';

/**
 * Multiple of the previous dump's size to require free. The new `.tmp` and the
 * previous dump coexist for the length of the run (the rename is the last
 * step), so 2x is the floor for correctness; the third covers growth between
 * snapshots.
 */
const DUMP_SIZE_HEADROOM_FACTOR = 3n;
/** Budget when no previous dump exists to measure (first run in a workspace). */
const MIN_DUMP_BUDGET_BYTES = 2n * GIB;
/** Never drive the filesystem to literal zero, however small the dump is. */
const FILESYSTEM_SAFETY_MARGIN_BYTES = 1n * GIB;

export interface PreSnapshotHookResult {
  ok: boolean;
  bytes?: number;
  error?: string;
  /**
   * Set when the dump was deliberately and provably UNNECESSARY rather than
   * attempted — today, only when the host backup already dumped this exact
   * cluster's copy of this database (see host-dump-coverage.ts).
   *
   * Such a skip reports `ok: true`, because the leg did its job: the database
   * is captured, by the mechanism that owns it. Reporting `ok: false` would
   * drive `dbDumpOk` false on every snapshot forever (workspace-backup.ts),
   * turning a correct delegation into a permanent false degradation — and this
   * field exists so that "no dump was written" stays visible in the
   * `hook_pg_dump` event instead of being flattened into a silent success.
   */
  skipped?: string;
}

/**
 * Space the dump needs, plus a margin — sized to the WORK, never to the disk.
 *
 * The previous implementation asked for 10% of TOTAL CAPACITY (floor 10GiB,
 * ceiling 100GiB). On any large volume that saturates at the 100GiB ceiling,
 * so writing a 1.7GB dump demanded 100GiB free — a ~60x margin that a busy
 * 2TB disk never satisfies. The result was NOT a noisy alarm but a SILENT
 * one: the guard meant to protect the backup disabled it outright, hourly,
 * for 26 hours (EI-20109034777197353), because a reserve derived from disk
 * size has no relationship to the thing being reserved FOR.
 *
 * Sized from the previous dump instead: it is by far the best predictor of
 * the next one. The factor covers the fact that the new `.tmp` is written
 * while the previous dump still exists (so both are on disk at once) plus
 * room for growth; the floor covers a fresh workspace with no prior artifact
 * to measure; the margin keeps the filesystem off zero regardless.
 *
 * Being too PERMISSIVE here is the recoverable direction — `dumpPg` handles
 * ENOSPC and unlinks its partial `.tmp`. Being too restrictive silently ends
 * backups, which is the failure this function caused.
 *
 * @param recentDumpBytes size of the most recent successful dump, or null when
 *   none exists yet.
 */
export function requiredFreeBytes(recentDumpBytes: bigint | null): bigint {
  const projected =
    recentDumpBytes !== null && recentDumpBytes > 0n
      ? recentDumpBytes * DUMP_SIZE_HEADROOM_FACTOR
      : MIN_DUMP_BUDGET_BYTES;
  const need = projected < MIN_DUMP_BUDGET_BYTES ? MIN_DUMP_BUDGET_BYTES : projected;
  return need + FILESYSTEM_SAFETY_MARGIN_BYTES;
}

/**
 * gzip args for the PG dump. `--rsyncable` inserts periodic flush
 * points so an unchanged region of the dump compresses to a stable
 * byte range — which lets kopia's content-defined chunker dedup it
 * across the snapshot cadence. Without it, gzip's output shifts
 * wholesale on any input change and every 5-minute snapshot stores a
 * fresh full copy of the dump (this was a contributor to repo bloat).
 *
 * GNU gzip supports the flag; BSD gzip (macOS) does not — probe once
 * and cache. On BSD we fall back to plain `-1`; kopia still chunks the
 * raw gzip stream, just with worse dedup.
 */
let _gzipRsyncable: boolean | null = null;
function gzipArgs(): string[] {
  if (_gzipRsyncable === null) {
    try {
      const probe = spawnSync('gzip', ['--help'], { encoding: 'utf8' });
      _gzipRsyncable = /--rsyncable/.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`);
    } catch {
      _gzipRsyncable = false;
    }
  }
  return _gzipRsyncable ? ['-1', '--rsyncable'] : ['-1'];
}

// Every workspace currently draws from the same harness_shared database.
// Serialize dump pipelines process-wide so multiple due workspaces cannot each
// drive pg_dump+gzip against the host at once. The tail always recovers, so one
// degraded dump cannot poison future work. This queue is deliberately only the
// load-shedding layer: desktop, staging API, and background-host processes can
// all snapshot the same workspace concurrently, so dumpPg() must also isolate
// its transaction file across processes.
let dumpQueue: Promise<void> = Promise.resolve();
let dumpAttemptSequence = 0;

/**
 * Allocate an attempt-scoped transaction path for the PG dump.
 *
 * `dumpQueue` cannot serialize separate Node processes. The old single
 * `pg-embedded.sql.gz.tmp` pathname therefore let an interval snapshot and an
 * explicit pre-destructive snapshot write the same inode. Whichever attempt
 * renamed it first made every other attempt fail its final stat with ENOENT;
 * worse, their streams could continue writing into the supposedly-complete
 * destination inode. PID + a process-local sequence makes the path unique in
 * both dimensions while retaining the `.tmp` suffix covered by Kopia policy.
 */
export function allocateDumpTempPath(outPath: string): string {
  dumpAttemptSequence += 1;
  return `${outPath}.${process.pid}-${dumpAttemptSequence}.tmp`;
}

/**
 * Return the writer PID encoded in one attempt-scoped transaction filename.
 *
 * Keep this parser exact. The dump directory can contain unrelated `.tmp`
 * files, and cleanup authority comes only from the filename shape allocated
 * above plus a dead-writer verdict.
 */
export function dumpTempOwnerPid(outPath: string, entryName: string): number | null {
  const prefix = `${basename(outPath)}.`;
  if (!entryName.startsWith(prefix) || !entryName.endsWith('.tmp')) return null;
  const owner = entryName.slice(prefix.length, -'.tmp'.length);
  const match = /^([1-9]\d*)-\d+$/.exec(owner);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists but belongs to another user. Unknown
    // probe failures also fail closed; only ESRCH authorizes deletion.
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/**
 * Reap transaction files whose encoded writer process is provably gone.
 *
 * Unique PID/sequence paths fixed the cross-process inode collision, but the
 * former cleanup still removed only the retired `outPath.tmp` name. A killed
 * operator therefore leaked every partial attempt forever. Do not age-reap:
 * another process may be legitimately writing the same workspace dump, while
 * an ESRCH verdict is an exact ownership boundary.
 */
export async function reapDeadDumpTempFiles(outPath: string): Promise<number> {
  const dir = dirname(outPath);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const pid = dumpTempOwnerPid(outPath, entry.name);
    if (pid === null || processExists(pid)) continue;
    try {
      await unlink(join(dir, entry.name));
      removed += 1;
    } catch {
      // A peer may have completed cleanup after readdir. Best-effort is enough;
      // the next hook retries every still-present dead-writer transaction.
    }
  }
  return removed;
}

export function runPreSnapshotHook(ctx: HookContext): Promise<PreSnapshotHookResult> {
  const run = dumpQueue.then(() => runPreSnapshotHookNow(ctx));
  dumpQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function runPreSnapshotHookNow(ctx: HookContext): Promise<PreSnapshotHookResult> {
  const dumpDir = join(ctx.workspaceRoot, 'db-dumps');
  await mkdir(dumpDir, { recursive: true });
  const logPath = join(dumpDir, 'hook.log');

  const log = async (msg: string) => {
    await appendFile(logPath, `[${new Date().toISOString()}] ${msg}\n`).catch(() => {});
  };

  const outPath = join(dumpDir, 'pg-embedded.sql.gz');

  // A leftover transaction from a crashed writer is never useful input, and
  // its bytes are exactly the bytes the next dump needs. Reclaim it BEFORE
  // measuring free space rather than leaving it to `dumpPg`: when the check
  // below refuses, `dumpPg` never runs, so the orphan outlives every skip and
  // is re-captured by every snapshot. The legacy single `.tmp` cleanup below
  // remains for pre-PID/sequence artifacts; the reaper covers current names.
  const reapedTransactions = await reapDeadDumpTempFiles(outPath);
  if (reapedTransactions > 0) {
    await log(`pg temp cleanup: reaped ${reapedTransactions} dead-writer transaction(s)`);
  }
  await unlink(`${outPath}.tmp`).catch(() => {});

  // --- embedded-pg (port discovered at runtime) ---
  const { url, source } = backupHost().getHarnessAdminUrl();
  await log(`embedded-pg URL source: ${source}`);
  const parsed = new URL(url);
  const target = {
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: parsed.username || 'postgres',
    password: decodeURIComponent(parsed.password || 'postgres'),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'papercusp',
  };

  // `getHarnessAdminUrl` is host-level and takes no workspace argument, so where
  // every workspace resolves to the same host cluster this dump duplicates the
  // hourly systemd job — one database dumped N+1 times per hour, whose overlap
  // is what drives the 900 s watchdog timeouts (EI-21874492117996483). Stand
  // down ONLY on proof that this cluster's copy of this database was dumped
  // successfully and recently; every uncertain branch falls through and dumps.
  //
  // The identity probe is deliberately gated behind a receipt being present, so
  // a deployment with no host job (the desktop ship target) never pays for a
  // psql spawn it can never act on.
  const hostStatus = await readHostDumpStatus(hostDumpStatusPath());
  const coverage = evaluateHostDumpCoverage({
    database: target.database,
    targetSystemIdentifier: hostStatus ? await probeSystemIdentifier(target) : null,
    status: hostStatus,
    nowEpoch: Math.floor(Date.now() / 1000),
  });
  if (coverage.covered) {
    await log(`pg SKIP: ${coverage.reason}`);
    await log('hook done (skipped: host-covered)');
    return { ok: true, skipped: coverage.reason };
  }
  if (hostStatus) await log(`host-dump coverage not established: ${coverage.reason}`);

  // The dump is written beside the workspace, not in the Kopia repository.
  // Refuse before spawning pg_dump when that filesystem cannot fit the dump —
  // sized to the dump's own need, never to disk capacity (see
  // requiredFreeBytes). This check deliberately follows the proven
  // host-coverage skip above: when the host backup already captured this exact
  // database, no local dump will be written and local filesystem headroom is
  // irrelevant. Uncertain coverage still falls through to this guard.
  try {
    const previousDumpBytes = await stat(outPath).then(
      (s) => BigInt(s.size),
      () => null,
    );
    const fs = await statfs(ctx.workspaceRoot);
    const blockSize = BigInt(fs.bsize);
    const freeBytes = blockSize * BigInt(fs.bavail);
    const reserveBytes = requiredFreeBytes(previousDumpBytes);
    if (freeBytes < reserveBytes) {
      const error = `insufficient free space (${freeBytes} available; ${reserveBytes} needed for a dump of ${previousDumpBytes ?? 'unknown'} bytes)`;
      await log(`pg SKIP: ${error}`);
      await log('hook done (degraded)');
      return { ok: false, error };
    }
  } catch (err) {
    // A statfs failure should not disable backups on an unusual filesystem;
    // dumpPg still handles ENOSPC and cleans its transaction file.
    await log(`free-space probe unavailable: ${String(err)}`);
  }

  const result = await dumpPg({
    ...target,
    outPath,
    log,
  });

  await log(`hook done (${result.ok ? 'ok' : 'degraded'})`);
  return result;
}

async function dumpPg(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  outPath: string;
  log: (msg: string) => Promise<void>;
}): Promise<PreSnapshotHookResult> {
  const tmp = allocateDumpTempPath(opts.outPath);
  // A crash/timeout from an earlier attempt must not become the next
  // snapshot's input. This is paired with the `*.tmp` Kopia policy rule.
  await unlink(tmp).catch(() => {});
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGPASSWORD: opts.password,
    // pg_dump keeps AccessShareLock rows for the duration of its snapshot
    // transaction. Give migration preflight + the hourly convoy monitor a
    // stable identity so they can refuse/diagnose DDL lock inversion.
    PGAPPNAME: WORKSPACE_BACKUP_APPLICATION_NAME,
    PGCONNECT_TIMEOUT: '5',
    // PGOPTIONS is parsed by libpq for the pg_dump session. Keep any caller
    // options, then append bounds that apply to this dump only.
    PGOPTIONS: [
      process.env.PGOPTIONS,
      `-c statement_timeout=${PG_DUMP_STATEMENT_TIMEOUT_MS}`,
      `-c lock_timeout=${PG_DUMP_LOCK_WAIT_TIMEOUT_MS}`,
    ].filter(Boolean).join(' '),
  };
  const pgDumpArgs = [
    '-h', opts.host,
    '-p', String(opts.port),
    '-U', opts.user,
    '-w',
    '-d', opts.database,
    '--no-owner',
    '--no-privileges',
    '-n', 'harness_shared',
    // Do not wait indefinitely behind a concurrent schema/table lock. The
    // session-level lock_timeout above also covers locks acquired by the
    // dump's own SQL, while this pg_dump flag gives its lock phase a clear
    // diagnostic failure.
    '--lock-wait-timeout=30s',
    // Every extension the harness_shared schema actually depends on at
    // DDL time must be dumped, not just `vector`. EI-13868: a restore
    // drill found the dump omitted `pg_trgm`, so importing into a fresh
    // DB failed 3x with "gin_trgm_ops does not exist for access method
    // gin" the moment the trigram GIN index (594-memory-canonical-trgm-
    // lexical.sql) tried to create — CREATE INDEX validates the operator
    // class at DDL time, unlike a plpgsql function body's pgcrypto calls
    // (000-baseline.sql: pgp_sym_encrypt/gen_salt), which aren't checked
    // until called. Include `pgcrypto` too so those functions actually
    // work post-restore instead of failing silently the first time
    // they're invoked.
    '-e', 'vector',
    '-e', 'pg_trgm',
    '-e', 'pgcrypto',
    ...HOT_SNAPSHOT_EXCLUDED_TABLE_DATA.map((table) => `--exclude-table-data=${table}`),
  ];
  const guard = resolveKopiaBackupGuard();
  const dumpCommand = guard ?? 'pg_dump';
  const dumpArgs = guard
    ? ['--mode', 'wait', '--label', WORKSPACE_BACKUP_GUARD_LABEL, '--', 'pg_dump', ...pgDumpArgs]
    : pgDumpArgs;
  if (guard) {
    // Guard logs must not contaminate the SQL dump on stdout. FD 3 reports when
    // the shared lock is acquired so the 900s dump watchdog starts at that point.
    env.KOPIA_BACKUP_GUARD_LOG_STDERR = '1';
    env.KOPIA_BACKUP_GUARD_READY_FD = '3';
    env.KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC = String(GUARD_LOCK_WAIT_TIMEOUT_SEC);
  }
  return new Promise<PreSnapshotHookResult>((resolve) => {
    const dumpDetached = process.platform !== 'win32';
    // Node only specializes child-process stream types for fds 0–2; fd 3 is
    // the optional guard channel. Both branches guarantee stdin=ignore and
    // stdout/stderr=pipe, so preserve those known stream types explicitly.
    const dump = spawn(dumpCommand, dumpArgs, {
      env,
      stdio: guard
        ? ['ignore', 'pipe', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe'],
      // The watchdog owns this entire guard -> pg_dump tree. Without an
      // isolated group, ChildProcess.kill() reaches only the guard shell.
      detached: dumpDetached,
    }) as ChildProcessByStdio<null, Readable, Readable>;
    const gz = spawn('gzip', gzipArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = createWriteStream(tmp);

    dump.stdout.pipe(gz.stdin);
    gz.stdout.pipe(out);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    if (guard) dump.stderr.on('data', createGuardLogForwarder());
    gz.stderr.on('data', (d) => { stderr += d.toString(); });

    const killDumpTree = () => terminateSpawnTree(dump, dumpDetached);

    let settled = false;
    let dumpWatchdog: NodeJS.Timeout | undefined;
    let guardReadinessWatchdog: NodeJS.Timeout | undefined;
    const armDumpWatchdog = () => {
      if (settled || dumpWatchdog) return;
      if (guardReadinessWatchdog) {
        clearTimeout(guardReadinessWatchdog);
        guardReadinessWatchdog = undefined;
      }
      dumpWatchdog = setTimeout(() => {
        stderr += `pg dump timed out after ${PG_DUMP_TIMEOUT_MS}ms\n`;
        killDumpTree();
        gz.kill('SIGKILL');
      }, PG_DUMP_TIMEOUT_MS);
    };
    const finalize = async (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (dumpWatchdog) clearTimeout(dumpWatchdog);
      if (guardReadinessWatchdog) clearTimeout(guardReadinessWatchdog);
      if (!out.destroyed) out.end();
      let result: PreSnapshotHookResult;
      if (ok) {
        try {
          const s = await stat(tmp);
          if (s.size >= MIN_RESTORABLE_DUMP_BYTES) {
            await renameAtomic(tmp, opts.outPath);
            await opts.log(`pg ${opts.host}:${opts.port} ok (${s.size} bytes)`);
            result = { ok: true, bytes: s.size };
          } else {
            const detail = stderr.trim().slice(0, 200);
            const error = `empty dump${detail ? `: ${detail}` : ''}`;
            await unlink(tmp).catch(() => {});
            await opts.log(`pg ${opts.host}:${opts.port} SKIP (empty dump)${detail ? `: ${detail}` : ''}`);
            result = { ok: false, error };
          }
        } catch (e) {
          const error = `stat: ${String(e)}`;
          await unlink(tmp).catch(() => {});
          await opts.log(`pg ${opts.host}:${opts.port} FAIL ${error}`);
          result = { ok: false, error };
        }
      } else {
        const error = stderr.trim().slice(0, 200) || 'dump pipeline failed';
        await unlink(tmp).catch(() => {});
        await opts.log(`pg ${opts.host}:${opts.port} FAIL: ${error}`);
        result = { ok: false, error };
      }
      resolve(result!);
    };

    // A missing binary (pg_dump / gzip) makes Node emit an 'error'
    // event on the child; with no listener that crashes the operator
    // process. Route it through finalize(false) so the snapshot still
    // proceeds without the dump.
    dump.on('error', (e) => {
      stderr += `pg_dump spawn failed: ${e.message}\n`;
      try { gz.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });
    gz.on('error', (e) => {
      stderr += `gzip spawn failed: ${e.message}\n`;
      killDumpTree();
      void finalize(false);
    });
    // The output file stream fails independently of the children —
    // disk full (ENOSPC), bad path (EISDIR/EACCES). An unhandled
    // stream 'error' crashes the operator just like an unhandled child
    // spawn error, so route it through finalize(false) too.
    out.on('error', (e) => {
      stderr += `output stream failed: ${e.message}\n`;
      killDumpTree();
      try { gz.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });
    // The pg_dump→gzip pipe (`dump.stdout.pipe(gz.stdin)`) is the OTHER
    // unguarded socket. If gzip dies mid-stream — SIGKILL from the 60s
    // timeout above, an OOM kill under host load, or a plain crash — gz.stdin
    // becomes a broken pipe and pg_dump's next write throws `write EPIPE`.
    // That EPIPE surfaces as an 'error' event on the gz.stdin Socket (and, in
    // some Node versions, on dump.stdout), NOT as a promise rejection — so it
    // bypasses BOTH finalize()'s resolve-only contract and the caller's
    // `.catch()`, and (as seen 2026-07-10) crashes the whole DETACHED deploy
    // process right at the pre-deploy snapshot step, blocking every green-pin
    // ship. The child-`on('error')` handlers above only cover SPAWN failures,
    // not the stdin/stdout stream sockets, so add explicit handlers here that
    // degrade exactly like every other dump failure: abandon the dump, let the
    // snapshot proceed.
    gz.stdin.on('error', (e) => {
      stderr += `gzip stdin pipe failed: ${e.message}\n`;
      killDumpTree();
      try { gz.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });
    dump.stdout.on('error', (e) => {
      stderr += `pg_dump stdout pipe failed: ${e.message}\n`;
      killDumpTree();
      try { gz.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });

    if (!guard) {
      armDumpWatchdog();
    } else {
      const readiness = dump.stdio[3] as NodeJS.ReadableStream | null;
      if (!readiness) {
        stderr += 'backup guard readiness channel unavailable\n';
        killDumpTree();
        try { gz.kill('SIGKILL'); } catch { /* already gone */ }
        void finalize(false);
      } else {
        guardReadinessWatchdog = setTimeout(() => {
          stderr += `backup guard lock readiness timed out after ${GUARD_READINESS_TIMEOUT_MS}ms\n`;
          killDumpTree();
          gz.kill('SIGKILL');
        }, GUARD_READINESS_TIMEOUT_MS);
        let readinessBuffer = '';
        readiness.on('data', (d) => {
          readinessBuffer = `${readinessBuffer}${d.toString()}`.slice(-GUARD_READY_SIGNAL.length);
          if (readinessBuffer.includes(GUARD_READY_SIGNAL)) armDumpWatchdog();
        });
        readiness.on('error', (e) => {
          stderr += `backup guard readiness pipe failed: ${e.message}\n`;
          killDumpTree();
          try { gz.kill('SIGKILL'); } catch { /* already gone */ }
          void finalize(false);
        });
      }
    }

    let dumpClosed = false;
    let gzipClosed = false;
    let dumpCode: number | null = null;
    let gzipCode: number | null = null;
    const maybeFinalize = () => {
      if (dumpClosed && gzipClosed) {
        void finalize(dumpCode === 0 && gzipCode === 0);
      }
    };
    dump.on('close', (code: number | null) => {
      dumpClosed = true;
      dumpCode = code;
      if (code !== 0) stderr += `pg_dump exited ${code ?? 'null'}\n`;
      maybeFinalize();
    });
    gz.on('close', (code: number | null) => {
      gzipClosed = true;
      gzipCode = code;
      if (code !== 0) stderr += `gzip exited ${code ?? 'null'}\n`;
      maybeFinalize();
    });
  });
}

async function renameAtomic(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises');
  // POSIX rename replaces an existing regular file atomically. Unlinking the
  // destination first created a real missing-file window in which a concurrent
  // Kopia scan could omit the DB dump altogether.
  await rename(from, to);
}
