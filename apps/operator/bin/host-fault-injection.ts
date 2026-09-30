/**
 * host-fault-injection — env-gated operator-side fault injection (EI-297).
 *
 * Desktop e2e cannot put an HTTP fault proxy in front of `/api`: the Tauri
 * webview's API traffic rides the IPC-first path straight into this host, so
 * the round-2 impersonation plan's server-error legs (§12.7 — "settings save
 * 500", timeout handling, etc.) were untestable as-a-user. This middleware
 * moves the fault into the host itself:
 *
 *   - DEFAULT OFF. Everything here is inert unless the host was started with
 *     `PAPERCUSP_FAULT_INJECTION=1` (a test-only env gate, not a product
 *     feature flag — a fault-injecting production host is never correct).
 *   - Rules are IN-MEMORY by design (storage-policy exception: deliberately
 *     ephemeral test state — a host restart clearing all faults is a safety
 *     feature, not a bug).
 *   - Control plane (loopback-only, same guard as the internal docs):
 *       GET    /api/admin/fault-injection          → { enabled, rules }
 *       POST   /api/admin/fault-injection          → add a rule, returns { rule }
 *       DELETE /api/admin/fault-injection[?id=...] → clear one rule / all rules
 *   - Rule shape: { pathPrefix, method?, status?, body?, delayMs?, times? }
 *       pathPrefix — request path must start with this (e.g. "/api/profile")
 *       method     — optional exact match (GET/POST/...)
 *       status     — fault response status (default 500). Omit WITH delayMs
 *                    set for a delay-only rule that then falls through.
 *       body       — JSON body for the fault response
 *                    (default { error: 'fault-injection' })
 *       delayMs    — wait this long before responding / falling through
 *       times      — auto-expire after N matches (default: until deleted)
 *
 * The middleware never matches its own control plane, so a fault rule for
 * "/api" can't lock you out of clearing it.
 */
import { Hono, type Context, type Next } from 'hono';
import { isLoopbackHost } from '@papercusp/operator-core/lib/endpoint-route/loopback-guard';

export interface FaultRule {
  id: string;
  pathPrefix: string;
  method?: string;
  status?: number;
  body?: unknown;
  delayMs?: number;
  /** Remaining matches before the rule auto-expires; undefined = unlimited. */
  times?: number;
}

const CONTROL_PATH = '/api/admin/fault-injection';

export function faultInjectionEnabled(): boolean {
  return process.env.PAPERCUSP_FAULT_INJECTION === '1';
}

const rules: FaultRule[] = [];
let seq = 0;

/** Test seam — reset the in-memory rule store between cases. */
export function _resetFaultRules(): void {
  rules.length = 0;
  seq = 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function matchRule(path: string, method: string): FaultRule | undefined {
  return rules.find(
    (r) => path.startsWith(r.pathPrefix) && (!r.method || r.method.toUpperCase() === method),
  );
}

/** Fault middleware for `/api/*` — inert (single env check) when disabled. */
export async function faultInjectionMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (!faultInjectionEnabled() || rules.length === 0) return next();
  const path = new URL(c.req.url).pathname;
  if (path.startsWith(CONTROL_PATH)) return next();
  const rule = matchRule(path, c.req.method.toUpperCase());
  if (!rule) return next();
  if (typeof rule.times === 'number') {
    rule.times -= 1;
    if (rule.times <= 0) rules.splice(rules.indexOf(rule), 1);
  }
  if (rule.delayMs && rule.delayMs > 0) await sleep(rule.delayMs);
  if (rule.status == null && rule.delayMs) return next(); // delay-only rule
  return c.json(
    (rule.body as object | undefined) ?? { error: 'fault-injection', rule: rule.id },
    (rule.status ?? 500) as 500,
  );
}

/** Control-plane routes — mounted only when the env gate is on. */
export function faultInjectionControl(): Hono {
  const app = new Hono();

  const loopbackGuard = async (c: Context, next: Next) => {
    const host = c.req.header('host') ?? '';
    if (!isLoopbackHost(host)) {
      return c.json({ error: 'fault-injection control is loopback-only' }, 403);
    }
    return next();
  };

  app.get(CONTROL_PATH, loopbackGuard, (c) =>
    c.json({ enabled: faultInjectionEnabled(), rules }),
  );

  app.post(CONTROL_PATH, loopbackGuard, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<FaultRule> | null;
    if (!body || typeof body.pathPrefix !== 'string' || !body.pathPrefix.startsWith('/')) {
      return c.json({ error: 'pathPrefix (string, starting with /) is required' }, 400);
    }
    if (body.status == null && !body.delayMs) {
      return c.json({ error: 'set status (fault) and/or delayMs (latency)' }, 400);
    }
    const rule: FaultRule = {
      id: `fault-${++seq}`,
      pathPrefix: body.pathPrefix,
      ...(body.method ? { method: String(body.method).toUpperCase() } : {}),
      ...(body.status != null ? { status: Number(body.status) } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.delayMs ? { delayMs: Number(body.delayMs) } : {}),
      ...(typeof body.times === 'number' ? { times: body.times } : {}),
    };
    rules.push(rule);
    return c.json({ rule }, 201);
  });

  app.delete(CONTROL_PATH, loopbackGuard, (c) => {
    const id = c.req.query('id');
    if (id) {
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) return c.json({ error: `no rule ${id}` }, 404);
      rules.splice(i, 1);
      return c.json({ ok: true, removed: id });
    }
    const n = rules.length;
    rules.length = 0;
    return c.json({ ok: true, removed: n });
  });

  return app;
}
