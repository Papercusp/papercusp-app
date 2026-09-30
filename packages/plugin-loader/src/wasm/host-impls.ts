/**
 * G2c — JS-side implementations of the WIT-imported interfaces that
 * WASM plugins call into. Each function consults the existing
 * capability granter (capabilities.ts) before doing anything; same
 * security model JS plugins already operate under, just exposed
 * through jco-transpiled bindings.
 *
 * These implementations are passed to the jco-transpiled module as
 * the `imports` argument when the wasm component is instantiated.
 * jco's binding machinery routes each WIT call to the matching
 * function here.
 *
 * WIT interfaces covered (mirrors @papercusp/plugin-wit/wit/v0_1_0/plugin.wit):
 *   - logging   — log() — always allowed; no cap; rate-limit at sink
 *   - http      — fetch() — gated by http:fetch:<host>
 *   - secrets   — get(name) — gated by secrets:read:<NAME>
 *   - events    — emit(name, payload) — namespace check + token bucket
 *   - compute   — exec(req) — gated by compute:exec:<bin>; per-host policy
 *
 * The plugin-exported interfaces (lifecycle, actions) are CALLED by the
 * host, not implemented here. Those live in wasm-plugin-host.ts.
 */

import { hasCapability, type CapabilityCheckContext } from '../capabilities';

/**
 * Per-plugin context that all host-impls have access to. Mirrors the
 * Rust runtime's PluginCtx shape: plugin id, granter context, secrets
 * map, event sink, audit sink, rate-limit bucket, compute policy.
 */
export interface WasmHostCtx {
  /** Plugin id from manifest.name. Used in audit + event attribution. */
  pluginId: string;
  /** Capability check context (used by hasCapability). */
  capCtx: CapabilityCheckContext;
  /** In-memory secrets store. Production swap-target: PG-backed. */
  secrets: Map<string, string>;
  /** Where emitted events go. */
  eventSink: EventSink;
  /** Where audit rows go. */
  auditSink: AuditSink;
  /** Per-plugin event-emit rate limit. */
  eventBucket: TokenBucket;
  /** What compute.exec should do. */
  computeRuntime: ComputeRuntime;
}

export interface EventSink {
  deliver(pluginId: string, eventName: string, payload: Uint8Array): void;
}

export interface AuditSink {
  record(row: AuditRow): void;
}

export interface AuditRow {
  ts: Date;
  pluginId: string;
  /** "logging" | "http" | "secrets" | "events" | "compute" | "actions" */
  interface: string;
  /** "log" | "fetch" | "get" | "emit" | "exec" | "invoke" */
  method: string;
  outcome: 'ok' | 'capability-denied' | 'invalid-input' | 'rate-limited' | 'transport' | 'not-found';
  detail: string;
}

/**
 * Token bucket for events.emit rate limiting. Mirrors Rust's
 * fractional-token impl in wasm.rs. Default capacity 100, refill 100/s.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(public capacity: number, public refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  tryConsume(): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export type ComputeRuntime =
  | { kind: 'disabled' }
  | { kind: 'unsandboxed-spawn'; pathSnapshot: string[] }
  | { kind: 'bwrap-sandboxed'; pathSnapshot: string[]; bwrapBinary: string; shareNetDefault: boolean };

const AUDIT_DETAIL_MAX_BYTES = 1024;

function truncateDetail(s: string): string {
  if (s.length <= AUDIT_DETAIL_MAX_BYTES) return s;
  return s.slice(0, AUDIT_DETAIL_MAX_BYTES) + '…[truncated]';
}

function audit(ctx: WasmHostCtx, opts: Pick<AuditRow, 'interface' | 'method' | 'outcome' | 'detail'>) {
  ctx.auditSink.record({
    ts: new Date(),
    pluginId: ctx.pluginId,
    interface: opts.interface,
    method: opts.method,
    outcome: opts.outcome,
    detail: truncateDetail(opts.detail),
  });
}

/* ───── logging ─────────────────────────────────────────────────────── */

export function makeLoggingHost(ctx: WasmHostCtx) {
  return {
    log(entry: { level: string; message: string; fields: [string, string][] }) {
      // Audit BEFORE forwarding — captures call attempt even if the
      // logger panics. Detail is metadata only; message content is
      // plugin-private + never goes in audit.
      audit(ctx, {
        interface: 'logging',
        method: 'log',
        outcome: 'ok',
        detail: `level=${entry.level} msg_len=${entry.message.length} fields=${entry.fields.length}`,
      });
      // Production: forward to operator's logging subsystem. For
      // v0.1.0 we just write to console.
      const tag = `[${ctx.pluginId}/${entry.level}]`;
      // eslint-disable-next-line no-console
      console.log(tag, entry.message);
    },
  };
}

/* ───── http ────────────────────────────────────────────────────────── */

export function makeHttpHost(ctx: WasmHostCtx) {
  return {
    async fetch(req: {
      method: string;
      url: string;
      headers: [string, string][];
      body: Uint8Array | undefined;
    }): Promise<{ tag: 'ok'; val: { status: number; headers: [string, string][]; body: Uint8Array } } | { tag: 'err'; val: unknown }> {
      let parsed: URL;
      try {
        parsed = new URL(req.url);
      } catch (e) {
        audit(ctx, { interface: 'http', method: 'fetch', outcome: 'invalid-input', detail: `url-parse-failed: ${e}` });
        return { tag: 'err', val: { tag: 'invalid-request', val: `url parse: ${e}` } };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        audit(ctx, { interface: 'http', method: 'fetch', outcome: 'invalid-input', detail: `unsupported-scheme: ${parsed.protocol}` });
        return { tag: 'err', val: { tag: 'invalid-request', val: `unsupported scheme: ${parsed.protocol}` } };
      }
      const host = parsed.hostname;
      const capStr = `http:fetch:${host}`;
      if (!hasCapability(ctx.capCtx, capStr)) {
        audit(ctx, { interface: 'http', method: 'fetch', outcome: 'capability-denied', detail: `cap=${capStr}` });
        return { tag: 'err', val: { tag: 'capability-denied', val: `cap ${capStr} not granted` } };
      }
      try {
        const resp = await globalThis.fetch(req.url, {
          method: req.method.toUpperCase(),
          headers: Object.fromEntries(req.headers),
          body: req.body && req.body.length > 0 ? req.body : undefined,
        });
        const respBody = new Uint8Array(await resp.arrayBuffer());
        const respHeaders: [string, string][] = [];
        resp.headers.forEach((v, k) => respHeaders.push([k, v]));
        audit(ctx, {
          interface: 'http',
          method: 'fetch',
          outcome: 'ok',
          detail: `cap=${capStr} status=${resp.status} body_len=${respBody.length}`,
        });
        return { tag: 'ok', val: { status: resp.status, headers: respHeaders, body: respBody } };
      } catch (e) {
        audit(ctx, { interface: 'http', method: 'fetch', outcome: 'transport', detail: `cap=${capStr} send-failed: ${e}` });
        return { tag: 'err', val: { tag: 'transport', val: `${e}` } };
      }
    },
  };
}

/* ───── secrets ─────────────────────────────────────────────────────── */

const SECRETS_NAME_RE = /^[A-Za-z0-9_]{1,256}$/;

export function makeSecretsHost(ctx: WasmHostCtx) {
  return {
    get(name: string): { tag: 'ok'; val: string } | { tag: 'err'; val: unknown } {
      if (!SECRETS_NAME_RE.test(name)) {
        audit(ctx, { interface: 'secrets', method: 'get', outcome: 'invalid-input', detail: 'invalid-name-charset-or-length' });
        return { tag: 'err', val: { tag: 'invalid-name', val: `bad secret name shape` } };
      }
      const capStr = `secrets:read:${name}`;
      if (!hasCapability(ctx.capCtx, capStr)) {
        audit(ctx, { interface: 'secrets', method: 'get', outcome: 'capability-denied', detail: `cap=${capStr}` });
        return { tag: 'err', val: { tag: 'capability-denied', val: `cap ${capStr} not granted` } };
      }
      const v = ctx.secrets.get(name);
      if (v === undefined) {
        audit(ctx, { interface: 'secrets', method: 'get', outcome: 'not-found', detail: `cap=${capStr} name=${name}` });
        return { tag: 'err', val: { tag: 'not-found', val: `no secret ${name}` } };
      }
      // SUCCESS: detail records value byte-length only. NEVER the value.
      audit(ctx, { interface: 'secrets', method: 'get', outcome: 'ok', detail: `cap=${capStr} value_len=${v.length}` });
      return { tag: 'ok', val: v };
    },
  };
}

/* ───── events ──────────────────────────────────────────────────────── */

export function makeEventsHost(ctx: WasmHostCtx) {
  return {
    emit(name: string, payload: Uint8Array): { tag: 'ok' } | { tag: 'err'; val: unknown } {
      const prefix = `${ctx.pluginId}.`;
      if (!name.startsWith(prefix)) {
        audit(ctx, { interface: 'events', method: 'emit', outcome: 'invalid-input', detail: `foreign-namespace: name=${name}` });
        return { tag: 'err', val: { tag: 'invalid-name', val: `event name '${name}' must start with '${prefix}'` } };
      }
      if (name.length > 256) {
        audit(ctx, { interface: 'events', method: 'emit', outcome: 'invalid-input', detail: `name-too-long: len=${name.length}` });
        return { tag: 'err', val: { tag: 'invalid-name', val: 'name too long' } };
      }
      if (!ctx.eventBucket.tryConsume()) {
        audit(ctx, { interface: 'events', method: 'emit', outcome: 'rate-limited', detail: `name=${name} payload_len=${payload.length}` });
        return { tag: 'err', val: { tag: 'rate-limited', val: 'rate limit exceeded' } };
      }
      ctx.eventSink.deliver(ctx.pluginId, name, payload);
      audit(ctx, { interface: 'events', method: 'emit', outcome: 'ok', detail: `name=${name} payload_len=${payload.length}` });
      return { tag: 'ok' };
    },
  };
}

/* ───── compute ─────────────────────────────────────────────────────── */
//
// Full slice 1+ behavior parity with Rust runtime:
//   - validate request shape (binary non-empty, timeout in range)
//   - cap check via compute:exec:<binary>
//   - dispatch to runtime: disabled / unsandboxed-spawn (no sandbox here
//     yet; bwrap is Linux-only + better wired through Rust's host)
//   - audit row format mirrors Rust's exactly so cross-runtime audit
//     consumers see identical schemas
//
// Real spawn here would use Node child_process; intentionally NOT
// shipping that in the JS host for v0.1.0 — recommend plugin authors
// use the Rust runtime for compute.exec workloads since the bwrap
// sandbox is the right home for spawn isolation. JS host returns
// CapabilityDenied for compute:exec:* even when granted, with a
// clear message pointing at the design recommendation.

export function makeComputeHost(ctx: WasmHostCtx) {
  return {
    async exec(req: {
      binary: string;
      args: string[];
      stdin: Uint8Array;
      env: [string, string][];
      timeoutMs: number;
    }): Promise<{ tag: 'ok'; val: unknown } | { tag: 'err'; val: unknown }> {
      if (req.binary.length === 0) {
        audit(ctx, { interface: 'compute', method: 'exec', outcome: 'invalid-input', detail: 'empty binary' });
        return { tag: 'err', val: { tag: 'invalid-request', val: 'binary must not be empty' } };
      }
      if (req.timeoutMs < 1 || req.timeoutMs > 600_000) {
        audit(ctx, { interface: 'compute', method: 'exec', outcome: 'invalid-input', detail: `timeout-out-of-range: ${req.timeoutMs}` });
        return { tag: 'err', val: { tag: 'invalid-request', val: 'timeout out of range' } };
      }
      const capStr = `compute:exec:${req.binary}`;
      if (!hasCapability(ctx.capCtx, capStr)) {
        audit(ctx, { interface: 'compute', method: 'exec', outcome: 'capability-denied', detail: `cap=${capStr}` });
        return { tag: 'err', val: { tag: 'capability-denied', val: `cap ${capStr} not granted` } };
      }
      // v0.1.0 JS host: cap layer is real; spawn is delegated.
      audit(ctx, {
        interface: 'compute',
        method: 'exec',
        outcome: 'not-found',
        detail: `cap=${capStr} runtime=disabled-on-js-host args_count=${req.args.length} stdin_len=${req.stdin.length} env_count=${req.env.length} timeout_ms=${req.timeoutMs}`,
      });
      return {
        tag: 'err',
        val: {
          tag: 'binary-not-found',
          val: 'compute.exec is not implemented in the JS host; use the Rust runtime for spawn workloads (see plugin-process-exec-design.md)',
        },
      };
    },
  };
}

/* ───── Bundled imports object for jco instantiation ────────────────── */

/**
 * Build the imports object that jco's instantiate-async expects.
 * Caller passes a fresh WasmHostCtx for each plugin instance (the
 * actor task owns the ctx for the lifetime of the plugin).
 */
export function makeImports(ctx: WasmHostCtx) {
  return {
    'papercup:plugin/logging': makeLoggingHost(ctx),
    'papercup:plugin/http': makeHttpHost(ctx),
    'papercup:plugin/secrets': makeSecretsHost(ctx),
    'papercup:plugin/events': makeEventsHost(ctx),
    'papercup:plugin/compute': makeComputeHost(ctx),
  };
}
