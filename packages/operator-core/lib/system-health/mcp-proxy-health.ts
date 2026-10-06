/**
 * system-health/mcp-proxy-health — read the resilient MCP proxy's failure ledger and
 * summarize the recent windowed failure counts for the Infra health panel
 * (backend-reliability-100pct-2026-07-03 W8 / P-008).
 *
 * WHY (the under-counting this closes): a connection-level MCP failure — a stale-socket
 * 400 (W1.3), a deploy-window refusal, a post-connect upstream error — NEVER creates a
 * `tool_invocations` row (it errors at the HTTP layer, BELOW tool dispatch). So the
 * agent-facing failure rate was invisible and "transient errors calling tools" felt
 * normal. The proxy now appends each such failure as a JSONL record
 * (apps/operator/lib/mcp-proxy/proxy.ts `recordProxyFailure`); THIS module reads them
 * back and turns them into a first-class SLO signal on the Infra panel: any sustained
 * HARD-failure count reds Infra → operator_degraded → the overall system light, so a
 * regression PAGES instead of being dismissed as "transient". (The status boundary lives
 * with the other SLOs in ./thresholds.ts — `infraStatus` + `MCP_PROXY_HARD_FAIL_CRIT`.)
 *
 * BOUNDED + fail-soft (perf + correctness floor):
 *  - the reader reads only the TAIL of the ledger (last READ_CAP_BYTES) via a positioned
 *    read, so a ledger that grows under a sustained regression never makes the health
 *    tick read an unbounded file (perf anti-pattern A-list: no full-file slurp);
 *  - an ABSENT ledger = no failures recorded yet = a healthy zero (`[]`), NOT an error;
 *  - a read/parse error yields `null` ⇒ the Infra panel greys THIS leg (never blanks);
 *  - the summarizer is PURE (no fs) so the window/classification logic unit-tests hermetically.
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpProxyHealth } from './types';
import { isCheapRepeatingBeat } from './mcp-proxy-beats';
import { MCP_PROXY_CRITICAL_CONTINUATION_WAIT_CRIT_MS } from './thresholds';

/** The ledger path — MUST match apps/operator/lib/mcp-proxy/proxy.ts `failureLogPath()`.
 *  Resolved per-call (not cached) so the env override is honoured at runtime + in tests. */
export function mcpProxyFailureLogPath(): string {
  return process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG || join(homedir(), '.papercusp', 'mcp-proxy-failures.jsonl');
}

/** Tail bytes read from the ledger — bounded regardless of total file size. 256KB holds
 *  far more than a 1h window's worth of records at any rate that isn't already a loud
 *  crit (a sustained >256KB/h failure stream reds the panel long before the tail clips). */
export const MCP_PROXY_READ_CAP_BYTES = 256 * 1024;

/** The default SLO lookback window (1h) — mirrors the dashboard's "this window". */
export const MCP_PROXY_WINDOW_MS = 60 * 60_000;

/** One parsed failure record (a superset of what `recordProxyFailure` writes). */
export interface McpProxyFailureRecord {
  ts: string;
  kind: string;
  status?: number;
  attempts?: number;
  connection?: string | null;
  method?: string;
  /** Bounded JSON-RPC protocol methods recorded by the proxy; never args/tool names. */
  rpcMethods?: string[];
  /** Proxy request identity; used to collapse periodic queue-wait samples per request. */
  traceId?: string;
  /** Current queue dwell in ms on `critical_continuation_queue_wait` records. */
  waitedMs?: number;
  path?: string;
  elapsedMs?: number;
  // P-006 instance tags — which proxy instance wrote this record (forensic attribution
  // across a shared ledger; multiple instances / a restart were previously indistinguishable).
  pid?: number;
  listenPort?: number;
  target?: string;
}

/**
 * EI-12102/EI-12211 root cause: the shared ledger is written by EVERY proxy instance on the
 * box, not just the one long-lived fleet-facing proxy (:9071) agents actually route through.
 * Forensic read of the live ledger (2026-07-15) found a recurring ~5-60min cadence of
 * `exhausted_refused`/`upstream_error` PAIRS against a bare `POST /api/mcp` (no `?client=…
 * &tools=…&role=…` — every real agent request carries that query string), each from a
 * DISTINCT, short-lived pid with `listenPort: 0` and a RANDOM high target port that changes
 * every time — the signature of a desktop-app sidecar's in-process fallback proxy
 * (host-bootstrap.ts / the Tauri sidecar's `serve.mjs`) racing its own companion Hono host's
 * startup on a fresh, ephemeral, per-launch port. `listenPort: 0` never happens for a REAL
 * listening instance (Node's `server.listen(0, …)` binds an OS-random port instead of the
 * configured one — no genuine deployment does this; only a mis-templated
 * `PAPERCUSP_MCP_PROXY_PORT=""` env produces it via `Number('') === 0`). The LIVE fleet-facing
 * proxy (a fixed, nonzero `listenPort`, e.g. 9071) recorded ZERO hard failures in the same
 * window — so this class of ledger row demonstrably never touched live agent traffic, yet was
 * inflating the "hard tool-call failures" SLO the infra-liveness alarm pages on.
 *
 * Exclude any record whose `listenPort` is falsy/zero from the alarm-relevant classes
 * (hardFailures / otherNon2xx / benign) — it did not come from an instance any client could
 * actually be routed through. Legacy pre-P-006 rows (no `listenPort` field at all) predate
 * this signature and are NOT excluded (kept counting as before) to avoid silently blinding the
 * SLO to genuine historical evidence; only an EXPLICIT `0` is the mis-launch signature.
 */
export function isNonInstanceRecord(r: Pick<McpProxyFailureRecord, 'listenPort'>): boolean {
  return r.listenPort === 0;
}

/**
 * P-006: a forwarded non-2xx that is BENIGN probe/heartbeat traffic, NOT an agent-facing
 * tool failure — so it must never count toward the SLO. The two measured classes:
 *  - a 408 Request Timeout (a keep-alive heartbeat the upstream let lapse), and
 *  - a GET that returns 405 Method Not Allowed (a liveness probe hitting the POST-only
 *    MCP endpoint) — a GET is never a tools/call write, so a GET 405 is pure probe noise.
 * Kept out of `hardFailures` AND `otherNon2xx` so the "genuine upstream 4xx/5xx" signal
 * stays clean and any alarm computed from it fires only on REAL classes.
 */
export function isBenignProbe(rec: Pick<McpProxyFailureRecord, 'status' | 'method'>): boolean {
  return rec.status === 408 || (rec.method === 'GET' && rec.status === 405);
}

/**
 * Read the TAIL of the JSONL ledger and return the parsed records (best-effort). A partial
 * leading line (the tail may start mid-record) is skipped; a malformed line is skipped.
 * Returns `[]` when the ledger is absent/empty (a healthy zero) and `null` on a genuine
 * read error (⇒ the collector greys the leg, fail-soft). Synchronous + bounded: at most
 * one statSync + one positioned readSync of ≤ capBytes — negligible on the health tick.
 */
export function readMcpProxyFailureTail(
  path: string = mcpProxyFailureLogPath(),
  capBytes: number = MCP_PROXY_READ_CAP_BYTES,
): McpProxyFailureRecord[] | null {
  let fd: number | undefined;
  try {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return []; // absent ledger ⇒ nothing has failed yet ⇒ healthy zero (not an error)
    }
    if (size === 0) return [];
    const start = Math.max(0, size - capBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // The tail likely begins mid-line — drop everything up to the first newline so we
      // only parse whole records.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const out: McpProxyFailureRecord[] = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s) as McpProxyFailureRecord;
        if (rec && typeof rec.ts === 'string' && typeof rec.kind === 'string') out.push(rec);
      } catch {
        /* skip a malformed / truncated line */
      }
    }
    return out;
  } catch {
    return null; // genuine read error ⇒ grey the leg (fail-soft)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** True when a forwarded non-2xx bears the W1.3 stale-socket-400 signature: HTTP 400 with
 *  `connection: close`. That is the exact shape :3070 returns when a forward lands on a
 *  half-closed pooled keep-alive socket — the ~13% bug P-010 fixed. Surfaced as a HARD
 *  failure so any regression of that class is instantly visible, never silently transient. */
export function isStaleSocket400(rec: Pick<McpProxyFailureRecord, 'status' | 'connection'>): boolean {
  return (
    rec.status === 400 &&
    typeof rec.connection === 'string' &&
    rec.connection.toLowerCase().includes('close')
  );
}

/**
 * True for terminal failures on a cheap repeating beat. The next beat is already scheduled,
 * so these misses are soft even when the proxy exhausted its short retry window. Intermediate
 * retry markers and successful recoveries stay in their existing classifications.
 */
export function isSoftBeatFailure(
  rec: Pick<McpProxyFailureRecord, 'kind' | 'path'>,
): boolean {
  return (
    typeof rec.path === 'string' &&
    isCheapRepeatingBeat(rec.path) &&
    (rec.kind === 'exhausted_refused' || rec.kind === 'upstream_error' || rec.kind === 'upstream_non2xx')
  );
}

/**
 * PURE: fold failure records into the windowed {@link McpProxyHealth} summary.
 *
 * Classification:
 *  - `recovered`                         → SOFT (proxy retried a refused upstream and
 *                                          succeeded; the agent saw success) → `recovered`.
 *  - `exhausted_refused` | `upstream_error` → HARD unless the record's path is a cheap repeating
 *                                          beat, in which case it is `softBeatFailures`.
 *  - `upstream_non2xx` + benign probe (408 heartbeat / GET-405) → `benign` (P-006, NOT a
 *                                          failure — kept out of every alarm class).
 *  - `upstream_non2xx` + stale-socket-400 signature → HARD (W1.3 regression).
 *  - `upstream_non2xx` otherwise         → `otherNon2xx` (a genuine upstream 4xx/5xx).
 *  - `handshake_timeout_retry` (WI-6740)  → `handshakeStalls`. NOT hard (the replay is the
 *                                          fix working) but first-class, because this is the
 *                                          leading indicator of the class that left agent
 *                                          sessions tool-dark for hours. See the field doc.
 *  - `shed_max_in_flight`                 → `shed`. Agent-facing 429, but admission control
 *                                          working; sustained nonzero = :3070 not draining.
 *  - `critical_continuation_queue_wait`   → distinct request count once `waitedMs` reaches
 *                                          the five-minute alarm floor; periodic samples are
 *                                          deduplicated by traceId. Short queue dwell stays quiet.
 *  - `post_connect_retry` (P-005 intermediate retry marker) → neither hard nor a failure;
 *                                          it only appears in `byKind` (the terminal
 *                                          outcome is separately recorded recovered/error).
 *
 * A kind that matches NO branch here survives only as a `byKind` tally — which means nothing
 * can alarm on it. That is not a neutral default: it is exactly how `handshake_timeout_retry`
 * stayed invisible. When `recordProxyFailure` gains an agent-affecting kind, give it a branch.
 *
 * Records outside `[now - windowMs, now + skew]` are ignored (a small future-skew guard
 * tolerates minor clock differences without admitting far-future garbage).
 */
export function summarizeMcpProxyHealth(
  records: readonly McpProxyFailureRecord[],
  nowMs: number,
  windowMs: number = MCP_PROXY_WINDOW_MS,
): McpProxyHealth {
  const SKEW_MS = 60_000;
  const byKind: Record<string, number> = {};
  let total = 0;
  let hardFailures = 0;
  let softBeatFailures = 0;
  let recovered = 0;
  let otherNon2xx = 0;
  let benign = 0;
  let nonInstance = 0;
  let handshakeStalls = 0;
  let shed = 0;
  let criticalContinuationQueueMaxWaitMs = 0;
  const sustainedCriticalContinuationTraces = new Set<string>();
  let unattributedSustainedCriticalContinuation = false;
  let newestAt: number | null = null;
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) continue;
    if (t < nowMs - windowMs || t > nowMs + SKEW_MS) continue;
    total += 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (newestAt === null || t > newestAt) newestAt = t;
    // EI-12102/EI-12211: a record from a non-instance (listenPort:0) source never touched
    // live agent traffic — count it for forensic visibility (byKind/nonInstance) but keep it
    // OUT of every alarm-relevant class below (see isNonInstanceRecord's doc for why).
    if (isNonInstanceRecord(r)) {
      nonInstance += 1;
      continue;
    }
    if (r.kind === 'critical_continuation_queue_wait' && typeof r.waitedMs === 'number' && Number.isFinite(r.waitedMs)) {
      criticalContinuationQueueMaxWaitMs = Math.max(criticalContinuationQueueMaxWaitMs, r.waitedMs);
      if (r.waitedMs >= MCP_PROXY_CRITICAL_CONTINUATION_WAIT_CRIT_MS) {
        if (typeof r.traceId === 'string' && r.traceId.length > 0) {
          sustainedCriticalContinuationTraces.add(r.traceId);
        } else {
          // Legacy rows without a trace identity contribute one bounded aggregate signal,
          // rather than turning periodic samples from one request into many incidents.
          unattributedSustainedCriticalContinuation = true;
        }
      }
    }
    if (isSoftBeatFailure(r)) {
      softBeatFailures += 1;
    } else if (r.kind === 'recovered') {
      recovered += 1;
    } else if (r.kind === 'handshake_timeout_retry') {
      // WI-6740 upstream silence on the control-plane handshake. Kept OUT of hardFailures on
      // purpose — the replay is the fix working — but given its own counter because this is
      // the leading indicator of the class that left sessions tool-dark for hours. Before this
      // branch existed it matched nothing here and survived only as a `byKind` tally, i.e. it
      // could not red the panel or page, which is the same "severity invisible to the observing
      // layer" failure WI-6740 itself documents. Verified live 2026-08-02: the fleet-facing
      // proxy (pid 2704092, listenPort 9071) writes these in production.
      handshakeStalls += 1;
    } else if (r.kind === 'shed_max_in_flight') {
      // EI-19305299022434394 admission control: agent-facing 429, but the bound working.
      shed += 1;
    } else if (r.kind === 'exhausted_refused' || r.kind === 'upstream_error') {
      hardFailures += 1;
    } else if (r.kind === 'upstream_non2xx') {
      // P-006: benign probe traffic (408 heartbeat / GET-405) is separated FIRST so it can
      // never inflate hardFailures or otherNon2xx — the SLO then alarms on real classes only.
      if (isBenignProbe(r)) benign += 1;
      else if (isStaleSocket400(r)) hardFailures += 1;
      else otherNon2xx += 1;
    }
  }
  return {
    windowMs, total, hardFailures, softBeatFailures, recovered, otherNon2xx, benign, nonInstance,
    handshakeStalls, shed,
    criticalContinuationQueueStalls:
      sustainedCriticalContinuationTraces.size + Number(unattributedSustainedCriticalContinuation),
    criticalContinuationQueueMaxWaitMs,
    byKind, newestAt,
  };
}
