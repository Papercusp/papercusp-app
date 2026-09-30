/**
 * Measure collection for the packaged-binary perf runner.
 *
 * WHY THIS EXISTS (perf-testing-sweep-2026-07-27, WI-6538 / WI-6535):
 * `harness_shared.desktop_perf_runs` was EMPTY from the day the desktop-perf
 * suite landed (2026-07-20), which made the desktop-perf release gate
 * structurally incapable of firing — `desktop-perf-gate.ts` looks for the latest
 * run, finds none, and takes its fail-soft `pass` branch. Every deploy therefore
 * cleared a perf gate that had never measured anything.
 *
 * The specs in this runner DID measure real interactions; they just `console.log`ged
 * the numbers and threw them away. This module is the collection half that lets a
 * run persist them (the wdio.conf.ts `onComplete` hook POSTs them to the operator's
 * ingest route, which wraps the same `recordDesktopPerfRun` the in-app admin suite
 * uses — one writer, one schema, one trend).
 *
 * WHY A FILE AND NOT AN IN-MEMORY ARRAY:
 * wdio's `local` runner FORKS a separate child process per spec file, while
 * `onPrepare`/`onComplete` run in the LAUNCHER process (see the long note on
 * `resolveDriverPort` in wdio.conf.ts — the same process boundary bit that fix
 * too). A module-scoped array written by a spec is invisible to `onComplete`:
 * different process, different memory. The measures must cross that boundary on
 * disk.
 *
 * WHY JSONL AND NOT A JSON ARRAY:
 * appending one self-contained line per measure is a single O_APPEND write with no
 * read-modify-write step, so concurrent spec workers cannot clobber each other's
 * measures (`maxInstances` is 1 today, but that is a tuning knob, not a guarantee).
 * It also degrades safely: a worker killed mid-write leaves one unparseable
 * trailing line, which `readMeasures` skips, instead of corrupting the whole file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface PrivateIpcFixture {
  pid: number;
  port: number;
  socketPath: string;
  socketDevice: number;
  socketInode: number;
}

/** Explicit Linux current-build fixtures use the same default discovery as Rust.
 * Validate before spawning: a dead default alongside a fresh per-port advert
 * otherwise silently falls back to HTTP and measures the wrong transport. */
export function assertPrivateIpcFixture(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): PrivateIpcFixture | null {
  if (platform !== "linux" || !env.PAPERCUSP_HOME) return null;
  if (!env.PAPERCUSP_DEV_API_TARGET) {
    if (env.PAPERCUSP_PERF_RUN_ID?.trim()) {
      throw new Error(
        "Named Linux native runs with PAPERCUSP_HOME require PAPERCUSP_DEV_API_TARGET for IPC fixture validation.",
      );
    }
    return null;
  }
  const port = Number(env.PAPERCUSP_DEV_API_TARGET);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PAPERCUSP_DEV_API_TARGET: ${env.PAPERCUSP_DEV_API_TARGET}`,
    );
  }
  const file = path.join(env.PAPERCUSP_HOME, 'endpoint-ipc.json');
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; port?: number; socketPath?: string };
    const socket = typeof record.socketPath === 'string' ? statSync(record.socketPath) : null;
    if (!Number.isInteger(record.pid) || record.pid! <= 0 || record.port !== port ||
        !socket?.isSocket()) {
      throw new Error('default discovery has a missing socket or mismatched PID/port');
    }
    process.kill(record.pid!, 0);
    return {
      pid: record.pid!,
      port,
      socketPath: record.socketPath!,
      socketDevice: socket.dev,
      socketInode: socket.ino,
    };
  } catch (error) {
    throw new Error(`Invalid private native IPC fixture at ${file}: ${String(error)}. ` +
      `Refresh endpoint-ipc.json from the verified live endpoint-ipc.${port}.json before measuring.`);
  }
}

/** A valid fixture at both ends is insufficient: it may point to a new API. */
export function assertPrivateIpcFixtureUnchanged(
  expected: PrivateIpcFixture | null,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): void {
  const current = assertPrivateIpcFixture(env, platform);
  if (expected === null && current === null) return;
  if (!expected || !current || expected.pid !== current.pid || expected.port !== current.port ||
      expected.socketPath !== current.socketPath || expected.socketDevice !== current.socketDevice ||
      expected.socketInode !== current.socketInode) {
    throw new Error('Private native IPC fixture changed during the measured run');
  }
}

/**
 * Mirrors `DesktopPerfMetricUnit` in packages/operator-core/lib/admin-test-suites-shared.ts.
 *
 * ⚠ Do NOT add a unit here to "make a measure fit". This runner posts to a
 * RUNNING operator (`:3070` = the deployed release checkout, NOT your working
 * tree), whose ingest route rejects the WHOLE batch on one unrecognised unit —
 * so a unit that exists only in your tree starves the gate rather than degrading
 * gracefully. Carry the unit in the metric KEY instead. See the long note on
 * DesktopPerfMetricUnit.
 */
export type PerfMeasureUnit = "ms" | "kb" | "count";

/** Mirrors `DesktopPerfMeasure` — the exact shape the ingest route validates. */
export interface PerfMeasure {
  /** Stable metric key, e.g. 'interaction:command-palette-open'. */
  key: string;
  value: number;
  unit: PerfMeasureUnit;
  /** null for an unbudgeted metric — recorded, never a failure. */
  budget: number | null;
  ok: boolean;
  /**
   * Binary correctness invariant rather than a tunable budget: a breach BLOCKS the
   * release gate even though ordinary budget regressions only warn
   * (no-http-anywhere-2026-07-28 P-003c). Prefer {@link recordInvariant}.
   */
  invariant?: boolean;
}

const RESULTS_DIR = path.resolve(__dirname, "results");
const MEASURES_PATH = path.join(RESULTS_DIR, "measures.jsonl");

export { MEASURES_PATH };

/**
 * Context-stamp prefixes: `host:` (the box) and `build:` (the artifact measured).
 * A COPY of DESKTOP_PERF_CONTEXT_STAMP_PREFIXES in
 * packages/operator-core/lib/admin-test-suites-shared.ts, which this runner does not
 * import; perf-report.node-test.ts fails if the two drift.
 */
export const CONTEXT_STAMP_PREFIXES = ["host:", "build:"] as const;

/** Copy of DESKTOP_PERF_BINARY_BUILT_AT_KEY (same pin as above). */
export const BINARY_BUILT_AT_KEY = "build:packaged-binary-mtime-ms";

/**
 * Context stamps describe the environment around a run; they are not a
 * test outcome. A preflight/session failure can still reach WDIO's onComplete,
 * so a stamp-only batch must never mint a fresh green performance run.
 */
export function hasRunOutcomeMeasure(measures: readonly PerfMeasure[]): boolean {
  return measures.some(
    (measure) => !CONTEXT_STAMP_PREFIXES.some((prefix) => measure.key.startsWith(prefix)),
  );
}

/**
 * Stamp WHEN the binary under test was built: its file mtime, epoch ms (WI-10003815).
 *
 * The run's `gitSha` is the checkout HEAD at run time, and nothing here rebuilds the
 * packaged binary, so without this stamp a run cannot say which code it timed. The
 * release gate compares this against the green pin and refuses to charge a candidate
 * with a breach measured on a build older than `main`: that measured a tree the
 * candidate had already moved past (observed 2026-09-29 on a 12-day-old binary).
 *
 * A stamp, not a budget (`budget: null`, `ok: true`), in unit `count` because a new
 * unit 400s the whole batch on a not-yet-redeployed validator. Never throws: an
 * unreadable binary only loses the stamp, and the gate then makes no attribution call.
 */
export function recordBinaryIdentity(appPath: string): void {
  try {
    const mtimeMs = Math.round(statSync(appPath).mtimeMs);
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return;
    recordMeasure({ key: BINARY_BUILT_AT_KEY, value: mtimeMs, unit: "count", budget: null, ok: true });
  } catch {
    /* no stat — the stamp is omitted, never faked */
  }
}

/** The build-provenance file `papercusp-desktop/bin/build-deb-repacked.sh` writes into
 *  the cargo profile dir (`<target>/<profile>/`) after a successful `tauri build`.
 *  Name fixed by plan desktop-perf-measure-candidate-build-2026-09-29 P-001. */
export const BUILD_IDENTITY_FILE = "build-provenance.json";

/** Slack for filesystem mtime granularity between the binary and the identity file
 *  written moments after it. Far below any real rebuild interval. */
const IDENTITY_MTIME_SLACK_MS = 2_000;

/**
 * The source sha of the build that produced the binary under test, or null
 * (desktop-perf-measure-candidate-build-2026-09-29 P-001 / D-001).
 *
 * `gitSha` names the tree the RUNNER came from; the release gate needs the tree the
 * BINARY came from, and nothing in the binary exposes that. So the build records it:
 * this walks up from the binary (a deb staging path `<profile>/bundle/deb/<pkg>/data/
 * usr/bin/<bin>` is six levels below `<profile>`; a raw `<profile>/<bin>` is one) to
 * the nearest `build-provenance.json`.
 *
 * The file is trusted ONLY when it is at least as new as the binary: an identity
 * written by an EARLIER scripted build, left beside a binary re-built afterwards by a
 * plain `tauri build`, would otherwise attribute the new binary to the old sha — the
 * exact misattribution D-001 exists to prevent. Never throws; every doubt is null,
 * which the gate reads as "unattributable", never as a guess.
 *
 * A DIRTY build (`"dirty": true` — built with uncommitted tracked edits) is null too
 * (P-002). Its binary is `buildSha` PLUS edits that land in LATER commits, which may be
 * in the judged candidate but not on the green pin; attributing it to `buildSha` would
 * let the gate call a regression those edits caused "pre-existing on main". Only a
 * clean build names its source exactly.
 */
export function readBuildIdentity(appPath: string, maxLevels = 7): string | null {
  let binaryMtimeMs: number;
  try {
    binaryMtimeMs = statSync(appPath).mtimeMs;
  } catch {
    return null;
  }
  let dir = path.dirname(appPath);
  for (let level = 0; level < maxLevels; level += 1) {
    const candidate = path.join(dir, BUILD_IDENTITY_FILE);
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).mtimeMs + IDENTITY_MTIME_SLACK_MS < binaryMtimeMs) return null;
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { buildSha?: unknown; dirty?: unknown };
        if (parsed.dirty === true) return null;
        const sha = typeof parsed.buildSha === "string" ? parsed.buildSha.trim().toLowerCase() : "";
        return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Keep the published workspace aligned with the workspace exercised by WDIO.
 * The ingest route already accepts workspaceId; omitting it stores a private
 * staging scenario under the operator host's unrelated default workspace. */
export function desktopPerfRunPayload(
  measures: readonly PerfMeasure[],
  gitSha: string | null,
  runId: string | null,
  env: NodeJS.ProcessEnv = process.env,
  buildSha: string | null = null,
) {
  const workspaceId = env.PAPERCUSP_PERF_WORKSPACE_ID?.trim();
  const namedProfile = runId?.trim() || null;
  return {
    measures,
    // A named packaged run can combine a frozen shell, copied SPA and live API
    // from different commits. The WDIO checkout HEAD is not that build. Keep
    // checkout correlation only for ordinary unnamed runs.
    gitSha: namedProfile ? null : gitSha,
    // The binary's own recorded identity is valid for named and unnamed runs alike:
    // it describes the artifact, not the checkout the runner happens to sit in.
    buildSha,
    runId: namedProfile,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/**
 * The operator this run talks to over plain HTTP — for publishing measures, and
 * for anything else that needs an origin the RUNNER can reach.
 *
 * Defaults to the green operator on :3070; override with `PAPERCUSP_OPERATOR_URL`
 * (e.g. `http://127.0.0.1:3170`) to target staging — necessary whenever a route is
 * newer than what :3070's release checkout serves.
 *
 * EXPORTED, rather than recomputed per caller, because the second caller is the
 * egress spec's sensor control, and a control pointed at a DIFFERENT default than
 * the publisher would fail in a way that reads as a broken sensor rather than a
 * misconfigured runner. One literal, one place.
 *
 * NORMALISED TO THE ORIGIN, and that is load-bearing rather than tidiness
 * (WI-38449). Callers append absolute paths like `/api/admin/testing/...`, so a
 * base carrying ANY path silently produces a doubled URL that 404s. This is not
 * hypothetical: `desktop-perf-scheduled-run.ts` spawns this suite with
 * `env: process.env`, i.e. the OPERATOR HOST's own environment, and that process
 * sets `PAPERCUSP_OPERATOR_URL` for its own unrelated purposes. On 2026-08-15 it
 * held `http://localhost:3070/api/mcp`, so every publish went to
 * `http://localhost:3070/api/mcp/api/admin/testing/desktop-perf-runs` and was
 * REJECTED (404) — for 13 days, while the tick logged "measures already posted
 * via onComplete regardless of exit code" and reported success. Result:
 * `harness_shared.desktop_perf_runs` took no rows and `DESKTOP_PERF_GATE`
 * fail-soft PASSED every deploy in that window while measuring nothing.
 *
 * Stripping the path is deliberately NOT silent. A value carrying a path means
 * this runner inherited an env var meant for something else, and the quiet fix
 * would leave that misconfiguration in place to surprise the next caller who
 * uses it for a purpose normalisation cannot rescue.
 */
export function operatorBaseUrl(): string {
  const raw = process.env.PAPERCUSP_OPERATOR_URL ?? "http://127.0.0.1:3070";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[perf-report] PAPERCUSP_OPERATOR_URL is not a URL (${JSON.stringify(raw)}) — ` +
        `falling back to http://127.0.0.1:3070`,
    );
    return "http://127.0.0.1:3070";
  }
  const extra = raw.slice(parsed.origin.length).replace(/\/$/, "");
  if (extra) {
    // eslint-disable-next-line no-console
    console.warn(
      `[perf-report] PAPERCUSP_OPERATOR_URL carries a path (${JSON.stringify(extra)}); using the ` +
        `ORIGIN ${parsed.origin} instead. Callers here append absolute /api/... paths, so the ` +
        `un-normalised value would 404 every publish. Whoever launched this run is passing an ` +
        `endpoint URL where an operator ORIGIN is expected — fix that too.`,
    );
  }
  return parsed.origin;
}

/**
 * Record one measured interaction.
 *
 * CALL THIS BEFORE THE BUDGET ASSERTS, NEVER AFTER. `expect(...)` throws on a
 * breach, so a call placed after the asserts records only PASSING measures — and
 * a breach is precisely the observation the release gate exists to catch. Recording
 * first means a failing run still posts its evidence and the gate can act on it.
 *
 * Never throws: a reporting failure must not turn a healthy perf run red. A write
 * that fails is logged and dropped (the run's log still carries the `[perf]` lines).
 */
export function recordMeasure(measure: PerfMeasure): void {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(MEASURES_PATH, `${JSON.stringify(measure)}\n`, "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[perf-report] could not record ${measure.key}:`, err);
  }
}

/**
 * Convenience wrapper for the common `ms`-against-a-budget case: derives `ok` and
 * emits the same `[perf]` log line the specs used to write by hand, so the run log
 * keeps reading identically.
 *
 * `value` is `number | null` because `latestMeasure()` returns null when the
 * interaction produced no `performance.measure` entry. A null is deliberately NOT
 * recorded: "the interaction never reported" is a suite/instrumentation failure
 * (the spec's own `expect(...).not.toBeNull()` catches it), not a slow interaction,
 * and inventing a 0ms or budget-breaching row would put a fabricated number into
 * the trend the gate reads.
 */
export function recordInteractionMs(
  name: string,
  value: number | null,
  budgetMs: number,
): void {
  // eslint-disable-next-line no-console
  console.log(`[perf] ${name} = ${value}ms (budget ${budgetMs}ms)`);
  if (value === null || !Number.isFinite(value)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[perf-report] ${name} produced no measure — not recorded (an absent measure is an instrumentation failure, not a timing)`,
    );
    return;
  }
  recordMeasure({
    key: `interaction:${name}`,
    value,
    unit: "ms",
    budget: budgetMs,
    ok: value <= budgetMs,
  });
}

/**
 * Record a binary CORRECTNESS INVARIANT — a property that must hold exactly, whose
 * breach blocks the release gate outright (no-http-anywhere-2026-07-28 P-003c).
 *
 * Use this instead of {@link recordMeasure} when the number is not a tunable
 * threshold but a count that must equal `mustEqual` (default 0): escaped HTTP
 * requests, unhandled console errors, leaked listeners. Do NOT use it for a timing
 * budget — those are load-sensitive, and blocking the fleet's deploys on a number
 * that moves with machine load is exactly what the gate's warn-only default exists
 * to prevent.
 *
 * Like `recordInteractionMs`, CALL THIS BEFORE THE ASSERTS. A breach is precisely
 * the observation the gate exists to act on, so it has to be recorded on the path
 * that is about to throw.
 */
export function recordInvariant(
  name: string,
  value: number,
  mustEqual = 0,
): void {
  const held = value === mustEqual;
  // eslint-disable-next-line no-console
  console.log(`[perf] invariant ${name} = ${value} (must be ${mustEqual})${held ? "" : " ← BREACH"}`);
  recordMeasure({
    key: `invariant:${name}`,
    value,
    unit: "count",
    budget: mustEqual,
    ok: held,
    invariant: true,
  });
}

/**
 * Record the HOST CPU PRESSURE this run is being taken under
 * (resource-efficiency-closeout-2026-08-13 D-005, step 1).
 *
 * WHY (D-003 → D-004 → D-005). A desktop timing measured while the host was
 * contended is not comparable to one measured on a quiet box, and for weeks this
 * suite published timings with NO record of which it was. That is how a 4466ms
 * LCP got written up as a regression: re-measured under a quiet window the same
 * code reads 2527–2803ms.
 *
 * WHY PSI AND NOT LOADAVG. /proc/loadavg is a trailing EWMA of runnable tasks,
 * not current contention — measured here at 56.92 while /proc/pressure/cpu
 * reported `some avg10=0.05` (i.e. no stall pressure at all). Worse than
 * useless: across six samples LCP was ANTI-correlated with loadavg (2143ms at
 * loadavg 99, 2803ms at loadavg 57). PSI `some avg10` is the live reading, so it
 * is the one recorded; loadavg is recorded ALONGSIDE it purely so a future
 * reader can see the two disagree rather than rediscovering it.
 *
 * These are stamps, not budgets: `budget: null` and `ok: true` unconditionally,
 * which the ingest route documents as "recorded, never a failure". A run taken
 * under load must NOT be reported as a budget breach — per D-005 an
 * uncontrolled sample is UNMEASURABLE, which is a different verdict from failing,
 * and conflating them is the defect this whole plan item exists to remove.
 *
 * Never throws: /proc/pressure/cpu is absent on non-Linux and on kernels built
 * without PSI, and a missing stamp must not fail a healthy perf run.
 */
export function recordHostPressure(phase: "start" | "end"): void {
  try {
    const psi = readFileSync("/proc/pressure/cpu", "utf8");
    // "some avg10=0.05 avg60=0.17 avg300=0.87 total=..." — one line per class.
    const read = (cls: "some" | "full"): number | null => {
      const line = psi.split("\n").find((l) => l.startsWith(cls));
      const m = line?.match(/avg10=([\d.]+)/);
      return m ? Number(m[1]) : null;
    };
    for (const cls of ["some", "full"] as const) {
      const value = read(cls);
      if (value === null || !Number.isFinite(value)) continue;
      recordMeasure({
        // Unit lives in the KEY, not the `unit` field — see PerfMeasureUnit.
        key: `host:psi-cpu-${cls}-avg10-pct:${phase}`,
        value,
        unit: "count",
        budget: null,
        ok: true,
      });
    }
  } catch {
    /* no PSI on this kernel — a missing stamp is not a failure */
  }
  try {
    // Recorded for CONTRAST only. Do not gate on this: see the note above.
    const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(/\s+/)[0]);
    if (Number.isFinite(load1)) {
      recordMeasure({
        key: `host:loadavg1-not-authoritative:${phase}`,
        value: load1,
        unit: "count",
        budget: null,
        ok: true,
      });
    }
  } catch {
    /* not Linux — skip */
  }
}

/**
 * Discard any measures on disk. Called from `onPrepare` so a file left behind by a
 * previously CRASHED run (one that died before `onComplete` could consume and clear
 * it) is never posted as if it were this run's data — that would report stale
 * timings against the current commit, which is worse than reporting none.
 */
export function resetMeasures(): void {
  try {
    rmSync(MEASURES_PATH, { force: true });
  } catch {
    /* nothing recorded yet, or already gone */
  }
}

/** Read every recorded measure, skipping any unparseable (partially-written) line. */
export function readMeasures(): PerfMeasure[] {
  if (!existsSync(MEASURES_PATH)) return [];
  const measures: PerfMeasure[] = [];
  for (const line of readFileSync(MEASURES_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      measures.push(JSON.parse(trimmed) as PerfMeasure);
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[perf-report] skipping unparseable measure line");
    }
  }
  return measures;
}
