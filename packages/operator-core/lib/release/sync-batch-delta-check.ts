/**
 * ⚠ STATUS 2026-08-31 — UNWIRED, PARKED MID-BUILD (owner pause order on P-012).
 *
 *   This file: `packages/operator-core/lib/release/sync-batch-delta-check.ts`.
 *   It is PURE LOGIC ONLY and is imported by NOTHING. There is deliberately no
 *   `system:sync-batch-delta-check` action, no `register-system-actions.ts` import,
 *   no `TARGET_ROLE_SPEND` entry, no `BESPOKE_ACTIVE_SEEDS` entry and no seed
 *   script — so nothing can schedule or fire it. It is tsc-clean and inert.
 *
 *   STILL TO DO for a successor (in this order — steps 2-5 must land in ONE change,
 *   because `routine-classification.registry.test.ts` cross-checks the registry
 *   against `TARGET_ROLE_SPEND` and reds the fleet gate on a half-landed pair):
 *     1. `sync-batch-delta-check-deps.ts` — bind `SyncBatchDeltaDeps` below to:
 *        `git -C <root> rev-parse <branch>` and `git log <cursor>..<branch>
 *        --no-merges --name-only --format=%x00%H %ct%n%(trailers:key=Papercusp-Agent)`
 *        (argv spawn, never a shell string); `node scripts/affected-tests.mjs
 *        --changed-paths <csv> [--print-affected]`; `node scripts/lint-tsc.mjs
 *        --files=<csv>`; `node scripts/test-files.mjs <one file>` for `confirmOne`
 *        (read the `TEST_FILE_RESULT … status=` line — an ABSENT line or `matched=0`
 *        is `null`/undetermined, never `false`); `node scripts/proc-guard.mjs check
 *        green-checkpoint` for `greenCheckpointRunning` (exit 0 = running, 1 = not,
 *        2 = usage error ⇒ null); `/proc/loadavg` + `os.cpus().length` for `hostLoad`;
 *        `createOneWorkItem` from `agent-tools/work_items/_create-core` with
 *        `{ kind:'bug', severity:'major', harness:'papercusp', conditionKey }` for
 *        `fileRed` (assert `conditionUpsert.adopted` on the second filing);
 *        cursor read/write as a scoped `jsonb_set` on
 *        `harness_shared.routines.metadata.sync_delta` (precedent:
 *        `dead-target-sweep.ts`'s `stampHealth`).
 *     2. `../harness/routines/sync-batch-delta-check-action.ts` —
 *        `registerSystemAction('sync-batch-delta-check', …)`, lazy-importing the deps
 *        module (the `frozen-candidate-drift-sweep-action.ts` shape).
 *     3. import it from `../harness/routines/register-system-actions.ts`.
 *     4. classify it in `../automation/routine-classification.ts` as
 *        `'system:sync-batch-delta-check': { spend: 'none', why: … }` (it spawns no
 *        agent and wakes no session), and add `^sync-batch-delta-check$` to
 *        `GIT_RELEASE_FAMILY` there so it files under Git & release rather than Health.
 *     5. add `{ name: 'sync-batch-delta-check', seedScript:
 *        'seed-sync-batch-delta-check-routine.ts' }` to `BESPOKE_ACTIVE_SEEDS`
 *        (`../harness/routines/bespoke-active-seeds-check.ts`) in the SAME change as
 *        the seed script — that registry is what catches "the seed script nobody ran".
 *     6. `seed-sync-batch-delta-check-routine.ts` — a `tier:'durable'` cron row on the
 *        repo's 6-field cron (second-first), every 5 minutes, with
 *        `concurrency:'skip'` and `catchup:'skip-old'`, modelled on
 *        `seed-cargo-test-routine.ts`. Durable, NOT ephemeral: an
 *        ephemeral row seeded by a standalone tsx script is only armed at bg-host
 *        boot, which is exactly how `frozen-candidate-drift-sweep` sat at
 *        `last_fired_at IS NULL` indefinitely.
 *     7. tests: cursor advance, batch path union, red → conditionKey filing,
 *        load-skip — all expressible against `SyncBatchDeltaDeps` with plain fakes
 *        (no `vi.mock`, so the full-replacement-mock-guard cannot be tripped), plus
 *        one test pinning `parseFailingFilesLine` against the REAL emitter
 *        (`renderFailingFilesSummary` in `scripts/lib/vitest-summary.mjs`).
 *
 * ── (design notes below describe the finished shape, not the current wiring) ──
 *
 * The SYNC-BATCH DELTA CHECK — per-commit-batch verification of `staging`
 * (gate-verdict-liveness-and-repair-reliability-2026-08-31, P-012).
 *
 * ── The gap it closes ───────────────────────────────────────────────────────
 * `staging` takes ~800 commits/day from ~70-100 agents and NOTHING verifies any
 * of them. The only instrument is the hourly green-checkpoint, whose full suite
 * takes 55-115 min — so by the time a red is known, 40-226 files are failing and
 * attribution is gone. And attribution cannot be recovered after the fact: git-sync
 * sweeps the WHOLE tree under one identity, so `git blame` and the commit SUBJECT
 * both name the wrong agent (root CLAUDE.md). The only surviving attribution signal
 * is WHICH COMMIT'S CHANGED PATHS the break falls downstream of — and that signal
 * decays as batches pile up.
 *
 * So this samples the stream instead of the endpoint: every ~5 min, take the
 * commits that landed since a durable cursor, run the AFFECTED radius for their
 * union of changed paths, and — on a red — attribute it to the newest batch whose
 * radius can reach the failing file, then file ONE deduped work item naming that
 * batch and a 60-minute fix-or-revert SLA.
 *
 * ── Why the logic lives here and the IO lives in the action ─────────────────
 * Same split as `frozen-candidate-drift-sweep.ts`: every decision in this file is
 * pure and unit-tested; `../harness/routines/sync-batch-delta-check-action.ts`
 * binds it to git, the scripts, the routine cursor and the work-item store. A
 * lambdas-inside-a-closure shape has already cost this repo a load-bearing blind
 * spot (EI-21559794492221235) — a test can only pin the source text of an adapter
 * it cannot execute.
 *
 * ── Bounds, because an UNBOUNDED checker on this box IS the failure ─────────
 * Every leg is capped, and every cap fails toward doing LESS work:
 *   · host load over `cores * LOAD_SKIP_FACTOR`  ⇒ skip, record why, touch nothing;
 *   · green-checkpoint suite running             ⇒ skip (never fight the gate);
 *   · affected radius wider than the caps        ⇒ record `radius-too-wide`, run NOTHING;
 *   · red confirmation                           ⇒ at most MAX_CONFIRM_RUNS single-file runs;
 *   · batch attribution                          ⇒ at most MAX_ATTRIBUTION_PROBES radius probes.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 * No auto-revert, no notifications beyond the work item, no re-cutting or firing of
 * the gate. It is an OBSERVER that files evidence; the repair decision stays human
 * (or with the item's claimant).
 */

// ── tunables (every default fails toward doing less work) ────────────────────

/** Skip the whole run when `loadavg1 > cores * this`. 1.2 = "the box is already
 *  oversubscribed", which on this host means the gate or a fleet burst owns it. */
export const LOAD_SKIP_FACTOR = 1.2;

/** Fix-or-revert SLA quoted in the filed work item, in minutes. Deliberately shorter
 *  than the hourly gate cycle: the whole point is to repair before the next
 *  checkpoint freezes a candidate on top of the break. */
export const SYNC_DELTA_SLA_MINUTES = 60;

/** Radius caps. A batch wider than any of these is recorded and NOT executed —
 *  a 71-workspace run is exactly the "burning the box" outcome this exists to avoid
 *  (the measured cost of an unscoped `test:affected`, EI-20812741760514969). */
export interface RadiusCaps {
  /** Affected WORKSPACES the probe may select before the batch is refused. */
  maxWorkspaces: number;
  /** Changed PATHS the union may carry before the batch is refused. */
  maxPaths: number;
  /** Commits one run may fold into a batch window before it is refused. */
  maxCommits: number;
}

export const DEFAULT_RADIUS_CAPS: RadiusCaps = { maxWorkspaces: 3, maxPaths: 80, maxCommits: 40 };

/** Single-file re-runs spent CONFIRMING a red before anything is filed. Root
 *  CLAUDE.md: a multi-file vitest invocation can abort during collection, so a
 *  batch verdict must not be attributed to every file it named. */
export const MAX_CONFIRM_RUNS = 3;

/** Radius probes spent ATTRIBUTING a red to an introducing batch. Each is a
 *  `--print-affected` enumeration (no test execution), so this bound is about
 *  wall-clock politeness, not safety. */
export const MAX_ATTRIBUTION_PROBES = 8;

// ── the durable cursor (persisted by the action; shape owned here) ────────────

/** One red this check is currently holding open, so a later run can re-verify it
 *  (refreshing the same conditionKey) instead of re-discovering it from scratch. */
export interface OpenRed {
  /** Repo-relative path of the failing file. */
  path: string;
  /** Workspace the failing file was attributed to, when the runner named one. */
  workspace: string | null;
  /** The batch commit this check attributed it to, or null when unattributed. */
  introducedBy: string | null;
  /** Epoch ms this red was first filed. */
  firstSeenMs: number;
  /** How many runs have re-confirmed it (1 = the filing run). */
  confirmations: number;
}

/**
 * The durable state of this check, stored on the routine's OWN row
 * (`harness_shared.routines.metadata.sync_delta`) rather than a new
 * `operator-state-pg` table.
 *
 * WHY THERE and not a new StateTable: each `StateTable` in `operator-state-pg.ts`
 * is its own `harness_shared.<name>` table and therefore its own migration, while
 * `routines.metadata` is the established durable store for exactly this kind of
 * routine-scoped watermark (`gate_health.observedCandidate`, `repair_queue` and
 * `health.dead_target` all live there, each merged through a scoped `jsonb_set`
 * that leaves sibling keys alone). The state is per-routine-row and read by the
 * same routine that writes it, so co-locating it with the row is both cheaper and
 * more discoverable (`routines:list` already surfaces `metadata`).
 */
export interface SyncDeltaCursor {
  /** The last `staging` commit this check processed. */
  sha: string;
  /** Epoch ms of the last run that advanced the cursor. */
  updatedAtMs: number;
  /** Why the last run did no work, when it did none (`host-load`, `radius-too-wide`, …). */
  lastSkipReason?: string;
  /** Epoch ms of that skip. */
  lastSkipMs?: number;
  /** Commits folded into the last processed batch window. */
  lastBatchCommits?: number;
  /** Reds this check is holding open and re-verifying. */
  openReds?: OpenRed[];
}

// ── git-log parsing ──────────────────────────────────────────────────────────

/** One git-sync commit and the paths it touched. */
export interface SyncBatch {
  sha: string;
  /** Commit time, epoch ms (`%ct` * 1000), or null when unparseable. */
  committedAtMs: number | null;
  /** The `Papercusp-Agent:` trailer — the ONLY trustworthy attribution in this repo
   *  (blame and the subject both name the sweeping agent, not the author). */
  agent: string | null;
  /** Repo-relative paths the commit touched. */
  paths: string[];
}

/** The NUL byte git writes for `%x00`, built without a source escape so this file
 *  can never carry a raw control byte (`lint:no-control-bytes` is a
 *  green-checkpoint leg, and one raw byte here reds the fleet gate). */
const NUL = String.fromCharCode(0);

/**
 * Parse `git log <since>..<branch> --no-merges --name-only
 *        --format=%x00%H %ct%n%(trailers:key=Papercusp-Agent)`.
 *
 * NUL separates commits; within a block the first line is `<sha> <epoch-seconds>`,
 * an optional `Papercusp-Agent: <id>` trailer follows, and every remaining
 * non-blank line is a changed path. Output order is git's: NEWEST FIRST.
 */
export function parseSyncBatches(raw: string): SyncBatch[] {
  const out: SyncBatch[] = [];
  for (const block of raw.split(NUL)) {
    const lines = block.split('\n').map((l) => l.trim());
    while (lines.length > 0 && lines[0] === '') lines.shift();
    const header = lines.shift();
    if (!header) continue;
    const [sha, ct] = header.split(/\s+/, 2);
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
    const seconds = Number(ct);
    const paths: string[] = [];
    let agent: string | null = null;
    for (const line of lines) {
      if (!line) continue;
      const trailer = /^Papercusp-Agent:\s*(\S+)/.exec(line);
      if (trailer) {
        agent = trailer[1] ?? null;
        continue;
      }
      paths.push(line);
    }
    out.push({
      sha,
      committedAtMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      agent,
      paths,
    });
  }
  return out;
}

// ── path-set shaping ─────────────────────────────────────────────────────────

export interface UnionedPaths {
  /** De-duplicated union, in first-seen order across the batch window. */
  paths: string[];
  /** True when the union was cut at `maxPaths` — the caller must treat the run as
   *  a REFUSAL, never as a narrower measurement (a truncated radius under-reports). */
  truncated: boolean;
  /** Union size BEFORE truncation, so a refusal can say how wide it really was. */
  totalPaths: number;
}

/** Union the changed paths of a batch window, capped. Order is stable (first-seen)
 *  so a re-run over the same window produces the same probe argument, which is what
 *  makes the affected-runner's passing-verdict cache able to hit. */
export function unionBatchPaths(batches: readonly SyncBatch[], maxPaths = DEFAULT_RADIUS_CAPS.maxPaths): UnionedPaths {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const b of batches) {
    for (const p of b.paths) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
  }
  const truncated = paths.length > maxPaths;
  return { paths: truncated ? paths.slice(0, maxPaths) : paths, truncated, totalPaths: paths.length };
}

/** The TypeScript files in a path set — what `lint:tsc --files=` is given. A bare
 *  `lint:tsc` typechecks operator-core ONLY, so the `--files` set is the whole
 *  instrument here (root CLAUDE.md). `.d.ts` is excluded: it declares, it never
 *  compiles as a leg's input. */
export function tsFilesOf(paths: readonly string[]): string[] {
  return paths.filter((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'));
}

// ── radius probe parsing + the cap verdict ───────────────────────────────────

export interface RadiusProbe {
  /** `AFFECTED_WS<TAB><name>` lines. */
  workspaces: string[];
  /** `AFFECTED_GUARD<TAB><workspace><TAB><script>` lines, as `<workspace>:<script>`. */
  guards: string[];
}

/** One `AFFECTED_WS_CMD<TAB><workspace><TAB><command>` line: the EXACT runnable
 *  invocation for one selected task. Kept as {workspace, command} rather than a
 *  joined string because the command is the whole point — root CLAUDE.md's
 *  standing warning is never to rebuild it from the workspace name (a standalone
 *  submodule needs `npm --prefix`, not `--workspace`, and the `--workspace` form
 *  exits 1 having measured ZERO tests). */
export interface AffectedTaskCommand {
  workspace: string;
  command: string;
}

/** The `AFFECTED_DERIVATION source=… changedPaths=… workspaces=… guards=… tasks=…`
 *  header. `source` is the field that says whether the radius came from an explicit
 *  `--changed-paths` set or from a tree-sized git diff — the distinction that decides
 *  whether a run is verifying YOUR edit or the whole fleet's. */
export interface AffectedDerivation {
  source: string;
  counts: Record<string, number>;
  raw: string;
}

/** `parseAffectedProbe`'s full result. It EXTENDS `RadiusProbe` additively rather
 *  than widening that interface in place: the release lane consumes only
 *  workspaces+guards, so making the new fields required there would strand its
 *  callers and fixtures for data it never reads. Every existing consumer typed as
 *  `RadiusProbe` keeps compiling unchanged. */
export interface AffectedProbe extends RadiusProbe {
  /** Selected TASKS. Note this is a different cardinality from `workspaces`: one
   *  workspace routinely contributes several tasks (operator-core alone splits into
   *  test:lane-pure + test:lane-stateful plus its lint guards), so a workspace count
   *  materially understates what a run will actually execute. */
  taskCommands: AffectedTaskCommand[];
  /** null when the probe emitted no derivation header (older script, or a failed run). */
  derivation: AffectedDerivation | null;
}

/** Parse `affected-tests.mjs --print-affected` output. It is an ENUMERATION query
 *  that emits no verdict marker, so absence of every line kind means "zero
 *  selected", which is a real (and common) answer. */
export function parseAffectedProbe(stdout: string): AffectedProbe {
  const workspaces: string[] = [];
  const guards: string[] = [];
  const taskCommands: AffectedTaskCommand[] = [];
  let derivation: AffectedDerivation | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // AFFECTED_WS_CMD is tested BEFORE AFFECTED_WS on purpose: `AFFECTED_WS\t(.+)`
    // does not match an `AFFECTED_WS_CMD\t…` line (the literal tab after `AFFECTED_WS`
    // is absent), but relying on that is a one-character-away trap, and mis-ordering
    // it would silently fold task commands into the workspace set — the same corruption
    // green-checkpoint.ts calls out where it parses `AFFECTED_WS\t` into its own Set.
    const cmd = /^AFFECTED_WS_CMD\t([^\t]+)\t(.+)$/.exec(line);
    if (cmd?.[1] && cmd[2]) {
      taskCommands.push({ workspace: cmd[1].trim(), command: cmd[2].trim() });
      continue;
    }
    const ws = /^AFFECTED_WS\t(.+)$/.exec(line);
    if (ws?.[1]) {
      workspaces.push(ws[1].trim());
      continue;
    }
    const guard = /^AFFECTED_GUARD\t([^\t]+)\t(.+)$/.exec(line);
    if (guard?.[1] && guard[2]) {
      guards.push(`${guard[1].trim()}:${guard[2].trim()}`);
      continue;
    }
    if (line.startsWith('AFFECTED_DERIVATION ')) {
      const counts: Record<string, number> = {};
      let source = 'unknown';
      for (const field of line.slice('AFFECTED_DERIVATION '.length).trim().split(/\s+/)) {
        const eq = field.indexOf('=');
        if (eq <= 0) continue;
        const key = field.slice(0, eq);
        const value = field.slice(eq + 1);
        if (key === 'source') {
          source = value;
          continue;
        }
        // Only numeric fields become counts; `runStartHead=<sha>` is deliberately
        // NOT coerced — Number('0a5de631…') is NaN, and a NaN in a counts map reads
        // as a measurement that failed rather than a field that was never a count.
        if (/^\d+$/.test(value)) counts[key] = Number(value);
      }
      derivation = { source, counts, raw: line.trim() };
    }
  }
  return { workspaces, guards, taskCommands, derivation };
}

export type RadiusVerdict =
  | { run: true; workspaces: string[] }
  | { run: false; reason: 'radius-too-wide'; detail: string }
  | { run: false; reason: 'nothing-selected'; detail: string };

/**
 * Should this batch window actually be EXECUTED?
 *
 * `nothing-selected` is a first-class PASS-BY-CONSTRUCTION, not a failure: a batch
 * of docs/plan edits legitimately selects zero workspaces, and running the suite for
 * it would be pure waste. It is reported separately from `radius-too-wide` because
 * the two want opposite follow-ups (one advances the cursor happily, the other is a
 * measurement we declined to take).
 */
export function evaluateRadius(input: {
  probe: RadiusProbe;
  union: UnionedPaths;
  batchCount: number;
  caps?: RadiusCaps;
}): RadiusVerdict {
  const caps = input.caps ?? DEFAULT_RADIUS_CAPS;
  const { probe, union, batchCount } = input;
  if (union.truncated) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail: `${union.totalPaths} changed paths across ${batchCount} commit(s) exceeds maxPaths=${caps.maxPaths}`,
    };
  }
  if (batchCount > caps.maxCommits) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail: `${batchCount} commits in the window exceeds maxCommits=${caps.maxCommits}`,
    };
  }
  if (probe.workspaces.length > caps.maxWorkspaces) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail:
        `${probe.workspaces.length} affected workspaces (${probe.workspaces.slice(0, 8).join(', ')}) ` +
        `exceeds maxWorkspaces=${caps.maxWorkspaces}`,
    };
  }
  if (probe.workspaces.length === 0) {
    return {
      run: false,
      reason: 'nothing-selected',
      detail: `${union.paths.length} changed path(s) select no test workspace`,
    };
  }
  return { run: true, workspaces: probe.workspaces };
}

// ── failure parsing ──────────────────────────────────────────────────────────

/** One failing file as the affected runner itself named it. */
export interface FailingFile {
  workspace: string | null;
  /** Repo-relative when the caller can resolve it; otherwise as reported. */
  file: string;
}

/** SGR colour escapes, so a coloured runner log parses identically to a piped one.
 *  The ESC is built with `String.fromCharCode(27)` rather than a source escape:
 *  `lint:no-control-bytes` is a green-checkpoint leg and one raw ESC byte in source
 *  reds the fleet gate for everybody (EI-19478121013052934). */
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Parse the runner's canonical break-set line
 * (`AFFECTED_TESTS_FAILING_FILES run=… files=[{workspace,file}] …`).
 *
 * Returns `null` when the line is ABSENT — which is not the same as `[]`. A present
 * line with `files=[]` is the run deliberately saying "red, but I could not name
 * files"; an absent line means the run never reached its terminal verdict at all,
 * and treating that as "no failures" is the false-green this distinction exists to
 * prevent. `sync-batch-delta-check.test.ts` pins this parser against the REAL
 * emitter (`scripts/lib/vitest-summary.mjs`'s `renderFailingFilesSummary`) so the
 * two cannot drift.
 */
export function parseFailingFilesLine(text: string): FailingFile[] | null {
  if (!text) return null;
  let parsed: FailingFile[] | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(SGR_RE, '');
    if (!/^\s*AFFECTED_TESTS_FAILING_FILES\s+run=\S+\s+/.test(line)) continue;
    const filesAt = line.indexOf('files=');
    if (filesAt < 0) continue;
    const unattributedAt = line.indexOf(' unattributed=', filesAt + 'files='.length);
    if (unattributedAt < 0) continue;
    let files: unknown;
    try {
      files = JSON.parse(line.slice(filesAt + 'files='.length, unattributedAt).trim());
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    const seen = new Set<string>();
    const entries: FailingFile[] = [];
    for (const entry of files) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as { workspace?: unknown; file?: unknown };
      if (typeof rec.file !== 'string' || !rec.file.trim()) continue;
      const workspace = typeof rec.workspace === 'string' && rec.workspace.trim() ? rec.workspace.trim() : null;
      const file = rec.file.trim();
      const key = `${workspace ?? ''} ${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ workspace, file });
    }
    // The outer runner prints its summary after child output; keep the LAST valid
    // line so a nested fixture invocation cannot mask the run-level break set.
    parsed = entries;
  }
  return parsed;
}

/** Extract the distinct files named by `error TS…` diagnostics. `tsc` prints
 *  `path/to/file.ts(12,3): error TS2339: …`; a leg that compiled nothing prints
 *  none, which is why the caller must ALSO read the leg's exit code rather than
 *  inferring green from an empty list. */
export function parseTscFailingFiles(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(SGR_RE, '');
    const m = /^\s*(\S+?\.[cm]?tsx?)\((\d+),(\d+)\):\s+error TS\d+/.exec(line);
    const file = m?.[1];
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

// ── host-load gate ───────────────────────────────────────────────────────────

export interface LoadReading {
  /** 1-minute load average. */
  load1: number;
  /** Online CPUs. */
  cores: number;
}

/** Parse `/proc/loadavg`'s first field. Returns null when the file is not the shape
 *  we expect — an unreadable instrument must never render as "load is fine". */
export function parseLoadavg1(raw: string): number | null {
  const first = raw.trim().split(/\s+/)[0];
  const n = Number(first);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type LoadVerdict = { skip: false } | { skip: true; reason: string };

/** Skip when the box is already oversubscribed. An UNREADABLE load (`null`) also
 *  skips: this check is optional work, so "I could not tell" resolves to not
 *  competing with the gate rather than to running anyway. */
export function evaluateLoad(reading: LoadReading | null, factor = LOAD_SKIP_FACTOR): LoadVerdict {
  if (!reading || !Number.isFinite(reading.load1) || !(reading.cores > 0)) {
    return { skip: true, reason: 'host-load-unreadable' };
  }
  const ceiling = reading.cores * factor;
  if (reading.load1 > ceiling) {
    return {
      skip: true,
      reason: `host-load ${reading.load1.toFixed(2)} > ${ceiling.toFixed(2)} (cores ${reading.cores} x ${factor})`,
    };
  }
  return { skip: false };
}

// ── batch attribution ────────────────────────────────────────────────────────

export interface Attribution {
  /** The batch this red is attributed to, or null when none could be named. */
  batch: SyncBatch | null;
  /** How it was decided — evidence, not a label. */
  how: 'exact-path' | 'radius' | 'unattributed';
  /** Radius probes spent (so the caller can keep the total under the cap). */
  probesUsed: number;
}

/**
 * Walk the window NEWEST→OLDEST and name the first batch that could have introduced
 * `failing`.
 *
 * Two tiers, cheapest first:
 *   1. EXACT — the batch touched the failing file itself.
 *   2. RADIUS — the batch's own changed paths select the workspace the failing file
 *      belongs to (one `--print-affected` enumeration per batch, capped).
 *
 * ⚠ This is a RADIUS argument, not a bisect: a true bisect would have to check out
 * each candidate sha, and this runs on the SHARED tree where no checkout is
 * permissible (root CLAUDE.md forbids every tree-wide destructive git op, and the
 * whole fleet is editing that tree concurrently). So the verdict names the newest
 * batch that *can reach* the break — the honest claim the evidence supports — and
 * `how` says which tier produced it so a reader never mistakes a radius hit for a
 * proven culprit.
 */
export async function attributeIntroducingBatch(input: {
  batches: readonly SyncBatch[];
  failing: FailingFile;
  /** Enumerate the affected workspaces for one batch's paths. Return null when the
   *  probe itself failed — an unmeasurable batch is skipped, never assumed clean. */
  probeBatch: (paths: readonly string[]) => Promise<RadiusProbe | null>;
  maxProbes?: number;
}): Promise<Attribution> {
  const maxProbes = input.maxProbes ?? MAX_ATTRIBUTION_PROBES;
  let probesUsed = 0;
  for (const batch of input.batches) {
    if (batch.paths.includes(input.failing.file)) {
      return { batch, how: 'exact-path', probesUsed };
    }
  }
  if (!input.failing.workspace) return { batch: null, how: 'unattributed', probesUsed };
  for (const batch of input.batches) {
    if (probesUsed >= maxProbes) break;
    if (batch.paths.length === 0) continue;
    probesUsed += 1;
    const probe = await input.probeBatch(batch.paths);
    if (!probe) continue;
    if (probe.workspaces.includes(input.failing.workspace)) {
      return { batch, how: 'radius', probesUsed };
    }
  }
  return { batch: null, how: 'unattributed', probesUsed };
}

// ── the filed finding ────────────────────────────────────────────────────────

/** The upsert identity: ONE open item per failing file, refreshed rather than
 *  re-filed. `work_items:create`'s `conditionKey` adopts an OPEN incumbent holding
 *  this key, which is what keeps a 5-minute cadence from becoming a spam engine. */
export function conditionKeyForRed(filePath: string): string {
  return `sync-delta-red:${filePath}`;
}

export interface RedFinding {
  conditionKey: string;
  title: string;
  body: string;
  /** Paths the item is about — the failing file plus the introducing batch's paths. */
  paths: string[];
}

/** Render the work-item a confirmed red becomes. Every field a triager needs is in
 *  the BODY, because a work-item body is what survives; a routine's console log does
 *  not. */
export function buildRedFinding(input: {
  failing: FailingFile;
  attribution: Attribution;
  /** The whole window this run judged, newest first. */
  batches: readonly SyncBatch[];
  leg: 'affected-tests' | 'lint-tsc';
  slaMinutes?: number;
  /** Prior open-red record, when this is a REFRESH rather than a first filing. */
  prior?: OpenRed | null;
}): RedFinding {
  const sla = input.slaMinutes ?? SYNC_DELTA_SLA_MINUTES;
  const { failing, attribution, batches, leg } = input;
  const batch = attribution.batch;
  const legLabel = leg === 'lint-tsc' ? 'lint:tsc' : 'test:affected';
  const title = `sync-batch delta red: ${failing.file} (${legLabel})`;

  const oldest = batches[batches.length - 1];
  const newest = batches[0];
  const windowLine =
    !oldest || !newest
      ? 'Window: (re-verification of an already-open red; no new commits judged this tick)'
      : `Window: ${batches.length} commit(s), ${oldest.sha.slice(0, 12)}..${newest.sha.slice(0, 12)}`;

  const attributionBlock = batch
    ? [
        `Introducing batch: ${batch.sha}`,
        `  attributed by: ${
          attribution.how === 'exact-path'
            ? 'the batch touched this exact file'
            : "the batch's changed paths select this file's workspace"
        }`,
        `  Papercusp-Agent trailer: ${batch.agent ?? '(none)'}`,
        `  changed paths (${batch.paths.length}): ${batch.paths.slice(0, 25).join(', ')}${
          batch.paths.length > 25 ? ', ...' : ''
        }`,
      ].join('\n')
    : [
        'Introducing batch: NOT ATTRIBUTED.',
        `  No commit in the window touches this file, and no batch's radius selects ${
          failing.workspace ?? 'its workspace'
        }.`,
        '  Treat the whole window as the suspect set; do NOT read this as "nobody did it".',
      ].join('\n');

  const lines = [
    `\`${failing.file}\` is RED on \`staging\` and the break falls inside a recent git-sync batch.`,
    '',
    `Failing file: ${failing.file}`,
    `Workspace:    ${failing.workspace ?? '(not named by the runner)'}`,
    `Detected by:  ${legLabel}, re-confirmed in its own single-file invocation`,
    windowLine,
    '',
    attributionBlock,
    '',
    `SLA: fix or revert within ${sla} minutes.`,
    'Past that the hourly green-checkpoint freezes a candidate on top of this break, and every later',
    'red inherits its attribution — which is the failure this check exists to prevent.',
    '',
    'Repair, in order:',
    `  1. \`npm run test:file -- ${failing.file}\` (or \`npm run lint:tsc -- --files=${failing.file}\`) to see the break.`,
    "  2. Fix forward if it is small. If it is not, revert the introducing batch's change to the paths above.",
    '  3. Re-run the same command to prove it green.',
    '',
    'Attribution caveat: this is a RADIUS argument, not a bisect. The shared tree cannot be checked out',
    'per-candidate, so the named batch is the NEWEST one whose changed paths can reach this file — strong',
    'evidence, not proof. `git blame` and the commit subject are worthless here (git-sync sweeps the whole',
    'tree under one identity); the `Papercusp-Agent` trailer above is the only trustworthy attribution.',
    '',
    `Filed by \`system:sync-batch-delta-check\` (conditionKey \`${conditionKeyForRed(
      failing.file,
    )}\` — this item is refreshed in place while the red persists, never re-filed as a sibling).`,
  ];
  if (input.prior) {
    lines.push(
      `Re-confirmed ${input.prior.confirmations + 1}x since ${new Date(input.prior.firstSeenMs).toISOString()}.`,
    );
  }

  const paths = [failing.file, ...(batch?.paths ?? [])].filter((p, i, a) => a.indexOf(p) === i).slice(0, 40);
  return { conditionKey: conditionKeyForRed(failing.file), title, body: lines.join('\n'), paths };
}

// ── the orchestration (deps-injected, so it is unit-testable end to end) ─────

/** Verdict of one single-file re-run. `null` = the run could not be measured
 *  (`matched=0`, a route error, no terminal line) — deliberately distinct from
 *  `false`, because "undetermined" must never be filed as a red. */
export type ConfirmVerdict = boolean | null;

export interface SyncBatchDeltaDeps {
  /** Read the durable cursor, or null when this check has never run here. */
  readCursor(): Promise<SyncDeltaCursor | null>;
  /** Persist the cursor (merged under `routines.metadata.sync_delta`). */
  writeCursor(next: SyncDeltaCursor): Promise<void>;
  /** `/proc/loadavg` + core count, or null when unreadable. */
  hostLoad(): LoadReading | null;
  // ⛔ Every leg below shells out, and therefore returns a Promise BY CONTRACT
  // (WI-10001771). The binding runs inside bg-host, which serves :3271 and the DBOS
  // routine engine on the same event loop, so a synchronous implementation
  // (`spawnSync`/`execFileSync`) blocks that loop for the child's whole lifetime and
  // takes the routine engine down fleet-wide. Keep these async even if a future
  // binding's work looks instant.
  /** true = a green-checkpoint suite is running; false = it is not; null = undetectable. */
  greenCheckpointRunning(): Promise<boolean | null>;
  /** Tip of the integration branch, or null when git could not be read. */
  headSha(): Promise<string | null>;
  /** Commits in `(sinceSha, HEAD]`, newest first; null when git could not be read. */
  listBatches(sinceSha: string): Promise<SyncBatch[] | null>;
  /** `affected-tests.mjs --print-affected` for a path set; null when the probe failed. */
  probeRadius(paths: readonly string[]): Promise<RadiusProbe | null>;
  /** `affected-tests.mjs --changed-paths <paths>` — the actual run. `failing: null`
   *  on a red means the run named no files, i.e. UNDETERMINED. */
  runAffected(paths: readonly string[]): Promise<{ ok: boolean; failing: FailingFile[] | null }>;
  /** `lint-tsc.mjs --files=<files>`. */
  runTsc(files: readonly string[]): Promise<{ ok: boolean; failing: string[] }>;
  /** One file, in its OWN invocation (root CLAUDE.md's gate-triage rule).
   *  `true` = passed, `false` = failed, `null` = not measured. */
  confirmOne(file: string): Promise<ConfirmVerdict>;
  /** File/refresh the deduped work item. */
  fileRed(finding: RedFinding): Promise<{ ok: boolean; id?: string; adopted?: boolean; error?: string }>;
  now(): number;
  log(message: string): void;
}

export type SyncBatchDeltaStatus =
  | 'skipped'
  | 'bootstrapped'
  | 'up-to-date'
  | 'radius-too-wide'
  | 'nothing-selected'
  | 'green'
  | 'red';

export interface SyncBatchDeltaFiling {
  file: string;
  conditionKey: string;
  introducedBy: string | null;
  id?: string;
  adopted?: boolean;
  error?: string;
}

export interface SyncBatchDeltaResult {
  status: SyncBatchDeltaStatus;
  /** Why, when the status alone does not say it. */
  reason?: string;
  /** Commits in the window this run judged. */
  batchCount: number;
  /** Unioned changed paths this run judged. */
  pathCount: number;
  /** Workspaces the radius probe selected. */
  workspaces: string[];
  /** Confirmed reds this run filed or refreshed. */
  filed: SyncBatchDeltaFiling[];
  /** Files the runner named that a single-file re-run did NOT reproduce — reported,
   *  never filed (they are the collection-abort false positives CLAUDE.md warns about). */
  unconfirmed: string[];
  /** Cursor after this run (null when the run deliberately did not advance it). */
  cursor: SyncDeltaCursor | null;
}

const emptyResult = (status: SyncBatchDeltaStatus, reason?: string): SyncBatchDeltaResult => ({
  status,
  ...(reason ? { reason } : {}),
  batchCount: 0,
  pathCount: 0,
  workspaces: [],
  filed: [],
  unconfirmed: [],
  cursor: null,
});

/**
 * One tick of the sync-batch delta check.
 *
 * NEVER advances the cursor past a window it could not measure: every "I could not
 * tell" path returns `skipped` with the cursor untouched, so the next run judges
 * that window instead of it being silently skipped forever. The cursor advances
 * only after a leg actually ran — or after the window was deliberately refused as
 * too wide, because leaving it parked there would re-refuse the same (still-growing)
 * window forever and wedge the check permanently.
 */
export async function runSyncBatchDeltaCheck(
  deps: SyncBatchDeltaDeps,
  opts?: { caps?: RadiusCaps; maxConfirmRuns?: number; maxAttributionProbes?: number },
): Promise<SyncBatchDeltaResult> {
  const caps = opts?.caps ?? DEFAULT_RADIUS_CAPS;
  const maxConfirm = opts?.maxConfirmRuns ?? MAX_CONFIRM_RUNS;
  const maxProbes = opts?.maxAttributionProbes ?? MAX_ATTRIBUTION_PROBES;

  // ── 1. never fight the gate ────────────────────────────────────────────────
  const loadVerdict = evaluateLoad(deps.hostLoad(), LOAD_SKIP_FACTOR);
  if (loadVerdict.skip) {
    await recordSkip(deps, loadVerdict.reason);
    deps.log(`[sync-batch-delta] skip: ${loadVerdict.reason}`);
    return emptyResult('skipped', loadVerdict.reason);
  }
  if ((await deps.greenCheckpointRunning()) === true) {
    await recordSkip(deps, 'green-checkpoint-running');
    deps.log('[sync-batch-delta] skip: a green-checkpoint suite is running');
    return emptyResult('skipped', 'green-checkpoint-running');
  }

  // ── 2. cursor ──────────────────────────────────────────────────────────────
  const head = await deps.headSha();
  if (!head) return emptyResult('skipped', 'git-unreadable');

  const cursor = await deps.readCursor();
  if (!cursor?.sha) {
    // First run here: adopt the tip. Scanning history backwards would judge
    // thousands of commits nobody is going to repair now.
    const next: SyncDeltaCursor = { sha: head, updatedAtMs: deps.now() };
    await deps.writeCursor(next);
    deps.log(`[sync-batch-delta] bootstrapped cursor at ${head.slice(0, 12)}`);
    return { ...emptyResult('bootstrapped'), cursor: next };
  }

  // ── 3. re-verify reds we are already holding open (bounded, cheap) ─────────
  const stillOpen: OpenRed[] = [];
  const filed: SyncBatchDeltaFiling[] = [];
  let confirmBudget = maxConfirm;
  for (const red of cursor.openReds ?? []) {
    if (confirmBudget <= 0) {
      stillOpen.push(red); // unmeasured this tick — keep holding it, never drop silently
      continue;
    }
    confirmBudget -= 1;
    const verdict = await deps.confirmOne(red.path);
    if (verdict === null || verdict === true) {
      // undetermined ⇒ keep holding; green ⇒ the red cleared, stop holding it.
      if (verdict === null) stillOpen.push(red);
      continue;
    }
    // Still red: refresh the SAME conditionKey so the incumbent is bumped, not duplicated.
    const finding = buildRedFinding({
      failing: { file: red.path, workspace: red.workspace },
      attribution: { batch: null, how: 'unattributed', probesUsed: 0 },
      batches: [],
      leg: 'affected-tests',
      prior: red,
    });
    const res = await deps.fileRed(finding);
    filed.push({
      file: red.path,
      conditionKey: finding.conditionKey,
      introducedBy: red.introducedBy,
      ...(res.id ? { id: res.id } : {}),
      ...(res.adopted ? { adopted: true } : {}),
      ...(res.error ? { error: res.error } : {}),
    });
    stillOpen.push({ ...red, confirmations: red.confirmations + 1 });
  }

  if (cursor.sha === head) {
    const next: SyncDeltaCursor = { ...cursor, sha: head, updatedAtMs: deps.now(), openReds: stillOpen };
    await deps.writeCursor(next);
    return { ...emptyResult('up-to-date'), filed, cursor: next };
  }

  // ── 4. the new batch window ────────────────────────────────────────────────
  const batches = await deps.listBatches(cursor.sha);
  if (!batches) return emptyResult('skipped', 'git-log-unreadable');
  if (batches.length === 0) {
    const next: SyncDeltaCursor = { ...cursor, sha: head, updatedAtMs: deps.now(), openReds: stillOpen };
    await deps.writeCursor(next);
    return { ...emptyResult('up-to-date'), filed, cursor: next };
  }

  const union = unionBatchPaths(batches, caps.maxPaths);
  if (union.paths.length === 0) {
    const next: SyncDeltaCursor = {
      ...cursor,
      sha: head,
      updatedAtMs: deps.now(),
      lastBatchCommits: batches.length,
      openReds: stillOpen,
    };
    await deps.writeCursor(next);
    return {
      ...emptyResult('nothing-selected', 'no changed paths'),
      batchCount: batches.length,
      filed,
      cursor: next,
    };
  }

  // ── 5. radius probe + the cap ──────────────────────────────────────────────
  const probe = await deps.probeRadius(union.paths);
  if (!probe) return emptyResult('skipped', 'radius-probe-failed');

  const verdict = evaluateRadius({ probe, union, batchCount: batches.length, caps });
  if (!verdict.run) {
    const next: SyncDeltaCursor = {
      ...cursor,
      sha: head,
      updatedAtMs: deps.now(),
      lastSkipReason: verdict.reason,
      lastSkipMs: deps.now(),
      lastBatchCommits: batches.length,
      openReds: stillOpen,
    };
    await deps.writeCursor(next);
    deps.log(`[sync-batch-delta] ${verdict.reason}: ${verdict.detail}`);
    return {
      status: verdict.reason,
      reason: verdict.detail,
      batchCount: batches.length,
      pathCount: union.paths.length,
      workspaces: probe.workspaces,
      filed,
      unconfirmed: [],
      cursor: next,
    };
  }

  // ── 6. execute the two legs ────────────────────────────────────────────────
  // Sequential on purpose: these are the two heaviest subprocesses on the box, and
  // running them concurrently would double the load the radius cap exists to bound.
  const affected = await deps.runAffected(union.paths);
  const tsFiles = tsFilesOf(union.paths);
  const tsc = tsFiles.length > 0 ? await deps.runTsc(tsFiles) : { ok: true, failing: [] as string[] };

  const candidates: Array<{ failing: FailingFile; leg: 'affected-tests' | 'lint-tsc' }> = [];
  if (!affected.ok) {
    if (affected.failing === null) {
      // Red with no terminal break-set line ⇒ the run never reached its verdict.
      // NOT MEASURED: do not advance, do not file. The next tick re-judges the window.
      deps.log('[sync-batch-delta] affected run red but named no files — undetermined, cursor held');
      return {
        ...emptyResult('skipped', 'affected-run-undetermined'),
        batchCount: batches.length,
        pathCount: union.paths.length,
        workspaces: probe.workspaces,
        filed,
      };
    }
    for (const f of affected.failing) candidates.push({ failing: f, leg: 'affected-tests' });
  }
  for (const f of tsc.failing) candidates.push({ failing: { file: f, workspace: null }, leg: 'lint-tsc' });

  // ── 7. confirm, attribute, file ────────────────────────────────────────────
  const unconfirmed: string[] = [];
  let probeBudget = maxProbes;
  const alreadyOpen = new Set(stillOpen.map((r) => r.path));

  for (const cand of candidates) {
    if (alreadyOpen.has(cand.failing.file)) continue;
    if (cand.leg === 'affected-tests') {
      if (confirmBudget <= 0) {
        unconfirmed.push(cand.failing.file);
        continue;
      }
      confirmBudget -= 1;
      const v = await deps.confirmOne(cand.failing.file);
      if (v === null || v === true) {
        // undetermined, or green on its own — CLAUDE.md: never attribute a batch
        // verdict to every file it named.
        unconfirmed.push(cand.failing.file);
        continue;
      }
    }

    const attribution = await attributeIntroducingBatch({
      batches,
      failing: cand.failing,
      probeBatch: async (paths) => {
        if (probeBudget <= 0) return null;
        probeBudget -= 1;
        return deps.probeRadius(paths);
      },
      maxProbes: probeBudget,
    });
    const finding = buildRedFinding({ failing: cand.failing, attribution, batches, leg: cand.leg });
    const res = await deps.fileRed(finding);
    filed.push({
      file: cand.failing.file,
      conditionKey: finding.conditionKey,
      introducedBy: attribution.batch?.sha ?? null,
      ...(res.id ? { id: res.id } : {}),
      ...(res.adopted ? { adopted: true } : {}),
      ...(res.error ? { error: res.error } : {}),
    });
    stillOpen.push({
      path: cand.failing.file,
      workspace: cand.failing.workspace,
      introducedBy: attribution.batch?.sha ?? null,
      firstSeenMs: deps.now(),
      confirmations: 1,
    });
    alreadyOpen.add(cand.failing.file);
  }

  const next: SyncDeltaCursor = {
    sha: head,
    updatedAtMs: deps.now(),
    lastBatchCommits: batches.length,
    openReds: stillOpen,
  };
  await deps.writeCursor(next);

  const red = filed.length > 0;
  deps.log(
    `[sync-batch-delta] ${batches.length} commit(s), ${union.paths.length} path(s), ` +
      `${probe.workspaces.length} workspace(s) -> ${red ? `${filed.length} red filed/refreshed` : 'green'}`,
  );
  return {
    status: red ? 'red' : 'green',
    batchCount: batches.length,
    pathCount: union.paths.length,
    workspaces: probe.workspaces,
    filed,
    unconfirmed,
    cursor: next,
  };
}

/** Record a skip WITHOUT advancing the cursor — the window stays unjudged so the
 *  next tick picks it up, which is the whole point of skipping rather than lying. */
async function recordSkip(deps: SyncBatchDeltaDeps, reason: string): Promise<void> {
  try {
    const cursor = await deps.readCursor();
    if (!cursor?.sha) return; // nothing to annotate yet
    await deps.writeCursor({ ...cursor, lastSkipReason: reason, lastSkipMs: deps.now() });
  } catch {
    // The skip note is an instrument, never a reason to fail the tick.
  }
}
