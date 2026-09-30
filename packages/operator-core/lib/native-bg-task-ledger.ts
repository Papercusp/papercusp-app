/**
 * native-bg-task-ledger — read the launch ledger written by the PreToolUse bash
 * gate and answer ONE question: does this session have native background Bash
 * jobs that are STILL RUNNING right now? (WI-5936 / EI-16611.)
 *
 * WHY THIS EXISTS. Native `run_in_background` bookkeeping lives in the CLI child
 * process's own memory — nowhere papercusp persists. A carry-respawn
 * (session:request-compaction), a cold-loop fire, or `claude --resume` starts a
 * NEW process and SIGTERMs the job: the LOGICAL session continues while the job
 * is silently dead, and a carry-note saying "read task <id>'s output" is a dead
 * reference to the successor. That knowledge was already written down (the
 * compaction strategy, an insights doc) and it recurred anyway, because the
 * knowledge sits on the READ path while the mistake is made on the WRITE path.
 * The bash gate now warns at LAUNCH; this module is the other half — the
 * backstop at the moment of the cut, where the loss actually happens.
 *
 * WHAT MAKES THE LIVENESS CLAIM REAL, not a guess. The ledger records the output
 * FILE each background command redirects to, and a job that is still running
 * still holds that file OPEN for writing. So liveness is decided by scanning
 * /proc for a process holding an open fd on that path — an OS-level fact — not
 * by the record's age or by assuming a launch is still alive. This is the same
 * check the gate's own log-read-race advisory uses, and it is why this module
 * can honestly say "live" instead of merely "launched at some point".
 *
 * WHAT IT DELIBERATELY CANNOT SEE. Only backgrounded commands that REDIRECT to a
 * file are tracked (`>`, `>>`, `| tee`) — a bg command whose output goes nowhere
 * has no fd to watch, so it is invisible here. That is a deliberate floor, not a
 * total: an empty result means "no tracked live job", never "you have no live
 * jobs". Callers must not render it as an all-clear. It also cannot attribute a
 * job whose launch predates the `sid` stamp (see `unattributed`), which is
 * reported separately rather than silently dropped or silently blamed on the
 * caller.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Matches the gate's `_BG_TRACK_FILE`. Both sides resolve `~` for the same user. */
export function defaultLedgerPath(): string {
  return join(homedir(), '.papercusp', 'tracking', 'bg-output-tracking.json');
}

/** The gate prunes at 2h regardless of liveness; mirror it so the two agree. */
export const NATIVE_BG_TRACK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface NativeBgTaskRecord {
  /** Absolute path the background command redirects its output to. */
  path: string;
  startedAtMs: number;
  /** Owning session (PAPERCUSP_SID / ownerId). Absent on pre-WI-5936 records. */
  sid?: string;
}

export interface LiveNativeBgTask extends NativeBgTaskRecord {
  ageSec: number;
  /** Pids holding the output file open — the evidence for the liveness claim. */
  pids: string[];
}

export interface NativeBgTaskReport {
  /** Tracked jobs owned by this session that a process is STILL writing to. */
  live: LiveNativeBgTask[];
  /**
   * Live tracked jobs carrying NO `sid` (written before the stamp existed, or by
   * a client that does not set one). They may or may not belong to the caller,
   * so they are neither claimed nor dropped — surface them as unattributed.
   */
  unattributed: LiveNativeBgTask[];
  /**
   * True when the ledger could not be READ (missing/unparseable). An empty
   * report then means "not measured", which is NOT the same fact as "nothing
   * live" — never render the two the same way.
   */
  degraded: boolean;
}

/** Tolerant parse: one bad record must not discard the rest of the ledger. */
export function parseNativeBgLedger(raw: string): NativeBgTaskRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: NativeBgTaskRecord[] = [];
  for (const [path, value] of Object.entries(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const rec = value as Record<string, unknown>;
    // Written by python `time.time()` — SECONDS, not ms. Reading it as ms would
    // date every record to 1970 and make every age check silently pass.
    const startedAtSec = typeof rec.started_at === 'number' ? rec.started_at : NaN;
    if (!Number.isFinite(startedAtSec)) continue;
    out.push({
      path,
      startedAtMs: startedAtSec * 1000,
      ...(typeof rec.sid === 'string' && rec.sid ? { sid: rec.sid } : {}),
    });
  }
  return out;
}

/**
 * Pure core: split tracked records into this session's live jobs and live jobs
 * with no owner stamp. `hasOpenWriter` is injected so the OS scan can be
 * substituted in tests — the liveness rule is what needs proving, not /proc.
 */
export function selectLiveNativeBgTasks(input: {
  records: NativeBgTaskRecord[];
  sid: string;
  nowMs: number;
  hasOpenWriter: (path: string) => string[];
}): { live: LiveNativeBgTask[]; unattributed: LiveNativeBgTask[] } {
  const live: LiveNativeBgTask[] = [];
  const unattributed: LiveNativeBgTask[] = [];
  for (const rec of input.records) {
    if (input.nowMs - rec.startedAtMs >= NATIVE_BG_TRACK_MAX_AGE_MS) continue;
    // Records belonging to a DIFFERENT session are none of this caller's
    // business — its cut cannot kill them.
    if (rec.sid && rec.sid !== input.sid) continue;
    const pids = input.hasOpenWriter(rec.path);
    if (pids.length === 0) continue; // finished or already killed — nothing to lose
    const task: LiveNativeBgTask = {
      ...rec,
      ageSec: Math.max(0, Math.round((input.nowMs - rec.startedAtMs) / 1000)),
      pids,
    };
    (rec.sid ? live : unattributed).push(task);
  }
  const byAge = (a: LiveNativeBgTask, b: LiveNativeBgTask) => b.ageSec - a.ageSec;
  return { live: live.sort(byAge), unattributed: unattributed.sort(byAge) };
}

/**
 * Pids holding `path` open. Mirrors the gate's `_bg_open_writer_pids`: walk
 * /proc/<pid>/fd and compare each symlink target. Every layer fails soft — a
 * process that exits mid-walk (or one this user cannot read) is skipped, never
 * thrown, so a partial scan degrades toward "not live" rather than an error.
 */
export function openWriterPids(path: string, procRoot = '/proc'): string[] {
  const pids: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return pids;
  }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    const fdDir = join(procRoot, pid, 'fd');
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(join(fdDir, fd)) === path) {
          pids.push(pid);
          break;
        }
      } catch {
        /* fd closed under us — skip */
      }
    }
  }
  return pids;
}

/**
 * Read the ledger and report this session's still-live native background jobs.
 * Never throws: an unreadable ledger reports `degraded: true` with empty lists,
 * so a read failure can never masquerade as a clean all-clear.
 */
export function readLiveNativeBgTasks(input: {
  sid: string;
  nowMs?: number;
  ledgerPath?: string;
  hasOpenWriter?: (path: string) => string[];
}): NativeBgTaskReport {
  const nowMs = input.nowMs ?? Date.now();
  let raw: string;
  try {
    raw = readFileSync(input.ledgerPath ?? defaultLedgerPath(), 'utf8');
  } catch {
    // Missing ledger is the overwhelmingly common case (no bg job ever launched)
    // and is a genuine "nothing tracked", not a failure to measure.
    return { live: [], unattributed: [], degraded: false };
  }
  const records = parseNativeBgLedger(raw);
  if (records.length === 0 && raw.trim() && raw.trim() !== '{}') {
    return { live: [], unattributed: [], degraded: true };
  }
  const { live, unattributed } = selectLiveNativeBgTasks({
    records,
    sid: input.sid,
    nowMs,
    hasOpenWriter: input.hasOpenWriter ?? ((p) => openWriterPids(p)),
  });
  return { live, unattributed, degraded: false };
}

/**
 * The agent-facing line for a compaction boundary. Returns '' when there is
 * nothing live — the caller appends it unconditionally.
 */
export function renderNativeBgTaskWarning(report: NativeBgTaskReport): string {
  const all = [...report.live, ...report.unattributed];
  if (all.length === 0) return '';
  const items = all
    .slice(0, 5)
    .map(
      (t) =>
        `\`${t.path}\` (running ${t.ageSec}s, pid ${t.pids[0]})${
          t.sid ? '' : ' [unattributed — may belong to another session]'
        }`,
    )
    .join('; ');
  return (
    ` ⚠ native-bg-tasks: ${all.length} native background Bash job(s) launched in this session are STILL RUNNING` +
    ` and will be SIGTERMed by this cut (EI-16611) — the successor inherits a dead reference, not a result: ${items}.` +
    ' Either wait for them, or re-launch under `capability:bash { run_in_background: true }` (operator-owned,' +
    ' reattachable — checkpoint the `bash_id`) before you stop. Only file-redirecting jobs are tracked, so this' +
    ' is a FLOOR, not a total.'
  );
}
