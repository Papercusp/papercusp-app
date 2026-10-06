'use strict';
// PC_HEAVY_PRELOAD_V1 — heavy-job admission preload for hosted workspace hosts.
// WI-10005296; design authority: plan agent-capacity-and-cost-gcp-2026-09-30, D-031 ruling 2a.
//
// Loaded into EVERY node process of a hosted agent via a fixed, operator-set
//   NODE_OPTIONS=--require=<customer toolchain>/heavy-admission.cjs
// It looks at process.argv[1]. When that is a heavy entrypoint (vitest, tsc, tsgo), it replaces
// the process with the SAME command run under scripts/pc-heavy.sh, so the job waits for a memory
// slot before it starts. Matching on the resolved entrypoint catches `npx vitest`, `npm test`,
// `node_modules/.bin/tsc` and a globally installed tsc alike, with no per-checkout state: hosted
// agents work in arbitrary customer checkouts whose `npm install` rewrites node_modules/.bin, so a
// .bin shim (the capacity-rig mechanism, scripts/agent-capacity/vm/heavy-shim.sh) cannot reach them.
//
// Every other node process (npm itself, the agent CLI, dev servers) pays one basename compare and
// returns. Nothing here may throw: a preload error would break every node process the agent runs.
//
// Re-entry: pc-heavy exports PC_HEAVY_BYPASS=1 into its child, so the re-run command (and every
// node process under it, e.g. vitest's forked workers) skips admission. Without that, K slots would
// deadlock on the first nested call.
//
// Not admitted, on purpose:
//   - informational calls (--version, --help, tsc --init / --showConfig): they finish in
//     milliseconds and must not queue behind a full pool;
//   - EXPLICIT watch mode (tsc -w/--watch, vitest watch/dev/--watch/-w): it never exits, so it
//     would hold a slot for the whole session. vitest's IMPLICIT watch (no `run` on a TTY) is not
//     detected; it is admitted and holds its slot until it exits.
//
// Env:
//   PC_HEAVY_BYPASS=1           skip admission (set by pc-heavy for its child; also an escape hatch).
//   PC_HEAVY_ADMISSION_SCRIPT   pc-heavy path; default: pc-heavy.sh beside this file (the toolchain
//                               ships both). When missing, the job runs unadmitted with one warning.
//   PC_HEAVY_SHIM_LOG=<file>    append {"ev":"request"|"admit",...} JSON lines, the same records as
//                               heavy-shim.sh, so the added-wait measurement (D-030) works here too.
const path = require('node:path');
const fs = require('node:fs');

/** Basenames argv[1] can have for a heavy entrypoint: the .bin link name or the package file. */
const HEAVY_BASENAMES = new Set(['vitest', 'vitest.mjs', 'tsc', 'tsc6', 'tsgo', 'tsgo.js']);

/** Resolved entrypoint paths, matched after realpath (a .bin entry is a symlink into the package). */
const HEAVY_ENTRYPOINTS = [
  { name: 'vitest', re: /[\\/]node_modules[\\/]vitest[\\/]vitest\.mjs$/ },
  // TypeScript 7's native launcher (this repo's `tsc`), which spawns the Go compiler as a child.
  { name: 'tsc', re: /[\\/]node_modules[\\/]@typescript[\\/]native[\\/]bin[\\/]tsc$/ },
  { name: 'tsc', re: /[\\/]node_modules[\\/]typescript[\\/]bin[\\/]tsc6?$/ },
  { name: 'tsgo', re: /[\\/]node_modules[\\/]@typescript[\\/]native-preview[\\/]bin[\\/]tsgo(?:\.js)?$/ },
];

const INFO_FLAGS = new Set(['--version', '-v', '--help', '-h', '--init', '--showConfig']);

/** The heavy entrypoint name for argv[1], or null. Cheap rejection first: basename, then realpath. */
function heavyName(entry) {
  if (typeof entry !== 'string' || entry === '') return null;
  if (!HEAVY_BASENAMES.has(path.basename(entry))) return null;
  let real;
  try {
    real = fs.realpathSync(entry);
  } catch {
    return null;
  }
  for (const h of HEAVY_ENTRYPOINTS) if (h.re.test(real)) return h.name;
  return null;
}

/** Why a heavy call is let through without a slot, or null when it must be admitted. */
function exemptReason(name, args) {
  if (args.some((a) => INFO_FLAGS.has(a))) return 'informational';
  if (args.includes('--watch') || args.includes('-w')) return 'watch';
  if (name === 'vitest') {
    const first = args.find((a) => !a.startsWith('-'));
    if (first === 'watch' || first === 'dev') return 'watch';
  }
  return null;
}

function record(obj) {
  const log = process.env.PC_HEAVY_SHIM_LOG;
  if (!log) return;
  try {
    fs.appendFileSync(log, JSON.stringify(obj) + '\n');
  } catch {
    /* measurement only: never fail the job over its log */
  }
}

/** Epoch seconds, the clock heavy-shim.sh logs with (`date +%s.%N`), so both logs compare. */
function nowSec() {
  return Date.now() / 1000;
}

function findBash() {
  for (const p of ['/bin/bash', '/usr/bin/bash']) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

function main() {
  const entry = process.argv[1];
  const name = heavyName(entry);
  if (name === null) return;
  // A worker thread inherits argv; only the main thread may re-exec.
  if (!require('node:worker_threads').isMainThread) return;

  if (process.env.PC_HEAVY_BYPASS === '1') {
    // The admitted re-run: close the request record opened before the exec.
    const t0 = process.env.PC_HEAVY_SHIM_T0;
    if (t0) {
      const t = nowSec();
      record({ ev: 'admit', bin: name, id: process.env.PC_HEAVY_SHIM_ID || '', t, waitSec: Math.round((t - Number(t0)) * 1000) / 1000 });
      delete process.env.PC_HEAVY_SHIM_T0;
      delete process.env.PC_HEAVY_SHIM_ID;
    }
    return;
  }

  const args = process.argv.slice(2);
  if (exemptReason(name, args) !== null) return;

  const script = process.env.PC_HEAVY_ADMISSION_SCRIPT || path.join(__dirname, 'pc-heavy.sh');
  const bash = findBash();
  if (!bash || !fs.existsSync(script)) {
    process.stderr.write(`heavy-admission: no ${bash ? `pc-heavy at ${script}` : 'bash'}; running ${name} unadmitted\n`);
    return;
  }

  const t0 = nowSec();
  const id = `${process.pid}-${t0}`;
  record({ ev: 'request', bin: name, id, t: t0 });
  const env = { ...process.env, PC_HEAVY_SHIM_T0: String(t0), PC_HEAVY_SHIM_ID: id };
  // Same interpreter, same node flags, same entrypoint and arguments, now behind a slot.
  const cmd = [script, '--', process.execPath, ...process.execArgv, entry, ...args];

  if (typeof process.execve === 'function') {
    // Node >= 22.15: replace this process, so exit status, signals and the pid's place in the
    // caller's process tree are exactly those of the admitted job.
    try {
      process.execve(bash, ['bash', ...cmd], env);
    } catch (err) {
      process.stderr.write(`heavy-admission: exec failed (${err && err.message}); running ${name} unadmitted\n`);
      return;
    }
  }

  // Older node: run it as a child and mirror its outcome. A signal sent only to this wrapper pid
  // does not reach the child; a terminal's Ctrl-C reaches both (same process group).
  const r = require('node:child_process').spawnSync(bash, cmd, { stdio: 'inherit', env });
  if (r.error) {
    process.stderr.write(`heavy-admission: spawn failed (${r.error.message}); running ${name} unadmitted\n`);
    return;
  }
  if (r.signal) {
    try {
      process.kill(process.pid, r.signal);
    } catch {
      /* fall through to an exit status */
    }
    const n = require('node:os').constants.signals[r.signal];
    process.exit(128 + (typeof n === 'number' ? n : 1));
  }
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

try {
  main();
} catch (err) {
  try {
    process.stderr.write(`heavy-admission: internal error (${err && err.message}); continuing unadmitted\n`);
  } catch {
    /* nothing left to do */
  }
}

module.exports = { heavyName, exemptReason };
