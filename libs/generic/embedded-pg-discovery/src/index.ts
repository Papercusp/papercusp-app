/**
 * Generic Postgres connection-URL discovery for desktop / local-first apps.
 *
 * Resolution order (configurable):
 *   1. Explicit env vars (first set wins), in the given order.
 *   2. A JSON discovery file written by the desktop host at boot
 *      (e.g. ~/.papercusp/embedded-pg.json) — reads its `url` field.
 *   3. A caller-supplied fallback URL (e.g. native PG for zero-config dev).
 *
 * Pure infra: no domain coupling. The Papercusp-specific configuration
 * (env var names, discovery path, native fallback) lives in the consumer
 * wrapper, not here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type PgUrlSource = 'env' | 'discovery-file' | 'fallback';

export interface PgUrlResult {
  url: string;
  source: PgUrlSource;
}

export interface DiscoveryConfig {
  /** Env var names checked in order; first non-empty wins. */
  envVars: string[];
  /**
   * Discovery file location. If `path` is absolute it is used as-is;
   * otherwise it is resolved under the user's home directory.
   * The file is JSON with a `url` string field.
   */
  discoveryFile?: { path: string };
  /** Last-resort connection string. */
  fallbackUrl: string;
}

/**
 * Resolve a Postgres URL per `config`. Pure (no caching) — callers that
 * want memoization wrap it (see the Papercusp `getHarnessAdminUrl`).
 */
export function resolvePgUrl(config: DiscoveryConfig): PgUrlResult {
  for (const name of config.envVars) {
    const v = process.env[name];
    if (v) return { url: v, source: 'env' };
  }

  if (config.discoveryFile) {
    const p = config.discoveryFile.path;
    const resolved = path.isAbsolute(p) ? p : path.join(os.homedir(), p);
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      const parsed = JSON.parse(raw) as { url?: string; pid?: number };
      // Liveness check: the file is written once at boot by the process that owns the
      // embedded-pg instance and is never cleaned up on an unclean exit (crash, SIGKILL,
      // host reboot) — so a STALE file from a long-dead writer otherwise wins forever over
      // the correct native-PG fallback, and every consumer (deploy tooling, a fresh `npm run
      // dev`, …) gets a permanent ECONNREFUSED on the recorded port until a human notices and
      // deletes the file. When the file records a `pid`, verify that process is still alive
      // (`process.kill(pid, 0)` — a same-host existence probe, no signal actually delivered;
      // reliable on POSIX, and Node documents it as usable for existence-checking on Windows
      // too) before trusting its port; a dead pid is treated exactly like a missing file
      // (fall through to the next source). No `pid` recorded (an older writer, or a caller
      // that never set one) preserves the prior unconditional-trust behavior — this is an
      // additive safety check, not a stricter file-format requirement.
      // TWO gates, because they answer different questions and the pid gate
      // alone was measured to be insufficient (see isPortListening).
      const pidLooksLive = parsed?.pid == null || isPidAlive(parsed.pid);
      const portLooksServed = pidLooksLive && isDiscoveredPortServed(parsed);
      if (parsed?.url && pidLooksLive && portLooksServed) {
        return { url: parsed.url, source: 'discovery-file' };
      }
    } catch {
      // file missing or unparseable — fall through
    }
  }

  return { url: config.fallbackUrl, source: 'fallback' };
}

/** Same-host process-existence probe: signal `0` delivers nothing, it only checks that the
 *  pid is a live process this user can signal. Cheap + synchronous (no network I/O), so it's
 *  safe to call on every {@link resolvePgUrl} invocation despite that function's "re-read per
 *  call, no caching" contract (see the discovery-port-changes-across-launches note on the
 *  Papercusp wrapper). Any thrown errno (ESRCH = gone, EPERM = alive but owned by another
 *  user — still "alive", so EPERM must NOT read as dead) is handled explicitly rather than a
 *  blanket catch, so a permissions quirk can't silently make a live port look stale. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Is the port the discovery file advertises actually being LISTENED on?
 *
 * ## Why the pid gate above is not enough (measured, 2026-08-01)
 *
 * `process.kill(pid, 0)` proves a process EXISTS. It does not prove that
 * process is SERVING. The writer advertises its port at STARTUP — the file's
 * own `startedAt` is stamped at the moment of the write — so there is a window
 * where the pid is alive and Postgres has not bound the port yet, or never
 * will because its bind failed. A consumer resolving in that window gets a live
 * pid and a dead port, and a pid-only gate waves it straight through.
 *
 * That is exactly what happened: a discovery file appeared advertising a port,
 * and 50 seconds later every consumer on the box was in an ECONNREFUSED storm
 * against it — with the pid gate already deployed and passing. The pid gate
 * checked the property that was easy to check rather than the property that
 * actually justifies trusting the file.
 *
 * ## Why this is a /proc read and not a TCP connect
 *
 * `resolvePgUrl` is SYNCHRONOUS and contractually re-resolves on every call
 * (the port changes across launches, so the answer must not be cached). A TCP
 * connect is asynchronous and cannot be awaited here without changing that
 * contract for every caller. Reading `/proc/net/tcp{,6}` answers the same
 * question synchronously, with no network I/O, no timers and no connection the
 * server has to accept and tear down.
 *
 * ## Degradation
 *
 * `/proc/net/tcp` is Linux-only. Where it is unavailable (macOS, Windows, a
 * container without /proc) this returns `true` — i.e. it declines to have an
 * opinion and leaves the pid gate as the only check, preserving the previous
 * behaviour rather than failing every resolution closed. A check that cannot
 * run must never be able to reject a healthy configuration.
 */
function isDiscoveredPortServed(parsed: { url?: string; port?: number }): boolean {
  const port = discoveredPort(parsed);
  if (port == null) return true; // nothing to check against — defer to the pid gate
  const listening = listeningPorts();
  if (listening === null) return true; // /proc unavailable — decline to judge
  return listening.has(port);
}

/** The advertised port: the explicit `port` field, else parsed from `url`. */
function discoveredPort(parsed: { url?: string; port?: number }): number | null {
  if (typeof parsed?.port === 'number' && Number.isInteger(parsed.port)) return parsed.port;
  if (!parsed?.url) return null;
  try {
    const p = new URL(parsed.url).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

/**
 * Ports in TCP_LISTEN state, from /proc. `null` means "cannot tell".
 *
 * Reads both tcp and tcp6: a server bound to `::` (dual-stack, the common
 * default) appears ONLY in tcp6, so checking tcp alone would report a
 * perfectly healthy port as dead — which would send every consumer to the
 * fallback and cause the very outage this function exists to prevent.
 */
function listeningPorts(): Set<number> | null {
  const TCP_LISTEN = '0A';
  const found = new Set<number>();
  let readAny = false;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw: string;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    readAny = true;
    for (const line of raw.split('\n').slice(1)) {
      // sl  local_address rem_address st ...  — local_address is HEXIP:HEXPORT
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== TCP_LISTEN) continue;
      const hexPort = cols[1]?.split(':')[1];
      if (!hexPort) continue;
      const port = parseInt(hexPort, 16);
      if (Number.isInteger(port)) found.add(port);
    }
  }
  return readAny ? found : null;
}
