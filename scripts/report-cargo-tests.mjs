#!/usr/bin/env node
/**
 * report-cargo-tests.mjs — run a Rust crate's `cargo test` and record one row
 * PER TEST FUNCTION into harness_shared.test_runs (framework='cargo'), so the
 * Tests tab picks up native Rust coverage the same way it already does for
 * vitest (admin-test-runs-reporter.ts) and playwright
 * (admin-test-runs-reporter-playwright.ts).
 *
 * Plan production-test-readiness-2026-07-06 P-009: ~151-205 cargo #[test] fns
 * exist (papercusp-desktop/src-tauri, the Tauri shell) but harness_shared.test_runs
 * had ZERO framework=cargo rows — the desktop shell's native test signal was
 * invisible to the Tests tab. There is no cargo-nextest on this box and no
 * stable-toolchain machine-readable test output (`--format json` needs nightly
 * `-Z unstable-options`), so this parses PLAIN `cargo test` stdout — the
 * `test <qualified::name> ... ok|FAILED|ignored` lines plus the trailing
 * `---- <name> stdout ----` failure-detail blocks for output_tail.
 *
 * D-007 fail-soft contract (mirrors admin-test-runs-reporter.ts):
 *   - the recorder's own DB/network faults NEVER change this script's exit code
 *     — that exit code is cargo test's real pass/fail, for CI/agent use.
 *   - short connect timeout, swallow every PG error, never throw out of the
 *     insert path.
 *
 * Usage: node scripts/report-cargo-tests.mjs --manifest-path <path/to/Cargo.toml> [-- <cargo test args>]
 * Example: node scripts/report-cargo-tests.mjs --manifest-path papercusp-desktop/src-tauri/Cargo.toml
 *
 * Granularity note: stable `cargo test` gives no per-test source-file or duration
 * — only a qualified test path (e.g. `app_role::tests::role_from_env_defaults_to_gui`)
 * and pass/fail/ignored. Each test's `file_path` row is therefore
 * `<crate-dir>::<qualified::test::path>` (not a real filesystem path) so it stays
 * unique + greppable; duration_ms is null per-row (unknown), and the WHOLE
 * binary's wall-clock elapsed is recorded as one extra aggregate row
 * (`<crate-dir> (cargo aggregate)`) so the Tests tab still has a duration signal.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, statfsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';
import { readReservedBytes } from './lib/disk-reservations.mjs';
import {
  assessCargoDiskAdmission,
  cargoCoverageOutputPath,
  cargoRunExitCode,
  CARGO_DISK_REFUSAL_EXIT_CODE,
  ensureCargoCacheTag,
  cargoDiskPolicyFromEnv,
  classifyCargoRun,
  diskProbePathFor,
  formatCargoDiskRefusal,
  formatCargoResultLine,
  parseCargoTestResultLines,
  pruneStaleBuildScriptOutputs,
  reclaimInactiveCargoArtifacts,
  resolveCargoBin,
  resolveCargoTargetDir,
} from './lib/cargo-result.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
let loopLagMonitor = null;

function ensureLoopLagMonitor() {
  if (loopLagMonitor) return;
  try {
    loopLagMonitor = monitorEventLoopDelay({ resolution: 20 });
    loopLagMonitor.enable();
  } catch {
    loopLagMonitor = null;
  }
}

function captureReporterSaturationSnapshot() {
  let loopLagP95Ms = null;
  try {
    ensureLoopLagMonitor();
    const p95Ns = loopLagMonitor?.percentile(95);
    if (typeof p95Ns === 'number' && Number.isFinite(p95Ns)) {
      loopLagP95Ms = Math.round((p95Ns / 1_000_000) * 10) / 10;
    }
    loopLagMonitor?.reset();
  } catch {
    loopLagP95Ms = null;
  }

  let rssMb = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms, rssMb };
}

function parseArgs(argv) {
  const out = { manifestPath: null, cargoArgs: [], coverage: false, coverageOutput: null };
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--manifest-path') {
      out.manifestPath = argv[++i];
    } else if (argv[i] === '--coverage') {
      out.coverage = true;
    } else if (argv[i] === '--coverage-output') {
      out.coverageOutput = argv[++i];
    } else if (argv[i] === '--') {
      out.cargoArgs = argv.slice(i + 1);
      break;
    }
  }
  return out;
}

function runCargoTest(manifestAbs, extraArgs, coverage = null) {
  const startedAt = new Date();
  const diskPolicy = cargoDiskPolicyFromEnv();
  // WI-212675: measure the mount Cargo WRITES to. The target directory is
  // config-driven (`build.target-dir`) and on this box lives on a different
  // filesystem from the checkout, so probing the manifest's mount refused the
  // suite hourly over a disk Cargo never touches. Resolved once per run; the
  // probe below re-reads the SAME path every time it is called.
  const cargoTargetDir = resolveCargoTargetDir(manifestAbs);
  const diskProbePath = diskProbePathFor(cargoTargetDir);
  const readDiskAdmission = () => {
    try {
      const fsst = statfsSync(diskProbePath);
      // Space other live builds have already declared (EI-21951384112327922).
      // Read fresh on every probe, not once: the point is that this number moves
      // while we are deciding, and the post-reclaim re-measure below must see the
      // ledger as it is THEN. Fails open to 0.
      let reservedBytes = 0;
      try {
        reservedBytes = readReservedBytes(diskProbePath);
      } catch {
        reservedBytes = 0;
      }
      return {
        ...assessCargoDiskAdmission(
          {
            totalBytes: Number(fsst.blocks) * Number(fsst.bsize),
            freeBytes: Number(fsst.bavail) * Number(fsst.bsize),
            reservedBytes,
          },
          diskPolicy,
        ),
        probePath: diskProbePath,
        targetDir: cargoTargetDir,
      };
    } catch (err) {
      console.warn(`[report-cargo-tests] disk admission probe unreadable; continuing fail-open: ${err.message}`);
      return {
        ...assessCargoDiskAdmission({ totalBytes: Number.NaN, freeBytes: Number.NaN }, diskPolicy),
        probePath: diskProbePath,
        targetDir: cargoTargetDir,
      };
    }
  };

  let diskAdmission = readDiskAdmission();
  let reclaim = { reclaimed: 0, bytesReclaimed: 0, scanned: 0, skipped: [], dryRun: false };
  // The periodic janitors keep this path cheap during normal operation. When
  // the percentage/absolute alarm is approaching, run one bounded, producer-
  // aware sweep before refusing to spawn Cargo, then measure the same mount
  // again. A stale refusal must not persist merely because the janitor tick
  // missed a run (EI-21150371868241728).
  if (diskAdmission.status === 'blocked') {
    try {
      // Stop at the first artifact that makes the mount admissible: the caps
      // bound how much a sweep may take, but only this budget keeps it from
      // taking more than the refusal actually costs.
      // WI-954677: this sweep only ever runs when admission is ALREADY blocked
      // — the suite is refusing to spawn at all. At that moment the default
      // 24h age gate is measuring the wrong cost. `debug` is where `cargo test`
      // builds, so on any host that runs the suite more than once a day it is
      // permanently younger than 24h: the sweep reports `reclaimed: 0` and the
      // suite refuses while tens of GiB of its own output sit one directory
      // away. That is the exact failure the comment on CARGO_PROFILE_DIR_NAMES
      // describes; adding `debug` to the candidate set fixed the candidate
      // half and left the age half, so the refusal kept recurring (WI-41462
      // closed 2026-08-25, recurred by 2026-08-30 at 95% used / 99 GiB free —
      // the artifact that unblocked it by hand was 66 MINUTES old).
      //
      // Reclaiming here costs a rebuild; refusing costs the whole suite and
      // red-pins the gate, so a short age gate is correct on this path only.
      // Safety does NOT rest on the age gate: activeRunMarker (pid +
      // start_ticks), pathIsLive (open descriptors), the cargo slot lock and
      // the .papercusp-keep marker each veto reclamation independently, and
      // `stopWhen` halts at the first artifact that restores admissibility.
      // heartbeatTtlMs is deliberately NOT lowered — see its policy comment.
      reclaim = reclaimInactiveCargoArtifacts({
        policy: { cargoTtlMs: 10 * 60_000 },
        // The sweep must reach the target this run builds into even when it is
        // config-driven rather than env-driven (WI-212675): the home-dir scan
        // only finds `.cargo-target*` names.
        configuredTargetDir: cargoTargetDir,
        stopWhen: () => readDiskAdmission().allowed,
      });
      if (reclaim.reclaimed > 0) diskAdmission = readDiskAdmission();
      if (reclaim.reclaimed > 0) {
        console.warn(
          `[report-cargo-tests] reclaimed ${reclaim.reclaimed} inactive artifact(s) ` +
          `(${Math.floor(reclaim.bytesReclaimed / 1024 ** 3)} GiB) before Cargo admission; ` +
          `${reclaim.skipped.length} protected/skipped` +
          `${reclaim.stoppedEarly ? '; stopped at the admission budget' : ''}`,
        );
      }
    } catch (err) {
      // Cleanup is a best-effort pressure valve; an unexpected probe failure
      // must leave the authoritative admission decision fail-closed, not turn
      // a diagnostic into a new runner crash.
      console.warn(`[report-cargo-tests] artifact reclaim unavailable; continuing with disk admission: ${err.message}`);
    }
  }

  if (!diskAdmission.allowed) {
    return Promise.resolve({
      code: CARGO_DISK_REFUSAL_EXIT_CODE,
      stdout: '',
      stderr: formatCargoDiskRefusal(diskAdmission),
      startedAt,
      finishedAt: new Date(),
      diskAdmission,
    });
  }

  // WI-212675 (gate run 7f876d2d, 2026-09-03T19:26Z): a MOVED target dir leaves
  // cached build-script outputs pointing at the old address; cargo replays them
  // without re-running the script, and the dependent build.rs panics on a path
  // that no longer exists (exit 101, 0 results — indistinguishable from a
  // compile error). Prune those dirs so cargo re-runs exactly the affected
  // scripts. Skips wholesale when another build holds the target dir.
  try {
    const stalePrune = pruneStaleBuildScriptOutputs(cargoTargetDir);
    if (stalePrune.found > 0) {
      console.warn(
        `[report-cargo-tests] stale build-script outputs (moved target dir) under ${stalePrune.targetDir}: ` +
        `found ${stalePrune.found}, pruned ${stalePrune.pruned.length}, skipped ${stalePrune.skipped.length}` +
        (stalePrune.pruned[0] ? `; e.g. ${stalePrune.pruned[0].crate} → ${stalePrune.pruned[0].staleRef}` : '') +
        (stalePrune.skipped[0] ? `; skip reason: ${stalePrune.skipped[0].reason}` : ''),
      );
    }
  } catch (err) {
    console.warn(`[report-cargo-tests] stale build-script output scan unavailable; continuing: ${err.message}`);
  }

  const configuredTargetDir = process.env.CARGO_TARGET_DIR;
  if (configuredTargetDir) {
    try {
      // Cargo resolves a relative CARGO_TARGET_DIR from the child cwd below.
      // Initialize the marker before spawning Cargo so an exclusive cleanup
      // can safely use `cargo clean --target-dir` after this run exits.
      ensureCargoCacheTag(resolve(REPO_ROOT, configuredTargetDir));
    } catch (err) {
      return Promise.resolve({
        code: 1,
        stdout: '',
        stderr: `[report-cargo-tests] REFUSED before spawning Cargo: could not initialize CACHEDIR.TAG for ${configuredTargetDir}: ${err.message}`,
        startedAt,
        finishedAt: new Date(),
        diskAdmission,
      });
    }
  }

  return new Promise((resolvePromise) => {
    // P-010: `cargo llvm-cov` WRAPS `cargo test` — it runs the same harness and
    // passes the same `test <name> ... ok|FAILED|ignored` lines through stdout,
    // so every parser below (and the per-test ledger rows) works unchanged. The
    // only difference is the subcommand and the report flags.
    //
    // `--output-path` does NOT create its parent directory: cargo-llvm-cov runs
    // the whole suite and only then fails with `failed to create file ...
    // (os error 2)`, throwing away a completed instrumented run. Measured
    // 2026-09-03: 386/386 tests passed, then the report write lost all of it.
    // mkdir first so a green suite can never be discarded at the last step.
    const args = coverage
      ? [
          'llvm-cov',
          '--manifest-path', manifestAbs,
          '--no-fail-fast',
          '--lcov',
          '--output-path', coverage.outputPath,
          '--', '--test-threads=4', ...extraArgs,
        ]
      : ['test', '--manifest-path', manifestAbs, '--no-fail-fast', '--', '--test-threads=4', ...extraArgs];
    if (coverage) {
      try {
        mkdirSync(dirname(coverage.outputPath), { recursive: true });
      } catch (err) {
        resolvePromise({
          code: 1,
          stdout: '',
          stderr: `[report-cargo-tests] REFUSED before spawning Cargo: could not create the coverage output directory ${dirname(coverage.outputPath)}: ${err.message}`,
          startedAt,
          finishedAt: new Date(),
          diskAdmission,
        });
        return;
      }
    }
    const child = spawn(resolveCargoBin(), args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr, startedAt, finishedAt: new Date(), diskAdmission });
    });
    child.on('error', (err) => {
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\nspawn error: ${err.message}`, startedAt, finishedAt: new Date(), diskAdmission });
    });
  });
}

/** Parse the `---- <name> stdout ----\n<body>` failure-detail blocks cargo prints
 *  under a trailing `failures:` section, keyed by test name, for output_tail. */
function parseFailureDetails(output) {
  const details = new Map();
  const re = /---- (\S+) stdout ----\n([\s\S]*?)(?=\n---- \S+ stdout ----|\nfailures:|\ntest result:|$)/g;
  let m;
  while ((m = re.exec(output))) {
    details.set(m[1], m[2].trim().slice(-4000));
  }
  return details;
}

async function tryGetPg() {
  try {
    const mod = await import('postgres');
    const pg = mod.default ?? mod;
    return pg(resolveScriptPgUrl().url, { max: 2, connect_timeout: 2, onnotice: () => {} });
  } catch {
    return null;
  }
}

async function insertRows(sql, rows) {
  if (!sql) return 0;
  let inserted = 0;
  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();
  for (const row of rows) {
    try {
      await Promise.race([
        sql`
          INSERT INTO harness_shared.test_runs
            (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, source, loop_lag_p95_ms, rss_mb)
          VALUES
            (${row.filePath}, 'cargo', ${row.status}, ${row.durationMs}, ${row.startedAt}, ${row.finishedAt}, ${row.outputTail}, ${row.source}, ${loopLagP95Ms}, ${rssMb})
        `,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 2000)),
      ]);
      inserted++;
    } catch {
      /* swallow — D-007: a broken ledger must never fail the test run */
    }
  }
  return inserted;
}

async function main() {
  const { manifestPath, cargoArgs, coverage: coverageRequested, coverageOutput } = parseArgs(process.argv.slice(2));
  if (!manifestPath) {
    console.error('usage: report-cargo-tests.mjs --manifest-path <path/to/Cargo.toml> [--coverage [--coverage-output <lcov>]] [-- <cargo test args>]');
    process.exit(2);
  }
  const manifestAbs = resolve(REPO_ROOT, manifestPath);
  const crateDir = relative(REPO_ROOT, dirname(manifestAbs)).split(sep).join('/');
  const coverage = coverageRequested
    ? { outputPath: coverageOutput ? resolve(REPO_ROOT, coverageOutput) : cargoCoverageOutputPath(manifestAbs) }
    : null;

  ensureLoopLagMonitor();
  console.log(
    coverage
      ? `[report-cargo-tests] running: cargo llvm-cov --manifest-path ${manifestPath} --no-fail-fast --lcov --output-path ${relative(REPO_ROOT, coverage.outputPath).split(sep).join('/')}`
      : `[report-cargo-tests] running: cargo test --manifest-path ${manifestPath} --no-fail-fast`,
  );
  const { code, stdout, stderr, startedAt, finishedAt, diskAdmission } = await runCargoTest(manifestAbs, cargoArgs, coverage);
  const combined = `${stdout}\n${stderr}`;
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);

  const results = parseCargoTestResultLines(combined);
  const failureDetails = parseFailureDetails(combined);
  const source = process.env.CI ? 'ci' : 'local';
  const cargoResult = diskAdmission?.status === 'blocked'
    ? {
        status: 'error',
        termination: null,
        cause: 'low-disk-admission-refused',
        disk: { usedPct: diskAdmission.usedPct, freeGiB: diskAdmission.freeGiB },
      }
    : classifyCargoRun({ code, output: combined, resultCount: results.length });

  const rows = results.map((r) => ({
    filePath: `${crateDir}::${r.name}`,
    status: r.outcome === 'ok' ? 'pass' : r.outcome === 'ignored' ? 'skip' : 'fail',
    durationMs: null,
    startedAt,
    finishedAt,
    outputTail: r.outcome === 'FAILED' ? (failureDetails.get(r.name) ?? null) : null,
    source,
  }));

  // One aggregate row for the whole binary so the Tests tab has a duration signal
  // even though stable `cargo test` gives no per-test timing.
  const anyFail = results.some((r) => r.outcome === 'FAILED');
  rows.push({
    filePath: `${crateDir} (cargo aggregate)`,
    status: cargoResult.status === 'killed' ? 'error' : results.length === 0 ? 'error' : anyFail ? 'fail' : 'pass',
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    startedAt,
    finishedAt,
    outputTail: results.length === 0 ? combined.slice(-4000) : null,
    source,
  });

  if (results.length === 0 && diskAdmission?.status !== 'blocked') {
    const suffix = cargoResult.termination
      ? ` — cargo process was killed by ${cargoResult.termination.signalName} (signal ${cargoResult.termination.signal})`
      : '';
    console.error(`[report-cargo-tests] WARNING: parsed 0 test result lines from cargo test output (exit code ${code})${suffix} — recording a single error aggregate row.`);
  }

  // Emit this after the child output so the discriminator is retained in the
  // fixed-size tail used by affected-tests and background gate notifications.
  console.log(formatCargoResultLine(cargoResult));

  const sql = await tryGetPg();
  const inserted = await insertRows(sql, rows);
  if (sql) {
    try { await sql.end({ timeout: 2 }); } catch { /* swallow */ }
  }
  console.log(`[report-cargo-tests] parsed ${results.length} test results; inserted ${inserted}/${rows.length} rows (framework=cargo) into harness_shared.test_runs.`);

  // The wrapper's exit code reflects cargo test's REAL outcome — never the
  // recorder's own DB fault (D-007: ledger health must never gate the test run).
  // A zero-result run is an invalid measurement even when Cargo returned 0.
  process.exit(cargoRunExitCode({ code, resultCount: results.length }));
}

main();
