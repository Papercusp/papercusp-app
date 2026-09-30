#!/usr/bin/env node
/**
 * GATING guard: a tracked systemd drop-in must actually be INSTALLED on a host
 * that runs the unit it belongs to.
 *
 * WHY (D-002/D-004 of substrate-observability-bug-wave-2026-08-26): a drop-in can be
 * written, committed, documented and unit-tested while never being symlinked into
 * ~/.config/systemd/user/, and NOTHING notices. The unit keeps running its old
 * configuration and every artifact around it reads as healthy.
 *
 * Measured instance that motivated this guard (2026-08-26): papercup-bg-host.service.d/
 * 95-bundled-entry.conf replaces the base unit's `npx tsx bin/hono-host.ts` entry — which
 * reads the LIVE shared checkout, so a peer's mid-edit state can crash-loop the DBOS
 * routines / git-sync / substrate primary — with a pre-built bundle. It was committed
 * 2026-08-25, shipped with bundle-host.sh, a README install section AND a dedicated
 * vitest, and was absent from the unit's live DropInPaths a full day later. Three
 * separate components had already been written assuming it was active:
 *   - bghost-watchdog.mjs      ("a successful boot takes 4-5 min (ExecStartPre esbuild bundle)")
 *   - check-host-bundle-builds.mjs ("bundle-host.sh — which runs as the service's ExecStartPre")
 *   - bghost-bundled-entry.test.ts (asserts the install instructions are well-formed)
 * Not one of them could observe the host, so all three were green.
 *
 * NOT the first instance either: 94-embed-sidecar-enable.conf's own header documents the
 * same class for a different fix — "the sidecar the fix shipped was simply never turned on
 * where it mattered." That is why this guard is scoped to the whole tracked systemd
 * directory rather than to one unit.
 *
 * WHY THIS IS NOT A VITEST: the fact being asserted lives in systemd, not in the repo, so
 * it is unobservable from CI by construction. Pinning repo text to other repo text is what
 * the existing test already does and is exactly the failure this replaces (D-004). This is
 * rung 3 of CLAUDE.md's derive/pin/attest ladder: reconcile against the runtime.
 *
 * A FAILED READ IS NEVER A VERDICT (EI-24161579159727790). This guard used to map a failed
 * `systemctl show` call to an empty DropInPaths list, so one transient read failure was
 * reported as a MISSING drop-in (measured 2026-09-24 12:35 EDT: at-spi-dbus-bus.service was
 * reported MISSING while a concurrent run of this same guard, with no daemon-reload in the
 * window, read it as loaded). The same collapse turned a failed LoadState read into a silent
 * "unit absent" skip. Now every read goes through showUnits(): one batched call, retried on a
 * failed or malformed answer, and a read that still fails is reported as UNREADABLE with
 * systemctl's own error — never as drift, never as a pass. A MISSING verdict is also
 * confirmed by a second read before it is reported, so one anomalous answer cannot fail the
 * gate or make the supervision reconciler file a false work-item.
 *
 * SCOPE, stated so a reader does not over-trust a pass: user-scope `*.service.d/*.conf`
 * drop-ins, plus the Diodon/zeitgeist lifecycle on a host with an active graphical
 * session. Root-owned system units installed by `sudo install` (per the README's
 * user-manager-watchdog section) are a different mechanism and are NOT covered here.
 *
 * Usage:
 *   node scripts/check-systemd-dropins-installed.mjs           # gate
 *   node scripts/check-systemd-dropins-installed.mjs --list    # print the measured population
 *
 * Gate exit codes: 0 = verified · 1 = drift (a drop-in is not loaded, or the Diodon lifecycle
 * is broken) · 2 = NOT VERIFIED (systemctl reads kept failing; nothing was concluded).
 * `--list` always exits 0. Its summary line and row formats are a parsed contract
 * (supervision-reconcile-action.ts parseSystemdDropInCheckOutput): an unreadable unit is
 * listed as `UNIT-ABSENT <unit> <conf> (systemctl show failed)`, which that parser maps to
 * `unavailable` rather than healthy or missing.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const systemdDir = join(repoRoot, 'apps', 'operator', 'scripts', 'systemd');
const listOnly = process.argv.includes('--list');

/**
 * Read attempts per batched `systemctl show`, and the pause before each retry. The whole
 * --list run must stay inside the supervision reconciler's 30s budget, so the pauses are
 * bounded. The env override exists so the recurrence test does not sleep.
 */
const READ_ATTEMPTS = 3;
const RETRY_DELAYS_MS = process.env.CHECK_SYSTEMD_DROPINS_RETRY_DELAY_MS
  ? [Number(process.env.CHECK_SYSTEMD_DROPINS_RETRY_DELAY_MS), Number(process.env.CHECK_SYSTEMD_DROPINS_RETRY_DELAY_MS)]
  : [2_000, 5_000];

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run systemctl --user. Returns { ok: true, stdout } or { ok: false, error }, where error is
 * systemctl's own first stderr line (or the exit status / signal). A failure is kept as a
 * failure — collapsing it into empty output is the defect this guard once had.
 */
function runSystemctl(args) {
  try {
    const stdout = execFileSync('systemctl', ['--user', ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { ok: true, stdout };
  } catch (err) {
    const stderr = `${err?.stderr ?? ''}`.trim().split('\n')[0];
    const detail =
      stderr ||
      (err?.signal ? `killed by ${err.signal}` : null) ||
      (typeof err?.status === 'number' ? `exit ${err.status}` : null) ||
      `${err?.code ?? err}`;
    return { ok: false, error: detail.slice(0, 200) };
  }
}

/**
 * Split multi-unit `systemctl show` output into one property map per unit. Units are
 * separated by a blank line and appear in argument order. Within a block, properties of a
 * unit's type interface (e.g. Restart) print before Id, and properties that do not apply to
 * a unit type are omitted rather than printed empty.
 */
function parseShowBlocks(stdout) {
  return stdout
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const props = {};
      for (const line of block.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
      }
      return props;
    });
}

/**
 * Read `properties` for every unit in ONE `systemctl show` call. A failed call or a
 * malformed answer (wrong block count, a block without Id or without a `required` property)
 * is retried. Returns { units: Map<unit, props> } or, when every attempt failed,
 * { error } naming the last failure.
 */
function showUnits(units, properties, required = []) {
  const args = ['show', '--property=Id', ...properties.map((p) => `--property=${p}`), ...units];
  let error = 'no read attempted';
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    const read = runSystemctl(args);
    if (read.ok) {
      const blocks = parseShowBlocks(read.stdout);
      const complete =
        blocks.length === units.length &&
        blocks.every((b) => 'Id' in b && required.every((p) => p in b));
      if (complete) return { units: new Map(units.map((u, i) => [u, blocks[i]])) };
      error = `malformed answer: expected ${units.length} unit block(s) with Id${required.map((p) => `,${p}`).join('')}, got ${blocks.length}`;
    } else {
      error = read.error;
    }
    if (attempt < READ_ATTEMPTS) sleepSync(RETRY_DELAYS_MS[attempt - 1] ?? 0);
  }
  return { error: `${error} (after ${READ_ATTEMPTS} attempts)` };
}

/**
 * Is there a user systemd manager to talk to at all?
 *
 * `is-system-running` exits NON-ZERO for healthy-but-degraded states, so its exit code
 * cannot be the probe — only the ABSENCE of output means we could not reach a manager.
 * Getting this backwards would make the guard skip on every box that has any failed
 * unit, which is precisely the host where it most needs to run.
 */
function userSystemdAvailable() {
  try {
    execFileSync('systemctl', ['--user', 'is-system-running'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15_000,
    });
    return true;
  } catch (err) {
    const out = `${err?.stdout ?? ''}`.trim();
    return out.length > 0;
  }
}

function installedSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink() && existsSync(path);
  } catch {
    return false;
  }
}

/** Collect tracked drop-ins as { unit, confPath, confName }. */
function trackedDropIns() {
  if (!existsSync(systemdDir)) return [];
  const found = [];
  for (const entry of readdirSync(systemdDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.service.d')) continue;
    const unit = entry.name.slice(0, -2); // "foo.service.d" -> "foo.service"
    const dir = join(systemdDir, entry.name);
    for (const conf of readdirSync(dir)) {
      if (!conf.endsWith('.conf')) continue;
      found.push({ unit, confName: conf, confPath: join(dir, conf) });
    }
  }
  return found.sort((a, b) => `${a.unit}/${a.confName}`.localeCompare(`${b.unit}/${b.confName}`));
}

/** Names of the drop-ins a unit has loaded, from its DropInPaths property. */
function loadedDropInNames(props) {
  return new Set(props.DropInPaths.split(/\s+/).filter(Boolean).map((p) => basename(p)));
}

const dropIns = trackedDropIns();

if (dropIns.length === 0) {
  console.log('systemd drop-in install check: no tracked *.service.d/*.conf found — nothing to verify.');
  process.exit(0);
}

if (!userSystemdAvailable()) {
  // Loud, not silent: a skip must never read like a pass. Exit 0 so CI (which has no
  // user systemd session) is not broken by an environment fact.
  console.log(
    `systemd drop-in install check: SKIPPED — no user systemd manager reachable.\n` +
      `  ${dropIns.length} tracked drop-in(s) were NOT verified. This check only means anything on a host that runs these units.`,
  );
  process.exit(0);
}

const missing = [];
const installed = [];
const unitAbsent = [];
const unreadable = [];
const readErrors = [];

const trackedUnits = [...new Set(dropIns.map((d) => d.unit))];
const firstRead = showUnits(trackedUnits, ['LoadState', 'DropInPaths'], ['LoadState', 'DropInPaths']);
if (firstRead.error) readErrors.push(firstRead.error);

const suspects = [];
for (const d of dropIns) {
  const props = firstRead.units?.get(d.unit);
  if (!props) unreadable.push(d);
  else if (props.LoadState === 'not-found') unitAbsent.push({ ...d, reason: 'unit not present in user scope' });
  else if (loadedDropInNames(props).has(d.confName)) installed.push(d);
  else suspects.push(d);
}

// Confirm every MISSING with a second, independent read: a genuine drift is stable, and a
// single anomalous answer must not fail the gate or file a work-item on its own.
if (suspects.length > 0) {
  sleepSync(RETRY_DELAYS_MS[0] ?? 0);
  const suspectUnits = [...new Set(suspects.map((d) => d.unit))];
  const confirm = showUnits(suspectUnits, ['LoadState', 'DropInPaths'], ['LoadState', 'DropInPaths']);
  if (confirm.error) readErrors.push(`confirmation read: ${confirm.error}`);
  for (const d of suspects) {
    const props = confirm.units?.get(d.unit);
    if (!props) unreadable.push(d);
    else if (props.LoadState === 'not-found') unitAbsent.push({ ...d, reason: 'unit not present in user scope' });
    else if (loadedDropInNames(props).has(d.confName)) installed.push(d);
    else missing.push(d);
  }
}

if (listOnly) {
  console.log('=== tracked systemd drop-ins (measured population) ===');
  for (const d of installed) console.log(`  INSTALLED    ${d.unit}  ${d.confName}`);
  for (const d of missing) console.log(`  MISSING      ${d.unit}  ${d.confName}`);
  for (const d of unitAbsent) console.log(`  UNIT-ABSENT  ${d.unit}  ${d.confName}  (${d.reason})`);
  // Kept in the UNIT-ABSENT row with this exact reason: the supervision reconciler's parser
  // recognises it and reports the check as unavailable, never healthy or missing.
  for (const d of unreadable) console.log(`  UNIT-ABSENT  ${d.unit}  ${d.confName}  (systemctl show failed)`);
  for (const e of readErrors) console.log(`systemctl read error: ${e}`);
  console.log(
    `\ninstalled=${installed.length} missing=${missing.length} unit-absent=${unitAbsent.length + unreadable.length}`,
  );
  process.exit(0);
}

if (unitAbsent.length > 0) {
  console.log(
    `systemd drop-in install check: ${unitAbsent.length} drop-in(s) skipped — their unit is not on this host:`,
  );
  for (const d of unitAbsent) console.log(`  - ${d.unit} / ${d.confName} (${d.reason})`);
}

let drift = false;
let unverified = false;

if (unreadable.length > 0) {
  unverified = true;
  console.error(
    `\n⚠ systemd drop-in install check: ${unreadable.length} tracked drop-in(s) NOT VERIFIED — ` +
      `systemctl could not read their unit. This is a failed read, not evidence of drift:`,
  );
  for (const d of unreadable) console.error(`  UNREADABLE   ${d.unit}  ${d.confName}`);
  for (const e of readErrors) console.error(`  systemctl read error: ${e}`);
}

if (missing.length > 0) {
  drift = true;
  console.error(
    `\n❌ ${missing.length} tracked systemd drop-in(s) are NOT loaded by the unit they belong to.\n` +
      `   The unit is running WITHOUT the configuration this repo believes it has.\n` +
      `   (Confirmed by two separate reads.)\n`,
  );
  for (const { unit, confName, confPath } of missing) {
    const rel = confPath.slice(repoRoot.length + 1);
    console.error(`  ${unit}  <-  ${confName}`);
    console.error(`     tracked at: ${rel}`);
    console.error(`     install:    mkdir -p ~/.config/systemd/user/${unit}.d \\`);
    console.error(`                 && ln -sfn "${confPath}" ~/.config/systemd/user/${unit}.d/${confName} \\`);
    console.error(`                 && systemctl --user daemon-reload`);
    console.error(
      `     then verify: systemctl --user show ${unit} --property=DropInPaths --value | tr ' ' '\\n' | grep ${confName}\n`,
    );
  }
  console.error(
    `   A drop-in that changes ExecStart/ExecStartPre does not take effect until the unit RESTARTS.\n` +
      `   Check the drop-in's own header for whether it is safe to restart, and whether it needs a\n` +
      `   raised TimeoutStartSec before activation.\n`,
  );
}

// WI-10003011: Diodon can remain running yet stop recording after Zeitgeist
// restarts. The unit dependency makes the client restart too; this host check
// catches an absent link, stale loaded unit, or a revived competing XDG
// autostart before the next user session silently loses clipboard history.
if (existsSync('/usr/bin/diodon')) {
  const service = 'diodon-managed.service';
  const session = showUnits(['graphical-session.target'], ['ActiveState'], ['ActiveState']);
  const lifecycle =
    session.units?.get('graphical-session.target')?.ActiveState === 'active'
      ? showUnits(
          [service, 'zeitgeist.service'],
          ['FragmentPath', 'UnitFileState', 'ActiveState', 'NeedDaemonReload', 'Restart', 'BindsTo', 'PartOf', 'After', 'Wants'],
        )
      : null;
  const readError = session.error ?? lifecycle?.error;
  if (readError) {
    unverified = true;
    console.error(`\n⚠ Diodon/zeitgeist lifecycle check NOT VERIFIED — systemctl read failed: ${readError}`);
  } else if (lifecycle) {
    const diodon = lifecycle.units.get(service);
    const zeitgeist = lifecycle.units.get('zeitgeist.service');
    const servicePath = join(homedir(), '.config', 'systemd', 'user', service);
    const autostartPath = join(homedir(), '.config', 'autostart', 'diodon-autostart.desktop');
    const issues = [];
    if (!installedSymlink(servicePath)) issues.push(`missing installed service symlink: ${servicePath}`);
    if (!installedSymlink(autostartPath)) issues.push(`missing XDG autostart override symlink: ${autostartPath}`);
    else if (!/^Hidden=true$/m.test(readFileSync(autostartPath, 'utf8')))
      issues.push('XDG autostart override does not disable the competing Diodon launch');
    if (diodon.FragmentPath !== servicePath) issues.push('managed Diodon unit file is not loaded');
    if (diodon.UnitFileState !== 'enabled') issues.push('managed Diodon unit is not enabled');
    if (diodon.ActiveState !== 'active') issues.push('managed Diodon unit is not active');
    if (diodon.NeedDaemonReload !== 'no') issues.push('managed Diodon unit needs daemon-reload');
    if (diodon.Restart !== 'on-failure') issues.push('managed Diodon crash recovery is disabled');
    if (zeitgeist.Restart !== 'on-failure') issues.push('Zeitgeist crash recovery is disabled');
    for (const [unit, props, property, value] of [
      [service, diodon, 'BindsTo', 'zeitgeist.service'],
      [service, diodon, 'PartOf', 'zeitgeist.service'],
      [service, diodon, 'After', 'zeitgeist.service'],
      ['zeitgeist.service', zeitgeist, 'Wants', service],
    ]) {
      // An omitted property is systemd saying it does not apply — a real, read answer.
      if (!(props[property] ?? '').split(/\s+/).includes(value))
        issues.push(`${unit} does not have ${property}=${value}`);
    }
    if (issues.length > 0) {
      drift = true;
      console.error(`❌ Diodon/zeitgeist lifecycle is not installed or active:\n  - ${issues.join('\n  - ')}`);
    } else {
      console.log('✓ Diodon/zeitgeist lifecycle check: managed service active and autostart override installed.');
    }
  }
}

if (drift) process.exit(1);
if (unverified) {
  console.error(
    `\n⚠ systemd drop-in install check: NOT VERIFIED (exit 2). Nothing was concluded about drift; ` +
      `re-run once systemctl --user show answers.`,
  );
  process.exit(2);
}

console.log(
  `✓ systemd drop-in install check: all ${installed.length} tracked drop-in(s) for units present on this host are loaded.`,
);
process.exit(0);
