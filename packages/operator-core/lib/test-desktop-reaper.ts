/**
 * Runaway / leaked TEST-desktop + zombie detector + KILLER
 * (infra-perf-reliability-audit-round3-2026-06-19 P-013/F12, round4 P-006).
 *
 * E2E / dev test runs spawn throwaway webviews — Playwright headless Chromium and
 * `tauri dev`/`npm run dev` WebKitGTK shells. When a test run is SIGKILLed or
 * wedges, those can leak and peg a CPU core for hours. That is a dominant host-CPU
 * drain feeding the per-core saturation these rounds target (root cause: the
 * operator's single Node event loop starves under host contention).
 *
 * ── Slice 1: DETECTION (toast) ─────────────────────────────────────────────────
 * A periodic scan that SURFACES leaked test desktops (Playwright/headless-marked
 * browsers) and a zombie/defunct-child pile as a `notifications:recent` toast.
 * Uses a FAIL-SAFE positive-marker classifier: a browser is only flagged as
 * test-automation when its cmdline carries an unambiguous test marker (Playwright
 * browser cache path, --headless, --remote-debugging-pipe/port). Anything without
 * a marker classifies as LIVE and is never alarmed or killed. `tauri dev` / WebKit
 * children without markers fail-safe to live-desktop (out of scope for slice 1).
 *
 * ── Slice 2: ADV-SESSION-BASED KILL ────────────────────────────────────────────
 * Kills papercusp-desktop (and oddsmith-desktop) processes whose
 * PAPERCUSP_ADV_SESSION_ID environment variable points to an ENDED adv_session
 * row. These are agent-spawned test desktops that were never cleaned up when the
 * agent session ended. This covers the dominant live leak: `papercusp-desktop`
 * processes forked by E2E test agents (which set PAPERCUSP_ADV_SESSION_ID on
 * spawn) that remain running with their WebKitWebProcess children at 99% CPU.
 *
 * SAFETY model:
 *  - Only kills a process carrying PAPERCUSP_ADV_SESSION_ID whose row in
 *    harness_shared.adv_sessions has ended_at set AND at least DESKTOP_GRACE_MS
 *    has elapsed since it ended (prevents killing a desktop mid-shutdown).
 *  - Never kills without a PAPERCUSP_ADV_SESSION_ID (ignores user-launched desktops).
 *  - Kills child WebKitWebProcess/WPEWebDriver children explicitly after the parent,
 *    so leaked renderers don't survive as orphans.
 *  - PID-recycle guard (re-reads cmdline immediately before signalling) so a recycled
 *    pid cannot be hit.
 *  - SIGTERM → 3-second grace → SIGKILL; per-process errors are isolated.
 *  - dryRun=true plans+logs, kills nothing.
 *  - Flag-gated (FLAGS.TEST_WEBVIEW_REAPER, defaults ON) with routine seeded INACTIVE
 *    (double-gate — routine must be activated before kills fire).
 */
import { promises as fsp, readFileSync, statSync } from 'node:fs';
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from './sync-sse';
// Shared with event-loop-sentinel.worker.ts — one parser, not two. See that
// module's header for why it is dependency-free (it is imported by a worker
// entry that Node type-strips, which cannot pull in this file's deps).
import { parseProcStat, USER_HZ } from './proc-thread-cpu';

const TOAST_RING_BUFFER = 2000;
const CPU_SAMPLE_MS = 250;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Pure classification (the safety-critical core) ─────────────────────────────

export type DesktopClass = 'test-desktop' | 'live-desktop' | 'not-desktop';

/** Browser/webview families a desktop could be. */
const BROWSER_RE = /chrome|chromium|webkitwebprocess|webkit2webprocess|wry|tauri|msedge/;
/** POSITIVE, unambiguous test-automation markers. A real user desktop never runs
 *  headless or exposes a remote-debugging endpoint, and never lives under a
 *  Playwright browser cache / temp profile. */
const TEST_MARKERS: readonly string[] = [
  'ms-playwright', // playwright's browser download cache path
  'playwright-core',
  '/playwright/', // a playwright-managed dir
  '--headless', // headless automation (covers --headless and --headless=new)
  '--remote-debugging-pipe',
  '--remote-debugging-port',
  '--user-data-dir=/tmp', // throwaway temp profile (CI / playwright default)
];

/**
 * Pure cmdline classifier. FAIL-SAFE: returns 'live-desktop' for any browser that
 * lacks a positive test marker, so the reaper can never target the user's real
 * desktop; 'not-desktop' for non-browser processes.
 */
export function classifyDesktop(cmdline: string): DesktopClass {
  const c = (cmdline || '').toLowerCase();
  if (!BROWSER_RE.test(c)) return 'not-desktop';
  if (TEST_MARKERS.some((m) => c.includes(m))) return 'test-desktop';
  return 'live-desktop';
}

// ── Pure candidate detection ───────────────────────────────────────────────────

export interface ProcSample {
  pid: number;
  /** Full (truncated) cmdline; empty for a zombie. */
  cmdline: string;
  /** /proc stat state char: R, S, D, Z (zombie), T, … */
  state: string;
  /** CPU% sampled over the window (0 for zombies / unsampled). */
  cpuPercent: number;
  /** Approx seconds since the process appeared (proc-dir mtime, as dev:processes). */
  ageSeconds: number;
  /** For a zombie (state 'Z'): true when its PARENT is a browser/webview (any of
   *  BROWSER_RE — Chromium / Edge / WebKit / Tauri, whether live-desktop OR
   *  test-desktop). A browser CONSTANTLY spawns + reaps renderer/utility children,
   *  so a handful of defunct children at any instant is NORMAL churn, not a
   *  reap-worthy leak — counting them false-alarms on the user's own live browser
   *  (the P-006 "the user's real desktop is untouchable" invariant, extended to its
   *  process churn). Left undefined for non-zombies and when the parent cmdline
   *  cannot be read (fail-safe: an unknown parent still counts, preserving the
   *  generic "a non-browser parent is not reaping" signal). */
  parentIsBrowser?: boolean;
}

export interface ReaperPolicy {
  /** A test desktop must be at/above this CPU% to count as runaway. */
  cpuPercentThreshold: number;
  /** …and have been alive at least this long (ignore brief spikes / startup). */
  minAgeSeconds: number;
  /** Only alarm on zombies once the pile reaches this size (a few transient
   *  defunct children are normal; a pile means a parent is not reaping). */
  zombieAlarmThreshold: number;
}

export const DEFAULT_POLICY: ReaperPolicy = {
  cpuPercentThreshold: 50,
  minAgeSeconds: 300,
  zombieAlarmThreshold: 25,
};

/** Read the policy from env knobs (tunable without a deploy). */
export function policyFromEnv(): ReaperPolicy {
  return {
    cpuPercentThreshold: envNum('PAPERCUSP_TEST_DESKTOP_REAPER_CPU_PCT', DEFAULT_POLICY.cpuPercentThreshold),
    minAgeSeconds: envNum('PAPERCUSP_TEST_DESKTOP_REAPER_MIN_AGE_SEC', DEFAULT_POLICY.minAgeSeconds),
    zombieAlarmThreshold: envNum('PAPERCUSP_TEST_DESKTOP_REAPER_ZOMBIE_COUNT', DEFAULT_POLICY.zombieAlarmThreshold),
  };
}

export type ReapReason = 'runaway-test-desktop' | 'zombie';

export interface ReapCandidate {
  pid: number;
  reason: ReapReason;
  cpuPercent: number;
  ageSeconds: number;
  cmdline: string;
}

/**
 * Pure candidate detection — unit-testable without /proc. A process is a
 * candidate iff it is a defunct (zombie) process, OR a positively-identified test
 * desktop pegging CPU past the threshold for past the min age. Live desktops are
 * never returned (see classifyDesktop).
 */
export function findReapCandidates(samples: ProcSample[], policy: ReaperPolicy = DEFAULT_POLICY): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const s of samples) {
    if (s.state === 'Z') {
      // A defunct child of a live/test browser is normal renderer churn, not a
      // reap-worthy leak — never count it (mirrors classifyDesktop's live-desktop
      // fail-safe, applied to the zombie's PARENT). An unknown parent still counts,
      // preserving the generic "a non-browser parent is not reaping" signal.
      if (s.parentIsBrowser) continue;
      out.push({ pid: s.pid, reason: 'zombie', cpuPercent: 0, ageSeconds: s.ageSeconds, cmdline: s.cmdline.slice(0, 160) });
      continue;
    }
    if (classifyDesktop(s.cmdline) !== 'test-desktop') continue;
    if (s.cpuPercent >= policy.cpuPercentThreshold && s.ageSeconds >= policy.minAgeSeconds) {
      out.push({
        pid: s.pid,
        reason: 'runaway-test-desktop',
        cpuPercent: s.cpuPercent,
        ageSeconds: s.ageSeconds,
        cmdline: s.cmdline.slice(0, 160),
      });
    }
  }
  return out;
}

/** Whether a candidate set warrants an alarm: any runaway desktop, or a zombie
 *  pile at/over the threshold. Pure. */
export function shouldAlarm(candidates: ReapCandidate[], policy: ReaperPolicy = DEFAULT_POLICY): boolean {
  const runaway = candidates.filter((c) => c.reason === 'runaway-test-desktop').length;
  const zombies = candidates.filter((c) => c.reason === 'zombie').length;
  return runaway > 0 || zombies >= policy.zombieAlarmThreshold;
}

/** Build the alarm toast body. Pure — unit-testable. */
export function formatReaperToast(candidates: ReapCandidate[]): { level: string; message: string; description: string } {
  const runaway = candidates.filter((c) => c.reason === 'runaway-test-desktop');
  const zombies = candidates.filter((c) => c.reason === 'zombie');
  const parts: string[] = [];
  if (runaway.length > 0) {
    const lines = runaway
      .map((c) => `• pid ${c.pid}: ${c.cpuPercent.toFixed(0)}% CPU, up ${Math.round(c.ageSeconds / 60)}m — ${c.cmdline}`)
      .join('\n');
    parts.push(`Runaway leaked TEST desktop(s) pegging CPU (Playwright/headless — NOT the live desktop):\n${lines}`);
  }
  if (zombies.length > 0) {
    parts.push(`${zombies.length} zombie/defunct process(es) — a parent is not reaping its children.`);
  }
  const n = runaway.length + (zombies.length > 0 ? 1 : 0);
  return {
    level: 'warning',
    message: `Test-desktop reaper — ${runaway.length} runaway desktop(s)${zombies.length ? ` + ${zombies.length} zombie(s)` : ''}`,
    description:
      `${parts.join('\n\n')}\n\n` +
      `These leak from killed/wedged E2E runs and drain host CPU (round-4 P-006). ` +
      `Reap them from the host (e.g. \`kill <pid>\`); auto-reap is intentionally NOT armed — ` +
      `killing a non-agent host process needs an owner-approved kill path. ` +
      `Tune via PAPERCUSP_TEST_DESKTOP_REAPER_CPU_PCT / _MIN_AGE_SEC / _ZOMBIE_COUNT; disable with PAPERCUSP_TEST_DESKTOP_REAPER=0.` +
      (n === 0 ? '' : ''),
  };
}

// ── Impure sampling + emit (injectable; never throws) ──────────────────────────

export interface ReaperDeps {
  /** Injectable for tests — defaults to a /proc CPU sample. */
  sample?: () => Promise<ProcSample[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

async function defaultSample(): Promise<ProcSample[]> {
  let pids: string[];
  try {
    // Synchronous enumeration — fast, avoids promise overhead per-pid in the hot path.
    pids = (await fsp.readdir('/proc'));
  } catch {
    return [];
  }

  // Pass 1 (cheap): one stat + cmdline read per pid. Keep only zombies and
  // positively browser-looking processes — only those need a CPU sample.
  interface Pre {
    pid: number;
    cmdline: string;
    state: string;
    ticks0: number;
    ageSeconds: number;
    parentIsBrowser?: boolean;
  }
  const now = Date.now();
  const pre: Pre[] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let rawStat = '';
    let stat: { state: string; ticks: number } | null = null;
    try {
      rawStat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      stat = parseProcStat(rawStat);
    } catch {
      continue;
    }
    if (!stat) continue;
    let cmdline = '';
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
    } catch {
      /* zombies have an empty cmdline; keep going on state */
    }
    const isZombie = stat.state === 'Z';
    const isBrowser = classifyDesktop(cmdline) !== 'not-desktop';
    if (!isZombie && !isBrowser) continue;
    // For a zombie, classify its PARENT: a defunct child of a browser/webview is
    // normal renderer churn (not a leak). Read the parent's cmdline via ppid.
    // Fail-safe: any read failure leaves parentIsBrowser undefined → still counts.
    let parentIsBrowser: boolean | undefined;
    if (isZombie) {
      const ppid = parsePpid(rawStat);
      if (ppid != null && ppid > 1) {
        try {
          const pcmd = readFileSync(`/proc/${ppid}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
          parentIsBrowser = classifyDesktop(pcmd) !== 'not-desktop';
        } catch {
          /* parent gone / unreadable — leave undefined (fail toward counting) */
        }
      }
    }
    let ageSeconds = 0;
    try {
      const m = statSync(`/proc/${pid}`).mtimeMs;
      if (m > 0) ageSeconds = Math.floor((now - m) / 1000);
    } catch {
      /* no stat */
    }
    pre.push({ pid: Number(pid), cmdline: cmdline.slice(0, 240), state: stat.state, ticks0: stat.ticks, ageSeconds, parentIsBrowser });
  }

  // Pass 2: CPU sample only the non-zombie candidates.
  const needsCpu = pre.filter((p) => p.state !== 'Z');
  if (needsCpu.length > 0) {
    await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS));
  }
  const out: ProcSample[] = [];
  for (const p of pre) {
    let cpuPercent = 0;
    if (p.state !== 'Z') {
      try {
        const s = parseProcStat(readFileSync(`/proc/${p.pid}/stat`, 'utf8'));
        if (s) {
          const dTicks = s.ticks - p.ticks0;
          cpuPercent = (dTicks / USER_HZ / (CPU_SAMPLE_MS / 1000)) * 100;
          if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = 0;
        }
      } catch {
        /* process exited between samples — treat as 0, it's gone */
      }
    }
    out.push({ pid: p.pid, cmdline: p.cmdline, state: p.state, cpuPercent, ageSeconds: p.ageSeconds, parentIsBrowser: p.parentIsBrowser });
  }
  return out;
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors storage-growth-alarm / agent-governor-observer).
  void (async () => {
    const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

/**
 * One read-only pass: sample processes, detect leaked test desktops + a zombie
 * pile, toast on an alarm. Never throws — observability is best-effort, mirroring
 * the other periodic monitors.
 */
export async function runTestDesktopReaperOnce(
  deps: ReaperDeps = {},
  policy: ReaperPolicy = policyFromEnv(),
): Promise<{ sampled: number; candidates: ReapCandidate[]; alarmed: boolean }> {
  const sample = deps.sample ?? defaultSample;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  let samples: ProcSample[] = [];
  try {
    samples = await sample();
  } catch (err) {
    console.warn(`[test-desktop-reaper] sample skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    return { sampled: 0, candidates: [], alarmed: false };
  }

  const candidates = findReapCandidates(samples, policy);
  const alarmed = shouldAlarm(candidates, policy);
  if (alarmed) {
    try {
      await emitToast(formatReaperToast(candidates));
    } catch (err) {
      console.warn(`[test-desktop-reaper] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
  }
  return { sampled: samples.length, candidates, alarmed };
}

// ── Slice 2: adv-session-based kill of leaked papercusp-desktop instances ──────
//
// Discovers papercusp-desktop (and oddsmith-desktop) processes that carry a
// PAPERCUSP_ADV_SESSION_ID env var pointing to an ENDED adv_session row. These
// are agent-spawned test desktops (E2E / tauri-agent-tools runs) that were never
// cleaned up. Kills them and their child WebKitWebProcess renderers.
//
// The ENDED check uses the session's numeric row id (not the uuid) because that is
// what the env var carries; every id is unique so a simple `ended_at IS NOT NULL`
// is correct (no "multiple rows for same uuid" ambiguity). A DESKTOP_GRACE_MS
// buffer prevents killing a desktop that is mid-shutdown.
//
// See the module header for the full safety model.
// ───────────────────────────────────────────────────────────────────────────────

/** Desktop binary names to scan for (debug AND release Tauri builds). */
const DESKTOP_BINARY_RE = /papercusp-desktop|oddsmith-desktop/i;

/** Grace after the adv_session.ended_at before we consider the desktop leakable.
 *  2 minutes is enough for a clean shutdown; a desktop still alive past it is
 *  confirmed leaked. */
const DESKTOP_GRACE_MS = 2 * 60 * 1000;

/** SIGTERM → wait this long → SIGKILL. */
const KILL_GRACE_MS = 3000;

/** A discovered desktop process with its adv_session handle. */
export interface AdvSessionDesktopProc {
  pid: number;
  cmdline: string;
  advSessionId: number;
}

/**
 * PURE: parse the process group id (pgrp) from a /proc/<pid>/stat string.
 * Post-')' tokens: [0]=state [1]=ppid [2]=pgrp. Returns null on parse failure.
 */
export function parsePgid(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  // index 2 = pgrp (0-based relative to the post-')' tokens)
  const pgrp = Number(rest[2]);
  return Number.isFinite(pgrp) && pgrp > 0 ? pgrp : null;
}

/**
 * PURE: parse the parent pid (ppid) from a /proc/<pid>/stat string.
 * Post-')' tokens: [0]=state [1]=ppid. Returns null on parse failure.
 */
export function parsePpid(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
}

/**
 * Check whether the process's cmdline still matches — PID-recycle guard.
 * Returns false on any read error (gone → safe, do not signal).
 */
async function stillHasAdvSessionEnv(pid: number, advSessionId: number): Promise<boolean> {
  try {
    const env = await fsp.readFile(`/proc/${pid}/environ`, 'utf8');
    return env.includes(`PAPERCUSP_ADV_SESSION_ID=${advSessionId}`);
  } catch {
    return false;
  }
}

export interface DesktopKillDeps {
  /** Enumerate /proc entries (injectable). */
  listProc: () => Promise<string[]>;
  /** Read /proc/<pid>/cmdline (injectable). */
  readCmdline: (pid: number) => Promise<string>;
  /** Read /proc/<pid>/environ (injectable). */
  readEnviron: (pid: number) => Promise<string>;
  /** Read /proc/<pid>/stat (injectable). */
  readStat: (pid: number) => Promise<string>;
  /** Query which numeric adv_session ids have ended AND the grace period elapsed. */
  endedAdvSessionIds: (ids: number[], graceMs: number) => Promise<Set<number>>;
  /** Pre-kill safety check: does the process still carry the expected env var? */
  pidCarriesSessionId: (pid: number, advSessionId: number) => Promise<boolean>;
  /** Send signal to a pid; returns false on error (gone / permission). */
  sigterm: (pid: number) => boolean;
  sigkill: (pid: number) => boolean;
  /** Is the pid still alive? */
  pidAlive: (pid: number) => boolean;
  /** Wait before the SIGKILL pass. */
  wait: (ms: number) => Promise<void>;
}

export interface DesktopKillResult {
  /** False when the flag is off (action is a no-op). */
  enabled: boolean;
  dryRun: boolean;
  /** Desktop procs scanned. */
  scanned: number;
  /** Pids of desktops (+ children) killed or WOULD kill. */
  killed: number[];
  /** Pids that were found but skipped (session still open / too fresh). */
  skipped: number[];
}

// ── Default (production) implementations ──────────────────────────────────────

async function defaultListProc(): Promise<string[]> {
  try {
    return await fsp.readdir('/proc');
  } catch {
    return [];
  }
}

async function defaultReadCmdline(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
}

async function defaultReadEnviron(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/environ`, 'utf8');
}

async function defaultReadStat(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/stat`, 'utf8');
}

async function defaultEndedAdvSessionIds(ids: number[], graceMs: number): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { sql } = getOrgPg();
  // A numeric adv_session id is "cleanly ended" when the row exists, ended_at is set,
  // AND ended_at is old enough (grace buffer). Each id is unique, so `ended_at IS NOT NULL`
  // alone is the right check — no multi-row "did it resume?" concern (unlike the uuid path).
  const rows = await sql<Array<{ id: number }>>`
    SELECT id
      FROM harness_shared.adv_sessions
     WHERE id = ANY(${ids})
       AND ended_at IS NOT NULL
       AND ended_at < NOW() - make_interval(secs => ${Math.ceil(graceMs / 1000)})`;
  return new Set(rows.map((r) => r.id));
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_KILL_DEPS: DesktopKillDeps = {
  listProc: defaultListProc,
  readCmdline: defaultReadCmdline,
  readEnviron: defaultReadEnviron,
  readStat: defaultReadStat,
  endedAdvSessionIds: defaultEndedAdvSessionIds,
  pidCarriesSessionId: (pid, id) => stillHasAdvSessionEnv(pid, id),
  sigterm: (pid) => { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } },
  sigkill: (pid) => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  pidAlive: defaultPidAlive,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Enumerate /proc to find papercusp-desktop processes carrying
 * PAPERCUSP_ADV_SESSION_ID in their environment.
 * Best-effort: any per-pid read failure is silently skipped.
 */
async function discoverDesktopProcs(deps: DesktopKillDeps): Promise<AdvSessionDesktopProc[]> {
  const pids = await deps.listProc();
  const candidates: AdvSessionDesktopProc[] = [];

  for (const pidStr of pids) {
    if (!/^\d+$/.test(pidStr)) continue;
    const pid = Number(pidStr);

    // Filter by cmdline: must be a desktop binary
    let cmdline = '';
    try {
      cmdline = (await deps.readCmdline(pid)).replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!DESKTOP_BINARY_RE.test(cmdline)) continue;

    // Read PAPERCUSP_ADV_SESSION_ID from environment
    let advSessionId: number | null = null;
    try {
      const env = await deps.readEnviron(pid);
      for (const part of env.split('\0')) {
        if (part.startsWith('PAPERCUSP_ADV_SESSION_ID=')) {
          const v = Number(part.slice('PAPERCUSP_ADV_SESSION_ID='.length));
          if (Number.isFinite(v) && v > 0) { advSessionId = v; break; }
        }
      }
    } catch {
      continue; // environ unreadable (process gone / different user)
    }
    if (advSessionId == null) continue; // not agent-spawned

    candidates.push({ pid, cmdline: cmdline.slice(0, 200), advSessionId });
  }
  return candidates;
}

/**
 * Find direct child WebKitWebProcess / WPEWebDriver children of the given desktop
 * pids. Only examines /proc entries — best-effort.
 */
async function discoverWebkitChildren(
  desktopPids: Set<number>,
  deps: DesktopKillDeps,
): Promise<Array<{ pid: number; parentPid: number }>> {
  if (desktopPids.size === 0) return [];
  const pids = await deps.listProc();
  const out: Array<{ pid: number; parentPid: number }> = [];
  for (const pidStr of pids) {
    if (!/^\d+$/.test(pidStr)) continue;
    const pid = Number(pidStr);
    if (desktopPids.has(pid)) continue; // skip the parent itself
    try {
      const stat = await deps.readStat(pid);
      const ppid = parsePpid(stat);
      if (ppid != null && desktopPids.has(ppid)) {
        // Only grab webkit / wpe children; skip unrelated children
        let cmdline = '';
        try { cmdline = (await deps.readCmdline(pid)).replace(/\0/g, ' '); } catch { /* ok */ }
        if (/webkitwebprocess|wpewebdriver|webkitnetworkprocess/i.test(cmdline)) {
          out.push({ pid, parentPid: ppid });
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

// ── Kill sweep ────────────────────────────────────────────────────────────────

/**
 * Discover and kill papercusp-desktop / oddsmith-desktop processes whose
 * PAPERCUSP_ADV_SESSION_ID session is ENDED. Also kills their WebKitWebProcess
 * children. SIGTERM → 3-second grace → SIGKILL; per-process errors are isolated.
 *
 * dryRun=true plans + logs, kills nothing.
 */
export async function killDesktopProcsWithEndedSessions(
  opts: { dryRun?: boolean; graceMs?: number; deps?: Partial<DesktopKillDeps> } = {},
): Promise<DesktopKillResult> {
  const dryRun = opts.dryRun ?? false;
  const graceMs = opts.graceMs ?? DESKTOP_GRACE_MS;
  const deps: DesktopKillDeps = { ...DEFAULT_KILL_DEPS, ...opts.deps };

  // Discover all desktop processes with a PAPERCUSP_ADV_SESSION_ID
  let desktopProcs: AdvSessionDesktopProc[] = [];
  try {
    desktopProcs = await discoverDesktopProcs(deps);
  } catch {
    return { enabled: true, dryRun, scanned: 0, killed: [], skipped: [] };
  }
  if (desktopProcs.length === 0) {
    return { enabled: true, dryRun, scanned: 0, killed: [], skipped: [] };
  }

  // Which sessions are cleanly ended (with grace buffer)?
  const uniqueIds = [...new Set(desktopProcs.map((p) => p.advSessionId))];
  let ended: Set<number>;
  try {
    ended = await deps.endedAdvSessionIds(uniqueIds, graceMs);
  } catch {
    return { enabled: true, dryRun, scanned: desktopProcs.length, killed: [], skipped: [] };
  }

  const toKill = desktopProcs.filter((p) => ended.has(p.advSessionId));
  const skipped = desktopProcs.filter((p) => !ended.has(p.advSessionId)).map((p) => p.pid);

  if (toKill.length === 0) {
    return { enabled: true, dryRun, scanned: desktopProcs.length, killed: [], skipped };
  }

  // Discover WebKitWebProcess children of the to-kill set
  const desktopPidSet = new Set(toKill.map((p) => p.pid));
  let webkitChildren: Array<{ pid: number; parentPid: number }> = [];
  try {
    webkitChildren = await discoverWebkitChildren(desktopPidSet, deps);
  } catch {
    webkitChildren = [];
  }

  const killedPids: number[] = [];

  if (dryRun) {
    // Dry run: report what would be killed without signalling anything.
    for (const d of toKill) killedPids.push(d.pid);
    for (const c of webkitChildren) killedPids.push(c.pid);
    return { enabled: true, dryRun: true, scanned: desktopProcs.length, killed: killedPids, skipped };
  }

  // Step 1: SIGTERM the desktop processes; track which ones passed the
  // recycle guard. Webkit children are ONLY signalled when their parent passed.
  const confirmedDesktopPids = new Set<number>();
  for (const d of toKill) {
    try {
      if (!(await deps.pidCarriesSessionId(d.pid, d.advSessionId))) continue; // recycle guard
      deps.sigterm(d.pid);
      confirmedDesktopPids.add(d.pid);
    } catch { /* isolated */ }
  }
  // SIGTERM webkit children of confirmed desktops only.
  const confirmedChildren = webkitChildren.filter((c) => confirmedDesktopPids.has(c.parentPid));
  for (const c of confirmedChildren) {
    try { deps.sigterm(c.pid); } catch { /* isolated */ }
  }

  // Step 2: Grace period.
  await deps.wait(KILL_GRACE_MS);

  // Step 3: SIGKILL survivors.
  for (const d of toKill) {
    if (!confirmedDesktopPids.has(d.pid)) continue; // recycle guard already failed in step 1
    try {
      if (!deps.pidAlive(d.pid)) { killedPids.push(d.pid); continue; }
      if (!(await deps.pidCarriesSessionId(d.pid, d.advSessionId))) continue; // post-wait recycle guard
      deps.sigkill(d.pid);
      killedPids.push(d.pid);
    } catch { /* isolated */ }
  }
  for (const c of confirmedChildren) {
    try {
      if (!deps.pidAlive(c.pid)) { killedPids.push(c.pid); continue; }
      deps.sigkill(c.pid);
      killedPids.push(c.pid);
    } catch { /* isolated */ }
  }

  return { enabled: true, dryRun: false, scanned: desktopProcs.length, killed: killedPids, skipped };
}
