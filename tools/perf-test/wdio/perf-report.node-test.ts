import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import type { Browser } from "webdriverio";

import { assertPrivateIpcFixture, assertPrivateIpcFixtureUnchanged, BINARY_BUILT_AT_KEY, BUILD_IDENTITY_FILE, CONTEXT_STAMP_PREFIXES, desktopPerfRunPayload, hasRunOutcomeMeasure, readBuildIdentity, type PerfMeasure } from "./perf-report";
import {
  isTerminalWebDriverSessionError,
  waitForPackagedAppUrl,
  waitUntilOrFailOnTerminalSession,
} from "./app-mount";

function retryingBrowser(): Browser {
  return {
    async waitUntil(condition: () => boolean | Promise<boolean>) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          if (await condition()) return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("fake waitUntil timed out");
    },
  } as unknown as Browser;
}

test("terminal WebDriver session failures are recognized from protocol messages", () => {
  assert.equal(isTerminalWebDriverSessionError(new Error("WebDriverError: invalid session id")), true);
  assert.equal(isTerminalWebDriverSessionError({ error: "pagecrashorhang" }), true);
  assert.equal(isTerminalWebDriverSessionError({ cause: new Error("session terminated without reply") }), true);
  assert.equal(isTerminalWebDriverSessionError(new Error("temporary connection reset")), false);
});

test("a terminal session error ends a WDIO wait on its first failed probe", async () => {
  let probes = 0;
  const browser = retryingBrowser();

  await assert.rejects(
    waitUntilOrFailOnTerminalSession(browser, () => {
      probes += 1;
      throw new Error("WebDriverError: invalid session id");
    }, { timeout: 180_000, interval: 500 }),
    /invalid session id/i,
  );
  assert.equal(probes, 1);
});

test("ordinary transient wait errors still retry until the condition succeeds", async () => {
  let probes = 0;

  await waitUntilOrFailOnTerminalSession(retryingBrowser(), () => {
    probes += 1;
    if (probes === 1) throw new Error("temporary connection reset");
    return true;
  });
  assert.equal(probes, 2);
});

test("workspace navigation waits past about:blank for the packaged app origin", async () => {
  const urls = ["about:blank", "about:blank?ws=papercusp-workspace", "papercusp://localhost/adv"];
  let reads = 0;
  const browser = Object.assign(retryingBrowser(), {
    async getUrl() { reads += 1; return urls.shift() ?? "papercusp://localhost/adv"; },
  });

  assert.equal(await waitForPackagedAppUrl(browser), "papercusp://localhost/adv");
  assert.equal(reads, 3);
});

test('private IPC fixture rejects a stale default even with a fresh per-port record', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-ipc-preflight-'));
  const socketPath = path.join(dir, 'operator.sock');
  const replacementSocketPath = path.join(dir, 'replacement.sock');
  const server = createServer();
  const replacementServer = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await new Promise<void>((resolve, reject) => { replacementServer.once('error', reject); replacementServer.listen(replacementSocketPath, resolve); });
  try {
    const live = { pid: process.pid, port: 3170, socketPath };
    const env = { PAPERCUSP_HOME: dir, PAPERCUSP_DEV_API_TARGET: "3170" };
    writeFileSync(
      path.join(dir, "endpoint-ipc.3170.json"),
      JSON.stringify(live),
    );
    writeFileSync(
      path.join(dir, "endpoint-ipc.json"),
      JSON.stringify({ ...live, socketPath: path.join(dir, "gone.sock") }),
    );
    assert.throws(
      () => assertPrivateIpcFixture(env, "linux"),
      /Invalid private native IPC fixture/,
    );
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify(live));
    assert.doesNotThrow(() => assertPrivateIpcFixture(env, "linux"));
    const preflight = assertPrivateIpcFixture(env, "linux");
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify({ ...live, socketPath: replacementSocketPath }));
    assert.doesNotThrow(() => assertPrivateIpcFixture(env, "linux"));
    assert.throws(() => assertPrivateIpcFixtureUnchanged(preflight, env, "linux"), /changed during the measured run/);
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify(live));
    assert.doesNotThrow(() => assertPrivateIpcFixtureUnchanged(preflight, env, "linux"));
    // A named run must not silently skip this guard when the target was omitted.
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          {
            PAPERCUSP_HOME: dir,
            PAPERCUSP_PERF_RUN_ID: "named-profile",
          },
          "linux",
        ),
      /PAPERCUSP_DEV_API_TARGET/,
    );
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          {
            ...env,
            PAPERCUSP_DEV_API_TARGET: "invalid",
          },
          "linux",
        ),
      /Invalid PAPERCUSP_DEV_API_TARGET/,
    );
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          { ...env, PAPERCUSP_DEV_API_TARGET: "3070" },
          "linux",
        ),
      /mismatched/,
    );
    writeFileSync(
      path.join(dir, "endpoint-ipc.json"),
      JSON.stringify({ ...live, pid: 2147483647 }),
    );
    assert.throws(
      () => assertPrivateIpcFixture(env, "linux"),
      /Invalid private native IPC fixture/,
    );
    assert.doesNotThrow(() => assertPrivateIpcFixture({}, "linux"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

const host = (key: string): PerfMeasure => ({
  key,
  value: 0.1,
  unit: "count",
  budget: null,
  ok: true,
});

test("host-pressure context alone is not a publishable perf run", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    host("host:loadavg1-not-authoritative:end"),
  ]), false);
});

test("a timing or invariant makes the surrounding host context publishable", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: "interaction:command-palette-open", value: 250, unit: "ms", budget: 400, ok: true },
  ]), true);
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: "invariant:webview-http-egress", value: 0, unit: "count", budget: 0, ok: true, invariant: true },
  ]), true);
});

test("desktop perf receipts retain the measured workspace across the WDIO publisher boundary", () => {
  const measures = [{ key: "interaction:plan-popup-open", value: 1010, unit: "ms", budget: 1500, ok: true }] as const;
  assert.deepEqual(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {
    PAPERCUSP_PERF_WORKSPACE_ID: " papercusp-workspace ",
  }), {
    measures,
    gitSha: null,
    buildSha: null,
    runId: "named-profile",
    workspaceId: "papercusp-workspace",
  });
  assert.deepEqual(desktopPerfRunPayload(measures, "checkout-sha", null, {}), {
    measures,
    gitSha: "checkout-sha",
    buildSha: null,
    runId: null,
  });
  assert.equal("workspaceId" in desktopPerfRunPayload(measures, null, null, {}), false);
});

test("the binary's recorded build identity rides on named and unnamed runs alike", () => {
  const measures = [{ key: "interaction:plan-popup-open", value: 1010, unit: "ms", budget: 1500, ok: true }] as const;
  // A named profile drops the checkout sha (it is not the build) but keeps the
  // binary's own identity, which describes the artifact actually measured.
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {}, "4223f93417df").buildSha, "4223f93417df");
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {}, "4223f93417df").gitSha, null);
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", null, {}, "4223f93417df").buildSha, "4223f93417df");
});

test("readBuildIdentity finds the profile-dir identity above a deb staging binary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "bundle", "deb", "pkg_0.0.1_amd64", "data", "usr", "bin", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), JSON.stringify({ buildSha: "4223F93417DF132EEC90ACE218A6017F5A97B8B3" }));
    assert.equal(readBuildIdentity(bin), "4223f93417df132eec90ace218a6017f5a97b8b3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity refuses an identity OLDER than the binary (rebuilt after the scripted build)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    const identity = path.join(root, "release", BUILD_IDENTITY_FILE);
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df" }));
    const past = new Date(Date.now() - 60_000);
    utimesSync(identity, past, past);
    writeFileSync(bin, "rebuilt later by a plain tauri build");
    assert.equal(readBuildIdentity(bin), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity refuses a DIRTY build — its binary is not exactly the recorded sha (P-002)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    const identity = path.join(root, "release", BUILD_IDENTITY_FILE);
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df", dirty: true }));
    assert.equal(readBuildIdentity(bin), null);
    // CONTROL: the same file recorded clean is trusted.
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df", dirty: false }));
    assert.equal(readBuildIdentity(bin), "4223f93417df");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity returns null for a missing binary, missing file, or malformed sha", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    assert.equal(readBuildIdentity(path.join(root, "absent")), null);
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    assert.equal(readBuildIdentity(bin, 2), null);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), JSON.stringify({ buildSha: "not-a-sha" }));
    assert.equal(readBuildIdentity(bin), null);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), "{ truncated");
    assert.equal(readBuildIdentity(bin), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner resets stale measures before any preflight can throw", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const onPrepare = config.slice(config.indexOf("async onPrepare()"), config.indexOf("async onComplete()"));
  const reset = onPrepare.indexOf("resetMeasures();");
  assert(reset >= 0);
  assert(reset < onPrepare.indexOf("assertNativeWebDriverAvailable();"));
  assert(reset < onPrepare.indexOf("assertInstallationComplete();"));
});

test("named native publishing checks fixture continuity before sending a receipt", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const publish = config.slice(
    config.indexOf("async function publishMeasures()"),
    config.indexOf("function resolveDriverPort"),
  );
  assert(publish.includes("assertPrivateIpcFixtureUnchanged(initialPrivateIpcFixture);"));
  assert(
    publish.indexOf("assertPrivateIpcFixtureUnchanged(initialPrivateIpcFixture);") <
      publish.indexOf("await fetch(url"),
  );
});

test("a build: stamp is context, not an outcome (WI-10003815)", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: BINARY_BUILT_AT_KEY, value: 1_789_600_000_000, unit: "count", budget: null, ok: true },
  ]), false);
});

test("the runner's stamp literals match the gate's canonical constants", () => {
  // The runner cannot import operator-core, so it carries copies; a drifted key would
  // silently disable the release gate's stale-build check.
  const shared = readFileSync(
    path.resolve(__dirname, "../../..", "packages/operator-core/lib/admin-test-suites-shared.ts"),
    "utf8",
  );
  assert(shared.includes(`DESKTOP_PERF_BINARY_BUILT_AT_KEY = '${BINARY_BUILT_AT_KEY}'`));
  const prefixes = CONTEXT_STAMP_PREFIXES.map((p) => `'${p}'`).join(", ");
  assert(shared.includes(`DESKTOP_PERF_CONTEXT_STAMP_PREFIXES = [${prefixes}] as const`));
});

test("the runner stamps the binary under test before any spec can measure", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const onPrepare = config.slice(config.indexOf("async onPrepare()"), config.indexOf("async onComplete()"));
  const stamp = onPrepare.indexOf("recordBinaryIdentity(TAURI_APP_PATH);");
  assert(stamp >= 0, "onPrepare must record the measured binary's build time");
  assert(stamp > onPrepare.indexOf("resetMeasures();"), "a stamp written before the reset is wiped");
});

test("the root perf command preserves WDIO failures through tee", () => {
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["perf:desktop"], /bash -o pipefail/);
});

test("the gate-selected `test` script is headless; the full GUI run is `test:all` (WI-10003821)", () => {
  // The green gate runs this package's `test` on every change here (STANDALONE_PACKAGE_DIRS in
  // scripts/affected-tests.mjs), and a gate box cannot boot the packaged desktop binary. So `test`
  // must never reach WDIO, and every caller that wants measures must name `test:all`.
  const own = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(own.scripts.test, /test:wdio|wdio run/, "`test` must stay headless");
  assert.match(own.scripts.test, /test:unit/, "`test` must still run the runner guards");
  assert.match(own.scripts["test:all"], /npm run test:wdio/, "`test:all` must run the specs");
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["perf:desktop"], /npm run test:all\b/);
});
