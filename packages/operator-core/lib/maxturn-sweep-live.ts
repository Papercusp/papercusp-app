/**
 * maxturn-sweep-live — P-024's LIVE cell driver + the pure transcript→metrics
 * extractor (deterministic-context-carry-2026-07-14, WI-5002).
 *
 * Split exactly like residual-carry-pass-live / cold-boot-drill-live: the PURE
 * halves (metrics extraction from a successor transcript, the benchmark kickoff
 * builder) live and unit-test here; the LIVE seams (spawn a real headless psu
 * session, bind/clear the per-session doors override, read the owner transcript)
 * are injectable with real defaults, and NOTHING runs unless runMaxTurnSweep is
 * explicitly `armed` with this driver (D-001 — a sweep that binds overrides on
 * live sessions and spends is opt-in, never a default).
 *
 * HOW A CELL RUNS (makeHeadlessPsuCellDriver):
 *   1. mint a fresh ownerId for the cell repeat (`su-sweep-…`) — pre-pinned onto
 *      the session via `psu --owner-id=…` (WI-5002/EI-13277: the launch envelope
 *      overrides the exported PAPERCUSP_SID, so the flag — honored by
 *      bootstrap-su — is the only binding that makes the session RUN AS the
 *      owner the driver keyed its state to), so step 2 binds BEFORE the first
 *      API call;
 *   2. bind the cell's DoorConstantsPatch as that owner's SESSION override
 *      (writeSessionDoorsOverride — the exact store config:doors-set-session
 *      writes, so the live door sites enforce the cell's constants);
 *   3. spawn a HEADLESS psu Claude session with the benchmark kickoff
 *      (psu-launcher --headless --yes --owner-id=… --kickoff=…), bounded by
 *      taskTimeoutMs;
 *   4. poll the owner's native transcript WHILE the child runs (a headless
 *      session's transcript store can be cleaned at host end — EI-13277 — so
 *      the post-exit read is only a fallback), terminate early once an
 *      assistant turn prints the done marker, and extract CellRunMetrics —
 *      stop_reason=max_tokens rate, spill-chase, hops, cache-read vs fresh input,
 *      compact_boundary count, wall clock, done-marker success;
 *   5. ALWAYS clear the override (finally) — a sweep must never leave a stray
 *      session override behind.
 *
 * The metrics come ENTIRELY from the transcript (verified live 2026-07-16 on a
 * real session: assistant lines carry message.usage + stop_reason; compactions
 * land as type:'system' subtype:'compact_boundary'; result-door spills name their
 * scratch path inline) — no second telemetry join needed for v1.
 *
 * ✅ CANARY UNBLOCKED (WI-5075, resolved + live-verified 2026-07-16): the
 * carry-respawn kill-loop that used to re-kill any session the compaction
 * watchdog estimated over-limit (a small-maxTurn sweep cell compacts often and
 * was exactly in the blast radius) is fixed — adv_sessions now re-anchors on
 * respawn, journalctl showed zero re-fires across 4+ post-fix sweeps. The live
 * canary is safe to run. What is STILL missing as of WI-5003 (P-025): no CLI/
 * script entry point invokes runMaxTurnSweep+makeHeadlessPsuCellDriver — every
 * call site today is this file's own tests (mocked seams). Running an actual
 * canary or the full matrix needs (a) a small runner script and (b) an explicit
 * decision to spend real headless-session time/tokens on the live campaign —
 * see WI-5003's follow-up for the concrete next step.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  emptyCellMetrics,
  type BenchmarkTask,
  type CellConfig,
  type CellDriver,
  type CellRunMetrics,
  type SweepCell,
} from './maxturn-sweep';
import { writeSessionDoorsOverride, type DoorConstantsPatch } from './context-doors-config';
import { newestTranscriptUnderOwner } from './claude-sessions';

/** The terminal marker the benchmark kickoff instructs the session to print as its
 *  FINAL line when the task is fully complete — the task-success signal the
 *  extractor looks for in ASSISTANT output (never user/kickoff lines). */
export const SWEEP_TASK_DONE_MARKER = '⟦maxturn-sweep:task-done⟧';

/** account-routing-3-options (the same lever cup:spawn / fleet launch expose):
 *  how a spawned cell session's model calls are routed.
 *    - `'auto'`     → through the inference gateway, auto-selecting an available
 *                     pool account WITH failover (the standing fleet behavior).
 *    - `<pool-id>`  → hard-pin to that pool account via the gateway (no failover).
 *    - `'default'`  → SKIP the gateway, use the system CLI-login credential.
 *  The union is documentary — psu-launcher validates the concrete value. */
export type SweepAccountRouting = 'auto' | 'default' | (string & {});

/** The sweep DEFAULTS to gateway auto-routing. Omitting `--account` sends every
 *  cell in `'default'` mode — through the ONE shared CLI credential with no
 *  failover — which starves under a multi-hundred-cell campaign: tail cells
 *  spawn but land zero API turns, yielding all-null-but-`'ok'` rows while the
 *  7-account gateway pool sits idle (root-caused 2026-07-17, WI-5003; the fleet
 *  runs on `--account=auto` for exactly this reason). Owner directive
 *  [owner 2026-07-17 "pin them to the gateway"]. */
export const DEFAULT_SWEEP_ACCOUNT_ROUTING: SweepAccountRouting = 'auto';

/** Per-repeat wall-clock cap. A cell that cannot finish its benchmark inside this
 *  is captured with whatever transcript it produced (metrics still extract).
 *  15min (was 10): every benchmark task must be COMPLETABLE well inside the cap or
 *  taskSuccessRate measures the timeout, not the config — the 2026-07-17 campaign's
 *  file-writes cells (then 8 docs ≈ 23min of writing) ALL timed out at 0/…-done,
 *  capping mean task success at ~0.67 and making the 0.95 gate unsatisfiable
 *  (WI-5003). Sized so the largest task (3×~400-line docs ≈ 9min observed) keeps
 *  ~40% headroom; completed cells early-terminate on the done marker, so a bigger
 *  cap never slows a good cell. */
export const DEFAULT_SWEEP_TASK_TIMEOUT_MS = 15 * 60_000;

/** Where benchmark sessions do their file work — NEVER the shared repo tree. */
export function sweepWorkDir(cellId: string, base: string = join(homedir(), '.papercusp', 'sweep-bench')): string {
  return join(base, cellId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure half 1 — transcript JSONL → CellRunMetrics
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic reports an output-door stop as stop_reason 'max_tokens'; OpenAI-style
 *  ports use 'length'. Both count as a length-stop. */
const LENGTH_STOP_REASONS = new Set(['max_tokens', 'length']);

/** Matches a result-door spill pointer and captures its scratch path. Kept loose:
 *  the pointer text has evolved; the PATH is the stable join key. */
const SPILL_POINTER_RE = /result-door[^]*?((?:\/[\w.-]+)+\.md)/;

interface AssistantAgg {
  usage: { input: number; cacheRead: number; output: number };
  stopReason: string | null;
  sawDoneMarker: boolean;
}

/** A large on-disk artifact the benchmark expects the session to page through
 *  with the Read tool — the spill-chase subject for raw-file workloads, where
 *  nothing ever flows through an MCP result-door (WI-5003: spillChase was null
 *  on EVERY 2026-07-17 campaign cell, making the 0.95 gate unsatisfiable). */
export interface SpillFixture {
  /** Absolute path Read tool_use inputs are matched against (exact match). */
  path: string;
  /** Total line count — the denominator of the coverage fraction. */
  lines: number;
}

/** Claude Code's Read returns up to this many lines when no `limit` is passed —
 *  the implicit window of an offset-less/limit-less Read tool_use. */
const READ_DEFAULT_LIMIT_LINES = 2_000;

/**
 * Extract per-cell metrics from a session's native transcript JSONL. PURE.
 * One API call = one hop: assistant lines are deduped by message.id with
 * max-merged usage (a message streams as multiple lines repeating its usage)
 * and last-non-null stop_reason. All-null metrics come back for an empty/
 * unparseable transcript (never fabricated zeros).
 *
 * Spill-chase has two sources, in precedence order:
 *  1. result-door pointers (MCP tool results spilled to scratch): fraction of
 *     distinct spilled paths the session mentioned again (paged back).
 *  2. `opts.spillFixture` (raw-file workloads): the fixture IS the spill — it
 *     cannot fit one Read — so success = fraction of its lines covered by the
 *     union of the session's Read tool_use windows on that path.
 * Neither present/measured ⇒ null (the scorer treats null as not-exercised).
 */
export function extractCellMetricsFromJsonl(
  jsonl: string,
  opts: { taskDoneMarker?: string; spillFixture?: SpillFixture } = {},
): CellRunMetrics {
  const marker = opts.taskDoneMarker ?? SWEEP_TASK_DONE_MARKER;
  const byMsg = new Map<string, AssistantAgg>();
  let anonSeq = 0;
  let compactionCount = 0;
  let firstTsMs: number | null = null;
  let lastTsMs: number | null = null;
  // Spill-chase: path → number of DISTINCT lines mentioning it. The pointer line
  // itself is the first; any later mention (the agent paging it back) is a chase.
  const spillLineCounts = new Map<string, number>();
  // Raw-file spill-chase: [start, end) line windows of Read tool_use calls on the
  // fixture path (1-based, end exclusive) — union coverage is the chase fraction.
  const fixtureReadWindows: Array<[number, number]> = [];

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // torn line — contributes nothing
    }
    const evt = j as {
      type?: string;
      subtype?: string;
      timestamp?: string;
      message?: { id?: string; model?: string; stop_reason?: string | null; usage?: Record<string, number>; content?: unknown };
    };

    const tsMs = evt.timestamp ? Date.parse(evt.timestamp) : NaN;
    if (Number.isFinite(tsMs)) {
      if (firstTsMs == null || tsMs < firstTsMs) firstTsMs = tsMs;
      if (lastTsMs == null || tsMs > lastTsMs) lastTsMs = tsMs;
    }

    if (evt.type === 'system' && evt.subtype === 'compact_boundary') compactionCount += 1;

    const spill = SPILL_POINTER_RE.exec(line);
    if (spill?.[1]) spillLineCounts.set(spill[1], (spillLineCounts.get(spill[1]) ?? 0) + 1);
    else {
      // A later read of a known spill path (a Read tool call names the path
      // without the 'result-door' text) — count it against every known path it
      // mentions. Bounded: only paths already seen as pointers.
      for (const path of spillLineCounts.keys()) {
        if (line.includes(path)) spillLineCounts.set(path, (spillLineCounts.get(path) ?? 0) + 1);
      }
    }

    if (evt.type !== 'assistant') continue;
    const model = evt.message?.model;
    if (!model || model.startsWith('<')) continue; // synthetic placeholder, not an API call
    // Fixture Read windows (spill source 2): tool_use blocks reading the fixture.
    if (opts.spillFixture && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content as Array<{ type?: string; name?: string; input?: { file_path?: string; offset?: number; limit?: number } }>) {
        if (block?.type !== 'tool_use' || block.name !== 'Read') continue;
        if (block.input?.file_path !== opts.spillFixture.path) continue;
        const start = Math.max(1, block.input.offset ?? 1);
        const len = Math.max(0, block.input.limit ?? READ_DEFAULT_LIMIT_LINES);
        if (len > 0) fixtureReadWindows.push([start, start + len]);
      }
    }
    const key = evt.message?.id ?? `anon-${anonSeq++}`;
    const agg =
      byMsg.get(key) ?? ({ usage: { input: 0, cacheRead: 0, output: 0 }, stopReason: null, sawDoneMarker: false } satisfies AssistantAgg);
    const u = evt.message?.usage ?? {};
    agg.usage.input = Math.max(agg.usage.input, u.input_tokens ?? 0);
    agg.usage.cacheRead = Math.max(agg.usage.cacheRead, u.cache_read_input_tokens ?? 0);
    agg.usage.output = Math.max(agg.usage.output, u.output_tokens ?? 0);
    if (evt.message?.stop_reason != null) agg.stopReason = evt.message.stop_reason;
    // Task-success marker: assistant CONTENT only (the kickoff/user turn quotes the
    // marker by instruction — scanning it would always false-positive).
    if (JSON.stringify(evt.message?.content ?? '').includes(marker)) agg.sawDoneMarker = true;
    byMsg.set(key, agg);
  }

  const hops = byMsg.size;
  if (hops === 0) return emptyCellMetrics();

  let lengthStops = 0;
  let cacheRead = 0;
  let freshInput = 0;
  let done = false;
  for (const agg of byMsg.values()) {
    if (agg.stopReason && LENGTH_STOP_REASONS.has(agg.stopReason)) lengthStops += 1;
    cacheRead += agg.usage.cacheRead;
    freshInput += agg.usage.input;
    if (agg.sawDoneMarker) done = true;
  }

  const spills = spillLineCounts.size;
  const chased = [...spillLineCounts.values()].filter((n) => n >= 2).length;
  // Source 2: union line-coverage of the fixture by Read windows (0..1). Only
  // when the caller declared a fixture; 0 (never read it) is a REAL failing
  // score, distinct from null (not exercised).
  let fixtureCoverage: number | null = null;
  if (opts.spillFixture) {
    const total = Math.max(1, opts.spillFixture.lines);
    const sorted = [...fixtureReadWindows].sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let cursor = 1; // 1-based lines; count coverage within [1, total]
    for (const [s, e] of sorted) {
      const start = Math.max(s, cursor);
      const end = Math.min(e, total + 1);
      if (end > start) {
        covered += end - start;
        cursor = end;
      }
    }
    fixtureCoverage = Math.min(1, covered / total);
  }

  return {
    stopReasonLengthRate: lengthStops / hops,
    spillChaseSuccessRate: spills > 0 ? chased / spills : fixtureCoverage,
    hopsPerTask: hops,
    cacheReadInputTokens: cacheRead,
    freshInputTokens: freshInput,
    compactionCount,
    wallClockMs: firstTsMs != null && lastTsMs != null && lastTsMs > firstTsMs ? lastTsMs - firstTsMs : null,
    taskSuccessRate: done ? 1 : 0,
  };
}

/**
 * Whether an ASSISTANT turn in this transcript printed the task-done marker.
 * PURE. The kickoff/user turn quotes the marker by instruction, so a raw
 * `includes` over the whole JSONL is always true once the kickoff persists —
 * only assistant content counts (same discipline as the extractor's
 * taskSuccessRate). The driver polls this mid-run to terminate a finished cell
 * early instead of idling out the full timeout (canary run 2 burned 7 of its
 * 10 minutes on a task that finished in 3).
 */
export function transcriptSawAssistantDoneMarker(
  jsonl: string,
  marker: string = SWEEP_TASK_DONE_MARKER,
): boolean {
  for (const line of jsonl.split('\n')) {
    if (!line.includes(marker)) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const evt = j as { type?: string; message?: { model?: string; content?: unknown } };
    if (evt.type !== 'assistant') continue;
    const model = evt.message?.model;
    if (!model || model.startsWith('<')) continue; // synthetic placeholder, not an API call
    if (JSON.stringify(evt.message?.content ?? '').includes(marker)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure half 2 — the benchmark kickoff per task kind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The concrete workload text a cell's session is kicked off with. Deliberately
 * FILESYSTEM-ONLY in a per-cell scratch dir — a benchmark session must never
 * touch the shared repo tree, the work-item ledger, or coord. Each kind
 * exercises the door the axis targets (many short hops / big output / big tool
 * results), and every kickoff closes with the done-marker discipline the
 * extractor's taskSuccessRate reads.
 */
export function buildBenchmarkKickoff(task: BenchmarkTask, cell: SweepCell, workDir: string): string {
  const header = [
    `⟦maxturn-sweep:cell:${cell.cellId}⟧ You are running a fixed benchmark workload (a config sweep cell).`,
    `Work ONLY inside ${workDir} — never edit any other directory, never create work items, never message anyone.`,
    '',
  ];
  const footer = [
    '',
    `When the task is FULLY complete, print exactly ${SWEEP_TASK_DONE_MARKER} as your final line and stop.`,
  ];
  const body: string[] = [];
  switch (task.kind) {
    case 'drain-style':
      body.push(
        `There are 12 small independent units. For unit N (1..12): create ${workDir}/unit-N.md containing a`,
        'numbered 10-step checklist for a distinct everyday engineering chore (each unit a different chore),',
        'then verify the file exists by reading it back before moving to the next unit. Do the units one at a',
        'time, in order — many short self-contained steps.',
      );
      break;
    case 'file-heavy-writes':
      // 3 docs, not more: the task must be COMPLETABLE well inside
      // DEFAULT_SWEEP_TASK_TIMEOUT_MS or taskSuccessRate measures the timeout,
      // not the config (8 docs ≈ 23min vs a 10min cap zeroed the metric on every
      // 2026-07-17 campaign cell — WI-5003).
      body.push(
        `Author 3 substantial files ${workDir}/doc-1.md, doc-2.md, doc-3.md. Each must be a coherent ~400-line`,
        'technical design document on a distinct invented subsystem (architecture, data model, failure modes,',
        'test plan). Write each file in full — large outputs are the point of this workload.',
      );
      break;
    case 'long-log-analysis':
      // The Read-tool mandate makes spill-chase MEASURABLE: the extractor scores
      // union line-coverage of the fixture from Read tool_use windows (a shell
      // pipeline reads invisibly and would under-credit the chase — WI-5003).
      body.push(
        `Read ${workDir}/fixture.log (a long service log). Produce ${workDir}/analysis.md with: the distinct`,
        'error classes and their counts, the time window of the worst error burst, the three noisiest components,',
        'and a root-cause hypothesis per error class citing line numbers. Page through the WHOLE log using the',
        'Read tool with offset/limit (never shell commands like grep/awk/sed — reading every line via the Read',
        'tool is the point of this workload: its large results are what is being measured).',
      );
      break;
    default:
      body.push(task.summary);
  }
  return [...header, ...body, ...footer].join('\n');
}

/** The long-log fixture's line count — shared by the generator (prepareWorkDir)
 *  and the extractor's spill-fixture coverage denominator, so the two can never
 *  drift. >READ_DEFAULT_LIMIT_LINES by design: the fixture must not fit in one
 *  Read or there is no spill to chase. */
export const SWEEP_LOG_FIXTURE_LINES = 4_000;

/** Generate the long-log fixture the 'long-log-analysis' task reads (~lines lines,
 *  a few recurring error classes with one burst window). Deterministic. */
export function buildLogFixture(lines = SWEEP_LOG_FIXTURE_LINES): string {
  const components = ['sync-gateway', 'pg-pool', 'wake-executor', 'vite-dev', 'embedder'];
  const errors = ['ETIMEDOUT upstream', 'pool exhausted', 'schema drift detected', 'socket hang up'];
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const t = new Date(1_784_200_000_000 + i * 1_000).toISOString();
    const comp = components[i % components.length];
    const burst = i >= lines * 0.6 && i < lines * 0.65;
    const isErr = burst ? i % 2 === 0 : i % 37 === 0;
    out.push(
      isErr
        ? `${t} ERROR [${comp}] ${errors[i % errors.length]} (req=${i})`
        : `${t} INFO  [${comp}] tick ok latency=${(i % 90) + 5}ms`,
    );
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE driver (injectable seams; defaults are the real bindings)
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepSpawnInput {
  ownerId: string;
  kickoff: string;
  workDir: string;
  cellId: string;
  timeoutMs: number;
  /** Harness slug to bootstrap the session under (WI-5003 live-canary finding,
   *  2026-07-17): omitting `--harness` makes psu-launcher skip the su bootstrap
   *  entirely and boot a PLAIN claude session — which never seeds the per-session
   *  CLAUDE_CONFIG_DIR, so the transcript lands under the shared ~/.claude store
   *  instead of ~/.papercusp/session-claude/<ownerId>/… and
   *  newestTranscriptUnderOwner finds nothing even though the session ran the
   *  benchmark task to completion (reproduced live: 12/12 unit files written,
   *  transcript unfindable). See apps/operator/scripts/psu-launcher.mjs's own
   *  "ALWAYS harness-scope a fresh launch" comment (agent-tools/capability/launch-agent.ts). */
  harness: string;
  /** account-routing-3-options: how THIS cell's model calls are routed — see
   *  {@link SweepAccountRouting}. The driver defaults it to
   *  {@link DEFAULT_SWEEP_ACCOUNT_ROUTING} ('auto' = gateway) so a campaign
   *  spreads across the pool with failover instead of starving one credential. */
  account: SweepAccountRouting;
}

/** Pure: the psu-launcher.mjs argv for one sweep cell repeat. Split out so the
 *  WI-5003 `--harness` fix (and any future flag) is unit-testable without a
 *  real spawn. */
export function buildSweepSpawnArgs(input: SweepSpawnInput, repoRoot: string): string[] {
  return [
    join(repoRoot, 'apps/operator/scripts/psu-launcher.mjs'),
    // --agent is REQUIRED by psu-launcher (it exits immediately with a usage error
    // otherwise) — caught by the WI-5002 live canary: the cell died in 262ms with
    // "no transcript" because this arg was missing and stdio:'ignore' hid the message.
    '--agent=claude',
    '--headless',
    '--yes',
    // WI-5003: without --harness, psu boots a PLAIN claude (skips su bootstrap
    // entirely) and never seeds the per-session CLAUDE_CONFIG_DIR the transcript
    // lookup below depends on — see the field doc on SweepSpawnInput.harness.
    `--harness=${input.harness}`,
    // Pre-pin the session's coord owner (WI-5002/EI-13277): the launch envelope
    // overrides the inherited PAPERCUSP_SID, so canary run 2 executed as a
    // server-minted owner — its doors override never applied and its transcript
    // was unfindable. The flag makes bootstrap-su use OUR owner id.
    `--owner-id=${input.ownerId}`,
    // account-routing-3-options (owner 2026-07-17 "pin them to the gateway"): route
    // every cell through the inference gateway ('auto' default) instead of psu's
    // no-flag 'default' mode (single CLI credential, no failover — starved the
    // 2026-07-17 campaign's tail cells to all-null-but-ok, WI-5003). Emitted
    // ALWAYS/explicitly so the routing is never an implicit fall-through.
    `--account=${input.account}`,
    `--kickoff=${input.kickoff}`,
  ];
}

/** A running cell session: `done` settles when the child exits (or times out);
 *  `terminate` requests an early stop (the WI-5002 canary showed a settled
 *  headless child idles under the pty host until the full timeout — the driver
 *  terminates as soon as the transcript shows the done marker instead). */
export interface SweepSessionHandle {
  done: Promise<void>;
  terminate: () => void;
}

export interface HeadlessCellDriverDeps {
  /** Mint the repeat's fresh ownerId (default `su-sweep-<cell>-<nonce>`). */
  mintOwnerId?: (cell: SweepCell, repeat: number) => string;
  /** Bind the cell patch as the owner's session doors override (default: the real
   *  writeSessionDoorsOverride — the exact store the door sites resolve). */
  bindOverride?: (ownerId: string, patch: DoorConstantsPatch, cellId: string) => Promise<void>;
  /** ALWAYS called (finally) — drop the owner's override. */
  clearOverride?: (ownerId: string) => Promise<void>;
  /** Prepare the cell's scratch dir (default: mkdir -p + the long-log fixture for
   *  the long-log-analysis kind). */
  prepareWorkDir?: (workDir: string, cell: SweepCell) => Promise<void>;
  /** Start the session, returning its handle. Default:
   *  `node apps/operator/scripts/psu-launcher.mjs --agent=claude --headless --yes
   *  --owner-id=<ownerId> --kickoff=…`, SIGTERM'd at timeoutMs. `--owner-id`
   *  (WI-5002/EI-13277) is what actually binds the session to the minted owner —
   *  the exported PAPERCUSP_SID env is overridden by the launch envelope, so
   *  without the flag the doors override AND the transcript read key to an owner
   *  the session never runs as. */
  spawnSession?: (input: SweepSpawnInput) => SweepSessionHandle;
  /** Read the owner's native transcript JSONL (default: newestTranscriptUnderOwner + read). */
  readTranscript?: (ownerId: string) => Promise<string | null>;
  /** Per-repeat wall-clock cap (default DEFAULT_SWEEP_TASK_TIMEOUT_MS). */
  taskTimeoutMs?: number;
  /** Mid-run transcript poll cadence (default 5s). The poll serves two ends: it
   *  snapshots the transcript WHILE THE CHILD LIVES (EI-13277 — a headless
   *  session's transcript can be cleaned at host end, so a post-exit read may
   *  find nothing), and it spots the done marker to terminate early. */
  pollIntervalMs?: number;
  /** Repo root for the default spawner (default: process.cwd()). */
  repoRoot?: string;
  /** Harness slug to bootstrap each cell session under (default 'papercusp' —
   *  see SweepSpawnInput.harness for why this must never be omitted). */
  harness?: string;
  /** account-routing-3-options for every cell session (default
   *  {@link DEFAULT_SWEEP_ACCOUNT_ROUTING} = 'auto', i.e. the inference gateway
   *  with failover). Set to a pool-id to pin, or 'default' to skip the gateway. */
  account?: SweepAccountRouting;
}

function defaultMintOwnerId(cell: SweepCell, repeat: number): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return `su-sweep-${cell.cellId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}-r${repeat}-${nonce}`;
}

async function defaultBindOverride(ownerId: string, patch: DoorConstantsPatch, cellId: string): Promise<void> {
  await writeSessionDoorsOverride(ownerId, {
    overrides: patch,
    setBy: 'maxturn-sweep-live',
    provenance: `P-024 sweep cell ${cellId}`,
  });
}

async function defaultClearOverride(ownerId: string): Promise<void> {
  await writeSessionDoorsOverride(ownerId, null);
}

async function defaultPrepareWorkDir(workDir: string, cell: SweepCell): Promise<void> {
  await fs.mkdir(workDir, { recursive: true });
  if (cell.taskKind === 'long-log-analysis') {
    await fs.writeFile(join(workDir, 'fixture.log'), buildLogFixture(), 'utf8');
  }
}

/** The real headless spawn. `done` settles on exit; the child is SIGTERM'd at
 *  timeoutMs or on terminate() (the transcript written so far still extracts).
 *  Never rejects on a non-zero exit — the transcript is the verdict, not the
 *  exit code. */
function defaultSpawnSession(input: SweepSpawnInput, repoRoot: string): SweepSessionHandle {
  const child = nodeSpawn(
    'node',
    buildSweepSpawnArgs(input, repoRoot),
    {
      cwd: input.workDir,
      env: { ...process.env, PAPERCUSP_SID: input.ownerId },
      stdio: 'ignore',
      detached: false,
    },
  );
  const terminate = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(terminate, input.timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return { done, terminate };
}

async function defaultReadTranscript(ownerId: string): Promise<string | null> {
  const path = newestTranscriptUnderOwner(ownerId);
  if (!path) return null;
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function meanOrNull(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length > 0 ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}

/** Aggregate per-repeat extracts into the cell's CellRunMetrics (mean per metric,
 *  nulls excluded per-metric — one failed repeat never nulls the cell). */
export function aggregateRepeatMetrics(repeats: CellRunMetrics[]): CellRunMetrics {
  if (repeats.length === 0) return emptyCellMetrics();
  return {
    stopReasonLengthRate: meanOrNull(repeats.map((r) => r.stopReasonLengthRate)),
    spillChaseSuccessRate: meanOrNull(repeats.map((r) => r.spillChaseSuccessRate)),
    hopsPerTask: meanOrNull(repeats.map((r) => r.hopsPerTask)),
    cacheReadInputTokens: meanOrNull(repeats.map((r) => r.cacheReadInputTokens)),
    freshInputTokens: meanOrNull(repeats.map((r) => r.freshInputTokens)),
    compactionCount: meanOrNull(repeats.map((r) => r.compactionCount)),
    wallClockMs: meanOrNull(repeats.map((r) => r.wallClockMs)),
    taskSuccessRate: meanOrNull(repeats.map((r) => r.taskSuccessRate)),
  };
}

/**
 * Build the P-024 CellDriver over headless psu sessions. Every seam injectable;
 * the returned driver binds→spawns→extracts→clears per repeat and aggregates.
 * A repeat whose transcript is unreadable throws (runMaxTurnSweep captures it as
 * that cell's status:'error' and moves on — its fail-soft contract).
 */
export function makeHeadlessPsuCellDriver(deps: HeadlessCellDriverDeps = {}): CellDriver {
  const mint = deps.mintOwnerId ?? defaultMintOwnerId;
  const bind = deps.bindOverride ?? defaultBindOverride;
  const clear = deps.clearOverride ?? defaultClearOverride;
  const prepare = deps.prepareWorkDir ?? defaultPrepareWorkDir;
  const readTranscript = deps.readTranscript ?? defaultReadTranscript;
  const timeoutMs = deps.taskTimeoutMs ?? DEFAULT_SWEEP_TASK_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const repoRoot = deps.repoRoot ?? process.cwd();
  const harness = deps.harness ?? 'papercusp';
  const account = deps.account ?? DEFAULT_SWEEP_ACCOUNT_ROUTING;
  const spawnSession = deps.spawnSession ?? ((input: SweepSpawnInput) => defaultSpawnSession(input, repoRoot));

  return async (cell: SweepCell, config: CellConfig, opts: { repeats: number }) => {
    const task: BenchmarkTask = { id: cell.taskId, kind: cell.taskKind, summary: '' };
    const perRepeat: CellRunMetrics[] = [];
    for (let repeat = 1; repeat <= Math.max(1, opts.repeats); repeat += 1) {
      const ownerId = mint(cell, repeat);
      const workDir = sweepWorkDir(`${cell.cellId}-r${repeat}`);
      await bind(ownerId, config.patch, cell.cellId);
      try {
        await prepare(workDir, cell);
        const kickoff = buildBenchmarkKickoff(task, cell, workDir);
        const handle = spawnSession({ ownerId, kickoff, workDir, cellId: cell.cellId, timeoutMs, harness, account });

        // Mid-run transcript poll (EI-13277): snapshot the transcript WHILE the
        // child lives — a headless session's store can be cleaned at host end, so
        // the post-exit read is a fallback, not the plan. The same poll terminates
        // a finished cell early: the pty host keeps a settled child alive to the
        // full timeout otherwise.
        let lastJsonl: string | null = null;
        let exited = false;
        void handle.done.then(() => {
          exited = true;
        });
        const poller = (async () => {
          while (!exited) {
            // Race the sleep against exit so a finished child never strands the
            // poller a full interval.
            await Promise.race([handle.done, new Promise((r) => setTimeout(r, pollIntervalMs))]);
            if (exited) break;
            const j = await readTranscript(ownerId).catch(() => null);
            if (j != null) {
              lastJsonl = j;
              if (transcriptSawAssistantDoneMarker(j)) {
                handle.terminate();
                break;
              }
            }
          }
        })();
        await handle.done;
        await poller;

        const finalJsonl = await readTranscript(ownerId).catch(() => null);
        const jsonl = finalJsonl ?? lastJsonl;
        if (jsonl == null) throw new Error(`sweep repeat ${repeat}: no transcript under ${ownerId}`);
        const metrics = extractCellMetricsFromJsonl(
          jsonl,
          cell.taskKind === 'long-log-analysis'
            ? { spillFixture: { path: join(workDir, 'fixture.log'), lines: SWEEP_LOG_FIXTURE_LINES } }
            : {},
        );
        // A zero-hop transcript means the session never completed ONE API call —
        // a routing/capacity/auth failure, not a benchmark result. It must be the
        // cell's ERROR, never an all-null row stamped 'ok': the 2026-07-17
        // campaign silently recorded 10+ such rows (WI-5003) and the dataset
        // read as present-but-empty exactly where load peaked.
        if (metrics.hopsPerTask == null) {
          throw new Error(
            `sweep repeat ${repeat}: zero-hop transcript under ${ownerId} — the session made no API calls (routing/capacity/auth failure)`,
          );
        }
        perRepeat.push(metrics);
      } finally {
        await clear(ownerId).catch(() => {
          /* best-effort — never mask the run error, but never leave silently either */
          console.warn(`[maxturn-sweep-live] failed to clear session doors override for ${ownerId}`);
        });
      }
    }
    return aggregateRepeatMetrics(perRepeat);
  };
}
