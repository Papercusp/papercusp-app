/**
 * fleet:launch-on-plan — stand up a desktop fleet ON a plan in ONE call.
 *
 * Collapses the multi-step "create a desktop fleet to work a plan" flow
 * (improve-fleet-launch-autokickoff / EI-5504) that used to be:
 *   fleet:create → write a launch brief → capability:terminal (N psu windows)
 *   → coord:send a manual kickoff wake to each parked member.
 * into a single tool:
 *   1. ensure the named fleet exists (idempotent) with the caller as leader;
 *   2. validate the target plan exists in the harness;
 *   3. open N visible desktop member terminals, each running a scripted psu
 *      launch on the plan.
 *
 * The members AUTO-START: a scripted `psu --no-picker --plan=…` launch now seeds
 * the agent's first user-turn REQUEST (EI-5503), so no separate leader kickoff is
 * needed. Process open, session registration, first-turn verification and task
 * disposition remain separate observations; the public result must not collapse
 * the request into proof that every member is already working.
 *
 * Plan AUTHORING + START stay their own well-factored tools (plans:apply-plan-block
 * / plans:new + plans:add-item, then plans:start) — chain them before this. plans:start
 * is REQUIRED, not optional: fleet members self-pull via `scheduler:get_next`, which leases
 * WORK-ITEMS (not raw plan items), and plan items become claimable work-items ONLY via the
 * plans:start promotion path (promotePlanItems). Skip plans:start and the fleet launches
 * onto an EMPTY backlog — every member's get_next returns nothing and they idle (the
 * research-desk 2026-07-08 miss: plan authored + set active, never started → zero work-items).
 * So the primary contract is "plans:start BEFORE this tool." As a FAILSAFE (not a substitute),
 * this tool idempotently promotes the plan's open items to claimable work-items before opening
 * any terminal, so a forgotten plans:start can never strand the fleet; it also sets a
 * plan-scoped claim spec so members' get_next stays on THIS plan.
 *
 * Reuses the maintained machinery rather than forking: createFleetIfAbsent (the
 * fleet:create registry path) + buildConsoleEnvelope/spawnConsole (the
 * capability:terminal desktop-spawn path). Desktop-spawn works on Linux + macOS
 * (server-side) AND Windows (WI-3289: relayed to the desktop shell's Tauri
 * console_launch over the sync-bus bridge — the desktop window must be open).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES, fuzzyEnumAsync } from '@papercusp/agent-mcp';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { spawnGovernedAgentProcess } from '../../resource-governor/spawn-execution';
import type { AdmissionContext } from '../../resource-governor/admission';
import { activeWorkspaceId } from '../../workspace-registry';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { resolveProjectDir } from '../../spawn-config';
import { isSuTierRole } from '../../su-role-addendum';
import { DEFAULT_MODEL_TIERS, splitModelSpec, validateCloudModelSpec } from '../../agent-config-constants';

/**
 * The model a claude-backend fleet member (and therefore the canary-first launch)
 * takes when the caller named none and none could be inherited — owner directive
 * 2026-09-15, WI-10001535: "opus 5 xhigh agents".
 *
 * DERIVED from the `max` tier rather than re-typed, so the `[1m]` marker cannot drift
 * out of sync with DEFAULT_MODEL_TIERS. That marker is load-bearing: `modelWindowForSpec`
 * reads it to launch the 1M auto-compact window, and a bare `opus` spec silently runs a
 * 200k window instead.
 */
const FLEET_DEFAULT_CLAUDE_MODEL_SPEC =
  DEFAULT_MODEL_TIERS.find((tier) => tier.name === 'max')?.spec ?? 'opus[1m]:xhigh';
import {
  claimFleetLaunchSlot,
  createFleetIfAbsent,
  fleetSlugFromName,
  getFleet,
  getFleetHeadcountTarget,
  getFleetScheme,
  mergeFleetLaunchWorkerAttestations,
  releaseFleetLaunchSlot,
  setFleetHeadcountTarget,
  setFleetLeader,
  setFleetLaunchTransaction,
  type FleetLaunchTransaction,
  type FleetHeadcountConfig,
  type FleetHeadcountTarget,
  type FleetType,
} from '../../agent-fleets-store';
import {
  describeLaunchRoles,
  expandPairedMembers,
  implementersToConfine,
  pairIndexOfSeat,
  pairsToCouple,
  resolveLaunchOptions,
  wholePairSeats,
} from './pair-launch-options';
import { directedImplementerConfinement } from '../../capability-envelope/session-confinement';
import { declareSessionConfinement } from '../../capability-envelope/session-confinement-store';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, formatSpecRef, type ClaimSpec } from '../../scheduler/claim-spec';
import type { SpecPoolEffect } from '../../scheduler/spec-pool-preview';
import {
  fleetSpecBeeKey,
  resolveClaimSpecWorkspace,
  setClaimSpec,
  getClaimSpec,
} from '../../scheduler/claim-spec-store';
import { getPresence, heartbeatPresence, setPresenceFleet, PRESENCE_STALE_MS } from '../coordination/presence';
import { declareCoupling } from '../../coord/couplings';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { resolveHarnessPlansDir, readPlanBySlug, resolvePlanHarnessSlug } from '../plans/source';
import { checkPlanStartable, startVerdictForRow } from '../plans/plan-start-gate';
import {
  buildExactPlanClaimSpec,
  claimableStatesForKinds as exactPlanClaimableStatesForKinds,
} from '../plans/plan-admission-preflight';
import { fleetRoleFor, json, recolorCallerTerminal, resolveFleetCaller } from './_shared';
import { extractWorkItemIds, TERMINAL_WORK_ITEM_STATES } from '../work_items/mirror-guard';
import { itemMatchesRawClaimSpec } from '../../scheduler/fleet-scope-admission';
import { reseedLeaderCompactionLimit } from './take-leadership-core';
import { ensureFleetLeaderControl, type LeaderControlOutcome } from './leader-control';
import {
  normalizePersistedFleetLaunchConfig,
  resolveLoadedSavedFleetLaunchSpec,
  resolveSavedFleetLaunchSpec,
} from './saved-launch-spec';
import { resolveSeatLaunch, seatAvailabilityForFleet } from '../../fleet/seat-accounting';
import {
  resolveWorkspaceHiveScope,
  resolveSharedHiveDisambiguation,
  type WorkspaceHiveScope,
} from '../coordination/federation-scope';
import { listOffers } from '../../p2p/offer-store';
import { publishSpawnRequest } from '../../p2p/spawn-request-publish';
import { listFederatedFleetMembers } from '../../sync/hyperbee/session-presence-store';
import { resolveUsageActor } from '../../harness/usage-actor';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../../identity/attest';
import type { ColorScheme } from '../../console-color-schemes';
import { liveFleetMemberIds, occupiesLaunchMemberSeat } from '../../fleet/fleet-roster';
import { listLiveTasks } from '../../task-manager/store';
import type { TaskRow } from '../../task-manager/types';
import { agentSpawnScopeMemoryMaxG } from '../../systemd-scope';
import { resolveCodexModelSelection } from '../../model-context-budget.mjs';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import { localModelIdsAsync } from '../../inference-gateway/local-model-ids-cache';
import { buildCapacityReport, buildFleetSizingAdvisory } from '../../fleet/capacity-dispatch';
import { listFacts } from '../../agent-facts/store';
import { getModes, getModeSubject } from '../../modes/store';
import { modeInstructionsFactKey } from '../mode/set';
import {
  composeModelSpec,
  deriveFreshLaunchEvidenceSummary,
  foldMemberSpec,
  formatFreshLaunchEvidenceSummary,
  injectLaunchedByArg,
  memberLaunchCommand as sharedMemberLaunchCommand,
  memberSpecSchema,
  MEMBER_BASELINE_RULES as sharedMemberBaselineRules,
  renderMemberBaseline as sharedRenderMemberBaseline,
  composeMemberLaunchContext as sharedComposeMemberLaunchContext,
  renderGoalFleetAllocation,
  verifyFreshLaunchStarted,
  modelEffortFromSpec,
  resolveLaunchMode,
  type FleetMemberDefaults,
  type FreshLaunchExpectedAttestation,
  type LaunchMode,
  type MemberSpec,
} from '../../agent-launch-core';
export type { MemberLaunchOpts } from '../../agent-launch-core';
import {
  resolveGoalLaunch,
  readGoalLaunchSettingsForLauncher,
  resolveGoalPotPlacementAuthority,
  type LaunchProfile,
} from '../../goal-launch-settings';
import { evaluateAgentObligationRecoveryBoundary } from '../../agent-obligations';
import { GOAL_LAUNCH_ROLES, isGoalLaunchRole, type GoalLaunchRole } from '../../goal-launch-settings-shared';
import {
  applyGoalLaunchOverlay,
  goalFleetLeaderProfile,
  goalFleetLaunchOverlay,
  goalFleetWideFoldSlot,
  goalPairedTypeNote,
  resolveGoalFleetLeadership,
} from './goal-fleet-launch-options';
// type-only: the runtime call is a LAZY dynamic import in the handler (the promotion failsafe),
// keeping the heavy promotion graph out of this module's load path — the type is erased.
import type { PromotePlanResult } from '../../plan-workitem-promotion-run';

/**
 * Apply one already-resolved GOAL launch profile to command defaults.
 *
 * Kept pure because a profile that reads as applied while its `model` never
 * reaches argv is otherwise invisible until a real fleet boots on the wrong
 * model. Every supported profile key is copied here, including false
 * `headless` and the zero-free numeric compaction limit.
 */
export function applyGoalLaunchProfileToDefaults(
  base: FleetMemberDefaults,
  profile: LaunchProfile | null | undefined,
): FleetMemberDefaults {
  if (!profile) return { ...base };
  return {
    ...base,
    agent: (profile.agent as FleetMemberDefaults['agent'] | undefined) ?? base.agent,
    model: profile.model ?? base.model,
    effort: profile.effort ?? base.effort,
    account: profile.account ?? base.account,
    carry: profile.carry ?? base.carry,
    contextSize: profile.contextSize ?? base.contextSize,
    compactionLimit: profile.compactionLimit ?? base.compactionLimit,
    headless: profile.headless ?? base.headless,
  };
}

/**
 * Resolve the launch overlay from the caller's durable mode row and standing
 * instruction fact. Keep this pure so the propagation contract is testable
 * without opening a fleet or reaching PG; the handler owns the one mode/fact
 * read and hands the result to every composer in the launch wave.
 */
export function resolveFleetLaunchMode(opts: {
  modeRows: ReadonlyArray<{
    mode?: unknown;
    subject?: unknown;
    ownerDirected?: unknown;
  }>;
  facts: ReadonlyArray<{ key?: unknown; body?: unknown }>;
}): LaunchMode | null {
  const instructions = opts.facts.find((fact) => fact.key === modeInstructionsFactKey('drain'));
  return resolveLaunchMode({
    modeRows: opts.modeRows,
    instructionsFact: instructions?.body,
  });
}

/** Read the caller's launch mode once per fleet launch; failures stay fail-soft
 * so an observability/read outage cannot strand an otherwise valid fleet launch. */
async function readCallerLaunchMode(workspaceId: string, ownerId: string): Promise<LaunchMode | null> {
  try {
    const modeRows = await getModes(workspaceId, ownerId);
    if (!modeRows.some((row) => row.mode === 'drain')) return null;
    const facts = await listFacts({ scope: 'owner', scopeRef: ownerId }, { workspaceId, limit: 50 });
    return resolveFleetLaunchMode({ modeRows, facts });
  } catch {
    return null;
  }
}

/**
 * Keep the promotion failsafe's prose aligned with its machine-readable result.
 * A zero-promoted result is normally an idempotent no-op, but the spec-triad
 * refusal is different: the open items are not covered and the lane is empty.
 */
function promotionFailsafeWarning(
  planSlug: string,
  result: (PromotePlanResult & { ran: boolean }) | null,
): string | null {
  if (!result?.ran) return null;
  if (result.promoted > 0) {
    return `⚠ plans:start had not promoted this plan — the launch FAILSAFE auto-promoted ${result.promoted} plan item${result.promoted === 1 ? '' : 's'} to claimable work-items. Run plans:start yourself BEFORE launching next time.`;
  }
  if (result.flagOff) {
    return `⚠ plan→work-item promotion is dark (flag off) so the launch failsafe promoted nothing. If plans:start was not run, members' scheduler:get_next will find nothing and idle — ensure claimable work-items exist for plan \`${planSlug}\`.`;
  }
  if (result.specTriadBlocked && result.skipped > 0) {
    const missing = result.specTriadMissing?.join(', ') || 'required sections';
    const remedy = result.specTriadWorkItem
      ? ` Claim ${result.specTriadWorkItem} to fill them, then rerun plans:start.`
      : ' Write the missing sections, then rerun plans:start.';
    return `⚠ plan→work-item promotion produced 0 of ${result.skipped} open plan item${result.skipped === 1 ? '' : 's'} — blocked by the spec triad (missing: ${missing}). Nothing is claimable yet.${remedy}`;
  }
  if (result.skipped === 0) {
    return `⚠ plan \`${planSlug}\` has no open items to promote — members may find nothing to claim. Confirm the plan has items (plans:items) and was started.`;
  }
  return null;
}

export interface PersistedFleetLaunchProfileConflict {
  field: string;
  saved: unknown;
  requested: unknown;
}

export interface FleetRouteSwitchConflict {
  currentFleet: string;
  currentRole: string | null;
  targetFleet: string;
}

/**
 * A caller-led launch relabels the caller into the target fleet.  Doing that
 * while the caller is already enrolled in another fleet is a route switch,
 * not an ordinary top-up: the old fleet loses its live supervisor/membership
 * even though every member process stays alive.  Require an explicit audit bit
 * for that transition.  `leader:'spawn'` is safe because the caller remains in
 * its current fleet and the fresh agent leads the new one.
 */
export function fleetRouteSwitchConflict(opts: {
  currentFleet?: string | null;
  currentRole?: string | null;
  targetFleet: string;
  leader?: 'caller' | 'spawn';
  confirmRouteSwitch?: boolean;
}): FleetRouteSwitchConflict | null {
  const currentFleet = opts.currentFleet?.trim();
  if (
    !currentFleet ||
    currentFleet === opts.targetFleet ||
    opts.leader === 'spawn' ||
    opts.confirmRouteSwitch === true
  ) {
    return null;
  }
  return {
    currentFleet,
    currentRole: opts.currentRole?.trim() || null,
    targetFleet: opts.targetFleet,
  };
}

/**
 * A saved fleet profile may supply terminal placement, but a first/unprofiled
 * local launch has no such authority.  Do not silently turn an omitted
 * `headless` into visible desktop windows: require one fleet-wide choice, or an
 * explicit choice for every member in a deliberately mixed launch.
 */
export function requiresExplicitUnprofiledVisibility(opts: {
  savedSpecFound: boolean;
  placement?: 'local' | 'remote';
  headless?: boolean;
  count?: number;
  members?: readonly { headless?: boolean }[];
}): boolean {
  if (opts.savedSpecFound || opts.placement === 'remote' || opts.headless !== undefined) return false;
  const count = Math.max(1, Math.floor(opts.count ?? 1));
  const members = opts.members ?? [];
  return members.length < count || members.slice(0, count).some((member) => member.headless === undefined);
}

/** Existing fleets recover from their persisted recipe; only host placement
 * (`local` / `remote`) and target size may change here. Terminal visibility is
 * boot-baked launch behavior, so changing `headless` requires an explicit
 * fleet:respawn-member transition rather than an ad-hoc top-up override. */
export function persistedFleetLaunchProfileConflicts(
  requested: {
    plan?: string;
    harness?: string;
    agent?: string;
    model?: string;
    account?: string;
    headless?: boolean;
    carry?: 'warm' | 'cold';
    role?: string;
    brief?: string;
    launchContext?: string;
    contextSize?: 'trimmed' | 'steward';
    compactionLimit?: number;
    extraArgs?: string[];
    members?: readonly unknown[];
    perMemberLaunchContext?: readonly string[];
  },
  saved: FleetHeadcountConfig,
): PersistedFleetLaunchProfileConflict[] {
  const result = resolveLoadedSavedFleetLaunchSpec({
    target: {
      workspaceId: 'compat',
      fleetSlug: 'compat',
      target: 1,
      enabled: true,
      config: saved,
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    },
    workspaceId: 'compat',
    fleetSlug: 'compat',
    requested,
    reusePath: 'fleet:launch-on-plan',
  });
  return result.ok
    ? []
    : result.conflicts.map(({ field, saved: savedValue, requested: requestedValue }) => ({
        field,
        saved: savedValue,
        requested: requestedValue,
      }));
}

/**
 * `count` is the desired LIVE fleet size. The invocation requests the complete
 * live-member deficit; durable governor admission may still clamp the number
 * that actually opens. Keeping target and live population separate preserves
 * idempotent top-ups without imposing a second, local resource ceiling.
 */
export function computeFleetTopUpWave(
  targetCount: number,
  liveMembers: number,
): { remainingDeficit: number; requestedOpenCount: number; waveCapped: boolean } {
  const target = Number.isFinite(targetCount) ? Math.max(0, Math.floor(targetCount)) : 0;
  const live = Number.isFinite(liveMembers) ? Math.max(0, Math.floor(liveMembers)) : 0;
  const remainingDeficit = Math.max(0, target - live);
  return { remainingDeficit, requestedOpenCount: remainingDeficit, waveCapped: false };
}

/**
 * Read the runnable member population used by BOTH exact-plan admission and the
 * later launch deficit guard. Keeping the population definition shared is
 * load-bearing: admission judges the number of terminals this invocation can
 * actually open, so it must subtract the same local/federated members that the
 * launch path subtracts a few steps later.
 */
async function liveLaunchMemberIdsForSizing(args: {
  fleetSlug: string;
  workspaceId: string;
  launcherOwnerId: string;
  remotePlacement: boolean;
}): Promise<string[]> {
  const localLive = (await liveFleetMemberIds(args.fleetSlug, args.workspaceId, 'launch')).filter(
    (id) => id !== args.launcherOwnerId,
  );
  if (!args.remotePlacement) return localLive;

  // Remote members never register in local coord_presence. Their federated
  // session-presence rows occupy the same launch seats, so union them here just
  // as the launch deficit guard does. The federated read remains best-effort;
  // the local roster plus the launch window still guards a transient miss.
  try {
    const federated = await listFederatedFleetMembers({
      workspaceId: args.workspaceId,
      fleetSlug: args.fleetSlug,
      staleMs: PRESENCE_STALE_MS,
    });
    const federatedSeats = federated
      .filter((member) => occupiesLaunchMemberSeat(member.fleetRole))
      .map((member) => member.ownerId);
    return [...new Set([...localLive, ...federatedSeats])].filter((id) => id !== args.launcherOwnerId);
  } catch {
    return localLive;
  }
}

/**
 * Open every planned wave before waiting on any wave's boot verification.
 *
 * A launch wave's verifier intentionally has a bounded wait, but that wait is still
 * long enough to consume the whole launch call on a slow first member. Keeping the
 * phase boundary explicit prevents a slow verifier from serialising later spawns.
 * Positive spawn failures still stop new waves; already-opened waves are verified in
 * the second phase so the transaction reports every observation it can.
 */
export async function runLaunchWavesBeforeVerification<T>(
  waveIndices: readonly (readonly number[])[],
  requestedMemberIds: readonly string[],
  spawnWave: (
    waveIndex: number,
    indices: readonly number[],
    ownerIds: readonly string[],
  ) => Promise<{ payload: T; stopAfterSpawn: boolean }>,
  verifyWave: (record: {
    waveIndex: number;
    indices: readonly number[];
    ownerIds: readonly string[];
    payload: T;
  }) => Promise<void>,
): Promise<void> {
  const records: Array<{
    waveIndex: number;
    indices: readonly number[];
    ownerIds: readonly string[];
    payload: T;
  }> = [];

  for (let waveIndex = 0; waveIndex < waveIndices.length; waveIndex += 1) {
    const indices = waveIndices[waveIndex].slice();
    const ownerIds = indices.map((i) => requestedMemberIds[i]);
    const spawned = await spawnWave(waveIndex, indices, ownerIds);
    records.push({ waveIndex, indices, ownerIds, payload: spawned.payload });
    if (spawned.stopAfterSpawn) break;
  }

  for (const record of records) {
    await verifyWave(record);
  }
}

/**
 * Map a zero-based launch-wave position to the fleet member-spec index.
 * Top-up waves append after the members already live; reusing wave position 0
 * on a deficit relaunch silently gives the new member member 1's brief.
 */
export function memberSpecIndexForLaunch(liveMembers: number, waveIndex: number): number {
  const live = Number.isFinite(liveMembers) ? Math.max(0, Math.floor(liveMembers)) : 0;
  const wave = Number.isFinite(waveIndex) ? Math.max(0, Math.floor(waveIndex)) : 0;
  return live + wave;
}

/**
 * EI-21010422711013687: every visible fleet launch carries a command that must
 * execute. A server-side gnome-terminal client can successfully open a window
 * while its D-Bus factory silently drops that command, leaving only a wrapper
 * and no psu child. Keep this exported so the fleet contract has a cheap pure
 * regression assertion as well as the two runtime call sites below.
 */
export const VISIBLE_FLEET_AGENT_REQUIRES_PROCESS_PER_WINDOW = true;

/** The operator's own base URL for the spawned terminal's API-callback env. Mirrors
 *  capability:terminal's resolver (strip a trailing /api/mcp back to the origin). */
// WI-6154: this-host identity (PAPERCUSP_HONO_PORT) must win over an inherited
// PAPERCUSP_OPERATOR_URL — see resolveSpawnHostOperatorBaseUrl's doc for why.
const resolveOperatorBaseUrl = resolveSpawnHostOperatorBaseUrl;

/** Optional psu launch flags threaded onto EVERY member's `psu` invocation (EI-5765 /
 *  owner request). Each maps to the matching `psu --flag=value`; `brain` is the boolean
 *  `--brain`; `extraArgs` is a verbatim escape hatch for any psu flag without a first-class
 *  field. The fleet/agent/harness/plan/no-picker tokens are owned by the tool and not
 *  overridable here. */
/** A model routed through the LOCAL inference gateway / ollama (e.g. `ollama-cc/…ornith`)
 *  runs ONLY on the `omp` backend — the `claude`/`codex` CLIs cannot load an ollama model id.
 *  `agent` and `model` are therefore COUPLED. Used to (a) infer agent:'omp' when only such a
 *  model is given, and (b) reject an explicit claude/codex + local-model pairing that would
 *  otherwise launch the WRONG backend nominally `--model`-set to an unrunnable id — and since
 *  the fleet-status echoes the model string (not the agent), it LOOKS like ornith while the
 *  members are really claude. That exact trap spawned 4 claude members mislabelled ornith on
 *  2026-07-03 (a leader relaunched with `model: ollama-cc/…ornith` but no `agent: omp`). */
export function isOmpLocalModel(model: string | undefined): boolean {
  if (!model) return false;
  return /^ollama(-cc)?\//i.test(model.trim()) || /\bornith\b/i.test(model);
}

/**
 * Return the native cloud backend for model families whose ownership is
 * unambiguous. The cloud model-id set remains open: unknown ids return null and
 * keep the existing caller-inheritance/fallback behavior.
 *
 * OMP remains allowed to run either cloud family when selected explicitly
 * because it is a multi-provider backend.
 */
export function cloudModelBackendHint(model: string | undefined): 'claude' | 'codex' | null {
  if (!model || isOmpLocalModel(model)) return null;
  const withoutEffort = model.trim().replace(/:(low|medium|high|xhigh|max)$/i, '');
  const base = withoutEffort.replace(/\[[^\]]+\]$/, '');
  if (
    /^(luna|terra|sol)$/i.test(base) ||
    /^gpt(?:[-_.]|\d)/i.test(base) ||
    /^o\d(?:[-_.]|$)/i.test(base) ||
    /(?:^|[-_.\/])codex(?:[-_.\/]|$)/i.test(base)
  ) {
    return 'codex';
  }
  if (
    /^(opus|sonnet|haiku|fable)$/i.test(base) ||
    /^claude(?:[-_.\/]|$)/i.test(base) ||
    /^anthropic[.\/]claude(?:[-_.\/]|$)/i.test(base)
  ) {
    return 'claude';
  }
  return null;
}

/** The three fleet-member backends (psu `--agent`). Guards an inherited caller backend. */
const FLEET_BACKENDS = new Set(['claude', 'omp', 'codex']);

export type FleetAgentResolution = {
  agent: 'claude' | 'omp' | 'codex';
  model: string | undefined;
  modelSource?: 'explicit' | 'inherited' | 'configured-default';
} | { error: string };

/**
 * Select the gateway stats projection for the backend that the member launch will use.
 * Native CLIs have one unambiguous provider; OMP can run either cloud family, so use its
 * model hint when one is known and retain the observability module's Claude projection as
 * the conservative fallback for local or still-unknown OMP model ids.
 */
export function gatewayCapacityProviderForFleetAgent(
  agent: 'claude' | 'omp' | 'codex',
  model: string | undefined,
): 'claude' | 'codex' {
  if (agent === 'codex') return 'codex';
  if (agent === 'claude') return 'claude';
  return cloudModelBackendHint(model) ?? 'claude';
}

/**
 * PURE (fleet-launch-agent-inheritance-2026-07-03): resolve a fleet member's backend + model from
 * the launch args and the CURRENT calling agent's stamped backend/model. Precedence:
 *   agent = explicit `args.agent` → backend inferred from a known model family → the CALLER's own
 *           backend (`ctx.callerAgent`, so an omp/ornith leader that omits `agent` spawns omp
 *           members, not the historical claude default) → 'claude' (last-resort fallback).
 *   model = explicit `args.model` → the CALLER's model, but ONLY when the backend was ALSO
 *           inherited (never cross a claude model onto an omp member) → the backend default.
 * Rejects explicit native-backend/model-family mismatches (the "thought X, got Y" trap).
 * Unit-tested without PG.
 */
export function resolveFleetAgent(opts: {
  argAgent?: 'claude' | 'omp' | 'codex';
  argModel?: string;
  callerAgent?: string | null;
  callerModel?: string | null;
}): FleetAgentResolution {
  const argModel = opts.argModel?.trim() || undefined;
  const localModel = isOmpLocalModel(argModel);
  if (opts.argAgent && opts.argAgent !== 'omp' && localModel) {
    return {
      error:
        `model \`${argModel}\` is a local/gateway model that only the \`omp\` backend can run — ` +
        `pass \`agent: "omp"\` (not \`agent: "${opts.argAgent}"\`). The claude/codex CLIs cannot load an ollama model id.`,
    };
  }
  const cloudBackend = cloudModelBackendHint(argModel);
  if (opts.argAgent && opts.argAgent !== 'omp' && cloudBackend && opts.argAgent !== cloudBackend) {
    return {
      error:
        `model \`${argModel}\` belongs to the \`${cloudBackend}\` backend, but this launch requested ` +
        `\`agent: "${opts.argAgent}"\`. Pass \`agent: "${cloudBackend}"\`, or omit \`agent\` and let ` +
        `fleet:launch-on-plan infer it from the model family.`,
    };
  }
  const inherited =
    opts.callerAgent && FLEET_BACKENDS.has(opts.callerAgent) ? (opts.callerAgent as 'claude' | 'omp' | 'codex') : null;
  const agent = opts.argAgent ?? (localModel ? 'omp' : (cloudBackend ?? inherited ?? 'claude'));
  // Inherit the caller's model ONLY when we also inherited its backend (no explicit agent) — else
  // an omp member would launch on omp's default, not the ornith the leader is actually running.
  const inheritedBackend = !opts.argAgent && agent === opts.callerAgent;
  let model = argModel ?? (inheritedBackend && opts.callerModel ? opts.callerModel : undefined);
  let modelSource: 'explicit' | 'inherited' | 'configured-default' | undefined;
  // Owner directive 2026-09-15 (WI-10001535): a fleet member — and therefore the
  // canary-first launch, which has no model knob of its own — defaults to opus 5 at
  // xhigh rather than falling through to whatever the CLI picks. Scoped to the claude
  // backend on purpose: `codex` resolves its own model just below via
  // resolveCodexModelSelection, and `omp` runs local/gateway ids an Anthropic spec
  // cannot name. Explicit and inherited models still win, so this only fills the hole
  // where the old code left `model` undefined.
  if (agent === 'claude' && !model) {
    model = FLEET_DEFAULT_CLAUDE_MODEL_SPEC;
    modelSource = 'configured-default';
  }
  if (agent === 'codex') {
    try {
      modelSource = argModel ? 'explicit' : model ? 'inherited' : undefined;
      const selection = resolveCodexModelSelection(model, {
        // fleet:launch-on-plan is a scripted --no-picker path. Naming Codex is
        // backend selection, not model authority; a model must be explicit or
        // inherited from the recorded caller before any member is materialized.
        source: modelSource ?? 'explicit',
      });
      model = selection.model;
      modelSource = selection.source;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { agent, model, ...(modelSource ? { modelSource } : {}) };
}

/** Window inside which a repeat launch of the same fleet is suppressed (the P-005 idempotency
 *  guard). The state lives in PG (agent_fleets.last_launch_at, migration 484) — NOT an in-process
 *  map: :3070 serves MCP from a multi-process worker pool, and the 2026-07-03 ornith incident
 *  proved a per-worker map is porous (a leader re-fired the tool 7× in 40s treating "launch" as a
 *  status check; 6 calls each landed on a worker with an empty map and opened 2 terminals apiece —
 *  12 unwanted desktop windows). claimFleetLaunchSlot is one atomic SQL check-and-set shared by
 *  every worker, so exactly ONE call per fleet can win the window. */
const RELAUNCH_SUPPRESS_MS = 300_000;
export const FLEET_LAUNCH_CANARY_FRESHNESS_MS = RELAUNCH_SUPPRESS_MS;
/** EI-20437060078324174: window for the ONE post-wave re-probe of members whose
 *  per-wave verification window expired unconfirmed. The measured false-negative
 *  registered 5.5s past a 25s window; 30s more, measured from launch start by the
 *  probe's `since`, covers that shape without materially slowing a real dud. */
const LATE_VERIFY_RECHECK_TIMEOUT_MS = 30_000;

/**
 * Keep the response path below the MCP transport budget. The launch transaction
 * is already durable before this boundary, so a slow verifier can continue in
 * the detached completion below while the caller gets a safe replay handle.
 */
export const LAUNCH_RESPONSE_DEADLINE_MS = 20_000;

export type LaunchResponseRace<T> = { timedOut: false; value: T } | { timedOut: true };

/** Race a launch completion against the caller-facing response budget.
 *
 * The operation is intentionally not cancelled when the deadline wins: spawn
 * and verification have already mutated the durable launch transaction and the
 * continuation must finish that transaction instead of leaving it ambiguous.
 */
export async function raceLaunchResponseWithinBudget<T>(
  operation: Promise<T>,
  timeoutMs = LAUNCH_RESPONSE_DEADLINE_MS,
): Promise<LaunchResponseRace<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : LAUNCH_RESPONSE_DEADLINE_MS;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), delay);
  });
  try {
    return await Promise.race([operation.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** EI-20361787885323735: how old a slot-holding launch must be before ZERO live members is
 *  read as "the wave it protects is DEAD" rather than "still booting". Presence registration
 *  lands within seconds of psu boot (measured +24s on a 5-member codex wave), so 2 minutes is
 *  comfortably past the boot gap while still rescuing the owner-killed-wave case (kills land
 *  at +2..+8 min and the relaunch was refused for the rest of the 300s window). */
export const DEAD_WAVE_OVERRIDE_MIN_AGE_MS = 120_000;

/**
 * PURE (EI-20361787885323735): should a LOST launch slot be overridden because the wave it
 * protects is provably dead? True only when (a) the prior launch is past the boot gap, so its
 * members would have registered presence by now, AND (b) ZERO non-leader members are live per
 * the pid-probed roster read. Conservative on both axes: a young wave (members may not have
 * registered) and any live member both keep the suppression.
 */
export function deadWaveSlotOverride(opts: {
  priorAtMs: number;
  nowMs: number;
  liveMembers: number;
  minAgeMs?: number;
}): boolean {
  const minAge = opts.minAgeMs ?? DEAD_WAVE_OVERRIDE_MIN_AGE_MS;
  return opts.liveMembers === 0 && opts.nowMs - opts.priorAtMs >= minAge;
}

type FleetLaunchRequestedMember = NonNullable<FleetLaunchTransaction['requestedMembers']>[number];
export type FleetLaunchMemberProfile = Pick<
  FleetLaunchRequestedMember,
  'agent' | 'model' | 'account' | 'carry' | 'headless'
>;

/**
 * A fresh successful canary is a bounded receipt that this launch route/profile
 * recently authenticated. It is deliberately narrow: only the prior
 * transaction's index-0 requested member, explicitly verified in a terminal
 * state, and an exact profile match can relax a healthyAccounts===0 zero-gate.
 */
export function hasFreshSameProfileCanary(opts: {
  transaction: Pick<
    FleetLaunchTransaction,
    'state' | 'updatedAt' | 'requestedMembers' | 'verifiedMemberIds'
  > | null | undefined;
  currentProfile: FleetLaunchMemberProfile;
  nowMs?: number;
  freshnessWindowMs?: number;
}): boolean {
  const transaction = opts.transaction;
  if (!transaction || (transaction.state !== 'partial' && transaction.state !== 'verified')) return false;
  const canary = transaction.requestedMembers?.find((member) => member.index === 0);
  if (!canary || !transaction.verifiedMemberIds.includes(canary.ownerId)) return false;
  const nowMs = opts.nowMs ?? Date.now();
  const freshnessWindowMs = opts.freshnessWindowMs ?? FLEET_LAUNCH_CANARY_FRESHNESS_MS;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(transaction.updatedAt) ||
    !Number.isFinite(freshnessWindowMs) ||
    freshnessWindowMs < 0 ||
    transaction.updatedAt > nowMs ||
    nowMs - transaction.updatedAt > freshnessWindowMs
  ) {
    return false;
  }
  return (
    canary.agent === opts.currentProfile.agent &&
    canary.model === opts.currentProfile.model &&
    canary.account === opts.currentProfile.account &&
    canary.carry === opts.currentProfile.carry &&
    canary.headless === opts.currentProfile.headless
  );
}

export interface FleetLaunchCapacityClamp {
  requestedOpenCount: number;
  openCount: number;
  clamped: boolean;
  reachable: boolean;
  healthyAccounts: number | null;
  dispatchBudget: number | null;
  recommendedHeadroom: number | null;
  /** ADVISORY (not a clamp): the weekly-token-BUDGET window is tight for this many members
   *  (recommendedHeadroom < openCount). They still all launch; they may burn the remaining
   *  weekly budget faster and hit the wall sooner. See clampFleetTopUpToCapacity. */
  utilizationTight: boolean;
  /** The clamp the capacity signal RECOMMENDED, independent of whether it was applied. Non-null whenever a
   *  concurrency signal existed. With `override`, `openCount` stays at `requestedOpenCount` while this still
   *  reports what the pool advised — an override is never invisible. */
  recommendedOpenCount: number | null;
  /** True when a binding recommendation was consciously OVERRIDDEN by the caller (`opts.override`). */
  overridden: boolean;
  reason: string;
}

/** The fraction of host RAM deliberately left for the operator, sidecars, and the OS. */
export const HEADLESS_HOST_MEMORY_RESERVED_FRACTION = 0.25;

/**
 * Rows returned by listLiveTasks that represent an agent scope with a real memory
 * ceiling. Keep this predicate pure: the launch handler owns the live ledger read,
 * while the admission math stays deterministic and easy to regression-test.
 */
export function isProtectedAgentSessionTask(task: Pick<TaskRow, 'class' | 'memoryMaxBytes'>): boolean {
  return (
    task.class === 'agent-session' &&
    typeof task.memoryMaxBytes === 'number' &&
    Number.isFinite(task.memoryMaxBytes) &&
    task.memoryMaxBytes > 0
  );
}

export interface ProtectedAgentMemoryUsage {
  activeProtectedAgentScopes: number;
  observedProtectedMemoryBytes: number;
  unmeasuredProtectedAgentScopes: number;
}

/**
 * Summarize the memory footprint of protected agent scopes without turning a
 * missing cgroup sample into a false zero. A peak is an upper bound for the
 * scope's observed lifetime; a scope without one is accounted for separately so
 * admission can reserve its full enforced cap.
 */
export function summarizeProtectedAgentMemory(
  tasks: ReadonlyArray<Pick<TaskRow, 'class' | 'memoryMaxBytes' | 'peakMemoryBytes'>>,
): ProtectedAgentMemoryUsage {
  let activeProtectedAgentScopes = 0;
  let observedProtectedMemoryBytes = 0;
  let unmeasuredProtectedAgentScopes = 0;

  for (const task of tasks) {
    if (!isProtectedAgentSessionTask(task)) continue;
    activeProtectedAgentScopes += 1;
    const peak = task.peakMemoryBytes;
    if (typeof peak === 'number' && Number.isFinite(peak) && peak >= 0) {
      observedProtectedMemoryBytes += peak;
    } else {
      unmeasuredProtectedAgentScopes += 1;
    }
  }

  return {
    activeProtectedAgentScopes,
    observedProtectedMemoryBytes,
    unmeasuredProtectedAgentScopes,
  };
}

export interface HeadlessHostMemoryClamp {
  requestedOpenCount: number;
  openCount: number;
  clamped: boolean;
  hostTotalMemoryBytes: number;
  reservedFraction: number;
  reservedMemoryBytes: number;
  usableMemoryBytes: number;
  perScopeMemoryBytes: number;
  activeProtectedAgentScopes: number;
  maxProtectedAgentScopes: number;
  availableProtectedAgentScopes: number;
  observedProtectedMemoryBytes: number;
  unmeasuredProtectedAgentScopes: number;
  reservedProtectedMemoryBytes: number;
  availableProtectedMemoryBytes: number;
  reason: string;
}

/**
 * Pure aggregate admission for headless agent scopes.
 *
 * Every new headless member receives the shared agent-scope MemoryMax. Existing
 * scopes use their observed peak memory as the reservation, while a scope without
 * a peak sample reserves the full cap. This keeps the admission fail-closed for
 * unknown tasks without treating every long-lived scope as if it were currently
 * consuming its worst-case budget. The configured uniform-cap ceiling remains in
 * `maxProtectedAgentScopes` as a diagnostic reference.
 */
export function clampHeadlessLaunchToHostMemory(
  requestedOpenCount: number,
  opts: {
    hostTotalMemoryBytes: number;
    activeProtectedAgentScopes: number;
    perScopeMemoryBytes: number;
    observedProtectedMemoryBytes?: number;
    unmeasuredProtectedAgentScopes?: number;
    reservedFraction?: number;
  },
): HeadlessHostMemoryClamp {
  const requested = Number.isFinite(requestedOpenCount) ? Math.max(0, Math.floor(requestedOpenCount)) : 0;
  const total = Number.isFinite(opts.hostTotalMemoryBytes) ? Math.max(0, opts.hostTotalMemoryBytes) : 0;
  const perScope = Number.isFinite(opts.perScopeMemoryBytes) ? Math.max(1, opts.perScopeMemoryBytes) : 1;
  const active = Number.isFinite(opts.activeProtectedAgentScopes)
    ? Math.max(0, Math.floor(opts.activeProtectedAgentScopes))
    : 0;
  const reservedFraction =
    typeof opts.reservedFraction === 'number' && Number.isFinite(opts.reservedFraction)
      ? Math.min(1, Math.max(0, opts.reservedFraction))
      : HEADLESS_HOST_MEMORY_RESERVED_FRACTION;
  const reservedMemoryBytes = total * reservedFraction;
  const usableMemoryBytes = Math.max(0, total - reservedMemoryBytes);
  const maxProtectedAgentScopes = Math.floor(usableMemoryBytes / perScope);
  const observedProtectedMemoryBytes =
    typeof opts.observedProtectedMemoryBytes === 'number' && Number.isFinite(opts.observedProtectedMemoryBytes)
      ? Math.max(0, opts.observedProtectedMemoryBytes)
      : 0;
  const unmeasuredProtectedAgentScopes =
    typeof opts.unmeasuredProtectedAgentScopes === 'number' && Number.isFinite(opts.unmeasuredProtectedAgentScopes)
      ? Math.max(0, Math.min(active, Math.floor(opts.unmeasuredProtectedAgentScopes)))
      : active;
  const reservedProtectedMemoryBytes = observedProtectedMemoryBytes + unmeasuredProtectedAgentScopes * perScope;
  const availableProtectedMemoryBytes = Math.max(0, usableMemoryBytes - reservedProtectedMemoryBytes);
  const availableProtectedAgentScopes = Math.floor(availableProtectedMemoryBytes / perScope);
  const openCount = Math.min(requested, availableProtectedAgentScopes);
  const clamped = openCount < requested;
  const hostGiB = (total / 1024 ** 3).toFixed(1);
  const usableGiB = (usableMemoryBytes / 1024 ** 3).toFixed(1);
  const capGiB = (perScope / 1024 ** 3).toFixed(1);
  const reservedGiB = (reservedProtectedMemoryBytes / 1024 ** 3).toFixed(1);
  const observedGiB = (observedProtectedMemoryBytes / 1024 ** 3).toFixed(1);
  const metricNote =
    unmeasuredProtectedAgentScopes > 0
      ? `, ${unmeasuredProtectedAgentScopes} without peak metrics reserved at cap`
      : '';
  // WI-41206: this figure is ADVISORY. The caller does NOT withhold members on it, so the
  // wording must never imply a launch was reduced or refused — that misdirected an entire
  // debugging session when `openCount 12→0` was read as a real limit.
  const detail = `${active} active protected agent-session scope(s), ${reservedGiB}GiB reserved (${observedGiB}GiB observed peak${metricNote}), host total ${hostGiB}GiB, ${usableGiB}GiB usable after ${(reservedFraction * 100).toFixed(0)}% reserved, ${capGiB}GiB budgeted per new scope, ${availableProtectedAgentScopes} scope slot(s) within that budget. Swap is NOT counted here, and this does not gate the launch.`;
  const reason = clamped
    ? `host-memory-advisory: headless top-up of ${requested} exceeds the ${availableProtectedAgentScopes}-slot RAM-only budget; launching all ${requested} anyway (workers page rather than being refused) — ${detail}`
    : `host-memory-ok headless top-up ${requested} — ${detail}`;
  return {
    requestedOpenCount: requested,
    openCount,
    clamped,
    hostTotalMemoryBytes: total,
    reservedFraction,
    reservedMemoryBytes,
    usableMemoryBytes,
    perScopeMemoryBytes: perScope,
    activeProtectedAgentScopes: active,
    maxProtectedAgentScopes,
    availableProtectedAgentScopes,
    observedProtectedMemoryBytes,
    unmeasuredProtectedAgentScopes,
    reservedProtectedMemoryBytes,
    availableProtectedMemoryBytes,
    reason,
  };
}

function floorCap(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/** A single path component is capped at 255 bytes on the filesystems this tool
 *  supports. Above that, a value is not a plausible path component, so treat it
 *  as inline text rather than risk feeding it to `readFileSync`. */
const LAUNCH_CONTEXT_INLINE_TEXT_LENGTH_THRESHOLD = 255;

/**
 * `launchContext` documents itself as a file PATH, but its own schema text ("sent as
 * brief text, <=8000 chars") reads as if the arg CARRIES the text — a caller who
 * passes actual brief TEXT dies deep inside `readFileSync` with ENAMETOOLONG, and
 * every member silently boots on the bare baseline while the launch still reports
 * `ok:true` (EI-19276371920501216). Multi-line content, or content implausibly long
 * to be a filename, is almost certainly inline text rather than a path — disambiguate
 * cheaply instead of finding out via a failed `open(2)`.
 */
export function looksLikeInlineLaunchContextText(value: string): boolean {
  return value.includes('\n') || Buffer.byteLength(value, 'utf8') > LAUNCH_CONTEXT_INLINE_TEXT_LENGTH_THRESHOLD;
}

/**
 * EI-6805: a relaunch/top-up wave must not only warn about capacity, it must
 * clamp the number of NEW terminals it opens to the shared capacity oracle.
 * Missing/unreachable capacity fails open so an observability outage never
 * strands a fleet; a reachable zero-headroom report suppresses the top-up.
 */
export function clampFleetTopUpToCapacity(
  requestedOpenCount: number,
  report: Pick<
    ReturnType<typeof buildCapacityReport>,
    'reachable' | 'healthyAccounts' | 'dispatchBudget' | 'recommendedHeadroom'
  >,
  opts?: {
    /** Whether the members being opened will route through the inference GATEWAY ('auto' or a
     *  pinned pool account / seat). Default true (the conservative legacy behavior). Pass false
     *  for DIRECT-credential members (no --account on linux/windows, or explicit
     *  'default'/'system') — they never ask the gateway to authenticate, so pool health must
     *  not gate them (fleet-launch-zero-gate-routing-blind, 2026-07-09). */
    gatewayRouted?: boolean;
    /** OWNER DIRECTIVE 2026-07-09 ("when the gateway clamps it should just be a recommendation, agents
     *  should be able to override"): honor the capacity signal as ADVICE, not a cap. The recommendation is
     *  still computed and REPORTED (`recommendedOpenCount`, `overridden:true`, `reason`), but every
     *  requested member launches — including through a pool reading `healthyAccounts:0`.
     *
     *  This is a real escape hatch, not a footgun: `healthyAccounts` reads the gateway's IN-MEMORY
    *  exhaustedUntil map, which no store-side tool can clear (accounts:reset-rate is another process;
     *  gateway:reload only drops absent ids). A STALE exhaustion therefore suppressed gateway-routed
     *  launches to ZERO with a full dispatchBudget of free slots, and the only remedy was restarting the
     *  gateway. Default OFF — the clamp remains the safe default. */
    override?: boolean;
    /** A fresh, successful exact-profile canary receipt. This relaxes only the
     *  healthyAccounts===0 zero-gate; dispatchBudget remains binding. */
    freshSameProfileCanary?: boolean;
  },
): FleetLaunchCapacityClamp | null {
  const requested = Math.max(0, Math.floor(requestedOpenCount));
  if (!report.reachable) return null;
  const healthyAccounts = floorCap(report.healthyAccounts);
  const dispatchBudget = floorCap(report.dispatchBudget);
  const recommendedHeadroom = floorCap(report.recommendedHeadroom);
  // CONCURRENCY is the only HARD cap on how many desktop-fleet members open at once, and
  // `dispatchBudget` (bee-tier spare admission slots = cap − inFlight − queued, gateway
  // DEFAULT_CONCURRENCY 24) is that authority. It is INDEPENDENT of BOTH:
  //  - account COUNT — ONE account paces MANY concurrent sessions through the gateway.
  //    Putting account-count in this min() was the "1 account = 1 session" bug (a top-up of
  //    N collapsed to 1 on a single-account install with tens of free slots). It informs the
  //    sizing ADVISORY only (buildFleetSizingAdvisory), never a hard cap.
  //  - weekly-token-BUDGET utilization — `recommendedHeadroom` folds in `capacityFactor`'s
  //    budget leg, which throttles on `utilization` (the most-constraining budget WINDOW,
  //    e.g. an account at 0.94 of its 7-DAY token cap → factor ~0.4 → recommendedHeadroom
  //    floored to minHeadroom 2). That collapsed an owner's EXPLICIT 5-member fleet to 2 even
  //    with ~20 free admission slots (fleet-launch-utilization-not-concurrency, 2026-07-08).
  //    A near-weekly-cap account can still run many SIMULTANEOUS sessions right now — weekly
  //    budget tightness is not a concurrency limit, so it is DEMOTED to an advisory
  //    (utilizationTight): the members still all launch; they may just burn the remaining
  //    weekly budget faster. Same treatment `healthyAccounts` already got.
  // `healthyAccounts` gates the ZERO case ONLY for GATEWAY-routed members: no routable pool
  // account ⇒ no valid gateway credential ⇒ nothing could authenticate, so suppress the top-up.
  // fleet-launch-zero-gate-routing-blind (2026-07-09): a member launched WITHOUT gateway routing
  // authenticates with the DIRECT system credential and never touches the pool — an exhausted
  // pool must NOT suppress its launch (live incident: a 1-member default-routed canary was
  // clamped 1→0 by a fully-walled pool despite dispatchBudget=13 free slots).
  const gatewayRouted = opts?.gatewayRouted ?? true;
  const override = opts?.override ?? false;
  const freshSameProfileCanary = opts?.freshSameProfileCanary === true;
  const caps = [dispatchBudget].filter((n): n is number => n != null);
  if (healthyAccounts === 0 && gatewayRouted && !freshSameProfileCanary) {
    caps.push(0); // no routable gateway account ⇒ suppress the top-up
  }
  if (caps.length === 0) return null; // no concurrency signal ⇒ fail open (never strand on a missing signal)
  const capacityHeadroom = Math.min(...caps);
  // The RECOMMENDATION — what capacity advises, always computed so an override is always legible.
  const recommendedOpenCount = Math.min(requested, capacityHeadroom);
  // ADVISORY CLAMP (owner directive 2026-07-09): `override` honors the recommendation as advice only.
  const openCount = override ? requested : recommendedOpenCount;
  const clamped = openCount < requested;
  const overridden = override && recommendedOpenCount < requested;
  // ADVISORY only — the weekly budget is tight for this many members, but never a clamp.
  const utilizationTight = recommendedHeadroom != null && recommendedHeadroom < openCount;
  const detail = `dispatchBudget=${dispatchBudget ?? 'n/a'} (concurrency — the real cap), recommendedHeadroom=${recommendedHeadroom ?? 'n/a'} (weekly-budget util — ADVISORY, not a cap), healthyAccounts=${healthyAccounts ?? 'n/a'} (${gatewayRouted ? (freshSameProfileCanary ? 'fresh same-profile canary authenticated this route; 0 is treated as stale for this bounded retry' : 'accounts do NOT cap sessions; 0 = nothing can authenticate') : 'pool — does NOT gate this launch: members route on the direct system credential, gateway skipped'})`;
  return {
    requestedOpenCount: requested,
    openCount,
    clamped,
    reachable: true,
    healthyAccounts,
    dispatchBudget,
    recommendedHeadroom,
    utilizationTight,
    recommendedOpenCount,
    overridden,
    reason: overridden
      ? `capacity OVERRIDDEN: launching all ${requested} (capacity recommended ${recommendedOpenCount}). The recommendation stands — if it was RIGHT, these members will contend or fail to authenticate; if healthyAccounts=0 is a STALE in-memory exhaustion, probe/readmit the pool (accounts:probe-capacity, POST /admin/readmit) rather than relying on the override (${detail})`
      : clamped
        ? `capacity-clamped top-up ${requested}→${openCount} — pass override to launch all ${requested} anyway (${detail})`
        : freshSameProfileCanary && healthyAccounts === 0 && gatewayRouted
          ? `capacity-ok top-up ${requested} — a fresh same-profile canary authenticated this route, so the healthyAccounts=0 signal is treated as stale for this bounded retry (${detail})`
        : utilizationTight
          ? `capacity-ok top-up ${requested}, but weekly-token-budget is tight for this many members (recommendedHeadroom=${recommendedHeadroom}) — they still all launch, may hit the wall sooner (${detail})`
          : `capacity-ok top-up ${requested} (${detail})`,
  };
}

/** The owner-facing default is the inference gateway's AUTO routing on every host
 * (owner directive 2026-09-15, WI-10001535: "set the canary agents to opus 5 xhigh
 * agents pinned to auto mode of the inference gateway"; it ratifies the standing
 * 2026-07-01 mandate that ALL agents auto-route rather than hard-pin an account).
 *
 * This is what the fleet CANARY inherits: the canary-first launch has no model or
 * account knob of its own — `hasFreshSameProfileCanary` compares the canary against
 * the member profile — so the canary's routing IS this default.
 *
 * `auto` lets the gateway pick an available account and FAIL OVER when one is
 * rate-limited; `default` skipped the gateway entirely and therefore had no failover.
 * The trade is deliberate and is not free: an auto-routed launch is gateway-routed, so
 * it becomes subject to the `healthyAccounts === 0` capacity gate that a `default`
 * launch bypassed. `overrideCapacityClamp` and a fresh same-profile canary receipt are
 * the documented escapes when that reading is stale.
 *
 * Platform-specific credential inheritance is an implementation concern, not
 * permission to silently change the selected routing mode. */
export function defaultMemberAccountRouting(
  account: string | undefined,
  _platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (account) return account;
  return 'auto';
}

/**
 * P-006 (knowledge-at-symptom-time-2026-08-09): state the fleet's FILL against the TARGET,
 * so a partially-filled fleet can never render as a full one.
 *
 * `count` is a TARGET fleet size, not "terminals to open": only the deficit
 * (`count - liveMembers`) is attempted, and `clampFleetTopUpToCapacity` can shrink that
 * deficit further. The pre-fix headline rendered `opened/attempted` — a ratio whose
 * DENOMINATOR is the post-clamp attempt — so a request for 10 that clamped to 4 rendered
 * `4/4 members opened`, which is indistinguishable from complete success. Measured incident
 * (P-006): an owner asked for 10 members, 4 opened, and the agent reported 10 were coming.
 *
 * Denominating against `requested` and naming the shortfall is what makes the shortfall
 * legible AT THE MOMENT OF THE LAUNCH — the same symptom-time principle as the rest of this
 * plan. `attempted` is reported only as the wave's own failure detail, never as a denominator.
 */
export function describeFleetFillOutcome(o: {
  /** `count` — the TARGET fleet size the caller asked for. */
  requested: number;
  /** Members already LIVE before this wave (they are not re-opened). */
  liveMembers: number;
  /** Terminals this wave tried to open (the post-clamp deficit). */
  attempted: number;
  /** Terminals that actually opened. */
  opened: number;
  /** Noun for a member, e.g. 'HEADLESS member'. Default 'member'. */
  noun?: string;
  /** Why a successful bounded wave can still leave the fleet below target. */
  limitedBy?: 'capacity' | 'host-memory' | 'wave';
}): { fleetSize: number; shortfall: number; complete: boolean; clause: string } {
  const nonNeg = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  const requested = nonNeg(o.requested);
  const liveMembers = nonNeg(o.liveMembers);
  const attempted = nonNeg(o.attempted);
  const opened = nonNeg(o.opened);
  const noun = o.noun?.trim() || 'member';
  const fleetSize = liveMembers + opened;
  const shortfall = Math.max(0, requested - fleetSize);
  const complete = shortfall === 0;
  const plural = opened === 1 ? '' : 's';
  const failedThisWave = Math.max(0, attempted - opened);
  const clause = complete
    ? `${opened} ${noun}${plural} opened — fleet is now ${fleetSize} of the ${requested} requested`
    : `${opened} ${noun}${plural} opened — ⚠ fleet is ${fleetSize} of the ${requested} requested, SHORT BY ${shortfall}` +
      (failedThisWave > 0
        ? ` (${failedThisWave} of this wave's ${attempted} terminal${attempted === 1 ? '' : 's'} failed to open)`
        : o.limitedBy === 'wave'
          ? ' (the remaining deficit exceeded the per-wave launch limit — every terminal this wave attempted DID open; re-read live membership before the next top-up)'
          : o.limitedBy === 'host-memory'
            ? ' (the deficit was host-memory-clamped — every terminal this wave attempted DID open, so the fleet is still under target)'
            : ' (the deficit was capacity-clamped — every terminal this wave attempted DID open, so the fleet is still under target)');
  return { fleetSize, shortfall, complete, clause };
}

/**
 * EI-22168623726023643 — the headline for a wave that opened ZERO members.
 *
 * P-006 made {@link describeFleetFillOutcome} compute the ⚠ shortfall clause and the CAUSE,
 * and the zero-open branch then discarded both, emitting a flat "No member terminals were
 * started for fleet `X`." beside `ok:true`. That reads as a benign no-op in precisely the
 * case where it is the opposite: a capacity clamp to zero leaves the caller holding a LIVE,
 * REGISTERED leader and an EMPTY fleet, so the plan looks staffed and is not. Two real
 * launches were reported as successful placements that way.
 *
 * The benign/malign split is `fill.complete`, not the opened count: a fleet ALREADY at target
 * correctly opens nothing, and warning there would be a false alarm on the common top-up path.
 */
export function describeZeroOpenFleetHeadline(o: {
  fleetSlug: string;
  /** The fill verdict from {@link describeFleetFillOutcome} — its clause already names the cause. */
  fill: { complete: boolean; clause: string };
  /** The capacity clamp's own reason, when one suppressed the wave. */
  clampReason?: string | null;
}): string {
  if (o.fill.complete) {
    // Not a shortfall: the deficit was already satisfied, so nothing needed opening.
    return `No new member terminals were needed for fleet \`${o.fleetSlug}\` — ${o.fill.clause}.`;
  }
  const reason = o.clampReason?.trim() ? ` ${o.clampReason.trim()}.` : '';
  return (
    `⚠ NO member terminals were started for fleet \`${o.fleetSlug}\` — ${o.fill.clause}.${reason} ` +
    'The fleet now has a LIVE LEADER and NO members, so the plan LOOKS staffed while nothing is working it. ' +
    're-call this tool once capacity recovers (the live-member deficit guard opens only the remaining deficit), ' +
    'and do not record the plan as staffed on this result.'
  );
}

/** Backward-compatible export for p2p delegated-spawn callers. */
export const memberLaunchCommand = sharedMemberLaunchCommand;

/**
 * MEMBER_BASELINE_RULES / renderMemberBaseline / composeMemberLaunchContext now live in
 * agent-launch-core.ts (WI-4442 — finishing the P-001/D-002 relocation: this file used to
 * carry its OWN copy of all three, which had already drifted from the core's stale copy —
 * the core version required `plan` while this file's had grown the P-003 optional-plan
 * case, so a future direct caller of the core version would have silently regressed. Single
 * source now; re-exported here unchanged so this file's own callers (composeMemberLaunchContext
 * usages below) and external ones (p2p/delegated-spawn-honor.ts's dynamic import, this file's
 * own tests) keep working without a call-site change. */
export const MEMBER_BASELINE_RULES = sharedMemberBaselineRules;
export const renderMemberBaseline = sharedRenderMemberBaseline;
export const composeMemberLaunchContext = sharedComposeMemberLaunchContext;
export { IMMUTABLE_MEMBER_LAUNCH_LINEAGE_GUARD } from '../../agent-launch-core';

/**
 * The fleet LEADER's standing-job checklist, rendered (auto-numbered) into the launch-result
 * message. Pure + exported so (a) its rendered length is test-guarded against silent balloon
 * (su-loop-capability-parity P-013 — context-blow is the #1 leader self-inflicted failure), and
 * (b) a future insert never has to hand-renumber the points. The universal
 * steer-don't-micromanage rules a leader runs each cycle until the plan drains. Numbering is
 * applied at render time (`${i + 1}.`) — keep each entry WITHOUT a leading number.
 */
/**
 * The AUTO-mode auto-enter directive rendered into the launch result the moment the caller
 * becomes a fleet LEADER. Leading a fleet from an ask-first posture is how fleets die
 * unsupervised: an AUTO-off leader parks waiting for permission while members stall, wedge,
 * or drain unnoticed (the 2026-07-03 ornith run: the leader stayed at its routing-gate
 * posture after this very call and only supervised when externally woken). The persona rule
 * ("creating or leading a fleet AUTO-ENTERS AUTO mode") is delivered HERE because this
 * result is the exact moment the caller becomes a leader — a persona clause alone is too
 * far from the act for weak models to bind it. Pure + exported for tests.
 */
export const LEADER_AUTO_MODE_DIRECTIVE =
  'LEADING THIS FLEET PUTS YOU IN AUTO MODE — effective NOW, for the rest of your session. ' +
  'You cannot supervise a fleet from an ask-first posture: act on your own judgment, do not ' +
  'stop to ask permission between steps, and NEVER end a turn waiting for an instruction while ' +
  'your fleet is live. Tell your owner you have switched to AUTO mode (a notice, not a question). ' +
  'Until the plan is drained, your standing job each cycle:';

export const LEADER_STANDING_JOB: readonly string[] = [
  'WATCH YOUR INBOX (coord:inbox) and handle anything addressed to you. Members ping the leader with wakeOnReply:true expecting an ack or a decision — blockers, systemic findings, "nothing left to claim". An unacked flag is a dropped ball: coord:ack it or act on it; never let it scroll past in the broadcast stream.',
  'STAY ALIVE across turns: loop:arm a monitor loop so your leadership persists — a leader that ends its turn with no loop stops leading and the fleet runs unsupervised. (To retune the cadence, loop:end then loop:arm fresh; an in-place interval change reverts.)',
  // su-loop-capability-parity P-002: steer-don't-dispatch (the queen model) + the completion mandate.
  "STEER, don't micro-dispatch: your members self-PULL via `scheduler:get_next`; you decide WHICH item each gets by SETTING/BUMPING its claim-spec — `scheduler:set_claim_spec { cupId, spec }` with a PROPERTY FILTER (e.g. `{field:'plan',op:'=',value:'<slug>'}` + a rank), NEVER id-pins for a standing lane (an `id in [...]` pin is a static one-off wave only). Re-steer a running member by bumping its spec (the revision auto-applies on its next pull), not by hand-assigning items. And you OWN driving the plan to done THROUGH the fleet — keep the lanes covered + the dependency order honest; do NOT quietly fall back to doing the work solo.",
  'Keep each wake LEAN: one dev:pg_query for burn-down + active-worker count. Do NOT dump fleet:assignments coverage[] or a full coord:presence every wake — that blows your OWN context within a few cycles and is the #1 leader self-inflicted failure.',
  // agent-launch-resume-primitives P-007: the leader's revival lever. Detail (account pin,
  // fork-a-live-source, how the brief lands as the first turn) lives in the agent-insight
  // doc `launching-resuming-and-forking-agents` — keep this point short.
  'AUDIT completions: spot-check terminalCompletionRefs (work_items:get) for evidence — files touched, the exact test run + its result — not just a status flip.',
  // su-loop-capability-parity P-006: the wave-close rubric-graded scorecard folded into the
  // wind-down point (per-WAVE, never per-turn) — keeps the leader block from growing a point.
  // agent-launch-resume-primitives D-006: no magic "resume the fleet" verb — the leader
  // sees WHO died and composes the revival per member (resume vs fork vs fresh).
  'BRING BACK a member that DIED mid-lane instead of re-launching a blank one: `capability:launch-agent { resume: { agentId }, fleet, brief }` restores it mid-thread, context intact (the brief becomes its next turn). `fleet:status` tells you WHO died and whether each is `resumable`. Choose per member — resume one deep in a lane, launch fresh for an unstarted lane; do not blanket-revive a member killed days ago.',
  'Right-size + wind down: relaunch a wave (this tool again) if workers thin out while claimable work remains; when only owner-gated/blocked/other-fleet residue is left OR the Mug issues graceful-drain cues, loop:end and report to the owner. Do not spin empty wakes. AT WAVE CLOSE emit a scorecard (per-WAVE, never per-turn) — `improvements:capture { lane:"observation", observation:{ rubricRef:"fleet-execution-health", ratings } }`, one rating per criterion, evidence MANDATORY, "unknown" the honest value for what you could not assess.',
  "Pausing the Hive Mug is NOT a 'drain your fleet' order. A hive pause / `pauseNewWork` / `maxBees` / a steering fact you see in orient governs the queen-bee loop, NOT your fleet: a fleet drains ONLY on an explicit owner / `fleet:*` action or a drain cue ADDRESSED to you. Check a cue's authority+scope stamp — `hive-queen(<hive>)→hive-wide` is the Mug; `fleet-leader(<other>)→fleet-members` is a PEER draining ITS OWN members, not a command to you. Never drain a peer leader or another fleet; if unsure, `pot:get-steering` + ask the owner rather than self-draining.",
  // su-loop-capability-parity P-010: read the CURATED fleet feed at wave boundaries
  // (salience-ranked, triage-deduped) + the overwatch nudge-hygiene rule.
  'Read the CURATED fleet feed at wave boundaries: `curation:feed` is the salience-ranked, triage-deduped signal (blockers / escalations / questions), so you are not re-deriving state from a raw `coord:inbox` scan. Nudge hygiene: RE-READ state before nudging (the drift may already be resolved); a nudge that fails to land twice is an ESCALATION to the owner, not a third nudge.',
  // su-loop-capability-parity P-012 (leader side): park with carry-notes, not prose.
  'When you PARK or hand off (wind-down, restart, leadership change), leave carry-notes — not prose that scrolls away: a per-item `work_items:checkpoint` for anything mid-flight + a plan `## Now` pointer (`plans:set-now`) to the resume state, so the next leader / your next wake picks up from durable state.',
];

/**
 * EI-8985: resolve each opened member's OWN brief text, index-aligned to
 * `perMemberBriefs` (entry 0 → member 1, …). A member beyond the array, or
 * whose entry is empty/whitespace, falls back to `sharedBriefText` (the plain
 * `launchContext` brief, if any) — never an error; a partially-specified
 * roster is normal (e.g. only the 2 specialists need distinct briefs, the
 * rest share the baseline). Pure + exported for a unit test.
 */
export function resolveMemberBriefText(
  index: number,
  perMemberBriefs: readonly (string | null | undefined)[] | undefined,
  sharedBriefText: string | null | undefined,
): string | null {
  const own = perMemberBriefs?.[index]?.trim();
  if (own) return own;
  const shared = sharedBriefText?.trim();
  return shared || null;
}

/**
 * EI-7671: build the FLEET-level claim spec that restricts every member's
 * scheduler:get_next self-pull to `kinds`. Pure + exported for a unit test — the
 * shape must satisfy validateClaimSpec (see scheduler:set_claim_spec's docstring
 * for the concrete field/op vocabulary). Rank/limits are inherited from
 * DEFAULT_CLAIM_SPEC unchanged: only the view.filter narrows (D-002 — a spec can
 * only narrow + reorder within the global floors, never widen past them).
 */
/**
 * P-010 (the bug-drain-200k trap): a kind-scoped fleet claim spec left at the OLD default
 * `states:['todo']` matched ZERO open bugs, the exact silent starvation EI-11300 names.
 * work-item-status-full-unify P-004/P-005: `open` is now the single unified claimable token
 * for BOTH families (feature `todo`→`open`), so any kind-scoped issue-family lane pins
 * `['open']`. Returns undefined for a pure feature-family set — the unified `['open']` floor
 * default already fits, so there is nothing to pin. Exported for a unit test.
 */
export function claimableStatesForKinds(kinds: readonly string[]): string[] | undefined {
  return exactPlanClaimableStatesForKinds(kinds);
}

/**
 * WI-6342: a fleet named as a "nonp2p" drain (the exact convention
 * `p2p-lane-fence.ts`'s own module doc already assumes — see its comment about
 * avoiding a false-positive on "a fleet literally named 'nonp2p-bug-drain'")
 * gets zero p2p/federation/rig awareness from `buildFleetKindClaimSpec`'s bare
 * kind-only filter: a p2p/dht/federation-tagged item (e.g. WI-6342, a
 * papercup-isolated-dht liveness bug) was served straight to a single-box
 * member who cannot execute it. This is the SAME regression class as
 * WI-5265/WI-5272/WI-5639/WI-6050 — a p2p-lane-fence silently missing from a
 * fleet's claim spec — recurring via a NEW code path (the auto-generated
 * "-kinds" spec `fleet:launch-on-plan` builds when a leader passes
 * `claimKinds` with no hand-authored spec yet) that was never wired to the
 * `p2p-lane` fence macro at all. Detected purely from the fleet slug (the
 * established naming convention for this drain-fleet family) since
 * `buildFleetKindClaimSpec` has no other signal of "this fleet's mandate
 * excludes P2P work" available to it.
 */
export function isNonP2pDrainFleetSlug(fleetSlug: string): boolean {
  return /nonp2p/i.test(fleetSlug);
}

export function buildFleetKindClaimSpec(fleetSlug: string, kinds: readonly string[]): Record<string, unknown> {
  const states = claimableStatesForKinds(kinds);
  return {
    specVersion: '1.0',
    specId: `fleet-launch-${fleetSlug}-kinds`,
    revision: 1,
    view: {
      filter: { field: 'kind', op: 'in', value: [...kinds] },
      // WI-6342: compose the shared p2p/federation/rig title-fence in for a
      // "nonp2p"-named drain fleet — see isNonP2pDrainFleetSlug above.
      // validateClaimSpec expands `fence` into `view.filter` (AND-composed
      // with the kind filter) at write time (claim-spec.ts, WI-6050).
      ...(isNonP2pDrainFleetSlug(fleetSlug) ? { fence: 'p2p-lane' } : {}),
    },
    rank: DEFAULT_CLAIM_SPEC.rank,
    limits: DEFAULT_CLAIM_SPEC.limits,
    // P-010: auto-include `open` for an issue-family drain so the lane doesn't starve.
    ...(states ? { states } : {}),
  };
}

/**
 * fleet-launch-plan-scoped-claim-spec (2026-07-08): build the FLEET-level claim spec that keeps
 * every member's scheduler:get_next self-pull on THIS plan's work-items — `plan = <planSlug>`
 * (the `plan` spec field maps to the `source_plan_slug` column; promoted work-items always carry
 * it, so the filter matches exactly), optionally AND `kind ∈ kinds`. get_next's harness+workspace
 * FLOORS already scope pickup to the plan's harness, so this is defense-in-depth: it stops a member
 * drifting onto UNRELATED work if the pot ever holds other work-items, AND closes the boot-race
 * where members pull under the empty-filter DEFAULT_CLAIM_SPEC before the leader hand-sets a spec.
 * Pure + exported for a unit test — the shape must satisfy validateClaimSpec (D-002: view.filter
 * only narrows + reorders within the global floors, never widens). Rank/limits inherited unchanged.
 */
export function buildFleetPlanClaimSpec(
  fleetSlug: string,
  planSlug: string,
  kinds?: readonly string[],
): Record<string, unknown> {
  return buildExactPlanClaimSpec(`fleet-launch-${fleetSlug}-plan`, planSlug, kinds);
}

/**
 * EI-10409: true when `specId` was authored by a leader/human (via
 * `scheduler:set_claim_spec`) rather than by this tool itself or the "nothing
 * customized yet" sentinel. Distinguishes a deliberate, leader-set fleet claim
 * spec (e.g. a vetted id-pinned wave) — which must be PRESERVED or MERGED into,
 * never silently clobbered — from one this tool generated on a prior launch
 * (safe to regenerate) or `DEFAULT_CLAIM_SPEC` (nothing to preserve).
 */
export function isLeaderAuthoredClaimSpec(specId: string, fleetSlug: string): boolean {
  if (specId === DEFAULT_CLAIM_SPEC.specId) return false;
  if (specId === `fleet-launch-${fleetSlug}-plan`) return false;
  if (specId === `fleet-launch-${fleetSlug}-kinds`) return false;
  return true;
}

/**
 * EI-10409: AND a `kind ∈ kinds` leaf onto an EXISTING (leader-authored) claim
 * spec's filter, preserving everything else (specId, rank, limits) and bumping
 * `revision`. Used when a launch carries `claimKinds` over a pre-set leader spec
 * — merges the kind constraint in rather than discarding the leader's view
 * (EI-10409 defect (a): a silent clobber). When the existing filter is empty
 * (`view: {}` — the `DEFAULT_CLAIM_SPEC` shape), the kind leaf becomes the whole
 * filter.
 */
export function mergeKindIntoClaimSpec(existing: ClaimSpec, kinds: readonly string[]): Record<string, unknown> {
  type ClaimFilter = NonNullable<ClaimSpec['view']['filter']>;
  // Annotated (not inferred) so `op` keeps its literal type: inference widens it to `string`, which
  // no longer satisfies FilterNode once the leaf flows through the typed dedupe below.
  const kindLeaf: ClaimFilter = { field: 'kind', op: 'in', value: [...kinds] };
  const existingFilter = existing.view?.filter;

  // Keep conjunctions canonical. In particular, the issue-family fallback's
  // positiveIdCohortIds extractor deliberately recognizes positive ID leaves only
  // when they are direct members of the top-level `all`. Wrapping an existing
  // `{ all: [...] }` as `{ all: [existingFilter, kindLeaf] }` hides that cohort and
  // makes an otherwise-valid fixed bug wave falsely report windDown=true. Flatten
  // recursively so a relaunch also repairs specs persisted by the old merge shape.
  const flattenAll = (filter: ClaimFilter): ClaimFilter[] =>
    'all' in filter ? filter.all.flatMap(flattenAll) : [filter];

  const referencesPlanFamilyScope = (filter: ClaimFilter): boolean => {
    if ('field' in filter) return filter.field === 'plan' || filter.field === 'plan_item' || filter.field === 'goal';
    if ('all' in filter) return filter.all.some(referencesPlanFamilyScope);
    if ('any' in filter) return filter.any.some(referencesPlanFamilyScope);
    return referencesPlanFamilyScope(filter.not);
  };

  const positiveKindValues = (filter: ClaimFilter): string[] | null => {
    if (!('field' in filter) || filter.field !== 'kind') return null;
    if (filter.op !== '=' && filter.op !== 'in') return null;
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return values.map(String);
  };

  // The merge is APPLIED REPEATEDLY to the same spec — every relaunch/top-up of a fleet whose leader
  // authored a spec runs it again — so appending unconditionally makes the conjunction grow without
  // bound. Caught on the live `nonp2p-bug-drain` spec 2026-08-09: two launch-on-plan calls carrying
  // claimKinds:['bug'] left rev7 holding the IDENTICAL {field:'kind',op:'in',value:['bug']} leaf THREE
  // times. An AND of identical predicates is semantically idempotent, so nothing misbehaves today —
  // which is exactly why it would have gone on accreting silently until the spec was a wall of
  // duplicates, unreadable by the humans and agents who audit these lanes for scope drift.
  //
  // Structural dedupe on a key with sorted object keys (arrays keep their order — two `in` lists that
  // differ only by ordering are left alone rather than assumed equivalent, which is the conservative
  // direction: a missed dedupe costs one duplicate clause, a wrong one silently widens a lane).
  const stableKey = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableKey((v as Record<string, unknown>)[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
  };
  const dedupe = (clauses: ClaimFilter[]): ClaimFilter[] => {
    const seen = new Set<string>();
    return clauses.filter((c) => {
      const k = stableKey(c);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  // Shape is preserved exactly as before (a non-empty existing filter still yields `{ all: [...] }`
  // even when dedupe leaves one clause) — the positiveIdCohortIds extractor above only recognizes
  // positive ID leaves as direct members of a top-level `all`, so collapsing to a bare leaf here
  // would reintroduce the false windDown this function's comment already warns about.
  let filter: ClaimFilter;
  if (existingFilter && Object.keys(existingFilter).length > 0) {
    const flattened = flattenAll(existingFilter);
    if (referencesPlanFamilyScope(existingFilter)) {
      // EI-22042825344838662: a plan/goal worklist spans BOTH work-item families.
      // Relaunches repeatedly merged issue-only claimKinds as NEW `all` siblings,
      // turning an authored `kind in [bug,change,task,chunk,feature]` envelope into
      // its issue-only intersection. The live goal-drain spec accumulated three
      // positive kind leaves and then rejected an allowed pre-promotion P-NNN,
      // whose synthetic admission subject is correctly kind='feature'.
      //
      // Within a positive plan/plan_item/goal scope, kind lists are one DOMAIN
      // selector and therefore merge by UNION into one canonical leaf. The plan
      // allowlist and every non-kind sibling (especially the non-P2P fence) remain
      // AND constraints. Pure kind/backlog lanes retain intersection semantics.
      const mergedKinds: string[] = [];
      const withoutKindLeaves: ClaimFilter[] = [];
      let firstKindIndex = -1;
      for (const clause of flattened) {
        const values = positiveKindValues(clause);
        if (values) {
          if (firstKindIndex < 0) firstKindIndex = withoutKindLeaves.length;
          for (const value of values) if (!mergedKinds.includes(value)) mergedKinds.push(value);
        } else {
          withoutKindLeaves.push(clause);
        }
      }
      for (const value of kinds) if (!mergedKinds.includes(value)) mergedKinds.push(value);
      const canonicalKind: ClaimFilter = { field: 'kind', op: 'in', value: mergedKinds };
      const clauses = [...withoutKindLeaves];
      clauses.splice(firstKindIndex < 0 ? clauses.length : firstKindIndex, 0, canonicalKind);
      filter = { all: dedupe(clauses) };
    } else {
      filter = { all: dedupe([...flattened, kindLeaf]) };
    }
  } else {
    filter = kindLeaf;
  }
  // P-010: if the leader-authored spec never pinned `states`, derive it from the merged-in
  // issue-family kinds so the merge doesn't leave the lane at the starving ['todo'] default.
  // A leader-set `states` (spread via `...existing`) is preserved untouched.
  const derivedStates = existing.states ? undefined : claimableStatesForKinds(kinds);
  return {
    ...existing,
    view: { filter },
    revision: existing.revision + 1,
    ...(derivedStates ? { states: derivedStates } : {}),
  };
}

/**
 * WI-5211 (cross-machine placement): launch args that have NO effect on a remote
 * placement — the honoring host owns the spawn shape (its delegated slot pins
 * model+effort+account; window/carry/display are its machine's business). Listed so
 * placement:'remote' refuses them loudly instead of silently dropping them.
 */
export const REMOTE_PLACEMENT_UNSUPPORTED_ARGS = [
  'agent',
  'model',
  'account',
  'fromSeats',
  'seat',
  'headless',
  'carry',
  'display',
  'perMemberLaunchContext',
  // P-004: the declarative per-member spec pins model/account/carry/window shape per member,
  // all of which the honoring host owns on a remote placement — refuse it loudly (like its
  // brief-only twin `perMemberLaunchContext`) rather than silently dropping every member spec.
  'members',
  'profile',
  'contextSize',
  'brain',
  'addDir',
  'allowSubagents',
  'extraArgs',
  'feature',
  'role',
  'overrideCapacityClamp',
] as const;

/** Pure: which explicitly-passed args a placement:'remote' launch must refuse. */
export function remotePlacementUnsupportedArgs(args: Record<string, unknown>): string[] {
  return REMOTE_PLACEMENT_UNSUPPORTED_ARGS.filter((k) => args[k] !== undefined);
}

/**
 * Pure (WI-5211): pick the ONE shared hive whose federated seat-offers a
 * placement:'remote' launch consumes. Thin back-compat wrapper (same name/shape
 * this module has always exported) over the generalized
 * `resolveSharedHiveDisambiguation` (EI-16673), which resource:offers now also
 * uses — see federation-scope.ts for the shared logic.
 */
export function resolveRemotePlacementHive(
  scope: WorkspaceHiveScope,
  explicitHive: string | undefined,
  harness: string | null,
): { ok: true; homeSlug: string } | { ok: false; error: string } {
  const picked = resolveSharedHiveDisambiguation(scope, explicitHive, harness);
  return picked.ok ? { ok: true, homeSlug: picked.homeSlug } : { ok: false, error: picked.error };
}

/** One remote machine's open seat-offer, summarized for distribution. */
export interface RemoteSeatOfferSummary {
  publisher: number;
  offerId: string;
  host: string | null;
  seats: number;
  /** P-005: set for a pot-scoped offer (fleetSlug=null on the row) — threaded
   *  back into publishSpawnRequest's requesterPotSlug so the honoring host's
   *  audience gate (delegated-spawn-honor.ts) can evaluate it; null/undefined
   *  for a fleet-scoped offer (no audience concept). */
  potSlug?: string | null;
}

export type RemotePlacementDistribution =
  | { ok: true; allocations: Array<RemoteSeatOfferSummary & { count: number }> }
  | { ok: false; error: string };

/**
 * PURE (P-014/D-005 — the local-seat leg of "placement/spawn must treat local
 * and remote seats uniformly"): true when a published seat-offer's signer
 * identity matches the CALLER's own identity — i.e. this machine delegated the
 * seat to its own fleet (self-donation), so the seat is consumed LOCALLY via
 * `fromSeats`/`seat` (D-005: a remote fleet's seats may come from local or
 * remote donors) rather than via a remote spawn-request. Without this
 * exclusion a self-delegated seat would ALSO be offered to
 * `distributeRemotePlacement`, publishing a spawn-request that targets the
 * caller itself — the honor hook only fires on a REMOTE apply, so a
 * self-targeted request would just sit forever, silently under-filling the
 * fleet. Fails OPEN (never excludes) when either identity half is unknown —
 * the caller's own best-effort identity resolution already logs/handles that
 * upstream, and `publishSpawnRequest`'s self-target guard backstops any offer
 * that slips through here.
 */
export function isSelfPublishedSeatOffer(
  offer: { publisherGithubUserId: number | null; signerDevicePubkey: string | null },
  selfGithubUserId: number | null,
  selfDevicePubkey: string | null,
): boolean {
  return (
    selfGithubUserId != null &&
    selfDevicePubkey != null &&
    offer.publisherGithubUserId === selfGithubUserId &&
    offer.signerDevicePubkey === selfDevicePubkey
  );
}

/**
 * PURE (WI-5211; P-005 pools in pot-scoped offers too): spread `count` members
 * across the fleet's REMOTE seat-offers. `offers` is the CALLER's already-merged
 * pool of this fleet's own fleet-scoped offers AND its pot's shared (potSlug-set)
 * offers — this function is scope-blind and just spreads over whatever it's
 * given. Deterministic max-spread round-robin — 1 member per machine per round
 * (offers sorted by host label then offer id), so `count` ≤ machines lands
 * exactly one member on each of `count` DIFFERENT machines before any machine
 * gets a second; each offer is bounded by its delegated seat count. Refuses
 * (never clamps) when `count` exceeds the total delegated remote capacity.
 */
export function distributeRemotePlacement(
  count: number,
  offers: readonly RemoteSeatOfferSummary[],
): RemotePlacementDistribution {
  const usable = offers.filter((o) => o.seats > 0);
  if (usable.length === 0) {
    return {
      ok: false,
      error:
        "no open REMOTE seat-offer for this fleet or its pot — a contributing machine delegates first (resource:delegate kind:'agent_slot', to the fleet or to the whole pot); this machine's own delegation spawns locally (fromSeats), never via placement:'remote'",
    };
  }
  const capacity = usable.reduce((s, o) => s + o.seats, 0);
  if (!Number.isSafeInteger(count) || count < 1 || count > capacity) {
    return {
      ok: false,
      error: `count must be 1..${capacity} (the seats delegated across ${usable.length} remote machine${usable.length === 1 ? '' : 's'}: ${usable
        .map((o) => `${o.host ?? `publisher ${o.publisher}`}=${o.seats}`)
        .join(', ')}), got ${count}`,
    };
  }
  const sorted = [...usable].sort(
    (a, b) => (a.host ?? '').localeCompare(b.host ?? '') || a.offerId.localeCompare(b.offerId),
  );
  const allocated = new Map<string, number>();
  let remaining = count;
  while (remaining > 0) {
    let progressed = false;
    for (const o of sorted) {
      if (remaining === 0) break;
      const cur = allocated.get(o.offerId) ?? 0;
      if (cur < o.seats) {
        allocated.set(o.offerId, cur + 1);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break; // unreachable given the capacity check — belt and braces
  }
  return {
    ok: true,
    allocations: sorted
      .filter((o) => (allocated.get(o.offerId) ?? 0) > 0)
      .map((o) => ({ ...o, count: allocated.get(o.offerId)! })),
  };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Preflight every explicitly requested psu role through the SAME role-prompt
 * assembler bootstrap-role will use after a terminal opens. `fleet:launch-on-plan`
 * is otherwise able to accept an arbitrary string, open a real desktop window,
 * and discover only inside psu that no persona exists (EI-21014432394938679:
 * `role:"builder"` left a failed terminal plus a partial launch transaction).
 *
 * Plain `su` and the closed SU-tier addendum roles stay on bootstrap-su, so they
 * deliberately bypass role-prompt resolution. Every other role must resolve in
 * the target harness/blueprint now. This preserves blueprint-specific roles—the
 * assembler reads the harness's real blueprint chain—instead of narrowing the
 * open role set to a hand-maintained enum that would reject legitimate specialists.
 */
async function unresolvedFleetMemberRole(opts: {
  harness: string;
  workspaceId: string;
  count: number;
  role?: string;
  members?: readonly MemberSpec[];
}): Promise<string | null> {
  const requested: Array<{ source: string; role: string }> = [];
  const fleetRole = opts.role?.trim();
  if (fleetRole) requested.push({ source: 'role', role: fleetRole });
  for (let i = 0; i < Math.min(opts.count, opts.members?.length ?? 0); i++) {
    const role = opts.members?.[i]?.role?.trim();
    if (role) requested.push({ source: `members[${i}].role`, role });
  }
  const unique = Array.from(new Map(requested.map((entry) => [entry.role, entry])).values());
  if (unique.length === 0) return null;

  const projectDir = await resolveProjectDir(opts.harness, opts.workspaceId);
  if (!projectDir) {
    return `Could not preflight fleet member role(s): harness \`${opts.harness}\` is not registered in workspace \`${opts.workspaceId}\`. NO fleet was created and NO terminals were opened.`;
  }

  for (const entry of unique) {
    if (entry.role === 'su' || isSuTierRole(entry.role)) continue;
    try {
      assembleRolePrompt({
        slug: opts.harness,
        projectDir,
        role: entry.role,
        mode: 'chat',
      });
    } catch (e: any) {
      return (
        `Invalid fleet member role \`${entry.role}\` from \`${entry.source}\`: ` +
        `${e?.message ?? e}. Omit \`role\` for the standard su collaborator, pass \`role:"su"\`, ` +
        `or choose a role whose prompt resolves in harness \`${opts.harness}\`. ` +
        'NO fleet was created and NO terminals were opened.'
      );
    }
  }
  return null;
}

/**
 * A headcount profile's `role` is a psu persona when authored by a caller, but
 * older goal-driven launches persisted the goal's launch SLOT there instead
 * (for example `drain-fleet-leader`).  A slot is not a persona and must not be
 * sent through role-prompt preflight or `psu --role` on recovery.
 *
 * This boundary is intentionally source-aware: only a role inherited from the
 * persisted homogeneous profile is eligible for sanitization.  Explicit caller
 * roles remain untouched, including an explicit value that happens to be a
 * goal-slot name (it should receive the normal persona validation error), and
 * per-member `members[].role` overrides are not inspected here at all.
 */
export interface IgnoredPersistedGoalRoleDiagnostic {
  role: GoalLaunchRole;
  source: 'fleet:headcount-target';
  reason: 'goal-launch-slot-is-not-a-psu-persona';
}

export interface PersistedGoalLaunchRoleSanitization {
  role?: string;
  ignoredRoles: IgnoredPersistedGoalRoleDiagnostic[];
}

export function sanitizePersistedGoalLaunchRole(opts: {
  persistedRole?: unknown;
  explicitRole?: unknown;
}): PersistedGoalLaunchRoleSanitization {
  const explicitRole = typeof opts.explicitRole === 'string' ? opts.explicitRole.trim() : undefined;
  const persistedRole = typeof opts.persistedRole === 'string' ? opts.persistedRole.trim() : undefined;

  // Explicit input wins over recovery. Do not use a broad goal-role filter here:
  // the caller may intentionally ask psu to validate a role, and member roles
  // are handled by unresolvedFleetMemberRole/foldMemberSpec independently.
  if (explicitRole !== undefined) return { role: explicitRole, ignoredRoles: [] };
  if (!persistedRole) return { role: undefined, ignoredRoles: [] };

  // The predicate is the runtime guard; the closed array is kept in the same
  // expression so adding/renaming a launch slot cannot silently change this
  // boundary without updating the canonical vocabulary.
  if (isGoalLaunchRole(persistedRole) && GOAL_LAUNCH_ROLES.includes(persistedRole)) {
    return {
      role: undefined,
      ignoredRoles: [
        {
          role: persistedRole,
          source: 'fleet:headcount-target',
          reason: 'goal-launch-slot-is-not-a-psu-persona',
        },
      ],
    };
  }
  return { role: persistedRole, ignoredRoles: [] };
}

// Keep the name discoverable to callers that describe the input as a fleet
// profile rather than a goal launch; both names share one implementation.
export const sanitizePersistedFleetLaunchRole = sanitizePersistedGoalLaunchRole;

/**
 * EI-18862608742257943: extract every WI-/EI- id referenced across the composed
 * kickoff brief text(s) a launch is about to hand its members — reusing the SAME
 * id-extraction the work_items:create mirror-guard uses (WI-<n> / EI-<n>,
 * case-insensitive, deduped) rather than inventing a second regex. Pure + exported
 * for a unit test. `null`/`undefined`/blank entries are ignored (a member with no
 * distinct brief falls back to the shared one, or to none at all).
 */
export function extractKickoffWorkItemIds(texts: readonly (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const id of extractWorkItemIds(t)) ids.add(id);
  }
  return [...ids];
}

/**
 * Keep the durable launch transaction addressable from tool_invocations without
 * copying its mutable outcome into telemetry. The fleet registry remains the
 * source of truth; metadata_json supplies the join key for the sweep.
 */
function stampLaunchOutcome(
  ctx: { metadata?: (data: Record<string, unknown>) => void },
  fleet: string,
  transaction: FleetLaunchTransaction,
): void {
  ctx.metadata?.({
    launchOutcome: {
      fleet,
      transactionId: transaction.transactionId,
    },
  });
}

/**
 * One role's slice of a PAIRED launch (D-009 / P-011). Deliberately the same
 * knobs as the flat single-fleet set, minus `count` — a paired fleet is 1:1, so
 * N lives at the top level (D-012) and a per-role count is refused rather than
 * ignored. Declared once and used for both roles so the two can never drift.
 */
const PAIRED_ROLE_ARGS = z.object({
  agent: z.enum(['claude', 'omp', 'codex']).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  headless: z.boolean().optional(),
  account: z.string().optional(),
  carry: z.enum(['warm', 'cold']).optional(),
  // Accepted by the SCHEMA so the refusal comes from resolveLaunchOptions with a
  // real repair ("pair count lives at the top level"), rather than as an opaque
  // zod "unrecognized key" that does not say where to put it instead.
  count: z.number().int().min(1).optional(),
});

/** R5 (interrupted-member-recovery-hardening-2026-09-01): decide how an explicit
 * `supervise` grant/revoke reaches the fleet's durable headcount row. Pure so
 * the branch is provable without opening a terminal (this module's standing
 * discipline). `write` non-null ⇒ the caller must rewrite the row in place; a
 * write failure downgrades `persisted` at the call site. An undeliverable grant
 * (no row, or a disabled row the store cannot rewrite config for) is REPORTED,
 * never silently dropped — "reads as configured while binding nothing" is the
 * exact D-016/WI-38048 failure class. */
export function resolveSuperviseGrant(args: {
  supervise: boolean | undefined;
  /** The headcount profile as it stands AFTER any fresh-fleet persist. */
  profile: { target: number; config: { supervise?: boolean } } | null;
  /** The durable row (re-read for `enabled`), or null when none exists. */
  existing: Pick<FleetHeadcountTarget, 'enabled' | 'target' | 'config'> | null;
}): {
  requested: boolean;
  persisted: boolean;
  reason: string;
  write: { target: number; config: FleetHeadcountConfig } | null;
} | null {
  if (args.supervise == null) return null;
  if (args.profile?.config.supervise === args.supervise) {
    return {
      requested: args.supervise,
      persisted: true,
      reason: 'persisted on the fleet launch recipe',
      write: null,
    };
  }
  if (args.existing?.enabled) {
    return {
      requested: args.supervise,
      persisted: true,
      reason: 'updated the existing enabled headcount row in place',
      write: {
        target: args.existing.target,
        config: normalizePersistedFleetLaunchConfig({ ...args.existing.config, supervise: args.supervise }),
      },
    };
  }
  return {
    requested: args.supervise,
    persisted: false,
    reason: args.existing
      ? 'the fleet headcount row is disabled (target null) and the store cannot rewrite config without arming; arm it via fleet:headcount-target { target, supervise }'
      : 'no homogeneous headcount recipe exists for this fleet (paired/heterogeneous launches persist none); arm one via fleet:headcount-target { target, supervise }',
    write: null,
  };
}

export default defineTool({
  name: 'fleet:launch-on-plan',
  description:
    "Launch N su members on an existing plan — visible or headless. Ensures fleet, leadership, plan binding and first-turn request; do not assemble them with capability:launch-agent/terminal. Process open is not proof of registration, a verified first turn, or a claimed task; read `launchTransaction`. `carry` picks warm/cold; `placement:'remote'` uses delegated-seat machines.",
  guidance: {
    when: 'ERGONOMIC N-AGENTS-ON-AN-EXISTING-PLAN DOOR: members auto-join and receive the plan as their first-turn request. Prefer over capability:launch-agent or capability:terminal. Queue duplicate screening governs work-item claims; it is not a reason to delay opening the fleet.',
    notWhen:
      'Not for: an AD-HOC brief with no plan, RESUMING a dead agent mid-thread, or FORKING a live one — that is capability:launch-agent (the flexible superset; `fleet` optional there, so a non-leader can launch too). Not for the retired background cup/nursery tier, plain command windows (capability:terminal), or fleet registration only (fleet:create). Decision table: /internal/docs/agent-insights/launching-agents-which-tool-for-which-door.',
    chaining:
      'plans:apply-plan-block or plans:new/plans:add-item → plans:start (REQUIRED — items become claimable only through it; skipped, the fleet launches onto an empty backlog; backstopped idempotently here) → fleet:launch-on-plan { name, plan, count }. As leader, loop:arm a lean monitor; avoid polling full rosters every wake.',
  },
  // Desktop-spawn is the privileged action — gate it exactly like capability:terminal.
  capability: 'capability:terminal',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    name: z
      .string()
      .min(1)
      .describe('Fleet name — created (you become leader) if new, else joined. Slugified to the durable handle.'),
    plan: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Plan slug (filename without .md) the members should work — must already exist. OPTIONAL (P-003): omit it to launch a PURE CLAIM-SPEC fleet (members self-pull by `claimKinds`, no plan lane). When omitted, `claimKinds` is REQUIRED so the members have a lane to drain.',
      ),
    harness: z
      .string()
      .optional()
      .describe(
        "Harness the plan belongs to. Defaults to the session's harness scope; required when the session is unscoped.",
      ),
    directors: PAIRED_ROLE_ARGS.optional().describe(
      "type:'paired' ONLY (D-009): the DIRECTOR half of every pair — the session that decomposes the plan item into milestones, issues one directive at a time, verifies each from the ledger, and closes the milestone work items. Give it the strongest model you are willing to pay for (D-006): its job is judgement, and it never loads file bodies so it stays cheap per turn. Each knob here is independent of `implementers`. Passing this on a type:'single' fleet is rejected.",
    ),
    implementers: PAIRED_ROLE_ARGS.optional().describe(
      "type:'paired' ONLY (D-009): the IMPLEMENTER half of every pair — the session that edits, tests and reports, and cannot self-direct (it is parked between directives and tool-denied from completing work items or arming loops). May be a CHEAPER tier than the director (D-006), and a different model FAMILY is preferred so the pair's errors decorrelate. Passing this on a type:'single' fleet is rejected.",
    ),
    type: z
      .enum(['single', 'paired'])
      .optional()
      .describe(
        "Fleet TYPE (D-008), which also SELECTS THE OPTION SHAPE this call accepts (D-009). 'single' (default) is today's fleet, unchanged: N independent members configured by the FLAT knobs (agent/model/count/headless/account/carry/…). 'paired' launches N director↔implementer pairs and takes those same knobs as two per-role groups instead — `directors:{…}` and `implementers:{…}` — so a top-tier visible director can sit beside cheaper headless implementers. The shapes do not merge: passing per-role groups with type 'single', or flat per-member knobs with type 'paired', is REJECTED with invalid_args naming the expected shape, never coerced (a flat value broadcast to both roles is how you end up with a fleet of directors running the implementer's model).",
      ),
    agent: z
      .enum(['claude', 'omp', 'codex'])
      .optional()
      .describe(
        'Backend each member runs. When omitted, a known model family selects its native backend (`luna`/`terra`/`sol`/`gpt-*` → `codex`; `opus`/`sonnet`/`haiku`/`fable`/`claude-*` → `claude`; local `ollama-cc/…`/ornith → `omp`), then the caller backend is inherited, with `claude` only as the final fallback. Explicit native-backend/model-family mismatches are REJECTED before terminals open; `omp` may still be selected explicitly for supported cloud providers.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `TARGET fleet size — NOT the number of new terminals to open (default 1). Only the DEFICIT opens: with N members already LIVE, count:M opens M−N, and a fleet already at M opens NOTHING (relaunchSuppressed:true). For a plan-scoped launch, an explicit target wider than the plan's currently executable DAG frontier is refused before fleet creation with requestedSeats/executableWidth/seatShortfall and exact blocker diagnostics. The full live-member deficit proceeds through governed admission; capacity may clamp it, so the fleet can end up SMALLER than count — read \`fleetSize\`/\`shortfall\` on the result, never the opened count alone. To ADD N members to a running fleet, pass count = liveMembers + N.`,
      ),
    placement: z
      .enum(['local', 'remote'])
      .optional()
      .describe(
        "Where members run (default 'local': this machine, exactly as before). 'remote' places members on the OTHER machines that delegated agent_slot seats to this fleet OR to its pot (P-005: fleet-scoped and pot-scoped federated seat-offers are pooled together): `count` is spread round-robin across those machines — 1 per machine first, so count 2 across 2 machines lands 1 member on EACH — publishing one SIGNED spawn-request per target (the fleet:request_remote_spawn chain, which stays the single-target/explicit-pick door). ASYNC: members arrive only after each host's owner-authority accept-delegated-seats gate admits the request, AND — for a pot-scoped target — that host's audience check for the pot ('trusted-members'|'whole-pot') passes (a gate-off host, or an audience refusal, lets/leaves the request to expire after 60 min); watch arrivals via fleet:status / coord:presence, refusals via p2p:trace. Each machine's delegated slot pins the member's model+effort+account and the host owns the window shape, so agent/model/account/seat/headless/carry/display/per-member-brief args are REFUSED with 'remote'; `launchContext` still applies (sent as brief text, ≤8000 chars).",
      ),
    hive: z
      .string()
      .optional()
      .describe(
        "placement:'remote' on a MULTI-hive workspace: which shared hive's federated seat-offers to place onto (mirror of resource:delegate's `hive`). Defaults to the single shared hive, else to `harness` when that names a shared hive; otherwise the call refuses and lists the candidates.",
      ),
    headless: z
      .boolean()
      .optional()
      .describe(
        "Launch the members HEADLESS — background su sessions with NO desktop window (default false = visible terminals). Same su members (NOT cups), same leader-led contract, they register presence + count toward the fleet, auto-start on the plan, and stay injectable for warm loop:arm wakes; they just have no window and log to a file you can tail. EI-9748 FIXED (2026-07-11, live): on a systemd-managed Linux host (the normal case), each headless member is spawned via `systemd-run --user --scope`, which places it in a transient scope that is a SIBLING of the operator API's own service in the systemd --user cgroup tree — NOT a descendant — so `systemctl --user restart` of papercup-dev-api/papercup-staging-api (KillMode=control-group) cannot reap it; a headless member now survives those restarts just like a visible one. RESIDUAL CAVEAT: on a host with no `systemd-run` on PATH (macOS, a bare/non-systemd container), the spawn falls back to a plain detached child that DOES still share the operator process's cgroup and CAN be silently SIGTERM-killed by a restart of that service — a killed member's log says so. Headless is safe to prefer by default on Linux dev hosts; on a non-systemd host, prefer visible for anything that must survive hours unattended, or check on the fleet more often. Orthogonal to `carry`.",
      ),
    leader: z
      .enum(['caller', 'spawn'])
      .optional()
      .describe(
        "WHO LEADS the fleet (generic default 'caller' — you become leader, the historical behavior). Under GOAL context omission defaults to 'spawn' and explicit 'caller' is refused: a GOAL portfolio steward must never lead its plan fleet. 'spawn' launches a FRESH agent to lead it and leaves you out of the fleet entirely. Replaces the two-hop relay (launch an agent, brief it to call this tool itself) with one call. The spawned leader's coord identity is PRE-PINNED, so the fleet row names its real leader from the first write and there is never a window where you are recorded as leading. It is opened BEFORE any member, and if it fails to open the whole launch ABORTS with zero members — members draining a queue with no leader watching is worse than no fleet. Goal-context leaders and members bind their distinct launch-role profiles; explicit top-level/per-member choices still win.",
      ),
    confirmRouteSwitch: z
      .boolean()
      .optional()
      .describe(
        "Explicitly authorize moving the CALLER from its currently registered fleet into a different target fleet. Without this bit, a caller-led launch (`leader:'caller'`, the default) is refused before mutation when the caller already belongs to another fleet; use `leader:'spawn'` instead when the current fleet must keep its supervisor. This is an audit guard, not a convenience retry flag — read the refusal's currentFleet/targetFleet first.",
      ),
    carry: z
      .enum(['warm', 'cold'])
      .optional()
      .describe(
        "Auto-mode carry for EVERY member (default 'warm'), INDEPENDENT of `headless`: 'warm' = each loop:arm wake resumes the SAME live context (fast, remembers the thread); 'cold' = each wake starts a FRESH context reconstructed from the member's last checkpoint (cheaper long-run, survives compaction, but the carry-note is the ONLY memory). Threads into the member baseline so a cold member arms `loop:arm { carry:'cold' }` and treats its checkpoint as load-bearing. ANNOUNCE the choice to the owner per the persona spawn-disclosure rule (alongside account + model).",
      ),
    supervise: z
      .boolean()
      .optional()
      .describe(
        'R5 per-fleet governor grant: true opts THIS fleet into fleet-headcount auto-top-up by persisting `supervise: true` on its durable launch recipe (the governor acts only on granting fleets, and only while FLEET_HEADCOUNT_GOVERNOR is ON); false revokes; omit leaves the stored grant untouched. An undeliverable grant (paired/heterogeneous launch, or an existing fleet with no ENABLED headcount row) is reported on the result as `superviseGrant`, never silently dropped.',
      ),
    overrideCapacityClamp: z
      .boolean()
      .optional()
      .describe(
        "Treat the inference-pool capacity signal as a RECOMMENDATION, not a cap: launch all `count` members even when capacity would clamp them (including a pool reading healthyAccounts:0, which otherwise suppresses a gateway-routed launch to ZERO). The recommendation is still computed and reported (capacityClamp.recommendedOpenCount / overridden). Use when you believe the pool signal is STALE — but prefer FIXING the signal first: `accounts:probe-capacity` (store projection) and `POST /admin/readmit` (the gateway's in-memory exhaustion) are the real remedies. Default false.",
      ),
    // --- optional psu launch flags threaded onto EVERY member (EI-5765 / owner request) ---
    account: z
      .string()
      .optional()
      .describe(
        'psu --account routing for EVERY member (account-routing-3-options) — one of three: a POOL ACCOUNT ID (from accounts:list / gateway:status) → pin every member to it via the inference gateway (isolate/concentrate the fleet\'s load; no failover); "auto" → route through the gateway, which auto-selects an available account + fails over; "default" → skip the gateway, use the system / CLI-login credential. OMIT defaults to "default" on every platform; gateway routing is never selected implicitly. (For a multi-account spread, launch in batches with different account ids.) ANNOUNCE the choice to the owner per the persona spawn-disclosure rule.',
      ),
    workspace: z
      .string()
      .optional()
      .describe(
        "psu --workspace: the workspace the fleet + every member launch under. Defaults to the launch session's workspace.",
      ),
    role: z
      .string()
      .optional()
      .describe('psu --role: the su role each member runs as (default the standard su collaborator).'),
    stack: z
      .array(z.string().min(1))
      .max(40)
      .optional()
      .describe('Repeatable psu --stack `slot:id` bindings for every member; members[].stack overrides this list.'),
    model: fuzzyEnumAsync(localModelIdsAsync, {
      applies: isOmpLocalModel,
      // A leader passes the PROVIDER-PREFIXED spec (ollama-cc/…); the backend registry stores the
      // BARE id — normalize both so a valid prefixed ornith model is never false-rejected.
      normalize: (v) => v.replace(/^ollama(-cc)?\//i, ''),
      label: 'local model',
    })
      // Defense-in-depth (WI-1993): the fuzzyEnum above only validates LOCAL models (applies:
      // isOmpLocalModel). A malformed CLOUD spec — a hand-typed `[1m]` marker (`fabel5[1m]`, the
      // WI-1979 incident) or a typo'd alias — would otherwise pass the tool's zod and open N desktop
      // windows that each die at psu boot with no useful hint. Mirror psu-launcher's validateModelSpec
      // at the TOOL BOUNDARY so the leader's call fails cleanly, BEFORE any window opens. Local/ornith
      // specs return ok:true here (fuzzyEnum owns those); the check is deliberately lenient on the open
      // cloud id set — it only rejects the unambiguous malformed classes (incl. the `sonnet-5`
      // versioned-shorthand leak, the most common agent typo).
      .superRefine((value, ctx) => {
        const v = validateCloudModelSpec(value);
        if (!v.ok) {
          ctx.addIssue({
            code: 'custom',
            message: v.message ?? 'invalid model spec',
            params: { cloudModelSpec: true, got: value },
          });
        }
      })
      .optional()
      .describe(
        'psu --model: a per-member model spec, e.g. "opus:high" (default the role/tier default). A ' +
          'LOCAL/gateway model (ollama-cc/…, ornith) is fuzzy-validated against the registered local ' +
          'backends — an invalid id returns the nearest registered model + the allowed list (generic-' +
          'tool-arg-fuzzy-validation). A non-local (claude/codex) alias is the open set — full ids pass, ' +
          'but a malformed alias (a versioned shorthand like `sonnet-5`, or a typo) is caught + corrected.',
      ),
    effort: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        'Reasoning effort for EVERY member (low|medium|high|xhigh|max) — composed onto the model spec (`<model>:<effort>`); use `members[].effort` for a per-member override.',
      ),
    feature: z.string().optional().describe('psu --feature: a feature id each member should pick up.'),
    brief: z
      .string()
      .min(1)
      .max(8000)
      .optional()
      .describe(
        'Shared inline first-turn brief for every member. Unlike `launchContext`, this is always treated as text, never as a file path; it is layered below the universal member baseline.',
      ),
    launchContext: z
      .string()
      .optional()
      .describe(
        "psu --launch-context: PATH to a brief/markdown file injected as EVERY member's launch context (shared) — or, if the value contains a newline or is too long to plausibly be a filename, the brief TEXT itself (composed straight into the generated launch-context file; no read attempted). Use `perMemberLaunchContext` instead when different members need DISTINCT briefs.",
      ),
    perMemberLaunchContext: z
      .array(z.string())
      .optional()
      .describe(
        'Per-member brief paths, index-aligned to member number (entry 0 → member 1, …) — each member gets its OWN composed context. Fewer entries than members opened ⇒ the rest fall back to `launchContext`/baseline, never an error.',
      ),
    members: z
      .array(memberSpecSchema)
      .optional()
      .describe(
        'DECLARATIVE per-member config, index-aligned to member number (entry 0 → member 1, …). Each set field OVERRIDES the fleet-wide arg for THAT member only; an unset field falls through to the fleet arg, then the system default. Fewer entries than members opened ⇒ the rest use the flat fleet-wide args, never an error. This generalizes `perMemberLaunchContext` (brief-only) to every setting — use it to run one fleet where members differ in model/effort/account/limit/lane.',
      ),
    profile: z.string().optional().describe('psu --profile: launch profile name for each member.'),
    contextSize: z
      .enum(['trimmed', 'steward'])
      .optional()
      .describe(
        "psu --context-size for EVERY member. 'trimmed' seeds the growable core tool surface; 'steward' (WI-2140338, explicit opt-in) adds the steward verb families for goal-holder/steward lanes. Both stay growable — tools:find/tools:invoke retain reachability to the full catalog.",
      ),
    compactionLimit: z
      .number()
      .int()
      .min(20_000)
      .max(900_000)
      .optional()
      .describe(
        'psu --compaction-limit for EVERY member. A persisted fleet headcount profile reuses this value for launch, respawn, and governor restoration instead of reconstructing it per wave.',
      ),
    brain: z.boolean().optional().describe('psu --brain: launch each member in brain mode.'),
    addDir: z
      .array(z.string())
      .optional()
      .describe("psu --add-dir (repeatable): extra directories added to each member's workspace."),
    allowSubagents: z
      .boolean()
      .optional()
      .describe(
        "psu --allow-subagents (default OFF): opt every member's su session back IN to its own built-in subagent-launch (Task/Agent) tool. Subagents are DENIED BY DEFAULT for every psu launch (owner mandate 2026-07-02), so members CANNOT fan out unless this is true.",
      ),
    fromSeats: z
      .boolean()
      .optional()
      .describe(
        "P-005 launch-from-seats (agent-allocation-framework): spawn members that CONSUME the fleet's delegated agent_slot seats (resource:delegate / the /res Agent-seats group). The slot pins model+effort+account (D-002/D-003) — so `model`/`account` must be OMITTED — and the seat COUNT cap is enforced (count > free seats is refused; the N+1th spawn is refused at boot too). Implied by `seat`.",
      ),
    seat: z
      .string()
      .optional()
      .describe(
        "Which delegated slot template to launch from, as its ref '<model>:<effort>:<account>' (e.g. 'opus:xhigh:AUTO'). Required only when the fleet has MORE THAN ONE delegated template; a single template is picked automatically with `fromSeats: true`.",
      ),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe(
        'Escape hatch for any other psu flag: each element is one full token (e.g. ["--yes", "--add-dir=/x"]), appended verbatim to every member\'s psu launch — covers psu args without a first-class field above.',
      ),
    display: z
      .string()
      .optional()
      .describe(
        "WI-4272 (demo/recording): open EVERY member terminal on this X display (e.g. ':110' — a computer:provision_desktop sandbox stage being recorded) instead of the owner's desktop seat. Linux only; requires a DISPLAY-honoring emulator (xterm/alacritty/kitty/wezterm) and the display's X socket to be alive (loud-fail otherwise). Ignored for `headless: true` (headless members have no window). Omit for normal visible-desktop use.",
      ),
    claimKinds: z
      .array(z.enum(['feature', 'chunk', 'bug', 'change', 'task']))
      .min(1)
      .max(5)
      .optional()
      .describe(
        "EI-7671: restrict every member's scheduler:get_next self-pull to these work-item kinds — e.g. " +
          '["bug","change","task"] for a bugs-only backlog-drain fleet. Sets a FLEET-level claim spec ' +
          'BEFORE any member terminal opens, closing the boot-race where members start pulling under the ' +
          'empty-filter DEFAULT_CLAIM_SPEC (which admits every kind, including feature/chunk) before the ' +
          "leader gets around to calling scheduler:set_claim_spec by hand. A member's own later per-bee " +
          'spec still overrides this fleet default. Omit to leave scheduling exactly as before (no spec set).',
      ),
    confirmClaimCollapse: z
      .boolean()
      .optional()
      .describe(
        "P-010 pool-collapse override: a `claimKinds` fleet is REFUSED at launch (BEFORE any terminal opens) when its kind-scoped claim spec matches 0 rows of a nonempty claimable pool — the silent bug-drain starvation shape (WI-5212/EI-11300). Pass true ONLY after reading the refusal's reported counts and confirming the empty lane is intended (e.g. a pre-staged fleet whose items are not promoted yet). Ignored when no `claimKinds` is given.",
      ),
    confirmKickoffMismatch: z
      .boolean()
      .optional()
      .describe(
        'EI-18862608742257943 override: the launch is REFUSED (BEFORE any terminal opens, LOCAL placement only) when a WI-/EI- id referenced in `launchContext` / `perMemberLaunchContext` / `members[].brief` does not match the fleet claim spec this launch is about to apply — a member kicked off with "your only job is WI-xxxx" that cannot then claim WI-xxxx (assignee stays NULL, presence shows it holding nothing, the death-resilience net never engages). Pass true to launch anyway (e.g. the brief only MENTIONS the id for context, or you will widen the spec by hand right after); otherwise fix the claimKinds/plan scope or drop the id from the brief.',
      ),
  }),
  async handler(args, ctx) {
    // Resolved FIRST, ahead of the option branch (P-006): the goal's launch
    // settings can supply `fleetType` and the per-role profiles, and reading them
    // needs the caller's workspace + owner id. All three resolvers below are
    // synchronous and free of side effects — an identity read off ctx, the
    // workspace fallback, and a slug derived from the name — so hoisting them
    // changes nothing except when they are available.
    const { identity, ownerId, workspaceId: callerWs } = resolveFleetCaller(ctx);
    // An explicit `workspace` arg (psu --workspace) scopes the fleet + envelope + every
    // member; otherwise the launch session's workspace (never the '*' wildcard).
    const workspaceId = args.workspace?.trim() || (callerWs && callerWs !== '*' ? callerWs : activeWorkspaceId());
    const fleetSlug = fleetSlugFromName(args.name);
    const requestedPlan = args.plan?.trim() || null;
    const claimSpecWorkspaceId = resolveClaimSpecWorkspace(workspaceId);

    // EI-21577352340987493: an existing fleet's live claim spec is the lane its
    // members are actually draining. Read it before the saved headcount profile
    // can inherit a stale plan, so an omitted top-up stays on the fleet's current
    // lane instead of re-running admission against an unrelated plan (or failing
    // the no-plan lane check before the fleet is even joined).
    let existingFleet: Awaited<ReturnType<typeof getFleet>> = null;
    let existingFleetClaimSpec: ClaimSpec | null = null;
    try {
      existingFleet = await getFleet(workspaceId, fleetSlug);
    } catch {
      existingFleet = null;
    }
    if (existingFleet && claimSpecWorkspaceId) {
      try {
        const liveSpec = await getClaimSpec({
          cupId: fleetSpecBeeKey(fleetSlug),
          workspaceId: claimSpecWorkspaceId,
        });
        if (liveSpec) existingFleetClaimSpec = liveSpec;
      } catch {
        existingFleetClaimSpec = null;
      }
    }
    const existingFleetHasLiveClaimLane = Boolean(
      existingFleet && existingFleetClaimSpec && existingFleetClaimSpec.specId !== DEFAULT_CLAIM_SPEC.specId,
    );

    // P-006 / D-004: the goal's SETTINGS ONLY — no ceilings, no budget gate, no
    // side effects. The ceiling-bearing `resolveGoalLaunch` still runs exactly
    // ONCE, far below, with the post-capacity-clamp `openCount`. It cannot be
    // reused here because that count does not exist yet: calling it now would
    // check the ceilings against a provisional number and could fire the
    // per-goal budget escalation for a launch that is never attempted.
    const goalSettings = await readGoalLaunchSettingsForLauncher({
      workspaceId,
      launcherOwnerId: ownerId,
    });
    const goalOverlay = goalFleetLaunchOverlay({
      goalId: goalSettings.goalId,
      settings: goalSettings.settings,
      fleetSlug,
      drainFleetSlug: goalSettings.drainFleetSlug,
      callerType: args.type,
    });
    // Goal provenance is inherited by execution agents. Only the caller's OWN
    // GOAL mode marks the portfolio steward; using goalSettings.goalId here
    // prevents delegated leaders from launching or topping up their own fleet.
    let goalHolderSubject: string | null = null;
    if (goalSettings.goalId) {
      try {
        goalHolderSubject = await getModeSubject(workspaceId, ownerId, 'goal');
      } catch (error) {
        return err(`goal_holder_role_unreadable: could not resolve launcher role before fleet mutation: ${String(error)}`);
      }
    }
    const goalLeadership = resolveGoalFleetLeadership({
      goalHolderSubject,
      requested: args.leader,
      callerOwnerId: ownerId,
      existingLeaderOwnerId: existingFleet?.leaderOwnerId ?? null,
    });
    if (!goalLeadership.ok) return err(goalLeadership.message);
    // The generic fleet door remains caller-led by default. GOAL context is the
    // deliberate exception: the portfolio steward delegates leadership even
    // when it omitted the easily-missed `leader` argument.
    args.leader = goalLeadership.leader;

    // D-009 / P-011: branch the option shape on the declared type BEFORE any
    // other work. A shape mismatch is a caller error that costs nothing to
    // detect and everything to discover late — after terminals have opened on
    // the wrong per-role settings there is no cheap undo.
    const launchOptions = resolveLaunchOptions(
      applyGoalLaunchOverlay(
        {
          type: args.type,
          count: args.count,
          agent: args.agent,
          model: args.model,
          effort: args.effort,
          headless: args.headless,
          account: args.account,
          carry: args.carry,
          directors: args.directors,
          implementers: args.implementers,
        },
        goalOverlay,
      ),
    );
    if (!launchOptions.ok) {
      // D-006: when the GOAL is what made this launch paired, the stock refusal
      // ("type:'paired' was declared") names the wrong author — the caller may
      // have passed no `type` at all. Say who actually chose it.
      return err(launchOptions.message + goalPairedTypeNote(goalOverlay));
    }
    // A goal knob that this launch shape cannot deliver is REPORTED, never
    // dropped in silence: an owner who set it is entitled to know it did not
    // bind, which is the whole complaint behind D-016/WI-38048. These ride out
    // on the launch result beside the paired announcement.
    const goalLaunchNotes: string[] = goalOverlay.unbindable.map(
      (u) =>
        `⚠ goal ${goalOverlay.goalId} pins \`${u.knob}\` on slot \`${u.slot}\`, which this paired ` +
        `launch cannot bind: ${u.why}.`,
    );
    if (goalLeadership.defaultedToSpawn) {
      goalLaunchNotes.push(
        `goal ${goalOverlay.goalId} plan-fleet leadership defaulted to \`leader:'spawn'\` — ` +
          'the GOAL holder remains outside the fleet as portfolio steward',
      );
    }
    if (goalOverlay.goalId && goalOverlay.pinned) {
      goalLaunchNotes.push(
        goalOverlay.slots.type === 'paired'
          ? `goal ${goalOverlay.goalId} launch profile applied — slots \`${goalOverlay.slots.director}\` / ` +
              `\`${goalOverlay.slots.implementer}\`${goalOverlay.typeSource === 'goal' ? " (fleetType:'paired' from the goal)" : ''}`
          : `goal ${goalOverlay.goalId} launch profile applied — slot \`${goalOverlay.slots.member}\``,
      );
    }
    // Provisional: the AUTHORITATIVE type is re-read off the registry row after
    // createFleetIfAbsent, because a top-up joins an existing fleet whose stored
    // type wins over whatever this call asked for.
    let launchFleetType: FleetType = launchOptions.type;

    // D-014 / P-011: a paired launch is expressed as the EXISTING per-member
    // override list, not a second member-command path. Two translations happen
    // here and nowhere else:
    //
    //   1. `count` means PAIRS on this arm (D-012), so the fleet TARGET is
    //      pairs*2 seats. Everything downstream — the capacity clamp, the
    //      headcount governor and deficit math — keeps treating
    //      `args.count` as a seat target and needs no paired-awareness at all.
    //   2. Each seat's role slice becomes a `members[]` entry, so the fold, the
    //      launch-context composition and the attestation records all apply
    //      unchanged.
    //
    // Done BEFORE resolveSavedFleetLaunchSpec so the saved-spec round trip sees
    // the same effective inputs the governor and command composer will.
    let pairedAnnouncement: string[] | null = null;
    if (launchOptions.type === 'paired') {
      if (args.members?.length) {
        return err(
          "`members` cannot be combined with type:'paired': the per-member override list IS how the " +
            'director/implementer split is expressed, so supplying your own would silently overwrite one ' +
            'half of every pair. Configure the roles with directors:{…} / implementers:{…} instead.',
        );
      }
      const pairs = launchOptions.pairs ?? 1;
      const seats = wholePairSeats(pairs * 2);
      if (seats < 2) {
        return err(
          `count:${pairs} does not open a whole pair. A paired fleet is 1:1, so count is the number of PAIRS ` +
            '(count:1 opens 1 director + 1 implementer = 2 members). Pass count >= 1.',
        );
      }
      args.count = seats;
      args.members = expandPairedMembers(launchOptions, seats) as typeof args.members;
      pairedAnnouncement = describeLaunchRoles(launchOptions);
    }

    // (identity / ownerId / workspaceId / fleetSlug are resolved at the top of
    // this handler — P-006 hoisted them above the option branch so the goal's
    // launch settings could be read before the fleet shape is decided.)
    // D-008 (WI-40321): the headcount target is also the fleet's durable,
    // homogeneous launch profile. A later launch/top-up supplies only the fleet
    // name and any deliberate overrides; omitted values come from this one row.
    // Read it before resolving agent/model/plan so every downstream validation
    // and command composer sees the same effective inputs as the governor.
    const savedLaunchSpec = await resolveSavedFleetLaunchSpec({
      workspaceId,
      fleetSlug,
      requested: {
        plan: args.plan,
        harness: args.harness,
        agent: args.agent,
        model: args.model,
        effort: args.effort,
        account: args.account,
        headless: args.headless,
        carry: args.carry,
        role: args.role,
        brief: args.brief,
        launchContext: args.launchContext,
        contextSize: args.contextSize,
        compactionLimit: args.compactionLimit,
        extraArgs: args.extraArgs,
        members: args.members,
        perMemberLaunchContext: args.perMemberLaunchContext,
        claimKinds: args.claimKinds,
        addDir: args.addDir,
        allowSubagents: args.allowSubagents,
        brain: args.brain,
        feature: args.feature,
        profile: args.profile,
        display: args.display,
      },
      reusePath: 'fleet:launch-on-plan -> agent-launch-core.memberLaunchCommand',
    });
    if (!savedLaunchSpec.ok) {
      return err(
        `${savedLaunchSpec.message} Existing-fleet top-up/takeover may vary only count and host placement. ` +
          'Use fleet:respawn-member for an explicit audited per-member boot-setting change.',
      );
    }

    // EI-21304203620302419: a caller-led launch changes the caller's durable
    // membership below.  The recovered incident had an agent leading BYOC call
    // this tool for a brand-new observability fleet; that silently abandoned the
    // selected route and, because the new slug had no saved profile, also lost
    // BYOC's headless launch setting.  Refuse before promotion/fleet creation.
    let priorFleetMembership: { fleetSlug: string | null; fleetRole: string | null } | null = null;
    try {
      priorFleetMembership = (await fetchPresenceFleet([ownerId])).get(ownerId) ?? null;
    } catch {
      priorFleetMembership = null; // a presence read outage must not fabricate a route
    }
    const routeSwitch = fleetRouteSwitchConflict({
      currentFleet: priorFleetMembership?.fleetSlug,
      currentRole: priorFleetMembership?.fleetRole,
      targetFleet: fleetSlug,
      leader: args.leader,
      confirmRouteSwitch: args.confirmRouteSwitch,
    });
    if (routeSwitch) {
      return json(
        {
          ok: false,
          error: 'fleet_route_switch_refused',
          ...routeSwitch,
          message:
            `Caller is already enrolled in fleet \`${routeSwitch.currentFleet}\`` +
            `${routeSwitch.currentRole ? ` as ${routeSwitch.currentRole}` : ''}; a caller-led launch into ` +
            `\`${routeSwitch.targetFleet}\` would silently switch routes. Target the current fleet to reuse its ` +
            "saved launch spec, use `leader:'spawn'` so the caller stays put, or pass " +
            '`confirmRouteSwitch:true` only for a deliberate route change.',
        },
        true,
      );
    }

    if (
      requiresExplicitUnprofiledVisibility({
        savedSpecFound: savedLaunchSpec.found,
        placement: args.placement,
        headless: args.headless,
        count: args.count,
        members: args.members,
      })
    ) {
      return json(
        {
          ok: false,
          error: 'unprofiled_visibility_required',
          fleet: fleetSlug,
          message:
            `No saved launch spec exists for fleet \`${fleetSlug}\`. Pass \`headless:true\` or ` +
            '`headless:false` explicitly (or set every `members[].headless` value for a mixed fleet) ' +
            'instead of silently defaulting to visible desktop windows. If an existing fleet profile is the ' +
            'authority, target that fleet slug; launch specs are fleet-scoped and are never inferred from another fleet.',
        },
        true,
      );
    }
    let persistedHeadcountProfile = savedLaunchSpec.found
      ? { target: savedLaunchSpec.target, config: savedLaunchSpec.config }
      : null;
    let ignoredRoleDiagnostics: IgnoredPersistedGoalRoleDiagnostic[] = [];
    if (persistedHeadcountProfile) {
      persistedHeadcountProfile = {
        ...persistedHeadcountProfile,
        config: normalizePersistedFleetLaunchConfig(persistedHeadcountProfile.config),
      };
      const profile = persistedHeadcountProfile.config;
      const profileModel = composeModelSpec(profile.model, profile.effort);
      args.count ??= persistedHeadcountProfile.target;
      // An omitted plan on an existing fleet is intentional: its live claim spec
      // is the authority. Inheriting the profile's plan here can resurrect a stale
      // lane and make exact-plan admission reject a valid top-up. New fleets and
      // explicit plan requests retain the established profile behavior.
      if (!existingFleet || requestedPlan) args.plan ??= profile.plan;
      args.harness ??= profile.harness;
      args.agent ??= profile.agent;
      args.model ??= profileModel;
      args.account ??= profile.account;
      args.headless ??= profile.headless ?? true;
      args.carry ??= profile.carry;
      // A persisted homogeneous profile may predate D-016 and contain the
      // GOAL's launch slot in `role`. That value is not a psu persona and must
      // never reach role-prompt preflight or the member command. Explicit
      // caller input remains authoritative, including an explicit invalid role.
      if (args.role === undefined) {
        const roleResolution = sanitizePersistedGoalLaunchRole({ persistedRole: profile.role });
        args.role = roleResolution.role;
        ignoredRoleDiagnostics = roleResolution.ignoredRoles;
      }
      args.brief ??= profile.brief;
      args.launchContext ??= profile.launchContext;
      args.contextSize ??= profile.contextSize;
      args.compactionLimit ??= profile.compactionLimit;
      args.extraArgs ??= profile.extraArgs;
    }
    // DRAIN is a durable caller overlay, not a fleet argument. Read the mode row and
    // its owner-scoped instruction fact once, then thread the bounded result through
    // every member/leader composer below so no launch path silently drops the mode.
    const launchMode = await readCallerLaunchMode(workspaceId, ownerId);
    // `agent` and `model` are COUPLED: a local/gateway model (ollama-cc/…ornith) only runs on
    // the omp backend. Infer omp from such a model when agent is unspecified, and reject an
    // explicit claude/codex pairing outright — otherwise psu launches that backend with an
    // unrunnable --model and the fleet-status (which shows model, not agent) reads as ornith
    // while the members are really claude (the 2026-07-03 "thought ornith, got claude" bug).
    // `agent` + `model` resolution: explicit arg → omp (inferred from a local model) → the CURRENT
    // calling agent's backend (ctx.callerAgent, stamped by psu into the MCP URL) → claude. Also
    // inherits the caller's model when the backend is inherited, so an omp/ornith leader that omits
    // both spawns omp + ornith members — not the historical claude default (the 2026-07-03 leak).
    const callerAgent = (ctx as { callerAgent?: string | null }).callerAgent ?? null;
    const callerModel = (ctx as { callerModel?: string | null }).callerModel ?? null;
    const agentResolution = resolveFleetAgent({
      argAgent: args.agent,
      argModel: args.model,
      callerAgent,
      callerModel,
    });
    if ('error' in agentResolution) return err(agentResolution.error);
    const { agent, model: memberModel, modelSource: memberModelSource } = agentResolution;
    const count = args.count ?? 1;
    const goalAllocation = goalOverlay.goalId
      ? {
          goalId: goalOverlay.goalId,
          // P-020: intention comes from the live goal settings, never from a ceiling.
          intendedParallelPlanFleets: goalSettings.settings?.intendedParallelPlanFleets ?? null,
        }
      : null;
    if (goalAllocation?.intendedParallelPlanFleets == null) {
      if (goalAllocation) goalLaunchNotes.push(
        `goal ${goalAllocation.goalId} has no intendedParallelPlanFleets decision in live launch settings; set it from the portfolio before treating a ceiling as the desired width.`,
      );
    }

    // P-003: `plan` is optional. A pure claim-spec fleet launches with no plan — its
    // members self-pull by `claimKinds`, so require a lane when no plan is given (else
    // the fleet would drain the whole harness backlog under the empty DEFAULT_CLAIM_SPEC).
    const planSlug = args.plan?.trim() || null;
    if (!planSlug && !args.claimKinds?.length && !existingFleetHasLiveClaimLane) {
      return err(
        'Give the fleet a lane: pass a `plan` (members self-pull that plan\'s items) OR `claimKinds` for a pure claim-spec fleet (e.g. claimKinds:["bug"]). Without either, members would drain the entire harness backlog under the default claim spec.',
      );
    }

    // P-005 launch-from-seats: the delegated slot pins model+effort+account (D-002/
    // D-003) — an explicit model/account alongside it would silently contradict the
    // delegation, so refuse the combination outright.
    const seatsRequested = Boolean(args.fromSeats || args.seat?.trim());
    if (seatsRequested) {
      if (args.model || args.account) {
        return err(
          'launch-from-seats derives model+effort+account FROM the delegated slot (D-002/D-003) — drop the explicit `model`/`account` args; pass `seat` to pick a template when several are delegated.',
        );
      }
      // P-004: a per-member MemberSpec that pins model/effort/account contradicts the slot
      // just as loudly as the flat args do — the seat, not the member, decides those under
      // launch-from-seats (a seat-launched fleet is homogeneous in model/account by design).
      // Reject it here rather than silently letting foldMemberSpec override the seat pin.
      const badMemberIdx = (args.members ?? []).findIndex((m) => m?.model || m?.effort || m?.account);
      if (badMemberIdx >= 0) {
        return err(
          `launch-from-seats derives model+effort+account FROM the delegated slot (D-002/D-003), so members[${badMemberIdx}]'s ` +
            '`model`/`effort`/`account` would silently contradict the seat pin — drop them (a seat-launched fleet is homogeneous ' +
            'in model/account; use `seat` to pick a template when several are delegated).',
        );
      }
    }

    // WI-5211 cross-machine placement: the honoring hosts own the spawn shape, so
    // every local-shape arg is refused loudly rather than silently dropped.
    const remotePlacement = args.placement === 'remote';
    if (remotePlacement) {
      const unsupported = remotePlacementUnsupportedArgs(args as Record<string, unknown>);
      if (unsupported.length) {
        return err(
          `placement:'remote' spawns on the honoring machines — each delegated slot pins model+effort+account and the host owns the window/carry shape, so these args have no effect there and are refused: ${unsupported.join(
            ', ',
          )}. Drop them (name/plan/count/launchContext/claimKinds still apply).`,
        );
      }
      // P-003: the pure-claim-spec (no-plan) fleet is a LOCAL feature. Remote members
      // pull work-items under their OWN machine's claim spec (the claim spec set here is
      // machine-local — claimKinds does NOT federate), and the signed spawn-request carries
      // a required planSlug, so a remote placement without a plan has no lane. Require one.
      if (!planSlug) {
        return err(
          "placement:'remote' requires a `plan`: remote members pull under their own machine's claim spec (claimKinds does not federate), so a plan is the only lane that reaches them. Launch a pure claim-spec fleet LOCALLY (drop `placement:'remote'`), or pass a `plan`.",
        );
      }
    }

    // Harness scope: explicit arg, else the session's scope (never the '*' wildcard).
    const ctxSlug = (ctx as { harnessSlug?: string | null }).harnessSlug;
    const harness = args.harness?.trim() || (ctxSlug && ctxSlug !== '*' ? ctxSlug : null);
    if (!harness) {
      return err(
        'No harness for the plan. Pass `harness: "<slug>"` (the harness the plan belongs to) — this session is not harness-scoped.',
      );
    }
    // workspace-work-scope-policy-2026-09-04 P-005: a fleet on a plan in a harness the
    // workspace policy excludes is refused at the door (parked, never deleted).
    {
      const { gateWorkScope } = await import('../../work-scope-policy');
      const scope = await gateWorkScope('fleet:launch-on-plan', { harness, plan: args.plan ?? null, actor: (ctx as { ownerId?: string }).ownerId ?? null });
      if (!scope.allowed) return err(scope.message);
    }

    // Validate the plan exists before opening any windows (fail clean, not N dead members).
    // Hoist the resolved harness/workspace so the promotion failsafe below reuses them.
    let planHarnessSlug = harness;
    let planWorkspaceId = workspaceId;
    let planRow: Parameters<typeof startVerdictForRow>[0] | null = null;
    try {
      const resolved = await resolveHarnessPlansDir(harness, { workspaceId });
      planHarnessSlug = resolved.harnessSlug;
      planWorkspaceId = resolved.workspaceId;
      // P-003: only a plan-scoped launch validates a plan exists; a pure claim-spec
      // fleet (no plan) skips this — there is nothing to look up.
      if (planSlug) {
        const found = await readPlanBySlug(planSlug, {
          harnessSlug: resolved.harnessSlug,
          workspaceId: resolved.workspaceId,
        });
        if (!found) {
          return err(
            `Plan \`${planSlug}\` not found in harness \`${harness}\`. Create it first (plans:apply-plan-block / plans:new + plans:add-item), then launch the fleet.`,
          );
        }
        planRow = found.row;
      }
    } catch (e: any) {
      return err(
        `Could not resolve ${planSlug ? `plan \`${planSlug}\`` : `harness \`${harness}\``}: ${e?.message ?? e}`,
      );
    }

    // EI-22180799091614070 / WI-1984709: a GOAL holder owns only its own
    // active-owner pots plus the genuinely unowned frontier. A contributing
    // goal may observe and route work for another active goal's pot, but it
    // must never open a second plan fleet there. Resolve this from goal_pots ×
    // goals.status, not goal_pots alone: terminal goals intentionally retain
    // their relationship rows, and treating a killed owner as active would
    // permanently fence WOE out of papercusp itself.
    //
    // This sits after canonical harness resolution but before the plan start
    // gate, promotion failsafe, fleet registry writes, launch-slot mutation,
    // or terminal spawn. Authority read failures fail CLOSED at this mutation
    // door; a degraded read must not silently become cross-goal placement.
    if (goalSettings.goalId) {
      let placementAuthority: Awaited<ReturnType<typeof resolveGoalPotPlacementAuthority>>;
      try {
        placementAuthority = await resolveGoalPotPlacementAuthority({
          workspaceId,
          launcherGoalId: goalSettings.goalId,
          harnessSlug: planHarnessSlug,
        });
      } catch (e: any) {
        return err(
          `goal_placement_sovereignty_unreadable: could not verify whether GOAL \`${goalSettings.goalId}\` may ` +
            `launch into harness \`${planHarnessSlug}\`: ${e?.message ?? e}. NO fleet was created and NO terminals were opened.`,
        );
      }
      if (!placementAuthority.allowed) {
        const ownerTitle = placementAuthority.ownerGoalTitle ? ` (\`${placementAuthority.ownerGoalTitle}\`)` : '';
        return err(
          `goal_placement_sovereignty_refusal: GOAL \`${goalSettings.goalId}\` cannot launch into harness ` +
            `\`${planHarnessSlug}\` because active goal \`${placementAuthority.ownerGoalId}\`${ownerTitle} owns that pot. ` +
            "Route the finding/work to that goal's holder or drain leader instead. NO fleet was created and NO terminals were opened.",
        );
      }
    }

    // P-006 start gate, checked HERE for the same reason the existence check is
    // above: before any window opens. A fleet launched on an under-specified plan
    // would otherwise put N members to work and have each of them independently
    // discover mid-task that the plan has no target — N failures for one missing
    // argument, and N sessions to clean up.
    //
    // Deliberately OUTSIDE the resolution try/catch above. This gate does no IO, so
    // nothing it throws is a resolution failure — but while it lived inside, any
    // defect here was relabelled `Could not resolve plan ...`, which is simply false
    // and sends the reader after the plan store / database instead of the real cause.
    // That is not hypothetical: a stub whose shape predated this gate made
    // `found.row` undefined, and the resulting TypeError was reported as a
    // resolution failure in 40 tests at once (EI-19310192267009629).
    // Existing-fleet top-ups are enrollment into an already-running fleet, not a
    // second attempt to start the plan. The fleet's persisted claim spec/profile
    // is authoritative for that wave; re-entering checkPlanStartable here would
    // re-read the plan's BAR contract and can refuse a valid top-up with a stale
    // or unrelated bar_snapshot_* result. New fleets still take the full start
    // gate before any fleet/terminal mutation.
    if (planSlug && planRow && !existingFleet) {
      let gate: Awaited<ReturnType<typeof checkPlanStartable>>;
      try {
        gate = await checkPlanStartable(
          planSlug,
          {
            workspaceId: planRow.workspaceId,
            harnessSlug: planRow.harnessSlug,
          },
          null,
          'fleet-launch',
        );
      } catch (e: any) {
        // Name the component that actually failed. Anything thrown here is a
        // defect in the start gate itself, NOT a plan-resolution problem — say
        // so, so the reader looks at the gate instead of at the plan store.
        return err(
          `Plan start gate failed for \`${planSlug}\` — this is a defect in the start gate, ` +
            `not a plan-resolution problem: ${e?.message ?? e}`,
        );
      }
      if (!gate.ok) {
        // Two different refusals reach here, and they send the reader to different
        // places: an inputs refusal is repaired in the plan document, a P-004
        // admission refusal is repaired by ratifying the revision under the pot's
        // governance policy. Reporting either as the other wastes the whole trip.
        if (gate.kind === 'admission') {
          return err(
            `Plan \`${planSlug}\` is not admitted to run (${gate.refusal.code}): ${gate.refusal.hint}` +
              ` [revision ${gate.refusal.planRevisionHash || 'unknown'}, policy epoch ${gate.refusal.policyVersion}]`,
          );
        }
        return err(
          `Plan \`${planSlug}\` cannot start: ${gate.refusal.hint}` +
            (gate.refusal.missing.length > 0 ? ` (missing: ${gate.refusal.missing.join(', ')})` : ''),
        );
      }
    }

    // shared-agent-obligations P-006 / A-04: this is the normalized GOAL
    // placement mutation boundary. The generic launch policy above establishes
    // that this caller is the actual GOAL holder and has delegated leadership;
    // now re-read the provider that chose WHICH plan/fleet operation is due.
    // This sits after omitted plan/harness/leader values have resolved, but
    // before role preflight, promotion, fleet registry writes, launch-slot
    // mutation, or terminal spawn. A stale turn brief is never authority.
    if (goalSettings.goalId && goalHolderSubject) {
      try {
        const { readAgentObligationAgenda } = await import('../../agent-obligation-reader');
        const read = await readAgentObligationAgenda({
          workspaceId,
          ownerId,
          goalId: goalHolderSubject,
          // Placement is the only boundary being checked here. Avoid unrelated
          // acceptance reads while retaining the same provider/source assembly.
          planSlugs: [],
          fleetSlug,
          launchCount: count,
        });
        const placement = read.agenda.evaluations.find((entry) => entry.family === 'plan-placement');
        const readAgeMs = Date.now() - Date.parse(read.observedAt);
        const scopeMatches =
          read.goalId === goalHolderSubject &&
          placement?.scope.workspaceId === workspaceId &&
          placement.scope.ownerId === ownerId &&
          placement.scope.goalId === goalHolderSubject &&
          placement.responsibleOwnerId === ownerId;
        const currentProviderEvidence =
          placement?.status === 'unknown' ||
          (Boolean(placement?.sourceGeneration?.trim()) &&
            placement!.evidence.every((item) => item.freshness === 'current'));
        if (
          !placement ||
          !scopeMatches ||
          !Number.isFinite(readAgeMs) ||
          readAgeMs < 0 ||
          readAgeMs > 30_000 ||
          !currentProviderEvidence
        ) {
          return json(
            {
              ok: false,
              error: 'goal-plan-placement-prerequisite',
              goalId: goalHolderSubject,
              message:
                `The live GOAL plan-placement provider returned stale, missing, or wrong-scope evidence for ` +
                `\`${goalHolderSubject}\`; no fleet was created and no terminals were opened. ` +
                'Refresh the canonical goal portfolio/placement cohort and retry the provider-selected recovery action.',
              observed: {
                readGoalId: read.goalId,
                readAt: read.observedAt,
                sourceGeneration: placement?.sourceGeneration ?? null,
                obligationScope: placement?.scope ?? null,
                responsibleOwnerId: placement?.responsibleOwnerId ?? null,
                evidenceFreshness: placement?.evidence.map((item) => item.freshness) ?? [],
              },
            },
            true,
          );
        }

        const verdict = evaluateAgentObligationRecoveryBoundary({
          obligation: placement,
          boundary: 'fleet:launch-on-plan',
          phase: 'operation',
          operation: {
            tool: 'fleet:launch-on-plan',
            args: {
              name: fleetSlug,
              plan: planSlug,
              harness: planHarnessSlug,
              leader: args.leader,
              // The plan-placement provider's canonical recovery is headless.
              // For paired launches the expanded member list is the effective
              // visibility source; any visible seat makes the operation differ.
              headless:
                args.headless ?? !(args.members ?? []).slice(0, count).some((member) => member?.headless === false),
              count,
            },
          },
        });
        if (!verdict.allowed) {
          return json(
            {
              ok: false,
              error: verdict.code ?? 'goal-plan-placement-prerequisite',
              goalId: goalHolderSubject,
              sourceGeneration: placement.sourceGeneration,
              reason: verdict.reason,
              evidenceRefs: verdict.evidenceRefs,
              recovery: verdict.recovery ?? null,
              message:
                `${verdict.reason} No fleet was created and no terminals were opened. ` +
                'Run the returned provider recovery action exactly; count/model/account remain your resource decision.',
            },
            true,
          );
        }
        if (verdict.warning) {
          goalLaunchNotes.push(
            `⚠ GOAL plan-placement evidence is unknown; the provider policy allows launch with warning: ${verdict.reason}`,
          );
        }
      } catch (error) {
        // The provider's declared unknown policy is allow-with-warning, matching
        // resolveGoalLaunch's existing measurement stance. Preserve repair and
        // diagnostic availability; the later post-capacity ceiling check still
        // runs before a terminal opens.
        goalLaunchNotes.push(
          `⚠ GOAL plan-placement prerequisite could not be re-read; proceeding under its allow-with-warning policy (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    // EI-21014432394938679: validate optional role selectors BEFORE promotion,
    // fleet creation, launch-slot mutation, or any terminal spawn. The psu child
    // uses this exact assembler on the role path; running it here turns a late
    // dead-window failure into a synchronous, side-effect-free tool refusal.
    try {
      const roleError = await unresolvedFleetMemberRole({
        harness: planHarnessSlug,
        workspaceId: planWorkspaceId,
        count,
        role: args.role,
        members: args.members,
      });
      if (roleError) return err(roleError);
    } catch (e: any) {
      return err(
        `Could not preflight fleet member role(s): ${e?.message ?? e}. ` +
          'NO fleet was created and NO terminals were opened.',
      );
    }

    // #3 FAILSAFE (fleet-launch-promote-workitems-failsafe, 2026-07-08): members self-pull via
    // scheduler:get_next, which leases WORK-ITEMS — and plan items become claimable work-items ONLY
    // via the plans:start promotion path (promotePlanItems). The PRIMARY contract is that the leader
    // ran plans:start before this tool; if they DIDN'T (the research-desk 2026-07-08 miss: plan
    // authored + set active but never started), the fleet launches onto an EMPTY backlog and every
    // member idles. So idempotently promote the plan's open items to claimable work-items HERE, before
    // any terminal opens. Idempotent — promotePlanItems skips items already promoted, so a proper
    // upstream plans:start makes this a no-op (promoted:0). Best-effort: a failure NEVER blocks the
    // launch. This is a BACKSTOP, not a replacement for plans:start (which ALSO flips op_status=started
    // for Queen/orchestrator visibility — the failsafe deliberately does not).
    // P-003: promotion only applies to a plan-scoped launch — a pure claim-spec fleet
    // has no plan items to promote (its lane is `claimKinds` over the existing backlog).
    let promotionFailsafe: (PromotePlanResult & { ran: boolean }) | null = null;
    if (planSlug) {
      try {
        const { promotePlanItems } = await import('../../plan-workitem-promotion-run');
        const res = await promotePlanItems({
          workspaceId: planWorkspaceId,
          harnessSlug: planHarnessSlug,
          planSlug,
          createdBy: ownerId,
          // EI-21574373783224719: RESERVE what this failsafe mints for THIS fleet.
          // The block above deliberately leaves op_status alone (a second dispatcher on a
          // fleet-driven plan would be worse), but that left the minted lanes carrying no
          // reservation signal whatsoever — so `reservedPlanLaneExclusionSql` scored them
          // as free backlog and self-select handed them to unrelated agents while the fleet
          // was live on the same plan (WI-41517, served to two non-fleet agents 57 minutes
          // apart). Stamping the fleet activates that floor's EXISTING fleet leg (EI-13524)
          // without touching plan lifecycle: this fleet's own members remain authorized,
          // by-id claims still bypass the floor, and only outsiders' self-select narrows.
          fleetSlug,
        });
        promotionFailsafe = { ...res, ran: true };
      } catch {
        promotionFailsafe = null; // never block the launch on the failsafe
      }
    }

    // P-058: promotion is not proof that an exact plan can feed a fleet. Read the
    // plan DAG, its promoted rows, and both structurally reachable scheduler
    // families before creating a fleet row or opening a terminal. Unknown is a
    // refusal here: spawning idle workers hides the admission defect.
    let admission: Awaited<
      ReturnType<typeof import('../plans/plan-admission-preflight').preflightExactPlanAdmission>
    > | null = null;
    let admissionError: string | null = null;
    // `count` is an ABSOLUTE live-member target, not the number of terminals to
    // open. Exact-plan admission used to compare that absolute target to the
    // CURRENT executable frontier before computeFleetTopUpWave subtracted live
    // members. A valid target=3/live=2/frontier=1 top-up was therefore refused as
    // a three-seat request even though this invocation could open exactly one.
    // Measure the same population as the later deficit guard and admit only the
    // bounded deficit. A zero-deficit no-op skips admission entirely; it must be
    // allowed to reach the authoritative relaunch-suppressed response even when
    // the remaining plan lane has since drained or become family-discordant.
    let admissionRequestedSeats = count;
    if (existingFleet) {
      try {
        const preflightLiveMembers = await liveLaunchMemberIdsForSizing({
          fleetSlug,
          workspaceId,
          launcherOwnerId: ownerId,
          remotePlacement,
        });
        admissionRequestedSeats = computeFleetTopUpWave(count, preflightLiveMembers.length).requestedOpenCount;
      } catch {
        // A roster read failure keeps the historical fail-safe shape: judge the
        // full target and let the launch-window guard prevent duplicate opens.
        admissionRequestedSeats = count;
      }
    }
    if (planSlug && admissionRequestedSeats > 0) {
      try {
        const { preflightExactPlanAdmission } = await import('../plans/plan-admission-preflight');
        admission = await preflightExactPlanAdmission({
          workspaceId: planWorkspaceId,
          harnessSlug: planHarnessSlug,
          planSlug,
          actor: ownerId,
          // Fleet members are different claimants from the launching leader. A
          // population read deliberately omits caller-relative release cooldowns;
          // otherwise a just-released ready row yields claimable=0 for the leader
          // even though the launched member can take it immediately.
          specId: `fleet-launch-${fleetSlug}-plan`,
          fleetSlug,
          claimKinds: args.claimKinds,
          requestedSeats: admissionRequestedSeats,
        });
      } catch (error) {
        admissionError = (error as Error).message;
      }
      if (!admission?.ready) {
        return json(
          {
            ok: false,
            error: 'admission_refused',
            fleet: fleetSlug,
            plan: planSlug,
            harness: planHarnessSlug,
            promotionFailsafe,
            admission,
            ...(admissionError ? { admissionError } : {}),
            message: admission
              ? `Exact-plan admission refused before fleet creation: ${admission.message}`
              : `Exact-plan admission could not be measured before fleet creation: ${admissionError ?? 'unknown error'}`,
          },
          true,
        );
      }
    }

    // Ensure the fleet (idempotent) with the caller as owner + leader, then label the
    // caller's presence — same path as fleet:create.
    let leaderRole = 'leader';
    let priorLaunchTransaction: FleetLaunchTransaction | null = null;
    let freshFleetCreated = false;
    // NOTE ON THE NAME `P-009` IN THIS FILE: the comments below about the compaction-cap
    // re-seed belong to a DIFFERENT plan's P-009. The `leader:'spawn'` work is
    // goal-mode-hardening P-009 (D-013) and is always spelled out in full. Two unrelated
    // changes share the bare id; do not read them as one.
    // P-009: the compaction-cap re-seed applied when launching INTO leadership (null unless
    // the caller was a member launching a fleet, i.e. stuck at the 300k member cap).
    let leaderReseed: Awaited<ReturnType<typeof reseedLeaderCompactionLimit>> = null;
    let leaderControl: LeaderControlOutcome | null = null;
    // ── goal-mode-hardening P-009 / D-013: who leads ─────────────────────────────
    // 'spawn' means a FRESH agent leads and the caller stays out of the fleet. Its coord
    // identity is minted HERE, pre-spawn — the "state a spawner keys pre-spawn" case `psu
    // --owner-id` exists for (the same pattern goals:start uses) — so the agent is
    // addressable the moment this returns and the leader can be installed by a known id.
    //
    // The fleet is created LEADERLESS and the leader is installed only once it has actually
    // OPENED (setFleetLeader, after the spawn below). Two rejected alternatives, both of
    // which write a leader the registry cannot honour:
    //   - create under the CALLER and relay leadership after boot: there is then a window in
    //     which the registry says the caller leads, and if the spawned agent never boots the
    //     window never closes — silently, because every write succeeded.
    //   - create with the MINTED id up front: the row would name a leader before that agent
    //     exists, and the refusal gates between here and the spawn (capacity clamped to
    //     zero, a claim-spec pool collapse) return EARLY — leaving a fleet permanently
    //     recording a leader that was never launched.
    // Leaderless is the only state that is TRUE at this point, so it is the one to write.
    const wantsSpawnedLeader = args.leader === 'spawn';
    const spawnedLeaderOwnerId = wantsSpawnedLeader ? `su-${randomUUID()}` : null;
    // Set when 'spawn' was asked for but the fleet already has a confirmed-live leader:
    // installing a second one is a coup, so preserve the historical ignored/top-up path.
    let leaderSpawnSkipped: string | null = null;
    // Existing fleets whose recorded leader is absent (or explicitly leaderless) may be
    // recovered by a fresh delegated leader. Keep the observed registry value for the
    // compare-and-set install after the new process opens; a concurrent takeover must win.
    let delegatedSpawnReplacement = false;
    let delegatedSpawnReplacementExpectedLeader: string | null | undefined;
    let leaderSpawnRecoveryWarning: string | null = null;
    // A request-timeout/retry of the same spawned-leader launch races with the first call:
    // the fleet row already exists, but the caller still owns the row and the spawned leader
    // is already recorded. That retry must remain a delegator, not join the fleet as a member.
    // An unrelated pre-existing fleet keeps the historical ignored-spawn/top-up behavior.
    let delegatedSpawnRetry = false;
    let delegatedRecordedLeaderOwnerId: string | null = null;
    try {
      const { record, created } = await createFleetIfAbsent({
        workspaceId,
        fleetSlug,
        title: args.name,
        owner: ownerId,
        // Leaderless while a leader is being spawned — see the note above. Installed by
        // setFleetLeader only after that agent's terminal actually opens.
        leaderOwnerId: wantsSpawnedLeader ? null : ownerId,
        // D-008 / P-010. Applies on FIRST INSERT only; a top-up of an existing
        // fleet keeps its stored type, which is why launchType below reads the
        // RECORD rather than the argument.
        fleetType: launchOptions.type,
      });
      // The authoritative type for the rest of this launch is the one on the
      // durable row — not what the caller asked for. On a top-up of an existing
      // fleet those differ, and the members must match the fleet they join.
      launchFleetType = record.fleetType;
      freshFleetCreated = created;
      priorLaunchTransaction = record.lastLaunchTransaction ?? null;
      if (wantsSpawnedLeader && !created) {
        // A fresh delegated leader is safe ONLY when the recorded leader is absent. A
        // confirmed-live leader remains authoritative; an unreadable liveness signal fails
        // closed and keeps the ordinary ignored/top-up path (EI-210946 authority guard).
        let recordedLeaderLive = record.leaderOwnerId != null;
        let leaderReadFailed = false;
        if (record.leaderOwnerId != null) {
          try {
            recordedLeaderLive = (await getPresence(record.leaderOwnerId)) !== null;
          } catch {
            leaderReadFailed = true;
          }
        }
        if (!leaderReadFailed && !recordedLeaderLive) {
          delegatedSpawnReplacement = true;
          delegatedSpawnReplacementExpectedLeader = record.leaderOwnerId;
          leaderSpawnSkipped = null;
        } else {
          // Idempotency beats the flag: a relaunch/top-up of an existing fleet must not
          // mint a rival leader while the recorded leader is live or liveness is unknown.
          delegatedSpawnRetry =
            record.owner === ownerId && record.leaderOwnerId != null && record.leaderOwnerId !== ownerId;
          if (delegatedSpawnRetry) delegatedRecordedLeaderOwnerId = record.leaderOwnerId;
          leaderSpawnSkipped = delegatedSpawnRetry
            ? `\`leader:'spawn'\` retry recognized: fleet \`${fleetSlug}\` was already handed to spawned leader ` +
              `\`${record.leaderOwnerId}\`; no second leader was spawned and the caller remains outside the fleet.`
            : leaderReadFailed
              ? `\`leader:'spawn'\` was IGNORED: fleet \`${fleetSlug}\` already records leader ` +
                `\`${record.leaderOwnerId ?? 'nobody'}\`, but its liveness could not be confirmed; ` +
                `no replacement was spawned and this call only tops up members.`
              : `\`leader:'spawn'\` was IGNORED: fleet \`${fleetSlug}\` already exists and is led by ` +
                `\`${record.leaderOwnerId ?? 'nobody'}\`, so no second leader was spawned — this call ` +
                `only tops up members. To replace the leader, use fleet:take-leadership (or let the ` +
                `existing one keep leading); to get a spawned leader, launch under a NEW fleet name.`;
        }
      }
      leaderRole = delegatedSpawnRetry ? 'delegator' : fleetRoleFor(record.leaderOwnerId, ownerId);
      await heartbeatPresence(identity);
      // A spawned-leader launch deliberately leaves the CALLER out of the fleet: no presence
      // label, no leader compaction re-seed, no window recolor. The caller is the delegator,
      // not a participant — labelling it here is exactly the "you are leading a fleet you
      // asked not to lead" state this mode exists to prevent. Skipped only when a leader was
      // actually spawned; the ignored case above falls through to the normal join.
      if ((wantsSpawnedLeader && created) || delegatedSpawnRetry || delegatedSpawnReplacement) {
        leaderRole = 'delegator';
      } else {
        await setPresenceFleet(workspaceId, ownerId, fleetSlug, leaderRole);
        if (leaderRole === 'leader') {
          leaderControl = await ensureFleetLeaderControl({
            workspaceId,
            ownerId,
            fleetSlug,
            harnessSlug: harness,
            planSlug,
            carry: args.carry ?? 'warm',
          });
        }
        // P-009 (incl. via launch): now that presence marks the caller this fleet's leader, lift a
        // stuck 300k member-cap seed to the leader default (400k on [1m]). Auto-only (no explicit
        // leader contextSize/limit arg on this door), and precise — it no-ops unless the caller was
        // exactly at the member cap (an established leader stays put). Best-effort inside the helper.
        if (leaderRole === 'leader') leaderReseed = await reseedLeaderCompactionLimit(ownerId);
        // Recolor the caller's live window to the fleet's bound scheme — every other
        // membership entry point (fleet:create / fleet:join / fleet:take-leadership)
        // does this; a leader whose window keeps its old color while the members open
        // in the fleet scheme is the bug, not a variant. Best-effort: a no-op for
        // non-psu-hosted callers, never throws.
        await recolorCallerTerminal(ownerId, record);
      }
    } catch (e: any) {
      return err(`Failed to create/join fleet \`${fleetSlug}\`: ${e?.message ?? e}`);
    }
    // True only when this call must actually open a leader terminal (asked for, and the
    // fleet was newly created rather than joined).
    const spawningLeader = wantsSpawnedLeader && (freshFleetCreated || delegatedSpawnReplacement);
    const callerExcludedFromFleet = spawningLeader || delegatedSpawnRetry;
    const callerMembership = {
      enrolled: !callerExcludedFromFleet,
      role: callerExcludedFromFleet ? 'delegator' : leaderRole,
      reason: callerExcludedFromFleet ? 'leader-spawn-caller-excluded' : null,
    } as const;

    // LIVE-MEMBER deficit guard: a fleet that already has enough LIVE members gets NO new wave,
    // regardless of timing. The rate window alone cannot stop a doom-looping leader that re-fires
    // minutes apart (2026-07-03 second incident: leader 10040 re-fired at +5 min and +9 min — each
    // burst was past the 60s window and opened 2 more ornith terminals while its members were alive
    // and working). Presence is authoritative once members register; the window below covers only
    // the boot gap before they do. A read failure never blocks a launch (fail open to the window).
    // This guard deliberately runs before claim-spec reads/writes: a suppressed no-op must not
    // re-stamp an authored lane when there is no launch wave to prepare.
    let liveMembers = 0;
    let liveMemberOwnerIds: string[] = [];
    try {
      // The audience population intentionally keeps `recorded` owners for durable
      // delivery; launch sizing needs the narrower runnable-state population so a
      // warm-dead recorded session cannot suppress its replacement (EI-21406488340926352).
      const localLive = (await liveFleetMemberIds(fleetSlug, workspaceId, 'launch')).filter((id) => id !== ownerId);
      let live = localLive;
      if (remotePlacement) {
        // WI-5211: remote members never register in LOCAL coord_presence — they announce
        // via session-presence gossip (shared_session_presence, mig 479). Without this
        // union a remote re-call always sees liveMembers=0 and publishes a whole second
        // wave onto the other machines. Best-effort: federated roster unavailable ⇒ the
        // local count alone (the relaunch window still guards the double-fire case).
        try {
          const federated = await listFederatedFleetMembers({
            workspaceId,
            fleetSlug,
            staleMs: PRESENCE_STALE_MS,
          });
          // EI-21428116455038454: mirror the local launch population's role filter —
          // a remote LEADER/delegator row must not occupy a member seat either.
          const federatedSeats = federated
            .filter((member) => occupiesLaunchMemberSeat(member.fleetRole))
            .map((member) => member.ownerId);
          live = [...new Set([...localLive, ...federatedSeats])].filter((id) => id !== ownerId);
        } catch {
          live = localLive;
        }
      }
      liveMemberOwnerIds = live;
      liveMembers = live.length;
    } catch {
      liveMemberOwnerIds = [];
      liveMembers = 0;
    }
    // A delegated dead-leader recovery still needs to open its leader even when the
    // member target is already satisfied; suppressing the whole call here would leave
    // a running fleet leaderless forever. Ordinary top-ups retain the no-op guard.
    if (liveMembers >= count && !spawningLeader) {
      const lines = [
        `Fleet \`${fleetSlug}\` already has ${liveMembers} LIVE member${liveMembers === 1 ? '' : 's'} — you asked for ${count}, so NO new terminals were opened.`,
        'Your fleet is running: monitor it, do not relaunch. Re-call this tool only after members have actually drained (their presence goes stale), or with a HIGHER count to top up.',
        planSlug
          ? `Until the plan \`${planSlug}\` is drained, your standing job each cycle:`
          : `Until your fleet \`${fleetSlug}\` claim-lane is drained, your standing job each cycle:`,
      ];
      LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      return json({
        ok: true,
        fleet: fleetSlug,
        leaderRole,
        callerMembership,
        leaderSpawnIgnored: leaderSpawnSkipped,
        plan: planSlug,
        harness,
        agent,
        account: args.account?.trim() || null,
        requested: count,
        liveMembers,
        sizingAdvisory: null,
        memberBaselineApplied: false,
        claimSpecApplied: null,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath: null,
        perMemberLaunchContextPaths: null,
        briefReadError: null,
        opened: [],
        failed: [],
        relaunchSuppressed: true,
        message: lines.join('\n'),
      });
    }

    // #4 (fleet-launch-plan-scoped-claim-spec, 2026-07-08) + EI-7671 + EI-10409: set the
    // fleet-level claim spec BEFORE any member terminal opens — scoping every member's
    // scheduler:get_next self-pull to THIS plan (`plan = <slug>`), AND to args.claimKinds when
    // given. This is deliberately deferred until the launch-slot guard has admitted a real
    // wave: a duplicate-suppressed retry opens nothing and must not rewrite an authored lane
    // or bump its revision (EI-21577837411148486).
    //
    // EI-10409: this used to ALWAYS overwrite, which (a) silently clobbered a spec the leader had
    // just hand-authored seconds earlier (e.g. a vetted id-pinned wave) with no warning, and (b)
    // replaced it with a bare `plan = <slug>` filter that ordinary backlog work-items don't carry
    // (only items PROMOTED from the plan do) — starving a `claimKinds` backlog-drain fleet, which
    // is the exact flow claimKinds advertises. So: read the CURRENT spec first; a leader-authored
    // spec is preserved (merging in the kind constraint when claimKinds is given, never discarded);
    // only a not-yet-customized spec gets (re)generated, preferring a kind-only filter over a
    // plan= filter whenever claimKinds is given. Best-effort throughout: a spec read/write failure
    // never blocks the launch (members still start; get_next's harness floor still scopes them to
    // this pot).
    type ClaimSpecApplication = {
      claimSpecApplied: {
        ok: boolean;
        revision?: number;
        warning?: string;
        errors?: string[];
        poolEffect?: SpecPoolEffect;
      } | null;
      // P-010: when the claimKinds pool-collapse guard refuses, abort the launch BEFORE any
      // terminal opens (the whole point — a starving spec must never open members onto nothing).
      claimCollapseRefusal: { errors: string[]; poolEffect: SpecPoolEffect | null } | null;
    };
    const applyFleetClaimSpec = async (): Promise<ClaimSpecApplication> => {
      let claimSpecApplied: ClaimSpecApplication['claimSpecApplied'] = null;
      let claimCollapseRefusal: ClaimSpecApplication['claimCollapseRefusal'] = null;
      // A same-owner spawned-leader retry already installed the fleet lane on its first call.
      // Preserve that spec byte-for-byte; this retry is only allowed to finish a member wave.
      if (delegatedSpawnRetry) {
        claimSpecApplied = {
          ok: true,
          warning:
            `leader:'spawn' retry preserved the existing claim spec for fleet \`${fleetSlug}\`; ` +
            'the caller remains outside the fleet',
        };
      } else {
        try {
          const claimSpecWorkspaceId = resolveClaimSpecWorkspace(workspaceId);
          const cupId = fleetSpecBeeKey(fleetSlug);
          let existingSpec: ClaimSpec = DEFAULT_CLAIM_SPEC;
          let currentSpecRead = false;
          try {
            const liveSpec = await getClaimSpec({ cupId, workspaceId: claimSpecWorkspaceId });
            if (liveSpec) {
              existingSpec = liveSpec;
              currentSpecRead = true;
            }
          } catch {
            // Never block the launch on a read failure. For an existing fleet,
            // retain the preflight snapshot rather than reconstructing a default
            // lane after the launch slot has been won.
            existingSpec = existingFleetClaimSpec ?? DEFAULT_CLAIM_SPEC;
          }
          if (!currentSpecRead && existingFleetClaimSpec) existingSpec = existingFleetClaimSpec;
          const authored = isLeaderAuthoredClaimSpec(existingSpec.specId, fleetSlug);

          // The spec we WOULD apply (null = preserve the existing authored spec, no write), plus
          // the EI-10409 merge/preserve note carried onto the applied result.
          let specToApply: Record<string, unknown> | null = null;
          let applyWarning: string | null = null;
          // EI-21577352340987493: a top-up with no explicit plan/kinds must reuse
          // any non-default live lane, including a tool-generated fleet spec. The
          // old authored-only branch treated generated lanes as disposable and
          // then tried to build a kind spec from undefined args.
          if (
            existingFleet &&
            !planSlug &&
            !args.claimKinds?.length &&
            existingSpec.specId !== DEFAULT_CLAIM_SPEC.specId
          ) {
            claimSpecApplied = {
              ok: true,
              revision: existingSpec.revision,
              warning:
                `EI-215773: preserved live claim spec ${formatSpecRef(existingSpec.specId, existingSpec.revision)} ` +
                `for existing fleet \`${fleetSlug}\`${currentSpecRead ? '' : ' (using the preflight snapshot after a failed reread)'}`,
            };
          } else if (authored) {
            if (args.claimKinds?.length) {
              specToApply = mergeKindIntoClaimSpec(existingSpec, args.claimKinds);
              applyWarning =
                `EI-10409: merged kind∈[${args.claimKinds.join(',')}] into pre-existing leader-authored ` +
                `claim spec ${formatSpecRef(existingSpec.specId, existingSpec.revision)} rather than overwriting it`;
            } else {
              claimSpecApplied = {
                ok: true,
                revision: existingSpec.revision,
                warning:
                  `EI-10409: preserved pre-existing leader-authored claim spec ` +
                  `${formatSpecRef(existingSpec.specId, existingSpec.revision)} — not overwritten`,
              };
            }
          } else {
            // EI-21148090110387275: COMPOSE claimKinds with the plan predicate rather than
            // replacing it. buildFleetPlanClaimSpec already ANDs a `kind ∈ claimKinds` leaf onto
            // the `plan = <planSlug>` leaf when kinds are given — so whenever a plan was supplied,
            // route through it (with or without claimKinds) so an existing tool-generated
            // `fleet-launch-<slug>-plan` spec is refreshed IN PLACE (same specId, plan predicate
            // preserved) instead of being clobbered by the global, plan-blind
            // `fleet-launch-<slug>-kinds` spec buildFleetKindClaimSpec produces. Only a
            // claimKinds-only launch (no plan — P-003's "pure claim-spec fleet") falls back to
            // buildFleetKindClaimSpec; the early `plan || claimKinds` validation guarantees
            // claimKinds is non-empty whenever planSlug is absent here.
            specToApply = planSlug
              ? buildFleetPlanClaimSpec(fleetSlug, planSlug, args.claimKinds)
              : buildFleetKindClaimSpec(fleetSlug, args.claimKinds!);
          }

          // P-010 (WI-5212 pool-collapse guard): run the SAME write-time pool-effect count +
          // collapse verdict scheduler:set_claim_spec runs — refuse a scope matching 0 rows of a
          // nonempty pool (or a cratered authored lane) BEFORE any terminal opens, and surface
          // poolEffect.matched.
          //
          // EI-19276371141300541: this guard used to run ONLY on the claimKinds path — a FRESH
          // plan-only spec (buildFleetPlanClaimSpec, `plan = <slug>`) got neither the zero-match
          // refuse NOR a surfaced poolEffect, on the theory that "plan-promoted items vary in
          // status; guarding it risks a false refusal". That theory doesn't hold: the promotion
          // failsafe above already ran BEFORE this block, so a legitimately-fed plan lane already
          // has its items promoted (states=['open'] by construction) by the time we count here — a
          // freshly-generated plan lane is exactly as measurable as a freshly-generated kind lane.
          // Skipping the check for it is precisely how a 10-member fleet launched onto a plan whose
          // own tracking items (not the backlog being drained) matched exactly ONE row, while
          // `claimSpecApplied` reported `ok:true` with nothing to say a starvation had occurred.
          // Now run for every FRESHLY-BUILT spec (kind-only, plan-only, or their merge into an
          // authored lane) — never for a preserved authored no-claimKinds spec (nothing changed
          // there to measure). FAILS OPEN: a preview/count error never blocks the launch (safety
          // net, not a new SPOF).
          let poolEffect: SpecPoolEffect | null = null;
          if (specToApply) {
            try {
              const validated = validateClaimSpec(specToApply);
              if (validated.ok && validated.spec) {
                const { previewSpecPoolEffect, evaluateCollapseGuard } =
                  await import('../../scheduler/spec-pool-preview');
                // Count the REAL work_items partition (the launch's resolved workspace) — NOT the
                // claim-spec store partition (resolveClaimSpecWorkspace), which is a different key
                // space. This mirrors scheduler:set_claim_spec's own countScope (ident.workspaceId).
                const countScope = { workspaceId, harness };
                poolEffect = await previewSpecPoolEffect(validated.spec, countScope);
                let previousMatched: number | null = null;
                if (authored) {
                  try {
                    previousMatched = (await previewSpecPoolEffect(existingSpec, countScope)).matched;
                  } catch {
                    previousMatched = null; // previous unmeasurable → guard degrades to fresh-spec rules
                  }
                }
                const verdict = evaluateCollapseGuard({
                  matched: poolEffect.matched,
                  pool: poolEffect.pool,
                  previousMatched,
                  previousSource: authored ? 'authored' : 'default',
                  confirm: args.confirmClaimCollapse === true,
                });
                if (verdict.refuse) {
                  claimCollapseRefusal = { errors: verdict.errors, poolEffect };
                } else if (verdict.warning) {
                  applyWarning = applyWarning ? `${applyWarning}\n${verdict.warning}` : verdict.warning;
                }

                // EI-19276371141300541: a NONZERO but LOW match count evades the zero-match refuse
                // above yet is the exact starvation shape a caller otherwise cannot see — the
                // reported incident matched exactly 1 row for a 10-member fleet (matched !== 0, so
                // `zeroMatch` never fires). Surface it as a loud warning — never a refusal, since a
                // real backlog genuinely smaller than the requested headcount is legitimate and
                // members simply idle until more work lands — whenever the matched pool can't feed
                // every requested member.
                if (!verdict.refuse && poolEffect.matched > 0 && poolEffect.matched < count) {
                  const lowMatchWarning =
                    `⚠ claim-lane pool-effect: this spec matches only ${poolEffect.matched} of ${poolEffect.pool} ` +
                    `claimable row(s) under states=[${poolEffect.states.join(',')}]${poolEffect.harness ? ` in \`${poolEffect.harness}\`` : ''} ` +
                    `— for a ${count}-member fleet. At least ${count - poolEffect.matched} member(s) will find nothing to claim under this lane.`;
                  applyWarning = applyWarning ? `${applyWarning}\n${lowMatchWarning}` : lowMatchWarning;
                }

                // WI-6673 — THE DUAL OF THE COLLAPSE GUARD. Above refuses a lane matching TOO
                // FEW rows (starvation). This warns about the opposite and equally real failure:
                // a lane matching PLENTY of rows that are not work. On 2026-08-01 a bug-drain
                // fleet was launched at a lane of 1,252 "claimable" items that was 98.7%
                // nit-severity auto-filed observations; the true bug backlog was ~285. Nothing
                // in the launch path objected, because every count was correct — a big number
                // simply looks like a healthy backlog. WARN, never refuse: a legitimately
                // low-severity lane (a nit-sweep fleet) is a real thing to want.
                try {
                  const { aggregateAdmittedComposition } = await import('../../scheduler/get-next');
                  const { formatLowSeverityShare } = await import('../../scheduler/admitted-composition-format');
                  const comp = await aggregateAdmittedComposition(validated.spec.view.filter, {
                    harness,
                    states: validated.spec.states,
                  });
                  if (comp.degenerate) {
                    const burst = comp.peakDay
                      ? ` ${comp.peakDay.count} of them were filed on a single day (${comp.peakDay.day}), the signature of burst auto-filing rather than discovered work.`
                      : '';
                    // The denominator MUST be the admitted total, not poolEffect.matched: the
                    // share is computed over rows passing ALL claim floors, while `matched` is
                    // the pre-floor filter match (a strictly larger population). Pairing one
                    // with the other states a true percentage against the wrong base — the exact
                    // defect class WI-6673 exists to catch, reproduced inside its own warning.
                    // `formatLowSeverityShare` carries that denominator with the share, and
                    // floors rather than rounds so this sentence can never print "100%" while a
                    // major-severity row is in the lane (EI-22184028605968917).
                    const degenWarning =
                      `⚠ DEGENERATE LANE: ${formatLowSeverityShare(comp, 'claimable row(s)')}` +
                      (poolEffect.matched !== comp.total
                        ? ` (of ${poolEffect.matched} matched before claim floors)`
                        : '') +
                      `.${burst}` +
                      ` This lane is very likely an OBSERVATION FIREHOSE, not a backlog — a large count is not a workload.` +
                      ` Composition: kinds ${JSON.stringify(comp.byKind)}, severities ${JSON.stringify(comp.bySeverity)}.` +
                      ` If you meant to drain real defects, scope the lane by severity or kind before the members start pulling (WI-6673).`;
                    applyWarning = applyWarning ? `${applyWarning}\n${degenWarning}` : degenWarning;
                  }
                } catch {
                  /* composition is a diagnostic, never a launch blocker — fail open */
                }
              }
            } catch (e: any) {
              applyWarning = `${applyWarning ? `${applyWarning}\n` : ''}pool-effect preview failed open (spec applied, collapse guard skipped): ${e?.message ?? e}`;
            }
          }

          // Apply — unless the guard refused (handled after the try) or we preserved an authored
          // no-kinds spec (claimSpecApplied already set, specToApply null).
          if (!claimCollapseRefusal && specToApply) {
            // EI-21177728511242093: `harness` is this launch's resolved (mandatory) harness
            // scope — the SAME value already threaded into `countScope` above for the
            // pool-effect preview. Passing `potSlug: null` here unconditionally overwrote
            // the claim spec's `harness_slug` column on EVERY relaunch/top-up, even when a
            // prior launch (or a leader's own scheduler:set_claim_spec) had correctly scoped
            // it — stranding get_next reads that filter by harness and leaving a live member
            // with no matching claimable work. Mirror scheduler:set_claim_spec's own
            // resolution (an explicit/ctx harness always wins) instead of hardcoding null.
            const applied = await setClaimSpec({
              cupId,
              workspaceId: claimSpecWorkspaceId,
              spec: specToApply,
              updatedBy: ownerId,
              potSlug: harness,
            });
            const warning =
              applied.ok && applyWarning
                ? applied.warning
                  ? `${applied.warning}\n${applyWarning}`
                  : applyWarning
                : applied.warning;
            claimSpecApplied = {
              ...applied,
              ...(warning ? { warning } : {}),
              ...(applied.ok && poolEffect ? { poolEffect } : {}),
            };
          }
        } catch (e: any) {
          claimSpecApplied = { ok: false, errors: [e?.message ?? String(e)] };
        }
      }
      return { claimSpecApplied, claimCollapseRefusal };
    };

    const refuseClaimCollapseAfterSlot = async (
      slotAt: number,
      refusal: NonNullable<ClaimSpecApplication['claimCollapseRefusal']>,
    ) => {
      // The slot is reserved before claim-spec evaluation so a suppressed retry cannot
      // mutate the lane. If the fresh lane itself is refused, release that reservation so
      // the caller can correct the scope and retry immediately.
      try {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slotAt });
      } catch {
        /* the guard self-heals when the window elapses */
      }
      const pe = refusal.poolEffect;
      const laneDesc = args.claimKinds?.length ? `claimKinds=[${args.claimKinds.join(',')}]` : `plan=\`${planSlug}\``;
      // EI-21016597300738770: this is an EARLY return, before the ordinary
      // success-message assembler appends promotionFailsafeWarning. When
      // promotion itself explained the zero lane (notably specTriadBlocked +
      // its concrete filing), dropping that warning left callers with only a
      // generic 0/N refusal and no discoverable exit. Preserve the structured
      // diagnosis here too; the collapse guard still refuses and opens nothing.
      const promotionWarning = planSlug ? promotionFailsafeWarning(planSlug, promotionFailsafe) : null;
      return err(
        `${promotionWarning ? `${promotionWarning}\n` : ''}${refusal.errors.join('\n')}\n` +
          (pe
            ? `${laneDesc} matched ${pe.matched} of ${pe.pool} claimable row(s) under states=[${pe.states.join(
                ',',
              )}]${pe.harness ? ` in harness \`${pe.harness}\`` : ''}. `
            : '') +
          'NO members were opened. Re-send with confirmClaimCollapse:true to launch anyway (a pre-staged lane whose items are not promoted yet), or fix the claimKinds / plan / backlog first.',
      );
    };

    // Only the DEFICIT opens. The target remains independent of the live population:
    // a 27-member fleet targeting 28 opens one, while a larger deficit proceeds to
    // the durable governor/capacity admission below instead of a local numeric cap.
    const topUpWave = computeFleetTopUpWave(count, liveMembers);
    let openCount = topUpWave.requestedOpenCount;
    const requestedOpenCount = openCount;
    let claimSpecApplied: ClaimSpecApplication['claimSpecApplied'] = null;

    // ── WI-5211 REMOTE placement: distribute the deficit across the OTHER machines'
    // federated seat-offers — one signed spawn-request per target machine (composing
    // the fleet:request_remote_spawn chain), so ONE call places members on EVERY
    // contributing machine. The local capacity clamp is skipped by design: the
    // members burn the HONORING hosts' capacity, and each host's honor path re-checks
    // its own seat caps (delegated-spawn-honor gates 4/5) before spawning.
    if (remotePlacement) {
      const scope = await resolveWorkspaceHiveScope(workspaceId);
      const hivePick = resolveRemotePlacementHive(scope, args.hive, harness);
      if (!hivePick.ok) return err(hivePick.error);
      const hiveHomeSlug = hivePick.homeSlug;
      // This machine's OWN delegation must never receive a spawn-request (the honor
      // hook fires only on REMOTE apply — a self-request would sit forever), so
      // identify self and exclude own offers. Best-effort: identity unavailable ⇒
      // no pre-filter; publishSpawnRequest's self-target guard still backstops.
      let selfGithubUserId: number | null = null;
      let selfDevicePubkey: string | null = null;
      try {
        const actor = await resolveUsageActor();
        if (actor) {
          selfGithubUserId = actor.githubUserId;
          const keypair = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(actor.githubUserId));
          selfDevicePubkey = keypair.pubkeyBase64;
        }
      } catch {
        selfGithubUserId = null;
        selfDevicePubkey = null;
      }
      let seatOffers;
      try {
        seatOffers = await listOffers(workspaceId, hiveHomeSlug, {
          fleetSlug,
          kind: 'seat',
          status: 'open',
        });
      } catch (e: any) {
        return err(`Failed to list the fleet's federated seat-offers: ${e?.message ?? e}`);
      }
      // P-005: pool the pot's shared seat-offers (fleetSlug=null, potSlug=this
      // plan's harness) alongside this fleet's own — the same fallback
      // fleet:request_remote_spawn's single-target auto-pick already uses
      // (WI-5402/P-004's pickPotSeatOffer), now applied to the SPREAD
      // distribution so `count` can draw from either scope in one call. The
      // audience gate ('trusted-members'|'whole-pot') is re-checked
      // authoritatively on the honoring host (delegated-spawn-honor.ts) — this
      // side just pools candidates and threads potSlug through so that gate has
      // what it needs; it never filters by audience itself (fail-closed lives
      // on the host, not the requester).
      const potSlug = await resolvePlanHarnessSlug(workspaceId, planSlug!);
      let potSeatOffers: typeof seatOffers = [];
      if (potSlug) {
        try {
          potSeatOffers = await listOffers(workspaceId, hiveHomeSlug, {
            potSlug,
            kind: 'seat',
            status: 'open',
          });
        } catch (e: any) {
          return err(`Failed to list the pot's federated seat-offers: ${e?.message ?? e}`);
        }
      }
      const remoteOffers: RemoteSeatOfferSummary[] = [...seatOffers, ...potSeatOffers]
        .filter((o) => !o.localDisposition)
        .filter((o) => !isSelfPublishedSeatOffer(o, selfGithubUserId, selfDevicePubkey))
        .map((o) => ({
          publisher: o.publisherGithubUserId,
          offerId: o.offerId,
          host: o.record?.seat?.hostLabel ?? null,
          seats: o.record?.seat?.count ?? 0,
          potSlug: o.potSlug,
        }));
      const dist = distributeRemotePlacement(openCount, remoteOffers);
      if (!dist.ok) return err(dist.error);

      // The remote brief travels as TEXT inside the signed request; the honoring host
      // composes it under the member baseline itself (delegated-spawn-honor).
      let remoteBriefText: string | null = args.brief?.trim() || null;
      if (!remoteBriefText && args.launchContext?.trim()) {
        const rawLaunchContext = args.launchContext.trim();
        if (looksLikeInlineLaunchContextText(rawLaunchContext)) {
          // EI-19276371920501216: this is brief TEXT, not a path — send it as-is
          // rather than handing it to readFileSync (ENAMETOOLONG).
          remoteBriefText = rawLaunchContext;
        } else {
          try {
            remoteBriefText = readFileSync(rawLaunchContext, 'utf8');
          } catch (e: any) {
            return err(`Could not read launchContext \`${rawLaunchContext}\` for the remote brief: ${e?.message ?? e}`);
          }
        }
      }
      if (goalAllocation) {
        const allocation = renderGoalFleetAllocation({ ...goalAllocation, fleetMemberTarget: count });
        remoteBriefText = [remoteBriefText, allocation].filter(Boolean).join('\n\n');
      }
      if (remoteBriefText && remoteBriefText.length > 8000) {
        return err(
          `remote launch brief is ${remoteBriefText.length} chars — a remote spawn-request brief is capped at 8000. Trim the custom brief.`,
        );
      }

      // Same atomic idempotency guard as a local wave: a re-fired call must not publish
      // a SECOND set of signed spawn-requests — each fresh request re-spawns on its
      // target host once honored.
      let remoteSlot;
      try {
        remoteSlot = await claimFleetLaunchSlot({
          workspaceId,
          fleetSlug,
          count,
          windowMs: RELAUNCH_SUPPRESS_MS,
          allowCountIncreaseWithinWindow: leaderRole === 'leader' && liveMembers > 0,
        });
      } catch (e: any) {
        return err(`Failed to check the fleet's launch guard: ${e?.message ?? e}`);
      }
      if (!remoteSlot.won) {
        const agoS = Math.max(1, Math.round((Date.now() - remoteSlot.priorAt) / 1000));
        return json({
          ok: true,
          fleet: fleetSlug,
          leaderRole,
          callerMembership,
          leaderSpawnIgnored: leaderSpawnSkipped,
          plan: planSlug,
          harness,
          placement: 'remote',
          requested: count,
          liveMembers,
          claimSpecApplied,
          remotePlacements: [],
          failedPlacements: [],
          relaunchSuppressed: true,
          message:
            `Fleet \`${fleetSlug}\` was already launched ${agoS}s ago (possibly by this very session) — NO new spawn-requests were published. ` +
            'Remote members arrive ASYNC (federation + the honor gate + spawn + presence can take minutes): watch fleet:status / coord:presence before re-requesting.',
        });
      }

      const claimSpecResult = await applyFleetClaimSpec();
      claimSpecApplied = claimSpecResult.claimSpecApplied;
      if (claimSpecResult.claimCollapseRefusal) {
        return refuseClaimCollapseAfterSlot(remoteSlot.at, claimSpecResult.claimCollapseRefusal);
      }

      const remotePlacements: Array<{
        publisher: number;
        offer: string;
        host: string | null;
        count: number;
        requestOfferId: string;
      }> = [];
      const failedPlacements: Array<{
        publisher: number;
        offer: string;
        host: string | null;
        count: number;
        error: string;
      }> = [];
      for (const alloc of dist.allocations) {
        const res = await publishSpawnRequest({
          workspaceId,
          fleetSlug,
          targetPublisherGithubUserId: alloc.publisher,
          targetOfferId: alloc.offerId,
          count: alloc.count,
          planSlug: planSlug!,
          requesterOwnerId: ownerId,
          // P-005: only set for allocations drawn from a pot-scoped offer — the
          // honoring host's audience gate (delegated-spawn-honor.ts) consults
          // this ONLY when Gate 2 matched a pot-scoped candidate; undefined for
          // a fleet-scoped allocation (no audience concept there).
          requesterPotSlug: alloc.potSlug ?? undefined,
          launchContext: remoteBriefText,
          hiveOverride: hiveHomeSlug,
        });
        if (res.ok) {
          remotePlacements.push({
            publisher: alloc.publisher,
            offer: alloc.offerId,
            host: alloc.host,
            count: alloc.count,
            requestOfferId: res.stored.offerId,
          });
        } else {
          failedPlacements.push({
            publisher: alloc.publisher,
            offer: alloc.offerId,
            host: alloc.host,
            count: alloc.count,
            error: 'skipped' in res ? res.skipped : res.error,
          });
        }
      }
      if (remotePlacements.length === 0) {
        try {
          await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: remoteSlot.at });
        } catch {
          /* the guard self-heals when the window elapses */
        }
      }

      const placedTotal = remotePlacements.reduce((s, p) => s + p.count, 0);
      const lines: string[] = [];
      const promotionWarning = promotionFailsafeWarning(planSlug!, promotionFailsafe);
      if (promotionWarning) lines.push(promotionWarning);
      lines.push(
        remotePlacements.length
          ? `Published ${placedTotal} REMOTE member placement${placedTotal === 1 ? '' : 's'} for fleet \`${fleetSlug}\` on plan \`${planSlug}\` across ${remotePlacements.length} machine${remotePlacements.length === 1 ? '' : 's'}${liveMembers > 0 ? ` (deficit top-up: ${liveMembers} already live of the ${count} requested)` : ''}:`
          : `No remote placements were published for fleet \`${fleetSlug}\`.`,
      );
      for (const p of remotePlacements) {
        lines.push(
          `  • ${p.host ?? `publisher ${p.publisher}`}: ${p.count} member${p.count === 1 ? '' : 's'} — spawn-request ${p.requestOfferId}`,
        );
      }
      if (failedPlacements.length) {
        lines.push(`${failedPlacements.length} placement${failedPlacements.length === 1 ? '' : 's'} failed:`);
        for (const f of failedPlacements) {
          lines.push(`  • ${f.host ?? `publisher ${f.publisher}`} (${f.offer}): ${f.error}`);
        }
      }
      if (remotePlacements.length) {
        lines.push(
          "ASYNC contract: each signed request federates on the next sync tick; a target spawns ONLY if its owner enabled accept-delegated-seats (otherwise the request expires after 60 min — agree with that machine's owner first). Watch members arrive via fleet:status / coord:presence (federated session presence carries the fleet label); a refusal federates back as a p2p receipt (p2p:trace with the requestOfferId).",
        );
        lines.push(
          "NOTE: the fleet claim spec set here is MACHINE-LOCAL — remote members pull work-items under their own machine's spec (default order, scoped by the pot floor). The plan's promoted work-items federate, so they still land on this plan.",
        );
        lines.push(LEADER_AUTO_MODE_DIRECTIVE);
        LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      }

      return json(
        {
          ok: remotePlacements.length > 0,
          fleet: fleetSlug,
          leaderRole,
          callerMembership,
          leaderSpawnIgnored: leaderSpawnSkipped,
          autoModeEntered: leaderControl?.mode.healthy === true,
          leaderControl,
          plan: planSlug,
          harness,
          placement: 'remote',
          requested: count,
          liveMembers,
          requestedOpenCount,
          claimSpecApplied,
          promotionFailsafe,
          admission,
          remotePlacements,
          failedPlacements,
          message: lines.join('\n'),
        },
        remotePlacements.length === 0,
      );
    }

    let capacityClamp: FleetLaunchCapacityClamp | null = null;
    let sizingAdvisory: ReturnType<typeof buildFleetSizingAdvisory> = null;
    try {
      const capacityProvider = gatewayCapacityProviderForFleetAgent(agent, memberModel);
      const capacity = buildCapacityReport(
        await fetchGatewayHeadroom({ timeoutMs: 1200, provider: capacityProvider }),
        {
          clampArmed: true,
          headroom: openCount,
        },
      );
      // fleet-launch-zero-gate-routing-blind (2026-07-09): the healthyAccounts===0 zero-gate
      // applies only to GATEWAY-routed members. Resolve the members' planned routing the same
      // way the launch command will (a seat pins a pool account ⇒ gateway; otherwise
      // defaultMemberAccountRouting selects the direct system credential everywhere).
      const plannedAccount = seatsRequested ? 'auto' : defaultMemberAccountRouting(args.account?.trim() || undefined);
      const gatewayRouted = !!plannedAccount && plannedAccount !== 'default' && plannedAccount !== 'system';
      const capacityProfileSpec = args.members?.[memberSpecIndexForLaunch(liveMembers, 0)];
      const freshSameProfileCanary = hasFreshSameProfileCanary({
        transaction: priorLaunchTransaction,
        currentProfile: {
          agent: capacityProfileSpec?.agent ?? agent,
          model:
            composeModelSpec(
              capacityProfileSpec?.model ?? memberModel,
              capacityProfileSpec?.effort ?? args.effort,
            ) ?? null,
          account: seatsRequested
            ? 'auto'
            : defaultMemberAccountRouting(
                capacityProfileSpec?.account ?? (args.account?.trim() || undefined),
              ) ?? 'default',
          carry: capacityProfileSpec?.carry ?? args.carry ?? 'warm',
          headless: capacityProfileSpec?.headless ?? !!args.headless,
        },
      });
      capacityClamp = clampFleetTopUpToCapacity(openCount, capacity, {
        gatewayRouted,
        override: args.overrideCapacityClamp ?? false,
        freshSameProfileCanary,
      });
      if (capacityClamp) openCount = capacityClamp.openCount;
      sizingAdvisory = buildFleetSizingAdvisory(count, capacity) ?? null;
      // A "they WILL still launch" sizing advisory alongside a zero-clamp is a self-contradictory
      // response (hit live 2026-07-09) — the clamp reason is authoritative; drop the advisory.
      if (capacityClamp?.clamped && capacityClamp.openCount === 0) sizingAdvisory = null;
    } catch {
      capacityClamp = null;
      sizingAdvisory = null;
    }

    // Headless members are each placed in a protected agent-session scope with the
    // shared MemoryMax. The gateway capacity signal above protects inference
    // admission, but it cannot see the host-wide cgroup population that caused the
    // memory-reclaim incident behind EI-21170449710478148. Count the live/pending
    // protected scopes before opening this wave and compose that ceiling with the
    // gateway result. This is deliberately LOCAL only: remote placement is admitted
    // by each honoring host against its own resource ledger.
    let hostMemoryClamp: HeadlessHostMemoryClamp | null = null;
    let hostMemoryAdmissionError: string | null = null;
    if (args.headless && openCount > 0) {
      try {
        const liveTasks = await listLiveTasks(workspaceId);
        const protectedAgentMemory = summarizeProtectedAgentMemory(liveTasks);
        // A spawned headless leader consumes the same protected scope as a member,
        // but has not enrolled in the ledger yet. Reserve that slot before deciding
        // how many member scopes this call may open.
        const reservedForSpawnedLeader = spawningLeader ? 1 : 0;
        hostMemoryClamp = clampHeadlessLaunchToHostMemory(openCount, {
          hostTotalMemoryBytes: totalmem(),
          activeProtectedAgentScopes: protectedAgentMemory.activeProtectedAgentScopes + reservedForSpawnedLeader,
          perScopeMemoryBytes: agentSpawnScopeMemoryMaxG() * 1024 ** 3,
          observedProtectedMemoryBytes: protectedAgentMemory.observedProtectedMemoryBytes,
          unmeasuredProtectedAgentScopes:
            protectedAgentMemory.unmeasuredProtectedAgentScopes + reservedForSpawnedLeader,
        });
        // ADVISORY ONLY — deliberately does NOT reduce openCount.
        //
        // WI-41206 / plan remove-memory-derived-work-refusals-2026-08-24.
        // [owner 2026-08-24] "if the user wants to run a lot of agents and use up
        // the memory and force pagination that is their choice."
        //
        // Why the refusal was wrong, measured 2026-08-24: it reserved each live scope's
        // full MemoryMax — 74 scopes x 6 GiB = 444 GiB of ceiling — against 188.6 GiB of
        // usable RAM, while those same scopes held 23 GiB RSS in total. Once the
        // population crossed floor(188.6/6)=31 it therefore returned 0 for EVERY headless
        // launch, indefinitely. At the time of removal the host measured PSI memory
        // full avg60=1.16 (the EI-21170449710478148 incident threshold is 5), zero
        // pswpout over a 10s sample, and 1.87 TB of free swap that this arithmetic never
        // counted. A worker that exceeds its budget should page and get slower, not be
        // refused; MemoryMax on the scope remains as the per-worker runaway backstop.
        //
        // The figures stay in the returned result so callers keep the observability.
      } catch (e: any) {
        // Telemetry, not admission: an unreadable ledger means we cannot REPORT the
        // protected-scope population, never that the launch is refused.
        hostMemoryAdmissionError = `host-memory telemetry unavailable (advisory only — launch NOT refused): ${e?.message ?? e}`;
      }
    }
    if (openCount <= 0 && !spawningLeader) {
      // WI-41206: host memory can no longer produce this branch. The clamp is advisory
      // and never reduces openCount, so reaching 0 here means capacity or the live-member
      // deficit — never memory. Reporting it as a memory suppression would send the
      // caller to fix the wrong thing.
      const hostMemorySuppressed = false;
      const lines = [
        `Fleet \`${fleetSlug}\` has ${liveMembers} LIVE member${liveMembers === 1 ? '' : 's'}; target ${count} leaves a deficit of ${topUpWave.remainingDeficit}, but capacity allows 0 new member terminals now.`,
        capacityClamp?.reason ?? 'capacity report unavailable',
        'NO new terminals were opened. Re-call this tool after capacity recovers; the live-member deficit guard will still open only the remaining deficit.',
        planSlug
          ? `Until the plan \`${planSlug}\` is drained, your standing job each cycle:`
          : `Until your fleet \`${fleetSlug}\` claim-lane is drained, your standing job each cycle:`,
      ];
      LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      return json({
        ok: true,
        fleet: fleetSlug,
        leaderRole,
        callerMembership,
        leaderSpawnIgnored: leaderSpawnSkipped,
        plan: planSlug,
        harness,
        agent,
        account: args.account?.trim() || null,
        requested: count,
        liveMembers,
        requestedOpenCount,
        capacityClamp,
        sizingAdvisory,
        memberBaselineApplied: false,
        claimSpecApplied,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath: null,
        perMemberLaunchContextPaths: null,
        briefReadError: null,
        opened: [],
        failed: [],
        relaunchSuppressed: true,
        capacitySuppressed: Boolean(capacityClamp?.clamped && !hostMemorySuppressed),
        hostMemorySuppressed,
        hostMemoryClamp,
        hostMemoryAdmissionError,
        message: lines.join('\n'),
      });
    }

    // Idempotency guard (P-005): a weak model that re-fires launch-on-plan (the 9896 "take
    // leadership" fumble, the 2026-07-03 7×-re-fire) must NOT open a second wave. The claim is
    // an atomic PG check-and-set on the fleet row, shared across every operator worker — if ANY
    // launch of this fleet won the window, no-op with a notice instead of spawning again. This
    // covers the BOOT GAP: members just spawned are not yet in presence, so the deficit guard
    // above cannot see them for the first ~1-3 min.
    // P-005 launch-from-seats: resolve + ENFORCE the delegated seat cap and pin the
    // member launch to the slot's model:effort + gateway account (D-002/D-003). Placed
    // BEFORE the launch-slot claim so a seat refusal never burns the relaunch window.
    // Boot-time consumption (bootstrap-su → consumeSeatAtBoot, mig 487) is the durable
    // backstop that also refuses the N+1th member mid-race (P-006).
    let effAgent = agent;
    let effModel = memberModel;
    let effAccount = args.account?.trim() || undefined;
    let seatPin: { ref: string; delegated: number; consumedBefore: number; availableBefore: number } | null = null;
    if (seatsRequested) {
      let seatResolution;
      try {
        const availability = await seatAvailabilityForFleet({ workspaceId, fleetSlug });
        seatResolution = resolveSeatLaunch({ availability, count, seatRef: args.seat });
      } catch (e: any) {
        return err(`Failed to read fleet \`${fleetSlug}\`'s delegated seats: ${e?.message ?? e}`);
      }
      if (!seatResolution.ok) {
        return err(`[${seatResolution.refusal.code}] ${seatResolution.refusal.detail}`);
      }
      // The slot's model rides the SAME agent/model coupling as an explicit arg (a
      // local/gateway slot model implies the omp backend, etc.).
      const re = resolveFleetAgent({
        argAgent: args.agent,
        argModel: seatResolution.launch.model,
        callerAgent,
        callerModel,
      });
      if ('error' in re) return err(re.error);
      effAgent = re.agent;
      effModel = re.model;
      effAccount = seatResolution.launch.account;
      seatPin = {
        ref: seatResolution.slot.ref,
        delegated: seatResolution.slot.quantity,
        consumedBefore: seatResolution.slot.consumed,
        availableBefore: seatResolution.slot.available,
      };
    }
    // An omitted account is an explicit product default, not a platform heuristic:
    // every member uses the system/CLI credential unless the owner selected auto
    // or a named pool account. Existing account/seat choices always win.
    effAccount = defaultMemberAccountRouting(effAccount);

    // EI-20362893066852316: a codex wave launched with a model the ChatGPT backend refuses
    // boots EVERY member into a hard per-turn refusal that only the member terminals see
    // (burned a 4-member wave on bare 'gpt-5.6', 2026-08-13). ONE tiny streaming request
    // answers "will this subscription serve this model?" BEFORE any terminal opens.
    // FAIL-OPEN: only a definitive model-refusal blocks; auth/capacity/transport trouble
    // proceeds with a warning (the preflight must never become a new way to fail a launch).
    let codexPreflightWarning: string | null = null;
    if (effAgent === 'codex' && effModel) {
      try {
        const { preflightCodexModel, resolveCodexPreflightHome } =
          await import('../../inference-gateway/codex-oauth-proxy');
        const home = await resolveCodexPreflightHome(effAccount, workspaceId);
        if (home) {
          const { parseBridgeModel } = await import('../../inference-gateway/codex-cli-bridge');
          const bareModel = parseBridgeModel(effModel).id;
          const pf = await preflightCodexModel(home, bareModel);
          if (pf.verdict === 'refused') {
            return err(
              `Codex model preflight REFUSED '${bareModel}' on account '${effAccount ?? 'default'}' — the ChatGPT backend answered: ${pf.detail} ` +
                `NO terminals were opened (a wave on this model would fail every turn). Working ids on this subscription are family-suffixed ` +
                `(e.g. gpt-5.6-sol, gpt-5.6-terra); verify one with a 1-turn probe: codex exec -m <id> 'Reply OK'.`,
            );
          }
          if (pf.verdict === 'unknown') {
            codexPreflightWarning = `codex model preflight inconclusive (${pf.detail}) — proceeding fail-open`;
          }
        }
      } catch (e) {
        codexPreflightWarning = `codex model preflight errored (${(e as Error).message}) — proceeding fail-open`;
      }
    }

    let slot;
    let resumeOwnerIds: string[] | null = null;
    try {
      slot = await claimFleetLaunchSlot({
        workspaceId,
        fleetSlug,
        count,
        windowMs: RELAUNCH_SUPPRESS_MS,
        allowCountIncreaseWithinWindow: leaderRole === 'leader' && liveMembers > 0,
      });
    } catch (e: any) {
      return err(`Failed to check the fleet's launch guard: ${e?.message ?? e}`);
    }
    if (!slot.won && deadWaveSlotOverride({ priorAtMs: slot.priorAt, nowMs: Date.now(), liveMembers })) {
      // EI-20361787885323735: the slot is held by a wave with ZERO live members past the boot
      // gap — an owner-killed (or otherwise dead-on-arrival) wave. The guard exists to stop
      // DOUBLE-waves onto a LIVE fleet; protecting a corpse wave for the rest of the window
      // is the bug (refused legitimate corrective relaunches twice on 2026-08-13). Release
      // the corpse's claim and re-claim; any failure falls through to the normal suppression.
      try {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.priorAt });
        slot = await claimFleetLaunchSlot({
          workspaceId,
          fleetSlug,
          count,
          windowMs: RELAUNCH_SUPPRESS_MS,
          allowCountIncreaseWithinWindow: leaderRole === 'leader' && liveMembers > 0,
        });
      } catch {
        /* keep the lost slot — the window self-heals */
      }
    }
    if (priorLaunchTransaction?.state === 'partial') {
      // EI-20497372063255974: a canary may miss the bounded verifier and then take its
      // first real turn seconds later. The launch transaction already proves that ONLY
      // its first wave opened; its recovery set holds the exact pre-pinned identities
      // that were never opened. Once every opened identity is now LIVE, continuing that
      // same transaction cannot double-spawn the prior wave. Reclaim a still-held slot
      // when necessary and resume only when the unopened identity count exactly equals
      // the current live deficit. This must run for BOTH slot outcomes: after the
      // 300-second suppression window expires, claimFleetLaunchSlot returns won=true,
      // and skipping this branch would mint a new identity set and transaction ledger.
      const opened = new Set(priorLaunchTransaction.openedMemberIds);
      const live = new Set(liveMemberOwnerIds);
      const unopenedRetryOwnerIds = priorLaunchTransaction.recovery.retryOwnerIds.filter(
        (memberOwnerId) => !opened.has(memberOwnerId),
      );
      const openedWaveRecovered = opened.size > 0 && [...opened].every((memberOwnerId) => live.has(memberOwnerId));
      if (openedWaveRecovered && unopenedRetryOwnerIds.length === requestedOpenCount) {
        if (!slot.won) {
          try {
            await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.priorAt });
            slot = await claimFleetLaunchSlot({
              workspaceId,
              fleetSlug,
              count,
              windowMs: RELAUNCH_SUPPRESS_MS,
              allowCountIncreaseWithinWindow: leaderRole === 'leader' && liveMembers > 0,
            });
          } catch {
            /* keep the lost slot — the window self-heals */
          }
        }
        if (slot.won) resumeOwnerIds = unopenedRetryOwnerIds;
      }
    }
    if (!slot.won) {
      const agoS = Math.max(1, Math.round((Date.now() - slot.priorAt) / 1000));
      // EI-20438033749915749: the launch-slot count is the requested target, while the
      // persisted transaction records how many terminals actually opened. A partial wave
      // must not tell the leader that its unopened identities already have terminals.
      const priorOpenedCount = priorLaunchTransaction?.openedMemberIds.length ?? slot.priorCount;
      const lines = [
        `Fleet \`${fleetSlug}\` was already launched — ${priorOpenedCount} member${priorOpenedCount === 1 ? '' : 's'} opened ${agoS}s ago (possibly by this very session).`,
        'You ARE the leader; do NOT call fleet:launch-on-plan again or fleet:take-leadership for this fleet — re-call only to add another wave once the current members have drained.',
        planSlug
          ? `Until the plan \`${planSlug}\` is drained, your standing job each cycle:`
          : `Until your fleet \`${fleetSlug}\` claim-lane is drained, your standing job each cycle:`,
      ];
      LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      lines.push(
        'Those members were launched with this MEMBER OPERATING BASELINE (do NOT re-issue or contradict it; a later custom brief still layers below it):',
      );
      MEMBER_BASELINE_RULES.forEach((rule, i) => lines.push(`  ${i + 1}. ${rule.head}`));
      return json({
        ok: true,
        fleet: fleetSlug,
        leaderRole,
        callerMembership,
        leaderSpawnIgnored: leaderSpawnSkipped,
        plan: planSlug,
        harness,
        agent: effAgent,
        account: effAccount ?? null,
        seats: seatPin ? { ...seatPin, requested: count } : null,
        requested: count,
        sizingAdvisory: null,
        memberBaselineApplied: false,
        claimSpecApplied,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath: null,
        perMemberLaunchContextPaths: null,
        briefReadError: null,
        opened: [],
        failed: [],
        relaunchSuppressed: true,
        message: lines.join('\n'),
      });
    }

    const claimSpecResult = await applyFleetClaimSpec();
    claimSpecApplied = claimSpecResult.claimSpecApplied;
    if (claimSpecResult.claimCollapseRefusal) {
      return refuseClaimCollapseAfterSlot(slot.at, claimSpecResult.claimCollapseRefusal);
    }

    // Compose every member's launch context = the universal MEMBER OPERATING
    // BASELINE + (optionally) the leader's per-fleet brief below it. Written to the
    // workspace's launch-context dir (NON-repo — never the staging tree, which
    // git-sync would try to commit) and passed to psu as each member's appended
    // system prompt. An unreadable caller-supplied path is a preflight failure:
    // launching members with a materially different brief is worse than refusing
    // before any irreversible terminal spawn. Compose/write failures still fall
    // back to the raw launchContext because those do not make the supplied path
    // unreadable.
    const refuseUnreadableLaunchContext = async (message: string) => {
      try {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
      } catch {
        /* the guard self-heals when the window elapses */
      }
      return err(`${message} No members were opened.`);
    };
    let effectiveLaunchContext = args.launchContext?.trim() || undefined;
    let memberLaunchContextPath: string | null = null;
    let baselineApplied = false;
    let briefReadError: string | null = null;
    let sharedBriefText: string | null = args.brief?.trim() || null;
    try {
      if (!sharedBriefText && effectiveLaunchContext) {
        if (looksLikeInlineLaunchContextText(effectiveLaunchContext)) {
          // EI-19276371920501216: this is brief TEXT, not a path — use it directly
          // instead of handing it to readFileSync (ENAMETOOLONG). It still lands in
          // the composed baseline file below, so `effectiveLaunchContext` gets
          // reassigned to the WRITTEN file path either way (never the raw text).
          sharedBriefText = effectiveLaunchContext;
        } else {
          try {
            sharedBriefText = readFileSync(effectiveLaunchContext, 'utf8');
          } catch (e: any) {
            return refuseUnreadableLaunchContext(
              `Could not read launchContext \`${effectiveLaunchContext}\` (${e?.message ?? e}) — refusing the launch to avoid briefing members with the baseline only.`,
            );
          }
        }
      }
      const composed = composeMemberLaunchContext({
        fleetSlug,
        plan: planSlug,
        count,
        carry: args.carry,
        customBriefText: sharedBriefText,
        goalAllocation,
      });
      const ctxDir = join(papercuspPathForWorkspace(workspaceId), 'launch-context');
      mkdirSync(ctxDir, { recursive: true });
      const ctxPath = join(ctxDir, `fleet-${fleetSlug}-launch-context.md`);
      writeFileSync(ctxPath, composed, 'utf8');
      effectiveLaunchContext = ctxPath;
      memberLaunchContextPath = ctxPath;
      baselineApplied = true;
    } catch {
      // Compose/write failed — fall back to the raw launchContext (or none). The
      // launch still proceeds; the baseline just isn't prepended this time.
      baselineApplied = false;
    }

    // EI-8985: per-member DISTINCT launch-context briefs (index 0 → member 1, …).
    // Each member gets its OWN composed file (baseline + that member's brief, falling
    // back to the shared brief above when its entry is missing/unset) — this is the
    // knob whose absence used to force a hand-rolled fleet:create + capability:terminal
    // launch (EI-5835 / su.md D). An unreadable per-member path refuses the whole
    // launch before any terminal opens; compose/write failures for ONE member still
    // fall that member back to the shared `effectiveLaunchContext` and are surfaced.
    const perMemberBriefsRaw = args.perMemberLaunchContext;
    // P-002: `members[i].brief` (inline TEXT) and `members[i].launchContext` (a path)
    // are the declarative twins of perMemberLaunchContext, so any of the three arms
    // the per-member compose path below. Inline brief text wins over a path entry —
    // the caller supplied the actual words, not a pointer to them.
    const memberSpecIndex = (i: number) => memberSpecIndexForLaunch(liveMembers, i);
    const memberBriefText = (i: number): string | null => args.members?.[memberSpecIndex(i)]?.brief?.trim() || null;
    const anyMemberBrief = (args.members ?? []).some((m) => m?.brief?.trim());
    // P-004: a per-member `carry` override also forces a DISTINCT composed baseline for that
    // member — the warm/cold loop:arm instruction is baked into the baseline TEXT, so it arms
    // the per-member compose path exactly as a distinct brief does. Without this, `members[i].carry`
    // is folded but never reaches the member: the fleet-wide `args.carry` baseline is all it sees.
    const anyMemberCarry = (args.members ?? []).some((m) => m?.carry);
    const perMemberComposeActive = Boolean(perMemberBriefsRaw?.length) || anyMemberBrief || anyMemberCarry;
    const perMemberLaunchContextPaths: (string | null)[] | null = perMemberComposeActive ? [] : null;
    const perMemberReadErrors: string[] = [];
    const perMemberReadFailures: string[] = [];
    let memberLaunchContextPathForIndex: (i: number) => string | undefined = () => effectiveLaunchContext;
    // EI-18862608742257943: every brief text a member actually receives, collected so the
    // kickoff-vs-claim-spec check below (after this block) can scan ALL of them for a named
    // WI-/EI- id — the shared brief always counts; each member's OWN resolved brief (inline
    // `members[i].brief`, a `perMemberLaunchContext[i]` file, or the shared fallback) is added
    // per iteration when a per-member compose is active.
    const kickoffBriefTexts: (string | null)[] = [sharedBriefText];
    if (perMemberComposeActive) {
      const ctxDir = join(papercuspPathForWorkspace(workspaceId), 'launch-context');
      try {
        mkdirSync(ctxDir, { recursive: true });
      } catch {
        /* best-effort — a per-member write below falls back to the shared path if this failed */
      }
      const resolved: (string | undefined)[] = [];
      for (let i = 0; i < openCount; i++) {
        const specIndex = memberSpecIndex(i);
        const ownPath = perMemberBriefsRaw?.[specIndex]?.trim();
        // Inline `members[i].brief` short-circuits the file read entirely.
        let ownBriefText: string | null = memberBriefText(i);
        if (!ownBriefText && ownPath) {
          try {
            ownBriefText = readFileSync(ownPath, 'utf8');
          } catch (e: any) {
            const readFailure = `member ${i + 1}: could not read perMemberLaunchContext[${i}] \`${ownPath}\` (${e?.message ?? e})`;
            perMemberReadErrors.push(`${readFailure} — refusing the launch.`);
            perMemberReadFailures.push(readFailure);
          }
        }
        const briefText = ownBriefText ?? sharedBriefText;
        kickoffBriefTexts.push(briefText);
        try {
          const composed = composeMemberLaunchContext({
            fleetSlug,
            plan: planSlug,
            count,
            // P-004: member > fleet precedence for carry (foldMemberSpec's rule) — this member's
            // OWN warm/cold choice shapes ITS baseline, not the fleet-wide default.
            carry: args.members?.[specIndex]?.carry ?? args.carry,
            customBriefText: briefText,
            goalAllocation,
          });
          const ctxPath = join(ctxDir, `fleet-${fleetSlug}-launch-context-member-${specIndex + 1}.md`);
          writeFileSync(ctxPath, composed, 'utf8');
          resolved.push(ctxPath);
          perMemberLaunchContextPaths!.push(ctxPath);
        } catch (e: any) {
          // Per-member compose/write failed — this member falls back to the shared file.
          perMemberReadErrors.push(
            `member ${i + 1}: could not write its composed context (${e?.message ?? e}) — fell back to the shared brief.`,
          );
          resolved.push(effectiveLaunchContext);
          perMemberLaunchContextPaths!.push(null);
        }
      }
      memberLaunchContextPathForIndex = (i) => resolved[i] ?? effectiveLaunchContext;
    }
    if (perMemberReadErrors.length) {
      briefReadError = briefReadError
        ? `${briefReadError}\n${perMemberReadErrors.join('\n')}`
        : perMemberReadErrors.join('\n');
    }
    if (perMemberReadFailures.length) {
      return refuseUnreadableLaunchContext(
        `${perMemberReadFailures.join('\n')} — refusing the launch because every supplied brief path must be readable before spawning.`,
      );
    }

    // `members[i].launchContext` is the per-member path form of the same option.
    // It is passed directly to psu (unlike members[i].brief, which is composed here),
    // so validate every effective path before any leader/member terminal can open.
    const memberLaunchContextReadFailures: string[] = [];
    const memberSpecsForPreflight = args.members ?? [];
    for (let i = 0; i < Math.min(openCount, memberSpecsForPreflight.length); i++) {
      const ownLaunchContext = memberSpecsForPreflight[i]?.launchContext?.trim();
      if (!ownLaunchContext || looksLikeInlineLaunchContextText(ownLaunchContext)) continue;
      try {
        readFileSync(ownLaunchContext, 'utf8');
      } catch (e: any) {
        memberLaunchContextReadFailures.push(
          `member ${i + 1}: could not read members[${i}].launchContext \`${ownLaunchContext}\` (${e?.message ?? e})`,
        );
      }
    }
    if (memberLaunchContextReadFailures.length) {
      return refuseUnreadableLaunchContext(
        `${memberLaunchContextReadFailures.join('\n')} — refusing the launch because every supplied brief path must be readable before spawning.`,
      );
    }

    // EI-18862608742257943: does the claim spec THIS launch is about to apply actually
    // admit every WI-/EI- id the kickoff brief(s) name? A member kicked off with "your
    // only job is WI-xxxx" that then cannot claim WI-xxxx does the work anyway — unclaimed
    // (assignee stays NULL, fleet:assignments shows it holding nothing, the death-resilience
    // reclaim-on-death net never engages) — the free-text brief and the enforced claim spec
    // were authored independently and nothing reconciled them. Re-fetch the EFFECTIVE spec
    // fresh (rather than threading a local out of the claim-spec block above) so this checks
    // whatever actually landed, whichever of the preserve/merge/build branches ran above.
    // LOCAL placement only — a remote placement already returned earlier. FAILS OPEN: any
    // lookup error must never strand a launch, same philosophy as every other diagnostic in
    // this handler (poolEffect preview, degenerate-lane composition, …).
    try {
      const kickoffIds = extractKickoffWorkItemIds(kickoffBriefTexts);
      const claimSpecWorkspaceId = resolveClaimSpecWorkspace(workspaceId);
      if (kickoffIds.length > 0 && !args.confirmKickoffMismatch && claimSpecWorkspaceId) {
        const effectiveSpec = await getClaimSpec({
          cupId: fleetSpecBeeKey(fleetSlug),
          workspaceId: claimSpecWorkspaceId,
        });
        const { lookupWorkItem } = await import('../work_items/_lookup');
        const mismatches: string[] = [];
        const unreadable: string[] = [];
        for (const id of kickoffIds) {
          // WI-6746: `.catch(() => null)` here would collapse "the item is not there" with "I
          // could not ask", and a blip would then silently contribute NO mismatch — i.e. the
          // refusal below disappears exactly when the database is unhealthy. This site's posture
          // stays FAIL OPEN (a diagnosis must never strand a launch), so an unreadable id is not
          // escalated to a refusal — but it is REPORTED, so the launch never claims a clean
          // pre-check it did not actually get.
          const lookup = await lookupWorkItem(id, harness);
          if (lookup.status === 'unreadable') {
            unreadable.push(`${id} (${lookup.error})`);
            continue;
          }
          if (lookup.status === 'missing') continue; // genuinely not there — the claim call 404s on its own
          const item = lookup.item;
          if (TERMINAL_WORK_ITEM_STATES.has(String(item.state ?? '').toLowerCase())) continue; // already finished — nothing to claim
          const matches = await itemMatchesRawClaimSpec(item, effectiveSpec, claimSpecWorkspaceId);
          if (!matches) mismatches.push(id);
        }
        if (unreadable.length > 0) {
          const note =
            `KICKOFF/CLAIM-SPEC PRE-CHECK INCOMPLETE (WI-6746): could not read ${unreadable.join(', ')} — ` +
            `${unreadable.length === 1 ? 'that id was' : 'those ids were'} NOT checked against the claim spec ` +
            `(${formatSpecRef(effectiveSpec.specId, effectiveSpec.revision)}), so this launch proceeded WITHOUT ` +
            `a verdict on ${unreadable.length === 1 ? 'it' : 'them'}. If a member cannot claim what its brief ` +
            `names, widen the spec (scheduler:set_claim_spec { fleet: "${fleetSlug}", … }) or re-launch once the ` +
            `read succeeds.`;
          briefReadError = briefReadError ? `${briefReadError}\n${note}` : note;
        }
        if (mismatches.length > 0) {
          try {
            await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
          } catch {
            /* best-effort — a release failure must not mask the real refusal below */
          }
          return err(
            `KICKOFF/CLAIM-SPEC MISMATCH (EI-18862608742257943): the brief(s) this launch would hand its ` +
              `members name ${mismatches.join(', ')}, but the claim spec this launch is about to apply ` +
              `(${formatSpecRef(effectiveSpec.specId, effectiveSpec.revision)}) does not admit ` +
              `${mismatches.length === 1 ? 'it' : 'them'} — a member told "${mismatches[0]} is your only job" ` +
              `would be UNABLE to work_items:claim it (fleet_scope_violation), so it would do the work anyway ` +
              `unclaimed: assignee stays NULL, fleet:assignments shows it holding nothing, and the ` +
              `death-resilience reclaim-on-death net never engages. NO members were opened. Either widen the ` +
              `spec first (scheduler:set_claim_spec { fleet: "${fleetSlug}", spec: <a revision whose ` +
              `view.filter admits ${mismatches.join(', ')}> }), drop the id from the brief, or re-send with ` +
              `confirmKickoffMismatch:true if the brief only mentions it for context.`,
          );
        }
      }
    } catch {
      /* a diagnosis must never strand a launch — fail open */
    }

    // Base envelope (cwd/env) once — skip the superuser .mcp.json (each member's psu
    // bootstraps its own MCP), exactly like capability:terminal.
    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug: harness,
        operatorBaseUrl: resolveOperatorBaseUrl(),
        skipMcpJson: true,
      });
    } catch (e: any) {
      return err(`Failed to prepare the fleet terminals: ${e?.message ?? e}`);
    }

    // The fleet's bound color scheme (cosmetic — a lookup failure never blocks launch).
    // Skipped entirely for a headless launch: there is no window to color (P-003).
    let scheme: ColorScheme | null = null;
    if (!args.headless) {
      try {
        scheme = await getFleetScheme(workspaceId, fleetSlug);
      } catch {
        scheme = null;
      }
    }

    // EI-8985: build each member's OWN command — identical for every member unless
    // perMemberLaunchContext gave member i its own composed context file, in which
    // case only its `--launch-context` differs.
    // per-member-declarative-launch-specs P-002: the fleet-wide launch defaults each
    // member's OWN spec folds over (D-001 precedence: member > fleet > system). Before
    // this, every member necessarily shared one command apart from --launch-context;
    // now `members[i]` can differ in model/effort/account/limit/role/lane/anything.
    // ── Per-goal launch settings + the D-005 ceilings (P-004/D-009) ───────────
    // Resolved from the LEADER, not from an argument: a fleet launched by an
    // agent working under a goal is that goal's fleet, and every member counts
    // against BOTH the goal's total and this fleet's own cap — which is the whole
    // point of D-005's two composing ceilings. `openCount` (post-capacity-clamp)
    // is passed whole so an over-large fleet is refused once, here, rather than
    // part-way through spawning.
    const requestedGoalProfile = {
      // Only an authored/saved/seat-pinned choice outranks goal settings. The
      // backend/model inherited from the CALLER is a system fallback, not a
      // contextual decision by the GOAL holder; treating it as requested made
      // every goal role profile lose silently.
      ...(args.agent || seatsRequested ? { agent: effAgent as 'claude' | 'codex' | 'omp' } : {}),
      ...(args.account || seatsRequested ? { account: effAccount } : {}),
      ...(args.model || seatsRequested ? { model: effModel } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.carry ? { carry: args.carry } : {}),
      ...(args.contextSize ? { contextSize: args.contextSize } : {}),
      ...(args.compactionLimit ? { compactionLimit: args.compactionLimit } : {}),
      ...(args.headless !== undefined ? { headless: args.headless } : {}),
    };
    const goalLaunch = await resolveGoalLaunch({
      workspaceId,
      launcherOwnerId: ownerId,
      // D-016 (WI-38048): the launch SLOT, not psu `--role`. This door opens the
      // MEMBERS of a plan fleet, so that is the slot whose profile applies, and
      // the folded result rides down as fleetDefaults below. Passing `args.role`
      // here — psu's persona selector, `su` for ~every session — was the bug:
      // `settings.roles` is keyed by contract slot, so the lookup matched nothing
      // and every profile the owner configured was silently ignored.
      // P-006 / D-005 — the slot is DERIVED, not hardcoded, and it is derived
      // from `launchFleetType` (the AUTHORITATIVE type re-read off the registry
      // row) rather than from the provisional overlay: a top-up joins an
      // existing fleet whose stored type wins over whatever this call asked for.
      //
      // On a SINGLE fleet that is the member slot for this fleet's family —
      // `plan-fleet-member`, or `drain-fleet-member` when this IS the goal's
      // declared drain fleet (mirroring resolveFleetHeadcountLaunchRole, whose
      // fix EI-20219409083169975 was exactly this derivation for the governor).
      //
      // On a PAIRED fleet it is deliberately NULL. This one fold feeds
      // `fleetDefaults`, which EVERY member inherits, so folding either the
      // director or the implementer profile here would broadcast one role's
      // model/account/carry to both — the precise coercion pair-launch-options
      // refuses one layer down, smuggled back in one layer up. The per-role
      // profiles reach their seats through `members[]` instead, where the
      // member > fleet precedence keeps them apart.
      goalRole: goalFleetWideFoldSlot(goalOverlay.family, launchFleetType),
      fleetSlug,
      count: openCount,
      requested: requestedGoalProfile,
    });
    if (goalLaunch.refusal) {
      return err(goalLaunch.refusal.message);
    }

    const launchFallbackDefaults: FleetMemberDefaults = {
      agent: effAgent,
      headless: args.headless ?? undefined,
      account: effAccount,
      effort: args.effort,
      launchMode,
      // The caller's request scope is already resolved above. Always stamp that
      // authoritative workspace onto the psu command: omitting the flag makes a
      // fleet member inherit the operator process's workspace (commonly
      // `default`), so its first warm wake loses the harness it was launched to
      // drain even though the fleet/claim rows live in the correct workspace.
      workspace: workspaceId,
      role: args.role?.trim() || undefined,
      stack: args.stack,
      model: effModel,
      modelSource: seatsRequested ? 'inherited' : memberModelSource,
      seat: seatPin?.ref,
      feature: args.feature?.trim() || undefined,
      profile: args.profile?.trim() || undefined,
      contextSize: args.contextSize,
      compactionLimit: args.compactionLimit,
      carry: args.carry,
      claimKinds: args.claimKinds,
      brain: args.brain || undefined,
      addDir: args.addDir,
      allowSubagents: args.allowSubagents || undefined,
      extraArgs: args.extraArgs,
    };
    // WI-2146552: `resolveGoalLaunch` already folded defaults + the member
    // slot + the caller's contextual choice. Apply the WHOLE profile to the
    // actual member command defaults; the previous inline mapping dropped its
    // `model` while claiming the goal profile was applied.
    const fleetDefaults = applyGoalLaunchProfileToDefaults(
      launchFallbackDefaults,
      goalLaunch.effective,
    );
    // The spawned leader is a distinct launch slot. It inherits goal defaults,
    // then the plan/drain leader profile, then this launch's explicit choices;
    // member role settings must never leak upward into the leader command.
    const leaderProfile = goalFleetLeaderProfile({
      settings: goalSettings.settings,
      family: goalOverlay.family,
      requested: requestedGoalProfile,
    });
    const leaderDefaults = applyGoalLaunchProfileToDefaults(
      launchFallbackDefaults,
      leaderProfile,
    );
    const memberSpecs: (MemberSpec | undefined)[] = args.members ?? [];
    /** The folded, fully-resolved config for member `i` (0-indexed). */
    const resolvedMemberConfig = (i: number): FleetMemberDefaults => foldMemberSpec(fleetDefaults, memberSpecs[i]);
    const requestedMemberIds = resumeOwnerIds ?? Array.from({ length: openCount }, () => `su-${randomUUID()}`);
    // A partial replay opens only the unresolved identities in `requestedMemberIds`, but
    // its durable transaction must retain the original cohort/history. Replacing the
    // transaction here would make fleet:status lose the only recovery ledger and cause
    // the next retry to mint another set of owner IDs.
    // ── P-004 / D-016(b): CONFINE EACH IMPLEMENTER BEFORE IT EXISTS ──────────────────
    // The confinement is keyed on the coord ownerId, and `requestedMemberIds` is where the
    // launcher MINTS those ids — so this is the first moment the key is known, and it is
    // still before any process has been spawned. That ordering is the whole mechanism
    // (D-017 §4): the resolver reads a sync cache and a cold miss reads as "unconfined",
    // which cannot be made fail-closed (unconfined is the default for every session in the
    // fleet). Writing here means the row — and this process's cache entry — exist before the
    // confined session does, so there is no window rather than a small one.
    //
    // FAIL-HARD, unlike the auto-coupling block far below. That one is fail-soft because by
    // the time it runs the members are already live, and reporting a failed launch for a
    // fleet that opened is worse than an uncoupled pair the result names. Here nothing has
    // spawned yet, so refusing costs only the launch — while continuing would open an
    // implementer that can complete its own work items and arm its own loops, which is
    // exactly the theatre this line of work exists to end, and would do it invisibly.
    // A RESUME is skipped deliberately, and it cannot leave a hole: this block runs before the
    // launch transaction exists, so a refusal here returns with nothing spawned and nothing to
    // resume. Reaching a resume therefore PROVES the confinements were already declared. The
    // skip also avoids a real hazard — a partial replay carries only the unresolved identities,
    // so `liveMembers + i` no longer maps to the original seats, and re-deriving roles from it
    // could confine a DIRECTOR.
    if (launchFleetType === 'paired' && !resumeOwnerIds) {
      const preSpawnSeatOwners = new Map<number, string>();
      requestedMemberIds.forEach((ownerId, i) => preSpawnSeatOwners.set(liveMembers + i, ownerId));
      const engagementScope = planSlug ?? fleetSlug;
      for (const seat of implementersToConfine(preSpawnSeatOwners)) {
        const declared = await declareSessionConfinement({
          ownerId: seat.implementer,
          confinement: directedImplementerConfinement({
            directorSid: seat.director ?? `the pair-director for pair ${seat.pairIndex}`,
            scope: engagementScope,
          }),
        });
        if (!declared.ok) {
          return err(
            `refusing to launch: could not confine the implementer in pair ${seat.pairIndex} ` +
              `(${seat.implementer}) — ${declared.reason}. An implementer that launches ` +
              `unconfined can complete its own work items and select its own work, which is ` +
              `the failure the paired fleet exists to prevent. Nothing was spawned.`,
          );
        }
      }
    }
    const resumedLaunchTransaction = resumeOwnerIds && priorLaunchTransaction ? priorLaunchTransaction : null;
    const transactionRequestedMemberIds = resumedLaunchTransaction?.requestedMemberIds ?? requestedMemberIds;
    let memberCommands: string[];
    try {
      memberCommands = Array.from({ length: openCount }, (_v, i) => {
        const folded = resolvedMemberConfig(memberSpecIndex(i));
        const rawCommand = memberLaunchCommand({
          ...folded,
          fleetSlug,
          harness,
          plan: planSlug ?? undefined,
          ownerId: requestedMemberIds[i],
          // The member's own brief file wins over the shared/per-member-path fallback.
          // Carry behavior comes from that baseline, while the psu flag is its durable
          // attestation token in adv_sessions.launch_argv.
          carry: folded.carry ?? 'warm',
          launchContext: folded.launchContext ?? memberLaunchContextPathForIndex(i),
        });
        return injectLaunchedByArg(rawCommand, ownerId).command;
      });
    } catch (error) {
      // Command composition is still pre-spawn validation. A malformed effective
      // model/effort pair used to escape the handler here, after the launch slot and
      // headcount recipe had been persisted. That left the next retry reading the
      // requested count as if those terminals had opened and suppressing the real
      // launch. Roll back the slot and report the composition failure explicitly.
      try {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
      } catch {
        /* the launch guard self-heals when its window elapses */
      }
      return err(
        `Could not compose fleet member launch command for \`${fleetSlug}\`: ${
          error instanceof Error ? error.message : String(error)
        }. No members were opened.`,
      );
    }

    // D-008 / WI-41145: a brand-new homogeneous plan fleet must immediately own
    // the same durable recipe that later top-ups and the headcount governor use.
    // Per-member declarations and paired fleets are intentionally excluded: one
    // FleetHeadcountConfig cannot represent their heterogeneous boot settings.
    // Keep this write AFTER command composition: an invalid effective model/effort
    // pair must not leave a governor recipe for a launch that never reached spawn.
    if (
      freshFleetCreated &&
      Boolean(planSlug) &&
      launchFleetType !== 'paired' &&
      memberSpecs.length === 0 &&
      !(args.perMemberLaunchContext && args.perMemberLaunchContext.length > 0)
    ) {
      // A supplied launchContext may be inline brief text. The member command
      // above never forwards that raw value: composeMemberLaunchContext writes
      // the effective brief to a readable file and memberLaunchContextPath is
      // the path actually handed to psu. Persist that canonical path as well;
      // otherwise a later governor/respawn refill replays the inline prose as
      // --launch-context and the replacement dies while opening its profile.
      const requestedLaunchContext = args.launchContext?.trim();
      const persistedLaunchContext = requestedLaunchContext
        ? memberLaunchContextPath ??
          (looksLikeInlineLaunchContextText(requestedLaunchContext) ? undefined : effectiveLaunchContext)
        : undefined;
      if (requestedLaunchContext && !persistedLaunchContext) {
        try {
          await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
        } catch {
          /* the guard self-heals when the window elapses */
        }
        return err(
          `Could not persist the fresh fleet launch profile for \`${fleetSlug}\`: ` +
            'the supplied inline launchContext did not produce a canonical readable context file. No members were opened.',
        );
      }
      const modelSpec = composeModelSpec(fleetDefaults.model, fleetDefaults.effort) ?? null;
      const split = splitModelSpec(modelSpec);
      const config = normalizePersistedFleetLaunchConfig({
        plan: planSlug!,
        harness,
        agent: (fleetDefaults.agent ?? effAgent) as FleetHeadcountConfig['agent'],
        ...(split.model ? { model: split.model } : {}),
        ...(split.effort ? { effort: split.effort } : {}),
        ...((fleetDefaults.account ?? effAccount) ? { account: fleetDefaults.account ?? effAccount } : {}),
        headless: args.headless ?? true,
        ...(args.role?.trim() ? { role: args.role.trim() } : {}),
        ...(args.brief?.trim() ? { brief: args.brief.trim() } : {}),
        ...(persistedLaunchContext ? { launchContext: persistedLaunchContext } : {}),
        ...(args.contextSize ? { contextSize: args.contextSize } : {}),
        ...(args.compactionLimit != null ? { compactionLimit: args.compactionLimit } : {}),
        carry: args.carry ?? 'warm',
        ...(args.extraArgs ? { extraArgs: [...args.extraArgs] } : {}),
        // R5: an explicit supervise grant/revoke rides the fresh-recipe persist.
        ...(args.supervise != null ? { supervise: args.supervise } : {}),
      });
      try {
        await setFleetHeadcountTarget({ workspaceId, fleetSlug, target: count, config });
        persistedHeadcountProfile = { target: count, config };
      } catch (error) {
        try {
          await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
        } catch {
          /* the launch guard self-heals when its window elapses */
        }
        return err(
          `Could not persist the fresh fleet launch profile for \`${fleetSlug}\`: ${
            error instanceof Error ? error.message : String(error)
          }. No members were opened.`,
        );
      }
    }

    // R5 (interrupted-member-recovery-hardening-2026-09-01): deliver an explicit
    // per-fleet supervise grant/revoke. A fresh homogeneous fleet already carries it
    // on the recipe persisted just above (no second write); an existing fleet's
    // durable row is rewritten in place when it is ENABLED; anything else is
    // REPORTED on the result as `superviseGrant.persisted:false` — never silently
    // dropped ("reads as configured while binding nothing" is the D-016/WI-38048
    // failure class). Ordered before the wave opens so a member launched under a
    // fresh grant is governed from its first tick, and kept INDEPENDENT of the
    // wave: a grant write failure is reported, it does not abort a launch that can
    // still open. The branch logic lives in `resolveSuperviseGrant` (pure, tested).
    let superviseGrant: { requested: boolean; persisted: boolean; reason: string } | null = null;
    if (args.supervise != null) {
      let existing: FleetHeadcountTarget | null = null;
      let existingReadError: string | null = null;
      if (persistedHeadcountProfile?.config.supervise !== args.supervise) {
        try {
          existing = await getFleetHeadcountTarget(workspaceId, fleetSlug);
        } catch (error) {
          existingReadError = error instanceof Error ? error.message : String(error);
        }
      }
      const resolution = resolveSuperviseGrant({
        supervise: args.supervise,
        profile: persistedHeadcountProfile,
        existing,
      });
      if (resolution) {
        const { write, ...outcome } = resolution;
        superviseGrant =
          existingReadError && !outcome.persisted
            ? { ...outcome, reason: `could not read the fleet headcount row (${existingReadError}); ${outcome.reason}` }
            : outcome;
        if (write) {
          try {
            await setFleetHeadcountTarget({ workspaceId, fleetSlug, target: write.target, config: write.config });
            persistedHeadcountProfile = { target: write.target, config: write.config };
          } catch (error) {
            superviseGrant = {
              ...outcome,
              persisted: false,
              reason: `could not rewrite the fleet headcount row: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        }
      }
    }

    const launchRequestedAt = Date.now();
    const expectedAttestations: FreshLaunchExpectedAttestation[] = Array.from({ length: openCount }, (_v, i) => {
      const folded = resolvedMemberConfig(memberSpecIndex(i));
      const modelSpec = composeModelSpec(folded.model, folded.effort) ?? null;
      return {
        ownerId: requestedMemberIds[i],
        agent: folded.agent,
        workspaceId,
        harnessSlug: harness,
        planSlug: planSlug ?? null,
        model: modelSpec,
        modelSource: folded.agent === 'codex' ? (folded.modelSource ?? null) : null,
        effort: modelEffortFromSpec(modelSpec),
        account: folded.account ?? 'default',
        carry: folded.carry ?? 'warm',
        visibility: folded.headless ? 'headless' : 'visible',
        fleetSlug,
        fleetRole: 'member',
      };
    });
    // Back-compat: `command` (singular) is reported/reused where every member is
    // identical (the common case — no perMemberLaunchContext).
    const command = memberCommands[0] ?? '';
    // P-004 per-member disclosure: the fully-resolved config each member actually got
    // (precedence member > fleet > system), so the leader confirms it WITHOUT diffing raw
    // command strings. Only built when a declarative `members` spec was passed (a homogeneous
    // launch needs no breakdown). model/account/compactionLimit also ride the psu command;
    // `carry` does NOT (it shapes the baseline text), so this is the ONLY surface a per-member
    // carry override is visible on. composeModelSpec here can't throw: the identical (model,
    // effort) pair already succeeded inside memberLaunchCommand when memberCommands was built.
    const resolvedMembers = memberSpecs.length
      ? Array.from({ length: openCount }, (_v, i) => {
          const f = resolvedMemberConfig(memberSpecIndex(i));
          return {
            member: i + 1,
            model: composeModelSpec(f.model, f.effort) ?? null,
            account: f.account ?? null,
            carry: (memberSpecs[memberSpecIndex(i)]?.carry ?? args.carry ?? 'warm') as 'warm' | 'cold',
            compactionLimit: f.compactionLimit ?? null,
            claimKinds: f.claimKinds ?? null,
          };
        })
      : null;
    const opened: Array<{
      ownerId: string;
      terminal: string;
      pid: number | null;
      display: string | null;
      desktopEnvResolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | 'caller-override' | null;
      command: string;
    }> = [];
    const failed: Array<{ ownerId?: string; error: string; code: number }> = [];
    let persistedLaunchRevision = priorLaunchTransaction
      ? {
          transactionId: priorLaunchTransaction.transactionId,
          updatedAt: priorLaunchTransaction.updatedAt,
        }
      : null;
    const launchTransaction: FleetLaunchTransaction = {
      ...(resumedLaunchTransaction
        ? {
            ...resumedLaunchTransaction,
            state: 'launching' as const,
            updatedAt: launchRequestedAt,
            openedMemberIds: resumedLaunchTransaction.openedMemberIds.slice(),
            verifiedMemberIds: resumedLaunchTransaction.verifiedMemberIds.slice(),
            failed: resumedLaunchTransaction.failed.map((failure) => ({ ...failure })),
            waves: resumedLaunchTransaction.waves.map((wave) => ({
              ...wave,
              ownerIds: wave.ownerIds.slice(),
              ...(wave.openedOwnerIds ? { openedOwnerIds: wave.openedOwnerIds.slice() } : {}),
              ...(wave.verifiedOwnerIds ? { verifiedOwnerIds: wave.verifiedOwnerIds.slice() } : {}),
            })),
            recovery: { ...resumedLaunchTransaction.recovery },
            ...(resumedLaunchTransaction.unconfirmedMemberIds
              ? { unconfirmedMemberIds: resumedLaunchTransaction.unconfirmedMemberIds.slice() }
              : {}),
          }
        : {
            version: 1 as const,
            transactionId: randomUUID(),
            state: 'launching' as const,
            requestedAt: launchRequestedAt,
            updatedAt: launchRequestedAt,
            requestedMemberIds: transactionRequestedMemberIds,
            openedMemberIds: [],
            verifiedMemberIds: [],
            failed: [],
            waves: [],
            recovery: {
              retryOwnerIds: requestedMemberIds.slice(),
              nextAction:
                'resume from the first unresolved pre-pinned member identity; never relaunch verified members',
            },
            requestedMembers: Array.from({ length: openCount }, (_v, i) => {
              const folded = resolvedMemberConfig(i);
              return {
                index: i,
                ownerId: requestedMemberIds[i],
                agent: folded.agent,
                model: composeModelSpec(folded.model, folded.effort) ?? null,
                account: folded.account ?? 'default',
                carry: memberSpecs[i]?.carry ?? args.carry ?? 'warm',
                headless: !!args.headless,
              };
            }),
          }),
    };
    launchTransaction.launcherOwnerId = ownerId;
    const refreshLaunchRecovery = (): void => {
      const verified = new Set(launchTransaction.verifiedMemberIds);
      launchTransaction.recovery.retryOwnerIds = transactionRequestedMemberIds.filter((id) => !verified.has(id));
      launchTransaction.updatedAt = Math.max(
        Date.now(),
        persistedLaunchRevision?.transactionId === launchTransaction.transactionId
          ? persistedLaunchRevision.updatedAt + 1
          : launchTransaction.updatedAt,
      );
    };
    const persistLaunchTransaction = async (): Promise<void> => {
      refreshLaunchRecovery();
      const persisted = await setFleetLaunchTransaction({
        workspaceId,
        fleetSlug,
        transaction: launchTransaction,
        expectedRevision: persistedLaunchRevision,
      });
      if (persisted === false) {
        throw new Error('the durable launch transaction changed concurrently; re-read fleet:status before retrying');
      }
      persistedLaunchRevision = {
        transactionId: launchTransaction.transactionId,
        updatedAt: launchTransaction.updatedAt,
      };
    };
    try {
      await persistLaunchTransaction();
    } catch (e: any) {
      try {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
      } catch {
        /* compare-and-set release: a newer launch claim, if any, remains untouched */
      }
      return err(
        `Failed to persist the fleet launch transaction before spawning (${e?.message ?? e}) — NO members were opened.`,
      );
    }
    // Concurrent spawns: spawnConsole is async since WI-1886 (it verifies each
    // window survives an early-exit probe instead of reporting ok+pid for a
    // client that died off-screen) — a serial loop would stack N probe windows.
    // P-003: a headless launch routes each member through spawnHeadless (same
    // SpawnConsoleResult shape → no result-handling branch below), which runs the
    // SAME one-liner under a detached `bash -lc` logging to a file — no window, no
    // scheme, no desktop bridge. Members log under the workspace's fleet-logs dir
    // (NON-repo — never the staging tree git-sync would try to commit).
    const headlessLogDir = args.headless ? join(papercuspPathForWorkspace(workspaceId), 'fleet-logs') : null;

    // ── goal-mode-hardening P-009 / D-013: open the SPAWNED LEADER, before any member ──
    // The ORDER is load-bearing, not stylistic. The leader opens FIRST and a failure
    // ABORTS the launch with zero members opened, because the state that would otherwise
    // result — members draining a queue with no leader watching — is strictly worse than
    // no fleet at all: nobody reclaims their stalled claims, nobody relaunches them when
    // they die, and nothing surfaces any of it to the owner. Fail closed.
    //
    // The leader is IN ADDITION to `count`, which is the pre-existing semantics rather than
    // a new exception: `count` has always meant MEMBERS, with the leader (until now always
    // the caller) sitting outside it.
    let spawnedLeader: {
      ownerId: string;
      terminal: string;
      pid: number | null;
      command: string;
      registered: boolean;
    } | null = null;
    let leaderAdmissionContext: AdmissionContext | undefined;
    if (spawningLeader && spawnedLeaderOwnerId) {
      // The leader's brief is the standing leader job — the same text a caller-leader gets
      // in this tool's RESULT and would otherwise have had to relay by hand, which is the
      // hop this mode removes. LEADER_AUTO_MODE_DIRECTIVE is included deliberately: leading
      // from an ask-first posture is the documented way fleets die unsupervised, and unlike
      // a caller-leader this agent has no human in front of it to switch it over.
      let leaderCtxPath: string | undefined;
      try {
        const leaderRegistryNote = delegatedSpawnReplacement
          ? [
              'The fleet currently records a missing/dead leader. After your process opens, the',
              'launcher will compare-and-set the registry to your pinned coord identity. If a',
              'concurrent takeover wins that CAS, you are NOT the leader and must not steer the fleet.',
            ]
          : [
              'The registry ALREADY records you as this',
              "fleet's leader (your coord identity was pinned before the fleet row was written), so there is",
            ];
        const delegatedRecoveryAction = delegatedSpawnReplacement
          ? [
              '',
              `Once coord:orient confirms the registry names you as leader, call fleet:resume { fleet: "${fleetSlug}", reason: "delegated dead-leader recovery" }.`,
              'Do not call resume if orient shows another leader; that concurrent authority won the recovery race.',
            ]
          : [];
        const leaderBrief = [
          `You are the LEADER of fleet \`${fleetSlug}\`${planSlug ? ` on plan \`${planSlug}\`` : ''}.`,
          '',
          'You were LAUNCHED to lead it. The agent that called fleet:launch-on-plan delegated this to',
          'you and retains responsibility for portfolio priorities and resource allocation.',
          `Your assigned target is ${count} member seats. Execute the plan within the supplied fleet size and model configuration.`,
          ...(goalAllocation ? [renderGoalFleetAllocation({ ...goalAllocation, fleetMemberTarget: count })] : []),
          'The GOAL steward chooses the plans, fleet size and role models using the whole portfolio.',
          'Request allocation changes from that steward; do not unilaterally widen the fleet or replace its model choices.',
          'Proceed with execution and member supervision under this assignment.',
          ...leaderRegistryNote,
          ...(delegatedSpawnReplacement
            ? []
            : ['no leadership to claim — but there IS a monitor loop to arm, and nothing happens until you do.']),
          ...delegatedRecoveryAction,
          '',
          LEADER_AUTO_MODE_DIRECTIVE,
          ...LEADER_STANDING_JOB.map((point, i) => `  ${i + 1}. ${point}`),
        ].join('\n');
        const ctxDir = join(papercuspPathForWorkspace(workspaceId), 'launch-context');
        mkdirSync(ctxDir, { recursive: true });
        leaderCtxPath = join(ctxDir, `fleet-${fleetSlug}-leader-context.md`);
        writeFileSync(leaderCtxPath, leaderBrief, 'utf8');
      } catch {
        // Compose/write failed — the leader still launches, just on the bare baseline.
        // Losing the brief is survivable; losing the leader is not.
        leaderCtxPath = undefined;
      }
      const leaderCommand = injectLaunchedByArg(
        memberLaunchCommand({
          ...leaderDefaults,
          fleetSlug,
          harness,
          plan: planSlug ?? undefined,
          // The pre-pin. This is what makes the fleet row written above name a REAL agent.
          ownerId: spawnedLeaderOwnerId,
          launchContext: leaderCtxPath,
        }),
        ownerId,
      ).command;
      const leaderLabel = `${fleetSlug} · LEADER (${planSlug ?? 'claim-spec'})`;
      const leaderResult = await spawnGovernedAgentProcess(
        {
          workspaceId,
          idempotencyKey: `fleet-spawn:${fleetSlug}:${launchRequestedAt}:leader`,
          owner: spawnedLeaderOwnerId,
          payloadRef: `fleet:${fleetSlug}:leader`,
          metadata: { launchedBy: ownerId, targetOwnerId: spawnedLeaderOwnerId, fleetSlug, role: 'leader' },
        },
        (admissionContext) => {
          const governedBase = {
            ...base,
            env: { ...base.env, PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(admissionContext) },
          };
          return args.headless
            ? spawnHeadless({
                envelope: { ...governedBase, greetingCmd: leaderCommand, cwd: base.cwd },
                label: leaderLabel,
                logDir: headlessLogDir,
                launchedBy: ownerId,
                fleetSlug,
                coordOwnerId: spawnedLeaderOwnerId,
              })
            : spawnConsole({
                envelope: { ...governedBase, greetingCmd: leaderCommand, cwd: base.cwd },
                label: leaderLabel,
                writeMcpJson: false,
                scheme,
                allowDesktopBridge: true,
                displayOverride: args.display,
                preferProcessPerWindow: VISIBLE_FLEET_AGENT_REQUIRES_PROCESS_PER_WINDOW,
              });
        },
      );
      if (leaderResult.status !== 'ok') {
        // Nothing else has opened yet, so release the launch slot — an immediate, legitimate
        // retry must not be suppressed for the whole 5-minute window by a launch that
        // produced no agents at all.
        try {
          await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
        } catch {
          /* the guard self-heals when the window elapses */
        }
        const registryTruth = delegatedSpawnReplacement
          ? `Fleet \`${fleetSlug}\` still records its prior absent leader ` +
            `\`${delegatedSpawnReplacementExpectedLeader ?? 'none'}\`; that value was not cleared or replaced.`
          : `Fleet \`${fleetSlug}\` now exists and is LEADERLESS — no leader was recorded, because none launched.`;
        return err(
          `leader:'spawn' — the LEADER failed to open (${leaderResult.error}), so NO members were ` +
            `opened (deliberately: an unled fleet is worse than none). ${registryTruth} ` +
            `Recover by re-running this same leader:'spawn' call or taking leadership explicitly.`,
        );
      }
      leaderAdmissionContext = leaderResult.admissionContext;
      // The leader is OPEN — only now does the registry learn who leads. Before this line the
      // fleet was honestly leaderless; after it, it names an agent that demonstrably launched.
      // Best-effort: a registry write failure must not orphan a leader that is already running,
      // and the fleet stays claimable via fleet:take-leadership if it does fail.
      let leaderRegistered = true;
      let installedLeader: Awaited<ReturnType<typeof setFleetLeader>> = null;
      try {
        installedLeader = delegatedSpawnReplacement
          ? await setFleetLeader(
              workspaceId,
              fleetSlug,
              spawnedLeaderOwnerId,
              undefined,
              delegatedSpawnReplacementExpectedLeader,
            )
          : await setFleetLeader(workspaceId, fleetSlug, spawnedLeaderOwnerId);
        // A null CAS result means another actor changed leadership after our preflight;
        // never claim registration or overwrite that concurrent leader.
        if (!installedLeader) leaderRegistered = false;
      } catch {
        leaderRegistered = false;
      }
      if (!leaderRegistered && delegatedSpawnReplacement) {
        leaderSpawnRecoveryWarning =
          `Delegated leader \`${spawnedLeaderOwnerId}\` opened, but fleet \`${fleetSlug}\` leadership changed concurrently; ` +
          'the concurrent registry leader was preserved and the spawned process was not reported as registered.';
      }
      if (leaderRegistered) {
        // Keep the trigger-maintained presence projection coupled to the registry CAS.
        // `coord_presence.fleet_role` is what role-keyed policy reads, so a spawned
        // leader must append the same `lead` membership event as take-leadership.
        await setPresenceFleet(workspaceId, spawnedLeaderOwnerId, fleetSlug, 'leader');
        leaderControl = await ensureFleetLeaderControl({
          workspaceId,
          ownerId: spawnedLeaderOwnerId,
          fleetSlug,
          harnessSlug: harness,
          planSlug,
          carry: leaderDefaults.carry ?? 'warm',
        });
      }
      spawnedLeader = {
        ownerId: spawnedLeaderOwnerId,
        terminal: leaderResult.terminal,
        pid: leaderResult.pid,
        command: leaderCommand,
        // False = the agent IS running and briefed as leader, but the registry write failed,
        // so fleet:status will not show it leading until someone repairs that. Surfaced
        // rather than swallowed: a silently-unregistered leader looks exactly like a fleet
        // nobody is watching.
        registered: leaderRegistered,
      };
    }

    // The GOAL holder and its delegated leader must be coupled by the launch
    // itself. A returned instruction to call coord:couple is easy to miss, and a
    // retry against an already-led fleet must repair a missing edge as well.
    // The leader may already be running, so a coupling-store failure is reported
    // as a typed partial result rather than pretending the launch did not happen.
    let goalLeaderCoupling: {
      status: 'coupled' | 'failed' | 'no-registered-leader';
      peerOwnerId: string | null;
      error: string | null;
    } | null = null;
    if (goalHolderSubject && callerExcludedFromFleet) {
      const peerOwnerId = spawnedLeader?.registered
        ? spawnedLeader.ownerId
        : delegatedSpawnRetry
          ? delegatedRecordedLeaderOwnerId
          : null;
      if (!peerOwnerId) {
        goalLeaderCoupling = { status: 'no-registered-leader', peerOwnerId: null, error: null };
      } else {
        try {
          const edge = await declareCoupling({
            workspaceId,
            agentA: ownerId,
            agentB: peerOwnerId,
            declaredBy: ownerId,
            reason: `GOAL ${goalHolderSubject} delegated fleet ${fleetSlug} leadership`,
          });
          goalLeaderCoupling = edge
            ? { status: 'coupled', peerOwnerId, error: null }
            : { status: 'failed', peerOwnerId, error: 'coupling-store-returned-no-edge' };
        } catch (error) {
          goalLeaderCoupling = { status: 'failed', peerOwnerId, error: String(error) };
        }
      }
    }

    const waveIndices: number[][] = [];
    // EI-20437060078324174: members whose verification window expired WITHOUT an
    // observation either way. Not failures — no 502, no failed[] entry. They are
    // re-probed once after the last wave and reported honestly as unverified.
    const unconfirmed: Array<{ ownerId: string; note: string }> = [];
    if (openCount > 0) waveIndices.push([0]);
    for (let start = 1; start < openCount; start += 3) {
      waveIndices.push(Array.from({ length: Math.min(3, openCount - start) }, (_v, offset) => start + offset));
    }
    // Spawn and verification are deliberately separate phases. A slow first-member
    // verifier must not consume the call budget before later bounded waves have even
    // been opened (WI-39368). A positive spawn failure still stops NEW waves, while
    // every wave that did open is verified below and reported in the transaction.
    const completeLaunch = async (): Promise<string | null> => {
      try {
        await runLaunchWavesBeforeVerification(
          waveIndices,
          requestedMemberIds,
          async (waveIndex, indices, ownerIds) => {
            const wave: FleetLaunchTransaction['waves'][number] = {
              index: waveIndex,
              ownerIds: [...ownerIds],
              state: 'opening',
            };
            launchTransaction.waves.push(wave);
            await persistLaunchTransaction();

            const waveResults = await Promise.all(
              indices.map(async (i) => {
                const memberOwnerId = requestedMemberIds[i];
                const memberLabel = `${fleetSlug} · member ${i + 1}/${openCount} (${planSlug ?? 'claim-spec'})`;
                try {
                  return await spawnGovernedAgentProcess(
                    {
                      workspaceId,
                      idempotencyKey: `fleet-spawn:${fleetSlug}:${launchRequestedAt}:member:${i}`,
                      owner: memberOwnerId,
                      payloadRef: `fleet:${fleetSlug}:member:${memberOwnerId}`,
                      parent: leaderAdmissionContext,
                      metadata: { launchedBy: ownerId, targetOwnerId: memberOwnerId, fleetSlug, role: 'member' },
                    },
                    (admissionContext) => {
                      const governedBase = {
                        ...base,
                        env: { ...base.env, PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(admissionContext) },
                      };
                      return args.headless
                        ? spawnHeadless({
                            envelope: { ...governedBase, greetingCmd: memberCommands[i], cwd: base.cwd },
                            label: memberLabel,
                            logDir: headlessLogDir,
                            launchedBy: ownerId,
                            fleetSlug,
                            coordOwnerId: memberOwnerId,
                          })
                        : spawnConsole({
                            envelope: { ...governedBase, greetingCmd: memberCommands[i], cwd: base.cwd },
                            label: memberLabel,
                            writeMcpJson: false,
                            scheme,
                            allowDesktopBridge: true,
                            displayOverride: args.display,
                            preferProcessPerWindow: VISIBLE_FLEET_AGENT_REQUIRES_PROCESS_PER_WINDOW,
                          });
                    },
                  );
                } catch (error) {
                  // Admission can reject before the console spawner runs (for example when
                  // its durable receipt cannot be persisted). Keep the rejection in its
                  // member slot so Promise.all can finalize the wave and report the exact
                  // member instead of aborting the whole launch transaction.
                  return {
                    status: 'error' as const,
                    code: 500,
                    error: `governed spawn failed: ${error instanceof Error ? error.message : String(error)}`,
                  };
                }
              }),
            );
            const openedThisWave: string[] = [];
            waveResults.forEach((result, offset) => {
              const i = indices[offset];
              const memberOwnerId = requestedMemberIds[i];
              if (result.status === 'ok') {
                openedThisWave.push(memberOwnerId);
                launchTransaction.openedMemberIds.push(memberOwnerId);
                opened.push({
                  ownerId: memberOwnerId,
                  terminal: result.terminal,
                  pid: result.pid,
                  display: result.display,
                  desktopEnvResolvedVia: result.desktopEnvResolvedVia,
                  command: memberCommands[i],
                });
              } else {
                failed.push({ ownerId: memberOwnerId, error: result.error, code: result.code });
                launchTransaction.failed.push({ ownerId: memberOwnerId, phase: 'spawn', reason: result.error });
              }
            });
            wave.openedOwnerIds = openedThisWave;
            const spawnFailed = waveResults.some((result) => result.status !== 'ok');
            return {
              payload: { wave, openedThisWave, spawnFailed },
              stopAfterSpawn: spawnFailed,
            };
          },
          async ({ payload }) => {
            const { wave, openedThisWave, spawnFailed } = payload;
            let waveVerified = false;
            if (openedThisWave.length > 0) {
              try {
                const waveArgs = {
                  workspaceId,
                  launcherOwnerId: ownerId,
                  since: launchRequestedAt,
                  expected: openedThisWave.length,
                  expectedOwnerIds: openedThisWave,
                  expectedAttestations: expectedAttestations.filter((item) => openedThisWave.includes(item.ownerId)),
                };
                let verdict = await verifyFreshLaunchStarted(waveArgs);
                mergeFleetLaunchWorkerAttestations(launchTransaction, verdict.sessions);
                if (verdict.agentStarted === null) {
                  // EI-20437060078324174: an expired window is the ABSENCE of an
                  // observation, not death — the measured false-negative registered
                  // 5.5s past the first window and went straight on to claim work.
                  // One bounded re-probe BEFORE any gate decision, so a slow boot
                  // verifies here and only a genuinely dark member stays unconfirmed.
                  verdict = await verifyFreshLaunchStarted(waveArgs, {
                    timeoutMs: LATE_VERIFY_RECHECK_TIMEOUT_MS,
                  });
                  mergeFleetLaunchWorkerAttestations(launchTransaction, verdict.sessions);
                }
                waveVerified = verdict.agentStarted === true;
                if (waveVerified) {
                  launchTransaction.verifiedMemberIds.push(...openedThisWave);
                  wave.verifiedOwnerIds = openedThisWave.slice();
                } else if (verdict.agentStarted === null) {
                  // Still unconfirmed after the re-probe. NOT a failure: no 502, no
                  // failed[] entry — the members are reported as unverified, and the
                  // EI-20497372063255974 resume path re-opens the unopened remainder
                  // once they prove live. Session-level split first: a member whose
                  // session already took a real turn IS verified even when the wave
                  // as a whole is not.
                  const verifiedNow = new Set(
                    verdict.sessions
                      .filter((s) => s.ownerId != null && s.successfulCalls > 0)
                      .map((s) => s.ownerId as string),
                  );
                  const confirmed = openedThisWave.filter((id) => verifiedNow.has(id));
                  const pending = openedThisWave.filter((id) => !verifiedNow.has(id));
                  if (confirmed.length > 0) {
                    launchTransaction.verifiedMemberIds.push(...confirmed);
                    wave.verifiedOwnerIds = confirmed.slice();
                  }
                  for (const memberOwnerId of pending) {
                    unconfirmed.push({ ownerId: memberOwnerId, note: verdict.note });
                  }
                  launchTransaction.unconfirmedMemberIds = [
                    ...(launchTransaction.unconfirmedMemberIds ?? []),
                    ...pending,
                  ];
                } else {
                  const phase = verdict.note.includes('ATTESTATION MISMATCH') ? 'attestation' : 'verification';
                  for (const memberOwnerId of openedThisWave) {
                    launchTransaction.failed.push({ ownerId: memberOwnerId, phase, reason: verdict.note });
                    failed.push({ ownerId: memberOwnerId, error: verdict.note, code: 502 });
                  }
                }
              } catch (e: any) {
                // The instrument broke — say THAT. A probe fault is not an observation
                // about the member, so it must not masquerade as a 502 launch failure
                // (the rule capability:launch-agent already applies to this verifier).
                for (const memberOwnerId of openedThisWave) {
                  unconfirmed.push({
                    ownerId: memberOwnerId,
                    note:
                      `⏳ launch verification could not run (${e?.message ?? e}) — the member may be ` +
                      `fine; this says nothing either way. Verify with coord:presence { owner: '${memberOwnerId}' }.`,
                  });
                }
                launchTransaction.unconfirmedMemberIds = [
                  ...(launchTransaction.unconfirmedMemberIds ?? []),
                  ...openedThisWave,
                ];
              }
            }

            // A positive spawn failure still leaves the wave partial; an unconfirmed or
            // failed verification is likewise reported without being mistaken for a
            // successful wave. Later waves have already been spawned by this point.
            if (waveVerified && !spawnFailed && openedThisWave.length === wave.ownerIds.length) {
              wave.state = 'verified';
            } else {
              wave.state = 'partial';
            }
            await persistLaunchTransaction();
          },
        );
        // P-003 worker attestation is a stricter readiness contract than the
        // legacy "agent took a turn" verification above. A member can satisfy
        // that older probe while still having no durable wake, scheduler pull,
        // or accountable disposition; reporting the transaction as verified in
        // that shape is exactly the ready:0/verified false-green. Preserve the
        // legacy fallback when no typed worker evidence exists, but once any
        // worker attestation is recorded require every requested member to be
        // in the ready set.
        const hasTypedWorkerEvidence =
          launchTransaction.workerAttestations !== undefined ||
          launchTransaction.workerReadyMemberIds !== undefined;
        const workersReady =
          !hasTypedWorkerEvidence ||
          transactionRequestedMemberIds.every((ownerId) =>
            launchTransaction.workerReadyMemberIds?.includes(ownerId) === true,
          );
        if (
          launchTransaction.verifiedMemberIds.length === transactionRequestedMemberIds.length &&
          workersReady
        ) {
          launchTransaction.state = 'verified';
        } else {
          launchTransaction.state = 'partial';
        }
        await persistLaunchTransaction();

        // The slot was claimed BEFORE spawning (the atomic winner). If the launch opened NOTHING
        // (every spawn failed), release it so an immediate legitimate retry isn't suppressed for
        // the whole window; a partial success keeps the claim. Best-effort — never fails the result.
        if (opened.length === 0) {
          try {
            await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
          } catch {
            /* the guard self-heals when the window elapses */
          }
        }
        return null;
      } catch (e: any) {
        const completionError = `launch completion failed (${e?.message ?? e}) — inspect fleet:status before replaying.`;
        const verified = new Set(launchTransaction.verifiedMemberIds);
        const pending = opened.map((member) => member.ownerId).filter((memberOwnerId) => !verified.has(memberOwnerId));
        const alreadyUnconfirmed = new Set(unconfirmed.map((member) => member.ownerId));
        for (const memberOwnerId of pending) {
          if (!alreadyUnconfirmed.has(memberOwnerId)) {
            unconfirmed.push({ ownerId: memberOwnerId, note: completionError });
          }
        }
        if (pending.length > 0) {
          launchTransaction.unconfirmedMemberIds = Array.from(
            new Set([...(launchTransaction.unconfirmedMemberIds ?? []), ...pending]),
          );
        }
        launchTransaction.state = 'partial';
        launchTransaction.recovery.nextAction = completionError;
        try {
          await persistLaunchTransaction();
        } catch {
          // The original transaction is still durable; do not turn a completion
          // bookkeeping failure into an unhandled detached rejection.
        }
        if (opened.length === 0) {
          try {
            await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
          } catch {
            /* the guard self-heals when the window elapses */
          }
        }
        return completionError;
      }
    };
    const launchCompletion = completeLaunch();
    const currentLaunchEvidence = () => {
      const openedIdsForEvidence = new Set(opened.map((member) => member.ownerId));
      const workerAttestations = launchTransaction.workerAttestations
        ?.filter((attestation) => attestation.ownerId != null && openedIdsForEvidence.has(attestation.ownerId))
        ?? null;
      const firstTurn = opened.length === 0
        ? null
        : opened.every((member) => launchTransaction.verifiedMemberIds.includes(member.ownerId))
          ? true
          : launchTransaction.failed.some(
              (failure) =>
                openedIdsForEvidence.has(failure.ownerId) &&
                (failure.phase === 'verification' || failure.phase === 'attestation'),
            )
            ? false
            : null;
      return deriveFreshLaunchEvidenceSummary({
        opened: opened.length,
        firstTurn,
        workerAttestations,
      });
    };
    const responseRace = await raceLaunchResponseWithinBudget(launchCompletion);
    const ignoredRoleNote = ignoredRoleDiagnostics.length
      ? `⚠ ignored persisted GOAL launch slot role(s): ${ignoredRoleDiagnostics.map((diagnostic) => `\`${diagnostic.role}\``).join(', ')} — omitted from psu persona validation and member commands.`
      : null;
    if (responseRace.timedOut) {
      stampLaunchOutcome(ctx, fleetSlug, launchTransaction);
      const launchEvidence = currentLaunchEvidence();
      const completionHandle = {
        transactionId: launchTransaction.transactionId,
        fleet: fleetSlug,
        status: 'pending' as const,
        nextAction: `fleet:status { fleet: '${fleetSlug}' }`,
      };
      return json(
        {
          ok: opened.length > 0 || spawnedLeader?.registered === true,
          fleet: fleetSlug,
          leaderRole,
          callerMembership,
          autoModeEntered: leaderControl?.mode.healthy === true,
          leaderControl,
          spawnedLeader,
          leaderSpawnIgnored: leaderSpawnSkipped,
          leaderSpawnRecoveryWarning,
          plan: planSlug,
          harness,
          agent: effAgent,
          account: effAccount ?? null,
          headless: !!args.headless,
          carry: args.carry ?? 'warm',
          ignoredRoleDiagnostics,
          requested: count,
          liveMembers,
          requestedOpenCount,
          launchEvidence,
          completionPending: true,
          completionHandle,
          launchTransaction,
          opened,
          failed,
          unverifiedMembers: unconfirmed.length
            ? unconfirmed.map((member) => ({ ownerId: member.ownerId, note: member.note }))
            : null,
          message:
            `Launch response bounded at ${LAUNCH_RESPONSE_DEADLINE_MS}ms; transaction ` +
            `\`${launchTransaction.transactionId}\` continues in the background. ` +
            `${formatFreshLaunchEvidenceSummary(launchEvidence)} ` +
            (ignoredRoleNote ? `${ignoredRoleNote} ` : '') +
            `Use ${completionHandle.nextAction} to inspect the durable result before replaying.`,
        },
        opened.length === 0 && spawnedLeader?.registered !== true,
      );
    }
    const completionError = responseRace.value;
    const lines: string[] = [];
    if (ignoredRoleNote) lines.push(ignoredRoleNote);
    if (leaderSpawnRecoveryWarning) lines.push(`⚠ ${leaderSpawnRecoveryWarning}`);
    if (sizingAdvisory) lines.push(sizingAdvisory.message);
    // Surface the capacity note when it CLAMPED (a real concurrency limit) OR when the
    // weekly-token-budget is merely tight (utilizationTight — advisory; members still launch).
    if (capacityClamp && (capacityClamp.clamped || capacityClamp.utilizationTight)) lines.push(capacityClamp.reason);
    // WI-41206: hostMemoryClamp is ADVISORY — it no longer withholds any member, so its
    // reason string is deliberately NOT surfaced here as if it had limited the wave. The
    // full figures remain on the structured result for anyone who wants them.
    if (hostMemoryAdmissionError) lines.push(hostMemoryAdmissionError);
    // #3 failsafe report: tell the leader if the launch had to backstop a missing
    // plans:start, or if promotion was refused by the spec-triad gate. The latter
    // is not an idempotent no-op: the lane is empty and the remedy is actionable.
    const promotionWarning = promotionFailsafeWarning(planSlug!, promotionFailsafe);
    if (promotionWarning) lines.push(promotionWarning);
    // P-010: surface the pool-effect so the leader sees whether the lane is actually fed
    // (matched > 0) — the counter-signal to the silent-starvation shape the guard refuses.
    // EI-19276371141300541: this now also fires for a fresh plan-only lane (no claimKinds), so
    // describe the lane generically rather than assuming claimKinds is set, and don't assert
    // "IS fed" when matched is merely nonzero but too low to cover the fleet.
    if (claimSpecApplied?.poolEffect) {
      const pe = claimSpecApplied.poolEffect;
      const laneDesc = args.claimKinds?.length ? `claimKinds=[${args.claimKinds.join(',')}]` : `plan=\`${planSlug}\``;
      const fedNote = pe.matched >= count ? 'this lane IS fed' : `⚠ this lane may NOT cover all ${count} member(s)`;
      lines.push(
        `  ↳ claim-lane pool-effect (P-010): ${laneDesc} matches ${pe.matched} of ${pe.pool} claimable row(s) under states=[${pe.states.join(',')}]${pe.harness ? ` in \`${pe.harness}\`` : ''} — ${fedNote}.`,
      );
    }
    // P-012: AUTO-COUPLE each director↔implementer pair as soon as both of its
    // members are open. Coupling is what makes the director able to SEE its
    // implementer's working state (and vice versa) without either of them asking
    // — the pair's whole operating loop depends on it, so leaving it to a manual
    // coord:couple would mean every paired fleet launches subtly broken until
    // someone noticed.
    //
    // Two deliberate properties:
    //   • FAIL-SOFT. The members are already running by the time we get here.
    //     Throwing would report a failed launch for a fleet that actually opened,
    //     which is strictly worse than an uncoupled pair the result names.
    //   • VISIBLE-ABSENCE. A pair whose partner never opened is SKIPPED, not
    //     half-coupled, and the shortfall is stated in the message — a dangling
    //     edge would render on every later roster as a healthy pair.
    let pairCoupling: { pairs: number; coupled: number; skipped: number; error: string | null } | null = null;
    if (launchFleetType === 'paired') {
      const openedIds = new Set(opened.map((o) => o.ownerId));
      // ABSOLUTE seats: a top-up wave opens seats `liveMembers + i`, and pair
      // identity belongs to the fleet, not to the wave.
      const seatOwners = new Map<number, string>();
      requestedMemberIds.forEach((memberOwnerId, i) => {
        if (openedIds.has(memberOwnerId)) seatOwners.set(liveMembers + i, memberOwnerId);
      });
      const couplable = pairsToCouple(seatOwners);
      const touchedPairs = new Set([...seatOwners.keys()].map((s) => pairIndexOfSeat(s))).size;
      let coupled = 0;
      let couplingError: string | null = null;
      try {
        // Lazy, like the promotion failsafe above: keeps the coordination store
        // off this module's static import graph.
        const { declareCoupling } = await import('../../coord/couplings');
        for (const p of couplable) {
          const edge = await declareCoupling({
            agentA: p.director,
            agentB: p.implementer,
            declaredBy: ownerId,
            workspaceId,
            // No ttlSec — D-006 (coupling-signal-liveness-and-lifecycle): a
            // clock expiry would silently stop two live pair members from seeing
            // each other. Retirement here is cause-based; the edge dies with the
            // pair.
            reason:
              `directed pair ${p.pairIndex} of fleet \`${fleetSlug}\` — the director issues one directive ` +
              `at a time and reads the implementer's state to verify each milestone`,
          });
          if (edge) coupled += 1;
        }
      } catch (e) {
        couplingError = e instanceof Error ? e.message : String(e);
      }
      const skipped = Math.max(0, touchedPairs - coupled);
      pairCoupling = { pairs: touchedPairs, coupled, skipped, error: couplingError };
      if (couplingError) {
        lines.push(
          `  ⚠ pair auto-coupling FAILED (${couplingError}) — the members are running but are NOT coupled. ` +
            'Couple each pair by hand with coord:couple, or the director cannot see its implementer.',
        );
      } else if (skipped > 0) {
        lines.push(
          `  ⚠ ${skipped} of ${touchedPairs} pair(s) left UNCOUPLED — only one half opened. ` +
            'A lone member has no counterpart; top up the fleet or kill the orphan.',
        );
      } else if (coupled > 0) {
        lines.push(`  ↳ auto-coupled ${coupled} director↔implementer pair(s).`);
      }
    }
    const carryMode: 'warm' | 'cold' = args.carry ?? 'warm';
    // P-006: denominate the headline against the TARGET (`count`), never against the post-clamp
    // attempt — `opened/attempted` rendered a clamped 10→4 wave as "4/4 opened" (complete success).
    const fill = describeFleetFillOutcome({
      requested: count,
      liveMembers,
      attempted: openCount,
      opened: opened.length,
      noun: args.headless ? 'HEADLESS member' : 'member',
      // WI-41206: hostMemoryClamp is advisory and never limits the wave, so it is no
      // longer a `limitedBy` cause — attributing a shortfall to it would be false.
      limitedBy: capacityClamp?.clamped ? 'capacity' : topUpWave.waveCapped ? 'wave' : undefined,
    });
    const clampSuffix = capacityClamp?.clamped
      ? `; the deficit was capacity-clamped ${requestedOpenCount}→${openCount}`
      : '';
    const launchEvidence = currentLaunchEvidence();
    lines.push(
      opened.length
        ? `Launched fleet \`${fleetSlug}\` (you are ${leaderRole})${planSlug ? ` on plan \`${planSlug}\`` : ' (claim-spec fleet)'} — ${fill.clause}${args.headless ? ' (no desktop windows — tail the per-member log paths below)' : ''}${carryMode === 'cold' ? ' [COLD carry]' : ''}${liveMembers > 0 ? ` (deficit top-up: ${liveMembers} already live of the ${count} requested)` : ''}${clampSuffix}${scheme ? ` (scheme: ${scheme.name})` : ''}:`
        : // EI-22168623726023643: carry the fill verdict and the clamp reason into the
          // ZERO-open case too. The old flat sentence dropped both and read as a benign
          // no-op beside ok:true, which is how an empty fleet was recorded as staffed.
          describeZeroOpenFleetHeadline({
            fleetSlug,
            fill,
            clampReason: capacityClamp?.clamped ? capacityClamp.reason : null,
          }),
    );
    lines.push(`  ↳ ${formatFreshLaunchEvidenceSummary(launchEvidence)}`);
    for (const o of opened) {
      const displayNote = o.display ? ` [DISPLAY=${o.display}]` : '';
      lines.push(`  • ${o.terminal} (pid ${o.pid ?? '?'})${displayNote} — ${o.command}`);
    }
    if (perMemberLaunchContextPaths) {
      lines.push(
        `  ↳ per-member launch contexts (EI-8985): ${perMemberLaunchContextPaths.filter(Boolean).length}/${openCount} members got a DISTINCT composed context (own brief and/or warm/cold carry); the rest fell back to the shared launch context.`,
      );
    }
    // P-004: echo the resolved per-member config so the leader confirms what each member got.
    if (resolvedMembers) {
      lines.push('  ↳ per-member resolved config (P-004 — what each member got; precedence member > fleet > system):');
      for (const m of resolvedMembers) {
        lines.push(
          `     ${m.member}. model=${m.model ?? '(fleet default)'} · account=${m.account ?? 'default'} · carry=${m.carry}` +
            ` · compactionLimit=${m.compactionLimit ?? '(role default)'}${m.claimKinds ? ` · claimKinds=[${m.claimKinds.join(',')}]` : ''}`,
        );
      }
      // Per-member claimKinds is folded but NOT applied at launch (no member cup exists yet to
      // pin) — only the FLEET claim spec is set here. Disclose it rather than imply it took.
      if (resolvedMembers.some((_m, i) => memberSpecs[i]?.claimKinds?.length)) {
        lines.push(
          '  ⚠ per-member `claimKinds` is NOT applied at launch: no member cup exists yet to pin, so launch set only the FLEET claim spec (above). To give a member its own lane, scheduler:set_claim_spec { cupId } once it registers (find the cup via coord:presence / fleet:status).',
        );
      }
    }
    // EI-8289: a socket-scan placement means no real logged-in seat was found —
    // these windows MAY have landed on a virtual/sandbox display (a leased
    // Xvfb) rather than the owner's real desktop. The launch previously
    // reported bare "opened" here even when that happened, which is exactly
    // how the 2026-07-06 fleet-behavior-probe windows went invisible.
    if (opened.some((o) => o.desktopEnvResolvedVia === 'socket-scan')) {
      lines.push(
        '  ⚠ no active login seat was detected (who) — the DISPLAY(s) above were picked by a raw X11 ' +
          "socket scan and MAY be a virtual/sandbox display rather than the owner's real desktop " +
          '(EI-8289). Confirm the owner can actually see these windows before assuming supervision works.',
      );
    }
    // WI-4272: an explicit `display` arg is an INTENTIONAL sandbox/demo-stage
    // placement — disclose it plainly (the windows are NOT on the owner's seat).
    if (opened.some((o) => o.desktopEnvResolvedVia === 'caller-override')) {
      lines.push(
        `  ↳ member windows opened on caller-specified display ${args.display} (demo-stage override, ` +
          "WI-4272) — NOT the owner's desktop seat; visible in the sandbox recording/screenshot only.",
      );
    }
    if (failed.length) {
      lines.push(`${failed.length} failed:`);
      for (const f of failed) lines.push(`  • ${f.error}`);
    }
    if (unconfirmed.length) {
      // EI-20437060078324174: unverified is a THIRD state — neither the success
      // list nor the failure list may absorb it, or the caller double-launches.
      lines.push(
        `${unconfirmed.length} member${unconfirmed.length > 1 ? 's' : ''} UNVERIFIED (opened; ` +
          `registration not confirmed inside the window — NOT a failure, do NOT relaunch on this alone):`,
      );
      for (const u of unconfirmed) {
        lines.push(`  • ${u.ownerId} — verify: coord:presence { owner: '${u.ownerId}' }`);
      }
      lines.push(`  ↳ ${unconfirmed[0].note}`);
    }
    if (failed.length) {
      if (failed.some((f) => f.code === 501 || f.error.includes('desktop-bridge'))) {
        lines.push(
          '(On Windows member windows are relayed to the desktop shell via the sync-bus bridge (WI-3289) — the Papercusp desktop window must be OPEN for the relay to land. Linux + macOS spawn server-side directly.)',
        );
      }
    }
    if (opened.length || spawnedLeader) {
      if (seatPin) {
        lines.push(
          `Seats (P-005): ${opened.length} member${opened.length === 1 ? '' : 's'} launched FROM slot \`${seatPin.ref}\` — ${seatPin.consumedBefore} of ${seatPin.delegated} seat${seatPin.delegated === 1 ? '' : 's'} were already consumed; each member consumes one at boot (the cap re-checks there too).`,
        );
      }
      // goal-mode-hardening P-009 / D-013: a DELEGATING caller must not be handed the
      // leader's standing job. It is not leading this fleet — telling it to arm a monitor
      // loop and watch the members would re-create by instruction the exact role it just
      // paid a spawn to avoid, and (worse) it would then believe the fleet is supervised
      // by itself rather than by the agent that actually holds the role.
      if (callerExcludedFromFleet) {
        if (spawnedLeader?.registered) {
          lines.push(
            `THIS FLEET IS LED BY A LAUNCHED AGENT, NOT BY YOU — \`${spawnedLeader.ownerId}\` was spawned to lead it ` +
              `and already holds the role in the registry. You are NOT in this fleet and you do NOT enter AUTO mode ` +
              `from this call. Do not arm a monitor loop for it; that is the leader's standing job and it was briefed ` +
              `with it at launch.`,
          );
          lines.push(
            `  ↳ \`coord:send\` reaches ${spawnedLeader.ownerId} directly. It is addressable NOW — the identity was pinned ` +
              `before the fleet row was written — even though it is still booting.`,
          );
        } else if (spawnedLeader) {
          lines.push(
            `THE DELEGATED LEADER PROCESS \`${spawnedLeader.ownerId}\` OPENED BUT DID NOT WIN REGISTRY AUTHORITY. ` +
              `A concurrent leader change was preserved; you remain outside the fleet, and the spawned process ` +
              `was briefed not to steer unless coord:orient names it as leader.`,
          );
        } else {
          lines.push(
            `THIS FLEET IS ALREADY LED BY A SPAWNED AGENT, NOT BY YOU — this leader:'spawn' retry preserved ` +
              `the existing leader and kept you outside the fleet. You do NOT enter AUTO mode from this call; ` +
              `do not arm a monitor loop for it.`,
          );
        }
      } else {
        lines.push(
          `You are this fleet's LEADER (${ownerId}). Members auto-start on boot — no kickoff needed. Do NOT ` +
            `call fleet:launch-on-plan or fleet:take-leadership again for this fleet — you already lead it (a ` +
            `re-call opens NO new members for ${Math.round(RELAUNCH_SUPPRESS_MS / 1000)}s).`,
        );
        // P-009: disclose a lifted compaction cap (you launched INTO leadership from the member cap).
        if (leaderReseed?.reason === 'member-cap-lifted') {
          lines.push(
            `  ↳ compaction cap lifted ${leaderReseed.from} → ${leaderReseed.applied} tokens (P-009): you were at the 300k member cap; leaders get the full window. Your \`context: N/limit\` signal reflects it next turn.`,
          );
        }
        lines.push(LEADER_AUTO_MODE_DIRECTIVE);
        // Auto-numbered from the single canonical LEADER_STANDING_JOB source (P-013): a future
        // insert never hand-renumbers, and the rendered length is test-guarded against balloon.
        LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      }
      if (goalLeaderCoupling?.status === 'coupled') {
        lines.push(`  ↳ GOAL holder automatically coupled to delegated leader \`${goalLeaderCoupling.peerOwnerId}\`.`);
      } else if (goalLeaderCoupling?.status === 'failed') {
        lines.push(
          `  ⚠ GOAL leader coupling failed for \`${goalLeaderCoupling.peerOwnerId}\`: ${goalLeaderCoupling.error}. ` +
            `The fleet launch remains in effect; repair with \`coord:couple { b: "${goalLeaderCoupling.peerOwnerId}" }\`.`,
        );
      }
      if (leaderSpawnSkipped) lines.push(leaderSpawnSkipped);
      if (baselineApplied) {
        lines.push(
          'Your members were launched with this MEMBER OPERATING BASELINE (already told to them — do NOT re-issue or contradict it; your custom brief, if any, is layered BELOW it and wins on fleet-specifics):',
        );
        for (let i = 0; i < MEMBER_BASELINE_RULES.length; i++) {
          lines.push(`  ${i + 1}. ${MEMBER_BASELINE_RULES[i].head}`);
        }
        if (memberLaunchContextPath) lines.push(`  (full composed member context: ${memberLaunchContextPath})`);
      }
      if (briefReadError) lines.push(briefReadError);
    }

    stampLaunchOutcome(ctx, fleetSlug, launchTransaction);
    return json(
      {
        ok: launchTransaction.verifiedMemberIds.length > 0 || spawnedLeader?.registered === true,
        fleet: fleetSlug,
        leaderRole,
        callerMembership,
        // Machine-readable fact about the ACTUAL registered leader, never inferred from
        // how many member terminals happened to open. On leader:'spawn' this describes
        // the spawned leader; the caller remains a delegator as the message below states.
        autoModeEntered: leaderControl?.mode.healthy === true,
        leaderControl,
        // goal-mode-hardening P-009 / D-013: the agent launched to lead this fleet
        // (null on an ordinary caller-led launch). `ownerId` is the PRE-PINNED coord
        // identity pre-pinned for this launch, so it is addressable
        // (coord:send / coord:presence / coord:couple) from the moment this returns —
        // before that agent has finished booting.
        spawnedLeader,
        goalLeaderCoupling,
        // Non-null when `leader:'spawn'` was asked for and deliberately NOT honored
        // (the fleet already existed with a leader). Surfaced rather than silent: the
        // caller believes it is not leading, and on this path it may well be.
        leaderSpawnIgnored: leaderSpawnSkipped,
        leaderSpawnRecoveryWarning,
        plan: planSlug,
        harness,
        agent: effAgent,
        account: effAccount ?? null,
        // P-003/P-004: the two orthogonal launch knobs, echoed so non-prose
        // consumers (hooks, scorers, the persona disclosure) can key on them.
        headless: !!args.headless,
        carry: carryMode,
        headcountProfile: persistedHeadcountProfile
          ? {
              applied: true,
              target: persistedHeadcountProfile.target,
              config: persistedHeadcountProfile.config,
              provenance: savedLaunchSpec.provenance,
              reusePath: savedLaunchSpec.reusePath,
            }
          : null,
        // R5: how an explicit `supervise` arg landed (null = arg omitted).
        superviseGrant,
        ignoredRoleDiagnostics,
        // P-004: the resolved per-member config (model/account/carry/compactionLimit/claimKinds),
        // null for a homogeneous (no-`members`) launch. `carry` here is honored per member; the
        // fleet-wide `carry` field above is the default the unspecified members fell through to.
        resolvedMembers,
        // P-005: the seat pin this wave launched from (null = a plain, non-seat launch).
        seats: seatPin ? { ...seatPin, requested: count, launched: opened.length } : null,
        requested: count,
        liveMembers,
        requestedOpenCount,
        // EI-20437060078324174: the THIRD verification state, machine-readable.
        // These members OPENED and were neither confirmed nor observed failing —
        // a caller must treat them as possibly-live (verify via coord:presence),
        // never as a shortfall to relaunch into.
        unverifiedMembers: unconfirmed.length ? unconfirmed.map((u) => ({ ownerId: u.ownerId, note: u.note })) : null,
        launchEvidence,
        // P-006: the MACHINE-READABLE fill verdict, so a caller never has to infer "did I get the
        // fleet I asked for?" from an opened count whose denominator is the post-clamp attempt.
        fleetSize: fill.fleetSize,
        shortfall: fill.shortfall,
        fleetComplete: fill.complete,
        capacityClamp,
        hostMemoryClamp,
        // WI-41206: always present and always false on this path. Host memory is advisory
        // and never withholds a member, but the field must still EXIST here — a caller that
        // reads `hostMemorySuppressed` cannot distinguish "not suppressed" from "field
        // missing on the success payload", and undefined reads as falsy by luck, not design.
        hostMemorySuppressed: false,
        hostMemoryAdmissionError,
        sizingAdvisory,
        // EI-20362893066852316: non-null when the codex model preflight could not get a
        // definitive answer (auth/transport/etc.) and the launch proceeded fail-open.
        codexPreflightWarning,
        memberBaselineApplied: baselineApplied,
        claimSpecApplied,
        promotionFailsafe,
        admission,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath,
        perMemberLaunchContextPaths,
        briefReadError,
        // D-008 / D-014: the fleet's type, and — when paired — the per-role spawn
        // announcement the persona rule owes the owner. `announcement` is ONE LINE
        // PER ROLE on purpose: a merged summary is unreadable exactly when the two
        // roles differ, which is the only case worth announcing. `pairs` reports
        // whole pairs actually opened, which is what a clamped wave changes.
        fleetType: launchFleetType,
        pairing:
          launchFleetType === 'paired'
            ? {
                pairs: Math.floor(fill.fleetSize / 2),
                requestedPairs: Math.floor(count / 2),
                announcement: pairedAnnouncement ?? [],
                // P-012: null only on a non-paired fleet, so a reader can tell
                // "coupling did not apply" from "coupling ran and coupled zero".
                coupling: pairCoupling,
              }
            : null,
        opened,
        failed,
        launchTransaction,
        // P-006: what the GOAL contributed to this launch, and anything it set
        // that could not bind. Ahead of the per-role announcement because an
        // owner reading "the goal chose this shape" needs it before the roles.
        goalLaunch: goalOverlay.goalId
          ? {
              goalId: goalOverlay.goalId,
              fleetType: goalOverlay.type,
              typeSource: goalOverlay.typeSource,
              slots: goalOverlay.slots,
              applied: goalOverlay.pinned,
              unbindable: goalOverlay.unbindable,
              degraded: goalSettings.degradedReasons,
            }
          : null,
        message: [...goalLaunchNotes, ...(pairedAnnouncement ?? []), ...lines].join('\n'),
      },
      launchTransaction.verifiedMemberIds.length === 0 && spawnedLeader?.registered !== true,
    );
  },
});
