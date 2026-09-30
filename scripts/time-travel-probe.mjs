#!/usr/bin/env node
/**
 * time-travel-probe — find tests that will EXPIRE, before wall-clock finds them for you.
 *
 * WHY THIS EXISTS (EI-20017917424584843, measured 2026-08-09)
 * ----------------------------------------------------------
 * `stalled-loops-guard-revival.test.ts` pinned a fixture to an absolute instant
 * (`lastRealTurnAt: '2026-08-09T16:29:00.000Z'`) while the code under test compared it to
 * `Date.now()` against a 6h ceiling. So the suite had a hard expiry — 22:29:00Z — and went
 * red there, permanently, with NO code change to explain it. Last green run was 22:25:32Z.
 *
 * The expensive part was not the bug, it was the DISGUISE: the failure was attributed to the
 * commit that happened to land nearest the flip (22:26Z), whose diff touched nothing in that
 * module. A time bomb is deterministic, monotonically worsening, and `git diff pass..fail`
 * explains nothing — so it reads exactly like a regression in the code under test, and a
 * bisect hands you a causally innocent commit.
 *
 * WHAT THIS DOES
 * --------------
 * Runs a test command with `Date` shifted forward N days, for every module in the worker
 * tree. A suite whose fixtures are load-bearing against `Date.now()` goes red NOW instead of
 * at some unattended future hour. A suite that freezes its clock (`vi.useFakeTimers`) or
 * derives fixtures from `Date.now()` is immune and stays green.
 *
 * This is anchored to the PROPERTY (a pinned instant reaching code that reads `Date.now()`),
 * not to how a date literal happens to be spelled. That distinction is deliberate: the first
 * measurement of this class WAS a spelling grep (`2026-08-09T`), and it is wrong in both
 * directions — it over-counts identity-only assertions that never expire, and it cannot see a
 * fixture pinned to an earlier date, which is already further past its expiry. This repo has
 * been burned three separate times by form-blind detectors; see CLAUDE.md § shared-lib
 * singletons.
 *
 * USAGE
 *   node scripts/time-travel-probe.mjs --days 365 -- npm run test:file -- <paths...>
 *   node scripts/time-travel-probe.mjs --days 30  -- npm run test:affected
 *
 * EXIT CODES
 *   0  the command passed under time travel — no expiring fixture detected by this run
 *   1  the command FAILED under time travel — something expires (that is a finding)
 *   2  misuse
 *
 * ⚠ READ THE ASYMMETRY. A green here is not proof of immortality: it only says nothing broke
 * at the offset you probed. Probe a couple of horizons (30d and 365d) — a fixture inside a 6h
 * ceiling and one inside a 30d retention window fail at very different offsets.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The preload body. Kept as a string so this ships as ONE file with nothing to keep in sync. */
const PRELOAD = `
const OFFSET_MS = Number(process.env.TIME_SHIFT_MS || 0);
if (OFFSET_MS !== 0) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      // Only "now" moves. Every explicit form is untouched, so a fixture's literal instant
      // still parses to exactly the instant it names — the shift must move NOW, not history.
      if (args.length === 0) super(RealDate.now() + OFFSET_MS);
      else super(...args);
    }
    static now() { return RealDate.now() + OFFSET_MS; }
  }
  // static parse/UTC inherit through the class chain, so literals keep parsing normally.
  globalThis.Date = ShiftedDate;
}
`;

function die(msg) {
  console.error(`time-travel-probe: ${msg}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1) die('missing `--` separator.\n  usage: node scripts/time-travel-probe.mjs --days 365 -- <command...>');

const flags = argv.slice(0, sep);
const command = argv.slice(sep + 1);
if (command.length === 0) die('no command after `--`.');

const daysIdx = flags.indexOf('--days');
const days = daysIdx === -1 ? 365 : Number(flags[daysIdx + 1]);
if (!Number.isFinite(days) || days === 0) die(`--days must be a non-zero number (got ${flags[daysIdx + 1]})`);

const shiftMs = Math.round(days * 24 * 60 * 60 * 1000);

// The preload lives OUTSIDE the repo on purpose: this tree is swept into commits every few
// minutes, so a probe artifact written in-tree can be committed by accident.
const dir = mkdtempSync(join(tmpdir(), 'time-travel-probe-'));
const preloadPath = join(dir, 'shift.mjs');
writeFileSync(preloadPath, PRELOAD);

const nowIso = new Date().toISOString();
const shiftedIso = new Date(Date.now() + shiftMs).toISOString();
console.log(`[time-travel-probe] real now  ${nowIso}`);
console.log(`[time-travel-probe] shifted   ${shiftedIso}  (+${days}d)`);
console.log(`[time-travel-probe] running:  ${command.join(' ')}\n`);

const child = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  env: {
    ...process.env,
    TIME_SHIFT_MS: String(shiftMs),
    // Appended, never replaced — clobbering a caller's NODE_OPTIONS would silently drop
    // whatever they were already loading.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preloadPath).href}`.trim(),
  },
});

child.on('exit', (code, signal) => {
  const failed = signal != null || code !== 0;
  console.log(
    `\n[time-travel-probe] VERDICT: ${
      failed
        ? `FAILED under +${days}d — something in this suite EXPIRES. Freeze the clock ` +
          `(vi.useFakeTimers({ toFake: ['Date'] }) + setSystemTime) or derive the fixtures from Date.now().`
        : `passed under +${days}d — no expiring fixture detected AT THIS OFFSET (not a proof of immortality; try another horizon).`
    }`,
  );
  console.log(`TIME_TRAVEL_PROBE_RESULT days=${days} verdict=${failed ? 'expires' : 'clean'} exit=${code ?? 'signal:' + signal}`);
  process.exit(failed ? 1 : 0);
});
