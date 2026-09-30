/**
 * Host-dump coverage — refuse to re-dump a database the host backup already dumped.
 *
 * `runPreSnapshotHook` resolves its target with `backupHost().getHarnessAdminUrl()`,
 * a ZERO-ARGUMENT host-level function. It takes no workspace parameter, so it
 * cannot return a per-workspace database: on a deployment where every workspace
 * resolves to the same host cluster, the hook dumps that ONE database once per
 * workspace per interval while the hourly systemd job (`papercusp-db-backup.sh`)
 * dumps it again. Measured 2026-08-30 (EI-21874492117996483): three ~2.5 GB
 * dumps/hour of a single database, whose overlap with the host job drove pg_dump
 * to ~161 KB/s and produced three 900 s watchdog timeouts, while the same dump
 * clear of the host job ran at ~9.4 MB/s — a ~58x difference against an unchanged
 * budget. The contention was not two legitimate jobs colliding; it was one
 * database being backed up twice, concurrently, by two mechanisms.
 *
 * This restores the boundary the hook's own docblock already states ("The hook
 * only handles per-workspace state. Host PG (:5432) ... are the systemd kopia
 * job's concern, not this one") — but PROVES coverage rather than assuming it.
 *
 * FAIL-SAFE IN EVERY DIRECTION. The skip requires positive evidence that this
 * EXACT cluster was dumped successfully and recently. A missing receipt, an
 * unparseable one, a stale one, a failed run, a missing or mismatched cluster
 * identity, or a database absent from the receipt's `dumped` list all fall
 * through to dumping as before. A deployment with no host job — the desktop ship
 * target — therefore never skips, because it never produces a receipt.
 *
 * Since WI-2146225 the host producer may replace the undifferentiated
 * `papercusp` artifact with an authoritative `papercusp-state` /
 * `papercusp-transcript` pair. The workspace hook omits the transcript tables,
 * so a successful state tier is sufficient coverage for the hook's data subset;
 * it is accepted only when the receipt explicitly advertises tier mode.
 *
 * COVERAGE IS PER ARTIFACT, NOT PER RUN (EI-24018312041976584). A host run that
 * dumps the state tier and then skips the transcript tier for disk space writes
 * `ok: false`, but its `dumped` list still proves the state tier was written.
 * Treating the whole run as "not ok" made every workspace hook on the host dump
 * the same cluster itself, every hour. Measured 2026-09-23 00:00-02:48Z on the
 * tower: four workspace hooks, ten full dumps, one success, and nine discarded
 * after the 900 s watchdog or a gzip EPIPE. Each one swept the 64 GB
 * swappable shared_buffers and drove the host into swap-in thrash. So a not-ok
 * receipt still covers an artifact its last run dumped. That run's START
 * (`lastRunEpoch - elapsedSec`) dates the artifact, and it must pass the same
 * freshness bound as a successful run. A not-ok receipt with no run timing
 * falls through to dumping.
 *
 * Cluster identity is `pg_control_system().system_identifier`, a 64-bit value
 * generated at initdb. It is deliberately NOT a host:port or database-name
 * comparison, because both are unsafe here:
 *   - the host job connects over the unix socket while the hook connects over
 *     TCP, so their endpoints never match textually even when they are the same
 *     server; and
 *   - a workspace's EMBEDDED Postgres routinely holds a database *named*
 *     `papercusp` on a DIFFERENT cluster, which a name-only test would wrongly
 *     report as covered — silently disabling that workspace's only real dump.
 * Nor is the resolver's `source` label usable: it reads `env` both on this box
 * (host PG via HARNESS_ADMIN_DATABASE_URL) and in the desktop app (embedded PG
 * injected by Tauri main), so it cannot separate the two cases.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Directory holding the host backup's `STATUS.json` receipt.
 *
 * `papercusp-db-backup.sh` honors the same environment variable with the same
 * default, and `host-dump-coverage-defaults.test.ts` pins the two together so
 * the pair cannot drift into a silent no-skip.
 */
export const HOST_PG_DUMP_DIR_ENV = 'PAPERCUSP_HOST_PG_DUMP_DIR';
// Moved off /mnt/data/Backup/db-dumps on 2026-09-05 (WI-2146225) in lockstep
// with the shell default — see the note in papercusp-db-backup.sh. The old
// value pointed at a directory the 2026-09-05 relocation abandoned, so a reader
// that fell back to it found a STATUS.json frozen at the relocation instant and
// concluded coverage from a receipt that had stopped being written.
export const DEFAULT_HOST_PG_DUMP_DIR = '/mnt/backup/db-dumps';

/**
 * How recent the host dump must be for the hook to stand down.
 *
 * The host timer is `OnCalendar=hourly` with `Persistent=true`. Three hours
 * tolerates one missed run plus a long dump without ever letting a wedged host
 * job silently suppress workspace dumps indefinitely: once the receipt ages out,
 * every workspace resumes dumping on its own.
 */
export const HOST_DUMP_MAX_AGE_SEC = 3 * 60 * 60;

/** The subset of `STATUS.json` this decision consumes. Fields are `unknown` because the file is written by a shell script and parsed defensively. */
export interface HostDumpStatus {
  ok?: unknown;
  lastSuccessEpoch?: unknown;
  /** End of the LAST run, successful or not; pairs with `dumped` and `elapsedSec`. */
  lastRunEpoch?: unknown;
  /** Duration of the last run, so `lastRunEpoch - elapsedSec` is when it started. */
  elapsedSec?: unknown;
  /** Artifacts the LAST run dumped successfully, even when another artifact failed. */
  dumped?: unknown;
  tiersEnabled?: unknown;
  systemIdentifier?: unknown;
}

export interface HostDumpCoverage {
  /** True ⇒ the host job demonstrably dumped this exact database on this exact cluster, recently. */
  covered: boolean;
  /** Human-readable justification, logged verbatim to the workspace hook.log. */
  reason: string;
}

/** Absolute path to the host backup receipt. */
export function hostDumpStatusPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[HOST_PG_DUMP_DIR_ENV]?.trim() || DEFAULT_HOST_PG_DUMP_DIR;
  return join(dir, 'STATUS.json');
}

/** Read + parse the host receipt. Any failure ⇒ null ⇒ the caller dumps. */
export async function readHostDumpStatus(path: string): Promise<HostDumpStatus | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as HostDumpStatus;
  } catch {
    return null;
  }
}

/**
 * Decide whether the host backup already covers this database on this cluster.
 *
 * Pure and total: every branch returns a reason, and every uncertain branch
 * returns `covered: false`.
 */
export function evaluateHostDumpCoverage(input: {
  database: string;
  /** `system_identifier` of the cluster the hook is about to dump; null when unprobeable. */
  targetSystemIdentifier: string | null;
  status: HostDumpStatus | null;
  nowEpoch: number;
  maxAgeSec?: number;
}): HostDumpCoverage {
  const { database, targetSystemIdentifier, status, nowEpoch } = input;
  const maxAgeSec = input.maxAgeSec ?? HOST_DUMP_MAX_AGE_SEC;

  if (!status) return { covered: false, reason: 'no host-dump receipt' };
  const runOk = status.ok === true;

  // Identity must be present on BOTH sides and equal. A receipt written before
  // the identity field existed yields `undefined` here, so an old receipt
  // degrades to "dump as before" rather than to an unproven skip.
  const hostId = typeof status.systemIdentifier === 'string' ? status.systemIdentifier.trim() : '';
  if (!hostId) return { covered: false, reason: 'host-dump receipt has no cluster identity' };
  if (!targetSystemIdentifier) return { covered: false, reason: 'could not probe target cluster identity' };
  if (hostId !== targetSystemIdentifier) {
    return {
      covered: false,
      reason: `different cluster (target ${targetSystemIdentifier} != host-dump ${hostId})`,
    };
  }

  const dumped = Array.isArray(status.dumped)
    ? status.dumped.filter((d): d is string => typeof d === 'string')
    : [];
  const directArtifact = dumped.includes(database);
  const tieredStateArtifact = `${database}-state`;
  const tieredState = status.tiersEnabled === true && dumped.includes(tieredStateArtifact);
  if (!directArtifact && !tieredState) {
    return {
      covered: false,
      reason: runOk
        ? `database ${database} not in host-dump receipt`
        : `host dump last reported not-ok and its last run did not dump ${database}`,
    };
  }

  let artifactEpoch: number;
  let basis: string;
  if (runOk) {
    artifactEpoch = finiteNumber(status.lastSuccessEpoch) ?? 0;
    if (artifactEpoch <= 0) return { covered: false, reason: 'host-dump receipt has no success timestamp' };
    basis = 'dumped';
  } else {
    // `dumped` lists only artifacts the last run completed, so a not-ok run
    // still proves them. Date them from the run's start, the earliest moment
    // their data could reflect, so the freshness bound stays conservative.
    const lastRun = finiteNumber(status.lastRunEpoch);
    const elapsed = finiteNumber(status.elapsedSec);
    if (lastRun === null || lastRun <= 0 || elapsed === null || elapsed < 0) {
      return {
        covered: false,
        reason: 'host dump last reported not-ok and the receipt lacks the run timing needed to date its dumped artifacts',
      };
    }
    artifactEpoch = lastRun - elapsed;
    basis = 'dumped by a partially failed run that started';
  }

  const ageSec = nowEpoch - artifactEpoch;
  // A receipt from the future is a clock fault, not evidence of coverage.
  if (ageSec < 0) return { covered: false, reason: 'host-dump receipt timestamp is in the future' };
  if (ageSec > maxAgeSec) {
    return { covered: false, reason: `host dump is stale (${ageSec}s > ${maxAgeSec}s)` };
  }

  return {
    covered: true,
    reason: `host PG is covered by db-backup.sh (cluster ${hostId}, database ${database}, artifact ${directArtifact ? database : tieredStateArtifact}, ${basis} ${ageSec}s ago)`,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Probe `system_identifier` of the cluster the hook is about to dump, reusing the
 * dump's own connection parameters so the answer describes the same server
 * pg_dump would reach.
 *
 * Never throws and never rejects: a missing `psql`, an auth failure, a timeout,
 * or unparseable output all resolve to null, which the decision above treats as
 * "not proven ⇒ dump".
 */
export function probeSystemIdentifier(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  timeoutMs?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* the probe is advisory; a kill failure must not surface */
      }
      done(null);
    }, opts.timeoutMs ?? 10_000);

    try {
      child = spawn(
        'psql',
        [
          '-h', opts.host,
          '-p', String(opts.port),
          '-U', opts.user,
          '-w',
          '-d', opts.database,
          '-tAc', 'SELECT system_identifier FROM pg_control_system()',
        ],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, PGPASSWORD: opts.password, PGCONNECT_TIMEOUT: '5' },
        },
      );
    } catch {
      done(null);
      return;
    }

    // Chunk-safe accumulation (WI-6728): decoding each 'data' chunk on its own
    // turns a multi-byte character split across two events into replacement
    // chars. Hold the raw Buffers and decode ONCE at close instead. This package
    // deliberately has no dependencies — operator-core depends on it, so the
    // shared `createTextCollector` helper would be a dependency cycle — hence
    // the local form rather than the usual import.
    const chunks: Buffer[] = [];
    let outBytes = 0;
    child.stdout?.on('data', (c: Buffer) => {
      // Bound the buffer: this reads one integer, and an unexpected torrent
      // (a wrong -c, a chatty wrapper) must not accumulate unboundedly.
      if (outBytes < 4096) {
        chunks.push(c);
        outBytes += c.length;
      }
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) return done(null);
      const id = Buffer.concat(chunks).toString().trim().split(/\s+/)[0] ?? '';
      done(/^\d+$/.test(id) ? id : null);
    });
  });
}
