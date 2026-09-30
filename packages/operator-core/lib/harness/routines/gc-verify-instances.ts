/**
 * gc-verify-instances — reap abandoned `scripts/verify-tauri-headless.sh` instances.
 *
 * WHY (owner ask 2026-08-01: "how do we fix this from recurring — a cleanup sweep that
 * would detect this?"). Measured on the dev box that day:
 *
 *     288 /tmp/verify-tauri-headless.* work dirs   →   300 GB
 *     /tmp 80% full (5.8T of 7.3T)
 *     one --boot-only instance running since Jul 19 (8 days), holding Xvfb :93,
 *     a webview and an operator sidecar
 *
 * Each work dir carries a frozen `spa` bundle snapshot (~1GB), so DISK is the dominant
 * cost — not the display/port starvation the first report assumed.
 *
 * ⚠ AND THE LEAK WAS UNIVERSAL, not a `--boot-only` problem. The obvious story — "the
 * `-- <cmd>` form tears itself down, `--boot-only` returns without teardown, so only
 * the latter leaks" — is what the first report said and it is WRONG. Measured: the
 * youngest leaked dir was 100h old, meaning even clean runs left theirs behind. The
 * reason is that `teardown()` only ever killed PROCESSES; the single `rm -rf` in the
 * whole script was for the isolated-PG datadir. Displays were already reclaimed
 * opportunistically (EI-18738872670541790), which is why the process side looked
 * handled while disk quietly grew. So the ROOT fix is in the script — teardown now
 * drops `$WORK/spa` (WI-6684) — and this sweep exists for what a trap can never cover:
 *
 *   - the accumulated backlog (288 dirs at first run),
 *   - runs SIGKILLed before the trap fires,
 *   - `--boot-only` callers that die/compact/forget and never run the printed stop.sh,
 *   - the kilobyte log husks that deliberately survive teardown for post-mortems.
 *
 * ── DESIGN: INVOKE THE EXISTING TEARDOWN, NEVER REIMPLEMENT IT ───────────────────
 *
 * Every work dir contains a generated `stop.sh` that already encodes four separately
 * hard-won fixes:
 *
 *   EI-11559              do NOT force-kill the port-lock keeper — it must survive to
 *                         self-terminate once the display is gone AND the port drains,
 *                         or a display-reusing next run collides with a straggler.
 *   EI-18745117818375852  reap escaped restart-supervisor sidecars BY PORT, matching
 *                         /proc/<pid>/environ, not by the tracked pid (the WI-3042
 *                         supervisor spawns replacements outside the process group).
 *   EI-18816386093046558  SIGKILL leaves /tmp/.X11-unix/X<N> unlinked.
 *   (ordering)            openbox before Xvfb, group-kill before single-kill.
 *
 * A reaper that rolled its own kill logic would silently lose all four and re-earn them
 * one incident at a time. So this sweep decides only WHETHER a dir is abandoned; the
 * dir's own stop.sh decides HOW to tear it down.
 *
 * ── SAFETY IS THE DELIVERABLE ────────────────────────────────────────────────────
 *
 * This sweep kills processes on a box shared by the owner's real desktop and a live
 * agent fleet, unattended, on a timer. A near-miss on 2026-07-27 (su-709bb0d6) ran
 * `pkill -f "papercusp-desktop" -u $USER --older-than 0` while cleaning up its OWN
 * instance — `--older-than 0` means "older than 0 seconds", i.e. EVERY match, which
 * included the owner's desktop window and every peer's test instance. That is the
 * failure mode this file must not have. Hence:
 *
 *   - NEVER pattern-kill. This module issues no kill of its own; it execs a specific
 *     work dir's own stop.sh and nothing else.
 *   - REFUSE a stop.sh whose display is :0/:1/:2 (:0 is the owner's real desktop) —
 *     a defensive parse, since a well-formed stop.sh always targets its own high
 *     display, but a malformed or hand-edited one must not be trusted.
 *   - Before the TTL, only touch a dir whose operator-issued task id is terminal,
 *     marker owner is gone, and teardown grace has elapsed. Otherwise the 6h TTL
 *     protects long interactive --boot-only sessions.
 *   - BOUND every run, and support dryRun that names what it WOULD reap (a bare count
 *     hides destruction — see the gen-gallery.py lesson).
 *
 * ── SCAN A ROOT SET, NOT JUST /tmp (WI-10002867, owner #443) ────────────────────
 *
 * The verifier writes TWO kinds of `verify-tauri-headless.*` dir, and they need not
 * share a filesystem:
 *
 *   - `$WORK`                 — `${TMPDIR:-/tmp}`; carries stop.sh.
 *   - `$OPERATOR_SOURCE_WORK` — the operator source + hardlinked dependency snapshot.
 *     Hardlinks cannot cross devices, so when /tmp is on another device than the repo
 *     (true on the dev box: /tmp is its own 7.3T disk, the repo is on the 1.9T root)
 *     `select_verifier_snapshot_root` puts it under `<repo>/.papercusp/tmp`. It holds a
 *     `.papercusp-run` owner marker but NO stop.sh; the WORK dir's stop.sh removes it.
 *
 * This sweep used to scan only /tmp, so whenever a snapshot outlived its WORK dir (run
 * SIGKILLed before stop.sh existed, WORK removed by another cleaner) nothing ever
 * looked at it again. Measured 2026-09-23: three such snapshots, 20GB, dated Sep 7-9,
 * sat in `papercusp/.papercusp/tmp` while the root FS went to 100%. Hence
 * {@link defaultVerifyScanRoots} and the live-owner refusal below.
 */
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Lazily promisified (NOT `const execFileAsync = promisify(execFile)` at module
// scope): this module is reachable via a transitive import chain from test files
// that narrowly mock `node:child_process` for their own subprocess assertions —
// under such a mock the `execFile` import binding resolves to `undefined`, and
// eagerly calling `promisify(undefined)` at module-eval time throws for every such
// suite, even ones that never call the stop-script path (lint:no-eager-execfile-
// promisify / EI-10161; same pattern as watchdog.ts's `execFileP`). Deferring the
// promisify to first actual call means a transitive importer that never exercises
// this function never pays the cost.
type ExecFileAsync = (
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let cachedExecFileAsync: ExecFileAsync | null = null;
function execFileAsync(file: string, args: string[], opts?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  if (!cachedExecFileAsync) cachedExecFileAsync = promisify(execFile) as unknown as ExecFileAsync;
  return cachedExecFileAsync(file, args, opts);
}

/** Where the verify harness puts its per-run work dirs. */
export const VERIFY_WORK_DIR_PREFIX = 'verify-tauri-headless.';

/**
 * How old a work dir must be before it is even considered. A real `-- <cmd>` run is
 * bounded by the bridge timeout (180s) plus its assertions — minutes, not hours. The
 * generous default exists for `--boot-only`, which is a human/agent-driven interactive
 * session that may legitimately stay up while someone works against it.
 */
export const VERIFY_INSTANCE_TTL_HOURS_DEFAULT = 6;

/** Let a terminal task's own teardown settle before reclaiming its scratch. */
export const VERIFY_TERMINAL_TASK_GRACE_MS = 3 * 60_000;

/** Never reap more than this in one pass — a runaway sweep should be slow, not total. */
export const VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT = 50;

/**
 * Displays this sweep will never tear down, whatever a stop.sh claims.
 * `:0` is the owner's real desktop; `:1`/`:2` are the conventional next seats.
 */
export const PROTECTED_DISPLAYS = new Set([':0', ':1', ':2']);

/** Where discovery looks for checkouts, each of which may own a `.papercusp/tmp`. */
export interface VerifyScanRootEnv {
  /** Always-scanned bases (default: /tmp and os.tmpdir()). */
  baseDirs?: string[];
  /** Parent of the sibling checkouts (default $PAPERCUSP_WORKSPACE_ROOT or ~/papercupai-workspace). */
  workspaceRoot?: string;
  /** Parent of the pot hives, some of which a workspace entry symlinks into (default ~/.papercusp/hives). */
  hivesRoot?: string;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The root SET this sweep scans: the base temp dirs plus every checkout's
 * `.papercusp/tmp` (where the verifier's cross-device source snapshot lands — see the
 * header). Deduplicated by realpath, because /tmp is usually os.tmpdir() and several
 * workspace entries are symlinks into the hives. Missing dirs are simply absent.
 */
export async function defaultVerifyScanRoots(env: VerifyScanRootEnv = {}): Promise<string[]> {
  const workspaceRoot =
    env.workspaceRoot ??
    (process.env.PAPERCUSP_WORKSPACE_ROOT?.trim() || join(homedir(), 'papercupai-workspace'));
  const hivesRoot = env.hivesRoot ?? join(homedir(), '.papercusp', 'hives');
  const candidates = [...(env.baseDirs ?? ['/tmp', tmpdir()])];
  for (const parent of [workspaceRoot, hivesRoot]) {
    let names: string[];
    try {
      names = await readdir(parent);
    } catch {
      continue;
    }
    for (const name of names) candidates.push(join(parent, name, '.papercusp', 'tmp'));
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!(await isDir(candidate))) continue;
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(real);
  }
  return roots;
}

/** Field 22 (starttime) of /proc/<pid>/stat, parsed after the `comm` field's closing paren. */
async function processStartTicks(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a dir's `.papercusp-run` marker (written by the verifier: `pid=` plus
 * `start_ticks=`) names a process that is still alive. The start-ticks comparison
 * means a recycled pid cannot keep an abandoned dir alive, the same rule as
 * `scripts/lib/cargo-result.mjs` `activeRunMarker`. No marker, or an unreadable one,
 * is not live.
 */
export async function runMarkerIsLive(dir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(dir, '.papercusp-run'), 'utf8');
  } catch {
    return false;
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const pid = Number(values.get('pid'));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM = alive but not ours to signal; anything else (ESRCH) = gone.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const expected = values.get('start_ticks');
  if (!expected) return true;
  return (await processStartTicks(pid)) === expected;
}

/** An operator-issued task id from the run marker, if one was recorded. */
export async function runMarkerTaskId(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dir, '.papercusp-run'), 'utf8');
    const taskId = raw.split('\n').find((line) => line.startsWith('task_id='))?.slice('task_id='.length);
    return taskId && /^[0-9a-z]{4,64}$/.test(taskId) ? taskId : null;
  } catch {
    return null;
  }
}

export interface GcVerifyInstancesOptions {
  /** Roots to scan (default {@link defaultVerifyScanRoots}). Injected by the tests. */
  roots?: string[];
  ttlHours?: number;
  maxPerRun?: number;
  /** Report what WOULD be reaped without killing or deleting anything. */
  dryRun?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Injectable teardown, so tests never exec a real stop.sh. */
  runStopScript?: (stopScriptPath: string) => Promise<void>;
  /** Confirm terminal ledger state before the ordinary age TTL; unavailable means false. */
  isTaskTerminal?: (taskId: string) => Promise<boolean>;
}

export interface ReapedInstance {
  dir: string;
  ageHours: number;
  bytes: number;
  /** The display its stop.sh targets, when one could be parsed. */
  display: string | null;
  /** Present when the dir was SKIPPED rather than reaped. */
  skipped?: string;
}

export interface GcVerifyInstancesResult {
  scanned: number;
  reaped: number;
  /** Bytes freed (or that would be freed under dryRun). */
  bytesFreed: number;
  /** Every dir acted on or deliberately skipped, with the reason. */
  instances: ReapedInstance[];
  skipped: number;
  dryRun: boolean;
  ttlHours: number;
  /** The roots actually scanned, so a run can be audited for what it could NOT see. */
  roots: string[];
}

/**
 * Parse the display a stop.sh targets, e.g. `pkill -9 -f "Xvfb :144 "` → `:144`.
 * Returns null when no display can be read, which is itself a refusal condition:
 * we do not tear down a teardown script we cannot understand.
 */
export function parseStopScriptDisplay(stopScript: string): string | null {
  const m = /Xvfb (:\d+)/.exec(stopScript);
  return m ? m[1] : null;
}

/** Recursive size of a directory, tolerant of races (a file vanishing mid-walk). */
async function dirBytes(path: string): Promise<number> {
  let total = 0;
  // Dirent[] explicitly: `Awaited<ReturnType<typeof readdir>>` resolves to the
  // BUFFER overload (Dirent<NonSharedBuffer>[]), so `e.name` typed as a Buffer and
  // `.startsWith` did not exist on it.
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const child = `${path}/${e.name}`;
    try {
      if (e.isDirectory()) total += await dirBytes(child);
      else if (e.isFile()) total += (await stat(child)).size;
    } catch {
      /* vanished mid-walk — a concurrent run tearing itself down; not our problem */
    }
  }
  return total;
}

async function defaultRunStopScript(stopScriptPath: string): Promise<void> {
  // 60s is generous: stop.sh sleeps ~1s between TERM and KILL and drains the port
  // lock. A hung teardown must not wedge the whole sweep.
  await execFileAsync('bash', [stopScriptPath], { timeout: 60_000 });
}

export async function gcVerifyInstances(
  opts: GcVerifyInstancesOptions = {},
): Promise<GcVerifyInstancesResult> {
  const roots = opts.roots ?? (await defaultVerifyScanRoots());
  const ttlHours =
    Number.isFinite(opts.ttlHours) && (opts.ttlHours as number) > 0
      ? (opts.ttlHours as number)
      : VERIFY_INSTANCE_TTL_HOURS_DEFAULT;
  const maxPerRun =
    Number.isFinite(opts.maxPerRun) && (opts.maxPerRun as number) > 0
      ? (opts.maxPerRun as number)
      : VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const runStopScript = opts.runStopScript ?? defaultRunStopScript;

  const instances: ReapedInstance[] = [];
  let reaped = 0;
  let skipped = 0;
  let bytesFreed = 0;
  let scanned = 0;

  // Oldest first ACROSS every root, so a capped run always makes progress on the worst
  // offenders rather than nibbling whichever dirs readdir happened to return first.
  const candidates: Array<{ dir: string; mtimeMs: number }> = [];
  for (const root of roots) {
    // Dirent[] explicitly: `Awaited<ReturnType<typeof readdir>>` resolves to the
    // BUFFER overload (Dirent<NonSharedBuffer>[]), so `e.name` typed as a Buffer and
    // `.startsWith` did not exist on it.
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // a missing root must never throw into the routine tick
    }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith(VERIFY_WORK_DIR_PREFIX)) continue;
      const dir = join(root, e.name);
      try {
        candidates.push({ dir, mtimeMs: (await stat(dir)).mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const { dir, mtimeMs } of candidates) {
    scanned += 1;
    if (reaped >= maxPerRun) break;

    const ageHours = (now - mtimeMs) / 3_600_000;
    const record = (extra: Partial<ReapedInstance>): ReapedInstance => ({
      dir,
      ageHours: Math.round(ageHours * 10) / 10,
      bytes: 0,
      display: null,
      ...extra,
    });

    // A deadline reap kills the verifier before its EXIT trap can remove the
    // large snapshot. Its managed task id is recorded in both scratch roots.
    // Permit early cleanup only after the ledger is terminal, the marker owner
    // is gone, and a short grace has allowed normal teardown to finish.
    let terminalTask = false;
    if (ageHours < ttlHours && ageHours * 3_600_000 >= VERIFY_TERMINAL_TASK_GRACE_MS && opts.isTaskTerminal) {
      const taskId = await runMarkerTaskId(dir);
      if (taskId && !(await runMarkerIsLive(dir))) {
        try {
          terminalTask = await opts.isTaskTerminal(taskId);
        } catch {
          // A ledger read failure cannot authorize deletion.
        }
      }
    }

    // ── REFUSAL 1: too young and no confirmed terminal managed task.
    if (ageHours < ttlHours && !terminalTask) {
      skipped += 1;
      instances.push(record({ skipped: `younger than ttl (${ttlHours}h)` }));
      continue;
    }

    const stopScriptPath = `${dir}/stop.sh`;
    let stopScript: string;
    try {
      stopScript = await readFile(stopScriptPath, 'utf8');
    } catch {
      // No stop.sh: a partially-created dir (the harness died mid-boot), or an operator
      // source snapshot whose teardown lives in a WORK dir elsewhere. There is nothing
      // to tear down, so the dir alone is safe to remove — UNLESS its owner still runs.
      //
      // ── REFUSAL 4: a live owner. Only this branch checks, and deliberately so: a
      // snapshot of a still-running rig would otherwise be deleted out from under its
      // sidecar. A dir WITH stop.sh keeps the TTL-only rule, because a forgotten
      // --boot-only rig's marker names its port-lock keeper, which stays alive for as
      // long as the rig does — honouring it there would make those rigs immortal. When
      // that rig IS reaped, its stop.sh removes this snapshot too.
      if (await runMarkerIsLive(dir)) {
        skipped += 1;
        instances.push(record({ skipped: 'owner run still alive (.papercusp-run)' }));
        continue;
      }
      const bytes = await dirBytes(dir);
      if (!dryRun) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          skipped += 1;
          instances.push(record({ skipped: 'rm failed' }));
          continue;
        }
      }
      reaped += 1;
      bytesFreed += bytes;
      instances.push(record({ bytes }));
      continue;
    }

    const display = parseStopScriptDisplay(stopScript);

    // ── REFUSAL 2: unreadable teardown. We do not run a stop.sh we cannot parse.
    if (!display) {
      skipped += 1;
      instances.push(record({ skipped: 'stop.sh names no display — refusing to run it' }));
      continue;
    }

    // ── REFUSAL 3: a protected display. THE load-bearing guard. :0 is the owner's
    // real desktop; tearing it down logs them out. A well-formed stop.sh never
    // targets one, so hitting this means the script is malformed or hand-edited —
    // exactly when blind trust is most expensive.
    if (PROTECTED_DISPLAYS.has(display)) {
      skipped += 1;
      instances.push(record({ display, skipped: `protected display ${display} — refusing` }));
      continue;
    }

    const bytes = await dirBytes(dir);
    if (!dryRun) {
      // Best-effort teardown: a dead instance's stop.sh exits nonzero on every kill
      // (the pids are long gone), which is SUCCESS for our purposes, not failure.
      try {
        await runStopScript(stopScriptPath);
      } catch {
        /* pids already dead, or a hung child hit the timeout — remove the dir anyway */
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        skipped += 1;
        instances.push(record({ display, skipped: 'rm failed after teardown' }));
        continue;
      }
    }
    reaped += 1;
    bytesFreed += bytes;
    instances.push(record({ display, bytes }));
  }

  return { scanned, reaped, bytesFreed, instances, skipped, dryRun, ttlHours, roots };
}
