#!/usr/bin/env node
/**
 * check-systemd-startlimit-placement.mjs — fail-loud guard against
 * StartLimitIntervalSec / StartLimitBurst sitting in a `[Service]` section
 * (EI-19381535849234617).
 *
 * Both directives are `[Unit]`-only. systemd parses one in `[Service]`,
 * prints "Unknown key name '...' in section 'Service', ignoring", and — the
 * dangerous part — IGNORES it rather than failing, so the unit silently falls
 * back to systemd's DEFAULT rate-limit window (10s / 5-burst) instead of
 * whatever the author intended. `systemd-analyze --user verify` already
 * surfaces the warning but exits 0 anyway, so it has sat unread on every
 * verify for weeks (measured live: 6 units on this box, including a service
 * whose own header comment promised "NEVER gives up" via
 * StartLimitIntervalSec=0 — a promise that was not in effect).
 *
 * Scope: this repo's version-controlled systemd unit sources under
 * apps/operator/scripts/systemd/ (*.service, *.conf drop-ins) and
 * infra/phone-app/systemd/ (*.service, *.tmpl). It CANNOT see
 * host-local `~/.config/systemd/user/*.service.d/*.conf` drop-ins that are not
 * checked in anywhere — those need a live `systemd-analyze --user verify` spot
 * check on the box that runs them; a repo lint has no way to reach them.
 *
 *   node scripts/check-systemd-startlimit-placement.mjs
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { listTrackedFiles, describeUnscanned } from './lib/tracked-files.mjs';

const OFFENDING_KEYS = ['StartLimitIntervalSec', 'StartLimitBurst'];
const UNIT_SOURCE_RE = /^(?:apps\/operator\/scripts\/systemd\/.*\.(service|conf)|infra\/phone-app\/systemd\/.*\.(service|tmpl))$/;

/**
 * Pure: scan one unit-file's TEXT for an offending key inside a `[Service]`
 * section. INI sections are line-anchored (`^\[Name\]$`, whitespace-trimmed);
 * a key before the first section header is treated as belonging to no
 * section (never flagged — that shape doesn't occur in real unit files but
 * isn't this guard's problem to diagnose).
 */
export function findMisplacedStartLimitKeys(text) {
  const offenders = [];
  let section = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([A-Za-z]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== 'Service') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (OFFENDING_KEYS.includes(key)) {
      offenders.push({ line: i + 1, key, text: trimmed });
    }
  }
  return offenders;
}

function findOffenders() {
  const { files, unscanned } = listTrackedFiles();
  const offenders = [];
  for (const f of files) {
    if (!UNIT_SOURCE_RE.test(f)) continue;
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue; // deleted-but-still-listed edge case — nothing to scan
    }
    for (const hit of findMisplacedStartLimitKeys(text)) {
      offenders.push(`${f}:${hit.line}: \`${hit.key}\` under [Service] (systemd ignores it there) — ${hit.text}`);
    }
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    console.log(
      '✓ no StartLimitIntervalSec/StartLimitBurst misplaced under [Service] in tracked systemd unit sources.' +
        describeUnscanned(unscanned),
    );
    console.log(
      '  Note: this only covers REPO-TRACKED unit sources — a host-local ~/.config/systemd/user/*.service.d/*.conf',
    );
    console.log('  drop-in is invisible to a repo lint; spot-check those with `systemd-analyze --user verify`.');
    process.exit(0);
  }
  console.error('✗ StartLimitIntervalSec/StartLimitBurst misplaced under [Service] — systemd IGNORES them there:');
  console.error('  Move the key(s) into a `[Unit]` section instead (for a drop-in, add one if missing).');
  console.error('  See EI-19381535849234617 for the failure mode this silently defeats.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s).`);
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit
// test) must NOT exec git / exit the process. Symlink-robust (WI-1443).
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
