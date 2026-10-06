/**
 * service-health — probe the local dev endpoints + detect up/down transitions
 * (plan fleet-coordination-painpoints, Phase 3b). Driven by the lightweight
 * in-process periodic scheduler; transitions broadcast to coord. External
 * liveness has no event source, so the probe is the one irreducible poll
 * (D-006) — but transition-only, never a per-tick firehose.
 *
 * `diffHealth` is pure (unit-tested); `probeAll` does the I/O.
 */

import { statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { probeDesktop } from './desktop-health';
import { listListeningSockets, type ListeningSocket } from './listening-sockets';
import {
  readProcessMemoryPressure,
  describeMemoryPressure,
  type ProcessMemoryPressure,
} from './process-memory-pressure';
import { operatorApiBase } from './operator-api-base';
import { emitServiceHealthTransitionEvent } from './service-health-events';
import {
  boundedPgReadTxn,
  PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS,
  PG_READ_TXN_DEFAULT_TIMEOUT_MS,
} from './pg-read-query';

export interface EndpointSpec {
  name: string;
  url: string;
  /** Per-endpoint probe timeout override (default 3000ms — see {@link probeEndpoint}). */
  timeoutMs?: number;
  /**
   * EI-2339: this endpoint is an ON-DEMAND dev-only layer with NO systemd unit
   * (spawned ad hoc by `bin/dev` / the desktop dev shell), not a persistent
   * service — being down is the NORMAL/expected state whenever no dev shell is
   * running, not an outage. When true, `probeEndpoint` reports a down result as
   * `present: false` (the same "legitimately absent, don't alert" contract
   * already used for the desktop/bg-host-ticker/substrate-sidecar probes) so
   * `diffHealth` never fires a transition and `collectServiceDownSignals` never
   * escalates it — it stays purely informational in `dev:service_health`.
   */
  onDemand?: boolean;
}

/**
 * The dev services worth watching (operator/vite/staging/oddsmith; the Tauri
 * desktop and other portless/opt-in services are probed separately in `probeAll`).
 *
 * NB: RETIRED surfaces are deliberately NOT monitored. None runs in this
 * deployment, so probing them produced a perpetual phantom "DOWN" signal that
 * the improvement watchdog re-captured every cycle AND re-broadcast on every
 * operator restart/deploy — a chronic false-alarm that trains agents/owner to
 * ignore service-health reds:
 *   - the standalone web app on :3001 (the retired "old Restart web app" — see
 *     `_retired/papercup`, "doesn't exist in this container") — removed per EI-188.
 *   - the Restart shop storefront on :4321 — not part of the running stack;
 *     removed per EI-276 (it fed the EI-187 CRITICAL "shop is down", re-announced
 *     on every boot). Verified down-because-absent, not a regression.
 *   - the standalone Restart Scout service on :3350 — `apps/scout-service` was
 *     deleted; Papercusp's Blender/Scout loop now runs in-process in bg-host.
 *     Keeping this endpoint produced a permanent connection-refused root cause
 *     for a service that cannot exist (WI-40135 / EI-21028583648509131).
 * Don't re-add a retired surface here.
 *
 * NB2 (EI-2339): `vite` (:3055) is kept in this list for VISIBILITY (a "not
 * currently running" row is still useful in `dev:service_health`) but is
 * `onDemand: true` — it is the Tauri desktop's on-demand dev content layer
 * (spawned ad hoc by `bin/dev`), has NO systemd unit, and is simply not
 * listening whenever no desktop dev shell is up, by design. Before EI-2339 a
 * down vite was treated exactly like a down persistent service and 24h-aged
 * into a CRITICAL escalation even though the live
 * product (:3070) was healthy — see `onDemand` on `EndpointSpec` for the fix.
 */
export const HEALTH_ENDPOINTS: EndpointSpec[] = [
  { name: 'operator', url: 'http://127.0.0.1:3070/api/desktop/version' }, // 200 + build-info SHA (P-011)
  // EI-6902: vite's dev-server request handler can legitimately take 4-6s+ to answer
  // under this box's typical concurrent build/vitest load (confirmed live: a plain
  // GET / took 5.4s to resolve while otherwise healthy) — the shared 3000ms default
  // was firing a persistent false "vite DOWN" alarm (aged 2 days, escalated to
  // critical) purely from probe impatience, not an actual outage. A generous
  // per-endpoint override here fixes the false positive without loosening the
  // timeout for the other (consistently fast, <100ms) endpoints. EI-2339: also
  // onDemand — vite has no systemd unit, so a genuinely-down probe (no dev shell
  // running at all) must never escalate either; see NB2 above.
  { name: 'vite', url: 'http://127.0.0.1:3055/', timeoutMs: 10_000, onDemand: true },
  // code-server probe removed (owner directive 2026-07-07): code-server is no
  // longer bundled or spawned, so :8082 was a permanent false-DOWN.
  //
  // WI-6146 / P-013 (D-010, plan bash-to-tool-substitution-2026-07-26): the
  // :3170 staging operator. CLAUDE.md tells every agent to verify a
  // server-side edit with `dev:restart { target:'staging' }` and then "probe
  // :3170" — but :3170 was not in this list, so the documented workflow had
  // NO tool form and 80 curl atoms went to bash for want of anywhere else to
  // ask. Same path as the `operator` entry above because it is the same
  // operator build on the staging port (verified live: 200 in ~2ms).
  //
  // NOT `onDemand`: unlike `vite`, this is a persistent systemd unit
  // (papercusp-staging-api, already in SUPERVISED_PROCESSES as 'staging-api'),
  // so a sustained down is a REAL signal and must still alarm. It is instead
  // flap-damped via DOWN_CONFIRM_TICKS, because `dev:restart` restarts it
  // several times a day by design — see STAGING_API_DOWN_CONFIRM_TICKS.
  // The name matches its SUPERVISED_PROCESSES entry so the probe and the
  // supervision row join, per this file's naming convention.
  { name: 'staging-api', url: 'http://127.0.0.1:3170/api/desktop/version' },
  // WI-6149 / P-013 (D-010 item 4): the oddsmith sidecar — the single
  // most-asked-about unprobed unit in the 7d corpus (73 `is-active` reads, plus
  // 28 of the 32 raw `systemctl --user restart` atoms, which is why
  // SERVICE_LIFECYCLE_WRITE_FINDING says the restart residue is "mostly a unit
  // the tool cannot name"). It is the ONLY one of item 4's candidates that is
  // structurally eligible — see NON_PROBED_UNITS below for the four measured
  // reasons the others are not.
  //
  // Eligible because it is PERSISTENT and has a FIXED port: `Type=simple`,
  // `Restart=always`, `UnitFileState=enabled`, and `ODDSMITH_HONO_PORT=46229`
  // is pinned in the unit file (verified: `systemctl --user cat`), so a
  // fixed-URL entry can express it. `/health` answers 200 in ~1.4ms.
  //
  // NOT `onDemand`: it is an enabled always-on unit, so a sustained down IS a
  // real signal — it runs a live trading engine (`TRADING_PAPER_MODE=false`).
  // Flap-damped instead, via DOWN_CONFIRM_TICKS — see
  // ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS for the measured restart rate.
  { name: 'oddsmith-sidecar', url: 'http://127.0.0.1:46229/health' },
];

/**
 * Resolve the runtime operator target for the default probe set.
 *
 * `HEALTH_ENDPOINTS` intentionally keeps the dev-box baseline visible and
 * stable, but packaged `serve.ts` binds the operator to a sticky loopback port
 * and exports that port through `operatorApiBase()` before importing this
 * module's periodic health tick. Using that canonical base at probe time keeps
 * the default operator probe on the actual packaged listener instead of the
 * baked :3070 fallback. Callers that provide explicit specs are returned
 * unchanged in value, so focused/custom probes retain their requested target.
 */
export function resolveHealthEndpoints(specs?: readonly EndpointSpec[]): EndpointSpec[] {
  // An explicitly supplied list is an opt-in test/custom surface. Preserve its
  // requested URLs even when it happens to contain an `operator`-named entry.
  if (specs !== undefined) return specs.map((spec) => ({ ...spec }));

  const operatorBase = operatorApiBase().replace(/\/+$/, '');
  const operatorUrl = `${operatorBase}/api/desktop/version`;
  return HEALTH_ENDPOINTS.map((spec) => (spec.name === 'operator' ? { ...spec, url: operatorUrl } : { ...spec }));
}

/**
 * WI-6149 (D-010 item 4): units agents DO shell out to `systemctl is-active`
 * for and that are deliberately NOT probed, each with the measurement that
 * settled it. Recorded as data, not prose, so a future agent re-reading the
 * corpus does not re-litigate a decision that was already made with evidence —
 * and so `service-health-unit-coverage.test.ts` can assert the exclusions still
 * hold rather than trusting a comment.
 *
 * The four reasons are STRUCTURAL, not preferences — each one is a different
 * way a unit cannot be represented in this registry at all:
 */
export const NON_PROBED_UNITS: Readonly<Record<string, { atoms: number; reason: string }>> = {
  // Name carries a per-run random suffix (`papercup-green-checkpoint-manual-1fxzuva`),
  // minted by release-checkpoint-launch's `systemd-run --unit=…`. A static
  // registry cannot name it, ever. The question ("is my manual checkpoint run
  // still going?") is run-scoped, not health-scoped — it belongs to a release
  // surface, not here.
  'papercup-green-checkpoint-manual-*': { atoms: 29, reason: 'transient-unit-name' },
  // `Type=oneshot` on an hourly timer: measured 17:00:16 → 17:02:48 = 152s
  // active per 3600s (4.2%), i.e. `inactive` IS the healthy state 96% of the
  // time. Liveness is the wrong question — 4 of its 13 atoms are `is-failed`,
  // asking for the last-run RESULT, which is already served by
  // papercup-backup-health.timer + STATUS.json + papercusp-db-backup-alert.
  'papercusp-db-backup': { atoms: 13, reason: 'episodic-oneshot' },
  // System-scope units, not `--user`. The reconciler execs `systemctl --user`
  // exclusively and `SupervisionLayer` has no `systemd-system` member, so
  // representing these needs a new layer + a second exec path. auditd has been
  // up since the Jul 10 boot with NRestarts=0; 1 atom does not justify it.
  // (NB pgbouncer is `Restart=no` — a real supervision gap, but the same
  // structural blocker applies; filed separately rather than half-fixed here.)
  auditd: { atoms: 1, reason: 'system-scope-unit' },
  pgbouncer: { atoms: 1, reason: 'system-scope-unit' },
  // NOT INSTALLED on this box: `systemctl show fail2ban.service` →
  // `LoadState=not-found`. Probing an absent unit is precisely the permanent
  // phantom-DOWN class the NB above records for :3001 and :4321 (EI-188 /
  // EI-276). Never add these.
  fail2ban: { atoms: 1, reason: 'unit-not-installed' },
  crowdsec: { atoms: 1, reason: 'unit-not-installed' },
};

export interface ProbeResult {
  name: string;
  up: boolean;
  status: number | null;
  latencyMs: number;
  /**
   * For services that may legitimately be ABSENT (the desktop — see
   * desktop-health.ts): false means "not running, don't alert". `diffHealth`
   * skips a result with `present === false`. HTTP endpoints leave it undefined
   * (always treated as present).
   */
  present?: boolean;
  /** Human-readable detail (which signal failed, recent error toasts, …). */
  note?: string;
  /** Desktop only: count of recent ERROR toasts (toastLog signal). */
  recentErrors?: number;
  /**
   * EI-13163: the exact address that was probed for this entry (e.g.
   * `http://127.0.0.1:3070/api/desktop/version`) — set for every HTTP-probed
   * endpoint (`probeEndpoint`, so `operator`/`vite`/`scout`/`embed-sidecar` all
   * carry it). Portless processes (desktop, bg-host-ticker, bg-host-code,
   * substrate-sidecar) have no HTTP address and leave this undefined. Before
   * this field existed, `dev:service_health` told you a service NAME was
   * up/down without ever exposing the URL that proved it, forcing an agent to
   * guess a port (or fall back to a raw datastore read) instead of reading the
   * canonical address straight off the probe result.
   */
  url?: string;
  /**
   * EI-19465075959589134 — WEDGED, which is NOT down. True when the HTTP probe
   * failed while the port still has a LISTENER whose accept queue is holding
   * connections the process never accepted. A blocked event loop defeats every
   * OTHER liveness signal simultaneously: the port is open, `systemctl
   * is-active` says active, the pid is alive, and even a TCP connect succeeds
   * (the kernel completes the handshake without the process). So a wedge used
   * to render BYTE-IDENTICALLY to "the service is down", and the two want
   * opposite responses — down means start it, wedged means something is
   * blocking the loop and a restart only buys time.
   *
   * Undefined = not determined (the listen table was unreadable, or the URL is
   * not a local port). Never read an absent `wedged` as "not wedged".
   */
  wedged?: boolean;
  /**
   * WI-1647443 — embed-sidecar only: did THIS probe actually reach the model,
   * or was it answered by the sidecar's LRU in front of it?
   *
   * `'yes'` = the response's per-request cache accounting proves every probe
   * text was inferred during this request. `'no'` = a usable vector came back
   * but it was served from the cache (or coalesced), so the ONNX worker was
   * NOT exercised and `latencyMs` is a cache-lookup time, not an embed time.
   * `'unknown'` = the sidecar is too old to report `cache` at all, or it
   * ignored the `bypassCache` request — the question is undecidable from this
   * response, which is deliberately NOT the same as `'no'`.
   *
   * Undefined = this probe is not the embed sidecar, or it never got as far as
   * a usable vector. Never read an absent value as `'yes'`.
   */
  embedModelExercised?: 'yes' | 'no' | 'unknown';
  /**
   * The listener's accept queue at probe time, when it could be read:
   * `pending` connections established-but-not-accepted, out of the `backlog`
   * limit. Carried on the result so a reader sees the EVIDENCE for `wedged`
   * rather than a bare verdict — and so a climbing queue across two probes is
   * visible without re-deriving it.
   */
  acceptQueue?: { pending: number; backlog: number };
  /**
   * WI-7329 — per-process memory pressure for the listener that failed this
   * probe, when its pid was readable. Answers the question every other signal
   * here leaves open: is this a CODE BUG, or is the process swap-thrashing?
   *
   * A Node event loop stalled on major page faults is byte-identical to a hot
   * synchronous loop across every other signal (high CPU, full accept queue,
   * live pid, `is-active` green, TCP connect succeeding), so `wedged` alone
   * points a reader at "find the blocking code" even when the real cause is
   * that the box is out of memory. Measured 2026-08-03: the :3270 sidecar had
   * 9.5 GB swapped against 4.2 GB resident and was major-faulting continuously
   * — the busy-loop hypothesis was wrong and cost several manual `/proc` reads
   * to disprove (EI-19406226890070872).
   *
   * STRICTLY DIAGNOSTIC. It never sets or clears `up`/`wedged`/`present` and
   * never originates a transition; it only explains a failure already detected.
   *
   * Undefined = not sampled (no listener pid, non-Linux host, or `/proc`
   * unreadable). Never read an absent value as "memory is fine" — and note the
   * booleans inside are false-when-undetermined for the same reason.
   */
  memoryPressure?: ProcessMemoryPressure;
  /**
   * Provenance for a code-drift verdict. The mtime leg remains a useful
   * fallback for legacy/unbundled processes, but it must not be rendered as
   * equivalent to a build identity carried by the process that actually
   * loaded the code (EI-21647996938145436).
   */
  provenance?: {
    source: 'runtime-vintage' | 'mtime-fallback';
    loadedSha?: string | null;
    expectedSha?: string | null;
    loadedPid?: number | null;
    loadedReportedAt?: string | null;
    reason?: string;
  };
}

/** A build identity joined to the process that produced the drift verdict. */
export interface LoadedCodeIdentity {
  source: 'runtime-vintage';
  treeSha: string | null;
  bundleVersion?: string | null;
  pid?: number | null;
  host?: string | null;
  reportedAt?: string | null;
}

/** Minimal async exec shape used by the committed hot-path identity check. */
export type CodeDriftExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

/**
 * EI-21392098254217280 — `/api/health` and `/api/desktop/version` only prove
 * that the listener can answer a cheap GET. They do not prove that the MCP
 * control plane can accept a session initialize while the operator is under
 * CPU pressure. Keep this probe separate from `HEALTH_ENDPOINTS`: it is an
 * on-demand diagnostic used by `dev:service_health`, not another periodic
 * down-transition source that could amplify the incident it is measuring.
 */
export const MCP_HANDSHAKE_PROBE_TIMEOUT_MS = 2_000;
export const MCP_HEALTH_PROBE_CLIENT = 'mcp-health';

export interface McpHandshakeProbeResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  protocolVersion?: string;
  url: string;
  note?: string;
}

type McpFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Parse either a JSON MCP response or the SSE `data:` envelope. Pure + tested. */
export function parseMcpHandshakePayload(body: string): Record<string, unknown> | null {
  const candidates = [body.trim()];
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  candidates.push(...dataLines.reverse());
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next SSE/JSON candidate. A malformed response is reported as
      // an unknown handshake, never as a successful cheap health check.
    }
  }
  return null;
}

/**
 * Perform a bounded MCP `initialize` round-trip against the local operator.
 * This is intentionally fail-closed for the handshake itself: a 200 GET does
 * not make `ok` true when the initialize response is missing, malformed, or a
 * JSON-RPC error. The timeout is independent of the ordinary service probe
 * budget so a wedged control plane produces a quick, named verdict.
 */
export async function probeMcpHandshake(
  baseUrl: string = operatorApiBase(),
  timeoutMs: number = MCP_HANDSHAKE_PROBE_TIMEOUT_MS,
  fetchFn: McpFetch = fetch,
  now: () => number = Date.now,
): Promise<McpHandshakeProbeResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/mcp?client=${encodeURIComponent(MCP_HEALTH_PROBE_CLIENT)}`;
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const latency = () => Math.max(0, now() - startedAt);
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mcp-health',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'papercusp-health-probe', version: '1.0' },
        },
      }),
    });
    const body = await response.text();
    const payload = parseMcpHandshakePayload(body);
    const result = payload?.result;
    const error = payload?.error;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs: latency(),
        url,
        note: `MCP initialize returned HTTP ${response.status}`,
      };
    }
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      return {
        ok: false,
        status: response.status,
        latencyMs: latency(),
        url,
        note: `MCP initialize returned a JSON-RPC error${typeof message === 'string' ? `: ${message}` : ''}`,
      };
    }
    const protocolVersion =
      result && typeof result === 'object' && typeof (result as { protocolVersion?: unknown }).protocolVersion === 'string'
        ? (result as { protocolVersion: string }).protocolVersion
        : undefined;
    if (!protocolVersion) {
      return {
        ok: false,
        status: response.status,
        latencyMs: latency(),
        url,
        note: 'MCP initialize returned HTTP success without a protocolVersion result',
      };
    }
    return { ok: true, status: response.status, protocolVersion, latencyMs: latency(), url };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      latencyMs: latency(),
      url,
      note: timedOut
        ? `MCP initialize timed out after ${timeoutMs}ms`
        : `MCP initialize probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * EI-7462: fast TCP-level preflight budget, separate from the (per-endpoint,
 * up to 10s for vite — EI-6902) HTTP response budget. A dead/wedged listener
 * (nothing bound to the port, or its accept queue/backlog is stuck) fails a
 * raw connect fast; only a *live* listener that then answers HTTP slowly gets
 * the generous response budget. Kept short + fixed (not derived from the
 * endpoint's own timeoutMs) because a real localhost handshake completes in
 * low single-digit ms — 400ms is already generous slack for a connect that
 * will actually succeed, so genuinely down/wedged never has to wait out the
 * full response timeout.
 */
export const CONNECT_PREFLIGHT_MS = 400;

type NetConnect = typeof netConnect;

/**
 * Tri-state preflight verdict (EI-18748002829224393 — see the doc comment on
 * `tcpPreflight` below for why 'refused' and 'indeterminate' must NOT be
 * collapsed into one boolean "down").
 */
export type TcpPreflightResult = 'connected' | 'refused' | 'indeterminate';

/**
 * Raw TCP connect check. Resolves:
 *  - 'connected'    — the handshake completed within `timeoutMs`.
 *  - 'refused'      — the OS itself refused the connection (ECONNREFUSED or any
 *                      other socket `error` event). This is DETERMINATE: an
 *                      instant, real signal regardless of how busy this
 *                      process's event loop is — nothing is listening.
 *  - 'indeterminate' — the fixed `timeoutMs` budget expired with NEITHER
 *                      `connect` nor `error` ever firing. EI-18748002829224393:
 *                      this does NOT mean the listener is down. `setTimeout`
 *                      measures event-loop-serviced time, not network time —
 *                      on a cold/loaded process the connect callback can be
 *                      queued but never serviced before the timer fires, even
 *                      though the OS-level handshake itself completed in
 *                      single-digit ms. Reproduced deterministically: the
 *                      FIRST `probeAll` in a cold process reported every HTTP
 *                      endpoint's preflight timing out (~1.1s, identical
 *                      across all five — one shared event-loop stall, not five
 *                      independent network failures), while a solo probe of
 *                      the SAME endpoint under the SAME load succeeded in
 *                      ~60ms. A genuinely wedged listener (stuck accept
 *                      backlog) is indistinguishable from loop lag at this
 *                      layer alone, so this case must be resolved by falling
 *                      through to the real HTTP fetch (see `probeEndpoint`),
 *                      not reported as down here.
 *
 * `connectFn` is injectable for tests; production callers use the real
 * `node:net` connect.
 */
export function tcpPreflight(url: string, timeoutMs = CONNECT_PREFLIGHT_MS, connectFn: NetConnect = netConnect): Promise<TcpPreflightResult> {
  let host: string;
  let port: number;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    // Unparseable URL (shouldn't happen for our fixed HEALTH_ENDPOINTS list) —
    // never let a preflight bug block the real probe; fall through as reachable.
    return Promise.resolve('connected');
  }
  return new Promise((resolve) => {
    let settled = false;
    const socket = connectFn({ host, port });
    const finish = (result: TcpPreflightResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners?.('connect');
      socket.removeAllListeners?.('error');
      socket.destroy?.();
      resolve(result);
    };
    const timer = setTimeout(() => finish('indeterminate'), timeoutMs);
    socket.once('connect', () => finish('connected'));
    socket.once('error', () => finish('refused'));
  });
}

/**
 * EI-19465075959589134. Decide, from the listen table, whether a FAILED HTTP
 * probe is a wedge rather than an outage. Pure — the reader is injected — so the
 * verdict is unit-testable without an `ss` on the box.
 *
 * `null` means UNDETERMINED (no listener rows, unreadable table, non-local URL),
 * which callers must not collapse into "healthy" or "not wedged": the whole
 * defect being fixed is two different states rendering identically.
 */
export function classifyListenerWedge(
  sockets: ListeningSocket[] | null,
): { wedged: boolean; pending: number; backlog: number } | null {
  if (!sockets || sockets.length === 0) return null;
  const pending = sockets.reduce((n, s) => n + (s.acceptQueue?.pending ?? 0), 0);
  const backlog = sockets.reduce((n, s) => Math.max(n, s.acceptQueue?.backlog ?? 0), 0);
  // A listener exists (so this is NOT "nothing is bound") and the kernel is
  // holding connections it never accepted. Threshold is >0 rather than a rate:
  // this only runs on the FAILURE path, where a request that should have been
  // served is provably sitting unaccepted. A healthy server drains to 0 between
  // probes; one that cannot is exactly the condition worth naming.
  return { wedged: pending > 0, pending, backlog };
}

/** Local-loopback port for a probe URL, or null when the URL is not one. */
export function localProbePort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) return null;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

type ListenTableReader = (opts: { port: number }) => Promise<{ sockets: ListeningSocket[] }>;

/**
 * Read the accept queue for a failed probe's port. FAIL-SOFT by construction: an
 * absent/erroring `ss` returns null (undetermined), never a false verdict — a
 * diagnostic that can itself break the health probe it rides on would be the
 * same class of bug this whole item is about.
 */
export async function detectWedgedListener(
  url: string,
  read: ListenTableReader = listListeningSockets,
): Promise<{ wedged: boolean; pending: number; backlog: number; pid: number | null } | null> {
  const port = localProbePort(url);
  if (port === null) return null;
  try {
    const { sockets } = await read({ port });
    const verdict = classifyListenerWedge(sockets);
    if (!verdict) return null;
    // WI-7329: carry the owning pid alongside the wedge verdict. The listen
    // table was already read to reach this verdict, so the pid is free here and
    // would otherwise cost a second lookup at the only moment it is wanted.
    // `classifyListenerWedge` stays a pure 3-field verdict on purpose — it
    // answers "is this wedged", not "who owns it".
    return { ...verdict, pid: firstListenerPid(sockets) };
  } catch {
    return null;
  }
}

/**
 * The representative owning pid for a set of listening sockets, or null when no
 * row exposed one (a listener owned by another uid reports `pid: null` rather
 * than being omitted — "not readable by us", never "unowned").
 */
function firstListenerPid(sockets: ListeningSocket[] | null): number | null {
  if (!sockets) return null;
  for (const s of sockets) {
    if (typeof s.pid === 'number' && s.pid > 0) return s.pid;
    const fromList = s.pids?.find((p) => typeof p === 'number' && p > 0);
    if (fromList !== undefined) return fromList;
  }
  return null;
}

export async function probeEndpoint(
  spec: EndpointSpec,
  timeoutMs = spec.timeoutMs ?? 3000,
  /** Injectable ONLY so the wedge verdict is testable without wedging a real server. */
  readListenTable: ListenTableReader = listListeningSockets,
  /**
   * Injectable ONLY so the WI-7329 memory-pressure leg is testable without a
   * real swap-thrashing process. Defaults to the real `/proc` sampler, which is
   * fail-soft and Linux-only and returns null everywhere else.
   */
  sampleMemory: (pid: number) => Promise<ProcessMemoryPressure | null> = readProcessMemoryPressure,
): Promise<ProbeResult> {
  const start = Date.now();
  // EI-2339: an onDemand endpoint (no systemd unit, spawned ad hoc) being down
  // is the expected/normal state, not an outage — mark it present:false so
  // diffHealth/collectServiceDownSignals never alert or escalate it, while the
  // raw up:false result still flows through to dev:service_health for visibility.
  // EI-13163: stamp the probed URL on every branch so a `dev:service_health`
  // reader gets the canonical address alongside the up/down verdict, instead
  // of having to already know (or guess) which port a service name maps to.
  const markIfOnDemand = (r: ProbeResult): ProbeResult =>
    !r.up && spec.onDemand
      ? { ...r, present: false, note: r.note ? `${r.note} (on-demand dev layer, not currently running)` : 'on-demand dev layer, not currently running' }
      : r;
  const preflight = await tcpPreflight(spec.url);
  if (preflight === 'refused') {
    // Fails fast (≤ CONNECT_PREFLIGHT_MS) instead of waiting out the full
    // (possibly 10s) response budget for a port that isn't even accepting.
    // This branch is unaffected by EI-18748002829224393: an OS-level refusal
    // is determinate and instant regardless of event-loop load.
    return markIfOnDemand({
      name: spec.name,
      up: false,
      status: null,
      latencyMs: Date.now() - start,
      url: spec.url,
      note: `connection refused at TCP preflight (≤${CONNECT_PREFLIGHT_MS}ms) — nothing is listening`,
    });
  }
  // EI-18748002829224393: an 'indeterminate' preflight (the fixed budget
  // expired without `connect`/`error` ever firing) is deliberately NOT
  // reported as down here — see tcpPreflight's doc comment. Fall through to
  // the real HTTP fetch either way ('connected' or 'indeterminate'): a
  // healthy listener whose preflight was merely loop-lagged now correctly
  // resolves up via the fetch; a GENUINELY wedged listener still ends up
  // reported down below (its own connect fails there too) — just via the
  // slower response-budget path instead of the fast preflight short-circuit.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(spec.url, { method: 'GET', signal: ctl.signal });
    // < 500 = "up" (a 401/404 still means the server is answering); 5xx = down.
    return markIfOnDemand({ name: spec.name, up: res.status < 500, status: res.status, latencyMs: Date.now() - start, url: spec.url });
  } catch {
    // EI-19465075959589134: the fetch failed — but is anything still LISTENING
    // with connections it never accepted? That separates WEDGED (a live process
    // with a blocked event loop) from DOWN, which every other signal here
    // reports identically. Undetermined stays undetermined.
    // Capture the failure latency BEFORE any diagnostics run. Everything below
    // (the listen-table read, and WI-7329's ~500ms memory sample) is our own
    // instrumentation, and folding it into the reported latency would let a
    // diagnostic corrupt the very measurement it is attached to.
    const failureLatencyMs = Date.now() - start;
    const wedge = await detectWedgedListener(spec.url, readListenTable);
    // WI-7329: a listener exists but the probe still failed — the one moment
    // "code bug vs. swap-thrash" is worth the ~500ms to answer. Skipped entirely
    // when no pid was readable (nothing listening, or another uid owns it), so
    // an ordinary connection-refused failure pays nothing.
    // `.catch` is NOT redundant with the sampler's own internal fail-soft: this
    // guards the SEAM. The default reader swallows its own /proc errors, but an
    // injected sampler (or a failure in the dynamic `node:fs/promises` import
    // before that try/catch is reached) would otherwise propagate out of here
    // and take down the health probe — a diagnostic breaking the probe it rides
    // on is the same class of defect as the bug it diagnoses. Caught by this
    // module's own fail-soft test, which failed before this line existed.
    const memoryPressure =
      wedge?.pid != null
        ? ((await sampleMemory(wedge.pid).catch(() => null)) ?? undefined)
        : undefined;
    const memoryNote = describeMemoryPressure(memoryPressure ?? null) ?? undefined;
    const preflightNote = preflight === 'indeterminate'
      ? `TCP preflight was indeterminate (timer expired under load, not a refused connection) and the follow-up HTTP fetch then also failed — likely a genuinely down/wedged listener, not event-loop lag`
      : undefined;
    const wedgeNote = wedge?.wedged
      ? `WEDGED, not down: a process is still listening on this port but has ${wedge.pending} connection(s) queued unaccepted (backlog ${wedge.backlog}) — its event loop is blocked, so systemd/is-active, a live pid and a TCP connect all still look healthy. A restart clears the symptom only; find what is blocking the loop.`
      : undefined;
    return markIfOnDemand({
      name: spec.name,
      up: false,
      status: null,
      latencyMs: failureLatencyMs,
      url: spec.url,
      wedged: wedge?.wedged,
      acceptQueue: wedge ? { pending: wedge.pending, backlog: wedge.backlog } : undefined,
      memoryPressure,
      // Surface WHY the preflight didn't fast-fail this result, for the
      // diagnostic signature the bug report names: "TCP preflight timed out,
      // then the real fetch also failed" is a genuinely down/wedged listener;
      // an omitted note here (preflight === 'connected') is the plain fetch-
      // failed case unchanged from before.
      // WI-7329: the memory note goes LAST and is additive. It never replaces
      // the wedge note — the accept queue is still the evidence that this is a
      // wedge — it appends the alternative explanation for WHY the loop stalled,
      // because the wedge note's own advice ("find what is blocking the loop")
      // sends the reader hunting application code that may be blameless.
      note: [wedgeNote, preflightNote, memoryNote].filter(Boolean).join(' ') || undefined,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * EI-1832: liveness of the papercusp-bg-host DBOS TICKER — a SEPARATE service from
 * the :3070 operator. The ticker drives git-sync + every scheduled routine; when it
 * freezes (event-loop starvation), :3070 stays up while the whole commit/deploy
 * pipeline silently halts. On 2026-06-20 that froze the fleet ~48m, and the only
 * agent-visible signal (dev:service_health → ":3070 up") MISLED the diagnosis toward
 * a wrong `dev:restart` of the operator. The signal: the ticker fires routines, so the
 * NEWEST `last_fired_at` across active routines IS the last-tick age — if nothing has
 * fired in this window, the ticker is frozen. Generous so a normally-firing fleet
 * (git-sync alone fires every few minutes) never false-alarms, while a real freeze
 * (tens of minutes) trips it. Isolates "ticker frozen (ALL routines stop)" from "one
 * routine stuck" — the latter is git-pipeline-stats / the green-stall-watchdog.
 */
export const BG_HOST_STALE_MS = 15 * 60_000;

/**
 * The probe names emitted WITHOUT an `EndpointSpec` — the "portless" probes.
 * `HEALTH_ENDPOINTS` enumerates every fixed-URL probe, so it is the natural
 * answer to "is this a real probe target?"; these names are the rest of that
 * answer, and nothing else enumerated them.
 *
 * LOAD-BEARING, not a doc list: the emitters below name themselves FROM this
 * constant, so it cannot drift from what is actually emitted. That is the whole
 * point — `DOWN_CONFIRM_TICKS`'s "no damping a name nothing emits" guard needs
 * `HEALTH_ENDPOINTS ∪ PORTLESS_PROBE_NAMES` to be the true set of probe names,
 * and a hand-maintained second list would rot exactly the way the bare
 * `'desktop'` literal it replaces did (EI-19375157952766991: damping
 * `bg-host-ticker` — a real, long-standing portless probe — reddened the fleet
 * gate, because the guard's model of "real probe" was HEALTH_ENDPOINTS plus one
 * hardcoded portless name).
 *
 * `desktop` is the one entry no emitter here can own: it is produced by the
 * Tauri desktop probe outside this module. It is listed because the guard needs
 * the complete set, and is the reason this is a name TABLE rather than a set
 * derived from the emitters themselves.
 */
export const PORTLESS_PROBE_NAMES = {
  /** Emitted by the desktop-shell probe, outside this module. */
  desktop: 'desktop',
  bgHostTicker: 'bg-host-ticker',
  bgHostCode: 'bg-host-code',
  mcpProxyCode: 'mcp-proxy-code',
  substrateSidecar: 'substrate-sidecar',
  embedSidecar: 'embed-sidecar',
  /** See {@link probeJournalCanary} (EI-15810, EI-2434 follow-up). */
  journalCanary: 'journal-canary',
} as const;

/** Flat lookup for "is this name a portless probe target?" */
export const PORTLESS_PROBE_NAME_SET: ReadonlySet<string> = new Set<string>(
  Object.values(PORTLESS_PROBE_NAMES),
);

/**
 * The health probe must fit inside the interactive query-embedding budget.
 * A successful /healthz response only proves that the sidecar's HTTP listener
 * is alive; it does not prove that the model worker can accept an embed. Keep
 * the functional request deliberately tiny and bounded so a saturated worker
 * cannot stall the service-health tick.
 */
export const EMBED_SIDECAR_FUNCTIONAL_PROBE_TIMEOUT_MS = 1_200;
const EMBED_SIDECAR_FUNCTIONAL_PROBE_TEXT = 'health probe';

/**
 * WI-1647443 — the probe text is a CONSTANT, and the sidecar caches on
 * `${model}:${kind}\0${text}`. So the first probe after a sidecar boot infers
 * and every probe after that is an LRU hit whose recency is refreshed on the
 * way out, meaning the entry can never age out of the 1024-entry LRU while the
 * probe keeps running. A dead ONNX worker therefore passed the *functional*
 * probe indefinitely: HTTP and the cache were alive, and the one thing this
 * probe exists to certify was never touched.
 *
 * The repair has two halves, and it needs both:
 *
 * 1. **Duty-cycled real inference** — at most once per this interval, a probe
 *    sends `bypassCache: true` (EI-19323982006772080) so the model actually
 *    runs. That bounds how long a dead worker can hide to one interval, at a
 *    cost of ~one short embed per interval per host rather than one per ~30s
 *    tick. The back-off clock advances ONLY on PROVEN inference (see
 *    `probeEmbedSidecar`), so a failing or unprovable exercise re-tries on the
 *    very next tick instead of flapping up/down across the interval.
 * 2. **Stating the population on every probe** — the note and
 *    `embedModelExercised` say which of the two happened, so a cached probe is
 *    a *stated* non-measurement rather than a silent false green, and the
 *    reported `latencyMs` is never read as an embed time when it is a cache
 *    lookup.
 *
 * A rotating probe text was the third candidate and was rejected: bucketing by
 * time dedupes across every host sharing one sidecar, so a host taking an LRU
 * hit cannot tell whether the entry was written a second or a bucket ago — no
 * single host ever gets a bounded verdict of its own, which is the whole point
 * of a per-host health probe.
 */
export const EMBED_SIDECAR_EXERCISE_INTERVAL_MS = 5 * 60_000;

/**
 * Budget for a probe that deliberately bypasses the cache. A cached probe
 * answers in ~2ms; a real gemma query embed measured ~170ms/doc on an idle
 * sidecar (EI-19323982006772080) and queues behind other work on the sidecar's
 * single FIFO, so the 1.2s interactive budget above would turn ordinary queue
 * pressure into a phantom DOWN. Failing to embed one short query inside THIS
 * budget is still a real outage for a service whose contract is interactive
 * embedding, so it stays a DOWN — the note names the exercising mode so
 * triage isn't sent looking for an HTTP fault.
 */
export const EMBED_SIDECAR_EXERCISE_PROBE_TIMEOUT_MS = 6_000;

/**
 * Should THIS probe force a real inference? Pure so the duty cycle is testable
 * without touching the module clock. `lastProvenMs === null` (nothing has been
 * proven yet — fresh process) always exercises: the first probe of a process
 * is exactly when "does this sidecar embed at all?" is unanswered.
 */
export function embedSidecarProbeShouldExercise(
  nowMs: number,
  lastProvenMs: number | null,
  intervalMs: number = EMBED_SIDECAR_EXERCISE_INTERVAL_MS,
): boolean {
  if (lastProvenMs === null) return true;
  return nowMs - lastProvenMs >= intervalMs;
}

/**
 * When this host last obtained PROOF (`cache.inferred === texts.length`) that
 * the sidecar's model ran. Plain module state, matching `downStreaks` /
 * `lastHealth` below; a split module record would at worst exercise once per
 * interval per record, which errs toward measuring more often, never less.
 */
let lastEmbedSidecarProvenInferenceMs: number | null = null;

/** Test seam: forget the duty-cycle back-off so a case starts from a fresh process. */
export function __resetEmbedSidecarExerciseClockForTests(): void {
  lastEmbedSidecarProvenInferenceMs = null;
}

function toMs(v: Date | string | number | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure verdict for the bg-host ticker, from the newest routine `last_fired_at`
 * (ms, or null = no routine has fired) + `now`. Unit-tested like `diffHealth`.
 * `lastFiredMs == null` ⇒ liveness UNKNOWN (present:false, never alarm a fresh/idle
 * install). A fresh tick ⇒ up; an age past `staleAfterMs` ⇒ down with a note that
 * names the bg-host (NOT :3070) so the reader doesn't restart the wrong service.
 */
export function evaluateBgHostTicker(
  lastFiredMs: number | null,
  now: number,
  staleAfterMs: number = BG_HOST_STALE_MS,
): ProbeResult {
  const name = PORTLESS_PROBE_NAMES.bgHostTicker;
  if (lastFiredMs == null) {
    return { name, up: true, status: null, latencyMs: 0, present: false, note: 'no routine has fired — ticker liveness unknown' };
  }
  const ageMs = Math.max(0, now - lastFiredMs);
  const up = ageMs <= staleAfterMs;
  const ageMin = Math.round(ageMs / 60_000);
  const ageSec = Math.round(ageMs / 1000);
  return {
    name,
    up,
    status: null,
    latencyMs: 0,
    note: up
      ? `last routine tick ${ageSec}s ago — papercusp-bg-host DBOS ticker alive`
      : `⚠ no routine has fired in ${ageMin}m — the SEPARATE papercusp-bg-host DBOS ticker ` +
        `(git-sync + every scheduled routine) looks FROZEN. This is NOT the :3070 operator; ` +
        `do NOT dev:restart the operator. Revive the bg-host ticker (service-restart lane).`,
  };
}

/**
 * WI-1867: the routine hot paths — code that changes ROUTINE BEHAVIOR and therefore
 * only takes effect on the bg-host after a `papercusp-bg-host.service` restart. When
 * the newest commit touching one of these is YOUNGER than the bg-host process, the
 * routines primary is running STALE code: every loop fire / scheduled routine / wake
 * emit behaves as-of its boot, however green the tree. This is exactly how the
 * 2026-07-03 cold-auto bug hid — flag ON, code landed 08:46, bg-host up since 07:37,
 * so every cold loop fire went out payload-less (warm) with zero error anywhere.
 */
export const BG_HOST_HOT_PATHS = [
  'packages/operator-core/lib/dbos',
  'packages/operator-core/lib/harness/routines',
  'packages/operator-core/lib/harness/git-sync',
  'packages/operator-core/lib/events',
  'packages/operator-core/lib/agent-tools/loop',
  'packages/operator-core/lib/red-queen',
  'packages/operator-core/lib/release/routine-engine-liveness.ts',
] as const;

export const BG_HOST_ARTIFACT_PATHS = ['apps/operator/dist-host/hono-host.mjs'] as const;

/**
 * The code the :9071 MCP proxy tsx-loads at import (EI-21390665295968159). The unit is
 * `ExecStart=npx tsx bin/mcp-proxy.ts` against the WORKING TREE with no file-watch, so it
 * has the identical stale-code property as the bg-host above: a landed proxy fix does
 * nothing until the unit is restarted, and NOTHING made that visible.
 *
 * This is not hypothetical. On 2026-08-25 the proxy booted 04:08Z, a peer landed the
 * bounded FIFO handshake-admission queue at 04:27Z (swept into da8ae3d8 at 04:49Z), and
 * the live proxy went on shedding under the PRE-fix path for hours — still emitting the
 * `shed_handshake_bulkhead` telemetry kind that by then existed in no file in the tree.
 * Three separate agents filed three separate bugs against the SYMPTOMS
 * (EI-21390665295968159, EI-21394957999406125, EI-21394957105776098) because the stale
 * process was invisible. That is the cost this probe exists to remove.
 */
export const MCP_PROXY_HOT_PATHS = [
  'apps/operator/lib/mcp-proxy',
  'apps/operator/bin/mcp-proxy.ts',
] as const;

/**
 * Pure verdict for bg-host CODE DRIFT (WI-1867), from the bg-host process start (ms)
 * + the newest hot-path ON-DISK CHANGE (ms; the bg-host tsx-loads the WORKING TREE at
 * import, so file mtime — not commit time — is the honest "what code would a restart
 * load" signal). Unknown inputs ⇒ present:false (fail-soft, never a fabricated
 * verdict). Drift is reported `up:true` — the service WORKS, it just behaves as-of an
 * older snapshot — so it never fires a down-transition alarm or nudges an auto-restart
 * (EI-2186: a bg-host restart reclaims in-flight spawns; the restart is a HUMAN/agent
 * decision, this is the loud signal that it's due).
 */
export function evaluateBgHostCodeDrift(
  bootMs: number | null,
  hotChangeMs: number | null,
  newestFile?: string | null,
  loadedIdentity?: LoadedCodeIdentity | null,
  currentSourceSha?: string | null,
  sourceChangedSinceLoaded?: boolean | null,
): ProbeResult {
  return evaluateCodeDrift(PORTLESS_PROBE_NAMES.bgHostCode, bootMs, hotChangeMs, newestFile, {
    unknown: 'bg-host code-drift unknown (boot time or hot-path change time unreadable)',
    current: 'bg-host code current (no routine hot-path change on disk since its boot)',
    drift: (behindMin, which) =>
      `⚠ bg-host CODE DRIFT: routine hot-path code changed on disk${which} ~${behindMin}m AFTER papercusp-bg-host booted — ` +
      `loop fires / scheduled routines / wake emits are running STALE code until ` +
      `\`systemctl --user restart papercusp-bg-host.service\`. If you just landed routine-behavior code and it ` +
      `"doesn't take effect", this is why (see agent-insights/bg-host-runs-stale-routine-code).`,
    identityCurrent: (loadedSha, expectedSha) =>
      `bg-host code current (loaded build ${loadedSha} from runtime-vintage matches current hot-path source at ${expectedSha}; ` +
      `mtime is only a fallback signal)`,
    identityDrift: (loadedSha, expectedSha, identity) =>
      `⚠ bg-host CODE DRIFT: loaded build ${loadedSha} from ${identityLabel(identity)} differs from current source ${expectedSha} — ` +
      `scheduled loop fires / routines / wake emits are running STALE code until ` +
      `\`systemctl --user restart papercusp-bg-host.service\`.`,
  }, loadedIdentity, currentSourceSha, sourceChangedSinceLoaded);
}

/**
 * Pure verdict for :9071 MCP-PROXY CODE DRIFT (EI-21390665295968159), same inputs and
 * same fail-soft contract as {@link evaluateBgHostCodeDrift}. Drift is reported `up:true`
 * on purpose: the proxy is SERVING — it is just serving as-of an older snapshot — so this
 * never fires a down-transition alarm or nudges an auto-restart. Restarting the proxy
 * severs every in-flight agent MCP call, so it stays a human/agent decision; this is only
 * the loud signal that it is due.
 */
export function evaluateMcpProxyCodeDrift(
  bootMs: number | null,
  hotChangeMs: number | null,
  newestFile?: string | null,
  loadedIdentity?: LoadedCodeIdentity | null,
  currentSourceSha?: string | null,
  sourceChangedSinceLoaded?: boolean | null,
): ProbeResult {
  return evaluateCodeDrift(PORTLESS_PROBE_NAMES.mcpProxyCode, bootMs, hotChangeMs, newestFile, {
    unknown: 'mcp-proxy code-drift unknown (boot time or hot-path change time unreadable)',
    current: 'mcp-proxy code current (no proxy hot-path change on disk since its boot)',
    drift: (behindMin, which) =>
      `⚠ mcp-proxy CODE DRIFT: :9071 proxy code changed on disk${which} ~${behindMin}m AFTER papercup-mcp-proxy booted — ` +
      `the proxy tsx-loads the working tree with NO file-watch, so admission control / handshake ` +
      `bulkhead / retry behaviour is running STALE code until ` +
      `\`systemctl --user restart papercup-mcp-proxy.service\`. If agents are still hitting a proxy ` +
      `failure you already fixed, this is why (EI-21390665295968159).`,
    identityCurrent: (loadedSha, expectedSha) =>
      `mcp-proxy code current (loaded build ${loadedSha} from runtime-vintage matches current hot-path source at ${expectedSha}; ` +
      `mtime is only a fallback signal)`,
    identityDrift: (loadedSha, expectedSha, identity) =>
      `⚠ mcp-proxy CODE DRIFT: loaded build ${loadedSha} from ${identityLabel(identity)} differs from current source ${expectedSha} — ` +
      `the :9071 proxy is running STALE code until ` +
      `\`systemctl --user restart papercup-mcp-proxy.service\`.`,
  }, loadedIdentity, currentSourceSha, sourceChangedSinceLoaded);
}

/** Shared pure verdict for a "tsx-loads the working tree, no file-watch" unit: process
 *  boot (ms) vs the newest ON-DISK change under its hot paths (ms). Unknown inputs ⇒
 *  present:false (fail-soft, never a fabricated verdict). */
function evaluateCodeDrift(
  name: string,
  bootMs: number | null,
  hotChangeMs: number | null,
  newestFile: string | null | undefined,
  copy: {
    unknown: string;
    current: string;
    drift: (behindMin: number, which: string) => string;
    identityCurrent: (loadedSha: string, expectedSha: string) => string;
    identityDrift: (loadedSha: string, expectedSha: string, identity: LoadedCodeIdentity) => string;
  },
  loadedIdentity?: LoadedCodeIdentity | null,
  currentSourceSha?: string | null,
  sourceChangedSinceLoaded?: boolean | null,
): ProbeResult {
  const identity = loadedIdentity ?? null;
  const loadedSha = identity?.treeSha?.trim() || null;
  const expectedSha = currentSourceSha?.trim() || null;
  if (identity && loadedSha && expectedSha) {
    const provenance = {
      source: 'runtime-vintage' as const,
      loadedSha,
      expectedSha,
      loadedPid: identity.pid ?? null,
      loadedReportedAt: identity.reportedAt ?? null,
    };
    // Direct callers that omit the scoped comparison retain the old pure-helper
    // behavior for backwards compatibility. The real probe always supplies a
    // three-state result from Git, so a failed scoped read falls through to the
    // mtime leg instead of turning an unrelated commit into a false warning.
    const identityDiffers =
      sourceChangedSinceLoaded === undefined
        ? !sameSourceSha(loadedSha, expectedSha)
        : sourceChangedSinceLoaded;
    if (identityDiffers === true) {
      return {
        name,
        up: true,
        status: null,
        latencyMs: 0,
        note: copy.identityDrift(loadedSha, expectedSha, identity),
        provenance,
      };
    }
    // A matching commit identity proves the bundle was built from this commit,
    // but not that the working tree is clean. Keep the mtime leg for a newer
    // uncommitted edit so identity-first does not hide that distinct case.
    if (identityDiffers === false && bootMs !== null && hotChangeMs !== null && hotChangeMs <= bootMs) {
      return {
        name,
        up: true,
        status: null,
        latencyMs: 0,
        note: copy.identityCurrent(loadedSha, expectedSha),
        provenance,
      };
    }
  }
  if (bootMs == null || hotChangeMs == null) {
    return {
      name,
      up: true,
      status: null,
      latencyMs: 0,
      present: false,
      note: copy.unknown,
      provenance: {
        source: 'mtime-fallback',
        ...(loadedSha ? { loadedSha } : {}),
        ...(expectedSha ? { expectedSha } : {}),
        reason: 'loaded build identity was unavailable or could not be compared',
      },
    };
  }
  if (hotChangeMs <= bootMs) {
    return {
      name,
      up: true,
      status: null,
      latencyMs: 0,
      note: `${copy.current} (provenance: mtime fallback; loaded build identity was unavailable or did not match)`,
      provenance: {
        source: 'mtime-fallback',
        ...(loadedSha ? { loadedSha } : {}),
        ...(expectedSha ? { expectedSha } : {}),
        reason: 'loaded build identity was unavailable or did not match',
      },
    };
  }
  const behindMin = Math.max(1, Math.round((hotChangeMs - bootMs) / 60_000));
  const which = newestFile ? ` (newest: ${newestFile})` : '';
  return {
    name,
    up: true,
    status: null,
    latencyMs: 0,
    note: `${copy.drift(behindMin, which)} (provenance: mtime fallback; a newer uncommitted working-tree change may be present)`,
    provenance: {
      source: 'mtime-fallback',
      ...(loadedSha ? { loadedSha } : {}),
      ...(expectedSha ? { expectedSha } : {}),
      reason: 'mtime detected a newer working-tree change',
    },
  };
}

function sameSourceSha(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right) return false;
  return left === right || (left.length >= 7 && right.startsWith(left)) || (right.length >= 7 && left.startsWith(right));
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

const CODE_DRIFT_TEST_EXCLUDE_PATHSPEC = ':(exclude)**/*.test.ts';

/**
 * Compare two committed identities only in the files a service actually loads.
 *
 * A runtime-vintage `treeSha` is a whole-repository commit identity. Comparing it
 * directly with the current whole-repository HEAD makes every unrelated commit
 * look like service code drift. `git diff --name-only ... -- <hot paths>` keeps
 * the committed leg in the same scope as the mtime leg. `null` is deliberate:
 * an unavailable/unknown Git ref must not be interpreted as "no drift".
 */
export async function compareCommittedHotPaths(
  run: CodeDriftExecFile,
  integrationRoot: string,
  loadedSha: string,
  currentSha: string,
  hotPaths: readonly string[],
): Promise<boolean | null> {
  const loaded = loadedSha.trim();
  const current = currentSha.trim();
  if (!isGitSha(loaded) || !isGitSha(current) || hotPaths.length === 0) return null;
  if (sameSourceSha(loaded, current)) return false;
  try {
    const { stdout } = await run(
      'git',
      ['diff', '--name-only', loaded, current, '--', ...hotPaths, CODE_DRIFT_TEST_EXCLUDE_PATHSPEC],
      { cwd: integrationRoot, timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

function identityLabel(identity: LoadedCodeIdentity): string {
  const pid = identity.pid == null ? '' : ` pid ${identity.pid}`;
  const host = identity.host ? ` on ${identity.host}` : '';
  const reported = identity.reportedAt ? ` reported ${identity.reportedAt}` : '';
  return `runtime-vintage${pid}${host}${reported}`;
}

/** Probe bg-host code drift (WI-1867): unit MainPID elapsed-seconds vs the newest
 *  *.ts mtime under BG_HOST_HOT_PATHS in the integration tree (the working tree the
 *  bg-host tsx-loads from — mtime, not commit time, is what a restart would pick up).
 *  Fail-soft at every step (no systemd / no unit / no tree ⇒ present:false, never a
 *  phantom drift). */
export async function probeBgHostCodeDrift(now: number = Date.now()): Promise<ProbeResult> {
  return probeCodeDrift(
    {
      name: PORTLESS_PROBE_NAMES.bgHostCode,
      unit: process.env.PAPERCUSP_BGHOST_WATCHDOG_UNIT || 'papercusp-bg-host',
      hotPaths: BG_HOST_HOT_PATHS,
      artifactPaths: BG_HOST_ARTIFACT_PATHS,
      evaluate: evaluateBgHostCodeDrift,
      platformNote: 'bg-host code-drift probe is Linux/systemd-only — not applicable on this platform',
      failedNote: 'bg-host code-drift unknown (probe failed)',
    },
    now,
  );
}

/** Probe :9071 MCP-proxy code drift (EI-21390665295968159): the `papercup-mcp-proxy` unit's
 *  start time vs the newest *.ts mtime under {@link MCP_PROXY_HOT_PATHS} in the tree it
 *  tsx-loads from. Same fail-soft contract as the bg-host probe — no systemd / no unit /
 *  no tree ⇒ present:false, never a phantom drift. */
export async function probeMcpProxyCodeDrift(now: number = Date.now()): Promise<ProbeResult> {
  return probeCodeDrift(
    {
      name: PORTLESS_PROBE_NAMES.mcpProxyCode,
      unit: process.env.PAPERCUSP_MCP_PROXY_UNIT || 'papercup-mcp-proxy',
      hotPaths: MCP_PROXY_HOT_PATHS,
      evaluate: evaluateMcpProxyCodeDrift,
      platformNote: 'mcp-proxy code-drift probe is Linux/systemd-only — not applicable on this platform',
      failedNote: 'mcp-proxy code-drift unknown (probe failed)',
    },
    now,
  );
}

/**
 * Keep the runtime-vintage lookup inside the same bounded read-only transaction
 * used by the other operator diagnostics. The explicit acquisition deadline
 * matters after a bg-host restart, when a wedged/restarting pool is the failure
 * being diagnosed and a raw list call could outlive the MCP request itself.
 */
export async function readRuntimeVintageForServiceHealth() {
  const { listRuntimeVintage } = await import('./runtime-vintage');
  return boundedPgReadTxn(
    (tx) => listRuntimeVintage(undefined, tx),
    {
      timeoutMs: PG_READ_TXN_DEFAULT_TIMEOUT_MS,
      acquireTimeoutMs: PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS,
    },
  );
}

/** Shared probe mechanics for the code-drift family: unit start via the shared systemd
 *  probe, newest hot-path *.ts mtime via GNU `find -printf` in the integration tree. */
async function probeCodeDrift(
  spec: {
    name: string;
    unit: string;
    hotPaths: readonly string[];
    artifactPaths?: readonly string[];
    evaluate: (
      bootMs: number | null,
      hotChangeMs: number | null,
      newestFile?: string | null,
      loadedIdentity?: LoadedCodeIdentity | null,
      currentSourceSha?: string | null,
      sourceChangedSinceLoaded?: boolean | null,
    ) => ProbeResult;
    platformNote: string;
    failedNote: string;
  },
  now: number = Date.now(),
): Promise<ProbeResult> {
  const start = Date.now();
  // Linux/systemd-only probe: MainPID via `systemctl --user`, elapsed via `ps etimes`,
  // newest mtime via GNU `find -printf` — none of which exist on macOS. Short-circuit to an
  // HONEST "not applicable on this platform" instead of spawning a missing `systemctl` and
  // returning the scary "probe failed" note (P-005,
  // cross-platform-hardening-and-agent-ergonomics-2026-07-05). NOTE: a Windows desktop runs
  // this sidecar as a Linux process under WSL (process.platform === 'linux'), so it is NOT
  // short-circuited here — the inner try/catch stays the backstop for WSL-without-systemd.
  if (process.platform !== 'linux') {
    return {
      name: spec.name,
      up: true,
      status: null,
      latencyMs: Date.now() - start,
      present: false,
      note: spec.platformNote,
    };
  }
  try {
    // Every git/find below goes through the spawner sidecar (WI-10005118), never a local fork.
    const run = defaultCodeDriftExec;
    // Boot time via the SHARED systemd probe (agent-tools/dev/systemd-service-probe)
    // rather than a second inline systemctl+ps: it already handles the unit-type
    // suffix correctly (EI-18700974567040702) and distinguishes "MainPID 0 = not
    // running" from "probe failed", which this call site used to conflate.
    const { probeServiceStart } = await import('./agent-tools/dev/systemd-service-probe');
    const svc = await probeServiceStart(spec.unit);
    const processStartMs =
      svc.ok && svc.startedAtMs !== undefined
        ? svc.startedAtMs
        : svc.ok && svc.secondsSinceStart !== undefined
          ? now - svc.secondsSinceStart * 1000
          : null;
    const bootMs = processStartMs;
    if (bootMs === null) {
      return { ...spec.evaluate(null, null), latencyMs: Date.now() - start };
    }
    // Newest hot-path *.ts mtime in the integration tree (the tree the bg-host runs from).
    let integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? '';
    if (!integrationRoot) {
      const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { timeout: 3000 });
      integrationRoot = stdout.trim();
    }
    let loadedIdentity: LoadedCodeIdentity | null = null;
    try {
      const rows = await readRuntimeVintageForServiceHealth();
      const processPid = svc.mainPid ?? null;
      if (processPid !== null) {
        const row = rows.find((candidate) => {
          const reportedAtMs = Date.parse(candidate.reportedAt);
          return (
            candidate.host === hostname() &&
            candidate.pid === processPid &&
            Number.isFinite(reportedAtMs) &&
            reportedAtMs >= bootMs
          );
        });
        if (row) {
          loadedIdentity = {
            source: 'runtime-vintage',
            treeSha: row.treeSha,
            bundleVersion: row.bundleVersion,
            pid: row.pid,
            host: row.host,
            reportedAt: row.reportedAt,
          };
        }
      }
    } catch {
      // The mtime path below remains the bounded fail-soft fallback when the
      // boot self-report or its datastore is unavailable.
    }
    let currentSourceSha: string | null = null;
    try {
      const { stdout } = await run('git', ['rev-parse', 'HEAD'], {
        timeout: 3000,
        cwd: integrationRoot,
        maxBuffer: 1024 * 1024,
      });
      const sha = stdout.trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) currentSourceSha = sha;
    } catch {
      // A missing git identity leaves the mtime fallback as the only honest leg.
    }
    const sourceChangedSinceLoaded =
      loadedIdentity?.treeSha && currentSourceSha
        ? await compareCommittedHotPaths(
            run,
            integrationRoot,
            loadedIdentity.treeSha,
            currentSourceSha,
            spec.hotPaths,
          )
        : null;
    const artifactPaths = (spec.artifactPaths ?? []).filter((artifactPath) => {
      try {
        return statSync(join(integrationRoot, artifactPath)).isFile();
      } catch {
        return false;
      }
    });
    const findArgs = [
      ...spec.hotPaths,
      ...artifactPaths,
      '-type',
      'f',
      '(',
      '-name',
      '*.ts',
      '-not',
      '-name',
      '*.test.ts',
      ...artifactPaths.flatMap((artifactPath) => ['-o', '-path', artifactPath]),
      ')',
      '-printf',
      '%T@ %p\n',
    ];
    const { stdout: findOut } = await run('find', findArgs, {
      timeout: 5000,
      cwd: integrationRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    let hotChangeMs: number | null = null;
    let newestFile: string | null = null;
    for (const line of findOut.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp <= 0) continue;
      const t = Number(line.slice(0, sp)) * 1000;
      if (Number.isFinite(t) && (hotChangeMs == null || t > hotChangeMs)) {
        hotChangeMs = t;
        newestFile = line.slice(sp + 1);
      }
    }
    return {
      ...spec.evaluate(
        bootMs,
        hotChangeMs,
        newestFile,
        loadedIdentity,
        currentSourceSha,
        sourceChangedSinceLoaded,
      ),
      latencyMs: Date.now() - start,
    };
  } catch {
    return { name: spec.name, up: true, status: null, latencyMs: Date.now() - start, present: false, note: spec.failedNote };
  }
}

/** Probe the bg-host ticker via the newest active-routine `last_fired_at`. Fail-soft:
 *  a PG/read failure → liveness UNKNOWN (present:false), never a fabricated DOWN. */
export async function probeBgHostTicker(now: number = Date.now()): Promise<ProbeResult> {
  const start = Date.now();
  try {
    // No install_slug filter — the ticker drives EVERY install's routines, so the
    // fleet-wide newest fire is the ticker heartbeat (and it stays robust while the
    // papercup→papercusp slug rename is in flight).
    const rows = await boundedPgReadTxn(
      (tx) => tx<{ last: Date | string | null }[]>`
        SELECT MAX(last_fired_at) AS last
          FROM harness_shared.routines
         WHERE active = true AND last_fired_at IS NOT NULL`,
      {
        timeoutMs: PG_READ_TXN_DEFAULT_TIMEOUT_MS,
        acquireTimeoutMs: PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS,
      },
    );
    return { ...evaluateBgHostTicker(toMs(rows[0]?.last), now), latencyMs: Date.now() - start };
  } catch {
    return { name: PORTLESS_PROBE_NAMES.bgHostTicker, up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'ticker liveness unknown (routines read failed)' };
  }
}

/**
 * WI-899 (A): liveness of the SUBSTRATE_SIDECAR process — a SEPARATE process from
 * :3070 that owns the federation engine (Corestore + own-log + merge/projection loop
 * + swarm/admission) when the flag is ON. Before this, `sidecar:healthz` was called
 * exactly once at boot (substrate-boot-wrapper.ts) and NEVER polled again — a sidecar
 * that died post-boot kept reading "healthy" everywhere (getInProcessSubstrateStatus
 * hardcoded `handlePresent: true` over the still-cached boot-time proxies), which is
 * exactly the class of silent failure this whole federation-observability plan chases.
 *
 * Fail-soft + flag-aware: SUBSTRATE_SIDECAR OFF (the default) ⇒ `present: false`
 * (nothing to probe, never a phantom DOWN — mirrors `probeBgHostTicker`'s unknown-is-
 * silent contract). ON + the healthz RPC succeeds within `timeoutMs` ⇒ up. ON + the
 * RPC throws/times out ⇒ DOWN with a note naming the sidecar specifically (so the
 * reader doesn't restart :3070 instead, the same pitfall `evaluateBgHostTicker`'s note
 * guards against).
 */
export async function probeSubstrateSidecar(timeoutMs = 5000): Promise<ProbeResult> {
  const name = PORTLESS_PROBE_NAMES.substrateSidecar;
  const start = Date.now();
  let sidecarOn = false;
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    sidecarOn = await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system');
  } catch {
    // Flag-read failure: liveness unknown, never fabricate a verdict either way.
    return { name, up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'sidecar liveness unknown (flag read failed)' };
  }
  if (!sidecarOn) {
    return { name, up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'SUBSTRATE_SIDECAR flag off — no sidecar to probe' };
  }
  // WI-895 discrimination (2026-07-03): this probe can only see a sidecar spawned by
  // THIS process family — the client dials PAPERCUSP_SUBSTRATE_IPC_SOCKET when set,
  // else /tmp/papercusp-substrate-<own pid>.sock. Flag ON with NO socket at that
  // path is NOT an outage: no sidecar was spawned here (lazy substrate not yet
  // booted, in-process fallback, or the install's sidecar belongs to ANOTHER host,
  // e.g. the bg-host owns it while dev-api runs this probe). Before this check that
  // state read as a phantom "sidecar DOWN (Connection timeout)" — it burned ~40min
  // of fleet incident-response on 2026-07-03 against a perfectly healthy sidecar.
  let sockPath = '';
  try {
    const { resolveSubstrateSocketPath } = await import('./sync/hyperbee/substrate-socket-path');
    sockPath = resolveSubstrateSocketPath();
    const { existsSync } = await import('node:fs');
    if (!existsSync(sockPath)) {
      return {
        name,
        up: true,
        status: null,
        latencyMs: Date.now() - start,
        present: false,
        note: `no sidecar spawned by this process — flag ON but no socket at ${sockPath} ` +
          `(lazy substrate not yet booted, in-process mode, or the sidecar spawner is another ` +
          `host e.g. bg-host). NOT a liveness verdict on the install's sidecar.`,
      };
    }
  } catch {
    // Path-resolution failure: fall through to the RPC probe — never fabricate a verdict.
  }
  try {
    const { getSubstrateIpcClient } = await import('./sync/hyperbee/substrate-ipc-client');
    const client = getSubstrateIpcClient();
    await Promise.race([
      client.call('sidecar:healthz'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('healthz probe timeout')), timeoutMs)),
    ]);
    return { name, up: true, status: null, latencyMs: Date.now() - start, note: `sidecar:healthz OK (${sockPath})` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name,
      up: false,
      status: null,
      latencyMs: Date.now() - start,
      note: `⚠ substrate sidecar DOWN (healthz to ${sockPath || 'unresolved socket'}: ${msg}) — the SEPARATE process that owns federation ` +
        `replication (Corestore/merge/swarm) for this install. Boot-time handle proxies stay cached in ` +
        `the main process regardless, so federation-status/boot-health can still read "booted" for a ` +
        `dead sidecar — this probe is the actual liveness signal. The socket EXISTS but healthz failed: ` +
        `a real sidecar fault (spawn-side auto-respawn should recover it; dev:restart if not), not :3070.`,
    };
  }
}

/**
 * P-002 (shared-embedding-sidecar-and-enrichment-2026-07-10): liveness of the
 * shared EMBED SIDECAR — the loopback HTTP process that owns the warm local
 * embedding model when a host opts in (PAPERCUSP_EMBED_SIDECAR=1, or an
 * explicit PAPERCUSP_EMBED_SIDECAR_URL pointing at one).
 *
 * Fail-soft + opt-in-aware, mirroring `probeSubstrateSidecar`'s contract: not
 * enabled on this host ⇒ `present: false` (nothing to probe — NEVER a phantom
 * DOWN; that is the exact EI-188/EI-276 false-alarm class the HEALTH_ENDPOINTS
 * header warns against, which is why this is a dedicated probe and not a raw
 * endpoint entry). Enabled + a bounded functional POST /embed that returns one
 * vector ⇒ up. Enabled + no answer, a non-2xx response, or a malformed vector
 * response ⇒ DOWN. A /healthz 200 alone is intentionally insufficient: the
 * 2026-08-23 incident had exactly that shape while every real embed stalled.
 *
 * ⚠ EI-18580900204592249: the DOWN note used to claim embedding "falls back to
 * in-process embedding (D-003)" — that fallback was RETIRED by WI-4021
 * (2026-07-11): a host with a CONFIGURED sidecar URL now REQUIRES it. On a
 * real outage, embed calls reject loudly (`sidecar_required_unavailable`) and
 * memory writes park in `harness_shared.memory_write_journal`, auto-draining
 * once the sidecar returns — this is degraded (no data loss, self-healing),
 * but it is NOT the harmless silent fallback the old note implied. The
 * in-process path only survives on a host with NO sidecar configured at all
 * (desktop app, tests, bench) — see `embed-sidecar-wiring.ts`.
 */
export async function probeEmbedSidecar(
  timeoutMs?: number,
  opts: {
    /**
     * Force this probe into (`true`) or out of (`false`) cache-bypassing mode.
     * Omitted ⇒ the duty cycle decides — see `embedSidecarProbeShouldExercise`.
     */
    exercise?: boolean;
  } = {},
): Promise<ProbeResult> {
  const name = PORTLESS_PROBE_NAMES.embedSidecar;
  const start = Date.now();
  const exercise =
    opts.exercise ?? embedSidecarProbeShouldExercise(start, lastEmbedSidecarProvenInferenceMs);
  let url: string;
  try {
    const spawnMod = await import('./memory/embed-sidecar-spawn');
    const explicitUrl = process.env.PAPERCUSP_EMBED_SIDECAR_URL;
    if (!spawnMod.embedSidecarEnabled() && !explicitUrl) {
      return {
        name,
        up: true,
        status: null,
        latencyMs: Date.now() - start,
        present: false,
        note: 'embed sidecar not enabled on this host (PAPERCUSP_EMBED_SIDECAR/…_URL unset) — nothing to probe',
      };
    }
    const resolved = explicitUrl ?? spawnMod.embedSidecarLocalUrl();
    if (!explicitUrl && spawnMod.embedSidecarIdleByDesign()) {
      return {
        name,
        up: true,
        status: null,
        latencyMs: Date.now() - start,
        present: false,
        note: 'embed sidecar is exiting idle (announced) — the next embed re-launches it; nothing to probe',
      };
    }
    if (!resolved) {
      // P-530: this Server spawns its sidecar on demand and none is running
      // now (not started yet, or it exited idle). Not an outage.
      return {
        name,
        up: true,
        status: null,
        latencyMs: Date.now() - start,
        present: false,
        note: 'embed sidecar is spawned on demand by this Server and is not running now — nothing to probe',
      };
    }
    url = resolved.replace(/\/$/, '');
  } catch {
    return { name, up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'embed-sidecar liveness unknown (spawn-module read failed)' };
  }
  const embedUrl = `${url}/embed`;
  const budgetMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.trunc(timeoutMs as number))
    : exercise
      ? EMBED_SIDECAR_EXERCISE_PROBE_TIMEOUT_MS
      : EMBED_SIDECAR_FUNCTIONAL_PROBE_TIMEOUT_MS;
  // P-532b: a per-tenant sidecar exits after 5 idle minutes. Its idle clock must not count
  // this probe, and a sidecar that exits idle WHILE this probe runs is "not running", not DOWN.
  const { EMBED_SIDECAR_PROBE_HEADER } = await import('./memory/embed-sidecar-server');
  const exitedIdleMeanwhile = async (): Promise<ProbeResult | null> => {
    if (process.env.PAPERCUSP_EMBED_SIDECAR_URL) return null;
    try {
      const spawnMod = await import('./memory/embed-sidecar-spawn');
      if (!spawnMod.embedSidecarIdleByDesign()) return null;
    } catch {
      return null;
    }
    return {
      name,
      up: true,
      status: null,
      latencyMs: Date.now() - start,
      present: false,
      note: 'embed sidecar exited idle while this probe ran — the next embed re-launches it; not an outage',
    };
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  try {
    const response = await fetch(embedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [EMBED_SIDECAR_PROBE_HEADER]: '1' },
      body: JSON.stringify({
        model: 'gemma',
        kind: 'query',
        texts: [EMBED_SIDECAR_FUNCTIONAL_PROBE_TEXT],
        // Only sent when this probe means to measure the model. An older
        // sidecar bundle accepts the unknown field, ignores it, and answers
        // from its LRU in ~2ms — which is precisely why the response is asked
        // to PROVE the bypass below rather than the flag being taken as
        // evidence that it happened.
        ...(exercise ? { bypassCache: true } : {}),
      }),
      signal: ctl.signal,
    });
    if (!response.ok) {
      const idle = await exitedIdleMeanwhile();
      if (idle) return idle;
      return {
        name,
        up: false,
        status: response.status,
        latencyMs: Date.now() - start,
        url: embedUrl,
        note:
          `⚠ embed sidecar DOWN (functional POST /embed returned HTTP ${response.status} within ${budgetMs}ms) — ` +
          `the shared warm-model embedding process for this host. This host's sidecar is REQUIRED ` +
          `(in-process fallback retired by WI-4021/D-003): embed calls reject loudly ` +
          `(sidecar_required_unavailable) and memory writes park in the write journal until it returns.`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        name,
        up: false,
        status: response.status,
        latencyMs: Date.now() - start,
        url: embedUrl,
        note: `⚠ embed sidecar DOWN (functional POST /embed returned invalid JSON within ${budgetMs}ms) — the response was not a usable embedding result.`,
      };
    }
    const vectors = (body as { vectors?: unknown } | null)?.vectors;
    const vector = Array.isArray(vectors) && vectors.length === 1 ? vectors[0] : null;
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      return {
        name,
        up: false,
        status: response.status,
        latencyMs: Date.now() - start,
        url: embedUrl,
        note: `⚠ embed sidecar DOWN (functional POST /embed returned no usable vector within ${budgetMs}ms) — the response shape is invalid for the shared embedding client.`,
      };
    }
    // WI-1647443: a usable vector proves HTTP + response shape. Whether it
    // proves the MODEL is a separate question, and the response is the only
    // thing that can answer it — asking for `bypassCache` is not evidence the
    // bypass happened (an older bundle accepts the unknown field, ignores it,
    // and answers from its LRU). Ask the one helper that owns the question
    // rather than reading `cache` here, so this probe and the bench CLI cannot
    // drift into disagreeing about what counts as a measurement.
    let measured: import('./memory/embed-sidecar-server').EmbedMeasuredVerdict;
    try {
      const serverMod = await import('./memory/embed-sidecar-server');
      measured = serverMod.embedResponseMeasuredModel(body as Record<string, unknown>, 1);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      measured = { ok: false, code: 'no-accounting', reason: `cache-accounting verdict unavailable (${detail})` };
    }
    const latencyMs = Date.now() - start;
    if (measured.ok) {
      // Back off ONLY on proof. A failed or unprovable exercise leaves the
      // clock alone so the next tick tries again, which is what stops a dead
      // worker from producing one DOWN followed by an interval of cached ups.
      // ⚠ Load-bearing, not tidiness: `embed-sidecar` is damped by
      // EMBED_SIDECAR_DOWN_CONFIRM_TICKS, and `applyDownConfirmDebounce`
      // RESETS the streak on any `up`. Advance this clock on ATTEMPT instead
      // and a dead worker alternates DOWN / cached-up forever, so the sidecar
      // can never confirm DOWN at all.
      lastEmbedSidecarProvenInferenceMs = Date.now();
      return {
        name,
        up: true,
        status: response.status,
        latencyMs,
        url: embedUrl,
        embedModelExercised: 'yes',
        note:
          `functional POST /embed OK — the model ran for THIS probe (1/1 texts inferred` +
          `${exercise ? ', bypassCache' : ''}, budget ${budgetMs}ms, ${latencyMs}ms)`,
      };
    }
    if (measured.code === 'served-from-cache') {
      return {
        name,
        up: true,
        status: response.status,
        latencyMs,
        url: embedUrl,
        embedModelExercised: 'no',
        note:
          `embed sidecar answered, but the model was NOT exercised: this vector came from the sidecar's LRU, ` +
          `so ${latencyMs}ms is a cache lookup and this probe says nothing about the ONNX worker. ` +
          `A real inference is forced at most every ${Math.round(EMBED_SIDECAR_EXERCISE_INTERVAL_MS / 1000)}s (WI-1647443).`,
      };
    }
    return {
      name,
      up: true,
      status: response.status,
      latencyMs,
      url: embedUrl,
      embedModelExercised: 'unknown',
      note:
        `embed sidecar answered with a usable vector, but whether the model ran is UNDECIDABLE` +
        `${exercise ? ' — this probe asked for bypassCache and the response did not account for it' : ''}: ` +
        `${measured.reason} Treat this as "not proven", never as a healthy embed.`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const idle = await exitedIdleMeanwhile();
    if (idle) return idle;
    return {
      name,
      up: false,
      status: null,
      latencyMs: Date.now() - start,
      url: embedUrl,
      note:
        `⚠ embed sidecar DOWN (functional POST /embed failed within ${budgetMs}ms: ${detail}) — ` +
        `${exercise ? 'this probe was the periodic cache-BYPASSING one, so the budget covers a real inference and the failure is the model or its queue, not the HTTP layer. ' : ''}` +
        `the shared warm-model embedding process for this host. This host's sidecar is REQUIRED ` +
        `(in-process fallback retired by WI-4021/D-003): embed calls reject loudly ` +
        `(sidecar_required_unavailable) and memory writes park in the write journal until it returns.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * EI-15810 (EI-2434 follow-up): the user-manager journald stdout-capture path can
 * silently wedge HOST-WIDE — every `--user` unit keeps running and serving traffic,
 * but new stdout output stops landing in the journal. EI-2434 found this by accident,
 * days into an unrelated incident (EI-2421); there was no signal it had happened at
 * all. Not built in EI-2434 itself (the reproducing state had already cleared by the
 * time that pass was picked up) — this is the deferred detection-only guard.
 *
 * Every tick this writes a fresh nonce to THIS process's own stdout, then checks
 * whether the PRIOR tick's nonce (module state — see `pendingJournalCanary`) landed in
 * the journal. That design choice is deliberate, not incidental: by the time a
 * previous-tick nonce is checked it is already a full `runServiceHealthTick` interval
 * (60s) old — far past any conceivable journald ingestion latency — so this probe adds
 * ZERO blocking delay to `probeAll()`. Several callers (`dev:service_health`, the
 * watchdog's inline-probe-on-stale fallback) run `probeAll()` synchronously and
 * on-demand; a probe that slept in-place before checking its own just-written canary
 * would tax every one of those calls, every tick, forever. Checking the PRIOR write
 * instead of sleeping on THIS one also produces a strictly stronger signal: two
 * consecutive DOWN ticks mean two INDEPENDENTLY-written canaries both failed to land,
 * not one write re-checked after a fixed pause.
 *
 * A miss means journald has stopped capturing THIS unit's stdout — it is explicitly
 * NOT a claim that the unit itself is down (same pitfall `probeSubstrateSidecar`'s note
 * guards against for :3070 vs the sidecar it probes). There is no in-process fix: the
 * known recovery is a human-triggered host reboot/relogin. Detection alone would have
 * saved the multi-day diagnosis in EI-2421 — a miss now fires a service-health signal
 * instead of the blackout being silently absorbed.
 *
 * Fail-soft + platform/context-aware, mirroring every other portless probe in this
 * file: non-Linux, not running under a systemd `--user` `.service` unit at all (a dev
 * shell, a test process, the desktop shell), no prior canary to check yet (the first
 * tick since process start), or an unreadable journal all read `present:false` —
 * liveness UNKNOWN, never a fabricated verdict either way. Only a PROVEN miss
 * (`journalctl --grep` genuinely matched nothing — see `classifyJournalctlFailure`'s
 * `'no-match'`, the same exit-1-empty-stderr semantic `journal-read.ts` already had to
 * learn once) is reported as a real DOWN, damped by `JOURNAL_CANARY_DOWN_CONFIRM_TICKS`
 * like every other probe in this family that can see a transient single-tick blip
 * (`bg-host-ticker`, `embed-sidecar`).
 */

/**
 * Bounded exec budget for the confirming journalctl read — deliberately far below
 * `journal-read.ts`'s `JOURNAL_TIMEOUT_MS` (30s, sized for that module's heavier,
 * unscoped/wide-window interactive reads). This read is unit-scoped, grep-scoped to
 * one nonce, and windowed from the prior write with `SINCE_CUSHION_MS` of slack, so a
 * healthy read finishes in well under a second; a run that needs longer than this
 * budget is itself worth surfacing as a probe failure rather than stalling a 60s
 * health tick.
 */
export const JOURNAL_CANARY_READ_TIMEOUT_MS = 3_000;

/**
 * Safety margin subtracted from the prior canary's write time before it is used as the
 * confirming read's `--since` bound (clock rounding, not a landing-time allowance —
 * see the module doc comment above for why this probe never waits on landing).
 */
export const JOURNAL_CANARY_SINCE_CUSHION_MS = 2_000;

/**
 * Pure: extract a systemd `.service` unit name from a `/proc/self/cgroup` body, or
 * null. Split out from {@link resolveOwnServiceUnit} so the parsing logic is
 * unit-testable without touching the filesystem.
 */
export function parseOwnServiceUnitFromCgroup(cgroupBody: string): string | null {
  for (const rawLine of cgroupBody.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // The LAST path segment, not the first `.service` match: the cgroup path is
    // hierarchical and its EARLIER segments include systemd's own containers (e.g.
    // `user@1000.service`, the per-user systemd instance every --user unit runs
    // inside) — those are not the app unit. Only the deepest/innermost segment names
    // the actual unit this process belongs to; a `.scope` there (an ad-hoc process,
    // not a systemd-managed unit) correctly yields no match.
    const segments = line.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.endsWith('.service')) return last;
  }
  return null;
}

/**
 * Which systemd `--user` `.service` unit (if any) THIS process is running under,
 * derived from `/proc/self/cgroup` rather than a lookup table: a systemd-managed
 * unit's process lives in a cgroup path ending in `<unit>.service` (verified live on
 * this host: `.../app.slice/papercusp-dev-api.service`), while an ad-hoc process (a
 * dev shell, a test run, an agent terminal) lives in a `.scope`, never a `.service`.
 * Returns null for anything that is not a systemd `.service` unit — including every
 * non-Linux host and every read failure — so the caller can treat "no unit" and
 * "unreadable" identically as `present:false`, matching every other portless probe.
 */
export async function resolveOwnServiceUnit(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile('/proc/self/cgroup', 'utf8');
    return parseOwnServiceUnitFromCgroup(raw);
  } catch {
    return null;
  }
}

/** Per-site kill-switch for the code-drift probes' sidecar route (`0` = force a local spawn). */
export const CODE_DRIFT_SIDECAR_VAR = 'PAPERCUSP_CODE_DRIFT_SPAWN_SIDECAR';

/**
 * The production exec for the code-drift probes (`git rev-parse`, `git diff --name-only`,
 * `find -printf`): forked by the spawner sidecar where this host has one. WI-10005118: a 30 s
 * main-thread CPU profile of a 3.5 GB bg-host put probeCodeDrift at 47% of the main thread's
 * spawn self time, because a local fork copies the parent's page tables (cost grows with RSS).
 * Same contract as promisify(execFile): resolves on exit 0, rejects with `.code`/`.stdout` otherwise.
 */
export async function defaultCodeDriftExec(
  file: string,
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer?: number },
): Promise<{ stdout: string }> {
  const { execFileViaSidecar } = await import('./fleet/git-via-sidecar');
  const { stdout } = await execFileViaSidecar(file, args, {
    timeoutMs: options.timeout,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    subsystem: 'code-drift-probe',
    sidecarVar: CODE_DRIFT_SIDECAR_VAR,
  });
  return { stdout };
}

/** Per-site kill-switch for the journal canary's sidecar route (`0` = force a local spawn). */
export const JOURNAL_CANARY_SIDECAR_VAR = 'PAPERCUSP_JOURNAL_CANARY_SPAWN_SIDECAR';

/**
 * The production canary read: `journalctl` forked by the spawner sidecar where this host
 * has one (WI-10004975 — this per-tick read was ~10% of a 13 GB bg-host's spawn samples;
 * a local fork costs time proportional to the parent's RSS). Exported for its routing test.
 */
export async function defaultJournalCanaryExec(args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  const { execFileViaSidecar } = await import('./fleet/git-via-sidecar');
  const { stdout } = await execFileViaSidecar('journalctl', args, {
    timeoutMs,
    maxBuffer: 64 * 1024,
    subsystem: 'journal-canary',
    sidecarVar: JOURNAL_CANARY_SIDECAR_VAR,
  });
  return { stdout };
}

/** Render epoch milliseconds in journalctl's unambiguous `@epoch` grammar — never a
 *  relative or locale-formatted spec. journalctl parses `--since`/`--until` in the
 *  HOST'S LOCAL time while every papercusp surface (including this probe's own
 *  `writtenAtMs`) is UTC epoch ms; `@epoch` is the one form immune to that mismatch. */
function journalCanaryEpoch(ms: number): string {
  return `@${Math.floor(ms / 1000)}`;
}

/** Cross-tick pending-canary state: the nonce written on the PRIOR tick, checked on
 *  THIS tick (see the module doc comment above for why). Module-scoped like
 *  `lastEmbedSidecarProvenInferenceMs`; resets on process restart, which is correct —
 *  a fresh process has no prior canary to check yet (the first-tick present:false
 *  branch in `probeJournalCanary` below). */
let pendingJournalCanary: { unit: string; nonce: string; writtenAtMs: number } | null = null;

/** Test seam: forget cross-tick canary state so a case starts from a fresh process. */
export function __resetJournalCanaryStateForTests(): void {
  pendingJournalCanary = null;
}

/** Injectable seams for {@link probeJournalCanary} — production uses the real
 *  filesystem/subprocess/console; tests substitute all three so the probe never needs
 *  a live systemd host to exercise, and never has to wait out a real tick interval. */
export interface JournalCanaryDeps {
  resolveUnit?: () => Promise<string | null>;
  exec?: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
  writeCanary?: (line: string) => void;
  readTimeoutMs?: number;
}

export async function probeJournalCanary(deps: JournalCanaryDeps = {}): Promise<ProbeResult> {
  const name = PORTLESS_PROBE_NAMES.journalCanary;
  const start = Date.now();
  if (process.platform !== 'linux') {
    return { name, up: true, status: null, latencyMs: 0, present: false, note: 'non-Linux host — no journald to canary' };
  }
  const resolveUnit = deps.resolveUnit ?? resolveOwnServiceUnit;
  let unit: string | null;
  try {
    unit = await resolveUnit();
  } catch {
    unit = null;
  }
  if (!unit) {
    return {
      name,
      up: true,
      status: null,
      latencyMs: Date.now() - start,
      present: false,
      note: 'not running under a systemd --user .service unit — nothing to canary (dev shell, test process, or desktop shell)',
    };
  }

  const exec = deps.exec ?? defaultJournalCanaryExec;
  const readTimeoutMs = deps.readTimeoutMs ?? JOURNAL_CANARY_READ_TIMEOUT_MS;
  const pending = pendingJournalCanary;
  let result: ProbeResult;
  if (!pending || pending.unit !== unit) {
    // First tick since process start, or the resolved unit changed mid-process
    // (shouldn't happen — a cgroup doesn't move — but resync rather than compare
    // a nonce against the wrong unit's journal): nothing to check yet.
    result = {
      name,
      up: true,
      status: null,
      latencyMs: Date.now() - start,
      present: false,
      note: pending ? 'canary unit changed — resynchronizing' : 'no prior canary to check yet (first tick since process start) — writing one now',
    };
  } else {
    try {
      await exec(
        ['--user', '-u', pending.unit, '-g', pending.nonce, '--since', journalCanaryEpoch(pending.writtenAtMs - JOURNAL_CANARY_SINCE_CUSHION_MS), '--no-pager', '-o', 'cat'],
        readTimeoutMs,
      );
      result = {
        name,
        up: true,
        status: null,
        latencyMs: Date.now() - start,
        note: `stdout capture healthy — the prior tick's canary landed in the journal for ${unit}`,
      };
    } catch (e) {
      const { classifyJournalctlFailure } = await import('./journal-read');
      const { kind } = classifyJournalctlFailure(e);
      if (kind === 'no-match') {
        // journalctl exits 1 with EMPTY stderr when --grep matched nothing — a
        // genuinely clean read, and the exact miss this probe exists to catch.
        result = {
          name,
          up: false,
          status: null,
          latencyMs: Date.now() - start,
          note:
            `⚠ the prior tick's canary WROTE to stdout but did NOT land in the journal for ${unit} — ` +
            `journald's stdout-capture path for this unit may be silently wedged (EI-2434: host-wide, ` +
            `every --user unit stays up and serves traffic while its journal logging goes dark). This ` +
            `is NOT a claim that ${unit} itself is down. Known recovery: a host reboot/relogin — ` +
            `nothing here can self-heal it.`,
        };
      } else {
        // no-systemd / timeout / error: the READ failed, not a proven miss — never
        // fabricate a verdict either way (same contract as every sibling probe).
        result = {
          name,
          up: true,
          status: null,
          latencyMs: Date.now() - start,
          present: false,
          note: `journal canary liveness unknown (${kind}: journalctl read failed)`,
        };
      }
    }
  }

  // Write THIS tick's canary for the NEXT tick to check, unconditionally — a wedge
  // must not stop new canaries from being written, or the probe would go permanently
  // blind the moment it starts failing instead of continuing to confirm/clear.
  const nonce = `svchealth-${process.pid}-${start.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const writeCanary = deps.writeCanary ?? ((line: string) => console.log(line));
  writeCanary(`[journal-canary] ${nonce}`);
  pendingJournalCanary = { unit, nonce, writtenAtMs: start };
  return result;
}

// ---------------------------------------------------------------------------
// Supervised-process registry (critical-process-supervisor-2026-07-04 P-001,
// EI-7021 design). ADDITIVE ONLY — a static metadata list describing which
// processes a future failed-unit reconciler (P-002) / flap-state rollup
// (P-004) should watch + whether it may auto-restart them. It does NOT wire
// into probeAll/runServiceHealthTick/diffHealth and changes no existing
// behavior; it is deliberately BROADER than HEALTH_ENDPOINTS (which only
// lists the HTTP endpoints polled every tick) because several supervised
// processes are systemd units or node-child sidecars with no HTTP probe at
// all today (e.g. the MCP proxy, the staging API, the inference gateway).
// `name` matches an existing ProbeResult.name where one already exists
// (operator/desktop-shell/substrate-sidecar/bg-host); a systemd-only entry
// with no live probe yet uses its own descriptive name. See the plan's
// "## Design (normative) → Supervised-process registry" for the source shape.
// ---------------------------------------------------------------------------

/** Where a supervised process runs / how it would be restarted. */
export type SupervisionLayer = 'systemd-user' | 'node-child' | 'desktop-shell';

/** `important` still pages; `critical` is load-bearing for the whole fleet. */
export type SupervisionCriticality = 'critical' | 'important';

export interface SupervisionEntry {
  /** Stable identifier — matches a ProbeResult.name when a probe already exists. */
  name: string;
  layer: SupervisionLayer;
  /** systemd-user layer only: the unit name. Omit the `.service` suffix for a service unit
   *  (systemctl defaults to that type); a non-default unit type (e.g. a `.timer`) MUST carry
   *  its explicit suffix — the reconciler only strips `.service` when matching `list-units`
   *  output (WI-5376), so an unsuffixed name never matches a `.timer` entry. */
  unit?: string;
  criticality: SupervisionCriticality;
  /** false = report-only for this entry — never auto-restarted even when the
   *  (future, P-002/D-003) `supervisorAutoRestart` flag is ON. Used for
   *  processes systemd already restarts itself (bg-host: Restart=always) or
   *  that must never be restart-looped (the federation test gate). */
  autoRestart: boolean;
  /**
   * WI-6149 (D-010 item 4): this unit is TIMER-DRIVEN — a `Type=oneshot`
   * service activated on a schedule, so `inactive` is its NORMAL idle state and
   * "is it running right now?" is the WRONG health question. For an episodic
   * entry, DOWN means `failed` (the last run errored), never `inactive`; see
   * `isUnitDown`, which takes this as an option.
   *
   * Without this distinction the registry silently mis-answers: `inactive` is
   * indistinguishable from `failed` to a persistent-unit oracle, so a healthy
   * hourly oneshot reads as "confirmed DOWN" for ~96% of every hour. That was
   * live and wrong for `live-federation-gate` before this field existed (see
   * its entry below), and it is the specific hazard that ruled
   * `papercusp-db-backup` and the oddsmith timers OUT of the registry —
   * NON_PROBED_UNITS records the measurements.
   *
   * INVARIANT: episodic ⇒ `autoRestart: false`. Auto-restarting a oneshot does
   * not heal anything — it RE-RUNS the job, once per reconciler tick, until the
   * give-up threshold escalates. For `papercusp-db-backup` that would mean
   * re-running a `pg_dump` every 60s. `service-health-unit-coverage.test.ts`
   * asserts this.
   */
  episodic?: boolean;
  /**
   * EI-21232345359778222: this unit's EXIT STATUS reports whether the RUN COMPLETED, not
   * whether its subject CONDITION is healthy. Supervision may therefore say "the last run
   * exited 0" about it — and may NEVER say "recovered", which is a claim about the condition.
   *
   * The distinction is not pedantic; it is the difference between a true and a false
   * all-clear. Read at the writer 2026-08-23: `live-federation-gate.sh` exits **0** on
   * `GATE: FRESH-RED (… still red, already tracked; NOT a green)` (line 563) and on
   * `GATE: FRESH-DOWNGRADE (… not a green)` — i.e. exit 0 spans GREEN, still-RED and
   * downgraded alike, because the exit code encodes "did this window have news", never the
   * verdict. Measured 2026-08-23 04:34 EDT: the unit started, freshness-suppressed an
   * unchanged tracked red, emitted `GATE: FRESH-RED`, exited 0/inactive — and supervision
   * broadcast `✅ … recovered` while WI-40905 was still red and no witness had rerun. A
   * reader acted on that all-clear and had to retract it.
   *
   * What supervision deliberately does NOT do here: read the gate's verdict bank
   * (`$STATE_DIR/verdicts.jsonl`, written by `bank_verdict`). `decideReconcile` is a pure,
   * domain-agnostic systemd oracle; teaching it one subsystem's verdict format would fork a
   * second gate-status reader with its own staleness bugs. The fix is to stop RENDERING a
   * run-level fact as a condition-level claim — the verdict stays the verdict writer's to
   * report, and the notification now says where to read it.
   *
   * INVARIANT: `exitEncodesRunOnly ⇒ episodic`. For a persistent service the exit status IS
   * the condition (the process is up or it is not), so the flag could only mislead there.
   * `service-health-unit-coverage.test.ts` asserts this.
   */
  exitEncodesRunOnly?: boolean;
  /**
   * EI-24811958626062774: hold this report-only entry's DOWN broadcast until the unit has been
   * continuously down for this many ms, and stay silent about a recovery that lands first.
   *
   * Report-only entries otherwise announce the first failed tick. That is right for a unit
   * that fails rarely and wrong for one that fails in short self-clearing streaks. Measured on
   * `papercup-staging-sync` over 3 days: 30 failure streaks, 14 of them a single failed run. A
   * first-tick alarm there emits about 20 down/recovered broadcasts a day, almost all noise,
   * and a channel that cries wolf is the one nobody reads when the 5-hour streak arrives.
   *
   * The clock counts the WHOLE episode, including runs in flight that did not recover it
   * (`decideReconcile` holds state across them), so it measures how long the subject has
   * actually been stuck. It is in-memory like the rest of the flap state: a bg-host restart
   * restarts the clock, which delays one alarm and never invents one.
   *
   * INVARIANT: `notifyAfterDownMs ⇒ !autoRestart`. A restart-capable entry already pages on
   * its own ladder (failed restart, give-up), and delaying that would hide a dead service.
   * `service-health-unit-coverage.test.ts` asserts this.
   */
  notifyAfterDownMs?: number;
}

/**
 * Initial supervised set, per the plan's Design section. Populate-only in
 * P-001 — nothing consumes this yet; P-002 (failed-unit reconciler) and P-004
 * (dev:service_health supervision block) are the first real readers.
 */
export const SUPERVISED_PROCESSES: SupervisionEntry[] = [
  // Already Restart=always at the systemd level (R4-1 drop-ins) — registry
  // entry is report-only/verify per the plan, not a second restart lever.
  { name: 'bg-host', layer: 'systemd-user', unit: 'papercusp-bg-host', criticality: 'critical', autoRestart: false },
  // EI-20067982007251440: bg-host's ONLY out-of-process recovery — and until now the
  // one supervised-adjacent unit nobody supervised. `bghost-watchdog.mjs` restarts
  // bg-host on ticker-silence (240s); the in-process reconciler CANNOT do that job,
  // because it runs INSIDE bg-host and freezes with it. Measured 2026-08-10: the
  // watchdog restarted a frozen bg-host at 11:00:30Z — while the same freeze had
  // halted git-sync, every scheduled routine, and the release gate fleet-wide. If
  // this watchdog is dark, that freeze has NO automatic recovery and nothing says so.
  //
  // `criticality: 'critical'` NOT because its own downtime breaks anything — bg-host
  // runs fine without it — but because its silence is a fleet-level EXPOSURE: the next
  // freeze goes unrecovered until a human happens to notice (~25min + luck, 2026-08-10).
  // A reader seeing this row down needs "act now", which 'important' under-states.
  //
  // ⚠ `autoRestart: true` DELIBERATELY DIVERGES from the `bg-host` entry directly
  // above, whose rationale ("already Restart=always, so a registry lever would be a
  // second restarter") does NOT transfer — and the difference is the whole point of
  // this entry. `Restart=always` fires on EXIT. It does nothing for a unit that was
  // administratively STOPPED, which stays down forever and looks identical to healthy
  // from every process-level view. That is not hypothetical: WI-5376 records the
  // federation gate's timer being externally stopped TWICE with no systemd-logged stop
  // client, silently meaning "the gate never runs again" until a human noticed. This
  // unit is the same shape and a worse blast radius, so it follows the
  // `live-federation-gate-timer` precedent (autoRestart: true), not the bg-host one.
  // Restarting it is safe + idempotent: it is a stateless poller with its own circuit
  // breaker (8/hr) and 5min debounce, so a restart re-polls rather than re-running a
  // job, and WI-5378's `isAdministrativelyPaused` still honours a deliberate pause
  // (`systemctl --user disable --now papercusp-bg-host-watchdog`) as report-only.
  { name: 'bg-host-watchdog', layer: 'systemd-user', unit: 'papercusp-bg-host-watchdog', criticality: 'critical', autoRestart: true },
  { name: 'operator', layer: 'systemd-user', unit: 'papercusp-dev-api', criticality: 'critical', autoRestart: true }, // :3070
  { name: 'staging-api', layer: 'systemd-user', unit: 'papercusp-staging-api', criticality: 'important', autoRestart: true }, // :3170
  // Folds the bespoke inference-gateway-watchdog's intent in; the watchdog
  // unit itself stays running until parity with this registry is proven (D-002).
  { name: 'inference-gateway', layer: 'systemd-user', unit: 'papercup-inference-gateway', criticality: 'critical', autoRestart: true },
  { name: 'mcp-proxy', layer: 'systemd-user', unit: 'papercup-mcp-proxy', criticality: 'important', autoRestart: true }, // :9071
  { name: 'substrate-sidecar', layer: 'node-child', criticality: 'important', autoRestart: true },
  { name: 'spawner-sidecar', layer: 'node-child', criticality: 'important', autoRestart: true }, // apps/operator/bin/spawner-sidecar.ts
  // Shared warm-model embedding process (P-002, shared-embedding-sidecar-and-
  // enrichment-2026-07-10). D-003: consumers fall back to in-process embedding
  // when it's down, so 'important' not 'critical'.
  { name: 'embed-sidecar', layer: 'node-child', criticality: 'important', autoRestart: true }, // apps/operator/bin/embed-sidecar.ts
  // supervised by the Tauri shell itself (P-005), not the server-side reconciler.
  { name: 'desktop-shell', layer: 'desktop-shell', criticality: 'critical', autoRestart: true },
  // A test gate, not a service — restarting it in a loop would re-run smokes.
  // Alert-only, mirrors the papercup-live-federation-gate HEALTH_ENDPOINTS-adjacent note.
  //
  // WI-6149 (D-010 item 4): `episodic: true`. This is a `Type=oneshot` unit on an
  // hourly timer (measured: 24 `Started` events in 24h of journal), so `inactive`
  // is its normal state between runs — and BEFORE this flag existed
  // `dev:service_health` reported `active: false` for it, which its own tool
  // description sells as "the unit is confirmed DOWN". VERIFIED live 2026-07-26:
  // the supervision block returned `{ name:'live-federation-gate', active:false }`
  // for a gate that had run successfully minutes earlier. It is also why arming
  // the (never-armed — EI-18746253391734322) reconciler as-is would have emitted
  // ~48 broadcasts/day for this one healthy unit: 24 down-transitions + 24
  // recoveries. Its `.timer` below is NOT episodic — an armed timer is genuinely
  // `active`/`waiting` continuously, so persistent semantics are correct there.
  //
  // EI-21232345359778222: `exitEncodesRunOnly: true`. The gate's exit code says whether the
  // WINDOW had news, not whether the federation is green — it exits 0 on `GATE: FRESH-RED`
  // ("still red, already tracked; NOT a green") exactly as it does on a real green. So a
  // down→up transition here means "the last run exited 0", never "recovered".
  { name: 'live-federation-gate', layer: 'systemd-user', unit: 'papercup-live-federation-gate', criticality: 'important', autoRestart: false, episodic: true, exitEncodesRunOnly: true },
  // WI-5376: the gate's *timer* has been externally stopped twice (Jul 17 + Jul 18) with no
  // systemd-logged stop client and NO supervision watching it — the reconciler above only ever
  // tracked the `.service` (deliberately report-only, per the comment on it), so a stopped timer
  // silently meant "the gate never runs again" until a human happened to notice. Restarting a
  // *timer* unit is safe to automate (unlike the service): it only re-arms the schedule, it never
  // touches an in-flight gate run. autoRestart:true so this heals itself within the reconciler's
  // normal backoff ladder, and — if something keeps killing it — the existing give-up escalation
  // pages loudly instead of the timer just staying dark.
  //
  // WI-5378: that auto-heal fought a DELIBERATE pause — `systemctl --user stop` alone reads
  // identically to a crash, so a leader-ordered pause got silently re-armed within minutes.
  // `unit-reconciler.ts`'s `isAdministrativelyPaused` now checks the unit's persisted
  // `UnitFileState` and treats `disabled`/`masked` as intentional (report-only, never
  // restarted) regardless of `autoRestart`. **To pause the gate, `systemctl --user disable
  // --now papercup-live-federation-gate.timer`** (a bare `stop` — or disabling the `.service`,
  // which is `static` and has no `[Install]` section — does NOT persist and WILL be undone).
  // `enable --now` to resume.
  { name: 'live-federation-gate-timer', layer: 'systemd-user', unit: 'papercup-live-federation-gate.timer', criticality: 'important', autoRestart: true },
  // EI-24811958626062774: the job that moves :3170 forward. `Type=oneshot`, `RemainAfterExit=no`,
  // fired ~every 5min by papercup-staging-sync.timer, so it is EPISODIC: idle `inactive` is
  // healthy and only `failed` is down. When it fails, :3170 keeps serving its last build while
  // staging moves on, and every agent verifying "current staging" there is reading stale code.
  // Nothing watched it: on 2026-10-01 it exited FATAL on every tick from 20:16Z for 5+ hours
  // (WorkingDirectory vs the `.current` alias) and was found only because one live verification
  // needed :3170.
  //
  // `autoRestart: false`: re-running a failed sync just repeats the same FATAL; the failure is in
  // the tree or the layout, which a restart cannot fix. `notifyAfterDownMs: 30min`: measured
  // over 3 days, 30 failure streaks; at 30 min the alarm fires on the 31-69 min streaks and the
  // 5-hour one, and stays quiet on the 14 single-run blips. The timer itself is not a separate
  // entry: a stopped timer is a different failure (it stops running at all) and has not been
  // observed here.
  { name: 'staging-sync', layer: 'systemd-user', unit: 'papercup-staging-sync', criticality: 'important', autoRestart: false, episodic: true, notifyAfterDownMs: 30 * 60_000 },
  // WI-6149 (D-010 item 4): the oddsmith sidecar — persistent, probed on :46229
  // (see HEALTH_ENDPOINTS). `autoRestart: false` follows the `bg-host` precedent
  // directly above: the unit is already `Restart=always` at the systemd level, so
  // a registry restart lever would be a SECOND restarter racing systemd's own,
  // not added resilience. `important` rather than `critical`: nothing in the
  // papercusp fleet's own critical path depends on it — it is a hosted workload
  // (its own embedded PG on :5544, its own DBOS engine).
  { name: 'oddsmith-sidecar', layer: 'systemd-user', unit: 'papercup-oddsmith-sidecar', criticality: 'important', autoRestart: false },
  // WI-38449 / D-007 finding 1: the host release-gate's PRODUCER was dead ~7h and
  // nothing detected it. Measured 2026-08-16: `papercup-perf-signals-capture.timer`
  // sat `failed (Result: resources)` from 2026-08-15T23:57:59Z — systemd could not
  // open the unit file ("Unit to trigger vanished") because these units are symlinked
  // into ~/.config/systemd/user through the repo tree and a peer tree op transiently
  // removed the target. systemd LATCHED failed; nothing re-armed it. Last capture
  // 2026-08-15T23:56:38Z against `PERF_BUDGETS.staleMs` 10min — ~42x over — so the
  // host SLO/CLOSE_WAIT guard was blind for the whole window.
  //
  // Why the existing `blindMs` branch was not enough: it detects the ARTEFACT going
  // stale (>30min ⇒ `warn` naming this timer, perf-budgets.ts), which is the EFFECT,
  // reached only when something evaluates the verdict AND surfaces a non-`pass`
  // action. It says nothing about the unit, and it cannot re-arm anything. This entry
  // watches the CAUSE, and heals it.
  //
  // Deliberately the `.timer` ONLY, not `papercup-perf-signals-capture.service`. That
  // service is `Type=oneshot` (verified: `systemctl --user show -p Type`), so it is the
  // `papercusp-db-backup` shape NON_PROBED_UNITS rules out as `episodic-oneshot`:
  // liveness is the wrong question when `inactive` is the healthy state between ticks,
  // and its last-run RESULT is already served — here by perf-budgets.ts's `blindMs`
  // branch, which names this timer explicitly. Registering the oneshot would add a
  // second, worse answer to a question already answered.
  //
  // An ARMED timer, by contrast, is continuously `active`/`waiting`, so the persistent
  // oracle is correct for it and `episodic` must stay unset — marking it episodic would
  // mask exactly the stopped/failed timer this entry exists to catch (the same
  // reasoning as `live-federation-gate-timer` above, whose WI-5376 incident was a timer
  // externally stopped with nothing watching). `autoRestart: true` for the same reason
  // it is safe there: restarting a *timer* only re-arms the schedule, it never touches
  // an in-flight capture, and the capture is a stateless 2-min snapshot.
  //
  // Verified this will not be inert: `UnitFileState=enabled` (same as the
  // live-federation-gate timer), so WI-5378's `isAdministrativelyPaused` does NOT treat
  // it as a deliberate pause. To pause it deliberately, `systemctl --user disable --now
  // papercup-perf-signals-capture.timer` — a bare `stop` will be re-armed.
  //
  // ⚠ Scope, honestly: auto-restart re-arms a STOPPED or FAILED timer. It does not fix
  // the root symlink breakage — while the unit file is genuinely absent the restart
  // fails too (recovery there needs `systemctl --user daemon-reload` once the target is
  // back). What this converts is the silent-forever case into a visible, escalating one.
  { name: 'perf-signals-capture-timer', layer: 'systemd-user', unit: 'papercup-perf-signals-capture.timer', criticality: 'important', autoRestart: true },
];

/**
 * Selector for P-002 (reconciler tick) / P-004 (service_health supervision
 * block): the full registry, or filtered by layer/autoRestart. Pure + sync —
 * no I/O, so it's trivially unit-testable and safe to call every tick.
 */
export function supervisedProcesses(filter?: { layer?: SupervisionLayer; autoRestart?: boolean }): SupervisionEntry[] {
  if (!filter) return SUPERVISED_PROCESSES;
  return SUPERVISED_PROCESSES.filter(
    (e) =>
      (filter.layer === undefined || e.layer === filter.layer) &&
      (filter.autoRestart === undefined || e.autoRestart === filter.autoRestart),
  );
}

export async function probeAll(specs?: EndpointSpec[]): Promise<ProbeResult[]> {
  // The Tauri desktop has no HTTP endpoint — probe it from its local signals
  // (bridge eval + IPC socket + recent error toasts) alongside the HTTP ones; the
  // bg-host DBOS ticker has no port either — probe it from routine fire-freshness (EI-1832);
  // the substrate sidecar (WI-899) is a third portless process, probed via its own IPC RPC;
  // the embed sidecar HAS a port but is opt-in, so its probe is present:false-aware
  // rather than a raw HEALTH_ENDPOINTS entry (phantom-DOWN guard).
  const probeSpecs = specs ?? resolveHealthEndpoints();
  const [http, desktop, bgHostTicker, bgHostCode, mcpProxyCode, substrateSidecar, embedSidecar, journalCanary] = await Promise.all([
    Promise.all(probeSpecs.map((s) => probeEndpoint(s))),
    probeDesktop(),
    probeBgHostTicker(),
    probeBgHostCodeDrift(),
    probeMcpProxyCodeDrift(),
    probeSubstrateSidecar(),
    probeEmbedSidecar(),
    probeJournalCanary(),
  ]);
  return [...http, desktop, bgHostTicker, bgHostCode, mcpProxyCode, substrateSidecar, embedSidecar, journalCanary];
}

/**
 * Probe one named service using the same implementations as `probeAll`.
 *
 * This is intentionally a fail-open lookup: callers that name an event-only or
 * otherwise unknown service get `null` and can retain the edge-triggered wait,
 * while known monitored services get a fresh authoritative reading without
 * paying for unrelated probes. `present:false` remains part of the result so
 * callers do not mistake an absent/disabled optional service for HEALTHY.
 */
export async function probeNamedService(name: string): Promise<ProbeResult | null> {
  const endpoint = resolveHealthEndpoints().find((spec) => spec.name === name);
  if (endpoint) return probeEndpoint(endpoint);

  switch (name) {
    case PORTLESS_PROBE_NAMES.desktop:
      return probeDesktop();
    case PORTLESS_PROBE_NAMES.bgHostTicker:
      return probeBgHostTicker();
    case PORTLESS_PROBE_NAMES.bgHostCode:
      return probeBgHostCodeDrift();
    case PORTLESS_PROBE_NAMES.mcpProxyCode:
      return probeMcpProxyCodeDrift();
    case PORTLESS_PROBE_NAMES.substrateSidecar:
      return probeSubstrateSidecar();
    case PORTLESS_PROBE_NAMES.embedSidecar:
      return probeEmbedSidecar();
    case PORTLESS_PROBE_NAMES.journalCanary:
      return probeJournalCanary();
    default:
      return null;
  }
}

export interface HealthTransition {
  name: string;
  to: 'up' | 'down';
}

/**
 * Pure transition detector: compare the latest probe to the last-known
 * up/down per endpoint. Returns only ENDPOINTS THAT CHANGED (transition-only
 * — never the full set), plus the next state map to persist. A name absent
 * from `prev` is treated as previously-up (so a first-seen DOWN alerts, a
 * first-seen UP is silent — no startup spam).
 */
export function diffHealth(
  prev: Record<string, boolean>,
  now: ProbeResult[],
): { transitions: HealthTransition[]; next: Record<string, boolean> } {
  const transitions: HealthTransition[] = [];
  const next: Record<string, boolean> = { ...prev };
  for (const r of now) {
    if (r.present === false) {
      // A legitimately-absent service (e.g. the desktop is not running): forget
      // it — don't alert a phantom DOWN, and don't fire a false "recovered" when
      // it comes back (it'll be a silent first-seen-up instead).
      delete next[r.name];
      continue;
    }
    const was = prev[r.name] ?? true; // unknown → assume up (only alert on a real drop)
    if (was !== r.up) {
      transitions.push({ name: r.name, to: r.up ? 'up' : 'down' });
    }
    next[r.name] = r.up;
  }
  return { transitions, next };
}

/**
 * EI-18144960689849695 (service-down:desktop flap volume — 500+ up/down
 * transitions since 2026-07-04, ~one every 45min, still recurring after both
 * prior desktop-flap fixes: EI-7760's per-port discovery fix and
 * EI-18131725582506957's single ipc-connect retry). Root cause of the
 * REMAINING flaps: `diffHealth` (below) transitions on a SINGLE bad probe
 * tick with no debounce — exactly the mechanism the EI-18131725582506957 doc
 * comment already named as the enabler of that (narrower, now-fixed) bug
 * class. The single retry in `realIpcConnectable` only bridges ONE specific
 * known transient window (a routine operator restart's stop→re-exec); it
 * does not cover other benign single-tick blips (a webview-eval hiccup, a
 * momentary accept-queue delay under this box's heavy concurrent-agent
 * load). Live-confirmed on 2026-07-20 06:33-06:46Z: `desktop` reported DOWN
 * for ~13 consecutive minutes with `papercusp-staging-api.service` NEVER
 * restarted in that window (systemd ActiveEnterTimestamp/NRestarts
 * unchanged) — i.e. a real multi-tick flap unrelated to either previously-
 * fixed cause, self-clearing with no operator action.
 *
 * Fix: require N CONSECUTIVE bad ticks before a name is reported down to any
 * consumer (coord broadcast, the `collectServiceDownSignals` watchdog
 * EI-filer, `dev:service_health`) — a single good tick clears the streak
 * immediately (fast-recover, slow-alarm: standard flap damping). This
 * generalizes the intent already on record in the EI-18131725582506957
 * comment instead of adding a fourth narrow per-cause patch.
 *
 * WI-6146 / P-013 (plan bash-to-tool-substitution-2026-07-26) generalized it
 * the rest of the way, from a desktop-only special case to the per-probe
 * `DOWN_CONFIRM_TICKS` map below, when `staging-api` (:3170) became a probed
 * endpoint. Damping is OPT-IN per name; everything absent from that map keeps
 * today's single-tick alerting.
 *
 * NB — this SUPERSEDES a claim that used to live here, namely that ":3170
 * staging, watched by `dev:restart` drains" must keep single-tick detection.
 * That was written while :3170 was not probed at all, and it does not survive
 * checking: `dev:restart`'s drain drains LOCK HOLDERS (it acquires
 * exclusive(<target>-server) and drains agents currently using the resource)
 * and never reads `lastServiceHealth()` or any probe result. Nothing
 * operational depends on single-tick detection of :3170, so the restart-blip
 * false alarms it would produce buy nothing. See `staging-api` in
 * HEALTH_ENDPOINTS for the measured restart rate behind that call.
 */
export const DESKTOP_DOWN_CONFIRM_TICKS = 2;

/**
 * The operator probe resolves through `operatorApiBase()` to the current
 * packaged listener. A single refused preflight can coincide with its brief
 * restart/startup window, so use the same two-tick confirmation as the
 * explicitly probed staging listener. A sustained outage still confirms on
 * the next 60s health tick.
 */
export const OPERATOR_DOWN_CONFIRM_TICKS = 2;

/**
 * WI-6146: damping is LOAD-BEARING for `staging-api`, not a nicety — without
 * it, adding the :3170 probe would have manufactured ~50 false DOWN
 * broadcasts/day.
 *
 * `staging-api` is cycled by TWO independent restarters, and only the smaller
 * one is visible in the audit log:
 *   - `dev:restart { target:'staging' }` when an agent loads a server-side
 *     edit — 7-11/day in `harness_shared.audit_log`.
 *   - DOMINANT, and invisible to that query: `papercup-staging-sync.timer`
 *     restarts the unit with a raw `systemctl --user restart` roughly every
 *     5-6 min whenever `staging` has advanced, hard-cycling it (SIGKILL,
 *     ~10-13s down). This is EI-13221's finding, and it is why
 *     `RECENT_RESTART_WINDOW_SEC` below exists for the supervision block.
 *
 * So the real duty cycle is ~12s down per ~330s ≈ 3.6%. Against this file's
 * 60s tick (`in-process-periodic.ts` serviceHealthCheck) a SINGLE-tick alarm
 * would fire on ~3.6% of 1,440 daily ticks ≈ 50 phantom DOWNs — each one a
 * coord broadcast to '*', a `service:down:staging-api` event, and a candidate
 * watchdog EI. That is exactly the "chronic false-alarm that trains agents to
 * ignore service-health reds" this file's HEALTH_ENDPOINTS NB warns about.
 *
 * Two ticks is PROVABLY sufficient here rather than merely better: consecutive
 * ticks are 60s apart and the restart window is ≤13s, so two consecutive ticks
 * cannot both land inside one restart. A genuinely dead :3170 stays down
 * across ticks and still alarms, one tick (60s) later.
 */
export const STAGING_API_DOWN_CONFIRM_TICKS = 2;

/**
 * Per-probe flap damping: consecutive bad ticks required before a name is
 * reported DOWN. A name ABSENT from this map is undamped (1 tick) — that is
 * the default, so adding an endpoint never silently delays its alerting.
 * Keyed by `ProbeResult.name` rather than hung off `EndpointSpec` because the
 * portless probes (`desktop`, bg-host-ticker, the sidecars) have no spec.
 */
/**
 * WI-6149 (D-010 item 4): `oddsmith-sidecar` cycles, so adding its probe
 * without damping would manufacture false DOWNs — the same reasoning as
 * `staging-api`, with the rate measured the same way (by enumerating the
 * WRITERS, never from `harness_shared.audit_log`, which sees only `dev:restart`
 * TOOL calls and undercounted staging-api's true rate ~25×).
 *
 * MEASURED from the unit's own journal, 2026-07-26:
 *   - restart RATE: 22 `Started` events on Jul 25, 21 on Jul 26 — ~1/hour.
 *     Writers are agents' raw `systemctl --user restart` (28 corpus atoms in 7d;
 *     the unit is not a `dev:restart` target) plus systemd's own
 *     `Restart=always` recoveries.
 *   - down WINDOW per restart: ≤2s. systemd `Stopping → Started` is 0-1s, and
 *     the listener is back within another ~1s (`Started 14:10:16` →
 *     `hono host listening on http://127.0.0.1:46229` at `14:10:17`).
 *
 * So the undamped exposure is ~22 × 2s = 44s/day ≈ 0.05% of wall clock; against
 * the 60s tick that is <1 phantom DOWN/day — far lower than staging-api's ~50,
 * but each one is still a coord broadcast to '*' and a candidate watchdog EI, so
 * it is worth eliminating rather than tolerating.
 *
 * Two ticks is PROVABLY sufficient, not merely better, by the same argument
 * WI-6146 used: consecutive ticks are 60s apart and the restart window is ≤2s,
 * so two consecutive ticks cannot both land inside one restart. A genuinely
 * dead sidecar stays down across ticks and still alarms, 60s later.
 */
export const ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS = 2;

/**
 * EI-19375157952766991: `bg-host-ticker` was the one portless probe left
 * UNDAMPED — a single bad tick reported it DOWN immediately, unlike every
 * sibling probe above (desktop/staging-api/oddsmith-sidecar), each of which
 * was damped for exactly this reason after a measured single-tick false-alarm
 * incident. `probeBgHostTicker` reads `MAX(last_fired_at)` fleet-wide over a
 * live PG connection on every tick; a single transient read (a momentary pool
 * stall, a slow query under this box's heavy concurrent-agent load, or a
 * genuinely-brief tick-duration blip in the routine engine itself — see
 * `deadRoutineOverdueMsForCiWindow`'s doc comment for the same class of
 * transient elsewhere in this alarm family) can read as stale for one tick
 * and self-clear by the next. Measured live 2026-08-02 20:26-20:28Z: the
 * ticker probe fired `bg-host-ticker is DOWN` (⚠ no routine has fired in 16m)
 * prescribing a destructive `service-restart lane` remediation for a healthy
 * service — `git log` showed git-sync committing continuously through the
 * whole window (largest gap 7.0min, well under the 15min `BG_HOST_STALE_MS`
 * threshold), and re-running the probe's own exact query moments later
 * returned an age of 7s. Two ticks is provably sufficient here by the same
 * argument as `staging-api`/`oddsmith-sidecar`: this probe runs on the same
 * 60s service-health tick, so two consecutive bad ticks require the false
 * reading to persist ≥60s — well past the self-clearing blip actually
 * observed — while a genuinely frozen ticker (BG_HOST_STALE_MS=15min of no
 * fires) stays down across ticks and still alarms, 60s later.
 */
export const BG_HOST_TICKER_DOWN_CONFIRM_TICKS = 2;

/**
 * EI-21524175314121282: the embed sidecar's functional probe can exceed its
 * deliberately tight 1.2s budget during a transient model/transport hiccup.
 * Keep the bounded probe itself unchanged, but require a second consecutive
 * bad service-health tick before treating the configured sidecar as DOWN. A
 * genuinely unavailable sidecar still confirms on the next 60s tick.
 */
export const EMBED_SIDECAR_DOWN_CONFIRM_TICKS = 2;

/**
 * EI-15810: journald ingestion of a healthy `--user` unit's forwarded stdout is
 * normally sub-second, but a momentary scheduling/IO blip on this heavily-loaded box
 * could in principle push one canary past its landing-delay window without the
 * host-wide wedge EI-2434 diagnosed actually being present. Two ticks costs nothing
 * (a real wedge, once present, does not self-clear — it stays down until the human
 * reboot/relogin) and matches the precedent every other single-signal portless probe
 * in this file follows (`bg-host-ticker`, `embed-sidecar`).
 */
export const JOURNAL_CANARY_DOWN_CONFIRM_TICKS = 2;

export const DOWN_CONFIRM_TICKS: Readonly<Record<string, number>> = {
  [PORTLESS_PROBE_NAMES.desktop]: DESKTOP_DOWN_CONFIRM_TICKS,
  operator: OPERATOR_DOWN_CONFIRM_TICKS,
  'staging-api': STAGING_API_DOWN_CONFIRM_TICKS,
  [PORTLESS_PROBE_NAMES.bgHostTicker]: BG_HOST_TICKER_DOWN_CONFIRM_TICKS,
  'oddsmith-sidecar': ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS,
  [PORTLESS_PROBE_NAMES.embedSidecar]: EMBED_SIDECAR_DOWN_CONFIRM_TICKS,
  [PORTLESS_PROBE_NAMES.journalCanary]: JOURNAL_CANARY_DOWN_CONFIRM_TICKS,
};

let downStreaks: Record<string, number> = {};

/**
 * Pure debounce step: for each damped probe, increments/resets a
 * consecutive-bad-tick streak and, while under its confirm threshold,
 * rewrites the exposed result to `up: true` (annotated) so downstream
 * consumers never see the not-yet-confirmed blip. Undamped names pass
 * through untouched. Exported for direct unit testing.
 *
 * A name missing from `results` this tick drops out of the returned streaks
 * (equivalent to a reset), matching the pre-generalization behaviour.
 */
export function applyDownConfirmDebounce(
  results: ProbeResult[],
  streaks: Record<string, number>,
  confirmTicksByName: Readonly<Record<string, number>> = DOWN_CONFIRM_TICKS,
): { results: ProbeResult[]; nextStreaks: Record<string, number> } {
  const nextStreaks: Record<string, number> = {};
  let out = results;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const confirmTicks = confirmTicksByName[r.name] ?? 1;
    // Undamped, recovered, or legitimately absent → no streak to carry.
    if (confirmTicks <= 1 || r.present === false || r.up) continue;
    const streak = (streaks[r.name] ?? 0) + 1;
    nextStreaks[r.name] = streak;
    if (streak >= confirmTicks) continue; // confirmed — expose the real DOWN
    if (out === results) out = results.slice();
    out[i] = {
      ...r,
      up: true,
      note: `unconfirmed down (streak ${streak}/${confirmTicks}) — ${r.note ?? 'no detail'}`,
    };
  }
  return { results: out, nextStreaks };
}

// Cross-tick last-known state. A module singleton (not PG): on operator
// restart it resets, and diffHealth's unknown-as-up default means a restart
// re-alerts only services that are actually DOWN — no spurious spam.
let lastHealth: Record<string, boolean> = {};

const HEALTH_IDENTITY: AgentIdentity = {
  ownerId: 'service-health',
  ownerLabel: 'service-health',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Last probe results (for the on-demand status tool / UI). */
let lastResults: ProbeResult[] = [];
/**
 * When `lastResults` was last populated (epoch ms), or null if never probed this
 * process. The watchdog's service-down collector reads this to skip a STALE
 * snapshot — if the probe workflow has stopped, the module singleton would
 * otherwise feed the watchdog phantom up/down data (watchdog-robustness P-004).
 */
let lastResultsAt: number | null = null;
export function lastServiceHealth(): ProbeResult[] {
  return lastResults;
}
/** Epoch-ms timestamp of the last probe, or null if never probed (P-004). */
export function lastServiceHealthAt(): number | null {
  return lastResultsAt;
}

/**
 * Debounce raw probe results against the persistent confirm-ticks streaks
 * (`DOWN_CONFIRM_TICKS` / `applyDownConfirmDebounce`) and update the module
 * snapshot (`lastServiceHealth()` / `lastServiceHealthAt()`) — the ONE shared
 * source of truth every consumer reads (the coord broadcast below, `dev:
 * service_health`, and the watchdog's `service-down` collector).
 *
 * Exported so a caller that probes OUTSIDE the normal 60s tick applies the
 * SAME confirm-ticks damping instead of feeding a raw, undebounced single
 * probe straight to its own consumer. Concretely: `serviceDownCollectorResult`'s
 * inline-probe-on-stale fallback (R4-7, watchdog.ts) used to call `probeAll()`
 * directly and hand the raw result to `collectServiceDownSignals` — bypassing
 * `applyDownConfirmDebounce` entirely and silently reintroducing the exact
 * single-tick flap class WI-6146 damped `staging-api`/`desktop`/
 * `oddsmith-sidecar` against, specifically for the watchdog's auto-filed
 * `service-down` bug tickets (which never went through the periodic tick's
 * debounce at all). Live-confirmed: EI-19363229944812169 filed a
 * `service-down: staging-api` bug ~51s after a routine ≤13s restart-drain
 * cycle — well inside a single damped streak, and exactly the shape this
 * fallback path could produce undebounced.
 */
export function recordProbeResults(rawResults: ProbeResult[]): ProbeResult[] {
  const { results, nextStreaks } = applyDownConfirmDebounce(rawResults, downStreaks);
  downStreaks = nextStreaks;
  lastResults = results;
  lastResultsAt = Date.now();
  return results;
}

/**
 * One service-health tick: probe all endpoints, broadcast a coord MESSAGE
 * (not notify — D-002) on each up/down transition. Driven by the in-process
 * periodic scheduler. Returns the transitions for logging/tests.
 */
export async function runServiceHealthTick(): Promise<{ checked: number; transitions: HealthTransition[] }> {
  const rawResults = await probeAll();
  const results = recordProbeResults(rawResults);
  const { transitions, next } = diffHealth(lastHealth, results);
  lastHealth = next;
  for (const t of transitions) {
    const r = results.find((x) => x.name === t.name);
    const downDetail = r?.note
      ? ` — ${r.note}`
      : r?.status
        ? ` (HTTP ${r.status})`
        : ' (no response)';
    const summary =
      t.to === 'down'
        ? `⚠ service "${t.name}" is DOWN${downDetail}`
        : `✅ service "${t.name}" recovered`;
    // P-033 (d): `auto` marks it machine lifecycle chatter, which also carries
    // the `expects:'none'` stamp at the sendMessage seam. Set explicitly because
    // `service-health` does not match the conservative MACHINE_SENDER_PATTERN.
    await sendMessage(HEALTH_IDENTITY, {
      to: ['*'],
      summary,
      category: 'service-health',
      extra: { auto: true },
    }).catch(() => {});
    // P-104: also fire the awaitable key so "block until recovered" (events:await
    // service:up:<name>) replaces re-polling dev:service_health. Fire-and-forget;
    // transition-only by construction (diffHealth already returns only changes).
    emitServiceHealthTransitionEvent(t.name, t.to, r?.note);
  }
  return { checked: results.length, transitions };
}

/** Test-only — reset the cross-tick state. */
export function _resetServiceHealthState(): void {
  lastHealth = {};
  lastResults = [];
  lastResultsAt = null;
  downStreaks = {};
}
