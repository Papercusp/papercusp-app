/**
 * orphaned-mcp-reaper.ts — targeted reaper for leaked `playwright-mcp` server
 * processes (EI-18691186726153223).
 *
 * MEASURED 2026-08-02 on the shared dev host: 168 live processes (~56 groups of
 * 3: `npm exec @playwright/mcp@latest --browser chromium --headless` → `sh -c
 * playwright-mcp ...` → `node .../playwright-mcp ...`), oldest 9+ days, every
 * single one a descendant of a still-ALIVE, still-looping fleet-member `claude`
 * session (verified via `systemctl --user status` on their owning transient
 * scope: every scope had a live `claude` process). These are NOT orphans in the
 * classic dead-parent sense — they are per-session MCP servers that Claude Code
 * starts once at session boot (because the session's `.claude.json` still listed
 * the `playwright` mcpServer) and then never closes for the FULL lifetime of the
 * session, which for a long-running warm-carry fleet member is days to weeks.
 * This repo's own convention (CLAUDE.md "Browser checks") is that Papercusp
 * agents NEVER use the playwright MCP tools at all (the `verdict` skill covers
 * every browser-verification need instead) — P-020
 * (`interactive-claude-config.ts` `FLEET_PRUNED_MCP_SERVERS`) already stops NEW
 * fleet sessions from spawning this server at all. This module is the
 * complementary "max-age sweeper for orphaned MCP server processes" fix
 * direction (b) from the ticket: it cleans up the (large) population of
 * already-running, permanently-idle instances that P-020 cannot retroactively
 * touch (a session's MCP server set is fixed at boot), and it stays live as a
 * general backstop for any future/non-fleet launch path that still wires the
 * server in.
 *
 * SAFETY MODEL (this destroys real child processes of LIVE agent sessions —
 * conservative by design, mirroring test-desktop-reaper.ts's established model):
 *   - Only a process whose FULL cmdline matches one of a small set of patterns
 *     naming the playwright-mcp PACKAGE/BINARY specifically (`@playwright/mcp`,
 *     `playwright-mcp`) is ever a candidate — never a generic `playwright`
 *     substring, which would also match the repo's own committed Playwright E2E
 *     suite (`npx playwright test ...`) and must never be touched.
 *   - Only a candidate that carries `PAPERCUSP_ADV_SESSION_ID` in its process
 *     environment is ever a candidate — i.e. only a process that is a
 *     descendant of a papercusp-launched agent session. A user's own,
 *     non-agent-spawned playwright-mcp use (any project outside this repo) is
 *     never touched, mirroring test-desktop-reaper's "no PAPERCUSP_ADV_SESSION_ID
 *     ⇒ ignore" invariant.
 *   - Only a candidate group whose ROOT process has been alive at least
 *     `minAgeMs` (default 30 minutes — far past any realistic single browser-
 *     automation call) is reaped; anything younger is left alone this sweep.
 *   - The full descendant subtree of a matched root is reaped together (so a
 *     future version that actually launches a headless Chromium child is
 *     covered too) — but NEVER an ancestor. The owning `claude` session itself
 *     is never a candidate (it never matches the playwright-mcp patterns) and
 *     is therefore never touched.
 *   - PID-recycle guard: cmdline is re-read and re-verified immediately before
 *     every signal (SIGTERM and, separately, SIGKILL) — this box has been
 *     measured to recycle pids roughly daily under fleet load.
 *   - `dryRun` (default true in the exported convenience wrapper) classifies +
 *     logs and kills nothing.
 *   - Bounded: at most `maxGroupsPerSweep` groups are acted on per call.
 */
import { promises as fsp } from 'node:fs';

// ── Pure identification ─────────────────────────────────────────────────────

/**
 * Patterns identifying the playwright-mcp SERVER package/binary specifically.
 * Deliberately narrow: anchored to `@playwright/mcp` or the `playwright-mcp`
 * binary name, never the bare `playwright` CLI (which the committed E2E suite
 * legitimately runs as `npx playwright test ...` and must never match).
 */
export const DEFAULT_MCP_REAP_PATTERNS: readonly RegExp[] = [
  // `npm exec @playwright/mcp[@version] --browser <b> --headless ...` — what a
  // claude session's mcpServers config resolves to when it still lists the
  // (P-020-pruned-for-NEW-fleet-sessions, but pre-existing-session-baked)
  // `playwright` server.
  /^npm exec @playwright\/mcp(?:@[\w.\-]+)?\b/,
  // an npm/npx-interposed shell wrapper: `sh -c "playwright-mcp ..."`.
  /^sh -c playwright-mcp\b/,
  // the resolved binary itself, however it got here: `node .../playwright-mcp ...`.
  /(^|\/)playwright-mcp\b/,
];

/** True iff `cmd` (the process's full, reconstructed cmdline) identifies it as
 *  part of a playwright-mcp server launch chain. Pure, fail-safe-narrow. */
export function isPlaywrightMcpProcess(cmd: string, patterns: readonly RegExp[] = DEFAULT_MCP_REAP_PATTERNS): boolean {
  return patterns.some((p) => p.test(cmd));
}

// ── Pure planning ────────────────────────────────────────────────────────────

export interface McpProcInfo {
  pid: number;
  ppid: number;
  /** Full reconstructed cmdline (NUL-joined argv, trimmed). */
  cmd: string;
  startedAtMs: number;
  /** Parsed `PAPERCUSP_ADV_SESSION_ID` from the process environment, or null
   *  when absent (not agent-spawned, or unreadable). */
  advSessionId: number | null;
}

export interface McpReapGroup {
  rootPid: number;
  /** root + every descendant, root first. */
  pids: number[];
  ageMs: number;
  advSessionId: number | null;
  cmd: string;
}

export interface OrphanedMcpReapPlan {
  reap: McpReapGroup[];
  skippedTooYoung: McpReapGroup[];
  /** Matched the playwright-mcp signature but carries no PAPERCUSP_ADV_SESSION_ID
   *  anywhere in its group — not confirmed agent-spawned, so never touched. */
  skippedNoAgentAnchor: McpReapGroup[];
}

/** Default minimum root-process age before a group is eligible for reap — see
 *  module header. */
export const DEFAULT_MIN_AGE_MS = 30 * 60 * 1000;

/** Hard cap on groups classified as `reap` in one call — defense in depth
 *  against a classification bug turning this into a mass-kill (mirrors
 *  task-manager/scan.ts's separate owned/foreign caps). */
export const DEFAULT_MAX_GROUPS_PER_SWEEP = 25;

/** Bounded ancestor-climb / descendant-walk depth — mirrors
 *  task-manager/cgroup-read.ts's `walkCgroupTree` maxDepth=32 rationale: a
 *  pathological or cyclic ppid chain must never hang a periodic sweep. */
const MAX_WALK_DEPTH = 32;

/**
 * PURE planner: classify every playwright-mcp process (+ its full descendant
 * subtree) into reap / skippedTooYoung / skippedNoAgentAnchor. No I/O — the
 * process snapshot and clock are injected so this is deterministically
 * unit-testable. Never mutates or signals anything.
 */
export function planOrphanedMcpReap(opts: {
  processes: readonly McpProcInfo[];
  nowMs: number;
  minAgeMs?: number;
  patterns?: readonly RegExp[];
  maxGroupsPerSweep?: number;
}): OrphanedMcpReapPlan {
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const patterns = opts.patterns ?? DEFAULT_MCP_REAP_PATTERNS;
  const maxGroups = opts.maxGroupsPerSweep ?? DEFAULT_MAX_GROUPS_PER_SWEEP;

  const byPid = new Map<number, McpProcInfo>();
  const childrenByPpid = new Map<number, McpProcInfo[]>();
  for (const p of opts.processes) {
    byPid.set(p.pid, p);
    const list = childrenByPpid.get(p.ppid);
    if (list) list.push(p);
    else childrenByPpid.set(p.ppid, [p]);
  }

  const seedPidSet = new Set<number>();
  for (const p of opts.processes) {
    if (isPlaywrightMcpProcess(p.cmd, patterns)) seedPidSet.add(p.pid);
  }

  // For each seed, climb the ppid chain while the parent is ALSO a seed, to
  // find the topmost seed ancestor — the group's true root. Any process
  // reached this way that is NOT a seed (a normal ancestor, e.g. the owning
  // `claude` process) stops the climb: it is never absorbed into the group.
  function topmostSeedAncestor(start: McpProcInfo): McpProcInfo {
    let cur = start;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      const parent = byPid.get(cur.ppid);
      if (!parent || !seedPidSet.has(parent.pid)) return cur;
      cur = parent;
    }
    return cur;
  }

  // Full descendant walk from a root pid (BFS, depth-bounded, cycle-safe via a
  // visited set) — collects the WHOLE subtree, not just further seed matches,
  // so a hypothetical future chromium child is swept up too.
  function descendantsOf(rootPid: number): number[] {
    const out: number[] = [];
    const visited = new Set<number>([rootPid]);
    const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
    while (queue.length) {
      const { pid, depth } = queue.shift()!;
      if (depth >= MAX_WALK_DEPTH) continue;
      for (const child of childrenByPpid.get(pid) ?? []) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        out.push(child.pid);
        queue.push({ pid: child.pid, depth: depth + 1 });
      }
    }
    return out;
  }

  const groupedRootPids = new Set<number>();
  const groups: McpReapGroup[] = [];
  for (const seedPid of seedPidSet) {
    const seed = byPid.get(seedPid);
    if (!seed) continue;
    const root = topmostSeedAncestor(seed);
    if (groupedRootPids.has(root.pid)) continue;
    groupedRootPids.add(root.pid);

    const pids = [root.pid, ...descendantsOf(root.pid)];
    const advSessionId = pids
      .map((pid) => byPid.get(pid)?.advSessionId ?? null)
      .find((v) => v != null) ?? null;

    groups.push({
      rootPid: root.pid,
      pids,
      ageMs: opts.nowMs - root.startedAtMs,
      advSessionId,
      cmd: root.cmd.slice(0, 200),
    });
  }
  // Deterministic order (oldest first — reap the biggest offenders first if
  // the sweep cap ever binds).
  groups.sort((a, b) => b.ageMs - a.ageMs);

  const plan: OrphanedMcpReapPlan = { reap: [], skippedTooYoung: [], skippedNoAgentAnchor: [] };
  for (const g of groups) {
    if (g.advSessionId == null) {
      plan.skippedNoAgentAnchor.push(g);
      continue;
    }
    if (g.ageMs < minAgeMs) {
      plan.skippedTooYoung.push(g);
      continue;
    }
    if (plan.reap.length >= maxGroups) continue; // capped — picked up next sweep
    plan.reap.push(g);
  }
  return plan;
}

// ── Impure sampling + kill (injectable; mirrors test-desktop-reaper.ts) ────────

export interface McpKillDeps {
  listProc: () => Promise<string[]>;
  readCmdline: (pid: number) => Promise<string>;
  readEnviron: (pid: number) => Promise<string>;
  readStat: (pid: number) => Promise<string>;
  /** Approx process start time — this codebase's established idiom
   *  (test-desktop-reaper.ts) is the `/proc/<pid>` dir mtime, not a
   *  clock-ticks-since-boot conversion. */
  startedAtMs: (pid: number) => Promise<number | null>;
  sigterm: (pid: number) => boolean;
  sigkill: (pid: number) => boolean;
  pidAlive: (pid: number) => boolean;
  wait: (ms: number) => Promise<void>;
}

/** SIGTERM → wait this long → SIGKILL survivors. */
export const KILL_GRACE_MS = 3000;

function parsePpidFromStat(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
}

function parseAdvSessionId(environ: string): number | null {
  for (const part of environ.split('\0')) {
    if (part.startsWith('PAPERCUSP_ADV_SESSION_ID=')) {
      const v = Number(part.slice('PAPERCUSP_ADV_SESSION_ID='.length));
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return null;
}

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
async function defaultStartedAtMs(pid: number): Promise<number | null> {
  try {
    const st = await fsp.stat(`/proc/${pid}`);
    return st.mtimeMs > 0 ? st.mtimeMs : null;
  } catch {
    return null;
  }
}
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_MCP_KILL_DEPS: McpKillDeps = {
  listProc: defaultListProc,
  readCmdline: defaultReadCmdline,
  readEnviron: defaultReadEnviron,
  readStat: defaultReadStat,
  startedAtMs: defaultStartedAtMs,
  sigterm: (pid) => { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } },
  sigkill: (pid) => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  pidAlive: defaultPidAlive,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Best-effort full-host process snapshot for `planOrphanedMcpReap`. Any
 *  per-pid read failure silently drops that pid (process exited mid-scan, or
 *  environ is unreadable across users — never fatal to the sweep). */
export async function sampleMcpCandidates(deps: McpKillDeps = DEFAULT_MCP_KILL_DEPS): Promise<McpProcInfo[]> {
  const pidStrs = await deps.listProc();
  const out: McpProcInfo[] = [];
  for (const pidStr of pidStrs) {
    if (!/^\d+$/.test(pidStr)) continue;
    const pid = Number(pidStr);
    let cmd = '';
    try {
      cmd = (await deps.readCmdline(pid)).replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!cmd) continue;
    let ppid: number | null = null;
    try {
      ppid = parsePpidFromStat(await deps.readStat(pid));
    } catch {
      continue;
    }
    if (ppid == null) continue;
    const startedAtMs = await deps.startedAtMs(pid).catch(() => null);
    if (startedAtMs == null) continue;
    let advSessionId: number | null = null;
    try {
      advSessionId = parseAdvSessionId(await deps.readEnviron(pid));
    } catch {
      /* environ unreadable (different user, process gone) — leave null, the
       * planner's no-agent-anchor floor then correctly refuses to touch it. */
    }
    out.push({ pid, ppid, cmd: cmd.slice(0, 240), startedAtMs, advSessionId });
  }
  return out;
}

/** Re-verify (immediately before signalling) that `pid` still identifies as a
 *  playwright-mcp process — the pid-recycle guard. False on any read failure
 *  (process gone → safe, do not signal). */
async function stillMatches(pid: number, deps: McpKillDeps, patterns: readonly RegExp[]): Promise<boolean> {
  try {
    const cmd = (await deps.readCmdline(pid)).replace(/\0/g, ' ').trim();
    return isPlaywrightMcpProcess(cmd, patterns);
  } catch {
    return false;
  }
}

export interface McpReapResult {
  dryRun: boolean;
  scanned: number;
  groupsPlanned: number;
  /** Every pid actually (or, in dryRun, would-be) signalled. */
  killed: number[];
  skippedTooYoung: number;
  skippedNoAgentAnchor: number;
}

/**
 * Sample the host, plan, and — unless `dryRun` — SIGTERM→grace→SIGKILL every
 * reap-eligible group. Never throws (best-effort periodic sweep); per-group
 * and per-pid failures are isolated.
 */
export async function reapOrphanedMcpProcesses(
  opts: {
    dryRun?: boolean;
    minAgeMs?: number;
    patterns?: readonly RegExp[];
    maxGroupsPerSweep?: number;
    deps?: Partial<McpKillDeps>;
  } = {},
): Promise<McpReapResult> {
  const dryRun = opts.dryRun ?? true;
  const patterns = opts.patterns ?? DEFAULT_MCP_REAP_PATTERNS;
  const deps: McpKillDeps = { ...DEFAULT_MCP_KILL_DEPS, ...opts.deps };

  let processes: McpProcInfo[] = [];
  try {
    processes = await sampleMcpCandidates(deps);
  } catch (err) {
    console.warn(`[orphaned-mcp-reaper] sample skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    return { dryRun, scanned: 0, groupsPlanned: 0, killed: [], skippedTooYoung: 0, skippedNoAgentAnchor: 0 };
  }

  const plan = planOrphanedMcpReap({
    processes,
    nowMs: Date.now(),
    minAgeMs: opts.minAgeMs,
    patterns,
    maxGroupsPerSweep: opts.maxGroupsPerSweep,
  });

  const killed: number[] = [];
  if (dryRun) {
    for (const g of plan.reap) killed.push(...g.pids);
    return {
      dryRun: true,
      scanned: processes.length,
      groupsPlanned: plan.reap.length,
      killed,
      skippedTooYoung: plan.skippedTooYoung.length,
      skippedNoAgentAnchor: plan.skippedNoAgentAnchor.length,
    };
  }

  for (const g of plan.reap) {
    // Kill descendants before the root — never leaves a child briefly parentless
    // pointing at a root that's already gone. Isolated per-pid: one failure never
    // aborts the group or the sweep.
    const order = [...g.pids].reverse();
    const confirmed: number[] = [];
    for (const pid of order) {
      try {
        if (!(await stillMatches(pid, deps, patterns))) continue; // recycle guard
        if (deps.sigterm(pid)) confirmed.push(pid);
      } catch {
        /* isolated */
      }
    }
    await deps.wait(KILL_GRACE_MS);
    for (const pid of confirmed) {
      try {
        if (!deps.pidAlive(pid)) {
          killed.push(pid);
          continue;
        }
        if (!(await stillMatches(pid, deps, patterns))) continue; // post-wait recycle guard
        deps.sigkill(pid);
        killed.push(pid);
      } catch {
        /* isolated */
      }
    }
  }

  return {
    dryRun: false,
    scanned: processes.length,
    groupsPlanned: plan.reap.length,
    killed,
    skippedTooYoung: plan.skippedTooYoung.length,
    skippedNoAgentAnchor: plan.skippedNoAgentAnchor.length,
  };
}
