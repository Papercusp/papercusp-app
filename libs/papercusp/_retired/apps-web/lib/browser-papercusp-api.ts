/**
 * Phase 6b — browser-side PapercuspApi factory.
 *
 * Plugin UI components run in the browser but the SDK's `api: PapercuspApi`
 * contract has methods backed by Postgres / fs / secrets / etc. — all
 * server-only. This factory returns a Proxy that translates each method
 * call into a fetch() to /api/plugin-runtime/<slug>/<plugin>/<service>/<method>.
 *
 * The server-side dispatcher (app/api/plugin-runtime/[slug]/[plugin]/...
 * route.ts) builds a real PapercuspApi via buildPluginRuntime() and runs
 * the call. Capability checks happen server-side.
 *
 * Errors from the server are reified into typed exceptions so plugin
 * components can pattern-match — e.g. catching MissingCapabilityError to
 * surface a "Plugin needs additional permissions" UI.
 */

import type { PapercuspApi } from '@papercusp/plugin-sdk';

export class BrowserApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'BrowserApiError';
  }
}

export class MissingCapabilityError extends BrowserApiError {
  constructor(message: string, status: number, raw?: unknown) {
    super('missingCapability', message, status, raw);
    this.name = 'MissingCapabilityError';
  }
}

export class NotYetWiredError extends BrowserApiError {
  constructor(message: string, status: number, raw?: unknown) {
    super('notYetWired', message, status, raw);
    this.name = 'NotYetWiredError';
  }
}

interface BrowserApiOptions {
  /** Override the runtime endpoint base path. Default '/api/plugin-runtime'. */
  basePath?: string;
  /** Override fetch (tests). Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

async function callServer(
  slug: string,
  pluginName: string,
  service: string,
  method: string,
  args: unknown[],
  opts: BrowserApiOptions,
): Promise<unknown> {
  const f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = opts.basePath ?? '/api/plugin-runtime';
  const url = `${base}/${encodeURIComponent(slug)}/${encodeURIComponent(pluginName)}/${encodeURIComponent(service)}/${encodeURIComponent(method)}`;
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* keep null */ }

  if (res.ok && body?.ok === true) {
    return body.result;
  }

  const errCode = body?.error ?? 'http';
  const detail = body?.detail ?? body?.error ?? `HTTP ${res.status}`;
  if (errCode === 'missingCapability') {
    throw new MissingCapabilityError(detail, res.status, body);
  }
  if (errCode === 'notYetWired') {
    throw new NotYetWiredError(detail, res.status, body);
  }
  throw new BrowserApiError(errCode, detail, res.status, body);
}

function makeServiceProxy(
  slug: string,
  pluginName: string,
  service: string,
  opts: BrowserApiOptions,
): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        const method = String(prop);
        // Support promise-protocol pass-throughs if any caller does
        // `Promise.resolve(api.tasks)` etc.
        if (method === 'then' || method === 'catch' || method === 'finally') return undefined;
        return (...args: unknown[]) => callServer(slug, pluginName, service, method, args, opts);
      },
    },
  );
}

/**
 * Build a fetch-backed PapercuspApi for use inside browser plugin components.
 *
 * Usage:
 *   const api = makeBrowserApi(slug, pluginName);
 *   const tasks = await api.tasks.list({ status: 'todo' });
 */
export function makeBrowserApi(slug: string, pluginName: string, opts: BrowserApiOptions = {}): PapercuspApi {
  const tasks         = makeServiceProxy(slug, pluginName, 'tasks',         opts);
  const goals         = makeServiceProxy(slug, pluginName, 'goals',         opts);
  const pendingEvents = makeServiceProxy(slug, pluginName, 'pendingEvents', opts);
  const routines      = makeServiceProxy(slug, pluginName, 'routines',      opts);
  const comments      = makeServiceProxy(slug, pluginName, 'comments',      opts);
  const secrets       = makeServiceProxy(slug, pluginName, 'secrets',       opts);
  const storage       = makeServiceProxy(slug, pluginName, 'storage',       opts);
  const db            = makeServiceProxy(slug, pluginName, 'db',            opts);

  // fetch isn't a service-with-methods; it's just `api.fetch(input, init)`.
  const pluginFetch = ((input: string | URL, init?: RequestInit) =>
    callServer(slug, pluginName, 'fetch', 'fetch', [String(input), init], opts)
      .then((r: any) => {
        // The server dispatcher returns the raw fetch Response — but
        // Response objects don't survive JSON serialization. So on the
        // server side we'd need to serialize it. For v1, we pass through
        // and let the plugin author know that runtime.api.fetch crosses
        // the wire as JSON-only (stringified). Plugin authors should
        // prefer using their own apiRoutes for binary/streaming data.
        return r as Response;
      })) as typeof fetch;

  // Hooks bus: plugins on the browser side can't subscribe to host
  // hook events meaningfully (no shared event loop). We expose a
  // no-op shim that throws on subscribe to fail loudly.
  const hooks = {
    addAction: () => { throw new Error('PluginHookBus.addAction is not available in the browser. Use a server-side plugin (apiRoutes) to handle host hooks.'); },
    addFilter: () => { throw new Error('PluginHookBus.addFilter is not available in the browser.'); },
    emit: async () => { /* no-op */ },
  };

  return {
    tasks,
    goals,
    pendingEvents,
    routines,
    comments,
    secrets,
    fetch: pluginFetch,
    storage,
    db,
    hooks: hooks as any,
    capabilities: () => [],  // browser doesn't know — server enforces
  } as PapercuspApi;
}

/** Test helper — exposed for unit tests that want to drive an in-memory mock. */
export const _internals = {
  callServer,
};
