/**
 * The audited disposition of the native capability families named by the
 * managed-agent cutover plan's R-1 acceptance bar.
 *
 * This is inventory, not launch policy. A family may already have substantial
 * managed authority and still be unready for cutover while a named parity,
 * recovery, policy, or evidence gap remains. Consumers must gate on
 * `cutoverReady`; a managed tool name alone never proves confinement.
 */

export const MANAGED_CAPABILITY_CONTRACT_VERSION = 1 as const;

export const MANAGED_CAPABILITY_FAMILY_IDS = [
  'shell-ssh-interpreters',
  'jobs-output-stop-pty',
  'script-orchestration-kernels',
  'reads-list-search-lsp',
  'edit-write-patch-notebook',
  'http-search-browser-computer',
  'delegation',
  'schedules-monitors-wakes',
  'tasks-plans-goals',
  'memory-checkpoint-resume-rewind',
  'questions-approvals',
  'images-artifacts-skills-discovery',
  'pure-tui-presentation',
] as const;

export type ManagedCapabilityFamilyId = (typeof MANAGED_CAPABILITY_FAMILY_IDS)[number];

export type ManagedCapabilityDispositionKind =
  | 'managed-execution'
  | 'managed-backed-native-interface'
  | 'deliberately-retained-interface'
  | 'unsupported-gap';

export type ManagedCapabilityGapKind = 'parity' | 'recovery' | 'policy' | 'evidence' | 'unsupported';

export interface ManagedCapabilitySourceCitation {
  /** Repository-relative source path. */
  path: string;
  /** Literal source anchors which must all remain present. */
  anchors: readonly string[];
  /** Literal source anchors whose appearance invalidates the cited gap/boundary. */
  absentAnchors?: readonly string[];
  note: string;
}

export interface ManagedCapabilityGap {
  id: string;
  kind: ManagedCapabilityGapKind;
  description: string;
  /** Plan items which must close this gap; P-001 only inventories it. */
  owningPlanItems: readonly string[];
  falsifier: string;
}

export interface ManagedCapabilityDisposition {
  family: ManagedCapabilityFamilyId;
  nativeSurface: string;
  disposition: ManagedCapabilityDispositionKind;
  /** Exact line between managed authority and intentionally retained/native behavior. */
  boundary: string;
  managedAuthorities: readonly string[];
  /** The single primary, source-verified evidence citation required by R-1. */
  evidence: ManagedCapabilitySourceCitation;
  /** Additional existing implementation sites to extend rather than duplicate. */
  reuseSites: readonly ManagedCapabilitySourceCitation[];
  gaps: readonly ManagedCapabilityGap[];
  cutoverReady: false;
  cutoverReason: string;
}

/**
 * The structural subset accepted by the pure red-control validator. Keeping
 * candidate fields wider than the published contract lets tests and admission
 * callers prove malformed inventories are rejected instead of merely asserting
 * that the one checked-in value happens to look valid.
 */
export interface ManagedCapabilityContractCandidate {
  family: string;
  disposition: string;
  evidence?: {
    path?: string;
    anchors?: readonly string[];
  };
  reuseSites?: readonly unknown[];
  gaps?: readonly unknown[];
  cutoverReady?: boolean;
}

export const MANAGED_CAPABILITY_DISPOSITIONS = [
  {
    family: 'shell-ssh-interpreters',
    nativeSurface: 'Shell commands, SSH commands, and language-interpreter processes',
    disposition: 'managed-execution',
    boundary:
      'Execution belongs to capability:bash and its sandbox/task envelope; Bash remains the invoked shell, while SSH and interpreters are commands inside that same governed process boundary rather than separate escape hatches.',
    managedAuthorities: ['capability:bash', 'task-manager managed spawn', 'capability execution sandbox'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/capability/bash.ts',
      anchors: ["name: 'capability:bash'", 'run_in_background'],
      note: 'The public managed shell door and its foreground/background split.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/capability/exec-sandbox.ts',
        anchors: ['export function buildCapabilitySandboxCommand'],
        note: 'Existing execution sandbox and credential/network policy boundary.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/capability/bash-jobs.ts',
        anchors: ['startBackground', 'waitForJobResponse', 'CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV'],
        note: 'Start-once process launch, separate response/execution deadlines, output, and task enrolment.',
      },
    ],
    gaps: [
      {
        id: 'shell-cross-client-enforcement',
        kind: 'policy',
        description: 'Claude, Codex, and OMP alias/interpreter/SSH bypass coverage is not yet accepted.',
        owningPlanItems: ['P-005', 'P-007', 'P-008'],
        falsifier:
          'The real-client matrix proves every named bypass is denied or routed through the managed authority.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-005/P-007/P-008 still own cross-client bypass proof and accepted enforcement.',
  },
  {
    family: 'jobs-output-stop-pty',
    nativeSurface: 'Background jobs, output retrieval, stop/kill, and interactive terminal sessions',
    disposition: 'unsupported-gap',
    boundary:
      'Bash jobs use start-once response yield plus durable task ids and managed process scopes. Managed PTYs accept authorized input and resize, return bounded screen media, emit task-terminal wakes, and distinguish live reattachment from ended or unrecoverably lost server handles. The family remains unsupported for cutover until real-client restart/reattachment acceptance is complete.',
    managedAuthorities: [
      'capability:bash_output',
      'capability:bash_kill',
      'capability:pty_open/read_screen/write_stdin/resize/kill',
      'task-manager',
    ],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/capability/pty.ts',
      anchors: [
        "name: 'capability:pty_open'",
        "name: 'capability:pty_resize'",
        "name: 'capability:pty_read_screen'",
        "name: 'capability:pty_kill'",
        "reattachment: 'unrecoverable'",
      ],
      note: 'Task-ledger-backed PTY input, resize, bounded screen media, reattachment, explicit lost-handle truth, and kill share one authority path.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/capability/bash_output.ts',
        anchors: ["name: 'capability:bash_output'"],
        note: 'Existing bounded output/tail and task reattachment surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/capability/bash_kill.ts',
        anchors: ["name: 'capability:bash_kill'"],
        note: 'Existing explicit managed kill surface.',
      },
    ],
    gaps: [
      {
        id: 'pty-real-client-restart-acceptance',
        kind: 'unsupported',
        description:
          'The real Claude, Codex, and OMP clients have not yet accepted PTY reattachment and explicit unrecoverable outcomes across an operator restart.',
        owningPlanItems: ['P-007', 'P-008'],
        falsifier:
          'The real-client matrix covers incremental PTY output, clean exit wake, explicit cancel, live reattachment, and explicit unrecoverable restart truth.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-007/P-008 still own real-client restart/reattachment acceptance before restriction.',
  },
  {
    family: 'script-orchestration-kernels',
    nativeSurface: 'Multi-step tool scripts, saved recipes, language execution, and persistent/multimodal kernels',
    disposition: 'unsupported-gap',
    boundary:
      'code:run, orchestrate:run, and recipes:run are foreground managed script authorities with current-caller nested authorization, branching/fan-out, parent cancellation, explicit replay state, final image/audio media, and uncertain-write reporting. They do not claim a persistent language kernel: cross-call or restart state beyond returned replay state remains explicitly unsupported.',
    managedAuthorities: ['code:run', 'orchestrate:run', 'recipes:run'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/code/run.ts',
      anchors: ["name: 'code:run'", 'generatedImage({ image_url:'],
      note: 'Managed nested-tool scripting with bounded result/media output.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/orchestration/run.ts',
        anchors: ["name: 'orchestrate:run'", 'runOrchestration'],
        note: 'Existing mixed orchestration runtime and cancellation/error shaping.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/recipes/run.ts',
        anchors: ["name: 'recipes:run'", 'authorityContextSchema'],
        note: 'Existing saved-script execution and authority contract.',
      },
    ],
    gaps: [
      {
        id: 'persistent-kernel-lifecycle',
        kind: 'unsupported',
        description:
          'A persistent language-kernel lifecycle with state beyond explicit replay values and restart recovery is not implemented or accepted.',
        owningPlanItems: ['P-006', 'P-008'],
        falsifier:
          'Persistent-kernel acceptance proves cross-call state lifetime, binary/media transport, cancellation, nested-call authorization, and restart recovery.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-006/P-008 still own a persistent-kernel backend and real-client proof.',
  },
  {
    family: 'reads-list-search-lsp',
    nativeSurface: 'File reads/listing, grep/glob/full-text/semantic search, and code-intelligence queries',
    disposition: 'managed-execution',
    boundary:
      'Managed read/list/search/LSP tools govern durable access and bounded output; efficient native rendering or read-only helpers may remain only where their access/output boundary is explicitly accepted.',
    managedAuthorities: ['capability:read', 'capability:list', 'search:fulltext', 'search:semantic', 'lsp:query'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/capability/read.ts',
      anchors: ["name: 'capability:read'", 'MAX_BYTE_PAGE'],
      note: 'Managed byte/range read with an explicit bounded page contract.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/capability/list.ts',
        anchors: ["name: 'capability:list'", 'hiddenExcluded'],
        note: 'Managed directory enumeration with explicit truncation and hidden-entry truth.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/search/fulltext.ts',
        anchors: ["name: 'search:fulltext'"],
        note: 'Canonical lexical search surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/search/semantic.ts',
        anchors: ["name: 'search:semantic'"],
        note: 'Canonical semantic search surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/lsp/query.ts',
        anchors: ["name: 'lsp:query'"],
        note: 'Canonical code-intelligence query surface.',
      },
    ],
    gaps: [
      {
        id: 'read-native-retention-policy',
        kind: 'policy',
        description:
          'Read/grep/glob retention, access, symlink, binary, and output accounting are not yet accepted across every client.',
        owningPlanItems: ['P-006', 'P-007', 'P-008'],
        falsifier:
          'Positive and negative real-client controls establish the same access/output rules or a documented retained exception.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-006/P-007/P-008 still own retained-read boundaries and per-client proof.',
  },
  {
    family: 'edit-write-patch-notebook',
    nativeSurface: 'Exact edits, whole-file writes, multi-file patches, structural code changes, and notebook mutation',
    disposition: 'managed-execution',
    boundary:
      'capability:edit/write, capability:patch, capability:notebook_edit and lsp:apply are managed mutation doors under the same lock policy; atomic multi-file patch and notebook cell semantics are now distinct registered adapters and must not be hidden by renaming an exact-string edit, but cross-client bypass enforcement and real-client acceptance are still unproven.',
    managedAuthorities: [
      'capability:edit',
      'capability:write',
      'capability:patch',
      'capability:notebook_edit',
      'lsp:apply',
      'locks:*',
    ],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/index.ts',
      anchors: [
        "import './capability/edit';",
        "import './capability/write';",
        "import './capability/patch';",
        "import './capability/notebook';",
        "import './lsp/apply';",
      ],
      note: 'The registry exposes managed edit/write/LSP mutation plus the registered patch and notebook cell-edit adapters.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/capability/edit.ts',
        anchors: ["name: 'capability:edit'"],
        note: 'Existing exact-string edit/locking authority.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/capability/write.ts',
        anchors: ["name: 'capability:write'", 'emptyWriteWouldDestroy'],
        note: 'Existing whole-file write safety contract.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/lsp/apply.ts',
        anchors: ["name: 'lsp:apply'"],
        note: 'Existing structural code-action mutation surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/capability/patch.ts',
        anchors: ["name: 'capability:patch'", 'MAX_HUNKS', 'function restore('],
        note: 'Registered atomic multi-file patch adapter with bounded hunks and all-or-nothing restore.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/capability/notebook.ts',
        anchors: ["name: 'capability:notebook_edit'", 'function findCell(', 'function sourceStyle('],
        note: 'Registered notebook cell-edit adapter preserving cell addressing and source-style fidelity.',
      },
    ],
    gaps: [
      {
        id: 'patch-notebook-real-client-acceptance',
        kind: 'evidence',
        description:
          'Registered patch and notebook adapters pass hermetic and single-host real-client checks, but the Claude/Codex/OMP matrix has not yet accepted them against native Edit/MultiEdit/NotebookEdit UX.',
        owningPlanItems: ['P-007', 'P-008'],
        falsifier:
          'Each client matrix run proves atomic multi-file patch and notebook cell semantics through managed authority and locks, with no native mutation door left unaccounted.',
      },
      {
        id: 'mutation-client-enforcement',
        kind: 'policy',
        description: 'Alias and nested-shell mutation bypasses have not yet passed the Claude/Codex/OMP matrix.',
        owningPlanItems: ['P-005', 'P-007', 'P-008'],
        falsifier: 'Every unmanaged file-mutation path is denied or explicitly retained with an accepted boundary.',
      },
    ],
    cutoverReady: false,
    cutoverReason:
      'P-005/P-007/P-008 still own cross-client mutation enforcement and real-client patch/notebook acceptance.',
  },
  {
    family: 'http-search-browser-computer',
    nativeSurface: 'HTTP fetch, web search, browser/DOM automation, and visual computer control',
    disposition: 'unsupported-gap',
    boundary:
      'capability:fetch governs raw HTTP and capability:computer governs a leased sandbox desktop; search and browser/DOM behavior remain distinct and cannot be represented as fetch or pixel clicking by fiat.',
    managedAuthorities: [
      'capability:fetch',
      'search:* provider surfaces',
      'capability:computer',
      'computer desktop lease',
    ],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/index.ts',
      anchors: ["import './capability/fetch';", "import './computer/computer';", "import './search/fulltext';"],
      absentAnchors: ["import './browser/browser';"],
      note: 'Managed HTTP, search, and computer doors are registered; no canonical managed browser adapter is registered.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/capability/fetch.ts',
        anchors: ["name: 'capability:fetch'", 'DEFAULT_MAX_DOWNLOAD_BYTES'],
        note: 'Existing bounded HTTP body and spill handling.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/computer/computer.ts',
        anchors: ["name: 'capability:computer'", 'resolveBoundDisplay'],
        note: 'Existing sandbox-desktop action and observation boundary.',
      },
    ],
    gaps: [
      {
        id: 'browser-provider-contract',
        kind: 'unsupported',
        description:
          'A managed browser/DOM provider with explicit auth, egress, output, and session-lifetime rules is not yet accepted.',
        owningPlanItems: ['P-006', 'P-008'],
        falsifier:
          'A real-client test proves browser navigation/DOM work without conflating it with raw HTTP or sandbox pixels.',
      },
      {
        id: 'network-computer-client-policy',
        kind: 'policy',
        description:
          'Web-search aliases, native fetch, egress overrides, and host-versus-sandbox computer paths are not yet fully enforced.',
        owningPlanItems: ['P-005', 'P-007', 'P-008'],
        falsifier:
          'Positive/negative controls prove provider access, egress, sandbox targeting, and truthful unsupported outcomes per client.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-005/P-006/P-007/P-008 still own browser parity and network/computer enforcement.',
  },
  {
    family: 'delegation',
    nativeSurface: 'Agent launch, resume, fork, fleet placement, and work handoff',
    disposition: 'managed-execution',
    boundary:
      'Agent lifecycle starts through capability:launch-agent or fleet:launch-on-plan and is bound to managed identity, launch policy, saved profile, and coordination; client-native subagent backends are not an equivalent hidden lane.',
    managedAuthorities: ['capability:launch-agent', 'fleet:launch-on-plan', 'coord:dispatch', 'agent-launch-core'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/capability/launch-agent.ts',
      anchors: ["name: 'capability:launch-agent'", 'buildAgentLaunchCommand'],
      note: 'Canonical managed launch/resume/fork door reusing the shared launcher core.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/fleet_registry/launch-on-plan.ts',
        anchors: ["name: 'fleet:launch-on-plan'"],
        note: 'Existing visible/headless plan-fleet placement surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-launch-core.ts',
        anchors: ['export function buildAgentLaunchCommand', 'resolveResumeTarget'],
        note: 'Shared command, identity, resume, wake, and verification implementation.',
      },
    ],
    gaps: [
      {
        id: 'delegation-lifecycle-policy-parity',
        kind: 'policy',
        description:
          'All client-native spawn aliases and resume/wake transitions have not yet passed one versioned policy matrix.',
        owningPlanItems: ['P-005', 'P-007', 'P-008'],
        falsifier:
          'Claude/Codex/OMP launches, resumes, forks, and wakes show managed identity/policy and reject native bypass controls.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-005/P-007/P-008 still own alias, lifecycle, and real-client enforcement proof.',
  },
  {
    family: 'schedules-monitors-wakes',
    nativeSurface: 'Recurring schedules, condition monitors, one-shot waits, and self-wakes',
    disposition: 'managed-execution',
    boundary:
      'Recurring work belongs to plan schedules, ambient conditions to watch:create, one-shot gates to events:await, and continuous solo work to loop:arm; native schedulers/monitors are not independent authority.',
    managedAuthorities: ['plans:set-schedule/arm-schedule', 'watch:create', 'events:await', 'loop:arm'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/plans/set-schedule.ts',
      anchors: ["name: 'plans:set-schedule'"],
      note: 'Canonical plan recurrence authoring surface.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/plans/arm-schedule.ts',
        anchors: ["name: 'plans:arm-schedule'"],
        note: 'Separate autonomy-gated schedule arming surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/events/watch.ts',
        anchors: ["name: 'watch:create'"],
        note: 'Unified durable subscription primitive.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/events/await.ts',
        anchors: ["name: 'events:await'"],
        note: 'One-shot event-wake preset.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/loop/arm.ts',
        anchors: ["name: 'loop:arm'"],
        note: 'Tracked solo self-wake loop.',
      },
    ],
    gaps: [
      {
        id: 'scheduler-monitor-native-bypass',
        kind: 'policy',
        description:
          'Client scheduler/monitor aliases, override arguments, lifecycle reset, and duplicate-fire controls are not yet accepted.',
        owningPlanItems: ['P-005', 'P-007', 'P-008'],
        falsifier:
          'The real-client matrix proves canonical scheduling/wake state and rejects or truthfully retains every native alternative.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-005/P-007/P-008 still own native alias denial and lifecycle/adoption evidence.',
  },
  {
    family: 'tasks-plans-goals',
    nativeSurface: 'Session-local tasks, shared work-items, durable plans, and goals',
    disposition: 'managed-execution',
    boundary:
      'tasks:ops is session-local presentation state; work_items, plans, and goals are the durable shared authorities. A task panel may remain, but it must not masquerade as the shared ledger.',
    managedAuthorities: ['tasks:ops', 'work_items:*', 'plans:*', 'goals:*'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/tasks/ops.ts',
      anchors: ["name: 'tasks:ops'"],
      note: 'Explicit session-task surface kept distinct from durable work.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/work_items/get.ts',
        anchors: ["name: 'work_items:get'"],
        note: 'Durable shared work-item read/resume surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/plans/get.ts',
        anchors: ["name: 'plans:get'"],
        note: 'Canonical plan structure/read surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/goals/start.ts',
        anchors: ["name: 'goals:start'"],
        note: 'Canonical goal execution/ownership entry point.',
      },
    ],
    gaps: [
      {
        id: 'native-task-panel-store-distinction',
        kind: 'policy',
        description:
          'Client task/plan panels have not yet proven their writes land in the correct session-local or shared canonical store.',
        owningPlanItems: ['P-006', 'P-007', 'P-008'],
        falsifier:
          'Per-client UI tests show task, work-item, plan, and goal mutations in their intended stores with no shadow backend.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-006/P-007/P-008 still own client-panel/store distinction and acceptance.',
  },
  {
    family: 'memory-checkpoint-resume-rewind',
    nativeSurface:
      'Durable memory, standing facts, work checkpoints, transcript resume, compaction carry, and filesystem rewind',
    disposition: 'managed-backed-native-interface',
    boundary:
      'Managed memory/facts/checkpoints and launch identity are authoritative; a client may present native transcript resume/navigation, but transcript continuation is never filesystem rewind and neither may invent a shadow durable-memory store.',
    managedAuthorities: [
      'memory:*',
      'facts:*',
      'work_items:checkpoint',
      'session:request-compaction',
      'agent-launch-core resume',
    ],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/work_items/checkpoint.ts',
      anchors: ["name: 'work_items:checkpoint'"],
      note: 'Durable in-flight checkpoint/carry authority.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/memory/remember.ts',
        anchors: ["name: 'memory:remember'"],
        note: 'Shared semantic-memory write surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/facts/assert.ts',
        anchors: ["name: 'facts:assert'"],
        note: 'Deterministic standing-fact authority.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/session/request-compaction.ts',
        anchors: ["name: 'session:request-compaction'", 'native `/compact`', 'is RETIRED'],
        note: 'Deterministic managed carry-respawn seam.',
      },
      {
        path: 'packages/operator-core/lib/agent-launch-core.ts',
        anchors: ['resolveResumeTarget', 'export function buildAgentLaunchCommand'],
        note: 'Managed identity-preserving resume/fork resolution.',
      },
    ],
    gaps: [
      {
        id: 'offline-bounded-recovery',
        kind: 'unsupported',
        description:
          'Operator-unreachable bounded local recovery is DELIBERATELY EXCLUDED, not unbuilt: plan decision D-010 retired the feature and dropped its owning item P-004. D-007/D-008 measured that no machine-local authority root can establish human-owner provenance here — a software-only Ed25519 key in sk-ssh-ed25519 wire format with signer-chosen flags 0x05 verifies as hardware-backed, and managed agents hold NOPASSWD root — so a local grant is forgeable by the very agents it constrains. The exclusion stands BECAUSE no weaker substitute is acceptable; there is no managed offline recovery path, and callers must treat operator-unreachable as unrecoverable.',
        owningPlanItems: ['P-004', 'P-008'],
        falsifier:
          'This exclusion is falsified if any locally-authorized recovery path ships — i.e. a managed agent obtains a recovery grant without an owner signature rooted outside this machine mutation authority. A re-implementation attempt must first supersede D-007/D-008, never route around them.',
      },
      {
        id: 'resume-rewind-client-semantics',
        kind: 'policy',
        description:
          'Per-client controls do not yet prove transcript resume, compaction carry, and filesystem rewind remain distinct.',
        owningPlanItems: ['P-005', 'P-006', 'P-007', 'P-008'],
        falsifier: 'Versioned client tests exercise each control and observe the correct independent state transition.',
      },
    ],
    cutoverReady: false,
    cutoverReason:
      'Offline recovery is no longer owned by anyone: D-010 retired the feature and dropped P-004, so it is a permanent documented exclusion rather than outstanding work. P-005 through P-008 still own restriction reset and distinct resume/rewind semantics, which is what keeps this family short of cutover.',
  },
  {
    family: 'questions-approvals',
    nativeSurface: 'Owner questions, approval choices, permission prompts, and response presentation',
    disposition: 'managed-backed-native-interface',
    boundary:
      'Question/approval state belongs to chat/coord and the owner inbox; a native radio/dialog may remain as presentation, and genuine client permission checks remain client security controls rather than Papercusp approvals.',
    managedAuthorities: ['chat:ask_choice', 'coord:ask', 'owner inbox', 'tui:dispatch'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/chat/ask_choice.ts',
      anchors: ["name: 'chat:ask_choice'", 'presentation'],
      note: 'Managed question state with an explicit presentation payload.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/coordination/tools/ask.ts',
        anchors: ["name: 'coord:ask'"],
        note: 'Durable owner-directed coordination question surface.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/tui/dispatch.ts',
        anchors: ["name: 'tui:dispatch'"],
        note: 'Existing managed-to-native TUI action bridge.',
      },
    ],
    gaps: [
      {
        id: 'question-permission-cross-client-boundary',
        kind: 'policy',
        description:
          'Each client has not yet proven managed question state while preserving genuine native permission enforcement and delivery truth.',
        owningPlanItems: ['P-006', 'P-007', 'P-008'],
        falsifier:
          'Real-client tests distinguish answered managed choices, owner inbox state, and native security prompts without shadow approvals.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-006/P-007/P-008 still own client dialog, permission, and delivery acceptance.',
  },
  {
    family: 'images-artifacts-skills-discovery',
    nativeSurface: 'Image/media blocks, published artifacts, client skills, and tool/capability discovery',
    disposition: 'deliberately-retained-interface',
    boundary:
      'Native/client media rendering, authenticated artifact publishing, and skill UX remain provider interfaces; tools:find/invoke is managed discovery and code:run can return validated media, but retained interfaces gain no implicit filesystem/network authority.',
    managedAuthorities: ['tools:find', 'tools:invoke', 'code:run result door', 'provider-specific access policy'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/tools/find.ts',
      anchors: ["name: 'tools:find'", 'buildCorpus'],
      note: 'Managed discovery over the complete registered capability catalog.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/tools/invoke.ts',
        anchors: ["name: 'tools:invoke'", 'summarizeNestedToolOutcome'],
        note: 'Managed invocation fallback for discovered tools.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/code/run.ts',
        anchors: ['generatedImage({ image_url:', 'codeRunReturnedContextBytes'],
        note: 'Validated media output and context-byte accounting through the shared result door.',
      },
      {
        path: 'packages/operator-core/lib/agent-tools/index.ts',
        anchors: ["import './tools/find';", "import './tools/invoke';"],
        absentAnchors: ["import './artifacts/publish';", "import './skills/run';"],
        note: 'Discovery is registered, while artifact/skill operations remain client/provider integrations rather than parallel MCP backends.',
      },
    ],
    gaps: [
      {
        id: 'retained-media-artifact-skill-policy',
        kind: 'policy',
        description:
          'Retained media, artifact, and skill paths lack one accepted cross-client access/output/auth and lifecycle statement.',
        owningPlanItems: ['P-006', 'P-007', 'P-008'],
        falsifier:
          'Per-client tests prove retained rendering/discovery and authorized side effects, with explicit exclusions for unavailable providers.',
      },
      {
        id: 'media-output-recovery',
        kind: 'evidence',
        description:
          'Binary/media retention and exact authorized retrieval across result truncation/restart are not yet evidenced.',
        owningPlanItems: ['P-003', 'P-006', 'P-008'],
        falsifier:
          'Media/script acceptance recovers the permitted payload after bounded previews and restart without false byte-equivalence claims.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-003/P-006/P-007/P-008 still own retained-provider policy and media recovery evidence.',
  },
  {
    family: 'pure-tui-presentation',
    nativeSurface: 'Terminal rendering, navigation, diffs, status panels, and other presentation-only client behavior',
    disposition: 'deliberately-retained-interface',
    boundary:
      'Pure rendering/navigation remains native; any action initiated from it must dispatch to managed authority through tui:dispatch/ui:dispatch or another registered operation. Presentation discovery/hiding is never an authorization boundary.',
    managedAuthorities: ['tui:dispatch', 'ui:dispatch', 'registered operation handlers'],
    evidence: {
      path: 'packages/operator-core/lib/agent-tools/tui/dispatch.ts',
      anchors: ["name: 'tui:dispatch'", 'TUI analogue'],
      note: 'Managed dispatch seam for actions originating in the native TUI.',
    },
    reuseSites: [
      {
        path: 'packages/operator-core/lib/agent-tools/ui/dispatch.ts',
        anchors: ["name: 'ui:dispatch'"],
        note: 'Sibling UI dispatch seam for registered operations.',
      },
      {
        path: 'libs/papercusp/packages/orchestrator/src/invoke.ts',
        anchors: [
          'export const FLEET_CAPABILITY_REPLACED_TOOLS',
          'Withholding an MCP tool needs',
          'server-side enforcement',
        ],
        note: 'Existing launch-policy source explicitly distinguishes client tool lists from server-side authority.',
      },
    ],
    gaps: [
      {
        id: 'presentation-action-authority-parity',
        kind: 'policy',
        description:
          'Native panels/actions have not yet been exhaustively mapped to managed writes or classified as pure presentation.',
        owningPlanItems: ['P-006', 'P-007', 'P-008'],
        falsifier:
          'Client acceptance proves retained rendering while every state-changing action reaches its canonical managed store/control.',
      },
    ],
    cutoverReady: false,
    cutoverReason: 'P-006/P-007/P-008 still own native-panel action mapping and real-client acceptance.',
  },
] as const satisfies readonly ManagedCapabilityDisposition[];

/** Root cutover gate: intentionally false until every per-family gap is closed and re-evidenced. */
export const MANAGED_CAPABILITY_CUTOVER_READY = MANAGED_CAPABILITY_DISPOSITIONS.every((entry) => entry.cutoverReady);

const MANAGED_CAPABILITY_DISPOSITION_KINDS: ReadonlySet<string> = new Set([
  'managed-execution',
  'managed-backed-native-interface',
  'deliberately-retained-interface',
  'unsupported-gap',
]);

/** Pure structural admission check for a candidate capability inventory. */
export function managedCapabilityContractViolations(entries: readonly ManagedCapabilityContractCandidate[]): string[] {
  const violations: string[] = [];
  const expected = new Set<string>(MANAGED_CAPABILITY_FAMILY_IDS);
  const counts = new Map<string, number>();

  for (const entry of entries) counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);

  for (const family of MANAGED_CAPABILITY_FAMILY_IDS) {
    const count = counts.get(family) ?? 0;
    if (count === 0) violations.push(`missing-family:${family}`);
    if (count > 1) violations.push(`duplicate-family:${family}`);
  }

  entries.forEach((entry, index) => {
    const ref = expected.has(entry.family) ? entry.family : `index-${index}`;
    if (!expected.has(entry.family)) violations.push(`unknown-family:${entry.family}`);
    if (!MANAGED_CAPABILITY_DISPOSITION_KINDS.has(entry.disposition)) {
      violations.push(`invalid-disposition:${ref}:${entry.disposition}`);
    }
    if (!entry.evidence?.path || !entry.evidence.anchors?.length) violations.push(`missing-evidence:${ref}`);
    if (!entry.reuseSites?.length) violations.push(`missing-reuse-site:${ref}`);
    if (!entry.gaps?.length) violations.push(`missing-gap:${ref}`);
    if (entry.cutoverReady !== false) violations.push(`cutover-not-blocked:${ref}`);
  });

  return violations;
}

export function managedCapabilityDisposition(
  family: ManagedCapabilityFamilyId,
): (typeof MANAGED_CAPABILITY_DISPOSITIONS)[number] {
  const disposition = MANAGED_CAPABILITY_DISPOSITIONS.find((entry) => entry.family === family);
  if (!disposition) throw new Error(`Unknown managed capability family: ${family}`);
  return disposition;
}
