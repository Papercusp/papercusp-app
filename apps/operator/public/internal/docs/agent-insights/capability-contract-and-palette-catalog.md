# The command palette and the agent MCP catalog are two registries unified at projection, not merged
URL: /internal/docs/agent-insights/capability-contract-and-palette-catalog

Ctrl+P commands come from lib/commands (Action Registry, browser-reflexive); agent tools come from defineTool/tooldef (server, gated). The Capability contract (lib/capabilities) unifies them at the read/projection layer with a §3 safety filter — it does NOT merge the two definition systems. Key gotchas: persona-axis ≠ RBAC-axis, :3070 serves a static build, runsIn mirrors CommandDef.browser.

## The two registries (and why they look like one)

There are **two** "invokable thing" registries, and they are easy to confuse:

1. **Action Registry** — `packages/operator-core/lib/commands/`. `CommandDef`s registered via
   `register()`. **Browser-reflexive**: they run in the tab (mutate DOM / nuqs / URL),
   `browser: 'required'|'optional'|'none'`. Surfaces: the ⌘K palette, keyboard shortcuts,
   voice, the mobile webhook. Discovery: `list({ kind:'command', agent:'palette' })`.

2. **tooldef / endpoint catalog** — `defineTool()` in `packages/operator-core/lib/agent-tools/`
   (+ `libs/generic/tooldef`, `packages/agent-mcp`). **Server-side, gated, audited**. Surfaces:
   the MCP transport (`papercusp-su` + in-app agents) and HTTP routes. Discovery:
   `getCatalog()` / `listAllProjectedTools()`.

They share **no** definition substrate. The only long-standing seam is
`packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-command.ts` — itself a `defineTool` route that
bridges an agent's command id to a live browser tab (`session-registry.deliver`). The
Action Registry's `types.ts` header still claims it's "the single source of truth for
Oracle/Pi MCP" — that's **stale**; conversational agents read the tooldef
`mcp__agentmcp__*` catalog (`packages/operator-core/lib/operator-mcp-tools.ts`).

## What `packages/operator-core/lib/capabilities/` does

Plan `capability-metadata-contract-2026-05-31`. The `Capability` contract unifies the two
**at the read/projection layer only** — it does **not** merge the definition systems (a
merge would re-couple browser concerns into the now-extracted host-agnostic
`@papercusp/tooldef`). Two read-only adapters map each registry into one `Capability[]`:
`from-action-registry.ts` and `from-tooldef.ts`. The palette then lists both; `Ctrl+P`
spans browser commands **and** the server tool catalog.

* `GET /api/agent-mcp/capabilities` — the §3-eligible, principal+role-gated server catalog.
* `POST /api/agent-mcp/run-tool` — loopback-only invoke; runs the tool through the **full
  dispatch stack with NO gate-bypass** (`lookupByMcpName` + `dispatchProjectedToolToMcp` +
  `PROJECTED_DEPS`), so role/capability/authorize/quota/audit all apply.
* `app/_components/use-server-capabilities.ts` — client fetch + execute + toast.

## Gotchas that will bite you

* **Persona/surface axis ≠ principal RBAC axis.** A `CommandDef.agents` entry like
  `'palette'`/`'operator'` is the **persona/surface** axis (→ `Capability.gating.agentRoles`
  * the `surfaces` overlay), **never** principal `auth.roles`. Conflating them is the exact
    bug RFC `tooldef-auth-rfc-2026-05-31`'s decision D-E forbids. The first draft of this
    plan's §4 made that mistake; see D-004.

* **The palette principal is just the request principal — no escalation.** On the desktop,
  `tryResolvePrincipal` → `principalFromLoopback` yields `kind:'loopback'`,
  `trust:'unverified-loopback'`, `capabilities: Set(['*'])`. Do **not** mint a higher-trust
  "trusted" palette principal — trust-gated tools correctly reject loopback, and the
  dispatch stack is the real boundary (D-005).

* **One-keystroke ≠ safe.** "principal-allowed + no-args" is NOT "safe to fire from a fuzzy
  palette with a toast." `safety-filter.ts` (`paletteEligibility`) excludes
  streaming/interactive/required-arg tools and forces a **confirm** step for
  destructive/`tier:high`. `run-tool` re-enforces this **server-side** (never trust the
  client) — destructive tools 409 without `confirmed:true`.

* **`runsIn` is 3-valued, mirroring `CommandDef.browser`** (`required`→browser,
  `none`→server, `optional`→hybrid). A binary server/browser split silently drops
  `browser:'optional'` (e.g. `chat.dispatch`).

* **`ToolDefinition` (from `getCatalog()`) has `tier` + `args`; `ProjectedTool` (from
  `listAllProjectedTools()`) has `agentRoles` + `expose` but NOT `tier`.** Use the catalog
  for risk/args, the projection for the role allowlist. Tooldef's `CapabilityTier` is
  `'low'|'medium'|'high'` — note **`medium`**, not `med`.

## Why your route change "doesn't show up" in the running desktop

The desktop webview loads **`:3070`, which serves a static pre-built `operator-vite/dist/`**
(hashed `/assets/index-*.js`, no Vite HMR). `:3055` is the live HMR dev server but the
webview does **not** use it. Consequences:

* **Client (UI) changes** need `npm --workspace @papercusp/operator-vite run build` **and** a
  webview reload (`DevReloadGate` suppresses auto-reload — `Ctrl/Cmd+R` is manual).
* **Server route changes** (`routes/index.ts`) need the **`:3070` hono host to restart** —
  it does not hot-reload new routes. Don't restart it casually: it's a shared service that
  also backs the `papercusp-su` MCP and other agents' sessions. Announce/get authorization
  first (see how the dogfood agents restarted `papercup-dev-api.service`).

This is why a freshly-added route can read `404` on `:3070` even though it's correctly
registered and the build is green — it's live only after the host restarts.
