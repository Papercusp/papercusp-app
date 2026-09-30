/**
 * WebdriverIO config for driving the packaged Papercusp Tauri binary
 * via tauri-driver (https://v2.tauri.app/develop/tests/webdriver/).
 *
 * Prereqs:
 *   1. cargo install tauri-driver          (✓ installed)
 *   2. sudo apt install webkit2gtk-driver  (Linux only — required for WebKitGTK WebDriver;
 *      preflight-checked in onPrepare below, so a missing install now fails fast with a
 *      clear message instead of a silent multi-minute session timeout — WI-5662)
 *   3. Build the desktop app:               pnpm --filter @papercusp/desktop build
 *   4. Set TAURI_APP_PATH below to the binary in the resulting bundle
 *
 * Then: pnpm --filter @papercusp/perf-test-wdio test
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  assertPrivateIpcFixture,
  assertPrivateIpcFixtureUnchanged,
  desktopPerfRunPayload,
  hasRunOutcomeMeasure,
  operatorBaseUrl,
  readMeasures,
  recordBinaryIdentity,
  readBuildIdentity,
  recordHostPressure,
  resetMeasures,
  type PrivateIpcFixture,
} from "./perf-report";
import { SPEC_TIMEOUT_MS } from "./app-mount";

/**
 * Allocate a free ephemeral TCP port from the OS: bind to :0, read back what
 * the kernel assigned, close immediately, return it. Two independent calls
 * are used below (driver port + native port) rather than one fixed value —
 * this box runs dozens of concurrent agent/e2e sessions, so any hardcoded
 * port is a collision waiting to happen (WI-5662 point 3).
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("getFreePort: could not resolve an ephemeral port")));
      }
    });
  });
}

/**
 * tauri-driver defaults `--native-port` (the port it spawns the OS-native
 * WebDriver on) to **4445** — see tauri-driver 2.0.6 `src/cli.rs`. This repo's
 * config used to pass only `--port 4445` (its OWN intermediary-server port)
 * and never set `--native-port`, so the native WebKitWebDriver's *default*
 * native-port (4445) collided with tauri-driver's own `--port` (also 4445,
 * since that's the very value this config chose). tauri-driver's own HTTP
 * server always wins the bind race, so WebKitWebDriver crashed on startup
 * with `FATAL: Unable to listen for HTTP server at host 127.0.0.1 and port
 * 4445` (its stderr, inherited through tauri-driver's stdio) and became a
 * zombie — leaving every `POST /session` to time out against a tauri-driver
 * that had no native driver behind it. 100% deterministic, unrelated to box
 * load. Root-caused + reproduced live 2026-07-20 (WI-5662): confirmed via
 * `tauri-driver --port 4445` alone (FATAL + defunct WebKitWebDriver) vs.
 * `tauri-driver --port 4445 --native-port 4444` (both bind cleanly). Fix:
 * always pass EXPLICIT, DISTINCT `--port`/`--native-port` values — ephemeral
 * ones, per the box-collision note above.
 */
function assertNativeWebDriverAvailable(): void {
  if (process.platform !== "linux") return; // macOS: safaridriver ships with the OS
  try {
    execFileSync("which", ["WebKitWebDriver"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "[wdio.conf.ts] WebKitWebDriver not found on PATH. tauri-driver needs it to drive " +
        "the WebKitGTK-backed Tauri webview on Linux. Install it with:\n\n" +
        "  sudo apt install webkit2gtk-driver\n\n" +
        "(desktop-performance-suite-2026-07-20 / WI-5662 — this used to fail as an opaque " +
        "5-minute session timeout instead of this preflight message.)"
    );
  }
}

/**
 * Ensure the Tauri app will have an X display, WITHOUT depending on an ambient one.
 *
 * WHY THIS EXISTS (perf-testing-sweep-2026-07-27, WI-6538):
 * `@wdio/xvfb` wraps each SPEC WORKER in `xvfb-run`, but the app process is not a
 * child of a worker — it is launched by tauri-driver, which `onPrepare` spawns in
 * the LAUNCHER process. So the app inherits the LAUNCHER's environment, and the
 * worker-level xvfb wrapper does nothing for it. With an ambient `DISPLAY` (an
 * interactive shell on this box has `:1`) that goes unnoticed; run the same command
 * from anywhere without one — a routine, a cron, CI, an operator-spawned job, i.e.
 * exactly the UNATTENDED scheduling this suite exists to enable — and the binary
 * dies on:
 *
 *   thread 'main' panicked at tao-0.35.0/.../event_loop.rs:217:
 *   Failed to initialize gtk backend!: Failed to initialize GTK
 *
 * That is an opaque Rust panic several layers below the test, and it reads as "the
 * desktop build is broken" rather than "there is no display", so it costs a real
 * diagnosis every time. Wrapping tauri-driver in `xvfb-run -a` (auto-pick a free
 * display) makes the runner self-sufficient: the driver, and therefore the app,
 * always has a display, and the suite becomes schedulable unattended.
 *
 * Returns the argv to spawn. Prefers an ambient DISPLAY when present so an
 * interactive/debug run still shows a real window.
 */
function driverCommand(args: readonly string[]): { file: string; argv: string[] } {
  if (process.env.DISPLAY) return { file: "tauri-driver", argv: [...args] };
  try {
    execFileSync("which", ["xvfb-run"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "[wdio.conf.ts] No DISPLAY is set and `xvfb-run` is not on PATH, so the Tauri " +
        "binary would panic with an opaque `Failed to initialize GTK` deep in tao. " +
        "Install it with:\n\n  sudo apt install xvfb\n\n" +
        "(or export DISPLAY=:N pointing at a running X server). " +
        "perf-testing-sweep-2026-07-27 / WI-6538 — this used to surface as a Rust " +
        "panic that read like a broken desktop build.",
    );
  }
  // -a: pick a free display number rather than colliding with the many `Xvfb :0`
  // instances other agents' e2e sessions keep alive on this box.
  return { file: "xvfb-run", argv: ["-a", "tauri-driver", ...args] };
}

/**
 * Resolve the packaged Tauri binary. `TAURI_APP_PATH` wins; otherwise try the
 * real build locations in preference order. NOTE: the desktop app is the
 * in-repo `papercusp-desktop` submodule (binary name `papercusp-desktop`) — the
 * old default here pointed at the retired `libs/papercusp/apps/desktop` path
 * with the wrong binary name, so a plain `npm test` never found the binary
 * (desktop-performance-suite-2026-07-20 P-008). RELEASE is strongly preferred:
 * a DEBUG build runs several-fold slower, so its interaction timings blow the
 * release-tuned budgets — use debug only for wiring/smoke, never budget asserts.
 */
/**
 * Where cargo ACTUALLY puts build artifacts.
 *
 * WHY NOT JUST `CARGO_TARGET_DIR` (perf-testing-sweep-2026-07-27, WI-6538): the env
 * var is only ONE of the ways the target dir gets redirected. On this box it is set
 * by a `target-dir` entry in the user-level `~/.cargo/config.toml`, which the env
 * var does not reflect — so the old resolver looked only in
 * `<repo>/papercusp-desktop/src-tauri/target/{release,debug}`, found no build there,
 * and silently fell back to a stale in-tree DEBUG binary from six weeks earlier.
 *
 * That is the most consequential bug in this file's history: the suite reported
 * timings for a six-week-old binary while appearing to measure current code, so its
 * numbers could not detect a regression in anything the binary predated. Silent,
 * because falling back to a real file looks exactly like success.
 *
 * `cargo metadata` is the authority — it accounts for the env var, config.toml, and
 * workspace layout in one answer. Memoized through the environment (the same trick
 * `resolveDriverPort` uses) so the forked spec workers do not each re-shell it.
 */
function cargoTargetDir(): string | null {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR;
  if (process.env.PAPERCUSP_RESOLVED_CARGO_TARGET_DIR) {
    return process.env.PAPERCUSP_RESOLVED_CARGO_TARGET_DIR;
  }
  try {
    const out = execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps"],
      {
        cwd: path.resolve(__dirname, "../../..", "papercusp-desktop", "src-tauri"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const dir = (JSON.parse(out) as { target_directory?: string }).target_directory;
    if (dir) {
      process.env.PAPERCUSP_RESOLVED_CARGO_TARGET_DIR = dir;
      return dir;
    }
  } catch {
    /* cargo unavailable / not a cargo project — fall back to the in-tree guesses */
  }
  return null;
}

/**
 * The installed-tree completeness guard, owned by the desktop app (it mirrors
 * that app's OWN boot-time requirement, so it must live and be tested next to
 * the Rust that enforces it — papercusp-desktop/test/installed-app-tree.test.js).
 * Imported by relative path because tools/perf-test/wdio is deliberately not an
 * npm workspace member; this suite already hard-depends on papercusp-desktop's
 * layout anyway (see cargoTargetDir, which shells `cargo metadata` in it).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installedAppTree = require(
  path.resolve(__dirname, "../../../papercusp-desktop/bin/lib/installed-app-tree.js"),
) as {
  inspectInstalledApp: (appPath: string) => {
    appPath: string;
    exists: boolean;
    sidecarDir: string;
    missing: string[];
    placeholder: boolean;
    complete: boolean;
  };
  describeIncompleteInstall: (report: { complete: boolean }) => string | null;
};

/**
 * Prefer a COMPLETE thin-GUI app tree, not merely an existing binary.
 *
 * WHY COMPLETENESS AND NOT JUST EXISTENCE (EI-18885442084466501). This function
 * used to return the first path that existed, and the first candidate it tried
 * was the bare `cargo build --release` output. A bare cargo binary has no
 * sibling `../lib/<productName>/` resource tree AT ALL, so its sidecar is
 * missing by construction — and the app's response to a missing sidecar is not
 * to die but to wait out a 120s operator-boot timeout and fall back to a foreign
 * environment. Every spec then failed on a 30s UI-mount wait that expired 90
 * seconds before the app had even chosen an environment.
 *
 * That is the SAME defect this file already documents for build freshness
 * (cargoTargetDir's note about the six-week-old debug binary): selecting a real
 * file looks exactly like success. Freshness and profile were both fixed then;
 * completeness is the third axis, and it is the one that decides whether the
 * measurement describes the shipping configuration or a fallback.
 *
 * Bundle paths therefore come FIRST — only a bundled tree can carry the SPA
 * resources that the attach-only GUI measures.
 */
function resolveTauriAppPath(): string {
  if (process.env.TAURI_APP_PATH) return process.env.TAURI_APP_PATH;
  const repoRoot = path.resolve(__dirname, "../../..");
  const cargoTarget = cargoTargetDir();
  const inTreeTarget = path.join(repoRoot, "papercusp-desktop", "src-tauri", "target");
  // A `tauri build` deb unpacks to <bundle>/deb/<name>_<ver>_<arch>/data/usr/bin/.
  const debBinaries = (target: string | null): string[] => {
    if (!target) return [];
    const debRoot = path.join(target, "release", "bundle", "deb");
    try {
      return readdirSync(debRoot)
        .map((entry) => path.join(debRoot, entry, "data", "usr", "bin", "papercusp-desktop"))
        .filter((candidate) => existsSync(candidate))
        // Newest bundle first — an older one alongside it is a stale artifact.
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    } catch {
      return []; // no bundle dir yet
    }
  };
  const candidates = [
    ...debBinaries(cargoTarget),
    ...debBinaries(inTreeTarget),
    cargoTarget && path.join(cargoTarget, "release", "papercusp-desktop"),
    path.join(inTreeTarget, "release", "papercusp-desktop"),
    cargoTarget && path.join(cargoTarget, "debug", "papercusp-desktop"),
    path.join(inTreeTarget, "debug", "papercusp-desktop"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const existing = candidates.filter((candidate) => existsSync(candidate));
  // A complete tree wins outright. Otherwise fall through to the first binary
  // that exists so the preflight below can name a REAL path in its diagnosis
  // (and finally to the canonical release path, so a "not built yet" failure
  // still names where the build was expected to land).
  const complete = existing.find((candidate) => installedAppTree.inspectInstalledApp(candidate).complete);
  return complete ?? existing[0] ?? candidates[0];
}

const TAURI_APP_PATH = resolveTauriAppPath();

/**
 * Refuse to measure a GUI artifact that cannot render its packaged shell.
 *
 * This is the detector that was missing (EI-18885442084466501). Without it the
 * suite spent 3m19s producing four identical `operator UI did not mount in 30s`
 * failures — a message that points at the UI, the webview, the wait value, and
 * the box's load, i.e. at everything EXCEPT the artifact, which was the actual
 * cause. Three plausible-but-wrong diagnoses are reachable from that message and
 * none of them is "one build step was skipped".
 *
 * It fails rather than warns, and it fails BEFORE tauri-driver is spawned, for
 * two reasons:
 *
 * 1. There is no useful degraded mode. The thin GUI deliberately does not own
 *    the operator sidecar; it must contain the packaged SPA and attach to the
 *    separately-running Server. Measuring a package without that SPA describes
 *    neither shipping product.
 * 2. A hard stop here is what lets the mount wait be generous. Once the
 *    structural failure is caught in ~1ms, a long UI-mount timeout only ever
 *    costs time on a genuinely slow boot, never on a broken build.
 */
function assertInstallationComplete(): void {
  const report = installedAppTree.inspectInstalledApp(TAURI_APP_PATH);
  if (!report.exists) {
    throw new Error(
      `[wdio.conf.ts] no papercusp-desktop binary at ${TAURI_APP_PATH}. Build one first:\n\n` +
        `  cd papercusp-desktop && bash bin/build-desktop-sidecar.sh && npm run build\n`,
    );
  }
  const problem = installedAppTree.describeIncompleteInstall(report);
  if (problem) throw new Error(`[wdio.conf.ts] refusing to measure an unbootable app.\n\n${problem}`);
}

let tauriDriver: ChildProcess | null = null;

/**
 * Reap the WHOLE driver subtree, not just the process we spawned (EI-18886600444441200).
 *
 * WHY THIS IS NOT `tauriDriver.kill()`: driverCommand deliberately wraps the driver
 * as `xvfb-run -a tauri-driver ...` (WI-6538, so the app inherits a display), so the
 * pid we hold is the **xvfb-run wrapper shell**. SIGTERMing that shell does not
 * forward the signal to tauri-driver, does not reap the WebKitWebDriver tauri-driver
 * spawned, and does not stop the Xvfb that xvfb-run started. Every run therefore
 * stranded three processes, each holding a display number. It went unnoticed for so
 * long because the ports are ephemeral per run, so nothing ever collided — the leak
 * is invisible until you count processes. Measured 2026-08-01 on this box: 20 orphan
 * Xvfb and 8 orphan tauri-driver/WebKitWebDriver pairs, at load ~43.
 *
 * So `onPrepare` spawns DETACHED purely to make the child a process-group leader,
 * and teardown signals the negative pid (the whole group): SIGTERM, a short grace
 * period, then SIGKILL for anything still standing. Detached here means "give me a
 * killable group", the opposite of "let this outlive the run" — the group never
 * survives the process that made it.
 *
 * NOTE the repo rule this respects: never `pkill -f` by name. That has twice killed
 * the owner's live desktop window and peers' Xvfb instances, and this box always has
 * other agents' Xvfb/WebKitWebDriver processes running. Group-scoped signals can only
 * ever reach processes THIS run started.
 */
function reapDriverTree(): void {
  const pid = tauriDriver?.pid;
  tauriDriver = null;
  if (!pid) return;
  // Returns false on ESRCH — "the group is already gone", which is the goal state
  // here, not an error. Signal 0 sends nothing and is purely a liveness probe.
  const signalGroup = (sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  // Sleep SYNCHRONOUSLY, not via await: this same reaper runs from the `exit`
  // handler below, where the event loop no longer turns and a promise would never
  // resolve. Atomics.wait on a throwaway buffer is the standard sync-sleep idiom
  // (no subprocess, unlike shelling out to `sleep`).
  const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    sleepSync(100);
    if (!signalGroup(0)) return; // whole group exited on the SIGTERM
  }
  // Something ignored SIGTERM (xvfb-run's shell is a repeat offender) — escalate.
  signalGroup("SIGKILL");
}

/**
 * A run that DIES does not reach onComplete — and an interrupted run is exactly how
 * these orphans accumulated (a Ctrl-C, a harness timeout, a spec-worker crash all
 * skip the normal teardown). Reaping only on the happy path would leave the leak
 * armed for every unhappy one, so bind the same reaper to process death too.
 */
let reaperBound = false;
function bindDriverReaper(): void {
  if (reaperBound) return;
  reaperBound = true;
  process.on("exit", reapDriverTree);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      reapDriverTree();
      process.exit(1);
    });
  }
}

/**
 * POST this run's measures to the operator so they land in
 * `harness_shared.desktop_perf_runs` — the table the desktop-perf RELEASE GATE
 * reads (perf-testing-sweep-2026-07-27, WI-6538 / WI-6535).
 *
 * Until this existed the runner measured real interactions and discarded them, the
 * table stayed empty from 2026-07-20 onward, and `desktopPerfGate` took its
 * fail-soft "no fresh run" branch on EVERY deploy — a perf gate that had never
 * measured anything. Publishing here is what makes the gate capable of firing.
 *
 * NEVER FAILS THE RUN: a publish problem (operator down, no token, stale build
 * without the ingest route) is logged loudly and swallowed. The perf assertions
 * already passed or failed on their own merits in the workers; turning a healthy
 * run red because a side-channel POST failed would be a worse defect than the one
 * this fixes. The log line is deliberately explicit about WHY, because a silent
 * no-op here is exactly how the original starvation went unnoticed for 8 days.
 */
/**
 * True when the binary under test is a DEBUG build.
 *
 * A debug build runs several-fold slower than release (this file's
 * `resolveTauriAppPath` already warns that its timings blow the release-tuned
 * budgets), so a debug timing is not a release datapoint — it is noise wearing the
 * same shape as signal. Publishing one poisons the trend the release gate reads and
 * produces a permanent false "desktop interaction REGRESSED" warning, which is
 * worse than no data: a gate that cries wolf every deploy trains everyone to ignore
 * it, and then a REAL regression lands unnoticed.
 *
 * Measured on this box for scale: the same command-palette-open interaction is
 * ~346ms on release and ~857ms on debug against a 400ms budget — the build profile
 * alone flips the verdict.
 */
function isDebugBinary(): boolean {
  return /(^|\/)debug\//.test(TAURI_APP_PATH);
}

let initialPrivateIpcFixture: PrivateIpcFixture | null = null;

async function publishMeasures(): Promise<void> {
  const measures = readMeasures();
  if (!hasRunOutcomeMeasure(measures)) {
    // onComplete runs even when onPrepare or session creation failed. Host stamps
    // from that path are context, not proof that one spec measured anything.
    // Clear them so a later crash cannot inherit and publish this false run.
    // eslint-disable-next-line no-console
    console.warn(
      `[perf-report] NOTHING TO PUBLISH — ${measures.length} host-context measure(s) ` +
        `were recorded, but no spec produced a timing or invariant outcome.`,
    );
    resetMeasures();
    return;
  }
  // Refuse debug-build numbers by DEFAULT (override only for deliberately testing
  // the ingest path itself). The run's own [perf] log lines still show the timings.
  if (isDebugBinary() && process.env.PAPERCUSP_PERF_PUBLISH_DEBUG !== "1") {
    // eslint-disable-next-line no-console
    console.warn(
      `[perf-report] NOT publishing ${measures.length} measure(s): the binary under test is a ` +
        `DEBUG build (${TAURI_APP_PATH}). Debug timings are several-fold slower than release and ` +
        `would register as a false regression in the desktop-perf gate. Build release ` +
        `(cargo build --release) for gate-feeding numbers, or set ` +
        `PAPERCUSP_PERF_PUBLISH_DEBUG=1 to publish anyway when testing the ingest path.`,
    );
    return;
  }
  if (measures.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[perf-report] NOTHING TO PUBLISH — no measures were recorded, so no run row " +
        "will exist and the desktop-perf gate stays starved. Check that the specs " +
        "actually reached their recordInteractionMs calls.",
    );
    return;
  }

  // A named Linux fixture can be valid at preflight and lose its target while
  // WebDriver is measuring. Do not publish a receipt spanning two API processes.
  // Compare the live PID and socket identity with the preflight snapshot before
  // the POST; a restart makes the recorded build profile unmeasurable.
  if (process.env.PAPERCUSP_PERF_RUN_ID?.trim()) {
    try {
      assertPrivateIpcFixtureUnchanged(initialPrivateIpcFixture);
    } catch (error) {
      resetMeasures();
      throw new Error(
        `[perf-report] UNMEASURABLE named native run: ${String(error)}`,
      );
    }
  }

  // The ingest route requires a trusted bearer; the superuser token is the local
  // operator credential (resolves to trust:'trusted' — packages/agent-mcp/src/auth.ts).
  const tokenPath = path.join(os.homedir(), ".papercusp", "superuser-token");
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    // eslint-disable-next-line no-console
    console.error(
      `[perf-report] cannot publish ${measures.length} measure(s): no readable token at ${tokenPath}`,
    );
    return;
  }

  // Shared with the egress spec's sensor control — see operatorBaseUrl().
  const base = operatorBaseUrl();
  const url = `${base}/api/admin/testing/desktop-perf-runs`;

  // Best-effort commit correlation so a recorded run is attributable to code.
  let gitSha: string | null = null;
  try {
    gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
    }).trim();
  } catch {
    /* not a git checkout, or git unavailable — the row is still worth recording */
  }

  const failing = measures.filter((m) => !m.ok);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(
        desktopPerfRunPayload(
          measures,
          gitSha,
          process.env.PAPERCUSP_PERF_RUN_ID ?? null,
          process.env,
          readBuildIdentity(TAURI_APP_PATH),
        ),
      ),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(
        `[perf-report] publish REJECTED (${res.status}) by ${url}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
      );
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[perf-report] published ${measures.length} measure(s) to ${url} ` +
        `(${failing.length} over budget): ${JSON.stringify(await res.json().catch(() => ({})))}`,
    );
    // Only clear once the operator has durably accepted them — a failed publish
    // leaves the file so the next run's onPrepare reset is the deliberate discard.
    resetMeasures();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[perf-report] publish FAILED to ${url}:`, err);
  }
}

/**
 * The port workers actually connect on. wdio's `local` runner FORKS a
 * SEPARATE child process per spec file — `onPrepare` below runs only in the
 * launcher process, so mutating the exported `config` object from inside it
 * is invisible to worker processes (different process, different memory; a
 * first attempt at this fix did exactly that and every worker still hit the
 * stale port). What DOES reach workers: `@wdio/local-runner` reads
 * `process.env` fresh at fork time (after `onPrepare` resolves) and passes it
 * to each worker, and each worker re-imports this config file fresh in its
 * own process. So the real (ephemeral, collision-free) port is decided ONCE
 * in `onPrepare`, stashed in `process.env.TAURI_DRIVER_PORT` there, and read
 * back here at module scope — which runs once per process: the launcher's
 * own first import gets the (unused) placeholder below, and each worker's
 * import — happening after the launcher set the env var — gets the real one.
 */
function resolveDriverPort(): number {
  const fromEnv = process.env.TAURI_DRIVER_PORT;
  return fromEnv ? Number(fromEnv) : 4445; // placeholder; see doc comment above
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "wry",
      // @wdio/protocols ≥9 auto-injects `webSocketUrl: true` (opting into
      // WebDriver BiDi) for any capability whose browserName isn't "safari"
      // — see webdriver/build/node.js's newSession assembly. WebKitWebDriver
      // does not implement BiDi, so it flatly rejects that injected
      // capability with "Failed to match capabilities" — a session-creation
      // failure that only became visible once the port-binding bug above was
      // fixed (confirmed live via a raw curl POST /session repro, WI-5662).
      // This opts back out to classic (non-BiDi) WebDriver, which
      // WebKitWebDriver does support.
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application: TAURI_APP_PATH },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  // DERIVED, never a literal. A hardcoded 60_000 here sat under a 180_000 mount
  // wait for every run this suite has ever done, so mocha killed each spec two
  // minutes before the mount wait could expire and `mountTimeoutDiagnosis` never
  // ran once — all four specs failed with a bare `Error: Timeout` carrying no
  // information. See SPEC_TIMEOUT_MS's doc comment in app-mount.ts.
  mochaOpts: { ui: "bdd", timeout: SPEC_TIMEOUT_MS },

  // Preflight-check the native driver, allocate two DISTINCT ephemeral ports
  // (see assertNativeWebDriverAvailable's doc comment for why they must
  // differ), spawn tauri-driver, and publish the chosen port via env (see
  // resolveDriverPort's doc comment for why that — not mutating `config`
  // in-place — is what actually reaches worker processes).
  async onPrepare() {
    // Reset FIRST. WDIO still calls onComplete when a later preflight throws; if
    // stale measures survive until then, its host-pressure stamp can make an old
    // crashed run look like a fresh green one.
    resetMeasures();
    initialPrivateIpcFixture = null;
    assertNativeWebDriverAvailable();
    assertInstallationComplete();
    initialPrivateIpcFixture = assertPrivateIpcFixture();
    // Announce WHAT is being measured, with its age. This is the detector that was
    // missing: the resolver silently fell back to a six-week-old in-tree debug
    // binary for this suite's entire existence (see cargoTargetDir), and nothing in
    // the output ever named the file, so every number looked like it described
    // current code. A perf result is meaningless without knowing which build it
    // came from — so print it, loudly, before any measuring happens.
    try {
      const ageMs = Date.now() - statSync(TAURI_APP_PATH).mtimeMs;
      const ageHrs = Math.round(ageMs / 3_600_000);
      const profile = isDebugBinary() ? "DEBUG" : "release";
      // eslint-disable-next-line no-console
      console.log(
        `[perf-report] measuring ${profile} binary ${TAURI_APP_PATH} (built ${ageHrs}h ago)`,
      );
      if (ageMs > 24 * 60 * 60 * 1000) {
        // eslint-disable-next-line no-console
        console.warn(
          `[perf-report] ⚠ that binary is ${Math.floor(ageHrs / 24)} DAY(S) OLD — these timings ` +
            `describe the code as of that build, NOT your working tree. Rebuild ` +
            `(cargo build --release) before treating any result as a regression signal.`,
        );
      }
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[perf-report] could not stat the app binary at ${TAURI_APP_PATH}`);
    }
    // Stamp WHICH build is being measured (WI-10003815): the release gate needs it to
    // tell a candidate's regression from a stale binary's. After resetMeasures, same
    // as the pressure stamp below.
    recordBinaryIdentity(TAURI_APP_PATH);
    // Stamp the host pressure this run STARTS under (D-005). Must come AFTER
    // resetMeasures, or the reset would wipe the stamp it just wrote.
    recordHostPressure("start");
    const driverPort = process.env.TAURI_DRIVER_PORT
      ? Number(process.env.TAURI_DRIVER_PORT)
      : await getFreePort();
    let nativePort = process.env.TAURI_DRIVER_NATIVE_PORT
      ? Number(process.env.TAURI_DRIVER_NATIVE_PORT)
      : await getFreePort();
    while (nativePort === driverPort) nativePort = await getFreePort();

    process.env.TAURI_DRIVER_PORT = String(driverPort);
    // See driverCommand: the app inherits THIS process's environment, so the display
    // must be arranged here — the worker-level @wdio/xvfb wrapper never reaches it.
    const { file, argv } = driverCommand([
      "--port",
      String(driverPort),
      "--native-port",
      String(nativePort),
    ]);
    // detached: makes the child a process-GROUP leader so teardown can reap the
    // whole xvfb-run -> tauri-driver -> {WebKitWebDriver, Xvfb} tree rather than
    // just the wrapper shell. See reapDriverTree (EI-18886600444441200).
    tauriDriver = spawn(file, argv, {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    bindDriverReaper();
  },
  // Publish BEFORE killing the driver so a publish hang can't leave tauri-driver
  // orphaned; the kill is in a finally for the same reason.
  async onComplete() {
    try {
      // Stamp the END pressure before publishing, so the published run carries
      // both ends of the window it was measured in — a run that STARTED quiet
      // and ended contended is not a quiet sample.
      recordHostPressure("end");
      await publishMeasures();
    } finally {
      reapDriverTree();
    }
  },

  hostname: "127.0.0.1",
  port: resolveDriverPort(),
};
