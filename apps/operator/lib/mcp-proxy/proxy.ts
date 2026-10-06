/**
 * Resilient local MCP proxy (mcp-host-availability-resilience-2026-06-22 P-005).
 *
 * WHY: the papercusp-su MCP endpoint is :3070/api/mcp, and :3070 restarts on every
 * deploy. A native MCP client (Claude Code) drops its connection on that restart and
 * does not re-discover tools → "toolless session". This always-up local proxy sits in
 * FRONT of :3070: the client connects HERE (opt-in), and the client→proxy connection
 * stays up across a :3070 deploy because THIS process never restarts on deploys. When
 * :3070 is briefly unreachable (mid-restart) the proxy RETRIES the forward, so a
 * tools/call issued during the window just waits a beat instead of erroring — the
 * restart is invisible to the agent.
 *
 * SAFETY — no double-execution (the load-bearing invariant): a tools/call is often a
 * non-idempotent WRITE. The base rule: RETRY freely only when the upstream connection was
 * REFUSED (ECONNREFUSED / pre-connect error) — i.e. the request provably never reached
 * :3070, so replaying it cannot double-apply. Once the socket has CONNECTED, an error
 * MIGHT mean :3070 already processed the call, so by default we do NOT retry — we surface
 * a 502.
 *
 * P-005 (mcp-reliability-hardening-2026-07-11) refines the post-connect case — the
 * "retry-once on a stale-socket reset" this header long anticipated — by CLASSIFYING the
 * forward (see prepareForward):
 *   - 'idempotent' (no tools/call: initialize / tools/list / ping / resources / prompts /
 *     notifications) → replaying has no side effect, so a post-connect failure IS retried
 *     (bounded, in-window). This directly targets the dropped-handshake "toolless session".
 *   - 'keyed' (a tools/call into which the proxy injects a per-request `_meta.idempotencyKey`)
 *     → the key preserves a completed result for a later explicit retry, but the proxy does
 *     NOT retry immediately: the original handler may still be running and its result row
 *     does not exist until it settles, so a concurrent replay can execute the mutation twice.
 *   - 'readonly' (EI-21268234394605529: EVERY tools/call in the batch names a verb in
 *     READ_ONLY_TOOLS) → re-running the call cannot double-apply anything, so a post-connect
 *     socket error IS retried once, in-window — while the timeout path stays on maxHoldMs
 *     exactly like 'keyed'/'opaque': `build:typecheck` legitimately runs ~160s and must never
 *     inherit the 8s handshake bound.
 *   - 'opaque' (a tools/call with no usable key — keying kill-switched off, body unparseable,
 *     or oversized) → the original invariant stands: NEVER replay a post-connect failure.
 * Kill-switch: PAPERCUSP_MCP_PROXY_KEYED_RETRY=0 forces every tools/call to 'opaque'
 * (exactly the pre-P-005 refused-only behavior); the idempotent-method retry is always safe
 * and stays on.
 *
 * The endpoint is STATELESS streamable-HTTP (no Mcp-Session-Id / handshake), so the
 * proxy is a pure per-request passthrough — no session state to lose across a restart.
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { parser as createStreamJsonParser } from "stream-json";
import { normalizeMcpName } from "@papercusp/tooldef";
import {
  MCP_DATA_PLANE_DEGRADED_AT_HEADER,
  MCP_REQUEST_TRACE_HEADER,
  MAX_MCP_REQUEST_TRACE_ID_CHARS,
} from "@papercusp/operator-core/lib/mcp-request-trace";
import { isCheapRepeatingBeat } from "@papercusp/operator-core/lib/system-health/mcp-proxy-beats";
import {
  isBoundedDevTelemetryArgs,
  isBoundedCoordPresenceArgs,
  isBoundedCoordRosterArgs,
  isBoundedJudgeScorecardsEvaluateArgs,
  isBoundedRecipesSearchArgs,
  isBoundedScorecardsEvaluateArgs,
  isBoundedScorecardsListArgs,
  isBoundedActivityToolLogArgs,
  isBoundedTestingRunStatusArgs,
} from "@papercusp/operator-core/lib/endpoint-route/routes/transport/mcp-admission";
import { classifyCapabilityBashEffect } from "@papercusp/operator-core/lib/agent-tools/capability/bash-effect";
import { foreignLoopbackPeerForSocket } from "@papercusp/operator-core/lib/auth/loopback-peer-trust";
export {
  CHEAP_REPEATING_BEAT_PATHS,
  isCheapRepeatingBeat,
} from "@papercusp/operator-core/lib/system-health/mcp-proxy-beats";
// The one path this proxy answers itself. Shared with watchdog.mjs so the liveness probe and
// the route it probes cannot drift apart (WI-6743).
import { MCP_PROXY_LOCAL_HEALTH_PATH } from "./budgets.mjs";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyServerTimeouts } from "../../bin/host-request-deadline";

/**
 * Dedicated upstream agent with keep-alive DISABLED — backend-reliability-100pct-2026-07-03 W1.3.
 *
 * ROOT CAUSE (measured 2026-07-03): forwarding through Node's GLOBAL agent (keepAlive:true,
 * maxSockets:Infinity on Node ≥19) POOLS + REUSES sockets to the :3070 cluster. A pooled socket
 * races the server/worker closing it (the :3070 http server advertises `keep-alive: timeout=61`,
 * AND SO_REUSEPORT workers recycle on lag) — so a forward can land on a half-closed socket, :3070's
 * parser sees a malformed request and returns its default `400 Bad Request` (connection:close, empty
 * body). The proxy treats that as a normal upstream RESPONSE (statusCode 400) and forwards it to the
 * agent as a spurious tool error — NOT covered by the refused-only retry. Reproduced at ~13% on
 * reuse-prone (sequential) traffic while direct :3070 was 15/15 clean. Every agent routes through
 * this proxy, so this was a prime source of the "transient tool errors under load".
 *
 * FIX: a fresh socket per forward eliminates the reuse race entirely. This proxy fronts a localhost
 * upstream, so the extra connect is microseconds. keepAlive:false is the correct, safe fix for the
 * reuse race; it does NOT bound concurrency, which is `maxSockets` below.
 *
 * EI-19305299022434394 — `maxSockets` was `Infinity` here, which is the OTHER half of the same
 * congestion-collapse bug this comment already describes for keep-alive: when :3070 accepts
 * connections but stalls, an unbounded agent keeps opening brand-new concurrent sockets for every
 * arriving request instead of queuing them — the more the upstream struggles, the more simultaneous
 * work the proxy piles onto it. Measured 2026-08-01: 3,450 requests held open simultaneously in one
 * second when :3070 stopped responding, with proxy elapsed times of 32-89 minutes. A finite
 * `maxSockets` makes Node's own `http.Agent` queue excess forwards internally instead of amplifying
 * them; `createMcpProxy`'s own `maxInFlight` admission control (below) then sheds with 429 once even
 * that queue backs up past a threshold, so the proxy never silently holds an unbounded number of
 * requests. Both bounds are env-overridable so a box that legitimately needs more headroom can raise
 * them without a code change.
 */
const DEFAULT_MAX_UPSTREAM_SOCKETS = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_SOCKETS ?? 64,
);
const UPSTREAM_AGENT = new http.Agent({
  keepAlive: false,
  maxSockets:
    DEFAULT_MAX_UPSTREAM_SOCKETS > 0 ? DEFAULT_MAX_UPSTREAM_SOCKETS : Infinity,
});

/**
 * WI-41042 — one bounded, proxy-owned correlation key per client request. The proxy always
 * overwrites this header before forwarding, so an untrusted client cannot inject an unbounded
 * value into upstream logs or make two unrelated requests appear correlated.
 */
export const MCP_PROXY_TRACE_HEADER = MCP_REQUEST_TRACE_HEADER;
export const MAX_MCP_PROXY_TRACE_ID_CHARS = MAX_MCP_REQUEST_TRACE_ID_CHARS;
export const MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER =
  MCP_DATA_PLANE_DEGRADED_AT_HEADER;
export const DEFAULT_DATA_PLANE_WARNING_WINDOW_MS = 30_000;

/**
 * Overwrite/remove any client-supplied diagnostic marker, then stamp the
 * proxy's own recent-instability timestamp while it remains inside the short
 * warning window. Pure so the trust boundary and expiry rule stay pinned.
 */
export function withDataPlaneDegradedHeader(
  headers: http.IncomingHttpHeaders,
  lastInstabilityAtMs: number,
  nowMs = Date.now(),
  windowMs = DEFAULT_DATA_PLANE_WARNING_WINDOW_MS,
): http.IncomingHttpHeaders {
  const forwarded = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        name.toLowerCase() !== MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER,
    ),
  );
  const ageMs = nowMs - lastInstabilityAtMs;
  if (
    !Number.isSafeInteger(lastInstabilityAtMs) ||
    lastInstabilityAtMs <= 0 ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    ageMs < 0 ||
    ageMs > windowMs
  ) {
    return forwarded;
  }
  return {
    ...forwarded,
    [MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER]: String(lastInstabilityAtMs),
  };
}

const configuredInitializeSlowMs = Number(
  process.env.PAPERCUSP_MCP_PROXY_INITIALIZE_SLOW_MS,
);
/** Successful initialize requests are silent unless their end-to-end proxy time crosses this. */
export const DEFAULT_INITIALIZE_SLOW_MS =
  Number.isFinite(configuredInitializeSlowMs) && configuredInitializeSlowMs > 0
    ? Math.floor(configuredInitializeSlowMs)
    : 2_500;

/**
 * W8 (backend-reliability-100pct-2026-07-03) — make the proxy's forwarded FAILURES VISIBLE.
 * A non-2xx the proxy forwards, a retry-recovery, or a window-exhaustion NEVER creates a
 * `tool_invocations` row (the request errors at the HTTP layer, BELOW tool dispatch), so the
 * agent-facing failure rate was under-counted and "transient errors" felt normal — exactly how
 * the W1.3 stale-socket 400s stayed invisible. Append a structured JSONL record (journald-
 * independent, survives restart) that a health collector / SLO can ingest. NEVER throws —
 * telemetry must never break forwarding. Env override: PAPERCUSP_MCP_PROXY_FAILURE_LOG.
 *
 * ⚠ THE LEDGER IS SHARED AND MULTI-WRITER (EI-19388683897769817): this file is the real,
 * fleet-facing production telemetry a health collector reads, NOT a scratch log. Every
 * reader of it must apply `isNonInstanceRecord` (system-health/mcp-proxy-health.ts) to
 * exclude `listenPort: 0` (test/sidecar) rows, or it over-counts failures — measured live,
 * 18% of a 13,189-record sample were test-suite noise (28-record batches from short-lived
 * pids, `maxInFlight: 2` fixture values) with no env override set. `isNonInstanceRecord`
 * lives in exactly ONE reader today; a second consumer that forgets it silently inherits
 * the pollution (already shipped once and caught in review, see
 * plan `outage-must-not-be-silent-2026-08-02` D-005).
 */
function failureLogPath(): string {
  // Resolved per-call (not cached at module load) so the sink is env-overridable at runtime + testable.
  return (
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG ||
    join(homedir(), ".papercusp", "mcp-proxy-failures.jsonl")
  );
}
export const DEFAULT_FAILURE_LOG_MAX_BYTES = 10 * 1024 * 1024;
function failureLogMaxBytes(): number {
  const configured = Number(
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES,
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_FAILURE_LOG_MAX_BYTES;
}
export function shouldRotateFailureLog(
  sizeBytes: number,
  maxBytes = DEFAULT_FAILURE_LOG_MAX_BYTES,
): boolean {
  return sizeBytes >= maxBytes;
}
/**
 * PURE: should `recordProxyFailure` skip writing this call entirely? EI-19388683897769817 —
 * a test that constructs a proxy WITHOUT setting PAPERCUSP_MCP_PROXY_FAILURE_LOG must never
 * fall through to the real default `~/.papercusp/mcp-proxy-failures.jsonl` — that silently
 * appended ~18% test noise (short-lived-pid batches, `listenPort: 0`, fixture values like
 * `maxInFlight: 2`) into the shared production ledger every suite run. Guarded at the WRITE
 * site (not per-test) so a future test cannot forget: under vitest, only an EXPLICIT override
 * writes; the default path is skipped entirely rather than silently redirected, because
 * nothing in this suite depends on the default path being written to (the two tests that
 * assert on ledger content already set the override themselves). Exported as a pure
 * predicate (inputs, not env reads) so it is unit-testable without touching real env/fs.
 */
export function shouldSkipDefaultFailureLog(
  isTest: boolean,
  hasExplicitOverride: boolean,
): boolean {
  return isTest && !hasExplicitOverride;
}
function recordProxyFailure(rec: Record<string, unknown>): void {
  if (
    shouldSkipDefaultFailureLog(
      Boolean(process.env.VITEST),
      Boolean(process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG),
    )
  ) {
    return;
  }
  try {
    const path = failureLogPath();
    mkdirSync(dirname(path), { recursive: true }); // idempotent; failures are rare so this is cheap
    try {
      if (shouldRotateFailureLog(statSync(path).size, failureLogMaxBytes())) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // A missing file is normal; concurrent writers may also win the rotation race.
    }
    appendFileSync(
      path,
      JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n",
    );
  } catch {
    /* telemetry must never break the proxy */
  }
}

const MAX_MCP_PROXY_SUCCESS_TOOL_NAMES = 64;
const MAX_MCP_PROXY_SUCCESS_TOOL_NAME_CHARS = 128;
const MAX_MCP_PROXY_SUCCESS_STAGE_MS = 10 * 60 * 1000;

type NativeSessionAttribution = {
  pseudonym: string | null;
  source: string;
  trust: string;
};

function nativeSessionAttribution(
  headers: http.IncomingHttpHeaders,
): NativeSessionAttribution {
  const carrier = headers["x-papercusp-native-session"];
  if (typeof carrier !== "string") {
    return {
      pseudonym: null,
      source: carrier === undefined ? "absent" : "header:x-papercusp-native-session",
      trust: carrier === undefined ? "unavailable" : "unusable",
    };
  }
  const nativeSessionId = carrier.trim();
  if (
    nativeSessionId.length === 0 ||
    nativeSessionId.length > MAX_MCP_PROXY_SUCCESS_TOOL_NAME_CHARS ||
    !/^[A-Za-z0-9._:-]+$/.test(nativeSessionId)
  ) {
    return {
      pseudonym: null,
      source: "header:x-papercusp-native-session",
      trust: "unusable",
    };
  }
  return {
    pseudonym: createHash("sha256")
      .update(nativeSessionId)
      .digest("hex")
      .slice(0, 24),
    source: "header:x-papercusp-native-session",
    trust: "unverified-client-assertion",
  };
}

function boundedMcpProxyStageMs(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_MCP_PROXY_SUCCESS_STAGE_MS, Math.max(0, Math.floor(value)))
    : 0;
}

type McpResponseTelemetrySummary = {
  resultSeen: boolean;
  errorSeen: boolean;
  toolsArraySeen: boolean;
  toolCount: number;
  toolNames: string[];
};

type McpResponseTelemetryObserver = {
  write(chunk: Buffer): void;
  finish(): Promise<McpResponseTelemetrySummary | null>;
};

/**
 * Observe only the small result fields needed for MCP success telemetry. The SAX
 * parser never assembles descriptions, schemas, or the response body, and the
 * streamable-HTTP bytes continue through the original pipe untouched.
 */
function createMcpResponseTelemetryObserver(
  contentType: string | string[] | undefined,
): McpResponseTelemetryObserver {
  type Frame = {
    kind: "object" | "array";
    role: "batch" | "response" | "result" | "tools" | "tool" | "other";
    pendingKey?: string;
    nameSeen: boolean;
  };
  type NameCapture = { value: string; chars: number };

  const isEventStream = /text\/event-stream/i.test(
    Array.isArray(contentType) ? contentType.join(",") : (contentType ?? ""),
  );
  const parser = createStreamJsonParser.asStream({
    jsonStreaming: true,
    packKeys: false,
    packStrings: false,
    packNumbers: false,
  });
  const decoder = isEventStream ? new StringDecoder("utf8") : null;
  const frames: Frame[] = [];
  const toolNames: string[] = [];
  let resultSeen = false;
  let errorSeen = false;
  let toolsArraySeen = false;
  let toolCount = 0;
  let failed = false;
  let finished = false;
  let settled = false;
  let inKey = false;
  let keyBuffer = "";
  let keyOverflow = false;
  let activeName: NameCapture | null = null;
  let sseMode: "prefix" | "data" | "other" = "prefix";
  let ssePrefix = "";
  let sseSkipOptionalSpace = false;
  let sseEventHasData = false;
  let ssePendingData = "";
  let resolveCompletion: (
    summary: McpResponseTelemetrySummary | null,
  ) => void = () => {};
  const completion = new Promise<McpResponseTelemetrySummary | null>(
    (resolve) => {
      resolveCompletion = resolve;
    },
  );

  const settle = (summary: McpResponseTelemetrySummary | null): void => {
    if (settled) return;
    settled = true;
    resolveCompletion(summary);
  };
  const fail = (): void => {
    failed = true;
    settle(null);
  };
  const appendNameChunk = (chunk: string): void => {
    if (!activeName || activeName.chars >= MAX_MCP_PROXY_SUCCESS_TOOL_NAME_CHARS)
      return;
    const printable = chunk.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    for (const character of printable) {
      if (activeName.chars >= MAX_MCP_PROXY_SUCCESS_TOOL_NAME_CHARS) break;
      activeName.value += character;
      activeName.chars++;
    }
  };
  const valueStarts = new Set([
    "startObject",
    "startArray",
    "startString",
    "startNumber",
    "stringValue",
    "numberValue",
    "trueValue",
    "falseValue",
    "nullValue",
  ]);
  const beginValue = (tokenName: string): void => {
    const parent = frames[frames.length - 1];
    const key = parent?.kind === "object" ? parent.pendingKey : undefined;
    if (parent?.kind === "object" && parent.role === "response") {
      if (key === "result") resultSeen = true;
      if (key === "error") errorSeen = true;
    }
    if (parent?.kind === "array" && parent.role === "tools" && valueStarts.has(tokenName)) {
      if (toolCount < Number.MAX_SAFE_INTEGER) toolCount++;
      else failed = true;
    }
    if (parent?.kind === "object" && parent.role === "tool" && key === "name") {
      if (
        tokenName === "startString" &&
        !parent.nameSeen &&
        toolNames.length < MAX_MCP_PROXY_SUCCESS_TOOL_NAMES
      ) {
        activeName = { value: "", chars: 0 };
      }
      parent.nameSeen = true;
    }
    if (parent?.kind === "object") parent.pendingKey = undefined;
  };
  const childRole = (
    kind: "object" | "array",
    parent: Frame | undefined,
    key: string | undefined,
  ): Frame["role"] => {
    if (!parent) return kind === "array" ? "batch" : "response";
    if (parent.kind === "array" && parent.role === "batch" && kind === "object")
      return "response";
    if (parent.kind === "object" && parent.role === "response" && key === "result" && kind === "object")
      return "result";
    if (parent.kind === "object" && parent.role === "result" && key === "tools" && kind === "array") {
      toolsArraySeen = true;
      return "tools";
    }
    if (parent.kind === "array" && parent.role === "tools" && kind === "object")
      return "tool";
    return "other";
  };
  parser.on("data", (token: { name: string; value?: unknown }) => {
    if (failed) return;
    try {
      if (token.name === "startKey") {
        inKey = true;
        keyBuffer = "";
        keyOverflow = false;
        return;
      }
      if (token.name === "endKey") {
        const frame = frames[frames.length - 1];
        if (frame?.kind === "object")
          frame.pendingKey = keyOverflow ? "" : keyBuffer;
        inKey = false;
        keyBuffer = "";
        keyOverflow = false;
        return;
      }
      if (token.name === "stringChunk") {
        const chunk = typeof token.value === "string" ? token.value : "";
        if (inKey) {
          if (keyBuffer.length < 16) {
            const remaining = 16 - keyBuffer.length;
            keyBuffer += chunk.slice(0, remaining);
            if (chunk.length > remaining) keyOverflow = true;
          } else {
            keyOverflow = true;
          }
        } else {
          appendNameChunk(chunk);
        }
        return;
      }
      if (token.name === "endString") {
        if (activeName) {
          const sanitized = activeName.value.trim();
          if (
            sanitized.length > 0 &&
            toolNames.length < MAX_MCP_PROXY_SUCCESS_TOOL_NAMES
          )
            toolNames.push(sanitized);
          activeName = null;
        }
        return;
      }
      if (token.name === "startObject" || token.name === "startArray") {
        const kind = token.name === "startObject" ? "object" : "array";
        const parent = frames[frames.length - 1];
        const key = parent?.kind === "object" ? parent.pendingKey : undefined;
        const role = childRole(kind, parent, key);
        beginValue(token.name);
        frames.push({ kind, role, nameSeen: false });
        return;
      }
      if (token.name === "endObject" || token.name === "endArray") {
        frames.pop();
        return;
      }
      if (
        token.name === "startString" ||
        token.name === "startNumber" ||
        token.name === "stringValue" ||
        token.name === "numberValue" ||
        token.name === "trueValue" ||
        token.name === "falseValue" ||
        token.name === "nullValue"
      ) {
        beginValue(token.name);
      }
    } catch {
      fail();
    }
  });
  parser.on("error", fail);
  parser.on("end", () => {
    if (failed) {
      settle(null);
      return;
    }
    settle({
      resultSeen,
      errorSeen,
      toolsArraySeen,
      toolCount,
      toolNames,
    });
  });

  const flushSseData = (): void => {
    if (ssePendingData.length === 0) return;
    parser.write(ssePendingData);
    ssePendingData = "";
  };
  const appendSseData = (value: string): void => {
    ssePendingData += value;
    if (ssePendingData.length >= 1024) flushSseData();
  };
  const feedEventStreamText = (text: string): void => {
    for (const character of text) {
      if (character === "\r") continue;
      if (character === "\n") {
        if (sseMode === "prefix" && ssePrefix.length === 0 && sseEventHasData) {
          appendSseData("\n");
          flushSseData();
          sseEventHasData = false;
        }
        sseMode = "prefix";
        ssePrefix = "";
        sseSkipOptionalSpace = false;
        continue;
      }
      if (sseMode === "prefix") {
        ssePrefix += character;
        if ("data:".startsWith(ssePrefix)) {
          if (ssePrefix === "data:") {
            sseMode = "data";
            if (sseEventHasData) appendSseData("\n");
            sseEventHasData = true;
            sseSkipOptionalSpace = true;
            ssePrefix = "";
          }
        } else {
          sseMode = "other";
          ssePrefix = "";
        }
        continue;
      }
      if (sseMode === "data") {
        if (sseSkipOptionalSpace) {
          sseSkipOptionalSpace = false;
          if (character === " ") continue;
        }
        appendSseData(character);
      }
    }
  };

  return {
    write(chunk: Buffer): void {
      if (failed || finished) return;
      try {
        if (decoder) feedEventStreamText(decoder.write(chunk));
        else parser.write(chunk);
      } catch {
        fail();
      }
    },
    finish(): Promise<McpResponseTelemetrySummary | null> {
      if (!finished) {
        finished = true;
        try {
          if (decoder) {
            feedEventStreamText(decoder.end());
            if (sseEventHasData) appendSseData("\n");
            flushSseData();
          }
          parser.end();
        } catch {
          fail();
        }
      }
      return completion;
    },
  };
}

export interface McpProxyOptions {
  listenPort: number;
  listenHost?: string;
  targetHost?: string;
  targetPort?: number;
  /** Resolve the current upstream per attempt. Used by packaged installs whose operator port changes per boot. */
  resolveTarget?: () => McpProxyTarget;
  /** Resolve ordered upstream candidates per attempt. A later candidate is selected only after a pre-connect refusal. */
  resolveTargets?: () => McpProxyTarget[];
  /**
   * WI-41045 — the superuser MCP client config contains a bearer captured at
   * session boot. When the token file rotates, refresh it at the proxy boundary
   * instead of forwarding that stale client header. The path and reader are
   * injectable so rotation can be exercised without touching the host token.
   */
  superuserTokenPath?: string;
  readSuperuserToken?: (path: string) => string | null;
  /** Total wall-clock budget to keep retrying a refused upstream (a :3070 restart). */
  retryWindowMs: number;
  /** WI-6740: per-attempt wait for response headers on the write-free control-plane batch
   *  (initialize / tools/list / ping). Defaults to HANDSHAKE_UPSTREAM_TIMEOUT_MS; injectable
   *  so tests can drive a stalling upstream without sleeping 8s. Never applied to a tools/call. */
  handshakeTimeoutMs?: number;
  /**
   * WI-41042 — emit a privacy-bounded initialize-stage record when a successful initialize
   * crosses this end-to-end duration. Timeouts are always recorded. Injectable for tests;
   * defaults to `PAPERCUSP_MCP_PROXY_INITIALIZE_SLOW_MS` or 2500ms.
   */
  initializeSlowMs?: number;
  /** Delay between retries while the upstream is refusing connections. */
  retryBackoffMs?: number;
  /**
   * EI-19305299022434394 — the admission-control ceiling: shed a NEW request with 429 +
   * Retry-After the instant this many forwards are already in flight, BEFORE it ever opens an
   * upstream socket. Defaults to `DEFAULT_MAX_IN_FLIGHT` (env `PAPERCUSP_MCP_PROXY_MAX_IN_FLIGHT`).
   * Injectable so tests can drive shedding without spinning up hundreds of real connections.
   */
  maxInFlight?: number;
  /**
   * EI-21391963810159383 — class-specific ceiling for write-free MCP session handshakes
   * (`initialize` / `ping` / `tools/list`). A reconnect burst must not consume the whole
   * reserved-control-plane pool and queue the watchdog behind the class it diagnoses.
   * Defaults to `DEFAULT_MAX_HANDSHAKES_IN_FLIGHT`; non-positive disables the class cap.
   */
  maxHandshakeInFlight?: number;
  /**
   * EI-21395173692390816 — bounded FIFO waiters for ordinary session handshakes that reach
   * `maxHandshakeInFlight`. A queued handshake consumes no upstream slot until granted; zero
   * disables waiting and preserves the immediate 429 behavior.
   */
  maxHandshakeQueue?: number;
  /**
   * EI-21556422206126497 — bounded FIFO waiters for durability-boundary writes
   * (`loop:checkpoint`, `work_items:complete`, lifecycle writes, ...). The dedicated
   * continuation pool remains conflict-serialized, but an overlapping checkpoint waits here
   * instead of being shed merely because one sibling write is still finishing.
   */
  maxCriticalContinuationQueue?: number;
  /** Maximum time (ms) a critical-continuation write may wait for the dedicated slot. */
  maxCriticalContinuationQueueWaitMs?: number;
  /**
   * EI-21669304707115602 — bounded FIFO waiters for pure `coord:send` batches. These
   * handoffs have their own bounded lane so they cannot sit behind a long completion or
   * checkpoint on the general continuation socket.
   */
  maxCoordSendQueue?: number;
  /**
   * EI-21653510279635866 — `coord:send` must fail before ptool's 60s client deadline when
   * its dedicated continuation slot is occupied. A send that never reached the handler is safe
   * to reject/retry, while a mixed critical batch remains governed by the shared lane.
   */
  coordSendQueueWaitMs?: number;
  /**
   * WI-950869 — incident captures must fail before the client deadline when the continuation
   * slot is occupied. Unlike the generic continuation lane, `improvements:capture` can be
   * retried safely after an explicit not-forwarded response, so it gets a finite default dwell.
   * Pass 0 to restore unbounded waiting for this tool specifically.
   */
  improvementsCaptureQueueWaitMs?: number;
  /** Per-waiter telemetry cadence (ms) for the critical-continuation FIFO. */
  criticalContinuationQueueWaitLogMs?: number;
  /**
   * EI-21504897841052086 — how long (ms) a session handshake may WAIT in the admission
   * FIFO before it is shed with 429 `mcp_proxy_handshake_queue_dwell`. Bounded because
   * observed clients give up at 16-44s anyway; an honest early 429 beats a silent
   * multi-minute park (the WI-41398 wedge held "8 in flight, N waiting" for 13 minutes).
   * Defaults to `DEFAULT_HANDSHAKE_QUEUE_WAIT_MS` (env
   * `PAPERCUSP_MCP_PROXY_MAX_QUEUE_WAIT_MS`); 0 restores unbounded waiting.
   */
  maxHandshakeQueueWaitMs?: number;
  /**
   * EI-21504897841052086 — cadence (ms) for per-waiter queue telemetry
   * (`handshake_queue_wait` records) while a handshake sits queued. Arrival-only
   * recording left that wedge window with ZERO visibility into queue aging. Defaults to
   * `DEFAULT_HANDSHAKE_QUEUE_WAIT_LOG_MS` (env
   * `PAPERCUSP_MCP_PROXY_QUEUE_WAIT_LOG_MS`); 0 disables.
   */
  handshakeQueueWaitLogMs?: number;
  /** Slots kept available for scheduler control-plane pulls when ordinary tool traffic fills
   * the proxy. This is also the control-plane CLASS ceiling: ordinary and reserved traffic are
   * bulkheaded instead of either class being allowed to consume the other's capacity. Reserved
   * traffic also gets a separate upstream socket pool so an admitted recovery probe cannot sit
   * behind the ordinary pool it is trying to diagnose. The already-isolated watchdog and critical
   * continuation agents each retain one bounded emergency slot outside this partition. */
  controlPlaneReserve?: number;
  /** Injectable ordinary upstream agent for deterministic queue-saturation tests/embedders. */
  upstreamAgent?: http.Agent;
  /** Injectable reserved-control-plane agent. Caller owns an injected agent's lifecycle. */
  controlPlaneAgent?: http.Agent;
  /**
   * Injectable diagnostic agent for the watchdog's session-plane probe. The watchdog must not
   * queue behind ordinary reserved-control-plane calls (`coord:orient`, `tools:find`, ...), or
   * the detector can report the proxy as wedged while its own control-plane pool is saturated.
   * Caller owns an injected agent's lifecycle.
   */
  watchdogAgent?: http.Agent;
  /**
   * Injectable continuation agent for checkpoint/compaction writes. These calls must not queue
   * behind ordinary reserved-control-plane traffic: they persist the state needed to recover
   * from the very overload that can fill the ordinary pool. Caller owns an injected agent's
   * lifecycle.
  */
  criticalContinuationAgent?: http.Agent;
  /**
   * EI-21669304707115602 — injectable agent for pure `coord:send` handoffs. Caller
   * owns an injected agent's lifecycle.
   */
  coordSendAgent?: http.Agent;
  /**
   * EI-22728723476698098 — injectable agent for pure `improvements:capture` incident records.
   * These captures must remain reachable while a long checkpoint/completion occupies the shared
   * continuation agent. Caller owns an injected agent's lifecycle.
   */
  improvementsCaptureAgent?: http.Agent;
  /** Maximum number of pure `improvements:capture` forwards waiting for its dedicated slot. */
  maxImprovementsCaptureQueue?: number;
  /**
   * EI-19305299022434394 — the absolute ceiling (ms) on how long a NON-idempotent forward
   * (a real tools/call: 'keyed' or 'opaque') may hold its upstream socket waiting for response
   * headers, distinct from `handshakeTimeoutMs` (which bounds only the write-free control-plane
   * batch). Generous by design — well above any legitimate tool's real runtime (`build:typecheck`
   * ~160s) — purely to stop the 32-89 minute silent parks a stalled-but-connected upstream can
   * otherwise hold a socket for. 0/undefined at the option level falls back to
   * `DEFAULT_MAX_HOLD_MS` (env `PAPERCUSP_MCP_PROXY_MAX_HOLD_MS`); pass `0` explicitly to disable.
   */
  maxHoldMs?: number;
  /**
   * EI-19305299022434394 — how often (ms) to log/record an in-flight heartbeat while at least
   * one forward is outstanding, so a stalled proxy is LOUD instead of silent (the proxy previously
   * logged only on completion/error, so total upstream silence produced total proxy silence too —
   * 106 minutes with zero log lines during the measured outage). Defaults to
   * `DEFAULT_HEARTBEAT_INTERVAL_MS` (env `PAPERCUSP_MCP_PROXY_HEARTBEAT_MS`); `0` disables.
   */
  heartbeatIntervalMs?: number;
  /**
   * WI-10005688 — peer-uid gate for every request, the same one the inference gateway runs
   * (WI-10003621). The proxy binds 127.0.0.1 and injects the superuser bearer, so on a host
   * where loopback is shared with another account (a hosted workspace host, a vm-release
   * Server, or several tenants' Servers on one Linux box) a caller of another uid must be
   * refused before anything is forwarded. Returns the foreign verdict to refuse, null to
   * proceed. Default `foreignLoopbackPeerForSocket`: a no-op unless the loopback peer-uid
   * policy is active, so a single-user host pays no /proc read per connection.
   */
  loopbackPeerGate?: (
    socket: import("node:net").Socket,
  ) => { uid: number | null; reason: string } | null;
  log?: (s: string) => void;
}

export interface McpProxyTarget {
  host: string;
  port: number;
  source?: string;
}

/** The shared host token used by the superuser MCP endpoint. */
export function defaultSuperuserTokenPath(): string {
  const configured = process.env.PAPERCUSP_MCP_TOKEN_FILE?.trim();
  return configured || join(homedir(), ".papercusp", "superuser-token");
}

/** Read the current bearer without caching it across requests. */
export function readCurrentSuperuserToken(
  path = defaultSuperuserTokenPath(),
): string | null {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/** True only for the query form that opts a request into superuser MCP auth. */
export function isSuperuserMcpRequest(requestUrl: string): boolean {
  try {
    return (
      new URL(requestUrl, "http://127.0.0.1").searchParams.get("superuser") ===
      "1"
    );
  } catch {
    return false;
  }
}

/**
 * Replace a stale client bearer with the token currently on disk, but only on
 * the superuser MCP path. A missing/unreadable token preserves the original
 * headers so the upstream returns its normal auth failure rather than the
 * proxy inventing one.
 */
export function injectCurrentSuperuserBearer(
  requestUrl: string,
  headers: http.IncomingHttpHeaders,
  options: {
    tokenPath?: string;
    readToken?: (path: string) => string | null;
  } = {},
): http.IncomingHttpHeaders {
  if (!isSuperuserMcpRequest(requestUrl)) return headers;
  const token = (options.readToken ?? readCurrentSuperuserToken)(
    options.tokenPath ?? defaultSuperuserTokenPath(),
  );
  if (!token?.trim()) return headers;
  const withoutAuthorization = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
  return { ...withoutAuthorization, authorization: `Bearer ${token.trim()}` };
}

/**
 * `Connection` is hop-by-hop metadata for the client→proxy socket. Forwarding a client
 * `Connection: close` to the upstream makes the capped control-plane agent queue requests
 * onto sockets that are already closing; :3070 can then answer the queued request with an
 * empty 400. Let Node derive the upstream connection policy from its own agent instead.
 */
export function stripClientConnectionHeader(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const forwarded = { ...headers };
  delete forwarded.connection;
  return forwarded;
}

export function staticMcpProxyTarget(
  host: string,
  port: number,
): McpProxyTarget {
  return { host, port, source: "static" };
}

/** The canonical live operator port on the shared dev box. */
export const DEFAULT_MCP_PROXY_TARGET_PORT = 3070;
/** The canonical staging operator port, available only as an explicit dev topology fallback. */
export const DEFAULT_MCP_PROXY_DEV_FALLBACK_PORT = 3170;

/** Build a deterministic ordered static target list, omitting a duplicate fallback. */
export function staticMcpProxyTargets(
  host: string,
  port: number,
  fallbackPort?: number,
): McpProxyTarget[] {
  const primary = staticMcpProxyTarget(host, port);
  if (
    !Number.isFinite(fallbackPort) ||
    (fallbackPort as number) <= 0 ||
    fallbackPort === port
  )
    return [primary];
  return [
    primary,
    { host, port: fallbackPort as number, source: "static-fallback" },
  ];
}

/**
 * Resolve the unpinned dev-box topology. The staging fallback is deliberately
 * enabled only when no target/host/host-port pin was supplied; packaged
 * installs use `readOperatorJsonTarget` through `resolveTarget` instead.
 */
export function resolveDefaultMcpProxyTargets(
  env: NodeJS.ProcessEnv = process.env,
): McpProxyTarget[] {
  const targetHost = env.PAPERCUSP_MCP_PROXY_TARGET_HOST ?? "127.0.0.1";
  const targetPortEnv = env.PAPERCUSP_MCP_PROXY_TARGET_PORT;
  const honoPortEnv = env.PAPERCUSP_HONO_PORT;
  const targetPort = Number(
    targetPortEnv ?? honoPortEnv ?? DEFAULT_MCP_PROXY_TARGET_PORT,
  );
  const explicitPin =
    targetPortEnv !== undefined ||
    honoPortEnv !== undefined ||
    env.PAPERCUSP_MCP_PROXY_TARGET_HOST !== undefined;
  const fallbackPort =
    !explicitPin && targetPort === DEFAULT_MCP_PROXY_TARGET_PORT
      ? Number(
          env.PAPERCUSP_MCP_PROXY_DEV_FALLBACK_PORT ??
            DEFAULT_MCP_PROXY_DEV_FALLBACK_PORT,
        )
      : undefined;
  return staticMcpProxyTargets(targetHost, targetPort, fallbackPort);
}

export function readOperatorJsonTarget(
  path = join(homedir(), ".papercusp", "operator.json"),
): McpProxyTarget | null {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as {
      httpUrl?: string;
      port?: number | string;
    };
    if (typeof d.httpUrl === "string" && d.httpUrl.trim()) {
      const u = new URL(d.httpUrl);
      return {
        host: u.hostname || "127.0.0.1",
        port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
        source: "operator.json",
      };
    }
    const port = Number(d.port);
    if (Number.isFinite(port) && port > 0)
      return { host: "127.0.0.1", port, source: "operator.json" };
  } catch {
    /* discovery unavailable */
  }
  return null;
}

function resolveTargetCandidates(opts: McpProxyOptions): McpProxyTarget[] {
  const candidates = opts.resolveTargets?.();
  if (candidates) {
    if (candidates.length === 0)
      throw new Error("mcp proxy resolveTargets returned no targets");
    return candidates;
  }
  const dynamic = opts.resolveTarget?.();
  if (dynamic) return [dynamic];
  const host = opts.targetHost ?? "127.0.0.1";
  const port = Number(opts.targetPort);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      "mcp proxy targetPort must be set when resolveTarget is not provided",
    );
  }
  return [staticMcpProxyTarget(host, port)];
}

function resolveTarget(opts: McpProxyOptions): McpProxyTarget {
  return resolveTargetCandidates(opts)[0]!;
}

/**
 * Pure retry decision (unit-tested): keep retrying ONLY while BOTH hold —
 *  (a) the upstream connection has NOT yet been established this attempt
 *      (`connected === false` ⇒ the request never reached :3070 ⇒ safe to replay), and
 *  (b) we are still inside the retry window.
 * `connected === true` ⇒ :3070 may already have processed the (possibly non-idempotent)
 * call ⇒ never replay.
 */
export function shouldRetry(
  connected: boolean,
  elapsedMs: number,
  windowMs: number,
): boolean {
  if (connected) return false;
  return elapsedMs < windowMs;
}

/** Post-connect failures are retried AT MOST this many times — a bounded "retry-once on a
 *  stale-socket reset". Bounding it caps the exposure of the server's documented
 *  commit→store race (a write that committed but died before persisting its replay row)
 *  to a single replay attempt. */
export const MAX_POST_CONNECT_RETRIES = 1;
/**
 * P-010 (mcp-reliability-hardening-2026-07-11) — admission-control backpressure absorption.
 * When :3070's event loop is CRITICALLY saturated it sheds a tools/call PRE-DISPATCH with
 * HTTP 429 + Retry-After (the tool never ran → no side effect). A 429 is defined by HTTP as
 * "the request was NOT fulfilled", so replaying it is write-safe for ANY ForwardClass — the
 * proxy ABSORBS it (drain → wait Retry-After → retry) so the agent just waits a beat instead
 * of seeing a spurious error, exactly like the refused-restart window. Bounded by BOTH the
 * retry window and a max count so a persistently-critical operator eventually surfaces the
 * 429 rather than hanging the client past its own timeout. Kill-switch:
 * PAPERCUSP_MCP_PROXY_ABSORB_429=0 (forwards the 429 straight through, pre-P-010 behavior).
 */
export const MAX_BACKPRESSURE_RETRIES = 20;
/** Clamp for a Retry-After wait so a missing/hostile header value can't wedge the proxy loop. */
const MAX_BACKPRESSURE_WAIT_MS = 3000;
/**
 * EI-21524426281638998 — shed responses carry a bounded estimate of how long it should take
 * for an admission slot to drain. Keep only a short, bounded history: this is a hint for a
 * caller, not a second queue or an unbounded telemetry buffer.
 */
export const SHED_DRAIN_RATE_WINDOW_MS = 30_000;
export const MIN_SHED_RETRY_AFTER_SEC = 1;
export const MAX_SHED_RETRY_AFTER_SEC = 30;
const MAX_SHED_DRAIN_SAMPLES = 256;
/**
 * EI-16883 — boot-window status absorption. During a :3070 restart there is a window where
 * the socket ACCEPTS but the route table is not yet mounted: /api/mcp answers 404/405 (and
 * a booting worker can shed 503 before admission control is up). Like a 429, these statuses
 * mean the tool handler NEVER dispatched — the request was not fulfilled — so replaying is
 * write-safe for ANY ForwardClass. Measured 2026-07-19: 1,395 boot-window 405s passed
 * through to clients in 48h; each marks the MCP server "failed" in its Claude Code session,
 * drops + re-adds the tool catalog, and full-invalidates that session's prompt cache (the
 * dominant slice of the fleet's cache-write bill). Absorbed exactly like 429s — bounded by
 * the same retry window + max count, then surfaced honestly. Kill-switch:
 * PAPERCUSP_MCP_PROXY_ABSORB_BOOT=0. Cost: a GENUINE malformed-path 404/405 now surfaces
 * after the window instead of instantly — acceptable; well-formed clients never see these
 * statuses in steady state.
 */
export const BOOT_WINDOW_STATUSES: ReadonlySet<number> = new Set([
  404, 405, 503,
]);
/** Above this serialized size we do NOT rewrite the body to inject a key: re-stringifying a
 *  pathologically large tools/call would block the proxy loop, and that call is exactly the
 *  one we must not block on. Forgoing its key only drops it to 'opaque' (refused-only). */
const INJECT_MAX_BODY_BYTES = 256 * 1024;
/** Mirrors the server's validIdempotencyKey bound (_mcp-result-replay.ts KEY_MAX=200) so a
 *  client-supplied key we "respect" is one :3070 will actually honor for replay. */
const IDEM_KEY_MAX = 200;

function isValidIdemKey(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.trim().length <= IDEM_KEY_MAX
  );
}

/** How a forwarded request may be retried AFTER the socket connected:
 *  - 'idempotent' — no tools/call present → replaying has no side effect, always safe.
 *  - 'readonly'   — every tools/call names a READ_ONLY_TOOLS verb → a replay re-executes a
 *                   side-effect-free call, so it can never double-apply (EI-21268234394605529).
 *  - 'keyed'      — every tools/call carries a valid idempotencyKey → a replay dedups
 *                   server-side instead of double-applying the write.
 *  - 'opaque'     — a tools/call with no usable key → NEVER replay (write-safety default). */
export type ForwardClass = "idempotent" | "readonly" | "keyed" | "opaque";
export type McpProxyForwardingResult =
  | "not_forwarded"
  | "queued"
  | "applied"
  | "outcome_unknown";
export const MCP_PROXY_FORWARDING_RESULTS = {
  notForwarded: "not_forwarded",
  queued: "queued",
  applied: "applied",
  outcomeUnknown: "outcome_unknown",
} as const satisfies Record<string, McpProxyForwardingResult>;

export function forwardingResultForUpstreamFailure(
  connected: boolean,
): McpProxyForwardingResult {
  return connected
    ? MCP_PROXY_FORWARDING_RESULTS.outcomeUnknown
    : MCP_PROXY_FORWARDING_RESULTS.notForwarded;
}

export interface PreparedForward {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  klass: ForwardClass;
  /** True when the outer tools/call is code:run (directly or through tools:invoke). */
  hasCodeRunWrapper: boolean;
  /**
   * Bounded JSON-RPC method names from the parsed batch (`initialize`,
   * `tools/list`, `tools/call`, ...). Payloads and tool names are deliberately
   * excluded: this exists only to split the broad `idempotent` timeout class
   * into actionable protocol paths in the failure ledger.
   */
  rpcMethods: string[];
}

/** A pathological batch must not turn one telemetry record into an unbounded payload. */
export const MAX_RECORDED_RPC_METHODS = 8;

function recordedRpcMethods(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const method = (message as { method?: unknown }).method;
    if (typeof method !== "string" || out.includes(method)) continue;
    out.push(method);
    if (out.length >= MAX_RECORDED_RPC_METHODS) break;
  }
  return out;
}

/**
 * EI-21268234394605529 — verbs whose handler is PROVABLY side-effect-free, eligible for a
 * bounded post-connect socket-error replay ('readonly' class). CURATED ON PURPOSE: this
 * proxy is a dependency-free passthrough (node:http/node:crypto only), so it must not import
 * the tool catalog to derive effects. The safe failure direction is omission — a read
 * missing from this set keeps today's exact 'keyed' behavior, while a WRITE wrongly added
 * here could be silently double-applied on a replay. The writer-exclusion guard test in
 * proxy.test.ts pins known mutators OUT; when adding a name here, verify its handler
 * performs no writes (no PG mutations, no fs writes outside tmp, no external sends).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // filesystem reads are side-effect-free, including result-door scratch pages
  "capability:read",
  // build/type diagnostics (the reported failure: scoped tsc runs are pure reads)
  "build:typecheck",
  // dev observability reads
  "dev:pipeline_position",
  "dev:pg_query",
  "dev:service_health",
  "dev:telemetry",
  "dev:listening_ports",
  "dev:build_status",
  "dev:migrations",
  "dev:rate_governor_status",
  // Journal reads have no application side effects; a bounded replay recovers a lost log response.
  "logs:read",
  // bounded activity ledger reads are safe to replay after a stale socket;
  // admission still reserves only the explicitly scoped form below.
  "activity:tool-log",
  // documentation + search reads
  "docs:get",
  "docs:search",
  "docs:outline",
  "search:fulltext",
  "search:semantic",
  // Session reads refresh live transcripts into persistent index state; keep them
  // outside this pure-read retry allowlist so a reset cannot overlap ingestion.
  // memory recall (search ONLY — remember/forget mutate the store)
  "memory:search",
  // work-item / plan reads
  "work_items:list",
  "work_items:get",
  "work_items:search",
  "work_items:claimable",
  // Scorecard reads use seed-free rubric resolution; a missing/malformed rubric stays
  // unknown instead of entering the first-party lazy-seed writer.
  "scorecards:get",
  "scorecards:list",
  // The bounded grading preflight is also side-effect-free and safe to replay.
  "scorecards:evaluate",
  "plans:get",
  "plans:get-specs",
  "plans:list",
  "plans:items",
  "plans:search",
  // Recipe discovery is read-only; the bounded semantic:false form is also
  // reserved under critical pressure so recovery can find a reusable path
  // without invoking the embedder.
  "recipes:search",
  // test-run history
  "testing:runs",
  // harness / fleet status snapshots
  "harness:list",
  "harness:status",
  "harness:get",
  "fleet:assignments",
  "fleet:status",
  // coordination/state reads (presence/glance are pure snapshots;
  // coord:inbox EXCLUDED — reading marks messages read)
  "coord:presence",
  "coord:roster",
  "coord:glance",
  // coord:whoami resolves the caller identity without mutating coordination state.
  "coord:whoami",
  // coord:read fetches one message without advancing the inbox read cursor;
  // unlike coord:inbox, replaying it cannot mutate coordination state.
  "coord:read",
  // conversations:list only reads conversation rows/topics; replaying it is safe
  // for reconciliation after a preceding consult write has an unknown outcome.
  "conversations:list",
  "events:catalog",
  "events:status",
  "facts:list",
  "state:read",
  "locks:list",
  "locks:queue",
  // Loop state is a pure snapshot; unlike loop:checkpoint/loop:end it does not mutate.
  "loop:status",
  // capability discovery (find ONLY — tools:invoke EXECUTES arbitrary tools)
  "tools:find",
]);

/**
 * EI-21677017866028949 — the LOOKUP key is normalized (normalizeMcpName folds `[:_.-]+`
 * to ':'), but the curated set above stores RAW verbs. Any entry containing an underscore
 * therefore normalized to a key that was not in the set and could never match — silently
 * unreachable, so 9 of 38 entries (work_items:get/list/claimable, dev:pg_query,
 * dev:pipeline_position, dev:service_health, dev:listening_ports, dev:build_status,
 * dev:rate_governor_status) classified 'keyed' instead of 'readonly' and were never
 * replayed on a post-connect reset. `work_items:get` did not even match itself. The
 * underscore-free entries (loop:status, events:status, coord:read, build:typecheck) worked,
 * which is why the gap survived: every test in proxy.test.ts happens to name one of those.
 *
 * Normalize ONCE at module load and compare normalized-to-normalized. READ_ONLY_TOOLS stays
 * the human-readable curated list (and the writer-exclusion guard keeps reading it directly).
 */
const READ_ONLY_TOOLS_LOOKUP: ReadonlySet<string> = new Set(
  [...READ_ONLY_TOOLS].map(normalizeMcpName),
);

const READ_ONLY_TOOLS_INVOKE_NAME = normalizeMcpName("tools:invoke");
const CAPABILITY_BASH_NAME = normalizeMcpName("capability:bash");
const RELEASE_CUT_NAME = normalizeMcpName("release:cut");

function forwardedToolName(m: unknown): string | null {
  if (!m || typeof m !== "object") return null;
  const params = (m as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params))
    return null;
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const normalizedName = normalizeMcpName(name);
  if (normalizedName !== READ_ONLY_TOOLS_INVOKE_NAME) return normalizedName;

  // Deferred tools:invoke calls carry the actual tool identity in arguments.name.
  // Inspect only that one nested target; an unknown/malformed wrapper stays non-read-only.
  const invokeArgs = (params as { arguments?: unknown }).arguments;
  if (
    !invokeArgs ||
    typeof invokeArgs !== "object" ||
    Array.isArray(invokeArgs)
  )
    return null;
  const target = (invokeArgs as { name?: unknown }).name;
  return typeof target === "string" ? normalizeMcpName(target) : null;
}

/** The effective target arguments, unwrapping tools:invoke's optional JSON string. */
function forwardedToolArgs(m: unknown): unknown {
  if (!m || typeof m !== "object") return null;
  const params = (m as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params))
    return null;
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const argumentsValue = (params as { arguments?: unknown }).arguments;
  if (normalizeMcpName(name) !== READ_ONLY_TOOLS_INVOKE_NAME)
    return argumentsValue;
  if (
    !argumentsValue ||
    typeof argumentsValue !== "object" ||
    Array.isArray(argumentsValue)
  )
    return null;
  const nested = (argumentsValue as { args?: unknown }).args;
  if (typeof nested !== "string") return nested;
  try {
    return JSON.parse(nested) as unknown;
  } catch {
    return null;
  }
}

function isReadOnlyToolCall(m: unknown): boolean {
  const name = forwardedToolName(m);
  if (name === null) return false;
  if (READ_ONLY_TOOLS_LOOKUP.has(name)) return true;
  // release:cut is a mixed-effect tool. Only its status operation reads local
  // markers/logs and systemd state; every other operation must keep the keyed path.
  if (name === RELEASE_CUT_NAME) {
    const args = forwardedToolArgs(m);
    return (
      !!args &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      (args as { op?: unknown }).op === "status"
    );
  }
  return (
    name === CAPABILITY_BASH_NAME &&
    classifyCapabilityBashEffect(forwardedToolArgs(m)) === "read"
  );
}

const CODE_RUN_TOOL_NAME = normalizeMcpName("code:run");

function isCodeRunToolCall(m: unknown): boolean {
  return forwardedToolName(m) === CODE_RUN_TOOL_NAME;
}
/**
 * Classify a forward and, for a tools/call, inject a per-request `_meta.idempotencyKey`
 * so a post-connect retry is write-safe (:3070 replays the stored result). PURE +
 * unit-tested; `genKey` is injected for determinism. A VALID client-supplied key is
 * respected (never overwritten); an INVALID one (the server would ignore it) drops the
 * whole request to 'opaque'. Only a POST JSON body can carry a tools/call.
 *
 * EI-21268234394605529: a batch whose every tools/call names a READ_ONLY_TOOLS verb
 * classifies 'readonly' BEFORE any key logic — replay safety comes from the tool's own
 * side-effect freedom, not stored-result dedup, so keys are neither needed nor injected
 * and the body is returned untouched.
 */
export function prepareForward(
  method: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  opts: {
    keyingEnabled: boolean;
    readonlyRetryEnabled?: boolean;
    genKey: () => string;
    requestPath?: string;
  },
): PreparedForward {
  if (method !== "POST" || body.length === 0)
    return { body, headers, klass: "opaque", hasCodeRunWrapper: false, rpcMethods: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { body, headers, klass: "opaque", hasCodeRunWrapper: false, rpcMethods: [] }; // non-JSON — cannot classify → safe default
  }
  // bootstrap-su is a REST mutation, not a JSON-RPC handshake. Its JSON has no
  // tools/call, which otherwise makes prepareForward label it "idempotent" and
  // abort/replay the upstream after the handshake's 8s no-header limit. Keep
  // proxy replay off even when the body has a bootstrap idempotency key: the
  // route's ledger can fail open, so only psu's typed same-key retry may recover.
  const requestPath = opts.requestPath?.split("?")[0]?.replace(/\/+$/, "");
  if (
    requestPath === "/api/agent-mcp/console/bootstrap-su" ||
    requestPath === "/api/agent-mcp/console/bootstrap-role"
  ) {
    return { body, headers, klass: "opaque", hasCodeRunWrapper: false, rpcMethods: [] };
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  const rpcMethods = recordedRpcMethods(msgs);
  const isCall = (
    m: unknown,
  ): m is { method?: unknown; params?: Record<string, unknown> } =>
    !!m &&
    typeof m === "object" &&
    (m as { method?: unknown }).method === "tools/call";
  const calls = msgs.filter(isCall);
  const hasCodeRunWrapper = calls.some(isCodeRunToolCall);
  if (calls.length === 0)
    return { body, headers, klass: "idempotent", hasCodeRunWrapper, rpcMethods }; // no write → free safe retry

  if (!opts.keyingEnabled)
    return { body, headers, klass: "opaque", hasCodeRunWrapper, rpcMethods }; // kill-switch → refused-only
  if (body.length > INJECT_MAX_BODY_BYTES)
    return { body, headers, klass: "opaque", hasCodeRunWrapper, rpcMethods };
  // EI-21268234394605529: a provably read-only tools/call may be replayed on a post-connect
  // socket error (re-executing a read cannot double-apply). Gated behind BOTH switches: the
  // keying master switch above (PAPERCUSP_MCP_PROXY_KEYED_RETRY=0 = pre-P-005 refused-only)
  // and its own PAPERCUSP_MCP_PROXY_READONLY_RETRY=0. Unknown / oversized / switched-off
  // bodies fall through to the existing keyed/opaque path unchanged.
  if (opts.readonlyRetryEnabled !== false && calls.every(isReadOnlyToolCall)) {
    return { body, headers, klass: "readonly", hasCodeRunWrapper, rpcMethods }; // body untouched — no key injection needed
  }

  let mutated = false;
  for (const m of calls) {
    const params =
      m.params && typeof m.params === "object"
        ? m.params
        : (m.params = {} as Record<string, unknown>);
    const meta =
      params._meta && typeof params._meta === "object"
        ? (params._meta as Record<string, unknown>)
        : {};
    if (isValidIdemKey(meta.idempotencyKey)) continue; // respect a valid client key
    if (meta.idempotencyKey !== undefined)
      return { body, headers, klass: "opaque", hasCodeRunWrapper, rpcMethods }; // invalid client key → can't safely retry
    meta.idempotencyKey = opts.genKey();
    params._meta = meta;
    m.params = params;
    mutated = true;
  }
  if (!mutated) return { body, headers, klass: "keyed", hasCodeRunWrapper, rpcMethods }; // already client-keyed, body unchanged
  const newBody = Buffer.from(JSON.stringify(parsed), "utf8");
  const newHeaders: http.IncomingHttpHeaders = {
    ...headers,
    "content-length": String(newBody.length),
  };
  delete newHeaders["transfer-encoding"];
  return { body: newBody, headers: newHeaders, klass: "keyed", hasCodeRunWrapper, rpcMethods };
}

/**
 * Post-connect retry decision (PURE + unit-tested): only a write-free request may be
 * replayed — the 'idempotent' control-plane class, or EI-21268234394605529's 'readonly'
 * class (every tools/call names a READ_ONLY_TOOLS verb, so re-execution cannot double-apply).
 * A keyed tools/call remains recoverable only AFTER its first execution stores a result; an
 * immediate retry can overlap that still-running call and double-apply the mutation.
 */
export function postConnectRetryable(
  klass: ForwardClass,
  retriesUsed: number,
  maxRetries: number,
  elapsedMs: number,
  windowMs: number,
): boolean {
  if (klass !== "idempotent" && klass !== "readonly") return false;
  if (retriesUsed >= maxRetries) return false;
  return elapsedMs < windowMs;
}

/**
 * WI-6740 — upstream SILENCE, the one failure class the retry ladder above did not cover.
 *
 * Every branch so far reacts to an upstream ERROR: refused (pre-connect), a socket reset
 * (post-connect), a 429, a boot-window status. But when :3070 ACCEPTS the connection and
 * then simply stops responding, nothing fails from the proxy's point of view — so no retry
 * path is ever entered. `forwardOnce` had no timeout, so the proxy waited indefinitely and
 * the CLIENT's own (shorter) timeout fired first.
 *
 * That is session-fatal, not a blip. An MCP client fetches the tool catalog ONCE, at
 * connect, so a ~10s stall landing on that handshake costs a MULTI-HOUR agent session its
 * entire tool plane ("Reconnected … but fetching tools failed: Request timed out", then
 * zero papercusp tools for the rest of its life). ~/.papercusp/mcp-proxy-watchdog.log
 * recorded 269 such stalls between 2026-07-10 and 2026-08-01, EVERY one followed by
 * `recovered (was unreachable 10s)` — which reads as benign self-healing at the watchdog's
 * layer and is why this went unfixed for three weeks. The severity is invisible to the
 * layer that observes it.
 *
 * Bound ONLY the 'idempotent' class — a batch containing NO tools/call, i.e. exactly the
 * control-plane handshake (initialize / tools/list / ping / resources / prompts). Those are
 * cheap catalog reads: one taking >8s is definitionally stalled, and replaying them is
 * free (no writes). A real tools/call MUST stay unbounded — `build:typecheck` legitimately
 * runs ~160s and `capability:bash` ~120s on this box, so a blanket upstream timeout would
 * convert working long tools into hard failures. That asymmetry is the whole design.
 */
export const HANDSHAKE_UPSTREAM_TIMEOUT_MS = Number(
  process.env.PAPERCUSP_MCP_PROXY_HANDSHAKE_TIMEOUT_MS ?? 8_000,
);

/** Handshake-timeout replays allowed per request (→ up to 3 attempts ≈ 25s worst case,
 *  comfortably inside a typical ~30s client budget). Deliberately SEPARATE from
 *  MAX_POST_CONNECT_RETRIES: that bound exists because a socket error may have already
 *  applied a side effect, which cannot happen for a write-free idempotent batch. */
export const MAX_HANDSHAKE_TIMEOUT_RETRIES = 2;

/**
 * Whether an upstream-silence timeout should be replayed (PURE + unit-tested). Only the
 * write-free 'idempotent' control-plane class qualifies: any tools/call — including
 * 'readonly' (EI-21268234394605529), whose members legitimately run minutes
 * (`build:typecheck` ~160s) — stays on the generous maxHoldMs ceiling, never this 8s
 * handshake bound, and surfaces honestly instead of being replayed blind.
 */
export function handshakeTimeoutRetryable(
  klass: ForwardClass,
  retriesUsed: number,
  maxRetries: number,
  elapsedMs: number,
  windowMs: number,
  nextAttemptBudgetMs = 0,
): boolean {
  if (klass !== "idempotent") return false;
  if (retriesUsed >= maxRetries) return false;
  // EI-21554095087170158: a timer can fire substantially late when the local proxy
  // process is CPU-starved. Starting another full response-header attempt merely because
  // `elapsedMs < windowMs` then guarantees that the request overruns its own retry window
  // (measured: an 8s timer fired at 22.7s, then the handshake surfaced after 37.7s).
  // Require enough remaining wall-clock budget for the next bounded attempt. The default
  // preserves the pure helper's historical behavior for callers that have no attempt bound.
  return elapsedMs + Math.max(0, nextAttemptBudgetMs) < windowMs;
}

/**
 * Whether an upstream STATUS is transient admission-control backpressure the proxy should
 * ABSORB (retry) rather than forward to the agent. Only 429 (P-010): HTTP defines 429 as
 * "not fulfilled", so a retry never double-applies — safe regardless of ForwardClass, unlike
 * a post-connect socket error whose side effect is unknown. PURE + unit-tested.
 */
export function isBackpressureStatus(status: number): boolean {
  return status === 429;
}

/** Bounded backpressure-retry decision (PURE + unit-tested): keep absorbing a 429 while
 *  under both the per-request max count and the retry window. */
export function backpressureRetryable(
  retriesUsed: number,
  maxRetries: number,
  elapsedMs: number,
  windowMs: number,
): boolean {
  return retriesUsed < maxRetries && elapsedMs < windowMs;
}

/** EI-21504897841052086 — PURE + unit-tested via the queue-dwell behavior specs: a queued
 *  handshake whose dwell reached the bound is shed with 429 instead of waiting indefinitely.
 *  `maxWaitMs <= 0` disables expiry (the previous unbounded behavior). */
export function handshakeQueueWaitExpired(
  waitedMs: number,
  maxWaitMs: number,
): boolean {
  return maxWaitMs > 0 && waitedMs >= maxWaitMs;
}

/**
 * Parse a `Retry-After` DELTA-SECONDS header into ms, clamped to [0, maxMs] with a fallback
 * when the header is absent/invalid — so a missing value still backs off and a hostile huge
 * value can't wedge the proxy loop. (We only emit delta-seconds server-side, so HTTP-date
 * forms aren't parsed.) PURE + unit-tested.
 */
export function retryAfterMs(
  header: string | string[] | undefined,
  fallbackMs: number,
  maxMs: number,
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const secs = raw != null && raw !== "" ? Number(raw) : NaN;
  const ms = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : fallbackMs;
  return Math.max(0, Math.min(ms, maxMs));
}

/**
 * Estimate a bounded Retry-After hint from the proxy's observed forward completion cadence.
 * `currentInFlight - admissionCeiling + 1` is the number of completions needed before a new
 * request can be admitted. With no trustworthy recent cadence (zero/one samples, stale samples,
 * or same-timestamp samples), return the conservative upper bound: zero observed drain means a
 * short fixed delay would only teach callers to retry into the same saturated wall.
 * PURE + unit-tested.
 */
export function retryAfterSecForDrainRate(
  currentInFlight: number,
  admissionCeiling: number,
  completionTimesMs: readonly number[],
  nowMs: number,
  options: {
    windowMs?: number;
    minSec?: number;
    maxSec?: number;
  } = {},
): number {
  const windowMs =
    Number.isFinite(options.windowMs) && (options.windowMs ?? 0) > 0
      ? options.windowMs!
      : SHED_DRAIN_RATE_WINDOW_MS;
  const configuredMinSec =
    Number.isFinite(options.minSec) && (options.minSec ?? 0) > 0
      ? options.minSec!
      : MIN_SHED_RETRY_AFTER_SEC;
  const configuredMaxSec =
    Number.isFinite(options.maxSec) && (options.maxSec ?? 0) > 0
      ? options.maxSec!
      : MAX_SHED_RETRY_AFTER_SEC;
  const minSec = Math.max(1, configuredMinSec);
  const maxSec = Math.max(minSec, configuredMaxSec);
  const cutoffMs = nowMs - windowMs;
  const recent = completionTimesMs
    .filter(
      (timestamp) =>
        Number.isFinite(timestamp) &&
        timestamp >= cutoffMs &&
        timestamp <= nowMs,
    )
    .slice()
    .sort((a, b) => a - b);
  const completionsNeeded = Math.max(1, currentInFlight - admissionCeiling + 1);
  let waitMs = maxSec * 1000;
  if (recent.length >= 2) {
    const observedSpanMs = recent[recent.length - 1] - recent[0];
    if (observedSpanMs > 0) {
      const completionsPerMs = (recent.length - 1) / observedSpanMs;
      waitMs = completionsNeeded / completionsPerMs;
    }
  }
  return Math.max(minSec, Math.min(maxSec, Math.ceil(waitMs / 1000)));
}

interface ForwardOutcome {
  /** The upstream response, when one was received. */
  ures?: http.IncomingMessage;
  /** The error, when the forward failed. */
  err?: NodeJS.ErrnoException;
  /** Whether the TCP socket connected before the error (gates retry safety). */
  connected: boolean;
  /** WI-6740: the attempt was abandoned because upstream went SILENT past `timeoutMs`,
   *  as opposed to actively failing. Distinguished so the caller can apply the
   *  idempotent-only replay rule instead of the socket-error one. */
  timedOut?: boolean;
}

/** One forward attempt. Resolves with the upstream response OR an error + whether the
 *  socket had connected (so the caller can decide retry-safety). Never rejects.
 *  `timeoutMs` (WI-6740) bounds how long we wait for RESPONSE HEADERS; 0/undefined =
 *  unbounded, which is what every real tools/call still uses.
 *
 *  `signal` (WI-35737) lets the caller abandon an attempt whose CLIENT has gone away, so the
 *  proxy stops spending upstream capacity producing a response nobody can read. The caller
 *  passes one ONLY for the write-free 'idempotent' class — aborting a keyed/opaque tools/call
 *  mid-flight could leave a write half-applied, which is the same retry-safety rule
 *  `handshakeTimeoutRetryable` already enforces. Abort surfaces through the existing
 *  `upstream.on('error')` path as an ordinary failed attempt; the caller then sees
 *  `clientGone` and breaks instead of replaying. */
function forwardOnce(
  opts: McpProxyOptions,
  target: McpProxyTarget,
  method: string,
  reqUrl: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  agent: http.Agent,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ForwardOutcome> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (o: ForwardOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(o);
    };
    const forwardedHeaders = stripClientConnectionHeader(
      injectCurrentSuperuserBearer(reqUrl, headers, {
        tokenPath: opts.superuserTokenPath,
        readToken: opts.readSuperuserToken,
      }),
    );
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method,
        path: reqUrl,
        // WI-41045: this is deliberately inside forwardOnce, not outside the
        // retry loop. A token can rotate between a reset and its replay.
        headers: {
          ...forwardedHeaders,
          host: `${target.host}:${target.port}`,
        },
        // W1.3: fresh socket per forward — never reuse a pooled keep-alive socket the :3070
        // cluster may be closing (the ~13% spurious-400 root cause). See UPSTREAM_AGENT above.
        agent,
        // WI-35737: abandon this attempt if the client disconnects (idempotent class only —
        // see the doc comment above). Node destroys the request and emits 'error' with
        // code ABORT_ERR, which the existing handler below turns into a normal outcome.
        signal,
      },
      (ures) => done({ ures, connected: true }),
    );
    upstream.on("socket", (s) => {
      // Once the TCP handshake completes, the request is (or may be) in flight at :3070.
      // A reused keep-alive socket is ALREADY connected — return without adding a
      // 'connect' listener (one per proxied request accumulated on the shared socket:
      // the MaxListenersExceededWarning in the unit journal, mcp-outage-triage-2026-07-02).
      if (s.connecting === false) {
        connected = true;
        return;
      }
      s.once("connect", () => {
        connected = true;
      });
    });
    upstream.on("error", (err: NodeJS.ErrnoException) =>
      done({ err, connected }),
    );
    // WI-6740: bound the wait for RESPONSE HEADERS. Note this is deliberately NOT
    // `upstream.setTimeout` (socket INACTIVITY): a stalled :3070 can keep the socket alive
    // while producing nothing, which inactivity never fires on. We want wall-clock silence.
    // `connected: true` is asserted so this can never be mistaken for a refused upstream
    // (which would be replayed unconditionally); the caller gates it on the idempotent class.
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        const err: NodeJS.ErrnoException = Object.assign(
          new Error(`upstream silent for ${timeoutMs}ms (no response headers)`),
          { code: "ETIMEDOUT" },
        );
        upstream.destroy();
        done({ err, connected: true, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
    }
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

/**
 * EI-19294517824914302 — a CHEAP REPEATING BEAT must not inherit the restart-sized retry
 * window. This is the single highest-volume failure path on the box, and the cause is a
 * classifier gap, not a bug in either layer on its own.
 *
 * `prepareForward` classifies by MCP BATCH SHAPE: a POST whose JSON body contains no
 * `tools/call` is 'idempotent' (proxy.ts's `calls.length === 0` branch). That rule was
 * written for the MCP control-plane handshake — initialize / tools/list / ping — where a
 * long retry window is exactly right: a client fetches the tool catalog ONCE per session,
 * so losing that one request costs a multi-hour agent its whole tool plane (WI-6740).
 *
 * But a plain REST beat like bootstrap-su/heartbeat is not an MCP batch at all. It has no
 * `tools/call`, so it falls through the same branch and silently inherits a budget sized to
 * outlast a full :3070 restart. Its own handler deliberately returns a SOFT 503 —
 * "the launcher treats any failure as a missed beat, never an error loop"
 * (routes/agent-mcp/bootstrap-su.ts) — and the proxy, which cannot see that intent, turns
 * that one shrug into ~30 attempts over 27-42s.
 *
 * MEASURED 2026-08-01: 13,330 of 13,754 proxy failures in 90 minutes were this ONE path
 * (97%), with SUCCESSES recording `attempts:30, elapsedMs:42361`. With ~140 agents beating
 * every ~60s, transient upstream slowness is multiplied ~30x on the hottest path in the
 * system, which sustains the slowness that caused it — a textbook metastable retry storm.
 *
 * The asymmetry is the whole point, and it mirrors WI-6740's: retry the ONE-SHOT handshake
 * generously (losing it is session-fatal, replaying is free), but retry a beat that repeats
 * every ~60s barely at all (the next one is already on its way, and replaying it is what
 * causes the storm). Fix at the CLASSIFIER — never by making the endpoint lie about its
 * status code.
 *
 * ⚠ WI-35737 (2026-08-08) — membership is a PROPERTY ("high-frequency + soft failure +
 * replacement already scheduled"), not a fixed roster. The canonical list is shared with the
 * health reader in operator-core so retry and alarm classification cannot drift.
 *
 * The recurrence: `/api/agent-mcp/mid-turn-context` is the per-tool-batch memory-injection
 * search — simultaneously the most EXPENSIVE endpoint on the box (`searchMs` p50 1000ms,
 * p90 1364ms, max 4954ms over 522 samples) and one of the highest-frequency (every tool
 * batch, every agent). It carries no `tools/call`, so it took the 'idempotent' branch and
 * inherited the restart-sized window PLUS up to `MAX_HANDSHAKE_TIMEOUT_RETRIES` replays.
 *
 * MEASURED 2026-08-08 16:00-18:12Z, while :3070's data plane was intermittently stalling on
 * `withWorkspace:acquire(app)` (EI-19485014132257783 — the ROOT cause, not this file's):
 *   - handshake_timeout_retry: 385 of 540 (71%) were this ONE path
 *   - post_connect_retry:      175 of 245 (71%) were this ONE path
 *   - every `upstream_error` was `upstream silent for 8000ms (no response headers)`
 * Each replay re-runs that multi-second search against the upstream that is already failing
 * (`recovered after 2 attempts (12623ms)` is the SUCCESS case — it still cost two searches),
 * so the proxy multiplied load ~4x onto the exact dependency that was struggling and turned
 * a bursty upstream stall into a fleet-wide 429 outage. Same storm, same classifier, new path.
 *
 * The memory-injection paths satisfy the property: losing one is SOFT (the agent's turn simply
 * carries no memory-injection block — `injection.ts` degrades, it does not fail), and the
 * replacement is already scheduled (the next tool batch / the next turn).
 *
 * The canonical path list and predicate now live in operator-core and are shared with the
 * system-health reader. Keeping one classifier prevents a path from receiving the cheap-beat
 * retry budget while still being counted as a hard failure by health (EI-21304678711668996).
 */

/** Retry budget for a cheap repeating beat: one prompt re-attempt, then give up and let the
 *  NEXT beat carry the liveness signal. Deliberately far below `retryWindowMs`. */
export const CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS = 2000;

/** The retry window this REQUEST gets — the restart-sized default, unless it is a cheap
 *  repeating beat, which must fail fast rather than amplify (EI-19294517824914302). */
export function effectiveRetryWindowMs(url: string, windowMs: number): number {
  return isCheapRepeatingBeat(url)
    ? Math.min(CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS, windowMs)
    : windowMs;
}

/**
 * EI-19305299022434394 — the admission-control ceiling on TOTAL concurrent forwards this proxy
 * instance will hold across the NORMAL ordinary + reserved partition, independent of
 * `DEFAULT_MAX_UPSTREAM_SOCKETS` (which bounds upstream TCP connections). The one-socket
 * watchdog and critical-continuation emergency lanes are deliberately outside that partition,
 * so recovery remains possible at saturation without reopening unbounded admission. The normal
 * ceiling is deliberately well ABOVE the socket bound so healthy queuing is not shed; it exists
 * to catch the genuinely runaway case that would otherwise pile up invisibly in the agent queue.
 */
export const DEFAULT_MAX_IN_FLIGHT = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_IN_FLIGHT ?? 200,
);
export const DEFAULT_CONTROL_PLANE_RESERVE = Number(
  process.env.PAPERCUSP_MCP_PROXY_CONTROL_PLANE_RESERVE ?? 8,
);
/**
 * EI-21395174573687098 — the watchdog probe has its own upstream agent, so the full reserved
 * control-plane pool is available to ordinary reconnect handshakes. This is a class cap, not a
 * smaller global ceiling: long tools/call traffic retains the existing admission contract. An
 * explicit non-positive env/option value disables it.
 */
export const DEFAULT_MAX_HANDSHAKES_IN_FLIGHT = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_HANDSHAKES_IN_FLIGHT ??
    Math.max(1, DEFAULT_CONTROL_PLANE_RESERVE),
);
/**
 * EI-21395173692390816 — a reconnect burst should wait in a small FIFO instead of making every
 * client independently retry the same handshake. The default absorbs a burst of roughly eight
 * class caps while remaining a hard memory bound; set the env/option to 0 to retain shed-now.
 */
const configuredMaxHandshakeQueue = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_HANDSHAKE_QUEUE ?? 64,
);
export const DEFAULT_MAX_HANDSHAKE_QUEUE = Number.isFinite(
  configuredMaxHandshakeQueue,
)
  ? Math.max(0, Math.floor(configuredMaxHandshakeQueue))
  : 64;
/**
 * EI-21556422206126497 — continuation writes are deliberately single-flight upstream, but
 * immediate shed-on-one made the durability plane fail exactly when two sessions checkpointed
 * together. The default bound must cover the proxy's supported concurrent admission population:
 * a fixed 16-slot FIFO still rejected checkpoints while the normal proxy legitimately admitted
 * 200 sessions (EI-21656350947178031). Keep an explicit env override, but derive the default from
 * the same ceiling rather than maintaining a smaller, drifting capacity island.
 */
const configuredMaxCriticalContinuationQueue = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_CRITICAL_CONTINUATION_QUEUE ??
    DEFAULT_MAX_IN_FLIGHT,
);
export const DEFAULT_MAX_CRITICAL_CONTINUATION_QUEUE = Number.isFinite(
  configuredMaxCriticalContinuationQueue,
)
  ? Math.max(0, Math.floor(configuredMaxCriticalContinuationQueue))
  : DEFAULT_MAX_IN_FLIGHT;
/** EI-21669304707115602 — pure `coord:send` uses a separate FIFO with the same default bound
 * as the general continuation queue; callers may tune the lanes independently. */
export const DEFAULT_MAX_COORD_SEND_QUEUE =
  DEFAULT_MAX_CRITICAL_CONTINUATION_QUEUE;
/** EI-22728723476698098 — keep incident-capture queue capacity bounded independently of the
 * shared durability FIFO. The default follows the existing admission population, while callers
 * may lower it for a deliberately tighter recovery lane. */
const configuredMaxImprovementsCaptureQueue = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_IMPROVEMENTS_CAPTURE_QUEUE ??
    DEFAULT_MAX_CRITICAL_CONTINUATION_QUEUE,
);
export const DEFAULT_MAX_IMPROVEMENTS_CAPTURE_QUEUE = Number.isFinite(
  configuredMaxImprovementsCaptureQueue,
)
  ? Math.max(0, Math.floor(configuredMaxImprovementsCaptureQueue))
  : DEFAULT_MAX_CRITICAL_CONTINUATION_QUEUE;
const MAX_CRITICAL_CONTINUATION_HEALTH_REQUESTS = 16;
/**
 * EI-21504897841052086 — bounded dwell for a handshake WAITING in the admission FIFO.
 * During the measured wedge, clients hung 16-44s while the proxy held their handshakes
 * indefinitely behind 8 stuck slots; shedding at ~30s answers honestly inside typical
 * client budgets. 0 disables expiry.
 */
const configuredHandshakeQueueWaitMs = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_QUEUE_WAIT_MS ?? 30_000,
);
export const DEFAULT_HANDSHAKE_QUEUE_WAIT_MS =
  Number.isFinite(configuredHandshakeQueueWaitMs) &&
  configuredHandshakeQueueWaitMs >= 0
    ? Math.floor(configuredHandshakeQueueWaitMs)
    : 30_000;
/** EI-21504897841052086 — per-waiter queue telemetry cadence. The wedge window recorded ONLY
 *  arrival rows, so 13 minutes of saturation left zero ledger evidence. Mirrors the
 *  per-request heartbeat pattern (EI-19388661789704364). 0 disables. */
const configuredQueueWaitLogMs = Number(
  process.env.PAPERCUSP_MCP_PROXY_QUEUE_WAIT_LOG_MS ?? 5_000,
);
export const DEFAULT_HANDSHAKE_QUEUE_WAIT_LOG_MS =
  Number.isFinite(configuredQueueWaitLogMs) && configuredQueueWaitLogMs > 0
    ? Math.floor(configuredQueueWaitLogMs)
    : 5_000;
const configuredCriticalContinuationQueueWaitMs = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_CRITICAL_CONTINUATION_QUEUE_WAIT_MS ??
    0,
);
/**
 * Continuation writes are the recovery boundary for the overload they may be waiting behind.
 * Keep the FIFO length bounded, but do not expire an admitted waiter by default: a legitimate
 * work_items:complete can occupy the single continuation socket longer than the ordinary 30s
 * queue dwell (measured at 61.8s), and shedding a queued checkpoint leaves its mutation outcome
 * unknown at exactly the point where it is needed for compaction recovery. Client disconnects
 * still cancel queued waiters, while operators may opt into a finite dwell with the env/option.
 * Zero means expiry disabled, matching the explicit option contract below.
 */
export const DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_MS =
  Number.isFinite(configuredCriticalContinuationQueueWaitMs) &&
  configuredCriticalContinuationQueueWaitMs >= 0
    ? Math.floor(configuredCriticalContinuationQueueWaitMs)
    : 0;
/**
 * Leave enough of ptool's 60s `coord:send` deadline for the handler's bounded wake preflight
 * (two 15s stages) plus persistence/transport margin. Unlike checkpoints, a send still sitting
 * in the proxy FIFO has not mutated anything, so an explicit 429/not_forwarded is safer than an
 * opaque client timeout with outcome unknown.
 */
export const DEFAULT_COORD_SEND_QUEUE_WAIT_MS = 20_000;
/**
 * WI-950869 — leave enough of the MCP client's deadline for `improvements:capture` to report
 * an honest retryable result when its dedicated continuation socket is occupied. This is
 * intentionally separate from the generic critical-continuation default, which remains 0 so
 * durable checkpoint/completion writes do not become ambiguous by default.
 */
export const DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS = 20_000;
const configuredCriticalContinuationQueueWaitLogMs = Number(
  process.env.PAPERCUSP_MCP_PROXY_CRITICAL_CONTINUATION_QUEUE_WAIT_LOG_MS ??
    5_000,
);
export const DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_LOG_MS =
  Number.isFinite(configuredCriticalContinuationQueueWaitLogMs) &&
  configuredCriticalContinuationQueueWaitLogMs >= 0
    ? Math.floor(configuredCriticalContinuationQueueWaitLogMs)
    : 5_000;
/**
 * EI-19305299022434394 — see `McpProxyOptions.maxHoldMs`. 10 minutes is comfortably above any
 * legitimate tool's real runtime (`build:typecheck` ~160s, `capability:bash` ~120s) while still
 * cutting off the 32-89 minute silent parks the report measured.
 */
export const DEFAULT_MAX_HOLD_MS = Number(
  process.env.PAPERCUSP_MCP_PROXY_MAX_HOLD_MS ?? 10 * 60_000,
);
/** EI-19305299022434394 — see `McpProxyOptions.heartbeatIntervalMs`. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = Number(
  process.env.PAPERCUSP_MCP_PROXY_HEARTBEAT_MS ?? 30_000,
);

/**
 * Whether a NEW request should be shed (429, before opening any upstream socket) given how many
 * forwards are already in flight. PURE + unit-tested. `maxInFlight <= 0` disables shedding
 * entirely (unbounded, the pre-fix behavior) — an explicit opt-out, never the default.
 */
export function shouldShedForInFlight(
  currentInFlight: number,
  maxInFlight: number,
): boolean {
  if (maxInFlight <= 0) return false;
  return currentInFlight >= maxInFlight;
}

const RESERVED_CONTROL_PLANE_TOOLS = new Set(
  [
    "scheduler:get_next",
    "coord:orient",
    "coord:send",
    // The automatic status glance is a read-only liveness surface. Keep it on the
    // reserved admission path so a saturated ordinary pool cannot hide the fleet
    // state that agents use to recover from the saturation.
    "coord:glance",
    // Gate ownership is a recovery-critical state read: it must remain available
    // when ordinary traffic fills the non-reserved admission ceiling.
    "state:read",
    // DRAIN reconciliation reads must remain callable while ordinary tool traffic
    // occupies the non-reserved ceiling. `coord:inbox` is intentionally not in
    // READ_ONLY_TOOLS because reading it advances message-read state, but it is
    // still liveness-critical for recovering a fleet member.
    "coord:inbox",
    "fleet:assignments",
    "fleet:leader-brief",
    "loop:checkpoint",
    // Ending a loop is the terminal recovery action when a worker is blocked or the
    // queue is drained. Keep it callable at the reserved ceiling and isolate it from
    // a saturated reserved socket so the failed wake path can actually shut down.
    "loop:end",
    "session:request-compaction",
    "tools:find",
    "dev:service_health",
    "dev:pg_query",
    "loop:arm",
    "plans:get",
    "plans:search",
    "improvements:capture",
    "locks:acquire",
    "locks:queue",
    "locks:cancel_wait",
    "locks:release",
    // Event-wait registrations are the liveness/control-plane half of a paired
    // events:await/events:emit hand-off. Keep them on the reserve while ordinary
    // traffic is saturated so concurrent recovery waits can actually register.
    "events:await",
    "events:cancel",
    "work_items:checkpoint",
    "work_items:claimable",
    "work_items:complete",
    "work_items:get",
    "work_items:search",
    "work_items:release",
    "work_items:set_state",
  ].map(normalizeMcpName),
);
const SCORECARDS_LIST_TOOL_NAME = normalizeMcpName("scorecards:list");
const SCORECARDS_EVALUATE_TOOL_NAME = normalizeMcpName("scorecards:evaluate");
const DEV_TELEMETRY_TOOL_NAME = normalizeMcpName("dev:telemetry");
const ACTIVITY_TOOL_LOG_TOOL_NAME = normalizeMcpName("activity:tool-log");
const COORD_PRESENCE_TOOL_NAME = normalizeMcpName("coord:presence");
const COORD_ROSTER_TOOL_NAME = normalizeMcpName("coord:roster");
const TESTING_RUN_STATUS_TOOL_NAME = normalizeMcpName("testing:run-status");
const RECIPES_SEARCH_TOOL_NAME = normalizeMcpName("recipes:search");

function isReservedControlPlaneTool(name: string, args?: unknown, requestPath?: string): boolean {
  if (name === SCORECARDS_LIST_TOOL_NAME) return isBoundedScorecardsListArgs(args);
  if (name === SCORECARDS_EVALUATE_TOOL_NAME) {
    return isBoundedScorecardsEvaluateArgs(args) || isBoundedJudgeScorecardsEvaluateArgs(args, requestPath);
  }
  if (name === DEV_TELEMETRY_TOOL_NAME) return isBoundedDevTelemetryArgs(args);
  if (name === ACTIVITY_TOOL_LOG_TOOL_NAME) return isBoundedActivityToolLogArgs(args);
  if (name === COORD_PRESENCE_TOOL_NAME) return isBoundedCoordPresenceArgs(args);
  if (name === COORD_ROSTER_TOOL_NAME) return isBoundedCoordRosterArgs(args);
  if (name === TESTING_RUN_STATUS_TOOL_NAME) return isBoundedTestingRunStatusArgs(args);
  if (name === RECIPES_SEARCH_TOOL_NAME) return isBoundedRecipesSearchArgs(args);
  return RESERVED_CONTROL_PLANE_TOOLS.has(name);
}

// Continuation writes are a narrower, higher-priority slice of the reserved plane. Keep this
// separate from RESERVED_CONTROL_PLANE_TOOLS: the ordinary reserved pool is allowed to queue
// behind a slow upstream, while these writes are the durable boundary that lets a session recover
// from that exact condition.
const CRITICAL_CONTINUATION_TOOL_NAMES = [
  // EI-21549564362601660 — these are the two short writes an agent uses to
  // report and durably record a control-plane incident. Keeping them in the
  // ordinary reserved pool made the recovery channel disappear at exactly the
  // moment that pool saturated: ptool saw repeated upstream 502s followed by
  // proxy 429s even though the operator hosts were still healthy. Route them
  // through the existing isolated, bounded FIFO instead of creating another
  // admission system or allowing unbounded retries.
  "coord:send",
  "improvements:capture",
  "loop:checkpoint",
  "loop:end",
  "session:request-compaction",
  "work_items:checkpoint",
  "work_items:complete",
] as const;
const CRITICAL_CONTINUATION_TOOLS = new Set(
  CRITICAL_CONTINUATION_TOOL_NAMES.map(normalizeMcpName),
);
const CRITICAL_CONTINUATION_DISPLAY_NAMES = new Map(
  CRITICAL_CONTINUATION_TOOL_NAMES.map((name) => [
    normalizeMcpName(name),
    name,
  ]),
);

// EI-21266423740643882 — the watchdog's session-plane probe is a plain JSON-RPC
// `tools/list`, not a tools/call named by RESERVED_CONTROL_PLANE_TOOLS. The admission reserve
// is useless to the probe that diagnoses a saturated proxy unless the MCP handshake itself is
// recognized. Keep this deliberately narrow: only the stateless, write-free calls required to
// establish/prove a session, not every idempotent resources/prompts request.
const RESERVED_CONTROL_PLANE_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
]);
const TOOLS_INVOKE_NAME = normalizeMcpName("tools:invoke");
const COORD_SEND_TOOL_NAME = normalizeMcpName("coord:send");
const IMPROVEMENTS_CAPTURE_TOOL_NAME = normalizeMcpName("improvements:capture");
// EI-21564741982937381 — loop:checkpoint's own `{ read: true }` mode is a pure snapshot: it
// writes nothing, so it never needs the single critical-continuation socket's durability
// guarantee. Routing it through that one-socket bulkhead anyway meant a read could be shed
// behind an in-flight WRITE checkpoint even though the two never contend for anything real
// ("proxy critical-continuation class still reported one in-flight request and shed the
// read"). Excluding only this exact shape leaves every other loop:checkpoint call (the
// default, mutating one) on the critical lane unchanged; a read still lands on the ordinary
// RESERVED_CONTROL_PLANE_TOOLS slot (loop:checkpoint is listed there too), so it is not shed
// merely because it now skips the critical queue.
const LOOP_CHECKPOINT_TOOL_NAME = normalizeMcpName("loop:checkpoint");
function isLoopCheckpointReadOnlyContinuationArgs(
  toolName: string,
  args: unknown,
): boolean {
  if (toolName !== LOOP_CHECKPOINT_TOOL_NAME) return false;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  return (args as { read?: unknown }).read === true;
}

/**
 * Whether the complete JSON-RPC batch is a write-free session handshake. `prepareForward`
 * deliberately classifies a wider idempotent set; this narrower predicate exists only for the
 * reconnect bulkhead. A mixed batch that carries any other method must not inherit the class cap
 * (or the watchdog exemption) merely because one member is `tools/list`.
 */
export function isMcpSessionHandshakeCall(rawBody: Buffer): boolean {
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return (
      messages.length > 0 &&
      messages.every((message) => {
        if (!message || typeof message !== "object") return false;
        const method = (message as { method?: unknown }).method;
        return (
          typeof method === "string" &&
          RESERVED_CONTROL_PLANE_METHODS.has(method)
        );
      })
    );
  } catch {
    return false;
  }
}

/** The session-plane watchdog identifies its one diagnostic tools/list request by this exact
 * client query parameter. Keep the exemption path- and value-exact: ordinary reconnect clients
 * remain bounded, while the detector retains the one socket the default class cap leaves free. */
export function isMcpProxyWatchdogProbePath(requestPath: unknown): boolean {
  if (typeof requestPath !== "string") return false;
  try {
    const url = new URL(requestPath, "http://127.0.0.1");
    return (
      url.pathname === "/api/mcp" &&
      url.searchParams.get("client") === "mcp-proxy-watchdog"
    );
  } catch {
    return false;
  }
}

// psu launch/resume preflight and the PUI's canonical operator/store identity
// probe use plain REST rather than JSON-RPC. These calls are human/fleet entry
// points and must retain access to the reserve while ordinary tool traffic is
// saturated. Heartbeat is intentionally absent: it is a cheap repeating beat
// and should fail fast rather than consume a reserved slot.
export const RESERVED_CONTROL_PLANE_PATHS = new Set([
  "/api/adv/sessions/resumable",
  "/api/agent-mcp/console/bootstrap-su/options",
  "/api/agent-mcp/console/bootstrap-su",
  "/api/agent-mcp/console/bootstrap-su/session-ended",
  "/api/agent-mcp/console/bootstrap-su/session-resumed",
  "/api/agent-mcp/console/bootstrap-su/session-resume-finalized",
  "/api/agent-mcp/console/bootstrap-su/session-resume-released",
  "/api/agent-mcp/console/bootstrap-su/session-respawned",
  "/api/tui/identity",
]);

// One-shot lifecycle mutations are the boundary that creates/ends a live
// writer. They need the reserved admission pool plus the same isolated socket
// as continuation checkpoints. Heartbeat is deliberately excluded: it repeats
// and may fail fast under pressure.
export const CRITICAL_SESSION_LIFECYCLE_PATHS = new Set([
  "/api/agent-mcp/console/bootstrap-su/session-ended",
  "/api/agent-mcp/console/bootstrap-su/session-resumed",
  "/api/agent-mcp/console/bootstrap-su/session-resume-finalized",
  "/api/agent-mcp/console/bootstrap-su/session-resume-released",
  "/api/agent-mcp/console/bootstrap-su/session-respawned",
]);

/** Match a REST control-plane path without letting query strings or a harmless
 * trailing slash defeat the reserve classification. */
export function isReservedControlPlanePath(requestPath: unknown): boolean {
  if (typeof requestPath !== "string") return false;
  const path = requestPath.split("?")[0]?.replace(/\/+$/, "") || "/";
  return RESERVED_CONTROL_PLANE_PATHS.has(path);
}

export function isCriticalSessionLifecyclePath(requestPath: unknown): boolean {
  if (typeof requestPath !== "string") return false;
  const path = requestPath.split("?")[0]?.replace(/\/+$/, "") || "/";
  return CRITICAL_SESSION_LIFECYCLE_PATHS.has(path);
}

/**
 * Whether a complete JSON-RPC batch contains only continuation-boundary writes. A mixed batch
 * stays on the ordinary route so an unrelated call cannot inherit the critical socket.
 * `tools:invoke` is recognized because some clients reach deferred tools through that wrapper.
 */
interface CriticalContinuationIdentity {
  critical: boolean;
  /** Bounded, argument-free tool/path identities safe to expose in health + failure telemetry. */
  tools: string[];
  /**
   * Work-item identities whose mutations must remain ordered. `null` is the conservative
   * global key for continuation calls that cannot prove a narrower conflict domain.
   */
  conflictKeys: string[] | null;
}

interface CoordSendIdentity {
  coordSend: boolean;
  /** Bounded, argument-free tool identities safe to expose in health + failure telemetry. */
  tools: string[];
}

/** Return the canonical coord:send identity for one tools/call message, if it is pure send. */
function coordSendToolName(message: unknown): "coord:send" | null {
  if (!message || typeof message !== "object") return null;
  const call = message as {
    method?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  if (call.method !== "tools/call" || typeof call.params?.name !== "string")
    return null;
  const calledTool = normalizeMcpName(call.params.name);
  if (calledTool === COORD_SEND_TOOL_NAME) return "coord:send";
  if (calledTool !== TOOLS_INVOKE_NAME) return null;
  const invokeArgs = call.params.arguments;
  if (
    !invokeArgs ||
    typeof invokeArgs !== "object" ||
    Array.isArray(invokeArgs)
  )
    return null;
  const target = (invokeArgs as { name?: unknown }).name;
  return typeof target === "string" &&
    normalizeMcpName(target) === COORD_SEND_TOOL_NAME
    ? "coord:send"
    : null;
}

/**
 * Whether a complete JSON-RPC batch contains only direct or deferred `coord:send` calls.
 * A mixed batch deliberately returns false so it stays on the general critical lane.
 */
function classifyCoordSendCall(
  rawBody: Buffer,
  requestPath?: string,
): CoordSendIdentity {
  if (isCriticalSessionLifecyclePath(requestPath)) {
    return { coordSend: false, tools: [] };
  }
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const tools = messages.map(coordSendToolName);
    const coordSend =
      messages.length > 0 && tools.every((tool): tool is "coord:send" => tool !== null);
    return coordSend
      ? { coordSend: true, tools: ["coord:send"] }
      : { coordSend: false, tools: [] };
  } catch {
    return { coordSend: false, tools: [] };
  }
}

/** Whether this complete JSON-RPC batch can use the dedicated coord:send lane. */
export function isCoordSendContinuationCall(
  rawBody: Buffer,
  requestPath?: string,
): boolean {
  return classifyCoordSendCall(rawBody, requestPath).coordSend;
}

/** Argument-free identity for a pure coord:send request occupying/waiting on its lane. */
export function coordSendToolNames(
  rawBody: Buffer,
  requestPath?: string,
): string[] {
  return classifyCoordSendCall(rawBody, requestPath).tools;
}

interface ImprovementsCaptureIdentity {
  improvementsCapture: boolean;
  /** Bounded, argument-free tool identities safe to expose in health + failure telemetry. */
  tools: string[];
}

/**
 * Whether a complete JSON-RPC batch contains only direct or deferred
 * `improvements:capture` calls. A mixed batch deliberately remains on the shared
 * critical-continuation lane so one HTTP request cannot split its ordering semantics.
 */
function classifyImprovementsCaptureCall(
  rawBody: Buffer,
  requestPath?: string,
): ImprovementsCaptureIdentity {
  if (isCriticalSessionLifecyclePath(requestPath)) {
    return { improvementsCapture: false, tools: [] };
  }
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const isCapture = messages.every((message) => {
      if (!message || typeof message !== "object") return false;
      const call = message as {
        method?: unknown;
        params?: { name?: unknown; arguments?: unknown };
      };
      if (call.method !== "tools/call" || typeof call.params?.name !== "string")
        return false;
      const calledTool = normalizeMcpName(call.params.name);
      if (calledTool === IMPROVEMENTS_CAPTURE_TOOL_NAME) return true;
      if (calledTool !== TOOLS_INVOKE_NAME) return false;
      const invokeArgs = call.params.arguments;
      if (
        !invokeArgs ||
        typeof invokeArgs !== "object" ||
        Array.isArray(invokeArgs)
      )
        return false;
      const target = (invokeArgs as { name?: unknown }).name;
      return (
        typeof target === "string" &&
        normalizeMcpName(target) === IMPROVEMENTS_CAPTURE_TOOL_NAME
      );
    });
    return isCapture && messages.length > 0
      ? { improvementsCapture: true, tools: ["improvements:capture"] }
      : { improvementsCapture: false, tools: [] };
  } catch {
    return { improvementsCapture: false, tools: [] };
  }
}

export function isImprovementsCaptureContinuationCall(
  rawBody: Buffer,
  requestPath?: string,
): boolean {
  return classifyImprovementsCaptureCall(rawBody, requestPath).improvementsCapture;
}

/** Argument-free identity for the dedicated incident-capture lane. */
export function improvementsCaptureToolNames(
  rawBody: Buffer,
  requestPath?: string,
): string[] {
  return classifyImprovementsCaptureCall(rawBody, requestPath).tools;
}

const WORK_ITEM_SCOPED_CONTINUATION_TOOLS = new Set([
  normalizeMcpName("work_items:checkpoint"),
  normalizeMcpName("work_items:complete"),
]);

/**
 * Derive the narrow mutation domain carried by the two work-item continuation tools.
 * Anything malformed, unkeyed, or outside that pair stays globally conflicting; admission
 * must never guess an identity before the upstream tool has validated its own arguments.
 */
function criticalContinuationConflictKeysForTool(
  toolName: string,
  args: unknown,
): string[] | null {
  if (!WORK_ITEM_SCOPED_CONTINUATION_TOOLS.has(toolName)) return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const input = args as { id?: unknown; items?: unknown };
  const ids: string[] = [];
  if (typeof input.id === "string" && input.id.trim()) ids.push(input.id.trim());
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || !id.trim()) return null;
      ids.push(id.trim());
    }
  }
  return ids.length > 0 ? [...new Set(ids)].sort() : null;
}

function classifyCriticalContinuationCall(
  rawBody: Buffer,
  requestPath?: string,
): CriticalContinuationIdentity {
  if (isCriticalSessionLifecyclePath(requestPath)) {
    const path = requestPath?.split("?")[0]?.replace(/\/+$/, "") || "/";
    return { critical: true, tools: [`rest:${path}`], conflictKeys: null };
  }
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const tools: string[] = [];
    const conflictKeys = new Set<string>();
    let globallyConflicting = false;
    const recordCriticalTool = (toolName: string, args: unknown): void => {
      tools.push(
        CRITICAL_CONTINUATION_DISPLAY_NAMES.get(toolName) ?? toolName,
      );
      const keys = criticalContinuationConflictKeysForTool(toolName, args);
      if (keys === null) globallyConflicting = true;
      else for (const key of keys) conflictKeys.add(key);
    };
    const critical =
      messages.length > 0 &&
      messages.every((message) => {
        if (!message || typeof message !== "object") return false;
        const call = message as {
          method?: unknown;
          params?: { name?: unknown; arguments?: unknown };
        };
        if (
          call.method !== "tools/call" ||
          typeof call.params?.name !== "string"
        )
          return false;
        const calledTool = normalizeMcpName(call.params.name);
        if (CRITICAL_CONTINUATION_TOOLS.has(calledTool)) {
          if (
            isLoopCheckpointReadOnlyContinuationArgs(
              calledTool,
              call.params?.arguments,
            )
          )
            return false;
          recordCriticalTool(calledTool, call.params?.arguments);
          return true;
        }
        if (calledTool !== TOOLS_INVOKE_NAME) return false;
        const invokeArgs = call.params.arguments;
        if (
          !invokeArgs ||
          typeof invokeArgs !== "object" ||
          Array.isArray(invokeArgs)
        )
          return false;
        const target = (invokeArgs as { name?: unknown }).name;
        if (typeof target !== "string") return false;
        const normalizedTarget = normalizeMcpName(target);
        if (!CRITICAL_CONTINUATION_TOOLS.has(normalizedTarget)) return false;
        if (
          isLoopCheckpointReadOnlyContinuationArgs(
            normalizedTarget,
            (invokeArgs as { args?: unknown }).args,
          )
        )
          return false;
        recordCriticalTool(
          normalizedTarget,
          (invokeArgs as { args?: unknown }).args,
        );
        return true;
      });
    const coordSend = classifyCoordSendCall(rawBody, requestPath).coordSend;
    const improvementsCapture = classifyImprovementsCaptureCall(
      rawBody,
      requestPath,
    ).improvementsCapture;
    return critical && !coordSend && !improvementsCapture
      ? {
          critical: true,
          tools: [...new Set(tools)].slice(0, MAX_RECORDED_RPC_METHODS),
          conflictKeys: globallyConflicting
            ? null
            : [...conflictKeys].sort(),
        }
      : { critical: false, tools: [], conflictKeys: null };
  } catch {
    return { critical: false, tools: [], conflictKeys: null };
  }
}

export function isCriticalContinuationCall(
  rawBody: Buffer,
  requestPath?: string,
): boolean {
  return classifyCriticalContinuationCall(rawBody, requestPath).critical;
}

/** Argument-free identity for the critical request occupying/waiting on the durability slot. */
export function criticalContinuationToolNames(
  rawBody: Buffer,
  requestPath?: string,
): string[] {
  return classifyCriticalContinuationCall(rawBody, requestPath).tools;
}

/** Fleet bootstrap, direct coordination delivery, continuation checkpoints, scheduler claims,
 * deferred tool discovery, bounded diagnostics, loop arming, incident capture, file-lock inspection,
 * file-lock cancellation/release, and continuation checkpoint writes are liveness/control-plane traffic:
 * if they cannot run, workers cannot orient, wake a blocker, persist a safe wake boundary, drain
 * the queue generating proxy load, recover a missing tool surface, keep themselves alive, file
 * the failure that needs fixing, inspect lock ownership, release a lock held during an edit,
 * or preserve the successor state needed to resume after a task boundary, cancel an event wait,
 * acquire/release a file lock around an edit, inspect a
 * work-item during recovery, search the work-item queue during recovery, release a claim during recovery, diagnose a service outage, or finish a work-item when
 * ordinary traffic has saturated the proxy. The MCP
 * client may send a canonical colon-form name or its `mcp__<server>__group_verb` advertisement
 * name; both are normalized through the shared tooldef helper before this narrow membership check.
 * Keep the reserved set deliberately narrow. `requestPath` covers the small
 * plain-REST bootstrap surface that cannot identify itself in a JSON-RPC body. */
export function isReservedControlPlaneCall(
  rawBody: Buffer,
  requestPath?: string,
): boolean {
  if (isReservedControlPlanePath(requestPath)) return true;
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    // JSON-RPC permits a request body to contain a batch. Reserve the whole forward when
    // any member is a control-plane call: one HTTP request consumes one admission slot, and
    // hiding a scheduler/orientation call inside a batch must not make it compete with ordinary
    // traffic for the non-reserved ceiling.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((message) => {
      if (!message || typeof message !== "object") return false;
      const call = message as {
        method?: unknown;
        params?: { name?: unknown; arguments?: unknown };
      };
      if (typeof call.method !== "string") return false;
      if (RESERVED_CONTROL_PLANE_METHODS.has(call.method)) return true;
      if (call.method !== "tools/call" || typeof call.params?.name !== "string")
        return false;
      const calledTool = normalizeMcpName(call.params.name);
      if (isReservedControlPlaneTool(calledTool, call.params.arguments, requestPath)) return true;
      if (calledTool !== TOOLS_INVOKE_NAME) return false;
      const invokeArgs = call.params.arguments;
      if (
        !invokeArgs ||
        typeof invokeArgs !== "object" ||
        Array.isArray(invokeArgs)
      )
        return false;
      const target = (invokeArgs as { name?: unknown }).name;
      return (
        typeof target === "string" &&
        isReservedControlPlaneTool(
          normalizeMcpName(target),
          (invokeArgs as { args?: unknown }).args,
          requestPath,
        )
      );
    });
  } catch {
    return false;
  }
}

/** Build the proxy HTTP server (does NOT listen — caller invokes .listen, or use
 *  startMcpProxy). Exposed for tests (drive it against a stub upstream). */
export function createMcpProxy(opts: McpProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[mcp-proxy] ${s}`));
  let lastDataPlaneInstabilityAtMs = 0;
  const backoff = opts.retryBackoffMs ?? 500;
  // P-006 (mcp-reliability-hardening-2026-07-11): instance-tag every failure record with
  // pid + listenPort + the resolved target, so a forensic read of the shared ledger can
  // attribute a failure to a SPECIFIC proxy instance (multiple instances / a restart across
  // the same ledger were previously indistinguishable — every record looked identical).
  const record = (rec: Record<string, unknown>): void => {
    let target: string | undefined;
    try {
      const t = resolveTarget(opts);
      target = `${t.host}:${t.port}`;
    } catch {
      /* target unresolved (misconfig / operator.json missing) — omit rather than throw */
    }
    recordProxyFailure({
      pid: process.pid,
      listenPort: opts.listenPort,
      target,
      ...rec,
    });
  };

  // EI-19305299022434394 — admission control + visibility state for THIS proxy instance.
  // `inFlightStarts` maps a per-request sequence id to its start time so the heartbeat can
  // report how long the OLDEST outstanding forward has been held, not just a bare count.
  const maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  // An explicitly injected max is predominantly a test/embedding contract; preserve its old
  // all-purpose semantics unless that caller also explicitly asks for a reserve.
  const controlPlaneReserve = Math.max(
    0,
    opts.controlPlaneReserve ??
      (opts.maxInFlight === undefined ? DEFAULT_CONTROL_PLANE_RESERVE : 0),
  );
  const reservedControlPlaneGuaranteedFloor =
    maxInFlight > 1 && controlPlaneReserve > 0
      ? Math.min(Math.floor(controlPlaneReserve), maxInFlight - 1)
      : 0;
  const ordinaryInFlightCeiling =
    reservedControlPlaneGuaranteedFloor > 0
      ? maxInFlight - reservedControlPlaneGuaranteedFloor
      : maxInFlight;
  // EI-21553301566833091 — a strict 136/64 partition stranded every standard control read
  // while all 136 ordinary slots sat empty. Make the partition work-conserving without
  // returning to the old one-way reserve: each normal class may borrow only down to the
  // OTHER class's guaranteed floor, and the shared normal-partition cap remains maxInFlight.
  // Production therefore permits a 136-request burst in either class while preserving at
  // least 64 immediate slots for the other one.
  const ordinaryGuaranteedFloor = Math.min(
    ordinaryInFlightCeiling,
    reservedControlPlaneGuaranteedFloor,
  );
  const reservedControlPlaneCeiling =
    reservedControlPlaneGuaranteedFloor > 0
      ? Math.min(
          maxInFlight,
          Math.max(
            reservedControlPlaneGuaranteedFloor,
            maxInFlight - ordinaryGuaranteedFloor,
          ),
        )
      : maxInFlight;
  // P-004: reuse the already-budgeted control-plane reserve as the concurrency budget for
  // disjoint continuation mutations. This is not a new/static capacity escape hatch: the
  // existing reserve remains the upper bound, while unkeyed and overlapping writes still
  // serialize exactly as before.
  const criticalContinuationConcurrencyCeiling = Math.max(
    1,
    reservedControlPlaneGuaranteedFloor,
  );
  // Pure coord:send handoffs share the same reserved control-plane budget as other
  // conflict-disjoint continuation mutations. Keeping this derived from the existing
  // reserve avoids a second static capacity escape hatch while allowing independent
  // handoffs to make progress concurrently when the reserve has room.
  const coordSendConcurrencyCeiling = Math.max(
    1,
    reservedControlPlaneGuaranteedFloor,
  );
  const partitionedAdmission = reservedControlPlaneGuaranteedFloor > 0;
  const upstreamAgent = opts.upstreamAgent ?? UPSTREAM_AGENT;
  // Admission-only reservation is not end-to-end reservation: during the measured incident all
  // 64 ordinary sockets were occupied and even an admitted watchdog tools/list would have queued
  // behind them. A distinct pool gives the reserved slots real upstream capacity. Keep the pool
  // instance-local so its maxSockets follows an injected/env reserve; destroy only agents we own.
  const ownsControlPlaneAgent = opts.controlPlaneAgent === undefined;
  const controlPlaneAgent =
    opts.controlPlaneAgent ??
    new http.Agent({
      keepAlive: false,
      maxSockets: Math.max(1, reservedControlPlaneCeiling),
    });
  const ownsWatchdogAgent = opts.watchdogAgent === undefined;
  // Keep one independent upstream socket for the watchdog. Admission reservation alone is not
  // enough: ordinary reserved tools/call traffic can occupy every socket in controlPlaneAgent
  // while its requests wait on a slow upstream, leaving the watchdog queued behind the failure
  // it is meant to diagnose.
  const watchdogAgent =
    opts.watchdogAgent ??
    new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
  const ownsCriticalContinuationAgent =
    opts.criticalContinuationAgent === undefined;
  // The isolated pool admits only conflict-disjoint continuation mutations concurrently.
  // Same-item/unkeyed ordering is enforced before a request reaches this agent.
  const criticalContinuationAgent =
    opts.criticalContinuationAgent ??
    new http.Agent({
      keepAlive: false,
      maxSockets: criticalContinuationConcurrencyCeiling,
    });
  const ownsCoordSendAgent = opts.coordSendAgent === undefined;
  // Pure coord:send handoffs get their own bounded bulkhead. This keeps the recovery
  // message path live while a completion/checkpoint occupies criticalContinuationAgent,
  // while allowing disjoint sends to use the reserved control-plane budget concurrently.
  const coordSendAgent =
    opts.coordSendAgent ??
    new http.Agent({
      keepAlive: false,
      maxSockets: coordSendConcurrencyCeiling,
    });
  const ownsImprovementsCaptureAgent =
    opts.improvementsCaptureAgent === undefined;
  // EI-22728723476698098 — incident captures get one independent socket. A capture is safe to
  // retry after the proxy explicitly says it was not forwarded, but it must not sit behind a
  // long completion/checkpoint on the shared durability socket and lose the client's deadline.
  const improvementsCaptureAgent =
    opts.improvementsCaptureAgent ??
    new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
  const maxHandshakeInFlight =
    opts.maxHandshakeInFlight ?? DEFAULT_MAX_HANDSHAKES_IN_FLIGHT;
  const configuredHandshakeQueue =
    opts.maxHandshakeQueue ?? DEFAULT_MAX_HANDSHAKE_QUEUE;
  const maxHandshakeQueue = Number.isFinite(configuredHandshakeQueue)
    ? Math.max(0, Math.floor(configuredHandshakeQueue))
    : 0;
  // EI-21504897841052086 — queue dwell bound + per-waiter telemetry cadence.
  const maxHandshakeQueueWaitMs =
    opts.maxHandshakeQueueWaitMs ?? DEFAULT_HANDSHAKE_QUEUE_WAIT_MS;
  const queueWaitLogMs =
    opts.handshakeQueueWaitLogMs ?? DEFAULT_HANDSHAKE_QUEUE_WAIT_LOG_MS;
  const configuredCriticalContinuationQueue =
    opts.maxCriticalContinuationQueue ??
    (opts.maxInFlight === undefined
      ? DEFAULT_MAX_CRITICAL_CONTINUATION_QUEUE
      : maxInFlight);
  const maxCriticalContinuationQueue = Number.isFinite(
    configuredCriticalContinuationQueue,
  )
    ? Math.max(0, Math.floor(configuredCriticalContinuationQueue))
    : 0;
  const configuredCoordSendQueue =
    opts.maxCoordSendQueue ?? maxCriticalContinuationQueue;
  const maxCoordSendQueue = Number.isFinite(configuredCoordSendQueue)
    ? Math.max(0, Math.floor(configuredCoordSendQueue))
    : 0;
  const configuredImprovementsCaptureQueue =
    opts.maxImprovementsCaptureQueue ??
    (opts.maxInFlight === undefined
      ? DEFAULT_MAX_IMPROVEMENTS_CAPTURE_QUEUE
      : maxInFlight);
  const maxImprovementsCaptureQueue = Number.isFinite(
    configuredImprovementsCaptureQueue,
  )
    ? Math.max(0, Math.floor(configuredImprovementsCaptureQueue))
    : 0;
  const maxCriticalContinuationQueueWaitMs =
    opts.maxCriticalContinuationQueueWaitMs ??
    DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_MS;
  const configuredCoordSendQueueWaitMs =
    opts.coordSendQueueWaitMs ?? DEFAULT_COORD_SEND_QUEUE_WAIT_MS;
  const coordSendQueueWaitMs =
    Number.isFinite(configuredCoordSendQueueWaitMs) &&
    configuredCoordSendQueueWaitMs >= 0
      ? Math.floor(configuredCoordSendQueueWaitMs)
      : DEFAULT_COORD_SEND_QUEUE_WAIT_MS;
  const configuredImprovementsCaptureQueueWaitMs =
    opts.improvementsCaptureQueueWaitMs ??
    DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS;
  const improvementsCaptureQueueWaitMs =
    Number.isFinite(configuredImprovementsCaptureQueueWaitMs) &&
    configuredImprovementsCaptureQueueWaitMs >= 0
      ? Math.floor(configuredImprovementsCaptureQueueWaitMs)
      : DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS;
  const criticalContinuationQueueWaitLogMs =
    opts.criticalContinuationQueueWaitLogMs ??
    DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_LOG_MS;
  let handshakeInFlight = 0;
  // EI-21548622458694037 — admission must count the TWO normal traffic classes independently.
  // The old one-way "reserve" compared every ordinary request against TOTAL in-flight traffic,
  // while reserved requests compared only against the global hard ceiling. A sustained wave of
  // fleet:leader-brief / fleet:assignments calls could therefore occupy all 200 slots, shedding
  // both ordinary work and the recovery reads that were nominally "reserved". Production's
  // 64-slot reserve is now a real 136 ordinary + 64 reserved bulkhead.
  let ordinaryInFlight = 0;
  let reservedControlPlaneInFlight = 0;
  // These classes already own one-socket agents. Count them explicitly so their admission can
  // exceed the normal partition without becoming an unbounded escape hatch.
  let watchdogProbeInFlight = 0;
  let criticalContinuationInFlight = 0;
  let coordSendInFlight = 0;
  let improvementsCaptureInFlight = 0;
  const maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const initializeSlowMs = opts.initializeSlowMs ?? DEFAULT_INITIALIZE_SLOW_MS;
  const inFlightStarts = new Map<number, number>();
  const ordinaryInFlightStarts = new Map<number, number>();
  const reservedControlPlaneInFlightStarts = new Map<number, number>();
  const watchdogProbeInFlightStarts = new Map<number, number>();
  const criticalContinuationInFlightStarts = new Map<number, number>();
  const coordSendInFlightStarts = new Map<number, number>();
  const improvementsCaptureInFlightStarts = new Map<number, number>();
  interface ContinuationRequestDetails {
    startedAtMs: number;
    traceId: string;
    tools: string[];
    conflictKeys: string[] | null;
  }
  const criticalContinuationRequests = new Map<
    number,
    ContinuationRequestDetails
  >();
  const coordSendRequests = new Map<number, ContinuationRequestDetails>();
  const improvementsCaptureRequests = new Map<
    number,
    ContinuationRequestDetails
  >();
  const completedForwardAtMs: number[] = [];
  let nextInFlightId = 0;

  const oldestAgeMs = (
    starts: Map<number, number>,
    now = Date.now(),
  ): number | null => {
    let oldest: number | null = null;
    for (const startedAt of starts.values()) {
      if (oldest == null || startedAt < oldest) oldest = startedAt;
    }
    return oldest == null ? null : Math.max(0, now - oldest);
  };

  /**
   * EI-22090638969690024 — identity of the request currently HOLDING the single durability
   * socket. A dwell shed is head-of-line blocking far more often than queue congestion:
   * measured 2026-09-02T05:55Z, an `improvements:capture` was shed at its 20s dwell while
   * `queueLength` was 0 and ONE `loop:end` had held the socket for 30s (heartbeat
   * `oldestAgeMs: 30001`, `admissionClass: "critical-continuation"`). The shed named neither
   * the holder nor its age, so "0 waiting" read as "nothing was in the way" and a
   * working-as-designed backpressure signal was filed as a broken transport.
   */
  const criticalContinuationBlocker = (
    conflictKeys: string[] | null,
    now = Date.now(),
  ): {
    tools: string[];
    ageMs: number;
    traceId: string;
    conflictKeys: string[] | null;
  } | null => {
    let oldest: ContinuationRequestDetails | null = null;
    for (const details of criticalContinuationRequests.values()) {
      if (!criticalContinuationKeysConflict(details.conflictKeys, conflictKeys))
        continue;
      if (oldest == null || details.startedAtMs < oldest.startedAtMs) {
        oldest = details;
      }
    }
    return oldest == null
      ? null
      : {
          tools: oldest.tools,
          ageMs: Math.max(0, now - oldest.startedAtMs),
          traceId: oldest.traceId,
          conflictKeys: oldest.conflictKeys,
        };
  };

  const recordForwardCompletion = (completedAtMs: number): void => {
    completedForwardAtMs.push(completedAtMs);
    const cutoffMs = completedAtMs - SHED_DRAIN_RATE_WINDOW_MS;
    while (
      completedForwardAtMs.length > 0 &&
      completedForwardAtMs[0] < cutoffMs
    ) {
      completedForwardAtMs.shift();
    }
    while (completedForwardAtMs.length > MAX_SHED_DRAIN_SAMPLES) {
      completedForwardAtMs.shift();
    }
  };

  /** A request waiting for a class-cap slot. It is resolved only after the slot is reserved. */
  interface QueuedAdmission {
    resolve: (granted: boolean) => void;
    cancelled: boolean;
    granted: boolean;
    /** EI-21504897841052086 — when this waiter entered the FIFO (dwell accounting). */
    enqueuedAtMs: number;
    /** Set by the dwell watch before resolving false, so the continuation can answer 429. */
    expired: boolean;
    /** Per-waiter telemetry/expiry watch; cleared on grant, cancel, and after the await. */
    waitTimer?: NodeJS.Timeout;
  }
  interface QueuedCriticalContinuation extends QueuedAdmission {
    traceId: string;
    tools: string[];
    conflictKeys: string[] | null;
    maxWaitMs: number;
  }
  type QueuedHandshake = QueuedAdmission;
  const handshakeQueue: QueuedHandshake[] = [];
  const criticalContinuationQueue: QueuedCriticalContinuation[] = [];
  interface QueuedCoordSend extends QueuedAdmission {
    traceId: string;
    tools: string[];
    maxWaitMs: number;
  }
  const coordSendQueue: QueuedCoordSend[] = [];
  interface QueuedImprovementsCapture extends QueuedAdmission {
    traceId: string;
    tools: string[];
    maxWaitMs: number;
  }
  const improvementsCaptureQueue: QueuedImprovementsCapture[] = [];
  // Resolve one waiter at a time so the async continuation can increment the live counters
  // before another queued request is granted. This reservation also keeps the global hard cap
  // true while the grant continuation is between the queue and the forwarding loop.
  let handshakeGrantReservations = 0;
  let pumpHandshakeQueue: () => void = () => {};
  let criticalContinuationGrantReservations = 0;
  let pumpCriticalContinuationQueue: () => void = () => {};
  let coordSendGrantReservations = 0;
  let pumpCoordSendQueue: () => void = () => {};
  let improvementsCaptureGrantReservations = 0;
  let pumpImprovementsCaptureQueue: () => void = () => {};

  const handshakeQueueLength = (): number =>
    handshakeQueue.reduce(
      (count, waiter) => count + (waiter.cancelled || waiter.granted ? 0 : 1),
      0,
    );
  const criticalContinuationQueueLength = (): number =>
    criticalContinuationQueue.reduce(
      (count, waiter) => count + (waiter.cancelled || waiter.granted ? 0 : 1),
      0,
    );
  const coordSendQueueLength = (): number =>
    coordSendQueue.reduce(
      (count, waiter) => count + (waiter.cancelled || waiter.granted ? 0 : 1),
      0,
    );
  const improvementsCaptureQueueLength = (): number =>
    improvementsCaptureQueue.reduce(
      (count, waiter) => count + (waiter.cancelled || waiter.granted ? 0 : 1),
      0,
    );
  const hasQueuedCompaction = (): boolean =>
    criticalContinuationQueue.some(
      (waiter) =>
        !waiter.cancelled &&
        !waiter.granted &&
        waiter.tools.includes("session:request-compaction"),
    );
  // EI-21567991637671620 — a loop:checkpoint is itself the recovery record needed when the
  // current turn is about to disappear. Keep one loop checkpoint waiter in a bounded priority
  // slot independently of the compaction slot, so a full ordinary FIFO cannot make that record's
  // mutation outcome unknown. `work_items:checkpoint` has the same successor-state guarantee,
  // but needs its own slot: a fallback work-item checkpoint must still be admitted when a loop
  // checkpoint already occupies the other recovery lane (EI-21598413057126541).
  const loopCheckpointContinuationTools = new Set(["loop:checkpoint"]);
  const workItemCheckpointContinuationTools = new Set([
    "work_items:checkpoint",
  ]);
  const hasQueuedLoopCheckpoint = (): boolean =>
    criticalContinuationQueue.some(
      (waiter) =>
        !waiter.cancelled &&
        !waiter.granted &&
        waiter.tools.some((tool) =>
          loopCheckpointContinuationTools.has(tool),
        ),
    );
  const hasQueuedWorkItemCheckpoint = (): boolean =>
    criticalContinuationQueue.some(
      (waiter) =>
        !waiter.cancelled &&
        !waiter.granted &&
        waiter.tools.some((tool) =>
          workItemCheckpointContinuationTools.has(tool),
        ),
    );
  // EI-21567905826837255 — a terminal work-item completion is itself the mutation result
  // that tells the fleet whether the item was drained. Keep one completion waiter in a bounded
  // priority slot so a saturated continuation FIFO cannot turn a durable close into an unknown
  // outcome. This is separate from checkpoint/compaction recovery: all three may be needed at
  // the same boundary, and each priority class remains bounded to one queued waiter.
  const completionContinuationTools = new Set(["work_items:complete"]);
  const hasQueuedCompletion = (): boolean =>
    criticalContinuationQueue.some(
      (waiter) =>
        !waiter.cancelled &&
        !waiter.granted &&
        waiter.tools.some((tool) => completionContinuationTools.has(tool)),
    );
  // EI-21669304707115602 — pure coord:send batches use the dedicated lane below. Keep the
  // canonical name in CRITICAL_CONTINUATION_TOOLS so a mixed batch (coord:send plus another
  // continuation write) is still recognized as critical, but never give that mixed batch the
  // pure-send lane's dwell/priority semantics.
  // EI-21646782269636565 — improvements:capture is the required incident/bug record for a
  // failed tool call. Preserve one bounded priority waiter when the ordinary continuation FIFO
  // is full, so the capture of the saturation failure is not itself shed at the point where the
  // system most needs the evidence. Keep this slot separate from coordination handoffs: both
  // may be needed during one recovery turn.
  const improvementsCaptureContinuationTools = new Set(["improvements:capture"]);
  const hasQueuedImprovementsCapture = (): boolean =>
    criticalContinuationQueue.some(
      (waiter) =>
        !waiter.cancelled &&
        !waiter.granted &&
        waiter.tools.some((tool) =>
          improvementsCaptureContinuationTools.has(tool),
        ),
    );
  // EI-21567903270684307 — loop:end is the cleanup action that stops a worker's wake source
  // after a blocked or drained turn. Expiring it at a finite queue dwell boundary leaves the
  // loop running while its caller has already lost the outcome. EI-21582773337412658 extends
  // the same rule to session:request-compaction: compaction is the recovery boundary for the
  // context that is about to disappear, so shedding it at a configured dwell cap strands the
  // very session that needs the cut. EI-21598376721192513 applies it to work_items:complete:
  // terminal completion is the mutation outcome that tells the fleet whether the item drained,
  // so shedding it at the dwell cap makes the close ambiguous. The FIFO remains hard-bounded,
  // and a client disconnect still cancels the waiter, so these terminal/recovery actions must
  // wait for the single continuation slot rather than becoming an ambiguous 429. Other
  // continuation writes retain the configured finite dwell when an operator explicitly enables it.
  const nonExpiringCriticalContinuationTools = new Set([
    "loop:end",
    "session:request-compaction",
    // EI-22052756477768229 — this is the loop's only recovery record; a dwell 429
    // would leave the next wake's carry state ambiguous.
    "loop:checkpoint",
    // EI-22476972244692928 — the work-item checkpoint is the fallback carry record. A
    // finite dwell 429 makes the checkpoint outcome unknown while the successor needs it.
    "work_items:checkpoint",
    "work_items:complete",
  ]);
  const hasNonExpiringCriticalContinuation = (tools: string[]): boolean =>
    tools.some((tool) => nonExpiringCriticalContinuationTools.has(tool));

  const canGrantHandshake = (): boolean => {
    if (
      shouldShedForInFlight(
        handshakeInFlight + handshakeGrantReservations,
        maxHandshakeInFlight,
      )
    ) {
      return false;
    }
    if (partitionedAdmission) {
      const reservedWithGrant =
        reservedControlPlaneInFlight + handshakeGrantReservations;
      const normalWithGrant = ordinaryInFlight + reservedWithGrant;
      return (
        !shouldShedForInFlight(
          reservedWithGrant,
          reservedControlPlaneCeiling,
        ) && !shouldShedForInFlight(normalWithGrant, maxInFlight)
      );
    }
    return (
      maxInFlight <= 0 ||
      inFlightStarts.size + handshakeGrantReservations < maxInFlight
    );
  };

  const cancelQueuedHandshake = (waiter: QueuedHandshake): void => {
    if (waiter.cancelled || waiter.granted) return;
    waiter.cancelled = true;
    waiter.resolve(false);
    pumpHandshakeQueue();
  };

  /** EI-21504897841052086 — stop a waiter's dwell watch; idempotent. */
  const clearQueuedWaitTimer = (waiter: QueuedAdmission): void => {
    if (!waiter.waitTimer) return;
    clearTimeout(waiter.waitTimer);
    waiter.waitTimer = undefined;
  };

  pumpHandshakeQueue = (): void => {
    while (handshakeQueue.length > 0) {
      const waiter = handshakeQueue.shift();
      if (!waiter || waiter.cancelled) continue;
      if (!canGrantHandshake()) {
        handshakeQueue.unshift(waiter);
        return;
      }
      waiter.granted = true;
      handshakeGrantReservations++;
      waiter.resolve(true);
    }
  };

  const criticalContinuationKeysConflict = (
    left: string[] | null,
    right: string[] | null,
  ): boolean =>
    left === null ||
    right === null ||
    left.some((key) => right.includes(key));

  const canGrantCriticalContinuation = (
    conflictKeys: string[] | null,
  ): boolean => {
    // A reservation becomes an active map entry in the same event-loop continuation. Treat
    // that tiny hand-off as globally conflicting so a direct arrival cannot race the key stamp.
    if (criticalContinuationGrantReservations > 0) return false;
    if (
      shouldShedForInFlight(
        criticalContinuationInFlight,
        criticalContinuationConcurrencyCeiling,
      )
    )
      return false;
    return [...criticalContinuationRequests.values()].every(
      (active) =>
        !criticalContinuationKeysConflict(active.conflictKeys, conflictKeys),
    );
  };

  const hasQueuedCriticalContinuationConflict = (
    conflictKeys: string[] | null,
  ): boolean =>
    criticalContinuationQueue.some(
      (waiter) =>
        !waiter.cancelled &&
        !waiter.granted &&
        criticalContinuationKeysConflict(waiter.conflictKeys, conflictKeys),
    );

  const cancelQueuedCriticalContinuation = (
    waiter: QueuedCriticalContinuation,
  ): void => {
    if (waiter.cancelled || waiter.granted) return;
    waiter.cancelled = true;
    waiter.resolve(false);
    pumpCriticalContinuationQueue();
  };

  const canGrantCoordSend = (): boolean =>
    !shouldShedForInFlight(
      coordSendInFlight + coordSendGrantReservations,
      coordSendConcurrencyCeiling,
    );

  const cancelQueuedCoordSend = (waiter: QueuedCoordSend): void => {
    if (waiter.cancelled || waiter.granted) return;
    waiter.cancelled = true;
    waiter.resolve(false);
    pumpCoordSendQueue();
  };

  const canGrantImprovementsCapture = (): boolean =>
    !shouldShedForInFlight(
      improvementsCaptureInFlight + improvementsCaptureGrantReservations,
      1,
    );

  const cancelQueuedImprovementsCapture = (
    waiter: QueuedImprovementsCapture,
  ): void => {
    if (waiter.cancelled || waiter.granted) return;
    waiter.cancelled = true;
    waiter.resolve(false);
    pumpImprovementsCaptureQueue();
  };

  pumpCriticalContinuationQueue = (): void => {
    for (let index = 0; index < criticalContinuationQueue.length; index++) {
      const waiter = criticalContinuationQueue[index];
      if (!waiter || waiter.cancelled || waiter.granted) {
        criticalContinuationQueue.splice(index, 1);
        index--;
        continue;
      }
      if (!canGrantCriticalContinuation(waiter.conflictKeys)) continue;
      // A waiter may bypass only earlier DISJOINT mutations. This removes cross-item
      // head-of-line blocking without letting same-item (or unkeyed/global) writes reorder.
      const conflictsWithEarlierWaiter = criticalContinuationQueue
        .slice(0, index)
        .some(
          (earlier) =>
            !earlier.cancelled &&
            !earlier.granted &&
            criticalContinuationKeysConflict(
              earlier.conflictKeys,
              waiter.conflictKeys,
            ),
        );
      if (conflictsWithEarlierWaiter) continue;
      criticalContinuationQueue.splice(index, 1);
      waiter.granted = true;
      criticalContinuationGrantReservations++;
      waiter.resolve(true);
      // The continuation that received this reservation increments the live counter before the
      // event loop returns here, so one grant per pump is the simplest fail-closed guarantee.
      return;
    }
  };

  pumpCoordSendQueue = (): void => {
    while (coordSendQueue.length > 0) {
      const waiter = coordSendQueue.shift();
      if (!waiter || waiter.cancelled) continue;
      if (!canGrantCoordSend()) {
        coordSendQueue.unshift(waiter);
        return;
      }
      waiter.granted = true;
      coordSendGrantReservations++;
      waiter.resolve(true);
      // The continuation that received this reservation increments the live counter before the
      // event loop returns here, so one grant per pump is the simplest fail-closed guarantee.
      return;
    }
  };

  pumpImprovementsCaptureQueue = (): void => {
    while (improvementsCaptureQueue.length > 0) {
      const waiter = improvementsCaptureQueue.shift();
      if (!waiter || waiter.cancelled) continue;
      if (!canGrantImprovementsCapture()) {
        improvementsCaptureQueue.unshift(waiter);
        return;
      }
      waiter.granted = true;
      improvementsCaptureGrantReservations++;
      waiter.resolve(true);
      // The continuation that received this reservation increments the live counter before the
      // event loop returns here, so one grant per pump is the fail-closed hand-off.
      return;
    }
  };

  // Half 2 of EI-19305299022434394: the proxy previously logged ONLY on completion/error, so a
  // stalled upstream that never completes anything produced total silence (106 minutes with zero
  // log lines during the measured outage) — indistinguishable from an idle proxy.
  //
  // EI-19388661789704364: the ORIGINAL shape here was a single global `setInterval` that sampled
  // `inFlightStarts.size` on a fixed 30s cadence and only logged/recorded when that ONE instant
  // landed on a nonzero count. Measured live: zero `heartbeat` records across a 27MB / 30h+ ledger,
  // despite `shed_max_in_flight` proving the proxy DID hit its concurrency ceiling repeatedly — the
  // real traffic here is bursts of requests that each complete in milliseconds, so a 30s-aligned
  // sample essentially never coincides with one being outstanding. The exact case the heartbeat was
  // built for (one genuinely long-held/stalled forward) was therefore left to chance alignment
  // instead of being detected deterministically.
  //
  // Fixed by moving from a SAMPLED aggregate tick to a per-request THRESHOLD timer: the instant a
  // forward starts, schedule a check `heartbeatIntervalMs` out; if that SPECIFIC request is still
  // outstanding when the timer fires, it is — by construction — a real long hold (not a fast burst
  // that happened to be in flight at a sample instant), so it beats, then reschedules itself for as
  // long as the request remains open. This fires deterministically for any forward held at least
  // `heartbeatIntervalMs`, with no dependency on how many other requests are in flight or when.
  const heartbeatIntervalMs =
    opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (heartbeatIntervalMs > 0) {
    // Deliberately does NOT contain the word "heartbeat" — that word marks a real per-request
    // beat event (tests and any production log-grep for `heartbeat` key off it), and this is a
    // one-time startup line, not a beat. EI-19388661789704364 asked for exactly this: a resolved
    // value logged at start so "is it armed at all" is never itself a guess.
    log(`in-flight stall watch armed: checkAfterMs=${heartbeatIntervalMs}`);
  }
  const stallTimers = new Map<number, NodeJS.Timeout>();
  function scheduleStallCheck(inFlightId: number, startedAt: number): void {
    if (heartbeatIntervalMs <= 0) return;
    const timer = setTimeout(() => {
      // The request may have completed (and cleared its slot) in the gap before this fired —
      // that is the common case and not a stall, so say nothing.
      if (!inFlightStarts.has(inFlightId)) return;
      const oldestAgeMs = Date.now() - startedAt;
      const count = inFlightStarts.size;
      const criticalDetails = criticalContinuationRequests.get(inFlightId);
      const coordSendDetails = coordSendRequests.get(inFlightId);
      const improvementsCaptureDetails =
        improvementsCaptureRequests.get(inFlightId);
      log(
        `heartbeat: request #${inFlightId} held ${Math.round(oldestAgeMs / 1000)}s, ${count} in flight total`,
      );
      record({
        kind: "heartbeat",
        inFlight: count,
        oldestAgeMs,
        maxInFlight,
        inFlightId,
        ...(criticalDetails || coordSendDetails || improvementsCaptureDetails
          ? {
              admissionClass: improvementsCaptureDetails
                ? "improvements-capture"
                : coordSendDetails
                  ? "coord-send"
                  : "critical-continuation",
              traceId: (
                improvementsCaptureDetails ??
                coordSendDetails ??
                criticalDetails
              )!.traceId,
              tools: (
                improvementsCaptureDetails ??
                coordSendDetails ??
                criticalDetails
              )!.tools,
            }
          : {}),
      });
      scheduleStallCheck(inFlightId, startedAt); // still outstanding — keep beating until it isn't
    }, heartbeatIntervalMs);
    timer.unref?.();
    stallTimers.set(inFlightId, timer);
  }

  // WI-41257 — inbound observability. The proxy already recorded failures it observed while
  // forwarding to :3070, but it had no signal for failures on its own client-facing socket. Node
  // exposes parser/socket failures through `clientError` and admission drops through `drop`; keep
  // those events separate from upstream failures so an operator can tell "the proxy could not
  // accept me" from ":3070 was unavailable". These counters are deliberately instance-local and
  // are also exposed by the proxy-local health route as a bounded snapshot.
  const inbound = {
    accepted: 0,
    active: 0,
    clientErrors: 0,
    socketResets: 0,
    drops: 0,
  };
  const resetSockets = new WeakSet<object>();
  const inboundSnapshot = (): typeof inbound => ({ ...inbound });
  const isSocketResetError = (error: Error): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return (
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      /(?:socket|connection).*(?:reset|hang up)/i.test(error.message)
    );
  };
  const socketDetails = (socket: object): Record<string, unknown> => {
    const peer = socket as {
      remoteAddress?: string;
      remotePort?: number;
      remoteFamily?: string;
    };
    return {
      remoteAddress: peer.remoteAddress,
      remotePort: peer.remotePort,
      remoteFamily: peer.remoteFamily,
    };
  };
  const recordInboundSocketReset = (
    socket: object | undefined,
    source: string,
  ): void => {
    if (socket && resetSockets.has(socket)) return;
    if (socket) resetSockets.add(socket);
    inbound.socketResets++;
    log(`inbound socket reset (${source})`);
    record({
      kind: "inbound_socket_reset",
      event: source,
      socketResets: inbound.socketResets,
      ...(socket ? socketDetails(socket) : {}),
    });
  };
  const recordInboundClientError = (error: Error, socket: object): void => {
    inbound.clientErrors++;
    const socketReset = isSocketResetError(error);
    if (socketReset) {
      recordInboundSocketReset(socket, "clientError");
    }
    const errorCode = (error as NodeJS.ErrnoException).code;
    const message = error.message || String(error);
    log(
      `inbound client error${socketReset ? " / socket reset" : ""}: ${message}`,
    );
    record({
      kind: "inbound_client_error",
      event: "clientError",
      errorCode,
      detail: message,
      socketReset,
      clientErrors: inbound.clientErrors,
      ...socketDetails(socket),
    });
  };

  const loopbackPeerGate =
    opts.loopbackPeerGate ?? ((socket: import("node:net").Socket) => foreignLoopbackPeerForSocket(socket));
  const server = http.createServer((req, res) => {
    const receivedAt = Date.now();
    // The degraded marker describes MCP data-plane health only. REST endpoints
    // share this listener, but their failures must not affect /api/mcp callers.
    const isMcpApiRequest = req.url?.split("?")[0] === "/api/mcp";
    // WI-10005688: refuse a loopback caller of another uid before anything runs or is
    // forwarded (the proxy injects the superuser bearer, so forwarding would act as us).
    const foreignPeer = loopbackPeerGate(req.socket);
    if (foreignPeer) {
      log(`refused loopback peer uid=${foreignPeer.uid ?? "unknown"} (${foreignPeer.reason})`);
      record({ kind: "foreign_loopback_peer_refused", uid: foreignPeer.uid, reason: foreignPeer.reason });
      res.writeHead(403, { "content-type": "application/json", connection: "close" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message:
              "mcp-proxy: loopback callers other than the operator service account are refused on this host",
          },
          reason: foreignPeer.reason,
          mcpProxy: true,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === MCP_PROXY_LOCAL_HEALTH_PATH) {
      let target: McpProxyTarget | null = null;
      try {
        target = resolveTarget(opts);
      } catch {
        target = null;
      }
      const healthNow = Date.now();
      const activeCriticalContinuationRequests = [
        ...criticalContinuationRequests.entries(),
      ]
        .slice(0, MAX_CRITICAL_CONTINUATION_HEALTH_REQUESTS)
        .map(([inFlightId, details]) => ({
          inFlightId,
          traceId: details.traceId,
          tools: details.tools,
          conflictKeys: details.conflictKeys,
          ageMs: Math.max(0, healthNow - details.startedAtMs),
        }));
      const waitingCriticalContinuationRequests = criticalContinuationQueue
        .filter((waiter) => !waiter.cancelled && !waiter.granted)
        .slice(0, MAX_CRITICAL_CONTINUATION_HEALTH_REQUESTS)
        .map((waiter) => ({
          traceId: waiter.traceId,
          tools: waiter.tools,
          conflictKeys: waiter.conflictKeys,
          ageMs: Math.max(0, healthNow - waiter.enqueuedAtMs),
          maxWaitMs: waiter.maxWaitMs,
        }));
      const activeCoordSendRequests = [...coordSendRequests.entries()]
        .slice(0, MAX_CRITICAL_CONTINUATION_HEALTH_REQUESTS)
        .map(([inFlightId, details]) => ({
          inFlightId,
          traceId: details.traceId,
          tools: details.tools,
          ageMs: Math.max(0, healthNow - details.startedAtMs),
        }));
      const waitingCoordSendRequests = coordSendQueue
        .filter((waiter) => !waiter.cancelled && !waiter.granted)
        .slice(0, MAX_CRITICAL_CONTINUATION_HEALTH_REQUESTS)
        .map((waiter) => ({
          traceId: waiter.traceId,
          tools: waiter.tools,
          ageMs: Math.max(0, healthNow - waiter.enqueuedAtMs),
          maxWaitMs: waiter.maxWaitMs,
        }));
      const activeImprovementsCaptureRequests = [
        ...improvementsCaptureRequests.entries(),
      ]
        .slice(0, MAX_CRITICAL_CONTINUATION_HEALTH_REQUESTS)
        .map(([inFlightId, details]) => ({
          inFlightId,
          traceId: details.traceId,
          tools: details.tools,
          ageMs: Math.max(0, healthNow - details.startedAtMs),
        }));
      const waitingImprovementsCaptureRequests = improvementsCaptureQueue
        .filter((waiter) => !waiter.cancelled && !waiter.granted)
        .slice(0, MAX_CRITICAL_CONTINUATION_HEALTH_REQUESTS)
        .map((waiter) => ({
          traceId: waiter.traceId,
          tools: waiter.tools,
          ageMs: Math.max(0, healthNow - waiter.enqueuedAtMs),
          maxWaitMs: waiter.maxWaitMs,
        }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          target,
          inbound: inboundSnapshot(),
          inFlight: {
            total: inFlightStarts.size,
            ordinary: ordinaryInFlight,
            reservedControlPlane: reservedControlPlaneInFlight,
            watchdog: watchdogProbeInFlight,
            criticalContinuation: criticalContinuationInFlight,
            criticalContinuationMax: criticalContinuationConcurrencyCeiling,
            criticalContinuationRequests: activeCriticalContinuationRequests,
            criticalContinuationQueue: {
              waiting: criticalContinuationQueueLength(),
              max: maxCriticalContinuationQueue,
              maxWaitMs: maxCriticalContinuationQueueWaitMs,
              coordSendMaxWaitMs: coordSendQueueWaitMs,
              improvementsCaptureMaxWaitMs: improvementsCaptureQueueWaitMs,
              oldestAgeMs:
                waitingCriticalContinuationRequests.length > 0
                  ? Math.max(
                      ...waitingCriticalContinuationRequests.map(
                        (request) => request.ageMs,
                      ),
                    )
                  : null,
              requests: waitingCriticalContinuationRequests,
            },
            improvementsCapture: improvementsCaptureInFlight,
            improvementsCaptureMax: 1,
            improvementsCaptureRequests: activeImprovementsCaptureRequests,
            improvementsCaptureQueue: {
              waiting: improvementsCaptureQueueLength(),
              max: maxImprovementsCaptureQueue,
              maxWaitMs: improvementsCaptureQueueWaitMs,
              oldestAgeMs:
                waitingImprovementsCaptureRequests.length > 0
                  ? Math.max(
                      ...waitingImprovementsCaptureRequests.map(
                        (request) => request.ageMs,
                      ),
                    )
                  : null,
              requests: waitingImprovementsCaptureRequests,
            },
            coordSend: coordSendInFlight,
            coordSendMax: coordSendConcurrencyCeiling,
            coordSendRequests: activeCoordSendRequests,
            coordSendQueue: {
              waiting: coordSendQueueLength(),
              max: maxCoordSendQueue,
              maxWaitMs: coordSendQueueWaitMs,
              oldestAgeMs:
                waitingCoordSendRequests.length > 0
                  ? Math.max(
                      ...waitingCoordSendRequests.map(
                        (request) => request.ageMs,
                      ),
                    )
                  : null,
              requests: waitingCoordSendRequests,
            },
            maxInFlight,
            ordinaryCeiling: ordinaryInFlightCeiling,
            ordinaryGuaranteedFloor,
            reservedControlPlaneGuaranteedFloor,
            reservedControlPlaneCeiling,
            oldestAgeMs: {
              ordinary: oldestAgeMs(ordinaryInFlightStarts, healthNow),
              reservedControlPlane: oldestAgeMs(
                reservedControlPlaneInFlightStarts,
                healthNow,
              ),
              watchdog: oldestAgeMs(watchdogProbeInFlightStarts, healthNow),
              criticalContinuation: oldestAgeMs(
                criticalContinuationInFlightStarts,
                healthNow,
              ),
              coordSend: oldestAgeMs(coordSendInFlightStarts, healthNow),
              improvementsCapture: oldestAgeMs(
                improvementsCaptureInFlightStarts,
                healthNow,
              ),
            },
          },
        }),
      );
      return;
    }
    // WI-35737 — CLIENT-DISCONNECT TRACKING. Before this, the proxy had no client-side
    // liveness signal at all (the only `req` listeners were the three below, all about
    // accumulating the request BODY), so a client that gave up — its own timeout fired, its
    // agent session died, the watchdog restarted it — bought nothing: the retry loop kept
    // replaying against upstream for a response with nowhere to go.
    //
    // ⚠ This is NOT a slot leak, and an earlier diagnosis on WI-35737 that said so was wrong
    // (withdrawn in comment 56302). The in-flight slot is released at RESPONSE-HEADER time —
    // the `return` after `ures.pipe(res)` below sits INSIDE the `try`, so the `finally` runs
    // while the SSE body is still streaming. Measured: across 2,305 heartbeat records the
    // max hold was 120,004ms against a 600,000ms `maxHoldMs`, i.e. the cap was never
    // approached. What this DOES cut is AMPLIFICATION: work spent on a dead client during
    // exactly the upstream-stall windows when capacity is scarcest.
    let clientGone = false;
    let abortAttempt: (() => void) | null = null;
    let cancelQueuedAdmission: (() => void) | null = null;
    const noteClientGone = (
      source: "response_close" | "request_aborted",
    ): void => {
      // 'close' also fires on NORMAL completion — `writableFinished` is what separates "the
      // response was fully sent" from "the peer vanished mid-flight". Without this guard
      // every successful request would mark itself aborted.
      if (clientGone || res.writableFinished) return;
      clientGone = true;
      recordInboundSocketReset(req.socket, source);
      cancelQueuedAdmission?.();
      abortAttempt?.();
    };
    res.on("close", () => noteClientGone("response_close"));
    req.on("aborted", () => noteClientGone("request_aborted"));
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", (error) => {
      if (isSocketResetError(error)) {
        recordInboundSocketReset(req.socket, "request_error");
      } else {
        inbound.clientErrors++;
        log(
          `inbound client error (request): ${error.message || String(error)}`,
        );
        record({
          kind: "inbound_client_error",
          event: "request_error",
          detail: error.message || String(error),
          clientErrors: inbound.clientErrors,
          ...socketDetails(req.socket),
        });
      }
      try {
        res.writeHead(400);
        res.end();
      } catch {
        /* client already gone */
      }
    });
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks);
        const bodyReadyAt = Date.now();
        // EI-19305299022434394 — admission control, checked BEFORE any upstream socket is
        // opened (and before we even bother classifying the forward). A request that arrives
        // while `maxInFlight` forwards are already outstanding is shed immediately with 429 +
        // Retry-After instead of being allowed to pile onto an already-struggling upstream —
        // this is what stops the congestion-collapse feedback loop the unbounded agent used to
        // create (3,450 simultaneous held requests, measured 2026-08-01).
        const inFlightNow = inFlightStarts.size;
        const requestTraceId = randomUUID();
        const reservedControlPlane = isReservedControlPlaneCall(
          rawBody,
          req.url,
        );
      const criticalContinuationIdentity = classifyCriticalContinuationCall(
          rawBody,
          req.url,
        );
      const coordSendIdentity = classifyCoordSendCall(rawBody, req.url);
        const improvementsCaptureIdentity = classifyImprovementsCaptureCall(
          rawBody,
          req.url,
        );
        const coordSend = coordSendIdentity.coordSend;
        const coordSendTools = coordSendIdentity.tools;
        const improvementsCapture =
          improvementsCaptureIdentity.improvementsCapture;
        const improvementsCaptureTools = improvementsCaptureIdentity.tools;
        const criticalContinuation = criticalContinuationIdentity.critical;
        const criticalContinuationTools = criticalContinuationIdentity.tools;
        const criticalContinuationConflictKeys =
          criticalContinuationIdentity.conflictKeys;
        const sessionHandshake = isMcpSessionHandshakeCall(rawBody);
        const watchdogSessionProbe =
          sessionHandshake && isMcpProxyWatchdogProbePath(req.url);
        const standardReservedControlPlane =
          reservedControlPlane &&
          !criticalContinuation &&
          !coordSend &&
          !improvementsCapture &&
          !watchdogSessionProbe;
        const admissionClass = improvementsCapture
          ? "improvements-capture"
          : coordSend
          ? "coord-send"
          : criticalContinuation
            ? "critical-continuation"
          : watchdogSessionProbe
            ? "watchdog"
            : standardReservedControlPlane
              ? "reserved-control-plane"
              : "ordinary";
        const admissionCeiling =
          improvementsCapture
            ? 1
            : coordSend
            ? coordSendConcurrencyCeiling
            : watchdogSessionProbe
              ? 1
              : criticalContinuation
                ? criticalContinuationConcurrencyCeiling
                : partitionedAdmission
                  ? standardReservedControlPlane
                    ? reservedControlPlaneCeiling
                    : ordinaryInFlightCeiling
                  : maxInFlight;
        const classInFlight = coordSend
          ? coordSendInFlight
          : improvementsCapture
            ? improvementsCaptureInFlight
          : criticalContinuation
            ? criticalContinuationInFlight
            : watchdogSessionProbe
              ? watchdogProbeInFlight
              : standardReservedControlPlane
                ? reservedControlPlaneInFlight
                : ordinaryInFlight;
        const normalInFlight = ordinaryInFlight + reservedControlPlaneInFlight;
        const normalPartitionSaturated =
          !criticalContinuation &&
          !coordSend &&
          !improvementsCapture &&
          !watchdogSessionProbe &&
          shouldShedForInFlight(normalInFlight, maxInFlight);
        // Ordinary handshakes use the bounded FIFO below, which accounts for both their own
        // handshake cap and the reserved-class cap. Shedding them here would bypass that queue.
        const admissionSaturated =
          criticalContinuation || coordSend || improvementsCapture
          ? false
          : sessionHandshake && !watchdogSessionProbe
            ? false
            : shouldShedForInFlight(classInFlight, admissionCeiling) ||
              normalPartitionSaturated;
        if (admissionSaturated) {
          const retryAfterSec = retryAfterSecForDrainRate(
            classInFlight,
            admissionCeiling,
            completedForwardAtMs,
            Date.now(),
          );
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": String(retryAfterSec),
          });
          res.end(
            JSON.stringify({
              ok: false,
              error: "mcp_proxy_overloaded",
              retryable: true,
              forwardingResult: "not_forwarded" satisfies McpProxyForwardingResult,
              detail: `proxy ${admissionClass} class already has ${classInFlight} request(s) in flight (class max ${admissionCeiling}, total ${inFlightNow}, normal hard max ${maxInFlight}) — shed before forwarding`,
              retryAfterSec,
            }),
          );
          log(
            `shed request — ${admissionClass} ${classInFlight}/${admissionCeiling}, ${inFlightNow} total`,
          );
          record({
            kind: "shed_max_in_flight",
            method: req.method,
            path: req.url,
            inFlight: inFlightNow,
            classInFlight,
            maxInFlight,
            admissionClass,
            admissionCeiling,
            ordinaryInFlight,
            reservedControlPlaneInFlight,
            reservedControlPlane,
            retryAfterSec,
            forwardingResult: "not_forwarded",
          });
          return;
        }
        // EI-22728723476698098 — pure improvements:capture incident records get a dedicated
        // one-socket lane. A long checkpoint/completion on criticalContinuationAgent must not
        // consume the capture's entire client deadline; mixed batches remain on the shared lane.
        if (improvementsCapture && !canGrantImprovementsCapture()) {
          pumpImprovementsCaptureQueue();
          if (
            maxImprovementsCaptureQueue <= improvementsCaptureQueueLength()
          ) {
            const retryAfterSec = retryAfterSecForDrainRate(
              improvementsCaptureInFlight,
              1,
              completedForwardAtMs,
              Date.now(),
            );
            res.writeHead(429, {
              "content-type": "application/json",
              "retry-after": String(retryAfterSec),
            });
            res.end(
              JSON.stringify({
                ok: false,
                error: "mcp_proxy_improvements_capture_queue_full",
                retryable: true,
                forwardingResult: "not_forwarded" satisfies McpProxyForwardingResult,
                detail: `proxy improvements:capture FIFO already has ${improvementsCaptureQueueLength()} waiter(s) (queue max ${maxImprovementsCaptureQueue})`,
                retryAfterSec,
                traceId: requestTraceId,
              }),
            );
            log(
              `shed improvements:capture request ${requestTraceId} — ` +
                `${improvementsCaptureQueueLength()}/${maxImprovementsCaptureQueue} waiters`,
            );
            record({
              kind: "shed_improvements_capture_queue_full",
              method: req.method,
              path: req.url,
              traceId: requestTraceId,
              tools: improvementsCaptureTools,
              improvementsCaptureInFlight,
              queueLength: improvementsCaptureQueueLength(),
              maxImprovementsCaptureQueue,
              retryAfterSec,
              forwardingResult: "not_forwarded",
            });
            return;
          }

          let queuedImprovementsCapture!: QueuedImprovementsCapture;
          const enqueuedAtMs = Date.now();
          const granted = await new Promise<boolean>((resolve) => {
            queuedImprovementsCapture = {
              resolve,
              cancelled: false,
              granted: false,
              enqueuedAtMs,
              expired: false,
              traceId: requestTraceId,
              tools: improvementsCaptureTools,
              maxWaitMs: improvementsCaptureQueueWaitMs,
            };
            improvementsCaptureQueue.push(queuedImprovementsCapture);
            cancelQueuedAdmission = (): void => {
              clearQueuedWaitTimer(queuedImprovementsCapture);
              cancelQueuedImprovementsCapture(queuedImprovementsCapture);
            };

            const armImprovementsCaptureWaitWatch = (): void => {
              if (
                queuedImprovementsCapture.maxWaitMs === 0 &&
                criticalContinuationQueueWaitLogMs === 0
              ) {
                return;
              }
              const waitedMs =
                Date.now() - queuedImprovementsCapture.enqueuedAtMs;
              const remainingMs =
                queuedImprovementsCapture.maxWaitMs > 0
                  ? Math.max(
                      1,
                      queuedImprovementsCapture.maxWaitMs - waitedMs,
                    )
                  : Number.POSITIVE_INFINITY;
              const nextLogMs =
                criticalContinuationQueueWaitLogMs > 0
                  ? criticalContinuationQueueWaitLogMs
                  : Number.POSITIVE_INFINITY;
              const nextDelayMs = Math.min(remainingMs, nextLogMs);
              if (!Number.isFinite(nextDelayMs)) return;
              queuedImprovementsCapture.waitTimer = setTimeout(() => {
                if (
                  queuedImprovementsCapture.granted ||
                  queuedImprovementsCapture.cancelled
                )
                  return;
                const waitedSoFarMs =
                  Date.now() - queuedImprovementsCapture.enqueuedAtMs;
                if (
                  queuedImprovementsCapture.maxWaitMs > 0 &&
                  waitedSoFarMs >= queuedImprovementsCapture.maxWaitMs
                ) {
                  queuedImprovementsCapture.expired = true;
                  clearQueuedWaitTimer(queuedImprovementsCapture);
                  cancelQueuedImprovementsCapture(queuedImprovementsCapture);
                  return;
                }
                log(
                  `improvements:capture request ${requestTraceId} still queued ` +
                    `${Math.round(waitedSoFarMs / 1000)}s — ` +
                    `${improvementsCaptureInFlight} in flight, ${improvementsCaptureQueueLength()} waiting`,
                );
                record({
                  kind: "improvements_capture_queue_wait",
                  method: req.method,
                  path: req.url,
                  traceId: requestTraceId,
                  tools: improvementsCaptureTools,
                  waitedMs: waitedSoFarMs,
                  improvementsCaptureInFlight,
                  queueLength: improvementsCaptureQueueLength(),
                  maxImprovementsCaptureQueue,
                  maxImprovementsCaptureQueueWaitMs:
                    queuedImprovementsCapture.maxWaitMs,
                });
                armImprovementsCaptureWaitWatch();
              }, nextDelayMs);
              queuedImprovementsCapture.waitTimer.unref?.();
            };
            armImprovementsCaptureWaitWatch();
            log(
              `queued improvements:capture request ${requestTraceId} — ` +
                `${improvementsCaptureInFlight} in flight, ${improvementsCaptureQueueLength()} waiting`,
            );
            record({
              kind: "queue_improvements_capture",
              method: req.method,
              path: req.url,
              traceId: requestTraceId,
              tools: improvementsCaptureTools,
              improvementsCaptureInFlight,
              queueLength: improvementsCaptureQueueLength(),
              maxImprovementsCaptureQueue,
              maxImprovementsCaptureQueueWaitMs:
                improvementsCaptureQueueWaitMs,
              forwardingResult: "queued",
            });
          });
          clearQueuedWaitTimer(queuedImprovementsCapture);
          cancelQueuedAdmission = null;
          if (!granted || clientGone) {
            if (granted) {
              improvementsCaptureGrantReservations = Math.max(
                0,
                improvementsCaptureGrantReservations - 1,
              );
              pumpImprovementsCaptureQueue();
            } else if (queuedImprovementsCapture.expired && !clientGone) {
              const waitedMs =
                Date.now() - queuedImprovementsCapture.enqueuedAtMs;
              res.writeHead(429, {
                "content-type": "application/json",
                "retry-after": "2",
              });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "mcp_proxy_improvements_capture_queue_dwell",
                  retryable: true,
                  forwardingResult: "not_forwarded" satisfies McpProxyForwardingResult,
                  detail: `improvements:capture waited ${waitedMs}ms in the dedicated FIFO (max ${queuedImprovementsCapture.maxWaitMs}ms) — shed; retry`,
                  retryAfterSec: 2,
                  traceId: requestTraceId,
                }),
              );
              record({
                kind: "shed_improvements_capture_queue_dwell",
                method: req.method,
                path: req.url,
                traceId: requestTraceId,
                tools: improvementsCaptureTools,
                waitedMs,
                improvementsCaptureInFlight,
                queueLength: improvementsCaptureQueueLength(),
                maxImprovementsCaptureQueueWaitMs:
                  queuedImprovementsCapture.maxWaitMs,
                forwardingResult: "not_forwarded",
              });
            }
            return;
          }
          improvementsCaptureGrantReservations = Math.max(
            0,
            improvementsCaptureGrantReservations - 1,
          );
        }
        // EI-21669304707115602 — pure coord:send handoffs have a dedicated continuation
        // lane. They must not wait behind a long completion/checkpoint on the shared critical
        // socket, while still keeping a bounded FIFO and an honest pre-forward dwell response
        // inside ptool's client deadline. The lane's concurrency is derived from the reserved
        // control-plane budget, matching criticalContinuationAgent.
        if (coordSend && !canGrantCoordSend()) {
          pumpCoordSendQueue();
          if (maxCoordSendQueue <= coordSendQueueLength()) {
            const retryAfterSec = retryAfterSecForDrainRate(
              coordSendInFlight,
              1,
              completedForwardAtMs,
              Date.now(),
            );
            res.writeHead(429, {
              "content-type": "application/json",
              "retry-after": String(retryAfterSec),
            });
            res.end(
              JSON.stringify({
                ok: false,
                error: "mcp_proxy_coord_send_queue_full",
                retryable: true,
                forwardingResult: "not_forwarded" satisfies McpProxyForwardingResult,
                detail: `proxy coord-send FIFO already has ${coordSendQueueLength()} waiter(s) (queue max ${maxCoordSendQueue})`,
                retryAfterSec,
                traceId: requestTraceId,
              }),
            );
            log(
              `shed coord-send request ${requestTraceId} — ` +
                `${coordSendQueueLength()}/${maxCoordSendQueue} waiters`,
            );
            record({
              kind: "shed_coord_send_queue_full",
              method: req.method,
              path: req.url,
              traceId: requestTraceId,
              tools: coordSendTools,
              coordSendInFlight,
              queueLength: coordSendQueueLength(),
              maxCoordSendQueue,
              retryAfterSec,
              forwardingResult: "not_forwarded",
            });
            return;
          }

          let queuedCoordSend!: QueuedCoordSend;
          const enqueuedAtMs = Date.now();
          const granted = await new Promise<boolean>((resolve) => {
            queuedCoordSend = {
              resolve,
              cancelled: false,
              granted: false,
              enqueuedAtMs,
              expired: false,
              traceId: requestTraceId,
              tools: coordSendTools,
              maxWaitMs: coordSendQueueWaitMs,
            };
            coordSendQueue.push(queuedCoordSend);
            cancelQueuedAdmission = (): void => {
              clearQueuedWaitTimer(queuedCoordSend);
              cancelQueuedCoordSend(queuedCoordSend);
            };

            const armCoordSendWaitWatch = (): void => {
              if (
                queuedCoordSend.maxWaitMs === 0 &&
                criticalContinuationQueueWaitLogMs === 0
              ) {
                return;
              }
              const waitedMs = Date.now() - queuedCoordSend.enqueuedAtMs;
              const remainingMs =
                queuedCoordSend.maxWaitMs > 0
                  ? Math.max(1, queuedCoordSend.maxWaitMs - waitedMs)
                  : Number.POSITIVE_INFINITY;
              const nextLogMs =
                criticalContinuationQueueWaitLogMs > 0
                  ? criticalContinuationQueueWaitLogMs
                  : Number.POSITIVE_INFINITY;
              const nextDelayMs = Math.min(remainingMs, nextLogMs);
              if (!Number.isFinite(nextDelayMs)) return;
              queuedCoordSend.waitTimer = setTimeout(() => {
                if (queuedCoordSend.granted || queuedCoordSend.cancelled)
                  return;
                const waitedSoFarMs =
                  Date.now() - queuedCoordSend.enqueuedAtMs;
                if (
                  queuedCoordSend.maxWaitMs > 0 &&
                  waitedSoFarMs >= queuedCoordSend.maxWaitMs
                ) {
                  queuedCoordSend.expired = true;
                  clearQueuedWaitTimer(queuedCoordSend);
                  cancelQueuedCoordSend(queuedCoordSend);
                  return;
                }
                log(
                  `coord-send request ${requestTraceId} still queued ` +
                    `${Math.round(waitedSoFarMs / 1000)}s — ` +
                    `${coordSendInFlight} in flight, ${coordSendQueueLength()} waiting`,
                );
                record({
                  kind: "coord_send_queue_wait",
                  method: req.method,
                  path: req.url,
                  traceId: requestTraceId,
                  tools: coordSendTools,
                  waitedMs: waitedSoFarMs,
                  coordSendInFlight,
                  queueLength: coordSendQueueLength(),
                  maxCoordSendQueue,
                  maxCoordSendQueueWaitMs: queuedCoordSend.maxWaitMs,
                });
                armCoordSendWaitWatch();
              }, nextDelayMs);
              queuedCoordSend.waitTimer.unref?.();
            };
            armCoordSendWaitWatch();
            log(
              `queued coord-send request ${requestTraceId} — ` +
                `${coordSendInFlight} in flight, ${coordSendQueueLength()} waiting`,
            );
            record({
              kind: "queue_coord_send",
              method: req.method,
              path: req.url,
              traceId: requestTraceId,
              tools: coordSendTools,
              coordSendInFlight,
              queueLength: coordSendQueueLength(),
              maxCoordSendQueue,
              maxCoordSendQueueWaitMs: coordSendQueueWaitMs,
              forwardingResult: "queued",
            });
          });
          clearQueuedWaitTimer(queuedCoordSend);
          cancelQueuedAdmission = null;
          if (!granted || clientGone) {
            if (granted) {
              coordSendGrantReservations = Math.max(
                0,
                coordSendGrantReservations - 1,
              );
              pumpCoordSendQueue();
            } else if (queuedCoordSend.expired && !clientGone) {
              const waitedMs = Date.now() - queuedCoordSend.enqueuedAtMs;
              res.writeHead(429, {
                "content-type": "application/json",
                "retry-after": "2",
              });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "mcp_proxy_coord_send_queue_dwell",
                  retryable: true,
                  forwardingResult: "not_forwarded" satisfies McpProxyForwardingResult,
                  detail: `coord:send waited ${waitedMs}ms in the dedicated FIFO (max ${queuedCoordSend.maxWaitMs}ms) — shed; retry`,
                  retryAfterSec: 2,
                  traceId: requestTraceId,
                }),
              );
              record({
                kind: "shed_coord_send_queue_dwell",
                method: req.method,
                path: req.url,
                traceId: requestTraceId,
                tools: coordSendTools,
                waitedMs,
                coordSendInFlight,
                queueLength: coordSendQueueLength(),
                maxCoordSendQueueWaitMs: queuedCoordSend.maxWaitMs,
                forwardingResult: "not_forwarded",
              });
            }
            return;
          }
          coordSendGrantReservations = Math.max(
            0,
            coordSendGrantReservations - 1,
          );
        }
        // EI-21556422206126497 — the one-socket continuation bulkhead protects durability writes
        // from normal traffic, but the old hard admission ceiling shed every SECOND durability
        // write immediately. Preserve single-flight upstream execution while absorbing a bounded
        // concurrent burst in FIFO order. A waiter owns no socket or in-flight slot until granted.
        if (
          criticalContinuation &&
          (!canGrantCriticalContinuation(criticalContinuationConflictKeys) ||
            hasQueuedCriticalContinuationConflict(
              criticalContinuationConflictKeys,
            ))
        ) {
          pumpCriticalContinuationQueue();
          // EI-21568137857973279 — the bounded continuation FIFO is itself a
          // recovery dependency: when all ordinary waiter slots are occupied, a
          // session already at its context wall must still be able to enqueue ONE
          // compaction. Keep that reservation bounded (one queued compaction) and
          // put it at the head of the waiter list so ordinary durability traffic
          // cannot consume or indefinitely sit ahead of the recovery slot.
          const compactionPriority =
            criticalContinuationTools.includes("session:request-compaction") &&
            !hasQueuedCompaction();
          // EI-21567991637671620 — preserve one bounded priority slot for loop:checkpoint.
          // This is separate from compaction: a compaction request may already be queued when the
          // loop needs to persist its carry-note, and vice versa.
          const loopCheckpointPriority =
            criticalContinuationTools.some((tool) =>
              loopCheckpointContinuationTools.has(tool),
            ) && !hasQueuedLoopCheckpoint();
          // EI-21598413057126541 — work_items:checkpoint is the fallback durability record. It
          // must have an independent slot from loop:checkpoint, because the fallback can arrive
          // while the loop checkpoint is already waiting in the same bounded FIFO.
          const workItemCheckpointPriority =
            criticalContinuationTools.some((tool) =>
              workItemCheckpointContinuationTools.has(tool),
            ) && !hasQueuedWorkItemCheckpoint();
          // EI-21567905826837255 — preserve one bounded priority slot for terminal completion.
          const completionPriority =
            criticalContinuationTools.some((tool) =>
              completionContinuationTools.has(tool),
            ) && !hasQueuedCompletion();
          const improvementsCapturePriority =
            criticalContinuationTools.some((tool) =>
              improvementsCaptureContinuationTools.has(tool),
            ) && !hasQueuedImprovementsCapture();
          if (
            maxCriticalContinuationQueue <= criticalContinuationQueueLength() &&
            !compactionPriority &&
            !loopCheckpointPriority &&
            !workItemCheckpointPriority &&
            !completionPriority &&
            !improvementsCapturePriority
          ) {
            const retryAfterSec = retryAfterSecForDrainRate(
              criticalContinuationInFlight,
              criticalContinuationConcurrencyCeiling,
              completedForwardAtMs,
              Date.now(),
            );
            res.writeHead(429, {
              "content-type": "application/json",
              "retry-after": String(retryAfterSec),
            });
            res.end(
              JSON.stringify({
                ok: false,
                error: "mcp_proxy_critical_continuation_queue_full",
                retryable: true,
                forwardingResult: "not_forwarded" satisfies McpProxyForwardingResult,
                detail: `proxy critical-continuation FIFO already has ${criticalContinuationQueueLength()} waiter(s) (queue max ${maxCriticalContinuationQueue})`,
                retryAfterSec,
                traceId: requestTraceId,
              }),
            );
            log(
              `shed critical-continuation request ${requestTraceId} (${criticalContinuationTools.join(",") || "unknown"}) — ` +
                `${criticalContinuationQueueLength()}/${maxCriticalContinuationQueue} waiters`,
            );
            record({
              kind: "shed_critical_continuation_queue_full",
              method: req.method,
              path: req.url,
              traceId: requestTraceId,
              tools: criticalContinuationTools,
              conflictKeys: criticalContinuationConflictKeys,
              criticalContinuationInFlight,
              queueLength: criticalContinuationQueueLength(),
              maxCriticalContinuationQueue,
              retryAfterSec,
              forwardingResult: "not_forwarded",
            });
            return;
          }

          let queuedCriticalContinuation!: QueuedCriticalContinuation;
          const enqueuedAtMs = Date.now();
          const nonExpiring = hasNonExpiringCriticalContinuation(
            criticalContinuationTools,
          );
          const improvementsCaptureWaitBound = criticalContinuationTools.some(
            (tool) => improvementsCaptureContinuationTools.has(tool),
          )
            ? improvementsCaptureQueueWaitMs
            : 0;
          const improvementsCaptureExplicitlyUnbounded =
            criticalContinuationTools.some(
              (tool) => improvementsCaptureContinuationTools.has(tool),
            ) && opts.improvementsCaptureQueueWaitMs === 0;
          const positiveQueueWaitBounds = [
            maxCriticalContinuationQueueWaitMs,
            improvementsCaptureWaitBound,
          ].filter((waitMs): waitMs is number => waitMs > 0);
          const effectiveQueueWaitMs = nonExpiring
            ? 0
            : improvementsCaptureExplicitlyUnbounded
              ? 0
            : positiveQueueWaitBounds.length > 0
              ? Math.min(...positiveQueueWaitBounds)
              : 0;
          const granted = await new Promise<boolean>((resolve) => {
            queuedCriticalContinuation = {
              resolve,
              cancelled: false,
              granted: false,
              enqueuedAtMs,
              expired: false,
              traceId: requestTraceId,
              tools: criticalContinuationTools,
              conflictKeys: criticalContinuationConflictKeys,
              maxWaitMs: effectiveQueueWaitMs,
            };
            if (
              compactionPriority ||
              loopCheckpointPriority ||
              workItemCheckpointPriority ||
              completionPriority ||
              improvementsCapturePriority
            ) {
              if (queuedCriticalContinuation.conflictKeys === null) {
                // Preserve the established recovery-priority contract for global
                // compaction/loop/incident writes: these deliberately jump the FIFO.
                criticalContinuationQueue.unshift(queuedCriticalContinuation);
              } else {
                // A keyed priority write may jump unrelated/global traffic, but never an
                // earlier mutation of the same work item. That is the only ordering domain
                // P-004 narrows, and it keeps bulk/overlapping mutations deterministic.
                let insertAt = 0;
                for (
                  let index = 0;
                  index < criticalContinuationQueue.length;
                  index++
                ) {
                  const earlier = criticalContinuationQueue[index];
                  if (
                    earlier?.conflictKeys &&
                    earlier.conflictKeys.some((key) =>
                      queuedCriticalContinuation.conflictKeys!.includes(key),
                    )
                  ) {
                    insertAt = index + 1;
                  }
                }
                criticalContinuationQueue.splice(
                  insertAt,
                  0,
                  queuedCriticalContinuation,
                );
              }
            } else {
              criticalContinuationQueue.push(queuedCriticalContinuation);
            }
            cancelQueuedAdmission = (): void => {
              clearQueuedWaitTimer(queuedCriticalContinuation);
              cancelQueuedCriticalContinuation(queuedCriticalContinuation);
            };

            const armCriticalContinuationWaitWatch = (): void => {
              if (
                queuedCriticalContinuation.maxWaitMs === 0 &&
                criticalContinuationQueueWaitLogMs === 0
              ) {
                return;
              }
              const waitedMs =
                Date.now() - queuedCriticalContinuation.enqueuedAtMs;
              const remainingMs =
                queuedCriticalContinuation.maxWaitMs > 0
                  ? Math.max(
                      1,
                      queuedCriticalContinuation.maxWaitMs - waitedMs,
                    )
                  : Number.POSITIVE_INFINITY;
              const nextLogMs =
                criticalContinuationQueueWaitLogMs > 0
                  ? criticalContinuationQueueWaitLogMs
                  : Number.POSITIVE_INFINITY;
              const nextDelayMs = Math.min(remainingMs, nextLogMs);
              if (!Number.isFinite(nextDelayMs)) return;
              queuedCriticalContinuation.waitTimer = setTimeout(() => {
                if (
                  queuedCriticalContinuation.granted ||
                  queuedCriticalContinuation.cancelled
                )
                  return;
                const waitedSoFarMs =
                  Date.now() - queuedCriticalContinuation.enqueuedAtMs;
                if (
                  queuedCriticalContinuation.maxWaitMs > 0 &&
                  waitedSoFarMs >= queuedCriticalContinuation.maxWaitMs
                ) {
                  queuedCriticalContinuation.expired = true;
                  clearQueuedWaitTimer(queuedCriticalContinuation);
                  cancelQueuedCriticalContinuation(queuedCriticalContinuation);
                  return;
                }
                log(
                  `critical-continuation request ${requestTraceId} (${criticalContinuationTools.join(",") || "unknown"}) ` +
                    `still queued ${Math.round(waitedSoFarMs / 1000)}s — ` +
                    `${criticalContinuationInFlight} in flight, ${criticalContinuationQueueLength()} waiting`,
                );
                record({
                  kind: "critical_continuation_queue_wait",
                  method: req.method,
                  path: req.url,
                  traceId: requestTraceId,
                  tools: criticalContinuationTools,
                  conflictKeys: criticalContinuationConflictKeys,
                  waitedMs: waitedSoFarMs,
                  criticalContinuationInFlight,
                  queueLength: criticalContinuationQueueLength(),
                  maxCriticalContinuationQueue,
                  maxCriticalContinuationQueueWaitMs:
                    queuedCriticalContinuation.maxWaitMs,
                });
                armCriticalContinuationWaitWatch();
              }, nextDelayMs);
              queuedCriticalContinuation.waitTimer.unref?.();
            };
            armCriticalContinuationWaitWatch();
            log(
              `queued critical-continuation request ${requestTraceId} (${criticalContinuationTools.join(",") || "unknown"}) — ` +
                `${criticalContinuationInFlight} in flight, ${criticalContinuationQueueLength()} waiting`,
            );
            record({
              kind: "queue_critical_continuation",
              method: req.method,
              path: req.url,
              traceId: requestTraceId,
              tools: criticalContinuationTools,
              conflictKeys: criticalContinuationConflictKeys,
              criticalContinuationInFlight,
              queueLength: criticalContinuationQueueLength(),
              maxCriticalContinuationQueue,
              maxCriticalContinuationQueueWaitMs: effectiveQueueWaitMs,
              forwardingResult: "queued",
            });
          });
          clearQueuedWaitTimer(queuedCriticalContinuation);
          cancelQueuedAdmission = null;
          if (!granted || clientGone) {
            if (granted) {
              criticalContinuationGrantReservations = Math.max(
                0,
                criticalContinuationGrantReservations - 1,
              );
              pumpCriticalContinuationQueue();
            } else if (queuedCriticalContinuation.expired && !clientGone) {
              const waitedMs =
                Date.now() - queuedCriticalContinuation.enqueuedAtMs;
              // EI-22090638969690024 — name the HOLDER. Without it a shed reporting
              // `queueLength: 0` is indistinguishable from "the transport dropped my write",
              // and the honest cause (one slow durability write owning the single socket) is
              // unrecoverable from the response.
              const blocker = criticalContinuationBlocker(
                queuedCriticalContinuation.conflictKeys,
              );
              const blockedByDetail = blocker
                ? ` — head-of-line blocked by ${blocker.tools.join(",") || "an unnamed continuation"} in flight ${blocker.ageMs}ms (trace ${blocker.traceId})`
                : " — no continuation was in flight; the slot was released before the retry";
              res.writeHead(429, {
                "content-type": "application/json",
                "retry-after": "2",
              });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "mcp_proxy_critical_continuation_queue_dwell",
                  retryable: true,
                  forwardingResult: "not_forwarded" satisfies McpProxyForwardingResult,
                  detail: `critical-continuation write waited ${waitedMs}ms in the FIFO (max ${queuedCriticalContinuation.maxWaitMs}ms, ${criticalContinuationQueueLength()} other waiter(s))${blockedByDetail}`,
                  retryAfterSec: 2,
                  traceId: requestTraceId,
                  ...(blocker ? { blockedBy: blocker } : {}),
                }),
              );
              record({
                kind: "shed_critical_continuation_queue_dwell",
                method: req.method,
                path: req.url,
                traceId: requestTraceId,
                tools: criticalContinuationTools,
                waitedMs,
                criticalContinuationInFlight,
                queueLength: criticalContinuationQueueLength(),
                maxCriticalContinuationQueueWaitMs:
                  queuedCriticalContinuation.maxWaitMs,
                blockedByTools: blocker?.tools ?? [],
                blockedByAgeMs: blocker?.ageMs ?? null,
                blockedByTraceId: blocker?.traceId ?? null,
                forwardingResult: "not_forwarded",
              });
            }
            return;
          }
          criticalContinuationGrantReservations = Math.max(
            0,
            criticalContinuationGrantReservations - 1,
          );
        }
        // EI-21391963810159383 — a proxy restart made ~60 clients reconnect at once. Because
        // initialize/tools/list/ping are reserved traffic, every one bypassed the ordinary
        // ceiling and queued/replayed inside the 8-socket control-plane pool: 1,164 internal
        // timeout retries and 96 total in flight in six minutes, including the watchdog behind
        // the herd it was trying to diagnose. Bound THIS write-free class before it opens an
        // upstream socket. The watchdog's exact named probe alone uses the socket deliberately
        // left outside the normal production partition; its one-socket agent is its hard bound.
        const countsTowardHandshakeCap =
          sessionHandshake && !watchdogSessionProbe;
        if (countsTowardHandshakeCap && !canGrantHandshake()) {
          // Prune cancelled entries before enforcing the bounded FIFO length. A cancelled
          // request is not capacity, even when its promise has not yet reached the async
          // continuation that observes the false grant.
          pumpHandshakeQueue();
          if (maxHandshakeQueue <= handshakeQueueLength()) {
            res.writeHead(429, {
              "content-type": "application/json",
              "retry-after": "2",
            });
            res.end(
              JSON.stringify({
                error: "mcp_proxy_handshake_overloaded",
                detail: `proxy already has ${handshakeInFlight} session handshake(s) in flight (class max ${maxHandshakeInFlight}, queue max ${maxHandshakeQueue}) — shed before forwarding`,
                retryAfterSec: 2,
              }),
            );
            log(
              `shed session handshake — ${handshakeInFlight} already in flight (class max ${maxHandshakeInFlight}, queue full)`,
            );
            record({
              kind: "shed_handshake_queue_full",
              method: req.method,
              path: req.url,
              inFlight: inFlightNow,
              handshakeInFlight,
              maxHandshakeInFlight,
              maxHandshakeQueue,
              reservedControlPlane,
              watchdogSessionProbe,
            });
            return;
          }

          let queuedHandshake!: QueuedHandshake;
          const enqueuedAtMs = Date.now();
          const granted = await new Promise<boolean>((resolve) => {
            queuedHandshake = {
              resolve,
              cancelled: false,
              granted: false,
              enqueuedAtMs,
              expired: false,
            };
            handshakeQueue.push(queuedHandshake);
            cancelQueuedAdmission = (): void => {
              clearQueuedWaitTimer(queuedHandshake);
              cancelQueuedHandshake(queuedHandshake);
            };
            // EI-21504897841052086 — a queued waiter previously produced exactly ONE ledger
            // row (at arrival), so the measured wedge showed "8 in flight, N waiting" for 13
            // minutes with no evidence of whether the holders were progressing. Mirror the
            // per-request stall-watch: while THIS waiter is still queued, beat on a fixed
            // cadence; once dwell crosses the bound, expire it (resolves false below).
            if (queueWaitLogMs > 0) {
              const armQueueWaitWatch = (): void => {
                queuedHandshake.waitTimer = setTimeout(() => {
                  if (queuedHandshake.granted || queuedHandshake.cancelled)
                    return;
                  const waitedSoFarMs =
                    Date.now() - queuedHandshake.enqueuedAtMs;
                  if (
                    handshakeQueueWaitExpired(
                      waitedSoFarMs,
                      maxHandshakeQueueWaitMs,
                    )
                  ) {
                    queuedHandshake.expired = true;
                    clearQueuedWaitTimer(queuedHandshake);
                    cancelQueuedHandshake(queuedHandshake); // resolves false + pumps the queue
                    return;
                  }
                  log(
                    `session handshake still queued ${Math.round(waitedSoFarMs / 1000)}s — ` +
                      `${handshakeInFlight} in flight, ${handshakeQueueLength()} waiting (max ${maxHandshakeQueue})`,
                  );
                  record({
                    kind: "handshake_queue_wait",
                    method: req.method,
                    path: req.url,
                    waitedMs: waitedSoFarMs,
                    handshakeInFlight,
                    queueLength: handshakeQueueLength(),
                    maxHandshakeInFlight,
                    maxHandshakeQueue,
                  });
                  armQueueWaitWatch();
                }, queueWaitLogMs);
                queuedHandshake.waitTimer?.unref?.();
              };
              armQueueWaitWatch();
            }
            log(
              `queued session handshake — ${handshakeInFlight} in flight, ${handshakeQueueLength()} waiting (max ${maxHandshakeQueue})`,
            );
            record({
              kind: "queue_handshake",
              method: req.method,
              path: req.url,
              inFlight: inFlightNow,
              handshakeInFlight,
              queueLength: handshakeQueueLength(),
              maxHandshakeInFlight,
              maxHandshakeQueue,
            });
          });
          clearQueuedWaitTimer(queuedHandshake);
          cancelQueuedAdmission = null;
          if (!granted || clientGone) {
            if (granted) {
              handshakeGrantReservations = Math.max(
                0,
                handshakeGrantReservations - 1,
              );
              pumpHandshakeQueue();
            } else if (queuedHandshake.expired && !clientGone) {
              // Dwell expiry with a LIVE client: answer honestly instead of silently
              // dropping it — the client's own budget (16-44s observed) may not have fired.
              const waitedMs = Date.now() - queuedHandshake.enqueuedAtMs;
              res.writeHead(429, {
                "content-type": "application/json",
                "retry-after": "2",
              });
              res.end(
                JSON.stringify({
                  error: "mcp_proxy_handshake_queue_dwell",
                  detail: `session handshake waited ${waitedMs}ms in the admission queue (max ${maxHandshakeQueueWaitMs}ms) — shed; retry`,
                  retryAfterSec: 2,
                }),
              );
              log(
                `shed session handshake — queue dwell ${waitedMs}ms exceeded ${maxHandshakeQueueWaitMs}ms`,
              );
              record({
                kind: "shed_handshake_queue_dwell",
                method: req.method,
                path: req.url,
                waitedMs,
                handshakeInFlight,
                queueLength: handshakeQueueLength(),
                maxHandshakeQueueWaitMs,
              });
            }
            return;
          }
          handshakeGrantReservations = Math.max(
            0,
            handshakeGrantReservations - 1,
          );
        }
        const admittedAt = Date.now();
        const inFlightId = nextInFlightId++;
        const inFlightStartedAt = Date.now();
        inFlightStarts.set(inFlightId, inFlightStartedAt);
        if (improvementsCapture) {
          improvementsCaptureInFlight++;
          improvementsCaptureInFlightStarts.set(inFlightId, inFlightStartedAt);
          improvementsCaptureRequests.set(inFlightId, {
            startedAtMs: inFlightStartedAt,
            traceId: requestTraceId,
            tools: improvementsCaptureTools,
            conflictKeys: null,
          });
        } else if (coordSend) {
          coordSendInFlight++;
          coordSendInFlightStarts.set(inFlightId, inFlightStartedAt);
          coordSendRequests.set(inFlightId, {
            startedAtMs: inFlightStartedAt,
            traceId: requestTraceId,
            tools: coordSendTools,
            conflictKeys: null,
          });
        } else if (criticalContinuation) {
          criticalContinuationInFlight++;
          criticalContinuationInFlightStarts.set(inFlightId, inFlightStartedAt);
          criticalContinuationRequests.set(inFlightId, {
            startedAtMs: inFlightStartedAt,
            traceId: requestTraceId,
            tools: criticalContinuationTools,
            conflictKeys: criticalContinuationConflictKeys,
          });
          // A newly active key may leave later disjoint waiters immediately runnable.
          pumpCriticalContinuationQueue();
        } else if (watchdogSessionProbe) {
          watchdogProbeInFlight++;
          watchdogProbeInFlightStarts.set(inFlightId, inFlightStartedAt);
        } else if (standardReservedControlPlane) {
          reservedControlPlaneInFlight++;
          reservedControlPlaneInFlightStarts.set(inFlightId, inFlightStartedAt);
        } else {
          ordinaryInFlight++;
          ordinaryInFlightStarts.set(inFlightId, inFlightStartedAt);
        }
        if (countsTowardHandshakeCap) handshakeInFlight++;
        scheduleStallCheck(inFlightId, inFlightStartedAt);
        try {
          // P-005: classify the forward + (for a tools/call) inject a per-request
          // idempotencyKey ONCE, reused across every retry of THIS request so :3070 dedups a
          // replay instead of double-applying the write. Kill-switch:
          // PAPERCUSP_MCP_PROXY_KEYED_RETRY=0 forces tools/call to 'opaque' (refused-only).
          const keyingEnabled =
            process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY !== "0";
          // EI-21268234394605529: replay a provably read-only tools/call once on a
          // post-connect socket error (own kill-switch; the keying master switch above
          // disables it too). Defaults ON.
          const readonlyRetryEnabled =
            keyingEnabled &&
            process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY !== "0";
          // P-010: absorb an admission-control 429 by retrying (kill-switch to opt out).
          const absorb429 = process.env.PAPERCUSP_MCP_PROXY_ABSORB_429 !== "0";
          const absorbBoot =
            process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT !== "0";
          const fwd = prepareForward(
            req.method ?? "GET",
            req.headers,
            rawBody,
            { keyingEnabled, readonlyRetryEnabled, genKey: randomUUID, requestPath: req.url },
          );
          const traceId = requestTraceId;
          fwd.headers = withDataPlaneDegradedHeader(
            { ...fwd.headers, [MCP_PROXY_TRACE_HEADER]: traceId },
            isMcpApiRequest ? lastDataPlaneInstabilityAtMs : 0,
          );
          // WI-41042 detector gap: `klass:'idempotent'` folds initialize,
          // tools/list, ping, resources and prompts together. Preserve only the
          // bounded protocol method names in failure telemetry so the next
          // no-header stall identifies its handler path without logging args.
          const rpcTrace = {
            traceId,
            ...(fwd.rpcMethods.length ? { rpcMethods: fwd.rpcMethods } : {}),
          };
          const isInitialize = fwd.rpcMethods.includes("initialize");
          const isToolsList = fwd.rpcMethods.includes("tools/list");
          const recordInitializeStage = (
            outcome:
              | "success"
              | "slow_response"
              | "timeout_retry"
              | "timeout_exhausted",
            upstreamMs: number,
            nativeSession?: NativeSessionAttribution,
          ): void => {
            const totalMs = boundedMcpProxyStageMs(Date.now() - receivedAt);
            if (
              !isInitialize ||
              (outcome === "slow_response" && totalMs < initializeSlowMs)
            )
              return;
            // Privacy boundary: request-specific fields are limited to the proxy-owned trace id,
            // a finite outcome enum, bounded stage durations, and pseudonymous native-session
            // attribution with an explicit trust label. Never add raw headers, URLs, bodies,
            // tool names, or error text to this record.
            record({
              kind: "initialize_stage",
              traceId,
              outcome,
              stages: {
                bodyReadMs: boundedMcpProxyStageMs(bodyReadyAt - receivedAt),
                admissionWaitMs: boundedMcpProxyStageMs(admittedAt - bodyReadyAt),
                upstreamMs: boundedMcpProxyStageMs(upstreamMs),
                totalMs,
              },
              ...(nativeSession ? { nativeSession } : {}),
            });
          };
          // EI-19294517824914302: a cheap repeating beat fails fast instead of burning the
          // restart-sized window (~30 attempts) and amplifying a transient stall ~30x.
          const retryWindowMs = effectiveRetryWindowMs(
            req.url ?? "/",
            opts.retryWindowMs,
          );
          const started = Date.now();
          let attempts = 0;
          let postConnectRetries = 0;
          let backpressureRetries = 0;
          let handshakeTimeoutRetries = 0;
          let candidateIndex = 0;
          let candidateCount = 0;
          let last: ForwardOutcome | undefined;
          // Retry loop: refused → walk ordered candidates, then replay the last candidate
          // across the window (shouldRetry); post-connect →
          // replay only an idempotent/readonly request, bounded (postConnectRetryable);
          // upstream 429 (admission-control backpressure) → absorb + retry (P-010).
          // eslint-disable-next-line no-constant-condition
          while (true) {
            // WI-35737: the client is gone — every further attempt is upstream capacity spent
            // on a response nobody can read, during the exact windows when it is scarcest.
            // Checked at the TOP so it also covers a client that left between two attempts.
            if (clientGone) break;
            // Re-evaluate the window immediately before every upstream hop. A delayed retry
            // must not carry a timestamp that expired while it was queued/backing off.
            fwd.headers = withDataPlaneDegradedHeader(
              fwd.headers,
              isMcpApiRequest ? lastDataPlaneInstabilityAtMs : 0,
            );
            attempts++;
            const attemptStartedAt = Date.now();
            // WI-6740: bound the write-free control-plane batch tightly (see
            // HANDSHAKE_UPSTREAM_TIMEOUT_MS). EI-19305299022434394: a real tools/call is no
            // longer literally unbounded either — `maxHoldMs` (generous, default 10 min) is the
            // absolute ceiling that stops a stalled-but-connected upstream from silently
            // parking a socket for 32-89 minutes, while staying well above any legitimate tool's
            // real runtime (`build:typecheck` ~160s).
            // WI-35737: arm client-disconnect abort for THIS attempt — write-free class only.
            // A 'keyed'/'opaque' batch carries a tools/call whose side effect may already be
            // landing upstream, so we let it finish and simply discard the result; that is the
            // same retry-safety rule `handshakeTimeoutRetryable` applies, for the same reason.
            // (This costs nothing in practice: every failure in the measured 2026-08-08 window
            // — 540 handshake timeouts, 520 upstream errors, 245 post-connect retries — was
            // klass 'idempotent'.)
            const attemptAbort =
              fwd.klass === "idempotent" ? new AbortController() : null;
            abortAttempt = attemptAbort
              ? (): void => attemptAbort.abort()
              : null;
            let outcome: ForwardOutcome;
            candidateCount = 0;
            try {
              const candidates = resolveTargetCandidates(opts);
              candidateCount = candidates.length;
              candidateIndex = Math.min(candidateIndex, candidates.length - 1);
              outcome = await forwardOnce(
                opts,
                candidates[candidateIndex]!,
                req.method ?? "GET",
                req.url ?? "/",
                fwd.headers,
                fwd.body,
                watchdogSessionProbe
                  ? watchdogAgent
                  : improvementsCapture
                    ? improvementsCaptureAgent
                  : coordSend
                    ? coordSendAgent
                    : criticalContinuation
                      ? criticalContinuationAgent
                    : reservedControlPlane && controlPlaneReserve > 0
                      ? controlPlaneAgent
                      : upstreamAgent,
                fwd.klass === "idempotent"
                  ? (opts.handshakeTimeoutMs ?? HANDSHAKE_UPSTREAM_TIMEOUT_MS)
                  : maxHoldMs > 0
                    ? maxHoldMs
                    : 0,
                attemptAbort?.signal,
              );
            } finally {
              abortAttempt = null;
            }
            const upstreamMs = Date.now() - attemptStartedAt;
            // The abort above surfaces as an ordinary failed attempt; `clientGone` is what
            // decides, so a race between the abort landing and the response arriving cannot
            // write to a dead socket.
            if (clientGone) {
              // EI-21908521835344903: the client is gone, so nothing can be written back to
              // it — but for a 'keyed'/'opaque' class this attempt was never aborted (only
              // 'idempotent' gets an AbortController; see the comment above `attemptAbort`),
              // so the write may have LANDED anyway. `outcome` already holds that answer right
              // here; record it instead of discarding it, so the forensic ledger can later
              // distinguish "committed after the client gave up" from "genuinely failed" —
              // exactly what a caller whose own MCP client surfaced a bare, undiscriminated
              // "operation timed out" (a client-side message this proxy never emits and
              // cannot rewrite) currently has no way to determine except by hand-verifying
              // application state. `upstreamStatus` present + 2xx means the write applied.
              if (outcome.ures) outcome.ures.resume(); // drain so the (keepAlive:false) socket is released
              record({
                kind: "client_gone",
                method: req.method,
                path: req.url,
                klass: fwd.klass,
                attempts,
                elapsedMs: Date.now() - started,
                upstreamStatus: outcome.ures?.statusCode,
                connected: outcome.connected,
                timedOut: outcome.timedOut ?? false,
                upstreamErr: outcome.err
                  ? String(outcome.err.message ?? outcome.err)
                  : undefined,
              });
              break;
            }
            const elapsed = Date.now() - started;
            if (outcome.ures) {
              const ures = outcome.ures;
              const status = ures.statusCode ?? 502;
              recordInitializeStage("slow_response", upstreamMs);
              // P-010: :3070 shed this tools/call (event loop critically saturated). The tool
              // NEVER dispatched (429 = not fulfilled) → replay is write-safe for any class.
              // Drain the shed response to free the socket, wait Retry-After, and retry within
              // the window so the saturation is invisible to the agent. When the operator stays
              // critical past the window/max, fall through and surface the 429 (honest, not a hang).
              // POST-only: every real MCP call is a POST. A GET/HEAD (health probes, the
              // watchdog's liveness check) that yields 404/405 must surface INSTANTLY —
              // absorbing it would stall probes for the whole retry window and read as a
              // wedge (worst case: the watchdog restart-loops the proxy, flapping the fleet).
              const bootAbsorbable =
                req.method === "POST" &&
                BOOT_WINDOW_STATUSES.has(status) &&
                absorbBoot;
              if (
                ((isBackpressureStatus(status) && absorb429) ||
                  bootAbsorbable) &&
                backpressureRetryable(
                  backpressureRetries,
                  MAX_BACKPRESSURE_RETRIES,
                  elapsed,
                  retryWindowMs,
                )
              ) {
                backpressureRetries++;
                if (isMcpApiRequest) {
                  lastDataPlaneInstabilityAtMs = Date.now();
                }
                fwd.headers = withDataPlaneDegradedHeader(
                  fwd.headers,
                  isMcpApiRequest ? lastDataPlaneInstabilityAtMs : 0,
                );
                const waitMs = retryAfterMs(
                  ures.headers["retry-after"],
                  backoff,
                  MAX_BACKPRESSURE_WAIT_MS,
                );
                ures.resume(); // discard the shed/boot-window body so the (keepAlive:false) socket is released
                record({
                  kind: isBackpressureStatus(status)
                    ? "absorb_429"
                    : "absorb_boot_status",
                  method: req.method,
                  path: req.url,
                  status,
                  attempts,
                  backpressureRetries,
                  waitMs,
                  elapsedMs: elapsed,
                });
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
              }
              if (
                status >= 200 &&
                status < 300 &&
                (isInitialize || isToolsList)
              ) {
                try {
                  const observer = createMcpResponseTelemetryObserver(
                    ures.headers["content-type"],
                  );
                  let responseFinished = false;
                  let observationFinished = false;
                  let observation: McpResponseTelemetrySummary | null = null;
                  let telemetryRecorded = false;
                  const recordSuccessfulObservation = (): void => {
                    if (
                      telemetryRecorded ||
                      !responseFinished ||
                      !observationFinished ||
                      !observation ||
                      !observation.resultSeen ||
                      observation.errorSeen
                    )
                      return;
                    const recordInitializeSuccess = isInitialize;
                    const recordToolsListSuccess =
                      isToolsList && observation.toolsArraySeen;
                    if (!recordInitializeSuccess && !recordToolsListSuccess)
                      return;
                    telemetryRecorded = true;
                    const nativeSession = nativeSessionAttribution(req.headers);
                    const stages = {
                      bodyReadMs: boundedMcpProxyStageMs(
                        bodyReadyAt - receivedAt,
                      ),
                      admissionWaitMs: boundedMcpProxyStageMs(
                        admittedAt - bodyReadyAt,
                      ),
                      upstreamMs: boundedMcpProxyStageMs(upstreamMs),
                      totalMs: boundedMcpProxyStageMs(Date.now() - receivedAt),
                    };
                    const toolCount = observation.toolCount;
                    const toolNames = observation.toolNames;
                    setImmediate(() => {
                      if (recordInitializeSuccess)
                        recordInitializeStage(
                          "success",
                          upstreamMs,
                          nativeSession,
                        );
                      if (recordToolsListSuccess)
                        record({
                          kind: "tools_list_stage",
                          traceId,
                          outcome: "success",
                          toolCount,
                          toolNames,
                          stages,
                          nativeSession,
                        });
                    });
                  };
                  ures.on("data", (chunk: Buffer) => observer.write(chunk));
                  ures.once("end", () => {
                    void observer
                      .finish()
                      .then((summary) => {
                        observation = summary;
                        observationFinished = true;
                        recordSuccessfulObservation();
                      })
                      .catch(() => {
                        observation = null;
                        observationFinished = true;
                        recordSuccessfulObservation();
                      });
                  });
                  ures.once("error", () => {
                    observation = null;
                    observationFinished = true;
                    recordSuccessfulObservation();
                  });
                  res.once("finish", () => {
                    responseFinished = true;
                    recordSuccessfulObservation();
                  });
                } catch {
                  // Telemetry setup is best-effort; the original response pipe owns delivery.
                }
              }
              res.writeHead(status, ures.headers);
              // WI-35737: an MCP response is an SSE stream that stays open long after headers
              // arrive (and long after this function returns and releases its in-flight slot).
              // `pipe` does NOT tear down the SOURCE when the destination dies, so without
              // this a client that vanishes mid-stream leaves :3070 writing into a dead socket
              // for the life of the stream. Safe for every class, unlike aborting a request
              // in flight: headers are already back, so the tools/call has run — destroying
              // the RESPONSE cannot half-apply anything.
              res.on("close", () => {
                if (!ures.destroyed) ures.destroy();
              });
              ures.pipe(res);
              if (attempts > 1) {
                log(
                  `recovered after ${attempts} attempts (${Date.now() - started}ms) — upstream target came back`,
                );
                record({
                  kind: "recovered",
                  method: req.method,
                  ...(!(isInitialize || isToolsList) ? { path: req.url } : {}),
                  status,
                  attempts,
                  postConnectRetries,
                  klass: fwd.klass,
                  elapsedMs: Date.now() - started,
                  forwardingResult: "applied",
                  ...rpcTrace,
                });
              }
              // Forwarded a non-2xx: previously INVISIBLE (no tool_invocations row). A 4xx with
              // `connection: close` is the stale-socket-400 signature (W1.3) — record it so any
              // regression of that class is instantly visible, never silently "transient".
              if (status >= 400) {
                record({
                  kind: "upstream_non2xx",
                  method: req.method,
                  path: req.url,
                  status,
                  attempts,
                  elapsedMs: Date.now() - started,
                  connection: (ures.headers["connection"] as string) ?? null,
                  forwardingResult: "applied",
                });
              }
              return;
            }
            last = outcome;
            if (isMcpApiRequest) {
              lastDataPlaneInstabilityAtMs = Date.now();
            }
            fwd.headers = withDataPlaneDegradedHeader(
              fwd.headers,
              isMcpApiRequest ? lastDataPlaneInstabilityAtMs : 0,
            );
            if (!outcome.connected) {
              // Refused / pre-connect: the request provably never reached the selected
              // upstream. Walk to the next candidate only in this safe state; a connected
              // error must never fail over because the first target may have applied a write.
              if (
                candidateIndex + 1 < candidateCount &&
                shouldRetry(false, elapsed, retryWindowMs)
              ) {
                candidateIndex++;
                continue;
              }
              // Once every candidate has refused, keep retrying the last candidate until
              // the same bounded window expires.
              if (shouldRetry(false, elapsed, retryWindowMs)) {
                await new Promise((r) => setTimeout(r, backoff));
                continue;
              }
              break;
            }
            // WI-6740: upstream went SILENT (not a socket error). Replay the write-free
            // handshake so a ~10s :3070 stall is a slightly-slower connect instead of a
            // session that is tool-dark for hours. Checked BEFORE the socket-error branch
            // so it gets its own (larger) bound rather than consuming MAX_POST_CONNECT_RETRIES.
            const retryTimedOutHandshake = Boolean(
              outcome.timedOut &&
              handshakeTimeoutRetryable(
                fwd.klass,
                handshakeTimeoutRetries,
                MAX_HANDSHAKE_TIMEOUT_RETRIES,
                elapsed,
                retryWindowMs,
                (opts.handshakeTimeoutMs ?? HANDSHAKE_UPSTREAM_TIMEOUT_MS) +
                  backoff,
              ),
            );
            if (outcome.timedOut) {
              recordInitializeStage(
                retryTimedOutHandshake ? "timeout_retry" : "timeout_exhausted",
                upstreamMs,
              );
            }
            if (retryTimedOutHandshake) {
              handshakeTimeoutRetries++;
              record({
                kind: "handshake_timeout_retry",
                method: req.method,
                path: req.url,
                klass: fwd.klass,
                attempts,
                handshakeTimeoutRetries,
                elapsedMs: elapsed,
                ...rpcTrace,
              });
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            // A timed-out handshake has exhausted its dedicated retry budget. Do not let it
            // fall through to the socket-error retry budget: that would add a fourth attempt
            // after the two allowed timeout retries and amplify the same silent upstream stall.
            if (outcome.timedOut) break;
            // Post-connect failure: replay ONLY an idempotent or server-keyed request, bounded.
            if (
              postConnectRetryable(
                fwd.klass,
                postConnectRetries,
                MAX_POST_CONNECT_RETRIES,
                elapsed,
                retryWindowMs,
              )
            ) {
              postConnectRetries++;
              record({
                kind: "post_connect_retry",
                method: req.method,
                path: req.url,
                klass: fwd.klass,
                attempts,
                elapsedMs: elapsed,
                detail: String(outcome.err?.message ?? ""),
                ...rpcTrace,
              });
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            break;
          }
          // WI-35737: the loop broke because the CLIENT left, not because upstream failed.
          // There is no socket to answer on, and writing the 502/503 below would both throw
          // and record a phantom `upstream_error` — inflating the very failure counts this
          // incident is being triaged from. The `finally` still releases the in-flight slot.
          if (clientGone) return;
          // Exhausted the window (or a post-connect error we must not / no longer replay).
          const refused = last && !last.connected;
          res.writeHead(refused ? 503 : 502, {
            "content-type": "application/json",
            "retry-after": "5",
          });
          res.end(
            JSON.stringify({
              error: refused
                ? "mcp_proxy_upstream_unavailable"
                : "mcp_proxy_upstream_error",
              forwardingResult: forwardingResultForUpstreamFailure(
                Boolean(last?.connected),
              ),
              detail: String(last?.err?.message ?? last?.err ?? "unknown"),
              attempts,
              windowMs: retryWindowMs,
              note: refused
                ? "upstream target refused connections for the whole retry window (restart took too long or is down)"
                : fwd.klass === "opaque"
                  ? "upstream errored AFTER connecting — not retried (avoids double-applying a non-idempotent tools/call)"
                  : fwd.klass === "keyed"
                    ? // EI-21568680890986171: a keyed write is NEVER auto-retried here — postConnectRetryable
                      // only admits 'idempotent'/'readonly' — so postConnectRetries stays 0 and the old
                      // "retried N×" phrasing falsely implied a retry was attempted. The call carries a
                      // proxy-injected idempotencyKey, so IF the caller resends the identical body :3070
                      // dedups server-side instead of double-applying — but the proxy itself does not know
                      // whether the first attempt's write landed, so it surfaces honestly rather than guess.
                      fwd.hasCodeRunWrapper
                        ? "upstream errored AFTER connecting — not auto-retried (the outer code:run wrapper's " +
                          "nested outcome is unknown; its script may have performed reads or writes. " +
                          "Repeating the same request is safe for writes only when the caller preserves " +
                          "its idempotency key)"
                        : "upstream errored AFTER connecting — not auto-retried (the write's outcome is unknown; " +
                          "resending the same call is safe server-side dedup if the caller preserves its idempotency key)"
                    : `upstream errored AFTER connecting; retried ${postConnectRetries}× (${fwd.klass}) then surfaced the error`,
            }),
          );
          log(
            `upstream ${refused ? "unavailable" : "error"} after ${attempts} attempt(s): ${last?.err?.message ?? last?.err}`,
          );
          record({
            kind: refused ? "exhausted_refused" : "upstream_error",
            method: req.method,
            path: req.url,
            status: refused ? 503 : 502,
            attempts,
            postConnectRetries,
            klass: fwd.klass,
            elapsedMs: Date.now() - started,
            detail: String(last?.err?.message ?? last?.err ?? "unknown"),
            forwardingResult: forwardingResultForUpstreamFailure(
              Boolean(last?.connected),
            ),
            ...rpcTrace,
          });
        } finally {
          // EI-19305299022434394: always release the in-flight slot, on every exit path
          // (success return, exhausted-window fallthrough, or an unexpected throw).
          const completedAtMs = Date.now();
          inFlightStarts.delete(inFlightId);
          if (improvementsCapture) {
            improvementsCaptureInFlight = Math.max(
              0,
              improvementsCaptureInFlight - 1,
            );
            improvementsCaptureInFlightStarts.delete(inFlightId);
            improvementsCaptureRequests.delete(inFlightId);
          } else if (coordSend) {
            coordSendInFlight = Math.max(0, coordSendInFlight - 1);
            coordSendInFlightStarts.delete(inFlightId);
            coordSendRequests.delete(inFlightId);
          } else if (criticalContinuation) {
            criticalContinuationInFlight = Math.max(
              0,
              criticalContinuationInFlight - 1,
            );
            criticalContinuationInFlightStarts.delete(inFlightId);
            criticalContinuationRequests.delete(inFlightId);
          } else if (watchdogSessionProbe) {
            watchdogProbeInFlight = Math.max(0, watchdogProbeInFlight - 1);
            watchdogProbeInFlightStarts.delete(inFlightId);
          } else if (standardReservedControlPlane) {
            reservedControlPlaneInFlight = Math.max(
              0,
              reservedControlPlaneInFlight - 1,
            );
            reservedControlPlaneInFlightStarts.delete(inFlightId);
          } else {
            ordinaryInFlight = Math.max(0, ordinaryInFlight - 1);
            ordinaryInFlightStarts.delete(inFlightId);
          }
          recordForwardCompletion(completedAtMs);
          if (countsTowardHandshakeCap)
            handshakeInFlight = Math.max(0, handshakeInFlight - 1);
          // EI-19388661789704364: cancel this request's own stall timer so a fast forward
          // never leaves a dangling scheduled check (and never fires one after completion).
          const stallTimer = stallTimers.get(inFlightId);
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimers.delete(inFlightId);
          }
          // A released ordinary slot can unblock a queued handshake even when the class cap
          // itself was already available; pump after both counters are current so neither cap
          // is oversubscribed during the grant continuation.
          pumpHandshakeQueue();
          pumpCriticalContinuationQueue();
          pumpCoordSendQueue();
          pumpImprovementsCaptureQueue();
        }
      })();
    });
  });
  // Adding a `clientError` listener disables Node's default socket destruction, so preserve the
  // default safety behavior after recording the event. The event may represent a parser error or
  // an ECONNRESET before an IncomingMessage exists; both are inbound and otherwise invisible.
  server.on("clientError", (error, socket) => {
    recordInboundClientError(error, socket);
    socket.destroy();
  });
  // Node emits `drop` when its connection admission limit rejects a socket. This is the closest
  // process-level signal to listen-backlog pressure; kernel-level SYN/backlog drops cannot be
  // observed by userland, so do not claim this counter is a complete refusal count.
  server.on("drop", (details) => {
    inbound.drops++;
    log(
      `inbound connection dropped (accept pressure): ${details?.remoteAddress ?? "unknown peer"}`,
    );
    record({
      kind: "inbound_drop",
      event: "drop",
      acceptPressure: true,
      drops: inbound.drops,
      ...details,
    });
  });
  server.on("connection", (socket) => {
    inbound.accepted++;
    inbound.active++;
    socket.once("close", () => {
      inbound.active = Math.max(0, inbound.active - 1);
    });
  });
  // EI-21275891049298859: the proxy is the MCP client's inbound HTTP server, so it
  // needs the same WI-1711 keep-alive policy as the operator it fronts. Leaving this
  // raw `http.createServer` on Node's 5s default let ptool finish tools/list, pause
  // briefly under install/CPU pressure, then race the server FIN on tools/call — two
  // concurrent calls surfaced ECONNRESET/UND_ERR_SOCKET without ever reaching the
  // proxy's upstream-failure ledger. Reuse the canonical 61s policy (including the
  // headersTimeout > keepAliveTimeout invariant and existing kill-switch) instead of
  // inventing a proxy-specific timeout surface.
  applyServerTimeouts(server);
  server.on("close", () => {
    for (const timer of stallTimers.values()) clearTimeout(timer);
    stallTimers.clear();
    // EI-21504897841052086 — queued waiters' dwell watches must not hold the loop open.
    for (const waiter of handshakeQueue) clearQueuedWaitTimer(waiter);
    for (const waiter of criticalContinuationQueue)
      clearQueuedWaitTimer(waiter);
    for (const waiter of coordSendQueue) clearQueuedWaitTimer(waiter);
    for (const waiter of improvementsCaptureQueue)
      clearQueuedWaitTimer(waiter);
    if (ownsControlPlaneAgent) controlPlaneAgent.destroy();
    if (ownsWatchdogAgent) watchdogAgent.destroy();
    if (ownsCriticalContinuationAgent) criticalContinuationAgent.destroy();
    if (ownsCoordSendAgent) coordSendAgent.destroy();
    if (ownsImprovementsCaptureAgent) improvementsCaptureAgent.destroy();
  });
  return server;
}

/**
 * The upstream named in the startup log line. Must resolve through the same
 * option precedence as `resolveTargetCandidates` — the bin entry passes
 * `resolveTargets` (never `targetPort`), so reading `opts.targetPort` here
 * logged `127.0.0.1:undefined` (WI-10004334).
 */
export function describeMcpProxyTarget(opts: McpProxyOptions): string {
  if (!opts.resolveTargets && opts.resolveTarget)
    return "dynamic operator.json target";
  try {
    const [primary, ...fallbacks] = resolveTargetCandidates(opts).map(
      (t) => `${t.host}:${t.port}`,
    );
    return fallbacks.length
      ? `${primary} (fallback ${fallbacks.join(", ")})`
      : primary!;
  } catch (err) {
    return `unresolved target (${(err as Error).message})`;
  }
}

/** Start the proxy from env/opts. Returns the listening server. */
export function startMcpProxy(opts: McpProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[mcp-proxy] ${s}`));
  const server = createMcpProxy(opts);
  server.listen(opts.listenPort, opts.listenHost ?? "127.0.0.1", () => {
    log(
      `listening on ${opts.listenHost ?? "127.0.0.1"}:${opts.listenPort} → ${describeMcpProxyTarget(opts)} ` +
        `(retry-on-refused window ${opts.retryWindowMs}ms)`,
    );
  });
  return server;
}
