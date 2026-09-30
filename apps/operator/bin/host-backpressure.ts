/**
 * Inbound-HTTP backpressure / load-shedding for the operator Hono host
 * (infra-perf-reliability-audit-round4-2026-06-19 P-018, lane su-61e7e).
 *
 * The operator has admission control for agent SPAWNS (loop-pressure-governor)
 * but NONE for inbound HTTP — under loop saturation the accept queue overflows
 * (observed 512/511 live this round) and requests time out at 30-60s instead of
 * fast-failing. This adds a thin middleware that, when the event loop is
 * CRITICALLY saturated, fast-503s (with Retry-After) requests EXPLICITLY marked
 * deferrable, so the interactive traffic that remains is not starved behind a
 * backlog of low-value work.
 *
 * CONSERVATIVE BY DESIGN:
 *  - Default OFF (PAPERCUSP_HTTP_BACKPRESSURE unset/0 → a single env read + pass
 *    through). Opt-in kill-switch, mirrors the loop-pressure-governor flag.
 *  - Sheds ONLY requests a caller opts into as deferrable — the
 *    `x-papercusp-deferrable` header, or a configured path prefix
 *    (PAPERCUSP_HTTP_BACKPRESSURE_PATHS). Unmarked / interactive traffic is
 *    NEVER shed.
 *  - Liveness/health paths are never shed, even when marked.
 *  - REUSES the existing event-loop-lag signal (loopPressure) — does NOT add a
 *    second monitor. Additive to su-67d39 self-restart + deeb4 P-003 CLOSE_WAIT.
 *
 * Follow-up (out of scope here): honoring SSE res.write() backpressure (await
 * 'drain') in libs/generic/sse — a larger refactor of the stream sink, tracked
 * separately so this admission-control middleware stays small + safe.
 */
import type { MiddlewareHandler } from 'hono';
import { loopPressure, type LoopPressure } from '@papercusp/operator-core/lib/event-loop-lag-monitor';

const DEFERRABLE_HEADER = 'x-papercusp-deferrable';
/** Never shed these prefixes — liveness/health must always answer. */
const PROTECTED_PREFIXES = ['/api/health'];
const DEFAULT_RETRY_AFTER_SEC = 5;

export interface SheddingInput {
  /** PAPERCUSP_HTTP_BACKPRESSURE on. */
  enabled: boolean;
  /** Current event-loop pressure band (loopPressure()). */
  pressure: LoopPressure;
  /** Request pathname. */
  path: string;
  /** x-papercusp-deferrable header value (null if absent). */
  deferrableHeader: string | null;
  /** Configured deferrable path prefixes. */
  deferrablePaths: string[];
}
export type SheddingDecision = { shed: false } | { shed: true; retryAfterSec: number };

function isProtected(path: string): boolean {
  return PROTECTED_PREFIXES.some((p) => path.startsWith(p));
}
function isDeferrable(path: string, header: string | null, paths: string[]): boolean {
  if (header && header !== '0' && header.toLowerCase() !== 'false') return true;
  return paths.some((p) => p && path.startsWith(p));
}

/** Pure shedding decision — unit-testable without a server or a live loop. Shed
 *  iff: enabled AND loop is critical AND the request is caller-marked deferrable
 *  AND not a protected (health/liveness) path. */
export function decideShedding(input: SheddingInput, retryAfterSec = DEFAULT_RETRY_AFTER_SEC): SheddingDecision {
  if (!input.enabled) return { shed: false };
  if (input.pressure !== 'critical') return { shed: false };
  if (isProtected(input.path)) return { shed: false };
  if (!isDeferrable(input.path, input.deferrableHeader, input.deferrablePaths)) return { shed: false };
  return { shed: true, retryAfterSec };
}

export function backpressureEnabled(): boolean {
  const v = process.env.PAPERCUSP_HTTP_BACKPRESSURE;
  return v === '1' || v === 'true';
}
function envDeferrablePaths(): string[] {
  return (process.env.PAPERCUSP_HTTP_BACKPRESSURE_PATHS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function envRetrySec(): number {
  const v = Number(process.env.PAPERCUSP_HTTP_BACKPRESSURE_RETRY_SEC);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETRY_AFTER_SEC;
}

/** Hono middleware: fast-503 caller-marked deferrable requests under critical
 *  loop pressure. Inert (single env read + passthrough) unless enabled. */
export const backpressureMiddleware: MiddlewareHandler = async (c, next) => {
  if (!backpressureEnabled()) return next();
  const decision = decideShedding(
    {
      enabled: true,
      pressure: loopPressure(),
      path: new URL(c.req.url).pathname,
      deferrableHeader: c.req.header(DEFERRABLE_HEADER) ?? null,
      deferrablePaths: envDeferrablePaths(),
    },
    envRetrySec(),
  );
  if (decision.shed) {
    c.header('Retry-After', String(decision.retryAfterSec));
    return c.json(
      {
        error: 'loop_saturated',
        message: 'operator event loop saturated; retry shortly',
        retryAfterSec: decision.retryAfterSec,
      },
      503,
    );
  }
  return next();
};
