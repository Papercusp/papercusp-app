/**
 * @papercusp/host-platform — the host-boundary interface.
 *
 * The ~10% of papercusp that is genuinely host-specific: filesystem reads,
 * home-directory lookups, database URL resolution. Everything else (the
 * endpoint system, the orchestrator, business logic) is host-clean and
 * takes a `HostPlatform` when it needs the host.
 *
 * One interface, two impls:
 *   `./desktop` — node:fs + ~/.papercusp/embedded-pg.json + env fallback
 *   `./server`  — env-only; throws on any filesystem call
 *
 * Consumers either inject a `HostPlatform` explicitly (preferred — keeps the
 * dependency visible) or call `getHostPlatform()` to get the process-wide
 * default — whatever was registered via `registerHostPlatform()` during host
 * bootstrap. There is NO silent fallback: an unregistered host throws on the
 * first `getHostPlatform()` call (see the rationale on that function). Hosts
 * that register today: the operator Hono host (`bin/host-bootstrap.ts`) and
 * the agent-mcp stdio server (`server-entry.ts`) — both desktop.
 */

export interface HostPlatform {
  /**
   * Read a file as utf-8 text. Returns `null` if the file is missing or
   * unreadable — never throws for "expected" filesystem absence. (Throwing
   * would be wrong here: most call sites probe a list of candidate paths
   * and pick whichever exists. ENOENT-as-exception forces them all to
   * wrap try/catch.)
   *
   * Synchronous. Consumers call this on init paths + per-request inside
   * `definePrompt`/`defineResource` handlers; an async signature would
   * force callers to either go async themselves or block — both worse.
   * If a host genuinely cannot do sync fs (e.g. a future browser host),
   * the server stub already shows the answer: throw on call.
   */
  readTextFileSync(absolutePath: string): string | null;

  /**
   * Test whether a file exists on the host. `false` if the path is not a
   * file (directories return false). Mirrors `node:fs.existsSync` shape;
   * exists separately from `readTextFileSync` because some call sites only
   * need to probe presence without reading.
   */
  fileExistsSync(absolutePath: string): boolean;

  /**
   * The user's home directory — `os.homedir()` on the desktop impl. Used
   * by discovery-file lookups (`~/.papercusp/embedded-pg.json`,
   * `~/.papercusp/superuser-token`, etc.).
   */
  homedir(): string;

  /**
   * The harness-admin Postgres URL the operator should connect to.
   *
   * Resolution order on the desktop impl:
   *   1. `HARNESS_ADMIN_DATABASE_URL` / `DATABASE_URL` / `PAPERCUSP_PG_URL` env
   *   2. `~/.papercusp/embedded-pg.json` discovery file (written by the desktop's
   *      Rust main when embedded-pg comes up)
   *   3. `postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp` native fallback
   *
   * Resolution on the server stub:
   *   1. env only — throws if absent (no embedded-PG discovery on a server).
   */
  getHarnessAdminUrl(): string;
}

let registered: HostPlatform | null = null;

/**
 * Register the process-wide default `HostPlatform`. Idempotent — calling
 * twice with the same impl is a no-op; calling twice with different impls
 * throws (the host has to pick one).
 *
 * Called once during host bootstrap. Hosts that ship via `instrumentation.ts`
 * (Next, the operator-vite Hono node-server, the IPC bridge) should register
 * before any handlers run.
 */
export function registerHostPlatform(platform: HostPlatform): void {
  if (registered && registered !== platform) {
    throw new Error(
      'HostPlatform already registered with a different impl. ' +
        'A host registers exactly once during bootstrap.',
    );
  }
  registered = platform;
}

/**
 * Get the process-wide `HostPlatform`. Throws if nothing has been registered
 * — every host is required to call `registerHostPlatform()` during bootstrap.
 *
 * The throw is deliberate: a missing-registration "auto-default" hides
 * which host is actually in play (and forces this module to depend on its
 * own impl files, defeating the point of the separation). Hosts register
 * explicitly; tests register mocks or whichever impl they're exercising;
 * if you got here without a registration, the bug is in bootstrap order,
 * not in this module.
 *
 * Consumers may also receive a `HostPlatform` as an argument — that's
 * preferable in deeply-nested handlers where dependency-visibility matters.
 * This helper is for top-level entry points (prompt resolvers, tool
 * handlers) where threading the platform through every call would be noise.
 */
export function getHostPlatform(): HostPlatform {
  if (!registered) {
    throw new Error(
      'No HostPlatform registered. Hosts must call registerHostPlatform() ' +
        'during bootstrap (e.g. registerHostPlatform(desktopHostPlatform) ' +
        'in instrumentation-node.ts). Tests should register a mock or one ' +
        'of the provided impls before exercising code that calls ' +
        'getHostPlatform().',
    );
  }
  return registered;
}

/**
 * Test-only: clear the registration. Production code never calls this;
 * tests use it to swap between desktop/server/mock impls.
 */
export function _resetHostPlatformForTests(): void {
  registered = null;
}
