export type InteractiveBackend = 'claude' | 'codex' | 'omp';
export type SpawnBackendLike = InteractiveBackend | 'claude-code' | 'anthropic-direct';
export type BackendAccountProvider = 'claude' | 'codex';

export type BackendFeature =
  | 'fresh-su'
  | 'resume'
  | 'role-session'
  | 'launch-context'
  | 'saved-prompts'
  | 'slash-tool-prompts'
  | 'account-pinning'
  | 'gateway-routing'
  | 'file-lock-enforcement'
  | 'native-fork'
  | 'native-web-search'
  | 'native-code-review'
  | 'native-image-input'
  | 'native-image-generation'
  | 'native-subagents'
  | 'native-app-server'
  | 'brain-pinning'
  | 'forced-native-session-id'
  | 'runtime-home-inheritance'
  | 'mcp-http-auth'
  | 'settings-diagnostics';

export type CapabilityState = 'supported' | 'soft' | 'unsupported';

export interface BackendFeatureCapability {
  state: CapabilityState;
  mechanism: string;
  unsupportedReason?: string;
}

export interface BackendFeatureGuard {
  supported: boolean;
  capability: BackendFeatureCapability;
  reason: string | null;
}

export type BackendFeatureMatrix = Record<InteractiveBackend, Record<BackendFeature, BackendFeatureCapability>>;

const supported = (mechanism: string): BackendFeatureCapability => ({ state: 'supported', mechanism });
const unsupported = (mechanism: string, unsupportedReason: string): BackendFeatureCapability => ({
  state: 'unsupported',
  mechanism,
  unsupportedReason,
});

export const BACKEND_FEATURE_CAPABILITIES: BackendFeatureMatrix = {
  claude: {
    'fresh-su': supported('raw claude launch with prompt file and user-level papercusp-su MCP'),
    resume: supported('native claude --resume/--continue with tracked adv session correlation'),
    'role-session': supported('raw claude role launch with prompt file and signed role MCP config'),
    'launch-context': supported('--append-system-prompt-file'),
    'saved-prompts': supported('.claude/commands materialization'),
    'slash-tool-prompts': supported('MCP prompt/slash surface through Claude command discovery'),
    'account-pinning': supported('inference-gateway Anthropic headers and env'),
    'gateway-routing': supported('Anthropic-compatible inference gateway route'),
    'file-lock-enforcement': supported('Claude PreToolUse/PostToolUse hooks'),
    'native-fork': supported('claude --fork-session'),
    'native-web-search': supported('Claude WebSearch/WebFetch tool surface where enabled by policy'),
    'native-code-review': unsupported(
      'backend-neutral review workflow',
      'Papercusp has no Claude-native review CLI integration equivalent to codex review; use the backend-neutral reviewer/work_items paths',
    ),
    'native-image-input': supported('Claude multimodal image attachment surface where enabled by the launched model'),
    'native-image-generation': unsupported(
      'backend-neutral asset workflow',
      'Claude has no Papercusp-managed native image generation CLI surface equivalent to Codex image generation',
    ),
    'native-subagents': unsupported(
      'Papercusp fleet/work_items delegation',
      'Claude Task/subagent-style delegation is intentionally routed through Papercusp work_items/fleet coordination for durable cross-backend ownership',
    ),
    'native-app-server': unsupported(
      'not a Claude CLI surface',
      'Claude has no Codex-style app-server/remote TUI surface to integrate',
    ),
    'brain-pinning': unsupported(
      'retired psu --brain and bootstrap brain paths; use operator/sentinel converse',
      'Pinned brain sessions were retired on 2026-06-21; use the backend-neutral operator/sentinel converse surface or a normal psu session',
    ),
    'forced-native-session-id': supported('claude --session-id'),
    'runtime-home-inheritance': supported('interactive Claude config mirror of ~/.claude with isolated projects'),
    'mcp-http-auth': supported('user-level MCP config with bearer headers'),
    'settings-diagnostics': supported('existing Claude/account/session settings surfaces'),
  },
  codex: {
    'fresh-su': supported('raw codex launch with per-session CODEX_HOME'),
    resume: supported('codex resume using tracked CODEX_HOME and rollout discovery'),
    'role-session': supported('raw codex role launch with per-session CODEX_HOME'),
    'launch-context': supported('bootstrap folds launch-context into CODEX_HOME/AGENTS.md'),
    'saved-prompts': supported('$CODEX_HOME/prompts materialization'),
    'slash-tool-prompts': supported('$CODEX_HOME/prompts slash-tool prompt materialization'),
    'account-pinning': supported('Codex account id baked into per-session model_provider gateway config'),
    'gateway-routing': supported('OpenAI-compatible /v1 gateway route with account header'),
    'file-lock-enforcement': supported('per-session hooks.json PreToolUse/PostToolUse for apply_patch/Edit/Write and shell gates'),
    'native-fork': supported('codex fork [SESSION_ID] / codex fork --last'),
    'native-web-search': supported('codex --search / web_search = live, with cached search enabled by default'),
    'native-code-review': supported('codex review --uncommitted/--base/--commit'),
    'native-image-input': supported('codex -i/--image for interactive and exec/resume prompts'),
    'native-image-generation': supported('Codex built-in image generation / $imagegen skill'),
    'native-subagents': supported('Codex multi_agent/subagents feature with [agents] config'),
    'native-app-server': supported('codex app-server / --remote TUI transport'),
    'brain-pinning': unsupported(
      'retired psu --brain and bootstrap brain paths; use operator/sentinel converse',
      'Pinned brain sessions were retired on 2026-06-21; use the backend-neutral operator/sentinel converse surface or a normal psu session',
    ),
    'forced-native-session-id': unsupported(
      'tracked via CODEX_HOME and rollout id discovery',
      'Codex CLI can resume/fork native rollout UUIDs, but cannot be launched with a caller-chosen native session UUID',
    ),
    'runtime-home-inheritance': supported('per-session CODEX_HOME inherits auth, skills, plugins, prompts, and trusted-workspace state'),
    'mcp-http-auth': supported('per-session config.toml bakes HTTP MCP Authorization headers'),
    'settings-diagnostics': supported('account and gateway diagnostics expose Codex provider routeability'),
  },
  omp: {
    'fresh-su': supported('raw omp launch with prompt and coordination extension'),
    resume: supported('omp -r thread headless one-turn resume, with readiness-gated PTY fallback diagnostics'),
    'role-session': supported('raw omp role launch with prompt and cwd-discovered MCP config'),
    'launch-context': supported('--append-system-prompt'),
    'saved-prompts': supported('.claude/commands materialization shared with OMP command discovery'),
    'slash-tool-prompts': supported('MCP prompt/slash surface through OMP-compatible command discovery'),
    'account-pinning': supported('per-session models.yml papercusp-gateway provider headers carry the x-papercusp-account pin (omp-account-pinning-gateway D-006)'),
    'gateway-routing': supported('per-session models.yml papercusp-gateway provider baseUrl routes Anthropic /v1/messages through the inference gateway (omp-account-pinning-gateway D-006)'),
    'file-lock-enforcement': supported('OMP coordination extension'),
    'native-fork': unsupported(
      'capability-gated in the launcher',
      'OMP has no Claude-style native fork-session flag; branch by launching a new OMP session with explicit launch_context instead of pretending to native-fork',
    ),
    'native-web-search': unsupported('backend-neutral MCP/search tools', 'OMP has no Papercusp-managed native web-search CLI flag'),
    'native-code-review': unsupported('backend-neutral review workflow', 'OMP has no Papercusp-managed native review CLI equivalent to codex review'),
    'native-image-input': unsupported('backend-neutral attachment flow', 'OMP has no Papercusp-managed native image attachment parity path'),
    'native-image-generation': unsupported('backend-neutral asset workflow', 'OMP has no Papercusp-managed native image generation surface'),
    'native-subagents': unsupported(
      'Papercusp fleet/work_items delegation',
      'OMP delegation is intentionally routed through Papercusp work_items/fleet coordination for durable cross-backend ownership',
    ),
    'native-app-server': unsupported('not an OMP CLI surface', 'OMP has no Codex-style app-server/remote TUI surface to integrate'),
    'brain-pinning': unsupported(
      'retired psu --brain and bootstrap brain paths; use operator/sentinel converse',
      'Pinned brain sessions were retired on 2026-06-21; use the backend-neutral operator/sentinel converse surface or a normal psu session',
    ),
    'forced-native-session-id': unsupported('thread id tracking', 'OMP resumes by thread id and does not accept a forced Claude-style session UUID'),
    'runtime-home-inheritance': supported('per-spawn OMP agent dir copies auth/config/tool cache'),
    'mcp-http-auth': supported('OMP mcp.json carries HTTP MCP headers'),
    'settings-diagnostics': supported('OMP gateway routeability surfaced via the shared account/gateway diagnostics; omp delegates to the anthropic adapter'),
  },
};

export function backendFeatureCapability(
  backend: InteractiveBackend,
  feature: BackendFeature,
): BackendFeatureCapability {
  return BACKEND_FEATURE_CAPABILITIES[backend][feature];
}

export function backendSupportsFeature(backend: InteractiveBackend, feature: BackendFeature): boolean {
  return backendFeatureCapability(backend, feature).state === 'supported';
}

export function backendFeatureGuard(backend: InteractiveBackend, feature: BackendFeature): BackendFeatureGuard {
  const capability = backendFeatureCapability(backend, feature);
  if (capability.state === 'supported') return { supported: true, capability, reason: null };
  return {
    supported: false,
    capability,
    reason: capability.unsupportedReason ?? `${backend} ${feature} is ${capability.state}`,
  };
}

export function backendFeatureUnsupportedReason(backend: InteractiveBackend, feature: BackendFeature): string | null {
  return backendFeatureGuard(backend, feature).reason;
}

export function interactiveBackendFromSpawnBackend(backend: SpawnBackendLike): InteractiveBackend {
  return backend === 'claude-code' || backend === 'anthropic-direct' ? 'claude' : backend;
}

export function accountProviderForInteractiveBackend(backend: InteractiveBackend): BackendAccountProvider | null {
  if (!backendFeatureGuard(backend, 'account-pinning').supported) return null;
  if (!backendFeatureGuard(backend, 'gateway-routing').supported) return null;
  return backend === 'codex' ? 'codex' : 'claude';
}
