/**
 * testing-domains-registry.ts — the operator's /admin/testing registry barrel.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24 (P-002); split in Phase B
 * (P-010/P-011) of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * The portable `routes` domain — the one that applies to any project —
 * lives in `@papercusp/testing-shell` as `universalDomains` (pure data);
 * this file resolves its `endpoints` role against the operator's own repo
 * (OPERATOR_ROLE_GLOBS) and registers it. The Papercusp-runtime-bound
 * test-runs / live / chaos / ai moved here from the lib (they can't run
 * against a non-Papercusp project as-is — D-002 option b), alongside the 16
 * other Papercusp-only domains — 20 in all (testing-shell-cross-project D-007).
 *
 * Importing this module side-effect-registers all 21 domains. The four
 * /admin/testing endpoint routes (P-003) side-effect-import it to populate
 * getTestDomain / listTestDomains; the SPA's left-rail tab list is
 * hardcoded in operator-vite's TestingClient (P-006a) and does not read
 * this file.
 *
 * Globs are repo-relative POSIX. Glob walk happens server-side at request
 * time (P-003) — no checked-in catalog to drift.
 *
 * Tier groupings (the 16 here): `quick` (memory, packaged), `domain`
 * (per-domain surfaces + llm), `surface` (transport, docs). The
 * generalized 5 carry tier `generalized`.
 */

import {
  defineTestDomain,
  getTestDomain,
  listTestDomains,
  universalDomains,
  applyRoleGlobs,
  type TestDomain,
} from './testing-domains';

// The operator's role→globs map for the lib's universal domains: it supplies
// the concrete endpoint-test paths the lib leaves as the 'endpoints' role
// (testing-shell-cross-project D-007). applyRoleGlobs fills routes' globs so
// /admin/testing (and the registered Map) resolve against the operator repo.
const OPERATOR_ROLE_GLOBS: Record<string, string[]> = {
  endpoints: ['packages/operator-core/lib/endpoint-route/__tests__/**/*.test.ts'],
};

/** The lib's universal domains, resolved against the operator's own repo. */
const operatorUniversal: TestDomain[] = applyRoleGlobs(universalDomains, OPERATOR_ROLE_GLOBS);

// Register the universal domains (role-resolved) into the shared Map so
// /admin/testing's getTestDomain / listTestDomains see them.
for (const d of operatorUniversal) defineTestDomain(d);

/* ---------------------------------------------------------------- *
 * Papercusp-only domains (20). The portable `routes` domain lives in the lib
 * (@papercusp/testing-shell, universalDomains). The Papercusp-runtime-bound
 * test-runs/live/chaos/ai used to live there too but moved here — they can't
 * run against a non-Papercusp project as-is (D-002 option b; generalizing
 * them to drive each project's base URL is a deferred follow-up).
 * ---------------------------------------------------------------- */

// — Moved from the lib (formerly the generalized tier; now Papercusp 'quick') —
defineTestDomain({
  id: 'test-runs',
  label: 'Test Runs',
  description: 'Suite orchestrator: start / poll / cancel named suites.',
  tier: 'quick',
  sections: [
    {
      id: 'all',
      label: 'Suites',
      description: 'All admin-test-suite runs.',
      runners: [{ kind: 'admin-suite', suiteId: 'desktop-health' }],
    },
  ],
});

// The surface census (CoverageTab) — deterministic-coverage-census-2026-08-17 P-005.
// Distinct from `test-runs` on purpose: that domain reports what RAN, this one reports
// what EXISTS and which of it is proven. A fully green suite is silent about every
// surface it never touched, which is the blind spot the census was built to close.
defineTestDomain({
  id: 'coverage',
  label: 'Coverage',
  description: 'Surface census: what exists, and which surfaces are proven to the depth floor.',
  tier: 'quick',
  sections: [
    {
      id: 'all',
      label: 'Census',
      description: 'The census read surfaces and their honesty guards.',
      globs: [
        'packages/operator-core/lib/agent-tools/testing/coverage.test.ts',
        'apps/operator/app/admin/testing/_components/CoverageTab.test.ts',
      ],
    },
  ],
});

// Operator desktop vitals (LiveMetricsTab). Renamed `live` → `vitals` so the
// universal in-page observer (live-web, from buildUniversalTesting) owns the
// generic "Live" slot — universal-testing-domains-generic Phase 6.
defineTestDomain({
  id: 'vitals',
  label: 'Live metrics',
  description: 'Operator desktop vitals: interactions, console, layout, unhandled errors.',
  tier: 'quick',
  sections: [
    { id: 'all', label: 'Observers', globs: ['apps/operator/app/admin/testing/_lib/vitals-*.test.ts'] },
  ],
});

// The interactive Chaos panel is now the universal chaos-desktop (lib
// ChaosDesktopPanel via buildUniversalTesting); this domain keeps the recorder
// test-glob attached to the matching `chaos-desktop` id so the contract/harness
// view stay consistent.
defineTestDomain({
  id: 'chaos-desktop',
  label: 'Chaos (desktop)',
  description: 'In-app perf-recorder clicker that drives the Tauri shell looking for crashes.',
  tier: 'quick',
  sections: [
    { id: 'host', label: 'Recorder host', globs: ['apps/operator/app/admin/testing/_lib/chaos-*.test.ts'] },
  ],
});

// The interactive AI Explore panel is now the universal ai-explore (lib
// AiExplorePanel via buildUniversalTesting); this domain keeps the prompts suite
// attached to the matching `ai-explore` id.
defineTestDomain({
  id: 'ai-explore',
  label: 'AI Explore',
  description: 'Stagehand LLM walk over admin routes.',
  tier: 'quick',
  sections: [
    {
      id: 'prompts',
      label: 'Prompts',
      runners: [{ kind: 'admin-suite', suiteId: 'ai-explore-prompts' }],
    },
  ],
});

defineTestDomain({
  id: 'memory',
  label: 'Memory',
  description: 'mem0 pgvector round-trip + memory-core suite + CRUD probe.',
  tier: 'quick',
  sections: [
    { id: 'core', label: 'Health', globs: ['packages/operator-core/lib/memory/**/*.test.ts'] },
    {
      id: 'live',
      label: 'Live',
      description:
        'Live session-extraction round-trip on the anthropic-direct transport (mem0-extraction-via-claude-session P-007): ' +
        'remember → Haiku-extracted facts → paraphrase-searchable, in an isolated PG schema. ' +
        'Needs a Claude session + PG + embedder key; exits 2 (skip) without a usable session.',
      runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/memory/session-extraction-live.ts'],
          label: 'session-extraction round-trip (live Claude session)',
        },
      ],
    },
  ],
});

// learning-packs-2026-06-11: the Knowledge Packs feature end-to-end — pack
// format/seeding/management, the hive memory scope + budgeted injection, the
// Learnings-view reader, the creation/Comb UI, and the worker's
// pre-publication review pipeline. (hive-scope/injection also surface under
// the Memory domain's core glob — the overlap is deliberate: this row is the
// per-feature view.)
defineTestDomain({
  id: 'learnings',
  label: 'Learnings',
  description: 'Knowledge packs: format/seed/manage, hive memory scope, Learnings UI, Comb review pipeline.',
  tier: 'domain',
  sections: [
    {
      id: 'packs',
      label: 'Packs core',
      description: 'Pack format + loader, default-pack content pin, seeding, install/uninstall/upgrade/sweep + conflict review.',
      globs: ['packages/operator-core/lib/knowledge-packs/**/*.test.ts'],
    },
    {
      id: 'hive-memory',
      label: 'Hive memory',
      description: 'hive:<slug> scope resolution + budgeted pre-turn injection (pack-muting-aware).',
      globs: [
        'packages/operator-core/lib/memory/hive-scope.test.ts',
        'packages/operator-core/lib/memory/injection.test.ts',
      ],
    },
    {
      id: 'reader',
      label: 'Learnings view reader',
      globs: ['packages/operator-core/lib/sync-resolver/learning-hive-read.test.ts'],
    },
    {
      id: 'ui',
      label: 'UI',
      description: 'Creation pack picker + seeded summary, Learning tab, Comb storefront/detail.',
      globs: [
        'apps/operator/app/harness/__tests__/EntryGithubUrlForm.test.tsx',
        'apps/operator/app/harness/__tests__/CreateHarnessPicker.test.tsx',
        'apps/operator/app/cupboard/__tests__/*.test.tsx',
        'apps/operator-vite/src/components/adv/LearningTab.test.tsx',
      ],
    },
    {
      id: 'comb-review',
      label: 'Comb review',
      description: 'Cupboard worker: listing kinds + the pending→approve/reject pre-publication pipeline (D-007).',
      globs: [
        'apps/operator-public/src/__tests__/review.test.ts',
        'apps/operator-public/src/__tests__/listings.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'packaged',
  label: 'Packaged build',
  description: 'wdio + tauri-driver against the packaged binary.',
  tier: 'quick',
  sections: [
    {
      id: 'wdio',
      label: 'WebdriverIO',
      globs: ['tools/perf-test/wdio/specs/**/*.spec.ts'],
      runners: [
        { kind: 'admin-suite', suiteId: 'packaged-readiness' },
        {
          kind: 'node',
          cmd: 'npm',
          args: ['--prefix', 'tools/perf-test/wdio', 'test'],
          label: 'WebdriverIO packaged-app specs',
        },
      ],
    },
  ],
});

defineTestDomain({
  id: 'llm',
  label: 'LLM',
  description: 'Scenario-driven LLM evaluations (Runs / Scenarios / Targets / Findings).',
  tier: 'domain',
  sections: [
    { id: 'core', label: 'Core', globs: ['packages/operator-core/lib/llm-testing/__tests__/**/*.test.ts'] },
  ],
});

/* ---------------------------------------------------------------- *
 * Tier 2 — domains (12 new tabs)
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'harness',
  label: 'Harness',
  description: 'Harness UI: dock, layouts, fs-watcher, status sweep, branch actions.',
  tier: 'domain',
  sections: [
    { id: 'dock', label: 'Dock', globs: ['apps/operator/app/harness/dock/**/*.test.*'] },
    { id: 'layout', label: 'Layout', globs: [
        'packages/operator-core/lib/dock-layouts.test.ts',
        'packages/operator-core/lib/dock-layout-migrators.test.ts',
      ] },
    { id: 'fs-watcher', label: 'FS watcher', globs: ['packages/operator-core/lib/harness-fs-watcher.test.ts'] },
    { id: 'status-sweep', label: 'Status sweep', globs: ['packages/operator-core/lib/harness-status-sweep.test.ts'] },
    // Catch-the-rest for the harness lib surface (federation/dogfood-specific
    // harness/__tests__ files also appear under the Dogfood domain — overlap
    // is intentional).
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/harness-*.test.ts',
        'packages/operator-core/lib/harness/**/*.test.ts',
        'packages/operator-core/lib/harness-insights/**/*.test.ts',
        'packages/operator-core/lib/harness-state/**/*.test.ts',
      ] },
    { id: 'app', label: 'App UI', globs: ['apps/operator/app/harness/**/*.test.*'] },
    // dock.spec.ts retired with the /harness/$slug dashboard
    // (_retired/harness-dashboard/, design-simplification-2026-07-09 P-008).
    { id: 'e2e', label: 'E2E', globs: [
        'apps/operator/e2e/harness-*.spec.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'voice',
  label: 'Voice',
  description: 'Voice stack: runtime/capture, cards, engines, persona, spend.',
  tier: 'domain',
  sections: [
    { id: 'runtime', label: 'Runtime', globs: ['apps/operator/app/_components/voice/**/*.test.*'] },
    { id: 'cards', label: 'Cards', globs: ['packages/operator-core/lib/voice-cards/**/*.test.ts'] },
    { id: 'engines', label: 'Engines', globs: [
        'packages/operator-core/lib/voice-engines/**/*.test.ts',
        'packages/operator-core/lib/voice-engine-health.test.ts',
      ] },
    { id: 'persona', label: 'Persona', globs: [
        'packages/operator-core/lib/op-backstory*.test.ts',
        'packages/operator-core/lib/op-narration-policy.test.ts',
        'packages/operator-core/lib/operator-persona.test.ts',
        'packages/operator-core/lib/classify-utterance-mode.test.ts',
      ] },
    { id: 'spend', label: 'Spend', globs: [
        'packages/operator-core/lib/stt-spend.test.ts',
        'packages/operator-core/lib/tts-spend.test.ts',
        'packages/operator-core/lib/elevenlabs-webhook-auth.test.ts',
      ] },
    // Catch-the-rest for the voice-* lib surface so new voice tests appear
    // without a per-file registry edit.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/voice-*.test.ts',
      ] },
    { id: 'smoke', label: 'Smoke', runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-suite-test.mjs'], label: 'el-suite' },
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/voice-stack-check.mjs'], label: 'voice-stack-check' },
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-connect-test.mjs'], label: 'el-connect (live EL creds)' },
        // Static drift check (no live deps): el-agent-sync TOOLS list vs the
        // operator command registry — catches the "client tool not defined" crash class.
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-tools-check.mjs'], label: 'el-tools-check (registry↔TOOLS drift)' },
        // pui/tui real-audio loopback through a PipeWire null-sink (synthetic audio,
        // never touches the box's real defaults). See isolated-audio-e2e-null-sink.
        { kind: 'shell', cmd: 'bash', args: ['apps/tui/scripts/audio-loopback-smoke.sh'], label: 'pui audio loopback (null-sink)' },
      ] },
  ],
});

defineTestDomain({
  id: 'papercusp-su',
  label: 'Papercusp-SU',
  description: 'Superuser surface: coordination, file locking, identity, tools.',
  tier: 'domain',
  sections: [
    {
      id: 'coordination',
      label: 'Coordination',
      description:
        'Messages, plan-events, watermarks, subscriptions, escalations, handoffs, promote — plus the coordination ENGINE underneath: the inbox bus + producer, the coord wire schema, lifecycle rules/rendering/desugaring, and the typed coord-ops programs (ops, triggers, program runner, blueprints e2e).',
      globs: [
        'packages/operator-core/lib/agent-tools/coordination/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agent_chats/**/*.test.ts',
        'packages/operator-core/lib/coord-inbox-bus*.test.ts',
        'packages/operator-core/lib/coord-schema*.test.ts',
        'packages/operator-core/lib/coord-lifecycle/**/*.test.ts',
        'packages/operator-core/lib/coord-ops/**/*.test.ts',
        // EI-1742: durable successor brief written on coord:declare-intent (presence path).
        'packages/operator-core/lib/session-brief*.test.ts',
      ],
    },
    {
      id: 'file-locking',
      label: 'File Locking',
      description: 'locks:* tools, file-lock-queue, su-locks integration.',
      globs: [
        'packages/operator-core/lib/agent-tools/locks/**/*.test.ts',
        'packages/operator-core/lib/endpoint-route/__tests__/su-locks*.test.ts',
        // P-030 migrated the legacy su-locks-e2e.sh into:
        'apps/operator/scripts/hooks/omp/__tests__/su-locks-omp.integration.test.ts',
      ],
    },
    {
      id: 'identity',
      label: 'Identity',
      description: 'Auth principals, device JWT, OAuth, audit, rate-limit, power-user.',
      globs: [
        'packages/operator-core/lib/agent-tools/coordination/identity*.test.ts',
        'packages/operator-core/lib/auth.test.ts',
        'packages/operator-core/lib/auth-*.test.ts',
        'packages/operator-core/lib/device-jwt*.test.ts',
        'packages/operator-core/lib/power-user-token*.test.ts',
        'packages/operator-core/lib/oauth/**/*.test.ts',
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      description: 'agent-tools surface + agent-mcp dispatch/projection/define-tool. coordination/locks live in their own sections above.',
      globs: [
        'packages/operator-core/lib/agent-tools/__tests__/**/*.test.ts',
        // Explicit positive list — my dependency-free matcher doesn't
        // support extglob negation (!(coordination|locks)).
        'packages/operator-core/lib/agent-tools/agent_chats/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agent_tools/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/architect/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/capability/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/autoloop/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/backup/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/chat/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/cross_harness/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/dev/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/docs/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/flags/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/harness/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/harness_docs/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/memory/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/operator/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/oracle/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/plugins/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/processes/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/projects/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/roles/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/search/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/instance/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/tasks/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/ui/**/*.test.ts',
        'packages/agent-mcp/**/*.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'backup',
  label: 'Backup',
  description: 'Kopia backup integration: settings, policy, snapshot, self-exclusion.',
  tier: 'domain',
  sections: [
    { id: 'core', label: 'Core', globs: ['packages/operator-core/lib/backup/**/*.test.ts'] },
    { id: 'e2e', label: 'E2E', globs: ['apps/operator/e2e/backups.spec.ts'] },
  ],
});

defineTestDomain({
  id: 'plans',
  label: 'Plans',
  description: 'Plan-tracking surface: authoring, runs, revisions, concurrency, UI.',
  tier: 'domain',
  sections: [
    {
      id: 'authoring',
      label: 'Authoring',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/add-*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/set-*.test.ts',
      ],
    },
    {
      id: 'runs',
      label: 'Runs',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/runs.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/launch*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/resume*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/context-bundle.test.ts',
      ],
    },
    {
      id: 'revisions',
      label: 'Revisions',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/revision-*.test.ts',
      ],
    },
    {
      id: 'concurrency',
      label: 'Concurrency',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/concurrency*.test.ts',
      ],
    },
    {
      id: 'scheduling',
      label: 'Scheduling (routines)',
      // The scheduled-plans feature: a plan's RRULE/cron schedule is armed into
      // a routine that fires plan_runs. Its runtime lives in the routines engine
      // (packages/.../harness/routines/), so these globs overlap the Harness ›
      // Lib catch-all — deliberately, to surface the feature as one group here.
      // (Other routines actions — hive-canary, wake-brain, release, improvement,
      // coord-invariant — are NOT scheduled-plans and stay out of this section.)
      globs: [
        'packages/operator-core/lib/harness/routines/schedule-next.test.ts',
        'packages/operator-core/lib/harness/routines/scheduled-occurrences.integration.test.ts',
        'packages/operator-core/lib/harness/routines/materialize-plan-schedule.integration.test.ts',
        'packages/operator-core/lib/harness/routines/arm-plan-schedule.integration.test.ts',
        'packages/operator-core/lib/harness/routines/plan-run-action.integration.test.ts',
        'packages/operator-core/lib/harness/routines/plan-run-cost.integration.test.ts',
        'packages/operator-core/lib/harness/routines/reconcile-plan-runs.integration.test.ts',
        'packages/operator-core/lib/harness/routines/gc-plan-runs.integration.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/set-plan-schedule.integration.test.ts',
      ],
    },
    // Catch-the-rest for the plans tool __tests__ dir + the plans admin UI.
    { id: 'tools', label: 'Tools', globs: ['packages/operator-core/lib/agent-tools/plans/__tests__/**/*.test.ts'] },
    { id: 'app', label: 'App UI', globs: ['apps/operator/app/admin/plans/**/*.test.*'] },
    {
      id: 'ui',
      label: 'UI',
      globs: [
        'apps/operator/app/admin/plans/**/*.test.*',
        'packages/operator-core/lib/__tests__/client-navigation.test.ts',
        'packages/operator-core/lib/__tests__/desktop-static-host.test.ts',
        'packages/operator-core/lib/__tests__/desktop-ui-intents.test.ts',
        'packages/operator-core/lib/__tests__/lazy-with-retry.test.ts',
        'apps/operator/app/admin/testing/_lib/recorder-start-params.test.ts',
        'apps/operator/app/_components/__tests__/SupportChatButton.test.tsx',
        'apps/operator/app/_components/__tests__/ChatwootWidget.test.tsx',
        'apps/operator/app/_components/__tests__/UiPresenceProvider.test.tsx',
        'apps/operator/app/_components/__tests__/OperatorChatSidebar.test.ts',
        'apps/operator/app/_components/__tests__/UserPicker.test.tsx',
        'packages/operator-core/lib/__tests__/workspaces-tauri.test.ts',
        'apps/operator/app/_components/__tests__/routePending.test.ts',
        'apps/operator/app/_components/__tests__/RouteLink.test.ts',
        'apps/operator/app/_components/__tests__/ChromeShellNav.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'operator',
  label: 'Operator',
  description: 'Operator brain: converse, scan, suggestions, audit, persona, state.',
  tier: 'domain',
  sections: [
    { id: 'brain', label: 'Brain', globs: ['packages/operator-core/lib/operator-converse*.test.ts'] },
    { id: 'suggestions', label: 'Suggestions', globs: ['packages/operator-core/lib/operator-suggest*.test.ts'] },
    { id: 'audit', label: 'Audit', globs: ['packages/operator-core/lib/operator-audit*.test.ts'] },
    { id: 'persona', label: 'Persona', globs: ['packages/operator-core/lib/operator-persona*.test.ts', 'packages/operator-core/lib/operator-prompt*.test.ts'] },
    { id: 'state', label: 'State', globs: ['packages/operator-core/lib/operator-state*.test.ts', 'packages/operator-core/lib/operator-trigger*.test.ts'] },
    // Catch-the-rest: every operator-*.test.ts at lib root (converse/scan/etc.
    // are already sectioned above; this surfaces the long tail too).
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/operator-*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'design',
  label: 'Design',
  description: 'Design phase: IR, adapters, spec, tokens, phase flow.',
  tier: 'domain',
  sections: [
    { id: 'spec', label: 'Spec', globs: ['packages/operator-core/lib/design-spec/**/*.test.ts'] },
    { id: 'phase-flow', label: 'Phase flow', globs: ['packages/operator-core/lib/design-phase*.test.ts'] },
    // Catch-the-rest for the design-* lib surface + design-tokens outputs.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/design-*.test.ts',
        'design-tokens/**/*.test.ts',
      ] },
    // Live E2E smoke (needs a running operator) — surfaced as a runner.
    { id: 'smoke', label: 'Smoke', runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/design-loop-smoke.mjs'], label: 'design-loop (live operator)' },
      ] },
  ],
});

defineTestDomain({
  id: 'plugins',
  label: 'Plugins',
  description: 'Plugin runtime: loader, SDK, WIT, grants, lifecycle, host-shim.',
  tier: 'domain',
  sections: [
    { id: 'loader', label: 'Loader', globs: ['packages/plugin-loader/**/*.test.ts'] },
    { id: 'sdk', label: 'SDK', globs: ['packages/plugin-sdk/**/*.test.ts'] },
    { id: 'wit', label: 'WIT', globs: ['packages/plugin-wit/**/*.test.ts'] },
    { id: 'grants', label: 'Grants', globs: ['packages/operator-core/lib/plugin-grants*.test.ts'] },
    { id: 'lifecycle', label: 'Lifecycle', globs: ['packages/operator-core/lib/plugin-*.test.ts'] },
    // Vitest unit tests that ship beside a built-in plugin (libs/papercusp/plugins/**).
    // e.g. gitnexus-bridge's rolesFor/quotaFor/path helpers. Distinct from the
    // builtin-smoke runner below (which drives a full in-process publish flow).
    { id: 'builtin', label: 'Built-in plugin units', globs: ['libs/papercusp/plugins/**/*.test.ts'] },
    // Built-in plugin smokes (libs/papercusp/plugins/**). In-process — the
    // cloudflare-pages smoke runs the full Direct-Upload flow against a mock
    // of api.cloudflare.com (no real CF account/token). Surfaced as a runner
    // because the plugins/ dir is not part of an operator Vitest project.
    { id: 'builtin-smoke', label: 'Built-in plugin smokes', runners: [
        { kind: 'node', cmd: 'npx', args: ['tsx', 'libs/papercusp/plugins/cloudflare-pages/index.smoke.ts'], label: 'cloudflare-pages publish (mock CF)' },
      ] },
  ],
});

defineTestDomain({
  id: 'transport',
  label: 'Transport',
  description: 'SSE / IPC / adapters / sync-resolver.',
  tier: 'surface',
  sections: [
    { id: 'sse', label: 'SSE', globs: ['libs/generic/sse/**/*.test.ts'] },
    { id: 'ipc', label: 'IPC', globs: [
        'packages/operator-core/lib/endpoint-ipc/**/*.test.ts',
        'libs/generic/ipc-endpoint-server/**/*.test.ts',
        'libs/generic/ipc-framing/**/*.test.ts',
      ] },
    { id: 'adapters', label: 'Adapters', globs: [
        'libs/generic/desktop-ipc/src/**/*.test.ts',
        'packages/operator-core/lib/transport-adapters/**/*.test.ts',
      ] },
    // The operator sync delta codec (createSyncDeltaCodec) — the sync delta seam.
    // Lives under apps/operator/providers; was gate-run but not registry-globbed
    // (invisible in the Tests tab) until wired here (orphan-test audit).
    { id: 'sync-delta', label: 'Sync delta codec', globs: ['apps/operator/providers/**/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'instance-spec',
  label: 'Instance spec',
  description: 'The reproducible InstanceSpec: genome surface, capture/boot/vary, eval-battery subject.',
  tier: 'domain',
  sections: [
    { id: 'genome', label: 'Genome', globs: ['packages/operator-core/lib/instance-spec/genome*.test.ts'] },
    { id: 'vary', label: 'Vary', globs: ['packages/operator-core/lib/instance-spec/vary.test.ts'] },
    { id: 'capture', label: 'Capture', globs: ['packages/operator-core/lib/instance-spec/capture.test.ts'] },
    { id: 'subject', label: 'Subject', globs: ['packages/operator-core/lib/instance-spec/instance-subject.test.ts'] },
    { id: 'roundtrip', label: 'Round-trip', globs: ['packages/operator-core/lib/instance-spec/roundtrip.test.ts'] },
  ],
});

defineTestDomain({
  id: 'mobile',
  label: 'Mobile',
  description: 'Paired-device flow: pair, JWT, feeds, actions, voice init.',
  tier: 'domain',
  sections: [
    { id: 'pair', label: 'Pair', globs: ['packages/operator-core/lib/device-pair*.test.ts'] },
    { id: 'jwt', label: 'JWT', globs: ['packages/operator-core/lib/device-jwt*.test.ts'] },
    { id: 'feeds', label: 'Feeds', globs: ['packages/operator-core/lib/device-feed*.test.ts'] },
    // Catch-the-rest for the device-*/mobile-* lib surface.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/device-*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'provisioning',
  label: 'Provisioning',
  description: 'Workspace provisioning: runner, sandbox, trust-store, templates, network.',
  tier: 'domain',
  sections: [
    { id: 'runner', label: 'Runner', globs: ['packages/operator-core/lib/provision/runner*.test.ts'] },
    { id: 'sandbox', label: 'Sandbox', globs: ['packages/operator-core/lib/provision/sandbox*.test.ts'] },
    { id: 'trust-store', label: 'Trust store', globs: ['packages/operator-core/lib/provision/trust*.test.ts'] },
    { id: 'network', label: 'Network', globs: ['packages/operator-core/lib/provision/network*.test.ts'] },
    // Catch-the-rest for everything under the provision/ dir.
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/provision/**/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'docs',
  label: 'Docs',
  description: 'Docs engine: outline, search, adapters.',
  tier: 'surface',
  sections: [
    { id: 'engine', label: 'Engine', globs: ['packages/docs-engine/**/*.test.ts'] },
    { id: 'outline', label: 'Outline', globs: ['packages/operator-core/lib/agent-tools/docs/**/*.test.ts'] },
    { id: 'search', label: 'Search', globs: [
        'packages/operator-core/lib/search/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/search/**/*.test.ts',
      ] },
    // The doc-freshness engine + the doc-steward (docs-corpus-audit WS2 P-008): drift detection,
    // anchoring, the post-sync sweep + self-bootstrap + create-seed, and the doc-steward dispatch
    // (the LLM consumer that re-syncs a drifted doc to the code).
    { id: 'freshness', label: 'Freshness + steward', globs: [
        'packages/operator-core/lib/harness/docs/**/*.test.ts',
      ] },
  ],
});

/* ---------------------------------------------------------------- *
 * Dogfood — the shared-harness collaborative substrate (plan
 * dogfood-test-suite-2026-06-01). One sectioned domain covering the
 * Model-B sync layer, identity/binding, federation, orchestrator
 * claim, PR lifecycle, reactivity, revocation, the Cupboard public
 * API, the collaboration UI, and the endpoint routes — surfaces the
 * ~80 existing substrate/identity/orchestrator/pr-host tests (which
 * no prior domain globbed) plus the new coverage this plan adds.
 * Cross-section overlap (e.g. revocation ⊂ substrate) is intentional:
 * the matcher doesn't negate, and a sub-view is worth its own glob.
 * ---------------------------------------------------------------- */
defineTestDomain({
  id: 'dogfood',
  label: 'Dogfood',
  description: 'Shared-harness collaborative substrate: Model-B sync, identity/binding, federation, claims, PR lifecycle, Cupboard.',
  tier: 'domain',
  sections: [
    {
      id: 'substrate',
      label: 'Substrate',
      description: 'Model-B per-peer signed logs + LWW read-merge + projections + boot/swarm.',
      globs: ['packages/operator-core/lib/sync/hyperbee/**/*.test.ts'],
    },
    {
      id: 'identity-binding',
      label: 'Identity & binding',
      description: 'Device keychain, Ed25519 signing, two-channel binding, attestation.',
      globs: ['packages/operator-core/lib/identity/**/*.test.ts'],
    },
    {
      id: 'federation',
      label: 'Federation',
      description: 'Join/share, user-branch, binding publish, tree classifier, clone, register.',
      globs: [
        'packages/operator-core/lib/harness/__tests__/**/*.test.ts',
        'packages/operator-core/lib/harness/classify-tree.test.ts',
        'packages/operator-core/lib/harness/clone-github.test.ts',
        'packages/operator-core/lib/harness/register-papercusp.test.ts',
        'packages/operator-core/lib/harness/papercusp-workspace.test.ts',
        'packages/operator-core/lib/harness/contributor-row-types.test.ts',
        'packages/operator-core/lib/harness/contributor-usage-event-types.test.ts',
        'packages/operator-core/lib/harness/feature-queue-row-types.test.ts',
      ],
    },
    {
      id: 'claim',
      label: 'Claim',
      description: 'Orchestrator distributed/advisory feature claim + audit + multi-harness spawning smoke.',
      globs: ['packages/operator-core/lib/orchestrator/**/*.test.ts'],
      // Live multi-harness-spawning E2E (drives a running operator) — runner.
      runners: [
        { kind: 'shell', cmd: 'bash', args: ['bin/smoke-multi-harness-spawning.sh'], label: 'multi-harness spawning (live)' },
      ],
    },
    {
      id: 'pr-lifecycle',
      label: 'PR lifecycle',
      description: 'PrHost, poll daemon + retry, auto-approve/merge, reviewer settings.',
      globs: ['packages/operator-core/lib/pr-host/**/*.test.ts'],
    },
    {
      id: 'completion-ref',
      label: 'Completion ref',
      description: 'completion_ref writer + background ls-remote verifier.',
      globs: ['packages/operator-core/lib/harness/completion-ref-*.test.ts'],
    },
    {
      id: 'reactivity',
      label: 'Reactivity',
      description: 'sync-resolver query registry + sync-sse bridge + emit-change-notify trigger sentinel.',
      globs: [
        'packages/operator-core/lib/sync-resolver/**/*.test.ts',
        'packages/operator-core/lib/sync-sse.test.ts',
      ],
      // Live-PG regression sentinel (brings its own embedded PG) — see
      // agent-insights/live-pg-regression-sentinel.
      runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/verify-trigger-consolidation.mjs'], label: 'emit-change-notify sentinel' },
        // Full reactivity round-trip e2e: PG trigger → pg_notify → sync-sse LISTEN
        // → SSE endpoint → EventSource consumer. Drives the live operator.
        { kind: 'node', cmd: 'npx', args: ['tsx', 'apps/operator/scripts/verify-reactivity-e2e.ts'], label: 'reactivity round-trip e2e (live operator)' },
      ],
    },
    {
      id: 'revocation',
      label: 'Revocation',
      description: 'Self-device + contributor revocation, enforcement, re-verify, MCP tools.',
      globs: [
        'packages/operator-core/lib/sync/hyperbee/__tests__/revoke-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/revocation-enforcement.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/reverify-admitted.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/boot-revoke-production-path.test.ts',
        'packages/operator-core/lib/agent-tools/substrate/**/*.test.ts',
      ],
    },
    {
      id: 'cupboard',
      label: 'Cupboard',
      description: 'Public harness-discovery API (operator-public).',
      globs: ['apps/operator-public/src/**/*.test.ts'],
    },
    {
      id: 'ui',
      label: 'UI',
      description: 'Create/Share/Join, PRs, Insights cards, claim/contributor/binding badges.',
      globs: [
        'apps/operator/app/harness/__tests__/**/*.test.tsx',
        'apps/operator/app/harness/insights/__tests__/**/*.test.tsx',
        'apps/operator/app/harness/PrsTab.component.test.tsx',
        'apps/operator/app/_components/__tests__/ContributorBadge.test.tsx',
        'apps/operator/app/_components/__tests__/ClaimStatusBadge.test.tsx',
        'apps/operator/app/_components/__tests__/HarnessClaimHeader.test.tsx',
        'apps/operator/app/_components/__tests__/BindingStatusBadge.test.tsx',
        'apps/operator/app/users/github/[id]/__tests__/**/*.test.tsx',
      ],
    },
    {
      id: 'routes',
      label: 'Routes',
      description: 'Substrate revoke, join/share/feature-queue/discord, user-profile endpoints.',
      globs: [
        'packages/operator-core/lib/endpoint-route/routes/admin/__tests__/substrate-*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/admin/__tests__/dogfood-substrate-*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/__tests__/**/*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/users/__tests__/**/*.test.ts',
      ],
    },
  ],
});

// p2p-performance-suite-2026-06-07 (D-002): the hyperbee substrate's
// three-tier performance suite. The vitest files under perf/ ALSO match the
// dogfood substrate glob — intentional overlap (they are substrate tests);
// this domain is where the bench RUNNERS live. Artifacts + per-run report
// land under test-results/p2p-perf/<runId>/; committed baselines next to the
// suite in perf/baselines/ (advisory comparator — D-005).
defineTestDomain({
  id: 'p2p-perf',
  label: 'P2P Perf',
  description:
    'Hyperbee-substrate performance suite: merge/decode benches, multi-process replication + churn, netem WAN sim, real-frame tier.',
  tier: 'domain',
  sections: [
    {
      id: 'infra',
      label: 'Suite infra',
      description:
        'Corpus determinism, comparator math, meter envelope, and the CI-locked EI-79 idle-tick invariant (merge-scaling.test.ts).',
      globs: ['packages/operator-core/lib/sync/hyperbee/perf/**/*.test.ts'],
    },
    {
      id: 'tier1',
      label: 'Tier 1 (local)',
      description:
        'Loopback benches: merge cost / decode throughput / replication latency+ceiling / churn. Every scenario asserts the loop-lag SLO (p95 < 100ms).',
      runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier1', '--profile', 'smoke'],
          label: 'tier1 smoke (~3 min)',
        },
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier1', '--profile', 'ci'],
          label: 'tier1 ci profile (~15 min)',
        },
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier1', '--profile', 'full'],
          label: 'tier1 full sweep (long)',
        },
      ],
    },
    {
      id: 'tier2',
      label: 'Tier 2 (netem WAN)',
      description:
        'Simulated WAN: unprivileged userns + veth + tc netem (RTT/jitter/loss matrix + the UDX loss curve). Skips on hosts without userns.',
      runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier2', '--profile', 'smoke'],
          label: 'tier2 netem smoke',
        },
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier2', '--profile', 'full'],
          label: 'tier2 netem full matrix',
        },
      ],
    },
    {
      id: 'tier3',
      label: 'Tier 3 (real frames)',
      description:
        'Latitude/Hetzner real-machine measurements (NAT/holepunch, real-WAN DHT, cross-region replication). Cred-gated: $0 and skipped without LATITUDE_API_KEY.',
      globs: [
        'packages/operator-core/lib/deployment/**/p2p-perf*.test.ts',
        'packages/operator-core/lib/deployment/p2p-perf-tier3/**/*.test.ts',
      ],
    },
  ],
});

/* ---------------------------------------------------------------- *
 * Newer subsystems that grew their own test trees after the original 20
 * domains were hand-curated, plus catch-all domains so NO canonical test
 * is ever invisible in the tab. Globs are directory/prefix-level so new
 * tests in an existing area appear with no registry edit; a genuinely new
 * subsystem (a new top-level dir) trips the coverage guard
 * (scripts/lint-tests.ts) which forces a one-line glob add here.
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'gym',
  label: 'Gym',
  description: 'Agent gym / eval harness.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/gym/**/*.test.ts',
      ] },
    // Self-contained boot E2Es (testcontainer PG + a dedicated headless
    // gym-operator; no live operator needed) — surfaced as runners.
    { id: 'e2e', label: 'Boot E2E', runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/gym/wake-mode-run.ts'],
          label: 'wake-mode autonomous chain links 1→4 (fake, zero-LLM — hive-loop-e2e P-006)',
        },
      ] },
  ],
});

// inference-gateway: the multi-account LLM inference gateway (the egress chokepoint
// every model call routes through). It grew a large test tree under
// lib/inference-gateway/ that was only ever globbed by the operator-core catch-all —
// this surfaces it as its own first-class subsystem view, grouped by concern. Files
// also match the operator-core catch-all (overlap intentional, like the other
// subsystem domains). The `lib` catch-the-rest section means a new gateway test
// appears here with no registry edit.
defineTestDomain({
  id: 'inference-gateway',
  label: 'Inference Gateway',
  description:
    'The multi-account LLM inference gateway: the transparent proxy/routing surface + pure budget parsers, account failover + cache-affinity routing, credential store, per-account egress circuit, self-heal/wedge resilience, rate-limit stall-autowake, launch composition + observability, and the spawn-env wiring.',
  tier: 'domain',
  sections: [
    {
      id: 'proxy',
      label: 'Proxy & routing',
      description:
        'The transparent proxy: OAuth + anthropic-beta injection, request/response header discipline, method/query forwarding, admission + load-shed, the upstream/token/downstream stall guards, bare-429 + usage-cap + org-disallow failover, AIMD admission concurrency, the priority-TIER admission layer (per-tier caps + reserved tier-1 floor + tier-aware shedding + per-tier /stats), prompt-cache instrumentation, and the chaos battery — plus the pure budget parsers (estimateTokens / parseRateReset / parseUnifiedWindow / parseUnified7dWindow) and the admin/observability endpoints (/healthz, /stats, /admin/config, /admin/reload, /admin/stalls).',
      globs: [
        'packages/operator-core/lib/inference-gateway/gateway.test.ts',
        'packages/operator-core/lib/inference-gateway/gateway-thorough.test.ts',
        'packages/operator-core/lib/inference-gateway/gateway-openai-proxy.test.ts',
        'packages/operator-core/lib/inference-gateway/gateway-priority-tiers.test.ts',
        'packages/operator-core/lib/inference-gateway/unified-7d-window.test.ts',
      ],
    },
    {
      id: 'failover',
      label: 'Account failover & routing',
      description:
        'The multi-account failover pool: round-robin-to-capacity, 5h-exhaustion rotation, cache-affinity select, atomic hot-reload, and the end-to-end account-resolution + routing path.',
      globs: [
        'packages/operator-core/lib/inference-gateway/account-failover.test.ts',
        'packages/operator-core/lib/inference-gateway/account-resolver.test.ts',
        'packages/operator-core/lib/inference-gateway/account-routing-e2e.test.ts',
      ],
    },
    {
      id: 'credentials',
      label: 'Credential store',
      description: 'Credential-ref parsing, OAuth beta merge, token-file/env channels, and resolver caching + refresh.',
      globs: ['packages/operator-core/lib/inference-gateway/credential-store.test.ts'],
    },
    {
      id: 'egress',
      label: 'Egress circuit',
      description: 'The per-account egress dispatcher + the transport-failure circuit (open → pause → half-open probe → readmit).',
      globs: ['packages/operator-core/lib/inference-gateway/gateway-egress-circuit.test.ts'],
    },
    {
      id: 'resilience',
      label: 'Self-heal & wedge',
      description: 'The in-process self-heal release valve + the external wedge detector (summarizeGatewayMetrics / detectGatewayWedge / sampleGateway).',
      globs: [
        'packages/operator-core/lib/inference-gateway/gateway-self-heal.test.ts',
        'packages/operator-core/lib/inference-gateway/gateway-wedge.test.ts',
      ],
    },
    {
      id: 'stall-autowake',
      label: 'Stall autowake',
      description: 'The rate-limit stall recorder → stall-waker auto-wake of a confirmed-idle bee (false-positive guard, capacity wait, de-dup, wake cap).',
      globs: ['packages/operator-core/lib/inference-gateway/stall-waker.test.ts'],
    },
    {
      id: 'launch-observability',
      label: 'Launch & observability',
      description: 'Service composition (resolver + pool → proxy), the hot-reload endpoints, and the headroom read-model projection.',
      globs: [
        'packages/operator-core/lib/inference-gateway/launch.test.ts',
        'packages/operator-core/lib/inference-gateway/observability.test.ts',
      ],
    },
    {
      id: 'spawn-env',
      label: 'Spawn env wiring',
      description: 'gatewaySpawnEnv / gatewayLlmEnv: ANTHROPIC_BASE_URL patching + x-papercusp-account / x-papercusp-owner / x-papercusp-priority (role → admission tier, flag-gated) header emission for spawned agents.',
      globs: [
        'packages/operator-core/lib/inference-gateway/spawn-env.test.ts',
        'packages/operator-core/lib/inference-gateway/resolve-spawn-gateway-env.test.ts',
      ],
    },
    // Catch-the-rest so a new inference-gateway test appears here with no registry edit.
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/inference-gateway/**/*.test.ts'] },
  ],
});

// scout: the autonomous idea-scout (corpus-grounded creative ideation). Surfaces its
// growing pure test tree (grading invariants, LLM-JSON extraction, the run loop, critique
// scoring) as a first-class subsystem view instead of being buried in the operator-core
// catch-all. The `**` glob means a new scout test appears here with no registry edit.
defineTestDomain({
  id: 'scout',
  label: 'Scout',
  description:
    'The autonomous idea-scout: corpus-grounded creative ideation invariants (grounded / forced-diversity / non-duplicate / bettable / no-human-prompt — D-003), the tolerant LLM-JSON extractor (fenced/prose-wrapped responses), critique + novelty scoring, and the run loop.',
  tier: 'domain',
  sections: [{ id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/scout/**/*.test.ts'] }],
});

defineTestDomain({
  id: 'dream',
  label: 'Dreaming',
  description:
    'REM dreaming: cross-time, cross-type fragment sampling and the reviewed insight pipeline.',
  tier: 'domain',
  sections: [{ id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/dream/**/*.test.ts'] }],
});

defineTestDomain({
  id: 'dbos',
  label: 'DBOS',
  description: 'Durable workflow engine: steps, crash-replay, sweep glue.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/dbos/**/*.test.ts',
      ] },
    { id: 'integration', label: 'Integration', globs: ['apps/operator/test/dbos-*.integration.test.ts'] },
  ],
});

defineTestDomain({
  id: 'workspace',
  label: 'Workspace',
  description: 'Workspace registry, multi-workspace context, per-window scoping.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/workspace-*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'adv',
  label: 'ADV Shell',
  description: 'The /adv operator shell: dock panels, sessions, contributors, Vite SPA.',
  tier: 'domain',
  sections: [
    { id: 'panels', label: 'Panels', globs: [
        'apps/operator/app/adv/**/*.test.ts',
        'apps/operator/app/adv/**/*.test.tsx',
        'packages/operator-core/lib/adv-*.test.ts',
      ] },
    { id: 'vite', label: 'Vite SPA', globs: [
        'apps/operator-vite/src/**/*.test.ts',
        'apps/operator-vite/src/**/*.test.tsx',
        // Root-level operator-vite tests (e.g. dev-dist-prune.test.ts — the
        // dev-watch build-churn tooling lives at the package root, not src/).
        'apps/operator-vite/*.test.ts',
      ] },
  ],
});

// behaviour-suite: the DESKTOP agent-behaviour suite (plan desktop-agent-behaviour-suite-2026-07-03).
// It scores a REAL agent's own omp session transcript against 8 codified behaviour checks — the
// desktop counterpart to the headless cert-battery (which drives an LLM directly). Surfaced as its
// own subsystem view; files also match the operator-core catch-all (overlap intentional).
defineTestDomain({
  id: 'behaviour-suite',
  label: 'Behaviour Suite (desktop)',
  description:
    'The desktop agent-behaviour suite: scores a real su/ornith run (its captured omp session transcript) against 8 deterministic, no-LLM-judge checks — model-routing, context-fit, routing-gate, plan-execution, scope-adherence, lock-discipline, fleet-launch, completion-evidence — reusing cert-battery\'s ToolCallStats + verdict shape. The transcript parser + assertions + report are pure; the runner\'s launch/capture I/O sits behind an injected port.',
  tier: 'domain',
  sections: [
    {
      id: 'scoring',
      label: 'Scoring core (assertions + report)',
      description: 'The 8 pure behaviour checks and the report/verdict assembly (a failed critical check fails the run).',
      globs: [
        'packages/operator-core/lib/behaviour-suite/assertions.test.ts',
      ],
    },
    {
      id: 'runner',
      label: 'Runner (transcript capture + orchestration)',
      description: 'The transcript parser and the launch→wait-for-session→capture→score→teardown orchestration (fake fs + fake launch).',
      globs: [
        'packages/operator-core/lib/behaviour-suite/runner.test.ts',
      ],
    },
    {
      id: 'tool',
      label: 'behaviour:run tool',
      description: 'The on-demand agent surface (behaviour:run / behaviour:catalog) that scores a session by id/path or launches + scores a fresh run.',
      globs: [
        'packages/operator-core/lib/agent-tools/behaviour/*.test.ts',
      ],
    },
    // Catch-the-rest so a new behaviour-suite test appears here with no registry edit.
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/behaviour-suite/**/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'operator-core',
  label: 'Operator (core & misc)',
  description: 'Flat catch-all for the operator app: every lib/app/bin/script/integration test, so nothing is invisible. Files here may also appear under a more specific domain — overlap is intentional.',
  tier: 'domain',
  sections: [
    { id: 'repo-root', label: 'repo root', globs: [
        '*.test.ts',
      ] },
    { id: 'lib-root', label: 'lib (root)', globs: [
        'packages/operator-core/lib/*.test.ts',
      ] },
    { id: 'lib-subdirs', label: 'lib (subdirs)', globs: [
        'packages/operator-core/lib/*/*.test.ts',
        'packages/operator-core/lib/*/*.test.tsx',
        'packages/operator-core/lib/*/__tests__/**/*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/**/*.test.ts',
      ] },
    { id: 'lib-tests', label: 'lib/__tests__', globs: [
        'packages/operator-core/lib/__tests__/**/*.test.ts',
      ] },
    { id: 'app', label: 'app', globs: [
        'apps/operator/app/**/*.test.ts',
        'apps/operator/app/**/*.test.tsx',
      ] },
    { id: 'bin-scripts', label: 'bin / scripts', globs: [
        'apps/operator/bin/**/*.test.ts',
        'apps/operator/scripts/**/*.test.ts',
        'scripts/*.test.ts',
        'scripts/*.test.mjs',
        'scripts/lib/**/*.test.ts',
        'scripts/lib/**/*.test.mjs',
      ] },
    { id: 'integration', label: 'Integration (test/)', globs: [
        'apps/operator/test/**/*.test.ts',
        'apps/operator/__tests__/**/*.test.ts',
      ] },
    { id: 'e2e', label: 'E2E (all specs)', globs: ['apps/operator/e2e/*.spec.ts'] },
    // Vitest UNIT tests co-located with the e2e helpers they cover (e.g. the
    // hosted-http1 acceptance config parser) — run by apps/operator's Vitest
    // config, which does not exclude e2e/, never by Playwright.
    { id: 'e2e-helpers', label: 'E2E helpers (unit)', globs: ['apps/operator/e2e/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'libraries',
  label: 'Libraries',
  description: 'Shared libs + packages the operator depends on (libs/*, packages/*, tools/*).',
  tier: 'surface',
  sections: [
    { id: 'generic', label: 'libs/generic', globs: [
        'libs/generic/**/*.test.ts',
        'libs/generic/**/*.test.tsx',
        // papergrid + search-core use `.spec.ts` for Vitest (Restart-style).
        'libs/generic/**/*.spec.ts',
      ] },
    { id: 'papercusp', label: 'libs/papercusp', globs: [
        'libs/papercusp/packages/**/*.test.ts',
        'libs/papercusp/libs/**/*.test.ts',
      ] },
    { id: 'operator-libs', label: 'operator libs', globs: [
        'libs/papercusp-shared/src/**/*.test.ts',
        'libs/papercusp-shared/src/**/*.test.tsx',
        'libs/papercusp-publish-auth/src/**/*.test.ts',
        'libs/host-platform/src/**/*.test.ts',
        'libs/flags/src/**/*.test.ts',
        'libs/test-config/src/**/*.test.ts',
        'libs/testing-shell/src/**/*.test.ts',
        'libs/testing-shell/src/**/*.test.tsx',
        // The standalone publish worker (Cloudflare).
        'apps/papercusp-publish/src/**/*.test.ts',
      ],
      // Live end-to-end smoke against `wrangler dev --local` (register → build
      // manifest → mint JWT → publish/start → upload → finalize).
      runners: [
        { kind: 'node', cmd: 'node', args: ['apps/papercusp-publish/scripts/smoke-test.mjs'], label: 'papercusp-publish e2e (wrangler dev --local)' },
      ] },
    { id: 'ui-libs', label: 'UI libs', globs: [
        'libs/marketplace-public-ui/src/**/*.test.ts',
        'libs/marketplace-public-ui/src/**/*.test.tsx',
        'libs/agent-chat/src/**/*.test.ts',
        'libs/agent-chat/src/**/*.test.tsx',
      ] },
    { id: 'packages', label: 'packages', globs: [
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
      ] },
    // No broad tools/**/*.test.* or tools/**/*.spec.* promise here. The only
    // canonical tests under tools/ are the WebdriverIO specs, registered with
    // their concrete executor in the packaged/wdio section above. A future
    // Vitest-shaped tools/ file must stay an [ORPHAN] until it gains a real
    // workspace/config owner (EI-10445 / EI-15951).
  ],
});

defineTestDomain({
  id: 'harness-framework',
  label: 'Harness Framework',
  description: 'libs/papercusp framework end-to-end smokes (bash). Live — drive real services; surfaced as shell runners, not Vitest.',
  tier: 'surface',
  sections: [
    {
      id: 'smokes',
      label: 'Smokes',
      description: 'Full-stack, planner, and service-gate smokes for the Papercusp harness framework.',
      runners: [
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/bin/papercusp-smoketest.sh'], label: 'framework full-stack' },
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/packages/harness/bin/smoke-test.sh'], label: 'planner smoke' },
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/packages/harness/bin/service-smoke-test.sh'], label: 'service gate (run.sh DONE)' },
      ],
    },
  ],
});

/* ---------------------------------------------------------------- *
 * Composed views (P-011). `papercuspRegistry` = the 20 declared above
 * (read back from the Map by id); `adminRegistry` = universal + papercusp
 * = the full /admin/testing set. The SPA nav order is TestingClient's own
 * TABS, not these arrays.
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'hive',
  label: 'Hive (Mug/bee loop)',
  description:
    'The local-hive orchestration loop: tracked Mug launch, bee placement + nursery, the deliver-and-wake / parent-wake liveness chain, spawn reclaim, host self-recycle, and the Apiary IQ battery. Many files also appear under operator-core (overlap intentional); this is the cohesive subsystem view.',
  tier: 'domain',
  sections: [
    {
      id: 'wake-loop',
      label: 'Wake loop',
      description: 'Deliver-and-wake: parent-wake on bee terminal, the wake executor (resume command + MCP remount), inbox-wake fan, await engine/store, and the end-to-end reclaim→parent-wake liveness contract.',
      globs: [
        'packages/operator-core/lib/fleet/parent-wake.integration.test.ts',
        'packages/operator-core/lib/fleet/hive-wake-loop.integration.test.ts',
        'packages/operator-core/lib/events/await/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/coordination/tools/deliver-and-wake.test.ts',
      ],
    },
    {
      id: 'placement',
      label: 'Placement & nursery',
      description: 'cup:spawn chokepoint, the fleet_assignment (Brood Box) projection, graceful drain, selected-bee, spawn budget/governor, and the concurrency-primitive suite.',
      globs: [
        'packages/operator-core/lib/fleet/operator-spawn.test.ts',
        'packages/operator-core/lib/fleet/assignments*.test.ts',
        'packages/operator-core/lib/fleet/nursery.integration.test.ts',
        'packages/operator-core/lib/fleet/selected-bee.test.ts',
        'packages/operator-core/lib/fleet/spawn-budget.integration.test.ts',
        'packages/operator-core/lib/fleet/governor.integration.test.ts',
        'packages/operator-core/lib/fleet/supervision.integration.test.ts',
        'packages/operator-core/lib/fleet/saga.integration.test.ts',
        'packages/operator-core/lib/fleet/lock-release.integration.test.ts',
        'packages/operator-core/lib/fleet/classic-*.test.ts',
        'packages/operator-core/lib/agent-tools/fleet/**/*.test.ts',
      ],
    },
    {
      id: 'reclaim',
      label: 'Reclaim',
      description: 'P-011 heartbeat-stale reclaim of orphaned spawns (frees the concurrency ceiling; fires parent-wake).',
      globs: ['packages/operator-core/lib/fleet/spawn-reclaim.integration.test.ts'],
    },
    {
      id: 'host-health',
      label: 'Host health',
      description: 'Operator self-protection: the memory watchdog (bounded-RSS self-recycle) and the event-loop-lag gauge.',
      globs: [
        'packages/operator-core/lib/memory-watchdog.test.ts',
        'packages/operator-core/lib/event-loop-lag-monitor.test.ts',
      ],
    },
    {
      id: 'apiary',
      label: 'Apiary IQ battery',
      description: 'The Apiary instance-gym: corpus seeder, the seven metric collectors, and the Beekeeper runner.',
      globs: ['packages/operator-core/lib/iq-battery/**/*.test.ts'],
    },
  ],
});

// The SHARED-HIVE federation: sharing one Hive's work across SOVEREIGN peer Hives
// (shared-hive-federation-2026-06-08 / cross-hive-boundary-2026-06-08). Distinct from the
// `hive` domain (the LOCAL Queen/bee loop): this is the cross-Hive substrate — the mediated
// boundary (owner-set capability grants → admit → translate into B's own conversation/work_item),
// the signed wire + store-and-forward outbox, the Hyperswarm transport, the P2P hive directory,
// per-Hive identity/membership/settings + contributor revocation, and the Hive-scoped work-item
// claim authority. Files also appear under operator-core (overlap intentional, like `hive`);
// this is the cohesive subsystem view a reviewer of "Shared Hive" wants in one place.
defineTestDomain({
  id: 'shared-pot',
  label: 'Shared Hive (federation)',
  description:
    'Cross-Hive peer-to-peer federation: the mediated Hive→Hive boundary (capability-grant admission + translation), signed wire + store-and-forward outbox, Hyperswarm transport, the P2P hive directory, per-Hive identity/membership/settings + contributor revocation, and Hive-scoped work-item claim authority.',
  tier: 'domain',
  sections: [
    {
      id: 'boundary',
      label: 'Boundary (admit + signed wire)',
      description:
        'The sovereignty boundary: capability-grant allow-list admission (default-deny, per-peer, per-kind), translation into B\'s ordinary conversation/work_item surfaces, the Ed25519-signed wire envelope + verify (incl. malformed-input robustness + correlationId canonicalization), the durable store-and-forward outbox (partial-failure recovery + id-keyed dedup), and the persisted grant store.',
      globs: [
        'packages/operator-core/lib/cross-hive-boundary*.test.ts',
        'packages/operator-core/lib/cross-hive-transport*.test.ts',
        'packages/operator-core/lib/cross-hive-grants.integration.test.ts',
        'packages/operator-core/lib/cross-hive-outbox-pg.integration.test.ts',
      ],
    },
    {
      id: 'transport-swarm',
      label: 'Hyperswarm transport + live wire',
      description:
        'The Hive-pubkey-topic Hyperswarm transport (dial-by-pubkey, subscribe, close) and the live two-Hive wire E2E over a real Hyperswarm testnet (bidirectional ask→answer). NOTE: the two-hive testnet wire test is timing-flaky on the DHT and is actively being stabilized.',
      globs: [
        'packages/operator-core/lib/cross-hive-swarm-transport.test.ts',
        'packages/operator-core/lib/cross-hive-e2e.test.ts',
        'packages/operator-core/lib/cross-hive-two-hive.test.ts',
      ],
    },
    {
      id: 'directory',
      label: 'Hive directory + publish',
      description:
        'The P2P hive-discovery directory (verified-only ingest, LWW dedup, mute, visibility-routed announce, TTL GC, boot wiring) plus announce-on-publish and the harness→Hive swarm-binding re-key.',
      globs: [
        'packages/operator-core/lib/hive-directory*.test.ts',
        'packages/operator-core/lib/hive-publish.test.ts',
        'packages/operator-core/lib/hive-federation.test.ts',
      ],
    },
    {
      id: 'identity',
      label: 'Identity & store',
      description: 'Per-Hive Ed25519 identity get-or-mint + pubkey resolution, and the hive entity PG store (pubkey/keychain CRUD, workspace scoping).',
      globs: [
        'packages/operator-core/lib/hive-identity*.test.ts',
        'packages/operator-core/lib/hive-store.integration.test.ts',
      ],
    },
    {
      id: 'membership',
      label: 'Membership, settings & revocation',
      description:
        'Per-Hive contributor admission (device pubkeys, the revoked-pubkey union), federated per-Hive settings, owner revocation of a Hive contributor (blocklist into the owner row), and the P-MEMBER/P-MOD owner-enforcement boundary end-to-end against real PG — open auto-admit, approval-mode pending → owner approve/deny, and ban/unban re-join refusal.',
      globs: [
        'packages/operator-core/lib/hive-membership-store.integration.test.ts',
        'packages/operator-core/lib/hive-membership-admission.integration.test.ts',
        'packages/operator-core/lib/hive-settings-store.integration.test.ts',
        'packages/operator-core/lib/hive-revoke-contributor.test.ts',
      ],
    },
    {
      id: 'claim-authority',
      label: 'Work-item claim + replica authority',
      description:
        'The Hive-scoped work-item arbitration seams (single-peer local authority + the Track-B swap-in registry) and their stores: (1) the CLAIM lease — acquire/heartbeat/release op routing, lease lifecycle, concurrency races, two-instance split; and (2) the BOINC REDUNDANCY replica store (EI-266) — the per-Hive replica-authority seam + the claim-slot/heartbeat/release/record-result/list/judge op routing that homes the N replicas of a high-stakes item in ONE store so cross-swarm replicas meet, plus the replica lease/steal/record/judge store behavior.',
      globs: [
        'packages/operator-core/lib/work-item-claim-authority*.test.ts',
        'packages/operator-core/lib/work-item-claims*.test.ts',
        'packages/operator-core/lib/work-item-replica-authority*.test.ts',
        'packages/operator-core/lib/work-item-redundancy*.test.ts',
      ],
    },
    {
      id: 'tab-suite',
      label: 'Tests-tab federation suite (shared-hive-core)',
      description:
        'The shared-hive-core Tests-tab suite (buildSharedHiveCoreChecks) + its CI guard: the live end-to-end federation check composing the shipped modules — the Hive-pubkey topic re-key, Ed25519 hive identity, the per-Hive lock-authority election + file-claim routing (P-009), the instant lock-handover event fold (P-015), the work-item claim/replica seams, and the real shared_presence election + per-Hive admission union (P-006) against a throwaway Postgres. The one automated gate behind the live Tests-tab suite (mirrors memory-core).',
      globs: ['packages/operator-core/lib/shared-pot/**/*.test.ts'],
    },
    {
      id: 'authority',
      label: 'Lock authority (election, failover, fencing, RPC, caller-auth)',
      description:
        'The D-005 deterministic lock/claim authority layer: argmin election + staleness failover over presence (harness + Hive scope), hardened epoch fencing + anti-flap, the authority-op registry, the HTTP peer-RPC transport + boot wiring + address resolution, file-lock authority ops + Hive-aware routing, the two-instance authority rigs, cross-machine lock failover mid-hold (P-007), the failover flood (P-003), the lock-set reconstructor handover, the remote-peers fast-path cache, and the EI-322 authenticated peer-RPC envelope (Ed25519 sign/verify, freshness, holderPubkey identity binding + revocation in the receiving caller-verifier, end-to-end signed/forged/tampered loopback).',
      globs: ['packages/operator-core/lib/authority/__tests__/**/*.test.ts'],
    },
    {
      id: 'wire-federation',
      label: 'Federation wire (peers, presence, partition, coord rails)',
      description:
        'The Hive-relevant slice of the hyperbee substrate over the REAL wire (the full substrate suite lives at dogfood/substrate — overlap by design): two-peer + bidi swarms, three-peer partition/rejoin convergence, presence announce + hive_slug projection, the federated coord rails (messages/threads/conversations incl. the deliver-and-wake intent), the federation triggers (hive members, plan-item assignment, engineer issues, feature content, substrate outbox), the adversarial two-peer battery, swarm join/guard/chaos, topic derivation + default binding, and the live two-peer hive directory.',
      globs: [
        'packages/operator-core/lib/sync/hyperbee/__tests__/hive-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/two-peer*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/three-peer-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/presence-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/wire-presence.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/federation-adversarial.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/coord-*-federation.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/*federation-trigger.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/feature-content-federation.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/cross-plan-federation-seam.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/plan-item-assignment-two-peer-federation.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/substrate-outbox-trigger.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/swarm*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/convergence.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/derive-swarm-topic.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/default-swarm-binding-p007.test.ts',
      ],
    },
    {
      id: 'coordination',
      label: 'Cross-peer coordination (presence→authority→claim→failover/partition)',
      description:
        'Coordination across the shared Hive end-to-end: two REAL peers federate presence over the wire → the federated roster drives a CONSISTENT (no-split-brain) Hive authority election → both Swarms contend for one work-item and the federated-presence-elected authority grants EXACTLY ONE (cross-peer exactly-once). Plus the topology-change legs over the same real federated roster: the authority Swarm DEPARTS → staleness deposes it and the survivor elects itself (D-005 failover by definition) with claims continuing locally; a PARTITION (authority fresh in roster, RPC severed) → the non-authority fails open LOUDLY into its own store (D-004, the documented optimistic split-brain window), then routes remote-authority again on heal; THREE-peer failover consistency (both survivors independently elect the SAME successor; contended claim grants exactly one) + departed-Swarm REJOIN reconverging all three on the original argmin; the full claim LEASE LIFECYCLE across peers (acquire remote → contention refused → release remote → re-acquire); FILE-LOCK routing (the production routeFileLockOp cutover seam) resolving its Hive scope off the federated roster and crossing the wire (grant / busy-with-holder / release); DELIVER-AND-WAKE over the real wire (a body.wake coord-message federates A→B; B fires the fan EXACTLY once; the EI-117 echo breaker keeps A at one origin=local copy); and SCALE (the -scale sibling file — own vitest worker, see _cross-peer-rig.ts): a FIVE-Swarm cascade where every authority departure is followed by UNANIMOUS re-election among all survivors and claims serialize at every epoch, 5→1. Closes the gap the injected-roster authority/claim suites leave open.',
      globs: ['packages/operator-core/lib/sync/hyperbee/__tests__/cross-peer-coordination*.integration.test.ts'],
    },
    {
      id: 'loop-composition',
      label: 'Multi-swarm loop composition (hermetic 2-swarm rig)',
      description:
        'The shared-hive autonomous LOOP as a system (shared-pot-loop-e2e-testing-2026-06-10): the hermetic 2-swarm composition rig — scripted Mug steering → concurrent cross-swarm claim_next + authority lease → fake pipelines → real CDC convergence — plus the chaos scenarios (partition fail-open + reconcile, kill-authority re-election, lease-steal D-007 adoption, split-brain Mug D-008 gate/detector, outbox write-storm, two-identity redundancy) and the Phase-3 fleet monitors (double-completion scanner, orphaned-taken_by sweep, outbox health, presence ghosts, convergence-lag probe). Brief 12\'s coord verb-lifecycle two-cell suite rides the same rig.',
      globs: ['packages/operator-core/lib/shared-pot-loop/**/*.test.ts'],
    },
    {
      id: 'tools',
      label: 'Hive agent tools',
      description: 'The agent-facing hive lifecycle tools: pot:create / pot:add-member, discovery:pots, and harness create→hive-membership wiring.',
      globs: [
        'packages/operator-core/lib/agent-tools/pot/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/discovery/pots.test.ts',
        'packages/operator-core/lib/agent-tools/harness/__tests__/create-pot-membership.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'operator-ui-lib',
  label: 'Operator UI lib',
  description: 'UI-tier lib kept in apps/operator after the operator-core carve (router-compat, flag-hooks, plugin UI, forms, chat-cards, theme/notify/visual-effects hooks + the operator-vite/script/bin-composition tests).',
  tier: 'quick',
  sections: [
    { id: 'all', label: 'UI lib', globs: ['apps/operator/lib/**/*.test.ts', 'apps/operator/lib/**/*.test.tsx'] },
  ],
});

// The adversarial coordination test suite (coordination-test-suite-2026-06-08) as a
// cohesive cross-subsystem VIEW, grouped by the test CLASSES that were missing when
// EI-152/EI-153 shipped. Files also appear under their home domains (hive/wake-loop,
// papercusp-su, operator-core) — overlap is intentional, exactly like the `hive`
// domain. The companion coverage matrix is /internal/docs/testing/coordination-coverage-matrix.
defineTestDomain({
  id: 'coordination-suite',
  label: 'Coordination suite (adversarial)',
  description:
    'The adversarial, multi-session, real-seam coordination suite that closes the EI-152/EI-153 escape classes: cross-agent isolation, real-seam integration, multi-session concurrency, and the liveness matrix. Cross-subsystem view; files overlap their home domains by design.',
  tier: 'domain',
  sections: [
    {
      id: 'feature-change-reconciliation',
      label: 'Feature-change reconciliation',
      description:
        'Durable aggregate validation for feature-change candidate settlement, terminal-shard coverage, and honest zero-state readiness.',
      globs: [
        'scratchpad/feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p004-validation-aggregate.test.mjs',
      ],
    },
    {
      id: 'wake-liveness',
      label: 'C4 liveness matrix + EI-152',
      description: 'The wake-executor liveness×handle/socket matrix over the REAL socket seam; EI-152 (no-handle + live socket → socket-inject, not park) verified red-on-pre-fix.',
      globs: ['packages/operator-core/lib/events/await/wake-executor-matrix.test.ts'],
    },
    {
      id: 'wake-identity',
      label: 'C5 identity + EI-153',
      description: 'Cross-agent wake isolation + identity across resume (per-owner CLAUDE_CONFIG_DIR / CODEX_HOME, exact-session resume never --continue) + the launch-side per-spawn config isolation (headless bees) AND the interactive psu/SU + role claude config-dir materializer (EI-155 — a symlink mirror of ~/.claude with an isolated transcript store).',
      globs: [
        'packages/operator-core/lib/events/await/wake-resume-isolation.test.ts',
        'libs/papercusp/packages/orchestrator/src/spawn-config-isolation.test.ts',
        'packages/operator-core/lib/interactive-claude-config.test.ts',
      ],
    },
    {
      id: 'fork-identity',
      label: 'C5 fork identity (psu --resume --fork)',
      description:
        'psu --resume --fork mints a genuinely fresh, PERSISTED adv_sessions identity (distinct coord owner id + forced native id) that branches the original’s history and runs concurrently WITHOUT mutating the original — proven against real PG (real recordAdvSession / listResumableSessions / markAdvSessionEnded + the real launcher fork fns: forkBootstrapBody / resumeArgsFor / resumeEnvFor / nativeSessionIdFromLaunchArgs).',
      globs: ['apps/operator/lib/psu-launcher-fork.integration.test.ts'],
    },
    {
      id: 'resume-live',
      label: 'C5 real resume spawn (live)',
      description: 'LIVE-SMOKE (needs claude/codex creds → not CI): a REAL claude/codex resume — built by the SAME wake-executor resumeCommandFor, run in the EI-155 isolated CLAUDE_CONFIG_DIR/CODEX_HOME — continues the EXACT session (transcript/rollout GROWS). Complements the injected-spawnDetached CI rung in wake-resume-isolation.test.',
      runners: [
        { kind: 'node', cmd: 'npx', args: ['tsx', 'apps/operator/scripts/resume-spawn-live.ts'], label: 'real claude/codex resume (live · needs creds)' },
      ],
    },
    {
      id: 'wake-realseam',
      label: 'C2/C6 real-seam pump + host',
      description: 'The real psu-pty-host idle-gate + mode:turn CR-submit + discovery handshake; the real emit→pump path with armInboxWake idempotency and cross-agent isolation.',
      globs: [
        'apps/operator/lib/psu-pty-host-turn.integration.test.ts',
        'packages/operator-core/lib/events/await/wake-pump-isolation.integration.test.ts',
      ],
    },
    {
      id: 'channel-isolation',
      label: 'C1 channel isolation (coord/locks)',
      description: 'Cross-agent isolation for coord:send/inbox/presence (real PgCoordLog) and file/resource locks (A can\'t release/heartbeat B\'s; block-on-held; authority election) + the file-lock PreToolUse hook decision rendering (block-on-held deny / fail-open).',
      globs: [
        'packages/operator-core/lib/agent-tools/coordination/__tests__/cross-agent-isolation.integration.test.ts',
        'packages/operator-core/lib/agent-tools/locks/__tests__/cross-agent-isolation.integration.test.ts',
        'apps/operator/scripts/hooks/cc/__tests__/pretooluse-locks-decision.test.ts',
      ],
    },
    {
      id: 'concurrency-federation',
      label: 'C3 concurrency + federation',
      description: 'N-session claim concurrency (no double-claim), federation data-plane (peer-log→projection→PG, admission/revocation, no-loss/no-dup), and the full multi-session concurrency capstone (wakes+sends+claims+locks → zero loss/dup/misroute).',
      globs: [
        'packages/operator-core/lib/work-item-claims-concurrency.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/federation-adversarial.integration.test.ts',
        'packages/operator-core/lib/multi-session-concurrency.integration.test.ts',
      ],
    },
  ],
});

// First-party Rust crates — Cargo is one of the four canonical frameworks
// (testing/index.mdx §1.0a) but these crates were never surfaced in the Tests
// tab. The repo has NO root Cargo workspace, so the `cargo` runner kind's
// classic `-p <crate>` form (which resolves a crate from a workspace root)
// cannot find any of these crates from the repo root. EI-1610's proper fix:
// each section now targets its crate via `kind:'cargo'` + `manifestPath`
// (`cargo test --manifest-path <dir>/Cargo.toml`, verified against all four
// crates) instead of a `shell` cd-and-run workaround — proper framework
// categorization (Tests tab counts these as Cargo, not Shell) + the JSON
// reporter path testing-run.ts's cargo case already parses. Tests live in
// `#[cfg(test)]` modules under each crate's src/. Files are .rs, so they are
// never canonical-test orphans — the gap was purely that no domain RAN them;
// this domain closes it.
defineTestDomain({
  id: 'rust',
  label: 'Rust (Cargo)',
  description:
    'First-party Rust crates: the pui/TUI workbench, the pui companion proto + zellij plugin, and the papercusp-desktop Tauri shell. Run via `cargo test --manifest-path` (the repo has no root Cargo workspace, so each crate is targeted by its own manifest). The desktop crate needs the Tauri system deps (webkit2gtk/gtk) installed to build.',
  tier: 'surface',
  sections: [
    {
      id: 'pui',
      label: 'pui (apps/tui)',
      description: 'The Rust TUI / pui workbench (cargo pkg `pui`) — 35 files carry #[cfg(test)] modules.',
      runners: [{ kind: 'cargo', crate: 'pui', manifestPath: 'apps/tui/Cargo.toml' }],
    },
    {
      id: 'pui-companion-proto',
      label: 'pui-companion-proto',
      description: 'The pui companion wire-protocol crate.',
      runners: [{ kind: 'cargo', crate: 'pui-companion-proto', manifestPath: 'apps/pui-companion-proto/Cargo.toml' }],
    },
    {
      id: 'pui-companion',
      label: 'pui-companion (zellij plugin)',
      description: 'The zellij companion plugin crate (cargo pkg `pui-companion`, dir apps/pui-zellij-plugin).',
      runners: [{ kind: 'cargo', crate: 'pui-companion', manifestPath: 'apps/pui-zellij-plugin/Cargo.toml' }],
    },
    {
      id: 'desktop',
      label: 'papercusp-desktop (Tauri shell)',
      description: 'The Tauri desktop shell (papercusp-desktop/src-tauri) — 11 files carry #[cfg(test)] modules. Needs the Tauri system deps to build.',
      runners: [{ kind: 'cargo', crate: 'papercusp-desktop', manifestPath: 'papercusp-desktop/src-tauri/Cargo.toml' }],
    },
  ],
});

// papercusp-desktop bash self-tests (EI-18725214765732588): these guard the
// live-federation rig + release-leg reaper scripts (release artifacts,
// latest-manifest generation, gate/leg reapers, matrix-starvation downgrade,
// rig log banking, and port self-discovery) but were referenced by NOTHING —
// no aggregate script, no CI workflow, no green gate. Only federation-asserts
// had a single live caller (live-federation-gate.sh), and only inside that
// gate's own run, never in CI. Verified hermetic (synthetic localhost-only
// HTTP listeners + static grep assertions, no docker/ssh/real network) before
// wiring in. `test:selftests` (papercusp-desktop/package.json, backed by
// bin/lib/run-selftests.sh) runs the same set as one aggregate; this domain
// surfaces them individually in the Tests tab / admin Testing dashboard,
// closing the "dark test" gap the same way EI-1610 closed it for the Rust
// crates above.
defineTestDomain({
  id: 'desktop-selftests',
  label: 'Desktop Selftests (bash)',
  description:
    'papercusp-desktop bash self-tests for the live-federation rig + release-leg scripts. Pure/hermetic — synthetic localhost listeners and static grep assertions only, no docker/ssh/real network.',
  tier: 'surface',
  sections: [
    {
      id: 'selftests',
      label: 'Selftests',
      description: 'The previously-dark shell selftests (EI-18725214765732588), now wired into the aggregate runner + this registry, plus later additions guarding the same rig scripts.',
      runners: [
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/federation-asserts.selftest.sh'], label: 'federation port self-discovery' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/release-artifacts.selftest.sh'], label: 'release artifacts guard' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/release-content-identity.selftest.sh'], label: 'release content identity — per-platform stage identity + receipt invalidation' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/release-tag-pin.selftest.sh'], label: 'release tag pin + exact repair guard' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/gen-latest-manifest.selftest.sh'], label: 'latest-manifest generation' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/live-federation-gate-reaper.selftest.sh'], label: 'live-federation-gate reaper' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/release-local-leg-reaper.selftest.sh'], label: 'release local-leg reaper' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/local-matrix-starvation.selftest.sh'], label: 'local-matrix starvation downgrade' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/rig-bank-logs.selftest.sh'], label: 'rig bank-logs' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/local-matrix-bank.selftest.sh'], label: 'local-matrix teardown evidence banking (EI-18660101091813036)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/vm-run-env.selftest.sh'], label: 'vm_run guest-env delivery (WI-6176)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/seat-offer-diag.selftest.sh'], label: 'seat-offer b→a failure discriminator (WI-6179)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/b9-attestation-precondition.selftest.sh'], label: 'LEG4 attestation precondition + both-frames restore (WI-5064)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/b3-revocation-kcut.selftest.sh'], label: 'revocation K-cut: the device-scoped absence assert resolves a KEY-BEARING device (never the synthetic att2dev one), and delivery is not classified as disclosure (EI-18712383368117845)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/b5-restart.selftest.sh'], label: 'restart durability: failing runs retain every passing assertion in the transcript (EI-21115093867849562)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/b6-concurrent.selftest.sh'], label: 'concurrent_lww adapter: a failing run keeps its PHASE2 failure-time diagnostics in the transcript (WI-10003114)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/matrix-scenario-adapters.selftest.sh'], label: 'live-matrix sibling adapters: failing runs retain every passing assertion in the transcript (EI-21116501794646084)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/matrix-verdict-states.selftest.sh'], label: 'matrix PASS/FAIL/UNMEASURED verdict states: a scenario that ran but could not hold its own precondition renders UNMS, is not counted as a pass, and never masks a real FAIL (WI-6046)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/matrix-pass-transcript.selftest.sh'], label: "matrix PASS-path transcript: a passing scenario's own ✓/⚠/✗/OVERALL verdict lines reach the run log, so a fail-closed NOT-MEASURED instrument cannot render silent and read as a clean result (WI-40593)" },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/replication-soak-diagnostics.selftest.sh'], label: 'replication-soak failed-leg detector window + row/outbox/announce high-water diagnostics (WI-38376)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/restart-settle-barrier.selftest.sh'], label: 'restart settle-barrier budget + WARN_IS_FAIL escalation (WI-6181)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/rig-wait-converged.selftest.sh'], label: 'rig wait-converged: non-numeric psql is not a false PASS (WI-6181)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/roster-scope.selftest.sh'], label: 'roster-gate workspace + pot scoping (WI-6181)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/deployed-state-guards.selftest.sh'], label: 'rig deployed-state: uniform sidecar + build provenance + DHT isolation (WI-6212)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/inno-legacy-reaper.selftest.sh'], label: 'Windows installer legacy-uninstall reaper: ghosts reaped, LIVE entries spared (WI-4490)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/inno-uninstall-cleanup.selftest.sh'], label: 'Windows installer UNINSTALL cleanup: login-autostart removed, sibling role + shared runtime spared (WI-39403)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/rust-path-remap.selftest.sh'], label: 'Rust build-box path remap: every build entry point sets it itself + is idempotent (EI-20075266271803900)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/disk-preflight.selftest.sh'], label: 'Build disk preflight: refuses ENOSPC(28) up front, fails open when unmeasurable, and every staging entry point calls it (EI-20090527288494606)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/mac-vm-fresh-state.selftest.sh'], label: 'macOS fresh-install state isolation: trap-restores both Papercusp roots across PASS/FAIL/TERM and refuses stale backups (EI-20332777704574867)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/streak-escalation.selftest.sh'], label: 'live-federation-gate streak escalation: a run of consecutive non-GREEN verdicts computes its own streak length and escalates, instead of going quiet because each repeat reason was already filed (WI-39354)' },
        { kind: 'shell', cmd: 'bash', args: ['papercusp-desktop/bin/lib/remote-object-state.selftest.sh'], label: 'upload-release.sh remote_state: a multipart object is never accepted on SIZE alone, so a rebuilt-but-same-size artifact cannot be silently kept as already-uploaded (EI-23963309971611146)' },
      ],
    },
  ],
});

/**
 * The registration Map is the canonical domain identity set. Deriving these
 * views from it closes the stale-declaration direction: adding a domain is one
 * registration, not a registration plus a second hand-maintained id list.
 * Universal entries are the only entries excluded from the Papercusp view;
 * `adminRegistry` preserves the shared Map's complete, deterministic order.
 */
export const adminRegistry: TestDomain[] = listTestDomains();
export const papercuspRegistry: TestDomain[] = adminRegistry.filter((d) => d.tier !== 'universal');
