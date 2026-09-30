/**
 * harness-profile.ts — the DECLARED capability matrix for each spawn backend.
 *
 * Borrowed from yc-software/qm's `HarnessAdapterProfile` (src/harness/harness.ts),
 * whose adapters declare `{ controlTransport, toolTransport, capabilities }` and are
 * pinned by a single cross-adapter conformance test. The lesson worth taking is not
 * the shape but the INVERSION: qm's core asks the adapter "do you support X?",
 * where ours asked `agentBackend === 'claude-code'` inline at ~20 sites in
 * `invoke.ts`. Inline equality has two costs we actually paid:
 *
 *   1. Adding a backend means finding every branch. Nothing forces the sweep, so a
 *      path silently keeps the wrong default — which is how the claude-code spawn
 *      leg rotted unnoticed while omp was the default (documented in the session
 *      memory for 2026-05-31: claude-code worked standalone with the exact spawn
 *      flags, but the orchestrator's own invoke() captured zero stdout).
 *   2. `backend === 'codex' || backend === 'omp'` states a CONCLUSION ("these two")
 *      rather than the REASON ("these two have no usable native sandbox"). The
 *      reason is what a new backend needs to answer.
 *
 * Every field below is derived from a branch that exists in `invoke.ts` today —
 * no capability is invented for symmetry. `harness-profile.test.ts` pins the whole
 * matrix, so adding a backend fails the build until it declares itself.
 *
 * This does NOT change behavior: each accessor returns exactly what the inline
 * conditional it replaces returned.
 */

import { AGENT_BACKENDS, type AgentBackend } from './types';

/** How the backend's structured event stream is framed. */
export type HarnessStreamFormat = 'claude-stream-json' | 'omp-json' | 'codex-json';

/** Provider bucket used for subprocess usage attribution + shared rate-limit pacing. */
export type HarnessProvider = 'anthropic' | 'openai' | 'unknown';

/** How the prompt text reaches the child process. */
export type HarnessPromptDelivery =
  /** Written to the child's stdin (claude-code). */
  | 'stdin'
  /** Spilled to a temp file, passed as a trailing `@<path>` argv entry (omp). */
  | 'argv-file'
  /** Piped to stdin, addressed by a trailing `-` positional (codex exec). */
  | 'stdin-dash';

/**
 * A capability is listed here only when some code path branches on it. Names state
 * the PROPERTY, not the backend that happens to have it.
 */
export type HarnessCapability =
  /** Has its own OS sandbox, so the spawn is not wrapped in `srt`. */
  | 'native-sandbox'
  /** Accepts a caller-supplied session id (`--session-id`) for a tracked launch. */
  | 'native-session-id'
  /** Keeps a durable per-session config dir that `--resume` must find again. */
  | 'resumable-config-dir'
  /** Ships a built-in subagent/Task launcher that must be denied (owner mandate 2026-07-02). */
  | 'subagent-tools'
  /** Supports replacing the vendor's base system prompt with our own preamble. */
  | 'system-prompt-override'
  /** Routed through the inference gateway via a generated models.yml overlay. */
  | 'gateway-models-yml';

export interface HarnessAdapterProfile {
  readonly id: AgentBackend;
  /** Provider the backend deterministically targets; `unknown` means multi-provider. */
  readonly provider: HarnessProvider;
  /** True when the backend owns provider pacing/fallback and the host only caps concurrency. */
  readonly selfPacing: boolean;
  readonly streamFormat: HarnessStreamFormat;
  readonly promptDelivery: HarnessPromptDelivery;
  /** Flag spelling for the model id — codex takes a bare `-m <id>`. */
  readonly modelFlag: '--model' | '-m';
  /** Egress domains the `srt` wrapper must allow for this backend's model API. */
  readonly srtModelDomains: readonly string[];
  readonly capabilities: ReadonlySet<HarnessCapability>;
}

const profile = (
  id: AgentBackend,
  provider: HarnessProvider,
  selfPacing: boolean,
  streamFormat: HarnessStreamFormat,
  promptDelivery: HarnessPromptDelivery,
  modelFlag: '--model' | '-m',
  srtModelDomains: readonly string[],
  capabilities: readonly HarnessCapability[],
): HarnessAdapterProfile => ({
  id,
  provider,
  selfPacing,
  streamFormat,
  promptDelivery,
  modelFlag,
  srtModelDomains,
  capabilities: new Set(capabilities),
});

const PROFILES: Readonly<Record<AgentBackend, HarnessAdapterProfile>> = {
  'claude-code': profile('claude-code', 'anthropic', false, 'claude-stream-json', 'stdin', '--model', [], [
    'native-sandbox',
    'native-session-id',
    'resumable-config-dir',
    'subagent-tools',
    'system-prompt-override',
  ]),
  omp: profile('omp', 'unknown', true, 'omp-json', 'argv-file', '--model', [], ['gateway-models-yml']),
  codex: profile(
    'codex',
    'openai',
    false,
    'codex-json',
    'stdin-dash',
    '-m',
    // srt confines egress; codex talks to the OpenAI endpoints.
    ['api.openai.com', 'chatgpt.com', 'auth.openai.com', '*.openai.com'],
    ['resumable-config-dir'],
  ),
};

export function harnessProfile(backend: AgentBackend): HarnessAdapterProfile {
  const found = PROFILES[backend];
  if (!found) {
    // Unreachable for a declared backend; a new AgentBackend member without a
    // profile is caught by harness-profile.test.ts before it can ship.
    throw new Error(`no harness profile declared for backend '${String(backend)}'`);
  }
  return found;
}

export function harnessSupports(backend: AgentBackend, capability: HarnessCapability): boolean {
  return harnessProfile(backend).capabilities.has(capability);
}

/** Every declared profile — for the conformance test and for diagnostics. */
export function allHarnessProfiles(): readonly HarnessAdapterProfile[] {
  return AGENT_BACKENDS.map((b) => harnessProfile(b));
}
