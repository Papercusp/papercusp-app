# @papercusp/flags

Feature flags for Papercusp. Evaluated server-side via PostHog; clients
never load any PostHog SDK.

## Layout

| Entry | Use where |
| --- | --- |
| `@papercusp/flags` | Shared types (`FLAGS`, `FlagKey`, `FLAG_DEFAULTS`). Safe in any environment. |
| `@papercusp/flags/server` | `posthog-node` wrapper. Server-only (Hono routes, MCP tools, SSR). |
| `@papercusp/flags/client` | Zero-dependency reader. Reads from `/api/flags/bootstrap` and an SSE stream. |
| `@papercusp/flags/test` | Test-only override stash. Used by vitest/playwright setups. |

## Design

- The user's machine never connects to PostHog. The Papercusp backend
  evaluates flags and returns resolved booleans over HTTP/SSE.
- If PostHog is unreachable, every flag returns its
  `FLAG_DEFAULTS[key]` value (fail-safe-closed — V1 ship state is "off").
- Flag keys, defaults, and the full set live in `src/types.ts`. Editing
  that file is the only place a flag name should appear outside PostHog.

## Configuration

The server reads PostHog connection info from `~/.papercusp/posthog.json`
(via `apps/operator/lib/posthog-config.ts`). The discovery file is created
during Phase 1 of the V1 feature-flag plan.
