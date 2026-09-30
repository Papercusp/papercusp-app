#!/usr/bin/env node
/**
 * pc-heavy-jobs — list and safely stop admitted pc-heavy jobs.
 *
 * WHY THIS EXISTS (EI-22066972653982768)
 * --------------------------------------
 * `processes:kill { taskId }` is the sanctioned runaway-process surface, but it
 * only reaches processes enrolled in the task ledger. A heavy job started by
 * `scripts/pc-heavy.sh` (every `npm run test:affected`, `test:file`, typecheck,
 * …) is NOT ledger-enrolled: handing `processes:kill` the exact live pid of a
 * `node scripts/affected-tests.mjs` child is refused with
 * `unsupported_kind` (classified kind=other). So when an unscoped
 * `test:affected` expands fleet-wide and pins the box, the one sanctioned kill
 * surface cannot stop it, and the documented fallback — `pkill -f <pattern>` —
 * is exactly the pattern-kill this repo forbids (it has twice killed the
 * owner's live desktop and peer agents' Xvfb instances).
 *
 * The tracking data needed to stop such a job SAFELY already exists and is
 * written by default: preemptible mode (`PC_HEAVY_PREEMPTIBLE=auto` → 1
 * whenever `setsid` is present, i.e. effectively always) plus
 * `PC_HEAVY_PSI_ADMISSION=1` make pc-heavy write one record per admitted job to
 * `$PC_HEAVY_ADMISSION_DIR/<admission_id>.state`. Nothing in TypeScript reads
 * that directory. The gap is purely "no sanctioned tool reads these records and
 * offers a safe kill" — NOT "pc-heavy fails to track its children". This script
 * is therefore purely additive: it makes ZERO changes to pc-heavy.sh's hot
 * execution/admission path.
 *
 * THE REUSE-SAFETY CONTRACT
 * -------------------------
 * A record carries both `pid` and `start_ticks` (field 22 of /proc/<pid>/stat,
 * the process start time in clock ticks). A bare pid is NOT a safe kill target
 * here: PID wrap happens ~daily on this box under fleet load, so a stale record
 * can name a pid that now belongs to something else entirely. We therefore
 * re-read the live start_ticks and require an EXACT match before signalling —
 * the same pid+start_ticks pair pc-heavy's own reap function trusts before it
 * runs `kill -TERM -- "-<pid>"`. A missing or mismatched value is a REFUSAL,
 * never a "kill anyway".
 *
 * Kill semantics match pc-heavy's own reap: SIGTERM to the process GROUP
 * (`-pid` — setsid makes each job its own session/pgid, so the recorded pid is
 * the group leader), then SIGKILL to the group after a grace window if it is
 * still alive. Killing the group is what actually stops the job: the npm →
 * node → vitest chain leaves orphans behind if you signal only the leader.
 *
 * Everything is injectable (`admissionDir`, `procRoot`, `killFn`, `sleepFn`) so
 * the unit tests drive it against a fixture /proc with a fake signal function
 * and never send a real signal.
 *
 * USAGE
 *   node scripts/pc-heavy-jobs.mjs list [--json] [--all]
 *   node scripts/pc-heavy-jobs.mjs kill <admission_id> [--grace-ms=<n>] [--dry-run]
 *
 * Exit codes: 0 success · 1 refused / not found / nothing killed · 2 usage or
 * unexpected error.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";

export const DEFAULT_PROC_ROOT = "/proc";
export const DEFAULT_GRACE_MS = 5000;

/**
 * Resolve the admission directory pc-heavy writes to, mirroring its own
 * resolution order exactly:
 *   $PC_HEAVY_ADMISSION_DIR
 *   ${PC_HEAVY_DIR:-${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots}/psi-admissions
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveAdmissionDir(env = process.env) {
  if (env.PC_HEAVY_ADMISSION_DIR) return env.PC_HEAVY_ADMISSION_DIR;
  const base =
    env.PC_HEAVY_DIR ||
    path.join(env.XDG_RUNTIME_DIR || "/tmp", "pc-heavy-slots");
  return path.join(base, "psi-admissions");
}

/**
 * Parse a pc-heavy admission record (`key=value` lines). Unknown keys are kept
 * verbatim so a future pc-heavy field is visible to `list --json` without a
 * change here. A malformed line is skipped rather than failing the whole read:
 * a partially-written record must never be able to hide a live runaway job.
 * @param {string} raw
 * @returns {Record<string,string>}
 */
export function parseAdmissionRecord(raw) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const line of String(raw).split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Split the fields of a /proc/<pid>/stat line that FOLLOW the comm field.
 *
 * `comm` is parenthesized and may itself contain spaces and parentheses (a
 * process can be named `(evil) 1 2 3`), so the only safe split is through the
 * LAST `") "`. After that, token 1 is field 3 (state) — hence token 3 is field
 * 5 (pgrp) and token 20 is field 22 (starttime). This mirrors
 * `_pc_heavy_proc_start_ticks` in pc-heavy.sh so the two cannot disagree about
 * which number is the start time.
 * @param {string} statLine
 * @returns {string[]}
 */
export function fieldsAfterComm(statLine) {
  const s = String(statLine);
  const idx = s.lastIndexOf(") ");
  if (idx < 0) return [];
  return s
    .slice(idx + 2)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Read a live process's start_ticks (field 22), or null when the pid is gone or
 * unreadable. Null is a REFUSAL input, never "assume it matches".
 * @param {number|string} pid
 * @param {{ procRoot?: string }} [opts]
 * @returns {string|null}
 */
export function readStartTicks(pid, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  if (!/^\d+$/.test(String(pid))) return null;
  let stat;
  try {
    stat = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  const fields = fieldsAfterComm(stat);
  return fields.length >= 20 ? fields[19] : null;
}

/**
 * Read a live process's process-group id (field 5), or null.
 * @param {number|string} pid
 * @param {{ procRoot?: string }} [opts]
 * @returns {string|null}
 */
export function readPgid(pid, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  if (!/^\d+$/.test(String(pid))) return null;
  let stat;
  try {
    stat = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  const fields = fieldsAfterComm(stat);
  return fields.length >= 3 ? fields[2] : null;
}

/**
 * Decide whether a record still names the process it was written for.
 *
 * Returns one of:
 *   live            — pid is alive AND start_ticks matches; safe to signal
 *   gone            — pid no longer exists; the job already ended
 *   recycled        — pid exists but start_ticks differs: the pid was REUSED by
 *                     an unrelated process. Signalling it would kill a
 *                     bystander, so this is a hard refusal.
 *   malformed       — record lacks a usable pid/start_ticks pair
 * @param {Record<string,string>} record
 * @param {string|null} liveTicks
 * @returns {'live'|'gone'|'recycled'|'malformed'}
 */
export function classifyRecord(record, liveTicks) {
  const pid = record?.pid;
  const ticks = record?.start_ticks;
  if (!/^\d+$/.test(String(pid)) || !/^\d+$/.test(String(ticks)))
    return "malformed";
  if (liveTicks === null || liveTicks === undefined) return "gone";
  return String(liveTicks) === String(ticks) ? "live" : "recycled";
}

/**
 * List every admission record with its verified liveness.
 *
 * Unlike pc-heavy's own scanner this NEVER deletes a stale record — an
 * inspection command that mutates shared runtime state would make `list` unsafe
 * to run while the coordinator is electing a victim. Reaping stays pc-heavy's
 * job.
 * @param {{ admissionDir?: string; procRoot?: string; env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Array<{admissionId:string,pid:number|null,startTicks:string|null,
 *   status:'live'|'gone'|'recycled'|'malformed',state:string|null,
 *   priority:string|null,admittedAt:string|null,cgroupPath:string|null,
 *   memoryCurrentMib:string|null,file:string,record:Record<string,string>}>}
 */
export function listJobs(opts = {}) {
  const admissionDir = opts.admissionDir ?? resolveAdmissionDir(opts.env);
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  let entries;
  try {
    entries = readdirSync(admissionDir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".state")) continue;
    const file = path.join(admissionDir, name);
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const record = parseAdmissionRecord(raw);
    const liveTicks = readStartTicks(record.pid, { procRoot });
    const status = classifyRecord(record, liveTicks);
    rows.push({
      admissionId: record.admission_id || name.replace(/\.state$/, ""),
      pid: /^\d+$/.test(String(record.pid)) ? Number(record.pid) : null,
      startTicks: record.start_ticks ?? null,
      status,
      state: record.state ?? null,
      priority: record.priority ?? null,
      admittedAt: record.admitted_at ?? null,
      cgroupPath: record.cgroup_path ?? null,
      memoryCurrentMib: record.memory_current_mib ?? null,
      file,
      record,
    });
  }
  return rows;
}

/**
 * Stop one admitted job by admission id, with the pid+start_ticks reuse-safety
 * check enforced before any signal is sent.
 *
 * @param {string} admissionId
 * @param {{ admissionDir?: string; procRoot?: string; env?: NodeJS.ProcessEnv;
 *   killFn?: (pid:number, signal:string)=>void; sleepFn?: (ms:number)=>Promise<void>;
 *   graceMs?: number; dryRun?: boolean; selfPid?: number }} [opts]
 * @returns {Promise<{ok:boolean,outcome:string,detail:string,signals:string[],job?:object}>}
 */
export async function killJob(admissionId, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const killFn = opts.killFn ?? ((pid, signal) => process.kill(pid, signal));
  const sleepFn =
    opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const selfPid = opts.selfPid ?? process.pid;
  /** @type {string[]} */
  const signals = [];

  const jobs = listJobs({
    admissionDir: opts.admissionDir,
    procRoot,
    env: opts.env,
  });
  const job = jobs.find((j) => j.admissionId === admissionId);
  if (!job)
    return {
      ok: false,
      outcome: "not-found",
      detail: `no admission record with id ${admissionId}`,
      signals,
    };

  if (job.status !== "live") {
    const why = {
      gone: "the recorded pid no longer exists — the job already ended",
      recycled:
        "the recorded pid is alive but its start_ticks differ: the pid was REUSED by an unrelated process. Refusing to signal a bystander",
      malformed: "the record has no usable pid/start_ticks pair",
    }[job.status];
    return { ok: false, outcome: `refused:${job.status}`, detail: why, signals, job };
  }

  // Self-protection: the recorded pid is its own process-group leader, so if
  // that group is OUR group, signalling it would kill this very process (and,
  // in an agent session, the agent). Refuse rather than self-destruct.
  const ourPgid = readPgid(selfPid, { procRoot });
  if (ourPgid !== null && String(job.pid) === String(ourPgid))
    return {
      ok: false,
      outcome: "refused:self",
      detail: `admission ${admissionId} names our own process group (${ourPgid})`,
      signals,
      job,
    };

  if (opts.dryRun)
    return {
      ok: true,
      outcome: "dry-run",
      detail: `would SIGTERM process group -${job.pid} (verified start_ticks ${job.startTicks})`,
      signals,
      job,
    };

  // Signal the GROUP, matching pc-heavy's own reap (`kill -TERM -- "-<pid>"`).
  killFn(-job.pid, "SIGTERM");
  signals.push("SIGTERM");

  // Re-verify identity on each poll, not just liveness: if the pid vanishes and
  // is recycled inside the grace window, `kill -0` would report "still alive"
  // and we would escalate SIGKILL onto a bystander.
  const deadline = graceMs;
  let waited = 0;
  const step = Math.max(1, Math.min(250, graceMs));
  while (waited < deadline) {
    await sleepFn(step);
    waited += step;
    const nowTicks = readStartTicks(job.pid, { procRoot });
    if (classifyRecord(job.record, nowTicks) !== "live")
      return {
        ok: true,
        outcome: "terminated",
        detail: `process group -${job.pid} exited after SIGTERM`,
        signals,
        job,
      };
  }

  killFn(-job.pid, "SIGKILL");
  signals.push("SIGKILL");
  const finalTicks = readStartTicks(job.pid, { procRoot });
  const stillLive = classifyRecord(job.record, finalTicks) === "live";
  return {
    ok: !stillLive,
    outcome: stillLive ? "still-alive" : "killed",
    detail: stillLive
      ? `process group -${job.pid} survived SIGKILL`
      : `process group -${job.pid} killed after ${graceMs}ms grace`,
    signals,
    job,
  };
}

/** @param {string[]} argv @returns {Record<string,string|boolean>} */
export function parseFlags(argv) {
  /** @type {Record<string,string|boolean>} */
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/** Human-readable one-line rendering of a job row. */
export function formatJob(job) {
  const mem =
    job.memoryCurrentMib && job.memoryCurrentMib !== "unknown"
      ? `${job.memoryCurrentMib}MiB`
      : "mem?";
  return `  ${job.status.padEnd(9)} ${String(job.pid ?? "-").padStart(7)}  prio=${
    job.priority ?? "?"
  } state=${job.state ?? "?"} ${mem}  ${job.admissionId}`;
}

const USAGE = `usage:
  node scripts/pc-heavy-jobs.mjs list [--json] [--all]
  node scripts/pc-heavy-jobs.mjs kill <admission_id> [--grace-ms=<n>] [--dry-run]

Lists / stops jobs admitted by scripts/pc-heavy.sh. A kill is refused unless the
record's pid AND start_ticks both still match the live process, so a recycled
pid can never be signalled. Signals go to the process GROUP, matching pc-heavy's
own reap.

By default \`list\` shows only live jobs; --all includes stale records.`;

/** @param {string[]} argv */
export async function main(argv) {
  const cmd = argv[0];
  const flags = parseFlags(argv);
  const admissionDir =
    typeof flags["admission-dir"] === "string"
      ? flags["admission-dir"]
      : undefined;

  if (cmd === "list") {
    const all = flags.all === true;
    const jobs = listJobs({ admissionDir }).filter(
      (j) => all || j.status === "live",
    );
    // `list` is the command that gets piped, and both of its payloads are
    // data-derived and unbounded (a JSON dump, or one line per job). process.exit()
    // tears the process down without waiting for a pipe's async stdout write to
    // flush, so a large list silently arrives truncated to its reader. Returning
    // instead lets the program end naturally with the same status 0 — the CLI
    // entry below does not force an exit on success.
    if (flags.json === true) {
      console.log(JSON.stringify(jobs.map(({ record, ...j }) => j), null, 2));
      return;
    }
    if (jobs.length === 0) {
      console.log(
        all
          ? "pc-heavy-jobs: no admission records found."
          : "pc-heavy-jobs: no live admitted jobs (use --all to see stale records).",
      );
      return;
    }
    console.log(`pc-heavy-jobs: ${jobs.length} job(s):`);
    for (const job of jobs) console.log(formatJob(job));
    return;
  }

  if (cmd === "kill") {
    const admissionId = argv[1];
    if (!admissionId || admissionId.startsWith("--")) {
      console.error("pc-heavy-jobs: kill needs an <admission_id>\n\n" + USAGE);
      process.exit(2);
    }
    const graceMs =
      typeof flags["grace-ms"] === "string"
        ? Number(flags["grace-ms"])
        : DEFAULT_GRACE_MS;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      console.error("pc-heavy-jobs: --grace-ms must be a non-negative number");
      process.exit(2);
    }
    const result = await killJob(admissionId, {
      admissionDir,
      graceMs,
      dryRun: flags["dry-run"] === true,
    });
    console.log(`pc-heavy-jobs: ${result.outcome} — ${result.detail}`);
    if (result.signals.length)
      console.log(`  signals sent: ${result.signals.join(", ")}`);
    process.exit(result.ok ? 0 : 1);
  }

  console.error(USAGE);
  process.exit(2);
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`pc-heavy-jobs: ${e?.message ?? e}`);
    process.exit(2);
  });
}
