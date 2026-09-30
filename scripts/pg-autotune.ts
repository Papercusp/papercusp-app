#!/usr/bin/env tsx
/**
 * pg-autotune — apply HOST-SCALED PostgreSQL server settings to a NATIVE PG.
 *
 * The embedded Postgres that ships with the desktop autoadjusts at boot (its
 * `-c` flags are fed from resource-profile in apps/operator/bin/serve.ts). A
 * NATIVE PostgreSQL (a dev box or a dedicated server, where PG is a system
 * service we don't launch) can't be tuned that way — so this script is its arm:
 * it derives the SAME knobs from the SAME source of truth
 * (`@papercusp/resource-profile` → deriveDatabaseTuning), writes them to a
 * non-destructive `conf.d` drop-in, restarts PG, and verifies it came back up —
 * rolling the drop-in back automatically if it didn't.
 *
 * Nothing is hardcoded for one machine: the numbers come from detected cores +
 * RAM, so the same command does the right thing on a laptop and on a 128-core
 * server.
 *
 *   npx tsx scripts/pg-autotune.ts            # --print: derived settings + live drift, change nothing
 *   npx tsx scripts/pg-autotune.ts --check    # exit 1 if the live cluster or the drop-in has drifted
 *   npx tsx scripts/pg-autotune.ts --apply    # write the drop-in + RELOAD (restart only if forced to)
 *
 * Flags:
 *   --apply                 actually write + apply (default is print-only)
 *   --check                 report drift and exit non-zero on any; writes nothing
 *   --huge-pages            opt in to huge_pages=on (requires a restart; default
 *                           leaves the safe reload-only planner apply path intact)
 *   --restart               force a full restart even when a reload would do
 *   --confd   <dir>         conf.d directory (default /etc/postgresql/18/main/conf.d)
 *   --service <unit>        systemd unit to restart (default postgresql@18-main.service)
 *   --port    <n>           port to verify against (default 5432)
 *   --nr-hugepages <path>   kernel reservation counter (default /proc/sys/vm/nr_hugepages)
 *
 * ── Why --apply RELOADS by default (EI-19314331871893219) ────────────────────
 * This script used to restart PostgreSQL unconditionally. On a shared box with a
 * whole fleet connected, that is disruptive enough that nobody runs it — so the
 * next agent needing a knob HAND-APPENDS it to the managed drop-in instead, the
 * live config forks from `databaseTuningToSettings()`, and every setting added
 * since the last real --apply is dropped with no error anywhere. That is not
 * hypothetical: `max_slot_wal_keep_size` (the WAL disk-fill-SPOF defense, WI-347)
 * and `shared_preload_libraries` (P-020) both sat unapplied for weeks exactly
 * that way, while the source, its tests and its comments all said otherwise.
 *
 * Most of what we emit is SIGHUP-reloadable, so the honest default is: write the
 * file, reload, and restart ONLY when a postmaster-context setting actually
 * changed (asked of the live server, not assumed). Hand-editing then has no
 * reason to happen — and --check makes a fork loud if it does.
 *
 * Requires passwordless sudo for the write + reload/restart (writes a
 * postgres-owned file and signals a system service). A restart briefly drops all
 * connections; pooled clients reconnect. A reload drops nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  databaseTuningToSettings,
  deriveDatabaseTuning,
  detectResourceSignals,
  diffPgSettings,
  requiredPgHugePagesForTarget,
  type PgLiveSetting,
} from '@papercusp/resource-profile';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const opt = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const apply = has('--apply');
const check = has('--check');
const enableHugePages = has('--huge-pages');
const forceRestart = has('--restart');

// The scheduled host dump already holds this flock for its whole pg_dump
// lifecycle. Re-enter under the SAME lock before deriving or writing settings:
// a restart while pg_dump is copying closes its connection and fails the whole
// backup. The child retains the lock until apply and live verification finish.
// A scheduled backup that arrives during this short maintenance window sees its
// existing EX_TEMPFAIL path and retries on its timer.
if (apply && process.env.PAPERCUSP_PG_AUTOTUNE_BACKUP_LOCK_HELD !== '1') {
  const backupLock = process.env.PC_BACKUP_LOCK || join(homedir(), '.cache/papercusp/db-backup.lock');
  mkdirSync(dirname(backupLock), { recursive: true });
  const guarded = spawnSync(
    'flock',
    ['-n', '-E', '200', backupLock, 'npx', 'tsx', process.argv[1], ...args],
    {
      stdio: 'inherit',
      env: { ...process.env, PAPERCUSP_PG_AUTOTUNE_BACKUP_LOCK_HELD: '1' },
    },
  );
  if (guarded.status === 200) {
    console.error(`PostgreSQL apply deferred: host backup holds ${backupLock}; retry after the dump finishes.`);
  } else if (guarded.error) {
    console.error(`PostgreSQL apply could not establish the backup lock: ${guarded.error.message}`);
  }
  process.exit(guarded.status === 200 ? 75 : (guarded.status ?? 1));
}

const confDir = opt('--confd', '/etc/postgresql/18/main/conf.d');
const service = opt('--service', 'postgresql@18-main.service');
const port = opt('--port', '5432');
const nrHugePagesPath = opt('--nr-hugepages', '/proc/sys/vm/nr_hugepages');
const dropIn = join(confDir, '10-papercusp-autotune.conf');

// Native PG = a dedicated DB (embeddedPg:false) → the textbook PGTune fractions.
const signals = detectResourceSignals({ embeddedPg: false });
const tuning = deriveDatabaseTuning(signals);
const settings = databaseTuningToSettings(tuning);
const gib = (signals.totalMemBytes / 1024 ** 3).toFixed(0);

const sleep = (ms: number) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SAB unavailable — skip the wait */
  }
};
const sudo = (file: string, ...a: string[]) =>
  execFileSync('sudo', ['-n', file, ...a], { encoding: 'utf8' });
const psql = (q: string): string | null => {
  try {
    return execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-p', port, '-tAc', q], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null; // wedged / unreachable — best-effort
  }
};

/** The live server's own view of the GUCs we intend to set. null ⇒ unreachable. */
const readLiveSettings = (names: readonly string[]): PgLiveSetting[] | null => {
  const list = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const out = psql(
    `SELECT name || E'\\t' || setting || E'\\t' || coalesce(unit,'') || E'\\t' || context ` +
      `FROM pg_settings WHERE name IN (${list})`,
  );
  if (out === null) return null;
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, setting, unit, context] = l.split('\t');
      return { name, setting, unit: unit || null, context: context || null };
    });
};

console.log(`host: ${signals.cores} cores, ${gib} GiB RAM — tuning NATIVE PG (dedicated)`);
const liveMax = psql('show max_connections');
const liveSb = psql('show shared_buffers');
if (liveMax) console.log(`current (live):  max_connections=${liveMax}  shared_buffers=${liveSb ?? '?'}`);
else console.log('current (live):  <unreachable — PG is wedged or down>');

// Persist pg_stat_statements so a FRESH host re-provision keeps query telemetry.
// Today it lives only in a manual conf.d/20 drop-in, which survives deploys but
// NOT a fresh provision — so re-running this script (the provision arm) silently
// drops query stats. Bake it into the managed drop-in instead. Union with whatever
// is already loaded so we never DROP a lib another mechanism added. shared_preload_
// libraries is postmaster-level (needs a restart), which --apply already does.
// (infra-perf-reliability-audit-round4 P-020.)
const livePreload = psql('show shared_preload_libraries') ?? '';
const preloadLibs = Array.from(
  new Set(
    [...livePreload.split(','), 'pg_stat_statements'].map((s) => s.trim()).filter(Boolean),
  ),
);
const preloadValue = `'${preloadLibs.join(',')}'`;

/** Everything we intend the cluster to be running — the map plus the applier's own knob. */
const target: Record<string, string> = {
  ...settings,
  shared_preload_libraries: preloadValue,
};

// huge_pages is postmaster-context and cannot be made live by the normal,
// reload-only planner apply. Keep it an explicit opt-in so a safe planner
// refresh never turns into an unannounced shared PostgreSQL restart.
if (enableHugePages) target.huge_pages = 'on';

// shared_memory_size_in_huge_pages describes the CURRENT cache. A shrink must
// subtract the old cache before adding the target cache, or the old 64 GiB
// estimate wrongly rejects a valid 18,000-page pool for the new 32 GiB target.
// The shared resource-profile helper retains measured non-buffer overhead and
// a conservative 1,024-page floor if the current cluster is unreachable.
const pgHugePagesEstimate = Number(psql('show shared_memory_size_in_huge_pages'));
const requiredHugePages = requiredPgHugePagesForTarget(
  tuning.sharedBuffersMb,
  liveSb,
  pgHugePagesEstimate,
);
let reservedHugePages: number | null = null;
try {
  const parsed = Number(readFileSync(nrHugePagesPath, 'utf8').trim());
  if (Number.isSafeInteger(parsed) && parsed >= 0) reservedHugePages = parsed;
} catch {
  reservedHugePages = null;
}

console.log('derived (target):');
for (const [k, v] of Object.entries(target)) console.log(`  ${k} = ${v}`);
console.log(
  `huge-page reservation: ${reservedHugePages ?? '<unreadable>'} reserved, ` +
    `${requiredHugePages} required before restart`,
);

const content =
  [
    '# Managed by scripts/pg-autotune.ts — host-scaled PostgreSQL tuning.',
    '# Derived from detected cores/RAM via @papercusp/resource-profile.',
    '# Additive override (read after postgresql.conf); delete + restart to revert.',
    `# Host: ${signals.cores} cores, ${gib} GiB RAM.`,
    '',
  ].join('\n') +
  Object.entries(target)
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n') +
  '\n';

/* ── Drift report ─────────────────────────────────────────────────────────────
 * Two independent questions, because they fail independently:
 *   1. is the LIVE SERVER running what we derive?  (pg_settings vs target)
 *   2. is the DROP-IN ON DISK the file we generate? (bytes vs bytes)
 * (2) catches a hand-edit even when it happens to leave (1) clean — which is the
 * shape that hid two unapplied settings for weeks. Neither alone is sufficient.
 */
const live = readLiveSettings(Object.keys(target));
const drift = live ? diffPgSettings(target, live) : null;

let fileOnDisk: string | null = null;
try {
  fileOnDisk = readFileSync(dropIn, 'utf8');
} catch {
  fileOnDisk = null; // not written yet
}
const fileDrift = fileOnDisk !== content;

console.log('\ndrift:');
if (!drift) {
  console.log('  live cluster: <unreachable — PG is wedged or down; cannot compare>');
} else if (drift.inSync) {
  console.log('  live cluster: ✓ every derived setting matches');
} else {
  for (const d of drift.diverged) {
    console.log(`  live cluster: ✗ ${d.name}: live=${d.live} target=${d.target}` +
      `${d.restartOnly ? '  [restart-only]' : '  [reloadable]'}`);
  }
}
if (drift?.unknown.length) {
  console.log(`  not present on this server (ignored): ${drift.unknown.join(', ')}`);
}
if (fileOnDisk === null) {
  console.log(`  drop-in:      ✗ ${dropIn} does not exist`);
} else if (fileDrift) {
  console.log(`  drop-in:      ✗ ${dropIn} differs from the generated content ` +
    `(hand-edited, or written by an older revision)`);
} else {
  console.log('  drop-in:      ✓ byte-identical to the generated content');
}

if (check) {
  const bad = fileDrift || (drift ? !drift.inSync : true);
  if (bad) {
    console.error(
      '\n✗ DRIFT. The live cluster and/or the managed drop-in do not match the tuning ' +
        'source of truth (databaseTuningToSettings). Re-run with --apply.',
    );
    process.exit(1);
  }
  console.log('\n✓ no drift.');
  process.exit(0);
}

if (!apply) {
  console.log('\n--print only. Re-run with --apply to write the drop-in and apply it.');
  process.exit(0);
}

if (enableHugePages && (reservedHugePages === null || reservedHugePages < requiredHugePages)) {
  console.error(
    `\n✗ refusing to enable huge_pages=on: kernel reservation is ` +
      `${reservedHugePages ?? 'unreadable'}, but PostgreSQL needs at least ${requiredHugePages}.\n` +
      `  Install/enable apps/operator/scripts/systemd/papercusp-host-performance.service ` +
      `and reboot so its 18,000-page reservation runs before ${service}; then re-run --apply. ` +
      `No PostgreSQL config was changed.`,
  );
  process.exit(1);
}

const tmp = join(tmpdir(), 'papercusp-autotune.conf');
writeFileSync(tmp, content, 'utf8');

// Restore the file we found (not `rm`, which would ALSO drop every setting the
// previous drop-in was correctly applying) and put the server back on it.
const rollback = (viaRestart: boolean) => {
  console.error('rolling back the drop-in to its prior content…');
  try {
    if (fileOnDisk === null) {
      sudo('rm', '-f', dropIn);
    } else {
      const prev = join(tmpdir(), 'papercusp-autotune.prev.conf');
      writeFileSync(prev, fileOnDisk, 'utf8');
      sudo('cp', prev, dropIn);
      sudo('chown', 'postgres:postgres', dropIn);
      sudo('chmod', '644', dropIn);
    }
  } catch {
    /* ignore */
  }
  try {
    if (viaRestart) sudo('systemctl', 'restart', service);
    else psql('select pg_reload_conf()');
  } catch {
    /* ignore */
  }
};

// Restart ONLY when a postmaster-context setting actually changed — asked of the
// live server (pg_settings.context), not assumed. `--restart` forces it; an
// unreachable server can't be asked, so it is the one case we fall back to a
// restart, which is also the only thing that can revive a wedged postmaster.
const restartNames = drift?.restartRequired ?? [];
const needsRestart = forceRestart || !drift || restartNames.length > 0;

console.log(`\nwriting ${dropIn}`);
sudo('cp', tmp, dropIn);
sudo('chown', 'postgres:postgres', dropIn);
sudo('chmod', '644', dropIn);

if (needsRestart) {
  const why = forceRestart
    ? '--restart forced'
    : !drift
      ? 'live settings unreadable — cannot prove a reload is enough'
      : `postmaster-context change: ${restartNames.join(', ')}`;
  console.log(`restarting ${service} (brief connection drop; ${why})…`);
  try {
    sudo('systemctl', 'restart', service);
  } catch (e) {
    console.error(`restart command failed: ${(e as Error).message}`);
    rollback(true);
    process.exit(1);
  }

  // Verify PG accepts connections again with the new config.
  let up = false;
  for (let i = 0; i < 30; i++) {
    if (psql('select 1') === '1') {
      up = true;
      break;
    }
    sleep(1000);
  }
  if (!up) {
    console.error('PG did not accept connections within 30s after restart.');
    rollback(true);
    process.exit(1);
  }
} else {
  console.log('reloading config (SIGHUP — no connection drop; nothing postmaster-level changed)…');
  if (psql('select pg_reload_conf()') !== 't') {
    console.error('pg_reload_conf() did not return true.');
    rollback(false);
    process.exit(1);
  }
  sleep(500); // the postmaster re-reads and signals backends asynchronously
}

// Verify against the SAME target we diffed, rather than spot-checking two knobs
// by hand — a bespoke check per setting is how the two unapplied ones stayed
// invisible. Anything still divergent means something else wins (a later conf.d
// file, an ALTER SYSTEM override, or a value PG silently clamped).
const after = readLiveSettings(Object.keys(target));
const residual = after ? diffPgSettings(target, after) : null;
if (!residual) {
  console.error('\n✗ applied, but the live settings are unreadable — verify by hand.');
  process.exit(1);
}
if (residual.inSync) {
  const hugePagesStatus = enableHugePages ? psql('show huge_pages_status') : null;
  if (enableHugePages && hugePagesStatus !== 'on') {
    console.error(
      `\n✗ settings match, but PostgreSQL reports huge_pages_status=${hugePagesStatus ?? '<unreadable>'}; ` +
        `the kernel-backed allocation is not active.`,
    );
    process.exit(1);
  }
  console.log(`\n✓ applied${needsRestart ? ' (restart)' : ' (reload, no downtime)'}. ` +
    `All ${Object.keys(target).length} derived settings are live${enableHugePages ? '; huge_pages_status=on.' : '.'}`);
} else {
  console.error(`\n✗ applied, but ${residual.diverged.length} setting(s) did NOT take effect:`);
  for (const d of residual.diverged) {
    console.error(`    ${d.name}: live=${d.live} target=${d.target}` +
      (d.restartOnly ? '  (needs a restart — re-run with --restart)' : ''));
  }
  console.error(
    '  A later conf.d file or an ALTER SYSTEM override may win. The drop-in was ' +
      'left in place; nothing was rolled back.',
  );
  process.exit(1);
}
