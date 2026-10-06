/**
 * `papercusp serve` — headless operator boot (SP1 C1 + C3).
 *
 * Plan: operator-core-headless-serve-2026-06-04.
 *
 * This is the standalone, UI-less entry point for the operator core. Unlike
 * `hono-host.ts` (which assumes Postgres is already up and always serves the
 * SPA), `serve.ts` OWNS the whole headless lifecycle:
 *
 *   1. Start embedded Postgres in-process (`startEmbeddedPostgresServer`),
 *      applying migrations via the package's own runner (pass `dbSqlDir`).
 *   2. Resolve the admin URL into `HARNESS_ADMIN_DATABASE_URL` *before* any
 *      operator module reads it (getHarnessAdminUrl caches first-call).
 *   3. Write `~/.papercusp/embedded-pg.json` (the latent-bug fix: nothing
 *      wrote it before — see the plan's "Latent bug" note).
 *   4. `runBootstrap()` (background services) then `serve()` the Hono host
 *      with `PAPERCUSP_SERVE_UI=0` so NO SPA is mounted (Decision E).
 *   5. Write `~/.papercusp/operator.json` ({httpUrl,port,token,pid,...}) —
 *      the discovery file the SP3 plugin's headersHelper will read.
 *
 * Singleton (Decision C): `serve --ensure` reuses a healthy running operator
 * (pid alive + http reachable) and exits 0; otherwise an O_EXCL pidfile lock
 * (`~/.papercusp/operator.lock`) guards the cold-start race. The DB-backed
 * named resource locks can't guard cold start (they need the DB up), hence an
 * OS-level lock here.
 *
 * Run:  tsx apps/operator/bin/serve.ts [--ensure] [--ui]
 *
 * Env knobs (all optional):
 *   PAPERCUSP_HONO_PORT / PORT    HTTP port (default 3070)
 *   PAPERCUSP_BIND_HOST           bind host (default 127.0.0.1; HOSTNAME is ignored)
 *   PAPERCUSP_PG_PORT             embedded-pg port (default 5532)
 *   PAPERCUSP_PG_DATA_DIR         embedded-pg data dir (default ~/.papercusp/embedded-pg-data)
 *   PAPERCUSP_PG_SQL_DIR          migrations dir (default: repo libs/papercusp/libs/db/sql)
 *   PAPERCUSP_USE_EMBEDDED_PG=0   attach external PG via HARNESS_*_DATABASE_URL instead
 *   PAPERCUSP_SERVE_UI=1          force the SPA on even under serve (default off here)
 *   PAPERCUSP_DISTRIBUTION_PROFILE=hosted-control-plane
 *                                 start only the hosted API allowlist + same-origin SPA
 */
// Cap glibc malloc arenas by re-executing in place when the launcher did not
// (boot-malloc-arena.ts). It reads no flags, so boot-flag-store below is still the
// first module that can observe one.
import "./boot-malloc-arena";
// MUST remain the first flag-reading import. Projection/background modules can resolve
// flags during ESM evaluation, before main() runs; without this side effect the
// packaged/headless serve process logs "No override store installed" and
// silently serves dark defaults even after flags:set wrote a runtime override.
import "./boot-flag-store";

import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  connect as netConnect,
} from "node:net";
import { dirname, join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  chmod,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isRequestOnlyIdentityProcess } from "@papercusp/operator-core/lib/identity/keychain";
import { ensureToolPathEnv } from "@papercusp/operator-core/lib/tool-path";
import { resolveBindHost } from "@papercusp/operator-core/lib/resolve-bind-host";
import { assertRemoteAuthReady } from "@papercusp/operator-core/lib/remote-auth-policy";
import { runShutdownWithDeadline } from "../lib/shutdown-deadline";
import { getBuildInfo } from "@papercusp/operator-core/lib/build-info";
import { readProcessIdentity } from "@papercusp/operator-core/lib/process-identity";
import { pidAlive, startParentDeathWatch, startSidecarParentDeathWatch } from "@papercusp/operator-core/lib/process-supervision/parent-death-watch";
export { pidAlive, isOrphanedFromParent, resolveExpectedParentPid, startParentDeathWatch, startSidecarParentDeathWatch } from "@papercusp/operator-core/lib/process-supervision/parent-death-watch";
import { installTimestampedConsole } from "@papercusp/operator-core/lib/timestamped-console";
import { installStdioPeerGuard } from "@papercusp/operator-core/lib/process-supervision/stdio-peer-guard";
import {
  assertVmReleaseRuntimePolicy,
  assertVmReleaseRuntimePort,
  isVmReleaseDistribution,
} from "@papercusp/operator-core/lib/vm-release-runtime-policy";
import { portAvailable } from "@papercusp/operator-core/lib/port-availability";

export { portAvailable } from "@papercusp/operator-core/lib/port-availability";

// WI-5778 (P-422): install as the very first statement below the imports —
// before ANYTHING else in this file has a chance to console.log/warn/error —
// so as close to every line of the process's own output as possible carries
// a timestamp. This is the ONE choke point every frame's serve.log flows
// through (serve.mjs is esbuild-bundled from this file — see
// build-desktop-sidecar.sh — and every rig script redirects its stdout/
// stderr straight to `$H/serve.log`), so fixing it here fixes it for every
// rig at once instead of patching N shell redirects.
installTimestampedConsole();

// WI-39599: install immediately after the console is wired and BEFORE the
// process-level fault handlers below — those handlers report by writing to
// stderr, so once our stdio peer dies (the operator that spawned us is
// SIGKILLed and both pipe read ends close) their own diagnostic write raises
// EPIPE, re-enters them, and the pair becomes a self-sustaining loop that burns
// a full core for as long as the orphan lives. Absorbing the stream error here
// means a broken pipe never becomes an uncaughtException, so the amplification
// cannot start. See stdio-peer-guard.ts for the measurement.
const stdioPeerGuard = installStdioPeerGuard();

// The three sidecar entrypoints (substrate / spawner / inference-gateway) are
// imported DYNAMICALLY inside main(), never here — same as host-bootstrap,
// host-handler and embedded-pg below. Each is reachable only from its own
// mutually-exclusive PAPERCUSP_*_SIDECAR_MODE branch, and each drags in a heavy
// graph the other paths never touch: the hypercore/holepunch substrate host,
// DBOS (which registers workflows at module-eval), and the gateway service.
// Statically importing them made EVERY serve.mjs start — overwhelmingly the
// plain operator boot, which uses none of the three — pay to evaluate all three
// (and load their native addons). esbuild bundles a dynamic import into the
// same single-file serve.mjs (no --splitting needed) behind a lazy `__esm`
// init, so the packaged bundle is unchanged in shape and only the eager
// evaluation goes away.

// (WI-5654) Boot-time background-task safety net — MUST be registered before
// runBootstrap() (called fire-and-forget, un-awaited, further down) fires its
// many detached best-effort warm-up tasks (memory embedder warm, hyperbee
// substrate boot, OMP integration, spawner/embed-sidecar warm-ups, …). Each is
// documented as non-fatal ("never affect boot", "best-effort") and is
// individually try/catch'd or `.catch()`-chained at its own call site — but
// THIS file (serve.ts, the packaged desktop entrypoint) never imports
// hono-host.ts, so unlike the multi-tenant `:3070` production host, this
// process has NEVER had a process-level unhandledRejection/uncaughtException
// guard. A single missed `.catch()` anywhere inside that fire-and-forget boot
// graph — first- or third-party, e.g. WI-5654: the harrier HF-cache-miss
// during the boot-time embedder warm-up crashing on a stripped bundle cache —
// becomes a bare Node unhandledRejection with ZERO listeners, which (per
// Node's default `--unhandled-rejections=throw`) kills the ENTIRE desktop app
// before it ever binds its HTTP port, with no diagnostic beyond a raw stack
// dump ("live-federation-gate RED 3/3", inst-a/inst-b.log). Unlike
// hono-host.ts (a live multi-tenant request-serving host, where masking a
// genuine bug could hide a real problem fleet-wide), this is a SINGLE-USER
// DESKTOP BOOT sequence: a fault in a best-effort background warm-up must
// never take the whole app down with it. Genuine CRITICAL boot failures
// (embedded PG, the HTTP listen) are unaffected by this — they're properly
// awaited inside main()'s own try/catch and surface through the informative
// `main().catch()` handler at the bottom of this file, which still exits(1).
// This backstop exists purely for the detached fire-and-forget class: log
// loudly (so the fault stays debuggable) and keep booting, instead of the
// whole app dying silently mid-boot with nothing but a raw V8 stack dump.

// WI-39599: both handlers report BY WRITING, so once our stdio peer is gone the
// report is itself a failing write that re-enters the handler that made it. The
// guard installed above already stops that from reaching us as an
// uncaughtException; skipping the write as well keeps this pair from being an
// amplifier again if some other unlistened stream error ever reappears. There is
// nothing left to read the output at this point, so nothing is lost by staying
// quiet — and the durable file sinks (e.g. gatewayLogLine) are unaffected.
process.on('unhandledRejection', (reason) => {
  if (stdioPeerGuard.peerGone()) return;
  console.error(
    '[serve] non-fatal unhandledRejection in a detached boot/background task (continuing boot):',
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  );
});
process.on('uncaughtException', (err) => {
  if (stdioPeerGuard.peerGone()) return;
  console.error(
    '[serve] non-fatal uncaughtException in a detached boot/background task (continuing boot):',
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
});

// EI-13917: honor PAPERCUSP_HOME (the established isolation escape hatch —
// see packages/operator-core/lib/papercusp-root.ts) BEFORE falling back to the
// box-wide `~/.papercusp`. Without this, ANY isolated invocation of this
// script — a packaged Papercusp Server run with its own PAPERCUSP_HOME +
// PAPERCUSP_PG_PORT for a gate/smoke test — still wrote its discovery file
// (embedded-pg.json), operator.json, superuser-token, and cold-start lock
// into the REAL user's `~/.papercusp/`, silently hijacking every other
// env-less process on the box onto its own (often throwaway/partial-schema)
// embedded PG the moment it started. Live incident: a leaked
// `papercup-live-federation-gate` instance (PAPERCUSP_HOME set, PAPERCUSP_PG_
// PORT=16757) overwrote the box-canonical embedded-pg.json at 2026-07-17
// 08:29Z, pointing the shared bg-host's pools at its own empty DB for ~5min
// (routines engine read "0 active routines" — box-wide git-sync/kettle/scout
// stall) — see EI-13917. A process that already does the isolation-correct
// thing (sets PAPERCUSP_HOME) now gets FULL isolation instead of only
// half of it.
const PAPERCUSP_DIR = process.env.PAPERCUSP_HOME || join(homedir(), ".papercusp");
const OPERATOR_JSON = join(PAPERCUSP_DIR, "operator.json");
const EMBEDDED_PG_JSON = join(PAPERCUSP_DIR, "embedded-pg.json");

/**
 * WI-10003627: a vm-release host is MULTI-ACCOUNT — the customer workspace account
 * shares loopback with this service user, and loopback TCP is not a uid boundary —
 * so its embedded Postgres roles must not carry the repo-public DEV passwords. This
 * 0600 file (in the 0700 state dir) holds the host's generated role passwords; the
 * embedded server keys every role to it and refuses to boot while a default still
 * authenticates. PAPERCUSP_PG_HOST_CREDENTIALS=1 opts any other host in.
 */
export const EMBEDDED_PG_CREDENTIALS_FILE = join(PAPERCUSP_DIR, "embedded-pg-credentials.json");

/** The per-host credentials file this process must key its embedded PG to, if any. */
export function embeddedPgCredentialsFile(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isVmReleaseDistribution(env) || env.PAPERCUSP_PG_HOST_CREDENTIALS === "1") {
    return EMBEDDED_PG_CREDENTIALS_FILE;
  }
  return undefined;
}
const SUPERUSER_TOKEN = join(PAPERCUSP_DIR, "superuser-token");

// WI-3287: a packaged env-sidecar sibling (env-operator-launcher.ts's bundled
// spawn — prod/staging running request-only alongside the primary, EI-126)
// re-execs THIS SAME serve.mjs under the SAME $HOME, identified by
// PAPERCUSP_ENV_OPERATOR_ID. Without scoping the lock file by that id, the
// sibling's acquireColdStartLock() call collides with the primary's — which
// holds `operator.lock` for its ENTIRE lifetime (only released on shutdown,
// never after a successful boot) — so every env-sidecar boot would
// permanently fail with "another `serve` holds the cold-start lock" the
// moment the primary is up (found live on the first real packaged-Linux
// env-switcher verify, 2026-07-07 — the switcher's staging button never
// lit because of this). Scoping by id gives each sibling (and the primary)
// its own lock, so they can legitimately cold-start concurrently.
const ENV_OPERATOR_ID = process.env.PAPERCUSP_ENV_OPERATOR_ID || null;
/** Request-only children may be launched from either the bundled env path or
 * a source/Vite path.  Keep the role marker independent of the env id so an
 * older launcher that only sets the explicit mode still cannot publish the
 * primary discovery records. */
export function isRequestOnlySidecar(
  env: NodeJS.ProcessEnv = process.env,
  envOperatorId: string | null = env.PAPERCUSP_ENV_OPERATOR_ID || null,
): boolean {
  return Boolean(envOperatorId || isRequestOnlyIdentityProcess(env));
}
const REQUEST_ONLY_SIDECAR = isRequestOnlySidecar(process.env, ENV_OPERATOR_ID);
/** Pure — exported so the scoping rule is unit-testable without a full module
 *  re-import (serve.ts has non-idempotent module-load side effects — DBOS
 *  workflow registration — that a `vi.resetModules()` re-import re-triggers). */
export function lockFileNameForEnvId(envOperatorId: string | null): string {
  return envOperatorId ? `operator.lock.env-${envOperatorId}` : "operator.lock";
}
const LOCK_PATH = join(PAPERCUSP_DIR, lockFileNameForEnvId(ENV_OPERATOR_ID));
// WI-2644: was `process.env.npm_package_version ?? '0.1.0-dev'` — npm never
// invokes the bundled sidecar, so this was ALWAYS the '0.1.0-dev' fallback on
// every packaged desktop build. build-info.ts already resolves the correct
// version (preferring PAPERCUSP_BUILD_VERSION, baked at compile time in
// main.rs and forwarded to the sidecar's env — see build-info.ts's docblock);
// reuse that single resolver instead of a second, divergent version read.
const VERSION = getBuildInfo().version;
// EI-9002: this process's own build sha, captured once at module load — the
// build-identity half of the `--ensure` reuse decision below.
const BUILD_SHA = getBuildInfo().sha;

export interface OperatorDiscovery {
  /** Base HTTP origin of the operator API, e.g. http://127.0.0.1:3070 */
  httpUrl: string;
  port: number;
  /** Superuser bearer token (from ~/.papercusp/superuser-token), or null. */
  token: string | null;
  pid: number;
  /** Kernel-backed boot + process-start identity. A PID-only record is never
   *  sufficient authority for a later cleanup signal. */
  processIdentity: string | null;
  startedAt: number;
  version: string;
  /** Short git sha this operator was built from (getBuildInfo().sha), or null
   *  when unresolved. EI-9002: this is the ONLY field precise enough to tell
   *  two builds sharing the same package.json `version` apart (a dev build,
   *  or a version bump that didn't happen). */
  sha: string | null;
}

function log(msg: string): void {
  console.log(`[serve] ${msg}`);
}


/** Read the current operator.json discovery, or null. */
export function readOperatorDiscovery(): OperatorDiscovery | null {
  try {
    const j = JSON.parse(
      readFileSync(OPERATOR_JSON, "utf8"),
    ) as Partial<OperatorDiscovery>;
    if (
      typeof j?.httpUrl === "string" &&
      j.httpUrl &&
      typeof j.pid === "number"
    ) {
      return {
        httpUrl: j.httpUrl,
        port: Number(j.port) || 0,
        token: typeof j.token === "string" ? j.token : null,
        pid: j.pid,
        processIdentity:
          typeof j.processIdentity === "string" && j.processIdentity
            ? j.processIdentity
            : null,
        startedAt: Number(j.startedAt) || 0,
        version: typeof j.version === "string" ? j.version : "unknown",
        sha: typeof j.sha === "string" && j.sha ? j.sha : null,
      };
    }
  } catch {
    /* missing / corrupt */
  }
  return null;
}

/** Best-effort HTTP liveness probe — any response (even 404) means "up". */
async function httpAlive(httpUrl: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(httpUrl + "/api/", { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * (EI-9002) True when `existing` (a running operator's discovery record) is
 * from a DIFFERENT build than the ensuring process's own `mine` build info —
 * i.e. `--ensure` must NOT adopt it silently.
 *
 * Prefer sha comparison when BOTH sides resolved one: sha is the precise
 * build identity (two dev builds can share the same package.json `version`).
 * Fall back to version when a sha is unavailable on either side — still
 * catches the common case (an actual version bump) even without git info.
 * Neither field being available (both unknown) is NOT treated as a mismatch:
 * there's no signal to distinguish on, so we preserve the pre-fix reuse
 * behavior rather than force a needless restart on every ensure.
 */
export function buildIdentityMismatch(
  existing: Pick<OperatorDiscovery, "sha" | "version">,
  mine: { sha: string | null; version: string },
): boolean {
  if (existing.sha && mine.sha) return existing.sha !== mine.sha;
  return existing.version !== mine.version;
}

/** The version a non-release build (dev tree, rig compose) reports: build-info's
 *  fallback when no PAPERCUSP_BUILD_VERSION / baked version is present. */
const DEV_BUILD_VERSION = "0.0.0";

function releaseTriple(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * (WI-10005958) True when the build-mismatched operator already running is
 * NEWER than the one launching, so replacing it would be a DOWNGRADE over data
 * a newer build may already have migrated. EI-9002's guard used to treat every
 * mismatch as "stale": an installed 0.0.26 app on the Mac test VM killed a rig
 * sidecar composed from current staging, and the old build's sweeps then
 * rewrote federated rows the newer build had fixed.
 *
 * - A dev launcher (0.0.0) may always replace — dev builds carry no order.
 * - A release launcher never replaces a running dev/rig compose.
 * - Release vs release: newer only when the running major.minor.patch is
 *   strictly greater (a pre-release suffix is ignored, so equal triples keep
 *   the EI-9002 replace behaviour).
 */
export function runningOperatorIsNewer(
  existing: Pick<OperatorDiscovery, "version">,
  mine: { version: string },
): boolean {
  if (mine.version === DEV_BUILD_VERSION) return false;
  if (existing.version === DEV_BUILD_VERSION) return true;
  const running = releaseTriple(existing.version);
  const launching = releaseTriple(mine.version);
  if (!running || !launching) return false;
  for (let i = 0; i < 3; i++) {
    if (running[i] !== launching[i]) return running[i] > launching[i];
  }
  return false;
}

/** Poll until `pid` is gone, or `ms` elapses. True when it exited. */
async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * (EI-9002) Gracefully terminate a FOREIGN running operator (SIGTERM, wait up
 * to `graceMs` for it to exit, SIGKILL fallback) so `--ensure` can cold-start
 * a fresh one instead of silently adopting a stale build. Never throws — a
 * process that's already gone (ESRCH on the initial kill) is a no-op success.
 *
 * Resolves ONLY once the pid is actually gone (`true`) — including after the
 * SIGKILL fallback, which used to return while the doomed process still held
 * its listening socket and PG data dir. The caller depends on that: the port
 * the stale operator occupies is released at its exit, and `resolveStickyPort`
 * probes for it immediately afterwards (see the ordering note in main). A
 * `false` return means it outlived even SIGKILL (uninterruptible sleep); the
 * boot continues and the port probe falls back to the launcher hint.
 */
export async function terminateForeignOperator(
  pid: number,
  opts: { graceMs?: number; killWaitMs?: number } = {},
): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true; // already gone
  }
  if (await waitForExit(pid, opts.graceMs ?? 5000)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true; // raced to death
  }
  return waitForExit(pid, opts.killWaitMs ?? 2000);
}

/**
 * (EI-9002) The `--ensure` reconciliation: adopt the operator that is already
 * running, or refuse it and terminate it. Returns the discovery record to
 * reuse, or null when the caller must cold-start.
 *
 * Extracted from main so the ordering invariant it establishes — a refused
 * operator is DEAD, and its port free, by the time this resolves — has a unit
 * recurrence guard.
 */
export async function reconcileEnsure(
  mine: { sha: string | null; version: string } = {
    sha: BUILD_SHA,
    version: VERSION,
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorDiscovery | null> {
  const existing = readOperatorDiscovery();
  if (
    !existing ||
    !pidAlive(existing.pid) ||
    !(await httpAlive(existing.httpUrl))
  )
    return null;
  if (!buildIdentityMismatch(existing, mine)) {
    log(
      `already running (pid ${existing.pid}) at ${existing.httpUrl} — reusing`,
    );
    return existing;
  }
  // WI-10005958: a mismatch is only "stale" when the running build is not
  // newer. Refusing loudly (main exits 1) beats a silent downgrade; neither
  // adopting it nor cold-starting beside it is safe.
  if (
    runningOperatorIsNewer(existing, mine) &&
    env.PAPERCUSP_ALLOW_OPERATOR_DOWNGRADE !== "1"
  ) {
    throw new Error(
      `refusing to replace pid ${existing.pid} at ${existing.httpUrl}: it runs a NEWER build ` +
        `(running sha=${existing.sha ?? "unknown"} version=${existing.version}, ` +
        `mine sha=${mine.sha ?? "unknown"} version=${mine.version}). Replacing it would ` +
        `downgrade the operator over data a newer build may have migrated (WI-10005958). ` +
        `Stop that operator deliberately, or set PAPERCUSP_ALLOW_OPERATOR_DOWNGRADE=1.`,
    );
  }
  log(
    `refusing to adopt pid ${existing.pid} at ${existing.httpUrl}: build mismatch ` +
      `(running sha=${existing.sha ?? "unknown"} version=${existing.version}, ` +
      `mine sha=${mine.sha ?? "unknown"} version=${mine.version}) — this is the silent ` +
      `no-op-update bug (EI-9002); terminating the stale operator and cold-starting fresh`,
  );
  if (!(await terminateForeignOperator(existing.pid))) {
    log(
      `stale operator pid ${existing.pid} outlived SIGKILL — it still holds port ${existing.port}`,
    );
  }
  return null;
}

/** Read the superuser bearer token if present. */
export function readToken(): string | null {
  try {
    const t = readFileSync(SUPERUSER_TOKEN, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

// ── Sticky operator port (stale-port-pin class fix, 2026-07-07) ─────────────
// The packaged desktop launcher (main.rs spawn_serve) hands us a FRESH
// portpicker-picked port on every boot, so every app restart used to move the
// operator's address — and every long-lived URL pin (tutorial-runner's
// --operator-url, dock CLIs, spawned members' MCP configs) died with it
// ("can't reach the Papercusp server", dead member MCP — owner-reported).
// Remembering the last successfully-bound port and re-binding it when free
// keeps the address stable across restarts; pinned clients then ride through a
// restart on their normal connection retry (operator-discovery.mjs
// fetchResilient) instead of pointing at a dead port forever.
const OPERATOR_PORT_MEMORY = join(PAPERCUSP_DIR, "operator-port.json");

/** Last successfully-bound HTTP port, or null. Unlike operator.json (unlinked
 *  on every shutdown), operator-port.json survives — it is the memory that
 *  makes the port sticky. */
export function readRememberedPort(): number | null {
  try {
    const j = JSON.parse(readFileSync(OPERATOR_PORT_MEMORY, "utf8")) as {
      port?: unknown;
    };
    const p = Number(j?.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {
    /* missing / corrupt → no memory */
  }
  return null;
}

/**
 * The port to bind: on the packaged desktop (PAPERCUSP_DESKTOP=1, the one
 * environment whose launcher hint is a fresh random port each boot), prefer
 * the remembered port when it is still free; everywhere else — dev box,
 * tests, anyone pinning PAPERCUSP_HONO_PORT deliberately — the hint stands.
 */
export async function resolveStickyPort(
  hinted: number,
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (env.PAPERCUSP_DESKTOP !== "1") return hinted;
  const remembered = readRememberedPort();
  if (!remembered || remembered === hinted) return hinted;
  if (!(await portAvailable(remembered, hostname))) {
    log(
      `remembered operator port ${remembered} is taken — using launcher hint ${hinted}`,
    );
    return hinted;
  }
  log(
    `re-binding remembered operator port ${remembered} (launcher hint ${hinted}) — pinned client URLs stay valid across restarts`,
  );
  return remembered;
}

/**
 * Resolve the HTTP port HINT from the environment, with a hard guardrail for
 * env-sidecar siblings (EI-11342).
 *
 * PRIMARY operator (`envOperatorId == null`): default to the well-known 3070
 * when no explicit PAPERCUSP_HONO_PORT/PORT is set — unchanged behavior.
 *
 * ENV-SIDECAR (`envOperatorId` set — a rig / env-switcher sibling): an explicit,
 * valid port is MANDATORY. These siblings are launched with a FIXED per-instance
 * port (env-operator-launcher.ts always sets PAPERCUSP_HONO_PORT alongside
 * PAPERCUSP_ENV_OPERATOR_ID) and run on the SAME box as the primary operator, so
 * silently falling back to the baked 3070 default means squatting the production
 * operator's port. That is exactly EI-11342: a packaged live-federation-gate
 * sidecar whose port override never reached it fell back to 3070, won a bind
 * race against a mid-restart papercup-dev-api, and crash-looped prod + blacked
 * out fleet-wide MCP for ~7 min. When the injected override is missing or
 * invalid we FAIL LOUDLY here instead of binding a wrong (possibly prod) port.
 */
export function resolveHonoPortHint(
  env: NodeJS.ProcessEnv,
  envOperatorId: string | null,
): number {
  const rawExplicit = env.PAPERCUSP_HONO_PORT ?? env.PORT ?? null;
  if (envOperatorId) {
    const port = rawExplicit == null ? NaN : Number(rawExplicit);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(
        `env-sidecar ${JSON.stringify(envOperatorId)} requires an explicit ` +
          `PAPERCUSP_HONO_PORT/PORT (got ${JSON.stringify(rawExplicit)}); refusing to ` +
          `fall back to the baked default 3070, which would squat the production ` +
          `operator's port on this box (EI-11342).`,
      );
    }
    return port;
  }
  return Number(rawExplicit ?? 3070);
}

/**
 * Re-export the RESOLVED operator port into every env var that names it, so
 * in-process consumers never see the launcher's stale cold-start hint.
 *
 * The desktop launcher spawns this sidecar with `PAPERCUSP_HONO_PORT` and
 * `PAPERCUSP_OPERATOR_BASE` set to a fresh random port hint; when
 * `resolveStickyPort` re-binds the remembered port instead (every boot after
 * the first), those envs silently diverge from the port actually bound. The
 * worst consumer was the endpoint-IPC `sys:http` bridge, whose upstream base
 * prefers `PAPERCUSP_OPERATOR_BASE`: every IPC-bridged `/api/*` call (all
 * sync SSE + REST) hit the dead hint port and ECONNREFUSED'd forever — the
 * packaged desktop's permanent "Operator connection lost" banner (WI-3385),
 * on every launch after the first, on all 3 platforms. `endpoint-ipc.json`'s
 * `port` field (PAPERCUSP_HONO_PORT) carried the same lie. One write here,
 * before `runBootstrap()` imports any consumer, fixes the whole class.
 */
export function exportResolvedPortEnv(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.PORT = String(port); // selfUrl() origin (mirrors hono-host.ts)
  env.PAPERCUSP_HONO_PORT = String(port);
  env.PAPERCUSP_OPERATOR_BASE = `http://127.0.0.1:${port}`;
}

/**
 * Cold-start singleton guard. Atomically create the lockfile (O_EXCL) with our
 * pid. Returns true if acquired. If a *live* owner holds it, returns false.
 * A stale lock (owner dead) is reclaimed and re-attempted once.
 *
 * Liveness = pid alive AND its cmdline looks like a serve/node process —
 * bare pid-aliveness is defeated by pid reuse, which is near-CERTAIN in a
 * restarted WSL distro (serve gets a single-digit pid; after
 * `wsl --terminate` / host reboot the distro's own init session occupies
 * it, and an unreleased lock then wedges every future boot — found live on
 * Windows 2026-06-11). Same guard sweepOrphanPostgres already uses.
 *
 * WI-5393: `/proc/<pid>/cmdline` can read EMPTY for a genuinely-LIVE process
 * under heavy host load (the same race already documented on
 * `isPortAccepting` above) — observed live on gate run 122147 (host load
 * 96+): the env-sidecar "prod" lock's owner pid was alive and actually
 * serving, but its cmdline read empty at the exact moment a restarting
 * sibling checked it, so the old code below (which treated ANY non-matching
 * cmdline — including an ambiguous empty read — as "not a serve process")
 * unlinked the still-valid lock and spawned a SECOND live serve.mjs beside
 * the first. Two live instances of the same env then fought over the shared
 * embedded Postgres for the rest of that boot. An empty cmdline read is NOT
 * proof the owner isn't a serve process — it is proof we couldn't tell — so
 * it must fail CLOSED (treat as still-held, do not reclaim) rather than fail
 * open (treat as stale, reclaim). The asymmetry is deliberate: a false
 * "still held" costs one extra boot-retry once the load spike passes; a
 * false "reclaim" produces a live duplicate process, which is the bug.
 * `deps` lets a test simulate the empty-read race without needing a real
 * process whose actual /proc/<pid>/cmdline happens to be empty.
 */
export function acquireColdStartLock(
  retried = false,
  deps: {
    pidAlive?: (pid: number) => boolean;
    processCommandLine?: (pid: number) => string | null;
  } = {},
): boolean {
  const isAlive = deps.pidAlive ?? pidAlive;
  const cmdlineOf = deps.processCommandLine ?? processCommandLine;
  try {
    // ~/.papercusp may not exist yet on a fresh machine, and this runs before
    // any other writer mkdir's it — create it owner-only first.
    mkdirSync(PAPERCUSP_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const ownerPid =
      Number(
        (() => {
          try {
            return readFileSync(LOCK_PATH, "utf8").trim();
          } catch {
            return "";
          }
        })(),
      ) || 0;
    // Our own pid = we already hold it; never reclaim out from under
    // ourselves.
    if (ownerPid === process.pid) return false;
    // Foreign pids must look like serve SPECIFICALLY — a loose pattern
    // (node, or any .papercusp path mention) false-positives on whatever
    // unrelated process reused the pid, e.g. a `cat
    // ~/.papercusp/operator.json` health probe (observed live: the probe's
    // own cmdline contains "papercusp" and occupied the reclaimed pid,
    // wedging boot exactly like the stale lock it was checking for).
    const ownerAlive = isAlive(ownerPid);
    const ownerCmdline = ownerAlive ? cmdlineOf(ownerPid) : null;
    const ownerIsServe =
      ownerAlive && !!ownerCmdline && /serve\.(mjs|ts)/i.test(ownerCmdline);
    if (ownerIsServe) return false;
    // WI-5393: alive but cmdline read as an EMPTY string (as opposed to
    // `null`, which means the read failed outright / the pid is gone) is
    // INCONCLUSIVE, not a negative — fail closed and refuse to reclaim.
    if (ownerAlive && ownerCmdline === "") return false;
    if (retried) return false;
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* someone else reclaimed */
    }
    return acquireColdStartLock(true, deps);
  }
}

export function releaseColdStartLock(): void {
  try {
    const owner = Number(readFileSync(LOCK_PATH, "utf8").trim()) || 0;
    if (owner === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

/** Default migrations dir: repo `libs/papercusp/libs/db/sql` relative to this file. */
function defaultSqlDir(): string {
  return fileURLToPath(
    new URL("../../../libs/papercusp/libs/db/sql", import.meta.url),
  );
}

/** The embedded-PG data dir as ensurePostgres resolves it (env or default). */
function resolvedPgDataDir(): string {
  return (
    process.env.PAPERCUSP_PG_DATA_DIR ?? join(PAPERCUSP_DIR, "embedded-pg-data")
  );
}

/**
 * Synchronously SIGINT the postmaster named in `<dataDir>/postmaster.pid` —
 * PG's "fast shutdown". Used by the signal handler, which cannot rely on
 * surviving past its first await (see the shutdown comment). PG finishes the
 * shutdown on its own and removes postmaster.pid; we don't wait.
 */
export function sigintPostmasterSync(dataDir: string): void {
  try {
    const raw = readFileSync(join(dataDir, "postmaster.pid"), "utf8");
    const pid = Number((raw.split("\n")[0] ?? "").trim());
    if (Number.isInteger(pid) && pid > 0) {
      log(`fast-shutdown signal to postmaster pid=${pid}`);
      process.kill(pid, "SIGINT");
    }
  } catch {
    /* no postmaster.pid / already gone */
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  // ~/.papercusp holds credentials — operator.json carries the superuser bearer
  // token, embedded-pg.json carries a DSN with the PG password (the `url` field
  // can't be redacted; external clients connect with it). Keep the dir + files
  // owner-only (0700/0600) so the secrets aren't world/group-readable.
  await mkdir(PAPERCUSP_DIR, { recursive: true, mode: 0o700 });
  await chmod(PAPERCUSP_DIR, 0o700).catch(() => {}); // tighten even if it pre-existed
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {}); // deterministic even if tmp pre-existed
  // rename is atomic on the same filesystem and preserves the 0600 mode.
  await rename(tmp, path);
}

interface PgHandle {
  port: number;
  urls: { admin: string; app: string; zero: string };
  stop: () => Promise<void>;
}

/** Best-effort command line of a live process, or null. Linux reads
 * /proc/<pid>/cmdline; macOS falls back to `ps`. */
function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    }
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

/**
 * True if something is accepting TCP connections on 127.0.0.1:`port` within
 * `timeoutMs`. Used by the orphan sweep as GROUND TRUTH for "is a postgres
 * actually up on the recorded port?" — more reliable than a pid/cmdline match
 * inside the WSL distro, where low pids get recycled fast (a dead postgres's
 * pid can already belong to an unrelated live process) and `/proc/<pid>/cmdline`
 * can read empty under load. Never throws.
 */
export async function isPortAccepting(
  port: number,
  timeoutMs = 750,
): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) return false;
  return new Promise<boolean>((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/**
 * Sweep an orphaned postgres process holding `dataDir` (left by a prior
 * unclean exit) before we start a fresh one. Ported from the desktop
 * embedder's Rust `sweep_orphan_postgres` (SP1 C5 — PG lifecycle ownership
 * moved here, so the orphan problem moved with it).
 *
 * PG writes its own PID into `<dataDir>/postmaster.pid` on startup and
 * removes it on clean shutdown. If the file exists and the PID is alive AND
 * its command line names postgres + our exact data dir, it's a leftover from
 * a prior session — kill it. If the PID is dead, unlink the stale lockfile so
 * embedded-postgres doesn't reject the dir as already-running.
 *
 * Defensive about misidentifying live processes: only kill when the cmdline
 * has `postgres`/`embedded-pg` in it AND references our data dir. Otherwise
 * leave it alone and let the start surface its own error — better to fail
 * loud than nuke an unrelated process.
 */
export async function sweepOrphanPostgres(
  dataDir: string,
  logFn: (m: string) => void = log,
): Promise<void> {
  const pidFile = join(dataDir, "postmaster.pid");
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf8");
  } catch {
    return; // No lockfile, no orphan to worry about.
  }
  // postmaster.pid format: PID is line 1.
  const pidStr = (raw.split("\n")[0] ?? "").trim();
  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) {
    // WI-3822: an unclean shutdown (power loss, host crash, VM reset, OOM)
    // can leave postmaster.pid partially/never flushed — e.g. all-NUL bytes
    // from ext4 delayed allocation after a hard reset. We already recognise
    // this as malformed, but historically just logged and left the file in
    // place: Postgres itself then refuses to start ("FATAL: bogus data in
    // lock file"), permanently bricking the app until a human manually
    // deletes the file from a hidden data dir. An unparseable pid means we
    // cannot identify an owning postmaster process to check aliveness on, so
    // fall back to the same ground-truth check the "alive but not ours"
    // branch below uses: only unlink if nothing is actually listening on the
    // recorded port. If something IS listening, a real server may still hold
    // the dir; leave it alone and let the start fail loudly rather than
    // silently orphaning a live server.
    logFn(`sweepOrphanPostgres: malformed pid '${pidStr}' in ${pidFile}`);
    const recordedPort = Number((raw.split("\n")[3] ?? "").trim()) || 0;
    if (recordedPort > 0 && (await isPortAccepting(recordedPort))) {
      logFn(
        `sweepOrphanPostgres: pid unparseable but :${recordedPort} is accepting — ` +
          `a live server may hold ${dataDir}; leaving ${pidFile} alone`,
      );
      return;
    }
    logFn(
      `sweepOrphanPostgres: unparseable postmaster.pid and :${recordedPort || "?"} not accepting — ` +
        `unlinking ${pidFile}`,
    );
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
    return;
  }
  if (!pidAlive(pid)) {
    // Stale lockfile from a crashed prior session — embedded-postgres usually
    // handles this itself, but unlink eagerly to be safe.
    logFn(
      `sweepOrphanPostgres: stale postmaster.pid (pid=${pid} dead), unlinking`,
    );
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
    return;
  }
  // Live: confirm it's actually a postgres pointed at OUR data dir before
  // terminating.
  const cmdline = processCommandLine(pid) ?? "";
  const isPg = /postgres|embedded-pg/i.test(cmdline);
  if (!isPg || !cmdline.includes(dataDir)) {
    // The pid is alive but does NOT look like our postgres. Two cases, and BOTH
    // mean the postmaster that wrote this lockfile is gone: (a) postgres died
    // and the WSL2 distro recycled its (low) pid to an unrelated process, or
    // (b) `/proc/<pid>/cmdline` read empty under load. Either way, leaving the
    // stale postmaster.pid in place is NOT harmless: embedded-postgres' next
    // `pg.start()` FATALs on "lock file already exists", which crash-loops the
    // operator and — on Windows — the respawn storm wedges the whole WSL distro
    // until a manual `wsl --terminate` (VM-observed 2026-07-08, WI-3360). So
    // clear the stale lockfile — but ONLY after confirming, via GROUND TRUTH,
    // that no postgres is actually accepting on the recorded port. If something
    // IS listening, a real server holds the dir (or a genuine port clash) and
    // we must NOT unlink; surface it by leaving the start to fail loudly.
    const recordedPort = Number((raw.split("\n")[3] ?? "").trim()) || 0;
    if (recordedPort > 0 && (await isPortAccepting(recordedPort))) {
      logFn(
        `sweepOrphanPostgres: pid ${pid} is alive but not our postgres, yet :${recordedPort} ` +
          `is accepting — a live server holds ${dataDir}; leaving it alone ` +
          `(cmdline=${JSON.stringify(cmdline.slice(0, 200))})`,
      );
      return;
    }
    logFn(
      `sweepOrphanPostgres: pid ${pid} alive but not our postgres and :${recordedPort || "?"} ` +
        `not accepting — stale postmaster.pid (postgres dead, pid reused); unlinking ${pidFile}`,
    );
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
    return;
  }
  logFn(
    `sweepOrphanPostgres: killing orphaned postgres pid=${pid} holding ${dataDir}`,
  );
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* raced to death */
  }
  // Up to 5s for a graceful exit, then SIGKILL.
  for (let i = 0; i < 50 && pidAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* raced */
    }
  }
  try {
    unlinkSync(pidFile);
  } catch {
    /* postgres removed it on clean exit */
  }
}

/** The port PG recorded on line 4 of `<dataDir>/postmaster.pid` (0 if absent/unparseable). */
function readPostmasterRecordedPort(dataDir: string): number {
  try {
    const raw = readFileSync(join(dataDir, "postmaster.pid"), "utf8");
    return Number((raw.split("\n")[3] ?? "").trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * (EI-14941) Detect a healthy embedded Postgres that a DIFFERENT, still-alive
 * operator already owns for THIS data dir — so we ATTACH to it instead of
 * hijacking it.
 *
 * The foot-gun this closes: on a shared sidecar home (multiple operators sharing
 * one `$HOME` → the same embedded-pg data dir — e.g. an "isolated" test rig whose
 * HOME override silently failed to propagate), the cold-start path used to
 * `sweepOrphanPostgres` (SIGKILL the running postmaster) and restart PG on a
 * fresh launcher-hint port. That silently breaks every consumer baked to the OLD
 * port — a totally unrelated live operator loses DB connectivity while its HTTP
 * process keeps looking healthy (the live incident on the shared mac VM,
 * 2026-07-17).
 *
 * We attach ONLY when a foreign owner genuinely holds it, which is precisely the
 * multi-tenant collision and NEVER the normal single-user desktop (there the
 * recorded owner pid is either our own or a dead prior session):
 *   - `~/.papercusp/embedded-pg.json` names an operator pid that is ALIVE and is
 *     NOT us (a live foreign owner — distinguishes this from a clean-restart
 *     orphan, whose owner has exited);
 *   - the on-disk `postmaster.pid` in this data dir records the SAME port
 *     (ground truth that a live postmaster holds THIS dir, not a stale record);
 *   - that port is actually accepting TCP (the PG is really up).
 * Any check failing ⇒ null ⇒ the caller falls through to the unchanged
 * sweep+cold-start path.
 */
export async function detectRunningSharedPg(
  dataDir: string,
  logFn: (m: string) => void = log,
): Promise<{ port: number; ownerPid: number; adminUrl: string; appUrl?: string } | null> {
  let rec: { pid?: unknown; port?: unknown; url?: unknown; appUrl?: unknown } | null = null;
  try {
    rec = JSON.parse(readFileSync(EMBEDDED_PG_JSON, "utf8"));
  } catch {
    return null; // no PG discovery record → nothing to attach to
  }
  const ownerPid = Number(rec?.pid);
  const pgPort = Number(rec?.port);
  const adminUrl = typeof rec?.url === "string" ? rec.url : "";
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (!Number.isInteger(pgPort) || pgPort <= 0 || pgPort >= 65536) return null;
  if (!adminUrl) return null;
  // Our own record, or an owner that has exited — NOT a live foreign owner. Let
  // the normal sweep+cold-start reclaim the dir (also avoids attaching to a PG
  // that is mid-shutdown during a fast single-user restart).
  if (ownerPid === process.pid || !pidAlive(ownerPid)) return null;
  // Ground truth: a live postmaster genuinely holds THIS data dir on that port.
  if (readPostmasterRecordedPort(dataDir) !== pgPort) return null;
  if (!(await isPortAccepting(pgPort))) return null;
  logFn(
    `detectRunningSharedPg: live shared Postgres on :${pgPort} owned by still-alive ` +
      `operator pid ${ownerPid} holds ${dataDir} — will attach, not take over (EI-14941)`,
  );
  const appUrl = typeof rec?.appUrl === "string" && rec.appUrl ? rec.appUrl : undefined;
  return { port: pgPort, ownerPid, adminUrl, ...(appUrl ? { appUrl } : {}) };
}

/** Start (or attach to) Postgres and ensure HARNESS_ADMIN_DATABASE_URL is set. */
async function ensurePostgres(): Promise<PgHandle | null> {
  if (process.env.PAPERCUSP_USE_EMBEDDED_PG === "0") {
    const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
    if (!admin) {
      throw new Error(
        "PAPERCUSP_USE_EMBEDDED_PG=0 requires HARNESS_ADMIN_DATABASE_URL (and HARNESS_DATABASE_URL) to be set.",
      );
    }
    log(`attaching to external Postgres via HARNESS_ADMIN_DATABASE_URL`);
    return null; // external PG; nothing for us to manage/stop
  }

  const { startEmbeddedPostgresServer } =
    await import("@papercusp/embedded-postgres-server");
  const port = Number(process.env.PAPERCUSP_PG_PORT ?? 5532);
  const dataDir =
    process.env.PAPERCUSP_PG_DATA_DIR ??
    join(PAPERCUSP_DIR, "embedded-pg-data");
  const dbSqlDir = process.env.PAPERCUSP_PG_SQL_DIR ?? defaultSqlDir();
  // Pre-migrated PGDATA seed (first-boot fast path). When present + the data dir
  // is fresh, embedded-postgres-server extracts it instead of running initdb +
  // the full migration replay (~11s → ~1s). Absent/unset ⇒ normal initdb path.
  const seedPath = process.env.PAPERCUSP_PG_SEED_PATH;

  log(`starting embedded Postgres on :${port} (data=${dataDir})`);
  if (!existsSync(dbSqlDir))
    log(`warning: migrations dir not found at ${dbSqlDir}`);
  if (seedPath && existsSync(seedPath))
    log(
      `pre-migrated seed available at ${seedPath} (used only on a fresh data dir)`,
    );

  // (EI-14941) If a DIFFERENT, still-alive operator already owns a healthy
  // Postgres for this data dir (the shared-sidecar-home multi-tenant case),
  // ATTACH to it on its existing port instead of sweeping+restarting it on a
  // fresh port — the latter silently severs every consumer baked to the old
  // port. We take NO ownership: like the external-PG branch above, return null
  // so shutdown never sweeps or SIGINTs a postmaster we don't own. Never fires
  // on a normal single-user desktop (recorded owner is our own pid or a dead
  // prior session).
  const shared = await detectRunningSharedPg(dataDir);
  if (shared) {
    process.env.HARNESS_ADMIN_DATABASE_URL = shared.adminUrl;
    if (!process.env.HARNESS_DATABASE_URL) {
      if (shared.appUrl) {
        // A multi-account host keys harness_app to a per-host secret and
        // advertises its URL (WI-10003627); the DEV default would be refused.
        process.env.HARNESS_DATABASE_URL = shared.appUrl;
      } else {
        try {
          const u = new URL(shared.adminUrl);
          u.username = "harness_app";
          u.password = "harness_app_pwd";
          process.env.HARNESS_DATABASE_URL = u.toString();
        } catch {
          /* keep admin-only if the stored URL won't parse */
        }
      }
    }
    process.env.PAPERCUSP_USE_EMBEDDED_PG = "1";
    process.env.PAPERCUSP_PG_PORT = String(shared.port);
    let dbName = "papercusp";
    try {
      dbName = new URL(shared.adminUrl).pathname.replace(/^\//, "") || dbName;
    } catch {
      /* keep default for the readiness marker only */
    }
    log(
      `attaching to already-running shared embedded Postgres on :${shared.port} ` +
        `(owner operator pid ${shared.ownerPid} still alive) — NOT taking it over ` +
        `(EI-14941); our shutdown leaves it running`,
    );
    // Preserve the readiness marker the desktop smoke harness greps
    // (federation-asserts.sh fed_wait_boot); main() only logs it when we OWN pg.
    log(`embedded Postgres ready on localhost:${shared.port} db=${dbName}`);
    return null;
  }

  // Kill/clear any orphaned postgres from a prior unclean exit before the
  // fresh start — otherwise the spawn fails with "lock file already exists"
  // or silently serves stale data on another port.
  await sweepOrphanPostgres(dataDir);

  // Autoadjust the embedded PG to the host: derive server knobs (max_connections,
  // shared_buffers, parallelism, work_mem, …) from detected cores/RAM and pass
  // them as `-c` flags. embeddedPg:true — the DB shares this box with the operator
  // + agents, so it takes a gentler RAM slice (see deriveDatabaseTuning). Without
  // this the desktop's embedded PG runs on laptop-sized stock defaults
  // (max_connections=100 / shared_buffers=128MB), which a busy fleet exhausts.
  const {
    deriveDatabaseTuning,
    databaseTuningToSettings,
    detectResourceSignals,
  } = await import("@papercusp/resource-profile");
  const extraPostgresSettings = databaseTuningToSettings(
    deriveDatabaseTuning(detectResourceSignals({ embeddedPg: true })),
  );
  log(
    `embedded PG host-tuning: max_connections=${extraPostgresSettings.max_connections}, ` +
      `shared_buffers=${extraPostgresSettings.shared_buffers}, ` +
      `effective_cache_size=${extraPostgresSettings.effective_cache_size}`,
  );

  // WI-3822: embedded-postgres' pg.start() can reject with an Error whose
  // message is empty, or (observed live, EI-7099) with no Error object at
  // all — losing the actual cause. The real reason (e.g. `FATAL: bogus data
  // in lock file "postmaster.pid": ""`) already streams through onLog just
  // above the rejection; capture the last FATAL-looking line here so a bare
  // rejection can be re-thrown WITH it attached, instead of forcing whoever
  // reads the crash to scroll back through the log to find it.
  let lastPgFatalLine: string | undefined;
  const credentialsFile = embeddedPgCredentialsFile();
  if (credentialsFile) {
    log(
      `embedded PG roles keyed to per-host generated passwords (${credentialsFile}); ` +
        `boot refuses while any repo-public default still authenticates (WI-10003627)`,
    );
  }
  const pg = (await startEmbeddedPostgresServer({
    port,
    dataDir,
    credentialsFile,
    dbSqlDir: existsSync(dbSqlDir) ? dbSqlDir : undefined,
    seedPath: seedPath && existsSync(seedPath) ? seedPath : undefined,
    extraPostgresSettings,
    onLog: (m: string) => {
      log(`pg: ${m}`);
      if (/FATAL/i.test(m)) lastPgFatalLine = m;
    },
  }).catch((e: unknown) => {
    if (lastPgFatalLine && (!(e instanceof Error) || !e.message)) {
      throw new Error(
        `embedded postgres failed to start: ${lastPgFatalLine.trim()}`,
        { cause: e },
      );
    }
    throw e;
  })) as PgHandle;

  // Make the admin URL the #1 resolution source BEFORE any operator module
  // calls getHarnessAdminUrl() (it caches the first result).
  process.env.HARNESS_ADMIN_DATABASE_URL = pg.urls.admin;
  if (!process.env.HARNESS_DATABASE_URL) {
    process.env.HARNESS_DATABASE_URL = pg.urls.app;
  }
  // Stamp the env to match REALITY for env-keyed consumers. Embedded is
  // serve's default, so the desktop launcher often doesn't set the flag —
  // but setup-status's probePostgres branches on PAPERCUSP_USE_EMBEDDED_PG
  // === '1' and otherwise probes native :5432, painting the wizard's
  // database step red while embedded PG is healthy (found live on Windows
  // 2026-06-11). PG_PORT likewise: the launcher's value is a HINT; record
  // the port actually bound.
  process.env.PAPERCUSP_USE_EMBEDDED_PG = "1";
  process.env.PAPERCUSP_PG_PORT = String(pg.port);

  // Write the embedded-pg discovery file (the latent-bug fix). The generic
  // resolver reads the `url` field; extra fields are diagnostics.
  //
  // WI-7462: but NOT if that would hijack a live foreign endpoint. This file is
  // an advertisement to the WHOLE BOX — every env-less consumer resolves its DB
  // through it — so overwriting it redirects processes we do not own.
  // detectRunningSharedPg() above already declines to TAKE OVER a foreign PG,
  // but it is narrow by construction: it also requires a postmaster to hold OUR
  // data dir on that port. When the box's canonical PG is native (dev box,
  // :5432, a different data dir) that check fails, we fall through to
  // sweep+cold-start, and then — until now — we published anyway, pointing the
  // fleet at a throwaway PG that dies when this instance exits. That is the
  // 25-minute fleet-wide MCP outage of 2026-08-03 (EI-19415174699106397).
  const existingRec = readPgDiscoveryRecord();
  const existingPort = Number(existingRec?.port);
  // Ordering is what makes this safe for the legitimate cases:
  // sweepOrphanPostgres() ran BEFORE our start, so a swept orphan's port is
  // already dead by now and this probe says "not live" ⇒ we publish as before.
  const foreignEndpointLive =
    Number.isInteger(existingPort) && existingPort > 0 && existingPort !== pg.port
      ? await isPortAccepting(existingPort)
      : false;
  const verdict = _shouldPublishGlobalPgDiscovery({
    existingPort: Number.isInteger(existingPort) ? existingPort : null,
    existingPid: Number(existingRec?.pid) || null,
    ourPort: pg.port,
    ourPid: process.pid,
    foreignEndpointLive,
  });
  const record = {
    url: pg.urls.admin,
    // harness_app's URL: on a multi-account host its password is a per-host
    // secret, so readers cannot derive it from the admin URL (WI-10003627).
    appUrl: pg.urls.app,
    port: pg.port,
    pid: process.pid,
    startedAt: Date.now(),
  };
  if (verdict.publish) {
    await writeJsonAtomic(EMBEDDED_PG_JSON, record);
    log(`wrote ${EMBEDDED_PG_JSON} (${verdict.reason})`);
  } else {
    // Still advertise ourselves, just instance-scoped so anything that wants
    // THIS operator's PG can find it. Mirrors the per-port
    // `endpoint-ipc.<port>.json` convention (EI-190).
    const scoped = join(PAPERCUSP_DIR, `embedded-pg.${pg.port}.json`);
    await writeJsonAtomic(scoped, record);
    log(
      `REFUSING to overwrite ${EMBEDDED_PG_JSON}: it advertises :${existingPort}, ` +
        `which is STILL ACCEPTING connections and is not ours (we are :${pg.port}, ` +
        `pid ${process.pid}). Publishing to ${scoped} instead — the box-wide ` +
        `advertisement is left pointing at the live endpoint (WI-7462). If this ` +
        `instance is meant to be isolated, set PAPERCUSP_HOME (EI-13917).`,
    );
  }
  return pg;
}

/** Read the current global embedded-pg advertisement, or null. Exported for tests. */
export function readPgDiscoveryRecord(): { port?: unknown; pid?: unknown } | null {
  try {
    return JSON.parse(readFileSync(EMBEDDED_PG_JSON, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Remove a discovery advertisement only when it still belongs to this serve
 * process and (when present) this embedded-PG port. A newer serve can replace
 * the file while an older shutdown is still draining; an unconditional unlink
 * from that older shutdown would erase the newer process's live endpoint.
 *
 * Records written by this module always carry both `pid` and `port`. Requiring
 * the pid here also means an older/malformed record is left for the reader's
 * stale-file guard rather than being mistaken for ours.
 */
export function removeOwnedPgDiscoveryFile(
  path: string,
  ownerPid: number,
  ownerPort?: number,
): boolean {
  let record: { pid?: unknown; port?: unknown };
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }

  if (Number(record?.pid) !== ownerPid) return false;
  const advertisedPort = Number(record?.port);
  if (
    ownerPort !== undefined &&
    Number.isInteger(advertisedPort) &&
    advertisedPort !== ownerPort
  ) {
    return false;
  }

  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * WI-7462: may we take over the box-wide embedded-pg advertisement?
 *
 * Pure so the rule is unit-testable without booting Postgres. The single
 * question it answers: would writing our record REDIRECT the box away from an
 * endpoint that is still serving somebody?
 */
export function _shouldPublishGlobalPgDiscovery(args: {
  existingPort: number | null;
  existingPid: number | null;
  ourPort: number;
  ourPid: number;
  foreignEndpointLive: boolean;
}): { publish: boolean; reason: string } {
  const { existingPort, existingPid, ourPort, ourPid, foreignEndpointLive } = args;
  if (existingPort === null) return { publish: true, reason: "no prior advertisement" };
  // We just bound the port it already names — publishing REFRESHES the record
  // for an endpoint we now own (pid/url/startedAt), it does not redirect anyone.
  if (existingPort === ourPort) return { publish: true, reason: "same endpoint, refreshing" };
  // Our own stale record from a prior identity of this process.
  if (existingPid !== null && existingPid === ourPid)
    return { publish: true, reason: "our own prior record" };
  // A different port that no longer answers — a dead advertisement helps nobody.
  if (!foreignEndpointLive)
    return { publish: true, reason: `prior endpoint :${existingPort} is dead` };
  return { publish: false, reason: `foreign endpoint :${existingPort} is live` };
}

export const SERVE_HELP_TEXT = `Usage: papercusp serve [--ensure] [--ui]

Start the headless Papercusp operator.

Options:
  --ensure     Reuse a healthy operator from the same build when one is running.
  --ui         Serve the packaged UI as well as the operator API.
  -h, --help   Show this help and exit without starting runtime services.
`;

export function isServeHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export const HOSTED_CONTROL_PLANE_SERVE_PROFILE = "hosted-control-plane";

export function isHostedControlPlaneServeProfile(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PAPERCUSP_DISTRIBUTION_PROFILE === HOSTED_CONTROL_PLANE_SERVE_PROFILE;
}

async function main(): Promise<void> {
  // EI-21546899007927487: argv help is a read-only introspection contract. This
  // MUST remain the first branch in main(): the packaged sidecar dispatches
  // below start child servers, while the normal path acquires the cold-start
  // lock and boots embedded Postgres + migrations. A conventional `--help`
  // probe must reach none of them.
  const argv = process.argv.slice(2);
  if (argv[0] === "--content-bootstrap") {
    const { runContentBootstrap } = await import("./papercusp-content-bootstrap");
    process.exitCode = await runContentBootstrap(argv.slice(1));
    return;
  }
  if (isServeHelpRequest(argv)) {
    process.stdout.write(SERVE_HELP_TEXT);
    return;
  }

  // R6 admission pre-check workers are managed tasks whose lifetime is independent of this
  // serving host. Divert before the ordinary sidecar parent-death watch and before host boot.
  if (process.env.PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE === "1") {
    const { runAdmissionPrecheckWorkerFromEnvironment } =
      await import("@papercusp/operator-core/lib/release/admission-fix-precheck-managed");
    process.exitCode = await runAdmissionPrecheckWorkerFromEnvironment();
    return;
  }

  // The packaged sidecar branches below return before the normal operator
  // shutdown handlers are installed. Arm the shared parent-death watch first;
  // once the sidecar entrypoint is running, its SIGTERM handler receives this
  // handoff and closes its own server/socket. If the parent is already gone,
  // the immediate check exits this process before the sidecar can become an
  // orphan.
  const packagedSidecarMode =
    process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MODE === "1" ||
    process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE === "1" ||
    process.env.PAPERCUSP_EMBED_SIDECAR_MODE === "1" ||
    process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE === "1" ||
    process.env.PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE === "1" ||
    process.env.PAPERCUSP_LSP_DAEMON_MODE === "1";
  if (packagedSidecarMode) startSidecarParentDeathWatch();

  // PACKAGED substrate-sidecar (P-006): the spawner re-execs THIS bundled
  // serve.mjs with PAPERCUSP_SUBSTRATE_SIDECAR_MODE=1 instead of `npx tsx`-ing a
  // .ts the bundle doesn't contain. Divert to the sidecar JSON-RPC server BEFORE
  // any embedded-PG / operator boot; the net server keeps the process alive.
  if (process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MODE === "1") {
    const { runSubstrateSidecarServer } =
      await import("@papercusp/operator-core/lib/sync/hyperbee/substrate-sidecar-server");
    runSubstrateSidecarServer();
    return;
  }
  if (process.env.PAPERCUSP_LSP_DAEMON_MODE === "1") {
    const { runLspDaemonServer } = await import('@papercusp/operator-core/lib/code-intelligence/lsp-daemon-server');
    runLspDaemonServer();
    return;
  }
  // PACKAGED spawner-sidecar (WI-344 ③): same re-exec divert for the agent-spawn
  // sidecar — serve.mjs is re-execed with PAPERCUSP_SPAWNER_SIDECAR_MODE=1.
  if (process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE === "1") {
    const { runSpawnerSidecarServer } =
      await import("@papercusp/operator-core/lib/fleet/spawner-sidecar-server");
    runSpawnerSidecarServer();
    return;
  }
  // PACKAGED embed-sidecar (P-002, shared-embedding-sidecar-and-enrichment):
  // same re-exec divert — embed-sidecar-spawn.ts re-execs THIS bundled
  // serve.mjs with PAPERCUSP_EMBED_SIDECAR_MODE=1. The loopback HTTP server
  // keeps the process alive.
  if (process.env.PAPERCUSP_EMBED_SIDECAR_MODE === "1") {
    const { runEmbedSidecarServer } =
      await import("@papercusp/operator-core/lib/memory/embed-sidecar-server");
    runEmbedSidecarServer();
    return;
  }
  // PACKAGED inference-gateway sidecar (cross-platform-hardening P-006): same
  // re-exec divert — gateway-sidecar-spawn.ts re-execs THIS bundled serve.mjs
  // with PAPERCUSP_GATEWAY_SIDECAR_MODE=1 (a bundle has no tsx / no bin.ts on
  // disk). Mirror bin.ts's fatal policy: a startup failure exits 1 so the
  // supervisor's respawn loop restarts us, fail-closed. The gateway's HTTP
  // server keeps the process alive after a successful start.
  if (process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE === "1") {
    const { runGatewaySidecarMain, gatewayLogLine } =
      await import("@papercusp/operator-core/lib/inference-gateway/sidecar-main");
    runGatewaySidecarMain().catch((e) => {
      try {
        gatewayLogLine(`fatal: ${(e as Error)?.stack || String(e)}`);
      } catch {
        console.error("[inference-gateway] fatal:", e);
      }
      process.exit(1);
    });
    return;
  }
  // PACKAGED resource-governor live-health monitor. The same bundle re-exec
  // keeps this path available in the Tauri desktop without tsx or systemd.
  if (process.env.PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE === "1") {
    const { runLiveHealthMonitorMain } =
      await import("@papercusp/operator-core/lib/resource-governor/live-health-monitor-main");
    await runLiveHealthMonitorMain();
    return;
  }
  const args = new Set(argv);
  const ensure = args.has("--ensure");
  // Headless by default; --ui (or a pre-set PAPERCUSP_SERVE_UI) keeps the SPA.
  if (!args.has("--ui") && process.env.PAPERCUSP_SERVE_UI == null) {
    process.env.PAPERCUSP_SERVE_UI = "0";
  }

  // Guarantee the user's CLI tools (git, gh credential-helper, kopia, …) are on
  // PATH for everything this operator spawns. TWO failure modes this fixes:
  //  - Windows/WSL: the launcher forwards only the bundled bin dir
  //    (PAPERCUSP_SIDECAR_BIN); /usr/bin et al must be re-added or distro-binary
  //    spawns die ENOENT (found 2026-06-11, windows-desktop-release-readiness).
  //  - macOS: a packaged app's launchd PATH is minimal (/usr/bin:/bin:…) and
  //    OMITS /opt/homebrew/bin (Apple-Silicon Homebrew) — so the dogfood
  //    `git clone` couldn't find gh/git → "workspace setup failed" (found
  //    2026-06-25 via an owner Mac-VM setup failure). ensureToolPathEnv()
  //    sources the ONE canonical dir list (tool-path.ts) incl. /opt/homebrew,
  //    so detection (preflight/agent-auth-detect) and execution never drift.
  // Runs on darwin even without PAPERCUSP_SIDECAR_BIN (a GUI-launched sidecar
  // still has the minimal launchd PATH); on Linux we keep prior behavior (only
  // recompose when the launcher trimmed PATH via PAPERCUSP_SIDECAR_BIN).
  if (
    process.platform !== "win32" &&
    (process.env.PAPERCUSP_SIDECAR_BIN || process.platform === "darwin")
  ) {
    ensureToolPathEnv();
  }

  // The bind host is NEVER read from the generic `HOSTNAME` var: several
  // distros' /etc/profile export it as the machine name, which silently turned
  // this default into an off-box-reachable listen (open-source-release P-010;
  // same class as hono-host's audit P-027). Off-loopback is an explicit
  // PAPERCUSP_BIND_HOST opt-in, and it must carry a complete remote-auth policy
  // before any listen().
  const hostname = resolveBindHost();
  assertRemoteAuthReady(hostname);
  // EI-11342: an env-sidecar (ENV_OPERATOR_ID set) must never fall back to the
  // baked 3070 default — it would squat the prod operator's port on this box.
  const honoPortHint = resolveHonoPortHint(process.env, ENV_OPERATOR_ID);

  // D-043 / P-050: an immutable VM package must prove its package-contained
  // manifest and one-operator network/environment contract BEFORE --ensure can
  // adopt an already-running process. Non-vm-release profiles no-op here.
  assertVmReleaseRuntimePolicy({
    env: process.env,
    sidecarDir: dirname(fileURLToPath(import.meta.url)),
    hostname,
    port: honoPortHint,
  });

  // --ensure: reuse a healthy running operator and exit 0 — UNLESS it's a
  // DIFFERENT build (EI-9002). Before this check, an install-then-relaunch
  // would find the OLD operator still alive+healthy on the port (a Windows
  // taskkill of the desktop host never touches the inner WSL distro's node
  // process) and adopt it silently: every readiness marker passed while the
  // user kept running the pre-update build indefinitely. A mismatch now
  // gracefully kills the foreign operator and falls through to a fresh
  // cold-start below instead of returning early.
  if (ensure) {
    const reuse = await reconcileEnsure();
    if (reuse) {
      process.stdout.write(JSON.stringify(reuse) + "\n");
      return;
    }
  }

  // ⚠ ORDER IS LOAD-BEARING: resolve the port only AFTER the ensure block has
  // terminated a build-mismatched operator. That operator holds the remembered
  // sticky port, so resolving first made portAvailable() report it taken —
  // every update restart fell back to the launcher's fresh random hint and
  // MOVED the operator (observed live on the Windows VM: 17043 → 18384), then
  // persisted the new port as the memory. An update is exactly when pinned
  // client URLs (spawned members' MCP configs, --operator-url consumers) must
  // survive, so the sticky-port fix was defeated in its most important case.
  //
  // WI-3287: an env-sidecar sibling has a FIXED, well-known port per the
  // env-switcher contract (env-operator-launcher.ts's PROVISIONABLE_ENV_OPERATORS)
  // — it must never wander onto the PRIMARY's remembered sticky port (which
  // operator-port.json records for the primary alone; siblings must not read
  // OR write it — see the OPERATOR_JSON/OPERATOR_PORT_MEMORY guard below).
  const port = ENV_OPERATOR_ID
    ? honoPortHint
    : await resolveStickyPort(honoPortHint, hostname);
  // The sticky resolver may replace the launch hint; enforce the same forbidden
  // dev/local/staging port set on the effective listener too.
  assertVmReleaseRuntimePort(port, process.env);
  const httpUrl = `http://${hostname}:${port}`;

  // Cold-start race guard.
  if (!acquireColdStartLock()) {
    if (ensure) {
      // Another serve is starting — poll briefly for its operator.json.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const d = readOperatorDiscovery();
        if (d && pidAlive(d.pid) && (await httpAlive(d.httpUrl))) {
          log(`another serve won the race (pid ${d.pid}) — reusing`);
          process.stdout.write(JSON.stringify(d) + "\n");
          return;
        }
      }
    }
    throw new Error("another `serve` holds the cold-start lock; aborting");
  }

  let pg: PgHandle | null = null;
  let server: import("node:http").Server | null = null;
  let bootedHandlesPgPublisher: { stop(): void } | null = null;
  let shuttingDown = false;

  // ⚠ The critical cleanup below is SYNCHRONOUS by design. The async
  // version of this handler was observed (2026-06-06, bundled serve.mjs)
  // dying mid-shutdown: operator.json got removed but the process never
  // came back from `await pg.stop()` — the cold-start lock stayed held and
  // in one variant the postmaster was orphaned. The host graph bundles
  // signal-exit (via execa et al.), whose re-raise can kill the process at
  // the first yield; pg_ctl can also stall on an already-dying PG. Rather
  // than depend on surviving any await: remove the discovery file, release
  // the lock, and fast-shutdown the postmaster (SIGINT) all synchronously,
  // then attempt the graceful async stop as best-effort.
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} — shutting down`);
    // WI-2667: a hung graceful stop must NEVER leave this process alive. On
    // 2026-07-04 (packaged Mac dogfood) SIGTERM ran this handler — the sync
    // cleanup below stopped PG, but the async `await pg.stop()` never resolved
    // (pg_ctl stalled on the already-dying postmaster), so `process.exit(0)`
    // never ran. The operator stayed alive ~1h45m with PG down and every
    // background loop (DBOS executor, append-heavy invalidator, watchdogs)
    // flailing against a dead DB — an endless error storm — AND, because the
    // process never exited, launchd KeepAlive never respawned it, so PG never
    // came back. A ref'd hard deadline guarantees exit regardless of any
    // stalled await, which also restores crash-recovery (exit → launchd
    // respawn → fresh boot brings PG back up). The orchestration is extracted
    // into runShutdownWithDeadline so the HANG path has a unit recurrence guard
    // (shutdown-deadline.test.ts) — see shutdown-deadline.ts.
    runShutdownWithDeadline({
      deadlineMs: 4000,
      onForceExit: () =>
        log(`${sig} — shutdown deadline exceeded; force-exiting`),
      syncCleanup: () => {
        // EI-20952729544817284: this packaged entrypoint owns the cross-service
        // booted-handles publisher it starts below. Stop it synchronously before
        // PG teardown so no new heartbeat write races the shutdown path.
        bootedHandlesPgPublisher?.stop();
        bootedHandlesPgPublisher = null;
        try {
          server?.close?.();
        } catch {
          /* ignore */
        }
        // WI-3287: never unlink the PRIMARY's discovery file from a sibling shutdown.
        if (!REQUEST_ONLY_SIDECAR) {
          try {
            unlinkSync(OPERATOR_JSON);
          } catch {
            /* already gone */
          }
        }
        if (pg) {
          // The primary owns the box-wide advertisement only when it was
          // allowed to publish there. A refused publish uses the per-port
          // record below; env-sidecar siblings must never touch the primary's
          // global record.
          if (!REQUEST_ONLY_SIDECAR) {
            removeOwnedPgDiscoveryFile(EMBEDDED_PG_JSON, process.pid, pg.port);
          }
          removeOwnedPgDiscoveryFile(
            join(PAPERCUSP_DIR, `embedded-pg.${pg.port}.json`),
            process.pid,
            pg.port,
          );
        }
        if (pg) sigintPostmasterSync(resolvedPgDataDir());
        releaseColdStartLock();
      },
      // Best-effort graceful wait — a competing handler may kill us before this
      // completes; the sync work above already covered the essentials.
      gracefulStop: async () => {
        if (pg) await pg.stop().catch(() => {});
      },
      exit: (code) => process.exit(code),
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // EI-8894: a hard-killed desktop parent (launchctl kickstart -k, pkill -9,
  // a crash) never sends us SIGTERM — self-detect the reparenting and run
  // the SAME graceful teardown instead of surviving as an orphan.
  startParentDeathWatch(() => shutdown("PARENT_DEATH"));

  try {
    pg = await ensurePostgres();
    // Explicit readiness marker. The desktop smoke harness
    // (papercusp-desktop/bin/lib/federation-asserts.sh fed_wait_boot) greps
    // 'ready on localhost:<port> db=papercusp' to learn the PG port — the
    // standalone embedded-postgres-server bin used to print it; in-process
    // ownership (SP1 C5) moved the line here.
    if (pg) log(`embedded Postgres ready on localhost:${pg.port} db=papercusp`);

    // Import AFTER env is set: host-handler builds the Hono app at module load
    // (reading PAPERCUSP_SERVE_UI), and bootstrap/handler resolve the admin URL.
    // Correct every port-naming env to the RESOLVED port BEFORE the imports
    // below: host-handler/bootstrap read env at module load, and a stale
    // launcher hint here is the WI-3385 offline-banner root cause (see
    // exportResolvedPortEnv).
    exportResolvedPortEnv(port);

    const { serve } = await import("@hono/node-server");
    const hostedControlPlane = isHostedControlPlaneServeProfile();
    let requestHandler: (request: Request) => Promise<Response>;
    let hostedUpgrade: import("./hosted-handler").HostedHandler["upgrade"] | undefined;

    if (hostedControlPlane) {
      // D-051: never import the local handler or runBootstrap graph here. The
      // hosted module contains only the exact `/api` allowlist plus the shared
      // SPA, and its runtime constructor asserts mounted[] before returning.
      const { createHostedHandlerFromEnvironment } =
        await import("./hosted-handler");
      const hostedHandler = await createHostedHandlerFromEnvironment();
      requestHandler = hostedHandler.handler;
      hostedUpgrade = hostedHandler.upgrade;
    } else {
      const { runBootstrap } = await import("./host-bootstrap");
      const { handler } = await import("./host-handler");
      requestHandler = handler;
      runBootstrap();

      // EI-20952729544817284: the desktop bundle is built from THIS entrypoint,
      // not hono-host.ts. The latter already starts this publisher, but keeping
      // the library in serve.mjs through read-side imports did not execute it —
      // packaged substrate owners therefore never wrote their diagnostic row.
      // Start only after embedded PG is ready and bootstrap has installed the
      // substrate-owner state; the publisher self-gates on ownership every beat.
      const { startBootedHandlesPgPublisher } =
        await import("@papercusp/operator-core/lib/sync/hyperbee/substrate-booted-handles-pg");
      bootedHandlesPgPublisher = startBootedHandlesPgPublisher({});
    }

    server = serve({ fetch: requestHandler, port, hostname }, async (info) => {
      log(
        `listening on http://${hostname}:${info.port} (${hostedControlPlane ? "HOSTED CONTROL PLANE" : `UI ${process.env.PAPERCUSP_SERVE_UI === "0" ? "OFF" : "ON"}`})`,
      );
      // WI-3287: OPERATOR_JSON/OPERATOR_PORT_MEMORY are THE PRIMARY's discovery
      // records — Tauri's `--ensure` reuse check, the sticky-port memory, and
      // every external `--operator-url` consumer key off this ONE fixed path.
      // An env-sidecar sibling (ENV_OPERATOR_ID set) must never write it: it
      // would clobber the primary's own discovery with itself, breaking every
      // future `--ensure` / reconnect. Siblings are reached by direct port
      // navigation (the env switcher), not through this file.
      if (!REQUEST_ONLY_SIDECAR) {
        const discovery: OperatorDiscovery = {
          httpUrl,
          port: info.port,
          token: readToken(),
          pid: process.pid,
          processIdentity: readProcessIdentity(process.pid),
          startedAt: Date.now(),
          version: VERSION,
          sha: BUILD_SHA,
        };
        await writeJsonAtomic(OPERATOR_JSON, discovery);
        log(`wrote ${OPERATOR_JSON}`);
        try {
          // Port memory for the next boot (sticky port — see resolveStickyPort).
          // Optional state: a failed write must never affect the running boot.
          await writeJsonAtomic(OPERATOR_PORT_MEMORY, {
            port: info.port,
            updatedAt: Date.now(),
          });
        } catch (e) {
          log(
            `could not persist port memory (${(e as Error).message}) — next restart re-picks`,
          );
        }
      }
    }) as import("node:http").Server;
    if (hostedUpgrade) {
      const upgrade = hostedUpgrade;
      server.on("upgrade", (request, socket, head) => {
        void upgrade(request, socket, head)
          .then((handled) => {
            if (!handled) socket.destroy();
          })
          .catch(() => socket.destroy());
      });
    }
  } catch (e) {
    bootedHandlesPgPublisher?.stop();
    bootedHandlesPgPublisher = null;
    if (pg) {
      if (!REQUEST_ONLY_SIDECAR) {
        removeOwnedPgDiscoveryFile(EMBEDDED_PG_JSON, process.pid, pg.port);
      }
      removeOwnedPgDiscoveryFile(
        join(PAPERCUSP_DIR, `embedded-pg.${pg.port}.json`),
        process.pid,
        pg.port,
      );
    }
    releaseColdStartLock();
    if (pg) await pg.stop().catch(() => {});
    throw e;
  }
}

// Only auto-run when executed directly (so tests / other modules can import
// the helpers without booting a server). Symlink-robust (WI-1443): node
// realpaths import.meta.url while argv[1] keeps the invoked path (papercup ->
// papercusp), so also compare the realpath'd form.
const invokedDirectly = ((): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    // EI-7099: a raw `console.error('[serve] fatal:', e)` printed a bare
    // "undefined" during a real restart-race failure (embedded-PG rejecting
    // startup with "pre-existing shared memory block still in use") — some
    // upstream rejection in the embedded-pg boot chain loses the Error object
    // (a non-Error rejection reason, or a rejection with none at all), so the
    // one-liner carried zero diagnostic value and the run sat wedged
    // undiagnosable. Make this LAST-LINE-OF-DEFENSE handler informative
    // regardless of what shape `e` arrives in, instead of chasing every
    // possible upstream swallow point.
    const detail =
      e instanceof Error
        ? (e.stack ?? e.message)
        : e === undefined
          ? "(no error object — an upstream rejection carried no reason; check the PG boot log, e.g. the embedded-pg data dir's log file or serve.log tail, for the actual FATAL)"
          : (() => {
              try {
                return JSON.stringify(e);
              } catch {
                return String(e);
              }
            })();
    console.error("[serve] fatal:", detail);
    process.exit(1);
  });
}
