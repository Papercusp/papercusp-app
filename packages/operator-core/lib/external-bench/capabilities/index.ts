/**
 * external-bench/capabilities — the shared SUBSTRATE for the benchmark
 * capability-injection redesign (plan benchmark-capability-injection-redesign-2026-06-17,
 * P-001 + P-002): a reusable capability palette + a per-run sandbox that lets a benchmark
 * agent use our REAL systems (memory / work-queue / coord) in a way that (a) never touches
 * production, (b) accumulates within a run, (c) is wiped between runs/arms.
 *
 * The three pieces:
 *   - {@link RunSandbox} ({@link openRunSandbox}) — the per-(suite-run × arm) isolation
 *     boundary, backed by a per-run ephemeral hive whose `potSlug` is the shared namespace.
 *   - {@link CapabilityTool} wrappers — thin functions exposing the real `memory:*` /
 *     `work_items:*` / `coord:*` verbs as agent-callable tools, each bound to a sandbox.
 *   - {@link CapabilityProfile} + {@link materializeProfile} — named capability sets
 *     (`vanilla` / `+memory` / `+coord` / `+workqueue` / `ours`) → bound tools.
 *
 * NOT wired into any driver yet — that's the next phase (P-003+), coordinated with the team.
 */
export type {
  CapabilityKind,
  CapabilityTool,
  JsonSchema,
  JsonSchemaProperty,
  RunSandbox,
  RunTool,
  RunToolResult,
  SandboxHiveOps,
  SandboxId,
} from './types';

export { openRunSandbox, liveSandboxHiveOps } from './run-sandbox';
export type { OpenRunSandboxArgs } from './run-sandbox';

export {
  liveRunTool,
  unwrapRunToolPayload,
  toolsForCapability,
  CAPABILITY_TOOL_FACTORIES,
  memoryRememberTool,
  memorySearchTool,
  workqueueEnqueueTool,
  workqueueClaimTool,
  workqueueCompleteTool,
  coordConsultTool,
  coordHandoffTool,
  coordAskTool,
} from './capability-tools';
export type {
  OpenRunSandboxDeps,
  CapabilityToolFactory,
  MemoryRememberArgs,
  MemorySearchArgs,
  WorkqueueEnqueueArgs,
  WorkqueueClaimArgs,
  WorkqueueCompleteArgs,
  CoordConsultArgs,
  CoordHandoffArgs,
  CoordAskArgs,
} from './capability-tools';

export {
  CAPABILITY_PROFILES,
  resolveProfile,
  materializeProfile,
} from './capability-profile';
export type { CapabilityProfile, CapabilityProfileName } from './capability-profile';
