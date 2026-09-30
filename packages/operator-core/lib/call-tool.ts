/**
 * callTool / callToolStream / callRoute — the single client seam for hitting
 * operator endpoints. Plan: calltool-endpoint-seam-2026-06-01 (Phase A).
 *
 * The rule: client code calls ONLY these three — never `fetch('/api/…')`
 * directly. That makes the transport choice a single registry-driven decision
 * instead of a per-call-site one, so upgrading an endpoint to direct in-process
 * dispatch later (Phase E) is a server-side opt-in with zero client churn.
 *
 * Phase A is behavior-preserving:
 *   - Everything defaults to the route-preserving transport
 *     (`dispatchEndpointStreamHttp`), which on the desktop is carried over the
 *     `sys:http` IPC bridge by the fetch polyfill — off browser-pooled HTTP, with
 *     the real Hono route (auth/session, workspace RLS, cost-caps, persistence)
 *     intact. Off-desktop it is a plain HTTP request. (D-001/D-002.)
 *   - Direct dispatch (`dispatchEndpointStreamIpc`) is chosen ONLY for a tool the
 *     injected resolver marks `directEligible` AND only on the desktop. The
 *     default resolver never marks anything eligible, so direct dispatch is OFF
 *     until Phase E wires registry-backed eligibility + the RequestContext parity
 *     (D-003). This is the gate that keeps the route-bypass footgun closed.
 *
 * Request context (P-003): the route-preserving path already carries the
 * workspace scope via the existing `installWorkspaceHeaderFetch` polyfill (the
 * `sys:http`/HTTP request rides the header → route → ALS → RLS GUC). So nothing
 * new is needed here for Phase A. Direct dispatch has no HTTP request to hang a
 * header on, so it must apply an explicit RequestContext server-side — that is
 * Phase E's `P-008` work, not this module's.
 *
 * `callRoute` is also the single place to instrument IPC traffic for the dev
 * inspector (Phase C, P-006).
 *
 * Generic-lift note: this is resolver-injected and domain-free except for the
 * default route convention; if a second host needs it, lift it into
 * `@papercusp/desktop-ipc` with the resolver as the only host seam.
 */
import {
  dispatchEndpointStreamHttp,
  dispatchEndpointStreamIpc,
  type EndpointStreamEvent,
  type DispatchEndpointStreamOptions,
} from '@papercusp/desktop-ipc';

/** Terminal result of a unary tool call (the `done` event's payload). */
export type ToolResult = { content: Array<{ type: string; [k: string]: unknown }> };

/** What the host's registry tells `callTool` about one endpoint. */
export interface ToolResolution {
  /**
   * Canonical route path for the route-preserving (sys:http / HTTP) transport —
   * the actual Hono route whose semantics must be preserved (may be a custom
   * shim, not the generic projected path).
   */
  route: string;
  /**
   * True iff the tool's handler is fully self-contained — it performs every
   * auth / workspace-RLS / cost-cap / persistence / audit effect its route did,
   * and is therefore safe to call directly (bypassing the route). The default
   * resolver always returns false (Phase A); Phase E flips it per audited tool
   * with a parity test (D-003).
   */
  directEligible: boolean;
}

export type ToolResolver = (name: string) => ToolResolution;

/**
 * Default resolver: the framework projected path, never direct-eligible. Hosts
 * override via {@link configureCallTool} to supply real per-tool routes + the
 * (Phase-E) eligibility flag.
 */
const defaultResolver: ToolResolver = (name) => ({
  route: `/api/agent-tools/${name.replaceAll(':', '/')}`,
  directEligible: false,
});

let resolver: ToolResolver = defaultResolver;

/** Inject the host's registry-backed resolver (canonical route + eligibility). */
export function configureCallTool(r: ToolResolver): void {
  resolver = r;
}

/** Reset to the default resolver (tests). */
export function resetCallTool(): void {
  resolver = defaultResolver;
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  // Mirror the desktop-ipc feature-detect; don't import @tauri-apps' `isTauri`
  // (not statically importable from SSR contexts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Boolean((window as any).__TAURI_INTERNALS__?.invoke);
}

export interface CallToolOptions extends DispatchEndpointStreamOptions {
  /**
   * Override the canonical route for this call (rare — for a tool whose shim
   * differs from what the resolver returns). Ignored on the direct path.
   */
  route?: string;
}

/**
 * Streaming endpoint call — yields the tool's `EndpointStreamEvent`s to a
 * terminal (`done` / `error`). The transport is picked here, once, from the
 * resolver; consumers never see it.
 */
export function callToolStream<TInput>(
  name: string,
  input: TInput,
  opts: CallToolOptions = {},
): AsyncIterable<EndpointStreamEvent> {
  const { route, directEligible } = resolver(name);
  // D-001: default to the route-preserving transport. Direct dispatch only for an
  // eligible (self-contained) tool, and only on the desktop where IPC exists.
  if (directEligible && isTauri()) {
    return dispatchEndpointStreamIpc(name, input, opts);
  }
  return dispatchEndpointStreamHttp(name, input, {
    ...opts,
    overrideUrl: opts.route ?? route,
  });
}

export class CallToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CallToolError';
    this.code = code;
  }
}

/**
 * Unary endpoint call — drains the stream and returns the terminal
 * {@link ToolResult}. Throws {@link CallToolError} on an `error` terminal or if
 * the stream ends without one.
 */
export async function callTool<TInput>(
  name: string,
  input: TInput,
  opts: CallToolOptions = {},
): Promise<ToolResult> {
  for await (const ev of callToolStream(name, input, opts)) {
    if (ev.kind === 'done') return ev.result;
    if (ev.kind === 'error') throw new CallToolError(ev.code, ev.message);
  }
  throw new CallToolError('no_terminal', `callTool('${name}') stream ended without done/error`);
}

/**
 * Arbitrary NON-tool route call (sync `rest-query`, plugin routes, anything not
 * registry-shaped). On the desktop the same-origin `/api/*` fetch is carried
 * over `sys:http` by the polyfill (off browser-pooled HTTP); elsewhere it's a
 * plain fetch. Always route-preserving — only `callTool` is ever upgraded to
 * direct dispatch (D-002). Kept as a thin, named wrapper so the "never raw
 * `fetch('/api/…')`" rule is enforceable + greppable, and so there's one place to
 * hang the dev IPC inspector (Phase C).
 */
export function callRoute(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, init);
}
