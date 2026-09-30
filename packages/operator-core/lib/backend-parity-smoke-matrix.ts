import type { BackendFeature, CapabilityState, InteractiveBackend } from './backend-feature-capabilities';

export type BackendParitySmokeArea =
  | 'psu-launch-resume-wake'
  | 'omp-resume-leg'
  | 'codex-home-recovery'
  | 'spawned-agent-attach'
  | 'retired-brain-pinning'
  | 'gateway-account-pin-fail-closed'
  | 'prompt-materialization'
  | 'operator-command-run'
  | 'delegate-work-items'
  | 'plan-agent-backend-run'
  | 'agent-attribution';

export type BackendParitySmokeCoverageKind =
  | 'vitest'
  | 'bounded-cli-smoke'
  | 'retired-surface';

export interface BackendParitySmokeCoverage {
  kind: BackendParitySmokeCoverageKind;
  path?: string;
  command?: string[];
  expected?: string;
}

export interface BackendParityCapabilityExpectation {
  backend: InteractiveBackend;
  feature: BackendFeature;
  state: CapabilityState;
}

export interface BackendParitySmokeRow {
  id: string;
  area: BackendParitySmokeArea;
  title: string;
  backends: readonly InteractiveBackend[];
  requirement: string;
  coverage: readonly BackendParitySmokeCoverage[];
  capabilities: readonly BackendParityCapabilityExpectation[];
}

export const REQUIRED_BACKEND_PARITY_SMOKE_AREAS: readonly BackendParitySmokeArea[] = [
  'psu-launch-resume-wake',
  'omp-resume-leg',
  'codex-home-recovery',
  'spawned-agent-attach',
  'retired-brain-pinning',
  'gateway-account-pin-fail-closed',
  'prompt-materialization',
  'operator-command-run',
  'delegate-work-items',
  'plan-agent-backend-run',
  'agent-attribution',
];

export const BACKEND_PARITY_SMOKE_MATRIX: readonly BackendParitySmokeRow[] = [
  {
    id: 'psu-launch-resume-wake',
    area: 'psu-launch-resume-wake',
    title: 'PSU launch, resume, and wake work across interactive backends',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'fresh launch, durable resume handle, role launch, and wake delivery stay covered together',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/endpoint-route/__tests__/bootstrap-su.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/endpoint-route/__tests__/bootstrap-role.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/native-session-id-roundtrip.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/events/await/wake-executor-matrix.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/events/await/wake-executor.test.ts' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'fresh-su', state: 'supported' },
      { backend: 'claude', feature: 'resume', state: 'supported' },
      { backend: 'claude', feature: 'native-fork', state: 'supported' },
      { backend: 'codex', feature: 'fresh-su', state: 'supported' },
      { backend: 'codex', feature: 'resume', state: 'supported' },
      { backend: 'codex', feature: 'native-fork', state: 'supported' },
      { backend: 'omp', feature: 'fresh-su', state: 'supported' },
      { backend: 'omp', feature: 'resume', state: 'supported' },
      { backend: 'omp', feature: 'native-fork', state: 'unsupported' },
    ],
  },
  {
    id: 'omp-headless-resume-cli',
    area: 'omp-resume-leg',
    title: 'OMP resume uses the headless one-turn CLI leg before PTY fallback',
    backends: ['omp'],
    requirement: 'resume syntax parses as a bounded non-TUI smoke and failures are diagnostic, not hanging',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/events/await/wake-executor.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/events/await/wake-executor-matrix.test.ts' },
      {
        kind: 'bounded-cli-smoke',
        command: [
          'timeout',
          '10s',
          'omp',
          '-r',
          '__papercusp_smoke_nonexistent_thread__',
          '--approval-mode',
          'yolo',
          '-p',
          '__papercusp_resume_syntax_smoke__',
          '--no-tools',
          '--no-lsp',
          '--no-pty',
        ],
        expected: 'exits non-zero with "Session ... not found" instead of entering the TUI',
      },
    ],
    capabilities: [
      { backend: 'omp', feature: 'resume', state: 'supported' },
    ],
  },
  {
    id: 'codex-home-recovery',
    area: 'codex-home-recovery',
    title: 'Codex resume recovers from the tracked CODEX_HOME and rollout id',
    backends: ['codex'],
    requirement: 'Codex role and SU sessions share the home root that the wake executor uses for resume',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/role-codex-home.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/native-session-handles.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/events/await/wake-executor.test.ts' },
    ],
    capabilities: [
      { backend: 'codex', feature: 'runtime-home-inheritance', state: 'supported' },
      { backend: 'codex', feature: 'resume', state: 'supported' },
    ],
  },
  {
    id: 'spawned-agent-attach',
    area: 'spawned-agent-attach',
    title: 'Spawned agents expose durable attach handles in the dossier and backend helpers',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'spawned-agent rows normalize backend-specific session handles and surface missing-handle reasons',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/native-session-handles.test.ts' },
      { kind: 'vitest', path: 'apps/operator/app/adv/sessions/__tests__/AgentDossier.test.tsx' },
      { kind: 'vitest', path: 'apps/operator/app/adv/sessions/__tests__/SessionsRosterView.test.tsx' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'resume', state: 'supported' },
      { backend: 'codex', feature: 'resume', state: 'supported' },
      { backend: 'omp', feature: 'resume', state: 'supported' },
    ],
  },
  {
    id: 'retired-brain-pinning',
    area: 'retired-brain-pinning',
    title: 'Pinned brain sessions are retired for every interactive backend',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'psu --brain fails closed instead of silently launching a backend-specific pinned session',
    coverage: [
      { kind: 'vitest', path: 'apps/operator/lib/psu-launcher.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/backend-feature-capabilities.test.ts' },
      { kind: 'retired-surface', path: 'apps/operator-docs/src/content/docs/agent-spawning/terminal-wrappers.mdx' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'brain-pinning', state: 'unsupported' },
      { backend: 'codex', feature: 'brain-pinning', state: 'unsupported' },
      { backend: 'omp', feature: 'brain-pinning', state: 'unsupported' },
    ],
  },
  {
    id: 'gateway-account-pin-fail-closed',
    area: 'gateway-account-pin-fail-closed',
    title: 'Gateway/account pinning is supported for Claude, Codex, and OMP',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'launchers only emit account routing for providers with both account pinning and gateway routing; OMP routes via a per-session models.yml gateway provider (omp-account-pinning-gateway D-006)',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/backend-feature-capabilities.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/deployment/account-spawn-routing.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/inference-gateway/account-routing-e2e.test.ts' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'account-pinning', state: 'supported' },
      { backend: 'claude', feature: 'gateway-routing', state: 'supported' },
      { backend: 'codex', feature: 'account-pinning', state: 'supported' },
      { backend: 'codex', feature: 'gateway-routing', state: 'supported' },
      { backend: 'omp', feature: 'account-pinning', state: 'supported' },
      { backend: 'omp', feature: 'gateway-routing', state: 'supported' },
    ],
  },
  {
    id: 'prompt-materialization',
    area: 'prompt-materialization',
    title: 'Prompt materialization reaches each backend native command surface',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'saved prompts and slash-tool prompts materialize into the home directory each backend reads',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/saved-prompts-materialize.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/saved-prompts-projection.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/slash-tool-prompts-codex.test.ts' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'saved-prompts', state: 'supported' },
      { backend: 'claude', feature: 'slash-tool-prompts', state: 'supported' },
      { backend: 'codex', feature: 'saved-prompts', state: 'supported' },
      { backend: 'codex', feature: 'slash-tool-prompts', state: 'supported' },
      { backend: 'omp', feature: 'saved-prompts', state: 'supported' },
      { backend: 'omp', feature: 'slash-tool-prompts', state: 'supported' },
    ],
  },
  {
    id: 'operator-command-backend-run',
    area: 'operator-command-run',
    title: 'Representative operator command runs stay backend-neutral',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'operator-side command/query registration remains a backend-neutral tool surface',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/commands/__tests__/delegation.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/endpoint-route/__tests__/bootstrap-su.test.ts' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'mcp-http-auth', state: 'supported' },
      { backend: 'codex', feature: 'mcp-http-auth', state: 'supported' },
      { backend: 'omp', feature: 'mcp-http-auth', state: 'supported' },
    ],
  },
  {
    id: 'delegate-work-items-retired-command',
    area: 'delegate-work-items',
    title: 'Retired delegate commands stay removed; delegated work runs through work_items',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'operator:delegate parity is a work_items path, not a revived Claude-only command',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/commands/__tests__/delegation.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/delegated-tasks.integration.test.ts' },
      {
        kind: 'retired-surface',
        path: 'packages/operator-core/lib/_retired/operator-delegate.md',
        expected: 'delegate_to_claude and delegate_to_agent stay absent from command discovery',
      },
    ],
    capabilities: [
      { backend: 'claude', feature: 'role-session', state: 'supported' },
      { backend: 'codex', feature: 'role-session', state: 'supported' },
      { backend: 'omp', feature: 'role-session', state: 'supported' },
    ],
  },
  {
    id: 'agent-attribution-contract',
    area: 'agent-attribution',
    title: 'Agent attribution surfaces stay populated for every interactive backend',
    backends: ['claude', 'codex', 'omp'],
    requirement:
      'session-handle, transcript-resolver, roster and usage attribution never regress to claude-only population (WI-1500 — the gpt-5.4 three-seam class: TUI transcript mirror, placement-watchdog zombie signal, roster labels); missing durable keys degrade to an explicit missingReason, never silence',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/agent-attribution-contract.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/native-session-handles.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/adv-roster.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/compaction-usage.test.ts' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'resume', state: 'supported' },
      { backend: 'codex', feature: 'resume', state: 'supported' },
      { backend: 'omp', feature: 'resume', state: 'supported' },
    ],
  },
  {
    id: 'plan-agent-backend-run',
    area: 'plan-agent-backend-run',
    title: 'Plan-agent launch and resume paths are covered as backend-neutral orchestration',
    backends: ['claude', 'codex', 'omp'],
    requirement: 'plan launch/resume derivations stay independent of a Claude-only backend assumption',
    coverage: [
      { kind: 'vitest', path: 'packages/operator-core/lib/agent-tools/plans/__tests__/launch.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/agent-tools/plans/__tests__/resume.test.ts' },
      { kind: 'vitest', path: 'packages/operator-core/lib/endpoint-route/__tests__/harness-spawn-routes.integration.test.ts' },
    ],
    capabilities: [
      { backend: 'claude', feature: 'role-session', state: 'supported' },
      { backend: 'codex', feature: 'role-session', state: 'supported' },
      { backend: 'omp', feature: 'role-session', state: 'supported' },
    ],
  },
];
