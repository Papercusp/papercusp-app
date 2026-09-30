# Never hardcode PG port — use the liveness-gated resolver
URL: /internal/docs/agent-insights/embedded-pg-discovery

Embedded Postgres uses a discovered port that can become stale after an unclean shutdown. Resolve through the application or scripts/pg-url.mjs liveness-gated resolver instead of reading embedded-pg.json directly.

## What

Papercusp ships with **embedded Postgres**, not a host-installed PG.
On desktop boot, the embedded-pg process picks an available port and
writes its connection info to:

```
~/.papercusp/embedded-pg.json
```

Agents and the webapp resolve the connection via
`getHarnessAdminUrl()` (from `packages/operator-core/lib/embedded-pg-discovery.ts`;
the generic resolver is `resolvePgUrl` in `libs/generic/embedded-pg-discovery`),
which reads this file. `getHarnessPg(slug)` (per-harness scoped) lives in
`libs/papercusp/libs/db/src/connection.ts`. The port is **not** stable — it can
shift between boots, machines, and Papercusp installs.

### Caching: only the `env` source is safe to pin — re-read `discovery`/`fallback` every call

`getHarnessAdminUrlWithSource()` caches its result **only** when the resolved
source is `env` (`HARNESS_ADMIN_DATABASE_URL` etc. — injected once by Tauri
main and stable for the process lifetime). A `discovery-file` or `fallback`
result is **re-resolved on every call** — never cached. This isn't
incidental: the embedded-pg.json port genuinely *changes* across boots (the
desktop's Rust main picks a fresh free port each launch), and a caller that
memoized an early `discovery`/`fallback` read (e.g. before `serve` rewrote
the discovery file for *this* boot) would pin a previous launch's stale
port for the whole process lifetime. That exact bug wedged every later
LISTEN/query on a dead port on Windows/WSL — the WSL distro persists the
prior-boot `embedded-pg.json` across launches, so a memoized early read is
guaranteed stale there (fixed 2026-07-02). `connection.ts`'s `adminUrl()` /
`appUrl()` follow the identical contract: cache `env`, re-read + invalidate
the cached pool on every `discovery` change, never cache the native
fallback. If you write a NEW caller around `resolvePgUrl`, mirror this —
memoizing a `discovery`/`fallback` result is the bug class to avoid.

## Why it matters

Code that hardcodes `:5432` (host PG default) or `:16534` (an older
embedded-pg default we've seen) works on the developer's laptop and
**breaks silently on every other machine**. Symptoms:

* "Connection refused" on a freshly cloned machine.
* Tests that pass locally and fail in CI.
* An agent's `psql` invocation that returns nothing because it
  connected to the *wrong* PG instance — possibly the user's
  unrelated host PG, leading to confusing query results.
* A shell caller that reads `embedded-pg.json` directly after an unclean
  shutdown and receives a stale port, even though the application resolver
  would reject that advertisement and choose the live target.

The native-PG path (`:5432`) is also being retired (memory:
`project_papercusp_pg_topology` — "public release = desktop +
embedded-pg only; native PG :5432 + webapp are dev crutches going
away"). Don't assume it'll be there.

## How to apply

* **Always resolve PG connections through `getHarnessAdminUrl()`**
  (admin role) or `getHarnessPg(slug)` (per-harness scoped).
* **For repo/dev shell scripts**, use the same liveness-gated resolver through
  `scripts/pg-url.mjs` rather than parsing `embedded-pg.json` yourself:
  ```bash
  # Safe provenance only; never prints credentials.
  node scripts/pg-url.mjs --describe

  # Preferred: keep the password out of the process argv.
  eval "$(node scripts/pg-url.mjs --export)"
  psql -c 'SELECT 1'
  ```
  The resolver checks explicit environment configuration and isolated test-PG
  ownership first, then validates discovery-file liveness before using it, and
  only then falls back to the native PG URL. Its default mode connects and runs
  `SELECT 1`, so a dead advertisement fails at resolution time with provenance
  instead of producing a later unexplained `ECONNREFUSED`. The
  `--export` form is preferred because a DSN passed as a command argument is
  visible to other processes on this shared host.
* **For packaged/sidecar shells without the repo script**, do not treat
  `~/.papercusp/embedded-pg.json` as proof of liveness. Use the packaged
  application's resolver when available; if it is absent or the file is missing,
  surface that as an unresolved database target rather than guessing a port.
* **Never write a config file** that bakes a PG port at install time.
  Resolve at runtime.
