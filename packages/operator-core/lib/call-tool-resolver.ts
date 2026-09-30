/**
 * Operator-side resolver for the `callTool` seam. Plan:
 * calltool-endpoint-seam-2026-06-01 (Phase A, P-001).
 *
 * Maps a projected-tool name → its canonical route + (Phase E) direct-dispatch
 * eligibility, then installs it via `configureCallTool`.
 *
 * Why a map, not a pure convention: operator tools are reached at heterogeneous
 * routes — the framework default `/api/agent-tools/<name>`, the
 * `/api/agent-mcp/operator-<verb>` shims, and bespoke shims (`oracle:chat` →
 * `/api/oracle/chat`). The canonical route is the one the tool's CURRENT
 * consumers hit, so migrating a call site to `callTool(name)` stays
 * behavior-preserving. We can't introspect the projected registry on the client
 * (importing it pulls server code into the SPA bundle — the blank-page trap,
 * see `operator-vite-spa-server-leak-blank-page`), so the routes are an explicit
 * map seeded with the direct-dispatch candidates (the self-contained streaming
 * tools) and grown / verified per call site during the Phase B migration.
 *
 * NOT callTool(name) candidates: parameterized routes (`agent_chats:chat` →
 * `/api/harness/<slug>/agent-chats/<id>/messages`; harness-scoped brainstorm /
 * architect) carry path params, so they migrate to `callRoute(builtPath)`.
 *
 * `directEligible` is `false` for everything in Phase A — direct dispatch is off
 * until Phase E flips it per audited tool with a RequestContext parity test
 * (D-003). The route-preserving (`sys:http`) default already carries workspace
 * scope via `installWorkspaceHeaderFetch`, so this is behavior-preserving today.
 */
import { configureCallTool, type ToolResolution } from './call-tool';

/**
 * Tool name → canonical route (the shim its consumers currently hit). Seeded
 * with the verified static-route streaming tools; extend per call site during
 * the Phase B migration after confirming the route matches the consumer's
 * current `fetch`.
 */
const TOOL_ROUTES: Record<string, string> = {
  'oracle:chat': '/api/oracle/chat',
  'operator:converse': '/api/agent-mcp/operator-converse',
};
// ('operator:scan' was removed with the scanner card stream —
// unify-agent-launches D-005; scans now fire the `scan` launch blueprint.)
// ('operator:delegate' was retired 2026-06-21; the old delegate-chat route is
// a 410 tombstone, not a live tool route.)

/**
 * Phase E — tools eligible for DIRECT in-process dispatch on desktop (endpoint
 * _invoke bypasses the loopback-HTTP route replay; lower latency). A tool is
 * eligible ONLY if it is SELF-CONTAINED — every auth/session, budget, and
 * persistence side-effect lives in the HANDLER, not the route — because direct
 * dispatch skips the route. This set is exactly the documented self-contained,
 * NON-parameterized streaming tools, and it mirrors the server-side IPC
 * allowlist (`expose: { ipc: true }`) locked by ipc-allowlist.test.ts:
 *   - operator:converse  — prompt+budget+spend+mem0 in the handler
 * EXCLUDED: oracle:chat / agent_chats:chat (route-dependent — the closed
 * footgun); architect:chat / brainstorm:chat (harness-scoped parameterized
 * routes — they migrate to `callRoute(builtPath)`, not name-based direct dispatch).
 *
 * Effect today: LATENT. Nothing client-side calls `callTool` for these yet, so
 * flipping this is a zero-behavior-change capability switch — it only takes
 * effect when a call site migrates to `callTool(name)` on desktop. The route
 * stays the browser fallback (callToolStream uses direct only when isTauri()).
 * D-003's per-tool RequestContext parity test should accompany the FIRST live
 * call-site migration of each tool (verifies handler-via-direct == handler-via-route).
 */
const DIRECT_ELIGIBLE = new Set<string>([
  'operator:converse',
]);

export function operatorToolResolver(name: string): ToolResolution {
  return {
    route: TOOL_ROUTES[name] ?? `/api/agent-tools/${name.replaceAll(':', '/')}`,
    directEligible: DIRECT_ELIGIBLE.has(name),
  };
}

/**
 * Install the operator resolver into the `callTool` seam. Call once at app init
 * (RootSyncProvider, module-eval). Idempotent — re-registers the same resolver.
 */
export function installCallToolResolver(): void {
  configureCallTool(operatorToolResolver);
}
