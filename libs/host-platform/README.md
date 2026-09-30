# @papercusp/host-platform

The host-boundary interface for Papercusp. The ~10% of the system that is
genuinely host-specific — filesystem reads, home-directory lookups,
database-URL resolution — lives behind one swappable `HostPlatform`
adapter. Everything else (the endpoint system, the orchestrator, business
logic) stays host-clean and takes a `HostPlatform` when it needs the host.

## Layout

| Entry | Use where |
| --- | --- |
| `@papercusp/host-platform` | The `HostPlatform` interface + the registry (`getHostPlatform` / `registerHostPlatform`). Safe in any environment. |
| `@papercusp/host-platform/desktop` | Node impl: `node:fs` + `~/.papercusp/embedded-pg.json` + env fallback. The default for Tauri and the `npm run dev` operator. |
| `@papercusp/host-platform/server` | Env-only stub. Throws on any filesystem call — the answer for a future host that genuinely cannot do sync fs. |
| `@papercusp/host-platform/process-environment` | Internal PID-environment inspection: exact owning-spawn/procfs sources plus an explicitly best-effort macOS `ps eww` fallback. Raw results may contain credentials and must be allowlisted or redacted before crossing a diagnostic boundary. |

## Design

- **One interface, two impls.** Consumers either inject a `HostPlatform`
  explicitly (preferred — keeps the dependency visible) or call
  `getHostPlatform()` for the process-wide default. The default is
  whatever was registered via `registerHostPlatform()` during host
  bootstrap, or the desktop impl if nothing was registered.
- **`readTextFileSync` returns `null` for expected absence**, never throws
  for ENOENT — most call sites probe a list of candidate paths and pick
  whichever exists.
- **Synchronous by design.** Consumers call into the host on init paths
  and per-request inside `definePrompt`/`defineResource` handlers; an
  async signature would force callers to go async or block.

Extracted/audited per `papercusp-systems-abstraction-2026-05-29` (D-007):
zero `harness_shared.*` / `@papercusp/db-org` / domain-type imports.
