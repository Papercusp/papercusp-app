#!/usr/bin/env node
// WI-10005321 — the build gate around a bundler that reads the shared working tree.
//
//   node scripts/mutation-probe-window-gate.mjs wait   --root <checkout> --stamp-file <f> [--timeout-sec N]
//     (no --timeout-sec: PAPERCUSP_BUNDLE_PROBE_WAIT_SEC, else PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC, else 90)
//   node scripts/mutation-probe-window-gate.mjs verify --root <checkout> --stamp-file <f>
//
// `wait` blocks (bounded) while an in-tree mutation probe holds a file under <checkout> or any of
// its submodules mutated, then records the probe admission-directory stamp. `verify`, run after
// the build and before the output is published, fails if a window is open now or opened at all
// during the build. Exit 0 = the build may use/publish; 1 = it must not; 2 = usage error.
// `apps/operator/bin/bundle-host.sh` treats 1 as a failed bundle step, so the supervisor boots the
// last-known-good bundle and marks it stale instead of shipping a mutant.
//
// `--tmp-dir` / `--uid` (and PAPERCUSP_MUTATION_PROBE_TMPDIR, for tests that run the real
// bundler) exist only so tests can point the gate at a scratch admission root instead of the
// live `/tmp` markers of peers' probes. Production callers set neither.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  formatBuildWindowBlock,
  resolveBuildWindowWaitSec,
  verifyBuildWindowUnchanged,
  waitForBuildWindowClear,
} from './lib/mutation-probe-window.mjs';

function usage(message) {
  process.stderr.write(`mutation-probe-window-gate: ${message}\n`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      'stamp-file': { type: 'string' },
      'timeout-sec': { type: 'string' },
      'tmp-dir': { type: 'string' },
      uid: { type: 'string' },
    },
  });
} catch (error) {
  usage(String(error instanceof Error ? error.message : error));
}
const { positionals, values } = parsed;
const mode = positionals[0];
const root = values.root;
const stampFile = values['stamp-file'];
if ((mode !== 'wait' && mode !== 'verify') || !root || !stampFile) {
  usage('expected `wait|verify --root <checkout> --stamp-file <file>`');
}
const tmpDir = values['tmp-dir'] || process.env.PAPERCUSP_MUTATION_PROBE_TMPDIR;
const options = {
  ...(tmpDir ? { tmpDir } : {}),
  ...(values.uid ? { uid: Number(values.uid) } : {}),
};

if (mode === 'wait') {
  // WI-10006268: callers omit --timeout-sec so the env knobs (PAPERCUSP_BUNDLE_PROBE_WAIT_SEC, then
  // the PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC umbrella) reach this wait; an explicit flag still wins.
  let timeoutSec;
  let source = '--timeout-sec';
  if (values['timeout-sec'] !== undefined) {
    timeoutSec = Number(values['timeout-sec']);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) usage(`--timeout-sec must be a non-negative number`);
  } else {
    try {
      ({ sec: timeoutSec, source } = resolveBuildWindowWaitSec(process.env));
    } catch (error) {
      usage(String(error instanceof Error ? error.message : error));
    }
  }
  const result = await waitForBuildWindowClear(root, { ...options, timeoutMs: timeoutSec * 1000 });
  for (const note of result.verdict.notes) process.stdout.write(`→ ${note}\n`);
  if (!result.ok) {
    for (const line of formatBuildWindowBlock(result.verdict, root)) process.stdout.write(`${line}\n`);
    const why = result.verdict.waitable
      ? `it stayed open for the whole ${timeoutSec}s wait (from ${source}; an unattended build sets PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC to queue longer)`
      : 'an orphaned or unreadable marker will not clear by itself (the next mutation probe recovers an orphan)';
    process.stdout.write(
      `ERROR: refusing to bundle while a mutation probe holds a file in this tree mutated (WI-10005321): ${why}.\n`,
    );
    process.exit(1);
  }
  if (result.polls > 0) {
    process.stdout.write(`→ waited ${Math.round(result.waitedMs / 1000)}s for a mutation-probe window to close\n`);
  }
  writeFileSync(stampFile, JSON.stringify(result.stamp));
  process.exit(0);
}

let stamp;
try {
  stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
} catch {
  // No stamp means `wait` never cleared: the build cannot be shown probe-free.
  process.stdout.write(`ERROR: no mutation-probe stamp at ${stampFile}; run \`wait\` before the build.\n`);
  process.exit(1);
}
const result = verifyBuildWindowUnchanged(root, stamp, options);
if (!result.ok) {
  for (const line of formatBuildWindowBlock(result.verdict, root)) process.stdout.write(`${line}\n`);
  const where = result.moved.length ? ` (admission directory moved: ${result.moved.join(', ')})` : '';
  process.stdout.write(
    `MUTATION_PROBE_WINDOW_DURING_BUILD reason=${result.reason}${where}: the bundle may contain a mutant.\n`,
  );
  process.exit(1);
}
process.exit(0);
