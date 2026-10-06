/**
 * Types for the mcp-proxy watchdog's pure decision surface.
 *
 * `watchdog.mjs` is plain ESM (it is a bare `node watchdog.mjs` systemd entrypoint, so it
 * must stay runnable without a build step). Importing it from TypeScript therefore raised
 * TS7016 — "implicitly has an 'any' type" — which silently erased type checking for every
 * assertion in watchdog.test.ts: the tests would still have compiled if a verdict string
 * were misspelled or an argument dropped. Declaring the surface here restores that safety
 * without asking the entrypoint to become TypeScript.
 *
 * Only the PURE, exported decision functions appear here. The poll loop, the network probe
 * and the systemctl call are deliberately unexported and untyped — they are side-effecting
 * and are exercised end-to-end against a live endpoint, not unit-tested.
 */

/** Verdict for one session-plane probe. See classifyProbeResult in watchdog.mjs. */
export type ProbeKind = 'ok' | 'auth' | 'empty' | 'dead';

/**
 * Verdict for one DATA-plane probe (WI-6739). 'config' is deliberately distinct from 'dead':
 * a probe we mis-configured must never alarm as a service fault.
 */
export type DataPlaneKind = 'ok' | 'config' | 'dead';

/** Remediation chosen from a proxy probe plus a same-moment upstream probe. */
export type HandshakeAction = 'none' | 'restart-proxy' | 'upstream-wedged';

/**
 * The liveness path (WI-6743) — re-exported from budgets.mjs, which proxy.ts also imports, so
 * the probe and the route it probes cannot drift apart. MUST be proxy-local: a forwarded path
 * cannot answer while retry-on-refused holds a request through a :3070 restart.
 */
export const LIVENESS_PROBE_PATH: string;

export function livenessProbeUrl(port?: number): string;

/** Runtime files loaded by the proxy service from the integration working tree. */
export const MCP_PROXY_COMMITTED_HOT_PATHS: readonly string[];

export type MpcProxyHotPathActivationCode =
  | 'activate'
  | 'generation_unknown'
  | 'clock_unknown'
  | 'commit_unknown'
  | 'commit_time_future'
  | 'generation_current'
  | 'cleanliness_unknown'
  | 'hot_paths_dirty'
  | 'throttled_or_in_flight'
  | 'ptool_failed'
  | 'ptool_result_unknown'
  | 'restart_suppressed'
  | 'restarted'
  | 'coalesced'
  | 'no_restart'
  | 'probe_failed';

export interface MpcProxyHotPathActivationInput {
  activeForSec: number | null;
  latestCommitMs: number | null;
  latestCommitHash: string | null;
  nowMs: number | null;
  dirtyEntries: string[] | null;
}

export interface MpcProxyHotPathActivationVerdict {
  activate: boolean;
  code: MpcProxyHotPathActivationCode | string;
  bootMs?: number;
  latestCommitMs?: number;
  latestCommitHash?: string;
  dirtyCount?: number;
  dirtySample?: string[];
}

/** Fail-closed gate for activating newer committed proxy code. */
export function evaluateMcpProxyHotPathActivation(
  input: MpcProxyHotPathActivationInput,
): MpcProxyHotPathActivationVerdict;

/** Throttle/reentrancy gate for the low-frequency committed-code check. */
export function shouldCheckMcpProxyHotPathActivation(input: {
  inFlight: boolean;
  lastCheckMs: number;
  nowMs: number;
  intervalMs: number;
}): boolean;

export interface MpcProxyHotPathShellResult {
  err: Error | null;
  stdout: string;
  stderr?: string;
}

export interface MpcProxyHotPathShellOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  stdin?: string;
  timeout?: number;
}

/** Read committed proxy generation evidence; unreadable signals remain unknown. */
export function readMcpProxyHotPathState(deps?: {
  root?: string;
  sh?: (
    command: string,
    args: string[],
    options?: MpcProxyHotPathShellOptions,
  ) => Promise<MpcProxyHotPathShellResult>;
}): Promise<{
  root: string | null;
  latestCommitMs: number | null;
  latestCommitHash: string | null;
  dirtyEntries: string[] | null;
  error: string | null;
}>;

/** Invoke the coordinated restart surface for the mcp-proxy service. */
export function requestMcpProxyHotPathRestart(
  latestCommitHash: string,
  deps?: {
    ptoolScript?: string;
    sh?: (
      command: string,
      args: string[],
      options?: MpcProxyHotPathShellOptions,
    ) => Promise<MpcProxyHotPathShellResult>;
  },
): Promise<{
  ok: boolean;
  restarted: boolean;
  coalesced: boolean;
  code: MpcProxyHotPathActivationCode | string;
  body?: unknown;
  error?: string;
}>;

export function shouldRestart(
  unreachableSinceMs: number,
  nowMs: number,
  thresholdMs?: number,
): boolean;

/** Rolling-window verdict for stall RATE (WI-6744). Returns the pruned event list. */
export function evaluateStallRate(
  eventTimesMs: number[],
  nowMs: number,
  windowMs?: number,
  threshold?: number,
): { kept: number[]; count: number; escalate: boolean; windowMs: number; threshold: number };

export function classifyProbeResult(result?: {
  networkError?: unknown;
  status?: number;
  json?: unknown;
}): ProbeKind;

export function classifyDataPlaneResult(result?: {
  networkError?: unknown;
  status?: number;
  json?: unknown;
}): DataPlaneKind;

/**
 * Arguments for the data-plane probe call (WI-6739). `invalid` reports a malformed
 * PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_ARGS override, which is logged rather than silently
 * replaced with args belonging to a different tool.
 */
export function dataPlaneProbeArgs(
  tool: string,
  rawArgs?: string | null,
  defaultTool?: string,
): { args: Record<string, unknown>; invalid: boolean };

export function decideHandshakeAction(
  proxyKind: ProbeKind | string,
  upstreamKind: ProbeKind | string,
): HandshakeAction;

/** WI-39378 — verdict of the final re-confirmation before an in-flight-call-killing restart. */
export type RestartRecheckDecision = 'stand-down-recovered' | 'stand-down-recheck-ok' | 'restart';

/**
 * WI-39378 — the last gate before restarting the proxy. `failingSince` is the epoch ms the
 * session plane started failing (0 = a concurrent poll already saw it recover);
 * `recheckKind` is a FRESH probe verdict, or null when only the first check applies.
 */
export function decideRestartAfterRecheck(
  failingSince: number,
  recheckKind: ProbeKind | string | null,
): RestartRecheckDecision;

/**
 * The JSON-RPC `coord:escalate` call body a CRITICAL verdict sends (EI-19415174699106397).
 * Pure — builds the request shape only; the network POST + credential read stay unexported and
 * untested directly (same convention as the probe/restart side effects above).
 */
export function buildEscalationCall(
  conditionKey: string,
  summary: string,
  body?: string,
): {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: {
    name: 'coord:escalate';
    arguments: {
      severity: 'blocker';
      summary: string;
      body?: string;
      conditionKey: string;
      evidence: { band: 'observed'; reportedBy: string };
    };
  };
};
